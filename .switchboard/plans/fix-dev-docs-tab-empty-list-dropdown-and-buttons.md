# Fix the Dev Docs Tab: Restore the File List, Style & Sync the Workspace Picker, and Un-grey the Action Buttons

## Goal

The **Dev Docs** tab in `planning.html` is non-functional. Four user-reported symptoms, which resolve to three independent defects (two of the symptoms share one root cause):

1. **Workspace dropdown is unstyled** (native OS white control) instead of matching the tab theme.
2. **Workspace dropdown does not sync** with the workspace shown in the Kanban board.
3. **No files are detected** — the list is empty in *both* the "Docs" and "README" source modes, even though the repo's `docs/` folder is full of `.md` files and a root `README.md` exists.
4. **Import** and **Draft with agent** buttons are permanently greyed out.

### Root-cause analysis

**Symptom 3 + 4 share one cause — a missing function (the linchpin).**
`renderDevDocsList()` (`src/webview/planning.js:11386`) begins:

```js
function renderDevDocsList() {
    if (!devdocsListPane) return;
    devdocsListPane.innerHTML = '';                                          // pane cleared
    devdocsListPane.appendChild(buildSidebarToggleRow(state.devdocsListCollapsed));  // ← ReferenceError
    ...
}
```

`buildSidebarToggleRow` appears exactly **once** in the entire file — at the call site above — and is **never defined** (no function declaration, no `const`/arrow, no `window.` assignment). So every call to `renderDevDocsList()` throws `ReferenceError: buildSidebarToggleRow is not defined` *after* it has already blanked the pane and *before* it appends any doc rows.

Consequences:
- The list pane is left empty regardless of source mode → **Symptom 3** ("empty in both modes"). The backend (`_listDevDocs`, `PlanningPanelProvider.ts:9250`) correctly returns the `docs/` files and the root README tagged `sourceType:'readme'`; the data arrives fine — the render just crashes.
- The throw propagates out of the `case 'devDocsList':` handler (`planning.js:4348`), so the auto-select-first-doc logic at the end of `renderDevDocsList()` and the `_pendingDevDocSelection` block never run. No doc is ever selected → `readDevDoc` is never sent → the `devDocContent` handler (`planning.js:4365-4370`) — the **only** place `btn-import-devdoc` and `btn-agent-devdoc` are enabled — never fires → **Symptom 4**.

Why the helper was expected: every other list tab keeps a **static** `.sidebar-toggle-row` in HTML (it is present in the Dev Docs markup too, `planning.html:3869-3871`) and renders its list into a sub-container, so the toggle row is never destroyed. The Dev Docs tab instead wipes the entire pane with `innerHTML = ''` (destroying that static row) and was meant to rebuild the row programmatically via `buildSidebarToggleRow` — a helper that was never authored.

**Symptom 1 — missing CSS class.** In `planning.html:3851` the workspace `<select id="devdocs-workspace-filter">` carries **no class**, while its immediate sibling `<select id="devdocs-source-filter" class="workspace-filter-select">` (`:3854`) is styled. The unclassed select falls back to the native control.

**Symptom 2 — no kanban-root defaulting + stale item list.** The Dev Docs dropdown is hand-populated by `populateDevDocsAndNotebookFilters()` (`planning.js:11560`) from `_kanbanWorkspaceItems`, and it hard-defaults the filter value to `''` ("All Workspaces"). It never resolves to the Kanban-selected root the way the sibling **Docs** tab does via `resolveDocsWorkspaceFilter()` (`planning.js:91`, using `_kanbanDefaultRoot`). Worse, `_kanbanWorkspaceItems` is only filled on a `fetchKanbanPlans` round-trip, and switching to the Dev Docs tab (`planning.js:1989`) sends only `loadDevDocs` — never a workspace-items fetch — so on a cold open the dropdown is empty/stale.

Confirmed decision (from consultation): the desired sync model is **default to the Kanban workspace on load, but remember an explicit user override** — identical to the Docs tab, and consistent with the standing "planning tabs need independent workspace dropdowns" rule. This is *default-to*, not *hard-mirror*.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, bugfix

## Non-Goals

- No change to the backend `_listDevDocs` / `readDevDoc` / import / draft-prompt logic — the backend is correct.
- No migration concerns: the Dev Docs tab is unreleased dev work (commit `8a14023`), so clean breaks are fine (no `*.migrated.bak`, no compat shims).
- No confirmation dialogs anywhere (delete stays immediate).

## Implementation Plan

### Fix A — Define `buildSidebarToggleRow` (fixes Symptoms 3 & 4)

Add a helper in `planning.js`, in the same closure/scope as `renderDevDocsList` (near the other Dev Docs helpers, before `renderDevDocsList`), that returns the toggle-row DOM node the render function expects:

- Build a `<div class="sidebar-toggle-row">` containing a `<button class="sidebar-toggle-btn" title="Toggle sidebar">` whose glyph is `»` when `collapsed` is truthy, else `«` (matching `applySidebarState`, `planning.js:1909-1911`).
- Wire the button's `click` to toggle `state.devdocsListCollapsed`, call `applySidebarState('devdocs', state.devdocsListCollapsed)`, and persist via the same `vscode.setState({... devdocsListCollapsed ...})` pattern used by `toggleSidebarCollapsed` (`planning.js:1929-1937`). Persist `devdocsListCollapsed` alongside the existing keys so a `let devdocsListCollapsed` should be added to the persisted `vscode.setState` payload and restored on init.
- Return the node (so the existing `devdocsListPane.appendChild(buildSidebarToggleRow(...))` call works unchanged).

Rationale for this over refactoring `renderDevDocsList` to preserve a static row: it is the smallest change that matches the code's existing intent and call signature, and it keeps the Dev Docs tab's "wipe-and-rebuild" render model intact.

**Secondary consistency fix:** `toggleSidebarCollapsed()` (`planning.js:1912`) has no `devdocs` branch (its `else` handles docs/research). Because the helper above wires its own click handler, `toggleSidebarCollapsed` does not strictly need updating — but add a `devdocs` branch there too for parity so any future delegated `.sidebar-toggle-btn` handler behaves correctly. (Verify whether a delegated global handler already dispatches to `toggleSidebarCollapsed`; if so, the helper's own handler and the delegated one must not double-toggle — wire only one.)

### Fix B — Style the workspace dropdown (fixes Symptom 1)

In `planning.html:3851`, add `class="workspace-filter-select"` to `<select id="devdocs-workspace-filter">` so it matches the source dropdown and the rest of the tab. (Keep the `margin-right`/spacing consistent with the source select at `:3854`.)

### Fix C — Default the workspace picker to the Kanban root, with override (fixes Symptom 2)

1. **Ensure workspace items are fresh on tab entry.** In the tab-switch block (`planning.js:1989`, the `if (tabName === 'devdocs')` branch), also request the workspace item list so the dropdown is never empty on a cold open — send a `fetchKanbanPlans` (matching the Docs/Notebook tabs) *in addition to* `loadDevDocs`. This populates `_kanbanWorkspaceItems` and triggers `populateDevDocsAndNotebookFilters()`.

2. **Resolve the default like the Docs tab.** Replace the hard `devdocsWorkspaceFilter.value = _devDocsWsFilter || ''` in `populateDevDocsAndNotebookFilters()` (`planning.js:11572`) with a resolver that mirrors `resolveDocsWorkspaceFilter` semantics:
   - If the user has an explicitly restored/persisted choice (including `''` = deliberately "All Workspaces"), honor it.
   - Else default to the Kanban-selected root (`_kanbanDefaultRoot`) when it is present among the items.
   - Else fall back to the first workspace.
   Set both `_devDocsWsFilter` and `devdocsWorkspaceFilter.value` from that result.

3. **Persist explicit overrides.** In the dropdown `change` handler (`planning.js:11417`), persist the chosen root via the existing `persistTab(...)` mechanism (e.g. key `devdocs.root`) and add the corresponding restore on init, so an explicit choice survives reloads and wins over the Kanban default — exactly as `docs.root` does.

4. **Workspace-root normalization check (correctness).** The client-side filter compares `d.workspaceRoot === _devDocsWsFilter`. Confirm the dropdown option values (`_kanbanWorkspaceItems[].workspaceRoot`) are normalized identically to the backend's `_listDevDocs` output (`path.resolve(root)` via `buildWorkspaceItems`). If they can differ (trailing separators, symlink/case), normalize both sides before comparing so selecting a specific workspace does not silently empty the list. This defect is currently masked by Symptom 3.

### Fix D — Make Import available without a prior selection (hardens Symptom 4)

Once Fix A restores auto-select, both buttons enable normally when a doc is selected. However, **Import** (clipboard → *new* doc) does not logically require an existing selection. Enable `btn-import-devdoc` whenever a workspace is resolvable — i.e. enable it in `populateDevDocsAndNotebookFilters()` / on tab load — rather than gating it solely behind `devDocContent`. Its click handler already derives the target root from the dropdown/filter and falls back sensibly (`planning.js:11466-11470`), so no selection is needed.

Leave **Draft/Improve with agent** (`btn-agent-devdoc`) gated on a selection: by design it operates on the selected doc ("Draft" when the selected doc is empty, "Improve" when it has content), so enabling it on selection (restored by Fix A) is correct.

## Edge Cases & Risks

- **Empty `docs/` folder + no README:** list should show the existing empty-state copy ("No dev docs yet…" / "No README found…"), not crash. Verify after Fix A.
- **Multi-root workspaces:** with "All Workspaces" selected, rows show their `workspaceLabel` badge (existing behavior in `renderDevDocsList`). Confirm defaulting logic still lets the user pick "All Workspaces" explicitly and that it sticks.
- **Collapse-state persistence:** adding `devdocsListCollapsed` to `vscode.setState` must not clobber the other persisted collapse keys — spread the existing state as the sibling code does.
- **Double-toggle:** if a delegated global click handler for `.sidebar-toggle-btn` already exists, ensure the new per-row handler doesn't also fire (pick one owner).
- **Regression scope:** all changes are confined to the Dev Docs code paths in `planning.js` + one attribute in `planning.html`; the Notebook tab (card layout, no `buildSidebarToggleRow`) and other tabs are untouched.

## Verification

Testing is via an installed VSIX (per project rules); `src/` is source of truth. After building/installing:

1. Open the planning panel → **Dev Docs** tab. **Docs** mode lists the repo `docs/*.md` files; the first is auto-selected and its preview renders.
2. Switch source to **README** → the root `README.md` appears (badge shown) and renders.
3. With the webview dev-tools console open, confirm **no** `ReferenceError` / `[PlanningPanel] Message handler error` on tab entry.
4. Workspace dropdown is themed (not native white) and, on cold open, defaults to the Kanban board's current workspace; changing it filters the list and the choice survives a panel reload; "All Workspaces" can be chosen and sticks.
5. **Import** is clickable with no doc selected (paste markdown → new doc imported and list refreshes). **Draft/Improve with agent** enables once a doc is selected and copies the correct prompt.
6. Sidebar collapse toggle (`«`/`»`) works in the Dev Docs tab and its state persists across reloads.

## User Review Required

None.
