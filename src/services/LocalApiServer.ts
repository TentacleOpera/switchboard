import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { URL } from 'url';
import { ClickUpSyncService } from './ClickUpSyncService';
import { LinearSyncService } from './LinearSyncService';
import type { NotionFetchService } from './NotionFetchService';
import { importPlanFiles } from './PlanFileImporter';
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';

interface LocalApiServerOptions {
    workspaceRoot: string;
    clickupMetadataPath: string;
    linearMetadataPath: string;
    getClickUpService: () => ClickUpSyncService | null;
    getLinearService: () => LinearSyncService | null;
    getNotionService: () => NotionFetchService | null;
    getAuthToken: () => Promise<string>;
    allRoots: string[];
    /**
     * Move a kanban card through the running extension so the move inherits the
     * feature→subtask cascade, the Linear/ClickUp integration-sync fan-out, and the
     * board refresh. Used by the kanban_operations fallback script to keep
     * external trackers in exact sync (its direct-DB path cannot reach the
     * integration token, which lives in VS Code secret storage). Optional —
     * absent in headless/test harnesses.
     */
    moveCard?: (
        workspaceRoot: string,
        sessionId: string,
        targetColumn: string,
        planFile?: string
    ) => Promise<{ success: boolean; error?: string }>;
    /**
     * Create a feature from a set of subtask plan IDs through the running extension so
     * the create inherits the DB upsert, subtask linking, feature-file write, and board
     * refresh. Used by the kanban_operations create-feature.js script. Optional — absent
     * in headless/test harnesses. Note: feature creation does NOT sync to Linear/ClickUp.
     */
    createFeature?: (
        workspaceRoot: string,
        name: string,
        planIds: string[],
        description?: string
    ) => Promise<{ success: boolean; featurePlanId?: string; featureSessionId?: string; error?: string }>;
    /**
     * Batch-assign existing plans to an existing feature through the running extension.
     * Used by the kanban_operations assign-to-feature.js script. Plans already on another
     * feature (or that are themselves features / missing) are reported in `skipped`, not
     * treated as a failure. Optional — absent in headless/test harnesses.
     */
    assignToFeature?: (
        workspaceRoot: string,
        featurePlanId: string,
        planIds: string[]
    ) => Promise<{ success: boolean; assigned: string[]; skipped: string[]; error?: string }>;
    /**
     * Remove a single subtask from its parent feature through the running extension.
     * Used by the kanban_operations remove-from-feature.js script. Detaches the
     * subtask, abandons its worktree, regenerates the feature file, and unlinks
     * from external trackers. Optional — absent in headless/test harnesses.
     */
    removeSubtaskFromFeature?: (
        workspaceRoot: string,
        subtaskPlanId: string
    ) => Promise<{ success: boolean; error?: string }>;
    /**
     * Delete a feature and optionally its subtasks through the running extension.
     * Used by the kanban_operations delete-feature.js script. Abandons all child
     * worktrees, either tombstones or detaches subtasks, tombstones the feature,
     * and unlinks from external trackers. Optional — absent in headless/test harnesses.
     */
    deleteFeature?: (
        workspaceRoot: string,
        featurePlanId: string,
        deleteSubtasks: boolean
    ) => Promise<{ success: boolean; error?: string }>;
    /**
     * Split a feature into two new features, partitioning its subtasks. Used by
     * the kanban_operations split-feature.js script. The original feature is
     * deleted (subtasks detached); `keptPlanIds` go to the first new feature, the
     * rest go to the second. Optional — absent in headless/test harnesses.
     */
    splitFeature?: (
        workspaceRoot: string,
        featurePlanId: string,
        keptPlanIds: string[],
        firstFeatureName: string,
        secondFeatureName: string
    ) => Promise<{ success: boolean; firstFeaturePlanId?: string; secondFeaturePlanId?: string; error?: string }>;
    cleanupWorktree?: (
        workspaceRoot: string,
        worktreeId: string | number
    ) => Promise<{ success: boolean; error?: string }>;
    /**
     * Phone-a-Friend dispatch — reached by a coding agent's `curl` when it finishes a
     * plan batch. The host resolves the Phone-a-Friend terminal, sends `/clear` + a
     * second-pass coder prompt, and silently drops the dispatch if no terminal is
     * running (the callback MUST NOT throw on "no terminal" — a throw becomes a 500
     * and breaks the coder's best-effort signal). `planFile` is an opaque relative
     * path forwarded into the prompt text; the server does NOT resolve/traverse it.
     * `originRole` lets the host resolve the originating coder's saved addons.
     * Optional — absent in headless/test harnesses.
     */
    onPhoneAFriend?: (planFile: string, originRole?: string) => Promise<void>;
    /**
     * Orchestrator request channel — reached by a fleet coding/review agent's
     * `curl` when it needs to raise a question, warning, research request, or
     * blocker to the orchestrator. The host resolves the workspace root and
     * writes the request to `.switchboard/orchestrator/inbox/`. Optional —
     * absent in headless/test harnesses (returns 503).
     */
    onOrchestratorRequest?: (request: {
        stage: string; type: string; from?: string;
        planId?: string; feature?: string; body: string; worktreePath?: string;
    }, workspaceRoot?: string) => Promise<{ success: boolean; file?: string; error?: string }>;
    /**
     * KanbanDatabase accessor for read/management endpoints. LocalApiServer
     * holds no DB handle today; every kanban op above is an injected callback.
     * This accessor lets read endpoints reach the DB. Optional — absent in
     * headless/test harnesses (endpoints return 503).
     */
    getKanbanDatabase?: (workspaceRoot?: string) => Promise<any | null | undefined>;
    /**
     * Orchestration fan-out dispatch — reached by the orchestrator's `curl` after
     * grouping completes. The host resolves the feature's PLAN REVIEWED subtasks,
     * routes each by complexity, resolves its worktree terminal, and dispatches the
     * coder via the established batch-trigger path. Subtasks beyond the concurrency
     * cap stay in PLAN REVIEWED for later wake ticks. Optional — absent in
     * headless/test harnesses (returns 503).
     */
    orchestrationDispatch?: (
        workspaceRoot: string,
        featurePlanId: string
    ) => Promise<{ success: boolean; dispatched?: string[]; skipped?: Array<{ planId: string; reason: string }>; error?: string }>;
    /**
     * Protocol catalog provider — serves the checked-in `protocol-catalog.json`
     * (generated by `scripts/generate-protocol-catalog.js`) so external clients
     * discover every verb/endpoint/payload at runtime. The MCP-free
     * discoverability layer. Optional — absent in headless/test harnesses
     * (returns 404 with a clear "run the scanner" message).
     */
    catalogProvider?: () => Promise<any>;
}

export class LocalApiServer {
    private _server: http.Server | null = null;
    private _port: number;
    private _options: LocalApiServerOptions;
    private _allRoots: string[];
    private _nameResolutionCache: Map<string, { id: string; timestamp: number }> = new Map();
    private readonly _CACHE_TTL_MS = 30000; // 30 seconds
    private readonly _MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
    private _mermaidCliAvailable: boolean | null = null;
    // In-process liveness signal — set true in the listen callback, false on stop/error.
    // The watchdog checks this (NOT a self-HTTP round-trip, which times out on a starved
    // host and produces a false negative).
    private _isListening: boolean = false;

    constructor(options: LocalApiServerOptions) {
        this._options = options;
        this._port = 0; // Will be assigned on start
        this._allRoots = options.allRoots || [];
    }

    /**
     * Start the local API server on a random free port.
     * Returns the port number.
     *
     * Wraps the listen promise in a 5s timeout race: if the host is starved so the
     * listen callback never fires, the promise never settles and the port file is
     * never written (the "no port file ⇒ manual reload" failure mode). On timeout
     * the promise rejects with a clear error so the watchdog can retry.
     */
    async start(): Promise<number> {
        // Cleanup temp files from previous interrupted writes
        await this._cleanupTempFiles();
        this._isListening = false;

        const START_TIMEOUT_MS = 5000;
        const listenPromise = new Promise<number>((resolve, reject) => {
            this._server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
                await this._handleRequest(req, res);
            });

            this._server.listen(0, '127.0.0.1', () => {
                const address = this._server?.address() as { port: number };
                this._port = address.port;
                this._isListening = true;
                console.log(`[LocalApiServer] Started on port ${this._port}`);

                resolve(this._port);
            });

            this._server.on('error', (err: Error) => {
                console.error('[LocalApiServer] Server error:', err);
                this._isListening = false;
                reject(err);
            });
        });

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new Error(`[LocalApiServer] start() timed out after ${START_TIMEOUT_MS}ms (extension host starved — listen callback did not fire)`));
            }, START_TIMEOUT_MS);
        });

        // Clear the timeout timer once the race settles so a successful listen doesn't
        // leave a dangling 5s timer that fires a no-op reject on an already-settled promise.
        return Promise.race([listenPromise, timeoutPromise]).finally(() => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        });
    }

    /**
     * In-process liveness signal for the watchdog. True only when the listen callback
     * has fired and stop() has not run. Do NOT use a self-HTTP round-trip to probe
     * liveness — it times out on a starved host and produces a false negative.
     */
    public isListening(): boolean {
        return this._isListening && this._server !== null;
    }

    public getPort(): number {
        return this._port;
    }

    /**
     * Stop the local API server.
     */
    async stop(): Promise<void> {
        this._isListening = false;
        if (this._server) {
            return new Promise((resolve) => {
                this._server?.close(() => {
                    console.log('[LocalApiServer] Stopped');
                    resolve();
                });
            });
        }
    }

    /**
     * Cleanup temp files from interrupted writes.
     */
    private async _cleanupTempFiles(): Promise<void> {
        try {
            const switchboardDir = path.join(this._options.workspaceRoot, '.switchboard');
            const files = await fs.readdir(switchboardDir);
            for (const file of files) {
                if (file.endsWith('.json.tmp') || file === 'api-server-port.txt.tmp') {
                    await fs.unlink(path.join(switchboardDir, file)).catch(() => {
                        // Ignore errors (file may be locked on Windows)
                    });
                }
            }
        } catch {
            // Directory may not exist yet
        }
    }

    private async _checkAuth(req: http.IncomingMessage, requireAuth: boolean = true): Promise<boolean> {
        // Trust the localhost boundary check already performed in _handleRequest
        return true;
    }

    private async _parseJsonBody(req: http.IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            let body = '';
            let bodySize = 0;
            req.on('data', chunk => {
                body += chunk;
                bodySize += chunk.length;
                if (bodySize > this._MAX_FILE_SIZE_BYTES) {
                    req.destroy();
                    reject(new Error('Payload too large'));
                }
            });
            req.on('end', () => {
                try {
                    if (!body) {
                        resolve(null);
                        return;
                    }
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(new Error('Invalid JSON body'));
                }
            });
            req.on('error', reject);
        });
    }

    private _pruneCache(): void {
        if (this._nameResolutionCache.size < 100) return; // Prevent O(N^2) pruning
        const now = Date.now();
        for (const [key, value] of this._nameResolutionCache.entries()) {
            if (now - value.timestamp >= this._CACHE_TTL_MS) {
                this._nameResolutionCache.delete(key);
            }
        }
    }

    /**
     * §8 — POST /comment. Host-side comment write-back reached by agents over the bridge.
     * Body: { provider: 'linear' | 'clickup' | 'notion', id: string, body: string }.
     * The host stamps the self-marker (Linear/ClickUp) or inserts a Comments-DB row with
     * `From = Switchboard` (Notion); the agent never touches the token or the marker.
     */
    private async _handlePostComment(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const provider = String(body?.provider || '').trim().toLowerCase();
            const id = String(body?.id || '').trim();
            const text = String(body?.body || '');
            if ((provider !== 'linear' && provider !== 'clickup' && provider !== 'notion') || !id || !text.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing or invalid provider/id/body' }));
                return;
            }

            const service = provider === 'linear'
                ? this._options.getLinearService()
                : provider === 'clickup'
                    ? this._options.getClickUpService()
                    : this._options.getNotionService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `${provider} service not available` }));
                return;
            }

            const result = await service.postManagedComment(id, text);
            // Notion surfaces a "setup not run" case as `notConfigured` → 503 so the agent
            // knows to ask the user to run the Remote-tab setup, not retry blindly.
            const code = result.success
                ? 200
                : (result as { notConfigured?: boolean }).notConfigured ? 503 : 502;
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] postComment error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'postComment failed' }));
        }
    }

    /**
     * POST /kanban/move — move a kanban card via the running extension so the move
     * inherits the feature→subtask cascade, the Linear/ClickUp sync fan-out, and the
     * board refresh. Reached by the kanban_operations fallback script over the
     * bridge; the script's direct-DB path cannot sync to external trackers because
     * the integration token lives in VS Code secret storage.
     * Body: { sessionId?: string, planId?: string, targetColumn: string, workspaceRoot?: string, planFile?: string }.
     */
    private async _handleKanbanMove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const moveCard = this._options.moveCard;
        if (!moveCard) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Kanban move not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const sessionId = String(body?.sessionId || '').trim();
            const planId = String(body?.planId || '').trim();
            const effectiveKey = sessionId || planId;
            const targetColumn = String(body?.targetColumn || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const planFile = body?.planFile ? String(body.planFile).trim() : undefined;
            if (!effectiveKey || !targetColumn) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: sessionId/planId and targetColumn' }));
                return;
            }

            const result = await moveCard(workspaceRoot, effectiveKey, targetColumn, planFile);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanMove error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanMove failed' }));
        }
    }

    /**
     * POST /kanban/feature — create a feature from a set of subtask plan IDs via the running
     * extension (DB upsert + subtask linking + feature-file write + board refresh). Reached
     * by the kanban_operations create-feature.js script. Feature creation does NOT sync to
     * Linear/ClickUp. Body: { name: string, planIds: string[], workspaceRoot?: string, description?: string }.
     */
    private async _handleKanbanCreateFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const createFeature = this._options.createFeature;
        if (!createFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature creation not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const name = String(body?.name || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const planIds = Array.isArray(body?.planIds) ? body.planIds.map((p: any) => String(p)) : null;
            const description = body?.description ? String(body.description) : undefined;
            if (!name) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: name' }));
                return;
            }
            if (!planIds || planIds.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'planIds must be a non-empty array' }));
                return;
            }

            const result = await createFeature(workspaceRoot, name, planIds, description);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanCreateFeature error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanCreateFeature failed' }));
        }
    }

    /**
     * POST /kanban/feature/assign — batch-assign existing plans to an existing feature via the
     * running extension. Reached by the kanban_operations assign-to-feature.js script. Plans
     * already on another feature are reported in `skipped`, not treated as a failure.
     * Body: { featurePlanId: string, planIds: string[], workspaceRoot?: string }.
     */
    private async _handleKanbanAssignFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const assignToFeature = this._options.assignToFeature;
        if (!assignToFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature assignment not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const featurePlanId = String(body?.featurePlanId || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const planIds = Array.isArray(body?.planIds) ? body.planIds.map((p: any) => String(p)) : null;
            if (!featurePlanId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: featurePlanId' }));
                return;
            }
            if (!planIds || planIds.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'planIds must be a non-empty array' }));
                return;
            }

            const result = await assignToFeature(workspaceRoot, featurePlanId, planIds);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanAssignFeature error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanAssignFeature failed' }));
        }
    }

    /**
     * Handle POST /kanban/feature/remove — remove a single subtask from its parent
     * feature through the running extension. Reached by the kanban_operations
     * remove-from-feature.js script. Body: { subtaskPlanId: string, workspaceRoot?: string }.
     */
    private async _handleKanbanRemoveSubtaskFromFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const removeSubtaskFromFeature = this._options.removeSubtaskFromFeature;
        if (!removeSubtaskFromFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Subtask removal not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const subtaskPlanId = String(body?.subtaskPlanId || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!subtaskPlanId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: subtaskPlanId' }));
                return;
            }

            const result = await removeSubtaskFromFeature(workspaceRoot, subtaskPlanId);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanRemoveSubtaskFromFeature error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanRemoveSubtaskFromFeature failed' }));
        }
    }

    /**
     * Handle POST /kanban/feature/delete — delete a feature and optionally its
     * subtasks through the running extension. Reached by the kanban_operations
     * delete-feature.js script. Body: { featurePlanId: string, deleteSubtasks?: boolean, workspaceRoot?: string }.
     */
    private async _handleKanbanDeleteFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const deleteFeature = this._options.deleteFeature;
        if (!deleteFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature deletion not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const featurePlanId = String(body?.featurePlanId || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const deleteSubtasks = !!body?.deleteSubtasks;
            if (!featurePlanId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: featurePlanId' }));
                return;
            }

            const result = await deleteFeature(workspaceRoot, featurePlanId, deleteSubtasks);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanDeleteFeature error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanDeleteFeature failed' }));
        }
    }

    /**
     * Handle POST /kanban/feature/split — split a feature into two new features,
     * partitioning its subtasks. Reached by the kanban_operations split-feature.js
     * script. Body: { featurePlanId: string, keptPlanIds: string[], firstFeatureName: string, secondFeatureName: string, workspaceRoot?: string }.
     */
    private async _handleKanbanSplitFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const splitFeature = this._options.splitFeature;
        if (!splitFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature split not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const featurePlanId = String(body?.featurePlanId || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const keptPlanIds = Array.isArray(body?.keptPlanIds) ? body.keptPlanIds.map((p: any) => String(p)) : null;
            const firstFeatureName = String(body?.firstFeatureName || '').trim();
            const secondFeatureName = String(body?.secondFeatureName || '').trim();
            if (!featurePlanId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: featurePlanId' }));
                return;
            }
            if (!keptPlanIds || keptPlanIds.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'keptPlanIds must be a non-empty array' }));
                return;
            }
            if (!firstFeatureName || !secondFeatureName) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'firstFeatureName and secondFeatureName are required' }));
                return;
            }

            const result = await splitFeature(workspaceRoot, featurePlanId, keptPlanIds, firstFeatureName, secondFeatureName);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanSplitFeature error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanSplitFeature failed' }));
        }
    }

    private async _handleWorktreeCleanup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const cleanupWorktree = this._options.cleanupWorktree;
        if (!cleanupWorktree) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Worktree cleanup not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const worktreeId = body?.worktreeId || body?.branch;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (worktreeId === undefined) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: worktreeId' }));
                return;
            }

            const result = await cleanupWorktree(workspaceRoot, worktreeId);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] _handleWorktreeCleanup error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'worktree cleanup failed' }));
        }
    }

    /**
     * POST /phone-a-friend — notify the Phone-a-Friend terminal to do a second pass on
     * a just-coded plan batch. Reached by a coding agent's `curl` when it finishes.
     * Body: { planFile: string, originRole?: string }. The host handles the silent drop
     * when no terminal is running (the callback MUST NOT throw on "no terminal"). Returns
     * 200 on ack, 400 on bad body, 503 when no callback is wired (headless/test harness).
     */
    private async _handlePhoneAFriend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const onPhoneAFriend = this._options.onPhoneAFriend;
        if (!onPhoneAFriend) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Phone-a-Friend dispatch not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const planFile = String(body?.planFile || '').trim();
            const originRole = body?.originRole ? String(body.originRole).trim() : undefined;
            // Validate planFile: non-empty, relative, no traversal (the host only forwards
            // it into prompt text — never resolves it server-side).
            if (!planFile) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: planFile' }));
                return;
            }
            if (path.isAbsolute(planFile) || planFile.includes('..')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'planFile must be a relative path without .. traversal' }));
                return;
            }

            // The callback handles the silent drop internally and MUST NOT throw on
            // "no terminal" — a throw here becomes a 500 and breaks the best-effort signal.
            await onPhoneAFriend(planFile, originRole);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            console.error('[LocalApiServer] phoneAFriend error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'phoneAFriend failed' }));
        }
    }

    private async _handleOrchestratorRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const onOrchestratorRequest = this._options.onOrchestratorRequest;
        if (!onOrchestratorRequest) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Orchestrator request channel not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const stage = String(body?.stage || '').trim();
            const type = String(body?.type || '').trim();
            const from = body?.from ? String(body.from).trim() : undefined;
            const planId = body?.planId ? String(body.planId).trim() : undefined;
            const feature = body?.feature ? String(body.feature).trim() : undefined;
            const worktreePath = body?.worktreePath ? String(body.worktreePath).trim() : undefined;
            const reqBody = String(body?.body || '').trim();

            const validStages = ['planner', 'coder', 'reviewer'];
            const validTypes = ['question', 'warning', 'research', 'blocked'];
            if (!validStages.includes(stage)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid stage '${stage}'. Must be one of: ${validStages.join(', ')}` }));
                return;
            }
            if (!validTypes.includes(type)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid type '${type}'. Must be one of: ${validTypes.join(', ')}` }));
                return;
            }
            if (!reqBody) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: body' }));
                return;
            }

            const result = await onOrchestratorRequest(
                { stage, type, from, planId, feature, body: reqBody, worktreePath },
                this._options.workspaceRoot
            );
            if (result.success) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, file: result.file }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: result.error || 'orchestrator request failed' }));
            }
        } catch (err) {
            console.error('[LocalApiServer] orchestratorRequest error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'orchestratorRequest failed' }));
        }
    }

    private async _handleOrchestrationDispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const orchestrationDispatch = this._options.orchestrationDispatch;
        if (!orchestrationDispatch) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Orchestration dispatch not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const featurePlanId = String(body?.featurePlanId || '').trim();
            if (!featurePlanId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: featurePlanId' }));
                return;
            }
            if (!workspaceRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: workspaceRoot' }));
                return;
            }
            const result = await orchestrationDispatch(workspaceRoot, featurePlanId);
            if (result.success) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    dispatched: result.dispatched || [],
                    skipped: result.skipped || []
                }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: result.error || 'orchestration dispatch failed' }));
            }
        } catch (err) {
            console.error('[LocalApiServer] orchestrationDispatch error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'orchestrationDispatch failed' }));
        }
    }

    // ─── Read endpoints for external AI coding tools ──────────────────────────

    private async _handleReadEndpoint(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        handler: () => Promise<any>
    ): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        try {
            const data = await handler();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data }));
        } catch (err: any) {
            const status = (err && typeof err.statusCode === 'number') ? err.statusCode : 500;
            if (status >= 500) console.error('[LocalApiServer] read endpoint error:', err);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'read endpoint failed' }));
        }
    }

    private async _handleGetBoard(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            if (!db) throw new Error('Kanban database not available');
            const board = await this._resolveBoard(db);
            return board;
        });
    }

    private async _handleGetCatalog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            if (this._options.catalogProvider) {
                return await this._options.catalogProvider();
            }
            // Fallback: load the checked-in protocol-catalog.json from the workspace root.
            const catalogPath = path.join(this._options.workspaceRoot, 'protocol-catalog.json');
            try {
                const raw = await fs.readFile(catalogPath, 'utf8');
                return JSON.parse(raw);
            } catch {
                const err: any = new Error('catalog not generated; run `node scripts/generate-protocol-catalog.js --write` in the workspace root');
                err.statusCode = 404;
                throw err;
            }
        });
    }

    private async _handleGetPlans(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            if (!db) throw new Error('Kanban database not available');
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            const column = url.searchParams.get('column') || undefined;
            const featureId = url.searchParams.get('featureId') || undefined;
            let plans;
            if (featureId) {
                plans = await db.getSubtasksByFeatureId(featureId);
            } else if (column) {
                const all = await this._resolveBoard(db);
                plans = (all || []).filter((p: any) => p.kanbanColumn === column);
            } else {
                plans = await this._resolveBoard(db);
            }
            return plans;
        });
    }

    private async _handleGetFeatures(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            if (!db) throw new Error('Kanban database not available');
            const board = await this._resolveBoard(db);
            const features = (board || []).filter((p: any) => p.isFeature === 1 || p.isFeature === true);
            return features;
        });
    }

    private async _handleGetWorktrees(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            if (!db) throw new Error('Kanban database not available');
            const worktrees = await db.getWorktrees();
            return worktrees;
        });
    }

    private async _handleGetOrchestratorInbox(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const root = this._options.workspaceRoot;
            const inboxDir = path.join(root, '.switchboard', 'orchestrator', 'inbox');
            const entries: Array<{ file: string; content: string }> = [];
            try {
                const files = await fs.readdir(inboxDir);
                for (const f of files) {
                    if (f === 'processed') continue;
                    const filePath = path.join(inboxDir, f);
                    const stat = await fs.stat(filePath);
                    if (stat.isFile()) {
                        const content = await fs.readFile(filePath, 'utf8');
                        entries.push({ file: f, content });
                    }
                }
            } catch { /* inbox doesn't exist yet — return empty */ }
            return entries;
        });
    }

    private async _handleGetOrchestratorSessionLog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const root = this._options.workspaceRoot;
            const logPath = path.join(root, '.switchboard', 'orchestrator', 'session-log.md');
            try {
                const content = await fs.readFile(logPath, 'utf8');
                return content;
            } catch {
                return '';
            }
        });
    }

    private async _resolveDbFromQuery(req: http.IncomingMessage): Promise<any | null> {
        const getKanbanDatabase = this._options.getKanbanDatabase;
        if (!getKanbanDatabase) return null;
        const url = new URL(req.url || '', `http://localhost:${this._port}`);
        const wsRoot = url.searchParams.get('workspaceRoot') || undefined;
        return await getKanbanDatabase(wsRoot);
    }

    /**
     * getBoard() filters on the workspace UUID (not the root path). Resolve it
     * the same way the moveCard callback does, or every board-backed read comes
     * back as an empty array with no error.
     */
    private async _resolveBoard(db: any): Promise<any[]> {
        const wsId = await this._wsId(db);
        return await db.getBoard(wsId);
    }

    /** Resolve the KanbanDatabase for a mutation handler, defaulting to the primary root. */
    private async _resolveDbForRoot(wsRoot?: string): Promise<any | null> {
        const getKanbanDatabase = this._options.getKanbanDatabase;
        if (!getKanbanDatabase) return null;
        return await getKanbanDatabase(wsRoot || this._options.workspaceRoot);
    }

    /** Resolve the workspace UUID the DB methods key on (not the root path). */
    private async _wsId(db: any): Promise<string> {
        return (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
    }

    /** GET /kanban/plan?planId= — a single plan record plus its full file content. */
    private async _handleGetPlan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            if (!db) throw new Error('Kanban database not available');
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            const planId = url.searchParams.get('planId');
            if (!planId) { const e: any = new Error('Missing required query param: planId'); e.statusCode = 400; throw e; }
            const record = await db.getPlanByPlanId(planId);
            if (!record) { const e: any = new Error(`Plan not found: ${planId}`); e.statusCode = 404; throw e; }
            let content = '';
            try {
                const root = url.searchParams.get('workspaceRoot') || this._options.workspaceRoot;
                const abs = path.isAbsolute(record.planFile) ? record.planFile : path.join(root, record.planFile);
                content = await fs.readFile(abs, 'utf8');
            } catch { /* file may be missing — return the record without content */ }
            return { ...record, content };
        });
    }

    /** GET /kanban/columns — built-in column definitions + custom columns present on the board. */
    private async _handleGetColumns(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const builtIn = DEFAULT_KANBAN_COLUMNS;
            let custom: string[] = [];
            const db = await this._resolveDbFromQuery(req);
            if (db) {
                try {
                    const board = await this._resolveBoard(db);
                    const builtInIds = new Set(builtIn.map(c => c.id));
                    custom = Array.from(new Set(
                        (board || [])
                            .map((p: any) => p.kanbanColumn)
                            .filter((c: string) => c && !builtInIds.has(c))
                    ));
                } catch { /* best-effort custom-column derivation */ }
            }
            return { builtIn, custom };
        });
    }

    /** POST /kanban/plans — create a plan file and import it (the canonical importer assigns the planId). */
    private async _handleCreatePlan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const root = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!root) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: workspaceRoot' }));
                return;
            }
            const title = String(body?.title || body?.topic || '').trim();
            if (!title) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: title' }));
                return;
            }
            const rawSlug = String(body?.slug || title);
            const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'plan';
            const plansDir = path.join(root, '.switchboard', 'plans');
            const resolvedDir = path.resolve(plansDir);
            const resolved = path.resolve(path.join(plansDir, `${slug}.md`));
            // Path-traversal guard: the resolved file MUST live directly under .switchboard/plans/.
            if (resolved !== path.join(resolvedDir, `${slug}.md`) || !resolved.startsWith(resolvedDir + path.sep)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid slug (path traversal rejected)' }));
                return;
            }
            // Don't clobber an existing plan.
            try {
                await fs.access(resolved);
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Plan file already exists: ${slug}.md` }));
                return;
            } catch { /* good — does not exist */ }

            const complexity = (body?.complexity !== undefined && body?.complexity !== null) ? String(body.complexity) : 'Unknown';
            const tags = body?.tags ? (Array.isArray(body.tags) ? body.tags.join(', ') : String(body.tags)) : '';
            const project = body?.project ? String(body.project).replace(/[\r\n]+/g, ' ').trim() : '';
            const description = body?.description ? String(body.description).replace(/[\r\n]+/g, ' ').trim() : '';
            const goal = body?.body ? String(body.body) : '(Describe the goal of this plan.)';

            const md: string[] = [];
            if (description) { md.push('---', `description: ${description}`, '---', ''); }
            md.push(`# ${title}`, '');
            md.push(`**Complexity:** ${complexity}`);
            if (tags) md.push(`**Tags:** ${tags}`);
            if (project) md.push(`**Project:** ${project}`);
            md.push('', '## Goal', '', goal, '');

            await fs.mkdir(plansDir, { recursive: true });
            await fs.writeFile(resolved, md.join('\n'), 'utf8');

            // Canonical importer: assigns a DB planId keyed on plan_file + workspace_id.
            await importPlanFiles(root);

            // Return the assigned planId, matched by file basename (format-agnostic).
            let planId: string | undefined;
            const db = await this._resolveDbForRoot(root);
            if (db) {
                try {
                    const board = await this._resolveBoard(db);
                    const rec = (board || []).find((p: any) =>
                        String(p.planFile || '').replace(/\\/g, '/').endsWith(`${slug}.md`));
                    planId = rec?.planId;
                } catch { /* best-effort planId resolution */ }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, planId, planFile: resolved, slug }));
        } catch (err) {
            console.error('[LocalApiServer] createPlan error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'createPlan failed' }));
        }
    }

    /** DELETE /kanban/plans?planId=[&deleteFile=true] — remove the DB row (optionally unlink the file). */
    private async _handleDeletePlan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        try {
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            const planId = url.searchParams.get('planId');
            if (!planId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required query param: planId' }));
                return;
            }
            const root = url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '';
            const db = await this._resolveDbForRoot(root);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Kanban database not available' }));
                return;
            }
            const record = await db.getPlanByPlanId(planId);
            if (!record) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Plan not found: ${planId}` }));
                return;
            }
            const ok = await db.deletePlanByPlanId(planId);
            // deletePlanByPlanId removes the DB row only; the .md file re-imports on the
            // next import_plans unless the caller opts into unlinking it too.
            let fileDeleted = false;
            if (url.searchParams.get('deleteFile') === 'true' && record.planFile && root) {
                const plansDir = path.resolve(path.join(root, '.switchboard', 'plans'));
                const abs = path.resolve(path.isAbsolute(record.planFile) ? record.planFile : path.join(root, record.planFile));
                if (abs.startsWith(plansDir + path.sep)) {
                    try { await fs.unlink(abs); fileDeleted = true; } catch { /* already gone */ }
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: ok, fileDeleted }));
        } catch (err) {
            console.error('[LocalApiServer] deletePlan error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'deletePlan failed' }));
        }
    }

    /** PUT /kanban/plans/project — set a plan's project ({ planId, project }). */
    private async _handleSetPlanProject(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handlePlanFieldUpdate(req, res, 'project');
    }

    /** PUT /kanban/plans/complexity — set a plan's complexity ({ planId, complexity }). */
    private async _handleSetPlanComplexity(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handlePlanFieldUpdate(req, res, 'complexity');
    }

    private async _handlePlanFieldUpdate(req: http.IncomingMessage, res: http.ServerResponse, field: 'project' | 'complexity'): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const planId = String(body?.planId || '').trim();
            if (!planId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: planId' }));
                return;
            }
            const value = field === 'project' ? String(body?.project ?? '') : String(body?.complexity ?? '');
            const db = await this._resolveDbForRoot(String(body?.workspaceRoot || '').trim() || undefined);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Kanban database not available' }));
                return;
            }
            const record = await db.getPlanByPlanId(planId);
            if (!record) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Plan not found: ${planId}` }));
                return;
            }
            const wsId = await this._wsId(db);
            const ok = field === 'project'
                ? await db.updatePlanProjectByPlanFile(record.planFile, wsId, value)
                : await db.updateComplexityByPlanFile(record.planFile, wsId, value);
            res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: ok }));
        } catch (err) {
            console.error(`[LocalApiServer] setPlan-${field} error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'update failed' }));
        }
    }

    /** POST /kanban/plans/import — rescan .switchboard/plans/*.md and upsert into the DB. */
    private async _handleImportPlans(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const root = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!root) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: workspaceRoot' }));
                return;
            }
            const result = await importPlanFiles(root);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
            console.error('[LocalApiServer] importPlans error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'importPlans failed' }));
        }
    }

    private async _handleClickUpApiProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, false)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { method, endpoint, query, body: apiBody } = body || {};
            
            // Validate inputs
            if (!method || !endpoint) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing method or endpoint' }));
                return;
            }
            
            // Call ClickUp API via service
            const result = await service.makeApiRequest(method, endpoint, query, apiBody);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] ClickUp API proxy error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Proxy request failed' }));
        }
    }

    private async _handleCreateClickUpTask(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // CLARIFICATION: Strict auth enforcement for write operations
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { name, listId, description, assignees, dueDate, subtasks } = body;
            
            // Validation
            if (!name || !listId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: name and listId' }));
                return;
            }
            
            // Create parent task first
            const parentTask = await service.createTask({
                name,
                listId,
                description,
                assignees,
                dueDate
            });
            
            // Create subtasks if provided
            let createdSubtasks: any[] = [];
            let failedSubtasks: any[] = [];
            
            if (subtasks && Array.isArray(subtasks) && subtasks.length > 0) {
                for (let i = 0; i < subtasks.length; i++) {
                    const subtask = subtasks[i];
                    try {
                        const created = await service.createTask({
                            name: subtask.name,
                            listId,
                            description: subtask.description,
                            assignees: subtask.assignees,
                            dueDate: subtask.dueDate,
                            parent: parentTask?.id
                        });
                        createdSubtasks.push(created);
                    } catch (err) {
                        console.warn(`[LocalApiServer] Subtask creation failed for index ${i}:`, err);
                        // CLARIFICATION: Record failed subtasks instead of failing silently
                        failedSubtasks.push({
                            index: i,
                            name: subtask.name,
                            error: err instanceof Error ? err.message : String(err)
                        });
                    }
                }
            }
            
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                task: parentTask,
                subtasks: createdSubtasks,
                subtaskCount: createdSubtasks.length,
                failedSubtasks: failedSubtasks.length > 0 ? failedSubtasks : undefined
            }));
        } catch (err) {
            console.error('[LocalApiServer] Task creation error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task creation failed' }));
        }
    }

    private async _handleUpdateClickUpTask(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            
            // CLARIFICATION: Build update payload only with provided fields
            const updatePayload: any = {};
            
            if ('name' in body) updatePayload.name = body.name;
            if ('description' in body) updatePayload.description = body.description;
            if ('status' in body) updatePayload.status = body.status;
            if ('assignees' in body) updatePayload.assignees = body.assignees;
            if ('dueDate' in body) {
                const date = new Date(body.dueDate);
                if (!isNaN(date.getTime())) {
                    updatePayload.due_date = date.getTime();
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid dueDate format' }));
                    return;
                }
            }
            if ('priority' in body) updatePayload.priority = body.priority;
            if ('tags' in body) updatePayload.tags = body.tags;
            
            // Validate at least one field provided
            if (Object.keys(updatePayload).length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No fields provided for update' }));
                return;
            }
            
            const result = await service.updateTask(taskId, updatePayload);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                task: result,
                updatedFields: Object.keys(updatePayload)
            }));
        } catch (err) {
            console.error('[LocalApiServer] Task update error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task update failed' }));
        }
    }

    private async _handleMoveClickUpTask(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { targetListId, moveCustomFields, statusMappings } = body || {};

            if (!targetListId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'targetListId is required' }));
                return;
            }

            const result = await service.moveTask(taskId, targetListId, {
                moveCustomFields,
                statusMappings
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                taskId,
                targetListId,
                warning: result.warning ?? null,
                remainsInLists: result.remainsInLists
            }));
        } catch (err) {
            console.error('[LocalApiServer] ClickUp task move error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task move failed' }));
        }
    }

    private async _handleMoveLinearIssue(issueId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const service = this._options.getLinearService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Linear service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { targetProjectId } = body || {};

            if (!body || !('targetProjectId' in body)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'targetProjectId is required (use null to unassign)' }));
                return;
            }

            await service.updateIssueProject(issueId, targetProjectId || null);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, issueId, targetProjectId: targetProjectId || null }));
        } catch (err) {
            console.error('[LocalApiServer] Linear issue move error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Issue move failed' }));
        }
    }

    private async _handleAttachFile(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { fileName, fileDataBase64, comment } = body;
            
            // Validation
            if (!fileName || !fileDataBase64) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: fileName and fileDataBase64' }));
                return;
            }
            
            // Check file size (Base64 is ~4/3 of binary size)
            const estimatedSize = (fileDataBase64.length * 3) / 4;
            if (estimatedSize > this._MAX_FILE_SIZE_BYTES) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    error: 'File too large',
                    maxSize: `${this._MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`,
                    receivedSize: `${(estimatedSize / 1024 / 1024).toFixed(2)}MB`
                }));
                return;
            }
            
            // Validate file extension
            const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.txt', '.md', '.json'];
            const ext = path.extname(fileName).toLowerCase();
            if (!allowedExtensions.includes(ext)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    error: 'File type not allowed',
                    allowedTypes: allowedExtensions
                }));
                return;
            }
            
            // Decode Base64
            let buffer: Buffer;
            try {
                // Buffer.from silently ignores invalid base64 characters, so we must strictly validate
                const stripped = fileDataBase64.replace(/\s/g, '');
                if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
                    throw new Error('Invalid Base64 data');
                }
                buffer = Buffer.from(stripped, 'base64');
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid Base64 data' }));
                return;
            }
            
            // Upload via service
            const result = await service.attachFile(taskId, fileName, buffer, comment);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                url: result.url,
                fileName: result.fileName,
                size: buffer.length
            }));
        } catch (err) {
            console.error('[LocalApiServer] File attachment error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Upload failed' }));
        }
    }

    private async _handleCreateDocPage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { workspaceId, docId, pageName, content, parentPageId } = body;
            
            // Validation
            if (!docId || !pageName || !content) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: docId, pageName, content' }));
                return;
            }
            
            const result = await service.createDocPage({
                workspaceId,
                docId,
                pageName,
                content,
                parentPageId
            });
            
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                pageId: result.id,
                url: result.url,
                docId,
                pageName
            }));
        } catch (err) {
            console.error('[LocalApiServer] Doc page creation error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: err instanceof Error ? err.message : 'Doc page creation failed',
                hint: 'Ensure docId is valid and you have write access to the document'
            }));
        }
    }

    private async _checkMermaidCli(): Promise<boolean> {
        if (this._mermaidCliAvailable !== null) {
            return this._mermaidCliAvailable;
        }
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            // Check for mmdc (mermaid-cli binary)
            const cmd = process.platform === 'win32' ? 'where mmdc' : 'which mmdc';
            await execAsync(cmd);
            this._mermaidCliAvailable = true;
        } catch {
            this._mermaidCliAvailable = false;
        }
        return this._mermaidCliAvailable;
    }

    private _generateMermaidSyntax(diagramType: string, maxNodes: number, focusPath?: string): string {
        // CLARIFICATION: This is a placeholder - actual implementation would use ArchitectureAnalyzer
        return `graph TD\nA[Start] --> B[End]`;
    }

    private async _handleGenerateDiagram(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        
        try {
            const body = await this._parseJsonBody(req);
            const { diagramType, maxNodes, focusPath, detailLevel, targetId, platform } = body;
            
            // Validate required fields
            if (!diagramType) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: diagramType' }));
                return;
            }
            
            // Generate Mermaid syntax (always available)
            const mermaidSyntax = this._generateMermaidSyntax(diagramType, maxNodes || 50, focusPath);
            
            // Check if mermaid-cli is available
            const canRender = await this._checkMermaidCli();
            
            if (!canRender) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    rendered: false,
                    warning: 'mermaid-cli not installed. Install with: npm install -g @mermaid-js/mermaid-cli',
                    mermaidSyntax: mermaidSyntax,
                    installCommand: 'npm install -g @mermaid-js/mermaid-cli'
                }));
                return;
            }
            
            // Render using mermaid-cli
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            const os = require('os');
            const crypto = require('crypto');
            
            const safeId = crypto.randomUUID();
            const tempPath = path.join(os.tmpdir(), `diagram-${safeId}.mmd`);
            const tempOutputPath = `${tempPath}.png`;
            
            // Write Mermaid syntax to temp file
            await fs.writeFile(tempPath, mermaidSyntax);
            
            try {
                // Render with mermaid-cli
                await execAsync(`mmdc -i "${tempPath}" -o "${tempOutputPath}" -b transparent`);
                
                // Read rendered image
                const imageBuffer = await fs.readFile(tempOutputPath);
                
                // Upload to platform if target provided
                if (targetId && platform) {
                    let uploadResult;
                    if (platform === 'clickup') {
                        const service = this._options.getClickUpService();
                        if (!service) throw new Error('ClickUp service not available');
                        uploadResult = await service.attachFile(targetId, 'diagram.png', imageBuffer, 'Generated diagram');
                    } else if (platform === 'linear') {
                        const service = this._options.getLinearService();
                        if (!service) throw new Error('Linear service not available');
                        uploadResult = await service.uploadAttachment(targetId, imageBuffer, 'diagram.png');
                    }
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        rendered: true, 
                        url: uploadResult?.url,
                        uploadedTo: platform,
                        targetId
                    }));
                } else {
                    // Return image directly
                    res.writeHead(200, { 
                        'Content-Type': 'image/png',
                        'Content-Disposition': 'attachment; filename="diagram.png"'
                    });
                    res.end(imageBuffer);
                }
            } catch (renderErr) {
                console.warn('[LocalApiServer] Diagram render failed:', renderErr);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    rendered: false,
                    warning: 'Render failed: ' + (renderErr instanceof Error ? renderErr.message : 'Unknown error'),
                    mermaidSyntax: mermaidSyntax,
                    renderError: renderErr instanceof Error ? renderErr.message : 'Unknown'
                }));
            } finally {
                // Cleanup temp files
                await fs.unlink(tempPath).catch(() => {});
                await fs.unlink(tempOutputPath).catch(() => {});
            }
        } catch (err) {
            console.error('[LocalApiServer] Diagram generation error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Diagram generation failed' }));
        }
    }

    private async _handleLinearApiProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, false)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const service = this._options.getLinearService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Linear service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { query, variables } = body || {};
            
            if (!query) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing GraphQL query' }));
                return;
            }
            
            const result = await service.makeGraphQLRequest(query, variables);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] Linear API proxy error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Proxy request failed' }));
        }
    }

    private async _handleResolveName(source: string, name: string, res: http.ServerResponse): Promise<void> {
        const cacheKey = `${source}:${name}`;
        const cached = this._nameResolutionCache.get(cacheKey);
        
        // Return cached result if valid
        if (cached && Date.now() - cached.timestamp < this._CACHE_TTL_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: cached.id, cached: true }));
            return;
        }
        
        try {
            let id: string | null = null;
            
            if (source === 'clickup') {
                const service = this._options.getClickUpService();
                if (!service) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'ClickUp service not available' }));
                    return;
                }
                id = await service.resolveNameToId(name);
            } else if (source === 'linear') {
                const service = this._options.getLinearService();
                if (!service) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Linear service not available' }));
                    return;
                }
                id = await service.resolveNameToId(name);
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid source. Use "clickup" or "linear"' }));
                return;
            }
            
            if (!id) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Name "${name}" not found in ${source}` }));
                return;
            }
            
            // Cache the result and prune old entries
            this._nameResolutionCache.set(cacheKey, { id, timestamp: Date.now() });
            this._pruneCache();
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id, cached: false }));
        } catch (err) {
            console.error('[LocalApiServer] Name resolution error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Resolution failed' }));
        }
    }

    /**
     * Handle incoming HTTP requests.
     */
    private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // Restrict to localhost only
        const remoteAddress = req.socket.remoteAddress;
        if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied: localhost only' }));
            return;
        }

        // Add CORS headers - allow any localhost origin
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const pathname = url.pathname;

        try {
            if (pathname === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', port: this._port, roots: this._allRoots }));
            } else if (pathname === '/metadata/clickup' && req.method === 'GET') {
                await this._handleGetMetadata('clickup', res);
            } else if (pathname === '/metadata/linear' && req.method === 'GET') {
                await this._handleGetMetadata('linear', res);
            } else if (pathname.startsWith('/task/clickup/') && req.method === 'GET') {
                const taskId = pathname.split('/')[3];
                await this._handleGetTask('clickup', taskId, res);
            } else if (pathname.startsWith('/task/linear/') && req.method === 'GET') {
                const taskId = pathname.split('/')[3];
                await this._handleGetTask('linear', taskId, res);
            } else if (pathname === '/task/clickup' && req.method === 'POST') {
                await this._handleCreateClickUpTask(req, res);
            } else if (pathname.startsWith('/task/clickup/') && pathname.endsWith('/move') && req.method === 'PUT') {
                const taskId = pathname.split('/')[3];
                await this._handleMoveClickUpTask(taskId, req, res);
            } else if (pathname.startsWith('/task/linear/') && pathname.endsWith('/move') && req.method === 'PUT') {
                const issueId = pathname.split('/')[3];
                await this._handleMoveLinearIssue(issueId, req, res);
            } else if (pathname.startsWith('/task/clickup/') && !pathname.endsWith('/move') && req.method === 'PUT') {
                const taskId = pathname.split('/')[3];
                await this._handleUpdateClickUpTask(taskId, req, res);
            } else if (pathname === '/kanban/move' && req.method === 'POST') {
                await this._handleKanbanMove(req, res);
            } else if (pathname === '/kanban/feature' && req.method === 'POST') {
                await this._handleKanbanCreateFeature(req, res);
            } else if (pathname === '/kanban/feature/assign' && req.method === 'POST') {
                await this._handleKanbanAssignFeature(req, res);
            } else if (pathname === '/kanban/feature/remove' && req.method === 'POST') {
                await this._handleKanbanRemoveSubtaskFromFeature(req, res);
            } else if (pathname === '/kanban/feature/delete' && req.method === 'POST') {
                await this._handleKanbanDeleteFeature(req, res);
            } else if (pathname === '/kanban/feature/split' && req.method === 'POST') {
                await this._handleKanbanSplitFeature(req, res);
            } else if (pathname === '/kanban/orchestration/dispatch' && req.method === 'POST') {
                await this._handleOrchestrationDispatch(req, res);
            } else if (pathname === '/kanban/plans/import' && req.method === 'POST') {
                await this._handleImportPlans(req, res);
            } else if (pathname === '/kanban/plans/project' && req.method === 'PUT') {
                await this._handleSetPlanProject(req, res);
            } else if (pathname === '/kanban/plans/complexity' && req.method === 'PUT') {
                await this._handleSetPlanComplexity(req, res);
            } else if (pathname === '/kanban/plans' && req.method === 'POST') {
                await this._handleCreatePlan(req, res);
            } else if (pathname === '/kanban/plans' && req.method === 'DELETE') {
                await this._handleDeletePlan(req, res);
            } else if (pathname === '/worktree/cleanup' && req.method === 'POST') {
                await this._handleWorktreeCleanup(req, res);
            } else if (pathname === '/comment' && req.method === 'POST') {
                await this._handlePostComment(req, res);
            } else if (pathname === '/phone-a-friend' && req.method === 'POST') {
                await this._handlePhoneAFriend(req, res);
            } else if (pathname === '/orchestrator/request' && req.method === 'POST') {
                await this._handleOrchestratorRequest(req, res);
            } else if (pathname === '/api/clickup' && req.method === 'POST') {
                await this._handleClickUpApiProxy(req, res);
            } else if (pathname === '/api/linear' && req.method === 'POST') {
                await this._handleLinearApiProxy(req, res);
            } else if (pathname.startsWith('/task/clickup/') && pathname.endsWith('/attach') && req.method === 'POST') {
                const taskId = pathname.split('/')[3];
                await this._handleAttachFile(taskId, req, res);
            } else if (pathname === '/doc/clickup' && req.method === 'POST') {
                await this._handleCreateDocPage(req, res);
            } else if (pathname === '/diagram/generate' && req.method === 'POST') {
                await this._handleGenerateDiagram(req, res);
            } else if (pathname.startsWith('/resolve/') && req.method === 'GET') {
                const parts = pathname.split('/');
                const source = parts[2]; // 'clickup' or 'linear'
                const name = decodeURIComponent(parts[4]);
                await this._handleResolveName(source, name, res);
            } else if (pathname === '/kanban/board' && req.method === 'GET') {
                await this._handleGetBoard(req, res);
            } else if (pathname === '/kanban/plans' && req.method === 'GET') {
                await this._handleGetPlans(req, res);
            } else if (pathname === '/kanban/features' && req.method === 'GET') {
                await this._handleGetFeatures(req, res);
            } else if (pathname === '/kanban/plan' && req.method === 'GET') {
                await this._handleGetPlan(req, res);
            } else if (pathname === '/kanban/columns' && req.method === 'GET') {
                await this._handleGetColumns(req, res);
            } else if (pathname === '/worktree/list' && req.method === 'GET') {
                await this._handleGetWorktrees(req, res);
            } else if (pathname === '/orchestrator/inbox' && req.method === 'GET') {
                await this._handleGetOrchestratorInbox(req, res);
            } else if (pathname === '/orchestrator/session-log' && req.method === 'GET') {
                await this._handleGetOrchestratorSessionLog(req, res);
            } else if (pathname === '/catalog' && req.method === 'GET') {
                await this._handleGetCatalog(req, res);
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (err) {
            console.error('[LocalApiServer] Request error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }

    /**
     * Handle GET /metadata/{source} requests.
     */
    private async _handleGetMetadata(sourceId: string, res: http.ServerResponse): Promise<void> {
        const filePath = sourceId === 'clickup'
            ? this._options.clickupMetadataPath
            : this._options.linearMetadataPath;

        try {
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch {
            // File doesn't exist or is invalid — return empty metadata
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: 1, sourceId, metadata: [], writtenAt: Date.now() }));
        }
    }

    /**
     * Handle GET /task/{source}/{taskId} requests.
     */
    private async _handleGetTask(sourceId: string, taskId: string, res: http.ServerResponse): Promise<void> {
        if (sourceId === 'clickup') {
            const service = this._options.getClickUpService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'ClickUp service not available' }));
                return;
            }

            try {
                const details = await service.getTaskDetails(taskId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(details));
            } catch (err) {
                console.error('[LocalApiServer] ClickUp task fetch error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to fetch task details' }));
            }
        } else if (sourceId === 'linear') {
            const service = this._options.getLinearService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Linear service not available' }));
                return;
            }

            try {
                const issue = await service.getIssue(taskId);
                let subtasks: any[] = [];
                let comments: any[] = [];
                let attachments: any[] = [];
                if (issue) {
                    try { subtasks = await service.getSubtasks(taskId); } catch (e) {
                        console.warn('[LocalApiServer] Failed to load Linear subtasks:', e);
                    }
                    try { comments = await service.getComments(taskId); } catch (e) {
                        console.warn('[LocalApiServer] Failed to load Linear comments:', e);
                    }
                    try { attachments = await service.getAttachments(taskId); } catch (e) {
                        console.warn('[LocalApiServer] Failed to load Linear attachments:', e);
                    }
                }

                if (!issue) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Linear issue ${taskId} not found` }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ issue, subtasks, comments, attachments }));
            } catch (err) {
                console.error('[LocalApiServer] Linear issue fetch error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to fetch issue details' }));
            }
        }
    }
}
