# Epic Status Reset to CREATED Column on Creation

## Goal

### Problem
When an epic is created in `kanban.html` from multiple selected plans, the epic always gets its kanban column set to `CREATED` (the "New" column), even if all the subtasks were already in the `PLANNED` (Plan Reviewed) column or further. The epic should **only** go back to `CREATED` if at least one subtask was in the `NEW` (CREATED) or `BACKLOG` column. If all subtasks were already past those columns, the epic should inherit the leftmost (earliest-stage) subtask's column.

### Background Context
The `createEpic` handler in `KanbanProvider.ts` (lines 7469–7562) resolves the epic's initial column via a `resolvedColumn` computation (lines 7489–7496):

```typescript
const customColumns = await this._getCustomKanbanColumns(workspaceRoot);
const columnDefs = await this._buildKanbanColumns([], customColumns);
const ordinalMap = new Map<string, number>();
columnDefs.forEach((def, idx) => ordinalMap.set(def.id, idx));
const resolvedColumn = subtasks
     .map((st: any) => st.kanbanColumn)
     .filter((col: string | null): col is string => !!col)
     .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || subtasks[0].kanbanColumn || 'CREATED';
```

This **intends** to pick the leftmost (lowest-ordinal) subtask column. If all subtasks are in `PLAN REVIEWED` (order 100), the result should be `PLAN REVIEWED`. If any subtask is in `CREATED` (order 0), the result should be `CREATED`.

### Root Cause Analysis
The `resolvedColumn` logic appears correct in isolation, but the user observes the epic **always** landing in `CREATED`. There are two likely causes:

**Cause 1 — Subtask `kanbanColumn` is null/empty in the DB:** The `_readRows` method in `KanbanDatabase.ts` (line 5750) maps `kanban_column` as `String(row.kanban_column || "CREATED")`. If a subtask's `kanban_column` is NULL or empty string in the DB (e.g., it was imported via the file watcher's `insertFileDerivedPlan` which sets `kanban_column='CREATED'` on fresh insert but may leave it empty in some edge cases, or it was never explicitly moved), `_readRows` converts it to `"CREATED"`. This means the filter `!!col` keeps it, and the sort places `CREATED` (order 0) first. The resolvedColumn becomes `CREATED` even if the user sees the card in the "Planned" column on the board.

**Cause 2 — The `ordinalMap` is built with `_buildKanbanColumns([], customColumns)` (empty custom agents):** Line 7490 passes `[]` for custom agents. While `buildKanbanColumns` (agentConfig.ts line 335) includes ALL default columns regardless of agent availability (the `hideWhenNoAgent` flag is only used in frontend rendering, not in `buildKanbanColumns`), the `BACKLOG` column is **not** in `DEFAULT_KANBAN_COLUMNS` — it is injected separately by `PlanningPanelProvider` (line 7799–7802). So if a subtask is in `BACKLOG`, `ordinalMap.get('BACKLOG')` returns `undefined` → `?? Infinity`, sorting it to the end. This means a `BACKLOG` subtask would NOT be the leftmost, and the epic would not go to `BACKLOG`. However, the user's complaint is the opposite (always `CREATED`), so this is a secondary issue.

**Most likely root cause:** The subtasks' `kanban_column` values in the DB do not reflect their displayed board positions at the time `createEpic` reads them. This can happen if:
- The board displays a card in a column based on runtime state, but the DB `kanban_column` was never updated (stale).
- The `_readRows` default of `"CREATED"` masks a NULL `kanban_column`, making the resolvedColumn always `CREATED` when subtasks have no explicit column set.

## Metadata
- **Tags:** kanban, epic, column, status, backend
- **Complexity:** 5/10

## Complexity Audit
**Moderate.** The fix involves adjusting the `resolvedColumn` logic in `KanbanProvider.ts` and ensuring the `BACKLOG` column is included in the ordinal map. No frontend changes needed. The risk is low — the change only affects the initial column of newly created epics.

## Edge-Case & Dependency Audit
- **`BACKLOG` column:** Not in `DEFAULT_KANBAN_COLUMNS`. Must be added to the `ordinalMap` so `BACKLOG` subtasks are correctly positioned. `BACKLOG` should be treated as equivalent to `CREATED` (leftmost) per the user's requirement: "ONLY go back to CREATED if at least one subtask was in the new or backlog column."
- **Column order overrides:** The `_getEffectiveKanbanOrderOverrides()` is applied inside `_buildKanbanColumns`. The ordinal map already respects overrides.
- **Custom user columns:** `_getCustomKanbanColumns` is passed and included in `columnDefs`. Custom columns are in the ordinal map.
- **Subtasks with NULL kanban_column:** The `_readRows` default of `"CREATED"` means NULL columns are treated as `CREATED`. This is actually correct behavior — a plan with no column set IS in the "New" state.
- **Single-plan `promoteToEpic`:** This path does NOT change `kanban_column` (it only sets `is_epic=1` and moves the file). The plan retains its current column. This is correct and should not be affected.
- **Desired behavior clarification:** The epic should go to `CREATED` if any subtask is in `CREATED` or `BACKLOG`. Otherwise, it should inherit the leftmost subtask's column. This is exactly what "leftmost subtask column" means, as long as `BACKLOG` is treated as leftmost (same as `CREATED`).

## Proposed Changes

### `src/services/KanbanProvider.ts` — `createEpic` handler (lines 7489–7496)

**Change 1: Include `BACKLOG` in the ordinal map and treat it as leftmost (order -1).**

The current code builds the ordinal map from `_buildKanbanColumns([], customColumns)`, which does not include `BACKLOG`. Add `BACKLOG` explicitly with an ordinal lower than `CREATED` (order 0):

```typescript
const customColumns = await this._getCustomKanbanColumns(workspaceRoot);
const columnDefs = await this._buildKanbanColumns([], customColumns);
const ordinalMap = new Map<string, number>();
columnDefs.forEach((def, idx) => ordinalMap.set(def.id, idx));
// BACKLOG is injected by PlanningPanelProvider, not by _buildKanbanColumns.
// Treat it as leftmost (before CREATED) so a BACKLOG subtask sends the epic to CREATED.
if (!ordinalMap.has('BACKLOG')) {
    ordinalMap.set('BACKLOG', -1);
}
```

**Change 2: Map `BACKLOG` to `CREATED` in the resolved column.**

Since the epic should go to `CREATED` (not `BACKLOG`) when a subtask is in `BACKLOG`, add a post-processing step:

```typescript
const resolvedColumn = subtasks
     .map((st: any) => st.kanbanColumn)
     .filter((col: string | null): col is string => !!col)
     .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || subtasks[0].kanbanColumn || 'CREATED';

// If the leftmost subtask was in BACKLOG, the epic goes to CREATED (not BACKLOG).
const effectiveColumn = resolvedColumn === 'BACKLOG' ? 'CREATED' : resolvedColumn;
```

Then use `effectiveColumn` in the `upsertPlan` call (line 7521):

```typescript
kanbanColumn: effectiveColumn,
```

**Change 3: Add diagnostic logging to verify subtask columns at creation time.**

```typescript
console.log(`[KanbanProvider] createEpic: subtask columns = [${subtasks.map(st => st.kanbanColumn).join(', ')}], resolvedColumn=${resolvedColumn}, effectiveColumn=${effectiveColumn}`);
```

This will help confirm whether the subtask `kanbanColumn` values are correctly populated or are NULL/empty (defaulting to `CREATED`).

### `src/services/KanbanProvider.ts` — Verify subtask column data freshness

**Change 4: If Cause 1 is confirmed (subtask columns are stale/NULL), investigate the board's column-move path.**

The `movePlanByPlanFile` method in `KanbanDatabase.ts` (line 1475) updates `kanban_column` when a card is dragged to a new column. If subtasks were moved via drag-and-drop, their `kanban_column` should be current. If they were moved via an agent dispatch (e.g., the planner agent moving a plan to "Plan Reviewed"), verify that the dispatch path also calls `movePlanByPlanFile` or equivalent.

This is a verification step — if the diagnostic log in Change 3 shows correct column values (e.g., `PLAN REVIEWED`), then the `resolvedColumn` logic fix in Changes 1–2 is sufficient. If the log shows `CREATED` for all subtasks despite them being displayed in "Planned", then there is a deeper DB sync issue that needs separate investigation.

## Verification Plan
1. **Add the diagnostic log** (Change 3) and create an epic from 2 plans that are both in the "Planned" column. Check the debug console — confirm the log shows `subtask columns = [PLAN REVIEWED, PLAN REVIEWED]` and `effectiveColumn=PLAN REVIEWED`.
2. **All subtasks in PLANNED:** Move 2+ plans to the "Planned" column. Select them, create an epic. Confirm the epic card appears in the "Planned" column (NOT "New"/CREATED).
3. **Mixed columns (one in NEW, one in PLANNED):** Move one plan to "New" and one to "Planned". Select both, create an epic. Confirm the epic appears in "New" (CREATED) — because at least one subtask was in NEW.
4. **All subtasks in CODED:** Move 2+ plans to "Lead Coder" (LEAD CODED). Create an epic. Confirm the epic appears in "Lead Coded" (the leftmost subtask column).
5. **Subtask in BACKLOG:** If the BACKLOG column is available, move one plan to BACKLOG and one to PLANNED. Create an epic. Confirm the epic appears in "New" (CREATED), not BACKLOG.
6. **Single-plan promotion unchanged:** Select 1 plan in "Planned", promote it to epic. Confirm it stays in "Planned" (the `promoteToEpic` path does not change the column).
7. **If the diagnostic log shows `CREATED` for all subtasks** despite them being in "Planned" on the board, investigate the column-move sync path as described in Change 4.
