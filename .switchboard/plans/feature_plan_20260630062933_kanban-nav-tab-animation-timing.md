# Reduce Kanban Navigation Tab Animation Timing to Match Other Webviews

## Goal

### Problem
The user reports that the navigation tabs in `kanban.html` feel like they have a longer animation than the navigation tabs in `project.html` and `design.html`. The user also notes that the tabs should not share the same animation timing as the buttons in `kanban.html` — the tabs feel wrong getting the same timing as the buttons.

### Root Cause
**Investigation finding**: The `.shared-tab-btn` CSS is currently **identical** across all three files — all use `transition: all 0.15s`. The button elements in `kanban.html` (`.strip-btn`, `.btn-add-plan`, `.strip-icon-btn`, etc.) also use `transition: all 0.15s`.

The perceived difference is likely due to `kanban.html` being a single monolithic HTML file with 8 tabs and heavier content hydration (multiple `postKanbanMessage` calls on each tab switch), making the tab switch feel subjectively slower than the lighter `project.html` and `design.html` panels.

However, the user's core request is clear: **the tab transition should be faster/snappier than the button transition**, and the tabs should not share the same `0.15s` timing as the buttons. The fix is to reduce the `.shared-tab-btn` transition duration in `kanban.html` to a snappier value while leaving all button transitions at `0.15s`.

### Background
- `kanban.html` line 2399: `.shared-tab-btn { transition: all 0.15s; }`
- `project.html` line 616: `.shared-tab-btn { transition: all 0.15s; }`
- `design.html` line 3483: `.shared-tab-btn { transition: all 0.15s; }`
- All button transitions in `kanban.html` (`.strip-btn` line 436, `.btn-add-plan` line 493, `.strip-icon-btn` line 528, `.backlog-toggle-btn` line 601, `.btn-batch` line 632, etc.) use `transition: all 0.15s` — these must NOT be changed.

## Metadata
- **Tags**: `kanban`, `navigation`, `tabs`, `animation`, `transition`, `ux`
- **Complexity**: 2/10

## Complexity Audit

**Routine** — Single CSS property change in one file. No logic changes, no new dependencies, no backend changes. The risk is limited to visual feel only.

## Edge-Case & Dependency Audit

1. **Claudify theme overrides**: `kanban.html` has Claudify-specific overrides for `.shared-tab-btn` (lines 2434-2445) that change colors but do not override `transition`. The transition change on the base `.shared-tab-btn` rule will apply to both themes.
2. **Cyber theme active state**: `.cyber-theme-enabled .shared-tab-btn.active` (line 2423) adds a box-shadow but does not override `transition`. The faster transition will apply to the box-shadow as well, which is desirable.
3. **Button preservation**: The change is scoped to `.shared-tab-btn` only. All button classes (`.strip-btn`, `.btn-add-plan`, etc.) have their own separate CSS rules and will not be affected.
4. **Consistency with project.html/design.html**: The user says "reduce to match" project.html and design.html. Since those files also use `0.15s`, the user's intent is for the kanban tabs to feel snappier. If desired, the same change could be applied to project.html and design.html for cross-panel consistency, but the user specifically called out kanban.html.

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

**Do NOT change any other transition in kanban.html.** Specifically, leave these untouched:
- `.strip-btn` (line 436): `transition: all 0.15s` — preserve
- `.btn-add-plan` (line 493): `transition: all 0.15s` — preserve
- `.btn-add-plan img` (line 504): `transition: filter 0.15s` — preserve
- `.strip-icon-btn` (line 528): `transition: all 0.15s` — preserve
- `.backlog-toggle-btn` (line 601): `transition: all 0.15s` — preserve
- `.btn-batch` (line 632): `transition: all 0.15s` — preserve
- All other button/action element transitions — preserve

### 2. (Optional) `src/webview/project.html` and `src/webview/design.html` — Match tab timing

If cross-panel consistency is desired, apply the same `0.08s` change to `.shared-tab-btn` in:
- `project.html` line 616
- `design.html` line 3483

This is optional — the user's primary complaint is about `kanban.html`. Applying it to all three ensures no panel feels different.

## Verification Plan

1. **Build**: `npm run compile` — confirm no errors (CSS-only change, should be trivial).
2. **Manual test — tab hover feel**:
   - Open Kanban panel.
   - Hover over navigation tabs (KANBAN, AGENTS, PROMPTS, etc.) — confirm the hover state transition feels snappy and instant, not sluggish.
   - Click between tabs — confirm the active state transition is quick.
3. **Manual test — button preservation**:
   - Hover over buttons in the kanban tab strip (e.g. "+ New Plan", filter buttons, batch buttons) — confirm they still have the same `0.15s` transition feel as before.
   - Confirm buttons do NOT feel snappy/jumpy — they should feel the same as before the change.
4. **Manual test — theme variants**:
   - Test with Afterburner theme — confirm tab transitions are snappy.
   - Test with Claudify theme — confirm tab transitions are snappy (the Claudify overrides don't touch transition).
5. **Manual test — cross-panel comparison** (if optional change applied):
   - Switch tabs in Kanban, Project, and Design panels — confirm all three feel equally snappy.
