import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { stateFs as fs } from './stateConfigBridge';
import { applyThemeBodyClass } from './themeBodyClass';
import { KanbanDatabase } from './KanbanDatabase';
import * as http from 'http';
import {
    ResearchImportService,
    TreeNode,
    NotionResearchAdapter
} from './ResearchImportService';
import { PlannerPromptWriter } from './PlannerPromptWriter';
import { NotionFetchService } from './NotionFetchService';
import { NotionBrowseService } from './NotionBrowseService';
import { LocalFolderService } from './LocalFolderService';
import { LinearDocsAdapter } from './LinearDocsAdapter';
import { ClickUpDocsAdapter } from './ClickUpDocsAdapter';
import { PlanningPanelCacheService } from './PlanningPanelCacheService';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import { buildKanbanColumns, KanbanColumnDefinition, CustomKanbanColumnConfig, CustomAgentConfig, parseCustomAgents } from './agentConfig';
import { ReviewCommentRequest, ReviewCommentResult } from './reviewTypes';
import { isValidComplexityValue, legacyToScore } from './complexityScale';
import { applyManualComplexityOverride } from './planMetadataUtils';
import { formatReviewLogEntries } from './reviewLogUtils';
import { PanelStateStore } from './PanelStateStore';
import { buildWorkspaceItems } from './workspaceUtils';
import { GlobalPlanWatcherService } from './GlobalPlanWatcherService';
import { InsightManager } from './InsightManager';
import { GovernanceFileKey } from './constitutionUtils';
import { getProjectPrdPath } from './prdUtils';


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
    isEpic?: number;
    epicId?: string;
    subtaskCount?: number;
    clickupTaskId?: string;
    linearIssueId?: string;
}

export class PlanningPanelProvider {
    private static readonly IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg']);
    private _panel: vscode.WebviewPanel | undefined;
    private _projectPanel: vscode.WebviewPanel | undefined;
    private _disposables: vscode.Disposable[] = [];
    private _latestRequestIds: Map<string, number> = new Map();
    private _registeredRootsKey: string | null = null;
    private _cacheService: PlanningPanelCacheService | undefined;
    private _periodicSyncTimer: NodeJS.Timeout | undefined;
    private _currentSyncMode: string = 'no-sync';
    private _syncCancellationSource: AbortController | undefined;
    private _importInProgress = false;
    private _docsFolderWatcher: vscode.FileSystemWatcher | undefined;
    private _localFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _localDocsDebounce: NodeJS.Timeout | undefined;
    private _lastLocalDocsSignature = ''; // content dedup: skip re-posting an unchanged local-docs list
    private _lastPreviewContentByPath: Map<string, string> = new Map(); // content dedup: skip re-sending unchanged preview content
    private _lastWebviewRootsSignature = ''; // skip reassigning webview.options when roots are unchanged (avoids reload loop)
    private _antigravityWatchers: vscode.FileSystemWatcher[] = [];
    private _activeDocWatcher: vscode.FileSystemWatcher | undefined;
    private _activeDocWatchDebounce: NodeJS.Timeout | undefined;
    private _kanbanPlansWatchers: vscode.FileSystemWatcher[] = [];
    private _kanbanPlansWatchDebounce: NodeJS.Timeout | undefined;
    private _epicDocsWatchers: vscode.FileSystemWatcher[] = [];
    private _epicDocsWatchDebounce: NodeJS.Timeout | undefined;
    private _constitutionWatchers: vscode.FileSystemWatcher[] = [];
    private _constitutionWatchDebounce: NodeJS.Timeout | undefined;
    private _insightsWatchers: vscode.FileSystemWatcher[] = [];
    private _insightsWatchDebounce: NodeJS.Timeout | undefined;
    private _ticketsAutoSyncWatchers: Map<string, vscode.Disposable> = new Map();
    private _ticketsViewWatcher: vscode.Disposable | undefined;
    private _ticketsViewWatcherDebounces: Map<string, NodeJS.Timeout> = new Map();
    private _ticketsAutoSyncDebounces: Map<string, NodeJS.Timeout> = new Map();
    private _lastPanelWriteTimestamp: number = 0;
    private _isAutoRefreshing: boolean = false;
    private _nonce: string = '';
    private _activePreviewPath: string | null = null;
    private _activePreviewSourceId: string | null = null;
    private _activePreviewDocId: string | null = null;
    private _activePreviewSourceFolder: string | null = null;
    private _activePreviewWorkspaceRoot: string | undefined;
    private _planningHtmlFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _planningHtmlDocsDebounce: NodeJS.Timeout | undefined;
    private _planningHtmlServers = new Map<string, { server: http.Server; port: number; timeoutId: NodeJS.Timeout }>();
    private _planningHtmlServerCreationPromises = new Map<string, Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }>>();
    private _activePlanningHtmlPreview: { sourceFolder: string; docId: string; sourceId: string } | null = null;
    private _saveTextDocListener: vscode.Disposable | undefined;
    private _watcherGeneration: number = 0;
    private _activeDesignDocSourceId: string | null = null;
    private _activeDesignDocId: string | null = null;
    private _activeTicketsProvider: 'clickup' | 'linear' | null = null;
    // Type-only reference (avoids a runtime circular import with KanbanProvider). Used to
    // assemble/dispatch the orchestrator prompt for the Epics-tab Orchestrate action so the
    // builder logic lives in one place (preview = dispatch parity).
    private _kanbanProvider?: import('./KanbanProvider').KanbanProvider;
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

    public async openProject(): Promise<void> {
        this._lastWebviewRootsSignature = '';
        if (this._projectPanel) {
            this._projectPanel.reveal(vscode.ViewColumn.One);
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
        this._projectPanel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
        this._updateWebviewRoots();

        this._projectPanel.webview.html = this._getProjectHtml(this._projectPanel.webview);

        this._projectPanel.webview.onDidReceiveMessage(
            async message => {
                try {
                    await this._handleMessage(message, true);
                } catch (err) {
                    console.error('[ProjectPanel] Message handler error:', err);
                    this._projectPanel?.webview.postMessage({ type: 'error', message: String(err) });
                }
            },
            null,
            this._disposables
        );

        this._projectPanel.onDidDispose(
            () => {
                this._projectPanel = undefined;
            },
            null,
            this._disposables
        );

        // Hot-swap the theme on the Project panel when the setting changes (it previously
        // only learned the theme on init, so it needed a reload to update).
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('switchboard.theme.name')) {
                    const t = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                    this._projectPanel?.webview.postMessage({ type: 'switchboardThemeChanged', theme: t });
                }
                if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
                    const d = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
                    this._projectPanel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled: d });
                }
            })
        );

        const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
        this._projectPanel.webview.postMessage({ type: 'switchboardThemeChanged', theme });
        const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
        this._projectPanel.webview.postMessage({ type: 'cyberAnimationSetting', disabled });

        await this._sendActiveDesignDocState();
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
                    this._panel?.webview.postMessage({ type: 'error', message: String(err) });
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(
            () => {
                this.dispose();
            },
            null,
            this._disposables
        );

        // Register adapters when panel opens
        this._ensureAdaptersRegistered();

        // Start periodic sync if configured (unified config discovery across all roots)
        const allRoots = this._getWorkspaceRoots();
        const workspaceRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);
        const { config, sourceRoot } = await this._resolveSyncConfig();
        const syncMode = config.syncMode || 'no-sync';

        if (syncMode !== 'no-sync' && sourceRoot) {
            await this.triggerSync(sourceRoot, syncMode);
        }

        this._disposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => {
                this._panel?.webview.postMessage({ type: 'themeChanged' });
            })
        );

        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
                    const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
                    this._panel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled });
                }
                if (e.affectsConfiguration('switchboard.theme.name')) {
                    const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                    this._panel?.webview.postMessage({ type: 'switchboardThemeChanged', theme });
                }
            })
        );

        // Re-register adapters when workspace folders change
        this._disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                console.log('[PlanningPanel] Workspace folders changed, re-registering adapters');
                this._ensureAdaptersRegistered();
                this._setupKanbanPlansWatcher();
                this._setupEpicDocsWatcher();
                this._setupConstitutionWatcher();
                this._setupInsightsWatcher();
                this._panel?.webview.postMessage({
                    type: 'workspaceItemsUpdated',
                    items: buildWorkspaceItems(this._getWorkspaceRoots())
                });
            })
        );

        // Watch the docs directory for changes and refresh imported docs list
        this._setupDocsFolderWatcher(workspaceRoot);
        this._setupLocalFolderWatchers();
        this._setupPlanningHtmlFolderWatchers();

        this._setupAntigravityWatcher();
        this._setupKanbanPlansWatcher();
        this._setupEpicDocsWatcher();
        this._setupConstitutionWatcher();
        this._setupInsightsWatcher();

        // Send initial active design doc state
        await this._sendActiveDesignDocState();
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
                    panel.webview.postMessage({ type: 'error', message: String(err) });
                }
            },
            null,
            this._disposables
        );

        // Use the same dispose semantics as open(): for the planning panel,
        // dispose all shared resources; for project panel, just null the ref.
        if (isProject) {
            panel.onDidDispose(() => {
                this._projectPanel = undefined;
            }, null, this._disposables);
        } else {
            panel.onDidDispose(() => {
                this.dispose();
            }, null, this._disposables);
        }

        const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
        panel.webview.postMessage({ type: 'switchboardThemeChanged', theme });
        const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
        panel.webview.postMessage({ type: 'cyberAnimationSetting', disabled });

        // For the Planning (non-Project) panel, replicate the live-update listeners and file
        // watchers that open() registers, so a RESTORED panel auto-refreshes on external
        // file/theme/workspace changes instead of going stale until the user reopens it.
        // (Adapters self-register lazily in _handleMessage; periodic sync is intentionally NOT
        // started here — deferred to the next explicit open() to avoid duplicate sync jobs.)
        if (!isProject) {
            this._disposables.push(
                vscode.window.onDidChangeActiveColorTheme(() => {
                    this._panel?.webview.postMessage({ type: 'themeChanged' });
                })
            );

            this._disposables.push(
                vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
                        const animDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
                        this._panel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled: animDisabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.name')) {
                        const themeName = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                        this._panel?.webview.postMessage({ type: 'switchboardThemeChanged', theme: themeName });
                    }
                })
            );

            this._disposables.push(
                vscode.workspace.onDidChangeWorkspaceFolders(() => {
                    console.log('[PlanningPanel] Workspace folders changed, re-registering adapters');
                    this._ensureAdaptersRegistered();
                    this._setupKanbanPlansWatcher();
                    this._setupEpicDocsWatcher();
                    this._setupConstitutionWatcher();
                    this._setupInsightsWatcher();
                    this._panel?.webview.postMessage({
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
            this._setupEpicDocsWatcher();
            this._setupConstitutionWatcher();
            this._setupInsightsWatcher();
        }

        await this._sendActiveDesignDocState();
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
        this._panel?.webview.postMessage(message);
    }

    public revealProject(): void {
        if (this._projectPanel) {
            this._projectPanel.reveal(vscode.ViewColumn.One);
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
        this._projectPanel?.webview.postMessage(message);
    }

    private _setupDocsFolderWatcher(workspaceRoot: string | undefined): void {
        if (!workspaceRoot) return;

        const docsDir = path.join(workspaceRoot, '.switchboard', 'docs');
        const docsUri = vscode.Uri.file(docsDir);

        // Create watcher for the docs directory
        this._docsFolderWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(docsUri, '*.md')
        );

        // Refresh imported docs when files are created, deleted, or changed
        const refreshImportedDocs = () => {
            if (Date.now() - this._lastPanelWriteTimestamp < 2000) {
                return;
            }
            if (workspaceRoot) {
                this._handleFetchImportedDocs(workspaceRoot);
            }
        };

        this._docsFolderWatcher.onDidCreate(refreshImportedDocs);
        this._docsFolderWatcher.onDidDelete(refreshImportedDocs);
        this._docsFolderWatcher.onDidChange(refreshImportedDocs);

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

        for (const root of allRoots) {
            const localFolderService = this._getLocalFolderService(root);
            const folderPaths = localFolderService.getFolderPaths();

            for (const folderPath of folderPaths) {
                if (!folderPath) continue;
                // Deduplicate: skip if already watching this absolute path
                if (watchedPaths.has(folderPath)) continue;
                watchedPaths.add(folderPath);

                const folderUri = vscode.Uri.file(folderPath);

                // Create watcher for the local docs folder — recursive, all supported text extensions
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(folderUri, '**/*.{md,txt,markdown,rst,adoc}')
                );

                // Refresh local docs when files are created, deleted, or changed (debounced)
                const refreshLocalDocs = () => {
                    this._scheduleLocalDocsRefresh();
                };

                watcher.onDidCreate(refreshLocalDocs);
                watcher.onDidDelete(refreshLocalDocs);
                watcher.onDidChange(refreshLocalDocs);

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

        const config = vscode.workspace.getConfiguration('switchboard');
        const enabled = config.get<boolean>('research.antigravityBrainEnabled', false);
        if (!enabled) { return; }

        const allRoots = this._getWorkspaceRoots();
        const service = this._getLocalFolderService(allRoots[0] || '');
        const brainPaths = service.detectAntigravityBrainPaths();
        if (brainPaths.length === 0) { return; }

        const refresh = () => this._scheduleLocalDocsRefresh();
        const watchedPaths = new Set<string>();

        for (const brainPath of brainPaths) {
            const resolvedPath = path.resolve(brainPath);
            if (watchedPaths.has(resolvedPath)) { continue; }
            watchedPaths.add(resolvedPath);

            // CRITICAL: must use vscode.Uri.file for out-of-workspace paths.
            // Scope to document extensions only — watching '**/*' fired on every log/
            // knowledge/artifact write in the constantly-churning brain tree.
            const brainUri = vscode.Uri.file(brainPath);
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(brainUri, '**/*.{md,markdown,txt}')
            );

            watcher.onDidCreate(refresh);
            watcher.onDidChange(refresh);
            watcher.onDidDelete(refresh);
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

            // Create watcher relative to root to handle plans directory created after startup
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(root), '.switchboard/plans/**/*.md')
            );

            const triggerRefresh = () => {
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

            watcher.onDidCreate(triggerRefresh);
            watcher.onDidChange(triggerRefresh);
            watcher.onDidDelete(triggerRefresh);

            this._kanbanPlansWatchers.push(watcher);
            this._disposables.push(watcher);
        }
    }

    private _setupEpicDocsWatcher(): void {
        for (const w of this._epicDocsWatchers) {
            w.dispose();
            const idx = this._disposables.indexOf(w);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
        }
        this._epicDocsWatchers = [];

        const allRoots = this._getWorkspaceRoots();
        const watchedPaths = new Set<string>();

        for (const root of allRoots) {
            if (watchedPaths.has(root)) { continue; }
            watchedPaths.add(root);

            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(root), '.switchboard/epics/**/*.md')
            );

            const triggerRefresh = () => {
                if (!this._projectPanel) { return; }
                if (this._epicDocsWatchDebounce) {
                    clearTimeout(this._epicDocsWatchDebounce);
                }
                this._epicDocsWatchDebounce = setTimeout(() => {
                    this._epicDocsWatchDebounce = undefined;
                    if (!this._projectPanel) { return; }
                    this._handleMessage({ type: 'fetchEpicDocuments' }, true).catch(err => {
                        console.error('[PlanningPanel] Error auto-refreshing epic documents:', err);
                    });
                }, 400);
            };

            watcher.onDidCreate(triggerRefresh);
            watcher.onDidChange(triggerRefresh);
            watcher.onDidDelete(triggerRefresh);

            this._epicDocsWatchers.push(watcher);
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

                const relativePattern = path.relative(root, targetPath);
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(vscode.Uri.file(root), relativePattern));
                const refresh = () => {
                    if (!this._projectPanel) { return; }
                    // Notify the webview immediately so the correct file-type preview
                    // refreshes. A shared debounce would drop the message for all but
                    // the last-firing watcher (e.g. a git checkout changing both
                    // CLAUDE.md and AGENTS.md within 400ms). The webview's
                    // governanceFileChanged handler already gates on the currently-
                    // selected file-type and edit-mode, and constitutionFileRead has
                    // a race guard, so immediate dispatch is safe.
                    this._projectPanel?.webview.postMessage({
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
                watcher.onDidChange(refresh); watcher.onDidCreate(refresh); watcher.onDidDelete(refresh);
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
            const relativePattern = path.relative(root, insightsDir);

            try {
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(vscode.Uri.file(root), `${relativePattern}/*.md`)
                );

                const triggerRefresh = () => {
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

                watcher.onDidCreate(triggerRefresh);
                watcher.onDidChange(triggerRefresh);
                watcher.onDidDelete(triggerRefresh);

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
            this._activeDocWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath)),
                true,  // ignore create events (file already exists when watcher is set up)
                false, // watch change events
                true   // ignore delete events (handled via onDidDelete)
            );

            this._activeDocWatcher.onDidChange(() => {
                if (gen !== this._watcherGeneration) { return; } // stale watcher
                if (Date.now() - this._lastPanelWriteTimestamp < 1000) { return; } // panel-initiated write
                if (filePath !== this._activePreviewPath) { return; } // stale path

                if (this._activeDocWatchDebounce) {
                    clearTimeout(this._activeDocWatchDebounce);
                }

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

            this._activeDocWatcher.onDidDelete(() => {
                if (gen !== this._watcherGeneration) { return; }
                if (this._activeDocWatchDebounce) {
                    clearTimeout(this._activeDocWatchDebounce);
                }
                this._panel?.webview.postMessage({
                    type: 'previewError',
                    sourceId: this._activePreviewSourceId || 'local-folder',
                    requestId: -1,
                    error: 'File deleted externally'
                });
                this._activeDocWatcher?.dispose();
                this._activeDocWatcher = undefined;
            });

            this._disposables.push(this._activeDocWatcher);
        } catch (err) {
            console.error('[PlanningPanel] Failed to create active doc watcher:', err);
        }
    }

    private async _handleFetchKanbanPlanPreview(filePath: string, requestId: number): Promise<void> {
        const allRoots = Array.from(this._getAllowedRoots());
        const resolved = path.resolve(filePath);
        const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
        const targetPanel = this._projectPanel || this._panel;
        if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
            targetPanel?.webview.postMessage({
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
            const renderedHtml = await vscode.commands.executeCommand<string>('markdown.api.render', content);

            targetPanel?.webview.postMessage({
                type: 'kanbanPlanPreviewReady',
                requestId,
                filePath,
                content: renderedHtml,
                rawContent: content,
                isAutoRefreshed: this._isAutoRefreshing
            });
        } catch (err) {
            targetPanel?.webview.postMessage({
                type: 'kanbanPlanPreviewReady', requestId, filePath, content: '', error: String(err)
            });
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

        const pathParts = normalizedResolved.split(path.sep);
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
            res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
            res.end(data);
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

            this._panel?.webview.postMessage({
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
                htmlContent: isHtmlFile ? this._injectLocalCsp(fileContent) : undefined,
                isAutoRefreshed: isAutoRefreshed || undefined
            });
        } catch (err: any) {
            if (requestId === -1) return;
            this._panel?.webview.postMessage({
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

                this._panel.webview.postMessage({
                    type: 'planningHtmlDocsReady',
                    sourceId: 'planning-html-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this._panel?.webview.postMessage({
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
                        const pattern = new vscode.RelativePattern(p, '**/*');
                        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                        watcher.onDidChange(() => this._sendPlanningHtmlDocsReady());
                        watcher.onDidCreate(() => this._sendPlanningHtmlDocsReady());
                        watcher.onDidDelete(() => this._sendPlanningHtmlDocsReady());
                        this._planningHtmlFolderWatchers.push(watcher);
                    }
                }
            } catch {}
        }
    }

    private _registerSaveTextDocListener(): void {
        if (this._saveTextDocListener) return;
        this._saveTextDocListener = vscode.workspace.onDidSaveTextDocument((document) => {
            if (!this._panel?.visible) return;
            if (!this._activePlanningHtmlPreview) return;
            const changedPath = path.resolve(document.uri.fsPath);
            const active = this._activePlanningHtmlPreview;
            const relativePath = active.docId.includes(':')
                ? active.docId.substring(active.docId.indexOf(':') + 1)
                : active.docId;
            const activePath = path.resolve(active.sourceFolder, relativePath);
            if (changedPath !== activePath) return;
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
        return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
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
    private _findTicketFilePath(resolvedRoot: string, provider: string, id: string): string | null {
        const prefix = `${provider}_${id}_`;
        const baseDirs: string[] = [];
        try {
            const config = GlobalIntegrationConfigService.loadConfigSync(provider as any);
            if (config && config.ticketSaveLocation) {
                baseDirs.push(path.join(config.ticketSaveLocation, provider));
            }
        } catch { /* ignore */ }
        baseDirs.push(path.join(resolvedRoot, '.switchboard', 'tickets', provider));
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

    private async _handleMessage(msg: any, isProject: boolean = false): Promise<void> {
        const allRoots = this._getWorkspaceRoots();
        if (allRoots.length === 0) {
            const errorPanel = isProject ? this._projectPanel : this._panel;
            errorPanel?.webview.postMessage({ type: 'error', message: 'No workspace open' });
            return;
        }

        // Use active workspace root if available, otherwise use first root
        const workspaceRoot = this._getWorkspaceRoot() || allRoots[0];

        // Ensure adapters are registered before processing any message
        this._ensureAdaptersRegistered();

        switch (msg.type) {
            case 'fetchRoots': {
                console.log('[PlanningPanel] Received fetchRoots, _panel exists:', !!this._panel);
                const sources = this._researchImportService.getAvailableSources();
                console.log('[PlanningPanel] Available sources at fetchRoots:', sources);
                
                // Send workspaceItems and restoredTabState
                const items = buildWorkspaceItems(allRoots);
                const tabKeys = ['local', 'online', 'kanban', 'tickets', 'research', 'notebook', 'localDocs.root', 'onlineDocs.root', 'kanban.root', 'kanban.project', 'tickets.root', 'research.root', 'notebook.root'];
                const statePayload = this._stateStore.getAllStates(tabKeys, allRoots);
                this._panel?.webview.postMessage({
                    type: 'workspaceItemsUpdated',
                    items
                });
                this._panel?.webview.postMessage({
                    type: 'restoredTabState',
                    panel: statePayload.panel,
                    byRoot: statePayload.byRoot
                });

                const integrationWorkspaces = await this._getIntegrationWorkspaces();
                this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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

                this._panel?.webview.postMessage({
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
                        this._panel?.webview.postMessage({
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
                        this._panel?.webview.postMessage({
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

                    const result = await vscode.commands.executeCommand<ReviewCommentResult>(
                        'switchboard.sendReviewComment',
                        request
                    );

                    const normalizedResult = result && typeof result.ok === 'boolean'
                        ? result
                        : { ok: false, message: 'Review comment dispatch failed (no response).' };

                    this._panel?.webview.postMessage({ type: 'commentResult', ...normalizedResult });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this._panel?.webview.postMessage({ type: 'commentResult', ok: false, message });
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
            case 'toggleAntigravityBrain': {
                const enabled = Boolean(msg.enabled);
                await vscode.workspace.getConfiguration('switchboard').update(
                    'research.antigravityBrainEnabled',
                    enabled,
                    vscode.ConfigurationTarget.Global  // MUST be Global — user preference, not workspace
                );
                this._setupAntigravityWatcher();        // Re-setup watcher on toggle
                await this._sendLocalDocsReady();       // Refresh tree
                break;
            }
            case 'fetchAntigravityArtifact': {
                const artifactPath = msg.artifactPath;
                const requestId = msg.requestId || -1;
                const allRoots = this._getWorkspaceRoots();
                const service = this._getLocalFolderService(allRoots[0] || '');
                const result = await service.fetchAntigravityArtifact(artifactPath);
                if (result.success) {
                    this._panel?.webview.postMessage({
                        type: 'previewReady',
                        sourceId: 'antigravity',
                        requestId,
                        content: result.content || '',
                        docName: path.basename(artifactPath, '.md')
                    });
                } else {
                    this._panel?.webview.postMessage({
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
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add Docs Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addFolderPath(result[0].fsPath);
                    this._setupLocalFolderWatchers();
                    await this._sendLocalDocsReady();
                    this._panel?.webview.postMessage({ type: 'localFoldersListed', paths: service.getFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeLocalFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                await service.removeFolderPath(msg.folderPath);
                this._setupLocalFolderWatchers();
                await this._sendLocalDocsReady();
                this._panel?.webview.postMessage({ type: 'localFoldersListed', paths: service.getFolderPaths(), workspaceRoot: root });
                break;
            }
            case 'listLocalFolders': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                const paths = service.getFolderPaths();
                this._panel?.webview.postMessage({ type: 'localFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'addTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add Tickets Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addTicketsFolderPath(result[0].fsPath);
                    await this._sendLocalDocsReady(true);
                    this._panel?.webview.postMessage({ type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                await service.removeTicketsFolderPath(msg.folderPath);
                await this._sendLocalDocsReady(true);
                this._panel?.webview.postMessage({ type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                break;
            }
            case 'listTicketsFolders': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                const paths = service.getTicketsFolderPaths();
                this._panel?.webview.postMessage({ type: 'ticketsFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'saveTicketsFolderPaths': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                const config = await service.loadFolderPathsConfig();
                config.ticketsFolderPaths = msg.paths || [];
                await service.saveFolderPathsConfig(config);
                await this._sendLocalDocsReady(true);
                this._panel?.webview.postMessage({ type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                break;
            }
            case 'browseTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const result = await vscode.window.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    openLabel: 'Select Tickets Folder'
                });
                if (result && result.length > 0) {
                    this._panel?.webview.postMessage({ type: 'browseTicketsFolderResult', path: result[0].fsPath, workspaceRoot: root });
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
                this._panel?.webview.postMessage({ type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                break;
            }

            case 'listPlanningHtmlFolders': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                const paths = service.getPlanningHtmlFolderPaths();
                this._panel?.webview.postMessage({ type: 'planningHtmlFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'addPlanningHtmlFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add HTML Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addPlanningHtmlFolderPath(result[0].fsPath);
                    this._setupPlanningHtmlFolderWatchers();
                    await this._sendPlanningHtmlDocsReady();
                    this._panel?.webview.postMessage({ type: 'planningHtmlFoldersListed', paths: service.getPlanningHtmlFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removePlanningHtmlFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                const service = this._getLocalFolderService(root);
                await service.removePlanningHtmlFolderPath(msg.folderPath);
                this._setupPlanningHtmlFolderWatchers();
                await this._sendPlanningHtmlDocsReady();
                this._panel?.webview.postMessage({ type: 'planningHtmlFoldersListed', paths: service.getPlanningHtmlFolderPaths(), workspaceRoot: root });
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
                    await vscode.env.openExternal(vscode.Uri.parse(url));
                } catch (err: any) {
                    vscode.window.showErrorMessage('Failed to serve HTML file: ' + err.message);
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
                    this._panel?.webview.postMessage({ type: 'containersReady', sourceId, containers: [] });
                    break;
                }
                try {
                    const containers = await adapter.listContainers();
                    this._panel?.webview.postMessage({ type: 'containersReady', sourceId, containers });
                } catch {
                    this._panel?.webview.postMessage({ type: 'containersReady', sourceId, containers: [] });
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
                    this._panel?.webview.postMessage({ type: 'filteredDocsReady', sourceId, nodes: [], requestId });
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
                    this._panel?.webview.postMessage({ type: 'filteredDocsReady', sourceId, nodes, requestId });
                } catch {
                    if (requestId === this._latestRequestIds.get(filterKey)) {
                        this._panel?.webview.postMessage({ type: 'filteredDocsReady', sourceId, nodes: [], requestId });
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
                    this._panel?.webview.postMessage({ type: 'docPagesReady', sourceId, docId, pages: [], requestId });
                    break;
                }

                try {
                    const pages = await adapter.listDocPages(docId);
                    // Drop if stale
                    if (requestId !== this._latestRequestIds.get(pagesKey)) { break; }
                    this._panel?.webview.postMessage({ type: 'docPagesReady', sourceId, docId, pages, requestId });
                } catch {
                    if (requestId === this._latestRequestIds.get(pagesKey)) {
                        this._panel?.webview.postMessage({ type: 'docPagesReady', sourceId, docId, pages: [], requestId });
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
                    this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'Adapter does not support page content' });
                    break;
                }

                try {
                    const result = await adapter.fetchPageContent(docId, pageId);
                    if (requestId !== this._latestRequestIds.get(sourceId)) { break; }
                    if (result.success) {
                        this._panel?.webview.postMessage({ type: 'previewReady', sourceId, requestId, content: result.content, docName: result.docName });
                    } else {
                        this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: result.error });
                    }
                } catch (err) {
                    if (requestId === this._latestRequestIds.get(sourceId)) {
                        this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: String(err) });
                    }
                }
                break;
            }
            case 'importPlansFromClipboard': {
                await this._handleImportPlansFromClipboard(workspaceRoot);
                break;
            }
            case 'importNotebookLMPlans': {
                const targetRoot = msg.workspaceRoot && allRoots.includes(msg.workspaceRoot) ? msg.workspaceRoot : workspaceRoot;
                const result = await vscode.commands.executeCommand('switchboard.importNotebookLMPlans', targetRoot) as { overwritten: number; created: number; errors: number } | undefined;
                this._panel?.webview.postMessage({ type: 'importNotebookLMPlansResult', overwritten: result?.overwritten ?? 0, created: result?.created ?? 0, errors: result?.errors ?? 0 });
                break;
            }
            case 'importResearchDoc': {
                const targetRoot = msg.workspaceRoot && allRoots.includes(msg.workspaceRoot) ? msg.workspaceRoot : workspaceRoot;
                await this._handleImportResearchDoc(targetRoot, msg.docTitle, msg.folderPath);
                break;
            }
            case 'airlock_export': {
                const targetRoot = msg.workspaceRoot && allRoots.includes(msg.workspaceRoot) ? msg.workspaceRoot : workspaceRoot;
                const result = await this._handleAirlockExport(targetRoot);
                this._panel?.webview.postMessage({ type: 'airlock_exportComplete', ...result });
                break;
            }
            case 'airlock_openNotebookLM': {
                await vscode.env.openExternal(vscode.Uri.parse('https://notebooklm.google.com'));
                break;
            }
            case 'airlock_openAIStudio': {
                await vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com'));
                break;
            }
            case 'airlock_openFolder': {
                const targetRoot = msg.workspaceRoot && allRoots.includes(msg.workspaceRoot) ? msg.workspaceRoot : workspaceRoot;
                const folderUri = vscode.Uri.file(path.join(targetRoot, '.switchboard', 'NotebookLM'));
                await vscode.commands.executeCommand('revealFileInOS', folderUri);
                break;
            }
            case 'disableDesignDoc': {
                await this._handleDisableDesignDoc();
                break;
            }
            case 'setActivePlanningContext': {
                await this._handleSetActivePlanningContext(workspaceRoot, msg.sourceId, msg.docId, msg.docName, msg.sourceFolder);
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
                await this._handleCreateLocalDoc(workspaceRoot, msg.folderPath);
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'localDocDeleted',
                        docId,
                        success: true
                    });
                } else {
                    this._panel?.webview.postMessage({
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
                        this._panel?.webview.postMessage({
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
                        this._panel?.webview.postMessage({
                            type: 'saveOnlineDocFileResult',
                            success: false,
                            error: 'Path access not allowed'
                        });
                        break;
                    }

                    this._lastPanelWriteTimestamp = Date.now();
                    await fs.promises.writeFile(resolved, content, 'utf8');

                    this._panel?.webview.postMessage({
                        type: 'saveOnlineDocFileResult',
                        success: true
                    });
                } catch (err) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'importedDocDeleted',
                        slugPrefix,
                        success: true
                    });
                } catch (err) {
                    this._panel?.webview.postMessage({
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
                await vscode.commands.executeCommand('switchboard.importUnclaimedPlans');
                break;
            }
            case 'copyChatPrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || undefined;
                const prompt = await vscode.commands.executeCommand<string | undefined>('switchboard.copyChatPrompt', workspaceRoot);
                if (prompt) {
                    const targetPanel = isProject ? this._projectPanel : this._panel;
                    targetPanel?.webview.postMessage({ type: 'chatPromptCopied' });
                }
                break;
            }
            case 'uploadPlanAttachment': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { planFile, topic } = msg;
                if (!workspaceRoot || !planFile) {
                    this._panel?.webview.postMessage({
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
                        this._panel?.webview.postMessage({
                            type: 'uploadPlanAttachmentResult',
                            success: false,
                            error: 'Plan not found in kanban database.',
                            planFile
                        });
                        break;
                    }
                    if (!plan.clickupTaskId && !plan.linearIssueId) {
                        this._panel?.webview.postMessage({
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
                        this._panel?.webview.postMessage({
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
                        this._panel?.webview.postMessage({
                            type: 'uploadPlanAttachmentResult',
                            success: true,
                            url: result?.url || '',
                            provider: 'clickup',
                            planFile
                        });
                    } else if (linearIssueId) {
                        const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        const result = await linear.uploadAttachment(linearIssueId, buffer, fileName);
                        this._panel?.webview.postMessage({
                            type: 'uploadPlanAttachmentResult',
                            success: true,
                            url: result?.url || '',
                            provider: 'linear',
                            planFile
                        });
                    }
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    this._panel?.webview.postMessage({
                        type: 'uploadPlanAttachmentResult',
                        success: false,
                        error: errMsg,
                        planFile
                    });
                }
                break;
            }
            case 'createPlan': {
                await vscode.commands.executeCommand('switchboard.initiatePlan');
                break;
            }
            case 'fetchKanbanPlans': {
                const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
                const guardKey = 'kanban-plans';
                if (requestId <= (this._latestRequestIds.get(guardKey) || 0)) { break; }
                this._latestRequestIds.set(guardKey, requestId);
                try {
                    const allRoots = Array.from(this._getAllowedRoots());
                    const allPlans: any[] = [];
                    const seenIds = new Set<string>();
                    const allWorkspaceProjects: Record<string, string[]> = {};
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
                            allWorkspaceProjects[resolvedRoot] = projects;
                            if (effectiveRoot !== resolvedRoot) {
                                // Merge into the parent entry (or create it)
                                const existing = allWorkspaceProjects[effectiveRoot] || [];
                                allWorkspaceProjects[effectiveRoot] = [...new Set([...existing, ...projects])];
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
                    // Compute orchestrator availability before the guard check so a newer
                    // request arriving during the await doesn't get a stale message.
                    const orchestratorAvailable = this._kanbanProvider
                        ? await this._kanbanProvider.isOrchestratorAvailable()
                        : false;
                    if (requestId !== this._latestRequestIds.get(guardKey)) { break; }
                    allPlans.sort((a, b) => b.mtime - a.mtime);
                    mergedColumns.sort((a, b) => a.order - b.order);
                    this._projectPanel?.webview.postMessage({
                        type: 'kanbanPlansReady',
                        plans: allPlans,
                        workspaceItems,
                        allWorkspaceProjects,
                        columns: mergedColumns,
                        kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
                        requestId,
                        orchestratorAvailable
                    });
                } catch (err) {
                    if (requestId === this._latestRequestIds.get(guardKey)) {
                        this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: [], columns: [], requestId, error: String(err), orchestratorAvailable: false });
                    }
                }
                break;
            }
            case 'openKanbanPlan': {
                const filePath: string = msg.filePath || '';
                const resolved = path.resolve(filePath);
                const isAllowed = Array.from(this._getAllowedRoots()).some(r => resolved.startsWith(path.resolve(r)));
                if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanOpenResult', success: false, error: 'File not found or not in workspace' });
                    break;
                }
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanOpenResult', success: true });
                } catch (err) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanOpenResult', success: false, error: String(err) });
                }
                break;
            }
            case 'fetchKanbanPlanPreview': {
                const filePath: string = msg.filePath || '';
                const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
                await this._handleFetchKanbanPlanPreview(filePath, requestId);
                break;
            }
            case 'setKanbanPlanContext': {
                const filePath: string = msg.filePath || '';
                const resolved = path.resolve(filePath);
                const isAllowed = Array.from(this._getAllowedRoots()).some(r => resolved.startsWith(path.resolve(r)));
                if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanContextSet', success: false, error: 'File not found or not in workspace' });
                    break;
                }
                try {
                    await vscode.workspace.getConfiguration('switchboard').update(
                        'planner.designDocLink', filePath, vscode.ConfigurationTarget.Workspace
                    );
                    await vscode.workspace.getConfiguration('switchboard').update(
                        'planner.designDocEnabled', true, vscode.ConfigurationTarget.Workspace
                    );
                    await this._sendActiveDesignDocState();
                    this._projectPanel?.webview.postMessage({ type: 'kanbanContextSet', success: true });
                } catch (err) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanContextSet', success: false, error: String(err) });
                }
                break;
            }
            case 'copyKanbanPlanPrompt': {
                const sessionId = String(msg.sessionId || '');
                const column = String(msg.column || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!sessionId) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId' });
                    break;
                }
                try {
                    const success = await vscode.commands.executeCommand<boolean>(
                        'switchboard.copyPlanFromKanban', sessionId, column, wsRoot
                    );
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: !!success, sessionId });
                } catch (err) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
                }
                break;
            }
            case 'copyEpicPlannerPrompt': {
                const sessionId = String(msg.sessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!sessionId || !this._kanbanProvider) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId or kanban provider' });
                    break;
                }
                try {
                    const assembled = await this._kanbanProvider.buildEpicOrchestrationPrompt(wsRoot, sessionId, 'planner');
                    if (!assembled) {
                        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: 'Could not resolve this epic.' });
                        break;
                    }
                    await vscode.env.clipboard.writeText(assembled.prompt);
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: true, sessionId });
                } catch (err) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
                }
                break;
            }
            case 'moveKanbanPlanColumn': {
                const planFile = String(msg.planFile || '');
                const newColumn = String(msg.newColumn || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!planFile || !newColumn) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanColumnChanged', success: false, error: 'Missing planFile or newColumn' });
                    break;
                }
                try {
                    const moved = await vscode.commands.executeCommand<boolean>(
                        'switchboard.moveKanbanCardByPlanFile', wsRoot, planFile, newColumn
                    );
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanColumnChanged', success: !!moved, error: moved ? undefined : 'Column update failed' });
                } catch (err) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanColumnChanged', success: false, error: String(err) });
                }
                break;
            }
            case 'planShown': {
                const sessionId = String(msg.sessionId || '');
                if (sessionId) {
                    await vscode.commands.executeCommand('switchboard.selectSession', sessionId);
                }
                break;
            }
            case 'setKanbanPlanComplexity': {
                const planId = String(msg.planId || '');
                const complexity = String(msg.complexity || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!planId) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanComplexityChanged', success: false, error: 'Missing planId' });
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
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, requestId: Date.now() });
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanComplexityChanged', success: true });
                } catch (err) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanComplexityChanged', success: false, error: String(err) });
                }
                break;
            }
            case 'deleteKanbanPlan': {
                const planId = String(msg.planId || '');
                const planFile = String(msg.planFile || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!planId || !wsRoot) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanDeleted', success: false, error: 'Missing planId or workspaceRoot' });
                    break;
                }
                if (planFile) {
                    const resolvedPlanFile = path.isAbsolute(planFile)
                        ? planFile
                        : path.resolve(wsRoot, planFile);
                    const resolvedRoot = path.resolve(wsRoot);
                    const rel = path.relative(resolvedRoot, resolvedPlanFile);
                    if (rel.startsWith('..') || path.isAbsolute(rel)) {
                        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanDeleted', success: false, error: 'Plan file is outside workspace root' });
                        break;
                    }
                }
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
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
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanDeleted', success: true, planId });
                } catch (err) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanDeleted', success: false, error: String(err) });
                }
                break;
            }
            case 'fetchKanbanPlanLog': {
                const sessionId = String(msg.sessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!sessionId || !wsRoot) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanLogReady', entries: [], error: 'Missing sessionId or workspaceRoot' });
                    break;
                }
                try {
                    const { SessionActionLog } = require('./SessionActionLog');
                    const log = new SessionActionLog(wsRoot);
                    const sheet = await log.getRunSheet(sessionId);
                    const events: any[] = Array.isArray(sheet?.events) ? sheet.events : [];
                    const entries = formatReviewLogEntries(events);
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanLogReady', entries });
                } catch (err) {
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlanLogReady', entries: [], error: String(err) });
                }
                break;
            }
            case 'getEpicDetails': {
                const sessionId = String(msg.sessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!sessionId || !wsRoot) {
                    this._projectPanel?.webview.postMessage({ type: 'epicDetails', epic: null, subtasks: [] });
                    break;
                }
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    const epic = await db.getPlanByPlanId(sessionId);
                    const subtasks = epic && epic.isEpic ? await db.getSubtasksByEpicId(epic.planId) : [];
                    this._projectPanel?.webview.postMessage({ type: 'epicDetails', epic, subtasks });
                } catch (err) {
                    this._projectPanel?.webview.postMessage({ type: 'epicDetails', epic: null, subtasks: [], error: String(err) });
                }
                break;
            }
            case 'addSubtaskToEpic': {
                const epicSessionId = String(msg.epicSessionId || '');
                const subtaskSessionId = String(msg.subtaskSessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!epicSessionId || !subtaskSessionId || !wsRoot) break;
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    const epic = await db.getPlanByPlanId(epicSessionId);
                    if (!epic || !epic.isEpic) break;
                    // Lock-column validation
                    const lockColumnsRaw = await db.getConfig('epic_lock_columns');
                    const lockColumns = (lockColumnsRaw || 'IN PROGRESS,CODE REVIEW,REVIEWED,DONE').split(',').map((c: string) => c.trim());
                    if (lockColumns.includes(epic.kanbanColumn)) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: 'Cannot modify subtasks of an epic in a locked column.' });
                        break;
                    }
                    const subtask = await db.getPlanByPlanId(subtaskSessionId);
                    if (!subtask) break;
                    if (subtask.isEpic) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: 'Cannot add an epic as a subtask.' });
                        break;
                    }
                    if (subtask.epicId && subtask.epicId !== epic.planId) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: 'Subtask already belongs to another epic.' });
                        break;
                    }
                    await db.updateEpicStatus(subtask.planId, 0, epic.planId);
                    const allPlans = await this._getKanbanPlans(wsRoot);
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, requestId: Date.now() });
                } catch (err) {
                    console.error('[PlanningPanelProvider] addSubtaskToEpic failed:', err);
                }
                break;
            }
            case 'removeSubtaskFromEpic': {
                const subtaskSessionId = String(msg.subtaskSessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!subtaskSessionId || !wsRoot) break;
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    const subtask = await db.getPlanByPlanId(subtaskSessionId);
                    if (!subtask) break;
                    await db.updateEpicStatus(subtask.planId, 0, '');
                    const allPlans = await this._getKanbanPlans(wsRoot);
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, requestId: Date.now() });
                } catch (err) {
                    console.error('[PlanningPanelProvider] removeSubtaskFromEpic failed:', err);
                }
                break;
            }
            case 'deleteEpic': {
                const sessionId = String(msg.sessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                const deleteSubtasks = !!msg.deleteSubtasks;
                if (!sessionId || !wsRoot) break;
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    const epic = await db.getPlanByPlanId(sessionId);
                    if (!epic || !epic.isEpic) break;
                    if (deleteSubtasks) {
                        const subtasks = await db.getSubtasksByEpicId(epic.planId);
                        for (const st of subtasks) {
                            await db.tombstonePlan(st.planId);
                        }
                    } else {
                        await db.clearEpicIdForEpic(epic.planId);
                    }
                    await db.tombstonePlan(epic.planId);
                    const allPlans = await this._getKanbanPlans(wsRoot);
                    this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, requestId: Date.now() });
                } catch (err) {
                    console.error('[PlanningPanelProvider] deleteEpic failed:', err);
                }
                break;
            }
            case 'orchestrateEpic': {
                // Assemble the orchestrator prompt for one epic and either copy it (default,
                // Decision #6) or also dispatch it to the orchestrator terminal. Copy always
                // happens so the action works even when no orchestrator terminal exists.
                const sessionId = String(msg.sessionId || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                const mode = msg.mode === 'send' ? 'send' : (msg.mode === 'preview' ? 'preview' : 'copy');
                if (!sessionId || !wsRoot || !this._kanbanProvider) {
                    this._projectPanel?.webview.postMessage({ type: 'epicOrchestrationResult', ok: false, mode, error: 'Orchestration is unavailable in this window.' });
                    break;
                }
                try {
                    if (mode === 'send') {
                        const { assembled, sent } = await this._kanbanProvider.dispatchEpicOrchestration(wsRoot, sessionId);
                        if (!assembled) {
                            this._projectPanel?.webview.postMessage({ type: 'epicOrchestrationResult', ok: false, mode, error: 'Could not resolve this epic.' });
                            break;
                        }
                        await vscode.env.clipboard.writeText(assembled.prompt);
                        this._projectPanel?.webview.postMessage({ type: 'epicOrchestrationResult', ok: true, mode, sent, prompt: assembled.prompt, epicTopic: assembled.epicTopic, subtaskCount: assembled.subtaskCount, totalSubtasks: assembled.totalSubtasks });
                    } else {
                        const assembled = await this._kanbanProvider.buildEpicOrchestrationPrompt(wsRoot, sessionId);
                        if (!assembled) {
                            this._projectPanel?.webview.postMessage({ type: 'epicOrchestrationResult', ok: false, mode, error: 'Could not resolve this epic.' });
                            break;
                        }
                        if (mode === 'copy') {
                            await vscode.env.clipboard.writeText(assembled.prompt);
                            await this._kanbanProvider.markEpicOrchestrating(wsRoot, sessionId);
                        }
                        this._projectPanel?.webview.postMessage({ type: 'epicOrchestrationResult', ok: true, mode, prompt: assembled.prompt, epicTopic: assembled.epicTopic, subtaskCount: assembled.subtaskCount, totalSubtasks: assembled.totalSubtasks });
                    }
                } catch (err) {
                    console.error('[PlanningPanelProvider] orchestrateEpic failed:', err);
                    this._projectPanel?.webview.postMessage({ type: 'epicOrchestrationResult', ok: false, mode, error: String(err) });
                }
                break;
            }
            case 'fetchEpicDocuments': {
                try {
                    const allRoots = Array.from(this._getAllowedRoots());
                    const workspaceItems = this._buildKanbanWorkspaceItems();
                    const documents: any[] = [];
                    for (const root of allRoots) {
                        const epicDir = path.join(root, '.switchboard', 'epics');
                        let files: string[] = [];
                        try { files = await fs.promises.readdir(epicDir); } catch { /* dir doesn't exist */ }
                        for (const file of files) {
                            if (!file.endsWith('.md')) continue;
                            const fullPath = path.join(epicDir, file);
                            try {
                                const stat = await fs.promises.stat(fullPath);
                                const content = await fs.promises.readFile(fullPath, 'utf8');
                                // Extract title from first H1 or frontmatter description, fallback to filename
                                let title = file.replace(/\.md$/, '');
                                const h1Match = content.match(/^#\s+(.+)$/m);
                                if (h1Match) { title = h1Match[1].trim(); }
                                else {
                                    const descMatch = content.match(/^description:\s*'(.+)'/m);
                                    if (descMatch) { title = descMatch[1].trim(); }
                                }
                                const effectiveRoot = this._resolveEffectiveWorkspaceRoot(root);
                                const wsLabel = workspaceItems.find(
                                    item => item.workspaceRoot === effectiveRoot
                                )?.label || path.basename(effectiveRoot);
                                documents.push({
                                    planId: `epic-doc:${fullPath}`,
                                    topic: title,
                                    planFile: fullPath,
                                    workspaceRoot: effectiveRoot,
                                    workspaceLabel: wsLabel,
                                    mtime: stat.mtime.getTime(),
                                    isEpic: true,
                                    isEpicDocument: true,
                                    subtaskCount: 0
                                });
                            } catch { /* skip unreadable files */ }
                        }
                    }
                    documents.sort((a, b) => b.mtime - a.mtime);
                    this._projectPanel?.webview.postMessage({ type: 'epicDocumentsReady', documents });
                } catch (err) {
                    console.error('[PlanningPanelProvider] fetchEpicDocuments failed:', err);
                    this._projectPanel?.webview.postMessage({ type: 'epicDocumentsReady', documents: [] });
                }
                break;
            }
            case 'createEpic': {
                try {
                    const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (!wsRoot) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: 'No workspace root resolved.' });
                        break;
                    }
                    const name = String(msg.name || '').trim();
                    if (!name) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: 'Epic name is required.' });
                        break;
                    }
                    const addToKanbanBoard = msg.addToKanbanBoard !== false;
                    const description = msg.description ? String(msg.description).trim() : '';
                    const yamlSafeName = name.replace(/'/g, "''");
                    const yamlSafeDesc = description.replace(/'/g, "''");
                    const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${name}\n\n${description}`;

                    // Add to kanban board: create a DB plan record + file in epics/
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    const workspaceId = await db.getWorkspaceId();
                    if (!workspaceId) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: 'Workspace ID not found. Cannot create epic.' });
                        break;
                    }
                    const planId = crypto.randomUUID();
                    const sessionId = crypto.randomUUID();

                    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'epic';
                    let uniqueSlug = slug;
                    const epicDir = path.join(wsRoot, '.switchboard', 'epics');
                    await fs.promises.mkdir(epicDir, { recursive: true });
                    if (fs.existsSync(path.join(epicDir, `${slug}.md`))) {
                        uniqueSlug = `${slug}-${planId.slice(0, 8)}`;
                    }
                    const epicPlanFile = path.join('.switchboard', 'epics', `${uniqueSlug}.md`);
                    const epicPath = path.join(wsRoot, epicPlanFile);

                    const now = new Date().toISOString();
                    const upsertOk = await db.upsertPlan({
                        planId,
                        sessionId,
                        topic: name,
                        planFile: epicPlanFile,
                        kanbanColumn: 'CREATED',
                        status: 'active',
                        complexity: 'Unknown',
                        tags: '',
                        repoScope: '',
                        workspaceId,
                        createdAt: now,
                        updatedAt: now,
                        lastAction: '',
                        sourceType: 'local',
                        brainSourcePath: '',
                        mirrorPath: '',
                        routedTo: '',
                        dispatchedAgent: '',
                        dispatchedIde: '',
                        isEpic: 1,
                        epicId: ''
                    });

                    if (!upsertOk) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: 'Failed to create epic: DB upsert failed.' });
                        break;
                    }

                    await db.updateEpicStatus(planId, 1, '');
                    GlobalPlanWatcherService.registerPendingCreation(epicPath);
                    await fs.promises.writeFile(epicPath, epicContent, 'utf8');
                    // Trigger a full fetchKanbanPlans so the webview receives a complete
                    // kanbanPlansReady message (with workspaceItems, columns, etc.).
                    this._handleMessage({
                        type: 'fetchKanbanPlans',
                        requestId: Date.now()
                    }, true).catch(err => {
                        console.error('[PlanningPanelProvider] createEpic post-fetch failed:', err);
                    });
                } catch (err) {
                    console.error('[PlanningPanelProvider] createEpic failed:', err);
                    this._projectPanel?.webview.postMessage({ type: 'epicError', message: String(err) });
                }
                break;
            }
            case 'updateEpicConfig': {
                // epic_prompt_template is superseded by the orchestrator role prompt override
                // (Decision #3/#4); writes removed to avoid dual-source conflict.
                // epic_lock_columns is dormant; writes removed.
                // epic_max_subtasks still bounds epic expansion and has no addon replacement
                // yet, so its write is kept. Legacy keys are still READ as fallback (per CLAUDE.md).
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!wsRoot) break;
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    if (msg.epicMaxSubtasks !== undefined) await db.setConfig('epic_max_subtasks', String(msg.epicMaxSubtasks));
                } catch (err) {
                    console.error('[PlanningPanelProvider] updateEpicConfig failed:', err);
                }
                break;
            }
            case 'loadConstitutionFiles': {
                const workspaceItems = buildWorkspaceItems(allRoots);
                const workspaces = workspaceItems.map(ws => {
                    const governance = (['constitution', 'claude', 'agents'] as const).map(key => ({
                        key,
                        exists: fs.existsSync(this._getGovernanceFilePath(ws.workspaceRoot, key)),
                    }));
                    return {
                        label: ws.label,
                        workspaceRoot: ws.workspaceRoot,
                        governance,
                        hasConstitution: governance[0].exists /* keep legacy field */
                    };
                });
                this._projectPanel?.webview.postMessage({
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
                const cfgDefault = vscode.workspace.getConfiguration('switchboard').get<boolean>('planner.constitutionEnabled', false);
                const enabled = plannerConfig?.addons?.constitution ?? cfgDefault;
                let status = 'None';
                if (enabled && exists) { status = path.basename(filePath); }
                else if (enabled) { status = 'File not found'; }
                else { status = 'Disabled'; }
                this._projectPanel?.webview.postMessage({ type: 'constitutionStatus', status, planFile: msg.planFile, enabled, workspaceRoot: wr });
                break;
            }
            case 'readConstitutionFile': {
                const wsRoot = msg.workspaceRoot;
                const key = msg.governanceFile ?? 'constitution';
                if (!allRoots.includes(wsRoot)) {
                    this._projectPanel?.webview.postMessage({
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
                        const renderedHtml = await vscode.commands.executeCommand<string>('markdown.api.render', content);
                        this._projectPanel?.webview.postMessage({
                            type: 'constitutionFileRead',
                            workspaceRoot: wsRoot,
                            governanceFile: key,
                            filePath,
                            exists: true,
                            content,
                            renderedHtml
                        });
                    } catch (err) {
                        this._projectPanel?.webview.postMessage({
                            type: 'constitutionFileRead',
                            workspaceRoot: wsRoot,
                            governanceFile: key,
                            exists: false,
                            error: String(err)
                        });
                    }
                } else {
                    this._projectPanel?.webview.postMessage({
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
                if (!allRoots.includes(wsRoot)) {
                    this._projectPanel?.webview.postMessage({
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
                    fs.writeFileSync(filePath, content, 'utf8');
                    this._projectPanel?.webview.postMessage({
                        type: 'fileSaved',
                        success: true,
                        tab: 'constitution',
                        governanceFile: key
                    });
                    await this._handleMessage({ type: 'loadConstitutionFiles', requestId: Date.now() }, true);
                } catch (err) {
                    this._projectPanel?.webview.postMessage({
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
                this._projectPanel?.webview.postMessage({ type: 'projectContextEnabled', enabled, workspaceRoot: wsRoot });
                break;
            }
            case 'setProjectContextEnabled': {
                // Per-project PRD master toggle (per-workspace). KanbanProvider's dispatch path
                // reads this same config, so a write here governs whether the active project's
                // PRD is injected into future dispatched prompts. Confirm state back to the webview.
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (wsRoot) {
                    await this._kanbanProvider?.setProjectContextEnabled(wsRoot, !!msg.enabled);
                }
                this._projectPanel?.webview.postMessage({ type: 'projectContextEnabled', enabled: !!msg.enabled, workspaceRoot: wsRoot });
                break;
            }
            case 'getProjectPrd': {
                // Read a project's PRD file for the Projects-tab editor.
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (wsRoot && typeof msg.projectName === 'string') {
                    const filePath = getProjectPrdPath(wsRoot, msg.projectName);
                    let content = '';
                    let exists = false;
                    try {
                        if (fs.existsSync(filePath)) {
                            content = await fs.promises.readFile(filePath, 'utf8');
                            exists = true;
                        }
                    } catch { /* non-fatal */ }
                    this._projectPanel?.webview.postMessage({
                        type: 'projectPrdContent',
                        projectName: msg.projectName,
                        workspaceRoot: wsRoot,
                        content,
                        exists,
                        path: filePath
                    });
                }
                break;
            }
            case 'saveProjectPrd': {
                // Write a project's PRD file (creating .switchboard/projects/<slug>/).
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (wsRoot && typeof msg.projectName === 'string' && typeof msg.content === 'string') {
                    const filePath = getProjectPrdPath(wsRoot, msg.projectName);
                    let ok = false;
                    try {
                        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
                        await fs.promises.writeFile(filePath, msg.content, 'utf8');
                        ok = true;
                    } catch (err) {
                        console.error('[PlanningPanelProvider] Failed to save project PRD:', err);
                    }
                    this._projectPanel?.webview.postMessage({
                        type: 'projectPrdSaved',
                        projectName: msg.projectName,
                        ok,
                        path: filePath
                    });
                }
                break;
            }
            case 'toggleConstitutionAddon': {
                const store = this._context.globalState;
                const plannerConfig = store.get<any>('switchboard.prompts.roleConfig_planner', {}) || {};
                plannerConfig.addons = plannerConfig.addons || {};
                plannerConfig.addons.constitution = !!msg.enabled;
                await store.update('switchboard.prompts.roleConfig_planner', plannerConfig);
                this._projectPanel?.webview.postMessage({ type: 'constitutionAddonState', enabled: !!msg.enabled });
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
                await vscode.env.clipboard.writeText(promptText);
                this._projectPanel?.webview.postMessage({ type: 'constitutionPromptCopied' });
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
                await vscode.env.clipboard.writeText(promptText);
                this._projectPanel?.webview.postMessage({ type: 'constitutionPromptCopied' }); // reuse copied notification
                break;
            }
            case 'invokeConstitutionBuilder': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) {
                    break;
                }
                const promptText = `Follow instructions in .agents/skills/constitution_builder.md to build or improve CONSTITUTION.md in this project.`;
                // Try dispatching via the planner role (gets rotation for free).
                // Fall back to ad-hoc terminal creation if no planner agent is registered.
                if (this._taskViewerProvider) {
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
                    if (dispatched) { break; }
                }
                const terminal = vscode.window.terminals.find(t => t.name.toLowerCase().includes('planner') || t.name.toLowerCase().includes('lead'))
                    || vscode.window.createTerminal({ name: 'Constitution Builder', cwd: wsRoot });
                terminal.show();
                const { sendRobustText } = require('./terminalUtils');
                await sendRobustText(terminal, promptText);
                break;
            }
            case 'invokeConstitutionUpdater': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) {
                    break;
                }
                const promptText = `Follow instructions in .agents/skills/constitution_builder.md to improve and update the existing CONSTITUTION.md in this project.`;
                if (this._taskViewerProvider) {
                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
                    if (dispatched) { break; }
                }
                const terminal = vscode.window.terminals.find(t => t.name.toLowerCase().includes('planner') || t.name.toLowerCase().includes('lead'))
                    || vscode.window.createTerminal({ name: 'Constitution Builder', cwd: wsRoot });
                terminal.show();
                const { sendRobustText } = require('./terminalUtils');
                await sendRobustText(terminal, promptText);
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
                const terminal = vscode.window.terminals.find(t =>
                        t.name.toLowerCase().includes('planner') || t.name.toLowerCase().includes('lead'))
                    || vscode.window.createTerminal({ name: 'System Builder', cwd: wsRoot });
                terminal.show();
                const { sendRobustText } = require('./terminalUtils');
                await sendRobustText(terminal, promptText);
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
                await vscode.env.clipboard.writeText(promptText);
                this._projectPanel?.webview.postMessage({ type: 'systemPromptCopied' });
                break;
            }
            case 'deleteConstitutionFile': {
                const wsRoot = msg.workspaceRoot;
                const key = msg.governanceFile ?? 'constitution';
                if (!allRoots.includes(wsRoot)) { break; }
                const filePath = this._getGovernanceFilePath(wsRoot, key);
                try {
                    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
                    this._projectPanel?.webview.postMessage({ type: 'constitutionFileDeleted', workspaceRoot: wsRoot, governanceFile: key });
                    await this._handleMessage({ type: 'loadConstitutionFiles', requestId: Date.now() }, true);
                } catch (err) {
                    this._projectPanel?.webview.postMessage({ type: 'constitutionFileDeleted', workspaceRoot: wsRoot, governanceFile: key, success: false, error: String(err) });
                }
                break;
            }
            case 'getConstitutionPaths': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) { break; }
                this._projectPanel?.webview.postMessage({
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
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                    defaultUri: vscode.Uri.file(wsRoot),
                    filters: { Markdown: ['md'] },
                    openLabel: 'Use as Constitution',
                });
                if (!picked || picked.length === 0) { break; }
                const abs = picked[0].fsPath;
                const rel = path.relative(wsRoot, abs);
                if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.endsWith('.md')) {
                    vscode.window.showErrorMessage('Constitution file must be a .md file inside the workspace root.');
                    break;
                }
                const list = this._getConstitutionPathList(wsRoot);
                if (!list.includes(rel)) { list.push(rel); }
                await this._setConstitutionPathList(wsRoot, list);
                // Activate the newly added path (routes through existing validated handler + watcher refresh).
                await this._handleMessage({ type: 'setConstitutionPath', workspaceRoot: wsRoot, relativePath: rel }, true);
                this._projectPanel?.webview.postMessage({
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
                this._projectPanel?.webview.postMessage({
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
                    vscode.window.showErrorMessage('Invalid constitution path. Must be relative, end in .md, and remain inside the workspace root.');
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
                this._projectPanel?.webview.postMessage({
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
                const saveDestPanel = (tab === 'kanban' || tab === 'constitution' || tab === 'epics') ? this._projectPanel : this._panel;
                let resolved: string;
                if (!path.isAbsolute(filePath)) {
                    const wsRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);
                    if (wsRoot) {
                        resolved = path.resolve(wsRoot, filePath);
                    } else {
                        saveDestPanel?.webview.postMessage({ type: 'saveFileContentResult', success: false, error: 'No workspace root to resolve relative path', tab });
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
                    saveDestPanel?.webview.postMessage({ type: 'saveFileContentResult', success: false, error: 'Invalid file path', tab });
                    break;
                }
                try {
                    // Conflict detection: compare disk content with original
                    let diskContent = '';
                    if (fs.existsSync(resolved)) {
                        diskContent = await fs.promises.readFile(resolved, 'utf8');
                    }
                    if (originalContent && diskContent !== originalContent) {
                        saveDestPanel?.webview.postMessage({ type: 'saveFileContentResult', success: false, conflict: true, diskContent, tab });
                        break;
                    }

                    // Validate JSON/YAML before write
                    const saveExt = path.extname(resolved).toLowerCase();
                    if (saveExt === '.json') {
                        try { JSON.parse(content); }
                        catch (e: any) {
                            saveDestPanel?.webview.postMessage({
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
                            saveDestPanel?.webview.postMessage({
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
                    if (tab === 'kanban' || tab === 'epics') {
                        try {
                            const currentBasename = path.basename(resolved);
                            // Only auto-rename files that follow the feature_plan_<YYYYMMDD>_<HHMMSS>_<slug>.md
                            // convention. Epic files use hyphen slugs (.switchboard/epics/<slug>.md) and legacy
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

                    saveDestPanel?.webview.postMessage({
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
                    saveDestPanel?.webview.postMessage({ type: 'saveFileContentResult', success: false, error: String(err), tab });
                }
                break;
            }
            case 'linearLoadProject': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'linearProjectLoaded',
                        status: 'loaded',
                        issues,
                        projectName,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'linearProjectsLoaded',
                        status: 'loaded',
                        projects,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                        this._panel?.webview.postMessage({
                            type: 'linearError',
                            scope: 'task',
                            issueId,
                            error: `Linear issue ${issueId} was not found.`,
                            workspaceRoot
                        });
                        break;
                    }

                    let renderedDescriptionHtml = '';
                    const descriptionMd = (issue.description || '').trim() || 'No description provided.';
                    try {
                        renderedDescriptionHtml = await vscode.commands.executeCommand<string>('markdown.api.render', descriptionMd) || '';
                    } catch {
                        renderedDescriptionHtml = '';
                    }

                    this._panel?.webview.postMessage({
                        type: 'linearTaskDetailsLoaded',
                        issue,
                        subtasks,
                        comments,
                        attachments,
                        renderedDescriptionHtml,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: error instanceof Error ? error.message : String(error),
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'clickupSpacesLoaded',
                        spaces,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'clickupFoldersLoaded',
                        spaceId: msg.spaceId,
                        folders,
                        directLists: await clickUp.getLists(msg.spaceId),
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'clickupListsLoaded',
                        spaceId: msg.spaceId,
                        folderId: msg.folderId,
                        lists,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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

                    this._panel?.webview.postMessage({
                        type: 'clickupProjectLoaded',
                        status: 'loaded',
                        tasks: tasks.map((t: any) => this._mapClickUpTaskToSidebar(t)),
                        listName: config.selectedListName || 'Unknown List',
                        loadSeq,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                        renderedDescriptionHtml = await vscode.commands.executeCommand<string>('markdown.api.render', descriptionMd) || '';
                    } catch {
                        renderedDescriptionHtml = '';
                    }

                    this._panel?.webview.postMessage({
                        type: 'clickupTaskDetailsLoaded',
                        task: this._mapClickUpTaskToSidebar(details.task),
                        subtasks: details.subtasks.map((s: any) => this._mapClickUpTaskToSidebar(s)),
                        comments: details.comments.map((c: any) => this._mapClickUpComment(c)),
                        attachments: details.attachments.map((a: any) => this._mapClickUpAttachment(a)),
                        renderedDescriptionHtml,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
                        type: 'clickupError',
                        scope: 'task',
                        taskId: msg.taskId,
                        error: error instanceof Error ? error.message : 'Failed to load task details',
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'linearLabelsUpdated',
                        issueId,
                        labelIds,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'clickupTagsUpdated',
                        taskId,
                        tags: tagNames,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'linearAutomationCatalogLoaded',
                        labels: catalog.labels,
                        states: catalog.states,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'clickupSpaceTagsLoaded',
                        tags,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'clickupListStatusesLoaded',
                        statuses,
                        listId,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'linearTaskImported',
                        success: false,
                        error: 'Missing workspace or issue ID',
                        workspaceRoot: workspaceRoot || msg.workspaceRoot || undefined
                    });
                    break;
                }

                try {
                    if (mode === 'document') {
                        await vscode.commands.executeCommand(
                            'switchboard.importTaskAsDocument',
                            { workspaceRoot, provider: 'linear', id: issueId, includeSubtasks }
                        );
                    } else {
                        await vscode.commands.executeCommand(
                            'switchboard.importLinearTask',
                            { workspaceRoot, issueId, includeSubtasks }
                        );
                    }
                    this._panel?.webview.postMessage({
                        type: 'linearTaskImported',
                        success: true,
                        workspaceRoot
                    });
                } catch (error) {
                    console.error('[PlanningPanel] Failed to import Linear task:', error);
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'clickupTaskImported',
                        success: false,
                        error: 'Missing workspace or task ID',
                        workspaceRoot: workspaceRoot || msg.workspaceRoot || undefined
                    });
                    break;
                }

                try {
                    if (mode === 'document') {
                        await vscode.commands.executeCommand(
                            'switchboard.importTaskAsDocument',
                            { workspaceRoot, provider: 'clickup', id: taskId, includeSubtasks }
                        );
                    } else {
                        await vscode.commands.executeCommand(
                            'switchboard.importClickUpTask',
                            { workspaceRoot, taskId, includeSubtasks }
                        );
                    }
                    this._panel?.webview.postMessage({
                        type: 'clickupTaskImported',
                        success: true,
                        workspaceRoot
                    });
                } catch (error) {
                    console.error('[PlanningPanel] Failed to import ClickUp task:', error);
                    this._panel?.webview.postMessage({
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
                try {
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.importAllTasks',
                        { workspaceRoot, provider, ids, listId, projectId, workspaceId, page, append, importMode }
                    );
                    // Webview status is silent — surface the real outcome natively so
                    // failures aren't invisible (mirrors the ticket-push handler).
                    const errDetail = (result?.errors || []).slice(0, 3)
                        .map((e: any) => `${e.id}: ${e.error}`).join('; ');
                    if (!result?.success) {
                        vscode.window.showErrorMessage(`Import all (${importMode}) failed: ${result?.error || 'unknown'}`);
                    } else if ((result.successCount || 0) === 0) {
                        vscode.window.showWarningMessage(`Import all (${importMode}): nothing imported (${ids?.length ?? 0} requested${errDetail ? ' — ' + errDetail : ''}).`);
                    } else if ((result.failCount || 0) > 0) {
                        vscode.window.showWarningMessage(`Import all (${importMode}): ${result.successCount} imported, ${result.failCount} failed — ${errDetail}`);
                    }
                    this._panel?.webview.postMessage({
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
                    vscode.window.showErrorMessage(`Import all (${importMode}) failed: ${errMsg}`);
                    this._panel?.webview.postMessage({
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
            case 'openExternalUrl': {
                const url = msg.url as string;
                if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
                    vscode.env.openExternal(vscode.Uri.parse(url));
                }
                break;
            }
            case 'saveLocalTicketFile': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id, content } = msg;
                if (!workspaceRoot || !id || typeof content !== 'string') break;
                const filePath = this._findTicketFilePath(workspaceRoot, provider, id);
                if (!filePath) break;
                try {
                    const nfs = require('fs') as typeof import('fs');
                    const existing = nfs.readFileSync(filePath, 'utf8');
                    const frontmatterMatch = existing.match(/^(---\n[\s\S]*?\n---\n?)/);
                    const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';
                    nfs.writeFileSync(filePath, frontmatter + content, 'utf8');
                } catch { }
                break;
            }
            case 'editTicket': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id } = msg;
                try {
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.importTaskAsDocument',
                        { workspaceRoot, provider, id, includeSubtasks: true }
                    );
                    this._panel?.webview.postMessage({
                        type: 'editTicketResult',
                        success: result.success,
                        id,
                        filePath: result.filePath,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.pushTicketEdits',
                        { workspaceRoot, provider, id }
                    );
                    if (!result?.success) {
                        // Webview status is silent; surface the real reason natively.
                        vscode.window.showErrorMessage(`Push to ${provider} failed: ${result?.error || 'unknown error'}`);
                    }
                    this._panel?.webview.postMessage({
                        type: 'pushTicketResult',
                        success: result.success,
                        id,
                        error: result.error,
                        message: result.message,
                        workspaceRoot
                    });
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Push to ${provider} failed: ${errMsg}`);
                    this._panel?.webview.postMessage({
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
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.deleteTicket',
                        { workspaceRoot, provider, id }
                    );
                    this._panel?.webview.postMessage({
                        type: 'ticketDeleted',
                        success: result.success,
                        id,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({ type: 'localTicketFilesListed', provider, tickets: [] });
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

                            // Map DB entries to the provider-specific tickets output list
                            for (const dbT of dbTickets) {
                                if (dbT.sourceId === provider) {
                                    let kanbanColumn = '';
                                    let syncStatus: 'synced' | 'modified' | 'local-only' = 'local-only';
                                    if (fs.existsSync(dbT.filePath)) {
                                        try {
                                            const content = fs.readFileSync(dbT.filePath, 'utf8');
                                            const fm = content.match(/^---\n([\s\S]*?)\n---/);
                                            if (fm) {
                                                const km = fm[1].match(/kanbanColumn:\s*(.+)/);
                                                if (km) { kanbanColumn = km[1].trim(); }
                                            }
                                            // Sync status is purely a timestamp comparison against the
                                            // DB's last-fetch time: if the local file was edited after we
                                            // last pulled it from the source, it has unpushed local changes.
                                            syncStatus = this._ticketSyncStatusFromTimestamps(dbT.filePath, dbT.lastSyncedAt);
                                        } catch {}
                                    }
                                    tickets.push({
                                        id: dbT.remoteDocId || dbT.slugPrefix.replace(`${provider}_`, ''),
                                        title: dbT.docName,
                                        status: kanbanColumn || '',
                                        filePath: dbT.filePath,
                                        lastSyncedAt: dbT.lastSyncedAt,
                                        syncStatus
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

                this._panel?.webview.postMessage({ type: 'localTicketFilesListed', provider, tickets });
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
                this._panel?.webview.postMessage({ type: 'ticketSyncStatusesLoaded', provider, statuses });
                break;
            }
            case 'readLocalTicketFile': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider as 'clickup' | 'linear';
                const id = msg.id;
                if (!workspaceRoot || !provider || !id) {
                    this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: false });
                    break;
                }
                const filePath = this._findTicketFilePath(workspaceRoot, provider, id);
                if (!filePath) {
                    this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: false });
                    break;
                }
                try {
                    const raw = fs.readFileSync(filePath, 'utf8');
                    const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
                    const h1 = content.match(/^#\s+(.+)$/m);
                    const title = h1 ? h1[1].trim() : id;
                    this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: true, title, content });
                } catch {
                    this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: false });
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
                    
                    for (const ticket of tickets) {
                        try {
                            const result: any = await vscode.commands.executeCommand(
                                'switchboard.pushTicketEdits',
                                { workspaceRoot, provider, id: ticket.id }
                            );
                            if (result?.success) {
                                results.succeeded++;
                            } else {
                                results.failed++;
                                results.errors.push(`${ticket.id}: ${result?.error || 'Unknown error'}`);
                            }
                        } catch (err) {
                            results.failed++;
                            results.errors.push(`${ticket.id}: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }
                    
                    this._panel?.webview.postMessage({
                        type: 'syncAllTicketsResult',
                        success: results.failed === 0,
                        count: tickets.length,
                        succeeded: results.succeeded,
                        failed: results.failed,
                        errors: results.errors
                    });
                } else {
                    this._panel?.webview.postMessage({
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
                let lastError: string | undefined;
                if (workspaceRoot) {
                    if (Array.isArray(msg.ticketIds) && msg.ticketIds.length > 0) {
                        const providerDir = provider === 'clickup' ? 'clickup' : 'linear';
                        for (const id of msg.ticketIds) {
                            if (typeof id === 'string' && id && !id.includes('/') && !id.includes('\\') && !id.includes('..')) {
                                // Ticket files are named `${provider}_${id}_<slug>.md` and live in
                                // nested hierarchies (team/project/sprint), so resolve the real path
                                // by prefix scan rather than reconstructing a flat path.
                                let filePath = this._findTicketFilePath(workspaceRoot, providerDir, id);
                                if (!filePath) {
                                    // Ensure-then-link: import the ticket as a local doc, then use the
                                    // returned filePath directly (avoids a redundant re-scan race).
                                    try {
                                        const result: any = await vscode.commands.executeCommand('switchboard.importTaskAsDocument', {
                                            workspaceRoot,
                                            provider,
                                            id,
                                            includeSubtasks: true
                                        });
                                        if (result?.filePath) {
                                            filePath = result.filePath;
                                        } else if (result?.success === false) {
                                            lastError = result.error || 'Could not import ticket.';
                                            continue;
                                        }
                                        if (!filePath) {
                                            filePath = this._findTicketFilePath(workspaceRoot, providerDir, id);
                                        }
                                    } catch (err: any) {
                                        lastError = err?.message || String(err);
                                    }
                                }
                                if (filePath) {
                                    paths.push(filePath);
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
                        const hint = lastError || 'Could not locate or create a local file for this ticket.';
                        this._panel?.webview.postMessage({ type: 'ticketLinkFailed', error: hint });
                    } else {
                        const ticketRefs = paths;
                        await vscode.env.clipboard.writeText(ticketRefs.join('\n'));
                        this._panel?.webview.postMessage({ type: 'ticketLinkCopied', count: paths.length });
                    }
                } else {
                    await vscode.env.clipboard.writeText(paths.join('\n'));
                }
                break;
            }
            case 'copyDiagramPrompt': {
                try {
                    const { prompt } = msg;
                    if (typeof prompt !== 'string' || !prompt.trim()) {
                        vscode.window.showErrorMessage('Diagram prompt is empty.');
                        break;
                    }
                    await vscode.env.clipboard.writeText(prompt);
                    vscode.window.showInformationMessage('Diagram prompt copied to clipboard');
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to copy diagram prompt: ${String(err)}`);
                }
                break;
            }
            case 'copyRefinePrompt': {
                try {
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    const { provider, id, title, description } = msg;
                    if (!workspaceRoot || !id) {
                        vscode.window.showErrorMessage('Missing workspace or ticket ID for refine prompt');
                        break;
                    }

                    // Read user-editable skill file
                    const skillPath = path.join(workspaceRoot, '.agents', 'skills', 'refine_ticket.md');
                    let skillContent = '';
                    try {
                        const nfs = require('fs') as typeof import('fs');
                        skillContent = nfs.readFileSync(skillPath, 'utf8');
                    } catch {
                        // Backward-compatible fallback: a user who kept their old .agent/ folder.
                        try {
                            const nfs = require('fs') as typeof import('fs');
                            const legacyPath = path.join(workspaceRoot, '.agent', 'skills', 'refine_ticket.md');
                            skillContent = nfs.readFileSync(legacyPath, 'utf8');
                        } catch {
                            skillContent = `Refine this ticket into a complete specification with:
- Summary, Background/Why, User Flow, Acceptance Criteria (checkboxed, testable)
- Assumptions challenged, Open Questions, Dependencies
- Mermaid flow diagram rendered to PNG if the flow is non-trivial
- Write result back to the local file path provided.`;
                        }
                    }

                    // Resolve local ticket file path
                    let localFilePath = '';
                    try {
                        localFilePath = this._findTicketFilePath(workspaceRoot, provider, id) || '';
                    } catch { }

                    const prompt = `You are refining a ${provider} ticket into a complete, agent-actionable specification.

## Skill Instructions
${skillContent}

## Ticket to Refine
- **Title:** ${title || ''}
- **Description:** ${description || ''}
- **Ticket ID:** ${id}
- **Provider:** ${provider}
${localFilePath ? `- **Local file path (write the refined content here):** ${localFilePath}` : ''}

Read the existing ticket content from the local file if it exists. Determine what's missing. Produce a complete ticket following the skill instructions above. Write the refined markdown directly to the local file path, preserving any YAML frontmatter. Report back with a summary of what you added or changed.`;

                    await vscode.env.clipboard.writeText(prompt);
                    vscode.window.showInformationMessage('Refine prompt copied to clipboard');
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to copy refine prompt: ${String(err)}`);
                }
                break;
            }
            case 'changeTicketStatus': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id, statusId } = msg;
                try {
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.changeTicketStatus',
                        { workspaceRoot, provider, id, statusId }
                    );
                    this._panel?.webview.postMessage({
                        type: 'changeTicketStatusResult',
                        success: result.success,
                        id,
                        statusId,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.postTicketComment',
                        { workspaceRoot, provider, id, comment, mentions }
                    );
                    this._panel?.webview.postMessage({
                        type: 'postTicketCommentResult',
                        success: result.success,
                        id,
                        comment,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.loadTicketComments',
                        { workspaceRoot, provider, id }
                    );
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.postTicketReply',
                        { workspaceRoot, provider, id, commentId, commentText, mentions }
                    );
                    this._panel?.webview.postMessage({
                        type: 'postTicketReplyResult',
                        success: result.success,
                        id,
                        commentId,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.downloadAttachment',
                        { workspaceRoot, provider, url, filename, ticketId, ticketTitle }
                    );
                    this._panel?.webview.postMessage({
                        type: 'attachmentDownloaded',
                        success: result.success,
                        url,
                        filePath: result.filePath,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.getAttachmentList',
                        { workspaceRoot, provider, ticketId, attachmentsArray: attachments }
                    );
                    this._panel?.webview.postMessage({
                        type: 'attachmentsListResult',
                        success: true,
                        ticketId,
                        attachments: result,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    const uri = vscode.Uri.file(localPath);
                    await vscode.env.openExternal(uri);
                    this._panel?.webview.postMessage({
                        type: 'attachmentOpened',
                        success: true,
                        localPath,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    const uri = vscode.Uri.file(localPath);
                    await vscode.commands.executeCommand('revealInExplorer', uri);
                    this._panel?.webview.postMessage({
                        type: 'attachmentRevealed',
                        success: true,
                        localPath,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                        ...(msg.parentId ? { parent: msg.parentId } : {})
                    });
                    if (task) {
                        // A remote-only ticket diverges from every other ticket in the
                        // tab (which are both local + online). Import it immediately so
                        // the local file + DB entry exist, exactly like the Import button.
                        try {
                            await vscode.commands.executeCommand(
                                'switchboard.importTaskAsDocument',
                                { workspaceRoot, provider: 'clickup', id: task.id, includeSubtasks: false }
                            );
                        } catch (importErr) {
                            console.error('[PlanningPanel] Created ClickUp task but local import failed:', importErr);
                        }
                        this._panel?.webview.postMessage({
                            type: 'clickupTaskCreated',
                            success: true,
                            workspaceRoot
                        });
                    } else {
                        this._panel?.webview.postMessage({
                            type: 'clickupTaskCreated',
                            success: false,
                            error: 'Failed to create ClickUp task (empty result).',
                            workspaceRoot
                        });
                    }
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                        ...(msg.parentId ? { parentId: msg.parentId } : {})
                    });
                    // A remote-only ticket diverges from every other ticket in the tab
                    // (which are both local + online). Import it immediately so the local
                    // file + DB entry exist, exactly like the Import button.
                    if (result?.id) {
                        try {
                            await vscode.commands.executeCommand(
                                'switchboard.importTaskAsDocument',
                                { workspaceRoot, provider: 'linear', id: result.id, includeSubtasks: false }
                            );
                        } catch (importErr) {
                            console.error('[PlanningPanel] Created Linear issue but local import failed:', importErr);
                        }
                    }
                    this._panel?.webview.postMessage({
                        type: 'linearIssueCreated',
                        success: true,
                        result,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'subtaskConverted',
                        success: true,
                        provider: msg.provider,
                        taskId: msg.taskId,
                        parentId: msg.parentId,
                        workspaceRoot
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({
                        type: 'ticketsAskAgentResult',
                        success: false,
                        error: 'Missing workspace or ticket ID',
                        workspaceRoot: askWorkspaceRoot || msg.workspaceRoot || undefined
                    });
                    break;
                }

                try {
                    await vscode.commands.executeCommand(
                        'switchboard.askAgentTask',
                        {
                            workspaceRoot: askWorkspaceRoot,
                            id: ticketId,
                            title: String(msg.title || '').trim(),
                            description: String(msg.description || '').trim(),
                            provider
                        }
                    );
                    this._panel?.webview.postMessage({ type: 'ticketsAskAgentResult', success: true, workspaceRoot: askWorkspaceRoot });
                } catch (error) {
                    console.error('[PlanningPanel] Failed to send ticket to agent:', error);
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({ type: 'onlineDocCreated', success: false, error: 'Missing source' });
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
                                this._panel?.webview.postMessage({ type: 'onlineDocCreated', success: false, error: 'Adapter not available' });
                                break;
                            }
                            const containers = await adapter.listContainers();
                            if (!containers || containers.length === 0) {
                                this._panel?.webview.postMessage({ type: 'onlineDocCreated', success: false, error: 'No containers available to create doc' });
                                break;
                            }
                            const pick = await vscode.window.showQuickPick(
                                containers.map(c => ({ label: c.name, description: c.id, value: c.id })),
                                { placeHolder: `Choose a location for new ${sourceId} document` }
                            );
                            if (!pick) {
                                this._panel?.webview.postMessage({ type: 'onlineDocCreated', success: false, error: 'No location selected' });
                                break;
                            }
                            parentId = pick.value;
                            // Save as upload location
                            if (configPath) {
                                const updated = { ...config, uploadLocations: { ...(config.uploadLocations || {}), [sourceId]: parentId } };
                                await fs.promises.writeFile(configPath, JSON.stringify(updated, null, 2));
                                this._resolvedConfigCache = { configPath, config: updated, sourceRoot };
                            }
                        }
                    }
                    if (!title) {
                        title = (await vscode.window.showInputBox({ prompt: 'Document title', placeHolder: 'Enter document title' })) || '';
                        if (!title) {
                            this._panel?.webview.postMessage({ type: 'onlineDocCreated', success: false, error: 'No title provided' });
                            break;
                        }
                    }
                    const adapter = this._researchImportService.getAdapter(sourceId);
                    if (!adapter || !adapter.createDocument) {
                        this._panel?.webview.postMessage({ type: 'onlineDocCreated', success: false, error: 'Adapter does not support document creation' });
                        break;
                    }
                    const result = await adapter.createDocument({ parentId, title });
                    if (result.success) {
                        // Refresh source
                        this._sendOnlineDocsReady();
                        this._panel?.webview.postMessage({ type: 'onlineDocCreated', success: true, docId: result.docId, url: result.url, sourceId });
                    } else {
                        this._panel?.webview.postMessage({ type: 'onlineDocCreated', success: false, error: result.error || 'Creation failed' });
                    }
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'onlineDocCreated', success: false, error: String(err) });
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
                    const pick = await vscode.window.showQuickPick(
                        containers.map(c => ({ label: c.name, description: c.id, value: c.id })),
                        { placeHolder: `Set upload location for ${sourceId}` }
                    );
                    if (pick && configPath) {
                        const updated = { ...config, uploadLocations: { ...(config.uploadLocations || {}), [sourceId]: pick.value } };
                        await fs.promises.writeFile(configPath, JSON.stringify(updated, null, 2));
                        this._resolvedConfigCache = { configPath, config: updated, sourceRoot };
                        this._panel?.webview.postMessage({ type: 'uploadLocationSet', sourceId, containerId: pick.value });
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
                    this._panel?.webview.postMessage({ type: 'syncToOnlineResult', success: false, error: 'Missing local doc path or source' });
                    break;
                }
                try {
                    const content = await fs.promises.readFile(localDocPath, 'utf8');
                    const { configPath, config, sourceRoot } = await this._resolveSyncConfig();
                    const mappingKey = localDocPath;
                    const existingMapping = config.docMappings?.[mappingKey];

                    const adapter = this._researchImportService.getAdapter(sourceId);
                    if (!adapter) {
                        this._panel?.webview.postMessage({ type: 'syncToOnlineResult', success: false, error: 'Adapter not available' });
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

                    this._panel?.webview.postMessage({ type: 'syncToOnlineResult', ...result });
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'syncToOnlineResult', success: false, error: String(err) });
                }
                break;
            }
            case 'getSyncConfig': {
                try {
                    const { config } = await this._resolveSyncConfig();
                    this._panel?.webview.postMessage({
                        type: 'syncConfigReady',
                        uploadLocations: config.uploadLocations || {},
                        docMappings: config.docMappings || {}
                    });
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'syncConfigReady', uploadLocations: {}, docMappings: {} });
                }
                break;
            }
            case 'getPlanningPanelSyncMode': {
                try {
                    const { sourceRoot } = await this._resolveSyncConfig();
                    const resolvedRoot = sourceRoot || this._getWorkspaceRoot() || allRoots[0];
                    if (!resolvedRoot) {
                        this._panel?.webview.postMessage({
                            type: 'planningPanelSyncModeReady',
                            mode: 'no-sync',
                            selectedContainers: []
                        });
                        break;
                    }
                    const db = KanbanDatabase.forWorkspace(resolvedRoot);
                    const rawMode = await db.getConfig('planning.syncMode') || 'no-sync';
                    const validModes = ['no-sync', 'auto-sync-all', 'sync-selected'];
                    const mode = validModes.includes(rawMode) ? rawMode : 'no-sync';
                    const selectedContainers = await db.getConfigJson<string[]>('planning.selectedContainers', []);
                    this._panel?.webview.postMessage({
                        type: 'planningPanelSyncModeReady',
                        mode,
                        selectedContainers
                    });
                } catch (err) {
                    this._panel?.webview.postMessage({
                        type: 'planningPanelSyncModeReady',
                        mode: 'no-sync',
                        selectedContainers: []
                    });
                }
                break;
            }
            case 'setPlanningPanelSyncMode': {
                const validModes = ['no-sync', 'auto-sync-all', 'sync-selected'];
                const syncMode = validModes.includes(msg.mode) ? msg.mode : 'no-sync';
                const { sourceRoot } = await this._resolveSyncConfig();
                const resolvedRoot = sourceRoot || this._getWorkspaceRoot() || allRoots[0];
                if (!resolvedRoot) {
                    break;
                }
                const db = KanbanDatabase.forWorkspace(resolvedRoot);
                await db.setConfig('planning.syncMode', syncMode);
                this._resolvedConfigCache = null;
                await this.triggerSync(resolvedRoot, syncMode);
                break;
            }
            case 'fetchAvailableSyncContainers': {
                const { sourceRoot } = await this._resolveSyncConfig();
                const resolvedRoot = sourceRoot || this._getWorkspaceRoot() || allRoots[0];
                if (!resolvedRoot) {
                    break;
                }
                
                const containers: Array<{sourceId: string, id: string, name: string}> = [];
                
                // ClickUp
                try {
                    const clickUpAdapter = this._adapterFactories.getClickUpDocsAdapter?.(resolvedRoot);
                    if (clickUpAdapter && typeof clickUpAdapter.listContainers === 'function') {
                        const clickUpContainers = await clickUpAdapter.listContainers();
                        for (const c of clickUpContainers) {
                            containers.push({ sourceId: 'clickup', id: String(c.id), name: String(c.name) });
                        }
                    }
                } catch { }
                
                // Linear
                try {
                    const linearAdapter = this._adapterFactories.getLinearDocsAdapter?.(resolvedRoot);
                    if (linearAdapter && typeof linearAdapter.listContainers === 'function') {
                        const linearContainers = await linearAdapter.listContainers();
                        for (const c of linearContainers) {
                            containers.push({ sourceId: 'linear', id: String(c.id), name: String(c.name) });
                        }
                    }
                } catch { }
                
                // Notion
                try {
                    const notionService = this._adapterFactories.getNotionService?.(resolvedRoot);
                    if (notionService) {
                        const notionConfig = await notionService.loadConfig();
                        if (notionConfig?.setupComplete && notionConfig.pageTitle) {
                            containers.push({ sourceId: 'notion', id: notionConfig.pageId || 'default', name: notionConfig.pageTitle });
                        }
                    }
                } catch { }
                
                // Local folder
                try {
                    const localService = this._getLocalFolderService(resolvedRoot);
                    if (localService) {
                        const folderPath = localService.getFolderPath?.();
                        if (folderPath) {
                            containers.push({ sourceId: 'local-folder', id: 'root', name: path.basename(folderPath) });
                        }
                    }
                } catch { }
                
                const db = KanbanDatabase.forWorkspace(resolvedRoot);
                const selected = await db.getConfigJson<string[]>('planning.selectedContainers', []);
                this._panel?.webview.postMessage({
                    type: 'availableSyncContainersReady',
                    containers,
                    selectedContainers: selected
                });
                break;
            }
            case 'setPlanningPanelSelectedContainers': {
                const { sourceRoot } = await this._resolveSyncConfig();
                const resolvedRoot = sourceRoot || this._getWorkspaceRoot() || allRoots[0];
                if (!resolvedRoot) {
                    break;
                }
                const containers = Array.isArray(msg.containers) ? msg.containers.map((v: unknown) => String(v)) : [];
                const db = KanbanDatabase.forWorkspace(resolvedRoot);
                await db.setConfigJson('planning.selectedContainers', containers);
                this._resolvedConfigCache = null;
                await this.triggerSync(resolvedRoot, 'sync-selected');
                break;
            }
            case 'loadInsights': {
                const wsRoot = String(msg.workspaceRoot || '');
                if (wsRoot) {
                    const insights = InsightManager.listInsights(wsRoot);
                    this._projectPanel?.webview.postMessage({ type: 'insightsLoaded', insights });
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
                    this._projectPanel?.webview.postMessage({ type: 'insightsLoaded', insights: allInsights });
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
                        const renderedHtml = await vscode.commands.executeCommand<string>('markdown.api.render', content);
                        this._projectPanel?.webview.postMessage({
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
                    vscode.window.showInformationMessage('No plans with adversarial review sections found.');
                    this._projectPanel?.webview.postMessage({ type: 'tuningExtractComplete', planCount: 0 });
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
                await vscode.env.clipboard.writeText(extractPrompt);
                vscode.window.showInformationMessage('Tuning extract prompt copied to clipboard. Paste it into your agent chat.');
                this._projectPanel?.webview.postMessage({ type: 'tuningExtractComplete', planCount: planFiles.length });
                break;
            }
            case 'runTuningGovernance': {
                const wsRoot = String(msg.workspaceRoot || '');
                const effectiveWsRoot = wsRoot || (allRoots.length > 0 ? allRoots[0] : '');
                const governancePrompt = `Run the tuning skill in governance mode for workspace: ${effectiveWsRoot}\n\nRead all insight files in ${effectiveWsRoot}/.switchboard/insights/ with status 'open'. Review the insights and propose specific edits to governance files (CONSTITUTION.md, AGENTS.md, CLAUDE.md) to address the recurring patterns. Present proposed changes as diffs.`;
                await vscode.env.clipboard.writeText(governancePrompt);
                vscode.window.showInformationMessage('Tuning governance prompt copied to clipboard. Paste it into your agent chat.');
                this._projectPanel?.webview.postMessage({ type: 'tuningGovernanceComplete' });
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
                    this._projectPanel?.webview.postMessage({ type: 'insightsLoaded', insights });
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
                    this._projectPanel?.webview.postMessage({ type: 'insightsLoaded', insights });
                    this._projectPanel?.webview.postMessage({ type: 'insightContent', filename: '', workspaceRoot: wsRoot, content: '' });
                } catch (err) {
                    console.error('[PlanningPanel] Failed to delete insight:', err);
                }
                break;
            }
            case 'copyInsightLink': {
                const link = String(msg.link || '');
                if (link) {
                    const linkRef = link;
                    await vscode.env.clipboard.writeText(linkRef);
                    this._projectPanel?.webview.postMessage({ type: 'insightLinkCopied' });
                }
                break;
            }
        }
    }

    private async _handleDisableDesignDoc(): Promise<void> {
        try {
            await vscode.workspace.getConfiguration('switchboard').update(
                'planner.designDocEnabled',
                false,
                vscode.ConfigurationTarget.Workspace
            );
            // Clear the designDocLink to remove stale references
            await vscode.workspace.getConfiguration('switchboard').update(
                'planner.designDocLink',
                undefined,
                vscode.ConfigurationTarget.Workspace
            );
            this._activeDesignDocSourceId = null;
            this._activeDesignDocId = null;
            // Send updated state back to panel
            await this._sendActiveDesignDocState();
        } catch (err) {
            console.error('[PlanningPanelProvider] Failed to disable design doc:', err);
            this._panel?.webview.postMessage({
                type: 'activeDesignDocUpdated',
                planningEpic: { enabled: true, docName: this._getPlanningEpicName() || 'None', sourceId: this._activeDesignDocSourceId, docId: this._activeDesignDocId },
                error: String(err)
            });
        }
    }

    private async _handleSetActivePlanningContext(
        workspaceRoot: string,
        sourceId: string,
        docId: string,
        docName: string,
        sourceFolder?: string
    ): Promise<void> {
        try {
            let docPath: string | null = null;

            if (sourceId === 'local-folder') {
                if (!sourceFolder) {
                    throw new Error('sourceFolder is required');
                }
                const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, sourceId)
                    || this._getLocalFolderService(workspaceRoot);
                const resolvedSourceFolder = localFolderService.resolveFolderPath(sourceFolder);
                const allowedPaths = localFolderService.getFolderPaths();
                if (!allowedPaths.includes(resolvedSourceFolder)) {
                    throw new Error('sourceFolder is not a configured folder path');
                }
                const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
                docPath = path.join(resolvedSourceFolder, cleanDocId);
                try {
                    await fs.promises.access(docPath, fs.constants.R_OK);
                } catch {
                    docPath = null;
                }
            } else if (sourceId === 'antigravity') {
                // For antigravity: docId is already an absolute path to the artifact
                const localFolderService = this._getLocalFolderService(workspaceRoot);
                const result = await localFolderService.fetchAntigravityArtifact(docId);
                if (result.success) {
                    docPath = docId;
                } else {
                    docPath = null;
                }
            } else {
                // For online sources: resolve through the import registry
                if (this._cacheService) {
                    const rawSlug = (docName || sourceId)
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_+|_+$/g, '')
                        .slice(0, 60) || sourceId;
                    const workspaceId = await this._getWorkspaceId(workspaceRoot);
                    docPath = await this._cacheService.resolveImportedDocPath(rawSlug, workspaceId);
                }
            }

            if (!docPath) {
                this._panel?.webview.postMessage({ type: 'activeContextSet', success: false, error: 'Document not found' });
                return;
            }

            await vscode.workspace.getConfiguration('switchboard').update(
                'planner.designDocLink', docPath, vscode.ConfigurationTarget.Workspace
            );
            await vscode.workspace.getConfiguration('switchboard').update(
                'planner.designDocEnabled', true, vscode.ConfigurationTarget.Workspace
            );
            this._activeDesignDocSourceId = sourceId;
            this._activeDesignDocId = docId;
            await this._sendActiveDesignDocState();

            this._panel?.webview.postMessage({ type: 'activeContextSet', success: true });
        } catch (err) {
            this._panel?.webview.postMessage({
                type: 'activeContextSet',
                success: false,
                error: String(err)
            });
        }
    }

    private async _handleLinkToDocument(
        workspaceRoot: string,
        sourceId: string,
        docId: string,
        docName: string,
        sourceFolder?: string
    ): Promise<void> {
        try {
            let docPath: string | null = null;

            if (sourceId === 'local-folder') {
                if (!sourceFolder) {
                    throw new Error('sourceFolder is required');
                }
                const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, sourceId)
                    || this._getLocalFolderService(workspaceRoot);
                const resolvedSourceFolder = localFolderService.resolveFolderPath(sourceFolder);
                const allowedPaths = localFolderService.getFolderPaths();
                if (!allowedPaths.includes(resolvedSourceFolder)) {
                    throw new Error('sourceFolder is not a configured folder path');
                }
                const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
                docPath = path.join(resolvedSourceFolder, cleanDocId);
                try {
                    await fs.promises.access(docPath, fs.constants.R_OK);
                } catch {
                    docPath = null;
                }
            } else if (sourceId === 'antigravity') {
                // For antigravity: docId is already an absolute path to the artifact
                const localFolderService = this._getLocalFolderService(workspaceRoot);
                const result = await localFolderService.fetchAntigravityArtifact(docId);
                if (result.success) {
                    docPath = docId;
                } else {
                    docPath = null;
                }
            } else {
                if (this._cacheService) {
                    const rawSlug = (docName || sourceId)
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_+|_+$/g, '')
                        .slice(0, 60) || sourceId;
                    const workspaceId = await this._getWorkspaceId(workspaceRoot);
                    docPath = await this._cacheService.resolveImportedDocPath(rawSlug, workspaceId);
                }
            }

            if (!docPath) {
                vscode.window.showErrorMessage('Document not found');
                return;
            }

            const docRef = docPath;
            await vscode.env.clipboard.writeText(docRef);
            vscode.window.showInformationMessage(`Document path copied to clipboard: ${docRef}`);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to link to document: ${String(err)}`);
        }
    }

    private async _handleLinkToFolder(
        workspaceRoot: string,
        folderPath: string
    ): Promise<void> {
        try {
            let resolvedFolder = '';
            let localFolderService = this._getLocalFolderService(workspaceRoot);

            if (/^\d+:/.test(folderPath)) {
                const colonIdx = folderPath.indexOf(':');
                const relativePath = folderPath.substring(colonIdx + 1);
                let found = false;
                for (const root of this._getWorkspaceRoots()) {
                    const service = this._getLocalFolderService(root);
                    const folderPaths = service.getFolderPaths();
                    for (let i = 0; i < folderPaths.length; i++) {
                        const candidate = path.join(folderPaths[i], relativePath);
                        if (fs.existsSync(candidate)) {
                            resolvedFolder = candidate;
                            localFolderService = service;
                            found = true;
                            break;
                        }
                    }
                    if (found) { break; }
                }
                if (!found) {
                    throw new Error('Subfolder not found');
                }
            } else {
                localFolderService = this._getLocalFolderServiceForFolder(folderPath, workspaceRoot, 'local-folder')
                    || this._getLocalFolderService(workspaceRoot);
                resolvedFolder = localFolderService.resolveFolderPath(folderPath);
            }

            const allowedPaths = localFolderService.getFolderPaths();
            const isWithinAllowed = allowedPaths.some(p => resolvedFolder.startsWith(p + path.sep) || resolvedFolder === p);
            if (!isWithinAllowed) {
                throw new Error('Folder is not within a configured local docs folder');
            }
            if (!fs.existsSync(resolvedFolder)) {
                throw new Error('Folder does not exist');
            }
            await vscode.env.clipboard.writeText(resolvedFolder);
            vscode.window.showInformationMessage(`Folder path copied to clipboard: ${resolvedFolder}`);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to link to folder: ${String(err)}`);
        }
    }

    private async _handleCreateLocalDoc(
        workspaceRoot: string,
        folderPath: string
    ): Promise<void> {
        try {
            const docName = await vscode.window.showInputBox({
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
                    vscode.window.showErrorMessage('Folder is not a configured local docs folder');
                    return;
                }
                const folderIndex = allowedPaths.indexOf(resolvedFolder);
                docId = `${folderIndex}:${sanitized}`;
            }

            const filePath = path.join(resolvedFolder, sanitized);
            if (fs.existsSync(filePath)) {
                vscode.window.showErrorMessage(`A document named ${sanitized} already exists.`);
                return;
            }

            const title = sanitized.replace(/\.md$/i, '');
            const stub = `# ${title}\n`;
            await fs.promises.writeFile(filePath, stub, 'utf8');

            this._lastLocalDocsSignature = '';
            await this._sendLocalDocsReady();
            this._panel?.webview.postMessage({
                type: 'selectLocalDoc',
                docId,
                docName: sanitized
            });
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to create document: ${String(err)}`);
        }
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
                this._panel?.webview.postMessage({
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
                this._panel?.webview.postMessage({
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
                            this._panel?.webview.postMessage({
                                type: 'duplicateResolved', success: false,
                                error: 'Could not generate a unique name (too many duplicates)'
                            });
                            return;
                        }
                    }
                }
                // Import with the new name; duplicate check passes because name is unique
                await this._handleImportFullDoc(workspaceRoot, sourceId, docId, newName);
                this._panel?.webview.postMessage({
                    type: 'duplicateResolved', success: true, message: `Imported as "${newName}"`
                });
                return;
            }

            this._panel?.webview.postMessage({
                type: 'duplicateResolved', success: false, error: 'Invalid action'
            });
        } catch (err) {
            this._panel?.webview.postMessage({
                type: 'duplicateResolved', success: false, error: String(err)
            });
        }
    }

    private _getPlanningEpicName(): string | null {
        const config = vscode.workspace.getConfiguration('switchboard');
        const designDocLink = config.get<string>('planner.designDocLink');
        if (!designDocLink) return null;
        return path.basename(designDocLink, '.md');
    }


    private async _sendActiveDesignDocState(): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard');
        const enabled = config.get<boolean>('planner.designDocEnabled', false);
        const docName = enabled ? this._getPlanningEpicName() : null;
        const payload = {
            type: 'activeDesignDocUpdated',
            planningEpic: { enabled, docName: docName || 'None', sourceId: this._activeDesignDocSourceId, docId: this._activeDesignDocId }
        };
        this._panel?.webview.postMessage(payload);
        this._projectPanel?.webview.postMessage(payload);
    }

    private _updateWebviewRoots(): void {
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

        const localResourceRoots = [
            vscode.Uri.joinPath(this._extensionUri, 'dist'),
            vscode.Uri.joinPath(this._extensionUri, 'webview'),
            vscode.Uri.joinPath(this._extensionUri, 'designs'),
            vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
            ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri),
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

            const agConfig = vscode.workspace.getConfiguration('switchboard');
            const agEnabled = agConfig.get<boolean>('research.antigravityBrainEnabled', false);
            if (agEnabled && allRoots.length > 0) {
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
                antigravityEnabled: agEnabled,
                workspaceItems
            });
            if (!force && signature === this._lastLocalDocsSignature) {
                return;
            }
            this._lastLocalDocsSignature = signature;

            console.log('[PlanningPanel] Sending localDocsReady, total nodes count:', allFiles.length);
            this._panel.webview.postMessage({
                type: 'localDocsReady',
                sourceId: 'local-folder',
                folderPathsByRoot: configuredFolderPathsByRoot,
                ticketsFolderPathsByRoot,
                nodes: mappedNodes,
                workspaceItems,
                kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
                antigravitySessions,
                antigravityEnabled: agEnabled
            });
        } catch (err) {
            console.error('[PlanningPanel] Failed to fetch local-folder roots:', err);
            this._lastLocalDocsSignature = ''; // force re-render on next successful send
            this._panel?.webview.postMessage({
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
        const folderUri = workspaceRoot ? vscode.workspace.workspaceFolders?.find(f => path.resolve(f.uri.fsPath) === path.resolve(workspaceRoot))?.uri : undefined;
        const configScope = vscode.workspace.getConfiguration('switchboard', folderUri);
        const enabledSourcesConfig = configScope.get<Record<string, boolean>>('planning.enabledSources') || {};

        const enabledSources: Record<string, boolean> = {};
        availableSources.forEach(s => {
            if (s !== 'local-folder') {
                enabledSources[s] = enabledSourcesConfig[s] !== false;
            }
        });
        this._panel.webview.postMessage({
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
        const cyberAnimationDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
        this._panel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled: cyberAnimationDisabled });
        const currentTheme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
        this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
    }

    private async _handleFetchChildren(workspaceRoot: string, sourceId: string, parentId?: string): Promise<void> {
        // Handle local-folder directly without adapter
        if (sourceId === 'local-folder') {
            const localFolderService = this._getLocalFolderService(workspaceRoot);
            try {
                const files = await localFolderService.listFiles();
                const nodes = this._mapLocalFilesToTreeNodes(files)
                    .filter(node => node.parentId === parentId || (!parentId && !node.parentId));
                this._panel?.webview.postMessage({ type: 'childrenReady', sourceId, parentId, nodes });
            } catch (err) {
                console.error(`Failed to fetch children for ${sourceId}:`, err);
                this._panel?.webview.postMessage({ type: 'childrenReady', sourceId, parentId, nodes: [] });
            }
            return;
        }

        const adapter = this._researchImportService.getAdapter(sourceId);
        if (!adapter) {
            this._panel?.webview.postMessage({ type: 'childrenReady', sourceId, parentId, nodes: [] });
            return;
        }

        try {
            const nodes = await adapter.fetchChildren(parentId);
            this._panel?.webview.postMessage({ type: 'childrenReady', sourceId, parentId, nodes });
        } catch (err) {
            console.error(`Failed to fetch children for ${sourceId}:`, err);
            this._panel?.webview.postMessage({ type: 'childrenReady', sourceId, parentId, nodes: [] });
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
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'sourceFolder is required' });
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
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'sourceFolder is required' });
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
                            this._panel?.webview.postMessage({
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

                    this._panel?.webview.postMessage({ 
                        type: 'previewReady', 
                        sourceId, 
                        requestId, 
                        content: result.content || '', 
                        docName: result.docTitle,
                        isAutoRefreshed: this._isAutoRefreshing,
                        filePath: resolvedPath
                    });
                } else {
                    this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: result.error || 'Failed to fetch document' });
                }
            } catch (err) {
                console.error('[PlanningPanel] Error fetching local doc:', err);
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: String(err) });
            }
            return;
        }

        const adapter = this._researchImportService.getAdapter(sourceId);
        if (!adapter) {
            this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'Adapter not found' });
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

                    this._panel?.webview.postMessage({ 
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
                        this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: docResult.error || 'Failed to fetch ClickUp document' });
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

            this._panel?.webview.postMessage({ 
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
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: String(err) });
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
                result = await this._plannerPromptWriter.writeContentToDocsDir(workspaceRoot, finalContent, docName, sourceId, { skipDesignDocLink: true });
            } else {
                result = await this._plannerPromptWriter.writeFromPlanningCache(workspaceRoot, sourceId, docId, docName, { skipDesignDocLink: true });
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
            this._panel?.webview.postMessage({ type: 'plannerPromptState', ...result });
            // Send updated active design doc state after import
            if (result.success) {
                await this._sendActiveDesignDocState();
            }
        } catch (err) {
            this._panel?.webview.postMessage({ type: 'plannerPromptState', error: String(err) });
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
            console.log('[PlanningPanelProvider] _handleFetchImportedDocs: allRoots=', allRoots);
            const allDocs: any[] = [];
            const seenSlugs = new Set<string>();

            for (const root of allRoots) {
                const wsId = await this._getWorkspaceId(root);
                console.log('[PlanningPanelProvider] _handleFetchImportedDocs: root=', root, 'wsId=', wsId);
                const cacheService = this._adapterFactories.getCacheService(root);
                console.log('[PlanningPanelProvider] _handleFetchImportedDocs: cacheService._kanbanDb.dbPath=', (cacheService as any)._kanbanDb?.dbPath);

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
                console.log('[PlanningPanelProvider] _handleFetchImportedDocs: dbEntries count=', dbEntries.length, 'for wsId=', wsId);

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

            console.log('[PlanningPanelProvider] Sending importedDocsReady with docs:', allDocs);
            this._panel?.webview.postMessage({ type: 'importedDocsReady', docs: allDocs });
        } catch (err) {
            console.error('[PlanningPanelProvider] Error fetching imported docs:', err);
            this._panel?.webview.postMessage({ type: 'importedDocsReady', docs: [], error: String(err) });
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
                this._panel?.webview.postMessage({
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

            this._panel?.webview.postMessage({
                type: 'previewReady',
                sourceId: 'local-folder',
                requestId,
                content: displayContent,
                docName,
                isAutoRefreshed: this._isAutoRefreshing
            });
        } catch (err) {
            console.error('[PlanningPanelProvider] Error fetching docs file:', err);
            this._panel?.webview.postMessage({
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
                this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: false, error: 'Cache service not available' });
                return;
            }

            const workspaceId = await this._getWorkspaceId(workspaceRoot);
            const importEntry = await this._cacheService.getImportBySlugPrefix(slugPrefix, workspaceId);
            if (!importEntry) {
                this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: false, error: 'Import entry not found' });
                return;
            }

            const adapter = this._researchImportService.getAdapter(importEntry.sourceId);
            if (!adapter || !adapter.updateContent) {
                this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: false, error: 'Source does not support sync-to-source' });
                return;
            }

            const localPath = await this._cacheService.resolveImportedDocPath(slugPrefix, workspaceId);
            if (!localPath) {
                this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: false, error: 'Local file not found' });
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
                            this._panel?.webview.postMessage({
                                type: 'syncResult', slugPrefix, success: true,
                                message: 'Remote was updated. Local content is unchanged. Registry updated.'
                            });
                            return;
                        }

                        // Both local and remote have changed — conflict: offer resolution via modal dialog
                        const choice = await vscode.window.showWarningMessage(
                            `Conflict: Both the local and remote document "${importEntry.docName}" have been modified since the last sync.`,
                            { modal: true },
                            'Overwrite Remote',
                            'Keep Remote',
                            'Cancel'
                        );
                        if (choice === 'Keep Remote' || choice === 'Cancel' || !choice) {
                            this._panel?.webview.postMessage({
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
                this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: true });
            } else {
                this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: false, error: result.error });
            }
        } catch (err) {
            this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: false, error: String(err) });
        }
    }

    private async _handleImportFullDoc(workspaceRoot: string, sourceId: string, docId: string, docName: string, sourceFolder?: string): Promise<void> {
        // Concurrency guard: prevent double-import
        if (this._importInProgress) {
            this._panel?.webview.postMessage({ type: 'importFullDocResult', error: 'Import already in progress' });
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
                    this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({ type: 'importFullDocResult', error: 'sourceFolder is required' });
                    return;
                }
                const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, 'local-folder')
                    || this._getLocalFolderService(workspaceRoot);
                const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
                const result = await localFolderService.fetchDocContent(cleanDocId, sourceFolder);
                if (!result.success) {
                    this._panel?.webview.postMessage({ type: 'importFullDocResult', error: result.error || 'Failed to fetch document' });
                    return;
                }
                const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
                    workspaceRoot,
                    result.content || '',
                    docName,
                    sourceId,
                    { skipDesignDocLink: true }
                );
                this._lastPanelWriteTimestamp = Date.now();
                if (writeResult.error) {
                    this._panel?.webview.postMessage({ type: 'importFullDocResult', error: writeResult.error });
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
                this._panel?.webview.postMessage({ type: 'importFullDocResult', success: true, message: 'Document imported', savedPath: writeResult.savedPath, docName });
                return;
            }

            const adapter = this._researchImportService.getAdapter(sourceId);
            if (!adapter) {
                this._panel?.webview.postMessage({ type: 'importFullDocResult', error: 'Adapter not found' });
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
                                    { pageOrder: pageIndex, parentDocName: docName, skipDesignDocLink: true }
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
                    this._panel?.webview.postMessage({
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
                { skipDesignDocLink: true }
            );

            if (writeResult.error) {
                this._panel?.webview.postMessage({ type: 'importFullDocResult', error: writeResult.error });
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
            this._panel?.webview.postMessage({
                type: 'importFullDocResult',
                success: true,
                message: 'Document imported successfully',
                savedPath: writeResult.savedPath,
                docName
            });
        } catch (err) {
            this._panel?.webview.postMessage({ type: 'importFullDocResult', error: String(err) });
        } finally {
            this._importInProgress = false;
        }
    }

    private async _handleFetchPageContent(workspaceRoot: string, sourceId: string, docId: string, pageId: string, requestId: number): Promise<void> {
        try {
            const adapter = this._researchImportService.getAdapter(sourceId);
            if (!adapter || !('fetchPageContent' in adapter)) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'Adapter does not support page content' });
                return;
            }

            const result = await (adapter as any).fetchPageContent(docId, pageId);
            if (result.success) {
                this._panel?.webview.postMessage({
                    type: 'previewReady',
                    sourceId,
                    requestId,
                    content: result.content,
                    docName: result.docName
                });
            } else {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: result.error || 'Failed to fetch page content' });
            }
        } catch (err) {
            this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: String(err) });
        }
    }

    private async _handleImportPlansFromClipboard(workspaceRoot: string): Promise<void> {
        // Delegate to the existing command that handles clipboard import
        await vscode.commands.executeCommand('switchboard.importPlanFromClipboard');
    }

    private async _handleImportResearchDoc(workspaceRoot: string, docTitle?: string, folderPath?: string): Promise<void> {
        if (this._importInProgress) {
            this._panel?.webview.postMessage({ type: 'importResearchDocResult', error: 'Import already in progress' });
            return;
        }

        this._importInProgress = true;
        try {
            const content = await vscode.env.clipboard.readText();

            if (!content || !content.trim()) {
                this._panel?.webview.postMessage({ type: 'importResearchDocResult', error: 'Clipboard is empty. Copy research markdown first.' });
                return;
            }
            if (content.length > 200_000) {
                this._panel?.webview.postMessage({ type: 'importResearchDocResult', error: 'Clipboard content is too large (>200 KB). Aborting import.' });
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
                { skipDesignDocLink: true, targetFolder: resolvedFolder ?? folderPath }
            );

            this._lastPanelWriteTimestamp = Date.now();

            if (writeResult.error) {
                this._panel?.webview.postMessage({ type: 'importResearchDocResult', error: writeResult.error });
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

            this._panel?.webview.postMessage({
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
            this._panel?.webview.postMessage({ type: 'importResearchDocResult', error: String(err) });
        } finally {
            this._importInProgress = false;
        }
    }

    private async _handleAirlockExport(workspaceRoot: string): Promise<{ success: boolean; message: string }> {
        try {
            const integrationDir = path.join(workspaceRoot, '.switchboard', 'NotebookLM');
            if (!fs.existsSync(integrationDir)) {
                fs.mkdirSync(integrationDir, { recursive: true });
            }

            // For now, return a success message. The actual bundling logic
            // can be implemented later by calling the appropriate service.
            return { success: true, message: 'NotebookLM folder ready. Export functionality coming soon.' };
        } catch (err) {
            return { success: false, message: `Failed to prepare NotebookLM folder: ${String(err)}` };
        }
    }

    // Sync methods for Planning Panel
    public async syncAllDocuments(workspaceRoot: string): Promise<void> {
        if (!this._cacheService) {
            this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
        }
        this._syncCancellationSource = new AbortController();
        const signal = this._syncCancellationSource.signal;
        this._currentSyncMode = 'auto-sync-all';

        const sources = this._researchImportService.getAvailableSources();
        
        for (const sourceId of sources) {
            if (signal.aborted || this._currentSyncMode !== 'auto-sync-all') { break; }
            
            const adapter = this._researchImportService.getAdapter(sourceId);
            if (!adapter) { continue; }
            
            try {
                // Use listFiles() to get all documents for this source
                const docs = await adapter.listFiles();
                
                for (const doc of docs) {
                    if (signal.aborted || this._currentSyncMode !== 'auto-sync-all') { break; }
                    
                    try {
                        let content = '';
                        let docName = doc.name;
                        
                        if ('fetchContent' in adapter) {
                            content = await adapter.fetchContent(doc.id);
                        } else if (sourceId === 'clickup' && 'fetchDocContent' in adapter) {
                            const result = await (adapter as any).fetchDocContent(doc.id);
                            if (result.success) {
                                content = result.content || '';
                                docName = result.docTitle || doc.name;
                            }
                        }
                        
                        await this._cacheService.cacheDocument(sourceId, doc.id, content, docName);
                    } catch (error) {
                        console.warn(`[PlanningPanel] Failed to cache ${sourceId}/${doc.id}:`, error);
                    }
                }
            } catch (error) {
                console.warn(`[PlanningPanel] Failed to list docs for ${sourceId}:`, error);
            }
        }
    }

    public async syncSelectedContainers(workspaceRoot: string, selectedContainers: string[]): Promise<void> {
        if (!this._cacheService) {
            this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
        }
        this._syncCancellationSource = new AbortController();
        const signal = this._syncCancellationSource.signal;
        this._currentSyncMode = 'sync-selected';

        for (const containerSpec of selectedContainers) {
            if (signal.aborted || this._currentSyncMode !== 'sync-selected') { break; }

            const [sourceId, containerId] = containerSpec.split(':');
            const adapter = this._researchImportService.getAdapter(sourceId);
            if (!adapter) continue;

            try {
                const docs = await adapter.listDocumentsByContainer(containerId);

                for (const doc of docs) {
                    if (signal.aborted || this._currentSyncMode !== 'sync-selected') { break; }

                    try {
                        let content = '';
                        let docName = doc.name;

                        if ('fetchContent' in adapter) {
                            content = await adapter.fetchContent(doc.id);
                        } else if (sourceId === 'clickup' && 'fetchDocContent' in adapter) {
                            const result = await (adapter as any).fetchDocContent(doc.id);
                            if (result.success) {
                                content = result.content || '';
                                docName = result.docTitle || doc.name;
                            }
                        }

                        await this._cacheService.cacheDocument(sourceId, doc.id, content, docName);
                    } catch (error) {
                        console.warn(`[PlanningPanel] Failed to cache ${sourceId}/${doc.id}:`, error);
                    }
                }
            } catch (error) {
                console.warn(`[PlanningPanel] Failed to sync container ${containerSpec}:`, error);
            }
        }
    }

    public startPeriodicSync(workspaceRoot: string, intervalMinutes: number = 30): void {
        this.stopPeriodicSync();

        const intervalMs = intervalMinutes * 60 * 1000;
        this._periodicSyncTimer = setInterval(async () => {
            try {
                const db = KanbanDatabase.forWorkspace(workspaceRoot);
                const mode = await db.getConfig('planning.syncMode') || 'no-sync';
                
                if (mode === 'auto-sync-all') {
                    await this.syncAllDocuments(workspaceRoot);
                } else if (mode === 'sync-selected') {
                    const selectedContainers = await db.getConfigJson<string[]>('planning.selectedContainers', []);
                    await this.syncSelectedContainers(workspaceRoot, selectedContainers);
                }
            } catch { /* no config yet */ }
        }, intervalMs);

        this._disposables.push({
            dispose: () => { this.stopPeriodicSync(); }
        });
    }

    public stopPeriodicSync(): void {
        if (this._periodicSyncTimer) {
            clearInterval(this._periodicSyncTimer);
            this._periodicSyncTimer = undefined;
        }
        this._syncCancellationSource?.abort();
        this._syncCancellationSource = undefined;
    }

    public async triggerSync(workspaceRoot: string, syncMode?: string): Promise<void> {
        this.stopPeriodicSync();

        // If no mode provided, read from unified config
        let mode: string = syncMode || 'no-sync';
        if (!syncMode) {
            const { config } = await this._resolveSyncConfig();
            mode = config.syncMode || 'no-sync';
        }

        this._currentSyncMode = mode;

        if (mode === 'auto-sync-all') {
            await this.syncAllDocuments(workspaceRoot);
            this.startPeriodicSync(workspaceRoot);
        } else if (mode === 'sync-selected') {
            // Use unified config discovery for selected containers
            const { configPath, config } = await this._resolveSyncConfig();
            if (configPath && Array.isArray(config.selectedContainers)) {
                await this.syncSelectedContainers(workspaceRoot, config.selectedContainers);
            }
            this.startPeriodicSync(workspaceRoot);
        }
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
                try {
                    const content = nfs.readFileSync(fullPath, 'utf8');
                    const fm = content.match(/^---\n([\s\S]*?)\n---/);
                    if (fm) { const km = fm[1].match(/kanbanColumn:\s*(.+)/); if (km) { kanbanColumn = km[1].trim(); } }
                    const h1 = content.match(/^#\s+(.+)$/m);
                    if (h1) { title = h1[1].trim(); }
                } catch { }
                out.push({ id, title, status: kanbanColumn || '', filePath: fullPath });
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

        const watchPaths: string[] = [];
        const clickup = GlobalIntegrationConfigService.loadConfigSync('clickup');
        if (clickup?.ticketSaveLocation) {
            watchPaths.push(path.join(clickup.ticketSaveLocation, '**/*.md'));
        }
        const linear = GlobalIntegrationConfigService.loadConfigSync('linear');
        if (linear?.ticketSaveLocation) {
            watchPaths.push(path.join(linear.ticketSaveLocation, '**/*.md'));
        }
        watchPaths.push(path.join(workspaceRoot, '.switchboard/tickets/**/*.md'));

        const handleTicketFileEvent = (uri: vscode.Uri) => {
            const fileName = path.basename(uri.fsPath);
            const match = fileName.match(/^(linear|clickup)_([^_]+)_.*\.md$/);
            if (!match) { return; }
            const [, provider, id] = match;

            const key = uri.fsPath;
            const existing = this._ticketsViewWatcherDebounces.get(key);
            if (existing) { clearTimeout(existing); }
            this._ticketsViewWatcherDebounces.set(key, setTimeout(() => {
                this._ticketsViewWatcherDebounces.delete(key);
                try {
                    const nfs = require('fs') as typeof import('fs');
                    const raw = nfs.readFileSync(uri.fsPath, 'utf8');
                    const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
                    const h1 = content.match(/^#\s+(.+)$/m);
                    const title = h1 ? h1[1].trim() : id;
                    this._panel?.webview.postMessage({ type: 'ticketFileChanged', provider, id, title, content });
                } catch { }
            }, 300));
        };

        const watchers = watchPaths.map(pattern => {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidCreate(handleTicketFileEvent);
            watcher.onDidChange(handleTicketFileEvent);
            watcher.onDidDelete(handleTicketFileEvent);
            return watcher;
        });

        const combined = vscode.Disposable.from(...watchers);
        this._ticketsViewWatcher = combined;
        this._disposables.push(combined);
    }

    private _updateTicketsAutoSyncWatcher(workspaceRoot: string, enabled: boolean): void {
        const existing = this._ticketsAutoSyncWatchers.get(workspaceRoot);
        if (!enabled) {
            if (existing) {
                try { existing.dispose(); } catch (e) {}
                this._ticketsAutoSyncWatchers.delete(workspaceRoot);
            }
            return;
        }
        if (existing) { return; } // already watching

        const watchPaths: string[] = [];
        const clickup = GlobalIntegrationConfigService.loadConfigSync('clickup');
        if (clickup?.ticketSaveLocation) {
            watchPaths.push(path.join(clickup.ticketSaveLocation, '**/*.md'));
        }
        const linear = GlobalIntegrationConfigService.loadConfigSync('linear');
        if (linear?.ticketSaveLocation) {
            watchPaths.push(path.join(linear.ticketSaveLocation, '**/*.md'));
        }
        watchPaths.push(path.join(workspaceRoot, '.switchboard/tickets/**/*.md'));

        const watchers = watchPaths.map(pattern => {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern, true, false, true);
            watcher.onDidChange(async (uri) => {
                const fileName = path.basename(uri.fsPath);
                const match = fileName.match(/^(linear|clickup)_([^_]+)_.*\.md$/);
                if (!match) { return; }
                const [, provider, id] = match;

                const debounceKey = uri.fsPath;
                const existing = this._ticketsAutoSyncDebounces.get(debounceKey);
                if (existing) { clearTimeout(existing); }
                this._ticketsAutoSyncDebounces.set(debounceKey, setTimeout(async () => {
                    this._ticketsAutoSyncDebounces.delete(debounceKey);
                    try {
                        const result: any = await vscode.commands.executeCommand(
                            'switchboard.pushTicketEdits',
                            { workspaceRoot, provider: provider as 'linear' | 'clickup', id }
                        );
                        this._panel?.webview.postMessage({
                            type: 'pushTicketResult',
                            success: result?.success ?? false,
                            id,
                            error: result?.error,
                            autoSync: true
                        });
                    } catch (e) {
                        this._panel?.webview.postMessage({
                            type: 'pushTicketResult',
                            success: false,
                            id,
                            error: e instanceof Error ? e.message : String(e),
                            autoSync: true
                        });
                    }
                }, 2000));
            });
            return watcher;
        });

        const combined = vscode.Disposable.from(...watchers);
        this._ticketsAutoSyncWatchers.set(workspaceRoot, combined);
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
        if (this._epicDocsWatchDebounce) {
            clearTimeout(this._epicDocsWatchDebounce);
            this._epicDocsWatchDebounce = undefined;
        }
        for (const watcher of this._epicDocsWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._epicDocsWatchers = [];
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
            this._disposables.push(
                this._projectPanel.onDidDispose(() => {
                    this._projectPanel = undefined;
                })
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
            vscode.workspace.getConfiguration('switchboard').get<number>('kanban.completedLimit', 100) ?? 100,
            500
        ));
        const completedRecords = await db.getCompletedPlans(workspaceId, completedLimit);
        const allRecords = [...records, ...completedRecords];
        
        const subtaskCountMap = new Map<string, number>();
        for (const r of allRecords) {
            if (r.epicId) {
                subtaskCountMap.set(r.epicId, (subtaskCountMap.get(r.epicId) || 0) + 1);
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
            isEpic: r.isEpic,
            epicId: r.epicId || '',
            subtaskCount: r.isEpic ? (subtaskCountMap.get(r.planId) || 0) : undefined,
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
            gatherer: false, ticket_updater: false, researcher: false,
            splitter: false, code_researcher: false, orchestrator: false
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
        if (!plans || plans.length === 0) {
            return allColumns.filter(col => {
                if (!col.hideWhenNoAgent) return true;
                if (col.role && visibleAgents[col.role] !== false) return true;
                return false;
            });
        }
        const occupiedColumns = new Set(plans.map(p => p.column));
        return allColumns.filter(col => {
            if (!col.hideWhenNoAgent) return true;
            if (col.role && visibleAgents[col.role] !== false) return true;
            if (occupiedColumns.has(col.id)) return true;
            return false;
        });
    }


}
