/**
 * Clipboard write with an insecure-context fallback.
 *
 * `navigator.clipboard.writeText()` is gated behind a secure context (HTTPS or
 * loopback). A board served over Tailscale's raw IP (`http://100.110.206.86:…`)
 * is NOT a secure context, so `navigator.clipboard` is undefined and every
 * "copy prompt" / "copy plan" button silently does nothing. This helper falls
 * back to a hidden `<textarea>` + `document.execCommand('copy')` — the
 * pre-Clipboard-API path that works in any context.
 *
 * Load this file AFTER sharedDefaults.js and BEFORE any panel script that
 * copies to the clipboard. It installs `window.sbCopyToClipboard(text)` as the
 * single entry point; existing `navigator.clipboard.writeText(text)` call sites
 * should be routed through it.
 */
(function () {
    if (typeof window === 'undefined') { return; }
    if (window.sbCopyToClipboard) { return; } // idempotent

    /**
     * Copy `text` to the clipboard. Returns a Promise that resolves true on
     * success, false on failure. Never throws — a clipboard failure is a
     * quality-of-life issue, not a reason to break a workflow.
     */
    window.sbCopyToClipboard = function (text) {
        // Preferred path: the async Clipboard API, available in secure contexts.
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text)
                .then(function () { return true; })
                .catch(function () { return fallbackCopy(text); });
        }
        return Promise.resolve(fallbackCopy(text));
    };

    function fallbackCopy(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            // Position off-screen so the textarea is never visible, but NOT
            // `display: none` — a non-rendered textarea cannot be selected on
            // some browsers. `position:fixed; left:-9999px` is the canonical
            // recipe.
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            ta.style.top = '0';
            ta.setAttribute('readonly', '');
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (e) {
            console.warn('[clipboardFallback] copy failed:', e);
            return false;
        }
    }
})();
