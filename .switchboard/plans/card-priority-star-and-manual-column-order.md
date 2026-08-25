# A priority star and manual ordering in every column

## Goal

Give users two ways to express execution order on the board — a **priority star** that overrides everything, and **drag-to-reorder in any column** so the arrangement on screen is the arrangement that runs — and make every consumer that picks "the next card" read them instead of falling back to the column's default ordering.

### Problem Analysis

**Ordering is currently expressible in exactly one column, and only as a side effect of staging.** `queue_position` (V60) is *"the STAGING session queue's explicit order… a 1-based sort key assigned by stageForQueue (append from MAX+1), rewritten by reorderQueue (one transaction), and cleared by clearQueuePosition when a card leaves STAGING."* The drag handler that writes it is gated on `effectiveTargetColumn === 'STAGING'` (`kanban.html:9765`) — described as *"Pure same-column reorder (EVERY dragged card is already in STAGING)"*. No other column persists a hand-set order, and no priority flag exists anywhere on `plans`.

> **Superseded:** The drag handler that writes it is gated on `effectiveTargetColumn === 'STAGING'` (`kanban.html:9408`).
> **Reason:** Line drift — the STAGING gate is at line 9765 in the current source, not 9408. The cited line number was stale.
> **Replaced with:** `kanban.html:9765` — the `if (effectiveTargetColumn === 'STAGING')` branch that routes cross-column drops through `stageForQueue` and same-column reorders through `reorderQueue`.

**So every "pick the next card" consumer falls back to a timestamp, and each does it independently:**

- `_distributePlannerDispatch` sorts by `lastActivity` ASC (`KanbanProvider.ts:6873-6875`) — oldest activity first — before bucketing across planner terminals. It does NOT filter by `!dispatchedAt`; the caller at `KanbanProvider.ts:10792-10795` passes `_lastCards` filtered only by `workspaceRoot` and `sessionIds`, with no in-progress exclusion.
- The queue pop (`LocalApiServer.ts:1921-1923`) sorts STAGING candidates by `queue_position` ASC NULLS LAST, then board order (`updated_at DESC` per `getBoard` at `KanbanDatabase.ts:3778`). It DOES filter by `!p.dispatchedAt` via `isQueueable` (`LocalApiServer.ts:1899-1902`).
- The schedule's dispatch path (`TaskViewerProvider.ts:13639-13648`) resolves the live coding head and calls `dispatchNextFromQueue` — the SAME queue pop. It is not a third independent sort; it delegates to the queue pop and inherits its filter and ordering.

> **Superseded:** The queue candidate predicate tests `!p.dispatchedAt` directly (`LocalApiServer.ts:1879`, and again at `:2326`), so the queue path already excludes dispatched cards by fact rather than by inference.
> **Reason:** Both line references are wrong. Line 1879 is the `inFlightCard` 409 response payload (`dispatchedTerminal: inFlightCard.dispatchedTerminal`), not the `!p.dispatchedAt` test. Line 2326 is the escalation ladder's `parkReason` variable. The actual `!p.dispatchedAt` test is in `isQueueable` at `LocalApiServer.ts:1901`. There is no second independent `!dispatchedAt` test at `:2326` — the escalation ladder re-reads the card's column but does not re-test `dispatchedAt`.
> **Replaced with:** The queue candidate predicate `isQueueable` tests `!p.dispatchedAt` at `LocalApiServer.ts:1901`, so the queue path (and the schedule path that delegates to it) already excludes dispatched cards by fact rather than by inference.

**And oldest-first was never an ordering decision — it is a guard against picking up work already in progress.** That reframes it entirely: age was standing in for "not currently being worked on", which is a *filter*, not a *sort*.

The filter already exists where it matters. The queue path tests `!p.dispatchedAt` directly (`LocalApiServer.ts:1901`), so the queue path (and the schedule that delegates to it) already excludes dispatched cards by fact rather than by inference. Oldest-first adds nothing to that exclusion — which is exactly why it stops making sense once you look at it as ordering: it is a proxy for a condition that is separately and correctly tested.

**So the sort is free, provided every consumer actually applies the filter.** That is the one thing to verify per consumer before changing its sort: a consumer that leaned on age as its *only* protection against grabbing in-flight work would start doing so the moment the sort became user intent. The queue path is covered (and the schedule with it); `_distributePlannerDispatch` is NOT — it has no `!dispatchedAt` filter of its own and relies on the caller having already excluded in-flight cards, which the caller does not do.

A user who drags cards in CREATED or PLAN REVIEWED to put important work first is not overridden — **their intent was never recorded**. The board shows one order and the system acts on another, and nothing reports the discrepancy.

**And STAGING is not a priority mechanism.** It is where missions live. Treating "stage it" as "prioritise it" conflates a membership decision with an ordering one: a user who wants a card done first should not have to enrol it in a mission to say so, and a mission's internal sequence is not a place to park unrelated urgent work.

**Two different needs, which is why one mechanism will not do.** "Do this one first, whatever else is queued" is a *flag* — it is about one card relative to all others, it is toggled constantly, and it should be visible at a glance. "Run these in this sequence" is an *order* — it is about the whole column, it is set by arranging, and its value is that the screen shows the plan. A star cannot express a sequence, and a sequence makes a single urgent card tedious to promote.

### V61 `column_entered_at` — the board already has a display order

V61 introduced `column_entered_at` (`KanbanDatabase.ts:533-536`), set to `now` on every column move (`KanbanDatabase.ts:2573`). The frontend sorts non-STAGING columns by `column_entered_at DESC` then `createdAt DESC` (`kanban.html:8911-8917`). This means the board already shows "most recently moved to column first" — not creation age. A card dragged into a column appears at the top because its `column_entered_at` is `now`.

This is a presentation order, not an execution order: no consumer reads `column_entered_at` when picking the next card. But it is the order the user sees, and the plan's goal is "the arrangement on screen is the arrangement that runs." So the manual order field must coexist with `column_entered_at`:

- When a manual order exists (non-NULL `column_order`), it takes precedence over `column_entered_at` in both the display sort and the resolver.
- When no manual order exists (NULL), the card falls back to `column_entered_at DESC` then `createdAt DESC` — the current behavior, unchanged.
- A cross-column move sets `column_entered_at = now` (card appears at top) and clears `column_order` (no manual position in the new column yet), unless the drop handler computes an insertion index and sets `column_order` explicitly.

This makes `column_entered_at` the natural fallback instead of "age" — it is what the board already uses, and it means unarranged cards keep their current display position rather than jumping to an age-based order that the screen never showed.

### Root Cause

Board position was built as state, not as intent. A column records *where* work has got to, and the only ordering ever added — `queue_position` — was added for the queue that needed it rather than as a board-wide capability. V61 later added `column_entered_at` for display sorting (most recently moved first), but no consumer reads it for execution order. Every consumer that needed an order had no field to read, so each invented the same fallback — a timestamp, different in each place, none of them what the user sees.

## Metadata

**Complexity:** 6
**Tags:** feature, frontend, backend, ui

## User Review Required

- **The star yielding to dependency order in STAGING** — the plan proposes that a starred card in STAGING is refused ahead of an incomplete predecessor with a stated reason, rather than silently jumping the queue. This is a visible behavior change for users who star a card in STAGING expecting it to go first. Confirm that a stated refusal is preferable to silent reordering.
- **`column_entered_at` as the fallback instead of creation age** — the plan proposes that unarranged cards fall back to `column_entered_at DESC` (most recently moved first), which is the board's current display order, rather than creation age. This means a card just dragged into a column (but not manually positioned) runs before older cards in the same column. Confirm this matches intent — it means "most recently touched" is the default priority for unarranged cards, not "oldest first."

## Settled Design

- **A priority star on cards — single level.** One click on, one click off, no confirmation gate (project rule). It overrides other ordering. No ranked tiers.
- **Drag-to-reorder in every column**, persisted, so the visible arrangement is the execution arrangement.
- **STAGING keeps `queue_position`.** It is the mission queue's order and the streams work builds on it; a drag inside STAGING already writes it. The new order field covers every *other* column, so no column ever has two competing orders.
- **Precedence, in one place:** starred first → then the column's manual order (`queue_position` in STAGING, `column_order` elsewhere) → then `column_entered_at DESC` then `createdAt DESC`, as the board's existing display fallback for cards never arranged — not "age," which was never what the screen showed.
- **The frontend display sort and the consumer resolver share the same precedence.** The display comparator (`kanban.html:8900-8917`) is updated to apply starred → manual order → `column_entered_at DESC` → `createdAt DESC`, matching the resolver exactly. Without this, the screen and the consumers are separate code paths that drift — the exact problem this plan exists to fix.
- **In-progress exclusion stays a filter, never a sort.** `!dispatchedAt` is the test; age is not a substitute for it and must not be relied on as one. `_distributePlannerDispatch` must gain this filter before its sort changes.

## Complexity Audit

### Routine

- A boolean priority column on `plans`, and a star control on the card.
- A general per-column order column, written by the existing drop handler with its STAGING gate widened.
- Migration V62: two additive columns, both nullable/defaulted, following the V60/V61 pattern.

### Complex / Risky

- **`queue_position` must not be generalised to carry this.** It is cleared when a card leaves STAGING, and the streams work makes it the tiebreak among cards at the same stream sequence — so it already carries queue semantics. Reusing it for board-wide visual order would make one integer mean both "mission queue slot" and "where the user dragged it", which is the overload the streams plan already argues against for stage encoding. A separate field, with the STAGING/non-STAGING split above, keeps each number meaning one thing.
- **A star that overrides a dependency is a correctness bug, not a preference.** In STAGING, mission streams sequence work so a card cuts from its predecessor's result. A starred card jumping ahead of an incomplete predecessor produces exactly the conflict the stage map exists to prevent. The star must yield to dependency order — or be refused there with a stated reason — and it must never silently reorder a stream.
- **`_distributePlannerDispatch` has no `!dispatchedAt` filter.** It sorts by `lastActivity` ASC (`KanbanProvider.ts:6873-6875`) and relies on the caller at `:10792-10795` to exclude in-flight cards, which the caller does not do. Changing its sort to honour user intent before adding the filter is a window in which automation picks up work already underway. The filter must be added first (or in the same change), routing through the shared resolver which applies `!dispatchedAt` as a predicate before sorting.
- **Precedence has to live in one resolver, not in each consumer.** There are two independent sort implementations today (`_distributePlannerDispatch` and the queue pop; the schedule delegates to the queue pop). Adding two more inputs to each is how they drift; the first symptom is two surfaces disagreeing about which card is next, which is very hard to diagnose from the board.
- **The frontend display sort must match the resolver.** The display comparator at `kanban.html:8900-8917` currently sorts by `queue_position` (STAGING) or `column_entered_at DESC` (everything else). If the resolver applies starred → manual order → fallback but the display does not, the screen shows one order and the system acts on another — the exact defect this plan fixes. Both must share the same precedence logic.
- **Order on column move.** A card dragged between columns needs a position in its new column. The STAGING handler already computes an insertion index from the drop position (`kanban.html:9811-9817`), and that behaviour should carry over rather than every cross-column move appending to the end — otherwise dragging a card to the top of a column silently puts it last. A cross-column move that does not compute an insertion index should clear `column_order` (NULL → falls back to `column_entered_at DESC`, card appears at top, which is the current behavior).
- **A mixed drag is a known trap here.** The existing handler documents that a mixed selection *"previously took the reorder branch and silently discarded the unstaged cards — no message, no error, nothing staged."* Widening the gate to all columns multiplies the mixed cases, so the same losslessness requirement applies to every column pair, not just into STAGING.
- **Starring everything is the same as starring nothing**, and it will happen. Not worth gating, but worth surfacing: a count of starred cards, so the degenerate state is visible rather than felt as "ordering stopped working".
- **NULL ordering must sort predictably.** V60's precedent is explicit — *"NULL sorts last so pre-existing staged cards… keep working and drop to the end of the queue rather than vanishing or jumping the front."* For `column_order`, NULL means "never manually arranged" and falls back to `column_entered_at DESC` then `createdAt DESC` — the board's current display order — so every card predating this feature keeps its current position. This is distinct from V60's NULLs-last: `column_order` NULL does not sort last, it yields to `column_entered_at`, which is DESC (most recently moved first).

## Edge-Case & Dependency Audit

**Migration.** Two additive columns (V62), both nullable/defaulted, following the V60/V61 pattern (present in `SCHEMA_TABLES_SQL` so fresh DBs get them at creation, with an idempotent ALTER under the version gate). Every existing card is unstarred and unarranged, so behaviour is unchanged until a user acts — which is what makes this safe for ~4,000 installs. The new columns:
- `priority_starred INTEGER DEFAULT 0` — boolean (0 = unstarred, 1 = starred).
- `column_order INTEGER DEFAULT NULL` — 1-based sort key for non-STAGING columns, analogous to `queue_position` but scoped to the card's current non-STAGING column.

Both must be added to `PLAN_COLUMNS` (`KanbanDatabase.ts:919`) and the upsert query (`KanbanDatabase.ts:859-863`) so they are read and written on every board refresh and plan import.

**Security.** None. Board metadata only.

**Side effects.** Consumers that today pick the oldest card will pick a different card once a user stars or arranges anything. That is the intent, and it is why the precedence resolver must be shared — a partial rollout where one surface honours the star and another does not is worse than neither doing so.

**Ordering.** A precondition for the ordering behaviour promised by the batch plan and the schedule selector amendment; both currently have only age to work with outside STAGING.

**Race conditions.** Two webviews reordering the same column concurrently could produce overlapping `column_order` values. The V60 precedent handles this for `queue_position`: the render comparator tie-breaks on the board's existing order (`kanban.html:8907-8909`), and `setQueuePositions` wraps all writes in a transaction (`KanbanDatabase.ts:10116`). The new `setColumnOrders` must follow the same pattern: one transaction, tie-break on `column_entered_at DESC` in the comparator.

## Dependencies

- **Precondition for** `batch-moves-to-a-team-send-the-feature-implementation-prompt.md` (which five get sent) and for the schedule selector amendment tracked in `revise-the-in-flight-plans-for-asserted-completion.md`.
- **Must not disturb** `staging-streams-parallel-dispatch-and-worktrees.md`: `queue_position` keeps its meaning, and the star yields to stage order.
- **Fixes the fallback in** `_distributePlannerDispatch` (`KanbanProvider.ts:6873-6875`), whose `lastActivity` ASC sort is the second independent copy (the schedule delegates to the queue pop, so it is not a third).

## Adversarial Synthesis

Key risks: (1) the frontend display sort and the consumer resolver are separate code paths that could drift, recreating the exact "screen shows one order, system acts on another" defect; (2) `_distributePlannerDispatch` has no `!dispatchedAt` filter, so changing its sort before adding the filter opens a window where in-flight work is re-dispatched; (3) `column_order` NULL falling back to `column_entered_at DESC` means unarranged cards default to "most recently moved first," not "oldest first" — a behavior change for consumers that today sort oldest-first. Mitigations: both display and resolver share one precedence specification; the filter is added in the same change as the sort; the fallback is explicitly documented and surfaced in User Review Required.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — schema and migration

**Context:** The `plans` table schema (`KanbanDatabase.ts:190-228`) and migration system (V60 at `:520-522`, V61 at `:533-536`) are the pattern to follow.

**Logic:**
- Add `priority_starred INTEGER DEFAULT 0` and `column_order INTEGER DEFAULT NULL` to `SCHEMA_TABLES_SQL` (after `column_entered_at` at line 227).
- Add `MIGRATION_V62_SQL` with two idempotent ALTER statements, following the V61 comment format.
- Add V62 to the migration runner (after the V61 block at `:8576-8580`).
- Add both columns to `PLAN_COLUMNS` (line 919) and the upsert query (lines 859-863, 916-919).
- Add `clearColumnOrder(planId, workspaceId)` — analogous to `clearQueuePosition` (`:10053-10057`), sets `column_order = NULL`.
- Add `setColumnOrders(workspaceId, orderedPlanIds)` — analogous to `setQueuePositions` (`:10112-10137`), assigns 1..N in one transaction.
- Add `setPriorityStarred(planId, workspaceId, starred: boolean)` — sets `priority_starred` to 0 or 1.

**Edge Cases:**
- `column_order` is cleared on cross-column moves (like `queue_position` is cleared at `KanbanProvider.ts:8158-8161` when leaving STAGING), unless the drop handler computes an insertion index.
- `priority_starred` is NOT cleared on column moves — a star is a persistent flag that follows the card.

### 2. `src/webview/kanban.html` — star control and display sort

**Context:** The card HTML is generated by `createCardHtml` (search for this function). The display sort is at `kanban.html:8900-8917`. The drop handler's STAGING branch is at `:9765-9838`.

**Logic:**
- Add a star icon to `createCardHtml` — one click toggles `priority_starred`, posts a `setPriorityStarred` message. No confirm gate (project rule). Visual: filled star when starred, outline when not.
- Update the display sort comparator (`:8900-8917`) to apply the shared precedence: starred first → `queue_position` (STAGING) or `column_order` (elsewhere) ASC NULLs-yield-to-fallback → `column_entered_at DESC` → `createdAt DESC`. The STAGING `queue_position` branch (`:8901-8909`) stays; the non-STAGING branch gains `column_order` before the `column_entered_at` fallback.
- Widen the drop handler's reorder branch beyond STAGING. The same-column reorder logic at `:9800-9836` (compute insertion index from pointer Y, build ordered id list, post `reorderQueue`) is generalized: for non-STAGING columns, post `reorderColumn` with the same ordered id list. The STAGING branch keeps posting `reorderQueue`.
- For cross-column drops into non-STAGING columns: compute the insertion index from the drop position (same algorithm as `:9811-9817`), set `column_order` for the dragged cards at that position, and renumber the column in one transaction. If no insertion index is computed (e.g. a keyboard move), clear `column_order` and let `column_entered_at` place the card at the top.
- Surface the starred count: a badge or label showing "N starred" so a degenerate all-starred board is visible.

**Edge Cases:**
- Mixed drags (some cards already in the target column, some from elsewhere) must stay lossless in every column pair, not just into STAGING. The documented failure (`:9760-9764`) — silently discarding unstaged cards — must not recur for non-STAGING columns.
- The star control must not interfere with drag selection or card click handlers.

### 3. `src/services/KanbanProvider.ts` — message handlers and `_distributePlannerDispatch`

**Context:** Message handlers are in the `handleKanbanMessage` switch (search for `case 'reorderQueue'` at `:11940`). `_distributePlannerDispatch` is at `:6823-6952`.

**Logic:**
- Add `case 'setPriorityStarred'` — calls `db.setPriorityStarred(planId, workspaceId, starred)`, posts a board refresh.
- Add `case 'reorderColumn'` — calls `db.setColumnOrders(workspaceId, orderedPlanIds)`, posts a board refresh. Analogous to `case 'reorderQueue'` at `:11940-11947`.
- Update `moveCardToColumnWithReason` (`:8130-8170`) to clear `column_order` when a card moves to a different non-STAGING column (analogous to the `queue_position` clear at `:8158-8161`).
- Repoint `_distributePlannerDispatch` at the shared resolver instead of its own `lastActivity` ASC sort (`:6873-6875`). Add `!dispatchedAt` as a filter predicate before sorting — either in the resolver or as a pre-filter on `sourceCards` before the resolver runs.

**Edge Cases:**
- `_distributePlannerDispatch` receives `sourceCards` from `_lastCards` filtered by `sessionIds` — no `!dispatchedAt` filter. If a dispatched card is in the selection, it would be re-dispatched. The resolver (or a pre-filter) must exclude it.
- The `skipLimit` option (`:6878-6879`) must still work after the repoint — the resolver sorts, then the limit slices.

### 4. Shared precedence resolver — new utility

**Context:** Currently there is no shared resolver — each consumer sorts independently. The queue pop has `byQueueThenBoard` (`LocalApiServer.ts:1911-1919`); `_distributePlannerDispatch` has its inline sort (`KanbanProvider.ts:6873-6875`); the frontend has its comparator (`kanban.html:8900-8917`).

**Logic:**
- Create a shared comparator function (e.g. `compareByPrecedence(a, b, column)`) that encodes: starred first → `queue_position` (STAGING) or `column_order` (elsewhere) ASC with NULL yielding to fallback → `column_entered_at DESC` → `createdAt DESC`.
- The frontend display sort calls this comparator.
- `_distributePlannerDispatch` calls this comparator after filtering by `!dispatchedAt`.
- The queue pop's `byQueueThenBoard` is updated to apply starred first before `queue_position` — or the queue pop calls the shared comparator for STAGING.
- The schedule path needs no change — it delegates to the queue pop and inherits the resolver.

**Edge Cases:**
- The comparator must be deterministic for equal keys (stable sort on `createdAt` as final tiebreaker).
- The comparator must handle missing fields (`column_entered_at` NULL → fall back to `lastActivity` or `createdAt`, matching `kanban.html:8845-8851`).

### 5. Star yields to dependency/stage order in STAGING

**Context:** STAGING's `queue_position` is sequenced by mission streams. The queue pop (`LocalApiServer.ts:1921-1928`) picks `candidates[0]` — the first by `queue_position`.

**Logic:**
- In the queue pop, after sorting by the shared precedence (starred → `queue_position` → fallback), check whether the top candidate has an incomplete stage predecessor. If it does and the card is starred, refuse the star's precedence with a stated reason (e.g. "starred card X has incomplete predecessor Y in stage 1") and fall back to the non-starred order. If the card is not starred, the normal `queue_position` order applies.
- The refusal reason is returned in the response payload so Mission Control or the UI can surface it.

**Edge Cases:**
- A starred card with no predecessor (or a completed predecessor) is dispatched normally — the star only yields when there is an actual dependency conflict.
- The check must read the card's stage map (from the streams plan) to determine predecessor state. If the streams plan has not landed, this check is a no-op (no stage map → no predecessor → star applies normally).

### 6. Surface the starred count

**Context:** The board header already shows column counts (`kanban.html:8889-8891`).

**Logic:**
- Add a "N starred" indicator to the board header or a column-level summary, computed from `currentCards.filter(c => c.priorityStarred).length`.
- When all cards are starred, the indicator reads "N starred (all)" so the degenerate state is visible.

### Migration

Two additive columns (V62); existing cards read as unstarred and unarranged. `column_order` NULL falls back to `column_entered_at DESC` then `createdAt DESC` — the board's current display order — so no card moves. `priority_starred` defaults to 0. No behaviour change until a user stars or drags.

## Verification Plan

### Goal Invariants

- A starred card is picked before any unstarred one, in every consumer.
- A manually arranged column is consumed in its visible order.
- A card never has two competing orders.
- A star never reorders a dependency-sequenced stream.
- The display sort and the consumer resolver produce the same order for the same column.

### Automated Tests

- **The arrangement on screen is the arrangement consumed:** arrange a non-STAGING column newest-first, then run each consumer; assert the visible order. This fails today for every consumer, which is the point.
- **The star wins across all consumers:** star the last card in a column; assert the batch send, the schedule selector and the planner fan-out all pick it first. Testing one surface passes a partial rollout, which is the worst outcome.
- **One resolver, not two:** assert each consumer calls the shared resolver rather than sorting locally — a structural test, since duplicated sorts pass behavioural tests right up until one drift.
- **STAGING keeps `queue_position`:** assert a drag inside STAGING still writes `queue_position` and that `column_order` is untouched there.
- **The star yields to stage order:** star a stage-2 card whose stage-1 predecessor is incomplete; assert it is not dispatched ahead of it, and that the refusal states why.
- **Mixed drags stay lossless in every column pair:** drag a mixed selection between two non-STAGING columns; assert nothing is silently dropped — the documented failure this widening could reintroduce.
- **Unarranged and unstarred is unchanged:** assert a board where nobody has starred or dragged behaves exactly as today, ordering by `column_entered_at DESC` then `createdAt DESC` with NULLs falling back to the same order.
- **In-progress work is never picked, whatever the order says:** star and hand-place a card that is already dispatched; assert no consumer selects it. This is the assertion that replaces oldest-first's real job, and it must pass for every consumer — a star is a strong enough override to expose any consumer whose only guard was age.
- **Cross-column drop position is honoured:** drag a card to the top of another column; assert it lands first (via `column_order`), not last.
- **`_distributePlannerDispatch` filters in-flight cards:** pass a dispatched card in the source selection; assert it is not re-dispatched, even when it is the oldest or starred.
- **Display sort matches resolver:** for a column with a mix of starred, manually ordered, and unarranged cards, assert the frontend comparator and the consumer resolver produce identical orderings.

### Manual Verification

- Arrange a column, star one card lower down, batch-send, and confirm the star goes first and the rest follow the visible order.
- Star a card in STAGING that has an incomplete predecessor; confirm it is refused with a reason, not silently reordered.
- Drag a card to the top of a non-STAGING column; confirm it stays at the top after a board refresh.

## Outstanding Questions

- **[user]** The star yielding to dependency order in STAGING — is a stated refusal preferable to silently honouring the star and risking a dependency conflict? — proceeding on the assumption that a stated refusal is preferable, since a silent reorder in a mission stream is the exact conflict the stage map exists to prevent.
- **[user]** `column_entered_at` as the fallback for unarranged cards (most recently moved first, not oldest first) — does this match intent? — proceeding on the assumption that it does, since it is the board's current display order and the plan's goal is "the arrangement on screen is the arrangement that runs."

## Implementation Summary

Implemented V63 migration adding `priority_starred` (INTEGER DEFAULT 0) and `column_order` (INTEGER DEFAULT NULL) to the `plans` table, with three new DB methods (`clearColumnOrder`, `setColumnOrders`, `setPriorityStarred`) mirroring the V60 `queue_position` pattern. Created a shared precedence resolver (`kanbanOrdering.ts`) encoding starred-first → manual order (`queue_position` in STAGING, `column_order` elsewhere) → `column_entered_at DESC` → `createdAt DESC`, used by the queue pop (`LocalApiServer`), the planner fan-out (`_distributePlannerDispatch`), and duplicated inline in the frontend display sort so the screen and every consumer agree on which card is next. The planner fan-out gained a `!working` in-flight filter before the sort (replacing the `lastActivity` ASC proxy that was standing in for it). The frontend gained a star toggle on every card (no confirm gate), same-column drag-to-reorder for non-STAGING columns via a new `reorderColumn` message, and a starred-count indicator that reads "(all)" when every eligible card is starred. Cross-column non-STAGING moves clear `column_order` (card falls back to `column_entered_at DESC` = appears at top, the current behavior). The star-yields-to-stage-order guard is a no-op hook (`checkStagePredecessor` returns null) since the streams plan's stage map has not landed yet. One deliberate deviation from the plan: `priority_starred` and `column_order` were NOT added to `UPSERT_PLAN_SQL` (they are DB-owned like `queue_position`; adding them would wipe a user's star on every file re-import since the watcher's record does not carry these fields — the schema DEFAULT handles fresh inserts and absence from the ON CONFLICT SET list preserves them on conflict).

## Review Findings

Five material defects were found and fixed: the two new verbs never reached `protocol-catalog.json` / `src/generated/verbAllowlist.ts`, so `handleServiceVerb` would have thrown on `setPriorityStarred` and `reorderColumn` — the star worked in the VS Code webview and was dead in the browser cockpit; `moveCardToColumnWithReason` excluded STAGING on both sides of its `column_order` clear, so a CREATED → STAGING → CREATED round-trip kept its stale pre-staging position; the new `!working` filter in `_distributePlannerDispatch` dropped in-flight cards from an explicit user advance with no report, stranding the webview's optimistic move and leaving its guard-ledger entry armed (now reported via the existing `moveCardsFailed` channel through a new `_inFlightSkipFailures` helper); `KanbanProvider.setPriorityStarred` did not resolve a session-id card key the way its `reorderQueue`/`reorderColumn` siblings do, and `_persistedUpdate` reports success on zero rows changed, so an unresolved id would have claimed a star it never wrote; and the resolver's own docs described "NULL yields to the fallback", which the code correctly does not implement — resolving manual-vs-absent by timestamp is intransitive — so the comments in `kanbanOrdering.ts`, `KanbanDatabase.ts` and `kanban.html` were corrected to state that a manual position outranks its absence and that a card arriving in an already-arranged column therefore lands at its end. Files changed: `src/services/KanbanProvider.ts`, `src/services/KanbanDatabase.ts`, `src/services/kanbanOrdering.ts`, `src/webview/kanban.html`, `protocol-catalog.json`, `src/generated/verbAllowlist.ts`, plus a new `src/test/card-priority-and-column-order-contract.test.js` wired into `package.json` and `.github/workflows/integration-tests.yml` — the plan named eleven automated tests and none had been written or wired, which is the exact green-while-incomplete hole. Validation: `tsc -p tsconfig.test.json` clean, `eslint` 0 errors, `catalog:check` / `parity:check` / `push-routing:check` / `standalone-parity:check` / `standalone-fork:check` / `kanban-dispatch-callers:check` / `verb-returns:check` / `mirror:check` all pass, and the kanban contract suites (drag-guard, render-guard, queue-pipeline, dispatch-view, view-plan-removal, browser-panel-verb-routing's kanban assertion) pass; two failures are pre-existing at HEAD and unrelated (`staging-column`'s `sourceColumn: 'STAGING'` run-sheet assertion, `browser-panel-verb-routing`'s `connections.js copyTextToClipboard`). Two follow-up decisions on the cross-column path: a column move clears `column_order` and writes NOTHING in its place — a move is a stage change, not a statement about priority, and assigning one (front-of-column was tried and reverted) hands a card the user never placed a slot ahead of the ones they did; and the same-column reorder branch now compares the post-drop order against the rendered order and returns without writing when nothing moved, so a card picked up and put back cannot silently flip a whole column from self-ordering to a frozen arrangement. An arriving card is therefore NULL — not part of that column's arrangement — appearing at top in an un-arranged column (every column, until someone drags) and after the arrangement in one the user has ordered. Remaining risks: a mis-drop inside a column is still a real reorder and the remedy is to drag it back, as in STAGING today; the star-yields-to-stage-order guard is a live but inert hook (`checkStagePredecessor` always returns `null`) until the streams plan lands its stage map; and `moveCardToColumnByPlanFileWithReason` clears neither `queue_position` nor `column_order`, a pre-existing V60 parity gap this change inherits rather than introduces.
