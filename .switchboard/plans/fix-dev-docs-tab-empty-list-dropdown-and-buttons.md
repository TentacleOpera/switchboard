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
    devdocsListPane.innerHTML = '';                                          // pane cleared (planning.js:11388)
    devdocsListPane.appendChild(buildSidebarToggleRow(state.devdocsListCollapsed));  // ← ReferenceError (planning.js:11389)
    ...
}
```

`buildSidebarToggleRow` appears exactly **once** in the entire file — at the call site above (`planning.js:11389`) — and is **never defined** (no function declaration, no `const`/arrow, no `window.` assignment; verified by grep against current `src/`). So every call to `renderDevDocsList()` throws `ReferenceError: buildSidebarToggleRow is not defined` *after* it has already blanked the pane and *before* it appends any doc rows.

Consequences (all verified against current `src/`):
- The list pane is left empty regardless of source mode → **Symptom 3** ("empty in both modes"). The backend (dev-docs list handler, reached via `PlanningPanelProvider.ts` → `planningService.ts:454` `loadDevDocs` → `handleMessage`) correctly returns the `docs/` files and the root README tagged `sourceType:'readme'`; the frontend already filters on `d.sourceType === 'readme'` and renders a README badge (`planning.js:11396-11423`). The data arrives fine — the render just crashes.
- The throw propagates out of the `case 'devDocsList':` handler (`planning.js:4348-4356`), so (a) the auto-select-first-doc logic at the end of `renderDevDocsList()` (`planning.js:11433-11439`) and (b) the `_pendingDevDocSelection` block (`planning.js:4351-4355`, which runs *after* the `renderDevDocsList()` call on line 4350) never run. No doc is ever selected → `readDevDoc` is never sent → the `devDocContent` handler (`planning.js:4357-4374`) — the **only** place `btn-import-devdoc` and `btn-agent-devdoc` are enabled (`planning.js:4366-4371`) — never fires → **Symptom 4**.

Why the helper was expected: every other list tab keeps a **static** `.sidebar-toggle-row` in HTML (it is present in the Dev Docs markup too, `planning.html:3870`) and renders its list into a sub-container, so the toggle row is never destroyed. The Dev Docs tab instead wipes the entire pane with `innerHTML = ''` (destroying that static row) and was meant to rebuild the row programmatically via `buildSidebarToggleRow` — a helper that was never authored.

**Symptom 1 — missing CSS class.** In `planning.html:3852` the workspace `<select id="devdocs-workspace-filter">` carries **no class**, while its immediate sibling `<select id="devdocs-source-filter" class="workspace-filter-select" style="margin-right: 12px;">` (`planning.html:3855`) is styled. The unclassed select falls back to the native control.

**Symptom 2 — no kanban-root defaulting + stale item list.** The Dev Docs dropdown is hand-populated by `populateDevDocsAndNotebookFilters()` (`planning.js:11592`) from `_kanbanWorkspaceItems`, and it hard-defaults the filter value to `''` ("All Workspaces") at `planning.js:11604`. It never resolves to the Kanban-selected root the way the sibling **Docs** tab does via `resolveDocsWorkspaceFilter()` (`planning.js:91`). Worse, `_kanbanWorkspaceItems` is only filled on a `fetchKanbanPlans` round-trip (`handleKanbanPlansReady`, `planning.js:7206-7207`), and switching to the Dev Docs tab (`planning.js:1990-1992`) sends only `loadDevDocs` — never a workspace-items fetch — so on a cold open the dropdown is empty/stale.

Confirmed decision (from consultation): the desired sync model is **default to the Kanban workspace on load, but remember an explicit user override** — identical to the Docs tab, and consistent with the standing "planning tabs need independent workspace dropdowns" rule. This is *default-to*, not *hard-mirror*.

> **Superseded:** "default to the Kanban-selected root (`_kanbanDefaultRoot`)" as the sole source of the default.
> **Reason:** `_kanbanDefaultRoot` is assigned in exactly one place — `handleLocalDocsReady` (`planning.js:3458`), which fires on the **Docs/Local** tab round-trip. The Dev Docs tab-entry fetch (`fetchKanbanPlans` → `handleKanbanPlansReady`, `planning.js:7206`) populates `_kanbanWorkspaceItems` but does **not** set `_kanbanDefaultRoot`. On a cold Dev Docs open (user never visited Docs/Local), `_kanbanDefaultRoot` is `null`, so the resolver silently falls through to "first workspace" — Symptom 2's "sync to the board" goal is not actually met even though the dropdown *appears* populated.
> **Replaced with:** The resolver defaults to **`kanbanFilters.workspaceRoot || _kanbanDefaultRoot`** — `kanbanFilters.workspaceRoot` (`planning.js:6545` decl; the board's live in-memory selection, restored from persisted `kanban.root`) is the workspace *actually shown on the board* and is populated independent of tab-visit order. `_kanbanDefaultRoot` remains a secondary fallback. Both are module-scope and in scope where `populateDevDocsAndNotebookFilters()` runs.

## Metadata

**Tags:** frontend, ui, ux, bugfix
**Complexity:** 5

> **Superseded:** **Complexity:** 4
> **Reason:** The naive reading ("author one missing helper + one CSS class") is a 3-4, but the improve pass surfaced two genuine correctness risks that require cross-referencing multiple message paths: (1) the picker default must be sourced from `kanbanFilters.workspaceRoot`, not the tab-order-dependent `_kanbanDefaultRoot`; (2) the `d.workspaceRoot === _devDocsWsFilter` path comparison is an un-normalized `===` on filesystem paths that silently empties the list, currently masked by Symptom 3 and *un*-masked the moment Fix A lands. This is "mixed": majority routine, but with two moderate, well-scoped risks extending existing patterns.
> **Replaced with:** **Complexity:** 5 (Mixed).

## User Review Required

None.

## Non-Goals

- No change to the backend dev-docs list / `readDevDoc` / import / draft-prompt logic — the backend is correct.
- No migration concerns: the Dev Docs tab is unreleased dev work (commit `8a14023`), so clean breaks are fine (no `*.migrated.bak`, no compat shims).
- No confirmation dialogs anywhere (delete stays immediate).
- **Not** re-architecting `renderDevDocsList` to stop wiping the pane (alternative A1 in the Adversarial Synthesis). That is the principled long-term design but is out of scope for a four-symptom bugfix; noted as a follow-up if the tab is touched again.

## Complexity Audit

### Routine
- Authoring `buildSidebarToggleRow` — small, self-contained DOM builder matching an existing call signature (`planning.js:11389`).
- Adding `class="workspace-filter-select"` to one `<select>` (Fix B) — one attribute.
- Persisting/restoring `devdocsListCollapsed` — mirrors existing collapse-key persistence (`planning.js:1930-1937`).
- Enabling `btn-import-devdoc` on tab load — mirrors existing button-state toggles.

### Complex / Risky
- **Picker default sourcing** — must read the *live board selection* (`kanbanFilters.workspaceRoot`), not the tab-order-dependent `_kanbanDefaultRoot`; getting this wrong makes Symptom 2 silently unfixed while appearing fixed.
- **Workspace-root path normalization** — `d.workspaceRoot === _devDocsWsFilter` is un-normalized string equality on absolute paths; a mismatch (trailing sep / symlink / case) silently empties the list. Masked today by Symptom 3; live after Fix A.
- **Cross-handler button-state consistency** — Fix D must be honored in *all* paths that touch `btn-import-devdoc.disabled` (tab load, delete, external delete), not just the enable path.

## Edge-Case & Dependency Audit

**Race Conditions**
- On tab switch, `applySidebarState('devdocs', …)` runs synchronously (`planning.js:1981`) while `loadDevDocs` is dispatched async; the `devDocsList` response then replaces the toggle row via `renderDevDocsList()`. There is a brief window where the *static* HTML toggle button is live. It is bound (at init, `planning.js:1948-1950`) to `toggleSidebarCollapsed`, whose `else` branch toggles **docs** state, not devdocs — a latent mis-toggle in that window. The `devdocs` branch added in Fix A's secondary fix closes it. No data race (single-threaded webview).

**Security**
- None. All changes are DOM/state within the sandboxed webview; no new message types, no new backend surface, no external I/O, no `eval`/`innerHTML` of untrusted content (doc titles already pass through `escapeHtml`, `planning.js:11417-11423`).

**Side Effects**
- Fix C step 1 sends `fetchKanbanPlans` on Dev Docs tab entry. This triggers `handleKanbanPlansReady`, which re-renders kanban DOM (in the hidden kanban tab) and repopulates several dropdowns. This is an **already-accepted** pattern — the Notebook tab does exactly this via `hydrateNotebookTab()` (`planning.js:11530-11537`). Low risk; mirror that precedent.
- Adding `devdocsListCollapsed` to the `vscode.setState({...})` payload must **spread** the existing persisted object (as `toggleSidebarCollapsed` already does, `planning.js:1930-1937`) so it does not clobber the other collapse keys.

**Dependencies & Conflicts**
- Backend emitter of option `workspaceRoot` values is `buildWorkspaceItems` (`src/services/workspaceUtils.ts:6`), which uses `path.resolve(root)` (lines 23/61/74/80). Fix C step 4 must ensure the dev-docs list's emitted `workspaceRoot` is normalized identically (`path.resolve`) before the frontend `===` comparison — normalize both sides if there is any doubt.
- No conflict with the Notebook tab: it uses a card layout with no `buildSidebarToggleRow` and a separate first-workspace default (`planning.js:11607-11617`); it is untouched.

## Dependencies

None. No cross-session (`sess_…`) dependencies — this is a self-contained frontend bugfix in `planning.js` + `planning.html`. The backend list/read path (`planningService.ts`) is a read-only precondition, already shipped and correct; no coordinating plan is required.

## Adversarial Synthesis

Key risks: (1) the picker default sourced from the tab-order-dependent `_kanbanDefaultRoot` (null on cold open) makes Symptom-2 "sync" *appear* fixed while actually falling back to first-workspace — resolve by preferring `kanbanFilters.workspaceRoot`; (2) `d.workspaceRoot === _devDocsWsFilter` is un-normalized path equality that will silently empty the list once Fix A un-masks it — normalize both sides with `path.resolve`; (3) Fix D's "import without selection" is contradicted by the delete handlers that re-disable the import button. Mitigations: seed the default from the live board selection, normalize path comparisons, and strip `btnImportDevdoc.disabled = true` from the delete/external-delete handlers. The "double-toggle" concern is resolved (not a risk — the init binding is per-node, not delegated; the rebuilt row escapes it).

## Proposed Changes

### `src/webview/planning.js` (Fixes A, C, D)

#### Fix A — Define `buildSidebarToggleRow` (fixes Symptoms 3 & 4)

**Context:** `renderDevDocsList()` (`planning.js:11386`) wipes the pane (`innerHTML = ''`, line 11388) then calls the never-defined `buildSidebarToggleRow` (line 11389), throwing before any rows render.

**Logic:** Author the helper the code already calls, in the same closure/scope as `renderDevDocsList` (near the other Dev Docs helpers, before `renderDevDocsList`), returning the toggle-row DOM node the render function expects.

**Implementation:**
- Build a `<div class="sidebar-toggle-row">` containing a `<button class="sidebar-toggle-btn" title="Toggle sidebar">` whose glyph is `»` when `collapsed` is truthy, else `«` (matching `applySidebarState`, `planning.js:1909-1911`). The `sidebar-toggle-row` class is required by the collapse CSS `#devdocs-list-pane > *:not(.sidebar-toggle-row)` (`planning.html:3481`).
- Wire the button's `click` to toggle `state.devdocsListCollapsed`, call `applySidebarState('devdocs', state.devdocsListCollapsed)`, and persist via the same spread-`vscode.setState({...})` pattern used by `toggleSidebarCollapsed` (`planning.js:1930-1937`) — **add `devdocsListCollapsed: state.devdocsListCollapsed`** to that persisted payload.
- Restore on init: change the state initializer at `planning.js:30` from `devdocsListCollapsed: false` to `devdocsListCollapsed: persistedState.devdocsListCollapsed || false` (it currently ignores persisted state).
- Return the node (so the existing `devdocsListPane.appendChild(buildSidebarToggleRow(...))` call at `planning.js:11389` works unchanged).

Rationale for this (alternative A2) over refactoring `renderDevDocsList` to preserve a static row (alternative A1): it is the smallest change that matches the code's existing intent and call signature, and keeps the Dev Docs tab's "wipe-and-rebuild" render model intact. A1 is cleaner but is scope creep for a bugfix (see Non-Goals / Adversarial Synthesis).

**Edge Cases:**
- **Double-toggle — resolved, not a risk.**
  > **Superseded:** "Verify whether a delegated global handler already dispatches to `toggleSidebarCollapsed`; if so, the helper's own handler and the delegated one must not double-toggle."
  > **Reason:** The global binding at `planning.js:1948-1950` is `document.querySelectorAll('.sidebar-toggle-btn').forEach(btn => btn.addEventListener('click', toggleSidebarCollapsed))` — **per-node `addEventListener` at init time, not event delegation on a parent.** It binds only nodes present in the DOM at load. The static Dev Docs toggle button (`planning.html:3870`) is destroyed by `innerHTML = ''` on the first `renderDevDocsList()`, and the button rebuilt by `buildSidebarToggleRow` post-dates the init loop, so it is **never** caught by that binding. The rebuilt button therefore carries only the handler `buildSidebarToggleRow` attaches — no double-toggle is possible.
  > **Replaced with:** `buildSidebarToggleRow` wires its own single click handler; there is no double-binding to guard against. State the conclusion; do not re-verify.
- **Collapse-state persistence:** adding `devdocsListCollapsed` to `vscode.setState` must spread the existing state so it does not clobber the other collapse keys.

**Secondary consistency fix (recommended):** `toggleSidebarCollapsed()` (`planning.js:1912`) has no `devdocs` branch — its `else` toggles `state.docsListCollapsed` and applies to docs/research. Because Fix A wires the rebuilt button's own handler, `toggleSidebarCollapsed` is not on the rebuilt button's click path, so this branch is not strictly required for correctness. Add it anyway for parity: it (a) fixes the brief pre-render window where the *static* button (still init-bound to `toggleSidebarCollapsed`) would mis-toggle docs state, and (b) future-proofs any later switch to true delegation. When added, also persist `devdocsListCollapsed` in that function's `vscode.setState` payload.

#### Fix C — Default the workspace picker to the Kanban root, with override (fixes Symptom 2)

**Context:** `populateDevDocsAndNotebookFilters()` (`planning.js:11592`) rebuilds the dropdown from `_kanbanWorkspaceItems` and hard-sets `devdocsWorkspaceFilter.value = _devDocsWsFilter || ''` (`planning.js:11604`); the tab-entry block (`planning.js:1990-1992`) sends only `loadDevDocs`, so `_kanbanWorkspaceItems` is empty/stale on a cold open.

**Logic:** Mirror the Docs tab's `resolveDocsWorkspaceFilter` semantics, seeding the default from the *live board selection*, and refresh items on tab entry the way the Notebook tab already does.

**Implementation:**
1. **Ensure workspace items are fresh on tab entry.** In the tab-switch block (`planning.js:1990-1992`, the `if (tabName === 'devdocs')` branch), also send `fetchKanbanPlans` (matching the Docs/Notebook tabs) *in addition to* `loadDevDocs`. Use `hydrateNotebookTab()` (`planning.js:11530-11537`) as the template. This populates `_kanbanWorkspaceItems` and triggers `populateDevDocsAndNotebookFilters()` via `handleKanbanPlansReady` (`planning.js:7206-7207`).
2. **Resolve the default like the Docs tab.** Replace the hard `devdocsWorkspaceFilter.value = _devDocsWsFilter || ''` (`planning.js:11604`) with a resolver mirroring `resolveDocsWorkspaceFilter` (`planning.js:91-113`):
   - If the user has an explicitly restored/persisted choice (including `''` = deliberately "All Workspaces"), honor it. Read it from `_restoredPanelState.panel['devdocs.root']` (the restore map is populated at `planning.js:4473-4474`; use the same `hasOwnProperty`/`=== ''` discrimination `resolveDocsWorkspaceFilter` uses at lines 94-100).
   - Else default to **`kanbanFilters.workspaceRoot || _kanbanDefaultRoot`** when that value is present among `_kanbanWorkspaceItems`. *(See the superseded callout in Root-cause analysis — `_kanbanDefaultRoot` alone is null on a cold open.)*
   - Else fall back to the first workspace (`_kanbanWorkspaceItems[0].workspaceRoot`), not "All Workspaces".
   - Set both `_devDocsWsFilter` and `devdocsWorkspaceFilter.value` from that result.
3. **Persist explicit overrides.** In the dropdown `change` handler (`planning.js:11448-11453`), after setting `_devDocsWsFilter = devdocsWorkspaceFilter.value`, persist the chosen root via `persistTab('devdocs.root', _devDocsWsFilter)` (`persistTab` is defined at `planning.js:116`, exposed as `window.persistTab`). Also write it into `_restoredPanelState.panel['devdocs.root']` immediately (as the Docs tab does at `planning.js:1823` for `docs.root`) so the resolver in step 2 honors it within the same session. This makes an explicit choice survive reloads and win over the Kanban default — exactly as `docs.root` does.
4. **Workspace-root normalization check (correctness).** The client-side filter compares `d.workspaceRoot === _devDocsWsFilter` (`planning.js:11392`). The dropdown option values come from `_kanbanWorkspaceItems[].workspaceRoot`, produced by `buildWorkspaceItems` (`src/services/workspaceUtils.ts`) via `path.resolve`. Confirm the dev-docs list backend emits `workspaceRoot` normalized identically (`path.resolve`); if there is any chance they differ (trailing separator, symlink, case), normalize **both** sides before comparing so selecting a specific workspace does not silently empty the list. This defect is currently masked by Symptom 3 and becomes live the moment Fix A lands.

**Edge Cases:**
- **Multi-root, "All Workspaces" chosen:** rows show their `workspaceLabel` badge (`planning.js:11417-11419`). Defaulting logic must still let the user pick "All Workspaces" explicitly (`''`) and have it stick via the persisted-override path.
- **Board on "All Workspaces" (`kanbanFilters.workspaceRoot === ''`):** there is no single board workspace to sync to → first-workspace fallback is correct.

#### Fix D — Make Import available without a prior selection (hardens Symptom 4)

**Context:** Once Fix A restores auto-select, both buttons enable when a doc is selected (`planning.js:4366-4371`). But **Import** (clipboard → *new* doc) does not logically require an existing selection — its click handler already derives the target root from the dropdown/filter with sensible fallbacks (`planning.js:11496-11504`).

**Logic:** Enable `btn-import-devdoc` whenever a workspace is resolvable (on tab load / in `populateDevDocsAndNotebookFilters()`), and stop other paths from re-disabling it.

**Implementation:**
- Enable `btnImportDevdoc.disabled = false` in `populateDevDocsAndNotebookFilters()` / on tab load, rather than gating it solely behind `devDocContent` (`planning.js:4366`).
- **Remove `btnImportDevdoc.disabled = true` from the delete and external-delete handlers** (`planning.js:4398` and `planning.js:4426`). Those handlers disable Import when the selected doc is removed, which directly contradicts "Import needs no selection." Leave the `btnAgentDevdoc` disable in those handlers intact.
- Leave **Draft/Improve with agent** (`btn-agent-devdoc`) gated on a selection: by design it operates on the selected doc ("Draft" when empty, "Improve" when it has content, `planning.js:11507-11519`), so enabling it on selection (restored by Fix A) is correct.

**Edge Cases:**
- **Import with ambiguous root** (multi-root + "All Workspaces" + no selection → `wsRoot === ''`): the handler posts `importDevDocFromClipboard` with an empty `workspaceRoot`. Confirm the backend picks a root or prompts rather than failing silently. Single-root workspaces are unaffected (only one root to resolve).

### `src/webview/planning.html` (Fix B)

#### Fix B — Style the workspace dropdown (fixes Symptom 1)

**Context:** `<select id="devdocs-workspace-filter">` at `planning.html:3852` has no class; its sibling `#devdocs-source-filter` at `planning.html:3855` is styled with `class="workspace-filter-select"`.

**Implementation:** Add `class="workspace-filter-select"` to `<select id="devdocs-workspace-filter">` (`planning.html:3852`) so it matches the source dropdown and the rest of the tab. Keep spacing consistent with the source select (`style="margin-right: 12px;"` on `:3855`).

**Edge Cases:** Pure CSS-class change; no behavioral risk.

## Verification Plan

Testing is via an installed VSIX (per project rules); `src/` is source of truth and `dist/` is not exercised in dev/testing. After building/installing:

1. Open the planning panel → **Dev Docs** tab. **Docs** mode lists the repo `docs/*.md` files; the first is auto-selected and its preview renders.
2. Switch source to **README** → the root `README.md` appears (badge shown) and renders.
3. With the webview dev-tools console open, confirm **no** `ReferenceError` / `[PlanningPanel] Message handler error` on tab entry.
4. Workspace dropdown is themed (not native white) and, on a **cold open** (fresh window, Dev Docs opened *without* first visiting the Docs/Local tab), defaults to the workspace **shown on the Kanban board** (`kanbanFilters.workspaceRoot`) — this is the specific cold-open case that exposes the `_kanbanDefaultRoot`-is-null bug. Changing the dropdown filters the list; the choice survives a panel reload; "All Workspaces" can be chosen and sticks.
5. **Multi-root path check:** with more than one workspace open, selecting a specific workspace actually shows that workspace's docs (not an empty list) — confirms the `path.resolve` normalization (Fix C step 4).
6. **Import** is clickable with **no doc selected** (paste markdown → new doc imported and list refreshes), and **remains** clickable after deleting the selected doc (confirms the delete-handler fix in Fix D). **Draft/Improve with agent** enables once a doc is selected and copies the correct prompt.
7. Sidebar collapse toggle (`«`/`»`) works in the Dev Docs tab and its state persists across reloads.

### Automated Tests

Per session directives (SKIP TESTS, SKIP COMPILATION) and project convention, verification is **manual via an installed VSIX** — there is no automated test harness exercising `planning.js` webview DOM / message-passing in this repo, so no unit/integration test is added for these fixes. The manual steps above are the acceptance criteria. If the webview ever gains a jsdom-based harness, the highest-value regression tests would be: (a) `renderDevDocsList()` does not throw and appends a `.sidebar-toggle-row` + doc rows; (b) the picker resolver returns `kanbanFilters.workspaceRoot` on a cold open and honors a persisted `devdocs.root` override.

---

**Recommendation:** Complexity 5 → **Send to Coder.**

---

## Review Findings

Reviewed all four fixes in `src/webview/planning.js` and `src/webview/planning.html`; every plan requirement is satisfied. Fix A: `buildSidebarToggleRow` (planning.js:11344) is defined and wired with its own single click handler + spread-`vscode.setState` persistence; state initializer at line 30 restores it; `toggleSidebarCollapsed` gained the `devdocs` branch. Fix B: `class="workspace-filter-select"` added at planning.html:3851 (margin preserved). Fix C: tab entry sends `fetchKanbanPlans`+`loadDevDocs` (1994-1997), `resolveDevDocsWorkspaceFilter` (11569) defaults to `kanbanFilters.workspaceRoot || _kanbanDefaultRoot` and honors persisted `devdocs.root`; path comparison uses `normalizeFsPath` on both sides and the backend `_listDevDocs`/dropdown both source `workspaceRoot` from `buildWorkspaceItems`→`path.resolve`, so the normalization risk is closed. Fix D: Import enabled in `populateDevDocsAndNotebookFilters` (11616) and the two `btnImportDevdoc.disabled = true` lines removed from the delete/external-delete handlers (only `= false` remains). `node --check src/webview/planning.js` passed; per session directives no compile/tests were run. Remaining low risk: a brief cold-open flash where the list shows all-workspace docs before the kanban-root filter resolves (eventual-consistency, accepted in the plan).

---

**Completion Report:** Implemented all four fixes. Added `buildSidebarToggleRow` in `src/webview/planning.js` so `renderDevDocsList` no longer throws, restored the file list, and wired the Dev Docs sidebar toggle with persisted collapse state. Added `class="workspace-filter-select"` to the workspace `<select>` in `src/webview/planning.html`. Synced the Dev Docs workspace picker by sending `fetchKanbanPlans` on tab entry, resolving defaults from `kanbanFilters.workspaceRoot` with a `normalizeFsPath` comparison, and persisting explicit overrides via `devdocs.root`. Enabled the `Import` button in `populateDevDocsAndNotebookFilters` and removed the `disabled = true` lines from the delete handlers so the button stays available. `node --check` passed on `planning.js` and the diff is limited to the expected two files. No compile or test steps were run per the session directives.
