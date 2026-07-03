import type { ClickUpSyncService } from '../ClickUpSyncService';
import type { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';
import type { RemoteProvider, RemoteStateDelta, RemoteCommentDelta, RemoteProviderCapabilities, ProjectContextBundle, ProjectContextPushResult, ArchiveResult } from './RemoteProvider';

/**
 * ClickUp backend for the unified push dispatch — push-only by design.
 *
 * ClickUp is NOT a remote-control (pull) provider. It stays a push-only stakeholder-visibility
 * mirror. The pull methods return empty results; `capabilities.pull = false` gates the UI
 * honestly so no toggle ever offers a capability ClickUp lacks.
 *
 * `pushState` delegates to `ClickUpSyncService.syncPlan` (which takes a full KanbanPlanRecord).
 * The adapter looks up the plan record by `clickupTaskId` from the DB, sets the target column,
 * and calls `syncPlan` — preserving the `isSyncInProgress` loop guard and `columnMappings` logic
 * inside `syncPlan`.
 */

interface ClickUpRemoteProviderDeps {
    db: KanbanDatabase;
    getWorkspaceId: () => Promise<string>;
    getPlansDir?: () => Promise<string>;
    log?: (msg: string) => void;
}

export class ClickUpRemoteProvider implements RemoteProvider {
    public readonly kind = 'clickup' as const;
    public readonly capabilities: RemoteProviderCapabilities = { pull: false, push: true, projectContextPush: false, archive: false };
    private _clickup: ClickUpSyncService;
    private _deps: ClickUpRemoteProviderDeps;

    constructor(clickup: ClickUpSyncService, deps: ClickUpRemoteProviderDeps) {
        this._clickup = clickup;
        this._deps = deps;
    }

    private _log(msg: string): void {
        (this._deps.log || (() => { /* noop */ }))(`[ClickUpRemoteProvider] ${msg}`);
    }

    // ── Pull methods (stub — ClickUp is pull-false by design) ───────

    public async fetchStateDeltas(_sinceCursor: string): Promise<{ deltas: RemoteStateDelta[]; nextCursor: string }> {
        return { deltas: [], nextCursor: _sinceCursor };
    }

    public async fetchCommentDeltas(_sinceCursor: string): Promise<{ deltas: RemoteCommentDelta[]; nextCursor: string }> {
        return { deltas: [], nextCursor: _sinceCursor };
    }

    public stateKeyToColumn(_stateKey: string): string | undefined {
        return undefined;
    }

    public async refreshLocalPlanFromRemote(_remoteId: string): Promise<void> {
        // No-op — ClickUp is pull-false.
    }

    public async importRemotePlan(_remoteId: string): Promise<KanbanPlanRecord | null> {
        return null;
    }

    public async postComment(_remoteId: string, _body: string): Promise<void> {
        // No-op — ClickUp remote control (pull) is not supported.
    }

    // ── Push methods (delegate to ClickUpSyncService) ───────────────

    public async pushState(remoteId: string, column: string): Promise<void> {
        // syncPlan takes a full KanbanPlanRecord — look it up by clickupTaskId.
        try {
            const workspaceId = await this._deps.getWorkspaceId();
            if (!workspaceId) { return; }
            // Find the plan by clickupTaskId. The DB doesn't have a direct lookup by
            // clickupTaskId, so we scan all plans and match.
            const allPlans = await this._deps.db.getAllPlans(workspaceId);
            const plan = allPlans.find(p => p.clickupTaskId === remoteId && p.status !== 'deleted');
            if (!plan) {
                this._log(`pushState: no plan found for clickupTaskId ${remoteId} — skipping.`);
                return;
            }
            // Set the target column on the record before calling syncPlan.
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

    // ── Project-context / archive (not applicable — ClickUp is a push-only mirror) ──

    public async pushProjectContext(_bundle: ProjectContextBundle): Promise<ProjectContextPushResult> {
        return { ok: true, skipped: true, detail: 'ClickUp is a push-only stakeholder mirror — no project context' };
    }

    public async archiveCard(_remoteId: string): Promise<ArchiveResult> {
        return { ok: true, skipped: true };
    }
}
