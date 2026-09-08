import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PromptDeliveryOptions } from './ptyPromptDelivery';
import { run, tmuxCaps, validatePaneId, type TmuxSocket, type TmuxTerminalHandle } from './tmuxBackend';

/**
 * tmux prompt delivery — deliberately parallel to `ptyPromptDelivery.ts`.
 *
 * Same options shape (`PromptDeliveryOptions`), same lock pattern (keyed on
 * `paneId` — not friendly name, which a user can rename mid-send), same
 * unconditional double-confirm CR. The delivery logic is duplicated rather
 * than abstracted: the PTY path writes bytes to an fd, the tmux path shells
 * out to a control binary, and forcing them behind one helper would obscure
 * both. Revisit only if a third transport appears.
 *
 * NO clear-readiness tracker: the PTY path uses `clearAndAwaitReadinessLocked`
 * to wait for the CLI's actual re-render signal after `/clear`. The tmux path
 * is send-only (no `onData` stream), so it cannot use the tracker — a fixed
 * delay is the only option. This is an inherent limitation of the send-only
 * design, not a parity gap that can be closed.
 */

// ─── Constants ───────────────────────────────────────────────────────────
// tmux-specific pacing. Each chunk is a separate `execFile` call (orders of
// magnitude slower than an fd write), so the PTY path's 8ms would be too
// aggressive. 30ms is justified by the per-chunk execFile overhead, NOT by
// PTY parity. Named `TMUX_CHUNK_DELAY_MS` so it is not confused with the PTY
// constant (`CHUNK_DELAY_MS = 8` in ptyPromptDelivery.ts).
const TMUX_CHUNK_SIZE = 256;
const TMUX_CHUNK_DELAY_MS = 30;

// Settle before the submit Enter. The PTY path uses 40ms (SUBMIT_SETTLE_MS)
// because it writes straight to the master fd; tmux crosses an execFile
// boundary, so 100ms is more conservative.
const SUBMIT_SETTLE_MS = 100;

// The confirm Enter waits on the CLI's own re-render of the pasted text.
// Matches the PTY path's CONFIRM_ENTER_DELAY_MS (ptyPromptDelivery.ts:23) —
// the value that demonstrably submits claude seats today.
const CONFIRM_ENTER_DELAY_MS = 200;

// Clear settle — tmux-specific. The `/clear` command goes through send-keys
// (external process) and the pane re-renders without a readiness signal, so
// a conservative default is warranted. The PTY default is 600ms with a
// readiness tracker; the tmux path has no tracker, so 2000ms is the floor.
// Clamped 0..10000 (identical clamp to ptyPromptDelivery.ts:30).
const DEFAULT_CLEAR_SETTLE_MS = 2000;
const MAX_CLEAR_SETTLE_MS = 10000;

// ─── Per-pane lock ───────────────────────────────────────────────────────
// Keyed on `paneId` (not friendly name, which a user can rename mid-send).
// Copies the promise-chain lock pattern from ptyPromptDelivery.ts:25-53.
const sendLocks = new Map<string, Promise<void>>();

function withTmuxLock<T>(paneId: string, fn: () => Promise<T>): Promise<T> {
    const previous = sendLocks.get(paneId) || Promise.resolve();
    const current = previous.then(fn, fn);
    sendLocks.set(paneId, current.then(() => {}, () => {}));
    return current;
}

// ─── Buffer namespacing ──────────────────────────────────────────────────
// `switchboard-<pid>-<counter>` — uniquely named so concurrent load-buffer
// calls never collide on a buffer name. The per-process counter is the
// collision guard. `paste-buffer -d` deletes the buffer after pasting, so
// this never touches the user's unnamed buffer stack.
let _bufferCounter = 0;
function nextBufferName(): string {
    return `switchboard-${process.pid}-${_bufferCounter++}`;
}

// ─── Temp file helpers ───────────────────────────────────────────────────
// The `load-buffer <file>` fallback writes plan content to disk. Create with
// mode 0600, unlink in a `finally` so a throw mid-paste does not leave prompt
// text readable. The `finally` is load-bearing, not defensive decoration.
function createTempFile(content: string): string {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `switchboard-tmux-${process.pid}-${Date.now()}-${_bufferCounter}.buf`);
    fs.writeFileSync(tmpFile, content, { mode: 0o600 });
    return tmpFile;
}

function safeUnlink(filePath: string): void {
    try { fs.unlinkSync(filePath); } catch { /* already gone — nothing to clean */ }
}

// ─── Clear ───────────────────────────────────────────────────────────────
/**
 * Send `/clear` to a tmux pane — the step-1 bytes lifted out of
 * `sendPromptToTmux` so a UI button can reach them without dispatching a
 * prompt. Stays in this module to reuse `withTmuxLock`: a clear issued
 * outside it can splice into an in-flight paste. Write errors are swallowed:
 * a pane that died between the active-check and the send has no context left
 * to reset, so the clear has effectively succeeded. Mirrors `clearPty`
 * (ptyPromptDelivery.ts:393-399) including its swallow-on-dead-pane rationale.
 *
 * Deliberately fire-and-forget, with NO readiness detection — same rationale
 * as `clearPty`: every caller's next write is minutes away, so detecting the
 * CLI's return to readiness buys nothing and stalls the caller.
 */
export async function clearTmuxPane(handle: TmuxTerminalHandle): Promise<void> {
    return withTmuxLock(handle.paneId, async () => {
        try {
            await sendClearLocked(handle, handle.socket);
        } catch { /* pane died — nothing to clear */ }
    });
}

/**
 * Lock-free body: send `/clear` + Enter. Caller must already hold the
 * per-pane lock.
 */
async function sendClearLocked(handle: TmuxTerminalHandle, socket?: TmuxSocket): Promise<void> {
    validatePaneId(handle.paneId);
    await run(['send-keys', '-t', handle.paneId, '-l', '/clear'], socket);
    await run(['send-keys', '-t', handle.paneId, 'Enter'], socket);
}

// ─── Prompt delivery ─────────────────────────────────────────────────────

/**
 * Deliver a prompt to a tmux pane. Sequence inside the per-pane lock:
 *
 * 1. If `opts.clearBeforePrompt`: `send-keys -l '/clear'` + `Enter`, then
 *    wait `clearBeforePromptDelayMs ?? 2000`, clamped `0..10000`.
 * 2. Deliver the payload:
 *    - **Preferred** (`caps.bracketedPaste`): buffer route — no argv length
 *      limit, bracket framing for free. `load-buffer -b <name> <tmpfile>` (or
 *      `-` + stdin when `caps.stdinBuffer`), then `paste-buffer -b <name> -t
 *      %id -d -p`. `-d` deletes the buffer after pasting; `-p` requests
 *      bracket codes. Temp file mode 0600, unlink in `finally`.
 *    - **Fallback** (no bracketed paste, tmux < 2.6): flatten newlines to
 *      spaces, then chunked `send-keys -l` at 256 bytes / 30ms. The
 *      flattening decision is based on the tmux version capability
 *      (`caps.bracketedPaste`), not on a CLI-agent name regex.
 * 3. Settle 100ms → `send-keys -t %id Enter`.
 * 4. Wait 200ms → a second `Enter`, **unconditionally** (no name/role/regex
 *    gate). Matches the PTY path's unconditional double-confirm
 *    (ptyPromptDelivery.ts:257-259).
 */
export async function sendPromptToTmux(
    handle: TmuxTerminalHandle,
    text: string,
    opts?: PromptDeliveryOptions
): Promise<void> {
    return withTmuxLock(handle.paneId, async () => {
        validatePaneId(handle.paneId);
        const socket = handle.socket;
        const caps = await tmuxCaps(socket);

        // Step 1: optional clear.
        if (opts?.clearBeforePrompt) {
            await sendClearLocked(handle, socket);
            const clearDelay = Math.min(
                MAX_CLEAR_SETTLE_MS,
                Math.max(0, opts?.clearBeforePromptDelayMs ?? DEFAULT_CLEAR_SETTLE_MS)
            );
            if (clearDelay > 0) {
                await new Promise(r => setTimeout(r, clearDelay));
            }
        }

        // Step 2: deliver the payload.
        if (caps.bracketedPaste) {
            await deliverViaBuffer(handle, text, caps, socket);
        } else {
            await deliverViaSendKeys(handle, text, socket);
        }

        // Step 3: submit Enter.
        await new Promise(r => setTimeout(r, SUBMIT_SETTLE_MS));
        await run(['send-keys', '-t', handle.paneId, 'Enter'], socket);

        // Step 4: confirm Enter — unconditional (no name/role/regex gate).
        // Matches the PTY path's unconditional double-confirm.
        await new Promise(r => setTimeout(r, CONFIRM_ENTER_DELAY_MS));
        await run(['send-keys', '-t', handle.paneId, 'Enter'], socket);
    });
}

/**
 * Buffer route — preferred when `caps.bracketedPaste` is true. No argv length
 * limit and bracket framing for free. Temp file is the primary route (works
 * on tmux ≥ 1.9); stdin is an optimization on ≥ 3.2.
 */
async function deliverViaBuffer(
    handle: TmuxTerminalHandle,
    text: string,
    caps: { stdinBuffer: boolean; bracketedPaste: boolean; hexKeys: boolean },
    socket?: TmuxSocket
): Promise<void> {
    validatePaneId(handle.paneId);
    const bufName = nextBufferName();

    if (caps.stdinBuffer) {
        // load-buffer - (stdin) — tmux ≥ 3.2. No temp file needed.
        await run(['load-buffer', '-b', bufName, '-'], socket, text);
    } else {
        // load-buffer <file> — tmux ≥ 1.9. Temp file with mode 0600.
        const tmpFile = createTempFile(text);
        try {
            await run(['load-buffer', '-b', bufName, tmpFile], socket);
        } finally {
            safeUnlink(tmpFile);
        }
    }

    // paste-buffer -d -p: -d deletes the buffer after pasting (no residue),
    // -p requests bracket codes. If the pane's foreground app did not enable
    // bracketed paste mode, tmux emits no brackets and multiline text submits
    // line-by-line — undetectable from outside and documented as a risk.
    try {
        await run(['paste-buffer', '-b', bufName, '-t', handle.paneId, '-d', '-p'], socket);
    } catch {
        // If paste-buffer fails, ensure the buffer is cleaned up.
        try { await run(['delete-buffer', '-b', bufName], socket); } catch { /* buffer may already be gone */ }
        throw new Error(`tmux paste-buffer failed for pane ${handle.paneId}`);
    }
}

/**
 * Fallback — when `caps.bracketedPaste` is false (tmux < 2.6). Flatten
 * newlines to spaces (a plain `bash` pane gets no brackets, so a multiline
 * payload would submit line-by-line — each line running as a shell command),
 * then chunked `send-keys -l` at 256 bytes / 30ms.
 */
async function deliverViaSendKeys(
    handle: TmuxTerminalHandle,
    text: string,
    socket?: TmuxSocket
): Promise<void> {
    validatePaneId(handle.paneId);
    // Flatten newlines to spaces — the pane's foreground app has not enabled
    // bracketed paste mode, so multiline text would submit line-by-line.
    const flattened = text.replace(/[\r\n]+/g, ' ');
    for (let i = 0; i < flattened.length; i += TMUX_CHUNK_SIZE) {
        const chunk = flattened.slice(i, i + TMUX_CHUNK_SIZE);
        await run(['send-keys', '-t', handle.paneId, '-l', chunk], socket);
        if (i + TMUX_CHUNK_SIZE < flattened.length) {
            await new Promise(r => setTimeout(r, TMUX_CHUNK_DELAY_MS));
        }
    }
}
