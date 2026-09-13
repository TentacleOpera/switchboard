# Composer: Send a Prompt to Any Terminal Without Rerender

## Goal

Add a "Composer" feature that lets the user type a prompt into a local input box, select a target terminal from a dropdown, and deliver the text to that terminal — without switching the active terminal pane (which forces a slow rerender when multiple terminals are open).

This mirrors the "compose locally, send remotely" pattern used by mobile SSH/Mosh clients like Term Rover, adapted to Switchboard's existing terminal infrastructure. The key UX win: the user can reach any terminal in the fleet from a single composer dialog, avoiding the render cost of switching panes.

### Problem Analysis

**Root cause of the pain:** When a user wants to send a command to a terminal that isn't currently focused, they must click that terminal's sidebar entry, which triggers a pane switch and xterm.js rerender. With multiple terminals open, this rerender is noticeably slow on mobile and remote connections. The user then types into the terminal directly, suffering input lag (keystroke → echo round-trip over the remote link).

**Why a composer fixes this:**
- Terminal selection via dropdown avoids the pane switch entirely — no rerender.
- Local text composition eliminates the keystroke-by-keystroke round-trip latency.
- Delivery via `sendToTerminal` (the existing host-routed path) handles PTY framing, chunking, and bracketed paste — the same infrastructure that already powers dispatch and "clear all terminals."

**Existing prior art in the codebase:**
- `openTerminalPasteDialog` (terminals.js:2542) — a per-pane paste overlay that delivers via `term.paste(text)`. This is local-only (xterm.js instance) and bound to the currently-viewed pane. The composer generalizes this: terminal selector instead of pane binding, `sendToTerminal` instead of `term.paste`.
- `sendToTerminal` message — handled in `TaskViewerProvider.ts` (extension host, line 16366) and `bootstrap.ts` (standalone, line 3489). Already supports multi-line input via `ptySendPrompt` (bracketed-paste framing, 256-byte chunking, per-terminal lock) and appends the submitting newline. This is the delivery path the composer will use.
- `#link-modal` (terminals.html:3240) — a sidebar-level modal using static HTML with `hidden` toggle, `position: fixed; inset: 0; z-index: 200`. This is the correct modal pattern for the composer (sidebar-level), NOT the paste dialog's dynamic-overlay pattern (pane-level).

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, feature
**Project:** Browser Switchboard

## User Review Required

- **[user]** The `sendToTerminal` verb hardcodes `kind: 'dispatch'` in the extension handler (TaskViewerProvider.ts:16429), which classifies all prompts as dispatches. The composer passes `standingOrders: false` to suppress standing-orders appending, but the `kind: 'dispatch'` attribution itself cannot be overridden by the caller. If dispatch attribution matters for logging/analytics, a follow-up would need to either use `ptySendPrompt` directly or add a `kind` override to `sendToTerminal`. Proceeding on the assumption that `standingOrders: false` is sufficient for the composer's use case.

## Complexity Audit

### Routine
- Adding a static HTML modal element (mirrors `#link-modal` pattern)
- Adding a sidebar button in `.sidebar-ops` (mirrors `#btn-link-up` placement)
- Wiring button click to open/close the modal
- Populating a `<select>` from the fleet list (mirrors `openLinkModal` at terminals.js:11711)
- Posting a fetch to `/terminals/verb/sendToTerminal` (same pattern as all 20 existing verb calls in terminals.js)
- CSS for the modal (mirrors `.link-modal` styles at terminals.html:2047)
- Adding hide rules for team-scoped/controller-scoped modes (mirrors `#btn-link-up` rules at terminals.html:2375,2391)

### Complex / Risky
- `sendToTerminal` hardcodes `kind: 'dispatch'` — composer must pass `standingOrders: false` to avoid appending standing orders to user-typed prompts (TaskViewerProvider.ts:16429-16430, bootstrap.ts:3534)
- `sendToTerminal` re-lists the fleet internally (TaskViewerProvider.ts:16404) — redundant round-trip since the composer already has the fleet from its dropdown; acceptable for user-initiated action
- Command view panel (command.js) has no existing `sendToTerminal` caller — the composer would be the first; the route exists and works but this is a new caller pattern for that file

## Edge-Case & Dependency Audit

**Race Conditions:**
- Terminal exits while dialog is open: `sendToTerminal` handler checks terminal status and returns an error (TaskViewerProvider.ts:16408 checks `target.status === 'active'`; bootstrap.ts:3509 checks `ptyHandle`). The dialog shows the error and stays open for retry. No race — the check is at delivery time, not at dialog-open time.
- Fleet list goes stale while dialog is open: the dropdown was populated at open time. If a terminal exits after the dropdown was populated but before SEND, the `sendToTerminal` handler's internal fleet re-list catches it and returns an error. The user sees the error and can retry (possibly re-opening the dialog for a fresh fleet).

**Security:**
- No secrets persistence: the composer starts fresh each time, no history stored (same as the paste dialog).
- No `navigator.clipboard` access: the composer uses a textarea for input, never reads the clipboard (same contract as the paste dialog — see `terminal-pane-paste-contract.test.js`).
- `sendToTerminal` is auth-gated on the `/terminals/verb/` route (LocalApiServer.ts:7157).

**Side Effects:**
- `sendToTerminal` with `kind: 'dispatch'` may trigger dispatch attribution/logging. Mitigated by `standingOrders: false` but the `kind` classification itself is hardcoded.
- `sendToTerminal` for a single-line `/`-prefixed input routes via `ptyWrite` (control string), which resets the input line first (TaskViewerProvider.ts:16411, bootstrap.ts:3517-3532). This is the same behavior as the existing "CLEAR ALL TERMINALS" button.

**Dependencies & Conflicts:**
- The composer coexists with the existing paste dialog (`openTerminalPasteDialog`). Different use cases: paste dialog is pane-local (`term.paste`), composer is fleet-wide (`sendToTerminal`).
- The composer coexists with `#link-modal`. Different purposes: link-up instructs one agent to message another; composer sends a prompt directly.
- The `sendToTerminal` verb is served on `/terminals/verb/` in both extension and standalone (LocalApiServer.ts:7157-7172, bootstrap.ts:2104). No route conflict.

## Dependencies

None — all infrastructure (`sendToTerminal` verb, `/terminals/verb/` route, fleet list fetch, modal patterns) already exists in the codebase.

## Adversarial Synthesis

Key risks: (1) `sendToTerminal` hardcodes `kind: 'dispatch'` which applies standing orders — must pass `standingOrders: false` to avoid corrupting user-typed prompts; (2) the plan originally specified `postMessage` for the extension context, but terminals.js uses `fetch` for all verb calls — corrected to fetch in both contexts; (3) the modal should follow the `#link-modal` static-HTML pattern, not the paste dialog's dynamic-overlay pattern. Mitigations: `standingOrders: false` in payload, single fetch call for both contexts, static HTML modal with `hidden` toggle.

## Design Decisions

### 1. Two entry points, one shared concept

The composer is surfaced in two places:
- **Terminals panel sidebar** — a new `btn-composer` button in `.sidebar-ops`, placed directly under `btn-link-up`. Opens the composer dialog as a modal.
- **Command view panel** — a composer button in the command view UI. Opens the same style of dialog.

Both entry points share the same dialog structure and the same delivery path (`sendToTerminal` via `fetch('/terminals/verb/sendToTerminal', ...)`). They are implemented in their respective webview contexts (terminals.js vs command.js) but follow the same pattern.

### 2. Terminal selector dropdown

The dialog includes a `<select>` dropdown populated from the fleet list (`ptyListTerminals`). Each option shows the terminal's `friendlyName`. Only terminals with `status === 'active'` are selectable; exited/disposed terminals are either omitted or shown as disabled options.

The dropdown is fetched when the dialog opens (not cached from boot), so the list is current. This mirrors how `openLinkModal` (terminals.js:11712) filters `fleetList` for active terminals, and how `fetchTeamsState` in command.js (line 595) fetches the fleet.

### 3. Delivery via `sendToTerminal`

The composer delivers text by posting to the `/terminals/verb/sendToTerminal` HTTP route — the same route all terminal verbs use in both the extension webview and standalone browser contexts.

> **Superseded:** "In the extension webview context: `postMessage({ type: 'sendToTerminal', name, input, paced })` to the host. In the standalone browser context: `fetch('/terminals/verb/sendToTerminal', ...)`."
> **Reason:** terminals.js NEVER uses `postMessage`. All 20 verb calls in terminals.js use `fetch('/terminals/verb/...')`. There is no `acquireVsCodeApi`, no `vscode.postMessage`. Both the extension webview and standalone browser use the same fetch route — LocalApiServer.ts serves `/terminals/verb/sendToTerminal` in both contexts (line 7157-7172). The "context-detecting shared helper" (Part C) was solving a problem that doesn't exist.
> **Replaced with:** `fetch('/terminals/verb/sendToTerminal', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, input, paced: true, standingOrders: false }) })` in both contexts. No context detection needed.

> **Superseded:** Delivery payload `{ name, input, paced }` without `standingOrders`.
> **Reason:** `sendToTerminal` hardcodes `kind: 'dispatch'` in the extension handler (TaskViewerProvider.ts:16429), which applies standing orders to every prompt. The standalone handler (bootstrap.ts:3534) also applies standing orders by default (`payload.standingOrders !== false`). The composer is a user-typed prompt, not a system dispatch — appending standing orders would silently corrupt the user's intent.
> **Replaced with:** `{ name, input, paced: true, standingOrders: false }` — suppresses standing orders on both hosts (extension line 16430 checks `data.standingOrders === false`; standalone line 3534 checks `payload.standingOrders !== false`).

- **Text + Enter**: `sendToTerminal` already appends the submitting newline (via `ptySendPrompt` for prompts, or `ptyWrite` with `\r` for control strings). The composer does not need to append `\n` itself.
- **Multi-line as block**: `ptySendPrompt` handles multi-line input natively via bracketed-paste framing and 256-byte chunking. The composer sends the entire textarea content as a single `input` string.
- **Control string detection**: The host already detects single-line inputs starting with `/` as control strings and routes them via `ptyWrite` instead of `ptySendPrompt` (TaskViewerProvider.ts:16400, bootstrap.ts:3517). The composer does not need to classify — the host does it.
- **`paced` field**: Extension-only; harmlessly ignored by the standalone handler. Included for parity with the existing `sendToTerminal` contract.
- **`standingOrders: false`**: Suppresses standing-orders appending. Required because `sendToTerminal` hardcodes `kind: 'dispatch'`.

### 4. No history

The composer starts fresh each time it opens. No session or persistent history. This avoids secrets-persistence concerns and keeps the implementation simple.

### 5. Coexistence with the existing paste dialog

The existing per-pane paste dialog (`openTerminalPasteDialog`) and the composer serve different use cases and should coexist:
- **Paste dialog**: local delivery (`term.paste`), bound to the viewed pane, no terminal selector. Useful for quick paste into the terminal you're already looking at.
- **Composer**: host-routed delivery (`sendToTerminal`), terminal selector dropdown, can target any terminal without switching panes. Useful for sending to a terminal you don't want to switch to.

### 6. Modal pattern: static HTML, not dynamic overlay

> **Superseded:** "Builds an overlay dialog (following the same overlay pattern as `openTerminalPasteDialog`)"
> **Reason:** The paste dialog creates a dynamic `div` appended to the pane's `.pane-content` — it's pane-level. The composer is sidebar-level (opened from a sidebar button). The correct pattern is `#link-modal`: static HTML in terminals.html, `position: fixed; inset: 0; z-index: 200`, toggled with `hidden`. The plan already references `btn-link-up` (which opens `#link-modal`) as the placement neighbor — the dialog should follow the same modal pattern.
> **Replaced with:** A static `#composer-modal` element in terminals.html, mirroring `#link-modal`'s structure (`.modal-content`, `.modal-header`, `.modal-body`, `.modal-footer`), toggled with `hidden` attribute. CSS mirrors `.link-modal` styles.

## Proposed Changes

### terminals.html

**Context:** Add the composer button to `.sidebar-ops` and the composer modal to the page body. Add CSS and hide rules.

**Logic:**
1. Add `#btn-composer` button in `.sidebar-ops`, directly after `#btn-link-up` (line 3074):
   ```html
   <button type="button" id="btn-composer" class="secondary-btn w-full"
           title="Compose a prompt and send it to any terminal without switching panes">COMPOSER</button>
   ```
2. Add `#btn-composer` to the team-scoped hide rule (line 2375) and controller-scoped hide rule (line 2391), alongside `#btn-link-up`.
3. Add a static `#composer-modal` element (mirroring `#link-modal` at line 3240), with:
   - `.modal-header`: "Composer" title + close button
   - `.modal-body`: terminal selector `<select id="composer-terminal-select">`, textarea `<textarea id="composer-input">`, status text `#composer-status`
   - `.modal-footer`: CANCEL and SEND buttons
4. Add CSS for `.composer-modal`, mirroring `.link-modal` styles (line 2047): `position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 200;` with `[hidden] { display: none; }`.

**Edge Cases:**
- The `[hidden] { display: none; }` rule is mandatory (same as `.link-modal[hidden]` at line 2059) — without it, `display: flex` overrides the UA `hidden` default.

### terminals.js

**Context:** Wire the composer button, implement the dialog open/close logic, populate the terminal selector, and deliver via `sendToTerminal`.

**Logic:**
1. Wire the button (near `btnLinkUp` wiring at line 1185):
   ```js
   const btnComposer = document.getElementById('btn-composer');
   if (btnComposer) { btnComposer.addEventListener('click', openComposerModal); }
   ```
2. Add `openComposerModal()` function (near `openLinkModal` at line 11711):
   - Fetch the fleet list via `fetch('/terminals/verb/ptyListTerminals', ...)` (same as `fetchTerminalList` at line 2384) or reuse `fleetList` if recently polled.
   - Filter for `status === 'active'` terminals (same as `openLinkModal` at line 11712).
   - Populate `#composer-terminal-select` with active terminals. Each option's value is the terminal's `friendlyName`. If no active terminals, show a disabled placeholder option ("No active terminals") and disable SEND.
   - Clear the textarea and status text.
   - Show the modal: `document.getElementById('composer-modal').hidden = false`.
3. Add `closeComposerModal()` function:
   - `document.getElementById('composer-modal').hidden = true`.
4. Add `deliverComposerPrompt()` function:
   - Read the selected terminal name and textarea value.
   - If empty textarea, show error in `#composer-status`, return.
   - POST to `/terminals/verb/sendToTerminal`:
     ```js
     const res = await fetch('/terminals/verb/sendToTerminal', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
             name: selectedTerminal,
             input: textareaValue,
             paced: true,
             standingOrders: false
         })
     });
     const data = await res.json().catch(() => null);
     ```
   - On success: close the modal, show `showPaneToast('Sent to ' + selectedTerminal)`.
   - On failure: show error in `#composer-status`, keep the modal open for retry.
5. Wire SEND, CANCEL, close button, and Escape key (same pattern as `wireLinkModal` at line 11915).
6. Add `updateComposerSendButton()` — disable SEND when textarea is empty (same as `updateSendButton` in the paste dialog at line 2628).

**Edge Cases:**
- No active terminals: disabled placeholder option, SEND disabled, status: "No active terminals available."
- Terminal exits while dialog is open: `sendToTerminal` handler returns an error (TaskViewerProvider.ts:16408 checks `target.status === 'active'`). Show error, keep modal open.
- Empty textarea: SEND disabled (same as paste dialog's `updateSendButton`).
- Dialog already open: `#composer-modal` uses `hidden` toggle — clicking COMPOSER while open is a no-op (or refocuses the select).

### command.html

**Context:** Add a composer button in the command view panel.

**Logic:**
1. Add a composer button in the dispatch view's `.list-header-row` (line 887) or a dedicated toolbar area. The exact placement should match the panel's existing button styling (`.secondary-action-btn` or `.star-filter-btn`).

**Edge Cases:**
- The command view panel has no existing `sendToTerminal` caller. The composer would be the first. The route exists and works — no new server-side code needed.

### command.js

**Context:** Implement the composer dialog for the command view panel, following the same pattern as terminals.js.

**Logic:**
1. Add an `openComposerDialog()` function that follows the same pattern as terminals.js:
   - Fetch the fleet list via `fetch('/terminals/verb/ptyListTerminals', ...)` (same as `fetchTeamsState` at line 598) or reuse `liveFleet` (line 605).
   - Filter for `status === 'active'` terminals.
   - Populate a terminal selector dropdown.
   - Deliver via `fetch('/terminals/verb/sendToTerminal', ...)` with the same payload: `{ name, input, paced: true, standingOrders: false }`.
2. Wire the composer button.
3. The dialog can be a static HTML element in command.html (mirroring the terminals.html pattern) or a dynamically created overlay. The static-HTML pattern is preferred for consistency.

**Edge Cases:**
- command.js stores the fleet in `liveFleet` (line 605), not `fleetList`. The composer should read from `liveFleet` or do a fresh fetch on open.

## Verification Plan

### Automated Tests

1. **Contract test** (`composer-contract.test.js`, following `terminal-pane-paste-contract.test.js` pattern):
   - Assert `#btn-composer` exists in `.sidebar-ops` in terminals.html.
   - Assert `#composer-modal` exists in terminals.html with a terminal selector `<select>` and a textarea.
   - Assert `openComposerModal` function exists in terminals.js.
   - Assert the delivery code posts to `/terminals/verb/sendToTerminal` (not `term.paste`, not `ws.send`, not `postMessage`).
   - Assert the payload includes `standingOrders: false`.
   - Assert no `navigator.clipboard` access in the composer code path.
   - Assert no `confirm()` or `window.confirm` calls in the composer code path.

### Goal Invariants

- Assert `#btn-composer` exists inside `.sidebar-ops` in `src/webview/terminals.html`.
- Assert `#composer-modal` exists in `src/webview/terminals.html` with `position: fixed` in its CSS.
- Assert `openComposerModal` is a function in `src/webview/terminals.js`.
- Assert `sendToTerminal` appears in a `fetch('/terminals/verb/sendToTerminal'` call in `src/webview/terminals.js`.
- Assert `standingOrders: false` appears in the composer delivery code in `src/webview/terminals.js`.
- Assert `postMessage` does NOT appear in the composer delivery code in `src/webview/terminals.js`.
- Assert `#btn-composer` appears in the `is-team-scoped` and `is-controller-scoped` hide rules in `src/webview/terminals.html`.

### Manual Verification

1. **Sidebar entry point**: Open the terminals panel. Verify the COMPOSER button appears under LINK UP. Click it — verify the modal opens with a terminal dropdown populated from active terminals and a textarea.
2. **Command view entry point**: Open the command view panel. Verify the composer button is visible. Click it — verify the same dialog pattern.
3. **Delivery**: Type a command (e.g., `echo hello`), select a terminal, click SEND. Verify the text appears in the target terminal and the dialog closes with a success toast.
4. **Multi-line**: Type a multi-line block, select a terminal, click SEND. Verify the entire block is delivered (bracketed paste, not line-by-line).
5. **No rerender**: While the composer dialog is open, verify the terminal pane grid does not rerender (no pane switch occurs).
6. **No active terminals**: Close all terminals. Open the composer. Verify the dropdown shows "No active terminals" and SEND is disabled.
7. **Terminal exits mid-compose**: Start composing, then exit the target terminal from another action. Click SEND. Verify the error is shown in the dialog and the dialog stays open.
8. **Control string**: Type `/clear` in the composer, select a terminal, click SEND. Verify the terminal clears (delivered via `ptyWrite`, not bracketed paste).
9. **Standing orders suppressed**: With standing orders defined for a team, type a prompt in the composer and send to a team member terminal. Verify the standing orders block is NOT appended to the prompt.
10. **Team-scoped mode**: Switch to team-scoped mode. Verify the COMPOSER button is hidden (same as LINK UP).
11. **Controller-scoped mode**: Switch to controller-scoped mode. Verify the COMPOSER button is hidden.

## Implementation Summary

Implemented the Composer feature in both composition roots. The terminals panel (`terminals.html`/`terminals.js`) gained a `#btn-composer` sidebar button (placed under LINK UP, hidden in team-scoped and controller-scoped modes) and a static `#composer-modal` mirroring the `#link-modal` pattern (position: fixed, z-index: 200, `hidden` toggle). The command view panel (`command.html`/`command.js`) gained a matching COMPOSER button in the dispatch view header and its own `#composer-modal`. Both modals populate a terminal-selector dropdown from the active fleet (cached list shown instantly, then refreshed via a background `ptyListTerminals` fetch), accept a textarea prompt, and deliver via `fetch('/terminals/verb/sendToTerminal', ...)` with `{ paced: true, standingOrders: false }` — the explicit `standingOrders: false` suppresses standing-orders appending since `sendToTerminal` hardcodes `kind: 'dispatch'`. No `postMessage`, `term.paste`, `ws.send`, `navigator.clipboard`, or `confirm()` gates are used. A 19-assertion contract test (`src/test/composer-contract.test.js`, wired as `test:contract:composer`) verifies the structural and delivery invariants across all four files; all 19 assertions pass.

