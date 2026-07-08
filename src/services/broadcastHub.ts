import type * as vscode from 'vscode';
import type { LocalApiServer } from './LocalApiServer';

/**
 * Broadcast Abstraction — Feature A · A2a
 *
 * The dual-fan-out mechanism that routes host→UI push sites to BOTH the
 * VS Code webview (`postMessage`) AND the wsHub (`broadcastWs`). This is
 * the abstraction A2b's 988 push-site audit routes through — every
 * `this._panel?.webview.postMessage({type:...})` site becomes a
 * `broadcaster.push({type:...})` call, preserving per-connection ordering
 * via wsHub's sequence numbers.
 *
 * Ordering: the webview fan-out preserves the existing
 * `_pendingWebviewMessages` queue for initial-load ordering (messages
 * queued before the webview is ready are flushed on `ready`). The wsHub
 * fan-out uses per-connection sequence numbers + resync-on-connect.
 *
 * Usage (A2b replaces direct postMessage calls with this):
 *   broadcaster.push({ type: 'updateBoard', cards });
 *   // → webview.postMessage({type:'updateBoard',cards})
 *   // → wsHub.broadcast('updateBoard', {type:'updateBoard',cards})
 */

export interface BroadcastTarget {
    /** The webview panel to push to (may be null before the panel is ready). */
    webview?: { postMessage(msg: any): Thenable<boolean> } | null;
    /** The LocalApiServer whose wsHub is the WS fan-out target. */
    apiServer?: LocalApiServer | null;
}

export class BroadcastHub {
    private _target: BroadcastTarget;
    private _pendingWebviewMessages: any[] = [];

    constructor(target: BroadcastTarget) {
        this._target = target;
    }

    /** Update the webview target (called when the panel is created/ready). */
    setWebview(webview: { postMessage(msg: any): Thenable<boolean> } | null | undefined): void {
        this._target.webview = webview ?? undefined;
        if (webview && this._pendingWebviewMessages.length) {
            const queued = this._pendingWebviewMessages;
            this._pendingWebviewMessages = [];
            for (const m of queued) {
                webview.postMessage(m).then(undefined, () => { /* panel may have closed */ });
            }
        }
    }

    /** Update the API server target (called when the LocalApiServer starts). */
    setApiServer(apiServer: LocalApiServer | null | undefined): void {
        this._target.apiServer = apiServer ?? undefined;
    }

    /**
     * Push a message to both fan-out targets. If the webview is not ready,
     * the message is queued in `_pendingWebviewMessages` (flushed on
     * `setWebview`). The wsHub broadcast is always attempted (no-op if no
     * WS clients are connected).
     */
    push(msg: any, surface?: string): void {
        // Fan-out 1: the BOUND webview (with pending queue for initial-load ordering).
        if (this._target.webview) {
            this._target.webview.postMessage(msg).then(undefined, () => { /* panel closed */ });
        } else {
            this._pendingWebviewMessages.push(msg);
        }
        // Fan-out 2: wsHub, tagged with `surface`.
        this.mirrorToWs(surface, msg);
    }

    /**
     * WS-only mirror, tagged with `surface`. NO webview delivery — use this when a
     * message was already sent to a specific panel's webview by the caller (so it is
     * NOT re-delivered to the BOUND webview, which would misdeliver to the wrong panel
     * in a multi-panel provider). No-op when no LocalApiServer/wsHub is wired.
     */
    mirrorToWs(surface: string | undefined, msg: any): void {
        if (this._target.apiServer) {
            const verb = msg?.type ?? '__unknown';
            this._target.apiServer.broadcastWs(verb, msg, surface);
        }
    }

    /**
     * Deliver to a SPECIFIC webview (the panel the caller names) AND mirror to WS
     * tagged with `surface`. This is the correct primitive for a provider that owns
     * more than one webview panel: the bound-webview `push()` cannot serve secondary
     * panels without cross-delivering to the main panel. No pending-queue for
     * secondary panels — a closed panel simply drops its webview copy; WS still gets it.
     */
    pushTo(webview: { postMessage(msg: any): Thenable<boolean> } | null | undefined, surface: string, msg: any): void {
        if (webview) {
            webview.postMessage(msg).then(undefined, () => { /* panel closed */ });
        }
        this.mirrorToWs(surface, msg);
    }

    /**
     * Push to the webview only (no WS fan-out). Used for messages that are
     * webview-internal (e.g. `switchToTab`) and should not go to external clients.
     */
    pushWebviewOnly(msg: any): void {
        if (this._target.webview) {
            this._target.webview.postMessage(msg).then(undefined, () => { /* panel closed */ });
        } else {
            this._pendingWebviewMessages.push(msg);
        }
    }

    /** Number of messages queued waiting for the webview to become ready. */
    get pendingCount(): number {
        return this._pendingWebviewMessages.length;
    }

    /** Flush the pending queue (called when the webview signals ready). */
    flushPending(): void {
        if (this._target.webview && this._pendingWebviewMessages.length) {
            const queued = this._pendingWebviewMessages;
            this._pendingWebviewMessages = [];
            for (const m of queued) {
                this._target.webview.postMessage(m).then(undefined, () => { /* panel closed */ });
            }
        }
    }
}
