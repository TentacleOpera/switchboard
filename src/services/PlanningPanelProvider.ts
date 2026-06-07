import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fs from 'fs';
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
import { ReviewCommentRequest, ReviewCommentResult } from './ReviewProvider';


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
}

export class PlanningPanelProvider {
    private static readonly IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg']);
    private _panel: vscode.WebviewPanel | undefined;
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
    private _htmlFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _htmlDocsDebounce: NodeJS.Timeout | undefined;
    private _designFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _designDocsDebounce: NodeJS.Timeout | undefined;
    private _antigravityWatchers: vscode.FileSystemWatcher[] = [];
    private _activeDocWatcher: vscode.FileSystemWatcher | undefined;
    private _activeDocWatchDebounce: NodeJS.Timeout | undefined;
    private _kanbanPlansWatchers: vscode.FileSystemWatcher[] = [];
    private _kanbanPlansWatchDebounce: NodeJS.Timeout | undefined;
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

    private _resolvedConfigCache: {
        configPath: string | null;
        config: { syncMode?: string; browseFilterContainers?: Record<string, string>; selectedContainers?: string[] };
        sourceRoot: string;
    } | null = null;

    constructor(
        private _extensionUri: vscode.Uri,
        private _researchImportService: ResearchImportService,
        private _plannerPromptWriter: PlannerPromptWriter,
        private _getWorkspaceRoot: () => string | undefined,
        private _adapterFactories: PlanningPanelAdapterFactories,
        private _context: vscode.ExtensionContext
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
                        new NotionResearchAdapter(notionService, notionBrowseService)
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
        config: { syncMode?: string; browseFilterContainers?: Record<string, string>; selectedContainers?: string[] };
        sourceRoot: string;
    }> {
        // Return cached result if available (resolves race condition on repeated calls)
        if (this._resolvedConfigCache) {
            return this._resolvedConfigCache;
        }

        const allRoots = this._getWorkspaceRoots();
        const defaultConfig = { syncMode: 'no-sync', browseFilterContainers: {}, selectedContainers: [] as string[] };

        // Search all roots for config
        for (const root of allRoots) {
            const configPath = path.join(root, '.switchboard', 'planning-sync-config.json');
            try {
                const raw = await fs.promises.readFile(configPath, 'utf8');
                const config = JSON.parse(raw);
                console.log(`[PlanningPanel] Using sync config from: ${root}`);
                const result = { configPath, config, sourceRoot: root };
                this._resolvedConfigCache = result;
                return result;
            } catch (err) {
                // Config not found in this root, continue searching
                // Clarification: Only swallow ENOENT errors; log others for debugging
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    console.warn(`[PlanningPanel] Error reading config from ${root}:`, err);
                }
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

    public async open(): Promise<void> {
        // Force the next local-docs send to render (the dedup cache must not starve a
        // freshly revealed/created panel).
        this._lastLocalDocsSignature = '';
        this._lastPreviewContentByPath.clear();
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-planning',
            'ARTIFACTS',
            vscode.ViewColumn.One,
            {
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
            })
        );

        // Watch the docs directory for changes and refresh imported docs list
        this._setupDocsFolderWatcher(workspaceRoot);
        this._setupLocalFolderWatchers();
        this._setupHtmlFolderWatchers();
        this._setupDesignFolderWatchers();
        this._setupAntigravityWatcher();
        this._setupKanbanPlansWatcher();

        // Send initial active design doc state
        await this._sendActiveDesignDocState();
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

    private _setupHtmlFolderWatchers(): void {
        // Dispose and remove all existing watchers
        for (const watcher of this._htmlFolderWatchers) {
            watcher.dispose();
            const idx = this._disposables.indexOf(watcher);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
        }
        this._htmlFolderWatchers = [];

        const allRoots = this._getWorkspaceRoots();
        const watchedPaths = new Set<string>();

        for (const root of allRoots) {
            const localFolderService = this._getLocalFolderService(root);
            const folderPaths = localFolderService.getHtmlFolderPaths();

            for (const folderPath of folderPaths) {
                if (!folderPath) continue;
                // Deduplicate: skip if already watching this absolute path
                if (watchedPaths.has(folderPath)) continue;
                watchedPaths.add(folderPath);

                const folderUri = vscode.Uri.file(folderPath);

                // Create watcher for the local HTML folder — recursive, html/htm
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(folderUri, '**/*.{html,htm}')
                );

                // Refresh HTML docs when files are created, deleted, or changed
                const refreshHtmlDocs = () => {
                    this._sendHtmlDocsReady();
                };

                watcher.onDidCreate(refreshHtmlDocs);
                watcher.onDidDelete(refreshHtmlDocs);
                watcher.onDidChange(refreshHtmlDocs);

                this._htmlFolderWatchers.push(watcher);
                this._disposables.push(watcher);
            }
        }
    }

    private _setupDesignFolderWatchers(): void {
        // Dispose and remove all existing watchers
        for (const watcher of this._designFolderWatchers) {
            watcher.dispose();
            const idx = this._disposables.indexOf(watcher);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
        }
        this._designFolderWatchers = [];

        const allRoots = this._getWorkspaceRoots();
        const watchedPaths = new Set<string>();

        for (const root of allRoots) {
            const localFolderService = this._getLocalFolderService(root);
            const folderPaths = localFolderService.getDesignFolderPaths();

            for (const folderPath of folderPaths) {
                if (!folderPath) continue;
                // Deduplicate: skip if already watching this absolute path
                if (watchedPaths.has(folderPath)) continue;
                watchedPaths.add(folderPath);

                const folderUri = vscode.Uri.file(folderPath);

                // Create watcher for the local design folder
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(folderUri, '**/*.{md,txt,markdown,rst,adoc,png,jpg,jpeg,gif,svg}')
                );

                const refreshDesignDocs = () => {
                    this._sendDesignDocsReady();
                };

                watcher.onDidCreate(refreshDesignDocs);
                watcher.onDidDelete(refreshDesignDocs);
                watcher.onDidChange(refreshDesignDocs);

                this._designFolderWatchers.push(watcher);
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
                if (!this._panel) { return; }
                if (this._kanbanPlansWatchDebounce) {
                    clearTimeout(this._kanbanPlansWatchDebounce);
                }
                this._kanbanPlansWatchDebounce = setTimeout(() => {
                    this._kanbanPlansWatchDebounce = undefined;
                    if (!this._panel) { return; }
                    this._handleMessage({
                        type: 'fetchKanbanPlans',
                        requestId: Date.now()
                    }).catch(err => {
                        console.error('[PlanningPanel] Error auto-refreshing kanban plans:', err);
                    });
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
                false, // watch create
                false, // watch change
                true   // ignore delete (handled via onDidDelete)
            );

            // TODO: Keep onDidChange and onDidCreate refresh logic in sync
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

            // TODO: Keep onDidCreate and onDidChange refresh logic in sync
            this._activeDocWatcher.onDidCreate(() => {
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

                    console.log('[PlanningPanel] Auto-refreshing active document (create):', filePath);
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
        const allRoots = this._getWorkspaceRoots();
        const resolved = path.resolve(filePath);
        const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
        if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
            this._panel?.webview.postMessage({
                type: 'kanbanPlanPreviewReady', requestId,
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

            this._panel?.webview.postMessage({
                type: 'kanbanPlanPreviewReady', requestId, content,
                isAutoRefreshed: this._isAutoRefreshing
            });
        } catch (err) {
            this._panel?.webview.postMessage({
                type: 'kanbanPlanPreviewReady', requestId, content: '', error: String(err)
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

    private _mapClickUpTaskToSidebar(task: any): any {
        return {
            id: task.id,
            title: task.name,
            identifier: task.id,
            status: task.status?.status || 'Unknown',
            assignees: task.assignees || [],
            description: task.description?.trim() || 'No description provided.',
            markdownDescription: task.markdownDescription || '',
            list: task.list,
            url: task.url,
            parentId: task.parentId || task.parent || null
        };
    }

    private _mapClickUpComment(comment: any): any {
        return {
            id: comment.id,
            comment_text: comment.comment_text,
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
        let mappings: any[] = [];
        let enabled = false;
        try {
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();
            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                mappings = cfg.mappings;
                enabled = true;
            }
        } catch { /* ignore */ }

        const items: Array<{ label: string; workspaceRoot: string }> = [];
        const openRoots = this._getWorkspaceRoots();

        // Check if ANY of the currently open workspace folders is mapped
        let anyOpenFolderIsMapped = false;
        if (enabled && mappings.length > 0) {
            for (const root of openRoots) {
                const resolvedRoot = path.resolve(root);
                for (const m of mappings) {
                    const parent = m.parentFolder || (m as any).parentWorkspaceFolder
                        || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined);
                    if (parent) {
                        const expandedParent = parent.startsWith('~')
                            ? path.join(os.homedir(), parent.slice(1))
                            : parent;
                        if (path.resolve(expandedParent) === resolvedRoot) {
                            anyOpenFolderIsMapped = true;
                            break;
                        }
                    }
                    for (const wf of m.workspaceFolders || []) {
                        const expandedWf = wf.startsWith('~')
                            ? path.join(os.homedir(), wf.slice(1))
                            : wf;
                        if (path.resolve(expandedWf) === resolvedRoot) {
                            anyOpenFolderIsMapped = true;
                            break;
                        }
                    }
                    if (anyOpenFolderIsMapped) break;
                }
                if (anyOpenFolderIsMapped) break;
            }
        }

        if (enabled && mappings.length > 0 && anyOpenFolderIsMapped) {
            // Multi-root/mapped context: display the custom configured parent mapping names
            const addedRoots = new Set<string>();
            for (const m of mappings) {
                const parent = m.parentFolder || (m as any).parentWorkspaceFolder
                    || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined);
                if (parent) {
                    const expanded = parent.startsWith('~')
                        ? path.join(os.homedir(), parent.slice(1))
                        : parent;
                    const resolvedParent = path.resolve(expanded);
                    if (!addedRoots.has(resolvedParent)) {
                        addedRoots.add(resolvedParent);
                        items.push({
                            label: m.name || path.basename(resolvedParent),
                            workspaceRoot: resolvedParent
                        });
                    }
                }
            }
        } else {
            // Independent context or mappings disabled: display standard workspace folders
            for (const root of openRoots) {
                const resolvedRoot = path.resolve(root);
                const folder = (vscode.workspace.workspaceFolders || []).find(
                    f => path.resolve(f.uri.fsPath) === resolvedRoot
                );
                items.push({
                    label: folder ? folder.name : path.basename(resolvedRoot),
                    workspaceRoot: resolvedRoot
                });
            }
        }

        return items;
    }

    private async _handleMessage(msg: any): Promise<void> {
        const allRoots = this._getWorkspaceRoots();
        if (allRoots.length === 0) {
            this._panel?.webview.postMessage({ type: 'error', message: 'No workspace open' });
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
                await this._handleFetchRoots(true);

                // Send integration provider preference
                try {
                    const [clickUpConfig, linearConfig] = await Promise.all([
                        this._adapterFactories.getClickUpSyncService(workspaceRoot).loadConfig(),
                        this._adapterFactories.getLinearSyncService(workspaceRoot).loadConfig()
                    ]);
                    const provider = (clickUpConfig?.setupComplete) ? 'clickup'
                        : (linearConfig?.setupComplete) ? 'linear'
                        : null;
                    this._panel?.webview.postMessage({ type: 'integrationProviderPreference', provider, workspaceRoot });
                } catch (err) {
                    console.warn('[PlanningPanel] Failed to determine integration provider preference:', err);
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
                    if (!targetConfigPath) {
                        const allRoots = this._getWorkspaceRoots();
                        if (allRoots.length === 0) { break; }
                        targetRoot = allRoots[0];
                        targetConfigPath = path.join(targetRoot, '.switchboard', 'planning-sync-config.json');
                        console.log(`[PlanningPanel] Creating new config in: ${targetRoot}`);
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

                    await fs.promises.mkdir(path.dirname(targetConfigPath), { recursive: true });
                    await fs.promises.writeFile(targetConfigPath, JSON.stringify(config, null, 2), 'utf8');

                    // Update cache to reflect new state
                    this._resolvedConfigCache = {
                        configPath: targetConfigPath,
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
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add Docs Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(workspaceRoot);
                    await service.addFolderPath(result[0].fsPath);
                    this._setupLocalFolderWatchers();
                    await this._sendLocalDocsReady();
                }
                break;
            }
            case 'removeLocalFolder': {
                const service = this._getLocalFolderService(workspaceRoot);
                await service.removeFolderPath(msg.folderPath);
                this._setupLocalFolderWatchers();
                await this._sendLocalDocsReady();
                break;
            }
            case 'listLocalFolders': {
                const service = this._getLocalFolderService(workspaceRoot);
                const paths = service.getFolderPaths();
                this._panel?.webview.postMessage({ type: 'localFoldersListed', paths });
                break;
            }
            case 'addHtmlFolder': {
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add HTML Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(workspaceRoot);
                    await service.addHtmlFolderPath(result[0].fsPath);
                    this._setupHtmlFolderWatchers();
                    await this._sendHtmlDocsReady();
                }
                break;
            }
            case 'removeHtmlFolder': {
                const service = this._getLocalFolderService(workspaceRoot);
                await service.removeHtmlFolderPath(msg.folderPath);
                this._setupHtmlFolderWatchers();
                await this._sendHtmlDocsReady();
                break;
            }
            case 'listHtmlFolders': {
                const service = this._getLocalFolderService(workspaceRoot);
                const paths = service.getHtmlFolderPaths();
                this._panel?.webview.postMessage({ type: 'htmlFoldersListed', paths });
                break;
            }
            case 'addDesignFolder': {
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add Design Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(workspaceRoot);
                    await service.addDesignFolderPath(result[0].fsPath);
                    this._setupDesignFolderWatchers();
                    await this._sendDesignDocsReady();
                }
                break;
            }
            case 'removeDesignFolder': {
                const service = this._getLocalFolderService(workspaceRoot);
                await service.removeDesignFolderPath(msg.folderPath);
                this._setupDesignFolderWatchers();
                await this._sendDesignDocsReady();
                break;
            }
            case 'listDesignFolders': {
                const service = this._getLocalFolderService(workspaceRoot);
                const paths = service.getDesignFolderPaths();
                this._panel?.webview.postMessage({ type: 'designFoldersListed', paths });
                break;
            }
            case 'refreshSource': {
                const sourceId = msg.sourceId;
                // Clear cache for this source to force fresh fetch
                await this._cacheService?.clearSourceCache(sourceId);
                // Refresh only the affected pane to avoid cross-pane flicker
                if (sourceId === 'local-folder') {
                    await this._sendLocalDocsReady(true);
                } else if (sourceId === 'html-folder') {
                    await this._sendHtmlDocsReady();
                } else if (sourceId === 'design-folder') {
                    await this._sendDesignDocsReady();
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
            case 'importResearchDoc': {
                await this._handleImportResearchDoc(workspaceRoot, msg.docTitle, msg.folderPath);
                break;
            }
            case 'airlock_export': {
                const result = await this._handleAirlockExport(workspaceRoot);
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
                const folderUri = vscode.Uri.file(path.join(workspaceRoot, '.switchboard', 'integration'));
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
                const confirm = await vscode.window.showWarningMessage(
                    `Move "${docName}" to trash?`,
                    { modal: true },
                    'Move to Trash'
                );
                if (confirm !== 'Move to Trash') {
                    break;
                }
                const service = this._getLocalFolderService(docRoot);
                const result = await service.deleteFile(docId, sourceFolder);
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
            case 'deleteImportedDoc': {
                const slugPrefix = msg.slugPrefix;
                const docName = msg.docName || slugPrefix;
                const confirm = await vscode.window.showWarningMessage(
                    `Delete "${docName}" from local docs?`,
                    { modal: true },
                    'Delete'
                );
                if (confirm !== 'Delete') {
                    break;
                }
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
            case 'checkAnalystAvailability': {
                try {
                    const result = await vscode.commands.executeCommand<{ available: boolean }>(
                        'switchboard.checkAnalystAvailability'
                    );
                    this._panel?.webview.postMessage({
                        type: 'analystAvailabilityResult',
                        available: result?.available ?? false
                    });
                } catch (err) {
                    this._panel?.webview.postMessage({
                        type: 'analystAvailabilityResult',
                        available: false
                    });
                }
                break;
            }
            case 'sendToAnalyst': {
                const prompt = msg.prompt;
                if (!prompt) {
                    this._panel?.webview.postMessage({
                        type: 'sendToAnalystResult',
                        success: false,
                        error: 'No prompt provided'
                    });
                    break;
                }

                try {
                    const result = await vscode.commands.executeCommand<{ success: boolean; error?: string }>(
                        'switchboard.sendToAnalystFromPlanningPanel',
                        prompt
                    );
                    this._panel?.webview.postMessage({
                        type: 'sendToAnalystResult',
                        success: result?.success ?? false,
                        error: result?.error
                    });
                } catch (err) {
                    this._panel?.webview.postMessage({
                        type: 'sendToAnalystResult',
                        success: false,
                        error: String(err)
                    });
                }
                break;
            }
            case 'draftResearchPrompt': {
                const { topic, context, depth } = msg;
                if (!topic) {
                    this._panel?.webview.postMessage({
                        type: 'draftResearchPromptResult',
                        success: false,
                        error: 'No topic provided'
                    });
                    break;
                }
                try {
                    // Build the analyst prompt via the prompt builder
                    const { buildKanbanBatchPrompt } = require('./agentPromptBuilder');
                    const analystPrompt = buildKanbanBatchPrompt('analyst', [], {
                        instruction: 'draft-research-prompt',
                        researchTopic: topic,
                        researchContext: context || '',
                        researchDepth: depth || 'standard',
                        switchboardSafeguardsEnabled: false
                    });
                    const result = await vscode.commands.executeCommand<{ success: boolean; error?: string }>(
                        'switchboard.sendToAnalystFromPlanningPanel',
                        analystPrompt
                    );
                    this._panel?.webview.postMessage({
                        type: 'draftResearchPromptResult',
                        success: result?.success ?? false,
                        error: result?.error
                    });
                } catch (err) {
                    this._panel?.webview.postMessage({
                        type: 'draftResearchPromptResult',
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
                    const allRoots = this._getWorkspaceRoots();
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
                            const { KanbanDatabase } = require('./KanbanDatabase');
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
                    this._panel?.webview.postMessage({
                        type: 'kanbanPlansReady',
                        plans: allPlans,
                        workspaceItems,
                        allWorkspaceProjects,
                        columns: mergedColumns,
                        requestId
                    });
                } catch (err) {
                    if (requestId === this._latestRequestIds.get(guardKey)) {
                        this._panel?.webview.postMessage({ type: 'kanbanPlansReady', plans: [], columns: [], requestId, error: String(err) });
                    }
                }
                break;
            }
            case 'openKanbanPlan': {
                const filePath: string = msg.filePath || '';
                const resolved = path.resolve(filePath);
                const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
                if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
                    this._panel?.webview.postMessage({ type: 'kanbanPlanOpenResult', success: false, error: 'File not found or not in workspace' });
                    break;
                }
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                    this._panel?.webview.postMessage({ type: 'kanbanPlanOpenResult', success: true });
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'kanbanPlanOpenResult', success: false, error: String(err) });
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
                const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
                if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
                    this._panel?.webview.postMessage({ type: 'kanbanContextSet', success: false, error: 'File not found or not in workspace' });
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
                    this._panel?.webview.postMessage({ type: 'kanbanContextSet', success: true });
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'kanbanContextSet', success: false, error: String(err) });
                }
                break;
            }
            case 'copyKanbanPlanPrompt': {
                const sessionId = String(msg.sessionId || '');
                const column = String(msg.column || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!sessionId) {
                    this._panel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId' });
                    break;
                }
                try {
                    const success = await vscode.commands.executeCommand<boolean>(
                        'switchboard.copyPlanFromKanban', sessionId, column, wsRoot
                    );
                    this._panel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: !!success, sessionId });
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
                }
                break;
            }
            case 'moveKanbanPlanColumn': {
                const planFile = String(msg.planFile || '');
                const newColumn = String(msg.newColumn || '');
                const wsRoot = String(msg.workspaceRoot || workspaceRoot);
                if (!planFile || !newColumn) {
                    this._panel?.webview.postMessage({ type: 'kanbanPlanColumnChanged', success: false, error: 'Missing planFile or newColumn' });
                    break;
                }
                try {
                    const moved = await vscode.commands.executeCommand<boolean>(
                        'switchboard.moveKanbanCardByPlanFile', wsRoot, planFile, newColumn
                    );
                    this._panel?.webview.postMessage({ type: 'kanbanPlanColumnChanged', success: !!moved, error: moved ? undefined : 'Column update failed' });
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'kanbanPlanColumnChanged', success: false, error: String(err) });
                }
                break;
            }
            case 'saveFileContent': {
                const filePath = String(msg.filePath || '');
                const content = String(msg.content || '');
                const originalContent = String(msg.originalContent || '');
                const tab = String(msg.tab || '');
                const allRoots = this._getWorkspaceRoots();
                const resolved = path.resolve(filePath);
                let isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
                if (!isAllowed) {
                    for (const r of allRoots) {
                        try {
                            const service = this._getLocalFolderService(r);
                            const designPaths = service.getDesignFolderPaths();
                            if (designPaths.some(dp => resolved.startsWith(path.resolve(dp)))) {
                                isAllowed = true;
                                break;
                            }
                        } catch (err) {}
                    }
                }
                if (!filePath || !isAllowed) {
                    this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: false, error: 'Invalid file path', tab });
                    break;
                }
                try {
                    // Conflict detection: compare disk content with original
                    let diskContent = '';
                    if (fs.existsSync(resolved)) {
                        diskContent = await fs.promises.readFile(resolved, 'utf8');
                    }
                    if (originalContent && diskContent !== originalContent) {
                        this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: false, conflict: true, diskContent, tab });
                        break;
                    }

                    // Validate JSON/YAML before write
                    const saveExt = path.extname(resolved).toLowerCase();
                    if (saveExt === '.json') {
                        try { JSON.parse(content); }
                        catch (e: any) {
                            this._panel?.webview.postMessage({
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
                            this._panel?.webview.postMessage({
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
                    this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: true, tab });
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: false, error: String(err), tab });
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
                        message: 'No workspace open.'
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
                        message: 'Set up Linear in Setup before using the Project tab.'
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
                        projectName
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
                        type: 'linearError',
                        scope: 'project',
                        error: error instanceof Error ? error.message : String(error)
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
                        message: 'No workspace open.'
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
                        message: 'Set up Linear in Setup before using the Project tab.'
                    });
                    break;
                }

                try {
                    const projects = await linear.getAvailableProjects();
                    this._panel?.webview.postMessage({
                        type: 'linearProjectsLoaded',
                        status: 'loaded',
                        projects
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
                        type: 'linearError',
                        scope: 'project',
                        error: error instanceof Error ? error.message : String(error)
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
                        error: 'Select a Linear issue first.'
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
                            error: `Linear issue ${issueId} was not found.`
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
                        renderedDescriptionHtml
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: error instanceof Error ? error.message : String(error)
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
                        error: 'No workspace folder found'
                    });
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const spaces = await clickUp.getSpaces();
                    this._panel?.webview.postMessage({
                        type: 'clickupSpacesLoaded',
                        spaces
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: error instanceof Error ? error.message : 'Failed to load Spaces'
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
                        error: 'No workspace folder found'
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
                        directLists: await clickUp.getLists(msg.spaceId)
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: error instanceof Error ? error.message : 'Failed to load Folders'
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
                        error: 'No workspace folder found'
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
                        lists
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: error instanceof Error ? error.message : 'Failed to load Lists'
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
                        loadSeq
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
                        loadSeq
                    });
                    break;
                }

                const listId = msg.listId || config.selectedListId;
                if (!listId) {
                    this._panel?.webview.postMessage({
                        type: 'clickupProjectLoaded',
                        status: 'setup-required',
                        message: 'No list selected. Please select a Space, Folder, and List to view tasks.',
                        loadSeq
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
                        tasks: tasks.map(t => this._mapClickUpTaskToSidebar(t)),
                        listName: config.selectedListName || 'Unknown List',
                        loadSeq
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
                        type: 'clickupError',
                        scope: 'project',
                        error: error instanceof Error ? error.message : 'Failed to load ClickUp project',
                        loadSeq
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
                        error: 'No workspace folder found'
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
                        subtasks: details.subtasks.map(s => this._mapClickUpTaskToSidebar(s)),
                        comments: details.comments.map(c => this._mapClickUpComment(c)),
                        attachments: details.attachments.map(a => this._mapClickUpAttachment(a)),
                        renderedDescriptionHtml
                    });
                } catch (error) {
                    this._panel?.webview.postMessage({
                        type: 'clickupError',
                        scope: 'task',
                        taskId: msg.taskId,
                        error: error instanceof Error ? error.message : 'Failed to load task details'
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
                        config.selectedFolderId = '';
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
                        config.selectedFolderId = String(msg.folderId || '').trim();
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

                if (!workspaceRoot || !issueId) {
                    this._panel?.webview.postMessage({
                        type: 'linearTaskImported',
                        success: false,
                        error: 'Missing workspace or issue ID'
                    });
                    break;
                }

                try {
                    const result = await vscode.commands.executeCommand(
                        'switchboard.importLinearTask',
                        { workspaceRoot, issueId, includeSubtasks }
                    );
                    this._panel?.webview.postMessage({
                        type: 'linearTaskImported',
                        success: true
                    });
                } catch (error) {
                    console.error('[PlanningPanel] Failed to import Linear task:', error);
                    this._panel?.webview.postMessage({
                        type: 'linearTaskImported',
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
                break;
            }
            case 'clickupImportTask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const taskId = String(msg.taskId || '').trim();
                const includeSubtasks = Boolean(msg.includeSubtasks);

                if (!workspaceRoot || !taskId) {
                    this._panel?.webview.postMessage({
                        type: 'clickupTaskImported',
                        success: false,
                        error: 'Missing workspace or task ID'
                    });
                    break;
                }

                try {
                    const result = await vscode.commands.executeCommand(
                        'switchboard.importClickUpTask',
                        { workspaceRoot, taskId, includeSubtasks }
                    );
                    this._panel?.webview.postMessage({
                        type: 'clickupTaskImported',
                        success: true
                    });
                } catch (error) {
                    console.error('[PlanningPanel] Failed to import ClickUp task:', error);
                    this._panel?.webview.postMessage({
                        type: 'clickupTaskImported',
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
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
                enabled: true,
                docName: this._getDesignDocName(),
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

            if (sourceId === 'local-folder' || sourceId === 'design-folder') {
                if (!sourceFolder) {
                    throw new Error('sourceFolder is required');
                }
                const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, sourceId)
                    || this._getLocalFolderService(workspaceRoot);
                const resolvedSourceFolder = localFolderService.resolveFolderPath(sourceFolder);
                const allowedPaths = sourceId === 'design-folder' ? localFolderService.getDesignFolderPaths() : localFolderService.getFolderPaths();
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

            if (sourceId === 'local-folder' || sourceId === 'design-folder') {
                if (!sourceFolder) {
                    throw new Error('sourceFolder is required');
                }
                const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, sourceId)
                    || this._getLocalFolderService(workspaceRoot);
                const resolvedSourceFolder = localFolderService.resolveFolderPath(sourceFolder);
                const allowedPaths = sourceId === 'design-folder' ? localFolderService.getDesignFolderPaths() : localFolderService.getFolderPaths();
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

    private _getDesignDocName(): string | null {
        const config = vscode.workspace.getConfiguration('switchboard');
        const designDocLink = config.get<string>('planner.designDocLink');
        if (!designDocLink) return null;
        return path.basename(designDocLink, '.md');
    }

    private async _sendActiveDesignDocState(): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard');
        const enabled = config.get<boolean>('planner.designDocEnabled', false);
        const docName = enabled ? this._getDesignDocName() : null;
        this._panel?.webview.postMessage({
            type: 'activeDesignDocUpdated',
            enabled,
            docName: docName || 'None',
            sourceId: this._activeDesignDocSourceId,
            docId: this._activeDesignDocId
        });
    }

    private _updateWebviewRoots(): void {
        if (!this._panel) { return; }
        const allRoots = this._getWorkspaceRoots();
        const folderUris: vscode.Uri[] = [];
        for (const r of allRoots) {
            try {
                const service = this._getLocalFolderService(r);
                for (const p of service.getDesignFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
                for (const p of service.getHtmlFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
                for (const p of service.getFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
            } catch (err) {}
        }

        const localResourceRoots = [
            vscode.Uri.joinPath(this._extensionUri, 'dist'),
            vscode.Uri.joinPath(this._extensionUri, 'webview'),
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

        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots
        };
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
        sourceId: 'local-folder' | 'html-folder' | 'design-folder' = 'local-folder'
    ): LocalFolderService | null {
        if (!sourceFolder) { return null; }
        const allRoots = this._getWorkspaceRoots();
        const activeRoot = this._getWorkspaceRoot();

        // Try active root first (matches existing priority logic)
        if (activeRoot) {
            const service = this._getLocalFolderService(activeRoot);
            const paths = sourceId === 'html-folder'
                ? service.getHtmlFolderPaths()
                : (sourceId === 'design-folder' ? service.getDesignFolderPaths() : service.getFolderPaths());
            const resolved = service.resolveFolderPath(sourceFolder);
            if (paths.includes(resolved)) {
                return service;
            }
        }

        // Fall back to scanning all roots
        for (const root of allRoots) {
            if (activeRoot && path.resolve(root) === path.resolve(activeRoot)) continue; // already tried
            const service = this._getLocalFolderService(root);
            const paths = sourceId === 'html-folder'
                ? service.getHtmlFolderPaths()
                : (sourceId === 'design-folder' ? service.getDesignFolderPaths() : service.getFolderPaths());
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
            let configuredFolderPaths: string[] = []; // Track configured folder paths for webview

            // Compute configured folder paths using the first root (global settings)
            // With global settings, all roots return the same paths, so use first root
            const configRoot = allRoots.length > 0 ? allRoots[0] : activeRoot;
            if (configRoot) {
                const configService = this._getLocalFolderService(configRoot);
                configuredFolderPaths = configService.getFolderPaths();
            }

            const seenFilePaths = new Set<string>(); // Deduplicate files across roots

            for (const root of allRoots) {
                try {
                    const localFolderService = this._getLocalFolderService(root);
                    const folderPaths = localFolderService.getFolderPaths();

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
                folderPaths: configuredFolderPaths,
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
                folderPaths: configuredFolderPaths,
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
                folderPaths: [],
                nodes: [],
                workspaceItems: this._buildKanbanWorkspaceItems(),
                error: String(err)
            });
        }
    }

    private async _sendHtmlDocsReady(): Promise<void> {
        if (this._htmlDocsDebounce) {
            clearTimeout(this._htmlDocsDebounce);
        }
        this._htmlDocsDebounce = setTimeout(async () => {
            this._htmlDocsDebounce = undefined;
            try {
                const allRoots = this._getWorkspaceRoots();
                const allFiles: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string; _root?: string; sourceFolder?: string; title?: string }> = [];
                const scannedPaths = new Set<string>();
                const activeRoot = this._getWorkspaceRoot();
                let configuredFolderPaths: string[] = [];

                // Compute configured HTML folder paths using the first root (global settings)
                const configRoot = allRoots.length > 0 ? allRoots[0] : activeRoot;
                if (configRoot) {
                    const configService = this._getLocalFolderService(configRoot);
                    configuredFolderPaths = configService.getHtmlFolderPaths();
                }

                const seenFilePaths = new Set<string>();

                for (const root of allRoots) {
                    try {
                        const localFolderService = this._getLocalFolderService(root);
                        const folderPaths = localFolderService.getHtmlFolderPaths();

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
                            const files = await localFolderService.listHtmlFiles();
                            for (const f of files) {
                                const absPath = path.resolve(f.sourceFolder, f.relativePath);
                                if (!seenFilePaths.has(absPath)) {
                                    seenFilePaths.add(absPath);
                                    allFiles.push({ ...f, _root: root });
                                }
                            }
                        }
                    } catch (err) {
                        console.debug('[PlanningPanel] Failed to list HTML files for root:', root, err);
                    }
                }

                if (!this._panel) {
                    return;
                }

                // Update webview localResourceRoots — use _updateWebviewRoots() which
                // has a dedup check to avoid unnecessary webview reloads (assigning
                // webview.options unconditionally reloads the webview, resetting the
                // DOM to "Loading…" placeholders and triggering the stuck-on-loading bug).
                this._updateWebviewRoots();

                const workspaceItems = this._buildKanbanWorkspaceItems();
                this._panel.webview.postMessage({
                    type: 'htmlDocsReady',
                    sourceId: 'html-folder',
                    folderPaths: configuredFolderPaths,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems
                });
            } catch (err) {
                console.error('[PlanningPanel] Failed to fetch html-folder roots:', err);
                this._panel?.webview.postMessage({
                    type: 'htmlDocsReady',
                    sourceId: 'html-folder',
                    folderPaths: [],
                    nodes: [],
                    workspaceItems: this._buildKanbanWorkspaceItems(),
                    error: String(err)
                });
            }
        }, 300);
    }

    private async _sendDesignDocsReady(): Promise<void> {
        if (this._designDocsDebounce) {
            clearTimeout(this._designDocsDebounce);
        }
        this._designDocsDebounce = setTimeout(async () => {
            this._designDocsDebounce = undefined;
            try {
                const allRoots = this._getWorkspaceRoots();
                const allFiles: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string; _root?: string; sourceFolder?: string; title?: string }> = [];
                const scannedPaths = new Set<string>();
                const activeRoot = this._getWorkspaceRoot();
                let configuredFolderPaths: string[] = [];

                // Compute configured design folder paths using the first root (global settings)
                const configRoot = allRoots.length > 0 ? allRoots[0] : activeRoot;
                if (configRoot) {
                    const configService = this._getLocalFolderService(configRoot);
                    configuredFolderPaths = configService.getDesignFolderPaths();
                }

                const seenFilePaths = new Set<string>();

                for (const root of allRoots) {
                    try {
                        const localFolderService = this._getLocalFolderService(root);
                        const folderPaths = localFolderService.getDesignFolderPaths();

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
                            const files = await localFolderService.listDesignFiles();
                            for (const f of files) {
                                const absPath = path.resolve(f.sourceFolder, f.relativePath);
                                if (!seenFilePaths.has(absPath)) {
                                    seenFilePaths.add(absPath);
                                    allFiles.push({ ...f, _root: root });
                                }
                            }
                        }
                    } catch (err) {
                        console.debug('[PlanningPanel] Failed to list design files for root:', root, err);
                    }
                }

                if (!this._panel) {
                    return;
                }

                // Update webview options localResourceRoots
                this._updateWebviewRoots();

                const workspaceItems = this._buildKanbanWorkspaceItems();
                this._panel.webview.postMessage({
                    type: 'designDocsReady',
                    sourceId: 'design-folder',
                    folderPaths: configuredFolderPaths,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems
                });
            } catch (err) {
                console.error('[PlanningPanel] Failed to fetch design-folder roots:', err);
                this._panel?.webview.postMessage({
                    type: 'designDocsReady',
                    sourceId: 'design-folder',
                    folderPaths: [],
                    nodes: [],
                    workspaceItems: this._buildKanbanWorkspaceItems(),
                    error: String(err)
                });
            }
        }, 300);
    }

    private async _sendOnlineDocsReady(): Promise<void> {
        const availableSources = this._researchImportService.getAvailableSources();
        console.log('[PlanningPanel] Available sources before filtering:', availableSources);

        const roots = availableSources
            .filter(sourceId => sourceId !== 'local-folder')
            .map(sourceId => ({ sourceId, nodes: [] as TreeNode[] }));

        // Load saved browse filter containers from unified config
        const { config } = await this._resolveSyncConfig();
        const browseFilterContainers = config.browseFilterContainers || {};

        if (!this._panel) { throw new Error('[PlanningPanel] _panel is undefined — cannot send onlineDocsReady'); }
        console.log('[PlanningPanel] Sending onlineDocsReady, roots count:', roots.length, 'roots:', roots);
        this._panel.webview.postMessage({
            type: 'onlineDocsReady',
            roots,
            enabledSources: {
                clickup: true,
                linear: true,
                notion: true
            },
            browseFilterContainers
        });
    }

    private async _handleFetchRoots(forceLocalDocs: boolean = false): Promise<void> {
        await this._sendLocalDocsReady(forceLocalDocs);
        await this._sendHtmlDocsReady();
        await this._sendDesignDocsReady();
        await this._sendOnlineDocsReady();
        const cyberAnimationDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
        this._panel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled: cyberAnimationDisabled });
        const currentTheme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
        this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
    }

    private async _handleFetchChildren(workspaceRoot: string, sourceId: string, parentId?: string): Promise<void> {
        // Handle local-folder, design-folder, html-folder directly without adapter
        if (sourceId === 'local-folder' || sourceId === 'design-folder' || sourceId === 'html-folder') {
            const localFolderService = this._getLocalFolderService(workspaceRoot);
            try {
                const files = sourceId === 'local-folder'
                    ? await localFolderService.listFiles()
                    : (sourceId === 'design-folder' ? await localFolderService.listDesignFiles() : await localFolderService.listHtmlFiles());
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

        // Handle html-folder directly
        if (sourceId === 'html-folder') {
            if (!sourceFolder) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'sourceFolder is required' });
                return;
            }
            // Validate sourceFolder is a configured HTML folder
            const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, 'html-folder')
                || this._getLocalFolderService(workspaceRoot);
            const resolvedSourceFolder = localFolderService.resolveFolderPath(sourceFolder);
            if (!localFolderService.getHtmlFolderPaths().includes(resolvedSourceFolder)) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'sourceFolder is not a configured HTML folder path' });
                return;
            }
            const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
            const resolvedPath = path.resolve(path.join(resolvedSourceFolder, cleanDocId));
            // Prevent path traversal
            if (!resolvedPath.startsWith(path.resolve(resolvedSourceFolder) + path.sep) && resolvedPath !== path.resolve(resolvedSourceFolder)) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'Invalid file path' });
                return;
            }
            if (!fs.existsSync(resolvedPath)) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'File not found' });
                return;
            }
            if (!this._panel) { return; }
            const webviewUri = this._panel.webview.asWebviewUri(vscode.Uri.file(resolvedPath)).toString();
            this._activePreviewPath = resolvedPath;
            this._activePreviewSourceId = 'html-folder';
            this._activePreviewDocId = docId;
            this._activePreviewSourceFolder = sourceFolder;
            this._activePreviewWorkspaceRoot = workspaceRoot;
            this._setupActiveDocWatcher(resolvedPath);

            const fileExt = path.extname(resolvedPath).toLowerCase();
            const isImage = PlanningPanelProvider.IMAGE_EXTENSIONS.has(fileExt);

            if (isImage) {
                // Skip UTF-8 read for binary image files
                this._panel?.webview.postMessage({
                    type: 'previewReady',
                    sourceId,
                    requestId,
                    webviewUri,
                    docName: path.basename(resolvedPath),
                    isImage: true,
                    isAutoRefreshed: this._isAutoRefreshing
                });
                return;
            }

            try {
                const htmlContent = await fs.promises.readFile(resolvedPath, 'utf8');

                // Dedup: compare raw content before CSP injection (nonce may rotate)
                const cacheKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
                const lastContent = this._lastPreviewContentByPath.get(cacheKey);
                if (htmlContent === lastContent) {
                    // Cache hit — notify frontend for user-initiated requests only
                    // (auto-refresh dedup is preserved to prevent flicker)
                    if (requestId >= 0) {
                        this._panel?.webview.postMessage({
                            type: 'previewReady',
                            sourceId,
                            requestId,
                            webviewUri,
                            docName: path.basename(resolvedPath),
                            isAutoRefreshed: false
                        });
                    }
                    return;
                }
                this._lastPreviewContentByPath.set(cacheKey, htmlContent);

                const htmlWithCsp = this._injectLocalCsp(htmlContent);
                console.log('[PlanningPanel] HTML preview: nonce injected:', !!this._nonce, 'content length:', htmlWithCsp.length, 'hasNonceAttr:', /nonce="/.test(htmlWithCsp));
                this._panel?.webview.postMessage({
                    type: 'previewReady',
                    sourceId,
                    requestId,
                    webviewUri,
                    htmlContent: htmlWithCsp,
                    docName: path.basename(resolvedPath),
                    isAutoRefreshed: this._isAutoRefreshing
                });
            } catch (err: any) {
                // If file read fails, fall back to webviewUri-only delivery
                this._panel?.webview.postMessage({
                    type: 'previewReady',
                    sourceId,
                    requestId,
                    webviewUri,
                    docName: path.basename(resolvedPath),
                    isAutoRefreshed: this._isAutoRefreshing
                });
            }
            return;
        }

        // Handle design-folder directly
        if (sourceId === 'design-folder') {
            if (!sourceFolder) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'sourceFolder is required' });
                return;
            }
            // Validate sourceFolder is a configured Design folder
            const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, 'design-folder')
                || this._getLocalFolderService(workspaceRoot);
            const resolvedSourceFolder = localFolderService.resolveFolderPath(sourceFolder);
            if (!localFolderService.getDesignFolderPaths().includes(resolvedSourceFolder)) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'sourceFolder is not a configured Design folder path' });
                return;
            }
            const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
            const resolvedPath = path.resolve(path.join(resolvedSourceFolder, cleanDocId));
            // Prevent path traversal
            if (!resolvedPath.startsWith(path.resolve(resolvedSourceFolder) + path.sep) && resolvedPath !== path.resolve(resolvedSourceFolder)) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'Invalid file path' });
                return;
            }
            if (!fs.existsSync(resolvedPath)) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'File not found' });
                return;
            }
            if (!this._panel) { return; }
            const webviewUri = this._panel.webview.asWebviewUri(vscode.Uri.file(resolvedPath)).toString();
            this._activePreviewPath = resolvedPath;
            this._activePreviewSourceId = 'design-folder';
            this._activePreviewDocId = docId;
            this._activePreviewSourceFolder = sourceFolder;
            this._activePreviewWorkspaceRoot = workspaceRoot;
            this._setupActiveDocWatcher(resolvedPath);

            const fileExt = path.extname(resolvedPath).toLowerCase();
            const isImage = PlanningPanelProvider.IMAGE_EXTENSIONS.has(fileExt);

            if (isImage) {
                // Skip UTF-8 read for binary image files
                this._panel?.webview.postMessage({
                    type: 'previewReady',
                    sourceId,
                    requestId,
                    webviewUri,
                    docName: path.basename(resolvedPath),
                    isImage: true,
                    isAutoRefreshed: this._isAutoRefreshing
                });
                return;
            }

            try {
                const docContent = await fs.promises.readFile(resolvedPath, 'utf8');

                // Map extension to a preview category
                // Unmapped extensions default to 'text'
                const fileTypeMap: Record<string, string> = {
                    '.json': 'json',
                    '.css': 'css', '.scss': 'css', '.less': 'css', '.sass': 'css',
                    '.yaml': 'yaml', '.yml': 'yaml',
                    '.xml': 'xml',
                    '.md': 'markdown', '.txt': 'markdown', '.markdown': 'markdown',
                    '.rst': 'markdown', '.adoc': 'markdown',
                };
                const fileType = isImage ? 'image' : (fileTypeMap[fileExt] || 'text');

                // For YAML: parse on backend and send parsed result to frontend
                let parsedJson: any = undefined;
                if (fileType === 'yaml') {
                    try {
                        const yaml = require('js-yaml');
                        parsedJson = yaml.load(docContent);
                    } catch (e: any) {
                        // Will be handled as error on frontend — send raw content only
                    }
                }

                const cacheKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
                const lastContent = this._lastPreviewContentByPath.get(cacheKey);
                if (docContent === lastContent) {
                    // Cache hit — notify frontend for user-initiated requests only
                    if (requestId >= 0) {
                        this._panel?.webview.postMessage({
                            type: 'previewReady',
                            sourceId,
                            requestId,
                            webviewUri,
                            content: docContent,
                            docName: path.basename(resolvedPath),
                            fileType,
                            parsedJson,
                            isAutoRefreshed: false,
                            filePath: resolvedPath
                        });
                    }
                    return;
                }
                this._lastPreviewContentByPath.set(cacheKey, docContent);

                this._panel?.webview.postMessage({
                    type: 'previewReady',
                    sourceId,
                    requestId,
                    webviewUri,
                    content: docContent,
                    docName: path.basename(resolvedPath),
                    fileType,
                    parsedJson,
                    isAutoRefreshed: this._isAutoRefreshing,
                    filePath: resolvedPath
                });
            } catch (err: any) {
                this._panel?.webview.postMessage({
                    type: 'previewError',
                    sourceId,
                    requestId,
                    error: String(err)
                });
            }
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
            } else if (sourceId === 'design-folder' && !finalContent) {
                if (!sourceFolder) {
                    throw new Error('sourceFolder is required');
                }
                const localFolderService = this._getLocalFolderServiceForFolder(sourceFolder, workspaceRoot, 'design-folder')
                    || this._getLocalFolderService(workspaceRoot);
                const resolvedSourceFolder = localFolderService.resolveFolderPath(sourceFolder);
                if (!localFolderService.getDesignFolderPaths().includes(resolvedSourceFolder)) {
                    throw new Error('sourceFolder is not a configured Design folder path');
                }
                const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
                const resolvedPath = path.resolve(path.join(resolvedSourceFolder, cleanDocId));
                if (!resolvedPath.startsWith(path.resolve(resolvedSourceFolder) + path.sep) && resolvedPath !== path.resolve(resolvedSourceFolder)) {
                    throw new Error('Invalid file path');
                }
                finalContent = await fs.promises.readFile(resolvedPath, 'utf8');
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
            const { KanbanDatabase } = require('./KanbanDatabase');
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
                this._panel?.webview.postMessage({ type: 'importFullDocResult', success: true, message: 'Document imported' });
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
                        message: `Imported ${importedCount} pages (${errorCount} errors)`
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
                message: 'Document imported successfully'
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

            const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
                workspaceRoot,
                content,
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
            const integrationDir = path.join(workspaceRoot, '.switchboard', 'integration');
            if (!fs.existsSync(integrationDir)) {
                fs.mkdirSync(integrationDir, { recursive: true });
            }

            // For now, return a success message. The actual bundling logic
            // can be implemented later by calling the appropriate service.
            return { success: true, message: 'Integration folder ready. Export functionality coming soon.' };
        } catch (err) {
            return { success: false, message: `Failed to prepare integration: ${String(err)}` };
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
            const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
            try {
                const raw = await fs.promises.readFile(configPath, 'utf8');
                const config = JSON.parse(raw);
                const mode = config.syncMode || 'no-sync';
                
                if (mode === 'auto-sync-all') {
                    await this.syncAllDocuments(workspaceRoot);
                } else if (mode === 'sync-selected' && Array.isArray(config.selectedContainers)) {
                    await this.syncSelectedContainers(workspaceRoot, config.selectedContainers);
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
        for (const watcher of this._htmlFolderWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._htmlFolderWatchers = [];
        for (const watcher of this._designFolderWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._designFolderWatchers = [];
        if (this._localDocsDebounce) {
            clearTimeout(this._localDocsDebounce);
            this._localDocsDebounce = undefined;
        }
        if (this._htmlDocsDebounce) {
            clearTimeout(this._htmlDocsDebounce);
            this._htmlDocsDebounce = undefined;
        }
        if (this._designDocsDebounce) {
            clearTimeout(this._designDocsDebounce);
            this._designDocsDebounce = undefined;
        }
        if (this._kanbanPlansWatchDebounce) {
            clearTimeout(this._kanbanPlansWatchDebounce);
            this._kanbanPlansWatchDebounce = undefined;
        }
        for (const watcher of this._kanbanPlansWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._kanbanPlansWatchers = [];
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
        if (this._panel) {
            this._panel.dispose();
            this._panel = undefined;
        }
    }

    private async _getKanbanPlans(workspaceRoot: string): Promise<KanbanPlanSummary[]> {
        const { KanbanDatabase } = require('./KanbanDatabase');
        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        const workspaceId = await this._getWorkspaceId(workspaceRoot);
        const records = await db.getBoard(workspaceId);

        // Resolve to the effective (mapped parent) root so that plan.workspaceRoot
        // matches the workspaceItems dropdown values sent to the webview.
        const effectiveRoot = this._resolveEffectiveWorkspaceRoot(workspaceRoot);

        // Derive the label from _buildKanbanWorkspaceItems() so it uses the
        // configured mapping name (not the raw VSCode folder name).
        const wsLabel = this._buildKanbanWorkspaceItems().find(
            item => item.workspaceRoot === effectiveRoot
        )?.label || path.basename(effectiveRoot);

        return records.map((r: any) => ({
            planId: r.planId,
            sessionId: r.sessionId || '',
            topic: r.topic || path.basename(r.planFile || '') || 'Untitled',
            column: r.kanbanColumn,
            workspaceRoot: effectiveRoot,
            workspaceLabel: wsLabel,
            project: r.project || '',
            repoScope: r.repoScope || '',
            mtime: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
            planFile: r.planFile || ''
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
