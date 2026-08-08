import { EventEmitter } from 'events';
import type { TerminalHandle } from '../services/hostSeams';
import { PtyTerminalBackend } from './ptyBackend';
import { GlobalIntegrationConfigService } from '../services/GlobalIntegrationConfigService';
import type { KanbanDatabase } from '../services/KanbanDatabase';

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
    ideName: string;
    purpose: string;
}

export interface ExtendedTerminalHandle extends TerminalHandle {
    pty: import('node-pty').IPty;
    role: string;
    friendlyName: string;
    startTime: string;
    status: 'active' | 'exited';
    worktreePath?: string;
    cwd: string;
    exitCode?: number;
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

    public async create(role: string, friendlyName?: string, cwd?: string, worktreePath?: string): Promise<ExtendedTerminalHandle> {
        let name = friendlyName || `${role}-1`;
        let counter = 1;
        while (this.terminals.has(name)) {
            counter++;
            name = `${role}-${counter}`;
        }

        const effectiveCwd = cwd || worktreePath || this.workspaceRoot;
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
            ...(this.apiToken ? { SWITCHBOARD_API_TOKEN: this.apiToken } : {}),
        };
        const rawHandle = this.backend.create({
            name,
            cwd: effectiveCwd,
            env: { ...process.env, ...switchboardEnv } as Record<string, string>,
        });

        const startTime = new Date().toISOString();
        const handle: ExtendedTerminalHandle = {
            ...rawHandle,
            name,
            role,
            friendlyName: name,
            startTime,
            status: 'active',
            worktreePath: worktreePath || undefined,
            cwd: effectiveCwd,
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

        await this.injectStartupCommand(handle, role);

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
    private async injectStartupCommand(handle: ExtendedTerminalHandle, role: string): Promise<void> {
        try {
            const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
            const cmd = commands[role];
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

    public kill(name: string): boolean {
        const handle = this.terminals.get(name);
        if (!handle) return false;
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
                    ideName: PTY_IDE_NAME,
                    purpose: 'pty',
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
