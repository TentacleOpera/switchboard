import type { HostSeams } from './hostSeams';
import type { BroadcastHub } from './broadcastHub';

export interface DesignServiceContext {
    readonly workspaceRoot: string;
    readonly seams: HostSeams;
    readonly broadcaster: BroadcastHub;
    handleMessage(msg: any): Promise<any>;
}

export class DesignService {
    private _ctx: DesignServiceContext;

    constructor(ctx: DesignServiceContext) {
        this._ctx = ctx;
    }

    setContext(ctx: DesignServiceContext): void {
        this._ctx = ctx;
    }

    async "activeTabChanged"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'activeTabChanged', ...payload });
    }

    async "addBriefsFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addBriefsFolder', ...payload });
    }

    async "addClaudeFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addClaudeFolder', ...payload });
    }

    async "addDesignFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addDesignFolder', ...payload });
    }

    async "addHtmlFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addHtmlFolder', ...payload });
    }

    async "addImagesFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addImagesFolder', ...payload });
    }

    async "addStitchFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addStitchFolder', ...payload });
    }

    async "briefs"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'briefs', ...payload });
    }

    async "claude"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'claude', ...payload });
    }

    async "copyClaudeArtifactPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyClaudeArtifactPrompt', ...payload });
    }

    async "copyClaudeImportPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyClaudeImportPrompt', ...payload });
    }

    async "createBrief"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createBrief', ...payload });
    }

    async "deleteBrief"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteBrief', ...payload });
    }

    async "disableDesignDoc"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'disableDesignDoc', ...payload });
    }

    async "fetchPreview"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'fetchPreview', ...payload });
    }

    async "html-preview"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'html-preview', ...payload });
    }

    async "images"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'images', ...payload });
    }

    async "inspectRequestDataUrl"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'inspectRequestDataUrl', ...payload });
    }

    async "linkToDocument"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linkToDocument', ...payload });
    }

    async "linkToFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'linkToFolder', ...payload });
    }

    async "listBriefsFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listBriefsFolders', ...payload });
    }

    async "listClaudeFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listClaudeFolders', ...payload });
    }

    async "listDesignFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listDesignFolders', ...payload });
    }

    async "listHtmlFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listHtmlFolders', ...payload });
    }

    async "listImagesFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listImagesFolders', ...payload });
    }

    async "listStitchFolders"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'listStitchFolders', ...payload });
    }

    async "persistTabState"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'persistTabState', ...payload });
    }

    async "ready"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'ready', ...payload });
    }

    async "refreshDocsForTab"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'refreshDocsForTab', ...payload });
    }

    async "removeBriefsFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeBriefsFolder', ...payload });
    }

    async "removeClaudeFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeClaudeFolder', ...payload });
    }

    async "removeDesignFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeDesignFolder', ...payload });
    }

    async "removeHtmlFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeHtmlFolder', ...payload });
    }

    async "removeImagesFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeImagesFolder', ...payload });
    }

    async "removeStitchFolder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeStitchFolder', ...payload });
    }

    async "renderMarkdownLive"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'renderMarkdownLive', ...payload });
    }

    async "saveFileContent"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveFileContent', ...payload });
    }

    async "sendClaudeArtifactPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'sendClaudeArtifactPrompt', ...payload });
    }

    async "serveAndOpenHtml"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'serveAndOpenHtml', ...payload });
    }

    async "setActivePlanningContext"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setActivePlanningContext', ...payload });
    }

    async "stitchApplyDesignSystem"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchApplyDesignSystem', ...payload });
    }

    async "stitchCreateDesignSystem"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchCreateDesignSystem', ...payload });
    }

    async "stitchCreateProject"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchCreateProject', ...payload });
    }

    async "stitchDownloadAsset"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchDownloadAsset', ...payload });
    }

    async "stitchDownloadPalette"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchDownloadPalette', ...payload });
    }

    async "stitchEdit"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchEdit', ...payload });
    }

    async "stitchForceReloadScreens"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchForceReloadScreens', ...payload });
    }

    async "stitchGenerate"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchGenerate', ...payload });
    }

    async "stitchGetProjectScreens"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchGetProjectScreens', ...payload });
    }

    async "stitchListDesignSystems"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchListDesignSystems', ...payload });
    }

    async "stitchListProjects"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchListProjects', ...payload });
    }

    async "stitchOpenManifest"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchOpenManifest', ...payload });
    }

    async "stitchPickAttachFiles"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchPickAttachFiles', ...payload });
    }

    async "stitchRebuildImageCache"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchRebuildImageCache', ...payload });
    }

    async "stitchRefreshScreen"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchRefreshScreen', ...payload });
    }

    async "stitchSaveApiKey"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchSaveApiKey', ...payload });
    }

    async "stitchSaveAuthConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchSaveAuthConfig', ...payload });
    }

    async "stitchSendBrief"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchSendBrief', ...payload });
    }

    async "stitchUpdateDesignSystem"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchUpdateDesignSystem', ...payload });
    }

    async "stitchValidateAuth"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchValidateAuth', ...payload });
    }

    async "stitchVariants"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stitchVariants', ...payload });
    }

    async "toggleStitchHtmlPreview"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleStitchHtmlPreview', ...payload });
    }


}