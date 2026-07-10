import type { HostSeams } from './hostSeams';
import type { BroadcastHub } from './broadcastHub';

/**
 * Setup Service — Feature A · A2b (Generic Verb Passthrough)
 *
 * Formerly the per-verb shim burn-down target; now holds only the genuinely-
 * extracted methods that webview arms call directly
 * (`this._setupService.saveStartupCommands(message)` etc.). All other verbs
 * are routed through the generic allowlist-gated passthrough in
 * `handleServiceVerb` → `_handleMessage`, so they no longer need a forwarder
 * method here.
 */

export interface SetupServiceContext {
    readonly workspaceRoot: string;
    readonly seams: HostSeams;
    readonly broadcaster: BroadcastHub;
    handleMessage(msg: any): Promise<any>;
    handleGetStartupCommands(): Promise<any>;
    handleSaveStartupCommands(data: any): Promise<void>;
    refreshUI(): Promise<void>;
}

export class SetupService {
    private _ctx: SetupServiceContext;

    constructor(ctx: SetupServiceContext) {
        this._ctx = ctx;
    }

    setContext(ctx: SetupServiceContext): void {
        this._ctx = ctx;
    }

    // ─── Genuine extracted verbs (called directly from _handleMessage arms) ───

    /**
     * `getStartupCommands` — fetch persisted startup commands and push to webview.
     * Coupling: handleGetStartupCommands (provider-internal), BroadcastHub.push.
     */
    async "getStartupCommands"(payload: any): Promise<any> {
        const startupState = await this._ctx.handleGetStartupCommands();
        this._ctx.broadcaster.push({ type: 'startupCommands', ...startupState });
        return { success: true, ...startupState };
    }

    /**
     * `saveStartupCommands` — persist startup commands and refresh the UI.
     * Coupling: handleSaveStartupCommands (provider-internal), refreshUI.
     */
    async "saveStartupCommands"(payload: any): Promise<any> {
        await this._ctx.handleSaveStartupCommands(payload);
        await this._ctx.refreshUI();
        return { success: true };
    }
}
