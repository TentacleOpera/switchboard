# Fix: Epic Subtask Count Label Always Shows "0 subtasks" in project.html Epics Tab

## Goal

In the **Epics tab** of `project.html`, every epic card displays a `Subtasks (0)` label in its collapsible `<details>` accordion, even when the epic genuinely has subtasks linked to it in the database. The count is always zero regardless of actual subtask membership.

### Problem Analysis & Root Cause

The epics list is rendered by `renderEpicsList()` in `src/webview/project.js` (line ~1217):

```js
<summary style="cursor: pointer; color: var(--text-secondary);">Subtasks (${plan.subtaskCount || 0})</summary>
```

This reads `plan.subtaskCount` from each plan object in `_kanbanPlansCache`. The cache is populated by `kanbanPlansReady` messages, whose payload comes from `PlanningPanelProvider._getKanbanPlans()` in `src/services/PlanningPanelProvider.ts` (lines 7576–7592).

**Root cause:** `_getKanbanPlans()` maps DB records into `KanbanPlanSummary` objects but **never computes or includes a `subtaskCount` field**. The `KanbanPlanSummary` interface (lines 44–60) also lacks a `subtaskCount` property. As a result, every plan object arriving in the webview has `subtaskCount === undefined`, and `undefined || 0` evaluates to `0`.

This contrasts with `KanbanProvider.ts` (the Kanban board webview), which **correctly** computes `subtaskCount` using a `subtaskCountMap` built from each row's `epicId` (lines 1186–1208, 2056–2097). The Epics tab in `project.html` simply never received the same treatment.

Standalone epic documents (from `.switchboard/epics/`) are sent with `subtaskCount: 0` hardcoded (line 2863), which is correct for those — the bug only affects DB-backed epics that have linked subtasks.

## Metadata

- **Tags:** `bug`, `ui`, `epics`, `project.html`, `backend`
- **Complexity:** 3/10

## Complexity Audit

**Routine.** The fix mirrors an existing, proven pattern already implemented in `KanbanProvider.ts`. No new data sources, no schema changes, no migrations. The `epicId` field is already present on every record returned by `db.getBoard()` / `db.getCompletedPlans()`, so the count can be derived in-memory from the same records already being fetched.

## Edge-Case & Dependency Audit

- **Epics with zero subtasks:** `subtaskCountMap.get(planId) || 0` correctly yields `0` — label stays "Subtasks (0)", which is accurate.
- **Non-epic plans:** `subtaskCount` should be `undefined` (or omitted) for non-epics, matching `KanbanProvider` behaviour. The webview only reads it inside the epic accordion, so non-epics are unaffected.
- **Standalone epic documents:** Already hardcoded to `subtaskCount: 0` in the `fetchEpicDocuments` handler (line 2863). These are not DB records and have no subtasks, so no change needed there.
- **Completed subtasks:** `getCompletedPlans` returns completed rows which also carry `epicId`. Counting them in the map is correct — a completed subtask is still a subtask of the epic. This matches `KanbanProvider` which counts `allRows` (active + completed).
- **`isEpic` field type:** In `PlanningPanelProvider`, `isEpic` is `number` (0/1) from the DB, whereas `KanbanProvider` coerces to boolean. The truthiness check `r.isEpic ? ... : undefined` works for both `0`/`1` and `true`/`false`.
- **No migration needed:** This is a display-only bug in unreleased dev work (the `subtaskCount` field was never sent to this webview). No persisted state changes.

## Proposed Changes

### File 1: `src/services/PlanningPanelProvider.ts`

**1a. Add `subtaskCount` to the `KanbanPlanSummary` interface (line ~57):**

```ts
interface KanbanPlanSummary {
    planId: string;
    sessionId: string;
    topic: string;
    column: string;
    workspaceRoot: string;
    workspaceLabel: string;
    project: string;
    repoScope: string;
    mtime: number;
    planFile: string;
    complexity: string;
    isEpic?: number;
    epicId?: string;
    subtaskCount?: number;   // <-- ADD
    clickupTaskId?: string;
    linearIssueId?: string;
}
```

**1b. Compute `subtaskCountMap` and include `subtaskCount` in `_getKanbanPlans()` (lines ~7559–7592):**

After `allRecords` is assembled (line 7559), build the count map, then add the field to the mapped output:

```ts
const allRecords = [...records, ...completedRecords];

// Build subtask count map: for each record with an epicId, increment that epic's count.
const subtaskCountMap = new Map<string, number>();
for (const r of allRecords) {
    if (r.epicId) {
        subtaskCountMap.set(r.epicId, (subtaskCountMap.get(r.epicId) || 0) + 1);
    }
}

allRecords.sort((a, b) => { /* ... unchanged ... */ });
```

Then in the `.map()` return object, add:

```ts
return allRecords.map((r: any) => ({
    planId: r.planId,
    sessionId: r.sessionId || '',
    topic: r.topic || path.basename(r.planFile || '') || 'Untitled',
    column: r.kanbanColumn,
    workspaceRoot: effectiveRoot,
    workspaceLabel: wsLabel,
    project: r.project || '',
    repoScope: r.repoScope || '',
    mtime: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
    planFile: r.planFile || '',
    complexity: r.complexity || 'Unknown',
    isEpic: r.isEpic,
    epicId: r.epicId || '',
    subtaskCount: r.isEpic ? (subtaskCountMap.get(r.planId) || 0) : undefined,  // <-- ADD
    clickupTaskId: r.clickupTaskId || r.clickup_task_id || '',
    linearIssueId: r.linearIssueId || r.linear_issue_id || ''
}));
```

### File 2: `src/webview/project.js` (no change required)

The existing template `Subtasks (${plan.subtaskCount || 0})` (line ~1217) will now receive a real number once the backend sends it. No frontend change is needed — `undefined || 0` already handles the absent-field fallback for non-epics.

## Verification Plan

1. **Build:** `npm run compile` — confirm no TypeScript errors (the new interface field is optional, so no downstream breakage).
2. **Manual test (via installed VSIX):**
   - Open the Switchboard Project panel → Epics tab.
   - Select a workspace that has an epic with at least one linked subtask in the DB.
   - Confirm the accordion summary now reads `Subtasks (N)` where N matches the actual subtask count (cross-check by expanding the accordion — the loaded subtask list length should equal N).
   - Confirm an epic with zero subtasks still shows `Subtasks (0)`.
   - Confirm a standalone epic document (`.switchboard/epics/*.md`) still shows `Subtasks (0)`.
3. **Regression check:** Open the Kanban board tab and confirm epic cards there still show correct subtask counts (unchanged code path).

## Implementation Review (Reviewer Pass — 2026-06-24)

### Status: APPROVED — no code fixes required

The implementation faithfully mirrors the proven `KanbanProvider.ts` pattern. All plan requirements are satisfied.

### Files Changed

| File | Change | Lines |
|------|--------|-------|
| `src/services/PlanningPanelProvider.ts` | Added `subtaskCount?: number` to `KanbanPlanSummary` interface | L58 |
| `src/services/PlanningPanelProvider.ts` | Build `subtaskCountMap` from `allRecords` (active + completed) | L7562–7567 |
| `src/services/PlanningPanelProvider.ts` | Assign `subtaskCount` in `.map()` output (epics only) | L7599 |
| `src/webview/project.js` | No change (existing `plan.subtaskCount \|\| 0` template now receives real values) | L1232 (unchanged) |

### Verification Results

- **Compilation:** Skipped per session instructions.
- **Tests:** Skipped per session instructions (to be run separately by user).
- **Static verification (performed):**
  - All 5 `kanbanPlansReady` send sites (L2489, L2668, L2780, L2796, L2821) confirmed to route through the fixed `_getKanbanPlans()` — no bypass path.
  - Interface field is optional → no downstream type breakage.
  - Frontend `|| 0` fallback handles `undefined` for non-epics correctly.
  - Reference pattern parity confirmed against `KanbanProvider.ts:1186–1208`.
  - Standalone epic documents still hardcoded `subtaskCount: 0` (L2864) — correct, unchanged.

### Findings

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| NIT-1 | NIT | `PlanningPanelProvider._getKanbanPlans()` does not filter ghost plans / planFile-less completed rows before building `subtaskCountMap`, unlike `KanbanProvider` (which applies `filterGhostPlans` + `row.planFile` filter at KanbanProvider.ts:1181–1185). A tombstoned row carrying an `epicId` could inflate the Epics tab count relative to the Kanban board. | **Defer** — pre-existing divergence, explicitly accepted by plan's Edge-Case Audit (line 37). Edge case. Track separately. |
| NIT-2 | NIT | Per-workspace count isolation: in the multi-workspace merge path (L2489), `_getKanbanPlans(root)` is called per-root, so each call's `subtaskCountMap` only sees that root's records. Cross-workspace epic/subtask links would miscount. | **Defer** — inherent to the per-workspace `kanban.db` model; `KanbanProvider` has the identical limitation. Not introduced by this change. |

**No CRITICAL or MAJOR findings.**

### Remaining Risks

1. **NIT-1 divergence** could cause a count mismatch between the Epics tab and the Kanban board in workspaces that have ghost/tombstoned plans with `epicId` set. Low probability, cosmetic impact only.
2. **NIT-2** — cross-workspace epic/subtask linking is not supported by the DB schema; count would be scoped to the epic's own workspace DB. Pre-existing, not a regression.
