# Remove Dependency Tracking — Phase 5: Data Layer

## Goal

Remove the dependency storage and parsing infrastructure: the `dependencies` field from the `KanbanPlanRecord` and `PlanMetadata` interfaces, all SQL column references, the four database methods, the standalone parser file, and the importer initialisation. After this phase, no code reads or writes dependency data.

## Problem Analysis

With all callers removed in Phases 3-4, the data layer is now unreachable. This phase removes the interfaces, SQL references, and parser that define and store dependency data. The SQLite column definition is left in place to avoid a destructive schema migration.

## Metadata

- **Complexity:** 5
- **Tags:** refactor, backend

## User Review Required

None — removal only, no new behaviour.

## Complexity Audit

### Routine
- Delete `src/services/planDependencyParser.ts`
- Remove `dependencies` from `PlanMetadata` interface
- Remove dependency extraction block from `planMetadataUtils.ts`
- Remove `dependencies: ''` from `PlanFileImporter.ts`
- Remove `dependencies` from `KanbanPlanRecord` interface

### Complex / Risky
- **KanbanDatabase SQL handling** — must remove `dependencies` from INSERT column list, VALUES placeholder count, ON CONFLICT UPDATE clause, and SELECT column list. The VALUES placeholder count must decrease by one (one fewer `?`). The ON CONFLICT UPDATE clause has `dependencies = excluded.dependencies` which must be removed — if left, it references a column not in the INSERT and will cause a runtime error. The CREATE TABLE column definition (line 100) and ALTER TABLE migration (line 189) are left in place.
- **KanbanDatabase `_readRows()`** — must remove `dependencies: String(row.dependencies || "")` from the row mapping. Since `getAsObject()` returns all columns, the field will still be present in the raw row but we simply don't map it.
- **KanbanDatabase method removal** — four methods to remove: `updateDependenciesByPlanFile()`, `updateDependencies()`, `getDependencyStatus()`, `getPlansWithDependencies()`. All callers were removed in Phases 3-4.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — removal only.
- **Security:** None.
- **Side Effects:**
  - The `dependencies TEXT DEFAULT ''` column remains in the SQLite schema. New rows get DEFAULT '' automatically. Existing rows retain their data but nothing reads it. This is harmless and avoids a schema migration.
  - Removing `dependencies` from the INSERT column list means new rows will use the DEFAULT '' value instead of an explicit insert. This is functionally identical.
- **Dependencies & Conflicts:** Phases 3-4 must be complete. All callers of the removed methods are already gone.

## Dependencies

- Phase 3 (Service handlers) — removed `getDependenciesFromPlan()`, `_sendDependencyMapData()`, and their callers in KanbanProvider
- Phase 4 (TaskViewerProvider) — removed all `updateDependenciesByPlanFile()` callers and `getDependenciesFromPlan()` callers

## Adversarial Synthesis

Key risk: SQL column mismatch. If `dependencies` is removed from the INSERT column list but `dependencies = excluded.dependencies` remains in the ON CONFLICT UPDATE clause, SQLite will error because `excluded.dependencies` won't exist in the inserted row. Mitigation: remove both the INSERT column and the ON CONFLICT UPDATE entry in the same edit. Also reduce the VALUES placeholder count by one. The CREATE TABLE definition stays — it's independent of the UPSERT statement.

## Proposed Changes

### Delete `src/services/planDependencyParser.ts`
- Delete the entire file (121 lines)

### `src/services/planMetadataUtils.ts`
- Remove `dependencies: string` from `PlanMetadata` interface (line 29)
- Remove the dependency extraction block (lines 94–110)
- Remove `dependencies` from the returned object literal (line 123)

### `src/services/PlanFileImporter.ts`
- Remove `dependencies: ''` initialisation (line 116)

### `src/services/KanbanDatabase.ts`
- Remove `dependencies: string` from `KanbanPlanRecord` interface (line 28)
- Remove `dependencies` from INSERT column list (line 456)
- Remove one `?` placeholder from VALUES to match the reduced column count
- Remove `dependencies = excluded.dependencies` from ON CONFLICT UPDATE clause (line 470)
- Remove `dependencies` from `PLAN_COLUMNS` SELECT list (lines 490–493)
- Remove `dependencies: String(row.dependencies || "")` from `_readRows()` row mapping (line 4697)
- Remove `updateDependenciesByPlanFile()` method (lines 1391–1397)
- Remove `updateDependencies()` method (lines 1399–1404)
- Remove `getDependencyStatus()` method (lines 1532–1563)
- Remove `getPlansWithDependencies()` method (lines 2289–2311)
- Leave `dependencies TEXT DEFAULT ''` in CREATE TABLE (line 100) and ALTER TABLE migration (line 189)

### `src/services/KanbanProvider.ts` — deferred card literal cleanup
- Now that `KanbanPlanRecord` no longer has `dependencies`, remove `dependencies: []` and `hasBlockingDependencies: false` from all card construction literals (lines 1130–1131, 1146–1147, 1900–1901, 2064–2065, 3569–3570)
- Remove `dependencies: string[]` and `hasBlockingDependencies: boolean` from `KanbanCard` interface (lines 92–93)

## Verification Plan

### Automated Tests
- Skip (per session directive). Tests cleaned in Phase 6.

### Manual Verification
- Open Kanban view — no errors in developer console
- Create a new plan — it appears in the kanban without errors
- Move a plan between columns — no crash
- Verify no TypeScript compilation errors related to removed interface fields

**Recommendation: Send to Coder** (Complexity 5 — SQL handling requires care but all callers are already gone)
