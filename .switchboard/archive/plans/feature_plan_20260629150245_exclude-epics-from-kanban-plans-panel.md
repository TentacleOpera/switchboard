# Epic Files Showing in project.html Kanban Plans Panel

## Goal

Epic files should not appear in the project.html **Kanban plans panel** — they belong in the **Epics tab**. Currently, epic files show up in both places because the kanban plans filter (`getFilteredKanbanPlans`) does not exclude epics, while the epics tab (`renderEpicsList`) correctly filters *for* epics only. The kanban plans panel should show only regular plans (non-epics).

### Core problem & background

The project.html webview has two tabs that display plans from the same `_kanbanPlansCache`:

1. **Kanban tab** — should show regular plans only. Its filter function `getFilteredKanbanPlans()` (`project.js:1173-1200`) applies column, workspace, project, search, and complexity filters, but **does not exclude epics**. As a result, epic files (which have `isEpic: true` in the cache) pass all filters and appear in the kanban list alongside regular plans.

2. **Epics tab** — should show epics only. Its `renderEpicsList()` function (`project.js:1592-1605`) correctly filters: `_kanbanPlansCache.filter(plan => plan.isEpic)` (line 1597). This is the correct pattern.

The backend (`PlanningPanelProvider._getKanbanPlans`, `src/services/PlanningPanelProvider.ts:8596-8648`) returns ALL plans from the kanban database — both regular plans and epics — and includes the `isEpic` flag in each record (line 8642: `isEpic: r.isEpic`). The backend intentionally sends everything and expects the frontend to filter. The epics tab does this correctly; the kanban tab does not.

### Root cause

A missing `isEpic` exclusion filter in `getFilteredKanbanPlans()` (`project.js:1173-1200`). The function filters by column, workspace, project, search, and complexity, but never checks `plan.isEpic`. The fix is a one-line addition: `if (plan.isEpic) return false;` at the top of the filter callback, before the other filter checks.

This is the same pattern used in `planning.js` (the other webview), where the kanban view filters by `plan.isEpic` when in epics mode (`planning.js:5784-5785`) and excludes epics from the subtask-add dropdown (`planning.js:5828`: `_kanbanPlansCache.filter(p => !p.isEpic ...)`).

## Metadata

- **Tags:** [frontend, bugfix]
- **Complexity:** 1

## User Review Required

No — this is a one-line filter fix with no side effects. The `isEpic` flag is already present in the cache data and already used by the epics tab.

## Complexity Audit

### Routine
- Adding a single filter line (`if (plan.isEpic) return false;`) to `getFilteredKanbanPlans()` in `project.js`.

### Complex / Risky
- None. This is a one-line fix with no side effects. The `isEpic` flag is already present in the cache data, and the epics tab already uses it for its own filtering.

## Edge-Case & Dependency Audit

- **Standalone epic documents (not in DB):** The epics tab merges DB epics (`_kanbanPlansCache.filter(plan => plan.isEpic)`) with standalone epic documents from `_epicDocumentsCache` (`project.js:1596-1598`). Standalone epic documents are NOT in `_kanbanPlansCache`, so they would never appear in the kanban panel regardless. The fix only affects DB-backed epics that are already in the cache. No change needed for standalone documents.
- **Epic with subtasks:** An epic card in the kanban panel might have subtask counts displayed. After the fix, epics won't appear in the kanban panel at all, so their subtask counts are only visible in the epics tab — which is the correct behavior.
- **Epics tab still works:** The fix does not touch `renderEpicsList()` or the epics tab in any way. Epics continue to appear in the epics tab as before.
- **planning.js parity:** The `planning.js` kanban view has a `_kanbanViewMode` toggle (`planning.js:5485`) that switches between 'all' and 'epics'. In 'epics' mode it filters `plan.isEpic` to show only epics (`planning.js:5784-5785`). In the default 'all' mode, it does NOT explicitly filter out epics — so `planning.js` may have the same bug. However, the user's issue is specifically about `project.html`, and `planning.js` may handle the separation differently via its view-mode toggle. This plan addresses only `project.js`; a separate plan can address `planning.js` if needed.
- **No confirmation dialogs** (house rule, `CLAUDE.md`): No confirm gates involved.
- **Dependencies:** None. No other plan blocks or is blocked by this.

## Dependencies

None.

## Adversarial Synthesis

Key risks: none of substance. The one-line filter is provably correct — `isEpic` is set by the backend (`PlanningPanelProvider.ts:8642`), already used by the epics tab (`project.js:1597`), and the filter runs before all other checks so it short-circuits cleanly. The only residual concern is `planning.js` parity (same bug may exist in the other webview's 'all' mode), but that is out of scope for this plan.

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

### Automated Tests

Automated tests are skipped per session directive. The test suite will be run separately by the user.

### Manual Verification

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

---

## Code Review Results (Reviewer Pass — 2026-06-29)

### Stage 1: Grumpy Adversarial Findings

- **NIT** (`project.js:1197`): The one-line fix was committed in `2daedaa` (the *previous* plan's auto-commit), not in this plan's auto-commit `12062e5`. This plan's auto-commit (`12062e5`) contains ~113 lines of unrelated subtask-preview machinery (`renderEpicSubtaskMetaBar`, `_epicSubtaskPreview`, etc.) that is outside this plan's scope. Commit hygiene issue — not a code defect.
- **NIT** (commit `12062e5`): Unrelated subtask-preview changes in `project.js` (lines 165, 870-884, 1797-1800, 1882-1976, 1999-2003) are out of scope for this plan. Flagged for awareness — not reviewed here per isolation directive.

No CRITICAL or MAJOR findings.

### Stage 2: Balanced Synthesis

| Finding | Severity | Verdict |
|---|---|---|
| `if (plan.isEpic) return false;` at top of filter | — | **Keep.** Correct, matches plan spec exactly. |
| Fix landed in prior commit, not this plan's auto-commit | NIT | **Defer.** Commit hygiene, not a code defect. |
| Unrelated subtask-preview code in auto-commit | NIT | **Defer.** Out of scope. Flagged. |

**Code fixes applied:** None needed. Implementation matches plan precisely.

### Files Changed (Verified)

- `src/webview/project.js:1197` — `if (plan.isEpic) return false;` added at top of `getFilteredKanbanPlans()` filter callback.

### Validation Results

- ✅ Fix present at `project.js:1197` — `if (plan.isEpic) return false;`
- ✅ Placed before all other filter checks (short-circuits cleanly)
- ✅ Epics tab (`renderEpicsList`, `project.js:1620`) still filters `plan => plan.isEpic` — unaffected
- ✅ Backend (`PlanningPanelProvider.ts:8646`) ships `isEpic: r.isEpic`
- ✅ `tryResolvePendingEpicSelection` (`project.js:1386`) accesses cache directly — unaffected
- ✅ No confirm dialogs (house rule satisfied)
- ⏭️ Compilation skipped per session directive
- ⏭️ Tests skipped per session directive

### Remaining Risks

- **Commit hygiene:** The plan's one-line fix is in commit `2daedaa`; this plan's auto-commit `12062e5` contains unrelated work. No code impact, but worth noting for history clarity.

### Corrected: `planning.js` is NOT affected

The original plan's edge-case audit speculated that `planning.js` might have the same bug. **This is incorrect.** `planning.js` uses a fundamentally different UI paradigm:

- `planning.js` has a **two-mode toggle** (`_kanbanViewMode`: `'all'` vs `'epics'`, `planning.js:5750-5752`). In `'all'` mode, all plans (including epics) appear — this is **by design**, not a bug. In `'epics'` mode, only epics appear (`planning.js:5794-5796`).
- `project.html` has **separate tabs** (Kanban tab + Epics tab) that are meant to be mutually exclusive. Epics appearing in the Kanban tab was the bug this plan fixed.

There is no `planning.js` parity issue. No separate plan is needed.
