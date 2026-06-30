# Claude Tab Sidebar Renders Folders as Cards — Align with Other Tabs

## Goal

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
- **Tags**: `design-panel`, `claude-tab`, `sidebar`, `ux-consistency`, `ui`
- **Complexity**: 4/10

## Complexity Audit
- **Routine**: Replacing the bespoke `renderClaudeDocs` body with a call to `renderFolderGroupedDocs`. The shared helper already exists and is used by 4 other tabs.
- **Complex/Risky**: Preserving the folder-target-selection behavior. `renderFolderGroupedDocs` accepts a `createCardFn` for document cards but folder headers get a fixed `actions` array. We need the folder header to support a "Set as target" action that sets `state.claudeTargetFolder` and visually marks the folder as selected. The `buildAccordionFolderHeader` `actions` array already supports arbitrary click handlers (other tabs use "Link"), so this is a matter of passing the right action.

## Edge-Case & Dependency Audit
- **Folder selection state**: `state.claudeTargetFolder` must still be set when a user picks a target folder. Currently set on card click (line ~4640). Must move to a folder-header action.
- **Visual selection indicator**: Currently a folder card gets `.selected` class. With accordion headers, we need to indicate which folder is the active target. The `buildAccordionFolderHeader` supports a selected/active state — verify and use it.
- **HTML + Image mixed content**: The Claude tab shows both HTML and image files (unlike the HTML tab which only shows HTML). `renderFolderGroupedDocs` groups by `sourceFolder` metadata, not by file type. The current "HTML"/"Images" subheaders will be lost. Acceptable — files are already grouped under their parent folder, and the card subtitle ("HTML"/"Image") still distinguishes them. The `createCardFn` can set the subtitle based on file extension.
- **Search behavior**: `renderFolderGroupedDocs` has its own search path (forceOpen headers). The current `renderClaudeDocs` filters by search before rendering. Must pass the search term through and let the shared helper handle it, OR pre-filter `docNodes` and pass `search` to the helper.
- **Empty state**: The shared helper does not render an empty-state message when there are no docs. The current code does. Must add an empty-state fallback when `docNodes` is empty and no folders are configured.
- **`claudeTargetFolder` reset**: Line ~2693 resets `state.claudeTargetFolder = ''` on certain messages. No change needed.

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
        (doc) => createClaudeDocCard(doc, sourceId),
        'claude'
    );
}
```

### `src/webview/design.js` — New `createClaudeDocCard` helper

Replaces the inline card creation. Sets subtitle based on extension (HTML vs Image). Click handler calls `loadClaudePreview` for documents.

```js
function createClaudeDocCard(doc, sourceId) {
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
        clickHandler: () => loadClaudePreview(sourceId, doc.id, doc.name)
    });
}
```

### `src/webview/design.js` — Folder-target selection via header action

The `renderFolderGroupedDocs` helper passes a fixed `actions` array to `buildAccordionFolderHeader` (a "Link" button). To support folder-target selection without modifying the shared helper, add an optional `folderActionsFn` callback parameter to `renderFolderGroupedDocs` that, if provided, replaces the default actions array. For the Claude tab, pass a function that returns a "Set as target" action:

```js
// In renderFolderGroupedDocs, replace the hardcoded actions array:
const actions = folderActionsFn
    ? folderActionsFn(fp)
    : [{ label: 'Link', title: 'Copy folder path to clipboard', onClick: () => vscode.postMessage({ type: 'linkToFolder', folderPath: fp }) }];
```

And in `renderClaudeDocs`, pass:
```js
renderFolderGroupedDocs(
    docList, docNodes, folderNodes, folderPaths, search,
    (doc) => createClaudeDocCard(doc, sourceId),
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
```

> **Note**: The `folderActionsFn` parameter is added to the shared helper, so other tabs are unaffected (they don't pass it — the default "Link" action is used). This is a backward-compatible addition.

### `src/webview/design.js` — Remove dead `renderGroup` inner function

The `renderGroup` function inside the old `renderClaudeDocs` (lines ~4612–4657) is deleted entirely — it is no longer called.

## Verification Plan
1. **Visual consistency**: Open the Design panel, switch to the Claude tab. Confirm folders appear as accordion headers (collapsible), not as cards. Compare side-by-side with the HTML Previews tab — the layout pattern should match.
2. **Folder target selection**: Click "Set target" on a folder header. Confirm the button label changes to "✓ Target". Click "Copy import prompt" in the top strip. Confirm the generated prompt references the selected folder path.
3. **Document preview**: Click an HTML file card inside a folder accordion. Confirm the preview loads in the right pane. Click an image file card. Confirm the image preview loads.
4. **Search**: Type a search term in the "Search previews..." input. Confirm folder accordions auto-expand and only matching files are shown (matching the HTML tab's search behavior).
5. **Empty state**: With no folders configured, confirm the empty-state message appears. With folders configured but no matching files, confirm the "No matching files found." message appears.
6. **Other tabs unaffected**: Switch to Design, HTML Previews, Images, and Briefs tabs. Confirm they still show the "Link" action on folder headers (not "Set target") and render correctly.
7. **Sidebar collapse**: Collapse the sidebar via the toggle button. Confirm the Claude tab collapses cleanly (no orphaned folder cards visible).
