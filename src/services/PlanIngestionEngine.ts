/**
 * PlanIngestionEngine — host-agnostic plan ingestion.
 *
 * Extracted from `GlobalPlanWatcherService` (Headless Ingestion piece 1) so the
 * VS Code extension and the standalone (`npx switchboard`) host share ONE
 * ingestion engine. The engine depends on the `PlanIngestionHost` seam instead
 * of `vscode`; the extension supplies a VS Code adapter, standalone supplies a
 * native `fs.watch` adapter. Behaviour is byte-stable with the pre-extraction
 * watcher — the only thing that changed is where the watchers/config/logger
 * come from.
 *
 * The engine's provider surface is exactly the three constructor factories the
 * original watcher carried (`getClickUpService`, `getLinearService`,
 * `getNotionService?`). On the ingestion path it fires ClickUp real-time
 * `debouncedSync` on import, Linear `archiveIssue` on delete/purge, and Notion
 * `archiveCard` on purge — all preserved verbatim. (Headless piece 3 wires only
 * the first two into the engine; the Notion slot stays undefined there, so the
 * purge-time Notion archive is a no-op headless until the full-parity plan
 * lands. The extension adapter passes all three.)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { KanbanDatabase, type KanbanPlanRecord } from './KanbanDatabase';
import { appendFeatureClobberDiag } from './featureClobberDiag';
import { parsePlanMetadata, extractClickUpTaskId, extractLinearIssueId } from './planMetadataUtils';
import { isRuntimeMirrorPlanFile } from './PlanFileImporter';
import type { ClickUpSyncService } from './ClickUpSyncService';
import type { LinearSyncService } from './LinearSyncService';
import type { NotionFetchService } from './NotionFetchService';
import { NotionRemoteProvider } from './remote/NotionRemoteProvider';
import { loadNotionRemoteSetup } from './remote/notionRemoteConfig';
import { substituteCliPath } from '../utils/cliPathToken';

// ─── Host seam ──────────────────────────────────────────────────────────────

export type PlanIngestionWatchEvent = 'create' | 'change' | 'delete';

export interface PlanIngestionWatchHandle {
    dispose(): void;
}

export interface PlanIngestionWatcher {
    /**
     * Watch a folder recursively for `.md` plan/feature files. The host is
     * responsible for the platform-specific watcher (VS Code FileSystemWatcher,
     * native `fs.watch` recursive, or a non-recursive tree-walk fallback) and
     * for filtering to `.switchboard/{plans,features}/` and all nested `.md` files. The engine
     * receives one event per file change/create/delete and debounces them.
     */
    watchFolder(
        folder: string,
        onEvent: (event: PlanIngestionWatchEvent, filePath: string) => void
    ): PlanIngestionWatchHandle;
    /**
     * Watch a single file (used for `.git/HEAD` branch-change tracking).
     */
    watchFile(
        filePath: string,
        onEvent: (event: PlanIngestionWatchEvent, filePath: string) => void
    ): PlanIngestionWatchHandle;
}

export interface PlanIngestionHostConfig {
    getBoolean(key: string, defaultValue: boolean): boolean;
    getNumber(key: string, defaultValue: number): number;
}

export interface PlanIngestionHostLogger {
    appendLine(line: string): void;
}

export type PlanIngestionEnvironmentChange = 'roots' | 'config';

/**
 * Turn-end notification payload. The engine emits this once per turn boundary
 * (gated on the existing single-fire signals) so a host can notify the agent
 * waiting on a seat. The engine supplies only what it knows — recipient
 * resolution and delivery are the host's job (see `setTurnEndNotifier`).
 */
export interface TurnEndInfo {
    /** Friendly name of the seat whose turn ended. */
    seatName: string;
    /** The plan file the seat was working on. */
    planFile: string;
    /** `completed` = the seat POSTed /kanban/queue/done (the seat finished);
     *  `stalled` = the feature-level nudge — no dispatch is outstanding, the head went idle with
     *  un-accepted subtasks remaining, and the engine is waking it with evidence. */
    outcome: 'completed' | 'stalled';
    /** The workspace root the swept card lives in. */
    workspaceRoot: string;
    /** Deliver directly to this terminal, skipping parent resolution. Used by the feature-level
     *  nudge, where the head IS the recipient — resolving its parent would address Mission Control
     *  instead. When absent, hosts resolve the seat's parent (the existing turn-end path). */
    recipientSeat?: string;
    /** Pre-composed evidence body for the nudge (remaining subtasks, their seats, silence, mtime).
     *  Hosts send this verbatim when set and fall back to their own one-line message when absent. */
    body?: string;
}

/**
 * Feature-level stall watch (the nudge). Armed by the head agent driving a
 * feature via `watchFeature` / cancelled by `unwatchFeature` (KanbanProvider
 * verbs) and persisted in the `kanban.featureWatches` config key. The sweep
 * reads this each tick and nudges the head when the feature has un-accepted
 * subtasks, no dispatch is outstanding, and the head has gone idle.
 */
export interface FeatureWatchRecord {
    featureId: string;
    headTerminal: string;
    armedAt: number;
    lastNudgedAt: number;
    /** 0 = not yet nudged, 1 = nudged once (stop). Re-armed to 0 by gate (4a)
     *  when a dispatch is outstanding, so the next idle window after a coder
     *  finishes gets a fresh nudge. Old persisted records without this field
     *  are treated as 0 (not yet nudged) — `undefined >= 1` is false. */
    nudgeCount: number;
}

/**
 * Queue-level stall watch — the backstop for a lead-paced pipeline with the
 * schedule off. Armed by every path that can leave cards staged (staging,
 * dispatch, remote intake) via `armQueueWatch`, and persisted in the
 * `kanban.queueWatches` config key. The sweep reads this each tick and nudges
 * the head when the queue has cards left, no card is in flight, and the head
 * has gone idle. If the head is gone, the user is told — the night never ends
 * silently with work still staged.
 *
 * `headTerminal` is null when cards are staged before any coding team is
 * seated; the sweep notifies the user once in that state and keeps the watch
 * until a head is seated (upgrading the record on the next arm or sweep).
 */
export interface QueueWatchRecord {
    headTerminal: string | null;   // null = staged with no coding head yet
    workspaceRoot: string;
    armedAt: number;
    lastNudgedAt: number;
    nudgeCount: number;
    /** Stamp of the one-shot "no coding head seated" user notice. Prevents
     *  repeating the same notice every tick while the state persists. */
    noHeadNotifiedAt?: number;
    /** Stamp of the one-shot escalation to the user ("the lead is not
     *  advancing"). Bounds escalation to ONE notice per stall: a second
     *  escalation for the same stalled queue trains the user to ignore it.
     *  Cleared by a real dispatch (the `onDispatch` re-arm and the in-flight
     *  gate), so a queue that stalls again after progress escalates again. */
    escalatedAt?: number;
    /** `${pacerSeat}:${planId}` of the last dead-pacer alert. The alert is
     *  about a specific seat holding a specific card, so the one-shot budget
     *  is keyed on that pair, not on the shared `escalatedAt` boolean: a
     *  re-stage to a second seat that also dies is new information, and a
     *  repeat about the same dead seat and card is not. Absent (old records,
     *  first alert) reads as "not yet alerted" — the safe direction. */
    deadPacerAlertedFor?: string;
}

export interface PlanIngestionHost {
    /** Watcher factory — creates recursive folder / single-file watchers. */
    readonly watcher: PlanIngestionWatcher;
    /** Config reader scoped to a `switchboard.*` section (`planWatcher` / `activityLight`). */
    getConfig(section: 'planWatcher' | 'activityLight'): PlanIngestionHostConfig;
    /** Logger (VS Code OutputChannel or console). */
    readonly logger: PlanIngestionHostLogger;
    /** The list of workspace roots to watch (mapped folders + fallback workspace folders). */
    listWatchedRoots(): Promise<string[]>;
    /** Register a handler fired when watched roots or relevant config changes. */
    onEnvironmentChanged(handler: (kind: PlanIngestionEnvironmentChange) => void): PlanIngestionWatchHandle;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export class PlanIngestionEngine {
    private _watchers = new Map<string, PlanIngestionWatchHandle>();
    private _gitWatchers = new Map<string, PlanIngestionWatchHandle>();
    private _envHandle?: PlanIngestionWatchHandle;

    // Per-file debounce timers to coalesce watcher events
    private _debounceTimers = new Map<string, NodeJS.Timeout>();

    private _scanInterval?: NodeJS.Timeout;
    private _scanIntervalMs = 10000; // 10 seconds default

    private _lastScanTime = new Map<string, number>();
    private _scanInProgress = false;
    private _recentRenames = new Set<string>();
    private _scanSeenPaths = new Map<string, Set<string>>();
    private _gitOpActiveUntil = new Map<string, number>();
    private _recentEvents: { fsPath: string; ts: number }[] = [];

    private _pendingFeatureLinks = new Map<string, { featureId: string; retries: number }>();
    private static readonly MAX_FEATURE_LINK_RETRIES = 5;

    // Paths currently being written by _createInitiatedPlan — skip watcher insert to avoid duplicates
    private static _pendingCreations = new Map<string, NodeJS.Timeout>();

    // Tombstone map to preserve the kanban column of deleted files during atomic write DELETE->INSERT race.
    private _recentlyDeletedColumns = new Map<string, { column: string; ts: number }>();

    private readonly _planDiscoveredListeners = new Set<(workspaceRoot: string, filePath?: string) => void>();

    public static registerPendingCreation(absolutePath: string): void {
        const key = path.resolve(absolutePath);
        const existing = PlanIngestionEngine._pendingCreations.get(key);
        if (existing) clearTimeout(existing);
        PlanIngestionEngine._pendingCreations.set(key, setTimeout(() => {
            PlanIngestionEngine._pendingCreations.delete(key);
        }, 10000));
    }

    public registerRename(oldRelativePath: string): void {
        const normalized = oldRelativePath.replace(/\\/g, '/');
        this._recentRenames.add(normalized);
        setTimeout(() => this._recentRenames.delete(normalized), 2000);
    }

    private _recomputeFeatureColumn?: (featurePlanId: string, workspaceRoot: string) => Promise<void>;

    public setFeatureColumnRecomputer(fn: (featurePlanId: string, workspaceRoot: string) => Promise<void>): void {
        this._recomputeFeatureColumn = fn;
    }

    private _regenerateFeatureFile?: (workspaceRoot: string, featureId: string) => Promise<void>;

    /**
     * Completion-broadcast seam. **DORMANT in this module**: the only producer
     * was the mtime-based clear (the plan-file watcher and the silence sweep),
     * retired when POST /kanban/queue/done became the explicit completion
     * signal. Both hosts still register a callback here (extension.ts,
     * bootstrap.ts) and both now receive the live event from
     * `LocalApiServer._runQueueDone`'s `onWorkingStateCleared` option instead.
     * The seam is kept so any future engine-side clear (one that is a real
     * completion, not the abandonment timeout) has somewhere to land — do NOT
     * read the registration as evidence that the engine still fires it.
     */
    private _onWorkingStateCleared?: (
        record: KanbanPlanRecord,
        workspaceRoot: string,
        meta?: { planCount?: number }
    ) => void;

    public setOnWorkingStateCleared(cb: (record: KanbanPlanRecord, workspaceRoot: string, meta?: { planCount?: number }) => void): void {
        this._onWorkingStateCleared = cb;
    }

    /**
     * Turn-end notification seam for explicit completion reports and stalled
     * feature or queue watches. The engine passes only what it knows — the seat
     * name, plan file, outcome, and workspace root — and stays host-agnostic:
     * recipient resolution and delivery belong to the host. A host that sets no
     * notifier degrades silently.
     */
    private _turnEndNotifier?: (info: TurnEndInfo) => void;

    public setTurnEndNotifier(fn: (info: TurnEndInfo) => void): void {
        this._turnEndNotifier = fn;
    }

    /**
     * Arm the queue-level stall watch. Called from every path that can leave
     * cards staged: `dispatchNextFromQueue` (the pop), `Stage for queue`, the
     * Analyze button's staging, and remote intake staging. Idempotent —
     * re-arming an existing watch for the same workspace is a no-op that does
     * NOT reset `nudgeCount` (a re-stage is not a dispatch). When
     * `headTerminal` is null the watch is armed for the "no coding head seated
     * yet" state; the sweep notifies the user once and keeps the watch until a
     * head is seated, upgrading the record on the next arm or sweep.
     *
     * A successful dispatch (the pop in `dispatchNextFromQueue`) passes
     * `{ onDispatch: true }` so the nudge state resets — the lead just did its
     * job, and a fresh stall window starts from this dispatch.
     */
    public async armQueueWatch(
        workspaceRoot: string,
        headTerminal: string | null,
        opts?: { onDispatch?: boolean }
    ): Promise<void> {
        const WATCH_KEY = 'kanban.queueWatches';
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            const existing = await db.getConfigJson<QueueWatchRecord[]>(WATCH_KEY, []);
            const now = Date.now();
            const idx = existing.findIndex(w => w && w.workspaceRoot === workspaceRoot);
            if (idx >= 0) {
                const w = existing[idx];
                // Re-arm: upgrade headTerminal if one is now seated, and reset
                // nudge state on a dispatch. A re-stage (no onDispatch) is a
                // no-op on the nudge state — the lead has not advanced.
                const rearmed: QueueWatchRecord = {
                    ...w,
                    headTerminal: headTerminal ?? w.headTerminal ?? null,
                    ...(opts?.onDispatch ? { lastNudgedAt: 0, nudgeCount: 0 } : {}),
                };
                if (opts?.onDispatch) {
                    // A dispatch clears the whole stall state, not just the
                    // nudge counter: the one-shot escalation re-arms, and the
                    // one-shot "no head seated" notice re-arms too (a dispatch
                    // proves a head exists, so a later absence is news again).
                    delete rearmed.escalatedAt;
                    delete rearmed.noHeadNotifiedAt;
                    delete rearmed.deadPacerAlertedFor;
                }
                existing[idx] = rearmed;
                await db.setConfigJson(WATCH_KEY, existing);
                return;
            }
            const record: QueueWatchRecord = {
                headTerminal: headTerminal ?? null,
                workspaceRoot,
                armedAt: now,
                lastNudgedAt: 0,
                nudgeCount: 0,
            };
            existing.push(record);
            await db.setConfigJson(WATCH_KEY, existing);
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] armQueueWatch failed for ${workspaceRoot}: ${err}`);
        }
    }

    /**
     * Injected liveness provider (host-agnostic seam). Returns the PTY fleet's
     * current `{ friendlyName, lastDataAt, status }` snapshot — empty on the
     * fleet-less host, so the sweep degrades to today's blind timeout. The engine
     * must NOT import the fleet directly (it would couple this host-agnostic
     * module to node-pty and break the standalone/extension seam split). Read
     * synchronously inside the sweep loop — the extension host supplies a cached
     * snapshot (`TaskViewerProvider.getFleetLiveness`) to avoid a cross-process
     * HTTP call per tick; the standalone host supplies the in-process fleet's
     * `getLiveness()` directly via a lazy closure.
     */
    private _terminalLivenessProvider?: () => Array<{ friendlyName: string; lastDataAt: number; status: string }>;

    public setTerminalLivenessProvider(fn: () => Array<{ friendlyName: string; lastDataAt: number; status: string }>): void {
        this._terminalLivenessProvider = fn;
    }

    /**
     * Queue-head resolver seam (subtask 3 fix): the queue nudge sweep calls
     * this to resolve the live coding head (lead first, then coder) for a
     * workspace when a watch's `headTerminal` is null — the "staged with no
     * head" state. The resolver is role-aware (it queries the terminal host
     * for terminals tagged 'lead' or 'coder', not inferred from liveness,
     * which carries only friendlyName/lastDataAt/status). Returns the terminal
     * name or null when no head is live. Wired in extension.ts to
     * `taskViewerProvider.getAliveRoleTerminalNames`. Absent in test harnesses
     * → the sweep's null-head gate degrades to the original "notify user"
     * behaviour (no resolution attempt, no false alarm — it just notifies).
     */
    private _queueHeadResolver?: (workspaceRoot: string) => Promise<string | null>;

    public setQueueHeadResolver(fn: (workspaceRoot: string) => Promise<string | null>): void {
        this._queueHeadResolver = fn;
    }

    /**
     * Queue pacing resolver seam (subtask 3): the queue nudge sweep calls this
     * to resolve the pacing mode (`'head'` or `'seat'`) for the team a head
     * terminal leads. Returns `'head'` when the resolver is absent or the team
     * has no `pacing` field — the install-base compatibility contract (absent
     * reads as head). Wired in extension.ts to
     * `kanbanProvider.resolveTeamPacing`. The sweep resolves pacing per-tick
     * (not stored on the watch) so a pacing flip between ticks is picked up on
     * the next tick.
     */
    private _queuePacingResolver?: (workspaceRoot: string, headTerminal: string | null) => Promise<'head' | 'seat'>;
    private _queueTeamMembersResolver?: (workspaceRoot: string, headTerminal: string) => Promise<string[] | null>;

    public setQueuePacingResolver(fn: (workspaceRoot: string, headTerminal: string | null) => Promise<'head' | 'seat'>): void {
        this._queuePacingResolver = fn;
    }

    public setQueueTeamMembersResolver(fn: (workspaceRoot: string, headTerminal: string) => Promise<string[] | null>): void {
        this._queueTeamMembersResolver = fn;
    }

    /**
     * Queue escalation recorder seam (subtask 3 step 7): when the watch
     * escalates on a held card (seat pacing, latch set, pacer dead or
     * ignoring nudges), the sweep calls this to record a failed attempt for
     * that card so a dead seat escalates up subtask 2's ladder (intern →
     * coder → lead) rather than pinning the queue behind a card nobody is
     * working. Subtask 2 owns the failure store and the re-stage logic; this
     * seam is the bridge. Optional — absent when subtask 2 has not landed,
     * in which case the escalation still fires (operator notified) but the
     * card is not re-staged until subtask 2's branch exists.
     *
     * Returns TRUE only when the release actually landed — the latch made a
     * real non-NULL→NULL transition and the ladder ran. FALSE on a no-op, a
     * duplicate, a throw, or an absent host wiring. The boolean is the whole
     * point: `Promise<void>` made "did nothing" and "worked" the same value,
     * which is why a silently failing release could repeat a "will be
     * re-staged" notice that was false by then. Hosts wire this to
     * `LocalApiServer.reportQueueDone` and must return `payload.released`
     * (the released card id) — NOT `payload.cleared`, which is the
     * `clearTerminalContext` result and is hardcoded false for team seats.
     */
    private _queueEscalationRecorder?: (workspaceRoot: string, planId: string, fromSeat: string) => Promise<boolean>;

    public setQueueEscalationRecorder(fn: (workspaceRoot: string, planId: string, fromSeat: string) => Promise<boolean>): void {
        this._queueEscalationRecorder = fn;
    }

    public setFeatureFileRegenerator(cb: (workspaceRoot: string, featureId: string) => Promise<void>): void {
        this._regenerateFeatureFile = cb;
    }

    /**
     * Register a listener fired when a plan is discovered/updated/deleted.
     * `filePath` is the affected plan file when known (file-level events); absent
     * for folder-level rediscovery (periodic sweep, activity-light timeout). The
     * VS Code adapter wraps this into a `{uri, workspaceRoot}` event.
     */
    public onPlanDiscovered(listener: (workspaceRoot: string, filePath?: string) => void): PlanIngestionWatchHandle {
        this._planDiscoveredListeners.add(listener);
        return { dispose: () => { this._planDiscoveredListeners.delete(listener); } };
    }

    private _firePlanDiscovered(workspaceRoot: string, filePath?: string): void {
        for (const listener of this._planDiscoveredListeners) {
            try { listener(workspaceRoot, filePath); } catch { /* listener errors are isolated */ }
        }
    }

    constructor(
        private readonly _getClickUpService: (workspaceRoot: string) => ClickUpSyncService,
        private readonly _getLinearService: (workspaceRoot: string) => LinearSyncService,
        private readonly _host: PlanIngestionHost,
        private readonly _getNotionService?: (workspaceRoot: string) => NotionFetchService,
    ) {}

    public async refreshWatchers(): Promise<void> {
        await this._refreshWatchers();
    }

    public async initialize(): Promise<void> {
        this._host.logger.appendLine('[GlobalPlanWatcher] Initializing...');
        await this._refreshWatchers();
        this._startPeriodicScan();
        // Always run one startup scan regardless of periodicScanEnabled — this seeds the
        // seen-paths cache and imports files that were created before this session started.
        this._runStartupScan();
        void this.runPurgeSweep();

        // Watch for configuration / workspace-folder changes — the host surfaces both
        // through the single onEnvironmentChanged seam.
        this._envHandle = this._host.onEnvironmentChanged((kind) => {
            if (kind === 'config') {
                this._host.logger.appendLine('[GlobalPlanWatcher] Plan watcher config changed, restarting periodic scan...');
                this._startPeriodicScan();
            }
            if (kind === 'roots') {
                this._host.logger.appendLine('[GlobalPlanWatcher] Workspace folders changed, refreshing watchers...');
                void this._refreshWatchers();
            }
        });
    }

    private _runStartupScan(): void {
        void (async () => {
            if (this._scanInProgress) { return; }
            this._scanInProgress = true;
            try {
                const folders = await this._host.listWatchedRoots();
                for (const folder of folders) {
                    await this._scanForNewFiles(folder);
                }
                this._host.logger.appendLine('[GlobalPlanWatcher] Startup scan complete');
            } finally {
                this._scanInProgress = false;
            }
        })();
    }

    private _startPeriodicScan(): void {
        if (this._scanInterval) {
            clearInterval(this._scanInterval);
            this._scanInterval = undefined;
        }

        const planWatcherCfg = this._host.getConfig('planWatcher');
        const enabled = planWatcherCfg.getBoolean('periodicScanEnabled', true);
        this._scanIntervalMs = planWatcherCfg.getNumber('scanIntervalMs', 10000);

        if (!enabled) {
            this._host.logger.appendLine('[GlobalPlanWatcher] Periodic scan disabled');
            return;
        }

        this._scanInterval = setInterval(async () => {
            if (this._scanInProgress) { return; }
            this._scanInProgress = true;
            try {
                const folders = await this._host.listWatchedRoots();
                for (const folder of folders) {
                    await this._scanForNewFiles(folder);
                }
                const activityCfg = this._host.getConfig('activityLight');
                const timeoutMs = activityCfg.getNumber('timeoutMs', 10 * 60 * 1000);
                // Liveness window: how recently a dispatched terminal must have
                // produced output for the sweep to refresh its activity heartbeat.
                // Default 90s; older heartbeats fall through to the working-state
                // timeout.
                const livenessWindowMs = activityCfg.getNumber('livenessWindowMs', 90000);
                // Turn-end silence prevents a stall nudge from being injected into
                // an active PTY turn. Completion remains an explicit API signal.
                const turnEndSilenceMs = activityCfg.getNumber('turnEndSilenceMs', 90000);
                // Nudge silence paces feature- and queue-level stall reminders.
                // Default 10 min; the nudge is a backstop, not a completion signal.
                const nudgeSilenceMs = activityCfg.getNumber('nudgeSilenceMs', 600000);
                // Partition the fleet ONCE per tick (not per folder) — the fleet
                // is process-global and the snapshot is cheap. A miss on the
                // provider (fleet-less host) yields empty arrays and the sweep
                // degenerates to the blind timeout (today's behaviour).
                // The provider is host-supplied and reads a binding this module does
                // not own. The enclosing try has only a `finally`, so an exception
                // here escapes the async interval callback as an unhandled
                // rejection — fatal to the standalone process under Node's default
                // rejection mode. A failed liveness read must degrade to the blind
                // timeout, never take the plan watcher down with it.
                let liveness: Array<{ friendlyName: string; lastDataAt: number; status: string }> = [];
                if (this._terminalLivenessProvider) {
                    try {
                        liveness = this._terminalLivenessProvider() ?? [];
                    } catch (livenessProviderErr) {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] terminal liveness provider threw; falling back to the blind timeout: ${livenessProviderErr}`
                        );
                    }
                }
                const nowMs = Date.now();
                const liveNames: string[] = [];
                const forceTerminals: string[] = [];
                for (const entry of liveness) {
                    if (!entry.friendlyName) continue;
                    if (entry.status === 'exited') {
                        // Exited terminal = positive evidence of NOT working — the
                        // one case where liveness shortens the window. Force-clear
                        // on the next tick regardless of age.
                        forceTerminals.push(entry.friendlyName);
                    } else if (nowMs - entry.lastDataAt < livenessWindowMs) {
                        // Active AND recently produced output → stamp its heartbeat
                        // so the widened age basis keeps its card lit past timeout.
                        liveNames.push(entry.friendlyName);
                    }
                }
                let recordedLiveness = 0;
                const livenessIso = new Date(nowMs).toISOString();
                for (const folder of folders) {
                    try {
                        const db = KanbanDatabase.forWorkspace(folder);
                        await db.ensureReady();
                        const wsId = await db.getWorkspaceId();
                        if (!wsId) continue;
                        const notifiedSeatsThisTick = new Set<string>();
                        // Persist heartbeats for live active terminals BEFORE the
                        // sweep so the widened basis is in the row the sweep reads.
                        // ~1 write per live card per 10s — well within the sql.js
                        // WASM-heap budget (NOT per output flush).
                        if (liveNames.length > 0) {
                            try {
                                recordedLiveness += await db.recordLiveness(wsId, liveNames, livenessIso);
                            } catch (livenessErr) {
                                this._host.logger.appendLine(
                                    `[GlobalPlanWatcher] recordLiveness failed for ${folder}: ${livenessErr}`
                                );
                            }
                        }
                        const cleared = await db.clearStaleWorkingState(wsId, timeoutMs, { forceTerminals });
                        if (cleared > 0) {
                            this._host.logger.appendLine(
                                `[GlobalPlanWatcher] Activity-light timeout sweep cleared ${cleared} stale working card(s) in ${folder}` +
                                (recordedLiveness > 0 || forceTerminals.length > 0
                                    ? ` (liveness: recorded=${recordedLiveness}, forced=${forceTerminals.length})`
                                    : '')
                            );
                            this._firePlanDiscovered(folder);
                        }
                        // ── Feature-level stall nudge ───────────────────────────────
                        // A head driving a feature can stall in the window where no
                        // dispatch is outstanding (it dropped the thread, its turn
                        // ended without sending the next subtask, a registration
                        // failed). Per-dispatch turn-end says nothing about that —
                        // there is no dispatch to observe. An armed watch keeps
                        // nudging the head until the feature is done. Ships OFF by
                        // default; armed by the head agent via `watchFeature`.
                        try {
                            await this._runFeatureNudgeSweep({
                                db, folder, liveness, nowMs, turnEndSilenceMs, nudgeSilenceMs, notifiedSeatsThisTick,
                            });
                        } catch (nudgeErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] feature nudge sweep failed for ${folder}: ${nudgeErr}`);
                        }
                        // ── Queue-level stall nudge ────────────────────────────────
                        // The backstop for a lead-paced pipeline with the schedule
                        // off. Shares the same liveness snapshot, `nowMs`,
                        // `turnEndSilenceMs`, `nudgeSilenceMs` and
                        // `notifiedSeatsThisTick` set as the feature sweep so a
                        // head that is both a feature head and a queue head is
                        // nudged at most once per tick.
                        try {
                            await this._runQueueNudgeSweep({
                                db, folder, liveness, nowMs, turnEndSilenceMs, nudgeSilenceMs, notifiedSeatsThisTick,
                            });
                        } catch (queueNudgeErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] queue nudge sweep failed for ${folder}: ${queueNudgeErr}`);
                        }
                        await this._retryPendingFeatureLinks(db, folder);
                    } catch (sweepErr) {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Activity-light timeout sweep failed for ${folder}: ${sweepErr}`
                        );
                    }
                }
                try {
                    await this.runPurgeSweep();
                } catch (purgeErr) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Purge sweep failed: ${purgeErr}`);
                }
            } finally {
                this._scanInProgress = false;
            }
        }, this._scanIntervalMs);
        this._host.logger.appendLine(`[GlobalPlanWatcher] Periodic scan started (${this._scanIntervalMs}ms)`);
    }

    private async _scanForNewFiles(workspaceRoot: string): Promise<void> {
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        const featuresDir = path.join(workspaceRoot, '.switchboard', 'features');
        if (!fs.existsSync(plansDir) && !fs.existsSync(featuresDir)) { return; }

        try {
            const currentPaths = new Set<string>();

            const collectPaths = async (dir: string): Promise<void> => {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await collectPaths(entryPath);
                    } else if (entry.isFile() && entry.name.endsWith('.md')) {
                        currentPaths.add(entryPath.replace(/\\/g, '/'));
                    }
                }
            };

            if (fs.existsSync(plansDir)) {
                await collectPaths(plansDir);
            }
            if (fs.existsSync(featuresDir)) {
                await collectPaths(featuresDir);
            }

            const prevPaths = this._scanSeenPaths.get(workspaceRoot);
            this._scanSeenPaths.set(workspaceRoot, currentPaths);

            let filesToProcess: string[];
            if (prevPaths === undefined) {
                filesToProcess = [...currentPaths];
            } else {
                filesToProcess = [...currentPaths].filter(p => !prevPaths.has(p));
                if (filesToProcess.length === 0) {
                    return;
                }
            }

            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            const workspaceId = await db.getWorkspaceId();
            if (!workspaceId) { return; }

            const existingPlans = await db.getAllPlans(workspaceId);
            const existingPaths = new Set(
                existingPlans.map(p => {
                    const rel = path.isAbsolute(p.planFile) ? path.relative(workspaceRoot, p.planFile) : p.planFile;
                    return rel.replace(/\\/g, '/');
                })
            );
            const existingAbsolutePaths = new Set(
                existingPlans.map(p => p.planFile.replace(/\\/g, '/'))
                    .filter(p => path.isAbsolute(p))
            );
            const now = Date.now();
            const lastScan = this._lastScanTime.get(workspaceRoot) || 0;
            this._lastScanTime.set(workspaceRoot, now);

            for (const entryPath of filesToProcess) {
                const normalizedPath = entryPath.replace(/\\/g, '/');
                const relativePath = path.relative(workspaceRoot, entryPath).replace(/\\/g, '/');
                if (existingPaths.has(relativePath) || existingAbsolutePaths.has(normalizedPath)) { continue; }

                const stats = await fs.promises.stat(entryPath);
                if (stats.mtimeMs < lastScan) { continue; }
                if (now - stats.mtimeMs < 500) { continue; }

                this._host.logger.appendLine(`[GlobalPlanWatcher] Periodic scan found new file: ${relativePath}`);
                this._debounceHandleFile(entryPath, workspaceRoot);
            }
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Periodic scan error in ${workspaceRoot}: ${err}`);
        }
    }

    private async _refreshWatchers(): Promise<void> {
        const foldersToWatch = await this._host.listWatchedRoots();

        for (const [folder, watcher] of this._watchers) {
            if (!foldersToWatch.includes(folder)) {
                try { watcher.dispose(); } catch {}
                this._watchers.delete(folder);

                const gitWatcher = this._gitWatchers.get(folder);
                if (gitWatcher) {
                    try { gitWatcher.dispose(); } catch {}
                    this._gitWatchers.delete(folder);
                }
                this._gitOpActiveUntil.delete(folder);
                this._scanSeenPaths.delete(folder);

                this._host.logger.appendLine(`[GlobalPlanWatcher] Stopped watching: ${folder}`);
            }
        }

        for (const folder of foldersToWatch) {
            if (!this._watchers.has(folder)) {
                this._setupWatcherForFolder(folder);
            }
        }
    }

    private _setupWatcherForFolder(folder: string): void {
        const handle = this._host.watcher.watchFolder(folder, (event, filePath) => {
            if (event === 'delete') {
                this._host.logger.appendLine(`[GlobalPlanWatcher] Deleted: ${filePath}`);
                this._debounceHandleDelete(filePath, folder);
            } else {
                this._host.logger.appendLine(`[GlobalPlanWatcher] ${event === 'create' ? 'Created' : 'Changed'}: ${filePath}`);
                this._debounceHandleFile(filePath, folder);
            }
        });
        this._watchers.set(folder, handle);
        this._host.logger.appendLine(`[GlobalPlanWatcher] Watcher active for: ${folder}`);

        const gitDir = this._resolveDotGitDir(folder);
        if (gitDir && !this._gitWatchers.has(folder)) {
            const headPath = path.join(gitDir, 'HEAD');
            if (fs.existsSync(headPath)) {
                let lastBranchName = '';
                const checkBranch = () => {
                    try {
                        const content = fs.readFileSync(headPath, 'utf8').trim();
                        if (content !== lastBranchName) {
                            lastBranchName = content;
                            this._host.logger.appendLine(`[GlobalPlanWatcher] Git branch/HEAD changed for ${folder}: ${content}`);
                            this._gitOpActiveUntil.set(folder, Date.now() + 15000);
                        }
                    } catch (err) {
                        this._host.logger.appendLine(`[GlobalPlanWatcher] Failed to check branch in Git watcher for ${folder}: ${err}`);
                    }
                };
                const gitHandle = this._host.watcher.watchFile(headPath, () => checkBranch());
                this._gitWatchers.set(folder, gitHandle);
                checkBranch();
            } else {
                this._host.logger.appendLine(`[GlobalPlanWatcher] No .git/HEAD to watch for ${folder}`);
            }
        }
    }

    public isGitOpActive(workspaceRoot: string): boolean {
        const gitOpTime = this._gitOpActiveUntil.get(workspaceRoot) || 0;
        return Date.now() < gitOpTime;
    }

    private _resolveDotGitDir(workspaceRoot: string): string | null {
        try {
            const dotGitPath = path.join(workspaceRoot, '.git');
            if (!fs.existsSync(dotGitPath)) {
                return null;
            }
            const stat = fs.statSync(dotGitPath);
            if (stat.isDirectory()) {
                return dotGitPath;
            } else if (stat.isFile()) {
                const content = fs.readFileSync(dotGitPath, 'utf8');
                const match = content.match(/^gitdir:\s*(.+)$/m);
                if (match) {
                    const gitDirPointer = match[1].trim();
                    return path.isAbsolute(gitDirPointer)
                        ? gitDirPointer
                        : path.resolve(workspaceRoot, gitDirPointer);
                }
            }
        } catch (e) {
            console.error(`[GlobalPlanWatcher] Failed to resolve .git for ${workspaceRoot}:`, e);
        }
        return null;
    }

    public async runPurgeSweep(): Promise<void> {
        try {
            const folders = await this._host.listWatchedRoots();
            for (const folder of folders) {
                if (this.isGitOpActive(folder)) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Skipping purge sweep for ${folder} because git operation is active.`);
                    continue;
                }
                const db = KanbanDatabase.forWorkspace(folder);
                await db.ensureReady();
                const workspaceId = await db.getWorkspaceId();
                if (!workspaceId) continue;

                const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const missingPlans = await db.getMissingPlansOlderThan(cutoffIso, workspaceId);
                for (const plan of missingPlans) {
                    if (plan.clickupTaskId) {
                        try {
                            const clickup = this._getClickUpService(folder);
                            const clickupConfig = await clickup.loadConfig();
                            if (clickupConfig?.deleteSyncEnabled === true) {
                                await clickup.archiveTask(plan.clickupTaskId);
                            }
                        } catch (clickUpErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] ClickUp archive failed for task ${plan.clickupTaskId} during purge: ${clickUpErr}`);
                        }
                    }
                    if (plan.linearIssueId) {
                        try {
                            const linear = this._getLinearService(folder);
                            const linearConfig = await linear.loadConfig();
                            if (linearConfig?.deleteSyncEnabled === true) {
                                await linear.archiveIssue(plan.linearIssueId);
                            }
                        } catch (linearErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] Linear archive failed for issue ${plan.linearIssueId} during purge: ${linearErr}`);
                        }
                    }
                    if (plan.notionPageId && this._getNotionService) {
                        try {
                            const notion = this._getNotionService(folder);
                            const setup = await loadNotionRemoteSetup(db);
                            if (setup?.plansDatabaseId && setup.deleteSyncEnabled === true) {
                                const provider = new NotionRemoteProvider({
                                    notion,
                                    db,
                                    getWorkspaceId: async () => workspaceId,
                                    log: (m: string) => this._host.logger.appendLine(m),
                                });
                                const result = await provider.archiveCard(plan.notionPageId);
                                if (!result.ok && !result.skipped) {
                                    this._host.logger.appendLine(`[GlobalPlanWatcher] Notion archive failed for page ${plan.notionPageId} during purge: ${result.error}`);
                                }
                            }
                        } catch (notionErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] Notion archive failed for page ${plan.notionPageId} during purge: ${notionErr}`);
                        }
                    }
                    await db.deletePlanByPlanFile(plan.planFile, plan.workspaceId);
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Purged missing plan: ${plan.planFile}`);

                    if (plan.featureId && this._regenerateFeatureFile) {
                        try {
                            await this._regenerateFeatureFile(folder, plan.featureId);
                        } catch (regenErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] regenerateFeatureFile failed for ${plan.featureId} during purge: ${regenErr}`);
                        }
                    }
                }
            }
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Error in purge sweep: ${err}`);
        }
    }

    private _registerEventForBulkCheck(fsPath: string, workspaceRoot: string): void {
        const now = Date.now();
        this._recentEvents.push({ fsPath, ts: now });
        this._recentEvents = this._recentEvents.filter(e => now - e.ts <= 2000);
        if (this._recentEvents.length >= 5) {
            const count = this._recentEvents.length;
            this._recentEvents = [];
            void (async () => {
                try {
                    const db = KanbanDatabase.forWorkspace(workspaceRoot);
                    await db.ensureReady();
                    await db.writeDbBackup('bulk-change');
                    this._host.logger.appendLine(`[GlobalPlanWatcher] bulk change (${count}); snapshot written`);
                } catch (e) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Failed to write bulk-change backup: ${e}`);
                }
            })();
        }
    }

    private _debounceHandleFile(fsPath: string, workspaceRoot: string): void {
        this._registerEventForBulkCheck(fsPath, workspaceRoot);
        const key = fsPath;
        const existing = this._debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this._debounceTimers.delete(key);
            void this._handlePlanFile(fsPath, workspaceRoot);
        }, 300);
        this._debounceTimers.set(key, timer);
    }

    private _debounceHandleDelete(fsPath: string, workspaceRoot: string): void {
        this._registerEventForBulkCheck(fsPath, workspaceRoot);
        const key = `delete:${fsPath}`;
        const existing = this._debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this._debounceTimers.delete(key);
            void this._handlePlanDelete(fsPath, workspaceRoot);
        }, 300);
        this._debounceTimers.set(key, timer);
    }

    private async _applyFeatureLink(
        db: KanbanDatabase,
        subtaskPlanId: string,
        featureId: string,
        relativePath: string,
        workspaceId: string,
        workspaceRoot: string
    ): Promise<void> {
        if (!featureId || subtaskPlanId === featureId) return;
        if (relativePath.startsWith('.switchboard/features/')) return;

        try {
            const featureRow = await db.resolveFeatureIdentifier(featureId, workspaceId);
            if (!featureRow || !featureRow.isFeature) {
                const existing = this._pendingFeatureLinks.get(subtaskPlanId);
                const retries = existing ? existing.retries + 1 : 0;
                if (retries >= PlanIngestionEngine.MAX_FEATURE_LINK_RETRIES) {
                    this._host.logger.appendLine(
                        `[GlobalPlanWatcher] **Feature:** ${featureId} on ${relativePath} unresolved after ${retries} retries — dropping defer`
                    );
                    this._pendingFeatureLinks.delete(subtaskPlanId);
                    return;
                }
                this._pendingFeatureLinks.set(subtaskPlanId, { featureId, retries });
                return;
            }
            const subtaskRow = await db.getPlanByPlanId(subtaskPlanId);
            if (!subtaskRow) return;
            if (subtaskRow.featureId && subtaskRow.featureId !== '') {
                return;
            }
            await db.updateFeatureStatus(subtaskPlanId, 0, featureRow.planId);
            this._pendingFeatureLinks.delete(subtaskPlanId);
            this._host.logger.appendLine(
                `[GlobalPlanWatcher] Linked subtask ${relativePath} to feature ${featureRow.planId} via **Feature:** frontmatter`
            );
            try {
                await this._regenerateFeatureFile?.(workspaceRoot, featureRow.planId);
            } catch (regenErr) {
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] regenerateFeatureFile failed for ${featureRow.planId}: ${regenErr instanceof Error ? regenErr.message : String(regenErr)}`
                );
            }
        } catch (e) {
            this._host.logger.appendLine(
                `[GlobalPlanWatcher] _applyFeatureLink failed for ${relativePath}: ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }

    /**
     * Feature-level stall nudge — one sweep tick's worth. For every armed watch
     * (config key `kanban.featureWatches`), wake the head ONLY when all five hold:
     *   1. the feature still has at least one un-accepted subtask;
     *   2. the head terminal is live and `active`;
     *   3. the head's own `lastDataAt` is older than `turnEndSilenceMs` (not mid-turn);
     *   4. no dispatch record for any of the feature's seats is outstanding, and
     *      no turn-end notice for one of them fired on this tick;
     *   5. no member of the head's team has produced output within `nudgeSilenceMs`
     *      — a head waiting on a live coder is idle on purpose, not stalled.
     * The wake carries evidence (remaining subtasks, their seats, silence, mtime),
     * not a poke. Delivery reuses the turn-end notifier with `outcome: 'stalled'`,
     * `recipientSeat` = the head (skip parent resolution) and `body` = the composed
     * evidence. Cancellation is automatic when no un-accepted subtasks remain, or
     * the head terminal is absent/`exited`. Paced by `lastNudgedAt` with a floor of
     * `nudgeSilenceMs` (default 10 min) so a stalled feature produces a periodic
     * reminder, not a stream. One nudge per stall — `nudgeCount` stops repeat
     * nudges; a dispatch re-arms it via gate (4a). A watch is never retried
     * against a dead head.
     */
    private async _runFeatureNudgeSweep(args: {
        db: KanbanDatabase;
        folder: string;
        liveness: Array<{ friendlyName: string; lastDataAt: number; status: string }>;
        nowMs: number;
        turnEndSilenceMs: number;
        nudgeSilenceMs: number;
        notifiedSeatsThisTick: Set<string>;
    }): Promise<void> {
        if (!this._turnEndNotifier) return; // no notifier → no delivery → nothing to do.
        const { db, folder, liveness, nowMs, turnEndSilenceMs, nudgeSilenceMs, notifiedSeatsThisTick } = args;
        const WATCH_KEY = 'kanban.featureWatches';
        let watches: FeatureWatchRecord[] = [];
        try {
            watches = await db.getConfigJson<FeatureWatchRecord[]>(WATCH_KEY, []);
        } catch { return; } // unreadable config is no evidence — try next tick.
        if (watches.length === 0) return;
        // An EMPTY liveness snapshot is NO EVIDENCE, not evidence that every head
        // died. `getFleetLiveness()` returns [] whenever the fleet is unavailable —
        // before the first forward after an extension reload, while the ptyHost is
        // booting, on a fleet-less host. Without this guard the very next tick reads
        // every armed head as "absent" and permanently drops every watch, silently,
        // for a head that is still running. Same contract as the silence branch's
        // `lastDataAt > 0` guard: no data is not a signal.
        if (liveness.length === 0) return;

        // Liveness by friendly name for the head-silence and head-active tests.
        const livenessByName = new Map<string, { lastDataAt: number; status: string }>();
        for (const entry of liveness) {
            if (entry.friendlyName) livenessByName.set(entry.friendlyName, { lastDataAt: entry.lastDataAt, status: entry.status });
        }

        const originals = new Map(watches.map(watch => [watch.featureId, {
            ...watch,
        }]));
        let mutated = false;
        const kept: FeatureWatchRecord[] = [];
        for (const watch of watches) {
            // (2) Head terminal live and active. Absent or exited → drop the watch
            // and log which one ended it. A watch is never retried against a dead
            // head — the same honesty notifyTurnEnd shows when the recipient exited.
            const headLive = livenessByName.get(watch.headTerminal);
            if (!headLive || headLive.status === 'exited') {
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] Feature nudge: dropping watch for feature ${watch.featureId} — head '${watch.headTerminal}' is ${!headLive ? 'absent' : 'exited'}.`
                );
                mutated = true;
                continue;
            }

            // (1) Feature still has >=1 subtask with no completion post.
            //
            // Keyed on `completed_at` — the lead's asserted POST /kanban/task/complete —
            // and NEVER on kanbanColumn. A card enters a column when it reaches the team
            // and does not leave while the team works it, so `kanbanColumn` is CONSTANT
            // for the whole run: as a termination condition it is either true on the
            // first tick or never true, and it carries no progress information at all.
            // The previous `stopColumns` check (default ['CODE REVIEWED']) emptied
            // `remaining` on tick one for any feature whose subtasks were already in
            // that column, so this watch — the only backstop for a lead that never
            // posts — deleted itself before observing anything. Do not reintroduce a
            // column read here.
            //
            // getSubtasksByFeatureId filters status = 'active'; reaching COMPLETED sets
            // status = 'completed', so those rows are already absent. `completed_at` is
            // on every row the query returns.
            let subtasks: KanbanPlanRecord[] = [];
            try {
                subtasks = await db.getSubtasksByFeatureId(watch.featureId);
            } catch {
                // Unreadable subtasks is no evidence either way — keep the watch,
                // try again next tick. Do not nudge on a failed read.
                kept.push(watch);
                continue;
            }
            const remaining = subtasks.filter(s => s.kanbanColumn !== 'COMPLETED' && !s.completedAt);
            if (remaining.length === 0) {
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] Feature nudge: dropping watch for feature ${watch.featureId} — every subtask has a completion post.`
                );
                mutated = true;
                continue;
            }

            // (4a) No dispatch record for any of the feature's seats is outstanding.
            // A subtask with a non-null dispatchedAt is being worked by a coder —
            // the per-dispatch backstop covers it, so the nudge stays silent. This
            // is the "no dispatch to observe" window the nudge exists for.
            const outstanding = remaining.some(s => !!s.dispatchedAt);
            if (outstanding) {
                // A dispatch is in progress — the head is working, not stalled.
                // Re-arm the nudge state so the next idle window after this dispatch
                // completes gets a fresh nudge (mirrors the queue watch's in-flight
                // reset). Without this, nudgeCount latches at 1 after the first
                // nudge and the head is never nudged again for this feature — even
                // across new stall cycles.
                if ((watch.nudgeCount ?? 0) > 0 || watch.lastNudgedAt > 0) {
                    watch.nudgeCount = 0;
                    watch.lastNudgedAt = 0;
                    mutated = true;
                }
                kept.push(watch);
                continue;
            }

            // (4b) No completion notice for one of the feature's seats fired this tick.
            // A seat that just reported completion already woke the head, so a nudge
            // on top of it would be a double-wake about the same stall.
            const seatNotifiedThisTick = remaining.some(s => !!s.dispatchedTerminal && notifiedSeatsThisTick.has(s.dispatchedTerminal));
            if (seatNotifiedThisTick) {
                kept.push(watch);
                continue;
            }

            // (3) Head's own lastDataAt older than turnEndSilenceMs — it is not
            // mid-turn. Delivering a prompt to a terminal whose agent is actively
            // working injects text into a running turn; the safeguard must not be
            // the thing that breaks the driving agent.
            if (headLive.lastDataAt <= 0 || nowMs - headLive.lastDataAt < turnEndSilenceMs) {
                kept.push(watch);
                continue;
            }

            // Team-liveness: if any team member is actively producing output, the
            // head is waiting for a coder, not stalled. Suppress the nudge. The
            // feature head is a team head, so the roster is resolved the same way
            // the queue nudge's seat-pacing branch resolves it. When the resolver
            // is absent (headless/test harness), skip this gate — no evidence is
            // not evidence of a live coder, so fall through to the normal gates.
            // Placed AFTER the head-silence gate deliberately: this is the only gate in
            // the sweep that costs a DB read (the resolver hits kanban.db), and the head
            // is mid-turn on nearly every 10s tick — evaluating it earlier bought one
            // sql.js read per watch per tick for a decision the free gate above already
            // made. Both gates only `continue`, so the order is observationally identical.
            if (this._queueTeamMembersResolver) {
                try {
                    const resolved = await this._queueTeamMembersResolver(folder, watch.headTerminal);
                    const teamSet = new Set(resolved || []);
                    teamSet.add(watch.headTerminal); // include the head itself
                    const teamActive = Array.from(teamSet).some(name => {
                        const entry = livenessByName.get(name);
                        return entry && entry.lastDataAt > 0 && nowMs - entry.lastDataAt < nudgeSilenceMs;
                    });
                    if (teamActive) {
                        kept.push(watch);
                        continue;
                    }
                } catch { /* resolver failure is no evidence — fall through to normal gates */ }
            }

            // Pacing: at most one nudge per watch per `nudgeSilenceMs` window.
            // A floor well above the sweep tick (10s) so a stalled feature produces
            // a periodic reminder rather than a stream. `nudgeSilenceMs` (default
            // 10 min) is deliberately separate from `turnEndSilenceMs` (90s) — the
            // nudge is a backstop, not a turn-boundary probe.
            if (watch.lastNudgedAt > 0 && nowMs - watch.lastNudgedAt < nudgeSilenceMs) {
                kept.push(watch);
                continue;
            }

            // One nudge, then stop. A head that didn't respond to the first nudge
            // won't respond to a second — repeating every window is the noise this
            // fix exists to eliminate. A dispatch re-arms nudgeCount via gate (4a).
            if ((watch.nudgeCount ?? 0) >= 1) {
                kept.push(watch);
                continue;
            }

            // Compose the evidence body. The engine holds the subtask rows, the
            // liveness snapshot and the mtimes; the host must not re-derive it. A
            // head woken with the state acts immediately; a head woken with "check
            // on your coders" has to re-derive everything.
            const lines: string[] = [`[switchboard:turn-end] Feature stall — you armed a watch on feature ${watch.featureId} and have gone idle with ${remaining.length} un-accepted subtask(s) remaining:`];
            for (const s of remaining) {
                const seat = s.dispatchedTerminal ? `seat '${s.dispatchedTerminal}'` : 'no seat attributed';
                const seatLastDataAt = s.dispatchedTerminal ? (livenessByName.get(s.dispatchedTerminal)?.lastDataAt ?? 0) : 0;
                const silentFor = seatLastDataAt > 0 ? `, silent ${Math.round((nowMs - seatLastDataAt) / 1000)}s` : '';
                // Plan-file mtime is the OTHER half of the evidence: a seat that has
                // been quiet for minutes but whose plan file was written seconds ago
                // finished and never reported. Absolute age, not a compare against
                // `dispatchedAt` — these subtasks have no outstanding dispatch (that
                // is gate 4a), so there is no dispatch stamp to compare against.
                let writtenAgo = '';
                try {
                    const stat = await fs.promises.stat(path.join(folder, s.planFile));
                    writtenAgo = `, plan file written ${Math.round((nowMs - stat.mtimeMs) / 1000)}s ago`;
                } catch { /* unreadable at this root is no evidence — omit the clause */ }
                lines.push(`  - ${s.planFile} (column ${s.kanbanColumn}, ${seat}${silentFor}${writtenAgo})`);
            }
            lines.push('Register the next subtask (attributePastedPrompt) and dispatch it, or accept the remaining subtasks to end this watch.');
            const body = lines.join('\n');

            // Deliver via the turn-end notifier with `recipientSeat` = the head
            // (skip parent resolution — the head IS the recipient; resolving its
            // parent would address Mission Control instead) and the composed body.
            try {
                this._turnEndNotifier({
                    seatName: watch.headTerminal,
                    planFile: '',
                    outcome: 'stalled',
                    workspaceRoot: folder,
                    recipientSeat: watch.headTerminal,
                    body,
                });
            } catch (cbErr) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] feature nudge notifier failed for ${watch.featureId}: ${cbErr}`);
            }
            this._host.logger.appendLine(
                `[GlobalPlanWatcher] Feature nudge fired for feature ${watch.featureId} → head '${watch.headTerminal}' (${remaining.length} subtask(s) remaining).`
            );

            // Add the head to the shared notifiedSeatsThisTick set so the
            // queue nudge sweep does not double-wake the same head on this
            // tick. A head that is both a feature head and a queue head would
            // receive two prompts without this — the plan's double-wake
            // foot-gun. Both sweeps must both read AND write this set.
            notifiedSeatsThisTick.add(watch.headTerminal);

            // Stamp lastNudgedAt and nudgeCount, and keep the watch.
            watch.lastNudgedAt = nowMs;
            watch.nudgeCount = 1;
            mutated = true;
            kept.push(watch);
        }

        if (mutated) {
            try {
                const keptById = new Map(kept.map(watch => [watch.featureId, watch]));
                await db.updateConfigJson<FeatureWatchRecord[]>(WATCH_KEY, [], current => current.flatMap(watch => {
                    const original = originals.get(watch.featureId);
                    if (!original || original.armedAt !== watch.armedAt || original.headTerminal !== watch.headTerminal) {
                        return [watch];
                    }
                    const replacement = keptById.get(watch.featureId);
                    return replacement ? [replacement] : [];
                }));
            } catch (writeErr) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] feature nudge: failed to persist watch state: ${writeErr}`);
            }
        }
    }

    /**
     * Queue-level stall nudge — the backstop for a lead-paced pipeline with
     * the schedule off. Mirrors `_runFeatureNudgeSweep`'s shape and reuses its
     * hard-won guards verbatim: the empty-liveness guard (no evidence is not
     * "everyone died"), the mid-turn `lastDataAt` gate, the shared
     * `notifiedSeatsThisTick` set (both sweeps read AND write it), and the
     * `nudgeSilenceMs` pacing floor. Called from the same tick as the feature
     * sweep so the two share one liveness snapshot and one `nowMs`.
     *
     * Gates, in order:
     *  1. empty liveness snapshot → return, change nothing;
     *  2. queue empty → drop the watch silently (the session ended normally);
     *  3. no coding head seated at all → keep the watch, notify the user once;
     *  4. head present in the record but absent or `exited` → drop the watch,
     *     notify the user;
     *  5. any card in flight for this team → keep, stay silent, reset nudge
     *     state (the lead just dispatched);
     *  5b. any team member actively producing output → keep, stay silent
     *      (the lead is waiting for a coder, not stalled);
     *  6. a seat notified this tick → keep, stay silent (avoid a double wake);
     *  7. head `lastDataAt` within `turnEndSilenceMs` → keep, stay silent;
     *  8. otherwise nudge once, add the head to `notifiedSeatsThisTick`, and
     *     stop — no user escalation for the stall path. A dispatch re-arms.
     */
    private async _runQueueNudgeSweep(args: {
        db: KanbanDatabase;
        folder: string;
        liveness: Array<{ friendlyName: string; lastDataAt: number; status: string }>;
        nowMs: number;
        turnEndSilenceMs: number;
        nudgeSilenceMs: number;
        notifiedSeatsThisTick: Set<string>;
    }): Promise<void> {
        if (!this._turnEndNotifier) return; // no notifier → no delivery → nothing to do.
        const { db, folder, liveness, nowMs, turnEndSilenceMs, nudgeSilenceMs, notifiedSeatsThisTick } = args;
        const WATCH_KEY = 'kanban.queueWatches';
        let allWatches: QueueWatchRecord[] = [];
        try {
            allWatches = await db.getConfigJson<QueueWatchRecord[]>(WATCH_KEY, []);
        } catch { return; } // unreadable config is no evidence — try next tick.
        if (allWatches.length === 0) return;
        // Only process watches for THIS workspace — the tick iterates over all
        // watched roots and calls the sweep per root with that root's DB. A
        // watch for workspace A processed during workspace B's sweep would read
        // B's board and produce wrong evidence. Watches for other workspaces
        // are preserved untouched in the write-back (see `otherWatches` below).
        const otherWatches = allWatches.filter(w => w && w.workspaceRoot !== folder);
        let watches = allWatches.filter(w => w && w.workspaceRoot === folder);
        if (watches.length === 0) return;
        // An EMPTY liveness snapshot is NO EVIDENCE, not evidence that every head
        // died. `getFleetLiveness()` returns [] whenever the fleet is unavailable —
        // before the first forward after an extension reload, while the ptyHost is
        // booting, on a fleet-less host. Without this guard the very next tick reads
        // every armed head as "absent" and permanently drops every watch, silently,
        // for a head that is still running. Same contract as the feature sweep's
        // `:924-931` guard: no data is not a signal. Reused verbatim, not
        // reimplemented — a naive copy that treats empty as "every head died"
        // destroys every watch and notifies the user that every lead is gone.
        if (liveness.length === 0) return;

        const livenessByName = new Map<string, { lastDataAt: number; status: string }>();
        for (const entry of liveness) {
            if (entry.friendlyName) livenessByName.set(entry.friendlyName, { lastDataAt: entry.lastDataAt, status: entry.status });
        }

        let mutated = false;
        const kept: QueueWatchRecord[] = [];
        for (const watch of watches) {
            // (2) Queue empty → drop the watch silently. The session ended
            // normally; a watch with no work to watch is not a stall.
            let board: KanbanPlanRecord[] = [];
            try {
                const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || '';
                board = await db.getBoard(wsId) || [];
            } catch {
                // Unreadable board is no evidence — keep the watch, try next tick.
                kept.push(watch);
                continue;
            }
            // The queue is STAGING and only STAGING — the same predicate
            // `dispatchNextFromQueue` pops with. Counting PLAN REVIEWED here
            // would mean the watch never reaches this gate on a real board
            // (PLAN REVIEWED is rarely empty), so a session that finished its
            // staged work would keep nudging the lead to dispatch cards nobody
            // staged instead of ending quietly.
            const queueCards = board.filter(p =>
                p && p.kanbanColumn === 'STAGING'
                && (!p.dispatchedAt)
                && (!p.featureId || p.featureId === '')
            );
            if (queueCards.length === 0) {
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] Queue nudge: dropping watch for ${watch.workspaceRoot} — queue is empty (session ended normally).`
                );
                mutated = true;
                continue;
            }

            // ── Subtask 3: resolve pacing for this team ──────────────────
            // Pacing is resolved per-tick (not stored on the watch) so a flip
            // between ticks is picked up on the next tick. Head pacing runs the
            // existing gates (3)–(8) unchanged — byte-for-byte the shipped
            // behaviour, the regression gate for ~4,000 installs. Seat pacing
            // re-points the four existing gates (head live, nothing in flight,
            // head not mid-turn, no turn-end this tick) at the resolved pacer
            // — the seat currently holding a card — rather than the head. No
            // fifth gate; each existing one has a reason and the sweep is
            // already the most interlocked code in this area.
            let pacing: 'head' | 'seat' = 'head';
            if (this._queuePacingResolver) {
                try { pacing = await this._queuePacingResolver(folder, watch.headTerminal); }
                catch (paceErr) {
                    this._host.logger.appendLine(
                        `[GlobalPlanWatcher] Queue nudge: pacing resolution failed for ${watch.workspaceRoot}: ${paceErr}`
                    );
                }
            }

            if (pacing === 'seat') {
                // ── Seat pacing: resolve the pacer from board state ──────
                // The pacer is whichever seat currently holds a card — a card
                // with `dispatched_at` set and `completed_at` NULL. Cards resting
                // in coding columns with `dispatched_at` cleared or `completed_at`
                // set are NOT evidence of work in progress (they are coded cards
                // that belong there per switchboard-contracts #1) and must not
                // suppress the escalation branch. Two conditions: `dispatched_at`
                // set and `completed_at` NULL.
                let teamMembers: Set<string> | null = null;
                if (this._queueTeamMembersResolver && watch.headTerminal) {
                    try {
                        const resolved = await this._queueTeamMembersResolver(folder, watch.headTerminal);
                        teamMembers = new Set(resolved || []);
                    } catch (memberErr) {
                        this._host.logger.appendLine(`[GlobalPlanWatcher] Queue nudge: team resolution failed for ${watch.workspaceRoot}: ${memberErr}`);
                        teamMembers = new Set();
                    }
                }
                const heldCard = board.find(p =>
                    p && p.dispatchedAt
                    && !p.completedAt
                    && typeof p.dispatchedTerminal === 'string'
                    && p.dispatchedTerminal.length > 0
                    && (!teamMembers || teamMembers.has(p.dispatchedTerminal))
                );

                if (!heldCard) {
                    // (3 re-pointed) No pacer — no card has `dispatched_at`
                    // set and the queue is non-empty. Nothing is working and
                    // there is no agent to nudge. Skip the agent nudge
                    // entirely and escalate to the operator on the FIRST
                    // pass, not the second. Waiting a second pass to tell a
                    // human that nothing is running wastes an interval for no
                    // gain — the thing a second nudge tests for (an agent
                    // that was merely slow) cannot apply when no seat holds
                    // the latch. Cards resting in coding columns are not
                    // evidence of work in progress and must not suppress this
                    // branch.
                    //
                    // No gate 5/6/7 check: there is no agent whose turn we'd
                    // interrupt or whose liveness we'd gate on — the operator
                    // is the only correct addressee.
                    if (!watch.escalatedAt) {
                        const body = `[switchboard:turn-end] Queue stall (seat pacing) — ${queueCards.length} card(s) staged in the dispatch queue, but no seat is working (no card has been dispatched). A seat may have died after staging. The queue cannot advance without a working seat.`;
                        try {
                            this._turnEndNotifier({
                                seatName: '',
                                planFile: '',
                                outcome: 'stalled',
                                workspaceRoot: folder,
                                body,
                            });
                        } catch (cbErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] queue nudge seat-pacing no-pacer notifier failed: ${cbErr}`);
                        }
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Queue nudge (seat pacing): escalating to user for ${watch.workspaceRoot} — no seat holding a card, ${queueCards.length} card(s) staged (first-pass escalation).`
                        );
                        watch.escalatedAt = nowMs;
                        watch.lastNudgedAt = nowMs;
                        mutated = true;
                    }
                    kept.push(watch);
                    continue;
                }

                // Pacer resolved — the seat holding the card.
                const pacerSeat = heldCard.dispatchedTerminal!;

                // (4 re-pointed) Pacer present in the record but absent or
                // `exited` → the seat died holding the card. Notify the
                // operator AND record a failed attempt (step 7) so subtask 2's
                // ladder re-stages the card to a stronger seat rather than
                // pinning the queue behind a dead seat. Keep the watch — the
                // queue is still non-empty and the re-stage may dispatch to a
                // new pacer.
                const pacerLive = livenessByName.get(pacerSeat);
                if (!pacerLive || pacerLive.status === 'exited') {
                    // The dead-pacer alert has its OWN one-shot budget, keyed on
                    // the (seat, card) pair it is about — not the shared
                    // `escalatedAt` boolean the no-pacer alert uses. A re-stage
                    // to a second seat that also dies is new information (the
                    // message names a specific seat and card); a repeat about
                    // the same dead seat and card is not. Absent reads as "not
                    // yet alerted" — the safe direction for old records.
                    const deadPacerKey = `${pacerSeat}:${heldCard.planId}`;
                    // Step 7: feed subtask 2's ladder so the dead seat's card
                    // is re-staged. This runs on EVERY dead-pacer tick, OUTSIDE
                    // the alert guard: the one-shot budget belongs to the
                    // operator NOTICE, not to the recovery attempt. A release
                    // that fails transiently (db unavailable, a throw) recovers
                    // on the next tick — muting the retry alongside the notice
                    // would pin the card in its coding column with
                    // `dispatched_at` set until a human intervened. Once the
                    // release lands, `heldCard` no longer names this seat and
                    // the branch is not re-entered, so the retry is bounded by
                    // its own success.
                    //
                    // B2: the seam carries a boolean — true only when the
                    // release made a real non-NULL→NULL latch transition and the
                    // ladder ran, false on a no-op, an absent recorder, or a
                    // throw. A `Promise<void>` seam where "did nothing" and
                    // "worked" are the same value is the hole B2 closes.
                    let released = false;
                    if (this._queueEscalationRecorder) {
                        try { released = await this._queueEscalationRecorder(folder, heldCard.planId, pacerSeat); }
                        catch (recErr) { this._host.logger.appendLine(`[GlobalPlanWatcher] queue nudge escalation recorder failed: ${recErr}`); }
                    }
                    if (watch.deadPacerAlertedFor !== deadPacerKey) {
                        // The notice text depends on whether the card was
                        // actually released: repeating "will be re-staged"
                        // when the release failed is the now-false claim
                        // Layer 3 diagnosed. Say what is true, once.
                        const body = released
                            ? `[switchboard:turn-end] Queue stall (seat pacing) — seat '${pacerSeat}' holding card '${heldCard.planId}' is ${!pacerLive ? 'absent' : 'exited'}. ${queueCards.length} card(s) remain staged. The card will be re-staged to a stronger seat.`
                            : `[switchboard:turn-end] Queue stall (seat pacing) — seat '${pacerSeat}' holding card '${heldCard.planId}' is ${!pacerLive ? 'absent' : 'exited'}. ${queueCards.length} card(s) remain staged. The card could not be released (the seat may have been renamed, or the release silently failed). Re-stage it manually.`;
                        try {
                            this._turnEndNotifier({
                                seatName: pacerSeat,
                                planFile: heldCard.planFile || '',
                                outcome: 'stalled',
                                workspaceRoot: folder,
                                body,
                            });
                        } catch (cbErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] queue nudge seat-pacing dead-pacer notifier failed: ${cbErr}`);
                        }
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Queue nudge (seat pacing): pacer '${pacerSeat}' is ${!pacerLive ? 'absent' : 'exited'} for ${watch.workspaceRoot} — recording failed attempt for card '${heldCard.planId}' (${queueCards.length} card(s) staged).`
                        );
                        watch.deadPacerAlertedFor = deadPacerKey;
                        // `lastNudgedAt` is the shared pacing floor —
                        // legitimately shared across both alert blocks. It is
                        // NOT `nudgeCount`: the agent nudge's one-shot budget
                        // (gate 8) must not be spent by an operator alert.
                        watch.lastNudgedAt = nowMs;
                        mutated = true;
                    }
                    // The `continue` stays OUTSIDE the alert guard: every
                    // tick where the pacer is dead must short-circuit the
                    // rest of the gates, alert or no alert. Moving it inside
                    // the guard makes a suppressed alert fall through to
                    // gates 6/7/8 and deliver the pacer nudge to the dead
                    // terminal it just declined to alert about.
                    kept.push(watch);
                    continue;
                }

                // (6 re-pointed) Pacer notified this tick → keep, stay silent.
                // The shared `notifiedSeatsThisTick` set prevents a double-wake.
                if (notifiedSeatsThisTick.has(pacerSeat)) {
                    kept.push(watch);
                    continue;
                }

                // (7 re-pointed) Pacer's own lastDataAt within
                // turnEndSilenceMs — it is not mid-turn. The seat is actively
                // working; delivering a prompt injects text into a running
                // turn.
                if (pacerLive.lastDataAt <= 0 || nowMs - pacerLive.lastDataAt < turnEndSilenceMs) {
                    kept.push(watch);
                    continue;
                }

                // Pacing floor: at most one nudge per watch per `nudgeSilenceMs`
                // window. `nudgeSilenceMs` (default 10 min) is deliberately
                // separate from `turnEndSilenceMs` (90s) — the nudge is a
                // backstop, not a turn-boundary probe.
                if (watch.lastNudgedAt > 0 && nowMs - watch.lastNudgedAt < nudgeSilenceMs) {
                    kept.push(watch);
                    continue;
                }

                // (8 re-pointed) One nudge, then stop. A pacer that ignored the
                // first nudge is not going to answer a second — repeating every
                // window is the noise this fix exists to eliminate. No user
                // escalation for the stall path: the genuine operator alerts
                // (no-pacer, dead-pacer) are preserved above. A dispatch resets
                // nudgeCount, re-arming for the next stall.
                if (watch.nudgeCount >= 1) {
                    kept.push(watch);
                    continue;
                }

                // Nudge the pacer: one nudge with the state (its card, the
                // staged count) and the instruction to POST /kanban/queue/done
                // when finished, or with outcome: 'failed' if it cannot.
                const silentFor = pacerLive.lastDataAt > 0 ? Math.round((nowMs - pacerLive.lastDataAt) / 1000) : 0;
                const nudgeLines: string[] = [
                    `[switchboard:turn-end] Queue stall (seat pacing) — you have gone idle holding card '${heldCard.planId}' with ${queueCards.length} card(s) staged in the dispatch queue.`,
                    `  You have been silent for ${silentFor}s.`,
                    `  When you finish the card, run \`node "<cliPath>" done --from "${pacerSeat}"\` (or \`switchboard done --from "${pacerSeat}"\`).`,
                    `  If you cannot complete it, run \`node "<cliPath>" done --from "${pacerSeat}" --outcome failed\` with a one-line reason.`,
                ];
                const nudgeBody = substituteCliPath(nudgeLines.join('\n'));

                try {
                    this._turnEndNotifier({
                        seatName: pacerSeat,
                        planFile: heldCard.planFile || '',
                        outcome: 'stalled',
                        workspaceRoot: folder,
                        recipientSeat: pacerSeat,
                        body: nudgeBody,
                    });
                } catch (cbErr) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] queue nudge seat-pacing notifier failed for ${watch.workspaceRoot}: ${cbErr}`);
                }
                notifiedSeatsThisTick.add(pacerSeat);
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] Queue nudge (seat pacing) fired for ${watch.workspaceRoot} → pacer '${pacerSeat}' holding '${heldCard.planId}' (${queueCards.length} card(s) staged).`
                );

                watch.lastNudgedAt = nowMs;
                watch.nudgeCount = (watch.nudgeCount ?? 0) + 1;
                mutated = true;
                kept.push(watch);
                continue;
            }

            // ── Head pacing: existing gates (3)–(8) unchanged ────────────
            // (3) No coding head seated at all. `headTerminal` null, or the
            // recorded head is absent from liveness (not exited — absent means
            // the fleet snapshot has no row, which the empty-liveness guard
            // above already handled for the fleet-unavailable case; here it
            // means the specific head is not live). Keep the watch and notify
            // the user ONCE — a queue staged with no lead is the worst case,
            // not an exempt one.
            //
            // BUT: null must mean "there is no head", never "nobody looked".
            // When a watch was armed with headTerminal null (e.g. staged before
            // a team was seated), attempt resolution via the role-aware
            // resolver before notifying. If a head is now live, UPGRADE the
            // record and fall through to the normal gates (in-flight, mid-turn,
            // nudge) instead of crying outage. This is the plan's requirement:
            // "A staged queue with no head, where a head is later seated,
            // upgrades the record's headTerminal on the next arm or sweep
            // rather than needing a re-stage."
            if (!watch.headTerminal) {
                let resolvedHead: string | null = null;
                if (this._queueHeadResolver) {
                    try {
                        resolvedHead = await this._queueHeadResolver(folder);
                    } catch (resolveErr) {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Queue nudge: head resolution failed for ${watch.workspaceRoot}: ${resolveErr}`
                        );
                    }
                }
                if (resolvedHead) {
                    // A head is now live — upgrade the record and fall through
                    // to the normal gates. Do NOT notify the user; the pipeline
                    // is healthy.
                    this._host.logger.appendLine(
                        `[GlobalPlanWatcher] Queue nudge: upgrading watch for ${watch.workspaceRoot} — head '${resolvedHead}' now live (was null).`
                    );
                    watch.headTerminal = resolvedHead;
                    watch.noHeadNotifiedAt = 0;
                    mutated = true;
                    // Fall through to gates (4)–(8) below with the upgraded head.
                } else {
                    // Resolution genuinely found nobody — notify the user ONCE.
                    if (!watch.noHeadNotifiedAt) {
                        const body = `[switchboard:turn-end] Queue stall — ${queueCards.length} card(s) staged in the dispatch queue, but no coding head is live. Seat a coding team to start the pipeline.`;
                        try {
                            this._turnEndNotifier({
                                seatName: '',
                                planFile: '',
                                outcome: 'stalled',
                                workspaceRoot: folder,
                                body,
                            });
                        } catch (cbErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] queue nudge no-head notifier failed: ${cbErr}`);
                        }
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Queue nudge: no coding head seated for ${watch.workspaceRoot} — notified user (${queueCards.length} card(s) staged).`
                        );
                        watch.noHeadNotifiedAt = nowMs;
                        mutated = true;
                    }
                    kept.push(watch);
                    continue;
                }
            }

            // (4) Head present in the record but absent or `exited` → drop the
            // watch and notify the user, naming the head and the number of
            // cards left staged. Silently dropping is the failure this plan
            // exists to prevent.
            const headLive = livenessByName.get(watch.headTerminal);
            if (!headLive || headLive.status === 'exited') {
                const body = `[switchboard:turn-end] Queue stall — coding head '${watch.headTerminal}' is ${!headLive ? 'absent' : 'exited'} with ${queueCards.length} card(s) still staged in the dispatch queue. The pipeline cannot advance without a lead.`;
                try {
                    this._turnEndNotifier({
                        seatName: watch.headTerminal,
                        planFile: '',
                        outcome: 'stalled',
                        workspaceRoot: folder,
                        body,
                    });
                } catch (cbErr) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] queue nudge dead-head notifier failed: ${cbErr}`);
                }
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] Queue nudge: dropping watch for ${watch.workspaceRoot} — head '${watch.headTerminal}' is ${!headLive ? 'absent' : 'exited'} (${queueCards.length} card(s) left staged).`
                );
                mutated = true;
                continue;
            }

            // (5) Any card in flight for this team → keep, stay silent, and
            // reset nudge state. The lead just dispatched — a fresh stall
            // window starts from this dispatch. The in-flight predicate is
            // `dispatchNextFromQueue`'s, verbatim: a card HELD by a team seat
            // (`dispatched_terminal`) with NO completion fact (`completed_at`
            // is NULL). Board position is NOT an input — completion is asserted
            // via POST /kanban/task/complete and never inferred from a column.
            // Keying on the column instead would muzzle this sweep permanently:
            // a completed card keeps its holder and stays in its coding column,
            // so a column-scoped predicate reads "in flight" forever and the
            // head is never nudged again. Team membership is resolved via
            // `_queueTeamMembersResolver` (the same resolver the seat-pacing
            // branch and `dispatchNextFromQueue` use), so a card dispatched to
            // any team member counts as in-flight — not just one held by the
            // head itself. When the resolver is absent (headless/test harness),
            // fall back to `[watch.headTerminal]` — byte-for-byte the old
            // head-only behavior.
            let headTeamMembers: Set<string> | null = null;
            if (this._queueTeamMembersResolver && watch.headTerminal) {
                try {
                    const resolved = await this._queueTeamMembersResolver(folder, watch.headTerminal);
                    headTeamMembers = new Set(resolved || []);
                } catch (memberErr) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Queue nudge: team resolution failed for ${watch.workspaceRoot}: ${memberErr}`);
                    headTeamMembers = new Set();
                }
            }
            const headTeamSet = headTeamMembers ?? new Set([watch.headTerminal]);
            const inFlight = board.some(p =>
                p && !!p.dispatchedAt
                && !p.completedAt
                && typeof p.dispatchedTerminal === 'string'
                && p.dispatchedTerminal.length > 0
                && headTeamSet.has(p.dispatchedTerminal)
            );
            if (inFlight) {
                if (watch.nudgeCount > 0 || watch.lastNudgedAt > 0 || watch.escalatedAt) {
                    watch.nudgeCount = 0;
                    watch.lastNudgedAt = 0;
                    // Clearing `escalatedAt` re-arms the one-shot escalation:
                    // the queue is moving again, so the NEXT stall is a new
                    // stall and deserves its own notice.
                    delete watch.escalatedAt;
                    mutated = true;
                }
                kept.push(watch);
                continue;
            }

            // Team-liveness: if any team member is actively producing output, the
            // lead is waiting for a coder, not stalled. Suppress the nudge. Reuses
            // the `headTeamSet` computed above and the `livenessByName` map. Even
            // when no card is formally in-flight (all dispatch info cleared by
            // `clearWorkingState`), a coder actively producing output means the
            // lead is correctly idle — waiting for a coder, not stalled.
            const headTeamActive = Array.from(headTeamSet).some(name => {
                const entry = livenessByName.get(name);
                return entry && entry.lastDataAt > 0 && nowMs - entry.lastDataAt < nudgeSilenceMs;
            });
            if (headTeamActive) {
                kept.push(watch);
                continue;
            }

            // (6) A seat notified this tick → keep, stay silent. The shared
            // `notifiedSeatsThisTick` set prevents a double-wake when the head
            // is also a feature head that the feature sweep already poked. Both
            // sweeps must both read AND write this set — a head that is also a
            // feature head gets double-woken on one tick if the queue sweep
            // only reads it.
            if (notifiedSeatsThisTick.has(watch.headTerminal)) {
                kept.push(watch);
                continue;
            }

            // (7) Head's own lastDataAt within turnEndSilenceMs — it is not
            // mid-turn. Delivering a prompt to a terminal whose agent is
            // actively working injects text into a running turn. Evaluated
            // against the same `nowMs` the feature sweep uses — not a fresh
            // `Date.now()`.
            if (headLive.lastDataAt <= 0 || nowMs - headLive.lastDataAt < turnEndSilenceMs) {
                kept.push(watch);
                continue;
            }

            // Pacing: at most one nudge per watch per `nudgeSilenceMs` window.
            // `nudgeSilenceMs` (default 10 min) is deliberately separate from
            // `turnEndSilenceMs` (90s) — the nudge is a backstop, not a
            // turn-boundary probe.
            if (watch.lastNudgedAt > 0 && nowMs - watch.lastNudgedAt < nudgeSilenceMs) {
                kept.push(watch);
                continue;
            }

            // (8) One nudge, then stop. A head that ignored the first nudge is
            // not going to answer a second — repeating every window is the noise
            // this fix exists to eliminate. No user escalation: a lead paced by
            // the queue watch is an agent, not a human, and a second notice to
            // the human about an agent ignoring a first notice is noise that
            // trains the human to ignore the genuine alerts. A dispatch resets
            // nudgeCount (via the in-flight gate above), re-arming for the next
            // stall.
            if (watch.nudgeCount >= 1) {
                kept.push(watch);
                continue;
            }

            // Compose the evidence body. The next card's plan file, how long
            // the head has been silent, and the exact call to make.
            const nextCard = queueCards[0];
            const silentFor = headLive.lastDataAt > 0 ? Math.round((nowMs - headLive.lastDataAt) / 1000) : 0;
            const lines: string[] = [
                `[switchboard:turn-end] Queue stall — you have gone idle with ${queueCards.length} card(s) staged in the dispatch queue.`,
                `  Next card: ${nextCard.planFile} (column ${nextCard.kanbanColumn})`,
                `  You have been silent for ${silentFor}s.`,
                `  Make the call: run \`node "<cliPath>" next --from "${watch.headTerminal}"\` (or \`switchboard next --from "${watch.headTerminal}"\`).`,
            ];
            const body = substituteCliPath(lines.join('\n'));

            try {
                this._turnEndNotifier({
                    seatName: watch.headTerminal,
                    planFile: '',
                    outcome: 'stalled',
                    workspaceRoot: folder,
                    recipientSeat: watch.headTerminal,
                    body,
                });
            } catch (cbErr) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] queue nudge notifier failed for ${watch.workspaceRoot}: ${cbErr}`);
            }
            // Add the head to the shared notifiedSeatsThisTick set so the
            // feature sweep does not double-wake the same head on this tick.
            notifiedSeatsThisTick.add(watch.headTerminal);
            this._host.logger.appendLine(
                `[GlobalPlanWatcher] Queue nudge fired for ${watch.workspaceRoot} → head '${watch.headTerminal}' (${queueCards.length} card(s) staged).`
            );

            watch.lastNudgedAt = nowMs;
            watch.nudgeCount = (watch.nudgeCount ?? 0) + 1;
            mutated = true;
            kept.push(watch);
        }

        if (mutated) {
            try {
                // Merge the processed watches for this workspace with the
                // untouched watches for other workspaces — the config key is
                // process-global, and writing only `kept` would wipe every
                // other workspace's watch on each tick.
                await db.setConfigJson(WATCH_KEY, [...kept, ...otherWatches]);
            } catch (writeErr) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] queue nudge: failed to persist watch state: ${writeErr}`);
            }
        }
    }

    private async _retryPendingFeatureLinks(db: KanbanDatabase, workspaceRoot: string): Promise<void> {
        if (this._pendingFeatureLinks.size === 0) return;
        const workspaceId = (await db.getWorkspaceId()) || '';
        const entries = [...this._pendingFeatureLinks.entries()];
        for (const [subtaskPlanId, { featureId }] of entries) {
            await this._applyFeatureLink(db, subtaskPlanId, featureId, '', workspaceId, workspaceRoot);
        }
    }

    /**
     * Link the subtasks a feature file's `<!-- BEGIN SUBTASKS -->` / `## Subtasks` block
     * names, so feature membership can be declared by writing files alone (no running
     * API server). Additive only — see KanbanDatabase.linkFeatureSubtasksByPaths for why
     * omission from the block must never imply removal.
     */
    private async _linkFeatureMarkdownSubtasks(
        db: KanbanDatabase,
        featurePlanId: string,
        content: string,
        workspaceId: string
    ): Promise<void> {
        try {
            // The heading fallback is deliberately NOT /m. Under /m, `$` in the
            // lookahead matches at every end-of-line, so `[\s\S]*?` stops at the
            // first newline and the capture is the FIRST subtask line only — every
            // later link then reads as "removed from the file" and gets unlinked.
            // `(?:^|\n)` keeps the heading line-anchored without the flag (a bare
            // /##\s*Subtasks/ also matches the literal text inside prose or
            // backticks — e.g. a feature that documents this very code).
            const subtaskMatch = content.match(/<!-- BEGIN SUBTASKS[\s\S]*?-->([\s\S]*?)<!-- END SUBTASKS/i)
                || content.match(/(?:^|\n)##[ \t]*Subtasks[ \t]*\r?\n([\s\S]*?)(?=\n##|\n<!--|$)/i);
            if (subtaskMatch && subtaskMatch[1]) {
                const linkedPaths: string[] = [];
                const unparsedTargets: string[] = [];
                for (const line of subtaskMatch[1].split('\n')) {
                    const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
                    if (!linkMatch || !linkMatch[2]) continue;
                    let target = linkMatch[2].trim();
                    if (target.startsWith('../plans/')) {
                        target = path.join('.switchboard', 'plans', target.slice('../plans/'.length));
                    } else if (target.startsWith('.switchboard/plans/')) {
                        // already root-relative
                    } else if (target.startsWith('./')) {
                        target = path.join('.switchboard', 'features', target.slice(2));
                    } else {
                        // A link we cannot map to a plan path (plan-ID-only, bare
                        // basename, external URL). Record it: the block lists a
                        // subtask we cannot see, so the parsed set is not the whole
                        // truth and must not authorise unlinking.
                        unparsedTargets.push(target);
                        continue;
                    }
                    linkedPaths.push(target.replace(/\\/g, '/'));
                }
                if (unparsedTargets.length > 0) {
                    this._host.logger.appendLine(
                        `[GlobalPlanWatcher] _linkFeatureMarkdownSubtasks: feature ${featurePlanId} lists ` +
                        `${unparsedTargets.length} link(s) in an unsupported shape (${unparsedTargets.slice(0, 5).join(', ')}) — ` +
                        `linking the ${linkedPaths.length} resolvable one(s) and ignoring the rest.`
                    );
                }
                await db.linkFeatureSubtasksByPaths(featurePlanId, linkedPaths, workspaceId);
            }
        } catch (err) {
            this._host.logger.appendLine(
                `[GlobalPlanWatcher] _linkFeatureMarkdownSubtasks failed for feature ${featurePlanId}: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    private async _handlePlanFile(fsPath: string, workspaceRoot: string): Promise<void> {
        try {
            if (PlanIngestionEngine._pendingCreations.has(path.resolve(fsPath))) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] Skipping watcher insert for internally created plan: ${fsPath}`);
                return;
            }

            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();

            const relativePath = path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
            if (relativePath.startsWith('.switchboard/features/')) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] feature-file handle: instance ${db.instanceId} (dbPath=${db.dbPath}) for ${relativePath}`);
                appendFeatureClobberDiag(workspaceRoot, `watcher._handlePlanFile: instance=${db.instanceId} handling feature file ${relativePath}`);
            }
            if (isRuntimeMirrorPlanFile(path.basename(relativePath))) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] Skipped brain mirror file: ${relativePath}`);
                return;
            }
            const workspaceId = await db.getWorkspaceId();

            if (!workspaceId) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] No workspaceId for ${workspaceRoot}, skipping import`);
                return;
            }

            let plan = await db.getPlanByPlanFile(relativePath, workspaceId);
            if (plan && plan.status === 'missing') {
                await db.reactivatePlanByPlanFile(plan.planFile, plan.workspaceId);
                plan.status = 'active';
                this._host.logger.appendLine(`[GlobalPlanWatcher] Reactivated missing plan: ${plan.planFile}`);
            }

            let fileMtime = new Date().toISOString();
            let fileBirthtime = fileMtime;
            try {
                const stats = await fs.promises.stat(fsPath);
                fileMtime = stats.mtime.toISOString();
                fileBirthtime = stats.birthtime && stats.birthtime.getTime() > 0
                    ? stats.birthtime.toISOString()
                    : fileMtime;
            } catch (statErr) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] stat() failed for ${fsPath}: ${statErr}`);
            }

            if (plan && new Date(fileMtime).getTime() <= new Date(plan.updatedAt).getTime()) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] Plan unchanged, skipping: ${relativePath}`);
                return;
            }

            if (!plan) {
                const absolutePath = fsPath.replace(/\\/g, '/');
                plan = await db.getPlanByPlanFile(absolutePath, workspaceId);
                if (plan) {
                    if (plan.status === 'missing') {
                        await db.reactivatePlanByPlanFile(plan.planFile, plan.workspaceId);
                        plan.status = 'active';
                        this._host.logger.appendLine(`[GlobalPlanWatcher] Reactivated missing plan (absolute fallback): ${plan.planFile}`);
                    }
                    if (plan.sourceType === 'local') {
                        await db.movePlanByPlanFile(absolutePath, workspaceId, plan.kanbanColumn, relativePath);
                        plan = await db.getPlanByPlanFile(relativePath, workspaceId);
                    }
                }
            }

            if (!plan && relativePath.startsWith('.switchboard/features/')) {
                const featureUuidMatch = path.basename(relativePath).match(
                    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i
                );
                if (featureUuidMatch) {
                    const tombstoned = await db.getPlanByPlanId(featureUuidMatch[1]);
                    if (tombstoned && tombstoned.status === 'deleted') {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Skipping import of deleted feature (plan_id tombstone guard): ${relativePath}`
                        );
                        return;
                    }
                }
            }

            const content = await fs.promises.readFile(fsPath, 'utf8');
            const metadata = await parsePlanMetadata(content, relativePath);

            if (!metadata.project && /\*\*Project\b/i.test(content)) {
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] [pin-parse] file contains a **Project marker but no pin was parsed: ${relativePath}`
                );
            }

            let importClickupTaskId = extractClickUpTaskId(content);
            let importLinearIssueId = extractLinearIssueId(content);
            let importSourceType: KanbanPlanRecord['sourceType'] = 'local';
            if (importClickupTaskId && importLinearIssueId) {
                importClickupTaskId = '';
                importLinearIssueId = '';
            } else if (importClickupTaskId) {
                importSourceType = 'clickup-import';
            } else if (importLinearIssueId) {
                importSourceType = 'linear-import';
            }

            if (!plan) {
                const project = metadata.project;
                let derivedPlanId = uuidv4();
                if (relativePath.startsWith('.switchboard/features/')) {
                    const featureUuidMatch = path.basename(relativePath).match(
                        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i
                    );
                    if (featureUuidMatch) {
                        derivedPlanId = featureUuidMatch[1];
                    }
                }
                const newRecord: KanbanPlanRecord = {
                    planId: derivedPlanId,
                    sessionId: '',
                    topic: metadata.topic,
                    planFile: relativePath,
                    kanbanColumn: metadata.kanbanColumn || 'CREATED',
                    status: 'active',
                    complexity: metadata.complexity,
                    tags: metadata.tags,
                    repoScope: '',
                    project,
                    workspaceId: workspaceId,
                    createdAt: fileBirthtime,
                    updatedAt: fileMtime,
                    lastAction: '',
                    sourceType: 'local',
                    brainSourcePath: '',
                    mirrorPath: '',
                    routedTo: '',
                    dispatchedAgent: '',
                    dispatchedIde: '',
                    clickupTaskId: importClickupTaskId,
                    linearIssueId: importLinearIssueId
                };
                newRecord.sourceType = importSourceType;
                if (relativePath.startsWith('.switchboard/features/')) {
                    newRecord.isFeature = 1;
                }
                await db.insertFileDerivedPlan(newRecord);
                if (relativePath.startsWith('.switchboard/features/')) {
                    await db.updateFeatureStatus(newRecord.planId, 1, '');
                    await this._linkFeatureMarkdownSubtasks(db, newRecord.planId, content, workspaceId);
                    await this._retryPendingFeatureLinks(db, workspaceRoot);
                } else if (metadata.feature) {
                    await this._applyFeatureLink(db, newRecord.planId, metadata.feature, relativePath, workspaceId, workspaceRoot);
                }
                const tombKey = `${relativePath}|${workspaceId}`;
                const tomb = this._recentlyDeletedColumns.get(tombKey);
                let restoredFromTombstone = false;
                if (tomb && Date.now() - tomb.ts < 5000 && tomb.column && tomb.column !== 'CREATED') {
                    const moved = await db.movePlanByPlanFile(relativePath, workspaceId, tomb.column, relativePath);
                    if (moved) {
                        newRecord.kanbanColumn = tomb.column;
                        restoredFromTombstone = true;
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Restored column '${tomb.column}' from delete-tombstone for: ${relativePath}`
                        );
                    } else {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Tombstone column '${tomb.column}' rejected by movePlanByPlanFile (invalid/removed), plan stays at CREATED: ${relativePath}`
                        );
                    }
                }
                this._recentlyDeletedColumns.delete(tombKey);
                if (relativePath.startsWith('.switchboard/features/') && !restoredFromTombstone) {
                    await this._recomputeFeatureColumn?.(newRecord.planId, workspaceRoot);
                }
                plan = newRecord;

                this._host.logger.appendLine(`[GlobalPlanWatcher] Imported new plan: ${relativePath} in ${workspaceId}`);
            } else {
                const updatedRecord: KanbanPlanRecord = {
                    ...plan,
                    topic: metadata.topic,
                    complexity: metadata.complexity,
                    tags: metadata.tags,
                    // Send the FILE's pin when the DB row is unassigned and not a
                    // subtask, so the SQL's apply-if-empty CASE has something to
                    // apply; keep the DB value otherwise so a re-import can never
                    // move an assigned card (and a subtask's project stays
                    // governed by its feature).
                    project: (plan.project === '' && !plan.featureId && metadata.project) ? metadata.project : plan.project,
                    updatedAt: fileMtime
                };
                if (relativePath.startsWith('.switchboard/features/')) {
                    updatedRecord.isFeature = 1;
                }
                await db.insertFileDerivedPlan(updatedRecord);
                if (relativePath.startsWith('.switchboard/features/')) {
                    await db.updateFeatureStatus(updatedRecord.planId, 1, '');
                    await this._linkFeatureMarkdownSubtasks(db, updatedRecord.planId, content, workspaceId);
                    await this._retryPendingFeatureLinks(db, workspaceRoot);
                    const tombKey = `${relativePath}|${workspaceId}`;
                    const tomb = this._recentlyDeletedColumns.get(tombKey);
                    let restoredFromTombstone = false;
                    if (tomb && Date.now() - tomb.ts < 5000 && tomb.column && tomb.column !== 'CREATED') {
                        const moved = await db.movePlanByPlanFile(relativePath, workspaceId, tomb.column, relativePath);
                        if (moved) {
                            updatedRecord.kanbanColumn = tomb.column;
                            restoredFromTombstone = true;
                            this._host.logger.appendLine(
                                `[GlobalPlanWatcher] Restored column '${tomb.column}' from delete-tombstone for feature: ${relativePath}`
                            );
                        }
                    }
                    this._recentlyDeletedColumns.delete(tombKey);
                    if (!restoredFromTombstone) {
                        await this._recomputeFeatureColumn?.(updatedRecord.planId, workspaceRoot);
                    }
                } else if (updatedRecord.featureId) {
                    try {
                        await db.recomputeFeatureComplexity(updatedRecord.featureId);
                    } catch (bubbleErr) {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] recomputeFeatureComplexity failed for ${updatedRecord.featureId}: ${bubbleErr}`
                        );
                    }
                }
                if (metadata.feature && !relativePath.startsWith('.switchboard/features/')) {
                    await this._applyFeatureLink(db, updatedRecord.planId, metadata.feature, relativePath, workspaceId, workspaceRoot);
                }
                if (updatedRecord.dispatchedAt) {
                    this._host.logger.appendLine(
                        `[GlobalPlanWatcher] Plan file edited while dispatched (mtime-based completion retired — waiting for POST /kanban/queue/done): ${relativePath}`
                    );
                }
                plan = updatedRecord;

                this._host.logger.appendLine(`[GlobalPlanWatcher] Updated plan: ${plan.planFile} in ${workspaceId}`);
            }

            // ClickUp real-time sync
            if (plan) {
                try {
                    const clickUp = this._getClickUpService(workspaceRoot);
                    const clickUpConfig = await clickUp.loadConfig();
                    if (clickUpConfig?.setupComplete === true && clickUpConfig.realTimeSyncEnabled === true && (await clickUp.hasApiToken())) {
                        clickUp.debouncedSync(plan.planFile, {
                            planId: plan.planId,
                            sessionId: plan.sessionId,
                            topic: plan.topic,
                            planFile: plan.planFile,
                            kanbanColumn: plan.kanbanColumn,
                            status: plan.status,
                            complexity: plan.complexity,
                            tags: plan.tags,
                            createdAt: plan.createdAt,
                            updatedAt: plan.updatedAt,
                            lastAction: plan.lastAction
                        });
                    }
                } catch { /* skip sync errors */ }
            }

            this._firePlanDiscovered(workspaceRoot, fsPath);
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Error handling plan: ${err}`);
        }
    }

    private async _handlePlanDelete(fsPath: string, workspaceRoot: string): Promise<void> {
        try {
            // Atomic-write guard: external tools save via temp+rename, which fires a DELETE
            // event for the target path even though the rename immediately recreated it.
            // Checked here, AFTER the 300ms debounce, so the rename has definitely landed.
            if (fs.existsSync(fsPath)) {
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] Skipping delete; file still exists (atomic write/rename): ${fsPath}`
                );
                return;
            }

            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();

            const relativePath = path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
            const workspaceId = await db.getWorkspaceId();

            if (workspaceId) {
                if (this._recentRenames.has(relativePath)) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Skipping delete for recently-renamed plan: ${relativePath}`);
                    return;
                }
                const plan = await db.getPlanByPlanFile(relativePath, workspaceId);
                if (plan) {
                    if (plan.status === 'completed') {
                        this._host.logger.appendLine(`[GlobalPlanWatcher] Skipping delete for archived completed plan: ${plan.planFile}`);
                        return;
                    }
                    const tombKey = `${relativePath}|${workspaceId}`;
                    this._recentlyDeletedColumns.set(tombKey, {
                        column: plan.kanbanColumn || '',
                        ts: Date.now()
                    });
                    await db.markPlanMissingByPlanFile(plan.planFile, plan.workspaceId);
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Soft-deleted (marked missing) plan: ${plan.planFile}`);
                    this._firePlanDiscovered(workspaceRoot, fsPath);
                }
            }
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Error deleting plan: ${err}`);
        }
    }

    public async triggerScan(workspaceRoot: string): Promise<void> {
        this._host.logger.appendLine(`[GlobalPlanWatcher] Manual scan triggered for ${workspaceRoot}`);
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        const featuresDir = path.join(workspaceRoot, '.switchboard', 'features');

        if (!fs.existsSync(plansDir) && !fs.existsSync(featuresDir)) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Switchboard directories not found in ${workspaceRoot}`);
            return;
        }

        try {
            let processed = 0;
            const scanDir = async (dir: string): Promise<void> => {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await scanDir(entryPath);
                    } else if (entry.isFile() && entry.name.endsWith('.md')) {
                        await this._handlePlanFile(entryPath, workspaceRoot);
                        processed++;
                    }
                }
            };
            if (fs.existsSync(plansDir)) {
                await scanDir(plansDir);
            }
            if (fs.existsSync(featuresDir)) {
                await scanDir(featuresDir);
            }

            this._host.logger.appendLine(`[GlobalPlanWatcher] Scanned ${processed} files in ${workspaceRoot}`);
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Scan error in ${workspaceRoot}: ${err}`);
        }
    }

    /**
     * Synchronously ingest a single plan file path — used by the create/scan/import
     * verbs so the board buttons drive the same engine path as a file drop, bypassing
     * the 300ms debounce (the caller already knows the file exists).
     */
    public async ingestPlanFile(fsPath: string, workspaceRoot: string): Promise<void> {
        await this._handlePlanFile(fsPath, workspaceRoot);
    }

    public dispose(): void {
        if (this._scanInterval) {
            clearInterval(this._scanInterval);
            this._scanInterval = undefined;
        }

        for (const watcher of this._watchers.values()) {
            try { watcher.dispose(); } catch {}
        }
        this._watchers.clear();

        for (const watcher of this._gitWatchers.values()) {
            try { watcher.dispose(); } catch {}
        }
        this._gitWatchers.clear();

        for (const timer of this._debounceTimers.values()) {
            clearTimeout(timer);
        }
        this._debounceTimers.clear();

        try { this._envHandle?.dispose(); } catch {}
        this._envHandle = undefined;
    }
}

// ─── Home-dir expansion helper (shared by both adapters) ────────────────────

export function expandHome(p: string): string {
    const trimmed = p.trim();
    return trimmed.startsWith('~')
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed;
}

// ─── Turn-end notice composer for completed arm ─────────────────────────────

/**
 * The closing instruction on a `completed` turn-end notice: verify, then act.
 *
 * The action tail is load-bearing — a notice that only says "verify" produces a
 * lead that verifies and stops, because verification is then the whole turn.
 *
 * CARD MOVEMENT IS NOT AN ACTION THIS MAY NAME. An earlier form read "…then
 * advance the card or register the next subtask…", which contradicted the head's
 * own standing orders ("Never move a card to a new column yourself — that is not
 * your role") on the same lead, minutes apart. `team-heads-must-not-move-cards`
 * removed that language from `NEW_CODING_HEAD_PROMPT` — where
 * `stage-marker-commit-contract` now guards it with `!/advanc/i` — but scoped
 * itself to the prompt text and left this notice alone, so the wording came back
 * here. `terminal-plan-attribution-contract` guards this constant the same way.
 *
 * The endpoint for closing out is deliberately NOT restated: on the queue/done
 * relay `composeAcceptanceInstruction` (LocalApiServer.ts:742) follows this
 * sentence and spells out the POST. Naming it here would say it twice.
 */
export const TURN_END_VERIFY_INSTRUCTION =
    'Verify the diff (git diff) before you trust the report, then close out that subtask, register the next one (attributePastedPrompt), and dispatch it. The system moves cards as work progresses — never move one yourself.';

/**
 * The evidence fragment a completion notice carries after the seat/plan
 * identity: ` — "topic" (column X, feature Y, worked 12m)`. Empty when the
 * record has neither a topic nor a single renderable clause.
 *
 * Split out of {@link composeCompletedTurnEndBody} so the queue/done team-lead
 * relay renders the SAME evidence rather than a second, thinner summary of the
 * same card. Two notices about one completion that disagree on the detail is
 * worse than one — and the relay is the notice the lead actually receives now
 * (see `_runQueueDone`, which suppresses the turn-end live send when it fires).
 */
export function composeCompletionEvidence(
    record: Pick<KanbanPlanRecord, 'topic' | 'kanbanColumn' | 'featureId' | 'dispatchedAt'>,
    nowMs: number
): string {
    const rawTopic = String(record?.topic || '').replace(/[\r\n]+/g, ' ').trim();
    let safeTopic = rawTopic;
    if (safeTopic.length > 80) {
        safeTopic = safeTopic.slice(0, 80) + '…';
    }

    const clauses: string[] = [];
    if (record?.kanbanColumn) {
        clauses.push(`column ${record.kanbanColumn}`);
    }
    if (record?.featureId) {
        clauses.push(`feature ${record.featureId}`);
    }
    if (record?.dispatchedAt) {
        const parsed = Date.parse(record.dispatchedAt);
        if (Number.isFinite(parsed)) {
            const ms = Math.max(0, nowMs - parsed);
            const duration = ms < 120000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
            clauses.push(`worked ${duration}`);
        }
    }

    const topicClause = safeTopic ? ` — "${safeTopic}"` : '';
    const parenthetical = clauses.length > 0 ? ` (${clauses.join(', ')})` : '';
    return `${topicClause}${parenthetical}`;
}

export function composeCompletedTurnEndBody(
    record: Pick<KanbanPlanRecord, 'topic' | 'kanbanColumn' | 'featureId' | 'dispatchedAt'>,
    seatName: string,
    planFile: string,
    nowMs: number
): string {
    const safePlanFile = String(planFile || '').replace(/[\r\n]+/g, ' ').trim();
    const evidence = composeCompletionEvidence(record, nowMs);
    const header = `[switchboard:turn-end] Seat '${seatName}' finished its turn on '${safePlanFile}'${evidence}.`;

    return `${header}\n${TURN_END_VERIFY_INSTRUCTION}`;
}

