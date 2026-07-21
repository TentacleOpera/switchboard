import * as fs from 'fs';
import type { LinearSyncService } from '../LinearSyncService';
import type { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';
import { hasMarker } from '../commentMarker';
import type {
    RemoteProvider, RemoteStateDelta, RemoteCommentDelta,
    RemoteProviderCapabilities, ArchiveResult
} from './RemoteProvider';
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
    public readonly capabilities: RemoteProviderCapabilities = { pull: true, push: true, archive: true };
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
              nodes { id updatedAt description state { id } parent { id } children { nodes { id } } }
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
                const updatedAt = String(node.updatedAt || '');
                const description = String(node.description || '');
                if (remoteId && stateKey) {
                    deltas.push({
                        remoteId,
                        stateKey,
                        // Feature structure — parent/children are native Linear GraphQL fields.
                        // updatedAt bumps on parentId changes (issue property update), so a
                        // parent/child link change IS detected by this delta query.
                        parentRemoteId: String(node.parent?.id || ''),
                        isFeatureCandidate: (node.children?.nodes?.length || 0) > 0,
                        updatedAt: updatedAt || undefined,
                        description: description || undefined,
                    });
                }
                if (updatedAt && updatedAt > nextCursor) { nextCursor = updatedAt; }
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

    public async postComment(remoteId: string, body: string): Promise<void> {
        const result = await this._linear.postManagedComment(remoteId, body);
        if (!result.success) {
            throw new Error(`Linear postComment failed for ${remoteId}: ${result.error || 'unknown error'}`);
        }
    }

    public async archiveCard(remoteId: string): Promise<ArchiveResult> {
        const config = await this._linear.loadConfig();
        if (!config?.setupComplete) {
            return { ok: true, skipped: true };
        }
        const id = String(remoteId || '').trim();
        if (!id) {
            return { ok: false, error: 'No remote id provided' };
        }
        const result = await this._linear.archiveIssue(id);
        return result.success
            ? { ok: true }
            : { ok: false, error: result.error };
    }


    public async pushState(remoteId: string, column: string): Promise<void> {
        // Delegate to LinearSyncService.syncPlan — it maps column→stateId, handles
        // completeSyncEnabled gate, and creates/updates the issue. The remoteId IS
        // the Linear issue id; syncPlan looks up the plan by planFile via getIssueIdForPlan,
        // but we already have the issue id, so we use issueUpdate directly.
        try {
            const config = await this._linear.loadConfig();
            if (!config?.setupComplete) { return; }
            if (!(await this._linear.hasApiToken())) { return; }
            const stateId = config.columnToStateId[column];
            if (!stateId) {
                this._deps.log?.(`[LinearRemoteProvider] pushState: no Linear state mapped for column "${column}" — skipping.`);
                return;
            }
            const result = await this._linear.graphqlRequest(`
                mutation($id: String!, $stateId: String!) {
                    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
                }
            `, { id: remoteId, stateId });
            if (!result?.data?.issueUpdate?.success) {
                this._deps.log?.(`[LinearRemoteProvider] pushState: issueUpdate failed for ${remoteId}.`);
            }
        } catch (e) {
            this._deps.log?.(`[LinearRemoteProvider] pushState failed for ${remoteId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    public async pushContent(remoteId: string, markdown: string): Promise<void> {
        // Delegate to LinearSyncService.syncPlanContent — it strips H1, truncates, and
        // calls issueUpdate with the description.
        const result = await this._linear.syncPlanContent(remoteId, markdown);
        if (!result.success) {
            throw new Error(`Linear pushContent failed for ${remoteId}: ${result.error || 'unknown error'}`);
        }
    }

    private _renderIssue(issue: { title?: string; description?: string } | null, remoteId: string): string {
        if (!issue) { return ''; }
        const title = issue.title || `Linear Issue ${remoteId}`;
        const description = String(issue.description || '').trim();
        return `# ${title}\n\n> **Linear Issue ID:** ${remoteId}\n\n${description}`;
    }

    /**
     * Inbound-delete reconcile-sweep (provider-sync inbound-delete). Paginate all
     * non-archived Linear issues in the configured team(s) and collect their ids.
     * Throttled via the graphqlRequest layer's internal retry/backoff. If any page
     * fails, the sweep is reported INCOMPLETE — the caller MUST NOT tombstone the
     * un-fetched tail. Only a fully-completed sweep produces a reliable deletion list.
     *
     * Linear's `issues` query excludes archived issues by default, so a mapped issue
     * that was archived (Linear's "delete" = archive) simply stops appearing →
     * candidate deletion. The probeRemoteId step distinguishes archived (moved) from
     * genuinely-gone (deleted, though Linear keeps the id resolvable as archived).
     */
    public async reconcileLiveIds(): Promise<{ complete: boolean; liveIds: Set<string> }> {
        const config = await this._linear.loadConfig();
        if (!config?.setupComplete) { return { complete: true, liveIds: new Set() }; }
        if (!(await this._linear.hasApiToken())) { return { complete: true, liveIds: new Set() }; }

        const liveIds = new Set<string>();
        let complete = true;
        let cursor: string | null = null;
        const PAGE = 100;
        const MAX = 50; // safety backstop: ≤ 5,000 issues
        try {
            for (let page = 0; page < MAX; page++) {
                const after = cursor ? `, after: ${JSON.stringify(cursor)}` : '';
                const QUERY = `
                  query {
                    issues(first: ${PAGE}${after}) {
                      nodes { id }
                      pageInfo { hasNextPage endCursor }
                    }
                  }
                `;
                const resp = await this._linear.graphqlRequest(QUERY, {});
                const issues = resp?.data?.issues;
                if (!issues) { complete = false; break; }
                for (const node of (issues.nodes || [])) {
                    const id = String(node.id || '');
                    if (id) { liveIds.add(id); }
                }
                if (!issues.pageInfo?.hasNextPage) { break; }
                cursor = issues.pageInfo.endCursor || null;
                if (!cursor) { break; }
            }
        } catch (e) {
            this._deps.log?.(`[LinearRemoteProvider] reconcileLiveIds failed: ${e instanceof Error ? e.message : String(e)} — marking incomplete.`);
            complete = false;
        }
        if (complete) {
            this._deps.log?.(`[LinearRemoteProvider] reconcileLiveIds: complete sweep — ${liveIds.size} live issue(s).`);
        } else {
            this._deps.log?.(`[LinearRemoteProvider] reconcileLiveIds: INCOMPLETE — ${liveIds.size} issue(s) before abort; no tombstones will be issued.`);
        }
        return { complete, liveIds };
    }

    /**
     * Inbound-delete disambiguation probe (provider-sync inbound-delete). Re-check
     * the issue id directly: Linear keeps archived issues resolvable, so a found
     * issue with `archivedAt` set is a move (archived, not deleted); a found issue
     * with no `archivedAt` is in scope (shouldn't be reported missing — treat as
     * moved); a not-found/error is 'unknown' (safe skip). Linear has no hard-delete
     * from the API surface (issues are archived), so 'deleted' is only returned
     * when the id is genuinely unresolvable.
     */
    public async probeRemoteId(remoteId: string): Promise<'deleted' | 'moved' | 'unknown'> {
        const id = String(remoteId || '').trim();
        if (!id) { return 'unknown'; }
        try {
            const resp = await this._linear.graphqlRequest(`
                query($id: String!) {
                    issue(id: $id) { id archivedAt state { id } }
                }
            `, { id });
            const issue = resp?.data?.issue;
            if (!issue) { return 'deleted'; }
            // Archived = Linear's "delete". Treat as deleted (the user removed it
            // from the active board). This is the tombstone trigger.
            if (issue.archivedAt) { return 'deleted'; }
            // Exists and not archived — it's in scope, so the sweep shouldn't have
            // reported it missing. Treat as moved (safe skip).
            return 'moved';
        } catch (e) {
            this._deps.log?.(`[LinearRemoteProvider] probeRemoteId: ${id} threw (${e instanceof Error ? e.message : String(e)}) — treating as unknown.`);
            return 'unknown';
        }
    }
}
