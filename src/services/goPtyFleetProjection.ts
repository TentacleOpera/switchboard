import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import type { DelegateDefinition } from './agentConfig';
import { deriveCliFamily, type CliFamily } from './cliIdentity';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import type { KanbanDatabase } from './KanbanDatabase';
import { MAX_DELEGATES_PER_PARENT, MAX_LIVE_DELEGATE_PTYS } from './ptyLimits';
import { PTY_IDE_NAME, type PtyHostSupervisor } from './ptyHostSupervisor';
import type { TerminalHandle } from './hostSeams';
import type {
    CreateOptions,
    ExtendedTerminalHandle,
    FleetChangeEvent,
    FleetLivenessEntry,
    FleetTerminalInfo,
} from '../standalone/ptyFleetService';

export { MAX_DELEGATES_PER_PARENT, MAX_LIVE_DELEGATE_PTYS, PTY_IDE_NAME };
export const SHELL_READINESS_DELAY_MS = 750;

const SINGLETON_IDENTITIES: ReadonlyMap<string, string> = new Map([
    ['mission-control', 'controller'],
    ['project_manager', 'controller'],
]);

function singletonIdentityForRole(role: string): string | undefined {
    return SINGLETON_IDENTITIES.get(role);
}

interface ProjectedTerminal {
    friendlyName: string;
    role: string;
    status: 'active' | 'exited';
    pid: number;
    startTime: string;
    worktreePath?: string;
    cwd?: string;
    agentInstanceId?: string;
    parentInstanceId?: string | null;
    cliFamily?: CliFamily;
    startupCommand?: string;
    startupCommandSource?: string;
    lastDataAt?: number;
    promptCount?: number;
    hidden?: boolean;
    claudeInlineRendering?: boolean;
    _isTeamMember?: boolean;
}

/**
 * Host-side fleet client for the Go PTY supervisor. Board orchestration keeps
 * talking to the TypeScript fleet surface; bytes and process ownership stay in Go.
 */
export class GoPtyFleetProjection {
    private readonly emitter = new EventEmitter();
    private cache = new Map<string, ExtendedTerminalHandle>();
    private recentlyClosed = new Map<string, number>();
    private static readonly RECENTLY_CLOSED_CAP = 64;
    private db?: KanbanDatabase;
    private _registryWrite: Promise<void> = Promise.resolve();
    private _reconcileInFlight: Promise<void> | null = null;
    private _claudeInlineRenderingResolver?: () => boolean;
    private _controllerSeatResolver?: () => { terminalName?: string } | null | undefined;
    private _sharedMemberChains = new Map<string, Promise<unknown>>();

    public constructor(
        private readonly supervisor: PtyHostSupervisor,
        private readonly workspaceRoot = '',
        db?: KanbanDatabase,
        private readonly apiToken?: string,
    ) {
        this.db = db;
        void this.refresh().catch(() => { /* best-effort initial projection */ });
        this.onDidChange((event) => {
            if (event.type === 'closed') {
                this._recordRecentlyClosed(event.name);
            } else if (event.type === 'renamed') {
                const closedAt = this.recentlyClosed.get(event.oldName);
                if (closedAt !== undefined) {
                    this.recentlyClosed.delete(event.oldName);
                    this.recentlyClosed.set(event.newName, closedAt);
                }
            }
        });
    }

    public setClaudeInlineRenderingResolver(resolver: () => boolean): void {
        this._claudeInlineRenderingResolver = resolver;
    }

    public setControllerSeatResolver(resolver: () => { terminalName?: string } | null | undefined): void {
        this._controllerSeatResolver = resolver;
        void this.supervisor.request('ptySetControllerSeat', { seat: resolver() ?? null }).catch(() => { /* best-effort */ });
    }

    public setDatabase(db: KanbanDatabase): void {
        this.db = db;
    }

    public onDidChange(listener: (event: FleetChangeEvent) => void): { dispose: () => void } {
        this.emitter.on('change', listener);
        return { dispose: () => { this.emitter.off('change', listener); } };
    }

    public list(): ExtendedTerminalHandle[] {
        return Array.from(this.cache.values());
    }

    public listActive(): ExtendedTerminalHandle[] {
        return this.list().filter(t => t.status === 'active');
    }

    public getLiveness(): FleetLivenessEntry[] {
        const entries: FleetLivenessEntry[] = [];
        for (const t of this.cache.values()) {
            entries.push({ friendlyName: t.friendlyName, lastDataAt: t.lastDataAt, status: t.status, role: t.role });
        }
        for (const [name, closedAt] of this.recentlyClosed.entries()) {
            if (this.cache.has(name)) { continue; }
            entries.push({ friendlyName: name, lastDataAt: closedAt, status: 'exited' });
        }
        return entries;
    }

    public get(name: string): ExtendedTerminalHandle | undefined {
        return this.cache.get(name);
    }

    public getByAgentInstanceId(id: string): ExtendedTerminalHandle | undefined {
        for (const t of this.cache.values()) {
            if (t.agentInstanceId === id) { return t; }
        }
        return undefined;
    }

    public reportSingletonDuplicates(identity: string): string[] {
        const handles: ExtendedTerminalHandle[] = [];
        for (const t of this.cache.values()) {
            if (singletonIdentityForRole(t.role) === identity) { handles.push(t); }
        }
        if (handles.length > 0 && this._controllerSeatResolver) {
            try {
                const seatName = this._controllerSeatResolver()?.terminalName;
                if (seatName && !handles.some(h => h.friendlyName === seatName)) {
                    const seatHandle = this.cache.get(seatName);
                    if (seatHandle) { handles.push(seatHandle); }
                }
            } catch { /* best-effort */ }
        }
        if (handles.length <= 1) { return []; }
        return handles.slice(1).map(h => h.friendlyName);
    }

    public listChildren(parentId: string): ExtendedTerminalHandle[] {
        return Array.from(this.cache.values()).filter(t => t.parentInstanceId === parentId);
    }

    public async create(
        role: string,
        friendlyName?: string,
        cwd?: string,
        worktreePath?: string,
        parentInstanceId?: string | null,
        startupCommand?: string,
        opts?: CreateOptions,
    ): Promise<ExtendedTerminalHandle> {
        await this.refresh();
        const identity = singletonIdentityForRole(role);
        if (identity) {
            const existing = this._findSingletonHandle(identity);
            const duplicates = this.reportSingletonDuplicates(identity);
            if (duplicates.length > 0) {
                this.emitter.emit('change', { type: 'singletonDuplicates', identity, names: duplicates } as any);
            }
            if (existing?.status === 'active') { return existing; }
            if (existing) {
                this.cache.delete(existing.friendlyName);
                if (!friendlyName) { friendlyName = existing.friendlyName; }
            }
        }

        let name = friendlyName || `${role}-1`;
        let counter = 1;
        while (this.cache.has(name)) {
            counter++;
            name = `${role}-${counter}`;
        }

        const effectiveCwd = cwd || worktreePath || this.workspaceRoot;
        const claudeInlineRendering = opts?.claudeInlineRendering
            ?? (this._claudeInlineRenderingResolver ? this._claudeInlineRenderingResolver() : true);

        let effectiveStartupCommand = startupCommand;
        let effectiveStartupSource: string;
        if (effectiveStartupCommand) {
            effectiveStartupSource = opts?._isTeamMember ? 'team-definition' : 'argument';
        } else {
            try {
                const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
                effectiveStartupCommand = commands[role];
                effectiveStartupSource = effectiveStartupCommand ? 'global-file' : 'none';
            } catch {
                effectiveStartupCommand = undefined;
                effectiveStartupSource = 'none';
            }
        }

        const result = await this.supervisor.request('ptyCreateTerminal', {
            role,
            name,
            cwd: effectiveCwd,
            worktreePath,
            parentInstanceId: parentInstanceId ?? undefined,
            hidden: opts?.hidden === true,
            claudeInlineRendering,
            apiToken: this.apiToken,
            _isTeamMember: opts?._isTeamMember === true,
        });
        if (!result || result.success === false) {
            throw new Error(result?.error || `PTY create failed (state: ${this.supervisor.getState()})`);
        }
        const row = (result.terminal || result) as ProjectedTerminal;
        const handle = this.materialize({
            ...row,
            friendlyName: row.friendlyName || name,
            role: row.role || role,
            cwd: row.cwd || effectiveCwd,
            worktreePath: row.worktreePath || worktreePath,
            parentInstanceId: row.parentInstanceId ?? parentInstanceId,
            hidden: opts?.hidden === true,
            claudeInlineRendering,
            _isTeamMember: opts?._isTeamMember === true,
            startupCommand: effectiveStartupCommand,
            startupCommandSource: effectiveStartupSource,
            cliFamily: deriveCliFamily(effectiveStartupCommand),
        });
        this.cache.set(handle.friendlyName, handle);
        this.updateRegistryState();
        this.emitter.emit('change', { type: 'created', terminal: handle });

        if (effectiveStartupCommand) {
            await new Promise(resolve => setTimeout(resolve, SHELL_READINESS_DELAY_MS));
            if (handle.status === 'active') {
                handle.injectedAtMs = Date.now();
                handle.outputBytesSinceInjection = 0;
                handle.sendText(effectiveStartupCommand, true);
            }
        }
        return handle;
    }

    public async spawnDelegates(
        parent: ExtendedTerminalHandle,
        definitions: DelegateDefinition[],
        opts?: { teamName?: string },
    ): Promise<{ children: ExtendedTerminalHandle[]; createdNames: string[]; error?: string }> {
        const perTeamRequested = definitions
            .filter(d => d.scope !== 'shared')
            .reduce((n, d) => n + Math.max(1, Math.min(d.count || 1, MAX_DELEGATES_PER_PARENT)), 0);
        if (perTeamRequested > MAX_DELEGATES_PER_PARENT) {
            return { children: [], createdNames: [], error: `Delegate cap: ${perTeamRequested} requested, ${MAX_DELEGATES_PER_PARENT} allowed per head agent` };
        }
        const liveDelegates = Array.from(this.cache.values()).filter(t => t.parentInstanceId).length;
        if (liveDelegates + perTeamRequested > MAX_LIVE_DELEGATE_PTYS) {
            return { children: [], createdNames: [], error: `Delegate cap: ${liveDelegates} live, ${perTeamRequested} requested, ${MAX_LIVE_DELEGATE_PTYS} allowed in total` };
        }

        const children: ExtendedTerminalHandle[] = [];
        const createdNames: string[] = [];
        for (const d of definitions) {
            const count = Math.max(1, Math.min(d.count || 1, MAX_DELEGATES_PER_PARENT));
            if (d.scope === 'shared') {
                const teamName = opts?.teamName || 'team';
                const sharedBaseName = `${teamName}-${d.label || d.role}`;
                for (let i = 0; i < count; i++) {
                    const suffix = count > 1 ? `-${i + 1}` : '';
                    const sharedName = `${sharedBaseName}${suffix}`;
                    let wasCreated = false;
                    try {
                        const existing = await this._sharedMemberChain(sharedName, async () => {
                            const live = this.listActive().find(t => t.friendlyName === sharedName);
                            if (live) { return live; }
                            wasCreated = true;
                            return this.create(d.role, sharedName, parent.cwd, parent.worktreePath, undefined, d.startupCommand, {
                                _isTeamMember: true,
                                claudeInlineRendering: parent.claudeInlineRendering,
                            });
                        });
                        children.push(existing);
                        if (wasCreated) { createdNames.push(existing.friendlyName); }
                    } catch (err) {
                        return { children, createdNames, error: `Shared member '${sharedName}' failed to spawn: ${err instanceof Error ? err.message : String(err)}` };
                    }
                }
                continue;
            }
            for (let i = 0; i < count; i++) {
                const suffix = count > 1 ? `-${i + 1}` : '';
                const baseName = `${parent.friendlyName}-${d.label || d.role}${suffix}`;
                try {
                    const child = await this.create(
                        d.role, baseName, parent.cwd, parent.worktreePath, parent.agentInstanceId, d.startupCommand,
                        { _isTeamMember: true, claudeInlineRendering: parent.claudeInlineRendering },
                    );
                    children.push(child);
                    createdNames.push(child.friendlyName);
                } catch (err) {
                    return { children, createdNames, error: `Delegate '${baseName}' failed to spawn: ${err instanceof Error ? err.message : String(err)}` };
                }
            }
        }
        return { children, createdNames };
    }

    public async createBatch(
        allocation: Array<{ role: string; count: number }>,
        cwd?: string,
        worktreePath?: string,
        claudeInlineRendering?: boolean,
    ): Promise<{ success: boolean; created: Array<{ friendlyName: string; role: string }>; failed: Array<{ role: string; reason: string; kind: string }>; error?: string; estimatedDurationMs: number }> {
        const MAX_BATCH = 32;
        const created: Array<{ friendlyName: string; role: string }> = [];
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
                    const t = await this.create(a.role, undefined, cwd, worktreePath, null, undefined, { claudeInlineRendering });
                    created.push({ friendlyName: t.friendlyName, role: t.role });
                } catch (err: any) {
                    const msg = err instanceof Error ? err.message : String(err);
                    let kind = 'unknown';
                    if (/posix_openpt failed: Device not configured|No space left on device/i.test(msg)) { kind = 'pty-pool-exhausted'; }
                    else if (/posix_openpt failed: Too many open files|File table overflow/i.test(msg)) { kind = 'fd-limit'; }
                    else if (/posix_spawnp failed|spawn-helper ENOENT|PTY/i.test(msg)) { kind = 'spawn-failed'; }
                    failed.push({ role: a.role, reason: msg, kind });
                    if (kind === 'pty-pool-exhausted' || kind === 'fd-limit') { abortResource = true; }
                }
            }
        }
        return {
            success: created.length > 0 && failed.length === 0,
            created,
            failed,
            estimatedDurationMs: total * SHELL_READINESS_DELAY_MS,
            ...(failed.length > 0 && created.length === 0 ? { error: failed.map(f => `${f.role}: ${f.reason}`).join('; ') } : {}),
        };
    }

    public kill(name: string): boolean {
        const handle = this.cache.get(name);
        if (!handle) { return false; }
        const children = this.listChildren(handle.agentInstanceId);
        for (const child of children) { this.kill(child.friendlyName); }
        (handle as any)._live?.close?.();
        this.cache.delete(name);
        void this.supervisor.request('ptyCloseTerminal', { name }).catch(() => { /* already gone */ });
        this.updateRegistryState();
        this.emitter.emit('change', { type: 'closed', name });
        return true;
    }

    public rename(name: string, newAlias: string): boolean {
        const handle = this.cache.get(name);
        if (!handle || this.cache.has(newAlias)) { return false; }
        void this.supervisor.request('ptyRenameTerminal', { name, alias: newAlias }).catch(() => { /* best-effort */ });
        this.cache.delete(name);
        handle.friendlyName = newAlias;
        (handle as any).name = newAlias;
        this.cache.set(newAlias, handle);
        this.updateRegistryState();
        this.emitter.emit('change', { type: 'renamed', oldName: name, newName: newAlias });
        return true;
    }

    public async disposeAll(): Promise<void> {
        const names = Array.from(this.cache.keys());
        for (const name of names) { this.kill(name); }
        this.cache.clear();
        await this.supervisor.stop();
        this.updateRegistryState();
    }

    public static async purgePtyTerminals(db: KanbanDatabase): Promise<void> {
        try {
            const parsed = db.getConfigJsonSync<Record<string, any>>('runtime.terminals', {});
            if (!parsed || typeof parsed !== 'object') { return; }
            let modified = false;
            for (const key of Object.keys(parsed)) {
                const item = parsed[key];
                if (item && (item.purpose === 'pty' || item.ideName === PTY_IDE_NAME)) {
                    delete parsed[key];
                    modified = true;
                }
            }
            if (modified) { await db.setConfigJson('runtime.terminals', parsed); }
        } catch (err) {
            console.warn('[GoPtyFleetProjection] Failed to purge PTY terminals on boot:', err);
        }
    }

    private _findSingletonHandle(identity: string): ExtendedTerminalHandle | undefined {
        for (const t of this.cache.values()) {
            if (singletonIdentityForRole(t.role) === identity) { return t; }
        }
        if (this._controllerSeatResolver) {
            try {
                const seatName = this._controllerSeatResolver()?.terminalName;
                if (seatName) { return this.cache.get(seatName); }
            } catch { /* best-effort */ }
        }
        return undefined;
    }

    private async _sharedMemberChain<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const chain = this._sharedMemberChains.get(name) || Promise.resolve();
        const p = chain.then(() => fn());
        const guarded = p.catch(() => {});
        this._sharedMemberChains.set(name, guarded);
        try {
            return await p;
        } finally {
            if (this._sharedMemberChains.get(name) === guarded) { this._sharedMemberChains.delete(name); }
        }
    }

    private _recordRecentlyClosed(name: string): void {
        if (this.recentlyClosed.has(name)) { this.recentlyClosed.delete(name); }
        this.recentlyClosed.set(name, Date.now());
        while (this.recentlyClosed.size > GoPtyFleetProjection.RECENTLY_CLOSED_CAP) {
            const oldest = this.recentlyClosed.keys().next().value;
            if (oldest === undefined) { break; }
            this.recentlyClosed.delete(oldest);
        }
    }

    /**
     * Reconcile the cache against the Go host's authoritative roster, for READ
     * paths.
     *
     * Why a read path needs this at all: `_ptyHostVerb` prefers
     * `_ptyHostSupervisor` over `_fleetVerb` (TaskViewerProvider.ts), and the
     * standalone host wires BOTH, so every `_ptyHostVerb` create goes straight to
     * the Go child and never touches this projection. Two such paths are
     * reachable under standalone — `createFleetTerminalAndDeliver` (Planning /
     * sidebar dispatch to a role with no seat yet) and `ensureWorktreeTerminals`
     * -> `_createAutobanTerminal` (worktree create). Standalone's
     * `ptyListTerminals` answers from `list()`, i.e. this cache, so a seat created
     * that way was absent from the sidebar, from `getLiveness()` (the activity-
     * light sweep then had no evidence for it and its card fell through to the
     * blind timer), and from `listActive()` turn-end recipient resolution — and it
     * had no live stream, so the natural-exit emit never fired for it either. The
     * extension host is unaffected because its `ptyListTerminals` arm returns the
     * Go child's own reply.
     *
     * Single-flighted: concurrent readers share one round-trip. `create()` calls
     * `refresh()` directly instead, because its name-collision loop needs a
     * snapshot taken after its own call rather than one a coalesced caller started
     * earlier.
     */
    public reconcile(): Promise<void> {
        if (!this._reconcileInFlight) {
            this._reconcileInFlight = this.refresh().finally(() => { this._reconcileInFlight = null; });
        }
        return this._reconcileInFlight;
    }

    private async refresh(): Promise<void> {
        // Names present BEFORE the round-trip. Eviction is scoped to these so a
        // handle added by a concurrent create() while the request was in flight
        // survives. The previous implementation replaced `this.cache` wholesale
        // with a map built from a snapshot that predated the new seat, which
        // dropped the handle and orphaned its live socket — a lost update that was
        // rare while `create()` was the only caller and is reachable on every list
        // now that read paths reconcile.
        const before = new Set(this.cache.keys());
        const listed = await this.supervisor.request('ptyListTerminals', {});
        const rows: ProjectedTerminal[] = Array.isArray(listed?.terminals) ? listed.terminals : [];
        // MERGE IN PLACE, never rebuild. The Go host lists from a Go map
        // (`for _, t := range f.terminals`), whose iteration order is randomized
        // by design, so rebuilding the cache from `rows` reshuffled it on every
        // refresh — a sidebar that reorders itself on every push, and a random
        // pick for `reportSingletonDuplicates`'s keeper. Merging preserves
        // creation order.
        //
        // The loop below is await-free, so it runs to completion as a single task:
        // a second concurrent refresh cannot interleave and materialize the same
        // row twice, which would open two sockets for one terminal and leak one.
        const seen = new Set<string>();
        for (const row of rows) {
            seen.add(row.friendlyName);
            // `rename()` fires its host request without awaiting, so a reconcile
            // can arrive while the host still reports the OLD name and the cache
            // already holds the NEW one. Fall back to the instance id, which
            // survives a rename and which the Go host stamps on every row
            // (`fleet.project`, cmd/switchboard-pty-host/main.go) — verified in the
            // emitted map literal, not in the optional TS field. Without this the
            // row materializes a duplicate handle, and a second socket, for a
            // terminal that is already cached.
            const existing = this.cache.get(row.friendlyName)
                ?? (row.agentInstanceId ? this.getByAgentInstanceId(row.agentInstanceId) : undefined);
            if (existing) {
                existing.status = row.status === 'exited' ? 'exited' : 'active';
                existing.lastDataAt = row.lastDataAt ?? existing.lastDataAt;
                existing.promptCount = row.promptCount ?? existing.promptCount;
                if (row.pid) { existing.pty = { ...existing.pty, pid: row.pid }; }
                // Its own key, which may differ from `row.friendlyName` on the
                // rename path above — otherwise the eviction pass below would drop
                // the handle it just matched.
                seen.add(existing.friendlyName);
                continue;
            }
            this.cache.set(row.friendlyName, this.materialize(row));
        }
        for (const name of before) {
            if (seen.has(name)) { continue; }
            // Close the live socket on eviction, as `kill()` does before its own
            // delete. The wholesale replace this rewrites leaked one socket per
            // evicted handle; that cost little while eviction was rare and costs
            // more now that every list reconciles.
            const stale = this.cache.get(name);
            (stale as any)?._live?.close?.();
            this.cache.delete(name);
        }
    }

    private attachLiveStream(
        name: string,
        dataListeners: Set<(chunk: string) => void>,
        exitListeners: Set<(code: number | undefined) => void>,
        handle: ExtendedTerminalHandle,
    ): { sendResize: (cols: number, rows: number) => void; close: () => void } {
        let socket: WebSocket | undefined;
        let closed = false;
        let pendingResize: { cols: number; rows: number } | undefined;
        const ready = this.supervisor.getReady();
        const sendResize = (cols: number, rows: number) => {
            pendingResize = { cols, rows };
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ t: 'resize', cols, rows }));
            }
        };
        const close = () => {
            closed = true;
            try { socket?.close(); } catch { /* ignore */ }
            socket = undefined;
        };
        if (!ready) { return { sendResize, close }; }
        const url = `ws://127.0.0.1:${ready.port}/ws/terminal?name=${encodeURIComponent(name)}&token=${encodeURIComponent(ready.terminalToken)}`;
        socket = new WebSocket(url);
        socket.on('open', () => {
            if (closed) { socket?.close(); return; }
            if (pendingResize && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ t: 'resize', cols: pendingResize.cols, rows: pendingResize.rows }));
            }
        });
        socket.on('message', (raw, isBinary) => {
            // Terminal output arrives as a BINARY frame — 4-byte big-endian seq
            // followed by UTF-8 (`encodeOutputFrame`, cmd/switchboard-pty-host/ws.go
            // and main.go's publish). Only `hello` and `exit` are JSON.
            //
            // This handler used to parse EVERY frame as JSON and `return` on failure,
            // so once the host moved output onto binary frames every chunk was
            // silently discarded here. That froze `lastDataAt`, and the freeze is not
            // inert: the Go host stamps `lastDataAt` at spawn, so the value stays
            // POSITIVE while never advancing. Every nudge site guards with
            // `lastDataAt <= 0 || now - lastDataAt < turnEndSilenceMs` — a frozen
            // positive stamp defeats the `<= 0` fail-safe and reads as "silent for
            // hours", the most confident possible wrong answer, so stall nudges fire
            // into actively working seats. `recordLiveness` also records 0 forever,
            // collapsing the activity-light basis to bare `dispatched_at` and blanking
            // a working card at `timeoutMs`.
            //
            // Decode binary first; fall back to the JSON arms for control frames.
            if (isBinary && Buffer.isBuffer(raw) && raw.length >= 4) {
                handle.lastDataAt = Date.now();
                handle.hasProducedOutput = true;
                const chunk = raw.subarray(4).toString('utf8');
                for (const cb of dataListeners) { cb(chunk); }
                return;
            }
            let message: { t?: string; data?: string; code?: number };
            try { message = JSON.parse(String(raw)); } catch { return; }
            if ((message.t === 'output' || message.t === 'replay') && typeof message.data === 'string') {
                handle.lastDataAt = Date.now();
                handle.hasProducedOutput = true;
                for (const cb of dataListeners) { cb(message.data); }
            } else if (message.t === 'exit') {
                handle.status = 'exited';
                handle.exitCode = message.code;
                for (const cb of exitListeners) { cb(message.code); }
                // Emit a fleet change so onDidChange subscribers (the
                // terminalsChanged push in bootstrap.ts) learn about natural
                // CLI exit. kill() emits {type:'closed'} itself, but a CLI
                // that exits on its own only reaches this arm — without this
                // emit the push never fires and the sidebar shows the seat
                // active until the next poll (now deleted). The extra emit
                // when kill() already removed the handle is harmless: the
                // client coalesces, and a second push for an already-closed
                // seat is a no-op refetch. Do NOT guard with
                // `if (this.cache.has(name))` — kill() deletes from cache
                // before the WebSocket closes, so that guard would suppress
                // the exit push for a seat killed while still running.
                this.emitter.emit('change', { type: 'closed', name });
            }
        });
        return { sendResize, close };
    }

    private materialize(row: ProjectedTerminal): ExtendedTerminalHandle {
        const name = row.friendlyName;
        const dataListeners = new Set<(chunk: string) => void>();
        const exitListeners = new Set<(code: number | undefined) => void>();
        const startedAtMs = Date.now();
        const handle: ExtendedTerminalHandle = {
            name,
            friendlyName: name,
            role: row.role || 'coder',
            agentInstanceId: row.agentInstanceId || crypto.randomUUID(),
            parentInstanceId: row.parentInstanceId,
            startTime: row.startTime || new Date().toISOString(),
            status: row.status === 'exited' ? 'exited' : 'active',
            worktreePath: row.worktreePath,
            cwd: row.cwd || this.workspaceRoot,
            cliFamily: row.cliFamily || deriveCliFamily(row.startupCommand),
            startupCommand: row.startupCommand,
            startupCommandSource: row.startupCommandSource,
            startedAtMs,
            lastDataAt: row.lastDataAt || startedAtMs,
            promptCount: row.promptCount || 0,
            hidden: row.hidden === true,
            claudeInlineRendering: row.claudeInlineRendering,
            _isTeamMember: row._isTeamMember === true,
            pty: {
                pid: row.pid || 0,
                kill: (signal?: string) => { void this.supervisor.request('ptyCloseTerminal', { name, signal }).catch(() => { /* ignore */ }); },
            },
            sendText: (text: string, addNewLine?: boolean) => {
                void this.supervisor.request('ptyWrite', { name, data: addNewLine ? `${text}\r` : text }).catch(() => { /* ignore */ });
            },
            write: (data: string) => {
                void this.supervisor.request('ptyWrite', { name, data }).catch(() => { /* ignore */ });
            },
            onData: (cb: (chunk: string) => void) => {
                dataListeners.add(cb);
                return { dispose: () => { dataListeners.delete(cb); } };
            },
            onExit: (cb: (code: number | undefined) => void) => {
                exitListeners.add(cb);
                return { dispose: () => { exitListeners.delete(cb); } };
            },
            resize: (cols: number, rows: number) => { stream.sendResize(cols, rows); },
            dispose: () => { stream.close(); this.kill(name); },
            kill: () => { stream.close(); this.kill(name); },
            show: () => { /* headless */ },
        } as ExtendedTerminalHandle & TerminalHandle;
        const stream = this.attachLiveStream(name, dataListeners, exitListeners, handle);
        (handle as any)._live = stream;
        return handle;
    }

    private updateRegistryState(): void {
        if (!this.db) { return; }
        const db = this.db;
        this._registryWrite = this._registryWrite.then(async () => {
            const existing = db.getConfigJsonSync<Record<string, any>>('runtime.terminals', {}) || {};
            const terminalMap: Record<string, any> = {};
            for (const [entryName, entry] of Object.entries(existing)) {
                if (entry && entry.purpose === 'pty') { continue; }
                if (entry && entry.ideName === PTY_IDE_NAME) { continue; }
                terminalMap[entryName] = entry;
            }
            for (const [entryName, t] of this.cache.entries()) {
                terminalMap[entryName] = {
                    friendlyName: t.friendlyName,
                    role: t.role,
                    status: t.status,
                    pid: t.pty?.pid,
                    startTime: t.startTime,
                    worktreePath: t.worktreePath,
                    cwd: t.cwd,
                    ideName: PTY_IDE_NAME,
                    purpose: 'pty',
                    agentInstanceId: t.agentInstanceId,
                    parentInstanceId: t.parentInstanceId,
                    cliFamily: t.cliFamily,
                } satisfies FleetTerminalInfo;
            }
            await db.setConfigJson('runtime.terminals', terminalMap);
        }).catch(err => {
            console.warn('[GoPtyFleetProjection] Failed to update terminal registry state:', err);
        });
    }
}
