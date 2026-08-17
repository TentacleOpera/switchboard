import type { ExtendedTerminalHandle } from './ptyFleetService';

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

/** Lock-free body. Callers must already hold the terminal lock. */
export async function writeSlashCommandLocked(handle: ExtendedTerminalHandle, command: string): Promise<void> {
    handle.write(CLEAR_INPUT_LINE);
    await new Promise(r => setTimeout(r, CLEAR_INPUT_SETTLE_MS));
    handle.write(command.replace(/[\r\n]+$/, '') + '\r');
}

export interface PromptDeliveryOptions {
    clearBeforePrompt?: boolean;
    clearBeforePromptDelayMs?: number;
}

export async function sendPromptToPty(
    handle: ExtendedTerminalHandle,
    text: string,
    opts?: PromptDeliveryOptions
): Promise<void> {
    return withTerminalLock(handle.name, async () => {
        if (opts?.clearBeforePrompt) {
            await writeSlashCommandLocked(handle, '/clear');
            const delay = opts.clearBeforePromptDelayMs ?? DEFAULT_CLEAR_SETTLE_MS;
            await new Promise(r => setTimeout(r, Math.min(10000, Math.max(0, delay))));
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
        //      no role check, no CLI detection. Why one \r is enough on the clipboard branch in
        //      terminalUtils.ts (which pastes, sends ONE Enter, and returns — no confirm Enter
        //      for anyone, claude included, and that path ships) but not here is still open —
        //      but one theory is REFUTED by measurement, so do not revive it. Measured
        //      2026-08-14 with scripts/capture-cli-modes.js: it is NOT that we frame blind.
        //      BOTH CLIs enable bracketed paste at startup — claude emits ?2004h (after ?1049h
        //      alt-screen and mouse 1000/1002/1003/1006), devin emits ?2004h FIRST, on the
        //      normal screen, no mouse, synchronized output (?2026). The markers written below
        //      are honoured on both seats, so "devin's escape parser swallows an unnegotiated
        //      marker and eats the CR behind it" cannot explain the split.
        //      What survives: this path settles SUBMIT_SETTLE_MS (40ms) before the Enter where
        //      the clipboard branch settles ~400ms (POST_PASTE_SETTLE_MS + NEWLINE_DELAY), and
        //      the devin observation was made AFTER that constant was cut 100 -> 40. Nobody has
        //      tested devin at 100ms with a SINGLE CR — do that before treating the second CR as
        //      load-bearing. If it still needs two at a long settle, the next candidate is
        //      post-paste Enter semantics: a TUI that treats the first Enter after a bracketed
        //      paste as newline rather than submit needs two at any delay. The prior
        //      gate (CLI_AGENT_REGEX) was a static name match standing in for a runtime question:
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
        await new Promise(r => setTimeout(r, SUBMIT_SETTLE_MS));
        handle.write('\r');
        // Confirm Enter — see rule 2 above. Unconditional by design.
        await new Promise(r => setTimeout(r, CONFIRM_ENTER_DELAY_MS));
        handle.write('\r');
    });
}

/**
 * Send the agent-CLI context reset to a PTY — the same bytes sendPromptToPty
 * writes for clearBeforePrompt, lifted out so a UI button can reach them without
 * dispatching a prompt. Stays in this module to reuse withTerminalLock: a clear
 * issued outside it can splice into an in-flight chunked paste. Write errors are
 * swallowed: a PTY that died between the active-check and the write has no
 * context left to reset, so the clear has effectively succeeded.
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

