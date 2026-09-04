import type { ExtendedTerminalHandle } from './ptyFleetService';
import type { CliFamily } from '../services/cliIdentity';
import { createClearReadinessTracker, awaitFirstReadiness, type ClearReadinessResult, type ClearReadinessMode } from './clearReadiness';

const CHUNK_SIZE = 256;
// 30ms was inherited from the VS Code sendText path, where each chunk crosses an
// IPC boundary. handle.write() goes straight to the pty master fd — the only
// thing being paced here is the CLI's stdin reader, which keeps up at 8ms.
const CHUNK_DELAY_MS = 8;
// Settle windows. These pace a DIRECTLY-owned pty, not vscode.Terminal.sendText:
// there is no clipboard round trip, no focus acquisition, no extension-host IPC.
// See terminalUtils.ts (PRE_PASTE_SETTLE_MS / POST_PASTE_SETTLE_MS) for the
// indirect path's (already reduced) constants. The indirect path keeps 2000ms
// via terminal.clearBeforePromptDelay — do NOT unify the two, they are different
// physics on the same-named operation.
const DEFAULT_CLEAR_SETTLE_MS = 600;   // was 2000 — covers the CLI's /clear re-render
const SUBMIT_SETTLE_MS = 40;           // was 100 — small settle before Enter
// The confirm Enter waits on the CLI's own re-render of the pasted text, not on
// anything owning the pty master fd accelerates — so it stays at 200ms, the value
// that demonstrably submits claude seats today. The chunk/submit writes above go
// straight to the master fd and were cut to 8ms/40ms; this delay is different physics.
const CONFIRM_ENTER_DELAY_MS = 200;

const sendLocks = new Map<string, Promise<void>>();

function withTerminalLock<T>(terminalName: string, fn: () => Promise<T>): Promise<T> {
    const previous = sendLocks.get(terminalName) || Promise.resolve();
    const current = previous.then(fn, fn);
    sendLocks.set(terminalName, current.then(() => {}, () => {}));
    return current;
}

// Ctrl+U (unix-line-discard). Agent CLIs keep a persistent input buffer: anything
// already sitting in it concatenates with the next write, so `/clear` lands as
// `…text/clear` — a prompt, not a command, and the context is never reset. This
// byte empties the line first. No-op when empty, harmless in a plain shell, so it
// is sent unconditionally — no CLI detection, no role gate.
// It MUST land OUTSIDE any bracketed-paste block — i.e. before `\x1b[200~`, never
// after it. Inside the block it is absorbed as literal text and silently prefixes
// the payload (see the framing rules below). It is written on its own so it
// arrives as a keypress rather than as part of a burst the TUI may treat as paste.
const CLEAR_INPUT_LINE = '\x15';
// Just enough for the TUI to process the kill before the command arrives. Not a
// clipboard/focus settle — this path writes straight to the pty master fd.
const CLEAR_INPUT_SETTLE_MS = 30;

/**
 * Write a single-line slash command with the input line reset first.
 *
 * Takes the per-terminal lock, so a slash command can never splice into an
 * in-flight chunked paste from sendPromptToPty. Callers that ALREADY hold the
 * lock (sendPromptToPty's clear branch) must call writeSlashCommandLocked.
 */
export async function writeSlashCommand(handle: ExtendedTerminalHandle, command: string): Promise<void> {
    return withTerminalLock(handle.name, () => writeSlashCommandLocked(handle, command));
}

/**
 * Lock-free body. Callers must already hold the terminal lock.
 *
 * `onSubmitted` fires the instant the submitting CR is written — the readiness
 * tracker uses it to tell the CLI's echo of the typed command apart from its
 * post-clear re-render.
 */
export async function writeSlashCommandLocked(handle: ExtendedTerminalHandle, command: string, onSubmitted?: () => void): Promise<void> {
    handle.write(CLEAR_INPUT_LINE);
    await new Promise(r => setTimeout(r, CLEAR_INPUT_SETTLE_MS));
    // The submitting CR is its OWN write, after a real delay — NEVER concatenated
    // onto the command. Measured 2026-08-23 (see rule 2 below): devin 3000.5.20
    // inserts a literal newline instead of submitting when the CR arrives in the
    // same READ as printable text, so `'/clear' + '\r'` leaves the command sitting
    // in the input box unsent — and clearBeforePrompt then pastes the prompt on
    // top of it, delivering `/clear\n<prompt>` with the context never reset.
    // The await is load-bearing, not pacing: two back-to-back write() calls with
    // no delay between them fail exactly like one concatenated write, because the
    // pty coalesces them into a single read. Do not remove it.
    handle.write(command.replace(/[\r\n]+$/, ''));
    await new Promise(r => setTimeout(r, SUBMIT_SETTLE_MS));
    handle.write('\r');
    onSubmitted?.();
}

/**
 * Write `/clear` and wait until the cleared CLI's input editor is actually ready.
 * The tracker is created BEFORE the write — subscribing afterwards can miss the
 * OLD session's bracketed-paste disable, which is the transition Devin's state
 * machine anchors on. Caller must already hold the terminal lock.
 *
 * Returns the readiness result so callers can report the REAL reason
 * (signal / fallback / manual / exit) instead of assuming one.
 */
async function clearAndAwaitReadinessLocked(
    handle: ExtendedTerminalHandle,
    opts?: PromptDeliveryOptions
): Promise<ClearReadinessResult> {
    const tracker = createClearReadinessTracker(handle, {
        mode: opts?.clearReadinessMode,
        fallbackDelayMs: Math.min(10000, Math.max(0, opts?.clearBeforePromptDelayMs ?? DEFAULT_CLEAR_SETTLE_MS)),
        cliFamily: opts?.cliFamily || handle.cliFamily,
    });
    try {
        await writeSlashCommandLocked(handle, '/clear', tracker.markSubmitted);
        return await tracker.promise;
    } finally {
        tracker.dispose();
    }
}

export interface PromptDeliveryOptions {
    clearBeforePrompt?: boolean;
    clearBeforePromptDelayMs?: number;
    clearReadinessMode?: ClearReadinessMode;
    cliFamily?: CliFamily;
    /**
     * Fired after the prompt text has been written to the pty (before the
     * confirm CR). The terminal log writer registers as this callback to emit
     * a `##` heading at each dispatch boundary, giving the log document an
     * outline. This is the SHARED hook point — both hosts import
     * `sendPromptToPty`, so hooking here reaches both composition roots.
     * Hooking in `deliverPrompt` (standalone-only) would leave the extension
     * host with no headings.
     */
    onPromptDelivered?: (terminalName: string, promptText: string) => void;
}

export interface PromptDeliveryReceipt {
    /** The clear/boot readiness result, when either gate ran. Undefined on the
     *  established-seat, clearBeforePrompt:false path — unchanged semantics. */
    readiness?: ClearReadinessResult;
    /** UTF-8 byte length of the text WRITTEN TO THE PTY — the composed prompt,
     *  including any host-appended directives, seat block and standing orders.
     *  Not the length of the caller's `data` field. */
    bytesWritten: number;
    /** Date.now() captured immediately after the confirm CR. */
    deliveredAt: number;
    /** This seat's delivery ordinal, post-increment. Absent on an aborted send. */
    promptSeq?: number;
    /** Whether a context clear (/clear) was actually executed and completed ahead of the prompt. */
    cleared?: boolean;
}

/**
 * Deliver a prompt to a directly-owned pty.
 *
 * Returns a PromptDeliveryReceipt carrying delivery evidence: bytesWritten,
 * deliveredAt, promptSeq, and the readiness result (when either a clear or cold-boot
 * gate ran).
 *
 * On a seat with no prior delivery (`promptCount === 0`):
 *   1. `clearBeforePrompt` is forced false — a seat the host has never
 *      dispatched to has nothing to clear, and the `/clear` write is the one
 *      that can merge with the prompt on a booting CLI.
 *   2. The first-readiness gate (`awaitFirstReadiness`) waits for the CLI to
 *      produce output before the prompt is written — a floor prevents resolving
 *      inside the silent boot gap, a ceiling proceeds regardless (reason
 *      `timeout`), and an exit arm aborts delivery.
 */
export async function sendPromptToPty(
    handle: ExtendedTerminalHandle,
    text: string,
    opts?: PromptDeliveryOptions
): Promise<PromptDeliveryReceipt> {
    return withTerminalLock(handle.name, async (): Promise<PromptDeliveryReceipt> => {
        let readiness: ClearReadinessResult | undefined;
        const isFirstDelivery = handle.promptCount === 0;

        // Change 1: suppress clear on a seat with no prior delivery. A seat the
        // host has never dispatched to has nothing to clear, and the /clear
        // write is the one that can merge with the prompt on a booting CLI.
        // The existing work-context map (lastWorkContextByTerminal) is NOT on
        // the dispatchCards path — it lives only in the ptySendPrompt handler —
        // so the suppression must live here in the shared delivery layer.
        const effectiveClearBeforePrompt = isFirstDelivery ? false : (opts?.clearBeforePrompt === true);
        let cleared = false;

        // Change 3: first-readiness gate — wait for the cold-booting CLI to
        // produce output before writing anything. This is the ONE location
        // that covers both hosts: the standalone dispatchCards path and the
        // extension host's ptySendPrompt path both flow through sendPromptToPty.
        if (isFirstDelivery) {
            if (handle.status === 'exited') {
                return { readiness: { reason: 'exit', elapsedMs: 0 }, bytesWritten: 0, deliveredAt: Date.now(), cleared: false };
            }
            readiness = await awaitFirstReadiness(handle, {
                cliFamily: opts?.cliFamily || handle.cliFamily,
            });
            if (readiness.reason === 'exit' || (handle.status as string) === 'exited') {
                return { readiness, bytesWritten: 0, deliveredAt: Date.now(), cleared: false };
            }
        }

        if (effectiveClearBeforePrompt) {
            if (handle.status === 'exited') {
                return { readiness, bytesWritten: 0, deliveredAt: Date.now(), cleared: false };
            }
            readiness = await clearAndAwaitReadinessLocked(handle, opts);
            if (readiness.reason === 'exit' || (handle.status as string) === 'exited') {
                return { readiness, bytesWritten: 0, deliveredAt: Date.now(), cleared: false };
            }
            cleared = true;
        }

        // PORTED VERBATIM from _sendRobustTextBackground (src/services/terminalUtils.ts:241-258),
        // the VS Code path that has delivered prompts of arbitrary size to raw-mode agent CLIs
        // since 2026-07-20 (cf8846b0). That function is the reference implementation for prompt
        // delivery over a raw stdin: it needs no vscode API, so it ports to any host that can
        // write bytes to a terminal. Two rules it encodes, both load-bearing:
        //   1. The bracketed-paste markers are their OWN writes. Chunking the FRAMED string
        //      splits \x1b[201~ across a 30 ms gap whenever (6 + text.length) % 256 lands in
        //      the last five bytes — the 6 is the open marker \x1b[200~'s own width, which
        //      precedes the payload in the framed string and offsets the close marker's start;
        //      equivalently text.length % 256 ∈ [245,249]. The TUI never leaves paste mode and
        //      every later byte — \r, Ctrl-U, the next prompt — is absorbed as literal text.
        //   2. On this path a second \r is load-bearing. The old CLI_AGENT_REGEX gave
        //      allowlisted seats a confirm Enter and everyone else one; claude was allowlisted
        //      and submits reliably, devin was not and shows the pasted text land in the input
        //      field unsent — so the second CR below is UNCONDITIONAL: no regex, no allowlist,
        //      no role check, no CLI detection. Two theories about WHY are now closed by
        //      measurement. Do not revive either.
        //      (a) Measured 2026-08-14 with scripts/capture-cli-modes.js: it is NOT that we
        //      frame blind. BOTH CLIs enable bracketed paste at startup — claude emits ?2004h
        //      (after ?1049h alt-screen and mouse 1000/1002/1003/1006), devin emits ?2004h
        //      FIRST, on the normal screen, no mouse, synchronized output (?2026). The markers
        //      written below are honoured on both seats, so "devin's escape parser swallows an
        //      unnegotiated marker and eats the CR behind it" cannot explain the split.
        //      (b) Measured 2026-08-23, devin 3000.4.25 vs 3000.5.20, writing to a drawn input
        //      frame: it is not a settle-length question either. What decides submission is
        //      whether the CR arrives in the SAME READ as printable text. Concatenated
        //      ('/clear\r' as one write — or as two writes with no delay, which the pty
        //      coalesces) NEVER submits on 3000.5.20 at any delay; the CR is inserted as a
        //      literal newline. The identical bytes submit on 3000.4.25. An isolated CR 40ms
        //      after the text submits on both. LF instead of CR submits on neither. That also
        //      answers the old open question about the clipboard branch in terminalUtils.ts:
        //      its Enter is already isolated (`sendText('', true)` writes the newline on its
        //      own), so ONE is enough there. Every write of printable text on this path is
        //      therefore split from the CR that submits it — here and in
        //      writeSlashCommandLocked — and the settle between them must stay awaited.
        //      The prior gate (CLI_AGENT_REGEX) was a static name match standing in for a runtime question:
        //      it tested handle.name and handle.role, which carry no CLI identity for role-named
        //      seats, and it silently omitted 13 of the 19 CLIs in CLI_BRAND_ICON_KEYS. A stray
        //      Enter into a plain shell prints a blank prompt line — visible, user-fixable, and
        //      not worth a detection mechanism that will always be a static list pretending to
        //      be a runtime probe.
        // If a third host ever needs this, port that function again. Do not write a new one.
        handle.write('\x1b[200~');
        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            handle.write(text.slice(i, i + CHUNK_SIZE));
            if (i + CHUNK_SIZE < text.length) {
                await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
            }
        }
        handle.write('\x1b[201~');
        // Notify the log writer (or any flush observer) that a prompt was
        // delivered — the heading is emitted here, before the submit CR, so
        // the heading precedes the CLI's echo of the prompt in the log.
        if (opts?.onPromptDelivered) {
            try { opts.onPromptDelivered(handle.name, text); } catch { /* log writer must never crash delivery */ }
        }
        await new Promise(r => setTimeout(r, SUBMIT_SETTLE_MS));
        handle.write('\r');
        // Confirm Enter — see rule 2 above. Unconditional by design.
        await new Promise(r => setTimeout(r, CONFIRM_ENTER_DELAY_MS));
        handle.write('\r');
        const deliveredAt = Date.now();
        // Increment promptCount after the confirm CR — the delivery is now
        // complete. Subsequent dispatches will not suppress clear or run
        // the first-readiness gate. Keys changes 1, 3, 5, and 6.
        handle.promptCount += 1;
        const promptSeq = handle.promptCount;
        const bytesWritten = Buffer.byteLength(text, 'utf8');
        return {
            readiness,
            bytesWritten,
            deliveredAt,
            promptSeq,
            cleared,
        };
    });
}

/**
 * Send the agent-CLI context reset to a PTY — the same bytes sendPromptToPty
 * writes for clearBeforePrompt, lifted out so a UI button can reach them without
 * dispatching a prompt. Stays in this module to reuse withTerminalLock: a clear
 * issued outside it can splice into an in-flight chunked paste. Write errors are
 * swallowed: a PTY that died between the active-check and the write has no
 * context left to reset, so the clear has effectively succeeded.
 *
 * Deliberately fire-and-forget, with NO readiness detection. Every caller of this
 * function is a standalone clear — the Clear button, ptyClearAllTerminals, the
 * team roster reset, the accepted-coder clear on lead acceptance. In each case
 * the next write to that seat is minutes away (a lead has to read a diff and
 * compose a prompt), so detecting the CLI's return to readiness buys nothing and
 * stalls the caller behind the slowest seat. Readiness detection belongs to
 * sendPromptToPty, the ONE path where a prompt follows the clear with no gap.
 */
export async function clearPty(handle: ExtendedTerminalHandle): Promise<void> {
    return withTerminalLock(handle.name, async () => {
        try {
            await writeSlashCommandLocked(handle, '/clear');
        } catch { /* PTY died between check and write — nothing to clear */ }
    });
}

/**
 * Send the `/model` slash command to a PTY — a 1:1 mirror of clearPty with
 * `/model\r` in place of `/clear\r`. Stays in this module to reuse
 * withTerminalLock so the command cannot splice into an in-flight chunked
 * paste. Write errors are swallowed for the same reason as clearPty.
 */
export async function modelPty(handle: ExtendedTerminalHandle): Promise<void> {
    return withTerminalLock(handle.name, async () => {
        try {
            await writeSlashCommandLocked(handle, '/model');
        } catch { /* PTY died between check and write — nothing to model */ }
    });
}

