# Add "New Window" Button to Pop Out the Full Terminals Panel

## Goal

In the standalone/browser Switchboard (`shell.html` + iframed panels), the Terminals panel (`terminals.html`, served at `/terminals`) is hosted inside an iframe alongside the left shell icon strip (the "shell sidebar"). To get the terminals panel into its own browser window today, the user must manually duplicate the entire Switchboard browser tab and then navigate — carrying the shell sidebar with it and wasting screen space on navigation chrome they do not want.

Add a **"New Window"** button to the terminals panel that opens the full terminals panel — PTY Fleet sidebar, layout toolbar, multi-pane grid and all — in a new browser window **without** the outer shell sidebar.

### Problem Analysis & Root Cause

The standalone browser Switchboard is structured as:
- `shell.html` — the outer chrome: a left icon strip (`#strip`) that loads panel iframes and renders per-terminal pop-out buttons. This is the "shell sidebar" the user wants to shed.
- `terminals.html` — served at the `/terminals` route, loaded inside a shell iframe. It is **fully self-contained**: it fetches its own fleet list (`fetchTerminalList()`), connects to the PTY WebSocket hub directly (`PTY_HOST_ORIGIN`), and manages its own pane grid. It does not depend on the shell parent for any data — `postFleetStateToShell()` is the only parent-directed call and it no-ops when `window.parent === window`.

**Root cause:** There is no UI affordance on the terminals panel itself to pop the whole panel out. The existing pop-out path in `shell.js` (`renderTerminalSection`) opens `/terminals?solo=<name>` — but `?solo` pins a **single** terminal and hides the PTY Fleet sidebar + layout toolbar (`body.is-solo` CSS). That is a different feature (one-terminal focus), not "give me the whole terminals panel in its own window." The user is forced to duplicate the browser tab manually because no button opens `/terminals` (the full panel, no `?solo`) in a new window.

**Key insight:** Opening `/terminals` directly (no `?solo`, no shell parent) already renders the complete terminals panel with no shell sidebar — the shell chrome only exists in `shell.html`. So the fix is a button that calls `window.open('/terminals', ...)` from inside the panel. Theme inheritance already works for pop-outs: `resolveInitialTheme()` checks `window.opener.document.body` for the theme class when `window.parent === window` (the standalone-window case). The solo pop-out path already proves this pattern works.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, feature
**Project:** Browser Switchboard

## User Review Required

- **Named-window reuse semantics:** the popout uses the named target `'sb-terminals-panel'`, so a second click on "NEW WINDOW" navigates/reloads the already-open popout window instead of spawning a second one (PTYs survive server-side; the xterm viewports rebuild). Confirm this single-popout behavior is desired, or switch to `_blank` for unlimited popouts.
- **Live theme fan-out is out of scope for v1:** the popped-out window inherits the theme at open time but does not follow later theme switches (the shell's `popoutWindows` tracking is unreachable from inside the panel iframe). Noted as a follow-up.

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** This is a small, additive UI change to a single panel:

- One new button element in `terminals.html` (in the existing `.toolbar-actions` row of the layout toolbar).
- One click handler in `terminals.js` calling `window.open('/terminals', ...)`.
- One CSS rule to hide the button when the panel is already standalone (not inside the shell iframe) so a popped-out window does not show a redundant "New Window" button.
- Solo mode already hides `.layout-toolbar` via `body.is-solo .layout-toolbar { display: none !important; }`, so the button is automatically suppressed in solo pop-outs — no extra solo guard needed.

**Not complex/risky because:**
- No new routes, no server changes, no WebSocket changes — `/terminals` is already served standalone.
- No state synchronization between the popped-out window and the shell: the popped-out panel is an independent terminals session (same fleet, same WS hub). This matches the existing solo pop-out model, which deliberately does **not** rearrange the cockpit's panes (acknowledge-only, per the `shell.js` comment at line 249).
- Theme inheritance is already handled by `resolveInitialTheme()` via `window.opener`.

**One mild risk:** A user could pop out the panel and then close the original shell tab. The popped-out `/terminals` window is fully self-contained (it does not need the shell parent), so this is safe — but the plan's verification step confirms it.

## Edge-Case & Dependency Audit

1. **Already-standalone panel (popped out, or loaded directly at `/terminals`):** The "New Window" button would be redundant. Hide it when `window.parent === window` (the panel is not inside the shell iframe). This is the same test `postFleetStateToShell()` uses to detect "I am standalone."

2. **Solo mode (`?solo=<name>`):** The layout toolbar is already hidden by `body.is-solo .layout-toolbar { display: none !important; }`, so the button never renders in a solo pop-out. No additional guard required — but the plan notes this so a future refactor of solo CSS does not accidentally re-expose it.

3. **Popup blocker:** `window.open()` called outside a user gesture is blocked; called inside a click handler it is allowed. The button's click handler is a direct user gesture, so this is safe. Add a `try/catch` and a null/closed check mirroring the existing solo pop-out code in `shell.js` (lines 225–246) — if the popup is blocked, fall back to navigating the current panel to `/terminals` is **not** desirable (that would replace the shell view); instead, show a brief inline toast/tooltip telling the user the popup was blocked. Keep it simple: log a warning and disable the button momentarily. The existing solo path falls back to focusing the in-cockpit terminal; here there is no in-cockpit fallback that sheds the shell sidebar, so a blocked-popup notice is the honest behavior.

4. **Theme fan-out to the new window:** `resolveInitialTheme()` reads `window.opener.document.body` when `window.parent === window`. Since the new window is opened from the panel iframe (not the shell), `window.opener` is the iframe's window — whose `document.body` carries the theme class. Verified: the solo pop-out relies on this exact path and the contract test `resolveInitialTheme inherits theme from window.opener` pins it. Live theme switches after pop-out are **not** fanned out to a full-panel pop-out (the solo path fans out via `popoutWindows` in `shell.js`, but that set only tracks solo pop-outs opened from the shell strip). This is an acceptable limitation for v1 — the popped-out window keeps its initial theme. Noted as a follow-up, not a blocker.

5. **`dist/webview/` vs `src/webview/`:** The standalone server resolves `/static/webview/...` against `dist/webview` THEN `src/webview` (per `sync-webview-vendor.js` comments). `dist/webview/terminals.html` and `dist/webview/terminals.js` are generated by webpack's CopyPlugin from `src/webview/`. Edits go to `src/webview/`; a rebuild syncs dist. If no build is run, the dev server falls back to `src/webview/`, so editing `src/` is sufficient for verification.

6. **CSP:** `terminals.html` has a strict CSP (`default-src 'none'; script-src 'nonce-{{NONCE}}' 'self'; ...`). The new button is plain HTML + a click handler inside the existing `terminals.js` (already nonce-tagged) — no inline script, no new connect-src needed. `window.open` is not restricted by CSP.

## Proposed Changes

### 1. `src/webview/terminals.html` — add the button to the layout toolbar

In the `.toolbar-actions` div (currently holding only the OS Notifications toggle), add a "New Window" button. Place it **before** the notify toggle so it reads left-to-right as the primary action.

```html
<div class="toolbar-actions">
    <button type="button" id="btn-new-window" class="secondary-btn is-teal"
            title="Open the terminals panel in a new browser window (no shell sidebar)">NEW WINDOW</button>
    <label class="notify-toggle-label">
        <input type="checkbox" id="notify-toggle"> OS Notifications
    </label>
</div>
```

Add a CSS rule to hide the button when the panel is already standalone (not inside the shell iframe). Use a body class set by JS (`is-standalone`) rather than a media query, since "standalone" is a runtime condition:

```css
/* Hide the New Window button when the panel is already in its own top-level
   window (popped out, or loaded directly at /terminals). Inside the shell
   iframe, window.parent !== window and the class is absent, so the button
   shows. Solo mode already hides .layout-toolbar entirely. */
body.is-standalone #btn-new-window {
    display: none !important;
}
```

### 2. `src/webview/terminals.js` — wire the button and set the standalone class

In `init()` (terminals.js:310), after the solo-mode block, detect standalone and mark the body so CSS can hide the button. Then attach the click handler.

```js
function init() {
    if (soloTerminalName) {
        document.body.classList.add('is-solo');
        document.title = soloTerminalName;
        currentLayout = '1';
        effectiveLayout = '1';
        paneAssignments = [soloTerminalName];
        initialAssignmentDone = true;
    }

    // Mark standalone (top-level window, not inside the shell iframe) so CSS
    // can hide the New Window button — popping out an already-popped-out panel
    // is redundant. Solo mode hides the whole toolbar, so this is additive.
    if (window.parent === window) {
        document.body.classList.add('is-standalone');
    }

    resolveInitialTheme();

    // ... existing btnNew listener ...

    const btnNewWindow = document.getElementById('btn-new-window');
    if (btnNewWindow) {
        btnNewWindow.addEventListener('click', () => {
            const url = '/terminals';
            const features = 'width=1200,height=800';
            let popout = null;
            try {
                popout = window.open(url, 'sb-terminals-panel', features);
            } catch { /* ignore */ }
            if (!popout || popout.closed) {
                // Popup blocked — no in-cockpit fallback sheds the shell sidebar,
                // so tell the user instead of silently doing nothing. Use the
                // pane toast (terminals.js showPaneToast, line 609) — a console
                // warning is invisible to users who never open devtools.
                showPaneToast('Popup blocked — allow popups for this site to pop out the terminals panel.');
                btnNewWindow.disabled = true;
                setTimeout(() => { btnNewWindow.disabled = false; }, 2000);
            }
        });
    }
    // ... rest of init ...
}
```

**Named-window reuse (second click):** The named target `'sb-terminals-panel'` means a second click on "NEW WINDOW" navigates the already-open popout back to `/terminals` (reloading it) rather than spawning a duplicate window. PTYs survive server-side and the xterm viewports rebuild from the fleet, so no session is lost — but visible scrollback resets. This single-popout behavior is deliberate (it mirrors how the solo pop-out names its windows); it is called out in User Review Required in case unlimited popouts (`_blank`) are preferred.

> **Superseded:** On popup-blocked, log `console.warn('[Terminals] New Window popup was blocked…')` and momentarily disable the button.
> **Reason:** A console warning is invisible to users who never open devtools — exactly the users who block popups. The file already has a user-visible transient toast (`showPaneToast`, terminals.js:609).
> **Replaced with:** `showPaneToast('Popup blocked — allow popups for this site to pop out the terminals panel.')` plus the momentary button disable (code above already reflects this).

**Why `window.parent === window` for the standalone check:** This is the exact test `postFleetStateToShell()` (terminals.js:453) uses to decide "I am not inside the shell." It is reliable because the shell always loads the panel in an iframe (same-origin), so `window.parent !== window` iff embedded.

**Why no `popoutWindows` tracking / theme fan-out here:** The solo pop-out path in `shell.js` tracks popouts in a `Set` so `applyThemeToAll` can fan out theme switches. That set lives in `shell.js` and is keyed to solo pop-outs opened from the shell strip. A full-panel pop-out opened from **inside the panel iframe** cannot reach the shell's `popoutWindows` set (the iframe does not own it). Wiring theme fan-out would require the panel to postMessage the shell to register the popout — a larger change. v1 ships without live theme fan-out to the popped-out window; the popped-out window inherits the theme at open time via `resolveInitialTheme()` and keeps it. This is documented as a known limitation.

### 3. No server / route changes

`/terminals` is already served standalone by `headlessPanelHtml.ts` (`getTerminalsHtml`). No new route, no new manifest entry. The popped-out window loads the same URL the shell iframe loads, just at the top level.

## Dependencies

- None — no dependency on other plans or sessions. Sibling subtasks in this feature touch the same files (`terminals.html` / `terminals.js`) but different regions (see feature Dependencies & sequencing).

## Adversarial Synthesis

Key risks: named-window target reloads the existing popout on a second click (documented, PTYs survive); popup blockers silently swallow `window.open` (mitigated with a `showPaneToast` notice, not a console warning); live theme fan-out to the popout is not wired (accepted v1 limitation, theme inherits at open time). No server, CSP, or route surface changes — the approach reuses the already-proven solo pop-out pattern.

## Verification Plan

> **Superseded:** Step 1 "Run `npm run compile`… confirm no webpack errors" and step 2 "Run `node src/test/terminal-solo-popout-contract.test.js`".
> **Reason:** Session directive for this improvement pass — SKIP COMPILATION and SKIP TESTS: no project compilation and no automated tests run as part of verification.
> **Replaced with:** Serve the standalone Switchboard as-is (the dev server resolves `/static/webview/terminals.html` from `src/webview/` when `dist/` is absent — per edge-case audit item 5) and verify manually per the steps below. The solo-popout contract test still exists for CI; this change does not touch solo-mode code paths.

1. **Serve from source:** Start the standalone Switchboard without a webpack build and confirm the Terminals panel loads with the change present (dev server falls back to `src/webview/`).

2. **Manual — button appears inside the shell:**
   - Open the standalone Switchboard in a browser (`shell.html`).
   - Navigate to the Terminals panel.
   - Confirm a "NEW WINDOW" button appears in the layout toolbar, left of the "OS Notifications" toggle, with the teal accent style.

3. **Manual — pop-out works:**
   - Click "NEW WINDOW".
   - Confirm a new browser window opens showing the full terminals panel: PTY Fleet sidebar on the left, layout toolbar with grid picker, multi-pane grid — and **no** shell icon strip.
   - Confirm the popped-out panel is functional: spawn a new terminal (`+ New`), switch layouts, and verify the terminal renders and accepts input. This proves the popped-out `/terminals` session is self-contained.

4. **Manual — named-window reuse:**
   - With the popout open, click "NEW WINDOW" in the shell again.
   - Confirm the existing popout window is reused (navigated/reloaded) rather than a second window spawning, and that its terminals reconnect to the fleet.

5. **Manual — theme inheritance:**
   - With the shell in `claudify` theme, click "NEW WINDOW". Confirm the popped-out window opens in `claudify` (terracotta accent), not the default cyber cyan. This exercises `resolveInitialTheme()` → `window.opener.document.body`.

6. **Manual — button hidden when standalone:**
   - In the popped-out window, confirm the "NEW WINDOW" button is **not** visible (the `is-standalone` body class hides it).
   - Load `/terminals` directly in a fresh tab. Confirm the button is hidden there too.

7. **Manual — solo mode unaffected:**
   - From the shell's terminal strip, click a terminal glyph to open a solo pop-out (`/terminals?solo=<name>`).
   - Confirm the solo pop-out still hides the entire layout toolbar (no "NEW WINDOW" button, no grid picker) — `body.is-solo .layout-toolbar { display: none !important; }` still holds.

8. **Manual — popup blocked:**
   - Temporarily block popups for the site, click "NEW WINDOW", confirm the button briefly disables and a pane toast appears telling the user to allow popups (no crash, no silent failure).

## Completion Summary

Implemented the "New Window" pop-out button. Added a `#btn-new-window` teal button to the `.toolbar-actions` row in `src/webview/terminals.html` (left of the OS Notifications toggle) plus a `body.is-standalone #btn-new-window { display: none !important; }` CSS rule. In `src/webview/terminals.js` `init()`, set `body.is-standalone` when `window.parent === window` and wired the click handler to `window.open('/terminals', 'sb-terminals-panel', 'width=1200,height=800')` with a `showPaneToast` + momentary disable fallback when the popup is blocked. No server or route changes — `/terminals` is already served standalone. Solo mode is unaffected (its existing `body.is-solo .layout-toolbar { display: none !important; }` hides the whole toolbar). No issues encountered.
