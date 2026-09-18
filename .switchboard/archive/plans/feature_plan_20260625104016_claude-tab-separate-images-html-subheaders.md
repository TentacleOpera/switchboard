# Separate Images and HTML in Claude Tab with Subheaders

## Goal

The Claude tab in `design.html` mixes image files and HTML files in a single flat list under one subheader ("Repo Folders & Files"). The user explicitly requested that images and HTML be separated into distinct groups with their own subheaders (e.g. "HTML" and "Images"), matching the pattern already used by the HTML Previews tab and the Images tab. Folders should also be grouped under their own subheader ("Folders") so the tree is organized by type.

**Core problem & root cause:** The `renderClaudeDocs` function (`design.js` L4204-4293) filters nodes to include folders, HTML files, and image files all in one array (`docNodes`), then renders them in a single loop under one subheader (`'Repo Folders & Files'` at L4257). Unlike `renderHtmlDocs` (which only shows HTML files under an "HTML Previews" subheader) and `renderImagesDocs` (which only shows images under an "Images" subheader), `renderClaudeDocs` does not partition its nodes by type. The fix is to split `docNodes` into three groups — folders, HTML files, and image files — and render each group under its own subheader.

## Metadata

- **Tags:** ui, ux, frontend
- **Complexity:** 2/10

## User Review Required

No. This is a pure rendering reorganization within a single function. No data model, persistence, or API changes. The user's intent is unambiguous and the implementation follows an existing pattern (`renderHtmlDocs` / `renderImagesDocs`).

## Complexity Audit

### Routine
- Splitting the `docNodes` array in `renderClaudeDocs` into three filtered arrays: folders, HTML files, image files.
- Rendering each group under its own `type-subheader` div.
- Reusing the existing `renderDocCard` function for each card (no changes to `renderDocCard` needed).
- Skipping empty groups so no empty subheaders appear.

### Complex / Risky
- None. This is a pure rendering change within one function.

## Edge-Case & Dependency Audit

**Race Conditions:** None. `renderClaudeDocs` is called synchronously from the render pipeline; no async state mutations are introduced.

**Security:** None. No new user input is processed; the existing search filter and node filtering logic are preserved unchanged.

**Side Effects:**
- If a group is empty (e.g. no image files in the configured folders), its subheader should not be rendered. This avoids empty section headers.
- The folder click handler (setting `state.claudeTargetFolder`, updating status, selecting the tree node) and the file click handler (`loadClaudePreview`) are preserved exactly as in the original code — only the grouping/subheader structure changes.

**Dependencies & Conflicts:**
- No dependencies. The `type-subheader` CSS class already exists and is used by `renderHtmlDocs` (L673-676) and `renderImagesDocs` (L746-749).
- `renderDocCard` (L768) signature is unchanged — the plan passes the same parameters (`title`, `subtitle`, `sourceId`, `nodeId`, `nodeMetadata`, `actions`, `isSelected`, `clickHandler`).
- `loadClaudePreview` (L4110) and `findTreeNodeInPane` (L4104) are referenced but not modified.

## Dependencies

- None. This plan is self-contained within `src/webview/design.js`.

## Adversarial Synthesis

Key risks: the `renderGroup` closure helper captures outer-scope variables (fragile if extracted), the pre-existing extension-extraction pattern (`substring(lastIndexOf('.'))`) is triplicated across three filters, and the stale empty-state message at L4235 ("No HTML preview files found.") is misleading for a tab that shows folders + HTML + images. Mitigations: keep `renderGroup` as a local helper (consistent with existing closure patterns in `design.js`); optionally extract a `getFileExt()` helper to reduce duplication; update the L4235 message to "No files or folders found." as a one-line clarification in the same function.

## Proposed Changes

### File 1 — `src/webview/design.js` — `renderClaudeDocs` function (L4204-4293)

**Clarification (not new scope):** The early-return empty-state message at L4235 (`"No HTML preview files found."`) is misleading for a tab that shows folders, HTML, and images. Update it to `"No files or folders found."` — this is a one-line text change in the same function, directly before the replacement block.

Replace the single-list rendering block (L4239-4292) with type-grouped rendering:

```js
// Filter nodes by type
let allNodes = (nodes || []).filter(n => {
    if (n.kind === 'folder') return true;
    const ext = n.name.substring(n.name.lastIndexOf('.')).toLowerCase();
    return ['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(ext);
});

const search = String(state.claudeDocsSearch || '').trim().toLowerCase();
if (search) {
    allNodes = allNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
}

if (allNodes.length === 0) {
    docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No matching files or folders found.</div>';
    return;
}

// Partition by type
const folderNodes = allNodes.filter(n => n.kind === 'folder');
const htmlNodes = allNodes.filter(n => n.kind !== 'folder' && ['.html', '.htm'].includes(n.name.substring(n.name.lastIndexOf('.')).toLowerCase()));
const imageNodes = allNodes.filter(n => n.kind !== 'folder' && ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(n.name.substring(n.name.lastIndexOf('.')).toLowerCase()));

// Helper to render a group with a subheader
function renderGroup(subheaderText, groupNodes, isImageGroup) {
    if (groupNodes.length === 0) return;
    const subheader = document.createElement('div');
    subheader.className = 'type-subheader';
    subheader.textContent = subheaderText;
    docList.appendChild(subheader);

    groupNodes.forEach(doc => {
        const isFolder = doc.kind === 'folder';
        const card = renderDocCard({
            title: doc.name || doc.id,
            subtitle: isFolder ? 'Folder' : (isImageGroup ? 'Image' : 'HTML'),
            sourceId,
            nodeId: doc.id,
            nodeMetadata: doc.metadata,
            actions: [],
            isSelected: isFolder ? false : (state.activeClaudeDocId === doc.id),
            clickHandler: () => {
                if (isFolder) {
                    let relativePath = doc.id.includes(':') ? doc.id.substring(doc.id.indexOf(':') + 1) : doc.id;
                    state.claudeTargetFolder = relativePath;
                    updateClaudeTargetFolderStatus();
                    const pane = document.getElementById('tree-pane-claude');
                    if (pane) {
                        pane.querySelectorAll('.tree-node.selected').forEach(el => el.classList.remove('selected'));
                    }
                    const wrapper = findTreeNodeInPane('tree-pane-claude', doc.id);
                    if (wrapper) wrapper.classList.add('selected');
                } else {
                    loadClaudePreview(sourceId, doc.id, doc.name);
                }
            }
        });
        docList.appendChild(card);
    });
}

renderGroup('Folders', folderNodes, false);
renderGroup('HTML', htmlNodes, false);
renderGroup('Images', imageNodes, true);
```

This replaces the single `'Repo Folders & Files'` subheader with up to three subheaders: "Folders", "HTML", "Images". Empty groups are skipped (no empty subheaders).

**Optional refinement (Clarification):** The extension-extraction expression `n.name.substring(n.name.lastIndexOf('.')).toLowerCase()` is repeated three times (once per group filter). A small helper `function getFileExt(name) { const i = name.lastIndexOf('.'); return i >= 0 ? name.substring(i).toLowerCase() : ''; }` would reduce duplication and also handle the no-extension edge case more cleanly (returns `''` instead of the full filename). This is optional and does not change behavior for the current file types.

## Verification Plan

### Automated Tests

No automated tests required. This is a pure UI rendering change in a webview — verification is manual via the design panel. (Per session directive: skip compilation and automated test execution.)

### Manual Verification

1. Open the design panel, go to the Claude tab, configure folders that contain both HTML and image files.
2. Verify the sidebar shows three distinct sections with subheaders: "Folders", "HTML", "Images".
3. Verify folders appear under "Folders", `.html`/`.htm` files appear under "HTML", and image files (`.png`, `.jpg`, etc.) appear under "Images".
4. Verify that if a folder contains only HTML files (no images), the "Images" subheader does not appear.
5. Verify clicking a folder node still sets the target folder; clicking an HTML/image file still loads the preview.
6. Verify search still filters across all three groups.
7. Verify the empty-state message when no nodes are returned reads "No files or folders found." (not the old "No HTML preview files found.").

## Recommendation

Complexity 2/10 → **Send to Intern**.

## Implementation Status — Implemented 2026-06-25 (Epic Orchestrator)

**Done.** Part of the "Claude Tab: Independent Folder Management" epic. This plan **subsumes** companion plan `feature_plan_20260625104017` (Remove "Repo Folders & Files" subheader).

- **Verification:** `node --check src/webview/design.js` → syntax OK.

### Acceptance Criteria
- [x] `renderClaudeDocs` rendering block rewritten to partition nodes into **Folders / HTML / Images** groups, each under its own `type-subheader`.
- [x] Empty groups are skipped (no empty subheaders) via the `renderGroup` early-return.
- [x] The single invented `'Repo Folders & Files'` subheader is gone (subsumes plan `…104017`).
- [x] Empty-state message updated to `"No files or folders found."` (Claude-tab copy only; `renderHtmlDocs` message untouched).
- [x] Used the optional `getFileExt()` helper to de-duplicate the extension-extraction logic.
- [x] Folder click → sets `state.claudeTargetFolder` + tree selection; file click → `loadClaudePreview`. (Reconciled with plan `…104018`: the new folder-click handler does **not** call the now-deleted `updateClaudeTargetFolderStatus`.)

### Pending (requires running the VSIX — not done by orchestrator)
- [ ] Manual Verification steps 1–7 (visual confirmation of the three sections, empty-group suppression, search across groups).
