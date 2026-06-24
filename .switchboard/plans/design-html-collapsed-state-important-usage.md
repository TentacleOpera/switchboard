# Fix .content-row Collapsed State !important Usage in design.html

## Goal

Remove the unnecessary `!important` declarations from the `.content-row.collapsed` flex override rules in `src/webview/design.html` (lines 297 and 300). The `!important` is dead weight — the collapsed-state selectors already have higher CSS specificity than the base rules they override, so `!important` is not required for correctness.

### Problem

`.content-row.collapsed > :first-child` uses `flex: 0 0 40px !important` and `.content-row.collapsed > :last-child` uses `flex: 1 !important` (design.html `:296-301`). The `!important` is a code smell that makes future overrides harder and indicates a misunderstanding of the CSS cascade.

### Root Cause (Original Analysis — Preserved)

The original plan hypothesized that the transition on `flex` creates a specificity conflict — the collapsed state needs to win over the base `flex` value during the transition. Instead of structurally avoiding the conflict, `!important` was used as a shortcut.

### Root Cause (Corrected — Investigation Finding)

**The original analysis is incorrect.** CSS transitions have **zero effect on specificity** — they animate a property value change but do not participate in the cascade. The real situation is straightforward specificity arithmetic:

| Selector | Specificity |
|---|---|
| `.content-row > :first-child` (base, `:287`) | (0, 2, 0) — 1 class + 1 pseudo-class |
| `.content-row.collapsed > :first-child` (collapsed, `:296`) | (0, 3, 0) — 2 classes + 1 pseudo-class |

The collapsed selector **already wins** by specificity (0,3,0 > 0,2,0). The `!important` was either cargo-culted from `project.html` (where it IS needed — see Edge-Case Audit) or added without verifying the cascade. The `transition: flex 0.2s ease` on `.content-row > *` (`:285`) is orthogonal — it animates the value change but does not affect which declaration wins.

**The fix is a two-line change: delete `!important` from lines 297 and 300.** No transition changes are required for correctness.

## Metadata
**Complexity:** 2
**Tags:** refactor, frontend

## User Review Required

No — this is a pure CSS cleanup with no behavioral or product-scope change. The collapsed sidebar will look and behave identically. The only review point is visual confirmation that the sidebar still collapses to 40px and expands back.

## Complexity Audit

### Routine
- Two-line CSS edit: remove `!important` from two declarations in a single file.
- No JavaScript changes, no HTML structure changes, no backend changes.
- Specificity analysis is deterministic — the collapsed selectors provably outrank the base selectors.
- No data, no state, no migrations.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None — CSS cascade is deterministic, no async behavior.

**Security:** None — no script, no user input, no data handling.

**Side Effects:**
- **`display: none !important` on line 321 is a SEPARATE concern and must NOT be touched.** That `!important` overrides `display` on child elements of the tree panes (e.g. `.empty-state`, list items) and is needed because those children may have their own `display` rules. It is unrelated to the flex `!important` on lines 297/300.
- **The `transition: flex 0.2s ease` on line 285 can remain.** It is harmless — whether it produces a visible smooth animation is a separate UX question (see Uncertain Assumptions). Removing it is optional and out of scope for this plan.

**Dependencies & Conflicts:**
- **`planning.html` shares the identical pattern** (lines 288-292: same base rules with `transition: flex 0.2s ease`, same collapsed rules with `!important`). The same fix (remove `!important`) applies there and is safe for the same specificity reason. However, this plan scopes to `design.html` only per its title. A follow-up plan can address `planning.html`.
- **`project.html` has the SAME `!important` pattern (lines 515, 518) but for a DIFFERENT and VALID reason.** In `project.html`, the sidebar panes are sized by **ID selectors** (`#kanban-list-pane { width: 320px; flex-shrink: 0; }` at `:218-220`). An ID selector has specificity (1, 0, 0), which **outranks** `.content-row.collapsed > :first-child` at (0, 3, 0). Therefore the `!important` in `project.html` IS genuinely needed (or the collapsed rules should be rewritten to target the IDs directly). **Do NOT apply this plan's fix to `project.html`.**

## Dependencies
- None

## Adversarial Synthesis

Key risks: (1) someone blindly applies the "remove `!important`" fix to `project.html` where it IS needed due to ID-selector specificity, breaking sidebar collapse there; (2) the `display: none !important` on line 321 gets swept up in a "remove all !important" cleanup. Mitigations: the plan explicitly scopes to design.html lines 297/300 only and documents why project.html's `!important` is valid. The fix is a two-line surgical edit with no transition or structural changes required.

## Uncertain Assumptions

- **`transition: flex 0.2s ease` animation quality in Chromium/Electron — RESOLVED via web research.** The original plan claimed "transitions on `flex` are unreliable anyway (not all browsers animate `flex` smoothly)." Research confirms the following:
  - The `flex` shorthand IS animatable in Chromium/Blink — it expands to `flex-grow`, `flex-shrink`, and `flex-basis`, all of which interpolate continuously.
  - **However, it is a performance liability.** Every animation frame triggers a full main-thread layout reflow + paint cycle (style recalc → layout → pre-paint → paint → commit). In an Electron/VS Code webview where the main thread is also handling extension host messages, syntax highlighting, and file parsing, this causes dropped frames and visible jank.
  - **Known zero-value snap bug (Chromium Issue 41158700):** Transitioning `flex-grow` down to `0` historically snaps instantly instead of animating. This directly affects the `flex: 1` → `flex: 0 0 40px` transition in this codebase — the collapse may snap rather than smoothly animate, especially on older Electron runtimes.
  - **Non-linear intermediate curves:** Transitioning all three flex sub-properties simultaneously causes the flexbox solver to resolve conflicting constraints per frame, producing erratic intermediate sizing.
  - **Recommended alternatives (per research):** `transition: width` or `transition: max-width` (main-thread reflow but more predictable and linear), or CSS Grid column transitions (`grid-template-columns`). `transform: translateX()` is compositor-only (GPU) but doesn't reflow siblings.

  **Conclusion for this plan:** The `!important` removal (lines 297/300) proceeds unchanged — it is purely a specificity issue. The `transition: flex 0.2s ease` on line 285 is confirmed to be both a performance risk and potentially non-functional (zero-value snap). A follow-up plan should replace `transition: flex 0.2s ease` with `transition: width 0.2s ease` (or remove it entirely if smooth animation is not a priority for a 0.2s sidebar toggle). This is out of scope for the current plan but documented here as a confirmed finding.

## Proposed Changes

### `src/webview/design.html`

**Context:** Lines 296-301 contain the collapsed-state flex overrides with `!important`. Lines 284-294 contain the base flex rules. The collapsed selectors already have higher specificity (0,3,0 vs 0,2,0), so `!important` is redundant.

**Implementation — Step 1: Remove `!important` from the collapsed first-child rule (line 297):**

```css
/* BEFORE (line 296-298) */
.content-row.collapsed > :first-child {
    flex: 0 0 40px !important;
}

/* AFTER */
.content-row.collapsed > :first-child {
    flex: 0 0 40px;
}
```

**Implementation — Step 2: Remove `!important` from the collapsed last-child rule (line 300):**

```css
/* BEFORE (line 299-301) */
.content-row.collapsed > :last-child {
    flex: 1 !important;
}

/* AFTER */
.content-row.collapsed > :last-child {
    flex: 1;
}
```

**Edge Cases:**
- Do NOT touch line 321 (`display: none !important`) — that is a separate, valid `!important`.
- Do NOT touch the `transition: flex 0.2s ease` on line 285 — it is harmless and orthogonal to this fix.
- Do NOT apply this change to `project.html` or `planning.html` as part of this plan (see Edge-Case Audit for why `project.html` differs).

## Verification Plan

### Automated Tests
- None — this is a CSS-only change with no testable logic.

### Manual Verification
1. Open the Switchboard Design panel in VS Code.
2. On each tab that has a sidebar (Design, HTML, Images, Briefs), click the sidebar toggle button (`«`/`»`).
3. Confirm the sidebar collapses to 40px width (only the toggle button row remains visible).
4. Confirm the preview panel expands to fill the remaining space.
5. Click the toggle again — confirm the sidebar expands back to its original ratio.
6. Confirm no layout glitches, overflow, or visual regressions during collapse/expand.
7. If the sidebar was collapsed on page load (restored from saved state), confirm it renders correctly in the collapsed state on initial load.

---

**Recommendation:** Complexity 2 → **Send to Intern**
