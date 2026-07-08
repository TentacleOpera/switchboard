import * as fs from 'fs';
import * as path from 'path';
import type { HostSeams } from './hostSeams';
import type { BroadcastHub } from './broadcastHub';

/**
 * Kanban Service — Feature A · A2b (Per-Verb Handler Burn-Down)
 *
 * Host-agnostic service module for the Kanban panel. Each handler `case` arm
 * in `KanbanProvider._handleMessage` is extracted into a method here; the arm
 * becomes `case 'verb': return svc.verb(payload)`. The same method is served
 * over HTTP (`POST /kanban/verb/<name>`) so external clients drive the same
 * code path as the webview.
 *
 * ─── A2b Per-Verb Recipe ───────────────────────────────────────────────────
 * 1. Extract the arm body into a method on this service.
 * 2. Route every vscode-coupled call through the appropriate seam:
 *    - `vscode.commands.executeCommand` → `this._seams.commands.executeCommand`
 *    - `vscode.window.showWarningMessage` → `this._seams.ui.showWarningMessage`
 *    - `vscode.workspace.openTextDocument` → `this._seams.editor.openTextDocument`
 *    - `vscode.window.showTextDocument`   → `this._seams.editor.showTextDocument`
 *    - `vscode.workspace.getConfiguration` → `this._seams.pathConfig.getConfig*`
 *    - terminal ops → `this._seams.terminal.*`
 * 3. Route every `this._panel?.webview.postMessage(...)` through
 *    `this._broadcaster.push(...)` (dual-fan: webview + wsHub).
 * 4. If a NEW vscode-coupling surface is found (not in HostSeams), STOP and add
 *    it to `hostSeams.ts` (seam-growth protocol) — do NOT hack around it.
 * 5. The arm becomes: `case 'verb': return svc.verb(msg);`
 * 6. Add the HTTP endpoint: `POST /kanban/verb/<verb>` on LocalApiServer.
 * 7. Add a parity-test row (catalogued verb ⊆ live endpoint).
 *
 * Burn-down order: kanban → planning → project → design/Stitch → setup →
 * TaskViewer/sidebar. Driven by `protocol-catalog.json`.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Provider-internal calls (this._getKanbanDb, this._taskViewerProvider, etc.)
 * are exposed via the `KanbanServiceContext` interface — the provider constructs
 * the service with its own dependencies. The service itself never imports vscode.
 */

/**
 * Context the service needs from its host (the KanbanProvider in the extension,
 * or a headless composition root in B1). This is the non-vscode dependency
 * surface — vscode-coupled calls go through the seams.
 */
export interface KanbanServiceContext {
    /** The current workspace root (may change on workspace switch). */
    readonly workspaceRoot: string;
    /** Seam bundle for vscode-coupled calls. */
    readonly seams: HostSeams;
    /** Broadcast hub for dual-fan push sites (webview + wsHub). */
    readonly broadcaster: BroadcastHub;
    /** Resolve a planId/sessionId pair to a canonical session id. */
    resolveSessionId(planId?: string, sessionId?: string): string | undefined;
    /** Select a session in the TaskViewer (cross-provider delegation). */
    selectSession(sessionId: string): void;
    /** Trigger a plan scan across watch folders. */
    triggerPlanScan(): Promise<void>;
    handleMessage(msg: any): Promise<any>;
}

export class KanbanService {
    private _ctx: KanbanServiceContext;

    constructor(ctx: KanbanServiceContext) {
        this._ctx = ctx;
    }

    /** Update the context (e.g. when the workspace root changes). */
    setContext(ctx: KanbanServiceContext): void {
        this._ctx = ctx;
    }

    // ─── Extracted verbs (A2b burn-down) ─────────────────────────────────────
    // Each method corresponds to a `case '<verb>':` arm in
    // KanbanProvider._handleMessage. The arm delegates here; the HTTP endpoint
    // calls the same method.

    /**
     * `selectPlan` — select a plan's session in the TaskViewer.
     * Coupling: internal service call (this._taskViewerProvider.selectSession).
     */
    async selectPlan(payload: { planId?: string; sessionId?: string }): Promise<{ success: boolean }> {
        const resolved = this._ctx.resolveSessionId(payload.planId, payload.sessionId);
        if (resolved) {
            this._ctx.selectSession(resolved);
        }
        return { success: !!resolved };
    }

    /**
     * `openPlanByPath` — open a plan file by relative path. If the file has a
     * sessionId, select that session; otherwise open the file in the editor.
     * Coupling: HostUI (showWarningMessage), HostEditor (openTextDocument),
     * fs (readFile, existsSync).
     */
    async openPlanByPath(payload: { planPath?: string }): Promise<{ success: boolean; error?: string }> {
        const planPath = payload.planPath;
        const workspaceRoot = this._ctx.workspaceRoot;
        if (!workspaceRoot || typeof planPath !== 'string' || !planPath.trim()) {
            return { success: false, error: 'Missing planPath or workspaceRoot' };
        }
        try {
            const fullPath = path.resolve(workspaceRoot, planPath);
            if (!fullPath.startsWith(workspaceRoot)) {
                return { success: false, error: 'Path traversal denied' };
            }
            if (!fs.existsSync(fullPath)) {
                await this._ctx.seams.ui.showWarningMessage(`Plan file not found: ${planPath}`);
                return { success: false, error: `Plan file not found: ${planPath}` };
            }
            const planContent = await fs.promises.readFile(fullPath, 'utf-8');
            const sessionIdMatch = planContent.match(/sessionId:\s*(sess_\d+)/);
            if (sessionIdMatch) {
                this._ctx.selectSession(sessionIdMatch[1]);
                return { success: true };
            }
            // No sessionId — open the file in the editor.
            await this._ctx.seams.editor.openTextDocument(fullPath);
            return { success: true };
        } catch (err) {
            console.error('[KanbanService] openPlanByPath failed:', err);
            return { success: false, error: err instanceof Error ? err.message : 'openPlanByPath failed' };
        }
    }

    /**
     * `refresh` — "Sync Board" button: same full sync path.
     * Coupling: HostCommands (executeCommand('switchboard.fullSync')).
     */
    async refresh(): Promise<{ success: boolean }> {
        await this._ctx.seams.commands.executeCommand('switchboard.fullSync');
        return { success: true };
    }

    /**
     * `scanFoldersNow` — force-run periodic scan across all watch folders.
     * Coupling: internal call (this.triggerPlanScan).
     */
    async scanFoldersNow(): Promise<{ success: boolean }> {
        await this._ctx.triggerPlanScan();
        return { success: true };
    }

    /**
     * `focusTerminal` — focus a terminal by name.
     * Coupling: HostCommands (executeCommand('switchboard.focusTerminalByName')).
     * Terminal pattern: terminal-control verbs route through commands; the
     * TerminalBackend seam is for direct terminal ops (B3's node-pty backend).
     */
    async focusTerminal(payload: { terminalName?: string }): Promise<{ success: boolean }> {
        const terminalName = String(payload.terminalName || '');
        if (!terminalName) return { success: false };
        await this._ctx.seams.commands.executeCommand('switchboard.focusTerminalByName', terminalName);
        return { success: true };
    }

    /**
     * `fileExists` — check if a file exists within the workspace root.
     * Coupling: BroadcastHub.push (postMessage response), fs (existsSync).
     * Broadcast pattern: the response is pushed to the webview via the
     * broadcaster (dual-fan: webview + wsHub). External HTTP callers get
     * the response directly (no push needed).
     */
    async fileExists(payload: { path?: string; workspaceRoot?: string }): Promise<{ success: boolean; exists: boolean }> {
        const filePath = payload.path;
        if (typeof filePath !== 'string' || !filePath.trim()) {
            return { success: false, exists: false };
        }
        const workspaceRoot = payload.workspaceRoot || this._ctx.workspaceRoot;
        if (!workspaceRoot) {
            this._ctx.broadcaster.push({ type: 'fileExistsResult', exists: false });
            return { success: false, exists: false };
        }
        const resolvedPath = path.resolve(workspaceRoot, filePath);
        if (!resolvedPath.startsWith(workspaceRoot)) {
            this._ctx.broadcaster.push({ type: 'fileExistsResult', exists: false });
            return { success: false, exists: false };
        }
        const exists = fs.existsSync(resolvedPath);
        // Push to webview (the webview arm expects a push response).
        // HTTP callers get the return value directly.
        this._ctx.broadcaster.push({ type: 'fileExistsResult', exists });
        return { success: true, exists };
    }

    async "abandonWorktree"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'abandonWorktree', ...payload });
    }

    async "addAutobanTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addAutobanTerminal', ...payload });
    }

    async "addSubtaskToFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addSubtaskToFeature', ...payload });
    }

    async "archiveSelected"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'archiveSelected', ...payload });
    }

    async "assignSelectedToProject"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'assignSelectedToProject', ...payload });
    }

    async "batchDispatchLow"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'batchDispatchLow', ...payload });
    }

    async "batchLowComplexity"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'batchLowComplexity', ...payload });
    }

    async "batchPlannerPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'batchPlannerPrompt', ...payload });
    }

    async "chatCopyPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'chatCopyPrompt', ...payload });
    }

    async "checkMcpMonitorAuth"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'checkMcpMonitorAuth', ...payload });
    }

    async "cleanupWorktree"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'cleanupWorktree', ...payload });
    }

    async "codeMapConfirm"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'codeMapConfirm', ...payload });
    }

    async "codeMapSelected"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'codeMapSelected', ...payload });
    }

    async "coder"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'coder', ...payload });
    }

    async "completeAll"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'completeAll', ...payload });
    }

    async "completePlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'completePlan', ...payload });
    }

    async "completeSelected"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'completeSelected', ...payload });
    }

    async "copyChatWorkflow"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyChatWorkflow', ...payload });
    }

    async "copyExecutePrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyExecutePrompt', ...payload });
    }

    async "copyGatherPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyGatherPrompt', ...payload });
    }

    async "copyPlanLink"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyPlanLink', ...payload });
    }

    async "copyPrdPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyPrdPrompt', ...payload });
    }

    async "copyWorktreeMergePrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'copyWorktreeMergePrompt', ...payload });
    }

    async "createFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createFeature', ...payload });
    }

    async "createPlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createPlan', ...payload });
    }

    async "createWorktree"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createWorktree', ...payload });
    }

    async "createWorktreeForFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createWorktreeForFeature', ...payload });
    }

    async "createWorktreeForProject"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'createWorktreeForProject', ...payload });
    }

    async "deleteCustomAgent"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteCustomAgent', ...payload });
    }

    async "deleteFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteFeature', ...payload });
    }

    async "deleteKanbanColumn"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteKanbanColumn', ...payload });
    }

    async "exportAgentAsSkill"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'exportAgentAsSkill', ...payload });
    }

    async "generateAntigravityPrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'generateAntigravityPrompt', ...payload });
    }

    async "getAutoArchiveConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getAutoArchiveConfig', ...payload });
    }

    async "getCustomAgents"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getCustomAgents', ...payload });
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

    async "getFeatureDetails"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getFeatureDetails', ...payload });
    }

    async "getFeatureWorktreeMode"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getFeatureWorktreeMode', ...payload });
    }

    async "getKanbanStructure"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getKanbanStructure', ...payload });
    }

    async "getPersonaForRole"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getPersonaForRole', ...payload });
    }

    async "getPromptPreview"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getPromptPreview', ...payload });
    }

    async "getPromptsConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getPromptsConfig', ...payload });
    }

    async "getRemoteConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getRemoteConfig', ...payload });
    }

    async "getSafetySession"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getSafetySession', ...payload });
    }

    async "getSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getSetting', ...payload });
    }

    async "getStartupCommands"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getStartupCommands', ...payload });
    }

    async "getUATData"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getUATData', ...payload });
    }

    async "getWorktreeConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getWorktreeConfig', ...payload });
    }

    async "getWorktreeStatuses"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'getWorktreeStatuses', ...payload });
    }

    async "importFromClipboard"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'importFromClipboard', ...payload });
    }

    async "intern"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'intern', ...payload });
    }

    async "julesLowComplexity"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'julesLowComplexity', ...payload });
    }

    async "julesSelected"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'julesSelected', ...payload });
    }

    async "launchMcpMonitorTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'launchMcpMonitorTerminal', ...payload });
    }

    async "lead"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'lead', ...payload });
    }

    async "moveAll"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'moveAll', ...payload });
    }

    async "moveCardBackwards"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'moveCardBackwards', ...payload });
    }

    async "moveCardForward"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'moveCardForward', ...payload });
    }

    async "moveSelected"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'moveSelected', ...payload });
    }

    async "openSetupPanel"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openSetupPanel', ...payload });
    }

    async "openWorktreeTerminals"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'openWorktreeTerminals', ...payload });
    }

    async "pauseLiveSync"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'pauseLiveSync', ...payload });
    }

    async "planner"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'planner', ...payload });
    }

    async "promoteToFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'promoteToFeature', ...payload });
    }

    async "promptAll"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'promptAll', ...payload });
    }

    async "promptOnDrop"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'promptOnDrop', ...payload });
    }

    async "promptSelected"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'promptSelected', ...payload });
    }

    async "rePlanSelected"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'rePlanSelected', ...payload });
    }

    async "ready"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'ready', ...payload });
    }

    async "reassignPlansWorkspace"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'reassignPlansWorkspace', ...payload });
    }

    async "recoverAll"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'recoverAll', ...payload });
    }

    async "recoverSelected"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'recoverSelected', ...payload });
    }

    async "removeAutobanTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeAutobanTerminal', ...payload });
    }

    async "removeSubtaskFromFeature"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'removeSubtaskFromFeature', ...payload });
    }

    async "renderMcpMonitorPreview"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'renderMcpMonitorPreview', ...payload });
    }

    async "resetAutobanPools"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'resetAutobanPools', ...payload });
    }

    async "resetAutobanTimers"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'resetAutobanTimers', ...payload });
    }

    async "restoreKanbanDefaults"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'restoreKanbanDefaults', ...payload });
    }

    async "resumeLiveSync"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'resumeLiveSync', ...payload });
    }

    async "reviewPlan"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'reviewPlan', ...payload });
    }

    async "reviewer"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'reviewer', ...payload });
    }

    async "runNotionRemoteSetup"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'runNotionRemoteSetup', ...payload });
    }

    async "saveAutoArchiveConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveAutoArchiveConfig', ...payload });
    }

    async "saveCustomAgent"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveCustomAgent', ...payload });
    }

    async "saveDefaultPromptOverrides"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveDefaultPromptOverrides', ...payload });
    }

    async "saveIntegrationAutoPullSettings"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveIntegrationAutoPullSettings', ...payload });
    }

    async "saveKanbanColumn"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveKanbanColumn', ...payload });
    }

    async "savePromptsConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'savePromptsConfig', ...payload });
    }

    async "saveSetting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveSetting', ...payload });
    }

    async "saveStartupCommands"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'saveStartupCommands', ...payload });
    }

    async "sendToBacklog"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'sendToBacklog', ...payload });
    }

    async "sendToNew"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'sendToNew', ...payload });
    }

    async "setColumnDragDropMode"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setColumnDragDropMode', ...payload });
    }

    async "setFeatureWorkflowMode"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setFeatureWorkflowMode', ...payload });
    }

    async "setFeatureWorktreeMode"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setFeatureWorktreeMode', ...payload });
    }

    async "setMcpMonitorConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setMcpMonitorConfig', ...payload });
    }

    async "setPairProgrammingMode"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setPairProgrammingMode', ...payload });
    }

    async "setProjectOverride"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setProjectOverride', ...payload });
    }

    async "setRemoteConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setRemoteConfig', ...payload });
    }

    async "setSuppressMainTerminals"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setSuppressMainTerminals', ...payload });
    }

    async "setUATCheckState"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setUATCheckState', ...payload });
    }

    async "setWorkspaceOverride"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setWorkspaceOverride', ...payload });
    }

    async "showInfo"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'showInfo', ...payload });
    }

    async "showWarning"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'showWarning', ...payload });
    }

    async "startMcpMonitorPolling"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'startMcpMonitorPolling', ...payload });
    }

    async "startRemoteControl"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'startRemoteControl', ...payload });
    }

    async "stopMcpMonitorPolling"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stopMcpMonitorPolling', ...payload });
    }

    async "stopMcpMonitorTerminal"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stopMcpMonitorTerminal', ...payload });
    }

    async "stopRemoteControl"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stopRemoteControl', ...payload });
    }

    async "suggestFeatures"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'suggestFeatures', ...payload });
    }

    async "tester"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'tester', ...payload });
    }

    async "testingFailed"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'testingFailed', ...payload });
    }

    async "toggleAllowUnknownComplexityAutoMove"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleAllowUnknownComplexityAutoMove', ...payload });
    }

    async "toggleAutoban"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleAutoban', ...payload });
    }

    async "toggleAutobanPause"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleAutobanPause', ...payload });
    }

    async "toggleBacklogView"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleBacklogView', ...payload });
    }

    async "toggleClearTerminalBeforePrompt"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleClearTerminalBeforePrompt', ...payload });
    }

    async "toggleCliTriggers"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleCliTriggers', ...payload });
    }

    async "toggleDynamicComplexityRouting"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleDynamicComplexityRouting', ...payload });
    }

    async "toggleKanbanColumnVisibility"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleKanbanColumnVisibility', ...payload });
    }

    async "toggleWorktreeAgentsOpenWithGrid"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'toggleWorktreeAgentsOpenWithGrid', ...payload });
    }

    async "triggerAction"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'triggerAction', ...payload });
    }

    async "triggerBatchAction"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'triggerBatchAction', ...payload });
    }

    async "uncompleteCard"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'uncompleteCard', ...payload });
    }

    async "updateAutobanConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'updateAutobanConfig', ...payload });
    }

    async "updateClearTerminalBeforePromptDelay"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'updateClearTerminalBeforePromptDelay', ...payload });
    }

    async "updateFeatureConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'updateFeatureConfig', ...payload });
    }

    async "updateKanbanStructure"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'updateKanbanStructure', ...payload });
    }

    async "updateRoutingConfig"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'updateRoutingConfig', ...payload });
    }


    async "addProject"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'addProject', ...payload });
    }

    async "deleteProject"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'deleteProject', ...payload });
    }

    async "selectWorkspace"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'selectWorkspace', ...payload });
    }

    async "setAutomationMode"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setAutomationMode', ...payload });
    }

    async "setProjectFilter"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'setProjectFilter', ...payload });
    }

    async "startOrchestrator"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'startOrchestrator', ...payload });
    }

    async "stopOrchestrator"(payload: any): Promise<any> {
        return this._ctx.handleMessage({ type: 'stopOrchestrator', ...payload });
    }

}