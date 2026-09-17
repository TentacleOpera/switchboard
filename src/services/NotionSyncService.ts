import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { NotionFetchService } from './NotionFetchService';
import { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';
import { loadNotionRemoteSetup, saveNotionRemoteSetup } from './remote/notionRemoteConfig';
import { syncOwnershipLease } from './SyncOwnershipLease';

export interface NotionSyncConfig {
    databaseUrl?: string;
    databaseId?: string;
    databaseTitle?: string;
    lastBackupAt: string | null;
    lastRestoreAt: string | null;
}

/**
 * Projects kanban.db plans into a Notion database — the plans-database
 * projection Remote Control (`setupRemoteControl`) is built on.
 *
 * This is NOT a board backup/restore pair. `backupToNotion` and
 * `restoreFromNotion` were removed deliberately: a whole-board projection into
 * a tracker was a sql.js-era hedge against a fragile local store, and the store
 * is one better-sqlite3 database owned by one host now. Bulk publication of a
 * board into a tracker is the per-project seed's job
 * (.switchboard/plans/seed-board-projects-to-linear-projects.md), which needs a
 * destination mapping this service does not have.
 * `provider-capability-parity-contract.test.js` ratchets the removed names out.
 *
 * The Notion property names written here are SHIPPED STATE in real users'
 * databases — renaming one orphans every page. They are pinned byte-for-byte by
 * `__tests__/NotionSyncService.test.ts` (`npm run test:contract:notion-shipped-schema`).
 *
 * Uses Notion API with rate limiting (~3 requests/sec = 350ms delay).
 */
export class NotionSyncService {
    private _workspaceRoot: string;
    private _configPath: string;
    /** Pre-rename config path — read once and migrated forward; never deleted. */
    private _legacyConfigPath: string;
    private _notionFetchService: NotionFetchService;

    constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
        this._workspaceRoot = workspaceRoot;
        this._configPath = path.join(workspaceRoot, '.switchboard', 'notion-sync-config.json');
        this._legacyConfigPath = path.join(workspaceRoot, '.switchboard', 'notion-backup-config.json');
        this._notionFetchService = new NotionFetchService(workspaceRoot, secretStorage);
    }

    // ── Config I/O ──────────────────────────────────────────────

    async loadConfig(): Promise<NotionSyncConfig | null> {
        const current = await this._readConfigFile(this._configPath);
        if (current) { return current; }
        // Legacy path (pre-rename). Read it and migrate forward, preserving
        // unknown keys — never assume a prior migration already ran.
        const legacy = await this._readConfigFile(this._legacyConfigPath);
        if (!legacy) { return null; }
        try { await this.saveConfig(legacy); } catch { /* serve the legacy value regardless */ }
        return legacy;
    }

    /**
     * Parse a config file, or null when it is absent. A *corrupt* file throws
     * (loud) rather than reading as unconfigured — the two are not the same
     * state and must not be indistinguishable.
     */
    private async _readConfigFile(filePath: string): Promise<NotionSyncConfig | null> {
        let content: string;
        try { content = await fs.promises.readFile(filePath, 'utf8'); }
        catch { return null; }
        return JSON.parse(content) as NotionSyncConfig;
    }

    async saveConfig(config: NotionSyncConfig): Promise<void> {
        await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
        await fs.promises.writeFile(this._configPath, JSON.stringify(config, null, 2));
    }

    // ── URL Parsing ─────────────────────────────────────────────

    parseDatabaseId(url: string): string | null {
        return this._notionFetchService.parsePageId(url);
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
                // Feature structure — 'Is Feature' is created up-front; the 'Feature' self-relation
                // is added post-creation via _ensureFeatureProperties (Notion requires the DB
                // to exist before a relation can reference it).
                'Is Feature': { checkbox: {} }
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
        columnNames: string[],
        options?: { realTimeSyncEnabled?: boolean; deleteSyncEnabled?: boolean; inboundDeleteEnabled?: boolean }
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
        // Ensure feature schema properties (Is Feature checkbox + Feature self-relation) exist.
        // Idempotent — upgrades existing DBs in-place; no-op if already present.
        await this._ensureFeatureProperties(plansDatabaseId);

        // 3. Back up the participating plans and write page ids back.
        //    Two-pass: Pass 1 creates/updates all pages (with Is Feature but no Feature relation —
        //    the relation needs the feature's page id, which may not exist yet). Pass 2 PATCHes
        //    each subtask page to set its Feature relation now that all page ids are known.
        const participating = allPlans.filter(p => p.status !== 'deleted' && boardSet.has(p.project || ''));
        let backedUp = 0;
        const planIdToPageId = new Map<string, string>(); // collected during Pass 1
        for (let i = 0; i < participating.length; i++) {
            const plan = participating[i];
            // Pass 1: no featureIdToNotionPageId → Feature relation left empty (filled in Pass 2).
            const result = await this._upsertPlanToNotion(plansDatabaseId, plan);
            if (result.success && result.pageId) {
                await kanbanDb.updateNotionPageIdByPlanFile(plan.planFile, workspaceId, result.pageId);
                // Surface the id to the local triager/reply agent (mirror Linear's
                // `**Linear Issue ID:**`) so it can post replies via the notion-api protocol.
                await this._writeNotionPageIdMetadata(plan.planFile, result.pageId);
                planIdToPageId.set(plan.planId, result.pageId);
                backedUp++;
            }
            if (participating.length > 1) { await this._delay(350); }
        }

        // Pass 2: for each subtask with a featureId, PATCH its page to set the Feature relation.
        // Only plans whose feature has a known page id (from Pass 1) get the relation.
        for (const plan of participating) {
            if (!plan.featureId) { continue; }
            const featurePageId = planIdToPageId.get(plan.featureId);
            if (!featurePageId) { continue; } // feature not on this board or not backed up
            const subtaskPageId = planIdToPageId.get(plan.planId);
            if (!subtaskPageId) { continue; }
            try {
                await this._notionFetchService.httpRequest('PATCH', `/pages/${subtaskPageId}`, {
                    properties: { 'Feature': { relation: [{ id: featurePageId }] } }
                }, 10000);
            } catch (e) {
                console.warn(`[NotionSyncService] Pass 2: failed to set Feature relation for ${plan.planId}:`, e);
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
        await saveNotionRemoteSetup(kanbanDb, {
            plansDatabaseId,
            commentsDatabaseId,
            botId,
            ...(options?.realTimeSyncEnabled !== undefined ? { realTimeSyncEnabled: options.realTimeSyncEnabled } : {}),
            ...(options?.deleteSyncEnabled !== undefined ? { deleteSyncEnabled: options.deleteSyncEnabled } : {}),
            ...(options?.inboundDeleteEnabled !== undefined ? { inboundDeleteEnabled: options.inboundDeleteEnabled } : {})
        });

        const now = new Date().toISOString();
        // Cursor + seen keys MUST match RemoteControlService's `remote.{state,comment}Cursor.notion`.
        await kanbanDb.setConfig('remote.stateCursor.notion', now);
        await kanbanDb.setConfig('remote.commentCursor.notion', now);
        await kanbanDb.setConfig('remote.commentSeen.notion', '[]');

        return { success: true, backedUp, plansDatabaseUrl: config?.databaseUrl, commentsDatabaseId };
    }

    /**
     * Insert/replace a `> **Notion Page ID:** <id>` metadata line in the plan file so the
     * local triager/reply agent can resolve the id for the notion-api bridge protocol.
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
            console.warn('[NotionSyncService] _writeNotionPageIdMetadata failed:', e);
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
            console.warn('[NotionSyncService] _ensureColumnSelectOptions failed:', e);
        }
    }

    /**
     * Idempotently ensure the `Is Feature` (checkbox) and `Feature` (single-property self-relation)
     * properties exist on the plans DB. The `Feature` relation is a self-relation — Notion
     * requires the database to exist before a relation can reference it, so it is PATCHed
     * in after creation (same pattern as `_ensureColumnSelectOptions`). Safe to call on
     * every setup — only PATCHes properties that are missing.
     */
    private async _ensureFeatureProperties(databaseId: string): Promise<void> {
        try {
            const dbResult = await this._notionFetchService.httpRequest('GET', `/databases/${databaseId}`, undefined, 10000);
            if (dbResult.status !== 200) { return; }
            const props = dbResult.data?.properties || {};
            const patch: Record<string, any> = {};
            if (!props['Is Feature']) {
                patch['Is Feature'] = { checkbox: {} };
            }
            if (!props['Feature']) {
                patch['Feature'] = { relation: { database_id: databaseId, type: 'single_property', single_property: {} } };
            }
            if (Object.keys(patch).length > 0) {
                await this._notionFetchService.httpRequest('PATCH', `/databases/${databaseId}`, { properties: patch }, 10000);
            }
        } catch (e) {
            console.warn('[NotionSyncService] _ensureFeatureProperties failed:', e);
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

    private async _upsertPlanToNotion(databaseId: string, plan: KanbanPlanRecord, featureIdToNotionPageId?: Map<string, string>): Promise<{ success: boolean; pageId?: string }> {
        try {
            if (!(await syncOwnershipLease.isOwner())) {
                return { success: false };
            }
            // Query for existing page by Plan ID
            const queryResult = await this._notionFetchService.httpRequest('POST', `/databases/${databaseId}/query`, {
                filter: { property: 'Plan ID', rich_text: { equals: plan.planId } }
            }, 15000);
            const existing = queryResult.data?.results?.[0];

            const properties = this._planToNotionProperties(plan, featureIdToNotionPageId);
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

    private _planToNotionProperties(plan: KanbanPlanRecord, featureIdToNotionPageId?: Map<string, string>): Record<string, any> {
        // Feature relation — needs the feature's Notion page id (not the local planId).
        // If the map is provided and the feature's page exists, set the relation; otherwise
        // leave it empty (Pass 2 of setup sync fills it after all pages are created).
        let featureRelation: { relation: any[] };
        if (plan.featureId && featureIdToNotionPageId) {
            const featurePageId = featureIdToNotionPageId.get(plan.featureId);
            featureRelation = { relation: featurePageId ? [{ id: featurePageId }] : [] };
        } else {
            featureRelation = { relation: [] };
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
            'Is Feature': { checkbox: Boolean(plan.isFeature) },
            'Feature': featureRelation
        };
    }

    private async _delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}