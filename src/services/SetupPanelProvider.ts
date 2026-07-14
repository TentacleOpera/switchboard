
import { HostSeams, createVscodeHostSeams } from './hostSeams';
import { BroadcastHub } from './broadcastHub';
import { SetupService, SetupServiceContext } from './setupService';
import { SETUP_VERBS } from '../generated/verbAllowlist';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import { ControlPlaneMigrationService } from './ControlPlaneMigrationService';
import { MultiRepoScaffoldingService } from './MultiRepoScaffoldingService';
import { applyThemeBodyClass } from './themeBodyClass';
import type { TaskViewerProvider } from './TaskViewerProvider';
import { KanbanDatabase, type WorkspaceDatabaseMapping } from './KanbanDatabase';
import type { KanbanProvider } from './KanbanProvider';
import { getMappingsFromIndex, resolveEffectiveWorkspaceRootFromMappings } from './WorkspaceIdentityService';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';

// Switchboard writes only a marker-delimited MANAGED BLOCK into CLAUDE.md / AGENTS.md
// (see extension.ts ensureProtocolFile) and only ledger-tracked skills into `.claude/`
// (see ClaudeCodeMirrorService — `.claude/` is the user's Claude Code config dir, never
// owned wholesale). Litter cleanup must mirror that discipline: strip the block, remove
// ledger-tracked skills — never `rm -rf` a shared file/dir. Marker literals are a stable
// cross-host contract; kept in sync with their source-of-truth definitions.
const AGENTS_MANAGED_BLOCK_START = '<!-- switchboard:agents-protocol:start -->';
const AGENTS_MANAGED_BLOCK_END = '<!-- switchboard:agents-protocol:end -->';
const CLAUDE_MANAGED_BLOCK_START = '<!-- switchboard:claude-protocol:start -->';
const CLAUDE_MANAGED_BLOCK_END = '<!-- switchboard:claude-protocol:end -->';
const CLAUDE_GENERATED_MANIFEST_FILE = '.switchboard-generated.json';

type ControlPlaneTaskViewerProvider = TaskViewerProvider & {
    handleGetControlPlaneStatus?: (workspaceRoot?: string) => Promise<any>;
    handleSetExplicitControlPlaneRoot?: (controlPlaneRoot: string, workspaceRoot?: string) => Promise<any>;
    handleResetExplicitControlPlaneRoot?: (workspaceRoot?: string) => Promise<any>;
    handleClearControlPlaneCache?: (workspaceRoot?: string) => Promise<any>;
};

export class SetupPanelProvider implements vscode.Disposable {

    public async handleServiceVerb(verb: string, payload: any): Promise<any> {
        if (!this._setupService) {
            this._initSetupService();
        }
        if (!this._setupService) {
            throw new Error('SetupService unavailable — no workspace root resolved');
        }
        if (!SETUP_VERBS.has(verb)) {
            throw new Error(`Unknown Setup verb: '${verb}'`);
        }
        // VS Code is the host here; _handleMessage runs in-process. Command verbs
        // return the route layer's {success:true} ack (most _handleMessage impls are
        // void); read verbs emit their result over the WS hub (see plan).
        // `type` is set LAST so a payload `type` field can never override the
        // allowlist-checked verb, regardless of caller.
        return this._handleMessage({ ...(payload ?? {}), type: verb });
    }


    private _initSetupService(): void {
        const workspaceRoot = this._getCurrentWorkspaceRoot() || '';
        if (!workspaceRoot) {
            this._hostSeams = undefined;
            this._broadcaster = undefined;
            this._setupService = undefined;
            return;
        }
        this._hostSeams = createVscodeHostSeams(workspaceRoot);
        if (!this._broadcaster) {
            this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: null });
        } else {
            this._broadcaster.setWebview(this._panel?.webview);
        }
        const ctx: SetupServiceContext = {
            workspaceRoot,
            seams: this._hostSeams,
            broadcaster: this._broadcaster,
            handleMessage: async (msg) => this._handleMessage(msg),
            handleGetStartupCommands: async () => {
                if (this._taskViewerProvider) {
                    return this._taskViewerProvider.handleGetStartupCommands();
                }
                return { commands: {}, planIngestionFolder: '', visibleAgents: {}, autoCommitOnCodeReview: false };
            },
            handleSaveStartupCommands: async (data) => {
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.handleSaveStartupCommands(data);
                }
            },
            refreshUI: async () => {
                await vscode.commands.executeCommand('switchboard.refreshUI');
            }
        };
        if (this._setupService) {
            this._setupService.setContext(ctx);
        } else {
            this._setupService = new SetupService(ctx);
        }
    }

    public setApiServer(server: any): void {
        this._broadcaster?.setApiServer(server);
    }

    private _hostSeams?: HostSeams;
    private _broadcaster?: BroadcastHub;
    private _setupService?: SetupService;

    private _panel?: vscode.WebviewPanel;
    private _taskViewerProvider?: TaskViewerProvider;
    private _kanbanProvider?: KanbanProvider;
    private _disposables: vscode.Disposable[] = [];
    private _pendingSection?: string;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public get isOpen(): boolean {
        return !!this._panel;
    }

    public setTaskViewerProvider(provider: TaskViewerProvider): void {
        this._taskViewerProvider = provider;
    }

    public setKanbanProvider(provider: KanbanProvider): void {
        this._kanbanProvider = provider;
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
        if (this._broadcaster) {
            this._broadcaster.push(message);
        } else {
            this._panel?.webview.postMessage(message);
        }
    }

    public dispose(): void {
        this._panel?.dispose();
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables = [];
    }

    private _getWorkspaceFolderUri(workspaceRoot?: string): vscode.Uri | undefined {
        const resolvedRoot = String(workspaceRoot || '').trim();
        if (!resolvedRoot) {
            return undefined;
        }
        return vscode.workspace.workspaceFolders?.find((folder) =>
            path.resolve(folder.uri.fsPath) === path.resolve(resolvedRoot)
        )?.uri;
    }

    private _getCurrentWorkspaceRoot(): string | null {
        // Try to get the kanban-selected workspace
        const kanbanRoot = this._kanbanProvider?.getCurrentWorkspaceRoot();
        if (kanbanRoot) {
            return kanbanRoot;
        }

        // Fallback to first workspace folder (handles early initialization)
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
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
                case 'setThemeSetting': {
                    const theme = typeof message.theme === 'string' ? message.theme : 'afterburner';
                    await this._taskViewerProvider.handleSetThemeSetting(theme);
                    // Broadcast to all other active webviews
                    this._taskViewerProvider.broadcastToWebviews({ type: 'switchboardThemeChanged', theme });
                    // Also update the setup panel itself
                    this.postMessage({ type: 'switchboardThemeNameSetting', theme });
                    // Re-broadcast the effective colour-kanban-icons value so the
                    // Theme tab toggle updates live on theme switch (the per-theme
                    // default may change when the theme changes and the setting is
                    // unset). No feedback loop: the webview handler only sets
                    // toggle.checked and does not send a setColourKanbanIconsSetting
                    // message back.
                    this.postMessage({
                        type: 'colourKanbanIconsSetting',
                        enabled: this._taskViewerProvider.handleGetColourKanbanIconsSetting()
                    });
                    break;
                }
                case 'ready':
                    await this._taskViewerProvider.postSetupPanelState();
                    if (this._pendingSection) {
                        this.postMessage({ type: 'openSetupSection', section: this._pendingSection });
                        this._pendingSection = undefined;
                    }
                    break;
                case 'getIntegrationSetupStates': {
                    const states = await this._taskViewerProvider.getIntegrationSetupStates();
                    this.postMessage({ type: 'integrationSetupStates', ...states });
                    break;
                }
                case 'exportPromptSettings': {
                    const success = await this._taskViewerProvider.exportPromptSettings();
                    this.postMessage({ type: 'exportPromptSettingsResult', success });
                    break;
                }
                case 'importPromptSettings': {
                    const success = await this._taskViewerProvider.importPromptSettings();
                    this.postMessage({ type: 'importPromptSettingsResult', success });
                    break;
                }
                case 'copyDbSettingsToGlobal': {
                    const result = await this._taskViewerProvider.copyDbSettingsToGlobal();
                    this.postMessage({ type: 'copyDbSettingsResult', copiedCount: result.copied });
                    break;
                }
                case 'getControlPlaneStatus': {
                    const status = await this._getControlPlaneStatus(typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined);
                    this.postMessage({ type: 'controlPlaneStatusResult', ...status });
                    break;
                }
                case 'setExplicitControlPlaneRoot': {
                    const result = await this._setExplicitControlPlaneRoot(
                        typeof message.controlPlaneRoot === 'string' ? message.controlPlaneRoot : '',
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this.postMessage({ type: 'controlPlaneOverrideResult', action: 'set', ...result });
                    if (result.success) {
                        await this._taskViewerProvider.postSetupPanelState();
                        await vscode.commands.executeCommand('switchboard.refreshUI');
                    }
                    break;
                }
                case 'resetExplicitControlPlaneRoot': {
                    const result = await this._resetExplicitControlPlaneRoot(
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this.postMessage({ type: 'controlPlaneOverrideResult', action: 'reset', ...result });
                    if (result.success) {
                        await this._taskViewerProvider.postSetupPanelState();
                        await vscode.commands.executeCommand('switchboard.refreshUI');
                    }
                    break;
                }
                case 'clearControlPlaneCache': {
                    const confirmation = await vscode.window.showWarningMessage(
                        'Clear trusted Control Plane auto-detect decisions for this workspace?',
                        { modal: true },
                        'Clear Cache'
                    );
                    if (confirmation !== 'Clear Cache') {
                        this.postMessage({
                            type: 'controlPlaneOverrideResult',
                            action: 'clear-cache',
                            success: false,
                            error: 'Control Plane cache clear cancelled.'
                        });
                        break;
                    }
                    const result = await this._clearControlPlaneCache(
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this.postMessage({ type: 'controlPlaneOverrideResult', action: 'clear-cache', ...result });
                    if (result.success) {
                        await this._taskViewerProvider.postSetupPanelState();
                        await vscode.commands.executeCommand('switchboard.refreshUI');
                    }
                    break;
                }
                case 'detectControlPlaneCandidate': {
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (!workspaceRoot) {
                        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
                        return;
                    }
                    const candidate = await ControlPlaneMigrationService.detectCandidateParent(workspaceRoot);
                    this.postMessage({ type: 'controlPlaneCandidateResult', ...candidate });
                    break;
                }
                case 'previewControlPlaneMigration': {
                    const preview = await ControlPlaneMigrationService.previewMigration(String(message.parentDir || ''));
                    this.postMessage({ type: 'controlPlaneMigrationPreview', ...preview });
                    break;
                }
                case 'executeControlPlaneMigration': {
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (!workspaceRoot) {
                        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
                        return;
                    }
                    const result = await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            cancellable: false,
                            title: 'Migrating Control Plane...'
                        },
                        () => ControlPlaneMigrationService.executeMigration(String(message.parentDir || ''), {
                            currentWorkspaceRoot: workspaceRoot,
                            extensionPath: this._extensionUri.fsPath,
                            generateWorkspaceFile: message.generateWorkspaceFile !== false,
                            cleanupConfirmed: Array.isArray(message.cleanupConfirmed) ? message.cleanupConfirmed : []
                        })
                    );

                    // LAZY CHANGE: Ensure DB exists after migration
                    if (result.success && workspaceRoot) {
                        try {
                            const db = await this._taskViewerProvider.getKanbanDbForRoot(workspaceRoot);
                            if (db) {
                                await db.createIfMissing();
                            }
                        } catch (e) {
                            console.error('[SetupPanel] DB creation after migration failed:', e);
                        }
                    }

                    this.postMessage({ type: 'controlPlaneMigrationResult', ...result });
                    break;
                }
                case 'executeControlPlaneFreshSetup': {
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (!workspaceRoot) {
                        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
                        return;
                    }
                    const result = await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            cancellable: false,
                            title: 'Setting up Control Plane...'
                        },
                        () => ControlPlaneMigrationService.executeFreshSetup(String(message.parentDir || ''), {
                            currentWorkspaceRoot: workspaceRoot,
                            extensionPath: this._extensionUri.fsPath,
                            generateWorkspaceFile: message.generateWorkspaceFile !== false
                        })
                    );

                    // LAZY CHANGE: Ensure DB exists after fresh setup
                    if (result.success && workspaceRoot) {
                        try {
                            const db = await this._taskViewerProvider.getKanbanDbForRoot(workspaceRoot);
                            if (db) {
                                await db.createIfMissing();
                            }
                        } catch (e) {
                            console.error('[SetupPanel] DB creation after fresh setup failed:', e);
                        }
                    }

                    this.postMessage({ type: 'controlPlaneFreshSetupResult', ...result });
                    break;
                }
                case 'setBoardStateExport': {
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (workspaceRoot) {
                        const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(workspaceRoot));
                        const value = typeof message.value === 'string' ? message.value : 'none';
                        await config.update('boardStateExport', value, vscode.ConfigurationTarget.WorkspaceFolder);
                    }
                    break;
                }
                case 'setBoardStateExportRemoteUrl': {
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (workspaceRoot) {
                        const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(workspaceRoot));
                        const value = typeof message.value === 'string' ? message.value : '';
                        await config.update('boardStateExport.remoteUrl', value, vscode.ConfigurationTarget.WorkspaceFolder);
                    }
                    break;
                }
                case 'initControlPlaneGit': {
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (!workspaceRoot) {
                        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
                        return;
                    }
                    // Resolve the control-plane root
                    let cpRoot = workspaceRoot;
                    try {
                        const { resolveEffectiveWorkspaceRootFromMappings } = require('./WorkspaceIdentityService');
                        cpRoot = resolveEffectiveWorkspaceRootFromMappings(workspaceRoot);
                    } catch { /* fall through */ }
                    const remoteUrl = typeof message.remoteUrl === 'string' ? message.remoteUrl : undefined;
                    const result = await ControlPlaneMigrationService.initGitForControlPlane(cpRoot, remoteUrl);
                    this.postMessage({
                        type: 'controlPlaneGitInitResult',
                        ...result
                    });
                    if (result.success) {
                        vscode.window.showInformationMessage(
                            result.alreadyInitialized
                                ? 'Control plane git repo already initialized.'
                                : 'Control plane git repo initialized successfully.'
                        );
                    } else {
                        vscode.window.showWarningMessage(`Control plane git init failed: ${result.error || 'unknown error'}`);
                    }
                    break;
                }
                case 'scaffoldMultiRepo': {
                    try {
                        const result = await vscode.window.withProgress(
                            {
                                location: vscode.ProgressLocation.Notification,
                                cancellable: false,
                                title: 'Scaffolding Multi-Repo Control Plane...'
                            },
                            () => MultiRepoScaffoldingService.scaffold(
                                {
                                    parentDir: typeof message.parentDir === 'string' ? message.parentDir : '',
                                    workspaceName: typeof message.workspaceName === 'string' ? message.workspaceName : '',
                                    repoUrls: Array.isArray(message.repoUrls) ? message.repoUrls.map((value: unknown) => String(value)) : [],
                                    pat: typeof message.pat === 'string' ? message.pat : ''
                                },
                                this._extensionUri.fsPath
                            )
                        );
                        this.postMessage({ type: 'multiRepoScaffoldResult', result });
                    } catch (error) {
                        this.postMessage({
                            type: 'multiRepoScaffoldResult',
                            result: {
                                success: false,
                                repos: [],
                                error: error instanceof Error ? error.message : String(error)
                            }
                        });
                    }
                    break;
                }
                case 'applyClickUpConfig': {
                    const result = await this._taskViewerProvider.handleApplyClickUpConfig(
                        message.token,
                        message.options ?? {}
                    );
                    this.postMessage({ type: 'clickupApplyResult', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'saveClickUpMappings': {
                    const result = await this._taskViewerProvider.handleSaveClickUpMappings(
                        Array.isArray(message.mappings) ? message.mappings : []
                    );
                    this.postMessage({ type: 'clickupMappingsSaved', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'saveClickUpAutomation': {
                    const result = await this._taskViewerProvider.handleSaveClickUpAutomation(
                        Array.isArray(message.automationRules) ? message.automationRules : []
                    );
                    this.postMessage({ type: 'clickupAutomationSaved', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'applyLinearConfig': {
                    try {
                        const result = await this._taskViewerProvider.handleApplyLinearConfig(
                            message.token,
                            message.options ?? {}
                        );
                        this.postMessage({ type: 'linearApplyResult', ...result });
                        await this._taskViewerProvider.postSetupPanelState();
                        await vscode.commands.executeCommand('switchboard.refreshUI');
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        this.postMessage({
                            type: 'linearApplyResult',
                            success: false,
                            error: errorMessage
                        });
                    }
                    break;
                }
                case 'saveLinearAutomation': {
                    const result = await this._taskViewerProvider.handleSaveLinearAutomation(
                        Array.isArray(message.automationRules) ? message.automationRules : []
                    );
                    this.postMessage({ type: 'linearAutomationSaved', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'linearBrowseProjects': {
                    const result = await this._taskViewerProvider.handleLinearBrowseProjects();
                    if (!result.success) {
                        this.postMessage({
                            type: 'linearBrowseProjectsResult',
                            success: false,
                            error: result.error
                        });
                        break;
                    }
                    try {
                        const projectOptions = result.projects.map((p: { id: string; name: string }) => ({
                            label: p.name,
                            picked: false
                        }));
                        const selected = await vscode.window.showQuickPick(
                            projectOptions,
                            {
                                placeHolder: 'Select projects',
                                canPickMany: true
                            }
                        );
                        if (selected) {
                            const selectedNames = selected.map((s: { label: string }) => s.label);
                            this.postMessage({
                                type: 'linearBrowseProjectsResult',
                                success: true,
                                target: message.target,
                                projects: selectedNames
                            });
                        }
                    } catch (error) {
                        this.postMessage({
                            type: 'linearBrowseProjectsResult',
                            success: false,
                            error: error instanceof Error ? error.message : String(error)
                        });
                    }
                    break;
                }
                case 'enableTriagePipeline': {
                    const provider = message.provider === 'linear' ? 'linear' : 'clickup';
                    const result = await this._taskViewerProvider.handleEnableTriagePipeline(
                        provider,
                        typeof message.token === 'string' ? message.token : ''
                    );
                    this.postMessage({ type: 'triagePipelineResult', provider, ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'applyNotionConfig': {
                    const result = await this._taskViewerProvider.handleApplyNotionConfig(
                        message.token
                    );
                    this.postMessage({ type: 'notionApplyResult', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'configureNotionBackup': {
                    const result = await this._taskViewerProvider.handleConfigureNotionBackup(
                        typeof message.databaseUrl === 'string' ? message.databaseUrl : '',
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this.postMessage({ type: 'notionBackupConfigResult', ...result });
                    break;
                }
                case 'backupToNotion': {
                    const result = await this._taskViewerProvider.handleBackupToNotion(
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this.postMessage({ type: 'notionBackupResult', ...result });
                    break;
                }
                case 'restoreFromNotion': {
                    const result = await this._taskViewerProvider.handleRestoreFromNotion(
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this.postMessage({ type: 'notionRestoreResult', ...result });
                    break;
                }
                case 'autoCreateNotionDatabase': {
                    const result = await this._taskViewerProvider.handleAutoCreateNotionDatabase(
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this.postMessage({ type: 'notionAutoCreateResult', ...result });
                    break;
                }
                case 'runSetup':
                    await vscode.commands.executeCommand('switchboard.setup');
                    this.postMessage({ type: 'setupComplete' });
                    break;

                case 'openDocs':
                    await this._openDocs();
                    break;
                case 'openKanban':
                    await vscode.commands.executeCommand('switchboard.openKanban');
                    break;
                case 'saveStartupCommands':
                    if (this._setupService) {
                        await this._setupService.saveStartupCommands(message);
                    } else {
                        await this._taskViewerProvider.handleSaveStartupCommands(message);
                        await vscode.commands.executeCommand('switchboard.refreshUI');
                    }
                    break;
                case 'getStartupCommands': {
                    if (this._setupService) {
                        await this._setupService.getStartupCommands(message);
                    } else {
                        const startupState = await this._taskViewerProvider.handleGetStartupCommands();
                        this.postMessage({ type: 'startupCommands', ...startupState });
                    }
                    break;
                }
                case 'getVisibleAgents': {
                    const agents = await this._taskViewerProvider.getVisibleAgents();
                    this.postMessage({ type: 'visibleAgents', agents });
                    break;
                }
                case 'getCustomAgents': {
                    const workspaceRoot = this._getCurrentWorkspaceRoot() || undefined;
                    const customAgents = await this._taskViewerProvider.getCustomAgents(workspaceRoot);
                    this.postMessage({ type: 'customAgents', customAgents, workspaceRoot });
                    break;
                }
                case 'getKanbanStructure': {
                    const items = await this._taskViewerProvider.handleGetKanbanStructure();
                    this.postMessage({ type: 'kanbanStructure', items });
                    break;
                }
                case 'getPlanScannerConfig':
                    this.postMessage({
                        type: 'planScannerConfig',
                        config: this._taskViewerProvider.handleGetPlanScannerConfig()
                    });
                    break;
                case 'setPlanScannerConfig':
                    await this._taskViewerProvider.handleSetPlanScannerConfig(message.config || {});
                    this.postMessage({
                        type: 'planScannerConfig',
                        config: this._taskViewerProvider.handleGetPlanScannerConfig()
                    });
                    break;
                case 'getAccurateCodingSetting':
                    this.postMessage({
                        type: 'accurateCodingSetting',
                        enabled: this._taskViewerProvider.handleGetAccurateCodingSetting()
                    });
                    break;
                case 'getAdvancedReviewerSetting':
                    this.postMessage({
                        type: 'advancedReviewerSetting',
                        enabled: this._taskViewerProvider.handleGetAdvancedReviewerSetting()
                    });
                    break;
                case 'getLeadChallengeSetting':
                    this.postMessage({
                        type: 'leadChallengeSetting',
                        enabled: this._taskViewerProvider.handleGetLeadChallengeSetting()
                    });
                    break;


                case 'getAutoCommitOnCodeReviewSetting': {
                    const value = await this._taskViewerProvider.handleGetAutoCommitOnCodeReviewSetting();
                    this.postMessage({
                        type: 'autoCommitOnCodeReviewSetting',
                        enabled: value
                    });
                    break;
                }
                case 'getExcludeReviewedBacklogSetting':
                    this.postMessage({
                        type: 'excludeReviewedBacklogSetting',
                        enabled: this._taskViewerProvider.handleGetExcludeReviewedBacklogSetting()
                    });
                    break;
                case 'getPersistPanelsSetting': {
                    const config = vscode.workspace.getConfiguration('switchboard');
                    const enabled = config.get<boolean>('persistPanels', false);
                    this.postMessage({ type: 'persistPanelsSetting', enabled });
                    break;
                }
                case 'setExcludeReviewedBacklogSetting':
                    await this._taskViewerProvider.handleSetExcludeReviewedBacklogSetting(message.enabled);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'setPersistPanelsSetting': {
                    const config = vscode.workspace.getConfiguration('switchboard');
                    const enabled = message.enabled === true;
                    await config.update('persistPanels', enabled, vscode.ConfigurationTarget.Global);
                    this.postMessage({ type: 'persistPanelsSetting', enabled });
                    break;
                }
                case 'getProtocolTarget': {
                    const config = vscode.workspace.getConfiguration('switchboard');
                    const value = config.get<string>('protocol.target', 'both');
                    this.postMessage({ type: 'protocolTarget', value });
                    break;
                }
                case 'setProtocolTarget': {
                    const value = ['agents', 'claude', 'both'].includes(message.value) ? message.value : 'both';
                    const config = vscode.workspace.getConfiguration('switchboard');
                    await config.update('protocol.target', value, vscode.ConfigurationTarget.Workspace);
                    this.postMessage({ type: 'protocolTarget', value });
                    break;
                }

                case 'getStatusShowTerminalsSetting':
                    this.postMessage({
                        type: 'statusShowTerminalsSetting',
                        enabled: this._taskViewerProvider.handleGetStatusShowTerminalsSetting()
                    });
                    break;
                case 'setStatusShowTerminalsSetting':
                    await this._taskViewerProvider.handleSetStatusShowTerminalsSetting(message.enabled);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getStatusShowKanbanSetting':
                    this.postMessage({
                        type: 'statusShowKanbanSetting',
                        enabled: this._taskViewerProvider.handleGetStatusShowKanbanSetting()
                    });
                    break;
                case 'setStatusShowKanbanSetting':
                    await this._taskViewerProvider.handleSetStatusShowKanbanSetting(message.enabled);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getStatusShowArtifactsSetting':
                    this.postMessage({
                        type: 'statusShowArtifactsSetting',
                        enabled: this._taskViewerProvider.handleGetStatusShowArtifactsSetting()
                    });
                    break;
                case 'setStatusShowArtifactsSetting':
                    await this._taskViewerProvider.handleSetStatusShowArtifactsSetting(message.enabled);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getStatusShowDesignSetting':
                    this.postMessage({
                        type: 'statusShowDesignSetting',
                        enabled: this._taskViewerProvider.handleGetStatusShowDesignSetting()
                    });
                    break;
                case 'setStatusShowDesignSetting':
                    await this._taskViewerProvider.handleSetStatusShowDesignSetting(message.enabled);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getStatusShowProjectSetting':
                    this.postMessage({
                        type: 'statusShowProjectSetting',
                        enabled: this._taskViewerProvider.handleGetStatusShowProjectSetting()
                    });
                    break;
                case 'setStatusShowProjectSetting':
                    await this._taskViewerProvider.handleSetStatusShowProjectSetting(message.enabled);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getStatusShowMemoSetting':
                    this.postMessage({
                        type: 'statusShowMemoSetting',
                        enabled: this._taskViewerProvider.handleGetStatusShowMemoSetting()
                    });
                    break;
                case 'setStatusShowMemoSetting':
                    await this._taskViewerProvider.handleSetStatusShowMemoSetting(message.enabled);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getMemoHotkey': {
                    const config = vscode.workspace.getConfiguration('switchboard');
                    const hotkey = config.get<string>('memo.hotkey', 'cmd+shift+alt+m');
                    this.postMessage({ type: 'memoHotkey', value: hotkey });
                    break;
                }
                case 'saveMemoHotkey': {
                    const config = vscode.workspace.getConfiguration('switchboard');
                    await config.update('memo.hotkey', message.value, vscode.ConfigurationTarget.Global);
                    this.postMessage({ type: 'memoHotkeySaved' });
                    break;
                }
                case 'openKeybindings':
                    await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
                    break;
                case 'getThemeSetting': {
                    const currentTheme = vscode.workspace.getConfiguration('switchboard')
                        .get<string>('theme.name', 'afterburner');
                    this.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
                    break;
                }
                case 'getCyberAnimationDisabledSetting':
                    this.postMessage({
                        type: 'cyberAnimationDisabledSetting',
                        enabled: this._taskViewerProvider.handleGetCyberAnimationDisabledSetting()
                    });
                    break;
                case 'setCyberAnimationDisabledSetting':
                    await this._taskViewerProvider.handleSetCyberAnimationDisabledSetting(message.enabled);
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getCyberScanlinesDisabledSetting':
                    this.postMessage({
                        type: 'cyberScanlinesDisabledSetting',
                        enabled: this._taskViewerProvider.handleGetCyberScanlinesDisabledSetting()
                    });
                    break;
                case 'setCyberScanlinesDisabledSetting':
                    await this._taskViewerProvider.handleSetCyberScanlinesDisabledSetting(message.enabled);
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getColourKanbanIconsSetting':
                    this.postMessage({
                        type: 'colourKanbanIconsSetting',
                        enabled: this._taskViewerProvider.handleGetColourKanbanIconsSetting()
                    });
                    break;
                case 'setColourKanbanIconsSetting':
                    await this._taskViewerProvider.handleSetColourKanbanIconsSetting(message.enabled);
                    this._taskViewerProvider.broadcastToWebviews({
                        type: 'colourKanbanIconsChanged',
                        enabled: message.enabled
                    });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getUltracodeAnimationSetting':
                    this.postMessage({
                        type: 'ultracodeAnimationSetting',
                        enabled: this._taskViewerProvider.handleGetUltracodeAnimationSetting()
                    });
                    break;
                case 'setUltracodeAnimationSetting':
                    await this._taskViewerProvider.handleSetUltracodeAnimationSetting(message.enabled);
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'getPixelFontSetting':
                    this.postMessage({
                        type: 'pixelFontSetting',
                        enabled: this._taskViewerProvider.handleGetPixelFontSetting()
                    });
                    break;
                case 'setPixelFontSetting':
                    await this._taskViewerProvider.handleSetPixelFontSetting(message.enabled);
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;

                case 'getDesignSystemDocSetting': {
                    const setting = this._taskViewerProvider.handleGetDesignSystemDocSetting();
                    this.postMessage({
                        type: 'designSystemDocSetting',
                        enabled: setting.enabled,
                        link: setting.link
                    });
                    break;
                }
                case 'getGitIgnoreConfig': {
                    const config = this._taskViewerProvider.handleGetGitIgnoreConfig();
                    this.postMessage({ type: 'gitIgnoreConfig', ...config });
                    break;
                }
                case 'getDefaultPromptOverrides': {
                    const overrides = await this._taskViewerProvider.handleGetDefaultPromptOverrides();
                    this.postMessage({ type: 'defaultPromptOverrides', overrides });
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

                case 'updateKanbanStructure':
                    await this._taskViewerProvider.handleUpdateKanbanStructure(message.sequence);
                    break;
                case 'restoreKanbanDefaults':
                    await this._taskViewerProvider.handleRestoreKanbanDefaults();
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                case 'savePlanningSources': {
                    const sources = {
                        clickup: message.clickup === true,
                        linear: message.linear === true,
                        notion: message.notion === true,
                        'local-folder': message.localFolder === true
                    };
                    // NOTE: intentionally folder-scoped — this setting is per-project, not shared across workspaces
                    const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
                    const config = vscode.workspace.getConfiguration('switchboard', folderUri);
                    await config.update(
                        'planning.enabledSources',
                        sources,
                        folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace
                    );
                    this.postMessage({ type: 'planningSourcesSaved', success: true });
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'getDefaultPromptPreviews': {
                    const previews = await this._taskViewerProvider.handleGetDefaultPromptPreviews();
                    this.postMessage({ type: 'defaultPromptPreviews', previews });
                    break;
                }
                case 'getDbPath': {
                    const dbPath = await this._taskViewerProvider.handleGetDbPath();
                    this.postMessage({ type: 'dbPathUpdated', ...dbPath });
                    break;
                }
                case 'getAllDbPaths': {
                    const allDbPaths = await this._taskViewerProvider.handleGetAllDbPaths();
                    this.postMessage({ type: 'allDbPathsUpdated', databases: allDbPaths });
                    break;
                }
                case 'setLocalDb':
                    await this._taskViewerProvider.handleSetLocalDb(
                        typeof message.targetWorkspaceRoot === 'string' ? message.targetWorkspaceRoot : undefined
                    );
                    break;
                case 'setCustomDbPath':
                    await this._taskViewerProvider.handleSetCustomDbPath(
                        message.path,
                        typeof message.targetWorkspaceRoot === 'string' ? message.targetWorkspaceRoot : undefined
                    );
                    break;
                case 'setPresetDbPath':
                    await this._taskViewerProvider.handleSetPresetDbPath(
                        message.preset,
                        typeof message.targetWorkspaceRoot === 'string' ? message.targetWorkspaceRoot : undefined
                    );
                    break;
                case 'resetDatabase':
                    await this._taskViewerProvider.handleResetDatabase(
                        typeof message.targetWorkspaceRoot === 'string' ? message.targetWorkspaceRoot : undefined
                    );
                    break;
                case 'getPlanningSources': {
                    // NOTE: intentionally folder-scoped — this setting is per-project, not shared across workspaces
                    const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
                    const config = vscode.workspace.getConfiguration('switchboard', folderUri);
                    const enabledSources = config.get<any>('planning.enabledSources', {
                        clickup: true,
                        linear: true,
                        notion: true,
                        'local-folder': true
                    });
                    this.postMessage({
                        type: 'planningSources',
                        sources: enabledSources
                    });
                    break;
                }
                case 'getWorkspaceMappings': {
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    let mappings: { enabled: boolean; mappings: WorkspaceDatabaseMapping[] } = { enabled: false, mappings: [] };
                    if (workspaceRoot) {
                        try {
                            const db = KanbanDatabase.forWorkspace(workspaceRoot);
                            mappings = await db.getWorkspaceMappings();
                        } catch (err) {
                            console.error('[SetupPanelProvider] Failed to read workspace mappings from DB:', err);
                        }
                    }
                    const warnings: string[] = [];
                    for (const m of mappings.mappings ?? []) {
                        if (m.mode === 'connect' && m.dbPath && !fs.existsSync(m.dbPath)) {
                            warnings.push(`Mapping "${m.name}": database not found at ${m.dbPath}`);
                        }
                        if (m.parentFolder && !fs.existsSync(m.parentFolder)) {
                            warnings.push(`Mapping "${m.name}": parent folder not found at ${m.parentFolder}`);
                        }

                    }
                    this.postMessage({
                        type: 'workspaceMappings',
                        ...mappings,
                        warnings
                    });
                    break;
                }
                case 'setWorkspaceMappingEnabled': {
                    const enabled = typeof message.enabled === 'boolean' ? message.enabled : false;
                    
                    // Read current mappings from DB (source of truth)
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    let currentMappings: { enabled: boolean; mappings: WorkspaceDatabaseMapping[] } = { enabled: false, mappings: [] };
                    if (workspaceRoot) {
                        try {
                            const db = KanbanDatabase.forWorkspace(workspaceRoot);
                            currentMappings = await db.getWorkspaceMappings();
                        } catch (err) {
                            console.error('[SetupPanelProvider] Failed to read mappings from DB for setWorkspaceMappingEnabled:', err);
                        }
                    }

                    // Write to DB for each mapping
                    if (Array.isArray(currentMappings.mappings) && currentMappings.mappings.length > 0) {
                        for (const m of currentMappings.mappings) {
                            if (m.parentFolder && m.dbPath) {
                                KanbanDatabase.writeDbPointer(m.parentFolder, m.dbPath);
                                const db = KanbanDatabase.forWorkspace(m.parentFolder, m.dbPath);
                                await db.setWorkspaceMappings({
                                    enabled,
                                    mappings: currentMappings.mappings
                                });
                            }
                        }
                    }

                    this.postMessage({
                        type: 'workspaceMappingEnabled',
                        enabled
                    });
                    await vscode.commands.executeCommand('switchboard.mappingsChanged');
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'saveWorkspaceMappings': {
                    const incoming = message.payload as { enabled?: boolean; mappings?: any[] };
                    const errors: string[] = [];
                    const seenFolders = new Set<string>();
 
                    const expandHome = (p: string): string => {
                        const trimmed = p.trim();
                        return trimmed.startsWith('~')
                            ? path.join(os.homedir(), trimmed.slice(1))
                            : trimmed;
                    };
 
                    for (const m of incoming.mappings ?? []) {
                        if (!m.id || !m.name?.trim()) errors.push(`Mapping is missing id/name`);
                        const mode = m.mode || 'connect';
                        const parentFolder = m.parentFolder ? path.resolve(expandHome(m.parentFolder)) : '';
 
                        if (mode === 'create') {
                            if (!m.dbPath?.trim()) {
                                errors.push(`Mapping "${m.name}": You must click "Initialize Database" before saving.`);
                            }
                            const childFolders = (m.workspaceFolders ?? []).map((f: string) => path.resolve(expandHome(f)));
                            if (childFolders.includes(parentFolder)) {
                                errors.push(`Mapping "${m.name}": parent folder cannot also be a child workspace folder`);
                            }

                        }
 
                        if (mode === 'connect') {
                            if (!m.dbPath?.trim()) {
                                errors.push(`Mapping "${m.name}": database path is required in connect mode`);
                            } else {
                                const resolvedDbPath = path.resolve(expandHome(m.dbPath.trim()));
                                if (!fs.existsSync(resolvedDbPath)) {
                                    errors.push(`Mapping "${m.name}": database file does not exist: ${resolvedDbPath}`);
                                } else if (!resolvedDbPath.endsWith('.db')) {
                                    errors.push(`Mapping "${m.name}": database path must end with .db`);
                                }
                            }
                        }


 
                        for (const f of m.workspaceFolders ?? []) {
                            const norm = path.resolve(expandHome(f));
                            if (seenFolders.has(norm)) errors.push(`Folder ${norm} listed in multiple mappings`);
                            seenFolders.add(norm);
                        }


                    }
 
                    if (errors.length) {
                        this.postMessage({ type: 'workspaceMappingStatus', ok: false, error: errors.join('\n') });
                        break;
                    }
 
                    // Write to DB
                    if (Array.isArray(incoming.mappings)) {
                        for (const m of incoming.mappings) {
                            if (m.parentFolder && m.dbPath) {
                                KanbanDatabase.writeDbPointer(m.parentFolder, m.dbPath);
                                const db = KanbanDatabase.forWorkspace(m.parentFolder, m.dbPath);
                                await db.setWorkspaceMappings({
                                    enabled: incoming.enabled ?? false,
                                    mappings: incoming.mappings
                                });
                            }
                        }
                    }


 
                    this.postMessage({ type: 'workspaceMappingStatus', ok: true });
                    await vscode.commands.executeCommand('switchboard.mappingsChanged');
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'initializeWorkspaceDatabase': {
                    const parentFolder = String(message.parentFolder || '').trim();
                    if (!parentFolder) {
                        this.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: 'Parent folder is required.' });
                        break;
                    }
                    const expandHome = (p: string): string => {
                        const trimmed = p.trim();
                        return trimmed.startsWith('~')
                            ? path.join(os.homedir(), trimmed.slice(1))
                            : trimmed;
                    };
                    const resolvedParent = path.resolve(expandHome(parentFolder));
                    try {
                        await fs.promises.access(resolvedParent, fs.constants.W_OK);
                    } catch {
                        this.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: `Parent folder is not writable: ${resolvedParent}` });
                        break;
                    }
                    const derivedDbPath = path.join(resolvedParent, '.switchboard', 'kanban.db');
 
                    const workspaceFolders = Array.isArray(message.workspaceFolders) ? message.workspaceFolders : [];
                    const childFolders = workspaceFolders.map((f: string) => path.resolve(expandHome(f)));
                    if (childFolders.includes(resolvedParent)) {
                        this.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: 'Parent folder cannot also be a child workspace folder.' });
                        break;
                    }

 
                    try {
                        // Direct construction to bypass mapping resolution during config setup
                        const db = new (KanbanDatabase as any)(resolvedParent, derivedDbPath);
                        const created = await db.createIfMissing();
                        if (!created) {
                            this.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: 'Failed to create database. Check permissions and try again.' });
                            break;
                        }
                        // Save the mapping config with dbPath pre-filled
                        // Read current mappings from DB (source of truth), not VS Code config
                        let currentMappings: { enabled: boolean; mappings: WorkspaceDatabaseMapping[] } = { enabled: false, mappings: [] };
                        try {
                            currentMappings = await db.getWorkspaceMappings();
                        } catch {
                            // New DB, no existing mappings
                        }
                        const newMapping = {
                            id: message.mappingId || ('mapping-' + Date.now()),
                            name: message.name || path.basename(resolvedParent),
                            dbPath: derivedDbPath,
                            parentFolder: resolvedParent,
                            workspaceFolders,
                            mode: 'create'
                        };
                        const existingIndex = currentMappings.mappings.findIndex((m: any) => m.id === newMapping.id);
                        const updatedMappings = existingIndex >= 0
                            ? currentMappings.mappings.map((m: any) => m.id === newMapping.id ? newMapping : m)
                            : [...currentMappings.mappings, newMapping];
                        // Write pointer file
                        KanbanDatabase.writeDbPointer(resolvedParent, derivedDbPath);

                        // Save mapping config to database
                        const updatedPayload = {
                            enabled: true,
                            mappings: updatedMappings
                        };
                        await db.setWorkspaceMappings(updatedPayload);

                        // If there are other existing mappings, write this updated config to their DBs too
                        for (const m of updatedMappings) {
                            if (m.parentFolder && m.dbPath && m.parentFolder !== resolvedParent) {
                                KanbanDatabase.writeDbPointer(m.parentFolder, m.dbPath);
                                const otherDb = KanbanDatabase.forWorkspace(m.parentFolder, m.dbPath);
                                await otherDb.setWorkspaceMappings(updatedPayload);
                            }
                        }



                        this.postMessage({ type: 'workspaceMappingInitResult', ok: true, dbPath: derivedDbPath });
                        await vscode.commands.executeCommand('switchboard.mappingsChanged');
                        await vscode.commands.executeCommand('switchboard.refreshUI');
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        this.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: errorMessage });
                    }
                    break;
                }
                case 'browseWorkspaceMappingDbPath': {
                    const fileUri = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: { 'Database files': ['db'] },
                        title: 'Select kanban.db file'
                    });
                    if (fileUri?.[0]) {
                        this.postMessage({
                            type: 'workspaceMappingDbPathSelected',
                            path: fileUri[0].fsPath,
                            mappingId: message.mappingId
                        });
                    }
                    break;
                }
                case 'browseWorkspaceMappingFolder': {
                    const folderUri = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        title: 'Select workspace folder'
                    });
                    if (folderUri?.[0]) {
                        this.postMessage({
                            type: 'workspaceMappingFolderSelected',
                            path: folderUri[0].fsPath,
                            mappingId: message.mappingId
                        });
                    }
                    break;
                }

                case 'browseParentFolder': {
                    const parentUri = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        title: 'Select parent workspace folder (where .switchboard/ lives)'
                    });
                    if (parentUri?.[0]) {
                        const selectedPath = parentUri[0].fsPath;
                        const existingDbPath = path.join(selectedPath, '.switchboard', 'kanban.db');
                        const existingDbDetected = fs.existsSync(existingDbPath);
                        this.postMessage({
                            type: 'parentFolderSelected',
                            path: selectedPath,
                            mappingId: message.mappingId,
                            existingDbDetected
                        });
                    }
                    break;
                }
                case 'browseTicketsFolder': {
                    const provider = message.provider;
                    const folderUri = await vscode.window.showOpenDialog({
                        canSelectFolders: true,
                        canSelectFiles: false,
                        canSelectMany: false,
                        openLabel: 'Select Tickets Folder'
                    });
                    if (folderUri?.[0]) {
                        this.postMessage({
                            type: 'browseTicketsFolderResult',
                            provider,
                            path: folderUri[0].fsPath
                        });
                    }
                    break;
                }
                case 'saveTicketsFolder': {
                    const provider = message.provider;
                    const folderPath = String(message.folderPath || '').trim();
                    if (provider === 'clickup' || provider === 'linear') {
                        const config = await GlobalIntegrationConfigService.loadConfig(provider) || {};
                        config.ticketSaveLocation = folderPath;
                        await GlobalIntegrationConfigService.saveConfig(provider, config);
                        this.postMessage({
                            type: 'ticketsFoldersListed',
                            provider,
                            path: folderPath,
                            ticketsAutoSync: await GlobalIntegrationConfigService.getTicketsAutoSync()
                        });
                    }
                    break;
                }
                case 'saveTicketsAutoSync': {
                    await GlobalIntegrationConfigService.setTicketsAutoSync(message.enabled === true);
                    break;
                }
                case 'listTicketsFolders': {
                    const clickupConfig = await GlobalIntegrationConfigService.loadConfig('clickup');
                    const linearConfig = await GlobalIntegrationConfigService.loadConfig('linear');
                    const ticketsAutoSync = await GlobalIntegrationConfigService.getTicketsAutoSync();
                    this.postMessage({
                        type: 'ticketsFoldersListed',
                        provider: 'clickup',
                        path: clickupConfig?.ticketSaveLocation || '',
                        ticketsAutoSync
                    });
                    this.postMessage({
                        type: 'ticketsFoldersListed',
                        provider: 'linear',
                        path: linearConfig?.ticketSaveLocation || '',
                        ticketsAutoSync
                    });
                    break;
                }
                // ── Remote Control (§10) — delegated to KanbanProvider ─────────
                case 'getRemoteConfig': {
                    const payload = await this._kanbanProvider?.remoteGetConfigPayload(message.workspaceRoot);
                    if (payload) { this.postMessage(payload); }
                    break;
                }
                case 'setRemoteConfig': {
                    const payload = await this._kanbanProvider?.remoteSetConfig(message.workspaceRoot, message.config);
                    if (payload) { this.postMessage(payload); }
                    break;
                }
                case 'runNotionRemoteSetup': {
                    if (!this._kanbanProvider) {
                        this.postMessage({ type: 'notionRemoteSetupResult', success: false, error: 'Kanban provider unavailable' });
                        break;
                    }
                    const result = await this._kanbanProvider.remoteRunNotionSetup(message.workspaceRoot);
                    this.postMessage({ type: 'notionRemoteSetupResult', ...result });
                    break;
                }
                case 'startRemoteControl': {
                    const active = (await this._kanbanProvider?.remoteStart(message.workspaceRoot)) === true;
                    this.postMessage({ type: 'remoteControlState', active });
                    break;
                }
                case 'stopRemoteControl': {
                    const active = this._kanbanProvider?.remoteStop(message.workspaceRoot) === true;
                    this.postMessage({ type: 'remoteControlState', active });
                    break;
                }
                case 'getRemoteHealth': {
                    const payload = await this._kanbanProvider?.remoteGetHealthPayload(message.workspaceRoot);
                    if (payload) { this.postMessage(payload); }
                    break;
                }
                case 'copyLinearAgentSkill': {
                    if (!this._kanbanProvider) {
                        this.postMessage({ type: 'linearAgentSkillText', text: null, error: 'Kanban provider unavailable' });
                        break;
                    }
                    const result = await this._kanbanProvider.remoteBuildLinearAgentSkillText(message.workspaceRoot);
                    this.postMessage({
                        type: 'linearAgentSkillText',
                        text: result.text || null,
                        error: result.error,
                    });
                    break;
                }
                case 'getProjectContextSyncStatus': {
                    const payload = await this._kanbanProvider?.projectContextGetStatus(message.workspaceRoot);
                    if (payload) { this.postMessage(payload); }
                    break;
                }
                case 'setProjectContextSyncEnabled': {
                    const payload = await this._kanbanProvider?.projectContextSetEnabled(message.workspaceRoot, message.enabled === true);
                    if (payload) { this.postMessage(payload); }
                    break;
                }
                case 'projectContextSyncNow': {
                    this.postMessage({ type: 'projectContextSyncRunning' });
                    const payload = await this._kanbanProvider?.projectContextSyncNow(message.workspaceRoot, { auto: false });
                    if (payload) { this.postMessage(payload); }
                    else { this.postMessage({ type: 'projectContextSyncStatus', state: null, error: 'No workspace resolved' }); }
                    break;
                }
                case 'getAgentDirCleanupState': {
                    const state = await this._getAgentDirCleanupState();
                    this.postMessage({ type: 'agentDirCleanupState', ...state });
                    break;
                }
                case 'performAgentDirCleanup': {
                    const result = await this._performAgentDirCleanup();
                    this.postMessage({ type: 'agentDirCleanupResult', ...result });
                    break;
                }
                default:
                    break;
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Setup panel error: ${errorMessage}`);
        }
    }

    private async _getControlPlaneStatus(workspaceRoot?: string): Promise<any> {
        const provider = this._taskViewerProvider as ControlPlaneTaskViewerProvider;
        if (typeof provider.handleGetControlPlaneStatus === 'function') {
            return provider.handleGetControlPlaneStatus(workspaceRoot);
        }

        const dbPath = await this._taskViewerProvider?.handleGetDbPath(workspaceRoot);
        // NOTE: intentionally folder-scoped — controlPlaneRoot is per-project, not shared across workspaces
        const folderUri = this._getWorkspaceFolderUri(dbPath?.workspaceRoot || workspaceRoot);
        const config = vscode.workspace.getConfiguration('switchboard', folderUri);
        const explicitControlPlaneRoot = String(config.get<string>('kanban.controlPlaneRoot', '') || '').trim();
        return {
            success: true,
            workspaceRoot: dbPath?.workspaceRoot || workspaceRoot || '',
            path: dbPath?.path || '.switchboard/kanban.db',
            effectiveControlPlaneRoot: explicitControlPlaneRoot || '',
            explicitControlPlaneRoot,
            selectedWorkspaceRoot: dbPath?.workspaceRoot || workspaceRoot || '',
            repoFilter: '',
            mode: explicitControlPlaneRoot ? 'explicit' : 'auto'
        };
    }

    private async _setExplicitControlPlaneRoot(controlPlaneRoot: string, workspaceRoot?: string): Promise<any> {
        const provider = this._taskViewerProvider as ControlPlaneTaskViewerProvider;
        if (typeof provider.handleSetExplicitControlPlaneRoot === 'function') {
            const normalizedRoot = await this._validateControlPlaneRoot(controlPlaneRoot);
            const result: any = await provider.handleSetExplicitControlPlaneRoot(normalizedRoot, workspaceRoot);
            return {
                success: true,
                message: 'Saved the explicit Control Plane root.',
                ...result,
                explicitControlPlaneRoot: result?.explicitControlPlaneRoot ?? normalizedRoot,
                effectiveControlPlaneRoot: result?.controlPlaneRoot ?? result?.effectiveWorkspaceRoot ?? normalizedRoot,
                mode: result?.mode || 'explicit'
            };
        }

        const normalizedRoot = await this._validateControlPlaneRoot(controlPlaneRoot);
        // NOTE: intentionally folder-scoped — controlPlaneRoot is per-project, not shared across workspaces
        const folderUri = this._getWorkspaceFolderUri(workspaceRoot);
        const config = vscode.workspace.getConfiguration('switchboard', folderUri);
        await config.update(
            'kanban.controlPlaneRoot',
            normalizedRoot,
            folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace
        );

        return {
            success: true,
            message: 'Saved the explicit Control Plane root. Board behavior will fully update once the shared control-plane provider wiring is present.',
            explicitControlPlaneRoot: normalizedRoot,
            effectiveControlPlaneRoot: normalizedRoot,
            workspaceRoot: workspaceRoot || this._getCurrentWorkspaceRoot() || '',
            mode: 'explicit'
        };
    }

    private async _resetExplicitControlPlaneRoot(workspaceRoot?: string): Promise<any> {
        const provider = this._taskViewerProvider as ControlPlaneTaskViewerProvider;
        if (typeof provider.handleResetExplicitControlPlaneRoot === 'function') {
            const result: any = await provider.handleResetExplicitControlPlaneRoot(workspaceRoot);
            return {
                success: true,
                message: 'Reset the Control Plane override back to auto-detect.',
                ...result,
                explicitControlPlaneRoot: result?.explicitControlPlaneRoot ?? '',
                mode: result?.mode || 'auto'
            };
        }

        const folderUri = this._getWorkspaceFolderUri(workspaceRoot);
        const config = vscode.workspace.getConfiguration('switchboard', folderUri);
        await config.update(
            'kanban.controlPlaneRoot',
            '',
            folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace
        );

        return {
            success: true,
            message: 'Reset the explicit Control Plane override. Auto-detect will fully apply once the shared control-plane provider wiring is present.',
            explicitControlPlaneRoot: '',
            effectiveControlPlaneRoot: '',
            workspaceRoot: workspaceRoot || this._getCurrentWorkspaceRoot() || '',
            mode: 'auto'
        };
    }

    private async _clearControlPlaneCache(workspaceRoot?: string): Promise<any> {
        const provider = this._taskViewerProvider as ControlPlaneTaskViewerProvider;
        if (typeof provider.handleClearControlPlaneCache === 'function') {
            const result: any = await provider.handleClearControlPlaneCache(workspaceRoot);
            return {
                success: true,
                message: 'Cleared cached Control Plane decisions.',
                ...result
            };
        }

        try {
            await vscode.commands.executeCommand('switchboard.clearControlPlaneCache');
            return {
                success: true,
                message: 'Cleared cached Control Plane decisions.'
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error
                    ? error.message
                    : 'Control Plane cache clearing requires the shared command wiring to be integrated.'
            };
        }
    }

    private async _validateControlPlaneRoot(controlPlaneRoot: string): Promise<string> {
        const rawValue = String(controlPlaneRoot || '').trim();
        if (!rawValue) {
            throw new Error('Enter a Control Plane folder before saving an explicit override.');
        }

        const normalizedRoot = path.resolve(rawValue);
        try {
            await fs.promises.access(normalizedRoot, fs.constants.R_OK);
        } catch {
            throw new Error('Control Plane folder must exist and be readable.');
        }

        const dbPath = path.join(normalizedRoot, '.switchboard', 'kanban.db');
        try {
            await fs.promises.access(dbPath, fs.constants.R_OK);
        } catch {
            throw new Error('Control Plane folder must contain .switchboard/kanban.db.');
        }
        return normalizedRoot;
    }

    private async _openDocs(): Promise<void> {
        const manualPath = vscode.Uri.joinPath(this._extensionUri, 'docs', 'switchboard_user_manual.md');
        try {
            await vscode.workspace.fs.stat(manualPath);
            await vscode.commands.executeCommand('markdown.showPreview', manualPath);
            return;
        } catch {
            // Manual not found — fall back to README.md
        }

        const readmePath = vscode.Uri.joinPath(this._extensionUri, 'README.md');
        try {
            await vscode.workspace.fs.stat(readmePath);
            await vscode.commands.executeCommand('markdown.showPreview', readmePath);
        } catch {
            vscode.window.showErrorMessage('Plugin documentation not found.');
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

        // Inject shared defaults
        const sharedDefaultsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedDefaults.js')).toString();
        content = content.replace('<!-- SHARED_DEFAULTS_SCRIPT -->', `<script src="${sharedDefaultsUri}" nonce="${nonce}"></script>`);

        const hankenFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'HankenGrotesk-Variable.woff2')
        );
        content = content.replace(/\{\{HANKEN_FONT_URI\}\}/g, hankenFontUri.toString());

        content = applyThemeBodyClass(content);
        return content;
    }

    /**
     * Resolve all workspace roots to scan, including mapped children that may not be
     * open in the current window but are the primary victims of scaffold litter.
     */
    private _getCleanupScanRoots(): string[] {
        const roots = new Set<string>();
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                roots.add(path.resolve(folder.uri.fsPath));
            }
        }

        const cfg = getMappingsFromIndex();
        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
            for (const m of cfg.mappings) {
                if (m.parentFolder) {
                    const expanded = m.parentFolder.startsWith('~')
                        ? path.join(os.homedir(), m.parentFolder.slice(1))
                        : m.parentFolder;
                    if (expanded.trim()) {
                        try { roots.add(path.resolve(expanded)); } catch {}
                    }
                }
                if (Array.isArray(m.workspaceFolders)) {
                    for (const wf of m.workspaceFolders) {
                        const expanded = wf.startsWith('~')
                            ? path.join(os.homedir(), wf.slice(1))
                            : wf;
                        if (expanded.trim()) {
                            try { roots.add(path.resolve(expanded)); } catch {}
                        }
                    }
                }
            }
        }

        return Array.from(roots);
    }

    /**
     * Tiered predicate mirroring extension.ts isSwitchboardManagedFolder:
     * mapped children are not managed, configured parents are, and unclaimed roots
     * must carry a deliberate-setup marker (kanban.db or db-pointer). workspace-id
     * is deliberately excluded — it was self-planted into unrelated repos by the
     * identity writers pre-guard, so it proves nothing (keep in sync with extension.ts).
     */
    private _isSwitchboardManagedFolder(root: string): boolean {
        const resolvedRoot = path.resolve(root);
        try {
            const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(resolvedRoot);
            if (effectiveRoot !== resolvedRoot) {
                return false;
            }

            const cfg = getMappingsFromIndex();
            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                for (const mapping of cfg.mappings) {
                    if (mapping.parentFolder) {
                        const expanded = mapping.parentFolder.startsWith('~')
                            ? path.join(os.homedir(), mapping.parentFolder.slice(1))
                            : mapping.parentFolder;
                        if (path.resolve(expanded) === resolvedRoot) {
                            return true;
                        }
                    }
                }
            }

            const switchboardDir = path.join(resolvedRoot, '.switchboard');
            if (!fs.existsSync(switchboardDir) || !fs.statSync(switchboardDir).isDirectory()) {
                return false;
            }

            const markers = ['kanban.db', 'db-pointer'];
            return markers.some(name => fs.existsSync(path.join(switchboardDir, name)));
        } catch {
            return false;
        }
    }

    /**
     * Check whether any of the given relative paths are tracked by git.
     */
    private async _gitHasTrackedPaths(root: string, paths: string[]): Promise<boolean> {
        return new Promise((resolve) => {
            cp.execFile('git', ['ls-files', '--error-unmatch', '--', ...paths], { cwd: root, timeout: 10000 }, (_, stdout) => {
                // stdout contains the tracked paths; exit code 1 is produced whenever
                // any path is untracked, so we only care whether stdout has entries.
                resolve(stdout.trim().length > 0);
            });
        });
    }

    /**
     * Remove the scaffold litter set from a root. If preservePlans is true, the
     * `.switchboard/plans/` directory is kept and only the rest of `.switchboard/`
     * is removed.
     */
    private async _performScaffoldLitterCleanup(root: string, preservePlans: boolean): Promise<{
        removed: string[];
        skipped: string[];
    }> {
        const removed: string[] = [];
        const skipped: string[] = [];

        // `.agents/` is Switchboard's managed source-of-truth dir (the user's dir is the
        // SINGULAR `.agent/`, handled by the separate legacy-cleanup path and never touched
        // here). In a littered non-managed folder it is entirely a Switchboard dump, so it
        // is removed wholesale — with a symlink guard.
        const dotAgents = path.join(root, '.agents');
        try {
            const stat = fs.lstatSync(dotAgents);
            if (stat.isSymbolicLink()) {
                skipped.push('.agents/ is a symlink');
            } else if (stat.isDirectory()) {
                await fs.promises.rm(dotAgents, { recursive: true, force: true });
                removed.push('.agents/');
            }
        } catch (err: any) {
            if (err?.code !== 'ENOENT') {
                skipped.push(`.agents/ removal failed: ${err.message || err}`);
            }
        }

        // `.claude/` is the user's Claude Code config directory. Switchboard only ever
        // writes ledger-tracked skills + a non-destructive settings.json merge into it, so
        // we remove ONLY what the ledger records — never the directory wholesale. Deleting
        // `.claude/` would destroy the user's own settings.json, settings.local.json,
        // commands/, plans/, and hand-authored skills.
        await this._removeMirroredClaudeSkills(root, removed, skipped);

        // CLAUDE.md / AGENTS.md carry a marker-delimited Switchboard managed block that
        // coexists with user-authored content (this repo's own CLAUDE.md is a live example:
        // user rules above the block, generated protocol inside it). Strip ONLY the block;
        // delete the file only if nothing else survives.
        await this._stripManagedBlock(root, 'CLAUDE.md', CLAUDE_MANAGED_BLOCK_START, CLAUDE_MANAGED_BLOCK_END, removed, skipped);
        await this._stripManagedBlock(root, 'AGENTS.md', AGENTS_MANAGED_BLOCK_START, AGENTS_MANAGED_BLOCK_END, removed, skipped);

        const switchboardDir = path.join(root, '.switchboard');
        try {
            const stat = fs.lstatSync(switchboardDir);
            if (stat.isSymbolicLink()) {
                skipped.push('.switchboard/ is a symlink');
                return { removed, skipped };
            }
            if (!stat.isDirectory()) {
                skipped.push('.switchboard/ is not a directory');
                return { removed, skipped };
            }

            const entries = await fs.promises.readdir(switchboardDir, { withFileTypes: true });
            for (const entry of entries) {
                if (preservePlans && entry.name === 'plans') {
                    continue;
                }

                const childPath = path.join(switchboardDir, entry.name);
                try {
                    if (entry.isSymbolicLink()) {
                        skipped.push(`.switchboard/${entry.name} is a symlink`);
                        continue;
                    }
                    if (entry.isDirectory()) {
                        await fs.promises.rm(childPath, { recursive: true, force: true });
                        removed.push(`.switchboard/${entry.name}/`);
                    } else if (entry.isFile()) {
                        await fs.promises.unlink(childPath);
                        removed.push(`.switchboard/${entry.name}`);
                    }
                } catch (err: any) {
                    skipped.push(`.switchboard/${entry.name} removal failed: ${err.message || err}`);
                }
            }

            if (preservePlans) {
                removed.push('.switchboard/plans/ preserved');
            } else {
                await fs.promises.rmdir(switchboardDir);
                removed.push('.switchboard/');
            }
        } catch (err: any) {
            if (err?.code !== 'ENOENT') {
                skipped.push(`.switchboard/ cleanup failed: ${err.message || err}`);
            }
        }

        return { removed, skipped };
    }

    /**
     * Surgically remove only the Claude Code skills THIS extension generated into
     * `<root>/.claude/`, tracked in the `.switchboard-generated.json` ledger. Mirrors
     * ClaudeCodeMirrorService's own stale-mirror cleanup: only ledger-named skill dirs
     * are touched; user-authored skills, settings.json, commands/, plans/, etc. are left
     * intact. If there is no ledger, `.claude/` was not created by Switchboard (or by a
     * pre-ledger version) and is not touched at all. Empty dirs are pruned afterwards.
     */
    private async _removeMirroredClaudeSkills(root: string, removed: string[], skipped: string[]): Promise<void> {
        const claudeDir = path.join(root, '.claude');
        try {
            const stat = fs.lstatSync(claudeDir);
            if (stat.isSymbolicLink()) {
                skipped.push('.claude/ is a symlink');
                return;
            }
            if (!stat.isDirectory()) return;
        } catch (err: any) {
            if (err?.code !== 'ENOENT') skipped.push(`.claude/ inspect failed: ${err.message || err}`);
            return;
        }

        const ledgerPath = path.join(claudeDir, CLAUDE_GENERATED_MANIFEST_FILE);
        let ledger: any;
        try {
            ledger = JSON.parse(await fs.promises.readFile(ledgerPath, 'utf8'));
        } catch {
            // No ledger → not Switchboard-generated (or pre-ledger). Leave `.claude/` alone.
            return;
        }

        const skillsRoot = path.join(claudeDir, 'skills');
        const skills: Array<{ name?: string }> = Array.isArray(ledger?.skills) ? ledger.skills : [];
        for (const s of skills) {
            if (!s?.name) continue;
            const staleDir = path.join(skillsRoot, s.name);
            // Path-traversal guard: never step outside `.claude/skills/`.
            if (staleDir !== skillsRoot && !staleDir.startsWith(skillsRoot + path.sep)) continue;
            try {
                await fs.promises.rm(path.join(staleDir, 'SKILL.md'), { force: true });
                await fs.promises.rmdir(staleDir);
                removed.push(`.claude/skills/${s.name}/`);
            } catch {
                // Dir non-empty (user files) or already gone — leave it.
            }
        }

        // Remove the ledger, then prune now-empty Switchboard dirs. Non-empty (user
        // content) dirs are left, so a shared `.claude/` survives with the user's files.
        try { await fs.promises.rm(ledgerPath, { force: true }); removed.push(`.claude/${CLAUDE_GENERATED_MANIFEST_FILE}`); } catch {}
        try { await fs.promises.rmdir(skillsRoot); } catch { /* non-empty — leave */ }
        try { await fs.promises.rmdir(claudeDir); removed.push('.claude/ (was empty)'); } catch { /* non-empty — leave */ }
    }

    /**
     * Strip only the marker-delimited Switchboard managed block from a shared protocol
     * file (CLAUDE.md / AGENTS.md), preserving all user-authored content outside it.
     * Spans first-start → last-end to collapse any duplicate markers. If the file has no
     * markers it is left untouched. If nothing but whitespace remains after stripping,
     * the file was Switchboard-only and is deleted.
     */
    private async _stripManagedBlock(root: string, fileName: string, blockStart: string, blockEnd: string, removed: string[], skipped: string[]): Promise<void> {
        const filePath = path.join(root, fileName);
        try {
            const stat = fs.lstatSync(filePath);
            if (stat.isSymbolicLink()) {
                skipped.push(`${fileName} is a symlink`);
                return;
            }
            if (!stat.isFile()) return;
        } catch (err: any) {
            if (err?.code !== 'ENOENT') skipped.push(`${fileName} inspect failed: ${err.message || err}`);
            return;
        }

        let content: string;
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
        } catch (err: any) {
            skipped.push(`${fileName} read failed: ${err.message || err}`);
            return;
        }

        const startIdx = content.indexOf(blockStart);
        const endIdx = content.lastIndexOf(blockEnd);
        if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
            // No well-formed managed block → purely user content (or malformed). Leave it.
            return;
        }

        const stripped = (content.slice(0, startIdx) + content.slice(endIdx + blockEnd.length)).trim();
        try {
            if (stripped.length === 0) {
                await fs.promises.unlink(filePath);
                removed.push(fileName);
            } else {
                await fs.promises.writeFile(filePath, stripped + '\n', 'utf8');
                removed.push(`${fileName} (Switchboard block stripped, user content kept)`);
            }
        } catch (err: any) {
            skipped.push(`${fileName} update failed: ${err.message || err}`);
        }
    }

    /**
     * Scan workspace root(s) for a stale `.agent/` directory or scaffold litter that
     * can be safely cleaned up. Returns the list of deletable roots and skipped roots.
     */
    private async _getAgentDirCleanupState(): Promise<{
        hasStaleAgentDir: boolean;
        roots: Array<{ root: string; deletable: boolean; reason?: string; agentDir?: boolean; agentDirDeletable?: boolean; litter?: boolean; litterDeletable?: boolean; preservedPlans?: boolean }>;
    }> {
        const roots: Array<{ root: string; deletable: boolean; reason?: string; agentDir?: boolean; agentDirDeletable?: boolean; litter?: boolean; litterDeletable?: boolean; preservedPlans?: boolean }> = [];

        for (const root of this._getCleanupScanRoots()) {
            const legacyDir = path.join(root, '.agent');
            const switchboardDir = path.join(root, '.switchboard');
            const hasAgentDir = fs.existsSync(legacyDir);
            const hasSwitchboardDir = fs.existsSync(switchboardDir) && fs.statSync(switchboardDir).isDirectory();
            const hasLitter = hasSwitchboardDir && !this._isSwitchboardManagedFolder(root);

            if (!hasAgentDir && !hasLitter) {
                continue;
            }

            const entry: any = { root, agentDir: hasAgentDir, litter: hasLitter, deletable: false };
            const reasons: string[] = [];

            if (hasAgentDir) {
                const agentsDir = path.join(root, '.agents');
                if (!fs.existsSync(agentsDir)) {
                    reasons.push('No .agents/ directory found — removing .agent/ would leave you without agent assets.');
                } else {
                    try {
                        const stat = fs.lstatSync(legacyDir);
                        if (stat.isSymbolicLink()) {
                            reasons.push('.agent/ is a symlink — refusing to delete for safety.');
                        } else {
                            const configRefsLegacy = await this._configReferencesLegacyAgent(root);
                            if (configRefsLegacy) {
                                reasons.push('Your Switchboard configuration references .agent/ — remove those references before cleaning up.');
                            } else {
                                entry.agentDirDeletable = true;
                            }
                        }
                    } catch {
                        reasons.push('Unable to inspect .agent/ directory.');
                    }
                }
            }

            if (hasLitter) {
                try {
                    const stat = fs.lstatSync(switchboardDir);
                    if (stat.isSymbolicLink()) {
                        reasons.push('.switchboard/ is a symlink — refusing to delete for safety.');
                    } else {
                        const tracked = await this._gitHasTrackedPaths(root, ['.switchboard', '.agents', '.claude', 'AGENTS.md', 'CLAUDE.md']);
                        if (tracked) {
                            reasons.push('Scaffold files are tracked by git — refusing to delete.');
                        } else {
                            const plansDir = path.join(switchboardDir, 'plans');
                            let planFiles: string[] = [];
                            try {
                                const entries = await fs.promises.readdir(plansDir, { withFileTypes: true });
                                planFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);
                            } catch {
                                // plans directory absent or unreadable
                            }

                            if (planFiles.length > 0) {
                                entry.preservedPlans = true;
                            }
                            entry.litterDeletable = true;
                        }
                    }
                } catch {
                    reasons.push('Unable to inspect .switchboard/ directory.');
                }
            }

            if (entry.agentDirDeletable || entry.litterDeletable) {
                entry.deletable = true;
            } else if (reasons.length > 0) {
                entry.reason = reasons.join(' ');
            }

            roots.push(entry);
        }

        return { hasStaleAgentDir: roots.length > 0, roots };
    }

    /**
     * Perform the guarded cleanup of stale `.agent/` directories and scaffold litter.
     */
    private async _performAgentDirCleanup(): Promise<{
        success: boolean;
        removedRoots: string[];
        skippedRoots: Array<{ root: string; reason: string }>;
    }> {
        const state = await this._getAgentDirCleanupState();
        const removedRoots: string[] = [];
        const skippedRoots: Array<{ root: string; reason: string }> = [];

        for (const entry of state.roots) {
            if (!entry.deletable) {
                if (entry.reason) {
                    skippedRoots.push({ root: entry.root, reason: entry.reason });
                }
                continue;
            }

            const removedParts: string[] = [];
            const skippedParts: string[] = [];

            if (entry.agentDir && entry.agentDirDeletable) {
                const legacyDir = path.join(entry.root, '.agent');
                try {
                    const stat = fs.lstatSync(legacyDir);
                    if (stat.isSymbolicLink()) {
                        skippedParts.push('.agent/ is a symlink — refusing to delete for safety.');
                    } else if (!fs.existsSync(path.join(entry.root, '.agents'))) {
                        skippedParts.push('No .agents/ directory found — removing .agent/ would leave you without agent assets.');
                    } else {
                        await fs.promises.rm(legacyDir, { recursive: true, force: true });
                        removedParts.push('.agent/');
                    }
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    skippedParts.push(`.agent/ removal failed: ${reason}`);
                }
            } else if (entry.agentDir && !entry.agentDirDeletable) {
                skippedParts.push('old .agent/ directory not deletable');
            }

            if (entry.litter && entry.litterDeletable) {
                const result = await this._performScaffoldLitterCleanup(entry.root, !!entry.preservedPlans);
                removedParts.push(...result.removed);
                skippedParts.push(...result.skipped);
            } else if (entry.litter && !entry.litterDeletable) {
                skippedParts.push('scaffold litter not deletable');
            }

            if (removedParts.length > 0) {
                removedRoots.push(entry.root);
            }
            if (skippedParts.length > 0) {
                skippedRoots.push({ root: entry.root, reason: skippedParts.join('; ') });
            }
        }

        return { success: true, removedRoots, skippedRoots };
    }

    /**
     * Check whether any Switchboard agent-asset config value points into `.agent/`.
     */
    private async _configReferencesLegacyAgent(workspaceRoot: string): Promise<boolean> {
        try {
            const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(workspaceRoot));
            const plannerWorkflowPath = config.get<string>('planner.workflowPath', '');
            if (plannerWorkflowPath && plannerWorkflowPath.includes('.agent/')) {
                return true;
            }

            // Check Switchboard's internal config (stored via webview UI)
            const internalConfigPath = path.join(workspaceRoot, '.switchboard', 'config.json');
            if (fs.existsSync(internalConfigPath)) {
                const raw = fs.readFileSync(internalConfigPath, 'utf8');
                const internalConfig = JSON.parse(raw);
                const checkValue = (val: unknown): boolean => {
                    if (typeof val === 'string' && val.includes('.agent/')) return true;
                    if (val && typeof val === 'object') {
                        return Object.values(val).some(checkValue);
                    }
                    return false;
                };
                if (checkValue(internalConfig)) {
                    return true;
                }
            }
        } catch {
            // Non-fatal — assume no legacy references if we can't read config
        }
        return false;
    }

    /**
     * Resolve all workspace root paths (supports multi-root workspaces).
     */
    private _resolveWorkspaceRoots(): string[] {
        const roots: string[] = [];
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                roots.push(folder.uri.fsPath);
            }
        }
        return roots;
    }
}
