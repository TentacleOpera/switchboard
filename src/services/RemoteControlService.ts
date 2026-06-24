import type { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';
import type { LinearSyncService } from './LinearSyncService';
import { hasMarker } from './commentMarker';

/**
 * §7/§9/§10 — Remote Control (Linear only).
 *
 * Polls Linear on a timer (no webhooks) for the user's selected boards and:
 *  - mirrors Linear state changes onto the Kanban column, dispatching that column's
 *    agent the same way a manual drag would (§9);
 *  - ingests new issue comments and routes them to the current column's agent (§7).
 *
 * The two loop-closing mechanisms create cycles, so guards are load-bearing:
 *  - self-comment marker (commentMarker): outbound comments are skipped on ingest;
 *  - state echo guard: a state that maps to the card's *current* column is never
 *    re-applied (covers the local-drag → outbound-push → inbound-echo loop), plus a
 *    short-TTL per-card guard for the window before the DB reflects an applied move;
 *  - per-card sequential queue: comments for one card never run two agents at once;
 *  - the comment cursor is advanced only AFTER dispatch, so an extension reload mid-
 *    dispatch re-fetches the comment on the next poll (delayed, not lost).
 */

export interface RemoteConfig {
    /** Project board names that participate in Linear sync/ping. */
    boards: string[];
    /** Stay synced with Linear even while pinging is off. */
    silentSync: boolean;
    /** Constant = always pinging; Manual = only while the toolbar toggle is on. */
    pingMode: 'constant' | 'manual';
    /** Poll cadence, 30–120s. */
    pingFrequencySeconds: number;
}

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
    boards: [],
    silentSync: false,
    pingMode: 'manual',
    pingFrequencySeconds: 60
};

const REMOTE_CONFIG_KEY = 'remote.config';
const COMMENT_CURSORS_KEY = 'remote.commentCursors';
const PER_POLL_CARD_CAP = 100;
const ECHO_GUARD_TTL_MS = 5 * 60 * 1000;

interface RemoteControlDeps {
    getDb: () => KanbanDatabase | null;
    getWorkspaceId: () => Promise<string>;
    getLinearService: () => LinearSyncService | null;
    /** Apply a Linear-driven column move + dispatch the destination column's agent (§9). */
    onColumnMove: (plan: KanbanPlanRecord, targetColumn: string) => Promise<void>;
    /** Route an inbound comment to the card's current column agent (§7). */
    onComment: (plan: KanbanPlanRecord, commentBody: string) => Promise<void>;
    log?: (msg: string) => void;
}

export class RemoteControlService {
    private _deps: RemoteControlDeps;
    private _timer?: NodeJS.Timeout;
    private _polling = false;
    private _active = false;
    private _echoGuards = new Map<string, { lastAppliedState: string; ts: number }>();
    /** Per-card promise chain — serializes comment processing for a single plan. */
    private _queues = new Map<string, Promise<void>>();

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
        this._log(`Started (mode=${config.pingMode}, every ${config.pingFrequencySeconds}s, ${config.boards.length} board(s)).`);
    }

    /** Stop pinging. Silent sync, when on, continues elsewhere; the ping loop stops here. */
    public stop(): void {
        this._active = false;
        if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
        this._log('Stopped.');
    }

    public dispose(): void {
        this.stop();
        this._echoGuards.clear();
        this._queues.clear();
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

    // ── Poll cycle ──────────────────────────────────────────────────

    private async _poll(): Promise<void> {
        if (this._polling) { return; } // skip overlapping cycles
        this._polling = true;
        try {
            const db = this._deps.getDb();
            const linear = this._deps.getLinearService();
            if (!db || !linear || !(await db.ensureReady())) { return; }

            const config = await this.getConfig();
            if (config.boards.length === 0) { return; }

            const workspaceId = await this._deps.getWorkspaceId();
            const boardSet = new Set(config.boards);
            const allPlans = await db.getAllPlans(workspaceId);

            const synced = allPlans.filter((p) =>
                (p.sourceType === 'linear-import' || p.sourceType === 'linear-automation')
                && !!p.linearIssueId
                && p.status !== 'deleted'
                && boardSet.has(p.project || '')
            );

            // Per-poll card cap — defer the rest (most-recently-updated first) to next cycle.
            const ordered = synced.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
            const batch = ordered.slice(0, PER_POLL_CARD_CAP);
            if (ordered.length > PER_POLL_CARD_CAP) {
                this._log(`Card cap: polling ${PER_POLL_CARD_CAP} of ${ordered.length}; remainder deferred to next cycle.`);
            }
            if (batch.length === 0) { return; }

            const linearConfig = await linear.loadConfig();
            const stateIdToColumn = this._reverseStateMap(linearConfig?.columnToStateId || {});

            const updates = await linear.fetchIssueUpdates(
                batch.map((p) => p.linearIssueId).filter((id): id is string => !!id)
            );
            const cursors = await this._loadCursors();

            for (const plan of batch) {
                if (!plan.linearIssueId) { continue; }
                const upd = updates[plan.linearIssueId];
                if (!upd) { continue; }

                // §9 — state → column mirror.
                await this._applyStateMirror(plan, upd.stateId, stateIdToColumn);

                // §7 — inbound comment ingestion.
                await this._ingestComments(plan, upd.comments, cursors);
            }
        } catch (e) {
            this._log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this._polling = false;
        }
    }

    private _reverseStateMap(columnToStateId: Record<string, string>): Record<string, string> {
        const reversed: Record<string, string> = {};
        for (const [column, stateId] of Object.entries(columnToStateId || {})) {
            if (stateId) { reversed[stateId] = column; }
        }
        return reversed;
    }

    private async _applyStateMirror(
        plan: KanbanPlanRecord,
        stateId: string,
        stateIdToColumn: Record<string, string>
    ): Promise<void> {
        if (!stateId) { return; }
        const targetColumn = stateIdToColumn[stateId];
        if (!targetColumn) { return; }
        // Column-equality is the primary echo guard: a state that maps to the card's
        // current column (e.g. one we just pushed via a local drag) is a no-op.
        if (targetColumn === plan.kanbanColumn) { return; }

        const now = Date.now();
        const guard = this._echoGuards.get(plan.planId);
        if (guard && guard.lastAppliedState === stateId && (now - guard.ts) < ECHO_GUARD_TTL_MS) {
            return; // already applied this state moments ago; wait for DB to settle
        }

        this._echoGuards.set(plan.planId, { lastAppliedState: stateId, ts: now });
        this._log(`State mirror: ${plan.linearIssueId} → column ${targetColumn} (from ${plan.kanbanColumn}).`);
        try {
            await this._deps.onColumnMove(plan, targetColumn);
        } catch (e) {
            this._log(`onColumnMove failed for ${plan.planId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async _ingestComments(
        plan: KanbanPlanRecord,
        comments: Array<{ id: string; body: string; createdAt: string; author: string }>,
        cursors: Record<string, string>
    ): Promise<void> {
        const linearIssueId = plan.linearIssueId;
        if (!linearIssueId) { return; }
        const cursor = cursors[linearIssueId] || '';
        // First encounter (no cursor): seed the baseline to the latest existing comment
        // WITHOUT dispatching. Otherwise the whole comment history of an existing issue is
        // replayed as agent runs the instant remote control starts — exactly the runaway
        // dispatch the plan's Adversarial Synthesis warns about. Only comments posted after
        // remote control starts (i.e. after this baseline) are acted on. Reload-safe: the
        // cursor persists in the DB config table, so this seeding happens once per card.
        if (!cursor) {
            const latest = comments.reduce((max, c) => (c.createdAt && c.createdAt > max ? c.createdAt : max), '');
            if (latest) { await this._advanceCursor(linearIssueId, latest); }
            return;
        }
        // New = created after the cursor AND not authored by Switchboard (marker).
        const fresh = comments
            .filter((c) => c.createdAt && (!cursor || c.createdAt > cursor) && !hasMarker(c.body))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (fresh.length === 0) { return; }

        // Enqueue per-card so rapid-fire comments serialize on one plan.
        const prior = this._queues.get(plan.planId) || Promise.resolve();
        const next = prior.then(async () => {
            for (const comment of fresh) {
                try {
                    await this._deps.onComment(plan, comment.body);
                    // Advance cursor only AFTER dispatch completes (reload-safe).
                    await this._advanceCursor(linearIssueId, comment.createdAt);
                } catch (e) {
                    this._log(`onComment failed for ${plan.planId} — cursor NOT advanced: ${e instanceof Error ? e.message : String(e)}`);
                    break; // stop; the next poll re-fetches from the un-advanced cursor
                }
            }
        }).catch(() => { /* isolate queue failures */ });
        this._queues.set(plan.planId, next);
    }

    // ── Comment cursors (DB config table) ───────────────────────────

    private async _loadCursors(): Promise<Record<string, string>> {
        const db = this._deps.getDb();
        if (!db) { return {}; }
        try {
            const raw = await db.getConfig(COMMENT_CURSORS_KEY);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch {
            return {};
        }
    }

    private async _advanceCursor(issueId: string, createdAt: string): Promise<void> {
        const db = this._deps.getDb();
        if (!db) { return; }
        const cursors = await this._loadCursors();
        const existing = cursors[issueId] || '';
        if (!existing || createdAt > existing) {
            cursors[issueId] = createdAt;
            await db.setConfig(COMMENT_CURSORS_KEY, JSON.stringify(cursors));
        }
    }
}
