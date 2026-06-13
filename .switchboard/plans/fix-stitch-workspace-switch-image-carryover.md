# Fix Stitch Workspace Switch Image Carry-Over Bug

## Goal
When switching Stitch projects in the design.html Stitch tab, if an image file is selected in the bottom preview panel, the system incorrectly carries this file selection into the new project. This plan fixes the bug by clearing image selection state when switching Stitch workspaces.

### Root Cause
The Stitch workspace filter change handler (`stitch-workspace-filter` `change` event listener in `design.js`) only resets Stitch-specific state when switching workspaces:
- `state.selectedStitchProjectId = ''`
- `state.stitchScreens = []`
- `state.activePreviewScreenId = null`

However, it does NOT clear the Images tab's document selection state (`state.activeSource`, `state.activeDocId`). When the new workspace's images are loaded via the `imagesDocsReady` message handler, the old selection persists, causing the previously selected image to appear selected in the new project context.

### Current Flow
1. User selects an image in the Images tab → `state.activeSource = 'images-folder'`, `state.activeDocId = <fileId>`
2. User switches Stitch workspace via dropdown → Stitch state resets, but Images state remains
3. New workspace's images load via `imagesDocsReady` → `renderImagesDocs()` uses stale `state.activeSource`/`state.activeDocId` to determine selection
4. Old selection incorrectly appears in new workspace

### Key Code Locations
- **Stitch workspace switch handler**: `src/webview/design.js` lines 2979-2994
- **Images selection state**: `state.activeSource`, `state.activeDocId` (line 10-11)
- **Images render check**: `renderImagesDocs()` line 696 checks `state.activeSource === 'images-folder' && state.activeDocId === doc.id`

## Metadata
**Complexity:** 3
**Tags:** bugfix, ui, frontend

## User Review Required
No — straightforward state-clearing fix with no product or UX behavior changes.

## Complexity Audit

### Routine
- Single-file modification in `src/webview/design.js`
- Adds state-clearing logic to an existing event handler
- Reuses existing DOM element IDs and visibility patterns already present in the file
- No new architectural patterns or cross-module coordination

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. The state clear executes synchronously in the `change` event handler before any async postMessage round-trips.
- **Security:** None.
- **Side Effects:** Only affects the Images tab preview UI when `activeSource === 'images-folder'`. Design, HTML, and Briefs tabs are untouched.
- **Dependencies & Conflicts:** None. No external dependencies or cross-plan conflicts.

## Dependencies
None.

## Adversarial Synthesis
Key risks: stale selection state leaking across workspace boundaries, and the preview pane retaining an outdated image DOM. Mitigations: nullify `activeSource`, `activeDocId`, and `selectedEl`, and explicitly reset the Images preview pane DOM visibility to its initial state. Overall risk is low because the change is purely additive and tightly scoped to the Stitch workspace switch handler.

## Proposed Changes

### src/webview/design.js

#### Context
The `stitch-workspace-filter` change event handler (~line 2979) currently resets Stitch-specific state but leaves Images tab selection intact.

#### Logic
When the user switches Stitch workspaces, if the Images tab currently has an active selection (`state.activeSource === 'images-folder'`), clear the selection state and reset the preview pane UI so the old image does not carry over.

#### Implementation
Add the following block inside the `stitch-workspace-filter` change handler after `closeStitchPreview()`:

```javascript
document.getElementById('stitch-workspace-filter')?.addEventListener('change', (e) => {
    const newRoot = e.target.value;
    if (newRoot && newRoot !== state.stitchWorkspaceRoot) {
        state.stitchWorkspaceRoot = newRoot;
        _restoredPanelState.panel['stitch.root'] = newRoot;
        persistTab('stitch.root', state.stitchWorkspaceRoot);
        
        // reset in-memory stitch state
        state.selectedStitchProjectId = '';
        state.stitchScreens = [];
        state.activePreviewScreenId = null;
        if (stitchProjectSelect) {
            stitchProjectSelect.value = '';
        }
        closeStitchPreview();
        
        // FIX: Clear Images tab selection to prevent carry-over
        if (state.activeSource === 'images-folder') {
            state.activeSource = null;
            state.activeDocId = null;
            state.selectedEl = null;
            state.activeDocName = null;
            state.activeDocContent = null;
            state.activeDocFilePath = null;
            state.activeDocSourceFolder = null;
            state.activeFileType = null;
            // Clear the preview pane
            const initialState = document.getElementById('images-initial-state');
            const loadingState = document.getElementById('images-loading-state');
            const imageContainer = document.getElementById('image-preview-container-images');
            if (initialState) initialState.style.display = 'flex';
            if (loadingState) loadingState.style.display = 'none';
            if (imageContainer) imageContainer.style.display = 'none';
        }
        
        // ... rest of existing handler
    }
});
```

#### Edge Cases
- **User not on Images tab:** The check `state.activeSource === 'images-folder'` ensures we only clear when relevant.
- **Other tabs unaffected:** The fix only targets Images tab state, leaving Design, HTML, Briefs tabs untouched.
- **Preview pane cleanup:** Explicitly resetting the preview UI ensures visual consistency.
- **Stale DOM element:** `renderImagesDocs` rebuilds the doc list from scratch, so the old `selectedEl` reference is discarded; nulling `selectedEl` prevents stale class manipulation.
- **Complete state hygiene:** All doc-preview fields (`activeDocName`, `activeDocContent`, `activeDocFilePath`, `activeDocSourceFolder`, `activeFileType`) are cleared alongside the primary selection keys to prevent latent stale reads.

## Verification Plan

### Automated Tests
Skipped per session directive. The test suite will be run separately by the user.

### Manual Verification
- [ ] Switch Stitch workspace with no image selected → no change in behavior
- [ ] Switch Stitch workspace with image selected → selection cleared, preview reset
- [ ] Switch back to original workspace → can re-select images normally
- [ ] Other tabs (Design, HTML, Briefs) unaffected by Stitch workspace switch
- [ ] Workspace filter persistence still works correctly

## Files Changed
- `src/webview/design.js` (modify stitch-workspace-filter change handler)

## Risks
- **Low risk:** Change is scoped to a single event handler and only affects a specific state-clearing scenario.
- **No regression risk:** The fix only adds state clearing logic; it doesn't modify existing state management flows.

**Recommendation:** Send to Intern
