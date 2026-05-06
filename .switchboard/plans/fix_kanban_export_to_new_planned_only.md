# Fix Kanban State Export to Include Only NEW and PLANNED Columns

## Goal
Optimize the `kanban-state.json` auto-export to only include plans from the `NEW` and `PLANNED` columns. This reduces noise and token usage for the workflow dependency gatherer, which only cares about plans that haven't started yet.

## Proposed Changes

### src/services/KanbanDatabase.ts
- Modify `exportStateToFile()` to filter the `columns` object before serialization.
- Ensure only the `NEW` and `PLANNED` keys are present in the exported JSON.

### src/test/kanban-auto-export.test.ts
- Update test assertions to verify that `CREATED` and `CODED` columns are excluded.
- Verify that `NEW` and `PLANNED` columns are correctly populated.

---

## Reviewer Findings (Reviewer-Executor Pass)

### Stage 1: Grumpy Principal Engineer Review
**CRITICAL:** The implementation claims to only export `NEW` and `PLANNED` columns, but the code still loops through all plans in memory. Furthermore, the test was actually asserting that `CREATED` *was* present!
**MAJOR:** In-memory filtering is inefficient. We're fetching all plans via `getBoard()` and discarding 80% of them. Use a targeted SQL query.

### Stage 2: Balanced Synthesis
**Actionable Fixes:**
1. Update `KanbanDatabase.ts` to use a direct SQL query: `SELECT ... WHERE kanban_column IN ('NEW', 'PLANNED')`.
2. Fix the test suite to strictly assert the exclusion of other columns.
3. Update `KanbanPlanRecord` mock in tests to include missing TypeScript fields.

## Final Resolution & Execution
- **Code Fix:** Replaced in-memory filtering with an optimized SQL query in `exportStateToFile`.
- **Test Fix:** Updated `kanban-auto-export.test.ts` with correct assertions and updated dummy plan types.
- **Verification:** Verified with `npx mocha` after fixing TypeScript compilation errors.
- **Files Modified:** `src/services/KanbanDatabase.ts`, `src/test/kanban-auto-export.test.ts`.

## Complexity Audit
**Manual Complexity Override:** 3

### Complex / Risky
- None.
