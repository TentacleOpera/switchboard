# Fix the Stitch Design Systems Tab: Add a Project Dropdown and Render Real Data

## Goal

In `design.html`, the **Stitch Design Systems** sub-tab works poorly: there is no dropdown to select a Stitch project from within the tab, and when a design system loads it shows no useful information — just a "string of random numbers." Fix both: provide a project selector in the Design Systems panel, and render meaningful design-system data.

### Problem Analysis

**No project dropdown in the Design Systems panel.** The project `<select id="stitch-project-select">` lives in the *Screens* sub-tab ([design.html:3847](src/webview/design.html#L3847)). The Design Systems panel only shows a static label `STITCH PROJECT: None Selected` ([design.html:3700-3701](src/webview/design.html#L3700)) with no selector of its own. `refreshStitchDesignSystems()` ([design.js](src/webview/design.js)) early-returns with "No Stitch project selected" whenever `state.selectedStitchProjectId` is falsy — and that value is only ever set by the Screens-tab dropdown. So a user landing on Design Systems first has no way to pick a project.

**"String of random numbers."** Cards are rendered by `renderStitchDesignSystems()` using `ds.displayName`, `ds.id`, and `ds.styleGuidelines`. The backend maps the list in [DesignPanelProvider.ts:1654-1661](src/services/DesignPanelProvider.ts#L1654):
```ts
const designSystems = list.map((ds) => ({
    id: ds.id,
    displayName: ds.data?.displayName || ds.id,   // falls back to the raw id
    styleGuidelines: ds.data?.styleGuidelines || '',
    designTokens: ...JSON.stringify(ds.data?.designTokens || {})
}));
```
When the Stitch SDK design-system object does not expose `data.displayName` / `data.styleGuidelines` under those exact keys, `displayName` falls back to `ds.id` (an opaque numeric/hash id) and guidelines render empty — so the card title AND the id label both show the same "random numbers," with no real content.

### Root Cause

1. The Design Systems panel has no project selector and depends on a selection made in a different sub-tab.
2. The backend field mapping (`ds.data?.displayName` / `styleGuidelines`) does not match the actual Stitch design-system object shape, so names/guidelines are empty and only the raw id surfaces.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, stitch, design-panel, data-mapping

## Complexity Audit

### Routine
- Adding a project `<select>` to the Design Systems panel header, populated from the same project list used by the Screens tab.
- Wiring its `change` to set `state.selectedStitchProjectId` and call `refreshStitchDesignSystems()`.

### Complex / Risky
- Determining the correct Stitch SDK field shape for a design system requires inspecting an actual API response (the current mapping is guessing at `ds.data?.displayName`). The fix must be driven by real data, then the mapping corrected and the card made resilient (show guidelines/token summary even when there is no name).

## Edge-Case & Dependency Audit

- **Race Conditions:** Project list load vs. design-system fetch — populate the dropdown before (or independently of) fetching systems; guard against fetching with an empty project id.
- **Security:** None new (existing Stitch auth gate at [1641-1644](src/services/DesignPanelProvider.ts#L1641) stays).
- **Side Effects:** A Design-Systems-panel dropdown that also writes `state.selectedStitchProjectId` should stay in sync with the Screens-tab dropdown (`stitchProjectSelect`) so switching projects in one place reflects in the other.
- **Dependencies & Conflicts:** Backend `listDesignSystems()` from the Stitch SDK (`loadStitch`); the same call is used at [2146](src/services/DesignPanelProvider.ts#L2146) and [2179](src/services/DesignPanelProvider.ts#L2179) where the mapping already tries `ds.data?.name` as an alternative — a hint that `name` may be the real field.

## Proposed Changes

### 1. `src/webview/design.html` — add a project selector to the Design Systems panel
In the Design Systems panel header (near [3700](src/webview/design.html#L3700)), add a `<select id="design-system-project-select" class="workspace-filter-select">` alongside the `STITCH PROJECT:` label (or replace the static label), plus keep the existing Create/Refresh buttons.

### 2. `src/webview/design.js` — populate and wire the new selector
- When the project list arrives (the same payload that fills `stitchProjectSelect`, see `populate` near [2113-2137](src/webview/design.js#L2113)), also populate `design-system-project-select` and preselect `state.selectedStitchProjectId`.
- Add a `change` listener that sets `state.selectedStitchProjectId`, mirrors the value into `stitchProjectSelect`, and calls `refreshStitchDesignSystems()`.
- In `refreshStitchDesignSystems()`, drive the project name label from the new selector.

### 3. `src/services/DesignPanelProvider.ts` — correct the field mapping (data-driven)
First, temporarily log one raw `ds` from `project.listDesignSystems()` ([1653](src/services/DesignPanelProvider.ts#L1653)) to confirm the real shape. Then fix the mapping to read the actual fields, e.g.:
```ts
displayName: ds.data?.displayName || ds.data?.name || ds.name || `Design System ${ds.id}`,
styleGuidelines: ds.data?.styleGuidelines || ds.data?.guidelines || '',
```
Carry through any meaningful token/summary fields so the card has content.

### 4. `src/webview/design.js` — make the card resilient
In `renderStitchDesignSystems()`, when `displayName` is empty/equal to the id, render a friendly fallback title and surface the guidelines/token summary so the card is never just a bare id. Only show the raw id as a small secondary label.

## Verification Plan

1. Build; with a Stitch project that has at least one design system, open Design → Design Systems sub-tab **without** first visiting Screens → confirm a project dropdown is present and selectable.
2. Select a project → confirm design systems load and each card shows a real name and its style guidelines/tokens — not a bare numeric id.
3. Switch projects via the new dropdown → confirm the list refreshes and the Screens-tab dropdown stays in sync.
4. With the temporary log, confirm the corrected field mapping matches the actual SDK response; then remove the log.
5. Project with zero design systems → confirm the existing "No design systems found" empty state still shows.
