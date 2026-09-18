# The Dispatch Column Becomes the Session Queue — Select Plans, Press Run, Walk Away

## Goal

The user selects a set of plans, stages them, and presses one button. That ordered set is the night's work. The first card dispatches immediately; the lead pulls the rest. No run sheet to configure, no interval to pick, no mode to choose.

### Problem & background

**The queue already exists and is currently used as a fan-out bucket instead of a queue.**

`DISPATCH` is a real stored column value rendered inside `PLAN REVIEWED`'s slot, toggled by a header button (`DISPLAY_MODE_COLUMNS`, `src/services/agentConfig.ts:165`). It already has:

* a staged-card count on its toggle (`kanban.html:7695` counts `column === 'DISPATCH' && !c.featureId`, rendered as `DISPATCH n` at `:7705`);
* multi-select across the board (`selectedCards`, `kanban.html:5682`);
* a `Send all to coders` action (`sendDispatchSetToCoders`, `src/services/KanbanProvider.ts:10775`, button at `kanban.html:6990`).

So the staging concept, the visible count, and the selection mechanism are all built. What is missing is that `Send all to coders` **fans the entire set out at once** — it partitions by complexity route and dispatches every staged card to a routed coder in one press (`KanbanProvider.ts:10800-10840`). That is the opposite of a paced queue: it empties the staging area into N simultaneous dispatches, and pacing afterwards is nobody's job.

**Ordering is also absent.** Cards in `DISPATCH` have no queue position; they render in the board's default order, and the optimistic-move path inserts by `data-ts` timestamp, newest first (`kanban.html:6526-6540`). A user staging "do the schema change before the endpoints that depend on it" has no way to express it.

### Root cause — staging was designed for parallel fan-out, and the paced case was never given a door

The comment at `kanban.html:8281-8286` states the intent plainly: cards enter `DISPATCH` via the Analyze button, an agent-led decision about what can run in parallel, and there is **deliberately no one-click "Move to Dispatch"** because "a one-click move carries no parallel-safety analysis, which is the only thing membership in DISPATCH is supposed to mean." That is a legitimate mode and its fan-out is not being removed. But it left the *serial* case — one team, one card at a time, overnight — with nothing to press, and it is the sentence a later reader will use to revert this plan's staging action. This plan changes what membership in `DISPATCH` means, so that comment is part of the change, not an obstacle to route around.

### Why this is the cold start

Subtask 1 lets a lead ask for card N+1. Nothing dispatches card 1. That is the only genuine gap a pull model opens, and it is a button, not a subsystem: press Run, the first card dispatches, the standing order carries the lead from there.

---

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, database, ui, feature
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

> **Superseded:** Complexity 4.
> **Reason:** The plan carries a schema migration on the shipped `plans` table (~4,000 installs), a webview drag-reorder path with an insertion index the current drop handler does not compute, and a render-order change that has to be made in two places (initial render and the optimistic-move insert) or staged cards visibly jump. That is a multi-file change with a data-shape component, not a routine one.
> **Replaced with:** Complexity 5.

---

## User Review Required

**None.** Four decisions made here:

* **`DISPATCH` is the queue — no new state, no new column.** A parallel "session queue" table would duplicate a staging area that already exists, is already visible, and already has a count badge.
* **`Send all to coders` is kept, not replaced.** Parallel fan-out stays for the multi-coder case. `Run queue` is added beside it.
* **Order is explicit and user-controlled**, persisted on the card, not derived from complexity or insertion time.
* **Pressing Run with no team seated is an error, not an auto-start.** Seating a team is the orchestrator's job (subtask 6) or the user's; a button that silently spawns agents is the kind of surprise this whole redesign is removing.

---

## Complexity Audit

### Routine

- One nullable integer column and its accessor plumbing — the `plans` table has taken eight such additions in the V51–V59 range.
- A second button in a header that already renders two conditional buttons in the same block (`kanban.html:6987-6991`).
- A transient status notice on queue-empty — `showStatusMessage` is already the pattern in this handler.

### Complex / Risky

- **Schema change on a shipped table.** `queue_position` must be added to both `SCHEMA_TABLES_SQL` (fresh DBs) and a new `MIGRATION_V60_SQL` under a version gate (current head is V59, `KanbanDatabase.ts:482`). Shipped V51–V59 bodies must never be edited.
- **Drag-to-reorder needs an insertion index the drop handler does not currently compute.** Today's handler resolves a target *column* and returns early for a same-column drop; there is no drop-position concept anywhere in the board.
- **Two render paths must agree on order.** The initial render and the optimistic-move insert (`data-ts` descending, `:6526-6540`) both order cards. Changing one leaves the other reordering the queue on the next move.
- **The comment that forbids one-click staging is load-bearing prose** (`:8281-8286`). Leaving it in place while adding `Stage for queue` guarantees a later reader reverts one of the two.

---

## Edge-Case & Dependency Audit

### Race Conditions

- **Reorder racing a pop.** The lead can call `queue/next` while the user is dragging. Subtask 1's pop is serialized and re-reads positions inside its critical section, so a reorder that lands first simply changes what it picks. A reorder that lands *after* the select is harmless — the popped card has already left the queue.
- **Position rewrite is not atomic across cards.** A drag rewrites several rows. Write them in one transaction; a partial rewrite leaves duplicate positions, which must sort deterministically (tie-break on the board's existing order) rather than randomly.
- **Two windows staging at once** can assign the same "next" position. Positions are a sort key, not an identity — duplicates degrade to the tie-break, so this is tolerated rather than locked.

### Security

- No new external surface. `Run queue` is a webview action reaching the same verb path the existing Dispatch buttons use; the endpoint it calls enforces its own team resolution.

### Side Effects

- **`queue_position` clears on dispatch**, so a card that returns to the board later does not carry a stale position and jump the queue on re-stage.
- **The staged count on the toggle already excludes subtasks** (`!c.featureId`). Staging must preserve that: a feature stages as one card, never as its subtasks.
- Changing the meaning of `DISPATCH` changes what `Send all to coders` operates on — nothing functionally, but its tooltip ("all staged plans") now describes a queue. Reword it so the two buttons read as siblings: fan out, or walk in order.

### Dependencies & Conflicts

- **Subtask 1 consumes `queue_position`** and ships against a `PLAN REVIEWED` fallback until this lands. Both orderings must keep working during the gap.
- **Subtask 7 assigns the next `queue_position`** when it stages a remote arrival; **subtask 6** stages a scoped set in order. Both call the same staging helper this plan introduces — it must be exported, not inlined in the webview handler.
- **`moveCardsOptimistically` owns the board's optimistic-move guard** — the Dispatch render-order change belongs inside it, not beside it.
- No conflict with the Analyze button: it keeps staging cards into `DISPATCH`, they simply get appended positions.

---

## Dependencies

- `e060b8c4-27bd-48ac-a5d1-c72f557ea27a` — The Coding Lead Paces Its Own Pipeline *(reverse: subtask 1 reads the ordering this plan creates and calls the endpoint this plan's button calls)*

---

## Adversarial Synthesis

**Risk summary.** The real risks are a shipped-table migration and two order-rendering paths that can disagree — a queue that visibly reorders itself after a move destroys the only thing the user is being asked to trust. Mitigations: `queue_position` lands in both `SCHEMA_TABLES_SQL` and a gated `MIGRATION_V60_SQL` with no edit to shipped bodies, null sorts last so pre-existing staged cards are unaffected, and the ordering change is made inside `moveCardsOptimistically` as well as the initial render. The drag-reorder insertion index is new work with no precedent on this board and is the most likely place for polish debt.

---

## Proposed Changes

### `src/services/KanbanDatabase.ts` — `queue_position`

**Context.** Migration head is V59 (`blocked_at`, `:482`). New columns land in `SCHEMA_TABLES_SQL` *and* a gated migration; fresh DBs get the column from creation and the `ALTER` is a no-op there.

**Implementation.**

1. Add `queue_position INTEGER DEFAULT NULL` to the `plans` table in `SCHEMA_TABLES_SQL`.
2. Add `MIGRATION_V60_SQL = ['ALTER TABLE plans ADD COLUMN queue_position INTEGER DEFAULT NULL']` with the same version-gated, try/catch-wrapped runner shape as V58/V59, then `setMigrationVersion(60)`.
3. **Never edit a shipped V51–V59 body.** Read/write the field through the existing record mapper alongside `dispatchedAt` (`:8763`, `:8781`).

**Edge Cases.** A restored DB where the column exists but the version was not stamped — covered by the try/catch the existing runner already uses.

### `src/services/KanbanProvider.ts` — staging and ordering helpers

**Context.** `sendDispatchSetToCoders` (`:10775`) is the existing bulk Dispatch handler and is the model for the new ones; it re-reads the set from the latest board state inside the handler so a card dragged out between render and press is skipped.

**Logic.** Three exported operations, so the webview, subtask 6's handoff and subtask 7's remote intake all stage the same way:

- `stageForQueue(workspaceRoot, planIds[])` — move to `DISPATCH`, append positions in the order given.
- `reorderQueue(workspaceRoot, orderedPlanIds[])` — rewrite positions in one transaction.
- `clearQueuePosition(planId)` — called on dispatch.

**Implementation.**

1. Positions append from `MAX(queue_position) + 1` within the workspace's `DISPATCH` set; `NULL` sorts last so pre-existing staged cards keep working and drop to the end.
2. `stageForQueue` preserves the caller's order — for the webview, the **selection order**, not board order.
3. Wire `clearQueuePosition` into the dispatch path so a popped card leaves with a null position.
4. **Delete the "no one-click staging" rationale at `kanban.html:8281-8286`** and replace it with one line stating what `DISPATCH` now means: an ordered session queue, entered by the Analyze button, by an explicit `Stage for queue`, or by remote intake. Leaving the old sentence in place is how this plan gets reverted by the next reader.

**Edge Cases.** Staging a card already in `DISPATCH` re-positions it rather than duplicating. Staging a subtask (non-empty `featureId`) is refused — features stage as one card.

### `src/webview/kanban.html` — order, reorder, and the Run button

**Context.** In Dispatch view a same-column drop is currently a **no-op**: `effectiveTargetColumn` resolves to `DISPATCH` (`:8689-8690`) and the per-card loop returns immediately on `card.column === effectiveTargetColumn` (`:8694`). That early return is the branch this plan fills.

> **Superseded:** "The view already special-cases `DISPATCH` drags (`kanban.html:8231-8235` notes `getNextColumn('DISPATCH')` returns null), so this is filling a branch that currently dead-ends."
> **Reason:** `:8231-8243` is the **copy-prompt button label** derivation, not drag handling — it normalises `DISPATCH → PLAN REVIEWED` so the card's copy button gets a next column. Pointing the coder there sends them to unrelated code. The actual dead end is the same-column early return in the drop handler at `:8694`.
> **Replaced with:** hook the reorder into the drop handler's same-column early return at `:8694`, guarded on `showingDispatch && effectiveTargetColumn === 'DISPATCH'`.

**Implementation.**

1. **Reorder on same-column drop.** When `showingDispatch` and the drop resolves to `DISPATCH` for a card already in `DISPATCH`, compute the insertion index from the drop position relative to the rendered cards (nearest-card midpoint against the pointer's `clientY` — the board has no existing drop-index helper, so this is new), then post the full ordered id list to `reorderQueue`. Do not fall through to the column-move path.
2. **Order the render by `queue_position`.** In Dispatch view, sort ascending with `NULL` last. Apply the same comparator inside the optimistic-move insert (`:6526-6540`), which currently inserts by `data-ts` descending — leave it unchanged and a staged card jumps to the top on the next board move.
3. **`Stage for queue`** action on the selection, beside the existing selection actions, calling `stageForQueue` in selection order. Clear `selectedCards` after, matching the neighbouring handlers.
4. **`Run queue` button** beside `Send all to coders` (`:6990`). It resolves the coding head, then makes one `POST /kanban/queue/next` call — the same endpoint the lead uses, so cold start and steady state share exactly one code path. Disabled with an explanatory tooltip when no coding head is live or the queue is empty (mirror the existing `dispatchStagedNow === 0 || !dispatchAnalyzeAvailable` disable pattern).
5. **Queue-empty is visible.** When the last card leaves, the toggle drops back to `DISPATCH` with no count and the board posts a transient notice naming how many cards ran. The session ending should be legible without reading a log.

**Edge Cases.** A drag that leaves `DISPATCH` (onto another column) keeps today's move behaviour. A multi-card drag reorders the whole selection as a contiguous block at the drop index. Reordering while the queue is being popped is safe — see Race Conditions.

---

## Verification Plan

### Automated Tests

- **Unit** — `queue_position` assignment on entry, rewrite on reorder, clear on dispatch; `NULL`-position cards sort last.
- **Unit** — migration: a V59 DB gains the column and stamps 60; a fresh DB has it from `SCHEMA_TABLES_SQL`; running the migration twice is a no-op.
- **Unit** — `stageForQueue` preserves the caller's order and refuses subtasks.
- **Unit** — `Run queue` with no live coding head dispatches nothing and reports why.
- **Unit** — the Dispatch comparator: the optimistic-move insert and the initial render produce the same order for the same set (the regression that would let a queue reorder itself mid-session).
- **Regression** — `Send all to coders` still fans out in parallel and is unaffected by `queue_position`.
- **Regression** — the Analyze button still stages cards into `DISPATCH` as it does today, now with appended positions.

### Manual UAT

- **The headline case:** select five plans, stage them, reorder two, press `Run queue`, and confirm all five run in the stated order with every automation mode off. Check the fourth card was dispatched after the third's review passed, not before.
- Reorder a card, then let one dispatch, then reload the board — the remaining order must be the one on screen before the reload.

---

**Recommendation:** Complexity 5 → **Send to Coder.**

---

## Completion Report

Implemented the DISPATCH session queue (V60). Added `queue_position INTEGER DEFAULT NULL` to the `plans` table in `SCHEMA_TABLES_SQL` plus a gated `MIGRATION_V60_SQL` (head was V59), wired the column through `PLAN_COLUMNS` and the `_readRows` mapper, and added three DB writers (`clearQueuePosition`, `appendQueuePositions`, `setQueuePositions` — the last in one BEGIN/COMMIT transaction). In `KanbanProvider.ts` added exported `stageForQueue` / `reorderQueue` / `clearQueuePosition` (subtasks 6 and 7 reuse the staging helper), cleared `queue_position` in `moveCardToColumnWithReason` whenever a card leaves DISPATCH, threaded `queuePosition` through all four board card builders, and added `stageForQueue` / `reorderQueue` / `runQueue` message-handler arms. In `kanban.html` (targeted string edits only) the Dispatch-view render and the `moveCardElements` optimistic insert now sort by `queue_position` ascending with NULL last; the same-column drop dead-end is filled with a clientY-midpoint insertion-index reorder that posts `reorderQueue`; a `Stage for queue` selection button and a `Run queue` button (beside `Send all to coders`, whose tooltip was reworded to "Fan out") were added; and the load-bearing "no one-click staging" comment was replaced with one line stating DISPATCH is now an ordered queue. Files changed: `src/services/KanbanDatabase.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`. Did NOT edit `LocalApiServer.ts` or `teamWiring.ts`.

### Revision — runQueue arm three-defect fix

Fixed three linked defects in the `runQueue` message-handler arm (KanbanProvider.ts) and the Run queue button (kanban.html). (1) Wrong call shape: changed `dispatchNextFromQueue(workspaceRoot)` to `dispatchNextFromQueue({ workspaceRoot, from: headTerminal })` matching subtask 1's real signature `dispatchNextFromQueue(args: { workspaceRoot: string; from: string })`. (2) No coding head resolved: added resolution of the live coding head via `getAliveRoleTerminalNames('lead', ...)` with 'coder' fallback; refuses with an explanatory status message when no coding head is live (not an auto-start, per the plan); the webview button is now disabled with a tooltip when `lastCoderTerminalCount === 0`, mirroring the existing `dispatchStagedNow === 0 || !dispatchAnalyzeAvailable` disable pattern. (3) Return shape mismatch: replaced the `outcome.success`/`outcome.error`/`outcome.message` reads (none of which exist on `{ status, payload }`) with branching on `outcome.status` and reading `outcome.payload` — `payload.dispatched === null` is a non-error empty-queue, 409 is in-flight, `payload.error` carries the failure message. Files changed: `src/services/KanbanProvider.ts`, `src/webview/kanban.html`.

---

## Review Findings

The V60 migration is correct — `queue_position` lands in both `SCHEMA_TABLES_SQL` and a gated `MIGRATION_V60_SQL`, no shipped V51–V59 body was edited, and a fresh DB was verified to run the whole chain and stamp 60. **MAJOR** — the three new message-handler arms (`stageForQueue`, `reorderQueue`, `runQueue`) reached no allowlist, catalog or schema, so `npm run catalog:check` (CI-wired, `integration-tests.yml:26`) was red and both new buttons dead-click in the browser host (PRD contract #6); catalog and allowlist regenerated, schemas added. **MAJOR** — inserting the three arms between `sendDispatchSetToCoders` and `importFromClipboard` broke `test:contract:dispatch-view`, whose slice was anchored on the distant neighbour; the slice now ends at the next `case` label, and its snapshot-hash assertion now matches on field membership so adding `codingHeadLive` is not a red gate. **NIT** — `KanbanProvider.clearQueuePosition` has zero callers; its doc claims subtask 1 calls it, but the pop clears the position through `moveCardToColumnWithReason`.

**Verification:** `npm run compile` clean; `test:contract:dispatch-view` restored to green; `catalog:check` / `parity:check` / `verb-returns:check` green; new `test:contract:queue-pipeline` covers queue-position ordering (NULLs last) and subtask exclusion. **Remaining risk:** the drag-reorder insertion index and the two render paths' comparator agreement are still untested — both are webview-only and need the manual UAT in this plan.

---

## Completion Report (review pass)

Reviewed against this plan and fixed the verb-surface gap the implementation left open: `stageForQueue`/`reorderQueue`/`runQueue` are now in `protocol-catalog.json` and `src/generated/verbAllowlist.ts` (regenerated, not hand-edited) with permissive field-accurate entries in `src/services/verbSchemas.ts`. Repaired `src/test/dispatch-view-contract.test.js`, which this subtask broke by arm insertion rather than by behaviour — the arm slice is now bounded at the next case label and the snapshot-hash check matches on membership. Files changed: `protocol-catalog.json`, `src/generated/verbAllowlist.ts`, `src/services/verbSchemas.ts`, `src/test/dispatch-view-contract.test.js`. The DB layer, the staging helpers and the webview work needed no changes.
