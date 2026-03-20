"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePathForOS = normalizePathForOS;
exports.getAntigravityHash = getAntigravityHash;
exports.sendRobustText = sendRobustText;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
/**
 * Normalize a filesystem path for consistent cross-platform hashing.
 * On Windows, lowercases the path for case-insensitive comparison.
 */
function normalizePathForOS(p) {
    const normalized = path.normalize(p);
    const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const root = path.parse(stable).root;
    return stable.length > root.length ? stable.replace(/[\\\/]+$/, '') : stable;
}
/**
 * Compute the SHA256 hash used for antigravity plan IDs.
 * Accepts a raw path — normalizes it before hashing.
 */
function getAntigravityHash(rawPath) {
    const stablePath = normalizePathForOS(rawPath);
    return crypto.createHash('sha256').update(stablePath).digest('hex');
}
/**
 * Sends text to a terminal with chunking and pacing to prevent input corruption.
 * Shared by InboxWatcher (inbox-based delivery) and TaskViewerProvider (direct push).
 */
async function sendRobustText(terminal, text, paced = true, log) {
    const CHUNK_SIZE = 500;
    const CHUNK_DELAY = 50; // ms between chunks
    const NEWLINE_DELAY = paced ? 1000 : 100; // adaptive delay before submission
    const CLI_CONFIRM_ENTER_DELAY = paced ? 350 : 150;
    const isCliAgent = /\b(copilot|gemini|claude|windsurf|cursor|cortex)\b/i.test(terminal.name);
    const _log = (msg) => { log?.(msg); console.log(`[sendRobustText] ${msg}`); };
    // For most payloads, use clipboard paste to bypass PTY line-buffer limits
    // that silently truncate input. Threshold lowered to 100 chars to ensure
    // reliability for all message types while avoiding clipboard overhead for
    // trivial single-word commands.
    const CLIPBOARD_PASTE_THRESHOLD = 100;
    if (text.length > CLIPBOARD_PASTE_THRESHOLD) {
        _log(`Large payload (${text.length} chars) for '${terminal.name}', using clipboard paste delivery.`);
        try {
            let previousClipboard = '';
            try {
                previousClipboard = await vscode.env.clipboard.readText();
            }
            catch { /* ignore */ }
            await vscode.env.clipboard.writeText(text);
            terminal.show(false);
            await new Promise(r => setTimeout(r, 200));
            await vscode.commands.executeCommand('workbench.action.terminal.paste');
            // Wait for paste to settle, then restore clipboard
            await new Promise(r => setTimeout(r, 800));
            try {
                await vscode.env.clipboard.writeText(previousClipboard);
            }
            catch { /* ignore */ }
            // Submit the pasted content (clipboard paste doesn't need CLI confirmation Enter)
            await new Promise(r => setTimeout(r, NEWLINE_DELAY));
            terminal.sendText('', true);
            _log(`Clipboard paste complete for '${terminal.name}', Enter sent.`);
            return;
        }
        catch (clipErr) {
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
    }
    else {
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
//# sourceMappingURL=terminalUtils.js.map