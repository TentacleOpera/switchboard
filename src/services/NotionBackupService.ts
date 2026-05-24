import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { NotionFetchService } from './NotionFetchService';
import { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';

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

        for (let i = 0; i < allPlans.length; i++) {
            const plan = allPlans[i];
            progress?.report({ message: `Backing up plan ${i + 1} of ${total}...` });
            const result = await this._upsertPlanToNotion(config.databaseId, plan);
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
        const columnUpdates: Array<{ sessionId: string; column: string }> = [];
        let skipped = 0;

        for (let i = 0; i < notionPages.length; i++) {
            const page = notionPages[i];
            progress?.report({ message: `Restoring plan ${i + 1} of ${notionPages.length}...` });
            const plan = this._notionPageToPlanRecord(page);
            if (!plan) { continue; }

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
                    columnUpdates.push({ sessionId: plan.sessionId, column: plan.kanbanColumn });
                }
            }
            toRestore.push(plan);
            if (notionPages.length > 1) { await this._delay(10); }
        }

        if (toRestore.length > 0) {
            await kanbanDb.upsertPlans(toRestore);
        }
        for (const { sessionId, column } of columnUpdates) {
            await kanbanDb.updateColumn(sessionId, column);
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
                    { name: 'linear-automation', color: 'yellow' }
                ] } },
                'ClickUp Task ID': { rich_text: {} },
                'Linear Issue ID': { rich_text: {} }
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

    private async _upsertPlanToNotion(databaseId: string, plan: KanbanPlanRecord): Promise<{ success: boolean }> {
        try {
            // Query for existing page by Plan ID
            const queryResult = await this._notionFetchService.httpRequest('POST', `/databases/${databaseId}/query`, {
                filter: { property: 'Plan ID', rich_text: { equals: plan.planId } }
            }, 15000);
            const existing = queryResult.data?.results?.[0];

            const properties = this._planToNotionProperties(plan);
            if (existing) {
                await this._notionFetchService.httpRequest('PATCH', `/pages/${existing.id}`, { properties }, 10000);
            } else {
                await this._notionFetchService.httpRequest('POST', '/pages', {
                    parent: { database_id: databaseId },
                    properties
                }, 15000);
            }
            return { success: true };
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

    private _planToNotionProperties(plan: KanbanPlanRecord): Record<string, any> {
        return {
            'Topic': { title: [{ text: { content: plan.topic } }] },
            'Plan ID': { rich_text: [{ text: { content: plan.planId } }] },
            'Session ID': { rich_text: [{ text: { content: plan.sessionId } }] },
            'Kanban Column': { select: { name: plan.kanbanColumn } },
            'Status': { select: { name: plan.status } },
            'Complexity': { number: Number(plan.complexity) || 0 },
            'Tags': { multi_select: plan.tags.split(',').map(t => t.trim()).filter(Boolean).map(name => ({ name })) },
            'Dependencies': { rich_text: [{ text: { content: plan.dependencies } }] },
            'Repo Scope': { rich_text: [{ text: { content: plan.repoScope } }] },
            'Workspace ID': { rich_text: [{ text: { content: plan.workspaceId } }] },
            'Created At': { date: { start: plan.createdAt } },
            'Updated At': { date: { start: plan.updatedAt } },
            'Last Action': { rich_text: [{ text: { content: plan.lastAction } }] },
            'Source Type': { select: { name: plan.sourceType } },
            'ClickUp Task ID': { rich_text: [{ text: { content: plan.clickupTaskId || '' } }] },
            'Linear Issue ID': { rich_text: [{ text: { content: plan.linearIssueId || '' } }] }
        };
    }

    private _notionPageToPlanRecord(page: any): KanbanPlanRecord | null {
        try {
            const p = page.properties;
            const getRichText = (prop: any): string => prop?.rich_text?.[0]?.plain_text || '';
            const getTitle = (prop: any): string => prop?.title?.[0]?.plain_text || '';
            const getSelect = (prop: any): string => prop?.select?.name || '';
            const getDate = (prop: any): string => prop?.date?.start || '';
            const getNumber = (prop: any): number => prop?.number ?? 0;
            const getMultiSelect = (prop: any): string => (prop?.multi_select || []).map((t: any) => t.name).join(',');

            return {
                planId: getRichText(p['Plan ID']),
                sessionId: getRichText(p['Session ID']),
                topic: getTitle(p['Topic']),
                planFile: '',
                kanbanColumn: getSelect(p['Kanban Column']),
                status: getSelect(p['Status']) as KanbanPlanRecord['status'],
                complexity: String(getNumber(p['Complexity'])),
                tags: getMultiSelect(p['Tags']),
                dependencies: getRichText(p['Dependencies']),
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
                hasWorktree: getNumber(p['Has Worktree']),
                clickupTaskId: getRichText(p['ClickUp Task ID']),
                linearIssueId: getRichText(p['Linear Issue ID'])
            };
        } catch {
            return null;
        }
    }

    private async _delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}