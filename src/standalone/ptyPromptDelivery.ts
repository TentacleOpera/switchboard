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
