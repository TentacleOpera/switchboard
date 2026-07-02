import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { NotionFetchService } from './NotionFetchService';
import { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';
import { loadNotionRemoteSetup, saveNotionRemoteSetup } from './remote/notionRemoteConfig';

export interface NotionBackupConfig {
    databaseUrl?: string;
    databaseId?: string;
    databaseTitle?: string;
    lastBackupAt: string | null;
    lastRestoreAt: string | null;
}

/**
 * Service that backs up and restores kanban.db plans to/from a Notion database.
 * Uses Notion API with rate limiting (~3 requests/sec = 350ms delay).
 */
export class NotionBackupService {
    private _workspaceRoot: string;
    private _configPath: string;
    private _notionFetchService: NotionFetchService;

    constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
        this._workspaceRoot = workspaceRoot;
        this._configPath = path.join(workspaceRoot, '.switchboard', 'notion-backup-config.json');
        this._notionFetchService = new NotionFetchService(workspaceRoot, secretStorage);
    }

    // ── Config I/O ──────────────────────────────────────────────

    async loadConfig(): Promise<NotionBackupConfig | null> {
        try {
            const content = await fs.promises.readFile(this._configPath, 'utf8');
            return JSON.parse(content);
        } catch { return null; }
    }

    async saveConfig(config: NotionBackupConfig): Promise<void> {
        await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
        await fs.promises.writeFile(this._configPath, JSON.stringify(config, null, 2));
    }

    // ── URL Parsing ─────────────────────────────────────────────

    parseDatabaseId(url: string): string | null {
        return this._notionFetchService.parsePageId(url);
    }

    // ── Backup ────────────────────────────────────────────────────

    async backupToNotion(workspaceRoot: string, progress?: vscode.Progress<{ message?: string }>): Promise<{ success: boolean; backedUp: number; total: number; error?: string }> {
        const config = await this.loadConfig();
        if (!config?.databaseId) {
            return { success: false, backedUp: 0, total: 0, error: 'Notion database not configured' };
        }

        const kanbanDb = KanbanDatabase.forWorkspace(workspaceRoot);
        await kanbanDb.ensureReady();
        const workspaceId = await kanbanDb.getWorkspaceId();
        if (!workspaceId) {
            return { success: false, backedUp: 0, total: 0, error: 'Workspace ID not found in database' };
        }

        const allPlans = await kanbanDb.getAllPlans(workspaceId);
        let backedUp = 0;
        const total = allPlans.length;

        // Build planId → notionPageId map for epics so subtasks can set their Epic relation.
        // Uses existing notionPageId values (set by a prior setup sync). If an epic has no
        // page id yet, its subtasks get an empty relation — filled on a later backup.
        const epicIdToNotionPageId = new Map<string, string>();
        for (const p of allPlans) {
            if (p.isEpic && p.notionPageId) { epicIdToNotionPageId.set(p.planId, p.notionPageId); }
        }

        for (let i = 0; i < allPlans.length; i++) {
            const plan = allPlans[i];
            progress?.report({ message: `Backing up plan ${i + 1} of ${total}...` });
            const result = await this._upsertPlanToNotion(config.databaseId, plan, epicIdToNotionPageId);
            if (result.success) { backedUp++; }
            if (total > 1) { await this._delay(350); }
        }

        const success = backedUp === total;
        if (success) {
            config.lastBackupAt = new Date().toISOString();
            await this.saveConfig(config);
        }
        return { success, backedUp, total, error: success ? undefined : `Backed up ${backedUp}/${total} plans` };
    }

    // ── Restore ───────────────────────────────────────────────────

    async restoreFromNotion(workspaceRoot: string, progress?: vscode.Progress<{ message?: string }>): Promise<{ success: boolean; restored: number; skipped: number; error?: string }> {
        const config = await this.loadConfig();
        if (!config?.databaseId) {
            return { success: false, restored: 0, skipped: 0, error: 'Notion database not configured' };
        }

        const notionPages = await this._queryDatabasePages(config.databaseId);
        const kanbanDb = KanbanDatabase.forWorkspace(workspaceRoot);
        await kanbanDb.ensureReady();
        const workspaceId = await kanbanDb.getWorkspaceId();
        if (!workspaceId) {
            return { success: false, restored: 0, skipped: 0, error: 'Workspace ID not found in database' };
        }

        const localPlans = await kanbanDb.getAllPlans(workspaceId);
        const localByPlanId = new Map(localPlans.map(p => [p.planId, p]));

        const toRestore: KanbanPlanRecord[] = [];
        const columnUpdates: Array<{ planId: string; column: string }> = [];
        // Collect epic relation targets for second-pass resolution (notionPageId → planId).
        const epicLinks: Array<{ plan: KanbanPlanRecord; epicNotionPageId: string }> = [];
        let skipped = 0;

        for (let i = 0; i < notionPages.length; i++) {
            const page = notionPages[i];
            progress?.report({ message: `Restoring plan ${i + 1} of ${notionPages.length}...` });
            const parsed = this._notionPageToPlanRecord(page);
            if (!parsed) { continue; }
            const plan = parsed.plan;

            const local = localByPlanId.get(plan.planId);
            if (local) {
                if (local.updatedAt > plan.updatedAt) {
                    skipped++;
                    continue;
                }
                // Preserve local path / dispatch fields to avoid severing plan-to-file links
                plan.planFile = local.planFile;
                plan.brainSourcePath = local.brainSourcePath;
                plan.mirrorPath = local.mirrorPath;
                plan.routedTo = local.routedTo;
                plan.dispatchedAgent = local.dispatchedAgent;
                plan.dispatchedIde = local.dispatchedIde;
                // Track column change to update separately
                if (local.kanbanColumn !== plan.kanbanColumn) {
                    columnUpdates.push({ planId: plan.planId, column: plan.kanbanColumn });
                }
            }
            toRestore.push(plan);
            if (parsed.epicNotionPageId && parsed.epicNotionPageId !== String(page.id || '')) {
                // Guard against self-relations (a page pointing to itself).
                epicLinks.push({ plan, epicNotionPageId: parsed.epicNotionPageId });
            }
            if (notionPages.length > 1) { await this._delay(10); }
        }

        if (toRestore.length > 0) {
            await kanbanDb.upsertPlans(toRestore);
        }
        // Post-restore: apply column updates using planId-based lookup (never sessionId,
        // which is '' for file-based plans and would match a random row).
        // For epics, cascadeEpicByPlanId handles the epic's own column + subtasks atomically.
        // For non-epics, use getPlanByPlanId → updateColumnByPlanFile.
        for (const { planId, column } of columnUpdates) {
            if (!planId) continue;
            const dbPlan = await kanbanDb.getPlanByPlanId(planId);
            if (!dbPlan) continue;
            if (dbPlan.isEpic) {
                const targetStatus = dbPlan.status === 'completed' ? 'completed' : undefined;
                // includeAllSubtasks=true: restore should re-align ALL subtasks (including
                // completed/deleted), not just active ones, to match the epic's restored column.
                await kanbanDb.cascadeEpicByPlanId(dbPlan.planId, column, targetStatus, true);
            } else {
                await kanbanDb.updateColumnByPlanFile(dbPlan.planFile, dbPlan.workspaceId, column);
            }
        }

        // Post-restore: resolve Epic relations (Notion page id → local planId) and apply
        // epic structure. Build a notionPageId → planId map from the restored records
        // (each has both). Then for each subtask with an Epic relation, set its epicId.
        if (epicLinks.length > 0) {
            const notionPageIdToPlanId = new Map<string, string>();
            for (const r of toRestore) {
                if (r.notionPageId && r.planId) { notionPageIdToPlanId.set(r.notionPageId, r.planId); }
            }
            for (const { plan, epicNotionPageId } of epicLinks) {
                const epicPlanId = notionPageIdToPlanId.get(epicNotionPageId);
                if (!epicPlanId || epicPlanId === plan.planId) { continue; } // untracked or self-relation
                await kanbanDb.updateEpicStatus(plan.planId, 0, epicPlanId);
            }
        }

        config.lastRestoreAt = new Date().toISOString();
        await this.saveConfig(config);
        return { success: true, restored: toRestore.length, skipped };
    }

    // ── Auto-create database ──────────────────────────────────────

    async autoCreateDatabase(): Promise<{ success: boolean; databaseUrl?: string; error?: string }> {
        const notionConfig = await this._notionFetchService.loadConfig();
        const parentPageId = notionConfig?.pageId;
        if (!parentPageId) {
            return { success: false, error: 'No Notion page configured. Set up Notion integration in the Integrations tab first.' };
        }

        const payload = {
            parent: { page_id: parentPageId },
            title: [{ type: 'text', text: { content: 'Switchboard Kanban Backup' } }],
            properties: {
                'Topic': { title: {} },
                'Plan ID': { rich_text: {} },
                'Session ID': { rich_text: {} },
                'Kanban Column': { select: { options: [
                    { name: 'CREATED', color: 'blue' },
                    { name: 'BACKLOG', color: 'gray' },
                    { name: 'PLAN REVIEWED', color: 'yellow' },
                    { name: 'LEAD CODED', color: 'purple' },
                    { name: 'CODED', color: 'green' },
                    { name: 'REVIEWED', color: 'orange' },
                    { name: 'DONE', color: 'red' },
                    { name: 'CLOSED', color: 'brown' }
                ] } },
                'Status': { select: { options: [
                    { name: 'active', color: 'green' },
                    { name: 'archived', color: 'gray' },
                    { name: 'completed', color: 'blue' },
                    { name: 'deleted', color: 'red' }
                ] } },
                'Complexity': { number: { format: 'number' } },
                'Tags': { multi_select: {} },
                'Dependencies': { rich_text: {} },
                'Repo Scope': { rich_text: {} },
                'Workspace ID': { rich_text: {} },
                'Created At': { date: {} },
                'Updated At': { date: {} },
                'Last Action': { rich_text: {} },
                'Source Type': { select: { options: [
                    { name: 'local', color: 'blue' },
                    { name: 'brain', color: 'purple' },
                    { name: 'clickup-automation', color: 'green' },
                    { name: 'linear-automation', color: 'yellow' },
                    { name: 'notion-automation', color: 'pink' },
                    { name: 'notion-import', color: 'red' }
                ] } },
                'ClickUp Task ID': { rich_text: {} },
                'Linear Issue ID': { rich_text: {} },
                // Epic structure — 'Is Epic' is created up-front; the 'Epic' self-relation
                // is added post-creation via _ensureEpicProperties (Notion requires the DB
                // to exist before a relation can reference it).
                'Is Epic': { checkbox: {} }
            }
        };

        const result = await this._notionFetchService.httpRequest('POST', '/databases', payload, 15000);
        if (result.status !== 200) {
            return { success: false, error: `Failed to create database (HTTP ${result.status}): ${JSON.stringify(result.data)}` };
        }

        const databaseId = result.data?.id;
        const databaseUrl = result.data?.url || `https://notion.so/database/${databaseId}`;
        await this.saveConfig({
            databaseUrl,
            databaseId,
            databaseTitle: 'Switchboard Kanban Backup',
            lastBackupAt: null,
            lastRestoreAt: null
        });
        return { success: true, databaseUrl };
    }

    // ── Remote-Control setup (§10) ────────────────────────────────

    /**
     * One-time Notion Remote-Control setup, run from the Remote tab. Idempotent — safe to
     * re-run (it reuses existing databases and only extends the column select).
     *
     * 1. Ensure the plans DB exists (reuse the backup DB), back up the selected boards'
     *    plans so each has a page, and write each page id back to `notionPageId` — this is
     *    the gap `_upsertPlanToNotion` otherwise leaves open (cards with no page id can't be
     *    polled).
     * 2. Populate the `Kanban Column` select from the REAL board columns (not the hardcoded
     *    8) or state mirroring silently fails for any column not in the select.
     * 3. Ensure the "Switchboard Comments" DB exists (the async message bus).
     * 4. Cache the bot id + database ids; seed both cursors to "now" (no history replay).
     */
    async setupRemoteControl(
        workspaceRoot: string,
        boards: string[],
        columnNames: string[]
    ): Promise<{ success: boolean; backedUp?: number; plansDatabaseUrl?: string; commentsDatabaseId?: string; error?: string }> {
        const kanbanDb = KanbanDatabase.forWorkspace(workspaceRoot);
        await kanbanDb.ensureReady();
        const workspaceId = await kanbanDb.getWorkspaceId();
        if (!workspaceId) {
            return { success: false, error: 'Workspace ID not found in database' };
        }

        // 1. Ensure the plans DB.
        let config = await this.loadConfig();
        if (!config?.databaseId) {
            const created = await this.autoCreateDatabase();
            if (!created.success) { return { success: false, error: created.error || 'Failed to create plans database' }; }
            config = await this.loadConfig();
        }
        const plansDatabaseId = config?.databaseId;
        if (!plansDatabaseId) { return { success: false, error: 'Plans database id unavailable after setup' }; }

        // 2. Extend the Kanban Column select to cover every real board column + whatever
        //    columns existing cards already sit in.
        const allPlans = await kanbanDb.getAllPlans(workspaceId);
        const boardSet = new Set(boards);
        const dbColumns = Array.from(new Set(allPlans.map(p => String(p.kanbanColumn || '').trim()).filter(Boolean)));
        const allColumns = Array.from(new Set([...(columnNames || []), ...dbColumns].map(c => String(c).trim()).filter(Boolean)));
        await this._ensureColumnSelectOptions(plansDatabaseId, allColumns);
        // Ensure epic schema properties (Is Epic checkbox + Epic self-relation) exist.
        // Idempotent — upgrades existing DBs in-place; no-op if already present.
        await this._ensureEpicProperties(plansDatabaseId);

        // 3. Back up the participating plans and write page ids back.
        //    Two-pass: Pass 1 creates/updates all pages (with Is Epic but no Epic relation —
        //    the relation needs the epic's page id, which may not exist yet). Pass 2 PATCHes
        //    each subtask page to set its Epic relation now that all page ids are known.
        const participating = allPlans.filter(p => p.status !== 'deleted' && boardSet.has(p.project || ''));
        let backedUp = 0;
        const planIdToPageId = new Map<string, string>(); // collected during Pass 1
        for (let i = 0; i < participating.length; i++) {
            const plan = participating[i];
            // Pass 1: no epicIdToNotionPageId → Epic relation left empty (filled in Pass 2).
            const result = await this._upsertPlanToNotion(plansDatabaseId, plan);
            if (result.success && result.pageId) {
                await kanbanDb.updateNotionPageIdByPlanFile(plan.planFile, workspaceId, result.pageId);
                // Surface the id to the local triager/reply agent (mirror Linear's
                // `**Linear Issue ID:**`) so it can post replies via the notion_api skill.
                await this._writeNotionPageIdMetadata(plan.planFile, result.pageId);
                planIdToPageId.set(plan.planId, result.pageId);
                backedUp++;
            }
            if (participating.length > 1) { await this._delay(350); }
        }

        // Pass 2: for each subtask with an epicId, PATCH its page to set the Epic relation.
        // Only plans whose epic has a known page id (from Pass 1) get the relation.
        for (const plan of participating) {
            if (!plan.epicId) { continue; }
            const epicPageId = planIdToPageId.get(plan.epicId);
            if (!epicPageId) { continue; } // epic not on this board or not backed up
            const subtaskPageId = planIdToPageId.get(plan.planId);
            if (!subtaskPageId) { continue; }
            try {
                await this._notionFetchService.httpRequest('PATCH', `/pages/${subtaskPageId}`, {
                    properties: { 'Epic': { relation: [{ id: epicPageId }] } }
                }, 10000);
            } catch (e) {
                console.warn(`[NotionBackupService] Pass 2: failed to set Epic relation for ${plan.planId}:`, e);
            }
            await this._delay(350);
        }

        // 4. Ensure the Comments DB.
        const existingSetup = await loadNotionRemoteSetup(kanbanDb);
        let commentsDatabaseId = existingSetup?.commentsDatabaseId || '';
        if (commentsDatabaseId) {
            const access = await this.validateDatabaseAccess(commentsDatabaseId);
            if (!access.success) { commentsDatabaseId = ''; }
        }
        if (!commentsDatabaseId) {
            const created = await this._ensureCommentsDatabase(plansDatabaseId);
            if (!created.databaseId) { return { success: false, error: created.error || 'Failed to create Comments database' }; }
            commentsDatabaseId = created.databaseId;
        }

        // 5. Cache ids + bot id; seed cursors to "now" so history is not replayed.
        const botId = (await this._notionFetchService.getBotId()) || existingSetup?.botId || '';
        await saveNotionRemoteSetup(kanbanDb, { plansDatabaseId, commentsDatabaseId, botId });

        const now = new Date().toISOString();
        // Cursor + seen keys MUST match RemoteControlService's `remote.{state,comment}Cursor.notion`.
        await kanbanDb.setConfig('remote.stateCursor.notion', now);
        await kanbanDb.setConfig('remote.commentCursor.notion', now);
        await kanbanDb.setConfig('remote.commentSeen.notion', '[]');

        return { success: true, backedUp, plansDatabaseUrl: config?.databaseUrl, commentsDatabaseId };
    }

    /**
     * Insert/replace a `> **Notion Page ID:** <id>` metadata line in the plan file so the
     * local triager/reply agent can resolve the id for the notion_api bridge skill.
     * Idempotent: replaces an existing line rather than appending a duplicate.
     */
    private async _writeNotionPageIdMetadata(planFileAbs: string, pageId: string): Promise<void> {
        try {
            if (!planFileAbs || !pageId) { return; }
            let content: string;
            try { content = await fs.promises.readFile(planFileAbs, 'utf8'); }
            catch { return; } // plan file not on disk (DB-only record) — nothing to stamp
            const line = `> **Notion Page ID:** ${pageId}`;
            if (content.includes('**Notion Page ID:**')) {
                const replaced = content.replace(/^>?\s*\*\*Notion Page ID:\*\*.*$/m, line);
                if (replaced === content) { return; }
                await fs.promises.writeFile(planFileAbs, replaced, 'utf8');
                return;
            }
            // Insert right after the first line (usually the H1) to mirror Linear's stub layout.
            const lines = content.split('\n');
            const insertAt = lines.length > 0 && lines[0].startsWith('# ') ? 1 : 0;
            lines.splice(insertAt, 0, '', line);
            await fs.promises.writeFile(planFileAbs, lines.join('\n'), 'utf8');
        } catch (e) {
            console.warn('[NotionBackupService] _writeNotionPageIdMetadata failed:', e);
        }
    }

    /** Create/extend the plans DB `Kanban Column` select so every real column round-trips. */
    private async _ensureColumnSelectOptions(databaseId: string, columns: string[]): Promise<void> {
        if (!columns.length) { return; }
        try {
            const dbResult = await this._notionFetchService.httpRequest('GET', `/databases/${databaseId}`, undefined, 10000);
            if (dbResult.status !== 200) { return; }
            const existing: any[] = dbResult.data?.properties?.['Kanban Column']?.select?.options || [];
            const existingNames = new Set(existing.map((o: any) => String(o.name)));
            const additions = columns.filter(c => !existingNames.has(c));
            if (additions.length === 0) { return; }
            const options = [...existing.map((o: any) => ({ name: o.name, color: o.color })), ...additions.map(name => ({ name }))];
            await this._notionFetchService.httpRequest('PATCH', `/databases/${databaseId}`, {
                properties: { 'Kanban Column': { select: { options } } }
            }, 10000);
        } catch (e) {
            console.warn('[NotionBackupService] _ensureColumnSelectOptions failed:', e);
        }
    }

    /**
     * Idempotently ensure the `Is Epic` (checkbox) and `Epic` (single-property self-relation)
     * properties exist on the plans DB. The `Epic` relation is a self-relation — Notion
     * requires the database to exist before a relation can reference it, so it is PATCHed
     * in after creation (same pattern as `_ensureColumnSelectOptions`). Safe to call on
     * every setup — only PATCHes properties that are missing.
     */
    private async _ensureEpicProperties(databaseId: string): Promise<void> {
        try {
            const dbResult = await this._notionFetchService.httpRequest('GET', `/databases/${databaseId}`, undefined, 10000);
            if (dbResult.status !== 200) { return; }
            const props = dbResult.data?.properties || {};
            const patch: Record<string, any> = {};
            if (!props['Is Epic']) {
                patch['Is Epic'] = { checkbox: {} };
            }
            if (!props['Epic']) {
                patch['Epic'] = { relation: { database_id: databaseId, type: 'single_property', single_property: {} } };
            }
            if (Object.keys(patch).length > 0) {
                await this._notionFetchService.httpRequest('PATCH', `/databases/${databaseId}`, { properties: patch }, 10000);
            }
        } catch (e) {
            console.warn('[NotionBackupService] _ensureEpicProperties failed:', e);
        }
    }

    /** Create the agent-operated "Switchboard Comments" database under the configured parent page. */
    private async _ensureCommentsDatabase(plansDatabaseId: string): Promise<{ databaseId?: string; error?: string }> {
        const notionConfig = await this._notionFetchService.loadConfig();
        const parentPageId = notionConfig?.pageId;
        if (!parentPageId) {
            return { error: 'No Notion page configured. Set up Notion integration in the Integrations tab first.' };
        }
        const payload = {
            parent: { page_id: parentPageId },
            title: [{ type: 'text', text: { content: 'Switchboard Comments' } }],
            properties: {
                'Message': { title: {} },
                'Plan': { relation: { database_id: plansDatabaseId, type: 'single_property', single_property: {} } },
                'From': { select: { options: [
                    { name: 'Remote', color: 'blue' },
                    { name: 'Switchboard', color: 'green' }
                ] } }
            }
        };
        const result = await this._notionFetchService.httpRequest('POST', '/databases', payload, 15000);
        if (result.status !== 200) {
            return { error: `Failed to create Comments database (HTTP ${result.status}): ${JSON.stringify(result.data)?.slice(0, 200)}` };
        }
        return { databaseId: String(result.data?.id || '') };
    }

    // ── Validation ────────────────────────────────────────────────

    async validateDatabaseAccess(databaseId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const result = await this._notionFetchService.httpRequest('GET', `/databases/${databaseId}`, undefined, 10000);
            if (result.status === 200) { return { success: true }; }
            if (result.status === 403) { return { success: false, error: `403 Forbidden: the integration lacks permissions for this database.` }; }
            return { success: false, error: `HTTP ${result.status}: ${JSON.stringify(result.data)}` };
        } catch (err: any) {
            return { success: false, error: err.message || 'Network error validating database access' };
        }
    }

    // ── Private helpers ───────────────────────────────────────────

    private async _upsertPlanToNotion(databaseId: string, plan: KanbanPlanRecord, epicIdToNotionPageId?: Map<string, string>): Promise<{ success: boolean; pageId?: string }> {
        try {
            // Query for existing page by Plan ID
            const queryResult = await this._notionFetchService.httpRequest('POST', `/databases/${databaseId}/query`, {
                filter: { property: 'Plan ID', rich_text: { equals: plan.planId } }
            }, 15000);
            const existing = queryResult.data?.results?.[0];

            const properties = this._planToNotionProperties(plan, epicIdToNotionPageId);
            if (existing) {
                await this._notionFetchService.httpRequest('PATCH', `/pages/${existing.id}`, { properties }, 10000);
                return { success: true, pageId: String(existing.id || '') };
            } else {
                const created = await this._notionFetchService.httpRequest('POST', '/pages', {
                    parent: { database_id: databaseId },
                    properties
                }, 15000);
                return { success: true, pageId: String(created.data?.id || '') };
            }
        } catch {
            return { success: false };
        }
    }

    private async _queryDatabasePages(databaseId: string): Promise<any[]> {
        const pages: any[] = [];
        let hasMore = true;
        let startCursor: string | undefined;
        while (hasMore) {
            const result = await this._notionFetchService.httpRequest('POST', `/databases/${databaseId}/query`, {
                start_cursor: startCursor
            }, 15000);
            if (result.status !== 200) { break; }
            const data = result.data;
            pages.push(...(data.results || []));
            hasMore = data.has_more === true;
            startCursor = data.next_cursor || undefined;
            if (hasMore) { await this._delay(350); }
        }
        return pages;
    }

    private _planToNotionProperties(plan: KanbanPlanRecord, epicIdToNotionPageId?: Map<string, string>): Record<string, any> {
        // Epic relation — needs the epic's Notion page id (not the local planId).
        // If the map is provided and the epic's page exists, set the relation; otherwise
        // leave it empty (Pass 2 of setup sync fills it after all pages are created).
        let epicRelation: { relation: any[] };
        if (plan.epicId && epicIdToNotionPageId) {
            const epicPageId = epicIdToNotionPageId.get(plan.epicId);
            epicRelation = { relation: epicPageId ? [{ id: epicPageId }] : [] };
        } else {
            epicRelation = { relation: [] };
        }
        return {
            'Topic': { title: [{ text: { content: plan.topic } }] },
            'Plan ID': { rich_text: [{ text: { content: plan.planId } }] },
            'Session ID': { rich_text: [{ text: { content: plan.sessionId } }] },
            'Kanban Column': { select: { name: plan.kanbanColumn } },
            'Status': { select: { name: plan.status } },
            'Complexity': { number: Number(plan.complexity) || 0 },
            'Tags': { multi_select: plan.tags.split(',').map(t => t.trim()).filter(Boolean).map(name => ({ name })) },
            'Repo Scope': { rich_text: [{ text: { content: plan.repoScope } }] },
            'Workspace ID': { rich_text: [{ text: { content: plan.workspaceId } }] },
            'Created At': { date: { start: plan.createdAt } },
            'Updated At': { date: { start: plan.updatedAt } },
            'Last Action': { rich_text: [{ text: { content: plan.lastAction } }] },
            'Source Type': { select: { name: plan.sourceType } },
            'ClickUp Task ID': { rich_text: [{ text: { content: plan.clickupTaskId || '' } }] },
            'Linear Issue ID': { rich_text: [{ text: { content: plan.linearIssueId || '' } }] },
            'Is Epic': { checkbox: Boolean(plan.isEpic) },
            'Epic': epicRelation
        };
    }

    /**
     * Map a Notion page → KanbanPlanRecord. Also returns the `Epic` relation's target
     * page id (if any) as `epicNotionPageId` — a transient value NOT on KanbanPlanRecord.
     * The caller (`restoreFromNotion`) resolves it to a local `planId` in a second pass.
     */
    private _notionPageToPlanRecord(page: any): { plan: KanbanPlanRecord; epicNotionPageId?: string } | null {
        try {
            const p = page.properties;
            const getRichText = (prop: any): string => prop?.rich_text?.[0]?.plain_text || '';
            const getTitle = (prop: any): string => prop?.title?.[0]?.plain_text || '';
            const getSelect = (prop: any): string => prop?.select?.name || '';
            const getDate = (prop: any): string => prop?.date?.start || '';
            const getNumber = (prop: any): number => prop?.number ?? 0;
            const getMultiSelect = (prop: any): string => (prop?.multi_select || []).map((t: any) => t.name).join(',');

            // Epic structure — Is Epic checkbox + Epic relation (self-relation to plans DB).
            // If the properties don't exist (pre-epic-schema setup), these read falsy — safe.
            const isEpic = p['Is Epic']?.checkbox === true ? 1 : 0;
            const epicRelation = p['Epic']?.relation;
            const epicNotionPageId = Array.isArray(epicRelation) && epicRelation.length > 0
                ? String(epicRelation[0]?.id || '') : '';

            const plan: KanbanPlanRecord = {
                planId: getRichText(p['Plan ID']),
                sessionId: getRichText(p['Session ID']),
                topic: getTitle(p['Topic']),
                planFile: '',
                kanbanColumn: getSelect(p['Kanban Column']),
                status: getSelect(p['Status']) as KanbanPlanRecord['status'],
                complexity: String(getNumber(p['Complexity'])),
                tags: getMultiSelect(p['Tags']),
                repoScope: getRichText(p['Repo Scope']),
                workspaceId: getRichText(p['Workspace ID']),
                createdAt: getDate(p['Created At']),
                updatedAt: getDate(p['Updated At']),
                lastAction: getRichText(p['Last Action']),
                sourceType: getSelect(p['Source Type']) as KanbanPlanRecord['sourceType'],
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: '',
                clickupTaskId: getRichText(p['ClickUp Task ID']),
                linearIssueId: getRichText(p['Linear Issue ID']),
                // The row's own page id is the Notion Remote-Control linkage.
                notionPageId: String(page.id || ''),
                isEpic,
                epicId: '' // resolved by the caller from epicNotionPageId
            };
            return { plan, epicNotionPageId: epicNotionPageId || undefined };
        } catch {
            return null;
        }
    }

    private async _delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}