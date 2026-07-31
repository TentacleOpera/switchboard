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

/**
 * Coalescing window for pty output, in ms.
 *
 * node-pty emits a callback per read, which during interactive output means many
 * tiny chunks. Forwarding each one as its own frame made the browser pay a
 * JSON.parse + decode + xterm write per chunk — the dominant cost in the webview,
 * and the reason browser terminals felt laggy next to VS Code's (whose pty host
 * buffers writes before handing them to the renderer). One flush per window
 * collapses that into a single frame, a single scrollback entry, and a single
 * backpressure check.
 *
 * ~6ms is under one 60Hz frame, so coalescing never costs a rendered frame of
 * latency: the client rAF-batches writes anyway.
 */
export const OUTPUT_FLUSH_MS = 6;

/**
 * Ceiling on one coalesced frame. A `yes`-style firehose would otherwise join
 * into a single multi-megabyte frame that stalls the client's decode and defeats
 * backpressure (which can only act between frames). Whole chunks only — never
 * split one — so a surrogate pair can't be cut across two separately-UTF-8-encoded
 * payloads. Leftovers flush on the next tick.
 */
export const MAX_FLUSH_BYTES = 128 * 1024;

interface ScrollbackChunk {
    seq: number;
    data: string;
}

interface PendingOutput {
    parts: string[];
    bytes: number;
    timer?: NodeJS.Timeout;
}

/**
 * Wire format for output frames: 4-byte big-endian seq, then the raw UTF-8 bytes.
 *
 * Output used to travel as `JSON.stringify({t:'out', seq, data: base64})`. Base64
 * inflates by a third, JSON escaping inflates again, and the client paid
 * `JSON.parse` + `atob` + a char-by-char `Uint8Array.from` on every frame. Binary
 * frames cost one `DataView` read and one `TextDecoder` pass over bytes that were
 * never re-encoded.
 *
 * Control frames (hello/exit/error/pong) stay JSON text — they are rare, and
 * keeping them human-readable keeps the protocol debuggable. The client
 * discriminates on frame type: string = control, ArrayBuffer = output.
 */
function encodeOutputFrame(seq: number, payload: string): Buffer {
    const body = Buffer.from(payload, 'utf8');
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32BE(seq >>> 0, 0);
    body.copy(frame, 4);
    return frame;
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
    private pendingOutput = new Map<string, PendingOutput>();
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

        // Accumulate only. Everything expensive — seq assignment, ring-buffer
        // append, UTF-8 encode, fan-out, backpressure — happens once per flush
        // window in flushOutput, not once per pty read.
        const sub = t.onData((chunk: string) => {
            let pending = this.pendingOutput.get(t.name);
            if (!pending) {
                pending = { parts: [], bytes: 0 };
                this.pendingOutput.set(t.name, pending);
            }
            pending.parts.push(chunk);
            pending.bytes += chunk.length;
            this.scheduleFlush(t.name);
        });

        this.terminalSubscriptions.set(t.name, sub);
    }

    private scheduleFlush(terminalName: string): void {
        const pending = this.pendingOutput.get(terminalName);
        if (!pending || pending.timer) { return; }
        pending.timer = setTimeout(() => {
            pending.timer = undefined;
            this.flushOutput(terminalName);
        }, OUTPUT_FLUSH_MS);
    }

    /**
     * Emit one coalesced frame for a terminal: one seq, one scrollback entry, one
     * encode, one send per client, one backpressure check.
     */
    private flushOutput(terminalName: string): void {
        const pending = this.pendingOutput.get(terminalName);
        if (!pending || pending.parts.length === 0) { return; }

        // Take whole chunks up to the cap; anything left rides the next tick.
        const taken: string[] = [];
        let takenBytes = 0;
        while (pending.parts.length > 0 && takenBytes < MAX_FLUSH_BYTES) {
            const part = pending.parts.shift()!;
            taken.push(part);
            takenBytes += part.length;
        }
        pending.bytes -= takenBytes;

        const combined = taken.join('');
        const buffer = this.scrollbackBuffers.get(terminalName);
        let seq = 0;

        if (buffer) {
            seq = buffer.nextSeq++;
            buffer.chunks.push({ seq, data: combined });
            buffer.totalBytes += combined.length;
            while (buffer.totalBytes > MAX_SCROLLBACK_BYTES && buffer.chunks.length > 1) {
                const removed = buffer.chunks.shift()!;
                buffer.totalBytes -= removed.data.length;
            }
        }

        const frame = encodeOutputFrame(seq, combined);
        const targetClients = Array.from(this.clients).filter(c => c.terminalName === terminalName);
        for (const client of targetClients) {
            this.safeSendBinary(client.ws, frame);
        }

        this.checkBackpressure(terminalName, targetClients);

        // More than one cap's worth arrived in a single window — keep draining
        // rather than waiting for the next pty read to re-arm the timer.
        if (pending.parts.length > 0) {
            this.scheduleFlush(terminalName);
        }
    }

    private untrackTerminalData(name: string, exitCode?: number): void {
        const sub = this.terminalSubscriptions.get(name);
        if (sub) {
            sub.dispose();
            this.terminalSubscriptions.delete(name);
        }

        // Drain before announcing the exit. A process that prints and immediately
        // dies leaves its last output sitting in the coalescing window; dropping
        // the buffer here would swallow exactly the lines the operator needs.
        this.drainPending(name);

        this.scrollbackBuffers.delete(name);
        this.pendingOutput.delete(name);
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

    /** Flush everything queued for a terminal synchronously, then disarm its timer. */
    private drainPending(name: string): void {
        const pending = this.pendingOutput.get(name);
        if (!pending) { return; }
        while (pending.parts.length > 0) {
            this.flushOutput(name);
        }
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = undefined;
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

        // A reconnecting client tells us how far it already rendered so replay can
        // start from the tail instead of shipping the whole ring and relying on the
        // client to discard the prefix.
        const rawLastSeq = Number(reqUrl.searchParams.get('lastSeq'));
        const lastSeq = Number.isFinite(rawLastSeq) && rawLastSeq > 0 ? rawLastSeq : 0;

        this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.setupClient(ws, terminal, lastSeq);
        });
    }

    private setupClient(ws: WebSocket, terminal: ExtendedTerminalHandle, lastSeq = 0): void {
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

        // Replay scrollback BEFORE any live frame. This block is synchronous, and
        // node's single-threaded model means no flush can interleave with it — so
        // replay-then-live ordering holds without an explicit buffer.
        //
        // Sent as ONE concatenated frame, not one frame per chunk: 256 KB of ring
        // used to arrive as a burst of hundreds of JSON frames the moment a tab
        // opened, which is what made attaching feel like a stall. The frame carries
        // the highest replayed seq, and only chunks newer than the client's
        // `lastSeq` are included, so a re-attaching client can write the whole
        // payload without re-rendering the prefix it already has.
        if (buffer && buffer.chunks.length > 0) {
            const missed = lastSeq > 0
                ? buffer.chunks.filter(c => c.seq > lastSeq)
                : buffer.chunks;
            if (missed.length > 0) {
                const replaySeq = missed[missed.length - 1].seq;
                const combined = missed.map(c => c.data).join('');
                this.safeSendBinary(ws, encodeOutputFrame(replaySeq, combined));
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

    /**
     * Send a pre-encoded output frame. `binary: true` is explicit because `ws`
     * infers the opcode from the argument type, and a future refactor handing this
     * a string would silently flip the frame to text and break the client's
     * string-vs-ArrayBuffer discriminator.
     */
    private safeSendBinary(ws: WebSocket, frame: Buffer): void {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(frame, { binary: true });
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
        for (const pending of this.pendingOutput.values()) {
            if (pending.timer) { clearTimeout(pending.timer); }
        }
        this.pendingOutput.clear();
        for (const client of this.clients) {
            try { client.ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();
    }
}
