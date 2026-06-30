---
description: 'CRT Animation & Visual Theme Polish'
---

# CRT Animation & Visual Theme Polish

**Complexity:** 4

## Goal

Fix visual consistency issues in the Afterburner/claudify themes — CRT scanline animation appears in panels where it shouldn't, the "Disable CRT Animation" toggle doesn't take effect until a full reload, and kanban card meta text (complexity + timestamp) renders in teal instead of grey, breaking visual hierarchy. Together these make the themed UI feel unfinished and inconsistent.

## How the Subtasks Achieve This

- **Remove CRT Scanline Animation from the Design and Setup Panels**: The CRT scanline animation currently renders on all panels, including the Design and Setup panels where it's distracting and inappropriate. The animation should only appear on the main kanban board. This plan scopes the CRT animation CSS to the kanban board container only, removing it from the Design and Setup panels.

- **Make the "Disable CRT Animation" Toggle Take Effect Live**: The "Disable CRT Animation" toggle in settings requires a full webview reload to take effect. Users expect the animation to stop immediately when they toggle it off. This plan adds a CSS class toggle on the webview root element that's bound to the setting, so the animation stops (or starts) instantly without a reload.

- **Unify Kanban Card Meta (Complexity + Timestamp) to Grey Across Themes**: In the Afterburner theme, kanban card meta text (complexity badge and timestamp) renders in teal, which clashes with the theme's accent color and creates visual noise. The meta text should be a neutral grey across all themes so the card title and status badges remain the visual focus. This plan overrides the meta text color to grey in the Afterburner/claudify theme CSS.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remove CRT Scanline Animation from the Design and Setup Panels](../plans/feature_plan_20260626124050_crt_animation_scope_design_setup_panels.md) — **CODE REVIEWED**
- [ ] [Make the "Disable CRT Animation" Toggle Take Effect Live](../plans/feature_plan_20260626124051_crt_animation_disable_not_live.md) — **CODE REVIEWED**
- [ ] [Unify Kanban Card Meta (Complexity + Timestamp) to Grey Across Themes](../plans/feature_plan_20260626124052_kanban_card_meta_teal_afterburner.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

---

## Epic Review Pass (Reviewer-Executor)

### Summary

All 3 subtasks reviewed in-place against their plan requirements. 1 CRITICAL + 1 NIT found and fixed in Plan 1; Plans 2 and 3 passed clean.

| Subtask | Findings | Fixes Applied | Status |
|---------|----------|---------------|--------|
| Remove CRT Scanline from Design/Setup | 1 CRITICAL, 1 NIT | 2 fixes applied | Fixed & verified |
| Disable CRT Animation Toggle Live | 0 findings | None needed | Clean pass |
| Kanban Card Meta Grey | 0 findings | None needed | Clean pass |

### Findings by Severity

**CRITICAL (1):**
- `src/webview/setup.html:531-532` — Orphaned `<div class="cyber-scanlines"></div>` + comment not removed (CSS was removed but the element was left behind). **Fixed:** element + comment deleted.

**NIT (1):**
- `src/webview/design.html:1356` — `box-shadow` comment still referenced "scanlines" after scanline removal. **Fixed:** comment updated to remove stale reference.

### Files Changed During Review

- `src/webview/setup.html` — removed orphaned scanline div + comment (CRITICAL fix)
- `src/webview/design.html` — updated stale comment (NIT fix)

### Remaining Risks

- None. All 3 subtasks are complete and verified. The epic's visual consistency goals (scanline scope, live toggle, grey meta) are fully addressed.
