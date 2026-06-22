# Fix the Stitch Design Systems Tab: Add a Project Dropdown and Render Real Data

## Goal

In `design.html`, the **Stitch Design Systems** sub-tab works poorly: there is no dropdown to select a Stitch project from within the tab, and when a design system loads it shows no useful information — just a "string of random numbers." Fix both: provide a project selector in the Design Systems panel, and render meaningful design-system data.

### Problem Analysis

**No project dropdown in the Design Systems panel.** The project `<select id="stitch-project-select">` lives in the *Screens* sub-tab ([design.html:3847](src/webview/design.html#L3847)). The Design Systems panel only shows a static label `STITCH PROJECT: None Selected` ([design.html:3700-3701](src/webview/design.html#L3700)) with no selector of its own. `refreshStitchDesignSystems()` ([design.js:3700](src/webview/design.js#L3700)) early-returns with "No Stitch project selected" whenever `state.selectedStitchProjectId` is falsy — and that value is only ever set by the Screens-tab dropdown. So a user landing on Design Systems first has no way to pick a project.

**"String of random numbers."** Cards are rendered by `renderStitchDesignSystems()` ([design.js:3736](src/webview/design.js#L3736)) using `ds.displayName`, `ds.id`, and `ds.styleGuidelines`. The backend maps the list in [DesignPanelProvider.ts:1655-1662](src/services/DesignPanelProvider.ts#L1655):
```ts
const designSystems = list.map((ds: any) => ({
    id: ds.id,
    displayName: ds.data?.displayName || ds.id,   // falls back to the raw id
    styleGuidelines: ds.data?.styleGuidelines || '',
    designTokens: typeof ds.data?.designTokens === 'string'
        ? ds.data.designTokens
        : JSON.stringify(ds.data?.designTokens || {})
}));
```
When the Stitch SDK design-system object does not expose `data.displayName` / `data.styleGuidelines` under those exact keys, `displayName` falls back to `ds.id` (an opaque numeric/hash id) and guidelines render empty — so the card title AND the id label both show the same "random numbers," with no real content.

**Mapping inconsistency across consumers (key finding).** There are THREE consumers of `project.listDesignSystems()` in `DesignPanelProvider.ts`:
- The list handler at [line 1657](src/services/DesignPanelProvider.ts#L1657): `ds.data?.displayName || ds.id` — **no `name` fallback**.
- The DESIGN.md generator at [line 2151](src/services/DesignPanelProvider.ts#L2151): `ds.data?.displayName || ds.data?.name || ds.id` — **has `name` fallback**.
- The palette downloader at [line 2198](src/services/DesignPanelProvider.ts#L2198): `ds.data?.displayName || ds.data?.name || ds.id` — **has `name` fallback**.

The list handler is the only one missing the `ds.data?.name` fallback. This is a copy-paste omission and the most likely root cause of the "random numbers" symptom — the SDK returns `name` (not `displayName`) on read, even though the create/update handlers write `displayName` ([line 1688](src/services/DesignPanelProvider.ts#L1688), [line 1724](src/services/DesignPanelProvider.ts#L1724)). This write/read field asymmetry is a known SDK quirk.

### Root Cause

1. The Design Systems panel has no project selector and depends on a selection made in a different sub-tab.
2. The backend field mapping (`ds.data?.displayName` / `styleGuidelines`) in the list handler does not match the actual Stitch design-system object shape — it is missing the `ds.data?.name` fallback that the other two consumers already use. So names/guidelines are empty and only the raw id surfaces.
3. `designTokens` is stringified to `'{}'` (literal braces) when empty, which renders as meaningless content.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, ui, bugfix

## User Review Required

Yes — the field-mapping fix depends on confirming the actual Stitch SDK response shape. The plan includes a one-time temporary log to verify the `name` vs `displayName` asymmetry before finalizing the fallback chain. The user should verify the log output matches the assumed shape. Additionally, the user should confirm the desired sync behavior: the Design Systems dropdown mirrors the Screens-tab dropdown value but does NOT proactively refresh Screens-tab data (screens refresh on next visit to the Screens tab). If the user wants full bidirectional data sync, the plan must be adjusted.

## Complexity Audit

### Routine
- Adding a project `<select id="design-system-project-select">` to the Design Systems panel header ([design.html:3698-3707](src/webview/design.html#L3698)), populated from the same project list used by the Screens tab.
- Wiring its `change` listener to set `state.selectedStitchProjectId`, mirror the value into `stitchProjectSelect`, persist, and call `refreshStitchDesignSystems()`.
- Populating the new dropdown inside the existing `populateStitchProjects()` function ([design.js:2112](src/webview/design.js#L2112)) — same `stitchProjectsReady` payload, no separate loading race.
- Repurposing the `design-system-no-project` empty state ([design.html:3710-3713](src/webview/design.html#L3710)) to say "Select a project above" instead of "Go to Stitch Tab."
- Fixing the `'{}'` emission: emit `designTokens: ''` when empty in the backend, render "No design tokens" in the card.

### Complex / Risky
- Unifying the field mapping across all three `listDesignSystems()` consumers to use a consistent fallback chain (`ds.data?.displayName || ds.data?.name || ds.name || fallback`). The write/read asymmetry (`displayName` on write, `name` on read) is an SDK quirk that must be confirmed via a temporary log and then handled defensively.
- Dropdown sync semantics: the Design Systems dropdown mirrors the value into `stitchProjectSelect` but does NOT replay the Screens-tab `change` handler's side effects (screen fetch, poll clearing, preview close). This is a deliberate choice — screens data refreshes on next visit to the Screens tab. Must be documented to avoid confusion.

## Edge-Case & Dependency Audit

- **Race Conditions:** The new dropdown is populated inside `populateStitchProjects()` which runs on `stitchProjectsReady` ([design.js:2932-2934](src/webview/design.js#L2932)). If the user navigates to Design Systems before that message arrives, the dropdown is empty but `refreshStitchDesignSystems()` early-returns on falsy `selectedStitchProjectId` — no fetch occurs. Once projects arrive, both dropdowns populate. No additional guard needed; the existing flow handles it.
- **Security:** None new (existing Stitch auth gate at [1641-1644](src/services/DesignPanelProvider.ts#L1641) stays).
- **Side Effects:** A Design-Systems-panel dropdown that writes `state.selectedStitchProjectId` must mirror the value into `stitchProjectSelect` so the Screens tab shows the correct project on next visit. It must NOT call `stitchProjectSelect.dispatchEvent(new Event('change'))` because that would replay screen-fetch side effects from an unrelated tab. Value sync only; data sync is deferred.
- **Dependencies & Conflicts:** Backend `listDesignSystems()` from the Stitch SDK (`loadStitch`); the same call is used at [2146](src/services/DesignPanelProvider.ts#L2146) and [2179](src/services/DesignPanelProvider.ts#L2179) where the mapping already tries `ds.data?.name` — confirming `name` is the likely real field. The fix unifies all three to the same fallback chain.

## Dependencies

- None — this plan is self-contained within `design.html`, `design.js`, and `DesignPanelProvider.ts`.

## Adversarial Synthesis

Key risks: (1) the field-mapping fix assumes `ds.data?.name` is the real read field based on the other two consumers, but this must be confirmed via a temporary log before relying on it; (2) the dropdown sync only mirrors the value, not the Screens-tab side effects, which could confuse users who expect switching projects in Design Systems to also refresh screens; (3) the `design-system-no-project` empty state becomes contradictory once a dropdown is in-panel and must be repurposed. Mitigations: unify all three mappings with a defensive fallback chain, document the sync semantics explicitly in the plan and code comments, and repurpose the empty state to point at the new dropdown.

## Proposed Changes

### 1. `src/webview/design.html` — add a project selector to the Design Systems panel
In the Design Systems panel header (near [3700](src/webview/design.html#L3700)), add a `<select id="design-system-project-select" class="workspace-filter-select">` alongside the `STITCH PROJECT:` label (or replace the static label), plus keep the existing Create/Refresh buttons. The `design-system-project-name` strong tag can remain as a read-only display of the selected project name, kept in sync with the dropdown's selected option text.

**Repurpose the empty state:** Update `design-system-no-project` ([3710-3713](src/webview/design.html#L3710)) to say "Select a project from the dropdown above" instead of "No Stitch project selected." Keep the "Go to Stitch Tab" button as a secondary affordance (it still has value for users who want to generate screens), or remove it if the dropdown makes it redundant — prefer keeping it as secondary.

### 2. `src/webview/design.js` — populate and wire the new selector
- In `populateStitchProjects()` ([2112-2138](src/webview/design.js#L2112)), after populating `stitchProjectSelect`, also populate `design-system-project-select` with the same sorted project list and preselect `state.selectedStitchProjectId`. Use the same `<option value="">Select Project...</option>` placeholder.
- Add a `change` listener on `design-system-project-select` that:
  1. Sets `state.selectedStitchProjectId` to the selected value.
  2. Mirrors the value into `stitchProjectSelect` (`stitchProjectSelect.value = projectId`) — value sync only, do NOT dispatch a `change` event.
  3. Persists via `persistTab('stitch.projectId', projectId, state.stitchWorkspaceRoot)` if `state.stitchWorkspaceRoot` is set.
  4. Calls `refreshStitchDesignSystems()`.
- In `refreshStitchDesignSystems()` ([3700](src/webview/design.js#L3700)), update the `design-system-project-name` label from the new selector's selected option (or keep using `stitchProjectSelect` since both are mirrored — either works, but prefer the new selector as the source of truth when present).

### 3. `src/services/DesignPanelProvider.ts` — correct and unify the field mapping
First, temporarily log one raw `ds` from `project.listDesignSystems()` ([1654](src/services/DesignPanelProvider.ts#L1654)) to confirm the real shape (expect `ds.data?.name` to be populated). Then fix the list handler mapping at [1655-1662](src/services/DesignPanelProvider.ts#L1655) to match the other two consumers:
```ts
const designSystems = list.map((ds: any) => ({
    id: ds.id,
    displayName: ds.data?.displayName || ds.data?.name || ds.name || `Design System ${ds.id}`,
    styleGuidelines: ds.data?.styleGuidelines || ds.data?.guidelines || '',
    designTokens: ds.data?.designTokens
        ? (typeof ds.data.designTokens === 'string'
            ? ds.data.designTokens
            : JSON.stringify(ds.data.designTokens))
        : ''
}));
```
Key changes: add `ds.data?.name` and `ds.name` fallbacks for `displayName`; add `ds.data?.guidelines` fallback for `styleGuidelines`; emit `''` (empty string) instead of `'{}'` when there are no design tokens. Remove the temporary log after confirming the shape.

**Clarification (not new scope):** The create/update handlers write `{ displayName, styleGuidelines, designTokens }` ([1688](src/services/DesignPanelProvider.ts#L1688), [1724](src/services/DesignPanelProvider.ts#L1724)). The SDK appears to return `name` on read even when `displayName` is written — a known asymmetry. The defensive fallback chain handles this without requiring a SDK fix.

### 4. `src/webview/design.js` — make the card resilient
In `renderStitchDesignSystems()` ([3736-3819](src/webview/design.js#L3736)):
- When `displayName` is empty or equal to the id, render a friendly fallback title (e.g. `Design System` + short id suffix) instead of the bare id.
- Surface the guidelines/token summary so the card is never just a bare id. Only show the raw id as a small secondary label (already done at [3770-3774](src/webview/design.js#L3770)).
- When `designTokens` is empty string `''`, render "No design tokens" instead of `'{}'` or empty space.
- When `styleGuidelines` is empty, the existing "No style guidelines provided." fallback at [3784](src/webview/design.js#L3784) is correct — keep it.

## Verification Plan

### Automated Tests
- None — this plan touches webview UI and a backend field mapping that depends on a live Stitch SDK response shape. Automated tests are out of scope; verification is manual.

### Manual Verification
1. With a Stitch project that has at least one design system, open Design → Design Systems sub-tab **without** first visiting Screens → confirm a project dropdown is present and selectable.
2. Select a project → confirm design systems load and each card shows a real name and its style guidelines/tokens — not a bare numeric id.
3. Switch projects via the new dropdown → confirm the list refreshes and the Screens-tab dropdown (`stitchProjectSelect`) shows the same project (value mirrored). Confirm that screens data is NOT fetched until the user visits the Screens tab (by design).
4. With the temporary log, confirm the corrected field mapping matches the actual SDK response (expect `ds.data?.name` populated); then remove the log.
5. Project with zero design systems → confirm the existing "No design systems found" empty state still shows.
6. Project with a design system that has no tokens → confirm the card shows "No design tokens" instead of `'{}'`.
7. Design system with no guidelines → confirm "No style guidelines provided." still shows.

---

**Recommendation:** Complexity 5 → **Send to Coder.**
