# Local Docs Folder Subheaders

## Goal
Add source-folder subheaders to the local docs sidebar so documents from each configured local folder are visually grouped under their folder name, while preserving the existing internal folder-hierarchy grouping within each source folder.

## Problem
In the planning.html local docs tab, documents from all configured local folders are currently displayed together without any indication of which folder each document came from. This is confusing when multiple local folders are configured.

## Current Behavior
- Documents are grouped by folder hierarchy within each source folder
- All documents from all configured folders are combined into a single flat list
- No visual indication of which configured folder a document belongs to

## Desired Behavior
- Each configured local folder should have its own subheader in the sidebar
- Documents should be grouped under their respective folder subheaders
- The folder name (basename of the folder path) should be displayed as the subheader
- Internal folder hierarchy (subfolders within a source folder) should be preserved within each source-folder group

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 3

## User Review Required
- Confirm whether empty configured folders (with no documents) should show a subheader or be hidden
- Confirm whether single-folder setups should still show a subheader (current plan: yes, for consistency)

## Complexity Audit

### Routine
- Adding a source-folder grouping layer before the existing folder-hierarchy grouping in `renderLocalDocs`
- Extracting folder basename from `sourceFolder` path using string manipulation (browser context, no Node `path` module)
- Reusing the existing `.folder-subheader` CSS class for the new subheaders
- The `sourceFolder` metadata is already populated on each node by `_mapLocalFilesToTreeNodes` (PlanningPanelProvider.ts line 1349)

### Complex / Risky
- Two-level grouping (source folder → internal folder hierarchy) must not break the existing subfolder rendering logic
- Same-basename collision: two configured folders with identical basename (e.g. `~/projects/docs` and `~/backups/docs`) would produce indistinguishable subheaders. Mitigation: add `title` attribute with full path as tooltip.

## Edge-Case & Dependency Audit

- **Race Conditions**: None — `renderLocalDocs` is called synchronously from `handleLocalDocsReady` and replaces the entire DOM content each time.
- **Security**: `sourceFolder` values are absolute paths from the extension host. Using `textContent` (not `innerHTML`) for subheaders prevents XSS. The basename extraction is pure string manipulation with no injection risk.
- **Side Effects**: None — this is a pure rendering change. No state mutations, no API calls.
- **Dependencies & Conflicts**: The `sourceFolder` metadata must be present on nodes. Verified: `_mapLocalFilesToTreeNodes` (PlanningPanelProvider.ts:1349) already maps `f.sourceFolder` → `metadata.sourceFolder`. The `folderPaths` array passed to `renderLocalDocs` (line 577) contains the same values and can be used for ordered iteration.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Destroying the existing internal folder-hierarchy grouping if source-folder grouping replaces rather than wraps it. (2) Browser-context `path.basename` unavailability requiring string-based extraction. (3) Same-basename folder collision producing ambiguous subheaders. Mitigations: Two-level grouping preserves hierarchy; string split replaces `path.basename`; `title` tooltip disambiguates collisions.

## Proposed Changes

### `src/webview/planning.js` — `renderLocalDocs` function (lines 576–731)

**Context**: The current code at lines 666–707 separates `folderNodes` and `docNodes`, then groups `docNodes` by internal folder hierarchy using `folderNameMap` and `docsByFolder`. All documents from all source folders are mixed together.

**Logic**: Add a top-level grouping by `sourceFolder` before the existing folder-hierarchy grouping. The structure becomes:
1. Group all `docNodes` and `folderNodes` by `metadata.sourceFolder`
2. For each source folder, render a source-folder subheader (basename)
3. Within each source-folder group, apply the existing folder-hierarchy grouping logic

**Implementation**:

Replace lines 666–707 with:

```javascript
// Group nodes by sourceFolder first
const docsBySourceFolder = new Map();
const foldersBySourceFolder = new Map();

docNodes.forEach(d => {
    const sourceFolder = d.metadata?.sourceFolder;
    if (!sourceFolder) return; // skip docs without sourceFolder (shouldn't happen)
    if (!docsBySourceFolder.has(sourceFolder)) {
        docsBySourceFolder.set(sourceFolder, []);
    }
    docsBySourceFolder.get(sourceFolder).push(d);
});

folderNodes.forEach(f => {
    const sourceFolder = f.metadata?.sourceFolder;
    if (!sourceFolder) return;
    if (!foldersBySourceFolder.has(sourceFolder)) {
        foldersBySourceFolder.set(sourceFolder, []);
    }
    foldersBySourceFolder.get(sourceFolder).push(f);
});

// Iterate over source folders (use folderPaths for consistent ordering)
const sourceFolders = [...new Set([
    ...(folderPaths || []),
    ...docsBySourceFolder.keys()
])];

sourceFolders.forEach(sourceFolder => {
    const folderDocs = docsBySourceFolder.get(sourceFolder) || [];
    const sourceFolderNodes = foldersBySourceFolder.get(sourceFolder) || [];

    // Skip source folders with no documents AND no subfolders
    if (folderDocs.length === 0 && sourceFolderNodes.length === 0) return;

    // Source-folder subheader (basename of the full path)
    const sourceHeader = document.createElement('div');
    sourceHeader.className = 'folder-subheader source-folder-header';
    // Browser-safe basename extraction (no Node path module in webview)
    const folderName = sourceFolder.split(/[\\/]/).filter(Boolean).pop() || sourceFolder;
    sourceHeader.textContent = folderName;
    sourceHeader.title = sourceFolder; // full path as tooltip for disambiguation
    docList.appendChild(sourceHeader);

    // Within this source folder, apply existing folder-hierarchy grouping
    const folderNameMap = new Map();
    sourceFolderNodes.forEach(f => folderNameMap.set(f.id, f.name));

    const docsByFolder = new Map();
    const rootDocs = [];
    folderDocs.forEach(d => {
        const docPath = d.id || d.relativePath || '';
        const lastSlashIdx = docPath.lastIndexOf('/');
        const parentFolderId = lastSlashIdx > 0 ? docPath.substring(0, lastSlashIdx) : null;

        if (parentFolderId && folderNameMap.has(parentFolderId)) {
            if (!docsByFolder.has(parentFolderId)) {
                docsByFolder.set(parentFolderId, []);
            }
            docsByFolder.get(parentFolderId).push(d);
        } else {
            rootDocs.push(d);
        }
    });

    sourceFolderNodes.forEach(folder => {
        const folderDocsInSource = docsByFolder.get(folder.id) || [];
        if (folderDocsInSource.length === 0) return;

        const subheader = document.createElement('div');
        subheader.className = 'folder-subheader';
        subheader.textContent = folder.name;
        docList.appendChild(subheader);

        folderDocsInSource.forEach(doc => {
            const { wrapper } = renderNode(doc, sourceId);
            docList.appendChild(wrapper);
        });
    });

    rootDocs.forEach(doc => {
        const { wrapper } = renderNode(doc, sourceId);
        docList.appendChild(wrapper);
    });
});
```

**Edge Cases**:
- Documents without `sourceFolder` metadata: skipped (shouldn't happen per current data flow, but handled gracefully)
- Empty source folders: skipped (no subheader rendered)
- Same-basename folders: `title` attribute on subheader shows full path for disambiguation
- Single configured folder: subheader still shown for consistency

### `src/webview/planning.html` — CSS for source-folder header (around line 520)

**Context**: The existing `.folder-subheader` class is styled for internal folder names. Source-folder headers should be visually distinct (slightly larger/bolder) to indicate they are top-level groupings.

**Implementation**: Add after the existing `.folder-subheader` styles (after line 533):

```css
.source-folder-header {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-primary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 6px 8px;
    margin-top: 12px;
    border-bottom: 1px solid var(--border-color);
}
.source-folder-header:first-of-type {
    margin-top: 4px;
}
```

## Verification Plan

### Automated Tests
- N/A (webview rendering change, no automated test coverage for DOM output)

### Manual Verification
- Configure multiple local folders with documents and verify each folder has its own subheader
- Verify documents are grouped under the correct folder subheaders
- Verify folder names display correctly (basename of the configured path)
- Verify internal folder hierarchy (subfolders) is still shown within each source-folder group
- Verify the full folder path appears as a tooltip on hover over the subheader
- Test with a single configured folder — subheader should still appear
- Test with two folders sharing the same basename — subheaders look identical but tooltips differentiate them
- Test with an empty configured folder — no subheader should appear for it

## Review Results

### Reviewer: Grumpy Principal Engineer pass (2026-05-26)

#### Stage 1: Adversarial Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **MAJOR** | `handleLocalFolderPathUpdated` (planning.js:1297-1354) used OLD flat folder-hierarchy rendering without source-folder grouping. This registered message handler would produce inconsistent UI (no subheaders) if ever triggered. Currently dead code (TypeScript side calls `_sendLocalDocsReady()` instead), but a maintenance landmine. |
| 2 | **MAJOR** | `.folder-subheader:first-of-type` CSS rule (planning.html:530-533) became dead code after this change. `:first-of-type` matches by tag name (`div`), not class. Since source-folder headers (also `div`) now precede folder subheaders in the DOM, no folder-subheader will ever be the first `div` child. First folder-subheader after a source-folder header gets 8px top margin instead of 0 — visual regression. |
| 3 | NIT | `.source-folder-header:first-of-type` (planning.html:545-547) is fragile — depends on source-folder-header being the first `div` child. Works today but could silently break if DOM structure changes. Deferred. |

#### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| #1 Dead `handleLocalFolderPathUpdated` rendering | Fix now | Refactored to delegate to `renderLocalDocs` instead of duplicating incorrect logic |
| #2 Dead `.folder-subheader:first-of-type` | Fix now | Added `.source-folder-header + .folder-subheader` adjacent sibling rule to reset margin |
| #3 Fragile `:first-of-type` | Defer | Works correctly today; low risk |

#### Stage 3: Code Fixes Applied

**File: `src/webview/planning.js`**
- Replaced 48-line `handleLocalFolderPathUpdated` body with 5-line delegation to `renderLocalDocs`, ensuring consistent source-folder grouping across all rendering paths.

**File: `src/webview/planning.html`**
- Added `.source-folder-header + .folder-subheader` CSS rule (margin-top: 0, padding-top: 8px) to reset spacing on the first folder-subheader immediately after a source-folder header.

#### Stage 4: Validation

- `node -c planning.js` — syntax check passed (exit code 0)
- Compilation skipped per review instructions
- Automated tests skipped per review instructions
- `git diff` confirms exactly 2 files changed, 12 insertions, 48 deletions — no unintended modifications

#### Remaining Risks

- `.source-folder-header:first-of-type` is fragile but functional; could be replaced with `:first-child` or a JS-added class in a future refactor
- `handleLocalFolderPathUpdated` is currently dead code (no TypeScript sender); the delegation fix ensures correctness if it's ever re-wired
