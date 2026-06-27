# Comprehensive Fix: All Epic is_epic Clobbering and Cascade Bugs

## Goal

A full audit of every card move path, upsert path, file watcher path, **agent-prompt SQL path, batch-complete path, and run-sheet completion path** in the codebase has identified **8 distinct bug classes** that can cause epics to lose `is_epic` status or fail to cascade subtask column moves. This plan addresses all of them in one pass. Classes 6-8 were found in a follow-up sweep that the original 5-class audit missed.

**Root cause (verified against source):** the codebase is mid-migration from `session_id`-keyed to `plan_id`-keyed plan identity. File-based epics carry `session_id = ''`, so every DB method that keys on `session_id` (`updateColumnWithEpicCascade`, `updateColumnTransaction`) silently matches zero rows for file-based epics/subtasks and returns `true` with no rows-affected check. Separately, `UPSERT_PLAN_SQL` uses `COALESCE(excluded.is_epic, is_epic)` but `upsertPlans` passes `record.isEpic ?? 0` (a literal `0`, never `NULL`), so `COALESCE(0, 1)` resolves to `0` and clobbers any existing `is_epic = 1`. The full per-class root-cause analysis is preserved in **## Bug Classes Found** below.

## Metadata

**Tags:** bugfix, backend, database
**Complexity:** 7

## User Review Required

This fix encodes a few semantic decisions that should be confirmed before implementation:

1. **`is_epic` becomes "sticky" via upsert.** The Class 1 `CASE` change means `upsertPlans` can set `is_epic` to 1 but can no longer clear it back to 0 (because `CASE WHEN excluded.is_epic > 0` is false for 0, so the existing value is kept). Demotion of an epic must instead go through `updateEpicStatus(planId, 0, '')`. Verified safe today (tombstones use `tombstonePlan`, which only sets `status='deleted'` and never touches `is_epic`), but it is a permanent contract change. **Confirm this stickiness is acceptable.**
2. **Notion backup does not round-trip `is_epic`.** Verified: `_notionPageToPlanRecord` never sets `isEpic`, so Notion restore today silently clobbers every existing epic to `is_epic = 0`. The Class 1 fix changes this to *preserve* the local `is_epic` on restore. **Confirm "preserve local DB-owned flag when backup is silent" is the desired restore semantics** (vs. extending Notion backup to capture `is_epic` — out of scope here).
3. **Empty-`sessionId` fallback behavior in `_updateKanbanColumnForSession`.** The current fallback calls `db.updateColumn('', column)`, which routes to `getPlanBySessionId('')` → `WHERE session_id = '' LIMIT 1`, matching an *arbitrary* empty-session plan and moving the wrong card. The proposed fix guards this by returning `false` when `sessionId` is empty rather than guessing. **Confirm a no-op (return false) is preferred over a wrong-plan write for file-based plans in the no-provider fallback path.**
4. **Optional stronger cascade (open).** The new method can either take an explicit `subtaskPlanIds[]` (mirrors existing pattern, inherits a benign read-then-write race) or cascade via `WHERE epic_id = ? AND status = 'active'` (single atomic UPDATE, race-free). **Confirm which variant to implement** — default below keeps the explicit-ID form to match existing call sites.
5. **Class 6 fix strategy for agent-prompt SQL (open).** The embedded `sqlite3` statements in agent prompts (Class 6) cannot call the new DB method — they run as raw shell commands inside an autonomous agent. Two options: (a) **append a subtask-cascade UPDATE** to the prompt SQL (`UPDATE plans SET kanban_column = ... WHERE epic_id = ? AND status = 'active'`) and switch the batch variant from `session_id IN` to `plan_id IN`; or (b) **replace the raw SQL with an instruction to call the Switchboard skill/extension** (e.g. `kanban_operations` move-card) so column moves go through the validated DB layer. Option (a) keeps the existing self-contained agent workflow; option (b) is cleaner but requires the agent host to have the skill available. **Confirm which strategy to use.** Default below uses (a).

## Complexity Audit

### Routine
- SQL one-liner change to `UPSERT_PLAN_SQL` (`COALESCE` → `CASE`), localized to `KanbanDatabase.ts`.
- New `updateColumnWithEpicCascadeByPlanId` method is a near-clone of the existing `updateColumnWithEpicCascade` (same transaction/`BEGIN`/`COMMIT`/`_persist` shape), swapping `session_id` for `plan_id`.
- `completePlan` / `completeSelected` epic-check-and-cascade mirrors the pattern already present in `completeAll` (lines 6747-6753).
- Class 7 handler fixes (`uncompleteCard`, `testingFailureReport`, `_restoreFromArchive` fallback, `markPlanComplete` fallback) reuse the exact same epic-check-then-cascade pattern as Classes 3/4 — no new mechanism.
- Class 8 (`completeMultipleByPlanFile`) is a localized DB method that gains an epic check + cascade loop; its only caller (`SessionActionLog.ts:582`) needs no change.
- Class 5 (file watcher) is already fixed in source; no code change required, only a VSIX rebuild note.

### Complex / Risky
- **Empty-`sessionId` landmine in the Class 4 fallback.** `getPlanBySessionId('')` matches a random empty-session plan (`LIMIT 1`); the proposed epic check there can cascade the *wrong* epic if not guarded. Must return `false` on empty `sessionId`.
- **`is_epic` stickiness contract.** The `CASE` fix makes `is_epic` non-clearable via `upsertPlans`; any future caller relying on `isEpic: 0` to demote will silently fail. Requires a documenting SQL comment and adherence to `updateEpicStatus` for demotion.
- **Mixed keying in completion paths.** `completePlan`/`completeAll` will mix plan_id-keyed cascade (`updateColumnWithEpicCascadeByPlanId`) with session_id-keyed (planId-fallback-assisted) `updateColumn`/`updateStatus` calls. Functional today (verified `updateColumn`/`updateStatus` route through `getPlanBySessionId` which has a planId fallback at lines 2564-2572), but reflects the incomplete `session_id`→`plan_id` migration.
- **Column-name validation gap.** Sibling methods (`updateColumnByPlanFile`, `updateColumn`) validate column names against `VALID_KANBAN_COLUMNS` / `SAFE_COLUMN_NAME_RE`; the existing `updateColumnWithEpicCascade` does not, and the new method inherits that gap. Custom (user-config) column names flow into SQL, so the new method should add the same guard.
- **Possible orphaning of `updateColumnTransaction`.** Removing the `moveCardToColumnByPlanFile` empty-session fallback branch removes its only known caller; verify no other callers, then deprecate if orphaned.
- **Class 6: agent-prompt SQL is a different fix category.** The embedded `sqlite3` statements (KanbanProvider.ts:3576/3619, agentPromptBuilder.ts:1118/1143) run inside autonomous agent prompts as raw shell commands — they bypass the DB layer entirely, so the new `updateColumnWithEpicCascadeByPlanId` method cannot help. Fixing them means editing prompt *text*, and the batch variant is `session_id IN (...)`-keyed (same zero-rows bug as Class 2 for file-based plans). These prompts are executed asynchronously by external agents with no validation layer, so a malformed or stale plan_id in the prompt string silently no-ops.
- **Class 6 atomicity gap.** The cascade-via-appended-UPDATE option runs as a *separate* `sqlite3` invocation from the epic's own UPDATE — there is no transaction spanning epic + subtasks across two shell commands. A crash between them orphans subtasks. The `WHERE epic_id = ?` form at least covers subtasks added after prompt generation, but is not transactional with the epic move.

## Edge-Case & Dependency Audit

**Race Conditions**
- *Pre-existing, inherited:* every epic-cascade path (`moveCardToColumn`, `moveCardToColumnByPlanFile`, `completeAll`, and the new `completePlan`/`completeSelected`/fallback fixes) reads subtasks via `getSubtasksByEpicId(plan.planId)` and then updates them in a separate call. A subtask added/removed between the read and the write (file watcher from another IDE, concurrent card creation) is missed or stale. The new method does not introduce this race; it copies the existing pattern. Optional mitigation: cascade via `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE epic_id = ? AND status = 'active'` inside the same transaction (atomic, no read-then-write). See User Review Required #4.
- The new method's own transaction (`BEGIN`/`COMMIT`) is atomic for the epic + listed subtasks; partial-failure rolls back. Same as existing method.
- *Class 6 specific:* agent-prompt SQL executes asynchronously, possibly long after prompt generation. By the time the agent runs the `sqlite3` command, the DB state may have changed (plan moved, subtask added/deleted). The `WHERE epic_id = ?` cascade form self-heals against subtask additions since prompt generation, but the epic's own UPDATE and the subtask UPDATE are two separate `sqlite3` invocations with no shared transaction — a crash between them orphans subtasks. Inherent to the raw-SQL-in-prompt design; cannot be fully closed without option (b) in User Review Required #5.

**Security**
- Column names are inserted into SQL strings via string interpolation (`WHERE plan_id IN (${placeholders})` is parameterized and safe; but the column value itself is bound as a parameter, which is safe). The real gap is *unvalidated custom column names* reaching `UPDATE plans SET kanban_column = ?` — parameterized, so not injectable, but a bogus column name can corrupt board state. Add `VALID_KANBAN_COLUMNS.has(newColumn) || SAFE_COLUMN_NAME_RE.test(newColumn)` guard to the new method to match `updateColumnByPlanFile` (line 1432).
- No credentials/secrets touched. No new logging of sensitive data.

**Side Effects**
- `is_epic` becomes sticky via upsert (see User Review Required #1). Affects every `upsertPlans` caller.
- Notion restore will now *preserve* local `is_epic` instead of clobbering to 0 (a behavior fix, not a regression — see User Review Required #2).
- `_updateRunSheet` (`TaskViewerProvider._updateRunSheet` → `_buildKanbanRecordFromSheet` → `upsertPlan`) no longer clobbers `is_epic` on every run-sheet update; verified `_buildKanbanRecordFromSheet` never sets `isEpic`.
- `moveCardToColumnByPlanFile`: removing the empty-session fallback branch means file-based epics now go through the plan_id cascade instead of `updateColumnByPlanFile` + `updateColumnTransaction`. Behavior improves (cascade now works).

**Dependencies & Conflicts**
- No data migration required. The Class 1 change is SQL-behavior-only; existing rows retain their `is_epic` values, and future upserts honor the new `CASE`. No `*.migrated.bak` handling needed (per CLAUDE.md migration policy, this is a behavior change to live SQL, not a schema/state migration).
- Class 5 (file watcher) uses `insertFileDerivedPlan` (its own SQL, line 1334-1348), **not** `UPSERT_PLAN_SQL`, and its ON CONFLICT clause does not touch `is_epic`; the watcher re-asserts `is_epic=1` via `updateEpicStatus` (line 618). Therefore the Class 1 fix does not interact with the watcher path. The two fixes are independent.
- Depends on the existing helpers `getPlanByPlanId` (line 2646), `getSubtasksByEpicId` (line 3795), `updateEpicStatus` (line 1468) — all verified present.

## Dependencies

None — self-contained fix. No prerequisite plans/sessions.

## Adversarial Synthesis

Key risks: (1) the Class 1 `CASE` makes `is_epic` sticky (cannot be cleared via `upsertPlans` — demotion must use `updateEpicStatus`); (2) the Class 4 fallback's `getPlanBySessionId('')` matches a random empty-session plan, so the proposed epic-check there can cascade the wrong epic unless empty `sessionId` is guarded; (3) the new cascade method lacks the column-name validation present in sibling methods, and inherits a benign read-then-write subtask race; (4) Class 6's agent-prompt SQL bypasses the DB layer entirely, is `session_id`-keyed (zero-rows for file-based plans), and cannot be made transactional across epic+subtask — the prompt-text fix only mitigates, and the cleaner option (route through a Switchboard skill) depends on agent-host capability. Mitigations: document stickiness in a SQL comment and route demotion through `updateEpicStatus`; guard empty `sessionId` in the fallback (return `false`); add `VALID_KANBAN_COLUMNS`/`SAFE_COLUMN_NAME_RE` validation to the new method; optionally replace the explicit `subtaskPlanIds[]` with an atomic `WHERE epic_id = ? AND status = 'active'` cascade; for Class 6 switch the batch prompt from `session_id IN` to `plan_id IN` and append a `WHERE epic_id = ?` subtask cascade (or adopt User Review Required #5 option (b)).

## Bug Classes Found

### Class 1: UPSERT_PLAN_SQL COALESCE clobbers is_epic to 0

**File:** `src/services/KanbanDatabase.ts` line 592

```sql
is_epic = COALESCE(excluded.is_epic, is_epic),
```

`upsertPlans` passes `record.isEpic ?? 0` (line 1281). When a caller doesn't explicitly set `isEpic: 1`, the value is `0` (not NULL). `COALESCE(0, 1)` returns `0`, clobbering `is_epic = 1` to `0`.

**Affected callers (any upsert that doesn't explicitly set isEpic: 1):**
- `TaskViewerProvider._updateRunSheet` (line 14795) — HIGH RISK: `_buildKanbanRecordFromSheet` (line 2309) never sets `isEpic` (verified: `baseRecord` at 2345-2365 omits it; the `preserveExistingFields` spread at 2372-2383 also omits it). Every run-sheet update clobbers the epic flag.
- `TaskViewerProvider._migrateLegacyTombstones` (line 12179) — explicitly sets `isEpic: 0`, but **only on the `if (!existing)` INSERT branch** (no conflict, so `is_epic=0` applies directly). The `else` branch uses `tombstonePlan` (dedicated UPDATE, line 3395, sets only `status='deleted'`). Verified safe under the new `CASE`.
- `TaskViewerProvider._addTombstone` (line 12227) — same pattern as above: `isEpic: 0` only on the no-existing-row INSERT branch; existing rows use `tombstonePlan`. Verified safe.
- `NotionBackupService.restoreFromNotion` (line 138) — **hidden current bug:** `_notionPageToPlanRecord` (line 456) never sets `isEpic`, so every Notion restore clobbers all existing epics to `is_epic=0` today. The fix *resolves* this (local `is_epic` preserved). Not a risk; a bonus fix.
- `KanbanProvider.reassignPlansWorkspace` (line 5236) — spreads existing plan (carries the real `isEpic` value), safe under both old and new SQL.
- `TaskViewerProvider._restoreFromArchive` (line 11622) — spreads existing plan, safe.
- `TaskViewerProvider._handleBrainPlanMetadataUpdate` (line 13310) — spreads existing plan, safe.

**Fix:** Change the conflict clause:
```sql
-- Before:
is_epic = COALESCE(excluded.is_epic, is_epic),
-- After:
-- is_epic is STICKY via upsert: once 1, it can only be cleared by updateEpicStatus(planId, 0, '').
-- Callers pass `record.isEpic ?? 0` (literal 0, never NULL), so COALESCE(0, is_epic) clobbered epics.
is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END,
```

This preserves the existing `is_epic` value unless the caller explicitly sets `isEpic: 1`. Callers that want to clear `is_epic` (tombstones) already use dedicated UPDATE statements (`tombstonePlan`, which only flips `status`) or can pass `isEpic: 0` through `updateEpicStatus` — never through `upsertPlans`.

### Class 2: updateColumnWithEpicCascade uses session_id instead of plan_id

**File:** `src/services/KanbanDatabase.ts` line 3826-3842

```sql
UPDATE plans SET kanban_column = ?, updated_at = ? WHERE session_id = ?
```

File-based epics have `session_id = ''`. The query matches zero rows. The method returns `true` regardless (no rows-affected check). The epic's column is NOT updated, but the caller thinks it succeeded.

Same bug in `updateColumnTransaction` (line 3812): `WHERE session_id IN (...)` — file-based subtasks also have `session_id = ''`, so subtask cascade fails too.

> **Verification note:** `updateColumn` (line 1461) and `updateStatus` (line 1654) are *also* `session_id`-keyed but route through `getPlanBySessionId`, which has a **planId fallback** (lines 2564-2572: if `session_id` lookup fails, it retries by `plan_id`). So `updateColumn(planId)` works for file-based plans. `updateColumnWithEpicCascade` and `updateColumnTransaction` have **no such fallback** — they are the genuinely broken methods. This is why `completePlan`/`completeAll` partially work (the `updateColumn`/`updateStatus` calls succeed via fallback) while the cascade silently no-ops.

**Affected callers:**
- `moveCardToColumn` (KanbanProvider.ts:4840) — passes `sessionId` (the epic's `session_id`, empty for file-based) and `subtasks.map(st => st.sessionId)` (empty for file-based subtasks).
- `moveCardToColumnByPlanFile` (KanbanProvider.ts:4905) — passes `previousRecord.sessionId || ''` (empty for file-based epics); its empty-string fallback branch (4904-4911) calls `updateColumnByPlanFile` + `updateColumnTransaction(subtaskSessionIds)`, the latter of which also fails on empty `session_id`.
- `completeAll` (KanbanProvider.ts:6750) — passes `cardKey` (= `_cardId(card)` = `card.planId || card.sessionId`, so `planId` for file-based) and `subtasks.map(st => st.sessionId)` (empty for file-based).

**Fix:** Add a new method `updateColumnWithEpicCascadeByPlanId` that uses `plan_id` instead of `session_id`, **with column-name validation** to match `updateColumnByPlanFile`:

```typescript
public async updateColumnWithEpicCascadeByPlanId(
    epicPlanId: string,
    subtaskPlanIds: string[],
    targetColumn: string
): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    // Validate column name (custom columns flow in from user config) — matches updateColumnByPlanFile.
    if (!VALID_KANBAN_COLUMNS.has(targetColumn) && !SAFE_COLUMN_NAME_RE.test(targetColumn)) {
        console.error(`[KanbanDatabase] updateColumnWithEpicCascadeByPlanId rejected invalid column: ${targetColumn}`);
        return false;
    }
    const now = new Date().toISOString();
    try {
        this._db.run('BEGIN');
        this._db.run(
            `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_id = ?`,
            [targetColumn, now, epicPlanId]
        );
        if (subtaskPlanIds.length > 0) {
            const placeholders = subtaskPlanIds.map(() => '?').join(',');
            this._db.run(
                `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_id IN (${placeholders})`,
                [targetColumn, now, ...subtaskPlanIds]
            );
        }
        this._db.run('COMMIT');
        await this._persist();
        return true;
    } catch (err) {
        try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
        console.error('[KanbanDatabase] updateColumnWithEpicCascadeByPlanId failed:', err);
        return false;
    }
}
```

> **Optional race-free variant (see User Review Required #4):** replace the `subtaskPlanIds` block with a single atomic `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE epic_id = ? AND status = 'active'` inside the same transaction, eliminating the read-then-write race in callers. The explicit-ID form above is the default to match existing call sites.

Then update all 3 callers to use `plan_id` instead of `session_id`:
- `moveCardToColumn`: use `plan.planId` and `subtasks.map(st => st.planId).filter(Boolean)`
- `moveCardToColumnByPlanFile`: use `previousRecord.planId` and `subtasks.map(st => st.planId).filter(Boolean)`. Remove the `epicSessionId` empty-string fallback branch (4904-4911). **Then verify `updateColumnTransaction` has no remaining callers; if orphaned, mark `@deprecated`.**
- `completeAll`: use `card.planId` and `subtasks.map(st => st.planId).filter(Boolean)`

### Class 3: completePlan and completeSelected bypass epic cascade

**File:** `src/services/KanbanProvider.ts`

- `completePlan` (line 6688): calls `db.updateColumn(resolvedSessionId, 'COMPLETED')` directly
- `completeSelected` (line 6707): calls `db.updateColumn(sessionId, 'COMPLETED')` directly

Neither checks `plan.isEpic` or cascades subtasks. An epic completed via the card's "Done" button or via "Complete Selected" will move to COMPLETED (via `updateColumn`'s planId fallback) but its subtasks stay in their current column.

**Fix:** Both handlers should check `isEpic` and cascade, mirroring `completeAll` (line 6747-6752):

```typescript
// completePlan fix (line 6688):
const plan = await db.getPlanByPlanId(resolvedSessionId) ?? await db.getPlanBySessionId(resolvedSessionId);
if (plan && plan.isEpic) {
    const subtasks = await db.getSubtasksByEpicId(plan.planId);
    const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean) as string[];
    await db.updateColumnWithEpicCascadeByPlanId(plan.planId, subtaskPlanIds, 'COMPLETED');
} else {
    await db.updateColumn(resolvedSessionId, 'COMPLETED');
}
```

> **Note:** `db.updateColumn` / `db.updateStatus` below remain session_id-keyed but work for planId inputs via the `getPlanBySessionId` planId fallback (lines 2564-2572). The lookup `getPlanByPlanId(resolvedSessionId) ?? getPlanBySessionId(resolvedSessionId)` is slightly redundant (the second already falls back to planId) but is clearer and harmless. `resolvedSessionId = _resolveSessionId(msg.planId, msg.sessionId)` returns `sessionId if present else planId` (line 375).

Same pattern for `completeSelected` — loop through sessionIds, check each for isEpic, cascade if needed.

### Class 4: _updateKanbanColumnForSession fallback bypasses epic cascade

**File:** `src/services/TaskViewerProvider.ts` line 2250-2258

```typescript
private async _updateKanbanColumnForSession(workspaceRoot, sessionId, column): Promise<boolean> {
    const db = await this._getKanbanDb(workspaceRoot);
    if (!db) return false;
    if (this._kanbanProvider) {
        return this._kanbanProvider.moveCardToColumn(workspaceRoot, sessionId, column);
    }
    // FALLBACK: direct DB update without epic check
    return db.updateColumn(sessionId, column);
}
```

When `_kanbanProvider` is null (rare but possible during teardown or race conditions), the fallback calls `db.updateColumn` directly — no epic check, no subtask cascade. **Worse:** for file-based plans the callers pass `sessionId = ''`, and `db.updateColumn('')` → `getPlanBySessionId('')` → `WHERE session_id = '' LIMIT 1` matches an **arbitrary** empty-session plan, moving the wrong card. The fix must guard this.

**Affected callers (verified via grep — corrected line numbers):**
- `dispatchConfiguredKanbanColumnAction` (line 3012) — passes `plan.sessionId`
- `_applyManualKanbanColumnChange` (line 3234) — passes `sessionId`
- (line 3437) — passes `plan.sessionId`
- (line 15766) — jules role dispatch, passes `sessionId`
- `_handleTriggerAgentActionInternal` (line 15888) — sidebar agent dispatch, passes `sessionId`
- (lines 15911, 15921) — rollback paths, pass `sessionId`

> **Correction:** the original plan listed lines 3128 and 3353, which do not exist as callers. The actual call sites are 3012, 3234, 3437, 15766, 15888, 15911, 15921.

**Fix:** Add epic cascade to the fallback path **and guard empty sessionId**:

```typescript
// Fallback: direct DB update with epic check.
// Guard: an empty sessionId (file-based plan) would make getPlanBySessionId('') match a
// random empty-session plan (WHERE session_id='' LIMIT 1). Refuse to guess — return false.
if (!sessionId) return false;
const plan = await db.getPlanBySessionId(sessionId) ?? await db.getPlanByPlanId(sessionId);
if (plan && plan.isEpic) {
    const subtasks = await db.getSubtasksByEpicId(plan.planId);
    const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean) as string[];
    return db.updateColumnWithEpicCascadeByPlanId(plan.planId, subtaskPlanIds, column);
}
return db.updateColumn(sessionId, column);
```

### Class 5: File watcher race condition (ALREADY FIXED IN SOURCE)

**File:** `src/services/GlobalPlanWatcherService.ts` line 610

**Status:** Fixed in source code (unconditional `updateEpicStatus` for epic files at line 617-618). Verified: the watcher uses `insertFileDerivedPlan` (line 576/609), whose own ON CONFLICT clause (line 1334-1348) does **not** touch `is_epic`, and re-asserts `is_epic=1` via `updateEpicStatus` unconditionally for files under `.switchboard/epics/`. The comment at lines 610-616 documents why the unconditional form is required (atomic temp+rename writes can delete the row between fetch and insert).

Not yet deployed — the running extension still has the old code.

**Note:** This fix only takes effect after the extension is recompiled and reinstalled as a VSIX. Until then, editing epic files with external tools will continue to clobber `is_epic` to 0 in the running build. No code change is needed in this plan; the VSIX rebuild is covered by the project's normal release flow.

### Class 6: Agent-prompt SQL bypasses the DB layer, cascade, AND fails for file-based plans

> **Found in follow-up sweep — missed by the original 5-class audit.** The original audit scoped itself to "card move path, upsert path, and file watcher path" but never swept the **agent-prompt SQL path**: SQL embedded in prompts that coding/scheduler agents execute directly via the `sqlite3` CLI, completely bypassing `KanbanDatabase`. This is the most severe missed class because it is both `session_id`-broken (like Class 2) *and* cascade-less, and the planned DB-method fix cannot reach it.

**Files:**
- `src/services/KanbanProvider.ts` line 3576-3577 — batch scheduler prompt: `UPDATE plans SET kanban_column = '${resolvedNextColumn}', updated_at = datetime('now') WHERE session_id IN (${batchPlans.map(p => `'${p.sessionId}'`).join(', ')}) AND workspace_id = '${workspaceId}';`. **`session_id`-keyed → file-based epics/subtasks (`session_id=''`) match ZERO rows**, and there is no epic cascade even when it does match. Identical root cause to Class 2, but unreachable by the planned `updateColumnWithEpicCascadeByPlanId` method.
- `src/services/KanbanProvider.ts` line 3619-3620 — single-plan scheduler prompt: `WHERE plan_file = '${oldestPlan.planFile}' AND workspace_id = '${workspaceId}';`. Works for the plan itself, but **no epic cascade** — moving an epic via the scheduler orphans its subtasks.
- `src/services/agentPromptBuilder.ts` line 1117-1118 (and the duplicate at 1143) — Split Plan agent prompt: `WHERE plan_file = '<relative_path>' AND workspace_id = '$WORKSPACE_ID';`, no cascade.

**Affected callers:** any autonomous agent (Splitter, scheduler, lead/coder) that consumes one of the above prompts and runs the embedded `sqlite3` command. These are not in-process code paths — they execute in an external agent host against the live `kanban.db`.

**Fix (default — option (a) in User Review Required #5):** edit the prompt text in all three sites:
1. **Batch variant (3576):** switch `WHERE session_id IN (...)` to `WHERE plan_id IN (...)` using `batchPlans.map(p => `'${p.planId}'`)`, so file-based plans match.
2. **Single + batch variants (3576, 3619, 1118, 1143):** after the epic's own UPDATE, append a subtask-cascade UPDATE guarded by an epic check. The cleanest prompt-embeddable form is conditional SQL:

```bash
# After moving a plan that may be an epic, cascade its subtasks:
sqlite3 "$DB_PATH" "UPDATE plans SET kanban_column = '${TARGET_COLUMN}', updated_at = datetime('now') WHERE epic_id = (SELECT plan_id FROM plans WHERE plan_file = '<relative_path>' AND workspace_id = '$WORKSPACE_ID') AND status = 'active'; SELECT changes();"
```

   For the batch variant, loop the same per-plan or use `WHERE epic_id IN (SELECT plan_id FROM plans WHERE plan_file IN (...))`. The `WHERE epic_id = (subquery)` form self-heals against subtasks added after prompt generation (see Race Conditions note).

> **Alternative (option (b) in User Review Required #5):** replace the raw SQL block with an instruction to call the `kanban_operations` skill's move-card, routing the move through the validated DB layer (which then handles cascade + validation). Cleaner and transactional, but requires the agent host to have the Switchboard skill available.

**Edge Cases:** prompt SQL is async and non-transactional across the two `sqlite3` invocations (epic UPDATE + subtask UPDATE) — a crash between them orphans subtasks. Inherent to the design; option (b) closes it.

### Class 7: Direct `db.updateColumn` calls in webview handlers skip epic cascade

> **Found in follow-up sweep — missed by the original 5-class audit.** Same shape as the original Class 3/4, but in handlers the audit never listed. These *are* fixable by the planned `updateColumnWithEpicCascadeByPlanId` method + the same epic-check pattern.

**Files:** `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`

- `KanbanProvider.ts` line 6787-6788 — `uncompleteCard` ("Recover" from COMPLETED): `db.updateColumn(sessionId, targetColumn)`. Recovering an epic doesn't pull subtasks back. Plus its rollback at 6797-6798 (`db.updateColumn(sessionId, 'COMPLETED')`).
- `KanbanProvider.ts` line 7074-7075 — `testingFailureReport` moves cards to `LEAD CODED` via direct `db.updateColumn`. An epic sent back for fixes orphans its subtasks.
- `TaskViewerProvider.ts` line 11630-11634 — `_restoreFromArchive` **no-provider fallback**: `db.updateColumn(sessionId, 'CREATED')`. (The non-fallback path at 11631 uses `moveCardToColumn`, which cascades — so only the fallback is broken, exactly mirroring Class 4.)
- `TaskViewerProvider.ts` line 14055-14059 — `markPlanComplete` **no-provider fallback**: `db.updateColumn(sessionId, 'COMPLETED')`. (Non-fallback at 14056 uses `moveCardToColumn`.)

**Fix:** Apply the same epic-check-then-cascade pattern used in Classes 3/4:

```typescript
// Generic helper shape (apply at each site):
const plan = await db.getPlanBySessionId(sessionId) ?? await db.getPlanByPlanId(sessionId);
if (plan && plan.isEpic) {
    const subtasks = await db.getSubtasksByEpicId(plan.planId);
    const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean) as string[];
    await db.updateColumnWithEpicCascadeByPlanId(plan.planId, subtaskPlanIds, targetColumn);
} else {
    await db.updateColumn(sessionId, targetColumn);
}
```

For the `TaskViewerProvider` no-provider fallbacks (11633, 14058), also apply the empty-`sessionId` guard from Class 4 (`if (!sessionId) return false;`) since those callers may pass `''` for file-based plans.

> **Note:** `uncompleteCard` (6769) and its handler were not in the original plan's caller enumeration. The original `completeAll` comment at 6745 even references "A direct db.updateColumn would orphan subtasks" — the codebase authors knew the pattern, but these four sites still have the bug.

### Class 8: `completeMultipleByPlanFile` batch-complete has no epic cascade

> **Found in follow-up sweep — missed by the original 5-class audit.** A batch-complete DB method with no epic check/cascade.

**File:** `src/services/KanbanDatabase.ts` line 2876-2897

```typescript
public async completeMultipleByPlanFile(entries: Array<{ planFile: string; workspaceId: string }>): Promise<boolean> {
    // ... loops entries, runs: UPDATE plans SET status='completed', kanban_column='COMPLETED' WHERE plan_file=? AND workspace_id=?
    // No epic check, no subtask cascade.
}
```

**Live caller:** `src/services/SessionActionLog.ts` line 581-582 — fires when a run sheet's `completed` flag flips `true` (e.g. an agent marks a sheet done via the run-sheet editor). If that sheet is an epic, its subtasks never cascade to COMPLETED.

> **Note:** the sibling `completeMultiple` (line 2900, `@deprecated`, session_id-keyed) has the same gap but has **no live callers** (verified via grep — only the two `KanbanDatabase.ts` definition matches; `completeMultipleByPlanFile` is the live one).

**Fix:** Inside `completeMultipleByPlanFile`, after each plan's row update, check `isEpic` and cascade subtasks within the same transaction:

```typescript
for (const { planFile, workspaceId } of entries) {
    const normalized = this._ensureRelativePlanFile(planFile);
    this._db.run(
        'UPDATE plans SET status = ?, kanban_column = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
        ['completed', 'COMPLETED', now, normalized, workspaceId]
    );
    // Cascade: if this plan is an epic, complete its active subtasks too.
    const stmt = this._db.prepare(
        `SELECT plan_id, is_epic FROM plans WHERE plan_file = ? AND workspace_id = ? LIMIT 1`,
        [normalized, workspaceId]
    );
    let isEpic = false; let epicPlanId = '';
    try { if (stmt.step()) { const r = stmt.getAsObject(); isEpic = !!Number(r.is_epic); epicPlanId = String(r.plan_id); } } finally { stmt.free(); }
    if (isEpic && epicPlanId) {
        this._db.run(
            `UPDATE plans SET status = 'completed', kanban_column = 'COMPLETED', updated_at = ? WHERE epic_id = ? AND status = 'active'`,
            [now, epicPlanId]
        );
    }
}
```

The caller (`SessionActionLog.ts:582`) needs no change — the cascade is internal to the DB method. Using `WHERE epic_id = ? AND status = 'active'` (vs. explicit IDs) keeps it atomic within the existing `BEGIN`/`COMMIT` and race-free.

## Proposed Changes

### `src/services/KanbanDatabase.ts`
- **Context:** Central DB layer, mid-migration from `session_id` to `plan_id` keying.
- **Logic:**
  1. Line 592: replace `is_epic = COALESCE(excluded.is_epic, is_epic),` with the `CASE WHEN excluded.is_epic > 0 ...` form **plus the stickiness comment**. (Class 1)
  2. After line 3851: add `updateColumnWithEpicCascadeByPlanId` (plan_id-keyed, column-validated, transactional). (Class 2)
  3. `completeMultipleByPlanFile` (2876-2897): add epic check + `WHERE epic_id = ? AND status = 'active'` subtask cascade inside the existing transaction loop. (Class 8)
- **Implementation:** See code blocks in Class 1, Class 2, and Class 8 above.
- **Edge Cases:** `is_epic` stickiness (documented); column-name validation added; `updateColumnTransaction` may become orphaned (verify + deprecate); Class 8 cascade is atomic within the existing `BEGIN`/`COMMIT`.

### `src/services/KanbanProvider.ts`
- **Context:** Webview message handlers + card-move orchestration + scheduler prompt generation.
- **Logic:**
  1. `moveCardToColumn` (4836-4840): switch to `updateColumnWithEpicCascadeByPlanId` with `plan.planId` + `subtasks.map(st => st.planId)`. (Class 2)
  2. `moveCardToColumnByPlanFile` (4900-4911): switch to `updateColumnWithEpicCascadeByPlanId` with `previousRecord.planId` + `subtasks.map(st => st.planId)`; remove the `epicSessionId` empty-string fallback branch. (Class 2)
  3. `completePlan` (6688-6696): add epic check + cascade before `db.updateColumn`. (Class 3)
  4. `completeSelected` (6707-6714): add epic check + cascade in the loop. (Class 3)
  5. `completeAll` (6747-6752): switch to `updateColumnWithEpicCascadeByPlanId` with `card.planId` + `subtasks.map(st => st.planId)`. (Class 2)
  6. `uncompleteCard` (6787-6788) + rollback (6797-6798): add epic check + cascade (recover epic pulls subtasks back; rollback re-cascades to COMPLETED). (Class 7)
  7. `testingFailureReport` (7074-7075): add epic check + cascade when moving to `LEAD CODED`. (Class 7)
  8. Scheduler prompt SQL (3576-3577, 3619-3620): switch batch `session_id IN` → `plan_id IN`; append `WHERE epic_id = (subquery)` subtask-cascade UPDATE to both. (Class 6)
- **Implementation:** See code blocks in Class 2, Class 3, Class 6, and Class 7 above.
- **Edge Cases:** `updateStatus`/`updateColumn` still session_id-keyed (work via planId fallback); mixed keying is functional but note in code comments; Class 6 prompt SQL is async/non-transactional (see Race Conditions).

### `src/services/TaskViewerProvider.ts`
- **Context:** Sidebar/agent dispatch + manual column-change commands.
- **Logic:**
  1. `_updateKanbanColumnForSession` (2250-2258): add empty-sessionId guard + epic cascade to the no-provider fallback path. (Class 4)
  2. `_restoreFromArchive` fallback (11633): add empty-sessionId guard + epic cascade (non-fallback at 11631 already uses `moveCardToColumn`). (Class 7)
  3. `markPlanComplete` fallback (14058): add empty-sessionId guard + epic cascade (non-fallback at 14056 already uses `moveCardToColumn`). (Class 7)
- **Implementation:** See code blocks in Class 4 and Class 7 above.
- **Edge Cases:** Empty `sessionId` returns `false` (no-op) rather than moving a random empty-session plan; verified `_updateKanbanColumnForSession` caller lines are 3012, 3234, 3437, 15766, 15888, 15911, 15921.

### `src/services/GlobalPlanWatcherService.ts`
- **Already fixed** (line 610/617-618): no code change. (Class 5)

### `src/services/agentPromptBuilder.ts`
- **Context:** Split Plan agent prompt generation — embedded `sqlite3` column-move instructions.
- **Logic:** Lines 1117-1118 and 1143: append the `WHERE epic_id = (SELECT plan_id FROM plans WHERE plan_file = ...) AND status = 'active'` subtask-cascade UPDATE after the epic's own UPDATE. (Class 6)
- **Implementation:** See Class 6 code block above (same `sqlite3` template as the scheduler prompt).
- **Edge Cases:** Async/non-transactional across the two `sqlite3` invocations (inherent to prompt-SQL design; option (b) in User Review Required #5 closes it if adopted).

### `src/services/SessionActionLog.ts`
- **No code change.** Documented here because it is the sole live caller of `completeMultipleByPlanFile` (line 582); the Class 8 fix is internal to the DB method, so this caller inherits the cascade automatically.

### `src/services/NotionBackupService.ts`
- **No code change.** Documented here because the Class 1 fix incidentally corrects a hidden bug: `restoreFromNotion` (line 138) no longer clobbers `is_epic` to 0 on restore (Notion backup does not capture `is_epic`; local value is now preserved).

## Verification Plan

> Per session directives: **skip project compilation** (`npm run compile` / `tsc`) and **skip automated tests** — the test suite will be run separately by the user. The checks below describe the manual/functional verification the user should perform after implementation.

### Automated Tests
- *(Skipped this session per directive. The user will run the suite separately. Suggested coverage below for when they do.)*
- Unit: `updateColumnWithEpicCascadeByPlanId` moves epic + listed subtasks by `plan_id`; rejects invalid column names; rolls back on error.
- Unit: `UPSERT_PLAN_SQL` with `isEpic=undefined`/`0` preserves existing `is_epic=1`; with `isEpic=1` sets it; cannot clear via upsert.
- Unit: `completeMultipleByPlanFile` cascades subtasks of an epic entry to COMPLETED within the same transaction; non-epic entries get no cascade. (Class 8)
- Integration: epic drag/complete cascades file-based (empty `session_id`) subtasks.

### Epic column move tests (manual)
- Drag epic from CREATED to PLAN REVIEWED → epic + all subtasks move, epic badge persists
- Drag epic from PLAN REVIEWED to CODE REVIEWED → same
- Drag epic backward from CODE REVIEWED to PLAN REVIEWED → same
- Click "Done" on epic card → epic + all subtasks move to COMPLETED
- Select epic + click "Complete Selected" → same
- Click "Complete All" in a column with an epic → same
- Use command palette "Forward Move" on epic → same
- Use command palette "Backward Move" on epic → same
- Agent dispatch (sidebar) that moves an epic with `_kanbanProvider` momentarily null → epic + subtasks cascade (or safely no-op if `sessionId` empty)
- Recover an epic from COMPLETED ("uncompleteCard") → epic + all subtasks move back together (Class 7)
- Rollback of a failed epic recovery → epic + subtasks re-cascade to COMPLETED (Class 7)
- "Testing failure report" on an epic → epic + subtasks move to LEAD CODED together (Class 7)
- Restore an epic from archive with `_kanbanProvider` null → epic + subtasks move to CREATED (Class 7)
- Mark an epic complete via run-sheet editor with `_kanbanProvider` null → epic + subtasks complete (Class 7)
- Scheduler agent processes an epic (file-based, `session_id=''`) → epic moves (batch `plan_id IN` variant now matches); subtasks cascade (Class 6)
- Split Plan agent on an epic → epic's subtasks follow the column move (Class 6)
- Mark an epic done via the run-sheet `completed` flip → epic + active subtasks complete in one transaction (Class 8)

### is_epic persistence tests (manual)
- Edit epic file with external tool → epic badge persists (after VSIX rebuild — Class 5)
- Run `upsertPlans` with a record that has `isEpic: undefined` for an existing epic → `is_epic` stays 1
- Run `upsertPlans` with a record that has `isEpic: 0` for an existing epic → `is_epic` stays 1 (the `CASE` preserves it; demotion requires `updateEpicStatus`)
- Run `upsertPlans` with a record that has `isEpic: 1` → `is_epic` becomes 1 (explicit set still works)
- Notion restore over a workspace with existing epics → epics retain `is_epic=1` (no longer clobbered)

### Subtask cascade tests (manual)
- Move epic with subtasks that have `session_id = ''` → subtasks still move (plan_id-based cascade)
- Move epic with subtasks that have `session_id` set → subtasks still move
- Complete epic with mixed subtask session_ids → all subtasks complete

### Non-epic regression tests (manual)
- Move a non-epic plan → moves correctly, no cascade
- Complete a non-epic plan → completes correctly
- Upsert a non-epic plan → `is_epic` stays 0
- `_updateKanbanColumnForSession` fallback with empty `sessionId` → returns `false`, no wrong-plan write

## Recommendation

Complexity 7 (High: multi-file coordination across DB + 3 providers + agent-prompt text, with the Class 6 prompt-SQL category being a distinct fix kind and the empty-`sessionId` / stickiness / atomicity risks) → **Send to Lead Coder**. The implementer must honor the User Review Required decisions (especially #3 the empty-`sessionId` guard, #1 the stickiness comment, and #5 the Class 6 prompt-SQL strategy) before merging. Classes 1-5 and 7-8 are code-level and share the cascade mechanism; Class 6 is prompt-text and needs separate care.

---

## Reviewer Pass (in-place review, executed 2026-06-27)

Implementation verified present for all 8 bug classes against source. Stage 1 adversarial review + Stage 2 synthesis + code fixes applied. Existing implementation steps above are preserved unchanged.

### Stage 1 — Grumpy Principal Engineer findings (severity-tagged)

- **MAJOR — Class 6 `SELECT changes()` is a filthy liar after the cascade append.** `src/services/KanbanProvider.ts:3576,3619`; `src/services/agentPromptBuilder.ts:1118,1143`. The fix tacked a second `UPDATE ... WHERE epic_id = ... AND status = 'active'` onto each prompt's single `sqlite3` invocation but left `SELECT changes();` at the end. `changes()` returns rows from the MOST RECENTLY completed statement — i.e. the subtask cascade, NOT the epic's own move. So: a non-epic that moved perfectly (epic UPDATE=1, cascade UPDATE=0) reports `0`, and the prompt then instructs the autonomous agent to "notify the user to manually drag the card to the Planned column" — for a card that already moved. A theater of false negatives, acted out by a headless agent at 3am. An epic with 3 subtasks reports `3`, and the verification text (which only defined "1" and "0") leaves the agent with no branch. The plan added the cascade but never updated the verification semantics to account for the second statement. Direct regression introduced by the Class 6 fix.
- **NIT — Orphaned `updateColumnWithEpicCascade` left without a toe tag.** `src/services/KanbanDatabase.ts:3843`. The plan loudly deprecates `updateColumnTransaction` (its sibling) the instant it's orphaned, and grep confirms zero callers. But the OLD session_id-keyed `updateColumnWithEpicCascade` is now ALSO orphaned — all 3 callers defected to `updateColumnWithEpicCascadeByPlanId` — and it got no `@deprecated` tag. A future contributor reaching for "the epic cascade method" by name picks the session_id-keyed one and silently no-ops every file-based epic. The plan demanded symmetry for the sibling; it owed the same courtesy here.
- **OBSERVATION (out of scope, NOT fixed) — NotionBackupService restore doesn't cascade.** `src/services/NotionBackupService.ts:141`. `kanbanDb.updateColumn(sessionId, column)` on Notion restore is the same epic-agnostic shape as Class 7, but the plan explicitly scoped Notion out (User Review Required #2 — is_epic capture "out of scope here"). Notion restore is a rare manual bulk replace, not a pipeline card move, and subtask relationships may not be coherent in the remote backup. Documented as a remaining risk; not fixed (would expand scope + require the deferred Notion-restore semantic decision).
- **OBSERVATION (pre-existing, NOT fixed) — subtask `status` not cascaded by Class 3/7.** Class 8 cascades BOTH `status='completed'` AND `kanban_column='COMPLETED'` for subtasks (`KanbanDatabase.ts:2901`), but Class 3 (`completePlan`/`completeSelected`/`completeAll`) and Class 7 only cascade `kanban_column`, leaving subtask `status='active'`. This mirrors the PRE-EXISTING `completeAll` behavior the plan told Class 3 to copy, so it is not a regression — but it is an inconsistency: a subtask completed via run-sheet flip (Class 8) ends up `status='completed'`, while one completed via the card Done button (Class 3) ends up `column=COMPLETED` + `status='active'`. A later Class 6 prompt cascade (`WHERE epic_id = ? AND status = 'active'`) would then re-yank that "completed" subtask on the next epic move. Latent; deferred to a future plan.

### Stage 2 — Balanced synthesis

- **Fix now (MAJOR):** swap `SELECT changes()` → `SELECT total_changes()` in all 4 Class 6 prompt sites and update the verification text to `>= 1` / "at least one row" semantics. `total_changes()` returns the sum of both UPDATEs since connection open (non-epic moved = 1; epic + N subtasks = 1 + N; nothing moved = 0), which restores correct success/failure detection without altering the cascade logic. Low-risk, surgical, fully within the spirit of the Class 6 fix — the plan simply didn't track the verification consequence of appending a second statement.
- **Fix now (NIT):** add `@deprecated` to the orphaned `updateColumnWithEpicCascade`. Zero-risk symmetry with the sibling deprecation; closes a latent footgun. Trivial.
- **Defer (OBSERVATION 3 & 4):** Notion restore cascade and subtask-`status` cascade. Both are outside the plan's explicit scope, both require separate semantic decisions, neither is a regression. Documented as remaining risks below; code untouched.

### Code fixes applied

1. `src/services/agentPromptBuilder.ts:1118,1144` — `SELECT changes();` → `SELECT total_changes();`; verification text rewritten to "total_changes() returns the sum of BOTH updates … If output is 0: … If output is >= 1: success (the plan moved; if it is an epic, its active subtasks moved too)". (Both Split-Plan prompt sites, via replace_all.)
2. `src/services/KanbanProvider.ts:3576` — scheduler batch prompt: `SELECT changes();` → `SELECT total_changes();`; verification text rewritten to "at least the number of plans moved … If it is `0`, no rows matched — check that the plan_ids and workspace_id are correct."
3. `src/services/KanbanProvider.ts:3619` — scheduler single-plan prompt: `SELECT changes();` → `SELECT total_changes();`; verification text rewritten to "`>= 1` (total_changes() sums BOTH the plan's own move and any cascaded epic subtasks, so an epic with subtasks reports more than 1). If it is `0`, the plan_file path may not match …".
4. `src/services/KanbanDatabase.ts:3842` — added `@deprecated` JSDoc to the orphaned session_id-keyed `updateColumnWithEpicCascade`, mirroring the sibling `updateColumnTransaction` deprecation and pointing callers to `updateColumnWithEpicCascadeByPlanId`.

### Verification (this session)

Per session directives: **project compilation (`npm run compile` / `tsc` / webpack) and automated tests were SKIPPED** — the test suite will be run separately by the user.

- Static verification performed: grep-confirmed all 4 Class 6 prompt sites now emit `SELECT total_changes()` and no `SELECT changes()` remains in `src/services/` (`KanbanProvider.ts:3576,3619`; `agentPromptBuilder.ts:1118,1144`).
- Template-literal integrity: the JS template-literal escapes for the prompts' own backticks (`\`\`\`bash` fences, `${...}` interpolations) are preserved unchanged around the edited `sqlite3` lines; only the trailing `; SELECT changes();` → `; SELECT total_changes();` and the adjacent verification prose were modified.
- Pre-existing implementation re-verified present and correct against plan requirements:
  - Class 1 — `KanbanDatabase.ts:592-594` `CASE WHEN excluded.is_epic > 0 ...` + stickiness comment. ✓
  - Class 2 — `updateColumnWithEpicCascadeByPlanId` (`KanbanDatabase.ts:3876-3909`, column-validated, transactional); all 3 callers (`moveCardToColumn:4842`, `moveCardToColumnByPlanFile:4908`, `completeAll:6764`) switched to `plan_id`; `updateColumnTransaction` deprecated (`3820`); empty-session fallback branch removed. ✓
  - Class 3 — `completePlan:6694-6698` and `completeSelected:6720-6724` epic-check-then-cascade. ✓
  - Class 4 — `_updateKanbanColumnForSession` fallback (`TaskViewerProvider.ts:2252-2265`) with empty-`sessionId` guard + epic cascade. ✓
  - Class 5 — `GlobalPlanWatcherService.ts:610-620` unconditional `updateEpicStatus` + explanatory comment (already in source; VSIX rebuild still required for running installs). ✓
  - Class 6 — batch `plan_id IN` + `epic_id IN (...)` cascade (`KanbanProvider.ts:3576`); single + Split-Plan `epic_id = (SELECT plan_id ...)` cascade (`KanbanProvider.ts:3619`, `agentPromptBuilder.ts:1118,1144`). ✓ (plus the `total_changes()` fix above)
  - Class 7 — `uncompleteCard` + rollback (`KanbanProvider.ts:6798-6829`), `testingFailureReport` (`7108-7114`), `_restoreFromArchive` fallback (`TaskViewerProvider.ts:11642-11651`), `markPlanComplete` fallback (`14075-14084`); TaskViewerProvider fallbacks carry the empty-`sessionId` guard. ✓
  - Class 8 — `completeMultipleByPlanFile` (`KanbanDatabase.ts:2878-2913`) epic check + `WHERE epic_id = ? AND status = 'active'` cascade inside the existing `BEGIN`/`COMMIT`; caller `SessionActionLog.ts:582` unchanged. ✓
  - NotionBackupService — no `isEpic`/`is_epic` references (grep-confirmed); Class 1 `CASE` incidentally preserves local `is_epic` on restore. ✓ (no code change, as planned)
- Helper dependency check: `getSubtasksByEpicId` (`3811`), `getPlanByPlanId` (`2648`), `updateEpicStatus` (`1470`), `VALID_KANBAN_COLUMNS` (`631`), `SAFE_COLUMN_NAME_RE` (`638`) all present; `VALID_KANBAN_COLUMNS` contains every column the new method receives (CREATED/COMPLETED/LEAD CODED/CODE REVIEWED/PLAN REVIEWED), so validation never rejects a legitimate move. ✓
- Caller-sweep check: no remaining callers of the old session_id-keyed `updateColumnWithEpicCascade` or `updateColumnTransaction` in `src/` (grep-confirmed). ✓

### Files changed by this review pass

- `src/services/agentPromptBuilder.ts` (lines 1118-1121, 1144-1147) — Class 6 verification fix (2 sites).
- `src/services/KanbanProvider.ts` (lines 3576-3579, 3619-3622) — Class 6 verification fix (2 sites).
- `src/services/KanbanDatabase.ts` (line 3842) — `@deprecated` tag on orphaned `updateColumnWithEpicCascade`.

### Remaining risks

1. **Notion restore does not cascade epic subtasks** (`NotionBackupService.ts:141`). Same shape as Class 7 but explicitly scoped out by User Review Required #2. A future plan should decide whether Notion restore should cascade (and whether Notion backup should capture `is_epic` / `epic_id` to make subtask relationships coherent in the remote backup).
2. **Subtask `status` field is not cascaded by Class 3/7** (only `kanban_column`). Pre-existing (mirrors old `completeAll`), not a regression, but inconsistent with Class 8 (which cascades both). A subtask completed via the card Done button has `column=COMPLETED` + `status='active'`, so a later Class 6 prompt cascade (`WHERE epic_id = ? AND status = 'active'`) could re-yank it on the next epic move. A future plan should align all completion paths on cascading both `status` and `kanban_column` for subtasks.
3. **Class 6 atomicity gap (unchanged, inherent).** The epic's own UPDATE and the subtask-cascade UPDATE are two statements inside one `sqlite3` invocation — SQLite wraps them in an implicit transaction per the CLI, but a crash mid-invocation can still orphan subtasks. `total_changes()` does not change this; only User Review Required #5 option (b) (route through the Switchboard skill / validated DB layer) closes it.
4. **Read-then-write subtask race (inherited, unchanged).** The explicit-`subtaskPlanIds[]` form (Class 2/3/7) reads subtasks via `getSubtasksByEpicId` then updates them in a separate call; a subtask added/removed between read and write is missed. Class 8 uses the atomic `WHERE epic_id = ?` form and is race-free. User Review Required #4 (switch Class 2/3/7 to the `WHERE epic_id = ?` form) remains open.
5. **`is_epic` stickiness contract (intentional).** `upsertPlans` can no longer clear `is_epic` to 0 (the `CASE` preserves it); demotion must go through `updateEpicStatus(planId, 0, '')`. Documented in the SQL comment (`KanbanDatabase.ts:592-593`); future callers must honor it.
6. **VSIX rebuild still required for Class 5.** The file-watcher fix is in source but not yet in running installs; editing epic files with external tools will continue to clobber `is_epic` to 0 in the running build until the extension is recompiled and reinstalled. Covered by the normal release flow.

