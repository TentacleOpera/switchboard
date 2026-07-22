
import { HostSeams, HostWatchHandle, TerminalHandle, createVscodeHostSeams } from './hostSeams';
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
import { KanbanDatabase } from './KanbanDatabase';
import * as http from 'http';
import { fileURLToPath, pathToFileURL } from 'url';
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
import { getProjectPrdPath, sanitizeProjectSlug, buildPrdBuilderPrompt } from './prdUtils';
import { PlanAutoFetchService } from './PlanAutoFetchService';
import { classifyHttpError } from './errorMessages';
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

export class PlanningPanelProvider {

    public async handleServiceVerb(verb: string, payload: any): Promise<any> {
        if (!this._broadcaster) {
            this._initPlanningService();
        }
        // Memo verbs (Feature: Headless Browser UI · Memo subtask): the memo
        // capture UI was relocated from implementation.html (TaskViewer panel)
        // to project.html (Planning/Project panel). The verb handlers still
        // live on TaskViewerProvider (they're file I/O + planner dispatch),
        // so delegate to it when project.html posts a memo verb. The verbs are
        // in TASKVIEWER_VERBS, not PLANNING_VERBS — without this delegation the
        // PLANNING_VERBS guard below would reject them.
        if (verb === 'memoLoad' || verb === 'memoSave' || verb === 'memoClear' || verb === 'memoGeneratePrompt') {
            if (this._taskViewerProvider) {
                return this._taskViewerProvider.handleServiceVerb(verb, payload);
            }
            throw new Error(`Memo verb '${verb}' requires TaskViewerProvider, which is not attached.`);
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
            this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: null });
        } else {
            this._broadcaster.setWebview(this._panel?.webview);
        }
    }

    public setApiServer(server: any): void {
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
    private _ticketsAutoSyncWatchers: Map<string, HostWatchHandle> = new Map();
    private _ticketsViewWatcher: HostWatchHandle | undefined;
    private _ticketsViewWatcherDebounces: Map<string, NodeJS.Timeout> = new Map();
    private _ticketsAutoSyncDebounces: Map<string, NodeJS.Timeout> = new Map();
    // Delta-pull timer (auto-sync ON only). Runs the delta pull on a 45s
    // interval for the currently-selected list/project. Torn down on
    // toggle-off or dispose. Rate-limit aware: exponential backoff on
    // consecutive failures, cap at 5 then pause until next toggle cycle.
    private _ticketsAutoSyncTimers: Map<string, NodeJS.Timeout> = new Map();
    private _ticketsAutoSyncFailures: Map<string, number> = new Map();
    // Exponential backoff: after N consecutive failures, the next eligible
    // tick time is set to now + INTERVAL * 2^N. Reset to 0 on success.
    private _ticketsAutoSyncNextEligible: Map<string, number> = new Map();
    // Tracks the currently-selected list/project per workspace root so the
    // delta-pull timer knows what to poll. Updated by refreshTicketsDelta
    // and importAllTickets handlers.
    private _ticketsCurrentSelection: Map<string, { provider: string; listId?: string; projectId?: string }> = new Map();
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
    private _planAutoFetchService?: PlanAutoFetchService;
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

    public setPlanAutoFetchService(service: PlanAutoFetchService): void {
        this._planAutoFetchService = service;
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

    private async _doOpenProject(): Promise<void> {
        this._lastWebviewRootsSignature = '';
        if (this._projectPanel) {
            this._projectPanel.reveal(undefined, true);
            return;
        }

        this._projectPanel = vscode.window.createWebviewPanel(
            'switchboard-project',
            'PROJECT',
            vscode.ViewColumn.One,
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

        this._projectPanel.webview.html = this._getProjectHtml(this._projectPanel.webview);

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

        if (this._planAutoFetchService) {
            const wsRoot = this._getWorkspaceRoot() || (this._getWorkspaceRoots()[0]);
            if (wsRoot) {
                const status = this._planAutoFetchService.getStatus(wsRoot);
                this.postMessageToProjectWebview({
                    type: 'planAutoFetchState',
                    ...status
                });
            }
        }
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
            if (e.affectsConfiguration('switchboard.planAutoFetch') && this._planAutoFetchService && this._projectPanel) {
                const wsRoot = this._getWorkspaceRoot() || (this._getWorkspaceRoots()[0]);
                if (wsRoot) {
                    const status = this._planAutoFetchService.getStatus(wsRoot);
                    this.postMessageToProjectWebview({ type: 'planAutoFetchState', ...status });
                }
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

    public async open(): Promise<void> {
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
            this._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-planning',
            'ARTIFACTS',
            vscode.ViewColumn.One,
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

        this._panel.webview.html = this._getHtml(this._panel.webview);

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
        this._panel = panel;
        await this._hydratePanel(this._panel, false);
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
        this._projectPanel = panel;
        await this._hydratePanel(this._projectPanel, true);
    }

    private async _hydratePanel(
        panel: vscode.WebviewPanel,
        isProject: boolean
    ): Promise<void> {
        // Critical: set localResourceRoots so the webview can load scripts.
        // Reset the dedup guard first (mirrors open()/openProject()). Without this,
        // when BOTH the Planning and Project panels are restored in the same session,
        // the first _hydratePanel() caches the roots signature, and the second call
        // short-circuits in _updateWebviewRoots() — leaving the second panel's
        // webview.options (enableScripts + localResourceRoots) unset and its scripts
        // blocked (stuck on "Loading…").
        this._lastWebviewRootsSignature = '';
        this._updateWebviewRoots();

        panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
        panel.webview.html = isProject
            ? this._getProjectHtml(panel.webview)
            : this._getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(
            async (msg) => {
                try {
                    await this._handleMessage(msg, isProject);
                } catch (err) {
                    console.error(`[${isProject ? 'ProjectPanel' : 'PlanningPanel'}] Message handler error:`, err);
                    this._pushTo(panel, 'planning', { type: 'error', message: String(err) });
                }
            },
            null,
            this._disposables
        );

        if (!isProject) {
            this._initPlanningService();
        }

        // Use the same dispose semantics as open(): for the planning panel,
        // dispose all shared resources; for project panel, full cleanup mirroring
        // openProject()'s onDidDispose (line 382-394) — null the ref, reset ready
        // state, clear pending messages, and kill the ready timer. The previous
        // version only nulled _projectPanel, leaving stale ready state that caused
        // postMessageToProjectWebview to silently drop messages (no-op via optional
        // chaining) instead of queueing them during the close→reopen window.
        if (isProject) {
            panel.onDidDispose(() => {
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
            }, null, this._disposables);

            panel.onDidChangeViewState(
                (e) => {
                    if (e.webviewPanel.visible) {
                        this.postMessageToProjectWebview({ type: 'refreshKanbanPlans' });
                    }
                },
                null,
                this._disposables
            );
        } else {
            panel.onDidDispose(() => {
                this._broadcaster?.setWebview(null);
                this.dispose();
            }, null, this._disposables);
        }

        const theme = this._seams().pathConfig.getConfigStringWithDefault('theme.name', 'afterburner');
        this._pushTo(panel, 'planning', { type: 'switchboardThemeChanged', theme });
        const disabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberAnimation', false);
        this._pushTo(panel, 'planning', { type: 'cyberAnimationSetting', disabled });
        const scanlinesDisabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberScanlines', false);
        this._pushTo(panel, 'planning', { type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });

        // For the Planning (non-Project) panel, replicate the live-update listeners and file
        // watchers that open() registers, so a RESTORED panel auto-refreshes on external
        // file/theme/workspace changes instead of going stale until the user reopens it.
        // (Adapters self-register lazily in _handleMessage; periodic sync is intentionally NOT
        // started here — deferred to the next explicit open() to avoid duplicate sync jobs.)
        if (!isProject) {
            this._disposables.push(
                vscode.window.onDidChangeActiveColorTheme(() => {
                    this.postMessageToWebview({ type: 'themeChanged' });
                })
            );

            this._disposables.push(
                vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
                        const animDisabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberAnimation', false);
                        this.postMessageToWebview({ type: 'cyberAnimationSetting', disabled: animDisabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
                        const scanlinesDisabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberScanlines', false);
                        this.postMessageToWebview({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.name')) {
                        const themeName = this._seams().pathConfig.getConfigStringWithDefault('theme.name', 'afterburner');
                        this.postMessageToWebview({ type: 'switchboardThemeChanged', theme: themeName });
                    }
                    if (e.affectsConfiguration('switchboard.theme.ultracodeAnimation')) {
                        const enabled = this._seams().pathConfig.getConfigBoolean('theme.ultracodeAnimation', false);
                        this.postMessageToWebview({ type: 'ultracodeAnimationSetting', enabled });
                    }
                })
            );
        } else {
            this._registerProjectPanelConfigListener();
        }

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

            const allRoots = this._getWorkspaceRoots();
            const workspaceRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);
            this._setupDocsFolderWatcher(workspaceRoot);
            this._setupLocalFolderWatchers();
            this._setupAntigravityWatcher();
            this._setupKanbanPlansWatcher();
            this._setupFeatureDocsWatcher();
            this._setupConstitutionWatcher();
            this._setupInsightsWatcher();
    }


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

    private async _sendPromptToTerminal(promptText: string, wsRoot: string, name: string, searchSubstrings: string[]): Promise<void> {
        let handle: TerminalHandle | null = null;
        for (const sub of searchSubstrings) {
            handle = this._seams().terminal.findByNameContains(sub);
            if (handle) { break; }
        }
        if (!handle) {
            handle = this._seams().terminal.create(name, undefined, wsRoot);
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
   Follow instructions in \`.agents/skills/constitution-builder/SKILL.md\`.

3. **System Files** — \`CLAUDE.md\` and \`AGENTS.md\`
   These are agent governance files. Help the user write rules that agents should follow when working in this repo.

4. **Tuning Insights** — \`.switchboard/insights/*.md\`
   Follow instructions in \`.agents/skills/tuning/SKILL.md\`.

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


    private async _handleFetchKanbanPlanPreview(filePath: string, requestId: number): Promise<void> {
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
    }): Promise<void> {
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

            let fileContent = '';
            let webviewUri: string | undefined;
            if (isImage) {
                webviewUri = this._panel?.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
            } else {
                fileContent = await fs.promises.readFile(absPath, 'utf8');
                if (isHtmlFile) {
                    webviewUri = this._panel?.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
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

            this.postMessageToWebview({
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
            });
        } catch (err: any) {
            if (requestId === -1) return;
            this.postMessageToWebview({
                type: 'previewError',
                sourceId,
                requestId,
                error: err.message || String(err)
            });
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

                if (!this._panel) return;

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

    private async _getTicketsAutoSync(root: string): Promise<boolean> {
        const globalConfig = await GlobalIntegrationConfigService.loadGlobal();
        if (globalConfig.ticketsAutoSync === undefined) {
            const localService = this._getLocalFolderService(root);
            const localValue = localService.getTicketsAutoSync();
            if (localValue) {
                await GlobalIntegrationConfigService.setTicketsAutoSync(true);
                return true;
            }
            return false;
        }
        return globalConfig.ticketsAutoSync === true;
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
                if (!this._panel) { return match; } // headless — no webview URI rewriting
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
            case 'renderMarkdownLive': {
                try {
                    let content = msg.content || '';
                    // Tickets edit-preview: resolve the ticket file's directory and rewrite
                    // relative image paths to webview URIs (mirrors the view-mode path).
                    // Non-ticket editor mounts send no provider/id → no rewrite.
                    if (msg.provider && msg.id) {
                        const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                        const ticketFilePath = await this._findTicketFilePath(wsRoot, msg.provider, msg.id);
                        if (ticketFilePath) {
                            content = this._rewriteLocalImagePaths(content, path.dirname(ticketFilePath));
                        }
                    }
                    const html = await this._seams().commands.executeCommand<string>('markdown.api.render', content);
                    const targetPanel = isProject ? this._projectPanel : this._panel;
                    this._pushTo(targetPanel, 'planning', {
                        type: 'markdownLiveRendered',
                        requestId: msg.requestId,
                        html: html,
                        htmlContent: html
                    });
                } catch (err) {
                    const targetPanel = isProject ? this._projectPanel : this._panel;
                    this._pushTo(targetPanel, 'planning', {
                        type: 'markdownLiveRendered',
                        requestId: msg.requestId,
                        html: '',
                        htmlContent: '',
                        error: String(err)
                    });
                }
                break;
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

                await this._handleFetchRoots(true);

                // Send integration provider preference
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
                    const ticketsAutoSync = await this._getTicketsAutoSync(workspaceRoot);
                    if (provider) { this._updateTicketsAutoSyncWatcher(workspaceRoot, ticketsAutoSync); }
                    this.postMessageToWebview({
                        type: 'integrationProviderStates',
                        clickupSetupComplete,
                        linearSetupComplete,
                        provider,
                        ticketsAutoSync
                    });
                } catch (err) {
                    console.warn('[PlanningPanel] Failed to determine integration provider states:', err);
                }
                break;
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

            case 'setupTicketsWatcher': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (root) { this._setupTicketsViewWatcher(root); }
                break;
            }
            case 'ticketsDefaultRoot': {
                const restoredRoot = this._stateStore.getPanelState<string>('tickets.root');
                const allowedRoots = buildWorkspaceItems(allRoots).map(item => item.workspaceRoot);
                const kanbanRoot = this._kanbanProvider?.getCurrentWorkspaceRoot() || null;
                let defaultRoot: string | undefined;

                if (restoredRoot && allowedRoots.includes(restoredRoot)) {
                    defaultRoot = restoredRoot;
                } else if (kanbanRoot && allowedRoots.includes(kanbanRoot)) {
                    defaultRoot = kanbanRoot;
                } else if (allowedRoots.length > 0) {
                    defaultRoot = allowedRoots[0];
                } else {
                    defaultRoot = allRoots[0];
                }

                // Determine provider globally
                let defaultProvider: 'clickup' | 'linear' | null = null;
                try {
                    const probeRoot = defaultRoot || allRoots[0];
                    if (probeRoot) {
                        const [clickUpConfig, linearConfig] = await Promise.all([
                            this._adapterFactories.getClickUpSyncService(probeRoot).loadConfig(),
                            this._adapterFactories.getLinearSyncService(probeRoot).loadConfig()
                        ]);
                        defaultProvider = (clickUpConfig?.setupComplete) ? 'clickup'
                            : (linearConfig?.setupComplete) ? 'linear'
                            : null;
                    }
                } catch {}

                this.postMessageToWebview({
                    type: 'ticketsDefaultRoot',
                    workspaceRoot: defaultRoot,
                    provider: defaultProvider
                });
                break;
            }
            case 'ticketsRootChanged': {
                const root = msg.workspaceRoot;
                if (root && allRoots.includes(root)) {
                    try {
                        const [clickUpConfig, linearConfig] = await Promise.all([
                            this._adapterFactories.getClickUpSyncService(root).loadConfig(),
                            this._adapterFactories.getLinearSyncService(root).loadConfig()
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
                        const ticketsAutoSync = await this._getTicketsAutoSync(root);
                        if (provider) { this._updateTicketsAutoSyncWatcher(root, ticketsAutoSync); }
                        this._setupTicketsViewWatcher(root);
                        this.postMessageToWebview({
                            type: 'integrationProviderStates',
                            clickupSetupComplete,
                            linearSetupComplete,
                            provider,
                            ticketsAutoSync
                        });
                    } catch (err) {
                        console.warn('[PlanningPanel] Failed to determine integration preference for root:', root, err);
                    }
                }
                break;
            }
            case 'switchTicketsProvider': {
                const { provider, workspaceRoot } = msg;
                if (workspaceRoot && (provider === 'clickup' || provider === 'linear')) {
                    this._activeTicketsProvider = provider;
                    try {
                        const [clickUpConfig, linearConfig] = await Promise.all([
                            this._adapterFactories.getClickUpSyncService(workspaceRoot).loadConfig(),
                            this._adapterFactories.getLinearSyncService(workspaceRoot).loadConfig()
                        ]);
                        const clickupSetupComplete = clickUpConfig?.setupComplete === true;
                        const linearSetupComplete = linearConfig?.setupComplete === true;
                        const ticketsAutoSync = await this._getTicketsAutoSync(workspaceRoot);
                        if (provider) { this._updateTicketsAutoSyncWatcher(workspaceRoot, ticketsAutoSync); }
                        this.postMessageToWebview({
                            type: 'integrationProviderStates',
                            clickupSetupComplete,
                            linearSetupComplete,
                            provider,
                            ticketsAutoSync
                        });
                    } catch (err) {
                        console.warn('[PlanningPanel] Failed to switch ticket provider:', err);
                    }
                }
                break;
            }
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
                await this._handleFetchChildren(workspaceRoot, msg.sourceId, msg.parentId);
                break;
            }
            case 'fetchPreview': {
                await this._handleFetchPreview(workspaceRoot, msg.sourceId, msg.docId, msg.requestId, msg.sourceFolder);
                break;
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
                await this._handleFetchPageContent(workspaceRoot, msg.sourceId, msg.docId, msg.pageId, msg.requestId);
                break;
            }
            case 'fetchAntigravityArtifact': {
                const artifactPath = msg.artifactPath;
                const requestId = msg.requestId || -1;
                const allRoots = this._getWorkspaceRoots();
                const service = this._getLocalFolderService(allRoots[0] || '');
                const result = await service.fetchAntigravityArtifact(artifactPath);
                if (result.success) {
                    this.postMessageToWebview({
                        type: 'previewReady',
                        sourceId: 'antigravity',
                        requestId,
                        content: result.content || '',
                        docName: path.basename(artifactPath, '.md')
                    });
                } else {
                    this.postMessageToWebview({
                        type: 'previewError',
                        sourceId: 'antigravity',
                        requestId,
                        error: result.error || 'Failed to load artifact'
                    });
                }
                break;
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
                this.postMessageToWebview({ type: 'localFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'addTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const result = await this._seams().ui.showOpenDialog({
                    openLabel: 'Add Tickets Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addTicketsFolderPath(result[0]);
                    await this._sendLocalDocsReady(true);
                    this.postMessageToWebview({ type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                await service.removeTicketsFolderPath(msg.folderPath);
                await this._sendLocalDocsReady(true);
                this.postMessageToWebview({ type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                break;
            }
            case 'listTicketsFolders': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                const paths = service.getTicketsFolderPaths();
                this.postMessageToWebview({ type: 'ticketsFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'saveTicketsFolderPaths': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                const config = await service.loadFolderPathsConfig();
                config.ticketsFolderPaths = msg.paths || [];
                await service.saveFolderPathsConfig(config);
                await this._sendLocalDocsReady(true);
                this.postMessageToWebview({ type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                break;
            }
            case 'browseTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const result = await this._seams().ui.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    openLabel: 'Select Tickets Folder'
                });
                if (result && result.length > 0) {
                    this.postMessageToWebview({ type: 'browseTicketsFolderResult', path: result[0], workspaceRoot: root });
                }
                break;
            }
            case 'saveTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                const config = await service.loadFolderPathsConfig();
                const folderPath = String(msg.folderPath || '').trim();
                if (folderPath) {
                    config.ticketsFolderPaths = [folderPath];
                } else {
                    config.ticketsFolderPaths = [];
                }
                await service.saveFolderPathsConfig(config);
                await this._sendLocalDocsReady(true);
                this.postMessageToWebview({ type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                break;
            }

            case 'listPlanningHtmlFolders': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                const paths = service.getPlanningHtmlFolderPaths();
                this.postMessageToWebview({ type: 'planningHtmlFoldersListed', paths, workspaceRoot: root });
                break;
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
                    this.postMessageToWebview({ type: 'containersReady', sourceId, containers: [] });
                    break;
                }
                try {
                    const containers = await adapter.listContainers();
                    this.postMessageToWebview({ type: 'containersReady', sourceId, containers });
                } catch {
                    this.postMessageToWebview({ type: 'containersReady', sourceId, containers: [] });
                }
                break;
            }
            case 'fetchImportedDocs': {
                await this._handleFetchImportedDocs(workspaceRoot);
                break;
            }
            case 'fetchDocsFile': {
                await this._handleFetchDocsFile(workspaceRoot, msg.slugPrefix, msg.requestId);
                break;
            }
            case 'syncToSource': {
                await this._handleSyncToSource(workspaceRoot, msg.slugPrefix);
                break;
            }
            case 'fetchFilteredDocs': {
                const sourceId = msg.sourceId;
                const containerId = msg.containerId;
                const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
                // Race guard — same Map, namespaced key
                const filterKey = `filter:${sourceId}`;
                if (requestId <= (this._latestRequestIds.get(filterKey) || 0)) { break; }
                this._latestRequestIds.set(filterKey, requestId);

                const adapter = this._researchImportService.getAdapter(sourceId);
                if (!adapter) {
                    this.postMessageToWebview({ type: 'filteredDocsReady', sourceId, nodes: [], requestId });
                    break;
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
                    // Drop if stale
                    if (requestId !== this._latestRequestIds.get(filterKey)) { break; }
                    this.postMessageToWebview({ type: 'filteredDocsReady', sourceId, nodes, requestId });
                } catch {
                    if (requestId === this._latestRequestIds.get(filterKey)) {
                        this.postMessageToWebview({ type: 'filteredDocsReady', sourceId, nodes: [], requestId });
                    }
                }
                break;
            }
            case 'fetchDocPages': {
                const sourceId = msg.sourceId;
                const docId = msg.docId;
                const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
                // Race guard
                const pagesKey = `pages:${sourceId}:${docId}`;
                if (requestId <= (this._latestRequestIds.get(pagesKey) || 0)) { break; }
                this._latestRequestIds.set(pagesKey, requestId);

                const adapter = this._researchImportService.getAdapter(sourceId);

                if (!adapter || !adapter.listDocPages) {
                    this.postMessageToWebview({ type: 'docPagesReady', sourceId, docId, pages: [], requestId });
                    break;
                }

                try {
                    const pages = await adapter.listDocPages(docId);
                    // Drop if stale
                    if (requestId !== this._latestRequestIds.get(pagesKey)) { break; }
                    this.postMessageToWebview({ type: 'docPagesReady', sourceId, docId, pages, requestId });
                } catch {
                    if (requestId === this._latestRequestIds.get(pagesKey)) {
                        this.postMessageToWebview({ type: 'docPagesReady', sourceId, docId, pages: [], requestId });
                    }
                }
                break;
            }
            case 'fetchPageContent': {
                const sourceId = msg.sourceId;
                const docId = msg.docId;
                const pageId = msg.pageId;
                const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
                // Race guard — reuse source-keyed tracking from fetchPreview
                if (requestId <= (this._latestRequestIds.get(sourceId) || 0)) { break; }
                this._latestRequestIds.set(sourceId, requestId);

                const adapter = this._researchImportService.getAdapter(sourceId);
                if (!adapter || !adapter.fetchPageContent) {
                    this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: 'Adapter does not support page content' });
                    break;
                }

                try {
                    const result = await adapter.fetchPageContent(docId, pageId);
                    if (requestId !== this._latestRequestIds.get(sourceId)) { break; }
                    if (result.success) {
                        this.postMessageToWebview({ type: 'previewReady', sourceId, requestId, content: result.content, docName: result.docName });
                    } else {
                        this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: result.error });
                    }
                } catch (err) {
                    if (requestId === this._latestRequestIds.get(sourceId)) {
                        this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: String(err) });
                    }
                }
                break;
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
                this.postMessageToWebview({
                    type: 'createPlansState',
                    hasDocs,
                    publicUrl: this._stateStore.getPanelState<string>('createPlans.publicUrl') || '',
                    platform: this._stateStore.getPanelState<string>('createPlans.platform') || 'Notion',
                    platformRef: this._stateStore.getPanelState<string>('createPlans.platformRef') || ''
                });
                break;
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
                    this.postMessageToWebview({ type: 'createPlansFolderPicked', folder });
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
                    this.postMessageToWebview({ type: 'createPlansPasteBackResult', ok: false, error: 'Paste a markdown plan first.' });
                    break;
                }
                if (markdown.length > 200_000) {
                    this.postMessageToWebview({ type: 'createPlansPasteBackResult', ok: false, error: 'Plan is too large (>200 KB).' });
                    break;
                }
                // Pin to the board's active project when one is set; on any failure
                // to read the filter the plan lands unassigned (never invent a project).
                let cpProject: string | null = null;
                try { cpProject = this._kanbanProvider?.getProjectFilter() || null; } catch { cpProject = null; }
                try {
                    await this._seams().commands.executeCommand(
                        'switchboard.importPlanFromClipboard',
                        markdown,
                        cpProject ? { projectName: cpProject } : undefined
                    );
                    this.postMessageToWebview({ type: 'createPlansPasteBackResult', ok: true, projectName: cpProject });
                } catch (err) {
                    this.postMessageToWebview({ type: 'createPlansPasteBackResult', ok: false, error: err instanceof Error ? err.message : String(err) });
                }
                break;
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
                const wsRoot = owningRoot;
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
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.sendPromptToAgentTerminal('claude_artifacts', msg.prompt || '', msg.workspaceRoot);
                    const targetPanel = isProject ? this._projectPanel : this._panel;
                    this._pushTo(targetPanel, 'planning', { type: 'artifactPromptSent', kind: msg.kind });
                }
                break;
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
                    await this._taskViewerProvider.sendPromptToAgentTerminal('coder', prompt, msg.workspaceRoot || undefined);
                    this._seams().ui.showTemporaryNotification('Sent element tweak prompt to agent terminal.');
                } else {
                    await this._seams().clipboard.writeText(prompt);
                    this._seams().ui.showTemporaryNotification('Agent terminal unavailable — copied tweak prompt to clipboard instead.');
                }
                break;
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
            case 'setPlanAutoFetchEnabled': {
                try {
                    const wsRoot = this._getWorkspaceRoot() || (this._getWorkspaceRoots()[0]);
                    if (wsRoot) {
                        await this._seams().pathConfig.updateConfigWorkspace('planAutoFetch.enabled', msg.enabled);
                    }
                } catch (err) {
                    console.error('[PlanningPanel] setPlanAutoFetchEnabled error:', err);
                }
                break;
            }
            case 'planAutoFetchRunNow': {
                if (this._planAutoFetchService) {
                    const wsRoot = this._getWorkspaceRoot() || (this._getWorkspaceRoots()[0]);
                    if (wsRoot) {
                        this.postMessageToProjectWebview({
                            type: 'planAutoFetchState',
                            enabled: this._planAutoFetchService.getStatus(wsRoot).enabled,
                            lastOutcome: 'idle',
                            lastReason: 'Fetching now...',
                            resolvedBranch: this._planAutoFetchService.getStatus(wsRoot).resolvedBranch
                        });
                        await this._planAutoFetchService.runCycle();
                        const status = this._planAutoFetchService.getStatus(wsRoot);
                        this.postMessageToProjectWebview({
                            type: 'planAutoFetchState',
                            ...status
                        });
                    }
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
                    this.postMessageToProjectWebview({ type: 'kanbanPlanColumnChanged', success: false, error: 'Missing planFile or newColumn' });
                    break;
                }
                try {
                    const moved = await this._seams().commands.executeCommand<boolean>(
                        'switchboard.moveKanbanCardByPlanFile', wsRoot, planFile, newColumn
                    );
                    this.postMessageToProjectWebview({ type: 'kanbanPlanColumnChanged', success: !!moved, error: moved ? undefined : 'Column update failed' });
                } catch (err) {
                    this.postMessageToProjectWebview({ type: 'kanbanPlanColumnChanged', success: false, error: String(err) });
                }
                break;
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
                    return { success: false, ...errRes };
                }
                try {
                    const { SessionActionLog } = require('./SessionActionLog');
                    const log = new SessionActionLog(wsRoot);
                    const sheet = await log.getRunSheet(sessionId);
                    const events: any[] = Array.isArray(sheet?.events) ? sheet.events : [];
                    const entries = formatReviewLogEntries(events);
                    const okRes = { type: 'kanbanPlanLogReady', entries };
                    this.postMessageToProjectWebview(okRes);
                    return { success: true, ...okRes };
                } catch (err) {
                    const errRes = { type: 'kanbanPlanLogReady', entries: [], error: String(err) };
                    this.postMessageToProjectWebview(errRes);
                    return { success: false, ...errRes };
                }
            }
            case 'getFeatureDetails': {
                const sessionId = String(msg.sessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!sessionId || !wsRoot) {
                    const errRes = { type: 'featureDetails', feature: null, subtasks: [] };
                    this.postMessageToProjectWebview(errRes);
                    return { success: false, ...errRes };
                }
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    const feature = await db.getPlanByPlanId(sessionId);
                    const subtasks = feature && feature.isFeature ? await db.getSubtasksByFeatureId(feature.planId) : [];
                    const okRes = { type: 'featureDetails', feature, subtasks };
                    this.postMessageToProjectWebview(okRes);
                    return { success: true, ...okRes };
                } catch (err) {
                    const errRes = { type: 'featureDetails', feature: null, subtasks: [], error: String(err) };
                    this.postMessageToProjectWebview(errRes);
                    return { success: false, ...errRes };
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
                this.postMessageToProjectWebview({
                    type: 'constitutionFilesLoaded',
                    workspaces,
                    kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null
                });
                break;
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
                this.postMessageToProjectWebview({ type: 'constitutionStatus', status, planFile: msg.planFile, enabled, workspaceRoot: wr });
                break;
            }
            case 'readConstitutionFile': {
                const wsRoot = msg.workspaceRoot;
                const key = msg.governanceFile ?? 'constitution';
                if (!allRoots.includes(wsRoot)) {
                    this._postToBothPanels({
                        type: 'constitutionFileRead',
                        workspaceRoot: wsRoot,
                        governanceFile: key,
                        exists: false,
                        error: 'Invalid workspace root'
                    });
                    break;
                }
                const filePath = this._getGovernanceFilePath(wsRoot, key);
                if (fs.existsSync(filePath)) {
                    try {
                        const content = fs.readFileSync(filePath, 'utf8');
                        const renderedHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', content);
                        this._postToBothPanels({
                            type: 'constitutionFileRead',
                            workspaceRoot: wsRoot,
                            governanceFile: key,
                            filePath,
                            exists: true,
                            content,
                            renderedHtml
                        });
                    } catch (err) {
                        this._postToBothPanels({
                            type: 'constitutionFileRead',
                            workspaceRoot: wsRoot,
                            governanceFile: key,
                            exists: false,
                            error: String(err)
                        });
                    }
                } else {
                    this._postToBothPanels({
                        type: 'constitutionFileRead',
                        workspaceRoot: wsRoot,
                        governanceFile: key,
                        exists: false
                    });
                }
                break;
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
                    this._postToBothPanels({
                        type: 'projectPrdContent',
                        projectName: msg.projectName,
                        workspaceRoot: wsRoot,
                        content: renderedHtml,    // HTML for preview pane
                        rawContent,               // raw markdown for editor
                        exists,
                        path: filePath
                    });
                }
                break;
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
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
                    if (dispatched) { break; }
                }
                await this._sendPromptToTerminal(promptText, wsRoot, 'PRD Builder', ['planner', 'lead']);
                break;
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
                const promptText = `Follow instructions in .agents/skills/constitution-builder/SKILL.md to build or improve CONSTITUTION.md in this project.`;
                // Try dispatching via the planner role (gets rotation for free).
                // Fall back to ad-hoc terminal creation if no planner agent is registered.
                if (this._taskViewerProvider) {
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
                    if (dispatched) { break; }
                }
                await this._sendPromptToTerminal(promptText, wsRoot, 'Constitution Builder', ['planner', 'lead']);
                break;
            }
            case 'invokeConstitutionUpdater': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) {
                    break;
                }
                const promptText = `Follow instructions in .agents/skills/constitution-builder/SKILL.md to improve and update the existing CONSTITUTION.md in this project.`;
                if (this._taskViewerProvider) {
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
                    if (dispatched) { break; }
                }
                await this._sendPromptToTerminal(promptText, wsRoot, 'Constitution Builder', ['planner', 'lead']);
                break;
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
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
                    if (dispatched) { break; }
                }
                await this._sendPromptToTerminal(promptText, wsRoot, 'System Builder', ['planner', 'lead']);
                break;
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
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
                    if (dispatched) { break; }
                }

                // Fall back to ad-hoc terminal creation
                await this._sendPromptToTerminal(promptText, wsRoot, 'Switchboard Architect', ['architect', 'planner']);
                break;
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
                if (!allRoots.includes(wsRoot)) { break; }
                this.postMessageToProjectWebview({
                    type: 'constitutionPaths',
                    workspaceRoot: wsRoot,
                    paths: this._getConstitutionPathList(wsRoot),
                    active: this._activeConstitutionRel(wsRoot),
                });
                break;
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
            case 'linearLoadProject': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'linearProjectLoaded',
                        status: 'error',
                        issues: [],
                        message: 'No workspace open.',
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    break;
                }

                const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                const config = await linear.loadConfig();
                if (!config?.setupComplete) {
                    this.postMessageToWebview({
                        type: 'linearProjectLoaded',
                        status: 'setup-required',
                        issues: [],
                        message: 'Set up Linear in Setup before using the Project tab.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const issues = await linear.queryIssues({
                        search: typeof msg.search === 'string' ? msg.search : '',
                        stateId: typeof msg.stateId === 'string' ? msg.stateId : '',
                        limit: 100
                    });
                    const excludeNames = config.excludeProjectNames || [];
                    const includeNames = config.includeProjectNames || [];
                    const projectName = includeNames.length === 1 && excludeNames.length === 0
                        ? includeNames[0]
                        : includeNames.length > 0
                            ? `${includeNames.slice(0, 2).join(', ')}${includeNames.length > 2 ? '...' : ''}`
                            : `${config.teamName || 'Configured Linear Team'} (team-wide)`;
                    this.postMessageToWebview({
                        type: 'linearProjectLoaded',
                        status: 'loaded',
                        issues,
                        projectName,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'project',
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'linearLoadProjects': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'linearProjectsLoaded',
                        status: 'error',
                        projects: [],
                        message: 'No workspace open.',
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    break;
                }

                const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                const config = await linear.loadConfig();
                if (!config?.setupComplete) {
                    this.postMessageToWebview({
                        type: 'linearProjectsLoaded',
                        status: 'setup-required',
                        projects: [],
                        message: 'Set up Linear in Setup before using the Project tab.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const projects = await linear.getAvailableProjects();
                    this.postMessageToWebview({
                        type: 'linearProjectsLoaded',
                        status: 'loaded',
                        projects,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'project',
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'linearLoadTaskDetails': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                if (!workspaceRoot || !issueId) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: 'Select a Linear issue first.',
                        workspaceRoot: workspaceRoot || msg.workspaceRoot || undefined
                    });
                    break;
                }

                try {
                    const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                    const issue = await linear.getIssue(issueId);
                    let subtasks: any[] = [];
                    let comments: any[] = [];
                    let attachments: any[] = [];
                    if (issue) {
                        try { subtasks = await linear.getSubtasks(issueId); } catch (e) {
                            console.warn('[PlanningPanel] Failed to load Linear subtasks:', e);
                        }
                        try { comments = await linear.getComments(issueId); } catch (e) {
                            console.warn('[PlanningPanel] Failed to load Linear comments:', e);
                        }
                        try { attachments = await linear.getAttachments(issueId); } catch (e) {
                            console.warn('[PlanningPanel] Failed to load Linear attachments:', e);
                        }
                    }

                    if (!issue) {
                        this.postMessageToWebview({
                            type: 'linearError',
                            scope: 'task',
                            issueId,
                            error: `This Linear issue could not be found. It may have been deleted, or your token may lack access to it.`,
                            kind: 'deleted',
                            workspaceRoot
                        });
                        break;
                    }

                    let renderedDescriptionHtml = '';
                    const descriptionMd = (issue.description || '').trim() || 'No description provided.';
                    try {
                        renderedDescriptionHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', descriptionMd) || '';
                    } catch {
                        renderedDescriptionHtml = '';
                    }

                    this.postMessageToWebview({
                        type: 'linearTaskDetailsLoaded',
                        issue,
                        subtasks,
                        comments,
                        attachments,
                        renderedDescriptionHtml,
                        workspaceRoot
                    });
                } catch (error: any) {
                    const errMsg = error?.message || String(error);
                    const statusMatch = errMsg.match(/HTTP (\d{3})/);
                    const statusCode = typeof error?.statusCode === 'number'
                        ? error.statusCode
                        : (statusMatch ? Number(statusMatch[1]) : null);
                    const kind = statusCode != null ? classifyHttpError(statusCode) : 'generic';
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: errMsg,
                        kind,
                        workspaceRoot
                    });
                }
                break;
            }
            case 'linearSaveProjectSelection': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);

                try {
                    const config = await linear.loadConfig();
                    if (config) {
                        config.selectedProjectName = String(msg.projectName || '').trim();
                        await linear.saveConfig(config);
                    }
                } catch (error) {
                    console.error('Failed to save Linear project selection:', error);
                }
                break;
            }
            case 'clickupLoadSpaces': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const spaces = await clickUp.getSpaces();
                    this.postMessageToWebview({
                        type: 'clickupSpacesLoaded',
                        spaces,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: error instanceof Error ? error.message : 'Failed to load Spaces',
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupLoadFolders': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const folders = await clickUp.getFolders(msg.spaceId);
                    this.postMessageToWebview({
                        type: 'clickupFoldersLoaded',
                        spaceId: msg.spaceId,
                        folders,
                        directLists: await clickUp.getLists(msg.spaceId),
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: error instanceof Error ? error.message : 'Failed to load Folders',
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupLoadLists': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const lists = await clickUp.getLists(msg.spaceId, msg.folderId);
                    this.postMessageToWebview({
                        type: 'clickupListsLoaded',
                        spaceId: msg.spaceId,
                        folderId: msg.folderId,
                        lists,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: error instanceof Error ? error.message : 'Failed to load Lists',
                        workspaceRoot
                    });
                }
                break;
            }
            case 'invalidateClickUpCache': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                cacheService.invalidateTaskCache('clickup');
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                clickUp.clearTaskListIndex();
                break;
            }
            case 'clickupLoadProject': {
                const loadSeq = msg.loadSeq;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'clickupProjectLoaded',
                        status: 'error',
                        message: 'No workspace open.',
                        loadSeq,
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    break;
                }

                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                const config = await clickUp.loadConfig();

                if (!config?.setupComplete) {
                    this.postMessageToWebview({
                        type: 'clickupProjectLoaded',
                        status: 'setup-required',
                        message: 'ClickUp setup is incomplete. Please complete setup in the Setup panel.',
                        loadSeq,
                        workspaceRoot
                    });
                    break;
                }

                const listId = msg.listId || config.selectedListId;
                if (!listId) {
                    this.postMessageToWebview({
                        type: 'clickupProjectLoaded',
                        status: 'setup-required',
                        message: 'No list selected. Please select a Space, Folder, and List to view tasks.',
                        loadSeq,
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                    cacheService.invalidateTaskCache('clickup', listId);

                    const tasks = await clickUp.getListTasks(listId, {
                        includeClosed: msg.includeClosed || false,
                        archived: false
                    });

                    this.postMessageToWebview({
                        type: 'clickupProjectLoaded',
                        status: 'loaded',
                        tasks: tasks.map((t: any) => this._mapClickUpTaskToSidebar(t)),
                        listName: config.selectedListName || 'Unknown List',
                        loadSeq,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'project',
                        error: error instanceof Error ? error.message : 'Failed to load ClickUp project',
                        loadSeq,
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupLoadTaskDetails': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const details = await clickUp.getTaskDetails(msg.taskId);

                    let renderedDescriptionHtml = '';
                    const descriptionMd = (details.task.markdownDescription || details.task.description || '').trim() || 'No description provided.';
                    try {
                        renderedDescriptionHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', descriptionMd) || '';
                    } catch {
                        renderedDescriptionHtml = '';
                    }

                    this.postMessageToWebview({
                        type: 'clickupTaskDetailsLoaded',
                        task: this._mapClickUpTaskToSidebar(details.task),
                        subtasks: details.subtasks.map((s: any) => this._mapClickUpTaskToSidebar(s)),
                        comments: details.comments.map((c: any) => this._mapClickUpComment(c)),
                        attachments: details.attachments.map((a: any) => this._mapClickUpAttachment(a)),
                        renderedDescriptionHtml,
                        workspaceRoot
                    });
                } catch (error: any) {
                    const errMsg = error?.message || String(error);
                    const statusMatch = errMsg.match(/HTTP (\d{3})/);
                    const statusCode = typeof error?.statusCode === 'number'
                        ? error.statusCode
                        : (statusMatch ? Number(statusMatch[1]) : null);
                    const kind = statusCode != null ? classifyHttpError(statusCode) : 'generic';
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId: msg.taskId,
                        error: errMsg,
                        kind,
                        workspaceRoot
                    });
                }
                break;
            }
            case 'linearUpdateIssueLabels': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds : [];
                
                if (!workspaceRoot || !issueId) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: 'Invalid issue ID or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                    await linear.updateIssueLabels(issueId, labelIds);
                    this.postMessageToWebview({
                        type: 'linearLabelsUpdated',
                        issueId,
                        labelIds,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupUpdateTaskTags': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const taskId = String(msg.taskId || '').trim();
                const rawTags = Array.isArray(msg.tags) ? msg.tags : [];
                const tagNames = rawTags.map((t: any) => typeof t === 'string' ? t : String(t?.name || '')).filter(Boolean);

                if (!workspaceRoot || !taskId) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: 'Invalid task ID or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                    await clickUp.updateTask(taskId, { tags: tagNames });
                    this.postMessageToWebview({
                        type: 'clickupTagsUpdated',
                        taskId,
                        tags: tagNames,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'loadTicketAssignees': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider;
                const id = String(msg.id || '').trim();
                let listId = msg.listId ? String(msg.listId).trim() : '';

                if (!workspaceRoot || !id || !provider) {
                    this.postMessageToWebview({
                        type: 'ticketAssigneesError',
                        id,
                        provider,
                        error: 'Invalid request parameters.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    let members: any[] = [];
                    if (provider === 'linear') {
                        const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        members = await linear.getTeamMembers();
                    } else if (provider === 'clickup') {
                        const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        if (!listId) {
                            const task = await clickup.getTaskDetails(id);
                            if (task?.list?.id) {
                                listId = task.list.id;
                            }
                        }
                        if (listId) {
                            members = await clickup.getListMembers(listId);
                        }
                    }
                    this.postMessageToWebview({
                        type: 'ticketAssigneesLoaded',
                        provider,
                        id,
                        members,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'ticketAssigneesError',
                        provider,
                        id,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'loadTicketMembers': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider;
                let listId = msg.listId ? String(msg.listId).trim() : '';
                if (!workspaceRoot || !provider) {
                    this.postMessageToWebview({
                        type: 'ticketMembersError',
                        provider,
                        error: 'Invalid request parameters.',
                        workspaceRoot
                    });
                    break;
                }
                try {
                    let members: any[] = [];
                    if (provider === 'linear') {
                        const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        members = await linear.getTeamMembers();
                    } else if (provider === 'clickup') {
                        const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        if (listId) {
                            members = await clickup.getListMembers(listId);
                        } else {
                            // No list selected yet — return empty; webview shows "No members available."
                            members = [];
                        }
                    }
                    this.postMessageToWebview({
                        type: 'ticketMembersLoaded',
                        provider,
                        members,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'ticketMembersError',
                        provider,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'linearUpdateIssueAssignee': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                const assigneeId = msg.assigneeId === null ? null : String(msg.assigneeId || '').trim();

                if (!workspaceRoot || !issueId) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: 'Invalid issue ID or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                    await linear.updateIssueAssignee(issueId, assigneeId);
                    this.postMessageToWebview({
                        type: 'linearAssigneeUpdated',
                        issueId,
                        assigneeId,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupUpdateTaskAssignees': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const taskId = String(msg.taskId || '').trim();
                const currentAssigneeIds = Array.isArray(msg.currentAssigneeIds) ? msg.currentAssigneeIds.map(String) : [];
                const desiredAssigneeIds = Array.isArray(msg.desiredAssigneeIds) ? msg.desiredAssigneeIds.map(String) : [];

                if (!workspaceRoot || !taskId) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: 'Invalid task ID or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                const addIds = desiredAssigneeIds.filter((id: string) => !currentAssigneeIds.includes(id)).map(Number).filter((n: number) => !isNaN(n));
                const remIds = currentAssigneeIds.filter((id: string) => !desiredAssigneeIds.includes(id)).map(Number).filter((n: number) => !isNaN(n));

                if (addIds.length === 0 && remIds.length === 0) {
                    this.postMessageToWebview({
                        type: 'clickupAssigneesUpdated',
                        taskId,
                        assigneeIds: desiredAssigneeIds,
                        noChange: true,
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                    await clickup.updateTaskAssignees(taskId, addIds, remIds);
                    this.postMessageToWebview({
                        type: 'clickupAssigneesUpdated',
                        taskId,
                        assigneeIds: desiredAssigneeIds,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'linearUpdateIssuePriority': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                const priority = Number(msg.priority);

                if (!workspaceRoot || !issueId || isNaN(priority)) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: 'Invalid issue ID, priority, or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                    await linear.updateIssuePriority(issueId, priority);
                    this.postMessageToWebview({
                        type: 'linearPriorityUpdated',
                        issueId,
                        priority,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupUpdateTaskPriority': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const taskId = String(msg.taskId || '').trim();
                const priority = Number(msg.priority);

                if (!workspaceRoot || !taskId || isNaN(priority)) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: 'Invalid task ID, priority, or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                    await clickup.updateTask(taskId, { priority });
                    this.postMessageToWebview({
                        type: 'clickupPriorityUpdated',
                        taskId,
                        priority,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'linearLoadAutomationCatalog': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                try {
                    const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                    const catalog = await linear.getAutomationCatalog();
                    this.postMessageToWebview({
                        type: 'linearAutomationCatalogLoaded',
                        labels: catalog.labels,
                        states: catalog.states,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupLoadSpaceTags': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const spaceId = String(msg.spaceId || '').trim();
                if (!workspaceRoot || !spaceId) { break; }
                try {
                    const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                    const tags = await clickUp.getSpaceTags(spaceId);
                    this.postMessageToWebview({
                        type: 'clickupSpaceTagsLoaded',
                        tags,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupLoadListStatuses': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const listId = String(msg.listId || '').trim();
                if (!workspaceRoot || !listId) { break; }
                try {
                    const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                    const statuses = await clickUp.getListStatuses(listId);
                    this.postMessageToWebview({
                        type: 'clickupListStatusesLoaded',
                        statuses,
                        listId,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupSaveSpaceSelection': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const config = await clickUp.loadConfig();
                    if (config) {
                        config.selectedSpaceId = String(msg.spaceId || '').trim();
                        config.selectedSpaceName = String(msg.spaceName || '').trim();
                        config.selectedFolderId = '';
                        config.selectedFolderName = '';
                        config.selectedListId = '';
                        config.selectedListName = '';
                        await clickUp.saveConfig(config);
                    }
                } catch (error) {
                    console.error('Failed to save ClickUp space selection:', error);
                }
                break;
            }
            case 'clickupSaveFolderSelection': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const config = await clickUp.loadConfig();
                    if (config) {
                        config.selectedFolderId = String(msg.folderId || '').trim();
                        config.selectedFolderName = String(msg.folderName || '').trim();
                        config.selectedListId = '';
                        config.selectedListName = '';
                        await clickUp.saveConfig(config);
                    }
                } catch (error) {
                    console.error('Failed to save ClickUp folder selection:', error);
                }
                break;
            }
            case 'clickupSaveListSelection': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const config = await clickUp.loadConfig();
                    if (config) {
                        config.selectedListId = String(msg.listId || '').trim();
                        config.selectedListName = String(msg.listName || '').trim();
                        config.selectedSpaceId = String(msg.spaceId || '').trim();
                        config.selectedSpaceName = String(msg.spaceName || '').trim();
                        config.selectedFolderId = String(msg.folderId || '').trim();
                        config.selectedFolderName = String(msg.folderName || '').trim();
                        await clickUp.saveConfig(config);
                    }
                } catch (error) {
                    console.error('Failed to save ClickUp list selection:', error);
                }
                break;
            }
            // ===== TICKETS TAB IMPORT/REFINE DELEGATION =====
            case 'linearImportTask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                const includeSubtasks = Boolean(msg.includeSubtasks);
                const mode = msg.mode || 'plan';

                if (!workspaceRoot || !issueId) {
                    this.postMessageToWebview({
                        type: 'linearTaskImported',
                        success: false,
                        error: 'Missing workspace or issue ID',
                        workspaceRoot: workspaceRoot || msg.workspaceRoot || undefined
                    });
                    break;
                }

                try {
                    if (mode === 'document') {
                        await this._seams().commands.executeCommand(
                            'switchboard.importTaskAsDocument',
                            { workspaceRoot, provider: 'linear', id: issueId, includeSubtasks }
                        );
                    } else {
                        await this._seams().commands.executeCommand(
                            'switchboard.importLinearTask',
                            { workspaceRoot, issueId, includeSubtasks }
                        );
                    }
                    this.postMessageToWebview({
                        type: 'linearTaskImported',
                        success: true,
                        workspaceRoot
                    });
                } catch (error) {
                    console.error('[PlanningPanel] Failed to import Linear task:', error);
                    this.postMessageToWebview({
                        type: 'linearTaskImported',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupImportTask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const taskId = String(msg.taskId || '').trim();
                const includeSubtasks = Boolean(msg.includeSubtasks);
                const mode = msg.mode || 'plan';

                if (!workspaceRoot || !taskId) {
                    this.postMessageToWebview({
                        type: 'clickupTaskImported',
                        success: false,
                        error: 'Missing workspace or task ID',
                        workspaceRoot: workspaceRoot || msg.workspaceRoot || undefined
                    });
                    break;
                }

                try {
                    if (mode === 'document') {
                        await this._seams().commands.executeCommand(
                            'switchboard.importTaskAsDocument',
                            { workspaceRoot, provider: 'clickup', id: taskId, includeSubtasks }
                        );
                    } else {
                        await this._seams().commands.executeCommand(
                            'switchboard.importClickUpTask',
                            { workspaceRoot, taskId, includeSubtasks }
                        );
                    }
                    this.postMessageToWebview({
                        type: 'clickupTaskImported',
                        success: true,
                        workspaceRoot
                    });
                } catch (error) {
                    console.error('[PlanningPanel] Failed to import ClickUp task:', error);
                    this.postMessageToWebview({
                        type: 'clickupTaskImported',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'importAllTickets': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, ids, listId, projectId, workspaceId, page, append, importMode } = msg;
                if (!workspaceRoot) break;
                // Track the current selection so the auto-sync delta-pull timer
                // knows what to poll.
                if (importMode === 'document' && !ids) {
                    this._ticketsCurrentSelection.set(workspaceRoot, { provider, listId, projectId });
                }
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.importAllTasks',
                        { workspaceRoot, provider, ids, listId, projectId, workspaceId, page, append, importMode }
                    );
                    // Set the per-list delta cursor after a successful full document
                    // import so the next Refresh can do a delta pull instead of
                    // re-fetching the entire list.
                    if (result?.success && importMode === 'document' && !ids) {
                        try {
                            if (!this._cacheService) {
                                this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                            }
                            const kanbanDb = (this._cacheService as any)?._kanbanDb;
                            if (kanbanDb) {
                                const cursorKey = provider === 'clickup'
                                    ? `last_delta_pull_clickup_${listId || ''}`
                                    : `last_delta_pull_linear_${projectId || ''}`;
                                await kanbanDb.setMeta(cursorKey, new Date().toISOString());
                            }
                        } catch { /* non-fatal — cursor is a perf optimization */ }
                    }
                    // Webview status is silent — surface the real outcome natively so
                    // failures aren't invisible (mirrors the ticket-push handler).
                    const errDetail = (result?.errors || []).slice(0, 3)
                        .map((e: any) => `${e.id}: ${e.error}`).join('; ');
                    if (!result?.success) {
                        this._seams().ui.showErrorMessage(`Import all (${importMode}) failed: ${result?.error || 'unknown'}`);
                    } else if ((result.successCount || 0) === 0) {
                        this._seams().ui.showWarningMessage(`Import all (${importMode}): nothing imported (${ids?.length ?? 0} requested${errDetail ? ' — ' + errDetail : ''}).`);
                    } else if ((result.failCount || 0) > 0) {
                        this._seams().ui.showWarningMessage(`Import all (${importMode}): ${result.successCount} imported, ${result.failCount} failed — ${errDetail}`);
                    }
                    this.postMessageToWebview({
                        type: 'importAllTicketsComplete',
                        success: result.success,
                        successCount: result.successCount,
                        failCount: result.failCount,
                        errors: result.errors,
                        importMode,
                        workspaceRoot,
                        provider,
                        listId,
                        projectId,
                        page
                    });
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    this._seams().ui.showErrorMessage(`Import all (${importMode}) failed: ${errMsg}`);
                    this.postMessageToWebview({
                        type: 'importAllTicketsComplete',
                        success: false,
                        error: errMsg,
                        importMode,
                        workspaceRoot,
                        provider,
                        listId,
                        projectId,
                        page
                    });
                }
                break;
            }
            case 'refreshTicketsDelta': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, listId, projectId } = msg;
                if (!workspaceRoot) break;
                // Track the current selection so the auto-sync delta-pull timer
                // knows what to poll.
                this._ticketsCurrentSelection.set(workspaceRoot, { provider, listId, projectId });
                try {
                    if (!this._cacheService) {
                        this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                    }
                    const kanbanDb = (this._cacheService as any)?._kanbanDb;
                    const cursorKey = provider === 'clickup'
                        ? `last_delta_pull_clickup_${listId || ''}`
                        : `last_delta_pull_linear_${projectId || ''}`;

                    // Delta-aware import: read the per-list/per-project cursor. First
                    // open (no cursor) falls back to a full import + prune. Subsequent
                    // opens do a delta pull (only changed tasks written, prune skipped).
                    // Stale-file cleanup for remotely-deleted tickets is handled by the
                    // existing delta deletion sweep inside importAllTasks (lines
                    // 19482-19541), NOT by a periodic full prune.
                    //
                    // Exception: when includeClosed is true (user switched the status
                    // filter to a closed status, webview planning.js line 8916), force a
                    // FULL import. A delta pull with includeClosed=true uses dateUpdatedGt
                    // and would only fetch closed tickets UPDATED since the cursor,
                    // missing tickets closed before the cursor was set. This path is
                    // triggered only by the explicit status-filter change, not the
                    // every-open path, so it does not reintroduce the target churn.
                    const includeClosed = !!msg.includeClosed;
                    const forceFull = includeClosed || !!msg.forceFull;  // closed-status-filter or explicit force-full needs the full set
                    let lastPullIso: string | null = null;
                    if (!forceFull && kanbanDb) {
                        try { lastPullIso = await kanbanDb.getMeta(cursorKey); } catch { /* ignore */ }
                    }
                    const deltaSince = lastPullIso ? new Date(lastPullIso).getTime() : undefined;
                    const deltaSinceIso = lastPullIso || undefined;
                    const isDeltaRefresh = lastPullIso !== null && !forceFull;  // false when forceFull or first-open

                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.importAllTasks',
                        {
                            workspaceRoot,
                            provider,
                            listId,
                            projectId,
                            importMode: 'document',
                            includeClosed,
                            ...(deltaSince !== undefined ? { deltaSince } : {}),
                            ...(deltaSinceIso ? { deltaSinceIso } : {})
                        }
                    );

                    // No periodic full prune — the delta deletion sweep inside
                    // importAllTasks (lines 19482-19541) already prunes remotely-deleted
                    // tickets on every delta pull. Adding a periodic full import would
                    // reintroduce the exact full-reload churn this plan eliminates.

                    // Refresh the cursor baseline so the background delta timer polls
                    // from "now" rather than re-pulling the whole window.
                    if (result?.success && kanbanDb) {
                        const nowIso = new Date().toISOString();
                        try { await kanbanDb.setMeta(cursorKey, nowIso); } catch { /* ignore */ }
                    }

                    const skippedModified = result?.skippedModified || 0;
                    const errDetail = (result?.errors || []).slice(0, 3)
                        .map((e: any) => `${e.id}: ${e.error}`).join('; ');
                    if (!result?.success) {
                        this._seams().ui.showErrorMessage(`Refresh failed: ${result?.error || 'unknown'}`);
                    } else if (skippedModified > 0) {
                        this._seams().ui.showWarningMessage(
                            `Refreshed ${result.successCount} ticket${result.successCount !== 1 ? 's' : ''}. ${skippedModified} skipped (locally modified — push or discard changes first).`
                        );
                    } else if ((result.failCount || 0) > 0) {
                        this._seams().ui.showWarningMessage(`Refresh: ${result.successCount} updated, ${result.failCount} failed — ${errDetail}`);
                    }

                    this.postMessageToWebview({
                        type: 'importAllTicketsComplete',
                        success: result.success,
                        successCount: result.successCount,
                        failCount: result.failCount,
                        deletedCount: result.deletedCount,
                        errors: result.errors,
                        importMode: 'document',
                        workspaceRoot,
                        provider,
                        listId,
                        projectId,
                        isDelta: isDeltaRefresh
                    });
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    this._seams().ui.showErrorMessage(`Refresh failed: ${errMsg}`);
                    this.postMessageToWebview({
                        type: 'importAllTicketsComplete',
                        success: false,
                        error: errMsg,
                        importMode: 'document',
                        workspaceRoot,
                        provider,
                        listId,
                        projectId
                    });
                }
                break;
            }
            case 'openExternalUrl': {
                const url = msg.url as string;
                if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
                    this._seams().ui.openExternal(url);
                }
                break;
            }
            case 'saveLocalTicketFile': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id, content } = msg;
                if (!workspaceRoot || !id || typeof content !== 'string') break;
                let filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                // Create-if-missing: if no local file exists yet (e.g. auto-sync was
                // OFF when the list was selected, or the ticket was never imported),
                // import it from the remote first so we have a file + cache entry to
                // write into. The remote fetch is acceptable here — Save is a manual
                // user action and the ticket already exists remotely. The user's
                // edited content overwrites the imported content immediately after.
                if (!filePath) {
                    try {
                        const importResult: any = await this._seams().commands.executeCommand(
                            'switchboard.importTaskAsDocument',
                            { workspaceRoot, provider, id, includeSubtasks: false }
                        );
                        if (importResult && importResult.success === false) {
                            const errMsg = importResult.error || 'Local document write failed.';
                            this._seams().ui.showErrorMessage(`Save failed: ${errMsg}`);
                            break;
                        }
                        filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                    } catch (importErr) {
                        const errMsg = importErr instanceof Error ? importErr.message : String(importErr);
                        this._seams().ui.showErrorMessage(`Save failed (could not create local file): ${errMsg}`);
                        break;
                    }
                }
                if (!filePath) {
                    this._seams().ui.showErrorMessage('Save failed: could not locate or create the local ticket file.');
                    break;
                }
                try {
                    const nfs = require('fs') as typeof import('fs');
                    const existing = nfs.readFileSync(filePath, 'utf8');
                    const frontmatterMatch = existing.match(/^(---\n[\s\S]*?\n---\n?)/);
                    const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';
                    nfs.writeFileSync(filePath, frontmatter + content, 'utf8');
                } catch (writeErr) {
                    const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
                    this._seams().ui.showErrorMessage(`Save failed: ${errMsg}`);
                }
                break;
            }
            case 'editTicket': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.importTaskAsDocument',
                        { workspaceRoot, provider, id, includeSubtasks: true }
                    );
                    this.postMessageToWebview({
                        type: 'editTicketResult',
                        success: result.success,
                        id,
                        filePath: result.filePath,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'editTicketResult',
                        success: false,
                        id,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'pushTicket': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.pushTicketEdits',
                        { workspaceRoot, provider, id }
                    );
                    if (!result?.success) {
                        // Webview status is silent; surface the real reason natively.
                        this._seams().ui.showErrorMessage(`Push to ${provider} failed: ${result?.error || 'unknown error'}`);
                    }
                    this.postMessageToWebview({
                        type: 'pushTicketResult',
                        success: result.success,
                        id,
                        error: result.error,
                        message: result.message,
                        workspaceRoot
                    });
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    this._seams().ui.showErrorMessage(`Push to ${provider} failed: ${errMsg}`);
                    this.postMessageToWebview({
                        type: 'pushTicketResult',
                        success: false,
                        id,
                        error: errMsg,
                        workspaceRoot
                    });
                }
                break;
            }
            case 'deleteTicketConfirmed': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.deleteTicket',
                        { workspaceRoot, provider, id }
                    );
                    this.postMessageToWebview({
                        type: 'ticketDeleted',
                        success: result.success,
                        id,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'ticketDeleted',
                        success: false,
                        id,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'listLocalTicketFiles': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = (msg.provider as 'clickup' | 'linear') || 'clickup';
                if (!workspaceRoot) {
                    this.postMessageToWebview({ type: 'localTicketFilesListed', provider, tickets: [] });
                    break;
                }
                const ticketDirs = this._getTicketDocumentDirs(workspaceRoot, provider);
                const tickets: any[] = [];

                if (!this._cacheService && workspaceRoot) {
                    this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                }

                if (this._cacheService) {
                    const kanbanDb = (this._cacheService as any)._kanbanDb;
                    if (kanbanDb) {
                        try {
                            const effectiveWsId = await (this._cacheService as any)._getEffectiveWorkspaceId(undefined);
                            const throttleKey = 'last_ticket_heal_scan_' + effectiveWsId;
                            const lastHealStr = await kanbanDb.getMeta(throttleKey);
                            const lastHeal = lastHealStr ? new Date(lastHealStr).getTime() : 0;
                            const now = Date.now();
                            const twentyFourHours = 24 * 60 * 60 * 1000;

                            // Query existing ticket entries in DB
                            let dbTickets = await this._cacheService.getImportedTickets();

                            // If DB has no entries OR throttle expired, perform backfill scan
                            if (dbTickets.length === 0 || (now - lastHeal > twentyFourHours)) {
                                const scannedTickets: any[] = [];
                                for (const dir of ticketDirs) {
                                    this._scanLocalTicketFiles(dir, provider, scannedTickets);
                                }

                                // Upsert missing tickets to DB
                                for (const t of scannedTickets) {
                                    const exists = dbTickets.find(dbT => dbT.slugPrefix === `${provider}_${t.id}`);
                                    if (!exists) {
                                        try {
                                            // Register the orphan so it has a last_synced_at baseline.
                                            // Sync status is timestamp-based; the content hash is unused.
                                            await this._cacheService.registerImportedTicket(
                                                provider,
                                                t.id,
                                                t.title,
                                                `${provider}_${t.id}`,
                                                t.filePath,
                                                ''
                                            );
                                        } catch (err) {
                                            console.error('[PlanningPanelProvider] failed to backfill ticket:', err);
                                        }
                                    }
                                }
                                // Update the throttle key
                                await kanbanDb.setMeta(throttleKey, new Date().toISOString());

                                // Re-fetch from DB
                                dbTickets = await this._cacheService.getImportedTickets();
                            }

                            // Scope to the currently-selected list/project. The DB holds
                            // tickets for EVERY list ever opened; without this, selecting one
                            // sprint would show files from every other sprint. We scope by the
                            // listId/projectId recorded in each file's frontmatter at import
                            // time — instance-independent (does NOT depend on which service holds
                            // the live hierarchy selection, which differs between providers).
                            // If the webview didn't send a scope id, we don't scope (show all)
                            // so the sidebar is never wrongly emptied.
                            // ClickUp scopes strictly by list id (the key written to each file's
                            // frontmatter from the live task's list.id, and the same id the webview
                            // tracks as the selected list). Linear scopes by project name (the
                            // picker is name-based, and _buildLinearImportPlanContent writes
                            // `projectName:` to each file's frontmatter from issue.project.name).
                            // Legacy Linear files lacking `projectName:` are hidden until the
                            // project is re-imported (which rewrites them with the key).
                            const scopeId = provider === 'clickup'
                                ? String((msg.listId as string) || '').trim()
                                : String((msg.projectId as string) || '').trim();

                            // Map DB entries to the provider-specific tickets output list
                            for (const dbT of dbTickets) {
                                if (dbT.sourceId === provider) {
                                    let kanbanColumn = '';
                                    let clickStatus = '';
                                    let parentId = '';
                                    let fileScopeId = '';
                                    let dateCreated: string | undefined;
                                    let syncStatus: 'synced' | 'modified' | 'local-only' = 'local-only';
                                    let assignees: string[] = [];
                                    let priority: { priority: string; color: string; orderindex: string } | null = null;
                                    if (fs.existsSync(dbT.filePath)) {
                                        try {
                                            const content = fs.readFileSync(dbT.filePath, 'utf8');
                                            const fm = content.match(/^---\n([\s\S]*?)\n---/);
                                            if (fm) {
                                                const km = fm[1].match(/kanbanColumn:\s*(.+)/);
                                                if (km) { kanbanColumn = km[1].trim(); }
                                                // Real source status (ClickUp status name / Linear state name),
                                                // written into frontmatter at import time so the status-filter
                                                // dropdown works on file-backed rows.
                                                const sm = fm[1].match(/^status:\s*(.+)$/m);
                                                if (sm) { clickStatus = sm[1].trim(); }
                                                const pm = fm[1].match(/^parentId:\s*(.+)$/m);
                                                if (pm) { parentId = pm[1].trim(); }
                                                const idm = fm[1].match(provider === 'clickup' ? /^listId:\s*(.+)$/m : /^projectName:\s*(.+)$/m);
                                                if (idm) { fileScopeId = idm[1].trim(); }
                                                // Ticket creation date (source system), written at import time.
                                                // Drives the sidebar's newest-first sort.
                                                const cm = fm[1].match(/^created:\s*(.+)$/m);
                                                if (cm) { dateCreated = cm[1].trim(); }
                                                const am = fm[1].match(/^assignees:\s*(.+)$/m);
                                                if (am) { assignees = am[1].split(',').map((s: string) => s.trim()).filter(Boolean); }
                                                // ClickUp priority, persisted at import time so the
                                                // file-backed sidebar renders the priority dot without
                                                // re-hitting the API. Reconstruct the { priority, color,
                                                // orderindex } shape the webview render helpers consume.
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
                                            // Fallback to file mtime for older files lacking a `created:` field,
                                            // so they still sort in a reasonable order rather than to the end.
                                            if (!dateCreated) {
                                                try { dateCreated = fs.statSync(dbT.filePath).mtime.toISOString(); } catch {}
                                            }
                                            // Sync status is purely a timestamp comparison against the
                                            // DB's last-fetch time: if the local file was edited after we
                                            // last pulled it from the source, it has unpushed local changes.
                                            syncStatus = this._ticketSyncStatusFromTimestamps(dbT.filePath, dbT.lastSyncedAt);
                                        } catch {}
                                    }
                                    // Defensive: a subtask file (has parentId) is never a sidebar row —
                                    // subtasks are embedded in their parent's file.
                                    if (parentId) { continue; }
                                    // List/project scoping: when the webview names a selected list/
                                    // project, show ONLY files belonging to it. Files for other lists
                                    // (and legacy files lacking the key) are hidden. The selected list
                                    // is always re-imported on select — which rewrites its files WITH
                                    // this key from the live task's list.id/project.id — so its rows
                                    // reappear once that import completes.
                                    if (scopeId && fileScopeId !== scopeId) { continue; }
                                    tickets.push({
                                        id: dbT.remoteDocId || dbT.slugPrefix.replace(`${provider}_`, ''),
                                        title: dbT.docName,
                                        status: clickStatus || kanbanColumn || '',
                                        filePath: dbT.filePath,
                                        lastSyncedAt: dbT.lastSyncedAt,
                                        syncStatus,
                                        url: dbT.url || '',
                                        dateCreated,
                                        assignees,
                                        priority
                                    });
                                }
                            }
                        } catch (err) {
                            console.error('[PlanningPanelProvider] error listing tickets from cache DB:', err);
                        }
                    }
                }

                // Fallback to live file scan if still empty (e.g. database not ready or no entries found)
                if (tickets.length === 0) {
                    for (const dir of ticketDirs) {
                        this._scanLocalTicketFiles(dir, provider, tickets);
                    }
                }

                this.postMessageToWebview({ type: 'localTicketFilesListed', provider, tickets });
                break;
            }
            case 'getTicketSyncStatuses': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = (msg.provider as 'clickup' | 'linear') || 'clickup';
                const ids: string[] = msg.ids || [];
                if (!workspaceRoot || ids.length === 0) break;
                if (!this._cacheService && workspaceRoot) {
                    this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                }
                if (!this._cacheService) break;
                const statuses: Record<string, 'synced' | 'modified' | 'local-only'> = {};
                try {
                    const dbTickets = await this._cacheService.getImportedTickets();
                    for (const id of ids) {
                        const slugPrefix = `${provider}_${id}`;
                        const dbT = dbTickets.find(t => t.slugPrefix === slugPrefix);
                        if (!dbT || !fs.existsSync(dbT.filePath)) { statuses[id] = 'local-only'; continue; }
                        // file edited since last fetch from source → has local changes.
                        statuses[id] = this._ticketSyncStatusFromTimestamps(dbT.filePath, dbT.lastSyncedAt);
                    }
                } catch (err) {
                    console.error('[PlanningPanelProvider] getTicketSyncStatuses error:', err);
                }
                this.postMessageToWebview({ type: 'ticketSyncStatusesLoaded', provider, statuses });
                break;
            }
            case 'readLocalTicketFile': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider as 'clickup' | 'linear';
                const id = msg.id;
                if (!workspaceRoot || !provider || !id) {
                    this.postMessageToWebview({ type: 'localTicketFileRead', provider, id, success: false });
                    break;
                }
                const filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                if (!filePath) {
                    this.postMessageToWebview({ type: 'localTicketFileRead', provider, id, success: false });
                    break;
                }
                try {
                    const raw = fs.readFileSync(filePath, 'utf8');
                    const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
                    const h1 = content.match(/^#\s+(.+)$/m);
                    const title = h1 ? h1[1].trim() : id;
                    // Rewrite local image paths to webview-accessible URIs for display only.
                    // rawContent preserves original local paths for edit mode + push flow.
                    const displayContent = this._rewriteLocalImagePaths(content, path.dirname(filePath));
                    this.postMessageToWebview({ type: 'localTicketFileRead', provider, id, success: true, title, content: displayContent, rawContent: content });
                } catch {
                    this.postMessageToWebview({ type: 'localTicketFileRead', provider, id, success: false });
                }
                break;
            }
            case 'ticketAttachImage': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider as 'clickup' | 'linear';
                const id = msg.id;
                const requestId = msg.requestId;
                if (!workspaceRoot || !provider || !id) {
                    this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: false });
                    break;
                }
                try {
                    const filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                    if (!filePath) {
                        this._seams().ui.showErrorMessage('Save the ticket once before attaching images.');
                        this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: false });
                        break;
                    }
                    const picked = await this._seams().ui.showOpenDialog({
                        canSelectMany: false,
                        openLabel: 'Attach image',
                        filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
                    });
                    if (!picked || picked.length === 0) {
                        this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: false });
                        break;
                    }
                    const srcPath = picked[0];
                    const attachmentsDir = path.join(path.dirname(filePath), 'attachments');
                    fs.mkdirSync(attachmentsDir, { recursive: true });
                    const ext = path.extname(srcPath);
                    const stem = path.basename(srcPath, ext);
                    let destName = `${stem}${ext}`;
                    let counter = 1;
                    while (fs.existsSync(path.join(attachmentsDir, destName))) {
                        destName = `${stem}-${counter}${ext}`;
                        counter++;
                    }
                    fs.copyFileSync(srcPath, path.join(attachmentsDir, destName));
                    this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: true, relativePath: `attachments/${destName}` });
                } catch (err: any) {
                    this._seams().ui.showErrorMessage('Failed to attach image: ' + err.message);
                    this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: false });
                }
                break;
            }
            case 'importTicketSubtasks': {
                // Progressive subtask import: when a parent is opened, embed its
                // subtasks into the parent's file (a `## Subtasks` checklist) so they
                // are persisted locally — rather than mass-importing every subtask as
                // its own file up front. Subtasks already render live in the detail
                // view, so this is a silent, best-effort file enrichment (no editor
                // refresh). Skipped when the file has unpushed local edits — never
                // clobber the user's work.
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider as 'clickup' | 'linear';
                const id = msg.id;
                if (!workspaceRoot || !provider || !id) { break; }
                const filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                if (!filePath) { break; } // parent isn't a local file yet — nothing to enrich
                try {
                    if (!this._cacheService) {
                        this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                    }
                    const dbTickets = await this._cacheService.getImportedTickets();
                    const entry = dbTickets.find((t: any) => t.slugPrefix === `${provider}_${id}`);
                    if (entry && this._ticketSyncStatusFromTimestamps(filePath, entry.lastSyncedAt) === 'modified') {
                        break; // locally modified — leave it alone (subtasks still show in the live detail view)
                    }
                } catch { /* fall through and attempt the enrich */ }
                try {
                    await this._seams().commands.executeCommand(
                        'switchboard.importTaskAsDocument',
                        { workspaceRoot, provider, id, includeSubtasks: true }
                    );
                } catch (e) {
                    console.warn('[PlanningPanel] importTicketSubtasks failed:', e);
                }
                break;
            }
            case 'syncAllTickets': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider;
                const results = { succeeded: 0, failed: 0, errors: [] as string[] };
                
                if (workspaceRoot) {
                    const tickets: any[] = [];
                    for (const dir of this._getTicketDocumentDirs(workspaceRoot, provider)) {
                        if (!fs.existsSync(dir)) { continue; }
                        let files: string[] = [];
                        try { files = fs.readdirSync(dir); } catch { continue; }
                        for (const fileName of files) {
                            const match = fileName.match(/^(linear|clickup)_([^_]+)_(.*)\.md$/);
                            if (!match || match[1] !== provider) { continue; }
                            const filePath = path.join(dir, fileName);
                            try {
                                const content = fs.readFileSync(filePath, 'utf8');
                                tickets.push({ id: match[2], content, filePath });
                            } catch {
                                // ignore read errors
                            }
                        }
                    }
                    
                    // Deduplicate by ticket id — if the same id appears in multiple ticket
                    // document dirs, keep only the first. This prevents a concurrent
                    // hostInlineImages file-write race on the same sourceFilePath.
                    const seenIds = new Set<string>();
                    const uniqueTickets = tickets.filter(t => {
                        if (seenIds.has(t.id)) return false;
                        seenIds.add(t.id);
                        return true;
                    });

                    // Bounded concurrency: push up to 4 tickets at a time so total wall time
                    // is ~ceil(N/4) × per-ticket latency instead of N × per-ticket latency.
                    const CONCURRENCY = 4;
                    let done = 0;
                    const total = uniqueTickets.length;
                    for (let i = 0; i < uniqueTickets.length; i += CONCURRENCY) {
                        const batch = uniqueTickets.slice(i, i + CONCURRENCY);
                        const batchResults = await Promise.all(batch.map(async (ticket) => {
                            try {
                                const result: any = await this._seams().commands.executeCommand(
                                    'switchboard.pushTicketEdits',
                                    { workspaceRoot, provider, id: ticket.id }
                                );
                                return result?.success
                                    ? { ok: true }
                                    : { ok: false, error: `${ticket.id}: ${result?.error || 'Unknown error'}` };
                            } catch (err) {
                                return { ok: false, error: `${ticket.id}: ${err instanceof Error ? err.message : String(err)}` };
                            }
                        }));
                        for (const r of batchResults) {
                            if (r.ok) { results.succeeded++; }
                            else { results.failed++; results.errors.push(r.error ?? 'Unknown error'); }
                        }
                        done += batch.length;
                        this.postMessageToWebview({
                            type: 'syncAllTicketsProgress', done, total
                        });
                    }

                    this.postMessageToWebview({
                        type: 'syncAllTicketsResult',
                        success: results.failed === 0,
                        count: uniqueTickets.length,
                        succeeded: results.succeeded,
                        failed: results.failed,
                        errors: results.errors
                    });
                } else {
                    this.postMessageToWebview({
                        type: 'syncAllTicketsResult',
                        success: false,
                        count: 0,
                        succeeded: 0,
                        failed: 0,
                        errors: ['No workspace root resolved']
                    });
                }
                break;
            }
            case 'copyToClipboard': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider;
                const paths: string[] = [];
                const missingIds: string[] = [];
                if (workspaceRoot) {
                    if (Array.isArray(msg.ticketIds) && msg.ticketIds.length > 0) {
                        const providerDir = provider === 'clickup' ? 'clickup' : 'linear';
                        for (const id of msg.ticketIds) {
                            if (typeof id === 'string' && id && !id.includes('/') && !id.includes('\\') && !id.includes('..')) {
                                // Local-file-only lookup: "Link all"/"Link to ticket" copies paths
                                // for tickets already imported. It does NOT make API calls — the
                                // import happens during the sidebar load (importAllTickets document
                                // mode). Missing tickets are reported so the user can Refetch.
                                // Ticket files are named `${provider}_${id}_<slug>.md` and live in
                                // nested hierarchies (team/project/sprint), so resolve the real path
                                // by prefix scan rather than reconstructing a flat path.
                                const filePath = await this._findTicketFilePath(workspaceRoot, providerDir, id);
                                if (filePath) {
                                    paths.push(filePath);
                                } else {
                                    missingIds.push(id);
                                }
                            }
                        }
                    } else {
                        for (const dir of this._getTicketDocumentDirs(workspaceRoot, provider)) {
                            if (!fs.existsSync(dir)) { continue; }
                            paths.push(dir);
                        }
                    }
                }
                if (Array.isArray(msg.ticketIds) && msg.ticketIds.length > 0) {
                    if (paths.length === 0) {
                        this.postMessageToWebview({
                            type: 'ticketLinkFailed',
                            error: missingIds.length > 0
                                ? `No local files found for ${missingIds.length} ticket(s). Click "Refetch" to import them first.`
                                : 'Could not locate local files for these tickets.'
                        });
                    } else {
                        await this._seams().clipboard.writeText(paths.join('\n'));
                        this.postMessageToWebview({
                            type: 'ticketLinkCopied',
                            count: paths.length,
                            requestedCount: msg.ticketIds.length,
                            missingCount: missingIds.length
                        });
                    }
                } else {
                    await this._seams().clipboard.writeText(paths.join('\n'));
                }
                break;
            }
            case 'copyDiagramPrompt': {
                try {
                    const { prompt } = msg;
                    if (typeof prompt !== 'string' || !prompt.trim()) {
                        this._seams().ui.showErrorMessage('Diagram prompt is empty.');
                        break;
                    }
                    await this._seams().clipboard.writeText(prompt);
                    this._seams().ui.showTemporaryNotification('Diagram prompt copied to clipboard');
                } catch (err) {
                    this._seams().ui.showErrorMessage(`Failed to copy diagram prompt: ${String(err)}`);
                }
                break;
            }
            case 'fetchMoveTargets': {
                try {
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (!workspaceRoot) {
                        throw new Error('Workspace root not resolved');
                    }
                    const { provider, ticketId, refresh } = msg;
                    const cached = this._moveTargetsCache.get(provider);
                    if (!refresh && cached && Date.now() - cached.at < PlanningPanelProvider.MOVE_TARGETS_TTL_MS) {
                        this.postMessageToWebview({ type: 'moveTargetsResult', provider, ticketId, targets: cached.targets });
                        break;
                    }
                    if (provider === 'clickup') {
                        const clickUpService = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        const spaces = await clickUpService.getSpaces();
                        const targets: Array<{ id: string; name: string; path: string }> = [];
                        for (const space of spaces) {
                            const lists = await clickUpService.getLists(space.id);
                            for (const list of lists) {
                                targets.push({ id: list.id, name: list.name, path: `${space.name} / ${list.name}` });
                            }
                            const folders = await clickUpService.getFolders(space.id);
                            for (const folder of folders) {
                                const folderLists = await clickUpService.getLists(space.id, folder.id);
                                for (const list of folderLists) {
                                    targets.push({ id: list.id, name: list.name, path: `${space.name} / ${folder.name} / ${list.name}` });
                                }
                            }
                        }
                        this._moveTargetsCache.set('clickup', { at: Date.now(), targets });
                        this.postMessageToWebview({ type: 'moveTargetsResult', provider, ticketId, targets });
                    } else {
                        const linearService = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        const projects = await linearService.getAvailableProjects();
                        const targets = projects.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name, path: p.name }));
                        this._moveTargetsCache.set('linear', { at: Date.now(), targets });
                        this.postMessageToWebview({ type: 'moveTargetsResult', provider, ticketId, targets });
                    }
                } catch (err) {
                    console.error('[PlanningPanelProvider] Failed to fetch move targets:', err);
                    this.postMessageToWebview({ type: 'moveTargetsResult', provider: msg.provider, ticketId: msg.ticketId, targets: [], error: String(err) });
                }
                break;
            }
            case 'moveTicket': {
                try {
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (!workspaceRoot) {
                        throw new Error('Workspace root not resolved');
                    }
                    const { provider, ticketId, targetId } = msg;
                    if (provider === 'clickup') {
                        const clickUpService = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        const result = await clickUpService.moveTask(ticketId, targetId);
                        this.postMessageToWebview({
                            type: 'moveTicketResult',
                            success: true,
                            provider,
                            ticketId,
                            warning: result.warning ?? null,
                            remainsInLists: result.remainsInLists
                        });
                    } else {
                        const linearService = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        await linearService.updateIssueProject(ticketId, targetId);
                        this.postMessageToWebview({ type: 'moveTicketResult', success: true, provider, ticketId, targetId });
                    }
                } catch (err) {
                    console.error('[PlanningPanelProvider] Failed to move ticket:', err);
                    this.postMessageToWebview({ type: 'moveTicketResult', success: false, provider: msg.provider, ticketId: msg.ticketId, error: String(err) });
                }
                break;
            }
            case 'refineFeature': {
                try {
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    const { planId, planFile, title, subtaskCount } = msg;
                    if (!workspaceRoot || !planFile) {
                        this._seams().ui.showErrorMessage('Missing workspace or feature file for refine prompt');
                        break;
                    }

                    // Read user-editable skill file (.agents → legacy .agent → embedded fallback).
                    const nfs = require('fs') as typeof import('fs');
                    let skillContent = '';
                    try {
                        skillContent = nfs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', 'refine_feature.md'), 'utf8');
                    } catch {
                        try {
                            skillContent = nfs.readFileSync(path.join(workspaceRoot, '.agent', 'skills', 'refine_feature.md'), 'utf8');
                        } catch {
                            skillContent = `Refine this feature into a complete specification with:
- A clear ## Goal (outcome + problem it solves)
- ## Success Criteria (checkboxed, testable)
- ## Scope (in/out)
- ## Proposed Subtasks (ordered, checkboxed breakdown into shippable units)
- ## Risks / Open Questions
Preserve YAML frontmatter and the auto-generated <!-- BEGIN SUBTASKS --> block. Do not create kanban cards. Write the result back to the local file path provided.`;
                        }
                    }

                    // Resolve the feature markdown file — use path.resolve to match existing codebase pattern.
                    const featureFilePath = path.isAbsolute(planFile) ? planFile : path.resolve(workspaceRoot, planFile);
                    let existingContent = '';
                    try { existingContent = nfs.readFileSync(featureFilePath, 'utf8'); } catch { /* file may not exist yet */ }

                    const prompt = `You are refining a Switchboard feature into a complete, decomposable specification.

## Skill Instructions
${skillContent}

## Feature to Refine
- **Title:** ${title || ''}
- **Existing subtask cards:** ${subtaskCount || 0}
- **Local file path (write the refined content here):** ${featureFilePath}

## Current feature file content
${existingContent ? existingContent : '(file is empty or does not exist yet — author a complete feature at the path above)'}

Read the current content above. Determine what's missing. Produce a complete feature following the skill instructions — pay special attention to a concrete ## Proposed Subtasks breakdown. Write the refined markdown directly to the local file path, preserving any YAML frontmatter and the auto-generated <!-- BEGIN SUBTASKS --> block. Do NOT create kanban cards or modify any database. Report back with a summary and the proposed subtask list.`;

                    await this._seams().clipboard.writeText(prompt);
                    this._seams().ui.showTemporaryNotification('Refine-feature prompt copied to clipboard. Paste it into your agent.');
                } catch (err) {
                    this._seams().ui.showErrorMessage(`Failed to copy refine-feature prompt: ${String(err)}`);
                }
                break;
            }
            case 'changeTicketStatus': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id, statusId } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.changeTicketStatus',
                        { workspaceRoot, provider, id, statusId }
                    );
                    this.postMessageToWebview({
                        type: 'changeTicketStatusResult',
                        success: result.success,
                        id,
                        statusId,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'changeTicketStatusResult',
                        success: false,
                        id,
                        statusId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'postTicketComment': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id, comment, mentions } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.postTicketComment',
                        { workspaceRoot, provider, id, comment, mentions }
                    );
                    this.postMessageToWebview({
                        type: 'postTicketCommentResult',
                        success: result.success,
                        id,
                        comment,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'postTicketCommentResult',
                        success: false,
                        id,
                        comment,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'loadTicketComments': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.loadTicketComments',
                        { workspaceRoot, provider, id }
                    );
                    this.postMessageToWebview({
                        type: 'ticketCommentsLoaded',
                        success: result.success,
                        id,
                        provider,
                        threads: result.threads || [],
                        members: result.members || [],
                        threadingSupported: result.threadingSupported,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'ticketCommentsLoaded',
                        success: false,
                        id,
                        provider,
                        threads: [],
                        members: [],
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'postTicketReply': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id, commentId, commentText, mentions } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.postTicketReply',
                        { workspaceRoot, provider, id, commentId, commentText, mentions }
                    );
                    this.postMessageToWebview({
                        type: 'postTicketReplyResult',
                        success: result.success,
                        id,
                        commentId,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'postTicketReplyResult',
                        success: false,
                        id,
                        commentId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'downloadAttachment': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, url, filename, ticketId, ticketTitle } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.downloadAttachment',
                        { workspaceRoot, provider, url, filename, ticketId, ticketTitle }
                    );
                    this.postMessageToWebview({
                        type: 'attachmentDownloaded',
                        success: result.success,
                        url,
                        filePath: result.filePath,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'attachmentDownloaded',
                        success: false,
                        url,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'viewAttachments': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, ticketId, attachments } = msg;
                try {
                    let result: any = await this._seams().commands.executeCommand(
                        'switchboard.getAttachmentList',
                        { workspaceRoot, provider, ticketId, attachmentsArray: attachments }
                    );
                    const targetPanel = isProject ? this._projectPanel : this._panel;
                    if (Array.isArray(result) && targetPanel) {
                        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
                        result = result.map((att: any) => {
                            if (att.isDownloaded && att.localPath) {
                                const ext = path.extname(att.localPath).toLowerCase();
                                if (imageExts.includes(ext)) {
                                    const uri = vscode.Uri.file(att.localPath);
                                    att.webviewUri = targetPanel.webview.asWebviewUri(uri).toString();
                                }
                            }
                            return att;
                        });
                    }
                    this._pushTo(targetPanel, 'planning', {
                        type: 'attachmentsListResult',
                        success: true,
                        ticketId,
                        attachments: result,
                        workspaceRoot
                    });
                } catch (error) {
                    const targetPanel = isProject ? this._projectPanel : this._panel;
                    this._pushTo(targetPanel, 'planning', {
                        type: 'attachmentsListResult',
                        success: false,
                        ticketId,
                        attachments: [],
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'openAttachment': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { localPath } = msg;
                try {
                    if (!localPath) {
                        throw new Error('No local path provided');
                    }
                    await this._seams().ui.openExternal(pathToFileURL(localPath).toString());
                    this.postMessageToWebview({
                        type: 'attachmentOpened',
                        success: true,
                        localPath,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'attachmentOpened',
                        success: false,
                        localPath,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'revealAttachment': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { localPath } = msg;
                try {
                    if (!localPath) {
                        throw new Error('No local path provided');
                    }
                    await this._seams().commands.executeCommand('revealInExplorer', localPath);
                    this.postMessageToWebview({
                        type: 'attachmentRevealed',
                        success: true,
                        localPath,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'attachmentRevealed',
                        success: false,
                        localPath,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupCreateTask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'clickupTaskCreated',
                        success: false,
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                try {
                    let listId = msg.listId;
                    if (msg.parentId) {
                        const parentListId = clickUp.getTaskListId(msg.parentId);
                        if (parentListId) listId = parentListId;
                    }
                    const task = await clickUp.createTask({
                        name: msg.title,
                        listId,
                        description: msg.description,
                        ...(msg.parentId ? { parent: msg.parentId } : {}),
                        ...(msg.status ? { status: String(msg.status) } : {}),
                        ...(typeof msg.priority === 'number' && !isNaN(msg.priority) ? { priority: msg.priority } : {}),
                        ...(Array.isArray(msg.assignees) ? { assignees: msg.assignees.map(Number).filter((n: number) => !isNaN(n)) } : {})
                    });
                    if (task) {
                        // A remote-only ticket diverges from every other ticket in the
                        // tab (which are both local + online). Import it immediately so
                        // the local file + DB entry exist, exactly like the Import button.
                        // Pass the createTask response as preFetchedTask to dodge the
                        // read-after-write lag where a fresh getTaskDetails() returns
                        // null for a just-created task.
                        let importOk = true;
                        let importError: string | undefined;
                        try {
                            const importResult: any = await this._seams().commands.executeCommand(
                                'switchboard.importTaskAsDocument',
                                { workspaceRoot, provider: 'clickup', id: task.id, includeSubtasks: false, preFetchedTask: task }
                            );
                            if (importResult && importResult.success === false) {
                                importOk = false;
                                importError = importResult.error || 'Local document write failed.';
                            }
                        } catch (importErr) {
                            importOk = false;
                            importError = importErr instanceof Error ? importErr.message : String(importErr);
                            console.error('[PlanningPanel] Created ClickUp task but local import failed:', importErr);
                        }
                        this.postMessageToWebview({
                            type: 'clickupTaskCreated',
                            success: importOk,
                            ...(importError ? { error: `Task created remotely, but local file write failed: ${importError}` } : {}),
                            workspaceRoot
                        });
                    } else {
                        this.postMessageToWebview({
                            type: 'clickupTaskCreated',
                            success: false,
                            error: 'Failed to create ClickUp task (empty result).',
                            workspaceRoot
                        });
                    }
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupTaskCreated',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'linearCreateIssue': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'linearIssueCreated',
                        success: false,
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    break;
                }
                const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                try {
                    let projectId: string | undefined;
                    if (msg.projectName) {
                        const projects = await linear.getAvailableProjects();
                        const matching = projects.find((p: any) => p.name === msg.projectName || p.id === msg.projectName);
                        if (matching) {
                            projectId = matching.id;
                        } else {
                            projectId = msg.projectName;
                        }
                    }
                    const result = await linear.createIssueSimple({
                        title: msg.title,
                        description: msg.description,
                        projectId,
                        ...(msg.parentId ? { parentId: msg.parentId } : {}),
                        ...(msg.status ? { stateId: String(msg.status) } : {}),
                        ...(typeof msg.priority === 'number' && !isNaN(msg.priority) ? { priority: msg.priority } : {}),
                        ...(msg.assigneeId ? { assigneeId: String(msg.assigneeId) } : {})
                    });
                    // A remote-only ticket diverges from every other ticket in the tab
                    // (which are both local + online). Import it immediately so the local
                    // file + DB entry exist, exactly like the Import button. Pass the
                    // createIssueSimple response + the typed title/description/projectName
                    // as preFetchedTask to dodge the read-after-write lag where a fresh
                    // getIssue() returns null for a just-created issue.
                    let importOk = true;
                    let importError: string | undefined;
                    if (result?.id) {
                        try {
                            const importResult: any = await this._seams().commands.executeCommand(
                                'switchboard.importTaskAsDocument',
                                {
                                    workspaceRoot,
                                    provider: 'linear',
                                    id: result.id,
                                    includeSubtasks: false,
                                    preFetchedTask: {
                                        id: result.id,
                                        identifier: result.identifier,
                                        title: msg.title,
                                        description: msg.description,
                                        projectName: msg.projectName
                                    }
                                }
                            );
                            if (importResult && importResult.success === false) {
                                importOk = false;
                                importError = importResult.error || 'Local document write failed.';
                            }
                        } catch (importErr) {
                            importOk = false;
                            importError = importErr instanceof Error ? importErr.message : String(importErr);
                            console.error('[PlanningPanel] Created Linear issue but local import failed:', importErr);
                        }
                    }
                    this.postMessageToWebview({
                        type: 'linearIssueCreated',
                        success: importOk,
                        result,
                        ...(importError ? { error: `Issue created remotely, but local file write failed: ${importError}` } : {}),
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearIssueCreated',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'convertToSubtask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'subtaskConverted',
                        success: false,
                        error: 'No workspace folder found',
                        provider: msg.provider,
                        taskId: msg.taskId,
                        parentId: msg.parentId
                    });
                    break;
                }
                try {
                    if (msg.provider === 'clickup') {
                        const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        await clickUp.updateTask(msg.taskId, { parent: msg.parentId });
                    } else if (msg.provider === 'linear') {
                        const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        await linear.updateIssueParent(msg.taskId, msg.parentId);
                    } else {
                        throw new Error(`Unknown provider: ${msg.provider}`);
                    }
                    this.postMessageToWebview({
                        type: 'subtaskConverted',
                        success: true,
                        provider: msg.provider,
                        taskId: msg.taskId,
                        parentId: msg.parentId,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'subtaskConverted',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        provider: msg.provider,
                        taskId: msg.taskId,
                        parentId: msg.parentId
                    });
                }
                break;
            }
            case 'ticketsAskAgent': {
                const askWorkspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const ticketId = String(msg.id || '').trim();
                const provider = msg.provider === 'clickup' ? 'clickup' : 'linear';

                if (!askWorkspaceRoot || !ticketId) {
                    this.postMessageToWebview({
                        type: 'ticketsAskAgentResult',
                        success: false,
                        error: 'Missing workspace or ticket ID',
                        workspaceRoot: askWorkspaceRoot || msg.workspaceRoot || undefined
                    });
                    break;
                }

                try {
                    await this._seams().commands.executeCommand(
                        'switchboard.askAgentTask',
                        {
                            workspaceRoot: askWorkspaceRoot,
                            id: ticketId,
                            title: String(msg.title || '').trim(),
                            description: String(msg.description || '').trim(),
                            provider
                        }
                    );
                    this.postMessageToWebview({ type: 'ticketsAskAgentResult', success: true, workspaceRoot: askWorkspaceRoot });
                } catch (error) {
                    console.error('[PlanningPanel] Failed to send ticket to agent:', error);
                    this.postMessageToWebview({
                        type: 'ticketsAskAgentResult',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot: askWorkspaceRoot
                    });
                }
                break;
            }
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
                    return { success: true, ...res };
                } catch (err) {
                    const errRes = { type: 'syncConfigReady', uploadLocations: {}, docMappings: {} };
                    this.postMessageToWebview(errRes);
                    return { success: false, ...errRes };
                }
            }
            case 'loadInsights': {
                const wsRoot = String(msg.workspaceRoot || '');
                if (wsRoot) {
                    const insights = InsightManager.listInsights(wsRoot);
                    this.postMessageToProjectWebview({ type: 'insightsLoaded', insights });
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
                    this.postMessageToProjectWebview({ type: 'insightsLoaded', insights: allInsights });
                }
                break;
            }
            case 'readInsight': {
                const wsRoot = String(msg.workspaceRoot || '');
                const filename = String(msg.filename || '');
                if (!wsRoot || !filename) { break; }
                try {
                    const content = InsightManager.readInsight(wsRoot, filename);
                    if (content) {
                        const renderedHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', content);
                        this.postMessageToProjectWebview({
                            type: 'insightContent',
                            filename,
                            workspaceRoot: wsRoot,
                            content,
                            renderedHtml
                        });
                    }
                } catch (err) {
                    console.error('[PlanningPanel] Failed to read insight:', err);
                }
                break;
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
                const extractPrompt = `Run the tuning skill in extract mode for workspace: ${effectiveWsRoot}\n\nScan the following plan files for adversarial review sections ("Stage 1 — Grumpy Adversarial Findings" and "Stage 2 — Balanced Synthesis"):\n${planFilesList}\n\nFor each plan, extract the review findings. Then cluster recurring problem patterns across plans using these criteria:\n  - Same problem category (e.g., missing error handling, race conditions, prompt-design flaws, unvalidated assumptions)\n  - Same severity level (recurring vs critical vs minor)\n  - Same governance target (CONSTITUTION.md vs AGENTS.md vs CLAUDE.md)\nFor each distinct pattern, create an insight .md file in ${effectiveWsRoot}/.switchboard/insights/ using the insight template. If an existing insight covers the same pattern (same category AND similar description), append new evidence to it instead of creating a duplicate. When appending, update the Source Plans list and add new evidence entries.`;
                await this._seams().clipboard.writeText(extractPrompt);
                this._seams().ui.showTemporaryNotification('Tuning extract prompt copied to clipboard. Paste it into your agent chat.');
                this.postMessageToProjectWebview({ type: 'tuningExtractComplete', planCount: planFiles.length });
                break;
            }
            case 'runTuningGovernance': {
                const wsRoot = String(msg.workspaceRoot || '');
                const effectiveWsRoot = wsRoot || (allRoots.length > 0 ? allRoots[0] : '');
                const governancePrompt = `Run the tuning skill in governance mode for workspace: ${effectiveWsRoot}\n\nRead all insight files in ${effectiveWsRoot}/.switchboard/insights/ with status 'open'. Review the insights and propose specific edits to governance files (CONSTITUTION.md, AGENTS.md, CLAUDE.md) to address the recurring patterns. Present proposed changes as diffs.`;
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

    private async _sendLocalDocsReady(force: boolean = false): Promise<void> {
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

            if (!this._panel) {
                throw new Error('[PlanningPanel] _panel is undefined — cannot send localDocsReady');
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
            // "loading local docs", and steals the active tab. Skip when nothing changed.
            const signature = JSON.stringify({
                folderPathsByRoot: configuredFolderPathsByRoot,
                ticketsFolderPathsByRoot,
                nodes: mappedNodes,
                antigravitySessions,
                workspaceItems
            });
            if (!force && signature === this._lastLocalDocsSignature) {
                return;
            }
            this._lastLocalDocsSignature = signature;

            console.log('[PlanningPanel] Sending localDocsReady, total nodes count:', allFiles.length);
            this.postMessageToWebview({
                type: 'localDocsReady',
                sourceId: 'local-folder',
                folderPathsByRoot: configuredFolderPathsByRoot,
                ticketsFolderPathsByRoot,
                nodes: mappedNodes,
                workspaceItems,
                kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
                antigravitySessions
            });
        } catch (err) {
            console.error('[PlanningPanel] Failed to fetch local-folder roots:', err);
            this._lastLocalDocsSignature = ''; // force re-render on next successful send
            this.postMessageToWebview({
                type: 'localDocsReady',
                sourceId: 'local-folder',
                folderPathsByRoot: {},
                ticketsFolderPathsByRoot: {},
                nodes: [],
                workspaceItems: this._buildKanbanWorkspaceItems(),
                kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
                error: String(err)
            });
        }
    }


    private async _sendOnlineDocsReady(): Promise<void> {
        const availableSources = this._researchImportService.getAvailableSources();
        console.log('[PlanningPanel] Available sources before filtering:', availableSources);

        const adapters = this._researchImportService.getAdapters();
        const roots = adapters
            .filter(a => a.sourceId !== 'local-folder')
            .map(a => ({ sourceId: a.sourceId, nodes: [] as TreeNode[] }));

        // Load saved browse filter containers from unified config
        const { config } = await this._resolveSyncConfig();
        const browseFilterContainers = config.browseFilterContainers || {};

        if (!this._panel) { throw new Error('[PlanningPanel] _panel is undefined — cannot send onlineDocsReady'); }
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
        this.postMessageToWebview({
            type: 'onlineDocsReady',
            roots,
            enabledSources,
            browseFilterContainers
        });
    }

    private async _handleFetchRoots(forceLocalDocs: boolean = false): Promise<void> {
        await this._sendLocalDocsReady(forceLocalDocs);
        await this._sendOnlineDocsReady();
        await this._sendPlanningHtmlDocsReady();
        await this._handleFetchImportedDocs(this._getWorkspaceRoot() || '');
        const cyberAnimationDisabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberAnimation', false);
        this.postMessageToWebview({ type: 'cyberAnimationSetting', disabled: cyberAnimationDisabled });
        const cyberScanlinesDisabled = this._seams().pathConfig.getConfigBoolean('theme.disableCyberScanlines', false);
        this.postMessageToWebview({ type: 'cyberScanlinesSetting', disabled: cyberScanlinesDisabled });
        const currentTheme = this._seams().pathConfig.getConfigStringWithDefault('theme.name', 'afterburner');
        this.postMessageToWebview({ type: 'switchboardThemeNameSetting', theme: currentTheme });
    }

    private async _handleFetchChildren(workspaceRoot: string, sourceId: string, parentId?: string): Promise<void> {
        // Handle local-folder directly without adapter
        if (sourceId === 'local-folder') {
            const localFolderService = this._getLocalFolderService(workspaceRoot);
            try {
                const files = await localFolderService.listFiles();
                const nodes = this._mapLocalFilesToTreeNodes(files)
                    .filter(node => node.parentId === parentId || (!parentId && !node.parentId));
                this.postMessageToWebview({ type: 'childrenReady', sourceId, parentId, nodes });
            } catch (err) {
                console.error(`Failed to fetch children for ${sourceId}:`, err);
                this.postMessageToWebview({ type: 'childrenReady', sourceId, parentId, nodes: [] });
            }
            return;
        }

        const adapter = this._researchImportService.getAdapter(sourceId);
        if (!adapter) {
            this.postMessageToWebview({ type: 'childrenReady', sourceId, parentId, nodes: [] });
            return;
        }

        try {
            const nodes = await adapter.fetchChildren(parentId);
            this.postMessageToWebview({ type: 'childrenReady', sourceId, parentId, nodes });
        } catch (err) {
            console.error(`Failed to fetch children for ${sourceId}:`, err);
            this.postMessageToWebview({ type: 'childrenReady', sourceId, parentId, nodes: [] });
        }
    }

    private _getPreviewCacheKey(sourceId: string, docId: string, sourceFolder?: string): string {
        return `${sourceId}:${docId}:${sourceFolder || ''}`;
    }

    private async _handleFetchPreview(workspaceRoot: string, sourceId: string, docId: string, requestId: number, sourceFolder?: string): Promise<void> {
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
                this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: 'sourceFolder is required' });
                return;
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
            await this._buildAndSendPlanningHtmlPreview({ sourceId, sourceFolder, docId, requestId });
            return;
        }

        // Handle local-folder directly without adapter
        if (sourceId === 'local-folder') {
            if (!sourceFolder) {
                this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: 'sourceFolder is required' });
                return;
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
                            this.postMessageToWebview({
                                type: 'previewReady',
                                sourceId,
                                requestId,
                                content: result.content || '',
                                docName: result.docTitle,
                                isAutoRefreshed: false,
                                filePath: resolvedPath
                            });
                        }
                        return;
                    }
                    this._lastPreviewContentByPath.set(cacheKey, result.content || '');

                    this.postMessageToWebview({ 
                        type: 'previewReady', 
                        sourceId, 
                        requestId, 
                        content: result.content || '', 
                        docName: result.docTitle,
                        isAutoRefreshed: this._isAutoRefreshing,
                        filePath: resolvedPath
                    });
                } else {
                    this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: result.error || 'Failed to fetch document' });
                }
            } catch (err) {
                console.error('[PlanningPanel] Error fetching local doc:', err);
                this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: String(err) });
            }
            return;
        }

        const adapter = this._researchImportService.getAdapter(sourceId);
        if (!adapter) {
            this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: 'Adapter not found' });
            return;
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

                    this.postMessageToWebview({ 
                        type: 'previewReady', 
                        sourceId, 
                        requestId, 
                        content, 
                        docName, 
                        isCached: true, 
                        isImported,
                        isAutoRefreshed: this._isAutoRefreshing
                    });
                    // Refresh cache in background after returning cached content
                    this._refreshCacheInBackground(sourceId, docId, adapter);
                    return;
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
                        this.postMessageToWebview({
                            type: 'previewReady',
                            sourceId,
                            requestId,
                            docName: docResult.docTitle,
                            content: docResult.content || docResult.firstPageContent || '',
                            pages: docResult.pages,
                            totalPages: docResult.totalPages,
                            isAutoRefreshed: this._isAutoRefreshing
                        });
                        return;
                    }
                    content = docResult.content || '';
                    docName = docResult.docTitle;
                } else {
                    this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: docResult.error || 'Failed to fetch ClickUp document' });
                    return;
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

            this.postMessageToWebview({ 
                type: 'previewReady', 
                sourceId, 
                requestId, 
                content, 
                docName, 
                isCached: true, 
                isImported,
                isAutoRefreshed: this._isAutoRefreshing
            });
        } catch (err) {
            const currentRequestId = this._latestRequestIds.get(sourceId);
            if (currentRequestId === requestId) {
                this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: String(err) });
            }
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

    private async _handleFetchImportedDocs(workspaceRoot: string): Promise<void> {
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

            this.postMessageToWebview({ type: 'importedDocsReady', docs: allDocs });
        } catch (err) {
            console.error('[PlanningPanelProvider] Error fetching imported docs:', err);
            this.postMessageToWebview({ type: 'importedDocsReady', docs: [], error: String(err) });
        }
    }

    private async _handleFetchDocsFile(workspaceRoot: string, slugPrefix: string, requestId: number): Promise<void> {
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
                this.postMessageToWebview({
                    type: 'previewError',
                    sourceId: 'local-folder',
                    requestId,
                    error: 'File not found'
                });
                return;
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
                return;
            }
            this._lastPreviewContentByPath.set(cacheKey, displayContent);

            this.postMessageToWebview({
                type: 'previewReady',
                sourceId: 'local-folder',
                requestId,
                content: displayContent,
                docName,
                isAutoRefreshed: this._isAutoRefreshing
            });
        } catch (err) {
            console.error('[PlanningPanelProvider] Error fetching docs file:', err);
            this.postMessageToWebview({
                type: 'previewError',
                sourceId: 'local-folder',
                requestId,
                error: String(err)
            });
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

    private async _handleFetchPageContent(workspaceRoot: string, sourceId: string, docId: string, pageId: string, requestId: number): Promise<void> {
        try {
            const adapter = this._researchImportService.getAdapter(sourceId);
            if (!adapter || !('fetchPageContent' in adapter)) {
                this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: 'Adapter does not support page content' });
                return;
            }

            const result = await (adapter as any).fetchPageContent(docId, pageId);
            if (result.success) {
                this.postMessageToWebview({
                    type: 'previewReady',
                    sourceId,
                    requestId,
                    content: result.content,
                    docName: result.docName
                });
            } else {
                this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: result.error || 'Failed to fetch page content' });
            }
        } catch (err) {
            this.postMessageToWebview({ type: 'previewError', sourceId, requestId, error: String(err) });
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

    private _scanLocalTicketFiles(dir: string, provider: string, out: any[]): void {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const nfs = require('fs') as typeof import('fs');
        let entries: import('fs').Dirent[];
        try { entries = nfs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._scanLocalTicketFiles(fullPath, provider, out);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                const match = entry.name.match(/^(?:clickup|linear)_([^_]+)_(.+)\.md$/);
                if (!match) { continue; }
                const id = match[1];
                let title = match[2].replace(/-/g, ' ');
                let kanbanColumn = '';
                let dateCreated: string | undefined;
                let assignees: string[] = [];
                let priority: { priority: string; color: string; orderindex: string } | null = null;
                try {
                    const content = nfs.readFileSync(fullPath, 'utf8');
                    const fm = content.match(/^---\n([\s\S]*?)\n---/);
                    if (fm) {
                        const km = fm[1].match(/kanbanColumn:\s*(.+)/); if (km) { kanbanColumn = km[1].trim(); }
                        const cm = fm[1].match(/^created:\s*(.+)$/m); if (cm) { dateCreated = cm[1].trim(); }
                        const am = fm[1].match(/^assignees:\s*(.+)$/m); if (am) { assignees = am[1].split(',').map(s => s.trim()).filter(Boolean); }
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
                    const displayContent = this._rewriteLocalImagePaths(content, path.dirname(filePath));
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

    private _updateTicketsAutoSyncWatcher(workspaceRoot: string, enabled: boolean): void {
        const existing = this._ticketsAutoSyncWatchers.get(workspaceRoot);
        if (!enabled) {
            if (existing) {
                try { existing.dispose(); } catch (e) {}
                this._ticketsAutoSyncWatchers.delete(workspaceRoot);
            }
            // Tear down the delta-pull timer as well — auto-sync OFF means
            // no background network activity (manual Refresh still works).
            const timer = this._ticketsAutoSyncTimers.get(workspaceRoot);
            if (timer) {
                clearInterval(timer);
                this._ticketsAutoSyncTimers.delete(workspaceRoot);
            }
            this._ticketsAutoSyncFailures.delete(workspaceRoot);
            this._ticketsAutoSyncNextEligible.delete(workspaceRoot);
            return;
        }
        if (existing) { return; } // already watching

        const watchFolders: string[] = [];
        const clickup = GlobalIntegrationConfigService.loadConfigSync('clickup');
        const linear = GlobalIntegrationConfigService.loadConfigSync('linear');
        if (clickup?.ticketSaveLocation) { watchFolders.push(clickup.ticketSaveLocation); }
        if (linear?.ticketSaveLocation) { watchFolders.push(linear.ticketSaveLocation); }
        watchFolders.push(path.join(workspaceRoot, '.switchboard/tickets'));

        const watchers: HostWatchHandle[] = [];
        for (const folder of watchFolders) {
            if (!fs.existsSync(folder)) { continue; }
            const watcher = this._seams().watcher.watchFolder(folder, (event, filePath) => {
                if (event !== 'change' || !filePath.endsWith('.md')) { return; }
                const fileName = path.basename(filePath);
                const match = fileName.match(/^(linear|clickup)_([^_]+)_.*\.md$/);
                if (!match) { return; }
                const [, provider, id] = match;

                const debounceKey = filePath;
                const existing = this._ticketsAutoSyncDebounces.get(debounceKey);
                if (existing) { clearTimeout(existing); }
                this._ticketsAutoSyncDebounces.set(debounceKey, setTimeout(async () => {
                    this._ticketsAutoSyncDebounces.delete(debounceKey);
                    try {
                        const result: any = await this._seams().commands.executeCommand(
                            'switchboard.pushTicketEdits',
                            { workspaceRoot, provider: provider as 'linear' | 'clickup', id }
                        );
                        this.postMessageToWebview({
                            type: 'pushTicketResult',
                            success: result?.success ?? false,
                            id,
                            error: result?.error,
                            autoSync: true
                        });
                    } catch (e) {
                        this.postMessageToWebview({
                            type: 'pushTicketResult',
                            success: false,
                            id,
                            error: e instanceof Error ? e.message : String(e),
                            autoSync: true
                        });
                    }
                }, 2000));
            });
            watchers.push(watcher);
        }

        this._ticketsAutoSyncWatchers.set(workspaceRoot, {
            dispose: () => watchers.forEach(w => { try { w.dispose(); } catch { } })
        });

        // Start the delta-pull timer (auto-sync ON only). Runs every 45s —
        // safe for both ClickUp (100 req/min) and Linear (5,000 req/hour).
        // The callback wraps API calls in try/catch with exponential backoff
        // on consecutive failures (cap at 5, then pause until next toggle).
        // Errors are logged silently — no user toast spam on every failed poll.
        const POLL_INTERVAL_MS = 45000;
        const MAX_CONSECUTIVE_FAILURES = 5;
        const timer = setInterval(async () => {
            const failures = this._ticketsAutoSyncFailures.get(workspaceRoot) || 0;
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
                // Paused — wait for toggle cycle to reset. Log once.
                return;
            }
            // Exponential backoff: after N consecutive failures, skip ticks
            // until the next eligible time (now + INTERVAL * 2^N at the time
            // of the failure). This spaces out retries: 45s → 90s → 180s → …
            const now = Date.now();
            const nextEligible = this._ticketsAutoSyncNextEligible.get(workspaceRoot) || 0;
            if (nextEligible > now) { return; }
            const selection = this._ticketsCurrentSelection.get(workspaceRoot);
            if (!selection || !selection.provider) { return; }
            try {
                // Reuse the same delta-pull path as the manual Refresh button.
                // The cursor is read/updated inside importAllTasks; here we
                // just trigger it silently (no user toast on success).
                if (!this._cacheService) {
                    this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                }
                const kanbanDb = (this._cacheService as any)?._kanbanDb;
                const cursorKey = selection.provider === 'clickup'
                    ? `last_delta_pull_clickup_${selection.listId || ''}`
                    : `last_delta_pull_linear_${selection.projectId || ''}`;
                let lastPullIso: string | null = null;
                if (kanbanDb) {
                    try { lastPullIso = await kanbanDb.getMeta(cursorKey); } catch { /* ignore */ }
                }
                const deltaSince = lastPullIso ? new Date(lastPullIso).getTime() : undefined;
                const deltaSinceIso = lastPullIso || undefined;

                const result: any = await this._seams().commands.executeCommand(
                    'switchboard.importAllTasks',
                    {
                        workspaceRoot,
                        provider: selection.provider,
                        listId: selection.listId,
                        projectId: selection.projectId,
                        importMode: 'document',
                        ...(deltaSince !== undefined ? { deltaSince } : {}),
                        ...(deltaSinceIso ? { deltaSinceIso } : {})
                    }
                );

                if (result?.success && kanbanDb) {
                    try { await kanbanDb.setMeta(cursorKey, new Date().toISOString()); } catch { /* ignore */ }
                }

                if (result?.success) {
                    this._ticketsAutoSyncFailures.set(workspaceRoot, 0);
                    this._ticketsAutoSyncNextEligible.set(workspaceRoot, 0);
                    // If any tickets were updated OR deleted, refresh the sidebar
                    // silently. Without the deletedCount check, a tick where only
                    // deletions occurred (no updates) would not refresh the sidebar
                    // and the deleted ticket's card would linger until the next
                    // update-bearing tick.
                    if ((result.successCount || 0) > 0 || (result.deletedCount || 0) > 0) {
                        this.postMessageToWebview({
                            type: 'importAllTicketsComplete',
                            success: true,
                            successCount: result.successCount,
                            failCount: result.failCount,
                            deletedCount: result.deletedCount,
                            errors: result.errors,
                            importMode: 'document',
                            workspaceRoot,
                            provider: selection.provider,
                            listId: selection.listId,
                            projectId: selection.projectId,
                            isDelta: lastPullIso !== null,
                            autoSync: true
                        });
                    }
                } else {
                    const f = (this._ticketsAutoSyncFailures.get(workspaceRoot) || 0) + 1;
                    this._ticketsAutoSyncFailures.set(workspaceRoot, f);
                    // Exponential backoff: next eligible = now + INTERVAL * 2^f
                    this._ticketsAutoSyncNextEligible.set(workspaceRoot, Date.now() + POLL_INTERVAL_MS * Math.pow(2, f));
                    console.warn(`[PlanningPanel] Auto-sync delta pull failed (${f}/${MAX_CONSECUTIVE_FAILURES}):`, result?.error);
                }
            } catch (e) {
                const f = (this._ticketsAutoSyncFailures.get(workspaceRoot) || 0) + 1;
                this._ticketsAutoSyncFailures.set(workspaceRoot, f);
                this._ticketsAutoSyncNextEligible.set(workspaceRoot, Date.now() + POLL_INTERVAL_MS * Math.pow(2, f));
                console.warn(`[PlanningPanel] Auto-sync delta pull error (${f}/${MAX_CONSECUTIVE_FAILURES}):`, e);
            }
        }, POLL_INTERVAL_MS);
        this._ticketsAutoSyncTimers.set(workspaceRoot, timer);
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
        for (const watcher of this._ticketsAutoSyncWatchers.values()) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._ticketsAutoSyncWatchers.clear();
        for (const t of this._ticketsAutoSyncDebounces.values()) { clearTimeout(t); }
        this._ticketsAutoSyncDebounces.clear();
        // Tear down delta-pull timers.
        for (const t of this._ticketsAutoSyncTimers.values()) { clearInterval(t); }
        this._ticketsAutoSyncTimers.clear();
        this._ticketsAutoSyncFailures.clear();
        this._ticketsAutoSyncNextEligible.clear();
        this._ticketsCurrentSelection.clear();

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
