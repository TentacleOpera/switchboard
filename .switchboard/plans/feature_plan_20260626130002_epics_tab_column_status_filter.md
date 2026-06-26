# Make the Epics Tab Behave Like the Kanban Plans Tab (Column Status + Filter; Always-On-Board)

## Goal

Bring the Project panel's **Epics tab** (`project.html`) to parity with the **Kanban plans tab**: show each epic's workflow column/status, add a column filter dropdown, and — because epics are now just "mega plans" that always live on the board — remove the "Add to Kanban board" option from the New Epic flow so every newly created epic is automatically placed on the board.

### Problem analysis & root cause

Epics have been redefined as mega plans. All non-plan epic features were explicitly moved to the **Projects tab**, so the Epics tab no longer needs to support "epic documents that are not on the board". Today, however, the Epics tab:

1. **Has no column/status display.** `renderEpicsList()` (`src/webview/project.js:1459`) renders each card with only `topic`, `workspaceLabel · time`, a subtasks `<details>`, and action buttons (`:1510-1518`). There is no column badge — unlike kanban cards, which render a `.kanban-column-badge` plus an inline move dropdown (`project.js:1141-1149`). So the user can't see whether an epic is in Created / Coded / Reviewed / Done.

2. **Has no column filter.** The Epics controls strip (`project.html:1469-1476`) contains only a workspace filter, "+ New Epic", and a help button. The Kanban tab has a `#kanban-column-filter` dropdown (`project.html:1410-1412`) populated from `_kanbanAvailableColumns` (`populateKanbanFilters`, `project.js:897-911`) and applied in `renderKanbanPlans` (`project.js:1086`).

3. **Still offers "Add to Kanban board".** The New Epic modal has a checkbox `#new-epic-add-to-kanban` (`project.html:1624-1627`), read on submit as `addToKanbanBoard` (`project.js:2253`). The provider's `createEpic` handler branches on it: when `false` it writes a standalone doc with **no DB record** (`PlanningPanelProvider.ts:2981-2994`); when `true` it creates a DB plan record with `isEpic: 1`, `kanbanColumn: 'CREATED'` and writes the file (`:2996-3056`). Since every epic must now go on the board, this branch and its checkbox are obsolete.

The good news: the data needed already flows to the Epics tab. DB-backed epics in `_kanbanPlansCache.filter(p => p.isEpic)` already carry a `column` field (set in `_buildKanbanPlanSummaries`, `PlanningPanelProvider.ts:7856` as `column: r.kanbanColumn`), and `_kanbanAvailableColumns` is already populated from the `kanbanPlansReady` payload that the Epics tab already requests. So we can render the column badge and a column filter by **reusing the exact patterns already present in the same file** for the Kanban tab — and reuse the existing `moveKanbanPlanColumn` message for inline column changes.

## Metadata

- **Tags:** feature, frontend, ui, ux, backend
- **Complexity:** 6 / 10
- **Primary files:** `src/webview/project.html`, `src/webview/project.js`, `src/services/PlanningPanelProvider.ts`
- **Affected feature area:** Project panel → Epics tab

## User Review Required

Yes — before implementation, confirm:

- The decision to **force all new epics on-board** (removing the standalone-doc creation path) is final. Pre-existing standalone epic docs (`.switchboard/epics/*.md` with no DB record) will still *display* but can no longer be *created*. If any workflow still relies on creating off-board epic documents, flag it now.
- The neutral "Doc" badge label for legacy standalone epic documents is acceptable (vs. hiding them entirely or showing "No column").
- Independent epics-tab column filter state (not shared with the Kanban tab's column filter) is the desired behavior — switching tabs does not carry the column selection over.

## Complexity Audit

### Routine
- Adding a `<select id="epics-column-filter">` to the Epics controls strip — direct mirror of the kanban filter markup (`project.html:1410-1412`).
- Adding `column: ''` to the `epicsFilters` state object (`project.js:290`) and a change listener (`project.js:1833-1838` pattern).
- Populating the epics column dropdown inside `populateKanbanFilters()` (`project.js:897-911`) using the same `_kanbanAvailableColumns` loop already used for kanban.
- Applying `epicsFilters.column` in `renderEpicsList()` alongside the existing workspace filter (`project.js:1467-1469`).
- Removing the `#new-epic-add-to-kanban` checkbox from the modal (`project.html:1624-1627`) and its ref/reset/usage in `project.js` (lines 222, 2227, 2253).
- Hard-setting `addToKanbanBoard: true` on submit and defaulting the provider field to `true` when absent.

### Complex / Risky
- **Badge + inline move dropdown wiring for epics.** The kanban badge wiring is inline within `renderKanbanPlans`'s forEach (`project.js:1187-1209`). Replicating it in `renderEpicsList()` requires care to avoid event-handler duplication and to handle the standalone-doc (no `planFile`/`column`) degradation path. Factoring a shared helper is cleaner but touches working kanban code — the lower-risk option is an inline mirror scoped to the epics list.
- **Backward-compat for pre-existing standalone epic docs.** The `fetchEpicDocuments` read path and `_epicDocumentsCache` merge must remain intact so legacy docs still render; only the *creation* branch is removed. The provider must default `addToKanbanBoard` to `true` when the field is absent so older/omitted payloads still create on-board (defensive, since webview+provider ship together).
- **Column-filter exclusion of standalone docs.** When a specific column is selected, standalone docs (no `column`) must be excluded from results without being dropped from the unfiltered list (migration rule — they shipped).

## Edge-Case & Dependency Audit

- **Race Conditions:** `_kanbanAvailableColumns` is set from `msg.columns` at `project.js:320` before `renderEpicsList()` is called at `:332`, so the badge/filter always have column definitions available on render. No race. The epics column filter is populated inside `populateKanbanFilters()` (called at `:330`), also before `renderEpicsList()`.
- **Security:** No new user input surfaces. The column badge markup uses `escapeHtml()` (`project.js:2390`) for all interpolated values (`plan.column`, `columnDef.label`, `plan.planFile`, `plan.workspaceRoot`), matching the kanban tab. No injection risk.
- **Side Effects:** Removing the standalone-creation branch means `fetchEpicDocuments` is no longer triggered by `createEpic` (only the DB path's `fetchKanbanPlans` runs). Legacy docs already on disk remain visible via the existing `fetchEpicDocuments` call on tab activation. No files are deleted.
- **Dependencies & Conflicts:** The `moveKanbanPlanColumn` provider handler (`PlanningPanelProvider.ts:2653-2670`) is generic — it operates on `planFile` + `newColumn` + `wsRoot` via `switchboard.moveKanbanCardByPlanFile` with no epic special-casing, so DB-backed epics move unchanged. The existing "Send to Planner" epic button (`project.js:1575-1580`) already sends `moveKanbanPlanColumn` for epics, confirming the path works. No confirmation dialogs anywhere in this change (project rule).

## Dependencies

- None. This plan is self-contained and reuses only patterns/messages already present in the same files.

## Adversarial Synthesis

Key risks: (1) badge/dropdown event wiring duplicated across two render functions could drift or double-bind if a shared helper isn't extracted; (2) standalone epic docs silently vanish when a column filter is active, which may confuse users who expect them always visible; (3) removing the standalone-creation branch is a one-way product decision that can't be undone without re-adding the checkbox. Mitigations: mirror the kanban wiring inline (lowest risk to working code) with a comment pointing to the canonical block; show a "Doc" badge and keep standalone docs visible under "All Columns"; preserve the `fetchEpicDocuments` read path so legacy docs are never lost.

## Proposed Changes

### 1. `src/webview/project.html` — add a column filter to the Epics controls strip

Mirror the kanban column filter (`:1410-1412`). Insert into the epics controls strip (`:1469-1476`):

```html
<div class="controls-strip">
    <select id="epics-workspace-filter">
        <option value="">All Workspaces</option>
    </select>
    <select id="epics-column-filter">
        <option value="">All Columns</option>
    </select>
    <button id="btn-new-epic" class="strip-btn">+ New Epic</button>
    <button id="btn-epic-modes-help" class="strip-btn" title="How to run an epic (3 ways)" style="font-weight: bold; min-width: 28px; padding: 2px 8px;">?</button>
</div>
```

### 2. `src/webview/project.html` — remove the "Add to Kanban board" checkbox

Delete the checkbox block in the New Epic modal (`:1624-1627`):

```html
<!-- REMOVE: epics are always on the board now -->
<div style="display: flex; align-items: center; gap: 6px;">
    <input type="checkbox" id="new-epic-add-to-kanban" style="margin: 0;" />
    <label for="new-epic-add-to-kanban" ...>Add to Kanban board</label>
</div>
```

### 3. `src/webview/project.js` — filter state, element ref, population, listener

- Add the element ref near the other epics refs (after `:222` `newEpicAddToKanban` ref, which will be removed in step 6 — place the new ref among the epics element refs around `:225-231`):
  ```js
  const epicsColumnFilter = document.getElementById('epics-column-filter');
  ```
- Add `column` to the `epicsFilters` state object (`:290`):
  ```js
  const epicsFilters = { workspaceRoot: '', column: '' };
  ```
- Populate the dropdown inside `populateKanbanFilters()` (`:897-911`), appending after the kanban block so both filters populate from the same `_kanbanAvailableColumns` on every `kanbanPlansReady` (called at `:330`):
  ```js
  if (epicsColumnFilter) {
      const currentCol = epicsFilters.column;
      epicsColumnFilter.innerHTML = '<option value="">All Columns</option>';
      _kanbanAvailableColumns.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.id; opt.textContent = c.label;
          if (c.id === currentCol) opt.selected = true;
          epicsColumnFilter.appendChild(opt);
      });
  }
  ```
- Wire the change listener near the existing epics-workspace-filter listener (`:1833-1838`):
  ```js
  if (epicsColumnFilter) {
      epicsColumnFilter.addEventListener('change', () => {
          epicsFilters.column = epicsColumnFilter.value;
          renderEpicsList();
      });
  }
  ```

### 4. `src/webview/project.js` — apply the column filter + render a column badge in `renderEpicsList()`

Apply the filter alongside the existing workspace filter (`:1467-1469`), excluding standalone docs (no `column`) only when a specific column is chosen:

```js
if (epicsFilters.workspaceRoot) {
    filtered = filtered.filter(plan => plan.workspaceRoot === epicsFilters.workspaceRoot);
}
if (epicsFilters.column) {
    filtered = filtered.filter(plan => plan.column === epicsFilters.column);
}
```

Add a column badge to each card's markup (`:1510-1518`), reusing the existing `.kanban-column-badge` CSS and `_kanbanAvailableColumns`. For DB-backed epics, render the clickable badge + inline move dropdown exactly as kanban cards do (`:1141-1149`); for standalone docs (no `column`/`planFile`), render a static non-clickable label:

```js
const columnDef = plan.column ? _kanbanAvailableColumns.find(c => c.id === plan.column) : null;
const columnBadge = plan.column
    ? `<span class="kanban-column-badge clickable" data-column="${escapeHtml(plan.column)}">${escapeHtml(columnDef ? columnDef.label : plan.column)}</span>
       <select class="kanban-column-dropdown" style="display:none;" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">
           ${_kanbanAvailableColumns.map(col => `<option value="${escapeHtml(col.id)}" ${col.id === plan.column ? 'selected' : ''}>${escapeHtml(col.label)}</option>`).join('')}
       </select>`
    : `<span class="kanban-column-badge" style="opacity:0.6;">Doc</span>`;
```

Insert `columnBadge` into the card — placing it in the existing `.kanban-plan-actions`/`epic-card-action` row (`:1501-1507`) keeps it visually consistent. Wire the badge click → reveal dropdown → `moveKanbanPlanColumn` exactly as the kanban tab does (`project.js:1187-1209`); since the Epics list and Kanban list share `.kanban-column-badge`/`.kanban-column-dropdown` class names, the simplest path is to factor the existing kanban badge-wiring into a small shared helper and call it for both lists, or delegate via a shared event handler scoped to the visible tab.

**Clarification (implied by existing requirements, not new scope):** The inline mirror is the lower-risk option — add a parallel badge-wiring block inside `renderEpicsList()`'s forEach (after the existing action-button wiring, `:1528-1596`) that mirrors `:1187-1209` exactly, guarded by `if (plan.column && plan.planFile)`. This avoids touching the working kanban render path. A shared helper refactor is optional and should only be done if the duplication is deemed unacceptable.

**MANDATORY refinement (from adversarial review):** The kanban badge-click handler at `:1192` uses `document.querySelectorAll('.kanban-column-dropdown').forEach(...)` to close other open dropdowns — a **global** selector. Because the Epics list reuses the same `.kanban-column-dropdown` class, an unscoped copy would close kanban dropdowns when an epic badge is clicked (and vice versa). The epics badge-wiring block **must** scope the close-others query to the epics list pane only:
```js
epicsListPane.querySelectorAll('.kanban-column-dropdown').forEach(s => s.style.display = 'none');
```
Do not copy the `document.querySelectorAll` verbatim. (Applying the same scoping fix to the kanban block is optional but recommended for symmetry.)

### 5. `src/webview/project.js` — reset epics column filter on external epic activation

**MANDATORY refinement (from adversarial review):** The `activateKanbanTabAndSelectPlan` epic path (`:396-408`) clears `epicsFilters.workspaceRoot = ''` and `epicsWorkspaceFilter.value = ''` at `:403-404` so a pending selection isn't hidden by the workspace filter. It must **also** clear the new column filter, or a pending epic in a different column will be filtered out and `tryResolvePendingEpicSelection()` will fail silently:

```js
epicsFilters.workspaceRoot = '';
epicsFilters.column = '';              // ADD
if (epicsWorkspaceFilter) epicsWorkspaceFilter.value = '';
if (epicsColumnFilter) epicsColumnFilter.value = '';   // ADD
```

### 6. `src/webview/project.js` — force every new epic on-board

Remove the checkbox ref (`:222`) and reset (`:2227`), and hard-set `addToKanbanBoard: true` on submit (`:2247-2254`):

```js
// remove: const newEpicAddToKanban = document.getElementById('new-epic-add-to-kanban');
// remove: the `if (newEpicAddToKanban) newEpicAddToKanban.checked = false;` reset on modal open
vscode.postMessage({
    type: 'createEpic',
    name,
    description,
    workspaceRoot: epicsFilters.workspaceRoot,
    subtaskPlanIds: [],
    addToKanbanBoard: true   // epics are always on the board
});
```

### 7. `src/services/PlanningPanelProvider.ts` — default to on-board; keep standalone read path

In `createEpic` (`:2975`), default the field to `true` so an omitted/older payload still creates on-board, and remove the standalone-creation branch:

```ts
const addToKanbanBoard = msg.addToKanbanBoard !== false; // default ON — epics always go on the board
```

Then delete the `if (!addToKanbanBoard) { …standalone doc… break; }` block (`:2981-2994`) so creation always takes the DB-backed path (`:2996-3056`). **Keep** the `fetchEpicDocuments` handler and `_epicDocumentsCache` merge intact so any pre-existing standalone epic docs still display (migration rule — they shipped).

## Verification Plan

### Automated Tests

Automated tests are skipped for this session per directive (the test suite will be run separately by the user). No compilation step is run either.

### Manual Verification

1. **Column filter present & functional:** open the Epics tab — a "All Columns" dropdown appears next to the workspace filter, populated with the same columns as the Kanban tab. Selecting a column filters the epic list to epics in that column.
2. **Column badge on cards:** each DB-backed epic card shows its current column (Created/Coded/Reviewed/Done). Clicking the badge reveals the inline dropdown; choosing a new column moves the epic (verify via the Kanban tab / DB that `kanbanColumn` changed).
3. **Standalone docs degrade gracefully:** a pre-existing `.switchboard/epics/<slug>.md` standalone doc still appears with a neutral "Doc" badge and is not broken by the column filter (visible under "All Columns", hidden when a specific column is selected).
4. **New Epic always on board:** the New Epic modal no longer shows "Add to Kanban board". Creating an epic produces a DB record (`isEpic: 1`, `kanbanColumn: 'CREATED'`) and the epic appears on the Kanban board immediately.
5. **Backward-compat:** older standalone epic docs remain visible after the change; no epic files are deleted.
6. **No regressions to the Kanban tab:** its own column filter and badge behaviour are unchanged.
7. **Cross-tab dropdown scoping (adversarial fix):** with both tabs rendered, click an epic column badge — only epic dropdowns close; kanban dropdowns are unaffected. Click a kanban badge — epic dropdowns are unaffected.
8. **External epic activation clears column filter (adversarial fix):** set the epics column filter to "Reviewed", then trigger an external epic activation (e.g. via a board link to an epic in "Created") — the column filter resets and the target epic is selected and visible.

---

**Recommendation:** Complexity is 6/10 (multi-file, mirrors an existing pattern, one moderate risk in badge-wiring duplication). **Send to Coder.**

## Code Review Results (Reviewer Pass — 2026-06-26)

### Implementation Status: COMPLETE

All 7 plan steps were implemented correctly in commit `6c72aa4`. The implementation faithfully follows the plan including both MANDATORY adversarial refinements.

### Files Changed (by implementation)
- `src/webview/project.html` — column filter `<select>` added to epics controls strip; "Add to Kanban board" checkbox removed from New Epic modal.
- `src/webview/project.js` — `epicsColumnFilter` ref, `epicsFilters.column` state, `populateKanbanFilters()` population, change listener, column filter application in `renderEpicsList()`, column badge rendering (DB-backed + standalone "Doc" degradation), badge/dropdown wiring scoped to `epicsListPane`, column filter reset in `activateKanbanTabAndSelectPlan`, checkbox ref/reset removed, `addToKanbanBoard: true` hardcoded on submit.
- `src/services/PlanningPanelProvider.ts` — `addToKanbanBoard` defaults to `true` (`!== false`), standalone-creation branch removed, `fetchEpicDocuments` read path preserved.

### Files Changed (by review)
- `src/webview/project.js:1206` — Kanban badge click handler scoped from `document.querySelectorAll('.kanban-column-dropdown')` to `kanbanListPane.querySelectorAll(...)` for symmetry with the epics-side fix. Prevents cross-tab dropdown interference.

### Findings by Severity

| Severity | Finding | File:Line | Status |
|----------|---------|-----------|--------|
| NIT | Kanban badge handler used global `document.querySelectorAll` instead of pane-scoped selector (plan recommended fix for symmetry) | `src/webview/project.js:1206` | **Fixed** — scoped to `kanbanListPane` |
| NIT | Dead variable `addToKanbanBoard` computed but never read after standalone branch removal | `src/services/PlanningPanelProvider.ts:2976` | **Deferred** — harmless, documents intent |

No CRITICAL or MAJOR findings.

### Verification Results
- **Compilation:** Skipped per directive.
- **Tests:** Skipped per directive (user will run separately).
- **Manual verification items 1–8:** Not executable in this session (require running VS Code webview). All code paths verified by inspection against plan requirements.
- **Cross-tab dropdown scoping (item 7):** Both badge handlers now use pane-scoped `querySelectorAll` — `kanbanListPane` (line 1206) and `epicsListPane` (line 1564). No global `document.querySelectorAll('.kanban-column-dropdown')` selectors remain.

### Remaining Risks
1. **Dead variable** (`PlanningPanelProvider.ts:2976`): `addToKanbanBoard` is computed but unused. Harmless but untidy. Can be removed in a future cleanup pass.
2. **Manual UAT not run:** All 8 manual verification items require a live VS Code webview session. The user should execute them before releasing.
3. **Standalone epic doc creation permanently removed:** This is a one-way product decision. If any workflow relied on creating off-board epic documents, it can no longer do so. Pre-existing standalone docs remain visible via the preserved `fetchEpicDocuments` read path.
