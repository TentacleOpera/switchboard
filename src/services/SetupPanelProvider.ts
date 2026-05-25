import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ControlPlaneMigrationService } from './ControlPlaneMigrationService';
import { MultiRepoScaffoldingService } from './MultiRepoScaffoldingService';
import type { TaskViewerProvider } from './TaskViewerProvider';
import { KanbanDatabase } from './KanbanDatabase';
import { ensureWorkspaceIdentity } from './WorkspaceIdentityService';
import type { KanbanProvider } from './KanbanProvider';

type ControlPlaneTaskViewerProvider = TaskViewerProvider & {
    handleGetControlPlaneStatus?: (workspaceRoot?: string) => Promise<any>;
    handleSetExplicitControlPlaneRoot?: (controlPlaneRoot: string, workspaceRoot?: string) => Promise<any>;
    handleResetExplicitControlPlaneRoot?: (workspaceRoot?: string) => Promise<any>;
    handleClearControlPlaneCache?: (workspaceRoot?: string) => Promise<any>;
};

export class SetupPanelProvider implements vscode.Disposable {
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
                case 'setGlobalSettingsEnabled': {
                    await this._taskViewerProvider.setGlobalSettingsEnabled(message.enabled);
                    break;
                }
                case 'getGlobalSettingsEnabled': {
                    const enabled = this._taskViewerProvider.getGlobalSettingsEnabled();
                    this._panel.webview.postMessage({ type: 'globalSettingsEnabled', enabled });
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
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (!workspaceRoot) {
                        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
                        return;
                    }
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

                    this._panel.webview.postMessage({ type: 'controlPlaneMigrationResult', ...result });
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
                case 'configureNotionBackup': {
                    const result = await this._taskViewerProvider.handleConfigureNotionBackup(
                        typeof message.databaseUrl === 'string' ? message.databaseUrl : '',
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this._panel?.webview.postMessage({ type: 'notionBackupConfigResult', ...result });
                    break;
                }
                case 'backupToNotion': {
                    const result = await this._taskViewerProvider.handleBackupToNotion(
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this._panel?.webview.postMessage({ type: 'notionBackupResult', ...result });
                    break;
                }
                case 'restoreFromNotion': {
                    const result = await this._taskViewerProvider.handleRestoreFromNotion(
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this._panel?.webview.postMessage({ type: 'notionRestoreResult', ...result });
                    break;
                }
                case 'autoCreateNotionDatabase': {
                    const result = await this._taskViewerProvider.handleAutoCreateNotionDatabase(
                        typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
                    );
                    this._panel?.webview.postMessage({ type: 'notionAutoCreateResult', ...result });
                    break;
                }
                case 'runSetup':
                    await vscode.commands.executeCommand('switchboard.setup');
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
                    const workspaceRoot = this._getCurrentWorkspaceRoot() || undefined;
                    const customAgents = await this._taskViewerProvider.getCustomAgents(workspaceRoot);
                    this._panel.webview.postMessage({ type: 'customAgents', customAgents, workspaceRoot });
                    break;
                }
                case 'getKanbanStructure': {
                    const items = await this._taskViewerProvider.handleGetKanbanStructure();
                    this._panel.webview.postMessage({ type: 'kanbanStructure', items });
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
                case 'getPreventAgentFileOpeningSetting':
                    this._panel.webview.postMessage({
                        type: 'preventAgentFileOpeningSetting',
                        enabled: this._taskViewerProvider.handleGetPreventAgentFileOpeningSetting()
                    });
                    break;
                case 'setPreventAgentFileOpeningSetting':
                    await this._taskViewerProvider.handleSetPreventAgentFileOpeningSetting(message.enabled);
                    await vscode.commands.executeCommand('switchboard.refreshUI');
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
                    // NOTE: intentionally folder-scoped — this setting is per-project, not shared across workspaces
                    const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
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
                    // NOTE: intentionally folder-scoped — this setting is per-project, not shared across workspaces
                    const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
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
                case 'getAllDbPaths': {
                    const allDbPaths = await this._taskViewerProvider.handleGetAllDbPaths();
                    this._panel.webview.postMessage({ type: 'allDbPathsUpdated', databases: allDbPaths });
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
                case 'getPlanningPanelSyncMode': {
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (!workspaceRoot) {
                        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
                        return;
                    }
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
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (!workspaceRoot) {
                        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
                        return;
                    }
                    const syncMode = typeof message.mode === 'string' ? message.mode : 'no-sync';
                    await this._setPlanningPanelSyncMode(workspaceRoot, syncMode);
                    await this._triggerPlanningPanelSync(workspaceRoot, syncMode);
                    break;
                }
                case 'fetchAvailableSyncContainers': {
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (!workspaceRoot) {
                        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
                        return;
                    }
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
                    const workspaceRoot = this._getCurrentWorkspaceRoot();
                    if (!workspaceRoot) {
                        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
                        return;
                    }
                    const containers = Array.isArray(message.containers) ? message.containers.map((v: unknown) => String(v)) : [];
                    await this._setPlanningPanelSelectedContainers(workspaceRoot, containers);
                    await this._triggerPlanningPanelSync(workspaceRoot, 'sync-selected');
                    break;
                }
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
                    this._panel?.webview.postMessage({
                        type: 'planningSources',
                        sources: enabledSources
                    });
                    break;
                }
                case 'getWorkspaceMappings': {
                    const config = vscode.workspace.getConfiguration('switchboard');
                    const mappings = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
                    const warnings: string[] = [];
                    for (const m of mappings.mappings ?? []) {
                        if (m.mode === 'connect' && m.dbPath && !fs.existsSync(m.dbPath)) {
                            warnings.push(`Mapping "${m.name}": database not found at ${m.dbPath}`);
                        }
                        if (m.parentFolder && !fs.existsSync(m.parentFolder)) {
                            warnings.push(`Mapping "${m.name}": parent folder not found at ${m.parentFolder}`);
                        }
                        if (Array.isArray(m.dropdownWorkspaces)) {
                            for (const dw of m.dropdownWorkspaces) {
                                if (typeof dw === 'string' && !fs.existsSync(dw)) {
                                    warnings.push(`Mapping "${m.name}": dropdown workspace folder not found at ${dw}`);
                                }
                            }
                        }
                    }
                    this._panel?.webview.postMessage({
                        type: 'workspaceMappings',
                        ...mappings,
                        warnings
                    });
                    break;
                }
                case 'setWorkspaceMappingEnabled': {
                    const config = vscode.workspace.getConfiguration('switchboard');
                    const current = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
                    const enabled = typeof message.enabled === 'boolean' ? message.enabled : false;
                    await config.update(
                        'workspaceDatabaseMappings',
                        { ...current, enabled },
                        vscode.ConfigurationTarget.Workspace
                    );
                    this._panel?.webview.postMessage({
                        type: 'workspaceMappingEnabled',
                        enabled
                    });
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
                            const dropdownFolders = (m.dropdownWorkspaces ?? []).map((f: string) => path.resolve(expandHome(f)));
                            if (dropdownFolders.includes(parentFolder)) {
                                errors.push(`Mapping "${m.name}": parent folder cannot also be a dropdown workspace folder`);
                            }
                            for (const df of dropdownFolders) {
                                if (childFolders.includes(df)) {
                                    errors.push(`Mapping "${m.name}": folder "${df}" cannot be both a child workspace folder and a dropdown workspace folder`);
                                }
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

                        // Ensure dropdown workspaces have a valid dbPath (defense-in-depth)
                        // Skip checks already covered by mode-specific validation above to avoid
                        // duplicate error messages. Only adds dropdown-specific errors for modes
                        // that don't already validate dbPath (unexpected/unknown modes).
                        if (Array.isArray(m.dropdownWorkspaces) && m.dropdownWorkspaces.length > 0) {
                            if (!m.dbPath?.trim()) {
                                // mode='connect' and mode='create' already validate dbPath above;
                                // only add dropdown-specific message for unexpected modes
                                if (mode !== 'connect' && mode !== 'create') {
                                    errors.push(`Mapping "${m.name}": database path is required when dropdown workspaces are configured`);
                                }
                            } else if (mode !== 'create' && mode !== 'connect') {
                                // mode='connect' already checks existence and .db extension above;
                                // only add dropdown-specific checks for unexpected modes
                                const resolvedDbPath = path.resolve(expandHome(m.dbPath.trim()));
                                if (!fs.existsSync(resolvedDbPath)) {
                                    errors.push(`Mapping "${m.name}": database file does not exist for dropdown workspaces: ${resolvedDbPath}`);
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

                        for (const f of m.dropdownWorkspaces ?? []) {
                            const norm = path.resolve(expandHome(f));
                            if (seenFolders.has(norm)) errors.push(`Folder ${norm} listed in multiple mappings`);
                            seenFolders.add(norm);
                        }
                    }
 
                    if (errors.length) {
                        this._panel?.webview.postMessage({ type: 'workspaceMappingStatus', ok: false, error: errors.join('\n') });
                        break;
                    }
 
                    const config = vscode.workspace.getConfiguration('switchboard');
                    await config.update(
                        'workspaceDatabaseMappings',
                        incoming,
                        vscode.ConfigurationTarget.Workspace
                    );

                    // Provision workspace identity files for dropdown workspaces immediately after saving
                    if (Array.isArray(incoming.mappings)) {
                        for (const m of incoming.mappings) {
                            if (Array.isArray(m.dropdownWorkspaces)) {
                                for (const dw of m.dropdownWorkspaces) {
                                    try {
                                        const resolvedPath = path.resolve(expandHome(dw));
                                        if (fs.existsSync(resolvedPath)) {
                                            await ensureWorkspaceIdentity(resolvedPath);
                                        }
                                    } catch (err) {
                                        console.error(`[SetupPanelProvider] Failed to ensure identity for dropdown workspace "${dw}":`, err);
                                    }
                                }
                            }
                        }
                    }
 
                    this._panel?.webview.postMessage({ type: 'workspaceMappingStatus', ok: true });
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
                }
                case 'initializeWorkspaceDatabase': {
                    const parentFolder = String(message.parentFolder || '').trim();
                    if (!parentFolder) {
                        this._panel?.webview.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: 'Parent folder is required.' });
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
                        this._panel?.webview.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: `Parent folder is not writable: ${resolvedParent}` });
                        break;
                    }
                    const derivedDbPath = path.join(resolvedParent, '.switchboard', 'kanban.db');
 
                    const workspaceFolders = Array.isArray(message.workspaceFolders) ? message.workspaceFolders : [];
                    const childFolders = workspaceFolders.map((f: string) => path.resolve(expandHome(f)));
                    if (childFolders.includes(resolvedParent)) {
                        this._panel?.webview.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: 'Parent folder cannot also be a child workspace folder.' });
                        break;
                    }
                    const dropdownWorkspaces = Array.isArray(message.dropdownWorkspaces) ? message.dropdownWorkspaces : [];
                    const dropdownFolders = dropdownWorkspaces.map((f: string) => path.resolve(expandHome(f)));
                    if (dropdownFolders.includes(resolvedParent)) {
                        this._panel?.webview.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: 'Parent folder cannot also be a dropdown workspace folder.' });
                        break;
                    }
 
                    try {
                        // Direct construction to bypass mapping resolution during config setup
                        const db = new (KanbanDatabase as any)(resolvedParent, derivedDbPath);
                        const created = await db.createIfMissing();
                        if (!created) {
                            this._panel?.webview.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: 'Failed to create database. Check permissions and try again.' });
                            break;
                        }
                        // Save the mapping config with dbPath pre-filled
                        const config = vscode.workspace.getConfiguration('switchboard');
                        const current = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
                        const newMapping = {
                            id: message.mappingId || ('mapping-' + Date.now()),
                            name: message.name || path.basename(resolvedParent),
                            dbPath: derivedDbPath,
                            parentFolder: resolvedParent,
                            workspaceFolders,
                            dropdownWorkspaces,
                            mode: 'create'
                        };
                        const existingIndex = (current.mappings || []).findIndex((m: any) => m.id === newMapping.id);
                        const updatedMappings = existingIndex >= 0
                            ? current.mappings.map((m: any) => m.id === newMapping.id ? newMapping : m)
                            : [...(current.mappings || []), newMapping];
                        await config.update(
                            'workspaceDatabaseMappings',
                            { ...current, enabled: true, mappings: updatedMappings },
                            vscode.ConfigurationTarget.Workspace
                        );

                        // Provision workspace identity files for dropdown workspaces immediately
                        for (const dw of dropdownWorkspaces) {
                            try {
                                const resolvedPath = path.resolve(expandHome(dw));
                                if (fs.existsSync(resolvedPath)) {
                                    await ensureWorkspaceIdentity(resolvedPath);
                                }
                            } catch (err) {
                                console.error(`[SetupPanelProvider] Failed to ensure identity for dropdown workspace "${dw}":`, err);
                            }
                        }

                        this._panel?.webview.postMessage({ type: 'workspaceMappingInitResult', ok: true, dbPath: derivedDbPath });
                        await vscode.commands.executeCommand('switchboard.refreshUI');
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        this._panel?.webview.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: errorMessage });
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
                        this._panel?.webview.postMessage({
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
                        this._panel?.webview.postMessage({
                            type: 'workspaceMappingFolderSelected',
                            path: folderUri[0].fsPath,
                            mappingId: message.mappingId
                        });
                    }
                    break;
                }
                case 'browseWorkspaceMappingDropdownFolder': {
                    const folderUri = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        title: 'Select dropdown workspace folder'
                    });
                    if (folderUri?.[0]) {
                        this._panel?.webview.postMessage({
                            type: 'workspaceMappingDropdownFolderSelected',
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
                        this._panel?.webview.postMessage({
                            type: 'parentFolderSelected',
                            path: selectedPath,
                            mappingId: message.mappingId,
                            existingDbDetected
                        });
                    }
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

        // Inject shared defaults
        const sharedDefaultsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedDefaults.js')).toString();
        content = content.replace('<!-- SHARED_DEFAULTS_SCRIPT -->', `<script src="${sharedDefaultsUri}" nonce="${nonce}"></script>`);

        return content;
    }
}
