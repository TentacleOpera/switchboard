import type { HostSeams } from './hostSeams';
import type { BroadcastHub } from './broadcastHub';

export interface SetupServiceContext {
    readonly workspaceRoot: string;
    readonly seams: HostSeams;
    readonly broadcaster: BroadcastHub;
    handleMessage(msg: any): Promise<any>;
}

export class SetupService {
    private _ctx: SetupServiceContext;

    constructor(ctx: SetupServiceContext) {
        this._ctx = ctx;
    }

    setContext(ctx: SetupServiceContext): void {
        this._ctx = ctx;
    }

    async "applyClickUpConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'applyClickUpConfig', ...payload });
    }

    async "applyLinearConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'applyLinearConfig', ...payload });
    }

    async "applyNotionConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'applyNotionConfig', ...payload });
    }

    async "autoCreateNotionDatabase"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'autoCreateNotionDatabase', ...payload });
    }

    async "backupToNotion"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'backupToNotion', ...payload });
    }

    async "browseParentFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'browseParentFolder', ...payload });
    }

    async "browseTicketsFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'browseTicketsFolder', ...payload });
    }

    async "browseWorkspaceMappingDbPath"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'browseWorkspaceMappingDbPath', ...payload });
    }

    async "browseWorkspaceMappingFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'browseWorkspaceMappingFolder', ...payload });
    }

    async "clearControlPlaneCache"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clearControlPlaneCache', ...payload });
    }

    async "configureNotionBackup"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'configureNotionBackup', ...payload });
    }

    async "copyDbSettingsToGlobal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyDbSettingsToGlobal', ...payload });
    }

    async "copyLinearAgentSkill"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyLinearAgentSkill', ...payload });
    }

    async "detectControlPlaneCandidate"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'detectControlPlaneCandidate', ...payload });
    }

    async "enableTriagePipeline"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'enableTriagePipeline', ...payload });
    }

    async "executeControlPlaneFreshSetup"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'executeControlPlaneFreshSetup', ...payload });
    }

    async "executeControlPlaneMigration"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'executeControlPlaneMigration', ...payload });
    }

    async "exportPromptSettings"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'exportPromptSettings', ...payload });
    }

    async "getAccurateCodingSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getAccurateCodingSetting', ...payload });
    }

    async "getAdvancedReviewerSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getAdvancedReviewerSetting', ...payload });
    }

    async "getAgentDirCleanupState"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getAgentDirCleanupState', ...payload });
    }

    async "getAllDbPaths"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getAllDbPaths', ...payload });
    }

    async "getAutoCommitOnCodeReviewSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getAutoCommitOnCodeReviewSetting', ...payload });
    }

    async "getColourKanbanIconsSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getColourKanbanIconsSetting', ...payload });
    }

    async "getControlPlaneStatus"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getControlPlaneStatus', ...payload });
    }

    async "getCustomAgents"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getCustomAgents', ...payload });
    }

    async "getCyberAnimationDisabledSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getCyberAnimationDisabledSetting', ...payload });
    }

    async "getCyberScanlinesDisabledSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getCyberScanlinesDisabledSetting', ...payload });
    }

    async "getDbPath"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getDbPath', ...payload });
    }

    async "getDefaultPromptOverrides"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getDefaultPromptOverrides', ...payload });
    }

    async "getDefaultPromptPreviews"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getDefaultPromptPreviews', ...payload });
    }

    async "getDesignSystemDocSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getDesignSystemDocSetting', ...payload });
    }

    async "getExcludeReviewedBacklogSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getExcludeReviewedBacklogSetting', ...payload });
    }

    async "getGitIgnoreConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getGitIgnoreConfig', ...payload });
    }

    async "getHideGuidedSetupSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getHideGuidedSetupSetting', ...payload });
    }

    async "getIntegrationSetupStates"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getIntegrationSetupStates', ...payload });
    }

    async "getKanbanStructure"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getKanbanStructure', ...payload });
    }

    async "getLeadChallengeSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getLeadChallengeSetting', ...payload });
    }

    async "getMemoHotkey"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getMemoHotkey', ...payload });
    }

    async "getPersistPanelsSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getPersistPanelsSetting', ...payload });
    }

    async "getPixelFontSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getPixelFontSetting', ...payload });
    }

    async "getPlanScannerConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getPlanScannerConfig', ...payload });
    }

    async "getPlanningSources"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getPlanningSources', ...payload });
    }

    async "getProjectContextSyncStatus"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getProjectContextSyncStatus', ...payload });
    }

    async "getProtocolTarget"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getProtocolTarget', ...payload });
    }

    async "getRemoteConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getRemoteConfig', ...payload });
    }

    async "getRemoteHealth"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getRemoteHealth', ...payload });
    }

    async "getStartupCommands"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getStartupCommands', ...payload });
    }

    async "getStatusShowArtifactsSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getStatusShowArtifactsSetting', ...payload });
    }

    async "getStatusShowDesignSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getStatusShowDesignSetting', ...payload });
    }

    async "getStatusShowKanbanSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getStatusShowKanbanSetting', ...payload });
    }

    async "getStatusShowMemoSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getStatusShowMemoSetting', ...payload });
    }

    async "getStatusShowProjectSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getStatusShowProjectSetting', ...payload });
    }

    async "getStatusShowTerminalsSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getStatusShowTerminalsSetting', ...payload });
    }

    async "getThemeSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getThemeSetting', ...payload });
    }

    async "getUltracodeAnimationSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getUltracodeAnimationSetting', ...payload });
    }

    async "getVisibleAgents"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getVisibleAgents', ...payload });
    }

    async "getWorkspaceMappings"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getWorkspaceMappings', ...payload });
    }

    async "importPromptSettings"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importPromptSettings', ...payload });
    }

    async "initControlPlaneGit"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'initControlPlaneGit', ...payload });
    }

    async "initializeWorkspaceDatabase"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'initializeWorkspaceDatabase', ...payload });
    }

    async "linearBrowseProjects"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearBrowseProjects', ...payload });
    }

    async "listTicketsFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listTicketsFolders', ...payload });
    }

    async "openDocs"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openDocs', ...payload });
    }

    async "openKanban"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openKanban', ...payload });
    }

    async "openKeybindings"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openKeybindings', ...payload });
    }

    async "performAgentDirCleanup"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'performAgentDirCleanup', ...payload });
    }

    async "previewControlPlaneMigration"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'previewControlPlaneMigration', ...payload });
    }

    async "projectContextSyncNow"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'projectContextSyncNow', ...payload });
    }

    async "ready"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'ready', ...payload });
    }

    async "resetDatabase"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'resetDatabase', ...payload });
    }

    async "resetExplicitControlPlaneRoot"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'resetExplicitControlPlaneRoot', ...payload });
    }

    async "restoreFromNotion"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'restoreFromNotion', ...payload });
    }

    async "restoreKanbanDefaults"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'restoreKanbanDefaults', ...payload });
    }

    async "runNotionRemoteSetup"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'runNotionRemoteSetup', ...payload });
    }

    async "runSetup"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'runSetup', ...payload });
    }

    async "saveClickUpAutomation"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveClickUpAutomation', ...payload });
    }

    async "saveClickUpMappings"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveClickUpMappings', ...payload });
    }

    async "saveDefaultPromptOverrides"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveDefaultPromptOverrides', ...payload });
    }

    async "saveLinearAutomation"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveLinearAutomation', ...payload });
    }

    async "saveMemoHotkey"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveMemoHotkey', ...payload });
    }

    async "savePlanningSources"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'savePlanningSources', ...payload });
    }

    async "saveStartupCommands"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveStartupCommands', ...payload });
    }

    async "saveTicketsAutoSync"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveTicketsAutoSync', ...payload });
    }

    async "saveTicketsFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveTicketsFolder', ...payload });
    }

    async "saveWorkspaceMappings"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveWorkspaceMappings', ...payload });
    }

    async "scaffoldMultiRepo"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'scaffoldMultiRepo', ...payload });
    }

    async "setBoardStateExport"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setBoardStateExport', ...payload });
    }

    async "setBoardStateExportRemoteUrl"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setBoardStateExportRemoteUrl', ...payload });
    }

    async "setColourKanbanIconsSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setColourKanbanIconsSetting', ...payload });
    }

    async "setCustomDbPath"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setCustomDbPath', ...payload });
    }

    async "setCyberAnimationDisabledSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setCyberAnimationDisabledSetting', ...payload });
    }

    async "setCyberScanlinesDisabledSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setCyberScanlinesDisabledSetting', ...payload });
    }

    async "setExcludeReviewedBacklogSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setExcludeReviewedBacklogSetting', ...payload });
    }

    async "setExplicitControlPlaneRoot"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setExplicitControlPlaneRoot', ...payload });
    }

    async "setHideGuidedSetup"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setHideGuidedSetup', ...payload });
    }

    async "setLocalDb"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setLocalDb', ...payload });
    }

    async "setPersistPanelsSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setPersistPanelsSetting', ...payload });
    }

    async "setPixelFontSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setPixelFontSetting', ...payload });
    }

    async "setPlanScannerConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setPlanScannerConfig', ...payload });
    }

    async "setPresetDbPath"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setPresetDbPath', ...payload });
    }

    async "setProjectContextSyncEnabled"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setProjectContextSyncEnabled', ...payload });
    }

    async "setProtocolTarget"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setProtocolTarget', ...payload });
    }

    async "setRemoteConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setRemoteConfig', ...payload });
    }

    async "setStatusShowArtifactsSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setStatusShowArtifactsSetting', ...payload });
    }

    async "setStatusShowDesignSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setStatusShowDesignSetting', ...payload });
    }

    async "setStatusShowKanbanSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setStatusShowKanbanSetting', ...payload });
    }

    async "setStatusShowMemoSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setStatusShowMemoSetting', ...payload });
    }

    async "setStatusShowProjectSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setStatusShowProjectSetting', ...payload });
    }

    async "setStatusShowTerminalsSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setStatusShowTerminalsSetting', ...payload });
    }

    async "setThemeSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setThemeSetting', ...payload });
    }

    async "setUltracodeAnimationSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setUltracodeAnimationSetting', ...payload });
    }

    async "setWorkspaceMappingEnabled"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setWorkspaceMappingEnabled', ...payload });
    }

    async "startRemoteControl"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'startRemoteControl', ...payload });
    }

    async "stopRemoteControl"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stopRemoteControl', ...payload });
    }

    async "updateGitIgnoreConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'updateGitIgnoreConfig', ...payload });
    }

    async "updateKanbanStructure"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'updateKanbanStructure', ...payload });
    }


}