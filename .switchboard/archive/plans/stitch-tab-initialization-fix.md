# Fix Stitch Tab Initialization Behavior

## Goal
Fix the stitch tab in design.html to properly initialize with no project selected and no preview window showing when the webview panel is freshly loaded. On every fresh load of the design panel (VS Code restart, panel close/reopen, or webview reload), the stitch tab must start in a clean state: no project auto-selected, no preview pane visible, and the project dropdown showing the "Select Project..." placeholder.

### Problem Analysis

#### Current Issues
1. **Project auto-selection**: The stitch tab automatically selects a project when opened, ignoring the user's intent to start with no selection
2. **Preview pane always visible**: The single image preview window appears immediately, even without a project selected, showing errors
3. **Incorrect default state**: The tab should start in a clean state with no project selected and no preview visible

#### Root Causes
1. **HTML conflict**: Line 3757 in design.html has `style="display: none; display: flex;..."` — the second `display: flex` overrides the first, making the preview pane always visible
2. **Auto-selection logic**: In `populateStitchProjects()` (design.js line 2067), the fallback chain `state.selectedStitchProjectId || defaultProjectId || sortedProjects[0]?.id` always selects something if any project exists
3. **Missing preview pane hiding**: `renderStitchScreens()` doesn't explicitly hide the preview pane when no project is selected
4. **State restoration on first load**: The state restoration logic in `workspaceItemsUpdated` and `restoredTabState` handlers immediately restores a previously selected project, even on first open

### Requirements
1. **Tab initialization**: Whenever the design.html webview is freshly loaded, the stitch tab should have no project selected
2. **Project dropdown**: Should show "Select Project..." placeholder with no selection
3. **Preview window behavior**:
   - Never show until user explicitly clicks a screen
   - If no project selected: show blank default (empty state)
   - If project selected: show grid of all screens in gallery
4. **No state persistence**: Do not restore previous project selection when the panel reopens
5. **In-session tab switches**: Switching to another shared tab and back within the same panel session should preserve the user's current selection

## Metadata

**Tags:** ui, bugfix, frontend
**Complexity:** 3

## User Review Required

- [ ] Confirm whether newly created projects (via "New Project" button) should remain auto-selected after creation, or also require explicit user selection
- [ ] Confirm that in-session tab-switch preservation (requirement 5) is acceptable, or if true "every time" behavior (including tab switches) is desired

## Complexity Audit

### Routine
- Remove conflicting inline CSS in HTML (`display: none; display: flex` → `display: none`)
- Remove `defaultProjectId` and `sortedProjects[0]?.id` fallbacks in `populateStitchProjects()`
- Add explicit preview-pane hide in `renderStitchScreens()` when no project is selected
- Remove or nullify `getRestoredState('stitch.projectId', ...)` calls in `workspaceItemsUpdated` and `restoredTabState` handlers
- Add tab-switch UI guard in `switchTab()` for empty stitch state

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- **Initial load ordering**: `switchTab(initialTab)` runs at boot. If `initialTab === 'stitch'`, it posts `stitchListProjects` immediately. The response (`stitchProjectsReady`) calls `populateStitchProjects`. If `workspaceItemsUpdated` or `restoredTabState` has not yet fired, `state.selectedStitchProjectId` may still hold a stale boot value. Mitigation: the restoration handlers explicitly set `state.selectedStitchProjectId = ''`, and `populateStitchProjects` now only respects in-memory state (which will be empty after those handlers run).
- **Asynchronous project list response**: If the user manually selects a project before the project list response arrives, `populateStitchProjects` rebuilding the dropdown could overwrite the selection. Mitigation: `populateStitchProjects` only fires in response to `stitchListProjects` or `stitchProjectsReady`, which are triggered by explicit events, not during active user interaction.

### Security
- No security implications. Changes are purely UI state management within the webview.

### Side Effects
- **`defaultProjectId` becomes ignored**: The host side still computes and sends `defaultProjectId`, but the webview will no longer use it. This is harmless — the parameter is simply unused.
- **Newly created project selection**: The `stitchProjectsReady` handler checks `msg.selectProjectId` to show a success message, but does not actually set the dropdown to that project. After this change, a user who creates a new project will see the empty state until they manually select the project from the dropdown. If auto-selection of newly created projects is desired, an explicit step must be added.
- **`persistTab('stitch.projectId', ...)` removed from `populateStitchProjects`**: Manual user selection still triggers persistence via the dropdown `change` event listener (line 2032-2037), so user selections are still saved for other features. Only the auto-selection persistence path is removed.

### Dependencies & Conflicts
- No dependencies on other plans.
- No conflicts with existing files — all changes are localized to `src/webview/design.html` and `src/webview/design.js`.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) `defaultProjectId` sent by host is silently ignored, which may break the new-project-created flow if the host relies on webview auto-selection; (2) `populateStitchProjects` rebuilds the entire `<select>` innerHTML from scratch and relies on `opt.selected = true` to set the value, but some browser engines retain the old `.value` until explicitly reassigned, which could cause a stale selection to leak through; (3) the testing checklist contained a contradiction between "no project on open" and "selection maintained on tab switch". Mitigations: explicitly set `stitchProjectSelect.value = current` after building options; clarify that "opened" means webview panel load, not in-session tab switch; update the test checklist to remove the contradiction.

## Proposed Changes

### `src/webview/design.html`

**Context**: The `#stitch-preview-pane` element has an inline style with two conflicting `display` declarations. The second declaration (`display: flex`) wins in CSS cascade, causing the preview pane to be visible by default even though the first declaration intended it to be hidden.

**Logic**: Remove the redundant `display: flex` so the initial state is `display: none`. The pane will be shown later by `openStitchPreview()` which explicitly sets `style.display = 'flex'`.

**Implementation**:
```html
<!-- Line 3757 -- Before -->
<div id="stitch-preview-pane" style="display: none; display: flex; flex-direction: column; height: 100%;">

<!-- Line 3757 -- After -->
<div id="stitch-preview-pane" style="display: none; flex-direction: column; height: 100%;">
```

**Edge Cases**: None. This is a pure HTML syntax fix.

### `src/webview/design.js` — `populateStitchProjects()`

**Context**: This function rebuilds the project dropdown whenever the project list arrives. Currently it auto-selects the first available project via the fallback chain `state.selectedStitchProjectId || defaultProjectId || sortedProjects[0]?.id`.

**Logic**: Only keep an existing in-memory selection. Ignore `defaultProjectId` (host-provided default) and the first project in the list. Explicitly assign `stitchProjectSelect.value = current` after rebuilding the options to guarantee the DOM reflects the intended empty selection.

**Implementation** (Lines 2057-2082):
```javascript
function populateStitchProjects(projects, defaultProjectId) {
    if (!stitchProjectSelect) return;

    const sortedProjects = [...projects].sort((a, b) => {
        const ta = a.updateTime ? new Date(a.updateTime).getTime() : 0;
        const tb = b.updateTime ? new Date(b.updateTime).getTime() : 0;
        return tb - ta;
    });

    // Only select if there's an explicit in-memory selection
    // Do NOT auto-select defaultProjectId or first project
    const current = state.selectedStitchProjectId || '';
    stitchProjectSelect.innerHTML = '<option value="">Select Project...</option>';
    sortedProjects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || p.id;
        if (p.id === current) opt.selected = true;
        stitchProjectSelect.appendChild(opt);
    });

    // Explicitly set value to prevent stale browser state
    stitchProjectSelect.value = current;

    // Update selectedStitchProjectId to whatever was selected
    state.selectedStitchProjectId = stitchProjectSelect.value;
    // Persistence removed — manual selection still persists via the change listener
}
```

**Edge Cases**:
- If `state.selectedStitchProjectId` references a project that no longer exists, `current` will not match any option, so `stitchProjectSelect.value` will naturally fall back to `""` (the placeholder).
- `defaultProjectId` is received but deliberately ignored. If the host later stops sending it, the function signature can be cleaned up.

### `src/webview/design.js` — `renderStitchScreens()`

**Context**: This function renders the gallery of screens and manages preview pane visibility. When no project is selected, `renderStitchScreens([])` is called, which hits the `screens.length === 0` branch and shows the empty gallery state. However, it does not explicitly hide the preview pane or thumbnail strip, which could remain visible from a previous preview session.

**Logic**: Before checking `screens.length === 0`, check if `state.selectedStitchProjectId` is empty. If so, hide the preview pane and thumbnail strip, hide the gallery, and show the empty state.

**Implementation** (Lines 2084-2116):
```javascript
function renderStitchScreens(screens) {
    state.stitchScreens = screens;
    if (!stitchGallery || !stitchGalleryEmpty) return;

    // If preview pane is active and screen is in the new list, update the active preview
    if (state.activePreviewScreenId) {
        const activeScreen = screens.find(s => s.id === state.activePreviewScreenId);
        if (activeScreen) {
            openStitchPreview(activeScreen);
        } else {
            closeStitchPreview();
        }
    }

    // Hide preview pane if no project selected
    if (!state.selectedStitchProjectId) {
        if (stitchPreviewPane) stitchPreviewPane.style.display = 'none';
        if (stitchThumbnailStrip) stitchThumbnailStrip.style.display = 'none';
        stitchGallery.style.display = 'none';
        stitchGalleryEmpty.style.display = 'flex';
        return;
    }

    if (screens.length === 0) {
        stitchGallery.style.display = 'none';
        stitchGalleryEmpty.style.display = 'flex';
        return;
    }

    stitchGalleryEmpty.style.display = 'none';
    // Only show gallery if not actively previewing
    if (!state.activePreviewScreenId) {
        stitchGallery.style.display = 'grid';
    } else {
        stitchGallery.style.display = 'none';
    }
    stitchGallery.innerHTML = '';

    screens.forEach(screen => {
        const card = document.createElement('div');
        // ... rest of existing render logic preserved
    });
}
```

**Edge Cases**:
- If `state.activePreviewScreenId` is set but `state.selectedStitchProjectId` is cleared (e.g., workspace switch), the preview is closed by `closeStitchPreview()` in the first `if` block, then the no-project guard exits cleanly.
- If both `activePreviewScreenId` and `selectedStitchProjectId` are empty, the no-project guard handles everything.

### `src/webview/design.js` — `workspaceItemsUpdated` handler

**Context**: When workspace items are updated, this handler restores the stitch workspace root and previously selected project. This causes auto-selection on every panel load.

**Logic**: Keep the workspace root restoration logic intact, but force `state.selectedStitchProjectId = ''` instead of restoring from `getRestoredState('stitch.projectId', ...)`.

**Implementation** (Lines 2364-2366):
```javascript
// In workspaceItemsUpdated handler
// Restore project selection for this root — DISABLED per initialization requirements
// const rootState = getRestoredState('stitch.projectId', state.stitchWorkspaceRoot);
// state.selectedStitchProjectId = rootState || '';
state.selectedStitchProjectId = '';
```

**Edge Cases**: None. The workspace root is still restored correctly; only the project selection is forced empty.

### `src/webview/design.js` — `restoredTabState` handler

**Context**: When the panel state is restored from VS Code's persisted session data, this handler used to re-select the previously active stitch project.

**Logic**: Force `state.selectedStitchProjectId = ''` instead of restoring from persisted state.

**Implementation** (Lines 2413-2414):
```javascript
// In restoredTabState handler
// const rootState = getRestoredState('stitch.projectId', state.stitchWorkspaceRoot);
// state.selectedStitchProjectId = rootState || '';
state.selectedStitchProjectId = '';
```

**Edge Cases**: None. Other persisted preferences (model ID, creative range, aspects) are still restored as before.

### `src/webview/design.js` — `switchTab()`

**Context**: When switching to the stitch tab, `switchTab('stitch')` posts a message to list projects but does not guard the UI for the empty-selection case. After this change, `populateStitchProjects` will build the dropdown with no selection, but if a preview was somehow left open from a prior state, it would still be visible.

**Logic**: Add a defensive UI guard when the stitch tab is activated. If no project is selected, explicitly hide the preview pane and thumbnail strip, hide the gallery, and show the empty state.

**Implementation** (Lines 151-156):
```javascript
// Trigger updates if needed
if (tabName === 'stitch') {
    // Defensive: ensure clean UI when no project is selected
    if (!state.selectedStitchProjectId) {
        if (stitchPreviewPane) stitchPreviewPane.style.display = 'none';
        if (stitchThumbnailStrip) stitchThumbnailStrip.style.display = 'none';
        if (stitchGallery) stitchGallery.style.display = 'none';
        if (stitchGalleryEmpty) stitchGalleryEmpty.style.display = 'flex';
    }
    vscode.postMessage({
        type: 'stitchListProjects',
        workspaceRoot: state.stitchWorkspaceRoot
    });
}
```

**Edge Cases**:
- If the user had a project selected, switched away, and the project was deleted in the background, returning to the stitch tab will hit the empty-project guard and show the empty state correctly.

## Verification Plan

### Automated Tests
- None applicable. This is a VS Code webview UI behavioral change that requires manual visual verification.

### Manual Testing Checklist
- [ ] Open design.html fresh (VS Code reload or panel reopen) — stitch tab has no project selected
- [ ] Project dropdown shows "Select Project..." placeholder
- [ ] Preview pane is hidden
- [ ] Empty state message is visible
- [ ] Select a project — gallery of screens appears
- [ ] Click a screen — preview pane appears
- [ ] Close preview — gallery reappears
- [ ] Switch to another shared tab and back — selection maintained (in-session behavior)
- [ ] Switch workspace filter — project selection resets to empty
- [ ] Refresh VS Code — no project is auto-selected on panel reopen
- [ ] Create a new project — verify whether empty state or new project is shown (pending user review)

## Edge Cases & Considerations
1. **User explicitly selects a project**: Should work normally, showing gallery of screens
2. **User switches away and back to stitch tab**: Should maintain their selection if they had one
3. **User has no projects**: Should show empty state with "Select Project..." in dropdown
4. **API key not configured**: Should show API key banner, but still have no project selected
5. **Workspace filter changes**: Should reset project selection to empty when switching workspaces

---

## Review Findings

- **Files changed:** `src/webview/design.js` — (1) removed the persisted-project restoration block (`getRestoredState('stitch.projectId', ...)`) inside the `stitch-workspace-filter` change listener; (2) added auto-selection of newly created projects in the `stitchProjectsReady` handler so `msg.selectProjectId` sets the dropdown, persists, and loads screens immediately.
- **Validation:** Grep verification confirms `getRestoredState('stitch.projectId')` no longer appears in any active code path; the HTML double-`display` conflict is resolved; `populateStitchProjects` no longer auto-selects via `defaultProjectId` or `sortedProjects[0]` fallbacks; `renderStitchScreens` and `switchTab` both guard the no-project UI state.
- **Remaining risks:** The `defaultProjectId` parameter in `populateStitchProjects` is now unused; removing it is a safe deferred cleanup.
