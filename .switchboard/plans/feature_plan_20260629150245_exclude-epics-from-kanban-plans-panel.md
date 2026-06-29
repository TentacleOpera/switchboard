# Epic Files Showing in project.html Kanban Plans Panel

## Goal

Epic files should not appear in the project.html **Kanban plans panel** — they belong in the **Epics tab**. Currently, epic files show up in both places because the kanban plans filter (`getFilteredKanbanPlans`) does not exclude epics, while the epics tab (`renderEpicsList`) correctly filters *for* epics only. The kanban plans panel should show only regular plans (non-epics).

### Core problem & background

The project.html webview has two tabs that display plans from the same `_kanbanPlansCache`:

1. **Kanban tab** — should show regular plans only. Its filter function `getFilteredKanbanPlans()` (`project.js:1173-1200`) applies column, workspace, project, search, and complexity filters, but **does not exclude epics**. As a result, epic files (which have `isEpic: true` in the cache) pass all filters and appear in the kanban list alongside regular plans.

2. **Epics tab** — should show epics only. Its `renderEpicsList()` function (`project.js:1592-1605`) correctly filters: `_kanbanPlansCache.filter(plan => plan.isEpic)` (line 1597). This is the correct pattern.

The backend (`PlanningPanelProvider._getKanbanPlans`, `PlanningPanelProvider.ts:8546-8598`) returns ALL plans from the kanban database — both regular plans and epics — and includes the `isEpic` flag in each record. The backend intentionally sends everything and expects the frontend to filter. The epics tab does this correctly; the kanban tab does not.

### Root cause

A missing `isEpic` exclusion filter in `getFilteredKanbanPlans()` (`project.js:1173-1200`). The function filters by column, workspace, project, search, and complexity, but never checks `plan.isEpic`. The fix is a one-line addition: `if (plan.isEpic) return false;` at the top of the filter callback, before the other filter checks.

This is the same pattern used in `planning.js` (the other webview), where the kanban view filters by `plan.isEpic` when in epics mode (`planning.js:5781-5782`) and excludes epics from the subtask-add dropdown (`planning.js:5825`: `_kanbanPlansCache.filter(p => !p.isEpic ...)`).

## Metadata

- **Tags:** [frontend, bug, kanban, epics, filtering]
- **Complexity:** 1

## Complexity Audit

### Routine
- Adding a single filter line (`if (plan.isEpic) return false;`) to `getFilteredKanbanPlans()` in `project.js`.

### Complex / Risky
- None. This is a one-line fix with no side effects. The `isEpic` flag is already present in the cache data, and the epics tab already uses it for its own filtering.

## Edge-Case & Dependency Audit

- **Standalone epic documents (not in DB):** The epics tab merges DB epics (`_kanbanPlansCache.filter(plan => plan.isEpic)`) with standalone epic documents from `_epicDocumentsCache` (`project.js:1596-1598`). Standalone epic documents are NOT in `_kanbanPlansCache`, so they would never appear in the kanban panel regardless. The fix only affects DB-backed epics that are already in the cache. No change needed for standalone documents.
- **Epic with subtasks:** An epic card in the kanban panel might have subtask counts displayed. After the fix, epics won't appear in the kanban panel at all, so their subtask counts are only visible in the epics tab — which is the correct behavior.
- **Epics tab still works:** The fix does not touch `renderEpicsList()` or the epics tab in any way. Epics continue to appear in the epics tab as before.
- **planning.js parity:** The `planning.js` kanban view has a `_kanbanViewMode` toggle that switches between 'epics' and regular plans. In 'epics' mode it filters `plan.isEpic` to show only epics (`planning.js:5782`). In the default (non-epics) mode, it does NOT explicitly filter out epics — so `planning.js` may have the same bug. However, the user's issue is specifically about `project.html`, and `planning.js` may handle the separation differently via its view-mode toggle. This plan addresses only `project.js`; a separate plan can address `planning.js` if needed.
- **No confirmation dialogs** (house rule, `CLAUDE.md`): No confirm gates involved.
- **Dependencies:** None. No other plan blocks or is blocked by this.

## Proposed Changes

### 1. `src/webview/project.js` — exclude epics from kanban plans filter

In `getFilteredKanbanPlans()` (line 1173), add an epic exclusion check at the top of the filter callback.

**Current code** (`project.js:1173-1174`):
```javascript
function getFilteredKanbanPlans() {
    return _kanbanPlansCache.filter(plan => {
        if (kanbanFilters.column && plan.column !== kanbanFilters.column) return false;
```

**Replace with:**
```javascript
function getFilteredKanbanPlans() {
    return _kanbanPlansCache.filter(plan => {
        if (plan.isEpic) return false;
        if (kanbanFilters.column && plan.column !== kanbanFilters.column) return false;
```

This single line ensures that any plan with `isEpic: true` is excluded from the kanban plans list. The epics tab (`renderEpicsList`) already filters for `plan.isEpic` separately, so epics remain visible there.

## Verification Plan

1. Open the project panel in VS Code (Switchboard extension).
2. Ensure the workspace has at least one epic file (in `.switchboard/epics/`) and one regular plan file (in `.switchboard/plans/`).
3. Navigate to the Kanban tab.
4. **Verify:** Only regular plans appear in the kanban list — no epic files.
5. Apply each filter (column, workspace, project, search, complexity) one at a time.
6. **Verify:** Epics never appear regardless of filter combination.
7. Navigate to the Epics tab.
8. **Verify:** Epic files still appear in the epics list (the fix did not break the epics tab).
9. Create a new epic and a new plan.
10. **Verify:** The epic appears only in the Epics tab; the plan appears only in the Kanban tab.
