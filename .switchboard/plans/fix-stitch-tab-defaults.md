# Fix Stitch Tab: Auto-Select Most Recent Project and Default to Gallery View

## Goal

On initial Stitch tab load, automatically select the most recently updated project (or the only project if there is just one). When a project is selected, show the gallery grid of all screens as the default view instead of auto-opening a single-screen preview. Preserve the ability for the user to manually click into a single-screen preview from the gallery.

### Core Problem & Background

The Stitch tab in `design.html` has two UX regressions that force extra clicks on every session:

1. **No auto-selection of the most recent project.** When the tab loads, the project dropdown is left on "Select Project..." even when projects exist. The current logic relies on a static VS Code: setting (`switchboard.stitch.defaultProjectId`) that is usually empty. There is no fallback to the most recently updated project from the live Stitch API list.

2. **Preview mode opens automatically.** When a project with existing screens is selected, the code immediately opens the first screen in the single-screen preview pane, hiding the gallery grid. Users who want to browse all screens must manually close the preview every time.

### Root Cause

**Cause 1 — Static fallback, no recency heuristic**

In `DesignPanelProvider.ts` at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/DesignPanelProvider.ts:1160`, the `defaultProjectId` sent to the webview is read from extension settings:

```typescript
const defaultProjectId = config.get<string>('stitch.defaultProjectId') || '';
```

If the setting is unset, the webview receives `''`. The webview then tries `state.selectedStitchProjectId || dropdown.value || defaultProjectId || ''` at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2060`, all of which are empty on first load, leaving the dropdown unselected.

The `stitch.projects()` call returns project objects, but the provider maps only `id` and `name` at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/DesignPanelProvider.ts:1158`, discarding any timestamp fields (`updateTime`, `createTime`) that could be used for recency sorting.

**Cause 2 — Unconditional auto-preview**

In `design.js` at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2802-2804`, the `stitchScreensReady` message handler contains this guard:

```javascript
if (screens.length > 0 && !state.activePreviewScreenId) {
    openStitchPreview(screens[0]);
}
```

This unconditionally launches the preview pane whenever screens are loaded and no preview is already open. The gallery (`stitchGallery`) is hidden and the single-screen preview is shown instead.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, bugfix, ux, api

## User Review Required

- None

## Complexity Audit

### Routine
- Mapping one additional field (`updateTime`) from an existing API response in two message handlers.
- Adding a client-side array sort (`Array.prototype.sort`) in the webview.
- Removing an unconditional `openStitchPreview` call.
- Adjusting selection-priority logic in a single function.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- **Workspace-root switch race:** The workspace-filter change handler at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2983-3033` resets `selectedStitchProjectId`, restores persisted state, then posts `stitchListProjects`. When `stitchProjectsReady` arrives, `populateStitchProjects` must correctly respect the restored `selectedStitchProjectId` instead of overriding it with the most-recent fallback. The proposed selection priority (persisted > default > most recent) handles this naturally.
- **create-project vs. list-projects race:** `stitchCreateProject` posts `stitchProjectsReady` with `selectProjectId`. The `stitchProjectsReady` handler at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2780-2782` branches on `msg.selectProjectId` and skips the automatic screen-load path, so the new-project flow is unaffected.

### Security
- No changes to input validation, CSP, or secrets. The new `updateTime` field is a read-only ISO timestamp string passed straight through; no XSS vector is introduced.

### Side Effects
- Removing the auto-preview call means `state.activePreviewScreenId` stays `null` after `stitchScreensReady`. `renderStitchScreens` already branches on this to show the gallery, so the side effect is expected and desired.
- Sorting projects by recency changes the dropdown order. This is an intentional UX improvement.

### Dependencies & Conflicts
- Depends on the Stitch SDK `Project.data` shape, which exposes `updateTime` and `createTime` per the generated types at `@/Users/patrickvuleta/Documents/GitHub/switchboard/node_modules/@google/stitch-sdk/dist/generated/src/types.generated.d.ts` (fields `updateTime?: string` and `createTime?: string`). If the API omits these fields, the sort comparator must fall back to stable ordering.
- No conflicts with other open plans.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) The Stitch API may omit `updateTime`/`createTime`, making recency sorting unreliable; mitigation is a defensive comparator that falls back to stable order. (2) Removing auto-preview could confuse power users who relied on it; mitigation is that the gallery remains one click away and matches the stated UX goal. (3) Sorting the dropdown by recency changes muscle memory for users accustomed to API order; this is accepted as an intentional improvement.

## Proposed Changes

### `src/services/DesignPanelProvider.ts`

**Context:** The `stitchListProjects` and `stitchCreateProject` message handlers map the raw Stitch SDK project list to a minimal `{ id, name }` object. The generated SDK types (`ProjectInput`) include `updateTime?: string` and `createTime?: string`.

**Logic:** Include the recency timestamp in the mapped project object so the webview can sort and default-select the most recent project.

**Implementation:**
- At `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/DesignPanelProvider.ts:1158`, change the map expression inside `stitchListProjects` from:
  ```typescript
  const projects = list.map((p: any) => ({ id: p.id, name: p.data?.title || p.data?.name || p.id }));
  ```
  to:
  ```typescript
  const projects = list.map((p: any) => ({
      id: p.id,
      name: p.data?.title || p.data?.name || p.id,
      updateTime: p.data?.updateTime || p.data?.createTime || ''
  }));
  ```
- At `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/DesignPanelProvider.ts:1203`, apply the same mapping in `stitchCreateProject`.

**Edge Cases:**
- If `updateTime` and `createTime` are both absent, `updateTime` becomes `''`. The webview sort comparator must treat `''` as epoch zero so those projects sink to the bottom.

### `src/webview/design.js`

**Context:** `populateStitchProjects(projects, defaultProjectId)` at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2057` builds the `<select>` dropdown and picks the initially selected option. The current priority is `state.selectedStitchProjectId || dropdown.value || defaultProjectId || ''`, which falls through to empty string when no persisted state or config default exists.

**Logic:**
1. Sort the incoming `projects` array by `updateTime` descending before populating the dropdown.
2. Change the selection priority to: persisted per-workspace selection > `defaultProjectId` (used for newly created projects) > first project in the sorted list (most recent).
3. If the final selection comes from the sorted fallback (not persisted or default), automatically request the project's screens so the user sees the gallery immediately.

**Implementation:**
- In `populateStitchProjects` at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2057`:
  1. Add a sort before the existing `projects.forEach`:
     ```javascript
     const sortedProjects = [...projects].sort((a, b) => {
         const ta = a.updateTime ? new Date(a.updateTime).getTime() : 0;
         const tb = b.updateTime ? new Date(b.updateTime).getTime() : 0;
         return tb - ta;
     });
     ```
  2. Iterate over `sortedProjects` when building `<option>` elements.
  3. Replace the `current` selection logic with:
     ```javascript
     const current = state.selectedStitchProjectId || defaultProjectId || sortedProjects[0]?.id || '';
     ```
     (Remove `stitchProjectSelect.value` from the fallback chain; it is always `''` immediately after the dropdown is cleared.)
  4. After setting `state.selectedStitchProjectId = stitchProjectSelect.value`, check whether the selection was driven by the recency fallback (i.e., `!state.selectedStitchProjectId` before the call and `sortedProjects.length > 0`). If so, trigger `stitchGetProjectScreens` so the gallery loads automatically:
     ```javascript
     if (!state.selectedStitchProjectId && sortedProjects.length > 0) {
         state.selectedStitchProjectId = stitchProjectSelect.value;
         vscode.postMessage({
             type: 'stitchGetProjectScreens',
             projectId: state.selectedStitchProjectId,
             workspaceRoot: state.stitchWorkspaceRoot
         });
     }
     ```
     *Clarification:* The exact conditional shape should be refined so it only fires on the first-time fallback, not on every `populateStitchProjects` call. A simpler approach: after `populateStitchProjects` returns in the `stitchProjectsReady` handler, if `state.selectedStitchProjectId` is truthy and no screens are loaded yet, the existing handler at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2783-2791` already posts `stitchGetProjectScreens`. Therefore, the only change needed inside `populateStitchProjects` is to set `state.selectedStitchProjectId` correctly; the existing `stitchProjectsReady` branch will handle the screen load.

- In the `stitchScreensReady` message handler at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2797-2806`, remove the unconditional auto-preview block:
  ```javascript
  if (screens.length > 0 && !state.activePreviewScreenId) {
      openStitchPreview(screens[0]);
  }
  ```
  After removal, `renderStitchScreens(screens)` at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2800` will show the gallery because `state.activePreviewScreenId` is `null`.

**Edge Cases:**
- Empty project list (`sortedProjects.length === 0`): dropdown shows only "Select Project..."; no auto-selection or screen load occurs.
- Single project: `sortedProjects[0]` is selected automatically (satisfies R3).
- Persisted selection exists: `state.selectedStitchProjectId` is already set by the boot or workspace-switch logic at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2358-2359` and `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2406-2407`; the new `current` formula preserves it (satisfies R5).
- Newly created project: `stitchCreateProject` sends `selectProjectId`, and the `stitchProjectsReady` handler at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:2780-2782` bypasses the automatic screen-load path, rendering an empty gallery (satisfies E2).
- Missing timestamps: projects with absent `updateTime` sort to the bottom; if *all* projects lack timestamps, the fallback order is the original API order.

## Verification Plan

### Manual

- [ ] Open the Design panel → Stitch tab with multiple projects. The most recently updated project should be selected and its gallery shown.
- [ ] Switch to a different workspace root with a different persisted project. The persisted project should be restored.
- [ ] Create a new project. The new project should be selected (existing behaviour) with an empty gallery.
- [ ] Select a project with existing screens. The gallery grid should appear, not the single-screen preview.
- [ ] Click a gallery card. The single-screen preview should open (existing behaviour).
- [ ] Press Escape. The gallery should re-appear.

### Automated Tests

- **Skipped per session directive.** No compilation or test execution required.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Stitch API project objects do not contain `updateTime` / `createTime` fields | The defensive comparator falls back to `0` for missing timestamps, preserving stable API order. If *no* timestamps exist anywhere, auto-selection still works (it simply picks the first project in API order). |
| Removing auto-preview breaks a workflow where users expect the latest screen to open immediately | This is the exact UX complaint. The gallery is the correct default; users can click the first card in one click if they want the preview. |
| Sorting changes the dropdown order users are accustomed to | Sorting by recency is an intentional UX improvement. If preserving original API order is important, keep the original order in the dropdown and only use the sorted list for default selection. |

## Files Changed

- `src/services/DesignPanelProvider.ts`
- `src/webview/design.js`

## Recommendation

Send to Intern
