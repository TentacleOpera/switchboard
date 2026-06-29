# Add Left/Right Arrow Keyboard Navigation to Sidebar Item Lists

## Goal

### Problem
The Switchboard webview sidebars show a vertical list of document cards. The only way to move through items today is the mouse, plus native vertical scrolling via the Down/Up arrow keys (which scrolls the pane but does not change which item is selected/previewed). There is no keyboard shortcut to advance to the **next** or **previous** item in the list.

The user wants:
- **Right arrow** → advance to the next item (and load its preview, as a click would).
- **Left arrow** → advance to the previous item.
- Down arrow continues to scroll the list vertically (existing native behavior preserved).

This applies to the webview tabs that have a sidebar item list: **planning.html → HTML tab**, and **design.html → Claude / Briefs / HTML Previews / Images / Design System tabs** (the same tabs that have "Manage Folders" sidebars).

### Root Cause
There is **no keyboard handler** for item-list navigation in either webview:

- `planning.js` has only: a mention-autocomplete keydown (line 979, ArrowDown/ArrowUp for @-mentions), a Tab handler in a textarea (6483), and an Escape handler for modals (7046). None target the sidebar item list.
- `design.js` has only: a Space-to-pan handler (406) and Escape handlers (2208, 3793). None target the sidebar item list.

The sidebar item lists are `.source-doc-list` containers (inside `#tree-pane-planning-html`, `#tree-pane-design`, `#tree-pane-briefs`, `#tree-pane-html`, `#tree-pane-claude`, `#tree-pane-images`) holding `.tree-node` elements with `dataset.kind === 'document'`. Selection is tracked via `state.selectedEl` (the `.selected` node) and `state.activeSource`/`state.activeDocId`; clicking a card calls `loadDocumentPreview(sourceId, docId, docName)` (design.js:1079, planning.js:1958) which sets the `.selected` class and loads the preview.

So the fix is purely additive: a keydown listener on each relevant tree pane that, on ArrowLeft/ArrowRight, finds the currently selected `.tree-node` (or the first visible one if none), moves to the previous/next visible document node, and activates it the same way a click would (re-using the existing click handler by calling `.click()` on the target node, which invokes the attached `clickHandler`).

## Metadata
- **Tags**: ui, ux, feature, frontend
- **Complexity**: 3

## User Review Required
- Verify that Left/Right arrow key navigation does not conflict with any existing keyboard shortcuts in either webview (design.html, planning.html).
- Confirm that circular wrapping at list boundaries (Right on last item → first item, Left on first item → last item) is the desired behavior, versus stopping at the boundary.
- Verify that arrow key navigation does not interfere with browser-level or OS-level accessibility tools (e.g., screen readers that use arrow keys for their own navigation).

## Complexity Audit

### Routine
- Purely additive front-end behavior. No backend, no data-model, no persistence changes.
- The selection/activation mechanism already exists (`loadDocumentPreview` + `.selected` class + `.click()` re-trigger).
- Input guard pattern already established in design.js:409 — can be reused directly.
- The same helper functions are duplicated across two files with minimal variation (only the pane IDs differ).
- No CSS or HTML changes required — existing `.tree-node.selected` styling already handles visual feedback.

### Complex / Risky
- **Tab visibility detection**: Tab visibility in design.html uses `.shared-tab-content` wrapper divs with `.active` class (toggled by `switchTab()` at design.js:137-184), NOT `.active` on the tree-pane elements directly. The tree panes are children of these content divs. The correct check is `pane.offsetParent !== null` — when a tab's content wrapper is `display: none`, all children have `offsetParent === null`. The planning.js code already uses `offsetParent !== null` correctly.
- **Key-repeat rate**: Holding down an arrow key will fire `loadDocumentPreview` at key-repeat speed. This is synchronous DOM manipulation + iframe src change, so it won't crash, but rapid-fire preview loads could cause visual flicker. A debounce could be added as a future optimization if needed.
- **Interaction with accordion folders (Issue 1 dependency)**: If folder accordion work lands first, the `offsetParent !== null` filter on document nodes correctly skips collapsed items. If it hasn't landed, the filter is a harmless no-op. Either order is safe.

## Edge-Case & Dependency Audit

### Race Conditions
- None identified. The keydown handler is synchronous — it reads the current DOM state, finds the next node, and calls `.click()`. No async operations or shared mutable state are involved beyond `state.selectedEl`, which is updated synchronously by `loadDocumentPreview`.

### Security
- No security implications. This is a purely client-side UI navigation change within an already-sandboxed webview. No new data is fetched, no user input is sent to any backend, and no DOM content is injected.

### Side Effects
- **Focus in inputs/textareas/search boxes**: ArrowLeft/ArrowRight must do nothing when the event target is an `INPUT`, `TEXTAREA`, `SELECT`, or `contentEditable` element — otherwise typing/editing in the search box or any text field would hijack cursor movement. Guard at the top of the handler (mirrors design.js:409 and planning.js:7050). The guard should also check for `[role="textbox"]` elements for robustness against custom rich-text editors.
- **Collapsed folders**: if Issue 1's accordion work lands first, some document nodes may live inside collapsed `folder-section-content` (display:none). The navigation must skip hidden nodes — filter to `.tree-node[data-kind="document"]` that are visible (`offsetParent !== null` or `getBoundingClientRect().height > 0`). If the accordion work has NOT landed, all nodes are visible and the filter is a no-op. Either way the visible-only filter is correct and safe.
- **No current selection**: if `state.selectedEl` is null/undefined (nothing selected yet), Right arrow selects the first visible document node; Left arrow selects the last. This gives a sensible entry point.
- **List ends**: at the top, Left arrow wraps to the last item; at the bottom, Right arrow wraps to the first. Wrapping is the least surprising behavior for a circular list and avoids a dead-end where the key does nothing.
- **Scroll-into-view**: after activating a node off-screen, call `node.scrollIntoView({ block: 'nearest' })` so the newly selected card is visible. Must not steal scroll position aggressively — `nearest` only scrolls if needed.
- **Preview pane interaction**: design.html HTML Previews embed an iframe that captures keyboard events when focused. The keydown listener is attached to `document` but only acts when the active tab's sidebar is visible. Keyboard events inside the preview iframe do not bubble to the parent document, so no conflict arises.
- **Multiple tabs in one webview**: design.html has 5 sidebar tabs but only one is visible at a time. The handler gates on `pane.offsetParent !== null` to ensure only the currently visible pane responds to arrow keys. Tab visibility is controlled by `.shared-tab-content` wrapper divs with `.active` class — when inactive, the wrapper is `display: none`, making all child panes have `offsetParent === null`.
- **Kanban/Docs/Tickets tabs in planning.html**: out of scope per the user's request (scoped to "those listed in the last complaint"). The handler is written generically so it can be extended later, but only the HTML tab is wired in planning.js.
- **No `confirm()` gates** — this plan adds none (per project rules).

### Dependencies & Conflicts
- No hard dependencies on other plans or features. The folder accordion work (Issue 1) is compatible in either merge order — the `offsetParent !== null` filter handles both states.
- No conflicts with existing keydown handlers: design.js Space-pan (line 406) and Escape (lines 2208, 3793) handle different keys; planning.js mention-autocomplete (line 979) handles ArrowUp/ArrowDown only within the autocomplete context, Tab (line 6483) targets textareas, and Escape (line 7046) targets modals.
- The `stitch` tab in design.html has no tree-pane with document cards and is not affected.
- `tree-pane-online` and `tree-pane-tickets` exist but are out of scope and not wired.

## Dependencies

None

## Adversarial Synthesis

**Risk Summary:** The primary risk was an incorrect tab-visibility check (`pane.classList.contains('active')`) that would have silently broken navigation in design.html — this has been corrected to `pane.offsetParent !== null`, matching the DOM structure where `.active` lives on parent `.shared-tab-content` wrappers, not tree panes. The remaining risks (key-repeat flicker, missing `tabindex` for Tab-key focusing) are low-severity UX polish items that don't block implementation. The plan is fundamentally sound for a Complexity 3 additive feature with well-understood DOM APIs and established patterns in the codebase.

## Proposed Changes

### 1. `src/webview/design.js` — add keyboard navigation helper + wire to all 5 tabs

Add a shared helper near the other interaction code (after `loadDocumentPreview`, ~line 1091):

```js
function getVisibleDocNodes(pane) {
    return Array.from(pane.querySelectorAll('.tree-node[data-kind="document"]'))
        .filter(n => n.offsetParent !== null); // skip nodes hidden by collapsed accordions / display:none
}

function activateDocNode(node) {
    if (!node) return;
    node.click(); // re-uses the existing clickHandler -> loadDocumentPreview
    node.scrollIntoView({ block: 'nearest' });
}

function handleSidebarArrowKeydown(e, pane) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const nodes = getVisibleDocNodes(pane);
    if (nodes.length === 0) return;
    const current = pane.querySelector('.tree-node.selected');
    let idx = current ? nodes.indexOf(current) : -1;
    if (e.key === 'ArrowRight') {
        idx = idx < 0 ? 0 : (idx + 1) % nodes.length;
    } else { // ArrowLeft
        idx = idx < 0 ? nodes.length - 1 : (idx - 1 + nodes.length) % nodes.length;
    }
    activateDocNode(nodes[idx]);
    e.preventDefault();
}
```

Wire a single document-level listener that dispatches to the visible pane (added once, near the existing Escape listeners ~line 3793):

```js
document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const panes = ['tree-pane-design', 'tree-pane-briefs', 'tree-pane-html', 'tree-pane-claude', 'tree-pane-images'];
    for (const id of panes) {
        const pane = document.getElementById(id);
        if (pane && pane.offsetParent !== null) {
            handleSidebarArrowKeydown(e, pane);
            return;
        }
    }
});
```

### 2. `src/webview/planning.js` — add the same helper, wire to the HTML tab only

Add the identical `getVisibleDocNodes` / `activateDocNode` / `handleSidebarArrowKeydown` helpers (planning.js already has `state.selectedEl` and `.tree-node.selected` semantics, so `.click()` re-trigger works the same way). Wire a document-level listener scoped to `#tree-pane-planning-html`:

```js
document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const pane = document.getElementById('tree-pane-planning-html');
    if (pane && pane.offsetParent !== null) { // visible/active tab
        handleSidebarArrowKeydown(e, pane);
    }
});
```

### 3. No CSS / HTML changes required

The existing `.tree-node.selected` styling already highlights the active card, so keyboard-driven selection is visually identical to mouse-driven selection. No new DOM attributes are needed.

## Verification Plan
- [ ] **design.html Design tab**: focus the sidebar (click any card), press Right arrow → next card selects and its preview loads; press Left arrow → previous card selects; wrapping works at both ends.
- [ ] **design.html Briefs / HTML Previews / Images / Claude tabs**: same behavior, independently.
- [ ] **planning.html HTML tab**: Right/Left arrows advance through HTML doc cards and load each preview in the iframe pane.
- [ ] **Down arrow preserved**: pressing Down still scrolls the list vertically without changing selection (native behavior untouched).
- [ ] **Search box unaffected**: typing in any tab's search field and pressing Left/Right moves the text cursor, not the selection (input guard works).
- [ ] **Collapsed folders (post-Issue-1)**: arrow navigation skips cards inside collapsed folder sections and only walks visible cards; expanding a folder makes its cards reachable.
- [ ] **No initial selection**: with nothing selected, Right selects the first card and Left selects the last.
- [ ] **Scroll-into-view**: activating an off-screen card scrolls it smoothly into view without jumping the whole pane.
- [ ] **Cross-tab isolation**: pressing arrows while the Design tab is active does not move the Claude/Briefs/etc. lists.
- [ ] **No confirm dialogs** introduced (per project rules).

### Automated Tests
Tests are skipped per session directive. When tests are authored, they should cover: input guard filtering, circular wrapping at list boundaries, empty pane handling, and cross-tab isolation.

---

**Recommendation: Send to Intern**
