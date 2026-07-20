import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';

// Clipboard mutex: serialize paste operations to prevent user clipboard data loss
let _clipboardLock: Promise<void> = Promise.resolve();
function withClipboardLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = _clipboardLock.then(fn, fn);
    _clipboardLock = next.then(() => {}, () => {});
    return next;
}

// Per-terminal send lock: serialize the FULL /clear + prompt sequence for a
// single terminal so two overlapping dispatches to the same terminal cannot
// interleave their clears and prompts (e.g. rapid double "move all", or two
// columns dispatching to the planner role at once). Distinct terminals keep
// running concurrently. The KEY is a normalized terminal name (the caller
// normalizes), so suffix/case aliases of the same terminal share one lock.
// Mirrors the proven _clipboardLock promise-chain pattern above.
const _terminalSendLocks = new Map<string, Promise<void>>();

export function withTerminalSendLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (_terminalSendLocks.has(key)) {
        // Diagnostic: a previous send to this terminal is still in flight, so
        // this one will queue behind it. Helps explain any perceived slowness.
        console.log(`[TerminalSendLock] Queuing send to '${key}' — previous send in progress`);
    }
    const existing = _terminalSendLocks.get(key) || Promise.resolve();
    const next = existing.then(fn, fn);
    // Store a result/error-swallowing tail so the chain always advances even if
    // a send rejects (e.g. terminal closed mid-send). No deadlock on failure.
    _terminalSendLocks.set(key, next.then(() => {}, () => {}));
    return next;
}

// Optional: drop a terminal's lock entry (e.g. from a terminal-close handler).
// Not required — the map is bounded by the small set of role-terminal names.
export function cleanupTerminalSendLock(key: string): void {
    _terminalSendLocks.delete(key);
}

// Per-terminal background send queue: serializes non-focus-stealing
// `sendText`-based background deliveries (e.g. Comms Monitor poll ticks and
// auth checks) so concurrent sends to the same terminal cannot interleave
// their chunks. WeakMap keys die with the Terminal instance.
const _backgroundSendQueues = new WeakMap<vscode.Terminal, Promise<void>>();


// Named timing constants for clipboard paste operations
const PRE_PASTE_SETTLE_MS = 200;

// Connection-aware paste settle delay. Web research confirmed 100ms is safe
// for local terminals but unsafe for Remote-SSH (50-200ms RTT) where the
// Enter sequence can arrive before the clipboard buffer transfers.
// vscode.env.remoteName is undefined for local, non-undefined for remote.
const isRemoteTerminal = () => vscode.env.remoteName !== undefined;
const POST_PASTE_SETTLE_MS = () => isRemoteTerminal() ? 300 : 100; // was 800

/**
 * Paste text to terminal via clipboard to bypass PTY line-buffer limits.
 * Saves existing clipboard content, writes new text, pastes, then restores.
 */
export async function pasteTextViaClipboard(
    terminal: vscode.Terminal,
    text: string,
    options?: { acquireFocus?: boolean }
): Promise<void> {
    const acquireFocus = options?.acquireFocus !== false; // default true
    await withClipboardLock(async () => {
        let previousClipboard = '';
        try { previousClipboard = await vscode.env.clipboard.readText(); } catch { /* ignore */ }
        await vscode.env.clipboard.writeText(text);

        if (acquireFocus) {
            // workbench.action.terminal.paste targets the ACTIVE terminal, not the
            // captured reference. Force-focus the target and verify before pasting.
            // Retry loop covers the brief window where another terminal could steal focus.
            for (let attempt = 0; attempt < 3; attempt++) {
                terminal.show(true);
                await new Promise(r => setTimeout(r, 20));
                if (vscode.window.activeTerminal === terminal) { break; }
                await new Promise(r => setTimeout(r, 30));
            }
            if (vscode.window.activeTerminal !== terminal) {
                // Could not acquire focus. THROW rather than fall back to sendText —
                // sendText('/clear') reintroduces the slash-command concatenation bug
                // that pasteTextViaClipboard exists to prevent. Both callers have
                // try/catch handlers that degrade gracefully:
                //   - _attemptDirectTerminalPush: skips clear, proceeds to prompt
                //   - sendRobustText: falls back to chunked sendText (safe for prompts)
                try { await vscode.env.clipboard.writeText(previousClipboard); } catch { /* ignore */ }
                throw new Error(`pasteTextViaClipboard: could not acquire focus on terminal '${terminal.name}' after 3 attempts`);
            }
            await new Promise(r => setTimeout(r, PRE_PASTE_SETTLE_MS));
        } else {
            terminal.show(false);
            await new Promise(r => setTimeout(r, PRE_PASTE_SETTLE_MS));
        }

        await vscode.commands.executeCommand('workbench.action.terminal.paste');
        await new Promise(r => setTimeout(r, POST_PASTE_SETTLE_MS()));
        try { await vscode.env.clipboard.writeText(previousClipboard); } catch { /* ignore */ }
    });
}

/**
 * Normalize a filesystem path for consistent cross-platform hashing.
 * On Windows, lowercases the path for case-insensitive comparison.
 */
export function normalizePathForOS(p: string): string {
    const normalized = path.normalize(p);
    const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const root = path.parse(stable).root;
    return stable.length > root.length ? stable.replace(/[\\\/]+$/, '') : stable;
}

/**
 * Compute the SHA256 hash used for antigravity plan IDs.
 * Accepts a raw path — normalizes it before hashing.
 */
export function getAntigravityHash(rawPath: string): string {
    const stablePath = normalizePathForOS(rawPath);
    return crypto.createHash('sha256').update(stablePath).digest('hex');
}

/**
 * Sends text to a terminal with chunking and pacing to prevent input corruption.
 * Used by TaskViewerProvider for direct terminal push.
 */
export async function sendRobustText(
    terminal: vscode.Terminal,
    text: string,
    paced: boolean = true,
    log?: (msg: string) => void,
    options?: { acquireFocus?: boolean; background?: boolean }
): Promise<void> {
    // Background mode: deliver via terminal.sendText wrapped in Bracketed Paste
    // Mode without ever calling terminal.show() or workbench.action.terminal.paste,
    // so keyboard focus is never stolen from the user. Queued per-terminal to
    // prevent chunk interleaving between concurrent background sends.
    if (options?.background) {
        return _sendRobustTextBackground(terminal, text, log);
    }

    const CHUNK_SIZE = 500;
    const CHUNK_DELAY = 50; // ms between chunks
    const NEWLINE_DELAY = paced ? (isRemoteTerminal() ? 600 : 300) : 100; // was 1000 / 100 — adaptive delay before submission
    const CLI_CONFIRM_ENTER_DELAY = paced ? (isRemoteTerminal() ? 300 : 150) : 100; // was 350 / 150
    const isCliAgent = /\b(copilot|gemini|agy|claude|windsurf|cursor|cortex)\b/i.test(terminal.name);
    const _log = (msg: string) => { log?.(msg); console.log(`[sendRobustText] ${msg}`); };

    // For most payloads, use clipboard paste to bypass PTY line-buffer limits
    // that silently truncate input. Threshold lowered to 100 chars to ensure
    // reliability for all message types while avoiding clipboard overhead for
    // trivial single-word commands.
    const CLIPBOARD_PASTE_THRESHOLD = 100;
    if (text.length > CLIPBOARD_PASTE_THRESHOLD) {
        _log(`Large payload (${text.length} chars) for '${terminal.name}', using clipboard paste delivery.`);
        try {
            await pasteTextViaClipboard(terminal, text, options);

            // Submit the pasted content
            await new Promise(r => setTimeout(r, NEWLINE_DELAY));
            terminal.sendText('', true);
            _log(`Clipboard paste complete for '${terminal.name}', Enter sent.`);
            return;
        } catch (clipErr) {
            _log(`Clipboard paste failed for '${terminal.name}', falling back to chunked send: ${clipErr}`);
        }
    }

    // Flatten newlines for CLI agents to prevent premature submission
    const payload = isCliAgent ? text.replace(/[\r\n]+/g, ' ') : text;
    if (isCliAgent) {
        _log(`CLI terminal '${terminal.name}' detected. Flattening newlines for ${text.length} chars.`);
    }

    if (payload.length <= CHUNK_SIZE) {
        terminal.sendText(payload, false);
        _log(`Sent ${payload.length} chars in single call.`);
    } else {
        const chunkCount = Math.ceil(payload.length / CHUNK_SIZE);
        _log(`Large payload (${payload.length} chars), sending in ${chunkCount} chunks...`);
        for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
            const chunk = payload.substring(i, i + CHUNK_SIZE);
            terminal.sendText(chunk, false);
            if (i + CHUNK_SIZE < payload.length) {
                await new Promise(r => setTimeout(r, CHUNK_DELAY));
            }
        }
        _log(`All ${chunkCount} chunks sent.`);
    }

    // Give the terminal time to settle before submitting the buffered payload.
    await new Promise(r => setTimeout(r, NEWLINE_DELAY));
    terminal.sendText('', true);
    if (isCliAgent) {
        _log(`CLI terminal '${terminal.name}', sending single confirmation Enter.`);
        await new Promise(r => setTimeout(r, CLI_CONFIRM_ENTER_DELAY));
        terminal.sendText('', true);
    }
    _log(`sendRobustText complete for '${terminal.name}' (${text.length} chars).`);
}

/**
 * Background (non-focus-stealing) delivery path for `sendRobustText`.
 *
 * Wraps the payload in Bracketed Paste Mode ANSI escape sequences
 * (`\x1b[200~` ... `\x1b[201~`) and streams it via `terminal.sendText` in
 * 256-byte chunks with 30 ms pacing, then sends a single Enter to submit.
 *
 * `terminal.sendText` writes directly to the terminal's stdin without
 * revealing or focusing the terminal, so the user's keyboard focus is
 * preserved. The Bracketed Paste wrapper tells raw-mode TUIs (Claude CLI /
 * prompt-toolkit) to treat the block as an atomic paste, preserving
 * newlines and preventing premature submission.
 *
 * A per-terminal promise queue (`_backgroundSendQueues`) serializes
 * concurrent background sends so their chunks cannot interleave.
 */
async function _sendRobustTextBackground(
    terminal: vscode.Terminal,
    text: string,
    log?: (msg: string) => void
): Promise<void> {
    const _log = (msg: string) => { log?.(msg); console.log(`[sendRobustText background] ${msg}`); };
    const CHUNK_SIZE = 256;
    const CHUNK_DELAY_MS = 30;
    const SUBMIT_DELAY_MS = 100; // small settle before Enter

    const previous = _backgroundSendQueues.get(terminal) || Promise.resolve();
    const next = previous.then(async () => {
        _log(`Starting background send (${text.length} chars) to '${terminal.name}'`);

        // Begin Bracketed Paste Mode
        terminal.sendText('\x1b[200~', false);

        // Stream the payload in small chunks to avoid PTY/stdin saturation
        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            const chunk = text.substring(i, i + CHUNK_SIZE);
            terminal.sendText(chunk, false);
            if (i + CHUNK_SIZE < text.length) {
                await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
            }
        }

        // End Bracketed Paste Mode
        terminal.sendText('\x1b[201~', false);

        // Wait briefly for the terminal to process the paste block, then submit
        await new Promise(r => setTimeout(r, SUBMIT_DELAY_MS));
        terminal.sendText('', true);

        _log(`Background send complete for '${terminal.name}'`);
    }).then(() => {}, () => {}); // swallow errors so the queue always advances

    _backgroundSendQueues.set(terminal, next);
    return next;
}
