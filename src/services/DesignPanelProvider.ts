
import { HostSeams, createVscodeHostSeams } from './hostSeams';
import { BroadcastHub } from './broadcastHub';
import { DesignService, DesignServiceContext } from './designService';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { showTemporaryNotification } from '../utils/showTemporaryNotification';
import { applyThemeBodyClass } from './themeBodyClass';
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
function loadStitch(_accessToken: string): Promise<any> {
    if (!_stitchSdkPromise) {
        _stitchSdkPromise = import(/* webpackMode: "eager" */ '@google/stitch-sdk').then(m => m.stitch);
    }
    return _stitchSdkPromise;
}

export function invalidateStitchSdkCache(): void {
    _stitchSdkPromise = undefined;
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

    public async handleServiceVerb(verb: string, payload: any): Promise<any> {
        if (!this._designService) {
            this._initDesignService();
        }
        const svc = this._designService;
        if (!svc) {
            throw new Error('DesignService unavailable — no workspace root resolved');
        }
        const p = payload ?? {};
        switch (verb) {
            default:
                throw new Error(`Unknown or not-yet-extracted Design verb: '${verb}'`);
            case 'activeTabChanged': return await svc['activeTabChanged'](p);
            case 'addBriefsFolder': return await svc['addBriefsFolder'](p);
            case 'addClaudeFolder': return await svc['addClaudeFolder'](p);
            case 'addDesignFolder': return await svc['addDesignFolder'](p);
            case 'addHtmlFolder': return await svc['addHtmlFolder'](p);
            case 'addImagesFolder': return await svc['addImagesFolder'](p);
            case 'addStitchFolder': return await svc['addStitchFolder'](p);
            case 'briefs': return await svc['briefs'](p);
            case 'claude': return await svc['claude'](p);
            case 'copyClaudeArtifactPrompt': return await svc['copyClaudeArtifactPrompt'](p);
            case 'copyClaudeImportPrompt': return await svc['copyClaudeImportPrompt'](p);
            case 'createBrief': return await svc['createBrief'](p);
            case 'deleteBrief': return await svc['deleteBrief'](p);
            case 'disableDesignDoc': return await svc['disableDesignDoc'](p);
            case 'fetchPreview': return await svc['fetchPreview'](p);
            case 'html-preview': return await svc['html-preview'](p);
            case 'images': return await svc['images'](p);
            case 'inspectRequestDataUrl': return await svc['inspectRequestDataUrl'](p);
            case 'linkToDocument': return await svc['linkToDocument'](p);
            case 'linkToFolder': return await svc['linkToFolder'](p);
            case 'listBriefsFolders': return await svc['listBriefsFolders'](p);
            case 'listClaudeFolders': return await svc['listClaudeFolders'](p);
            case 'listDesignFolders': return await svc['listDesignFolders'](p);
            case 'listHtmlFolders': return await svc['listHtmlFolders'](p);
            case 'listImagesFolders': return await svc['listImagesFolders'](p);
            case 'listStitchFolders': return await svc['listStitchFolders'](p);
            case 'persistTabState': return await svc['persistTabState'](p);
            case 'ready': return await svc['ready'](p);
            case 'refreshDocsForTab': return await svc['refreshDocsForTab'](p);
            case 'removeBriefsFolder': return await svc['removeBriefsFolder'](p);
            case 'removeClaudeFolder': return await svc['removeClaudeFolder'](p);
            case 'removeDesignFolder': return await svc['removeDesignFolder'](p);
            case 'removeHtmlFolder': return await svc['removeHtmlFolder'](p);
            case 'removeImagesFolder': return await svc['removeImagesFolder'](p);
            case 'removeStitchFolder': return await svc['removeStitchFolder'](p);
            case 'renderMarkdownLive': return await svc['renderMarkdownLive'](p);
            case 'saveFileContent': return await svc['saveFileContent'](p);
            case 'sendClaudeArtifactPrompt': return await svc['sendClaudeArtifactPrompt'](p);
            case 'sendClaudeImportPrompt': return await svc['sendClaudeImportPrompt'](p);
            case 'serveAndOpenHtml': return await svc['serveAndOpenHtml'](p);
            case 'setActivePlanningContext': return await svc['setActivePlanningContext'](p);
            case 'stitchApplyDesignSystem': return await svc['stitchApplyDesignSystem'](p);
            case 'stitchCreateDesignSystem': return await svc['stitchCreateDesignSystem'](p);
            case 'stitchCreateProject': return await svc['stitchCreateProject'](p);
            case 'stitchDownloadAsset': return await svc['stitchDownloadAsset'](p);
            case 'stitchDownloadPalette': return await svc['stitchDownloadPalette'](p);
            case 'stitchEdit': return await svc['stitchEdit'](p);
            case 'stitchForceReloadScreens': return await svc['stitchForceReloadScreens'](p);
            case 'stitchGenerate': return await svc['stitchGenerate'](p);
            case 'stitchGetProjectScreens': return await svc['stitchGetProjectScreens'](p);
            case 'stitchListDesignSystems': return await svc['stitchListDesignSystems'](p);
            case 'stitchListProjects': return await svc['stitchListProjects'](p);
            case 'stitchOpenManifest': return await svc['stitchOpenManifest'](p);
            case 'stitchPickAttachFiles': return await svc['stitchPickAttachFiles'](p);
            case 'stitchRebuildImageCache': return await svc['stitchRebuildImageCache'](p);
            case 'stitchRefreshScreen': return await svc['stitchRefreshScreen'](p);
            case 'stitchSaveApiKey': return await svc['stitchSaveApiKey'](p);
            case 'stitchSaveAuthConfig': return await svc['stitchSaveAuthConfig'](p);
            case 'stitchSendBrief': return await svc['stitchSendBrief'](p);
            case 'stitchUpdateDesignSystem': return await svc['stitchUpdateDesignSystem'](p);
            case 'stitchValidateAuth': return await svc['stitchValidateAuth'](p);
            case 'stitchVariants': return await svc['stitchVariants'](p);
            case 'toggleStitchHtmlPreview': return await svc['toggleStitchHtmlPreview'](p);
        }
    }


    private _initDesignService(): void {
        const workspaceRoot = this._getWorkspaceRoot() || '';
        if (!workspaceRoot) {
            this._hostSeams = undefined;
            this._broadcaster = undefined;
            this._designService = undefined;
            return;
        }
        this._hostSeams = createVscodeHostSeams(workspaceRoot);
        if (!this._broadcaster) {
            this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: null });
        } else {
            this._broadcaster.setWebview(this._panel?.webview);
        }
        const ctx: DesignServiceContext = {
            workspaceRoot,
            seams: this._hostSeams,
            broadcaster: this._broadcaster,
            handleMessage: async (msg) => this._handleMessage(msg),
        };
        if (this._designService) {
            this._designService.setContext(ctx);
        } else {
            this._designService = new DesignService(ctx);
        }
    }

    public setApiServer(server: any): void {
        this._broadcaster?.setApiServer(server);
    }

    private _hostSeams?: HostSeams;
    private _broadcaster?: BroadcastHub;
    private _designService?: DesignService;

    private _panel?: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _nonce: string = '';
    private _htmlFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _claudeFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _designFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _imagesFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _briefsFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _saveTextDocListener?: vscode.Disposable;
    private _htmlDocsDebounce?: NodeJS.Timeout;
    private _claudeDocsDebounce?: NodeJS.Timeout;
    private _designDocsDebounce?: NodeJS.Timeout;
    private _imagesDocsDebounce?: NodeJS.Timeout;
    private _briefsDocsDebounce?: NodeJS.Timeout;
    private _activeTab: string = '';
    private _externalFilePollTimer?: NodeJS.Timeout;
    private _lastFolderSignature: Record<string, string> = {}; // keyed by tab name
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
    private _activeHtmlPreview: { sourceFolder: string; docId: string; sourceId: string } | null = null;
    private _activeClaudePreview: { sourceFolder: string; docId: string; sourceId: string } | null = null;
    private _autoRefreshDebounce?: NodeJS.Timeout;

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
            this._stopExternalFilePoll();
        }, null, this._disposables);

        this._panel.onDidChangeViewState(e => this._onVisibilityChanged(e.webviewPanel.visible), null, this._disposables);

        this._setupHtmlFolderWatchers();
        this._setupClaudeFolderWatchers();
        this._setupDesignFolderWatchers();
        this._setupImagesFolderWatchers();
        this._setupBriefsFolderWatchers();
        this._registerSaveTextDocListener();

        this._disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(async () => {
                this.postMessage({
                    type: 'workspaceItemsUpdated',
                    items: buildWorkspaceItems(this._getWorkspaceRoots())
                });
                this.disposeWatchers();
                this._setupHtmlFolderWatchers();
                this._setupClaudeFolderWatchers();
                this._setupDesignFolderWatchers();
                this._setupImagesFolderWatchers();
                this._setupBriefsFolderWatchers();
                await this._sendHtmlDocsReady();
                await this._sendClaudeDocsReady();
                await this._sendDesignDocsReady();
                await this._sendImagesDocsReady();
                await this._sendBriefsDocsReady();
            })
        );

        if (!this._themeListenersRegistered) {
            this._themeListenersRegistered = true;
            this._disposables.push(
                vscode.window.onDidChangeActiveColorTheme(() => {
                    this.postMessage({ type: 'themeChanged' });
                })
            );
            this._disposables.push(
                vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
                        const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
                        this.postMessage({ type: 'cyberAnimationSetting', disabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
                        const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
                        this.postMessage({ type: 'cyberScanlinesSetting', disabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.name')) {
                        const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                        this.postMessage({ type: 'switchboardThemeChanged', theme });
                    }
                    if (e.affectsConfiguration('switchboard.theme.pixelFont')) {
                        const enabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.pixelFont', true);
                        this.postMessage({ type: 'pixelFontSetting', enabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.ultracodeAnimation')) {
                        const enabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.ultracodeAnimation', false);
                        this.postMessage({ type: 'ultracodeAnimationSetting', enabled });
                    }
                    if (e.affectsConfiguration('switchboard.design.externalFilePollMs')) {
                        this._stopExternalFilePoll();
                        if (this._panel?.visible && this._isPolledTab(this._activeTab)) {
                            this._startExternalFilePoll();
                        }
                    }
                })
            );
        }
    }

    public async deserializeWebviewPanel(
        panel: vscode.WebviewPanel,
        state: any
    ): Promise<void> {
        this._panel = panel;
        // Reset webview options to the CURRENT extensionUri before loading html. VS Code
        // persists the localResourceRoots from the original panel, but after an extension
        // update those URIs point at the previous version's install dir (404 → blocked
        // scripts on the restored panel). Re-applying them keeps restored panels working
        // across updates. Mirrors the localResourceRoots set in open().
        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'dist'),
                vscode.Uri.joinPath(this._extensionUri, 'webview'),
                vscode.Uri.joinPath(this._extensionUri, 'designs'),
                vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
                ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri)
            ]
        };
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
            this._stopExternalFilePoll();
        }, null, this._disposables);

        this._panel.onDidChangeViewState(e => this._onVisibilityChanged(e.webviewPanel.visible), null, this._disposables);

        this._setupHtmlFolderWatchers();
        this._setupClaudeFolderWatchers();
        this._setupDesignFolderWatchers();
        this._setupImagesFolderWatchers();
        this._setupBriefsFolderWatchers();
        this._registerSaveTextDocListener();

        // Replicate the workspace-folder-change listener from open() so restored
        // panels react to workspace changes (refreshes content and re-wires watchers).
        this._disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(async () => {
                this.postMessage({
                    type: 'workspaceItemsUpdated',
                    items: buildWorkspaceItems(this._getWorkspaceRoots())
                });
                this.disposeWatchers();
                this._setupHtmlFolderWatchers();
                this._setupClaudeFolderWatchers();
                this._setupDesignFolderWatchers();
                this._setupImagesFolderWatchers();
                this._setupBriefsFolderWatchers();
                await this._sendHtmlDocsReady();
                await this._sendClaudeDocsReady();
                await this._sendDesignDocsReady();
                await this._sendImagesDocsReady();
                await this._sendBriefsDocsReady();
            })
        );

        if (!this._themeListenersRegistered) {
            this._themeListenersRegistered = true;
            this._disposables.push(
                vscode.window.onDidChangeActiveColorTheme(() => {
                    this.postMessage({ type: 'themeChanged' });
                })
            );
            this._disposables.push(
                vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
                        const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
                        this.postMessage({ type: 'cyberAnimationSetting', disabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
                        const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
                        this.postMessage({ type: 'cyberScanlinesSetting', disabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.name')) {
                        const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                        this.postMessage({ type: 'switchboardThemeChanged', theme });
                    }
                    if (e.affectsConfiguration('switchboard.theme.pixelFont')) {
                        const enabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.pixelFont', true);
                        this.postMessage({ type: 'pixelFontSetting', enabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.ultracodeAnimation')) {
                        const enabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.ultracodeAnimation', false);
                        this.postMessage({ type: 'ultracodeAnimationSetting', enabled });
                    }
                    if (e.affectsConfiguration('switchboard.design.externalFilePollMs')) {
                        this._stopExternalFilePoll();
                        if (this._panel?.visible && this._isPolledTab(this._activeTab)) {
                            this._startExternalFilePoll();
                        }
                    }
                })
            );
        }
    }


    public postMessage(message: any): void {
        if (this._broadcaster) {
            this._broadcaster.push(message);
        } else {
            this._panel?.webview.postMessage(message);
        }
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
        this._saveTextDocListener?.dispose();
        this._saveTextDocListener = undefined;
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables = [];
        if (this._autoRefreshDebounce) {
            clearTimeout(this._autoRefreshDebounce);
            this._autoRefreshDebounce = undefined;
        }
    }

    private disposeWatchers(): void {
        this._htmlFolderWatchers.forEach(w => w.dispose());
        this._htmlFolderWatchers = [];
        this._claudeFolderWatchers.forEach(w => w.dispose());
        this._claudeFolderWatchers = [];
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

        const markdownEditorUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'markdownEditor.js')
        );
        htmlContent = htmlContent.replace(/\{\{MARKDOWN_EDITOR_URI\}\}/g, markdownEditorUri.toString());

        const inspectJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'inspect.js')
        );
        htmlContent = htmlContent.replace(/\{\{INSPECT_JS_URI\}\}/g, inspectJsUri.toString());

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
                        watcher.onDidChange((uri) => {
                            this._sendHtmlDocsReady();
                            this._autoRefreshHtmlPreview(uri);
                        });
                        watcher.onDidCreate((uri) => {
                            this._sendHtmlDocsReady();
                            this._autoRefreshHtmlPreview(uri);
                        });
                        watcher.onDidDelete(() => this._sendHtmlDocsReady());
                        this._htmlFolderWatchers.push(watcher);
                    }
                }
            } catch {}
        }
    }

    private _setupClaudeFolderWatchers(): void {
        this._claudeFolderWatchers.forEach(w => w.dispose());
        this._claudeFolderWatchers = [];
        const roots = this._getWorkspaceRoots();
        for (const root of roots) {
            try {
                const service = this._getLocalFolderService(root);
                const paths = service.getClaudeFolderPaths();
                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        const pattern = new vscode.RelativePattern(p, '**/*');
                        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                        watcher.onDidChange((uri) => {
                            this._sendClaudeDocsReady();
                            // _autoRefreshHtmlPreview already checks _activeClaudePreview, so it
                            // covers Claude-tab auto-refresh too.
                            this._autoRefreshHtmlPreview(uri);
                        });
                        watcher.onDidCreate((uri) => {
                            this._sendClaudeDocsReady();
                            this._autoRefreshHtmlPreview(uri);
                        });
                        watcher.onDidDelete(() => this._sendClaudeDocsReady());
                        this._claudeFolderWatchers.push(watcher);
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

                this.postMessage({
                    type: 'htmlDocsReady',
                    sourceId: 'html-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this.postMessage({
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

    private async _sendClaudeDocsReady(): Promise<void> {
        if (this._claudeDocsDebounce) {
            clearTimeout(this._claudeDocsDebounce);
        }
        this._claudeDocsDebounce = setTimeout(async () => {
            this._claudeDocsDebounce = undefined;
            try {
                const allRoots = this._getWorkspaceRoots();
                const allFiles: any[] = [];
                const seenFilePaths = new Set<string>();
                const configuredFolderPathsByRoot: Record<string, string[]> = {};

                for (const root of allRoots) {
                    try {
                        const localFolderService = this._getLocalFolderService(root);
                        const folderPaths = localFolderService.getClaudeFolderPaths();
                        configuredFolderPathsByRoot[root] = folderPaths;

                        const files = await localFolderService.listClaudeFiles();
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

                this.postMessage({
                    type: 'claudeDocsReady',
                    sourceId: 'claude-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this.postMessage({
                    type: 'claudeDocsReady',
                    sourceId: 'claude-folder',
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

                this.postMessage({
                    type: 'designDocsReady',
                    sourceId: 'design-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this.postMessage({
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

                this.postMessage({
                    type: 'imagesDocsReady',
                    sourceId: 'images-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this.postMessage({
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

                this.postMessage({
                    type: 'briefsDocsReady',
                    sourceId: 'briefs-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                });
            } catch (err) {
                this.postMessage({
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
                // Include the Stitch assets directory (where screen PNGs live) in resource roots
                try {
                    folderUris.push(vscode.Uri.file(this._getImageCacheDir(r)));
                } catch {}
            } catch {}
        }

        const rawRoots = [
            vscode.Uri.joinPath(this._extensionUri, 'dist'),
            vscode.Uri.joinPath(this._extensionUri, 'webview'),
            vscode.Uri.joinPath(this._extensionUri, 'designs'),
            vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
            ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri),
            ...folderUris
        ];

        // Deduplicate by stringified URI — prevents spurious signature changes when
        // the same path is pushed by multiple sources (e.g. getHtmlFolderPaths + _getImageCacheDir).
        const seenRoots = new Set<string>();
        const localResourceRoots = rawRoots.filter(u => {
            const key = u.toString();
            if (seenRoots.has(key)) return false;
            seenRoots.add(key);
            return true;
        });

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
        let imagePath = '';
        try {
            await vscode.workspace.fs.stat(fileUri);
            imageUrl = this._panel?.webview.asWebviewUri(fileUri).toString() || '';
            imagePath = fileUri.fsPath;
        } catch {}
        return {
            id: cached.id,
            projectId: cached.projectId,
            name: cached.name,
            deviceType: cached.deviceType,
            imageUrl,
            imagePath,
            htmlUrl: '',
            htmlPath: await this._getStitchHtmlPath(cached.id, workspaceRoot),
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

    // Returns the on-disk path of a screen's downloaded HTML, or '' if it hasn't been
    // downloaded yet. HTML (unlike the PNG) is fetched on demand, not auto-cached.
    private async _getStitchHtmlPath(screenId: string, workspaceRoot: string): Promise<string> {
        if (!workspaceRoot) return '';
        const htmlPath = path.join(this._getImageCacheDir(workspaceRoot), `${path.basename(screenId)}.html`);
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(htmlPath));
            return htmlPath;
        } catch {
            return '';
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
        let imagePath = '';
        if (workspaceRoot) {
            const candidate = path.join(this._getImageCacheDir(workspaceRoot), `${path.basename(screen.id)}.png`);
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
                imagePath = candidate;
            } catch {}
        }
        return {
            id: screen.id,
            projectId: screen.projectId,
            name: screen.data?.title || screen.data?.displayName || screen.id,
            deviceType: screen.data?.deviceType,
            imageUrl,
            imagePath,
            htmlUrl: await screen.getHtml(),
            htmlPath: await this._getStitchHtmlPath(screen.id, workspaceRoot),
            status: screen.data?.screenMetadata?.status || null,
            statusMessage: screen.data?.screenMetadata?.statusMessage || null
        };
    }

    private async _setupStitchAuth(): Promise<{ valid: boolean; apiKey: string }> {
        const apiKey = (await this._context.secrets.get('switchboard.stitch.apiKey')) || '';
        const finalKey = apiKey || process.env.STITCH_API_KEY || '';
        if (finalKey) {
            process.env.STITCH_API_KEY = finalKey;
            return { valid: true, apiKey: finalKey };
        }
        return { valid: false, apiKey: finalKey };
    }

    // The kanban "Project PRD Reference" planner add-on (roleConfig_planner.addons.designSystemDoc)
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

        fs.readFile(resolvedPath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
                res.end('Not Found');
                return;
            }
            const mimeType = this._getMimeType(resolvedPath);
            // For HTML files, inject:
            // 1. A script that intercepts Node.prototype.appendChild/insertBefore
            //    to rewrite Babel-compiled output. Recent @babel/standalone
            //    defaults to preset-react runtime:'automatic', which generates
            //    `import { jsx } from "react/jsx-runtime"` in compiled output.
            //    Babel creates a <script> element with that code and appends it
            //    to the DOM — the browser parses the script during appendChild
            //    and rejects the import statement ("Cannot use import statement
            //    outside a module"). The intercept rewrites the import to use
            //    the already-loaded React global before the script is inserted.
            // 2. A diagnostic script that captures load errors and reports
            //    them back to the parent webview via postMessage.
            if (mimeType.startsWith('text/html')) {
                let html = data.toString('utf8');
                const babelPatch = `<script>(function(){
'use strict';
// Babel standalone compiles <script type="text/babel"> blocks and injects
// the compiled code as a new <script> element. Recent @babel/standalone
// defaults to preset-react runtime:'automatic', which generates
//   import { jsx as _jsx } from "react/jsx-runtime";
// at the top of the compiled output. The browser rejects this because
// the script is not type="module". We intercept ALL DOM insertion methods
// and rewrite the import into var declarations using the React global.
function rewriteScriptContent(el){
if(!el||!el.textContent)return;
var c=el.textContent;
if(c.indexOf('import')===-1)return;
// Rewrite import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime"
c=c.replace(
/import\\s*\\{([^}]+)\\}\\s*from\\s*["']react\\/jsx-runtime["'];?/g,
function(match,imports){
var parts=imports.split(',').map(function(s){return s.trim();});
var decls=[];
parts.forEach(function(part){
// Handle "jsx as _jsx" aliasing
var m=part.match(/^(\\w+)(?:\\s+as\\s+(\\w+))?$/);
if(!m)return;
var name=m[1],alias=m[2]||name;
if(name==='jsx'||name==='jsxs')decls.push('var '+alias+'=React.createElement');
else if(name==='Fragment')decls.push('var '+alias+'=React.Fragment');
});
return decls.join(';');
}
);
// Also rewrite import { ... } from "react/jsx-dev-runtime" (dev mode)
c=c.replace(
/import\\s*\\{([^}]+)\\}\\s*from\\s*["']react\\/jsx-dev-runtime["'];?/g,
function(match,imports){
var parts=imports.split(',').map(function(s){return s.trim();});
var decls=[];
parts.forEach(function(part){
var m=part.match(/^(\\w+)(?:\\s+as\\s+(\\w+))?$/);
if(!m)return;
var name=m[1],alias=m[2]||name;
if(name==='jsx'||name==='jsxs'||name==='jsxDEV')decls.push('var '+alias+'=React.createElement');
else if(name==='Fragment')decls.push('var '+alias+'=React.Fragment');
});
return decls.join(';');
}
);
// Strip any remaining import/export statements that would cause SyntaxError
c=c.replace(/import\\s*\\{[^}]+\\}\\s*from\\s*["'][^"']+["'];?/g,function(match){
var nameMatch=match.match(/\\{([^}]+)\\}/);
if(!nameMatch)return'';
var names=nameMatch[1].split(',').map(function(s){return s.trim().replace(/^\\w+\\s+as\\s+/,'');});
return names.map(function(n){return'var '+n+'=undefined;';}).join('');
});
c=c.replace(/import\\s+[^;]+;/g,function(m){
var nm=m.match(/import\\s+(\\w+)/);
return nm?'var '+nm[1]+'=undefined;':'';
});
c=c.replace(/export\\s+(default\\s+)?/g,function(m,def){
return def?'':'';
});
el.textContent=c;
}
// Intercept ALL DOM insertion methods that Babel might use
var origAppend=Node.prototype.appendChild;
Node.prototype.appendChild=function(child){
if(child&&child.tagName==='SCRIPT')rewriteScriptContent(child);
return origAppend.call(this,child);
};
var origInsert=Node.prototype.insertBefore;
Node.prototype.insertBefore=function(child,ref){
if(child&&child.tagName==='SCRIPT')rewriteScriptContent(child);
return origInsert.call(this,child,ref);
};
// Element.prototype.append() — newer API, used by some libraries
if(Element.prototype.append){
var origElAppend=Element.prototype.append;
Element.prototype.append=function(){
for(var i=0;i<arguments.length;i++){
if(arguments[i]&&arguments[i].tagName==='SCRIPT')rewriteScriptContent(arguments[i]);
}
return origElAppend.apply(this,arguments);
};
}
// Also intercept textContent setter on script elements — Babel may set
// content after the script is already in the DOM via innerHTML/textContent
var origTextDesc=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'textContent');
if(origTextDesc&&origTextDesc.set){
Object.defineProperty(HTMLScriptElement.prototype,'textContent',{
get:origTextDesc.get,
set:function(v){
if(typeof v==='string'&&v.indexOf('import')!==-1){
var fake={textContent:v};
rewriteScriptContent(fake);
v=fake.textContent;
}
origTextDesc.set.call(this,v);
},
configurable:true
});
}
})();</script>`;

                const diag = `<script>(function(){
'use strict';
var errors=[],loaded=[],failed=[];
window.addEventListener('error',function(e){
errors.push({message:e.message,filename:e.filename,lineno:e.lineno,colno:e.colno,
stack:e.error&&e.error.stack?e.error.stack:null});
report();
});
window.addEventListener('unhandledrejection',function(e){
errors.push({type:'unhandledrejection',reason:e.reason?(e.reason.stack||String(e.reason)):String(e.reason)});
report();
});
document.addEventListener('DOMContentLoaded',function(){
document.querySelectorAll('script[src]').forEach(function(s){
s.addEventListener('load',function(){loaded.push(s.src);report();});
s.addEventListener('error',function(){failed.push(s.src);report();});
});
});
function report(){
try{
window.parent.postMessage({
type:'previewRenderStatus',
errors:errors,loadedScripts:loaded,failedScripts:failed,
readyState:document.readyState,
rootChildren:document.getElementById('root')?document.getElementById('root').children.length:-1,
location:String(document.location)
},'*');
}catch(e){}
}
window.addEventListener('load',function(){
setTimeout(report,500);setTimeout(report,2000);setTimeout(report,5000);
});
})();</script>`;

                const injected = babelPatch + diag;
                if (/<head\b[^>]*>/i.test(html)) {
                    html = html.replace(/<head\b[^>]*>/i, m => m + injected);
                } else if (/<html\b[^>]*>/i.test(html)) {
                    html = html.replace(/<html\b[^>]*>/i, m => m + injected);
                } else {
                    html = injected + html;
                }
                res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
                res.end(Buffer.from(html, 'utf8'));
            } else {
                res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
                res.end(data);
            }
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
        const authInfo = await this._setupStitchAuth();
        const hasKey = authInfo.valid;

        switch (message.type) {
            case 'renderMarkdownLive': {
                try {
                    const html = await vscode.commands.executeCommand<string>('markdown.api.render', message.content || '');
                    this.postMessage({
                        type: 'markdownLiveRendered',
                        requestId: message.requestId,
                        html: html,
                        htmlContent: html
                    });
                } catch (err) {
                    this.postMessage({
                        type: 'markdownLiveRendered',
                        requestId: message.requestId,
                        html: '',
                        htmlContent: '',
                        error: String(err)
                    });
                }
                break;
            }
            case 'ready': {
                const allRoots = this._getWorkspaceRoots();
                const items = buildWorkspaceItems(allRoots);
                const tabKeys = ['stitch', 'html-preview', 'images', 'design', 'html.root', 'claude.root', 'design.root', 'briefs', 'briefs.root', 'stitch.root', 'images.root', 'activeTab'];
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
                this.postMessage({
                    type: 'stitchAuthStatus',
                    configured: hasKey,
                    valid: hasKey,
                    apiKey: authInfo.apiKey
                });
                const themeConfig = vscode.workspace.getConfiguration('switchboard');
                this.postMessage({ type: 'switchboardThemeChanged', theme: themeConfig.get<string>('theme.name', 'afterburner') });
                this.postMessage({ type: 'cyberAnimationSetting', disabled: themeConfig.get<boolean>('theme.disableCyberAnimation', false) });
                this.postMessage({ type: 'cyberScanlinesSetting', disabled: themeConfig.get<boolean>('theme.disableCyberScanlines', false) });
                await this._sendHtmlDocsReady();
                await this._sendClaudeDocsReady();
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
            case 'inspectRequestDataUrl': {
                const filePath = message.filePath;
                try {
                    // Simple path verification helper (defense-in-depth)
                    const isAllowed = this._getWorkspaceRoots().some(root => {
                        const rel = path.relative(root, filePath);
                        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
                    });
                    if (!isAllowed) {
                        throw new Error("Access denied: File not in workspace roots.");
                    }
                    const buf = fs.readFileSync(filePath);
                    const ext = path.extname(filePath).slice(1).toLowerCase();
                    const mime = ext === 'jpg' ? 'jpeg' : (ext || 'png');
                    this.postMessage({
                        type: 'inspectDataUrl',
                        dataUrl: `data:image/${mime};base64,${buf.toString('base64')}`,
                        requestId: message.requestId
                    });
                } catch (e) {
                    this.postMessage({ type: 'inspectDataUrlError', requestId: message.requestId, error: String(e) });
                }
                break;
            }
            case 'activeTabChanged': {
                this._activeTab = message.tab;
                if (message.tab !== 'html-preview') {
                    this._activeHtmlPreview = null;
                }
                if (message.tab !== 'claude') {
                    this._activeClaudePreview = null;
                }
                if (this._isPolledTab(message.tab) && this._panel?.visible) {
                    this._startExternalFilePoll();
                } else {
                    this._stopExternalFilePoll();
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
                    const config = vscode.workspace.getConfiguration('switchboard');
                    await config.update(
                        'planner.designSystemDocLink', docPath, vscode.ConfigurationTarget.Workspace
                    );
                    await config.update(
                        'planner.designSystemDocLink', undefined, vscode.ConfigurationTarget.Global
                    );
                    await config.update(
                        'planner.designSystemDocEnabled', true, vscode.ConfigurationTarget.Global
                    );
                    await config.update(
                        'planner.designSystemDocEnabled', undefined, vscode.ConfigurationTarget.Workspace
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
                    const config = vscode.workspace.getConfiguration('switchboard');
                    await config.update(
                        'planner.designSystemDocEnabled', false, vscode.ConfigurationTarget.Global
                    );
                    await config.update(
                        'planner.designSystemDocEnabled', undefined, vscode.ConfigurationTarget.Workspace
                    );
                    await config.update(
                        'planner.designSystemDocLink', undefined, vscode.ConfigurationTarget.Workspace
                    );
                    await config.update(
                        'planner.designSystemDocLink', undefined, vscode.ConfigurationTarget.Global
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
                const rawDocId = String(message.docId || '');
                if ((message.sourceId === 'html-folder' || message.sourceId === 'claude-folder') && message.sourceFolder) {
                    if (message.target === 'claude') {
                        this._activeClaudePreview = {
                            sourceFolder: path.resolve(message.sourceFolder),
                            docId: rawDocId,
                            sourceId: message.sourceId
                        };
                    } else {
                        this._activeHtmlPreview = {
                            sourceFolder: path.resolve(message.sourceFolder),
                            docId: rawDocId,
                            sourceId: message.sourceId
                        };
                    }
                } else {
                    if (message.target === 'claude') {
                        this._activeClaudePreview = null;
                    } else {
                        this._activeHtmlPreview = null;
                    }
                }
                await this._buildAndSendPreview({
                    sourceId: message.sourceId,
                    sourceFolder: message.sourceFolder,
                    docId: rawDocId,
                    target: message.target,
                    requestId: message.requestId,
                    isAutoRefreshed: false
                });
                break;
            }

            case 'copyClaudeImportPrompt': {
                const prompt = String(message.prompt || '');
                if (!prompt) break;
                await vscode.env.clipboard.writeText(prompt);
                showTemporaryNotification('Copied Claude import prompt to clipboard.');
                break;
            }

            case 'sendClaudeImportPrompt': {
                const prompt = String(message.prompt || '');
                if (!prompt) break;
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.sendPromptToAgentTerminal('claude_import', prompt, message.workspaceRoot || undefined);
                    showTemporaryNotification('Sent Claude import prompt to agent terminal.');
                } else {
                    await vscode.env.clipboard.writeText(prompt);
                    showTemporaryNotification('Agent terminal unavailable — copied Claude import prompt to clipboard instead.');
                }
                break;
            }

            case 'copyClaudeArtifactPrompt': {
                if (message.error) { showTemporaryNotification(String(message.error)); break; }
                const prompt = String(message.prompt || '');
                if (!prompt) break;
                await vscode.env.clipboard.writeText(prompt);
                showTemporaryNotification('Copied Claude artifact upload prompt to clipboard.');
                break;
            }

            case 'sendClaudeArtifactPrompt': {
                if (message.error) { showTemporaryNotification(String(message.error)); break; }
                const prompt = String(message.prompt || '');
                if (!prompt) break;
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.sendPromptToAgentTerminal('claude_artifacts', prompt, message.workspaceRoot || undefined);
                    showTemporaryNotification('Sent artifact upload prompt to Claude.');
                } else {
                    // No agent terminal wired up — fall back to clipboard so the button still does something.
                    await vscode.env.clipboard.writeText(prompt);
                    showTemporaryNotification('Agent terminal unavailable — copied artifact upload prompt to clipboard instead.');
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
                const linkRef = linkPath;
                vscode.env.clipboard.writeText(linkRef);
                showTemporaryNotification(`Copied document path to clipboard: ${linkRef}`);
                break;
            }

            case 'linkToFolder': {
                await this._handleLinkToFolder(this._getWorkspaceRoot(), String(message.folderPath || ''));
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
                    if (message.apiKey) {
                        await this._context.secrets.store('switchboard.stitch.apiKey', message.apiKey);
                    } else {
                        await this._context.secrets.delete('switchboard.stitch.apiKey');
                    }
                    process.env.STITCH_API_KEY = message.apiKey || '';
                    invalidateStitchSdkCache();
                    const auth = await this._setupStitchAuth();
                    this.postMessage({ type: 'stitchApiKeyStatus', configured: auth.valid });
                    this.postMessage({ type: 'stitchAuthStatus', configured: auth.valid, valid: auth.valid });
                    showTemporaryNotification('Stitch API Key saved successfully.');
                } catch (err: any) {
                    vscode.window.showErrorMessage('Failed to save API key: ' + err.message);
                }
                break;

            case 'stitchSaveAuthConfig':
                try {
                    if (message.apiKey) {
                        await this._context.secrets.store('switchboard.stitch.apiKey', message.apiKey);
                    } else {
                        await this._context.secrets.delete('switchboard.stitch.apiKey');
                    }
                    
                    invalidateStitchSdkCache();
                    const auth = await this._setupStitchAuth();
                    
                    this.postMessage({ type: 'stitchApiKeyStatus', configured: auth.valid });
                    this.postMessage({ 
                        type: 'stitchAuthStatus', 
                        configured: auth.valid, 
                        valid: auth.valid,
                        apiKey: auth.apiKey
                    });
                    showTemporaryNotification('Stitch Authentication settings saved successfully.');
                } catch (err: any) {
                    vscode.window.showErrorMessage('Failed to save settings: ' + err.message);
                }
                break;

            case 'stitchValidateAuth':
                try {
                    const auth = await this._setupStitchAuth();
                    if (!auth.valid) {
                        this.postMessage({ 
                            type: 'stitchAuthStatus', 
                            configured: false, 
                            valid: false,
                            error: 'Credentials not configured',
                            apiKey: auth.apiKey
                        });
                        return;
                    }
                    invalidateStitchSdkCache();
                    const stitch = await loadStitch('');
                    await stitch.projects();
                    this.postMessage({ 
                        type: 'stitchAuthStatus', 
                        configured: true, 
                        valid: true,
                        apiKey: auth.apiKey
                    });
                } catch (err: any) {
                    const auth = await this._setupStitchAuth();
                    this.postMessage({ 
                        type: 'stitchAuthStatus', 
                        configured: true, 
                        valid: false,
                        error: err.message || String(err),
                        apiKey: auth.apiKey
                    });
                }
                break;

            case 'stitchListDesignSystems':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const auth = await this._setupStitchAuth();
                    if (!auth.valid) {
                        this.postMessage({ type: 'stitchError', error: 'Authentication not configured.', workspaceRoot });
                        return;
                    }
                    const projectId = message.projectId;
                    if (!projectId) {
                        this.postMessage({ type: 'stitchError', error: 'No project selected.', workspaceRoot });
                        return;
                    }
                    const stitch = await loadStitch('');
                    const project = stitch.project(projectId);
                    const list = await project.listDesignSystems();
                    const designSystems = list.map((ds: any) => ({
                        id: ds.id,
                        displayName: ds.data?.displayName || ds.data?.name || ds.name || `Design System ${ds.id}`,
                        styleGuidelines: ds.data?.styleGuidelines || ds.data?.guidelines || '',
                        designTokens: ds.data?.designTokens
                            ? (typeof ds.data.designTokens === 'string'
                                ? ds.data.designTokens
                                : JSON.stringify(ds.data.designTokens))
                            : ''
                    }));
                    this.postMessage({ type: 'stitchDesignSystemsReady', designSystems, workspaceRoot });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchCreateDesignSystem':
                if (this._stitchOperationLock) {
                    this.postMessage({ type: 'stitchError', error: 'An operation is already in progress.', workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    break;
                }
                this._stitchOperationLock = true;
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const auth = await this._setupStitchAuth();
                    if (!auth.valid) {
                        throw new Error('Authentication not configured.');
                    }
                    const projectId = message.projectId;
                    if (!projectId) {
                        throw new Error('No project selected.');
                    }
                    const stitch = await loadStitch('');
                    const project = stitch.project(projectId);
                    
                    const input = {
                        displayName: message.displayName,
                        styleGuidelines: message.styleGuidelines,
                        designTokens: message.designTokens
                    };
                    
                    await project.createDesignSystem(input);
                    this.postMessage({ type: 'stitchDesignSystemCreated', workspaceRoot });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                } finally {
                    this._stitchOperationLock = false;
                }
                break;

            case 'stitchUpdateDesignSystem':
                if (this._stitchOperationLock) {
                    this.postMessage({ type: 'stitchError', error: 'An operation is already in progress.', workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    break;
                }
                this._stitchOperationLock = true;
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const auth = await this._setupStitchAuth();
                    if (!auth.valid) {
                        throw new Error('Authentication not configured.');
                    }
                    const projectId = message.projectId;
                    const assetId = message.assetId;
                    if (!projectId || !assetId) {
                        throw new Error('Project or design system asset ID is missing.');
                    }
                    const stitch = await loadStitch('');
                    const project = stitch.project(projectId);
                    const ds = project.designSystem(assetId);
                    
                    const input = {
                        displayName: message.displayName,
                        styleGuidelines: message.styleGuidelines,
                        designTokens: message.designTokens
                    };
                    
                    await ds.update(input);
                    this.postMessage({ type: 'stitchDesignSystemUpdated', workspaceRoot });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                } finally {
                    this._stitchOperationLock = false;
                }
                break;

            case 'stitchApplyDesignSystem':
                if (this._stitchOperationLock) {
                    this.postMessage({ type: 'stitchError', error: 'An operation is already in progress.', workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    break;
                }
                this._stitchOperationLock = true;
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const auth = await this._setupStitchAuth();
                    if (!auth.valid) {
                        throw new Error('Authentication not configured.');
                    }
                    const projectId = message.projectId;
                    const assetId = message.assetId;
                    const screenIds = message.screenIds || [];
                    if (!projectId || !assetId) {
                        throw new Error('Project or design system ID is missing.');
                    }
                    if (screenIds.length === 0) {
                        throw new Error('No screens selected.');
                    }

                    const { StitchToolClient } = await import('@google/stitch-sdk');
                    const dedicatedClient = new StitchToolClient();

                    const projectData: any = await dedicatedClient.callTool("get_project", { name: "projects/" + projectId });
                    const rawInstances = projectData.screenInstances || [];
                    
                    const selectedScreenInstances = rawInstances
                        .filter((instance: any) => {
                            if (!instance.id) return false;
                            if (instance.type && instance.type !== 'SCREEN_INSTANCE') return false;
                            return screenIds.includes(instance.id);
                        })
                        .map((instance: any) => ({
                            id: instance.id,
                            sourceScreen: instance.sourceScreen || instance.id
                        }));

                    if (selectedScreenInstances.length === 0) {
                        throw new Error('No applicable screens found in the project.');
                    }

                    const stitch = await loadStitch('');
                    const project = stitch.project(projectId);
                    const ds = project.designSystem(assetId);
                    
                    const updatedScreens = await ds.apply(selectedScreenInstances);

                    const formatted = await Promise.all(updatedScreens.map(async (s: any) => {
                        return this._formatScreen(s, workspaceRoot || '');
                    }));

                    const db = KanbanDatabase.forWorkspace(workspaceRoot || '');
                    await db.bulkUpsertStitchScreens(formatted.map((f: any) => ({
                        id: f.id,
                        projectId,
                        name: f.name,
                        deviceType: f.deviceType ?? null,
                        status: f.status,
                        statusMessage: f.statusMessage
                    })));

                    this.postMessage({ type: 'stitchDesignSystemApplied', workspaceRoot });
                    this.postMessage({ type: 'stitchScreensReady', screens: formatted, workspaceRoot });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                } finally {
                    this._stitchOperationLock = false;
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
                    const stitch = await loadStitch('');
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
                    const stitch = await loadStitch('');
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

                        const stitch = await loadStitch('');
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

                        const stitch = await loadStitch('');
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

                        // Optional brief attachment step
                        const briefChoice = await vscode.window.showQuickPick(
                            ['Yes, attach a brief', 'No, skip'],
                            { placeHolder: 'Attach a design brief to this project?' }
                        );
                        let briefContent: string | null = null;
                        if (briefChoice === 'Yes, attach a brief') {
                            const briefItems: Array<{ label: string; detail: string; data: any }> = [];
                            for (const root of (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath)) {
                                const svc = this._getLocalFolderService(root);
                                const files = await svc.listBriefsFiles();
                                for (const file of files) {
                                    if (file.isFolder) continue;
                                    briefItems.push({
                                        label: file.title || file.name,
                                        detail: file.sourceFolder,
                                        data: file
                                    });
                                }
                            }
                            if (briefItems.length > 0) {
                                const selected = await vscode.window.showQuickPick(briefItems, {
                                    placeHolder: 'Select a design brief'
                                });
                                if (selected) {
                                    const absPath = path.resolve(selected.data.sourceFolder, selected.data.relativePath);
                                    briefContent = await fs.promises.readFile(absPath, 'utf8');
                                }
                            }
                        }

                        const stitch = await loadStitch('');
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
                        if (briefContent) {
                            this.postMessage({ type: 'stitchBriefInjected', content: briefContent, projectId: project.id });
                        }
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
                    const stitch = await loadStitch('');
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
                        const stitch = await loadStitch('');
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

                    const stitch = await loadStitch('');
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

                    showTemporaryNotification(`Downloaded design tokens to ${path.basename(outputDir)}/design-tokens.json`);
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
            case 'listClaudeFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getClaudeFolderPaths();
                this.postMessage({ type: 'claudeFoldersListed', paths, workspaceRoot: root });
                break;
            }
            case 'addClaudeFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const result = await vscode.window.showOpenDialog({
                    openLabel: 'Add Claude Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addClaudeFolderPath(result[0].fsPath);
                    this._setupClaudeFolderWatchers();
                    await this._sendClaudeDocsReady();
                    this.postMessage({ type: 'claudeFoldersListed', paths: service.getClaudeFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeClaudeFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeClaudeFolderPath(message.folderPath);
                this._setupClaudeFolderWatchers();
                await this._sendClaudeDocsReady();
                this.postMessage({ type: 'claudeFoldersListed', paths: service.getClaudeFolderPaths(), workspaceRoot: root });
                break;
            }
            // Convenience toggle: register (or unregister) the hidden Stitch assets folder as an
            // HTML preview source, so downloaded screen HTML shows up in the HTML Previews tab.
            case 'toggleStitchHtmlPreview': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const stitchDir = this._getImageCacheDir(root);
                if (message.enabled) {
                    await service.addHtmlFolderPath(stitchDir);
                } else {
                    await service.removeHtmlFolderPath(stitchDir);
                }
                this._setupHtmlFolderWatchers();
                await this._sendHtmlDocsReady();
                this.postMessage({ type: 'htmlFoldersListed', paths: service.getHtmlFolderPaths(), workspaceRoot: root });
                break;
            }

            // Re-scan the source folders for a tab on demand. The webview posts this when
            // the user activates a tab, mirroring planning.js's fetch-on-tab-activation.
            // VS Code's FileSystemWatcher misses files created outside the editor (e.g. by
            // an external script or agent write), so the watcher-driven list can go stale;
            // a fresh readdir on tab entry guarantees the list is current.
            case 'refreshDocsForTab': {
                switch (message.tab) {
                    case 'html-preview':
                        await this._sendHtmlDocsReady();
                        break;
                    case 'claude':
                        await this._sendClaudeDocsReady();
                        break;
                    case 'images':
                        await this._sendImagesDocsReady();
                        break;
                    case 'briefs':
                        await this._sendBriefsDocsReady();
                        break;
                }
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
            case 'stitchPickAttachFiles': {
                try {
                    const result = await vscode.window.showOpenDialog({
                        canSelectMany: true,
                        openLabel: 'Attach reference files',
                        filters: {
                            'Reference Files': ['png', 'jpg', 'jpeg', 'webp', 'html', 'htm', 'md']
                        }
                    });
                    if (!result || result.length === 0) break;
                    const files = result.map(uri => {
                        const filePath = uri.fsPath;
                        const ext = path.extname(filePath).toLowerCase().replace('.', '');
                        const name = path.basename(filePath);
                        const type = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image'
                            : ['html', 'htm'].includes(ext) ? 'html'
                            : 'markdown';
                        return { path: filePath, name, type };
                    });
                    this.postMessage({ type: 'stitchAttachedFilesPicked', files });
                } catch (err: any) {
                    vscode.window.showErrorMessage('Failed to pick files: ' + err.message);
                }
                break;
            }

            case 'stitchSendBrief': {
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const root = workspaceRoot || '';
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

                    const title = await vscode.window.showInputBox({
                        prompt: 'Title for the new Stitch project',
                        placeHolder: 'e.g. Onboarding Redesign',
                        value: message.briefTitle || ''
                    });
                    if (!title) break; // user dismissed — nothing to do

                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        break;
                    }
                    this._stitchOperationLock = true;
                    try {
                        const stitch = await loadStitch('');
                        const project = await stitch.createProject(title);
                        const list = await stitch.projects();
                        const projects = list.map((p: any) => ({
                            id: p.id,
                            name: p.data?.title || p.data?.name || p.id,
                            updateTime: p.data?.updateTime || p.data?.createTime || ''
                        }));
                        if (workspaceRoot) {
                            const db = KanbanDatabase.forWorkspace(workspaceRoot);
                            for (const p of projects) {
                                await db.upsertStitchProject(p.id, p.name, p.updateTime);
                            }
                        }
                        this.postMessage({ type: 'stitchProjectsReady', projects, defaultProjectId: project.id, selectProjectId: project.id, workspaceRoot });
                        this.postMessage({ type: 'stitchBriefInjected', content, projectId: project.id });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
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
                        const stitch = await loadStitch('');
                        const projectInstance = stitch.project(message.projectId);

                        // Upload reference files and augment prompt with markdown context
                        let augmentedPrompt = message.prompt || '';
                        const attachedFiles = message.attachedFiles || [];
                        for (const file of attachedFiles) {
                            if (file.type === 'image' || file.type === 'html') {
                                try {
                                    await projectInstance.upload(file.path);
                                } catch (uploadErr: any) {
                                    console.error(`Failed to upload ${file.name}:`, uploadErr);
                                }
                            } else if (file.type === 'markdown') {
                                try {
                                    const mdContent = await fs.promises.readFile(file.path, 'utf8');
                                    augmentedPrompt += `\n\n--- Design Context ---\n${mdContent}\n---`;
                                } catch (readErr: any) {
                                    console.error(`Failed to read ${file.name}:`, readErr);
                                }
                            }
                        }

                        const screen = await projectInstance.generate(augmentedPrompt, message.deviceType, message.modelId);
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

                    // Default to the same folder the screen PNGs already live in, so a screen's
                    // assets stay together in one place. A caller can still override via destination.
                    let outputDir = this._getImageCacheDir(workspaceRoot);
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

                    showTemporaryNotification(`Downloaded ${safeFilename} to ${path.basename(outputDir)}/`);
                    // Tell the webview where the file landed so it can offer "Open on web"
                    // (for HTML) without re-deriving the path.
                    this.postMessage({
                        type: 'stitchAssetDownloaded',
                        kind: isPng ? 'png' : 'html',
                        screenId: message.screenId,
                        path: targetPath
                    });
                } catch (err: any) {
                    vscode.window.showErrorMessage('Download failed: ' + err.message);
                }
                break;
        }
    }

    private _isHtmlOrImageFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext);
    }

    private _isImageFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'].includes(ext);
    }

    private _isTextFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.md', '.txt', '.markdown', '.rst', '.adoc'].includes(ext);
    }

    private _isPolledTab(tab: string): boolean {
        return tab === 'html-preview' || tab === 'claude' || tab === 'images' || tab === 'briefs';
    }

    private _onVisibilityChanged(visible: boolean): void {
        if (visible && this._isPolledTab(this._activeTab)) {
            this._startExternalFilePoll();
        } else {
            this._stopExternalFilePoll();
        }
    }

    private _startExternalFilePoll(): void {
        if (this._externalFilePollTimer) return;
        const config = vscode.workspace.getConfiguration('switchboard');
        const ms = config.get<number>('design.externalFilePollMs', 4000);
        if (ms <= 0) return;
        this._externalFilePollTimer = setInterval(() => this._pollTick(), ms);
    }

    private _stopExternalFilePoll(): void {
        if (this._externalFilePollTimer) {
            clearInterval(this._externalFilePollTimer);
            this._externalFilePollTimer = undefined;
        }
    }

    private async _pollTick(): Promise<void> {
        const tab = this._activeTab;
        const visible = !!this._panel?.visible;
        if (!visible || !this._isPolledTab(tab) || !this._panel) {
            return;
        }

        try {
            const allRoots = this._getWorkspaceRoots();
            const signatures: string[] = [];

            for (const root of allRoots) {
                const service = this._getLocalFolderService(root);
                let folders: string[] = [];
                if (tab === 'html-preview') {
                    folders = service.getHtmlFolderPaths();
                } else if (tab === 'claude') {
                    folders = service.getClaudeFolderPaths();
                } else if (tab === 'images') {
                    folders = service.getImagesFolderPaths();
                } else if (tab === 'briefs') {
                    folders = service.getBriefsFolderPaths();
                }

                for (const dir of folders) {
                    // Do NOT use fs.existsSync here — it is a synchronous stat that
                    // blocks the event loop and bypasses the per-readdir 5s deadline
                    // in _getFolderSignature. On a hung NFS/SMB mount existsSync would
                    // wedge the tick exactly where the plan mandated a timeout. The
                    // raced readdir inside _getFolderSignature already handles
                    // non-existent dirs (rejects → caught → returns []).
                    const sigs = await this._getFolderSignature(dir, tab);
                    signatures.push(...sigs);
                }
            }

            signatures.sort();
            const combined = signatures.join('\n');
            const hash = crypto.createHash('md5').update(combined).digest('hex');

            if (this._activeTab !== tab || !this._panel?.visible) {
                return;
            }

            if (this._lastFolderSignature[tab] !== hash) {
                this._lastFolderSignature[tab] = hash;
                if (tab === 'html-preview') {
                    await this._sendHtmlDocsReady();
                } else if (tab === 'claude') {
                    await this._sendClaudeDocsReady();
                } else if (tab === 'images') {
                    await this._sendImagesDocsReady();
                } else if (tab === 'briefs') {
                    await this._sendBriefsDocsReady();
                }
            }
        } catch (err) {
            // swallow to survive tick
        }
    }

    private async _getFolderSignature(dir: string, tab: string, depth: number = 0, seen: Set<string> = new Set()): Promise<string[]> {
        if (depth >= 10) return [];
        const resolved = path.resolve(dir);
        if (seen.has(resolved)) return [];
        seen.add(resolved);

        let entries: fs.Dirent[];
        try {
            entries = await Promise.race([
                fs.promises.readdir(dir, { withFileTypes: true }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('readdir timeout')), 5000))
            ]);
        } catch {
            return [];
        }

        const filterFn = (name: string): boolean => {
            if (tab === 'html-preview' || tab === 'claude') {
                return this._isHtmlOrImageFile(name);
            } else if (tab === 'images') {
                return this._isImageFile(name);
            } else if (tab === 'briefs') {
                return this._isTextFile(name);
            }
            return false;
        };

        const filePromises: Promise<string>[] = [];
        const subfolderPromises: Promise<string[]>[] = [];

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            if (entry.isSymbolicLink()) continue;
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.switchboard') continue;
                // Include the directory itself in the signature so that an
                // externally-created empty subfolder (which the list methods render
                // as a folder node) is detected even when it contains no matching
                // files yet.
                filePromises.push(Promise.resolve(`${entry.name}|dir|dir`));
                subfolderPromises.push(this._getFolderSignature(fullPath, tab, depth + 1, seen));
            } else if (entry.isFile() && filterFn(entry.name)) {
                filePromises.push(
                    Promise.race([
                        fs.promises.stat(fullPath),
                        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stat timeout')), 5000))
                    ]).then(stat => {
                        return `${entry.name}|${stat.size}|${stat.mtimeMs}`;
                    }).catch(() => {
                        return `${entry.name}|error|error`;
                    })
                );
            }
        }

        const [files, subfolders] = await Promise.all([
            Promise.all(filePromises),
            Promise.all(subfolderPromises)
        ]);

        const results = [...files];
        for (const sf of subfolders) {
            results.push(...sf);
        }
        return results;
    }

    private async _buildAndSendPreview(opts: {
        sourceId: string;
        sourceFolder?: string;
        docId: string;
        requestId: number;
        target?: string;
        isAutoRefreshed?: boolean;
    }): Promise<void> {
        const { sourceId, sourceFolder, docId, requestId, target, isAutoRefreshed } = opts;
        try {
            if (!sourceFolder) throw new Error('sourceFolder is required');
            const relativePath = docId.includes(':')
                ? docId.substring(docId.indexOf(':') + 1)
                : docId;

            // Only configured design/html/claude/briefs/images folders may be read from.
            const allowedFolders = new Set<string>();
            for (const root of this._getWorkspaceRoots()) {
                try {
                    const svc = this._getLocalFolderService(root);
                    svc.getDesignFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                    svc.getHtmlFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                    svc.getClaudeFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                    svc.getBriefsFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                    svc.getImagesFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                } catch {}
            }
            const resolvedFolder = path.resolve(sourceFolder);
            if (!allowedFolders.has(resolvedFolder)) {
                throw new Error('sourceFolder is not a configured design/html/claude/briefs/images folder');
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
                    const serverEntry = await this._getOrCreateHtmlServer(resolvedFolder);
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

            let parsedJson: any = undefined;
            if (fileType === 'yaml') {
                try {
                    const yaml = require('js-yaml');
                    parsedJson = yaml.load(fileContent);
                } catch {}
            }

            this.postMessage({
                type: 'previewReady',
                sourceId,
                requestId,
                target,
                content: isImage ? '' : fileContent,
                docName: path.basename(relativePath),
                filePath: absPath,
                fileType,
                parsedJson,
                isImage,
                webviewUri,
                iframeSrc,
                htmlContent: isHtmlFile ? this._injectLocalCsp(fileContent) : undefined,
                isAutoRefreshed: isAutoRefreshed || undefined
            });
        } catch (err: any) {
            // Auto-refresh (requestId === -1) must fail silently — the file may be mid-write.
            if (requestId === -1) return;
            this.postMessage({
                type: 'previewError',
                sourceId,
                requestId,
                error: err.message || String(err)
            });
        }
    }

    private _registerSaveTextDocListener(): void {
        if (this._saveTextDocListener) return;
        this._saveTextDocListener = vscode.workspace.onDidSaveTextDocument((document) => {
            if (!this._panel?.visible) return;
            if (!this._activeHtmlPreview && !this._activeClaudePreview) return;
            this._autoRefreshHtmlPreview(document.uri);
        });
        this._disposables.push(this._saveTextDocListener);
    }

    private _autoRefreshHtmlPreview(changedUri: vscode.Uri): void {
        const changedPath = path.resolve(changedUri.fsPath);

        const checkAndRefresh = (active: typeof this._activeHtmlPreview, target?: string) => {
            if (!active) return;
            const relativePath = active.docId.includes(':')
                ? active.docId.substring(active.docId.indexOf(':') + 1)
                : active.docId;
            const activePath = path.resolve(active.sourceFolder, relativePath);

            if (changedPath !== activePath) return;

            if (this._autoRefreshDebounce) clearTimeout(this._autoRefreshDebounce);
            this._autoRefreshDebounce = setTimeout(() => {
                this._autoRefreshDebounce = undefined;
                
                const current = target === 'claude' ? this._activeClaudePreview : this._activeHtmlPreview;
                if (!current || !this._panel) return;

                const currentRel = current.docId.includes(':')
                    ? current.docId.substring(current.docId.indexOf(':') + 1)
                    : current.docId;
                const currentPath = path.resolve(current.sourceFolder, currentRel);
                if (currentPath !== activePath) return;

                this._buildAndSendPreview({
                    sourceId: current.sourceId,
                    sourceFolder: current.sourceFolder,
                    docId: current.docId,
                    target,
                    requestId: -1,
                    isAutoRefreshed: true
                });
            }, 300);
        };

        checkAndRefresh(this._activeHtmlPreview);
        checkAndRefresh(this._activeClaudePreview, 'claude');
    }

    /**
     * Resolve a folder path (absolute, or <index>:<relativePath> subfolder id)
     * to an absolute path, verify it sits within a configured design/briefs/html/images
     * folder, and copy it to the clipboard so the user can paste it into an agent prompt.
     * Mirrors PlanningPanelProvider._handleLinkToFolder.
     */
    private async _handleLinkToFolder(workspaceRoot: string | undefined, folderPath: string): Promise<void> {
        try {
            if (!folderPath) {
                throw new Error('No folder path provided');
            }

            // Build the allowed-folder set across ALL roots and ALL four kinds up front.
            // The frontend sends a bare absolute path with no owning-root hint, and
            // DesignPanelProvider has no _getLocalFolderServiceForFolder helper.
            // Validating against a single root would reject legitimate folders from non-primary roots.
            // So we make both resolution and validation root-agnostic.
            const allowedPaths: string[] = [];
            for (const root of this._getWorkspaceRoots()) {
                const svc = this._getLocalFolderService(root);
                allowedPaths.push(
                    ...svc.getDesignFolderPaths(),
                    ...svc.getBriefsFolderPaths(),
                    ...svc.getHtmlFolderPaths(),
                    ...svc.getImagesFolderPaths(),
                );
            }

            let resolvedFolder = '';

            if (/^\d+:/.test(folderPath)) {
                // Subfolder id `<index>:<relativePath>` — join against every allowed
                // base and take the first that exists on disk.
                const relativePath = folderPath.substring(folderPath.indexOf(':') + 1);
                for (const base of allowedPaths) {
                    const candidate = path.join(base, relativePath);
                    if (fs.existsSync(candidate)) {
                        resolvedFolder = candidate;
                        break;
                    }
                }
                if (!resolvedFolder) throw new Error('Subfolder not found');
            } else {
                // Frontend sends already-resolved absolute paths.
                const svc = this._getLocalFolderService(workspaceRoot || this._getWorkspaceRoots()[0] || '');
                resolvedFolder = svc.resolveFolderPath(folderPath);
            }

            const isWithinAllowed = allowedPaths.some(
                p => resolvedFolder === p || resolvedFolder.startsWith(p + path.sep)
            );
            if (!isWithinAllowed) {
                throw new Error('Folder is not within a configured folder');
            }
            if (!fs.existsSync(resolvedFolder)) {
                throw new Error('Folder does not exist');
            }
            await vscode.env.clipboard.writeText(resolvedFolder);
            showTemporaryNotification(`Folder path copied to clipboard: ${resolvedFolder}`);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to link to folder: ${String(err)}`);
        }
    }
}
