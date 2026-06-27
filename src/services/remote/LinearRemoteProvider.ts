import * as fs from 'fs';
import type { LinearSyncService } from '../LinearSyncService';
import type { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';
import { hasMarker } from '../commentMarker';
import type { RemoteProvider, RemoteStateDelta, RemoteCommentDelta } from './RemoteProvider';
import { importRemoteMarkdownPlan } from './importRemotePlan';

/**
 * Linear backend for Remote Control delta polling.
 *
 * TWO separate queries (research-confirmed, docs/technical_platform_integration_analysis.md):
 *  - State: `issues(filter:{ updatedAt:{ gt: cursor } })` — `updatedAt` tracks issue
 *    property changes (state, priority, assignee, description, title).
 *  - Comments: `comments(filter:{ createdAt:{ gt: cursor } })` queried as a SEPARATE entity,
 *    because creating a comment does NOT bump the parent issue's `updatedAt`.
 */

interface LinearRemoteProviderDeps {
    db?: KanbanDatabase;
    getWorkspaceId?: () => Promise<string>;
    getPlansDir?: () => Promise<string>;
    log?: (msg: string) => void;
}

export class LinearRemoteProvider implements RemoteProvider {
    public readonly kind = 'linear' as const;
    private _linear: LinearSyncService;
    private _deps: LinearRemoteProviderDeps;
    private _stateIdToColumn: Record<string, string> = {};

    constructor(linear: LinearSyncService, deps: LinearRemoteProviderDeps = {}) {
        this._linear = linear;
        this._deps = deps;
    }

    public async fetchStateDeltas(sinceCursor: string): Promise<{ deltas: RemoteStateDelta[]; nextCursor: string }> {
        const config = await this._linear.loadConfig();
        if (!config?.setupComplete) { return { deltas: [], nextCursor: sinceCursor }; }
        this._stateIdToColumn = {};
        for (const [column, stateId] of Object.entries(config.columnToStateId || {})) {
            if (stateId) { this._stateIdToColumn[stateId] = column; }
        }

        // The cursor is an ISO timestamp we mint ourselves; JSON.stringify quotes it
        // safely. Inlining avoids guessing Linear's DateTime filter scalar variable name.
        const since = JSON.stringify(String(sinceCursor || ''));
        const QUERY = `
          query {
            issues(filter: { updatedAt: { gt: ${since} } }, first: 100) {
              nodes { id updatedAt state { id } }
            }
          }
        `;
        const deltas: RemoteStateDelta[] = [];
        let nextCursor = sinceCursor;
        try {
            const resp = await this._linear.graphqlRequest(QUERY, {});
            const nodes = resp?.data?.issues?.nodes || [];
            for (const node of nodes) {
                const remoteId = String(node.id || '');
                const stateKey = String(node.state?.id || '');
                if (remoteId && stateKey) { deltas.push({ remoteId, stateKey }); }
                const ts = String(node.updatedAt || '');
                if (ts && ts > nextCursor) { nextCursor = ts; }
            }
        } catch (e) {
            console.warn('[LinearRemoteProvider] fetchStateDeltas failed:', e);
        }
        return { deltas, nextCursor };
    }

    public async fetchCommentDeltas(sinceCursor: string): Promise<{ deltas: RemoteCommentDelta[]; nextCursor: string }> {
        const config = await this._linear.loadConfig();
        if (!config?.setupComplete) { return { deltas: [], nextCursor: sinceCursor }; }

        const since = JSON.stringify(String(sinceCursor || ''));
        const QUERY = `
          query {
            comments(filter: { createdAt: { gt: ${since} } }, first: 100) {
              nodes { id body createdAt issue { id } }
            }
          }
        `;
        const deltas: RemoteCommentDelta[] = [];
        let nextCursor = sinceCursor;
        try {
            const resp = await this._linear.graphqlRequest(QUERY, {});
            const nodes = resp?.data?.comments?.nodes || [];
            for (const node of nodes) {
                const remoteId = String(node.issue?.id || '');
                const commentId = String(node.id || '');
                const body = String(node.body || '');
                const createdAt = String(node.createdAt || '');
                if (!remoteId || !commentId || !createdAt) { continue; }
                deltas.push({ remoteId, commentId, body, createdAt, authoredBySelf: hasMarker(body) });
                if (createdAt > nextCursor) { nextCursor = createdAt; }
            }
        } catch (e) {
            console.warn('[LinearRemoteProvider] fetchCommentDeltas failed:', e);
        }
        return { deltas, nextCursor };
    }

    public stateKeyToColumn(stateKey: string): string | undefined {
        return this._stateIdToColumn[stateKey];
    }

    public async refreshLocalPlanFromRemote(remoteId: string): Promise<void> {
        // Pull the Linear issue description into the local plan file before dispatch.
        try {
            if (!this._deps.db || !this._deps.getWorkspaceId) { return; }
            const workspaceId = await this._deps.getWorkspaceId();
            if (!workspaceId) { return; }
            const plan = await this._deps.db.findPlanByLinearIssueId(workspaceId, remoteId);
            if (!plan || !plan.planFile) { return; }
            const issue = await this._linear.getIssue(remoteId);
            const body = this._renderIssue(issue, remoteId);
            if (!body.trim()) { return; } // never clobber with an empty render
            await fs.promises.writeFile(plan.planFile, body, 'utf8');
        } catch (e) {
            this._deps.log?.(`[LinearRemoteProvider] refreshLocalPlanFromRemote failed for ${remoteId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    public async importRemotePlan(remoteId: string): Promise<KanbanPlanRecord | null> {
        try {
            if (!this._deps.db || !this._deps.getWorkspaceId || !this._deps.getPlansDir) { return null; }
            const workspaceId = await this._deps.getWorkspaceId();
            const plansDir = await this._deps.getPlansDir();
            if (!workspaceId || !plansDir) { return null; }
            const issue = await this._linear.getIssue(remoteId);
            if (!issue) { return null; }
            const rec = await importRemoteMarkdownPlan({
                db: this._deps.db, workspaceId, plansDir,
                title: issue.title || `Linear ${remoteId}`,
                body: this._renderIssue(issue, remoteId),
                sourceType: 'linear-import',
            });
            if (!rec) { return null; }
            await this._deps.db.updateLinearIssueIdByPlanFile(rec.planFile, workspaceId, remoteId);
            return await this._deps.db.findPlanByLinearIssueId(workspaceId, remoteId);
        } catch (e) {
            this._deps.log?.(`[LinearRemoteProvider] importRemotePlan failed for ${remoteId}: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }

    private _renderIssue(issue: { title?: string; description?: string } | null, remoteId: string): string {
        if (!issue) { return ''; }
        const title = issue.title || `Linear Issue ${remoteId}`;
        const description = String(issue.description || '').trim();
        return `# ${title}\n\n> **Linear Issue ID:** ${remoteId}\n\n${description}`;
    }
}
