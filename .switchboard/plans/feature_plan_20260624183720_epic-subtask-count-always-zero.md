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
