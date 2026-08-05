import type { ExtendedTerminalHandle } from './ptyFleetService';

const CLI_AGENT_REGEX = /copilot|gemini|agy|claude|windsurf|cursor|cortex/i;
const CHUNK_SIZE = 256;
const CHUNK_DELAY_MS = 30;

const sendLocks = new Map<string, Promise<void>>();

function withTerminalLock<T>(terminalName: string, fn: () => Promise<T>): Promise<T> {
    const previous = sendLocks.get(terminalName) || Promise.resolve();
    const current = previous.then(fn, fn);
    sendLocks.set(terminalName, current.then(() => {}, () => {}));
    return current;
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
            handle.write('/clear\r');
            const delay = opts.clearBeforePromptDelayMs ?? 2000;
            await new Promise(r => setTimeout(r, Math.min(10000, Math.max(0, delay))));
        }

        // Bracketed-paste framing
        const framed = `\x1b[200~${text}\x1b[201~`;
        
        // Chunked write
        for (let i = 0; i < framed.length; i += CHUNK_SIZE) {
            const chunk = framed.slice(i, i + CHUNK_SIZE);
            handle.write(chunk);
            if (i + CHUNK_SIZE < framed.length) {
                await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
            }
        }

        await new Promise(r => setTimeout(r, 100));
        handle.write('\r');

        // Second confirm \r for interactive CLI agents
        if (CLI_AGENT_REGEX.test(handle.name) || CLI_AGENT_REGEX.test(handle.role)) {
            await new Promise(r => setTimeout(r, 200));
            handle.write('\r');
        }
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
            handle.write('/clear\r');
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
            handle.write('/model\r');
        } catch { /* PTY died between check and write — nothing to model */ }
    });
}

