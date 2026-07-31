import { WebSocketServer, WebSocket } from 'ws';
import type { PtyFleetService, ExtendedTerminalHandle } from './ptyFleetService';
import { authorizeWsUpgrade } from '../services/wsUpgradeAuth';

export const MAX_SCROLLBACK_BYTES = 256 * 1024; // 256 KB
export const HIGH_WATER_MARK_BYTES = 1024 * 1024; // 1 MB
export const LOW_WATER_MARK_BYTES = 256 * 1024; // 256 KB
export const HIGH_WATER_GRACE_MS = 30000; // 30s
export const PING_INTERVAL_MS = 30000;
/**
 * How often a paused terminal re-checks whether its clients have drained.
 *
 * Load-bearing: the high/low-water check is otherwise only reachable from inside
 * `onData`, and a paused pty by definition produces no data — so pause() with no
 * independent timer is a permanent freeze, not backpressure.
 */
export const DRAIN_POLL_MS = 250;

interface ScrollbackChunk {
    seq: number;
    data: string;
}

interface ScrollbackBuffer {
    chunks: ScrollbackChunk[];
    totalBytes: number;
    /**
     * Monotonic output counter for THIS TERMINAL — not per-connection.
     *
     * Per-connection numbering restarted at 1 on every reconnect while the client
     * carries its `lastSeq` forward, so after one reconnect every frame satisfied
     * `seq <= lastSeq` and the terminal went permanently blank. Terminal-scoped
     * seqs make replay genuinely idempotent: a re-attaching client drops the
     * prefix it already rendered and writes only the tail it missed.
     */
    nextSeq: number;
}

interface ClientState {
    ws: WebSocket;
    terminalName: string;
    isAlive: boolean;
    highWaterStart?: number;
}

export class TerminalWsGateway {
    private wss = new WebSocketServer({ noServer: true });
    private fleetService: PtyFleetService;
    private getAuthToken: () => Promise<string | undefined>;
    private broadcastWs?: (verb: string, payload: any) => void;

    private scrollbackBuffers = new Map<string, ScrollbackBuffer>();
    private terminalSubscriptions = new Map<string, { dispose: () => void }>();
    private pausedTerminals = new Set<string>();
    private clients = new Set<ClientState>();
    private pingInterval?: NodeJS.Timeout;
    private drainInterval?: NodeJS.Timeout;

    constructor(
        fleetService: PtyFleetService,
        getAuthToken: () => Promise<string | undefined>,
        broadcastWs?: (verb: string, payload: any) => void
    ) {
        this.fleetService = fleetService;
        this.getAuthToken = getAuthToken;
        this.broadcastWs = broadcastWs;

        this.initFleetListeners();
        this.startPingReaper();
        this.startDrainPoller();
    }

    public setBroadcastWs(broadcastWs: (verb: string, payload: any) => void): void {
        this.broadcastWs = broadcastWs;
    }

    private initFleetListeners(): void {
        // Subscribe to fleet events so we capture scrollback from terminal creation time
        for (const t of this.fleetService.list()) {
            this.trackTerminalData(t);
        }

        this.fleetService.onDidChange((event) => {
            if (event.type === 'created') {
                this.trackTerminalData(event.terminal);
            } else if (event.type === 'closed') {
                this.untrackTerminalData(event.name, event.code);
            }
            if (this.broadcastWs) {
                this.broadcastWs('terminalsChanged', {});
            }
        });
    }

    private trackTerminalData(t: ExtendedTerminalHandle): void {
        if (this.terminalSubscriptions.has(t.name)) return;

        const buffer: ScrollbackBuffer = { chunks: [], totalBytes: 0, nextSeq: 1 };
        this.scrollbackBuffers.set(t.name, buffer);

        const sub = t.onData((chunk: string) => {
            // Append to ring buffer under this terminal's monotonic seq.
            const seq = buffer.nextSeq++;
            buffer.chunks.push({ seq, data: chunk });
            buffer.totalBytes += chunk.length;
            while (buffer.totalBytes > MAX_SCROLLBACK_BYTES && buffer.chunks.length > 1) {
                const removed = buffer.chunks.shift()!;
                buffer.totalBytes -= removed.data.length;
            }

            // Fan out to attached clients — same seq for everyone.
            const base64Data = Buffer.from(chunk, 'utf8').toString('base64');
            const targetClients = Array.from(this.clients).filter(c => c.terminalName === t.name);

            for (const client of targetClients) {
                if (client.ws.readyState === WebSocket.OPEN) {
                    this.safeSend(client.ws, {
                        t: 'out',
                        seq,
                        data: base64Data,
                    });
                }
            }

            this.checkBackpressure(t.name, targetClients);
        });

        this.terminalSubscriptions.set(t.name, sub);
    }

    private untrackTerminalData(name: string, exitCode?: number): void {
        const sub = this.terminalSubscriptions.get(name);
        if (sub) {
            sub.dispose();
            this.terminalSubscriptions.delete(name);
        }
        this.scrollbackBuffers.delete(name);
        this.pausedTerminals.delete(name);

        // Notify and close attached clients
        for (const client of Array.from(this.clients)) {
            if (client.terminalName === name) {
                this.safeSend(client.ws, { t: 'exit', code: exitCode ?? 0 });
                try { client.ws.close(); } catch { /* ignore */ }
                this.clients.delete(client);
            }
        }
    }

    private checkBackpressure(terminalName: string, targetClients: ClientState[]): void {
        const handle = this.fleetService.get(terminalName);
        if (!handle) return;

        let maxBuffered = 0;
        const now = Date.now();

        for (const client of targetClients) {
            const buffered = client.ws.bufferedAmount;
            if (buffered > maxBuffered) {
                maxBuffered = buffered;
            }

            if (buffered > HIGH_WATER_MARK_BYTES) {
                if (!client.highWaterStart) {
                    client.highWaterStart = now;
                } else if (now - client.highWaterStart > HIGH_WATER_GRACE_MS) {
                    // Evict lagging client
                    console.warn(`[TerminalWsGateway] Evicting lagging client for terminal ${terminalName}`);
                    this.safeSend(client.ws, { t: 'exit', code: -1, reason: 'Lagging client evicted' });
                    try { client.ws.close(); } catch { /* ignore */ }
                    this.clients.delete(client);
                }
            } else {
                client.highWaterStart = undefined;
            }
        }

        if (maxBuffered > HIGH_WATER_MARK_BYTES && !this.pausedTerminals.has(terminalName)) {
            try {
                handle.pty.pause();
                this.pausedTerminals.add(terminalName);
            } catch (err) {
                console.warn(`[TerminalWsGateway] Failed to pause terminal ${terminalName}:`, err);
            }
        } else if (maxBuffered < LOW_WATER_MARK_BYTES && this.pausedTerminals.has(terminalName)) {
            try {
                handle.pty.resume();
                this.pausedTerminals.delete(terminalName);
            } catch (err) {
                console.warn(`[TerminalWsGateway] Failed to resume terminal ${terminalName}:`, err);
            }
        }
    }

    public async handleUpgrade(req: any, socket: any, head: any): Promise<void> {
        const auth = await authorizeWsUpgrade(req, this.getAuthToken, { rejectWhenTokenEmpty: true });
        if (!auth.authorized) {
            const status = auth.statusCode || 401;
            const msg = auth.reason || 'Unauthorized';
            socket.write(`HTTP/1.1 ${status} ${msg}\r\n\r\n`);
            socket.destroy();
            return;
        }

        const reqUrl = new URL(req.url || '', `http://${req.headers['host'] || '127.0.0.1'}`);
        const name = reqUrl.searchParams.get('name');

        if (!name) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }

        const terminal = this.fleetService.get(name);
        if (!terminal) {
            // 4404 is an APPLICATION close code, not an HTTP status — writing
            // "HTTP/1.1 4404" produced a malformed handshake the browser reported as
            // a generic network failure, with no way for the client to distinguish
            // "no such terminal" from "server down". Complete the upgrade, name the
            // reason in a JSON frame, then close in the 4000-4999 private range.
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.safeSend(ws, { t: 'error', code: 4404, message: `No such terminal: ${name}` });
                try { ws.close(4404, 'Terminal not found'); } catch { /* already gone */ }
            });
            return;
        }

        this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.setupClient(ws, terminal);
        });
    }

    private setupClient(ws: WebSocket, terminal: ExtendedTerminalHandle): void {
        const client: ClientState = {
            ws,
            terminalName: terminal.name,
            isAlive: true,
        };
        this.clients.add(client);

        const buffer = this.scrollbackBuffers.get(terminal.name);

        // Hello frame carries the terminal's current high-water seq so a client can
        // tell how far ahead the stream already is.
        this.safeSend(ws, {
            t: 'hello',
            name: terminal.name,
            role: terminal.role,
            cols: terminal.pty.cols || 80,
            rows: terminal.pty.rows || 24,
            seq: buffer ? buffer.nextSeq - 1 : 0,
        });

        // Replay scrollback BEFORE any live frame. This loop is synchronous, and
        // node's single-threaded model means no `onData` callback can interleave
        // with it — so replay-then-live ordering holds without an explicit buffer.
        // Chunks keep their original seqs, so a re-attaching client dedupes the
        // prefix it has already rendered instead of double-writing it.
        if (buffer) {
            for (const chunk of buffer.chunks) {
                const base64Data = Buffer.from(chunk.data, 'utf8').toString('base64');
                this.safeSend(ws, {
                    t: 'out',
                    seq: chunk.seq,
                    data: base64Data,
                });
            }
        }

        if (terminal.status === 'exited') {
            this.safeSend(ws, { t: 'exit', code: terminal.exitCode ?? 0 });
        }

        ws.on('pong', () => {
            client.isAlive = true;
        });

        ws.on('message', (msg) => {
            try {
                const parsed = JSON.parse(msg.toString());
                if (parsed.t === 'input' && typeof parsed.data === 'string') {
                    const decoded = Buffer.from(parsed.data, 'base64').toString('utf8');
                    terminal.write(decoded);
                } else if (parsed.t === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
                    terminal.resize(parsed.cols, parsed.rows);
                } else if (parsed.t === 'ping') {
                    this.safeSend(ws, { t: 'pong' });
                }
            } catch (err) {
                console.warn('[TerminalWsGateway] Bad client message:', err);
            }
        });

        ws.on('close', () => {
            this.clients.delete(client);
        });

        ws.on('error', () => {
            this.clients.delete(client);
        });
    }

    /**
     * Re-evaluates backpressure for every paused terminal on a timer. Without this
     * a pause is terminal (see DRAIN_POLL_MS): no data flows, so nothing calls
     * checkBackpressure, so resume() never fires. Also the only path that resumes
     * after the last laggard is evicted or closes its tab.
     */
    private startDrainPoller(): void {
        this.drainInterval = setInterval(() => {
            if (this.pausedTerminals.size === 0) { return; }
            for (const name of Array.from(this.pausedTerminals)) {
                const targetClients = Array.from(this.clients).filter(c => c.terminalName === name);
                this.checkBackpressure(name, targetClients);
            }
        }, DRAIN_POLL_MS);
    }

    private startPingReaper(): void {
        this.pingInterval = setInterval(() => {
            for (const client of Array.from(this.clients)) {
                if (client.isAlive === false) {
                    client.ws.terminate();
                    this.clients.delete(client);
                    continue;
                }
                client.isAlive = false;
                try { client.ws.ping(); } catch { /* ignore */ }
            }
        }, PING_INTERVAL_MS);
    }

    private safeSend(ws: WebSocket, data: any): void {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(data));
            } catch { /* ignore */ }
        }
    }

    public dispose(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        if (this.drainInterval) {
            clearInterval(this.drainInterval);
        }
        for (const client of this.clients) {
            try { client.ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();
    }
}
