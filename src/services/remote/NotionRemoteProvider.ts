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
}
