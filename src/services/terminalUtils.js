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
    const NEWLINE_DELAY = paced ? 1000 : 100; // ms before newline
    const COPILOT_SECOND_ENTER_DELAY = paced ? 350 : 150;
    const needsSecondEnter = /\bcopilot\b/i.test(terminal.name);
    if (text.length <= CHUNK_SIZE) {
        terminal.sendText(text, false);
    }
    else {
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
//# sourceMappingURL=terminalUtils.js.map