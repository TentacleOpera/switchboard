import * as vscode from 'vscode';

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
    const NEWLINE_DELAY = paced ? 1000 : 100; // ms before newline
    const COPILOT_SECOND_ENTER_DELAY = paced ? 350 : 150;
    const needsSecondEnter = /\bcopilot\b/i.test(terminal.name);

    if (text.length <= CHUNK_SIZE) {
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

    // Final delay before newline to ensure terminal is ready to accept the command
    await new Promise(r => setTimeout(r, NEWLINE_DELAY));
    terminal.sendText('\n', false);
    if (needsSecondEnter) {
        log?.(`Copilot terminal detected for '${terminal.name}', sending confirmation Enter`);
        await new Promise(r => setTimeout(r, COPILOT_SECOND_ENTER_DELAY));
        terminal.sendText('\n', false);
    }
}
