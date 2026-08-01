import { WebSocketServer, WebSocket } from 'ws';
import type { PtyFleetService, ExtendedTerminalHandle } from './ptyFleetService';
import { authorizeWsUpgrade } from '../services/wsUpgradeAuth';

export const MAX_SCROLLBACK_BYTES = 256 * 1024; // 256 KB
export const HIGH_WATER_MARK_BYTES = 1024 * 1024; // 1 MB
export const LOW_WATER_MARK_BYTES = 256 * 1024; // 256 KB
export const HIGH_WATER_GRACE_MS = 30000; // 30s
export const PING_INTERVAL_MS = 30000;
export const LOW_WATER_CHARS = 5000;
export const HIGH_WATER_CHARS = 100000;
export const MAX_PAUSE_MS = 10000;
export const MAX_INPUT_FRAME_BYTES = 5 * 1024 * 1024; // 5 MB
export const INPUT_CHUNK_BYTES = 4096;
export const INPUT_HIGH_WATER_BYTES = 64 * 1024; // 64 KB
export const INPUT_LOW_WATER_BYTES = 16 * 1024; // 16 KB

interface InputQueue {
    chunks: Buffer[];
    queuedBytes: number;
    draining: boolean;
    throttled?: boolean;
}
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
    unackedChars: number;
    /** Last size this client reported FROM A RENDERED VIEWPORT. Undefined until it
     *  has one — a client with nothing on screen does not get a vote. See applyResize. */
    reportedSize?: { cols: number; rows: number };
}

export class TerminalWsGateway {
    private wss = new WebSocketServer({ noServer: true });
    private fleetService: PtyFleetService;
    private getAuthToken: () => Promise<string | undefined>;
    // Third arg is the WS surface tag (see SURFACES in services/wsHub.ts). Typed
    // here rather than imported so the standalone gateway keeps no dependency on
    // the hub module; the value is a plain string on the wire either way.
    private broadcastWs?: (verb: string, payload: any, surface?: string) => void;

    private scrollbackBuffers = new Map<string, ScrollbackBuffer>();
    private terminalSubscriptions = new Map<string, { dispose: () => void }>();
    private pendingOutput = new Map<string, PendingOutput>();
    private pendingFlushTerminals = new Set<string>();
    private pausedTerminals = new Set<string>();
    private pausedSince = new Map<string, number>();
    private clients = new Set<ClientState>();
    private inputQueues = new Map<string, InputQueue>();
    private pingInterval?: NodeJS.Timeout;
    private drainInterval?: NodeJS.Timeout;
    private sharedFlushInterval?: NodeJS.Timeout;

    private enqueueInput(terminalName: string, buf: Buffer): void {
        const handle = this.fleetService.get(terminalName);
        if (!handle) return;
        let queue = this.inputQueues.get(terminalName);
        if (!queue) {
            queue = { chunks: [], queuedBytes: 0, draining: false };
            this.inputQueues.set(terminalName, queue);
        }
        queue.chunks.push(buf);
        queue.queuedBytes += buf.length;

        if (queue.queuedBytes > INPUT_HIGH_WATER_BYTES && !queue.throttled) {
            queue.throttled = true;
            this.notifyInputThrottle(terminalName, true, queue.queuedBytes);
        }

        if (!queue.draining) {
            queue.draining = true;
            this.drainInputQueue(terminalName);
        }
    }

    private drainInputQueue(terminalName: string): void {
        const queue = this.inputQueues.get(terminalName);
        const handle = this.fleetService.get(terminalName);
        if (!queue || !handle || queue.chunks.length === 0) {
            if (queue) {
                queue.draining = false;
                this.clearInputThrottleIfDrained(terminalName, queue);
            }
            return;
        }

        const first = queue.chunks[0];
        if (first.length > INPUT_CHUNK_BYTES) {
            const sliceLen = this.findSafeBoundary(first, INPUT_CHUNK_BYTES);
            const chunkToDrain = first.subarray(0, sliceLen);
            const remaining = first.subarray(sliceLen);
            queue.chunks[0] = remaining;
            queue.queuedBytes -= sliceLen;
            try {
                handle.write(chunkToDrain.toString('utf8'));
            } catch (err) {
                console.warn(`[TerminalWsGateway] Failed to write input chunk to ${terminalName}:`, err);
            }
        } else {
            const chunkToDrain = queue.chunks.shift()!;
            queue.queuedBytes -= chunkToDrain.length;
            try {
                handle.write(chunkToDrain.toString('utf8'));
            } catch (err) {
                console.warn(`[TerminalWsGateway] Failed to write input chunk to ${terminalName}:`, err);
            }
        }

        this.clearInputThrottleIfDrained(terminalName, queue);

        if (queue.chunks.length > 0) {
            setImmediate(() => this.drainInputQueue(terminalName));
        } else {
            queue.draining = false;
        }
    }

    /**
     * Both halves of the throttle notice. The CLEAR is not cosmetic: the notice is
     * the only signal the operator gets that a paste is still landing, so leaving
     * it unclosed reads as "input is permanently throttled" long after the queue
     * drained. Nothing is ever dropped in either state.
     */
    private notifyInputThrottle(terminalName: string, throttled: boolean, queuedBytes: number): void {
        for (const client of this.clients) {
            if (client.terminalName !== terminalName) { continue; }
            this.safeSend(client.ws, { t: 'inputThrottled', throttled, queued: queuedBytes });
        }
    }

    private clearInputThrottleIfDrained(terminalName: string, queue: InputQueue): void {
        if (queue.throttled && queue.queuedBytes < INPUT_LOW_WATER_BYTES) {
            queue.throttled = false;
            this.notifyInputThrottle(terminalName, false, queue.queuedBytes);
        }
    }

    /**
     * Pick a cut point at or before `maxLen` that cannot corrupt the stream.
     *
     * Two hazards, both silent:
     *  - cutting inside a multi-byte codepoint, which mangles pasted text;
     *  - cutting inside an escape sequence, which turns `\x1b[200~` into a bare
     *    ESC followed by literal `[200~` — worse than not chunking at all, since
     *    the receiving app then treats a paste as typed input.
     *
     * CSI parsing is the load-bearing detail. `ESC [` is an INTRODUCER, not a
     * terminator: a CSI sequence ends at its FINAL byte (0x40-0x7E) which comes
     * after the parameter (0x30-0x3F) and intermediate (0x20-0x2F) bytes. Scanning
     * for "any byte in 0x40-0x7E after the ESC" therefore matches the `[` itself
     * and declares every CSI sequence complete at its second byte — which is
     * exactly the bracketed-paste marker this guard exists to keep whole.
     */
    private findSafeBoundary(buf: Buffer, maxLen: number): number {
        let pos = maxLen;
        // buf[pos] is the first byte of the REMAINDER, so back up while it is a
        // UTF-8 continuation byte (0b10xxxxxx) to land on a lead byte.
        while (pos > 0 && (buf[pos] & 0xc0) === 0x80) {
            pos--;
        }
        let escPos = -1;
        for (let i = Math.max(0, pos - 16); i < pos; i++) {
            if (buf[i] === 0x1b) {
                escPos = i;
            }
        }
        if (escPos !== -1 && !this.isEscapeSequenceComplete(buf, escPos, pos) && escPos > 0) {
            pos = escPos;
        }
        if (pos <= 0) {
            // A single codepoint or escape sequence longer than the whole chunk.
            // Impossible for well-formed input; write the slice rather than hang.
            console.warn(`[TerminalWsGateway] No safe input chunk boundary within ${maxLen} bytes — writing unsplit slice`);
            return maxLen;
        }
        return pos;
    }

    /** True when the escape sequence starting at `escPos` terminates before `end`. */
    private isEscapeSequenceComplete(buf: Buffer, escPos: number, end: number): boolean {
        let i = escPos + 1;
        if (i >= end) { return false; }
        const introducer = buf[i];
        if (introducer === 0x5b /* [ */ || introducer === 0x5d /* ] */) {
            // CSI (ESC [) / OSC (ESC ]). OSC ends on BEL or ST (ESC \); CSI ends on
            // a final byte in 0x40-0x7E. Treating BEL/final-byte uniformly is enough
            // here — we only need to know whether the sequence CLOSED before `end`.
            for (i = escPos + 2; i < end; i++) {
                const c = buf[i];
                if (introducer === 0x5d && c === 0x07 /* BEL */) { return true; }
                if (c >= 0x40 && c <= 0x7e) { return true; }
            }
            return false;
        }
        // Two-byte escape (ESC 7, ESC =, ESC ( B …): the next byte closes it, and
        // intermediates in 0x20-0x2F extend it by one more.
        if (introducer >= 0x20 && introducer <= 0x2f) { return escPos + 2 < end; }
        return true;
    }

    constructor(
        fleetService: PtyFleetService,
        getAuthToken: () => Promise<string | undefined>,
        broadcastWs?: (verb: string, payload: any, surface?: string) => void
    ) {
        this.fleetService = fleetService;
        this.getAuthToken = getAuthToken;
        this.broadcastWs = broadcastWs;

        this.initFleetListeners();
        this.startPingReaper();
        this.startDrainPoller();
    }

    public setBroadcastWs(broadcastWs: (verb: string, payload: any, surface?: string) => void): void {
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
                this.broadcastWs('terminalsChanged', {}, 'terminals');
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
        if (!pending || pending.parts.length === 0) { return; }
        this.pendingFlushTerminals.add(terminalName);
        if (!this.sharedFlushInterval) {
            this.sharedFlushInterval = setInterval(() => this.flushAllPending(), OUTPUT_FLUSH_MS);
        }
    }

    private flushAllPending(): void {
        if (this.pendingFlushTerminals.size === 0) {
            if (this.sharedFlushInterval) {
                clearInterval(this.sharedFlushInterval);
                this.sharedFlushInterval = undefined;
            }
            return;
        }
        for (const name of Array.from(this.pendingFlushTerminals)) {
            this.flushOutput(name);
        }
    }

    /**
     * Emit one coalesced frame for a terminal: one seq, one scrollback entry, one
     * encode, one send per client, one backpressure check.
     */
    private flushOutput(terminalName: string): void {
        const pending = this.pendingOutput.get(terminalName);
        if (!pending || pending.parts.length === 0) {
            this.pendingFlushTerminals.delete(terminalName);
            return;
        }

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
            client.unackedChars += combined.length;
        }

        this.checkBackpressure(terminalName, targetClients);

        // More than one cap's worth arrived in a single window — keep draining
        // rather than waiting for the next pty read to re-arm the timer.
        if (pending.parts.length === 0) {
            this.pendingFlushTerminals.delete(terminalName);
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
        this.pendingFlushTerminals.delete(name);
        this.pausedTerminals.delete(name);
        this.pausedSince.delete(name);
        this.inputQueues.delete(name);

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
        this.pendingFlushTerminals.delete(name);
    }

    private checkBackpressure(terminalName: string, targetClients: ClientState[]): void {
        const handle = this.fleetService.get(terminalName);
        if (!handle) return;

        let maxBuffered = 0;
        let maxUnacked = 0;
        const now = Date.now();

        for (const client of targetClients) {
            const buffered = client.ws.bufferedAmount;
            if (buffered > maxBuffered) {
                maxBuffered = buffered;
            }
            if (client.unackedChars > maxUnacked) {
                maxUnacked = client.unackedChars;
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

        // Safety valve. The stamp is refreshed on every ack that actually moves the
        // counter (see the 'ack' handler), so this measures TIME WITHOUT ACK
        // PROGRESS, not total pause time. A genuinely slow renderer that keeps
        // acking stays paused for as long as it needs — that is working
        // backpressure, and force-resuming it every 10s would disable the feature
        // under exactly the sustained load it exists for. Only a stalled counter
        // (lost ack, dead renderer, disposed view) trips this, and it degrades to
        // today's lag rather than to a silently dead terminal.
        const pausedTime = this.pausedSince.get(terminalName);
        if (pausedTime && now - pausedTime > MAX_PAUSE_MS) {
            console.warn(`[TerminalWsGateway] Terminal ${terminalName} paused ${MAX_PAUSE_MS}ms with no ack progress. Force resuming.`);
            try {
                handle.pty.resume();
            } catch (err) {
                console.warn(`[TerminalWsGateway] Failed to force resume terminal ${terminalName}:`, err);
            }
            this.pausedTerminals.delete(terminalName);
            this.pausedSince.delete(terminalName);
            for (const client of targetClients) {
                client.unackedChars = 0;
            }
            return;
        }

        if ((maxBuffered > HIGH_WATER_MARK_BYTES || maxUnacked > HIGH_WATER_CHARS) && !this.pausedTerminals.has(terminalName)) {
            try {
                handle.pty.pause();
                this.pausedTerminals.add(terminalName);
                this.pausedSince.set(terminalName, now);
            } catch (err) {
                console.warn(`[TerminalWsGateway] Failed to pause terminal ${terminalName}:`, err);
            }
        } else if (maxBuffered < LOW_WATER_MARK_BYTES && maxUnacked < LOW_WATER_CHARS && this.pausedTerminals.has(terminalName)) {
            try {
                handle.pty.resume();
                this.pausedTerminals.delete(terminalName);
                this.pausedSince.delete(terminalName);
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
            unackedChars: 0,
        };
        this.clients.add(client);

        const buffer = this.scrollbackBuffers.get(terminal.name);

        // Resolve the replay payload BEFORE the hello frame so hello can carry its
        // length. Replay is deliberately excluded from this client's credit ledger
        // (it is a catch-up burst up to MAX_SCROLLBACK_BYTES, larger than the whole
        // high-water budget), but the client acks whatever it parses — including
        // the replay. Without telling it how much to skip, a re-attaching client
        // pays down up to 256 KB of credit it never consumed, zeroing unackedChars
        // and disabling backpressure for the first quarter-megabyte of live output
        // after a reconnect: precisely the eviction→reconnect→replay spiral this
        // whole mechanism exists to break.
        let replayFrame: Buffer | undefined;
        let replayChars = 0;
        if (buffer && buffer.chunks.length > 0) {
            const missed = lastSeq > 0
                ? buffer.chunks.filter(c => c.seq > lastSeq)
                : buffer.chunks;
            if (missed.length > 0) {
                const replaySeq = missed[missed.length - 1].seq;
                const combined = missed.map(c => c.data).join('');
                replayChars = combined.length;
                replayFrame = encodeOutputFrame(replaySeq, combined);
            }
        }

        // Hello frame carries the terminal's current high-water seq so a client can
        // tell how far ahead the stream already is.
        this.safeSend(ws, {
            t: 'hello',
            name: terminal.name,
            role: terminal.role,
            cols: terminal.pty.cols || 80,
            rows: terminal.pty.rows || 24,
            seq: buffer ? buffer.nextSeq - 1 : 0,
            replayChars,
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
        if (replayFrame) {
            this.safeSendBinary(ws, replayFrame);
        }

        if (terminal.status === 'exited') {
            this.safeSend(ws, { t: 'exit', code: terminal.exitCode ?? 0 });
        }

        ws.on('pong', () => {
            client.isAlive = true;
        });

        // `isBinary` — NOT a Buffer check. ws@8 hands every frame to this callback as a
        // Buffer, text and binary alike, and reports the distinction only in this second
        // argument. The old `Buffer.isBuffer(msg)` guard was therefore true for JSON
        // control frames too: they fell into the binary arm, failed the 0x01 opcode test
        // and hit `return`. Every `resize`, `ack` and legacy `input` frame was silently
        // dropped for the life of that code — which is why ptys stayed pinned at their
        // 80x24 spawn size no matter how the operator sized the window, and why unacked
        // credit only ever grew until backpressure paused the terminal.
        ws.on('message', (msg, isBinary) => {
            try {
                if (isBinary) {
                    const buf = Buffer.from(msg as any);
                    if (buf.length < 1) return;
                    const opcode = buf[0];
                    if (opcode === 0x01) {
                        const payload = buf.subarray(1);
                        if (payload.length > MAX_INPUT_FRAME_BYTES) {
                            console.warn(`[TerminalWsGateway] Input frame size ${payload.length} exceeds max (${MAX_INPUT_FRAME_BYTES}) for ${terminal.name}`);
                            return;
                        }
                        this.enqueueInput(terminal.name, payload);
                    }
                    return;
                }
                const parsed = JSON.parse(msg.toString());
                if (parsed.t === 'input' && typeof parsed.data === 'string') {
                    const decoded = Buffer.from(parsed.data, 'base64');
                    if (decoded.length > MAX_INPUT_FRAME_BYTES) {
                        console.warn(`[TerminalWsGateway] Legacy input frame size ${decoded.length} exceeds max for ${terminal.name}`);
                        return;
                    }
                    this.enqueueInput(terminal.name, decoded);
                } else if (parsed.t === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
                    this.applyResize(client, parsed);
                } else if (parsed.t === 'ack' && typeof parsed.chars === 'number') {
                    const acked = Math.max(0, Math.min(parsed.chars, client.unackedChars));
                    client.unackedChars -= acked;
                    // Ack progress refreshes the pause stamp so MAX_PAUSE_MS measures a
                    // STALLED counter, not a legitimately long pause.
                    if (acked > 0 && this.pausedSince.has(client.terminalName)) {
                        this.pausedSince.set(client.terminalName, Date.now());
                    }
                    const targetClients = Array.from(this.clients).filter(c => c.terminalName === client.terminalName);
                    this.checkBackpressure(client.terminalName, targetClients);
                } else if (parsed.t === 'ping') {
                    this.safeSend(ws, { t: 'pong' });
                }
            } catch (err) {
                console.warn('[TerminalWsGateway] Bad client message:', err);
            }
        });

        ws.on('close', () => {
            this.clients.delete(client);
            // A departing client's size must stop constraining the survivors, or
            // closing a small tab leaves everyone else clamped to its dimensions.
            this.reconcileTerminalSize(client.terminalName);
        });

        ws.on('error', () => {
            this.clients.delete(client);
            this.reconcileTerminalSize(client.terminalName);
        });
    }

    /**
     * Size the pty from the clients that can actually see it.
     *
     * The pty is shared by every attached client and this used to be a bare
     * `terminal.resize(cols, rows)` — last frame wins. That is how a hidden tab came
     * to dictate the size: the browser shell mounts every panel iframe up front with
     * display:none, so the Terminals panel connects while measuring 0x0, and an xterm
     * with no layout reports its 80x24 construction default. The operator's visible
     * terminal was squashed to 24 rows on every shell load and tab switch.
     *
     * Two rules, in order:
     *  - A client that says it is not rendering gets no vote at all. terminals.js now
     *    stamps `rendered: true` on frames sent from a real box; a frame WITHOUT the
     *    field is treated as rendered so an older client behaves exactly as before.
     *  - Among the clients that do have a viewport, take the MIN. That is the
     *    conventional multi-client rule (tmux does the same): the smallest attached
     *    viewport is the only size where nobody is looking at wrapped or clipped
     *    output. With one client attached — overwhelmingly the common case — the min
     *    of one is just that client's size, so nothing changes.
     */
    private applyResize(client: ClientState, parsed: { cols: number; rows: number; rendered?: boolean }): void {
        if (parsed.rendered === false) {
            return;
        }
        if (parsed.cols < 1 || parsed.rows < 1) {
            console.warn(`[TerminalWsGateway] Ignoring degenerate resize ${parsed.cols}x${parsed.rows} for ${client.terminalName}`);
            return;
        }
        client.reportedSize = { cols: parsed.cols, rows: parsed.rows };
        this.reconcileTerminalSize(client.terminalName);
    }

    private reconcileTerminalSize(terminalName: string): void {
        const terminal = this.fleetService.get(terminalName);
        if (!terminal) { return; }

        let cols = Infinity;
        let rows = Infinity;
        for (const c of this.clients) {
            if (c.terminalName !== terminalName || !c.reportedSize) { continue; }
            cols = Math.min(cols, c.reportedSize.cols);
            rows = Math.min(rows, c.reportedSize.rows);
        }
        // Every attached client is still headless (or the last one with a viewport
        // just left). Leave the pty at whatever it already is rather than inventing
        // a size no client asked for.
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) { return; }

        terminal.resize(cols, rows);
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
        if (this.sharedFlushInterval) {
            clearInterval(this.sharedFlushInterval);
            this.sharedFlushInterval = undefined;
        }
        this.pendingFlushTerminals.clear();
        this.pendingOutput.clear();
        this.inputQueues.clear();
        for (const client of this.clients) {
            try { client.ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();
    }
}
