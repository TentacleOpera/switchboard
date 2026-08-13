import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import type { TerminalHandle } from '../services/hostSeams';
import { PtyTerminalBackend } from './ptyBackend';
import { GlobalIntegrationConfigService } from '../services/GlobalIntegrationConfigService';
import type { KanbanDatabase } from '../services/KanbanDatabase';
import type { DelegateDefinition } from '../services/agentConfig';

/** Delegate children one head agent may co-launch. A pty is a process, not a row. */
export const MAX_DELEGATES_PER_PARENT = 8;
/** Delegate ptys alive across every head agent in this fleet. */
export const MAX_LIVE_DELEGATE_PTYS = 32;

export const SHELL_READINESS_DELAY_MS = 750;
export const SIGTERM_GRACE_MS = 3000;

/**
 * Registry owner tag. The extension's `isCompatibleIdeName` partition (see
 * extension.ts) uses this to leave PTY rows alone instead of adopting them.
 */
export const PTY_IDE_NAME = 'switchboard-pty';

export interface FleetTerminalInfo {
    friendlyName: string;
    role: string;
    status: 'active' | 'exited';
    pid: number;
    startTime: string;
    worktreePath?: string;
    cwd?: string;
    hidden?: boolean;
    ideName: string;
    purpose: string;
    agentInstanceId: string;
    parentInstanceId?: string | null;
}

export interface ExtendedTerminalHandle extends TerminalHandle {
    pty: import('node-pty').IPty;
    role: string;
    friendlyName: string;
    agentInstanceId: string;
    parentInstanceId?: string | null;
    startTime: string;
    status: 'active' | 'exited';
    worktreePath?: string;
    cwd: string;
    exitCode?: number;
    hidden?: boolean;
    /**
     * Internal: marks a terminal spawned by spawnDelegates as a team member,
     * suppressing auto-start triggering. A shared member is unparented by
     * construction and would otherwise pass the auto-start recursion guard
     * (`!parentInstanceId`). Both hosts' handlePtyVerb read this flag so the
     * guard becomes `!parentInstanceId && !_isTeamMember`.
     */
    _isTeamMember?: boolean;
    /**
     * Heartbeat timestamp (ms epoch) of the most recent PTY output byte. Stamped
     * from a fleet-owned `onData` subscription created in `create()` — independent
     * of the gateway's tap, so it survives `ptyReady === false` for the WS path.
     * Consumers key on `status` for the live/exited distinction and read this for
     * "how recently did we hear from it". See `getLiveness()`.
     */
    lastDataAt: number;
}

/** Liveness snapshot entry returned by {@link PtyFleetService.getLiveness}. */
export interface FleetLivenessEntry {
    friendlyName: string;
    lastDataAt: number;
    status: 'active' | 'exited';
}

export interface CreateOptions {
    /** When true, the terminal is excluded from render lists and role-based dispatch pools. */
    hidden?: boolean;
    /**
     * Internal: marks a terminal spawned by spawnDelegates as a team member,
     * suppressing auto-start triggering. A shared member is unparented by
     * construction and would otherwise pass the auto-start recursion guard
     * (`!parentInstanceId`). This flag is the explicit non-triggering signal
     * the plan requires rather than relying on parentage alone.
     */
    _isTeamMember?: boolean;
    /**
     * Render Claude CLI inline in the normal screen buffer instead of the alternate
     * one, so the terminal PANE's own scrollbar and jump-to-latest pill work.
     *
     * A BOOLEAN, never an env map: this arrives from an HTTP payload, and every pty
     * child holds an API token, so accepting free-form environment here would let any
     * caller inject arbitrary variables into a spawned shell. The two concrete
     * variables are fixed literals in create(). Same reasoning that makes `delegates`
     * and `startupCommand` host-resolved rather than caller-supplied.
     *
     * Resolved HOST-side because this service is also constructed inside ptyHost.ts's
     * child process, which has no vscode API and no configProvider.
     */
    claudeInlineRendering?: boolean;
}

export type FleetChangeEvent = 
    | { type: 'created'; terminal: ExtendedTerminalHandle }
    // `code` is the process exit status when the PTY died on its own, and
    // undefined for an operator-initiated kill(). The gateway forwards it to
    // attached clients — without it every terminal reported "exited with code 0".
    | { type: 'closed'; name: string; code?: number }
    | { type: 'renamed'; oldName: string; newName: string };

export class PtyFleetService {
    private backend = new PtyTerminalBackend();
    private terminals = new Map<string, ExtendedTerminalHandle>();
    private emitter = new EventEmitter();
    private db?: KanbanDatabase;
    private workspaceRoot: string;
    private apiToken?: string;
    /** Serializes async registry read-modify-write cycles. See updateRegistryState. */
    private _registryWrite: Promise<void> = Promise.resolve();

    /**
     * Bounded tombstone map (terminal name → closedAt ms) covering terminals no
     * longer in {@link terminals}. Populated from the fleet's own `{type:'closed'}`
     * change event, which fires on BOTH death paths — the `onExit` self-exit
     * (handle stays in the map with `status:'exited'`) AND `kill()` (which deletes
     * the handle before killing, so `status:'exited'` is otherwise unobservable
     * for an operator kill). Without this the exited-terminal force-clear in the
     * activity-light sweep is structurally unreachable for the most common way a
     * terminal dies. Oldest-first eviction at the cap.
     */
    private recentlyClosed = new Map<string, number>();
    private static readonly RECENTLY_CLOSED_CAP = 64;

    constructor(workspaceRoot: string, db?: KanbanDatabase, apiToken?: string) {
        this.workspaceRoot = workspaceRoot;
        this.db = db;
        this.apiToken = apiToken;
        this.setupShutdownHandlers();
        // Populate the recentlyClosed tombstone from the fleet's own {type:'closed'}
        // change event, which fires on both death paths (onExit self-exit AND kill()).
        // Subscribing here (once, on the singleton) covers every terminal created
        // afterwards; the alternative — stamping at each emit site — is the
        // duplicated-builder trap this plan avoids.
        this.onDidChange((event) => {
            if (event.type === 'closed') {
                this._recordRecentlyClosed(event.name);
            } else if (event.type === 'renamed') {
                // Migrate any tombstone under the old key so a renamed seat that
                // later dies still produces an exited force-clear.
                const closedAt = this.recentlyClosed.get(event.oldName);
                if (closedAt !== undefined) {
                    this.recentlyClosed.delete(event.oldName);
                    this.recentlyClosed.set(event.newName, closedAt);
                }
            }
        });
    }

    /**
     * Record a closed-terminal tombstone, evicting the oldest entry when the cap
     * is reached. Map insertion order = age order, so the first entry is oldest.
     */
    private _recordRecentlyClosed(name: string): void {
        if (this.recentlyClosed.has(name)) {
            // Refresh position so a re-close of a re-created name lands at the end.
            this.recentlyClosed.delete(name);
        }
        this.recentlyClosed.set(name, Date.now());
        while (this.recentlyClosed.size > PtyFleetService.RECENTLY_CLOSED_CAP) {
            const oldest = this.recentlyClosed.keys().next().value;
            if (oldest === undefined) break;
            this.recentlyClosed.delete(oldest);
        }
    }

    public setDatabase(db: KanbanDatabase): void {
        this.db = db;
    }

    public onDidChange(listener: (event: FleetChangeEvent) => void): { dispose: () => void } {
        this.emitter.on('change', listener);
        return {
            dispose: () => {
                this.emitter.off('change', listener);
            }
        };
    }

    public async create(role: string, friendlyName?: string, cwd?: string, worktreePath?: string, parentInstanceId?: string | null, startupCommand?: string, opts?: CreateOptions): Promise<ExtendedTerminalHandle> {
        let name = friendlyName || `${role}-1`;
        let counter = 1;
        while (this.terminals.has(name)) {
            counter++;
            name = `${role}-${counter}`;
        }

        const effectiveCwd = cwd || worktreePath || this.workspaceRoot;
        const agentInstanceId = crypto.randomUUID();
        // Expose the seat's own identity AND the API credential to whatever runs
        // in it. The token is an ENV VAR, never prompt text: a token pasted into a
        // terminal lands in the agent's scrollback and its conversation history.
        // Omitted when empty so the extension host (whose getAuthToken is
        // effectively always empty) leaves the variable unset; the relay recipe's
        // unconditional Authorization header then carries an empty value, which
        // _checkAuth never reads because it short-circuits on the empty expected
        // token. The spread is MANDATORY — ptyBackend.ts:89 does
        // `options.env || process.env`, so a partial map replaces the whole
        // environment and the shell launches with no PATH/HOME/SHELL.
        const switchboardEnv: Record<string, string> = {
            SWITCHBOARD_TERMINAL: name,
            SWITCHBOARD_AGENT_INSTANCE_ID: agentInstanceId,
            ...(this.apiToken ? { SWITCHBOARD_API_TOKEN: this.apiToken } : {}),
        };
        // Claude Code enters the ALTERNATE SCREEN (\x1b[?1049h) and grabs mouse
        // reporting (\x1b[?1000h ?1002h ?1003h ?1006h) the moment its REPL starts.
        // Measured on a node-pty master, not inferred.
        //
        // The alt buffer has no scrollback in xterm.js, so the pane gets no scrollbar
        // and attachJumpToLatest's `baseY - viewportY` is pinned at 0 — the
        // "↓ latest" pill can never become visible. Mouse reporting then routes the
        // wheel to the app and disables xterm's SelectionService; that half is
        // already documented above REARMABLE_DEC_MODES as the "stuck, can't scroll,
        // can't deselect" report.
        //
        // These two env vars make the CLI render inline in the normal buffer instead.
        // Verified: with both set the startup stream contains no ?1049h and no mouse
        // modes. We do NOT filter the bytes client-side — that would desync xterm's
        // parser from the app's own belief about its screen state (see applyServerModes).
        //
        // Set UNCONDITIONALLY when enabled, not gated on the seat's role: a seat
        // spawns a SHELL, and `claude` is started later by a startup command or by
        // the operator, so there is no reliable role→CLI fact at this point. Other
        // CLIs ignore unrecognised CLAUDE_CODE_* variables.
        const claudeEnvDefaults: Record<string, string> = opts?.claudeInlineRendering
            ? {
                CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
                CLAUDE_CODE_DISABLE_MOUSE: '1',
            }
            : {};
        const rawHandle = this.backend.create({
            name,
            cwd: effectiveCwd,
            // Spread order is load-bearing THREE times over:
            //   1. claudeEnvDefaults FIRST — these are DEFAULTS. An operator who has
            //      already exported either variable keeps their own value, per
            //      variable, because process.env overwrites this layer.
            //   2. process.env SECOND and MANDATORY — ptyBackend.ts does
            //      `options.env || process.env`, so a partial map replaces the WHOLE
            //      environment and the shell launches with no PATH/HOME/SHELL.
            //   3. switchboardEnv LAST so the seat identity always wins.
            env: { ...claudeEnvDefaults, ...process.env, ...switchboardEnv } as Record<string, string>,
        });

        const startTime = new Date().toISOString();
        const handle: ExtendedTerminalHandle = {
            ...rawHandle,
            name,
            role,
            friendlyName: name,
            agentInstanceId,
            parentInstanceId,
            startTime,
            status: 'active',
            worktreePath: worktreePath || undefined,
            cwd: effectiveCwd,
            hidden: opts?.hidden === true,
            _isTeamMember: opts?._isTeamMember === true,
            // Initialise the heartbeat to creation time so a freshly-spawned shell
            // that has not yet emitted its banner still reads as "just heard from".
            lastDataAt: Date.now(),
        };

        this.terminals.set(name, handle);

        // Subscribe the fleet's own onData tap IMMEDIATELY after the handle is
        // constructed and BEFORE `await this.injectStartupCommand(handle, role)`.
        // That call awaits SHELL_READINESS_DELAY_MS before typing, so subscribing
        // after it would blind the heartbeat for the whole delay window AND lose
        // the shell's own banner output. Assignment only — no allocation, no timer,
        // no I/O — so this survives ~166 emits/sec without per-flush cost. This
        // subscription is independent of the gateway's; it stays live even when
        // ptyReady === false and the WS gateway is never constructed.
        handle.onData(() => { handle.lastDataAt = Date.now(); });

        handle.onExit((code) => {
            handle.status = 'exited';
            handle.exitCode = code;
            const wasPresent = this.terminals.has(handle.name);
            if (wasPresent) {
                this.updateRegistryState();
                this.emitter.emit('change', { type: 'closed', name: handle.name, code });
            }
        });

        this.updateRegistryState();
        this.emitter.emit('change', { type: 'created', terminal: handle });

        await this.injectStartupCommand(handle, role, startupCommand);

        return handle;
    }

    /**
     * Send the role's configured startup command verbatim after the shell has
     * had time to come up. The command is NOT rewritten: completion detection
     * is derived host-side from the PTY stream (see the `lastDataAt` heartbeat
     * in `create()`), which requires nothing from the agent and therefore
     * behaves identically for every CLI. An earlier revision appended
     * `--settings <generated hook file>` here to register Claude Code
     * lifecycle hooks; that was removed because hooks are a Claude-Code-only
     * mechanism, so it lit the board for one CLI and silently left every other
     * agent on the timeout path.
     */
    private async injectStartupCommand(handle: ExtendedTerminalHandle, role: string, startupCommand?: string): Promise<void> {
        try {
            let cmd = startupCommand;
            if (!cmd) {
                const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
                cmd = commands[role];
            }
            if (!cmd) { return; }
            await new Promise(resolve => setTimeout(resolve, SHELL_READINESS_DELAY_MS));
            if (handle.status === 'active') {
                handle.sendText(cmd, true);
            }
        } catch (err) {
            console.warn(`[PtyFleetService] Failed to inject startup command for role ${role}:`, err);
        }
    }

    public list(): ExtendedTerminalHandle[] {
        return Array.from(this.terminals.values());
    }

    public listActive(): ExtendedTerminalHandle[] {
        return Array.from(this.terminals.values()).filter(t => t.status === 'active');
    }

    /**
     * Liveness snapshot for the activity-light timeout sweep. Returns every
     * terminal in {@link terminals} (active AND self-exited, the latter still
     * present in the map with `status:'exited'`) PLUS every {@link recentlyClosed}
     * tombstone (operator-killed terminals, which `kill()` deletes from the map
     * before the process dies, so their `status:'exited'` is otherwise unobservable).
     * Tombstones are reported as `status:'exited'`. The join key is `friendlyName`,
     * which `rename()` keeps in sync with `name` — never divergent.
     */
    public getLiveness(): FleetLivenessEntry[] {
        const entries: FleetLivenessEntry[] = [];
        for (const t of this.terminals.values()) {
            entries.push({
                friendlyName: t.friendlyName,
                lastDataAt: t.lastDataAt,
                status: t.status,
            });
        }
        // Tombstones for terminals no longer in the map (operator kill path).
        // Skip any name still present in terminals — the live handle is authoritative.
        for (const [name, closedAt] of this.recentlyClosed.entries()) {
            if (this.terminals.has(name)) continue;
            entries.push({
                friendlyName: name,
                lastDataAt: closedAt,
                status: 'exited',
            });
        }
        return entries;
    }

    public get(name: string): ExtendedTerminalHandle | undefined {
        return this.terminals.get(name);
    }

    public getByAgentInstanceId(id: string): ExtendedTerminalHandle | undefined {
        for (const t of this.terminals.values()) {
            if (t.agentInstanceId === id) { return t; }
        }
        return undefined;
    }

    public listChildren(parentId: string): ExtendedTerminalHandle[] {
        return Array.from(this.terminals.values()).filter(t => t.parentInstanceId === parentId);
    }

    /**
     * Co-launch a head agent's declared delegate children as unattached ptys.
     *
     * Caps are checked BEFORE the first spawn so a rejected batch never leaves a
     * partial subtree, and the reason is returned rather than thrown: a throw here
     * would fail the whole `ptyCreateTerminal` call after the parent already exists,
     * leaving a phantom pane in the grid.
     *
     * `scope: 'shared'` members are reused, not respawned: if a live instance
     * named `${teamName}-${role}` already exists, it is returned in the children
     * array without spawning. The reuse check is serialised per (teamName, role)
     * so two heads starting concurrently do not both spawn. A shared member is
     * spawned unparented (no `parentInstanceId`), which puts it outside both
     * delegate caps, outside `liveDelegateCount()`, and outside head-owned
     * teardown — all deliberate, all stated in the plan. It carries
     * `_isTeamMember: true` to suppress the auto-start recursion guard.
     */
    public async spawnDelegates(
        parent: ExtendedTerminalHandle,
        definitions: DelegateDefinition[],
        opts?: { teamName?: string }
    ): Promise<{ children: ExtendedTerminalHandle[]; error?: string }> {
        // Per-team (parented) delegates count against caps. Shared members are
        // unparented and outside both caps — their count is bounded by the
        // number of team definitions, not by head starts.
        const perTeamRequested = definitions
            .filter(d => d.scope !== 'shared')
            .reduce((n, d) => n + Math.max(1, Math.min(d.count || 1, MAX_DELEGATES_PER_PARENT)), 0);
        if (perTeamRequested > MAX_DELEGATES_PER_PARENT) {
            return { children: [], error: `Delegate cap: ${perTeamRequested} requested, ${MAX_DELEGATES_PER_PARENT} allowed per head agent` };
        }
        const liveDelegates = Array.from(this.terminals.values()).filter(t => t.parentInstanceId).length;
        if (liveDelegates + perTeamRequested > MAX_LIVE_DELEGATE_PTYS) {
            return { children: [], error: `Delegate cap: ${liveDelegates} live, ${perTeamRequested} requested, ${MAX_LIVE_DELEGATE_PTYS} allowed in total` };
        }

        const children: ExtendedTerminalHandle[] = [];
        for (const d of definitions) {
            const count = Math.max(1, Math.min(d.count || 1, MAX_DELEGATES_PER_PARENT));

            if (d.scope === 'shared') {
                // Shared member: reuse a live instance or spawn unparented.
                // Name from the team definition so the reuse lookup has a
                // stable key and two teams' shared members are distinguishable.
                const teamName = opts?.teamName || 'team';
                const sharedBaseName = `${teamName}-${d.label || d.role}`;
                for (let i = 0; i < count; i++) {
                    const suffix = count > 1 ? `-${i + 1}` : '';
                    const sharedName = `${sharedBaseName}${suffix}`;
                    // Serialise the reuse check per (teamName, role) so two
                    // heads starting concurrently do not both spawn. The chain
                    // is per-name, not global — different shared members do
                    // not block each other.
                    try {
                        const existing = await this._sharedMemberChain(sharedName, async () => {
                            // Check for a live instance with this name.
                            const live = this.listActive().find(t => t.friendlyName === sharedName);
                            if (live) { return live; }
                            // No live instance — spawn unparented.
                            return this.create(
                                d.role,
                                sharedName,
                                parent.cwd,
                                parent.worktreePath,
                                undefined, // unparented — no parentInstanceId
                                d.startupCommand,
                                { _isTeamMember: true }
                            );
                        });
                        children.push(existing);
                    } catch (err) {
                        // Same best-effort contract as the per-team branch below:
                        // the head and any already-spawned siblings are real and
                        // stay. Letting this throw would reject the whole
                        // ptyCreateTerminal AFTER the head pty exists — the
                        // phantom-pane failure the caps comment above exists to
                        // prevent.
                        return {
                            children,
                            error: `Shared member '${sharedName}' failed to spawn: ${err instanceof Error ? err.message : String(err)}`
                        };
                    }
                }
                continue;
            }

            // Per-team member: parented to the head, as today.
            for (let i = 0; i < count; i++) {
                // Distinct per index. create()'s collision counter falls back to
                // `${role}-${n}` — NOT `${friendlyName}-${n}` — so handing it the same
                // base name twice drops the parent qualification off every child after
                // the first and lets two head agents' children collide.
                const suffix = count > 1 ? `-${i + 1}` : '';
                const baseName = `${parent.friendlyName}-${d.label || d.role}${suffix}`;
                try {
                    children.push(await this.create(
                        d.role,
                        baseName,
                        parent.cwd,
                        parent.worktreePath,
                        parent.agentInstanceId,
                        d.startupCommand,
                        { _isTeamMember: true }
                    ));
                } catch (err) {
                    // Best-effort with a report: the parent and any already-spawned
                    // siblings are real and stay. The caller surfaces the reason.
                    return {
                        children,
                        error: `Delegate '${baseName}' failed to spawn: ${err instanceof Error ? err.message : String(err)}`
                    };
                }
            }
        }
        return { children };
    }

    /**
     * Per-name promise chain serialising shared-member reuse checks. Two heads
     * starting concurrently and wanting the same shared researcher must not
     * both read "no live instance" and both spawn — the check-and-spawn is
     * atomic per name.
     */
    private _sharedMemberChains = new Map<string, Promise<unknown>>();

    private async _sharedMemberChain<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const chain = this._sharedMemberChains.get(name) || Promise.resolve();
        const p = chain.then(() => fn());
        const guarded = p.catch(() => {});
        this._sharedMemberChains.set(name, guarded);
        try {
            return await p;
        } finally {
            // Clean up completed chains to avoid unbounded map growth — but ONLY
            // when we are still the tail. An unconditional delete here dropped a
            // chain a LATER caller had already extended, so the caller after that
            // found no chain, started from Promise.resolve() and ran its
            // check-and-spawn concurrently with the pending one. That is exactly
            // the duplicate-shared-member race the serialisation exists to
            // prevent (eight planners started simultaneously, two researchers).
            if (this._sharedMemberChains.get(name) === guarded) {
                this._sharedMemberChains.delete(name);
            }
        }
    }

    public async createBatch(
        allocation: Array<{ role: string; count: number }>,
        hidden: boolean,
        cwd?: string,
        worktreePath?: string,
        claudeInlineRendering?: boolean
    ): Promise<{ success: boolean; created: Array<{ friendlyName: string; role: string; hidden: boolean }>; failed: Array<{ role: string; reason: string; kind: string }>; error?: string; estimatedDurationMs: number }> {
        const MAX_BATCH = 32;
        const created: Array<{ friendlyName: string; role: string; hidden: boolean }> = [];
        const failed: Array<{ role: string; reason: string; kind: string }> = [];

        if (!Array.isArray(allocation) || allocation.length === 0) {
            return { success: false, created, failed, error: 'allocation must be a non-empty array', estimatedDurationMs: 0 };
        }

        let total = 0;
        for (const a of allocation) {
            const count = Number(a?.count);
            if (!Number.isInteger(count) || count < 1) {
                return { success: false, created, failed, error: `count for role '${a?.role}' is not a positive integer`, estimatedDurationMs: 0 };
            }
            total += count;
        }
        if (total > MAX_BATCH) {
            return { success: false, created, failed, error: `batch cap: ${total} requested, ${MAX_BATCH} allowed`, estimatedDurationMs: 0 };
        }

        const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
        for (const a of allocation) {
            if (typeof a.role !== 'string' || !commands[a.role]) {
                return { success: false, created, failed, error: `no startup command for role '${a.role || ''}'`, estimatedDurationMs: 0 };
            }
        }

        let abortResource = false;
        for (const a of allocation) {
            for (let i = 0; i < a.count; i++) {
                if (abortResource) {
                    failed.push({ role: a.role, reason: 'aborted after earlier resource failure', kind: 'aborted' });
                    continue;
                }
                try {
                    const t = await this.create(a.role, undefined, cwd, worktreePath, null, undefined, { hidden, claudeInlineRendering });
                    created.push({ friendlyName: t.friendlyName, role: t.role, hidden: t.hidden === true });
                } catch (err: any) {
                    const msg = err instanceof Error ? err.message : String(err);
                    let kind = 'unknown';
                    if (/posix_openpt failed: Device not configured|No space left on device/i.test(msg)) kind = 'pty-pool-exhausted';
                    else if (/posix_openpt failed: Too many open files|File table overflow/i.test(msg)) kind = 'fd-limit';
                    else if (/posix_spawnp failed|spawn-helper ENOENT/i.test(msg)) kind = 'spawn-failed';
                    failed.push({ role: a.role, reason: msg, kind });
                    if (kind === 'pty-pool-exhausted' || kind === 'fd-limit') {
                        abortResource = true;
                    }
                }
            }
        }

        const success = created.length > 0 && failed.length === 0;
        return {
            success,
            created,
            failed,
            estimatedDurationMs: total * SHELL_READINESS_DELAY_MS,
            ...(failed.length > 0 && created.length === 0 ? { error: failed.map(f => `${f.role}: ${f.reason}`).join('; ') } : {})
        };
    }

    public kill(name: string): boolean {
        const handle = this.terminals.get(name);
        if (!handle) return false;
        // Tear the delegate subtree down with its head agent. Without this the
        // children keep running as orphan processes nothing lists or reaps.
        const children = this.listChildren(handle.agentInstanceId);
        if (children.length > 0) {
            for (const child of children) { this.kill(child.friendlyName); }
        }
        this.terminals.delete(name);
        try {
            handle.kill();
        } catch { /* ignore */ }
        this.updateRegistryState();
        this.emitter.emit('change', { type: 'closed', name });
        return true;
    }

    public rename(name: string, newAlias: string): boolean {
        const handle = this.terminals.get(name);
        if (!handle || this.terminals.has(newAlias)) return false;

        this.terminals.delete(name);
        handle.friendlyName = newAlias;
        (handle as any).name = newAlias;
        this.terminals.set(newAlias, handle);

        this.updateRegistryState();
        this.emitter.emit('change', { type: 'renamed', oldName: name, newName: newAlias });
        return true;
    }

    /**
     * Persist the live fleet into the shared `runtime.terminals` registry (the
     * `terminals` state key per stateConfigBridge.ts) so /health, the board and
     * worktree routing all see PTY terminals.
     *
     * Merges rather than clobbers: entries whose `ideName`/`purpose` are NOT ours
     * belong to another writer (a VS Code host that opened this same workspace db)
     * and are preserved verbatim. Only `purpose:'pty'` rows are ours to rewrite.
     *
     * Writes are serialized through `_registryWrite` — setConfigJson is async and
     * concurrent create/exit bursts would otherwise interleave read-modify-write
     * cycles and drop entries.
     */
    private updateRegistryState(): void {
        if (!this.db) return;
        const db = this.db;
        this._registryWrite = this._registryWrite.then(async () => {
            const existing = db.getConfigJsonSync<Record<string, any>>('runtime.terminals', {}) || {};
            const terminalMap: Record<string, any> = {};
            for (const [name, entry] of Object.entries(existing)) {
                if (entry && entry.purpose === 'pty') { continue; }
                if (entry && entry.ideName === PTY_IDE_NAME) { continue; }
                terminalMap[name] = entry;
            }
            for (const [name, t] of this.terminals.entries()) {
                terminalMap[name] = {
                    friendlyName: t.friendlyName,
                    role: t.role,
                    status: t.status,
                    pid: t.pty.pid,
                    startTime: t.startTime,
                    worktreePath: t.worktreePath,
                    cwd: t.cwd,
                    hidden: t.hidden === true,
                    ideName: PTY_IDE_NAME,
                    purpose: 'pty',
                    agentInstanceId: t.agentInstanceId,
                    parentInstanceId: t.parentInstanceId,
                } satisfies FleetTerminalInfo;
            }
            await db.setConfigJson('runtime.terminals', terminalMap);
        }).catch(err => {
            console.warn('[PtyFleetService] Failed to update terminal registry state:', err);
        });
    }

    public async disposeAll(): Promise<void> {
        const activeList = this.listActive();
        for (const handle of activeList) {
            try {
                handle.pty.kill('SIGTERM');
            } catch { /* ignore */ }
        }

        if (activeList.length > 0) {
            const start = Date.now();
            while (Date.now() - start < SIGTERM_GRACE_MS) {
                if (this.listActive().length === 0) break;
                await new Promise(r => setTimeout(r, 100));
            }
        }

        for (const handle of Array.from(this.terminals.values())) {
            try {
                handle.pty.kill('SIGKILL');
            } catch { /* ignore */ }
        }
        this.terminals.clear();
        this.updateRegistryState();
    }

    /**
     * Last-resort reaper. The GRACEFUL path is `instance.stop()`, which awaits
     * `disposeAll()` and gets the full SIGTERM → grace → SIGKILL budget; cli.ts
     * awaits that before `process.exit(0)`.
     *
     * This handler exists only for exits that never reach `stop()` (an uncaught
     * throw, a stray `process.exit()`). It is deliberately SYNCHRONOUS: on the
     * `exit` event the event loop is already drained, so an async `disposeAll()`
     * would send SIGTERM and never live to escalate — leaving orphaned shells and
     * risking the node-pty N-API teardown SIGABRT (upstream #904) that this whole
     * dispose-before-exit requirement exists to prevent. One hard kill, no awaits.
     */
    private setupShutdownHandlers(): void {
        const reapNow = () => {
            for (const handle of Array.from(this.terminals.values())) {
                try { handle.pty.kill('SIGKILL'); } catch { /* already gone */ }
            }
            this.terminals.clear();
        };
        process.once('exit', reapNow);
    }

    /**
     * Boot reconcile: drop every `purpose:'pty'` registry entry left over from a
     * previous run. PTYs are children of this process, so a recorded entry after a
     * restart is always a ghost — and a dispatch that resolved to one would route
     * work at a dead pid.
     *
     * MUST be awaited before LocalApiServer.start() accepts requests: the write
     * side is async (setConfigJson), so a fire-and-forget purge leaves a window in
     * which /kanban/dispatch's pre-flight sees ghosts and passes.
     */
    public static async purgePtyTerminals(db: KanbanDatabase): Promise<void> {
        try {
            const parsed = db.getConfigJsonSync<Record<string, any>>('runtime.terminals', {});
            if (!parsed || typeof parsed !== 'object') return;
            let modified = false;
            for (const key of Object.keys(parsed)) {
                const item = parsed[key];
                if (item && (item.purpose === 'pty' || item.ideName === PTY_IDE_NAME)) {
                    delete parsed[key];
                    modified = true;
                }
            }
            if (modified) {
                await db.setConfigJson('runtime.terminals', parsed);
            }
        } catch (err) {
            console.warn('[PtyFleetService] Failed to purge PTY terminals on boot:', err);
        }
    }
}
