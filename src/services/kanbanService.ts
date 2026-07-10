import * as fs from 'fs';
import * as path from 'path';
import type { HostSeams } from './hostSeams';
import type { BroadcastHub } from './broadcastHub';

/**
 * Kanban Service — Feature A · A2b (Generic Verb Passthrough)
 *
 * Formerly the per-verb shim burn-down target; now holds only the genuinely-
 * extracted methods that webview arms call directly
 * (`this._kanbanService.selectPlan(msg)` etc.). All other verbs are routed
 * through the generic allowlist-gated passthrough in `handleServiceVerb` →
 * `_handleMessage`, so they no longer need a forwarder method here.
 *
 * The HTTP endpoint (`POST /kanban/verb/<name>`) calls `handleServiceVerb`,
 * which allowlist-checks the verb and dispatches into `_handleMessage` —
 * the same code path a webview click takes. Genuine methods survive because
 * `_handleMessage` arms call them directly.
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
    workspaceStateGet(key: string): any;
    workspaceStateUpdate(key: string, value: any): Promise<void>;
    getScopedRoleConfig(roleName: string): any;
    updateScopedRoleConfig(roleName: string, value: any): Promise<void>;
    getScopedSetting(key: string, defaultValue?: any): any;
    updateScopedSetting(key: string, value: any): Promise<void>;
    remoteGetConfigPayload(workspaceRoot?: string): Promise<Record<string, any> | null>;
    remoteSetConfig(workspaceRoot: string | undefined, config: any): Promise<Record<string, any> | null>;
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

    // ─── Genuine extracted verbs (called directly from _handleMessage arms) ───

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
            // Containment check — a bare `startsWith(workspaceRoot)` admits sibling dirs
            // that share a prefix (e.g. `/home/u/repo-secrets` when root is `/home/u/repo`).
            if (fullPath !== workspaceRoot && !fullPath.startsWith(workspaceRoot + path.sep)) {
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
        // Containment check — a bare `startsWith(workspaceRoot)` admits sibling dirs
        // that share a prefix (e.g. `/home/u/repo-secrets` when root is `/home/u/repo`).
        if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(workspaceRoot + path.sep)) {
            this._ctx.broadcaster.push({ type: 'fileExistsResult', exists: false });
            return { success: false, exists: false };
        }
        const exists = fs.existsSync(resolvedPath);
        // Push to webview (the webview arm expects a push response).
        // HTTP callers get the return value directly.
        this._ctx.broadcaster.push({ type: 'fileExistsResult', exists });
        return { success: true, exists };
    }

    /**
     * `getRemoteConfig` — fetch remote-control config payload.
     * Coupling: internal call (remoteGetConfigPayload), BroadcastHub.push.
     */
    async "getRemoteConfig"(payload: any): Promise<any> {
        const result = await this._ctx.remoteGetConfigPayload(payload.workspaceRoot);
        if (result) {
            this._ctx.broadcaster.push(result);
        }
        return { success: true, payload: result };
    }

    /**
     * `getSetting` — read a scoped prompt setting.
     * Coupling: workspaceStateGet, getScopedRoleConfig, getScopedSetting,
     * BroadcastHub.push.
     */
    async "getSetting"(payload: any): Promise<any> {
        const { key } = payload;
        if (typeof key !== 'string') {
            return { success: false, error: 'Key is not a string' };
        }
        const fullKey = `switchboard.prompts.${key}`;

        let value: any;
        if (key === 'selectedRole') {
            value = this._ctx.workspaceStateGet(fullKey);
        } else if (key.startsWith('roleConfig_')) {
            const roleName = key.replace('roleConfig_', '');
            value = this._ctx.getScopedRoleConfig(roleName);
        } else {
            value = this._ctx.getScopedSetting(fullKey, undefined);
        }

        this._ctx.broadcaster.push({ type: 'settingResult', key, value });
        return { success: true, key, value };
    }

    /**
     * `saveSetting` — persist a scoped prompt setting.
     * Coupling: workspaceStateUpdate, updateScopedRoleConfig,
     * updateScopedSetting.
     */
    async "saveSetting"(payload: any): Promise<any> {
        const { key, value } = payload;
        if (typeof key !== 'string') {
            return { success: false, error: 'Key is not a string' };
        }
        const fullKey = `switchboard.prompts.${key}`;

        if (key === 'selectedRole') {
            await this._ctx.workspaceStateUpdate(fullKey, value);
            return { success: true };
        }

        if (key.startsWith('roleConfig_')) {
            const roleName = key.replace('roleConfig_', '');
            await this._ctx.updateScopedRoleConfig(roleName, value);
        } else {
            await this._ctx.updateScopedSetting(fullKey, value);
        }
        return { success: true };
    }

    /**
     * `setRemoteConfig` — persist remote-control config.
     * Coupling: internal call (remoteSetConfig), BroadcastHub.push.
     */
    async "setRemoteConfig"(payload: any): Promise<any> {
        const result = await this._ctx.remoteSetConfig(payload.workspaceRoot, payload.config);
        if (result) {
            this._ctx.broadcaster.push(result);
        }
        return { success: true, payload: result };
    }
}
