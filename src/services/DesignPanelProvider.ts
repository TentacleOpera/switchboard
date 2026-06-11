import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LocalFolderService } from './LocalFolderService';
// @ts-ignore
import { stitch } from '@google/stitch-sdk';

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
            case 'ready':
                this.postMessage({ type: 'stitchApiKeyStatus', configured: hasKey });
                await this._sendHtmlDocsReady();
                await this._sendDesignDocsReady();
                break;

            case 'fetchPreview': {
                try {
                    const workspaceRoot = this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No workspace root selected');
                    const service = this._getLocalFolderService(workspaceRoot);
                    const fileContent = await service.readFile(message.docId, message.sourceFolder);
                    const fileExt = path.extname(message.docId).toLowerCase();
                    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(fileExt);

                    let webviewUri: string | undefined;
                    if (isImage) {
                        const absPath = path.resolve(message.sourceFolder || workspaceRoot, message.docId);
                        webviewUri = this._panel?.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
                    }

                    this.postMessage({
                        type: 'previewReady',
                        sourceId: message.sourceId,
                        requestId: message.requestId,
                        content: isImage ? '' : fileContent,
                        docName: path.basename(message.docId),
                        filePath: message.docId,
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
                    const list = await stitch.projects();
                    this.postMessage({ type: 'stitchProjectsReady', projects: list });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchGetProjectScreens':
                try {
                    const projectInstance = stitch.project(message.projectId);
                    const list = await projectInstance.screens();
                    const formatted = await Promise.all(list.map(async (screen: any) => {
                        this._activeScreens.set(screen.id, screen);
                        return {
                            id: screen.id,
                            name: screen.name,
                            deviceType: screen.deviceType,
                            imageUrl: await screen.getImage(),
                            htmlUrl: await screen.getHtml()
                        };
                    }));
                    this.postMessage({ type: 'stitchScreensReady', screens: formatted });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchGenerate':
                try {
                    let projectInstance = stitch;
                    if (message.projectId) {
                        projectInstance = stitch.project(message.projectId);
                    }
                    const screen = await projectInstance.generate(message.prompt, message.deviceType);
                    this._activeScreens.set(screen.id, screen);
                    this.postMessage({
                        type: 'stitchScreenReady',
                        screen: {
                            id: screen.id,
                            name: screen.name,
                            deviceType: screen.deviceType,
                            imageUrl: await screen.getImage(),
                            htmlUrl: await screen.getHtml()
                        }
                    });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchEdit':
                try {
                    const screen = this._activeScreens.get(message.screenId);
                    if (!screen) throw new Error('Screen instance not found in memory cache.');
                    const updated = await screen.edit(message.prompt);
                    this._activeScreens.set(updated.id, updated);
                    this.postMessage({
                        type: 'stitchScreenReady',
                        screen: {
                            id: updated.id,
                            name: updated.name,
                            deviceType: updated.deviceType,
                            imageUrl: await updated.getImage(),
                            htmlUrl: await updated.getHtml()
                        }
                    });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchVariants':
                try {
                    const screen = this._activeScreens.get(message.screenId);
                    if (!screen) throw new Error('Screen instance not found in memory cache.');
                    const list = await screen.variants(message.prompt, { count: message.count || 3 });
                    const formatted = await Promise.all(list.map(async (v: any) => {
                        this._activeScreens.set(v.id, v);
                        return {
                            id: v.id,
                            name: v.name,
                            deviceType: v.deviceType,
                            imageUrl: await v.getImage(),
                            htmlUrl: await v.getHtml()
                        };
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

                    const projectInstance = stitch.project(message.projectId);
                    const screens = await projectInstance.screens();

                    const outputDir = path.join(workspaceRoot, '.stitch');
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));
                    const screensDir = path.join(outputDir, 'screens');
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(screensDir));

                    let designMd = `# Design Handoff - Project ${message.projectId}\n\n`;
                    designMd += `Sync timestamp: ${new Date().toISOString()}\n\n`;
                    designMd += `## Screens\n\n`;

                    for (const s of screens) {
                        const safeId = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');
                        const htmlUrl = await s.getHtml();
                        const imageUrl = await s.getImage();

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

                        designMd += `### ${s.name || s.id}\n`;
                        designMd += `- Device: ${s.deviceType || 'AGNOSTIC'}\n`;
                        designMd += `- HTML: [${safeId}.html](./screens/${safeId}.html)\n`;
                        designMd += `- Image: ![${s.name || s.id}](./screens/${safeId}.png)\n\n`;
                    }

                    const manifestPath = path.join(outputDir, 'DESIGN.md');
                    await vscode.workspace.fs.writeFile(vscode.Uri.file(manifestPath), Buffer.from(designMd, 'utf8'));

                    this.postMessage({ type: 'stitchSyncComplete' });
                    vscode.window.showInformationMessage('Sync Complete! Design assets saved under .stitch folder.');
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err) });
                }
                break;

            case 'stitchDownloadAsset':
                try {
                    const workspaceRoot = this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No active workspace root found');

                    const isPng = message.filename.endsWith('.png');
                    const outputDir = path.join(workspaceRoot, '.stitch');
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));

                    const targetPath = path.join(outputDir, message.filename);
                    const res = await fetch(message.url);

                    if (isPng) {
                        const buffer = Buffer.from(await res.arrayBuffer());
                        await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), buffer);
                    } else {
                        const text = await res.text();
                        await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(text, 'utf8'));
                    }

                    vscode.window.showInformationMessage(`Downloaded ${message.filename} to .stitch/`);
                } catch (err: any) {
                    vscode.window.showErrorMessage('Download failed: ' + err.message);
                }
                break;
        }
    }
}
