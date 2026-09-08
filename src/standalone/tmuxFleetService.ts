import { EventEmitter } from 'events';
import type { KanbanDatabase } from '../services/KanbanDatabase';
import {
    TMUX_IDE_NAME,
    type TmuxSocket,
    type TmuxPane,
    TmuxTerminalHandle,
    listTmuxPanes,
    validatePaneId,
    TmuxTerminalBackend,
} from './tmuxBackend';

/**
 * tmux Bridge — Part 2: Fleet service for adopted tmux panes.
 *
 * Modelled on {@link PtyFleetService}, but for panes Switchboard does NOT own:
 * no spawn/reap lifecycle, no SIGTERM escalation, no `disposeAll()` that kills
 * anything. A pane is adopted explicitly (verb) or by title pattern (config),
 * persisted in `runtime.terminals` tagged `ideName: 'switchboard-tmux'`, and
 * reconciled — not purged — across restarts, because a user's `coder-1` pane
 * outlives a Switchboard restart and re-adopting it would be flakiness.
 *
 * SECURITY: the defining risk of the tmux bridge is prompt-into-shell execution.
 * The four mitigations ship together (see the plan): opt-in default-off setting,
 * explicit adoption, bare-shell refusal without `force`, and newline flattening
 * for non-CLI-agent panes (Part 1). This service owns the second and third.
 */

// ─── Bare-shell guard ────────────────────────────────────────────────────
// Applied to `pane_current_command` (the foreground process name from
// `list-panes`), NOT to a terminal-name regex. The existing `isCliAgent`
// regex (terminalUtils.ts:220) tests terminal names, not process names, and
// is not applicable here. A bare-shell pane refuses adoption without `force`
// because a dispatch into it executes the prompt as shell commands.
const SHELL_BLACKLIST = /^(bash|zsh|fish|sh|dash|ksh|csh|tcsh)$/;

/**
 * Error thrown when {@link adopt} refuses a bare-shell pane. The caller
 * retries with `force: true` — there is no confirmation dialog (see
 * CLAUDE.md: no confirm gates). This is a guard, not a prompt.
 */
export class BareShellError extends Error {
    readonly paneId: string;
    readonly currentCommand: string;
    constructor(paneId: string, currentCommand: string) {
        super(
            `Pane ${paneId} is running a bare shell ('${currentCommand}'). `
            + `Adopting it would make dispatch execute prompts as shell commands. `
            + `Retry with force: true to adopt anyway.`
        );
        this.name = 'BareShellError';
        this.paneId = paneId;
        this.currentCommand = currentCommand;
    }
}

// ─── Adopted pane record ─────────────────────────────────────────────────
/** In-memory + registry record for an adopted pane. `paneId` is the identity. */
export interface AdoptedPane {
    paneId: string;
    friendlyName: string;
    role: string;
    pid: string;
    worktreePath: string;
    status: 'active';
    sessionName: string;
    windowName: string;
    currentCommand: string;
    currentPath: string;
    /** ISO timestamp of the last reconcile/adopt pass that confirmed liveness. */
    lastSeen: string;
}

export type TmuxFleetChangeEvent =
    | { type: 'adopted'; paneId: string }
    | { type: 'released'; paneId: string }
    | { type: 'renamed'; paneId: string; oldName: string; newName: string };

// ─── Name normalization ──────────────────────────────────────────────────
// Mirrors `normalizeAgentKey` (TaskViewerProvider.ts:497) and the duplicate
// in tmuxBackend.ts: lowercase, collapse hyphens/underscores to spaces, trim.
// Duplicated here so a name collision between a PTY and a tmux pane resolves
// identically in both fleets — the PTY-wins tie-break in getRegisteredTerminals
// depends on both sides normalizing the same way.
function normalizeAgentKey(value: string): string {
    return (value || '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ─── Registry ownership sub-tag ──────────────────────────────────────────
// `ideName: 'switchboard-tmux'` is written by TWO independent services: this
// adoption fleet (Part 2) and `tmuxTeamSeating.updateTmuxRegistryState` (Part 4).
// Both use the same "replace my rows, preserve everything else" merge, so
// without a second discriminator each write silently deleted the other's rows.
// A row with no `tmuxOwner` predates the tag and belongs to this fleet — the
// seating writer is the one that must opt in explicitly.
export const TMUX_OWNER_ADOPT = 'adopt';
export const TMUX_OWNER_SEAT = 'seat';

/** True when a registry entry is an adopted-pane row this fleet owns. */
function isOwnedByAdoptFleet(entry: any): boolean {
    if (!entry) { return false; }
    if (entry.ideName !== TMUX_IDE_NAME && entry.purpose !== 'tmux') { return false; }
    return entry.tmuxOwner !== TMUX_OWNER_SEAT;
}

/**
 * Fleet service for adopted tmux panes. Constructed by `bootstrap.ts` only
 * when `switchboard.terminal.tmux.enabled` is true AND `isTmuxAvailable()`
 * returns true. A disabled or unavailable host never constructs one, so every
 * tmux code path is gated at the composition root.
 */
export class TmuxFleetService {
    private readonly _workspaceRoot: string;
    private readonly _db: KanbanDatabase;
    private readonly _backend: TmuxTerminalBackend;
    private readonly _socket?: TmuxSocket;
    private readonly _panes = new Map<string, AdoptedPane>();
    private readonly _emitter = new EventEmitter();
    /** Serializes async registry read-modify-write cycles. See _updateRegistry. */
    private _registryWrite: Promise<void> = Promise.resolve();
    /** Auto-adopt title pattern; empty = matches nothing. */
    private _paneTitlePattern: string = '';

    constructor(workspaceRoot: string, db: KanbanDatabase, backend: TmuxTerminalBackend, socket?: TmuxSocket) {
        this._workspaceRoot = workspaceRoot;
        this._db = db;
        this._backend = backend;
        this._socket = socket;
    }

    /** Set the auto-adopt title pattern. Empty = explicit adoption only. */
    setPaneTitlePattern(pattern: string): void {
        this._paneTitlePattern = pattern || '';
    }

    onDidChange(listener: (e: TmuxFleetChangeEvent) => void): { dispose: () => void } {
        this._emitter.on('change', listener);
        return { dispose: () => { this._emitter.off('change', listener); } };
    }

    /**
     * Panes currently adopted (in-memory). Feeds `getRegisteredTerminals()`.
     * Synchronous by design: the dispatch pre-flight reads this on every
     * `POST /kanban/dispatch`, and an async probe there would serialize every
     * dispatch behind a tmux `list-panes` round trip. Liveness is refreshed by
     * {@link reconcile}, run at boot before the server accepts requests.
     */
    listActive(): AdoptedPane[] {
        return Array.from(this._panes.values());
    }

    /**
     * Resolve an adopted pane by friendly name (normalized) or pane id.
     * Returns a {@link TmuxTerminalHandle} for the delivery path, or undefined
     * if no adopted pane matches. Does NOT probe tmux — call {@link reconcile}
     * to refresh liveness, or rely on the send-time failure to surface a dead
     * pane.
     */
    get(nameOrPaneId: string): TmuxTerminalHandle | undefined {
        if (!nameOrPaneId) { return undefined; }
        // paneId exact match first — it is the stable identity.
        if (/^%\d+$/.test(nameOrPaneId)) {
            const pane = this._panes.get(nameOrPaneId);
            if (pane) {
                return new TmuxTerminalHandle(pane.friendlyName, pane.paneId, this._socket);
            }
        }
        const target = normalizeAgentKey(nameOrPaneId);
        for (const pane of this._panes.values()) {
            if (normalizeAgentKey(pane.friendlyName) === target) {
                return new TmuxTerminalHandle(pane.friendlyName, pane.paneId, this._socket);
            }
        }
        return undefined;
    }

    /**
     * Explicit adoption. Refuses a bare shell unless `force` — a dispatch into
     * a `bash` pane executes the prompt as shell commands, which is the
     * defining risk of the bridge. The refusal is a thrown {@link BareShellError}
     * the caller can retry with `force`; there is no confirmation dialog (see
     * CLAUDE.md). Validates `paneId` against `/^%\d+$/` before it reaches any
     * tmux `-t` argument.
     */
    async adopt(paneId: string, role: string, alias?: string, force?: boolean): Promise<AdoptedPane> {
        validatePaneId(paneId);
        const panes = await listTmuxPanes(this._socket);
        const pane = panes.find(p => p.paneId === paneId);
        if (!pane) {
            throw new Error(`tmux pane ${paneId} not found. It may have been closed.`);
        }
        // Bare-shell guard — the third mitigation. `force` overrides; there is
        // no prompt and no dialog, just an error the caller can retry.
        if (!force && SHELL_BLACKLIST.test(pane.paneCurrentCommand)) {
            throw new BareShellError(paneId, pane.paneCurrentCommand);
        }
        const friendlyName = (alias && alias.trim()) ? alias.trim() : pane.friendlyName;
        const adopted: AdoptedPane = {
            paneId: pane.paneId,
            friendlyName,
            role: role || 'coder',
            pid: pane.panePid,
            worktreePath: pane.paneCurrentPath,
            status: 'active',
            sessionName: pane.sessionName,
            windowName: pane.windowName,
            currentCommand: pane.paneCurrentCommand,
            currentPath: pane.paneCurrentPath,
            lastSeen: new Date().toISOString(),
        };
        const existing = this._panes.get(paneId);
        this._panes.set(paneId, adopted);
        this._updateRegistry();
        if (existing && existing.friendlyName !== friendlyName) {
            this._emitter.emit('change', { type: 'renamed', paneId, oldName: existing.friendlyName, newName: friendlyName });
        } else {
            this._emitter.emit('change', { type: 'adopted', paneId });
        }
        return adopted;
    }

    /**
     * Unregister an adopted pane. NEVER kills the pane — Switchboard did not
     * create it and must never destroy the user's shell as a side effect of
     * release. Mirrors `TmuxTerminalHandle.dispose()`'s asymmetry.
     */
    async release(paneId: string): Promise<void> {
        validatePaneId(paneId);
        if (!this._panes.has(paneId)) { return; }
        this._panes.delete(paneId);
        this._updateRegistry();
        this._emitter.emit('change', { type: 'released', paneId });
    }

    /**
     * Boot reconcile — NOT a purge. tmux panes outlive Switchboard restarts,
     * so a recorded adoption is re-confirmed against the live `list-panes`
     * output rather than deleted wholesale. Drops rows whose `paneId` is gone,
     * refreshes names/paths for the rest, and re-adopts any pane whose title
     * matches the configured pattern (auto-adopt).
     *
     * MUST be awaited before the API server accepts requests: a stale row
     * satisfies the dispatch pre-flight and produces a 409-free dispatch into
     * nothing — the exact failure `purgePtyTerminals`'s await ordering exists
     * to prevent.
     */
    async reconcile(): Promise<{ dropped: number; kept: number; autoAdopted: number }> {
        // Hydrate from the persisted registry BEFORE comparing against live panes.
        // Without this the boot pass walks an empty in-memory map, keeps nothing,
        // drops nothing, and then writes a registry containing zero tmux rows —
        // a blanket purge wearing a reconcile's name, which is precisely the
        // failure this method exists to avoid. Adoption is persisted so that a
        // user's `coder-1` pane survives a Switchboard restart; that only works
        // if the restart reads it back.
        this._hydrateFromRegistry();
        const livePanes = await listTmuxPanes(this._socket);
        const liveByPaneId = new Map<string, TmuxPane>();
        for (const p of livePanes) { liveByPaneId.set(p.paneId, p); }

        // Auto-adopt: panes whose title matches the configured pattern. Empty
        // pattern = matches nothing. A non-empty default would turn dispatch
        // into arbitrary command execution in a shell the user was using for
        // something else — the reason adoption is explicit by default.
        let autoAdopted = 0;
        if (this._paneTitlePattern) {
            let pattern: RegExp;
            try {
                pattern = new RegExp(this._paneTitlePattern);
            } catch {
                pattern = new RegExp(this._paneTitlePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            }
            for (const pane of livePanes) {
                if (this._panes.has(pane.paneId)) { continue; }
                if (pane.paneTitle && pattern.test(pane.paneTitle)) {
                    // Auto-adopt respects the bare-shell guard — a titled bash
                    // pane is still a bare shell.
                    if (SHELL_BLACKLIST.test(pane.paneCurrentCommand)) { continue; }
                    const adopted: AdoptedPane = {
                        paneId: pane.paneId,
                        friendlyName: pane.friendlyName,
                        role: 'coder',
                        pid: pane.panePid,
                        worktreePath: pane.paneCurrentPath,
                        status: 'active',
                        sessionName: pane.sessionName,
                        windowName: pane.windowName,
                        currentCommand: pane.paneCurrentCommand,
                        currentPath: pane.paneCurrentPath,
                        lastSeen: new Date().toISOString(),
                    };
                    this._panes.set(pane.paneId, adopted);
                    autoAdopted++;
                    this._emitter.emit('change', { type: 'adopted', paneId: pane.paneId });
                }
            }
        }

        // Drop dead rows + refresh live ones. paneId is the identity; the
        // friendly name in the registry can go stale if the user renamed the
        // pane in tmux, so refresh from the live record each pass.
        let dropped = 0;
        let kept = 0;
        const toDelete: string[] = [];
        for (const [paneId, adopted] of this._panes.entries()) {
            const live = liveByPaneId.get(paneId);
            if (!live) {
                toDelete.push(paneId);
                dropped++;
                continue;
            }
            // Refresh mutable fields from the live record. paneId, pid are
            // stable; name/path/command can change.
            const refreshed: AdoptedPane = {
                ...adopted,
                // The friendly name is deliberately NOT refreshed from the live
                // pane: it may be an alias the operator passed to `adopt()`, and
                // re-deriving it from `pane_title` each pass would silently rename
                // an adopted seat out from under every caller holding the name.
                // `paneId` is the identity; the name is the operator's label.
                friendlyName: adopted.friendlyName,
                worktreePath: live.paneCurrentPath,
                sessionName: live.sessionName,
                windowName: live.windowName,
                currentCommand: live.paneCurrentCommand,
                currentPath: live.paneCurrentPath,
                lastSeen: new Date().toISOString(),
            };
            this._panes.set(paneId, refreshed);
            kept++;
        }
        for (const paneId of toDelete) {
            this._panes.delete(paneId);
            this._emitter.emit('change', { type: 'released', paneId });
        }
        this._updateRegistry();
        return { dropped, kept, autoAdopted };
    }

    /**
     * Load adopted-pane rows persisted by a previous process back into memory.
     * Only rows this fleet owns are taken; team-seated rows (`tmuxOwner: 'seat'`)
     * belong to `tmuxTeamSeating` and are left alone. Rows already in memory win,
     * so a hydrate is safe to run more than once. Liveness is NOT assumed — the
     * caller (`reconcile`) immediately re-confirms every hydrated row against
     * `list-panes` and drops the ones whose pane is gone.
     */
    private _hydrateFromRegistry(): void {
        let existing: Record<string, any>;
        try {
            existing = this._db.getConfigJsonSync<Record<string, any>>('runtime.terminals', {}) || {};
        } catch {
            return;   // an unreadable registry is an empty one for this purpose
        }
        for (const entry of Object.values(existing)) {
            if (!isOwnedByAdoptFleet(entry)) { continue; }
            const paneId = entry?.paneId;
            if (typeof paneId !== 'string' || !/^%\d+$/.test(paneId)) { continue; }
            if (this._panes.has(paneId)) { continue; }
            this._panes.set(paneId, {
                paneId,
                friendlyName: entry.friendlyName || paneId,
                role: entry.role || 'coder',
                pid: entry.pid || '',
                worktreePath: entry.worktreePath || '',
                status: 'active',
                sessionName: entry.sessionName || '',
                windowName: entry.windowName || '',
                currentCommand: entry.currentCommand || '',
                currentPath: entry.worktreePath || '',
                lastSeen: entry.lastSeen || new Date().toISOString(),
            });
        }
    }

    /**
     * Drop a single stale row (called when a send-time failure indicates the
     * pane died between reconcile and dispatch). Never kills — the pane is
     * already gone. Keeps the registry honest so the next pre-flight is
     * accurate.
     */
    dropStale(paneId: string): void {
        if (!this._panes.has(paneId)) { return; }
        this._panes.delete(paneId);
        this._updateRegistry();
        this._emitter.emit('change', { type: 'released', paneId });
    }

    /**
     * Persist the adopted fleet into the shared `runtime.terminals` registry,
     * merging — never clobbering — entries whose `ideName` is NOT
     * `switchboard-tmux`. The mirror of `PtyFleetService.updateRegistryState`:
     * PTY and VS Code rows survive untouched because this writer skips them,
     * and the PTY writer skips tmux rows the same way. Two hosts writing the
     * same DB concurrently both preserve the other's rows.
     *
     * Writes are serialized through `_registryWrite` — `setConfigJson` is async
     * and concurrent adopt/release bursts would otherwise interleave
     * read-modify-write cycles and drop entries.
     */
    private _updateRegistry(): void {
        const db = this._db;
        this._registryWrite = this._registryWrite.then(async () => {
            const existing = db.getConfigJsonSync<Record<string, any>>('runtime.terminals', {}) || {};
            const terminalMap: Record<string, any> = {};
            // Preserve every entry that is NOT ours. The mirror of
            // ptyFleetService.ts:1154-1158: skip rows whose purpose OR ideName
            // is ours, keep the rest verbatim — including unknown/legacy keys
            // (CLAUDE.md: preserve unknown keys, never rebuild the map).
            for (const [name, entry] of Object.entries(existing)) {
                if (entry && isOwnedByAdoptFleet(entry)) { continue; }
                terminalMap[name] = entry;
            }
            for (const pane of this._panes.values()) {
                terminalMap[pane.friendlyName] = {
                    friendlyName: pane.friendlyName,
                    role: pane.role,
                    status: pane.status,
                    pid: pane.pid,
                    worktreePath: pane.worktreePath,
                    ideName: TMUX_IDE_NAME,
                    purpose: 'tmux',
                    // Sub-tag: which tmux writer owns this row. Two writers share
                    // `ideName: 'switchboard-tmux'` — this adoption fleet and
                    // tmuxTeamSeating's `updateTmuxRegistryState`. Without a
                    // discriminator each one's "replace my rows, preserve the rest"
                    // merge deletes the other's rows on every write.
                    tmuxOwner: TMUX_OWNER_ADOPT,
                    paneId: pane.paneId,
                    // REQUIRED, not decorative: startTmuxReconcilePoll judges a row
                    // dead when `!liveSessions.has(entry.sessionName)`. An undefined
                    // sessionName is never in that Set, so omitting this field marks
                    // every live adopted pane `status: 'exited'` on the first poll.
                    sessionName: pane.sessionName,
                    lastSeen: pane.lastSeen,
                };
            }
            await db.setConfigJson('runtime.terminals', terminalMap);
        }).catch(err => {
            console.warn('[TmuxFleetService] Failed to update terminal registry state:', err);
        });
    }
}
