# Move "Inspect Mode" Button to the Left of the Controls Strip

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, bugfix

## Goal

In the webview controls strip that contain an "Inspect Mode" overlay toggle, the button currently renders on the right-hand side of the strip. It should sit on the left, immediately next to the workspace/project `<select>` dropdown, so it is visually grouped with the primary navigation control rather than drifting to the far right.

> **⚠️ FLAGGED FOR USER — factual premise appears already satisfied.** Verification against the current source (see Superseded callouts below) shows all three affected strips already place the Inspect Mode `<button>` immediately after the `<select>` dropdown and before the `<input>` search box — i.e. the target order. The "currently renders on the right-hand side" claim in the Goal does not match the live code. This Goal statement is preserved per protocol; the user should confirm whether the plan is stale, targets a different branch, or is already done.

### Problem & Root Cause

Each affected controls strip is a flex row (`.controls-strip`: `display: flex; align-items: center; gap: 8px;` with no `justify-content`, children `flex-shrink: 0`). The DOM order in every affected strip is:

```
<select dropdown>  <input.sidebar-search-input>  <button Inspect Mode>  <span status>  <button ...>
```

The `.sidebar-search-input` class carries `margin-left: auto` (design.html:1899, planning.html:1917). In a flex row, `margin-left: auto` on an item absorbs all remaining free space to the **left** of that item, pushing that item — and every sibling after it — to the right edge of the container.

Result: the search input and the Inspect Mode button (which follows it in DOM order) both get shuttled to the right. The Inspect Mode button is not right-aligned by its own styling; it is dragged right by the search input's `margin-left: auto`.

> **Superseded:** The DOM order above (`<select> <input> <button Inspect Mode> ...`) and the resulting "button dragged right by the search input's `margin-left: auto`" conclusion.
> **Reason:** Verified against current source — all three strips already place the Inspect Mode button BEFORE the search input, so the `margin-left: auto` on the input pushes only the input + trailing siblings right, not the button. The button already sits left, next to the dropdown.
> **Replaced with:** The actual current DOM order (verified 2026-07-13) for all three strips is:
> ```
> <select dropdown>  <button Inspect Mode>  <input.sidebar-search-input>  <span status>  <button ...>
> ```
> See per-strip evidence in Proposed Changes. The Goal's desired layout is already the live layout.

### Why a markup reorder (not a CSS edit)

`.sidebar-search-input` is a shared class used in many sidebars/strips across both webviews. Editing its `margin-left` would change layout in unrelated places and risk regressions. The `margin-left: auto` is intentional for the search input's placement and the user has confirmed the search input should remain on the right. A pure DOM reorder of the Inspect Mode button achieves the goal without touching shared CSS.

## User Review Required

**Yes — required.** The plan's core premise (button currently on the right) does not match the live code, which already has the button on the left next to the dropdown. The user must confirm one of:
1. The plan is **already done** (a prior change landed it) → close/done the card with no code change.
2. The plan targets a **different branch/checkout** where the old order still exists → re-verify against that branch before acting.
3. The visual symptom persists despite the DOM order being correct → the cause is something else (e.g. CSS, a runtime reorder, a different strip than the three listed), and the plan needs rework.

## Affected Locations

Three controls strips, each with one `preview-overlay-btn` "Inspect Mode" button:

1. **planning.html** — `#planning-html-btn-inspect` inside `#controls-strip-planning-html` (line ~3690-3699)
2. **design.html** — `#stitch-html-btn-inspect` inside `#controls-strip-stitch-html` (line ~3803-3810)
3. **design.html** — `#html-btn-inspect` inside `#controls-strip-html` (line ~3893-3901)

Out of scope: the `strip-btn` "Inspect" buttons (`#btn-inspect-design` at design.html:3705, `#btn-inspect-images` at design.html:3967). Those are a different control in a different strip context (Design/Images tabs), not the "Inspect Mode" overlay toggle described in this request.

## Complexity Audit

### Routine
- DOM-only reorder of a single `<button>` within its parent `<div class="controls-strip">` (if any change is needed at all).
- No CSS, no IDs, no event handlers, no JS selectors change.
- Three near-identical edits across two HTML files.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None (static HTML).
- **Security:** None.
- **Side Effects:** None — element position within the same parent does not affect `getElementById`/`querySelector` lookups.
- **Dependencies & Conflicts:** The shared `.sidebar-search-input` class is intentionally NOT modified, so unrelated sidebars are unaffected. No dependency on other plans.

## Dependencies

- None

## Adversarial Synthesis

Key risk: the plan's premise is contradicted by the live source — all three strips already match the target order, so the proposed reorder is a no-op. Mitigation: flagged for user review; no code change should be made until the user confirms whether the plan is stale, branch-specific, or chasing a different visual symptom.

## Proposed Changes

### `src/webview/planning.html` — `#controls-strip-planning-html` (L3690-3699)

- **Context:** The plan proposed moving `#planning-html-btn-inspect` from after the search input to after the dropdown.
- **Verified current order (L3690-3699):**
  ```html
  <select id="planning-html-workspace-filter" ...>...</select>
  <button id="planning-html-btn-inspect" class="preview-overlay-btn" ...>Inspect Mode</button>
  <input type="text" id="planning-html-docs-search" class="sidebar-search-input" ... />
  <span id="status-planning-html" ...>...</span>
  <button id="btn-copy-artifact-prompt" ...>...</button>
  <button id="btn-send-artifact-prompt" ...>...</button>
  ```
  The button is **already** immediately after the `<select>` and before the `<input>`. This IS the target order.

> **Superseded:** Plan's "Current order" for Strip 1 showed `<select> <input> <button Inspect Mode> <span> <button> <button>`, with "Target order" `<select> <button Inspect Mode> <input> <span> <button> <button>`.
> **Reason:** The actual source (planning.html L3690-3699) already matches the stated "Target order." The "Current order" block does not reflect the live code.
> **Replaced with:** No change required for this strip — the button is already in the target position. If the user confirms the plan is still needed, re-verify against the correct branch first.

### `src/webview/design.html` — `#controls-strip-stitch-html` (L3805-3812)

- **Verified current order (L3805-3812):**
  ```html
  <select id="stitch-html-project-select" ...>...</select>
  <button id="stitch-html-btn-inspect" class="preview-overlay-btn" ...>Inspect Mode</button>
  <input type="text" id="stitch-html-docs-search" class="sidebar-search-input" ... />
  <span id="status-stitch-html" ...>...</span>
  ```
  The button is **already** immediately after the `<select>` and before the `<input>`. This IS the target order.

> **Superseded:** Plan's "Current order" for Strip 2 showed `<select> <input> <button Inspect Mode> <span>`, with "Target order" `<select> <button Inspect Mode> <input> <span>`.
> **Reason:** The actual source (design.html L3805-3812) already matches the stated "Target order."
> **Replaced with:** No change required for this strip.

### `src/webview/design.html` — `#controls-strip-html` (L3895-3904)

- **Verified current order (L3895-3904):**
  ```html
  <select id="html-workspace-filter" ...>...</select>
  <button id="html-btn-inspect" class="preview-overlay-btn" ...>Inspect Mode</button>
  <input type="text" id="html-docs-search" class="sidebar-search-input" ... />
  <span id="status-html" ...>...</span>
  <button id="btn-copy-design-html-artifact-prompt" ...>...</button>
  <button id="btn-send-design-html-artifact-prompt" ...>...</button>
  ```
  The button is **already** immediately after the `<select>` and before the `<input>`. This IS the target order.

> **Superseded:** Plan's "Current order" for Strip 3 showed `<select> <input> <button Inspect Mode> <span> <button> <button>`, with "Target order" `<select> <button Inspect Mode> <input> <span> <button> <button>`.
> **Reason:** The actual source (design.html L3895-3904) already matches the stated "Target order."
> **Replaced with:** No change required for this strip.

## Resulting Layout (all three strips)

```
[workspace/project dropdown] [Inspect Mode]  ←—— margin-left:auto ——→  [search input] [status] [buttons...]
```

Inspect Mode is pinned to the left next to the dropdown. The search input retains its right-cluster behavior. No CSS changes, no impact on other strips/sidebars that share `.sidebar-search-input`.

> **Note:** This is the layout already present in the live source for all three strips.

## Verification Plan

### Automated Tests
- None (manual UI verification).

### Manual Verification
1. Open the Switchboard extension in VS Code.
2. Planning panel → HTML tab: confirm Inspect Mode sits immediately right of the "All Workspaces" dropdown, and the search input + status + upload buttons remain on the right.
3. Design panel → Stitch HTML tab: confirm Inspect Mode sits immediately right of the "Select Project..." dropdown.
4. Design panel → HTML Previews tab: confirm Inspect Mode sits immediately right of the "All Workspaces" dropdown.
5. Toggle each Inspect Mode button on/off to confirm the overlay still activates (the reorder is purely positional; no event handlers or IDs change).
6. Spot-check an unrelated sidebar that uses `.sidebar-search-input` (e.g. a docs tree search) to confirm its layout is unchanged.

> **Note:** Because the live code already matches the target order, steps 2-4 should pass with no code change. If they fail, the visual symptom has a different cause than the one diagnosed in this plan — do not apply the proposed reorder; investigate the real cause (CSS, runtime DOM mutation, wrong strip).

## Risks & Edge Cases

- **None functional.** No IDs, classes, event handlers, or CSS are changed — only element position within the same parent. JS selectors (`getElementById`, `querySelector`) are position-independent.
- **Visual only:** the only behavioral risk is if any CSS targets the Inspect Mode button via a positional/nth-child selector. A search for `.controls-strip` selectors shows none target children by position; the button is styled by its class `.preview-overlay-btn` only. Safe.
- **Plan-premise risk (top finding):** the proposed reorder is a no-op against the current source. Acting on the plan as written would change nothing. See User Review Required.

## Recommendation

**Do NOT send to a coder yet.** The plan's premise is contradicted by the live source — all three strips already match the target order. Hold for user review (see User Review Required). If the user confirms the plan is already satisfied, mark the card done with no code change. If the visual symptom persists, rework the plan to diagnose the real cause before dispatch.

## Completion Summary

Verified against live source (2026-07-13): all three controls strips already place the Inspect Mode `<button>` immediately after the `<select>` dropdown and before the `<input class="sidebar-search-input">` — i.e. the target order described in the Goal. No code change was made. Files inspected: `src/webview/planning.html` (L3690-3699, `#controls-strip-planning-html`), `src/webview/design.html` (L3805-3812, `#controls-strip-stitch-html`; L3895-3904, `#controls-strip-html`). The plan's "currently renders on the right-hand side" premise does not match the current code; the proposed DOM reorder is a no-op. If the visual symptom persists, the cause lies elsewhere (CSS, runtime DOM mutation, or a different strip than the three listed) and the plan should be reworked before any code change.
