# Fix: Epic Column Clobbered to CREATED by File-Watcher Re-INSERT

## Goal

When an epic is created from subtasks that are all in `PLAN REVIEWED`, the epic should land in `PLAN REVIEWED` (the least-advanced subtask's column). Instead it ends up in `CREATED`, so the epic card — and the group of plans it represents — appears dragged back to the start of the board. The defect is that **being a new epic file forces the column to `CREATED`**, overriding the column that was already correctly resolved from the subtasks.

### Problem (the observed bug)

- Create an epic from a set of subtasks that all sit in `PLAN REVIEWED`.
- Expected: epic card appears in `PLAN REVIEWED`.
- Actual: epic card appears in `CREATED`.
- Because epic↔subtask columns are coupled on moves (`updateColumnWithEpicCascadeByPlanId`, `KanbanDatabase.ts` line 3826 — "an epic's subtasks always share its column on every move"), an epic sitting in `CREATED` also visually regresses the whole group. The user perceives this as "dragged all the plans back."

### Background — the resolution model is already correct

The epic's column is defined as the **least-advanced subtask's column** (minimum ordinal / weakest-link): an epic is only as far along as its least-complete subtask. If all subtasks are in `PLAN REVIEWED`, the epic is in `PLAN REVIEWED`; if even one subtask is still in `CREATED`, the epic stays in `CREATED`.

This is **already implemented correctly** in `createEpicFromPlanIds` (`KanbanProvider.ts` lines 8609-8613):

```typescript
const resolvedColumn = subtasks
     .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
     .filter((col: string | null): col is string => !!col)
     .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || this._normalizeLegacyKanbanColumn(subtasks[0].kanbanColumn) || 'CREATED';
const effectiveColumn = resolvedColumn === 'BACKLOG' ? 'CREATED' : resolvedColumn;
```

It sorts ascending by ordinal and picks `[0]` (minimum). At creation time `db.upsertPlan({ kanbanColumn: effectiveColumn, isEpic: 1, ... })` (line 8633-8657) writes the resolved column to the DB. **So the resolution is NOT the bug. Do not change the sort direction or the `[0]` index.** (The old plan's title said "most-advanced" and debated min-vs-max; that debate is moot — min is correct and already shipped.)

### Root Cause — the clobber is in the file-watcher import path, not the resolution

The correctly-resolved column is overwritten by the file-watcher's import path, which treats the epic file as a brand-new file and applies the new-file default `'CREATED'`:

1. `insertFileDerivedPlan` (`KanbanDatabase.ts` lines 1336-1350) hardcodes `kanban_column = 'CREATED'` in the INSERT VALUES (line 1342) and **omits `kanban_column` from the `ON CONFLICT ... DO UPDATE SET` clause** (lines 1343-1349).
   - On a true UPDATE (row exists) → `kanban_column` is preserved (not in the SET clause). OK.
   - On a fresh INSERT (row absent) → `kanban_column` is forced to `'CREATED'`, **ignoring whatever `record.kanbanColumn` carried**. Clobber.

2. A fresh INSERT of an already-existing epic happens in two situations:
   - **After the `registerPendingCreation` suppression window expires** (`GlobalPlanWatcherService.ts` line 39-46, 3000ms): `createEpicFromPlanIds` writes the epic file twice (initial write line 8671 + `_regenerateEpicFile` line 8677) and suppresses the watcher for 3s. If a watcher event is processed after that window (or escapes suppression), `_handlePlanFile` runs.
   - **The atomic-write DELETE→re-INSERT race** (same race as `fix-create-epic-not-setting-is-epic.md`): an external tool edits the epic file atomically (temp + rename) → both `_handlePlanDelete` and `_handlePlanFile` fire after the 300ms debounce → `_handlePlanDelete` deletes the row first → `insertFileDerivedPlan` then does a fresh INSERT with `kanban_column = 'CREATED'`.

3. `_handlePlanFile` (`GlobalPlanWatcherService.ts` lines 447-654) **re-asserts `is_epic = 1`** for epic files in both the new-record branch (lines 577-580) and the existing-record branch (lines 617-619) — that was the sibling plan's fix. But it does **NOT** re-assert `kanban_column`. So `is_epic` survives the race while the carefully-resolved column is lost to `'CREATED'`.

**Net:** the file-watcher import path decides the epic's column from "is this file new?" rather than from the epic's subtasks. Being a new file forces `CREATED`. That is the undesirable behavior to fix — the epic's column is a DB-owned invariant derived from subtasks, not a property of the file.

> Design note: `insertFileDerivedPlan`'s header (lines 1307-1310) states "DB-owned columns (is_epic, epic_id, kanban_column, status, ...) are left at their schema DEFAULT values — the file has no business setting them." The hardcoded `'CREATED'` is the schema default for genuinely-new files. The fix below respects this design: it does **not** teach the file to set `kanban_column`. Instead it re-derives the column from DB state (subtasks) after the insert, exactly as the `is_epic` re-assert already does.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, database, reliability

## Model Decision (decisive — no user review needed)

**Epic column = minimum ordinal of its subtasks' columns (least-advanced / weakest-link).** Already implemented at `KanbanProvider.ts` line 8609-8613. The fix does not touch the resolution; it makes the resolution survive the file-watcher import path. There is no "most-advanced" alternative under consideration — that was the old plan's erroneous framing.

### Built-in column ordinals (verified against `DEFAULT_KANBAN_COLUMNS`, `agentConfig.ts` lines 107-122)

The ordinal is the array index after sorting `buildKanbanColumns` output by `order` ascending (`agentConfig.ts` line 374). `BACKLOG` is not built-in; `createEpicFromPlanIds` adds it at ordinal `-1` (line 8606-8608) so it sorts before `CREATED` and is then coerced to `CREATED`.

| Column | `order` | Ordinal |
|---|---|---|
| CREATED | 0 | 0 |
| CONTEXT GATHERER | 50 | 1 |
| RESEARCHER | 90 | 2 |
| CODE_RESEARCHER | 95 | 3 |
| PLAN REVIEWED | 100 | 4 |
| SPLITTER | 110 | 5 |
| LEAD CODED | 180 | 6 |
| CODER CODED | 190 | 7 |
| INTERN CODED | 200 | 8 |
| ORCHESTRATING | 250 | 9 |
| CODE REVIEWED | 300 | 10 |
| ACCEPTANCE TESTED | 350 | 11 |
| TICKET UPDATER | 9000 | 12 |
| COMPLETED | 9999 | 13 |

User order overrides (`_getEffectiveKanbanOrderOverrides`) can reorder columns at runtime, so any re-assert must compute ordinals from the **live** column defs, not hardcode the table above.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — new `recomputeEpicColumnFromSubtasks(epicPlanId)` helper (NEW)

Re-derive an epic's column from its subtasks (min ordinal) and persist it. This is the DB-owned counterpart to the existing `is_epic` re-assert and is what the watcher calls after every epic-file import. Keeping the ordinal logic in the DB avoids coupling `GlobalPlanWatcherService` to `KanbanProvider._buildKanbanColumns`.

```typescript
/**
 * Re-derive an epic's kanban_column from its subtasks (minimum ordinal /
 * weakest-link) and persist it. Mirrors createEpicFromPlanIds' resolution:
 * sort subtask columns by live ordinal, pick the first (least-advanced),
 * coerce BACKLOG -> CREATED. No-op (returns true without writing) when the
 * epic has zero subtasks or all subtasks have empty kanbanColumn — in those
 * cases there is nothing to derive and we must NOT overwrite an existing
 * non-CREATED column with the new-file default. Used by the file watcher to
 * self-heal the kanban_column clobber from insertFileDerivedPlan's hardcoded
 * 'CREATED' on fresh INSERT (re-import after the 3000ms suppression window,
 * or the atomic-write DELETE->re-INSERT race).
 */
public async recomputeEpicColumnFromSubtasks(epicPlanId: string): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    const epic = await this.getPlanByPlanId(epicPlanId);
    if (!epic || !epic.isEpic) return false;
    const subtasks = await this.getSubtasksByEpicId(epicPlanId);
    const columns = subtasks
        .map((st: KanbanPlanRecord) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
        .filter((col: string | null): col is string => !!col);
    if (columns.length === 0) return true; // nothing to derive; leave existing column
    const ordinalMap = await this._buildLiveOrdinalMap(epic.workspaceId);
    let resolved = columns.sort(
        (a, b) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity)
    )[0];
    if (resolved === 'BACKLOG') resolved = 'CREATED';
    if (resolved === epic.kanbanColumn) return true; // already correct, no write
    return this.updateColumnByPlanFile(epic.planFile, epic.workspaceId, resolved);
}
```

**Supporting:** `_buildLiveOrdinalMap(workspaceId)` builds the `Map<columnId, ordinal>` from `DEFAULT_KANBAN_COLUMNS` (import from `agentConfig.ts`) + custom columns read via the existing config getter, sorted by `order` ascending — the same ordering `buildKanbanColumns` (`agentConfig.ts` line 374) produces. Add `BACKLOG -> -1` for parity with `createEpicFromPlanIds` (line 8606-8608). If a helper for this already exists on the DB or provider, reuse it instead of duplicating.

**Context:** `getSubtasksByEpicId` (line 3811) returns full `KanbanPlanRecord[]` incl. `kanbanColumn`. `updateColumnByPlanFile` (line 1433) validates the column name (`VALID_KANBAN_COLUMNS` / `SAFE_COLUMN_NAME_RE`) and is the canonical plan-file-keyed column update. `_normalizeLegacyKanbanColumn` (line 2008-2011) only maps `'CODED' -> 'LEAD CODED'`.

**Edge cases:**
- Zero subtasks / all empty `kanbanColumn` → no-op (do **not** force `CREATED` over an existing column). This is the guard that prevents "new file → CREATED" — when there are no subtasks to derive from, leave the DB value alone.
- `BACKLOG` (ordinal -1) → coerce to `CREATED`.
- Resolved column equals existing → skip the write (idempotent, avoids needless `_persist()`).
- Must use the **same min-ordinal model** as `createEpicFromPlanIds` (line 8609-8613) so the watcher re-assert never flips the column away from what creation just set.

### 2. `src/services/GlobalPlanWatcherService.ts` — `_handlePlanFile`: re-assert `kanban_column` for epic files (NEW, mirrors the existing `is_epic` re-assert)

In **both** branches where epic files are handled, immediately after the existing `updateEpicStatus(..., 1, '')` re-assert, call the new DB helper so the column is re-derived from subtasks every time the watcher processes an epic file. This self-heals the clobber whether it came from a post-3000ms re-import or the atomic-write DELETE→re-INSERT race.

```typescript
// New-record branch (after line 580, right after `newRecord.isEpic = 1;`):
if (relativePath.startsWith('.switchboard/epics/')) {
    await db.updateEpicStatus(newRecord.planId, 1, '');
    newRecord.isEpic = 1;
    // Re-assert kanban_column from subtasks: insertFileDerivedPlan hardcodes
    // 'CREATED' on fresh INSERT, so a re-import (post-suppression-window) or a
    // DELETE->re-INSERT race would clobber the epic's resolved column. Mirror
    // the is_epic re-assert above. No-op when the epic has no subtasks yet.
    await db.recomputeEpicColumnFromSubtasks(newRecord.planId);
}

// Existing-record branch (after line 620, right after `updatedRecord.isEpic = 1;`):
if (relativePath.startsWith('.switchboard/epics/')) {
    await db.updateEpicStatus(updatedRecord.planId, 1, '');
    updatedRecord.isEpic = 1;
    // Same clobber vector as above (the atomic-write DELETE->re-INSERT race
    // hits this branch: _handlePlanDelete deletes the row, then this branch's
    // insertFileDerivedPlan re-INSERTs with kanban_column='CREATED'). Re-derive.
    await db.recomputeEpicColumnFromSubtasks(updatedRecord.planId);
}
```

`db`, `relativePath`, and the `planId` (`newRecord.planId` / `updatedRecord.planId` — derived from the filename UUID for epics, lines 540-550) are all already in scope. No new imports or injected callbacks are required (unlike `_resolveDisplayedProject`, the ordinal logic lives in the DB helper, not the provider).

### 3. `src/services/KanbanProvider.ts` — `createEpicFromPlanIds` diagnostic logging (ALREADY APPLIED, keep)

Line 8614 already logs the resolved/effective column:
```typescript
console.log(`[KanbanProvider] createEpicFromPlanIds: subtask columns = [${subtasks.map(st => st.kanbanColumn).join(', ')}], resolvedColumn=${resolvedColumn}, effectiveColumn=${effectiveColumn}`);
```
Keep as-is. No resolution change.

### 4. (Optional, belt-and-suspenders) `createEpicFromPlanIds` post-creation column re-assert

With change #2 in place, the watcher re-asserts the column on any post-creation watcher event, so a creation-time re-assert is strictly redundant. It can be added as defense-in-depth (mirroring the existing `db.updateEpicStatus(planId, 1, '')` at line 8681) by calling `db.recomputeEpicColumnFromSubtasks(planId)` right before `_refreshBoard` (line 8684). Mark optional unless the implementer wants symmetry with the `is_epic` re-assert. Do NOT add a second hand-rolled resolution block — reuse the same DB helper to guarantee one model.

## Complexity Audit

### Routine
- The DB helper is a pure read-sort-update over already-fetched records; `getSubtasksByEpicId`, `updateColumnByPlanFile`, `_normalizeLegacyKanbanColumn` all exist.
- The watcher change is two one-line calls placed adjacent to the existing `is_epic` re-assert — same pattern, same guard (`startsWith('.switchboard/epics/')`).

### Complex / Risky
- `_buildLiveOrdinalMap` must honor user order overrides and custom columns, or the watcher re-assert could compute a different ordinal than `createEpicFromPlanIds` and flip the column on the first post-creation watcher event. Reuse the provider's column-building logic if extractable; otherwise duplicate it carefully and keep them in sync.
- The re-assert runs on **every** epic-file watcher event. It must be cheap and idempotent (the helper short-circuits when `resolved === epic.kanbanColumn`). For high-frequency epic edits this is one `getPlanByPlanId` + one `getSubtasksByEpicId` + (rarely) one `updateColumnByPlanFile` per debounced flush — acceptable and bounded.
- The zero-subtasks no-op guard is load-bearing: without it, the re-assert would itself force `CREATED` on a brand-new epic before its subtasks are linked, reintroducing the bug. `createEpicFromPlanIds` links subtasks (line 8672-8676) before the 3000ms window expires, so by the time the watcher re-asserts, subtasks are present — but the guard protects against any ordering surprise.

## Edge-Case & Dependency Audit

**Race Conditions**
- The headline race (atomic-write DELETE→re-INSERT) is the same one `fix-create-epic-not-setting-is-epic.md` closes for `is_epic`. Change #2 closes the `kanban_column` vector of the same race by re-deriving from subtasks after the re-INSERT. The brief window between the clobber and the re-assert can still be observed by a concurrent reader (board refresh mid-flush), but it self-heals on the next event.
- The 3000ms `registerPendingCreation` window covers the synchronous creation path; change #2 is the safety net for any event that escapes it.

**Security**
- None. Column values flow from DB records and `DEFAULT_KANBAN_COLUMNS`/config. `updateColumnByPlanFile` validates the column name. No untrusted input reaches the new paths.

**Side Effects**
- One extra `getPlanByPlanId` + `getSubtasksByEpicId` per epic-file watcher event; a `updateColumnByPlanFile` + `_persist()` only when the column actually differs. Epic edits are rare; negligible.
- Existing epics created under the clobber (stuck in `CREATED` when their subtasks are further along) will self-heal on their next watcher event (next edit or panel reopen/scan). No migration needed — the re-assert is self-correcting.

**Dependencies & Conflicts**
- Sibling: `fix-create-epic-not-setting-is-epic.md` — same atomic-write race; its `is_epic` re-assert (already applied at lines 577-580, 617-619) is the template for change #2. The two re-asserts sit side-by-side in the same `if` blocks.
- No conflict with `fix-epic-loses-status-on-column-move.md` (column moves via `moveCardToColumn`, a different code path from file-watcher imports).

## Dependencies

- `fix-create-epic-not-setting-is-epic.md` — same race, sibling column. Its applied `is_epic` re-assert establishes the pattern (unconditional re-assert for `.switchboard/epics/` files in both branches of `_handlePlanFile`). This plan adds the missing `kanban_column` re-assert next to it.

## Adversarial Synthesis

The prior version of this plan failed UAT for three reasons, all corrected here:
1. **Wrong frame:** it titled the bug "most-advanced subtask column" and debated min-vs-max ordinals. The resolution model was never the bug — min-ordinal (least-advanced) is correct and already shipped at `KanbanProvider.ts` line 8609-8613. The debate and the "User Review Required: weakest-link vs most-advanced" question are dropped; the model is decided.
2. **Mis-located fix:** it proposed a no-op refactor of the sort (`[0]` kept) plus a creation-only re-assert, while flagging the actual clobber (the file-watcher re-INSERT hardcoding `'CREATED'`) as "out of scope" and escalating it to the user. The clobber is the whole bug and is now in scope.
3. **Factual drift:** it carried multiple disproven hypotheses and self-corrections. The root cause is stated once, verified against the live code: `insertFileDerivedPlan` (line 1342) hardcodes `kanban_column='CREATED'` on INSERT and the ON CONFLICT clause (lines 1343-1349) omits it; `_handlePlanFile` re-asserts `is_epic` (lines 577-580, 617-619) but not `kanban_column`.

Key residual risk: the ordinal map in the DB helper must match `createEpicFromPlanIds`'s map (live column defs + overrides + `BACKLOG=-1`), or the first post-creation watcher event flips the column. Mitigation: reuse the provider's column-building logic if extractable; otherwise duplicate with a shared test. The zero-subtasks no-op guard mitigates the "new file → CREATED" reintroduction risk.

## Verification Plan

> Compilation and automated tests are deferred to the user (run separately). The verification below is manual/observational plus DB checks.

### Automated Tests (suggested, deferred to user)
- `createEpicFromPlanIds`: epic's `kanban_column` equals the minimum-ordinal subtask column (covers the resolution, regression-protects the already-correct logic).
- `recomputeEpicColumnFromSubtasks`: (a) epic with subtasks all in `PLAN REVIEWED` → column becomes `PLAN REVIEWED`; (b) epic with zero subtasks → no-op, existing column preserved (does NOT force `CREATED`); (c) epic with one subtask in `CREATED` + rest in `PLAN REVIEWED` → column becomes `CREATED`.
- Watcher race: simulate an atomic write (temp+rename) of an epic file whose subtasks are all in `PLAN REVIEWED` → after the debounced flush, `kanban_column` is `PLAN REVIEWED`, NOT `CREATED` (this is the regression test for the headline bug).

### Manual Verification
- Create an epic from 3 plans all in `PLAN REVIEWED` → epic must be in `PLAN REVIEWED` immediately and after board refresh.
- Create an epic from 3 plans where 2 are in `PLAN REVIEWED` and 1 is in `CREATED` → epic must be in `CREATED` (least-advanced).
- Create an epic from 3 plans all in `CREATED` → epic must be in `CREATED`.
- **Headline regression check:** create an epic whose subtasks are all in `PLAN REVIEWED`, then edit the epic file with an external atomic-write tool (temp + rename) → the epic must STAY in `PLAN REVIEWED`, not revert to `CREATED`.
- **Self-heal check:** take an existing epic stuck in `CREATED` whose subtasks are all in `PLAN REVIEWED`; trigger any epic-file watcher event (reopen panel / edit the epic file) → the epic must move to `PLAN REVIEWED` without a manual drag.
- Check DB after creation and after edit: `SELECT plan_id, is_epic, kanban_column FROM plans WHERE plan_id = '<epic_id>'` — `is_epic=1` and `kanban_column='PLAN REVIEWED'` in both cases.
