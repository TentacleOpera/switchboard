import * as fs from 'fs';
import type { LinearSyncService } from '../LinearSyncService';
import type { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';
import { hasMarker } from '../commentMarker';
import type {
    RemoteProvider, RemoteStateDelta, RemoteCommentDelta,
    RemoteProviderCapabilities, ProjectContextBundle, ProjectContextPushResult,
    ArchiveResult
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
    public readonly capabilities: RemoteProviderCapabilities = { pull: true, push: true, projectContextPush: true, archive: true };
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

    // ── Project-context push (feature: Project Context & Remote UI Hub) ──────
    //
    // Upserts a "Switchboard Project Context" document (Dev Docs + PRDs +
    // constitution, markdown) on each Linear project matching a configured
    // board name. Linear documents take markdown directly — no conversion.

    private static readonly CONTEXT_DOC_TITLE = 'Switchboard Project Context';

    public async pushProjectContext(bundle: ProjectContextBundle): Promise<ProjectContextPushResult> {
        const config = await this._linear.loadConfig();
        if (!config?.setupComplete || !config.teamId) {
            return { ok: true, skipped: true, detail: 'Linear not set up' };
        }

        let projects: { id: string; name: string }[];
        try {
            projects = await this._linear.getAvailableProjects();
        } catch (e) {
            return { ok: false, detail: `Could not list Linear projects: ${e instanceof Error ? e.message : String(e)}` };
        }

        // Board names match Linear project names by the sync convention; fall back
        // to the configured selected project when no board name resolves.
        const wanted = new Set(
            bundle.boards.filter(b => b).map(b => b.toLowerCase())
        );
        let targets = projects.filter(p => wanted.has(p.name.toLowerCase()));
        if (targets.length === 0 && config.selectedProjectName) {
            targets = projects.filter(p => p.name.toLowerCase() === config.selectedProjectName!.toLowerCase());
        }
        if (targets.length === 0) {
            return { ok: true, skipped: true, detail: 'No Linear project matches the configured boards' };
        }

        const errors: string[] = [];
        for (const project of targets) {
            try {
                await this._upsertContextDocument(project.id, bundle.combinedMarkdown);
            } catch (e) {
                errors.push(`${project.name}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        if (errors.length === targets.length) {
            return { ok: false, detail: `All project doc writes failed — ${errors.join('; ')}` };
        }
        return {
            ok: true,
            detail: errors.length
                ? `updated ${targets.length - errors.length}/${targets.length} project doc(s); failed: ${errors.join('; ')}`
                : `updated ${targets.length} project doc(s)`,
        };
    }

    /** Find the context document on a project by title and update it, else create it. */
    private async _upsertContextDocument(projectId: string, markdown: string): Promise<void> {
        const existing = await this._linear.graphqlRequest(`
            query($projectId: String!) {
              project(id: $projectId) { documents { nodes { id title } } }
            }
        `, { projectId });
        const nodes = existing?.data?.project?.documents?.nodes || [];
        const match = nodes.find((n: any) => String(n?.title || '').trim() === LinearRemoteProvider.CONTEXT_DOC_TITLE);

        if (match?.id) {
            const updated = await this._linear.graphqlRequest(`
                mutation($id: String!, $input: DocumentUpdateInput!) {
                  documentUpdate(id: $id, input: $input) { success }
                }
            `, { id: String(match.id), input: { content: markdown } });
            if (updated?.data?.documentUpdate?.success !== true) {
                throw new Error('documentUpdate returned success=false');
            }
            return;
        }

        const created = await this._linear.graphqlRequest(`
            mutation($input: DocumentCreateInput!) {
              documentCreate(input: $input) { success document { id } }
            }
        `, { input: { title: LinearRemoteProvider.CONTEXT_DOC_TITLE, content: markdown, projectId } });
        if (created?.data?.documentCreate?.success !== true) {
            throw new Error('documentCreate returned success=false');
        }
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
}
