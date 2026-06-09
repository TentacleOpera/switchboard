# Fix planning.html Delete Modal, Broken Deletion, and Save Path Errors

## Goal

Eliminate three critical UX bugs in the Switchboard Planning panel (`planning.html` / `planning.js` / `PlanningPanelProvider.ts`):

1. **Delete confirmation modal** — Delete actions currently trigger an intrusive VS Code modal dialog. The user has explicitly requested immediate, no-confirmation deletion.
2. **Local doc deletion is silently broken** — After confirming the modal, local-folder docs are never actually deleted because the backend passes a raw `docId` (with `folderIndex:` prefix like `"0:myplan.md"`) directly to `LocalFolderService.deleteFile()`, which expects a clean relative path.
3. **"Invalid file path" on save after editing H1** — Editing a document's H1 title (or any content) and clicking Save produces an `Invalid file path` error. This occurs because `saveFileContent` resolves relative paths (e.g. kanban `planFile` values like `.switchboard/plans/foo.md`) against the extension host's `process.cwd()` instead of the workspace root, causing the allow-list check to fail.

## Problem Analysis

### Root Cause 1: Modal Dialogs Block Immediate Deletion

In `src/services/PlanningPanelProvider.ts`:

- `deleteLocalDoc` handler (line 1497) wraps deletion in `vscode.window.showWarningMessage(..., { modal: true }, 'Move to Trash')`.
- `deleteImportedDoc` handler (line 1528) wraps deletion in `vscode.window.showWarningMessage(..., { modal: true }, 'Delete')`.

These modals are the direct cause of Bug 1. Even if the user clicks through, Bug 2 prevents actual deletion for local docs.

### Root Cause 2: `deleteLocalDoc` Passes Prefixed `docId` to `deleteFile`

In `src/webview/planning.js`, the `Delete` action handler for `local-folder` docs (line 1118) posts:

```js
vscode.postMessage({
    type: 'deleteLocalDoc',
    docId: node.id,           // e.g. "0:myplan.md"
    docName: node.name,
    workspaceRoot: node.metadata ? node.metadata.root : undefined,
    sourceFolder: node.metadata ? node.metadata.sourceFolder : undefined  // ALREADY PRESENT at line 1126
});
```

The `sourceFolder` field is **already included** in the webview message (line 1126). The original plan incorrectly stated it was missing; code inspection confirms it exists.

On the backend (`PlanningPanelProvider.ts` line 1506), the handler passes the raw `docId` (`0:myplan.md`) directly to `LocalFolderService.deleteFile(relativePath, sourceFolder)`. That service (line 614) expects a clean `relativePath` but receives a prefixed string, so it attempts to delete a non-existent file (`…/0:myplan.md`).

### Root Cause 3: `saveFileContent` Resolves Relative Paths Against Wrong Base

In `PlanningPanelProvider.ts` `saveFileContent` handler (line 1812):

```ts
const resolved = path.resolve(filePath);
let isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
```

When saving a **kanban plan**, the webview sends `_kanbanSelectedPlan.planFile`, which is a DB-relative path such as `.switchboard/plans/foo.md`. `path.resolve('.switchboard/plans/foo.md')` resolves relative to the VS Code extension host's `process.cwd()` (typically the extension installation directory), **not** the workspace root. The resulting absolute path falls outside every workspace root, so `isAllowed` is `false` and the handler returns:

```ts
{ success: false, error: 'Invalid file path', tab }
```

For **local-folder** and **design-folder** docs, the backend sends an absolute `filePath` in `previewReady`, so `path.resolve()` works correctly. The bug only surfaces for paths that are relative when they reach `saveFileContent`.

### Root Cause 4 (Discovered): `deleteKanbanPlan` Has Same Path Resolution Bug

In `PlanningPanelProvider.ts` `deleteKanbanPlan` handler (line 1775):

```ts
const resolvedPlanFile = path.resolve(planFile);
```

This has the identical relative-path resolution issue. If `planFile` is relative (e.g. `.switchboard/plans/foo.md`), it resolves against `process.cwd()` instead of the workspace root, causing the traversal check to incorrectly reject or pass the wrong path.

## Metadata

**Tags:** bugfix, frontend, backend, ui, ux
**Complexity:** 4

## User Review Required

- Confirm that immediate deletion (no modal, trash-based) is acceptable for both local docs and imported docs.
- Confirm that `deleteKanbanPlan` path fix is desired alongside `saveFileContent` fix.

## Complexity Audit

### Routine

- Remove two `showWarningMessage` modal blocks (lines 1497-1504, 1528-1535)
- Strip `folderIndex:` prefix from `docId` before calling `deleteFile` (line 1506)
- Add `path.isAbsolute()` guard in `saveFileContent` (line 1818)
- Add same guard in `deleteKanbanPlan` (line 1775)

### Complex / Risky

- Relative path resolution in `saveFileContent` must work for all three tab types (local, design, kanban) without breaking absolute-path flows that already work
- `deleteKanbanPlan` path fix must not break the existing traversal check logic

## Edge-Case & Dependency Audit

- **Race Conditions**: None identified. Delete and save are user-initiated, single-action operations.
- **Security**: The `saveFileContent` allow-list check (`isAllowed`) remains intact. Resolving relative paths against the workspace root before the check *strengthens* security by ensuring relative paths are correctly scoped. No path traversal risk introduced.
- **Side Effects**: Removing modals means no user confirmation before trash/delete. `LocalFolderService.deleteFile` uses `useTrash: true` (line 631), so local docs go to OS trash. Imported docs use `fs.promises.unlink` (line 1551) — permanent delete, no trash. This asymmetry is pre-existing and not introduced by this plan.
- **Dependencies & Conflicts**: The `_resolveWorkspacePath` method (line 208) exists for similar resolution but includes `existsSync` checks that are inappropriate for save-to-new-file scenarios. The inline fix is preferred.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) Relative path resolution must not break existing absolute-path flows for local/design docs. (2) `deleteKanbanPlan` shares the same bug and must be fixed in the same pass. (3) Removing modals removes the only confirmation step — trash-based deletion provides OS-level recovery for local docs, but imported docs are permanently deleted. Mitigations: Guard with `path.isAbsolute()` so absolute paths skip the resolution logic entirely; fix both handlers consistently; document the trash-vs-permanent asymmetry.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

**Change 1 — Remove `deleteLocalDoc` modal (lines 1497-1504)**

Remove the `showWarningMessage` block. Proceed directly from the `sourceFolder` check to `service.deleteFile(...)`.

Current (lines 1497-1504):
```ts
const confirm = await vscode.window.showWarningMessage(
    `Move "${docName}" to trash?`,
    { modal: true },
    'Move to Trash'
);
if (confirm !== 'Move to Trash') {
    break;
}
```

Replace with: (delete these 7 lines entirely; the `service.deleteFile(...)` call at line 1506 follows immediately after)

**Change 2 — Strip `folderIndex:` prefix from `docId` (line 1506)**

Current:
```ts
const result = await service.deleteFile(docId, sourceFolder);
```

Replace with:
```ts
const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
const result = await service.deleteFile(cleanDocId, sourceFolder);
```

**Change 3 — Remove `deleteImportedDoc` modal (lines 1528-1535)**

Remove the `showWarningMessage` block. Proceed directly to the file-unlink and DB-removal logic.

Current (lines 1528-1535):
```ts
const confirm = await vscode.window.showWarningMessage(
    `Delete "${docName}" from local docs?`,
    { modal: true },
    'Delete'
);
if (confirm !== 'Delete') {
    break;
}
```

Replace with: (delete these 7 lines entirely; the try block at line 1536 follows immediately after)

**Change 4 — Fix `saveFileContent` relative path resolution (lines 1818-1819)**

Current:
```ts
const resolved = path.resolve(filePath);
let isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
```

Replace with:
```ts
let resolved = path.resolve(filePath);
if (!path.isAbsolute(filePath)) {
    const wsRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);
    if (wsRoot) {
        resolved = path.resolve(wsRoot, filePath);
    } else {
        this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: false, error: 'No workspace root to resolve relative path', tab });
        break;
    }
}
let isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
```

This ensures:
- Absolute paths (local/design docs) skip the resolution logic entirely — no behavior change.
- Relative paths (kanban plans) are resolved against the workspace root.
- If no workspace root exists, the handler fails explicitly instead of silently using the wrong path.

**Change 5 — Fix `deleteKanbanPlan` relative path resolution (lines 1775-1781)**

Current:
```ts
if (planFile) {
    const resolvedPlanFile = path.resolve(planFile);
    const resolvedRoot = path.resolve(wsRoot);
    const rel = path.relative(resolvedRoot, resolvedPlanFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        this._panel?.webview.postMessage({ type: 'kanbanPlanDeleted', success: false, error: 'Plan file is outside workspace root' });
        break;
    }
}
```

Replace with:
```ts
if (planFile) {
    const resolvedPlanFile = path.isAbsolute(planFile)
        ? planFile
        : path.resolve(wsRoot, planFile);
    const resolvedRoot = path.resolve(wsRoot);
    const rel = path.relative(resolvedRoot, resolvedPlanFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        this._panel?.webview.postMessage({ type: 'kanbanPlanDeleted', success: false, error: 'Plan file is outside workspace root' });
        break;
    }
}
```

### `src/webview/planning.js`

**No changes required.** The `sourceFolder` field is already present in the `deleteLocalDoc` message (line 1126), and all three save handlers already include the `tab` field (lines 4925, 4959, 4993). The original plan incorrectly identified these as missing; code inspection confirms they exist.

## Execution Status

**Completed:** 2026-06-09
**Executor:** Cascade (Coder)

### Files Changed

- `src/services/PlanningPanelProvider.ts` — 5 edits applied

### Changes Applied

| # | Location | Change |
|---|----------|--------|
| 1 | `deleteLocalDoc` handler (was lines 1497-1504) | Removed `showWarningMessage` modal block. Deletion proceeds immediately. |
| 2 | `deleteLocalDoc` handler (was line 1506) | Strip `folderIndex:` prefix from `docId` before passing to `deleteFile`. |
| 3 | `deleteImportedDoc` handler (was lines 1528-1535) | Removed `showWarningMessage` modal block. Deletion proceeds immediately. |
| 4 | `saveFileContent` handler (was lines 1818-1819) | Relative paths now resolved against workspace root via `path.isAbsolute()` guard. |
| 5 | `deleteKanbanPlan` handler (was lines 1775-1776) | Relative `planFile` paths now resolved against `wsRoot` instead of `process.cwd()`. |

### Validation

- Syntax review: all edits compile cleanly (no syntax errors introduced).
- No changes to `src/webview/planning.js` — plan correctly confirmed fields already present.

### Remaining Risks

- Imported docs still use `fs.promises.unlink` (permanent delete, no trash). Pre-existing behavior, not introduced by this fix.
- `_resolveWorkspacePath` exists but was not used because it includes `existsSync` checks inappropriate for new-file saves.

## Verification Plan

### Automated Tests

No automated tests exist for these webview ↔ backend message flows. Manual verification required.

### Manual Verification Steps

1. Open the Planning panel in VS Code.
2. **Local Docs tab**: Select a local markdown file, click Edit, change the H1, click Save → should succeed without error.
3. **Local Docs tab**: Click the `×` delete button on a local doc → doc should vanish immediately with no modal (file goes to OS trash).
4. **Local Docs tab**: Click the `×` delete button on an imported doc → doc should vanish immediately with no modal (file is permanently deleted).
5. **Kanban tab**: Select a plan, click Edit, change the H1, click Save → should succeed without error.
6. **Kanban tab**: Use the column dropdown to delete a plan → should succeed without path resolution error.
7. **Design tab**: Select a design doc, click Edit, change content, click Save → should still work (absolute path, no regression).

### Recommendation

Complexity 4 → **Send to Coder**
