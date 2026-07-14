import * as fs from 'fs';
import type { ClickUpSyncService } from '../ClickUpSyncService';
import type { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';
import type { RemoteProvider, RemoteStateDelta, RemoteCommentDelta, RemoteProviderCapabilities, ProjectContextBundle, ProjectContextPushResult, ArchiveResult } from './RemoteProvider';
import { importRemoteMarkdownPlan } from './importRemotePlan';

/**
 * ClickUp backend for the unified remote control — state pull & push.
 *
 * ClickUp is promoted to a state-pull remote control provider. Comment-bus
 * remains explicitly unsupported.
 */

interface ClickUpRemoteProviderDeps {
    db: KanbanDatabase;
    getWorkspaceId: () => Promise<string>;
    getPlansDir?: () => Promise<string>;
    log?: (msg: string) => void;
}

export class ClickUpRemoteProvider implements RemoteProvider {
    public readonly kind = 'clickup' as const;
    public readonly capabilities: RemoteProviderCapabilities = { pull: true, push: true, projectContextPush: false, archive: false };
    private _clickup: ClickUpSyncService;
    private _deps: ClickUpRemoteProviderDeps;
    private _listIdToColumn: Record<string, string> = {};

    constructor(clickup: ClickUpSyncService, deps: ClickUpRemoteProviderDeps) {
        this._clickup = clickup;
        this._deps = deps;
    }

    private _log(msg: string): void {
        (this._deps.log || (() => { /* noop */ }))(`[ClickUpRemoteProvider] ${msg}`);
    }

    private _renderTask(task: any, remoteId: string): string {
        if (!task) { return ''; }
        const title = String(task.name || '').trim();
        const description = String(task.markdownDescription || '').trim();
        if (!title && !description) { return ''; }
        return `# ${title || `ClickUp Task ${remoteId}`}\n\n> **ClickUp Task ID:** ${remoteId}\n\n${description}`;
    }

    // ── Pull methods ─────────────────────────────────────────────────

    public async fetchStateDeltas(sinceCursor: string): Promise<{ deltas: RemoteStateDelta[]; nextCursor: string }> {
        const config = await this._clickup.loadConfig();
        if (!config?.setupComplete) { return { deltas: [], nextCursor: sinceCursor }; }

        this._listIdToColumn = {};
        for (const [column, listId] of Object.entries(config.columnMappings || {})) {
            if (listId) { this._listIdToColumn[listId] = column; }
        }

        const sinceMs = sinceCursor ? Date.parse(sinceCursor) : 0;
        const deltas: RemoteStateDelta[] = [];
        let nextCursor = sinceCursor;

        try {
            const listIds = Object.values(config.columnMappings || {});
            const allTasks: { task: any; listId: string }[] = [];
            for (const listId of listIds) {
                if (!listId) { continue; }
                const tasks = await this._clickup.getListTasks(listId, { dateUpdatedGt: sinceMs, includeClosed: false });
                for (const t of tasks) {
                    allTasks.push({ task: t, listId });
                }
            }

            // Dedup across lists by task.id (keep the entry with the latest dateUpdated)
            const grouped = new Map<string, { task: any; listId: string }>();
            for (const item of allTasks) {
                const existing = grouped.get(item.task.id);
                if (!existing || Number(item.task.dateUpdated || 0) > Number(existing.task.dateUpdated || 0)) {
                    grouped.set(item.task.id, item);
                }
            }

            for (const item of grouped.values()) {
                const task = item.task;
                const remoteId = String(task.id || '');
                const stateKey = String(task.list?.id || item.listId || '');
                const updatedAt = task.dateUpdated && !isNaN(Number(task.dateUpdated))
                    ? new Date(Number(task.dateUpdated)).toISOString()
                    : '';
                const description = task.markdownDescription || '';

                if (remoteId && stateKey) {
                    deltas.push({
                        remoteId,
                        stateKey,
                        updatedAt: updatedAt || undefined,
                        description: description || undefined,
                    });
                }
                if (updatedAt && (!nextCursor || updatedAt > nextCursor)) {
                    nextCursor = updatedAt;
                }
            }
        } catch (e) {
            this._log(`fetchStateDeltas failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        return { deltas, nextCursor };
    }

    public async fetchCommentDeltas(sinceCursor: string): Promise<{ deltas: RemoteCommentDelta[]; nextCursor: string }> {
        return { deltas: [], nextCursor: sinceCursor };
    }

    public stateKeyToColumn(stateKey: string): string | undefined {
        return this._listIdToColumn[stateKey];
    }

    public async refreshLocalPlanFromRemote(remoteId: string): Promise<void> {
        try {
            if (!this._deps.db || !this._deps.getWorkspaceId) { return; }
            const workspaceId = await this._deps.getWorkspaceId();
            if (!workspaceId) { return; }
            const plan = await this._deps.db.findPlanByClickUpTaskId(workspaceId, remoteId);
            if (!plan || !plan.planFile) { return; }
            const { task } = await this._clickup.getTaskDetails(remoteId);
            const body = this._renderTask(task, remoteId);
            if (!body.trim()) { return; }
            await fs.promises.writeFile(plan.planFile, body, 'utf8');
        } catch (e) {
            this._log(`refreshLocalPlanFromRemote failed for ${remoteId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    public async importRemotePlan(remoteId: string): Promise<KanbanPlanRecord | null> {
        try {
            if (!this._deps.db || !this._deps.getWorkspaceId || !this._deps.getPlansDir) { return null; }
            const workspaceId = await this._deps.getWorkspaceId();
            const plansDir = await this._deps.getPlansDir();
            if (!workspaceId || !plansDir) { return null; }
            const { task } = await this._clickup.getTaskDetails(remoteId);
            if (!task) { return null; }
            const rec = await importRemoteMarkdownPlan({
                db: this._deps.db,
                workspaceId,
                plansDir,
                title: task.name || `ClickUp ${remoteId}`,
                body: this._renderTask(task, remoteId),
                sourceType: 'clickup-import',
            });
            if (!rec) { return null; }
            await this._deps.db.updateClickUpTaskIdByPlanFile(rec.planFile, workspaceId, remoteId);
            return await this._deps.db.findPlanByClickUpTaskId(workspaceId, remoteId);
        } catch (e) {
            this._log(`importRemotePlan failed for ${remoteId}: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }

    public async postComment(_remoteId: string, _body: string): Promise<void> {
        // No-op — ClickUp comment-bus is not supported.
    }

    // ── Push methods (delegate to ClickUpSyncService) ───────────────

    public async pushState(remoteId: string, column: string): Promise<void> {
        try {
            const workspaceId = await this._deps.getWorkspaceId();
            if (!workspaceId) { return; }
            const plan = await this._deps.db.findPlanByClickUpTaskId(workspaceId, remoteId);
            if (!plan) {
                this._log(`pushState: no plan found for clickupTaskId ${remoteId} — skipping.`);
                return;
            }
            plan.kanbanColumn = column;
            const result = await this._clickup.syncPlan(plan);
            if (!result.success) {
                this._log(`pushState: syncPlan failed for ${remoteId}: ${result.error || 'unknown'}`);
            }
        } catch (e) {
            this._log(`pushState failed for ${remoteId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    public async pushContent(remoteId: string, markdown: string): Promise<void> {
        const result = await this._clickup.syncPlanContent(remoteId, markdown);
        if (!result.success) {
            throw new Error(`ClickUp pushContent failed for ${remoteId}: ${result.error || 'unknown error'}`);
        }
    }

    // ── Project-context / archive ────────────────────────────────────

    public async pushProjectContext(_bundle: ProjectContextBundle): Promise<ProjectContextPushResult> {
        return { ok: true, skipped: true, detail: 'ClickUp project-context push is not supported' };
    }

    public async archiveCard(_remoteId: string): Promise<ArchiveResult> {
        return { ok: true, skipped: true };
    }
}
