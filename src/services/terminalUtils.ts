import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';

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

    if (text.length <= CHUNK_SIZE) {
        // Send without newline so the paced delay below always applies before submission.
        terminal.sendText(text, false);
    } else {
        log?.(`Large payload (${text.length} chars), sending in ${Math.ceil(text.length / CHUNK_SIZE)} chunks...`);
        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            const chunk = text.substring(i, i + CHUNK_SIZE);
            terminal.sendText(chunk, false);
            if (i + CHUNK_SIZE < text.length) {
                await new Promise(r => setTimeout(r, CHUNK_DELAY));
            }
        }
    }

    // Give the terminal time to settle before submitting the buffered payload.
    await new Promise(r => setTimeout(r, NEWLINE_DELAY));
    terminal.sendText('', true);
    if (isCliAgent) {
        log?.(`CLI terminal detected for '${terminal.name}', sending confirmation Enters`);
        await new Promise(r => setTimeout(r, CLI_CONFIRM_ENTER_DELAY));
        terminal.sendText('', true);
        await new Promise(r => setTimeout(r, CLI_CONFIRM_ENTER_DELAY));
        terminal.sendText('', true);
    }
}
