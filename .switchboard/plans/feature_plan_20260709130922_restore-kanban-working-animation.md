# Restore the "agent working" pulse animation on kanban cards

## Goal

The kanban board has an activity-light indicator on each card that lights up while a coder/agent is actively working on that card (i.e. the card has been dispatched and `dispatched_at` is within the timeout window). The user reports this indicator is "totally broken" and "no longer shows."

### Problem analysis & root cause

The data layer that drives the indicator is **intact and functional**:

- `KanbanDatabase.updateDispatchInfoByPlanFile` writes `dispatched_at = now` on dispatch (`src/services/KanbanDatabase.ts:7533`).
- `KanbanProvider` derives `working: isWorkingState(row.dispatchedAt)` for each card (`src/services/KanbanProvider.ts:1646`, `:3221`, `:3416`), where `isWorkingState` returns `true` when `dispatched_at` is set and younger than the configured timeout (default 10 min) (`src/services/KanbanProvider.ts:133-139`).
- The webview renders `const isWorking = !isCompleted && card.working;` and applies the `is-working` class (`src/webview/kanban.html:6007-6008`).

The breakage is purely **visual/CSS**. Commit `e655700` ("Agent-protocol fixes + Remote-Control/Headless feature reorg", 2026-07-08) rewrote the `.kanban-card.is-working::after` rule. Before that commit the indicator was a noticeable **pulsing amber glow**:

```css
/* BEFORE (e655700) */
.kanban-card.is-working::after {
    ...
    box-shadow: 0 0 0 2px #e0a800, 0 0 14px color-mix(in srgb, #e0a800 45%, transparent);
    animation: kanban-working-pulse 1.8s ease-in-out infinite;
}
@keyframes kanban-working-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
@media (prefers-reduced-motion: reduce) {
    .kanban-card.is-working::after { animation: none; }
}
```

After the commit it became a **thin, static, non-animated 2px border** with no outer glow:

```css
/* AFTER (current, broken) */
.kanban-card.is-working::after {
    ...
    box-shadow: 0 0 0 2px #e0a800;   /* no glow, no animation */
}
body.cyber-theme-enabled .kanban-card.is-working::after { box-shadow: 0 0 0 2px #00e5ff; }
body.theme-claudify .kanban-card.is-working::after { box-shadow: 0 0 0 2px #D97757; }
```

Two regressions combine to make it look "totally broken":

1. **The pulse animation was deleted** — the `kanban-working-pulse` keyframes and the `animation:` declaration were removed, so the indicator no longer moves. The whole point of the feature was an *animation* that draws the eye to in-progress cards; a static border defeats that.
2. **The outer glow was deleted** — the `0 0 14px color-mix(... 45% ...)` second shadow layer was removed, leaving only a flat 2px ring. On a dense kanban board a thin static border is very easy to miss, so users perceive the indicator as "not showing" even when the `is-working` class is correctly applied.

The theme-specific color overrides (cyan for Afterburner, orange for Claudify) that the same commit introduced are a **good** addition and should be kept — they just need the glow + pulse restored alongside them.

### Desired outcome

Restore the pulsing animated glow so in-progress cards are immediately visible again, while preserving the per-theme color overrides and the `prefers-reduced-motion` accessibility guard.

## Metadata

- **Tags:** ui, bugfix
- **Complexity:** 2 (single-file CSS revert + enhancement; no logic/data changes)

## User Review Required

Yes — visual change only, but the user should confirm the restored pulse visibility and the per-theme glow colors match expectation before the card advances to coding. No data, logic, or protocol changes to review.

## Complexity Audit

### Routine
- Single-file CSS edit to one rule block in `src/webview/kanban.html` (lines ~967-988).
- Pure revert of a known-good animation + glow layer; reuses the exact keyframes/shadow values that shipped before `e655700`.
- The `working` flag derivation (`dispatched_at` → `isWorkingState` → `card.working` → `is-working` class) is already correct and untouched.
- Per-theme color overrides already exist; only the glow + pulse are layered back on.

### Complex / Risky
- None. No data flow, DB schema, message protocol, or TypeScript logic is touched. Risk is limited to visual appearance and the `prefers-reduced-motion` guard.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The `is-working` class is applied synchronously during card render from `card.working`; the CSS animation is purely presentational. No concurrent writers to the rule.
- **Security:** None. CSS-only; no user input, no HTML injection, no script changes.
- **Side Effects:**
  - `prefers-reduced-motion`: the original rule disabled the animation for users who opt out of motion. The restore MUST re-add the `@media (prefers-reduced-motion: reduce)` guard so the glow stays static (border + glow, no pulsing) for those users. Do not omit this.
  - `z-index: 1` / `pointer-events: none`: keep these so the glow ring doesn't block card clicks or sit behind the card body. Already correct in the current rule — preserve. (See Verification Plan for a stacking sanity check — the glow must paint above the card background, not behind it.)
  - Completed cards: `isWorking = !isCompleted && card.working` already suppresses the class for completed cards (`kanban.html:6007`); no change needed.
  - Feature cards: working state is derived from subtasks via `featureWorkingMap` (`KanbanProvider.ts:1646`); the same `is-working` class is applied, so the restored animation covers feature cards automatically.
- **Dependencies & Conflicts:**
  - No JS/data dependency. A grep confirms `kanban-working-pulse` only ever existed in this one file (currently absent — deleted by `e655700`); restoring it introduces no name collision with the neighboring `card-op-completed-flash` keyframes (line 993).
  - `color-mix(in srgb, ...)` is already used elsewhere in this same file (`card-op-completed-flash`, line 994) and renders correctly in the VS Code webview Chromium — no new browser-support risk.

## Dependencies

- None. No prerequisite plans or sessions.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the restored glow ring on `::after` at `z-index: 1` could render behind the card body if the body establishes a higher stacking context — reproducing the "invisible" bug the fix targets; (2) the 0.4 opacity trough is the original spec and is borderline-visible on dark themes, but widening it is net-new scope and out of bounds for a restore. Mitigations: add a z-index/stacking sanity check to verification (confirm the ring paints above the card background); keep the original 0.4 trough since the explicit goal is restore, not redesign; keep the `prefers-reduced-motion` guard and the keyframes-name uniqueness grep.

## Proposed Changes

### `src/webview/kanban.html` (lines ~967-988)

**Context:** The current rule block (lines 967-988) is the static, non-animated regression introduced by `e655700`. The `@keyframes kanban-working-pulse` block and the `@media (prefers-reduced-motion: reduce)` guard were deleted entirely and no longer exist in the file (verified by grep — zero matches for `kanban-working-pulse`).

**Logic:** Restore the outer-glow shadow layer (`0 0 14px color-mix(... 45% ...)`) to all three theme variants, restore the `animation: kanban-working-pulse 1.8s ease-in-out infinite` declaration, restore the `@keyframes kanban-working-pulse` block (opacity 1.0↔0.4), and restore the `prefers-reduced-motion` guard. The animation is theme-agnostic (animates `opacity`, not color), so a single `@keyframes` block serves all themes; only the static `box-shadow` color differs per theme.

**Implementation:** Single edit — replace the current static border block with:

```css
/* Agent activity-light border glow ring — lit while a card is dispatched to an agent.
   Amber hue + subtle pulse. Negative inset lets it sit outside the border. */
.kanban-card.is-working::after {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: 5px;
    pointer-events: none;
    z-index: 1;
    /* Default fallback — only reachable if a future third theme clears both
       cyber-theme-enabled and theme-claudify. Defensive only. */
    box-shadow: 0 0 0 2px #e0a800, 0 0 14px color-mix(in srgb, #e0a800 45%, transparent);
    animation: kanban-working-pulse 1.8s ease-in-out infinite;
}

/* Afterburner theme: cyan glow */
body.cyber-theme-enabled .kanban-card.is-working::after {
    box-shadow: 0 0 0 2px #00e5ff, 0 0 14px color-mix(in srgb, #00e5ff 45%, transparent);
}

/* Claudify theme: orange glow */
body.theme-claudify .kanban-card.is-working::after {
    box-shadow: 0 0 0 2px #D97757, 0 0 14px color-mix(in srgb, #D97757 45%, transparent);
}

@keyframes kanban-working-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

@media (prefers-reduced-motion: reduce) {
    .kanban-card.is-working::after { animation: none; }
}
```

**Edge Cases:**
- The `prefers-reduced-motion` guard keeps the glow (border + outer halo) visible but static for reduced-motion users — only the `animation` is disabled, not the `box-shadow`.
- `pointer-events: none` and `z-index: 1` are preserved so the ring never intercepts card clicks.
- The keyframes name `kanban-working-pulse` is unique in the file (verified — the only other keyframes nearby is `card-op-completed-flash`); no collision.

Notes on the diff vs. current:
- Re-adds the `0 0 14px color-mix(... 45% ...)` outer-glow shadow layer to all three theme variants (using each theme's color).
- Re-adds the `animation: kanban-working-pulse 1.8s ease-in-out infinite` declaration.
- Re-adds the `@keyframes kanban-working-pulse` block.
- Re-adds the `@media (prefers-reduced-motion: reduce)` guard.
- Keeps the per-theme color overrides introduced in `e655700` (cyan / orange) — only the glow + pulse are layered back on top.

No other files require changes. The `working` data path (`dispatched_at` → `isWorkingState` → `card.working` → `is-working` class) is already correct.

## Verification Plan

### Automated Tests
None — this is a CSS-only visual change with no logic surface. Per session directive, automated tests are skipped.

### Manual Verification
1. **Reload the webview** so the updated `kanban.html` is served (per session directive, compilation/`npm run compile` is skipped — `src/` is the source of truth and the webview reads it directly on reload).
2. **Dispatch a card** to an agent (e.g. open a plan in a Created/Coded column and run a dispatch action that calls `updateDispatchInfoByPlanFile`, setting `dispatched_at`).
3. **Confirm the indicator appears and animates**: the dispatched card should show a pulsing amber glow ring around its border, fading in/out on a ~1.8s cycle. It should be immediately noticeable.
4. **Confirm theme variants**: switch to the Afterburner (cyber) theme and verify a cyan pulsing glow; switch to the Claudify theme and verify an orange pulsing glow.
5. **Confirm completed cards stay dark**: a card in the COMPLETED column (or one whose `dispatched_at` was cleared by `clearWorkingState` / the timeout sweep) must NOT show the glow.
6. **Confirm `prefers-reduced-motion`**: enable reduced-motion at the OS level (macOS: System Settings → Accessibility → Display → Reduce motion) and reload the webview. The glow ring should still appear (static border + glow) but must NOT pulse.
7. **Confirm feature cards**: dispatch a subtask of a feature; the feature card should light up via `featureWorkingMap` with the same pulsing glow.
8. **Stacking sanity check (load-bearing)**: with a working card visible, confirm the glow ring paints *above* the card background and is not occluded by the card body. If the ring is invisible despite the `is-working` class being applied, the card body's stacking context is above `z-index: 1` — investigate the card body's `z-index`/`position` and raise the ring's `z-index` accordingly. (This is the one real risk: a glow that renders behind the card reproduces the exact "not showing" bug being fixed.)
9. **Regression grep**: after the edit, confirm `kanban-working-pulse` appears exactly once (the keyframes definition) and is referenced exactly once (the `animation:` declaration) in `kanban.html`.

## Recommendation

Complexity 2 → **Send to Intern**.

## Completion Report

Restored the pulsing agent-working glow ring on kanban cards in `src/webview/kanban.html` (lines 967-999): re-added the `0 0 14px color-mix(... 45% ...)` outer-glow shadow layer to all three theme variants (amber default, cyan Afterburner, orange Claudify), the `animation: kanban-working-pulse 1.8s ease-in-out infinite` declaration, the `@keyframes kanban-working-pulse` block (opacity 1.0↔0.4), and the `@media (prefers-reduced-motion: reduce)` guard that disables only the animation. Per-theme color overrides introduced by `e655700` were preserved; only the glow + pulse were layered back on. No other files touched — the `working` data path (`dispatched_at` → `isWorkingState` → `card.working` → `is-working` class at line 6019) was already correct. Regression grep confirms `kanban-working-pulse` appears exactly twice (one keyframes definition + one animation reference). No issues encountered.
