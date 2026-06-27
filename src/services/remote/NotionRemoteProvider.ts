import * as fs from 'fs';
import type { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';
import type { NotionFetchService } from '../NotionFetchService';
import type { RemoteProvider, RemoteStateDelta, RemoteCommentDelta } from './RemoteProvider';
import { loadNotionRemoteSetup, type NotionRemoteSetup } from './notionRemoteConfig';
import { importRemoteMarkdownPlan } from './importRemotePlan';

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

        const rows = await this._queryDelta(setup.plansDatabaseId, 'last_edited_time', sinceCursor);
        const deltas: RemoteStateDelta[] = [];
        let nextCursor = sinceCursor;
        for (const row of rows) {
            const remoteId = String(row.id || '');
            const stateKey = String(row.properties?.['Kanban Column']?.select?.name || '').trim();
            if (remoteId && stateKey) { deltas.push({ remoteId, stateKey }); }
            const ts = String(row.last_edited_time || '');
            if (ts && ts > nextCursor) { nextCursor = ts; }
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
