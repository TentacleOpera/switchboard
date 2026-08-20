
import { HostSeams, HostWatchHandle, TerminalHandle, createVscodeHostSeams } from './hostSeams';
import { composeExternalPrompt, LauncherSpec } from './externalAgentPrompts';
import {
    SharedUtilityVerbDeps,
    handleOpenExternalUrl,
    handleCopyDiagramPrompt,
    handleRenderMarkdownLive,
    handleCopyToClipboard,
    handleLinearLoadAutomationCatalog
} from './sharedUtilityVerbs';
import { BroadcastHub } from './broadcastHub';
import { PLANNING_VERBS } from '../generated/verbAllowlist';
import { validateVerbPayload } from './verbSchemas';
import * as vscode from 'vscode';
import { showTemporaryNotification } from '../utils/showTemporaryNotification';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { stateFs as fs } from './stateConfigBridge';
import { applyThemeBodyClass } from './themeBodyClass';
import { KanbanDatabase, type ColumnUpdateOutcome } from './KanbanDatabase';
import * as http from 'http';
import { fileURLToPath } from 'url';
import {
    ResearchImportService,
    TreeNode,
    NotionResearchAdapter
} from './ResearchImportService';
import { PlannerPromptWriter } from './PlannerPromptWriter';
import { NotionFetchService } from './NotionFetchService';
import { NotionBrowseService } from './NotionBrowseService';
import { LocalFolderService } from './LocalFolderService';
import { DesignPanelProvider } from './DesignPanelProvider';
import { LinearDocsAdapter } from './LinearDocsAdapter';
import { ClickUpDocsAdapter } from './ClickUpDocsAdapter';
import { PlanningPanelCacheService } from './PlanningPanelCacheService';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import { buildKanbanColumns, KanbanColumnDefinition, CustomKanbanColumnConfig, CustomAgentConfig, parseCustomAgents } from './agentConfig';
import { ReviewCommentRequest, ReviewCommentResult } from './reviewTypes';
import { isValidComplexityValue, legacyToScore, parseComplexityScore } from './complexityScale';
import { columnToPromptRole } from './agentPromptBuilder';
import { applyManualComplexityOverride } from './planMetadataUtils';
import { formatReviewLogEntries } from './reviewLogUtils';
import { PanelStateStore } from './PanelStateStore';
import { buildWorkspaceItems } from './workspaceUtils';
import { GlobalPlanWatcherService } from './GlobalPlanWatcherService';
import { InsightManager } from './InsightManager';
import { GovernanceFileKey } from './constitutionUtils';
import { reviveWithRetention, injectInitialWebviewState } from '../utils/reviveWithRetention';

import { getProjectPrdPath, sanitizeProjectSlug, buildPrdBuilderPrompt } from './prdUtils';
import { classifyHttpError } from './errorMessages';
import { stripImportedSubtasksBlock } from './ticketDisplayContent';
import { bundleDocsContext, DocsBundleSource } from './ContextBundler';

// The Create Plans planning prompt — behaviour-only by design (user flows and
// logic, not code). Shipped as HOW-TO-PLAN.md in the docs zip and copied (with
// a source-specific first line) for the link/platform sources.
const CREATE_PLANS_CORE_PROMPT = `You are helping plan a change to a product. You have its docs — read them and
write a plan that describes DESIRED BEHAVIOUR:
- What should the product do? What is the user flow, start to finish?
- What are the expected outcomes and the edge cases, in user terms?
- What is explicitly out of scope?

Do NOT write code, choose libraries, or design implementation. Stay at the level
of user flows and logic — how it should work, not how it is built. Defining the
base logic and the user experience is the point; turning it into code happens
later, inside the tool this plan goes back into.

Return the plan as markdown with a short title, a Goal, the flows/expected
behaviour, and edge cases. It will be pasted directly onto a planning board.`;

// Docs Health maintenance prompt — self-contained and tool-agnostic. Describes
// general categories of planning-navigational docs (not Switchboard-specific
// forms) so any agent, pointed at any project type, can build its own scanner
// logic and create/update the docs that apply. No references to Switchboard,
// VS Code, postMessage, dist/, or any host-specific path.
const DOCS_HEALTH_PROMPT = `You are maintaining planning docs for a project. These docs help planning agents
write better plans by providing navigational orientation — understanding the
project's structure, data flows, and code organization without reading every
file.

For each category below, check whether a doc of that kind exists and is current.
Create or update it as needed. You determine what's relevant — check file
existence, compare referenced paths against actual paths, verify line ranges are
still accurate, and determine which forms of each category apply to this
project's architecture. Doc conventions vary by project; adapt the format,
filenames, and structure to what makes sense for this project. Skip any category
that doesn't apply (e.g. a project with no large files doesn't need file TOCs;
a single-file script doesn't need a data-flow index).

1. Architecture / Component Map
Determine the project's structure — what are the major pieces and how do they
relate? Create or update a markdown file (e.g. ARCHITECTURE.md) that maps
features, UI areas, or modules to their source files. Include a folder-layout
overview. The form depends on the project type: a web service maps
routes→handlers→models; a CLI maps commands→modules; a library maps public
API→internal modules; a browser extension maps panels→HTML→scripts→providers;
a mobile app maps screens→components→state stores. If a map exists, verify the
mappings are still accurate and update stale references.

2. Data-Flow / Interface Index
Identify how information moves through the system — the entry points, messages,
or interfaces between layers. Create or update a markdown file listing each one
with where it's defined, where it's handled, and its purpose. The form depends
on the project: a web service lists API endpoints (method, path, handler,
purpose); a browser extension lists message types and handlers; an event-driven
app lists events, publishers, subscribers; a CLI lists flags and subcommands;
a library lists exported functions/classes. If an index exists, verify entries
are current. If the project has no inter-layer communication (e.g. a
single-file script), note that and skip.

3. Search Scoping Guidelines
Identify which directories contain source code vs build artifacts, generated
files, and dependencies. Check the project's root README or agent instructions
for a note telling agents where to search and where not to. If missing, add a
short section naming the source directories and the directories to ignore.
Build your own logic to distinguish source from generated — common signals: the
directory is in .gitignore, it's listed as an output in a build config, or it
contains compiled/transpiled output.

4. Navigation Aids in Large Files
Identify source files over ~500 lines. For each, check if it has a
table-of-contents comment block near the top listing major sections with
approximate line ranges. If missing, read the file, identify its major regions,
and add a TOC comment block in the appropriate comment syntax for the language.
If present, verify the line ranges are still approximately accurate. If no
files exceed the threshold, note that and skip.

Report back with a summary of what you created, updated, confirmed as current,
or skipped and why.`;


export interface PlanningPanelAdapterFactories {
    getNotionService: (root: string) => NotionFetchService;
    getNotionBrowseService: (root: string) => NotionBrowseService;
    getLinearDocsAdapter: (root: string) => LinearDocsAdapter;
    getClickUpDocsAdapter: (root: string) => ClickUpDocsAdapter;
    getCacheService: (root: string) => PlanningPanelCacheService;
    getLinearSyncService: (root: string) => any;
    getClickUpSyncService: (root: string) => any;
}

interface KanbanPlanSummary {
    planId: string;
    sessionId: string;
    topic: string;
    column: string;
    workspaceRoot: string;  // full absolute path — used as filter key
    workspaceLabel: string; // path.basename(workspaceRoot) — displayed in UI
    project: string;        // '' if no project
    repoScope: string;      // '' if no repo scope
    mtime: number;
    planFile: string;
    complexity: string;
    isFeature?: number;
    featureId?: string;
    subtaskCount?: number;
    clickupTaskId?: string;
    linearIssueId?: string;
}

// ┌─ Section Map (approx, ±20 lines) ──────────────────────────────────────
// │ Imports & type defs .......................... lines 1–185
// │ class PlanningPanelProvider .................... line 187
// │   handleServiceVerb / verb delegation ......... lines 189–268
// │   Seam bundle / webview setup / message
// │     listener wiring .......................... lines 269–903
// │   postMessageToWebview / project fan-out ...... lines 1010–1083
// │   Theme / animation / scanlines settings ....... lines 904–933
// │   _handleMessage switch (planning + project) .. lines 2593–5312
// │     Roots / tab-state / comment / containers ... lines 2622–2983
// │     Docs fetch / filtered / pages .............. lines 2987–3095
// │     Create-plans wizard ....................... lines 3096–3272
// │     Local docs / link / duplicate .............. lines 3274–3462
// │     Artifact / html-tweak / chat prompts ....... lines 3462–3522
// │     Kanban plans / features / constitution ..... lines 3609–4642
// │     Project PRD / context / architect .......... lines 4288–4632
// │     File save / linear catalog / online sync ... lines 4736–5312
// │   Online doc create / sync / import-full-doc ... lines 4999–6912
// │   Import research doc / ticket-file-changed .... lines 6958–7209
// │   Stitch / insights / tuning arms .............. lines 5193–5312
// │   Planning HTML preview server ................ lines 1856–1933
// └──────────────────────────────────────────────────────────────────────────

export class PlanningPanelProvider {

    public async handleServiceVerb(verb: string, payload: any): Promise<any> {
        if (!this._broadcaster) {
            this._initPlanningService();
        }
        // Memo verbs: the memo capture UI was relocated from project.html to the
        // standalone memo panel (memo.html), posted at POST /memo/verb/<verb>.
        // The verb handlers still live on TaskViewerProvider (they're file I/O +
        // planner dispatch), so delegate to it when a memo verb is posted. The
        // verbs are in TASKVIEWER_VERBS, not PLANNING_VERBS — without this
        // delegation the PLANNING_VERBS guard below would reject them.
        if (verb === 'memoLoad' || verb === 'memoSave' || verb === 'memoClear'
            || verb === 'memoGeneratePrompt' || verb === 'memoListWorkspaces') {
            if (this._taskViewerProvider) {
                return this._taskViewerProvider.handleServiceVerb(verb, payload);
            }
            throw new Error(`Memo verb '${verb}' requires TaskViewerProvider, which is not attached.`);
        }
        // improvePlan is implemented by KanbanProvider (KanbanProvider.ts:9797) and
        // catalogued under KANBAN_VERBS, but the button that posts it lives in the
        // PROJECT panel (project.js:2075), whose route prefix is /project/verb →
        // handleServiceVerb here. Without this delegation the PLANNING_VERBS guard
        // below rejects it and the browser shows "Unknown Planning verb: 'improvePlan'";
        // in the editor it fell through _handleMessage with no case and did nothing.
        // Same shape as the memo delegation above, and for the same reason: the verb is
        // catalogued on another provider, so this MUST sit before the guard.
        // Return the result verbatim — it carries `prompt`, which transport.js:292 uses
        // to put the improve-plan prompt on the BROWSER clipboard.
        if (verb === 'improvePlan') {
            if (this._kanbanProvider) {
                return this._kanbanProvider.handleServiceVerb(verb, payload);
            }
            throw new Error(`Verb '${verb}' requires KanbanProvider, which is not attached.`);
        }
        if (!PLANNING_VERBS.has(verb)) {
            throw new Error(`Unknown Planning verb: '${verb}'`);
        }
        // Network boundary: validate untrusted HTTP payloads against the verb's
        // schema (verbs with no schema yet pass through — generic-dispatch contract).
        const validation = validateVerbPayload('planning', verb, payload);
        if (!validation.ok) {
            throw new Error(`Invalid payload for Planning verb '${verb}': ${validation.error}`);
        }
        // VS Code is the host here; _handleMessage runs in-process. Command verbs
        // return the route layer's {success:true} ack (most _handleMessage impls are
        // void); read verbs emit their result over the WS hub (see plan).
        // `type` is set LAST so a payload `type` field can never override the
        // allowlist-checked verb, regardless of caller.
        return await this._handleMessage({ ...(payload ?? {}), type: verb });
    }


    private _initPlanningService(): void {
        const workspaceRoot = this._getWorkspaceRoot() || '';
        if (!workspaceRoot) {
            this._hostSeams = undefined;
            this._broadcaster = undefined;
            return;
        }
        this._hostSeams = createVscodeHostSeams(workspaceRoot, this._context.secrets);
        if (!this._broadcaster) {
            this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: this._apiServer ?? null });
        } else {
            this._broadcaster.setWebview(this._panel?.webview);
            if (this._apiServer) {
                this._broadcaster.setApiServer(this._apiServer);
            }
        }
    }

    private _apiServer?: any;

    public setApiServer(server: any): void {
        this._apiServer = server;
        this._broadcaster?.setApiServer(server);
    }

    private _hostSeams?: HostSeams;
    private _broadcaster?: BroadcastHub;

    /**
     * Seam bundle accessor for migrated _handleMessage arms. Lazily builds the
     * vscode-backed bundle when the provider is driven before `_initPlanningService`
     * ran (or when no workspace root resolved — seams still work; path-scoped
     * config reads just resolve against the empty root). The test-seam harness
     * injects a headless bundle by assigning `_hostSeams` directly.
     */
    private _seams(): HostSeams {
        if (!this._hostSeams) {
            this._hostSeams = createVscodeHostSeams(this._getWorkspaceRoot() || '', this._context.secrets);
        }
        return this._hostSeams;
    }

    private static readonly IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg']);
    private _panel: vscode.WebviewPanel | undefined;
    private _projectPanel: vscode.WebviewPanel | undefined;
    private _projectPanelReady = false;
    private _projectPanelConfigDisposable: vscode.Disposable | undefined;
    private _pendingProjectMessages: any[] = [];
    private _projectPanelReadyTimer: NodeJS.Timeout | undefined;
    private _projectPanelOpening: Promise<void> | undefined;
    private _projectPanelRestoring = false;
    private _disposables: vscode.Disposable[] = [];
    private _latestRequestIds: Map<string, number> = new Map();

    /** Provider-assigned push tickets, keyed like `_latestRequestIds` but never client-supplied. */
    private _pushTickets: Map<string, number> = new Map();

    /**
     * Race guard for request/response verbs, as a PUSH gate only. Takes a provider-side
     * ticket for `key` and returns a predicate that reports whether this call is still
     * the most recent one for that key once its async work finishes — i.e. whether an
     * unsolicited push would be overwriting fresher data with staler data.
     *
     * Two rules make it safe, and both matter:
     *
     * 1. It must never reject the request. Client `requestId`s are per-client counters
     *    starting at 1, while the guard map is provider-global — so rejecting on them
     *    starved whichever client counted lower. With an editor panel open (or after any
     *    browser reload) every cockpit `fetchFilteredDocs` returned
     *    `{success:false, error:'Stale request'}` and the Notion/Linear/ClickUp sections
     *    sat on "Loading..." forever. Callers now always get their own answer in-body.
     *
     * 2. The ticket is assigned HERE, not read from the payload. Gating on client ids
     *    would just invert the starvation — a browser tab sitting at id 30 would suppress
     *    every push for an editor panel still at id 5, silently freezing the editor.
     *    A provider-side counter means "the newest arrival for this key wins", whoever
     *    sent it, which is the actual intent.
     *
     * Per-client ordering is unaffected: each client already drops replies whose
     * requestId it did not issue (e.g. `handleFilteredDocsReady` in planning.js).
     */
    private _isFreshRequest(key: string): () => boolean {
        const ticket = (this._pushTickets.get(key) || 0) + 1;
        this._pushTickets.set(key, ticket);
        return () => this._pushTickets.get(key) === ticket;
    }

    private _registeredRootsKey: string | null = null;
    private _cacheService: PlanningPanelCacheService | undefined;
    private _periodicSyncTimer: NodeJS.Timeout | undefined;
    private _currentSyncMode: string = 'no-sync';
    private _syncCancellationSource: AbortController | undefined;
    private _importInProgress = false;
    private _docsFolderWatcher: HostWatchHandle | undefined;
    private _localFolderWatchers: HostWatchHandle[] = [];
    private _localDocsDebounce: NodeJS.Timeout | undefined;
    private _lastLocalDocsSignature = ''; // content dedup: skip re-posting an unchanged local-docs list
    private _lastPreviewContentByPath: Map<string, string> = new Map(); // content dedup: skip re-sending unchanged preview content
    private _lastWebviewRootsSignature = ''; // skip reassigning webview.options when roots are unchanged (avoids reload loop)
    private _antigravityWatchers: HostWatchHandle[] = [];
    private _activeDocWatcher: HostWatchHandle | undefined;
    private _activeDocWatchDebounce: NodeJS.Timeout | undefined;
    private _kanbanPlansWatchers: HostWatchHandle[] = [];
    private _kanbanPlansWatchDebounce: NodeJS.Timeout | undefined;
    private _featureDocsWatchers: HostWatchHandle[] = [];
    private _featureDocsWatchDebounce: NodeJS.Timeout | undefined;
    private _constitutionWatchers: HostWatchHandle[] = [];
    private _constitutionWatchDebounce: NodeJS.Timeout | undefined;
    private _insightsWatchers: HostWatchHandle[] = [];
    private _insightsWatchDebounce: NodeJS.Timeout | undefined;
    private _ticketsViewWatcher: HostWatchHandle | undefined;
    private _ticketsViewWatcherDebounces: Map<string, NodeJS.Timeout> = new Map();
    private _lastPanelWriteTimestamp: number = 0;
    private _isAutoRefreshing: boolean = false;
    private _nonce: string = '';
    private _activePreviewPath: string | null = null;
    private _activePreviewSourceId: string | null = null;
    private _activePreviewDocId: string | null = null;
    private _activePreviewSourceFolder: string | null = null;
    private _activePreviewWorkspaceRoot: string | undefined;
    private _planningHtmlFolderWatchers: HostWatchHandle[] = [];
    private _planningHtmlDocsDebounce: NodeJS.Timeout | undefined;
    private _planningHtmlServers = new Map<string, { server: http.Server; port: number; timeoutId: NodeJS.Timeout }>();
    private _planningHtmlServerCreationPromises = new Map<string, Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }>>();
    private _activePlanningHtmlPreview: { sourceFolder: string; docId: string; sourceId: string } | null = null;
    private _saveTextDocListener: HostWatchHandle | undefined;
    private _watcherGeneration: number = 0;
    private _moveTargetsCache = new Map<string, { at: number; targets: Array<{ id: string; name: string; path: string }> }>();
    private static readonly MOVE_TARGETS_TTL_MS = 60_000;

    private _activeTicketsProvider: 'clickup' | 'linear' | null = null;
    // Type-only reference (avoids a runtime circular import with KanbanProvider).
    private _kanbanProvider?: import('./KanbanProvider').KanbanProvider;
    private _fullKanbanPlansSent = false;
    // Type-only reference (avoids a runtime circular import with TaskViewerProvider).
    // Used to dispatch constitution builder/updater + system builder prompts through the planner rotation.
    private _taskViewerProvider?: import('./TaskViewerProvider').TaskViewerProvider;
    private readonly _SERVER_DENY_LIST: readonly string[] = [
        '.switchboard',
        '.git',
        '.env',
        '.env.',
        'node_modules',
        'secrets',
        'credentials',
        '.ssh',
        '.aws',
    ];

    private _resolvedConfigCache: {
        configPath: string | null;
        config: { syncMode: string; browseFilterContainers: Record<string, string>; selectedContainers: string[]; uploadLocations: Record<string, string>; docMappings: Record<string, { sourceId: string; docId: string; url?: string }> };
        sourceRoot: string;
    } | null = null;

    constructor(
        private _extensionUri: vscode.Uri,
        private _researchImportService: ResearchImportService,
        private _plannerPromptWriter: PlannerPromptWriter,
        private _getWorkspaceRoot: () => string | undefined,
        private _adapterFactories: PlanningPanelAdapterFactories,
        private _context: vscode.ExtensionContext,
        private _stateStore: PanelStateStore
    ) {}

    public setKanbanProvider(provider: import('./KanbanProvider').KanbanProvider): void {
        this._kanbanProvider = provider;
    }

    public setTaskViewerProvider(provider: import('./TaskViewerProvider').TaskViewerProvider): void {
        this._taskViewerProvider = provider;
    }

    // Ensure adapters are registered for current workspace roots.
    // Safe to call from any context — the roots-key guard makes this idempotent.
    // Called from _handleMessage() on every webview message, so the guard must be cheap.
    private _ensureAdaptersRegistered(): void {
        const allRoots = this._getWorkspaceRoots();
        if (allRoots.length === 0) { return; }

        // Using JSON.stringify for deterministic comparison of roots arrays
        const rootsKey = JSON.stringify(allRoots);
        if (this._registeredRootsKey === rootsKey) {
            // Roots unchanged — no need to re-register. Even if adapters were cleared
            // externally (e.g. clearAdapters() during workspace folder change), the
            // onDidChangeWorkspaceFolders handler will invalidate _registeredRootsKey
            // by calling us again, which will re-register with the new roots.
            return;
        }

        console.log('[PlanningPanel] Registering adapters globally...');

        // Clear existing adapters to avoid duplicates from previous registrations
        this._researchImportService.clearAdapters();

        const workspaceRoot = allRoots[0];

        // Notion
        try {
            const notionService = this._adapterFactories.getNotionService?.(workspaceRoot);
            const notionBrowseService = this._adapterFactories.getNotionBrowseService?.(workspaceRoot);
            if (notionService && notionBrowseService) {
                this._researchImportService.registerAdapter(
                    new NotionResearchAdapter(workspaceRoot, notionService, notionBrowseService)
                );
                console.log('[PlanningPanel] Registered Notion adapter globally');
            }
        } catch (err) {
            console.debug('[PlanningPanel] Notion adapter registration failed:', err);
        }

        // Linear
        try {
            const linearAdapter = this._adapterFactories.getLinearDocsAdapter?.(workspaceRoot);
            if (linearAdapter) {
                this._researchImportService.registerAdapter(linearAdapter);
                console.log('[PlanningPanel] Registered Linear adapter globally');
            }
        } catch (err) {
            console.debug('[PlanningPanel] Linear adapter registration failed:', err);
        }

        // ClickUp
        try {
            const clickUpAdapter = this._adapterFactories.getClickUpDocsAdapter?.(workspaceRoot);
            if (clickUpAdapter) {
                this._researchImportService.registerAdapter(clickUpAdapter);
                console.log('[PlanningPanel] Registered ClickUp adapter globally');
            }
        } catch (err) {
            console.debug('[PlanningPanel] ClickUp adapter registration failed:', err);
        }

        this._registeredRootsKey = rootsKey;
        console.log('[PlanningPanel] Adapter registration complete. Available sources:', this._researchImportService.getAvailableSources());
    }

    private async _resolveSyncConfig(): Promise<{
        configPath: string | null;
        config: {
            syncMode: string;
            browseFilterContainers: Record<string, string>;
            selectedContainers: string[];
            uploadLocations: Record<string, string>;
            docMappings: Record<string, { sourceId: string; docId: string; url?: string }>;
        };
        sourceRoot: string;
    }> {
        // Return cached result if available (resolves race condition on repeated calls)
        if (this._resolvedConfigCache) {
            return this._resolvedConfigCache;
        }

        const allRoots = this._getWorkspaceRoots();
        const defaultConfig = { syncMode: 'no-sync', browseFilterContainers: {}, selectedContainers: [] as string[], uploadLocations: {}, docMappings: {} };

        // Search all roots for config
        for (const root of allRoots) {
            try {
                const db = KanbanDatabase.forWorkspace(root);
                const syncMode = await db.getConfig('planning.syncMode');
                if (syncMode !== null) {
                    const selectedContainers = await db.getConfigJson<string[]>('planning.selectedContainers', []);
                    const browseFilterContainers = await db.getConfigJson<Record<string, string>>('planning.browseFilterContainers', {});
                    const uploadLocations = await db.getConfigJson<Record<string, string>>('planning.uploadLocations', {});
                    const docMappings = await db.getConfigJson<Record<string, { sourceId: string; docId: string; url?: string }>>('planning.docMappings', {});
                    const config = { syncMode, browseFilterContainers, selectedContainers, uploadLocations, docMappings };
                    console.log(`[PlanningPanel] Using sync config from DB for: ${root}`);
                    const result = { configPath: 'db', config, sourceRoot: root };
                    this._resolvedConfigCache = result;
                    return result;
                }
            } catch (err) {
                // Config not found in this root, continue searching
            }
        }

        // No config found in any root
        const result = { configPath: null, config: defaultConfig, sourceRoot: '' };
        this._resolvedConfigCache = result;
        return result;
    }

    private async _resolveWorkspacePath(
        relativePath: string,
        options?: { preferActive?: boolean }
    ): Promise<{ path: string | null; source: string }> {
        const allRoots = this._getWorkspaceRoots();
        const activeRoot = this._getWorkspaceRoot();

        // Try active root first if preferActive is set (or by default)
        if (options?.preferActive !== false && activeRoot) {
            const resolvedPath = path.join(activeRoot, relativePath);
            if (fs.existsSync(resolvedPath)) {
                return { path: resolvedPath, source: 'active workspace' };
            }
        }

        // Try first root as fallback
        if (allRoots.length > 0) {
            const firstRoot = allRoots[0];
            const firstPath = path.join(firstRoot, relativePath);
            if (fs.existsSync(firstPath)) {
                return { path: firstPath, source: 'first workspace' };
            }
        }

        // Search all remaining roots
        for (const root of allRoots) {
            if (root === activeRoot) { continue; } // Already tried active
            if (root === allRoots[0]) { continue; } // Already tried first

            const candidate = path.join(root, relativePath);
            if (fs.existsSync(candidate)) {
                return { path: candidate, source: `workspace ${path.basename(root)}` };
            }
        }

        return { path: null, source: 'not found' };
    }

    /**
     * Signal that a project-panel serializer restore may be in-flight.
     * Called from extension.ts ONLY after confirming a switchboard-project
     * tab exists in the editor layout (via TabGroups API). openProject()
     * will wait briefly for the serializer before creating a duplicate.
     */
    public markProjectPanelRestoring(): void {
        this._projectPanelRestoring = true;
        // Safety net: if VS Code never calls the serializer (e.g., the tab was
        // closed externally after layout save, or lazy-restored in a background
        // group), clear the flag after a generous timeout so openProject()
        // isn't permanently blocked.
        setTimeout(() => {
            if (this._projectPanelRestoring) {
                console.warn('[ProjectPanel] Restore flag still set after 8s — clearing (serializer may not fire for this session).');
                this._projectPanelRestoring = false;
            }
        }, 8000);
    }

    public async openProject(): Promise<void> {
        if (this._projectPanelOpening) {
            await this._projectPanelOpening;
            if (this._projectPanel) {
                // Reveal the panel where it currently lives. Passing an explicit
                // ViewColumn.One would relocate it into the main window's first
                // column, yanking it out of an auxiliary ("Move Editor into New
                // Window") window. Omit the column to reveal in place; preserve
                // focus so we don't steal the user off the board they clicked.
                this._projectPanel.reveal(undefined, true);
            }
            return;
        }

        if (this._projectPanel) {
            this._projectPanel.reveal(undefined, true);
            if (this._projectPanelReady) {
                this.postMessageToProjectWebview({ type: 'refreshKanbanPlans' });
            }
            return;
        }

        // If a serializer restore is pending, wait briefly for it before creating
        // a new panel. This closes the gap between activation and the serializer
        // call that would otherwise produce a duplicate tab.
        if (this._projectPanelRestoring) {
            await this._waitForRestore();
            // Re-check: the serializer may have set _projectPanel while we waited.
            // Capture into a const local so the post-await narrowing survives the
            // earlier `if (this._projectPanel) { return; }` which pinned the member
            // to `undefined` in this branch's control-flow analysis. The `as` cast
            // re-widens the read to its declared union so the truthiness guard
            // below narrows to WebviewPanel rather than `never`.
            const restoredPanel = this._projectPanel as vscode.WebviewPanel | undefined;
            if (restoredPanel) {
                restoredPanel.reveal(undefined, true);
                if (this._projectPanelReady) {
                    this.postMessageToProjectWebview({ type: 'refreshKanbanPlans' });
                }
                return;
            }
            // Serializer didn't fire in time — fall through to create a fresh panel.
            // The ghost tab (if any) will be overwritten when the serializer
            // eventually fires, or it was already disposed by VS Code.
            console.warn('[ProjectPanel] Restore wait expired — creating fresh panel.');
        }

        this._projectPanelOpening = this._doOpenProject();
        try {
            await this._projectPanelOpening;
        } finally {
            this._projectPanelOpening = undefined;
        }
    }

    private _waitForRestore(): Promise<void> {
        return new Promise<void>(resolve => {
            const checkInterval = 50; // ms
            const maxWait = 1500; // ms — tight; serializer fires within ~200-800ms
                                   // in practice. 1.5s is generous enough to absorb
                                   // slow extension hosts without noticeable delay.
            let elapsed = 0;
            const timer = setInterval(() => {
                elapsed += checkInterval;
                if (this._projectPanel || !this._projectPanelRestoring || elapsed >= maxWait) {
                    clearInterval(timer);
                    this._projectPanelRestoring = false;
                    resolve();
                }
            }, checkInterval);
        });
    }

    private async _doOpenProject(column?: vscode.ViewColumn, restoredState?: any): Promise<void> {
        const targetColumn = column ?? vscode.ViewColumn.One;
        // `column` is supplied only by reviveWithRetention, so it doubles as the
        // revival discriminator: preserveFocus on revival, focus on user-invoked open.
        const isRevival = column !== undefined;
        this._lastWebviewRootsSignature = '';
        if (this._projectPanel) {
            // Reveal in place (undefined column) unless reviving into a captured group —
            // passing a concrete column would YANK an already-open panel to that group.
            this._projectPanel.reveal(column, true);
            return;
        }

        this._projectPanel = vscode.window.createWebviewPanel(
            'switchboard-project',
            'PROJECT',
            { viewColumn: targetColumn, preserveFocus: isRevival },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        // Fresh webview: must re-handshake before any outbound message is delivered.
        this._projectPanelReady = false;
        this._pendingProjectMessages = [];
        if (this._projectPanelReadyTimer) {
            clearTimeout(this._projectPanelReadyTimer);
            this._projectPanelReadyTimer = undefined;
        }
        // Best-effort flush safeguard: if the webview never signals readiness
        // (e.g. a script error blocks boot), flush the queue after 10s so it
        // doesn't grow unbounded.
        this._projectPanelReadyTimer = setTimeout(() => {
            if (!this._projectPanelReady && this._projectPanel) {
                console.warn('[ProjectPanel] webviewReady not received within 10s; flushing pending messages best-effort.');
                this._flushPendingProjectMessages();
            }
        }, 10000);
        this._projectPanel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
        this._updateWebviewRoots();

        this._projectPanel.webview.html = injectInitialWebviewState(this._getProjectHtml(this._projectPanel.webview), restoredState);

        this._projectPanel.webview.onDidReceiveMessage(
            async message => {
                try {
                    await this._handleMessage(message, true);
                } catch (err) {
                    console.error('[ProjectPanel] Message handler error:', err);
                    this.postMessageToProjectWebview({ type: 'error', message: String(err) });
                }
            },
            null,
            this._disposables
        );

        this._projectPanel.onDidDispose(
            () => {
                this._projectPanel = undefined;
                this._projectPanelReady = false;
                this._projectPanelOpening = undefined;
                this._projectPanelRestoring = false;
                this._pendingProjectMessages = [];
                if (this._projectPanelReadyTimer) {
                    clearTimeout(this._projectPanelReadyTimer);
                    this._projectPanelReadyTimer = undefined;
                }
                this._projectPanelConfigDisposable?.dispose();
                this._projectPanelConfigDisposable = undefined;
            },
            null,
            this._disposables
        );

        this._projectPanel.onDidChangeViewState(
            (e) => {
                if (e.webviewPanel.visible) {
                    this.postMessageToProjectWebview({ type: 'refreshKanbanPlans' });
                }
            },
            null,
            this._disposables
        );

        // Hot-swap the theme on the Project panel when the setting changes (it previously
        // only learned the theme on init, so it needed a reload to update).
        this._registerProjectPanelConfigListener();

        const theme = this._seams().pathConfig.getConfigStringWithDefault('theme.name', 'afterburner');
        this.postMessageToProjectWebview({ type: 'switchboardThemeChanged', theme });
        const disabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberAnimation', false);
        this.postMessageToProjectWebview({ type: 'cyberAnimationSetting', disabled });
        const scanlinesDisabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberScanlines', false);
        this.postMessageToProjectWebview({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
    }

    private _registerProjectPanelConfigListener(): void {
        // Dispose any previous listener to avoid duplicates on re-registration
        // (openProject() and _hydratePanel(...,true) can both run in one session).
        this._projectPanelConfigDisposable?.dispose();
        this._projectPanelConfigDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('switchboard.theme.name')) {
                const t = this._seams().pathConfig.getConfigStringWithDefault('theme.name', 'afterburner');
                this.postMessageToProjectWebview({ type: 'switchboardThemeChanged', theme: t });
            }
            if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
                const d = this._seams().pathConfig.getConfigBoolean('theme.disableCyberAnimation', false);
                this.postMessageToProjectWebview({ type: 'cyberAnimationSetting', disabled: d });
            }
            if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
                const scanlinesDisabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberScanlines', false);
                this.postMessageToProjectWebview({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
            }
            if (e.affectsConfiguration('switchboard.theme.ultracodeAnimation')) {
                const enabled = this._seams().pathConfig.getConfigBoolean('theme.ultracodeAnimation', false);
                this.postMessageToProjectWebview({ type: 'ultracodeAnimationSetting', enabled });
            }
        });
        this._disposables.push(this._projectPanelConfigDisposable);
    }

    private _getProjectHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        this._nonce = nonce;
        const cspSource = webview.cspSource;

        const possiblePaths = [
            path.join(this._extensionUri.fsPath, 'dist', 'webview', 'project.html'),
            path.join(this._extensionUri.fsPath, 'webview', 'project.html'),
            path.join(this._extensionUri.fsPath, 'src', 'webview', 'project.html')
        ];

        let htmlContent = '';
        for (const htmlPath of possiblePaths) {
            try {
                if (fs.existsSync(htmlPath)) {
                    htmlContent = fs.readFileSync(htmlPath, 'utf8');
                    break;
                }
            } catch {
                // Continue to next path
            }
        }

        if (!htmlContent) {
            htmlContent = '<html><body><h1>Project panel HTML not found</h1></body></html>';
        }

        htmlContent = htmlContent.replace(/\{\{NONCE\}\}/g, nonce);
        htmlContent = htmlContent.replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, cspSource);

        const projectJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'project.js')
        );
        htmlContent = htmlContent.replace(/\{\{PROJECT_JS_URI\}\}/g, projectJsUri.toString());

        const sharedTabsCssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'shared-tabs.css')
        );
        htmlContent = htmlContent.replace(/\{\{SHARED_TABS_CSS_URI\}\}/g, sharedTabsCssUri.toString());

        const sharedUtilsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedUtils.js')
        );
        htmlContent = htmlContent.replace(/\{\{SHARED_UTILS_URI\}\}/g, sharedUtilsUri.toString());

        const markdownEditorUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'markdownEditor.js')
        );
        htmlContent = htmlContent.replace(/\{\{MARKDOWN_EDITOR_URI\}\}/g, markdownEditorUri.toString());

        const geistPixelFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'GeistPixel-Square.woff2')
        );
        htmlContent = htmlContent.replace(/\{\{GEIST_PIXEL_FONT_URI\}\}/g, geistPixelFontUri.toString());

        const hankenFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'HankenGrotesk-Variable.woff2')
        );
        htmlContent = htmlContent.replace(/\{\{HANKEN_FONT_URI\}\}/g, hankenFontUri.toString());

        htmlContent = applyThemeBodyClass(htmlContent);
        return htmlContent;
    }

    public async open(column?: vscode.ViewColumn, restoredState?: any): Promise<void> {
        const targetColumn = column ?? vscode.ViewColumn.One;
        // preserveFocus only on revival — see _doOpenProject().
        const isRevival = column !== undefined;
        // Force the next local-docs send to render (the dedup cache must not starve a
        // freshly revealed/created panel).
        this._lastLocalDocsSignature = '';
        this._lastPreviewContentByPath.clear();
        // CRITICAL: reset the webview-roots dedup guard so the first _updateWebviewRoots()
        // on a freshly created panel ALWAYS reassigns webview.options. If a prior panel was
        // disposed with the same workspace-roots signature still cached, the guard would
        // skip the assignment on the new panel — leaving enableScripts unset, blocking all
        // scripts, and freezing the panel on an infinite "Loading…" (stuck on Local Docs).
        this._lastWebviewRootsSignature = '';
        if (this._panel) {
            this._panel.reveal(targetColumn, isRevival);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-planning',
            'ARTIFACTS',
            { viewColumn: targetColumn, preserveFocus: isRevival },
            {
                // enableScripts MUST be set at creation time, not left to depend solely on
                // _updateWebviewRoots() — otherwise a stale dedup guard can leave a new panel
                // with scripts disabled (see _lastWebviewRootsSignature reset above).
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
        this._updateWebviewRoots();

        this._panel.webview.html = injectInitialWebviewState(this._getHtml(this._panel.webview), restoredState);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                try {
                    await this._handleMessage(message);
                } catch (err) {
                    console.error('[PlanningPanel] Message handler error:', err);
                    this.postMessageToWebview({ type: 'error', message: String(err) });
                }
            },
            null,
            this._disposables
        );

        this._initPlanningService();

        this._panel.onDidDispose(
            () => {
                this._broadcaster?.setWebview(null);
                this.dispose();
            },
            null,
            this._disposables
        );

        // Register adapters when panel opens
        this._ensureAdaptersRegistered();

        this._disposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => {
                this.postMessageToWebview({ type: 'themeChanged' });
            })
        );

        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
                    const disabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberAnimation', false);
                    this.postMessageToWebview({ type: 'cyberAnimationSetting', disabled });
                }
                if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
                    const scanlinesDisabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberScanlines', false);
                    this.postMessageToWebview({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
                }
                if (e.affectsConfiguration('switchboard.theme.name')) {
                    const theme = this._seams().pathConfig.getConfigStringWithDefault('theme.name', 'afterburner');
                    this.postMessageToWebview({ type: 'switchboardThemeChanged', theme });
                }
                if (e.affectsConfiguration('switchboard.theme.ultracodeAnimation')) {
                    const enabled = this._seams().pathConfig.getConfigBoolean('theme.ultracodeAnimation', false);
                    this.postMessageToWebview({ type: 'ultracodeAnimationSetting', enabled });
                }
            })
        );

        // Re-register adapters when workspace folders change
        this._disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                console.log('[PlanningPanel] Workspace folders changed, re-registering adapters');
                this._ensureAdaptersRegistered();
                this._setupKanbanPlansWatcher();
                this._setupFeatureDocsWatcher();
                this._setupConstitutionWatcher();
                this._setupInsightsWatcher();
                this.postMessageToWebview({
                    type: 'workspaceItemsUpdated',
                    items: buildWorkspaceItems(this._getWorkspaceRoots())
                });
            })
        );

        // Watch the docs directory for changes and refresh imported docs list
        this._setupDocsFolderWatcher(this._getWorkspaceRoot() || this._getWorkspaceRoots()[0]);
        this._setupLocalFolderWatchers();
        this._setupPlanningHtmlFolderWatchers();

        this._setupAntigravityWatcher();
        this._setupKanbanPlansWatcher();
        this._setupFeatureDocsWatcher();
        this._setupConstitutionWatcher();
        this._setupInsightsWatcher();

        // Send initial active design doc state

    }

    public async deserializeWebviewPanel(
        panel: vscode.WebviewPanel,
        state: any
    ): Promise<void> {
        await reviveWithRetention(panel, async (col, restoredState) => {
            await this.open(col, restoredState);
        }, state);
    }

    public async deserializeProjectPanel(
        panel: vscode.WebviewPanel,
        state: any
    ): Promise<void> {
        this._projectPanelRestoring = false;
        // If openProject() already created a panel while we waited for the
        // serializer, dispose the ghost — we can't have two.
        if (this._projectPanel) {
            panel.dispose();
            return;
        }
        await reviveWithRetention(panel, async (col, restoredState) => {
            await this._doOpenProject(col, restoredState);
        }, state);
    }

    // NOTE: the former `_hydratePanel()` lived here. It was the adoption path used by
    // `deserializeWebviewPanel`/`deserializeProjectPanel` to wire an already-created
    // restored panel. Both deserialize paths now re-create through `open()` /
    // `_doOpenProject()` (see utils/reviveWithRetention), which is the ONLY way a panel
    // gets `retainContextWhenHidden`. The method had no remaining callers and every
    // step it performed is done by the create paths, so it was removed rather than left
    // as a second, divergent way to bring up a panel.


    public reveal(): void {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
        } else {
            void this.open();
        }
    }

    public hasPanel(): boolean {
        return !!this._panel;
    }

    public isInCurrentWindow(): boolean {
        return !!this._panel && this._panel.viewColumn !== undefined;
    }

    public postMessageToWebview(message: any): void {
        if (this._broadcaster) {
            this._broadcaster.push(message, 'planning');
        } else {
            this._panel?.webview.postMessage(message);
        }
    }

    /**
     * Route a push to a SPECIFIC panel this provider owns (dev docs, notebook,
     * project, save-target, etc.) — delivers to that panel's own webview AND mirrors
     * to WS clients tagged with `surface`. A raw `panel.webview.postMessage` here would
     * drop the push from every remote client (the Gap-A push-site audit). The bound
     * broadcaster's `push()` cannot serve secondary panels — it targets the MAIN panel.
     */
    private _pushTo(panel: vscode.WebviewPanel | undefined, surface: string, message: any): void {
        if (this._broadcaster) {
            this._broadcaster.pushTo(panel?.webview, surface, message);
        } else {
            panel?.webview.postMessage(message).then(undefined, () => { /* panel closed */ });
        }
    }

    public revealProject(): void {
        if (this._projectPanel) {
            // Reveal in the panel's CURRENT location. An explicit ViewColumn.One
            // relocates the panel into the main window, stealing it back out of an
            // auxiliary window. Omitting the column reveals it in place;
            // preserveFocus keeps the user on the board they clicked from.
            this._projectPanel.reveal(undefined, true);
        } else {
            void this.openProject();
        }
    }

    public hasProjectPanel(): boolean {
        return !!this._projectPanel;
    }

    public isProjectInCurrentWindow(): boolean {
        return !!this._projectPanel && this._projectPanel.viewColumn !== undefined;
    }

    public postMessageToProjectWebview(message: any): void {
        // Mirror to WS clients tagged 'project'. NOT push() — the broadcaster is bound
        // to the MAIN panel's webview, so push() would ALSO deliver project messages to
        // the main planning panel (cross-delivery). The project webview is delivered
        // below, preserving its own readiness queue.
        this._broadcaster?.mirrorToWs('project', message);
        if (this._projectPanelReady) {
            this._projectPanel?.webview.postMessage(message).then(undefined, () => {});
        } else {
            this._pendingProjectMessages.push(message);
        }
    }

    /**
     * WS-only project push — for messages whose CLICK happened in the browser cockpit,
     * not in the editor. Deliberately skips the editor's Project panel entirely: no
     * open, no reveal, and no `_pendingProjectMessages` queue. Opening/revealing it
     * would yank focus into VS Code for an action the user took in a browser tab, and
     * queueing the message would replay that action (e.g. a tab jump + plan selection)
     * the next time the editor's Project panel happens to open.
     */
    public pushProjectMessageToWsOnly(message: any): void {
        // Lazy-init like handleServiceVerb: this can be the FIRST thing that touches
        // the provider in a session where no editor panel was ever opened (exactly the
        // browser-only case), and an unbuilt broadcaster would silently drop the push.
        if (!this._broadcaster) {
            this._initPlanningService();
        }
        this._broadcaster?.mirrorToWs('project', message);
    }

    private _flushPendingProjectMessages(): void {
        this._projectPanelReady = true;
        if (this._projectPanelReadyTimer) {
            clearTimeout(this._projectPanelReadyTimer);
            this._projectPanelReadyTimer = undefined;
        }
        for (const m of this._pendingProjectMessages) {
            this.postMessageToProjectWebview(m);
        }
        this._pendingProjectMessages = [];
    }

    private _setupDocsFolderWatcher(workspaceRoot: string | undefined): void {
        if (this._docsFolderWatcher) {
            this._docsFolderWatcher.dispose();
            const idx = this._disposables.indexOf(this._docsFolderWatcher);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
            this._docsFolderWatcher = undefined;
        }
        if (!workspaceRoot) return;

        const docsDir = path.join(workspaceRoot, '.switchboard', 'docs');

        // Refresh imported docs when files are created, deleted, or changed
        const refreshImportedDocs = (filePath: string) => {
            if (!filePath.endsWith('.md')) { return; }
            if (Date.now() - this._lastPanelWriteTimestamp < 2000) {
                return;
            }
            if (workspaceRoot) {
                this._handleFetchImportedDocs(workspaceRoot);
            }
        };

        this._docsFolderWatcher = this._seams().watcher.watchFolder(docsDir, (event, filePath) => {
            refreshImportedDocs(filePath);
        });

        this._disposables.push(this._docsFolderWatcher);
    }

    private _setupLocalFolderWatchers(): void {
        // Dispose and remove all existing watchers
        for (const watcher of this._localFolderWatchers) {
            watcher.dispose();
            const idx = this._disposables.indexOf(watcher);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
        }
        this._localFolderWatchers = [];

        const allRoots = this._getWorkspaceRoots();
        const watchedPaths = new Set<string>();
        const supportedExts = ['.md', '.txt', '.markdown', '.rst', '.adoc'];

        for (const root of allRoots) {
            const localFolderService = this._getLocalFolderService(root);
            const folderPaths = localFolderService.getFolderPaths();

            for (const folderPath of folderPaths) {
                if (!folderPath) continue;
                // Deduplicate: skip if already watching this absolute path
                if (watchedPaths.has(folderPath)) continue;
                watchedPaths.add(folderPath);

                // Create watcher for the local docs folder — recursive, all supported text extensions
                const watcher = this._seams().watcher.watchFolder(folderPath, (event, filePath) => {
                    if (filePath && !supportedExts.some(ext => filePath.toLowerCase().endsWith(ext))) { return; }
                    this._scheduleLocalDocsRefresh();
                });

                this._localFolderWatchers.push(watcher);
                this._disposables.push(watcher);
            }
        }
    }


    /**
     * Debounced local-docs refresh, used by file watchers. The Antigravity brain
     * directory churns continuously (the agent writes plans, logs, knowledge and
     * artifacts constantly), so firing _sendLocalDocsReady() on every raw file event
     * re-rendered the doc list multiple times per second — flickering the panel and
     * resetting any in-progress user action. Coalesce bursts into a single trailing
     * refresh once writes settle.
     */
    private _scheduleLocalDocsRefresh(delayMs: number = 600): void {
        if (this._localDocsDebounce) { clearTimeout(this._localDocsDebounce); }
        this._localDocsDebounce = setTimeout(() => {
            this._localDocsDebounce = undefined;
            void this._sendLocalDocsReady();
        }, delayMs);
    }

    private _setupAntigravityWatcher(): void {
        // Dispose existing
        for (const w of this._antigravityWatchers) {
            w.dispose();
            const idx = this._disposables.indexOf(w);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
        }
        this._antigravityWatchers = [];

        const allRoots = this._getWorkspaceRoots();
        const service = this._getLocalFolderService(allRoots[0] || '');
        const brainPaths = service.detectAntigravityBrainPaths();
        if (brainPaths.length === 0) { return; }

        const refresh = (filePath: string) => {
            if (!filePath.match(/\.(md|markdown|txt)$/i)) { return; }
            this._scheduleLocalDocsRefresh();
        };
        const watchedPaths = new Set<string>();

        for (const brainPath of brainPaths) {
            const resolvedPath = path.resolve(brainPath);
            if (watchedPaths.has(resolvedPath)) { continue; }
            watchedPaths.add(resolvedPath);

            const watcher = this._seams().watcher.watchFolder(resolvedPath, (event, filePath) => refresh(filePath));
            this._antigravityWatchers.push(watcher);
            this._disposables.push(watcher);
        }
    }

    private _setupKanbanPlansWatcher(): void {
        // Dispose existing watchers
        for (const w of this._kanbanPlansWatchers) {
            w.dispose();
            const idx = this._disposables.indexOf(w);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
        }
        this._kanbanPlansWatchers = [];

        const allRoots = this._getWorkspaceRoots();
        const watchedPaths = new Set<string>();

        for (const root of allRoots) {
            if (watchedPaths.has(root)) { continue; }
            watchedPaths.add(root);

            const plansDir = path.join(root, '.switchboard', 'plans');

            const triggerRefresh = (filePath: string) => {
                if (!filePath.endsWith('.md')) { return; }
                if (!this._panel && !this._projectPanel) { return; }
                if (this._kanbanPlansWatchDebounce) {
                    clearTimeout(this._kanbanPlansWatchDebounce);
                }
                this._kanbanPlansWatchDebounce = setTimeout(() => {
                    this._kanbanPlansWatchDebounce = undefined;
                    if (this._panel) {
                        this._handleMessage({
                            type: 'fetchKanbanPlans',
                            requestId: Date.now()
                        }).catch(err => {
                            console.error('[PlanningPanel] Error auto-refreshing kanban plans:', err);
                        });
                    }
                    if (this._projectPanel) {
                        this._handleMessage({
                            type: 'fetchKanbanPlans',
                            requestId: Date.now()
                        }, true).catch(err => {
                            console.error('[PlanningPanel] Error auto-refreshing project kanban plans:', err);
                        });
                    }
                }, 800);
            };

            const watcher = this._seams().watcher.watchFolder(plansDir, (event, filePath) => triggerRefresh(filePath));

            this._kanbanPlansWatchers.push(watcher);
            this._disposables.push(watcher);
        }
    }

    private _setupFeatureDocsWatcher(): void {
        for (const w of this._featureDocsWatchers) {
            w.dispose();
            const idx = this._disposables.indexOf(w);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
        }
        this._featureDocsWatchers = [];

        const allRoots = this._getWorkspaceRoots();
        const watchedPaths = new Set<string>();

        for (const root of allRoots) {
            if (watchedPaths.has(root)) { continue; }
            watchedPaths.add(root);

            const featuresDir = path.join(root, '.switchboard', 'features');
            const triggerRefresh = (filePath: string) => {
                if (!filePath.endsWith('.md')) { return; }
                if (!this._projectPanel) { return; }
                if (this._featureDocsWatchDebounce) {
                    clearTimeout(this._featureDocsWatchDebounce);
                }
                this._featureDocsWatchDebounce = setTimeout(() => {
                    this._featureDocsWatchDebounce = undefined;
                    if (!this._projectPanel) { return; }
                    // Feature files are imported into the kanban DB by GlobalPlanWatcherService;
                    // refresh the DB-backed plans so the Features list (DB-only) reflects the
                    // change. Longer debounce gives the import time to land before we re-read.
                    this._handleMessage({ type: 'fetchKanbanPlans', requestId: Date.now() }, true).catch(err => {
                        console.error('[PlanningPanel] Error auto-refreshing features after file change:', err);
                    });
                }, 1200);
            };

            const watcher = this._seams().watcher.watchFolder(featuresDir, (event, filePath) => triggerRefresh(filePath));

            this._featureDocsWatchers.push(watcher);
            this._disposables.push(watcher);
        }
    }

    private _getConstitutionPath(workspaceRoot: string): string {
        const { getConstitutionPath } = require('./constitutionUtils');
        return getConstitutionPath(this._context, workspaceRoot);
    }

    private _getConstitutionPathList(workspaceRoot: string): string[] {
        const store = this._context.globalState;
        const byRoot = store.get<Record<string, string[]>>('switchboard.constitutionPathsByRoot', {}) || {};
        let list = byRoot[workspaceRoot];
        if (!Array.isArray(list) || list.length === 0) {
            // Seed from the existing active path (shipped key) or the default.
            const active = path.relative(workspaceRoot, this._getConstitutionPath(workspaceRoot)) || 'CONSTITUTION.md';
            list = [active];
        }
        return list;
    }

    private async _setConstitutionPathList(workspaceRoot: string, list: string[]): Promise<void> {
        const store = this._context.globalState;
        const byRoot = store.get<Record<string, string[]>>('switchboard.constitutionPathsByRoot', {}) || {};
        byRoot[workspaceRoot] = Array.from(new Set(list));   // dedupe
        await store.update('switchboard.constitutionPathsByRoot', byRoot);
    }

    private _activeConstitutionRel(workspaceRoot: string): string {
        return path.relative(workspaceRoot, this._getConstitutionPath(workspaceRoot)) || 'CONSTITUTION.md';
    }

    private _getGovernanceFilePath(workspaceRoot: string, key: GovernanceFileKey = 'constitution'): string {
        const { getGovernanceFilePath } = require('./constitutionUtils');
        return getGovernanceFilePath(this._context, workspaceRoot, key);
    }

    /**
     * Tries the PTY fleet first, then falls back to VS Code terminal creation.
     * Host-derived creation policy: when a fleet is available, do not spawn a
     * VS Code terminal on miss (the fleet is authoritative). When no fleet,
     * spawn as before (byte-compat for shipped installs).
     */
    private async _sendPromptToTerminal(
        promptText: string,
        wsRoot: string,
        name: string,
        searchSubstrings: string[],
        options?: { role?: string }
    ): Promise<boolean> {
        if (this._taskViewerProvider) {
            const role = options?.role || searchSubstrings[0] || 'planner';
            const delivered = await this._taskViewerProvider.tryFleetDeliveryForRole(
                role, promptText, wsRoot, { source: 'planningPanel', label: name }
            );
            if (delivered) { return true; }
        }
        let handle: TerminalHandle | null = null;
        for (const sub of searchSubstrings) {
            handle = this._seams().terminal.findByNameContains(sub);
            if (handle) { break; }
        }
        if (!handle) {
            // Host-derived creation policy: if a PTY fleet is available, do not
            // spawn a VS Code terminal. The fleet is the authoritative terminal set.
            if (this._taskViewerProvider && this._taskViewerProvider.hasPtyHost()) { return false; }
            try {
                handle = this._seams().terminal.create(name, undefined, wsRoot);
            } catch {
                return false;
            }
        }
        handle.show();

        const CHUNK_SIZE = 500;
        const CHUNK_DELAY = 50;
        const text = handle.name.toLowerCase().match(/\b(copilot|gemini|agy|claude|windsurf|cursor|cortex)\b/i)
            ? promptText.replace(/[\r\n]+/g, ' ')
            : promptText;

        if (text.length <= CHUNK_SIZE) {
            handle.sendText(text, false);
        } else {
            for (let i = 0; i < text.length; i += CHUNK_SIZE) {
                const chunk = text.substring(i, i + CHUNK_SIZE);
                handle.sendText(chunk, false);
                if (i + CHUNK_SIZE < text.length) {
                    await new Promise(r => setTimeout(r, CHUNK_DELAY));
                }
            }
        }
        await new Promise(r => setTimeout(r, 300));
        handle.sendText('', true);
        return true;
    }

    private buildArchitectPrompt(wsRoot: string): string {
        return `You are the **Switchboard Architect** — a guided tour for project governance setup.

Your job is to help the user write and refine the following governance documents for this project at ${wsRoot}:

1. **PRD** (Product Requirements Document) — located at \`.switchboard/projects/<slug>/prd.md\`
   Format:
   # [Project Name] — PRD
   > **Vision:** [one sentence]
   ## Target Users
   [Who they are and their main pain point]
   ## Key Features
   - **[Name]:** [one sentence]
   ## Success Criteria
   - [measurable outcome]
   ## Non-Goals
   - [explicit exclusion]
   ## Open Questions
   - [unresolved decision or risk]

2. **Constitution** (coding standards) — located at \`CONSTITUTION.md\`
   Follow instructions in \`.switchboard/protocols/constitution-builder/SKILL.md\`.

3. **System Files** — \`CLAUDE.md\` and \`AGENTS.md\`
   These are agent governance files. Help the user write rules that agents should follow when working in this repo.

4. **Tuning Insights** — \`.switchboard/insights/*.md\`
   Follow instructions in \`.switchboard/protocols/tuning/SKILL.md\`.

## Workflow

1. First, check which documents already exist by reading the files.
2. Present a menu to the user: which document would they like to create or refine?
3. For each document, follow the corresponding skill or format above.
4. After completing one document, offer to move to the next.
5. Ensure consistency across all documents (e.g. constitution rules should align with CLAUDE.md).

## Rules
- Do NOT make git commits. Focus on writing/refining file content.
- Always show the user what you're about to write before writing it.
- Ask clarifying questions when requirements are ambiguous.
- Keep documents concise and actionable.

Start by checking which documents exist, then present the menu.`;
    }

    /**
     * Post a message to BOTH the project panel and the planning panel webviews.
     * The Docs-tab "Save as PRD / Save as Constitution" actions run in the
     * planning panel (`this._panel`) but reuse handlers that were originally wired
     * to the project panel (`this._projectPanel`). Replying to only one panel left
     * the planning-panel listeners dead (collision detection, success status, and
     * the Project-Context toggle warning never fired). Posting to both ensures the
     * requesting panel receives the response regardless of which is visible.
     */
    private _postToBothPanels(msg: unknown): void {
        this.postMessageToProjectWebview(msg);
        this._panel?.webview?.postMessage(msg);
    }

    private _setupConstitutionWatcher(): void {
        // Watch each workspace root's governance files so the project panel's
        // Constitution tab live-updates when the file is created/edited/deleted
        // outside the panel.

        // Dispose existing watchers
        for (const w of this._constitutionWatchers) {
            w.dispose();
            const idx = this._disposables.indexOf(w);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
        }
        this._constitutionWatchers = [];

        const allRoots = this._getWorkspaceRoots();
        allRoots.forEach(root => {
            const watchedPaths = new Set<string>(); // dedup by resolved path
            (['constitution', 'claude', 'agents'] as const).forEach(key => {
                const targetPath = this._getGovernanceFilePath(root, key);
                const resolved = path.resolve(targetPath);
                if (watchedPaths.has(resolved)) { return; } // avoid double-registration if custom path === CLAUDE.md/AGENTS.md
                watchedPaths.add(resolved);

                const refresh = (filePath: string) => {
                    if (path.resolve(filePath) !== resolved) { return; }
                    if (!this._projectPanel) { return; }
                    // Notify the webview immediately so the correct file-type preview
                    // refreshes. A shared debounce would drop the message for all but
                    // the last-firing watcher (e.g. a git checkout changing both
                    // CLAUDE.md and AGENTS.md within 400ms). The webview's
                    // governanceFileChanged handler already gates on the currently-
                    // selected file-type and edit-mode, and constitutionFileRead has
                    // a race guard, so immediate dispatch is safe.
                    this.postMessageToProjectWebview({
                        type: 'governanceFileChanged',
                        workspaceRoot: root,
                        governanceFile: key
                    });
                    if (this._constitutionWatchDebounce) { clearTimeout(this._constitutionWatchDebounce); }
                    this._constitutionWatchDebounce = setTimeout(() => {
                        this._constitutionWatchDebounce = undefined;
                        if (!this._projectPanel) { return; }
                        this._handleMessage({ type: 'loadConstitutionFiles', requestId: Date.now() }, true)
                            .catch(err => console.error('[PlanningPanel] Error auto-refreshing constitution files:', err));
                    }, 400);
                };
                const watcher = this._seams().watcher.watchFile(resolved, (event, filePath) => refresh(filePath));
                this._constitutionWatchers.push(watcher); this._disposables.push(watcher);
            });
        });
    }

    private _setupInsightsWatcher(): void {
        for (const w of this._insightsWatchers) {
            w.dispose();
            const idx = this._disposables.indexOf(w);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
        }
        this._insightsWatchers = [];

        const allRoots = this._getWorkspaceRoots();
        const watchedPaths = new Set<string>();

        for (const root of allRoots) {
            if (watchedPaths.has(root)) { continue; }
            watchedPaths.add(root);

            const insightsDir = path.join(root, '.switchboard', 'insights');

            try {
                const triggerRefresh = (filePath: string) => {
                    if (!filePath.endsWith('.md')) { return; }
                    if (!this._projectPanel) { return; }
                    if (this._insightsWatchDebounce) {
                        clearTimeout(this._insightsWatchDebounce);
                    }
                    this._insightsWatchDebounce = setTimeout(() => {
                        this._insightsWatchDebounce = undefined;
                        if (!this._projectPanel) { return; }
                        this._handleMessage({
                            type: 'loadInsights',
                            workspaceRoot: ''
                        }, true).catch(err => {
                            console.error('[PlanningPanel] Error auto-refreshing insights:', err);
                        });
                    }, 400);
                };

                const watcher = this._seams().watcher.watchFolder(insightsDir, (event, filePath) => triggerRefresh(filePath));

                this._insightsWatchers.push(watcher);
                this._disposables.push(watcher);
            } catch (err) {
                console.warn('[PlanningPanel] Failed to create insights watcher for', root, err);
            }
        }
    }

    private async _resolveTuningPlanFiles(workspaceRoot: string, allRoots: string[]): Promise<string[]> {
        const REVIEW_COLUMNS = new Set(['PLAN REVIEWED', 'CODE REVIEWED', 'CODED', 'COMPLETED']);
        const planFiles: string[] = [];
        const seenFiles = new Set<string>();

        const rootsToScan = workspaceRoot ? [workspaceRoot] : buildWorkspaceItems(allRoots).map(ws => ws.workspaceRoot);

        for (const root of rootsToScan) {
            try {
                const db = KanbanDatabase.forWorkspace(root);
                const workspaceId = await this._getWorkspaceId(root);
                const records = await db.getBoard(workspaceId);
                const completedLimit = 100;
                const completedRecords = await db.getCompletedPlans(workspaceId, completedLimit);
                const allRecords = [...records, ...completedRecords];

                for (const record of allRecords) {
                    if (record.kanbanColumn && REVIEW_COLUMNS.has(record.kanbanColumn)) {
                        if (record.planFile) {
                            const filePath = path.isAbsolute(record.planFile)
                                ? record.planFile
                                : path.resolve(root, record.planFile);
                            if (fs.existsSync(filePath) && !seenFiles.has(filePath)) {
                                seenFiles.add(filePath);
                                planFiles.push(filePath);
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn('[PlanningPanel] Failed to query Kanban DB for tuning plans:', root, err);
            }

            try {
                const { ArchiveManager } = require('./ArchiveManager');
                const archive = new ArchiveManager(root);
                if (archive.isConfigured) {
                    const archivedPlans = await archive.queryArchive(
                        `SELECT plan_file FROM plans WHERE kanban_column IN ('PLAN REVIEWED', 'CODE REVIEWED', 'CODED', 'COMPLETED') OR status = 'completed'`,
                        500
                    );
                    for (const row of archivedPlans as any[]) {
                        if (row.plan_file) {
                            const filePath = path.isAbsolute(row.plan_file)
                                ? row.plan_file
                                : path.resolve(root, row.plan_file);
                            if (fs.existsSync(filePath) && !seenFiles.has(filePath)) {
                                seenFiles.add(filePath);
                                planFiles.push(filePath);
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn('[PlanningPanel] Failed to query archive DB for tuning plans:', root, err);
            }
        }

        return planFiles;
    }

    private _setupActiveDocWatcher(filePath: string | null): void {
        // Dispose existing watcher synchronously
        if (this._activeDocWatchDebounce) {
            clearTimeout(this._activeDocWatchDebounce);
            this._activeDocWatchDebounce = undefined;
        }
        if (this._activeDocWatcher) {
            try {
                this._activeDocWatcher.dispose();
            } catch (err) {
                console.warn('[PlanningPanel] Error disposing active doc watcher:', err);
            }
            this._activeDocWatcher = undefined;
        }

        this._watcherGeneration++;
        const gen = this._watcherGeneration;

        if (!filePath || !fs.existsSync(filePath)) {
            return;
        }

        try {
            // Watch for changes to the specific file
            this._activeDocWatcher = this._seams().watcher.watchFile(filePath, (event, changedPath) => {
                if (gen !== this._watcherGeneration) { return; } // stale watcher
                if (filePath !== this._activePreviewPath) { return; } // stale path

                if (this._activeDocWatchDebounce) {
                    clearTimeout(this._activeDocWatchDebounce);
                }

                if (event === 'delete') {
                    this.postMessageToWebview({
                        type: 'previewError',
                        sourceId: this._activePreviewSourceId || 'local-folder',
                        requestId: -1,
                        error: 'File deleted externally'
                    });
                    this._activeDocWatcher?.dispose();
                    this._activeDocWatcher = undefined;
                    return;
                }

                if (Date.now() - this._lastPanelWriteTimestamp < 1000) { return; } // panel-initiated write

                this._activeDocWatchDebounce = setTimeout(async () => {
                    if (gen !== this._watcherGeneration || filePath !== this._activePreviewPath) { return; }
                    if (Date.now() - this._lastPanelWriteTimestamp < 1000) { return; }

                    const workspaceRoot = this._activePreviewWorkspaceRoot
                        || this._getWorkspaceRoot()
                        || (this._getWorkspaceRoots().length > 0 ? this._getWorkspaceRoots()[0] : undefined);
                    if (!workspaceRoot) return;

                    console.log('[PlanningPanel] Auto-refreshing active document:', filePath);
                    this._isAutoRefreshing = true;
                    try {
                        if (this._activePreviewSourceId === 'local-folder' || this._activePreviewSourceId === 'html-folder' || this._activePreviewSourceId === 'planning-html-folder') {
                            // Re-fetch local doc or HTML doc
                            await this._handleFetchPreview(workspaceRoot, this._activePreviewSourceId, this._activePreviewDocId!, -1, this._activePreviewSourceFolder!);
                        } else if (this._activePreviewSourceId === 'kanban-plan') {
                            await this._handleFetchKanbanPlanPreview(this._activePreviewDocId!, -1);
                        } else {
                            // Re-fetch imported doc via fetchDocsFile
                            await this._handleFetchDocsFile(workspaceRoot, this._activePreviewDocId!, -1);
                        }
                    } finally {
                        this._isAutoRefreshing = false;
                    }
                }, 300);
            });

            this._disposables.push(this._activeDocWatcher);
        } catch (err) {
            console.error('[PlanningPanel] Failed to create active doc watcher:', err);
        }
    }


    private async _handleFetchKanbanPlanPreview(filePath: string, requestId: number): Promise<any> {
        const allRoots = Array.from(this._getAllowedRoots());
        // Resolve relative paths against workspace roots, not just CWD
        let resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : '';
        if (!resolved || !fs.existsSync(resolved)) {
            for (const root of allRoots) {
                const candidate = path.resolve(root, filePath);
                if (fs.existsSync(candidate)) {
                    resolved = candidate;
                    break;
                }
            }
            if (!resolved) {
                resolved = path.resolve(filePath); // fall back to CWD resolution (will fail isAllowed below)
            }
        }
        // SECURITY: isAllowed must run on the final resolved path, unconditionally
        const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
        const sendResponse = (message: any) => {
            if (this._projectPanel) {
                this.postMessageToProjectWebview(message);
            } else {
                this.postMessageToWebview(message);
            }
        };

        if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
            sendResponse({
                type: 'kanbanPlanPreviewReady', requestId, filePath,
                content: '', error: 'File not found or not in workspace'
            });
            return;
        }
        try {
            const content = await fs.promises.readFile(resolved, 'utf8');

            // Set active preview state (mirrors _handleFetchPreview pattern)
            this._activePreviewPath = resolved;
            this._activePreviewSourceId = 'kanban-plan';
            this._activePreviewDocId = filePath;
            this._setupActiveDocWatcher(resolved);

            // Auto-refresh dedupe (mirrors _handleFetchPreview): skip the post when the
            // content is unchanged so the webview doesn't re-render and visibly reflow.
            const cacheKey = `kanban-plan:${resolved}`;
            if (requestId === -1 && this._lastPreviewContentByPath.get(cacheKey) === content) {
                return;
            }
            this._lastPreviewContentByPath.set(cacheKey, content);

            // Convert raw markdown to HTML for preview pane
            const renderedHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', content);

            const payload = {
                type: 'kanbanPlanPreviewReady',
                requestId,
                filePath,
                content: renderedHtml,
                rawContent: content,
                isAutoRefreshed: this._isAutoRefreshing
            };
            sendResponse(payload);
            return { success: true, ...payload };
        } catch (err) {
            const errPayload = {
                type: 'kanbanPlanPreviewReady', requestId, filePath, content: '', error: String(err)
            };
            sendResponse(errPayload);
            return { success: false, ...errPayload };
        }
    }

    private _getHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        this._nonce = nonce;
        const cspSource = webview.cspSource;

        // Fallback chain for HTML file location
        const possiblePaths = [
            path.join(this._extensionUri.fsPath, 'dist', 'webview', 'planning.html'),
            path.join(this._extensionUri.fsPath, 'webview', 'planning.html'),
            path.join(this._extensionUri.fsPath, 'src', 'webview', 'planning.html')
        ];

        let htmlContent = '';
        for (const htmlPath of possiblePaths) {
            try {
                if (fs.existsSync(htmlPath)) {
                    htmlContent = fs.readFileSync(htmlPath, 'utf8');
                    break;
                }
            } catch {
                // Continue to next path
            }
        }

        if (!htmlContent) {
            htmlContent = '<html><body><h1>Planning panel HTML not found</h1></body></html>';
        }

        // Substitute placeholders
        htmlContent = htmlContent.replace(/\{\{NONCE\}\}/g, nonce);
        htmlContent = htmlContent.replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, cspSource);

        const planningJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'planning.js')
        );
        htmlContent = htmlContent.replace(/\{\{PLANNING_JS_URI\}\}/g, planningJsUri.toString());

        const sharedUtilsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedUtils.js')
        );
        htmlContent = htmlContent.replace(/\{\{SHARED_UTILS_URI\}\}/g, sharedUtilsUri.toString());

        const markdownEditorUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'markdownEditor.js')
        );
        htmlContent = htmlContent.replace(/\{\{MARKDOWN_EDITOR_URI\}\}/g, markdownEditorUri.toString());

        const geistPixelFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'GeistPixel-Square.woff2')
        );
        htmlContent = htmlContent.replace(/\{\{GEIST_PIXEL_FONT_URI\}\}/g, geistPixelFontUri.toString());

        const hankenFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'HankenGrotesk-Variable.woff2')
        );
        htmlContent = htmlContent.replace(/\{\{HANKEN_FONT_URI\}\}/g, hankenFontUri.toString());

        htmlContent = applyThemeBodyClass(htmlContent);
        return htmlContent;
    }

    private _injectLocalCsp(html: string): string {
        // Inject the parent webview's nonce into all <script> tags so they satisfy
        // the inherited CSP's nonce requirement. We do NOT inject a separate CSP
        // <meta> tag because srcdoc iframes inherit the parent document's CSP, and
        // adding a second CSP creates a dual-policy enforcement scenario that can
        // produce unexpected blocking. The inherited parent CSP already covers all
        // necessary resource types (scripts, styles, images, etc.) — the only
        // additional requirement is the nonce on script tags.
        let processedHtml = html;

        // Remove any existing CSP <meta> tags in the preview HTML to prevent
        // conflicts with the inherited parent CSP. The preview's own CSP could
        // add restrictions (like blocking 'unsafe-eval' or external sources)
        // that prevent the preview from functioning correctly.
        processedHtml = processedHtml.replace(/<meta\b[^>]*\bhttp-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');

        if (this._nonce) {
            // Inject nonce into <script> tags that don't already have one,
            // avoiding double-nonce on tags that already carry a nonce attribute.
            processedHtml = processedHtml.replace(/<script(?![^>]*\bnonce=)(\s[^>]*)?>/gi, `<script nonce="${this._nonce}"$1>`);
        }
        return processedHtml;
    }

    // Mirrors DesignPanelProvider._injectIntoHead — inserts a snippet at the start
    // of <head> (or <html>, or document top) so the inspector script runs before
    // the page's own DOM is built. Used by the Planning HTML preview's srcdoc and
    // server paths to install Inspect Mode.
    private _injectIntoHead(html: string, snippet: string): string {
        if (/<head\b[^>]*>/i.test(html)) {
            return html.replace(/<head\b[^>]*>/i, m => m + snippet);
        } else if (/<html\b[^>]*>/i.test(html)) {
            return html.replace(/<html\b[^>]*>/i, m => m + snippet);
        } else {
            return snippet + html;
        }
    }

    // ── Planning HTML preview server infrastructure ──
    // Serves planning-HTML-tab files over localhost so iframes have a real origin.
    // Mirrors DesignPanelProvider's HTML server infra, scoped to _planningHtmlServers.

    private _getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeMap: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.htm': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.mjs': 'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml; charset=utf-8',
            '.ico': 'image/x-icon',
            '.webp': 'image/webp',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.eot': 'application/vnd.ms-fontobject',
            '.webmanifest': 'application/manifest+json',
            '.xml': 'application/xml',
            '.txt': 'text/plain; charset=utf-8',
            '.pdf': 'application/pdf',
        };
        return mimeMap[ext] || 'application/octet-stream';
    }

    private async _getOrCreatePlanningHtmlServer(sourceFolder: string): Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }> {
        const existing = this._planningHtmlServers.get(sourceFolder);
        if (existing) {
            clearTimeout(existing.timeoutId);
            existing.timeoutId = this._createPlanningHtmlServerTimeout(sourceFolder);
            return existing;
        }
        const pendingPromise = this._planningHtmlServerCreationPromises.get(sourceFolder);
        if (pendingPromise) {
            return pendingPromise;
        }
        const creationPromise = this._createPlanningHtmlServer(sourceFolder);
        this._planningHtmlServerCreationPromises.set(sourceFolder, creationPromise);
        try {
            return await creationPromise;
        } finally {
            this._planningHtmlServerCreationPromises.delete(sourceFolder);
        }
    }

    private _createPlanningHtmlServer(sourceFolder: string): Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }> {
        const server = http.createServer((req, res) => {
            this._handlePlanningHtmlServerRequest(req, res, sourceFolder);
        });
        return new Promise((resolve, reject) => {
            server.listen(0, '127.0.0.1', () => {
                const address = server.address() as { port: number };
                const timeoutId = this._createPlanningHtmlServerTimeout(sourceFolder);
                const entry = { server, port: address.port, timeoutId };
                this._planningHtmlServers.set(sourceFolder, entry);
                resolve(entry);
            });
            server.on('error', (err: any) => reject(err));
        });
    }

    private _buildLocalhostUrl(serverEntry: { port: number }, sourceFolder: string, filePath: string): string {
        const relativeUrlPath = path.relative(sourceFolder, filePath);
        const urlPath = relativeUrlPath.split(path.sep).map(encodeURIComponent).join('/');
        return `http://127.0.0.1:${serverEntry.port}/${urlPath}`;
    }

    private _handlePlanningHtmlServerRequest(req: http.IncomingMessage, res: http.ServerResponse, sourceFolder: string): void {
        const parsedUrl = new URL(req.url || '/', `http://127.0.0.1`);
        const requestedPath = decodeURIComponent(parsedUrl.pathname);

        if (requestedPath === '/' || requestedPath === '') {
            res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('Forbidden: directory listing not available');
            return;
        }

        const resolvedPath = path.resolve(sourceFolder, requestedPath.substring(1));
        const normalizedSource = path.normalize(sourceFolder).replace(/[\\/]+$/, '');
        const normalizedResolved = path.normalize(resolvedPath);

        if (!normalizedResolved.startsWith(normalizedSource + path.sep) && normalizedResolved !== normalizedSource) {
            res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('Forbidden: path traversal denied');
            return;
        }

        // Deny-list only the components BELOW the served folder. The traversal check
        // above already contains the request inside sourceFolder; checking the
        // absolute path instead (the previous behaviour) 403'd any folder whose
        // absolute path happens to contain a denied component (e.g. a workspace
        // rooted under a dot-folder). Mirrors DesignPanelProvider's fixed version.
        const pathParts = path.relative(normalizedSource, normalizedResolved).split(path.sep);
        for (const part of pathParts) {
            if (this._SERVER_DENY_LIST.some(denied => part === denied || part.startsWith(denied))) {
                res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
                res.end('Forbidden: access denied');
                return;
            }
        }

        const fs_node = require('fs');
        fs_node.readFile(resolvedPath, (err: any, data: Buffer) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
                res.end('Not Found');
                return;
            }
            const mimeType = this._getMimeType(resolvedPath);
            // For HTML files, inject the Inspect Mode inspector script so the
            // Planning HTML tab gains hover-to-select element inspection parity
            // with the Design panel's HTML/Stitch HTML tabs. Non-HTML assets
            // (CSS/JS/images/fonts) pass through byte-identical.
            if (mimeType.startsWith('text/html')) {
                const html = this._injectIntoHead(data.toString('utf8'), DesignPanelProvider._INSPECTOR_SCRIPT);
                res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
                res.end(Buffer.from(html, 'utf8'));
            } else {
                res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
                res.end(data);
            }
        });

        const entry = this._planningHtmlServers.get(sourceFolder);
        if (entry) {
            clearTimeout(entry.timeoutId);
            entry.timeoutId = this._createPlanningHtmlServerTimeout(sourceFolder);
        }
    }

    private _createPlanningHtmlServerTimeout(sourceFolder: string): NodeJS.Timeout {
        return setTimeout(() => {
            const entry = this._planningHtmlServers.get(sourceFolder);
            if (entry) {
                entry.server.close();
                this._planningHtmlServers.delete(sourceFolder);
            }
        }, 10 * 60 * 1000);
    }

    private async _buildAndSendPlanningHtmlPreview(opts: {
        sourceId: string;
        sourceFolder?: string;
        docId: string;
        requestId: number;
        isAutoRefreshed?: boolean;
    }): Promise<any> {
        const { sourceId, sourceFolder, docId, requestId, isAutoRefreshed } = opts;
        try {
            if (!sourceFolder) throw new Error('sourceFolder is required');
            const relativePath = docId.includes(':')
                ? docId.substring(docId.indexOf(':') + 1)
                : docId;

            const allowedFolders = new Set<string>();
            for (const root of this._getWorkspaceRoots()) {
                try {
                    const svc = this._getLocalFolderService(root);
                    svc.getPlanningHtmlFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                } catch {}
            }
            const resolvedFolder = path.resolve(sourceFolder);
            if (!allowedFolders.has(resolvedFolder)) {
                throw new Error('sourceFolder is not a configured planning HTML folder');
            }
            const absPath = path.resolve(resolvedFolder, relativePath);
            if (absPath !== resolvedFolder && !absPath.startsWith(resolvedFolder + path.sep)) {
                throw new Error('Invalid file path');
            }

            const fileExt = path.extname(relativePath).toLowerCase();
            const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(fileExt);
            const isHtmlFile = fileExt === '.html' || fileExt === '.htm';

            // The webviewUri rewrite needs a live webview (vscode.Uri + asWebviewUri).
            // Headless callers have none — skip it and return the filePath ref instead.
            const panelWebview = this._panel?.webview;
            let fileContent = '';
            let webviewUri: string | undefined;
            if (isImage) {
                if (panelWebview) {
                    webviewUri = panelWebview.asWebviewUri(vscode.Uri.file(absPath)).toString();
                }
            } else {
                fileContent = await fs.promises.readFile(absPath, 'utf8');
                if (isHtmlFile && panelWebview) {
                    webviewUri = panelWebview.asWebviewUri(vscode.Uri.file(absPath)).toString();
                }
            }

            let iframeSrc: string | undefined;
            if (isHtmlFile) {
                try {
                    const serverEntry = await this._getOrCreatePlanningHtmlServer(resolvedFolder);
                    iframeSrc = this._buildLocalhostUrl(serverEntry, resolvedFolder, absPath);
                } catch {
                    iframeSrc = undefined;
                }
            }

            const fileTypeMap: Record<string, string> = {
                '.json': 'json',
                '.yaml': 'yaml', '.yml': 'yaml',
                '.md': 'markdown', '.markdown': 'markdown', '.txt': 'markdown'
            };
            const fileType = isImage ? 'image' : (fileTypeMap[fileExt] || 'text');

            const res = {
                type: 'previewReady',
                sourceId,
                requestId,
                content: isImage ? '' : fileContent,
                docName: path.basename(relativePath),
                filePath: absPath,
                fileType,
                isImage,
                webviewUri,
                iframeSrc,
                htmlContent: isHtmlFile ? this._injectLocalCsp(this._injectIntoHead(fileContent, DesignPanelProvider._INSPECTOR_SCRIPT)) : undefined,
                isAutoRefreshed: isAutoRefreshed || undefined
            };
            this.postMessageToWebview(res);
            return { success: true, ...res };
        } catch (err: any) {
            if (requestId === -1) return { success: false, error: err.message || String(err) };
            const res = {
                type: 'previewError',
                sourceId,
                requestId,
                error: err.message || String(err)
            };
            this.postMessageToWebview(res);
            return { success: false, ...res };
        }
    }

    private async _sendPlanningHtmlDocsReady(): Promise<void> {
        if (this._planningHtmlDocsDebounce) {
            clearTimeout(this._planningHtmlDocsDebounce);
        }
        this._planningHtmlDocsDebounce = setTimeout(async () => {
            this._planningHtmlDocsDebounce = undefined;
            try {
                const allRoots = this._getWorkspaceRoots();
                const allFiles: any[] = [];
                const seenFilePaths = new Set<string>();
                const configuredFolderPathsByRoot: Record<string, string[]> = {};

                for (const root of allRoots) {
                    try {
                        const localFolderService = this._getLocalFolderService(root);
                        const folderPaths = localFolderService.getPlanningHtmlFolderPaths();
                        configuredFolderPathsByRoot[root] = folderPaths;

                        const files = await localFolderService.listPlanningHtmlFiles();
                        for (const f of files) {
                            const absPath = path.resolve(f.sourceFolder, f.relativePath);
                            if (!seenFilePaths.has(absPath)) {
                                seenFilePaths.add(absPath);
                                allFiles.push({ ...f, _root: root });
                            }
                        }
                    } catch {}
                }

                // No `if (!this._panel) return` gate here. `postMessageToWebview` fans out
                // to the WS hub as well as the editor webview, and the browser cockpit has
                // no editor panel — gating on one meant the HTML tab's file tree was never
                // sent to the browser at all, leaving it stuck on "Configure a folder to
                // browse HTML files" with nothing to click (so no preview could ever open).
                // postMessage is a safe no-op when neither target exists.
                this.postMessageToWebview({
                    type: 'planningHtmlDocsReady',
                    sourceId: 'planning-html-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this.postMessageToWebview({
                    type: 'planningHtmlDocsReady',
                    sourceId: 'planning-html-folder',
                    folderPathsByRoot: {},
                    nodes: [],
                    workspaceItems: this._buildKanbanWorkspaceItems(),
                    error: String(err)
                });
            }
        }, 300);
    }

    private _setupPlanningHtmlFolderWatchers(): void {
        for (const w of this._planningHtmlFolderWatchers) { w.dispose(); }
        this._planningHtmlFolderWatchers = [];

        const allRoots = this._getWorkspaceRoots();
        for (const root of allRoots) {
            try {
                const service = this._getLocalFolderService(root);
                const paths = service.getPlanningHtmlFolderPaths();
                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        const watcher = this._seams().watcher.watchFolder(p, () => this._sendPlanningHtmlDocsReady());
                        this._planningHtmlFolderWatchers.push(watcher);
                    }
                }
            } catch {}
        }
    }

    private _registerSaveTextDocListener(): void {
        if (this._saveTextDocListener) {
            this._saveTextDocListener.dispose();
            this._saveTextDocListener = undefined;
        }
        if (!this._activePlanningHtmlPreview) { return; }
        const active = this._activePlanningHtmlPreview;
        const relativePath = active.docId.includes(':')
            ? active.docId.substring(active.docId.indexOf(':') + 1)
            : active.docId;
        const activePath = path.resolve(active.sourceFolder, relativePath);
        this._saveTextDocListener = this._seams().watcher.watchFile(activePath, (event) => {
            if (event !== 'change') { return; }
            if (!this._activePlanningHtmlPreview) { return; }
            this._buildAndSendPlanningHtmlPreview({
                sourceId: active.sourceId,
                sourceFolder: active.sourceFolder,
                docId: active.docId,
                requestId: -1,
                isAutoRefreshed: true
            });
        });
        this._disposables.push(this._saveTextDocListener);
    }

    private _getWorkspaceRoots(): string[] {
        return this._seams().workspace.getWorkspaceRoots();
    }

    private async _getIntegrationWorkspaces(): Promise<Array<{ workspaceRoot: string; provider: 'clickup' | 'linear' }>> {
        const allRoots = this._getWorkspaceRoots();
        const allowedRoots = new Set(buildWorkspaceItems(allRoots).map(item => item.workspaceRoot));
        if (allRoots.length === 0 || allowedRoots.size === 0) return [];
        try {
            // Config is global — check once using any allowed root, not per-root.
            const probeRoot = allRoots.find(r => allowedRoots.has(r)) || allRoots[0];
            const [clickUpConfig, linearConfig] = await Promise.all([
                this._adapterFactories.getClickUpSyncService(probeRoot).loadConfig(),
                this._adapterFactories.getLinearSyncService(probeRoot).loadConfig()
            ]);
            const provider = (clickUpConfig?.setupComplete) ? 'clickup'
                : (linearConfig?.setupComplete) ? 'linear'
                : null;
            if (!provider) return [];
            // Tag every allowed root with the global provider so the dropdown can
            // still show workspace names for file-save context.
            return Array.from(allowedRoots).map(root => ({ workspaceRoot: root, provider }));
        } catch {
            return [];
        }
    }


    private _getAllowedRoots(): Set<string> {
        const roots = this._getWorkspaceRoots();
        const allowedRoots = new Set<string>(roots);
        try {
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();
            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                for (const m of cfg.mappings) {
                    const parent = m.parentFolder || (m as any).parentWorkspaceFolder;
                    if (typeof parent === 'string') {
                        const p = parent.trim();
                        const expanded = p.startsWith('~')
                            ? path.join(require('os').homedir(), p.slice(1))
                            : p;
                        allowedRoots.add(path.resolve(expanded));
                    }
                    for (const wf of m.workspaceFolders ?? []) {
                        const expanded = wf.startsWith('~')
                            ? path.join(require('os').homedir(), wf.slice(1))
                            : wf;
                        allowedRoots.add(path.resolve(expanded));
                    }
                }
            }
        } catch { /* fall through */ }
        return allowedRoots;
    }

    private _resolveWorkspaceRoot(explicitRoot?: string): string | undefined {
        const allowedRoots = this._getAllowedRoots();
        if (explicitRoot) {
            const resolved = path.resolve(explicitRoot);
            if (allowedRoots.has(resolved)) return resolved;
        }
        const defaultRoot = this._getWorkspaceRoot() || this._getWorkspaceRoots()[0];
        if (defaultRoot && allowedRoots.has(path.resolve(defaultRoot))) return defaultRoot;
        // Fallback to first allowed root
        const firstAllowed = Array.from(allowedRoots)[0];
        return firstAllowed;
    }

    private _slugify(text: string): string {
        return text.toString().toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\w\-]+/g, '')
            .replace(/\-\-+/g, '-')
            .replace(/^-+/, '')
            .replace(/-+$/, '');
    }

    // Same locations importTaskAsDocument writes to (TaskViewerProvider).
    private _getTicketDocumentDirs(resolvedRoot: string, provider?: 'clickup' | 'linear'): string[] {
        const dirs: string[] = [];
        const providerDir = provider === 'clickup' ? 'clickup' : 'linear';

        // 1. Configured global directory
        let globalBaseDir = '';
        if (provider) {
            try {
                const config = GlobalIntegrationConfigService.loadConfigSync(provider);
                if (config && config.ticketSaveLocation) {
                    globalBaseDir = config.ticketSaveLocation;
                }
            } catch {}
        }

        if (globalBaseDir) {
            try {
                if (provider === 'clickup') {
                    const clickUp = this._adapterFactories.getClickUpSyncService(resolvedRoot);
                    const h = clickUp.getSelectedHierarchy();
                    const parts = [globalBaseDir, 'clickup', this._slugify(h.spaceName).slice(0, 60)];
                    if (h.folderName) {
                        parts.push(this._slugify(h.folderName).slice(0, 60));
                    }
                    parts.push(this._slugify(h.listName).slice(0, 60));
                    dirs.push(path.join(...parts));
                } else if (provider === 'linear') {
                    const linear = this._adapterFactories.getLinearSyncService(resolvedRoot);
                    const teamName = linear.getTeamName();
                    const projectName = linear.getSelectedProjectName() || '_no-project';
                    dirs.push(path.join(
                        globalBaseDir,
                        'linear',
                        this._slugify(teamName).slice(0, 60),
                        this._slugify(projectName).slice(0, 60)
                    ));
                }
            } catch {
                dirs.push(path.join(globalBaseDir, providerDir));
            }
        }

        // 2. Fallback read-only search directory inside the workspace (.switchboard/tickets)
        let fallbackBaseDir = path.join(resolvedRoot, '.switchboard', 'tickets');
        try {
            if (provider === 'clickup') {
                const clickUp = this._adapterFactories.getClickUpSyncService(resolvedRoot);
                const h = clickUp.getSelectedHierarchy();
                const parts = [fallbackBaseDir, 'clickup', this._slugify(h.spaceName).slice(0, 60)];
                if (h.folderName) {
                    parts.push(this._slugify(h.folderName).slice(0, 60));
                }
                parts.push(this._slugify(h.listName).slice(0, 60));
                dirs.push(path.join(...parts));
            } else if (provider === 'linear') {
                const linear = this._adapterFactories.getLinearSyncService(resolvedRoot);
                const teamName = linear.getTeamName();
                const projectName = linear.getSelectedProjectName() || '_no-project';
                dirs.push(path.join(
                    fallbackBaseDir,
                    'linear',
                    this._slugify(teamName).slice(0, 60),
                    this._slugify(projectName).slice(0, 60)
                ));
            }
        } catch {
            dirs.push(path.join(fallbackBaseDir, providerDir));
        }

        return dirs;
    }

    // Resolve a ticket's real on-disk file path by scanning for its
    // `${provider}_${id}_` prefix. Mirrors TaskViewerProvider._findTicketDocument:
    // tickets import into nested folder hierarchies that can't be reconstructed
    // from live space/folder/list names, so we scan rather than build a flat path.
    private async _findTicketFilePath(resolvedRoot: string, provider: string, id: string): Promise<string | null> {
        // DB-FIRST. The Tickets sidebar renders every row from the import registry's
        // recorded absolute file_path (getImportedTickets → dbT.filePath), so the
        // link/save/refine/ask-agent paths MUST resolve through the SAME source or a
        // ticket that's plainly visible in the sidebar reports "no local file". That
        // happened because the fallback scan (below) rebuilds the directory from
        // _resolveWorkspaceRoot(), which for the Tickets tab falls back to the Kanban
        // board's currently-selected workspace (extension.ts wires _getWorkspaceRoot
        // to kanbanProvider.getCurrentWorkspaceRoot()). With no ticketSaveLocation
        // configured, the scan only ever looks under that one root — so switching the
        // Kanban board to a different workspace silently pointed the lookup at the
        // wrong folder even though nothing about the files changed. The DB path is
        // absolute and workspace-independent: trust it whenever the file still exists.
        try {
            if (!this._cacheService) {
                this._cacheService = this._adapterFactories.getCacheService(resolvedRoot);
            }
            const entry = await this._cacheService.getImportBySlugPrefix(`${provider}_${id}`);
            if (entry && entry.filePath && fs.existsSync(entry.filePath)) {
                return entry.filePath;
            }
        } catch { /* fall through to filesystem scan */ }

        // Fallback: scan for the `${provider}_${id}_` prefix. Covers legacy/unregistered
        // files and DB rows whose recorded path went stale. Scan the configured global
        // location, then EVERY allowed workspace root's .switchboard/tickets — not just
        // the resolved root — so the scan no longer depends on which workspace the
        // Kanban board happens to point at.
        const prefix = `${provider}_${id}_`;
        const baseDirs: string[] = [];
        try {
            const config = GlobalIntegrationConfigService.loadConfigSync(provider as any);
            if (config && config.ticketSaveLocation) {
                baseDirs.push(path.join(config.ticketSaveLocation, provider));
            }
        } catch { /* ignore */ }
        const roots = new Set<string>([resolvedRoot, ...this._getAllowedRoots()]);
        for (const root of roots) {
            baseDirs.push(path.join(root, '.switchboard', 'tickets', provider));
        }
        for (const dir of baseDirs) {
            const found = this._scanForTicketFile(dir, prefix);
            if (found) { return found; }
        }
        return null;
    }

    private _scanForTicketFile(dir: string, prefix: string): string | null {
        let entries: import('fs').Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const found = this._scanForTicketFile(full, prefix);
                if (found) { return found; }
            } else if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.md')) {
                return full;
            }
        }
        return null;
    }

    /**
     * Absolute folder paths the local-asset HTTP route may serve on this panel's behalf —
     * the ticket folders whose markdown carries embedded screenshots, plus each root's
     * `.switchboard/` (the default tickets/attachments location). Same contract as
     * `DesignPanelProvider.getDesignAssetRoots`: the provider owns the allow-list so the
     * route can never drift from what the panel actually previews.
     */
    public getPlanningAssetRoots(workspaceRoot: string): string[] {
        const roots: string[] = [];
        try {
            const service = this._getLocalFolderService(workspaceRoot);
            roots.push(...service.getTicketsFolderPaths());
            roots.push(...service.getFolderPaths());
        } catch { /* config unreadable — fall through to the default tickets dir */ }
        if (workspaceRoot) {
            // `getTicketsFolderPaths()` returns only EXPLICITLY configured folders, so the
            // default ticket location has to be listed here or its screenshots 403.
            // Scoped to `.switchboard/tickets`, not all of `.switchboard/`.
            roots.push(path.join(workspaceRoot, '.switchboard', 'tickets'));
        }
        return roots.filter(Boolean);
    }

    /**
     * Loopback URL for a local image, or undefined when the file is outside the
     * allow-list / no API server is listening.
     *
     * Why an absolute `http://127.0.0.1:<port>` URL and not `asWebviewUri`: the rewritten
     * markdown is ONE string delivered to BOTH clients (the editor webview and every
     * browser-cockpit tab, via `postMessageToWebview`'s two-target fan-out). A
     * `vscode-webview:` URI is unresolvable in a browser, and a root-relative
     * `/design/asset?…` path is unresolvable in a webview — so neither form can serve
     * both. The loopback URL resolves in both hosts (webviews can load localhost; the
     * panel CSPs allow `http://127.0.0.1:*` for img-src).
     */
    private _buildLocalAssetUrl(absPath: string): string | undefined {
        const port: number | undefined = this._apiServer?.getPort?.();
        if (!port) { return undefined; }
        const realOf = (p: string): string | null => {
            try { return fs.realpathSync(p); } catch { return null; }
        };
        const realTarget = realOf(absPath);
        if (!realTarget) { return undefined; }
        const allowed = this._getWorkspaceRoots()
            .flatMap(root => this.getPlanningAssetRoots(root))
            .map(folder => realOf(path.resolve(folder)))
            .filter((f): f is string => !!f);
        const isAllowed = allowed.some(folder =>
            realTarget === folder || realTarget.startsWith(folder + path.sep)
        );
        if (!isAllowed) { return undefined; }
        const root = this._getWorkspaceRoot() || '';
        return `http://127.0.0.1:${port}/design/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(realTarget)}`;
    }

    private _rewriteLocalImagePaths(markdown: string, baseDir: string): string {
        return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
            const trimmed = url.trim();
            // Leave remote, data, and already-webview URIs alone
            if (/^(https?:|data:|vscode-resource:|vscode-webview-resource:|vscode-webview:)/i.test(trimmed)) {
                return match;
            }
            try {
                let absPath: string;
                if (/^file:\/\/\//i.test(trimmed)) {
                    absPath = fileURLToPath(trimmed);
                } else {
                    absPath = path.resolve(baseDir, trimmed);
                }
                if (!fs.existsSync(absPath)) { return match; } // don't rewrite missing files
                // Host-neutral form first — works in the editor webview AND the browser.
                const assetUrl = this._buildLocalAssetUrl(absPath);
                if (assetUrl) { return `![${alt}](${assetUrl})`; }
                // No API server listening: keep the editor working via the webview URI.
                // (Headless with no server has no way to serve the file at all.)
                if (!this._panel) { return match; }
                const webviewUri = this._panel.webview.asWebviewUri(vscode.Uri.file(absPath));
                if (!webviewUri) { return match; }
                return `![${alt}](${webviewUri.toString()})`;
            } catch {
                return match;
            }
        });
    }

    private _mapClickUpTaskToSidebar(task: any): any {
        return {
            id: task.id,
            title: task.name,
            identifier: task.id,
            status: task.status?.status || 'Unknown',
            statusColor: task.status?.color || '',
            assignees: task.assignees || [],
            description: task.description?.trim() || 'No description provided.',
            markdownDescription: task.markdownDescription || '',
            list: task.list,
            url: task.url,
            parentId: task.parentId || task.parent || null,
            priority: task.priority || null,
            tags: Array.isArray(task.tags) ? task.tags.map((t: any) => ({
                name: String(t?.name || '').trim(),
                tagFg: String(t?.tag_fg || t?.tagFg || '').trim(),
                tagBg: String(t?.tag_bg || t?.tagBg || '').trim()
            })) : []
        };
    }

    private _mapClickUpComment(comment: any): any {
        // ClickUp returns `date` as a unix-ms timestamp string. The webview renders
        // dates from `createdAt` (ISO) via `.slice(0, 10)`, so convert here — otherwise
        // the date column stays blank (or shows raw timestamp digits).
        let createdAt = '';
        const rawDate = comment.date;
        if (rawDate) {
            const ms = Number(rawDate);
            createdAt = Number.isFinite(ms) ? new Date(ms).toISOString() : String(rawDate);
        }
        return {
            id: comment.id,
            body: comment.comment_text,
            // Webview reads user.name first (Linear shape); ClickUp gives username.
            user: { ...comment.user, name: comment.user?.username || comment.user?.email || '' },
            date: comment.date,
            createdAt
        };
    }

    private _mapClickUpAttachment(attachment: any): any {
        return {
            id: attachment.id,
            url: attachment.url,
            title: attachment.title,
            filename: attachment.filename
        };
    }

    /**
     * Resolve the effective workspace root: if this workspace is part of a
     * workspaceDatabaseMapping, return the parent workspace root; otherwise
     * return the resolved path unchanged. Mirrors KanbanProvider.resolveEffectiveWorkspaceRoot().
     */
    private _resolveEffectiveWorkspaceRoot(workspaceRoot: string): string {
        try {
            const { resolveEffectiveWorkspaceRootFromMappings } = require('./WorkspaceIdentityService');
            return resolveEffectiveWorkspaceRootFromMappings(path.resolve(workspaceRoot));
        } catch { /* outside extension host */ }
        return path.resolve(workspaceRoot);
    }

    private _buildKanbanWorkspaceItems(): Array<{ label: string; workspaceRoot: string }> {
        return buildWorkspaceItems(this._getWorkspaceRoots());
    }


    /**
     * Dependency bundle for `sharedUtilityVerbs`. The push is supplied per call
     * site rather than fixed here: these arms historically used two different
     * mechanisms — `postMessageToWebview` for the clipboard/Linear-catalog arms
     * and `_pushTo(targetPanel, 'planning', …)` for the markdown-render arm,
     * which also honours the project-panel split. Preserving each arm's original
     * push keeps this refactor behaviour-neutral for Planning.
     */
    private _sharedUtilityDeps(push: (message: any) => void, fallbackWorkspaceRoot?: string): SharedUtilityVerbDeps {
        return {
            seams: () => this._seams(),
            resolveWorkspaceRoot: (given?: string) => this._resolveWorkspaceRoot(given),
            push,
            findTicketFilePath: (root: string, provider: string, id: string) =>
                this._findTicketFilePath(root, provider, id),
            rewriteLocalImagePaths: (content: string, dir: string) =>
                this._rewriteLocalImagePaths(content, dir),
            getTicketDocumentDirs: (root: string, provider: any) =>
                this._getTicketDocumentDirs(root, provider),
            getLinearSyncService: (root: string) => this._adapterFactories.getLinearSyncService(root),
            fallbackWorkspaceRoot
        };
    }

    private async _handleMessage(msg: any, isProject: boolean = false): Promise<any> {
        // Ready-handshake: the Project panel webview signals boot completion.
        // Handle before the allRoots guard so readiness is recorded even when
        // no workspace is open. Only the Project panel sends this message.
        if (msg.type === 'webviewReady' && isProject) {
            this._flushPendingProjectMessages();
            return;
        }

        const allRoots = this._getWorkspaceRoots();
        if (allRoots.length === 0) {
            const errorPanel = isProject ? this._projectPanel : this._panel;
            this._pushTo(errorPanel, 'planning', { type: 'error', message: 'No workspace open' });
            return { success: false, error: 'No workspace open' };
        }

        // Use active workspace root if available, otherwise use first root
        const workspaceRoot = this._getWorkspaceRoot() || allRoots[0];

        // Ensure adapters are registered before processing any message
        this._ensureAdaptersRegistered();

        switch (msg.type) {
            // HTTP-originated handshake (handleServiceVerb calls this with one argument,
            // so isProject is false and the _flushPendingProjectMessages branch above is
            // not reached). Ack it so the browser's POST /project/verb/webviewReady returns
            // 200 instead of the allowlist throw's 500-and-red-banner. Deliberately does NOT
            // flush _pendingProjectMessages: that queue gates ONLY the editor's
            // _projectPanel.webview, and WS clients are mirrored unconditionally.
            case 'webviewReady':
                return { success: true };
            case 'renderMarkdownLive': {
                const mdTargetPanel = isProject ? this._projectPanel : this._panel;
                return await handleRenderMarkdownLive(
                    this._sharedUtilityDeps(m => this._pushTo(mdTargetPanel, 'planning', m), workspaceRoot), msg
                );
            }
            case 'fetchRoots': {
                console.log('[PlanningPanel] Received fetchRoots, _panel exists:', !!this._panel);
                const sources = this._researchImportService.getAvailableSources();
                console.log('[PlanningPanel] Available sources at fetchRoots:', sources);

                // Send workspaceItems and restoredTabState
                const items = buildWorkspaceItems(allRoots);
                const tabKeys = ['local', 'online', 'kanban', 'tickets', 'research', 'notebook', 'localDocs.root', 'onlineDocs.root', 'kanban.root', 'kanban.project', 'tickets.root', 'research.root', 'notebook.root'];
                const statePayload = this._stateStore.getAllStates(tabKeys, allRoots);
                this.postMessageToWebview({
                    type: 'workspaceItemsUpdated',
                    items
                });
                this.postMessageToWebview({
                    type: 'restoredTabState',
                    panel: statePayload.panel,
                    byRoot: statePayload.byRoot
                });

                const integrationWorkspaces = await this._getIntegrationWorkspaces();
                this.postMessageToWebview({
                    type: 'integrationWorkspaces',
                    workspaces: integrationWorkspaces
                });

                // ONE scan only. The doc-tree payloads are captured here and folded into
                // the fetchRootsComplete return body below (browser HTTP rail); the same
                // call already pushed them to the webview/WS. Calling this twice doubles
                // every folder scan, online-source fetch and imported-docs heal pass.
                const docTreeRoots = await this._handleFetchRoots(true);

                // Send integration provider preference
                let integrationProviderStates: any = { clickupSetupComplete: false, linearSetupComplete: false, provider: null };
                try {
                    const [clickUpConfig, linearConfig] = await Promise.all([
                        this._adapterFactories.getClickUpSyncService(workspaceRoot).loadConfig(),
                        this._adapterFactories.getLinearSyncService(workspaceRoot).loadConfig()
                    ]);
                    const clickupSetupComplete = clickUpConfig?.setupComplete === true;
                    const linearSetupComplete = linearConfig?.setupComplete === true;
                    let activeProvider = this._activeTicketsProvider;
                    if (!activeProvider) {
                        if (clickupSetupComplete && linearSetupComplete) {
                            activeProvider = 'clickup';
                        } else if (clickupSetupComplete) {
                            activeProvider = 'clickup';
                        } else if (linearSetupComplete) {
                            activeProvider = 'linear';
                        }
                        if (activeProvider) {
                            this._activeTicketsProvider = activeProvider;
                        }
                    }
                    const provider = activeProvider || null;
                    integrationProviderStates = { clickupSetupComplete, linearSetupComplete, provider };
                    this.postMessageToWebview({ type: 'integrationProviderStates', ...integrationProviderStates });
                } catch (err) {
                    console.warn('[PlanningPanel] Failed to determine integration provider states:', err);
                }
                return {
                    success: true,
                    type: 'fetchRootsComplete',
                    sources,
                    workspaceItems: items,
                    restoredTabState: statePayload,
                    integrationWorkspaces,
                    integrationProviderStates,
                    localDocs: docTreeRoots?.localDocs,
                    onlineDocs: docTreeRoots?.onlineDocs,
                    importedDocs: docTreeRoots?.importedDocs
                };
            }
            case 'persistTabState': {
                const { tabKey, workspaceRoot: root, state } = msg;
                if (tabKey) {
                    if (root) {
                        await this._stateStore.setRootState(tabKey, root, state);
                    } else {
                        await this._stateStore.setPanelState(tabKey, state);
                    }
                }
                break;
            }

            // ── 2c: setupTicketsWatcher + ticketsDefaultRoot + ticketsRootChanged
            //    moved to TicketsPanelProvider. Stubs removed — the catalog generator
            //    scans for `case 'verb':` to assign verbs to panels, so leaving the
            //    case blocks here would keep them in PLANNING_VERBS. ──

            // ── 2e: submitComment retained here — it serves the live kanban +
            //    project review-comment sidebars (planning.js / project.js post it
            //    and handle commentResult), which route to PlanningPanelProvider. ──
            case 'submitComment': {
                try {
                    const selectedText = typeof msg?.selectedText === 'string' ? msg.selectedText.trim() : '';
                    const comment = typeof msg?.comment === 'string' ? msg.comment.trim() : '';
                    let planFileAbsolute = typeof msg?.planFileAbsolute === 'string' ? msg.planFileAbsolute.trim() : '';

                    // Resolve relative planFile against workspace roots.
                    // The webview sends the DB-stored relative path (e.g. .switchboard/plans/foo.md);
                    // sendReviewComment expects an absolute path.
                    if (planFileAbsolute && !path.isAbsolute(planFileAbsolute)) {
                        for (const root of allRoots) {
                            const candidate = path.resolve(root, planFileAbsolute);
                            if (fs.existsSync(candidate)) {
                                planFileAbsolute = candidate;
                                break;
                            }
                        }
                    }

                    if (!selectedText) {
                        throw new Error('Please select text before submitting a comment.');
                    }
                    if (!comment) {
                        throw new Error('Please enter a comment before submitting.');
                    }

                    const request: ReviewCommentRequest = {
                        sessionId: msg.sessionId || '',
                        topic: msg.topic || '',
                        planFileAbsolute,
                        selectedText,
                        comment
                    };

                    const result = await this._seams().commands.executeCommand<ReviewCommentResult>(
                        'switchboard.sendReviewComment',
                        request
                    );

                    const normalizedResult = result && typeof result.ok === 'boolean'
                        ? result
                        : { ok: false, message: 'Review comment dispatch failed (no response).' };

                    this.postMessageToWebview({ type: 'commentResult', ...normalizedResult });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.postMessageToWebview({ type: 'commentResult', ok: false, message });
                }
                break;
            }
            case 'savePlanningContainerSelection': {
                const sourceId = String(msg.sourceId || '').trim();
                const containerId = String(msg.containerId || '').trim();
                if (!sourceId) { break; }

                try {
                    const { configPath, sourceRoot, config: existingConfig } = await this._resolveSyncConfig();
                    let targetConfigPath = configPath;
                    let targetRoot = sourceRoot;

                    // No existing config — create in first root
                    if (!targetRoot) {
                        const allRoots = this._getWorkspaceRoots();
                        if (allRoots.length === 0) { break; }
                        targetRoot = allRoots[0];
                        targetConfigPath = 'db';
                        console.log(`[PlanningPanel] Creating new config in DB for: ${targetRoot}`);
                    }

                    // Build updated config
                    const config = { ...existingConfig };
                    if (!config.browseFilterContainers) {
                        config.browseFilterContainers = {};
                    }
                    if (containerId && containerId !== '__all__') {
                        config.browseFilterContainers[sourceId] = containerId;
                    } else {
                        delete config.browseFilterContainers[sourceId];
                    }
                    const db = KanbanDatabase.forWorkspace(targetRoot);
                    await db.setConfig('planning.syncMode', config.syncMode);
                    await db.setConfigJson('planning.selectedContainers', config.selectedContainers);
                    await db.setConfigJson('planning.browseFilterContainers', config.browseFilterContainers);
                    await db.setConfigJson('planning.uploadLocations', config.uploadLocations);
                    await db.setConfigJson('planning.docMappings', config.docMappings);

                    // Update cache to reflect new state
                    this._resolvedConfigCache = {
                        configPath: 'db',
                        config,
                        sourceRoot: targetRoot
                    };
                } catch (error) {
                    console.error('[PlanningPanel] Failed to save container selection:', error);
                }
                break;
            }
            case 'fetchChildren': {
                return await this._handleFetchChildren(workspaceRoot, msg.sourceId, msg.parentId);
            }
            case 'fetchPreview': {
                return await this._handleFetchPreview(workspaceRoot, msg.sourceId, msg.docId, msg.requestId, msg.sourceFolder);
            }
            case 'appendToPlannerPrompt': {
                await this._handleAppendToPlannerPrompt(workspaceRoot, msg.sourceId, msg.docId, msg.docName, msg.content, msg.sourceFolder);
                break;
            }
            case 'importFullDoc': {
                await this._handleImportFullDoc(workspaceRoot, msg.sourceId, msg.docId, msg.docName, msg.sourceFolder);
                break;
            }
            case 'fetchPageContent': {
                return await this._handleFetchPageContent(workspaceRoot, msg.sourceId, msg.docId, msg.pageId, msg.requestId);
            }
            case 'fetchAntigravityArtifact': {
                const artifactPath = msg.artifactPath;
                const requestId = msg.requestId || -1;
                const allRoots = this._getWorkspaceRoots();
                const service = this._getLocalFolderService(allRoots[0] || '');
                const result = await service.fetchAntigravityArtifact(artifactPath);
                if (result.success) {
                    const okRes = {
                        type: 'previewReady',
                        sourceId: 'antigravity',
                        requestId,
                        content: result.content || '',
                        docName: path.basename(artifactPath, '.md')
                    };
                    this.postMessageToWebview(okRes);
                    return { ...okRes, success: true };
                } else {
                    const errRes = {
                        type: 'previewError',
                        sourceId: 'antigravity',
                        requestId,
                        error: result.error || 'Failed to load artifact'
                    };
                    this.postMessageToWebview(errRes);
                    return { ...errRes, success: false };
                }
            }
            case 'addLocalFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const result = await this._seams().ui.showOpenDialog({
                    openLabel: 'Add Docs Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addFolderPath(result[0]);
                    this._setupLocalFolderWatchers();
                    await this._sendLocalDocsReady();
                    this.postMessageToWebview({ type: 'localFoldersListed', paths: service.getFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeLocalFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                await service.removeFolderPath(msg.folderPath);
                this._setupLocalFolderWatchers();
                await this._sendLocalDocsReady();
                this.postMessageToWebview({ type: 'localFoldersListed', paths: service.getFolderPaths(), workspaceRoot: root });
                break;
            }
            case 'listLocalFolders': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                const paths = service.getFolderPaths();
                const res = { type: 'localFoldersListed', paths, workspaceRoot: root };
                this.postMessageToWebview(res);
                return { success: true, ...res };
            }
            // ── 2b: addTicketsFolder, removeTicketsFolder, listTicketsFolders,
            // saveTicketsFolderPaths, browseTicketsFolder, saveTicketsFolder
            // moved to TicketsPanelProvider. The Planning panel webview no longer
            // posts these (ticket markup moved to tickets.html in slice 2a). ──

            case 'listPlanningHtmlFolders': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                const paths = service.getPlanningHtmlFolderPaths();
                const res = { type: 'planningHtmlFoldersListed', paths, workspaceRoot: root };
                this.postMessageToWebview(res);
                return { success: true, ...res };
            }
            case 'addPlanningHtmlFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const result = await this._seams().ui.showOpenDialog({
                    openLabel: 'Add HTML Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addPlanningHtmlFolderPath(result[0]);
                    this._setupPlanningHtmlFolderWatchers();
                    await this._sendPlanningHtmlDocsReady();
                    this.postMessageToWebview({ type: 'planningHtmlFoldersListed', paths: service.getPlanningHtmlFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removePlanningHtmlFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                await service.removePlanningHtmlFolderPath(msg.folderPath);
                this._setupPlanningHtmlFolderWatchers();
                await this._sendPlanningHtmlDocsReady();
                this.postMessageToWebview({ type: 'planningHtmlFoldersListed', paths: service.getPlanningHtmlFolderPaths(), workspaceRoot: root });
                break;
            }
            case 'serveAndOpenHtml': {
                try {
                    const rawOpenId = String(msg.docId || '');
                    const openRelativePath = rawOpenId.includes(':')
                        ? rawOpenId.substring(rawOpenId.indexOf(':') + 1)
                        : rawOpenId;
                    const fullPath = msg.absolutePath
                        || path.resolve(msg.sourceFolder || this._getWorkspaceRoot() || '', openRelativePath);
                    const serveFolder = msg.sourceFolder || path.dirname(fullPath);
                    await fs.promises.access(fullPath, require('fs').constants.R_OK);
                    const entry = await this._getOrCreatePlanningHtmlServer(path.resolve(serveFolder));
                    const url = this._buildLocalhostUrl(entry, path.resolve(serveFolder), fullPath);
                    await this._seams().ui.openExternal(url);
                } catch (err: any) {
                    this._seams().ui.showErrorMessage('Failed to serve HTML file: ' + err.message);
                }
                break;
            }
            case 'refreshSource': {
                const sourceId = msg.sourceId;
                // Clear cache for this source to force fresh fetch
                await this._cacheService?.clearSourceCache(sourceId);
                // Refresh only the affected pane to avoid cross-pane flicker
                if (sourceId === 'local-folder') {
                    await this._sendLocalDocsReady(true);
                } else if (sourceId === 'planning-html-folder') {
                    await this._sendPlanningHtmlDocsReady();
                } else {
                    this._sendOnlineDocsReady();
                }
                break;
            }
            case 'fetchContainers': {
                const sourceId = msg.sourceId;
                const adapter = this._researchImportService.getAdapter(sourceId);
                if (!adapter) {
                    const res = { type: 'containersReady', sourceId, containers: [] };
                    this.postMessageToWebview(res);
                    return { ...res, success: true };
                }
                try {
                    const containers = await adapter.listContainers();
                    const res = { type: 'containersReady', sourceId, containers };
                    this.postMessageToWebview(res);
                    return { ...res, success: true };
                } catch {
                    const res = { type: 'containersReady', sourceId, containers: [] };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            }
            case 'fetchImportedDocs': {
                return await this._handleFetchImportedDocs(workspaceRoot);
            }
            case 'fetchDocsFile': {
                return await this._handleFetchDocsFile(workspaceRoot, msg.slugPrefix, msg.requestId);
            }
            case 'syncToSource': {
                await this._handleSyncToSource(workspaceRoot, msg.slugPrefix);
                break;
            }
            case 'fetchFilteredDocs': {
                const sourceId = msg.sourceId;
                const containerId = msg.containerId;
                const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
                // Race guard — same Map, namespaced key. PUSH-ONLY (see _isFreshRequest):
                // the answer is always computed and returned to the caller.
                const filterKey = `filter:${sourceId}`;
                const fresh = this._isFreshRequest(filterKey);

                const adapter = this._researchImportService.getAdapter(sourceId);
                if (!adapter) {
                    const res = { type: 'filteredDocsReady', sourceId, nodes: [], requestId };
                    if (fresh()) { this.postMessageToWebview(res); }
                    return { ...res, success: true };
                }
                try {
                    let nodes: TreeNode[];
                    if (containerId === '__all__') {
                        // "All" mode — use listFiles() mapped to TreeNode[]
                        const files = await adapter.listFiles();
                        nodes = files.map(f => ({
                            id: f.id,
                            name: f.name,
                            kind: 'document' as const,
                            hasChildren: false,
                            url: f.url
                        }));
                    } else {
                        nodes = await adapter.listDocumentsByContainer(containerId);
                    }
                    const res = { type: 'filteredDocsReady', sourceId, nodes, requestId };
                    if (fresh()) { this.postMessageToWebview(res); }
                    return { ...res, success: true };
                } catch {
                    const res = { type: 'filteredDocsReady', sourceId, nodes: [], requestId };
                    if (fresh()) { this.postMessageToWebview(res); }
                    return { ...res, success: false };
                }
            }
            case 'fetchDocPages': {
                const sourceId = msg.sourceId;
                const docId = msg.docId;
                const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
                // Race guard — push-only (see _isFreshRequest).
                const pagesKey = `pages:${sourceId}:${docId}`;
                const fresh = this._isFreshRequest(pagesKey);

                const adapter = this._researchImportService.getAdapter(sourceId);

                if (!adapter || !adapter.listDocPages) {
                    const res = { type: 'docPagesReady', sourceId, docId, pages: [], requestId };
                    if (fresh()) { this.postMessageToWebview(res); }
                    return { ...res, success: true };
                }

                try {
                    const pages = await adapter.listDocPages(docId);
                    const res = { type: 'docPagesReady', sourceId, docId, pages, requestId };
                    if (fresh()) { this.postMessageToWebview(res); }
                    return { ...res, success: true };
                } catch {
                    const res = { type: 'docPagesReady', sourceId, docId, pages: [], requestId };
                    if (fresh()) { this.postMessageToWebview(res); }
                    return { ...res, success: false };
                }
            }
            case 'fetchPageContent': {
                const sourceId = msg.sourceId;
                const docId = msg.docId;
                const pageId = msg.pageId;
                const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
                // Race guard — reuse source-keyed tracking from fetchPreview; push-only
                // (see _isFreshRequest).
                const fresh = this._isFreshRequest(sourceId);

                const adapter = this._researchImportService.getAdapter(sourceId);
                if (!adapter || !adapter.fetchPageContent) {
                    const res = { type: 'previewError', sourceId, requestId, error: 'Adapter does not support page content' };
                    if (fresh()) { this.postMessageToWebview(res); }
                    return { ...res, success: false };
                }

                try {
                    const result = await adapter.fetchPageContent(docId, pageId);
                    if (result.success) {
                        const res = { type: 'previewReady', sourceId, requestId, content: result.content, docName: result.docName };
                        if (fresh()) { this.postMessageToWebview(res); }
                        return { ...res, success: true };
                    } else {
                        const res = { type: 'previewError', sourceId, requestId, error: result.error };
                        if (fresh()) { this.postMessageToWebview(res); }
                        return { ...res, success: false };
                    }
                } catch (err) {
                    const res = { type: 'previewError', sourceId, requestId, error: String(err) };
                    if (fresh()) { this.postMessageToWebview(res); }
                    return { ...res, success: false };
                }
            }
            case 'importPlansFromClipboard': {
                await this._handleImportPlansFromClipboard(workspaceRoot);
                break;
            }

            // ── Create Plans tab (docs-first external planning intake) ──────
            case 'createPlansInit': {
                const cpRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                // hasDocs now reports whether managed extras (constitution / PRDs /
                // README) exist — it gates the "include extras" checkbox, not the zip.
                let hasDocs = false;
                try { hasDocs = cpRoot ? (await this._collectExtraDocSources(cpRoot)).length > 0 : false; } catch { hasDocs = false; }
                // The browser Connections panel reaches this arm through
                // /connections/verb → _handlePlanningVerb, so the WS push (tagged
                // 'planning') never reaches it — transport.js re-dispatches the RETURN
                // body, and only when it carries a `type`. Push AND return.
                const cpState = {
                    type: 'createPlansState',
                    hasDocs,
                    publicUrl: this._stateStore.getPanelState<string>('createPlans.publicUrl') || '',
                    platform: this._stateStore.getPanelState<string>('createPlans.platform') || 'Notion',
                    platformRef: this._stateStore.getPanelState<string>('createPlans.platformRef') || ''
                };
                this.postMessageToWebview(cpState);
                return { success: true, ...cpState };
            }
            case 'createPlansCopyPrompt': {
                // One prompt, adapted only by a single source-specific first line.
                let header = '';
                if (msg.source === 'platform') {
                    const platform = ['Notion', 'ClickUp', 'Linear'].includes(msg.platform) ? msg.platform : 'Notion';
                    const reference = typeof msg.reference === 'string' ? msg.reference.trim() : '';
                    if (!reference) {
                        this._seams().ui.showTemporaryNotification('Enter the platform reference first');
                        break;
                    }
                    await this._stateStore.setPanelState('createPlans.platform', platform);
                    await this._stateStore.setPanelState('createPlans.platformRef', reference);
                    header = `The docs live in ${platform} at ${reference}. Use the ${platform} MCP to read them.\n\n`;
                } else {
                    const url = typeof msg.url === 'string' ? msg.url.trim() : '';
                    if (!url) {
                        this._seams().ui.showTemporaryNotification('Enter the public docs URL first');
                        break;
                    }
                    await this._stateStore.setPanelState('createPlans.publicUrl', url);
                    header = `The docs are published at ${url}. Read them there.\n\n`;
                }
                await this._seams().clipboard.writeText(header + CREATE_PLANS_CORE_PROMPT);
                this._seams().ui.showTemporaryNotification('Planning prompt copied to clipboard');
                break;
            }
            case 'createPlansPickFolder': {
                // The zip is built from a folder the user chooses — Switchboard does
                // not decide the doc set. This is the primary Create Plans source.
                const picked = await this._seams().ui.showOpenDialog({
                    openLabel: 'Zip this folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                const folder = picked && picked.length > 0 ? picked[0] : '';
                if (folder) {
                    const pickedMsg = { type: 'createPlansFolderPicked', folder };
                    this.postMessageToWebview(pickedMsg);
                    return { success: true, ...pickedMsg };
                }
                break;
            }
            case 'createPlansDownloadZip': {
                const cpRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                if (!cpRoot) {
                    this._seams().ui.showTemporaryNotification('No workspace open');
                    break;
                }
                const folder = typeof msg.folder === 'string' ? msg.folder.trim() : '';
                if (!folder) {
                    this._seams().ui.showTemporaryNotification('Choose a folder to bundle first');
                    break;
                }
                try {
                    // Primary source: the docs in the chosen folder, recursively.
                    const sources = await this._collectFolderDocSources(folder);
                    // Opt-in extras: constitution + PRDs + README on top of the folder.
                    if (msg.includeExtras) {
                        for (const extra of await this._collectExtraDocSources(cpRoot)) {
                            if (!sources.some(s => s.absPath === extra.absPath)) { sources.push(extra); }
                        }
                    }
                    if (sources.length === 0) {
                        this._seams().ui.showTemporaryNotification('That folder has no docs (.md / .txt) to bundle');
                        break;
                    }
                    const howToPlan = `# How to plan from these docs\n\n${CREATE_PLANS_CORE_PROMPT}\n\nThe docs are the other markdown files in this zip — see MANIFEST.md for the list.`;
                    const { zipPath, fileCount } = await bundleDocsContext(cpRoot, { sources, howToPlanMarkdown: howToPlan });
                    this._seams().ui.showTemporaryNotification(`Docs zip created (${fileCount} doc${fileCount === 1 ? '' : 's'})`);
                    try { await this._seams().commands.executeCommand('revealFileInOS', vscode.Uri.file(zipPath)); } catch { /* reveal is best-effort */ }
                } catch (err) {
                    this._seams().ui.showErrorMessage(`Docs zip failed: ${err instanceof Error ? err.message : String(err)}`);
                }
                break;
            }
            case 'createPlansPasteBack': {
                const markdown = typeof msg.markdown === 'string' ? msg.markdown : '';
                if (!markdown.trim()) {
                    const res = { type: 'createPlansPasteBackResult', ok: false, error: 'Paste a markdown plan first.' };
                    this.postMessageToWebview(res);
                    return { success: true, ...res };
                }
                if (markdown.length > 200_000) {
                    const res = { type: 'createPlansPasteBackResult', ok: false, error: 'Plan is too large (>200 KB).' };
                    this.postMessageToWebview(res);
                    return { success: true, ...res };
                }
                const pbRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                let cpProject: string | null = null;
                try { cpProject = (await this._kanbanProvider?.resolveAuthoringProject(pbRoot, msg.initiatorProject)) || null; } catch { cpProject = null; }
                try {
                    await this._seams().commands.executeCommand(
                        'switchboard.importPlanFromClipboard',
                        markdown,
                        cpProject ? { projectName: cpProject } : undefined
                    );
                    const res = { type: 'createPlansPasteBackResult', ok: true, projectName: cpProject };
                    this.postMessageToWebview(res);
                    return { success: true, ...res };
                } catch (err) {
                    const res = { type: 'createPlansPasteBackResult', ok: false, error: err instanceof Error ? err.message : String(err) };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            }
            case 'createPlansImproveSource': {
                // Optional handoff: copy a docs-improvement prompt for a configured
                // Docs-tab folder. Reads no code; the tab works without it.
                const cpFolders: string[] = [];
                for (const root of this._getWorkspaceRoots()) {
                    for (const p of this._getLocalFolderService(root).getFolderPaths()) {
                        if (!cpFolders.includes(p)) { cpFolders.push(p); }
                    }
                }
                if (cpFolders.length === 0) {
                    this._seams().ui.showTemporaryNotification('Add a docs folder via Manage Folders first.');
                    break;
                }
                let target = cpFolders[0];
                if (cpFolders.length > 1) {
                    const picked = await this._seams().ui.showQuickPick(
                        cpFolders.map(p => ({ label: path.basename(p), description: p })),
                        { placeHolder: 'Which docs folder should the agent improve?' }
                    ) as { label: string; description?: string } | undefined;
                    if (!picked?.description) { break; }
                    target = picked.description;
                }
                const improvePrompt = `You are improving the planning docs in this folder: ${target}\n\nRead every markdown document in that folder. Rewrite and reorganise them so they work as a clear behavioural source for planning: what the product should do, the user flows start to finish, expected outcomes, and edge cases in user terms, plus what is out of scope. Fill gaps you can infer, flag gaps you cannot, and move implementation detail out of the way — the docs describe how the product behaves, not how it is built. Write the improved markdown back to the same files (or add a new file in the same folder where a topic deserves its own doc). Do not read or describe source code. Report back with a summary of what you changed.`;
                await this._seams().clipboard.writeText(improvePrompt);
                this._seams().ui.showTemporaryNotification('Docs-improvement prompt copied to clipboard');
                break;
            }
            case 'docsHealthCopyPrompt': {
                // Copy the self-contained docs-maintenance prompt. Uses the
                // createPlansInit push+return pattern (NOT createPlansCopyPrompt's
                // break-only form) so the webview's #dh-status updates in both the
                // VS Code host (postMessageToWebview) and the browser host
                // (transport.js re-dispatches the returned body).
                await this._seams().clipboard.writeText(DOCS_HEALTH_PROMPT);
                this._seams().ui.showTemporaryNotification('Docs maintenance prompt copied to clipboard');
                const dhResult = { type: 'docsHealthPromptResult', success: true };
                this.postMessageToWebview(dhResult);
                // `prompt` in the RETURNED body is what fills the clipboard on the
                // browser host: the headless clipboard seam is a no-op logger
                // (standalone/hostServices.ts), so the writeText above copies nothing
                // there — transport.js copies `result.prompt` via navigator.clipboard
                // client-side. Without it #dh-status says "Copied to clipboard!" over
                // an empty clipboard, a faked success the panel contract forbids. The
                // editor host ignores the extra field. `success` comes from dhResult
                // (spreading it after a literal `success` is TS2783).
                return { ...dhResult, prompt: DOCS_HEALTH_PROMPT };
            }
            case 'importResearchDoc': {
                const targetRoot = msg.workspaceRoot && allRoots.includes(msg.workspaceRoot) ? msg.workspaceRoot : workspaceRoot;
                await this._handleImportResearchDoc(targetRoot, msg.docTitle, msg.folderPath);
                break;
            }

            case 'linkToDocument': {
                await this._handleLinkToDocument(workspaceRoot, msg.sourceId, msg.docId, msg.docName, msg.sourceFolder);
                break;
            }
            case 'linkToFolder': {
                await this._handleLinkToFolder(workspaceRoot, msg.folderPath);
                break;
            }
            case 'createLocalDoc': {
                await this._handleCreateLocalDoc(workspaceRoot, msg.folderPath, msg.name, msg.description, msg.withAgent === true);
                break;
            }

            case 'draftImproveLocalDoc': {
                // Draft/Improve prompt for a local-folder doc selected in the Docs tab.
                // Webview-supplied path — accept only files inside a configured local
                // docs folder (the Docs tab's local-doc trust boundary; configured
                // folders may live outside the workspace roots, so a root check is
                // both too loose and too tight).
                const rawPath = typeof msg.path === 'string' && msg.path.endsWith('.md') ? path.resolve(msg.path) : '';
                let owningRoot: string | undefined;
                if (rawPath) {
                    for (const root of allRoots) {
                        const inside = this._getLocalFolderService(root).getFolderPaths().some(f => {
                            const base = path.resolve(f);
                            return rawPath === base || rawPath.startsWith(base + path.sep);
                        });
                        if (inside) { owningRoot = root; break; }
                    }
                }
                const safePath = owningRoot ? rawPath : null;
                if (!safePath) {
                    this._seams().ui.showTemporaryNotification('Local doc: invalid path — prompt not copied');
                    break;
                }
                const title = typeof msg.title === 'string' && msg.title ? msg.title : path.basename(safePath, '.md');
                const wsRoot = owningRoot || '';
                let currentContent = '';
                try { currentContent = await fs.promises.readFile(safePath, 'utf8'); } catch { /* treat as empty → Draft */ }
                const hasContent = !!(msg.hasContent === true) && !!(currentContent && currentContent.trim());
                const prompt = this._buildLocalDocDraftPrompt(safePath, title, wsRoot, hasContent, currentContent);
                await this._seams().clipboard.writeText(prompt);
                this._seams().ui.showTemporaryNotification('Doc prompt copied to clipboard');
                break;
            }

            case 'resolveDuplicate': {
                const { docName, sourceId, docId, action } = msg;
                await this._handleResolveDuplicate(workspaceRoot, docName, sourceId, docId, action);
                break;
            }
            case 'deleteLocalDoc': {
                const docId = msg.docId;
                const docName = msg.docName || docId;
                const docRoot = msg.workspaceRoot || workspaceRoot;
                const sourceFolder = msg.sourceFolder;
                if (!sourceFolder) {
                    this.postMessageToWebview({
                        type: 'localDocDeleted',
                        docId,
                        success: false,
                        error: 'sourceFolder is required'
                    });
                    break;
                }
                const service = this._getLocalFolderService(docRoot);
                const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
                const result = await service.deleteFile(cleanDocId, sourceFolder);
                if (result.success) {
                    // Refresh the local docs list
                    await this._sendLocalDocsReady();
                    this.postMessageToWebview({
                        type: 'localDocDeleted',
                        docId,
                        success: true
                    });
                } else {
                    this.postMessageToWebview({
                        type: 'localDocDeleted',
                        docId,
                        success: false,
                        error: result.error || 'Failed to delete file'
                    });
                }
                break;
            }
            case 'saveOnlineDocFile': {
                const slugPrefix = msg.slugPrefix;
                const content = msg.content || '';
                try {
                    const workspaceId = await this._getWorkspaceId(workspaceRoot);
                    let localPath: string | null = null;
                    if (this._cacheService) {
                        localPath = await this._cacheService.resolveImportedDocPath(slugPrefix, workspaceId);
                    }
                    if (!localPath) {
                        this.postMessageToWebview({
                            type: 'saveOnlineDocFileResult',
                            success: false,
                            error: 'Document not imported yet'
                        });
                        break;
                    }
                    
                    // Validate path is within workspace
                    const allRoots = this._getWorkspaceRoots();
                    const resolved = path.resolve(localPath);
                    const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
                    if (!isAllowed) {
                        this.postMessageToWebview({
                            type: 'saveOnlineDocFileResult',
                            success: false,
                            error: 'Path access not allowed'
                        });
                        break;
                    }

                    this._lastPanelWriteTimestamp = Date.now();
                    await fs.promises.writeFile(resolved, content, 'utf8');

                    this.postMessageToWebview({
                        type: 'saveOnlineDocFileResult',
                        success: true
                    });
                } catch (err) {
                    this.postMessageToWebview({
                        type: 'saveOnlineDocFileResult',
                        success: false,
                        error: String(err)
                    });
                }
                break;
            }
            case 'deleteImportedDoc': {
                const slugPrefix = msg.slugPrefix;
                const docName = msg.docName || slugPrefix;
                try {
                    // **CRITICAL FIX**: Look up actual file path from DB
                    let filePath: string | null = null;
                    if (this._cacheService) {
                        const workspaceId = await this._getWorkspaceId(workspaceRoot);
                        filePath = await this._cacheService.resolveImportedDocPath(slugPrefix, workspaceId);
                    }
                    
                    if (!filePath) {
                        // Fallback: construct path (legacy behavior)
                        filePath = path.join(workspaceRoot, '.switchboard', 'docs', `${slugPrefix}.md`);
                    }
                    
                    // Delete the file
                    if (fs.existsSync(filePath)) {
                        await fs.promises.unlink(filePath);
                    }
                    
                    // Remove DB entry
                    if (this._cacheService) {
                        const workspaceId = await this._getWorkspaceId(workspaceRoot);
                        await this._cacheService.removeImport(slugPrefix, workspaceId);
                    }
                    
                    // Refresh imported docs list
                    await this._handleFetchImportedDocs(workspaceRoot);
                    this.postMessageToWebview({
                        type: 'importedDocDeleted',
                        slugPrefix,
                        success: true
                    });
                } catch (err) {
                    this.postMessageToWebview({
                        type: 'importedDocDeleted',
                        slugPrefix,
                        success: false,
                        error: String(err)
                    });
                }
                break;
            }
            case 'importPlans': {
                // Manual "Import Plans": pick unclaimed plans (any age) to add to the board.
                await this._seams().commands.executeCommand('switchboard.importUnclaimedPlans');
                break;
            }
            case 'copyArtifactPrompt': {
                await this._seams().clipboard.writeText(msg.prompt || '');
                const targetPanel = isProject ? this._projectPanel : this._panel;
                this._pushTo(targetPanel, 'planning', { type: 'artifactPromptCopied', kind: msg.kind });
                break;
            }
            case 'sendArtifactPromptToTerminal': {
                const prompt = String(msg.prompt || '');
                if (!prompt) break;
                if (this._taskViewerProvider) {
                    const sent = await this._taskViewerProvider.sendPromptToAgentTerminal(
                        'claude_artifacts', prompt, msg.workspaceRoot
                    );
                    if (sent) {
                        const targetPanel = isProject ? this._projectPanel : this._panel;
                        this._pushTo(targetPanel, 'planning', { type: 'artifactPromptSent', kind: msg.kind });
                        return { success: true };
                    }
                    await this._seams().clipboard.writeText(prompt);
                    return { success: false, error: 'No claude_artifacts terminal could be reached — prompt copied to clipboard instead.', prompt };
                }
                await this._seams().clipboard.writeText(prompt);
                showTemporaryNotification('Agent terminal unavailable — copied artifact prompt to clipboard instead.');
                return { success: false, error: 'Agent terminal unavailable — prompt copied to clipboard instead.', prompt };
            }
            case 'copyHtmlTweakPrompt': {
                const prompt = String(msg.prompt || '');
                if (!prompt) break;
                await this._seams().clipboard.writeText(prompt);
                this._seams().ui.showTemporaryNotification('Copied element tweak prompt to clipboard.');
                break;
            }
            case 'sendHtmlTweakPrompt': {
                const prompt = String(msg.prompt || '');
                if (!prompt) break;
                if (this._taskViewerProvider) {
                    const sent = await this._taskViewerProvider.sendPromptToAgentTerminal(
                        'coder', prompt, msg.workspaceRoot || undefined
                    );
                    if (sent) {
                        this._seams().ui.showTemporaryNotification('Sent element tweak prompt to agent terminal.');
                        return { success: true };
                    }
                    await this._seams().clipboard.writeText(prompt);
                    this._seams().ui.showTemporaryNotification('Agent terminal unreachable — copied tweak prompt to clipboard instead.');
                    return { success: false, error: 'No coder terminal could be reached — prompt copied to clipboard instead.', prompt };
                } else {
                    await this._seams().clipboard.writeText(prompt);
                    this._seams().ui.showTemporaryNotification('Agent terminal unavailable — copied tweak prompt to clipboard instead.');
                    return { success: false, error: 'Agent terminal unavailable — prompt copied to clipboard instead.', prompt };
                }
            }
            case 'copyChatPrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || undefined;
                const prompt = await this._seams().commands.executeCommand<string | undefined>('switchboard.copyChatPrompt', workspaceRoot, msg.project);
                if (prompt) {
                    const targetPanel = isProject ? this._projectPanel : this._panel;
                    this._pushTo(targetPanel, 'planning', { type: 'chatPromptCopied' });
                }
                break;
            }
            case 'uploadPlanAttachment': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { planFile, topic } = msg;
                if (!workspaceRoot || !planFile) {
                    this.postMessageToWebview({
                        type: 'uploadPlanAttachmentResult',
                        success: false,
                        error: 'Missing workspace root or plan file.',
                        planFile
                    });
                    break;
                }
                try {
                    const db = KanbanDatabase.forWorkspace(workspaceRoot);
                    const workspaceId = await this._getWorkspaceId(workspaceRoot);
                    const plan = await db.getPlanByPlanFile(planFile, workspaceId);
                    if (!plan) {
                        this.postMessageToWebview({
                            type: 'uploadPlanAttachmentResult',
                            success: false,
                            error: 'Plan not found in kanban database.',
                            planFile
                        });
                        break;
                    }
                    if (!plan.clickupTaskId && !plan.linearIssueId) {
                        this.postMessageToWebview({
                            type: 'uploadPlanAttachmentResult',
                            success: false,
                            error: 'Plan is not linked to a ClickUp task or Linear issue.',
                            planFile
                        });
                        break;
                    }

                    const planFileAbsolute = path.isAbsolute(planFile)
                        ? planFile
                        : path.join(workspaceRoot, planFile);
                    const resolvedFile = path.resolve(planFileAbsolute);
                    const resolvedRoot = path.resolve(workspaceRoot);
                    if (!resolvedFile.startsWith(resolvedRoot + path.sep) && resolvedFile !== resolvedRoot) {
                        this.postMessageToWebview({
                            type: 'uploadPlanAttachmentResult',
                            success: false,
                            error: 'Plan file path is outside the workspace root.',
                            planFile
                        });
                        break;
                    }
                    const buffer = await fs.promises.readFile(planFileAbsolute);
                    const fileName = path.basename(planFileAbsolute);
                    const clickupTaskId = plan.clickupTaskId;
                    const linearIssueId = plan.linearIssueId;

                    if (clickupTaskId) {
                        const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        const result = await clickup.attachFile(clickupTaskId, fileName, buffer);
                        this.postMessageToWebview({
                            type: 'uploadPlanAttachmentResult',
                            success: true,
                            url: result?.url || '',
                            provider: 'clickup',
                            planFile
                        });
                    } else if (linearIssueId) {
                        const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        const result = await linear.uploadAttachment(linearIssueId, buffer, fileName);
                        this.postMessageToWebview({
                            type: 'uploadPlanAttachmentResult',
                            success: true,
                            url: result?.url || '',
                            provider: 'linear',
                            planFile
                        });
                    }
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    this.postMessageToWebview({
                        type: 'uploadPlanAttachmentResult',
                        success: false,
                        error: errMsg,
                        planFile
                    });
                }
                break;
            }
            case 'createPlan': {
                await this._seams().commands.executeCommand('switchboard.initiatePlan');
                break;
            }
            case 'fetchKanbanPlans': {
                const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
                const guardKey = 'kanban-plans';
                if (requestId <= (this._latestRequestIds.get(guardKey) || 0)) { return { success: false, error: 'Stale request' }; }
                this._latestRequestIds.set(guardKey, requestId);
                this._fullKanbanPlansSent = false;
                try {
                    const allRoots = Array.from(this._getAllowedRoots());
                    const allPlans: any[] = [];
                    const seenIds = new Set<string>();
                    const allWorkspaceProjects: Record<string, string[]> = {};
                    const allWorkspaceProjectPaths: Record<string, Record<string, { filePath: string; exists: boolean }>> = {};
                    const mergedColumns: { id: string; label: string; kind: string; order: number }[] = [];
                    const seenColumnIds = new Set<string>();

                    // Build workspaceItems using workspace mapping (or folder names as fallback)
                    const workspaceItems = this._buildKanbanWorkspaceItems();

                    for (const root of allRoots) {
                        try {
                            const plans = await this._getKanbanPlans(root);
                            for (const p of plans) {
                                if (!seenIds.has(p.planId)) {
                                    seenIds.add(p.planId);
                                    allPlans.push(p);
                                }
                            }
                            // Fetch projects for this workspace
                            const db = KanbanDatabase.forWorkspace(root);
                            const workspaceId = await this._getWorkspaceId(root);
                            const projects = await db.getProjects(workspaceId);

                            // Key by both the actual root AND the effective (mapped parent) root
                            // so that the webview project-dropdown lookup works regardless of
                            // whether the user selected a mapped parent or an independent folder.
                            const resolvedRoot = path.resolve(root);
                            const effectiveRoot = this._resolveEffectiveWorkspaceRoot(root);

                            const projectPaths: Record<string, { filePath: string; exists: boolean }> = {};
                            for (const projectName of projects) {
                                // Use the same effective root that getProjectPrd / saveProjectPrd resolve to.
                                const filePath = getProjectPrdPath(effectiveRoot, projectName);
                                projectPaths[projectName] = { filePath, exists: fs.existsSync(filePath) };
                            }

                            allWorkspaceProjects[resolvedRoot] = projects;
                            allWorkspaceProjectPaths[resolvedRoot] = projectPaths;
                            if (effectiveRoot !== resolvedRoot) {
                                // Merge into the parent entry (or create it)
                                const existing = allWorkspaceProjects[effectiveRoot] || [];
                                allWorkspaceProjects[effectiveRoot] = [...new Set([...existing, ...projects])];

                                const existingPaths = allWorkspaceProjectPaths[effectiveRoot] || {};
                                allWorkspaceProjectPaths[effectiveRoot] = {
                                    ...projectPaths,
                                    ...existingPaths, // first-wins: keep existing project paths, add child-only projects
                                };
                            }

                            // Fetch column definitions for this workspace and merge
                            const colDefs = await this._getKanbanColumnDefinitions(root, plans);
                            for (const col of colDefs) {
                                if (!seenColumnIds.has(col.id)) {
                                    seenColumnIds.add(col.id);
                                    mergedColumns.push({ id: col.id, label: col.label, kind: col.kind, order: col.order });
                                }
                            }
                        } catch (err) { /* root has no kanban DB, skip */ }
                    }
                    if (requestId !== this._latestRequestIds.get(guardKey)) {
                        allPlans.sort((a, b) => b.mtime - a.mtime);
                        mergedColumns.sort((a, b) => a.order - b.order);
                        const stalePayload = {
                            type: 'kanbanPlansReady',
                            plans: allPlans,
                            workspaceItems,
                            allWorkspaceProjects,
                            allWorkspaceProjectPaths,
                            columns: mergedColumns,
                            kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
                            requestId
                        };
                        if (!this._fullKanbanPlansSent) {
                            this._postToBothPanels(stalePayload);
                            this._fullKanbanPlansSent = true;
                        }
                        return { success: true, ...stalePayload };
                    }
                    allPlans.sort((a, b) => b.mtime - a.mtime);
                    mergedColumns.sort((a, b) => a.order - b.order);
                    const resultPayload = {
                        type: 'kanbanPlansReady',
                        plans: allPlans,
                        workspaceItems,
                        allWorkspaceProjects,
                        allWorkspaceProjectPaths,
                        columns: mergedColumns,
                        kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
                        requestId
                    };
                    this._postToBothPanels(resultPayload);
                    this._fullKanbanPlansSent = true;
                    return { success: true, ...resultPayload };
                } catch (err: any) {
                    if (requestId === this._latestRequestIds.get(guardKey)) {
                        this._postToBothPanels({ type: 'kanbanPlansReady', plans: [], columns: [], requestId, error: String(err) });
                    }
                    return { success: false, error: String(err) };
                }
            }
            case 'openKanbanPlan': {
                const filePath: string = msg.filePath || '';
                const resolved = path.resolve(filePath);
                const isAllowed = Array.from(this._getAllowedRoots()).some(r => resolved.startsWith(path.resolve(r)));
                if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanOpenResult', success: false, error: 'File not found or not in workspace' });
                    break;
                }
                try {
                    await this._seams().editor.showTextDocument(resolved, { viewColumn: 2 });
                    this.postMessageToProjectWebview({ type: 'kanbanPlanOpenResult', success: true });
                } catch (err) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanOpenResult', success: false, error: String(err) });
                }
                break;
            }
            case 'fetchKanbanPlanPreview': {
                const filePath: string = msg.filePath || '';
                const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
                return await this._handleFetchKanbanPlanPreview(filePath, requestId);
            }

            case 'copyKanbanPlanPrompt': {
                const sessionId = String(msg.sessionId || '');
                const column = String(msg.column || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!sessionId) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId' });
                    break;
                }
                if (!this._kanbanProvider) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: 'No kanban provider' });
                    break;
                }
                try {
                    const result = await this._kanbanProvider.handleServiceVerb('promptSelected', {
                        sessionIds: [sessionId],
                        column,
                        workspaceRoot: wsRoot
                    });
                    this.postMessageToProjectWebview({
                        type: 'kanbanPlanPromptCopied',
                        success: !!result?.success,
                        sessionId,
                        targetColumn: result?.targetColumn || undefined
                    });
                } catch (err) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
                }
                break;
            }
            case 'copyFeaturePlannerPrompt': {
                const sessionId = String(msg.sessionId || '');
                const column = String(msg.column || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!sessionId || !this._kanbanProvider) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId or kanban provider' });
                    break;
                }
                try {
                    const result = await this._kanbanProvider.handleServiceVerb('promptSelected', {
                        sessionIds: [sessionId],
                        column,
                        workspaceRoot: wsRoot
                    });
                    this.postMessageToProjectWebview({
                        type: 'kanbanPlanPromptCopied',
                        success: !!result?.success,
                        sessionId,
                        targetColumn: result?.targetColumn || undefined
                    });
                } catch (err) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
                }
                break;
            }
            case 'moveKanbanPlanColumn': {
                const planFile = String(msg.planFile || '');
                const newColumn = String(msg.newColumn || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!planFile || !newColumn) {
                    const payload = { success: false, error: 'Missing planFile or newColumn' };
                    this.postMessageToProjectWebview({ type: 'kanbanPlanColumnChanged', ...payload });
                    return payload;
                }
                try {
                    const outcome = await this._seams().commands.executeCommand<ColumnUpdateOutcome | undefined>(
                        'switchboard.moveKanbanCardByPlanFileWithReason', wsRoot, planFile, newColumn
                    );
                    const ok = !!outcome?.ok;
                    const payload = ok
                        ? { success: true }
                        : { success: false, error: outcome?.detail ?? 'Column update failed', reason: outcome?.reason };
                    this.postMessageToProjectWebview({ type: 'kanbanPlanColumnChanged', ...payload });
                    return payload;
                } catch (err) {
                    const payload = { success: false, error: String(err) };
                    this.postMessageToProjectWebview({ type: 'kanbanPlanColumnChanged', ...payload });
                    return payload;
                }
            }
            case 'planShown': {
                const sessionId = String(msg.sessionId || '');
                if (sessionId) {
                    await this._seams().commands.executeCommand('switchboard.selectSession', sessionId);
                }
                return { success: true, sessionId };
            }
            case 'setKanbanPlanComplexity': {
                const planId = String(msg.planId || '');
                const complexity = String(msg.complexity || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!planId) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanComplexityChanged', success: false, error: 'Missing planId' });
                    break;
                }
                let normalizedComplexity = complexity;
                if (!isValidComplexityValue(complexity)) {
                    const score = legacyToScore(complexity);
                    normalizedComplexity = score > 0 ? String(score) : 'Unknown';
                }
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    await db.updateComplexityByPlanId(planId, normalizedComplexity);
                    // Persist the choice into the plan file as a Manual Complexity
                    // Override. The DB update alone does NOT stick: the plan watcher
                    // re-derives complexity from the file's **Complexity:** line on the
                    // next file event and overwrites the DB. The override marker is the
                    // highest-priority source for both parsers, so writing it makes the
                    // dropdown change survive re-import.
                    try {
                        const planRecord = await db.getPlanByPlanId(planId);
                        const relPlanFile = planRecord?.planFile;
                        if (relPlanFile) {
                            const absPlanFile = path.isAbsolute(relPlanFile)
                                ? relPlanFile
                                : path.resolve(wsRoot, relPlanFile);
                            const nfs = require('fs') as typeof import('fs');
                            const content = await nfs.promises.readFile(absPlanFile, 'utf8');
                            const updated = applyManualComplexityOverride(content, normalizedComplexity);
                            if (updated !== content) {
                                  await nfs.promises.writeFile(absPlanFile, updated, 'utf8');
                            }
                        }
                    } catch (fileErr) {
                        console.warn('[PlanningPanelProvider] Failed to persist complexity override to plan file:', fileErr);
                    }
                    const allPlans = await this._getKanbanPlans(wsRoot);
                    const effectiveRoot = this._resolveEffectiveWorkspaceRoot(wsRoot);
                    this.postMessageToProjectWebview({ type: 'kanbanPlansReady', plans: allPlans, workspaceRoot: effectiveRoot, requestId: Date.now() });
                    this.postMessageToProjectWebview({ type: 'kanbanPlanComplexityChanged', success: true });
                } catch (err) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanComplexityChanged', success: false, error: String(err) });
                }
                break;
            }
            case 'deleteKanbanPlan': {
                const planId = String(msg.planId || '');
                const planFile = String(msg.planFile || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!planId || !wsRoot) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanDeleted', success: false, error: 'Missing planId or workspaceRoot' });
                    break;
                }
                if (planFile) {
                    const resolvedPlanFile = path.isAbsolute(planFile)
                        ? planFile
                        : path.resolve(wsRoot, planFile);
                    const resolvedRoot = path.resolve(wsRoot);
                    const rel = path.relative(resolvedRoot, resolvedPlanFile);
                    if (rel.startsWith('..') || path.isAbsolute(rel)) {
                        this.postMessageToProjectWebview({ type: 'kanbanPlanDeleted', success: false, error: 'Plan file is outside workspace root' });
                        break;
                    }
                }
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    // Capture feature_id BEFORE the row is destroyed — the parent link
                    // (plans.feature_id) is gone after deletePlanByPlanId, so a
                    // post-delete read cannot recover it. Mirrors the verified
                    // _removeSubtaskFromFeature capture-before-mutate pattern.
                    const rec = await db.getPlanByPlanId(planId);
                    const featureId = rec?.featureId || '';
                    await db.deletePlanByPlanId(planId);
                    // Delete the .md file from disk so the watcher doesn't re-import it
                    if (planFile) {
                        const resolvedPlanFile = path.isAbsolute(planFile)
                            ? planFile
                            : path.resolve(wsRoot, planFile);
                        try {
                            await require('fs').promises.unlink(resolvedPlanFile);
                        } catch (unlinkErr: any) {
                            if (unlinkErr?.code !== 'ENOENT') {
                                console.warn(`[PlanningPanelProvider] Failed to delete plan file ${resolvedPlanFile}:`, unlinkErr);
                            }
                        }
                    }
                    // Regenerate the parent feature's ## Subtasks block now that the
                    // subtask row is gone. No-op for non-subtask deletes (featureId === '').
                    if (featureId) {
                        try {
                            await this._kanbanProvider?.regenerateFeatureFile(wsRoot, featureId);
                        } catch (regenErr) {
                            console.warn(`[PlanningPanelProvider] regenerateFeatureFile failed for ${featureId}:`, regenErr);
                        }
                    }
                    this.postMessageToProjectWebview({ type: 'kanbanPlanDeleted', success: true, planId });
                } catch (err) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanDeleted', success: false, error: String(err) });
                }
                break;
            }
            case 'fetchKanbanPlanLog': {
                const sessionId = String(msg.sessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!sessionId || !wsRoot) {
                    const errRes = { type: 'kanbanPlanLogReady', entries: [], error: 'Missing sessionId or workspaceRoot' };
                    this.postMessageToProjectWebview(errRes);
                    return { ...errRes, success: false };
                }
                try {
                    const { SessionActionLog } = require('./SessionActionLog');
                    const log = new SessionActionLog(wsRoot);
                    const sheet = await log.getRunSheet(sessionId);
                    const events: any[] = Array.isArray(sheet?.events) ? sheet.events : [];
                    const entries = formatReviewLogEntries(events);
                    const okRes = { type: 'kanbanPlanLogReady', entries };
                    this.postMessageToProjectWebview(okRes);
                    return { ...okRes, success: true };
                } catch (err) {
                    const errRes = { type: 'kanbanPlanLogReady', entries: [], error: String(err) };
                    this.postMessageToProjectWebview(errRes);
                    return { ...errRes, success: false };
                }
            }
            case 'getFeatureDetails': {
                const sessionId = String(msg.sessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!sessionId || !wsRoot) {
                    const errRes = { type: 'featureDetails', feature: null, subtasks: [] };
                    this.postMessageToProjectWebview(errRes);
                    return { ...errRes, success: false };
                }
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    const feature = await db.getPlanByPlanId(sessionId);
                    const subtasks = feature && feature.isFeature ? await db.getSubtasksByFeatureId(feature.planId) : [];
                    const okRes = { type: 'featureDetails', feature, subtasks };
                    this.postMessageToProjectWebview(okRes);
                    return { ...okRes, success: true };
                } catch (err) {
                    const errRes = { type: 'featureDetails', feature: null, subtasks: [], error: String(err) };
                    this.postMessageToProjectWebview(errRes);
                    return { ...errRes, success: false };
                }
            }
            case 'addSubtaskToFeature': {
                const featureSessionId = String(msg.featureSessionId || '');
                const subtaskSessionId = String(msg.subtaskSessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!featureSessionId || !subtaskSessionId || !wsRoot) break;
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    const feature = await db.getPlanByPlanId(featureSessionId);
                    if (!feature || !feature.isFeature) break;
                    // Lock-column validation
                    const lockColumnsRaw = await db.getConfig('feature_lock_columns');
                    const lockColumns = (lockColumnsRaw || 'IN PROGRESS,CODE REVIEW,REVIEWED,DONE').split(',').map((c: string) => c.trim());
                    if (lockColumns.includes(feature.kanbanColumn)) {
                        this.postMessageToProjectWebview({ type: 'featureError', message: 'Cannot modify subtasks of a feature in a locked column.' });
                        break;
                    }
                    const subtask = await db.getPlanByPlanId(subtaskSessionId);
                    if (!subtask) break;
                    if (subtask.isFeature) {
                        this.postMessageToProjectWebview({ type: 'featureError', message: 'Cannot add a feature as a subtask.' });
                        break;
                    }
                    if (subtask.featureId && subtask.featureId !== feature.planId) {
                        this.postMessageToProjectWebview({ type: 'featureError', message: 'Subtask already belongs to another feature.' });
                        break;
                    }
                    await db.updateFeatureStatus(subtask.planId, 0, feature.planId);
                    const allPlans = await this._getKanbanPlans(wsRoot);
                    const effectiveRoot = this._resolveEffectiveWorkspaceRoot(wsRoot);
                    this.postMessageToProjectWebview({ type: 'kanbanPlansReady', plans: allPlans, workspaceRoot: effectiveRoot, requestId: Date.now() });
                } catch (err) {
                    console.error('[PlanningPanelProvider] addSubtaskToFeature failed:', err);
                }
                break;
            }
            case 'removeSubtaskFromFeature': {
                const subtaskSessionId = String(msg.subtaskSessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!subtaskSessionId || !wsRoot) break;
                try {
                    // Delegate to the shared KanbanProvider._removeSubtaskFromFeature — it
                    // detaches, abandons any subtask-bound worktree, regenerates the feature
                    // file, refreshes the kanban board, and unlinks from external trackers.
                    // The previous local body only did updateFeatureStatus and omitted regen,
                    // worktree abandon, and tracker unlink. Same shape as the existing
                    // TaskViewerProvider delegation (TaskViewerProvider.ts:1042).
                    if (this._kanbanProvider) {
                        await this._kanbanProvider._removeSubtaskFromFeature(wsRoot, subtaskSessionId);
                    }
                    // Preserve the planning-panel webview refresh — _removeSubtaskFromFeature's
                    // _refreshBoard targets the kanban board, not this provider's _projectPanel.
                    // Without this, the planning panel goes stale on every detach.
                    const allPlans = await this._getKanbanPlans(wsRoot);
                    const effectiveRoot = this._resolveEffectiveWorkspaceRoot(wsRoot);
                    this.postMessageToProjectWebview({ type: 'kanbanPlansReady', plans: allPlans, workspaceRoot: effectiveRoot, requestId: Date.now() });
                } catch (err) {
                    console.error('[PlanningPanelProvider] removeSubtaskFromFeature failed:', err);
                }
                break;
            }
            case 'deleteFeature': {
                const sessionId = String(msg.sessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                const deleteSubtasks = !!msg.deleteSubtasks;
                if (!sessionId || !wsRoot) break;
                try {
                    // Delegate to KanbanProvider._deleteFeature so the file-reap +
                    // **Feature:** strip + plan_id tombstone guard logic is shared
                    // (avoids the file-resurrect bug where the surviving .md re-imports).
                    if (this._kanbanProvider) {
                        await this._kanbanProvider._deleteFeature(wsRoot, sessionId, deleteSubtasks);
                    } else {
                        const db = KanbanDatabase.forWorkspace(wsRoot);
                        const feature = await db.getPlanByPlanId(sessionId);
                        if (!feature || !feature.isFeature) break;
                        if (deleteSubtasks) {
                            const subtasks = await db.getSubtasksByFeatureId(feature.planId);
                            for (const st of subtasks) {
                                await db.tombstonePlan(st.planId);
                            }
                        } else {
                            await db.clearFeatureIdForFeature(feature.planId);
                        }
                        await db.tombstonePlan(feature.planId);
                    }
                    const allPlans = await this._getKanbanPlans(wsRoot);
                    const effectiveRoot = this._resolveEffectiveWorkspaceRoot(wsRoot);
                    this.postMessageToProjectWebview({ type: 'kanbanPlansReady', plans: allPlans, workspaceRoot: effectiveRoot, requestId: Date.now() });
                } catch (err) {
                    console.error('[PlanningPanelProvider] deleteFeature failed:', err);
                }
                break;
            }
            case 'createFeature': {
                try {
                    const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (!wsRoot) {
                        this.postMessageToProjectWebview({ type: 'featureError', message: 'No workspace root resolved.' });
                        break;
                    }
                    const name = String(msg.name || '').trim();
                    if (!name) {
                        this.postMessageToProjectWebview({ type: 'featureError', message: 'Feature name is required.' });
                        break;
                    }
                    const description = msg.description ? String(msg.description).trim() : undefined;

                    // Delegate to the shared, hardened entry point so the Features-tab path runs
                    // IDENTICAL logic to the Kanban board webview path and the LocalApiServer/
                    // agent path. This is the single choke point that: inherits project/
                    // project_id, embeds the full planId UUID in the filename, re-asserts
                    // is_feature=1 as the final DB write, and calls _refreshBoard() so the Kanban
                    // board panel actually updates. The previous duplicated body here omitted all
                    // three, which is why a Features-tab feature never appeared on the board (and
                    // showed up as a plain plan once a later refresh ran).
                    if (!this._kanbanProvider) {
                        this.postMessageToProjectWebview({ type: 'featureError', message: 'Kanban provider not available.' });
                        break;
                    }
                    const result = await this._kanbanProvider.createFeatureFromPlanIds(
                        wsRoot,
                        name,
                        [],            // blank feature from the "+ New Feature" modal
                        description
                    );
                    if (!result.success) {
                        this.postMessageToProjectWebview({ type: 'featureError', message: result.error || 'Failed to create feature.' });
                        break;
                    }

                    // createFeatureFromPlanIds refreshed the Kanban board panel; still refresh the
                    // Features tab list (it reads from kanbanPlansReady, not the board push).
                    this._handleMessage({
                        type: 'fetchKanbanPlans',
                        requestId: Date.now()
                    }, true).catch(err => {
                        console.error('[PlanningPanelProvider] createFeature post-fetch failed:', err);
                    });
                } catch (err) {
                    console.error('[PlanningPanelProvider] createFeature failed:', err);
                    this.postMessageToProjectWebview({ type: 'featureError', message: String(err) });
                }
                break;
            }
            case 'updateFeatureConfig': {
                // feature_prompt_template / feature_lock_columns / feature_max_subtasks writes are all
                // removed: the cap is gone (every subtask dispatches), and the other two were
                // already dormant. Legacy keys are never dropped — they are still READ as
                // fallback (per CLAUDE.md); we simply stop writing them here.
                break;
            }
            case 'loadConstitutionFiles': {
                const workspaceItems = buildWorkspaceItems(allRoots);
                const workspaces = workspaceItems.map(ws => {
                    const governance = (['constitution', 'claude', 'agents'] as const).map(key => {
                        const filePath = this._getGovernanceFilePath(ws.workspaceRoot, key);
                        return {
                            key,
                            exists: fs.existsSync(filePath),
                            filePath,
                        };
                    });
                    return {
                        label: ws.label,
                        workspaceRoot: ws.workspaceRoot,
                        governance,
                        hasConstitution: governance[0].exists /* keep legacy field */
                    };
                });
                const res = {
                    type: 'constitutionFilesLoaded',
                    workspaces,
                    kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null
                };
                this.postMessageToProjectWebview(res);
                return { success: true, ...res };
            }
            case 'getConstitutionStatus': {
                // project.js (project panel) requests constitution status for the meta bar.
                // Resolution mirrors KanbanProvider._getPromptsConfig:
                //   plannerConfig?.addons?.constitution ?? config('planner.constitutionEnabled', false)
                const wr = (typeof msg.workspaceRoot === 'string' && allRoots.includes(msg.workspaceRoot))
                    ? msg.workspaceRoot
                    : workspaceRoot;
                const filePath = this._getConstitutionPath(wr);
                const exists = fs.existsSync(filePath);
                const store = this._context.globalState;
                const plannerConfig = store.get<any>('switchboard.prompts.roleConfig_planner', undefined);
                const cfgDefault = this._seams().pathConfig.getConfigBoolean('planner.constitutionEnabled', false);
                const enabled = plannerConfig?.addons?.constitution ?? cfgDefault;
                let status = 'None';
                if (enabled && exists) { status = path.basename(filePath); }
                else if (enabled) { status = 'File not found'; }
                else { status = 'Disabled'; }
                const res = { type: 'constitutionStatus', status, planFile: msg.planFile, enabled, workspaceRoot: wr };
                this.postMessageToProjectWebview(res);
                return { success: true, ...res };
            }
            case 'readConstitutionFile': {
                const wsRoot = msg.workspaceRoot;
                const key = msg.governanceFile ?? 'constitution';
                if (!allRoots.includes(wsRoot)) {
                    const errRes = {
                        type: 'constitutionFileRead',
                        workspaceRoot: wsRoot,
                        governanceFile: key,
                        exists: false,
                        error: 'Invalid workspace root'
                    };
                    this._postToBothPanels(errRes);
                    return { ...errRes, success: false };
                }
                const filePath = this._getGovernanceFilePath(wsRoot, key);
                if (fs.existsSync(filePath)) {
                    try {
                        const content = fs.readFileSync(filePath, 'utf8');
                        const renderedHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', content);
                        const okRes = {
                            type: 'constitutionFileRead',
                            workspaceRoot: wsRoot,
                            governanceFile: key,
                            filePath,
                            exists: true,
                            content,
                            renderedHtml
                        };
                        this._postToBothPanels(okRes);
                        return { ...okRes, success: true };
                    } catch (err) {
                        const errRes = {
                            type: 'constitutionFileRead',
                            workspaceRoot: wsRoot,
                            governanceFile: key,
                            exists: false,
                            error: String(err)
                        };
                        this._postToBothPanels(errRes);
                        return { ...errRes, success: false };
                    }
                } else {
                    const res = {
                        type: 'constitutionFileRead',
                        workspaceRoot: wsRoot,
                        governanceFile: key,
                        exists: false
                    };
                    this._postToBothPanels(res);
                    return { ...res, success: true };
                }
            }
            case 'saveConstitutionFile': {
                const wsRoot = msg.workspaceRoot;
                const content = msg.content;
                const key = msg.governanceFile ?? 'constitution';
                const mode = msg.mode; // replace or append
                if (!allRoots.includes(wsRoot)) {
                    this._postToBothPanels({
                        type: 'fileSaved',
                        success: false,
                        error: 'Invalid workspace root',
                        tab: 'constitution',
                        governanceFile: key
                    });
                    break;
                }
                const filePath = this._getGovernanceFilePath(wsRoot, key);
                try {
                    let finalContent = content;
                    if (fs.existsSync(filePath)) {
                        if (mode === 'append') {
                            const original = fs.readFileSync(filePath, 'utf8');
                            const dateStr = new Date().toISOString().slice(0, 10);
                            finalContent = original + `\n\n## Imported from docs (${dateStr})\n\n` + content;
                        } else if (mode === 'replace') {
                            // Backup chaining
                            let backupPath = filePath + '.bak';
                            let counter = 1;
                            while (fs.existsSync(backupPath)) {
                                backupPath = filePath + `.bak.${counter}`;
                                counter++;
                            }
                            fs.writeFileSync(backupPath, fs.readFileSync(filePath, 'utf8'), 'utf8');
                        }
                    }
                    fs.writeFileSync(filePath, finalContent, 'utf8');
                    this._postToBothPanels({
                        type: 'fileSaved',
                        success: true,
                        tab: 'constitution',
                        governanceFile: key
                    });
                    // Only the constitution participates in project-context sync
                    // (CLAUDE.md/AGENTS.md are local agent governance, not remote context).
                    await this._handleMessage({ type: 'loadConstitutionFiles', requestId: Date.now() }, true);
                } catch (err) {
                    this._postToBothPanels({
                        type: 'fileSaved',
                        success: false,
                        error: String(err),
                        tab: 'constitution',
                        governanceFile: key
                    });
                }
                break;
            }
            // ── Per-project PRDs (Projects tab) ─────────────────────────────────────────
            // PRD authoring lives in this Project panel (next to the constitution editor),
            // not the kanban board. The dispatch-path resolvers stay in KanbanProvider; the
            // toggle is read/written via its public getProjectContextEnabled/setProjectContextEnabled.
            case 'getProjectContextEnabled': {
                // Hydrate the PROJECT CONTEXT toggle for the workspace the Projects tab edits.
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const enabled = (wsRoot && this._kanbanProvider)
                    ? await this._kanbanProvider.getProjectContextEnabled(wsRoot)
                    : false;
                const okRes = { type: 'projectContextEnabled', enabled, workspaceRoot: wsRoot };
                this._postToBothPanels(okRes);
                return { success: true, ...okRes };
            }
            case 'setProjectContextEnabled': {
                // Per-project PRD master toggle (per-workspace). KanbanProvider's dispatch path
                // reads this same config, so a write here governs whether the active project's
                // PRD is injected into future dispatched prompts. Confirm state back to the webview.
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (wsRoot) {
                    await this._kanbanProvider?.setProjectContextEnabled(wsRoot, !!msg.enabled);
                }
                this.postMessageToProjectWebview({ type: 'projectContextEnabled', enabled: !!msg.enabled, workspaceRoot: wsRoot });
                break;
            }
            case 'getProjectPrd': {
                // Read a project's PRD file for the Projects-tab editor.
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (wsRoot && typeof msg.projectName === 'string') {
                    const filePath = getProjectPrdPath(wsRoot, msg.projectName);
                    let rawContent = '';
                    let exists = false;
                    try {
                        if (fs.existsSync(filePath)) {
                            rawContent = await fs.promises.readFile(filePath, 'utf8');
                            exists = true;
                        }
                    } catch { /* non-fatal */ }
                    // Render markdown to HTML for the preview pane (mirrors kanbanPlanPreviewReady).
                    let renderedHtml = '';
                    try {
                        renderedHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', rawContent) ?? '';
                    } catch { renderedHtml = ''; }
                    const res = {
                        type: 'projectPrdContent',
                        projectName: msg.projectName,
                        workspaceRoot: wsRoot,
                        content: renderedHtml,    // HTML for preview pane
                        rawContent,               // raw markdown for editor
                        exists,
                        path: filePath
                    };
                    this._postToBothPanels(res);
                    return { ...res, success: true };
                }
                return { success: false, error: 'Missing workspaceRoot or projectName' };
            }
            case 'saveProjectPrd': {
                // Write a project's PRD file (creating .switchboard/projects/<slug>/).
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const mode = msg.mode; // replace or append
                if (wsRoot && typeof msg.projectName === 'string' && typeof msg.content === 'string') {
                    const filePath = getProjectPrdPath(wsRoot, msg.projectName);
                    let ok = false;
                    try {
                        let finalContent = msg.content;
                        if (fs.existsSync(filePath)) {
                            if (mode === 'append') {
                                const original = fs.readFileSync(filePath, 'utf8');
                                const dateStr = new Date().toISOString().slice(0, 10);
                                finalContent = original + `\n\n## Imported from docs (${dateStr})\n\n` + msg.content;
                            } else if (mode === 'replace') {
                                // Backup chaining
                                let backupPath = filePath + '.bak';
                                let counter = 1;
                                while (fs.existsSync(backupPath)) {
                                    backupPath = filePath + `.bak.${counter}`;
                                    counter++;
                                }
                                fs.writeFileSync(backupPath, fs.readFileSync(filePath, 'utf8'), 'utf8');
                            }
                        }
                        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
                        await fs.promises.writeFile(filePath, finalContent, 'utf8');
                        ok = true;
                    } catch (err) {
                        console.error('[PlanningPanelProvider] Failed to save project PRD:', err);
                    }
                    this._postToBothPanels({
                        type: 'projectPrdSaved',
                        projectName: msg.projectName,
                        ok,
                        path: filePath
                    });
                }
                break;
            }
            case 'invokePrdBuilder': {
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!wsRoot || typeof msg.projectName !== 'string') { break; }
                const projectName = msg.projectName;
                const promptText = buildPrdBuilderPrompt(projectName, wsRoot);
                if (this._taskViewerProvider) {
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole(
                        'planner', promptText, wsRoot
                    );
                    if (dispatched) { return { success: true }; }
                }
                const sent = await this._sendPromptToTerminal(
                    promptText, wsRoot, 'PRD Builder', ['planner', 'lead'],
                    { role: 'planner' }
                );
                if (!sent) {
                    return { success: false, error: 'No planner terminal could be reached — prompt copied to clipboard instead.', prompt: promptText };
                }
                return { success: true };
            }
            case 'copyPrdBuildPrompt': {
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!wsRoot || typeof msg.projectName !== 'string') { break; }
                const projectName = msg.projectName;
                const promptText = buildPrdBuilderPrompt(projectName, wsRoot);
                await this._seams().clipboard.writeText(promptText);
                this.postMessageToProjectWebview({ type: 'prdPromptCopied' });
                break;
            }
            case 'toggleConstitutionAddon': {
                const store = this._context.globalState;
                const plannerConfig = store.get<any>('switchboard.prompts.roleConfig_planner', {}) || {};
                plannerConfig.addons = plannerConfig.addons || {};
                plannerConfig.addons.constitution = !!msg.enabled;
                await store.update('switchboard.prompts.roleConfig_planner', plannerConfig);
                this.postMessageToProjectWebview({ type: 'constitutionAddonState', enabled: !!msg.enabled });
                break;
            }
            case 'copyConstitutionPrompt': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) { break; }
                const promptText = `Please act as a system architect. I want to build a Project Constitution for the project at workspace root ${wsRoot}.
A project constitution is a lean, high-level intent document covering mission, target users, guiding principles, technical stack/constraints, and non-goals. It is not a coding-standards doc.

Please ask me the following questions one by one or help me draft it:
1. Mission: What is the name of this project, and in one sentence, what is its primary reason for existing?
2. Target Users: Who are the primary users, and what is their main pain point?
3. Guiding Principles: What are the 3-5 non-negotiable values that should govern every technical and product decision? Give each a short name and one concrete sentence explaining what it means in practice.
4. Technical Constraints: What are the hard technical boundaries? List required languages, core frameworks, data stores, and key third-party services.
5. Non-Goals: What are specific things this project will NOT do in its current scope?

Please format the output document strictly as follows:
# [Project Name] Constitution

> **Mission:** [one sentence]

## Guiding Principles
- **[Name]:** [concrete explanation]

## Target Users
[Who they are and their main pain point]

## Technical Constraints & Stack
- Core Language & Frameworks: ...
- Data Layer: ...
- Key External Services: ...

## Non-Goals
- [Explicit exclusion 1]
- [Explicit exclusion 2]
`;
                await this._seams().clipboard.writeText(promptText);
                this.postMessageToProjectWebview({ type: 'constitutionPromptCopied' });
                break;
            }
            case 'copyConstitutionUpdatePrompt': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) { break; }
                const filePath = this._getConstitutionPath(wsRoot);
                let currentContent = '';
                if (fs.existsSync(filePath)) {
                    currentContent = fs.readFileSync(filePath, 'utf8');
                }
                const promptText = `Please act as a system architect. I want to review and update the existing Project Constitution for the project at workspace root ${wsRoot}.
Here is the current constitution content:
\`\`\`markdown
${currentContent}
\`\`\`

A project constitution is a lean, high-level intent document covering mission, target users, guiding principles, technical stack/constraints, and non-goals.
Please review it and guide me through improving and extending it based on the following questions:
1. Mission: What is the name of this project, and in one sentence, what is its primary reason for existing?
2. Target Users: Who are the primary users, and what is their main pain point?
3. Guiding Principles: What are the 3-5 non-negotiable values that should govern every technical and product decision? Give each a short name and one concrete sentence explaining what it means in practice.
4. Technical Constraints: What are the hard technical boundaries? List required languages, core frameworks, data stores, and key third-party services.
5. Non-Goals: What are specific things this project will NOT do in its current scope?

Please format the updated output document strictly as follows:
# [Project Name] Constitution

> **Mission:** [one sentence]

## Guiding Principles
- **[Name]:** [concrete explanation]

## Target Users
[Who they are and their main pain point]

## Technical Constraints & Stack
- Core Language & Frameworks: ...
- Data Layer: ...
- Key External Services: ...

## Non-Goals
- [Explicit exclusion 1]
- [Explicit exclusion 2]
`;
                await this._seams().clipboard.writeText(promptText);
                this.postMessageToProjectWebview({ type: 'constitutionPromptCopied' }); // reuse copied notification
                break;
            }
            case 'invokeConstitutionBuilder': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) {
                    break;
                }
                const promptText = `Follow instructions in .switchboard/protocols/constitution-builder/SKILL.md to build or improve CONSTITUTION.md in this project.`;
                // Try dispatching via the planner role (gets rotation for free).
                // Fall back to ad-hoc terminal creation if no planner agent is registered.
                if (this._taskViewerProvider) {
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole(
                        'planner', promptText, wsRoot
                    );
                    if (dispatched) { return { success: true }; }
                }
                const sent = await this._sendPromptToTerminal(
                    promptText, wsRoot, 'Constitution Builder', ['planner', 'lead'],
                    { role: 'planner' }
                );
                if (!sent) {
                    return { success: false, error: 'No planner terminal could be reached — prompt copied to clipboard instead.', prompt: promptText };
                }
                return { success: true };
            }
            case 'invokeConstitutionUpdater': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) {
                    break;
                }
                const promptText = `Follow instructions in .switchboard/protocols/constitution-builder/SKILL.md to improve and update the existing CONSTITUTION.md in this project.`;
                if (this._taskViewerProvider) {
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole(
                        'planner', promptText, wsRoot
                    );
                    if (dispatched) { return { success: true }; }
                }
                const sent = await this._sendPromptToTerminal(
                    promptText, wsRoot, 'Constitution Builder', ['planner', 'lead'],
                    { role: 'planner' }
                );
                if (!sent) {
                    return { success: false, error: 'No planner terminal could be reached — prompt copied to clipboard instead.', prompt: promptText };
                }
                return { success: true };
            }
            case 'invokeSystemBuilder': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) { break; }
                const key = msg.governanceFile === 'agents' ? 'agents' : 'claude';
                const filename = key === 'agents' ? 'AGENTS.md' : 'CLAUDE.md';
                const audience = key === 'agents'
                    ? 'coding agents working in this repository'
                    : 'Claude Code and other AI assistants working in this repository';
                const promptText =
                    `Inspect this codebase, then create a ${filename} file at the project root for ${audience}. ` +
                    `Document: a concise architecture overview, the key build/test/lint commands, the directory layout, ` +
                    `and any project-specific conventions or gotchas an agent must follow. Keep it tight and high-signal.`;
                if (this._taskViewerProvider) {
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole(
                        'planner', promptText, wsRoot
                    );
                    if (dispatched) { return { success: true }; }
                }
                const sent = await this._sendPromptToTerminal(
                    promptText, wsRoot, 'System Builder', ['planner', 'lead'],
                    { role: 'planner' }
                );
                if (!sent) {
                    return { success: false, error: 'No planner terminal could be reached — prompt copied to clipboard instead.', prompt: promptText };
                }
                return { success: true };
            }
            case 'copySystemBuildPrompt': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) { break; }
                const key = msg.governanceFile === 'agents' ? 'agents' : 'claude';
                const filename = key === 'agents' ? 'AGENTS.md' : 'CLAUDE.md';
                const audience = key === 'agents'
                    ? 'coding agents working in this repository'
                    : 'Claude Code and other AI assistants working in this repository';
                const promptText =
                    `Inspect the codebase at ${wsRoot}, then create a ${filename} file at its root for ${audience}.\n` +
                    `Include:\n` +
                    `1. A concise architecture overview (what the project is, main components).\n` +
                    `2. Key commands: build, test, lint, run.\n` +
                    `3. Directory layout — where the important code lives.\n` +
                    `4. Project-specific conventions, invariants, and gotchas an agent must respect.\n` +
                    `Keep it tight and high-signal; do not pad.`;
                await this._seams().clipboard.writeText(promptText);
                this.postMessageToProjectWebview({ type: 'systemPromptCopied' });
                break;
            }
            case 'openArchitectTerminal': {
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!wsRoot || !allRoots.includes(wsRoot)) {
                    break;
                }
                const promptText = this.buildArchitectPrompt(wsRoot);

                // Try dispatching via the planner role (gets rotation for free).
                // Fall back to ad-hoc terminal creation if no planner agent is registered.
                if (this._taskViewerProvider) {
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole(
                        'planner', promptText, wsRoot
                    );
                    if (dispatched) { return { success: true }; }
                }

                // Fall back to ad-hoc terminal creation
                const sent = await this._sendPromptToTerminal(
                    promptText, wsRoot, 'Switchboard Architect', ['architect', 'planner'],
                    { role: 'architect' }
                );
                if (!sent) {
                    return { success: false, error: 'No architect terminal could be reached — prompt copied to clipboard instead.', prompt: promptText };
                }
                return { success: true };
            }

            case 'copyArchitectPrompt': {
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!wsRoot || !allRoots.includes(wsRoot)) {
                    break;
                }
                const promptText = this.buildArchitectPrompt(wsRoot);
                await this._seams().clipboard.writeText(promptText);
                this.postMessageToProjectWebview({ type: 'architectPromptCopied' });
                break;
            }

            case 'deleteConstitutionFile': {
                const wsRoot = msg.workspaceRoot;
                const key = msg.governanceFile ?? 'constitution';
                if (!allRoots.includes(wsRoot)) { break; }
                const filePath = this._getGovernanceFilePath(wsRoot, key);
                try {
                    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
                    this.postMessageToProjectWebview({ type: 'constitutionFileDeleted', workspaceRoot: wsRoot, governanceFile: key });
                    await this._handleMessage({ type: 'loadConstitutionFiles', requestId: Date.now() }, true);
                } catch (err) {
                    this.postMessageToProjectWebview({ type: 'constitutionFileDeleted', workspaceRoot: wsRoot, governanceFile: key, success: false, error: String(err) });
                }
                break;
            }
            case 'getConstitutionPaths': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) { return { success: false, error: 'Invalid workspace root' }; }
                const res = {
                    type: 'constitutionPaths',
                    workspaceRoot: wsRoot,
                    paths: this._getConstitutionPathList(wsRoot),
                    active: this._activeConstitutionRel(wsRoot),
                };
                this.postMessageToProjectWebview(res);
                return { success: true, ...res };
            }
            case 'addConstitutionPath': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) { break; }
                const picked = await this._seams().ui.showOpenDialog({
                    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                    filters: { Markdown: ['md'] },
                    openLabel: 'Use as Constitution',
                });
                if (!picked || picked.length === 0) { break; }
                const abs = picked[0];
                const rel = path.relative(wsRoot, abs);
                if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.endsWith('.md')) {
                    this._seams().ui.showErrorMessage('Constitution file must be a .md file inside the workspace root.');
                    break;
                }
                const list = this._getConstitutionPathList(wsRoot);
                if (!list.includes(rel)) { list.push(rel); }
                await this._setConstitutionPathList(wsRoot, list);
                // Activate the newly added path (routes through existing validated handler + watcher refresh).
                await this._handleMessage({ type: 'setConstitutionPath', workspaceRoot: wsRoot, relativePath: rel }, true);
                this.postMessageToProjectWebview({
                    type: 'constitutionPaths', workspaceRoot: wsRoot,
                    paths: this._getConstitutionPathList(wsRoot), active: this._activeConstitutionRel(wsRoot),
                });
                break;
            }
            case 'removeConstitutionPath': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) { break; }
                const rel = String(msg.relativePath || '');
                let list = this._getConstitutionPathList(wsRoot).filter(p => p !== rel);
                if (list.length === 0) { list = ['CONSTITUTION.md']; }
                await this._setConstitutionPathList(wsRoot, list);
                // If we removed the active path, re-point active to the first remaining entry.
                if (this._activeConstitutionRel(wsRoot) === rel) {
                    await this._handleMessage({ type: 'setConstitutionPath', workspaceRoot: wsRoot, relativePath: list[0] }, true);
                }
                this.postMessageToProjectWebview({
                    type: 'constitutionPaths', workspaceRoot: wsRoot,
                    paths: this._getConstitutionPathList(wsRoot), active: this._activeConstitutionRel(wsRoot),
                });
                break;
            }
            case 'setConstitutionPath': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) { break; }
                const rel = msg.relativePath;
                if (typeof rel !== 'string' || !rel.endsWith('.md') || rel.includes('..') || path.isAbsolute(rel)) {
                    this._seams().ui.showErrorMessage('Invalid constitution path. Must be relative, end in .md, and remain inside the workspace root.');
                    break;
                }
                const store = this._context.globalState;
                const paths = store.get<Record<string, string>>('switchboard.constitutionPaths', {}) || {};
                paths[wsRoot] = rel;
                await store.update('switchboard.constitutionPaths', paths);

                // Load-bearing append to keep the active path in the candidate list
                const list = this._getConstitutionPathList(wsRoot);
                if (!list.includes(rel)) {
                    list.push(rel);
                    await this._setConstitutionPathList(wsRoot, list);
                }

                // Update the file watcher
                this._setupConstitutionWatcher();

                // Re-read file and load
                await this._handleMessage({ type: 'readConstitutionFile', workspaceRoot: wsRoot }, true);
                await this._handleMessage({ type: 'loadConstitutionFiles', requestId: Date.now() }, true);
                // Refresh the Manage Paths modal + sidebar active-path button so the
                // "(active)" marker and sidebar label update after an Activate click.
                // (addConstitutionPath/removeConstitutionPath also broadcast after their
                //  inner setConstitutionPath call; the duplicate is idempotent and harmless.)
                this.postMessageToProjectWebview({
                    type: 'constitutionPaths', workspaceRoot: wsRoot,
                    paths: this._getConstitutionPathList(wsRoot), active: this._activeConstitutionRel(wsRoot),
                });
                break;
            }
            case 'saveFileContent': {
                const filePath = String(msg.filePath || '');
                const content = String(msg.content || '');
                const originalContent = String(msg.originalContent || '');
                const tab = String(msg.tab || '');
                const allRoots = this._getWorkspaceRoots();
                const saveDestPanel = (tab === 'kanban' || tab === 'constitution' || tab === 'features') ? this._projectPanel : this._panel;
                let resolved: string;
                if (!path.isAbsolute(filePath)) {
                    const wsRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);
                    if (wsRoot) {
                        resolved = path.resolve(wsRoot, filePath);
                    } else {
                        this._pushTo(saveDestPanel, 'planning', { type: 'saveFileContentResult', success: false, error: 'No workspace root to resolve relative path', tab });
                        break;
                    }
                } else {
                    resolved = path.resolve(filePath);
                }
                let isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
                if (!isAllowed) {
                    for (const r of allRoots) {
                        try {
                            const service = this._getLocalFolderService(r);
                            const allAllowedPaths = [
                                ...service.getFolderPaths(),
                                ...service.getDesignFolderPaths(),
                                ...service.getHtmlFolderPaths()
                            ];
                            if (allAllowedPaths.some(dp => resolved.startsWith(path.resolve(dp)))) {
                                isAllowed = true;
                                break;
                            }
                        } catch (err) {}
                    }
                }
                if (!filePath || !isAllowed) {
                    this._pushTo(saveDestPanel, 'planning', { type: 'saveFileContentResult', success: false, error: 'Invalid file path', tab });
                    break;
                }
                try {
                    // Conflict detection: compare disk content with original
                    let diskContent = '';
                    if (fs.existsSync(resolved)) {
                        diskContent = await fs.promises.readFile(resolved, 'utf8');
                    }
                    if (originalContent && diskContent !== originalContent) {
                        this._pushTo(saveDestPanel, 'planning', { type: 'saveFileContentResult', success: false, conflict: true, diskContent, tab });
                        break;
                    }

                    // Validate JSON/YAML before write
                    const saveExt = path.extname(resolved).toLowerCase();
                    if (saveExt === '.json') {
                        try { JSON.parse(content); }
                        catch (e: any) {
                            this._pushTo(saveDestPanel, 'planning', {
                                type: 'saveFileContentResult',
                                success: false,
                                error: `Invalid JSON: ${e.message}`,
                                tab
                            });
                            break;
                        }
                    }
                    if (saveExt === '.yaml' || saveExt === '.yml') {
                        const yaml = require('js-yaml');
                        try { yaml.load(content); }
                        catch (e: any) {
                            this._pushTo(saveDestPanel, 'planning', {
                                type: 'saveFileContentResult',
                                success: false,
                                error: `Invalid YAML: ${e.message}`,
                                tab
                            });
                            break;
                        }
                    }

                    this._lastPanelWriteTimestamp = Date.now();
                    await fs.promises.writeFile(resolved, content, 'utf8');

                    // Rename plan file if the H1 has changed and produces a different slug
                    let renamedTo: string | undefined;
                    let renameWsRoot: string | undefined;  // track which workspace root was used for the rename
                    if (tab === 'kanban' || tab === 'features') {
                        try {
                            const currentBasename = path.basename(resolved);
                            // Only auto-rename files that follow the feature_plan_<YYYYMMDD>_<HHMMSS>_<slug>.md
                            // convention. Feature files use hyphen slugs (.switchboard/features/<slug>.md) and legacy
                            // hand-named plans do NOT round-trip through the slug logic — renaming them produces
                            // a corrupt `feature_plan__<slug>.md` (empty timestamp) and desyncs the preview path.
                            const isTimestampedPlan = /^feature_plan_\d{8}_\d{6}_/.test(currentBasename);
                            const h1Match = content.match(/^#\s+(.+)$/m);
                            const h1Title = h1Match ? h1Match[1].trim() : '';
                            if (isTimestampedPlan && h1Title) {
                                // Generate the slug the file *should* have
                                // TODO: extract to shared PlanSlug utility — duplicated from _toPlanSlug() in TaskViewerProvider.ts:15387
                                const newSlug = h1Title
                                    .toLowerCase()
                                    .replace(/[^a-z0-9]+/g, '_')
                                    .replace(/^_+|_+$/g, '') || 'new_plan';
                                const currentSlug = currentBasename.replace(/^feature_plan_\d{8}_\d{6}_/, '').replace(/\.md$/, '');
                                if (newSlug !== currentSlug) {
                                    const timestamp = currentBasename.match(/^feature_plan_(\d{8}_\d{6})_/)?.[1] || '';
                                    const newBasename = `feature_plan_${timestamp}_${newSlug}.md`;
                                    const newPath = path.join(path.dirname(resolved), newBasename);
                                    // Try rename directly — if target exists (collision), rename throws and is caught.
                                    // This matches the established pattern in extension.ts:3068 (no existsSync pre-check).
                                    await fs.promises.rename(resolved, newPath);
                                    renamedTo = newPath;
                                    // Update kanban DB if available
                                    const wsRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);
                                    renameWsRoot = wsRoot;
                                    if (wsRoot) {
                                        const db = KanbanDatabase.forWorkspace(wsRoot);
                                        if (await db.ensureReady()) {
                                            const oldRelative = path.relative(wsRoot, resolved).replace(/\\/g, '/');
                                            const newRelative = path.relative(wsRoot, newPath).replace(/\\/g, '/');
                                            const plan = await db.getPlanByPlanFile(oldRelative, await db.getWorkspaceId() || '');
                                            if (plan) {
                                                await db.updatePlanFile(plan.sessionId, newRelative);
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (renameErr) {
                            // Rename failure is non-fatal — the content was already saved to the original path.
                            // Common causes: target file exists (collision), cross-device rename, file locked.
                            renamedTo = undefined;  // ensure we don't report a rename that didn't happen
                            console.error('[PlanningPanelProvider] Plan rename on save failed:', renameErr);
                        }
                    }

                    this._pushTo(saveDestPanel, 'planning', {
                        type: 'saveFileContentResult',
                        success: true,
                        tab,
                        // Use renameWsRoot (the root used for the DB lookup), NOT this._getWorkspaceRoot().
                        // In multi-root workspaces _getWorkspaceRoot() can be undefined → absolute path → DB mismatch.
                        renamedFilePath: renamedTo && renameWsRoot
                            ? path.relative(renameWsRoot, renamedTo).replace(/\\/g, '/')
                            : undefined
                    });
                } catch (err) {
                    this._pushTo(saveDestPanel, 'planning', { type: 'saveFileContentResult', success: false, error: String(err), tab });
                }
                break;
            }
            // ── 2b: linearLoadProject, linearLoadProjects moved to
            // TicketsPanelProvider. ──
            // ── 2d: linearLoadTaskDetails, clickupLoadTaskDetails,
            //    linearUpdateIssueLabels, clickupUpdateTaskTags,
            //    loadTicketAssignees, loadTicketMembers,
            //    linearUpdateIssueAssignee, clickupUpdateTaskAssignees,
            //    linearUpdateIssuePriority, clickupUpdateTaskPriority
            //    moved to TicketsPanelProvider. ──

            case 'linearLoadAutomationCatalog': {
                return await handleLinearLoadAutomationCatalog(
                    this._sharedUtilityDeps(m => this.postMessageToWebview(m)), msg
                );
            }
            // ── 2b: clickupLoadSpaceTags, clickupLoadListStatuses,
            // clickupSaveSpaceSelection, clickupSaveFolderSelection,
            // clickupSaveListSelection moved to TicketsPanelProvider. ──

            // ── 2f: linearImportTask, clickupImportTask, importAllTickets moved to
            //    TicketsPanelProvider (handlers + allowlist + schemas). ──
            // ── 2c: refreshTicketsDelta moved to TicketsPanelProvider. ──
            case 'openTicketsPanel': {
                // Cross-panel switch. planning.js coerces a 'tickets' tab request to
                // 'docs' (no blank panel) and posts this so the real panel opens.
                // Currently defensive: the Artifacts panel persists no active tab, and
                // planning.html no longer carries a tickets button, so nothing reaches
                // it today — but an unrouted post is a dead end, so it is wired.
                await this._seams().commands.executeCommand('switchboard.openTicketsPanel');
                return { success: true };
            }
            case 'openExternalUrl': {
                await handleOpenExternalUrl(this._sharedUtilityDeps(m => this.postMessageToWebview(m)), msg);
                break;
            }
            // ── 2c: saveLocalTicketFile moved to TicketsPanelProvider. ──
            // ── 2d: editTicket, pushTicket, deleteTicketConfirmed
            //    moved to TicketsPanelProvider. ──
            // ── 2c: listLocalTicketFiles + getTicketSyncStatuses + readLocalTicketFile
            //    moved to TicketsPanelProvider. ──
            // ── 2e: ticketAttachImage moved to TicketsPanelProvider. ──
            // ── 2d: importTicketSubtasks moved to TicketsPanelProvider. ──
            // ── 2f: syncAllTickets moved to TicketsPanelProvider. ──
            case 'copyToClipboard': {
                await handleCopyToClipboard(this._sharedUtilityDeps(m => this.postMessageToWebview(m)), msg);
                break;
            }
            case 'copyDiagramPrompt': {
                await handleCopyDiagramPrompt(this._sharedUtilityDeps(m => this.postMessageToWebview(m)), msg);
                break;
            }
            // ── 2d: fetchMoveTargets, moveTicket moved to TicketsPanelProvider. ──
            case 'improveFeature': {
                try {
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    const { planFile, subtaskCount } = msg;
                    if (!workspaceRoot || !planFile) {
                        this._seams().ui.showErrorMessage('Missing workspace or feature file for improve prompt');
                        break;
                    }

                    // Context-aware skill selection:
                    // - subtaskCount > 0 → improve-feature/SKILL.md (destructive
                    //   reconcile/restructure of existing subtasks).
                    // - subtaskCount === 0 → refine_feature.md (non-destructive
                    //   fleshing-out of a thin feature + proposed subtask breakdown).
                    // The button label is "Improve" in both cases; the backend picks
                    // the right skill silently.
                    const hasSubtasks = (typeof subtaskCount === 'number' ? subtaskCount : 0) > 0;
                    const skillRelPath = hasSubtasks
                        ? path.join('.switchboard', 'protocols', 'improve-feature', 'SKILL.md')
                        : path.join('.switchboard', 'protocols', 'refine_feature.md');
                    const skillRelPathLegacy = hasSubtasks
                        ? path.join('.agent', 'skills', 'improve-feature', 'SKILL.md')
                        : path.join('.agent', 'skills', 'refine_feature.md');
                    const fallbackContent = hasSubtasks
                        ? `Improve this feature: reconcile and restructure its subtasks — improve each subtask, then merge/delete/rewrite/split to make the set coherent. Preserve YAML frontmatter and the auto-generated <!-- BEGIN SUBTASKS --> block. Write the result back to the local file path provided.`
                        : `Refine this feature into a complete specification with a clear ## Goal, ## Success Criteria, ## Scope, ## Proposed Subtasks, and ## Risks / Open Questions. Preserve YAML frontmatter and the auto-generated <!-- BEGIN SUBTASKS --> block. Do not create kanban cards. Write the result back to the local file path provided.`;

                    const featureFilePath = path.isAbsolute(planFile) ? planFile : path.resolve(workspaceRoot, planFile);
                    let existingContent = '';
                    try { existingContent = (require('fs') as typeof import('fs')).readFileSync(featureFilePath, 'utf8'); } catch { /* file may not exist yet */ }

                    const spec: LauncherSpec = {
                        id: hasSubtasks ? 'feature-improve' : 'feature-refine',
                        label: hasSubtasks ? 'Improve a feature' : 'Refine a feature',
                        description: hasSubtasks
                            ? 'Reconcile and restructure a feature and its subtasks'
                            : 'Flesh out a thin feature into a complete, decomposable specification',
                        skillPaths: [skillRelPath, skillRelPathLegacy],
                        fallbackPrompt: fallbackContent,
                        targetKind: 'feature'
                    };

                    const res = composeExternalPrompt(spec, workspaceRoot, { absPath: featureFilePath, content: existingContent });
                    if (res.prompt) {
                        await this._seams().clipboard.writeText(res.prompt);
                        this._seams().ui.showTemporaryNotification('Improve-feature prompt copied to clipboard. Paste it into your agent.');
                    }
                    if (!res.resolvedSkillPath) {
                        console.warn(`[PlanningPanelProvider] improveFeature for '${planFile}': no skill file resolved from ${spec.skillPaths.join(', ')} — used the inline fallback prompt.`);
                    }
                    return { success: true, prompt: res.prompt, resolvedSkillPath: res.resolvedSkillPath };
                } catch (err) {
                    this._seams().ui.showErrorMessage(`Failed to copy improve-feature prompt: ${String(err)}`);
                    return { success: false, error: String(err) };
                }
            }
            // ── 2d: changeTicketStatus moved to TicketsPanelProvider. ──
            // ── 2e: postTicketComment, loadTicketComments, postTicketReply,
            //    downloadAttachment, viewAttachments, openAttachment,
            //    revealAttachment moved to TicketsPanelProvider. ──
            // ── 2f: clickupCreateTask, linearCreateIssue, ticketsAskAgent moved
            //    to TicketsPanelProvider (handlers + allowlist + schemas). ──
            case 'createOnlineDocument': {
                const sourceId = String(msg.sourceId || '').trim();
                let parentId = String(msg.parentId || '').trim() || undefined;
                let title = String(msg.title || '').trim();
                if (!sourceId) {
                    this.postMessageToWebview({ type: 'onlineDocCreated', success: false, error: 'Missing source' });
                    break;
                }
                try {
                    if (!parentId) {
                        const { configPath, config, sourceRoot } = await this._resolveSyncConfig();
                        parentId = config.uploadLocations?.[sourceId];
                        if (!parentId) {
                            // Show picker
                            const adapter = this._researchImportService.getAdapter(sourceId);
                            if (!adapter) {
                                this.postMessageToWebview({ type: 'onlineDocCreated', success: false, error: 'Adapter not available' });
                                break;
                            }
                            const containers = await adapter.listContainers();
                            if (!containers || containers.length === 0) {
                                this.postMessageToWebview({ type: 'onlineDocCreated', success: false, error: 'No containers available to create doc' });
                                break;
                            }
                            const pick = await this._seams().ui.showQuickPick(
                                containers.map(c => ({ label: c.name, description: c.id, value: c.id })),
                                { placeHolder: `Choose a location for new ${sourceId} document` }
                            ) as { label: string; description?: string; value: string } | undefined;
                            if (!pick) {
                                this.postMessageToWebview({ type: 'onlineDocCreated', success: false, error: 'No location selected' });
                                break;
                            }
                            parentId = pick.value;
                            // Save as upload location
                            if (configPath) {
                                const updated = { ...config, uploadLocations: { ...(config.uploadLocations || {}), [sourceId]: parentId as string } };
                                await fs.promises.writeFile(configPath, JSON.stringify(updated, null, 2));
                                this._resolvedConfigCache = { configPath, config: updated, sourceRoot };
                            }
                        }
                    }
                    if (!title) {
                        title = (await this._seams().ui.showInputBox({ prompt: 'Document title', placeHolder: 'Enter document title' })) || '';
                        if (!title) {
                            this.postMessageToWebview({ type: 'onlineDocCreated', success: false, error: 'No title provided' });
                            break;
                        }
                    }
                    const adapter = this._researchImportService.getAdapter(sourceId);
                    if (!adapter || !adapter.createDocument) {
                        this.postMessageToWebview({ type: 'onlineDocCreated', success: false, error: 'Adapter does not support document creation' });
                        break;
                    }
                    const result = await adapter.createDocument({ parentId, title });
                    if (result.success) {
                        // Auto-import the created doc so it is immediately editable,
                        // mirroring the Tickets tab's create-then-auto-import flow
                        // (clickupCreateTask → switchboard.importTaskAsDocument).
                        // Reuse _handleImportFullDoc wholesale to preserve the
                        // concurrency guard, duplicate check, and multi-page
                        // ClickUp subpage handling. Safe on a freshly-created
                        // empty doc: ClickUp/Linear fetchContent returns '' for
                        // empty content.
                        let autoImported = false;
                        if (result.docId) {
                            try {
                                const importRoot = this._resolveWorkspaceRoot(msg.workspaceRoot)
                                    || this._getWorkspaceRoot() || '';
                                if (importRoot) {
                                    await this._handleImportFullDoc(importRoot, sourceId, result.docId, title);
                                    autoImported = true;
                                }
                            } catch (importErr) {
                                console.error('[PlanningPanel] Created online doc but local import failed:', importErr);
                                // Don't fail the whole operation — the doc was created remotely.
                            }
                        }
                        // Refresh source
                        this._sendOnlineDocsReady();
                        await this._handleFetchImportedDocs(this._getWorkspaceRoot() || '');
                        this.postMessageToWebview({
                            type: 'onlineDocCreated',
                            success: true,
                            docId: result.docId,
                            url: result.url,
                            sourceId,
                            docName: title,
                            autoImported
                        });
                    } else {
                        this.postMessageToWebview({ type: 'onlineDocCreated', success: false, error: result.error || 'Creation failed' });
                    }
                } catch (err) {
                    this.postMessageToWebview({ type: 'onlineDocCreated', success: false, error: String(err) });
                }
                break;
            }
            case 'setUploadLocation': {
                const sourceId = String(msg.sourceId || '').trim();
                if (!sourceId) break;
                try {
                    const { configPath, config, sourceRoot } = await this._resolveSyncConfig();
                    const adapter = this._researchImportService.getAdapter(sourceId);
                    if (!adapter) break;
                    const containers = await adapter.listContainers();
                    if (!containers || containers.length === 0) break;
                    const pick = await this._seams().ui.showQuickPick(
                        containers.map(c => ({ label: c.name, description: c.id, value: c.id })),
                        { placeHolder: `Set upload location for ${sourceId}` }
                    ) as { label: string; description?: string; value: string } | undefined;
                    if (pick && configPath) {
                        const updated = { ...config, uploadLocations: { ...(config.uploadLocations || {}), [sourceId]: pick.value } };
                        await fs.promises.writeFile(configPath, JSON.stringify(updated, null, 2));
                        this._resolvedConfigCache = { configPath, config: updated, sourceRoot };
                        this.postMessageToWebview({ type: 'uploadLocationSet', sourceId, containerId: pick.value });
                    }
                } catch (err) {
                    console.error('[PlanningPanel] Failed to set upload location:', err);
                }
                break;
            }
            case 'syncDocToOnline': {
                const localDocPath = String(msg.localDocPath || '');
                const sourceId = String(msg.sourceId || '');
                const parentId = String(msg.parentId || '').trim() || undefined;
                const mode = msg.mode === 'update' ? 'update' : 'create';
                const rememberLocation = Boolean(msg.rememberLocation);
                const docName = String(msg.docName || '');
                if (!localDocPath || !sourceId) {
                    this.postMessageToWebview({ type: 'syncToOnlineResult', success: false, error: 'Missing local doc path or source' });
                    break;
                }
                try {
                    const content = await fs.promises.readFile(localDocPath, 'utf8');
                    const { configPath, config, sourceRoot } = await this._resolveSyncConfig();
                    const mappingKey = localDocPath;
                    const existingMapping = config.docMappings?.[mappingKey];

                    const adapter = this._researchImportService.getAdapter(sourceId);
                    if (!adapter) {
                        this.postMessageToWebview({ type: 'syncToOnlineResult', success: false, error: 'Adapter not available' });
                        break;
                    }

                    let result: { success: boolean; docId?: string; url?: string; error?: string };

                    if (mode === 'update' && existingMapping && existingMapping.sourceId === sourceId && adapter.updateContent) {
                        const updateResult = await adapter.updateContent(existingMapping.docId, content);
                        if (updateResult.success) {
                            result = { success: true, docId: existingMapping.docId, url: existingMapping.url };
                        } else {
                            result = { success: false, error: updateResult.error || 'Update failed' };
                        }
                    } else if (adapter.createDocument) {
                        const createResult = await adapter.createDocument({ parentId, title: docName || path.basename(localDocPath, '.md'), content });
                        result = createResult;
                    } else {
                        result = { success: false, error: 'Adapter does not support create/update' };
                    }

                    if (result.success && configPath) {
                        const updatedConfig = { ...config };
                        if (!updatedConfig.docMappings) updatedConfig.docMappings = {};
                        updatedConfig.docMappings[mappingKey] = { sourceId, docId: result.docId!, url: result.url };
                        if (rememberLocation && parentId) {
                            if (!updatedConfig.uploadLocations) updatedConfig.uploadLocations = {};
                            updatedConfig.uploadLocations[sourceId] = parentId;
                        }
                        await fs.promises.writeFile(configPath, JSON.stringify(updatedConfig, null, 2));
                        this._resolvedConfigCache = { configPath, config: updatedConfig, sourceRoot };
                    }

                    this.postMessageToWebview({ type: 'syncToOnlineResult', ...result });
                } catch (err) {
                    this.postMessageToWebview({ type: 'syncToOnlineResult', success: false, error: String(err) });
                }
                break;
            }
            case 'getSyncConfig': {
                try {
                    const { config } = await this._resolveSyncConfig();
                    const res = {
                        type: 'syncConfigReady',
                        uploadLocations: config.uploadLocations || {},
                        docMappings: config.docMappings || {}
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: true };
                } catch (err) {
                    const errRes = { type: 'syncConfigReady', uploadLocations: {}, docMappings: {} };
                    this.postMessageToWebview(errRes);
                    return { ...errRes, success: false };
                }
            }
            case 'loadInsights': {
                const wsRoot = String(msg.workspaceRoot || '');
                let insights: any[];
                if (wsRoot) {
                    insights = InsightManager.listInsights(wsRoot);
                } else {
                    const workspaceItems = buildWorkspaceItems(allRoots);
                    const allInsights: any[] = [];
                    for (const ws of workspaceItems) {
                        try {
                            const wsInsights = InsightManager.listInsights(ws.workspaceRoot);
                            allInsights.push(...wsInsights);
                        } catch (err) {
                            console.warn('[PlanningPanel] Failed to list insights for', ws.workspaceRoot, err);
                        }
                    }
                    insights = allInsights;
                }
                const res = { type: 'insightsLoaded', insights };
                this.postMessageToProjectWebview(res);
                return { success: true, ...res };
            }
            case 'readInsight': {
                const wsRoot = String(msg.workspaceRoot || '');
                const filename = String(msg.filename || '');
                if (!wsRoot || !filename) { return { success: false, error: 'Missing workspaceRoot or filename' }; }
                try {
                    const content = InsightManager.readInsight(wsRoot, filename);
                    if (content) {
                        const renderedHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', content);
                        const res = {
                            type: 'insightContent',
                            filename,
                            workspaceRoot: wsRoot,
                            content,
                            renderedHtml
                        };
                        this.postMessageToProjectWebview(res);
                        return { ...res, success: true };
                    }
                    return { success: true, type: 'insightContent', filename, workspaceRoot: wsRoot, content: '' };
                } catch (err) {
                    console.error('[PlanningPanel] Failed to read insight:', err);
                    return { success: false, error: String(err) };
                }
            }
            case 'runTuningExtract': {
                const wsRoot = String(msg.workspaceRoot || '');
                const planFiles = await this._resolveTuningPlanFiles(wsRoot, allRoots);
                if (planFiles.length === 0) {
                    this._seams().ui.showTemporaryNotification('No plans with adversarial review sections found.');
                    this.postMessageToProjectWebview({ type: 'tuningExtractComplete', planCount: 0 });
                    break;
                }
                const effectiveWsRoot = wsRoot || (allRoots.length > 0 ? allRoots[0] : '');
                let planFilesList: string;
                if (planFiles.length > 50) {
                    const insightsDir = InsightManager.getInsightsDirectory(effectiveWsRoot);
                    const now = Date.now();
                    try {
                        for (const f of fs.readdirSync(insightsDir)) {
                            if (!f.startsWith('_plan_list_') || !f.endsWith('.txt')) continue;
                            const fPath = path.join(insightsDir, f);
                            try {
                                const stat = fs.statSync(fPath);
                                if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
                                    fs.unlinkSync(fPath);
                                }
                            } catch {}
                        }
                    } catch {}
                    const tempPath = path.join(insightsDir, `_plan_list_${now}.txt`);
                    fs.writeFileSync(tempPath, planFiles.join('\n'), 'utf8');
                    planFilesList = `Plan list written to temp file: ${tempPath}`;
                } else {
                    planFilesList = planFiles.join('\n');
                }
                const extractPrompt = `Read and follow .switchboard/protocols/tuning/SKILL.md in extract mode for workspace: ${effectiveWsRoot}\n\nScan the following plan files for adversarial review sections ("Stage 1 — Grumpy Adversarial Findings" and "Stage 2 — Balanced Synthesis"):\n${planFilesList}\n\nFor each plan, extract the review findings. Then cluster recurring problem patterns across plans using these criteria:\n  - Same problem category (e.g., missing error handling, race conditions, prompt-design flaws, unvalidated assumptions)\n  - Same severity level (recurring vs critical vs minor)\n  - Same governance target (CONSTITUTION.md vs AGENTS.md vs CLAUDE.md)\nFor each distinct pattern, create an insight .md file in ${effectiveWsRoot}/.switchboard/insights/ using the insight template. If an existing insight covers the same pattern (same category AND similar description), append new evidence to it instead of creating a duplicate. When appending, update the Source Plans list and add new evidence entries.`;
                await this._seams().clipboard.writeText(extractPrompt);
                this._seams().ui.showTemporaryNotification('Tuning extract prompt copied to clipboard. Paste it into your agent chat.');
                this.postMessageToProjectWebview({ type: 'tuningExtractComplete', planCount: planFiles.length });
                break;
            }
            case 'runTuningGovernance': {
                const wsRoot = String(msg.workspaceRoot || '');
                const effectiveWsRoot = wsRoot || (allRoots.length > 0 ? allRoots[0] : '');
                const governancePrompt = `Read and follow .switchboard/protocols/tuning/SKILL.md in governance mode for workspace: ${effectiveWsRoot}\n\nRead all insight files in ${effectiveWsRoot}/.switchboard/insights/ with status 'open'. Review the insights and propose specific edits to governance files (CONSTITUTION.md, AGENTS.md, CLAUDE.md) to address the recurring patterns. Present proposed changes as diffs.`;
                await this._seams().clipboard.writeText(governancePrompt);
                this._seams().ui.showTemporaryNotification('Tuning governance prompt copied to clipboard. Paste it into your agent chat.');
                this.postMessageToProjectWebview({ type: 'tuningGovernanceComplete' });
                break;
            }
            case 'updateInsightStatus': {
                const wsRoot = String(msg.workspaceRoot || '');
                const filename = String(msg.filename || '');
                const newStatus = String(msg.status || '');
                if (!wsRoot || !filename || !newStatus) { break; }
                try {
                    InsightManager.updateInsightStatus(wsRoot, filename, newStatus);
                    const insights = InsightManager.listInsights(wsRoot);
                    this.postMessageToProjectWebview({ type: 'insightsLoaded', insights });
                } catch (err) {
                    console.error('[PlanningPanel] Failed to update insight status:', err);
                }
                break;
            }
            case 'deleteInsight': {
                const wsRoot = String(msg.workspaceRoot || '');
                const filename = String(msg.filename || '');
                if (!wsRoot || !filename) { break; }
                try {
                    InsightManager.deleteInsight(wsRoot, filename);
                    const insights = InsightManager.listInsights(wsRoot);
                    this.postMessageToProjectWebview({ type: 'insightsLoaded', insights });
                    this.postMessageToProjectWebview({ type: 'insightContent', filename: '', workspaceRoot: wsRoot, content: '' });
                } catch (err) {
                    console.error('[PlanningPanel] Failed to delete insight:', err);
                }
                break;
            }
            case 'copyInsightLink': {
                const link = String(msg.link || '');
                if (link) {
                    const linkRef = link;
                    await this._seams().clipboard.writeText(linkRef);
                    this.postMessageToProjectWebview({ type: 'insightLinkCopied' });
                }
                break;
            }
        }
        return { success: true };
    }


    private async _handleLinkToDocument(
        workspaceRoot: string,
        sourceId: string,
        docId: string,
        docName: string,
        sourceFolder?: string
    ): Promise<void> {
        try {
            // Source-agnostic: the frontend guard ensures sourceFolder is present
            // for every source that can fire Link Doc (local-folder, planning-html-folder).
            // Tree node ids are `${folderIndex}:${relativePath}` — strip the prefix.
            if (!sourceFolder) {
                throw new Error('sourceFolder is required');
            }
            const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
            const docPath = path.resolve(sourceFolder, cleanDocId);
            await this._seams().clipboard.writeText(docPath);
            this._seams().ui.showTemporaryNotification(`Document path copied to clipboard: ${docPath}`);
        } catch (err) {
            this._seams().ui.showErrorMessage(`Failed to link to document: ${String(err)}`);
        }
    }

    private async _handleLinkToFolder(
        workspaceRoot: string,
        folderPath: string
    ): Promise<void> {
        try {
            if (!folderPath) {
                throw new Error('No folder path provided');
            }

            // Build the allowed-folder set across ALL roots and BOTH folder kinds
            // (local docs folders + planning HTML source folders). The frontend sends
            // a bare absolute path with no owning-root hint, and the HTML tab's
            // "Link" buttons point at planning HTML source folders, which are NOT in
            // getFolderPaths(). Validating against a single root / single kind would
            // reject legitimate HTML folders (and folders from non-primary roots).
            // Mirrors DesignPanelProvider._handleLinkToFolder's root-agnostic approach.
            const allowedPaths: string[] = [];
            for (const root of this._getWorkspaceRoots()) {
                const svc = this._getLocalFolderService(root);
                allowedPaths.push(
                    ...svc.getFolderPaths(),
                    ...svc.getPlanningHtmlFolderPaths(),
                );
            }

            let resolvedFolder = '';

            if (/^\d+:/.test(folderPath)) {
                // Subfolder id `<index>:<relativePath>` — join against every allowed
                // base and take the first that exists on disk.
                const colonIdx = folderPath.indexOf(':');
                const relativePath = folderPath.substring(colonIdx + 1);
                let found = false;
                for (const base of allowedPaths) {
                    const candidate = path.join(base, relativePath);
                    if (fs.existsSync(candidate)) {
                        resolvedFolder = candidate;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    throw new Error('Subfolder not found');
                }
            } else {
                const localFolderService = this._getLocalFolderServiceForFolder(folderPath, workspaceRoot, 'local-folder')
                    || this._getLocalFolderService(workspaceRoot);
                resolvedFolder = localFolderService.resolveFolderPath(folderPath);
            }

            const isWithinAllowed = allowedPaths.some(p => resolvedFolder.startsWith(p + path.sep) || resolvedFolder === p);
            if (!isWithinAllowed) {
                throw new Error('Folder is not within a configured folder');
            }
            if (!fs.existsSync(resolvedFolder)) {
                throw new Error('Folder does not exist');
            }
            await this._seams().clipboard.writeText(resolvedFolder);
            this._seams().ui.showTemporaryNotification(`Folder path copied to clipboard: ${resolvedFolder}`);
        } catch (err) {
            this._seams().ui.showErrorMessage(`Failed to link to folder: ${String(err)}`);
        }
    }

    private async _handleCreateLocalDoc(
        workspaceRoot: string,
        folderPath: string,
        name?: string,
        description?: string,
        withAgent: boolean = false
    ): Promise<void> {
        try {
            // Webview-modal path: when `name` is supplied, the modal already
            // captured folder + name + description — skip the native prompts.
            // The no-`name` path below is retained as a safety-net fallback.
            let docName: string | undefined = typeof name === 'string' ? name : undefined;
            if (!folderPath) {
                // No active local folder — quick-pick among the configured folders
                // (all roots); with none configured, point at Manage Folders.
                const candidates: string[] = [];
                for (const root of this._getWorkspaceRoots()) {
                    for (const p of this._getLocalFolderService(root).getFolderPaths()) {
                        if (!candidates.includes(p)) { candidates.push(p); }
                    }
                }
                if (candidates.length === 0) {
                    this._seams().ui.showTemporaryNotification('Add a folder via Manage Folders first.');
                    return;
                }
                if (candidates.length === 1) {
                    folderPath = candidates[0];
                } else {
                    const picked = await this._seams().ui.showQuickPick(
                        candidates.map(p => ({ label: path.basename(p), description: p })),
                        { placeHolder: 'Select a folder for the new doc' }
                    ) as { label: string; description?: string } | undefined;
                    if (!picked?.description) { return; } // user cancelled
                    folderPath = picked.description;
                }
            }
            if (!docName) {
                docName = await this._seams().ui.showInputBox({
                    prompt: 'New document name',
                    placeHolder: 'e.g. my-plan.md',
                    validateInput: (value) => {
                        if (!value || !value.trim()) { return 'Name is required'; }
                        const sanitized = value.trim().replace(/[\\/:]/g, '').replace(/\.\./g, '');
                        if (!sanitized) { return 'Invalid name'; }
                        return undefined;
                    }
                });
                if (!docName) { return; }
            }

            let sanitized = docName.trim().replace(/[\\/:]/g, '').replace(/\.\./g, '');
            if (!sanitized.toLowerCase().endsWith('.md')) {
                sanitized += '.md';
            }

            let resolvedFolder = '';
            let docId = '';
            let localFolderService = this._getLocalFolderService(workspaceRoot);

            if (/^\d+:/.test(folderPath)) {
                const colonIdx = folderPath.indexOf(':');
                const folderIndex = parseInt(folderPath.substring(0, colonIdx), 10);
                const relativePath = folderPath.substring(colonIdx + 1);
                let found = false;
                for (const root of this._getWorkspaceRoots()) {
                    const service = this._getLocalFolderService(root);
                    const folderPaths = service.getFolderPaths();
                    if (folderIndex >= 0 && folderIndex < folderPaths.length) {
                        const candidate = path.join(folderPaths[folderIndex], relativePath);
                        if (fs.existsSync(candidate)) {
                            resolvedFolder = candidate;
                            localFolderService = service;
                            docId = `${folderIndex}:${path.join(relativePath, sanitized)}`;
                            found = true;
                            break;
                        }
                    }
                }
                if (!found) {
                    // Fallback to active root
                    const folderPaths = localFolderService.getFolderPaths();
                    if (folderIndex < 0 || folderIndex >= folderPaths.length) {
                        throw new Error('Invalid folder reference');
                    }
                    resolvedFolder = path.join(folderPaths[folderIndex], relativePath);
                    docId = `${folderIndex}:${path.join(relativePath, sanitized)}`;
                }
            } else {
                localFolderService = this._getLocalFolderServiceForFolder(folderPath, workspaceRoot, 'local-folder')
                    || this._getLocalFolderService(workspaceRoot);
                resolvedFolder = localFolderService.resolveFolderPath(folderPath);
                const allowedPaths = localFolderService.getFolderPaths();
                if (!allowedPaths.includes(resolvedFolder)) {
                    this._seams().ui.showErrorMessage('Folder is not a configured local docs folder');
                    return;
                }
                const folderIndex = allowedPaths.indexOf(resolvedFolder);
                docId = `${folderIndex}:${sanitized}`;
            }

            const filePath = path.join(resolvedFolder, sanitized);
            if (fs.existsSync(filePath)) {
                this._seams().ui.showErrorMessage(`A document named ${sanitized} already exists.`);
                return;
            }

            const title = sanitized.replace(/\.md$/i, '');
            const descTrimmed = typeof description === 'string' ? description.trim() : '';
            const stub = descTrimmed
                ? `# ${title}\n\n${descTrimmed}\n`
                : `# ${title}\n`;
            await fs.promises.writeFile(filePath, stub, 'utf8');

            this._lastLocalDocsSignature = '';
            await this._sendLocalDocsReady();
            this.postMessageToWebview({
                type: 'selectLocalDoc',
                docId,
                docName: sanitized
            });

            // Create with agent — copy the Draft/Improve prompt for the freshly
            // created file. A description seeds the "improve" variant; an empty
            // doc uses the "write from scratch" variant. The path was validated
            // above (configured-folder check), so call the builder directly.
            if (withAgent) {
                const wsRoot = workspaceRoot;
                const prompt = this._buildLocalDocDraftPrompt(filePath, title, wsRoot, !!descTrimmed, descTrimmed);
                await this._seams().clipboard.writeText(prompt);
                this._seams().ui.showTemporaryNotification('Doc prompt copied to clipboard');
            }
        } catch (err) {
            this._seams().ui.showErrorMessage(`Failed to create document: ${String(err)}`);
        }
    }

    /**
     * Build the Draft/Improve prompt for a local doc. Shared by the standalone
     * Draft-with-agent button (`draftImproveLocalDoc`) and the Create-with-agent
     * branch of `createLocalDoc` so the two produce byte-for-byte identical
     * prompts for the same inputs. Three branches preserved verbatim: large
     * (>200 KB), has-content, and empty.
     */
    private _buildLocalDocDraftPrompt(
        filePath: string,
        title: string,
        workspaceRoot: string,
        hasContent: boolean,
        currentContent: string
    ): string {
        if (hasContent && currentContent.length > 200_000) {
            return `You are improving an existing document for the project at ${workspaceRoot}.\n\n## Document\n- **Title:** ${title}\n- **File path (read the current doc here, and write the improved doc back here):** ${filePath}\n\nThe current content is large (>200 KB) and is not inlined here. Read the file at the path above, then fill gaps, correct anything out of date, and improve clarity and structure without discarding accurate existing material. Write the improved markdown back to the file path, preserving any YAML frontmatter. Report back with a summary of what you changed.`;
        } else if (hasContent) {
            return `You are improving an existing document for the project at ${workspaceRoot}.\n\n## Document\n- **Title:** ${title}\n- **File path (write the improved doc back here):** ${filePath}\n\n## Current content\n${currentContent}\n\nRead the current content above and the relevant parts of the codebase. Fill gaps, correct anything out of date, and improve clarity and structure without discarding accurate existing material. Write the improved markdown back to the file path, preserving any YAML frontmatter. Report back with a summary of what you changed.`;
        } else {
            return `You are writing a document for the project at ${workspaceRoot}.\n\n## Document\n- **Title:** ${title}\n- **File path (write the finished doc here):** ${filePath}\n\nThe file is currently empty (or contains only a title heading). Research the codebase as needed to write an accurate, useful document for this topic. Write the finished markdown directly to the file path above. Report back with a short summary of what you covered.`;
        }
    }

    /**
     * Enumerate the managed doc set for the Create Plans zip: constitution files,
     * every project PRD, the root README, and the curated Docs-tab folders.
     * Paths only — the bundler applies the docs-only (.md/.txt) allowlist.
     */
    /**
     * The zip's primary source: every doc in one user-chosen folder, walked
     * recursively (bounded depth). Switchboard does NOT decide the doc set — the
     * user points at a folder and gets its docs. Docs-only (.md/.txt); dotfiles
     * and node_modules are skipped so nothing but prose enters the bundle.
     */
    private async _collectFolderDocSources(folder: string): Promise<DocsBundleSource[]> {
        const sources: DocsBundleSource[] = [];
        const root = path.resolve(folder);
        const base = path.basename(root) || 'docs';
        const walk = async (dir: string, zipDir: string, depth: number): Promise<void> => {
            if (depth > 8) { return; }
            let entries: import('fs').Dirent[] = [];
            try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) as unknown as import('fs').Dirent[]; } catch { return; }
            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full, path.posix.join(zipDir, entry.name), depth + 1);
                } else if (['.md', '.txt'].includes(path.extname(entry.name).toLowerCase())) {
                    sources.push({ zipDir, absPath: full });
                }
            }
        };
        await walk(root, base, 0);
        return sources;
    }

    /**
     * The opt-in extras: the managed doc set (constitution + every project PRD +
     * root README). Added on top of the chosen folder only when the user ticks
     * "include extras" — never auto-scooped. No Docs-tab folder walk here.
     */
    private async _collectExtraDocSources(workspaceRoot: string): Promise<DocsBundleSource[]> {
        const sources: DocsBundleSource[] = [];
        const seen = new Set<string>();
        const add = (zipDir: string, absPath: string) => {
            const key = path.resolve(absPath);
            if (!seen.has(key) && fs.existsSync(key)) {
                seen.add(key);
                sources.push({ zipDir, absPath: key });
            }
        };

        // Constitution files (the configured list for this root).
        try {
            for (const rel of this._getConstitutionPathList(workspaceRoot)) {
                add('constitution', path.resolve(workspaceRoot, rel));
            }
        } catch { /* no constitution — fine */ }

        // Every project PRD: .switchboard/projects/<slug>/prd.md
        try {
            const projectsDir = path.join(workspaceRoot, '.switchboard', 'projects');
            for (const slug of await fs.promises.readdir(projectsDir)) {
                add(path.posix.join('prds', slug), path.join(projectsDir, slug, 'prd.md'));
            }
        } catch { /* no projects dir — fine */ }

        // Root README (any case variant).
        try {
            const rootEntries = await fs.promises.readdir(workspaceRoot);
            const readme = rootEntries.find((e: string) => e.toLowerCase() === 'readme.md');
            if (readme) { add('.', path.join(workspaceRoot, readme)); }
        } catch { /* root unreadable — fine */ }

        // Docs-only filter so hasDocs isn't fooled by non-doc files.
        return sources.filter(s => ['.md', '.txt'].includes(path.extname(s.absPath).toLowerCase()));
    }

    private async _handleResolveDuplicate(
        workspaceRoot: string,
        docName: string,
        sourceId: string,
        docId: string,
        action: 'skip' | 'replace' | 'rename'
    ): Promise<void> {
        try {
            if (action === 'skip') {
                this.postMessageToWebview({
                    type: 'duplicateResolved', success: true, message: 'Import skipped (duplicate)'
                });
                return;
            }

            if (action === 'replace') {
                // Remove existing import entry and file before re-importing
                if (this._cacheService) {
                    const workspaceId = await this._getWorkspaceId(workspaceRoot);
                    const existing = await this._cacheService.getImportByDocName(docName, workspaceId);
                    if (existing) {
                        await this._cacheService.removeImport(existing.slugPrefix, workspaceId);
                        // Delete the old file from .switchboard/docs/
                        try {
                            const resolvedPath = await this._cacheService.resolveImportedDocPath(existing.slugPrefix, workspaceId);
                            if (resolvedPath) {
                                await fs.promises.unlink(resolvedPath);
                            }
                        } catch { /* file may not exist */ }
                    }
                }
                // Re-import: the old registry entry is gone, so duplicate check won't trigger
                await this._handleImportFullDoc(workspaceRoot, sourceId, docId, docName);
                this.postMessageToWebview({
                    type: 'duplicateResolved', success: true, message: 'Replaced existing document'
                });
                return;
            }

            if (action === 'rename') {
                // Generate a unique name by appending a counter
                let newName = docName;
                let counter = 2;
                if (this._cacheService) {
                    const workspaceId = await this._getWorkspaceId(workspaceRoot);
                    while (true) {
                        const check = await this._cacheService.checkForDuplicate(newName, sourceId, workspaceId, docId);
                        if (!check.isDuplicate) break;
                        newName = `${docName} (${counter})`;
                        counter++;
                        if (counter > 100) {
                            this.postMessageToWebview({
                                type: 'duplicateResolved', success: false,
                                error: 'Could not generate a unique name (too many duplicates)'
                            });
                            return;
                        }
                    }
                }
                // Import with the new name; duplicate check passes because name is unique
                await this._handleImportFullDoc(workspaceRoot, sourceId, docId, newName);
                this.postMessageToWebview({
                    type: 'duplicateResolved', success: true, message: `Imported as "${newName}"`
                });
                return;
            }

            this.postMessageToWebview({
                type: 'duplicateResolved', success: false, error: 'Invalid action'
            });
        } catch (err) {
            this.postMessageToWebview({
                type: 'duplicateResolved', success: false, error: String(err)
            });
        }
    }

    private _updateWebviewRoots(): void {
        if (!this._panel && !this._projectPanel) { return; }
        const allRoots = this._getWorkspaceRoots();
        const folderUris: vscode.Uri[] = [];
        for (const r of allRoots) {
            try {
                const service = this._getLocalFolderService(r);
                for (const p of service.getFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
            } catch (err) {}
        }
        try {
            const clickupCfg = GlobalIntegrationConfigService.loadConfigSync('clickup');
            if (clickupCfg?.ticketSaveLocation) {
                folderUris.push(vscode.Uri.file(clickupCfg.ticketSaveLocation));
            }
        } catch {}
        try {
            const linearCfg = GlobalIntegrationConfigService.loadConfigSync('linear');
            if (linearCfg?.ticketSaveLocation) {
                folderUris.push(vscode.Uri.file(linearCfg.ticketSaveLocation));
            }
        } catch {}

        const localResourceRoots = [
            vscode.Uri.joinPath(this._extensionUri, 'dist'),
            vscode.Uri.joinPath(this._extensionUri, 'webview'),
            vscode.Uri.joinPath(this._extensionUri, 'designs'),
            vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
            ...allRoots.map(r => vscode.Uri.file(r)),
            ...folderUris
        ];

        // CRITICAL: assigning `webview.options` RELOADS the entire webview (resets the
        // DOM → default tab + "Loading…" placeholders). This is called on every docs
        // refresh, and the freshly-loaded webview re-posts `fetchRoots`, which calls
        // back here — an infinite reload loop (the ~500ms flicker). Only reassign when
        // the resource roots actually changed.
        const signature = JSON.stringify(localResourceRoots.map(u => u.toString()));
        if (signature === this._lastWebviewRootsSignature) { return; }
        this._lastWebviewRootsSignature = signature;

        if (this._panel) {
            this._panel.webview.options = {
                enableScripts: true,
                localResourceRoots
            };
        }
        if (this._projectPanel) {
            try {
                this._projectPanel.webview.options = {
                    enableScripts: true,
                    localResourceRoots
                };
            } catch {
                // Panel was disposed but reference wasn't cleared (e.g. planning panel
                // closed first, removing the onDidDispose listener that clears this).
                // Clear the stale reference so openProject() creates a fresh panel.
                this._projectPanel = undefined;
                this._projectPanelOpening = undefined;
                this._projectPanelRestoring = false;
            }
        }
    }

    private _getLocalFolderService(workspaceRoot: string): LocalFolderService {
        return new LocalFolderService(workspaceRoot);
    }

    /**
     * Find the LocalFolderService for the workspace root that has the given
     * sourceFolder configured. Prioritizes the active workspace root when
     * multiple roots configure the same folder path.
     */
    /**
     * Resolve which workspace root actually owns `folderPath`. Mirrors the scan order of
     * _getLocalFolderServiceForFolder (active root first, then all roots). Used by writers that
     * need the owning root (not just the service) — e.g. clipboard research import, which targets
     * a folder that may belong to a non-primary root in a multi-root workspace.
     * Falls back to `fallbackRoot` when the folder matches no configured root.
     */
    private _getWorkspaceRootForFolder(
        folderPath: string | undefined,
        fallbackRoot: string
    ): { root: string; resolvedFolder?: string } {
        if (!folderPath) { return { root: fallbackRoot }; }
        const allRoots = this._getWorkspaceRoots();
        const activeRoot = this._getWorkspaceRoot();
        const ordered = activeRoot
            ? [activeRoot, ...allRoots.filter(r => path.resolve(r) !== path.resolve(activeRoot))]
            : allRoots;
        for (const root of ordered) {
            const service = this._getLocalFolderService(root);
            const resolved = service.resolveFolderPath(folderPath);
            if (service.getFolderPaths().includes(resolved)) {
                return { root, resolvedFolder: resolved };
            }
        }
        return { root: fallbackRoot };
    }

    private _getLocalFolderServiceForFolder(
        sourceFolder: string | undefined,
        workspaceRoot: string,
        sourceId: 'local-folder' = 'local-folder'
    ): LocalFolderService | null {
        if (!sourceFolder) { return null; }
        const allRoots = this._getWorkspaceRoots();
        const activeRoot = this._getWorkspaceRoot();

        // Try active root first (matches existing priority logic)
        if (activeRoot) {
            const service = this._getLocalFolderService(activeRoot);
            const paths = service.getFolderPaths();
            const resolved = service.resolveFolderPath(sourceFolder);
            if (paths.includes(resolved)) {
                return service;
            }
        }

        // Fall back to scanning all roots
        for (const root of allRoots) {
            if (activeRoot && path.resolve(root) === path.resolve(activeRoot)) continue; // already tried
            const service = this._getLocalFolderService(root);
            const paths = service.getFolderPaths();
            const resolved = service.resolveFolderPath(sourceFolder);
            if (paths.includes(resolved)) {
                return service;
            }
        }

        // Fallback: use the provided workspaceRoot's service (preserves current behavior)
        return this._getLocalFolderService(workspaceRoot);
    }

    private _mapLocalFilesToTreeNodes(files: Array<{
        id: string; name: string; relativePath: string;
        isFolder?: boolean; parentId?: string;
        _root?: string; sourceFolder?: string; title?: string;
        createdMs?: number; mtimeMs?: number;
    }>): TreeNode[] {
        return files.map(f => ({
            id: f.id,
            name: f.name,
            kind: f.isFolder ? 'folder' : 'document',
            parentId: f.parentId,
            hasChildren: f.isFolder === true,
            title: f.title,
            metadata: {
                ...(f._root ? { root: f._root } : {}),
                ...(f.sourceFolder ? { sourceFolder: f.sourceFolder } : {}),
                ...(f.sourceFolder && f.relativePath ? { absolutePath: path.resolve(f.sourceFolder, f.relativePath) } : {}),
                ...(typeof f.createdMs === 'number' ? { createdMs: f.createdMs } : {}),
                ...(typeof f.mtimeMs === 'number' ? { mtimeMs: f.mtimeMs } : {})
            }
        }));
    }

    private async _sendLocalDocsReady(force: boolean = false): Promise<any> {
        try {
            const allRoots = this._getWorkspaceRoots();
            const allFiles: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string; _root?: string; sourceFolder?: string; title?: string; createdMs?: number; mtimeMs?: number }> = [];
            const scannedPaths = new Set<string>();
            const activeRoot = this._getWorkspaceRoot();
            const configuredFolderPathsByRoot: Record<string, string[]> = {};
            const ticketsFolderPathsByRoot: Record<string, string[]> = {};

            const seenFilePaths = new Set<string>(); // Deduplicate files across roots

            for (const root of allRoots) {
                try {
                    const localFolderService = this._getLocalFolderService(root);
                    const folderPaths = localFolderService.getFolderPaths();
                    configuredFolderPathsByRoot[root] = folderPaths;
                    const clickup = GlobalIntegrationConfigService.loadConfigSync('clickup');
                    const linear = GlobalIntegrationConfigService.loadConfigSync('linear');
                    const paths: string[] = [];
                    if (clickup?.ticketSaveLocation) paths.push(clickup.ticketSaveLocation);
                    if (linear?.ticketSaveLocation) paths.push(linear.ticketSaveLocation);
                    ticketsFolderPathsByRoot[root] = paths;

                    // Skip this root entirely if all its folder paths have already been scanned
                    const allAlreadyScanned = folderPaths.length > 0 && folderPaths.every(p => p && scannedPaths.has(p));

                    for (const folderPath of folderPaths) {
                        if (folderPath && scannedPaths.has(folderPath)) {
                            continue;
                        }
                        if (folderPath) {
                            scannedPaths.add(folderPath);
                        }
                    }

                    if (!allAlreadyScanned) {
                        const files = await localFolderService.listFiles();
                        // Tag files with their root, deduplicate by absolute path across roots
                        for (const f of files) {
                            const absPath = path.resolve(f.sourceFolder, f.relativePath);
                            if (!seenFilePaths.has(absPath)) {
                                seenFilePaths.add(absPath);
                                allFiles.push({ ...f, _root: root });
                            }
                        }
                    }
                } catch (err) {
                    // Log but continue — one bad root shouldn't break others
                    console.debug('[PlanningPanel] Failed to list files for root:', root, err);
                }
            }

            // Antigravity sessions
            let antigravitySessions: Array<{
                id: string; name: string; timestamp: string;
                artifacts: Array<{ id: string; name: string; relativePath: string }>;
            }> = [];

            if (allRoots.length > 0) {
                try {
                    const agService = this._getLocalFolderService(allRoots[0]);
                    antigravitySessions = await agService.listAntigravitySessions();
                } catch (err) {
                    console.debug('[PlanningPanel] Failed to list antigravity sessions:', err);
                }
            }

            const mappedNodes = this._mapLocalFilesToTreeNodes(allFiles);
            const workspaceItems = this._buildKanbanWorkspaceItems();

            // Content dedup: watched folders (e.g. an active Claude/Cursor projects dir)
            // can churn many times a second from file CONTENT edits that don't change the
            // list of docs. Re-posting an identical list re-renders the tree, flashes
            // "loading local docs", and steals the active tab. Skip the PUSH when nothing
            // changed — but still RETURN the payload so the HTTP return-contract (browser
            // cockpit) always gets a renderable body, never an empty one.
            const signature = JSON.stringify({
                folderPathsByRoot: configuredFolderPathsByRoot,
                ticketsFolderPathsByRoot,
                nodes: mappedNodes,
                antigravitySessions,
                workspaceItems
            });
            const payload = {
                type: 'localDocsReady',
                sourceId: 'local-folder',
                folderPathsByRoot: configuredFolderPathsByRoot,
                ticketsFolderPathsByRoot,
                nodes: mappedNodes,
                workspaceItems,
                kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
                antigravitySessions
            };
            if (!force && signature === this._lastLocalDocsSignature) {
                return payload;
            }
            this._lastLocalDocsSignature = signature;

            console.log('[PlanningPanel] Sending localDocsReady, total nodes count:', allFiles.length);
            this.postMessageToWebview(payload);
            return payload;
        } catch (err) {
            console.error('[PlanningPanel] Failed to fetch local-folder roots:', err);
            this._lastLocalDocsSignature = ''; // force re-render on next successful send
            const errPayload = {
                type: 'localDocsReady',
                sourceId: 'local-folder',
                folderPathsByRoot: {},
                ticketsFolderPathsByRoot: {},
                nodes: [],
                workspaceItems: this._buildKanbanWorkspaceItems(),
                kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
                error: String(err)
            };
            this.postMessageToWebview(errPayload);
            return errPayload;
        }
    }


    private async _sendOnlineDocsReady(): Promise<any> {
        const availableSources = this._researchImportService.getAvailableSources();
        console.log('[PlanningPanel] Available sources before filtering:', availableSources);

        const adapters = this._researchImportService.getAdapters();
        const roots = adapters
            .filter(a => a.sourceId !== 'local-folder')
            .map(a => ({ sourceId: a.sourceId, nodes: [] as TreeNode[] }));

        // Load saved browse filter containers from unified config
        const { config } = await this._resolveSyncConfig();
        const browseFilterContainers = config.browseFilterContainers || {};

        console.log('[PlanningPanel] Sending onlineDocsReady, roots count:', roots.length, 'roots:', roots);
        const allRoots = this._getWorkspaceRoots();
        const workspaceRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);
        const enabledSourcesConfig = this._seams().pathConfig.getConfigJson<Record<string, boolean>>('planning.enabledSources', {});

        const enabledSources: Record<string, boolean> = {};
        availableSources.forEach(s => {
            if (s !== 'local-folder') {
                enabledSources[s] = enabledSourcesConfig[s] !== false;
            }
        });
        const payload = {
            type: 'onlineDocsReady',
            roots,
            enabledSources,
            browseFilterContainers
        };
        this.postMessageToWebview(payload);
        return payload;
    }

    private async _handleFetchRoots(forceLocalDocs: boolean = false): Promise<any> {
        const localDocs = await this._sendLocalDocsReady(forceLocalDocs);
        const onlineDocs = await this._sendOnlineDocsReady();
        await this._sendPlanningHtmlDocsReady();
        const importedDocsRes = await this._handleFetchImportedDocs(this._getWorkspaceRoot() || '');

        // Arm file watchers. In VS Code these are also armed in open(), but
        // open() never runs in the standalone host — fetchRoots is the first
        // message the webview sends on page load (planning.js:9259), so this
        // is the standalone initialization path. Each _setup* method disposes
        // existing watchers before re-arming, so a double-call in VS Code is
        // safe. By this point LocalFolderService's async config load has
        // resolved, so getFolderPaths() returns the full configured set.
        this._setupDocsFolderWatcher(this._getWorkspaceRoot() || this._getWorkspaceRoots()[0]);
        this._setupLocalFolderWatchers();
        this._setupPlanningHtmlFolderWatchers();
        this._setupAntigravityWatcher();
        this._setupKanbanPlansWatcher();
        this._setupFeatureDocsWatcher();
        this._setupConstitutionWatcher();
        this._setupInsightsWatcher();

        const cyberAnimationDisabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberAnimation', false);
        this.postMessageToWebview({ type: 'cyberAnimationSetting', disabled: cyberAnimationDisabled });
        const cyberScanlinesDisabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberScanlines', false);
        this.postMessageToWebview({ type: 'cyberScanlinesSetting', disabled: cyberScanlinesDisabled });
        const currentTheme = this._seams().pathConfig.getConfigStringWithDefault('theme.name', 'afterburner');
        this.postMessageToWebview({ type: 'switchboardThemeNameSetting', theme: currentTheme });
        return {
            localDocs,
            onlineDocs,
            importedDocs: importedDocsRes
        };
    }

    private async _handleFetchChildren(workspaceRoot: string, sourceId: string, parentId?: string): Promise<any> {
        // Handle local-folder directly without adapter
        if (sourceId === 'local-folder') {
            const localFolderService = this._getLocalFolderService(workspaceRoot);
            try {
                const files = await localFolderService.listFiles();
                const nodes = this._mapLocalFilesToTreeNodes(files)
                    .filter(node => node.parentId === parentId || (!parentId && !node.parentId));
                const res = { type: 'childrenReady', sourceId, parentId, nodes };
                this.postMessageToWebview(res);
                return { success: true, ...res };
            } catch (err) {
                console.error(`Failed to fetch children for ${sourceId}:`, err);
                const res = { type: 'childrenReady', sourceId, parentId, nodes: [] };
                this.postMessageToWebview(res);
                return { success: false, ...res };
            }
        }

        const adapter = this._researchImportService.getAdapter(sourceId);
        if (!adapter) {
            const res = { type: 'childrenReady', sourceId, parentId, nodes: [] };
            this.postMessageToWebview(res);
            return { success: true, ...res };
        }

        try {
            const nodes = await adapter.fetchChildren(parentId);
            const res = { type: 'childrenReady', sourceId, parentId, nodes };
            this.postMessageToWebview(res);
            return { success: true, ...res };
        } catch (err) {
            console.error(`Failed to fetch children for ${sourceId}:`, err);
            const res = { type: 'childrenReady', sourceId, parentId, nodes: [] };
            this.postMessageToWebview(res);
            return { success: false, ...res };
        }
    }

    private _getPreviewCacheKey(sourceId: string, docId: string, sourceFolder?: string): string {
        return `${sourceId}:${docId}:${sourceFolder || ''}`;
    }

    private async _handleFetchPreview(workspaceRoot: string, sourceId: string, docId: string, requestId: number, sourceFolder?: string): Promise<any> {
        // Race guard — track latest request per source
        this._latestRequestIds.set(sourceId, requestId);

        // Single-entry cache: clear stale entries for other documents
        const currentKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
        for (const key of this._lastPreviewContentByPath.keys()) {
            if (key !== currentKey) {
                this._lastPreviewContentByPath.delete(key);
            }
        }


        // Handle planning-html-folder: iframe-based HTML preview with localhost server
        if (sourceId === 'planning-html-folder') {
            if (!sourceFolder) {
                const res = { type: 'previewError', sourceId, requestId, error: 'sourceFolder is required' };
                this.postMessageToWebview(res);
                return { success: false, ...res };
            }
            this._activePlanningHtmlPreview = { sourceFolder, docId, sourceId };
            this._activePreviewSourceId = 'planning-html-folder';
            this._activePreviewDocId = docId;
            this._activePreviewSourceFolder = sourceFolder;
            this._activePreviewWorkspaceRoot = workspaceRoot;
            const relPath = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
            const resolvedPreviewPath = path.resolve(sourceFolder, relPath);
            this._activePreviewPath = resolvedPreviewPath;
            this._setupActiveDocWatcher(resolvedPreviewPath);
            this._registerSaveTextDocListener();
            return await this._buildAndSendPlanningHtmlPreview({ sourceId, sourceFolder, docId, requestId });
        }

        // Handle local-folder directly without adapter
        if (sourceId === 'local-folder') {
            if (!sourceFolder) {
                const res = { type: 'previewError', sourceId, requestId, error: 'sourceFolder is required' };
                this.postMessageToWebview(res);
                return { success: false, ...res };
            }
            const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, 'local-folder')
                || this._getLocalFolderService(workspaceRoot);
            try {
                console.log('[PlanningPanel] Fetching local doc content:', { docId, requestId });
                const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
                const result = await localFolderService.fetchDocContent(cleanDocId, sourceFolder);
                console.log('[PlanningPanel] Local doc fetch result:', { success: result.success, error: result.error, hasContent: !!result.content });
                if (result.success) {
                    const resolvedPath = path.resolve(path.join(sourceFolder, cleanDocId));
                    this._activePreviewPath = resolvedPath;
                    this._activePreviewSourceId = 'local-folder';
                    this._activePreviewDocId = docId;
                    this._activePreviewSourceFolder = sourceFolder;
                    this._activePreviewWorkspaceRoot = workspaceRoot;
                    this._setupActiveDocWatcher(resolvedPath);

                    const cacheKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
                    const lastContent = this._lastPreviewContentByPath.get(cacheKey);
                    if (result.content === lastContent) {
                        // Cache hit — notify frontend for user-initiated requests only
                        if (requestId >= 0) {
                            const res = {
                                type: 'previewReady',
                                sourceId,
                                requestId,
                                content: result.content || '',
                                docName: result.docTitle,
                                isAutoRefreshed: false,
                                filePath: resolvedPath
                            };
                            this.postMessageToWebview(res);
                            return { ...res, success: true };
                        }
                        return { success: true, type: 'previewReady', sourceId, requestId, content: result.content || '', docName: result.docTitle };
                    }
                    this._lastPreviewContentByPath.set(cacheKey, result.content || '');

                    const res = {
                        type: 'previewReady',
                        sourceId,
                        requestId,
                        content: result.content || '',
                        docName: result.docTitle,
                        isAutoRefreshed: this._isAutoRefreshing,
                        filePath: resolvedPath
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: true };
                } else {
                    const res = { type: 'previewError', sourceId, requestId, error: result.error || 'Failed to fetch document' };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            } catch (err) {
                console.error('[PlanningPanel] Error fetching local doc:', err);
                const res = { type: 'previewError', sourceId, requestId, error: String(err) };
                this.postMessageToWebview(res);
                return { success: false, ...res };
            }
        }

        const adapter = this._researchImportService.getAdapter(sourceId);
        if (!adapter) {
            const res = { type: 'previewError', sourceId, requestId, error: 'Adapter not found' };
            this.postMessageToWebview(res);
            return { success: false, ...res };
        }

        // Initialize cache service via shared factory (one instance per workspace root)
        if (!this._cacheService && workspaceRoot) {
            this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
        }

        try {
            // CHECK CACHE FIRST - return immediately if cached
            if (this._cacheService) {
                const cachedContent = await this._cacheService.getCachedDocument(sourceId, docId);
                if (cachedContent) {
                    // Parse docName from front-matter if present
                    let docName: string | undefined;
                    const frontMatterMatch = cachedContent.match(/^---\n[\s\S]*?docName:\s*(.+?)\n[\s\S]*?\n---/);
                    if (frontMatterMatch) {
                        docName = frontMatterMatch[1].trim();
                    }
                    // Strip front-matter for display
                    const content = cachedContent.replace(/^---\n[\s\S]*?\n---\n/, '');
                    const isImported = await this._cacheService.isDocumentImported(sourceId, docId);

                    const workspaceId = await this._getWorkspaceId(workspaceRoot);
                    const resolvedPath = await this._cacheService.resolveImportedDocPath(docId, workspaceId);
                    if (resolvedPath) {
                        this._activePreviewPath = resolvedPath;
                        this._activePreviewSourceId = sourceId;
                        this._activePreviewDocId = docId;
                        this._setupActiveDocWatcher(resolvedPath);
                    }

                    const res = {
                        type: 'previewReady',
                        sourceId,
                        requestId,
                        content,
                        docName,
                        isCached: true,
                        isImported,
                        isAutoRefreshed: this._isAutoRefreshing
                    };
                    this.postMessageToWebview(res);
                    // Refresh cache in background after returning cached content
                    this._refreshCacheInBackground(sourceId, docId, adapter);
                    return { ...res, success: true };
                }
            }

            // No cache - fetch from adapter
            let content = '';
            let docName: string | undefined;

            // ClickUp: fetchDocContent returns both content AND docTitle in one call.
            if (sourceId === 'clickup' && 'fetchDocContent' in adapter) {
                const cleanDocId = docId.startsWith('doc:') ? docId.slice(4) : docId;
                const docResult = await (adapter as any).fetchDocContent(cleanDocId, 'summary');
                if (docResult.success) {
                    if (docResult.pages) {
                        const res = {
                            type: 'previewReady',
                            sourceId,
                            requestId,
                            docName: docResult.docTitle,
                            content: docResult.content || docResult.firstPageContent || '',
                            pages: docResult.pages,
                            totalPages: docResult.totalPages,
                            isAutoRefreshed: this._isAutoRefreshing
                        };
                        this.postMessageToWebview(res);
                        return { ...res, success: true };
                    }
                    content = docResult.content || '';
                    docName = docResult.docTitle;
                } else {
                    const res = { type: 'previewError', sourceId, requestId, error: docResult.error || 'Failed to fetch ClickUp document' };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            } else if ('fetchContent' in adapter) {
                content = await adapter.fetchContent(docId);
            }

            // Cache the document locally
            if (this._cacheService && content) {
                this._lastPanelWriteTimestamp = Date.now();
                await this._cacheService.cacheDocument(sourceId, docId, content, docName || docId);
            }

            const isImported = this._cacheService ? await this._cacheService.isDocumentImported(sourceId, docId) : false;

            if (this._cacheService) {
                const workspaceId = await this._getWorkspaceId(workspaceRoot);
                const resolvedPath = await this._cacheService.resolveImportedDocPath(docId, workspaceId);
                if (resolvedPath) {
                    this._activePreviewPath = resolvedPath;
                    this._activePreviewSourceId = sourceId;
                    this._activePreviewDocId = docId;
                    this._setupActiveDocWatcher(resolvedPath);
                }
            }

            const res = {
                type: 'previewReady',
                sourceId,
                requestId,
                content,
                docName,
                isCached: true,
                isImported,
                isAutoRefreshed: this._isAutoRefreshing
            };
            this.postMessageToWebview(res);
            return { success: true, ...res };
        } catch (err) {
            const currentRequestId = this._latestRequestIds.get(sourceId);
            if (currentRequestId === requestId) {
                const res = { type: 'previewError', sourceId, requestId, error: String(err) };
                this.postMessageToWebview(res);
                return { success: false, ...res };
            }
            return { success: false, error: 'Stale request' };
        }
    }

    /**
     * Refresh cache in background after serving cached content.
     * This updates the cache without blocking the UI.
     */
    private async _refreshCacheInBackground(sourceId: string, docId: string, adapter: any): Promise<void> {
        try {
            let content = '';
            let docName: string | undefined;

            if (sourceId === 'clickup' && 'fetchDocContent' in adapter) {
                const cleanDocId = docId.startsWith('doc:') ? docId.slice(4) : docId;
                const docResult = await (adapter as any).fetchDocContent(cleanDocId, 'summary');
                if (docResult.success) {
                    content = docResult.content || docResult.firstPageContent || '';
                    docName = docResult.docTitle;
                }
            } else if ('fetchContent' in adapter) {
                content = await adapter.fetchContent(docId);
            }

            if (this._cacheService && content) {
                this._lastPanelWriteTimestamp = Date.now();
                await this._cacheService.cacheDocument(sourceId, docId, content, docName || docId);
            }
        } catch (err) {
            // Background refresh failure is non-blocking
            console.warn(`[PlanningPanel] Background cache refresh failed for ${sourceId}/${docId}:`, err);
        }
    }

    private async _handleAppendToPlannerPrompt(workspaceRoot: string, sourceId: string, docId: string, docName: string, content?: string, sourceFolder?: string): Promise<void> {
        try {
            let result;
            this._lastPanelWriteTimestamp = Date.now();
            let finalContent = content;
            if (sourceId === 'local-folder' && !finalContent) {
                if (!sourceFolder) {
                    throw new Error('sourceFolder is required');
                }
                const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, 'local-folder')
                    || this._getLocalFolderService(workspaceRoot);
                const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
                const fetchResult = await localFolderService.fetchDocContent(cleanDocId, sourceFolder);
                if (!fetchResult.success) {
                    throw new Error(fetchResult.error || 'Failed to fetch local doc content');
                }
                finalContent = fetchResult.content;

            } else if (sourceId === 'antigravity' && !finalContent) {
                // For antigravity: docId is an absolute path to the artifact
                const localFolderService = this._getLocalFolderService(workspaceRoot);
                const fetchResult = await localFolderService.fetchAntigravityArtifact(docId);
                if (!fetchResult.success) {
                    throw new Error(fetchResult.error || 'Failed to fetch antigravity artifact content');
                }
                finalContent = fetchResult.content;
            }
            if (finalContent) {
                // Use provided content directly (for pages that aren't cached)
                result = await this._plannerPromptWriter.writeContentToDocsDir(workspaceRoot, finalContent, docName, sourceId);
            } else {
                result = await this._plannerPromptWriter.writeFromPlanningCache(workspaceRoot, sourceId, docId, docName);
            }
            if (result.success && this._cacheService && result.savedPath) {
                try {
                    const rawSlug = (docName || sourceId)
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_+|_+$/g, '')
                        .slice(0, 60) || sourceId;
                    const contentForHash = finalContent || '';
                    const contentWithoutFrontMatter = contentForHash.replace(/^---\n[\s\S]*?\n---\n*/, '');
                    const contentHash = crypto.createHash('sha256').update(contentWithoutFrontMatter).digest('hex');
                    const workspaceId = await this._getWorkspaceId(workspaceRoot);
                    await this._cacheService.registerImport(sourceId, docId, docName, rawSlug, {
                        remoteContentHash: contentHash,
                        workspaceId,
                        filePath: result.savedPath
                    });
                } catch (regErr) {
                    console.warn('[PlanningPanelProvider] Failed to register import:', regErr);
                }
                // Also mark as imported on the adapter (for UI state tracking)
                const adapter = this._researchImportService.getAdapter(sourceId);
                if (adapter && (adapter as any).setDocumentImported) {
                    await (adapter as any).setDocumentImported(docId);
                }
            }
            this.postMessageToWebview({ type: 'plannerPromptState', ...result });
            // Send updated active design doc state after import
            if (result.success) {

            }
        } catch (err) {
            this.postMessageToWebview({ type: 'plannerPromptState', error: String(err) });
        }
    }

    private async _getWorkspaceId(workspaceRoot: string): Promise<string> {
        // Derive from workspace root or use KanbanDatabase.forWorkspace(workspaceRoot).getWorkspaceId()
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            const wsId = await db.getWorkspaceId();
            if (wsId) return wsId;

            // If we have a DB instance but no workspace ID, something is wrong
            throw new Error(
                `[PlanningPanelProvider] No workspace_id configured in database for ${workspaceRoot}. ` +
                `Please run "Switchboard: Reset Kanban Database" to recreate.`
            );
        } catch (err) {
            // If it's our specific configuration error, rethrow it
            if (err instanceof Error && err.message.includes('No workspace_id configured')) {
                throw err;
            }
            // Otherwise it's a structural failure (require failed, etc.) - use hash as last resort
        }
        return crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
    }

    private async _handleFetchImportedDocs(workspaceRoot: string): Promise<any> {
        try {
            const allRoots = this._getWorkspaceRoots();
            const allDocs: any[] = [];
            const seenSlugs = new Set<string>();

            for (const root of allRoots) {
                const wsId = await this._getWorkspaceId(root);
                const cacheService = this._adapterFactories.getCacheService(root);

                // Run heal scan first (idempotent, fast if recent)
                const kanbanDb = (cacheService as any)._kanbanDb;
                if (kanbanDb) {
                    const lastScan = await kanbanDb.getMeta('last_heal_scan_' + wsId);
                    const oneHourAgo = Date.now() - (60 * 60 * 1000);
                    if (!lastScan || new Date(lastScan).getTime() < oneHourAgo) {
                        await kanbanDb.healImports(root, wsId);
                    }
                }

                // Query DB for imported docs
                const dbEntries = await cacheService.getImportedDocs(wsId);

                for (const entry of dbEntries) {
                    if (!seenSlugs.has(entry.slugPrefix)) {
                        seenSlugs.add(entry.slugPrefix);
                        allDocs.push({
                            sourceId: entry.sourceId,
                            docId: entry.remoteDocId || entry.slugPrefix,
                            docName: entry.docName,
                            parentDocName: entry.parentDocName || entry.docName,
                            slugPrefix: entry.slugPrefix,
                            canSync: ['clickup', 'linear', 'notion'].includes(entry.sourceId),
                            order: entry.displayOrder || 0,
                            lastSyncedAt: entry.lastSyncedAt || entry.importedAt,
                            importedAt: entry.importedAt
                        });
                    }
                }
            }

            const res = { type: 'importedDocsReady', docs: allDocs };
            this.postMessageToWebview(res);
            return { success: true, ...res };
        } catch (err) {
            console.error('[PlanningPanelProvider] Error fetching imported docs:', err);
            const res = { type: 'importedDocsReady', docs: [], error: String(err) };
            this.postMessageToWebview(res);
            return { success: false, ...res };
        }
    }

    private async _handleFetchDocsFile(workspaceRoot: string, slugPrefix: string, requestId: number): Promise<any> {
        try {
            // Search all workspace roots via their DBs first (handles hash-based filenames)
            let filePath: string | null = null;
            const allRoots = this._getWorkspaceRoots();
            for (const root of allRoots) {
                const wsId = await this._getWorkspaceId(root);
                const cacheService = this._adapterFactories.getCacheService(root);
                filePath = await cacheService.resolveImportedDocPath(slugPrefix, wsId);
                if (filePath) {
                    if (fs.existsSync(filePath)) {
                        break;
                    }
                    filePath = null; // DB entry stale, keep searching
                }
            }

            if (!filePath) {
                // Fallback: construct path directly (for non-imported docs)
                const relativePath = path.join('.switchboard', 'docs', `${slugPrefix}.md`);
                const resolved = await this._resolveWorkspacePath(relativePath);
                filePath = resolved.path;
            }

            if (!filePath || !fs.existsSync(filePath)) {
                const res = {
                    type: 'previewError',
                    sourceId: 'local-folder',
                    requestId,
                    error: 'File not found'
                };
                this.postMessageToWebview(res);
                return { success: false, ...res };
            }

            const content = fs.readFileSync(filePath, 'utf-8');

            // Parse docName from DB, top-level H1, or filename
            let docName = '';

            // 1. DB lookup first
            for (const root of allRoots) {
                try {
                    const wsId = await this._getWorkspaceId(root);
                    const cacheService = this._adapterFactories.getCacheService(root);
                    const entry = await cacheService.getImportBySlugPrefix(slugPrefix, wsId);
                    if (entry && entry.docName) {
                        docName = entry.docName;
                        break;
                    }
                } catch (e) {
                    // Ignore DB errors and proceed
                }
            }

            // 2. Top-level H1
            if (!docName) {
                const h1Match = content.match(/^#\s+(.+)$/m);
                if (h1Match) {
                    docName = h1Match[1].trim();
                }
            }

            // 3. Filename-as-slug fallback
            if (!docName) {
                const baseName = path.basename(filePath, '.md');
                // Strip old hash suffix (_abcd1234) and new collision suffix (_1, _2, etc.)
                const cleanBaseName = baseName.replace(/_[a-f0-9]{8}$/, '').replace(/_\d+$/, '');
                docName = cleanBaseName.replace(/_/g, ' ');
            }
            if (!docName) {
                docName = slugPrefix;
            }

            // Strip front-matter for display
            const displayContent = content.replace(/^---\n[\s\S]*?\n---\n/, '');

            this._activePreviewSourceId = 'local-folder';
            this._activePreviewDocId = slugPrefix;
            this._activePreviewPath = filePath;
            this._setupActiveDocWatcher(filePath);

            const cacheKey = this._getPreviewCacheKey('local-folder', slugPrefix, undefined);
            if (requestId === -1 && this._lastPreviewContentByPath.get(cacheKey) === displayContent) {
                return { success: true, type: 'previewReady', sourceId: 'local-folder', requestId, content: displayContent, docName };
            }
            this._lastPreviewContentByPath.set(cacheKey, displayContent);

            const res = {
                type: 'previewReady',
                sourceId: 'local-folder',
                requestId,
                content: displayContent,
                docName,
                isAutoRefreshed: this._isAutoRefreshing
            };
            this.postMessageToWebview(res);
            return { success: true, ...res };
        } catch (err) {
            console.error('[PlanningPanelProvider] Error fetching docs file:', err);
            const res = {
                type: 'previewError',
                sourceId: 'local-folder',
                requestId,
                error: String(err)
            };
            this.postMessageToWebview(res);
            return { success: false, ...res };
        }
    }

    private async _handleSyncToSource(workspaceRoot: string, slugPrefix: string): Promise<void> {
        try {
            if (!this._cacheService) {
                this.postMessageToWebview({ type: 'syncResult', slugPrefix, success: false, error: 'Cache service not available' });
                return;
            }

            const workspaceId = await this._getWorkspaceId(workspaceRoot);
            const importEntry = await this._cacheService.getImportBySlugPrefix(slugPrefix, workspaceId);
            if (!importEntry) {
                this.postMessageToWebview({ type: 'syncResult', slugPrefix, success: false, error: 'Import entry not found' });
                return;
            }

            const adapter = this._researchImportService.getAdapter(importEntry.sourceId);
            if (!adapter || !adapter.updateContent) {
                this.postMessageToWebview({ type: 'syncResult', slugPrefix, success: false, error: 'Source does not support sync-to-source' });
                return;
            }

            const localPath = await this._cacheService.resolveImportedDocPath(slugPrefix, workspaceId);
            if (!localPath) {
                this.postMessageToWebview({ type: 'syncResult', slugPrefix, success: false, error: 'Local file not found' });
                return;
            }

            const localContent = await fs.promises.readFile(localPath, 'utf8');
            const localContentHash = crypto.createHash('sha256').update(localContent).digest('hex');

            // Conflict detection: check if remote has changed since last sync
            if (importEntry.contentHash && adapter.fetchContent) {
                try {
                    const remoteContent = await adapter.fetchContent(importEntry.remoteDocId || importEntry.slugPrefix);
                    const remoteContentHash = crypto.createHash('sha256').update(remoteContent).digest('hex');

                    if (remoteContentHash !== importEntry.contentHash) {
                        // Remote has changed since last sync
                        if (localContentHash === importEntry.contentHash) {
                            // Only remote changed — no push needed, just update the stored hash
                            await this._cacheService.updateLastSynced(slugPrefix, remoteContentHash, workspaceId);
                            this.postMessageToWebview({
                                type: 'syncResult', slugPrefix, success: true,
                                message: 'Remote was updated. Local content is unchanged. Registry updated.'
                            });
                            return;
                        }

                        // Both local and remote have changed — conflict: offer resolution via modal dialog
                        const choice = await this._seams().ui.showModalWarningMessage(
                            `Conflict: Both the local and remote document "${importEntry.docName}" have been modified since the last sync.`,
                            'Overwrite Remote',
                            'Keep Remote',
                            'Cancel'
                        );
                        if (choice === 'Keep Remote' || choice === 'Cancel' || !choice) {
                            this.postMessageToWebview({
                                type: 'syncResult', slugPrefix, success: false,
                                error: choice === 'Keep Remote'
                                    ? 'Sync cancelled. Remote content preserved.'
                                    : 'Sync cancelled by user.'
                            });
                            return;
                        }
                        // choice === 'Overwrite Remote' — proceed with sync below
                    }
                } catch {
                    // Can't fetch remote for comparison — proceed with sync (best-effort)
                }
            }

            const result = await adapter.updateContent(importEntry.remoteDocId || importEntry.slugPrefix, localContent);
            if (result.success) {
                await this._cacheService.updateLastSynced(slugPrefix, localContentHash, workspaceId);
                this._lastPanelWriteTimestamp = Date.now();
                this.postMessageToWebview({ type: 'syncResult', slugPrefix, success: true });
            } else {
                this.postMessageToWebview({ type: 'syncResult', slugPrefix, success: false, error: result.error });
            }
        } catch (err) {
            this.postMessageToWebview({ type: 'syncResult', slugPrefix, success: false, error: String(err) });
        }
    }

    private async _handleImportFullDoc(workspaceRoot: string, sourceId: string, docId: string, docName: string, sourceFolder?: string): Promise<void> {
        // Concurrency guard: prevent double-import
        if (this._importInProgress) {
            this.postMessageToWebview({ type: 'importFullDocResult', error: 'Import already in progress' });
            return;
        }

        // Sanitize docId to prevent path traversal in cache file paths
        const safeDocId = docId.replace(/[^a-zA-Z0-9_-]/g, '_');

        this._importInProgress = true;
        try {
            const workspaceId = await this._getWorkspaceId(workspaceRoot);

            // Duplicate check for online sources (skip for local-folder)
            if (sourceId !== 'local-folder' && this._cacheService) {
                const duplicateCheck = await this._cacheService.checkForDuplicate(docName, sourceId, workspaceId, safeDocId);
                if (duplicateCheck.isDuplicate) {
                    this.postMessageToWebview({
                        type: 'duplicateDetected',
                        docName,
                        sourceId,
                        docId: safeDocId,
                        matchType: duplicateCheck.matchType,
                        existingDoc: duplicateCheck.existingDoc
                    });
                    // Release the import lock so resolveDuplicate can re-enter
                    this._importInProgress = false;
                    return;
                }
            }

            // Handle local-folder directly without adapter
            if (sourceId === 'local-folder') {
                if (!sourceFolder) {
                    this.postMessageToWebview({ type: 'importFullDocResult', error: 'sourceFolder is required' });
                    return;
                }
                const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, 'local-folder')
                    || this._getLocalFolderService(workspaceRoot);
                const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
                const result = await localFolderService.fetchDocContent(cleanDocId, sourceFolder);
                if (!result.success) {
                    this.postMessageToWebview({ type: 'importFullDocResult', error: result.error || 'Failed to fetch document' });
                    return;
                }
                const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
                    workspaceRoot,
                    result.content || '',
                    docName,
                    sourceId,
                );
                this._lastPanelWriteTimestamp = Date.now();
                if (writeResult.error) {
                    this.postMessageToWebview({ type: 'importFullDocResult', error: writeResult.error });
                    return;
                }
                if (this._cacheService && writeResult.success && writeResult.savedPath) {
                    try {
                        const rawSlug = (docName || sourceId)
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, '_')
                            .replace(/^_+|_+$/g, '')
                            .slice(0, 60) || sourceId;
                        const contentWithoutFrontMatter = (result.content || '').replace(/^---\n[\s\S]*?\n---\n*/, '');
                        const contentHash = crypto.createHash('sha256').update(contentWithoutFrontMatter).digest('hex');
                        const workspaceId = await this._getWorkspaceId(workspaceRoot);
                        await this._cacheService.registerImport(sourceId, safeDocId, docName, rawSlug, {
                            remoteContentHash: contentHash,
                            workspaceId,
                            filePath: writeResult.savedPath
                        });
                    } catch (regErr) {
                        console.warn('[PlanningPanelProvider] Failed to register local-folder import:', regErr);
                    }
                }
                await this._sendLocalDocsReady();
                await this._handleFetchImportedDocs(workspaceRoot);
                this.postMessageToWebview({ type: 'importFullDocResult', success: true, message: 'Document imported', savedPath: writeResult.savedPath, docName });
                return;
            }

            const adapter = this._researchImportService.getAdapter(sourceId);
            if (!adapter) {
                this.postMessageToWebview({ type: 'importFullDocResult', error: 'Adapter not found' });
                return;
            }

            // Check if adapter supports subpages
            if (adapter.listDocPages && adapter.fetchPageContent) {
                // Get list of pages
                const pages = await adapter.listDocPages(docId);
                
                if (pages && pages.length > 1) {
                    // Reverse pages so first page gets order 0 (ClickUp API returns pages in reverse order)
                    const reversedPages = [...pages].reverse();
                    
                    // Import each page as a separate doc
                    let importedCount = 0;
                    let errorCount = 0;
                    const batchEntries: any[] = [];
                    
                    // Track page index for order preservation
                    let pageIndex = 0;
                    for (const page of reversedPages) {
                        try {
                            const result = await adapter.fetchPageContent!(docId, page.id);
                            if (result.success && result.content) {
                                // Prioritize page.name (from listDocPages) over result.docName
                                const pageDocName = page.name || result.docName || 'Untitled Page';
                                const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
                                    workspaceRoot,
                                    result.content,
                                    pageDocName,
                                    sourceId,
                                    { pageOrder: pageIndex, parentDocName: docName }
                                );
                                
                                if (writeResult.success && writeResult.savedPath) {
                                    importedCount++;
                                    // Prepare batch entry
                                    const rawSlug = pageDocName
                                        .toLowerCase()
                                        .replace(/[^a-z0-9]+/g, '_')
                                        .replace(/^_+|_+$/g, '')
                                        .slice(0, 60) || sourceId;
                                    const contentWithoutFrontMatter = result.content.replace(/^---\n[\s\S]*?\n---\n*/, '');
                                    const contentHash = crypto.createHash('sha256').update(contentWithoutFrontMatter).digest('hex');
                                    
                                    batchEntries.push({
                                        slugPrefix: rawSlug,
                                        sourceId,
                                        remoteDocId: page.id,
                                        docName: pageDocName,
                                        parentDocName: docName,
                                        filePath: writeResult.savedPath,
                                        importedAt: new Date().toISOString(),
                                        lastSyncedAt: new Date().toISOString(),
                                        contentHash: contentHash,
                                        workspaceId: workspaceId,
                                        displayOrder: pageIndex
                                    });
                                    pageIndex++;
                                } else {
                                    errorCount++;
                                }
                            }
                        } catch (pageErr) {
                            console.warn(`[PlanningPanelProvider] Failed to import page ${page.id}:`, pageErr);
                            errorCount++;
                        }
                    }
                    
                    // Register all subpages in one batch
                    if (this._cacheService && batchEntries.length > 0) {
                        const kanbanDb = (this._cacheService as any)._kanbanDb;
                        if (kanbanDb) {
                            await kanbanDb.registerImportBatch(batchEntries);
                        }
                    }
                    
                    await this._sendLocalDocsReady();
                    await this._handleFetchImportedDocs(workspaceRoot);
                    this.postMessageToWebview({
                        type: 'importFullDocResult',
                        success: errorCount === 0,
                        message: `Imported ${importedCount} pages (${errorCount} errors)`,
                        savedPath: batchEntries[0]?.filePath,
                        docName
                    });
                    return;
                }
            }

            // Fallback: single doc import (no subpages or adapter doesn't support page listing)
            const content = await (adapter as any).fetchContent(safeDocId);
            const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
                workspaceRoot,
                content,
                docName,
                sourceId,
            );

            if (writeResult.error) {
                this.postMessageToWebview({ type: 'importFullDocResult', error: writeResult.error });
                return;
            }

            // Register in import registry so it shows in Imported Docs section
            if (this._cacheService && writeResult.success) {
                try {
                    const rawSlug = (docName)
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_+|_+$/g, '')
                        .slice(0, 60) || sourceId;
                    const contentWithoutFrontMatter = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
                    const contentHash = crypto.createHash('sha256').update(contentWithoutFrontMatter).digest('hex');
                    await this._cacheService.registerImport(sourceId, safeDocId, docName, rawSlug, { 
                        remoteContentHash: contentHash,
                        workspaceId: workspaceId,
                        filePath: writeResult.savedPath
                    });
                } catch (regErr) {
                    console.warn('[PlanningPanelProvider] Failed to register import:', regErr);
                }
            }

            await this._sendLocalDocsReady();
            await this._handleFetchImportedDocs(workspaceRoot);
            this.postMessageToWebview({
                type: 'importFullDocResult',
                success: true,
                message: 'Document imported successfully',
                savedPath: writeResult.savedPath,
                docName
            });
        } catch (err) {
            this.postMessageToWebview({ type: 'importFullDocResult', error: String(err) });
        } finally {
            this._importInProgress = false;
        }
    }

    private async _handleFetchPageContent(workspaceRoot: string, sourceId: string, docId: string, pageId: string, requestId: number): Promise<any> {
        try {
            const adapter = this._researchImportService.getAdapter(sourceId);
            if (!adapter || !('fetchPageContent' in adapter)) {
                const res = { type: 'previewError', sourceId, requestId, error: 'Adapter does not support page content' };
                this.postMessageToWebview(res);
                return { success: false, ...res };
            }

            const result = await (adapter as any).fetchPageContent(docId, pageId);
            if (result.success) {
                const res = {
                    type: 'previewReady',
                    sourceId,
                    requestId,
                    content: result.content,
                    docName: result.docName
                };
                this.postMessageToWebview(res);
                return { success: true, ...res };
            } else {
                const res = { type: 'previewError', sourceId, requestId, error: result.error || 'Failed to fetch page content' };
                this.postMessageToWebview(res);
                return { success: false, ...res };
            }
        } catch (err) {
            const res = { type: 'previewError', sourceId, requestId, error: String(err) };
            this.postMessageToWebview(res);
            return { success: false, ...res };
        }
    }

    private async _handleImportPlansFromClipboard(workspaceRoot: string): Promise<void> {
        // Delegate to the existing command that handles clipboard import
        await this._seams().commands.executeCommand('switchboard.importPlanFromClipboard');
    }

    private async _handleImportResearchDoc(workspaceRoot: string, docTitle?: string, folderPath?: string): Promise<void> {
        if (this._importInProgress) {
            this.postMessageToWebview({ type: 'importResearchDocResult', error: 'Import already in progress' });
            return;
        }

        this._importInProgress = true;
        try {
            const content = await this._seams().clipboard.readText();

            if (!content || !content.trim()) {
                this.postMessageToWebview({ type: 'importResearchDocResult', error: 'Clipboard is empty. Copy research markdown first.' });
                return;
            }
            if (content.length > 200_000) {
                this.postMessageToWebview({ type: 'importResearchDocResult', error: 'Clipboard content is too large (>200 KB). Aborting import.' });
                return;
            }

            let finalDocTitle = docTitle ? docTitle.trim() : '';
            if (!finalDocTitle) {
                const h1Match = content.match(/^#\s+(.+)$/m);
                if (h1Match) {
                    finalDocTitle = h1Match[1].trim();
                } else {
                    const timestamp = new Date().toISOString().split('.')[0].replace(/:/g, '-');
                    finalDocTitle = `Imported Document ${timestamp}`;
                }
            }

            // Ensure the written doc has an H1 near the top — the local docs sidebar derives
            // card titles from the first ~1KB of the file, so docs without a leading heading
            // showed up titleless.
            let contentToWrite = content;
            const bodyWithoutFrontMatter = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
            if (!/^#\s+/m.test(bodyWithoutFrontMatter.slice(0, 1000))) {
                contentToWrite = `# ${finalDocTitle}\n\n${bodyWithoutFrontMatter}`;
            }

            // In a multi-root workspace the clicked folder may belong to a non-primary root.
            // Resolve the owning root (and its canonical folder path) so the write targets the
            // correct LocalFolderService — otherwise writeContentToDocsDir throws "Target folder
            // is not a configured local docs folder" against the wrong root's path list.
            const { root: effectiveRoot, resolvedFolder } = this._getWorkspaceRootForFolder(folderPath, workspaceRoot);

            const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
                effectiveRoot,
                contentToWrite,
                finalDocTitle,
                'research-clipboard',
                { targetFolder: resolvedFolder ?? folderPath }
            );

            this._lastPanelWriteTimestamp = Date.now();

            if (writeResult.error) {
                this.postMessageToWebview({ type: 'importResearchDocResult', error: writeResult.error });
                return;
            }

            // Register import in the import registry
            if (writeResult.success && writeResult.savedPath && this._cacheService) {
                try {
                    const rawSlug = (finalDocTitle || 'research-clipboard')
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_+|_+$/g, '')
                        .slice(0, 60) || 'research-clipboard';
                    const contentWithoutFrontMatter = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
                    const contentHash = crypto.createHash('sha256').update(contentWithoutFrontMatter).digest('hex');
                    const workspaceId = await this._getWorkspaceId(effectiveRoot);
                    await this._cacheService.registerImport('research-clipboard', finalDocTitle, finalDocTitle, rawSlug, {
                        remoteContentHash: contentHash,
                        workspaceId,
                        filePath: writeResult.savedPath
                    });
                } catch (regErr) {
                    console.warn('[PlanningPanelProvider] Failed to register research import:', regErr);
                }
            }

            this.postMessageToWebview({
                type: 'importResearchDocResult', 
                success: true, 
                docTitle: finalDocTitle,
                savedPath: writeResult.savedPath
            });

            await this._handleFetchImportedDocs(effectiveRoot);
            // Force the tree to re-render even if the dedup signature looks unchanged, so the
            // freshly imported doc appears immediately (it sorts to the top by creation time).
            await this._sendLocalDocsReady(true);

        } catch (err) {
            this.postMessageToWebview({ type: 'importResearchDocResult', error: String(err) });
        } finally {
            this._importInProgress = false;
        }
    }

    // Retained as a no-op safety call — dispose() still invokes it. The periodic
    // sync timer / cancellation source are never started after the sync-mode
    // dropdown removal, so this simply clears already-undefined values. Kept
    // (rather than deleted) so any old panel instance disposing mid-session is
    // harmless, matching the migration posture in CLAUDE.md.
    public stopPeriodicSync(): void {
        if (this._periodicSyncTimer) {
            clearInterval(this._periodicSyncTimer);
            this._periodicSyncTimer = undefined;
        }
        this._syncCancellationSource?.abort();
        this._syncCancellationSource = undefined;
    }


    /**
     * Ticket sync status, decided purely from timestamps in the database.
     * `lastSyncedAt` is when we last fetched/pushed this ticket from the source;
     * the file's mtime is when it was last edited on disk. If the local edit is
     * newer than the last sync, the ticket has local changes that aren't on the
     * source yet → 'modified'. Otherwise → 'synced'.
     */
    private _ticketSyncStatusFromTimestamps(filePath: string, lastSyncedAt?: string): 'synced' | 'modified' | 'local-only' {
        if (!lastSyncedAt) { return 'local-only'; }
        try {
            const nfs = require('fs') as typeof import('fs');
            const mtimeMs = nfs.statSync(filePath).mtimeMs;
            const lastSyncedMs = Date.parse(lastSyncedAt);
            if (!Number.isFinite(lastSyncedMs)) { return 'local-only'; }
            // 1s grace: the import writes the file then records last_synced_at a
            // few ms later, so a freshly-imported file is never falsely modified.
            return mtimeMs > lastSyncedMs + 1000 ? 'modified' : 'synced';
        } catch {
            return 'local-only';
        }
    }

    private _scanLocalTicketFiles(dir: string, provider: string, out: any[], options?: { scopeId?: string; skipSubtasks?: boolean }): void {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const nfs = require('fs') as typeof import('fs');
        let entries: import('fs').Dirent[];
        try { entries = nfs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._scanLocalTicketFiles(fullPath, provider, out, options);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                const match = entry.name.match(/^(?:clickup|linear)_([^_]+)_(.+)\.md$/);
                if (!match) { continue; }
                const id = match[1];
                let title = match[2].replace(/-/g, ' ');
                let kanbanColumn = '';
                let dateCreated: string | undefined;
                let assignees: string[] = [];
                let priority: { priority: string; color: string; orderindex: string } | null = null;
                let parentId = '';
                let fileScopeId = '';
                try {
                    const content = nfs.readFileSync(fullPath, 'utf8');
                    const fm = content.match(/^---\n([\s\S]*?)\n---/);
                    if (fm) {
                        const km = fm[1].match(/kanbanColumn:\s*(.+)/); if (km) { kanbanColumn = km[1].trim(); }
                        const cm = fm[1].match(/^created:\s*(.+)$/m); if (cm) { dateCreated = cm[1].trim(); }
                        const am = fm[1].match(/^assignees:\s*(.+)$/m); if (am) { assignees = am[1].split(',').map(s => s.trim()).filter(Boolean); }
                        const pm = fm[1].match(/^parentId:\s*(.+)$/m); if (pm) { parentId = pm[1].trim(); }
                        const idm = fm[1].match(provider === 'clickup' ? /^listId:\s*(.+)$/m : /^projectName:\s*(.+)$/m);
                        if (idm) { fileScopeId = idm[1].trim(); }
                        const prm = fm[1].match(/^priority:\s*(.+)$/m);
                        const prcm = fm[1].match(/^priorityColor:\s*(.+)$/m);
                        const prom = fm[1].match(/^priorityOrderIndex:\s*(.+)$/m);
                        if (prm || prom) {
                            priority = {
                                priority: prm ? prm[1].trim() : '',
                                color: prcm ? prcm[1].trim() : '',
                                orderindex: prom ? prom[1].trim() : ''
                            };
                        }
                    }
                    const h1 = content.match(/^#\s+(.+)$/m);
                    if (h1) { title = h1[1].trim(); }
                } catch { }

                if (options?.skipSubtasks && parentId) { continue; }
                if (options?.scopeId && fileScopeId !== options.scopeId) { continue; }

                // Fallback to file mtime when no `created:` frontmatter, so the sidebar's
                // newest-first sort still has a usable key.
                if (!dateCreated) {
                    try { dateCreated = nfs.statSync(fullPath).mtime.toISOString(); } catch {}
                }
                out.push({ id, title, status: kanbanColumn || '', filePath: fullPath, url: '', dateCreated, assignees, priority });
            }
        }
    }

    private _findLocalTicketFile(dir: string, provider: string, id: string): string | null {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const nfs = require('fs') as typeof import('fs');
        let entries: import('fs').Dirent[];
        try { entries = nfs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const found = this._findLocalTicketFile(fullPath, provider, id);
                if (found) { return found; }
            } else if (entry.isFile() && entry.name.startsWith(`${provider}_${id}_`) && entry.name.endsWith('.md')) {
                return fullPath;
            }
        }
        return null;
    }

    private _setupTicketsViewWatcher(workspaceRoot: string): void {
        if (this._ticketsViewWatcher) {
            try { this._ticketsViewWatcher.dispose(); } catch { }
            this._ticketsViewWatcher = undefined;
        }
        for (const t of this._ticketsViewWatcherDebounces.values()) { clearTimeout(t); }
        this._ticketsViewWatcherDebounces.clear();

        const watchFolders: string[] = [];
        const clickup = GlobalIntegrationConfigService.loadConfigSync('clickup');
        if (clickup?.ticketSaveLocation) {
            watchFolders.push(clickup.ticketSaveLocation);
        }
        const linear = GlobalIntegrationConfigService.loadConfigSync('linear');
        if (linear?.ticketSaveLocation) {
            watchFolders.push(linear.ticketSaveLocation);
        }
        watchFolders.push(path.join(workspaceRoot, '.switchboard/tickets'));

        const handleTicketFileEvent = (filePath: string) => {
            const fileName = path.basename(filePath);
            const match = fileName.match(/^(linear|clickup)_([^_]+)_.*\.md$/);
            if (!match) { return; }
            const [, provider, id] = match;

            const key = filePath;
            const existing = this._ticketsViewWatcherDebounces.get(key);
            if (existing) { clearTimeout(existing); }
            this._ticketsViewWatcherDebounces.set(key, setTimeout(() => {
                this._ticketsViewWatcherDebounces.delete(key);
                try {
                    const nfs = require('fs') as typeof import('fs');
                    const raw = nfs.readFileSync(filePath, 'utf8');
                    const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
                    const h1 = content.match(/^#\s+(.+)$/m);
                    const title = h1 ? h1[1].trim() : id;
                    const displayContent = this._rewriteLocalImagePaths(
                        stripImportedSubtasksBlock(content), path.dirname(filePath)
                    );
                    // rawContent preserves original local paths for edit mode + push flow;
                    // content holds rewritten webview URIs for preview only.
                    this.postMessageToWebview({ type: 'ticketFileChanged', provider, id, title, content: displayContent, rawContent: content });
                } catch { }
            }, 300));
        };

        const watchers: HostWatchHandle[] = [];
        for (const folder of watchFolders) {
            if (!fs.existsSync(folder)) { continue; }
            const watcher = this._seams().watcher.watchFolder(folder, (event, filePath) => {
                if (!filePath.endsWith('.md')) { return; }
                handleTicketFileEvent(filePath);
            });
            watchers.push(watcher);
        }

        this._ticketsViewWatcher = {
            dispose: () => watchers.forEach(w => { try { w.dispose(); } catch { } })
        };
        this._disposables.push(this._ticketsViewWatcher);
    }

    public postMessage(message: any): void {
        this.postMessageToWebview(message);
        this.postMessageToProjectWebview(message);
    }

    public dispose(): void {
        this.stopPeriodicSync();
        if (this._activeDocWatchDebounce) {
            clearTimeout(this._activeDocWatchDebounce);
            this._activeDocWatchDebounce = undefined;
        }
        if (this._activeDocWatcher) {
            try { this._activeDocWatcher.dispose(); } catch (e) {}
            this._activeDocWatcher = undefined;
        }
        for (const watcher of this._antigravityWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._antigravityWatchers = [];
        for (const watcher of this._localFolderWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._localFolderWatchers = [];
        if (this._localDocsDebounce) {
            clearTimeout(this._localDocsDebounce);
            this._localDocsDebounce = undefined;
        }
        for (const watcher of this._planningHtmlFolderWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._planningHtmlFolderWatchers = [];
        if (this._planningHtmlDocsDebounce) {
            clearTimeout(this._planningHtmlDocsDebounce);
            this._planningHtmlDocsDebounce = undefined;
        }
        for (const [, entry] of this._planningHtmlServers) {
            clearTimeout(entry.timeoutId);
            try { entry.server.close(); } catch {}
        }
        this._planningHtmlServers.clear();
        this._planningHtmlServerCreationPromises.clear();
        if (this._kanbanPlansWatchDebounce) {
            clearTimeout(this._kanbanPlansWatchDebounce);
            this._kanbanPlansWatchDebounce = undefined;
        }
        for (const watcher of this._kanbanPlansWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._kanbanPlansWatchers = [];
        if (this._featureDocsWatchDebounce) {
            clearTimeout(this._featureDocsWatchDebounce);
            this._featureDocsWatchDebounce = undefined;
        }
        for (const watcher of this._featureDocsWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._featureDocsWatchers = [];
        if (this._insightsWatchDebounce) {
            clearTimeout(this._insightsWatchDebounce);
            this._insightsWatchDebounce = undefined;
        }
        for (const watcher of this._insightsWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._insightsWatchers = [];

        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
        if (this._panel) {
            this._panel.dispose();
            this._panel = undefined;
        }
        // If the project panel is still open, its onDidDispose listener was just
        // removed by clearing _disposables above. Re-register it so _projectPanel
        // is cleared when that panel is eventually closed.
        if (this._projectPanel) {
            // Re-register the onDidDispose listener with FULL cleanup — mirror the
            // original handler registered in openProject() (line 379-390). The previous
            // re-registration only nulled _projectPanel, leaving _projectPanelReady
            // and _pendingProjectMessages stale. If the Project panel reopens later,
            // stale pending messages could flush into the fresh panel.
            this._disposables.push(
                this._projectPanel.onDidDispose(() => {
                    this._projectPanel = undefined;
                    this._projectPanelReady = false;
                    this._projectPanelOpening = undefined;
                    this._projectPanelRestoring = false;
                    this._pendingProjectMessages = [];
                    if (this._projectPanelReadyTimer) {
                        clearTimeout(this._projectPanelReadyTimer);
                        this._projectPanelReadyTimer = undefined;
                    }
                })
            );
            // CRITICAL: Also re-register the message handler. dispose() cleared
            // _disposables above, which disposed the original onDidReceiveMessage
            // subscription. Without this, the Project panel becomes a zombie —
            // still visible but the backend can no longer receive messages from it.
            // This is the root cause of "copy prompt buttons don't work" and
            // "all previews stopped working" after the Planning panel is closed.
            this._disposables.push(
                this._projectPanel.webview.onDidReceiveMessage(
                    async (message: any) => {
                        try {
                            await this._handleMessage(message, true);
                        } catch (err) {
                            console.error('[ProjectPanel] Message handler error (re-registered):', err);
                            this.postMessageToProjectWebview({ type: 'error', message: String(err) });
                        }
                    }
                )
            );
        }
        // Reset the webview-roots dedup guard so a subsequent open() on a brand-new panel
        // reassigns webview.options (incl. enableScripts) instead of short-circuiting on a
        // stale signature left over from the disposed panel.
        this._lastWebviewRootsSignature = '';
    }

    private async _getKanbanPlans(workspaceRoot: string): Promise<KanbanPlanSummary[]> {
        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        const workspaceId = await this._getWorkspaceId(workspaceRoot);
        const records = await db.getBoard(workspaceId);
        const completedLimit = Math.max(1, Math.min(
            this._seams().pathConfig.getConfigNumber('kanban.completedLimit', 100),
            500
        ));
        const completedRecords = await db.getCompletedPlans(workspaceId, completedLimit);
        const allRecords = [...records, ...completedRecords];
        
        const subtaskCountMap = new Map<string, number>();
        for (const r of allRecords) {
            if (r.featureId) {
                subtaskCountMap.set(r.featureId, (subtaskCountMap.get(r.featureId) || 0) + 1);
            }
        }

        allRecords.sort((a, b) => {
            const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return bTime - aTime;
        });

        // Resolve to the effective (mapped parent) root so that plan.workspaceRoot
        // matches the workspaceItems dropdown values sent to the webview.
        const effectiveRoot = this._resolveEffectiveWorkspaceRoot(workspaceRoot);

        // Derive the label from _buildKanbanWorkspaceItems() so it uses the
        // configured mapping name (not the raw VSCode folder name).
        const wsLabel = this._buildKanbanWorkspaceItems().find(
            item => item.workspaceRoot === effectiveRoot
        )?.label || path.basename(effectiveRoot);

        return allRecords.map((r: any) => ({
            planId: r.planId,
            sessionId: r.sessionId || '',
            topic: r.topic || path.basename(r.planFile || '') || 'Untitled',
            column: r.kanbanColumn,
            workspaceRoot: effectiveRoot,
            workspaceLabel: wsLabel,
            project: r.project || '',
            repoScope: r.repoScope || '',
            mtime: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
            planFile: r.planFile || '',
            complexity: r.complexity || 'Unknown',
            isFeature: r.isFeature,
            featureId: r.featureId || '',
            subtaskCount: r.isFeature ? (subtaskCountMap.get(r.planId) || 0) : undefined,
            clickupTaskId: r.clickupTaskId || r.clickup_task_id || '',
            linearIssueId: r.linearIssueId || r.linear_issue_id || ''
        }));
    }

    private async _getKanbanColumnDefinitions(workspaceRoot: string, plans?: KanbanPlanSummary[]): Promise<KanbanColumnDefinition[]> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        let customAgents: CustomAgentConfig[] = [];
        let customKanbanColumns: CustomKanbanColumnConfig[] = [];
        // Build built-in role defaults matching KanbanProvider._getVisibleAgents
        const visibleAgentDefaults: Record<string, boolean> = {
            lead: true, coder: true, intern: true, reviewer: true,
            tester: false, planner: true, analyst: true, jules: false,
            ticket_updater: false, researcher: false
        };
        let visibleAgents: Record<string, boolean> = { ...visibleAgentDefaults };
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            if (Array.isArray(state.customAgents)) {
                customAgents = state.customAgents.filter((a: any) => a && a.role && a.name);
            }
            if (Array.isArray(state.customKanbanColumns)) {
                customKanbanColumns = state.customKanbanColumns.filter((c: any) => c && c.id && c.label);
            }
            // Custom agents default to visible, matching KanbanProvider behavior
            const parsedCustomAgents = parseCustomAgents(state.customAgents);
            for (const agent of parsedCustomAgents) {
                visibleAgentDefaults[agent.role] = true;
            }
            // Merge: defaults + custom-agent defaults, then overlay persisted toggles
            visibleAgents = { ...visibleAgentDefaults, ...(state.visibleAgents || {}) };
        } catch {
            // No state file or parse error — use defaults
        }
        const allColumns = buildKanbanColumns(customAgents, customKanbanColumns);
        if (!allColumns.some(c => c.id === 'BACKLOG')) {
            allColumns.push({
                id: 'BACKLOG',
                label: 'Backlog',
                order: 5,
                kind: 'created' as const,
                source: 'built-in' as const,
                autobanEnabled: false,
                dragDropMode: 'cli'
            });
            allColumns.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
        }
        const occupiedColumns = new Set(plans?.map(p => p.column) || []);
        return allColumns.filter(col => {
            if (col.featureOnly) return occupiedColumns.has(col.id);
            if (!col.role) return true;
            if (visibleAgents[col.role] !== false) return true;
            return occupiedColumns.has(col.id);
        });
    }


}
