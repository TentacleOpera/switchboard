# Copy-prompt button "copied" feedback fires late and flashes green instead of a subtle press

## Goal

### Problem

When the user clicks the per-card "Copy Prompt" button on a kanban card, two things go wrong:

1. **Timing:** The "copied" visual feedback fires ~1 second after the click — when the backend's `copyPlanLinkResult` message arrives and the card has already moved to the next column — instead of firing immediately on click.
2. **Styling:** The "copied" state is a flashing green background with white "Copied!" text (the `copyFlash` animation), and the button's text content changes from "Copy Prompt" to "Copied!". The user expects no wording change at all — just a subtle press effect.

### Root Cause

**Timing:** The "copied" feedback is applied in the `copyPlanLinkResult` message handler (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="10026-10060" />), which fires when the backend responds to the `promptSelected` message. The click handler `runCopyPrompt` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="8258-8339" />) does optimistically move the card and highlight the target column, but it does NOT apply any "copied" visual to the button itself. The button feedback is entirely backend-gated, so it arrives ~1 second late — coinciding with the card's arrival in the target column, which the user perceives as "fires when the card moves."

**Styling:** The `copyPlanLinkResult` handler sets `btn.textContent = 'Copied!'` (line 10036) and adds the `copied` class (line 10037), which triggers the `copyFlash` keyframe animation (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="1163-1171" />):

```css
@keyframes copyFlash {
    0% { background-color: var(--vscode-testing-iconPassed, #73c991); color: #ffffff; }
    70% { background-color: var(--vscode-testing-iconPassed, #73c991); color: #ffffff; }
    100% { background-color: transparent; color: var(--text-secondary); }
}
.card-btn.copy.copied {
    animation: copyFlash 1.5s ease-out forwards;
}
```

This is a 1.5-second green flash with a text change — exactly what the user does not want.

### The fix

1. **Fire the press feedback on click, not on backend response.** Add the visual feedback class in `runCopyPrompt` itself, immediately, before posting the `promptSelected` message.
2. **Replace the green flash with a subtle press.** Replace the `copyFlash` animation with a brief, subtle scale-down + background tint that resolves in ~300ms — no text change, no green, no "Copied!" wording.
3. **Remove the text-content change from `copyPlanLinkResult`.** The handler should no longer set `btn.textContent = 'Copied!'` or restore it. The button text stays as-is throughout.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## User Review Required

The visual parameters of the press effect should be confirmed by the user after implementation:
- **300ms duration** — too fast, too slow, or right?
- **Scale-down to 94%** — subtle enough, or too much/little?
- **Background tint at 18% opacity** (`var(--text-secondary)`) — visible enough, or too faint?
- **No "Copied!" text** — the user explicitly requested no wording change, so this is confirmed.

## Complexity Audit

### Routine
- Single-file CSS/JS change (`src/webview/kanban.html`) plus a one-regex update in the test file (`src/test/kanban-card-button-drag-guard.test.js`).
- The CSS animation replacement is a self-contained style block swap.
- The `runCopyPrompt` function already runs synchronously on click — adding a class toggle is a few lines.
- The `copyPlanLinkResult` handler's text-change logic is removed, simplifying it.
- The test file update is a mechanical regex swap (`.copied` → `.pressed`).

### Complex / Risky
- **`copyPlanLinkResult` still needs to exist.** The backend response confirms the clipboard write succeeded. If the copy fails (`msg.success === false`), the handler should still reset the button (remove any stuck press class). But it must not change the text content.
- **`animationend` listener cleanup.** The current `copyPlanLinkResult` handler attaches an `animationend` listener and a 2s fallback timer to reset the button. With the new approach, the press animation is fired on click and self-resets via its own `animationend` — the `copyPlanLinkResult` handler no longer needs this cleanup machinery.
- **`prefers-reduced-motion`.** The current code has a fallback timer for when `animationend` never fires (reduced motion). The new animation must also handle this — a CSS transition with a setTimeout fallback, or an animation with a fallback timer in `runCopyPrompt`. Additionally, the new `.card-btn.copy.pressed` rule should be added to the existing `@media (prefers-reduced-motion: reduce)` block (line 1107) to disable the animation for users who request reduced motion.

## Edge-Case & Dependency Audit

- **`dispatchFailedPromptReady` handler.** A separate handler (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="10062-10081" />) adds a `prompt-ready` class (orange glow) to the copy button when dispatch fails. This is independent of the `pressed` class and must not be affected.

  > **Superseded:** The press effect and the prompt-ready glow can coexist on the same button — they use different CSS classes and animations.
  > **Reason:** Both `.card-btn.copy.pressed` and `.card-btn.copy.prompt-ready` set the `animation` CSS shorthand property. CSS does not merge shorthand declarations from different matching rules — only the last-defined rule's `animation` value applies. If both classes were on the same element simultaneously, only one animation would run (the `prompt-ready` rule, defined later in the stylesheet, would win). They cannot visually coexist via CSS.
  > **Replaced with:** The press effect and the prompt-ready glow do NOT coexist on the same element at the same time — not because of CSS, but because of the event flow. The `dispatchFailedPromptReady` handler attaches a `pointerdown` listener (`removeGlow`, line 10070, `{ once: true }`) that removes `prompt-ready` before the user's click completes. Since `runCopyPrompt` is called from the `pointerup` handler (line 8377), `prompt-ready` is already gone by the time `pressed` is added. The two classes are never on the element simultaneously. This is an event-ordering guarantee, not a CSS property.

- **`copyLabel` dataset.** The button stores its original label in `data-copy-label` (set at render time, line 8560). The current `copyPlanLinkResult` handler restores text from `btn.dataset.copyLabel`. After the fix, this restore is unnecessary because the text never changes — but the `data-copy-label` attribute should remain for any other code that reads it.
- **`pointerdown` / `pointerup` pattern.** The copy button uses a pointer-capture pattern (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="8341-8385" />) to distinguish a click from a drag. `runCopyPrompt` is called from the `pointerup` handler (line 8377) only when the pointer is still within the button's bounds. The press feedback should be applied inside `runCopyPrompt`, not on `pointerdown`, so it fires only on a confirmed click.
- **Card re-render after backend response.** After the backend processes `promptSelected`, a board refresh may re-render the card and replace the button element entirely. If the press animation is still running at that point, the old button element (with the press class) is discarded and the new button renders clean — which is the correct behaviour. No stale-class risk.
- **Existing test file.** `src/test/kanban-card-button-drag-guard.test.js` Assertion 7 (lines 57-64) checks for the existence of the `.card-btn.copy.copied` CSS rule and verifies it does not set `pointer-events: none`. Removing the `.copied` rule and replacing it with `.pressed` will break this assertion. The test must be updated to check `.card-btn.copy.pressed` instead. See Proposed Changes §4.
- **No confirm gate.** Per `CLAUDE.md`, no confirmation dialogs. (Not relevant here — this is a visual feedback change, not a confirm gate.)

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the existing test `kanban-card-button-drag-guard.test.js` Assertion 7 will break because it expects the `.copied` CSS rule — the test must be updated to check `.pressed` instead; (2) the `copyPress` keyframe should use `background-color` (not the `background` shorthand) to match the existing `copyFlash` pattern and avoid clobbering the `.card-btn:hover` background during the animation; (3) the `prefers-reduced-motion` media query at line 1107 should include `.card-btn.copy.pressed { animation: none; }` so the press animation is suppressed for users who request reduced motion. Mitigations: update the test regex, use `background-color` in the keyframe, and add the reduced-motion rule.

## Proposed Changes

### 1. `src/webview/kanban.html` — replace the `copyFlash` animation with a subtle press

Replace the CSS at lines 1163-1171:

```css
/* Card Copy Button — subtle press feedback (fires on click, no wording change) */
@keyframes copyPress {
    0% { transform: scale(1); background-color: transparent; }
    30% { transform: scale(0.94); background-color: color-mix(in srgb, var(--text-secondary) 18%, transparent); }
    100% { transform: scale(1); background-color: transparent; }
}
.card-btn.copy.pressed {
    animation: copyPress 0.3s ease-out forwards;
}
```

This is a 300ms scale-down to 94% with a subtle background tint — no green, no text change, no "Copied!" wording. The `forwards` fill mode keeps the final state (scale 1, transparent) until the class is removed.

> **Superseded:** The original proposal used `background: transparent` and `background: color-mix(...)` (the `background` shorthand) in the `copyPress` keyframe.
> **Reason:** The `background` shorthand resets ALL background properties (including `background-image`, `background-size`, etc.) to their initial values. The existing `.card-btn:hover` rule (line 1137) also uses the `background` shorthand to set a hover tint. During the 300ms animation, the keyframe's `background` shorthand would override the hover state entirely. The existing `copyFlash` animation uses `background-color` (not the shorthand), which is more precise — it only animates the color property and leaves other background properties untouched.
> **Replaced with:** Use `background-color` in the `copyPress` keyframe, consistent with the existing `copyFlash` pattern. This avoids clobbering the hover background's non-color properties (if any are added in the future) and follows the codebase's established convention.

### 2. `src/webview/kanban.html` — fire the press feedback in `runCopyPrompt`

At the top of `runCopyPrompt` (line 8258), immediately apply the press class and set up a cleanup:

```javascript
function runCopyPrompt(btn) {
    // Subtle press feedback — fires on click, not on backend response.
    // No wording change: the button text stays as-is throughout.
    btn.classList.remove('pressed');
    void btn.offsetWidth; // Force reflow so re-clicking restarts the animation.
    btn.classList.add('pressed');
    const removePress = () => {
        btn.classList.remove('pressed');
        btn.removeEventListener('animationend', onAnimEnd);
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };
    const onAnimEnd = () => { pressTimer = null; removePress(); };
    let pressTimer = setTimeout(removePress, 400); // Fallback for prefers-reduced-motion.
    btn.addEventListener('animationend', onAnimEnd);

    const sessionId = btn.dataset.planId || btn.dataset.session || '';
    // ... rest of runCopyPrompt unchanged ...
```

### 3. `src/webview/kanban.html` — remove text change and `copied` class from `copyPlanLinkResult`

Simplify the `copyPlanLinkResult` handler (lines 10026-10060). Remove the `textContent` change, the `copied` class, the `animationend` listener, and the fallback timer. Keep only the failure-reset path:

```javascript
case 'copyPlanLinkResult': {
    let btn = null;
    if (msg.planId) {
        btn = document.querySelector(`.card-btn.copy[data-plan-id="${CSS.escape(msg.planId)}"]`);
    }
    if (!btn && msg.sessionId) {
        btn = document.querySelector(`.card-btn.copy[data-plan-id="${CSS.escape(msg.sessionId)}"]`) || document.querySelector(`.card-btn.copy[data-session="${CSS.escape(msg.sessionId)}"]`);
    }
    if (btn && !msg.success) {
        // Copy failed — ensure no stuck press state.
        btn.classList.remove('pressed');
    }
    break;
}
```

The success path does nothing — the press animation was already fired on click and self-resolves. The button text was never changed, so there is nothing to restore.

### 4. `src/webview/kanban.html` — add `pressed` to the `prefers-reduced-motion` media query

Add `.card-btn.copy.pressed` to the existing `@media (prefers-reduced-motion: reduce)` block at lines 1107-1112:

```css
@media (prefers-reduced-motion: reduce) {
    .kanban-card.card-op-completed { animation: none; }
    .teams-flow-node { opacity: 1; animation: none; }
    .teams-flow-edge { stroke-dashoffset: 0; animation: none; }
    .teams-flow-pulse { animation: none; opacity: 0.5; }
    .card-btn.copy.pressed { animation: none; }
}
```

This suppresses the press animation for users who have requested reduced motion. The 400ms fallback timer in `runCopyPrompt` still cleans up the `pressed` class — the button simply shows no visual effect, which is correct for reduced-motion mode.

### 5. `src/test/kanban-card-button-drag-guard.test.js` — update Assertion 7 for `.pressed` class

Assertion 7 (lines 57-64) currently checks for the `.card-btn.copy.copied` CSS rule. Since the `.copied` rule is replaced by `.card-btn.copy.pressed`, update the assertion to match:

```javascript
// Assertion 7: .card-btn.copy.pressed does NOT have pointer-events: none
const pressedRuleMatch = kanbanHtml.match(/\.card-btn\.copy\.pressed\s*\{([^}]+)\}/);
assert.strictEqual(pressedRuleMatch !== null, true, '.card-btn.copy.pressed rule must exist');
assert.strictEqual(
    pressedRuleMatch[1].includes('pointer-events: none'),
    false,
    '.card-btn.copy.pressed must not disable pointer events'
);
```

Assertion 7b (lines 66-81) and Assertion 8 (lines 83-105) do NOT need changes — the `copyPlanLinkResult` handler still exists (it still has `case 'copyPlanLinkResult':`), and the `KanbanProvider.ts` backend flow is unchanged.

## Verification Plan

### Manual Testing
1. Click "Copy Prompt" on a kanban card.
2. **Expected (timing):** The button immediately shows a subtle press effect (slight scale-down + faint background tint) on click — before the card moves.
3. **Expected (styling):** No green flash, no "Copied!" text, no wording change. The button text stays "Copy Prompt" (or "Copy coder prompt", etc.) throughout.
4. **Expected (duration):** The press effect resolves in ~300ms. The button returns to its normal appearance.
5. **Card still moves:** The card should still advance to the next column optimistically (this behaviour is unchanged).
6. **Copy failure:** If the backend reports failure, the press class is cleaned up — no stuck state.
7. **Reduced motion:** With `prefers-reduced-motion: reduce` enabled, no press animation plays. The button functions normally (copy still works).

### Automated Tests
- **Press fires on click, not on backend response.** Assert that after calling `runCopyPrompt(btn)`, `btn.classList.contains('pressed')` is true — before any `copyPlanLinkResult` message is dispatched.
- **No text content change.** Assert that `btn.textContent` is unchanged after `runCopyPrompt` and after `copyPlanLinkResult` with `success: true`.
- **`copied` class is never added.** Assert that the `copied` class is not present on the button at any point in the flow.
- **Press self-resolves.** After 400ms (or `animationend`), assert `btn.classList.contains('pressed')` is false.
- **Existing test suite.** Run `src/test/kanban-card-button-drag-guard.test.js` — all assertions (including the updated Assertion 7) must pass.

---

**Recommendation:** Send to Intern (complexity 2 — routine single-file CSS/JS change plus a mechanical test-file regex update).
