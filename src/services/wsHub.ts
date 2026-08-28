import type { Server } from 'http';
import { URL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { authorizeWsUpgrade } from './wsUpgradeAuth';


/**
 * wsHub — Feature A · A2a
 *
 * WebSocket server sharing the existing LocalApiServer HTTP port. Provides:
 *  - Token-gated upgrade (Origin header + bearer token from ?token= query param
 *    validated BEFORE ws.handleUpgrade() completes).
 *  - Per-connection ordered push queue with monotonic sequence numbers.
 *  - Full-state resync on every (re)connect.
 *  - broadcast(verb, payload) — the host→UI push method external clients use.
 *
 * Security: an unauthenticated upgrade path is local RCE once B3's terminal
 * streams ride the hub. The upgrade handler validates Origin (DNS-rebinding
 * mitigation) + token before completing the upgrade. Bad requests are
 * socket.destroy()'d before the upgrade completes.
 *
 * Ordering: WS has no built-in ordering guarantee (unlike VS Code's implicit
 * postMessage ordering). Each connection tracks a monotonic sequence number;
 * clients use it to detect gaps and request a resync. A full-state resync is
 * pushed on every (re)connect so a dropped connection converges rather than
 * going silently stale.
 */

/**
 * The push-routing vocabulary. Producers tag a push with one of these; a
 * connection declares which ones it wants at upgrade time and the hub drops the
 * rest before they cost a send, a frame and a `JSON.parse` in the panel.
 *
 * `common` is not optional garnish — theme, status messages and agent-completion
 * are genuinely cross-panel, and a one-surface-per-panel map silently swallows
 * them. Every panel's list includes it.
 *
 * `project` is in the vocabulary because PlanningPanelProvider already tags
 * pushes with it, but see PANEL_SURFACES for why no panel SUBSCRIBES to it.
 */
export const SURFACES = {
    common: 'common',
    kanban: 'kanban',
    terminals: 'terminals',
    planning: 'planning',
    project: 'project',
    design: 'design',
    setup: 'setup',
    memo: 'memo',
    tickets: 'tickets',
    connections: 'connections',
} as const;

export type SurfaceType = typeof SURFACES[keyof typeof SURFACES];

/**
 * Panel id (`document.body.dataset.panel`, stamped by headlessPanelHtml.ts) →
 * the surfaces that panel subscribes to. Mirrored in `webview/transport.js`,
 * which cannot import from a .ts module; the two must be changed together.
 *
 * DELIBERATELY ABSENT: `project`. The Project panel consumes messages that
 * PlanningPanelProvider tags `'planning'` (`saveFileContentResult`,
 * `chatPromptCopied` — project.js:1033, :796) as well as ones it tags
 * `'project'`, because one provider serves both panels. Declaring a set for it
 * would drop half of them and silently break saving in the Project panel. An
 * undeclared panel receives EVERYTHING (fail-open), which is correct until the
 * provider's tagging is untangled. Do not "complete" this map without fixing
 * that first.
 */
export const PANEL_SURFACES: Record<string, string[]> = {
    kanban: [SURFACES.kanban, SURFACES.common],
    terminals: [SURFACES.terminals, SURFACES.common],
    planning: [SURFACES.planning, SURFACES.common],
    design: [SURFACES.design, SURFACES.common],
    setup: [SURFACES.setup, SURFACES.common],
    memo: [SURFACES.memo, SURFACES.common],
    tickets: [SURFACES.tickets, SURFACES.common],
    connections: [SURFACES.connections, SURFACES.common],
};

const VALID_SURFACES = new Set<string>(Object.values(SURFACES));

/** Upper bound on the connect-time snapshot. Generous on purpose: the standalone
 *  snapshot is four sql.js reads producing the whole board (~84ms measured, and the
 *  cockpit opens one connection per mounted panel, so the Nth caller queues behind
 *  the others). This is a stall backstop, not a latency budget. */
const RESYNC_TIMEOUT_MS = 5000;

/** Upper bound on the auth gate before the 101 is written. The only await before
 *  `_wss.handleUpgrade` is `authorizeWsUpgrade`, and a stalled token read (notably
 *  VS Code SecretStorage under the extension host) leaves the client in CONNECTING
 *  forever on Chromium. */
const UPGRADE_AUTH_TIMEOUT_MS = 3000;

const WS_DEBUG = process.env.SWITCHBOARD_WS_DEBUG === '1';
function wsDebugLog(msg: string): void { if (WS_DEBUG) { console.log(`[wsHub] ${msg}`); } }

export interface WsHubOptions {
    /** The http.Server to attach the WS upgrade handler to. */
    server: Server;
    /** Returns the current auth token for bearer validation. */
    getAuthToken: () => Promise<string>;
    /**
     * Full-state snapshot provider — called on every new connection (and
     * reconnect) to push a resync, rendered for that connection's declared
     * project scope. The result is sent as a single
     * `{type:'__resync', seq:0, payload}` message before any broadcast
     * pushes, so the client converges to the current state.
     */
    getFullState?: (scope?: string | null) => Promise<any>;
    /**
     * Keepalive ping cadence in ms (default 30000). A connection whose pong has
     * not arrived by the next tick is terminate()d — the `ws` FAQ pattern that
     * reaps half-open sockets abrupt client death leaves behind. Overridable so
     * tests can exercise the loop without 30s waits; production callers omit it.
     */
    pingIntervalMs?: number;
    /**
     * Bind policy for the Host/Origin allowlist on WS upgrades. Defaults to
     * loopback-only. A tailnet policy widens the accepted set in step with the
     * HTTP guard (LocalApiServer._isAllowedHost), so the board's state socket
     * accepts the same Host set the page that opened it sent.
     */
    bindPolicy?: import('../utils/loopbackHostname').BindPolicy;
    /**
     * True when this upgrade arrived on the tailnet listener. When true the
     * token check is skipped (decision 4), scoped to that listener. Identified
     * by the socket's `localAddress` matching the bound tailnet address.
     */
    isTailnetUpgrade?: (req: any) => boolean;
}

/** A push payload: either a plain message object (composed once, sent to every
 *  connection) or a `(scope) => message` factory rendered per distinct declared
 *  scope. Only scope-dependent push types pay the factory cost. */
export type ScopedPayload = any | ((scope: string | null | undefined) => any);

interface ConnectionMeta {
    ws: WebSocket;
    seq: number; // last sent sequence number on this connection
    originatorId?: string;
    isAlive?: boolean;
    /** This connection's declared project scope. `undefined` = never declared →
     *  host renders with the workspace singleton (pre-scoping behaviour);
     *  `null` = explicitly declared "no project filter". The distinction is
     *  load-bearing — do not collapse the two. */
    project?: string | null;
    surfaces?: Set<string>;
    /** True when the connect-time snapshot timed out and no late snapshot was
     *  eligible. Surfaced by getConnectionInfo() — a client in this state is
     *  subscribed but never received a baseline. */
    resyncFailed?: boolean;
}

export class WsHub {
    private _wss: WebSocketServer | null = null;
    private _options: WsHubOptions;
    private _connections: Set<ConnectionMeta> = new Set();
    private _disconnectListeners: Set<(originatorId: string) => void> = new Set();
    private _pingInterval: NodeJS.Timeout | null = null;

    constructor(options: WsHubOptions) {
        this._options = options;
    }

    onDisconnect(cb: (originatorId: string) => void): () => void {
        this._disconnectListeners.add(cb);
        return () => { this._disconnectListeners.delete(cb); };
    }

    /**
     * Attach the WS upgrade handler to the HTTP server. Must be called after
     * the HTTP server is listening.
     */
    attach(autoListen: boolean = true): void {
        this._wss = new WebSocketServer({ noServer: true });

        if (autoListen) {
            this._options.server.on('upgrade', async (req, socket, head) => {
                try {
                    await this.handleUpgrade(req, socket, head);
                } catch (err) {
                    console.error('[wsHub] upgrade error:', err);
                    try { socket.destroy(); } catch { /* already gone */ }
                }
            });
        }

        if (!this._pingInterval) {
            this._pingInterval = setInterval(() => {
                for (const meta of this._connections) {
                    if (meta.isAlive === false) {
                        console.warn(`[wsHub] reaping connection with no pong: originatorId=${meta.originatorId || 'unknown'}, `
                            + `surfaces=${meta.surfaces ? [...meta.surfaces].join(',') : 'all'}`);
                        try { meta.ws.terminate(); } catch { /* ignore */ }
                    } else {
                        meta.isAlive = false;
                        try { meta.ws.ping(); } catch { /* ignore */ }
                    }
                }
            }, this._options.pingIntervalMs ?? 30000);
        }
    }

    // Cookie parsing, Host/Origin allowlisting and the constant-time token compare
    // used to live here as private methods. They now live in wsUpgradeAuth.ts and
    // are shared with the terminal gateway — deliberately deleted rather than left
    // behind, so the next auth fix has exactly one place to land.

    private _filterResync(state: any, meta: ConnectionMeta): any {
        if (Array.isArray(state) && meta.surfaces) {
            return state.filter((item: any) => !item.surface || meta.surfaces!.has(item.surface));
        }
        return state;
    }

    /**
     * Validate Origin + token, then complete the WS upgrade.
     */
    public async handleUpgrade(req: any, socket: any, head: any): Promise<void> {
        if (!this._wss) {
            this._wss = new WebSocketServer({ noServer: true });
        }

        // A stalled token read must become a 503 the client can see, never silence.
        // Below this line the socket is connected with no HTTP response written, and
        // Chromium will wait in CONNECTING indefinitely for one — so failing loudly
        // and fast is strictly better than failing open or failing slow. Mirrors
        // LocalApiServer.start()'s listen race.
        let auth: { authorized: boolean; statusCode?: number; reason?: string };
        let authTimer: NodeJS.Timeout | undefined;
        try {
            const authPromise = authorizeWsUpgrade(req, () => this._options.getAuthToken(), {
                bindPolicy: this._options.bindPolicy,
                isTailnetUpgrade: this._options.isTailnetUpgrade,
            });
            const authTimeout = new Promise<never>((_resolve, reject) => {
                authTimer = setTimeout(() => reject(new Error('upgrade auth timeout')), UPGRADE_AUTH_TIMEOUT_MS);
            });
            auth = await Promise.race([authPromise, authTimeout]);
            if (authTimer) { clearTimeout(authTimer); }
        } catch (err) {
            if (authTimer) { clearTimeout(authTimer); }
            console.error('[wsHub] upgrade auth did not settle — refusing the upgrade:', err);
            auth = { authorized: false, statusCode: 503, reason: 'Auth Unavailable' };
        }
        if (!auth.authorized) {
            const status = auth.statusCode || 401;
            const msg = auth.reason || 'Unauthorized';
            socket.write(`HTTP/1.1 ${status} ${msg}\r\n\r\n`);
            socket.destroy();
            return;
        }

        const reqUrl = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);

        // All checks passed — complete the upgrade.
        this._wss.handleUpgrade(req, socket, head, async (ws) => {
            const originatorId = reqUrl.searchParams.get('originatorId') || undefined;
            // `?scope=` absent → undefined (never declared → singleton fallback).
            // `?scope=` present but empty → null (explicitly "no project filter") —
            // this is how a reconnecting all-projects client re-declares itself.
            const initialScope = reqUrl.searchParams.has('scope')
                ? (reqUrl.searchParams.get('scope') || null)
                : undefined;

            // Unknown surfaces are DISCARDED, not stored: an unrecognised name must
            // never act as a wildcard, and an unbounded set of client-supplied strings
            // held per connection is a free memory amplifier.
            //
            // `undefined` means "never declared" → receives everything. A declaration
            // that survives filtering with nothing left (`?surfaces=`, or an all-unknown
            // list from a newer client against an older server) collapses back to
            // undefined rather than to an empty set — an empty set would mean "deliver
            // nothing tagged", i.e. a connection that goes silently deaf. Fail open is
            // the only safe reading of a declaration we could not understand.
            const rawSurfaces = reqUrl.searchParams.get('surfaces');
            let surfaces: Set<string> | undefined;
            if (rawSurfaces !== null) {
                const parsed = new Set(
                    rawSurfaces.split(',')
                        .map(s => s.trim())
                        .filter(s => VALID_SURFACES.has(s))
                );
                surfaces = parsed.size > 0 ? parsed : undefined;
            }

            const meta: ConnectionMeta = { ws, seq: 0, originatorId, isAlive: true, project: initialScope, surfaces };

            ws.on('pong', () => {
                meta.isAlive = true;
            });

            ws.on('message', (raw) => {
                if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
                const text = raw.toString();
                if (text.length > 4096) return;
                let msg: any;
                try { msg = JSON.parse(text); } catch { return; }
                if (!msg || msg.type !== '__scope') return;
                const p = msg.project;
                if (p !== null && typeof p !== 'string') return;
                meta.project = p;
            });

            // Subscribe-AFTER-snapshot. The full-state resync (seq 0) is sent BEFORE
            // this connection joins `_connections`, so no broadcast can interleave
            // ahead of the snapshot. If we added `meta` first, a broadcast() during
            // the getFullState() await window would send a delta (seq 1) before the
            // resync — whose hardcoded seq then clobbered the increment — and the
            // client would apply the older snapshot last and go silently stale (the
            // exact ordering hazard the plan flags). Every broadcast after this point
            // increments strictly monotonically from the snapshot baseline.
            if (this._options.getFullState) {
                const snapshot = Promise.resolve()
                    .then(() => this._options.getFullState!(meta.project));
                let timer: NodeJS.Timeout | undefined;
                const timeout = new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`resync exceeded ${RESYNC_TIMEOUT_MS}ms`)),
                        RESYNC_TIMEOUT_MS
                    );
                });
                try {
                    const state = await Promise.race([snapshot, timeout]);
                    this._safeSend(ws, {
                        type: '__resync',
                        seq: meta.seq, // 0 — the baseline; broadcasts increment from here
                        payload: this._filterResync(state, meta),
                    });
                } catch (err) {
                    console.error('[wsHub] resync did not complete — joining the broadcast set anyway:', err);
                    meta.resyncFailed = true;
                    // A LATE snapshot may still be useful, but only while nothing has
                    // been sent on this connection: a seq-0 __resync arriving behind a
                    // seq-1 delta is exactly the clobber the ordering comment warns
                    // about, and the client would apply the older state last.
                    snapshot.then((state) => {
                        if (meta.seq !== 0) { return; }
                        meta.resyncFailed = false;
                        this._safeSend(ws, {
                            type: '__resync',
                            seq: 0,
                            payload: this._filterResync(state, meta),
                        });
                    }).catch(() => { /* the race already logged it */ });
                } finally {
                    // Mirrors LocalApiServer.start()'s race — an un-cleared timer keeps a
                    // 5s handle alive per connection and fires a no-op reject later.
                    if (timer) { clearTimeout(timer); }
                }
            }

            // Join the broadcast set — now unconditional.
            this._connections.add(meta);
            wsDebugLog(`connection established: originatorId=${originatorId || 'unknown'}, `
                + `surfaces=${surfaces ? [...surfaces].join(',') : 'all'}, `
                + `scope=${initialScope === undefined ? 'undeclared' : initialScope === null ? 'null' : initialScope}, `
                + `resyncFailed=${meta.resyncFailed === true}, total=${this._connections.size}`);

            const handleDisconnect = () => {
                if (this._connections.has(meta)) {
                    this._connections.delete(meta);
                    console.warn(`[wsHub] connection closed: originatorId=${meta.originatorId || 'unknown'}, `
                        + `surfaces=${meta.surfaces ? [...meta.surfaces].join(',') : 'all'}, `
                        + `remaining=${this._connections.size}`);
                    if (meta.originatorId) {
                        for (const listener of Array.from(this._disconnectListeners)) {
                            try { listener(meta.originatorId); } catch (e) { console.error('[wsHub] disconnect listener error:', e); }
                        }
                    }
                }
            };

            ws.on('close', handleDisconnect);
            ws.on('error', (err) => {
                console.error('[wsHub] connection error:', err);
                handleDisconnect();
            });
        });
    }

    private _safeSend(ws: WebSocket, data: any): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    /**
     * Broadcast a push message to all connected clients. Each connection
     * gets its own monotonic sequence number so clients can detect gaps.
     * A factory payload is rendered once per DISTINCT declared scope —
     * undefined (never declared → singleton fallback) and null (declared
     * "no project") are DIFFERENT scopes and must never share a render.
     */
    broadcast(verb: string, payload?: ScopedPayload, surface?: string): void {
        const isFactory = typeof payload === 'function';
        const rendered = new Map<string, any>();
        for (const meta of this._connections) {
            // Deliver unless ALL THREE hold: the push is tagged, the connection
            // declared a set, and the tag is not in it. Untagged → everyone (roughly
            // half the producers pass no surface, and treating that as "no
            // subscribers" would delete them all). Undeclared → everyone (released
            // clients predate this parameter).
            //
            // seq is deliberately NOT incremented on the skip path. Clients use seq to
            // detect dropped pushes; incrementing here would show a filtered
            // connection a permanent gap on every push it was never meant to see.
            if (surface && meta.surfaces && !meta.surfaces.has(surface)) {
                continue;
            }
            let body = payload;
            if (isFactory) {
                const key = meta.project === undefined ? '\u0000undeclared'
                    : meta.project === null ? '\u0000null'
                        : `p:${meta.project}`;
                if (!rendered.has(key)) {
                    rendered.set(key, (payload as Function)(meta.project));
                }
                body = rendered.get(key);
            }
            if (WS_DEBUG && verb === 'terminalsChanged') {
                wsDebugLog(`-> terminalsChanged to originatorId=${meta.originatorId || 'unknown'}, seq=${meta.seq + 1}`);
            }
            meta.seq += 1;
            this._safeSend(meta.ws, {
                type: verb,
                seq: meta.seq,
                // `surface` names the UI surface this push belongs to (e.g. 'kanban',
                // 'planning', 'devDocs') so a remote client can route/filter a single
                // WS stream that carries pushes from every panel. Omitted → undefined.
                surface,
                payload: body,
            });
        }
    }

    /**
     * Push a message to a specific connection (by ws reference). Used when
     * a verb's reply should go to the requesting connection only.
     */
    send(ws: WebSocket, verb: string, payload?: any): void {
        const meta = Array.from(this._connections).find(m => m.ws === ws);
        if (meta) {
            meta.seq += 1;
            this._safeSend(ws, { type: verb, seq: meta.seq, payload });
        }
    }

    /** Number of currently connected clients. */
    get connectionCount(): number {
        return this._connections.size;
    }

    /**
     * Diagnostic roster. `pingAcked` is the reaper's bookkeeping, NOT "the socket is
     * open": it is set false on every ping and true on the pong, so it reads false
     * for a perfectly healthy connection for part of each interval. Do not diagnose
     * a dead connection from one false reading. Presence in this array is the
     * load-bearing fact — it means the connection is in the broadcast set.
     */
    public getConnectionInfo(): Array<{
        originatorId?: string; surfaces?: string[]; pingAcked?: boolean;
        project?: string | null; seq: number; resyncFailed?: boolean;
    }> {
        return Array.from(this._connections).map(m => ({
            originatorId: m.originatorId,
            surfaces: m.surfaces ? [...m.surfaces] : undefined,
            pingAcked: m.isAlive,
            project: m.project,
            seq: m.seq,
            resyncFailed: m.resyncFailed === true,
        }));
    }

    /** Close all connections and shut down the WS server. */
    close(): void {
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        for (const meta of this._connections) {
            try { meta.ws.close(); } catch { /* ignore */ }
        }
        this._connections.clear();
        if (this._wss) {
            this._wss.close();
            this._wss = null;
        }
    }
}
