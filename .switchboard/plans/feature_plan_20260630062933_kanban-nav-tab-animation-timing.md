# Reduce Kanban Navigation Tab Animation Timing to Match Other Webviews

## Goal

Reduce the `.shared-tab-btn` CSS transition duration in `kanban.html` from `0.15s` to `0.08s` so that navigation tabs feel snappier than buttons (which remain at `0.15s`). Apply the same change to `project.html` and `design.html` for cross-panel consistency.

### Problem
The user reports that the navigation tabs in `kanban.html` feel like they have a longer animation than the navigation tabs in `project.html` and `design.html`. The user also notes that the tabs should not share the same animation timing as the buttons in `kanban.html` — the tabs feel wrong getting the same timing as the buttons.

### Root Cause
**Investigation finding**: The `.shared-tab-btn` CSS is currently **identical** across all three files — all use `transition: all 0.15s`. The button elements in `kanban.html` (`.strip-btn`, `.btn-add-plan`, `.strip-icon-btn`, etc.) also use `transition: all 0.15s`.

The perceived difference is likely due to `kanban.html` being a single monolithic HTML file with 8 tabs and heavier content hydration (multiple `postKanbanMessage` calls on each tab switch), making the tab switch feel subjectively slower than the lighter `project.html` and `design.html` panels.

However, the user's core request is clear: **the tab transition should be faster/snappier than the button transition**, and the tabs should not share the same `0.15s` timing as the buttons. The fix is to reduce the `.shared-tab-btn` transition duration to a snappier value while leaving all button transitions at `0.15s`.

### Background
- `kanban.html` line 2399: `.shared-tab-btn { transition: all 0.15s; }`
- `project.html` line 616: `.shared-tab-btn { transition: all 0.15s; }`
- `design.html` line 3483: `.shared-tab-btn { transition: all 0.15s; }`
- All button transitions in `kanban.html` (`.strip-btn` line 436, `.btn-add-plan` line 493, `.strip-icon-btn` line 528, `.backlog-toggle-btn` line 601, `.btn-batch` line 632, etc.) use `transition: all 0.15s` — these must NOT be changed. There are 24 total `transition:.*0\.15s` instances in kanban.html; only line 2399 (`.shared-tab-btn`) should be changed.

## Metadata
- **Tags:** [ui, ux]
- **Complexity:** 2

## User Review Required
No — this is a CSS-only timing change with no behavioral or backend impact. The user explicitly requested snappier tab transitions.

## Complexity Audit

### Routine
- Change a single CSS property value (`transition: all 0.15s` → `transition: all 0.08s`) in `kanban.html` line 2399
- Apply the same change to `project.html` line 616 and `design.html` line 3483 for cross-panel consistency
- No logic changes, no new dependencies, no backend changes
- Risk is limited to visual feel only

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — CSS transitions are declarative and browser-managed with no shared state.
- **Security:** None — no input handling, no data exposure.
- **Side Effects:** None — the change is scoped to `.shared-tab-btn` only. All 23 other `transition:.*0\.15s` instances in kanban.html are on different CSS selectors and will not be affected.
- **Dependencies & Conflicts:**
  1. **Claudify theme overrides**: `kanban.html` has Claudify-specific overrides for `.shared-tab-btn` (lines 2434-2445) that change colors but do not override `transition`. The transition change on the base `.shared-tab-btn` rule will apply to both themes. Verified — no `transition` property in the Claudify override block.
  2. **Cyber theme active state**: `.cyber-theme-enabled .shared-tab-btn.active` (line 2423) adds a box-shadow but does not override `transition`. The faster transition will apply to the box-shadow as well, which is desirable.
  3. **Button preservation**: The change is scoped to `.shared-tab-btn` only. All button classes (`.strip-btn`, `.btn-add-plan`, etc.) have their own separate CSS rules and will not be affected. There are 23 other `0.15s` transition instances in kanban.html that must remain untouched.
  4. **Cross-panel consistency**: The plan title says "to Match Other Webviews." Since all three files currently use `0.15s`, changing all three to `0.08s` ensures they remain consistent with each other while all becoming snappier. Changing only kanban.html would make it inconsistent with the other two panels.

## Dependencies
- None — this plan is fully self-contained.

## Adversarial Synthesis

Key risks: (1) accidentally changing one of the 23 other `0.15s` transition instances in kanban.html — mitigated by explicit line-number targeting (line 2399 only) and a preservation list. (2) cross-panel inconsistency if only kanban.html is changed — mitigated by applying the change to all three files. (3) the `0.08s` value is close to instant, which is the desired "snappy" feel; it's distinguishable from the `0.15s` button transitions. No research needed — CSS transition timing is well-understood browser behavior.

## Proposed Changes

### 1. `src/webview/kanban.html` — Reduce tab button transition timing

**Line 2399** — Change the `.shared-tab-btn` transition from `all 0.15s` to `all 0.08s`:

```css
/* Before */
.shared-tab-btn {
  ...
  transition: all 0.15s;
  ...
}

/* After */
.shared-tab-btn {
  ...
  transition: all 0.08s;
  ...
}
```

This makes the tab hover/active state transition ~2x faster than the buttons (which remain at `0.15s`), giving the tabs a snappier feel distinct from the buttons.

**Do NOT change any other transition in kanban.html.** Specifically, leave these untouched (23 other instances):
- `.strip-btn` (line 436): `transition: all 0.15s` — preserve
- `.btn-add-plan` (line 493): `transition: all 0.15s` — preserve
- `.btn-add-plan img` (line 504): `transition: filter 0.15s` — preserve
- `.strip-icon-btn` (line 528): `transition: all 0.15s` — preserve
- `.backlog-toggle-btn` (line 601): `transition: all 0.15s` — preserve
- `.btn-batch` (line 632): `transition: all 0.15s` — preserve
- All other button/action element transitions (lines 795, 802, 823, 836, 858, 878, 980, 1113, 1222, 1237, 1256, 1289, 1311, 1513, 1730, 1818, 2114) — preserve

### 2. `src/webview/project.html` — Match tab timing

**Line 616** — Change the `.shared-tab-btn` transition from `all 0.15s` to `all 0.08s`:

```css
/* Before */
            transition: all 0.15s;

/* After */
            transition: all 0.08s;
```

### 3. `src/webview/design.html` — Match tab timing

**Line 3483** — Change the `.shared-tab-btn` transition from `all 0.15s` to `all 0.08s`:

```css
/* Before */
  transition: all 0.15s;

/* After */
  transition: all 0.08s;
```

Applying the change to all three ensures no panel feels different from the others, consistent with the plan title "to Match Other Webviews."

## Verification Plan

### Automated Tests
- None — this is a CSS-only timing change with no testable logic. No unit/integration/e2e tests apply.

### Manual Verification
1. **Manual test — tab hover feel**:
   - Open Kanban panel.
   - Hover over navigation tabs (KANBAN, AGENTS, PROMPTS, etc.) — confirm the hover state transition feels snappy and instant, not sluggish.
   - Click between tabs — confirm the active state transition is quick.
2. **Manual test — button preservation**:
   - Hover over buttons in the kanban tab strip (e.g. "+ New Plan", filter buttons, batch buttons) — confirm they still have the same `0.15s` transition feel as before.
   - Confirm buttons do NOT feel snappy/jumpy — they should feel the same as before the change.
3. **Manual test — theme variants**:
   - Test with Afterburner theme — confirm tab transitions are snappy.
   - Test with Claudify theme — confirm tab transitions are snappy (the Claudify overrides don't touch transition).
4. **Manual test — cross-panel comparison**:
   - Switch tabs in Kanban, Project, and Design panels — confirm all three feel equally snappy.
5. **Grep verification**:
   - Search kanban.html for `transition:.*0\.08s` — confirm exactly 1 match (line 2399).
   - Search kanban.html for `transition:.*0\.15s` — confirm 23 matches remain (all buttons/other elements unchanged).

## Recommendation

Complexity 2/10 → **Send to Intern**
