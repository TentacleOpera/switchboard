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
};

const VALID_SURFACES = new Set<string>(Object.values(SURFACES));

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

    /**
     * Validate Origin + token, then complete the WS upgrade.
     */
    public async handleUpgrade(req: any, socket: any, head: any): Promise<void> {
        if (!this._wss) {
            this._wss = new WebSocketServer({ noServer: true });
        }

        const auth = await authorizeWsUpgrade(req, () => this._options.getAuthToken());
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
                try {
                    let state = await this._options.getFullState(meta.project);
                    if (Array.isArray(state) && meta.surfaces) {
                        state = state.filter((item: any) => !item.surface || meta.surfaces!.has(item.surface));
                    }
                    this._safeSend(ws, {
                        type: '__resync',
                        seq: meta.seq, // 0 — the baseline; broadcasts increment from here
                        payload: state,
                    });
                } catch (err) {
                    console.error('[wsHub] resync error:', err);
                }
            }

            // Join the broadcast set only now that the snapshot is on the wire.
            this._connections.add(meta);

            const handleDisconnect = () => {
                if (this._connections.has(meta)) {
                    this._connections.delete(meta);
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
