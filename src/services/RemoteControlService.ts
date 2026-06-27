import type { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';
import type { RemoteProvider } from './remote/RemoteProvider';

/**
 * §7/§9/§10 — Remote Control (provider-agnostic: Linear or Notion).
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
 *    just no-ops here. That single equality check is the whole guard.
 *  - authoredBySelf: outbound comments (Linear marker / Notion `created_by` = bot) are
 *    skipped on ingest;
 *  - processed-comment-id set: this is Notion-API hygiene, not race defense — Notion rounds
 *    `created_time` to the minute and only supports an inclusive filter, so the boundary
 *    minute's comments re-appear each poll; the seen-set de-dups them;
 *  - the comment cursor advances only AFTER dispatch, so a reload mid-dispatch re-fetches
 *    on the next poll (delayed, not lost).
 */

export type RemoteProviderKind = 'linear' | 'notion';

export interface RemoteConfig {
    /** Which remote backend drives the board. One active at a time (no hot-swap). */
    provider: RemoteProviderKind;
    /** Project board names that participate in sync/ping. */
    boards: string[];
    /** Stay synced with the provider even while pinging is off. */
    silentSync: boolean;
    /** Constant = always pinging; Manual = only while the toolbar toggle is on. */
    pingMode: 'constant' | 'manual';
    /** Poll cadence, 30–120s. */
    pingFrequencySeconds: number;
}

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
    provider: 'linear',
    boards: [],
    silentSync: false,
    pingMode: 'manual',
    pingFrequencySeconds: 60
};

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
    log?: (msg: string) => void;
}

export class RemoteControlService {
    private _deps: RemoteControlDeps;
    private _timer?: NodeJS.Timeout;
    private _polling = false;
    private _active = false;

    constructor(deps: RemoteControlDeps) {
        this._deps = deps;
    }

    public get isActive(): boolean { return this._active; }

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
                provider: parsed.provider === 'notion' ? 'notion' : 'linear',
                boards: this._normalizeBoards(parsed.boards),
                silentSync: parsed.silentSync === true,
                pingMode: parsed.pingMode === 'constant' ? 'constant' : 'manual',
                pingFrequencySeconds: this._clampFrequency(parsed.pingFrequencySeconds)
            };
        } catch {
            return { ...DEFAULT_REMOTE_CONFIG };
        }
    }

    public async setConfig(config: RemoteConfig): Promise<void> {
        const db = this._deps.getDb();
        if (!db || !(await db.ensureReady())) { return; }
        const normalized: RemoteConfig = {
            provider: config.provider === 'notion' ? 'notion' : 'linear',
            boards: this._normalizeBoards(config.boards),
            silentSync: config.silentSync === true,
            pingMode: config.pingMode === 'constant' ? 'constant' : 'manual',
            pingFrequencySeconds: this._clampFrequency(config.pingFrequencySeconds)
        };
        await db.setConfig(REMOTE_CONFIG_KEY, JSON.stringify(normalized));
        // Constant mode keeps the ping loop running whenever configured.
        if (normalized.pingMode === 'constant' && normalized.boards.length > 0) {
            await this.start();
        } else if (normalized.pingMode === 'manual' && this._active) {
            // Restart the timer with the new cadence.
            this._scheduleTimer(normalized.pingFrequencySeconds);
        }
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

    /** Start pinging. In Manual mode with silentSync off, run a reconciling sync first. */
    public async start(): Promise<void> {
        const config = await this.getConfig();
        if (config.boards.length === 0) {
            this._log('No boards selected — not starting.');
            return;
        }
        if (config.pingMode === 'manual' && !config.silentSync) {
            this._log('Manual start with silent-sync off — running a reconciling poll first.');
            await this._poll(); // one-time reconcile before the loop
        }
        this._active = true;
        this._scheduleTimer(config.pingFrequencySeconds);
        this._log(`Started (provider=${config.provider}, mode=${config.pingMode}, every ${config.pingFrequencySeconds}s, ${config.boards.length} board(s)).`);
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

    /** Apply ping state on startup based on persisted config (Constant auto-starts). */
    public async restoreFromConfig(): Promise<void> {
        const config = await this.getConfig();
        if (config.pingMode === 'constant' && config.boards.length > 0) {
            await this.start();
        }
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

            await this._pollState(db, provider, byRemoteId);
            await this._pollComments(db, provider, byRemoteId);
        } catch (e) {
            this._log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this._polling = false;
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
            } else {
                // Notion: key on page-id presence (set by the one-time setup backup), NOT
                // sourceType. The common case is enabling Notion remote on an EXISTING board
                // whose plans are 'local'/etc; reclassifying them to 'notion-*' would clobber
                // their other links. notion-* source types still flow through normalization.
                if (p.notionPageId) {
                    map.set(p.notionPageId, p);
                }
            }
        }
        return map;
    }

    private _remoteIdOf(kind: RemoteProviderKind, plan: KanbanPlanRecord): string {
        return (kind === 'linear' ? plan.linearIssueId : plan.notionPageId) || '';
    }

    // ── State stream (§9) ───────────────────────────────────────────

    private async _pollState(
        db: KanbanDatabase,
        provider: RemoteProvider,
        byRemoteId: Map<string, KanbanPlanRecord>
    ): Promise<void> {
        const key = stateCursorKey(provider.kind);
        const cursor = await db.getConfig(key);
        if (!cursor) {
            // Seed-on-first-poll: baseline to "now" and process nothing, so an existing
            // board's history isn't replayed as a burst of agent runs.
            await db.setConfig(key, new Date().toISOString());
            return;
        }

        const { deltas, nextCursor } = await provider.fetchStateDeltas(cursor);
        for (const d of deltas) {
            let plan: KanbanPlanRecord | null | undefined = byRemoteId.get(d.remoteId);
            if (!plan) {
                // New remote item (a plan authored in Linear/Notion) with no local file →
                // import it as a new markdown plan, then treat it like any tracked card.
                plan = await provider.importRemotePlan(d.remoteId);
                if (!plan) { continue; }
                byRemoteId.set(d.remoteId, plan);
                this._log(`Imported new ${provider.kind} plan ${d.remoteId} → ${plan.planFile}.`);
            }
            const column = provider.stateKeyToColumn(d.stateKey);
            if (!column) { continue; }
            await this._applyStateMirror(provider, plan, column);
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
        targetColumn: string
    ): Promise<void> {
        // The whole echo guard: never re-apply the column the card is already in. Our own
        // outbound push re-surfaces as a delta with the column we just set → no-op here.
        if (targetColumn === plan.kanbanColumn) { return; }

        const remoteId = this._remoteIdOf(provider.kind, plan);
        this._log(`State mirror: ${remoteId} → column ${targetColumn} (from ${plan.kanbanColumn}).`);
        try {
            // Pull the remote-authored body/description into the local plan BEFORE dispatch.
            await provider.refreshLocalPlanFromRemote(remoteId);
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

    // ── Comment stream (§7) ─────────────────────────────────────────

    private async _pollComments(
        db: KanbanDatabase,
        provider: RemoteProvider,
        byRemoteId: Map<string, KanbanPlanRecord>
    ): Promise<void> {
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
}
