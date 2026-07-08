import type { HostSeams } from './hostSeams';
import type { BroadcastHub } from './broadcastHub';

export interface TaskViewerServiceContext {
    readonly workspaceRoot: string;
    readonly seams: HostSeams;
    readonly broadcaster: BroadcastHub;
    handleMessage(msg: any): Promise<any>;
}

export class TaskViewerService {
    private _ctx: TaskViewerServiceContext;

    constructor(ctx: TaskViewerServiceContext) {
        this._ctx = ctx;
    }

    setContext(ctx: TaskViewerServiceContext): void {
        this._ctx = ctx;
    }

    async "addAutobanTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addAutobanTerminal', ...payload });
    }

    async "airlock_export"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'airlock_export', ...payload });
    }

    async "airlock_openFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'airlock_openFolder', ...payload });
    }

    async "airlock_openNotebookLM"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'airlock_openNotebookLM', ...payload });
    }

    async "airlock_sendToCoder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'airlock_sendToCoder', ...payload });
    }

    async "airlock_syncRepo"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'airlock_syncRepo', ...payload });
    }

    async "claimPlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'claimPlan', ...payload });
    }

    async "clickupImportTask"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupImportTask', ...payload });
    }

    async "clickupLoadFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupLoadFolders', ...payload });
    }

    async "clickupLoadLists"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupLoadLists', ...payload });
    }

    async "clickupLoadProject"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupLoadProject', ...payload });
    }

    async "clickupLoadSpaceTags"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupLoadSpaceTags', ...payload });
    }

    async "clickupLoadSpaces"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupLoadSpaces', ...payload });
    }

    async "clickupLoadTaskDetails"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupLoadTaskDetails', ...payload });
    }

    async "clickupSaveFolderSelection"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupSaveFolderSelection', ...payload });
    }

    async "clickupSaveListSelection"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupSaveListSelection', ...payload });
    }

    async "clickupSaveSpaceSelection"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupSaveSpaceSelection', ...payload });
    }

    async "clickupUpdateTaskTags"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupUpdateTaskTags', ...payload });
    }

    async "closeChatAgent"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'closeChatAgent', ...payload });
    }

    async "closeTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'closeTerminal', ...payload });
    }

    async "completePlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'completePlan', ...payload });
    }

    async "copyPlanLink"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyPlanLink', ...payload });
    }

    async "copyTextToClipboard"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyTextToClipboard', ...payload });
    }

    async "createAgentGrid"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createAgentGrid', ...payload });
    }

    async "createAgentGridEditor"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createAgentGridEditor', ...payload });
    }

    async "createDraftPlanTicket"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createDraftPlanTicket', ...payload });
    }

    async "deletePlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deletePlan', ...payload });
    }

    async "deregisterAllTerminals"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deregisterAllTerminals', ...payload });
    }

    async "editDbPath"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'editDbPath', ...payload });
    }

    async "executeLocal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'executeLocal', ...payload });
    }

    async "executeRemote"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'executeRemote', ...payload });
    }

    async "fetchNotionContent"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchNotionContent', ...payload });
    }

    async "finishOnboarding"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'finishOnboarding', ...payload });
    }

    async "focus"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'focus', ...payload });
    }

    async "focusTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'focusTerminal', ...payload });
    }

    async "generateContextMap"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'generateContextMap', ...payload });
    }

    async "getAccurateCodingSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getAccurateCodingSetting', ...payload });
    }

    async "getAdvancedReviewerSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getAdvancedReviewerSetting', ...payload });
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

    async "getJulesAutoSyncSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getJulesAutoSyncSetting', ...payload });
    }

    async "getLeadChallengeSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getLeadChallengeSetting', ...payload });
    }

    async "getMcpMonitorConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getMcpMonitorConfig', ...payload });
    }

    async "getNotionFetchState"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getNotionFetchState', ...payload });
    }

    async "getRecentActivity"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getRecentActivity', ...payload });
    }

    async "getRecoverablePlans"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getRecoverablePlans', ...payload });
    }

    async "getStartupCommands"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getStartupCommands', ...payload });
    }

    async "getVisibleAgents"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getVisibleAgents', ...payload });
    }

    async "guidedSetup"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'guidedSetup', ...payload });
    }

    async "importPlans"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importPlans', ...payload });
    }

    async "initializeProtocols"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'initializeProtocols', ...payload });
    }

    async "kanban_workflowEvent"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'kanban_workflowEvent', ...payload });
    }

    async "linearImportAndSendToPlanner"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearImportAndSendToPlanner', ...payload });
    }

    async "linearImportTask"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearImportTask', ...payload });
    }

    async "linearLoadAutomationCatalog"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearLoadAutomationCatalog', ...payload });
    }

    async "linearLoadProject"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearLoadProject', ...payload });
    }

    async "linearLoadProjects"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearLoadProjects', ...payload });
    }

    async "linearLoadTaskDetails"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearLoadTaskDetails', ...payload });
    }

    async "linearSaveProjectSelection"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearSaveProjectSelection', ...payload });
    }

    async "linearUpdateIssueLabels"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearUpdateIssueLabels', ...payload });
    }

    async "memoClear"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'memoClear', ...payload });
    }

    async "memoGeneratePrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'memoGeneratePrompt', ...payload });
    }

    async "memoLoad"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'memoLoad', ...payload });
    }

    async "memoSave"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'memoSave', ...payload });
    }

    async "openDesignPanel"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openDesignPanel', ...payload });
    }

    async "openDocs"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openDocs', ...payload });
    }

    async "openExternalUrl"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openExternalUrl', ...payload });
    }

    async "openKanban"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openKanban', ...payload });
    }

    async "openPlanningPanel"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openPlanningPanel', ...payload });
    }

    async "openProjectPanel"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openProjectPanel', ...payload });
    }

    async "openSetupPanel"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openSetupPanel', ...payload });
    }

    async "pipelinePause"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'pipelinePause', ...payload });
    }

    async "pipelineSetInterval"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'pipelineSetInterval', ...payload });
    }

    async "pipelineStart"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'pipelineStart', ...payload });
    }

    async "pipelineStop"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'pipelineStop', ...payload });
    }

    async "pipelineUnpause"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'pipelineUnpause', ...payload });
    }

    async "queryArchives"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'queryArchives', ...payload });
    }

    async "ready"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'ready', ...payload });
    }

    async "recoverPlanFromSidebar"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'recoverPlanFromSidebar', ...payload });
    }

    async "registerAllTerminals"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'registerAllTerminals', ...payload });
    }

    async "removeAutobanTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeAutobanTerminal', ...payload });
    }

    async "renameTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'renameTerminal', ...payload });
    }

    async "requestContextFile"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'requestContextFile', ...payload });
    }

    async "resetAutobanPools"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'resetAutobanPools', ...payload });
    }

    async "resetDatabase"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'resetDatabase', ...payload });
    }

    async "restorePlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'restorePlan', ...payload });
    }

    async "reviewPlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'reviewPlan', ...payload });
    }

    async "runSetup"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'runSetup', ...payload });
    }

    async "runSetupIDEs"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'runSetupIDEs', ...payload });
    }

    async "saveDefaultPromptOverrides"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveDefaultPromptOverrides', ...payload });
    }

    async "saveStartupCommands"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveStartupCommands', ...payload });
    }

    async "scaffoldMultiRepo"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'scaffoldMultiRepo', ...payload });
    }

    async "sendAnalystMessage"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'sendAnalystMessage', ...payload });
    }

    async "sendToTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'sendToTerminal', ...payload });
    }

    async "setActiveSubTab"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setActiveSubTab', ...payload });
    }

    async "setActiveTab"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setActiveTab', ...payload });
    }

    async "setChatAgentRole"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setChatAgentRole', ...payload });
    }

    async "setCustomDbPath"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setCustomDbPath', ...payload });
    }

    async "setLocalDb"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setLocalDb', ...payload });
    }

    async "setMcpMonitorConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setMcpMonitorConfig', ...payload });
    }

    async "setPresetDbPath"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setPresetDbPath', ...payload });
    }

    async "setTerminalRole"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setTerminalRole', ...payload });
    }

    async "showInfo"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'showInfo', ...payload });
    }

    async "showWarning"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'showWarning', ...payload });
    }

    async "testDbConnection"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'testDbConnection', ...payload });
    }

    async "toggleSilentSetup"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleSilentSetup', ...payload });
    }

    async "triggerAgentAction"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'triggerAgentAction', ...payload });
    }

    async "updateAutobanState"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'updateAutobanState', ...payload });
    }

    async "viewPlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'viewPlan', ...payload });
    }


}