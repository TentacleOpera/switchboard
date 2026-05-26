# Bug Fix: Completed Column Does Not Respect Project Filter

## Goal

Fix the completed column to properly filter by project, matching the behavior of active columns. Currently, completed plans from all projects are shown regardless of the selected project filter.

## Metadata

- **Tags:** bugfix, backend
- **Complexity:** 2

## User Review Required

No — this is a straightforward bug fix to align completed column filtering with active column filtering.

## Complexity Audit

### Routine

- Two-file change: `KanbanDatabase.ts` (add new method) and `TaskViewerProvider.ts` (use new method)
- Pattern mirrors existing `getBoardFilteredByProject` for active plans
- No DB schema changes, no API contract changes

### Complex / Risky

- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — read-only DB query
- **Security:** No new security surface
- **Side Effects:** `getCompletedPlansFiltered` (repoScope-only) becomes unreachable in `TaskViewerProvider` after this change; must be marked `@deprecated` to signal the debt (see Proposed Changes)
- **Dependencies & Conflicts:** None — new method, existing call sites in `TaskViewerProvider` updated, no other callers of `getCompletedPlansFiltered` exist
- **Empty string edge case:** `getProjectFilter()` may return `""` (empty string, treated as falsy). Both the `(repoScope || projectFilter)` condition in `TaskViewerProvider` and the `if (!project && !repoScope)` guard in the new DB method treat `""` as absent — behavior is correct and consistent

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) The new method must use `this._readRows(stmt)` — the canonical helper used by all peer methods including `getBoardFilteredByProject` — not the old manual `while/step/free` pattern; using the wrong pattern would be inconsistent and skip path resolution in `_readRows`. (2) The old `getCompletedPlansFiltered` must be deprecated since it becomes unreachable in `TaskViewerProvider` after this change, otherwise it is silent dead code. Mitigations: copy exact structure from `getBoardFilteredByProject`; add `@deprecated` JSDoc to `getCompletedPlansFiltered`.

## Root Cause

In `TaskViewerProvider._refreshRunSheets` (lines 13540–13545), active plans use `getBoardFilteredByProject` which filters by both `project` and `repoScope`:

```ts
const activeRows = (repoScope || projectFilter)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
```

However, completed plans only use `getCompletedPlansFiltered` which filters by `repoScope` only:

```ts
const completedRows = (repoScope)
    ? await db.getCompletedPlansFiltered(workspaceId, repoScope)
    : await db.getCompletedPlans(workspaceId);
```

The `getCompletedPlansFiltered` method in `KanbanDatabase.ts` (lines 2151–2168) does not accept or apply a project filter:

```ts
public async getCompletedPlansFiltered(
    workspaceId: string,
    repoScope: string | null,
    limit: number = 100
): Promise<KanbanPlanRecord[]> {
    if (!repoScope) {
        return this.getCompletedPlans(workspaceId, limit);
    }
    // ... filters by repoScope only, no project parameter
}
```

This mismatch causes completed plans to ignore the project filter, showing cards from all projects.

## Proposed Changes

### `src/services/KanbanDatabase.ts`

**Step 1:** Add a new method `getCompletedPlansFilteredByProject` immediately after `getCompletedPlansFiltered` (after line 2168). Mirrors `getBoardFilteredByProject` exactly — including using `this._readRows(stmt)` (the canonical helper that handles `stmt.free()` and path resolution) rather than a manual loop:

```ts
public async getCompletedPlansFilteredByProject(
    workspaceId: string,
    project: string | null,
    repoScope: string | null,
    limit: number = 100
): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    if (!project && !repoScope) {
        return this.getCompletedPlans(workspaceId, limit);
    }
    let sql = `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? AND status = 'completed'`;
    const params: unknown[] = [workspaceId];
    if (project) {
        sql += ' AND project = ?';
        params.push(project);
    }
    if (repoScope) {
        sql += " AND repo_scope IN (?, '')";
        params.push(repoScope);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(limit);
    const stmt = this._db.prepare(sql, params);
    return this._readRows(stmt);
}
```

> **Clarification:** `_readRows` (line 4424) calls `stmt.step()` / `stmt.getAsObject()` / `stmt.free()` internally and also runs `_resolveAbsolutePlanFile` on each row — exactly what `getBoardFilteredByProject` relies on. Do NOT use the manual `while (stmt.step()) { ... stmt.free() }` pattern.

**Step 2:** Mark the now-superseded `getCompletedPlansFiltered` as deprecated (line 2151). Add a JSDoc comment following the existing `@deprecated` pattern (see line 2170 for `getPlanBySessionId`):

```ts
/** @deprecated Superseded by getCompletedPlansFilteredByProject which also accepts a project filter. */
public async getCompletedPlansFiltered(
    workspaceId: string,
    repoScope: string | null,
    limit: number = 100
): Promise<KanbanPlanRecord[]> {
```

---

### `src/services/TaskViewerProvider.ts`

**Step 3:** Update the completed plans query in `_refreshRunSheets` (lines 13543–13545) to use the new method whenever either filter is set, matching the active plans guard:

```ts
// Before:
const completedRows = repoScope
    ? await db.getCompletedPlansFiltered(workspaceId, repoScope)
    : await db.getCompletedPlans(workspaceId);

// After:
const completedRows = (repoScope || projectFilter)
    ? await db.getCompletedPlansFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getCompletedPlans(workspaceId);
```

This mirrors the active plans query at lines 13540–13542 exactly.

## Verification Plan

### Automated Tests

Add a unit test suite in `src/test/__tests__/KanbanDatabase.test.ts`. Follow the existing fixture pattern in that file for `plan1`, `plan2`, `plan3` (they must be valid `KanbanPlanRecord`-shaped objects with at minimum `plan_id`, `workspace_id`, `status`, `project`, and `repo_scope` fields set):

```ts
suite('getCompletedPlansFilteredByProject', () => {
    test('filters by project when projectFilter is set', async () => {
        // Insert completed plans with different projects
        await db.upsertPlan({ ...plan1, project: 'Project A', status: 'completed' });
        await db.upsertPlan({ ...plan2, project: 'Project B', status: 'completed' });

        const results = await db.getCompletedPlansFilteredByProject(workspaceId, 'Project A', null);
        assert.equal(results.length, 1);
        assert.equal(results[0].project, 'Project A');
    });

    test('filters by repoScope when repoScope is set', async () => {
        await db.upsertPlan({ ...plan1, repoScope: 'be', status: 'completed' });
        await db.upsertPlan({ ...plan2, repoScope: 'fe', status: 'completed' });

        const results = await db.getCompletedPlansFilteredByProject(workspaceId, null, 'be');
        assert.equal(results.length, 1);
        assert.equal(results[0].repoScope, 'be');
    });

    test('filters by both project and repoScope when both are set', async () => {
        await db.upsertPlan({ ...plan1, project: 'Project A', repoScope: 'be', status: 'completed' });
        await db.upsertPlan({ ...plan2, project: 'Project A', repoScope: 'fe', status: 'completed' });
        await db.upsertPlan({ ...plan3, project: 'Project B', repoScope: 'be', status: 'completed' });

        const results = await db.getCompletedPlansFilteredByProject(workspaceId, 'Project A', 'be');
        assert.equal(results.length, 1);
        assert.equal(results[0].project, 'Project A');
        assert.equal(results[0].repoScope, 'be');
    });

    test('returns all completed plans when no filters are set', async () => {
        await db.upsertPlan({ ...plan1, project: 'Project A', status: 'completed' });
        await db.upsertPlan({ ...plan2, project: 'Project B', status: 'completed' });

        const results = await db.getCompletedPlansFilteredByProject(workspaceId, null, null);
        assert.equal(results.length, 2);
    });
});
```

### Manual Checklist

- [ ] Open kanban board with multiple projects
- [ ] Select a project filter
- [ ] Move a plan from that project to COMPLETED
- [ ] Verify the completed plan appears in the completed column
- [ ] Move a plan from a different project to COMPLETED
- [ ] Verify the completed plan from the other project does NOT appear in the completed column
- [ ] Clear the project filter
- [ ] Verify both completed plans now appear

---

**Recommendation:** Send to Coder
