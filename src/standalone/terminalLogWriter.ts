/**
 * Per-terminal markdown log writer.
 *
 * Tees flushed pty output to `.switchboard/logs/<terminal-name>-<session-id>.md`,
 * stripping ANSI, collapsing carriage-return redraws, and keeping agent-printed
 * code fences from closing the log's own code block. Each prompt delivery opens
 * a `##` heading so the document has an outline keyed to dispatch boundaries.
 *
 * The writer subscribes to the gateway's flush observer (output chunks) and to
 * prompt-delivery notifications (headings). Writes are queued per terminal via
 * an async chain so a slow disk never blocks the shared flush interval — the
 * single `setInterval` in `terminalWsGateway.ts` drives every terminal's flush,
 * so a blocking `appendFileSync` here would stall them all.
 *
 * Session boundaries (triggered by `clearTerminalContext` / `queue/done`) roll
 * the file: the current session is closed and a new session-id file is started,
 * so a cleared terminal starting fresh work reads as a new document to a reader.
 *
 * Both hosts construct and subscribe this writer after gateway creation:
 * standalone (`bootstrap.ts`) and extension pty child (`ptyHost.ts`).
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Size cap before the active log rolls to a FRESH SESSION FILE.
 *
 * Rotation is a session roll, not a `<file>.1` rename: every log file the
 * writer produces stays a `<name>-<session-id>.md` the read endpoint and the
 * viewer's session sidebar can find. A `.md.1` rename would put the rotated
 * half behind the endpoint's `.md` filter — rotated history that exists on
 * disk and is unreachable from the only UI that reads it.
 *
 * 10 MiB is enough for a long agent session of stripped, CR-collapsed output.
 * Retention across session files is deferred to
 * `retention-and-archive-for-unbounded-growth.md`; the writer only rolls.
 */
const LOG_CAP_BYTES = 10 * 1024 * 1024;

/**
 * Cap on the CR-collapse carry — the incomplete trailing line held back until
 * its newline arrives.
 *
 * A well-behaved stream keeps this at one line. A TUI that repaints with cursor
 * positioning and never emits `\n` does not: ANSI stripping removes the
 * positioning, so an entire screen repaint concatenates into ONE line and the
 * carry grows for as long as the TUI runs. Flushing at the cap bounds the
 * memory instead of trusting the program on the other end to send a newline.
 */
const CARRY_CAP_BYTES = 64 * 1024;

/**
 * The opening and closing fence for an output block.
 *
 * `renderMarkdown` (`sharedUtils.js`) delimits code blocks on EXACTLY three
 * backticks — `/```(\w*)([\s\S]*?)```/`, not line-anchored — so the plan's
 * other option, "a fence longer than anything in the payload", does not work
 * against this renderer: a ``` printed by an agent closes the block however
 * long the surrounding fence is, and the rest of the session renders as prose.
 * Two rules make the document safe instead:
 *
 *  1. Payload text never contains a run of three or more backticks
 *     (`sanitizeFencePayload` breaks them up), so only the writer's own fence
 *     lines can open or close a block.
 *  2. The opening fence carries an info string and the closing fence does not,
 *     so a reader handed an arbitrary TAIL of the file — which is exactly what
 *     the ranged log endpoint serves — can tell whether its slice starts inside
 *     a block and balance it. `renderMarkdown` drops the info string.
 */
export const LOG_FENCE_OPEN = '```console';
export const LOG_FENCE_CLOSE = '```';

/**
 * Comprehensive ANSI escape sequence stripper.
 *
 * No `strip-ansi` dependency — a single regex covering CSI, OSC, charset
 * designation, and simple two-byte escapes. The markdown document is rendered
 * by the docs viewer, which cannot carry escape sequences, so colour and TUI
 * structure are deliberately lost here. The live terminal remains the place
 * for those; the log is for reading.
 *
 * Matches:
 *   - CSI:  ESC [ params intermediates final   (\x1b[?1049h, \x1b[31m, …)
 *   - OSC:  ESC ] payload (BEL | ST)            (\x1b]0;title\x07, …)
 *   - DCS/APC/PM/SOS: ESC P/_/^/X … ST          (string sequences)
 *   - Charset: ESC ( B, ESC ) 0, ESC * B, ESC + B
 *   - Simple: ESC c, ESC 7, ESC =, ESC >, ESC 8, ESC D, ESC E, ESC M, ESC H
 *   - 8-bit CSI: 0x9b … final
 *   - 8-bit ST:  0x9c
 */
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x1b]*(?:\x1b\\|\x9c)|\x1b[()*+].|\x1b[@-Z\\-_]|\x9b[ -\/]*[@-~]|\x9c/g;

/**
 * Strip ANSI escape sequences from a chunk of terminal output.
 */
export function stripAnsi(text: string): string {
    return text.replace(ANSI_REGEX, '');
}

/**
 * Collapse carriage-return redraws: for each line, keep only the final state
 * after `\r` overwrites. A spinner rewriting one line still emits every version
 * in the raw stream; a document made of spinner frames is unreadable, and the
 * bloat is almost entirely here.
 *
 * Handles `\r\n` (normal newline — the `\r` is not a redraw) and bare `\r`
 * (cursor to column 0, overwrite). A carry buffer holds a partial CR-collapse
 * run across flush boundaries so a line split between two flushes is collapsed
 * correctly.
 *
 * Returns the collapsed text and the carry (the incomplete trailing line) so
 * the caller can prepend it to the next chunk.
 */
export function collapseCarriageReturns(text: string, carry: string): { collapsed: string; carry: string } {
    const input = carry + text;
    // Split on \n but keep the \n so we can rejoin. A \r before \n is a normal
    // newline (CRLF), not a redraw — we treat it as a line break and strip the
    // bare \r during collapse.
    const lines = input.split('\n');
    // The last element is the incomplete trailing line (no \n) — carry it.
    const trailing = lines.pop() ?? '';

    const result: string[] = [];
    for (const line of lines) {
        result.push(collapseLine(line));
    }

    // The trailing line may itself contain \r redraws that will be continued
    // in the next chunk. We collapse what we can but carry the whole trailing
    // segment so the next chunk's redraws can overwrite it.
    const collapsedTrailing = collapseLine(trailing);
    return {
        collapsed: result.length > 0 ? result.join('\n') + '\n' : '',
        carry: collapsedTrailing,
    };
}

/**
 * Collapse a single line's `\r` redraws.
 *
 * `\r` moves the cursor to column 0; subsequent characters overwrite from the
 * start. We simulate this by overlaying each `\r`-delimited segment from column
 * 0, so the result is the final visible state of the line.
 */
function collapseLine(line: string): string {
    if (!line.includes('\r')) { return line; }
    // Split on \r and overlay each segment from column 0. \r returns the cursor
    // to column 0; subsequent characters overwrite from the start. If a segment
    // is shorter than the current line, the tail survives; if longer, it extends.
    const segments = line.split('\r');
    let result = '';
    for (const seg of segments) {
        result = seg + result.slice(seg.length);
    }
    return result;
}

/**
 * Break up any run of three or more backticks so agent-printed code fences
 * cannot close the log's own code block.
 *
 * A zero-width space is inserted between the backticks: no ``` substring
 * survives, and the backtick characters themselves are still there for anyone
 * reading the file raw. Runs of one or two backticks are left alone — they
 * cannot delimit a fence.
 *
 * Known cosmetic limit: `renderMarkdown` applies its inline `` `code` `` rule
 * inside `<pre>` too, so a broken-up run renders as an empty `<code>` span
 * rather than as visible backticks. The agent's fence MARKERS are what get
 * swallowed; the code between them stays inside the block and reads correctly,
 * which is the invariant that matters.
 */
export function sanitizeFencePayload(text: string): string {
    return text.replace(/`{3,}/g, run => run.split('').join('​'));
}

/**
 * Balance the fences in an arbitrary slice of a log file.
 *
 * The ranged log endpoint serves a byte range, so a slice can begin inside an
 * output block and can end inside the block the live session is still writing.
 * Either leaves `renderMarkdown` with an unpaired fence, which drops the rest
 * of the document out of its code block and renders terminal output as prose —
 * the same "renders fine until it doesn't" failure the fence discipline above
 * exists to prevent, arriving one layer later.
 *
 * `fromOffset` says the slice starts mid-file: the partial first line is
 * dropped, and a slice whose first fence line is a CLOSE (or which holds no
 * fence line at all) began inside a block, so an opening fence is prepended.
 * A slice that begins outside a block reaches its first fence line as an OPEN,
 * and the headings and blank lines before it are prose in the original too.
 */
export function normalizeLogSlice(slice: string, fromOffset: boolean): string {
    let text = slice;
    if (fromOffset) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    if (!text) { return ''; }

    const lines = text.split('\n');
    let firstFence: string | undefined;
    for (const line of lines) {
        if (line === LOG_FENCE_OPEN || line === LOG_FENCE_CLOSE) { firstFence = line; break; }
    }
    if (fromOffset && firstFence !== LOG_FENCE_OPEN) {
        text = `${LOG_FENCE_OPEN}\n${text}`;
        lines.unshift(LOG_FENCE_OPEN);
    }

    let open = false;
    for (const line of lines) {
        if (line === LOG_FENCE_OPEN) { open = true; }
        else if (line === LOG_FENCE_CLOSE) { open = false; }
    }
    if (open) {
        text = text.endsWith('\n') ? `${text}${LOG_FENCE_CLOSE}\n` : `${text}\n${LOG_FENCE_CLOSE}\n`;
    }
    return text;
}

/**
 * Per-terminal write state.
 */
interface TerminalLogState {
    /** Current session ID (timestamp-based, rolled on session boundary). */
    sessionId: string;
    /** Full path to the current log file. */
    filePath: string;
    /** CR-collapse carry across flush boundaries. */
    crCarry: string;
    /** Async write chain — serializes writes so flush is never blocked. */
    writeChain: Promise<void>;
    /** Whether an output code block is currently open in the file. */
    fenceOpen: boolean;
    /**
     * Bytes enqueued for the current session file. Counted at ENQUEUE time, not
     * from `statSync`, so the size check that triggers a roll stays synchronous
     * and never puts an fs call on the flush path.
     */
    bytesWritten: number;
}

/**
 * A log writer that tees terminal output to per-session markdown files.
 *
 * Constructed and subscribed in both hosts after gateway creation. The gateway
 * calls `onFlush` for each coalesced output chunk; the prompt delivery path
 * calls `onPrompt` for each dispatch boundary. Session boundaries roll the file.
 */
export class TerminalLogWriter {
    private logsDir: string;
    private terminals = new Map<string, TerminalLogState>();
    private disposed = false;

    /**
     * @param logsDir The `.switchboard/logs/` directory. Created if it does not exist.
     */
    constructor(logsDir: string) {
        this.logsDir = logsDir;
        try {
            fs.mkdirSync(logsDir, { recursive: true });
        } catch { /* may already exist, or dir creation fails — writes will no-op */ }
    }

    /**
     * Handle a flushed output chunk from the gateway.
     *
     * Strips ANSI, collapses CR redraws, keeps the payload fence-safe, and
     * queues an async write. Never blocks the caller — the write is appended to
     * a per-terminal promise chain.
     */
    onFlush(terminalName: string, data: string): void {
        if (this.disposed) { return; }
        const state = this.getOrCreateState(terminalName);

        const stripped = stripAnsi(data);
        const { collapsed, carry } = collapseCarriageReturns(stripped, state.crCarry);
        state.crCarry = carry;

        let out = collapsed;
        // A stream that never sends a newline would otherwise grow the carry for
        // the life of the terminal. Flush it as a line of its own at the cap.
        if (state.crCarry.length > CARRY_CAP_BYTES) {
            out += `${state.crCarry}\n`;
            state.crCarry = '';
        }
        if (!out) { return; }

        this.writeOutput(terminalName, state, out);
    }

    /**
     * Write a `##` heading for a prompt delivery (dispatch boundary).
     *
     * Gives the document an outline keyed to dispatch boundaries. The heading
     * text is `## <ISO timestamp> — <first 80 chars of prompt, single line>`.
     * The open output block is closed first — a heading inside a fence is just
     * a line of text, and the outline it exists for would not render.
     */
    onPrompt(terminalName: string, promptText: string): void {
        if (this.disposed) { return; }
        const state = this.getOrCreateState(terminalName);

        this.flushCarry(terminalName, state);
        this.closeFence(state);

        const ts = new Date().toISOString();
        // Sanitized: a prompt that opens with a code fence would otherwise put
        // ``` on the heading line, and renderMarkdown's fence match is not
        // line-anchored — it would delimit a block from the middle of a heading.
        const firstLine = sanitizeFencePayload(promptText.replace(/[\r\n]+/g, ' ').trim().slice(0, 80));
        this.enqueueWrite(state, `\n## ${ts} — ${firstLine}\n\n`);
    }

    /**
     * Roll the log file for a session boundary (e.g. `clearTerminalContext`).
     *
     * Closes the current session and starts a new one. The old file is
     * preserved on disk.
     */
    onSessionBoundary(terminalName: string): void {
        if (this.disposed) { return; }
        const state = this.terminals.get(terminalName);
        if (!state) { return; }
        this.rollSession(terminalName, state);
    }

    /**
     * Rekey a terminal's log state after a fleet rename.
     *
     * The file on disk keeps its old name (the session was started under it);
     * only the in-memory key moves so new flushes route correctly. A new session
     * after the rename would use the new name.
     */
    onRename(oldName: string, newName: string): void {
        if (this.disposed || !oldName || !newName || oldName === newName) { return; }
        const state = this.terminals.get(oldName);
        if (!state) { return; }
        this.terminals.set(newName, state);
        this.terminals.delete(oldName);
    }

    /**
     * Close the log for a terminal that has been removed from the fleet.
     * Flushes the CR carry and closes the open output block.
     */
    onClose(terminalName: string): void {
        if (this.disposed) { return; }
        const state = this.terminals.get(terminalName);
        if (!state) { return; }
        this.flushCarry(terminalName, state);
        this.closeFence(state);
        // The write chain will complete async; we just stop tracking.
        this.terminals.delete(terminalName);
    }

    // No path accessor and no session lister here on purpose. In the extension
    // host this writer runs inside the pty child, so LocalApiServer could never
    // call one — the read endpoints resolve sessions by reading the logs
    // directory, which works in both hosts. An accessor whose docblock claimed
    // the endpoint used it would be a comment the code cannot honour.

    dispose(): void {
        if (this.disposed) { return; }
        // Close every open block before we stop: an unbalanced trailing fence is
        // the state the read path has to guess about. Pending writes are left to
        // finish — never cancelled mid-write.
        for (const [name, state] of this.terminals) {
            this.flushCarry(name, state);
            this.closeFence(state);
        }
        this.disposed = true;
    }

    // --- Internal ---

    private getOrCreateState(terminalName: string): TerminalLogState {
        let state = this.terminals.get(terminalName);
        if (!state) {
            const sessionId = makeSessionId();
            state = {
                sessionId,
                filePath: this.makeFilePath(terminalName, sessionId),
                crCarry: '',
                writeChain: Promise.resolve(),
                fenceOpen: false,
                bytesWritten: 0,
            };
            this.terminals.set(terminalName, state);
            this.writeHeader(terminalName, state);
        }
        return state;
    }

    private makeFilePath(terminalName: string, sessionId: string): string {
        return path.join(this.logsDir, `${sanitizeFileName(terminalName)}-${sessionId}.md`);
    }

    private writeHeader(terminalName: string, state: TerminalLogState): void {
        const name = sanitizeFencePayload(terminalName);
        this.enqueueWrite(state, `# Terminal log: ${name}\n\nSession started ${new Date().toISOString()}\n`);
    }

    /**
     * Start a fresh session file: close the current block, re-key the path, and
     * write the new document's header. Used by both the `queue/done` session
     * boundary and the size cap.
     */
    private rollSession(terminalName: string, state: TerminalLogState): void {
        this.flushCarry(terminalName, state);
        this.closeFence(state);
        state.sessionId = makeSessionId();
        state.filePath = this.makeFilePath(terminalName, state.sessionId);
        state.bytesWritten = 0;
        this.writeHeader(terminalName, state);
    }

    /**
     * Emit the held-back partial line as a line of its own.
     *
     * `allowRoll: false` — the carry belongs to the session that produced it, so
     * flushing it must not itself trigger a roll. It is also what keeps
     * `rollSession → flushCarry → writeOutput → rollSession` from recursing.
     */
    private flushCarry(terminalName: string, state: TerminalLogState): void {
        if (!state.crCarry) { return; }
        const carry = state.crCarry;
        state.crCarry = '';
        this.writeOutput(terminalName, state, `${carry}\n`, false);
    }

    /**
     * Append output text inside the session's code block, opening the block
     * first if it is closed and rolling the session if the cap is reached.
     */
    private writeOutput(terminalName: string, state: TerminalLogState, text: string, allowRoll = true): void {
        if (allowRoll && state.bytesWritten > 0 && state.bytesWritten + text.length > LOG_CAP_BYTES) {
            this.rollSession(terminalName, state);
        }
        if (!state.fenceOpen) {
            this.enqueueWrite(state, `${LOG_FENCE_OPEN}\n`);
            state.fenceOpen = true;
        }
        this.enqueueWrite(state, sanitizeFencePayload(text));
    }

    private closeFence(state: TerminalLogState): void {
        if (!state.fenceOpen) { return; }
        state.fenceOpen = false;
        this.enqueueWrite(state, `${LOG_FENCE_CLOSE}\n`);
    }

    /**
     * Queue an append. The target path is captured HERE, not read inside the
     * chain: a session roll rewrites `state.filePath` synchronously, and a write
     * queued before the roll belongs to the session it was produced in.
     */
    private enqueueWrite(state: TerminalLogState, content: string): void {
        const target = state.filePath;
        state.bytesWritten += content.length;
        state.writeChain = state.writeChain.then(() => this.appendToFile(target, content));
    }

    /**
     * Append content to the log file.
     *
     * Uses `appendFileSync` (reopened on every write, following the `cli.ts`
     * pattern) so there is no long-lived fd to reopen. The write runs inside the
     * per-terminal async chain, so it never blocks the shared flush interval.
     */
    private appendToFile(filePath: string, content: string): void {
        try {
            fs.appendFileSync(filePath, content);
        } catch { /* logging must never crash the gateway */ }
    }
}

/**
 * Generate a session ID — a timestamp with a random suffix for uniqueness.
 *
 * Base36 of `Date.now()` is fixed-width for the next half-century, so sorting
 * session filenames lexicographically sorts them chronologically — which is
 * what the read endpoint and the viewer's sidebar rely on to pick "the most
 * recent session".
 */
function makeSessionId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}`;
}

/**
 * Sanitize a terminal name for use in a filename.
 *
 * Replaces path separators and other filesystem-unsafe characters with `_`.
 * Must not collide with `server.log` (the `cli.ts` logger's file) — the
 * `-<session-id>.md` suffix guarantees this since `server.log` has no session ID.
 */
function sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
