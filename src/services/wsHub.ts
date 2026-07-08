import type { Server } from 'http';
import { URL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

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

export interface WsHubOptions {
    /** The http.Server to attach the WS upgrade handler to. */
    server: Server;
    /** Returns the current auth token for bearer validation. */
    getAuthToken: () => Promise<string>;
    /**
     * Full-state snapshot provider — called on every new connection (and
     * reconnect) to push a resync. The result is sent as a single
     * `{type:'__resync', seq:0, payload}` message before any broadcast
     * pushes, so the client converges to the current state.
     */
    getFullState?: () => Promise<any>;
}

interface ConnectionMeta {
    ws: WebSocket;
    seq: number; // last sent sequence number on this connection
}

export class WsHub {
    private _wss: WebSocketServer | null = null;
    private _options: WsHubOptions;
    private _connections: Set<ConnectionMeta> = new Set();

    constructor(options: WsHubOptions) {
        this._options = options;
    }

    /**
     * Attach the WS upgrade handler to the HTTP server. Must be called after
     * the HTTP server is listening.
     */
    attach(): void {
        this._wss = new WebSocketServer({ noServer: true });

        this._options.server.on('upgrade', async (req, socket, head) => {
            try {
                await this._handleUpgrade(req, socket, head);
            } catch (err) {
                console.error('[wsHub] upgrade error:', err);
                try { socket.destroy(); } catch { /* already gone */ }
            }
        });
    }

    /**
     * Validate Origin + token, then complete the WS upgrade.
     */
    private async _handleUpgrade(req: any, socket: any, head: any): Promise<void> {
        // Origin validation — DNS-rebinding mitigation. Only allow localhost origins
        // (or no origin, which non-browser clients like curl don't send).
        const origin = req.headers['origin'];
        if (origin) {
            if (!this._isLocalhostOrigin(origin)) {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();
                return;
            }
        }

        // Token validation from ?token= query param.
        const reqUrl = new URL(req.url || '', `http://${req.headers.host}`);
        const token = reqUrl.searchParams.get('token');
        if (!token) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        const expected = await this._options.getAuthToken();
        if (!this._constantTimeEqual(token, expected)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        // All checks passed — complete the upgrade.
        this._wss!.handleUpgrade(req, socket, head, async (ws) => {
            const meta: ConnectionMeta = { ws, seq: 0 };

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
                    const state = await this._options.getFullState();
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

            ws.on('close', () => {
                this._connections.delete(meta);
            });
            ws.on('error', (err) => {
                console.error('[wsHub] connection error:', err);
                this._connections.delete(meta);
            });
        });
    }

    private _isLocalhostOrigin(origin: string): boolean {
        try {
            const u = new URL(origin);
            const h = u.hostname;
            return h === '127.0.0.1' || h === 'localhost' || h === '::1';
        } catch {
            return false;
        }
    }

    private _constantTimeEqual(a: string, b: string): boolean {
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < b.length; i++) {
            diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
        }
        return diff === 0;
    }

    private _safeSend(ws: WebSocket, data: any): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    /**
     * Broadcast a push message to all connected clients. Each connection
     * gets its own monotonic sequence number so clients can detect gaps.
     */
    broadcast(verb: string, payload?: any, surface?: string): void {
        for (const meta of this._connections) {
            meta.seq += 1;
            this._safeSend(meta.ws, {
                type: verb,
                seq: meta.seq,
                // `surface` names the UI surface this push belongs to (e.g. 'kanban',
                // 'planning', 'devDocs') so a remote client can route/filter a single
                // WS stream that carries pushes from every panel. Omitted → undefined.
                surface,
                payload,
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
