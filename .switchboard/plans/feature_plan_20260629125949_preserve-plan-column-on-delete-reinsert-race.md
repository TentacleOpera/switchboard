# Preserve a Non-Epic Plan's Column Across the Delete→Re-Insert Race

## Metadata
**Complexity:** 4
**Tags:** backend, bugfix, reliability

## Goal

Give **non-epic plans** the same kanban-column survival guarantee that epics already have when a plan file is rewritten through a genuine delete-then-recreate that the atomic-write guard does not catch. Today such a re-import re-INSERTs the row with a hardcoded `'CREATED'` column and there is no recovery path for a plain plan (the existing self-heal, `_recomputeEpicColumn`, is epic-only because it derives the column from subtasks — which a plain plan does not have). An advanced plan (e.g. in `CODER CODED`) silently snaps back to `CREATED`.

### Problem Analysis

Three layers protect an advanced card's column when its file is edited (verified end-to-end):

1. **`insertFileDerivedPlan` (`KanbanDatabase.ts:1343`)** — The INSERT VALUES literal at `:1349` **hardcodes** `'CREATED'` for `kanban_column`; `record.kanbanColumn` is never passed to the SQL. The `ON CONFLICT(plan_file, workspace_id) DO UPDATE SET` clause (`:1350-1356`) **omits `kanban_column`**, so an *existing* row's column is preserved on any normal edit (the conflict path runs `UPDATE SET topic, complexity, tags, project, project_id, updated_at` — never touching `kanban_column`). This is the primary protection and handles the common case (in-place writes, e.g. Node `fs.writeFile`, never fire a delete).
2. **Atomic-write delete guard (`_handlePlanDelete:694`)** — temp+rename saves fire a spurious DELETE; the guard re-checks `fs.existsSync` after the 300ms debounce and skips the delete if the file is back, so the row is never dropped and protection #1 applies.
3. **Epic self-heal (`_recomputeEpicColumn`, wired `extension.ts:522`)** — if a fresh INSERT does occur, an epic re-derives its column from its subtasks afterward.

**The gap:** if a tool saves via a *non-atomic* delete+recreate with a gap longer than the 300ms debounce (so the file is genuinely absent when the guard runs `fs.existsSync`), `_handlePlanDelete` hard-deletes the row. The subsequent change/create event then finds no row, takes the **new-plan branch** (`GlobalPlanWatcherService.ts:535`), and re-INSERTs via `insertFileDerivedPlan`. Because the INSERT VALUES literal is hardcoded `'CREATED'` (not `record.kanbanColumn`), the DB always gets `'CREATED'` on a fresh INSERT regardless of what `metadata.kanbanColumn` says. Plans do not carry their column in the file (it is DB-only), so the in-memory `newRecord.kanbanColumn` at `:571` is `'CREATED'` → **DB column is `CREATED`**. For an epic, layer #3 repairs it; for a plain plan there is nothing to repair from, so the column is lost.

### Root Cause

The re-INSERT has no memory of the row it is replacing. Layer #1 preserves the column only because the row still exists (the `ON CONFLICT` update path); once the row is gone, the column the user chose is unrecoverable from anything the new-plan branch can see. Epics get around this by re-deriving from subtasks; plain plans need the watcher to **remember the column it just deleted** and restore it on a fast re-insert — the same shape as the existing `_recentRenames` tombstone (`:32,50-51`).

## Decision (no open product questions)

- **Add a short-lived "recently deleted column" tombstone in the watcher**, keyed by `plan_file|workspace_id`, mirroring the existing `_recentRenames` Set + `setTimeout` eviction pattern (`:50-51`).
- **Capture on delete:** in `_handlePlanDelete`, immediately before `deletePlanByPlanFile` (i.e. *after* the existing completed-plan skip at `:715`, so archived plans are never tombstoned), record the row's `kanbanColumn` with a TTL (5000ms — comfortably covers the 300ms delete debounce plus the re-create debounce).
- **Restore on re-insert:** in the **new-plan branch** only (`:535-602`), after `insertFileDerivedPlan`, if a non-expired tombstone exists for this `plan_file|workspace_id` and its column is not `CREATED`, call `db.movePlanByPlanFile(relativePath, workspaceId, tombstonedColumn, relativePath)` to restore it — and consume (delete) the tombstone. This is exactly symmetric to the epic post-insert self-heal at `:600/:646`, just sourced from the tombstone instead of subtasks.
- **Do NOT change `insertFileDerivedPlan`'s SQL.** Leaving the INSERT literal and the `ON CONFLICT` clause untouched keeps the normal-edit preservation (layer #1) intact and avoids auditing the migration-path callers (`KanbanMigration.ts:85,175`). The fix is additive and watcher-local.
- **Genuine deletions are unaffected.** A real user delete sets a tombstone that simply expires — no re-create follows within the TTL, so nothing is resurrected. The tombstone only ever influences a row that is being re-inserted, which by definition means the file came back.

### Rejected Alternatives
- *Parameterize `kanban_column` in `insertFileDerivedPlan`'s INSERT* — rejected: forces a caller audit (the migration path passes records too) and risks regressing layer #1; the additive restore needs no SQL change.
- *Generalize `_recomputeEpicColumn` to plans* — impossible: a plain plan has no subtasks to derive a column from. The tombstone is the plan-side equivalent.
- *Soft-delete with a grace-period sweeper* — rejected as over-engineering for a narrow race; the tombstone is minimal and matches existing patterns.
- *Widen the delete debounce / add more `existsSync` checks* — rejected: the residual window is a fundamental race; existence checks shrink it but cannot close it. Remembering the column closes it deterministically.

## User Review Required

No open product questions. The approach is additive, watcher-local, and follows an existing pattern (`_recentRenames`). Review should confirm:
- The 5000ms TTL is sufficient for real-world save tools (the plan assumes delete+recreate happens well within 5s; if a tool has a longer gap, the tombstone expires and behavior falls back to status quo — no worse than today).
- Scoping to column-only restoration (not `repo_scope`, `routed_to`, etc.) is acceptable for the reported symptom.

## Complexity Audit

### Routine
- A `Map<string, { column: string; ts: number }>` field + `setTimeout` eviction (copy of the `_recentRenames` shape).
- One capture line in `_handlePlanDelete`; one lookup+restore block in the new-plan branch.
- No SQL changes, no schema changes, no migration.

### Complex / Risky
- This is race-critical, recently-bug-prone code (the atomic-write delete fix is days old). The capture must sit *after* the completed-plan skip, the restore must run *only* in the new-plan branch (never the update branch, which already preserves the column), and the tombstone key must include `workspace_id` to avoid cross-workspace collisions.
- The tombstone key in capture and restore MUST use the same source (`relativePath`, computed identically in both `_handlePlanDelete:704` and `_handlePlanFile:472`). Using `plan.planFile` (DB value) in the capture and `relativePath` in the restore is a latent key mismatch — see Adversarial Synthesis.

## Edge-Case & Dependency Audit
- **Real deletion:** tombstone expires unused; no resurrection (restore only fires inside a re-insert).
- **Completed/archived plans:** never tombstoned (capture is after the `status === 'completed'` skip at `:715`), and they don't re-enter the active new-plan branch.
- **Epics:** unaffected — they hit the epic branch and `_recomputeEpicColumn`; the tombstone restore is in the plain-plan path. (Harmless if both fire: same column.)
- **Cross-workspace:** key on `plan_file|workspace_id`, not bare path.
- **Invalid tombstone column:** if a custom column was removed between delete and re-create, `movePlanByPlanFile` validates against `VALID_KANBAN_COLUMNS` + `SAFE_COLUMN_NAME_RE` at `:1531` and silently rejects the move — the plan stays at `CREATED` (status quo). Safe fallback, not a bug.
- **`updated_at` side effect:** `movePlanByPlanFile` sets `updated_at = now` (`:1539/1547`), overwriting the mtime-based `updated_at` from `insertFileDerivedPlan`. The mtime-skip check at `:499` may cause a spurious skip on the next watcher event for the same file if it hasn't changed since. Harmless in practice (next real edit has a newer mtime). Known side effect, not worth preventing.
- **`_pendingCreations` interaction:** if a tool deletes and recreates a file that's in the `_pendingCreations` suppression window (`:464`), the create event is skipped entirely — the tombstone is set but never consumed, and the row was already deleted. The plan is lost. This is a **pre-existing bug** in `_pendingCreations`, not introduced by this plan. The tombstone doesn't help but doesn't hurt. Flagged as a known limitation.
- **Orphan timers on dispose:** each tombstone spawns an untracked `setTimeout` (same pattern as `_recentRenames`). `dispose()` at `:767` clears `_debounceTimers` but not these timers. Pre-existing pattern, not a regression. A tracked-timer `Map` cleared in `dispose()` would be the correct fix — flagged, not required here.
- **Other fields reset by the same race (out of scope):** a fresh re-INSERT also defaults `repo_scope`, `routed_to`, `dispatched_agent`, `dispatched_ide` (none are in the `ON CONFLICT` clause). This plan restores **column only** — the reported symptom. If those prove to matter, the tombstone can later capture the full prior record and restore them in the same `movePlanByPlanFile`-adjacent step; flagged, not fixed here.
- **TTL tuning:** 5000ms covers the 300ms delete debounce + re-create debounce with margin; if a save tool exceeds it, the tombstone expires and the plan falls back to today's behavior (resets to CREATED) — no worse than the status quo.

### Migration safety
- No schema change, no data migration. Pure in-memory, watcher-local behavior. Nothing persisted differently.

## Dependencies
- None. This is a self-contained, single-file change to `GlobalPlanWatcherService.ts`.

## Adversarial Synthesis

Key risks: (1) tombstone key mismatch if capture uses `plan.planFile` instead of `relativePath` — fixed by using `relativePath` in both; (2) `movePlanByPlanFile` silently rejects invalid columns — safe fallback to status quo, documented; (3) `_pendingCreations` suppression can shadow the re-create event, losing the plan — pre-existing bug, acknowledged as a known limitation. Mitigations: symmetric key construction, column validation safety net, and explicit documentation of all edge-case fallbacks.

## Proposed Changes

### 1. `src/services/GlobalPlanWatcherService.ts` — tombstone field
Alongside `_recentRenames` (`:32`):
```ts
/** plan_file|workspace_id -> last-known column, set just before a hard delete so a
 *  fast delete→re-insert (non-atomic save the existsSync guard missed) can restore the
 *  column instead of resetting it to CREATED. Plain-plan analogue of _recomputeEpicColumn. */
private _recentlyDeletedColumns = new Map<string, { column: string; ts: number }>();
```

### 2. `_handlePlanDelete` — capture before the hard delete (`:719`)
**Key consistency fix:** use `relativePath` (computed at `:704`), NOT `plan.planFile` (DB value), to guarantee the capture key matches the restore key in `_handlePlanFile` (which uses `relativePath` from `:472`).

```ts
// (after the completed-plan skip at :715, before deletePlanByPlanFile at :719)
const tombKey = `${relativePath}|${plan.workspaceId}`;
this._recentlyDeletedColumns.set(tombKey, { column: plan.kanbanColumn, ts: Date.now() });
setTimeout(() => this._recentlyDeletedColumns.delete(tombKey), 5000);
await db.deletePlanByPlanFile(plan.planFile, plan.workspaceId);
```

### 3. `_handlePlanFile` new-plan branch — restore after insert (`:601`, non-epic case)
Insert after the epic re-assert block (after `:601`, before `plan = newRecord;` at `:602`):
```ts
// after `await db.insertFileDerivedPlan(newRecord);` (:591) and the epic re-assert block (:592-601)
if (!relativePath.startsWith('.switchboard/epics/')) {
    const tombKey = `${relativePath}|${workspaceId}`;
    const tomb = this._recentlyDeletedColumns.get(tombKey);
    if (tomb && Date.now() - tomb.ts < 5000 && tomb.column && tomb.column !== 'CREATED') {
        // movePlanByPlanFile validates the column against VALID_KANBAN_COLUMNS + SAFE_COLUMN_NAME_RE
        // at KanbanDatabase.ts:1531 — if the column was removed since the delete, the move is
        // silently rejected and the plan stays at CREATED (status quo fallback).
        await db.movePlanByPlanFile(relativePath, workspaceId, tomb.column, relativePath);
        newRecord.kanbanColumn = tomb.column; // update in-memory record for ClickUp sync at :664
    }
    this._recentlyDeletedColumns.delete(tombKey); // consume tombstone regardless of restore
}
```

**Note on `newRecord.kanbanColumn`:** The `insertFileDerivedPlan` SQL hardcodes `'CREATED'` in the INSERT VALUES (`KanbanDatabase.ts:1349`) — `record.kanbanColumn` is never passed to the SQL. The `movePlanByPlanFile` call is what actually sets the DB column. Setting `newRecord.kanbanColumn = tomb.column` only updates the in-memory object, which is assigned to `plan` at `:602` and used by the ClickUp sync at `:664`. Without this, ClickUp sync would report `'CREATED'` instead of the restored column.

## Verification Plan

### Automated Tests
- **Tombstone capture:** simulate `_handlePlanDelete` on an active plan in `CODER CODED` → tombstone holds `CODER CODED`; on a `completed` plan → no tombstone set.
- **Restore:** seed a tombstone for `path|ws = CODER CODED`, run the new-plan branch for that path → final row column is `CODER CODED`, tombstone consumed.
- **No resurrection:** set a tombstone, let it expire (advance clock past TTL), run new-plan branch → column is `CREATED` (status quo), and no row is created from the tombstone alone.
- **Key symmetry:** verify the capture key (`relativePath|workspaceId`) matches the restore key (`relativePath|workspaceId`) — both use `relativePath` computed from `path.relative(workspaceRoot, uri.fsPath)`.
- **Invalid column fallback:** seed a tombstone with a column not in `VALID_KANBAN_COLUMNS` and not matching `SAFE_COLUMN_NAME_RE` → `movePlanByPlanFile` returns `false`, plan stays at `CREATED`.
- **Epic path untouched:** an epic re-import still routes through `_recomputeEpicColumn`, not the tombstone restore.

### Manual (installed VSIX — dev does not use `dist/`)
1. Move a plain plan to `CODER CODED`. Rewrite its plan file with a tool that does a non-atomic delete+recreate (or simulate by deleting then re-creating the file within ~1s). Confirm the card stays in `CODER CODED` instead of snapping to `CREATED`.
2. Repeat for an epic that's been advanced → still preserved (via the existing epic self-heal).
3. Genuinely delete a plan file → card disappears and does **not** reappear (tombstone expires unused).
4. Ordinary in-place edit of an advanced plan → column preserved (layer #1, unchanged).

## Review Pass (2026-06-29)

### Stage 1: Adversarial Findings

| # | Severity | File:Line | Finding |
|---|----------|-----------|---------|
| 1 | **MAJOR** | `GlobalPlanWatcherService.ts:610-611` | `newRecord.kanbanColumn = tomb.column` runs unconditionally after `await db.movePlanByPlanFile(...)`, even when the move returns `false` (invalid/removed column). This poisons the in-memory record and ClickUp sync with a column that doesn't match the DB (which stays at `CREATED`). Three-way desync: DB=CREATED, in-memory=tomb.column, ClickUp=tomb.column. The plan's own edge-case audit (line 61) documented the DB fallback but missed the in-memory poisoning. |
| 2 | NIT | `GlobalPlanWatcherService.ts:593,603` | `if`/`else` written as two independent `if` statements with mutually exclusive conditions. Stylistic, not a bug. |
| 3 | NIT | `GlobalPlanWatcherService.ts:743` | Orphan tombstone `setTimeout` not cleared in `dispose()`. Pre-existing pattern matching `_recentRenames`. Not a regression. |
| 4 | NIT | `GlobalPlanWatcherService.ts:741-746,606-621` | Zero logging on tombstone capture or restore. Race-critical code with no diagnostic trail. |

### Stage 2: Balanced Synthesis

- **Finding 1 (MAJOR): FIX NOW.** Guard `newRecord.kanbanColumn` update on `movePlanByPlanFile` return value. One-line check prevents three-way DB/in-memory/ClickUp desync.
- **Finding 2 (NIT): DEFER.** Stylistic `if`/`else` refactor — not worth diff churn in committed race-critical code.
- **Finding 3 (NIT): DEFER.** Pre-existing pattern, not a regression. Flagged in original plan.
- **Finding 4 (NIT): FIX NOW (minimal).** Add log lines on capture and restore for field diagnosability.

### Fixes Applied

1. **MAJOR fix — `GlobalPlanWatcherService.ts:610-620`:** Captured the return value of `movePlanByPlanFile` into `const moved`. Only update `newRecord.kanbanColumn = tomb.column` inside `if (moved)`. Added an `else` branch that logs the rejection. This ensures the in-memory record and ClickUp sync stay consistent with the DB when the move is rejected (invalid/removed column).
2. **NIT fix — `GlobalPlanWatcherService.ts:744-746`:** Added `appendLine` log on tombstone capture: `"Tombstoned column '<col>' for <path> before hard delete"`.
3. **NIT fix — `GlobalPlanWatcherService.ts:613-619`:** Added `appendLine` log on successful restore and on rejection, so the race fix is diagnosable in the field.

### Verification Results

- **Key symmetry:** CONFIRMED — both capture (`:726`) and restore (`:473`) use `path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/')` for `relativePath`, and both use the same `workspaceId` source (DB record's `workspaceId` in capture = `db.getWorkspaceId()` in restore, since the plan was fetched with that ID).
- **TTL consistency:** CONFIRMED — capture `setTimeout(..., 5000)` and restore check `Date.now() - tomb.ts < 5000` both use 5000ms.
- **Capture placement:** CONFIRMED — after completed-plan skip (`:737-740`), before `deletePlanByPlanFile` (`:747`).
- **Restore placement:** CONFIRMED — in new-plan branch only (inside `if (!plan)` at `:536`), after epic re-assert block (`:593-602`), before `plan = newRecord` (`:624`). Update branch (`:627+`) does NOT have tombstone restore.
- **Epic exclusion:** CONFIRMED — restore block guarded by `if (!relativePath.startsWith('.switchboard/epics/'))` at `:603`.
- **Tombstone consumption:** CONFIRMED — `this._recentlyDeletedColumns.delete(tombKey)` at `:622` runs regardless of restore (outside the inner `if`).
- **Compilation:** Skipped per instructions.
- **Tests:** Skipped per instructions.

### Remaining Risks

1. **`_pendingCreations` suppression shadow** (pre-existing, acknowledged in original plan line 63): if a tool deletes and recreates a file within the 3000ms `_pendingCreations` window, the create event is skipped entirely — tombstone is set but never consumed, and the row was already deleted. The plan is lost. Pre-existing bug, not introduced by this change.
2. **Orphan timers on dispose** (pre-existing, acknowledged in original plan line 64): tombstone `setTimeout` timers are not tracked or cleared in `dispose()`. Matches `_recentRenames` pattern. A tracked-timer `Map` cleared in `dispose()` would be the correct fix.
3. **Other fields reset by the same race** (out of scope, acknowledged in original plan line 65): `repo_scope`, `routed_to`, `dispatched_agent`, `dispatched_ide` are also defaulted on fresh re-INSERT. This plan restores column only.
4. **`updated_at` side effect** (acknowledged in original plan line 62): `movePlanByPlanFile` sets `updated_at = now`, which may cause a spurious mtime-skip on the next watcher event. Harmless in practice.
