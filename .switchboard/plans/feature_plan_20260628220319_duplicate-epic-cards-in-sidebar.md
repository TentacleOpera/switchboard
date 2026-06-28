# Duplicate Epic Cards in Project.html Epics Tab Sidebar

## Goal

Fix the Epics tab sidebar in `project.html` so each epic file appears only once. Currently, every epic is rendered twice: once with full card details (Copy Link, Copy Planning Prompt, Send to Planner buttons, column badge) and once as a bare duplicate at the bottom with only a "Doc" badge. The bare duplicate should not be there.

### Problem Analysis

The Epics tab sidebar is rendered by `renderEpicsList()` in `src/webview/project.js` (line 1592). This function merges two data sources without deduplication:

```javascript
let filtered = [
    ..._kanbanPlansCache.filter(plan => plan.isEpic),  // Source A: DB epic records
    ..._epicDocumentsCache                              // Source B: filesystem epic docs
];
```

**Source A** (`_kanbanPlansCache`): Populated from the kanban board data (line 389). Contains all plans from the DB, including epics (`isEpic: true`). Each epic entry has full metadata: `planId`, `sessionId`, `column`, `workspaceRoot`, `project`, etc. These render with full card details (action buttons, column badge, subtask accordion).

**Source B** (`_epicDocumentsCache`): Populated from `epicDocumentsReady` messages (line 516). The backend handler `fetchEpicDocuments` in `PlanningPanelProvider.ts` (line 3296) reads ALL `.md` files from `.switchboard/epics/` and creates entries with `isEpicDocument: true`, `subtaskCount: 0`, and a synthetic `planId` of `epic-doc:${fullPath}`. These render as bare cards — the `isManageable` check at line 1644 (`plan && !plan.isEpicDocument`) evaluates to `false`, so no action buttons are shown, only a "Doc" column badge.

### Root Cause

When an epic file exists in `.switchboard/epics/` AND has a corresponding DB record with `isEpic=1`, it appears in BOTH caches. The two entries have different `planId` values (the DB record has the real UUID; the document cache has `epic-doc:<path>`), so no natural deduplication occurs. The merged array contains both, and `renderEpicsList` iterates over all entries, producing two sidebar items for the same epic file.

The same duplication exists in `tryResolvePendingEpicSelection()` (line 1363), which also merges the two caches:
```javascript
const pool = [..._kanbanPlansCache.filter(p => p.isEpic), ..._epicDocumentsCache];
```

## Metadata
- **Tags:** bugfix, frontend, epics, project-tab, ui
- **Complexity:** 3/10

## Complexity Audit

### Routine
- Adding deduplication logic to `renderEpicsList()` to filter out `_epicDocumentsCache` entries that already exist in `_kanbanPlansCache` by matching `planFile` paths.
- Applying the same deduplication to `tryResolvePendingEpicSelection()`.
- Both changes are confined to `src/webview/project.js` and use existing data fields.

### Complex / Risky
- None. The fix is a pure filter operation on an in-memory array. No DB writes, no file operations, no backend changes.

## Edge-Case & Dependency Audit
- **Path normalization:** `_kanbanPlansCache` entries have `planFile` as an absolute path (resolved by `_resolveAbsolutePlanFile` in `KanbanDatabase.ts`). `_epicDocumentsCache` entries have `planFile` as `path.join(epicDir, file)` — also absolute. Both use forward slashes on macOS. However, edge cases like symlinks, trailing slashes, or case differences on case-insensitive filesystems could cause a mismatch. The deduplication should normalize paths before comparison (lowercase + `path.resolve` equivalent).
- **Standalone epic documents:** Some epic files in `.switchboard/epics/` may NOT have a DB record (e.g., manually created files, or files from a workspace that hasn't been scanned yet). These should still appear in the sidebar — only duplicates should be filtered out, not all document-cache entries.
- **Filter interactions:** The workspace and column filters (lines 1600–1604) apply AFTER the merge. The deduplication must happen BEFORE the filters so that a filtered-out DB entry doesn't cause its document-cache duplicate to survive.
- **Security:** None. Pure frontend rendering change.
- **Dependencies:** None. No other code depends on the duplicate entries being present.

## Proposed Changes

### Change 1: Deduplicate in `renderEpicsList()`

**File:** `src/webview/project.js` — `renderEpicsList()` (line 1592)

Replace the naive merge with a deduplicated merge. Build a Set of `planFile` paths from the DB epic cache, then filter the document cache to exclude entries whose `planFile` matches a DB epic entry.

```javascript
function renderEpicsList() {
    if (!epicsListPane) return;

    // Build a set of planFile paths from DB epics for O(1) dedup lookup.
    // Both caches store absolute paths, but normalize for case-insensitive
    // comparison (macOS/Windows) and trailing-slash differences.
    const dbEpicFiles = new Set(
        _kanbanPlansCache
            .filter(plan => plan.isEpic)
            .map(plan => normalizePath(plan.planFile))
    );

    // Merge DB epics with standalone epic documents, deduplicating by planFile.
    // Document-cache entries that already exist in the DB cache are skipped.
    let filtered = [
        ..._kanbanPlansCache.filter(plan => plan.isEpic),
        ..._epicDocumentsCache.filter(doc => !dbEpicFiles.has(normalizePath(doc.planFile)))
    ];
    // ... rest of function unchanged (filters, rendering, etc.)
}
```

Add a `normalizePath` helper at the top of the epics section:

```javascript
/** Normalize a file path for case-insensitive comparison (macOS/Windows). */
function normalizePath(p) {
    if (!p) return '';
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
```

### Change 2: Deduplicate in `tryResolvePendingEpicSelection()`

**File:** `src/webview/project.js` — `tryResolvePendingEpicSelection()` (line 1360)

Apply the same deduplication to the selection-resolution pool:

```javascript
function tryResolvePendingEpicSelection() {
    if (!_pendingEpicSelection) return;
    const sel = _pendingEpicSelection;
    // Deduplicate: prefer DB epic records over standalone document entries.
    const dbEpicFiles = new Set(
        _kanbanPlansCache.filter(p => p.isEpic).map(p => normalizePath(p.planFile))
    );
    const pool = [
        ..._kanbanPlansCache.filter(p => p.isEpic),
        ..._epicDocumentsCache.filter(doc => !dbEpicFiles.has(normalizePath(doc.planFile)))
    ];
    const match = pool.find(p =>
        (sel.planFile && p.planFile === sel.planFile) ||
        (sel.planId && p.planId === sel.planId) ||
        (sel.sessionId && p.sessionId === sel.sessionId)
    );
    // ... rest of function unchanged
}
```

## Verification Plan

1. **Reproduce the bug:** Open the project view, go to the Epics tab, observe that each epic appears twice in the sidebar — once with full details and once as a bare "Doc" entry at the bottom.
2. **Apply the fix:** Implement Changes 1 and 2.
3. **Verify deduplication:** Each epic should appear exactly once in the sidebar, with full card details (Copy Link, Copy Planning Prompt, Send to Planner buttons, column badge, subtask accordion).
4. **Verify standalone epic documents still appear:** Create a `.md` file manually in `.switchboard/epics/` that has no DB record. Confirm it still appears in the sidebar as a bare "Doc" entry (these are legitimate standalone documents).
5. **Verify selection still works:** Click an epic in the sidebar — it should select and preview correctly. Use "Copy Link" from the kanban board to deep-link to an epic, and confirm the Epics tab scrolls to and selects the correct epic.
6. **Verify filters:** Apply workspace and column filters in the Epics tab. Confirm no duplicates appear under any filter combination.
7. **Verify after board refresh:** Move a plan to a different column on the kanban board (which triggers a board refresh and `renderEpicsList` re-run). Confirm no duplicates appear after the refresh.
