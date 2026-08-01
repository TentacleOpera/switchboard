import * as vscode from 'vscode';

/**
 * Disposes a restored webview panel without firing any handlers on it,
 * then invokes the provider's creation callback targeting the restored panel's view column.
 * This guarantees every revived panel has retainContextWhenHidden set at creation time.
 *
 * The serialized `state` argument is the webview's last `vscode.setState()` payload.
 * Adoption used to hand it back to the rebooted webview automatically; re-creation does
 * not, so it is forwarded to the create path, which injects it into the initial HTML
 * (see `injectInitialWebviewState`). Without that, revival would silently reset every
 * `setState`-persisted preference on each window reload.
 */
export async function reviveWithRetention(
    restoredPanel: vscode.WebviewPanel,
    openFn: (column?: vscode.ViewColumn, restoredState?: any) => Promise<void>,
    state?: any
): Promise<void> {
    const targetColumn = restoredPanel.viewColumn ?? vscode.ViewColumn.One;
    // Dispose the restored panel cleanly without attaching listeners to it.
    restoredPanel.dispose();
    // Delegate to the provider's creation path with the target column + persisted state.
    await openFn(targetColumn, state);
}

/** Name of the meta tag carrying a revived panel's forwarded `setState` payload. */
export const INITIAL_STATE_META_NAME = 'sb-initial-state';

/**
 * Inline-inject a revived panel's persisted `vscode.setState()` payload into its initial
 * HTML, as `<meta name="sb-initial-state" content="<json>">`.
 *
 * Injection (rather than a post-`ready` postMessage) is deliberate: the value is present
 * in the document before any script runs, so there is no render-with-defaults frame and
 * no ready-race.
 *
 * A `<meta>` carrier — not an inline `<script>` — because the KANBAN panel's CSP is
 * `script-src 'nonce-…' <cspSource>` with NO `'unsafe-inline'`, and its nonce is stamped
 * inside `_getHtml` (before this runs). An injected script tag would be silently blocked
 * there. Meta content is inert markup and is not subject to `script-src` at all.
 *
 * It deliberately does NOT call `acquireVsCodeApi()` — that may be called only once per
 * webview and returns a frozen object, so a second acquisition would break the panel's
 * own call. Each panel seeds its own handle right after its single `acquireVsCodeApi()`.
 */
export function injectInitialWebviewState(html: string, state: any): string {
    if (!state || typeof state !== 'object') return html;
    let serialized: string;
    try {
        serialized = JSON.stringify(state);
    } catch {
        return html;
    }
    if (!serialized || serialized === '{}') return html;
    const escaped = serialized
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const tag = `<meta name="${INITIAL_STATE_META_NAME}" content="${escaped}">`;
    const headIndex = html.indexOf('<head>');
    if (headIndex !== -1) {
        const insertAt = headIndex + '<head>'.length;
        return html.slice(0, insertAt) + '\n' + tag + html.slice(insertAt);
    }
    // No <head> — fall back to prepending, which still precedes every panel script.
    return tag + html;
}
