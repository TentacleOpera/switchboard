import type { HostSeams } from './hostSeams';
import type { BroadcastHub } from './broadcastHub';

export interface PlanningServiceContext {
    readonly workspaceRoot: string;
    readonly seams: HostSeams;
    readonly broadcaster: BroadcastHub;
    handleMessage(msg: any): Promise<any>;
}

export class PlanningService {
    private _ctx: PlanningServiceContext;

    constructor(ctx: PlanningServiceContext) {
        this._ctx = ctx;
    }

    setContext(ctx: PlanningServiceContext): void {
        this._ctx = ctx;
    }

    async "addConstitutionPath"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addConstitutionPath', ...payload });
    }

    async "addLocalFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addLocalFolder', ...payload });
    }

    async "addPlanningHtmlFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addPlanningHtmlFolder', ...payload });
    }

    async "addSubtaskToFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addSubtaskToFeature', ...payload });
    }

    async "addTicketsFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addTicketsFolder', ...payload });
    }

    async "airlock_export"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'airlock_export', ...payload });
    }

    async "airlock_openAIStudio"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'airlock_openAIStudio', ...payload });
    }

    async "airlock_openFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'airlock_openFolder', ...payload });
    }

    async "airlock_openNotebookLM"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'airlock_openNotebookLM', ...payload });
    }

    async "appendToPlannerPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'appendToPlannerPrompt', ...payload });
    }

    async "browseTicketsFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'browseTicketsFolder', ...payload });
    }

    async "changeTicketStatus"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'changeTicketStatus', ...payload });
    }

    async "clickupCreateTask"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupCreateTask', ...payload });
    }

    async "clickupImportTask"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupImportTask', ...payload });
    }

    async "clickupLoadFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupLoadFolders', ...payload });
    }

    async "clickupLoadListStatuses"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupLoadListStatuses', ...payload });
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

    async "clickupUpdateTaskAssignees"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupUpdateTaskAssignees', ...payload });
    }

    async "clickupUpdateTaskPriority"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupUpdateTaskPriority', ...payload });
    }

    async "clickupUpdateTaskTags"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'clickupUpdateTaskTags', ...payload });
    }

    async "convertToSubtask"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'convertToSubtask', ...payload });
    }

    async "copyArchitectPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyArchitectPrompt', ...payload });
    }

    async "copyArtifactPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyArtifactPrompt', ...payload });
    }

    async "copyChatPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyChatPrompt', ...payload });
    }

    async "copyConstitutionPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyConstitutionPrompt', ...payload });
    }

    async "copyConstitutionUpdatePrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyConstitutionUpdatePrompt', ...payload });
    }

    async "copyDiagramPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyDiagramPrompt', ...payload });
    }

    async "copyFeaturePlannerPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyFeaturePlannerPrompt', ...payload });
    }

    async "copyInsightLink"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyInsightLink', ...payload });
    }

    async "copyKanbanPlanPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyKanbanPlanPrompt', ...payload });
    }

    async "copyPrdBuildPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyPrdBuildPrompt', ...payload });
    }

    async "copyRefinePrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyRefinePrompt', ...payload });
    }

    async "copySystemBuildPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copySystemBuildPrompt', ...payload });
    }

    async "copyToClipboard"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyToClipboard', ...payload });
    }

    async "createDevDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createDevDoc', ...payload });
    }

    async "createFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createFeature', ...payload });
    }

    async "createLocalDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createLocalDoc', ...payload });
    }

    async "createOnlineDocument"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createOnlineDocument', ...payload });
    }

    async "createPlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createPlan', ...payload });
    }

    async "deleteConstitutionFile"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteConstitutionFile', ...payload });
    }

    async "deleteDevDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteDevDoc', ...payload });
    }

    async "deleteFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteFeature', ...payload });
    }

    async "deleteImportedDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteImportedDoc', ...payload });
    }

    async "deleteInsight"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteInsight', ...payload });
    }

    async "deleteKanbanPlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteKanbanPlan', ...payload });
    }

    async "deleteLocalDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteLocalDoc', ...payload });
    }

    async "deleteTicketConfirmed"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteTicketConfirmed', ...payload });
    }

    async "downloadAttachment"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'downloadAttachment', ...payload });
    }

    async "draftImproveDevDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'draftImproveDevDoc', ...payload });
    }

    async "editTicket"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'editTicket', ...payload });
    }

    async "fetchAntigravityArtifact"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchAntigravityArtifact', ...payload });
    }

    async "fetchChildren"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchChildren', ...payload });
    }

    async "fetchContainers"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchContainers', ...payload });
    }

    async "fetchDocPages"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchDocPages', ...payload });
    }

    async "fetchDocsFile"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchDocsFile', ...payload });
    }

    async "fetchFilteredDocs"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchFilteredDocs', ...payload });
    }

    async "fetchImportedDocs"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchImportedDocs', ...payload });
    }

    async "fetchKanbanPlanLog"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchKanbanPlanLog', ...payload });
    }

    async "fetchKanbanPlanPreview"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchKanbanPlanPreview', ...payload });
    }

    async "fetchKanbanPlans"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchKanbanPlans', ...payload });
    }

    async "fetchMoveTargets"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchMoveTargets', ...payload });
    }

    async "fetchPageContent"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchPageContent', ...payload });
    }

    async "fetchPreview"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchPreview', ...payload });
    }

    async "fetchRoots"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchRoots', ...payload });
    }

    async "getConstitutionPaths"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getConstitutionPaths', ...payload });
    }

    async "getConstitutionStatus"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getConstitutionStatus', ...payload });
    }

    async "getFeatureDetails"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getFeatureDetails', ...payload });
    }

    async "getProjectContextEnabled"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getProjectContextEnabled', ...payload });
    }

    async "getProjectPrd"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getProjectPrd', ...payload });
    }

    async "getSyncConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getSyncConfig', ...payload });
    }

    async "getTicketSyncStatuses"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getTicketSyncStatuses', ...payload });
    }

    async "importAllTickets"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importAllTickets', ...payload });
    }

    async "importDevDocFromClipboard"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importDevDocFromClipboard', ...payload });
    }

    async "importFullDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importFullDoc', ...payload });
    }

    async "importNotebookLMPlans"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importNotebookLMPlans', ...payload });
    }

    async "importPlans"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importPlans', ...payload });
    }

    async "importPlansFromClipboard"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importPlansFromClipboard', ...payload });
    }

    async "importResearchDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importResearchDoc', ...payload });
    }

    async "importTicketSubtasks"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importTicketSubtasks', ...payload });
    }

    async "invalidateClickUpCache"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'invalidateClickUpCache', ...payload });
    }

    async "invokeConstitutionBuilder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'invokeConstitutionBuilder', ...payload });
    }

    async "invokeConstitutionUpdater"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'invokeConstitutionUpdater', ...payload });
    }

    async "invokePrdBuilder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'invokePrdBuilder', ...payload });
    }

    async "invokeSystemBuilder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'invokeSystemBuilder', ...payload });
    }

    async "linearCreateIssue"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearCreateIssue', ...payload });
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

    async "linearUpdateIssueAssignee"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearUpdateIssueAssignee', ...payload });
    }

    async "linearUpdateIssueLabels"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearUpdateIssueLabels', ...payload });
    }

    async "linearUpdateIssuePriority"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linearUpdateIssuePriority', ...payload });
    }

    async "linkToDocument"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linkToDocument', ...payload });
    }

    async "linkToFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linkToFolder', ...payload });
    }

    async "listLocalFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listLocalFolders', ...payload });
    }

    async "listLocalTicketFiles"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listLocalTicketFiles', ...payload });
    }

    async "listPlanningHtmlFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listPlanningHtmlFolders', ...payload });
    }

    async "listTicketsFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listTicketsFolders', ...payload });
    }

    async "loadConstitutionFiles"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'loadConstitutionFiles', ...payload });
    }

    async "loadDevDocs"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'loadDevDocs', ...payload });
    }

    async "loadInsights"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'loadInsights', ...payload });
    }

    async "loadTicketAssignees"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'loadTicketAssignees', ...payload });
    }

    async "loadTicketComments"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'loadTicketComments', ...payload });
    }

    async "moveKanbanPlanColumn"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'moveKanbanPlanColumn', ...payload });
    }

    async "moveTicket"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'moveTicket', ...payload });
    }

    async "notebookDefaultRoot"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'notebookDefaultRoot', ...payload });
    }

    async "openArchitectTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openArchitectTerminal', ...payload });
    }

    async "openAttachment"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openAttachment', ...payload });
    }

    async "openExternalUrl"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openExternalUrl', ...payload });
    }

    async "openKanbanPlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openKanbanPlan', ...payload });
    }

    async "persistTabState"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'persistTabState', ...payload });
    }

    async "planAutoFetchRunNow"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'planAutoFetchRunNow', ...payload });
    }

    async "planShown"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'planShown', ...payload });
    }

    async "postTicketComment"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'postTicketComment', ...payload });
    }

    async "postTicketReply"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'postTicketReply', ...payload });
    }

    async "pushTicket"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'pushTicket', ...payload });
    }

    async "readConstitutionFile"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'readConstitutionFile', ...payload });
    }

    async "readDevDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'readDevDoc', ...payload });
    }

    async "readInsight"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'readInsight', ...payload });
    }

    async "readLocalTicketFile"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'readLocalTicketFile', ...payload });
    }

    async "refineFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'refineFeature', ...payload });
    }

    async "refreshSource"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'refreshSource', ...payload });
    }

    async "refreshTicketsDelta"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'refreshTicketsDelta', ...payload });
    }

    async "removeConstitutionPath"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeConstitutionPath', ...payload });
    }

    async "removeLocalFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeLocalFolder', ...payload });
    }

    async "removePlanningHtmlFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removePlanningHtmlFolder', ...payload });
    }

    async "removeSubtaskFromFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeSubtaskFromFeature', ...payload });
    }

    async "removeTicketsFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeTicketsFolder', ...payload });
    }

    async "renderMarkdownLive"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'renderMarkdownLive', ...payload });
    }

    async "resolveDuplicate"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'resolveDuplicate', ...payload });
    }

    async "revealAttachment"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'revealAttachment', ...payload });
    }

    async "runTuningExtract"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'runTuningExtract', ...payload });
    }

    async "runTuningGovernance"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'runTuningGovernance', ...payload });
    }

    async "saveConstitutionFile"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveConstitutionFile', ...payload });
    }

    async "saveDevDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveDevDoc', ...payload });
    }

    async "saveFileContent"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveFileContent', ...payload });
    }

    async "saveLocalTicketFile"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveLocalTicketFile', ...payload });
    }

    async "saveOnlineDocFile"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveOnlineDocFile', ...payload });
    }

    async "savePlanningContainerSelection"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'savePlanningContainerSelection', ...payload });
    }

    async "saveProjectPrd"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveProjectPrd', ...payload });
    }

    async "saveTicketsFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveTicketsFolder', ...payload });
    }

    async "saveTicketsFolderPaths"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveTicketsFolderPaths', ...payload });
    }

    async "sendArtifactPromptToTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'sendArtifactPromptToTerminal', ...payload });
    }

    async "serveAndOpenHtml"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'serveAndOpenHtml', ...payload });
    }

    async "setConstitutionPath"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setConstitutionPath', ...payload });
    }

    async "setKanbanPlanComplexity"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setKanbanPlanComplexity', ...payload });
    }

    async "setPlanAutoFetchEnabled"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setPlanAutoFetchEnabled', ...payload });
    }

    async "setProjectContextEnabled"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setProjectContextEnabled', ...payload });
    }

    async "setUploadLocation"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setUploadLocation', ...payload });
    }

    async "setupTicketsWatcher"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setupTicketsWatcher', ...payload });
    }

    async "submitComment"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'submitComment', ...payload });
    }

    async "switchTicketsProvider"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'switchTicketsProvider', ...payload });
    }

    async "syncAllTickets"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'syncAllTickets', ...payload });
    }

    async "syncDocToOnline"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'syncDocToOnline', ...payload });
    }

    async "syncToSource"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'syncToSource', ...payload });
    }

    async "ticketsAskAgent"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'ticketsAskAgent', ...payload });
    }

    async "ticketsDefaultRoot"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'ticketsDefaultRoot', ...payload });
    }

    async "ticketsRootChanged"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'ticketsRootChanged', ...payload });
    }

    async "toggleConstitutionAddon"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleConstitutionAddon', ...payload });
    }

    async "updateFeatureConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'updateFeatureConfig', ...payload });
    }

    async "updateInsightStatus"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'updateInsightStatus', ...payload });
    }

    async "uploadPlanAttachment"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'uploadPlanAttachment', ...payload });
    }

    async "viewAttachments"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'viewAttachments', ...payload });
    }


}