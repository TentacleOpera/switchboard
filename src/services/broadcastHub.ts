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
    /**
     * Headless mode: set when the hub will NEVER acquire a webview (the
     * standalone/npx host). When true, `push` and `pushWebviewOnly` skip the
     * `_pendingWebviewMessages` append entirely — the queue is load-bearing
     * only for the editor's pre-webview cold-start ordering, and in a
     * headless process it grows unbounded (one shared hub, six providers,
     * driven by the 40 ms coalesced push loop). The WS fan-out is the sole
     * delivery path. Must NOT be set in the editor host — it would break
     * initial-load ordering on ~4,000 installed extensions.
     */
    headless?: boolean;
}

export class BroadcastHub {
    private _target: BroadcastTarget;
    private _pendingWebviewMessages: any[] = [];
    private _webviewScope: string | null | undefined;

    constructor(target: BroadcastTarget) {
        this._target = target;
    }

    setWebviewScope(scope: string | null | undefined): void {
        this._webviewScope = scope;
    }

    /**
     * The scope the BOUND webview declared (via its `setPushScope` verb). The webview
     * is a scoped pseudo-connection exactly like a WS client, so any push built OUTSIDE
     * the factory form — e.g. a mount-time full-state snapshot — must render against
     * this value or it silently delivers singleton-tier state to a project-scoped panel.
     * `undefined` = never declared → the singleton fallback the accessors already own.
     */
    getWebviewScope(): string | null | undefined {
        return this._webviewScope;
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

    /**
     * True when this hub was built for the headless (standalone / browser) host —
     * there is no VS Code webview and never will be, so WS fan-out is the ONLY
     * delivery path. Watcher-driven refreshes must gate on this rather than on a
     * panel handle: `!this._panel` is permanently true in standalone, which turns
     * every panel-gated watcher into a silent no-op.
     */
    isHeadless(): boolean {
        return this._target.headless === true;
    }

    /** Update the API server target (called when the LocalApiServer starts). */
    setApiServer(apiServer: LocalApiServer | null | undefined): void {
        this._target.apiServer = apiServer ?? undefined;
    }

    /**
     * Push a message to both fan-out targets. If the webview is not ready,
     * the message is queued in `_pendingWebviewMessages` (flushed on
     * `setWebview`). The wsHub broadcast is always attempted (no-op if no
     * WS clients are connected). Accepts either a static message object or
     * a (scope) => message factory for per-connection rendering.
     */
    push(msg: any, surface?: string, verbHint?: string): void {
        const isFactory = typeof msg === 'function';
        const webviewMsg = isFactory ? (msg as Function)(this._webviewScope) : msg;
        // Fan-out 1: the BOUND webview (with pending queue for initial-load ordering).
        // In headless mode there is no webview and never will be — skip the queue
        // entirely so it cannot grow unbounded. The WS fan-out is the sole path.
        if (this._target.webview) {
            this._target.webview.postMessage(webviewMsg).then(undefined, () => { /* panel closed */ });
        } else if (!this._target.headless) {
            this._pendingWebviewMessages.push(webviewMsg);
        }
        // Fan-out 2: wsHub, tagged with `surface`.
        this.mirrorToWs(surface, msg, verbHint || webviewMsg?.type);
    }

    /**
     * WS-only mirror, tagged with `surface`. NO webview delivery — use this when a
     * message was already sent to a specific panel's webview by the caller (so it is
     * NOT re-delivered to the BOUND webview, which would misdeliver to the wrong panel
     * in a multi-panel provider). No-op when no LocalApiServer/wsHub is wired.
     */
    mirrorToWs(surface: string | undefined, msg: any, explicitVerb?: string): void {
        if (this._target.apiServer) {
            const verb = explicitVerb ?? (typeof msg === 'function' ? '__unknown' : (msg?.type ?? '__unknown'));
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
    pushTo(webview: { postMessage(msg: any): Thenable<boolean> } | null | undefined, surface: string, msg: any, verbHint?: string): void {
        const isFactory = typeof msg === 'function';
        const webviewMsg = isFactory ? (msg as Function)(this._webviewScope) : msg;
        if (webview) {
            webview.postMessage(webviewMsg).then(undefined, () => { /* panel closed */ });
        }
        this.mirrorToWs(surface, msg, verbHint || webviewMsg?.type);
    }

    /**
     * Push to the webview only (no WS fan-out). Used for messages that are
     * webview-internal (e.g. `switchToTab`) and should not go to external clients.
     * In headless mode there is no webview and no WS fan-out by definition —
     * the message is dropped (a webview-internal message has no headless
     * consumer). This is correct: `switchToTab` etc. are editor-chrome
     * directives that are meaningless without a sidebar panel.
     */
    pushWebviewOnly(msg: any): void {
        if (this._target.headless) { return; }
        const isFactory = typeof msg === 'function';
        const webviewMsg = isFactory ? (msg as Function)(this._webviewScope) : msg;
        if (this._target.webview) {
            this._target.webview.postMessage(webviewMsg).then(undefined, () => { /* panel closed */ });
        } else {
            this._pendingWebviewMessages.push(webviewMsg);
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
