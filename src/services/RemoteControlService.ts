import * as path from 'path';
import type { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';
import type { RemoteProvider, RemoteStateDelta } from './remote/RemoteProvider';
import type { ContentConflictResolver } from './remote/ContentConflictResolver';
import { LastWriteWinsResolver } from './remote/ContentConflictResolver';
import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * §7/§9/§10 — Remote Control (provider-agnostic: Linear, Notion, or git-backed).
 *
 * Polls the active provider on a timer (no webhooks) for the user's selected boards and:
 *  - mirrors remote state changes onto the Kanban column, dispatching that column's agent
 *    the same way a manual drag would (§9);
 *  - ingests new comments and routes them to the current column's agent (§7).
 *
 * Delta polling (D4): instead of fetching every tracked card each cycle, the provider is
 * asked "what changed since my cursor?" — usually nothing. State and comments are TWO
 * separate streams with TWO cursors (a Linear comment does not bump the issue `updatedAt`;
 * a Notion native comment does not bump the page `last_edited_time`).
 *
 * The loop-closing guards are load-bearing. They prevent the system's OWN round-trip
 * (outbound push → bumped remote timestamp → inbound delta) from feeding itself — NOT a
 * human editing both sides at once (that's last-write-wins, not a case we defend):
 *  - state: a delta whose column equals the card's CURRENT column is a no-op. Once a move
 *    is applied the local column matches, so our own outbound push re-surfacing as a delta
 *    just no-ops here. That single equality check is the whole guard. This guard is now
 *    load-bearing for Notion too (pushState bumps last_edited_time → state delta re-fetches
 *    → column matches → no-op). Content push (pushContent) also bumps last_edited_time,
 *    but the column hasn't changed → echo guard no-ops the state delta.
 *  - authoredBySelf: outbound comments (Linear marker / Notion `created_by` = bot) are
 *    skipped on ingest;
 *  - processed-comment-id set: this is Notion-API hygiene, not race defense — Notion rounds
 *    `created_time` to the minute and only supports an inclusive filter, so the boundary
 *    minute's comments re-appear each poll; the seen-set de-dups them;
 *  - the comment cursor advances only AFTER dispatch, so a reload mid-dispatch re-fetches
 *    on the next poll (delayed, not lost).
 */

export type RemoteProviderKind = 'linear' | 'notion' | 'clickup';

export interface RemoteConfig {
    /** Which remote backend drives the board. One active at a time (no hot-swap). */
    provider: RemoteProviderKind;
    /** Project board names that participate in sync/ping. */
    boards: string[];
    /** Stay synced with the provider even while pinging is off. */
    silentSync: boolean;
    /** Poll cadence, 30–120s. */
    pingFrequencySeconds: number;
    /** Remote mode: 'ingest' = pull only (no state mirror, no agent dispatch); 'full' = pull + mirror + dispatch. */
    mode: 'ingest' | 'full';
    /** Whether push (status + content) is active. Gates push at trigger sites. */
    push: boolean;
    /** Whether comment polling is active. */
    comments: boolean;
    /** Whether plan-content polling is active (pull remote body edits back into the local plan file). */
    content: boolean;
}

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
    provider: 'linear',
    boards: [],
    silentSync: false,
    pingFrequencySeconds: 60,
    mode: 'ingest',
    push: false,
    comments: true,
    content: true
};

/**
 * Remote-sync health snapshot (feature 7 — Remote-Sync Health & Error Surfacing).
 * Surfaced in the Remote tab so silent failures (bad token, revoked connection,
 * rate-limit storm) are visible instead of console-only.
 */
export interface RemoteSyncHealth {
    active: boolean;
    provider: RemoteProviderKind;
    lastPollAt: string | null;
    lastPollOk: boolean;
    lastPollError: string | null;
    consecutiveFailures: number;
    /** True when the provider returned 429/529 and backoff is engaged. */
    throttled: boolean;
    throttleUntil: string | null;
    lastPushAt: string | null;
    lastPushOk: boolean;
    lastPushError: string | null;
}

const REMOTE_CONFIG_KEY = 'remote.config';
const COMMENT_SEEN_CAP = 500;

const stateCursorKey = (kind: RemoteProviderKind) => `remote.stateCursor.${kind}`;
const commentCursorKey = (kind: RemoteProviderKind) => `remote.commentCursor.${kind}`;
const commentSeenKey = (kind: RemoteProviderKind) => `remote.commentSeen.${kind}`;

interface RemoteControlDeps {
    getDb: () => KanbanDatabase | null;
    getWorkspaceId: () => Promise<string>;
    /** Build the provider for the active backend (or null if its integration isn't configured). */
    getProvider: (kind: RemoteProviderKind) => RemoteProvider | null;
    /** Apply a remote-driven column move + dispatch the destination column's agent (§9). */
    onColumnMove: (plan: KanbanPlanRecord, targetColumn: string) => Promise<{ dispatched: boolean }>;
    /** Route an inbound comment to the card's current column agent (§7). */
    onComment: (plan: KanbanPlanRecord, commentBody: string) => Promise<void>;
    /** Persisted description-sync cursors per issue (issueId → ISO timestamp). */
    getDescriptionCursors?: (kind: RemoteProviderKind) => Promise<Record<string, string>>;
    /** Persist a description-sync cursor for an issue. */
    setDescriptionCursor?: (kind: RemoteProviderKind, issueId: string, timestamp: string) => Promise<void>;
    /** Called after a description is pulled and written to disk. Registers the content hash for loop prevention. */
    onDescriptionPulled?: (issueId: string, contentHash: string) => void;
    /**
     * Conflict resolver for content-pull: decides whether a remote body should overwrite
     * the local plan file. Defaults to `LastWriteWinsResolver` when not injected. The seam
     * exists so a follow-on plan can swap in a locking/turn-taking resolver.
     */
    contentConflictResolver?: ContentConflictResolver;
    /** Resolve the workspace root for file path operations (plan files). */
    getWorkspaceRoot?: () => string;
    /**
     * Inbound-delete opt-in check (provider-sync inbound-delete). Returns true if the
     * given provider has inbound-delete detection+tombstone enabled (default off).
     * When false, the reconcile-sweep still runs (detecting deletions) but takes no
     * destructive action — or is skipped entirely if the provider isn't configured.
     * If not injected, the sweep is skipped (safe default — no destructive action).
     */
    getInboundDeleteEnabled?: (kind: RemoteProviderKind) => Promise<boolean>;
    log?: (msg: string) => void;
}

export class RemoteControlService {
    private _deps: RemoteControlDeps;
    private _timer?: NodeJS.Timeout;
    private _polling = false;
    private _active = false;
    // ── Health state (feature 7 — Remote-Sync Health & Error Surfacing) ──
    private _lastPollAt: string | null = null;
    private _lastPollOk = true;
    private _lastPollError: string | null = null;
    private _consecutiveFailures = 0;
    private _throttled = false;
    private _throttleUntil: string | null = null;
    private _lastPushAt: string | null = null;
    private _lastPushOk = true;
    private _lastPushError: string | null = null;
    // ── Inbound-delete reconcile-sweep state (provider-sync inbound-delete) ──
    private _sweeping = false;
    /** Polls between reconcile sweeps. Default targets ~10–15 min of wall-clock at
     *  a 60s poll (N = round(600 / 60) = 10), bounded [4, 20] so a ~13s sweep never
     *  starves the normal poll. Tunable later without a redesign. */
    private _sweepEveryN = 10;
    private _pollsSinceSweep = 0;
    /** Mid-create race guard: remoteId → ISO timestamp of the most recent outbound
     *  create that persisted the id. A sweep must NOT tombstone a plan whose id was
     *  persisted within this window (the outbound create just round-tripped; the
     *  remote item exists but may not yet be visible to a paginated query). */
    private _recentlyCreatedRemoteIds = new Map<string, string>();
    private static readonly MID_CREATE_GUARD_MS = 60_000;

    constructor(deps: RemoteControlDeps) {
        this._deps = deps;
    }

    public get isActive(): boolean { return this._active; }

    /**
     * Health snapshot for the Remote tab UI (feature 7). Reads the in-memory
     * last-status state recorded by the poll/push loops — no DB hit.
     */
    public async getHealth(): Promise<RemoteSyncHealth> {
        const config = await this.getConfig();
        // Clear the throttled flag once the backoff window expires.
        if (this._throttled && this._throttleUntil) {
            const until = Date.parse(this._throttleUntil);
            if (isFinite(until) && Date.now() >= until) {
                this._throttled = false;
                this._throttleUntil = null;
            }
        }
        return {
            active: this._active,
            provider: config.provider,
            lastPollAt: this._lastPollAt,
            lastPollOk: this._lastPollOk,
            lastPollError: this._lastPollError,
            consecutiveFailures: this._consecutiveFailures,
            throttled: this._throttled,
            throttleUntil: this._throttleUntil,
            lastPushAt: this._lastPushAt,
            lastPushOk: this._lastPushOk,
            lastPushError: this._lastPushError,
        };
    }

    /** Record an outbound push outcome (called by push dispatch paths). */
    public recordPushResult(ok: boolean, error?: string): void {
        this._lastPushAt = new Date().toISOString();
        this._lastPushOk = ok;
        this._lastPushError = ok ? null : (error || 'unknown error');
    }

    /**
     * Register a freshly-persisted outbound create id (provider-sync full parity).
     * The inbound-delete reconcile-sweep must NOT tombstone a plan whose remote id
     * was persisted within the MID_CREATE_GUARD_MS window — the outbound create just
     * round-tripped and the remote item exists, but a paginated sweep query may not
     * yet reflect it (eventual consistency / race). Called by the outbound create
     * path after the id is written to the local DB.
     */
    public registerOutboundCreate(remoteId: string): void {
        const id = String(remoteId || '').trim();
        if (!id) { return; }
        this._recentlyCreatedRemoteIds.set(id, new Date().toISOString());
        // Bounded — drop entries older than the guard window on each registration.
        const cutoff = Date.now() - RemoteControlService.MID_CREATE_GUARD_MS;
        for (const [rid, ts] of this._recentlyCreatedRemoteIds) {
            const t = Date.parse(ts);
            if (isFinite(t) && t < cutoff) { this._recentlyCreatedRemoteIds.delete(rid); }
        }
    }

    private _log(msg: string): void {
        (this._deps.log || ((m) => console.log(m)))(`[RemoteControl] ${msg}`);
    }

    // ── Config (DB config table, never state.json) ──────────────────

    public async getConfig(): Promise<RemoteConfig> {
        const db = this._deps.getDb();
        if (!db || !(await db.ensureReady())) { return { ...DEFAULT_REMOTE_CONFIG }; }
        try {
            const raw = await db.getConfig(REMOTE_CONFIG_KEY);
            if (!raw) { return { ...DEFAULT_REMOTE_CONFIG }; }
            const parsed = JSON.parse(raw);
            return {
                provider: this._normalizeProviderKind(parsed.provider),
                boards: this._normalizeBoards(parsed.boards),
                silentSync: parsed.silentSync === true,
                pingFrequencySeconds: this._clampFrequency(parsed.pingFrequencySeconds),
                mode: parsed.mode === 'full' ? 'full' : 'ingest',
                push: parsed.push === true,
                comments: parsed.comments !== false, // default true
                content: parsed.content !== false, // default true
            };
        } catch {
            return { ...DEFAULT_REMOTE_CONFIG };
        }
    }

    public async setConfig(config: RemoteConfig): Promise<void> {
        const db = this._deps.getDb();
        if (!db || !(await db.ensureReady())) { return; }
        const normalized: RemoteConfig = {
            provider: this._normalizeProviderKind(config.provider),
            boards: this._normalizeBoards(config.boards),
            silentSync: config.silentSync === true,
            pingFrequencySeconds: this._clampFrequency(config.pingFrequencySeconds),
            mode: config.mode === 'full' ? 'full' : 'ingest',
            push: config.push === true,
            comments: config.comments !== false,
            content: config.content !== false,
        };
        await db.setConfig(REMOTE_CONFIG_KEY, JSON.stringify(normalized));
        if (this._active) {
            // Restart the timer with the new cadence.
            this._scheduleTimer(normalized.pingFrequencySeconds);
        }
    }

    private _normalizeProviderKind(value: unknown): RemoteProviderKind {
        const valid: RemoteProviderKind[] = ['linear', 'notion', 'clickup'];
        const str = String(value || '');
        return valid.includes(str as RemoteProviderKind) ? (str as RemoteProviderKind) : 'linear';
    }

    /**
     * Normalize the persisted board list. Keeps the empty string '' (the base
     * workspace board key) but rejects null/undefined/non-string junk. A plain
     * .filter(Boolean) would silently drop '' and the "No Project" board could
     * never round-trip.
     */
    private _normalizeBoards(input: unknown): string[] {
        if (!Array.isArray(input)) { return []; }
        return input.filter((b): b is string => typeof b === 'string');
    }

    private _clampFrequency(value: unknown): number {
        const n = Number(value);
        if (!isFinite(n)) { return DEFAULT_REMOTE_CONFIG.pingFrequencySeconds; }
        return Math.min(120, Math.max(30, Math.round(n)));
    }

    // ── Lifecycle ───────────────────────────────────────────────────

    /** Start pinging. If silentSync is off, run a reconciling sync first. */
    public async start(): Promise<void> {
        const config = await this.getConfig();
        if (config.boards.length === 0) {
            this._log('No boards selected — not starting.');
            return;
        }
        // Size the sweep cadence to ~10 min of wall-clock at the configured poll rate,
        // bounded [4, 20] so a ~13s sweep never starves the normal poll.
        this._sweepEveryN = Math.min(20, Math.max(4, Math.round(600 / Math.max(1, config.pingFrequencySeconds))));
        if (!config.silentSync) {
            this._log('Silent sync off — running a reconciling poll before starting loop.');
            await this._poll(); // one-time reconcile before the loop
            // Inbound-delete reconcile-sweep on start() (provider-sync inbound-delete).
            // Runs once on boot so deletions accumulated while the machine was off are
            // caught; the Nth-poll cadence below handles mid-run deletions.
            await this._reconcileSweep();
        }
        this._active = true;
        this._scheduleTimer(config.pingFrequencySeconds);
        this._log(`Started (provider=${config.provider}, every ${config.pingFrequencySeconds}s, ${config.boards.length} board(s)).`);
    }

    /**
     * One-shot reconciliation: run a single poll cycle (state + comments) without
     * starting the recurring timer or marking the service active. Called at IDE
     * startup so cards advance from remote status changes accumulated while the
     * machine was off. Reuses the existing cursors, echo guards, seed-on-first-poll,
     * and import logic — no parallel pipeline, no new key.
     */
    public async reconcileOnce(): Promise<void> {
        const config = await this.getConfig();
        if (config.boards.length === 0) { return; } // unconfigured — clean no-op
        if (config.silentSync) { return; } // opt-in: match start() semantics
        await this._poll();
        // Inbound-delete reconcile-sweep on the one-shot startup reconcile too, so
        // deletions accumulated while the machine was off are caught even when the
        // poll loop isn't started (e.g. the extension's startup reconcile).
        await this._reconcileSweep();
    }

    /** Stop pinging. Silent sync, when on, continues elsewhere; the ping loop stops here. */
    public stop(): void {
        this._active = false;
        if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
        this._log('Stopped.');
    }

    public dispose(): void {
        this.stop();
    }

    private _scheduleTimer(frequencySeconds: number): void {
        if (this._timer) { clearInterval(this._timer); }
        this._timer = setInterval(() => { void this._poll(); }, frequencySeconds * 1000);
    }

    // ── Poll cycle (provider-agnostic) ──────────────────────────────

    private async _poll(): Promise<void> {
        if (this._polling) { return; } // skip overlapping cycles
        this._polling = true;
        try {
            const db = this._deps.getDb();
            if (!db || !(await db.ensureReady())) { return; }

            const config = await this.getConfig();
            if (config.boards.length === 0) { return; }

            const provider = this._deps.getProvider(config.provider);
            if (!provider) { this._log(`No provider available for '${config.provider}'.`); return; }

            const workspaceId = await this._deps.getWorkspaceId();
            const boardSet = new Set(config.boards);
            const allPlans = await db.getAllPlans(workspaceId);
            const byRemoteId = this._indexByRemoteId(provider.kind, allPlans, boardSet);

            const refreshedThisCycle = new Set<string>();
            await this._pollState(db, provider, byRemoteId, refreshedThisCycle);
            await this._pollComments(db, provider, byRemoteId);
            await this._pollDescriptions(db, provider, byRemoteId, refreshedThisCycle);

            // Health: record successful poll.
            this._lastPollAt = new Date().toISOString();
            this._lastPollOk = true;
            this._lastPollError = null;
            this._consecutiveFailures = 0;

            // Inbound-delete reconcile-sweep cadence (provider-sync inbound-delete).
            // Runs every Nth poll cycle (N sized in start()) so a headless service
            // that boots once and runs for days still catches mid-run deletions.
            // The sweep is guarded like _polling — an overlapping sweep is skipped.
            this._pollsSinceSweep++;
            if (this._pollsSinceSweep >= this._sweepEveryN) {
                this._pollsSinceSweep = 0;
                // Fire-and-forget — the sweep must not block or crash the poll loop.
                void this._reconcileSweep().catch(sweepErr => {
                    this._log(`Reconcile sweep error: ${sweepErr instanceof Error ? sweepErr.message : String(sweepErr)}`);
                });
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._log(`Poll error: ${msg}`);
            // Health: record failed poll.
            this._lastPollAt = new Date().toISOString();
            this._lastPollOk = false;
            this._lastPollError = msg;
            this._consecutiveFailures++;
            // Detect rate-limit / backoff indicators in the error message.
            // NotionFetchService.httpRequest retries internally but may surface
            // a 429/529 after exhausting attempts; Linear graphqlRequest throws.
            const lower = msg.toLowerCase();
            if (lower.includes('429') || lower.includes('529') || lower.includes('rate limit') || lower.includes('retry-after')) {
                this._throttled = true;
                // Backoff window: 60s default (the internal retry already waited;
                // this just flags the UI until the next successful poll clears it).
                this._throttleUntil = new Date(Date.now() + 60000).toISOString();
            }
        } finally {
            this._polling = false;
        }
    }

    // ── Inbound-delete reconcile-sweep (provider-sync inbound-delete) ──
    //
    // Detects when a mapped remote card is deleted/archived in the tracker
    // (ClickUp/Linear/Notion) and tombstones the mapped local plan (recoverable,
    // opt-in default-off, never hard-delete, never unmapped). The
    // RemoteStateDelta seam has no deletion signal, so the mechanism is a
    // reconcile-sweep: paginate the live remote id set per provider and diff
    // against locally-mapped remoteIds. A mapped id absent from the live set is a
    // candidate deletion — confirmed via probeRemoteId (move-vs-delete
    // disambiguation) and the mid-create race guard before tombstoning.

    private async _reconcileSweep(): Promise<void> {
        if (this._sweeping) { return; } // skip overlapping sweeps
        if (!this._deps.getInboundDeleteEnabled) {
            // No opt-in resolver wired — safe default is no destructive action.
            return;
        }
        this._sweeping = true;
        try {
            const db = this._deps.getDb();
            if (!db || !(await db.ensureReady())) { return; }
            const workspaceId = await this._deps.getWorkspaceId();
            if (!workspaceId) { return; }
            const config = await this.getConfig();
            const boardSet = new Set(config.boards);
            const allPlans = await db.getAllPlans(workspaceId);

            // Sweep every provider that (a) can be built and (b) has inbound-delete
            // opted in. All three providers are swept independently and simultaneously
            // (no single-active restriction) — mirroring the outbound parity design.
            const kinds: RemoteProviderKind[] = ['linear', 'notion', 'clickup'];
            for (const kind of kinds) {
                try {
                    const enabled = await this._deps.getInboundDeleteEnabled(kind);
                    if (!enabled) { continue; }
                    const provider = this._deps.getProvider(kind);
                    if (!provider || !provider.reconcileLiveIds) { continue; }
                    await this._sweepProvider(db, provider, allPlans, boardSet, workspaceId);
                } catch (e) {
                    this._log(`Reconcile sweep for ${kind} failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        } finally {
            this._sweeping = false;
        }
    }

    private async _sweepProvider(
        db: KanbanDatabase,
        provider: RemoteProvider,
        allPlans: KanbanPlanRecord[],
        boardSet: Set<string>,
        workspaceId: string
    ): Promise<void> {
        if (!provider.reconcileLiveIds) { return; }
        const { complete, liveIds } = await provider.reconcileLiveIds();
        if (!complete) {
            // Partial sweep (rate-limit backoff mid-pagination) — MUST NOT tombstone
            // the un-fetched tail. Log and bail; the next sweep retries.
            this._log(`Reconcile sweep for ${provider.kind}: incomplete — no tombstones issued.`);
            return;
        }

        // Index locally-mapped plans by remoteId for this provider kind, filtered to
        // the selected boards (same shape as _indexByRemoteId, but we rebuild here so
        // the sweep is independent of the active poll provider).
        const mapped = new Map<string, KanbanPlanRecord>();
        for (const p of allPlans) {
            // Only ACTIVE plans are deletion candidates. Excluding archived/completed/
            // missing/deleted is load-bearing: AutoArchiveService archives the REMOTE card
            // of an auto-archived plan (status='archived', remoteId retained), which the
            // sweep would then see as "missing" and — for Linear/ClickUp, whose probe maps
            // archived→'deleted' — tombstone. That is our OWN outbound archive echoing back
            // as an inbound delete (archived→deleted), exactly the self-round-trip the poll
            // guards prevent. A 'missing' plan is already en route to the purge sweep. Only
            // a live plan whose remote genuinely vanished should tombstone.
            if (p.status !== 'active') { continue; }
            if (!boardSet.has(p.project || '')) { continue; }
            const rid = this._remoteIdOf(provider.kind, p);
            if (rid) { mapped.set(rid, p); }
        }

        const cutoff = Date.now() - RemoteControlService.MID_CREATE_GUARD_MS;
        for (const [remoteId, plan] of mapped) {
            if (liveIds.has(remoteId)) { continue; } // still live — no action
            // Mid-create race guard: skip if the id was persisted by an outbound
            // create within the guard window (the remote item exists but may not yet
            // be visible to a paginated query).
            const createdTs = this._recentlyCreatedRemoteIds.get(remoteId);
            if (createdTs) {
                const t = Date.parse(createdTs);
                if (isFinite(t) && t > cutoff) {
                    this._log(`Reconcile sweep for ${provider.kind}: skipping ${remoteId} — mid-create guard (persisted ${createdTs}).`);
                    continue;
                }
            }
            // Move-vs-delete disambiguation: re-check the id directly. A card moved
            // out of the queried scope looks identical to a deletion in a scoped
            // query; probeRemoteId distinguishes them. 'unknown' → safe skip.
            if (!provider.probeRemoteId) {
                this._log(`Reconcile sweep for ${provider.kind}: ${remoteId} missing but no probe — skipping (safe default).`);
                continue;
            }
            const status = await provider.probeRemoteId(remoteId);
            if (status !== 'deleted') {
                this._log(`Reconcile sweep for ${provider.kind}: ${remoteId} probe=${status} — skipping (not a confirmed deletion).`);
                continue;
            }
            // Confirmed deletion — tombstone the mapped local plan (recoverable,
            // never hard-delete, never git rm, never unmapped).
            try {
                const ok = await db.tombstonePlan(plan.planId);
                if (ok) {
                    this._log(`Reconcile sweep for ${provider.kind}: tombstoned plan ${plan.planId} (remote ${remoteId} deleted).`);
                } else {
                    this._log(`Reconcile sweep for ${provider.kind}: tombstonePlan returned false for ${plan.planId} (already tombstoned?).`);
                }
            } catch (e) {
                this._log(`Reconcile sweep for ${provider.kind}: tombstonePlan threw for ${plan.planId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    /** Map remoteId → local plan, filtered to the active provider's synced cards on a selected board. */
    private _indexByRemoteId(
        kind: RemoteProviderKind,
        allPlans: KanbanPlanRecord[],
        boardSet: Set<string>
    ): Map<string, KanbanPlanRecord> {
        const map = new Map<string, KanbanPlanRecord>();
        for (const p of allPlans) {
            if (p.status === 'deleted') { continue; }
            if (!boardSet.has(p.project || '')) { continue; }
            if (kind === 'linear') {
                if ((p.sourceType === 'linear-import' || p.sourceType === 'linear-automation') && p.linearIssueId) {
                    map.set(p.linearIssueId, p);
                }
            } else if (kind === 'notion') {
                // Notion: key on page-id presence (set by the one-time setup backup), NOT
                // sourceType. The common case is enabling Notion remote on an EXISTING board
                // whose plans are 'local'/etc; reclassifying them to 'notion-*' would clobber
                // their other links. notion-* source types still flow through normalization.
                if (p.notionPageId) {
                    map.set(p.notionPageId, p);
                }
            } else if (kind === 'clickup') {
                // ClickUp: state-pull + push. Index by clickupTaskId so inbound
                // list-move deltas resolve to the local plan for column mirroring.
                if (p.clickupTaskId) {
                    map.set(p.clickupTaskId, p);
                }
            }
        }
        return map;
    }

    private _remoteIdOf(kind: RemoteProviderKind, plan: KanbanPlanRecord): string {
        if (kind === 'linear') { return plan.linearIssueId || ''; }
        if (kind === 'notion') { return plan.notionPageId || ''; }
        if (kind === 'clickup') { return plan.clickupTaskId || ''; }
        return '';
    }

    // ── State stream (§9) ───────────────────────────────────────────

    private async _pollState(
        db: KanbanDatabase,
        provider: RemoteProvider,
        byRemoteId: Map<string, KanbanPlanRecord>,
        refreshedThisCycle: Set<string>
    ): Promise<void> {
        const key = stateCursorKey(provider.kind);
        const cursor = await db.getConfig(key);
        if (!cursor) {
            // Seed-on-first-poll: baseline to "now" and process nothing, so an
            // existing board's history isn't replayed as a burst of agent runs.
            await db.setConfig(key, new Date().toISOString());
            return;
        }

        const config = await this.getConfig();
        const { deltas, nextCursor } = await provider.fetchStateDeltas(cursor);
        for (const d of deltas) {
            let plan: KanbanPlanRecord | null | undefined = byRemoteId.get(d.remoteId);
            if (!plan) {
                // New remote item (a plan authored in Linear/Notion) with no local file →
                // import it as a new markdown plan, then treat it like any tracked card.
                // State import runs in BOTH ingest and full mode.
                plan = await provider.importRemotePlan(d.remoteId);
                if (!plan) { continue; }
                byRemoteId.set(d.remoteId, plan);
                this._log(`Imported new ${provider.kind} plan ${d.remoteId} → ${plan.planFile}.`);
            }
            // Mirror feature structure changes (parent/child links) BEFORE column dispatch so
            // that a column cascade on a feature reaches its now-linked subtasks.
            if (d.parentRemoteId !== undefined || d.isFeatureCandidate !== undefined) {
                await this._mirrorFeatureStructure(db, plan, d, byRemoteId);
            }
            const column = provider.stateKeyToColumn(d.stateKey);
            if (!column) { continue; }
            // In ingest mode, skip state mirror (column move + agent dispatch).
            // State import (above) still runs — the remote is a plan source.
            if (config.mode === 'ingest') { continue; }
            await this._applyStateMirror(provider, plan, column, refreshedThisCycle);
        }
        // Advance AFTER processing. State idempotency comes from the echo guard, so a
        // re-fetched (same-minute / inclusive-cursor) item simply no-ops.
        if (nextCursor && nextCursor !== cursor) {
            await db.setConfig(key, nextCursor);
        }
    }

    private async _applyStateMirror(
        provider: RemoteProvider,
        plan: KanbanPlanRecord,
        targetColumn: string,
        refreshedThisCycle: Set<string>
    ): Promise<void> {
        // The whole echo guard: never re-apply the column the card is already in. Our own
        // outbound push re-surfaces as a delta with the column we just set → no-op here.
        if (targetColumn === plan.kanbanColumn) { return; }

        const remoteId = this._remoteIdOf(provider.kind, plan);
        this._log(`State mirror: ${remoteId} → column ${targetColumn} (from ${plan.kanbanColumn}).`);
        try {
            // Pull the remote-authored body/description into the local plan BEFORE dispatch.
            await provider.refreshLocalPlanFromRemote(remoteId);
            // Track that this card was already refreshed so _pollDescriptions doesn't double-pull.
            refreshedThisCycle.add(remoteId);
            const { dispatched } = await this._deps.onColumnMove(plan, targetColumn);
            if (dispatched) {
                provider.postComment(
                    remoteId,
                    `Switchboard received this status change and dispatched the local agent for the **${targetColumn}** column. Check back in a few minutes.`
                ).catch(e => this._log(`Dispatch ack comment failed for ${plan.planId}: ${e instanceof Error ? e.message : String(e)}`));
            }
        } catch (e) {
            this._log(`onColumnMove failed for ${plan.planId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Mirror feature structure changes (parent/child links) detected by the provider's state
     * delta query. Runs BEFORE `_applyStateMirror` so that a column cascade on a feature
     * reaches its now-linked subtasks in the same poll cycle.
     *
     * Idempotent: only writes if the local state differs from the delta. The echo guard
     * for outbound sync (feature-sync-outbound) is the idempotency guard itself — if the
     * local plan is already linked to the same feature, no write occurs.
     */
    private async _mirrorFeatureStructure(
        db: KanbanDatabase,
        plan: KanbanPlanRecord,
        delta: RemoteStateDelta,
        byRemoteId: Map<string, KanbanPlanRecord>
    ): Promise<void> {
        // 1. If this card is a parent (isFeatureCandidate), ensure it's marked isFeature locally.
        if (delta.isFeatureCandidate === true && !plan.isFeature) {
            await db.updateFeatureStatus(plan.planId, 1, '');
            this._log(`Feature mirror: ${plan.planId} marked as feature (remote says it has children).`);
        }

        // 2. If this card's parent changed, link/unlink locally.
        if (delta.parentRemoteId !== undefined) {
            if (delta.parentRemoteId === '') {
                // Unparented remotely → unlink locally
                if (plan.featureId) {
                    await db.updateFeatureStatus(plan.planId, 0, '');
                    this._log(`Feature mirror: ${plan.planId} unlinked from feature ${plan.featureId}.`);
                }
            } else {
                // Parented remotely → find the parent's local plan by remote id
                const parentPlan = byRemoteId.get(delta.parentRemoteId);
                if (parentPlan && parentPlan.planId !== plan.planId) {
                    if (plan.featureId !== parentPlan.planId) {
                        await db.updateFeatureStatus(plan.planId, 0, parentPlan.planId);
                        this._log(`Feature mirror: ${plan.planId} linked to feature ${parentPlan.planId}.`);
                    }
                } else if (!parentPlan) {
                    // Parent isn't tracked locally — can't link. Log (don't fail).
                    this._log(`Feature mirror: parent ${delta.parentRemoteId} not tracked locally — cannot link ${plan.planId}.`);
                }
            }
        }
    }

    // ── Comment stream (§7) ─────────────────────────────────────────

    private async _pollComments(
        db: KanbanDatabase,
        provider: RemoteProvider,
        byRemoteId: Map<string, KanbanPlanRecord>
    ): Promise<void> {
        const config = await this.getConfig();
        if (!config.comments) { return; } // comment polling gated by config

        const key = commentCursorKey(provider.kind);
        const cursor = await db.getConfig(key);
        if (!cursor) {
            // Seed-on-first-poll. For existing Linear installs this also supersedes the old
            // per-card `remote.commentCursors` (we baseline to "now" — no history replay).
            await db.setConfig(key, new Date().toISOString());
            return;
        }

        const { deltas } = await provider.fetchCommentDeltas(cursor);
        if (deltas.length === 0) { return; }

        const seen = await this._loadSeen(provider.kind);
        const sorted = deltas.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        let advanced = cursor;

        for (const d of sorted) {
            // Self-authored, already-processed, or unroutable → mark handled + advance, but
            // never dispatch. (authoredBySelf prevents the feedback loop; the seen-set
            // prevents re-dispatch under Notion's inclusive minute-rounded cursor.)
            if (d.authoredBySelf || seen.has(d.commentId) || !byRemoteId.get(d.remoteId)) {
                if (!d.authoredBySelf && !seen.has(d.commentId) && !byRemoteId.get(d.remoteId)) {
                    this._log(`Comment ${d.commentId} targets an untracked card (${d.remoteId}) — skipped.`);
                }
                seen.add(d.commentId);
                if (d.createdAt > advanced) { advanced = d.createdAt; }
                continue;
            }

            const plan = byRemoteId.get(d.remoteId)!;
            try {
                await this._deps.onComment(plan, d.body);
                seen.add(d.commentId);
                if (d.createdAt > advanced) { advanced = d.createdAt; }
            } catch (e) {
                // Stop here; do NOT advance past the failed comment. The next poll re-fetches
                // from `advanced` and retries (at-least-once).
                this._log(`onComment failed for ${plan.planId} — cursor NOT advanced past ${d.commentId}: ${e instanceof Error ? e.message : String(e)}`);
                break;
            }
        }

        await this._saveSeen(provider.kind, seen);
        if (advanced !== cursor) { await db.setConfig(key, advanced); }
    }

    // ── Processed-comment-id set (DB config table) ──────────────────

    private async _loadSeen(kind: RemoteProviderKind): Promise<Set<string>> {
        const db = this._deps.getDb();
        if (!db) { return new Set(); }
        try {
            const raw = await db.getConfig(commentSeenKey(kind));
            const arr = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(arr) ? arr.map((s: unknown) => String(s)) : []);
        } catch {
            return new Set();
        }
    }

    private async _saveSeen(kind: RemoteProviderKind, seen: Set<string>): Promise<void> {
        const db = this._deps.getDb();
        if (!db) { return; }
        let arr = Array.from(seen);
        if (arr.length > COMMENT_SEEN_CAP) { arr = arr.slice(arr.length - COMMENT_SEEN_CAP); }
        await db.setConfig(commentSeenKey(kind), JSON.stringify(arr));
    }

    // ── Description stream (bidirectional content sync) ─────────────

    /**
     * Poll for description-only changes (content edits that don't change the column).
     * Uses a separate per-issue cursor (`remote.descriptionCursor.${kind}`) that only
     * advances after successful processing. Skips cards already refreshed by
     * `_applyStateMirror` in the same poll cycle (column+description changed together).
     *
     * Provider-agnostic. Two ways the body reaches the poller:
     *  - Inline: `d.description` is populated on the delta row (Linear, ClickUp).
     *  - Lazy:   `provider.fetchDescription(remoteId)` is called only for rows past
     *            their cursor AND not `selfEdited` (Notion — body via the Markdown API).
     *
     * Echo guards (per provider):
     *  - Linear:  byte-hash guard (`newHash === existingHash`) no-ops an own-push round-trip
     *             (Linear descriptions round-trip byte-identically).
     *  - Notion:  `d.selfEdited === true` (last_edited_by === botId) → advance cursor, write
     *             nothing. Lossy markdown round-trip is irrelevant because the bot's own push
     *             is invisible to the puller.
     *  - ClickUp: cursor-advance-on-push (ContinuousSyncService calls `_onDescriptionSynced`
     *             with the actual post-push `date_updated`). The byte guard is unreliable
     *             here (ClickUp normalizes markdown on write), so the cursor advance is the
     *             primary mitigation; a residual one-time reformat is accepted.
     *
     * First-enable safety: when the raw `remote.descriptionCursor.${kind}` key is absent
     * (null/empty), baseline every current row's cursor to its `updatedAt` (or "now") and
     * pull nothing this cycle. This prevents a mass-overwrite of local plans the first time
     * content-polling turns on for an existing remote. The raw-key null-check (not the
     * parsed-JSON default) is what distinguishes "never set" from "set but empty map".
     */
    private async _pollDescriptions(
        db: KanbanDatabase,
        provider: RemoteProvider,
        byRemoteId: Map<string, KanbanPlanRecord>,
        refreshedThisCycle: Set<string>
    ): Promise<void> {
        if (!this._deps.getDescriptionCursors || !this._deps.setDescriptionCursor) { return; }

        const config = await this.getConfig();
        if (!config.content) { return; } // content polling gated by config

        const key = `remote.descriptionCursor.${provider.kind}`;

        // Seed-on-first-poll: distinguish "no key" from "empty map" via the raw config value.
        // _getDescriptionCursors returns {} for both; only the raw read tells them apart.
        const rawCursorBlob = await db.getConfig(key);
        if (!rawCursorBlob) {
            // First-enable: baseline every tracked card's cursor to its current updatedAt (or
            // "now" when the provider didn't supply one) and pull nothing this cycle.
            const stateCursor = await db.getConfig(stateCursorKey(provider.kind));
            const { deltas } = stateCursor
                ? await provider.fetchStateDeltas(stateCursor)
                : { deltas: [] };
            const seed: Record<string, string> = {};
            const nowIso = new Date().toISOString();
            for (const d of deltas) {
                if (!d.remoteId) { continue; }
                seed[d.remoteId] = d.updatedAt || nowIso;
            }
            await db.setConfig(key, JSON.stringify(seed));
            this._log(`First-enable: seeded ${Object.keys(seed).length} description cursor(s) for ${provider.kind}; no pulls this cycle.`);
            return;
        }

        const cursors = await this._deps.getDescriptionCursors(provider.kind);
        const resolver = this._deps.contentConflictResolver || new LastWriteWinsResolver();

        // Re-fetch state deltas to get description data (same query, includes description).
        // The state cursor is used as the "since" timestamp — this is acceptable because
        // description changes bump updatedAt, which is the same field the state cursor tracks.
        const stateCursor = await db.getConfig(stateCursorKey(provider.kind));
        if (!stateCursor) { return; }

        const { deltas } = await provider.fetchStateDeltas(stateCursor);
        let cursorsChanged = false;

        for (const d of deltas) {
            if (!d.description && !d.updatedAt && !provider.fetchDescription) { continue; }
            if (refreshedThisCycle.has(d.remoteId)) { continue; } // already refreshed by state mirror

            const plan = byRemoteId.get(d.remoteId);
            if (!plan) { continue; }

            const cursor = cursors[d.remoteId] || '';
            if (!d.updatedAt || d.updatedAt <= cursor) { continue; } // already synced

            // Notion semantic echo guard: the bot's own push set last_edited_by = botId.
            // Advance the cursor without writing — the markdown round-trip is irrelevant.
            if (d.selfEdited === true) {
                cursors[d.remoteId] = d.updatedAt;
                cursorsChanged = true;
                continue;
            }

            // Resolve the pulled body: inline (Linear/ClickUp) or lazy (Notion Markdown API).
            let pulledBody = d.description || '';
            let pulledUpdatedAt = d.updatedAt;
            if (!pulledBody && provider.fetchDescription) {
                try {
                    const fetched = await provider.fetchDescription(d.remoteId);
                    if (!fetched || !fetched.body || !fetched.body.trim()) {
                        // Empty/missing body — never clobber, but advance cursor so we don't
                        // re-fetch every poll. The empty-body guard below also covers this.
                        cursors[d.remoteId] = d.updatedAt;
                        cursorsChanged = true;
                        continue;
                    }
                    pulledBody = fetched.body;
                    if (fetched.updatedAt) { pulledUpdatedAt = fetched.updatedAt; }
                } catch (e) {
                    this._log(`fetchDescription failed for ${d.remoteId}: ${e instanceof Error ? e.message : String(e)} — cursor NOT advanced.`);
                    continue;
                }
            }

            if (!pulledBody.trim()) { continue; } // never clobber with empty

            // Large description guard (matches maxContentSizeBytes in LiveSyncTypes)
            if (pulledBody.length > 102400) { continue; }

            // Conflict-resolver seam: decide whether the remote body should overwrite local.
            const workspaceRoot = this._deps.getWorkspaceRoot?.() || '';
            const planPath = path.isAbsolute(plan.planFile)
                ? plan.planFile
                : path.join(workspaceRoot, plan.planFile);
            let existingContent = '';
            try { existingContent = await fs.promises.readFile(planPath, 'utf8'); } catch { /* ok */ }

            if (!resolver.shouldPull(pulledUpdatedAt, cursor, pulledBody, existingContent)) {
                // Resolver says skip — advance cursor, write nothing.
                cursors[d.remoteId] = pulledUpdatedAt;
                cursorsChanged = true;
                continue;
            }

            // Reconstruct full file content: preserve existing H1 title + pulled body.
            // Linear/ClickUp descriptions don't include the H1 — it was stripped before push.
            const h1Match = existingContent.match(/^# .+\n?/);
            const h1Line = h1Match ? h1Match[0] : `# ${plan.topic || 'Untitled'}\n`;
            const newContent = h1Line + '\n' + pulledBody;

            // Hash-based conflict check: if local content already matches what we'd write, skip.
            // This is the Linear echo guard (byte-identical round-trip). For ClickUp it's a
            // second line behind cursor-advance-on-push; for Notion the selfEdited guard
            // already handled the echo case above.
            const newHash = crypto.createHash('sha256').update(newContent).digest('hex');
            const existingHash = crypto.createHash('sha256').update(existingContent).digest('hex');
            if (newHash === existingHash) {
                // Already in sync — just advance cursor
                cursors[d.remoteId] = pulledUpdatedAt;
                cursorsChanged = true;
                continue;
            }

            // PULL: write new content to plan file.
            // Register hash BEFORE write so loop prevention is active when watcher fires.
            if (this._deps.onDescriptionPulled) {
                this._deps.onDescriptionPulled(d.remoteId, newHash);
            }
            try {
                await fs.promises.writeFile(planPath, newContent, 'utf8');
                cursors[d.remoteId] = pulledUpdatedAt;
                cursorsChanged = true;
                this._log(`Pulled description for ${d.remoteId} → ${plan.planFile}.`);
            } catch (e) {
                this._log(`Failed to pull description for ${d.remoteId}: ${e instanceof Error ? e.message : String(e)}`);
                // Don't advance cursor — retry on next poll
            }
        }

        if (cursorsChanged) {
            // Persist the whole cursors map to the DB config table.
            await db.setConfig(key, JSON.stringify(cursors));
        }
    }
}
