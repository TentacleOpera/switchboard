# Kanban Automation Tab: DRAIN/WATCH Toggle Needs Real Tooltips

## Goal

Give the DRAIN/WATCH trigger-mode toggle in the Automation tab tooltips that actually explain the two modes, delivered through the panel's own tooltip overlay so they render consistently with every other control in the tab.

### Problem Analysis & Root Cause

`createTriggerModeToggle` builds a two-button segmented control (`src/webview/kanban.html:9344-9382`). Its entire explanatory surface is two native `title` attributes:

```js
const drainBtn = document.createElement('button');
drainBtn.textContent = 'DRAIN';
drainBtn.title = 'Drain: process current cards, then stop.';

const watchBtn = document.createElement('button');
watchBtn.textContent = 'WATCH';
watchBtn.title = 'Watch: fire on arrival, never auto-stop.';
```

Two separate problems make these effectively invisible:

**1. Wrong tooltip mechanism for this panel.** The Kanban webview has its own tooltip overlay — `#tooltip-overlay` (`kanban.html:3465`), styled at `:2045-2063` (`max-width: 320px`, `white-space: pre-line`, so it handles multi-line explanatory copy), driven by delegated `mouseover`/`mouseout` handlers that read `data-tooltip` (`kanban.html:4158-4174`). Every other control in the automation strip uses it: `#btn-autoban`, `#btn-remote-control`, `#btn-manager-pass`, `#pairProgrammingModeSelect`, `#btn-scan-folders` and roughly twenty more all carry `data-tooltip`. The DRAIN/WATCH toggle is the odd one out on `title`, so it behaves differently (long browser delay, native styling, truncation) in a panel where the user has learned that hovering gives an instant styled tooltip.

**2. The copy is too terse to answer the actual question.** "Drain: process current cards, then stop" does not tell the user that Watch dispatches **every arriving plan immediately and unattended**, that it **never auto-stops**, or that each dispatch spends an agent's tokens. That information exists in the panel — as a warning banner rendered *only when a column is already set to Watch* (`kanban.html:9590-9593`) — which is backwards: the explanation appears after the risky choice is made, not while the user is deciding.

The toggle is also rendered in several places from the same factory (`kanban.html:9564` for the single-column config and `:10288`-region call sites for per-column rules), so fixing the factory fixes every instance.

**Root cause:** the control was built with native `title` attributes and one-line copy, in a panel that had already standardised on a custom `data-tooltip` overlay with room for real explanatory text. Nothing routes the existing Watch-mode warning copy into a hover affordance.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, ux
- **Project:** Browser Switchboard
- **Files touched:** `src/webview/kanban.html`
- **Risk:** Very low — attribute and copy change inside one factory function. No automation behaviour, config, or persistence is touched.

## User Review Required

None. The needed content already exists as the Watch warning banner; this puts a condensed form of it where the user hovers.

## Complexity Audit

### Routine
- Swap `title` for `data-tooltip` on both buttons in `createTriggerModeToggle`.
- Write substantive multi-line copy for each mode.
- Add a `data-tooltip` on the wrapper so hovering the seam between buttons still explains the control.

### Complex / Risky
- **`updateStyles` rewrites `style.cssText` wholesale** on every mode change (`kanban.html:9356-9364`). It does not touch attributes, so `data-tooltip` survives — but any future move of the tooltip into an inline style would break. Set the attributes once at construction, outside `updateStyles`.
- **The delegated handler is document-level**, bound once (`kanban.html:4158`), so dynamically created buttons work without re-binding — but `mouseout` bails when `e.relatedTarget` is contained by the target (`kanban.html:4167-4173`). With a `data-tooltip` on both the wrapper *and* its children, moving between DRAIN and WATCH transitions wrapper→child and child→child; the handler's `if (el === tooltipTarget) return;` plus `hideTooltip()` sequence must be checked to confirm the tooltip actually swaps rather than sticking on the wrapper's text.
- **The autoban panel re-renders on a timer**, guarded by `isAutobanPanelInteracting` (`kanban.html:9246-9262`). A re-render mid-hover destroys the hovered element, leaving `tooltipTarget` pointing at a detached node and the overlay visible with stale text. Hover is not one of the guarded events (`focus`/`change`/`input`), so this is worth verifying — and is cheap to fix by clearing the overlay when the panel re-renders.

## Edge-Case & Dependency Audit

1. **Tooltip on both wrapper and buttons.** Simplest correct arrangement: `data-tooltip` on each button only, and none on the wrapper — the wrapper is 18px tall with the two buttons filling it, so there is no meaningful dead zone, and a wrapper tooltip introduces the child↔parent swap problem above. **Decision: buttons only.**
2. **Overlay width.** `max-width: 320px` with `white-space: pre-line` (`kanban.html:2052-2056`) means `\n` in the string produces real line breaks. Use explicit newlines rather than relying on wrapping.
3. **Viewport clamping.** `showTooltip` prefers above, flips below when clipped, and clamps horizontally (`kanban.html:4134-4145`). The toggle sits inside a scrollable automation panel, so a tooltip near the panel's top edge flips down — verify both positions.
4. **Stale overlay on re-render.** `renderAutobanPanel` should call `hideTooltip()` at entry so a re-render cannot leave the overlay pinned with text for a destroyed button.
5. **Native `title` must be removed, not merely supplemented.** Leaving both produces two tooltips (the styled overlay plus the browser's own after its delay).
6. **Multiple instances.** The factory is called for the single-column config and once per column rule; all instances get the fix from one edit. Confirm the per-column instances too.
7. **Copy must not contradict the banner.** The banner (`kanban.html:9592`) is the authoritative long-form text; the tooltip is its condensation. Keep the same facts: Watch = fires on arrival, immediately, unattended, no batch delay, no review step, never auto-stops, costs one agent run per arrival; Drain = the default, finite batch, stops when the source column is empty.
8. **Accessibility.** `data-tooltip` is not read by screen readers. Add `aria-label` with the same short summary so the information is not hover-only.

## Dependencies

None — no prior session (`sess_…`) dependencies. All referenced infrastructure (`#tooltip-overlay`, the delegated `mouseover`/`mouseout` handlers, `hideTooltip`, `createTriggerModeToggle`) already exists in `src/webview/kanban.html`.

## Adversarial Synthesis

Key risks: a stale tooltip overlay left pinned after a timer-driven panel re-render, tooltip copy drifting from the Watch warning banner's facts, and the child↔child hover swap sticking. Mitigations: call `hideTooltip()` at the top of `renderAutobanPanel`, keep the copy a strict condensation of the banner, set `data-tooltip` once at construction (never inside `updateStyles`), and UAT the DRAIN→WATCH pointer swap. No design-level risk — the panel's own tooltip mechanism is reused verbatim.

## Proposed Changes

### `src/webview/kanban.html`

Replace the button construction inside `createTriggerModeToggle` (lines 9348-9354):

```js
const drainBtn = document.createElement('button');
drainBtn.textContent = 'DRAIN';
// data-tooltip, not title: this panel routes every other control through the
// #tooltip-overlay (delegated mouseover, max-width 320px, white-space:pre-line),
// so a native title here rendered late, unstyled, and inconsistently. Set once
// at construction — updateStyles() rewrites style.cssText wholesale.
drainBtn.setAttribute('data-tooltip',
    'DRAIN (default) — finite batch.\n'
    + 'Processes the cards that are in the source column now, then stops on its own '
    + 'when the column empties. Use this for an overnight run or any batch that '
    + 'should finish and stay finished.');
drainBtn.setAttribute('aria-label', 'Drain mode: process the current cards, then stop automatically');

const watchBtn = document.createElement('button');
watchBtn.textContent = 'WATCH';
// Condensed from the Watch warning banner below (which only appears AFTER a
// column is already set to Watch). Same facts, shown while deciding.
watchBtn.setAttribute('data-tooltip',
    'WATCH — runs agents automatically, forever.\n'
    + 'Every plan that lands in this column is dispatched to its agent immediately '
    + 'and unattended: no batch delay, no review step. Each dispatch is a real agent '
    + 'run that spends that agent\'s tokens. While any column is on Watch the engine '
    + 'will not auto-stop when the board empties — you stop it manually.\n'
    + 'Use for entry columns (CREATED) or remote-control hand-offs. Idling is free; '
    + 'the cost is one agent run per arrival.');
watchBtn.setAttribute('aria-label',
    'Watch mode: dispatch each arriving plan immediately and never auto-stop');
```

And clear any live tooltip when the panel re-renders — add at the top of `renderAutobanPanel`:

```js
// A timer-driven re-render destroys the hovered element; without this the
// overlay stays visible with text for a node that no longer exists.
hideTooltip();
```

## Verification Plan

1. **Automated tests:** Skipped per session directive — no compilation step and no automated test run in this pass. Verification is the static checks and UAT below.
2. **Static check:** `grep -n "drainBtn.title\|watchBtn.title" src/webview/kanban.html` returns nothing; `grep -n "data-tooltip" src/webview/kanban.html` includes the two new sets.
3. **UAT — hover DRAIN.** Kanban → AUTOMATION tab → single-column mode. Hover DRAIN: the styled overlay appears immediately (not after a browser delay), on two-plus lines, explaining the finite batch and the auto-stop.
4. **UAT — hover WATCH.** Hover WATCH: the overlay explains immediate unattended dispatch, per-arrival token cost, and that the engine never auto-stops. Text is fully readable, clamped to 320px, not truncated.
5. **UAT — swap.** Move the pointer directly from DRAIN to WATCH: the tooltip content swaps rather than sticking or disappearing.
6. **UAT — per-column instances.** Switch to multi-column mode and hover the DRAIN/WATCH toggle on a column rule row: same tooltips.
7. **UAT — positioning.** Scroll the automation panel so the toggle is near the top of the viewport and hover: the tooltip flips below instead of being clipped. Then scroll it near the right edge and confirm horizontal clamping.
8. **UAT — no stale overlay.** Hover a toggle and hold still for at least one automation-panel refresh cycle (~10s): the overlay must not be left showing text for a destroyed element, and no duplicate overlay appears.
9. **UAT — behaviour untouched.** Click DRAIN then WATCH: the active-button styling still updates and the mode still persists (reload the panel and confirm the selection stuck).

## Review Findings

**Files reviewed:** `src/webview/kanban.html` (createTriggerModeToggle L9384-9442, renderAutobanPanel L10807-10823, tooltip overlay handlers L4150-4173).

**Stage 1 (Grumpy):** Welcome, mortals. I see you've finally decided to explain your own toggle. Let's see if you did it right.
- ✅ `title` attributes gone, `data-tooltip` + `aria-label` set once at construction — not inside `updateStyles`. Good.
- ✅ `hideTooltip()` at top of `renderAutobanPanel` (L10813) — stale overlay on re-render: handled.
- ✅ Copy is a faithful condensation of the Watch warning banner facts.
- NIT: No wrapper `data-tooltip` — correct per plan's "buttons only" decision, but the wrapper's 18px height with overflow:hidden means a 1px seam between buttons has no tooltip. Acceptable — the seam is sub-pixel in practice.

**Stage 2 (Balanced):** All findings are clean or NIT-level. No CRITICAL or MAJOR issues. The implementation matches the plan exactly: `data-tooltip` on buttons only, `aria-label` for accessibility, `hideTooltip()` on panel re-render, attributes set outside `updateStyles`. The delegated mouseover/mouseout handlers correctly swap tooltips on DRAIN→WATCH transitions (siblings, not parent-child, so `el.contains(related)` is false and `hideTooltip()` fires).

**Verification:** `npm run compile` — 0 errors (4 pre-existing warnings). `npm run lint` — 0 errors. `npm run parity:check`, `push-routing:check`, `verb-returns:check` — all pass. Static grep confirms no `drainBtn.title`/`watchBtn.title` remaining. Kanban contract tests (drag-guard, render-guard, drag-confirm-order) all pass. 3 pre-existing failures in kanban-auto-export.test.js are unrelated (agent name resolution in markdown export, not automation tab UI).

**Gate-wiring audit:** No plan-specific automated checks named. PRD gates (verb-returns, parity, push-routing) wired in `.github/workflows/integration-tests.yml` L35-41 — all pass.

**Remaining risks:** None material. UAT-only verification items (hover swap, positioning, per-column instances) cannot be verified statically.

## Completion Report

Reviewed the DRAIN/WATCH tooltip implementation in `src/webview/kanban.html`. The `data-tooltip` and `aria-label` attributes are correctly set on both buttons at construction (outside `updateStyles`), `hideTooltip()` is called at the top of `renderAutobanPanel`, and native `title` attributes are fully removed. Compilation, lint, parity, push-routing, and verb-returns checks all pass. No code fixes were needed — the implementation matches the plan exactly.
