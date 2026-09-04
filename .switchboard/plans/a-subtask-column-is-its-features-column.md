# A Subtask's Column Is Its Feature's Column

<!-- board-collapse-03 -->
> **RESCOPED 2026-09-04 (Board Collapse 03, decision 6).** **Keep** the exported `isFeatureSubtask` predicate, the handler-layer refusal of a lone subtask move in both hosts (naming detach as the escape hatch), and the exclusion of subtasks from every loose-work set — dispatch, queue pop, column-keyed candidate reads.
> > 
> > **Delete** change 5, "reconcile before enforcing". The single startup reconcile is owned by the sibling *Every Feature Move Carries Its Subtasks*, which must land first; this plan's own pass is a third copy of the same repair.


## Goal

Make feature containment an invariant rather than a convention. A subtask's
column is **derived from** its feature's, so an individual subtask cannot be
moved to a column of its own, and a subtask can never appear as a candidate in
any set that means "loose work waiting for an agent" — the board's columns, the
dispatch candidates, the queue pop, or a "dispatch what is coded" instruction.

### Problem & background

**The containment predicate exists, in exactly one place.** The rule "a subtask
is contained by its feature and must not also render as loose work" is written
down as `featureId && !isFeature` and enforced at precisely one call site:
`KanbanProvider._resolveStageablePlanIds` (`KanbanProvider.ts:8415`), which
refuses to stage a subtask into `STAGING`. Its own docblock states the contract
("Features stage as one card; subtasks never stage"), and
`KanbanDatabase.isMissionMember` (`:11640-11650`) cites it as the reference the
mission analogue is modelled on — calling it *"the containment predicate"*.

Every other path has no such check:

* **Column moves.** Nothing refuses moving one subtask on its own. On
  2026-08-18 the subtask `836dde1f-2b5a-403e-bed6-13852cb455fd` was moved to
  `CODER CODED` while its feature stayed elsewhere. Ten days later it was still
  there, alone, in a coding column.
* **Dispatch.** `POST /kanban/dispatch` applies no containment check, so a
  subtask is dispatchable as if it were loose work.
* **"The card in coded."** Any instruction or automation that resolves a set by
  column sees stranded subtasks as ordinary candidates. On 2026-08-28 exactly
  this happened: a controller told to dispatch the card in a coding column
  resolved to that stranded subtask and dispatched a review agent against it.

**Why "just cascade harder" is not the fix.** The sibling plan *Every Feature
Move Carries Its Subtasks* makes the feature drag its subtasks along. That fixes
divergence introduced **by feature moves**. It does not stop divergence
introduced **by moving a subtask directly**, and it does not stop a subtask from
being dispatched. The two plans close different doors; either alone leaves a
route to the same rogue card.

### Root cause

Containment is enforced as a **check some callers remember to make**, not as a
property of the data. Nine-ish paths read plans by column; one of them knows
about `featureId`. The predicate is not exported, not named, and not shared —
`KanbanProvider.ts:8415` spells it inline, and the only other mention is a
comment in a different file describing what it does.

---

## Metadata

**Complexity:** 6
**Tags:** backend, bugfix, reliability, database, api
**Project:** Browser Switchboard

---

## User Review Required

**None.** Decisions made here:

* **A direct subtask column move is refused, not silently redirected.** Moving a
  subtask alone is always a mistake; answering with a clear refusal that names
  the feature teaches the caller. Silently moving the whole feature instead
  would be a surprising write nobody asked for.
* **The operator keeps an escape hatch: detach.** A subtask that genuinely needs
  its own lifecycle is removed from the feature first, then moved. Detach already
  exists; the refusal message names it.
* **One exported predicate, no second copy.** `isFeatureSubtask(plan)` lives in
  one module and every path imports it, gated by a contract test that counts
  definitions — the same shape as `loopbackHostname`'s single-predicate gate.
* **Dispatch and pop exclude subtasks; the feature is the unit.** This matches
  the staging contract that already ships.

---

## Complexity Audit

* **Score:** 6 / 10

### Routine
* The predicate itself is one line and already written at `KanbanProvider.ts:8415`.
* A refusal branch in a move handler follows the shape of the existing
  `stageableColumns` refusal beside it.

### Complex / Risky
* **Finding every candidate-resolution path is the work.** Column-keyed reads
  are spread across `KanbanProvider`, `LocalApiServer` and the queue. Memory of
  this codebase records five separate builders of the dispatch plans array, each
  of which dropped epics independently — the same shape, and the reason this is
  a 6 rather than a 3. Enumerate by grepping for `kanban_column` reads, not by
  reasoning from the endpoints.
* **The board must still SHOW subtasks.** Containment excludes them from *loose
  work* sets, not from the UI — they render inside their feature. A predicate
  applied too broadly makes subtasks invisible, which is a worse bug than the one
  being fixed.
* **A cascade must not trip the refusal.** `cascadeFeatureByPlanId` writes
  subtask rows directly in SQL and must remain able to. The refusal belongs at
  the request/handler layer, above the DB primitive — not inside
  `KanbanDatabase`, or the cascade refuses itself.
* **Shipped state.** Features are on the board in released versions, and at least
  one workspace has a diverged subtask today. Turning on a refusal without
  reconciling first leaves that card unmovable by any route.
* **Two hosts, one choke point + one batch path.** Both hosts' webview-driven
  moves converge on `moveCardToColumnWithReason` — the refusal there covers both.
  But the standalone's `moveSessionsToColumn` (`bootstrap.ts:1282`) is a separate
  batch path that also moves subtasks without refusal. Both must be covered.

---

## Edge-Case & Dependency Audit

### Race Conditions
* A move arriving while a cascade is mid-transaction must see either the pre- or
  post-cascade column, never a half-applied family. `cascadeFeatureByPlanId` is
  already transactional and flushes before returning; the refusal reads after it.

### Security
* The refusal is an authorisation-shaped rule on an already-authorised endpoint.
  It must not leak whether a `planId` exists to an unauthenticated caller — reuse
  the existing not-found shape for unknown ids.

### Side Effects
* Any agent skill or script that moves a subtask directly starts receiving a
  refusal. A sweep of `.agents/` found no instruction that tells an agent to
  move a subtask card directly — the existing guidance says to move the feature.
  The sweep is a defensive verification, not a known-broken-text fix.
* `move-card.js` (the sanctioned manual path) gains the refusal, which is the
  point — but its error output must name the feature and the detach escape.

### Dependencies & Conflicts
* Sibling: **Every Feature Move Carries Its Subtasks**. Not blocking, but its
  reconciliation should land first in practice so no card is left unmovable. If
  this plan ships first, its own startup reconciliation covers the gap.
* Supersedes nothing. `feature_plan_20260626100853_subtask_column_not_syncing_with_epic.md`
  and `enforce-subtask-project-inherits-feature.md` are both shipped and
  epic-era; the latter is the closest template — same shape, for `project`
  instead of `kanban_column`. Read it before designing the refusal.

---

## Dependencies

_(None — this is a self-contained invariant-enforcement plan. No prerequisite
sessions. The sibling plan **Every Feature Move Carries Its Subtasks** is not
blocking; see Dependencies & Conflicts above for the landing-order note.)_

---

## Adversarial Synthesis

Key risks: (1) the orphan guard must be at the refusal site, not in the
predicate — a pure one-liner returns `true` for orphans, making them unmovable;
(2) `moveSessionsToColumn` in `bootstrap.ts` is a second standalone move path
that the original plan missed — without the refusal there, a batch-dispatched
subtask still moves freely; (3) enumerating every loose-work set by grep is the
core work — missing one leaves a dispatchable stranded subtask. Mitigations:
orphan guard as a separate DB lookup step; `moveSessionsToColumn` refusal in the
same change; grep-based enumeration with a contract test that counts covered
paths.

---

## Proposed Changes

### 1. One exported predicate

Add `isFeatureSubtask(plan): boolean` — `!!plan.featureId && !plan.isFeature` —
to `src/utils/featureContainment.ts`, following the `src/utils/loopbackHostname.ts`
single-predicate pattern (one exported function, one contract test that counts
definitions). The docblock states the contract: *a subtask is contained by its
feature; it renders inside the feature, it never counts as loose work.* Replace
the inline copy at `KanbanProvider.ts:8415` with an import.

**Edge cases — orphaned subtasks:** a plan whose `featureId` points at a feature
row that no longer exists is an orphan, not a subtask — it must be movable, not
refused. The pure predicate `!!plan.featureId && !plan.isFeature` returns `true`
for an orphan because it only inspects the plan's own fields. The orphan check
must therefore happen at the **refusal site**, not inside the predicate: before
refusing, look up whether the feature row exists (`db.getPlanByPlanId(plan.featureId)`).
If the feature is gone, treat the plan as loose (not a subtask) and allow the
move. The predicate itself stays pure and one-liner-shaped; the orphan guard is
a separate step at each refusal site.

### 2. Refuse a direct subtask column move

The move architecture converges on **one choke point**:
`KanbanProvider.moveCardToColumnWithReason` (`KanbanProvider.ts:8264`). Both
hosts reach it:

* **Extension:** `POST /kanban/move` in `LocalApiServer` delegates to a
  `moveCard` callback injected by `TaskViewerProvider` (`:3851`), which calls
  `moveCardToColumnWithReason`.
* **Standalone:** `POST /kanban/move` returns 503 (no `moveCard` callback is
  wired in `bootstrap.ts` options). Standalone webview moves go through
  `kanbanVerb` default → `kanbanProvider.handleServiceVerb` →
  `moveCardToColumnWithReason` — the same method.

Place the refusal in `moveCardToColumnWithReason`, in the `else` branch (line
8288) where non-feature plans are moved via `db.updateColumnWithReason`. When
`isFeatureSubtask(plan)` is true and the orphan guard passes (feature row
exists), refuse with a 4xx naming the feature and the detach escape:

> `Refused: '<subtask topic>' is a subtask of feature '<feature topic>' and takes
> its column from that feature. Move the feature, or detach the subtask first.`

The refusal lives above `KanbanDatabase` so `cascadeFeatureByPlanId` (which
writes subtask rows directly in SQL, bypassing the handler layer entirely) is
unaffected — the cascade never calls `moveCardToColumnWithReason`.

**Additional standalone path — `moveSessionsToColumn`** (`bootstrap.ts:1282`):
this is called from the team batch dispatch path (`:2356`). It checks
`isFeature` and cascades, else does `db.updateColumn(sid, targetColumn)` for
each non-feature plan. A subtask in the batch moves without refusal. Add the
same `isFeatureSubtask` + orphan guard check here, in the `else` branch, before
the `db.updateColumn` call.

**Edge cases:** a move whose target column equals the feature's current column
is a no-op, not a refusal — it asks for the state the invariant already wants.

### 3. Exclude subtasks from every loose-work set

Enumerate the candidate-resolution paths by grepping `kanban_column` reads, then
apply `isFeatureSubtask` to each that means "work awaiting an agent": dispatch
candidates, the queue pop, and the column-keyed reads any board-state export or
agent-facing listing uses. Do **not** apply it to the board's own rendering of a
feature's children.

**Edge cases:** a feature whose every subtask is coded is itself the candidate —
excluding subtasks must not make the feature un-dispatchable.

### 4. Verify `.agents/` guidance is consistent

A sweep of `.agents/` skill and workflow files found **no instruction that tells
an agent to move a subtask card directly.** The existing guidance already says to
move the feature (subtasks cascade) or use `POST /kanban/move` / `move-card.js`
(which inherits the cascade). This step is a **defensive verification**, not a
known-broken-text fix: confirm no skill or workflow text contradicts the refusal
by instructing a direct subtask move. If any is found, fix it in the same change.
If none is found (as expected), document the verification in the PR description.

### ~~5. Reconcile before enforcing~~ — REMOVED

> **Removed 2026-09-04 (Board Collapse audit).** The banner above deletes this change; it was left live in the body, wired into both composition roots, and asserted by verification 8 and goal invariant 5. This would have been the **third** startup reconcile of the same diverged state. The single pass belongs to *Every Feature Move Carries Its Subtasks*, which aligns subtasks **to** the feature and must land first. This plan enforces; it does not repair.

## Files Changed

* `src/utils/featureContainment.ts` — new (exported predicate)
* `src/services/KanbanProvider.ts` (refusal in `moveCardToColumnWithReason`, predicate import)
* `src/standalone/bootstrap.ts` (refusal in `moveSessionsToColumn`, reconciliation wiring)
* `src/services/LocalApiServer.ts` (dispatch/pop exclusion)
* `src/extension.ts` (reconciliation wiring)
* `.agents/` skill text (defensive verification only — fix only if contradicts)
* `src/test/feature-containment-contract.test.js` — new
* `package.json`, `.github/workflows/integration-tests.yml` (gate wiring)

---

## Verification Plan

### Automated

1. **One predicate.** Exactly one file defines `isFeatureSubtask`; no path
   re-spells `featureId && !isFeature` inline.
2. **A direct subtask move is refused** with a message naming the feature; a
   move of the feature still cascades; a move of a plain plan is unaffected.
3. **A no-op move is not refused** — target equal to the feature's column returns
   success.
4. **An orphaned subtask is movable** — `featureId` pointing at a missing feature
   is not refused by the move handler (the orphan guard at the refusal site
   allows the move).
5. **The cascade is not self-refused.** `cascadeFeatureByPlanId` moves subtask
   rows with the refusal active.
6. **Subtasks are absent from every loose-work set** — dispatch candidates, the
   queue pop, and each column-keyed listing — while the feature is present, and
   while the subtasks still render inside their feature.
7. **Both hosts refuse identically**: assert the refusal appears in
   `moveCardToColumnWithReason` (covers extension HTTP + webview, and standalone
   webview) and in `moveSessionsToColumn` (standalone batch path), and that
   reconciliation is wired in both composition roots.
8. **The invariant holds after reconciliation:** zero rows where a subtask's
   column differs from its feature's.
9. **Gate wiring.** The new script is invoked by CI, not merely defined.

### Goal Invariants

1. `isFeatureSubtask` is defined in exactly one file in `src/` (`src/utils/featureContainment.ts`).
2. The string `featureId && !isFeature` (or `feature_id` + `is_feature` inline containment logic) appears in zero files in `src/` outside `src/utils/featureContainment.ts` and test files.
3. A subtask move via `moveCardToColumnWithReason` returns `ok: false` when `isFeatureSubtask(plan)` is true, the feature row exists, and the target column differs from the feature's current column.
4. A subtask move via `moveCardToColumnWithReason` returns `ok: true` when the feature row does NOT exist (orphan guard).
5. Zero rows in `plans` where `feature_id != '' AND is_feature = 0 AND kanban_column != (SELECT kanban_column FROM plans WHERE plan_id = feature_id)` after reconciliation.

### Manual

1. Drag a subtask to another column on the board: refused, with a message that
   names the feature and tells you to detach.
2. Detach it, move it, re-attach: it takes the feature's column again.
3. With a feature in `CODE REVIEWED` and a stranded subtask reconciled, confirm
   no card in any coding column belongs to a feature.
4. Issue "dispatch the card in coded" against a board whose only coding-column
   card is a feature subtask: nothing is dispatched, and the reason says so —
   this is the exact 2026-08-28 misfire, reproduced.
5. Both hosts: the extension and `npx switchboard`.

---

## Recommendation

Complexity 6 → **Send to Lead Coder.**
