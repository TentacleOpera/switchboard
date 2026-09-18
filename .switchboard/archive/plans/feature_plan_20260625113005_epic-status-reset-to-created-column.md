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

**Cause 3 (discovered during plan review) — Legacy `'CODED'` column not normalized:** The board display normalizes legacy column `'CODED'` → `'LEAD CODED'` via `_normalizeLegacyKanbanColumn()` (KanbanProvider.ts line 1983–1986), but the `createEpic` handler's `resolvedColumn` logic does NOT call this normalization. So a subtask with `kanban_column = 'CODED'` in the DB would have `ordinalMap.get('CODED')` return `undefined` → `?? Infinity`, sorting it to the end. The board would show it in "Lead Coder" but `createEpic` would not recognize the column. This is a secondary bug similar to the BACKLOG issue.

**Most likely root cause:** The subtasks' `kanban_column` values in the DB do not reflect their displayed board positions at the time `createEpic` reads them. This can happen if:
- The board displays a card in a column based on runtime state, but the DB `kanban_column` was never updated (stale).
- The `_readRows` default of `"CREATED"` masks a NULL `kanban_column`, making the resolvedColumn always `CREATED` when subtasks have no explicit column set.

**Code investigation findings (verified during plan review):**
- `insertFileDerivedPlan` (KanbanDatabase.ts line 1321–1335) has `ON CONFLICT(plan_file, workspace_id) DO UPDATE SET` that does NOT update `kanban_column` — so file-watcher re-imports preserve the column. This rules out the file watcher as a cause of stale columns.
- `UPSERT_PLAN_SQL` (KanbanDatabase.ts line 549–584) also has `ON CONFLICT DO UPDATE` that does NOT update `kanban_column` — so `upsertPlan` re-inserts preserve the column too.
- The `upsertPlan` call in `createEpic` (line 7516) sets `kanbanColumn: resolvedColumn` for the new epic. Since the epic plan file is new (fresh UUID), there is no conflict — the INSERT succeeds and sets the column correctly.
- `_regenerateEpicFile` (line 8041–8068) re-writes the epic file but does NOT call `upsertPlan` or `insertFileDerivedPlan`. It also calls `registerPendingCreation` (line 8066) so the file watcher skips this write. No column overwrite risk.
- The column-move path (`moveCardToColumn` → `updateColumn` → `movePlanByPlanFile`) correctly updates `kanban_column` in the DB via `UPDATE plans SET kanban_column = ?`.
- Conclusion: if the diagnostic log (Change 3) shows correct column values (e.g., `PLAN REVIEWED`), the `resolvedColumn` logic fix in Changes 1–3 is sufficient. If it shows `CREATED` for all subtasks despite them being displayed in "Planned", there is a deeper DB sync issue requiring separate investigation.

## Metadata
- **Tags:** bugfix, backend
- **Complexity:** 5/10

## User Review Required
Yes — the primary root cause (Cause 1: stale DB columns) is unconfirmed. The diagnostic log in Change 3 must be checked before deciding whether Changes 1–3 are sufficient or whether deeper DB sync investigation (Change 4) is needed. The user should verify the diagnostic log output during manual testing.

## Complexity Audit

### Routine
- Adding `BACKLOG` to the ordinalMap with a fixed ordinal value (single-line addition)
- Adding the `BACKLOG → CREATED` post-processing step (single conditional)
- Adding a `console.log` diagnostic line
- Swapping `resolvedColumn` → `effectiveColumn` in the `upsertPlan` call (one line)
- Adding `_normalizeLegacyKanbanColumn` call to subtask column mapping (one line)

### Complex / Risky
- **Unconfirmed root cause:** If the diagnostic log reveals that subtask `kanban_column` values are genuinely stale (all `CREATED` despite being displayed in other columns), the fix requires investigating the column-move sync path — a potentially deeper issue spanning multiple services (KanbanDatabase, GlobalPlanWatcherService, agent dispatch paths).
- **Legacy column normalization:** The `'CODED'` → `'LEAD CODED'` normalization gap means any subtask still using the legacy `'CODED'` value would be mispositioned. The fix is simple (add normalization) but the data audit to determine how many plans use legacy values is not.

## Edge-Case & Dependency Audit
- **`BACKLOG` column:** Not in `DEFAULT_KANBAN_COLUMNS` (agentConfig.ts line 102–115). Injected only by `PlanningPanelProvider` (line 7799–7806) with `order: 5`. Must be added to the `ordinalMap` so `BACKLOG` subtasks are correctly positioned. `BACKLOG` should be treated as equivalent to `CREATED` (leftmost) per the user's requirement: "ONLY go back to CREATED if at least one subtask was in the new or backlog column."
- **Legacy `'CODED'` column:** Present in `VALID_KANBAN_COLUMNS` (KanbanDatabase.ts line 617–618) but NOT in `DEFAULT_KANBAN_COLUMNS`. The board normalizes it to `'LEAD CODED'` via `_normalizeLegacyKanbanColumn` (line 1983–1986), but `createEpic` does not. Must add normalization to the subtask column mapping in `createEpic`.
- **Column order overrides:** The `_getEffectiveKanbanOrderOverrides()` is applied inside `_buildKanbanColumns` (line 502). The ordinal map already respects overrides.
- **Custom user columns:** `_getCustomKanbanColumns` is passed and included in `columnDefs`. Custom columns are in the ordinal map.
- **Subtasks with NULL kanban_column:** The `_readRows` default of `"CREATED"` means NULL columns are treated as `CREATED`. This is actually correct behavior — a plan with no column set IS in the "New" state.
- **`insertFileDerivedPlan` re-imports:** The `ON CONFLICT` clause does NOT update `kanban_column` (verified). Re-imports preserve the column. File watcher is NOT a cause of stale columns.
- **`UPSERT_PLAN_SQL` re-inserts:** The `ON CONFLICT` clause does NOT update `kanban_column` (verified). `upsertPlan` re-inserts preserve the column.
- **Single-plan `promoteToEpic`:** This path does NOT change `kanban_column` (it only sets `is_epic=1` and moves the file). The plan retains its current column. This is correct and should not be affected.
- **`_regenerateEpicFile`:** Re-writes the epic file but does NOT call `upsertPlan` or `insertFileDerivedPlan`. Calls `registerPendingCreation` so the watcher skips it. No column overwrite risk.
- **Desired behavior clarification:** The epic should go to `CREATED` if any subtask is in `CREATED` or `BACKLOG`. Otherwise, it should inherit the leftmost subtask's column. This is exactly what "leftmost subtask column" means, as long as `BACKLOG` is treated as leftmost (same as `CREATED`) and legacy `'CODED'` is normalized to `'LEAD CODED'`.

## Dependencies
- None — this is a self-contained bugfix in the `createEpic` handler.

## Adversarial Synthesis
Key risks: (1) the primary root cause is unconfirmed — the fix may be insufficient if subtask columns are genuinely stale in the DB; (2) the legacy `'CODED'` normalization gap is a newly discovered secondary bug that could affect plans imported from older versions; (3) the diagnostic log is the only way to distinguish between "logic fix is enough" and "deeper DB sync issue exists." Mitigations: add the diagnostic log first, verify with manual testing, and only escalate to DB sync investigation if the log confirms stale data.

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

**Change 4 (NEW — discovered during plan review): Normalize legacy `'CODED'` column in subtask mapping.**

The board display normalizes `'CODED'` → `'LEAD CODED'` via `_normalizeLegacyKanbanColumn()` (line 1983–1986), but `createEpic` does not. Add normalization to the subtask column mapping so legacy columns are correctly positioned in the ordinal sort:

```typescript
const resolvedColumn = subtasks
     .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
     .filter((col: string | null): col is string => !!col)
     .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || this._normalizeLegacyKanbanColumn(subtasks[0].kanbanColumn) || 'CREATED';
```

This ensures that a subtask with `kanban_column = 'CODED'` in the DB is treated as `'LEAD CODED'` for the ordinal lookup, matching what the board displays.

### `src/services/KanbanProvider.ts` — Verify subtask column data freshness

**Change 5: If Cause 1 is confirmed (subtask columns are stale/NULL), investigate the board's column-move path.**

The `movePlanByPlanFile` method in `KanbanDatabase.ts` (line 1475) updates `kanban_column` when a card is dragged to a new column. If subtasks were moved via drag-and-drop, their `kanban_column` should be current. If they were moved via an agent dispatch (e.g., the planner agent moving a plan to "Plan Reviewed"), verify that the dispatch path also calls `movePlanByPlanFile` or equivalent.

This is a verification step — if the diagnostic log in Change 3 shows correct column values (e.g., `PLAN REVIEWED`), then the `resolvedColumn` logic fix in Changes 1–4 is sufficient. If the log shows `CREATED` for all subtasks despite them being displayed in "Planned", then there is a deeper DB sync issue that needs separate investigation.

## Verification Plan

### Automated Tests
No automated tests required for this change. The fix is in the `createEpic` handler's column resolution logic, which is difficult to unit-test without mocking the full KanbanProvider/KanbanDatabase stack. Manual verification via the VSIX-installed extension is the primary validation path. (Per session directives, automated tests are skipped — the test suite will be run separately by the user.)

### Manual Verification Steps
1. **Add the diagnostic log** (Change 3) and create an epic from 2 plans that are both in the "Planned" column. Check the debug console — confirm the log shows `subtask columns = [PLAN REVIEWED, PLAN REVIEWED]` and `effectiveColumn=PLAN REVIEWED`.
2. **All subtasks in PLANNED:** Move 2+ plans to the "Planned" column. Select them, create an epic. Confirm the epic card appears in the "Planned" column (NOT "New"/CREATED).
3. **Mixed columns (one in NEW, one in PLANNED):** Move one plan to "New" and one to "Planned". Select both, create an epic. Confirm the epic appears in "New" (CREATED) — because at least one subtask was in NEW.
4. **All subtasks in CODED:** Move 2+ plans to "Lead Coder" (LEAD CODED). Create an epic. Confirm the epic appears in "Lead Coded" (the leftmost subtask column).
5. **Subtask in BACKLOG:** If the BACKLOG column is available, move one plan to BACKLOG and one to PLANNED. Create an epic. Confirm the epic appears in "New" (CREATED), not BACKLOG.
6. **Single-plan promotion unchanged:** Select 1 plan in "Planned", promote it to epic. Confirm it stays in "Planned" (the `promoteToEpic` path does not change the column).
7. **Legacy CODED column (if applicable):** If any plans still have `kanban_column = 'CODED'` in the DB (legacy value), select them and create an epic. Confirm the epic appears in "Lead Coder" (not at the end of the board).
8. **If the diagnostic log shows `CREATED` for all subtasks** despite them being in "Planned" on the board, investigate the column-move sync path as described in Change 5.

---

**Recommendation:** Complexity is 5/10 → **Send to Coder**. The core changes (ordinal map fix, BACKLOG mapping, legacy normalization, diagnostic log) are straightforward single-file edits. The only risk is the unconfirmed root cause, which the diagnostic log will resolve during manual testing.

---

## Review Results (Reviewer Pass — 2026-06-25)

### Files Changed
- `src/services/KanbanProvider.ts` — `createEpic` handler (lines 7734–7746): BACKLOG ordinal injection, legacy column normalization, effectiveColumn mapping, diagnostic logging, upsertPlan column swap. Additional verify log at line 7812.

### Stage 1 — Adversarial Findings

| Severity | Finding | Location | Disposition |
|----------|---------|----------|-------------|
| NIT | Two `console.log` diagnostic statements left in production code (one planned, one extra verify log at line 7812). No TODO/follow-up marker. | KanbanProvider.ts:7746, 7812 | Defer — remove after root cause confirmed via manual testing |
| NIT | Type predicate `(col: string \| null): col is string` is imprecise — `_normalizeLegacyKanbanColumn` always returns `string`, never `null`. No runtime impact. | KanbanProvider.ts:7743 | Defer — cosmetic, not worth the diff |
| NIT | Fallback chain re-normalizes `subtasks[0].kanbanColumn` redundantly (already normalized in the `.map()` step, but the mapped array was filtered/sorted so the fallback needs its own normalization). Correct but slightly wasteful. | KanbanProvider.ts:7744 | No action — correct behavior |

### Investigated Non-Issues (confirmed safe)
- **`updateEpicStatus` column clobber risk:** `UPDATE plans SET is_epic, epic_id, updated_at` — does NOT touch `kanban_column`. Safe.
- **`_regenerateEpicFile` re-import risk:** Rewrites file only, calls `registerPendingCreation` to skip watcher. No `upsertPlan`/`insertFileDerivedPlan`. Column preserved.
- **BACKLOG ordinal -1 vs custom negative-order columns:** Theoretical edge case — no evidence of negative-order custom columns in the wild. `KANBAN_REWEIGHT_STEP` uses positive weights.
- **Schema guarantees:** `kanban_column TEXT NOT NULL DEFAULT 'CREATED'` — NULL cannot appear. `_readRows` default is belt-and-suspenders.

### Stage 2 — Balanced Synthesis
All four plan changes are implemented correctly. No CRITICAL or MAJOR findings. No code fixes applied. The two diagnostic `console.log` statements are intentionally temporary per the plan's verification strategy and should be removed after manual testing confirms the root cause.

### Verification (Static — compilation/tests skipped per session directives)
1. **Code path traced:** `createEpic` → `getPlanByPlanId` (reads DB `kanban_column`) → `_normalizeLegacyKanbanColumn` → ordinal sort → BACKLOG→CREATED mapping → `upsertPlan(effectiveColumn)`. ✓
2. **No clobber risk:** `updateEpicStatus` and `_regenerateEpicFile` do not touch `kanban_column`. ✓
3. **Schema check:** `kanban_column NOT NULL DEFAULT 'CREATED'`. ✓
4. **Frontend contract:** `kanban.html` sends `subtaskPlanIds` for 2+ selections; `promoteToEpic` for single. `promoteToEpic` does not change column. ✓
5. **VALID_KANBAN_COLUMNS:** All possible `effectiveColumn` values are valid. ✓

### Remaining Risks
1. **Unconfirmed root cause (Cause 1):** If subtask `kanban_column` values are stale in the DB (all `CREATED` despite being displayed in other columns), the logic fix is insufficient and Change 5 (DB sync investigation) is needed. The diagnostic log will reveal this during manual testing.
2. **Diagnostic log debt:** Two `console.log` statements should be removed after manual testing confirms the fix works.
3. **Legacy CODED data audit:** The normalization fix handles `'CODED'` → `'LEAD CODED'` correctly, but the extent of legacy `'CODED'` values in the installed base is unknown. The V22 migration (KanbanDatabase.ts line 4483–4502) resets invalid columns to `'CREATED'`, but `'CODED'` is in `VALID_KANBAN_COLUMNS` so it would NOT be reset — it would persist as `'CODED'` and now be normalized at epic creation time.
