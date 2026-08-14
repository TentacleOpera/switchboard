# Dismiss the browser cockpit Memo modal after Copy Prompt / Send to Planner

## Goal

Make the Memo modal in the browser cockpit close itself once a Copy Prompt or Send to Planner click has actually succeeded, so the operator is returned to the panel they were on instead of having to hunt for the `×` or press Escape after every capture.

### Problem

In the headless app-shell (browser cockpit), Memo is not a panel you navigate to — it is an overlay. `src/services/headlessPanelHtml.ts:521` registers it as:

```ts
{ id: 'memo', label: 'Memo', icon: `${iconDir}/nav-memo.svg`, route: '/memo', enabled: true, presentation: 'modal' },
```

`shell.js` therefore mounts the `/memo` iframe inside `#modal-dialog` and shows it via `openModal()` (`src/webview/shell.js:65-76`). The only ways out today are the `×` button, a backdrop click, Escape, or navigating to another rail panel — all wired in `shell.js:38`, `53`, `754-756` and `selectPanel` (`shell.js:130-137`).

The two buttons that *finish* the memo workflow do not participate in any of that. `memo.js` posts the verb and then only paints in-frame feedback:

- `src/webview/memo.js:252-264` — Copy Prompt: `postMessage({ type: 'memoGeneratePrompt', action: 'copy', … })`, sets the status line to `Building prompt…`.
- `src/webview/memo.js:265-277` — Send to Planner: same, `action: 'send'`.
- `src/webview/memo.js:138-195` — the `memoPromptResult` arm writes the status line, clears the textarea when `msg.memoCleared` is true, and flashes `Copied ✓` / `Sent ✓` on the button (`_flashAction`, `memo.js:24-37`).

### Root cause

The memo frame has **no channel to its host at all**. `transport.js` gives every panel a cross-frame helper for *navigation* — `window.__switchboardSwitchPanel(panelId)` posts `{type:'switchPanel', panel}` to the parent (`src/webview/transport.js:432-446`) — and `shell.js`'s bridge handles exactly three inbound message types: `switchPanel`, `switchboardThemeChanged`, `terminalFleetState`, plus `popoutTerminal` (`shell.js:718-752`). There is no "dismiss the overlay hosting me" message, so a panel that has completed its job cannot say so. Nothing is broken in the verb path — the copy/send/clear all work; the missing piece is a one-way close request from the frame to the shell.

Three things constrain the fix and are the reason this is not a one-line change:

1. **`memo.js` is shared by two hosts.** The same file backs the shell's modal frame *and* the standalone full-page `/memo` route. `src/services/headlessPanelHtml.ts:376` injects `/static/webview/memo.js` into one HTML served for both; the route is registered at `src/services/LocalApiServer.ts:4044`. On the full-page route there is no parent to close anything, so the request must be a silent no-op there — the same shape `__switchboardSwitchPanel` already uses (`window.parent && window.parent !== window`).

2. **In the extension-hosted cockpit, one click delivers `memoPromptResult` twice.** Once via the WS fan-out (`TaskViewerProvider.ts:13329` pushes through `_broadcaster` → `BroadcastHub.mirrorToWs`) and once as the HTTP response body re-dispatched by `transport.js:406-412` — this is documented in `memo.js:147-152` and is the exact hazard the existing post-click-typing guard exists for. In the **standalone** host the arm (`src/standalone/bootstrap.ts:1659-1708`) returns a body and pushes nothing, and `LocalApiServer` does not mirror verb return bodies to WS, so there it is a single delivery. A dismissal request must therefore be idempotent under 1..n deliveries, not fired per delivery.

3. **`memoPromptResult` is not addressed to one surface.** `this.postMessage(...)` fans the same reply out to the VS Code sidebar webview *and* every WS client. A cockpit whose Memo overlay happens to be open receives the reply for a Copy the operator pressed **in the sidebar**. Flashing `Copied ✓` on that is merely noisy (pre-existing); *dismissing* on it would yank an overlay away from an operator who touched nothing. Dismissal must therefore be gated on "this frame submitted", which the flash is not.

### Scope decision

Dismissal fires **only on a real success that this frame asked for** — `!msg.isError && msg.memoCleared` (the same condition that already gates `_flashAction`, `memo.js:193`) **and** a locally-recorded submission. The three non-success replies keep the modal open, because each one leaves something on screen the operator must read:

| Reply | Source | Modal |
| :-- | :-- | :-- |
| `memoCleared: true`, no error, local submission | copy or send succeeded (`TaskViewerProvider.ts:13318-13347`) | **closes** |
| `memoCleared: true`, no error, **no** local submission | another surface (sidebar) pressed Copy; push mirrored over WS | stays open |
| `memoCleared: false`, `isError: true` | send failed, memo preserved for retry | stays open |
| `memoCleared: false`, `success: true`, `No entries to process.` | empty memo | stays open |
| `memoError` | unresolvable workspace root (`TaskViewerProvider.ts:13264-13273`) | stays open |

Non-goal: the modal does **not** navigate anywhere on close. A successful Send to Planner does not auto-switch the rail to Terminals — dismissal reveals whatever panel the operator was already on, which is the behaviour every other close path (`×`, Escape, backdrop) already has.

**Design invariant — every veto fails safe.** Each guard added below can only ever *prevent* a dismissal, never cause one. The worst outcome of any guard misfiring is the modal staying open, i.e. today's behaviour. No guard can lose text and none can close a surface the operator is using.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 3
> **Reason:** The improve pass found three live races the original scoring did not price in (duplicate-delivery re-arm after a veto, stale timer vs. re-open, and cross-surface WS fan-out dismissal), plus a fourth file in scope. The mechanics are still routine, but the change now spans five files with a real concurrency surface and eight new subtests — "single-file, localized" (1-4 lower band) no longer describes it.
> **Replaced with:** **Complexity:** 4 → *Send to Coder*.

**Not in scope, and deliberately so:** no new verb, no `verbSchemas.ts` entry, no `/panels` manifest change, no ratchet-baseline movement. This is a pure webview/shell change — `npm run verb-returns:check`, `npm run parity:check` and `npm run push-routing:check` are all unaffected. A coder should not go looking for provider work here. (Clarification, not new scope.)

## User Review Required

None. Every open question was decided in this pass: the grace period is 600 ms, dismissal is gated on a local submission, the re-open veto rides an explicit `panelVisibility` push from the shell, and the shell verifies the requesting frame. No open research items remain — see **Resolved Assumptions**.

## Complexity Audit

### Routine

- Adding a `__switchboardCloseModal` helper beside the existing `__switchboardSwitchPanel` in `transport.js` — identical shape, identical iframe guard.
- Adding one `else if` arm to the `shell.js` cross-frame bridge.
- Calling the helper from `memo.js`'s existing success branch.
- Extending two existing contract test files that already have the right harnesses (`bootMemoPanel` executes `memo.js`; `block()` scopes source assertions).

### Complex / Risky

- **Duplicate delivery.** One click → up to two `memoPromptResult` arrivals in the extension-hosted cockpit. `closeModal()` is already guarded by `if (!openModalId) { return; }` (`shell.js:79`), so a second *request* lands as a no-op — but the frame-side coalescing is what stops a second delivery from arming a second, later timer.
- **A veto defeated by the second delivery.** Coalescing on "is a timer in flight" is not the same as coalescing on "is this submission still eligible". Cancel the timer on typing, and the reply's second copy finds `_dismissTimer === null` and re-arms it. The fix is a latch cleared only by a fresh submit, not a bare `clearTimeout`.
- **Stale timer vs. re-open.** A timer armed for submission N must not close a modal the operator closed and re-opened afterwards. A modal frame receives **no visibility signal at all** today: `selectPanel`'s `panelVisibility` loop explicitly `continue`s past modal ids (`shell.js:140`), and `openModal`/`closeModal` post nothing. Closing that gap — extending the existing `panelVisibility` contract to modal frames — is the fix, and it is a latent hole worth closing on its own merits.
- **Cross-surface fan-out.** `memoPromptResult` is broadcast, not addressed. Without a local-submission gate, a sidebar Copy closes the cockpit's overlay.
- **Two hosts, one script.** The full-page `/memo` route must not throw and must not attempt anything. Guarded by the `window.parent !== window` check inside the transport helper, so `memo.js` stays host-agnostic.
- **Do not add a second writer on the way out.** `shell.js:84-86` carries an explicit comment that `closeModal` performs no flush, no save, no postMessage — memo.js owns its debounced save. This change must not violate that: the frame asks the shell to close; the shell still writes nothing.
- **CSP.** `/memo` is served with `default-src 'none'; … frame-src 'none'` (`headlessPanelHtml.ts:374`). `postMessage` to the parent is not a CSP-governed fetch — there is no directive that applies to it — so no directive change is needed, and none should be added.

## Edge-Case & Dependency Audit

### Race Conditions

- **Double delivery arms one timer.** `_scheduleDismiss()` returns early while a timer is in flight, so deliveries 1 and 2 produce exactly one close request.
- **Veto then second delivery.** Handled by the `_dismissVetoed` latch: `_vetoDismiss()` both cancels the timer and blocks re-arming until the next submit click clears it. Without the latch, the typing veto is a ~5 ms window that the WS/HTTP pair walks straight through.
- **Timer armed, operator navigates away.** `selectPanel` → `closeModal()` runs first; the timer later hits `if (!openModalId) { return; }` and no-ops.
- **Timer armed, operator navigates away and back inside 600 ms.** `closeModal()` posts `{type:'panelVisibility', visible:false}` into the frame, which vetoes on the spot; `openModal()` posts `visible:true` on the way back in and vetoes again. Either push alone is sufficient; both are cheap. The re-opened overlay stays open.
- **`_flashAction`'s own 1600 ms restore timer outlives the dismissal.** The frame is never destroyed on close (`shell-modal-panel-contract.test.js:63-73` pins this), so the timer runs to completion against a hidden frame and the button label is correct on the next open.
- **Post-click typing.** If the operator types after clicking, the existing guard (`memo.js:154-187`) may decline the clear; `memoCleared` is still `true` in the reply, so under the stated gate a dismissal would be scheduled — and is then immediately vetoed by the very `input` event that made the guard decline. If the reply somehow arrives with no typing at all, the text is safe regardless: the frame survives close and the debounced save still runs. Do **not** widen the gate to `clearedNow`, which would break dismissal for the ordinary case where the `memoContent:''` push wins the race.

### Security

- **Origin.** The bridge's newer arms check `event.origin !== location.origin` (`shell.js:729`, `732`). The memo frame is same-origin, so the new arm keeps that check and still passes.
- **Sender identity.** Origin alone does not prove *which* frame asked — every panel is same-origin. The arm additionally requires `event.source` to be the named panel's own `contentWindow`, so "a panel may dismiss itself and nothing else" is enforced rather than merely asserted in a comment.
- **Target origin `'*'`.** `__switchboardCloseModal` posts with `'*'` exactly as `__switchboardSwitchPanel` does. The payload carries no secret (a panel id), and the receiver verifies origin *and* source. Narrowing to `location.origin` here would be harmless but gratuitously divergent from the sibling helper.
- **No new network surface.** No verb, no route, no schema. Nothing crosses the HTTP trust boundary.

### Side Effects

- **`closeModal()` is the single dismissal path.** Driving dismissal through it (rather than hand-toggling `is-open`) keeps rail `is-active`, `aria-expanded`, and focus return correct for free (`shell.js:80-81`, `87`).
- **No writes on close.** The shell's "no flush, no save, no postMessage" contract is preserved: the frame asks, the shell closes, memo.js's own debounced save is the only writer.
- **VS Code sidebar Memo sub-tab.** `src/webview/implementation.html:1600-1606` (markup), `:2205-2209` (`memoPromptResult` handler) and `:2740-2767` (button wiring) are an **entirely separate inline implementation** — `memo.js` is not loaded there. It is a tab, not a modal. Untouched by this plan and must stay untouched.
- **`browser-panel-verb-routing.test.js:160`** scans `memo.js` for `vscode.postMessage({type:'…'})` verbs. The new code posts no verb (it calls a `window.__switchboard*` helper), and `extractPostedVerbs` already skips `window.parent.postMessage` prefixes (`:73`). No allowlist change needed.
- **`shell-modal-panel-contract.test.js:57-61`** asserts `modalPanels.has(pid)` + `continue` appears exactly twice. The new arm uses `modalPanels.has(data.panel)` with no `continue`, so the count is unchanged.
- **`shell-modal-panel-contract.test.js:63-73`** forbids `.src =`, `.remove(` and `frames.delete(` inside `closeModal` (after masking `classList.remove(`). The new push uses `frames.get(...)` and `postMessage` and trips none of them.
- **`scripts/check-push-routing.js`** counts raw push sites in **provider** files only. `shell.js` is a webview, not a provider, so the two new `postMessage` calls do not move that count.
- **Modal frames now receive `panelVisibility`.** Memo is the only `presentation: 'modal'` panel today, and it gains an explicit arm. Any future modal panel inherits the message and, like every panel with no arm for a type, falls through its message chain and ignores it.
- **`shell-modal-panel-contract.test.js:75-77`** asserts `shell.js` sets no `.title`. The new arm sets none.

### Dependencies & Conflicts

- **Standalone host degrade.** `src/standalone/bootstrap.ts:1686-1695` degrades a failed `send` into a copy and returns `memoCleared: false, action: 'copy'` with `success: true` and no `isError`. Under the `!isError && memoCleared` gate this correctly does **not** dismiss — the status line explains the degrade and the memo is preserved.
- **Full-page `/memo` route (not iframed).** `window.parent === window` → helper returns without posting. Modal behaviour is simply absent; nothing regresses.
- **`terminalDispatch: false` hosts.** `transport.js:455-467` hides `#memo-send-btn` entirely on such hosts, so only the copy path exists there. No extra handling needed.
- **No confirmation dialogs.** Per project rules, dismissal is unconditional on success — no "are you sure", no two-click pattern.
- **No file conflicts.** `transport.js`, `shell.js` and `memo.js` are each touched by one edit block; no other in-flight plan under this project owns them. One agent stream (PRD orchestration discipline) is sufficient.

## Dependencies

- None. This plan has no upstream session dependency and unblocks nothing else.

## Adversarial Synthesis

**Risk summary.** The whole change is two message hops; all the risk is in *when* the dismissal fires, not whether it can. Three races decide correctness — the extension host's duplicate delivery of `memoPromptResult`, a veto being undone by that duplicate, and a timer armed for one modal session firing into the next — and one addressing bug (the reply is broadcast, so a VS Code sidebar Copy would otherwise close the cockpit's overlay). Mitigations: coalesce on a `_dismissVetoed` latch that only a fresh submit clears; veto on `input` and on an explicit `panelVisibility` push that `openModal`/`closeModal` now send to modal frames (they send nothing today — modal ids are skipped by `selectPanel`'s loop); gate scheduling on a locally-recorded submission captured before the existing reset block nulls it; and have the shell verify `event.origin`, `openModalId`, and `event.source === frames.get(panel).contentWindow` before calling `closeModal()`. Every guard fails safe — its worst outcome is the modal staying open, which is today's behaviour.

## Proposed Changes

### 1. `src/webview/transport.js` — add the close-request helper

Immediately after `window.__switchboardSwitchPanel` (currently ending at line 446), add its dismissal counterpart. Same iframe guard, same `'*'` target origin (the shell verifies `event.origin` **and** `event.source` on receipt).

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

Add one arm to the listener at `shell.js:718-752`, after the `switchPanel` arm and before the `switchboardThemeChanged` arm:

```js
        } else if (data.type === 'closeModalPanel' && typeof data.panel === 'string') {
            if (event.origin !== location.origin) { return; }
            // A modal frame has no handle on the overlay hosting it, so it ASKS.
            // Three gates: the named panel must actually be modal-presented, it
            // must be the one currently open, and the request must come from THAT
            // frame's own window — every panel here is same-origin, so origin
            // alone does not identify the sender, and "a panel may dismiss itself
            // and nothing else" has to be enforced rather than assumed.
            // Routed through closeModal() so the rail icon, focus return and
            // aria-expanded all reset exactly as they do for the ×, the backdrop
            // and Escape — and so the "no flush, no save, no postMessage on the
            // way out" rule keeps holding: the frame ASKS, the shell still
            // writes nothing.
            const modalFrame = frames.get(data.panel);
            if (modalPanels.has(data.panel)
                && openModalId === data.panel
                && modalFrame && event.source === modalFrame.contentWindow) {
                closeModal();
            }
        } else if (data.type === 'switchboardThemeChanged') {
```

> **Superseded:** `if (modalPanels.has(data.panel) && openModalId === data.panel) { closeModal(); }`, commented as "Only the overlay that is actually open may be dismissed, and only by itself."
> **Reason:** The comment claimed sender identity the code never checked. Every panel iframe is same-origin, so `event.origin === location.origin` admits a request from *any* panel — the Board frame could dismiss the Memo overlay. The gap is silent (nothing throws; the wrong overlay just closes) and free to close.
> **Replaced with:** the three-gate form above, adding `event.source === modalFrame.contentWindow`.

Then give modal frames the visibility signal they have never had. `selectPanel` posts `{type:'panelVisibility', visible}` to every non-modal frame (`shell.js:147-152`) and explicitly `continue`s past modal ids (`shell.js:140`), because a modal is shown by the host rather than by `is-active`. The consequence is that a modal frame cannot observe its own opening or closing at all. Post it from the two functions that *do* own modal visibility.

In `openModal()`, after `focusModalContent(frame)` (`shell.js:75`):

```js
        // Modal frames are skipped by selectPanel's panelVisibility loop (they are
        // shown by the host, not by is-active), so without this they never learn
        // they were opened or closed. memo.js uses it to drop a pending dismissal
        // timer that would otherwise close a modal the operator just re-opened.
        try {
            frame.contentWindow?.postMessage({ type: 'panelVisibility', visible: true }, location.origin);
        } catch { /* frame not ready yet */ }
```

In `closeModal()`, before the focus-return block (`shell.js:87`) — note it must read the frame via the id captured *before* `openModalId` is nulled:

```js
        const closingFrame = frames.get(closingId);
        try {
            closingFrame?.contentWindow?.postMessage({ type: 'panelVisibility', visible: false }, location.origin);
        } catch { /* frame gone */ }
```

`closeModal` currently nulls `openModalId` at `shell.js:83` before the focus return, so capture it at the top of the function (`const closingId = openModalId;`, alongside the existing `if (!openModalId) { return; }` guard) and use that for both the icon lookup and this push.

This is a push, not a write: it changes no state the frame owns, so the "no flush, no save" rule at `shell.js:84-86` is untouched. That comment forbids the shell *writing memo data* on the way out; telling a frame it is now hidden is the same class of message `selectPanel` already sends every other panel.

> **Superseded:** Detecting a re-open inside the frame by listening for the `focus` event that `openModal()` → `focusModalContent()` → `textarea.focus()` fires.
> **Reason:** Web research (52 sources, spec + engine source + WPT) shows cross-document `.focus()` is not a reliable event signal, and three of its documented failure modes hit this code exactly. (a) `#modal-host` is `display: none` when closed (`shell.html:162-163`), so `openModal` un-hides an ancestor and calls `.focus()` across an iframe boundary **in the same task** — WebKit and Gecko may evaluate `isFocusable()` against a stale frame tree and abort silently, and Blink's `UpdateStyleAndLayoutTree` is not guaranteed to complete cross-frame attachment synchronously. (b) If the child document's `activeElement` is still the textarea, the WHATWG focusing steps **abort before the focus update steps** and dispatch nothing — a spec-mandated no-op, not an engine quirk. (c) When the top-level window lacks OS system focus, all three engines update `activeElement` but suppress the DOM `focus` event. The mechanism is unreliable in principle *and* silent when it fails.
> **Replaced with:** an explicit `panelVisibility` push from `openModal`/`closeModal`. This is the research's top-ranked mechanism (`postMessage` is independent of focus state, rendering state and layout timing), and it is not new machinery — it extends the message type and the intent `selectPanel` already implements for every non-modal panel to the one case it was never extended to.

Also extend the file header comment (`shell.js:10-11`) so the bridge's contract stays documented:

```js
 * Cross-panel bridge: listens for postMessage {type:'switchPanel', panel}
 * from iframes and switches the active panel; {type:'closeModalPanel', panel}
 * dismisses a modal-presented panel at its own request.
```

### 3. `src/webview/memo.js` — request dismissal on a real, locally-initiated success

Add the delay constant, the veto latch, and the coalesced scheduler near `_flashAction` (after `memo.js:37`):

```js
    // ─── Modal dismissal (headless app-shell) ────────────────────────────────
    // Grace period before the overlay is dismissed: long enough for the
    // "Copied ✓" / "Sent ✓" flash to paint so the dismissal reads as a response
    // to the click, short enough that it does not read as a timer.
    const DISMISS_DELAY_MS = 600;
    let _dismissTimer = null;
    // Dismissal for the CURRENT submission has been vetoed. Cleared ONLY by a
    // fresh submit click. Without this latch a veto is defeated within
    // milliseconds: the extension-hosted cockpit delivers memoPromptResult
    // TWICE, and the second delivery finds _dismissTimer already null and
    // happily re-arms the timer the veto just cancelled.
    let _dismissVetoed = false;

    function _cancelDismiss() {
        if (_dismissTimer) { clearTimeout(_dismissTimer); _dismissTimer = null; }
    }

    /** Veto dismissal until the next submit: cancel any armed timer AND stop a
     *  later duplicate delivery from re-arming one. */
    function _vetoDismiss() {
        _cancelDismiss();
        _dismissVetoed = true;
    }

    /** Ask the host shell to close the Memo overlay. Coalesced: in the
     *  extension-hosted cockpit one click delivers memoPromptResult TWICE (the
     *  WS fan-out AND the HTTP body re-dispatched by transport.js — see the note
     *  in the memoPromptResult arm) and both reach this; standalone delivers it
     *  once. One timer, one request, either way. No-op outside the shell:
     *  __switchboardCloseModal is absent on hosts with no modal bridge and
     *  returns without posting on the full-page /memo route. */
    function _scheduleDismiss() {
        if (_dismissTimer || _dismissVetoed) { return; }
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

In the `memoPromptResult` arm, capture the local-submission fact immediately after `flashAction` is resolved (`memo.js:146`) — it must be read **before** the reset block at `memo.js:184-187` nulls `_submittedContent`:

```js
                // Captured BEFORE the reset block below nulls it, for the same
                // reason flashAction is. A reply with no local submission behind
                // it belongs to ANOTHER surface — memoPromptResult is broadcast,
                // not addressed, so the VS Code sidebar's Copy arrives here over
                // the WS fan-out. Flashing on that is merely noisy; DISMISSING on
                // it would yank the overlay out from under an operator who
                // touched nothing.
                const wasOurSubmission = _submittedContent !== null;
```

Then extend the existing flash gate (`memo.js:193`) — same success condition, plus the ownership check:

```js
        if (!msg.isError && msg.memoCleared) {
            _flashAction(flashAction);
            if (wasOurSubmission) { _scheduleDismiss(); }
        }
```

> **Superseded:** `if (!msg.isError && msg.memoCleared) { _flashAction(flashAction); _scheduleDismiss(); }` — "same condition, so a reply that does not earn a `✓` does not earn a dismissal either."
> **Reason:** The flash and the dismissal do not deserve the same gate. `memoPromptResult` is pushed via `this.postMessage` (`TaskViewerProvider.ts:13329`) and fanned out to the webview *and* every WS client, so a Copy pressed in the **VS Code sidebar** arrives at an open cockpit Memo overlay carrying `memoCleared: true, isError: false`. A stray `Copied ✓` flash there is pre-existing noise; a dismissal is a surface vanishing on an operator who did not act. `_submittedContent === null` already identifies exactly this case — `memo.js:162-168` uses it for the same purpose in the clear guard.
> **Replaced with:** the flash keeps its existing gate; the dismissal additionally requires `wasOurSubmission`.

Reset the veto latch at the top of **both** submit handlers, so a fresh submission re-earns the right to dismiss and can never be closed by the previous click's timer. In `_memoCopyBtn`'s listener (`memo.js:254-255`) and `_memoSendBtn`'s (`memo.js:267-268`), immediately after the `clearTimeout(_memoSaveTimer)` line:

```js
            _cancelDismiss();
            _dismissVetoed = false;   // a fresh submit owns the dismissal, not the previous one
```

Veto on typing, at the `input` registration (`memo.js:236`):

```js
    if (_memoTextarea) {
        // Typing during the grace window means the operator is starting a new
        // memo — keep the surface they are typing into.
        _memoTextarea.addEventListener('input', () => { _vetoDismiss(); _debouncedMemoSave(); });
    }
```

Veto on any change of overlay visibility, as a new arm in the `message` switch (alongside `switchboardThemeChanged`, `memo.js:99`):

```js
            case 'panelVisibility': {
                // The shell's openModal/closeModal now tell modal frames when they
                // are shown and hidden. Either transition invalidates a pending
                // dismissal: it was armed for a modal session that has ended, and
                // firing it into the NEXT session closes an overlay the operator
                // just deliberately re-opened.
                _vetoDismiss();
                break;
            }
```

> **Superseded:** "Stale timer vs re-open … Handled by clearing the pending timer on every fresh submit click and by only ever having one timer in flight."
> **Reason:** Re-opening the overlay is not a submit click, so neither stated mitigation covers it. Concretely: click Copy → reply arrives, timer armed → click another rail icon (`selectPanel` → `closeModal()`) → click Memo again (`openModal()`) → at t=600 ms the stale timer closes the modal the operator just deliberately re-opened. Two clicks inside 600 ms is an ordinary double-click cadence, not a contrived race.
> **Replaced with:** a `panelVisibility` arm that vetoes on both the close and the re-open, fed by the two shell pushes added in §2. Unlike a focus listener it depends on no rendering, focus or layout state.

### 4. `src/test/memo-browser-clear-and-copy-contract.test.js` — behavioural coverage

The file already boots `memo.js` for real in jsdom against `memo.html`'s body markup (`bootMemoPanel`, `:108-137`) precisely because source regexes cannot see behaviour. Extend it:

- In `bootMemoPanel`, install a spy and expose it (order relative to `window.eval(memoJs)` does not matter — the helper is resolved at timer-fire time, not at boot):

```js
    const closeRequests = [];
    window.__switchboardCloseModal = (panelId) => closeRequests.push(panelId);
```
  Return `closeRequests` alongside `posted`, and add a `settleDismiss` helper that awaits comfortably longer than `DISMISS_DELAY_MS` (`await new Promise(r => setTimeout(r, 750))`). These are real waits — jsdom ships no fake-timer facility and stubbing `window.setTimeout` globally would also capture `_flashAction`'s 1600 ms restore and `_debouncedMemoSave`'s 800 ms debounce, breaking the pre-existing subtests. Budget ~5 s of added suite runtime and do not try to engineer it away.

- New subtests, using the reply fixtures already defined at `:139-149`:
  - `REPLY_COPY_CLEARED` after a real copy click → exactly one `'memo'` close request.
  - `REPLY_COPY_CLEARED` delivered **twice** (the extension host's real double delivery) → still exactly one request.
  - `REPLY_SEND_FAILED` → zero requests.
  - `REPLY_EMPTY` → zero requests.
  - **Foreign clear** — deliver `REPLY_COPY_CLEARED` to a freshly booted panel that never clicked (`_submittedContent === null`, mirroring the existing subtest at `:435-449`) → zero requests. This is the sidebar-pressed-Copy case.
  - **Veto survives the duplicate** — click copy, deliver `REPLY_COPY_CLEARED`, fire an `input` event, then deliver `REPLY_COPY_CLEARED` **again** → zero requests. Delivering only once here would pass against the buggy `clearTimeout`-only implementation; the second delivery is the whole point of the subtest.
  - **Visibility veto** — click copy, deliver `REPLY_COPY_CLEARED`, then deliver `{ type: 'panelVisibility', visible: false }` inside the grace window → zero requests. Repeat with `visible: true` (the re-open push) → zero requests.
  - **Fresh submit re-earns dismissal** — click copy, deliver `REPLY_COPY_CLEARED`, type (veto), then click copy again and deliver `REPLY_COPY_CLEARED` → exactly one request after settling, proving the latch is cleared by a submit and not sticky.

### 5. `src/test/shell-modal-panel-contract.test.js` — pin the bridge arm and the transport helper

Add source-text assertions (the failure modes here are silent in the browser, which is why this file exists). This file already loads `shellJs` and has the `block()` helper (`:33-39`); add a `transport.js` read alongside `shellJs` at `:15-17`.

```js
test('the cross-frame bridge dismisses a modal panel on request, origin- and source-checked', () => {
    assert.match(shellJs, /data\.type === 'closeModalPanel'/,
        'shell.js must handle a closeModalPanel request from a modal frame');
    const arm = block(shellJs, "data.type === 'closeModalPanel'", "data.type === 'switchboardThemeChanged'");
    assert.match(arm, /event\.origin !== location\.origin/, 'the closeModalPanel arm must check event.origin');
    assert.match(arm, /openModalId === data\.panel/, 'only the OPEN modal may be dismissed');
    assert.match(arm, /event\.source === \w+\.contentWindow/,
        'only the modal frame ITSELF may dismiss it — every panel is same-origin, so origin alone does not identify the sender');
    assert.match(arm, /closeModal\(\)/, 'dismissal must route through closeModal() for rail/focus/ARIA reset');
});

test('modal frames are told when they are shown and hidden', () => {
    // selectPanel deliberately skips modal ids, so openModal/closeModal are the
    // ONLY things that can tell a modal frame its visibility changed. Without
    // both pushes a stale dismissal timer closes the next modal session.
    const open = block(shellJs, 'function openModal(id) {', 'function closeModal()');
    assert.match(open, /panelVisibility[\s\S]*visible:\s*true/,
        'openModal must tell the modal frame it became visible');
    const close = block(shellJs, 'function closeModal() {', 'function toggleModal');
    assert.match(close, /panelVisibility[\s\S]*visible:\s*false/,
        'closeModal must tell the modal frame it was hidden');
    // The id is nulled mid-function; the push must not read it after that.
    assert.match(close, /const closingId = openModalId/,
        'closeModal must capture the closing id before nulling openModalId');
});

test('transport.js exposes the close-request helper, iframe-guarded', () => {
    assert.match(transportJs, /window\.__switchboardCloseModal\s*=/,
        'transport.js must expose __switchboardCloseModal');
    const fn = block(transportJs, 'window.__switchboardCloseModal', '// ─── Host-adaptive UI');
    assert.match(fn, /window\.parent !== window/,
        'the helper must no-op when not iframed — the full-page /memo route has no host to ask');
    assert.match(fn, /type: 'closeModalPanel'/, 'the helper must post the closeModalPanel message type');
});
```

> **Superseded:** a third assertion in this file reading `memo.js` and matching `/!msg\.isError && msg\.memoCleared\) \{ _flashAction\(flashAction\); _scheduleDismiss\(\);/`.
> **Reason:** Two problems. (a) It pins exact inter-token whitespace on a multi-statement line, so any reformat — including the multi-line form this plan now specifies — reds it for no behavioural reason. (b) It puts a `memo.js` behavioural claim in the *shell* contract file, when the sibling file two doors down already **executes** `memo.js` in jsdom and can assert the real thing. A regex asserting "dismissal shares the flash gate" is exactly the class of check that shipped the double-delivery bug while every regex stayed green (`memo-browser-clear-and-copy-contract.test.js:101-106`).
> **Replaced with:** the gate is covered behaviourally by the eight subtests in §4 (which distinguish the gates by *outcome*, including the foreign-clear case a shared-gate regex would have wrongly blessed); this file gains a `transport.js` helper assertion instead, keeping it scoped to the shell/transport seam it owns.

## Verification Plan

### Automated Tests

1. `npm run test:contract:memo-browser-clear` — all pre-existing subtests still green, plus the eight new dismissal subtests. Expect ~5 s of added wall time from the real `settleDismiss` waits.
2. `npm run test:contract:shell-modal-panel` — pre-existing modal assertions (`selectPanel` intercepts modal ids; both toggle loops skip them **exactly twice**; `closeModal` never destroys the frame; no native `title`; manifest `presentation: 'modal'`) still green, plus the two new ones.
3. `npm run test:contract:memo-panel-workspace-binding` — regression guard: it asserts `memo.js` source shape for the workspace path, which this change edits around.
4. `node src/test/browser-panel-verb-routing.test.js` — regression guard: confirms `memo.js` still posts no verb outside `PLANNING_ROUTE` (the new code posts none).
5. `npm run test:contract:memo-panel-style` — regression guard on the memo panel's style contract. No markup changes in this plan; this run exists to prove that.
6. `node --check src/webview/memo.js && node --check src/webview/shell.js && node --check src/webview/transport.js`.

### Manual (browser cockpit — the surface the report came from)

The cockpit is served by the **installed VSIX**, not the repo working tree, so `src/` edits are invisible to a running server. Rebuild and reinstall the VSIX (or restart the extension host against a rebuilt one) before UAT, then serve from the running extension's API port (`.switchboard/api-server-port.txt`) and open `http://127.0.0.1:<port>/`.

> **Superseded:** "Note that the live server serves the installed VSIX's `dist/`, so run `npm run compile` and reload the extension before UAT."
> **Reason:** `npm run compile` writes the *repo's* `dist/`, which is not what the live server reads — per project rules `dist/` is not used during development or testing, and all testing goes through an installed VSIX. Following the old instruction produces a green compile and a UAT run against unchanged code.
> **Replaced with:** rebuild **and reinstall** the VSIX before UAT.

7. Rail → Memo. Type two entries. **Copy Prompt** → status shows `Prompt for 2 issue(s) copied to clipboard. Memo cleared.`, the button flashes `Copied ✓`, and within ~0.6 s the overlay dismisses back to the panel behind it. The memo icon is no longer lit. Paste — the prompt is on the clipboard.
8. Re-open Memo → the textarea is empty (cleared), the overlay opens normally.
9. Type two entries. **Send to Planner** → `Sent ✓`, overlay dismisses, the planner terminal received the prompt, and the rail did **not** navigate anywhere on its own.
10. **Failure path:** with no planner terminal reachable, click Send to Planner → the overlay **stays open** showing `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.` and the text is still in the textarea.
11. **Empty path:** with an empty memo, click Copy Prompt → overlay stays open, status reads `No entries to process.`
12. **Grace-window typing:** click Copy Prompt and immediately start typing a new entry → the overlay stays open and the new text is not lost.
13. **Re-open race:** click Copy Prompt, then immediately click another rail icon and click Memo again (both inside ~0.6 s) → the re-opened overlay **stays open**. This is the stale-timer case; without the `panelVisibility` veto it closes under the operator.
14. **Cross-surface:** with the cockpit's Memo overlay open in the browser, press **Copy Prompt in the VS Code sidebar's Memo sub-tab** → the cockpit overlay **stays open**. (Its textarea may clear via the existing foreign-clear path; that is pre-existing and correct.)
15. **Regression on the other exits:** `×`, backdrop click, Escape while focused in the textarea, and clicking another rail panel all still dismiss; re-opening Memo restores the frame with its state (no reload).
16. **Full-page route:** open `http://127.0.0.1:<port>/memo` directly and click Copy Prompt → clipboard and status behave as before, no console error, nothing tries to close the page.
17. **Sidebar untouched:** in VS Code, the Memo sub-tab's Copy Prompt / Send to Planner behave exactly as before (no modal involved).

## Resolved Assumptions

**Authoritative — do not re-open.** No web research remains outstanding for this plan.

- **Cross-document `.focus()` as a re-open signal — RESOLVED: rejected.** Web research (52 sources: WHATWG HTML focusing steps, W3C UI Events, Blink/Gecko/WebKit source, WPT) established that a parent document calling `.focus()` on an element inside a same-origin child iframe is not a reliable event signal. Three documented failure modes hit this code exactly: the spec-mandated abort when the target is already the child's `activeElement` (no events dispatched at all); engine suppression of the DOM `focus` event whenever the top-level window lacks OS system focus; and silent `isFocusable()` failure when `.focus()` runs in the same task as un-hiding a `display: none` ancestor across a frame boundary — which is precisely `openModal()`'s shape, since `#modal-host` is `display: none` when closed (`shell.html:162-163`). The re-open veto was therefore re-based onto an explicit `panelVisibility` push (Proposed Changes §2), the research's top-ranked mechanism, which depends on no focus, rendering or layout state. `ResizeObserver` on the child root was evaluated as the runner-up (it would work here, since the wrapper really does collapse to `0×0`) and rejected only because `postMessage` reuses a contract this shell already implements for every non-modal panel.

- **Observation, out of scope, no action in this plan.** The same research implies `focusModalContent()`'s existing auto-focus of the memo textarea on open is itself unreliable for reasons (a) and (c) above — a pre-existing latent bug in the modal's ergonomics, unrelated to dismissal. It is not fixed here and must not be bundled in. Worth a separate plan if operators report the modal opening without the caret in the textarea.

- Everything else in this plan was verified directly against the source in this repository during the improve pass.

---

**Recommendation: Send to Coder** (Complexity 4).
