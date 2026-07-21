import * as fs from 'fs';
import type { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';
import type { NotionFetchService } from '../NotionFetchService';
import type {
    RemoteProvider, RemoteStateDelta, RemoteCommentDelta,
    RemoteProviderCapabilities, ArchiveResult
} from './RemoteProvider';
import { loadNotionRemoteSetup, saveNotionRemoteSetup, type NotionRemoteSetup } from './notionRemoteConfig';
import { importRemoteMarkdownPlan } from './importRemotePlan';
import { guardedWritePageBody } from './notionOverwriteGuard';

/**
 * Notion backend for Remote Control delta polling (D2/D3/D4/D7).
 *
 * State deltas come from the plans DB filtered by `last_edited_time`; comment deltas come
 * from a dedicated "Switchboard Comments" DB filtered by `created_time` (a native page
 * comment does NOT bump `last_edited_time`, so a plans-DB query would miss it — see
 * docs/technical_platform_integration_analysis.md, Finding 4).
 *
 * Two research-confirmed Notion quirks shape this:
 *  - Timestamp filters must use `{ timestamp: "...", "...": { on_or_after } }` with NO
 *    `"property"` field, or the API 400s. `on_or_after` is INCLUSIVE.
 *  - `created_time` / `last_edited_time` round DOWN to the minute, so same-minute items
 *    can't be ordered. The inclusive cursor re-fetches them; RemoteControlService's echo
 *    guard (state) and processed-id set (comments) no-op the duplicates.
 */

interface NotionRemoteProviderDeps {
    notion: NotionFetchService;
    db: KanbanDatabase;
    getWorkspaceId: () => Promise<string>;
    getPlansDir?: () => Promise<string>;
    log?: (msg: string) => void;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 5;          // safety backstop: ≤ 500 changed rows per poll
const LIMITER_MS = 350;       // Notion ~3 req/sec

export class NotionRemoteProvider implements RemoteProvider {
    public readonly kind = 'notion' as const;
    public readonly capabilities: RemoteProviderCapabilities = { pull: true, push: true, archive: true };
    private _deps: NotionRemoteProviderDeps;
    private _setup: NotionRemoteSetup | null = null;
    private _botId = '';

    constructor(deps: NotionRemoteProviderDeps) {
        this._deps = deps;
    }

    private _log(msg: string): void {
        (this._deps.log || (() => { /* noop */ }))(`[NotionRemoteProvider] ${msg}`);
    }

    private _delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async _ensureSetup(): Promise<NotionRemoteSetup | null> {
        if (this._setup) { return this._setup; }
        this._setup = await loadNotionRemoteSetup(this._deps.db);
        return this._setup;
    }

    /** Page through a database delta query (inclusive timestamp filter, ascending). */
    private async _queryDelta(databaseId: string, timestamp: 'last_edited_time' | 'created_time', cursor: string): Promise<any[]> {
        const pages: any[] = [];
        let startCursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const body: Record<string, unknown> = {
                filter: { timestamp, [timestamp]: { on_or_after: cursor } },
                sorts: [{ timestamp, direction: 'ascending' }],
                page_size: PAGE_SIZE,
            };
            if (startCursor) { body.start_cursor = startCursor; }
            const result = await this._deps.notion.httpRequest('POST', `/databases/${databaseId}/query`, body, 15000);
            if (result.status !== 200) {
                this._log(`Delta query (${timestamp}) failed: HTTP ${result.status} ${JSON.stringify(result.data)?.slice(0, 200)}`);
                break;
            }
            pages.push(...(result.data?.results || []));
            if (!result.data?.has_more) { break; }
            startCursor = result.data?.next_cursor || undefined;
            if (!startCursor) { break; }
            await this._delay(LIMITER_MS);
        }
        return pages;
    }

    public async fetchStateDeltas(sinceCursor: string): Promise<{ deltas: RemoteStateDelta[]; nextCursor: string }> {
        const setup = await this._ensureSetup();
        if (!setup?.plansDatabaseId) { return { deltas: [], nextCursor: sinceCursor }; }

        // Resolve the bot id (drives selfEdited echo guard for content-pull). Hoisted from
        // fetchCommentDeltas so the state stream can also use it. Fail SAFE: if it can't be
        // resolved, selfEdited is left undefined (the byte-hash guard + cursor-advance still
        // defend against echoes, just less precisely for Notion's lossy markdown round-trip).
        const botId = setup.botId || this._botId || (await this._deps.notion.getBotId()) || '';
        if (botId) { this._botId = botId; }

        const rows = await this._queryDelta(setup.plansDatabaseId, 'last_edited_time', sinceCursor);
        const deltas: RemoteStateDelta[] = [];
        let nextCursor = sinceCursor;
        for (const row of rows) {
            const remoteId = String(row.id || '');
            const stateKey = String(row.properties?.['Kanban Column']?.select?.name || '').trim();
            const lastEditedTime = String(row.last_edited_time || '');
            // selfEdited echo guard: Notion API returns `last_edited_by` directly on
            // database-query page objects (research-confirmed — no extra call). When the
            // bot's own push bumped last_edited_time, last_edited_by.id === botId → skip
            // the pull (advance cursor, write nothing) regardless of markdown round-trip.
            const lastEditedById = String(row.last_edited_by?.id || '');
            const selfEdited = !!(botId && lastEditedById && lastEditedById === botId);
            if (remoteId && stateKey) {
                // Feature structure — read Is Feature checkbox + Feature relation (added by
                // NotionBackupService._ensureFeatureProperties). If the properties don't
                // exist yet (pre-feature-schema setup), these read falsy — safe degradation.
                const featureRelation = row.properties?.['Feature']?.relation;
                const parentRemoteId = Array.isArray(featureRelation) && featureRelation.length > 0
                    ? String(featureRelation[0]?.id || '') : '';
                deltas.push({
                    remoteId,
                    stateKey,
                    parentRemoteId,
                    isFeatureCandidate: row.properties?.['Is Feature']?.checkbox === true,
                    updatedAt: lastEditedTime || undefined,
                    selfEdited,
                });
            }
            if (lastEditedTime && lastEditedTime > nextCursor) { nextCursor = lastEditedTime; }
        }
        return { deltas, nextCursor };
    }

    public async fetchCommentDeltas(sinceCursor: string): Promise<{ deltas: RemoteCommentDelta[]; nextCursor: string }> {
        const setup = await this._ensureSetup();
        if (!setup?.commentsDatabaseId) { return { deltas: [], nextCursor: sinceCursor }; }

        // Resolve the bot id (drives authoredBySelf). Fail SAFE: if it can't be resolved,
        // skip comment ingestion this cycle (an uncomputable authoredBySelf risks a loop).
        const botId = setup.botId || this._botId || (await this._deps.notion.getBotId()) || '';
        if (!botId) {
            this._log('Bot id unavailable — skipping comment ingestion this cycle (will retry).');
            return { deltas: [], nextCursor: sinceCursor };
        }
        this._botId = botId;

        const rows = await this._queryDelta(setup.commentsDatabaseId, 'created_time', sinceCursor);
        const deltas: RemoteCommentDelta[] = [];
        let nextCursor = sinceCursor;
        for (const row of rows) {
            const commentId = String(row.id || '');
            const createdAt = String(row.created_time || '');
            if (!commentId || !createdAt) { continue; }
            if (createdAt > nextCursor) { nextCursor = createdAt; }

            const remoteId = String(row.properties?.['Plan']?.relation?.[0]?.id || '');
            if (!remoteId) {
                // Can't route a comment with no Plan relation — drop with a warning (don't guess).
                this._log(`Comment ${commentId} has no Plan relation — dropped.`);
                continue;
            }
            const titleRuns = row.properties?.['Message']?.title || [];
            const body = titleRuns.map((t: any) => t.plain_text || '').join('');
            const authoredBySelf = String(row.created_by?.id || '') === botId;
            deltas.push({ remoteId, commentId, body, createdAt, authoredBySelf });
        }
        return { deltas, nextCursor };
    }

    public stateKeyToColumn(stateKey: string): string | undefined {
        // D2 — the `Kanban Column` select option name IS the board column name. Setup
        // populates the select from the real board columns, so this is a direct mapping.
        const name = String(stateKey || '').trim();
        return name || undefined;
    }

    /**
     * Lazy body fetch for content-pull — called by `_pollDescriptions` only for rows
     * past their per-issue cursor AND not `selfEdited`. Uses the Notion Markdown API
     * (`GET /v1/pages/{id}/markdown`) — a single call returning the page body as
     * Enhanced Markdown, replacing the block-fetch + convertBlocksToMarkdown round-trip.
     * Falls back to block-fetch when the Markdown API is unavailable for this workspace
     * (e.g. integration lacks content capabilities) or when the response is truncated
     * (>20K blocks) — the `selfEdited` guard works either way.
     */
    public async fetchDescription(remoteId: string): Promise<{ body: string; updatedAt: string } | null> {
        try {
            // Primary: Markdown API.
            const { markdown, truncated, lastEditedTime } = await this._deps.notion.fetchPageMarkdown(remoteId);
            if (truncated) {
                // Pages >20K blocks return truncated — fall back to block-fetch for completeness.
                this._log(`fetchDescription: ${remoteId} truncated via Markdown API — falling back to block-fetch.`);
                return await this._fetchDescriptionViaBlocks(remoteId);
            }
            if (!markdown || !markdown.trim()) {
                // Empty body — return null so the caller advances the cursor without clobbering.
                return null;
            }
            return { body: markdown, updatedAt: lastEditedTime || '' };
        } catch (e) {
            // Markdown API unavailable for this workspace/page — fall back to block-fetch.
            this._log(`fetchDescription: Markdown API failed for ${remoteId} (${e instanceof Error ? e.message : String(e)}) — falling back to block-fetch.`);
            return await this._fetchDescriptionViaBlocks(remoteId);
        }
    }

    /** Block-fetch fallback for fetchDescription (the importRemotePlan path). */
    private async _fetchDescriptionViaBlocks(remoteId: string): Promise<{ body: string; updatedAt: string } | null> {
        try {
            const blocks = await this._deps.notion.fetchBlocksRecursive(remoteId);
            const markdown = this._deps.notion.convertBlocksToMarkdown(blocks);
            if (!markdown || !markdown.trim()) { return null; }
            // Block-fetch doesn't return last_edited_time; caller uses the delta's updatedAt.
            return { body: markdown, updatedAt: '' };
        } catch (e) {
            this._log(`fetchDescription block-fetch fallback failed for ${remoteId}: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }

    public async refreshLocalPlanFromRemote(remoteId: string): Promise<void> {
        // D7 — overwrite the local plan file from the Notion page body before dispatch.
        try {
            const workspaceId = await this._deps.getWorkspaceId();
            if (!workspaceId) { return; }
            const plan = await this._deps.db.findPlanByNotionPageId(workspaceId, remoteId);
            if (!plan || !plan.planFile) { return; }

            const blocks = await this._deps.notion.fetchBlocksRecursive(remoteId);
            const markdown = this._deps.notion.convertBlocksToMarkdown(blocks);
            // Half-written body guard: never clobber the local plan with an empty render
            // (the remote agent's "write body fully, then flip column" convention is soft).
            if (!markdown || !markdown.trim()) {
                this._log(`Page ${remoteId} rendered empty — skipping plan refresh (avoids clobber).`);
                return;
            }
            await fs.promises.writeFile(plan.planFile, markdown, 'utf8');
            this._log(`Refreshed local plan ${plan.planFile} from Notion page ${remoteId}.`);
        } catch (e) {
            this._log(`refreshLocalPlanFromRemote failed for ${remoteId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    public async postComment(remoteId: string, body: string): Promise<void> {
        const result = await this._deps.notion.postManagedComment(remoteId, body);
        if (!result.success) {
            throw new Error(`Notion postComment failed for ${remoteId}: ${result.error || 'unknown error'}`);
        }
    }

    /**
     * Outbound create-if-missing (provider-sync full parity). Mirrors ClickUp's
     * `syncPlan` lazy-create: when a Notion-configured, push-enabled board fires an
     * outbound sync for a plan with no `notionPageId`, dedup-check by Plan ID, then
     * create a new page under the plans database with the title + Kanban Column
     * select + Plan ID rich_text in a single `POST /v1/pages` body (one-shot property
     * set at create — no follow-up PATCH). Returns the page id (existing or new), or
     * '' on failure. Idempotent: a repeated sync / second machine finds the page by
     * Plan ID and returns its id instead of duplicating.
     */
    public async createPageForPlan(
        plan: { planId: string; topic: string; kanbanColumn: string },
        targetColumn?: string
    ): Promise<string> {
        const setup = await this._ensureSetup();
        if (!setup?.plansDatabaseId) {
            this._log('createPageForPlan: no plans database configured — skipping.');
            return '';
        }
        const planId = String(plan.planId || '').trim();
        if (!planId) {
            this._log('createPageForPlan: plan has no planId — skipping (cannot dedup).');
            return '';
        }
        const column = String(targetColumn || plan.kanbanColumn || '').trim();
        const title = String(plan.topic || `Plan ${planId}`).trim() || `Plan ${planId}`;

        // Pre-create dedup: query the plans database by Plan ID rich_text equals.
        // This is the Notion analog to ClickUp's `_findTaskByPlanId` — suppresses
        // duplicate pages on repeated sync / second machine / pre-round-trip poll.
        try {
            const queryResult = await this._deps.notion.httpRequest(
                'POST',
                `/databases/${setup.plansDatabaseId}/query`,
                { filter: { property: 'Plan ID', rich_text: { equals: planId } }, page_size: 100 },
                15000
            );
            if (queryResult.status === 200) {
                const existing = queryResult.data?.results?.[0];
                if (existing?.id) {
                    this._log(`createPageForPlan: dedup hit for planId ${planId} → page ${existing.id}.`);
                    return String(existing.id);
                }
            } else {
                this._log(`createPageForPlan: dedup query failed (HTTP ${queryResult.status}) — proceeding to create (dup risk).`);
            }
        } catch (e) {
            this._log(`createPageForPlan: dedup query threw for planId ${planId} (${e instanceof Error ? e.message : String(e)}) — proceeding to create (dup risk).`);
        }

        // Create with properties in one shot. The plans database schema uses 'Topic'
        // as the title property and 'Plan ID' as a rich_text (verified in
        // NotionBackupService._planToNotionProperties). Kanban Column is a select.
        const properties: Record<string, any> = {
            'Topic': { title: [{ text: { content: title } }] },
            'Plan ID': { rich_text: [{ text: { content: planId } }] },
        };
        if (column) {
            properties['Kanban Column'] = { select: { name: column } };
        }

        try {
            const result = await this._deps.notion.httpRequest(
                'POST',
                '/pages',
                { parent: { database_id: setup.plansDatabaseId }, properties },
                15000
            );
            if (result.status < 200 || result.status >= 300) {
                this._log(`createPageForPlan: create failed (HTTP ${result.status}): ${JSON.stringify(result.data)?.slice(0, 200)}`);
                return '';
            }
            const pageId = String(result.data?.id || '');
            if (!pageId) {
                this._log('createPageForPlan: create returned no page id.');
                return '';
            }
            this._log(`createPageForPlan: created page ${pageId} for planId ${planId} (column="${column}").`);
            return pageId;
        } catch (e) {
            this._log(`createPageForPlan: create threw for planId ${planId}: ${e instanceof Error ? e.message : String(e)}`);
            return '';
        }
    }

    public async archiveCard(remoteId: string): Promise<ArchiveResult> {
        const setup = await this._ensureSetup();
        if (!setup?.plansDatabaseId) {
            return { ok: true, skipped: true };
        }
        const pageId = String(remoteId || '').trim();
        if (!pageId) {
            return { ok: false, error: 'No remote id provided' };
        }
        // Notion page archive = PATCH /pages/{id} with archived:true. Idempotent
        // (archiving an already-archived page is a no-op success).
        const result = await this._deps.notion.httpRequest('PATCH', `/pages/${pageId}`, { archived: true }, 15000);
        if (result.status >= 200 && result.status < 300) {
            this._log(`Archived Notion page ${pageId}.`);
            return { ok: true };
        }
        return { ok: false, error: `Notion archive failed (HTTP ${result.status}): ${JSON.stringify(result.data)?.slice(0, 200)}` };
    }

    public async pushState(remoteId: string, column: string): Promise<void> {
        // Write the `Kanban Column` select property on the Notion page.
        // Same pattern as NotionBackupService._upsertPlanToNotion (PATCH /pages/{id}).
        try {
            const result = await this._deps.notion.httpRequest(
                'PATCH', `/pages/${remoteId}`,
                { properties: { 'Kanban Column': { select: { name: column } } } },
                10000
            );
            if (result.status >= 400) {
                // Missing select option — log and skip, don't crash the sync loop.
                if (result.status === 400 || result.status === 422) {
                    this._log(`pushState: column "${column}" is not a valid Kanban Column select option for page ${remoteId} — skipping. Re-run Notion remote setup to sync column options.`);
                } else if (result.status === 404) {
                    this._log(`pushState: page ${remoteId} not found (deleted?) — skipping.`);
                } else {
                    this._log(`pushState: PATCH /pages/${remoteId} failed (HTTP ${result.status}).`);
                }
            }
        } catch (e) {
            this._log(`pushState failed for ${remoteId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    public async pushContent(remoteId: string, markdown: string): Promise<void> {
        // Primary: Notion Markdown API (`PATCH /v1/pages/{id}/markdown`) — a direct
        // markdown write replacing the block-append path. The `selfEdited` semantic
        // guard on the pull side (last_edited_by === botId) handles the echo regardless
        // of whether the markdown round-trip is lossy (Notion-flavored markdown may
        // normalize), so no special hash registration is needed here.
        try {
            const result = await this._deps.notion.updatePageMarkdown(remoteId, markdown);
            if (result.success) { return; }
            // Markdown API unavailable for this workspace/page (e.g. integration lacks
            // content capabilities) — fall back to the block-append path.
            this._log(`pushContent: Markdown API failed for ${remoteId} (${result.error}) — falling back to block-append.`);
        } catch (e) {
            this._log(`pushContent: Markdown API threw for ${remoteId} (${e instanceof Error ? e.message : String(e)}) — falling back to block-append.`);
        }
        // Fallback: block-append via the existing updatePageContent path.
        const fallback = await this._deps.notion.updatePageContent(remoteId, markdown);
        if (!fallback.success) {
            throw new Error(`Notion pushContent failed for ${remoteId}: ${fallback.error || 'unknown error'}`);
        }
    }

    public async importRemotePlan(remoteId: string): Promise<KanbanPlanRecord | null> {
        try {
            if (!this._deps.getPlansDir) { return null; }
            const workspaceId = await this._deps.getWorkspaceId();
            const plansDir = await this._deps.getPlansDir();
            if (!workspaceId || !plansDir) { return null; }
            const title = await this._deps.notion.fetchPageTitle(remoteId).catch(() => 'Untitled');
            const blocks = await this._deps.notion.fetchBlocksRecursive(remoteId);
            const rendered = this._deps.notion.convertBlocksToMarkdown(blocks);
            const body = `# ${title}\n\n> **Notion Page ID:** ${remoteId}\n\n${rendered}`;
            const rec = await importRemoteMarkdownPlan({
                db: this._deps.db, workspaceId, plansDir, title, body, sourceType: 'notion-import',
            });
            if (!rec) { return null; }
            await this._deps.db.updateNotionPageIdByPlanFile(rec.planFile, workspaceId, remoteId);
            return await this._deps.db.findPlanByNotionPageId(workspaceId, remoteId);
        } catch (e) {
            this._log(`importRemotePlan failed for ${remoteId}: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }

    /**
     * Inbound-delete reconcile-sweep (provider-sync inbound-delete). Paginate the
     * plans database (all non-archived pages) and collect their ids. Throttled at
     * the same ~3 RPS limiter the delta query uses; honours Retry-After via the
     * internal httpRequest retry. If any page fails (non-200 after retries), the
     * sweep is reported INCOMPLETE — the caller MUST NOT tombstone the un-fetched
     * tail. Only a fully-completed sweep produces a reliable deletion list.
     */
    public async reconcileLiveIds(): Promise<{ complete: boolean; liveIds: Set<string> }> {
        const setup = await this._ensureSetup();
        if (!setup?.plansDatabaseId) {
            return { complete: true, liveIds: new Set() };
        }
        // Full-database sweep cap — deliberately NOT the delta query's MAX_PAGES (5 ≈ 500
        // changed rows/poll). The plan sizes the target install at ~4,000 cards (≈40 pages);
        // cap at 60 pages (≈6,000) with headroom. Crucially, if the cap is hit while more
        // pages remain, the sweep MUST be reported INCOMPLETE — a truncated liveIds set
        // would otherwise flag every un-fetched mapped id as a candidate deletion (and even
        // with the per-id probe as a backstop, that means thousands of probe calls per
        // sweep, blowing the rate budget). "Only act on a complete sweep" is the contract.
        const RECONCILE_MAX_PAGES = 60;
        const liveIds = new Set<string>();
        let complete = true;
        let hasMore = false;
        let startCursor: string | undefined;
        for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
            const body: Record<string, unknown> = { page_size: PAGE_SIZE };
            if (startCursor) { body.start_cursor = startCursor; }
            let result;
            try {
                result = await this._deps.notion.httpRequest('POST', `/databases/${setup.plansDatabaseId}/query`, body, 30000);
            } catch (e) {
                this._log(`reconcileLiveIds: page ${page} threw (${e instanceof Error ? e.message : String(e)}) — marking sweep incomplete.`);
                complete = false;
                break;
            }
            if (result.status !== 200) {
                this._log(`reconcileLiveIds: page ${page} failed (HTTP ${result.status}) — marking sweep incomplete.`);
                complete = false;
                break;
            }
            for (const row of (result.data?.results || [])) {
                const id = String(row.id || '');
                if (id) { liveIds.add(id); }
            }
            hasMore = result.data?.has_more === true;
            if (!hasMore) { break; }
            startCursor = result.data?.next_cursor || undefined;
            if (!startCursor) { hasMore = false; break; }
            await this._delay(LIMITER_MS);
        }
        // Cap reached with pages still remaining → truncated set. Report incomplete so the
        // caller issues no tombstones (never mistake the un-fetched tail for deletions).
        if (hasMore) {
            this._log(`reconcileLiveIds: hit page cap (${RECONCILE_MAX_PAGES}) with more pages remaining — marking INCOMPLETE (no tombstones).`);
            complete = false;
        }
        if (complete) {
            this._log(`reconcileLiveIds: complete sweep — ${liveIds.size} live page(s).`);
        } else {
            this._log(`reconcileLiveIds: INCOMPLETE sweep — ${liveIds.size} page(s) fetched; no tombstones will be issued.`);
        }
        return { complete, liveIds };
    }

    /**
     * Inbound-delete disambiguation probe (provider-sync inbound-delete). After the
     * sweep reports a mapped page id as missing, re-check it directly: a GET /pages/{id}
     * that returns the page (archived or not) means the page still exists (a move, or
     * archived-but-not-deleted) → 'moved'; a 404/genuine absence → 'deleted'; any
     * uncertainty → 'unknown' (safe skip).
     */
    public async probeRemoteId(remoteId: string): Promise<'deleted' | 'moved' | 'unknown'> {
        const pageId = String(remoteId || '').trim();
        if (!pageId) { return 'unknown'; }
        try {
            const result = await this._deps.notion.httpRequest('GET', `/pages/${pageId}`, undefined, 15000);
            if (result.status === 404) { return 'deleted'; }
            if (result.status >= 200 && result.status < 300) {
                // Page exists — archived or not, it wasn't deleted. Treat as moved
                // (out of the queried scope, or archived which the query excludes).
                return 'moved';
            }
            this._log(`probeRemoteId: ${pageId} returned HTTP ${result.status} — treating as unknown.`);
            return 'unknown';
        } catch (e) {
            this._log(`probeRemoteId: ${pageId} threw (${e instanceof Error ? e.message : String(e)}) — treating as unknown.`);
            return 'unknown';
        }
    }
}
