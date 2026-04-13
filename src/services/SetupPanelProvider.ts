import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { TaskViewerProvider } from './TaskViewerProvider';

export class SetupPanelProvider implements vscode.Disposable {
    private _panel?: vscode.WebviewPanel;
    private _taskViewerProvider?: TaskViewerProvider;
    private _disposables: vscode.Disposable[] = [];
    private _pendingSection?: string;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public setTaskViewerProvider(provider: TaskViewerProvider): void {
        this._taskViewerProvider = provider;
    }

    public async open(section?: string): Promise<void> {
        if (section) {
            this._pendingSection = section;
        }

        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            await this._taskViewerProvider?.postSetupPanelState();
            if (this._pendingSection) {
                this.postMessage({ type: 'openSetupSection', section: this._pendingSection });
                this._pendingSection = undefined;
            }
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-setup',
            'SETUP',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
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
    }

    public postMessage(message: any): void {
        this._panel?.webview.postMessage(message);
    }

    public dispose(): void {
        this._panel?.dispose();
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables = [];
    }

    private async _handleMessage(message: any): Promise<void> {
        if (!this._panel) {
            return;
        }

        if (!this._taskViewerProvider) {
            console.warn('[SetupPanelProvider] TaskViewerProvider not attached.');
            return;
        }

        try {
            switch (message?.type) {
                case 'ready':
                    await this._taskViewerProvider.postSetupPanelState();
                    if (this._pendingSection) {
                        this._panel.webview.postMessage({ type: 'openSetupSection', section: this._pendingSection });
                        this._pendingSection = undefined;
                    }
                    break;
                case 'getIntegrationSetupStates': {
                    const states = await this._taskViewerProvider.getIntegrationSetupStates();
                    this._panel.webview.postMessage({ type: 'integrationSetupStates', ...states });
                    break;
                }
                case 'applyClickUpConfig': {
                    const result = await this._taskViewerProvider.handleApplyClickUpConfig(
                        message.token,
                        message.options ?? {}
                    );
                    this._panel.webview.postMessage({ type: 'clickupApplyResult', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'saveClickUpMappings': {
                    const result = await this._taskViewerProvider.handleSaveClickUpMappings(
                        Array.isArray(message.mappings) ? message.mappings : []
                    );
                    this._panel.webview.postMessage({ type: 'clickupMappingsSaved', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'saveClickUpAutomation': {
                    const result = await this._taskViewerProvider.handleSaveClickUpAutomation(
                        Array.isArray(message.automationRules) ? message.automationRules : []
                    );
                    this._panel.webview.postMessage({ type: 'clickupAutomationSaved', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'applyLinearConfig': {
                    const result = await this._taskViewerProvider.handleApplyLinearConfig(
                        message.token,
                        message.options ?? {}
                    );
                    this._panel.webview.postMessage({ type: 'linearApplyResult', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'saveLinearAutomation': {
                    const result = await this._taskViewerProvider.handleSaveLinearAutomation(
                        Array.isArray(message.automationRules) ? message.automationRules : []
                    );
                    this._panel.webview.postMessage({ type: 'linearAutomationSaved', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'applyNotionConfig': {
                    const result = await this._taskViewerProvider.handleApplyNotionConfig(
                        message.token,
                        message.options ?? {}
                    );
                    this._panel.webview.postMessage({ type: 'notionApplyResult', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'runSetup':
                    await vscode.commands.executeCommand('switchboard.setup');
                    break;
                case 'connectMcp':
                    await vscode.commands.executeCommand('switchboard.connectMcp');
                    break;
                case 'copyMcpConfig':
                    await vscode.commands.executeCommand('switchboard.copyMcpConfig');
                    break;
                case 'openDocs':
                    await this._openDocs();
                    break;
                case 'saveStartupCommands':
                    await this._taskViewerProvider.handleSaveStartupCommands(message);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getStartupCommands': {
                    const startupState = await this._taskViewerProvider.handleGetStartupCommands();
                    this._panel.webview.postMessage({ type: 'startupCommands', ...startupState });
                    break;
                }
                case 'getVisibleAgents': {
                    const agents = await this._taskViewerProvider.getVisibleAgents();
                    this._panel.webview.postMessage({ type: 'visibleAgents', agents });
                    break;
                }
                case 'getCustomAgents': {
                    const customAgents = await this._taskViewerProvider.getCustomAgents();
                    this._panel.webview.postMessage({ type: 'customAgents', customAgents });
                    break;
                }
                case 'getKanbanStructure': {
                    const items = await this._taskViewerProvider.handleGetKanbanStructure();
                    this._panel.webview.postMessage({ type: 'kanbanStructure', items });
                    break;
                }
                case 'getTeamLeadRoutingSettings': {
                    const settings = this._taskViewerProvider.handleGetTeamLeadRoutingSettings();
                    this._panel.webview.postMessage({ type: 'teamLeadRoutingSettings', ...settings });
                    break;
                }
                case 'getAccurateCodingSetting':
                    this._panel.webview.postMessage({
                        type: 'accurateCodingSetting',
                        enabled: this._taskViewerProvider.handleGetAccurateCodingSetting()
                    });
                    break;
                case 'getAdvancedReviewerSetting':
                    this._panel.webview.postMessage({
                        type: 'advancedReviewerSetting',
                        enabled: this._taskViewerProvider.handleGetAdvancedReviewerSetting()
                    });
                    break;
                case 'getLeadChallengeSetting':
                    this._panel.webview.postMessage({
                        type: 'leadChallengeSetting',
                        enabled: this._taskViewerProvider.handleGetLeadChallengeSetting()
                    });
                    break;
                case 'getAggressivePairSetting':
                    this._panel.webview.postMessage({
                        type: 'aggressivePairSetting',
                        enabled: this._taskViewerProvider.handleGetAggressivePairSetting()
                    });
                    break;
                case 'getDesignDocSetting': {
                    const designDocSetting = this._taskViewerProvider.handleGetDesignDocSetting();
                    this._panel.webview.postMessage({
                        type: 'designDocSetting',
                        enabled: designDocSetting.enabled,
                        link: designDocSetting.link
                    });
                    break;
                }
                case 'getGitIgnoreConfig': {
                    const config = this._taskViewerProvider.handleGetGitIgnoreConfig();
                    this._panel.webview.postMessage({ type: 'gitIgnoreConfig', ...config });
                    break;
                }
                case 'getDefaultPromptOverrides': {
                    const overrides = await this._taskViewerProvider.handleGetDefaultPromptOverrides();
                    this._panel.webview.postMessage({ type: 'defaultPromptOverrides', overrides });
                    break;
                }
                case 'updateGitIgnoreConfig':
                    await this._taskViewerProvider.handleSaveGitIgnoreConfig(message);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'saveDefaultPromptOverrides':
                    await this._taskViewerProvider.handleSaveDefaultPromptOverrides(message);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'saveLiveSyncConfig':
                    await this._taskViewerProvider.handleSaveLiveSyncConfig(message);
                    break;
                case 'updateKanbanStructure':
                    await this._taskViewerProvider.handleUpdateKanbanStructure(message.sequence);
                    break;
                case 'restoreKanbanDefaults':
                    await this._taskViewerProvider.handleRestoreKanbanDefaults();
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getDefaultPromptPreviews': {
                    const previews = await this._taskViewerProvider.handleGetDefaultPromptPreviews();
                    this._panel.webview.postMessage({ type: 'defaultPromptPreviews', previews });
                    break;
                }
                case 'getDbPath': {
                    const dbPath = await this._taskViewerProvider.handleGetDbPath();
                    this._panel.webview.postMessage({ type: 'dbPathUpdated', ...dbPath });
                    break;
                }
                case 'setLocalDb':
                    await this._taskViewerProvider.handleSetLocalDb();
                    break;
                case 'setCustomDbPath':
                    await this._taskViewerProvider.handleSetCustomDbPath(message.path);
                    break;
                case 'setPresetDbPath':
                    await this._taskViewerProvider.handleSetPresetDbPath(message.preset);
                    break;
                case 'resetDatabase':
                    await this._taskViewerProvider.handleResetDatabase();
                    break;
                default:
                    break;
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Setup panel error: ${errorMessage}`);
        }
    }

    private async _openDocs(): Promise<void> {
        const readmePath = vscode.Uri.joinPath(this._extensionUri, 'README.md');
        try {
            await vscode.workspace.fs.stat(readmePath);
            await vscode.commands.executeCommand('markdown.showPreview', readmePath);
        } catch {
            vscode.window.showErrorMessage('Plugin README.md not found.');
        }
    }

    private async _getHtml(webview: vscode.Webview): Promise<string> {
        const paths = [
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'setup.html'),
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'setup.html'),
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'setup.html')
        ];

        let htmlUri: vscode.Uri | undefined;
        for (const candidate of paths) {
            try {
                await vscode.workspace.fs.stat(candidate);
                htmlUri = candidate;
                break;
            } catch {
                // Continue to next candidate.
            }
        }

        if (!htmlUri) {
            return `<html><body style="padding:20px;font-family:sans-serif;">Setup webview HTML not found.</body></html>`;
        }

        const contentBuffer = await vscode.workspace.fs.readFile(htmlUri);
        let content = Buffer.from(contentBuffer).toString('utf8');

        const nonce = crypto.randomBytes(16).toString('base64');
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">`;
        content = content.replace('<head>', `<head>\n    ${csp}`);
        content = content.replace(/<script>/g, `<script nonce="${nonce}">`);
        return content;
    }
}
