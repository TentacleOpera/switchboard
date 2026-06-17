import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { stateFs as fs } from './stateConfigBridge';
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
import { buildKanbanColumns, KanbanColumnDefinition, CustomKanbanColumnConfig, CustomAgentConfig, parseCustomAgents } from './agentConfig';
import { ReviewCommentRequest, ReviewCommentResult } from './reviewTypes';
import { isValidComplexityValue, legacyToScore } from './complexityScale';
import { formatReviewLogEntries } from './reviewLogUtils';
import { PanelStateStore } from './PanelStateStore';
import { buildWorkspaceItems } from './workspaceUtils';

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
    private _ticketsAutoSyncWatchers: Map<string, vscode.FileSystemWatcher> = new Map();
    private _ticketsViewWatcher: vscode.FileSystemWatcher | undefined;
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
    private _watcherGeneration: number = 0;
    private _activeDesignDocSourceId: string | null = null;
    private _activeDesignDocId: string | null = null;
    private _activeTicketsProvider = new Map<string, 'clickup' | 'linear'>();
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

        console.log('[PlanningPanel] Registering adapters for roots:', allRoots);

        // Clear existing adapters to avoid duplicates from previous registrations
        this._researchImportService.clearAdapters();

        for (const workspaceRoot of allRoots) {
            // Notion
            try {
                const notionService = this._adapterFactories.getNotionService?.(workspaceRoot);
                const notionBrowseService = this._adapterFactories.getNotionBrowseService?.(workspaceRoot);
                if (notionService && notionBrowseService) {
                    this._researchImportService.registerAdapter(
                        new NotionResearchAdapter(workspaceRoot, notionService, notionBrowseService)
                    );
                    console.log('[PlanningPanel] Registered Notion adapter for:', workspaceRoot);
                }
            } catch (err) {
                // Clarification: Log at debug level for visibility without console spam
                console.debug('[PlanningPanel] Notion config not found or invalid for root:', workspaceRoot, err);
            }

            // Linear
            try {
                const linearAdapter = this._adapterFactories.getLinearDocsAdapter?.(workspaceRoot);
                if (linearAdapter) {
                    this._researchImportService.registerAdapter(linearAdapter);
                    console.log('[PlanningPanel] Registered Linear adapter for:', workspaceRoot);
                }
            } catch (err) {
                console.debug('[PlanningPanel] Linear config not found or invalid for root:', workspaceRoot, err);
            }

            // ClickUp
            try {
                const clickUpAdapter = this._adapterFactories.getClickUpDocsAdapter?.(workspaceRoot);
                if (clickUpAdapter) {
                    this._researchImportService.registerAdapter(clickUpAdapter);
                    console.log('[PlanningPanel] Registered ClickUp adapter for:', workspaceRoot);
                }
            } catch (err) {
                console.debug('[PlanningPanel] ClickUp config not found or invalid for root:', workspaceRoot, err);
            }
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

        const poppinsSemiboldFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'Poppins-SemiBold.woff2')
        );
        htmlContent = htmlContent.replace(/\{\{POPPINS_SEMIBOLD_FONT_URI\}\}/g, poppinsSemiboldFontUri.toString());

        const poppinsBoldFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'Poppins-Bold.woff2')
        );
        htmlContent = htmlContent.replace(/\{\{POPPINS_BOLD_FONT_URI\}\}/g, poppinsBoldFontUri.toString());

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
                this._panel?.webview.postMessage({
                    type: 'workspaceItemsUpdated',
                    items: buildWorkspaceItems(this._getWorkspaceRoots())
                });
            })
        );

        // Watch the docs directory for changes and refresh imported docs list
        this._setupDocsFolderWatcher(workspaceRoot);
        this._setupLocalFolderWatchers();

        this._setupAntigravityWatcher();
        this._setupKanbanPlansWatcher();

        // Send initial active design doc state
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
                    
                    const workspaceRoot = this._activePreviewWorkspaceRoot
                        || this._getWorkspaceRoot()
                        || (this._getWorkspaceRoots().length > 0 ? this._getWorkspaceRoots()[0] : undefined);
                    if (!workspaceRoot) return;

                    console.log('[PlanningPanel] Auto-refreshing active document:', filePath);
                    this._isAutoRefreshing = true;
                    try {
                        if (this._activePreviewSourceId === 'local-folder' || this._activePreviewSourceId === 'html-folder') {
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

        const poppinsSemiboldFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'Poppins-SemiBold.woff2')
        );
        htmlContent = htmlContent.replace(/\{\{POPPINS_SEMIBOLD_FONT_URI\}\}/g, poppinsSemiboldFontUri.toString());

        const poppinsBoldFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'Poppins-Bold.woff2')
        );
        htmlContent = htmlContent.replace(/\{\{POPPINS_BOLD_FONT_URI\}\}/g, poppinsBoldFontUri.toString());

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

    private _getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    }

    private async _getIntegrationWorkspaces(): Promise<Array<{ workspaceRoot: string; provider: 'clickup' | 'linear' }>> {
        const allRoots = this._getWorkspaceRoots();
        const allowedRoots = new Set(buildWorkspaceItems(allRoots).map(item => item.workspaceRoot));
        const results: Array<{ workspaceRoot: string; provider: 'clickup' | 'linear' }> = [];
        for (const root of allRoots) {
            if (!allowedRoots.has(root)) {
                continue;
            }
            try {
                const [clickUpConfig, linearConfig] = await Promise.all([
                    this._adapterFactories.getClickUpSyncService(root).loadConfig(),
                    this._adapterFactories.getLinearSyncService(root).loadConfig()
                ]);
                const provider = (clickUpConfig?.setupComplete) ? 'clickup'
                    : (linearConfig?.setupComplete) ? 'linear'
                    : null;
                if (provider) {
                    results.push({ workspaceRoot: root, provider });
                }
            } catch {
                // Config unreadable — skip this root
            }
        }
        return results;
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
        let baseDir = path.join(resolvedRoot, '.switchboard', 'tickets');
        try {
            const localFolderService = new LocalFolderService(resolvedRoot);
            const ticketsFolders = localFolderService.getTicketsFolderPaths();
            if (ticketsFolders.length > 0 && ticketsFolders[0]) {
                baseDir = ticketsFolders[0];
            }
        } catch { /* use default baseDir */ }

        try {
            if (provider === 'clickup') {
                const clickUp = this._adapterFactories.getClickUpSyncService(resolvedRoot);
                const h = clickUp.getSelectedHierarchy();
                const parts = [baseDir, 'clickup', this._slugify(h.spaceName).slice(0, 60)];
                if (h.folderName) {
                    parts.push(this._slugify(h.folderName).slice(0, 60));
                }
                parts.push(this._slugify(h.listName).slice(0, 60));
                return [path.join(...parts)];
            } else if (provider === 'linear') {
                const linear = this._adapterFactories.getLinearSyncService(resolvedRoot);
                const teamName = linear.getTeamName();
                const projectName = linear.getSelectedProjectName() || '_no-project';
                return [path.join(
                    baseDir,
                    'linear',
                    this._slugify(teamName).slice(0, 60),
                    this._slugify(projectName).slice(0, 60)
                )];
            }
        } catch { /* use flat provider dir */ }

        const providerDir = provider === 'clickup' ? 'clickup' : 'linear';
        return [path.join(baseDir, providerDir)];
    }

    // Resolve a ticket's real on-disk file path by scanning for its
    // `${provider}_${id}_` prefix. Mirrors TaskViewerProvider._findTicketDocument:
    // tickets import into nested folder hierarchies that can't be reconstructed
    // from live space/folder/list names, so we scan rather than build a flat path.
    private _findTicketFilePath(resolvedRoot: string, provider: string, id: string): string | null {
        const prefix = `${provider}_${id}_`;
        const baseDirs: string[] = [];
        try {
            const localFolderService = new LocalFolderService(resolvedRoot);
            for (const f of localFolderService.getTicketsFolderPaths()) {
                if (f) { baseDirs.push(path.join(f, provider)); }
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
        return {
            id: comment.id,
            body: comment.comment_text,
            user: comment.user,
            date: comment.date
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
                    let activeProvider = this._activeTicketsProvider.get(workspaceRoot);
                    if (!activeProvider) {
                        if (clickupSetupComplete && linearSetupComplete) {
                            activeProvider = 'clickup';
                        } else if (clickupSetupComplete) {
                            activeProvider = 'clickup';
                        } else if (linearSetupComplete) {
                            activeProvider = 'linear';
                        }
                        if (activeProvider) {
                            this._activeTicketsProvider.set(workspaceRoot, activeProvider);
                        }
                    }
                    const provider = activeProvider || null;
                    const localService = this._getLocalFolderService(workspaceRoot);
                    const ticketsAutoSync = localService.getTicketsAutoSync();
                    if (provider) { this._updateTicketsAutoSyncWatcher(workspaceRoot, ticketsAutoSync); }
                    this._panel?.webview.postMessage({
                        type: 'integrationProviderStates',
                        clickupSetupComplete,
                        linearSetupComplete,
                        provider,
                        workspaceRoot,
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
                const integrationWorkspaces = await this._getIntegrationWorkspaces();
                let defaultRoot: string | undefined;
                let defaultProvider: 'clickup' | 'linear' | null = null;

                // Prefer restored root if it still has a valid integration
                if (restoredRoot && integrationWorkspaces.some(w => w.workspaceRoot === restoredRoot)) {
                    defaultRoot = restoredRoot;
                    defaultProvider = integrationWorkspaces.find(w => w.workspaceRoot === restoredRoot)!.provider;
                }

                // Fall back to first integration workspace
                if (!defaultRoot && integrationWorkspaces.length > 0) {
                    defaultRoot = integrationWorkspaces[0].workspaceRoot;
                    defaultProvider = integrationWorkspaces[0].provider;
                }

                // Final fallback: restored root or first root (provider null)
                if (!defaultRoot) {
                    defaultRoot = (restoredRoot && allRoots.includes(restoredRoot)) ? restoredRoot : allRoots[0];
                }

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
                        let activeProvider = this._activeTicketsProvider.get(root);
                        if (!activeProvider) {
                            if (clickupSetupComplete && linearSetupComplete) {
                                activeProvider = 'clickup';
                            } else if (clickupSetupComplete) {
                                activeProvider = 'clickup';
                            } else if (linearSetupComplete) {
                                activeProvider = 'linear';
                            }
                            if (activeProvider) {
                                this._activeTicketsProvider.set(root, activeProvider);
                            }
                        }
                        const provider = activeProvider || null;
                        const localService = this._getLocalFolderService(root);
                        const ticketsAutoSync = localService.getTicketsAutoSync();
                        if (provider) { this._updateTicketsAutoSyncWatcher(root, ticketsAutoSync); }
                        this._setupTicketsViewWatcher(root);
                        this._panel?.webview.postMessage({
                            type: 'integrationProviderStates',
                            clickupSetupComplete,
                            linearSetupComplete,
                            provider,
                            workspaceRoot: root,
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
                    this._activeTicketsProvider.set(workspaceRoot, provider);
                    try {
                        const [clickUpConfig, linearConfig] = await Promise.all([
                            this._adapterFactories.getClickUpSyncService(workspaceRoot).loadConfig(),
                            this._adapterFactories.getLinearSyncService(workspaceRoot).loadConfig()
                        ]);
                        const clickupSetupComplete = clickUpConfig?.setupComplete === true;
                        const linearSetupComplete = linearConfig?.setupComplete === true;
                        const localService = this._getLocalFolderService(workspaceRoot);
                        const ticketsAutoSync = localService.getTicketsAutoSync();
                        if (provider) { this._updateTicketsAutoSyncWatcher(workspaceRoot, ticketsAutoSync); }
                        this._panel?.webview.postMessage({
                            type: 'integrationProviderStates',
                            clickupSetupComplete,
                            linearSetupComplete,
                            provider,
                            workspaceRoot,
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

            case 'refreshSource': {
                const sourceId = msg.sourceId;
                // Clear cache for this source to force fresh fetch
                await this._cacheService?.clearSourceCache(sourceId);
                // Refresh only the affected pane to avoid cross-pane flicker
                if (sourceId === 'local-folder') {
                    await this._sendLocalDocsReady(true);

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
                    if (requestId !== this._latestRequestIds.get(guardKey)) { break; }
                    allPlans.sort((a, b) => b.mtime - a.mtime);
                    mergedColumns.sort((a, b) => a.order - b.order);
                    this._projectPanel?.webview.postMessage({
                        type: 'kanbanPlansReady',
                        plans: allPlans,
                        workspaceItems,
                        allWorkspaceProjects,
                        columns: mergedColumns,
                        requestId
                    });
                } catch (err) {
                    if (requestId === this._latestRequestIds.get(guardKey)) {
                        this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: [], columns: [], requestId, error: String(err) });
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
            case 'updateEpicConfig': {
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!wsRoot) break;
                try {
                    const db = KanbanDatabase.forWorkspace(wsRoot);
                    if (msg.epicLockColumns !== undefined) await db.setConfig('epic_lock_columns', String(msg.epicLockColumns));
                    if (msg.epicPromptTemplate !== undefined) await db.setConfig('epic_prompt_template', String(msg.epicPromptTemplate));
                    if (msg.epicMaxSubtasks !== undefined) await db.setConfig('epic_max_subtasks', String(msg.epicMaxSubtasks));
                } catch (err) {
                    console.error('[PlanningPanelProvider] updateEpicConfig failed:', err);
                }
                break;
            }
            case 'loadConstitutionFiles': {
                const workspaceItems = buildWorkspaceItems(allRoots);
                const workspaces = workspaceItems.map(ws => {
                    const constitutionPath = path.join(ws.workspaceRoot, 'CONSTITUTION.md');
                    return {
                        label: ws.label,
                        workspaceRoot: ws.workspaceRoot,
                        hasConstitution: fs.existsSync(constitutionPath)
                    };
                });
                this._projectPanel?.webview.postMessage({
                    type: 'constitutionFilesLoaded',
                    workspaces
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
                const filePath = path.join(wr, 'CONSTITUTION.md');
                const exists = fs.existsSync(filePath);
                const globalSettingsEnabled = this._context.globalState.get<boolean>('switchboard.globalSettingsEnabled', true);
                const store = globalSettingsEnabled ? this._context.globalState : this._context.workspaceState;
                const plannerConfig = store.get<any>('switchboard.prompts.roleConfig_planner', undefined);
                const cfgDefault = vscode.workspace.getConfiguration('switchboard').get<boolean>('planner.constitutionEnabled', false);
                const enabled = plannerConfig?.addons?.constitution ?? cfgDefault;
                let status = 'None';
                if (enabled && exists) { status = 'CONSTITUTION.md'; }
                else if (enabled) { status = 'File not found'; }
                else { status = 'Disabled'; }
                this._projectPanel?.webview.postMessage({ type: 'constitutionStatus', status, planFile: msg.planFile });
                break;
            }
            case 'readConstitutionFile': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) {
                    this._projectPanel?.webview.postMessage({
                        type: 'constitutionFileRead',
                        workspaceRoot: wsRoot,
                        exists: false,
                        error: 'Invalid workspace root'
                    });
                    break;
                }
                const filePath = path.join(wsRoot, 'CONSTITUTION.md');
                if (fs.existsSync(filePath)) {
                    try {
                        const content = fs.readFileSync(filePath, 'utf8');
                        const renderedHtml = await vscode.commands.executeCommand<string>('markdown.api.render', content);
                        this._projectPanel?.webview.postMessage({
                            type: 'constitutionFileRead',
                            workspaceRoot: wsRoot,
                            filePath,
                            exists: true,
                            content,
                            renderedHtml
                        });
                    } catch (err) {
                        this._projectPanel?.webview.postMessage({
                            type: 'constitutionFileRead',
                            workspaceRoot: wsRoot,
                            exists: false,
                            error: String(err)
                        });
                    }
                } else {
                    this._projectPanel?.webview.postMessage({
                        type: 'constitutionFileRead',
                        workspaceRoot: wsRoot,
                        exists: false
                    });
                }
                break;
            }
            case 'saveConstitutionFile': {
                const wsRoot = msg.workspaceRoot;
                const content = msg.content;
                if (!allRoots.includes(wsRoot)) {
                    this._projectPanel?.webview.postMessage({
                        type: 'fileSaved',
                        success: false,
                        error: 'Invalid workspace root',
                        tab: 'constitution'
                    });
                    break;
                }
                const filePath = path.join(wsRoot, 'CONSTITUTION.md');
                try {
                    fs.writeFileSync(filePath, content, 'utf8');
                    this._projectPanel?.webview.postMessage({
                        type: 'fileSaved',
                        success: true,
                        tab: 'constitution'
                    });
                } catch (err) {
                    this._projectPanel?.webview.postMessage({
                        type: 'fileSaved',
                        success: false,
                        error: String(err),
                        tab: 'constitution'
                    });
                }
                break;
            }
            case 'invokeConstitutionBuilder': {
                const wsRoot = msg.workspaceRoot;
                if (!allRoots.includes(wsRoot)) {
                    break;
                }
                const terminal = vscode.window.terminals.find(t => t.name.toLowerCase().includes('planner') || t.name.toLowerCase().includes('lead'))
                    || vscode.window.createTerminal({ name: 'Constitution Builder', cwd: wsRoot });
                terminal.show();
                const promptText = `Follow instructions in .agent/skills/constitution_builder.md to build or improve CONSTITUTION.md in this project.`;
                const { sendRobustText } = require('./terminalUtils');
                await sendRobustText(terminal, promptText);
                break;
            }
            case 'saveFileContent': {
                const filePath = String(msg.filePath || '');
                const content = String(msg.content || '');
                const originalContent = String(msg.originalContent || '');
                const tab = String(msg.tab || '');
                const allRoots = this._getWorkspaceRoots();
                const saveDestPanel = (tab === 'kanban' || tab === 'constitution') ? this._projectPanel : this._panel;
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
                    saveDestPanel?.webview.postMessage({ type: 'saveFileContentResult', success: true, tab });
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
                let baseDir = path.join(workspaceRoot, '.switchboard', 'tickets');
                try {
                    const lfs = new LocalFolderService(workspaceRoot);
                    const folders = lfs.getTicketsFolderPaths();
                    if (folders.length > 0 && folders[0]) { baseDir = folders[0]; }
                } catch { }
                const filePath = this._findLocalTicketFile(path.join(baseDir, provider), provider, id);
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
            case 'openLocalTicket': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider;
                const id = msg.id;

                if (workspaceRoot) {
                    for (const dir of this._getTicketDocumentDirs(workspaceRoot, provider)) {
                        if (!fs.existsSync(dir)) { continue; }
                        let files: string[] = [];
                        try { files = fs.readdirSync(dir); } catch { continue; }
                        const match = files.find(f => f.startsWith(`${provider}_${id}_`));
                        if (match) {
                            const filePath = path.join(dir, match);
                            await vscode.env.clipboard.writeText(filePath);
                            break;
                        }
                    }
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
                let baseDir = path.join(workspaceRoot, '.switchboard', 'tickets');
                try {
                    const lfs = new LocalFolderService(workspaceRoot);
                    const folders = lfs.getTicketsFolderPaths();
                    if (folders.length > 0 && folders[0]) { baseDir = folders[0]; }
                } catch { }
                const providerDir = path.join(baseDir, provider);
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
                                this._scanLocalTicketFiles(providerDir, provider, scannedTickets);

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
                    this._scanLocalTicketFiles(providerDir, provider, tickets);
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
                let baseDir = path.join(workspaceRoot, '.switchboard', 'tickets');
                try {
                    const lfs = new LocalFolderService(workspaceRoot);
                    const folders = lfs.getTicketsFolderPaths();
                    if (folders.length > 0 && folders[0]) { baseDir = folders[0]; }
                } catch { }
                const filePath = this._findLocalTicketFile(path.join(baseDir, provider), provider, id);
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
                if (workspaceRoot) {
                    if (Array.isArray(msg.ticketIds) && msg.ticketIds.length > 0) {
                        const providerDir = provider === 'clickup' ? 'clickup' : 'linear';
                        for (const id of msg.ticketIds) {
                            if (typeof id === 'string' && id && !id.includes('/') && !id.includes('\\') && !id.includes('..')) {
                                // Ticket files are named `${provider}_${id}_<slug>.md` and live in
                                // nested hierarchies (team/project/sprint), so resolve the real path
                                // by prefix scan rather than reconstructing a flat path.
                                const filePath = this._findTicketFilePath(workspaceRoot, providerDir, id);
                                if (filePath) { paths.push(filePath); }
                            }
                        }
                    } else {
                        for (const dir of this._getTicketDocumentDirs(workspaceRoot, provider)) {
                            if (!fs.existsSync(dir)) { continue; }
                            paths.push(dir);
                        }
                    }
                }
                await vscode.env.clipboard.writeText(paths.join('\n'));
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
                const { provider, id, comment } = msg;
                try {
                    const result: any = await vscode.commands.executeCommand(
                        'switchboard.postTicketComment',
                        { workspaceRoot, provider, id, comment }
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
                    const task = await clickUp.createTask({
                        name: msg.title,
                        listId: msg.listId,
                        description: msg.description
                    });
                    if (task) {
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
                        projectId
                    });
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
            case 'linearRefineTask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                const title = String(msg.title || '').trim();
                const description = String(msg.description || '').trim();

                if (!workspaceRoot || !issueId) {
                    this._panel?.webview.postMessage({
                        type: 'linearTaskRefined',
                        success: false,
                        error: 'Missing workspace or issue ID'
                    });
                    break;
                }

                try {
                    const result = await vscode.commands.executeCommand(
                        'switchboard.refineTask',
                        { workspaceRoot, id: issueId, title, description, provider: 'linear' }
                    );
                    this._panel?.webview.postMessage({
                        type: 'linearTaskRefined',
                        success: true
                    });
                } catch (error) {
                    console.error('[PlanningPanel] Failed to refine Linear task:', error);
                    this._panel?.webview.postMessage({
                        type: 'linearTaskRefined',
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
                break;
            }
            case 'clickupRefineTask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const taskId = String(msg.taskId || '').trim();
                const title = String(msg.title || '').trim();
                const description = String(msg.description || '').trim();

                if (!workspaceRoot || !taskId) {
                    this._panel?.webview.postMessage({
                        type: 'clickupTaskRefined',
                        success: false,
                        error: 'Missing workspace or task ID'
                    });
                    break;
                }

                try {
                    const result = await vscode.commands.executeCommand(
                        'switchboard.refineTask',
                        { workspaceRoot, id: taskId, title, description, provider: 'clickup' }
                    );
                    this._panel?.webview.postMessage({
                        type: 'clickupTaskRefined',
                        success: true
                    });
                } catch (error) {
                    console.error('[PlanningPanel] Failed to refine ClickUp task:', error);
                    this._panel?.webview.postMessage({
                        type: 'clickupTaskRefined',
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
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

            await vscode.env.clipboard.writeText(docPath);
            vscode.window.showInformationMessage(`Document path copied to clipboard: ${docPath}`);
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
            this._projectPanel.webview.options = {
                enableScripts: true,
                localResourceRoots
            };
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
                ...(f.sourceFolder && f.relativePath ? { absolutePath: path.resolve(f.sourceFolder, f.relativePath) } : {})
            }
        }));
    }

    private async _sendLocalDocsReady(force: boolean = false): Promise<void> {
        try {
            const allRoots = this._getWorkspaceRoots();
            const allFiles: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string; _root?: string; sourceFolder?: string; title?: string }> = [];
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
                    ticketsFolderPathsByRoot[root] = localFolderService.getTicketsFolderPaths();

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
            .map(a => ({ sourceId: a.sourceId, workspaceRoot: a.workspaceRoot || '', nodes: [] as TreeNode[] }));

        // Load saved browse filter containers from unified config
        const { config } = await this._resolveSyncConfig();
        const browseFilterContainers = config.browseFilterContainers || {};

        if (!this._panel) { throw new Error('[PlanningPanel] _panel is undefined — cannot send onlineDocsReady'); }
        console.log('[PlanningPanel] Sending onlineDocsReady, roots count:', roots.length, 'roots:', roots);
        const enabledSources: Record<string, boolean> = {};
        availableSources.forEach(s => {
            if (s !== 'local-folder') {
                enabledSources[s] = true;
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
                            lastSyncedAt: entry.lastSyncedAt || entry.importedAt
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

            const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
                workspaceRoot,
                contentToWrite,
                finalDocTitle,
                'research-clipboard',
                { skipDesignDocLink: true, targetFolder: folderPath }
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
                    const workspaceId = await this._getWorkspaceId(workspaceRoot);
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
                docTitle: finalDocTitle 
            });

            await this._handleFetchImportedDocs(workspaceRoot);
            await this._sendLocalDocsReady();

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

        const localService = this._getLocalFolderService(workspaceRoot);
        const ticketsFolder = localService.getTicketsFolderPath?.() || undefined;
        const watchGlob = ticketsFolder
            ? new vscode.RelativePattern(ticketsFolder, '**/*.md')
            : new vscode.RelativePattern(workspaceRoot, '.switchboard/tickets/**/*.md');

        const watcher = vscode.workspace.createFileSystemWatcher(watchGlob, true, false, true);
        watcher.onDidChange((uri) => {
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
        });

        this._ticketsViewWatcher = watcher;
        this._disposables.push(watcher);
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

        const localService = this._getLocalFolderService(workspaceRoot);
        const ticketsFolder = localService.getTicketsFolderPath();
        const watchGlob = ticketsFolder
            ? new vscode.RelativePattern(ticketsFolder, '**/*.md')
            : new vscode.RelativePattern(workspaceRoot, '.switchboard/tickets/**/*.md');

        const watcher = vscode.workspace.createFileSystemWatcher(watchGlob, true, false, true);
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
        this._ticketsAutoSyncWatchers.set(workspaceRoot, watcher);
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
        if (this._kanbanPlansWatchDebounce) {
            clearTimeout(this._kanbanPlansWatchDebounce);
            this._kanbanPlansWatchDebounce = undefined;
        }
        for (const watcher of this._kanbanPlansWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._kanbanPlansWatchers = [];
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
            epicId: r.epicId || ''
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
            splitter: false, code_researcher: false
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
