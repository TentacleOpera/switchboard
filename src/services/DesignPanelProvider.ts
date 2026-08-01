
import { HostSeams, HostWatchHandle, createVscodeHostSeams } from './hostSeams';
import { BroadcastHub } from './broadcastHub';
import { DESIGN_VERBS } from '../generated/verbAllowlist';
import { validateVerbPayload } from './verbSchemas';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { showTemporaryNotification } from '../utils/showTemporaryNotification';
import { applyThemeBodyClass } from './themeBodyClass';
import { KanbanDatabase } from './KanbanDatabase';
import { LocalFolderService } from './LocalFolderService';
import { TaskViewerProvider } from './TaskViewerProvider';
import { PanelStateStore } from './PanelStateStore';
import { buildWorkspaceItems } from './workspaceUtils';
import { buildDesignSystemBlock } from './agentPromptBuilder';
import { getProjectDesignSystemPath, setProjectDesignSystemPath, removeProjectDesignSystemPath } from './designSystemUtils';
import { reviveWithRetention } from '../utils/reviveWithRetention';

import { STARTER_DESIGN_SYSTEM_HTML } from './designSystemStarterTemplate';

// @google/stitch-sdk is ESM-only (its exports map has no "require" condition), so a
// static import fails resolution in this CJS bundle. A dynamic import() resolves it via
// the "import" condition at build time. Webpack emits it as a lazy chunk in dist/ (like
// the other split chunks the extension already ships), so the SDK's code is loaded only
// when the Design panel is first used instead of sitting resident in the main bundle.
let _stitchSdkPromise: Promise<any> | undefined;
function loadStitch(_accessToken: string): Promise<any> {
    if (!_stitchSdkPromise) {
        _stitchSdkPromise = import('@google/stitch-sdk').then(m => m.stitch);
    }
    return _stitchSdkPromise;
}

// Long-lived raw MCP client for tool calls the high-level SDK wrappers can't serve —
// generate/edit/variants responses carry the model's text commentary and follow-up
// suggestions, which the SDK's projections silently drop. Screen instances built from
// raw responses hold this client for later calls, so it must not be closed while in use.
let _stitchRawClientPromise: Promise<any> | undefined;
function loadStitchRawClient(): Promise<any> {
    if (!_stitchRawClientPromise) {
        _stitchRawClientPromise = import('@google/stitch-sdk').then((m: any) => new m.StitchToolClient());
    }
    return _stitchRawClientPromise;
}

export function invalidateStitchSdkCache(): void {
    _stitchSdkPromise = undefined;
    // The raw client captured the previous API key at connect time — retire it.
    _stitchRawClientPromise?.then(c => c.close()).catch(() => { /* best effort */ });
    _stitchRawClientPromise = undefined;
}

interface TreeNode {
    id: string;
    name: string;
    kind: 'document' | 'folder';
    parentId?: string;
    hasChildren?: boolean;
    title?: string;
    metadata?: any;
}



export class DesignPanelProvider implements vscode.Disposable {

    public async handleServiceVerb(verb: string, payload: any): Promise<any> {
        if (!this._broadcaster) {
            this._initDesignService();
        }
        if (!DESIGN_VERBS.has(verb)) {
            throw new Error(`Unknown Design verb: '${verb}'`);
        }
        // Network boundary: HTTP payloads are untrusted (webview postMessage was
        // not) — validate against the verb's schema before dispatch. Verbs with
        // no schema yet pass through (generic-dispatch contract, zero per-verb code).
        const validation = validateVerbPayload('design', verb, payload);
        if (!validation.ok) {
            throw new Error(`Invalid payload for Design verb '${verb}': ${validation.error}`);
        }
        // VS Code is the host here; _handleMessage runs in-process. Migrated arms
        // RETURN their result (returned to the HTTP caller in the response body;
        // the webview push stays additive); un-migrated arms still `break` and the
        // route layer sends its {success:true} ack.
        // `type`, `__replyChannel` and `__viaHttp` are set LAST so a payload field can never override
        // the allowlist-checked verb or forge the reply channel/stamp, regardless of caller.
        // `__replyChannel: 'http'` means "an HTTP caller is awaiting the response body" —
        // reply arms return their payload instead of pushing it to every connected client.
        return this._handleMessage({ ...(payload ?? {}), type: verb, __replyChannel: 'http' as const, __viaHttp: true as const });
    }


    private _initDesignService(): void {
        const workspaceRoot = this._getWorkspaceRoot() || '';
        if (!workspaceRoot) {
            this._hostSeams = undefined;
            this._broadcaster = undefined;
            return;
        }
        this._hostSeams = createVscodeHostSeams(workspaceRoot, this._context.secrets);
        if (!this._broadcaster) {
            this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: this._apiServer ?? null });
        } else {
            this._broadcaster.setWebview(this._panel?.webview);
            if (this._apiServer) {
                this._broadcaster.setApiServer(this._apiServer);
            }
        }
    }

    private _seatFor(message: any) {
        const id = message?.originatorId || DesignPanelProvider._DEFAULT_SEAT;
        // Any message from a client is proof of life: cancel a pending eviction
        // scheduled by a WS drop, so a reconnect (or the re-assertion it triggers)
        // inside the grace window keeps the seat. Without this the timer fires
        // ~60s after a transient blip and silently deletes the LIVE seat.
        const pendingEviction = this._evictionTimers.get(id);
        if (pendingEviction) {
            clearTimeout(pendingEviction);
            this._evictionTimers.delete(id);
        }
        let seat = this._seats.get(id);
        if (!seat) {
            const isViaHttp = !!message?.__viaHttp;
            seat = {
                activeTab: '',
                htmlPreview: null,
                claudePreview: null,
                stitchHtmlPreview: null,
                designPreview: null,
                isExtensionWebview: !isViaHttp
            };
            this._seats.set(id, seat);
        }
        return seat;
    }

    private _evictSeat(originatorId: string): void {
        this._seats.delete(originatorId);
        const timer = this._evictionTimers.get(originatorId);
        if (timer) {
            clearTimeout(timer);
            this._evictionTimers.delete(originatorId);
        }
        for (const [key, t] of Array.from(this._autoRefreshDebounces.entries())) {
            if (key.startsWith(`${originatorId}::`)) {
                clearTimeout(t);
                this._autoRefreshDebounces.delete(key);
            }
        }
        for (const key of Array.from(this._pollPreviewMtimes.keys())) {
            if (key.startsWith(`${originatorId}::`)) {
                this._pollPreviewMtimes.delete(key);
            }
        }
        // Leak guard: seats are bounded by live WS connections plus the extension
        // webview's seat and the legacy default seat. Log-only — a violation means
        // seat lifetime and connection lifetime have drifted apart.
        const connections: number | undefined = this._apiServer?.wsHub?.connectionCount;
        if (typeof connections === 'number' && this._seats.size > connections + 2) {
            console.warn(`[DesignPanelProvider] seat leak suspected: ${this._seats.size} seats > ${connections} WS connections + 2`);
        }
        this._reconcilePoll();
    }

    /** Drop the extension webview's seat(s) when the panel goes away — the seat is
     *  pinned to the panel's lifetime. A reopened panel generates a fresh client
     *  originatorId, so stale webview seats would otherwise accumulate forever and
     *  revive their poll/auto-refresh contributions whenever a new panel is visible. */
    private _evictExtensionWebviewSeats(): void {
        for (const [id, seat] of Array.from(this._seats.entries())) {
            if (seat.isExtensionWebview) {
                this._evictSeat(id);
            }
        }
    }

    private _apiServer?: any;

    public setApiServer(server: any): void {
        this._apiServer = server;
        this._broadcaster?.setApiServer(server);
        if (server?.wsHub) {
            server.wsHub.onDisconnect((originatorId: string) => {
                // The hub is shared by every panel; only IDs holding a Design seat matter.
                if (!this._seats.has(originatorId)) return;
                if (this._evictionTimers.has(originatorId)) return;
                const timer = setTimeout(() => {
                    this._evictSeat(originatorId);
                }, this._evictionGraceMs);
                this._evictionTimers.set(originatorId, timer);
            });
        }
    }

    /**
     * Absolutise a root-relative API URL against the loopback server, or undefined when
     * no server is listening.
     *
     * Every asset URL this provider emits is pushed to BOTH clients at once (the editor
     * webview and every browser-cockpit tab share one `postMessage` fan-out), so a
     * host-detected URL is wrong for one of them whenever both are open: an
     * `asWebviewUri` result is unresolvable in a browser, and a root-relative
     * `/design/asset…` path is unresolvable in a webview. An absolute loopback URL is
     * the only form both hosts can load, so prefer it and keep the host-specific
     * branches only as the no-server fallback.
     */
    private _absoluteApiUrl(relativeUrl: string): string | undefined {
        const port: number | undefined = this._apiServer?.getPort?.();
        return port ? `http://127.0.0.1:${port}${relativeUrl}` : undefined;
    }

    /**
     * Absolute folder paths the `GET /design/asset` route is allowed to serve from
     * for `workspaceRoot` — exactly the user-configured Design/HTML/Claude/
     * Images folders this provider previews from. The allow-list lives here (not in
     * LocalApiServer) so the HTTP route and the provider's own preview validation
     * can never drift apart.
     */
    public getDesignAssetRoots(workspaceRoot: string): string[] {
        try {
            const service = this._getLocalFolderService(workspaceRoot);
            return [
                ...service.getDesignFolderPaths(),
                ...service.getHtmlFolderPaths(),
                ...service.getClaudeFolderPaths(),
                ...service.getImagesFolderPaths(),
            ].filter(Boolean);
        } catch {
            return [];
        }
    }

    /**
     * Seam bundle accessor for migrated _handleMessage arms. Lazily builds the
     * vscode-backed bundle when the provider is driven before `_initDesignService`
     * ran (or when no workspace root resolved — seams still work; path-scoped
     * config reads just resolve against the empty root). The test-seam harness
     * injects a headless bundle by assigning `_hostSeams` directly.
     */
    private _seams(): HostSeams {
        if (!this._hostSeams) {
            this._hostSeams = createVscodeHostSeams(this._getWorkspaceRoot() || '', this._context.secrets);
        }
        return this._hostSeams;
    }

    private _hostSeams?: HostSeams;
    private _broadcaster?: BroadcastHub;

    private _panel?: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _nonce: string = '';
    private _htmlFolderWatchers: HostWatchHandle[] = [];
    private _claudeFolderWatchers: HostWatchHandle[] = [];
    private _designFolderWatchers: HostWatchHandle[] = [];
    private _designFolderNativeWatchers: fs.FSWatcher[] = [];
    private _imagesFolderWatchers: HostWatchHandle[] = [];
    private _stitchHtmlFolderWatchers: HostWatchHandle[] = [];
    // Native fs.watch fallbacks for out-of-workspace folders where VS Code's
    // createFileSystemWatcher silently drops events (macOS fsevents, Linux
    // inotify, Windows ReadDirectoryChangesW). Parallel to the HostWatchHandle
    // arrays above; disposed in disposeWatchers().
    private _htmlFolderNativeWatchers: fs.FSWatcher[] = [];
    private _claudeFolderNativeWatchers: fs.FSWatcher[] = [];
    private _stitchHtmlFolderNativeWatchers: fs.FSWatcher[] = [];
    private _saveTextDocListener?: vscode.Disposable;
    private _htmlDocsDebounce?: NodeJS.Timeout;
    private _claudeDocsDebounce?: NodeJS.Timeout;
    private _designDocsDebounce?: NodeJS.Timeout;
    private _imagesDocsDebounce?: NodeJS.Timeout;
    private _seats = new Map<string, {
        activeTab: string;
        htmlPreview: { sourceFolder: string; docId: string; sourceId: string } | null;
        claudePreview: { sourceFolder: string; docId: string; sourceId: string } | null;
        stitchHtmlPreview: { sourceFolder: string; docId: string; sourceId: string; projectId: string; workspaceRoot: string } | null;
        designPreview: { sourceFolder: string; docId: string; sourceId: string } | null;
        isExtensionWebview: boolean;
    }>();
    private static readonly _DEFAULT_SEAT = '__default__';
    private _evictionTimers = new Map<string, NodeJS.Timeout>();
    /** Grace between a seat's WS disconnect and its eviction. transport.js's
     *  reconnect backoff caps at 30s, so a transient drop must not evict. */
    private _evictionGraceMs = 60000;
    /** Last-seen mtime (ms) of each seat's registered preview file, keyed
     *  `${originatorId}::${target}` — lets the external-file poll detect edits to
     *  the previewed DOCUMENT (not just the folder listing) in hosts/states where
     *  no FileSystemWatcher exists: panel closed, or the standalone host. */
    private _pollPreviewMtimes = new Map<string, number>();
    private _externalFilePollTimer?: NodeJS.Timeout;
    private _lastFolderSignature: Record<string, string> = {}; // keyed by tab name
    private _activeScreens = new Map<string, any>(); // Key: screen.id, Value: SDK Screen instance
    private _stitchProjectNames = new Map<string, string>(); // Key: projectId, Value: project name
    private _stitchCacheMigrated = new Set<string>(); // workspaceRoots that have been migrated
    private _stitchOperationLock = false;
    private _activeDesignSystemDocSourceId: string | null = null;
    private _activeDesignSystemDocId: string | null = null;
    private _htmlServers = new Map<string, { server: http.Server; port: number; timeoutId: NodeJS.Timeout }>();
    private _htmlServerCreationPromises = new Map<string, Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }>>();
    public static readonly _INSPECTOR_SCRIPT = `<script>(function(){
'use strict';
if (window.__sbInspectorInstalled) return;
window.__sbInspectorInstalled = true;

var active = false;
var hoveredElement = null;
var overlay = null;
var overlayLabel = null;

function createOverlay() {
    overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.pointerEvents = 'none';
    overlay.style.background = 'rgba(0, 120, 215, 0.2)';
    overlay.style.outline = '1px solid rgb(0, 120, 215)';
    overlay.style.zIndex = '2147483647';
    overlay.style.transition = 'all 0.05s ease-out';
    overlay.style.display = 'none';

    overlayLabel = document.createElement('div');
    overlayLabel.style.position = 'absolute';
    overlayLabel.style.background = 'rgb(0, 120, 215)';
    overlayLabel.style.color = '#fff';
    overlayLabel.style.fontSize = '10px';
    overlayLabel.style.fontFamily = 'monospace';
    overlayLabel.style.padding = '2px 6px';
    overlayLabel.style.borderRadius = '3px';
    overlayLabel.style.whiteSpace = 'nowrap';
    overlayLabel.style.pointerEvents = 'none';
    overlay.appendChild(overlayLabel);

    document.body.appendChild(overlay);
}

function updateOverlay(el) {
    if (!overlay) createOverlay();
    if (!el || el === document.body || el === document.documentElement) {
        overlay.style.display = 'none';
        return;
    }
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
        overlay.style.display = 'none';
        return;
    }

    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    overlay.style.display = 'block';

    var label = getBreadcrumb(el);
    overlayLabel.textContent = label;

    if (rect.top > 20) {
        overlayLabel.style.top = '-18px';
        overlayLabel.style.bottom = 'auto';
        overlayLabel.style.left = '0px';
    } else {
        overlayLabel.style.top = '0px';
        overlayLabel.style.bottom = 'auto';
        overlayLabel.style.left = '0px';
    }
}

function getBreadcrumb(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var classes = el.getAttribute('class');
    var classStr = '';
    if (classes && typeof classes === 'string') {
        var cleanClasses = classes.trim().split(/\\s+/).filter(Boolean);
        if (cleanClasses.length > 0) {
            classStr = '.' + cleanClasses.slice(0, 2).join('.');
        }
    }
    return tag + id + classStr;
}

function buildSelector(el) {
    if (el.id) {
        try {
            if (document.querySelectorAll('#' + el.id).length === 1) {
                return '#' + el.id;
            }
        } catch(e) {}
    }
    var path = [];
    var current = el;
    var depth = 0;
    while (current && current.nodeType === Node.ELEMENT_NODE && depth < 10) {
        var selector = current.tagName.toLowerCase();
        if (current.id) {
            selector += '#' + current.id;
            path.unshift(selector);
            try {
                if (document.querySelectorAll(path.join(' > ')).length === 1) {
                    break;
                }
            } catch(e) {}
        } else {
            var classes = current.getAttribute('class');
            if (classes && typeof classes === 'string') {
                var cleanClasses = classes.trim().split(/\\s+/).filter(Boolean);
                if (cleanClasses.length > 0) {
                    selector += '.' + cleanClasses.join('.');
                }
            }
            var siblings = current.parentNode ? current.parentNode.children : [];
            var sameTagIndex = 0;
            var isUniqueAmongSiblings = true;
            for (var i = 0; i < siblings.length; i++) {
                var sib = siblings[i];
                if (sib.tagName === current.tagName) {
                    sameTagIndex++;
                    if (sib !== current) {
                        isUniqueAmongSiblings = false;
                    }
                }
            }
            if (!isUniqueAmongSiblings && sameTagIndex > 0) {
                selector += ':nth-of-type(' + sameTagIndex + ')';
            }
            path.unshift(selector);
        }
        
        try {
            if (document.querySelectorAll(path.join(' > ')).length === 1) {
                break;
            }
        } catch(e) {}
        
        current = current.parentNode;
        depth++;
    }
    return path.join(' > ');
}

function onMouseOver(e) {
    if (!active) return;
    var target = e.target;
    if (target === overlay || overlay && overlay.contains(target)) return;
    hoveredElement = target;
    updateOverlay(target);
}

function onMouseOut(e) {
    if (!active) return;
    if (!e.relatedTarget) {
        if (overlay) overlay.style.display = 'none';
        hoveredElement = null;
    }
}

function onClick(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();

    var el = hoveredElement || e.target;
    if (!el) return;

    var selector = buildSelector(el);
    var tag = el.tagName.toLowerCase();
    var id = el.id || '';
    
    var classes = [];
    var classesAttr = el.getAttribute('class');
    if (classesAttr && typeof classesAttr === 'string') {
        classes = classesAttr.trim().split(/\\s+/).filter(Boolean);
    }

    var text = (el.textContent || '').trim();
    if (text.length > 200) {
        text = text.substring(0, 200) + '...';
    }

    var outerHTML = el.outerHTML || '';
    if (outerHTML.length > 2048) {
        outerHTML = outerHTML.substring(0, 2048) + '... [truncated]';
    }

    window.parent.postMessage({
        type: 'stitchElementSelected',
        selector: selector,
        tag: tag,
        id: id,
        classes: classes,
        text: text,
        outerHTML: outerHTML
    }, '*');
}

function onKeyDown(e) {
    if (!active) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        toggle(false);
    }
}

function onScroll() {
    if (!active || !hoveredElement) return;
    updateOverlay(hoveredElement);
}

function toggle(on) {
    active = !!on;
    if (active) {
        document.addEventListener('mouseover', onMouseOver, true);
        document.addEventListener('mouseout', onMouseOut, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        if (hoveredElement) updateOverlay(hoveredElement);
    } else {
        document.removeEventListener('mouseover', onMouseOver, true);
        document.removeEventListener('mouseout', onMouseOut, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('scroll', onScroll, true);
        if (overlay) overlay.style.display = 'none';
        hoveredElement = null;
    }
    window.parent.postMessage({ type: 'sbInspectState', on: active }, '*');
}

window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'sbInspectToggle') {
        toggle(e.data.on);
    }
});

// ── Space-to-pan forwarding (always on, independent of Inspect Mode) ──
function isEditableTarget(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
window.addEventListener('keydown', function(e) {
    if (e.code !== 'Space' || e.repeat) return;
    if (isEditableTarget(document.activeElement)) return; // let the field type a space
    e.preventDefault();                                    // stop the "jump down"
    window.parent.postMessage({ type: 'sbSpacePan', on: true }, '*');
}, true);
window.addEventListener('keyup', function(e) {
    if (e.code !== 'Space') return;
    window.parent.postMessage({ type: 'sbSpacePan', on: false }, '*');
}, true);
window.addEventListener('blur', function() {
    window.parent.postMessage({ type: 'sbSpacePan', on: false }, '*');
});

// ── Wheel forwarding so the parent can pan/zoom the transformed canvas even
//    when the capture layer is hidden (Pan mode off). The iframe is rendered at
//    natural size and swallows wheel events; forward them up so plain scroll
//    navigates the preview without forcing Pan mode on. Ctrl/Cmd+wheel still
//    zooms (matched on the parent side). preventDefault stops a preview page
//    that happens to be internally scrollable from also trying to scroll. ──
window.addEventListener('wheel', function(e) {
    try {
        e.preventDefault();
        window.parent.postMessage({
            type: 'sbWheel',
            deltaX: e.deltaX, deltaY: e.deltaY,
            deltaMode: e.deltaMode,
            ctrlKey: e.ctrlKey, metaKey: e.metaKey
        }, '*');
    } catch (err) {}
}, { passive: false, capture: true });

// ── Natural content-size reporter helper (pure classification function) ──
export function computeReportedWidth(rawW: number, clientWidth: number, innerWidth: number): number | null {
    if (clientWidth === 0) return null;
    var maxView = Math.max(clientWidth, innerWidth);
    if (rawW > maxView + 1) {
        return rawW;
    }
    return null;
}

// ── Natural content-size reporter (drives real Fit/Reset + panning) ──
function reportDims() {
    var d = document.documentElement;
    var clientW = d.clientWidth || 0;
    if (!clientW) return; // zero-layout frame guard

    var rawW = Math.max(d.scrollWidth, document.body ? document.body.scrollWidth : 0);
    var h = Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0);
    var maxView = Math.max(clientW, window.innerWidth || 0);
    var w = (rawW > maxView + 1) ? rawW : null;

    if (h) window.parent.postMessage({ type: 'sbContentDims', w: w, h: h }, '*');
}
window.addEventListener('load', reportDims);
window.addEventListener('resize', reportDims);
try { new ResizeObserver(reportDims).observe(document.documentElement); } catch (e) {}
setTimeout(reportDims, 0);
})();</script>`;

    private _injectIntoHead(html: string, snippet: string): string {
        if (/<head\b[^>]*>/i.test(html)) {
            return html.replace(/<head\b[^>]*>/i, m => m + snippet);
        } else if (/<html\b[^>]*>/i.test(html)) {
            return html.replace(/<html\b[^>]*>/i, m => m + snippet);
        } else {
            return snippet + html;
        }
    }

    private readonly _SERVER_DENY_LIST: readonly string[] = [
        '.switchboard',
        '.git',
        '.env',
        '.env.',
        'node_modules',
        'secrets',
        'credentials',
        '.ssh',
        '.aws',
    ];
    private _lastWebviewRootsSignature?: string;
    private _themeListenersRegistered = false;
    private _activeStitchHtmlProjectId: string = '';
    private _activeStitchHtmlWorkspaceRoot: string = '';
    private _autoRefreshDebounces = new Map<string, NodeJS.Timeout>();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _getWorkspaceRoot: () => string | undefined,
        private readonly _context: vscode.ExtensionContext,
        private readonly _stateStore: PanelStateStore,
        private readonly _taskViewerProvider?: TaskViewerProvider
    ) {}

    public get isOpen(): boolean {
        return !!this._panel;
    }

    public async open(column?: vscode.ViewColumn): Promise<void> {
        const targetColumn = column ?? vscode.ViewColumn.One;
        if (this._panel) {
            this._panel.reveal(targetColumn, true);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-design',
            'DESIGN',
            { viewColumn: targetColumn, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this._extensionUri, 'dist'),
                    vscode.Uri.joinPath(this._extensionUri, 'webview'),
                    vscode.Uri.joinPath(this._extensionUri, 'designs'),
                    vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
                    ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri)
                ]
            }
        );

        this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
        this._panel.webview.html = this._getHtml(this._panel.webview);

        this._panel.webview.onDidReceiveMessage(
            async (message) => this._handleMessage(message),
            undefined,
            this._disposables
        );

        // MUST run after `_panel` is assigned and BEFORE any push. It constructs the
        // BroadcastHub (or re-binds an existing one's webview target via setWebview,
        // flushing anything queued while no panel was open). Without it: no WS fan-out
        // at all, and — if an HTTP verb already lazily built the hub with no panel
        // bound — every `pushWebviewOnly` reply rots in `_pendingWebviewMessages`
        // and the editor panel goes silently dead. Do not remove.
        this._initDesignService();

        this._panel.onDidDispose(() => {
            this._panel = undefined;
            this._broadcaster?.setWebview(null);
            this.disposeWatchers();
            // The webview seat is pinned to the panel's lifetime: drop it first,
            // THEN reconcile — so closing the panel withdraws only the webview's
            // poll contribution and never stops a browser-only poll.
            this._evictExtensionWebviewSeats();
            this._reconcilePoll();
        }, null, this._disposables);

        this._panel.onDidChangeViewState(e => this._onVisibilityChanged(e.webviewPanel.visible), null, this._disposables);

        this._setupHtmlFolderWatchers();
        this._setupClaudeFolderWatchers();
        this._setupDesignFolderWatchers();
        this._setupImagesFolderWatchers();
        this._registerSaveTextDocListener();

        this._disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(async () => {
                this.postMessage({
                    type: 'workspaceItemsUpdated',
                    items: buildWorkspaceItems(this._getWorkspaceRoots())
                });
                this.disposeWatchers();
                this._setupHtmlFolderWatchers();
                this._setupClaudeFolderWatchers();
                this._setupDesignFolderWatchers();
                this._setupImagesFolderWatchers();
                void this._setupStitchHtmlFolderWatchers().catch(() => {});
                await this._sendHtmlDocsReady();
                await this._sendClaudeDocsReady();
                await this._sendDesignDocsReady();
                await this._sendImagesDocsReady();
            })
        );

        if (!this._themeListenersRegistered) {
            this._themeListenersRegistered = true;
            this._disposables.push(
                vscode.window.onDidChangeActiveColorTheme(() => {
                    this.postMessage({ type: 'themeChanged' });
                })
            );
            this._disposables.push(
                vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
                        const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
                        this.postMessage({ type: 'cyberAnimationSetting', disabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
                        const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
                        this.postMessage({ type: 'cyberScanlinesSetting', disabled });
                    }
                    if (e.affectsConfiguration('switchboard.theme.name')) {
                        const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                        this.postMessage({ type: 'switchboardThemeChanged', theme });
                    }
                    if (e.affectsConfiguration('switchboard.theme.ultracodeAnimation')) {
                        const enabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.ultracodeAnimation', false);
                        this.postMessage({ type: 'ultracodeAnimationSetting', enabled });
                    }
                    if (e.affectsConfiguration('switchboard.design.externalFilePollMs')) {
                        // Stop first: _startExternalFilePoll no-ops while a timer is
                        // live, so a bare reconcile would keep the OLD interval running
                        // (and `<= 0` — the disable escape hatch — would never engage).
                        this._stopExternalFilePoll();
                        this._reconcilePoll();
                    }
                })
            );
        }
    }

    public async deserializeWebviewPanel(
        panel: vscode.WebviewPanel,
        state: any
    ): Promise<void> {
        await reviveWithRetention(panel, async (col) => {
            await this.open(col);
        });
    }

    /**
     * The provider's ONE transport-internal raw send — the no-broadcaster fallback
     * shared by `postMessage` and `_postReply`. Kept as a single site on purpose:
     * `scripts/check-push-routing.js` ratchets this file at ONE raw webview send, and
     * a second literal call site fails that CI gate
     * (`.github/workflows/integration-tests.yml`). Route new sends through
     * `postMessage` / `_postReply`, never through a fresh raw call. (The checker is a
     * regex over source text, so do not spell the raw call out in prose either.)
     */
    private _postRawToWebview(message: any): void {
        this._panel?.webview.postMessage(message);
    }

    public postMessage(message: any): void {
        if (this._broadcaster) {
            this._broadcaster.push(message);
        } else {
            this._postRawToWebview(message);
        }
    }

    /**
     * Deliver a per-client REQUEST/RESPONSE reply on the channel its request arrived on.
     * Contrast `postMessage`, which broadcasts — correct for shared data, wrong for a
     * reply, which has exactly one legitimate recipient.
     *
     *  'http'      → no push at all. The arm RETURNS the payload; LocalApiServer writes it
     *                to the response body and transport.js re-dispatches it as a
     *                MessageEvent in the requesting tab only. The returned body MUST carry
     *                a `type` — transport.js drops a body without one, silently.
     *  'webview'   → the bound editor webview only, no WS mirror. The webview bridge
     *                discards `_handleMessage`'s return value, so a push is the only
     *                channel back to the editor.
     *  undefined   → host-initiated (e.g. the save-watcher auto-refresh). Nobody asked,
     *                every client is a legitimate recipient: broadcast, as today.
     *
     * NOTE: `pushWebviewOnly` queues into the hub's `_pendingWebviewMessages` when no
     * webview is bound. Unreachable in normal flow (a 'webview' channel implies a live
     * panel, and `open()`/`deserializeWebviewPanel` both bind via `_initDesignService`);
     * a panel disposed mid-request leaves exactly one orphan entry. Bounded and
     * harmless — already reviewed, do not re-litigate.
     */
    private _postReply(message: any, channel: 'http' | 'webview' | undefined): void {
        if (channel === 'http') { return; }
        if (channel === 'webview') {
            if (this._broadcaster) { this._broadcaster.pushWebviewOnly(message); }
            else { this._postRawToWebview(message); }
            return;
        }
        this.postMessage(message);
    }

    public dispose(): void {
        this._panel?.dispose();
        this.disposeWatchers();
        this._activeScreens.clear();
        this._stitchOperationLock = false;
        for (const [, entry] of this._htmlServers) {
            clearTimeout(entry.timeoutId);
            try { entry.server.close(); } catch {}
        }
        this._htmlServers.clear();
        this._htmlServerCreationPromises.clear();
        // Queued listing pushes must not fire into a disposed provider. The stitch-html
        // sweep schedules one of these per downloaded file, so the window is no longer
        // theoretical.
        for (const t of [this._htmlDocsDebounce, this._claudeDocsDebounce, this._designDocsDebounce,
                         this._imagesDocsDebounce, this._stitchHtmlDocsDebounce]) {
            if (t) clearTimeout(t);
        }
        this._htmlDocsDebounce = undefined;
        this._claudeDocsDebounce = undefined;
        this._designDocsDebounce = undefined;
        this._imagesDocsDebounce = undefined;
        this._stitchHtmlDocsDebounce = undefined;
        this._saveTextDocListener?.dispose();
        this._saveTextDocListener = undefined;
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables = [];
        for (const t of this._autoRefreshDebounces.values()) {
            clearTimeout(t);
        }
        this._autoRefreshDebounces.clear();
        for (const t of this._evictionTimers.values()) {
            clearTimeout(t);
        }
        this._evictionTimers.clear();
        this._pollPreviewMtimes.clear();
        this._seats.clear();
        this._stopExternalFilePoll();
    }

    private disposeWatchers(): void {
        this._htmlFolderWatchers.forEach(w => w.dispose());
        this._htmlFolderWatchers = [];
        this._claudeFolderWatchers.forEach(w => w.dispose());
        this._claudeFolderWatchers = [];
        this._designFolderWatchers.forEach(w => w.dispose());
        this._designFolderWatchers = [];
        this._imagesFolderWatchers.forEach(w => w.dispose());
        this._imagesFolderWatchers = [];
        this._stitchHtmlFolderWatchers.forEach(w => w.dispose());
        this._stitchHtmlFolderWatchers = [];
        for (const w of this._htmlFolderNativeWatchers) { try { w.close(); } catch {} }
        this._htmlFolderNativeWatchers = [];
        for (const w of this._claudeFolderNativeWatchers) { try { w.close(); } catch {} }
        this._claudeFolderNativeWatchers = [];
        for (const w of this._stitchHtmlFolderNativeWatchers) { try { w.close(); } catch {} }
        this._stitchHtmlFolderNativeWatchers = [];
        for (const w of this._designFolderNativeWatchers) { try { w.close(); } catch {} }
        this._designFolderNativeWatchers = [];
    }

    private _getHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        this._nonce = nonce;
        const cspSource = webview.cspSource;

        const possiblePaths = [
            path.join(this._extensionUri.fsPath, 'dist', 'webview', 'design.html'),
            path.join(this._extensionUri.fsPath, 'webview', 'design.html'),
            path.join(this._extensionUri.fsPath, 'src', 'webview', 'design.html')
        ];

        let htmlContent = '';
        for (const htmlPath of possiblePaths) {
            try {
                if (fs.existsSync(htmlPath)) {
                    htmlContent = fs.readFileSync(htmlPath, 'utf8');
                    break;
                }
            } catch {}
        }

        if (!htmlContent) {
            htmlContent = '<html><body><h1>Design panel HTML not found</h1></body></html>';
        }

        htmlContent = htmlContent.replace(/\{\{NONCE\}\}/g, nonce);
        htmlContent = htmlContent.replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, cspSource);

        const designJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'design.js')
        );
        htmlContent = htmlContent.replace(/\{\{DESIGN_JS_URI\}\}/g, designJsUri.toString());

        const sharedUtilsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedUtils.js')
        );
        htmlContent = htmlContent.replace(/\{\{SHARED_UTILS_URI\}\}/g, sharedUtilsUri.toString());

        const markdownEditorUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'markdownEditor.js')
        );
        htmlContent = htmlContent.replace(/\{\{MARKDOWN_EDITOR_URI\}\}/g, markdownEditorUri.toString());

        const inspectJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'inspect.js')
        );
        const inspectJsPath = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'inspect.js').fsPath;
        if (!fs.existsSync(inspectJsPath)) {
            console.error('[DesignPanelProvider] dist/webview/inspect.js is missing; Inspect buttons will not work.');
        }
        htmlContent = htmlContent.replace(/\{\{INSPECT_JS_URI\}\}/g, inspectJsUri.toString());

        const geistPixelFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'GeistPixel-Square.woff2')
        );
        htmlContent = htmlContent.replace(/\{\{GEIST_PIXEL_FONT_URI\}\}/g, geistPixelFontUri.toString());

        const hankenFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'HankenGrotesk-Variable.woff2')
        );
        htmlContent = htmlContent.replace(/\{\{HANKEN_FONT_URI\}\}/g, hankenFontUri.toString());

        htmlContent = applyThemeBodyClass(htmlContent);
        return htmlContent;
    }

    private _getWorkspaceRoots(): string[] {
        return this._seams().workspace.getWorkspaceRoots();
    }

    private _getLocalFolderService(workspaceRoot: string): LocalFolderService {
        return new LocalFolderService(workspaceRoot);
    }

    private _buildKanbanWorkspaceItems(): Array<{ label: string; workspaceRoot: string }> {
        return buildWorkspaceItems(this._getWorkspaceRoots());
    }

    private _mapLocalFilesToTreeNodes(files: Array<any>): TreeNode[] {
        return files.map(f => ({
            id: f.id,
            name: f.name,
            kind: f.isFolder ? 'folder' : 'document',
            parentId: f.parentId,
            hasChildren: f.isFolder === true,
            title: f.title,
            metadata: {
                ...(f._root ? { root: f._root } : {}),
                ...(f.sourceFolder ? { sourceFolder: f.sourceFolder } : {}),
                ...(f.sourceFolder && f.relativePath ? { absolutePath: path.resolve(f.sourceFolder, f.relativePath) } : {})
            }
        }));
    }

    /**
     * Native fs.watch fallback for folders that sit OUTSIDE any VS Code workspace
     * root. VS Code's `createFileSystemWatcher` (used by `hostSeams.watchFolder`)
     * is officially supported for out-of-workspace paths but is unreliable across
     * platforms — macOS fsevents drops events under load, Linux inotify exhausts
     * `max_user_watches`, Windows ReadDirectoryChangesW fails on trailing-slash
     * drive roots (VS Code Issue #162498). For in-workspace folders the primary
     * `createFileSystemWatcher` handle is reliable, so the native fallback is
     * skipped to avoid double-firing.
     *
     * `fs.watch({ recursive: true })` is only supported on macOS and Windows; on
     * Linux it throws, so we log a warning and skip (parity with the existing
     * `TaskViewerProvider` / `GlobalPlanWatcherService` fallbacks). The existing
     * 300ms debounce in `_autoRefreshHtmlPreview` absorbs fs.watch's macOS
     * double-fire — no separate dedup map is needed here (the TaskViewerProvider
     * 4s TTL map is a cross-watcher suppressor, which is moot here because the
     * native fallback only runs when the VS Code watcher is silent).
     */
    private _setupNativeFolderWatchFallback(
        folderPath: string,
        watchersArray: fs.FSWatcher[],
        onFile: (filePath: string) => void
    ): void {
        const roots = this._getWorkspaceRoots();
        const insideWorkspace = roots.some(r => folderPath === r || folderPath.startsWith(r + path.sep));
        if (insideWorkspace) return;

        if (process.platform === 'linux') {
            console.warn(
                `[DesignPanelProvider] fs.watch recursive fallback unavailable on Linux for '${folderPath}' — out-of-workspace external writes may not refresh`
            );
            return;
        }

        try {
            const watcher = fs.watch(folderPath, { recursive: true }, (_eventType, filename) => {
                if (!filename) return;
                const fullPath = path.join(folderPath, filename.toString());
                try {
                    onFile(fullPath);
                } catch (e) {
                    console.error('[DesignPanelProvider] native folder watch callback failed:', e);
                }
            });
            // fs.watch emits 'error' on folder deletion / fsevents hiccups / ENOSPC.
            // With no listener, Node's EventEmitter default is to throw → uncaught
            // exception in the extension host. Attach a no-op logger to contain it.
            watcher.on('error', (err) => {
                console.error(`[DesignPanelProvider] fs.watch error for '${folderPath}':`, err);
            });
            watchersArray.push(watcher);
        } catch (e) {
            console.error(`[DesignPanelProvider] fs.watch fallback failed for '${folderPath}':`, e);
        }
    }

    private _setupHtmlFolderWatchers(): void {
        this._htmlFolderWatchers.forEach(w => w.dispose());
        this._htmlFolderWatchers = [];
        for (const w of this._htmlFolderNativeWatchers) { try { w.close(); } catch {} }
        this._htmlFolderNativeWatchers = [];
        const roots = this._getWorkspaceRoots();
        for (const root of roots) {
            try {
                const service = this._getLocalFolderService(root);
                const paths = service.getHtmlFolderPaths();
                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        const watcher = this._seams().watcher.watchFolder(p, (event, filePath) => {
                            this._scheduleHtmlDocsReady();
                            if (event !== 'delete') {
                                this._autoRefreshHtmlPreview(filePath);
                            }
                        });
                        this._htmlFolderWatchers.push(watcher);
                        this._setupNativeFolderWatchFallback(p, this._htmlFolderNativeWatchers, (filePath) => {
                            this._scheduleHtmlDocsReady();
                            this._autoRefreshHtmlPreview(filePath);
                        });
                    }
                }
            } catch {}
        }
    }

    private async _setupStitchHtmlFolderWatchers(): Promise<void> {
        this._stitchHtmlFolderWatchers.forEach(w => w.dispose());
        this._stitchHtmlFolderWatchers = [];
        for (const w of this._stitchHtmlFolderNativeWatchers) { try { w.close(); } catch {} }
        this._stitchHtmlFolderNativeWatchers = [];
        const projectId = this._activeStitchHtmlProjectId;
        const workspaceRoot = this._activeStitchHtmlWorkspaceRoot;
        if (!projectId || !workspaceRoot) return;
        try {
            // Resolve the project name first so _getImageCacheDir computes the correct
            // <sanitizedName>-<idSuffix> cache dir. Without this, a name-cache miss would
            // target a phantom "project-<idSuffix>" dir that never receives events.
            await this._resolveStitchProjectName(workspaceRoot, projectId);
            // A concurrent _setupStitchHtmlFolderWatchers call (rapid project switch) may
            // have updated the active project while we were awaiting. Bail before creating
            // a watcher — the newer call owns the array now, and pushing here would orphan
            // this watcher (its callbacks would staleness-bail, but the OS handle leaks).
            if (this._activeStitchHtmlProjectId !== projectId || this._activeStitchHtmlWorkspaceRoot !== workspaceRoot) return;
            const cacheDir = this._getImageCacheDir(workspaceRoot, projectId);
            if (!fs.existsSync(cacheDir)) return;
            const watcher = this._seams().watcher.watchFolder(cacheDir, (event, filePath) => {
                // Bail if the active project changed between watcher creation and fire —
                // a callback from a just-discarded project must not refresh the new view.
                if (this._activeStitchHtmlProjectId !== projectId || this._activeStitchHtmlWorkspaceRoot !== workspaceRoot) return;
                this._scheduleStitchHtmlDocsReady();
                if (event !== 'delete') {
                    this._autoRefreshHtmlPreview(filePath);
                }
            });
            this._stitchHtmlFolderWatchers.push(watcher);
            this._setupNativeFolderWatchFallback(cacheDir, this._stitchHtmlFolderNativeWatchers, (filePath) => {
                // Same race-guard as the primary watcher — a callback from a
                // just-discarded project must not refresh the new view.
                if (this._activeStitchHtmlProjectId !== projectId || this._activeStitchHtmlWorkspaceRoot !== workspaceRoot) return;
                this._scheduleStitchHtmlDocsReady();
                this._autoRefreshHtmlPreview(filePath);
            });
        } catch {}
    }

    private _setupClaudeFolderWatchers(): void {
        this._claudeFolderWatchers.forEach(w => w.dispose());
        this._claudeFolderWatchers = [];
        for (const w of this._claudeFolderNativeWatchers) { try { w.close(); } catch {} }
        this._claudeFolderNativeWatchers = [];
        const roots = this._getWorkspaceRoots();
        for (const root of roots) {
            try {
                const service = this._getLocalFolderService(root);
                const paths = service.getClaudeFolderPaths();
                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        const watcher = this._seams().watcher.watchFolder(p, (event, filePath) => {
                            this._scheduleClaudeDocsReady();
                            // _autoRefreshHtmlPreview already checks _activeClaudePreview, so it
                            // covers Claude-tab auto-refresh too.
                            if (event !== 'delete') {
                                this._autoRefreshHtmlPreview(filePath);
                            }
                        });
                        this._claudeFolderWatchers.push(watcher);
                        this._setupNativeFolderWatchFallback(p, this._claudeFolderNativeWatchers, (filePath) => {
                            this._scheduleClaudeDocsReady();
                            this._autoRefreshHtmlPreview(filePath);
                        });
                    }
                }
            } catch {}
        }
    }

    private _setupDesignFolderWatchers(): void {
        this._designFolderWatchers.forEach(w => w.dispose());
        this._designFolderWatchers = [];
        for (const w of this._designFolderNativeWatchers) { try { w.close(); } catch {} }
        this._designFolderNativeWatchers = [];
        const roots = this._getWorkspaceRoots();
        for (const root of roots) {
            try {
                const service = this._getLocalFolderService(root);
                const paths = service.getDesignFolderPaths();
                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        const watcher = this._seams().watcher.watchFolder(p, (event, filePath) => {
                            this._scheduleDesignDocsReady();
                            // Live preview during agent iteration (#7): re-push the open
                            // design doc when it changes on disk.
                            if (event !== 'delete') {
                                this._autoRefreshHtmlPreview(filePath);
                            }
                        });
                        this._designFolderWatchers.push(watcher);
                        this._setupNativeFolderWatchFallback(p, this._designFolderNativeWatchers, (filePath) => {
                            this._scheduleDesignDocsReady();
                            this._autoRefreshHtmlPreview(filePath);
                        });
                    }
                }
            } catch {}
        }
    }

    /**
     * Debounced watcher entry point — coalesces folder churn (a watched folder fires
     * many times a second on content edits). Fire-and-forget: push only, no payload
     * for a caller. Verb arms must use `_sendHtmlDocsReady` instead, which returns.
     */
    private _scheduleHtmlDocsReady(): void {
        if (this._htmlDocsDebounce) {
            clearTimeout(this._htmlDocsDebounce);
        }
        this._htmlDocsDebounce = setTimeout(() => {
            this._htmlDocsDebounce = undefined;
            void this._sendHtmlDocsReady();
        }, 300);
    }

    /**
     * Build + push + RETURN the HTML doc tree. Verb arms await this so the HTTP
     * response body carries a renderable `htmlDocsReady` payload (return-contract:
     * the browser cockpit has no webview to push to). Deliberately NOT debounced —
     * a `return` inside a setTimeout callback resolves the callback, not this
     * function, so a debounced body always hands the caller `undefined`.
     */
    private async _sendHtmlDocsReady(): Promise<any> {
        if (this._htmlDocsDebounce) {
            clearTimeout(this._htmlDocsDebounce);
            this._htmlDocsDebounce = undefined;
        }
        try {
            const allRoots = this._getWorkspaceRoots();
            const allFiles: any[] = [];
            const seenFilePaths = new Set<string>();
            const configuredFolderPathsByRoot: Record<string, string[]> = {};

            for (const root of allRoots) {
                try {
                    const localFolderService = this._getLocalFolderService(root);
                    const folderPaths = localFolderService.getHtmlFolderPaths();
                    configuredFolderPathsByRoot[root] = folderPaths;

                    const files = await localFolderService.listHtmlFiles();
                    for (const f of files) {
                        const absPath = path.resolve(f.sourceFolder, f.relativePath);
                        if (!seenFilePaths.has(absPath)) {
                            seenFilePaths.add(absPath);
                            allFiles.push({ ...f, _root: root });
                        }
                    }
                } catch {}
            }

            this._updateWebviewRoots();

            const payload = {
                type: 'htmlDocsReady',
                sourceId: 'html-folder',
                folderPathsByRoot: configuredFolderPathsByRoot,
                nodes: this._mapLocalFilesToTreeNodes(allFiles),
                workspaceItems: this._buildKanbanWorkspaceItems()
            };
            this.postMessage(payload);
            return payload;
        } catch (err) {
            const errPayload = {
                type: 'htmlDocsReady',
                sourceId: 'html-folder',
                folderPathsByRoot: {},
                nodes: [],
                workspaceItems: this._buildKanbanWorkspaceItems(),
                error: String(err)
            };
            this.postMessage(errPayload);
            return errPayload;
        }
    }

    /** Progress for THIS project only. A sweep still running on a project the user has
     *  left must not stamp its counter onto the project they are now looking at. */
    private _stitchHtmlBackfillFor(workspaceRoot: string, projectId: string): { done: number; total: number } | undefined {
        const bf = this._stitchHtmlBackfill;
        return (bf && bf.workspaceRoot === workspaceRoot && bf.projectId === projectId)
            ? { done: bf.done, total: bf.total }
            : undefined;
    }

    private async _sendStitchHtmlDocsReady(workspaceRoot: string, projectId: string): Promise<any> {
        // Mirror _sendHtmlDocsReady: an explicit send supersedes a queued debounce, so
        // cancel it rather than letting it fire an identical push 300ms later.
        if (this._stitchHtmlDocsDebounce) {
            clearTimeout(this._stitchHtmlDocsDebounce);
            this._stitchHtmlDocsDebounce = undefined;
        }
        if (!workspaceRoot || !projectId) {
            const empty = { type: 'stitchHtmlDocsReady', docs: [], workspaceRoot };
            this.postMessage(empty);
            return empty;
        }
        try {
            await this._resolveStitchProjectName(workspaceRoot, projectId);
            const cacheDir = this._getImageCacheDir(workspaceRoot, projectId);
            const docs: Array<{ screenId: string; name: string; file: string; sourceFolder: string; absolutePath: string }> = [];
            try {
                const entries = await fs.promises.readdir(cacheDir);
                const db = KanbanDatabase.forWorkspace(workspaceRoot);
                await db.ensureReady();
                // Resolve display names once — one query for the whole project, not
                // one per HTML file.
                let nameById = new Map<string, string>();
                try {
                    const screens = await db.getStitchScreensForProject(projectId);
                    nameById = new Map(screens.map(s => [s.id, s.name] as const));
                } catch {}
                for (const entry of entries) {
                    if (path.extname(entry) !== '.html') continue;
                    const screenId = path.basename(entry, '.html');
                    docs.push({
                        screenId,
                        name: nameById.get(screenId) || screenId,
                        file: entry,
                        sourceFolder: cacheDir,
                        absolutePath: path.join(cacheDir, entry)
                    });
                }
            } catch {}
            const payload = {
                type: 'stitchHtmlDocsReady',
                docs,
                workspaceRoot,
                backfill: this._stitchHtmlBackfillFor(workspaceRoot, projectId)
            };
            this.postMessage(payload);
            return payload;
        } catch {
            const errPayload = {
                type: 'stitchHtmlDocsReady',
                docs: [],
                workspaceRoot,
                backfill: this._stitchHtmlBackfillFor(workspaceRoot, projectId)
            };
            this.postMessage(errPayload);
            return errPayload;
        }
    }

    /** Debounced watcher entry point — see _scheduleHtmlDocsReady. */
    private _scheduleClaudeDocsReady(): void {
        if (this._claudeDocsDebounce) {
            clearTimeout(this._claudeDocsDebounce);
        }
        this._claudeDocsDebounce = setTimeout(() => {
            this._claudeDocsDebounce = undefined;
            void this._sendClaudeDocsReady();
        }, 300);
    }

    /** Build + push + RETURN the Claude doc tree — see _sendHtmlDocsReady. */
    private async _sendClaudeDocsReady(): Promise<any> {
        if (this._claudeDocsDebounce) {
            clearTimeout(this._claudeDocsDebounce);
            this._claudeDocsDebounce = undefined;
        }
        try {
            const allRoots = this._getWorkspaceRoots();
            const allFiles: any[] = [];
            const seenFilePaths = new Set<string>();
            const configuredFolderPathsByRoot: Record<string, string[]> = {};

            for (const root of allRoots) {
                try {
                    const localFolderService = this._getLocalFolderService(root);
                    const folderPaths = localFolderService.getClaudeFolderPaths();
                    configuredFolderPathsByRoot[root] = folderPaths;

                    const files = await localFolderService.listClaudeFiles();
                    for (const f of files) {
                        const absPath = path.resolve(f.sourceFolder, f.relativePath);
                        if (!seenFilePaths.has(absPath)) {
                            seenFilePaths.add(absPath);
                            allFiles.push({ ...f, _root: root });
                        }
                    }
                } catch {}
            }

            this._updateWebviewRoots();

            const payload = {
                type: 'claudeDocsReady',
                sourceId: 'claude-folder',
                folderPathsByRoot: configuredFolderPathsByRoot,
                nodes: this._mapLocalFilesToTreeNodes(allFiles),
                workspaceItems: this._buildKanbanWorkspaceItems()
            };
            this.postMessage(payload);
            return payload;
        } catch (err) {
            const errPayload = {
                type: 'claudeDocsReady',
                sourceId: 'claude-folder',
                folderPathsByRoot: {},
                nodes: [],
                workspaceItems: this._buildKanbanWorkspaceItems(),
                error: String(err)
            };
            this.postMessage(errPayload);
            return errPayload;
        }
    }

    /** Debounced watcher entry point — see _scheduleHtmlDocsReady. */
    private _scheduleDesignDocsReady(): void {
        if (this._designDocsDebounce) {
            clearTimeout(this._designDocsDebounce);
        }
        this._designDocsDebounce = setTimeout(() => {
            this._designDocsDebounce = undefined;
            void this._sendDesignDocsReady();
        }, 300);
    }

    /** Build + push + RETURN the Design doc tree — see _sendHtmlDocsReady. */
    private async _sendDesignDocsReady(): Promise<any> {
        if (this._designDocsDebounce) {
            clearTimeout(this._designDocsDebounce);
            this._designDocsDebounce = undefined;
        }
        try {
            const allRoots = this._getWorkspaceRoots();
            const allFiles: any[] = [];
            const seenFilePaths = new Set<string>();
            const configuredFolderPathsByRoot: Record<string, string[]> = {};

            for (const root of allRoots) {
                try {
                    const localFolderService = this._getLocalFolderService(root);
                    const folderPaths = localFolderService.getDesignFolderPaths();
                    configuredFolderPathsByRoot[root] = folderPaths;

                    const files = await localFolderService.listDesignFiles();
                    for (const f of files) {
                        const absPath = path.resolve(f.sourceFolder, f.relativePath);
                        if (!seenFilePaths.has(absPath)) {
                            seenFilePaths.add(absPath);
                            allFiles.push({ ...f, _root: root });
                        }
                    }
                } catch {}
            }

            this._updateWebviewRoots();

            const payload = {
                type: 'designDocsReady',
                sourceId: 'design-folder',
                folderPathsByRoot: configuredFolderPathsByRoot,
                nodes: this._mapLocalFilesToTreeNodes(allFiles),
                workspaceItems: this._buildKanbanWorkspaceItems()
            };
            this.postMessage(payload);
            return payload;
        } catch (err) {
            const errPayload = {
                type: 'designDocsReady',
                sourceId: 'design-folder',
                folderPathsByRoot: {},
                nodes: [],
                workspaceItems: this._buildKanbanWorkspaceItems(),
                error: String(err)
            };
            this.postMessage(errPayload);
            return errPayload;
        }
    }

    private _setupImagesFolderWatchers(): void {
        this._imagesFolderWatchers.forEach(w => w.dispose());
        this._imagesFolderWatchers = [];
        const roots = this._getWorkspaceRoots();
        for (const root of roots) {
            try {
                const service = this._getLocalFolderService(root);
                const paths = service.getImagesFolderPaths();
                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        const watcher = this._seams().watcher.watchFolder(p, () => this._scheduleImagesDocsReady());
                        this._imagesFolderWatchers.push(watcher);
                    }
                }
            } catch {}
        }
    }

    /** Debounced watcher entry point — see _scheduleHtmlDocsReady. */
    private _scheduleImagesDocsReady(): void {
        if (this._imagesDocsDebounce) {
            clearTimeout(this._imagesDocsDebounce);
        }
        this._imagesDocsDebounce = setTimeout(() => {
            this._imagesDocsDebounce = undefined;
            void this._sendImagesDocsReady();
        }, 300);
    }

    /** Build + push + RETURN the Images doc tree — see _sendHtmlDocsReady. */
    private async _sendImagesDocsReady(): Promise<any> {
        if (this._imagesDocsDebounce) {
            clearTimeout(this._imagesDocsDebounce);
            this._imagesDocsDebounce = undefined;
        }
        {
            try {
                const allRoots = this._getWorkspaceRoots();
                const allFiles: any[] = [];
                const seenFilePaths = new Set<string>();
                const configuredFolderPathsByRoot: Record<string, string[]> = {};

                for (const root of allRoots) {
                    try {
                        const localFolderService = this._getLocalFolderService(root);
                        const folderPaths = localFolderService.getImagesFolderPaths();
                        configuredFolderPathsByRoot[root] = folderPaths;

                        const files = await localFolderService.listImagesFiles();
                        for (const f of files) {
                            const absPath = path.resolve(f.sourceFolder, f.relativePath);
                            if (!seenFilePaths.has(absPath)) {
                                seenFilePaths.add(absPath);
                                allFiles.push({ ...f, _root: root });
                            }
                        }
                    } catch {}
                }

                this._updateWebviewRoots();

                const payload = {
                    type: 'imagesDocsReady',
                    sourceId: 'images-folder',
                    folderPathsByRoot: configuredFolderPathsByRoot,
                    nodes: this._mapLocalFilesToTreeNodes(allFiles),
                    workspaceItems: this._buildKanbanWorkspaceItems()
                };
                this.postMessage(payload);
                return payload;
            } catch (err) {
                const errPayload = {
                    type: 'imagesDocsReady',
                    sourceId: 'images-folder',
                    folderPathsByRoot: {},
                    nodes: [],
                    workspaceItems: this._buildKanbanWorkspaceItems(),
                    error: String(err)
                };
                this.postMessage(errPayload);
                return errPayload;
            }
        }
    }

    private _updateWebviewRoots(): void {
        if (!this._panel) return;
        const allRoots = this._getWorkspaceRoots();
        const folderUris: vscode.Uri[] = [];
        for (const r of allRoots) {
            try {
                const service = this._getLocalFolderService(r);
                for (const p of service.getDesignFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
                for (const p of service.getHtmlFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
                for (const p of service.getFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
                for (const p of service.getImagesFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
                for (const p of service.getStitchFolderPaths()) {
                    folderUris.push(vscode.Uri.file(p));
                }
                // Include the Stitch assets directory (where screen PNGs live) in resource roots
                try {
                    folderUris.push(vscode.Uri.file(this._getImageCacheDir(r)));
                } catch {}
            } catch {}
        }

        const rawRoots = [
            vscode.Uri.joinPath(this._extensionUri, 'dist'),
            vscode.Uri.joinPath(this._extensionUri, 'webview'),
            vscode.Uri.joinPath(this._extensionUri, 'designs'),
            vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
            ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri),
            ...folderUris
        ];

        // Deduplicate by stringified URI — prevents spurious signature changes when
        // the same path is pushed by multiple sources (e.g. getHtmlFolderPaths + _getImageCacheDir).
        const seenRoots = new Set<string>();
        const localResourceRoots = rawRoots.filter(u => {
            const key = u.toString();
            if (seenRoots.has(key)) return false;
            seenRoots.add(key);
            return true;
        });

        const signature = JSON.stringify(localResourceRoots.map(u => u.toString()));
        if (signature === this._lastWebviewRootsSignature) return;
        this._lastWebviewRootsSignature = signature;

        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots
        };
    }

    private _getStitchOutputDir(workspaceRoot: string): string {
        const configured = this._getLocalFolderService(workspaceRoot).getStitchFolderPath() || '.stitch';
        return path.resolve(workspaceRoot, configured);
    }

    private _getImageCacheDir(workspaceRoot: string, projectId?: string): string {
        const root = path.join(workspaceRoot, '.switchboard', 'stitch');
        if (!projectId) return root;
        const folderName = this._sanitizeProjectFolderName(
            this._stitchProjectNames.get(projectId) || '',
            projectId
        );
        return path.join(root, folderName);
    }

    private _sanitizeProjectFolderName(name: string, id: string): string {
        const sanitized = (name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const idSuffix = id.length > 8 ? id.slice(0, 8) : id;
        return sanitized ? `${sanitized}-${idSuffix}` : `project-${idSuffix}`;
    }

    private async _resolveStitchProjectName(workspaceRoot: string, projectId: string): Promise<string> {
        const cached = this._stitchProjectNames.get(projectId);
        if (cached) return cached;
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            const name = await db.getStitchProjectName(projectId);
            if (name) {
                this._stitchProjectNames.set(projectId, name);
                return name;
            }
        } catch {}
        return '';
    }

    private async _migrateStitchCacheToProjectFolders(workspaceRoot: string): Promise<void> {
        if (this._stitchCacheMigrated.has(workspaceRoot)) return;
        this._stitchCacheMigrated.add(workspaceRoot);
        const stitchRoot = this._getImageCacheDir(workspaceRoot);
        let entries: string[];
        try {
            entries = await fs.promises.readdir(stitchRoot);
        } catch { return; }
        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        for (const entry of entries) {
            const ext = path.extname(entry);
            if (ext !== '.png' && ext !== '.html') continue;
            const screenBasename = path.basename(entry, ext);
            const projectId = await db.getStitchScreenProjectId(screenBasename);
            if (!projectId) continue;
            const projectName = await this._resolveStitchProjectName(workspaceRoot, projectId);
            this._stitchProjectNames.set(projectId, projectName);
            const projectDir = this._getImageCacheDir(workspaceRoot, projectId);
            const srcPath = path.join(stitchRoot, entry);
            const dstPath = path.join(projectDir, entry);
            try {
                await fs.promises.mkdir(projectDir, { recursive: true });
                await fs.promises.rename(srcPath, dstPath);
            } catch (err) {
                console.error(`[Stitch migration] Failed to move ${entry}:`, err);
            }
        }
    }

    private async _formatScreenFromCache(cached: {
        id: string; projectId: string; name: string;
        deviceType: string; status: string; statusMessage: string;
        summary?: string; suggestionsJson?: string;
    }, workspaceRoot: string): Promise<any> {
        const screenId = path.basename(cached.id);
        const projectDir = this._getImageCacheDir(workspaceRoot, cached.projectId);
        const filePath = path.join(projectDir, `${screenId}.png`);
        let imageUrl = '';
        let imagePath = '';
        try {
            await fs.promises.stat(filePath);
            const projectFolder = path.basename(projectDir);
            const relative = `/static/stitch/${encodeURIComponent(projectFolder)}/${encodeURIComponent(screenId)}.png`;
            imageUrl = this._absoluteApiUrl(relative)
                ?? (this._panel ? this._panel.webview.asWebviewUri(vscode.Uri.file(filePath)).toString() : relative);
            imagePath = filePath;
        } catch {}
        let suggestions: Array<{ label: string; prompt: string }> = [];
        if (cached.suggestionsJson) {
            try {
                const parsed = JSON.parse(cached.suggestionsJson);
                if (Array.isArray(parsed)) suggestions = parsed;
            } catch { /* stale/corrupt JSON — treat as no suggestions */ }
        }
        return {
            id: cached.id,
            projectId: cached.projectId,
            name: cached.name,
            deviceType: cached.deviceType,
            imageUrl,
            imagePath,
            htmlUrl: '',
            htmlPath: await this._getStitchHtmlPath(cached.id, workspaceRoot, cached.projectId),
            status: cached.status,
            statusMessage: cached.statusMessage,
            summary: cached.summary || '',
            suggestions
        };
    }

    private async _fetchWithTimeout(url: string, timeoutMs: number = 30000): Promise<Response> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            return response;
        } catch (err: any) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
                throw new Error(`Request timed out after ${timeoutMs}ms`);
            }
            throw err;
        }
    }

    // Returns the on-disk path of a screen's downloaded HTML, or '' if it hasn't been
    // downloaded yet. HTML (unlike the PNG) is fetched on demand, not auto-cached.
    private async _getStitchHtmlPath(screenId: string, workspaceRoot: string, projectId?: string): Promise<string> {
        if (!workspaceRoot) return '';
        const htmlPath = path.join(this._getImageCacheDir(workspaceRoot, projectId), `${path.basename(screenId)}.html`);
        try {
            await fs.promises.stat(htmlPath);
            return htmlPath;
        } catch {
            return '';
        }
    }

    private async _getCachedImageUri(screen: any, workspaceRoot: string): Promise<string> {
        // On-disk PNG wins: it's instant, and — with the API no longer reporting render
        // status — the last good render beats a blank card whenever the backend
        // temporarily serves no screenshot URL for a screen.
        const cacheDir = workspaceRoot ? this._getImageCacheDir(workspaceRoot, screen.projectId) : '';
        const filePath = cacheDir
            ? path.join(cacheDir, `${path.basename(screen.id)}.png`)
            : undefined;
        if (filePath) {
            try {
                await fs.promises.stat(filePath);
                const projectFolder = path.basename(cacheDir);
                const screenId = path.basename(screen.id);
                const relative = `/static/stitch/${encodeURIComponent(projectFolder)}/${encodeURIComponent(screenId)}.png`;
                const absolute = this._absoluteApiUrl(relative);
                if (absolute) { return absolute; }
                if (this._panel) {
                    const uri = this._panel.webview.asWebviewUri(vscode.Uri.file(filePath)).toString();
                    if (uri) return uri;
                } else {
                    return relative;
                }
            } catch { /* not cached yet */ }
        }

        let cdnUrl: string;
        try {
            cdnUrl = await screen.getImage() || '';
        } catch {
            cdnUrl = '';
        }
        if (!cdnUrl) return '';

        // Apply hi-res transform for immediate display (same as makeFifeHighResUrl in webview)
        const hiResUrl = (cdnUrl.includes('/fife/') || cdnUrl.includes('lh3.googleusercontent.com')) && !cdnUrl.includes('?')
            ? cdnUrl.replace(/=[wsh]\d+(?:-[wsh]\d+)?$/, '') + '=w1200'
            : cdnUrl;

        if (!filePath || !cacheDir) return hiResUrl;

        // Not cached yet — download in background, return CDN URL immediately so the
        // gallery renders now without waiting for the download to finish
        this._downloadToCache(hiResUrl, cacheDir, filePath).catch(err =>
            console.error('Stitch image cache download failed:', err)
        );

        return hiResUrl;
    }

    // Dedupes concurrent downloads of the same target — repeated _formatScreen calls
    // (polls, phase-3 refreshes) fire cache downloads before the first one lands.
    // Maps target path → in-flight promise so concurrent requests JOIN the same
    // download (callers that need the file on disk can await it) instead of
    // double-downloading or returning before the first write lands.
    private _cacheDownloadsInFlight = new Map<string, Promise<void>>();

    private _downloadToCache(url: string, cacheDir: string, filePath: string): Promise<void> {
        const key = filePath;
        const existing = this._cacheDownloadsInFlight.get(key);
        if (existing) return existing;
        const download = (async () => {
            await fs.promises.mkdir(cacheDir, { recursive: true });
            const res = await this._fetchWithTimeout(url, 60000);
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            const buffer = Buffer.from(await res.arrayBuffer());
            await fs.promises.writeFile(filePath, buffer);
        })();
        this._cacheDownloadsInFlight.set(key, download.finally(() => this._cacheDownloadsInFlight.delete(key)));
        return this._cacheDownloadsInFlight.get(key)!;
    }

    private _stitchHtmlDocsDebounce?: ReturnType<typeof setTimeout>;

    /** Debounced watcher entry point — see _scheduleHtmlDocsReady. */
    private _scheduleStitchHtmlDocsReady(): void {
        if (this._stitchHtmlDocsDebounce) {
            clearTimeout(this._stitchHtmlDocsDebounce);
        }
        this._stitchHtmlDocsDebounce = setTimeout(() => {
            this._stitchHtmlDocsDebounce = undefined;
            const root = this._activeStitchHtmlWorkspaceRoot;
            const projectId = this._activeStitchHtmlProjectId;
            if (root && projectId) void this._sendStitchHtmlDocsReady(root, projectId);
        }, 300);
    }

    /** Live sweep progress, TAGGED with the project it belongs to. The tag is load-
     *  bearing: `_scheduleStitchHtmlDocsReady` resolves its project at fire time, so an
     *  untagged object rides whatever project is active then — announcing "Caching
     *  HTML… 8/13" in a project where nothing is being cached. */
    private _stitchHtmlBackfill?: { done: number; total: number; workspaceRoot: string; projectId: string };
    /** Sweeps in flight, keyed `${root}::${projectId}`. `stitchHtmlListDocs` is posted
     *  from four frontend paths (project select, Open in HTML Tab, every STITCH project
     *  load, every screen edit) and the sweep runs for tens of seconds to minutes — so
     *  re-entry is the normal case, not an edge one. Without this guard a second sweep
     *  duplicates every `getScreen` + `getHtml` round trip (`_downloadToCache` dedupes
     *  only the download) and clobbers the single progress object. */
    private _stitchHtmlBackfillsInFlight = new Set<string>();

    private async _backfillStitchHtmlForProject(workspaceRoot: string, projectId: string): Promise<void> {
        const inFlightKey = `${workspaceRoot}::${projectId}`;
        if (this._stitchHtmlBackfillsInFlight.has(inFlightKey)) return;
        this._stitchHtmlBackfillsInFlight.add(inFlightKey);
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            const rows = await db.getStitchScreensForProject(projectId);
            const missing: any[] = [];
            for (const row of rows) {
                if (await this._getStitchHtmlPath(row.id, workspaceRoot, projectId)) continue;
                missing.push(row);
            }
            if (missing.length === 0) return;

            this._stitchHtmlBackfill = { done: 0, total: missing.length, workspaceRoot, projectId };
            this._scheduleStitchHtmlDocsReady();
            try {
                const stitch = await loadStitch('');
                const CONCURRENCY = 4;
                const screens: any[] = [];
                for (let i = 0; i < missing.length; i += CONCURRENCY) {
                    const batch = missing.slice(i, i + CONCURRENCY);
                    const resolved = await Promise.all(batch.map(async (row) => {
                        const cached = this._activeScreens.get(row.id);
                        if (cached) return cached;
                        try {
                            const screen = await stitch.project(projectId).getScreen(row.id);
                            this._activeScreens.set(row.id, screen);
                            return screen;
                        } catch (err) {
                            console.error(`[DesignPanel] getScreen failed for ${row.id}:`, err);
                            return null;
                        }
                    }));
                    screens.push(...resolved.filter(Boolean));
                    if (projectId !== this._activeStitchHtmlProjectId
                        || workspaceRoot !== this._activeStitchHtmlWorkspaceRoot) return;
                }
                if (screens.length === 0) return;

                await this._backfillStitchHtmlCache(screens, workspaceRoot, () => {
                    if (this._stitchHtmlBackfill) this._stitchHtmlBackfill.done++;
                    this._scheduleStitchHtmlDocsReady();
                });
            } finally {
                // Only clear progress that is still OURS — a sweep for another project
                // may have replaced it while we were downloading.
                if (this._stitchHtmlBackfill?.projectId === projectId
                    && this._stitchHtmlBackfill?.workspaceRoot === workspaceRoot) {
                    this._stitchHtmlBackfill = undefined;
                }
                // Final unconditional send so the last file can never be lost to a
                // trailing debounce, and the progress line always clears. Skip it if the
                // user has since switched project/root — the frontend does not filter.
                if (projectId === this._activeStitchHtmlProjectId && workspaceRoot === this._activeStitchHtmlWorkspaceRoot) {
                    void this._sendStitchHtmlDocsReady(workspaceRoot, projectId);
                }
            }
        } finally {
            this._stitchHtmlBackfillsInFlight.delete(inFlightKey);
        }
    }

    /**
     * Eagerly cache every screen's HTML next to its PNG (same `.switchboard/stitch/`
     * dir, `<id>.html`). The HTML is tiny (~15KB) but its download URL is a signed
     * temp link — without this, the design code is lost once the link expires unless
     * the user manually clicked DL HTML. Also makes the live-HTML preview and "Open
     * in Browser" instant. Fire-and-forget; never touches the webview.
     */
    private async _backfillStitchHtmlCache(screens: any[], workspaceRoot: string, onCached?: () => void): Promise<void> {
        if (!workspaceRoot) return;
        for (const screen of screens) {
            try {
                if (!screen?.id) continue;
                if (await this._getStitchHtmlPath(screen.id, workspaceRoot, screen.projectId)) continue; // already cached
                let htmlUrl = '';
                try { htmlUrl = (await screen.getHtml()) || ''; } catch { htmlUrl = ''; }
                if (!htmlUrl) continue; // image-space screens have no HTML at all
                const cacheDir = this._getImageCacheDir(workspaceRoot, screen.projectId);
                // Sequential on purpose — this is a background sweep, not a hot path.
                await this._downloadToCache(htmlUrl, cacheDir,
                    path.join(cacheDir, `${path.basename(screen.id)}.html`));
                onCached?.();
            } catch (err) {
                console.error(`Stitch HTML cache backfill failed for screen ${screen?.id}:`, err);
            }
        }
    }

    private async _formatScreen(screen: any, workspaceRoot: string): Promise<any> {
        const imageUrl = await this._getCachedImageUri(screen, workspaceRoot);
        let imagePath = '';
        if (workspaceRoot) {
            const candidate = path.join(this._getImageCacheDir(workspaceRoot, screen.projectId), `${path.basename(screen.id)}.png`);
            try {
                await fs.promises.stat(candidate);
                imagePath = candidate;
            } catch {}
        }
        // Image-space screens have no HTML at all (htmlCode: {}), and getHtml() falls
        // back to a get_screen API call — never let that failure sink the whole batch.
        let htmlUrl = '';
        try { htmlUrl = (await screen.getHtml()) || ''; } catch { htmlUrl = ''; }
        const htmlPath = await this._getStitchHtmlPath(screen.id, workspaceRoot, screen.projectId);
        if (!htmlPath && htmlUrl && workspaceRoot) {
            // Eager-cache the HTML like the PNG: download in background, don't block
            // the format. The signed URL expires, so grab it while we have it.
            const cacheDir = this._getImageCacheDir(workspaceRoot, screen.projectId);
            this._downloadToCache(htmlUrl, cacheDir,
                path.join(cacheDir, `${path.basename(screen.id)}.html`)
            ).catch(err => console.error('Stitch HTML cache download failed:', err));
        }
        return {
            id: screen.id,
            projectId: screen.projectId,
            name: screen.data?.title || screen.data?.displayName || screen.id,
            deviceType: screen.data?.deviceType,
            imageUrl,
            imagePath,
            htmlUrl,
            htmlPath,
            status: screen.data?.screenMetadata?.status || null,
            statusMessage: screen.data?.screenMetadata?.statusMessage || null,
            // The AI's text response about the screen + suggested follow-up prompts —
            // same metadata object the Stitch website renders alongside each generation.
            ...this._screenAiMeta(screen.data)
        };
    }

    // screenMetadata.summary / .suggestions normalization shared by _formatScreen and
    // the DB upsert sites. Suggestions are {label, prompt} pairs; either field may be
    // missing on the wire, so each backfills from the other.
    private _screenAiMeta(data: any): { summary: string; suggestions: Array<{ label: string; prompt: string }> } {
        const md = data?.screenMetadata;
        const suggestions = Array.isArray(md?.suggestions)
            ? md.suggestions
                .filter((s: any) => s && (s.prompt || s.label))
                .map((s: any) => ({ label: s.label || s.prompt, prompt: s.prompt || s.label }))
            : [];
        return { summary: md?.summary || '', suggestions };
    }

    private _screenAiMetaForDb(data: any): { summary: string; suggestionsJson: string } {
        const meta = this._screenAiMeta(data);
        return {
            summary: meta.summary,
            suggestionsJson: meta.suggestions.length ? JSON.stringify(meta.suggestions) : ''
        };
    }

    // The SDK's generate()/edit()/variants() wrappers keep only design.screens from the
    // tool response and silently drop the model's text commentary and follow-up
    // suggestions (verified live 2026-07-12: outputComponents = [designSystem?, design,
    // text, suggestion…] — the same content the Stitch website shows beside a
    // generation). Call the tool raw to recover all three.
    private async _screenToolCall(toolName: string, args: any, projectId: string): Promise<{
        screens: any[]; summary: string; suggestions: Array<{ label: string; prompt: string }>;
    }> {
        const mod: any = await import('@google/stitch-sdk');
        const client = await loadStitchRawClient();
        const raw = await client.callTool(toolName, args);
        const comps: any[] = raw?.outputComponents ?? [];
        const screens = comps
            .flatMap((c: any) => c?.design?.screens || [])
            .map((d: any) => new mod.Screen(client, { ...d, projectId }));
        const summary = comps.map((c: any) => c?.text).filter(Boolean).join('\n\n').trim();
        const suggestions = comps
            .map((c: any) => (typeof c?.suggestion === 'string' ? c.suggestion.trim() : ''))
            .filter(Boolean)
            .map((s: string) => ({ label: s, prompt: s }));
        return { screens, summary, suggestions };
    }

    // Persist generate/edit-time commentary so it survives reloads (list responses
    // never carry it), and stamp it onto the outgoing formatted screen.
    private async _attachScreenCommentary(
        formatted: any, projectId: string, workspaceRoot: string,
        summary: string, suggestions: Array<{ label: string; prompt: string }>
    ): Promise<void> {
        if (summary) formatted.summary = summary;
        if (suggestions.length) formatted.suggestions = suggestions;
        if (!workspaceRoot || (!summary && !suggestions.length)) return;
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            await db.upsertStitchScreen({
                id: formatted.id,
                projectId,
                name: formatted.name,
                deviceType: formatted.deviceType ?? null,
                status: formatted.status ?? null,
                statusMessage: formatted.statusMessage ?? null,
                summary,
                suggestionsJson: suggestions.length ? JSON.stringify(suggestions) : ''
            });
        } catch (e) {
            console.error('Failed to persist Stitch screen commentary:', e);
        }
    }

    // Distinguishes generated screens from reference uploads in project.screens() output.
    // The Stitch backend has shipped two asset shapes:
    //   • legacy (≤ June 2026): generated screens carry deviceType AND a screenMetadata
    //     object (status/summary); uploads may have one but never both.
    //   • current (July 2026+): screenMetadata is GONE. Screens carry screenshot/htmlCode
    //     {downloadUrl} objects and USUALLY deviceType — but not always (verified live:
    //     a generated screen arrived with no deviceType and an empty htmlCode). Uploads
    //     have screenshot/htmlCode too but never deviceType, and keep their original
    //     filename as the title.
    // Requiring screenMetadata filtered EVERY screen of a new project into an empty
    // gallery ("0 screens loaded"); requiring deviceType still dropped real screens.
    private _isGeneratedScreenAsset(s: any): boolean {
        const d = s?.data;
        if (!d) return false;
        // deviceType marks a generated screen in both shapes — keep it even with no
        // download URLs yet (still rendering server-side; shows placeholder + polls).
        if (d.deviceType) return true;
        if (d.screenMetadata !== undefined && d.screenMetadata !== null) return false; // legacy upload
        // No deviceType, current shape: keep renderable assets unless the title is a
        // filename (reference upload).
        const hasRenderable = !!(d.screenshot?.downloadUrl || d.htmlCode?.downloadUrl);
        if (!hasRenderable) return false;
        return !/\.(png|jpe?g|gif|webp|svg|pdf|mdx?|html?|txt)\s*$/i.test(String(d.title || ''));
    }

    private async _setupStitchAuth(): Promise<{ valid: boolean; apiKey: string }> {
        const apiKey = (await this._seams().secrets.get('switchboard.stitch.apiKey')) || '';
        const finalKey = apiKey || process.env.STITCH_API_KEY || '';
        if (finalKey) {
            process.env.STITCH_API_KEY = finalKey;
            return { valid: true, apiKey: finalKey };
        }
        return { valid: false, apiKey: finalKey };
    }

    // The kanban "Project PRD Reference" planner add-on (roleConfig_planner.addons.designSystemDoc)
    // gates whether planner.designSystemDocLink is injected into agent prompts. Setting/unsetting
    // the active design doc here must flip that add-on so the kanban checkbox stays in sync.
    private async _setPlannerDesignSystemAddon(enabled: boolean): Promise<void> {
        if (!this._taskViewerProvider) return;
        const key = 'roleConfig_planner';
        const existing = (this._taskViewerProvider.getRoleConfig(key) as any) || {};
        const updated = {
            ...existing,
            addons: { ...(existing.addons || {}), designSystemDoc: enabled }
        };
        await this._taskViewerProvider.saveRoleConfig(key, updated);
    }

    private _getDesignSystemDocName(): string | null {
        const pathConfig = this._seams().pathConfig;
        const designSystemDocLink = pathConfig.getConfigString('planner.designSystemDocLink');
        if (!designSystemDocLink) return null;
        return path.basename(designSystemDocLink, '.md');
    }

    private async _sendActiveDesignDocState(): Promise<void> {
        const pathConfig = this._seams().pathConfig;
        const dsEnabled = pathConfig.getConfigBoolean('planner.designSystemDocEnabled', false);
        const dsDocName = dsEnabled ? this._getDesignSystemDocName() : null;
        this.postMessage({
            type: 'activeDesignDocUpdated',
            designSystemDoc: {
                enabled: dsEnabled,
                docName: dsDocName || 'None',
                sourceId: this._activeDesignSystemDocSourceId,
                docId: this._activeDesignSystemDocId
            }
        });
    }

    // Resolve a `${folderIndex}:${relativePath}` tree-node id against a configured
    // design folder, returning the absolute path or null if unreadable/unconfigured.
    private async _resolveDesignDocPath(sourceFolder: string | undefined, docId: string): Promise<string | null> {
        if (!sourceFolder) return null;
        const resolvedFolder = path.resolve(sourceFolder);
        let isConfigured = false;
        for (const root of this._getWorkspaceRoots()) {
            try {
                const svc = this._getLocalFolderService(root);
                if (svc.getDesignFolderPaths().some(p => path.resolve(p) === resolvedFolder)) {
                    isConfigured = true;
                    break;
                }
            } catch {}
        }
        if (!isConfigured) return null;
        const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
        const docPath = path.resolve(resolvedFolder, cleanDocId);
        if (docPath !== resolvedFolder && !docPath.startsWith(resolvedFolder + path.sep)) return null;
        try {
            await fs.promises.access(docPath, fs.constants.R_OK);
            return docPath;
        } catch {
            return null;
        }
    }

    /**
     * The board's active project filter, used to prefer the project-bound design
     * system when copying a prompt without an explicit project. Read-only — the
     * board owns this config key.
     */
    private async _getActiveBoardProject(workspaceRoot: string): Promise<string | undefined> {
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            const filter = await db.getConfig('kanban.activeProjectFilter');
            if (filter && filter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
                return filter;
            }
        } catch {}
        return undefined;
    }

    // ── Localhost HTML preview server (ported from the planning panel) ──
    // srcdoc iframes inherit the webview's CSP and break relative asset paths;
    // serving from 127.0.0.1 gives previews a real origin (CSP frame-src allows http:).

    private async _getOrCreateHtmlServer(sourceFolder: string): Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }> {
        const existing = this._htmlServers.get(sourceFolder);
        if (existing) {
            clearTimeout(existing.timeoutId);
            existing.timeoutId = this._createServerTimeout(sourceFolder);
            return existing;
        }
        const pendingPromise = this._htmlServerCreationPromises.get(sourceFolder);
        if (pendingPromise) {
            return pendingPromise;
        }
        const creationPromise = this._createHtmlServer(sourceFolder);
        this._htmlServerCreationPromises.set(sourceFolder, creationPromise);
        try {
            return await creationPromise;
        } finally {
            this._htmlServerCreationPromises.delete(sourceFolder);
        }
    }

    private _createHtmlServer(sourceFolder: string): Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }> {
        const server = http.createServer((req, res) => {
            this._handleHtmlServerRequest(req, res, sourceFolder);
        });
        return new Promise((resolve, reject) => {
            server.listen(0, '127.0.0.1', () => {
                const address = server.address() as { port: number };
                const timeoutId = this._createServerTimeout(sourceFolder);
                const entry = { server, port: address.port, timeoutId };
                this._htmlServers.set(sourceFolder, entry);
                resolve(entry);
            });
            server.on('error', (err: any) => reject(err));
        });
    }

    private _buildLocalhostUrl(serverEntry: { port: number }, sourceFolder: string, filePath: string): string {
        const relativeUrlPath = path.relative(sourceFolder, filePath);
        const urlPath = relativeUrlPath.split(path.sep).map(encodeURIComponent).join('/');
        return `http://127.0.0.1:${serverEntry.port}/${urlPath}`;
    }

    private _handleHtmlServerRequest(req: http.IncomingMessage, res: http.ServerResponse, sourceFolder: string): void {
        const parsedUrl = new URL(req.url || '/', `http://127.0.0.1`);
        const requestedPath = decodeURIComponent(parsedUrl.pathname);

        if (requestedPath === '/' || requestedPath === '') {
            res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('Forbidden: directory listing not available');
            return;
        }

        const resolvedPath = path.resolve(sourceFolder, requestedPath.substring(1));
        const normalizedSource = path.normalize(sourceFolder).replace(/[\\/]+$/, '');
        const normalizedResolved = path.normalize(resolvedPath);

        if (!normalizedResolved.startsWith(normalizedSource + path.sep) && normalizedResolved !== normalizedSource) {
            res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('Forbidden: path traversal denied');
            return;
        }

        // Deny-list only the components BELOW the served folder. The traversal check
        // above already contains the request inside sourceFolder, and sourceFolder is
        // always extension-chosen — checking the absolute path instead 403'd every
        // server legitimately rooted under a dot-folder (the Stitch cache lives in
        // .switchboard/stitch, so all its HTML came back "Forbidden: access denied").
        const pathParts = path.relative(normalizedSource, normalizedResolved).split(path.sep);
        for (const part of pathParts) {
            if (this._SERVER_DENY_LIST.some(denied => part === denied || part.startsWith(denied))) {
                res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
                res.end('Forbidden: access denied');
                return;
            }
        }

        fs.readFile(resolvedPath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
                res.end('Not Found');
                return;
            }
            const mimeType = this._getMimeType(resolvedPath);
            // For HTML files, inject:
            // 1. A script that intercepts Node.prototype.appendChild/insertBefore
            //    to rewrite Babel-compiled output. Recent @babel/standalone
            //    defaults to preset-react runtime:'automatic', which generates
            //    `import { jsx } from "react/jsx-runtime"` in compiled output.
            //    Babel creates a <script> element with that code and appends it
            //    to the DOM — the browser parses the script during appendChild
            //    and rejects the import statement ("Cannot use import statement
            //    outside a module"). The intercept rewrites the import to use
            //    the already-loaded React global before the script is inserted.
            // 2. A diagnostic script that captures load errors and reports
            //    them back to the parent webview via postMessage.
            if (mimeType.startsWith('text/html')) {
                let html = data.toString('utf8');
                const babelPatch = `<script>(function(){
'use strict';
// Babel standalone compiles <script type="text/babel"> blocks and injects
// the compiled code as a new <script> element. Recent @babel/standalone
// defaults to preset-react runtime:'automatic', which generates
//   import { jsx as _jsx } from "react/jsx-runtime";
// at the top of the compiled output. The browser rejects this because
// the script is not type="module". We intercept ALL DOM insertion methods
// and rewrite the import into var declarations using the React global.
function rewriteScriptContent(el){
if(!el||!el.textContent)return;
var c=el.textContent;
if(c.indexOf('import')===-1)return;
// Rewrite import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime"
c=c.replace(
/import\\s*\\{([^}]+)\\}\\s*from\\s*["']react\\/jsx-runtime["'];?/g,
function(match,imports){
var parts=imports.split(',').map(function(s){return s.trim();});
var decls=[];
parts.forEach(function(part){
// Handle "jsx as _jsx" aliasing
var m=part.match(/^(\\w+)(?:\\s+as\\s+(\\w+))?$/);
if(!m)return;
var name=m[1],alias=m[2]||name;
if(name==='jsx'||name==='jsxs')decls.push('var '+alias+'=React.createElement');
else if(name==='Fragment')decls.push('var '+alias+'=React.Fragment');
});
return decls.join(';');
}
);
// Also rewrite import { ... } from "react/jsx-dev-runtime" (dev mode)
c=c.replace(
/import\\s*\\{([^}]+)\\}\\s*from\\s*["']react\\/jsx-dev-runtime["'];?/g,
function(match,imports){
var parts=imports.split(',').map(function(s){return s.trim();});
var decls=[];
parts.forEach(function(part){
var m=part.match(/^(\\w+)(?:\\s+as\\s+(\\w+))?$/);
if(!m)return;
var name=m[1],alias=m[2]||name;
if(name==='jsx'||name==='jsxs'||name==='jsxDEV')decls.push('var '+alias+'=React.createElement');
else if(name==='Fragment')decls.push('var '+alias+'=React.Fragment');
});
return decls.join(';');
}
);
// Strip any remaining import/export statements that would cause SyntaxError
c=c.replace(/import\\s*\\{[^}]+\\}\\s*from\\s*["'][^"']+["'];?/g,function(match){
var nameMatch=match.match(/\\{([^}]+)\\}/);
if(!nameMatch)return'';
var names=nameMatch[1].split(',').map(function(s){return s.trim().replace(/^\\w+\\s+as\\s+/,'');});
return names.map(function(n){return'var '+n+'=undefined;';}).join('');
});
c=c.replace(/import\\s+[^;]+;/g,function(m){
var nm=m.match(/import\\s+(\\w+)/);
return nm?'var '+nm[1]+'=undefined;':'';
});
c=c.replace(/export\\s+(default\\s+)?/g,function(m,def){
return def?'':'';
});
el.textContent=c;
}
// Intercept ALL DOM insertion methods that Babel might use
var origAppend=Node.prototype.appendChild;
Node.prototype.appendChild=function(child){
if(child&&child.tagName==='SCRIPT')rewriteScriptContent(child);
return origAppend.call(this,child);
};
var origInsert=Node.prototype.insertBefore;
Node.prototype.insertBefore=function(child,ref){
if(child&&child.tagName==='SCRIPT')rewriteScriptContent(child);
return origInsert.call(this,child,ref);
};
// Element.prototype.append() — newer API, used by some libraries
if(Element.prototype.append){
var origElAppend=Element.prototype.append;
Element.prototype.append=function(){
for(var i=0;i<arguments.length;i++){
if(arguments[i]&&arguments[i].tagName==='SCRIPT')rewriteScriptContent(arguments[i]);
}
return origElAppend.apply(this,arguments);
};
}
// Also intercept textContent setter on script elements — Babel may set
// content after the script is already in the DOM via innerHTML/textContent
var origTextDesc=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'textContent');
if(origTextDesc&&origTextDesc.set){
Object.defineProperty(HTMLScriptElement.prototype,'textContent',{
get:origTextDesc.get,
set:function(v){
if(typeof v==='string'&&v.indexOf('import')!==-1){
var fake={textContent:v};
rewriteScriptContent(fake);
v=fake.textContent;
}
origTextDesc.set.call(this,v);
},
configurable:true
});
}
})();</script>`;

                const diag = `<script>(function(){
'use strict';
var errors=[],loaded=[],failed=[];
window.addEventListener('error',function(e){
errors.push({message:e.message,filename:e.filename,lineno:e.lineno,colno:e.colno,
stack:e.error&&e.error.stack?e.error.stack:null});
report();
});
window.addEventListener('unhandledrejection',function(e){
errors.push({type:'unhandledrejection',reason:e.reason?(e.reason.stack||String(e.reason)):String(e.reason)});
report();
});
document.addEventListener('DOMContentLoaded',function(){
document.querySelectorAll('script[src]').forEach(function(s){
s.addEventListener('load',function(){loaded.push(s.src);report();});
s.addEventListener('error',function(){failed.push(s.src);report();});
});
});
function report(){
try{
window.parent.postMessage({
type:'previewRenderStatus',
errors:errors,loadedScripts:loaded,failedScripts:failed,
readyState:document.readyState,
rootChildren:document.getElementById('root')?document.getElementById('root').children.length:-1,
location:String(document.location)
},'*');
}catch(e){}
}
window.addEventListener('load',function(){
setTimeout(report,500);setTimeout(report,2000);setTimeout(report,5000);
});
})();</script>`;

                const injected = babelPatch + diag + DesignPanelProvider._INSPECTOR_SCRIPT;
                html = this._injectIntoHead(html, injected);
                res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
                res.end(Buffer.from(html, 'utf8'));
            } else {
                res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
                res.end(data);
            }
        });

        const entry = this._htmlServers.get(sourceFolder);
        if (entry) {
            clearTimeout(entry.timeoutId);
            entry.timeoutId = this._createServerTimeout(sourceFolder);
        }
    }

    private _getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeMap: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.htm': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.mjs': 'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml; charset=utf-8',
            '.ico': 'image/x-icon',
            '.webp': 'image/webp',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.eot': 'application/vnd.ms-fontobject',
            '.webmanifest': 'application/manifest+json',
            '.xml': 'application/xml',
            '.txt': 'text/plain; charset=utf-8',
            '.pdf': 'application/pdf',
        };
        return mimeMap[ext] || 'application/octet-stream';
    }

    private _createServerTimeout(sourceFolder: string): NodeJS.Timeout {
        return setTimeout(() => {
            const entry = this._htmlServers.get(sourceFolder);
            if (entry) {
                entry.server.close();
                this._htmlServers.delete(sourceFolder);
            }
        }, 10 * 60 * 1000); // 10 minutes idle shutdown
    }

    // srcdoc fallback only: strip the preview's own CSP metas (they'd double up with the
    // inherited webview CSP) and stamp the webview nonce onto script tags so they run.
    private _injectLocalCsp(html: string): string {
        let processedHtml = html.replace(/<meta\b[^>]*\bhttp-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
        if (this._nonce) {
            processedHtml = processedHtml.replace(/<script(?![^>]*\bnonce=)(\s[^>]*)?>/gi, `<script nonce="${this._nonce}"$1>`);
        }
        return processedHtml;
    }

    /**
     * The verb engine (INVERT-AND-INJECT). Arms migrated to the A2b pattern
     * RETURN their result — the HTTP rail sends it in the response body, and any
     * webview push the arm makes stays additive (live-UI update), in the same
     * order as before. Un-migrated arms still `break` (resolving undefined; the
     * rail acks `{success:true}`). The webview postMessage path ignores the
     * return value, so returning is byte-compatible for panel callers.
     */
    private async _handleMessage(message: any): Promise<any> {
        const authInfo = await this._setupStitchAuth();
        const hasKey = authInfo.valid;

        switch (message.type) {
            case 'renderMarkdownLive': {
                try {
                    const html = await this._seams().commands.executeCommand<string>('markdown.api.render', message.content || '');
                    this.postMessage({
                        type: 'markdownLiveRendered',
                        requestId: message.requestId,
                        html: html,
                        htmlContent: html
                    });
                    return { success: true, html, htmlContent: html };
                } catch (err) {
                    this.postMessage({
                        type: 'markdownLiveRendered',
                        requestId: message.requestId,
                        html: '',
                        htmlContent: '',
                        error: String(err)
                    });
                    return { success: false, error: String(err) };
                }
            }
            case 'ready': {
                const allRoots = this._getWorkspaceRoots();
                const items = buildWorkspaceItems(allRoots);
                const tabKeys = ['stitch', 'html-preview', 'images', 'design', 'html.root', 'claude.root', 'design.root', 'stitch.root', 'images.root', 'activeTab', 'previews.source'];
                const statePayload = this._stateStore.getAllStates(tabKeys, allRoots);
                this.postMessage({
                    type: 'workspaceItemsUpdated',
                    items
                });
                this.postMessage({
                    type: 'restoredTabState',
                    panel: statePayload.panel,
                    byRoot: statePayload.byRoot
                });

                this.postMessage({ type: 'stitchApiKeyStatus', configured: hasKey });
                this.postMessage({
                    type: 'stitchAuthStatus',
                    configured: hasKey,
                    valid: hasKey,
                    apiKey: authInfo.apiKey
                });
                const pathConfig = this._seams().pathConfig;
                this.postMessage({ type: 'switchboardThemeChanged', theme: pathConfig.getConfigStringWithDefault('theme.name', 'afterburner') });
                this.postMessage({ type: 'cyberAnimationSetting', disabled: pathConfig.getConfigBoolean('theme.disableCyberAnimation', false) });
                this.postMessage({ type: 'cyberScanlinesSetting', disabled: pathConfig.getConfigBoolean('theme.disableCyberScanlines', false) });
                const htmlDocs = await this._sendHtmlDocsReady();
                const claudeDocs = await this._sendClaudeDocsReady();
                const designDocs = await this._sendDesignDocsReady();
                const imagesDocs = await this._sendImagesDocsReady();
                await this._sendActiveDesignDocState();
                // `type` is mandatory for the browser return-contract: transport.js only
                // re-dispatches a body that carries one (and it dispatches the body as a
                // SINGLE MessageEvent — an array body would not be fanned out). design.js
                // handles 'designReadyComplete' by re-dispatching each nested *DocsReady
                // payload, so the existing per-tab render cases stay the only render path.
                return { success: true, type: 'designReadyComplete', items, statePayload, htmlDocs, claudeDocs, designDocs, imagesDocs };
            }

            case 'persistTabState': {
                const { tabKey, workspaceRoot: root, state } = message;
                if (!tabKey) {
                    return { success: false, error: 'tabKey is required' };
                }
                if (root) {
                    await this._stateStore.setRootState(tabKey, root, state);
                } else {
                    await this._stateStore.setPanelState(tabKey, state);
                }
                return { success: true };
            }
            case 'inspectRequestDataUrl': {
                const filePath = message.filePath;
                const replyChannel: 'http' | 'webview' | undefined = message.__replyChannel === 'http' ? 'http' : 'webview';
                try {
                    // Simple path verification helper (defense-in-depth)
                    const isAllowed = this._getWorkspaceRoots().some(root => {
                        const rel = path.relative(root, filePath);
                        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
                    });
                    if (!isAllowed) {
                        throw new Error("Access denied: File not in workspace roots.");
                    }
                    const buf = fs.readFileSync(filePath);
                    const ext = path.extname(filePath).slice(1).toLowerCase();
                    const mime = ext === 'jpg' ? 'jpeg' : (ext || 'png');
                    const dataUrl = `data:image/${mime};base64,${buf.toString('base64')}`;
                    const payload = {
                        type: 'inspectDataUrl',
                        dataUrl,
                        requestId: message.requestId
                    };
                    this._postReply(payload, replyChannel);
                    return { ...payload, success: true };
                } catch (e) {
                    console.error('[DesignPanelProvider] inspectRequestDataUrl failed', e);
                    const payload = { type: 'inspectDataUrlError', requestId: message.requestId, error: String(e) };
                    this._postReply(payload, replyChannel);
                    return { ...payload, success: false, error: String(e) };
                }
            }
            case 'activeTabChanged': {
                const seat = this._seatFor(message);
                seat.activeTab = message.tab;
                if (message.tab !== 'html-preview') {
                    seat.htmlPreview = null;
                }
                if (message.tab !== 'claude') {
                    seat.claudePreview = null;
                }
                if (message.tab !== 'stitch-html') {
                    seat.stitchHtmlPreview = null;
                }
                if (message.tab !== 'design') {
                    seat.designPreview = null;
                }
                this._reconcilePoll();
                return { success: true, activeTab: seat.activeTab };
            }
            case 'setActivePlanningContext': {
                try {
                    const docPath = await this._resolveDesignDocPath(message.sourceFolder, String(message.docId || ''));
                    if (!docPath) {
                        this.postMessage({ type: 'activeContextSet', success: false, error: 'Document not found' });
                        return { success: false, error: 'Document not found' };
                    }
                    const pathConfig = this._seams().pathConfig;
                    await pathConfig.updateConfigWorkspace(
                        'planner.designSystemDocLink', docPath
                    );
                    await pathConfig.updateConfigGlobal(
                        'planner.designSystemDocLink', undefined
                    );
                    await pathConfig.updateConfigGlobal(
                        'planner.designSystemDocEnabled', true
                    );
                    await pathConfig.updateConfigWorkspace(
                        'planner.designSystemDocEnabled', undefined
                    );
                    this._activeDesignSystemDocSourceId = message.sourceId;
                    this._activeDesignSystemDocId = message.docId;
                    await this._setPlannerDesignSystemAddon(true);
                    await this._sendActiveDesignDocState();
                    this.postMessage({ type: 'activeContextSet', success: true });
                    return { success: true, docPath };
                } catch (err: any) {
                    this.postMessage({ type: 'activeContextSet', success: false, error: String(err) });
                    return { success: false, error: String(err) };
                }
            }

            case 'disableDesignDoc': {
                try {
                    const pathConfig = this._seams().pathConfig;
                    await pathConfig.updateConfigGlobal(
                        'planner.designSystemDocEnabled', false
                    );
                    await pathConfig.updateConfigWorkspace(
                        'planner.designSystemDocEnabled', undefined
                    );
                    await pathConfig.updateConfigWorkspace(
                        'planner.designSystemDocLink', undefined
                    );
                    await pathConfig.updateConfigGlobal(
                        'planner.designSystemDocLink', undefined
                    );
                    this._activeDesignSystemDocSourceId = null;
                    this._activeDesignSystemDocId = null;
                    await this._setPlannerDesignSystemAddon(false);
                    await this._sendActiveDesignDocState();
                    return { success: true };
                } catch (err: any) {
                    this.postMessage({ type: 'activeContextSet', success: false, error: String(err) });
                    return { success: false, error: String(err) };
                }
            }

            case 'saveFileContent': {
                const filePath = String(message.filePath || '');
                const content = String(message.content || '');
                const originalContent = String(message.originalContent || '');
                const tab = String(message.tab || '');
                const allRoots = this._getWorkspaceRoots();
                if (!filePath || !path.isAbsolute(filePath)) {
                    this.postMessage({ type: 'saveFileContentResult', success: false, error: 'Invalid file path', tab });
                    return { success: false, error: 'Invalid file path', tab };
                }
                const resolved = path.resolve(filePath);
                let isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r) + path.sep));
                if (!isAllowed) {
                    for (const r of allRoots) {
                        try {
                            const service = this._getLocalFolderService(r);
                            const allAllowedPaths = [
                                ...service.getDesignFolderPaths(),
                                ...service.getHtmlFolderPaths()
                            ];
                            if (allAllowedPaths.some(dp => resolved.startsWith(path.resolve(dp) + path.sep))) {
                                isAllowed = true;
                                break;
                            }
                        } catch {}
                    }
                }
                if (!isAllowed) {
                    this.postMessage({ type: 'saveFileContentResult', success: false, error: 'Invalid file path', tab });
                    return { success: false, error: 'Invalid file path', tab };
                }
                try {
                    // Conflict detection: compare disk content with the content the editor started from
                    let diskContent = '';
                    if (fs.existsSync(resolved)) {
                        diskContent = await fs.promises.readFile(resolved, 'utf8');
                    }
                    if (originalContent && diskContent !== originalContent) {
                        this.postMessage({ type: 'saveFileContentResult', success: false, conflict: true, diskContent, tab });
                        return { success: false, conflict: true, diskContent, tab };
                    }

                    // Validate JSON/YAML before write
                    const saveExt = path.extname(resolved).toLowerCase();
                    if (saveExt === '.json') {
                        try { JSON.parse(content); }
                        catch (e: any) {
                            this.postMessage({ type: 'saveFileContentResult', success: false, error: `Invalid JSON: ${e.message}`, tab });
                            return { success: false, error: `Invalid JSON: ${e.message}`, tab };
                        }
                    }
                    if (saveExt === '.yaml' || saveExt === '.yml') {
                        const yaml = require('js-yaml');
                        try { yaml.load(content); }
                        catch (e: any) {
                            this.postMessage({ type: 'saveFileContentResult', success: false, error: `Invalid YAML: ${e.message}`, tab });
                            return { success: false, error: `Invalid YAML: ${e.message}`, tab };
                        }
                    }

                    await fs.promises.writeFile(resolved, content, 'utf8');
                    this.postMessage({ type: 'saveFileContentResult', success: true, tab });
                    return { success: true, tab };
                } catch (err: any) {
                    this.postMessage({ type: 'saveFileContentResult', success: false, error: String(err), tab });
                    return { success: false, error: String(err), tab };
                }
            }

            case 'fetchPreview': {
                const seat = this._seatFor(message);
                const rawDocId = String(message.docId || '');
                const replyChannel: 'http' | 'webview' | undefined = message.__replyChannel === 'http' ? 'http' : 'webview';
                if (message.sourceId === 'stitch-html-folder') {
                    // Resolve the folder server-side from projectId — never trust webview-supplied paths.
                    const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                    const projectId = String(message.projectId || '');
                    // Resolve the project name before computing the cache dir so the folder
                    // is correct even if fetchPreview fires before stitchHtmlListDocs has
                    // populated the name cache (mirrors the watcher's async resolution).
                    if (root && projectId) {
                        await this._resolveStitchProjectName(root, projectId);
                    }
                    const resolvedFolder = (root && projectId)
                        ? this._getImageCacheDir(root, projectId)
                        : '';
                    seat.stitchHtmlPreview = resolvedFolder
                        ? { sourceFolder: resolvedFolder, docId: rawDocId, sourceId: message.sourceId, projectId, workspaceRoot: root }
                        : null;
                    // Re-target the per-project watcher if the active project changed.
                    if (projectId !== this._activeStitchHtmlProjectId || root !== this._activeStitchHtmlWorkspaceRoot) {
                        this._activeStitchHtmlProjectId = projectId;
                        this._activeStitchHtmlWorkspaceRoot = root;
                        void this._setupStitchHtmlFolderWatchers().catch(() => {});
                    }
                    const res = await this._buildAndSendPreview({
                        sourceId: message.sourceId,
                        sourceFolder: resolvedFolder,
                        docId: rawDocId,
                        requestId: message.requestId,
                        isAutoRefreshed: false,
                        replyChannel,
                        originatorId: message.originatorId
                    });
                    return res.success
                        ? { ...res.payload, success: true }
                        : { ...(res.payload ?? { type: 'previewError', sourceId: message.sourceId, requestId: message.requestId }), error: res.error, success: false };
                }
                if (message.sourceId === 'design-folder' && message.sourceFolder) {
                    // Track the design tab's open doc so agent edits to a bound
                    // design system auto-refresh the rendered preview (#7).
                    seat.designPreview = {
                        sourceFolder: path.resolve(message.sourceFolder),
                        docId: rawDocId,
                        sourceId: message.sourceId
                    };
                } else if ((message.sourceId === 'html-folder' || message.sourceId === 'claude-folder') && message.sourceFolder) {
                    if (message.target === 'claude') {
                        seat.claudePreview = {
                            sourceFolder: path.resolve(message.sourceFolder),
                            docId: rawDocId,
                            sourceId: message.sourceId
                        };
                    } else {
                        seat.htmlPreview = {
                            sourceFolder: path.resolve(message.sourceFolder),
                            docId: rawDocId,
                            sourceId: message.sourceId
                        };
                    }
                } else {
                    if (message.target === 'claude') {
                        seat.claudePreview = null;
                    } else {
                        seat.htmlPreview = null;
                    }
                }
                const res = await this._buildAndSendPreview({
                    sourceId: message.sourceId,
                    sourceFolder: message.sourceFolder,
                    docId: rawDocId,
                    target: message.target,
                    requestId: message.requestId,
                    isAutoRefreshed: false,
                    replyChannel,
                    originatorId: message.originatorId
                });
                return res.success
                    ? { ...res.payload, success: true }
                    : { ...(res.payload ?? { type: 'previewError', sourceId: message.sourceId, requestId: message.requestId }), error: res.error, success: false };
            }

            case 'copyStitchTweakPrompt': {
                const prompt = String(message.prompt || '');
                if (!prompt) return { success: false, error: 'prompt is required' };
                await this._seams().clipboard.writeText(prompt);
                this._seams().ui.showTemporaryNotification('Copied element tweak prompt to clipboard.');
                return { success: true };
            }

            case 'copyDesignSystemPrompt': {
                let docPath: string | null = null;
                const copyRoot = this._getWorkspaceRoot() || '';
                const activeProject = message.projectName || (copyRoot ? await this._getActiveBoardProject(copyRoot) : undefined);
                if (activeProject) {
                    docPath = await getProjectDesignSystemPath(copyRoot, activeProject);
                }
                if (!docPath) {
                    docPath = await this._resolveDesignDocPath(message.sourceFolder, String(message.docId || ''));
                }
                if (!docPath && message.filePath && fs.existsSync(message.filePath)) {
                    docPath = message.filePath;
                }
                if (!docPath) {
                    this.postMessage({ type: 'copyDesignSystemPromptResult', success: false, error: 'No active or selected design system document found' });
                    return { success: false, error: 'No active or selected design system document found' };
                }
                try {
                    const content = await fs.promises.readFile(docPath, 'utf8');
                    const promptText = buildDesignSystemBlock({
                        link: docPath,
                        content,
                        mode: 'author'
                    });
                    await this._seams().clipboard.writeText(promptText);
                    this._seams().ui.showTemporaryNotification('Copied Design System Prompt to clipboard.');
                    this.postMessage({ type: 'copyDesignSystemPromptResult', success: true, promptText, docId: message.docId });
                    return { success: true, promptText };
                } catch (err: any) {
                    this.postMessage({ type: 'copyDesignSystemPromptResult', success: false, error: String(err) });
                    return { success: false, error: String(err) };
                }
            }

            case 'bindDesignSystemToProject': {
                const root = this._getWorkspaceRoot() || '';
                if (!root) {
                    return { success: false, error: 'No workspace root' };
                }
                let docPath = await this._resolveDesignDocPath(message.sourceFolder, String(message.docId || ''));
                if (!docPath && message.filePath && fs.existsSync(message.filePath)) {
                    docPath = message.filePath;
                }
                if (!docPath) {
                    this._seams().ui.showTemporaryNotification('Select a design document to bind first.');
                    return { success: false, error: 'No design document selected' };
                }
                try {
                    const db = KanbanDatabase.forWorkspace(root);
                    await db.ensureReady();
                    const workspaceId = await db.getWorkspaceId();
                    const projectNames = workspaceId ? await db.getProjects(workspaceId) : [];
                    if (projectNames.length === 0) {
                        this._seams().ui.showTemporaryNotification('No projects exist on the board yet — create a project first.');
                        return { success: false, error: 'No projects' };
                    }
                    const UNBIND_LABEL = 'Unbind a project…';
                    const items: Array<{ label: string; description?: string }> = [];
                    const bound: Array<{ name: string; docPath: string }> = [];
                    for (const name of projectNames) {
                        const existing = await getProjectDesignSystemPath(root, name);
                        items.push({ label: name, description: existing ? `bound to ${path.basename(existing)}` : undefined });
                        if (existing) bound.push({ name, docPath: existing });
                    }
                    if (bound.length > 0) {
                        items.push({ label: UNBIND_LABEL, description: 'Remove an existing design-system binding' });
                    }
                    const pick = await this._seams().ui.showQuickPick(items, { placeHolder: `Bind ${path.basename(docPath)} to which project?` });
                    if (!pick) return { success: false, error: 'Cancelled' };
                    const label = typeof pick === 'string' ? pick : Array.isArray(pick) ? '' : pick.label;
                    if (!label) return { success: false, error: 'Cancelled' };
                    if (label === UNBIND_LABEL) {
                        const unpick = await this._seams().ui.showQuickPick(
                            bound.map(b => ({ label: b.name, description: `bound to ${path.basename(b.docPath)}` })),
                            { placeHolder: 'Unbind the design system from which project?' }
                        );
                        if (!unpick) return { success: false, error: 'Cancelled' };
                        const unbindName = typeof unpick === 'string' ? unpick : Array.isArray(unpick) ? '' : unpick.label;
                        if (!unbindName) return { success: false, error: 'Cancelled' };
                        await removeProjectDesignSystemPath(root, unbindName);
                        this._seams().ui.showTemporaryNotification(`Unbound design system from "${unbindName}".`);
                        this.postMessage({ type: 'designSystemBindingChanged', projectName: unbindName, bound: false });
                        return { success: true, unbound: unbindName };
                    }
                    await setProjectDesignSystemPath(root, label, docPath);
                    this._seams().ui.showTemporaryNotification(`Bound ${path.basename(docPath)} as the design system for "${label}".`);
                    this.postMessage({ type: 'designSystemBindingChanged', projectName: label, bound: true, docPath });
                    return { success: true, projectName: label, docPath };
                } catch (err: any) {
                    return { success: false, error: String(err) };
                }
            }

            case 'createDesignSystemTemplate': {
                const root = this._getWorkspaceRoot();
                if (!root) {
                    return { success: false, error: 'No workspace root' };
                }
                const service = this._getLocalFolderService(root);
                const folders = service.getDesignFolderPaths();
                let targetFolder = folders[0];
                if (!targetFolder) {
                    // No design folder configured: the tab can only list files inside
                    // configured folders, so writing anywhere else (or scaffolding a
                    // .switchboard subfolder) produces an invisible file. Ask for a
                    // folder and register it as a design folder in one step.
                    const picked = await this._seams().ui.pickFolder('Create design system in this folder');
                    if (!picked) {
                        this._seams().ui.showTemporaryNotification('Add a design folder first — the template must live in a configured design folder to appear in the tab.');
                        return { success: false, error: 'No design folder configured' };
                    }
                    await service.addDesignFolderPath(picked);
                    targetFolder = picked;
                }

                let candidate = path.join(targetFolder, 'design-system.html');
                let count = 2;
                while (fs.existsSync(candidate)) {
                    candidate = path.join(targetFolder, `design-system-${count}.html`);
                    count++;
                }

                await fs.promises.writeFile(candidate, STARTER_DESIGN_SYSTEM_HTML, 'utf8');
                await this._sendDesignDocsReady();

                const kickoffPrompt = `Please run the design-system-builder skill to interactively interview me and customize the design system template at ${candidate}. If I want to derive it from an existing app instead of starting from scratch, ask me for the stylesheets, components, or screenshots to read first.`;
                await this._seams().clipboard.writeText(kickoffPrompt);
                this._seams().ui.showTemporaryNotification('Created design system starter template and copied kickoff prompt to clipboard.');

                return { success: true, createdPath: candidate, kickoffPrompt };
            }

            case 'sendStitchTweakPrompt': {
                const prompt = String(message.prompt || '');
                if (!prompt) return { success: false, error: 'prompt is required' };
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.sendPromptToAgentTerminal('coder', prompt, message.workspaceRoot || undefined);
                    showTemporaryNotification('Sent element tweak prompt to agent terminal.');
                } else {
                    await this._seams().clipboard.writeText(prompt);
                    showTemporaryNotification('Agent terminal unavailable — copied tweak prompt to clipboard instead.');
                }
                return { success: true };
            }

            case 'copyHtmlTweakPrompt': {
                const prompt = String(message.prompt || '');
                if (!prompt) return { success: false, error: 'prompt is required' };
                await this._seams().clipboard.writeText(prompt);
                this._seams().ui.showTemporaryNotification('Copied element tweak prompt to clipboard.');
                return { success: true };
            }

            case 'sendHtmlTweakPrompt': {
                const prompt = String(message.prompt || '');
                if (!prompt) return { success: false, error: 'prompt is required' };
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.sendPromptToAgentTerminal('coder', prompt, message.workspaceRoot || undefined);
                    showTemporaryNotification('Sent element tweak prompt to agent terminal.');
                } else {
                    await this._seams().clipboard.writeText(prompt);
                    showTemporaryNotification('Agent terminal unavailable — copied tweak prompt to clipboard instead.');
                }
                return { success: true };
            }

            case 'copyClaudeImportPrompt': {
                const prompt = String(message.prompt || '');
                if (!prompt) return { success: false, error: 'prompt is required' };
                await this._seams().clipboard.writeText(prompt);
                showTemporaryNotification('Copied Claude import prompt to clipboard.');
                return { success: true };
            }

            case 'sendClaudeImportPrompt': {
                const prompt = String(message.prompt || '');
                if (!prompt) return { success: false, error: 'prompt is required' };
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.sendPromptToAgentTerminal('claude_import', prompt, message.workspaceRoot || undefined);
                    showTemporaryNotification('Sent Claude import prompt to agent terminal.');
                } else {
                    await this._seams().clipboard.writeText(prompt);
                    showTemporaryNotification('Agent terminal unavailable — copied Claude import prompt to clipboard instead.');
                }
                return { success: true };
            }

            case 'copyClaudeArtifactPrompt': {
                if (message.error) { showTemporaryNotification(String(message.error)); return { success: false, error: String(message.error) }; }
                const prompt = String(message.prompt || '');
                if (!prompt) return { success: false, error: 'prompt is required' };
                await this._seams().clipboard.writeText(prompt);
                showTemporaryNotification('Copied Claude artifact upload prompt to clipboard.');
                return { success: true };
            }

            case 'sendClaudeArtifactPrompt': {
                if (message.error) { showTemporaryNotification(String(message.error)); return { success: false, error: String(message.error) }; }
                const prompt = String(message.prompt || '');
                if (!prompt) return { success: false, error: 'prompt is required' };
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.sendPromptToAgentTerminal('claude_artifacts', prompt, message.workspaceRoot || undefined);
                    showTemporaryNotification('Sent artifact upload prompt to Claude.');
                } else {
                    // No agent terminal wired up — fall back to clipboard so the button still does something.
                    await this._seams().clipboard.writeText(prompt);
                    showTemporaryNotification('Agent terminal unavailable — copied artifact upload prompt to clipboard instead.');
                }
                return { success: true };
            }

            case 'linkToDocument': {
                // Tree node ids are `${folderIndex}:${relativePath}` — strip the prefix.
                const rawLinkId = String(message.docId || '');
                const linkRelativePath = rawLinkId.includes(':')
                    ? rawLinkId.substring(rawLinkId.indexOf(':') + 1)
                    : rawLinkId;
                const linkPath = message.sourceFolder
                    ? path.resolve(message.sourceFolder, linkRelativePath)
                    : linkRelativePath;
                const linkRef = linkPath;
                this._seams().clipboard.writeText(linkRef);
                showTemporaryNotification(`Copied document path to clipboard: ${linkRef}`);
                return { success: true, linkRef };
            }

            case 'linkToFolder': {
                await this._handleLinkToFolder(this._getWorkspaceRoot(), String(message.folderPath || ''));
                return { success: true };
            }

            case 'serveAndOpenHtml':
                try {
                    // Tree node ids are `${folderIndex}:${relativePath}` — strip the prefix.
                    const rawOpenId = String(message.docId || '');
                    const openRelativePath = rawOpenId.includes(':')
                        ? rawOpenId.substring(rawOpenId.indexOf(':') + 1)
                        : rawOpenId;
                    const fullPath = message.absolutePath
                        || path.resolve(message.sourceFolder || this._getWorkspaceRoot() || '', openRelativePath);
                    const serveFolder = message.sourceFolder || path.dirname(fullPath);
                    await fs.promises.access(fullPath, fs.constants.R_OK);
                    const entry = await this._getOrCreateHtmlServer(path.resolve(serveFolder));
                    const url = this._buildLocalhostUrl(entry, path.resolve(serveFolder), fullPath);
                    await this._seams().ui.openExternal(url);
                    return { success: true, url };
                } catch (err: any) {
                    this._seams().ui.showErrorMessage('Failed to serve HTML file: ' + err.message);
                    return { success: false, error: err.message || String(err) };
                }

            case 'stitchSaveApiKey':
                try {
                    if (message.apiKey) {
                        await this._seams().secrets.store('switchboard.stitch.apiKey', message.apiKey);
                    } else {
                        await this._seams().secrets.delete('switchboard.stitch.apiKey');
                    }
                    process.env.STITCH_API_KEY = message.apiKey || '';
                    invalidateStitchSdkCache();
                    const auth = await this._setupStitchAuth();
                    this.postMessage({ type: 'stitchApiKeyStatus', configured: auth.valid });
                    this.postMessage({ type: 'stitchAuthStatus', configured: auth.valid, valid: auth.valid });
                    this._seams().ui.showTemporaryNotification('Stitch API Key saved successfully.');
                    return { success: true, configured: auth.valid };
                } catch (err: any) {
                    void this._seams().ui.showErrorMessage('Failed to save API key: ' + err.message);
                    return { success: false, error: err.message || String(err) };
                }

            case 'stitchSaveAuthConfig':
                try {
                    if (message.apiKey) {
                        await this._context.secrets.store('switchboard.stitch.apiKey', message.apiKey);
                    } else {
                        await this._context.secrets.delete('switchboard.stitch.apiKey');
                    }
                    
                    invalidateStitchSdkCache();
                    const auth = await this._setupStitchAuth();
                    
                    this.postMessage({ type: 'stitchApiKeyStatus', configured: auth.valid });
                    this.postMessage({ 
                        type: 'stitchAuthStatus', 
                        configured: auth.valid, 
                        valid: auth.valid,
                        apiKey: auth.apiKey
                    });
                    showTemporaryNotification('Stitch Authentication settings saved successfully.');
                    return { success: true, configured: auth.valid };
                } catch (err: any) {
                    this._seams().ui.showErrorMessage('Failed to save settings: ' + err.message);
                    return { success: false, error: err.message || String(err) };
                }

            case 'stitchValidateAuth':
                try {
                    const auth = await this._setupStitchAuth();
                    if (!auth.valid) {
                        this.postMessage({ 
                            type: 'stitchAuthStatus', 
                            configured: false, 
                            valid: false,
                            error: 'Credentials not configured',
                            apiKey: auth.apiKey
                        });
                        return { success: false, configured: false, valid: false, error: 'Credentials not configured' };
                    }
                    invalidateStitchSdkCache();
                    const stitch = await loadStitch('');
                    await stitch.projects();
                    this.postMessage({ 
                        type: 'stitchAuthStatus', 
                        configured: true, 
                        valid: true,
                        apiKey: auth.apiKey
                    });
                    return { success: true, configured: true, valid: true };
                } catch (err: any) {
                    const auth = await this._setupStitchAuth();
                    this.postMessage({ 
                        type: 'stitchAuthStatus', 
                        configured: true, 
                        valid: false,
                        error: err.message || String(err),
                        apiKey: auth.apiKey
                    });
                    return { success: false, configured: true, valid: false, error: err.message || String(err) };
                }

            case 'stitchListDesignSystems':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const auth = await this._setupStitchAuth();
                    if (!auth.valid) {
                        this.postMessage({ type: 'stitchError', error: 'Authentication not configured.', workspaceRoot });
                        return { success: false, error: 'Authentication not configured.' };
                    }
                    const projectId = message.projectId;
                    if (!projectId) {
                        this.postMessage({ type: 'stitchError', error: 'No project selected.', workspaceRoot });
                        return { success: false, error: 'No project selected.' };
                    }
                    const stitch = await loadStitch('');
                    const project = stitch.project(projectId);
                    const list = await project.listDesignSystems();
                    const designSystems = list.map((ds: any) => ({
                        id: ds.id,
                        displayName: ds.data?.displayName || ds.data?.name || ds.name || `Design System ${ds.id}`,
                        styleGuidelines: ds.data?.styleGuidelines || ds.data?.guidelines || '',
                        designTokens: ds.data?.designTokens
                            ? (typeof ds.data.designTokens === 'string'
                                ? ds.data.designTokens
                                : JSON.stringify(ds.data.designTokens))
                            : ''
                    }));
                    this.postMessage({ type: 'stitchDesignSystemsReady', designSystems, workspaceRoot });
                    return { success: true, designSystems };
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    return { success: false, error: err.message || String(err) };
                }

            case 'stitchCreateDesignSystem':
                if (this._stitchOperationLock) {
                    this.postMessage({ type: 'stitchError', error: 'An operation is already in progress.', workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    return { success: false, error: 'An operation is already in progress.' };
                }
                this._stitchOperationLock = true;
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const auth = await this._setupStitchAuth();
                    if (!auth.valid) {
                        throw new Error('Authentication not configured.');
                    }
                    const projectId = message.projectId;
                    if (!projectId) {
                        throw new Error('No project selected.');
                    }
                    const stitch = await loadStitch('');
                    const project = stitch.project(projectId);
                    
                    const input = {
                        displayName: message.displayName,
                        styleGuidelines: message.styleGuidelines,
                        designTokens: message.designTokens
                    };
                    
                    await project.createDesignSystem(input);
                    this.postMessage({ type: 'stitchDesignSystemCreated', workspaceRoot });
                    return { success: true };
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    return { success: false, error: err.message || String(err) };
                } finally {
                    this._stitchOperationLock = false;
                }

            case 'stitchUpdateDesignSystem':
                if (this._stitchOperationLock) {
                    this.postMessage({ type: 'stitchError', error: 'An operation is already in progress.', workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    return { success: false, error: 'An operation is already in progress.' };
                }
                this._stitchOperationLock = true;
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const auth = await this._setupStitchAuth();
                    if (!auth.valid) {
                        throw new Error('Authentication not configured.');
                    }
                    const projectId = message.projectId;
                    const assetId = message.assetId;
                    if (!projectId || !assetId) {
                        throw new Error('Project or design system asset ID is missing.');
                    }
                    const stitch = await loadStitch('');
                    const project = stitch.project(projectId);
                    const ds = project.designSystem(assetId);
                    
                    const input = {
                        displayName: message.displayName,
                        styleGuidelines: message.styleGuidelines,
                        designTokens: message.designTokens
                    };
                    
                    await ds.update(input);
                    this.postMessage({ type: 'stitchDesignSystemUpdated', workspaceRoot });
                    return { success: true };
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    return { success: false, error: err.message || String(err) };
                } finally {
                    this._stitchOperationLock = false;
                }

            case 'stitchApplyDesignSystem':
                if (this._stitchOperationLock) {
                    this.postMessage({ type: 'stitchError', error: 'An operation is already in progress.', workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    break;
                }
                this._stitchOperationLock = true;
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const auth = await this._setupStitchAuth();
                    if (!auth.valid) {
                        throw new Error('Authentication not configured.');
                    }
                    const projectId = message.projectId;
                    const assetId = message.assetId;
                    const screenIds = message.screenIds || [];
                    if (!projectId || !assetId) {
                        throw new Error('Project or design system ID is missing.');
                    }
                    if (screenIds.length === 0) {
                        throw new Error('No screens selected.');
                    }

                    const { StitchToolClient } = await import('@google/stitch-sdk');
                    const dedicatedClient = new StitchToolClient();

                    const projectData: any = await dedicatedClient.callTool("get_project", { name: "projects/" + projectId });
                    const rawInstances = projectData.screenInstances || [];
                    
                    const selectedScreenInstances = rawInstances
                        .filter((instance: any) => {
                            if (!instance.id) return false;
                            if (instance.type && instance.type !== 'SCREEN_INSTANCE') return false;
                            return screenIds.includes(instance.id);
                        })
                        .map((instance: any) => ({
                            id: instance.id,
                            sourceScreen: instance.sourceScreen || instance.id
                        }));

                    if (selectedScreenInstances.length === 0) {
                        throw new Error('No applicable screens found in the project.');
                    }

                    const stitch = await loadStitch('');
                    const project = stitch.project(projectId);
                    const ds = project.designSystem(assetId);
                    
                    const updatedScreens = await ds.apply(selectedScreenInstances);

                    const formatted = await Promise.all(updatedScreens.map(async (s: any) => {
                        return this._formatScreen(s, workspaceRoot || '');
                    }));

                    const db = KanbanDatabase.forWorkspace(workspaceRoot || '');
                    await db.bulkUpsertStitchScreens(formatted.map((f: any) => ({
                        id: f.id,
                        projectId,
                        name: f.name,
                        deviceType: f.deviceType ?? null,
                        status: f.status,
                        statusMessage: f.statusMessage,
                        summary: f.summary || '',
                        suggestionsJson: Array.isArray(f.suggestions) && f.suggestions.length ? JSON.stringify(f.suggestions) : ''
                    })));

                    this.postMessage({ type: 'stitchDesignSystemApplied', workspaceRoot });
                    this.postMessage({ type: 'stitchScreensReady', screens: formatted, workspaceRoot });
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                } finally {
                    this._stitchOperationLock = false;
                }
                break;

            case 'stitchListProjects':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (!hasKey) {
                        this.postMessage({ type: 'stitchApiKeyStatus', configured: false, workspaceRoot });
                        return { success: false, configured: false, error: 'API key not configured' };
                    }
                    const pathConfig = this._seams().pathConfig;
                    const defaultProjectId = pathConfig.getConfigString('stitch.defaultProjectId');
                    const defaultModelId = pathConfig.getConfigStringWithDefault('stitch.defaultModelId', 'GEMINI_3_FLASH');
                    const defaultCreativeRange = pathConfig.getConfigStringWithDefault('stitch.defaultCreativeRange', 'EXPLORE');

                    const db = KanbanDatabase.forWorkspace(workspaceRoot);
                    const dbProjects = await db.getStitchProjects();

                    // Cache-then-network: serve the DB list immediately for a fast dropdown,
                    // then ALWAYS refresh from the API so projects deleted on the Stitch side
                    // get pruned without the user having to know about the ↻ button.
                    const servedFromCache = dbProjects.length > 0 && !message.forceRefresh;
                    if (servedFromCache) {
                        for (const p of dbProjects) { this._stitchProjectNames.set(p.id, p.name); }
                        this.postMessage({ type: 'stitchProjectsReady', projects: dbProjects, defaultProjectId, defaultModelId, defaultCreativeRange, workspaceRoot });
                    }

                    try {
                        const stitch = await loadStitch('');
                        const list = await stitch.projects();
                        const projects = list.map((p: any) => ({
                            id: p.id,
                            name: p.data?.title || p.data?.name || p.id,
                            updateTime: p.data?.updateTime || p.data?.createTime || ''
                        }));

                        if (workspaceRoot) {
                            for (const p of projects) {
                                this._stitchProjectNames.set(p.id, p.name);
                                await db.upsertStitchProject(p.id, p.name, p.updateTime);
                            }
                            // Prune projects deleted on the Stitch side. Safe here only: this
                            // runs after a SUCCESSFUL projects() fetch (a failed fetch throws
                            // first), and these rows are purely a cache of remote state.
                            const fetchedIds = new Set(projects.map((p: any) => p.id));
                            for (const stale of dbProjects.filter(p => !fetchedIds.has(p.id))) {
                                await db.deleteStitchScreensForProject(stale.id);
                                await db.deleteStitchProject(stale.id);
                            }
                        }

                        // Re-post only when the fresh list differs from what the cache showed,
                        // to avoid dropdown churn on every panel open.
                        const changed = !servedFromCache ||
                            projects.length !== dbProjects.length ||
                            projects.some((p: any) => !dbProjects.find(dp => dp.id === p.id && dp.name === p.name));
                        if (changed) {
                            this.postMessage({ type: 'stitchProjectsReady', projects, defaultProjectId, defaultModelId, defaultCreativeRange, workspaceRoot });
                        }
                        return { success: true, type: 'stitchProjectsReady', projects, defaultProjectId, defaultModelId, defaultCreativeRange };
                    } catch (refreshErr: any) {
                        // Cache was already served — a failed background refresh shouldn't
                        // paint an error over a working dropdown.
                        if (!servedFromCache) throw refreshErr;
                        console.error('Stitch background project refresh failed:', refreshErr);
                        return { success: true, type: 'stitchProjectsReady', projects: dbProjects, defaultProjectId, defaultModelId, defaultCreativeRange };
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    return { success: false, error: err.message || String(err) };
                }

            case 'stitchGetProjectScreens':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const projectId: string = message.projectId;

                    const db = KanbanDatabase.forWorkspace(workspaceRoot);
                    await db.ensureReady();

                    // Migrate flat cache to per-project folders (idempotent, runs once per workspace).
                    await this._migrateStitchCacheToProjectFolders(workspaceRoot);
                    // Ensure this project's name is cached for folder resolution.
                    if (projectId) { await this._resolveStitchProjectName(workspaceRoot, projectId); }

                    // --- Phase 1: serve from cache immediately ---
                    const cachedWithImage = new Set<string>(); // screens we already sent WITH an image
                    const cachedIds = new Set<string>();       // all screens we sent from cache
                    // generate/edit-time commentary lives only in the DB (list responses
                    // never carry it) — remember it so re-formatted screens keep it.
                    const cachedCommentary = new Map<string, { summary: string; suggestions: any[] }>();

                    let formattedCached: any[] = [];
                    if (workspaceRoot) {
                        const cached = await db.getStitchScreensForProject(projectId);
                        if (cached.length > 0) {
                            formattedCached = await Promise.all(cached.map(s => this._formatScreenFromCache(s, workspaceRoot)));
                            this.postMessage({ type: 'stitchScreensReady', screens: formattedCached, workspaceRoot });
                            for (const f of formattedCached) {
                                cachedIds.add(f.id);
                                if (f.imageUrl) cachedWithImage.add(f.id);
                                if (f.summary || (f.suggestions && f.suggestions.length)) {
                                    cachedCommentary.set(f.id, { summary: f.summary, suggestions: f.suggestions });
                                }
                            }
                        }
                    }

                    // --- Phase 2: fetch from API ---
                    const stitch = await loadStitch('');
                    const allAssets = await stitch.project(projectId).screens();
                    // project.screens() returns ALL assets including reference uploads (images,
                    // documents, specs) — see _isGeneratedScreenAsset for the shape rules.
                    const list = allAssets.filter((s: any) => this._isGeneratedScreenAsset(s));
                    for (const screen of list) {
                        this._activeScreens.set(screen.id, screen);
                    }

                    // Update DB (append new screens, update statuses) using bulk upsert
                    if (workspaceRoot) {
                        const screensToUpsert = list.map((s: any) => ({
                            id: s.id,
                            projectId: s.projectId || projectId,
                            name: s.data?.title || s.data?.displayName || s.id,
                            deviceType: s.data?.deviceType || null,
                            status: s.data?.screenMetadata?.status || null,
                            statusMessage: s.data?.screenMetadata?.statusMessage || null,
                            ...this._screenAiMetaForDb(s.data)
                        }));
                        await db.bulkUpsertStitchScreens(screensToUpsert);
                    }

                    // --- Phase 3: send what the cache couldn't cover ---
                    const withCommentary = (f: any) => {
                        const c = cachedCommentary.get(f.id);
                        if (c) {
                            if (!f.summary) f.summary = c.summary;
                            if (!f.suggestions?.length) f.suggestions = c.suggestions;
                        }
                        return f;
                    };
                    let resultScreens: any[] = [];
                    if (cachedIds.size === 0) {
                        // No cache at all — send every screen at once
                        resultScreens = await Promise.all(list.map((s: any) => this._formatScreen(s, workspaceRoot)));
                        this.postMessage({ type: 'stitchScreensReady', screens: resultScreens, workspaceRoot });
                    } else {
                        // Cache was served — re-format screens that are new OR were cached without
                        // an image on disk. _formatScreen is the only path that triggers the PNG
                        // download, so filtering on cachedIds here would permanently strand any
                        // screen that entered the DB before its image finished rendering.
                        const needsUpdate = list.filter((s: any) => !cachedWithImage.has(s.id));
                        const updatedScreens = await Promise.all(needsUpdate.map(async (screen: any) => {
                            const formatted = withCommentary(await this._formatScreen(screen, workspaceRoot));
                            this.postMessage({ type: 'stitchScreenReady', screen: formatted, workspaceRoot });
                            return formatted;
                        }));
                        resultScreens = [...formattedCached, ...updatedScreens];
                    }

                    // Background sweep: archive any screen HTML not yet on disk before its
                    // signed URL expires. Covers screens served purely from cache above,
                    // which never pass through _formatScreen.
                    void this._backfillStitchHtmlCache(list, workspaceRoot);
                    return { success: true, type: 'stitchScreensReady', screens: resultScreens };
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    return { success: false, error: err.message || String(err) };
                }

            case 'stitchRebuildImageCache':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        const projectId: string = message.projectId;
                        if (!projectId) throw new Error('No project selected to rebuild cache');

                        const db = KanbanDatabase.forWorkspace(workspaceRoot);
                        await db.ensureReady();
                        const cached = await db.getStitchScreensForProject(projectId);

                        const cacheDir = this._getImageCacheDir(workspaceRoot, projectId);
                        for (const s of cached) {
                            const filePath = path.join(cacheDir, `${path.basename(s.id)}.png`);
                            try {
                                await fs.promises.unlink(filePath);
                            } catch {
                                // ignore if not exist
                            }
                        }

                        const stitch = await loadStitch('');
                        const formatted = await Promise.all(cached.map(async (s) => {
                            let screen = this._activeScreens.get(s.id);
                            if (!screen) {
                                screen = await stitch.project(projectId).getScreen(s.id);
                                this._activeScreens.set(s.id, screen);
                            }
                            return this._formatScreen(screen, workspaceRoot);
                        }));

                        this.postMessage({ type: 'stitchScreensReady', screens: formatted, workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchForceReloadScreens':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return { success: false, error: 'Another Stitch operation is in progress.' };
                    }
                    this._stitchOperationLock = true;
                    try {
                        const projectId: string = message.projectId;
                        if (!workspaceRoot) throw new Error('No workspace root available');
                        if (!projectId) throw new Error('No project selected to force reload');

                        const db = KanbanDatabase.forWorkspace(workspaceRoot);
                        await db.ensureReady();

                        // Force reload = re-fetch the authoritative list, upsert, and prune
                        // rows for screens deleted remotely. Deliberately does NOT delete
                        // cached PNGs (the API sometimes serves no screenshot URL for a
                        // screen — deleting the last good render leaves the card permanently
                        // blank; purging images is the Rebuild Image Cache button's job) and
                        // does NOT delete-all rows (generate-time commentary lives only in
                        // the DB and would be lost).
                        const cachedRows = await db.getStitchScreensForProject(projectId);

                        this._activeScreens.clear();

                        const stitch = await loadStitch('');
                        const allAssets = await stitch.project(projectId).screens();
                        const list = allAssets.filter((s: any) => this._isGeneratedScreenAsset(s));
                        for (const screen of list) {
                            this._activeScreens.set(screen.id, screen);
                        }

                        if (workspaceRoot) {
                            const screensToUpsert = list.map((s: any) => ({
                                id: s.id,
                                projectId: s.projectId || projectId,
                                name: s.data?.title || s.data?.displayName || s.id,
                                deviceType: s.data?.deviceType || null,
                                status: s.data?.screenMetadata?.status || null,
                                statusMessage: s.data?.screenMetadata?.statusMessage || null,
                                ...this._screenAiMetaForDb(s.data)
                            }));
                            await db.bulkUpsertStitchScreens(screensToUpsert);
                            const freshIds = new Set(list.map((s: any) => s.id));
                            for (const stale of cachedRows.filter(r => !freshIds.has(r.id))) {
                                await db.deleteStitchScreen(stale.id);
                            }
                        }

                        const commentaryById = new Map(cachedRows
                            .filter(r => r.summary || r.suggestionsJson)
                            .map(r => [r.id, r] as const));
                        const formatted = await Promise.all(list.map(async (s: any) => {
                            const f = await this._formatScreen(s, workspaceRoot);
                            const c = commentaryById.get(f.id);
                            if (c) {
                                if (!f.summary) f.summary = c.summary || '';
                                if (!f.suggestions?.length && c.suggestionsJson) {
                                    try { f.suggestions = JSON.parse(c.suggestionsJson); } catch { /* ignore */ }
                                }
                            }
                            return f;
                        }));
                        this.postMessage({ type: 'stitchScreensReady', screens: formatted, workspaceRoot });
                        return { success: true, screens: formatted };
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    return { success: false, error: err.message || String(err) };
                }

            case 'stitchCreateProject':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    const title = (typeof message.title === 'string' ? message.title : '').trim();
                    if (!title) {
                        this.postMessage({ type: 'stitchError', error: 'A project title is required.', workspaceRoot });
                        break;
                    }
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        const stitch = await loadStitch('');
                        const project = await stitch.createProject(title);
                        const list = await stitch.projects();
                        const projects = list.map((p: any) => ({
                            id: p.id,
                            name: p.data?.title || p.data?.name || p.id,
                            updateTime: p.data?.updateTime || p.data?.createTime || ''
                        }));
                        // Persist the freshly created project (and any others) so the cache-gated
                        // stitchListProjects path serves it on next panel open without a forceRefresh.
                        if (workspaceRoot) {
                            const db = KanbanDatabase.forWorkspace(workspaceRoot);
                            for (const p of projects) {
                                this._stitchProjectNames.set(p.id, p.name);
                                await db.upsertStitchProject(p.id, p.name, p.updateTime);
                            }
                        }
                        // Pass the new project as the default so the webview auto-selects it.
                        this.postMessage({ type: 'stitchProjectsReady', projects, defaultProjectId: project.id, selectProjectId: project.id, workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchRefreshScreen':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (!message.projectId || !message.screenId) throw new Error('Missing project or screen id');
                    const stitch = await loadStitch('');
                    const fresh = await stitch.project(message.projectId).getScreen(message.screenId);
                    this._activeScreens.set(fresh.id, fresh);
                    const formatted = await this._formatScreen(fresh, workspaceRoot);
                    this.postMessage({ type: 'stitchScreenReady', screen: formatted, workspaceRoot });
                    return { success: true, screen: formatted };
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    return { success: false, error: err.message || String(err) };
                }

            case 'stitchOpenManifest':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No active workspace root found');
                    const manifestPath = path.join(this._getStitchOutputDir(workspaceRoot), 'DESIGN.md');
                    if (!fs.existsSync(manifestPath)) {
                        if (!message.projectId) throw new Error('No project selected to generate DESIGN.md');
                        const stitch = await loadStitch('');
                        const projectInstance = stitch.project(message.projectId);
                        const screens = await projectInstance.screens();

                        const outputDir = this._getStitchOutputDir(workspaceRoot);
                        await fs.promises.mkdir(outputDir, { recursive: true });

                        let designMd = `# Design Handoff - Project ${message.projectId}\n\n`;
                        designMd += `Sync timestamp (on-demand): ${new Date().toISOString()}\n\n`;
                        designMd += `## Screens\n\n`;

                        const skipped: string[] = [];
                        for (const s of screens) {
                            const screenName = s.data?.title || s.data?.displayName || s.id;
                            const htmlUrl = await s.getHtml();
                            const imageUrl = await s.getImage();

                            if (!htmlUrl || !imageUrl) {
                                skipped.push(screenName);
                                continue;
                            }

                            designMd += `### ${screenName}\n`;
                            designMd += `- Device: ${s.data?.deviceType || 'AGNOSTIC'}\n`;
                            designMd += `- HTML Link: [Open HTML](${htmlUrl})\n`;
                            designMd += `- Image: ![${screenName}](${imageUrl})\n\n`;
                        }
                        if (skipped.length > 0) {
                            designMd += `> Skipped (no download URLs yet): ${skipped.join(', ')}\n\n`;
                        }

                        try {
                            const designSystems = await projectInstance.listDesignSystems();
                            if (designSystems && designSystems.length > 0) {
                                designMd += `## Design Systems\n\n`;
                                for (const ds of designSystems) {
                                    designMd += `### ${ds.data?.displayName || ds.data?.name || ds.id}\n\n`;
                                    const tokens = ds.data?.designTokens;
                                    if (tokens) {
                                        designMd += '```\n' + String(tokens) + '\n```\n\n';
                                    } else if (ds.data) {
                                        designMd += '```json\n' + JSON.stringify(ds.data, null, 2) + '\n```\n\n';
                                    }
                                }
                            }
                        } catch {
                            designMd += `> Design systems could not be fetched for this project.\n\n`;
                        }

                        await fs.promises.writeFile(manifestPath, Buffer.from(designMd, 'utf8'));
                    }
                    await this._seams().editor.showTextDocument(manifestPath, { preview: false });
                    return { success: true, manifestPath };
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                    return { success: false, error: err.message || String(err) };
                }

            case 'stitchDownloadPalette':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No active workspace root found');
                    if (!message.projectId) throw new Error('No project selected');

                    const stitch = await loadStitch('');
                    const projectInstance = stitch.project(message.projectId);
                    const designSystems = await projectInstance.listDesignSystems();

                    let outputDir = this._getStitchOutputDir(workspaceRoot);
                    if (message.destination) {
                        const resolvedDest = path.resolve(message.destination);
                        const allRoots = this._getWorkspaceRoots();
                        let isAllowed = allRoots.some(r => resolvedDest === path.resolve(r) || resolvedDest.startsWith(path.resolve(r) + path.sep));
                        if (!isAllowed) {
                            throw new Error('Invalid download destination folder path');
                        }
                        outputDir = resolvedDest;
                    }
                    await fs.promises.mkdir(outputDir, { recursive: true });

                    const tokens: any = {};
                    if (designSystems && designSystems.length > 0) {
                        for (const ds of designSystems) {
                            if (ds.data?.designTokens) {
                                tokens[ds.data.displayName || ds.data.name || ds.id] = ds.data.designTokens;
                            } else if (ds.data) {
                                tokens[ds.data.displayName || ds.data.name || ds.id] = ds.data;
                            }
                        }
                    }

                    const targetPath = path.join(outputDir, 'design-tokens.json');
                    await fs.promises.writeFile(targetPath, Buffer.from(JSON.stringify(tokens, null, 2), 'utf8'));

                    showTemporaryNotification(`Downloaded design tokens to ${path.basename(outputDir)}/design-tokens.json`);
                    return { success: true, targetPath };
                } catch (err: any) {
                    this._seams().ui.showErrorMessage('Download failed: ' + err.message);
                    return { success: false, error: err.message || String(err) };
                }

            case 'listDesignFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getDesignFolderPaths();
                this.postMessage({ type: 'designFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'addDesignFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                // HTTP callers pass folderPath directly; the webview flow keeps the host folder picker.
                const picked = (typeof message.folderPath === 'string' && message.folderPath.trim())
                    ? message.folderPath.trim()
                    : await this._seams().ui.pickFolder('Add Design Folder');
                if (!picked) {
                    return { success: false, error: 'No folder selected' };
                }
                const service = this._getLocalFolderService(root);
                await service.addDesignFolderPath(picked);
                this._setupDesignFolderWatchers();
                await this._sendDesignDocsReady();
                const paths = service.getDesignFolderPaths();
                this.postMessage({ type: 'designFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'removeDesignFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeDesignFolderPath(message.folderPath);
                this._setupDesignFolderWatchers();
                await this._sendDesignDocsReady();
                const paths = service.getDesignFolderPaths();
                this.postMessage({ type: 'designFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }

            case 'listHtmlFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getHtmlFolderPaths();
                this.postMessage({ type: 'htmlFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'addHtmlFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const picked = (typeof message.folderPath === 'string' && message.folderPath.trim())
                    ? message.folderPath.trim()
                    : await this._seams().ui.pickFolder('Add HTML Folder');
                if (!picked) {
                    return { success: false, error: 'No folder selected' };
                }
                const service = this._getLocalFolderService(root);
                await service.addHtmlFolderPath(picked);
                this._setupHtmlFolderWatchers();
                await this._sendHtmlDocsReady();
                const paths = service.getHtmlFolderPaths();
                this.postMessage({ type: 'htmlFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'removeHtmlFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeHtmlFolderPath(message.folderPath);
                this._setupHtmlFolderWatchers();
                await this._sendHtmlDocsReady();
                const paths = service.getHtmlFolderPaths();
                this.postMessage({ type: 'htmlFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'listClaudeFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getClaudeFolderPaths();
                this.postMessage({ type: 'claudeFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'addClaudeFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const picked = (typeof message.folderPath === 'string' && message.folderPath.trim())
                    ? message.folderPath.trim()
                    : await this._seams().ui.pickFolder('Add Claude Folder');
                if (!picked) {
                    return { success: false, error: 'No folder selected' };
                }
                const service = this._getLocalFolderService(root);
                await service.addClaudeFolderPath(picked);
                this._setupClaudeFolderWatchers();
                await this._sendClaudeDocsReady();
                const paths = service.getClaudeFolderPaths();
                this.postMessage({ type: 'claudeFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'removeClaudeFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeClaudeFolderPath(message.folderPath);
                this._setupClaudeFolderWatchers();
                await this._sendClaudeDocsReady();
                const paths = service.getClaudeFolderPaths();
                this.postMessage({ type: 'claudeFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }

            // Re-scan the source folders for a tab on demand. The webview posts this when
            // the user activates a tab, mirroring planning.js's fetch-on-tab-activation.
            // VS Code's FileSystemWatcher misses files created outside the editor (e.g. by
            // an external script or agent write), so the watcher-driven list can go stale;
            // a fresh readdir on tab entry guarantees the list is current.
            case 'stitchHtmlListDocs': {
                const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const projectId: string = message.projectId;
                // Track the active stitch-html project server-side so the per-project
                // watcher can re-target on project switch. A preview opened under project A
                // is not valid under project B, so clear the active preview on change.
                if (projectId !== this._activeStitchHtmlProjectId || workspaceRoot !== this._activeStitchHtmlWorkspaceRoot) {
                    this._activeStitchHtmlProjectId = projectId;
                    this._activeStitchHtmlWorkspaceRoot = workspaceRoot;
                    this._seatFor(message).stitchHtmlPreview = null;
                    void this._setupStitchHtmlFolderWatchers().catch(() => {});
                }
                const payload = await this._sendStitchHtmlDocsReady(workspaceRoot, projectId);
                if (hasKey && workspaceRoot && projectId && !this._stitchOperationLock) {
                    void this._backfillStitchHtmlForProject(workspaceRoot, projectId)
                        .catch(err => console.error('[DesignPanel] stitch-html backfill failed:', err));
                }
                return { success: true, ...(payload || {}) };
            }

            case 'refreshDocsForTab': {
                // A tab→sender map rather than a nested switch: the senders now RETURN
                // their `*DocsReady` payload (the browser return-contract), and a map
                // keeps this arm free of nested `break` control flow so the Design
                // return-contract ratchet stays honest.
                //
                // design.js only posts this for html-preview / images; 'design'
                // is here so the map is total over the local tabs if DESIGN SYSTEM ever
                // gains refresh-on-entry like its siblings. 'claude' has no tab in
                // design.html at all — the entry (and _sendClaudeDocsReady itself) is
                // dead, kept only because removing it is separate dead-code cleanup.
                const tabSenders: Record<string, () => Promise<any>> = {
                    'html-preview': () => this._sendHtmlDocsReady(),
                    'claude': () => this._sendClaudeDocsReady(),
                    'images': () => this._sendImagesDocsReady(),
                    'design': () => this._sendDesignDocsReady(),
                };
                const tabSender = tabSenders[message.tab as string];
                const payload = tabSender ? await tabSender() : null;
                return { success: true, ...(payload || {}) };
            }

            case 'listImagesFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getImagesFolderPaths();
                this.postMessage({ type: 'imagesFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'addImagesFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const picked = (typeof message.folderPath === 'string' && message.folderPath.trim())
                    ? message.folderPath.trim()
                    : await this._seams().ui.pickFolder('Add Images Folder');
                if (!picked) {
                    return { success: false, error: 'No folder selected' };
                }
                const service = this._getLocalFolderService(root);
                await service.addImagesFolderPath(picked);
                this._setupImagesFolderWatchers();
                await this._sendImagesDocsReady();
                const paths = service.getImagesFolderPaths();
                this.postMessage({ type: 'imagesFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'removeImagesFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeImagesFolderPath(message.folderPath);
                this._setupImagesFolderWatchers();
                await this._sendImagesDocsReady();
                const paths = service.getImagesFolderPaths();
                this.postMessage({ type: 'imagesFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }

            case 'listStitchFolders': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                const paths = service.getStitchFolderPaths();
                this.postMessage({ type: 'stitchFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'addStitchFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const picked = (typeof message.folderPath === 'string' && message.folderPath.trim())
                    ? message.folderPath.trim()
                    : await this._seams().ui.pickFolder('Add Stitch Folder');
                if (!picked) {
                    return { success: false, error: 'No folder selected' };
                }
                const service = this._getLocalFolderService(root);
                await service.addStitchFolderPath(picked);
                const paths = service.getStitchFolderPaths();
                this.postMessage({ type: 'stitchFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }
            case 'removeStitchFolder': {
                const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const service = this._getLocalFolderService(root);
                await service.removeStitchFolderPath(message.folderPath);
                const paths = service.getStitchFolderPaths();
                this.postMessage({ type: 'stitchFoldersListed', paths, workspaceRoot: root });
                return { success: true, paths, workspaceRoot: root };
            }

            case 'stitchPickAttachFiles': {
                try {
                    const result = await this._seams().ui.showOpenDialog({
                        canSelectFiles: true,
                        canSelectMany: true,
                        openLabel: 'Attach reference files',
                        filters: {
                            'Reference Files': ['png', 'jpg', 'jpeg', 'webp', 'html', 'htm', 'md']
                        }
                    });
                    if (!result || result.length === 0) {
                        return { success: false, files: [] };
                    }
                    const files = result.map(filePath => {
                        const ext = path.extname(filePath).toLowerCase().replace('.', '');
                        const name = path.basename(filePath);
                        const type = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image'
                            : ['html', 'htm'].includes(ext) ? 'html'
                            : 'markdown';
                        return { path: filePath, name, type };
                    });
                    this.postMessage({ type: 'stitchAttachedFilesPicked', files });
                    return { success: true, files };
                } catch (err: any) {
                    this._seams().ui.showErrorMessage('Failed to pick files: ' + err.message);
                    return { success: false, error: err.message || String(err) };
                }
            }

            case 'stitchGenerate':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        // The SDK has no root-level generate — a project is required.
                        if (!message.projectId) {
                            this.postMessage({ type: 'stitchError', error: 'Select a Stitch project before generating a screen.', workspaceRoot });
                            return;
                        }
                        const stitch = await loadStitch('');
                        const projectInstance = stitch.project(message.projectId);

                        // Upload reference files and augment prompt with markdown context
                        let augmentedPrompt = message.prompt || '';
                        const attachedFiles = message.attachedFiles || [];
                        for (const file of attachedFiles) {
                            if (file.type === 'image' || file.type === 'html') {
                                try {
                                    await projectInstance.upload(file.path);
                                } catch (uploadErr: any) {
                                    console.error(`Failed to upload ${file.name}:`, uploadErr);
                                }
                            } else if (file.type === 'markdown') {
                                try {
                                    const mdContent = await fs.promises.readFile(file.path, 'utf8');
                                    augmentedPrompt += `\n\n--- Design Context ---\n${mdContent}\n---`;
                                } catch (readErr: any) {
                                    console.error(`Failed to read ${file.name}:`, readErr);
                                }
                            }
                        }

                        const { screens, summary, suggestions } = await this._screenToolCall('generate_screen_from_text', {
                            projectId: message.projectId,
                            prompt: augmentedPrompt,
                            deviceType: message.deviceType,
                            modelId: message.modelId
                        }, message.projectId);
                        const screen = screens[0];
                        if (!screen) throw new Error('Stitch returned no screen for the generate request.');
                        this._activeScreens.set(screen.id, screen);
                        const formatted = await this._formatScreen(screen, workspaceRoot);
                        await this._attachScreenCommentary(formatted, message.projectId, workspaceRoot, summary, suggestions);
                        this.postMessage({ type: 'stitchScreenReady', screen: formatted, workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchEdit':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        // Edits can arrive from the Stitch HTML tab before the Stitch tab
                        // has loaded the project this session — fetch the screen on demand.
                        let screen = this._activeScreens.get(message.screenId);
                        if (!screen && message.projectId) {
                            const stitch = await loadStitch('');
                            screen = await stitch.project(message.projectId).getScreen(message.screenId);
                            if (screen) this._activeScreens.set(screen.id, screen);
                        }
                        if (!screen) throw new Error('Screen instance not found in memory cache.');
                        const { screens, summary, suggestions } = await this._screenToolCall('edit_screens', {
                            projectId: screen.projectId,
                            selectedScreenIds: [message.screenId],
                            prompt: message.prompt,
                            modelId: message.modelId
                        }, screen.projectId);
                        const updated = screens[0];
                        if (!updated) throw new Error('Stitch returned no screen for the edit request.');
                        this._activeScreens.set(updated.id, updated);
                        // Same-id edits leave stale cached assets that would mask the new
                        // render (disk wins in both cache lookups) — purge before formatting.
                        try {
                            const staleDir = this._getImageCacheDir(workspaceRoot, updated.projectId || screen.projectId);
                            await fs.promises.rm(path.join(staleDir, `${path.basename(updated.id)}.png`), { force: true });
                            await fs.promises.rm(path.join(staleDir, `${path.basename(updated.id)}.html`), { force: true });
                        } catch { /* cache purge is best-effort */ }
                        const formatted = await this._formatScreen(updated, workspaceRoot);
                        // The Stitch HTML tab reloads this screen's file when it hears
                        // stitchScreenReady — make sure the fresh HTML is on disk first.
                        if (formatted.htmlUrl) {
                            try {
                                const dir = this._getImageCacheDir(workspaceRoot, updated.projectId || screen.projectId);
                                await this._downloadToCache(formatted.htmlUrl, dir,
                                    path.join(dir, `${path.basename(updated.id)}.html`));
                                formatted.htmlPath = path.join(dir, `${path.basename(updated.id)}.html`);
                            } catch (e) {
                                console.error('Stitch edit HTML re-cache failed:', e);
                            }
                        }
                        await this._attachScreenCommentary(formatted, screen.projectId, workspaceRoot, summary, suggestions);
                        this.postMessage({ type: 'stitchScreenReady', screen: formatted, workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchVariants':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (this._stitchOperationLock) {
                        this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
                        return;
                    }
                    this._stitchOperationLock = true;
                    try {
                        // Variants can be launched from the Stitch HTML tab — fetch the
                        // source screen on demand if the Stitch tab hasn't loaded it.
                        let screen = this._activeScreens.get(message.screenId);
                        if (!screen && message.projectId) {
                            const stitch = await loadStitch('');
                            screen = await stitch.project(message.projectId).getScreen(message.screenId);
                            if (screen) this._activeScreens.set(screen.id, screen);
                        }
                        if (!screen) throw new Error('Screen instance not found in memory cache.');
                        const aspects = message.aspects?.length ? message.aspects : undefined;
                        const variantOptions = {
                            variantCount: message.count || 3,
                            creativeRange: message.creativeRange,
                            aspects
                        };
                        const { screens, summary, suggestions } = await this._screenToolCall('generate_variants', {
                            projectId: screen.projectId,
                            selectedScreenIds: [message.screenId],
                            prompt: message.prompt,
                            variantOptions,
                            modelId: message.modelId
                        }, screen.projectId);
                        const formatted = await Promise.all(screens.map(async (v: any) => {
                            this._activeScreens.set(v.id, v);
                            const f = await this._formatScreen(v, workspaceRoot);
                            // The commentary describes the variant batch — attach to each
                            await this._attachScreenCommentary(f, screen.projectId, workspaceRoot, summary, suggestions);
                            // The Stitch HTML tab refreshes its list on stitchScreensReady —
                            // land the variants' HTML on disk before announcing them.
                            if (f.htmlUrl) {
                                try {
                                    const dir = this._getImageCacheDir(workspaceRoot, v.projectId || screen.projectId);
                                    const target = path.join(dir, `${path.basename(v.id)}.html`);
                                    await this._downloadToCache(f.htmlUrl, dir, target);
                                    f.htmlPath = target;
                                } catch (e) {
                                    console.error('Stitch variant HTML cache failed:', e);
                                }
                            }
                            return f;
                        }));
                        this.postMessage({ type: 'stitchScreensReady', screens: formatted, workspaceRoot });
                    } finally {
                        this._stitchOperationLock = false;
                    }
                } catch (err: any) {
                    this.postMessage({ type: 'stitchError', error: err.message || String(err), workspaceRoot: message.workspaceRoot || this._getWorkspaceRoot() });
                }
                break;

            case 'stitchDownloadAsset':
                try {
                    const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot();
                    if (!workspaceRoot) throw new Error('No active workspace root found');
                    if (!message.url) {
                        throw new Error('No download URL is available for this asset yet — reload the project screens and try again.');
                    }

                    // basename() so a webview-supplied filename can't traverse out of the output dir
                    const safeFilename = path.basename(String(message.filename));
                    const isPng = safeFilename.endsWith('.png');

                    // Default to the same folder the screen PNGs already live in, so a screen's
                    // assets stay together in one place. A caller can still override via destination.
                    const activeScreen = message.screenId ? this._activeScreens.get(message.screenId) : undefined;
                    const projectId = activeScreen?.projectId || '';
                    let outputDir = projectId
                        ? this._getImageCacheDir(workspaceRoot, projectId)
                        : this._getImageCacheDir(workspaceRoot);
                    if (message.destination) {
                        const resolvedDest = path.resolve(message.destination);
                        const allRoots = this._getWorkspaceRoots();
                        let isAllowed = allRoots.some(r => resolvedDest === path.resolve(r) || resolvedDest.startsWith(path.resolve(r) + path.sep));
                        if (!isAllowed) {
                            throw new Error('Invalid download destination folder path');
                        }
                        outputDir = resolvedDest;
                    }
                    
                    await fs.promises.mkdir(outputDir, { recursive: true });

                    const targetPath = path.join(outputDir, safeFilename);

                    if (message.url.startsWith('file://')) {
                        const buffer = Buffer.from(await fs.promises.readFile(new URL(message.url)));
                        await fs.promises.writeFile(targetPath, buffer);
                    } else {
                        const res = await fetch(message.url);
                        if (isPng) {
                            const buffer = Buffer.from(await res.arrayBuffer());
                            await fs.promises.writeFile(targetPath, buffer);
                        } else {
                            const text = await res.text();
                            await fs.promises.writeFile(targetPath, Buffer.from(text, 'utf8'));
                        }
                    }

                    showTemporaryNotification(`Downloaded ${safeFilename} to ${path.basename(outputDir)}/`);
                    // Tell the webview where the file landed so it can offer "Open on web"
                    // (for HTML) without re-deriving the path.
                    this.postMessage({
                        type: 'stitchAssetDownloaded',
                        kind: isPng ? 'png' : 'html',
                        screenId: message.screenId,
                        path: targetPath
                    });
                    return { success: true, path: targetPath };
                } catch (err: any) {
                    this._seams().ui.showErrorMessage('Download failed: ' + err.message);
                    // A live preview may be waiting on this download — let it recover
                    // (show the placeholder + reload) instead of spinning forever.
                    this.postMessage({ type: 'stitchHtmlPreviewError', screenId: message.screenId, error: err.message || String(err) });
                    return { success: false, error: err.message || String(err) };
                }
            case 'stitchPreviewHtml':
                // Live-render a screen's downloaded HTML in the preview pane. Used as the
                // fallback for screens that never get a static screenshot (WebGL/animated
                // components aren't captured by Stitch's screenshot tool, so their
                // screenshot.downloadUrl stays empty forever — the HTML is the only render).
                try {
                    const htmlPath = path.resolve(String(message.htmlPath || ''));
                    // Same containment guard as downloads: only files inside a workspace root.
                    const allRoots = this._getWorkspaceRoots();
                    const isAllowed = allRoots.some(r => htmlPath.startsWith(path.resolve(r) + path.sep));
                    if (!isAllowed) throw new Error('Invalid preview file path');
                    await fs.promises.access(htmlPath, fs.constants.R_OK);

                    // Prefer a localhost URL — the iframe gets its own document origin, so
                    // inline WebGL scripts and CDN assets run outside the webview CSP.
                    let iframeSrc: string | undefined;
                    try {
                        const serveFolder = path.dirname(htmlPath);
                        const entry = await this._getOrCreateHtmlServer(serveFolder);
                        iframeSrc = this._buildLocalhostUrl(entry, serveFolder, htmlPath);
                    } catch {
                        iframeSrc = undefined;
                    }
                    let htmlContent: string | undefined;
                    let webviewUri: string | undefined;
                    if (!iframeSrc) {
                        htmlContent = await fs.promises.readFile(htmlPath, 'utf8');
                        webviewUri = this._panel?.webview.asWebviewUri(vscode.Uri.file(htmlPath)).toString();
                    }
                    this.postMessage({ type: 'stitchHtmlPreviewReady', screenId: message.screenId, iframeSrc, htmlContent, webviewUri });
                    return { success: true, iframeSrc, htmlContent, webviewUri };
                } catch (err: any) {
                    this.postMessage({ type: 'stitchHtmlPreviewError', screenId: message.screenId, error: err.message || String(err) });
                    return { success: false, error: err.message || String(err) };
                }
        }
    }

    private _isHtmlOrImageFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext);
    }

    private _isImageFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'].includes(ext);
    }

    private _isTextFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.md', '.txt', '.markdown', '.rst', '.adoc'].includes(ext);
    }

    private _isPolledTab(tab: string): boolean {
        return tab === 'html-preview' || tab === 'claude' || tab === 'images';
    }

    private _polledTabsAcrossSeats(): Set<string> {
        const tabs = new Set<string>();
        for (const seat of this._seats.values()) {
            if (seat.isExtensionWebview && !this._panel?.visible) {
                continue;
            }
            if (this._isPolledTab(seat.activeTab)) {
                tabs.add(seat.activeTab);
            }
        }
        return tabs;
    }

    private _reconcilePoll(): void {
        const polled = this._polledTabsAcrossSeats();
        if (polled.size > 0) {
            this._startExternalFilePoll();
        } else {
            this._stopExternalFilePoll();
        }
    }

    private _onVisibilityChanged(visible: boolean): void {
        this._reconcilePoll();
    }

    private _startExternalFilePoll(): void {
        if (this._externalFilePollTimer) return;
        const pathConfig = this._seams().pathConfig;
        const ms = pathConfig.getConfigNumber('design.externalFilePollMs', 4000);
        if (ms <= 0) return;
        this._externalFilePollTimer = setInterval(() => this._pollTick(), ms);
    }

    private _stopExternalFilePoll(): void {
        if (this._externalFilePollTimer) {
            clearInterval(this._externalFilePollTimer);
            this._externalFilePollTimer = undefined;
        }
    }

    private async _pollTick(): Promise<void> {
        const tabs = this._polledTabsAcrossSeats();
        if (!tabs.size) {
            this._stopExternalFilePoll();
            return;
        }

        try {
            const allRoots = this._getWorkspaceRoots();

            for (const tab of tabs) {
                const signatures: string[] = [];
                for (const root of allRoots) {
                    const service = this._getLocalFolderService(root);
                    let folders: string[] = [];
                    if (tab === 'html-preview') {
                        folders = service.getHtmlFolderPaths();
                    } else if (tab === 'claude') {
                        folders = service.getClaudeFolderPaths();
                    } else if (tab === 'images') {
                        folders = service.getImagesFolderPaths();
                    }

                    for (const dir of folders) {
                        const sigs = await this._getFolderSignature(dir, tab);
                        signatures.push(...sigs);
                    }
                }

                signatures.sort();
                const combined = signatures.join('\n');
                const hash = crypto.createHash('md5').update(combined).digest('hex');

                if (!this._polledTabsAcrossSeats().has(tab)) {
                    continue;
                }

                if (this._lastFolderSignature[tab] !== hash) {
                    this._lastFolderSignature[tab] = hash;
                    if (tab === 'html-preview') {
                        await this._sendHtmlDocsReady();
                    } else if (tab === 'claude') {
                        await this._sendClaudeDocsReady();
                    } else if (tab === 'images') {
                        await this._sendImagesDocsReady();
                    }
                }
            }

            // Preview-level refresh. The folder scan above only re-pushes LISTINGS;
            // the save listener and html/claude folder watchers exist only while an
            // extension panel has been opened — with the panel closed (watchers
            // disposed) or in the standalone host they are absent entirely. So the
            // poll also stats each live seat's registered html/claude preview
            // document and routes an mtime advance through the same keyed-debounce
            // re-push the watchers use. First sighting only seeds the baseline.
            for (const [origId, seat] of this._seats.entries()) {
                if (seat.isExtensionWebview && !this._panel?.visible) { continue; }
                const targets: Array<[{ sourceFolder: string; docId: string } | null, string]> = [
                    [seat.htmlPreview, 'html'],
                    [seat.claudePreview, 'claude'],
                ];
                for (const [preview, target] of targets) {
                    if (!preview) { continue; }
                    const rel = preview.docId.includes(':')
                        ? preview.docId.substring(preview.docId.indexOf(':') + 1)
                        : preview.docId;
                    const abs = path.resolve(preview.sourceFolder, rel);
                    let mtime: number;
                    try {
                        mtime = (await fs.promises.stat(abs)).mtimeMs;
                    } catch {
                        continue; // mid-write or deleted — try next tick
                    }
                    const key = `${origId}::${target}`;
                    const last = this._pollPreviewMtimes.get(key);
                    this._pollPreviewMtimes.set(key, mtime);
                    if (last !== undefined && mtime > last) {
                        this._autoRefreshHtmlPreview(abs);
                    }
                }
            }
        } catch (err) {
            // swallow to survive tick
        }
    }

    private async _getFolderSignature(dir: string, tab: string, depth: number = 0, seen: Set<string> = new Set()): Promise<string[]> {
        if (depth >= 10) return [];
        const resolved = path.resolve(dir);
        if (seen.has(resolved)) return [];
        seen.add(resolved);

        let entries: fs.Dirent[];
        try {
            entries = await Promise.race([
                fs.promises.readdir(dir, { withFileTypes: true }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('readdir timeout')), 5000))
            ]);
        } catch {
            return [];
        }

        const filterFn = (name: string): boolean => {
            if (tab === 'html-preview' || tab === 'claude') {
                return this._isHtmlOrImageFile(name);
            } else if (tab === 'images') {
                return this._isImageFile(name);
            }
            return false;
        };

        const filePromises: Promise<string>[] = [];
        const subfolderPromises: Promise<string[]>[] = [];

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            if (entry.isSymbolicLink()) continue;
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.switchboard') continue;
                // Include the directory itself in the signature so that an
                // externally-created empty subfolder (which the list methods render
                // as a folder node) is detected even when it contains no matching
                // files yet.
                filePromises.push(Promise.resolve(`${entry.name}|dir|dir`));
                subfolderPromises.push(this._getFolderSignature(fullPath, tab, depth + 1, seen));
            } else if (entry.isFile() && filterFn(entry.name)) {
                filePromises.push(
                    Promise.race([
                        fs.promises.stat(fullPath),
                        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stat timeout')), 5000))
                    ]).then(stat => {
                        return `${entry.name}|${stat.size}|${stat.mtimeMs}`;
                    }).catch(() => {
                        return `${entry.name}|error|error`;
                    })
                );
            }
        }

        const [files, subfolders] = await Promise.all([
            Promise.all(filePromises),
            Promise.all(subfolderPromises)
        ]);

        const results = [...files];
        for (const sf of subfolders) {
            results.push(...sf);
        }
        return results;
    }

    private async _buildAndSendPreview(opts: {
        sourceId: string;
        sourceFolder?: string;
        docId: string;
        requestId: number;
        target?: string;
        isAutoRefreshed?: boolean;
        replyChannel?: 'http' | 'webview' | undefined;
        originatorId?: string;
    }): Promise<{ success: true; payload: any } | { success: false; error: string; payload?: any }> {
        const { sourceId, sourceFolder, docId, requestId, target, isAutoRefreshed, replyChannel, originatorId } = opts;
        try {
            if (!sourceFolder) throw new Error('sourceFolder is required');
            const relativePath = docId.includes(':')
                ? docId.substring(docId.indexOf(':') + 1)
                : docId;

            // Only configured design/html/claude/images folders may be read from.
            const allowedFolders = new Set<string>();
            for (const root of this._getWorkspaceRoots()) {
                try {
                    const svc = this._getLocalFolderService(root);
                    svc.getDesignFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                    svc.getHtmlFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                    svc.getClaudeFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                    svc.getImagesFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                    // Admit per-project Stitch cache dirs so the stitch-html-folder sourceId
                    // can read cached HTML. Resolved server-side from project IDs — never from
                    // webview-supplied paths.
                    const db = KanbanDatabase.forWorkspace(root);
                    await db.ensureReady();
                    const projects = await db.getStitchProjects();
                    for (const p of projects) {
                        allowedFolders.add(path.resolve(this._getImageCacheDir(root, p.id)));
                    }
                } catch {}
            }
            const resolvedFolder = path.resolve(sourceFolder);
            if (!allowedFolders.has(resolvedFolder)) {
                console.error('[DesignPanel] preview folder rejected', {
                    sourceId, resolvedFolder,
                    roots: this._getWorkspaceRoots(),
                    allowedCount: allowedFolders.size
                });
                throw new Error('sourceFolder is not a configured design/html/claude/images folder');
            }
            const absPath = path.resolve(resolvedFolder, relativePath);
            if (absPath !== resolvedFolder && !absPath.startsWith(resolvedFolder + path.sep)) {
                throw new Error('Invalid file path');
            }

            // Turn an opaque ENOENT from the readFile below into a readable message. The
            // "Rebuild Cache" hint is stitch-only — that button exists nowhere else, so
            // offering it on a design/image doc would be a confidently wrong
            // instruction.
            try {
                await fs.promises.stat(absPath);
            } catch {
                throw new Error(sourceId === 'stitch-html-folder'
                    ? 'HTML file not found on disk — try Rebuild Cache'
                    : `File not found on disk: ${path.basename(relativePath)}`);
            }

            const fileExt = path.extname(relativePath).toLowerCase();
            const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(fileExt);
            const isHtmlFile = fileExt === '.html' || fileExt === '.htm';

            const workspaceRoot = this._getWorkspaceRoot() || '';
            const getAssetUrl = (p: string) => {
                const relative = `/design/asset?root=${encodeURIComponent(workspaceRoot)}&path=${encodeURIComponent(p)}`;
                return this._absoluteApiUrl(relative)
                    ?? (this._panel ? this._panel.webview.asWebviewUri(vscode.Uri.file(p)).toString() : relative);
            };

            let fileContent = '';
            let webviewUri: string | undefined;
            if (isImage) {
                webviewUri = getAssetUrl(absPath);
            } else {
                fileContent = await fs.promises.readFile(absPath, 'utf8');
                if (isHtmlFile) {
                    // HTML keeps the webview-URI path only. Headless, the browser renders
                    // HTML through the localhost `iframeSrc` below (a real directory-rooted
                    // origin, so relative asset refs resolve); /design/asset is an
                    // image-only route and would be a dead base href here.
                    webviewUri = this._panel
                        ? this._panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString()
                        : undefined;
                }
            }

            let iframeSrc: string | undefined;
            if (isHtmlFile) {
                try {
                    const serverEntry = await this._getOrCreateHtmlServer(resolvedFolder);
                    iframeSrc = this._buildLocalhostUrl(serverEntry, resolvedFolder, absPath);
                } catch {
                    iframeSrc = undefined;
                }
            }

            const fileTypeMap: Record<string, string> = {
                '.json': 'json',
                '.yaml': 'yaml', '.yml': 'yaml',
                '.md': 'markdown', '.markdown': 'markdown', '.txt': 'markdown',
                '.html': 'html', '.htm': 'html'
            };
            const fileType = isImage ? 'image' : (fileTypeMap[fileExt] || 'text');

            let parsedJson: any = undefined;
            if (fileType === 'yaml') {
                try {
                    const yaml = require('js-yaml');
                    parsedJson = yaml.load(fileContent);
                } catch {}
            }

            const payload: any = {
                type: 'previewReady',
                sourceId,
                requestId,
                target,
                content: isImage ? '' : fileContent,
                docName: path.basename(relativePath),
                filePath: absPath,
                fileType,
                parsedJson,
                isImage,
                webviewUri,
                iframeSrc,
                htmlContent: isHtmlFile ? this._injectLocalCsp(this._injectIntoHead(fileContent, DesignPanelProvider._INSPECTOR_SCRIPT)) : undefined,
                isAutoRefreshed: isAutoRefreshed || undefined,
                originatorId: originatorId || undefined
            };
            this._postReply(payload, replyChannel);
            return { success: true, payload };
        } catch (err: any) {
            const error = err.message || String(err);
            // Auto-refresh (requestId === -1) must fail silently — the file may be mid-write.
            if (requestId === -1) return { success: false, error };
            const payload: any = {
                type: 'previewError',
                sourceId,
                requestId,
                error,
                originatorId: originatorId || undefined
            };
            this._postReply(payload, replyChannel);
            return { success: false, error, payload };
        }
    }

    private _registerSaveTextDocListener(): void {
        if (this._saveTextDocListener) return;
        this._saveTextDocListener = vscode.workspace.onDidSaveTextDocument((document) => {
            let hasAnyPreview = false;
            for (const seat of this._seats.values()) {
                if (seat.htmlPreview || seat.claudePreview || seat.stitchHtmlPreview || seat.designPreview) {
                    hasAnyPreview = true;
                    break;
                }
            }
            if (!hasAnyPreview) return;
            this._autoRefreshHtmlPreview(document.uri.fsPath);
        });
        this._disposables.push(this._saveTextDocListener);
    }

    /**
     * Normalize a preview path for comparison: resolve, normalize separators/
     * trailing slashes, resolve symlinks via realpathSync (falls back to the
     * normalized path on transient ENOENT during mid-write), and lowercase on
     * darwin (case-insensitive filesystem). VS Code Issue #162498 documents
     * that trailing-slash / symlink / case differences cause RelativePattern
     * matching and exact-string compares to silently fail.
     */
    private _normalizePreviewPath(p: string): string {
        let normalized = path.normalize(p);
        try {
            normalized = fs.realpathSync(normalized);
        } catch {
            // Mid-write ENOENT or transient stat failure — keep the normalized
            // path; the comparison may miss this fire but the next one succeeds.
        }
        if (process.platform === 'darwin') {
            normalized = normalized.toLowerCase();
        }
        return normalized;
    }

    private _autoRefreshHtmlPreview(changedFsPath: string): void {
        const changedPath = this._normalizePreviewPath(path.resolve(changedFsPath));

        for (const [origId, seat] of this._seats.entries()) {
            const checkAndRefresh = (active: typeof seat.htmlPreview, target?: string) => {
                if (!active) return;
                const relativePath = active.docId.includes(':')
                    ? active.docId.substring(active.docId.indexOf(':') + 1)
                    : active.docId;
                const activePath = this._normalizePreviewPath(path.resolve(active.sourceFolder, relativePath));

                if (changedPath !== activePath) return;

                const debounceKey = `${origId}::${target || 'html'}`;
                const existing = this._autoRefreshDebounces.get(debounceKey);
                if (existing) clearTimeout(existing);

                const timer = setTimeout(() => {
                    this._autoRefreshDebounces.delete(debounceKey);

                    const currentSeat = this._seats.get(origId);
                    if (!currentSeat) return;
                    const current = target === 'claude' ? currentSeat.claudePreview
                        : target === 'stitch-html' ? currentSeat.stitchHtmlPreview
                        : target === 'design' ? currentSeat.designPreview
                        : currentSeat.htmlPreview;
                    if (!current) return;

                    const currentRel = current.docId.includes(':')
                        ? current.docId.substring(current.docId.indexOf(':') + 1)
                        : current.docId;
                    const currentPath = this._normalizePreviewPath(path.resolve(current.sourceFolder, currentRel));
                    if (currentPath !== activePath) return;

                    this._buildAndSendPreview({
                        sourceId: current.sourceId,
                        sourceFolder: current.sourceFolder,
                        docId: current.docId,
                        target,
                        requestId: -1,
                        isAutoRefreshed: true,
                        originatorId: origId
                    });
                }, 300);
                this._autoRefreshDebounces.set(debounceKey, timer);
            };

            checkAndRefresh(seat.htmlPreview);
            checkAndRefresh(seat.claudePreview, 'claude');
            checkAndRefresh(seat.stitchHtmlPreview, 'stitch-html');
            checkAndRefresh(seat.designPreview, 'design');
        }
    }

    /**
     * Resolve a folder path (absolute, or <index>:<relativePath> subfolder id)
     * to an absolute path, verify it sits within a configured design/html/images
     * folder, and copy it to the clipboard so the user can paste it into an agent prompt.
     * Mirrors PlanningPanelProvider._handleLinkToFolder.
     */
    private async _handleLinkToFolder(workspaceRoot: string | undefined, folderPath: string): Promise<void> {
        try {
            if (!folderPath) {
                throw new Error('No folder path provided');
            }

            // Build the allowed-folder set across ALL roots up front.
            // The frontend sends a bare absolute path with no owning-root hint, and
            // DesignPanelProvider has no _getLocalFolderServiceForFolder helper.
            // Validating against a single root would reject legitimate folders from non-primary roots.
            // So we make both resolution and validation root-agnostic.
            const allowedPaths: string[] = [];
            for (const root of this._getWorkspaceRoots()) {
                const svc = this._getLocalFolderService(root);
                allowedPaths.push(
                    ...svc.getDesignFolderPaths(),
                    ...svc.getHtmlFolderPaths(),
                    ...svc.getImagesFolderPaths(),
                );
            }

            let resolvedFolder = '';

            if (/^\d+:/.test(folderPath)) {
                // Subfolder id `<index>:<relativePath>` — join against every allowed
                // base and take the first that exists on disk.
                const relativePath = folderPath.substring(folderPath.indexOf(':') + 1);
                for (const base of allowedPaths) {
                    const candidate = path.join(base, relativePath);
                    if (fs.existsSync(candidate)) {
                        resolvedFolder = candidate;
                        break;
                    }
                }
                if (!resolvedFolder) throw new Error('Subfolder not found');
            } else {
                // Frontend sends already-resolved absolute paths.
                const svc = this._getLocalFolderService(workspaceRoot || this._getWorkspaceRoots()[0] || '');
                resolvedFolder = svc.resolveFolderPath(folderPath);
            }

            const isWithinAllowed = allowedPaths.some(
                p => resolvedFolder === p || resolvedFolder.startsWith(p + path.sep)
            );
            if (!isWithinAllowed) {
                throw new Error('Folder is not within a configured folder');
            }
            if (!fs.existsSync(resolvedFolder)) {
                throw new Error('Folder does not exist');
            }
            await this._seams().clipboard.writeText(resolvedFolder);
            showTemporaryNotification(`Folder path copied to clipboard: ${resolvedFolder}`);
        } catch (err) {
            this._seams().ui.showErrorMessage(`Failed to link to folder: ${String(err)}`);
        }
    }
}
