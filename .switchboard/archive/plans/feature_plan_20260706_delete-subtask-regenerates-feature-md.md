# Regenerate a feature's `## Subtasks` block when a subtask is deleted or detached

## Goal

Deleting (or detaching) a subtask from a feature must update the auto-generated
`<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->` … `<!-- END SUBTASKS -->`
block in the parent feature's `.md` file so it no longer lists the removed subtask.
Today the DB row and the subtask `.md` are removed, but the parent feature file keeps
listing the dead subtask until the next extension restart heals it.

### Root cause

The regenerator already exists and is **self-correcting**:
`KanbanProvider._regenerateFeatureFile(workspaceRoot, featurePlanId, db)`
(`src/services/KanbanProvider.ts:9821`, **private**) reads the *current* subtask set
from the DB (`db.getSubtasksByFeatureId(featurePlanId)` @9831, which filters
`WHERE feature_id = ? AND status = 'active'`), resolves the feature file via
`path.resolve(workspaceRoot, feature.planFile)` (@9833), splices new content between the
`BEGIN/END SUBTASKS` markers (@9850–9854), and skips the write if the result is
byte-identical (@9917–9919). So it *always produces correct output when called after the
subtask is gone* — it omits the deleted subtask automatically.

**The delete/detach paths simply never call it.** The one correct caller,
`KanbanProvider._removeSubtaskFromFeature` (`KanbanProvider.ts:9953`, public), shows the
required pattern: capture the parent `featureId` from the subtask record **before**
mutating (@9965 `const featureId = subtask.featureId`), perform the mutation
(@9966 `updateFeatureStatus(subtask.planId, 0, '')`), then call `_regenerateFeatureFile`
with the captured id (@9978). Because the parent link (`plans.feature_id`) is destroyed
by the delete, the `featureId` **must be captured before** the row/file is removed —
this is why a purely after-the-fact hook (e.g. only in the file-watcher) cannot recover
the linkage for the in-app delete paths.

### Subtask ↔ feature linkage (for reference)

- A subtask links to its feature via `plans.feature_id` (`TEXT DEFAULT ''`,
  `KanbanDatabase.ts:150`, indexed `idx_plans_feature_id` @566). A subtask's `feature_id`
  equals the feature's `plan_id`. There is **no** `is_subtask` column — a row is a subtask
  iff `feature_id` is non-empty, and a feature iff `is_feature = 1` (column @149; doc near
  `KanbanDatabase.ts:659–662`).
- On the record type `KanbanPlanRecord`, this surfaces as `featureId?: string`
  (`KanbanDatabase.ts:65`, mapped `featureId: String(row.feature_id || '')` @7043).
- To read a single plan's `feature_id` there is no single-column getter; use the full
  record getters `getPlanByPlanId(planId)` (`KanbanDatabase.ts:3192`) or
  `getPlanByPlanFile(planFile, workspaceId)` (`KanbanDatabase.ts:3213`) and read `.featureId`.
- `KanbanDatabase.forWorkspace(wsRoot)` (`KanbanDatabase.ts:844`) is a **per-workspace
  singleton** (cached in the static `_instances` map), and
  `KanbanProvider._getKanbanDb(wsRoot)` (`KanbanProvider.ts:1583`) returns that same
  singleton. **Invariant:** the `db` a caller obtains via `KanbanDatabase.forWorkspace(wsRoot)`
  (e.g. `PlanningPanelProvider` @3548) and the `db` obtained via
  `this._kanbanProvider._getKanbanDb(wsRoot)` are the same instance — so a capture read on
  one and a regen on the other share DB state. There is no cross-instance race.

### Stale-file sites (confirmed — none call regen today)

| # | Site | Location | Kind |
|---|------|----------|------|
| a | `PlanningPanelProvider.deleteKanbanPlan` | `src/services/PlanningPanelProvider.ts:3528` (delete @3549, unlink @3556) | in-app hard delete |
| b | `PlanningPanelProvider.removeSubtaskFromFeature` | `src/services/PlanningPanelProvider.ts:3640` (detach @3648, panel refresh @3649–3651) | detach — duplicate of the correct impl |
| c | `TaskViewerProvider._handleDeletePlan` | `src/services/TaskViewerProvider.ts:15097` (unlinks @15203–15222, DB delete @15302–15304) | in-app hard delete (kanban card) |
| d | `GlobalPlanWatcherService._handlePlanDelete` | `src/services/GlobalPlanWatcherService.ts:855` (row read @910, delete @923) | external/manual `.md` removal |

> **Line-number currency.** The line numbers above were pinned during the review pass on
> 2026-07-06. These source files are live-edited (a +26-line shift was observed in
> `GlobalPlanWatcherService.ts` *during* the review). When implementing, **locate each
> symbol by `grep` for its name** rather than trusting the number. Symbol names are stable;
> numbers are not.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, refactor, reliability

## User Review Required

Yes. Review focus:
- Confirm the **site c reorder** (DB-delete-before-unlink in `_handleDeletePlan`) and the
  associated **single hoisted `planRecord` read** do not regress the Linear/ClickUp
  fire-and-forget archive blocks (their `linearIssueId` / `clickupTaskId` must still be
  captured before the row is destroyed).
- Confirm Change 4's delegation preserves the **planning-panel webview refresh**
  (`kanbanPlansReady`) — see the gap noted in Adversarial Synthesis and Change 4.
- Confirm no `window.confirm` / confirmation gate is introduced anywhere (project rule:
  deletes are immediate).

## Complexity Audit

### Routine
- Adding the public `regenerateFeatureFile` wrapper (Change 1) — a 4-line mirror of the
  existing `regenerateAllFeatureFiles` (@9931). Trivial.
- Capture `featureId` before delete + regen after, at sites a and d — same
  capture-before-mutate-then-regen pattern as the verified reference (`_removeSubtaskFromFeature`).
- Injected regen callback + `extension.ts` wiring (Change 5) — mirrors the existing
  `setFeatureColumnRecomputer` injection (@69–72; wired @520).
- Change 4 delegation — replaces a duplicate body with a call to the shared method, same
  shape as the existing `TaskViewerProvider` delegation (@1042).

### Complex / Risky
- **Site c reorder + planRecord hoist** (`_handleDeletePlan`): the handler unlinks files,
  fires Linear/ClickUp archive, deletes runsheet, then deletes the DB row. Reordering to
  DB-delete-before-unlink, while keeping the archive blocks supplied with
  `linearIssueId`/`clickupTaskId`, requires fetching `planRecord` **once at the top** and
  reading all three IDs (`featureId`, `linearIssueId`, `clickupTaskId`) from it before any
  mutation. Moderate, well-scoped, but touches a busy handler with side effects.
- **Watcher-vs-in-app ordering interaction**: the reorder's purpose is to make the
  watcher's post-unlink read a no-op for in-app deletes so exactly one regen runs. This is
  an *optimization* (the byte-identical skip @9917 and idempotent `deletePlanByPlanId`
  @2365 already make the unordered path correct), but the implementer must understand the
  interaction to avoid reintroducing a double-regen.

## Edge-Case & Dependency Audit

### Race Conditions
- **Watcher vs in-app delete (sites a, c, d).** In-app deletes unlink the `.md`, which
  fires the watcher's `_handlePlanDelete`. If the DB row is already gone (DB-delete-first
  ordering), the watcher's `getPlanByPlanFile` (@910) returns null and it no-ops → exactly
  one regen (the in-app path's). If the row is still present (unlink-first, as site c is
  today), the watcher deletes the row and regenerates; the in-app path's subsequent
  `deletePlanByPlanId` (@2365) is an idempotent 0-row no-op, and the in-app regen is
  byte-identical-skipped (@9917). **Both orderings reach a correct end state**; the
  reorder only guarantees the single-regen property.
- **Atomic-write spurious-delete guard.** `_handlePlanDelete` already guards against
  temp-file+rename spurious deletes via `fs.existsSync(uri.fsPath)` (@892) checked *after*
  the 300ms debounce, plus a `_recentRenames` skip (@906). The new regen callback is only
  reached after these guards, so atomic writes do not trigger a spurious regen.
- **Concurrent feature-file edit.** `_regenerateFeatureFile` reads, builds, and writes the
  feature file; an external concurrent edit could in principle race. The existing
  `GlobalPlanWatcherService.registerPendingCreation(featureAbsPath)` (@9920) before the
  write suppresses the watcher's re-import of the self-write, and the byte-identical skip
  (@9917) prevents the self-write loop. No new race is introduced.

### Security
- No new attack surface. `regenerateFeatureFile` reads from the trusted local DB and
  writes the feature `.md` under the workspace — an existing, trusted path. No user input
  is interpolated into file paths beyond the already-trusted `feature.planFile`.
- **No confirmation dialogs are added anywhere** — deletes remain immediate (project rule;
  also `window.confirm` is a silent no-op in VS Code webviews).

### Side Effects
- Feature `.md` is rewritten on subtask delete/detach. `_regenerateFeatureFile` rewrites
  not only the `## Subtasks` block but also the `## Worktrees` block (@9856–9892) and the
  derived `**Complexity:**` marker (@9900–9907). **One regen call heals all three rendered
  sections.** An empty subtask set renders the placeholder `- [ ] (no subtasks)` (@9844).
- Board refresh (kanban webview) via `_refreshBoard` on the detach path.
- Planning-panel webview refresh via `kanbanPlansReady` post (must be preserved in
  Change 4 — see that change).
- Linear/ClickUp tracker unlink: Change 4's delegation to `_removeSubtaskFromFeature`
  additionally unlinks the detached subtask from external trackers (@9981–9987) and
  abandons its per-subtask worktree (@9970–9976) — both currently MISSING from the
  `PlanningPanelProvider` handler. Delegation fixes these too, not just regen.

### Dependencies & Conflicts
- Depends on the existing `_removeSubtaskFromFeature` reference pattern (@9953) and the
  private `_regenerateFeatureFile` (@9821). No new dependencies.
- **No schema migration**: this is a behavior change on delete/detach, not a change to any
  persisted file format or shipped DB schema. The feature `.md` format and the
  `BEGIN/END SUBTASKS` markers are unchanged.
- **Out of scope — orphan worktree row on hard delete.** Hard-deleting a subtask (sites a,
  c, d) leaves its `worktrees` row referencing a now-deleted `subtask_plan_id`. The detach
  path (`_removeSubtaskFromFeature` @9970–9976) abandons the worktree; the hard-delete
  paths do not. The rendered `## Worktrees` block self-heals (orphaned rows are omitted
  because the block is built from the *live* subtask set @9876–9881), but the DB row
  remains. This is **pre-existing** behavior (not introduced by this change) and is
  explicitly out of scope; flag for a follow-up if worktree hygiene on subtask delete is
  desired.

## Dependencies

None — this plan relies only on in-repo patterns (`KanbanProvider._removeSubtaskFromFeature`
@9953, `_regenerateFeatureFile` @9821). No cross-plan session dependencies.

## Adversarial Synthesis

Key risks: (1) the site-c reorder must hoist a **single** `planRecord` read to the top of
`_handleDeletePlan` so `featureId`, `linearIssueId`, and `clickupTaskId` are all captured
before the DB row is destroyed — the plan originally only mentioned `featureId`; (2)
Change 4's "drop the refresh code" would leave the **planning-panel** webview stale because
`_removeSubtaskFromFeature._refreshBoard` targets the kanban board, not the project panel —
the `kanbanPlansReady` post must be preserved; (3) all line numbers in the plan are stale
(the file drifted +26 lines mid-review) and implementers must locate symbols by `grep`.
Mitigations: one top-of-handler `planRecord` read feeding all three IDs; keep the
`kanbanPlansReady` post and drop only `updateFeatureStatus`; symbol-locate guidance and
reframing the reorder as an optimization (the byte-identical skip @9917 and idempotent
`deletePlanByPlanId` @2365 make the unordered path already correct).

## Proposed Changes

Follow the established `_removeSubtaskFromFeature` pattern at every removal site:
**capture `feature_id` before removal → remove → regenerate that one feature file.**
Regenerate the *specific* feature only — never the `regenerateAllFeatureFiles`
whole-directory sweep on each delete (it rewrites every feature `.md` and would risk the
file-churn / refresh-storm class of bug).

### `src/services/KanbanProvider.ts` — Change 1: expose a targeted public regen wrapper

`_regenerateFeatureFile` is `private`, so the other providers cannot call it. Add a thin
public wrapper next to it (mirrors the existing public `regenerateAllFeatureFiles` @9931
and `_removeSubtaskFromFeature` @9953, and reuses the private `_getKanbanDb` @1583 that
those methods already use):

```ts
/** Rewrite one feature's auto-generated ## Subtasks block from the live DB set. No-op if featureId is empty. */
public async regenerateFeatureFile(workspaceRoot: string, featureId: string): Promise<void> {
    if (!featureId) return;                       // non-subtask deletes carry no featureId
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !(await db.ensureReady())) return; // DB unavailable → nothing to regenerate against
    await this._regenerateFeatureFile(workspaceRoot, featureId, db);
}
```

`_regenerateFeatureFile` itself already bails if the feature row is missing (@9823) or not
a feature (@9827), and skips byte-identical writes (@9917), so this wrapper is safe to call
unconditionally with any captured id. **Clarification:** one call also heals the
`## Worktrees` block (@9856–9892) and `**Complexity:**` marker (@9900–9907).

### `src/services/PlanningPanelProvider.ts` — Change 2: `deleteKanbanPlan` (site a)

This handler currently does **not** read the plan row. Capture `feature_id` before the
delete, regen after. `wsRoot` (@3531), `db` (@3548) and `this._kanbanProvider` (field
@139, setter @172) are all in scope.

- Before `await db.deletePlanByPlanId(planId)` (@3549): `const rec = await db.getPlanByPlanId(planId); const featureId = rec?.featureId || '';`
- After the delete + unlink block, once the row is gone:
  `if (featureId) { await this._kanbanProvider?.regenerateFeatureFile(wsRoot, featureId); }`
- Keep the existing order **DB delete (@3549) → unlink (@3556)** (already correct — see
  ordering rule). Because `forWorkspace` is a singleton, the `db` here (@3548) and the
  `_kanbanProvider._getKanbanDb` db are the same instance — capture and regen share state.

### `src/services/TaskViewerProvider.ts` — Change 3: `_handleDeletePlan` (site c)

`resolvedWorkspaceRoot` (near @15097), `db` (@15231) and `this._kanbanProvider` (field
@387, setter @2119) are in scope; the handler already fetches `planRecord` via
`getPlanBySessionId` (@15238).

- **Hoist a single `planRecord` read to the top of the handler, before any unlink or DB
  delete.** `planRecord` is not only the `featureId` source — it also carries
  `linearIssueId` (used @15239) and `clickupTaskId` (used @15264) for the fire-and-forget
  Linear/ClickUp archive blocks. Fetch it once at the top and derive all three IDs:
  `const featureId = planRecord?.featureId || '';` (plus the existing `planRecord?.linearIssueId`
  / `planRecord?.clickupTaskId` reads, now sourced from the hoisted record). This is the
  critical refinement: the original plan mentioned only `featureId`, but the reorder
  invalidates the late `planRecord` fetch (@15238) for the archive IDs too.
- After the DB delete (@15302–15304):
  `if (featureId) { await this._kanbanProvider?.regenerateFeatureFile(resolvedWorkspaceRoot, featureId); }`
- **Reorder to DB-delete-before-unlink** (this handler currently unlinks files first
  @15203–15222, then deletes the row @15302). See ordering rule — the hoisted `planRecord`
  makes this safe for all three IDs regardless, but deleting the row before unlinking keeps
  the watcher path (site d) a clean no-op for in-app deletes and avoids a redundant regen
  write. **Note:** this reorder is an *optimization for the single-regen property*, not a
  correctness requirement — `deletePlanByPlanId` (@2365) is an idempotent `DELETE` (0-row
  no-op if the watcher already reaped the row) and the byte-identical skip (@9917) dedupes
  a double-regen. State it as such so reviewers do not block on it.
- **Brain-source / non-DB plans:** for plans with no kanban DB row, `planRecord` is null →
  `featureId` is `''` → the `if (featureId)` guard no-ops. No special-casing needed.

### `src/services/PlanningPanelProvider.ts` — Change 4: `removeSubtaskFromFeature` detach (site b) — fix + dedup

This webview handler (@3640) is a parallel re-implementation of the correct
`KanbanProvider._removeSubtaskFromFeature` but omits the regen **and** the worktree-abandon
**and** the tracker-unlink. Replace its body with a delegation to the shared public method
(which detaches, abandons the per-subtask worktree, regenerates, refreshes the board, and
unlinks from external trackers), exactly as `TaskViewerProvider.ts:1042` already does:

```ts
// case 'removeSubtaskFromFeature' in PlanningPanelProvider
const result = await this._kanbanProvider?._removeSubtaskFromFeature(wsRoot, subtask.planId);
```

Resolve `subtask.planId` the same way the current handler does (it already reads the
subtask @3646), or pass the subtask session id straight through — `_removeSubtaskFromFeature`
re-reads the record by id (@9961) and captures `featureId` itself (@9965). **Drop only the
`updateFeatureStatus` call (@3648).** Map `_removeSubtaskFromFeature`'s `{ success, error }`
to whatever webview response shape the handler returns to the front end.

> **Gap fixed vs. the original plan wording:** the original plan said "drop the now-dead
> local `updateFeatureStatus`/refresh code." Do NOT drop the refresh. `_removeSubtaskFromFeature._refreshBoard`
> (@9980) refreshes the **kanban board webview**, not the **planning-panel webview**. The
> `kanbanPlansReady` post (@3649–3651) is specific to this provider's `_projectPanel` and
> must be preserved, or the planning panel goes stale on every detach until a manual
> reload. Keep:
> ```ts
> const allPlans = await this._getKanbanPlans(wsRoot);
> const effectiveRoot = this._resolveEffectiveWorkspaceRoot(wsRoot);
> this.postMessageToProjectWebview({ type: 'kanbanPlansReady', plans: allPlans, workspaceRoot: effectiveRoot, requestId: Date.now() });
> ```
> **Bonus claimed explicitly:** delegating also fixes the missing per-subtask worktree
> abandon and the missing Linear/ClickUp tracker unlink — the current handler does neither.

### `src/services/GlobalPlanWatcherService.ts` — Change 5: `_handlePlanDelete` (site d) — external deletes

The watcher removes the DB row when a subtask `.md` is deleted directly on disk (agent,
git, manual `rm`). It holds **no** `KanbanProvider` reference — only injected callbacks
(e.g. `_recomputeFeatureColumn` wired via `setFeatureColumnRecomputer`, field @69–71, setter
@72). Add a parallel injected regen callback:

1. New field + setter on `GlobalPlanWatcherService`, mirroring the feature-column recomputer:
   ```ts
   private _regenerateFeatureFile?: (workspaceRoot: string, featureId: string) => Promise<void>;
   public setFeatureFileRegenerator(cb: (workspaceRoot: string, featureId: string) => Promise<void>): void {
       this._regenerateFeatureFile = cb;
   }
   ```
2. In `_handlePlanDelete` (@855), the plan row is already read at @910 (`plan`). Capture
   `const featureId = plan?.featureId || '';` **before** `deletePlanByPlanFile` (@923).
   After the delete: `if (featureId && this._regenerateFeatureFile) { await this._regenerateFeatureFile(workspaceRoot, featureId); }`
   Place the capture inside the `if (plan)` block (@911) but the regen call **after** the
   `deletePlanByPlanFile` (@923) and its `_onPlanDiscovered.fire` (@925). The
   `plan.status === 'completed'` skip (@913–916) returns before the delete, so no regen
   fires for archived/completed plans — correct.
3. Wire it in `extension.ts` alongside the existing `globalPlanWatcher.setFeatureColumnRecomputer(...)`
   call (@520) — that is the insertion point (not @781/@929; those are the unrelated
   `setKanbanProvider` calls, cited only as evidence the wiring pattern exists). At @520
   both `globalPlanWatcher` (@492) and `kanbanProvider` (@422) are in scope:
   ```ts
   globalPlanWatcher.setFeatureFileRegenerator((ws, fid) => kanbanProvider!.regenerateFeatureFile(ws, fid));
   ```

Because in-app deletes remove the DB row *before* the file is unlinked (ordering rule), by
the time the watcher fires on the unlink, `getPlanByPlanFile` (@910) returns null and
`_handlePlanDelete` bails early — so this callback runs **only** for true external
deletions, with no double regen for in-app deletes.

### Ordering rule (applies to sites a, c)

In-app delete paths must **delete the DB row before unlinking the `.md`**. Site a already
does (@3549 before @3556); site c must be reordered (Change 3). This guarantees the
watcher's post-unlink read (@910) finds nothing and no-ops, so exactly one regen runs per
in-app delete (the initiating path's own), and the watcher only regenerates for genuine
out-of-band file removals. **Clarification:** the reorder is an optimization; the
unordered path is already correct because `deletePlanByPlanId` (@2365) is idempotent and
the byte-identical skip (@9917) dedupes a double-regen.

## Files touched

- `src/services/KanbanProvider.ts` — add public `regenerateFeatureFile` wrapper (Change 1).
- `src/services/PlanningPanelProvider.ts` — capture+regen in `deleteKanbanPlan` (Change 2);
  delegate `removeSubtaskFromFeature` to the shared method, keeping the planning-panel
  refresh (Change 4).
- `src/services/TaskViewerProvider.ts` — hoist `planRecord`, capture+regen, and
  delete-before-unlink reorder in `_handleDeletePlan` (Change 3).
- `src/services/GlobalPlanWatcherService.ts` — injected regen callback + capture+invoke in
  `_handlePlanDelete` (Change 5, steps 1–2).
- `src/extension.ts` — wire `setFeatureFileRegenerator` to `kanbanProvider.regenerateFeatureFile`
  at @520 (Change 5, step 3).

## Verification Plan

### Automated Tests

No automated tests are added or run in this pass (per session directive: skip tests, skip
compilation). Verification is manual via an installed VSIX (`dist/` is not used in dev;
`src/` is the source of truth). If a regression test is desired later, the natural shape
is a KanbanDatabase-level test that seeds a feature + 2 subtasks, deletes one subtask,
calls `regenerateFeatureFile`, and asserts the feature `.md`'s `## Subtasks` block no
longer lists the deleted subtask and still lists the survivor.

### Manual verification (via installed VSIX)

Set up a feature with **two** subtasks (so a deletion leaves a visible survivor in the
block). For each removal entry point, confirm the parent feature `.md`'s `## Subtasks`
block drops the removed subtask and keeps the other:

1. **Site a** — delete a subtask from the Features/Project panel delete button.
2. **Site c** — delete the subtask's card from the kanban board; confirm the DB row is
   deleted before the file is unlinked (single regen, no watcher double-fire).
3. **Site b** — click "remove from feature" (detach) on a subtask; confirm the block
   updates, the subtask still exists as an unlinked plan, **and** the planning-panel
   webview refreshes (not just the kanban board).
4. **Site d** — with the extension running, delete a subtask `.md` directly on disk;
   confirm the watcher removes it from the block.
5. **Last-subtask case** — remove the final subtask; confirm the block renders the
   `- [ ] (no subtasks)` placeholder with markers intact and no stray entry.
6. **Non-subtask delete** — delete a standalone (non-subtask) plan; confirm no feature
   file is rewritten and no error is logged.
7. **Brain-source plan delete** — delete a plan with no kanban DB row; confirm `featureId`
   is empty, the `if (featureId)` guard no-ops, and no error is logged.
8. **Completed-plan external delete (site d guard)** — archive a subtask (status
   `completed`), then delete its `.md` on disk; confirm the watcher's completed-skip
   (@913–916) fires and no regen runs.

`npm run compile` is only needed when producing a VSIX for release; source under `src/`
is the source of truth for review.

---

**Recommendation:** Complexity 5 (Mixed) → **Send to Coder.**

## Review Findings

Files changed: `KanbanProvider.ts` (public `regenerateFeatureFile` wrapper, Change 1), `PlanningPanelProvider.ts` (capture+regen in `deleteKanbanPlan`; `removeSubtaskFromFeature` now delegates to `_removeSubtaskFromFeature` and keeps the `kanbanPlansReady` refresh, Changes 2+4), `TaskViewerProvider.ts` (`_handleDeletePlan` hoists a single `planRecord` read feeding `featureId`/`linearIssueId`/`clickupTaskId`, reorders DB-delete-before-unlink, regens after, Change 3), `GlobalPlanWatcherService.ts` (injected regenerator field/setter + capture-before-delete + post-delete regen, Change 5) and `extension.ts` (wires `setFeatureFileRegenerator`). Validation: all five changes present and correctly wired; the risky site-c hoist confirmed as a **single** `planRecord`/`db` declaration (no redeclaration, no duplicate delete block) with the fire-and-forget Linear/ClickUp archive blocks consuming the hoisted IDs, and `KanbanPlanRecord` carries the three optional-string fields so the reads typecheck. The watcher regen fires only for genuine external deletes (the `completed`-status skip precedes the capture, and in-app deletes null out `getPlanByPlanFile` via the ordering rule). Remaining risk: none material — the reorder is an optimization and the byte-identical-skip + idempotent `deletePlanByPlanId` make the unordered path correct regardless; the orphaned-worktree-row-on-hard-delete item remains explicitly out of scope. No CRITICAL/MAJOR issues found; no code fixes applied.
