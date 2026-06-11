import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LocalFolderService } from './LocalFolderService';

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
    private _htmlDocsDebounce?: NodeJS.Timeout;
    private _designDocsDebounce?: NodeJS.Timeout;
    private _activeScreens = new Map<string, any>(); // Key: screen.id, Value: SDK Screen instance
    private _lastWebviewRootsSignature?: string;
    private _themeListenersRegistered = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _getWorkspaceRoot: () => string | undefined,
        private readonly _context: vscode.ExtensionContext
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
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables = [];
    }

    private disposeWatchers(): void {
        this._htmlFolderWatchers.forEach(w => w.dispose());
        this._htmlFolderWatchers = [];
        this._designFolderWatchers.forEach(w => w.dispose());
        this._designFolderWatchers = [];
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
        const openRoots = this._getWorkspaceRoots();
        return openRoots.map(root => ({
            label: path.basename(root),
            workspaceRoot: root
        }));
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
        this.disposeWatchers();
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
        const configured = vscode.workspace.getConfiguration('switchboard')
            .get<string>('stitch.defaultOutputFolder') || '.stitch';
        return path.resolve(workspaceRoot, configured);
    }

    private async _formatScreen(screen: any): Promise<any> {
        return {
            id: screen.id,
            projectId: screen.projectId,
            name: screen.data?.title || screen.data?.displayName || screen.id,
            deviceType: screen.data?.deviceType,
            imageUrl: await screen.getImage(),
            htmlUrl: await screen.getHtml()
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

    private async _handleMessage(message: any): Promise<void> {
        const hasKey = this._setupStitchApiKey();

        switch (message.type) {
            case 'ready': {
                this.postMessage({ type: 'stitchApiKeyStatus', configured: hasKey });
                const themeConfig = vscode.workspace.getConfiguration('switchboard');
                this.postMessage({ type: 'switchboardThemeChanged', theme: themeConfig.get<string>('theme.name', 'afterburner') });
                this.postMessage({ type: 'cyberAnimationSetting', disabled: themeConfig.get<boolean>('theme.disableCyberAnimation', false) });
                await this._sendHtmlDocsReady();
                await this._sendDesignDocsReady();
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

                    // Only configured design/html folders may be read from.
                    const allowedFolders = new Set<string>();
                    for (const root of this._getWorkspaceRoots()) {
                        try {
                            const svc = this._getLocalFolderService(root);
                            svc.getDesignFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                            svc.getHtmlFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                        } catch {}
                    }
                    const resolvedFolder = path.resolve(sourceFolder);
                    if (!allowedFolders.has(resolvedFolder)) {
                        throw new Error('sourceFolder is not a configured design/html folder');
                    }
                    const absPath = path.resolve(resolvedFolder, relativePath);
                    if (absPath !== resolvedFolder && !absPath.startsWith(resolvedFolder + path.sep)) {
                        throw new Error('Invalid file path');
                    }

                    const fileExt = path.extname(relativePath).toLowerCase();
                    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(fileExt);

                    let fileContent = '';
                    let webviewUri: string | undefined;
                    if (isImage) {
                        webviewUri = this._panel?.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
                    } else {
                        fileContent = await fs.promises.readFile(absPath, 'utf8');
                    }

                    this.postMessage({
                        type: 'previewReady',
                        sourceId: message.sourceId,
                        requestId: message.requestId,
                        content: isImage ? '' : fileContent,
                        docName: path.basename(relativePath),
                        filePath: relativePath,
                        fileType: fileExt.substring(1),
                        isImage,
                        webviewUri,
                        htmlContent: fileExt === '.html' ? fileContent : undefined
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

            case 'linkToDocument':
                vscode.env.clipboard.writeText(message.docId);
                vscode.window.showInformationMessage(`Copied document path to clipboard: ${message.docId}`);
                break;

            case 'serveAndOpenHtml':
                // Simple fallback to opening in browser directly via file protocol or workspace file opening
                try {
                    const fullPath = path.resolve(message.sourceFolder || this._getWorkspaceRoot() || '', message.docId);
                    vscode.env.openExternal(vscode.Uri.file(fullPath));
                } catch (err: any) {
                    vscode.window.showErrorMessage('Failed to open HTML file: ' + err.message);
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
                    if (!hasKey) {
                        this.postMessage({ type: 'stitchApiKeyStatus', configured: false });
                        return;
                    }
                    const stitch = await loadStitch();
                    const list = await stitch.projects();
                    const projects = list.map((p: any) => ({ id: p.id, name: p.data?.title || p.data?.name || p.id }));
                    const config = vscode.workspace.getConfiguration('switchboard');
                    const defaultProjectId = config.get<string>('stitch.defaultProjectId') || '';
                    const defaultModelId = config.get<string>('stitch.defaultModelId') || 'GEMINI_3_FLASH';
                    const defaultCreativeRange = config.get<string>('stitch.defaultCreativeRange') || 'EXPLORE';
                    this.postMessage({
                        type: 'stitchProjectsReady',
                        projects,
                        defaultProjectId,
                        defaultModelId,
                        defaultCreativeRange
                    });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchGetProjectScreens':
                try {
                    const stitch = await loadStitch();
                    const projectInstance = stitch.project(message.projectId);
                    const list = await projectInstance.screens();
                    const formatted = await Promise.all(list.map(async (screen: any) => {
                        this._activeScreens.set(screen.id, screen);
                        return this._formatScreen(screen);
                    }));
                    this.postMessage({ type: 'stitchScreensReady', screens: formatted });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchCreateProject':
                try {
                    const title = await vscode.window.showInputBox({
                        prompt: 'Title for the new Stitch project',
                        placeHolder: 'e.g. Onboarding Redesign'
                    });
                    if (!title) return; // user dismissed the input — nothing to do
                    const stitch = await loadStitch();
                    const project = await stitch.createProject(title);
                    const list = await stitch.projects();
                    const projects = list.map((p: any) => ({ id: p.id, name: p.data?.title || p.data?.name || p.id }));
                    // Pass the new project as the default so the webview auto-selects it.
                    this.postMessage({ type: 'stitchProjectsReady', projects, defaultProjectId: project.id, selectProjectId: project.id });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchRefreshScreen':
                try {
                    if (!message.projectId || !message.screenId) throw new Error('Missing project or screen id');
                    const stitch = await loadStitch();
                    // getScreen() fetches fresh details — new download URLs and title —
                    // unlike the cached instance, whose data may predate render completion.
                    const fresh = await stitch.project(message.projectId).getScreen(message.screenId);
                    this._activeScreens.set(fresh.id, fresh);
                    this.postMessage({ type: 'stitchScreenReady', screen: await this._formatScreen(fresh) });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchOpenManifest':
                try {
                    const workspaceRoot = this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No active workspace root found');
                    const manifestPath = path.join(this._getStitchOutputDir(workspaceRoot), 'DESIGN.md');
                    if (fs.existsSync(manifestPath)) {
                        await vscode.window.showTextDocument(vscode.Uri.file(manifestPath), { preview: false });
                    } else {
                        vscode.window.showInformationMessage('No DESIGN.md yet — run "Sync Project to Workspace" first to download screens and the design-system palette.');
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchGenerate':
                try {
                    // The SDK has no root-level generate — a project is required.
                    if (!message.projectId) {
                        this.postMessage({ type: 'stitchError', error: 'Select a Stitch project before generating a screen.' });
                        return;
                    }
                    const stitch = await loadStitch();
                    const projectInstance = stitch.project(message.projectId);
                    const screen = await projectInstance.generate(message.prompt, message.deviceType, message.modelId);
                    this._activeScreens.set(screen.id, screen);
                    this.postMessage({ type: 'stitchScreenReady', screen: await this._formatScreen(screen) });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchEdit':
                try {
                    const screen = this._activeScreens.get(message.screenId);
                    if (!screen) throw new Error('Screen instance not found in memory cache.');
                    const updated = await screen.edit(message.prompt, undefined, message.modelId);
                    this._activeScreens.set(updated.id, updated);
                    this.postMessage({ type: 'stitchScreenReady', screen: await this._formatScreen(updated) });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchVariants':
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
                        return this._formatScreen(v);
                    }));
                    this.postMessage({ type: 'stitchScreensReady', screens: formatted });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchSyncProject':
                try {
                    const workspaceRoot = this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No active workspace root found');

                    const stitch = await loadStitch();
                    const projectInstance = stitch.project(message.projectId);
                    const screens = await projectInstance.screens();

                    const outputDir = this._getStitchOutputDir(workspaceRoot);
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));
                    const screensDir = path.join(outputDir, 'screens');
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(screensDir));

                    let designMd = `# Design Handoff - Project ${message.projectId}\n\n`;
                    designMd += `Sync timestamp: ${new Date().toISOString()}\n\n`;
                    designMd += `## Screens\n\n`;

                    const skipped: string[] = [];
                    for (const s of screens) {
                        const safeId = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');
                        const screenName = s.data?.title || s.data?.displayName || s.id;
                        const htmlUrl = await s.getHtml();
                        const imageUrl = await s.getImage();

                        // Screens still rendering have no download URLs yet — fetch('')
                        // throws "Failed to parse URL"; skip them and say so in the manifest.
                        if (!htmlUrl || !imageUrl) {
                            skipped.push(screenName);
                            continue;
                        }

                        // Fetch and save HTML
                        const htmlRes = await fetch(htmlUrl);
                        const htmlText = await htmlRes.text();
                        const htmlPath = path.join(screensDir, `${safeId}.html`);
                        await vscode.workspace.fs.writeFile(vscode.Uri.file(htmlPath), Buffer.from(htmlText, 'utf8'));

                        // Fetch and save PNG
                        const pngRes = await fetch(imageUrl);
                        const pngBuffer = Buffer.from(await pngRes.arrayBuffer());
                        const pngPath = path.join(screensDir, `${safeId}.png`);
                        await vscode.workspace.fs.writeFile(vscode.Uri.file(pngPath), pngBuffer);

                        designMd += `### ${screenName}\n`;
                        designMd += `- Device: ${s.data?.deviceType || 'AGNOSTIC'}\n`;
                        designMd += `- HTML: [${safeId}.html](./screens/${safeId}.html)\n`;
                        designMd += `- Image: ![${screenName}](./screens/${safeId}.png)\n\n`;
                    }
                    if (skipped.length > 0) {
                        designMd += `> Skipped (no download URLs yet — re-sync later): ${skipped.join(', ')}\n\n`;
                    }

                    // Design systems carry the project's palette/tokens — include them in the handoff.
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

                    const manifestPath = path.join(outputDir, 'DESIGN.md');
                    await vscode.workspace.fs.writeFile(vscode.Uri.file(manifestPath), Buffer.from(designMd, 'utf8'));

                    this.postMessage({ type: 'stitchSyncComplete', manifestPath, skippedCount: skipped.length });
                    await vscode.window.showTextDocument(vscode.Uri.file(manifestPath), { preview: false });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchDownloadAsset':
                try {
                    const workspaceRoot = this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No active workspace root found');
                    if (!message.url) {
                        throw new Error('No download URL is available for this asset yet — reload the project screens and try again.');
                    }

                    // basename() so a webview-supplied filename can't traverse out of the output dir
                    const safeFilename = path.basename(String(message.filename));
                    const isPng = safeFilename.endsWith('.png');
                    const outputDir = this._getStitchOutputDir(workspaceRoot);
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));

                    const targetPath = path.join(outputDir, safeFilename);
                    const res = await fetch(message.url);

                    if (isPng) {
                        const buffer = Buffer.from(await res.arrayBuffer());
                        await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), buffer);
                    } else {
                        const text = await res.text();
                        await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(text, 'utf8'));
                    }

                    vscode.window.showInformationMessage(`Downloaded ${safeFilename} to ${path.basename(outputDir)}/`);
                } catch (err: any) {
                    vscode.window.showErrorMessage('Download failed: ' + err.message);
                }
                break;
        }
    }
}
