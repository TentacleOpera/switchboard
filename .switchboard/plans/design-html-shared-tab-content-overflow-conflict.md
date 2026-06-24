# Fix .shared-tab-content.active overflow-y Conflict in design.html

## Goal

Resolve the nested-overflow conflict where `.shared-tab-content.active` sets `overflow-y: auto` while each tab's internal `.content-row` children manage their own scroll, causing potential double scrollbars, clipped content, or scroll capture going to the wrong element.

### Problem
`.shared-tab-content.active` has `overflow-y: auto` (line 3584), but individual tab contents set their own overflow properties. For example, `.content-row` has `overflow: hidden` (line 282) and its direct children (`.content-row > :first-child` / `> :last-child`) have `overflow-y: auto` (lines 289, 293). Nested overflow contexts can cause unexpected scrollbar behavior — double scrollbars, clipped content, or scroll capture going to the wrong element. The `#stitch-content` tab is the most affected because its `.content-row` ALSO sets `overflow-y: auto` (line 3026), creating two competing scroll containers.

### Root Cause
The `.shared-tab-content.active` rule was added as a generic "make active tabs scrollable" without considering that child elements (`.content-row` and its children) already manage their own overflow. The base `.shared-tab-content` rule correctly sets `overflow: hidden` (line 3580), but the `.active` variant overrides it with `overflow-y: auto` (line 3584), re-introducing an outer scroll context that conflicts with the inner ones.

### Specificity Note
A separate ID-based rule (lines 189-212) sets `height: calc(100vh - 40px)` and `display: flex` on `#design-content`, `#briefs-content`, `#html-preview-content`, `#images-content` — but NOT `#stitch-content`. The ID rule has higher specificity than the `.shared-tab-content` class rule. However, neither the ID rule nor the base class rule sets `overflow` on the active state — the only `overflow` declaration on the active state comes from `.shared-tab-content.active { overflow-y: auto }`. So removing that single declaration fixes all five tabs uniformly, regardless of where their height constraint originates.

## Metadata
**Tags:** bugfix, frontend, ui
**Complexity:** 2

## User Review Required
No — this is a single-line CSS deletion with no behavioral ambiguity. Each tab's internal scroll containers have been verified (see Complexity Audit). Safe to execute without review.

## Complexity Audit

### Routine
- Single-line CSS change: delete `overflow-y: auto;` from `.shared-tab-content.active` (line 3584)
- The base `.shared-tab-content` rule already sets `overflow: hidden` (line 3580), which applies automatically once the override is removed
- Each tab follows the same layout pattern: `.controls-strip` (flex-shrink: 0) + `.content-row` (flex: 1, overflow: hidden) — no tab relies on the outer container for scrolling
- No JavaScript depends on the outer container's scroll position (verified: zero `scrollTop`/`scrollTo`/`onscroll`/`addEventListener('scroll')` references in design.html or design.js; the only JS touching `.shared-tab-content` toggles the `active` class — design.js:128-146)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None — pure CSS, no runtime state.

**Security:** None — no data or auth surface.

**Side Effects:**
- If any tab had content directly inside `.shared-tab-content` (not wrapped in `.content-row`) that relied on the outer container scrolling, that content would become clipped. Verified: every tab's scrollable content is inside a `.content-row` whose children have `overflow-y: auto`. The only non-`.content-row` children are `.controls-strip` bars (flex-shrink: 0, fixed height) and conditionally-displayed panels (e.g. `#stitch-auth-panel`) — none require outer scrolling.
- `#stitch-content` is the only tab NOT covered by the ID-based `height: calc(100vh - 40px)` rule (lines 189-212). It relies on `.shared-tab-content { flex: 1 }` for height. With `overflow: hidden` (from base rule) and its inner `.content-row { overflow-y: auto }` (line 3026), scroll is correctly delegated inward. No regression.

**Dependencies & Conflicts:**
- The `.shared-tab-content.active` rule (line 3582) and the ID-based active rule (lines 203-212) both set `display: flex`. Removing `overflow-y: auto` from the class rule does not affect `display: flex` — the active tab remains visible. No conflict.

## Dependencies
- None

## Adversarial Synthesis
Key risks: stale line numbers in the original plan (corrected: active rule is at line 3584, not 3492; `.content-row` at 279, not 217); unverified assumption that no JS listens to outer-container scroll (verified — zero scroll listeners); and the untested `#stitch-content` tab which lacks the ID-based height constraint (confirmed safe via its inner `.content-row` scroll). Mitigations: line numbers corrected against current source; JS scroll-dependency audit completed; stitch tab's flex-based height + inner scroll confirmed sufficient. The fix is a single-line deletion with no behavioral side effects.

## Proposed Changes

### src/webview/design.html
- **Context:** The `.shared-tab-content.active` rule (lines 3582-3585) overrides the base `overflow: hidden` (line 3580) with `overflow-y: auto`, creating a competing outer scroll context.
- **Logic:** Delete the `overflow-y: auto;` declaration from `.shared-tab-content.active`. The base `.shared-tab-content { overflow: hidden }` then applies to active tabs uniformly. Keep `display: flex` so the active tab remains visible.
- **Implementation:**
  ```css
  /* BEFORE (lines 3582-3585) */
  .shared-tab-content.active {
    display: flex;
    overflow-y: auto;
  }

  /* AFTER */
  .shared-tab-content.active {
    display: flex;
  }
  ```
- **Edge Cases:** None — every tab delegates scroll to `.content-row` children (verified per-tab below).

### Per-Tab Scroll Audit (verified against current source)
| Tab | Element | Internal Scroll | Status |
|-----|---------|-----------------|--------|
| Briefs (`#briefs-content`) | `.content-row` (line 3633) → children `overflow-y: auto` (lines 289, 293); `#preview-pane-briefs` has `overflow: auto` (inline, line 3641) | OK |
| Design System (`#design-content`) | `#design-local-panel` `overflow: hidden` (inline, line 3676) → `.content-row` (line 3677) → children `overflow-y: auto` | OK |
| HTML Previews (`#html-preview-content`) | `.content-row` (line 3752) → `#preview-pane-html` `overflow: hidden` (inline, line 3760); `.content-row > *` `overflow-y: auto` | OK |
| Images (`#images-content`) | `.content-row` (line 3801) → `#preview-pane-images` `overflow: hidden` (inline, line 3809); `.content-row > *` `overflow-y: auto` | OK |
| Stitch (`#stitch-content`) | `.content-row` `overflow-y: auto` (line 3026, `flex-direction: column`) — inner scroll handles all content | OK — this was the tab MOST affected by the conflict (two competing `overflow-y: auto` containers); fix eliminates the outer one |

## Verification Plan

### Automated Tests
- None — pure CSS change, no unit-testable logic.

### Manual Verification (user-run, no compilation/tests per session directives)
1. Open the Design webview in VS Code.
2. For each of the five tabs (Briefs, Design System, HTML Previews, Images, Stitch):
   - Load content taller than the viewport.
   - Confirm scrolling works inside the tab (content reachable, no clipping).
   - Confirm NO double scrollbars appear (only the inner `.content-row` child scrolls).
3. Confirm the sidebar (tree pane) and preview pane scroll independently within each tab.
4. Confirm the Stitch tab specifically — it was the primary symptom (two `overflow-y: auto` containers). Verify single scrollbar, correct scroll capture.
5. Confirm collapsing/expanding the sidebar (`.content-row.collapsed`) still works without layout breakage.

## Recommendation
Complexity 2 → **Send to Intern**.
