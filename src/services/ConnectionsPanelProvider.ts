import * as vscode from 'vscode';
import { getConnectionsHtml, type HostCapabilities } from './headlessPanelHtml';
import { getThemeBodyClass } from './themeBodyClass';
import { SetupPanelProvider } from './SetupPanelProvider';
import { PlanningPanelProvider } from './PlanningPanelProvider';
import { SETUP_VERBS } from '../generated/verbAllowlist';
import { PLANNING_VERBS } from '../generated/verbAllowlist';
import * as crypto from 'crypto';

/**
 * A thin VS Code webview host for the Connections (Remote Control / Web Agents)
 * panel. It owns no verb arms — it only forwards each posted verb to either
 * SetupPanelProvider or PlanningPanelProvider, then delivers the returned body
 * and any side-pushes back to the Connections webview explicitly. This keeps the
 * extension-host routing in one place and avoids forking the shared HTML.
 */
export class ConnectionsPanelProvider implements vscode.Disposable {
    private _panel?: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _pendingSection?: string;

    /**
     * The pristine push methods, captured ONCE on first forward.
     *
     * Capturing per-call is unsafe: a second forward that starts while the first is
     * awaiting captures the FIRST CALL'S PATCH as its "original", and its `finally`
     * then reinstalls that patch permanently — every later Setup push routes to the
     * Connections webview forever, and silently vanishes once this panel closes
     * (the postMessage rejection is swallowed). Capturing once means restore always
     * targets the real method.
     */
    private _pristineSetupPostMessage?: (msg: any) => void;
    private _pristinePlanningPostMessage?: (msg: any) => void;

    /**
     * Forwards run one at a time. The push redirection below is global mutable
     * state on two shared providers, so overlapping forwards would interleave
     * patch/restore regardless of how carefully each one is written. Webview
     * messages genuinely overlap here — connections.js polls `getRemoteHealth`
     * on a 15 s interval while Remote Control is active, so any click can land
     * mid-poll. Serialising is what makes the redirection safe at all.
     */
    private _forwardChain: Promise<void> = Promise.resolve();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _setupProvider: SetupPanelProvider,
        private readonly _planningProvider: PlanningPanelProvider,
        private readonly _getWorkspaceRoot: () => string | undefined
    ) { }

    public get isOpen(): boolean {
        return !!this._panel;
    }

    public async open(section?: string): Promise<void> {
        if (section) {
            this._pendingSection = section;
        }

        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            if (this._pendingSection) {
                this._panel.webview.postMessage({ type: 'openConnectionsSection', section: this._pendingSection });
                this._pendingSection = undefined;
            }
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-connections',
            'CONNECTIONS',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                // Mirrors Setup: rehydrate on reveal rather than keeping a hidden
                // renderer resident.
                retainContextWhenHidden: false,
                localResourceRoots: [this._extensionUri]
            }
        );

        this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
        this._panel.webview.html = await this._getHtml(this._panel.webview);

        this._panel.webview.onDidReceiveMessage(
            async (message) => this._handleMessage(message),
            undefined,
            this._disposables
        );

        this._panel.onDidDispose(() => {
            this._panel = undefined;
        }, null, this._disposables);

        if (this._pendingSection) {
            this._panel.webview.postMessage({ type: 'openConnectionsSection', section: this._pendingSection });
            this._pendingSection = undefined;
        }
    }

    public dispose(): void {
        this._panel?.dispose();
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables = [];
    }

    /** Queue each forward behind the previous one — see `_forwardChain`. */
    private _handleMessage(message: any): Promise<void> {
        const run = () => this._forwardOne(message);
        this._forwardChain = this._forwardChain.then(run, run);
        return this._forwardChain;
    }

    private async _forwardOne(message: any): Promise<void> {
        if (!message || typeof message.type !== 'string') {
            console.warn('[ConnectionsPanelProvider] Ignoring message without type:', message);
            return;
        }

        const panel = this._panel;
        if (!panel) {
            return;
        }

        const { type, ...payload } = message;

        // Side-pushes from the target providers normally land on their own webview.
        // For the duration of this forwarded call, redirect those pushes to the
        // Connections webview so a Setup/Planning arm's `this.postMessage` does not
        // silently update a sibling panel. Restored in `finally` to the PRISTINE
        // methods captured once (never to whatever is installed right now).
        if (!this._pristineSetupPostMessage) {
            this._pristineSetupPostMessage = this._setupProvider.postMessage.bind(this._setupProvider);
        }
        if (!this._pristinePlanningPostMessage) {
            this._pristinePlanningPostMessage = this._planningProvider.postMessageToWebview.bind(this._planningProvider);
        }

        this._setupProvider.postMessage = (msg: any) => {
            panel.webview.postMessage(msg).then(undefined, () => { /* panel closed */ });
            const b = (this._setupProvider as any)._broadcaster;
            if (b) { b.mirrorToWs(undefined, msg, msg?.type); }
        };

        this._planningProvider.postMessageToWebview = (msg: any) => {
            panel.webview.postMessage(msg).then(undefined, () => { /* panel closed */ });
            const b = (this._planningProvider as any)._broadcaster;
            if (b) { b.mirrorToWs('planning', msg, msg?.type); }
        };

        let result: any;
        try {
            if (SETUP_VERBS.has(type)) {
                result = await this._setupProvider.handleServiceVerb(type, payload);
            } else if (PLANNING_VERBS.has(type)) {
                result = await this._planningProvider.handleServiceVerb(type, payload);
            } else {
                result = {
                    success: false,
                    error: `Unknown connections verb '${type}' — it is in neither SETUP_VERBS nor PLANNING_VERBS. Add the arm to its provider and run \`npm run catalog:generate\`.`
                };
            }
        } catch (err) {
            result = {
                success: false,
                error: err instanceof Error ? err.message : `connections verb '${type}' failed`
            };
        } finally {
            this._setupProvider.postMessage = this._pristineSetupPostMessage;
            this._planningProvider.postMessageToWebview = this._pristinePlanningPostMessage;
        }

        if (result !== undefined && result !== null) {
            panel.webview.postMessage(result).then(undefined, () => { /* panel closed */ });
        }
    }

    private async _getHtml(webview: vscode.Webview): Promise<string> {
        const workspaceRoot = this._getWorkspaceRoot();
        const repoRoot = this._extensionUri.fsPath;
        const themeClass = getThemeBodyClass(workspaceRoot);

        const capabilities: HostCapabilities = {
            terminalDispatch: true,
            automation: true,
            orchestrator: true,
            terminalFleet: true,
            mcpTerminals: true,
            secretsEntry: true,
            featureManagement: true,
            worktrees: true,
            uat: true,
            boardStructure: true,
            featureAdvanced: true,
            integrationsConfigured: {}
        };

        const { html } = getConnectionsHtml(repoRoot, workspaceRoot || '', capabilities, themeClass);

        // Re-nonce the whole document so the CSP meta and all script tags match.
        const nonce = crypto.randomBytes(16).toString('base64');
        let content = html.replace(/nonce="[^"]*"/g, `nonce="${nonce}"`);

        // Rewrite the shared headless /static/ paths to webview-scoped URIs for
        // the extension host. The standalone host still uses the unmodified
        // getConnectionsHtml output and serves /static itself.
        const resolveStaticUri = (rel: string): vscode.Uri | undefined => {
            if (rel.startsWith('/static/webview/')) {
                const rest = rel.slice('/static/webview/'.length);
                return vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', rest);
            }
            if (rel.startsWith('/static/designs/')) {
                const rest = rel.slice('/static/designs/'.length);
                return vscode.Uri.joinPath(this._extensionUri, 'designs', rest);
            }
            return undefined;
        };

        content = content.replace(
            /(src=|url\()(['"])(\/static\/[^'"]+)\2/g,
            (_match, prefix, quote, rel: string) => {
                const fileUri = resolveStaticUri(rel);
                if (!fileUri) { return `${prefix}${quote}${rel}${quote}`; }
                return `${prefix}${quote}${webview.asWebviewUri(fileUri)}${quote}`;
            }
        );

        const csp = `default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; connect-src ${webview.cspSource} ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*;`;
        content = content.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);

        return content;
    }
}
