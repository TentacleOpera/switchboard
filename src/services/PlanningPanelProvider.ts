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
import { buildKanbanColumns, KanbanColumnDefinition, CustomKanbanColumnConfig, CustomAgentConfig } from './agentConfig';
import { ReviewCommentRequest, ReviewCommentResult } from './ReviewProvider';


export interface PlanningPanelAdapterFactories {
    getNotionService: (root: string) => NotionFetchService;
    getNotionBrowseService: (root: string) => NotionBrowseService;
    getLinearDocsAdapter: (root: string) => LinearDocsAdapter;
    getClickUpDocsAdapter: (root: string) => ClickUpDocsAdapter;
    getCacheService: (root: string) => PlanningPanelCacheService;
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
    private _antigravityWatcher: vscode.FileSystemWatcher | undefined;
    private _activeDocWatcher: vscode.FileSystemWatcher | undefined;
    private _activeDocWatchDebounce: NodeJS.Timeout | undefined;
    private _kanbanPlansWatchers: vscode.FileSystemWatcher[] = [];
    private _kanbanPlansWatchDebounce: NodeJS.Timeout | undefined;
    private _lastPanelWriteTimestamp: number = 0;
    private _isAutoRefreshing: boolean = false;
    private _activePreviewPath: string | null = null;
    private _activePreviewSourceId: string | null = null;
    private _activePreviewDocId: string | null = null;
    private _activePreviewSourceFolder: string | null = null;
    private _watcherGeneration: number = 0;

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
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-planning',
            'ARTIFACTS',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this._extensionUri, 'dist'),
                    vscode.Uri.joinPath(this._extensionUri, 'webview'),
                    vscode.Uri.joinPath(this._extensionUri, 'node_modules')
                ]
            }
        );

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

                // Refresh local docs when files are created, deleted, or changed
                const refreshLocalDocs = () => {
                    this._sendLocalDocsReady();
                };

                watcher.onDidCreate(refreshLocalDocs);
                watcher.onDidDelete(refreshLocalDocs);
                watcher.onDidChange(refreshLocalDocs);

                this._localFolderWatchers.push(watcher);
                this._disposables.push(watcher);
            }
        }
    }

    private _setupAntigravityWatcher(): void {
        // Dispose existing
        if (this._antigravityWatcher) {
            this._antigravityWatcher.dispose();
            const idx = this._disposables.indexOf(this._antigravityWatcher);
            if (idx !== -1) { this._disposables.splice(idx, 1); }
            this._antigravityWatcher = undefined;
        }

        const config = vscode.workspace.getConfiguration('switchboard');
        const enabled = config.get<boolean>('research.antigravityBrainEnabled', false);
        if (!enabled) { return; }

        const allRoots = this._getWorkspaceRoots();
        const service = this._getLocalFolderService(allRoots[0] || '');
        const brainPath = service.detectAntigravityBrainPath();
        if (!brainPath) { return; }

        // CRITICAL: must use vscode.Uri.file for out-of-workspace paths
        const brainUri = vscode.Uri.file(brainPath);
        this._antigravityWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(brainUri, '*')  // Watch for new/deleted session directories
        );

        const refresh = () => this._sendLocalDocsReady();
        this._antigravityWatcher.onDidCreate(refresh);
        this._antigravityWatcher.onDidDelete(refresh);
        this._disposables.push(this._antigravityWatcher);
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
            const plansDir = path.join(root, '.switchboard', 'plans');
            if (!fs.existsSync(plansDir)) { continue; }
            if (watchedPaths.has(plansDir)) { continue; }
            watchedPaths.add(plansDir);

            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(plansDir), '**/*.md')
            );

            const triggerRefresh = () => {
                if (!this._panel) { return; }
                if (this._kanbanPlansWatchDebounce) {
                    clearTimeout(this._kanbanPlansWatchDebounce);
                }
                this._kanbanPlansWatchDebounce = setTimeout(() => {
                    this._kanbanPlansWatchDebounce = undefined;
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

            this._activeDocWatcher.onDidChange(() => {
                if (gen !== this._watcherGeneration) { return; } // stale watcher
                if (Date.now() - this._lastPanelWriteTimestamp < 1000) { return; } // panel-initiated write
                if (filePath !== this._activePreviewPath) { return; } // stale path

                if (this._activeDocWatchDebounce) {
                    clearTimeout(this._activeDocWatchDebounce);
                }

                this._activeDocWatchDebounce = setTimeout(async () => {
                    if (gen !== this._watcherGeneration || filePath !== this._activePreviewPath) { return; }
                    
                    const allRoots = this._getWorkspaceRoots();
                    const workspaceRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);
                    if (!workspaceRoot) return;

                    console.log('[PlanningPanel] Auto-refreshing active document:', filePath);
                    this._isAutoRefreshing = true;
                    try {
                        if (this._activePreviewSourceId === 'local-folder') {
                            // Re-fetch local doc
                            await this._handleFetchPreview(workspaceRoot, 'local-folder', this._activePreviewDocId!, -1, this._activePreviewSourceFolder!);
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

    private _getHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
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

    private _getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
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
                await this._handleFetchRoots();
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
                await this._handleImportFullDoc(workspaceRoot, msg.sourceId, msg.docId, msg.docName);
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
            case 'refreshSource': {
                const sourceId = msg.sourceId;
                // Clear cache for this source to force fresh fetch
                await this._cacheService?.clearSourceCache(sourceId);
                // Refresh only the affected pane to avoid cross-pane flicker
                if (sourceId === 'local-folder') {
                    await this._sendLocalDocsReady();
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
                await this._handleImportResearchDoc(workspaceRoot, msg.docTitle);
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
                    `Delete "${docName}" from .switchboard/docs?`,
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
                            allWorkspaceProjects[path.resolve(root)] = await db.getProjects(workspaceId);

                            // Fetch column definitions for this workspace and merge
                            const colDefs = await this._getKanbanColumnDefinitions(root);
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
                const allRoots = this._getWorkspaceRoots();
                const resolved = path.resolve(filePath);
                const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
                if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
                    this._panel?.webview.postMessage({
                        type: 'kanbanPlanPreviewReady', requestId,
                        content: '', error: 'File not found or not in workspace'
                    });
                    break;
                }
                try {
                    const content = await fs.promises.readFile(resolved, 'utf8');
                    this._panel?.webview.postMessage({ type: 'kanbanPlanPreviewReady', requestId, content });
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'kanbanPlanPreviewReady', requestId, content: '', error: String(err) });
                }
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
            case 'saveFileContent': {
                const filePath = String(msg.filePath || '');
                const content = String(msg.content || '');
                const originalContent = String(msg.originalContent || '');
                const tab = String(msg.tab || '');
                const allRoots = this._getWorkspaceRoots();
                const resolved = path.resolve(filePath);
                const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
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
                    await fs.promises.writeFile(resolved, content, 'utf8');
                    this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: true, tab });
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: false, error: String(err), tab });
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

            if (sourceId === 'local-folder') {
                if (!sourceFolder) {
                    throw new Error('sourceFolder is required');
                }
                // For local-folder: resolve the file path directly
                const localFolderService = this._getLocalFolderService(workspaceRoot);
                const resolvedSourceFolder = localFolderService.resolveFolderPath(sourceFolder);
                if (!localFolderService.getFolderPaths().includes(resolvedSourceFolder)) {
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
                const localFolderService = this._getLocalFolderService(workspaceRoot);
                const resolvedSourceFolder = localFolderService.resolveFolderPath(sourceFolder);
                if (!localFolderService.getFolderPaths().includes(resolvedSourceFolder)) {
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
            docName: docName || 'None'
        });
    }

    private _getLocalFolderService(workspaceRoot: string): LocalFolderService {
        return new LocalFolderService(workspaceRoot);
    }

    private _mapLocalFilesToTreeNodes(files: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string; _root?: string; sourceFolder?: string }>): TreeNode[] {
        return files.map(f => ({
            id: f.id,
            name: f.name,
            kind: f.isFolder ? 'folder' : 'document',
            parentId: f.parentId,
            hasChildren: f.isFolder === true,
            metadata: {
                ...(f._root ? { root: f._root } : {}),
                ...(f.sourceFolder ? { sourceFolder: f.sourceFolder } : {})
            }
        }));
    }

    private async _sendLocalDocsReady(): Promise<void> {
        try {
            const allRoots = this._getWorkspaceRoots();
            const allFiles: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string; _root?: string; sourceFolder?: string }> = [];
            const scannedPaths = new Set<string>();
            const activeRoot = this._getWorkspaceRoot();
            let configuredFolderPaths: string[] = []; // Track configured folder paths for webview

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
                            // Prioritize the active root's folder paths for the webview
                            if (root === activeRoot || !activeRoot) {
                                configuredFolderPaths.push(folderPath);
                            }
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

            console.log('[PlanningPanel] Sending localDocsReady, total nodes count:', allFiles.length);
            this._panel.webview.postMessage({
                type: 'localDocsReady',
                sourceId: 'local-folder',
                folderPaths: configuredFolderPaths, // Send active root's folder paths, not workspace root
                nodes: this._mapLocalFilesToTreeNodes(allFiles),
                antigravitySessions,           // NEW — undefined-safe in webview
                antigravityEnabled: agEnabled  // NEW — tells webview whether to show toggle as checked
            });
        } catch (err) {
            console.error('[PlanningPanel] Failed to fetch local-folder roots:', err);
            this._panel?.webview.postMessage({
                type: 'localDocsReady',
                sourceId: 'local-folder',
                folderPaths: [],
                nodes: [],
                error: String(err)
            });
        }
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

    private async _handleFetchRoots(): Promise<void> {
        await this._sendLocalDocsReady();
        await this._sendOnlineDocsReady();
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

    private async _handleFetchPreview(workspaceRoot: string, sourceId: string, docId: string, requestId: number, sourceFolder?: string): Promise<void> {
        // Race guard — track latest request per source
        this._latestRequestIds.set(sourceId, requestId);

        // Handle local-folder directly without adapter
        if (sourceId === 'local-folder') {
            if (!sourceFolder) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'sourceFolder is required' });
                return;
            }
            const localFolderService = this._getLocalFolderService(workspaceRoot);
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
                    this._setupActiveDocWatcher(resolvedPath);

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
                const localFolderService = this._getLocalFolderService(workspaceRoot);
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
            if (result.success && this._cacheService) {
                const adapter = this._researchImportService.getAdapter(sourceId);
                if (adapter && (adapter as any).setDocumentImported) {
                    await (adapter as any).setDocumentImported(docId);
                } else {
                    await this._cacheService.setDocumentImported(sourceId, docId);
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

            // Parse docName from filename or front-matter
            let docName = slugPrefix;
            const frontMatterMatch = content.match(/^---\n[\s\S]*?docName:\s*(.+?)\n[\s\S]*?\n---/);
            if (frontMatterMatch) {
                docName = frontMatterMatch[1].trim();
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

    private async _handleImportFullDoc(workspaceRoot: string, sourceId: string, docId: string, docName: string): Promise<void> {
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
                const localFolderService = this._getLocalFolderService(workspaceRoot);
                const result = await localFolderService.fetchDocContent(docId);
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
                if (this._cacheService && writeResult.success) {
                    await this._cacheService.setDocumentImported(sourceId, docId);
                }
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
                        workspaceId: workspaceId
                    });
                } catch (regErr) {
                    console.warn('[PlanningPanelProvider] Failed to register import:', regErr);
                }
            }

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

    private async _registerImport(
        cacheService: PlanningPanelCacheService | undefined,
        sourceId: string,
        docId: string,
        docName: string,
        content: string,
        workspaceRoot: string
    ): Promise<void> {
        if (!cacheService) return;
        try {
            const rawSlug = docName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .slice(0, 60) || sourceId;
            const contentWithoutFrontMatter = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
            const contentHash = crypto.createHash('sha256').update(contentWithoutFrontMatter).digest('hex');
            const workspaceId = await this._getWorkspaceId(workspaceRoot);
            await cacheService.registerImport(sourceId, docId, docName, rawSlug, { 
                remoteContentHash: contentHash,
                workspaceId: workspaceId
            });
        } catch (regErr) {
            console.warn('[PlanningPanelProvider] Failed to register import:', regErr);
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

    private async _handleImportResearchDoc(workspaceRoot: string, docTitle?: string): Promise<void> {
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
                    finalDocTitle = `Research-${timestamp}`;
                }
            }

            const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
                workspaceRoot,
                content,
                finalDocTitle,
                'research-clipboard',
                { skipDesignDocLink: true }
            );

            this._lastPanelWriteTimestamp = Date.now();

            if (writeResult.error) {
                this._panel?.webview.postMessage({ type: 'importResearchDocResult', error: writeResult.error });
                return;
            }

            this._panel?.webview.postMessage({ 
                type: 'importResearchDocResult', 
                success: true, 
                docTitle: finalDocTitle 
            });

            await this._handleFetchImportedDocs(workspaceRoot);

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
        if (this._antigravityWatcher) {
            try { this._antigravityWatcher.dispose(); } catch (e) {}
            this._antigravityWatcher = undefined;
        }
        for (const watcher of this._localFolderWatchers) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._localFolderWatchers = [];
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
        return records.map((r: any) => ({
            planId: r.planId,
            sessionId: r.sessionId || '',
            topic: r.topic || path.basename(r.planFile || '') || 'Untitled',
            column: r.kanbanColumn,
            workspaceRoot: path.resolve(workspaceRoot),
            workspaceLabel: (() => {
                const resolvedRoot = path.resolve(workspaceRoot);
                const folder = (vscode.workspace.workspaceFolders || []).find(
                    f => path.resolve(f.uri.fsPath) === resolvedRoot
                );
                return folder ? folder.name : path.basename(workspaceRoot);
            })(),
            project: r.project || '',
            repoScope: r.repoScope || '',
            mtime: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
            planFile: r.planFile || ''
        }));
    }

    private async _getKanbanColumnDefinitions(workspaceRoot: string): Promise<KanbanColumnDefinition[]> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        let customAgents: CustomAgentConfig[] = [];
        let customKanbanColumns: CustomKanbanColumnConfig[] = [];
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            if (Array.isArray(state.customAgents)) {
                customAgents = state.customAgents.filter((a: any) => a && a.role && a.name);
            }
            if (Array.isArray(state.customKanbanColumns)) {
                customKanbanColumns = state.customKanbanColumns.filter((c: any) => c && c.id && c.label);
            }
        } catch {
            // No state file or parse error — use defaults
        }
        return buildKanbanColumns(customAgents, customKanbanColumns);
    }
}
