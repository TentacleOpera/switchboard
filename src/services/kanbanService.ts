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
}
