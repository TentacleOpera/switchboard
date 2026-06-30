# Claude Tab Sidebar Renders Folders as Cards — Align with Other Tabs

## Goal

Align the **Claude** tab's sidebar renderer with the other tabs (Design, HTML Previews, Images, Briefs) so that configured folders render as collapsible **accordion headers** with documents nested underneath, instead of as clickable **cards** under a "Folders" subheader. Folder-target selection (setting `state.claudeTargetFolder` for the import prompt) moves from a card-click to a "Set as target" action on the folder header.

### Problem
The **Claude** tab of `design.html` renders configured folders as clickable **cards** in the sidebar, grouped under a "Folders" subheader. No other tab (Design, HTML Previews, Images, Briefs) does this — they all use `renderFolderGroupedDocs`, which renders folders as **accordion headers** with documents nested underneath. The Claude tab's divergent rendering makes it visually inconsistent and confusing.

### Background
The Claude tab exists to let users import a design from `claude.ai/design` into a repo folder. The sidebar shows the configured HTML/image folders and their files so the user can pick a **target folder** for the import. The "Copy import prompt" button (top strip) reads `state.claudeTargetFolder` to know where to write.

### Root Cause
`renderClaudeDocs` (`src/webview/design.js`, lines ~4551–4661) is a bespoke renderer that:
1. Includes folder nodes in `docNodes` (`if (n.kind === 'folder') return true;` — line ~4587).
2. Partitions nodes into `folderNodes`, `htmlNodes`, `imageNodes`.
3. Calls `renderGroup('Folders', folderNodes, false)` (line ~4659) which renders each folder as a `renderDocCard` with subtitle "Folder".

Every other tab calls the shared `renderFolderGroupedDocs` (line ~642) instead, which renders folders as accordion headers (via `buildAccordionFolderHeader`) and nests document cards inside them. Folders are containers, not selectable cards.

The Claude tab diverged because it needs **folder selection** (clicking a folder sets `state.claudeTargetFolder`). The bespoke renderer solved this by making folders clickable cards, but this is the wrong UX — it should use accordion headers with a "Set as target" action, matching the "Link" action other tabs already use on folder headers.

## Metadata
- **Tags**: `frontend`, `ui`, `ux`, `refactor`
- **Complexity**: 5/10

## User Review Required
- [ ] Confirm the desired visual indicator for the active target folder: a "✓ Target" label on the folder header action button (re-rendered on each selection). No other active/selected styling is applied to the header itself.
- [ ] Confirm behavior when a **document** is clicked: `loadClaudePreview` silently sets `state.claudeTargetFolder` to the document's parent directory (existing behavior, line ~4504). The "✓ Target" header label is refreshed via re-render so it stays honest (see Proposed Changes — the doc clickHandler re-renders after loading the preview). Acceptable, or should doc-click NOT change the target folder?

## Complexity Audit

### Routine
- Replacing the bespoke `renderClaudeDocs` body with a call to `renderFolderGroupedDocs`. The shared helper already exists and is used by 4 other tabs (`renderDesignDocs` 776, `renderBriefsDocs` 848, `renderHtmlDocs` 951, `renderImagesDocs`).
- Filtering `docNodes` to `kind === 'document'` + extension whitelist, and `folderNodes` to `kind === 'folder'` — identical to `renderHtmlDocs` (934-935).
- New `createClaudeDocCard` helper mirrors `createHtmlDocCard` / `createDesignDocCard`.
- Empty-state guard mirrors `renderHtmlDocs` (946).
- Backend grouping is verified safe: `_mapLocalFilesToTreeNodes` (DesignPanelProvider 400-413) sets `metadata.sourceFolder` on claude document nodes via `listClaudeFiles()` (DesignPanelProvider 548-584), so `renderFolderGroupedDocs` grouping by `metadata.sourceFolder` works identically to the other tabs.

### Complex / Risky
- **`folderActionsFn` threaded through 4 action-array sites.** `renderFolderGroupedDocs` hardcodes the "Link" actions array in THREE branches (search: 667-673, configured: 696-702, unconfigured: 717-723) and `renderSubfolderGroups` hardcodes it at 620-626. To support a "Set as target" action for the Claude tab without modifying every call site, an optional `folderActionsFn` callback must be added to `renderFolderGroupedDocs` AND `renderSubfolderGroups`, and threaded through all 3 internal `renderSubfolderGroups` call sites (677, 706, 727). Missing any site leaves the Claude tab showing "Link" on some headers and "Set target" on others.
- **Doc-click target staleness.** `loadClaudePreview` (line 4504) sets `state.claudeTargetFolder` to the clicked document's parent directory. Without a re-render, the "✓ Target" header label becomes stale after a doc click. The plan resolves this by re-rendering in the doc clickHandler (see Proposed Changes).
- **Re-render cost.** Re-rendering `renderClaudeDocs(rootEntry)` on every "Set target" and doc click rebuilds the docList. Collapse state persists (keyed in `state.docsSectionCollapsed` by `${tabKey}::${folderPath}`, read by `buildAccordionFolderHeader` 558-570). The search input (`claude-docs-search`) lives outside `tree-pane-claude`'s cleared innerHTML, so it survives. Only the docList scroll position resets — acceptable.

## Edge-Case & Dependency Audit
- **Folder selection state**: `state.claudeTargetFolder` must still be set when a user picks a target folder. Currently set on folder-card click (line ~4640). Moves to a folder-header "Set as target" action.
- **Visual selection indicator**: The current folder card gets `.selected` class. With accordion headers, the active target is indicated ONLY by the action button label ("✓ Target" vs "Set target"). **Verified:** `buildAccordionFolderHeader` (516-589) has NO selected/active/isSelected parameter — only `actions`, `subheader`, `forceOpen`, `defaultCollapsed`. No header-level active styling is available; the label approach is the sole option.
- **HTML + Image mixed content**: The Claude tab shows both HTML and image files (unlike the HTML tab which only shows HTML). `renderFolderGroupedDocs` groups by `sourceFolder` metadata, not by file type. The current "HTML"/"Images" subheaders will be lost. Acceptable — files are already grouped under their parent folder, and the card subtitle ("HTML"/"Image") still distinguishes them. The `createCardFn` sets the subtitle based on file extension.
- **Search behavior**: `renderFolderGroupedDocs` has its own search path (forceOpen headers, groups by `sourceFolder` of matching docs). The current `renderClaudeDocs` filters by search before rendering. Pass the search term through and let the shared helper handle it (pre-filter `docNodes` by search, then pass `search` to the helper so it force-opens headers).
- **Empty state**: The shared helper does not render an empty-state message when there are no docs. Must add an empty-state fallback when `docNodes` is empty and (search active OR no folders configured), mirroring `renderHtmlDocs` line 946.
- **`claudeTargetFolder` reset**: Line ~2693 resets `state.claudeTargetFolder = ''` on workspace-filter change. No change needed.
- **Doc-click also sets target**: `loadClaudePreview` (4501-4504) derives `state.claudeTargetFolder` from the clicked doc's path. The `createClaudeDocCard` clickHandler must re-render after loading the preview so the "✓ Target" header label stays in sync with the silently-updated target.
- **Empty configured folders during search**: In `renderFolderGroupedDocs`'s search branch (653-678), only folders containing matching docs get headers. An empty configured folder won't appear during search — acceptable, since target selection during search is not a supported flow.
- **Multi-root workspaces**: `renderClaudeDocs` receives `folderPaths` via `getCurrentFolderPaths(state.claudeFolderPathsByRoot, state.claudeWorkspaceRootFilter)` (3124). The shared helper iterates `folderPathsList` (688) and also renders unconfigured folders that contain docs (708-729). Multi-root filtering by `metadata.root` happens upstream (3118-3119) before `renderClaudeDocs` is called. No change needed.

## Dependencies
- None. This is a self-contained webview refactor with no cross-plan dependencies.

## Adversarial Synthesis
Key risks: (1) the `folderActionsFn` parameter must be threaded through all 4 hardcoded "Link" action sites (3 in `renderFolderGroupedDocs` + `renderSubfolderGroups` and its 3 internal call sites) or the Claude tab renders mixed "Set target"/"Link" headers; (2) `buildAccordionFolderHeader` has no selected-state parameter, so the active-target indicator is label-only; (3) doc-click silently mutates `claudeTargetFolder` and will stale the header label unless the clickHandler re-renders. Mitigations: thread `folderActionsFn` through every site explicitly; use the "✓ Target" label as the sole indicator; re-render on both "Set target" and doc click (collapse state and search input survive; only docList scroll resets).

## Proposed Changes

### `src/webview/design.js` — `renderClaudeDocs` (lines ~4551–4661)

Replace the bespoke partition + `renderGroup` logic with a call to `renderFolderGroupedDocs`, matching the pattern in `renderHtmlDocs` (lines ~899–952).

**Before** (abridged):
```js
function renderClaudeDocs(rootEntry) {
    const { sourceId, nodes, folderPaths } = rootEntry;
    const treePaneClaude = document.getElementById('tree-pane-claude');
    if (!treePaneClaude) return;
    treePaneClaude.innerHTML = '';
    // ... toggle row with Manage Folders + collapse btn ...
    const docList = document.createElement('div');
    docList.className = 'source-doc-list';
    docList.dataset.sourceId = sourceId;
    treePaneClaude.appendChild(docList);

    let docNodes = (nodes || []).filter(n => {
        if (n.kind === 'folder') return true;
        const ext = n.name.substring(n.name.lastIndexOf('.')).toLowerCase();
        return ['.html', '.htm', '.png', ...].includes(ext);
    });
    // ... search filter ...
    const folderNodes = docNodes.filter(n => n.kind === 'folder');
    const htmlNodes = ...;
    const imageNodes = ...;
    function renderGroup(subheaderText, groupNodes, isImageGroup) { ... }
    renderGroup('Folders', folderNodes, false);
    renderGroup('HTML', htmlNodes, false);
    renderGroup('Images', imageNodes, true);
}
```

**After** (abridged):
```js
function renderClaudeDocs(rootEntry) {
    const { sourceId, nodes, folderPaths } = rootEntry;
    const treePaneClaude = document.getElementById('tree-pane-claude');
    if (!treePaneClaude) return;
    treePaneClaude.innerHTML = '';
    // ... toggle row with Manage Folders + collapse btn (unchanged) ...
    const docList = document.createElement('div');
    docList.className = 'source-doc-list';
    docList.dataset.sourceId = sourceId;
    treePaneClaude.appendChild(docList);

    // Filter to documents only (exclude folder nodes — they become accordion headers)
    let docNodes = (nodes || []).filter(n => n.kind === 'document');
    docNodes = docNodes.filter(d => {
        const ext = d.name.substring(d.name.lastIndexOf('.')).toLowerCase();
        return ['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(ext);
    });
    const folderNodes = (nodes || []).filter(n => n.kind === 'folder');

    const search = String(state.claudeDocsSearch || '').trim().toLowerCase();
    if (search) {
        docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
    }

    if (docNodes.length === 0 && (search || !folderPaths || folderPaths.length === 0)) {
        docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No matching files found.</div>';
        return;
    }

    renderFolderGroupedDocs(
        docList,
        docNodes,
        folderNodes,
        folderPaths,
        search,
        (doc) => createClaudeDocCard(doc, sourceId, rootEntry),
        'claude',
        (folderPath) => [{
            label: state.claudeTargetFolder === folderPath ? '✓ Target' : 'Set target',
            title: 'Set this folder as the import target',
            onClick: () => {
                state.claudeTargetFolder = folderPath;
                // Re-render to update the action label on all headers
                renderClaudeDocs(rootEntry);
            }
        }]
    );
}
```

> **Clarification (implied by existing behavior, not new scope):** `renderHtmlDocs` has an earlier guard at line 929 (`if ((!nodes || nodes.length === 0) && (!folderPaths || folderPaths.length === 0))`). The "After" omits it because the single `docNodes.length === 0` guard covers the same case (empty nodes + empty folderPaths → docNodes empty + `!folderPaths` true → message shown). The empty-state message text changes from "No files or folders found." to "No matching files found." — acceptable, matches the HTML tab's wording.

### `src/webview/design.js` — New `createClaudeDocCard` helper

Replaces the inline card creation. Sets subtitle based on extension (HTML vs Image). Click handler calls `loadClaudePreview` for documents, then re-renders so the "✓ Target" header label stays in sync with the silently-updated `state.claudeTargetFolder` (set inside `loadClaudePreview` at line ~4504).

```js
function createClaudeDocCard(doc, sourceId, rootEntry) {
    const ext = doc.name.substring(doc.name.lastIndexOf('.')).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(ext);
    return renderDocCard({
        title: doc.name || doc.id,
        subtitle: isImage ? 'Image' : 'HTML',
        sourceId,
        nodeId: doc.id,
        nodeMetadata: doc.metadata,
        actions: [],
        isSelected: state.activeClaudeDocId === doc.id,
        clickHandler: () => {
            loadClaudePreview(sourceId, doc.id, doc.name);
            // loadClaudePreview silently sets state.claudeTargetFolder to the doc's parent (line ~4504).
            // Re-render so the "✓ Target" header label reflects the new target.
            renderClaudeDocs(rootEntry);
        }
    });
}
```

> **Note:** `loadClaudePreview` also manages the `.selected` class on the clicked doc card (4491-4496) and sets `state.activeClaudeDocId` (4498). The re-render preserves the selected visual because `createClaudeDocCard` passes `isSelected: state.activeClaudeDocId === doc.id`. The manual `.selected` toggling inside `loadClaudePreview` becomes redundant after re-render but is harmless.

### `src/webview/design.js` — `folderActionsFn` parameter in `renderFolderGroupedDocs` (line ~642)

Add an optional 8th parameter `folderActionsFn`. When provided, it replaces the default "Link" actions array at **every** header-construction site. There are THREE sites inside `renderFolderGroupedDocs` (search branch 667, configured branch 696, unconfigured branch 717) plus the shared `renderSubfolderGroups` helper (620) which must also receive and use it.

**Signature change:**
```js
function renderFolderGroupedDocs(docList, docNodes, folderNodes, folderPaths, search, createCardFn, tabKey = 'folder-grouped', folderActionsFn = undefined) {
```

**Default actions factory** (use at every site in place of the hardcoded array):
```js
const makeFolderActions = (fp) => folderActionsFn
    ? folderActionsFn(fp)
    : [{ label: 'Link', title: 'Copy folder path to clipboard', onClick: () => vscode.postMessage({ type: 'linkToFolder', folderPath: fp }) }];
```

Apply `makeFolderActions(fp)` (or `makeFolderActions(folder.id)` for subfolders) at:
1. **Search branch** (line ~667): replace the hardcoded array passed to `buildAccordionFolderHeader`.
2. **Configured-folder branch** (line ~696): replace the hardcoded array.
3. **Unconfigured-folder branch** (line ~717): replace the hardcoded array.
4. **`renderSubfolderGroups`** (line ~620): add `folderActionsFn` to its signature and replace its hardcoded array with `makeFolderActions(folder.id)`.
5. **All 3 `renderSubfolderGroups` call sites** inside `renderFolderGroupedDocs` (lines ~677, ~706, ~727): pass `folderActionsFn` through.

```js
// Example for renderSubfolderGroups signature:
function renderSubfolderGroups(docList, docs, subfolderNodes, createCardFn, showAll, tabKey, searchActive = false, folderActionsFn = undefined) {
    // ...
    const actions = folderActionsFn
        ? folderActionsFn(folder.id)
        : [{ label: 'Link', title: 'Copy subfolder path to clipboard', onClick: () => vscode.postMessage({ type: 'linkToFolder', folderPath: folder.id }) }];
    const { headerContainer, contentDiv } = buildAccordionFolderHeader({
        folderPath: folder.id,
        folderName: folder.name,
        docCount: folderDocs.length,
        tabKey,
        actions,
        subheader: true,
        forceOpen: hasSelectedDoc || searchActive
    });
    // ...
}
```

> **Note**: The `folderActionsFn` parameter is added to the shared helpers, so other tabs are unaffected (they don't pass it — the default "Link" action is used). This is a backward-compatible addition. The Claude tab is the only caller that passes `folderActionsFn`.

### `src/webview/design.js` — Remove dead `renderGroup` inner function

The `renderGroup` function inside the old `renderClaudeDocs` (lines ~4612–4657) is deleted entirely — it is no longer called. The `getFileExt` helper (4604-4607) is also dead and removed (the extension check moves into `createClaudeDocCard`).

## Verification Plan

### Automated Tests
- None. This is a webview UI refactor with no unit-test coverage in the repo for `design.js` render functions. Verification is manual via the installed VSIX (per project convention: `dist/` is not used during development; all testing is via an installed extension).

### Manual Verification
1. **Visual consistency**: Open the Design panel, switch to the Claude tab. Confirm folders appear as accordion headers (collapsible), not as cards. Compare side-by-side with the HTML Previews tab — the layout pattern should match.
2. **Folder target selection**: Click "Set target" on a folder header. Confirm the button label changes to "✓ Target". Click "Copy import prompt" in the top strip. Confirm the generated prompt references the selected folder path.
3. **Document preview + target sync**: Click an HTML file card inside a folder accordion. Confirm the preview loads in the right pane AND the parent folder's header label updates to "✓ Target" (because `loadClaudePreview` sets `claudeTargetFolder` to the doc's parent, then the clickHandler re-renders). Click an image file card. Confirm the image preview loads and the target label updates.
4. **Search**: Type a search term in the "Search previews..." input. Confirm folder accordions auto-expand and only matching files are shown (matching the HTML tab's search behavior).
5. **Empty state**: With no folders configured, confirm the empty-state message appears. With folders configured but no matching files, confirm the "No matching files found." message appears.
6. **Other tabs unaffected**: Switch to Design, HTML Previews, Images, and Briefs tabs. Confirm they still show the "Link" action on folder headers (not "Set target") and render correctly.
7. **Sidebar collapse**: Collapse the sidebar via the toggle button. Confirm the Claude tab collapses cleanly (no orphaned folder cards visible).
8. **Collapse-state persistence**: Expand/collapse a few Claude folder accordions, click "Set target" (triggers re-render). Confirm the expand/collapse state of each folder is preserved after the re-render.

## Recommendation
Complexity 5/10 → **Send to Coder**.
