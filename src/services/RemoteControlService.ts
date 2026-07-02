import type { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';
import type { RemoteProvider } from './remote/RemoteProvider';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

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
}

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
    provider: 'linear',
    boards: [],
    silentSync: false,
    pingFrequencySeconds: 60,
    mode: 'ingest',
    push: false,
    comments: true
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
    /** Persisted description-sync cursors per issue (issueId → ISO timestamp). */
    getDescriptionCursors?: (kind: RemoteProviderKind) => Promise<Record<string, string>>;
    /** Persist a description-sync cursor for an issue. */
    setDescriptionCursor?: (kind: RemoteProviderKind, issueId: string, timestamp: string) => Promise<void>;
    /** Called after a description is pulled and written to disk. Registers the content hash for loop prevention. */
    onDescriptionPulled?: (issueId: string, contentHash: string) => void;
    /** Resolve the workspace root for file path operations (plan files). */
    getWorkspaceRoot?: () => string;
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
                provider: (parsed.provider === 'notion' || parsed.provider === 'clickup') ? parsed.provider : 'linear',
                boards: this._normalizeBoards(parsed.boards),
                silentSync: parsed.silentSync === true,
                pingFrequencySeconds: this._clampFrequency(parsed.pingFrequencySeconds),
                mode: parsed.mode === 'full' ? 'full' : 'ingest',
                push: parsed.push === true,
                comments: parsed.comments !== false, // default true
            };
        } catch {
            return { ...DEFAULT_REMOTE_CONFIG };
        }
    }

    public async setConfig(config: RemoteConfig): Promise<void> {
        const db = this._deps.getDb();
        if (!db || !(await db.ensureReady())) { return; }
        const normalized: RemoteConfig = {
            provider: (config.provider === 'notion' || config.provider === 'clickup') ? config.provider : 'linear',
            boards: this._normalizeBoards(config.boards),
            silentSync: config.silentSync === true,
            pingFrequencySeconds: this._clampFrequency(config.pingFrequencySeconds),
            mode: config.mode === 'full' ? 'full' : 'ingest',
            push: config.push === true,
            comments: config.comments !== false,
        };
        await db.setConfig(REMOTE_CONFIG_KEY, JSON.stringify(normalized));
        if (this._active) {
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

    /** Start pinging. If silentSync is off, run a reconciling sync first. */
    public async start(): Promise<void> {
        const config = await this.getConfig();
        if (config.boards.length === 0) {
            this._log('No boards selected — not starting.');
            return;
        }
        if (!config.silentSync) {
            this._log('Silent sync off — running a reconciling poll before starting loop.');
            await this._poll(); // one-time reconcile before the loop
        }
        this._active = true;
        this._scheduleTimer(config.pingFrequencySeconds);
        this._log(`Started (provider=${config.provider}, every ${config.pingFrequencySeconds}s, ${config.boards.length} board(s)).`);
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
            } else if (kind === 'notion') {
                // Notion: key on page-id presence (set by the one-time setup backup), NOT
                // sourceType. The common case is enabling Notion remote on an EXISTING board
                // whose plans are 'local'/etc; reclassifying them to 'notion-*' would clobber
                // their other links. notion-* source types still flow through normalization.
                if (p.notionPageId) {
                    map.set(p.notionPageId, p);
                }
            } else if (kind === 'clickup') {
                // ClickUp: push-only, but index by clickupTaskId for completeness.
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
            // Seed-on-first-poll: baseline to "now" and process nothing, so an existing
            // board's history isn't replayed as a burst of agent runs.
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
     * Only Linear is supported — Notion description pull is deferred. The provider's
     * `fetchStateDeltas` must populate `description` and `updatedAt` on the deltas.
     */
    private async _pollDescriptions(
        db: KanbanDatabase,
        provider: RemoteProvider,
        byRemoteId: Map<string, KanbanPlanRecord>,
        refreshedThisCycle: Set<string>
    ): Promise<void> {
        if (!this._deps.getDescriptionCursors || !this._deps.setDescriptionCursor) { return; }
        if (provider.kind !== 'linear') { return; } // Linear-only for now

        const key = `remote.descriptionCursor.${provider.kind}`;
        const cursors = await this._deps.getDescriptionCursors(provider.kind);

        // Re-fetch state deltas to get description data (same query, includes description).
        // The state cursor is used as the "since" timestamp — this is acceptable because
        // description changes bump updatedAt, which is the same field the state cursor tracks.
        const stateCursor = await db.getConfig(stateCursorKey(provider.kind));
        if (!stateCursor) { return; }

        const { deltas } = await provider.fetchStateDeltas(stateCursor);
        let cursorsChanged = false;

        for (const d of deltas) {
            if (!d.description && !d.updatedAt) { continue; }
            if (refreshedThisCycle.has(d.remoteId)) { continue; } // already refreshed by state mirror

            const plan = byRemoteId.get(d.remoteId);
            if (!plan) { continue; }

            const cursor = cursors[d.remoteId] || '';
            if (!d.updatedAt || d.updatedAt <= cursor) { continue; } // already synced

            const pulledBody = d.description || '';
            if (!pulledBody.trim()) { continue; } // never clobber with empty

            // Large description guard (matches maxContentSizeBytes in LiveSyncTypes)
            if (pulledBody.length > 102400) { continue; }

            // Reconstruct full file content: preserve existing H1 title + pulled body.
            // Linear description doesn't include the H1 — it was stripped before push.
            const workspaceRoot = this._deps.getWorkspaceRoot?.() || '';
            const planPath = path.isAbsolute(plan.planFile)
                ? plan.planFile
                : path.join(workspaceRoot, plan.planFile);
            let existingContent = '';
            try { existingContent = await fs.promises.readFile(planPath, 'utf8'); } catch { /* ok */ }

            // Extract existing H1 title line
            const h1Match = existingContent.match(/^# .+\n?/);
            const h1Line = h1Match ? h1Match[0] : `# ${plan.topic || 'Untitled'}\n`;
            const newContent = h1Line + '\n' + pulledBody;

            // Hash-based conflict check: if local content already matches what we'd write, skip
            const newHash = crypto.createHash('sha256').update(newContent).digest('hex');
            const existingHash = crypto.createHash('sha256').update(existingContent).digest('hex');
            if (newHash === existingHash) {
                // Already in sync — just advance cursor
                cursors[d.remoteId] = d.updatedAt;
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
                cursors[d.remoteId] = d.updatedAt;
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
