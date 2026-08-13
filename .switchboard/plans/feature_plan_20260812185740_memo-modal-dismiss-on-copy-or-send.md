# Dismiss the browser cockpit Memo modal after Copy Prompt / Send to Planner

## Goal

Make the Memo modal in the browser cockpit close itself once a Copy Prompt or Send to Planner click has actually succeeded, so the operator is returned to the panel they were on instead of having to hunt for the `×` or press Escape after every capture.

### Problem

In the headless app-shell (browser cockpit), Memo is not a panel you navigate to — it is an overlay. `src/services/headlessPanelHtml.ts:521` registers it as:

```ts
{ id: 'memo', label: 'Memo', icon: `${iconDir}/nav-memo.svg`, route: '/memo', enabled: true, presentation: 'modal' },
```

`shell.js` therefore mounts the `/memo` iframe inside `#modal-dialog` and shows it via `openModal()` (`src/webview/shell.js:62-75`). The only ways out today are the `×` button, a backdrop click, Escape, or navigating to another rail panel — all wired in `shell.js:36`, `52`, `753` and `selectPanel` (`shell.js:132`).

The two buttons that *finish* the memo workflow do not participate in any of that. `memo.js` posts the verb and then only paints in-frame feedback:

- `src/webview/memo.js:252-264` — Copy Prompt: `postMessage({ type: 'memoGeneratePrompt', action: 'copy', … })`, sets the status line to `Building prompt…`.
- `src/webview/memo.js:265-277` — Send to Planner: same, `action: 'send'`.
- `src/webview/memo.js:138-195` — the `memoPromptResult` arm writes the status line, clears the textarea when `msg.memoCleared` is true, and flashes `Copied ✓` / `Sent ✓` on the button (`_flashAction`, `memo.js:24-37`).

### Root cause

The memo frame has **no channel to its host at all**. `transport.js` gives every panel a cross-frame helper for *navigation* — `window.__switchboardSwitchPanel(panelId)` posts `{type:'switchPanel', panel}` to the parent (`src/webview/transport.js:429-438`) — and `shell.js`'s bridge handles exactly three inbound message types: `switchPanel`, `switchboardThemeChanged`, `terminalFleetState`, plus `popoutTerminal` (`shell.js:718-751`). There is no "dismiss the overlay hosting me" message, so a panel that has completed its job cannot say so. Nothing is broken in the verb path — the copy/send/clear all work; the missing piece is a one-way close request from the frame to the shell.

Two things constrain the fix and are the reason this is not a one-line change:

1. **`memo.js` is shared by two hosts.** The same file backs the shell's modal frame *and* the standalone full-page `/memo` route (`src/services/headlessPanelHtml.ts:364-388` serves one HTML for both; the route is registered at `src/services/LocalApiServer.ts:4116`). On the full-page route there is no parent to close anything, so the request must be a silent no-op there — the same shape `__switchboardSwitchPanel` already uses (`window.parent && window.parent !== window`).
2. **In the browser, one click delivers `memoPromptResult` twice.** Once via the WS fan-out (`BroadcastHub.mirrorToWs`) and once as the HTTP response body re-dispatched by `transport.js` (`transport.js:397-402`) — this is documented in `memo.js:147-152` and is the exact hazard the existing post-click-typing guard exists for. A dismissal request must be idempotent/coalesced, not fired per delivery.

### Scope decision

Dismissal fires **only on a real success** — `!msg.isError && msg.memoCleared`, the same condition that already gates `_flashAction` (`memo.js:193`). The three non-success replies keep the modal open, because each one leaves something on screen the operator must read:

| Reply | Source | Modal |
| :-- | :-- | :-- |
| `memoCleared: true`, no error | copy or send succeeded (`TaskViewerProvider.ts:13185-13199`) | **closes** |
| `memoCleared: false`, `isError: true` | send failed, memo preserved for retry | stays open |
| `memoCleared: false`, `success: true`, `No entries to process.` | empty memo | stays open |
| `memoError` | unresolvable workspace root | stays open |

Non-goal: the modal does **not** navigate anywhere on close. A successful Send to Planner does not auto-switch the rail to Terminals — dismissal reveals whatever panel the operator was already on, which is the behaviour every other close path (`×`, Escape, backdrop) already has.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Adding a `__switchboardCloseModal` helper beside the existing `__switchboardSwitchPanel` in `transport.js` — identical shape, identical iframe guard.
- Adding one `else if` arm to the `shell.js` cross-frame bridge.
- Calling the helper from `memo.js`'s existing success branch.

**Complex / risky**
- **Double delivery.** Two `memoPromptResult` arrivals per click. `closeModal()` is already guarded by `if (!openModalId) { return; }` (`shell.js:77`), so a second request lands as a no-op — but the pending-timer coalescing in `memo.js` is what keeps a *stale* timer from firing later.
- **Stale timer vs re-open.** With any dismissal delay, a timer armed for submission N must not close a modal the operator re-opened afterwards. Handled by clearing the pending timer on every fresh submit click and by only ever having one timer in flight.
- **Two hosts, one script.** The full-page `/memo` route must not throw and must not attempt anything. Guarded by the `window.parent !== window` check inside the transport helper, so `memo.js` stays host-agnostic.
- **Do not add a second writer on the way out.** `shell.js:82-85` carries an explicit comment that `closeModal` performs no flush, no save, no postMessage — memo.js owns its debounced save. This change must not violate that: the frame asks the shell to close; the shell still writes nothing.
- **CSP.** `/memo` is served with `default-src 'none'` (`headlessPanelHtml.ts:373`). `postMessage` to the parent is not a CSP-governed fetch, so no directive change is needed — and none should be added.

## Edge-Case & Dependency Audit

- **Full-page `/memo` route (not iframed).** `window.parent === window` → helper returns without posting. Modal behaviour is simply absent; nothing regresses.
- **VS Code sidebar Memo sub-tab.** `src/webview/implementation.html:1583-1610` has its **own** inline copy of the memo handlers (`implementation.html:2780-2790`) and is a tab, not a modal. It is untouched by this plan and must stay untouched.
- **Send failure fallback.** `TaskViewerProvider.ts:13172-13178` copies the prompt to the clipboard and preserves the memo on a failed dispatch; the reply is `isError: true, memoCleared: false`. Modal stays open so the operator sees `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.`
- **Standalone host degrade.** `src/standalone/bootstrap.ts:1604-1653` degrades a failed `send` into a copy and returns `memoCleared: false, action: 'copy'` with `success: true` and no `isError`. Under the `!isError && memoCleared` gate this correctly does **not** dismiss — the status line explains the degrade and the memo is preserved.
- **`terminalDispatch: false` hosts.** `transport.js:449-457` hides `#memo-send-btn` entirely on such hosts, so only the copy path exists there. No extra handling needed.
- **Post-click typing.** If the operator types after clicking, the existing guard (`memo.js:154-187`) may decline the clear; `memoCleared` is still `true` in the reply, so under the stated gate the modal would dismiss while typed text is retained in the frame. That text is safe — the frame is never destroyed on close (`shell-modal-panel-contract.test.js:65-75` pins this) and `memo.js`'s debounced save still runs. Re-opening shows the text. Accept this; do not widen the gate to `clearedNow`, which would break dismissal for the ordinary case where the `memoContent:''` push wins the race.
- **Escape / backdrop / `×` while a dismissal timer is pending.** The modal is already closed; the timer's request hits `if (!openModalId) return;` and no-ops.
- **Rail icon state.** `closeModal()` clears `is-active` and `aria-expanded` on the memo icon (`shell.js:79-80`) — driving dismissal through `closeModal()` rather than hand-toggling `is-open` keeps rail state, focus return, and ARIA correct for free.
- **Origin.** The bridge's newer arms check `event.origin !== location.origin` (`shell.js:729`, `732`). The memo frame is same-origin, so the new arm keeps that check and still passes.
- **No confirmation dialogs.** Per project rules, dismissal is unconditional on success — no "are you sure", no two-click pattern.

## Proposed Changes

### 1. `src/webview/transport.js` — add the close-request helper

Immediately after `window.__switchboardSwitchPanel` (currently ending at line 438), add its dismissal counterpart. Same iframe guard, same `'*'` target origin (the shell verifies `event.origin` on receipt).

```js
    // ─── Modal dismissal bridge (headless app-shell) ─────────────────────────
    // A panel presented as a modal (manifest presentation:'modal' — Memo today)
    // has no handle on the overlay hosting it. This posts a dismissal REQUEST to
    // the shell, which closes the overlay through its own closeModal() so rail
    // icon state, focus return and ARIA stay correct. No-op when not iframed —
    // the standalone full-page /memo route has no host to ask.
    window.__switchboardCloseModal = function (panelId) {
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'closeModalPanel', panel: String(panelId) }, '*');
            }
        } catch (err) {
            console.warn('[transport] closeModalPanel postMessage failed:', err);
        }
    };
```

### 2. `src/webview/shell.js` — handle `closeModalPanel` in the cross-frame bridge

Add one arm to the listener at `shell.js:718-751`, after the `switchPanel` arm:

```js
        } else if (data.type === 'closeModalPanel' && typeof data.panel === 'string') {
            if (event.origin !== location.origin) { return; }
            // Only the overlay that is actually open may be dismissed, and only
            // by itself. Routed through closeModal() so the rail icon, focus
            // return and aria-expanded all reset exactly as they do for the ×,
            // the backdrop and Escape — and so the "no flush, no save, no
            // postMessage on the way out" rule keeps holding: the frame ASKS,
            // the shell still writes nothing.
            if (modalPanels.has(data.panel) && openModalId === data.panel) { closeModal(); }
        } else if (data.type === 'switchboardThemeChanged') {
```

Also extend the file header comment (`shell.js:10-11`) so the bridge's contract stays documented:

```js
 * Cross-panel bridge: listens for postMessage {type:'switchPanel', panel}
 * from iframes and switches the active panel; {type:'closeModalPanel', panel}
 * dismisses a modal-presented panel at its own request.
```

### 3. `src/webview/memo.js` — request dismissal on a real success

Add the delay constant and the coalesced scheduler near `_flashAction` (after `memo.js:37`):

```js
    // Grace period before the overlay is dismissed: long enough for the
    // "Copied ✓" / "Sent ✓" flash to paint one frame so the dismissal reads as
    // a response to the click, short enough that it does not read as a timer.
    const DISMISS_DELAY_MS = 600;
    let _dismissTimer = null;

    function _cancelDismiss() {
        if (_dismissTimer) { clearTimeout(_dismissTimer); _dismissTimer = null; }
    }

    /** Ask the host shell to close the Memo overlay. Coalesced: in the BROWSER one
     *  click delivers memoPromptResult TWICE (WS fan-out + the HTTP body
     *  re-dispatched by transport.js — see the note in the memoPromptResult arm),
     *  and both deliveries reach this. One timer, one request. No-op outside the
     *  shell: __switchboardCloseModal is absent on hosts with no modal bridge and
     *  returns without posting on the full-page /memo route. */
    function _scheduleDismiss() {
        if (_dismissTimer) { return; }
        _dismissTimer = setTimeout(() => {
            _dismissTimer = null;
            try {
                if (typeof window.__switchboardCloseModal === 'function') {
                    window.__switchboardCloseModal('memo');
                }
            } catch { /* not iframed / no host bridge — nothing to close */ }
        }, DISMISS_DELAY_MS);
    }
```

In the `memoPromptResult` arm, extend the existing flash gate (`memo.js:193`) — same condition, so a reply that does not earn a `✓` does not earn a dismissal either:

```js
        if (!msg.isError && msg.memoCleared) { _flashAction(flashAction); _scheduleDismiss(); }
```

Cancel any pending timer at the top of **both** submit handlers, so a second submission inside the grace window (or a re-open followed by a new click) can never be closed by the previous click's timer. In `_memoCopyBtn`'s listener (`memo.js:254`) and `_memoSendBtn`'s (`memo.js:267`), immediately after the `clearTimeout(_memoSaveTimer)` line:

```js
            _cancelDismiss();   // a fresh submit owns the dismissal, not the previous one
```

Cancel it on typing too, so an operator who starts a new memo during the grace window keeps the surface they are typing into. In the `input` listener registration (`memo.js:236`):

```js
    if (_memoTextarea) {
        _memoTextarea.addEventListener('input', () => { _cancelDismiss(); _debouncedMemoSave(); });
    }
```

### 4. `src/test/memo-browser-clear-and-copy-contract.test.js` — behavioural coverage

The file already boots `memo.js` for real in jsdom against `memo.html`'s body markup (`bootMemoPanel`, lines 99-137) precisely because source regexes cannot see behaviour. Extend it:

- In `bootMemoPanel`, install a spy before `window.eval(memoJs)` and expose it:

```js
    const closeRequests = [];
    window.__switchboardCloseModal = (panelId) => closeRequests.push(panelId);
```
  Return `closeRequests` alongside `posted`, and add a `settleDismiss` helper that awaits slightly longer than `DISMISS_DELAY_MS` (`await new Promise(r => setTimeout(r, 750))`).

- New subtests, using the reply fixtures already defined at lines 139-150:
  - `REPLY_COPY_CLEARED` → exactly one `'memo'` close request.
  - `REPLY_COPY_CLEARED` delivered **twice** (the browser's real double delivery) → still exactly one request.
  - `REPLY_SEND_FAILED` → zero requests.
  - `REPLY_EMPTY` → zero requests.
  - Click copy, deliver `REPLY_COPY_CLEARED`, then click copy again inside the grace window → the first timer is cancelled, and after settling exactly one request total is observed.
  - Deliver `REPLY_COPY_CLEARED`, then fire an `input` event inside the grace window → zero requests.

### 5. `src/test/shell-modal-panel-contract.test.js` — pin the bridge arm

Add source-text assertions (the failure modes here are silent in the browser, which is why this file exists):

```js
test('the cross-frame bridge dismisses a modal panel on request, origin-checked', () => {
    assert.match(shellJs, /data\.type === 'closeModalPanel'/,
        'shell.js must handle a closeModalPanel request from a modal frame');
    const arm = block(shellJs, "data.type === 'closeModalPanel'", "data.type === 'switchboardThemeChanged'");
    assert.match(arm, /event\.origin !== location\.origin/, 'the closeModalPanel arm must check event.origin');
    assert.match(arm, /openModalId === data\.panel/, 'only the OPEN modal may be dismissed, and only by itself');
    assert.match(arm, /closeModal\(\)/, 'dismissal must route through closeModal() for rail/focus/ARIA reset');
});

test('memo.js requests dismissal only on the flash gate', () => {
    const memoJs = fs.readFileSync(path.join(__dirname, '../webview/memo.js'), 'utf8');
    assert.match(memoJs, /__switchboardCloseModal/, 'memo.js never asks the shell to close');
    assert.match(memoJs, /!msg\.isError && msg\.memoCleared\) \{ _flashAction\(flashAction\); _scheduleDismiss\(\);/,
        'dismissal must share the flash gate — a reply with no ✓ must not close the modal');
});
```

## Verification Plan

**Automated**

1. `npm run test:contract:memo-browser-clear` — all pre-existing subtests still green, plus the six new dismissal subtests.
2. `npm run test:contract:shell-modal-panel` — pre-existing modal assertions (frame never destroyed, no native `title`, manifest `presentation: 'modal'`) still green, plus the two new ones.
3. `npm run test:contract:memo-panel-style` — unchanged; confirms the markup edits did not disturb the memo panel's style contract.
4. `node --check src/webview/memo.js && node --check src/webview/shell.js && node --check src/webview/transport.js`.

**Manual (browser cockpit — the surface the report came from)**

Serve the cockpit from the running extension's API port (`.switchboard/api-server-port.txt`) and open `http://127.0.0.1:<port>/`. Note that the live server serves the installed VSIX's `dist/`, so run `npm run compile` and reload the extension before UAT, or the edits will not be in the page.

5. Rail → Memo. Type two entries. **Copy Prompt** → status shows `Prompt for 2 issue(s) copied to clipboard. Memo cleared.`, the button flashes `Copied ✓`, and within ~0.6s the overlay dismisses back to the panel behind it. The memo icon is no longer lit. Paste — the prompt is on the clipboard.
6. Re-open Memo → the textarea is empty (cleared), the overlay opens normally.
7. Type two entries. **Send to Planner** → `Sent ✓`, overlay dismisses, the planner terminal received the prompt, and the rail did **not** navigate anywhere on its own.
8. **Failure path:** with no planner terminal reachable, click Send to Planner → the overlay **stays open** showing `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.` and the text is still in the textarea.
9. **Empty path:** with an empty memo, click Copy Prompt → overlay stays open, status reads `No entries to process.`
10. **Grace-window typing:** click Copy Prompt and immediately start typing a new entry → the overlay stays open and the new text is not lost.
11. **Regression on the other exits:** `×`, backdrop click, Escape while focused in the textarea, and clicking another rail panel all still dismiss; re-opening Memo restores the frame with its state (no reload).
12. **Full-page route:** open `http://127.0.0.1:<port>/memo` directly and click Copy Prompt → clipboard and status behave as before, no console error, nothing tries to close the page.
13. **Sidebar untouched:** in VS Code, the Memo sub-tab's Copy Prompt / Send to Planner behave exactly as before (no modal involved).
