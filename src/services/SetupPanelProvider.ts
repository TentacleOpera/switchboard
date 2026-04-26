import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ControlPlaneMigrationService } from './ControlPlaneMigrationService';
import { MultiRepoScaffoldingService } from './MultiRepoScaffoldingService';
import type { TaskViewerProvider } from './TaskViewerProvider';

type ControlPlaneTaskViewerProvider = TaskViewerProvider & {
    handleGetControlPlaneStatus?: (workspaceRoot?: string) => Promise<any>;
    handleSetExplicitControlPlaneRoot?: (controlPlaneRoot: string, workspaceRoot?: string) => Promise<any>;
    handleResetExplicitControlPlaneRoot?: (workspaceRoot?: string) => Promise<any>;
    handleClearControlPlaneCache?: (workspaceRoot?: string) => Promise<any>;
};

export class SetupPanelProvider implements vscode.Disposable {
    private _panel?: vscode.WebviewPanel;
    private _taskViewerProvider?: TaskViewerProvider;
    private _disposables: vscode.Disposable[] = [];
    private _pendingSection?: string;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public get isOpen(): boolean {
        return !!this._panel;
    }

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

    private _getWorkspaceFolderUri(workspaceRoot?: string): vscode.Uri | undefined {
        const resolvedRoot = String(workspaceRoot || '').trim();
        if (!resolvedRoot) {
            return undefined;
        }
        return vscode.workspace.workspaceFolders?.find((folder) =>
            path.resolve(folder.uri.fsPath) === path.resolve(resolvedRoot)
        )?.uri;
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
                case 'getControlPlaneStatus': {
                    const status = await this._getControlPlaneStatus(typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined);
                    this._panel.webview.postMessage({ type: 'controlPlaneStatusResult', ...status });
                    break;
                }
                case 'setExplicitControlPlaneRoot': {
                    const result = await this._setExplicitControlPlaneRoot(
                        typeof message.controlPlaneRoot === 'string' ? message.controlPlaneRoot : '',
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this._panel.webview.postMessage({ type: 'controlPlaneOverrideResult', action: 'set', ...result });
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
                    this._panel.webview.postMessage({ type: 'controlPlaneOverrideResult', action: 'reset', ...result });
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
                        this._panel.webview.postMessage({
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
                    this._panel.webview.postMessage({ type: 'controlPlaneOverrideResult', action: 'clear-cache', ...result });
                    if (result.success) {
                        await this._taskViewerProvider.postSetupPanelState();
                        await vscode.commands.executeCommand('switchboard.refreshUI');
                    }
                    break;
                }
                case 'detectControlPlaneCandidate': {
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    const candidate = await ControlPlaneMigrationService.detectCandidateParent(workspaceRoot);
                    this._panel.webview.postMessage({ type: 'controlPlaneCandidateResult', ...candidate });
                    break;
                }
                case 'previewControlPlaneMigration': {
                    const preview = await ControlPlaneMigrationService.previewMigration(String(message.parentDir || ''));
                    this._panel.webview.postMessage({ type: 'controlPlaneMigrationPreview', ...preview });
                    break;
                }
                case 'executeControlPlaneMigration': {
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
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
                    this._panel.webview.postMessage({ type: 'controlPlaneMigrationResult', ...result });
                    break;
                }
                case 'executeControlPlaneFreshSetup': {
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
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
                    this._panel.webview.postMessage({ type: 'controlPlaneFreshSetupResult', ...result });
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
                        this._panel.webview.postMessage({ type: 'multiRepoScaffoldResult', result });
                    } catch (error) {
                        this._panel.webview.postMessage({
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
                    try {
                        const result = await this._taskViewerProvider.handleApplyLinearConfig(
                            message.token,
                            message.options ?? {}
                        );
                        this._panel.webview.postMessage({ type: 'linearApplyResult', ...result });
                        await this._taskViewerProvider.postSetupPanelState();
                        await vscode.commands.executeCommand('switchboard.refreshUI');
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        this._panel.webview.postMessage({
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
                    this._panel.webview.postMessage({ type: 'linearAutomationSaved', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'linearBrowseProjects': {
                    const result = await this._taskViewerProvider.handleLinearBrowseProjects();
                    if (!result.success) {
                        this._panel.webview.postMessage({
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
                            this._panel.webview.postMessage({
                                type: 'linearBrowseProjectsResult',
                                success: true,
                                target: message.target,
                                projects: selectedNames
                            });
                        }
                    } catch (error) {
                        this._panel.webview.postMessage({
                            type: 'linearBrowseProjectsResult',
                            success: false,
                            error: error instanceof Error ? error.message : String(error)
                        });
                    }
                    break;
                }
                case 'getOllamaStatus': {
                    const state = await this._taskViewerProvider.handleGetOllamaSetupState();
                    this._panel.webview.postMessage({ type: 'ollamaSetupState', state });
                    break;
                }
                case 'openOllamaInstall': {
                    const result = await this._taskViewerProvider.handleOpenOllamaInstall();
                    this._panel.webview.postMessage({ type: 'ollamaActionResult', action: 'install', ...result });
                    break;
                }
                case 'ollamaSignIn': {
                    const result = await this._taskViewerProvider.handleOllamaSignIn();
                    this._panel.webview.postMessage({ type: 'ollamaActionResult', action: 'signin', ...result });
                    await this._taskViewerProvider.postSetupPanelState();
                    break;
                }
                case 'setOllamaInternModel': {
                    const result = await this._taskViewerProvider.handleSetOllamaInternModel({
                        enabled: typeof message.enabled === 'boolean' ? message.enabled : undefined,
                        mode: message.mode === 'local' ? 'local' : message.mode === 'cloud' ? 'cloud' : undefined,
                        model: typeof message.model === 'string' ? message.model : undefined
                    });
                    this._panel.webview.postMessage({ type: 'ollamaInternModelSaved', ...result });
                    if (result.success) {
                        await this._taskViewerProvider.postSetupPanelState();
                    }
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
                case 'saveIntegrationProviderPreference': {
                    const provider = message.provider === 'clickup' ? 'clickup' : 'linear';
                    const folderUri = this._getWorkspaceFolderUri();
                    const config = vscode.workspace.getConfiguration('switchboard', folderUri);
                    await config.update(
                        'integrations.preferredProvider',
                        provider,
                        folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace
                    );
                    // Broadcast to sidebar so tab label updates
                    this._taskViewerProvider.broadcastToWebviews({
                        type: 'integrationProviderPreference',
                        provider
                    });
                    break;
                }
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
                    const folderUri = this._getWorkspaceFolderUri();
                    const config = vscode.workspace.getConfiguration('switchboard', folderUri);
                    await config.update(
                        'planning.enabledSources',
                        sources,
                        folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace
                    );
                    this._panel.webview.postMessage({ type: 'planningSourcesSaved', success: true });
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
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
                case 'getPlanningPanelSyncMode': {
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    const mode = await this._getPlanningPanelSyncMode(workspaceRoot);
                    const selectedContainers = await this._getPlanningPanelSelectedContainers(workspaceRoot);
                    this._panel?.webview.postMessage({
                        type: 'planningPanelSyncModeReady',
                        mode,
                        selectedContainers
                    });
                    break;
                }
                case 'setPlanningPanelSyncMode': {
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    const syncMode = typeof message.mode === 'string' ? message.mode : 'no-sync';
                    await this._setPlanningPanelSyncMode(workspaceRoot, syncMode);
                    await this._triggerPlanningPanelSync(workspaceRoot, syncMode);
                    break;
                }
                case 'fetchAvailableSyncContainers': {
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    const containers = await this._fetchAvailableSyncContainers(workspaceRoot);
                    const selected = await this._getPlanningPanelSelectedContainers(workspaceRoot);
                    this._panel?.webview.postMessage({
                        type: 'availableSyncContainersReady',
                        containers,
                        selectedContainers: selected
                    });
                    break;
                }
                case 'setPlanningPanelSelectedContainers': {
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    const containers = Array.isArray(message.containers) ? message.containers.map((v: unknown) => String(v)) : [];
                    await this._setPlanningPanelSelectedContainers(workspaceRoot, containers);
                    await this._triggerPlanningPanelSync(workspaceRoot, 'sync-selected');
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
            workspaceRoot: workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
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
            workspaceRoot: workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
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
        const readmePath = vscode.Uri.joinPath(this._extensionUri, 'README.md');
        try {
            await vscode.workspace.fs.stat(readmePath);
            await vscode.commands.executeCommand('markdown.showPreview', readmePath);
        } catch {
            vscode.window.showErrorMessage('Plugin README.md not found.');
        }
    }

    // Planning Panel sync helper methods
    private async _getPlanningPanelSyncMode(workspaceRoot: string): Promise<string> {
        const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
        try {
            await fs.promises.access(configPath, fs.constants.R_OK);
            const content = await fs.promises.readFile(configPath, 'utf8');
            const config = JSON.parse(content);
            return config.syncMode || 'no-sync';
        } catch {
            return 'no-sync';
        }
    }

    private async _setPlanningPanelSyncMode(workspaceRoot: string, syncMode: string): Promise<void> {
        const configDir = path.join(workspaceRoot, '.switchboard');
        await fs.promises.mkdir(configDir, { recursive: true });
        const configPath = path.join(configDir, 'planning-sync-config.json');
        let config: any = {};
        try {
            const content = await fs.promises.readFile(configPath, 'utf8');
            config = JSON.parse(content);
        } catch { /* file doesn't exist yet — start fresh */ }
        config.syncMode = syncMode;
        config.lastSyncAt = new Date().toISOString();
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    }

    private async _getPlanningPanelSelectedContainers(workspaceRoot: string): Promise<string[]> {
        const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
        try {
            await fs.promises.access(configPath, fs.constants.R_OK);
            const content = await fs.promises.readFile(configPath, 'utf8');
            const config = JSON.parse(content);
            return config.selectedContainers || [];
        } catch {
            return [];
        }
    }

    private async _setPlanningPanelSelectedContainers(workspaceRoot: string, containers: string[]): Promise<void> {
        const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
        try {
            await fs.promises.access(configPath, fs.constants.R_OK);
            const content = await fs.promises.readFile(configPath, 'utf8');
            const config = JSON.parse(content);
            config.selectedContainers = containers;
            await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
        } catch {
            // If config doesn't exist, create it with sync-selected mode
            const configDir = path.join(workspaceRoot, '.switchboard');
            await fs.promises.mkdir(configDir, { recursive: true });
            const config = { syncMode: 'sync-selected', selectedContainers: containers };
            await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
        }
    }

    private async _fetchAvailableSyncContainers(workspaceRoot: string): Promise<Array<{sourceId: string, id: string, name: string}>> {
        const containers: Array<{sourceId: string, id: string, name: string}> = [];
        
        // ClickUp containers
        try {
            const clickUpAdapter = this._taskViewerProvider?.getClickUpDocsAdapter?.(workspaceRoot);
            if (clickUpAdapter && typeof clickUpAdapter.listContainers === 'function') {
                const clickUpContainers = await clickUpAdapter.listContainers();
                for (const c of clickUpContainers) {
                    containers.push({ sourceId: 'clickup', id: String(c.id), name: String(c.name) });
                }
            }
        } catch { /* ClickUp not configured — skip */ }
        
        // Linear containers
        try {
            const linearAdapter = this._taskViewerProvider?.getLinearDocsAdapter?.(workspaceRoot);
            if (linearAdapter && typeof linearAdapter.listContainers === 'function') {
                const linearContainers = await linearAdapter.listContainers();
                for (const c of linearContainers) {
                    containers.push({ sourceId: 'linear', id: String(c.id), name: String(c.name) });
                }
            }
        } catch { /* Linear not configured — skip */ }
        
        // Notion containers
        try {
            const notionService = this._taskViewerProvider?.getNotionService?.(workspaceRoot);
            if (notionService) {
                const notionConfig = await notionService.loadConfig();
                if (notionConfig?.setupComplete && notionConfig.pageTitle) {
                    containers.push({ sourceId: 'notion', id: notionConfig.pageId || 'default', name: notionConfig.pageTitle });
                }
            }
        } catch { /* Notion not configured — skip */ }
        
        // Local folder — always available if configured
        try {
            const localService = this._taskViewerProvider?.getLocalFolderService?.(workspaceRoot);
            if (localService) {
                const folderPath = localService.getFolderPath?.();
                if (folderPath) {
                    containers.push({ sourceId: 'local-folder', id: 'root', name: path.basename(folderPath) });
                }
            }
        } catch { /* Local folder not configured — skip */ }
        
        return containers;
    }

    private async _triggerPlanningPanelSync(workspaceRoot: string, mode: string): Promise<void> {
        try {
            await vscode.commands.executeCommand('switchboard.triggerPlanningPanelSync', mode);
        } catch (error) {
            console.warn('[SetupPanelProvider] Failed to trigger Planning Panel sync:', error);
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
