import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { KanbanDatabase } from './KanbanDatabase';
import { LocalFolderService } from './LocalFolderService';
import { TaskViewerProvider } from './TaskViewerProvider';
import { PanelStateStore } from './PanelStateStore';
import { buildWorkspaceItems } from './workspaceUtils';

// @google/stitch-sdk is ESM-only (its exports map has no "require" condition), so a
// static import fails resolution in this CJS bundle. A dynamic import() resolves with
// the "import" condition, and webpackMode: "eager" inlines the SDK into the main
// bundle — required because the installed extension ships dist/ without node_modules.
let _stitchSdkPromise: Promise<any> | undefined;
function loadStitch(): Promise<any> {
    if (!_stitchSdkPromise) {
        _stitchSdkPromise = import(/* webpackMode: "eager" */ '@google/stitch-sdk').then(m => m.stitch);
    }
    return _stitchSdkPromise;
}

interface TreeNode {
    id: string;
    name: string;
    kind: 'document' | 'folder';
    parentId?: string;
    hasChildren?: boolean;
    title?: string;
    metadata?: any;
}



export class DesignPanelProvider implements vscode.Disposable {
    private _panel?: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _nonce: string = '';
    private _htmlFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _designFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _imagesFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _briefsFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _htmlDocsDebounce?: NodeJS.Timeout;
    private _designDocsDebounce?: NodeJS.Timeout;
    private _imagesDocsDebounce?: NodeJS.Timeout;
    private _briefsDocsDebounce?: NodeJS.Timeout;
    private _activeScreens = new Map<string, any>(); // Key: screen.id, Value: SDK Screen instance
    private _stitchOperationLock = false;
    private _activeDesignSystemDocSourceId: string | null = null;
    private _activeDesignSystemDocId: string | null = null;
    private _htmlServers = new Map<string, { server: http.Server; port: number; timeoutId: NodeJS.Timeout }>();
    private _htmlServerCreationPromises = new Map<string, Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }>>();
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
    private _lastWebviewRootsSignature?: string;
    private _themeListenersRegistered = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _getWorkspaceRoot: () => string | undefined,
        private readonly _context: vscode.ExtensionContext,
        private readonly _stateStore: PanelStateStore,
        private readonly _taskViewerProvider?: TaskViewerProvider
    ) {}

    public get isOpen(): boolean {
        return !!this._panel;
    }

    public async open(): Promise<void> {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-design',
            'DESIGN',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this._extensionUri, 'dist'),
                    vscode.Uri.joinPath(this._extensionUri, 'webview'),
                    vscode.Uri.joinPath(this._extensionUri, 'designs'),
                    vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
                    ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri)
                ]
            }
        );

        this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
        this._panel.webview.html = this._getHtml(this._panel.webview);

        this._panel.webview.onDidReceiveMessage(
            async (message) => this._handleMessage(message),
            undefined,
            this._disposables
        );

        this._panel.onDidDispose(() => {
            this._panel = undefined;
            this.disposeWatchers();
        }, null, this._disposables);

        this._setupHtmlFolderWatchers();
        this._setupDesignFolderWatchers();
        this._setupImagesFolderWatchers();
        this._setupBriefsFolderWatchers();

        this._disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(async () => {
                this.postMessage({
                    type: 'workspaceItemsUpdated',
                    items: buildWorkspaceItems(this._getWorkspaceRoots())
                });
                this.disposeWatchers();
                this._setupHtmlFolderWatchers();
                this._setupDesignFolderWatchers();
                this._setupImagesFolderWatchers();
                this._setupBriefsFolderWatchers();
                await this._sendHtmlDocsReady();
                await this._sendDesignDocsReady();
                await this._sendImagesDocsReady();
                await this._sendBriefsDocsReady();
            })
        );

        if (!this._themeListenersRegistered) {
            this._themeListenersRegistered = true;
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
        }
    }

    public postMessage(message: any): void {
        this._panel?.webview.postMessage(message);
    }

    public dispose(): void {
        this._panel?.dispose();
        this.disposeWatchers();
        this._activeScreens.clear();
        this._stitchOperationLock = false;
        for (const [, entry] of this._htmlServers) {
            clearTimeout(entry.timeoutId);
            try { entry.server.close(); } catch {}
        }
        this._htmlServers.clear();
        this._htmlServerCreationPromises.clear();
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables = [];
    }

    private disposeWatchers(): void {
        this._htmlFolderWatchers.forEach(w => w.dispose());
        this._htmlFolderWatchers = [];
        this._designFolderWatchers.forEach(w => w.dispose());
        this._designFolderWatchers = [];
        this._imagesFolderWatchers.forEach(w => w.dispose());
        this._imagesFolderWatchers = [];
        this._briefsFolderWatchers.forEach(w => w.dispose());
        this._briefsFolderWatchers = [];
    }

    private _getHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        this._nonce = nonce;
        const cspSource = webview.cspSource;

        const possiblePaths = [
            path.join(this._extensionUri.fsPath, 'dist', 'webview', 'design.html'),
            path.join(this._extensionUri.fsPath, 'webview', 'design.html'),
            path.join(this._extensionUri.fsPath, 'src', 'webview', 'design.html')
        ];

        let htmlContent = '';
        for (const htmlPath of possiblePaths) {
            try {
                if (fs.existsSync(htmlPath)) {
                    htmlContent = fs.readFileSync(htmlPath, 'utf8');
                    break;
                }
            } catch {}
        }

        if (!htmlContent) {
            htmlContent = '<html><body><h1>Design panel HTML not found</h1></body></html>';
        }

        htmlContent = htmlContent.replace(/\{\{NONCE\}\}/g, nonce);
        htmlContent = htmlContent.replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, cspSource);

        const designJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'design.js')
        );
        htmlContent = htmlContent.replace(/\{\{DESIGN_JS_URI\}\}/g, designJsUri.toString());

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

    private _getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    }

    private _getLocalFolderService(workspaceRoot: string): LocalFolderService {
        return new LocalFolderService(workspaceRoot);
    }

    private _buildKanbanWorkspaceItems(): Array<{ label: string; workspaceRoot: string }> {
        return buildWorkspaceItems(this._getWorkspaceRoots());
    }

    private _mapLocalFilesToTreeNodes(files: Array<any>): TreeNode[] {
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

    private _setupHtmlFolderWatchers(): void {
        this._htmlFolderWatchers.forEach(w => w.dispose());
        this._htmlFolderWatchers = [];
        const roots = this._getWorkspaceRoots();
        for (const root of roots) {
            try {
                const service = this._getLocalFolderService(root);
                const paths = service.getHtmlFolderPaths();
                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        const pattern = new vscode.RelativePattern(p, '**/*');
                        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                        watcher.onDidChange(() => this._sendHtmlDocsReady());
                        watcher.onDidCreate(() => this._sendHtmlDocsReady());
                        watcher.onDidDelete(() => this._sendHtmlDocsReady());
                        this._htmlFolderWatchers.push(watcher);
                    }
                }
            } catch {}
        }
    }

    private _setupDesignFolderWatchers(): void {
        this._designFolderWatchers.forEach(w => w.dispose());
        this._designFolderWatchers = [];
        const roots = this._getWorkspaceRoots();
        for (const root of roots) {
            try {
                const service = this._getLocalFolderService(root);
                const paths = service.getDesignFolderPaths();
                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        const pattern = new vscode.RelativePattern(p, '**/*');
                        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                        watcher.onDidChange(() => this._sendDesignDocsReady());
                        watcher.onDidCreate(() => this._sendDesignDocsReady());
                        watcher.onDidDelete(() => this._sendDesignDocsReady());
                        this._designFolderWatchers.push(watcher);
                    }
                }
            } catch {}
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
                const allFiles: any[] = [];
                const seenFilePaths = new Set<string>();
                const configuredFolderPathsByRoot: Record<string, string[]> = {};

                for (const root of allRoots) {
                    try {
                        const localFolderService = this._getLocalFolderService(root);
                        const folderPaths = localFolderService.getHtmlFolderPaths();
                        configuredFolderPathsByRoot[root] = folderPaths;

                        const files = await localFolderService.listHtmlFiles();
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
                this._updateWebviewRoots();

                this._panel.webview.postMessage({
                    type: 'htmlDocsReady',
                    sourceId: 'html-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this._panel?.webview.postMessage({
                    type: 'htmlDocsReady',
                    sourceId: 'html-folder',
                    folderPathsByRoot: {},
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
                const allFiles: any[] = [];
                const seenFilePaths = new Set<string>();
                const configuredFolderPathsByRoot: Record<string, string[]> = {};

                for (const root of allRoots) {
                    try {
                        const localFolderService = this._getLocalFolderService(root);
                        const folderPaths = localFolderService.getDesignFolderPaths();
                        configuredFolderPathsByRoot[root] = folderPaths;

                        const files = await localFolderService.listDesignFiles();
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
                this._updateWebviewRoots();

                this._panel.webview.postMessage({
                    type: 'designDocsReady',
                    sourceId: 'design-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this._panel?.webview.postMessage({
                    type: 'designDocsReady',
                    sourceId: 'design-folder',
                    folderPathsByRoot: {},
                    nodes: [],
                    workspaceItems: this._buildKanbanWorkspaceItems(),
                    error: String(err)
                });
            }
        }, 300);
    }

    private _setupImagesFolderWatchers(): void {
        this._imagesFolderWatchers.forEach(w => w.dispose());
        this._imagesFolderWatchers = [];
        const roots = this._getWorkspaceRoots();
        for (const root of roots) {
            try {
                const service = this._getLocalFolderService(root);
                const paths = service.getImagesFolderPaths();
                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        const pattern = new vscode.RelativePattern(p, '**/*');
                        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                        watcher.onDidChange(() => this._sendImagesDocsReady());
                        watcher.onDidCreate(() => this._sendImagesDocsReady());
                        watcher.onDidDelete(() => this._sendImagesDocsReady());
                        this._imagesFolderWatchers.push(watcher);
                    }
                }
            } catch {}
        }
    }

    private async _sendImagesDocsReady(): Promise<void> {
        if (this._imagesDocsDebounce) {
            clearTimeout(this._imagesDocsDebounce);
        }
        this._imagesDocsDebounce = setTimeout(async () => {
            this._imagesDocsDebounce = undefined;
            try {
                const allRoots = this._getWorkspaceRoots();
                const allFiles: any[] = [];
                const seenFilePaths = new Set<string>();
                const configuredFolderPathsByRoot: Record<string, string[]> = {};

                for (const root of allRoots) {
                    try {
                        const localFolderService = this._getLocalFolderService(root);
                        const folderPaths = localFolderService.getImagesFolderPaths();
                        configuredFolderPathsByRoot[root] = folderPaths;

                        const files = await localFolderService.listImagesFiles();
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
                this._updateWebviewRoots();

                this._panel.webview.postMessage({
                    type: 'imagesDocsReady',
                    sourceId: 'images-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this._panel?.webview.postMessage({
                    type: 'imagesDocsReady',
                    sourceId: 'images-folder',
                    folderPathsByRoot: {},
                    nodes: [],
                    workspaceItems: this._buildKanbanWorkspaceItems(),
                    error: String(err)
                });
            }
        }, 300);
    }

    private _setupBriefsFolderWatchers(): void {
        this._briefsFolderWatchers.forEach(w => w.dispose());
        this._briefsFolderWatchers = [];
        const roots = this._getWorkspaceRoots();
        for (const root of roots) {
            try {
                const service = this._getLocalFolderService(root);
                const paths = service.getBriefsFolderPaths();
                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        const pattern = new vscode.RelativePattern(p, '**/*');
                        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                        watcher.onDidChange(() => this._sendBriefsDocsReady());
                        watcher.onDidCreate(() => this._sendBriefsDocsReady());
                        watcher.onDidDelete(() => this._sendBriefsDocsReady());
                        this._briefsFolderWatchers.push(watcher);
                    }
                }
            } catch {}
        }
    }

    private async _sendBriefsDocsReady(): Promise<void> {
        if (this._briefsDocsDebounce) {
            clearTimeout(this._briefsDocsDebounce);
        }
        this._briefsDocsDebounce = setTimeout(async () => {
            this._briefsDocsDebounce = undefined;
            try {
                const allRoots = this._getWorkspaceRoots();
                const allFiles: any[] = [];
                const seenFilePaths = new Set<string>();
                const configuredFolderPathsByRoot: Record<string, string[]> = {};

                for (const root of allRoots) {
                    try {
                        const localFolderService = this._getLocalFolderService(root);
                        const folderPaths = localFolderService.getBriefsFolderPaths();
                        configuredFolderPathsByRoot[root] = folderPaths;

                        const files = await localFolderService.listBriefsFiles();
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
                this._updateWebviewRoots();

                this._panel.webview.postMessage({
                    type: 'briefsDocsReady',
                    sourceId: 'briefs-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this._panel?.webview.postMessage({
                    type: 'briefsDocsReady',
                    sourceId: 'briefs-folder',
                    folderPathsByRoot: {},
                    nodes: [],
                    workspaceItems: this._buildKanbanWorkspaceItems(),
                    error: String(err)
                });
            }
        }, 300);
    }

    private _updateWebviewRoots(): void {
        if (!this._panel) return;
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
                for (const p of service.getImagesFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
                for (const p of service.getStitchFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
                for (const p of service.getBriefsFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
                // Include the Stitch image cache directory in resource roots
                const stitchCacheDir = path.join(r, '.switchboard', 'stitch');
                try {
                    folderUris.push(vscode.Uri.file(stitchCacheDir));
                } catch {}
            } catch {}
        }

        const localResourceRoots = [
            vscode.Uri.joinPath(this._extensionUri, 'dist'),
            vscode.Uri.joinPath(this._extensionUri, 'webview'),
            vscode.Uri.joinPath(this._extensionUri, 'designs'),
            vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
            ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri),
            ...folderUris
        ];

        const signature = JSON.stringify(localResourceRoots.map(u => u.toString()));
        if (signature === this._lastWebviewRootsSignature) return;
        this._lastWebviewRootsSignature = signature;

        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots
        };
    }

    private _getStitchOutputDir(workspaceRoot: string): string {
        const configured = this._getLocalFolderService(workspaceRoot).getStitchFolderPath() || '.stitch';
        return path.resolve(workspaceRoot, configured);
    }

    private _getImageCacheDir(workspaceRoot: string): string {
        return path.join(workspaceRoot, '.switchboard', 'stitch');
    }

    private async _formatScreenFromCache(cached: {
        id: string; projectId: string; name: string;
        deviceType: string; status: string; statusMessage: string;
    }, workspaceRoot: string): Promise<any> {
        const fileUri = vscode.Uri.file(
            path.join(this._getImageCacheDir(workspaceRoot), `${path.basename(cached.id)}.png`)
        );
        let imageUrl = '';
        try {
            await vscode.workspace.fs.stat(fileUri);
            imageUrl = this._panel?.webview.asWebviewUri(fileUri).toString() || '';
        } catch {}
        return {
            id: cached.id,
            projectId: cached.projectId,
            name: cached.name,
            deviceType: cached.deviceType,
            imageUrl,
            htmlUrl: '',
            status: cached.status,
            statusMessage: cached.statusMessage
        };
    }

    private async _fetchWithTimeout(url: string, timeoutMs: number = 30000): Promise<Response> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            return response;
        } catch (err: any) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
                throw new Error(`Request timed out after ${timeoutMs}ms`);
            }
            throw err;
        }
    }

    private async _getCachedImageUri(screen: any, workspaceRoot: string): Promise<string> {
        let cdnUrl: string;
        try {
            cdnUrl = await screen.getImage() || '';
        } catch {
            cdnUrl = '';
        }
        if (!cdnUrl) return '';

        // Apply hi-res transform for immediate display (same as makeFifeHighResUrl in webview)
        const hiResUrl = (cdnUrl.includes('/fife/') || cdnUrl.includes('lh3.googleusercontent.com')) && !cdnUrl.includes('?')
            ? cdnUrl.replace(/=[wsh]\d+(?:-[wsh]\d+)?$/, '') + '=w1200'
            : cdnUrl;

        if (!workspaceRoot) return hiResUrl;

        const cacheDir = this._getImageCacheDir(workspaceRoot);
        const safeId = path.basename(screen.id);
        const cachePath = path.join(cacheDir, `${safeId}.png`);
        const fileUri = vscode.Uri.file(cachePath);

        // If already cached, return the webview URI
        try {
            await vscode.workspace.fs.stat(fileUri);
            return this._panel?.webview.asWebviewUri(fileUri).toString() || hiResUrl;
        } catch {
            // Not cached yet — download in background, return CDN URL immediately so the
            // gallery renders now without waiting for the download to finish
        }

        this._downloadToCache(hiResUrl, cacheDir, fileUri).catch(err =>
            console.error('Stitch image cache download failed:', err)
        );

        return hiResUrl;
    }

    private async _downloadToCache(url: string, cacheDir: string, fileUri: vscode.Uri): Promise<void> {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(cacheDir));
        const res = await this._fetchWithTimeout(url, 60000);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        await vscode.workspace.fs.writeFile(fileUri, buffer);
    }

    private async _formatScreen(screen: any, workspaceRoot: string): Promise<any> {
        const imageUrl = await this._getCachedImageUri(screen, workspaceRoot);
        return {
            id: screen.id,
            projectId: screen.projectId,
            name: screen.data?.title || screen.data?.displayName || screen.id,
            deviceType: screen.data?.deviceType,
            imageUrl,
            htmlUrl: await screen.getHtml(),
            status: screen.data?.screenMetadata?.status || null,
            statusMessage: screen.data?.screenMetadata?.statusMessage || null
        };
    }

    private _setupStitchApiKey(): boolean {
        const config = vscode.workspace.getConfiguration('switchboard');
        const apiKey = config.get<string>('stitch.apiKey') || process.env.STITCH_API_KEY;
        if (apiKey) {
            process.env.STITCH_API_KEY = apiKey;
            return true;
        }
        return false;
    }

    // The kanban "Design Doc Reference" planner add-on (roleConfig_planner.addons.designSystemDoc)
    // gates whether planner.designSystemDocLink is injected into agent prompts. Setting/unsetting
    // the active design doc here must flip that add-on so the kanban checkbox stays in sync.
    private async _setPlannerDesignSystemAddon(enabled: boolean): Promise<void> {
        if (!this._taskViewerProvider) return;
        const key = 'roleConfig_planner';
        const existing = (this._taskViewerProvider.getRoleConfig(key) as any) || {};
        const updated = {
            ...existing,
            addons: { ...(existing.addons || {}), designSystemDoc: enabled }
        };
        await this._taskViewerProvider.saveRoleConfig(key, updated);
    }

    private _getDesignSystemDocName(): string | null {
        const config = vscode.workspace.getConfiguration('switchboard');
        const designSystemDocLink = config.get<string>('planner.designSystemDocLink');
        if (!designSystemDocLink) return null;
        return path.basename(designSystemDocLink, '.md');
    }

    private async _sendActiveDesignDocState(): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard');
        const dsEnabled = config.get<boolean>('planner.designSystemDocEnabled', false);
        const dsDocName = dsEnabled ? this._getDesignSystemDocName() : null;
        this.postMessage({
            type: 'activeDesignDocUpdated',
            designSystemDoc: {
                enabled: dsEnabled,
                docName: dsDocName || 'None',
                sourceId: this._activeDesignSystemDocSourceId,
                docId: this._activeDesignSystemDocId
            }
        });
    }

    // Resolve a `${folderIndex}:${relativePath}` tree-node id against a configured
    // design folder, returning the absolute path or null if unreadable/unconfigured.
    private async _resolveDesignDocPath(sourceFolder: string | undefined, docId: string): Promise<string | null> {
        if (!sourceFolder) return null;
        const resolvedFolder = path.resolve(sourceFolder);
        let isConfigured = false;
        for (const root of this._getWorkspaceRoots()) {
            try {
                const svc = this._getLocalFolderService(root);
                if (svc.getDesignFolderPaths().some(p => path.resolve(p) === resolvedFolder)) {
                    isConfigured = true;
                    break;
                }
            } catch {}
        }
        if (!isConfigured) return null;
        const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
        const docPath = path.resolve(resolvedFolder, cleanDocId);
        if (docPath !== resolvedFolder && !docPath.startsWith(resolvedFolder + path.sep)) return null;
        try {
            await fs.promises.access(docPath, fs.constants.R_OK);
            return docPath;
        } catch {
            return null;
        }
    }

    // ── Localhost HTML preview server (ported from the planning panel) ──
    // srcdoc iframes inherit the webview's CSP and break relative asset paths;
    // serving from 127.0.0.1 gives previews a real origin (CSP frame-src allows http:).

    private async _getOrCreateHtmlServer(sourceFolder: string): Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }> {
        const existing = this._htmlServers.get(sourceFolder);
        if (existing) {
            clearTimeout(existing.timeoutId);
            existing.timeoutId = this._createServerTimeout(sourceFolder);
            return existing;
        }
        const pendingPromise = this._htmlServerCreationPromises.get(sourceFolder);
        if (pendingPromise) {
            return pendingPromise;
        }
        const creationPromise = this._createHtmlServer(sourceFolder);
        this._htmlServerCreationPromises.set(sourceFolder, creationPromise);
        try {
            return await creationPromise;
        } finally {
            this._htmlServerCreationPromises.delete(sourceFolder);
        }
    }

    private _createHtmlServer(sourceFolder: string): Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }> {
        const server = http.createServer((req, res) => {
            this._handleHtmlServerRequest(req, res, sourceFolder);
        });
        return new Promise((resolve, reject) => {
            server.listen(0, '127.0.0.1', () => {
                const address = server.address() as { port: number };
                const timeoutId = this._createServerTimeout(sourceFolder);
                const entry = { server, port: address.port, timeoutId };
                this._htmlServers.set(sourceFolder, entry);
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

    private _handleHtmlServerRequest(req: http.IncomingMessage, res: http.ServerResponse, sourceFolder: string): void {
        const parsedUrl = new URL(req.url || '/', `http://127.0.0.1`);
        const requestedPath = decodeURIComponent(parsedUrl.pathname);

        if (requestedPath === '/' || requestedPath === '') {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden: directory listing not available');
            return;
        }

        const resolvedPath = path.resolve(sourceFolder, requestedPath.substring(1));
        const normalizedSource = path.normalize(sourceFolder).replace(/[\\/]+$/, '');
        const normalizedResolved = path.normalize(resolvedPath);

        if (!normalizedResolved.startsWith(normalizedSource + path.sep) && normalizedResolved !== normalizedSource) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden: path traversal denied');
            return;
        }

        const pathParts = normalizedResolved.split(path.sep);
        for (const part of pathParts) {
            if (this._SERVER_DENY_LIST.some(denied => part === denied || part.startsWith(denied))) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden: access denied');
                return;
            }
        }

        fs.readFile(resolvedPath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }
            res.writeHead(200, { 'Content-Type': this._getMimeType(resolvedPath) });
            res.end(data);
        });

        const entry = this._htmlServers.get(sourceFolder);
        if (entry) {
            clearTimeout(entry.timeoutId);
            entry.timeoutId = this._createServerTimeout(sourceFolder);
        }
    }

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

    private _createServerTimeout(sourceFolder: string): NodeJS.Timeout {
        return setTimeout(() => {
            const entry = this._htmlServers.get(sourceFolder);
            if (entry) {
                entry.server.close();
                this._htmlServers.delete(sourceFolder);
            }
        }, 10 * 60 * 1000); // 10 minutes idle shutdown
    }

    // srcdoc fallback only: strip the preview's own CSP metas (they'd double up with the
    // inherited webview CSP) and stamp the webview nonce onto script tags so they run.
    private _injectLocalCsp(html: string): string {
        let processedHtml = html.replace(/<meta\b[^>]*\bhttp-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
        if (this._nonce) {
            processedHtml = processedHtml.replace(/<script(?![^>]*\bnonce=)(\s[^>]*)?>/gi, `<script nonce="${this._nonce}"$1>`);
        }
        return processedHtml;
    }

    private async _handleMessage(message: any): Promise<void> {
        const hasKey = this._setupStitchApiKey();

        switch (message.type) {
            case 'ready': {
                const allRoots = this._getWorkspaceRoots();
                const items = buildWorkspaceItems(allRoots);
                const tabKeys = ['stitch', 'html-preview', 'images', 'design', 'html.root', 'design.root', 'briefs', 'briefs.root', 'stitch.root', 'images.root'];
                const statePayload = this._stateStore.getAllStates(tabKeys, allRoots);
                this.postMessage({
                    type: 'workspaceItemsUpdated',
                    items
                });
                this.postMessage({
                    type: 'restoredTabState',
                    panel: statePayload.panel,
                    byRoot: statePayload.byRoot
                });

                this.postMessage({ type: 'stitchApiKeyStatus', configured: hasKey });
                const themeConfig = vscode.workspace.getConfiguration('switchboard');
                this.postMessage({ type: 'switchboardThemeChanged', theme: themeConfig.get<string>('theme.name', 'afterburner') });
                this.postMessage({ type: 'cyberAnimationSetting', disabled: themeConfig.get<boolean>('theme.disableCyberAnimation', false) });
                await this._sendHtmlDocsReady();
                await this._sendDesignDocsReady();
                await this._sendImagesDocsReady();
                await this._sendBriefsDocsReady();
                await this._sendActiveDesignDocState();
                break;
            }

            case 'persistTabState': {
                const { tabKey, workspaceRoot: root, state } = message;
                if (tabKey) {
                    if (root) {
                        await this._stateStore.setRootState(tabKey, root, state);
                    } else {
                        await this._stateStore.setPanelState(tabKey, state);
                    }
                }
                break;
            }
            case 'setActivePlanningContext': {
                try {
                    const docPath = await this._resolveDesignDocPath(message.sourceFolder, String(message.docId || ''));
                    if (!docPath) {
                        this.postMessage({ type: 'activeContextSet', success: false, error: 'Document not found' });
                        break;
                    }
                    await vscode.workspace.getConfiguration('switchboard').update(
                        'planner.designSystemDocLink', docPath, vscode.ConfigurationTarget.Workspace
                    );
                    await vscode.workspace.getConfiguration('switchboard').update(
                        'planner.designSystemDocEnabled', true, vscode.ConfigurationTarget.Workspace
                    );
                    this._activeDesignSystemDocSourceId = message.sourceId;
                    this._activeDesignSystemDocId = message.docId;
                    await this._setPlannerDesignSystemAddon(true);
                    await this._sendActiveDesignDocState();
                    this.postMessage({ type: 'activeContextSet', success: true });
                } catch (err: any) {
                    this.postMessage({ type: 'activeContextSet', success: false, error: String(err) });
                }
                break;
            }

            case 'disableDesignDoc': {
                try {
                    await vscode.workspace.getConfiguration('switchboard').update(
                        'planner.designSystemDocEnabled', false, vscode.ConfigurationTarget.Workspace
                    );
                    await vscode.workspace.getConfiguration('switchboard').update(
                        'planner.designSystemDocLink', undefined, vscode.ConfigurationTarget.Workspace
                    );
                    this._activeDesignSystemDocSourceId = null;
                    this._activeDesignSystemDocId = null;
                    await this._setPlannerDesignSystemAddon(false);
                    await this._sendActiveDesignDocState();
                } catch (err: any) {
                    this.postMessage({ type: 'activeContextSet', success: false, error: String(err) });
                }
                break;
            }

            case 'saveFileContent': {
                const filePath = String(message.filePath || '');
                const content = String(message.content || '');
                const originalContent = String(message.originalContent || '');
                const tab = String(message.tab || '');
                const allRoots = this._getWorkspaceRoots();
                if (!filePath || !path.isAbsolute(filePath)) {
                    this.postMessage({ type: 'saveFileContentResult', success: false, error: 'Invalid file path', tab });
                    break;
                }
                const resolved = path.resolve(filePath);
                let isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r) + path.sep));
                if (!isAllowed) {
                    for (const r of allRoots) {
                        try {
                            const service = this._getLocalFolderService(r);
                            const allAllowedPaths = [
                                ...service.getDesignFolderPaths(),
                                ...service.getHtmlFolderPaths(),
                                ...service.getBriefsFolderPaths()
                            ];
                            if (allAllowedPaths.some(dp => resolved.startsWith(path.resolve(dp) + path.sep))) {
                                isAllowed = true;
                                break;
                            }
                        } catch {}
                    }
                }
                if (!isAllowed) {
                    this.postMessage({ type: 'saveFileContentResult', success: false, error: 'Invalid file path', tab });
                    break;
                }
                try {
                    // Conflict detection: compare disk content with the content the editor started from
                    let diskContent = '';
                    if (fs.existsSync(resolved)) {
                        diskContent = await fs.promises.readFile(resolved, 'utf8');
                    }
                    if (originalContent && diskContent !== originalContent) {
                        this.postMessage({ type: 'saveFileContentResult', success: false, conflict: true, diskContent, tab });
                        break;
                    }

                    // Validate JSON/YAML before write
                    const saveExt = path.extname(resolved).toLowerCase();
                    if (saveExt === '.json') {
                        try { JSON.parse(content); }
                        catch (e: any) {
                            this.postMessage({ type: 'saveFileContentResult', success: false, error: `Invalid JSON: ${e.message}`, tab });
                            break;
                        }
                    }
                    if (saveExt === '.yaml' || saveExt === '.yml') {
                        const yaml = require('js-yaml');
                        try { yaml.load(content); }
                        catch (e: any) {
                            this.postMessage({ type: 'saveFileContentResult', success: false, error: `Invalid YAML: ${e.message}`, tab });
                            break;
                        }
                    }

                    await fs.promises.writeFile(resolved, content, 'utf8');
                    this.postMessage({ type: 'saveFileContentResult', success: true, tab });
                } catch (err) {
                    this.postMessage({ type: 'saveFileContentResult', success: false, error: String(err), tab });
                }
                break;
            }

            case 'fetchPreview': {
                try {
                    const sourceFolder = message.sourceFolder;
                    if (!sourceFolder) throw new Error('sourceFolder is required');

                    // Tree node ids are `${folderIndex}:${relativePath}` — strip the prefix.
                    const rawDocId = String(message.docId || '');
                    const relativePath = rawDocId.includes(':')
                        ? rawDocId.substring(rawDocId.indexOf(':') + 1)
                        : rawDocId;

                    // Only configured design/html/briefs folders may be read from.
                    const allowedFolders = new Set<string>();
                    for (const root of this._getWorkspaceRoots()) {
                        try {
                            const svc = this._getLocalFolderService(root);
                            svc.getDesignFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                            svc.getHtmlFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                            svc.getBriefsFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                        } catch {}
                    }
                    const resolvedFolder = path.resolve(sourceFolder);
                    if (!allowedFolders.has(resolvedFolder)) {
                        throw new Error('sourceFolder is not a configured design/html/briefs folder');
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

                    // HTML previews are served from a localhost server so the iframe gets a
                    // real http origin — srcdoc (htmlContent) is only the fallback.
                    let iframeSrc: string | undefined;
                    if (isHtmlFile) {
                        try {
                            const serverEntry = await this._getOrCreateHtmlServer(resolvedFolder);
                            iframeSrc = this._buildLocalhostUrl(serverEntry, resolvedFolder, absPath);
                        } catch {
                            iframeSrc = undefined;
                        }
                    }

                    // Map extensions to the preview categories design.js switches on
                    // ('json' / 'yaml' / everything else renders as markdown).
                    const fileTypeMap: Record<string, string> = {
                        '.json': 'json',
                        '.yaml': 'yaml', '.yml': 'yaml',
                        '.md': 'markdown', '.markdown': 'markdown', '.txt': 'markdown'
                    };
                    const fileType = isImage ? 'image' : (fileTypeMap[fileExt] || 'text');

                    // YAML is parsed host-side; the webview renders the tree from parsedJson.
                    let parsedJson: any = undefined;
                    if (fileType === 'yaml') {
                        try {
                            const yaml = require('js-yaml');
                            parsedJson = yaml.load(fileContent);
                        } catch {}
                    }

                    this.postMessage({
                        type: 'previewReady',
                        sourceId: message.sourceId,
                        requestId: message.requestId,
                        content: isImage ? '' : fileContent,
                        docName: path.basename(relativePath),
                        filePath: absPath,
                        fileType,
                        parsedJson,
                        isImage,
                        webviewUri,
                        iframeSrc,
                        htmlContent: isHtmlFile ? this._injectLocalCsp(fileContent) : undefined
                    });
                } catch (err: any) {
                    this.postMessage({
                        type: 'previewError',
                        sourceId: message.sourceId,
                        requestId: message.requestId,
                        error: err.message || String(err)
                    });
                }
                break;
            }

            case 'linkToDocument': {
                // Tree node ids are `${folderIndex}:${relativePath}` — strip the prefix.
                const rawLinkId = String(message.docId || '');
                const linkRelativePath = rawLinkId.includes(':')
                    ? rawLinkId.substring(rawLinkId.indexOf(':') + 1)
                    : rawLinkId;
                const linkPath = message.sourceFolder
                    ? path.resolve(message.sourceFolder, linkRelativePath)
                    : linkRelativePath;
                vscode.env.clipboard.writeText(linkPath);
                vscode.window.showInformationMessage(`Copied document path to clipboard: ${linkPath}`);
                break;
            }

            case 'serveAndOpenHtml':
                try {
                    // Tree node ids are `${folderIndex}:${relativePath}` — strip the prefix.
                    const rawOpenId = String(message.docId || '');
                    const openRelativePath = rawOpenId.includes(':')
                        ? rawOpenId.substring(rawOpenId.indexOf(':') + 1)
                        : rawOpenId;
                    const fullPath = message.absolutePath
                        || path.resolve(message.sourceFolder || this._getWorkspaceRoot() || '', openRelativePath);
                    const serveFolder = message.sourceFolder || path.dirname(fullPath);
                    await fs.promises.access(fullPath, fs.constants.R_OK);
                    const entry = await this._getOrCreateHtmlServer(path.resolve(serveFolder));
                    const url = this._buildLocalhostUrl(entry, path.resolve(serveFolder), fullPath);
                    await vscode.env.openExternal(vscode.Uri.parse(url));
                } catch (err: any) {
                    vscode.window.showErrorMessage('Failed to serve HTML file: ' + err.message);
                }
                break;

            case 'stitchSaveApiKey':
                try {
                    const config = vscode.workspace.getConfiguration('switchboard');
                    await config.update('stitch.apiKey', message.apiKey, vscode.ConfigurationTarget.Global);
                    process.env.STITCH_API_KEY = message.apiKey;
                    this.postMessage({ type: 'stitchApiKeyStatus', configured: true });
                    vscode.window.showInformationMessage('Stitch API Key saved successfully.');
                } catch (err: any) {
                    vscode.window.showErrorMessage('Failed to save API key: ' + err.message);
                }
                break;

            case 'stitchListProjects':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (!hasKey) {
                        this.postMessage({ type: 'stitchApiKeyStatus', configured: false, workspaceRoot });
                        return;
                    }
                    const config = vscode.workspace.getConfiguration('switchboard');
                    const defaultProjectId = config.get<string>('stitch.defaultProjectId') || '';
                    const defaultModelId = config.get<string>('stitch.defaultModelId') || 'GEMINI_3_FLASH';
                    const defaultCreativeRange = config.get<string>('stitch.defaultCreativeRange') || 'EXPLORE';

                    const db = KanbanDatabase.forWorkspace(workspaceRoot);
                    const dbProjects = await db.getStitchProjects();

                    // If we have cached projects and forceRefresh is NOT set, serve from DB and exit.
                    if (dbProjects.length > 0 && !message.forceRefresh) {
                        this.postMessage({ type: 'stitchProjectsReady', projects: dbProjects, defaultProjectId, defaultModelId, defaultCreativeRange, workspaceRoot });
                        return;
                    }

                    // Otherwise fetch from API
                    const stitch = await loadStitch();
                    const list = await stitch.projects();
                    const projects = list.map((p: any) => ({
                        id: p.id,
                        name: p.data?.title || p.data?.name || p.id,
                        updateTime: p.data?.updateTime || p.data?.createTime || ''
                    }));

                    if (workspaceRoot) {
                        for (const p of projects) {
                            await db.upsertStitchProject(p.id, p.name, p.updateTime);
                        }
                    }
                    this.postMessage({ type: 'stitchProjectsReady', projects, defaultProjectId, defaultModelId, defaultCreativeRange, workspaceRoot });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchGetProjectScreens':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const projectId: string = message.projectId;

                    const db = KanbanDatabase.forWorkspace(workspaceRoot);
                    await db.ensureReady();

                    // --- Phase 1: serve from cache immediately ---
                    const cachedWithImage = new Set<string>(); // screens we already sent WITH an image
                    const cachedIds = new Set<string>();       // all screens we sent from cache

                    if (workspaceRoot) {
                        const cached = await db.getStitchScreensForProject(projectId);
                        if (cached.length > 0) {
                            const formatted = await Promise.all(cached.map(s => this._formatScreenFromCache(s, workspaceRoot)));
                            this.postMessage({ type: 'stitchScreensReady', screens: formatted, workspaceRoot });
                            for (const f of formatted) {
                                cachedIds.add(f.id);
                                if (f.imageUrl) cachedWithImage.add(f.id);
                            }
                        }
                    }

                    // --- Phase 2: fetch from API ---
                    const stitch = await loadStitch();
                    const allAssets = await stitch.project(projectId).screens();
                    // project.screens() returns ALL assets including reference uploads (images,
                    // documents, specs). Generated screens always have both a deviceType AND
                    // a screenMetadata object. Reference uploads may have one but not both.
                    const list = allAssets.filter((s: any) => !!s.data?.deviceType && s.data?.screenMetadata !== undefined && s.data?.screenMetadata !== null);
                    for (const screen of list) {
                        this._activeScreens.set(screen.id, screen);
                    }

                    // Update DB (append new screens, update statuses) using bulk upsert
                    if (workspaceRoot) {
                        const screensToUpsert = list.map((s: any) => ({
                            id: s.id,
                            projectId: s.projectId || projectId,
                            name: s.data?.title || s.data?.displayName || s.id,
                            deviceType: s.data?.deviceType || null,
                            status: s.data?.screenMetadata?.status || null,
                            statusMessage: s.data?.screenMetadata?.statusMessage || null
                        }));
                        await db.bulkUpsertStitchScreens(screensToUpsert);
                    }

                    // --- Phase 3: send what the cache couldn't cover ---
                    if (cachedIds.size === 0) {
                        // No cache at all — send every screen at once
                        const formatted = await Promise.all(list.map((s: any) => this._formatScreen(s, workspaceRoot)));
                        this.postMessage({ type: 'stitchScreensReady', screens: formatted, workspaceRoot });
                    } else {
                        // Cache was served — only fetch screens genuinely new (not in DB at all)
                        const needsUpdate = list.filter((s: any) => !cachedIds.has(s.id));
                        await Promise.all(needsUpdate.map(async (screen: any) => {
                            const formatted = await this._formatScreen(screen, workspaceRoot);
                            this.postMessage({ type: 'stitchScreenReady', screen: formatted, workspaceRoot });
                        }));
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchRebuildImageCache':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        const projectId: string = message.projectId;
                        if (!projectId) throw new Error('No project selected to rebuild cache');

                        const db = KanbanDatabase.forWorkspace(workspaceRoot);
                        await db.ensureReady();
                        const cached = await db.getStitchScreensForProject(projectId);

                        const cacheDir = this._getImageCacheDir(workspaceRoot);
                        for (const s of cached) {
                            const fileUri = vscode.Uri.file(
                                path.join(cacheDir, `${path.basename(s.id)}.png`)
                            );
                            try {
                                await vscode.workspace.fs.delete(fileUri);
                            } catch {
                                // ignore if not exist
                            }
                        }

                        const stitch = await loadStitch();
                        const formatted = await Promise.all(cached.map(async (s) => {
                            let screen = this._activeScreens.get(s.id);
                            if (!screen) {
                                screen = await stitch.project(projectId).getScreen(s.id);
                                this._activeScreens.set(s.id, screen);
                            }
                            return this._formatScreen(screen, workspaceRoot);
                        }));

                        this.postMessage({ type: 'stitchScreensReady', screens: formatted, workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchForceReloadScreens':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        const projectId: string = message.projectId;
                        if (!workspaceRoot) throw new Error('No workspace root available');
                        if (!projectId) throw new Error('No project selected to force reload');

                        const db = KanbanDatabase.forWorkspace(workspaceRoot);
                        await db.ensureReady();

                        const cached = await db.getStitchScreensForProject(projectId);
                        const cacheDir = this._getImageCacheDir(workspaceRoot);
                        for (const s of cached) {
                            const fileUri = vscode.Uri.file(path.join(cacheDir, `${path.basename(s.id)}.png`));
                            try { await vscode.workspace.fs.delete(fileUri); } catch { /* ignore if not exist */ }
                        }

                        await db.deleteStitchScreensForProject(projectId);

                        this._activeScreens.clear();

                        const stitch = await loadStitch();
                        const allAssets = await stitch.project(projectId).screens();
                        const list = allAssets.filter((s: any) => !!s.data?.deviceType && s.data?.screenMetadata !== undefined && s.data?.screenMetadata !== null);
                        for (const screen of list) {
                            this._activeScreens.set(screen.id, screen);
                        }

                        if (workspaceRoot) {
                            const screensToUpsert = list.map((s: any) => ({
                                id: s.id,
                                projectId: s.projectId || projectId,
                                name: s.data?.title || s.data?.displayName || s.id,
                                deviceType: s.data?.deviceType || null,
                                status: s.data?.screenMetadata?.status || null,
                                statusMessage: s.data?.screenMetadata?.statusMessage || null
                            }));
                            await db.bulkUpsertStitchScreens(screensToUpsert);
                        }

                        const formatted = await Promise.all(list.map((s: any) => this._formatScreen(s, workspaceRoot)));
                        this.postMessage({ type: 'stitchScreensReady', screens: formatted, workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchCreateProject':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        const title = await vscode.window.showInputBox({
                            prompt: 'Title for the new Stitch project',
                            placeHolder: 'e.g. Onboarding Redesign'
                        });
                        if (!title) return; // user dismissed the input — nothing to do
                        const stitch = await loadStitch();
                        const project = await stitch.createProject(title);
                        const list = await stitch.projects();
                        const projects = list.map((p: any) => ({
                            id: p.id,
                            name: p.data?.title || p.data?.name || p.id,
                            updateTime: p.data?.updateTime || p.data?.createTime || ''
                        }));
                        // Persist the freshly created project (and any others) so the cache-gated
                        // stitchListProjects path serves it on next panel open without a forceRefresh.
                        if (workspaceRoot) {
                            const db = KanbanDatabase.forWorkspace(workspaceRoot);
                            for (const p of projects) {
                                await db.upsertStitchProject(p.id, p.name, p.updateTime);
                            }
                        }
                        // Pass the new project as the default so the webview auto-selects it.
                        this.postMessage({ type: 'stitchProjectsReady', projects, defaultProjectId: project.id, selectProjectId: project.id, workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchRefreshScreen':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (!message.projectId || !message.screenId) throw new Error('Missing project or screen id');
                    const stitch = await loadStitch();
                    const fresh = await stitch.project(message.projectId).getScreen(message.screenId);
                    this._activeScreens.set(fresh.id, fresh);
                    this.postMessage({ type: 'stitchScreenReady', screen: await this._formatScreen(fresh, workspaceRoot), workspaceRoot });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;
            case 'stitchOpenManifest':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No active workspace root found');
                    const manifestPath = path.join(this._getStitchOutputDir(workspaceRoot), 'DESIGN.md');
                    if (!fs.existsSync(manifestPath)) {
                        if (!message.projectId) throw new Error('No project selected to generate DESIGN.md');
                        const stitch = await loadStitch();
                        const projectInstance = stitch.project(message.projectId);
                        const screens = await projectInstance.screens();

                        const outputDir = this._getStitchOutputDir(workspaceRoot);
                        await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));

                        let designMd = `# Design Handoff - Project ${message.projectId}\n\n`;
                        designMd += `Sync timestamp (on-demand): ${new Date().toISOString()}\n\n`;
                        designMd += `## Screens\n\n`;

                        const skipped: string[] = [];
                        for (const s of screens) {
                            const screenName = s.data?.title || s.data?.displayName || s.id;
                            const htmlUrl = await s.getHtml();
                            const imageUrl = await s.getImage();

                            if (!htmlUrl || !imageUrl) {
                                skipped.push(screenName);
                                continue;
                            }

                            designMd += `### ${screenName}\n`;
                            designMd += `- Device: ${s.data?.deviceType || 'AGNOSTIC'}\n`;
                            designMd += `- HTML Link: [Open HTML](${htmlUrl})\n`;
                            designMd += `- Image: ![${screenName}](${imageUrl})\n\n`;
                        }
                        if (skipped.length > 0) {
                            designMd += `> Skipped (no download URLs yet): ${skipped.join(', ')}\n\n`;
                        }

                        try {
                            const designSystems = await projectInstance.listDesignSystems();
                            if (designSystems && designSystems.length > 0) {
                                designMd += `## Design Systems\n\n`;
                                for (const ds of designSystems) {
                                    designMd += `### ${ds.data?.displayName || ds.data?.name || ds.id}\n\n`;
                                    const tokens = ds.data?.designTokens;
                                    if (tokens) {
                                        designMd += '```\n' + String(tokens) + '\n```\n\n';
                                    } else if (ds.data) {
                                        designMd += '```json\n' + JSON.stringify(ds.data, null, 2) + '\n```\n\n';
                                    }
                                }
                            }
                        } catch {
                            designMd += `> Design systems could not be fetched for this project.\n\n`;
                        }

                        await vscode.workspace.fs.writeFile(vscode.Uri.file(manifestPath), Buffer.from(designMd, 'utf8'));
                    }
                    await vscode.window.showTextDocument(vscode.Uri.file(manifestPath), { preview: false });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchDownloadPalette':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No active workspace root found');
                    if (!message.projectId) throw new Error('No project selected');

                    const stitch = await loadStitch();
                    const projectInstance = stitch.project(message.projectId);
                    const designSystems = await projectInstance.listDesignSystems();

                    let outputDir = this._getStitchOutputDir(workspaceRoot);
                    if (message.destination) {
                        const resolvedDest = path.resolve(message.destination);
                        const allRoots = this._getWorkspaceRoots();
                        let isAllowed = allRoots.some(r => resolvedDest === path.resolve(r) || resolvedDest.startsWith(path.resolve(r) + path.sep));
                        if (!isAllowed) {
                            throw new Error('Invalid download destination folder path');
                        }
                        outputDir = resolvedDest;
                    }
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));

                    const tokens: any = {};
                    if (designSystems && designSystems.length > 0) {
                        for (const ds of designSystems) {
                            if (ds.data?.designTokens) {
                                tokens[ds.data.displayName || ds.data.name || ds.id] = ds.data.designTokens;
                            } else if (ds.data) {
                                tokens[ds.data.displayName || ds.data.name || ds.id] = ds.data;
                            }
                        }
                    }

                    const targetPath = path.join(outputDir, 'design-tokens.json');
                    await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(JSON.stringify(tokens, null, 2), 'utf8'));

                    vscode.window.showInformationMessage(`Downloaded design tokens to ${path.basename(outputDir)}/design-tokens.json`);
                } catch (err: any) {
                    vscode.window.showErrorMessage('Download failed: ' + err.message);
                }
                break;

            case 'listDesignFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getDesignFolderPaths();
                this.postMessage({ type: 'designFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'addDesignFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add Design Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addDesignFolderPath(result[0].fsPath);
                    this._setupDesignFolderWatchers();
                    await this._sendDesignDocsReady();
                    this.postMessage({ type: 'designFoldersListed', paths: service.getDesignFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeDesignFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeDesignFolderPath(message.folderPath);
                this._setupDesignFolderWatchers();
                await this._sendDesignDocsReady();
                this.postMessage({ type: 'designFoldersListed', paths: service.getDesignFolderPaths(), workspaceRoot: root });
                break;
            }

            case 'listHtmlFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getHtmlFolderPaths();
                this.postMessage({ type: 'htmlFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'addHtmlFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add HTML Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addHtmlFolderPath(result[0].fsPath);
                    this._setupHtmlFolderWatchers();
                    await this._sendHtmlDocsReady();
                    this.postMessage({ type: 'htmlFoldersListed', paths: service.getHtmlFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeHtmlFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeHtmlFolderPath(message.folderPath);
                this._setupHtmlFolderWatchers();
                await this._sendHtmlDocsReady();
                this.postMessage({ type: 'htmlFoldersListed', paths: service.getHtmlFolderPaths(), workspaceRoot: root });
                break;
            }

            case 'listImagesFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getImagesFolderPaths();
                this.postMessage({ type: 'imagesFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'addImagesFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add Images Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addImagesFolderPath(result[0].fsPath);
                    this._setupImagesFolderWatchers();
                    await this._sendImagesDocsReady();
                    this.postMessage({ type: 'imagesFoldersListed', paths: service.getImagesFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeImagesFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeImagesFolderPath(message.folderPath);
                this._setupImagesFolderWatchers();
                await this._sendImagesDocsReady();
                this.postMessage({ type: 'imagesFoldersListed', paths: service.getImagesFolderPaths(), workspaceRoot: root });
                break;
            }

            case 'listStitchFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getStitchFolderPaths();
                this.postMessage({ type: 'stitchFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'addStitchFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add Stitch Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addStitchFolderPath(result[0].fsPath);
                    this.postMessage({ type: 'stitchFoldersListed', paths: service.getStitchFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeStitchFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeStitchFolderPath(message.folderPath);
                this.postMessage({ type: 'stitchFoldersListed', paths: service.getStitchFolderPaths(), workspaceRoot: root });
                break;
            }

            case 'listBriefsFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getBriefsFolderPaths();
                this.postMessage({ type: 'briefsFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'addBriefsFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add Briefs Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addBriefsFolderPath(result[0].fsPath);
                    this._setupBriefsFolderWatchers();
                    await this._sendBriefsDocsReady();
                    this.postMessage({ type: 'briefsFoldersListed', paths: service.getBriefsFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeBriefsFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeBriefsFolderPath(message.folderPath);
                this._setupBriefsFolderWatchers();
                await this._sendBriefsDocsReady();
                this.postMessage({ type: 'briefsFoldersListed', paths: service.getBriefsFolderPaths(), workspaceRoot: root });
                break;
            }
            case 'createBrief': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const sourceFolder = message.sourceFolder;
                const title = message.title;
                if (!sourceFolder || !title) {
                    this.postMessage({ type: 'briefCreated', success: false, error: 'Source folder and title are required' });
                    break;
                }
                try {
                    const service = this._getLocalFolderService(root);
                    const resolvedSource = path.resolve(sourceFolder);
                    const isAllowed = service.getBriefsFolderPaths().some(p => path.resolve(p) === resolvedSource);
                    if (!isAllowed) {
                        this.postMessage({ type: 'briefCreated', success: false, error: 'Source folder is not a configured briefs folder' });
                        break;
                    }
                    let fileName = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                    if (!fileName) {
                        fileName = 'untitled';
                    }
                    fileName = fileName + '.md';
                    const fullPath = path.join(sourceFolder, fileName);
                    
                    let finalPath = fullPath;
                    let counter = 1;
                    while (fs.existsSync(finalPath)) {
                        finalPath = path.join(sourceFolder, `${path.basename(fileName, '.md')}-${counter}.md`);
                        counter++;
                    }
                    
                    const content = `# ${title}\n\n`;
                    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
                    await fs.promises.writeFile(finalPath, content, 'utf8');
                    
                    const folderPaths = service.getBriefsFolderPaths();
                    const folderIndex = folderPaths.findIndex(p => path.resolve(p) === resolvedSource);
                    
                    await this._sendBriefsDocsReady();
                    this.postMessage({ 
                        type: 'briefCreated', 
                        success: true,
                        docId: folderIndex >= 0 ? `${folderIndex}:${path.relative(sourceFolder, finalPath)}` : undefined,
                        sourceFolder: sourceFolder
                    });
                } catch (err: any) {
                    this.postMessage({ type: 'briefCreated', success: false, error: String(err) });
                }
                break;
            }
            case 'deleteBrief': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const sourceFolder = message.sourceFolder;
                const docId = message.docId;
                if (!sourceFolder || !docId) {
                    this.postMessage({ type: 'briefDeleted', success: false, error: 'Source folder and docId are required' });
                    break;
                }
                try {
                    const relativePath = docId.includes(':')
                        ? docId.substring(docId.indexOf(':') + 1)
                        : docId;
                    
                    const resolvedFolder = path.resolve(sourceFolder);
                    const absPath = path.resolve(resolvedFolder, relativePath);
                    if (absPath !== resolvedFolder && !absPath.startsWith(resolvedFolder + path.sep)) {
                        throw new Error('Invalid path traversal');
                    }
                    
                    const service = this._getLocalFolderService(root);
                    if (!service.getBriefsFolderPaths().map(p => path.resolve(p)).includes(resolvedFolder)) {
                        throw new Error('Folder is not a configured briefs folder');
                    }
                    
                    if (fs.existsSync(absPath)) {
                        await fs.promises.unlink(absPath);
                    }
                    await this._sendBriefsDocsReady();
                    this.postMessage({ type: 'briefDeleted', success: true });
                } catch (err: any) {
                    this.postMessage({ type: 'briefDeleted', success: false, error: String(err) });
                }
                break;
            }
            case 'fetchBriefForInjection': {
                try {
                    const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                    const sourceFolder = message.sourceFolder;
                    if (!sourceFolder) throw new Error('sourceFolder is required');
                    
                    const rawDocId = String(message.docId || '');
                    const relativePath = rawDocId.includes(':')
                        ? rawDocId.substring(rawDocId.indexOf(':') + 1)
                        : rawDocId;
                    
                    const resolvedFolder = path.resolve(sourceFolder);
                    const absPath = path.resolve(resolvedFolder, relativePath);
                    if (absPath !== resolvedFolder && !absPath.startsWith(resolvedFolder + path.sep)) {
                        throw new Error('Invalid file path');
                    }
                    
                    const service = this._getLocalFolderService(root);
                    if (!service.getBriefsFolderPaths().map(p => path.resolve(p)).includes(resolvedFolder)) {
                        throw new Error('Folder is not configured briefs folder');
                    }

                    const content = await fs.promises.readFile(absPath, 'utf8');
                    this.postMessage({
                        type: 'briefContentForInjectionReady',
                        content
                    });
                } catch (err: any) {
                    vscode.window.showErrorMessage('Failed to fetch brief: ' + err.message);
                }
                break;
            }

            case 'stitchGenerate':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        // The SDK has no root-level generate — a project is required.
                        if (!message.projectId) {
                            this.postMessage({ type: 'stitchError', error: 'Select a Stitch project before generating a screen.', workspaceRoot });
                            return;
                        }
                        const stitch = await loadStitch();
                        const projectInstance = stitch.project(message.projectId);
                        const screen = await projectInstance.generate(message.prompt, message.deviceType, message.modelId);
                        this._activeScreens.set(screen.id, screen);
                        this.postMessage({ type: 'stitchScreenReady', screen: await this._formatScreen(screen, workspaceRoot), workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchEdit':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        const screen = this._activeScreens.get(message.screenId);
                        if (!screen) throw new Error('Screen instance not found in memory cache.');
                        const updated = await screen.edit(message.prompt, undefined, message.modelId);
                        this._activeScreens.set(updated.id, updated);
                        this.postMessage({ type: 'stitchScreenReady', screen: await this._formatScreen(updated, workspaceRoot), workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchVariants':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        const screen = this._activeScreens.get(message.screenId);
                        if (!screen) throw new Error('Screen instance not found in memory cache.');
                        const aspects = message.aspects?.length ? message.aspects : undefined;
                        const variantOptions = {
                            variantCount: message.count || 3,
                            creativeRange: message.creativeRange,
                            aspects
                        };
                        const list = await screen.variants(message.prompt, variantOptions, undefined, message.modelId);
                        const formatted = await Promise.all(list.map(async (v: any) => {
                            this._activeScreens.set(v.id, v);
                            return this._formatScreen(v, workspaceRoot);
                        }));
                        this.postMessage({ type: 'stitchScreensReady', screens: formatted, workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchDownloadAsset':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No active workspace root found');
                    if (!message.url) {
                        throw new Error('No download URL is available for this asset yet — reload the project screens and try again.');
                    }

                    // basename() so a webview-supplied filename can't traverse out of the output dir
                    const safeFilename = path.basename(String(message.filename));
                    const isPng = safeFilename.endsWith('.png');
                    
                    let outputDir = this._getStitchOutputDir(workspaceRoot);
                    if (message.destination) {
                        const resolvedDest = path.resolve(message.destination);
                        const allRoots = this._getWorkspaceRoots();
                        let isAllowed = allRoots.some(r => resolvedDest === path.resolve(r) || resolvedDest.startsWith(path.resolve(r) + path.sep));
                        if (!isAllowed) {
                            throw new Error('Invalid download destination folder path');
                        }
                        outputDir = resolvedDest;
                    }
                    
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));

                    const targetPath = path.join(outputDir, safeFilename);

                    if (message.url.startsWith('file://')) {
                        const fileUri = vscode.Uri.parse(message.url);
                        const buffer = Buffer.from(await vscode.workspace.fs.readFile(fileUri));
                        await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), buffer);
                    } else {
                        const res = await fetch(message.url);
                        if (isPng) {
                            const buffer = Buffer.from(await res.arrayBuffer());
                            await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), buffer);
                        } else {
                            const text = await res.text();
                            await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(text, 'utf8'));
                        }
                    }

                    vscode.window.showInformationMessage(`Downloaded ${safeFilename} to ${path.basename(outputDir)}/`);
                } catch (err: any) {
                    vscode.window.showErrorMessage('Download failed: ' + err.message);
                }
                break;
        }
    }
}
