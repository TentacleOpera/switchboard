# Clear Inspect-Mode Tweak Input on Copy Prompt / Send to Agent

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, ux, bugfix

## Goal

When a user composes an element-tweak instruction in an Inspect Mode tweak popup and then presses **Copy Prompt** or **Send to Agent**, the textarea should clear and the popup should close (mirroring the existing ✕ close-button cleanup), while **Inspect Mode itself stays active** so the user can immediately select another element and tweak it.

### Problem

Today the send/copy handlers in `design.js` and `planning.js` compose the prompt and call `vscode.postMessage(...)`, then leave the textarea populated and the popup open. The user has to manually clear the text and close the popup before tweaking the next element. The ✕ close button already does the right cleanup (hide popup, clear input, reset `selectedElement`), but the action buttons don't, so the UX is inconsistent: the user dispatches a tweak and the stale instruction text just sits there.

### Root cause

The send/copy click handlers were written to dispatch and stop — they never acquired the "reset after dispatch" step that the close handler has. Inspect Mode toggle is a separate control (`*-btn-inspect` / `sbInspectToggle` postMessage into the preview iframe) and is not touched by the close handler, so mirroring the close cleanup will not exit Inspect Mode.

## User Review Required

No review required beyond confirming the desired UX (clear + close on dispatch, Inspect Mode stays on). The change is mechanical and mirrors an existing, shipped cleanup pattern.

## Complexity Audit

### Routine
- Appending a 3-line cleanup block after an existing `vscode.postMessage(...)` call in six handlers.
- Mirrors the exact cleanup already shipped in the three ✕ close handlers (`stitch-tweak-btn-close`, `html-tweak-btn-close`, `planning-html-tweak-btn-close`).
- No new APIs, no new state, no backend message-type changes.
- Line numbers verified against current source (see Proposed Changes).

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `postMessage` is fire-and-forget/synchronous from the webview's perspective; cleanup runs strictly after dispatch, so the prompt is already composed and sent before the textarea is cleared. No async gap.
- **Security:** None. No new data flows; the dispatched prompt content is unchanged.
- **Side Effects:** The only side effect is the intended UI-state reset (textarea cleared, popup hidden, `selectedElement` nulled). Inspect Mode toggle state is untouched.
- **Dependencies & Conflicts:** None. No shared CSS, no shared helpers modified. The `compose*TweakPrompt()` helpers and the empty-instruction early-return guards are untouched.

## Dependencies

- None

## Adversarial Synthesis

Key risks: stale `inputEl` reference reuse (safe — resolved at handler top), potential double-dispatch (impossible — cleanup is post-dispatch), and accidental Inspect Mode exit (impossible — toggle is a separate control). Mitigations: all three are verified against the actual close-handler pattern already shipped in the same files.

## Proposed Changes

### `src/webview/design.js` — Stitch HTML tab (`stitch-tweak-popup`)

- **Context:** The Stitch tweak popup's send/copy handlers dispatch the composed prompt but leave the textarea populated and popup open. The close handler (`stitch-tweak-btn-close`, L4625-4631) already does the desired cleanup.
- **Logic:** Append the cleanup block immediately after each `vscode.postMessage(...)` call, before the handler's closing `});`.
- **Implementation:**
  1. **`stitch-tweak-btn-send`** (L4657-4679): after the `vscode.postMessage({ type: 'sendStitchTweakPrompt', ... })` block (ends L4678), append:
     ```js
     inputEl.value = '';
     const popup = document.getElementById('stitch-tweak-popup');
     if (popup) popup.style.display = 'none';
     state.stitchSelectedElement = null;
     ```
  2. **`stitch-tweak-btn-copy`** (L4681-4702): after the `vscode.postMessage({ type: 'copyStitchTweakPrompt', ... })` block (ends L4701), append the same cleanup block (popup id `stitch-tweak-popup`, state key `state.stitchSelectedElement`).
- **Edge Cases:** `inputEl` is resolved at the handler top (L4661 / L4685) and is non-null on the success path (the empty guard returns early otherwise), so reusing it is safe. The popup/state lookups use the same `getElementById` + null-guard pattern as the close handler.

### `src/webview/design.js` — HTML Previews tab (`html-tweak-popup`)

- **Context:** Same pattern as Stitch. Close handler `html-tweak-btn-close` (L4716-4722) already does cleanup.
- **Implementation:**
  1. **`html-tweak-btn-send`** (L4748-4770): after `vscode.postMessage({ type: 'sendHtmlTweakPrompt', ... })` (ends L4769), append:
     ```js
     inputEl.value = '';
     const popup = document.getElementById('html-tweak-popup');
     if (popup) popup.style.display = 'none';
     state.htmlSelectedElement = null;
     ```
  2. **`html-tweak-btn-copy`** (L4772-4793): after `vscode.postMessage({ type: 'copyHtmlTweakPrompt', ... })` (ends L4792), append the same block (popup id `html-tweak-popup`, state key `state.htmlSelectedElement`).
- **Edge Cases:** Same as Stitch — `inputEl` resolved at handler top (L4752 / L4776), non-null on success path.

### `src/webview/planning.js` — HTML tab (`planning-html-tweak-popup`)

- **Context:** Same pattern. Close handler `planning-html-tweak-btn-close` (L8289-8295) already does cleanup.
- **Implementation:**
  1. **`planning-html-tweak-btn-send`** (L8321-8343): after `vscode.postMessage({ type: 'sendHtmlTweakPrompt', ... })` (ends L8342), append:
     ```js
     inputEl.value = '';
     const popup = document.getElementById('planning-html-tweak-popup');
     if (popup) popup.style.display = 'none';
     state.htmlSelectedElement = null;
     ```
  2. **`planning-html-tweak-btn-copy`** (L8345-8366): after `vscode.postMessage({ type: 'copyHtmlTweakPrompt', ... })` (ends L8365), append the same block (popup id `planning-html-tweak-popup`, state key `state.htmlSelectedElement`).
- **Edge Cases:** Same — `inputEl` resolved at handler top (L8325 / L8349), non-null on success path.

### What does NOT change

- The empty-instruction early-return branches are untouched — there is nothing to clear when the user never typed anything.
- The `compose*TweakPrompt()` helpers are untouched.
- The ✕ close handlers are untouched (they already do this cleanup).
- Inspect Mode toggle (`*-btn-inspect`, `sbInspectToggle` postMessage to the preview iframe) is untouched — the user remains in inspect mode and can select another element immediately.
- The `*-tweak-status` status element is untouched on the success path (it's already hidden at the top of each handler; the early-return path is the only place it's shown).

## Verification Plan

### Automated Tests
- None (manual UI verification; no test harness for webview popups).

### Manual Verification
1. Open the Design panel → Stitch HTML tab → toggle Inspect Mode → select an element → type a tweak → press **Send to Agent**. Confirm: textarea clears, popup closes, Inspect Mode stays active (crosshair cursor remains, hovering still highlights elements), and selecting a new element opens a fresh empty popup.
2. Repeat with **Copy Prompt** in the same popup.
3. Repeat both actions in the Design panel → HTML Previews tab (`html-tweak-popup`).
4. Repeat both actions in the Planning panel → HTML Previews tab (`planning-html-tweak-popup`).
5. Confirm the empty-instruction guard still fires: open a tweak popup, leave the textarea empty, press Send/Copy — the "Please describe the change first." status still appears and nothing is cleared (there was nothing to clear).
6. Confirm the ✕ close button still behaves as before.

## Recommendation

Send to Intern (complexity 2 — mechanical, mirrors shipped pattern, single-pass append across six handlers).

## Completion Summary

Implemented the post-dispatch cleanup in all six tweak send/copy handlers. After each `vscode.postMessage(...)` call, appended a 4-line block that clears the textarea (`inputEl.value = ''`), hides the popup (`getElementById(...).style.display = 'none'` with null guard), and nulls the corresponding `state.*SelectedElement`. Files changed: `src/webview/design.js` (stitch-tweak-btn-send L4674-4682, stitch-tweak-btn-copy L4702-4709, html-tweak-btn-send L4773-4781, html-tweak-btn-copy L4801-4808) and `src/webview/planning.js` (planning-html-tweak-btn-send L8338-8346, planning-html-tweak-btn-copy L8366-8373). The cleanup mirrors the existing ✕ close-handler pattern exactly; Inspect Mode toggle and empty-instruction early-return guards are untouched. No issues encountered.
