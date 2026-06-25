# Fix: Epic Subtasks Leak Into Column-Batch Ops & Backlogging an Epic Orphans Its Subtasks

## Goal

In the Kanban board, "Advance All" (and the other column-batch actions) must operate **only** on the cards a user can actually see in that column. Today an epic's subtasks — which are hidden under their epic card — get swept into column-batch operations because each subtask carries its own `kanban_column`, independent of the epic's column. The deeper cause is that **moving an epic to BACKLOG (or back to CREATED) does not cascade to its subtasks**, so subtasks get stranded in an active column while their epic sits in BACKLOG.

Concretely: a BACKLOG epic ("design html code improvements") had 13 subtasks whose own `kanban_column` was still `CREATED`. "Advance All" on CREATED dispatched 3 of those subtasks to the planner terminals instead of the loose feature plans the user had just authored — and the limit-to-terminals + oldest-first sort meant the user's fresh plans were the ones held back.

### Problem Analysis & Root Cause

Two defects compound:

1. **Display-vs-data divergence (the leak).** The board webview hides subtasks from the main columns — `src/webview/kanban.html` (L5130): `displayCards = displayCards.filter(card => !card.epicId)`. But the backend `_lastCards` is a flat list built from every active row (subtasks included), each tagged with its own `kanban_column` — `src/services/KanbanProvider.ts` (L1220-L1236). Column-batch handlers selected source cards with `_lastCards.filter(card => card.column === column)` and **no `!card.epicId` exclusion**, so they re-admitted the subtasks the board had hidden.

2. **Missing backlog/activate cascade (the root cause).** `moveCardToColumn` (`KanbanProvider.ts` L4448-L4477) already cascades an epic move to its subtasks via `db.updateColumnWithEpicCascade(...)` (L4461-L4465). But the right-click actions `sendToBacklog` (L6375-L6385) and `sendToNew` (L6387-L6397) bypass it — they call `db.updateColumn(resolvedSessionId, ...)` directly on just the epic (L6381, L6393). So backlogging an epic moves only the epic; its subtasks stay where they were (CREATED), orphaned and free to be picked up by Advance All.

A model note: **the epic is a rigid unit — its subtasks always share its column, cascade on every move, and never appear as individual board cards.** Subtasks do not diverge across stages; the place to inspect or manage them is the **Epics tab**, not an on-board filter. (On-board epic *focus mode* is being removed — see `kanban-epic-focus-worktree-decouple.md`.) This fix enforces the data half: exclude subtasks from loose-column ops, and cascade the container's moves so subtasks follow it.

## Metadata

- **Tags:** `bugfix`, `backend`, `database`, `ui`
- **Complexity:** 4/10

## User Review Required

Yes — before implementation, confirm the **intended behavior change**: rerouting `sendToBacklog`/`sendToNew` through `moveCardToColumn` adds ClickUp/Linear integration sync (`queueIntegrationSyncForSession`, L4470) to backlog/new moves, which the direct `db.updateColumn` calls did not perform. This is judged **correct and desirable** (backlogging/activating is a real state change that integrations should reflect, and it makes backlog/new consistent with every other move path, which already sync). But it is a user-visible behavior change worth a conscious nod.

## Complexity Audit

### Routine
- Reroute `sendToBacklog` (L6375) and `sendToNew` (L6387) to call `moveCardToColumn` instead of `db.updateColumn` — two ~3-line edits in a single file.
- `moveCardToColumn` (L4448) and `updateColumnWithEpicCascade` (`KanbanDatabase.ts` L3757) already exist and are exercised by every other epic move path. No new logic.
- `_schedulePlanStateWrite` is a **disabled no-op** (L48-L57: `return;` on first line, "DISABLED: File-based state writes are deprecated") — so dropping its calls from the rerouted handlers changes nothing.
- The subtask-exclusion helper `_visibleColumnCards` (L360-L364) and the six column-batch call sites (§1) are already implemented and covered by the regression test.

### Complex / Risky
- **Integration-sync behavior change**: backlog/new moves will now fire `queueIntegrationSyncForSession` (ClickUp/Linear). Low risk (correct, consistent with other paths) but a behavior change that must be documented, not silently shipped.
- **`moveCardToColumnByPlanFile` (L4512-L4540) does NOT cascade** — it calls `db.updateColumnByPlanFile` directly (L4531), bypassing `updateColumnWithEpicCascade`. This is a latent orphaning gap on the planFile-based restoration path used by integration sync. **Out of scope for this plan** (not a user-initiated board move), but flagged as a related observation for a future fix.

## Edge-Case & Dependency Audit

- **Race Conditions**: `updateColumnWithEpicCascade` (`KanbanDatabase.ts` L3757-L3783) wraps the epic + subtask updates in a single `BEGIN`/`COMMIT` transaction with `ROLLBACK` on failure, so the cascade is atomic. No partial-move window.
- **Security**: No new surface. Session IDs are resolved via the existing `_resolveSessionId` helper.
- **Side Effects**: Rerouting adds `queueIntegrationSyncForSession` (ClickUp/Linear sync) to backlog/new moves — see User Review Required. `_schedulePlanStateWrite` calls being dropped are no-ops (disabled). `moveCardToColumn` does NOT call `this.refresh()`, so the rerouted handlers must keep their existing trailing `this.refresh()` call.
- **Dependencies & Conflicts**: Depends on the already-merged §1 work (`_visibleColumnCards` + six call sites + regression test). Relates to `kanban-epic-focus-worktree-decouple.md` (removes on-board focus mode, making the `!card.epicId` exclusion unconditional) and `feature_plan_20260625081837_epics-as-orchestration-onramp.md` (Epics tab as sole inspection surface).
- **Subtask rows still carry their own `kanban_column` in the DB** — a legacy of the schema, not a feature (with focus mode removed, subtasks never render as cards, so the stored column is never user-facing). The fix does NOT rely on that column for display; it (i) excludes subtasks from loose-column ops and (ii) cascades the *container*'s moves so each subtask's stored column stays in lockstep with its epic on **every** move.
- **No focus-mode exception (model change).** On-board epic-focus mode is being removed (`kanban-epic-focus-worktree-decouple.md`), so the `!card.epicId` exclusion is now **unconditional** and correct — subtasks never appear as column cards, so there is no focus-mode Advance-All to preserve. The focus-aware column-button work this plan originally proposed (§3) is therefore dropped.
- **Selection-based handlers must NOT exclude subtasks.** Explicit `msg.sessionIds` / `_cardMatchesIds` handlers (drag-drop move, `moveSelected`, `promptSelected`, chat copy, lead pair-programming) trust the IDs the user picked. Leave them untouched.
- **Epic card itself is not a subtask** (`epicId` empty, `isEpic` true), so `!card.epicId` keeps epic cards in column ops; advancing a column containing an epic still cascades via `moveCardToColumn`.
- **Completed subtasks** carry `epicId` too and are correctly excluded from active-column ops.
- **`sendToNew` symmetry.** Activating an epic out of BACKLOG should also bring its subtasks back to CREATED, otherwise un-backlogging leaves subtasks behind in BACKLOG. Cascade both directions.
- **Cross-workspace / ghost plans** — out of scope; pre-existing behavior unchanged.

## Dependencies

- None (session-independent). §1 (exclusion + helper + test) is already implemented in the working tree.
- Relates-to: `kanban-epic-focus-worktree-decouple.md` (removes on-board focus mode) and `feature_plan_20260625081837_epics-as-orchestration-onramp.md` (Epics tab becomes the sole epic-inspection surface).

## Adversarial Synthesis

Key risks: (1) stale line-number citations in the original plan pointed at the wrong handler (`sendToBacklog` was cited as ~L6257, which is actually `recoverPlan`) — corrected to verified current lines. (2) The plan's open "Decision point" about `_schedulePlanStateWrite` divergence is moot — that function is a disabled no-op (L56), so rerouting through `moveCardToColumn` is strictly a superset and no shared helper is needed. (3) Rerouting silently adds ClickUp/Linear integration sync to backlog/new moves — documented as an intended, correct behavior change (consistent with all other move paths). Mitigations: fix all citations, drop the dead `_schedulePlanStateWrite` calls, keep the trailing `this.refresh()`, extend the regression test to assert §2 routing, and flag the out-of-scope `moveCardToColumnByPlanFile` non-cascade as a related observation.

## Proposed Changes

### 1. Shared source-card helper — `src/services/KanbanProvider.ts` — DONE (this session)

Added `_visibleColumnCards(workspaceRoot, column)` (L360-L364) returning `_lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column && !card.epicId)`, with a doc comment tying it to the webview display contract (`kanban.html` L5130). Applied at all six column-batch sites:
- `batchPlannerPrompt` (L5626, CREATED), `batchLowComplexity` + Jules dispatch (L5654/L5682, PLAN REVIEWED low-complexity), `moveAll` (L5823), `promptAll` (L6056), `completeAll` (L6240).
Also added `if (c.epicId) return false;` to the two per-role prompt-preview filters (L2635-region) so previews match what dispatch sends. Regression test: `src/test/kanban-subtask-column-leak-regression.test.js` (passing).

### 2. Cascade on **every** epic move — `src/services/KanbanProvider.ts` — PENDING

Model: an epic is rigid, so **every** move of an epic card cascades to its subtasks. `moveCardToColumn` (L4448-L4477) already does this via `updateColumnWithEpicCascade`; the gap is the two handlers that bypass it with a direct `db.updateColumn(...)`. Reroute `sendToBacklog` (L6375-L6385) and `sendToNew` (L6387-L6397) through `moveCardToColumn`.

**Verified audit of all other epic move paths** — every one already routes through the cascading `moveCardToColumn`; no other bypassers exist among user-initiated board moves:
- `moveCardForward` (L5228), `moveCardBackwards` (L5214), `moveSelected` (L5718), drag-drop advance (L5133, L5599), `moveAll` PLAN-REVIEWED branch (L5845) + general branch (L5911), `promptAll` branches (L5782, L6032), `_distributePlannerDispatch` (L3437, L3478).
- Out-of-scope note: `moveCardToColumnByPlanFile` (L4531) calls `updateColumnByPlanFile` directly (no cascade) — used by integration-sync restoration, not user board moves. Flagged for a future fix, not touched here.

```ts
case 'sendToBacklog': {
    const resolvedRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!resolvedRoot) break;
    const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
    if (!resolvedSessionId) break;
    // Route through moveCardToColumn so an epic move cascades to its subtasks
    // (updateColumnWithEpicCascade). moveCardToColumn also queues ClickUp/Linear
    // integration sync — a correct, intended behavior change (backlogging is a
    // real state change). The previous direct db.updateColumn + _schedulePlanStateWrite
    // calls are dropped: _schedulePlanStateWrite is a disabled no-op (L48-L57).
    await this.moveCardToColumn(resolvedRoot, resolvedSessionId, 'BACKLOG');
    this.refresh();
    break;
}
```

Same for `sendToNew` with `'CREATED'`. This replaces the direct `db.updateColumn(...)` + `_schedulePlanStateWrite(...)` calls.

> **Decision point — RESOLVED.** The original plan asked whether `moveCardToColumn` performs the same side effects as `sendToBacklog`/`sendToNew`. Verified: `_schedulePlanStateWrite` is a **disabled no-op** (L48-L57: `return;` immediately, "DISABLED: File-based state writes are deprecated"), so the file-state mirror concern is moot. `moveCardToColumn` is strictly a superset — it does the DB column update + epic cascade + integration sync. No `moveEpicOrPlan` shared helper is needed. The only behavior change is the added integration sync (documented above as intended).

### 3. Focus-aware column buttons — **DROPPED**

This step originally added a focus-mode branch to the column-action handler so focus-mode Advance All would target the focused epic's subtasks. **On-board focus mode is being removed** (`kanban-epic-focus-worktree-decouple.md`), so there is no focus path to support and the unconditional `!card.epicId` exclusion from §1 is the complete, correct behavior. No change to the column-action handler is needed for epics.

## Verification Plan

### Automated Tests

- **Regression test:** `node src/test/kanban-subtask-column-leak-regression.test.js` (already passing for §1). **Extend** it with §2 assertions matching the existing source-pattern style:
  - The `sendToBacklog` case block must contain `moveCardToColumn(` and must NOT contain `db.updateColumn(resolvedSessionId`.
  - The `sendToNew` case block must contain `moveCardToColumn(` and must NOT contain `db.updateColumn(resolvedSessionId`.
  - This gives the §2 reroute deterministic coverage without a live DB harness.
- **Build:** `npm run compile` — no new TS errors (pre-existing `ArchiveManager` module-resolution error is unrelated). *(Skipped this session per directive; run before VSIX release.)*
- **Test suite:** *(Skipped this session per directive; run separately.)*

### Manual (installed VSIX)
1. Create an epic with several subtasks; subtasks land in CREATED, epic in CREATED.
2. Send the epic to BACKLOG → confirm **all** subtasks follow it to BACKLOG (DB: `SELECT kanban_column FROM plans WHERE epic_id=?`).
3. Send the epic back to New → subtasks return to CREATED.
4. With the epic in BACKLOG and 2 loose standalone plans in CREATED, click **Advance All** on CREATED → only the 2 standalone plans dispatch; no subtasks.
5. Advance an epic (with subtasks) forward a column → **all** its subtasks cascade with it (DB: `SELECT kanban_column FROM plans WHERE epic_id=?` all match the epic's new column); subtasks never appear as separate column cards.
6. **DB cross-check** for the original repro (epic `3051b25c`): after backlog, no subtask of that epic should remain in CREATED/PLAN REVIEWED.

## Status

- §1 (exclusion + previews + test) — **implemented & verified** in working tree. The exclusion is now **unconditional** (no focus exception). All six column-batch call sites confirmed routing through `_visibleColumnCards`. Per-role preview guards confirmed (`if (c.epicId) return false;` ×2).
- §2 (cascade on every epic move) — **implemented & verified**. `sendToBacklog` (L6379) and `sendToNew` (L6388) rerouted through `moveCardToColumn`. Dead `_schedulePlanStateWrite` calls dropped. Trailing `this.refresh()` preserved. Integration-sync behavior change documented.
- §2b (completeAll epic cascade — **added during review**) — **implemented & verified**. The original plan's audit claimed "no other bypassers exist among user-initiated board moves," but `completeAll` (L6240) called `dbAll.updateColumn(cardKey, 'COMPLETED')` directly, bypassing the epic cascade. Fixed: `completeAll` now branches on `card.isEpic` and uses `dbAll.updateColumnWithEpicCascade` for epic cards so subtasks follow to COMPLETED. Regression test extended with assertion #6.
- §3 (focus-aware column buttons) — **dropped** (on-board focus mode is being removed).

### Review Results (2026-06-25)

**Stage 1 (Grumpy):**
- §1: Correct. No findings.
- §2: Correct. No findings.
- MAJOR: `completeAll` bypassed epic cascade — same orphaning class as the `sendToBacklog`/`sendToNew` bug this plan fixes. The plan's audit claim ("no other bypassers exist") was false.
- NIT: Regression test lacked `completeAll` cascade assertion.

**Stage 2 (Balanced):** MAJOR fixed now (trivial — `card.isEpic` branch + `updateColumnWithEpicCascade`). NIT fixed now (test assertion #6 added).

**Files changed during review:**
- `src/services/KanbanProvider.ts` — `completeAll` handler (L6249-L6269): added `card.isEpic` branch with `getSubtasksByEpicId` + `updateColumnWithEpicCascade` for epic column updates.
- `src/test/kanban-subtask-column-leak-regression.test.js` — added assertion #6: `completeAll` must contain `updateColumnWithEpicCascade(` and `card.isEpic`.

**Validation:**
- Regression test: `node src/test/kanban-subtask-column-leak-regression.test.js` → **PASS** (all 6 assertion groups).
- Compilation: skipped per directive.
- Test suite: skipped per directive.

**Remaining risks:**
- `uncompleteCard` (L6270) also calls `db.updateColumn(sessionId, targetColumn)` directly without cascade — but it's a **selection-based handler** (uses explicit `msg.sessionIds`), which the plan explicitly leaves untouched. If the user un-completes an epic, subtasks won't follow back. Flagged as a related observation, not fixed (consistent with plan's selection-handler policy).
- `moveCardToColumnByPlanFile` (L4511) still doesn't cascade — out of scope, flagged in original plan.
- Integration sync now fires on backlog/new/complete-epic moves — documented as intended. No risk identified.

**Recommendation:** Complexity 4/10 → **Ready for release** after manual VSIX verification (see Verification Plan §Manual). All code changes verified; remaining risks are out-of-scope selection-handler and planFile-path gaps documented in the plan.

Depends-on: none. Relates-to: `kanban-epic-focus-worktree-decouple.md` (removes on-board focus mode) and `feature_plan_20260625081837_epics-as-orchestration-onramp.md` (the Epics tab becomes the sole epic-inspection surface).
