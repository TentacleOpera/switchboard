import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { URL } from 'url';
import { ClickUpSyncService } from './ClickUpSyncService';
import { LinearSyncService } from './LinearSyncService';
import type { NotionFetchService } from './NotionFetchService';
import { importPlanFiles } from './PlanFileImporter';
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';
import { WsHub } from './wsHub';

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
    /**
     * Declarative, path/slug-addressed feature reconciliation (Feature A · A3).
     * Converges the whole feature structure to a desired end state in one idempotent
     * call — creates features, assigns/removes subtasks (addressed by file path /
     * slug / planId), creates inline-defined plans, and optionally deletes unmentioned
     * features. Used by the /switchboard-manage skill and external agent hosts so an
     * agent never handles a raw UUID. Body shape:
     *   { workspaceRoot?, removeUnmentionedFeatures?, features: [{ name, description?,
     *     subtasks: ["<path|slug|planId>" | { slug, title, body }] }] }
     * Optional — absent in headless/test harnesses (returns 503).
     */
    reconcileFeatures?: (
        workspaceRoot: string,
        desiredFeatures: Array<{
            name: string;
            description?: string;
            subtasks: Array<string | { slug: string; title: string; body?: string }>;
        }>,
        options?: { removeUnmentionedFeatures?: boolean }
    ) => Promise<{
        success: boolean;
        features?: Array<{ name: string; featurePlanId: string; subtasks: Array<{ planId: string; planFile: string; topic: string }> }>;
        mutations?: Array<{ action: string; detail: string }>;
        warnings?: string[];
        error?: string;
    }>;
    /**
     * Generic Kanban verb dispatch — the A2b per-verb burn-down rail. Every
     * catalogued Kanban handler verb, once extracted into `KanbanService`, is
     * reachable at `POST /kanban/verb/<name>` and routed through this single
     * callback into the service — the same host-agnostic code path the webview
     * `case '<name>':` arm drives. A bulk coder extends the burn-down by adding
     * a `KanbanService` method + one dispatch case in
     * `KanbanProvider.handleServiceVerb`; NO new plumbing here per verb. `verb`
     * is the message `type`, `payload` is the request body (the webview
     * `postMessage` shape — untrusted network input; the service method
     * validates its own payload). Returns the service method's result (every
     * extracted verb returns `{ success, ... }`). Optional — absent in
     * headless/test harnesses (returns 503).
     */
    kanbanVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
    /**
     * Names of currently registered, live terminal agents (dispatch targets).
     * Surfaced on GET /health as `terminals` so external managers (the
     * switchboard-manage skill's entry protocol) can detect the "no terminal
     * agent registered" setup gap in the same single liveness call. Registration
     * is in-memory runtime state — there is NO file that reflects it (the legacy
     * `.switchboard/state.json` was migrated into kanban.db and renamed
     * `.migrated.bak`), so /health is the only truthful source. Optional —
     * absent in headless/test harnesses (/health then omits the field).
     */
    getRegisteredTerminals?: () => string[];
    /**
     * The board's currently selected workspace root (the kanban dropdown selection),
     * or null when no provider is loaded. Surfaced on GET /health as
     * `selectedWorkspaceRoot` so external managers (the switchboard-manage skill) can
     * tell whether the board's selection matches the caller's `$ROOT` before opening
     * the saved agent grid (createAgentGrid follows the board selection, not the
     * caller's root — a mismatch needs a selectWorkspace pre-step). Optional — absent
     * in headless/test harnesses (/health then omits the field, and the manager falls
     * back to the manual nudge rather than firing selectWorkspace blind).
     */
    getSelectedWorkspaceRoot?: () => string | null;
    /**
     * Pre-flight resolution for POST /kanban/dispatch: the target column's
     * configured role/spec and the CLI-triggers gate. Lets the endpoint reject
     * a doomed dispatch with a real error instead of letting the triggerAction
     * arm silently no-op. Optional — absent in headless/test harnesses.
     */
    resolveKanbanDispatch?: (workspaceRoot: string, targetColumn: string) => Promise<{
        role: string | null;
        cliTriggersEnabled: boolean;
        dragDropMode: string | null;
        source: string | null;
    }>;
    /**
     * Complexity-routed target column for POST /kanban/dispatch when the caller
     * omits targetColumn (or passes "auto"). Delegates to the board's own
     * score→role resolution (custom routing map or default bands 1–4 intern /
     * 5–6 coder / 7+ lead, pair-mode bypass included); routing off or unknown
     * complexity → lead. Optional.
     */
    resolveAutoDispatchColumn?: (workspaceRoot: string, complexity: string | null) => Promise<{
        targetColumn: string;
        reason: string;
    }>;
    planningVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
    designVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
    setupVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
    taskViewerVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
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
     * Research hand-off — reached by the planner agent's `curl` when its "advise
     * research if unsure" add-on has a research prompt to delegate. The host checks
     * whether a `researcher`-role terminal is registered AND live; if so it resolves
     * the configured research-docs folder (`switchboard.research.localFolderPaths[0]`,
     * default `.switchboard/docs/`), appends a save-to-docs instruction, and sends the
     * prompt to that terminal — returning `{ dispatched:true, researcher, savePath }`.
     * When no researcher is active it returns `{ dispatched:false, reason }` (it MUST
     * NOT throw, and MUST NOT spawn a terminal) so the planner cleanly falls back to
     * emitting the prompt in its chat summary. Optional — absent in headless/test
     * harnesses (endpoint returns 503).
     */
    onDispatchResearch?: (workspaceRoot: string, prompt: string) => Promise<{
        dispatched: boolean;
        researcher?: string;
        savePath?: string;
        reason?: string;
    }>;
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
     * Arm the unattended orchestration engine — the same path the AUTOMATION tab
     * "Start orchestrator" button takes (terminal + kickoff + autoban clock).
     * Reached by `POST /orchestration/start` from the /switchboard-manage skill
     * when the user explicitly asks to arm automation. Optional — absent in
     * headless/test harnesses (returns 503).
     */
    orchestrationStart?: (workspaceRoot?: string) => Promise<void>;
    /**
     * Disarm the orchestration engine — disables orchestration, stops the autoban
     * clock, persists state, and broadcasts. Reached by `POST /orchestration/stop`.
     * Optional — absent in headless/test harnesses (returns 503).
     */
    orchestrationStop?: () => Promise<void>;
    /**
     * Protocol catalog provider — serves the checked-in `protocol-catalog.json`
     * (generated by `scripts/generate-protocol-catalog.js`) so external clients
     * discover every verb/endpoint/payload at runtime. The MCP-free
     * discoverability layer. Optional — absent in headless/test harnesses
     * (returns 404 with a clear "run the scanner" message).
     */
    catalogProvider?: () => Promise<any>;
    /**
     * Full-state snapshot for WS resync-on-connect. Called by wsHub when a new
     * WS connection is established (or a dropped connection reconnects) so the
     * client converges to the current board state rather than going stale.
     * Optional — absent means no resync push (clients get broadcasts only).
     */
    getFullState?: () => Promise<any>;
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
    private _wsHub: WsHub | null = null;

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

                // Attach wsHub to the listening HTTP server.
                this._wsHub = new WsHub({
                    server: this._server!,
                    getAuthToken: this._options.getAuthToken,
                    getFullState: this._options.getFullState,
                });
                this._wsHub.attach();

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

    /**
     * Broadcast a push message to all connected WS clients. This is the
     * wsHub fan-out target for the broadcast abstraction (A2a) that A2b's
     * push-site audit routes through. No-op when no WS clients are connected.
     */
    public broadcastWs(verb: string, payload?: any, surface?: string): void {
        this._wsHub?.broadcast(verb, payload, surface);
    }

    public getPort(): number {
        return this._port;
    }

    /**
     * Stop the local API server.
     */
    async stop(): Promise<void> {
        this._isListening = false;
        if (this._wsHub) {
            this._wsHub.close();
            this._wsHub = null;
        }
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
        // The localhost boundary check is already performed in _handleRequest
        // (remoteAddress === 127.0.0.1 / ::1). For the existing webview-driven
        // flow (no Authorization header), we preserve backward compatibility by
        // trusting that localhost boundary. External clients MUST present a
        // valid bearer token — this gates the WS + HTTP surface against
        // DNS-rebinding and rogue local processes.
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            // No token presented — fall through to the localhost-only trust
            // model the shipped extension has always used. The remoteAddress
            // check in _handleRequest is the gate.
            return true;
        }
        const expected = await this._options.getAuthToken();
        const match = /^Bearer\s+(.+)$/i.exec(authHeader);
        if (!match) return false;
        // Constant-time comparison to avoid timing side channels.
        const presented = match[1];
        if (presented.length !== expected.length) return false;
        let diff = 0;
        for (let i = 0; i < expected.length; i++) {
            diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
        }
        return diff === 0;
    }

    // NOTE: Switchboard has no API-token setter UI today, so getAuthToken() is
    // effectively always empty and auth is localhost-trust. This 401 only fires
    // when a client sends an Authorization header at all. If a token-setter is
    // ever added, revisit this wording.
    private _sendUnauthorized(res: http.ServerResponse): void {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Unauthorized',
            detail: 'Invalid Authorization header. Switchboard accepts unauthenticated requests over loopback (127.0.0.1) — retry without an Authorization header.'
        }));
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
            this._sendUnauthorized(res);
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
     * Canonicalize a column reference against the board's real column IDs.
     * Accepts 'LEAD CODED', 'lead-coded', 'lead_coded', 'Lead Coded' → 'LEAD CODED'.
     * Returns null when nothing matches (caller responds 400). This exists because
     * column IDs are uppercase display names ('LEAD CODED') while the kanban-state
     * export files use slugs (kanban-state-lead-coded.md) — an API caller who
     * echoes the slug back gets it written to the DB verbatim, and the board
     * webview (which buckets by exact ID) dumps the card into the first column
     * while project.html shows the raw value: the same card in two "columns".
     */
    private async _canonicalColumnId(raw: string, workspaceRoot?: string): Promise<string | null> {
        const canon = (s: string) => s.trim().toUpperCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
        const target = canon(raw);
        if (!target) return null;
        const ids: string[] = DEFAULT_KANBAN_COLUMNS.map((c: any) => String(c.id));
        try {
            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (db) {
                const board = await this._resolveBoard(db);
                for (const p of board || []) {
                    const col = (p as any).kanbanColumn;
                    if (col && !ids.includes(col)) { ids.push(String(col)); }
                }
            }
        } catch { /* built-ins remain the floor */ }
        // Built-ins are listed first, so a canonical ID always wins over a rogue
        // stored variant that canonicalizes to the same target.
        for (const id of ids) { if (canon(id) === target) return id; }
        return null;
    }

    /**
     * POST /kanban/dispatch — the ONE-CALL "advance a card and fire its agent"
     * endpoint. Composes exactly what a webview drag does — the triggerAction arm
     * persists the column move FIRST, then dispatches the target column's
     * configured role prompt — and then VERIFIES the outcome against the DB
     * before answering. Exists because driving this through the raw verb rail
     * (`/kanban/verb/triggerAction`) requires exact webview payload field names
     * (`sessionId`, `targetColumn`) and returns a hollow {success:true} even when
     * the arm silently no-ops (wrong field names, CLI triggers disabled, column
     * with no role) — a manager is one payload typo away from believing it
     * dispatched something.
     * Body: { plan: string (planId | sessionId | plan-file path), targetColumn:
     *         string, workspaceRoot?: string }. `planId`/`sessionId`/`planFile`
     *         are accepted as aliases for `plan`; `column` for `targetColumn`.
     * Response: { success, planId, sessionId, topic, role, mode, column, moved,
     *             dispatched, dispatchedAgent, dispatchedAt, error? } — success
     * means "the card is in the target column AND a dispatch was observed",
     * never just "the request parsed".
     */
    private async _handleKanbanDispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const fail = (code: number, error: string, extra?: Record<string, unknown>) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error, ...(extra || {}) }));
        };
        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const ref = String(body?.plan || body?.planId || body?.sessionId || body?.planFile || '').trim();
            const rawColumn = String(body?.targetColumn || body?.column || '').trim();
            if (!ref) {
                fail(400, 'Missing required field: plan (planId | sessionId | plan-file path)');
                return;
            }
            const kanbanVerb = this._options.kanbanVerb;
            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!kanbanVerb || !db) {
                fail(503, 'Kanban dispatch not available (extension callbacks missing)');
                return;
            }

            // 1. Resolve the plan — planId first, then plan-file path.
            let record: any = await db.getPlanByPlanId(ref);
            if (!record && (ref.includes('/') || ref.endsWith('.md'))) {
                const wsId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                record = await db.getPlanByPlanFile(ref, wsId);
            }
            if (!record) {
                fail(404, `Plan not found: '${ref}' (tried planId and plan-file path)`);
                return;
            }
            const sessionId = record.sessionId || record.planId;

            // 2. Resolve the target column. Omitted (or "auto") → route by complexity
            //    through the board's own rule (default bands 1–4 intern / 5–6 coder /
            //    7+ lead; honors custom routing maps and the pair-mode bypass).
            let targetColumn: string | null;
            let routing: string | undefined;
            if (!rawColumn || rawColumn.toLowerCase() === 'auto') {
                if (!this._options.resolveAutoDispatchColumn) {
                    fail(400, 'targetColumn is required (auto-routing callback unavailable)');
                    return;
                }
                const auto = await this._options.resolveAutoDispatchColumn(workspaceRoot, record.complexity ?? null);
                targetColumn = auto.targetColumn;
                routing = `auto: ${auto.reason}`;
            } else {
                targetColumn = await this._canonicalColumnId(rawColumn, workspaceRoot);
                if (!targetColumn) {
                    fail(400, `Unknown targetColumn '${rawColumn}' — valid column IDs: ${DEFAULT_KANBAN_COLUMNS.map((c: any) => c.id).join(' | ')} (plus any custom columns; see GET /kanban/columns)`);
                    return;
                }
            }

            // 3. Pre-flight the gates the arm breaks silently on — fail loudly instead.
            //    (CLI-triggers is NOT checked: that setting gates webview drag-drop
            //    auto-dispatch; an explicit API dispatch bypasses it via apiOriginated.)
            let gate: { role: string | null; cliTriggersEnabled: boolean; dragDropMode: string | null; source: string | null } | undefined;
            if (this._options.resolveKanbanDispatch) {
                gate = await this._options.resolveKanbanDispatch(workspaceRoot, targetColumn);
                if (!gate.role) {
                    fail(400, `Column '${targetColumn}' has no dispatch role/action configured — a card moved there fires nothing. Pick a coding column with a configured drop action.`);
                    return;
                }
            }
            const isPromptMode = gate?.dragDropMode === 'prompt';
            if (!isPromptMode) {
                let terminals: string[] | undefined;
                try { terminals = this._options.getRegisteredTerminals?.(); } catch { /* health-style guard */ }
                if (terminals !== undefined && terminals.length === 0) {
                    fail(409, 'No terminal agent is live right now — dispatch would fall back to the clipboard and nothing would run. If you have set up agents before, just open your agent terminal(s) (AGENT SETUP tab / your saved agent grid) so they re-register; run Guided setup only if you have never configured one. API callers can open the saved grid themselves: POST /taskViewer/verb/createAgentGrid (check /health.selectedWorkspaceRoot matches your root first; POST /kanban/verb/selectWorkspace if not).');
                    return;
                }
            }

            // 4. Fire the exact arm a webview drag fires: it persists the move FIRST,
            //    then dispatches (the known move↔dispatch coupling order).
            const dispatchedAtBefore = record.dispatchedAt ?? null;
            await kanbanVerb('triggerAction', { sessionId, targetColumn, workspaceRoot, apiOriginated: true }, workspaceRoot);

            // 5. Verify against the DB — report what happened, not what was requested.
            const after: any = await db.getPlanByPlanId(record.planId);
            const column = after?.kanbanColumn ?? record.kanbanColumn;
            const moved = column === targetColumn;
            const dispatchObserved = !!after?.dispatchedAt && after.dispatchedAt !== dispatchedAtBefore;
            const dispatched = isPromptMode ? moved : dispatchObserved;
            const success = moved && dispatched;
            res.writeHead(success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success,
                planId: record.planId,
                sessionId,
                topic: record.topic,
                ...(routing ? { routing } : {}),
                role: gate?.role ?? null,
                mode: isPromptMode ? 'prompt (copied to clipboard/terminal per column config)' : 'terminal',
                column,
                moved,
                dispatched,
                dispatchedAgent: after?.dispatchedAgent || null,
                dispatchedAt: after?.dispatchedAt || null,
                ...(success ? {} : {
                    error: !moved
                        ? `Card did not land in '${targetColumn}' (currently '${column}')`
                        : 'Move persisted but no dispatch was recorded (dispatchedAt unchanged) — check the terminal agent'
                })
            }));
        } catch (err) {
            console.error('[LocalApiServer] kanbanDispatch error:', err);
            if (err instanceof Error && err.name === 'KanbanDispatchError') {
                fail(400, err.message);
                return;
            }
            fail(500, err instanceof Error ? err.message : 'kanbanDispatch failed');
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
            this._sendUnauthorized(res);
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
            const rawColumn = String(body?.targetColumn || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const planFile = body?.planFile ? String(body.planFile).trim() : undefined;
            if (!effectiveKey || !rawColumn) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: sessionId/planId and targetColumn' }));
                return;
            }
            const targetColumn = await this._canonicalColumnId(rawColumn, workspaceRoot);
            if (!targetColumn) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Unknown targetColumn '${rawColumn}' — valid column IDs: ${DEFAULT_KANBAN_COLUMNS.map((c: any) => c.id).join(' | ')} (plus any custom columns; see GET /kanban/columns)` }));
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
     * POST /kanban/features/assign — single (or batch) additive assign of existing plans
     * to an existing feature, resolved by path/slug/planId (Feature A · A3 ergonomic).
     * Body: { feature: string, plan?: string, plans?: string[], workspaceRoot?: string }.
     * This is the additive, no-UUID-choreography primitive; the existing
     * /kanban/feature/assign endpoint remains available for the kanban_operations script.
     */
    private async _handleKanbanFeaturesAssign(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
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
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const feature = String(body?.feature || '').trim();
            let planRefs: string[] = [];
            if (Array.isArray(body?.plans)) {
                planRefs = body.plans.map((p: any) => String(p).trim()).filter((p: string) => p.length > 0);
            } else if (body?.plan) {
                planRefs = [String(body.plan).trim()];
            }
            if (!feature) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: feature' }));
                return;
            }
            if (planRefs.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: plan or plans' }));
                return;
            }

            const result = await assignToFeature(workspaceRoot, feature, planRefs);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanFeaturesAssign error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanFeaturesAssign failed' }));
        }
    }

    /**
     * Handle POST /kanban/feature/remove — remove a single subtask from its parent
     * feature through the running extension. Reached by the kanban_operations
     * remove-from-feature.js script. Body: { subtaskPlanId: string, workspaceRoot?: string }.
     */
    private async _handleKanbanRemoveSubtaskFromFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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

    /**
     * POST /kanban/features/reconcile — declarative, path/slug-addressed feature
     * reconciliation (Feature A · A3). Converges the whole feature structure to a
     * desired end state in one idempotent call. Reached by the /switchboard-manage
     * skill and external agent hosts. Body:
     *   { workspaceRoot?, removeUnmentionedFeatures?, features: [{ name, description?,
     *     subtasks: ["<path|slug|planId>" | { slug, title, body }] }] }
     */
    private async _handleKanbanReconcileFeatures(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const reconcileFeatures = this._options.reconcileFeatures;
        if (!reconcileFeatures) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature reconciliation not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const removeUnmentionedFeatures = !!body?.removeUnmentionedFeatures;
            const features = Array.isArray(body?.features) ? body.features : null;
            if (!features || features.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'features must be a non-empty array' }));
                return;
            }

            const result = await reconcileFeatures(workspaceRoot, features, { removeUnmentionedFeatures });
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanReconcileFeatures error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanReconcileFeatures failed' }));
        }
    }

    /**
     * POST /kanban/verb/<name> — the A2b per-verb burn-down rail. Drives an
     * extracted `KanbanService` method over HTTP with the same host-agnostic
     * code path the webview `case '<name>':` arm takes. `<name>` is the
     * catalogued verb (the message `type`); the request body is the verb
     * payload (the webview `postMessage` shape). Security model: this is
     * untrusted network input gated by the server's localhost bind + `_checkAuth`
     * token (above); the provider dispatch is an explicit allowlist by verb name
     * (an unknown verb is rejected, never dynamically invoked) and the URL verb is
     * authoritative (any body `type` is stripped below). Per-verb payload-shape
     * validation is still owed as arms are properly extracted — many are thin
     * `_handleMessage` shims that forward the payload unvalidated; a malformed
     * payload is caught and returned as an error (500), never a crash. Every
     * extracted verb returns `{ success, ... }`; the body is passed through with
     * HTTP status derived from `success`.
     */
    private async _handleKanbanVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const kanbanVerb = this._options.kanbanVerb;
        if (!kanbanVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Kanban verb dispatch not available' }));
            return;
        }
        if (!verb) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing verb in path' }));
            return;
        }

        try {
            const rawBody = await this._parseJsonBody(req);
            // Strip any client-supplied `type` — the verb from the URL path is
            // authoritative. Without this, a body `{ "type": "deleteFeature", ... }`
            // would override the shim's `{ type: '<verb>', ...payload }` spread and
            // dispatch a DIFFERENT action than the one the allowlist checked.
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await kanbanVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] kanbanVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `kanban verb '${verb}' failed` }));
        }
    }

    private async _handlePlanningVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const planningVerb = this._options.planningVerb;
        if (!planningVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Planning verb dispatch not available' }));
            return;
        }
        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await planningVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] planningVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `planning verb '${verb}' failed` }));
        }
    }

    private async _handleDesignVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const designVerb = this._options.designVerb;
        if (!designVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Design verb dispatch not available' }));
            return;
        }
        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await designVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] designVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `design verb '${verb}' failed` }));
        }
    }

    private async _handleSetupVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const setupVerb = this._options.setupVerb;
        if (!setupVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Setup verb dispatch not available' }));
            return;
        }
        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await setupVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] setupVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `setup verb '${verb}' failed` }));
        }
    }

    private async _handleTaskViewerVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const taskViewerVerb = this._options.taskViewerVerb;
        if (!taskViewerVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'TaskViewer verb dispatch not available' }));
            return;
        }
        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await taskViewerVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] taskViewerVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `taskViewer verb '${verb}' failed` }));
        }
    }

    private async _handleWorktreeCleanup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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

    /**
     * POST /research/dispatch — hand a ready-to-run research prompt to an active
     * Researcher agent. Reached by the planner agent's `curl` when its "advise
     * research if unsure" add-on has an active researcher to delegate to. The host
     * callback (`onDispatchResearch`) decides: it dispatches only when a researcher
     * terminal is registered AND live, and returns `{ dispatched:false, reason }`
     * otherwise (never throws on "no researcher") so the planner falls back to
     * emitting the prompt in its chat summary. Body: `{ prompt, workspaceRoot? }`.
     */
    private async _handleResearchDispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const onDispatchResearch = this._options.onDispatchResearch;
        if (!onDispatchResearch) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Research dispatch not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const prompt = String(body?.prompt || '').trim();
            const workspaceRoot = body?.workspaceRoot
                ? String(body.workspaceRoot).trim()
                : (this._options.workspaceRoot || '');
            if (!prompt) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: prompt' }));
                return;
            }

            // The callback reports "no researcher active" as a normal result
            // (dispatched:false), never a throw — mirror the phone-a-friend
            // best-effort contract so the caller can branch on the outcome.
            //
            // Response shape: `dispatched` is the single top-level outcome
            // signal. Do NOT wrap in `{ success:true, ...result }` — that
            // wrapper contradicts `dispatched:false` with a `success:true`
            // sibling and HTTP 200, which agents key on to announce a phantom
            // hand-off and suppress the chat-paste fallback (the observed P0
            // "ram it through without a target agent" bug). Use the HTTP status
            // as the unambiguous gate instead:
            //   200 + { dispatched:true, ... }              → dispatched
            //   200 + { dispatched:false, reason:"..." }    → configured but offline (soft)
            //   404 + { dispatched:false, reason:"no researcher agent configured" }
            //                                               → no target configured (hard)
            // The 404-vs-200 distinction lets the directive branch cleanly:
            // any non-200 OR `dispatched` not `true` → fall back.
            const result = await onDispatchResearch(workspaceRoot, prompt);
            const status = (!result.dispatched && result.reason === 'no researcher agent configured') ? 404 : 200;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] researchDispatch error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'researchDispatch failed' }));
        }
    }

    private async _handleOrchestratorRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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

    /**
     * POST /orchestration/start — arm the unattended orchestration engine.
     * Calls startOrchestratorFromKanban (the same path the AUTOMATION tab button
     * takes). Body: { workspaceRoot? }. Reached by the /switchboard-manage skill
     * when the user explicitly asks to arm automation — never run on entry.
     */
    private async _handleOrchestrationStart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const orchestrationStart = this._options.orchestrationStart;
        if (!orchestrationStart) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Orchestration start not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            await orchestrationStart(workspaceRoot);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Orchestration engine armed' }));
        } catch (err) {
            console.error('[LocalApiServer] orchestrationStart error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'orchestration start failed' }));
        }
    }

    /**
     * POST /orchestration/stop — disarm the orchestration engine.
     * Calls stopOrchestratorFromKanban (disables orchestration, stops the autoban
     * clock, persists state, broadcasts). No body required.
     */
    private async _handleOrchestrationStop(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const orchestrationStop = this._options.orchestrationStop;
        if (!orchestrationStop) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Orchestration stop not available' }));
            return;
        }

        try {
            await orchestrationStop();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Orchestration engine disarmed' }));
        } catch (err) {
            console.error('[LocalApiServer] orchestrationStop error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'orchestration stop failed' }));
        }
    }

    // ─── Read endpoints for external AI coding tools ──────────────────────────

    private async _handleReadEndpoint(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        handler: () => Promise<any>
    ): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
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
                const data = await this._options.catalogProvider();
                // The provider swallows read errors and returns null when the catalog
                // file is absent — surface that as the plan-specified 404 rather than a
                // misleading 200 {data:null}.
                if (data == null) {
                    const err: any = new Error('catalog not generated; run `node scripts/generate-protocol-catalog.js --write` and ship protocol-catalog.json');
                    err.statusCode = 404;
                    throw err;
                }
                return data;
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
            this._sendUnauthorized(res);
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
                let terminals: string[] | undefined;
                try {
                    terminals = this._options.getRegisteredTerminals?.();
                } catch { /* health must never fail on a callback error */ }
                let selectedWorkspaceRoot: string | null | undefined;
                try {
                    selectedWorkspaceRoot = this._options.getSelectedWorkspaceRoot?.() ?? null;
                } catch { /* health must never fail on a callback error */ }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    port: this._port,
                    roots: this._allRoots,
                    ...(terminals !== undefined ? { terminals, terminalCount: terminals.length } : {}),
                    ...(selectedWorkspaceRoot !== undefined ? { selectedWorkspaceRoot } : {})
                }));
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
            } else if (pathname === '/kanban/dispatch' && req.method === 'POST') {
                await this._handleKanbanDispatch(req, res);
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
            } else if (pathname === '/kanban/features/assign' && req.method === 'POST') {
                await this._handleKanbanFeaturesAssign(req, res);
            } else if (pathname === '/kanban/features/reconcile' && req.method === 'POST') {
                await this._handleKanbanReconcileFeatures(req, res);
            } else if (pathname.startsWith('/kanban/verb/') && req.method === 'POST') {
                // A2b per-verb burn-down rail: /kanban/verb/<name> → KanbanService.
                const verb = decodeURIComponent(pathname.slice('/kanban/verb/'.length));
                await this._handleKanbanVerb(verb, req, res);
            } else if (pathname.startsWith('/planning/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/planning/verb/'.length));
                await this._handlePlanningVerb(verb, req, res);
            } else if (pathname.startsWith('/design/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/design/verb/'.length));
                await this._handleDesignVerb(verb, req, res);
            } else if (pathname.startsWith('/setup/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/setup/verb/'.length));
                await this._handleSetupVerb(verb, req, res);
            } else if (pathname.startsWith('/taskViewer/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/taskViewer/verb/'.length));
                await this._handleTaskViewerVerb(verb, req, res);
            } else if (pathname === '/kanban/orchestration/dispatch' && req.method === 'POST') {
                await this._handleOrchestrationDispatch(req, res);
            } else if (pathname === '/orchestration/start' && req.method === 'POST') {
                await this._handleOrchestrationStart(req, res);
            } else if (pathname === '/orchestration/stop' && req.method === 'POST') {
                await this._handleOrchestrationStop(req, res);
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
            } else if (pathname === '/research/dispatch' && req.method === 'POST') {
                await this._handleResearchDispatch(req, res);
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
