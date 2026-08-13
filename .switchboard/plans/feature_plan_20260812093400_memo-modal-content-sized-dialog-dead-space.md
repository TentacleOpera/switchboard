# Memo Modal Is Oversized: Dead Space Below The Memo Swallows Backdrop-Dismiss Clicks

## Goal

Size the Memo modal to its content so there is no large empty region below the memo controls, and so a click in the area the operator naturally aims at to dismiss the dialog lands on the backdrop and closes it.

### Problem analysis

The Memo modal opens far taller than its content. Below the Clear / Copy Prompt / Send to Planner button row there is a large band of empty dialog. The operator reads that band as "outside the dialog" and clicks it to dismiss — the universal modal gesture. The click lands **inside** the dialog, nothing happens, and the modal appears frozen. They click again, still nothing. The only working exits are the `×`, Escape, or a click far enough out to reach the real backdrop.

### Root cause

**The dialog's height is a fixed constant, not derived from content.**

`src/webview/shell.html:165-177`
```css
#modal-dialog {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: min(820px, 92%);
    height: min(700px, 88%);   /* ← fixed, content-independent */
    ...
}
```

`.modal-frame` then fills it (`shell.html:180-187`, `width:100%; height:100%`).

The memo document's natural content height is roughly: header ~45px + two hint paragraphs ~50px + `min-height: 320px` textarea (`memo.html:141-150`) + status line ~22px + button row ~40px + 32px of `.memo-body` padding ≈ **510px**. On any window taller than ~580px the dialog resolves to 700px, leaving **~190px of empty iframe** below the buttons. On a tall display the gap is the full 190px every time.

**That empty band is inside the iframe, and the backdrop is not under it.**

`#modal-backdrop` is a sibling of `#modal-dialog` covering the whole host (`shell.html:164`, `inset: 0`), and its click handler is the only backdrop dismissal (`src/webview/shell.js:36-39`). The dialog sits *above* it. A click in the dead band hits `.modal-frame` → the memo document's `<body>` → no handler anywhere. Dismissal never fires.

So the two halves of the report are one defect with one cause: the dialog is bigger than its content, and the oversized remainder is opaque to the dismiss gesture.

### Why content-sizing, not "make the dialog shorter"

A hardcoded shorter height re-breaks the moment the memo grows a control, and `.modal-textarea` is `resize: vertical` (`memo.html:143`) — the operator can legitimately drag the textarea taller, and the dialog must follow. The dialog must be measured from the panel, not guessed by the shell.

An iframe does not auto-size to its document, so the panel has to report its height and the shell has to apply it. That is the only mechanism that satisfies both "no dead space" and "still correct after the user resizes the textarea".

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard
- **Feature:** 553bb8eb-08ba-483f-a892-e04c7c8ecd2b

## User Review Required

- None. The measurement property, the reset semantics, the clamp bounds and the decision not to add a click-to-dismiss handler inside the memo document are all settled below.

## Complexity Audit

### Routine

- Changing `#modal-dialog` from `height: …` to `height: var(…)` plus a floor and a cap.
- Adding a `ResizeObserver` in `memo.js` that posts its content height.
- Adding a `modalContentHeight` arm to the shell's existing `message` listener (`shell.js:718-752`).

### Complex / Risky

- **Measurement loop, and the measurement property itself.** Sizing the dialog from the frame's content, when the frame's content depends on the dialog's size, is a classic feedback loop. The memo body is height-independent (it is a top-anchored block flow, not a `height:100%` layout), so the loop is avoidable — **but only if the property reported is content-sized rather than viewport-sized.**

  > **Superseded:** "Report from `document.documentElement.scrollHeight` with the body's own height left `auto`; do not report `getBoundingClientRect().height` of a stretched element."
  > **Reason:** For the **root** element, `scrollHeight` returns the height of the document's scrolling area, which is at least the viewport. Inside a 700px iframe with ~510px of content it returns **700**, not 510. The panel would therefore report exactly the height it was already given, the shell would re-apply it, and the ~190px of dead space would never go away — a fix that ships, passes review, and does nothing. The advice to avoid `getBoundingClientRect()` was aimed at a *stretched* element and is correct for one; the root element here is not stretched.
  > **Replaced with:** Report `document.documentElement.getBoundingClientRect().height`. The root box is `height: auto` and content-sized (body carries `margin: 0` in `memo.html:56`, so nothing escapes it), so the rect is the true content height and is independent of the height the shell applies.

- **Border box compensation.** `shell.html:47` declares `* { box-sizing: border-box; margin: 0; padding: 0; }`, so `#modal-dialog`'s `height` includes its `1px solid` border while `.modal-frame` fills only the content box. Assigning the raw reported content height leaves the frame 2px short and the panel permanently scrolling by 2px — visible as a scrollbar on a dialog that is supposedly sized to fit. The shell must add the dialog's own border back, measured (`offsetHeight - clientHeight`), not hardcoded.

- **Generic host, one consumer.** `#modal-dialog` is shared by every `presentation: 'modal'` panel (`shell.js:649-654`); `memo` is the only one today (`headlessPanelHtml.ts:521`). A panel that never posts a height must keep today's behaviour exactly. The fixed height therefore becomes the *default*, overridden only when that panel has reported one.

- **Untrusted-origin message.** The shell's `message` listener already gates some arms on `event.origin !== location.origin` (`shell.js:729, 732`) and some not. A height message must be origin-checked, sender-verified and range-clamped — an unclamped value from a hostile frame could size the dialog to `1e9px`.

- **VS Code host.** `memo.html` is also rendered inside the VS Code webview host, where there is no shell and no modal. The reporter must no-op harmlessly there (it posts to a cross-origin parent that ignores it), and no memo behaviour may depend on a reply.

## Edge-Case & Dependency Audit

1. **Short windows.** `max-height: min(700px, 88%)` must stay, or a memo taller than the viewport overflows off-screen. When content exceeds the cap, the dialog clamps and `.modal-frame` scrolls internally — the current behaviour for a long memo, unchanged.
2. **Minimum height.** A memo panel that reports a tiny height (e.g. before fonts load) must not collapse the dialog to a sliver. Apply a floor (`min-height: min(320px, 88%)`) and mirror it in the JS clamp.
3. **Textarea drag-resize.** `.modal-textarea` is `resize: vertical`. The `ResizeObserver` must be attached such that a manual drag is observed — observe `document.documentElement` (or the body), not the textarea alone, so both the drag and any content reflow are caught.
4. **Font loading.** `memo.html` loads two `@font-face` families with `font-display: swap` (lines 8-21). The first measurement can land pre-swap and be short. The `ResizeObserver` fires again on the reflow, so this self-corrects — but the first post must not be treated as final.
5. **Debounce.** A drag-resize fires the observer continuously. `requestAnimationFrame`-coalesce the post, or the shell restyles the dialog on every frame of the drag.
6. **Modal frames are never destroyed — and that is what makes a naive "clear on open" wrong.** `openModal` only *unhides* the frame (`shell.js:61-76`); its document, WebSocket and autosave debounce all survive.

   > **Superseded:** Clear `--modal-content-height` at the top of `openModal` and inside `closeModal`, so a stale height from a previous panel cannot persist.
   > **Reason:** The panel only re-posts when its content **changes** — the observer does not fire on reopen and the reporter de-duplicates on `lastSent`. Clearing on open therefore drops the height on the first close and never gets it back: the modal is correctly sized exactly once per page load, then reverts to 700px of dead space for every subsequent open. The stale-height concern is real, but it is a *cross-panel* concern, not a per-open one.
   > **Replaced with:** Key the reported height by **panel id** (`modalContentHeights: Map`) and have `openModal` *resolve* it — apply the stored value for the panel being opened, or clear the variable if that panel has none. One code path handles both "reopen memo" (re-applies) and "open a different modal panel that reports nothing" (falls back to the CSS default). `closeModal` needs no participation at all, because the host is hidden and `openModal` is authoritative on the way back in.

7. **Multiple modal panels.** Today only memo is modal, but the per-id keying above is what makes opening a *different* modal panel fall back to the fixed default rather than inheriting memo's height.
8. **A height can arrive while the modal is closed — that is the good case.** Modal frames are mounted at shell start (`renderManifest`, `shell.js:649-654`), so `memo.html` loads and posts its height long before the operator first clicks the icon. Attributing the message to `openModalId` would discard it; attributing it to the **sender frame** stores it, and the very first open is already correctly sized with no flash from 700px. `frames.set()` and `modalPanels.add()` both run before the frame is appended, so the lookup table is always populated before the frame can post.
9. **Applying before layout.** `offsetHeight - clientHeight` is `0 - 0` on a `display: none` subtree. `applyModalContentHeight` must therefore run **after** `modalHost.classList.add('is-open')`, or the border compensation silently evaluates to zero.
10. **Scrollbar-induced observer churn.** If the dialog is ever a hair short, a 6px scrollbar appears inside the frame, `documentElement`'s width changes, and the `ResizeObserver` fires again. The reported *height* is unchanged, so the `lastSent` de-duplication drops the post and the loop terminates. This guard is load-bearing, not an optimisation.
11. **At the cap.** Content ≥ 700px clamps to 700, and adding the 2px border exceeds `max-height: min(700px, 88%)`, so CSS clamps back to 700 and the frame scrolls a hairline. That is already the "content exceeds the cap" regime — correct, not a regression.
12. **Escape and `×` must keep working.** `wireModalFrameKeys` (`shell.js:98-108`) and the close button (`shell.js:44-54`) are untouched by this change and must be re-verified after it.
13. **Do not add a click-to-dismiss handler inside the memo document.** It would make an accidental click on the memo's own whitespace destroy an open capture session, and it papers over the sizing bug rather than fixing it. Removing the dead space is the fix; the backdrop then covers the area the operator aims at.
14. **No confirmation dialogs.** Per `CLAUDE.md` — closing the modal must remain immediate. The memo's own debounced autosave (`shell.js:84-86` documents that memo.js owns it) is what prevents data loss; do not add a second writer or a save-on-close prompt.
15. **`implementation.html:1600`** also declares a `#memo-textarea` in a different document. Out of scope.
16. **Standalone `/memo` and the VS Code host.** `window.parent === window` at the top-level `/memo` route → the reporter returns immediately. In the VS Code webview the parent is cross-origin, so `postMessage(msg, location.origin)` is not delivered; the `try/catch` covers any host that throws instead.
17. **`location.origin` as `targetOrigin` is load-bearing — never widen it to `'*'`.** The silent non-delivery in the VS Code webview is the *desired* behaviour: there is no shell and no modal there, and nothing should listen. Research confirms `'*'` (or `acquireVsCodeApi().postMessage()`) is what a webview needs to actually reach its parent — so "fixing" this call to `'*'` would start pumping memo height messages into the VS Code workbench's own message channel every animation frame of a textarea drag. The narrow `targetOrigin` is the guard, not an oversight.
18. **The border term is safe only because the border is an integer.** `#modal-dialog` is `border: 1px solid` (`shell.html:169`), so `offsetHeight - clientHeight` is exactly 2 with no rounding. Research flags 1px rounding error on **sub-pixel** borders — if the dialog's border ever becomes fractional (e.g. a hairline `0.5px` treatment), this arithmetic drifts and the frame gains or loses a pixel. Keep the border integral, or measure differently at that point.

## Dependencies

- `sess_none — no external session dependency.`
- **Intra-feature ordering (hard):** land *Memo Modal Close Button Overlaps The Workspace Dropdown* **first**. Both subtasks edit the `#modal-dialog` rule in `src/webview/shell.html`; run them in **one** agent stream (the project PRD's "one agent stream per provider file" contract — same-file parallel edits collide). The `--modal-close-*` tokens shown in the CSS below are that subtask's output and **must be preserved**, not replaced, by this one.

## Adversarial Synthesis

**Risk summary.** The headline risk is a fix that appears to work and does nothing — reporting a viewport-derived height would have the panel echo back the size it was just given, so the acceptance check ("dialog resizes") passes while the dead space survives; that is closed by measuring the root element's box rather than its scroll area, and by a verification step that compares two numbers instead of eyeballing. The second risk is state that outlives its panel: modal frames are never destroyed, so a height must be keyed per panel id and resolved on open, or the modal is correct once and wrong forever after. Remaining risks — hostile `postMessage`, observer churn during a textarea drag, a pre-font-swap short measurement — are handled by origin + sender verification with a numeric clamp, rAF coalescing with `lastSent` de-duplication, and `document.fonts.ready` respectively.

## Proposed Changes

### 1. `src/webview/shell.html` — content-driven height with a floor and a cap

**Context.** `#modal-dialog`, lines 165-177. The `--modal-close-*` tokens are added by the sibling subtask and are shown here as context that must survive.

**Logic.** Turn the fixed height into a defaulted custom property. A panel that never reports a height resolves to today's exact value, so this is behaviour-preserving for every modal panel that does not opt in.

**Implementation.**

```css
        #modal-dialog {
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            width: min(820px, 92%);
            /* Content-driven. --modal-content-height is set by shell.js from a
               `modalContentHeight` message posted by the panel inside the frame; a
               panel that posts nothing keeps the historical fixed 700px, so this is
               a no-op for every modal panel except ones that opt in.
               The floor stops a pre-font-swap measurement collapsing the dialog to
               a sliver; the cap keeps a long memo on screen and lets the frame
               scroll internally, exactly as it does today. */
            height: var(--modal-content-height, min(700px, 88%));
            min-height: min(320px, 88%);
            max-height: min(700px, 88%);
            background: var(--bg-elev);
            border: 1px solid var(--border);
            border-radius: 8px;
            box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
            overflow: hidden;
            display: flex;
            /* Owned by the sibling subtask (close-button corner reservation).
               Preserve — do not drop when editing the height lines above. */
            --modal-close-inset: 8px;
            --modal-close-size: 26px;
            --modal-close-reserve: calc(var(--modal-close-inset) * 2 + var(--modal-close-size));  /* 42px */
        }
```

**Edge cases.** The JS clamp below mirrors `320` / `700`; when the viewport is short the CSS percentages clamp further and CSS wins, which is correct.

### 2. `src/webview/shell.js` — store per panel, resolve on open, compensate for the border

**Context.** Module state at lines 24-27; `openModal` at 61-76; the `message` listener at 718-752.

**Logic.** Attribute each reported height to the frame that sent it, remember it per panel id, and let `openModal` be the single place that decides what the dialog's height is.

**Implementation.** Add beside the existing modal state (`shell.js:24-27`):

```js
    const modalContentHeights = new Map();   // modal panel id -> last reported content height (px)
```

Add two helpers next to `ensureModalHost`:

```js
    /** Which modal panel's frame sent this message. Attribution is by frame WINDOW
     *  identity, not by openModalId: modal frames are mounted at shell start, so a
     *  panel reports its height long before the operator first opens it — gating on
     *  openModalId would throw that away and make the first open flash at 700px.
     *  Doubles as sender authentication: a window that is not one of our modal
     *  frames cannot set a height at all. */
    function modalIdForSource(source) {
        if (!source) { return null; }
        for (const id of modalPanels) {
            const frame = frames.get(id);
            if (frame && frame.contentWindow === source) { return id; }
        }
        return null;
    }

    /** Resolve the dialog height for a panel: its reported height, or the CSS
     *  default if it has never reported one. Modal frames are never destroyed
     *  (openModal only unhides them), so this ONE call handles both "reopen the
     *  same panel" (re-apply) and "open a different panel that reports nothing"
     *  (fall back) — closeModal needs to do nothing.
     *  MUST run after the host has `is-open`: offsetHeight and clientHeight are
     *  both 0 on a display:none subtree, which would zero the border term below. */
    function applyModalContentHeight(id) {
        if (!modalDialog) { return; }
        const px = modalContentHeights.get(id);
        if (typeof px !== 'number') {
            modalDialog.style.removeProperty('--modal-content-height');
            return;
        }
        // shell.html:47 sets `* { box-sizing: border-box }`, so #modal-dialog's
        // height INCLUDES its 1px border while .modal-frame fills only the content
        // box. Handing over the raw content height leaves the frame 2px short and
        // the panel scrolling forever. Measured, not hardcoded — and safe to read
        // as a plain difference because the dialog is overflow:hidden, so no
        // scrollbar is folded into it.
        const chrome = Math.max(0, modalDialog.offsetHeight - modalDialog.clientHeight);
        modalDialog.style.setProperty('--modal-content-height', (px + chrome) + 'px');
    }
```

In `openModal` (line 61), insert the resolve immediately after the host is shown:

```js
        ensureModalHost();
        modalHost.classList.add('is-open');
        applyModalContentHeight(id);   // after is-open — see the note on that function
```

`closeModal` is unchanged.

Add the message arm beside the existing ones (`shell.js:718-752`):

```js
        } else if (data.type === 'modalContentHeight') {
            // Origin-checked, sender-verified and clamped. Unclamped, a frame could
            // size the dialog to anything; the clamp mirrors the CSS floor/cap so JS
            // and CSS cannot disagree about the bounds.
            if (event.origin !== location.origin) { return; }
            if (typeof data.height !== 'number' || !Number.isFinite(data.height)) { return; }
            const senderId = modalIdForSource(event.source);
            if (!senderId) { return; }
            const px = Math.max(320, Math.min(700, Math.ceil(data.height)));
            modalContentHeights.set(senderId, px);
            if (openModalId === senderId) { applyModalContentHeight(senderId); }
        }
```

**Edge cases.** The listener's existing `if (event.source === window) { return; }` guard (line 719) already excludes the shell's own posts. `frames.set()` / `modalPanels.add()` both run before the frame is appended (`shell.js:649-654`), so `modalIdForSource` is never asked about a frame it does not yet know.

### 3. `src/webview/memo.js` — report the document's natural height

**Context.** `memo.js` is a single IIFE; append this at the end of its body, after the Send-to-Planner wiring and before the closing `})();` at line 278.

**Logic.** Measure the root element's box (content-sized), coalesce posts to one per frame, and de-duplicate identical values.

**Implementation.**

```js
    /* Report our natural content height so the shell can size the modal dialog to
     * it. Without this the dialog is a fixed 700px and the ~190px below the button
     * row is opaque dead space: it belongs to THIS iframe, not to #modal-backdrop,
     * so a dismiss click there hits nothing.
     *
     * documentElement.getBoundingClientRect().height, NOT documentElement.scrollHeight:
     * for the ROOT element scrollHeight is the height of the scrolling area, which is
     * at least the viewport — inside a 700px iframe it reports 700 however short the
     * content is, so the panel would echo back the height it was just given and the
     * dead space would survive the "fix". The root element's BOX is height:auto and
     * content-sized (body is `margin: 0`, memo.html:56), so its rect is the true
     * content height and cannot feed back from what the shell applies.
     *
     * Observed on documentElement rather than the textarea so a manual
     * `resize: vertical` drag on .modal-textarea is picked up too. rAF-coalesced
     * because a drag fires the observer every frame, and de-duplicated on lastSent
     * so the width-only reflow of a scrollbar appearing cannot ping-pong with the
     * shell. */
    (function reportContentHeight() {
        if (window.parent === window) { return; }   // standalone /memo — no shell to tell
        let queued = false;
        let lastSent = -1;
        const post = () => {
            queued = false;
            const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
            if (h <= 0 || h === lastSent) { return; }
            lastSent = h;
            try {
                window.parent.postMessage({ type: 'modalContentHeight', height: h }, location.origin);
            } catch { /* cross-origin parent (VS Code webview host) — nothing listens */ }
        };
        const schedule = () => {
            if (queued) { return; }
            queued = true;
            requestAnimationFrame(post);
        };
        try {
            new ResizeObserver(schedule).observe(document.documentElement);
        } catch { /* no ResizeObserver — the two posts below still fire */ }
        // Fonts load with font-display: swap (memo.html:8-21), so the first
        // measurement can land pre-swap and short. The observer catches the reflow;
        // this also covers a host without ResizeObserver.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(schedule).catch(() => {});
        }
        schedule();
    })();
```

**Edge cases.** `location.origin` as `targetOrigin` means the message is delivered only to a same-origin parent — the shell — and is silently dropped by the VS Code webview host. Nothing in memo behaviour depends on a reply.

## Resolved Assumptions

Settled by web research 2026-08-13. Full report: `.switchboard/docs/layout_measurement_research.md`. **Authoritative — do not re-open these during implementation or review.**

1. **`documentElement.scrollHeight` is viewport-floored. CONFIRMED.** Normatively defined in CSSOM View as `max(viewport height, content height)`; returns **700** in a 700px iframe holding 510px of content, identically across Blink, Gecko and WebKit in standards mode. (In quirks mode `body` carries the behaviour instead.) This is the basis for the supersede in the Complexity Audit — the original measurement would have made the fix a permanent no-op.
2. **`documentElement.getBoundingClientRect().height` is the content height. CONFIRMED.** Returns the natural content height (510px) when `html` is `height: auto` with no flex/grid or `vh` stretch rules; `body { margin: 0 }` (`memo.html:56`) eliminates margin-collapsing distortion. The replacement measurement is correct as written.
3. **`ResizeObserver` on `documentElement` catches the drag. CONFIRMED.** Fires reliably on descendant vertical-textarea drags and on scrollbar toggles (both are content-box changes). rAF-coalescing the callback is the accepted mitigation for the non-fatal loop-notification warning — the plan already does this.
4. **Cross-origin `postMessage` no-ops silently. CONFIRMED.** HTML spec step 6 aborts delivery without throwing on a `targetOrigin` mismatch. VS Code webviews would require `'*'` or `acquireVsCodeApi().postMessage()` to actually receive — which this plan deliberately does not do (see Edge-Case 17).
5. **`window.parent === window` is safe. CONFIRMED.** Both `window.parent === window` and `window.top === window` are cross-origin whitelisted and non-throwing; `window.frameElement` throws a `SecurityError` `DOMException` across origins. The guard in `reportContentHeight` is the correct one — do not "improve" it to `frameElement`.
6. **`offsetHeight - clientHeight` equals the borders. CONFIRMED** for a `border-box`, `overflow: hidden` element with no scrollbars — subject to 1px rounding on *sub-pixel* borders, and returning 0 inside a `display: none` subtree (see Edge-Cases 9 and 18).

## Verification Plan

Manual, in the browser cockpit. Per session directive, no compilation step and no automated test run is part of this plan.

1. **The reported bug is gone.** Open the Memo modal in the browser cockpit. The dialog ends just below the Send to Planner button, with no large empty band. Click ~30px below the button row — the modal closes (that point is now backdrop).
2. **Measure it — this is the step that catches a no-op fix.** In devtools: `document.getElementById('modal-dialog').getBoundingClientRect().height`, and in the memo frame `document.documentElement.getBoundingClientRect().height`. They must differ by ~2px (the dialog's border), and the frame value must be well under 700 — if it reads ~700, the measurement property is wrong and the fix is doing nothing.
3. **No hairline scrollbar.** In the memo frame, assert `document.documentElement.scrollHeight === document.documentElement.clientHeight` — proves the border compensation landed.
4. **Textarea drag-resize follows.** Drag the textarea's resize handle down 200px. The dialog grows with it, smoothly, and stops at the 700px cap. Drag it back up; the dialog shrinks and stops at the 320px floor.
5. **Long content caps and scrolls.** Paste ~200 lines into the memo. The dialog clamps at `min(700px, 88%)` and the frame scrolls internally — no off-screen overflow, no page-level horizontal scroll.
6. **Short viewport.** Resize the browser to ~500px tall. The dialog uses the `88%` branch, stays fully on screen, and the buttons remain reachable.
7. **First open is already sized.** Hard-reload the cockpit and open Memo for the first time. It opens at content height with no visible flash from 700px (the frame reported its height at shell start).
8. **Reopen keeps the size — the regression the old design would have shipped.** Open Memo, close it, reopen it. It is content-sized on the second open too, not back at 700px. Repeat after dragging the textarea taller: the dragged height is restored on reopen.
9. **Cross-panel reset.** If a second `presentation: 'modal'` panel exists in the `/panels` manifest, open it after Memo and confirm it gets the fixed 700px default, not Memo's height. (Only `memo` is modal today — `headlessPanelHtml.ts:521` — so this is a no-op until a second one exists.)
10. **Escape, `×`, backdrop.** All three still dismiss immediately, with no confirm.
11. **Autosave survives.** Type a line, close via backdrop click, reopen. The text is still there — `closeModal` still performs no flush/save of its own (`shell.js:84-86`).
12. **Hostile / malformed height.** From the console, `postMessage({type:'modalContentHeight', height: 1e9})` from the top-level window is rejected (not a registered modal frame); from the memo frame it clamps to 700. `height: NaN`, `height: -5`, `height: '600'` and a missing `height` are all ignored without throwing.
13. **VS Code host unaffected.** Open the memo panel inside VS Code. It renders normally, no console error from the `postMessage`, no layout change.
14. **Standalone route.** Load `/memo` directly. The reporter returns at the `window.parent === window` guard; no console error, no layout change.

### Automated Tests

None added, and none run in this pass (session directive). Two existing source-text contracts sit next to this change and must not be broken by it:

- `src/test/shell-modal-panel-contract.test.js` — asserts `closeModal` never destroys the frame (this change adds nothing to `closeModal`), that `shell.js` sets no native `title`, and `shell.html`'s body markup shape.
- `src/test/memo-panel-style-contract.test.js` — asserts the memo token palette and the ids `memo.js` selects on; appending an IIFE to `memo.js` touches neither.

## Recommendation

Complexity 5 → **Send to Coder.** Land after the close-button subtask, in the same agent stream.
