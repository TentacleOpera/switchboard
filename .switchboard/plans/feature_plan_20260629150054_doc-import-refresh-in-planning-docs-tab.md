# Doc Import Does Not Refresh in planning.html Docs Tab

## Goal

When a user imports a doc (from an online source like ClickUp, Linear, or Notion) into the planning.html **Docs tab**, the imported doc should appear immediately in the sidebar. Currently it does not — the user has to manually re-trigger a fetch to see it. The import should trigger an immediate refresh of the imported-docs list.

### Core problem & background

The Docs tab in planning.html has two doc sources: **local docs** (files on disk) and **imported docs** (online sources synced into a local SQLite store). When a user clicks "Import" on an online doc, the backend (`PlanningPanelProvider.ts`) correctly writes the doc to the database and sends two messages back to the webview: `importFullDocResult` (success confirmation) and `importedDocsReady` (the refreshed imported-docs list).

The webview handler `handleImportedDocsReady` (`planning.js:3417`) receives the `importedDocsReady` message and tries to render the docs into a container element with id `imported-docs-list`. **However, no element with id `imported-docs-list` exists anywhere in `planning.html`.** The function hits an early return at line 3425 (`if (!importedDocsContainer) return;`) and the docs are silently discarded — they never render.

The local docs tree *does* refresh because the backend also calls `_sendLocalDocsReady()` (`PlanningPanelProvider.ts:7717`), which triggers `handleLocalDocsReady` → `rerenderUnifiedDocs()` (`planning.js:2782-2793`). But the imported-docs section (for online sources) is a separate UI section that never appears because its container element is missing.

### Root cause

The `#imported-docs-list` container element was never added to the `planning.html` DOM. The `handleImportedDocsReady` function in `planning.js` was written to populate this element, but the corresponding HTML element was never created — a wiring gap between the JS handler and the HTML markup. The existing pattern in the same file (`renderAntigravitySessions` at `planning.js:2709`) dynamically creates its container element and appends it to `#tree-pane`; the imported-docs handler should follow the same pattern rather than relying on a static HTML element that doesn't exist.

## Metadata

- **Tags:** [frontend, bug, ui, docs-tab]
- **Complexity:** 2

## Complexity Audit

### Routine
- Modifying `handleImportedDocsReady` (`planning.js:3417`) to dynamically create the `#imported-docs-list` container if it doesn't exist, following the same pattern as `renderAntigravitySessions` (`planning.js:2709`).
- Appending the dynamically-created container to `#tree-pane` in the correct position (after the local docs section, before the Antigravity sessions section if present).

### Complex / Risky
- None. The fix is a small, self-contained change to one function. The backend already sends the correct data; only the frontend rendering is broken.

## Edge-Case & Dependency Audit

- **Container already exists (future-proofing):** If a future change adds `#imported-docs-list` to the HTML, the dynamic-creation code must check `if (!importedDocsContainer)` before creating — it should reuse the existing element rather than creating a duplicate. The recommended fix already does this.
- **Empty docs list:** When `docs` is empty or null, the function should show "No imported documents" in the container. This logic already exists at `planning.js:3429-3431` and will work once the container is created.
- **Container ordering in `#tree-pane`:** The imported-docs section should appear after the local docs section and before any Antigravity sessions section. Use `treePane.appendChild()` or insert before the Antigravity section if it exists. The safest approach is `appendChild` — the Antigravity section is also dynamically appended, so order depends on which fires first. Since imported docs are fetched on tab load and Antigravity sessions are fetched separately, either order is acceptable. If strict ordering is needed, insert before `#antigravity-section` if it exists.
- **No confirmation dialogs** (house rule, `CLAUDE.md`): No confirm gates involved — this is a rendering fix.
- **Dependencies:** None. No other plan blocks or is blocked by this.

## Proposed Changes

### 1. `src/webview/planning.js` — dynamically create `#imported-docs-list` container

In `handleImportedDocsReady` (line 3417), replace the early-return with dynamic container creation:

**Current code** (`planning.js:3417-3425`):
```javascript
function handleImportedDocsReady(msg) {
    const { docs } = msg;

    console.log('[handleImportedDocsReady] Received docs:', docs);

    state.importedDocs.clear();

    const importedDocsContainer = document.getElementById('imported-docs-list');
    if (!importedDocsContainer) return;

    importedDocsContainer.innerHTML = '';
```

**Replace with:**
```javascript
function handleImportedDocsReady(msg) {
    const { docs } = msg;

    console.log('[handleImportedDocsReady] Received docs:', docs);

    state.importedDocs.clear();

    let importedDocsContainer = document.getElementById('imported-docs-list');
    if (!importedDocsContainer) {
        importedDocsContainer = document.createElement('div');
        importedDocsContainer.id = 'imported-docs-list';
        importedDocsContainer.className = 'imported-docs-section';
        const treePane = document.getElementById('tree-pane');
        if (!treePane) return;
        // Insert before the Antigravity section if it exists, otherwise append
        const antigravitySection = document.getElementById('antigravity-section');
        if (antigravitySection) {
            treePane.insertBefore(importedDocsContainer, antigravitySection);
        } else {
            treePane.appendChild(importedDocsContainer);
        }
    }

    importedDocsContainer.innerHTML = '';
```

This mirrors the pattern used by `renderAntigravitySessions` (`planning.js:2709`), which dynamically creates `#antigravity-section` and appends it to `#tree-pane`.

### 2. `src/webview/planning.html` — add CSS for `.imported-docs-section` (optional)

If the `.imported-docs-section` class is not already defined in the CSS, add a minimal style rule near the existing docs-tab styles to ensure the section has proper spacing:

```css
.imported-docs-section {
    margin-top: 8px;
}
```

If the class is already defined or the section renders acceptably without it, this step can be skipped.

## Verification Plan

1. Open the planning panel in VS Code (Switchboard extension).
2. Navigate to the Docs tab.
3. Import a doc from an online source (ClickUp, Linear, or Notion).
4. **Verify:** The imported doc appears immediately in the sidebar after the import completes — no manual refresh required.
5. Import a second doc from a different source.
6. **Verify:** Both docs appear, grouped by source.
7. Delete an imported doc (if the UI supports it) or clear the docs.
8. **Verify:** The list updates to show "No imported documents" or removes the deleted doc.
9. Switch away from the Docs tab and back.
10. **Verify:** The imported docs list persists and re-renders correctly.
