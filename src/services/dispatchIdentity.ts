/**
 * Host-agnostic dispatch-identity parser.
 *
 * The fleet delivery path (extension `_ptyHostVerb` and standalone
 * `deliverPrompt`) carries plan identity inside the prompt text but has no
 * `payload.dispatch` field to attribute it. This parser scrapes that identity
 * straight off the prompt body so registration becomes a property of the
 * delivery layer instead of a chore the caller must remember.
 *
 * It is a verbatim port of the webview's `extractPastedDispatchIdentity`
 * (`src/webview/terminals.js`) — same ANSI/bracketed-paste stripping, same
 * `PLANS TO PROCESS:` requirement, same `PLANS TO DISCUSS:` rejection, same
 * `PASTE_SCAN_MIN_CHARS` floor — with one correction: the plan-id regex
 * accepts UUIDs (`[0-9a-fA-F-]{8,}`) instead of the shipped `\d+` which
 * captured a single digit out of a UUID. The client mirror is corrected in
 * the same pass and pinned by a byte-equality contract test so the two
 * parsers cannot drift.
 *
 * Pure by design: no `vscode`, no DB. Both hosts import it, and the standalone
 * bundle does not drag in the extension.
 */

export interface DispatchIdentity {
    planIds: string[];
    planFiles: string[];
}

export const PASTE_SCAN_MIN_CHARS = 200;

/**
 * Parse plan identity out of a dispatch prompt body. Returns `null` — never
 * an empty object — when neither ids nor files are found, so the caller's
 * guard is a single truthiness check.
 */
export function extractDispatchIdentity(text: string): DispatchIdentity | null {
    if (text.length < PASTE_SCAN_MIN_CHARS) { return null; }
    // Strip bracketed-paste wrappers so the pasted body can be scanned cleanly.
    const stripped = text
        .replace(/\x1b\[200~|\x1b\[201~/g, '')
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    if (!stripped.includes('PLANS TO PROCESS:')) { return null; }
    if (stripped.includes('PLANS TO DISCUSS:')) { return null; } // consultation prompt, not dispatch

    const planIds: string[] = [];
    let m: RegExpExecArray | null;
    const idRe = /\bPLAN_ID=([0-9a-fA-F-]{8,})/g;   // UUIDs, not \d+
    while ((m = idRe.exec(stripped)) !== null) { planIds.push(m[1]); }

    const planFiles: string[] = [];
    const fileRe = /Plan File:\s+(\S+)/g;
    while ((m = fileRe.exec(stripped)) !== null) { planFiles.push(m[1]); }

    if (planIds.length === 0 && planFiles.length === 0) { return null; }
    return { planIds, planFiles };
}
