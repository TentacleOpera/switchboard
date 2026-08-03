import { HostSeams, createVscodeHostSeams } from './hostSeams';
import { BroadcastHub } from './broadcastHub';
import { TICKETS_VERBS } from '../generated/verbAllowlist';
import { validateVerbPayload } from './verbSchemas';
import * as vscode from 'vscode';
import * as path from 'path';
import { applyThemeBodyClass } from './themeBodyClass';
import { PanelStateStore } from './PanelStateStore';
import { buildWorkspaceItems } from './workspaceUtils';
import { reviveWithRetention, injectInitialWebviewState } from '../utils/reviveWithRetention';
import { getTicketsHtml } from './headlessPanelHtml';

export class TicketsPanelProvider {
    public static readonly viewType = 'switchboard.ticketsPanel';

    private _panel?: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _context: vscode.ExtensionContext;
    private _stateStore: PanelStateStore;
    private _apiServer?: any;
    private _broadcaster?: BroadcastHub;
    private _hostSeams?: HostSeams;
    private _workspaceRoot?: string;

    constructor(
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        stateStore: PanelStateStore,
        apiServer?: any
    ) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._stateStore = stateStore;
        this._apiServer = apiServer;
    }

    public async handleServiceVerb(verb: string, payload: any): Promise<any> {
        if (!this._broadcaster) {
            this._initTicketsService();
        }
        if (!TICKETS_VERBS.has(verb)) {
            throw new Error(`Unknown Tickets verb: '${verb}'`);
        }
        const validation = validateVerbPayload('tickets', verb, payload);
        if (!validation.ok) {
            throw new Error(`Invalid payload for Tickets verb '${verb}': ${validation.error}`);
        }
        return await this._handleMessage({ ...(payload ?? {}), type: verb });
    }

    private _initTicketsService(): void {
        const workspaceRoot = this._getWorkspaceRoot() || '';
        if (!workspaceRoot) {
            this._hostSeams = undefined;
            this._broadcaster = undefined;
            return;
        }
        this._hostSeams = createVscodeHostSeams(workspaceRoot, this._context.secrets);
        if (!this._broadcaster) {
            this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: this._apiServer ?? null });
        } else {
            this._broadcaster.setWebview(this._panel?.webview);
        }
        this._workspaceRoot = workspaceRoot;
    }

    private _getWorkspaceRoot(): string | null {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return null;
        return folders[0].uri.fsPath;
    }

    private _resolveWorkspaceRoot(givenRoot?: string): string | null {
        if (givenRoot) {
            const norm = path.normalize(givenRoot);
            const folders = vscode.workspace.workspaceFolders || [];
            for (const f of folders) {
                if (path.normalize(f.uri.fsPath) === norm) {
                    return f.uri.fsPath;
                }
            }
            return givenRoot;
        }
        return this._getWorkspaceRoot();
    }

    private _pushTo(panel: vscode.WebviewPanel | undefined, surface: string, message: any): void {
        if (this._broadcaster) {
            this._broadcaster.broadcast(surface, message);
        } else if (panel) {
            panel.webview.postMessage(message);
        }
    }

    public show(workspaceRoot?: string): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (this._panel) {
            this._panel.reveal(column);
            if (workspaceRoot) {
                this._pushTo(this._panel, 'tickets', { type: 'workspaceRootChanged', workspaceRoot });
            }
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            TicketsPanelProvider.viewType,
            'Tickets',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this._context.extensionPath, 'dist')),
                    vscode.Uri.file(path.join(this._context.extensionPath, 'src', 'webview')),
                    vscode.Uri.file(path.join(this._context.extensionPath, 'static'))
                ]
            }
        );

        this._initTicketsService();
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                try {
                    await this._handleMessage(message);
                } catch (err: any) {
                    console.error('[TicketsPanelProvider] Error handling message:', err);
                }
            },
            null,
            this._disposables
        );

        reviveWithRetention(this._panel, this._context, 'tickets');
    }

    public revive(panel: vscode.WebviewPanel): void {
        this._panel = panel;
        this._initTicketsService();
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                try {
                    await this._handleMessage(message);
                } catch (err: any) {
                    console.error('[TicketsPanelProvider] Error handling message:', err);
                }
            },
            null,
            this._disposables
        );

        reviveWithRetention(this._panel, this._context, 'tickets');
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const repoRoot = this._context.extensionPath;
        const workspaceRoot = this._getWorkspaceRoot() || '';
        const themeClass = applyThemeBodyClass(this._context);
        const result = getTicketsHtml(repoRoot, workspaceRoot, undefined, themeClass);
        let html = result.html;

        const webviewUri = (relativePath: string) =>
            webview.asWebviewUri(vscode.Uri.file(path.join(repoRoot, relativePath))).toString();

        html = html.replace(/\{\{SHARED_UTILS_URI\}\}/g, webviewUri('src/webview/sharedUtils.js'));
        html = html.replace(/\{\{TICKETS_JS_URI\}\}/g, webviewUri('src/webview/tickets.js'));
        html = html.replace(/\{\{MARKDOWN_EDITOR_URI\}\}/g, webviewUri('src/webview/markdownEditor.js'));

        return injectInitialWebviewState(html, this._context, 'tickets');
    }

    private async _handleMessage(msg: any): Promise<any> {
        const targetPanel = this._panel;

        switch (msg.type) {
            case 'getStatusShowTicketsSetting': {
                const config = vscode.workspace.getConfiguration('switchboard');
                const val = config.get<boolean>('statusBar.showTicketsButton', true);
                const res = { type: 'statusShowTicketsSetting', enabled: val };
                this._pushTo(targetPanel, 'tickets', res);
                return { ...res, success: true };
            }
            case 'setStatusShowTicketsSetting': {
                const config = vscode.workspace.getConfiguration('switchboard');
                await config.update('statusBar.showTicketsButton', msg.enabled === true, vscode.ConfigurationTarget.Global);
                const res = { type: 'statusShowTicketsSetting', enabled: msg.enabled === true };
                this._pushTo(targetPanel, 'tickets', res);
                return { ...res, success: true };
            }
            case 'persistTabState': {
                if (msg.tabKey) {
                    this._stateStore.setPanelState(msg.tabKey, msg.state);
                }
                return { success: true };
            }
            case 'fetchRoots': {
                const items = buildWorkspaceItems();
                const res = { type: 'rootsFetched', items };
                this._pushTo(targetPanel, 'tickets', res);
                return { ...res, success: true };
            }
            default: {
                return { success: true };
            }
        }
    }

    public dispose(): void {
        if (this._panel) {
            this._panel.dispose();
            this._panel = undefined;
        }
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }
}
