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
 * Shared by InboxWatcher (inbox-based delivery) and TaskViewerProvider (direct push).
 */
export async function sendRobustText(
    terminal: vscode.Terminal,
    text: string,
    paced: boolean = true,
    log?: (msg: string) => void
): Promise<void> {
    const CHUNK_SIZE = 500;
    const CHUNK_DELAY = 50; // ms between chunks
    const NEWLINE_DELAY = paced ? 1000 : 100; // adaptive delay before submission
    const CLI_CONFIRM_ENTER_DELAY = paced ? 350 : 150;
    const isCliAgent = /\b(copilot|gemini|claude|windsurf|cursor|cortex)\b/i.test(terminal.name);
    const _log = (msg: string) => { log?.(msg); console.log(`[sendRobustText] ${msg}`); };

    // For most payloads, use clipboard paste to bypass PTY line-buffer limits
    // that silently truncate input. Threshold lowered to 100 chars to ensure
    // reliability for all message types while avoiding clipboard overhead for
    // trivial single-word commands.
    const CLIPBOARD_PASTE_THRESHOLD = 100;
    if (text.length > CLIPBOARD_PASTE_THRESHOLD) {
        _log(`Large payload (${text.length} chars) for '${terminal.name}', using clipboard paste delivery.`);
        try {
            await withClipboardLock(async () => {
                let previousClipboard = '';
                try { previousClipboard = await vscode.env.clipboard.readText(); } catch { /* ignore */ }

                await vscode.env.clipboard.writeText(text);
                terminal.show(false);
                await new Promise(r => setTimeout(r, 200));
                await vscode.commands.executeCommand('workbench.action.terminal.paste');

                // Wait for paste to settle, then restore clipboard
                await new Promise(r => setTimeout(r, 800));
                try { await vscode.env.clipboard.writeText(previousClipboard); } catch { /* ignore */ }
            });

            // Submit the pasted content (clipboard paste doesn't need CLI confirmation Enter)
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
