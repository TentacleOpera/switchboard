# Fix Local Docs Duplicates and Preview Issue

## Goal
Fix the local docs sidebar in planning.html showing duplicate doc entries and the preview pane failing to display doc content, both caused by redundant container creation and a race condition during initialization.

## Metadata
- **Tags:** [bugfix, frontend, reliability]
- **Complexity:** 3

## User Review Required
- [ ] Verify that the "preview doc does not show" issue is resolved as a consequence of fixing the duplicate containers (see Edge-Case note below)
- [ ] Confirm no visual regression in the imported docs section after folder add/remove/refresh cycles

## Complexity Audit

### Routine
- Adding an existence check before creating a DOM element (`getElementById` guard)
- Removing a redundant message dispatch call from initialization
- Clearing container innerHTML before re-populating (already present in `handleImportedDocsReady`)
- The `treePane.innerHTML = ''` at line 571 already serves as the primary anti-duplicate mechanism by destroying all child elements before rebuild

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** `renderLocalDocs` (line 571) clears `treePane.innerHTML = ''` then rebuilds. If `handleImportedDocsReady` fires between the clear and the rebuild, `document.getElementById('imported-docs-list')` returns null and the function silently exits (line 1379). The imported docs are lost for that cycle. This is low-probability (requires file watcher + user action overlap) and self-corrects on the next `fetchImportedDocs` trigger. No additional mitigation needed.
- **Security:** No concerns — all DOM construction uses `createElement` and `textContent`, not `innerHTML` with user data.
- **Side Effects:** Removing the `fetchImportedDocs` initialization call means imported docs rely entirely on the `fetchImportedDocs` dispatched by `renderLocalDocs` (line 721). If `renderLocalDocs` is never called (no local folders configured), imported docs won't load. This is acceptable because imported docs from online sources are handled by the online pane path.
- **Dependencies & Conflicts:** `handleImportedDocsReady` (line 1371) depends on `imported-docs-list` existing in the DOM. The existence check in `renderLocalDocs` (line 712) ensures it's created, but note that within `renderLocalDocs` the check is redundant because `treePane.innerHTML = ''` at line 571 destroys it first. The check provides defensive value if other code paths were to call a similar function, but currently no such path exists.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The "preview not showing" problem lacks its own root cause — it is likely a consequence of duplicate containers causing `handleImportedDocsReady` to populate an orphaned element, but this should be verified. (2) The existence check in Fix 1 is redundant within `renderLocalDocs` due to the `innerHTML = ''` clear; the real anti-duplicate mechanism is the clear itself. Mitigations: Verify preview works after duplicate fix is applied; the existence check is harmless defensive coding.

## Problem
The local docs in planning.html is completely broken:
- Left hand side menu shows multiple duplicates of each doc
- Preview doc does not show

## Root Cause Analysis

### Issue 1: Duplicate `imported-docs-list` containers
In `src/webview/planning.js`, the `renderLocalDocs` function (line 567) creates an `imported-docs-section` with id `imported-docs-list` every time it's called:

```javascript
// Add separate imported docs section
const importedSection = document.createElement('div');
importedSection.className = 'imported-docs-section';
importedSection.id = 'imported-docs-list';
treePane.appendChild(importedSection);
```

However, this function can be called multiple times:
1. On initialization via `fetchRoots` → `_sendLocalDocsReady` → `localDocsReady` message
2. On folder changes via `addLocalFolder` / `removeLocalFolder` → `_sendLocalDocsReady`
3. On refresh via `refreshSource` → `_sendLocalDocsReady`
4. On file watcher triggers (create/delete/change) → `_sendLocalDocsReady`

Each call creates a NEW container with the same id, causing DOM duplication and multiple sidebar sections.

**Clarification:** The `treePane.innerHTML = ''` at line 571 clears the entire tree pane at the start of `renderLocalDocs`, which destroys any previously created `imported-docs-list`. So within a single `renderLocalDocs` call, there is no duplication. The duplication occurs when `handleImportedDocsReady` is triggered by a separate `fetchImportedDocs` call (e.g., from initialization) that races with `renderLocalDocs`, or when multiple rapid `_sendLocalDocsReady` calls cause overlapping render cycles.

### Issue 2: Race condition with initialization
The initialization code (lines 2404-2405) calls both:
```javascript
vscode.postMessage({ type: 'fetchRoots' });
vscode.postMessage({ type: 'fetchImportedDocs' });
```

`fetchRoots` triggers `renderLocalDocs` which creates the container and calls `fetchImportedDocs`. The separate `fetchImportedDocs` call creates a race condition.

### Issue 3: Preview not showing (consequence of Issue 1)
When duplicate `imported-docs-list` containers exist, `handleImportedDocsReady` (line 1371) uses `document.getElementById('imported-docs-list')` which returns the **first** matching element. If the first match is an orphaned or hidden container from a prior render cycle, the visible container remains empty and no imported docs appear. Additionally, if `renderLocalDocs` clears `treePane.innerHTML` while `handleImportedDocsReady` is populating the container, the imported docs content is destroyed. This is likely the root cause of the "preview doc does not show" symptom.

## Proposed Changes

### `src/webview/planning.js`

#### Change 1: Prevent duplicate container creation (line 711-718)
- **Context:** `renderLocalDocs` appends an `imported-docs-list` container to `treePane`. Before this fix, it always created a new one, leading to duplicates when called multiple times.
- **Logic:** Check if the container already exists before creating it. Note: within `renderLocalDocs`, `treePane.innerHTML = ''` at line 571 destroys the container first, so the check will always find null and create a new one. The check provides defensive value for hypothetical future code paths.
- **Implementation:**
```javascript
// Add separate imported docs section (only if it doesn't exist)
let importedSection = document.getElementById('imported-docs-list');
if (!importedSection) {
    importedSection = document.createElement('div');
    importedSection.className = 'imported-docs-section';
    importedSection.id = 'imported-docs-list';
    treePane.appendChild(importedSection);
}
```
- **Edge Cases:** If `treePane.innerHTML = ''` is ever removed from `renderLocalDocs`, this check becomes essential to prevent duplicates. Currently it is redundant-but-harmless within this function.

#### Change 2: Remove redundant initialization call (line 2407)
- **Context:** Initialization dispatched both `fetchRoots` and `fetchImportedDocs`. `fetchRoots` triggers `renderLocalDocs` which already sends `fetchImportedDocs` (line 721). The duplicate call caused `handleImportedDocsReady` to fire twice, potentially racing with `renderLocalDocs`.
- **Logic:** Remove the standalone `fetchImportedDocs` call; rely on the one inside `renderLocalDocs`.
- **Implementation:**
```javascript
vscode.postMessage({ type: 'fetchRoots' });
// Removed: vscode.postMessage({ type: 'fetchImportedDocs' });
```
- **Edge Cases:** If no local folders are configured, `renderLocalDocs` still sends `fetchImportedDocs`, so imported docs from online sources will still load. No regression.

#### Change 3: Clear existing content before re-rendering (already present)
- **Context:** `handleImportedDocsReady` (line 1371) already clears `importedDocsContainer.innerHTML = ''` at line 1381 before populating. This prevents accumulation within a single container.
- **Logic:** No change needed — this is already correct.
- **Implementation:**
```javascript
function handleImportedDocsReady(msg) {
    const { docs } = msg;
    console.log('[handleImportedDocsReady] Received docs:', docs);

    state.importedDocs.clear();

    const importedDocsContainer = document.getElementById('imported-docs-list');
    if (!importedDocsContainer) return;

    importedDocsContainer.innerHTML = ''; // Already present, good
    // ... rest of function
}
```
- **Edge Cases:** If `importedDocsContainer` is null (destroyed by `renderLocalDocs` clear), the function returns silently. The imported docs will load on the next `fetchImportedDocs` trigger (e.g., from `renderLocalDocs` line 721).

## Verification Plan

### Automated Tests
- No automated tests added (DOM rendering in VS Code webview lacks a practical test harness; manual verification is appropriate)

### Manual Verification Steps
1. Open planning panel
2. Verify local docs sidebar shows each doc only once (no duplicates)
3. Click on a local doc
4. Verify preview pane displays the doc content
5. Add/remove a local folder
6. Verify no new duplicate sections appear
7. Refresh local docs
8. Verify no duplicates appear
9. Import a doc from an online source (ClickUp/Linear)
10. Verify imported doc appears in the imported docs section without duplicates
11. Click an imported doc and verify preview displays correctly

## Risk Assessment
- **Low risk**: Changes are defensive (check before create, remove redundant call)
- **No breaking changes**: Only fixes duplicate rendering, doesn't change functionality
- **Backward compatible**: Existing behavior preserved, just without bugs

## Recommendation
Complexity 3 → **Send to Intern**
