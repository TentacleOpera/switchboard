# Fix: Epics Lose is_epic Status When Epic Files Are Edited (Atomic Write Race)

## Goal

When an epic file is edited (e.g., by the `write` tool, an agent, or any external process that does an atomic write via temp file + rename), the epic temporarily loses its `is_epic = 1` status in the database. The card renders as a normal plan without the epic badge. Closing and reopening the panel restores the epic status.

This also explains why 3 of the 8 epics created in a recent batch had `is_epic = 0` — the `createEpicFromPlanIds` method writes the epic file twice (initial write + `_regenerateEpicFile`), and the second write triggers the same race.

> **Current code state (verified 2026-06-27):** BOTH proposed changes are already applied in `src/`. `GlobalPlanWatcherService.ts` line 617-620 has the unconditional `updateEpicStatus`; `KanbanDatabase.ts` line 594 has the `CASE WHEN excluded.is_epic > 0 ...` conflict clause. This plan now serves as the documented rationale + residual-risk record. The remaining work is the `kanban_column` clobber from the SAME race — tracked in `fix-epic-default-column-from-subtasks.md`.

### Root Cause

**Race condition between `_handlePlanDelete` and `_handlePlanFile` in `GlobalPlanWatcherService.ts` during atomic writes.**

When a file is saved atomically (temp file + rename), both the VS Code file watcher and the native `fs.watch` watcher fire events:
- A delete event (old file removed)
- A create/change event (new file appears)

Both events are debounced with 300ms. After 300ms, both `_handlePlanDelete` and `_handlePlanFile` fire concurrently.

The race:

1. Both `_handlePlanDelete` and `_handlePlanFile` call `getPlanByPlanFile` concurrently — **both see the existing row with `is_epic = 1`**
2. `_handlePlanDelete` runs first → `deletePlanByPlanFile` deletes the DB row
3. `_handlePlanFile` continues → `insertFileDerivedPlan` runs. Since the row was just deleted, this does an **INSERT** (not an UPDATE). `insertFileDerivedPlan`'s SQL does NOT include `is_epic` in its INSERT column list, so the new row gets `is_epic = 0` (column default).
4. `_handlePlanFile` checks `if (relativePath.startsWith('.switchboard/epics/') && !plan.isEpic)` — but `plan` was fetched in step 1 when `is_epic` was still `1`, so `plan.isEpic` is truthy. The check is **false**. `updateEpicStatus` is **NOT called**.
5. The new row stays with `is_epic = 0` → card renders without epic badge

On panel reopen, `triggerScan` runs → `_handlePlanFile` fires again → this time `getPlanByPlanFile` returns the row with `is_epic = 0` → `!plan.isEpic` is **true** → `updateEpicStatus` is called → `is_epic = 1` → epic badge restored.

### Background

The `_recentRenames` set (line 32) is supposed to prevent delete events during renames, but it's only populated by `registerRename` — which is called for explicit extension-initiated renames, NOT for atomic writes by external tools. So the delete event from an atomic write is NOT suppressed.

`insertFileDerivedPlan`'s SQL (verified at `KanbanDatabase.ts` lines 1336-1350) does NOT include `is_epic` in its INSERT column list or conflict update set. On conflict (existing row), `is_epic` is preserved. On INSERT (new row), `is_epic` defaults to 0. The race causes an INSERT where an UPDATE was expected.

> **Clarification (verified, not a new requirement):** The same `insertFileDerivedPlan` INSERT also hardcodes `kanban_column = 'CREATED'` (line 1342) and omits `kanban_column` from its ON CONFLICT update set. So the identical race clobbers the epic's `kanban_column` back to `'CREATED'` on re-INSERT. Unlike `is_epic`, `_handlePlanFile` does NOT re-assert `kanban_column`. That clobber is the subject of `fix-epic-default-column-from-subtasks.md` — it is the SAME race, different column.

## Metadata

**Complexity:** 2
**Tags:** bugfix, backend, database, reliability

## User Review Required

Yes — confirm whether the residual `kanban_column` clobber (same race, tracked in the sibling plan) should be folded into this fix or kept separate. Both proposed changes here are already applied; the review is over the residual-risk documentation and the cross-plan dependency, not over new code.

## Complexity Audit

### Routine
- Single-concept race mitigation: make the `updateEpicStatus` call unconditional for files under `.switchboard/epics/`.
- One-line SQL conflict-clause change in a shared upsert constant (`UPSERT_PLAN_SQL`).
- Both changes are localized and idempotent (re-asserting `is_epic = 1` on an already-1 row is a no-op).

### Complex / Risky
- The fix is a **symptomatic** mitigation: the underlying DELETE-during-atomic-write race is still live and clobbers other columns (`kanban_column`, briefly `epic_id`/`project`) on re-INSERT. This plan only closes the `is_epic` vector.
- Brief inconsistency window: between the DELETE and the re-INSERT + `updateEpicStatus`, a concurrent reader (board refresh, `getSubtasksByEpicId`, integration sync) can see a missing row or a row with `is_epic = 0`.

## Edge-Case & Dependency Audit

**Race Conditions**
- The headline race: `_handlePlanDelete` + `_handlePlanFile` both debounced 300ms → concurrent fetch-then-write → DELETE then INSERT with column defaults. Mitigated for `is_epic` only.
- `_handlePlanDelete` re-invokes `_handlePlanFile` at line 706 on certain paths; the unconditional re-assert must remain safe under that re-entrant call (it is — idempotent).

**Security**
- None. No untrusted input reaches the changed paths; `updateEpicStatus` keys on `planId` derived from the filename UUID.

**Side Effects**
- `updateEpicStatus` calls `_persist()` (full DB serialize-to-disk). On rapid epic edits this runs once per debounced flush — acceptable and matches the existing pattern across all DB writes, but not free.
- The `UPSERT_PLAN_SQL` CASE change affects EVERY `upsertPlans` caller globally: any caller that previously relied on `isEpic: 0`/`undefined` clearing `is_epic` via the upsert path can no longer do so. Verified that `is_epic` clearing is owned by `updateEpicStatus(planId, 0, '')` (a dedicated UPDATE), not the upsert path — so no caller loses intended behavior.

**Dependencies & Conflicts**
- Shares the `UPSERT_PLAN_SQL` conflict-clause change with `fix-epic-loses-status-on-column-move.md` (same one-line edit, line 594). Already applied once; both plans must agree it is the canonical location.
- The `kanban_column` clobber from the same race is tracked in `fix-epic-default-column-from-subtasks.md`. Fixing `is_epic` without fixing `kanban_column` leaves the epic visually demoted to `CREATED` on edit even though the badge survives.

## Dependencies

- `fix-epic-default-column-from-subtasks.md` — same atomic-write race, different clobbered column (`kanban_column`). Should be implemented together to close the race for both vectors.
- `fix-epic-loses-status-on-column-move.md` — shares the `UPSERT_PLAN_SQL` `is_epic` CASE change (line 594); already applied.

## Adversarial Synthesis

Key risks: the unconditional `updateEpicStatus` closes the `is_epic` clobber but leaves the underlying atomic-write DELETE→re-INSERT race live, which clobbers `kanban_column` to `'CREATED'` (see sibling plan) and briefly drops the row for concurrent readers. The `UPSERT_PLAN_SQL` CASE change is already applied in code (line 594) — the original plan's "Still needed" label was stale and is corrected here. Mitigations: keep the unconditional re-assert (applied, correct); add a null guard on `updatedRecord` construction; treat the `kanban_column` clobber as a sibling plan rather than scope-creeping this one.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts` — `_handlePlanFile` (existing-record branch, line 609-620)

**Status: APPLIED.** Changed the conditional `updateEpicStatus` call to unconditional for epic files:

```typescript
// Before:
if (relativePath.startsWith('.switchboard/epics/') && !plan.isEpic) {
    await db.updateEpicStatus(plan.planId, 1, '');
    updatedRecord.isEpic = 1;
}

// After (APPLIED at lines 610-620):
// Always assert is_epic=1 for epic files. The conditional check on
// !plan.isEpic is unsafe: plan was fetched before insertFileDerivedPlan,
// and a concurrent _handlePlanDelete (from an atomic write: temp+rename)
// can delete the row between the fetch and the insert. insertFileDerivedPlan
// then INSERTs a fresh row with is_epic=0 (column default), but the stale
// plan.isEpic=1 skips updateEpicStatus — leaving the new row stuck at 0.
// Unconditional update is idempotent and cheap.
if (relativePath.startsWith('.switchboard/epics/')) {
    await db.updateEpicStatus(updatedRecord.planId, 1, '');
    updatedRecord.isEpic = 1;
}
```

Also changed `plan.planId` to `updatedRecord.planId` — `plan` is the stale pre-fetch, `updatedRecord` has the correct `planId` derived from the filename UUID.

**Residual edge case (not yet applied):** `updatedRecord` is built by spreading `plan` (line 601-608) in the existing-record branch, which is only reached when `plan` is non-null. The new-record branch (line 577-580) already has its own unconditional `updateEpicStatus`. A defensive null guard (`if (!plan) return;` before constructing `updatedRecord`) is belt-and-suspenders but not strictly required given the branch structure — note for the implementer.

### `src/services/KanbanDatabase.ts` — `UPSERT_PLAN_SQL` (line 592-594)

**Status: APPLIED (line 594).** The original plan labeled this "Still needed"; verified it is already in the code. Change the `is_epic` conflict clause from COALESCE to a preserve-unless-explicit pattern:

```sql
-- Before:
is_epic = COALESCE(excluded.is_epic, is_epic),

-- After (APPLIED at line 594):
is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END,
```

This prevents `upsertPlans` from clobbering `is_epic` to 0 when callers pass `isEpic: 0` or `isEpic: undefined` (which becomes `0` via `record.isEpic ?? 0` at line 1283). `COALESCE(0, 1)` returns `0`; the CASE expression preserves the existing value. Callers that need to clear `is_epic` use `updateEpicStatus(planId, 0, '')` (a dedicated UPDATE), not the upsert path.

## Verification Plan

> Compilation and automated tests are deferred to the user (run separately). The verification below is manual/observational.

### Automated Tests
- Deferred to user. No unit/integration/e2e tests are run as part of this plan session. Suggested coverage if added later: a watcher test that simulates an atomic write (temp+rename) of an epic file and asserts `is_epic = 1` persists without a panel reopen; a regression test that `upsertPlans` with `isEpic: undefined` does not clear an existing `is_epic = 1`.

### Manual Verification
- Edit an epic file with an external tool that does atomic writes → epic badge must persist on the board without panel reopen
- Edit an epic file in-place → epic badge must persist
- Create an epic via `create-epic.js` → `is_epic = 1` immediately and after board refresh
- Rapidly edit 3 epic files in succession → all 3 must have `is_epic = 1` after all edits complete
- Check DB after edits: `SELECT plan_id, is_epic FROM plans WHERE plan_id = '<epic_id>'` — must be `1`
- **Residual check (expected to still fail until the sibling plan lands):** after an atomic-write edit, confirm `kanban_column` is NOT clobbered to `'CREATED'`. If it is, that is the `fix-epic-default-column-from-subtasks.md` scope, not a regression of this fix.

---

## Reviewer Pass — 2026-06-28 (in-place reviewer-executor)

Adversarial review of the **actual `src/` code** against this plan's requirements. No compilation, automated tests, or state-mutating git per session policy.

### Stage 1 — Grumpy Principal Engineer

> *Cracks knuckles.* "A race condition 'fix' that admits in its own Goal that the underlying race is still alive. Bold. Let me find where the bodies are buried.
>
> **The headline fix:** you made `updateEpicStatus` unconditional for epic files. Fine. But you call it AFTER `insertFileDerivedPlan`. So if the malicious `_handlePlanDelete` slips in *between* the insert and the updateEpicStatus, your re-assert writes `is_epic = 1` onto a row that's about to be deleted, and then — poof — the delete lands and the row is gone entirely. Worse than `is_epic = 0`: now there's NO ROW. Did you even look at `_handlePlanDelete`? **CRITICAL (if true):** delete-last interleaving nukes the row permanently.
>
> **`_handlePlanDelete` itself (683):** it deletes the DB row on a delete event *without checking whether the file still exists on disk*. An atomic write is temp+rename — the real file is RIGHT THERE after the rename — and you blow away its row anyway, relying on `_recentRenames`, which your own Background section admits is only populated for extension-initiated renames, NOT external atomic writes. So the suppression you're counting on **does not fire for the exact scenario this plan exists to fix.** **MAJOR:** the delete guard is blind to on-disk reality.
>
> **`updateEpicStatus(updatedRecord.planId, 1, '')`** — you pass `epicId = ''`. That SQL is `SET is_epic = ?, epic_id = ?`. You're stamping `epic_id = ''` on the row every single time. If this is ever an epic that somehow carries an epic_id, you just wiped it. Prove epics never have an epic_id, or this is a silent data-clobber. **MAJOR.**
>
> **The null guard you waved off:** 'belt-and-suspenders, not strictly required given the branch structure.' Famous last words. If someone refactors that `if (!plan) / else` into something flatter, your `...plan` spread on line 622 NPEs. You're one careless edit from a crash and you *chose* not to add a one-line guard. **NIT, escalating to MAJOR if the branch ever moves.**
>
> **And the UPSERT CASE clause shared with the sibling plan** — same write-once-is_epic concern. Who clears the flag now?"

### Stage 2 — Balanced Synthesis

Running each Grumpy finding to ground against the code:

- **Delete-last interleaving nukes the row (CRITICAL-if-true) — REAL but CORRECTLY SCOPED OUT.** Traced `_handlePlanDelete` (`GlobalPlanWatcherService.ts:683-711`): it does NOT check `fs.existsSync` before deleting, and `_recentRenames` is only populated by `registerRename` (extension-initiated), so an external atomic-write delete event is NOT suppressed. If the debounced delete is processed *after* `_handlePlanFile`'s insert+`updateEpicStatus`, the row is deleted until the next `triggerScan`/panel reopen. **This is exactly the "underlying DELETE-during-atomic-write race is still live" that this plan's own Complexity Audit and Adversarial Synthesis explicitly declare out of scope** ("symptomatic mitigation… the underlying race is still live"). The plan closes the `is_epic = 0`-on-re-INSERT vector (the common case, where the delete lands *before* the insert), which is the documented goal. The delete-last full-row-loss case is rarer (requires the delete to win the debounce-flush ordering) and belongs to a broader watcher-race fix, not this plan. **No fix applied — honoring plan scope.** Logged as remaining risk #1 below with a concrete hardening suggestion.
- **`_handlePlanDelete` blind to on-disk reality (MAJOR) — REAL, OUT OF SCOPE.** A robust fix is `if (fs.existsSync(uri.fsPath)) return;` at the top of `_handlePlanDelete` (a delete event for a path that still exists ⇒ it was a rename, not a real delete). That is a behavioral change to the delete path that **neither this plan nor the sibling proposes**, has its own edge cases (the temp-file delete event carries a different path), and needs its own testing. Deliberately NOT applied here. Logged as remaining risk #1.
- **`epic_id = ''` clobber (MAJOR) — INVESTIGATED, NOT REAL.** Epics do not carry an `epic_id` — `epic_id` is the *subtask→epic* foreign key (a subtask's `epic_id` points at its epic's `plan_id`; see `getSubtasksByEpicId` `WHERE epic_id = ?`). An epic's own `epic_id` is empty by design, so `updateEpicStatus(planId, 1, '')` writing `epic_id = ''` on the epic row is a no-op-equivalent, not a clobber. Correct as written.
- **Missing null guard (NIT) — VALID, ACCEPTED AS-IS.** Confirmed the existing-record branch (the `else` at `GlobalPlanWatcherService.ts:605`) is only reachable when `plan` is non-null — the preceding `if (!plan) { …new-record… }` at line 535 owns the null case. So `{ ...plan }` at line 622 cannot spread null on the current control flow. The plan already reached this exact conclusion ("not strictly required given the branch structure"). Matches the verified code. No change.
- **UPSERT CASE write-once is_epic (shared concern) — NOT A DEFECT.** Same finding as the sibling plan: demotion is owned by `updateEpicStatus(planId, 0, '')`, never the upsert path. Documented contract at `KanbanDatabase.ts:592-594`. Verified.

### Bonus observation (outside this plan's two changes)

The watcher now ALSO calls `this._recomputeEpicColumn?.(...)` in **both** the new-record branch (`GlobalPlanWatcherService.ts:600`) and the existing-record branch (646), immediately after the `is_epic` re-assert. That is the sibling `fix-epic-default-column-from-subtasks.md` work — the `kanban_column`-clobber mitigation this plan deferred. It appears to have landed alongside these changes. So the "Residual check (expected to still fail)" bullet in the Verification Plan above may now PASS for epics that have subtasks (the column is re-derived after re-INSERT). For an epic with **no** subtasks yet, `_recomputeEpicColumn` is a documented no-op, so the `kanban_column='CREATED'` clobber from the delete-last race can still surface there. Out of this plan's scope; noted for the sibling plan's reviewer.

### Code Fixes Applied

**None.** Both of this plan's changes (`UPSERT_PLAN_SQL` CASE clause; unconditional `updateEpicStatus` for epic files, both branches, keyed off `updatedRecord.planId`) are correctly applied and verified. The one CRITICAL-shaped finding (delete-last row loss) is the live underlying race this plan *deliberately and explicitly* scopes out; fixing it would be scope-creep into the watcher's delete path. No source files modified.

### Files Changed (this reviewer pass)

- `.switchboard/plans/fix-create-epic-not-setting-is-epic.md` — added this Reviewer Pass section. No source files modified.

### Validation Results

- Compilation: SKIPPED (session policy).
- Automated tests: SKIPPED (session policy; user runs separately).
- Static verification (grep/read) performed:
  - `UPSERT_PLAN_SQL` `is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END` at `KanbanDatabase.ts:594`. ✓
  - New-record branch unconditional `updateEpicStatus(newRecord.planId, 1, '')` at `GlobalPlanWatcherService.ts:592-594`. ✓
  - Existing-record branch unconditional `updateEpicStatus(updatedRecord.planId, 1, '')` at `GlobalPlanWatcherService.ts:638-640` (keyed off `updatedRecord`, not stale `plan`). ✓
  - `insertFileDerivedPlan` INSERT omits `is_epic` (→ column default 0) and its ON CONFLICT set omits `is_epic` (→ preserved), confirming the race mechanism the fix targets (`KanbanDatabase.ts:1336-1350`). ✓
  - Existing-record `else` branch is null-safe by construction (guarded by `if (!plan)` at line 535). ✓
  - `updateEpicStatus` keys on `getPlanByPlanId(planId)` and `epic_id=''` is harmless for epics (`KanbanDatabase.ts:1470-1478`). ✓

### Remaining Risks

1. **Underlying atomic-write DELETE race is still live (accepted, documented):** if the debounced delete event is processed *after* `_handlePlanFile`'s insert+re-assert, the epic row is deleted until the next scan/panel reopen. Concrete hardening for a future plan: add `if (fs.existsSync(uri.fsPath)) return;` to the top of `_handlePlanDelete` so a delete event for a path that still exists on disk (the atomic-rename case) is ignored. Intentionally NOT applied here — out of this plan's scope.
2. **`kanban_column` clobber for subtask-less epics:** `_recomputeEpicColumn` is a no-op when the epic has no subtasks, so the `'CREATED'` clobber from the same race can still demote a freshly-created, subtask-less epic's column. Tracked in `fix-epic-default-column-from-subtasks.md`.
3. **Brief inconsistency window:** between the DELETE and the re-INSERT + re-assert, a concurrent reader (board refresh, `getSubtasksByEpicId`, integration sync) can momentarily see a missing row or `is_epic = 0`. Pre-existing; inherent to the symptomatic mitigation.
