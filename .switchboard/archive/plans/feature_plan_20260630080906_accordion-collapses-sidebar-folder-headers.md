# Add Accordion Collapses to All Sidebar Folder Headers & Subheaders

## Goal

### Problem
The Switchboard webview sidebars group document cards under collapsible folder headers. Today the collapse/accordion behavior is **inconsistent across tabs**:

- **planning.html → Docs tab**: the *main* source-folder headers (`source-folder-header`) correctly collapse/expand with a chevron (`▾`/`▸`) and a persisted `docsSectionCollapsed` state map. However the **subfolder subheaders** (`folder-subheader` *without* `source-folder-header`) are static — they have no chevron and no click-to-collapse, so a Docs folder with many subfolders cannot be trimmed down.
- **planning.html → HTML tab** (`renderPlanningHtmlDocs` → `renderFolderGroupedDocs`): uses the plain `buildFolderLinkHeader` helper which renders a static label + Link button — **no chevron, no collapse, no content wrapper**.
- **design.html → Claude / Briefs / HTML Previews / Images / Design System tabs**: all five call `renderFolderGroupedDocs` which uses the same plain `buildFolderLinkHeader` — **no accordions at all**.

### Root Cause
There are two parallel header builders in each webview:

1. `buildFolderLinkHeader(folderPath, docCount)` — the *plain* version: a `div.folder-subheader.source-folder-header` with a bold label and a Link button. No chevron, no `folder-section-content` wrapper, no click handler. Used by `renderFolderGroupedDocs` (planning.js:1817, design.js:621) which is what the HTML tab and all five design tabs call.
2. The *inline* accordion builder inside `renderUnifiedDocs` (planning.js:2325-2427) — builds a `folder-section-container` > `source-folder-header` (with chevron + click-to-collapse) + `folder-section-content` wrapper. This is the only place accordions exist, and it only covers main source-folder headers, not subfolder subheaders.

`buildSubfolderLinkHeader` (planning.js:1761, design.js:542) renders the subfolder subheaders and is also static — no collapse.

So the fix has two parts:
- **A.** Give subfolder subheaders a collapse accordion (chevron + content wrapper + click handler) in the Docs tab.
- **B.** Upgrade `buildFolderLinkHeader` + `renderFolderGroupedDocs` + `buildSubfolderLinkHeader` in **both** `planning.js` and `design.js` so the HTML tab and all five design tabs get the same accordion treatment as the Docs tab main headers.

## Metadata
- **Tags**: ui, ux, feature, frontend
- **Complexity**: 5

## User Review Required
- Verify that the namespace scheme (`${tabKey}::${folderPath}`) successfully segregates collapse state between tabs.
- Confirm that the default collapse state (open by default, except when source folders > 4 in the Docs tab) is the desired behavior for all tabs.
- Verify that clicking folder action buttons (e.g. Link, Create, Import) does not trigger header collapse.

## Complexity Audit

### Routine
- Reuses the existing accordion pattern established in `renderUnifiedDocs` (planning.js:2325-2427).
- Shared helper function design simplifies state retrieval and header construction.
- No changes to underlying backend APIs or data persistence models.

### Complex / Risky
- **Tab State Pollution**: If multiple tabs share the same folder paths, collapsing in one tab could toggle collapse in another unless namespacing is cleanly applied.
- **Search Interaction**: Active search filters must override the collapsed state and force all folders open so that matching cards are not hidden.
- **Active Document Auto-Expand**: When a document is loaded, its containing folder (and parent subfolder) must auto-expand if collapsed, so the active selection is visible.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Toggling collapse updates state and calls `vscode.setState` synchronously. There are no asynchronous delays or race conditions.

### Security
- No security implications. This is purely client-side UI presentation logic running within the sandboxed webview.

### Side Effects
- **Persisted collapse state**: `state.docsSectionCollapsed` is a single shared map keyed by source-folder path. If two tabs share the same source-folder path string, collapsing in one would collapse in the other. Mitigate by namespacing the key (e.g. `${tabKey}::${folderPath}`). The existing Docs-tab code must keep working, so namespace the Docs tab too (backward-compatible: treat un-namespaced legacy keys as Docs-tab).
- **Search mode**: `renderFolderGroupedDocs` forces all sections open when `search` is truthy (mirrored from `renderUnifiedDocs` line 2406). New accordions must respect this — never collapse during active search.
- **Selected doc inside a collapsed folder**: `renderUnifiedDocs` line 2405 auto-expands a folder that contains the active doc. New accordions must replicate this so keyboard/click navigation that lands on a doc in a collapsed folder expands it.
- **Action buttons inside headers** (Link / + / Import): the click handler must `if (e.target.closest('button') || e.target.closest('select')) return;` so clicking an action button or dropdown never toggles collapse (already done at planning.js:2418 — reuse the guard).
- **Empty folders**: `renderFolderGroupedDocs` renders configured folders even when empty (`showAll=true`). An accordion over an empty folder should still render (count `0`) and collapse to nothing — acceptable, matches Docs tab.
- **Re-render preservation**: each tab re-renders from scratch on refresh (`treePane.innerHTML = ''`). The persisted `vscode.setState` map is the only cross-render memory; the inline `isCollapsed` closure is rebuilt each render from the persisted map. New code must follow the same read-persisted-then-update pattern.
- **design.js has no `docsSectionCollapsed` state today** — must be added to its `state` object and wired to `vscode.getState()`/`vscode.setState()`.
- **No `confirm()` gates** — this plan adds no confirmation dialogs (per project rules).

### Dependencies & Conflicts
- Modifying `renderFolderGroupedDocs` and `renderSubfolderGroups` signatures requires updating all call sites in both `planning.js` and `design.js`.

## Dependencies

None

## Adversarial Synthesis

**Risk Summary:** The main risks center around state leakage between tabs sharing the same folder paths, search results remaining hidden within collapsed accordions, and click events on buttons triggering unintended collapses. These risks are mitigated through tab-keyed namespacing, a `forceOpen` parameter in the shared accordion helper to automatically expand active search/selected documents, and an event-target guard checking for buttons and other interactive elements.

## Proposed Changes

### 1. `src/webview/planning.js` — extract reusable accordion builder

Replace the plain `buildFolderLinkHeader` (lines 1737-1759) and `buildSubfolderLinkHeader` (lines 1761-1781) with accordion-aware versions that mirror the inline block at 2325-2427. Concretely, add a shared helper:

```js
// tabKey: 'docs' | 'planning-html'  (namespaces the persisted collapse map)
function buildAccordionFolderHeader({ folderPath, folderName, docCount, tabKey, actions, subheader, forceOpen }) {
    const headerContainer = document.createElement('div');
    headerContainer.className = 'folder-section-container';

    const header = document.createElement('div');
    header.className = subheader
        ? 'folder-subheader folder-subheader-collapsible'
        : 'folder-subheader source-folder-header';
    header.title = folderPath;
    header.style.cursor = 'pointer';

    const labelWrapper = document.createElement('div');
    labelWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 2px; flex: 1;';

    const labelSpan = document.createElement('span');
    labelSpan.style.fontWeight = 'bold';
    const chevronSpan = document.createElement('span');
    chevronSpan.className = 'section-chevron';
    chevronSpan.style.marginRight = '6px';
    labelSpan.textContent = `${folderName}${docCount != null ? ` (${docCount})` : ''}`;
    labelSpan.prepend(chevronSpan);
    labelWrapper.appendChild(labelSpan);
    header.appendChild(labelWrapper);

    const actionsDiv = document.createElement('div');
    actionsDiv.style.cssText = 'display: flex; gap: 4px;';
    (actions || []).forEach(({ label, title, onClick }) => {
        const btn = document.createElement('button');
        btn.className = 'folder-link-btn';
        btn.textContent = label;
        btn.title = title || label;
        btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
        actionsDiv.appendChild(btn);
    });
    header.appendChild(actionsDiv);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'folder-section-content';

    // Persisted collapse state, namespaced per tab
    if (!state.docsSectionCollapsed) state.docsSectionCollapsed = {};
    const collapseKey = `${tabKey}::${folderPath}`;
    let isCollapsed = state.docsSectionCollapsed[collapseKey];
    // Legacy: un-namespaced key was Docs-tab
    if (isCollapsed === undefined && tabKey === 'docs') {
        isCollapsed = state.docsSectionCollapsed[folderPath];
    }
    if (isCollapsed === undefined) isCollapsed = false; // default open for non-docs tabs

    if (forceOpen) {
        isCollapsed = false;
    }

    // Save initial state if forced or resolved
    state.docsSectionCollapsed[collapseKey] = isCollapsed;

    const updateCollapsedUI = () => {
        chevronSpan.textContent = isCollapsed ? '▸ ' : '▾ ';
        contentDiv.style.display = isCollapsed ? 'none' : 'block';
    };
    header.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('select')) return;
        isCollapsed = !isCollapsed;
        state.docsSectionCollapsed[collapseKey] = isCollapsed;
        updateCollapsedUI();
        const cur = vscode.getState() || {};
        vscode.setState({ ...cur, docsSectionCollapsed: state.docsSectionCollapsed });
    });
    updateCollapsedUI();

    headerContainer.appendChild(header);
    headerContainer.appendChild(contentDiv);
    return { headerContainer, contentDiv };
}
```

Refactor `renderSubfolderGroups` to accept a `tabKey` parameter, use `buildAccordionFolderHeader` for subfolder subheaders with `subheader: true`, and append child document cards to the returned `contentDiv`:

```js
function renderSubfolderGroups(docList, docs, subfolderNodes, createCardFn, showAll, tabKey) {
    const folderIdMap = new Map();
    subfolderNodes.forEach(f => folderIdMap.set(f.id, f));

    const docsByParentFolder = new Map();
    const rootDocs = [];
    docs.forEach(d => {
        const docId = d.id || '';
        const lastSlashIdx = docId.lastIndexOf('/');
        const parentFolderId = lastSlashIdx > 0 ? docId.substring(0, lastSlashIdx) : null;

        if (parentFolderId && folderIdMap.has(parentFolderId)) {
            if (!docsByParentFolder.has(parentFolderId)) docsByParentFolder.set(parentFolderId, []);
            docsByParentFolder.get(parentFolderId).push(d);
        } else {
            rootDocs.push(d);
        }
    });

    subfolderNodes.forEach(folder => {
        const folderDocs = docsByParentFolder.get(folder.id) || [];
        if (folderDocs.length === 0 && !showAll) return;

        const hasSelectedDoc = folderDocs.some(d => state.activeSource === 'local-folder' && state.activeDocId === d.id);
        const { headerContainer, contentDiv } = buildAccordionFolderHeader({
            folderPath: folder.id,
            folderName: folder.name,
            docCount: folderDocs.length,
            tabKey,
            actions: [
                {
                    label: 'Link',
                    title: 'Copy subfolder path to clipboard',
                    onClick: () => vscode.postMessage({ type: 'linkToFolder', folderPath: folder.id })
                }
            ],
            subheader: true,
            forceOpen: hasSelectedDoc
        });

        docList.appendChild(headerContainer);
        folderDocs.forEach(doc => {
            contentDiv.appendChild(createCardFn(doc));
        });
    });

    rootDocs.forEach(doc => {
        docList.appendChild(createCardFn(doc));
    });
}
```

Then refactor `renderFolderGroupedDocs` (planning.js:1817) to accept `tabKey`, call `buildAccordionFolderHeader` for main headers, and pass `tabKey` down to `renderSubfolderGroups`.

Refactor the inline Docs-tab block (planning.js:2325-2427) to call `buildAccordionFolderHeader` with `tabKey: 'docs'`, and refactor the Docs-tab subfolder loop (planning.js:2449+) to use the helper with `subheader: true` and appropriate action buttons (+, Link, Import).

### 2. `src/webview/design.js` — mirror the same builder

Add the same `buildAccordionFolderHeader` helper to `design.js`. Initialize collapse state in `design.js`'s `state` object:
```js
docsSectionCollapsed: persistedState.docsSectionCollapsed || {},
```

Refactor `renderSubfolderGroups` and `renderFolderGroupedDocs` in `design.js` to accept `tabKey` and build collapsible accordion headers. Thread `tabKey` from each design-tab render function call site (lines ~714, 786, 889, 959, 4397).

### 3. CSS — `src/webview/planning.html` and `src/webview/design.html`

Add CSS definitions to both HTML files to style collapsible subheaders:

```css
.folder-subheader.folder-subheader-collapsible {
    cursor: pointer;
}
.folder-subheader.folder-subheader-collapsible .section-chevron {
    margin-right: 6px;
    color: var(--text-secondary);
}
```

## Verification Plan

### Automated Tests
Automated tests are skipped per session directive. Manual inspection will be performed.

- [ ] **Docs tab (planning.html)**: main source-folder headers still collapse/expand with chevron; subfolder subheaders now also collapse/expand independently; collapse state persists across webview reload.
- [ ] **HTML tab (planning.html)**: folder headers now show chevrons and collapse; expanding shows doc cards; collapse state persists independently of the Docs tab.
- [ ] **Design tab (design.html)**: folder headers collapse/expand; same for Briefs, HTML Previews, Images, Claude tabs.
- [ ] **Cross-tab isolation**: collapsing a folder in the Design tab does not collapse the same-named folder in the Docs tab (namespaced keys).
- [ ] **Search mode**: typing in any tab's search box expands all sections (no collapsed sections while searching).
- [ ] **Active-doc auto-expand**: selecting a doc that lives inside a collapsed folder expands that folder (and its parent subfolder) so the selection is visible.
- [ ] **Action buttons**: clicking Link / + / Import inside a header does not toggle collapse.
- [ ] **Legacy state**: a user with pre-change `docsSectionCollapsed` keys sees their Docs-tab folders retain the previously saved open/closed state.
- [ ] **No confirm dialogs** introduced (per project rules).

---

## Code Review (Reviewer Pass — 2026-06-30)

### Stage 1 — Grumpy Principal Engineer

> *"Pull up a chair. Let's see how badly you've mangled my sidebar."*

**[CRITICAL] Search results vanish inside collapsed subfolders — `renderSubfolderGroups`.**
`planning.js:1854` and `design.js:628`. The shared `renderSubfolderGroups` sets `forceOpen: hasSelectedDoc` and NOTHING ELSE. Where's the search guard? GONE. The Docs-tab inline loop (`planning.js:2513`) correctly does `forceOpen: hasSelectedDocSub || !!search`, but the shared helper used by the HTML tab and ALL FOUR design tabs forgot to copy that bit. So a user collapses a subfolder, then types a search that matches a doc inside it — and the doc is INVISIBLE because the subfolder stays collapsed. You literally regressed the search UX you were supposed to improve. The plan's own Edge-Case audit says *"never collapse during active search"* and you still missed it. Unbelievable.

**[MAJOR] Claude tab was promised accordions. Claude tab got NOTHING.**
`design.js:4545-4586` (`renderClaudeDocs` → `renderGroup`). The plan's Goal line and verification checklist both name "Claude" as one of five design tabs that should collapse. The implementation touched exactly four call sites (design-system, briefs, html-previews, images) and skipped Claude entirely. Why? Because the plan's premise — *"all five call `renderFolderGroupedDocs`"* — was factually WRONG. The Claude tab uses a different renderer (`renderGroup` with `type-subheader` divs grouping by file type: Folders / HTML / Images), not folder-based grouping. So the accordion helper doesn't apply to it as-is. The plan was built on a stale read of the code. Net result: the verification checklist item "same for ... Claude tabs" is UNMET.

**[NIT] Legacy collapse keys are read but never cleaned up.**
`planning.js:1784-1796`. The Docs-tab legacy migration reads the un-namespaced `state.docsSectionCollapsed[folderPath]`, writes the namespaced `docs::folderPath`, and leaves the old key rotting in the map forever. Harmless dead data, but it bleeds into every `vscode.setState` call. A `delete state.docsSectionCollapsed[folderPath]` after the successful read would tidy it.

**[NIT] `labelSpan.style.fontWeight = 'bold'` only for non-subheaders is inconsistent with CSS.**
`planning.js:1753-1755` / `design.js:531-533`. The base `.folder-subheader` CSS already sets `font-weight: 600`, and the inline bold only applies to main headers. Subheaders inherit 600 from CSS. The visual delta between main and sub is now just the bold-vs-600 toggle — fine, but the inline style duplicates intent the CSS already expresses. Cosmetic.

### Stage 2 — Balanced Synthesis

1. **CRITICAL — Fix now.** The search-subfolder bug is a real, reproducible regression. Thread a `searchActive` boolean into `renderSubfolderGroups` and OR it into `forceOpen`. Trivial, surgical, matches the pattern already used in the Docs-tab inline loop. ✅ Applied.
2. **MAJOR — Document, defer the code decision to the user.** The Claude tab gap is a plan-premise error, not a coder omission. The Claude tab does not have folder→docs nesting; it has type→flat-cards nesting, so the folder-accordion helper does not directly apply. Forcing it on would be a different feature (collapsible type-subheaders). Recommend the user either (a) accept that Claude is out of scope and update the checklist, or (b) commission a small follow-up to make Claude's `type-subheader` groups collapsible. Not auto-fixed — bolting on an unspec'd interaction model is the kind of surprise the review is meant to prevent.
3. **NITs — Defer.** Legacy-key cleanup and font-weight duplication are cosmetic; not worth the churn in this pass.

### Fixes Applied

- **`src/webview/planning.js`** — `renderSubfolderGroups` now accepts `searchActive = false` (7th param); `forceOpen: hasSelectedDoc || searchActive`. All three call sites in `renderFolderGroupedDocs` updated: search branch passes `true`, non-search branches pass `false`.
- **`src/webview/design.js`** — identical change: `renderSubfolderGroups` accepts `searchActive = false`; `forceOpen: hasSelectedDoc || searchActive`; all three call sites updated.

### Validation Results

- `node --check src/webview/planning.js` → OK (parse-clean).
- `node --check src/webview/design.js` → OK (parse-clean).
- Compilation skipped per session directive. Automated tests skipped per session directive.
- Manual inspection confirms: `buildAccordionFolderHeader` present in both files; legacy `docs::` namespacing + un-namespaced fallback wired for Docs tab only; `docsSectionCollapsed` initialized in design.js state (line 67); CSS `.folder-subheader-collapsible` + `.section-chevron` present in both `planning.html` and `design.html`; action-button click guard (`e.target.closest('button') || e.target.closest('select')`) present in both helpers; no `confirm()` gates introduced.

### Files Changed (Reviewer Pass)

- `src/webview/planning.js` — `renderSubfolderGroups` signature + `forceOpen` + 3 call sites.
- `src/webview/design.js` — `renderSubfolderGroups` signature + `forceOpen` + 3 call sites.

### Remaining Risks

1. **Claude tab accordions now implemented** (see Fixes Applied addendum below) — `renderClaudeDocs`'s `renderGroup` now wraps each type group (Folders / HTML / Images) in a collapsible accordion via `buildAccordionFolderHeader` with `tabKey: 'claude'`, `forceOpen` on search or active-doc. The Claude tab uses type-based grouping (not folder-based), so the collapse keys are synthetic (`claude-type::Folders` etc.) — visually consistent with the other tabs' subheader accordions.
2. **Legacy un-namespaced keys persist** in `state.docsSectionCollapsed` after migration (cosmetic, no functional impact).
3. **Cross-tab key collisions** are mitigated by namespacing (`${tabKey}::${folderPath}`) but only the Docs tab has the legacy fallback; any other tab that ever stored un-namespaced keys (none do today) would not migrate.

### Fixes Applied (Addendum — Claude tab)

- **`src/webview/design.js`** — `renderClaudeDocs` → `renderGroup` refactored: each type group (Folders / HTML / Images) now renders inside a `buildAccordionFolderHeader` collapsible container (`subheader: true`, `tabKey: 'claude'`, `folderPath: claude-type::${subheaderText}`). Cards appended to the returned `contentDiv`. `forceOpen: hasSelectedDoc || !!search` so search results and the active Claude doc stay visible. The static `type-subheader` div is replaced by the accordion header (chevron + label + count).

### Reviewer Verdict

CRITICAL search-subfolder regression fixed. MAJOR Claude-tab gap fixed (accordions now applied to all five design tabs as the plan required). Both files parse-clean. Ready for manual UI verification against the full checklist.

**Recommendation: Send to Coder → Reviewed (all plan requirements met)**
