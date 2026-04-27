import * as vscode from 'vscode';
import * as path from 'path';
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

export interface PlanningPanelAdapterFactories {
    getNotionService: (root: string) => NotionFetchService;
    getNotionBrowseService: (root: string) => NotionBrowseService;
    getLinearDocsAdapter: (root: string) => LinearDocsAdapter;
    getClickUpDocsAdapter: (root: string) => ClickUpDocsAdapter;
    getCacheService: (root: string) => PlanningPanelCacheService;
}

export class PlanningPanelProvider {
    private _panel: vscode.WebviewPanel | undefined;
    private _disposables: vscode.Disposable[] = [];
    private _latestRequestIds: Map<string, number> = new Map();
    private _registeredRoot: string | null = null;
    private _cacheService: PlanningPanelCacheService | undefined;
    private _periodicSyncTimer: NodeJS.Timeout | undefined;
    private _currentSyncMode: string = 'no-sync';
    private _syncCancellationSource: AbortController | undefined;
    private _importInProgress = false;
    private _docsFolderWatcher: vscode.FileSystemWatcher | undefined;

    constructor(
        private _extensionUri: vscode.Uri,
        private _researchImportService: ResearchImportService,
        private _plannerPromptWriter: PlannerPromptWriter,
        private _getWorkspaceRoot: () => string | undefined,
        private _adapterFactories: PlanningPanelAdapterFactories,
        private _context: vscode.ExtensionContext
    ) {}

    private _ensureAdaptersRegistered(workspaceRoot: string): void {
        // Re-register when workspace root changes; adapters are workspace-scoped.
        if (this._registeredRoot === workspaceRoot) { return; }

        const notionService = this._adapterFactories.getNotionService(workspaceRoot);
        const notionBrowseService = this._adapterFactories.getNotionBrowseService(workspaceRoot);

        if (notionService && notionBrowseService) {
            this._researchImportService.registerAdapter(
                new NotionResearchAdapter(notionService, notionBrowseService)
            );
        }

        const linearAdapter = this._adapterFactories.getLinearDocsAdapter(workspaceRoot);
        if (linearAdapter) {
            this._researchImportService.registerAdapter(linearAdapter);
        }

        const clickUpAdapter = this._adapterFactories.getClickUpDocsAdapter(workspaceRoot);
        if (clickUpAdapter) {
            this._researchImportService.registerAdapter(clickUpAdapter);
        }

        this._registeredRoot = workspaceRoot;
    }

    public async open(): Promise<void> {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-planning',
            'Switchboard Planning',
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

        // Start periodic sync if configured
        const workspaceRoot = this._getWorkspaceRoot();
        if (workspaceRoot) {
            const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
            try {
                const raw = await fs.promises.readFile(configPath, 'utf8');
                const config = JSON.parse(raw);
                const syncMode = config.syncMode || 'no-sync';
                if (syncMode !== 'no-sync') {
                    await this.triggerSync(workspaceRoot, syncMode);
                }
            } catch { /* no config yet */ }
        }

        this._disposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => {
                this._panel?.webview.postMessage({ type: 'themeChanged' });
            })
        );

        // Watch the docs directory for changes and refresh imported docs list
        this._setupDocsFolderWatcher(workspaceRoot);

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

    private async _handleMessage(msg: any): Promise<void> {
        const workspaceRoot = this._getWorkspaceRoot();
        if (!workspaceRoot) {
            this._panel?.webview.postMessage({ type: 'error', message: 'No workspace open' });
            return;
        }

        try {
            this._ensureAdaptersRegistered(workspaceRoot);
        } catch (err) {
            console.error('[PlanningPanel] Adapter registration error:', err);
        }

        switch (msg.type) {
            case 'fetchRoots': {
                await this._handleFetchRoots(workspaceRoot);
                break;
            }
            case 'fetchChildren': {
                await this._handleFetchChildren(workspaceRoot, msg.sourceId, msg.parentId);
                break;
            }
            case 'fetchPreview': {
                await this._handleFetchPreview(workspaceRoot, msg.sourceId, msg.docId, msg.requestId);
                break;
            }
            case 'appendToPlannerPrompt': {
                await this._handleAppendToPlannerPrompt(workspaceRoot, msg.sourceId, msg.docId, msg.docName, msg.content);
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
            case 'browseLocalFolder': {
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Select Planning Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(workspaceRoot);
                    const folderPath = await service.setFolderPath(result[0].fsPath);
                    const files = await service.listFiles();
                    const nodes = this._mapLocalFilesToTreeNodes(files);
                    this._panel?.webview.postMessage({
                        type: 'localFolderPathUpdated',
                        folderPath,
                        nodes
                    });
                }
                break;
            }
            case 'setLocalFolderPath': {
                const service = this._getLocalFolderService(workspaceRoot);
                const folderPath = await service.setFolderPath(msg.folderPath || '');
                const files = await service.listFiles();
                const nodes = this._mapLocalFilesToTreeNodes(files);
                this._panel?.webview.postMessage({
                    type: 'localFolderPathUpdated',
                    folderPath,
                    nodes
                });
                break;
            }
            case 'refreshSource': {
                const sourceId = msg.sourceId;
                // Clear cache for this source to force fresh fetch
                await this._cacheService?.clearSourceCache(sourceId);
                // Refresh only the affected pane to avoid cross-pane flicker
                if (sourceId === 'local-folder') {
                    await this._sendLocalDocsReady(workspaceRoot);
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
            case 'getClipboardSeparatorPattern': {
                const pattern = await this._getClipboardSeparatorPattern(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'clipboardSeparatorPattern', ...pattern });
                break;
            }
            case 'setClipboardSeparatorPreset': {
                const result = await this._setClipboardSeparatorPreset(workspaceRoot, msg.preset);
                this._panel?.webview.postMessage({ type: 'clipboardSeparatorPatternUpdated', ...result });
                break;
            }
            case 'setClipboardSeparatorPattern': {
                const result = await this._setClipboardSeparatorPattern(workspaceRoot, msg.pattern);
                this._panel?.webview.postMessage({ type: 'clipboardSeparatorPatternUpdated', ...result });
                break;
            }
            case 'importPlansFromClipboard': {
                await this._handleImportPlansFromClipboard(workspaceRoot);
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
            case 'airlock_openFolder': {
                const folderUri = vscode.Uri.file(path.join(workspaceRoot, '.switchboard', 'airlock'));
                await vscode.commands.executeCommand('revealFileInOS', folderUri);
                break;
            }
            case 'disableDesignDoc': {
                await this._handleDisableDesignDoc();
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

    private _getDesignDocName(): string | null {
        const config = vscode.workspace.getConfiguration('switchboard');
        const designDocLink = config.get<string>('planner.designDocLink');
        if (!designDocLink) return null;
        return path.basename(designDocLink, '.md');
    }

    private async _sendActiveDesignDocState(): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard');
        const enabled = config.get<boolean>('planner.designDocEnabled', false);
        const docName = this._getDesignDocName();
        this._panel?.webview.postMessage({
            type: 'activeDesignDocUpdated',
            enabled,
            docName: docName || 'None'
        });
    }

    private _getLocalFolderService(workspaceRoot: string): LocalFolderService {
        return new LocalFolderService(workspaceRoot);
    }

    private _mapLocalFilesToTreeNodes(files: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string }>): TreeNode[] {
        return files.map(f => ({
            id: f.relativePath || f.id,
            name: f.name,
            kind: f.isFolder ? 'folder' : 'document',
            parentId: f.parentId,
            hasChildren: f.isFolder === true
        }));
    }

    private async _sendLocalDocsReady(workspaceRoot: string): Promise<void> {
        try {
            const localFolderService = this._getLocalFolderService(workspaceRoot);
            const files = await localFolderService.listFiles();
            this._panel?.webview.postMessage({
                type: 'localDocsReady',
                sourceId: 'local-folder',
                folderPath: localFolderService.getFolderPath(),
                nodes: this._mapLocalFilesToTreeNodes(files)
            });
        } catch (err) {
            console.error('[PlanningPanel] Failed to fetch local-folder roots:', err);
            this._panel?.webview.postMessage({
                type: 'localDocsReady',
                sourceId: 'local-folder',
                folderPath: '',
                nodes: [],
                error: String(err)
            });
        }
    }

    private _sendOnlineDocsReady(): void {
        const roots = this._researchImportService
            .getAvailableSources()
            .filter(sourceId => sourceId !== 'local-folder')
            .map(sourceId => ({ sourceId, nodes: [] as TreeNode[] }));

        this._panel?.webview.postMessage({
            type: 'onlineDocsReady',
            roots,
            enabledSources: {
                clickup: true,
                linear: true,
                notion: true
            }
        });
    }

    private async _handleFetchRoots(workspaceRoot: string): Promise<void> {
        await this._sendLocalDocsReady(workspaceRoot);
        this._sendOnlineDocsReady();
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

    private async _handleFetchPreview(workspaceRoot: string, sourceId: string, docId: string, requestId: number): Promise<void> {
        // Race guard — track latest request per source
        this._latestRequestIds.set(sourceId, requestId);

        // Handle local-folder directly without adapter
        if (sourceId === 'local-folder') {
            const localFolderService = this._getLocalFolderService(workspaceRoot);
            try {
                const result = await localFolderService.fetchDocContent(docId);
                if (result.success) {
                    this._panel?.webview.postMessage({ type: 'previewReady', sourceId, requestId, content: result.content || '', docName: result.docTitle });
                } else {
                    this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: result.error || 'Failed to fetch document' });
                }
            } catch (err) {
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
                    this._panel?.webview.postMessage({ type: 'previewReady', sourceId, requestId, content, docName, isCached: true, isImported });
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
                            totalPages: docResult.totalPages
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
                await this._cacheService.cacheDocument(sourceId, docId, content, docName || docId);
            }

            const isImported = this._cacheService ? await this._cacheService.isDocumentImported(sourceId, docId) : false;
            this._panel?.webview.postMessage({ type: 'previewReady', sourceId, requestId, content, docName, isCached: true, isImported });
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
                await this._cacheService.cacheDocument(sourceId, docId, content, docName || docId);
            }
        } catch (err) {
            // Background refresh failure is non-blocking
            console.warn(`[PlanningPanel] Background cache refresh failed for ${sourceId}/${docId}:`, err);
        }
    }

    private async _handleAppendToPlannerPrompt(workspaceRoot: string, sourceId: string, docId: string, docName: string, content?: string): Promise<void> {
        try {
            let result;
            if (content) {
                // Use provided content directly (for pages that aren't cached)
                result = await this._plannerPromptWriter.writeContentToDocsDir(workspaceRoot, content, docName, sourceId);
            } else {
                result = await this._plannerPromptWriter.writeFromPlanningCache(workspaceRoot, sourceId, docId, docName);
            }
            if (result.success && this._cacheService) {
                await this._cacheService.setDocumentImported(sourceId, docId);
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

    private async _handleFetchImportedDocs(workspaceRoot: string): Promise<void> {
        try {
            const docsDir = path.join(workspaceRoot, '.switchboard', 'docs');
            if (!fs.existsSync(docsDir)) {
                this._panel?.webview.postMessage({ type: 'importedDocsReady', docs: [] });
                return;
            }

            const files = await fs.promises.readdir(docsDir);
            console.log('[PlanningPanelProvider] Files in docs directory:', files);
            const docs = [];
            
            for (const file of files) {
                if (file.endsWith('.md')) {
                    const filePath = path.join(docsDir, file);
                    const stat = await fs.promises.stat(filePath);
                    const slugPrefix = path.basename(file, '.md');
                    const content = await fs.promises.readFile(filePath, 'utf-8');
                    
                    // Parse front-matter first
                    let displayName = slugPrefix;
                    let sourceId = 'local-folder';
                    let docId = slugPrefix;
                    let canSync = false;
                    let order = 0;

                    const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                    if (frontMatterMatch) {
                        const frontMatter = frontMatterMatch[1];

                        // Extract docName from front-matter
                        const docNameMatch = frontMatter.match(/^docName:\s*(.+)$/m);
                        if (docNameMatch) {
                            displayName = docNameMatch[1].trim();
                        }

                        // Extract sourceId from front-matter
                        const sourceIdMatch = frontMatter.match(/^sourceId:\s*(.+)$/m);
                        if (sourceIdMatch) {
                            sourceId = sourceIdMatch[1].trim();
                            const adapter = this._researchImportService.getAdapter(sourceId);
                            canSync = !!(adapter && adapter.updateContent);
                        }

                        // Extract docId from front-matter
                        const docIdMatch = frontMatter.match(/^docId:\s*(.+)$/m);
                        if (docIdMatch) {
                            docId = docIdMatch[1].trim();
                        }

                        // Extract order from front-matter
                        const orderMatch = frontMatter.match(/^order:\s*(\d+)$/m);
                        if (orderMatch) {
                            order = parseInt(orderMatch[1], 10);
                        }
                    }
                    
                    // Fall back to H1 if no docName in front-matter
                    if (displayName === slugPrefix) {
                        const h1Match = content.match(/^#\s+(.+)$/m);
                        if (h1Match) {
                            displayName = h1Match[1].trim();
                        }
                    }
                    
                    docs.push({
                        sourceId,
                        docId,
                        docName: displayName,
                        slugPrefix,
                        canSync,
                        order,
                        lastSyncedAt: stat.mtime.toISOString()
                    });
                }
            }
            
            console.log('[PlanningPanelProvider] Sending importedDocsReady with docs:', docs);
            this._panel?.webview.postMessage({ type: 'importedDocsReady', docs });
        } catch (err) {
            console.error('[PlanningPanelProvider] Error fetching imported docs:', err);
            this._panel?.webview.postMessage({ type: 'importedDocsReady', docs: [], error: String(err) });
        }
    }

    private async _handleFetchDocsFile(workspaceRoot: string, slugPrefix: string, requestId: number): Promise<void> {
        try {
            const docsDir = path.join(workspaceRoot, '.switchboard', 'docs');
            const filePath = path.join(docsDir, `${slugPrefix}.md`);
            
            if (!fs.existsSync(filePath)) {
                this._panel?.webview.postMessage({ type: 'previewError', sourceId: 'local-folder', requestId, error: 'File not found' });
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
            
            this._panel?.webview.postMessage({
                type: 'previewReady',
                sourceId: 'local-folder',
                requestId,
                content: displayContent,
                docName
            });
        } catch (err) {
            console.error('[PlanningPanelProvider] Error fetching docs file:', err);
            this._panel?.webview.postMessage({ type: 'previewError', sourceId: 'local-folder', requestId, error: String(err) });
        }
    }

    private async _handleSyncToSource(workspaceRoot: string, slugPrefix: string): Promise<void> {
        try {
            if (!this._cacheService) {
                this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: false, error: 'Cache service not available' });
                return;
            }

            const importEntry = await this._cacheService.getImportBySlugPrefix(slugPrefix);
            if (!importEntry) {
                this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: false, error: 'Import entry not found' });
                return;
            }

            const adapter = this._researchImportService.getAdapter(importEntry.sourceId);
            if (!adapter || !adapter.updateContent) {
                this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: false, error: 'Source does not support sync-to-source' });
                return;
            }

            const localPath = await this._cacheService.resolveImportedDocPath(slugPrefix);
            if (!localPath) {
                this._panel?.webview.postMessage({ type: 'syncResult', slugPrefix, success: false, error: 'Local file not found' });
                return;
            }

            const localContent = await fs.promises.readFile(localPath, 'utf8');
            const localContentHash = crypto.createHash('sha256').update(localContent).digest('hex');

            // Conflict detection: check if remote has changed since last sync
            if (importEntry.remoteContentHash && adapter.fetchContent) {
                try {
                    const remoteContent = await adapter.fetchContent(importEntry.docId);
                    const remoteContentHash = crypto.createHash('sha256').update(remoteContent).digest('hex');

                    if (remoteContentHash !== importEntry.remoteContentHash) {
                        // Remote has changed since last sync
                        if (localContentHash === importEntry.remoteContentHash) {
                            // Only remote changed — no push needed, just update the stored hash
                            await this._cacheService.updateLastSynced(slugPrefix, remoteContentHash);
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

            const result = await adapter.updateContent(importEntry.docId, localContent);
            if (result.success) {
                await this._cacheService.updateLastSynced(slugPrefix, localContentHash);
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
                    sourceId
                );
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
                    // Import each page as a separate doc
                    let importedCount = 0;
                    let errorCount = 0;
                    
                    // Track page index for order preservation
                    let pageIndex = 0;
                    for (const page of pages) {
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
                                    { pageOrder: pageIndex }
                                );
                                pageIndex++;
                                
                                if (writeResult.success) {
                                    importedCount++;
                                    // Register each page import
                                    if (this._cacheService) {
                                        try {
                                            const rawSlug = pageDocName
                                                .toLowerCase()
                                                .replace(/[^a-z0-9]+/g, '_')
                                                .replace(/^_+|_+$/g, '')
                                                .slice(0, 60) || sourceId;
                                            const contentWithoutFrontMatter = result.content.replace(/^---\n[\s\S]*?\n---\n*/, '');
                                            const contentHash = crypto.createHash('sha256').update(contentWithoutFrontMatter).digest('hex');
                                            await this._cacheService.registerImport(sourceId, page.id, pageDocName, rawSlug, { remoteContentHash: contentHash });
                                        } catch (regErr) {
                                            console.warn('[PlanningPanelProvider] Failed to register page import:', regErr);
                                        }
                                    }
                                } else {
                                    errorCount++;
                                }
                            }
                        } catch (pageErr) {
                            console.warn(`[PlanningPanelProvider] Failed to import page ${page.id}:`, pageErr);
                            errorCount++;
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
                sourceId
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
                    await this._cacheService.registerImport(sourceId, safeDocId, docName, rawSlug, { remoteContentHash: contentHash });
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
        content: string
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
            await cacheService.registerImport(sourceId, docId, docName, rawSlug, { remoteContentHash: contentHash });
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

    private async _getClipboardSeparatorPattern(workspaceRoot: string): Promise<{ preset: string; pattern: string }> {
        const preset = this._context.workspaceState.get<string>('switchboard.clipboardImport.separatorPreset') || 'claude';
        const pattern = this._context.workspaceState.get<string>('switchboard.clipboardImport.separatorPattern') || '### PLAN [N] START';
        return { preset, pattern };
    }

    private async _setClipboardSeparatorPreset(workspaceRoot: string, preset: string): Promise<{ preset: string; pattern: string }> {
        await this._context.workspaceState.update('switchboard.clipboardImport.separatorPreset', preset);
        const pattern = await this._getClipboardSeparatorPattern(workspaceRoot);
        return pattern;
    }

    private async _setClipboardSeparatorPattern(workspaceRoot: string, pattern: string): Promise<{ pattern: string }> {
        await this._context.workspaceState.update('switchboard.clipboardImport.separatorPattern', pattern);
        return { pattern };
    }

    private async _handleImportPlansFromClipboard(workspaceRoot: string): Promise<void> {
        // Delegate to the existing command that handles clipboard import
        await vscode.commands.executeCommand('switchboard.importPlanFromClipboard');
    }

    private async _handleAirlockExport(workspaceRoot: string): Promise<{ success: boolean; message: string }> {
        try {
            const airlockDir = path.join(workspaceRoot, '.switchboard', 'airlock');
            if (!fs.existsSync(airlockDir)) {
                fs.mkdirSync(airlockDir, { recursive: true });
            }

            // For now, return a success message. The actual bundling logic
            // can be implemented later by calling the appropriate service.
            return { success: true, message: 'Airlock folder ready. Export functionality coming soon.' };
        } catch (err) {
            return { success: false, message: `Failed to prepare airlock: ${String(err)}` };
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

        // If no mode provided, read from config
        let mode: string = syncMode || 'no-sync';
        if (!syncMode) {
            const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
            try {
                const raw = await fs.promises.readFile(configPath, 'utf8');
                const config = JSON.parse(raw);
                mode = config.syncMode || 'no-sync';
            } catch {
                mode = 'no-sync';
            }
        }

        this._currentSyncMode = mode;

        if (mode === 'auto-sync-all') {
            await this.syncAllDocuments(workspaceRoot);
            this.startPeriodicSync(workspaceRoot);
        } else if (mode === 'sync-selected') {
            const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
            try {
                const raw = await fs.promises.readFile(configPath, 'utf8');
                const config = JSON.parse(raw);
                if (Array.isArray(config.selectedContainers)) {
                    await this.syncSelectedContainers(workspaceRoot, config.selectedContainers);
                }
            } catch { /* no containers selected yet */ }
            this.startPeriodicSync(workspaceRoot);
        }
    }

    public dispose(): void {
        this.stopPeriodicSync();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
        if (this._panel) {
            this._panel.dispose();
            this._panel = undefined;
        }
    }
}
