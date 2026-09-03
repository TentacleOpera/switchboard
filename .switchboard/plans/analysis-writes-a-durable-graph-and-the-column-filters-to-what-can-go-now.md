# Analysis writes a durable dependency graph, and the column filters to the batch that can go now

## Goal

Five steps, in the operator's words:

1. Press one button.
2. The system builds or updates the dependency graph.
3. Click a filter button.
4. The Planned column now shows only the first batch that can be sent.
5. Optionally: tell a controller to use the graph to arrange missions, **or** to dispatch all safe plans to coders.

No mission is created, no card is moved, and nothing is staged unless the operator asks for it. The graph is a durable board fact; the batch is a view over it.

### Problem Analysis

**Every piece of storage this needs already exists and has never been used.** V64 added `plan_dependencies (plan_id, depends_on_plan_id)` with an index on `depends_on_plan_id`, plus `plans.map_fingerprint`. `POST /kanban/dependencies` accepts `{planId, dependsOn[], mapFingerprint}`, refuses cycles up front naming the closing path, and writes via `setPlanDependencies` / `addPlanDependency`. `GET` on the same route reads them back.

> **Superseded:** "Every piece of storage this needs already exists and has never been used."
> **Reason:** This is true for *directed dependency edges* and the *fingerprint hash*, but the plan's item 3 also requires file-overlap data to compute the non-conflicting batch. File sets are not persisted: `plan_dependencies` stores directed edges only, and `map_fingerprint` is a SHA-256 hash from which file sets cannot be reconstructed. The dispatch-analysis agent reads plan files, computes file overlap, and discards it — the exact "computed once, used, and thrown away" defect this plan set out to fix, but for the undirected half of the graph. Persisting file sets is the minimal extension of this plan's own premise ("persist the graph, don't throw it away") — file overlap *is* part of the graph.
> **Replaced with:** V64's storage covers edges and fingerprint. A new `analysis_file_set` TEXT column (JSON array of file paths) on `plans` is needed for the file-overlap half. The schema reconciliation mechanism (`SCHEMA_PLAN_COLUMN_DEFS`, `KanbanDatabase.ts:1044`) adds missing columns to existing databases automatically, so no manual migration is required for the ~4,000 installed base — the column is added on next open. The dispatch-analysis POSTs file sets alongside edges and fingerprint; the resolver reads persisted file sets and computes overlap with zero file I/O at filter time.

Measured on this board:

| | |
| :-- | --: |
| `plans` | 3,019 |
| rows in `plan_dependencies` | **0** |
| plans with `map_fingerprint` | **0** |
| `missions` / `mission_members` | **0** / **0** |
| plans with `queue_position` | **0** |

The table has been present since V64 and nothing has ever written a row.

**The Analyze button computes the graph and throws it away.** `dispatchAnalyze` (`kanban.html:8556`) dispatches `.agents/protocols/dispatch-analysis/SKILL.md`, which builds a file-overlap graph, reads declared dependencies, solves for the largest non-conflicting subset, and **moves that subset to STAGING via the API**. The edges are used as an exclusion filter and discarded. `staging-streams-parallel-dispatch-and-worktrees.md` states the consequence directly: *"the dependency knowledge is computed once, used to exclude, and thrown away — so no consumer can order anything by it."*

Three things follow, and they are exactly the operator's complaint:

1. **The answer is perishable.** A maximum-independent-set result is a subset valid at one instant, invalid the moment anything completes. There is no way to ask later "what is unblocked now?"
2. **Pressing Analyze commits you.** It moves cards into STAGING, and `stageForQueue` calls `resolveOrCreateOpenMission` — so learning what can run in parallel *creates a mission* as a side effect. There is no way to analyse without staging.
3. **A controller cannot read any of it.** With `plan_dependencies` empty, `GET /kanban/dependencies` returns nothing for every card, so step 5 has no input.

**Completion is already the right gate.** Per `completion-is-asserted-never-inferred.md`, completion is an asserted event in `completed_at`. So "is predecessor B finished?" is answerable directly — `completed_at IS NOT NULL` — with no second analysis pass and no inference from board position. The pop-time gate in `LocalApiServer.ts` is already written to be NULL-inert: with no rows in `plan_dependencies` the whole block is a no-op. It is waiting for data.

### Root Cause

Analysis and staging were built as one action because the only consumer of the analysis was the staging queue. The output shape was never revisited once the storage for a durable graph landed in V64. So the button that produces the knowledge is welded to the action that consumes it once, and the table that would let anything else consume it stays empty.

## Metadata

**Complexity:** 6
**Tags:** backend, frontend, api, database, ux

## User Review Required

- **Removal of `copyDispatchPromptSelected`.** The plan replaces the Copy-analysis-prompt button (`kanban.html:8262`) with the filter toggle. The plan's reasoning: once Analyze no longer moves cards (item 1), Analyze itself becomes the safe non-committing action, and the clipboard escape hatch has nothing left to escape. The user should confirm they are comfortable losing the clipboard path. The verb schema (`verbSchemas.ts:553`), the KanbanProvider arm (`KanbanProvider.ts:13057`), the webview handler (`kanban.html:8544`), and the verb allowlist entry must all be removed — no orphaned action may remain (verification check 4c).
- **New `analysis_file_set` column.** Adding a column to `plans` is a schema change. The reconciliation mechanism handles it automatically for existing installs, but the user should be aware that the next DB open adds the column. No manual migration step is needed.

## Complexity Audit

### Routine

- Removing the card-move step (5b) from `dispatch-analysis/SKILL.md` — the skill already POSTs edges and fingerprint (step 5a); step 5b is a separate, clearly delimited block.
- Adding `analysis_file_set` to `PLAN_COLUMNS` (`KanbanDatabase.ts:1032-1038`) and to the `KanbanPlanRecord` interface (`KanbanDatabase.ts:58`). The schema reconciliation adds the column to existing DBs.
- Extending `_buildBoardCards` (`KanbanProvider.ts:2154-2183`) to map `completedAt` and `mapFingerprint` (and `analysisFileSet`) onto card objects. Both fields are already in `PLAN_COLUMNS` and `KanbanPlanRecord`; the mapper just drops them today.
- Replacing the `copyDispatchPromptSelected` button with a filter toggle in the column header (`kanban.html:8261-8265`). The rendering precedent — `displayCards = displayCards.filter(...)` (`kanban.html:8913`, `:9139`) — is the exact pattern to follow.
- Removing the `copyDispatchPromptSelected` verb from `verbSchemas.ts:553`, the KanbanProvider arm (`KanbanProvider.ts:13057`), the webview handler (`kanban.html:8544`), and the generated verb allowlist (`verbAllowlist.ts:7`).

### Complex / Risky

- **Persisting file sets and computing the non-conflicting batch.** The dispatch-analysis must POST each plan's file set alongside its edges. The resolver must compute file overlap from persisted sets and select the non-conflicting batch using the same greedy algorithm and ordering (`compareByPrecedence`) as the dispatch path. A greedy selection ordered differently than the dispatch path produces a different batch — violating the plan's own invariant ("the filter must be a view of the dispatcher's answer, not a second opinion").
- **The shared resolver's scope boundary.** The queue pop (STAGING) checks dependency readiness only — file overlap was already checked at staging time. The filter (PLAN REVIEWED) checks dependency readiness AND file overlap — it determines what *can be staged*. The shared part is the dependency-readiness predicate; the file-overlap predicate is filter-specific because it operates pre-staging. Getting this boundary wrong either changes dispatch behavior (queue pop gains file-overlap checking it never had) or breaks the invariant (filter and dispatcher disagree).
- **Staleness detection requires file-set re-read.** Detecting that a plan's file set has changed since analysis requires recomputing the fingerprint from the current plan file. The `map_fingerprint` comparison is the mechanism, but the recomputation must read the plan file — there is no way around this. The plan must specify when this happens (on filter toggle? on board refresh? on explicit re-analysis?) and that it is a server-side operation, not a webview computation.

## Edge-Case & Dependency Audit

### Race Conditions

- **Analysis running while cards move.** A card could move out of PLAN REVIEWED while the dispatch-analysis agent is running. The agent re-queries the board at the start (dispatch-analysis skill step 1), but a move during the run could persist edges for a card that is no longer in the column. The edges are still valid (they record dependencies, not column position), but the filter would not show the card because it is no longer in PLAN REVIEWED. This is benign — the edges are durable facts, the filter is a column-scoped view.
- **Filter toggle while board refresh is in flight.** The filter is a view over the board update message's `sendablePlanIds` field. If the toggle fires between a board refresh and the next, the filter shows stale data for one render cycle. This is the same race every board update has — the next refresh corrects it. No special handling needed.

### Security

- **File sets in the DB.** The `analysis_file_set` column stores file paths from plan files. These are workspace-relative paths already present in plan files — no new information is exposed. The `GET /kanban/dependencies` endpoint already requires auth (`_checkAuth`).

### Side Effects

- **Removing `copyDispatchPromptSelected` changes the verb surface.** Any external automation or script that sends this verb will get a rejection. The verb is in the generated allowlist (`verbAllowlist.ts:7`); removing it is a breaking change for API consumers. Given ~4,000 installs and the verb's narrow purpose (clipboard copy of the analysis prompt), this is low-risk but should be noted.
- **Adding `analysis_file_set` to `PLAN_COLUMNS`.** Every `SELECT ${PLAN_COLUMNS}` query now returns the additional column. The `_readRows` parser must handle the new column. Existing code that destructures `KanbanPlanRecord` will not break (the field is optional), but any code that serialises the full record (e.g., board export) will include the new field.

### Dependencies & Conflicts

- **`staging-streams-parallel-dispatch-and-worktrees.md`** — built the current analysis+staging coupling and the V64 storage this plan populates. This plan decouples what that plan welded together. No conflict: the staging path remains available as a separate action (item 2).
- **`completion-is-asserted-never-inferred.md`** — established `completed_at` as the asserted completion signal. This plan depends on it: the readiness predicate checks `completed_at IS NOT NULL`. No conflict.
- **`missions-finish-the-card-the-drag-and-the-binding.md`** — explicitly out of scope (see below). This plan makes the graph useful *without* missions; that plan makes missions useful *with* the graph. They are complementary, not conflicting.
- **Standalone/extension parity.** All changes are in shared services (`dispatch-analysis/SKILL.md`, `KanbanDatabase.ts`, `KanbanProvider.ts`, `LocalApiServer.ts`, `kanbanOrdering.ts`, `kanban.html`). The composition roots (`extension.ts`, `bootstrap.ts`) require no changes: `triggerBatchAgentFromKanban` is registered in both hosts (`extension.ts` and `bootstrap.ts:1330`), the board update message is produced by the shared `KanbanProvider`, and the filter toggle is a webview feature in the shared `kanban.html`. No new seams to wire.

## Dependencies

- `staging-streams-parallel-dispatch-and-worktrees.md` — V64 storage (`plan_dependencies`, `map_fingerprint`), the analysis+staging coupling this plan decouples, and the pop-time dependency gate this plan feeds.
- `completion-is-asserted-never-inferred.md` — `completed_at` as the sole completion signal; the readiness predicate's dependency-ready check reads it directly.
- `missions-finish-the-card-the-drag-and-the-binding.md` — explicitly out of scope; this plan's graph is useful without missions, and that plan's missions consume the graph.

## Adversarial Synthesis

Key risks: (1) file-overlap data is not persisted — the resolver cannot compute the non-conflicting batch without it, so the filter would show conflicting cards as "sendable"; (2) `_buildBoardCards` drops `completedAt` and `mapFingerprint` from card objects, leaving the filter with no data to check predecessor completion or staleness; (3) the shared resolver's scope boundary between filter (pre-staging, checks file overlap) and queue pop (post-staging, checks dependency readiness only) must be precise — conflating them either changes dispatch behavior or breaks the filter-dispatch invariant. Mitigations: persist file sets in a new `analysis_file_set` column (schema-reconciled automatically), extend the card mapper to carry the needed fields, and specify the resolver as a dependency-readiness predicate shared by both paths plus a file-overlap predicate applied filter-side only.

## Proposed Changes

### 1. Analyze writes the graph and moves nothing

**Target:** `.agents/protocols/dispatch-analysis/SKILL.md`

**Context:** The skill currently performs two writes in step 5: 5a (POST edges + fingerprint) and 5b (move cards to STAGING). Step 5b is the coupling this plan removes.

**Logic:** Remove step 5b entirely. The skill POSTs edges, fingerprint, and now file sets (see item 3 below) for each analysed plan. No card moves. Re-running the analysis updates edges and file sets in place — `setPlanDependencies` already does DELETE+INSERT in a transaction (`KanbanDatabase.ts:11367-11376`), so removed dependencies disappear. The file set is overwritten the same way (UPDATE `analysis_file_set`).

**Implementation:**
- Step 5a: extend the POST body to include `fileSet` (the plan's file array):
  ```
  POST /kanban/dependencies
  { "workspaceRoot": "...", "planId": "...", "dependsOn": [...], "mapFingerprint": "...", "fileSet": ["src/foo.ts", "src/bar.ts"] }
  ```
- Step 5b: delete the entire "Move cards to STAGING" block. The report (step 6) no longer lists moved plans; it lists persisted edges and file sets instead.
- The "Recommended next step" changes from "Run queue or launch mission from STAGING" to "Toggle the sendable-batch filter on the Planned column, or stage the batch explicitly."

**Edge Cases:**
- A plan with no declared dependencies and no file modifications: POST an empty `dependsOn` array, an empty `fileSet` array, and the fingerprint. The edge write is already handled (fingerprint-only write is legitimate, `LocalApiServer.ts:3468-3473`); the file-set write follows the same pattern.
- A cycle is refused by the server (`LocalApiServer.ts:3490-3494`) with the closing path. No partial order is written. This is unchanged.

### 2. Staging becomes a separate, explicit action

**Target:** `kanban.html` (column header), `KanbanProvider.ts` (`stageForQueue` arm)

**Context:** The current `stageForQueue` action (`kanban.html:8325`, `KanbanProvider.ts:12857`) is already a separate verb — it stages selected plans into STAGING. The Analyze button is what couples analysis to staging by moving cards as a side effect. Item 1 removes that coupling. Staging remains available as its own control.

**Logic:** No new staging control is needed. The existing `stageForQueue` verb and the "Move Selected" / "Move All" buttons (`kanban.html:8291-8296`) already move cards to the next column. After item 1, analysis is no longer a precondition for staging, nor staging a consequence of analysis. The operator can: (a) press Analyze to build the graph, (b) toggle the filter to see the batch, (c) select those plans and press Move Selected to stage them.

**Implementation:** No code change beyond item 1. The staging path is already independent. Document the decoupled workflow in the dispatch-analysis skill's report (step 6).

**Edge Cases:**
- An operator who never presses Analyze can still stage plans manually — the workflow is unchanged from today for anyone who ignores the graph. The pop-time gate is NULL-inert without edges, so staging without analysis works exactly as before.

### 3. One shared readiness resolver, with file-overlap data persisted

**Target:** `kanbanOrdering.ts` (or a new sibling `sendableResolver.ts`), `KanbanDatabase.ts`, `LocalApiServer.ts`, `KanbanProvider.ts`

**Context:** The plan's original item 3 proposed "one shared readiness predicate" checking both dependency readiness and file overlap. The architecture review identified that file-overlap data is not persisted, and that the queue pop (STAGING) and the filter (PLAN REVIEWED) operate at different stages — the queue pop checks dependency readiness only (file overlap was checked at staging time), while the filter checks both. The shared part is the dependency-readiness predicate; the file-overlap predicate is filter-specific.

> **Superseded:** "A card is sendable when both hold: every depends_on_plan_id for it has completed_at IS NOT NULL, and it does not file-overlap any other card already selected into the batch. This must live in one resolver."
> **Reason:** File-overlap data is not persisted — `plan_dependencies` stores directed edges only, and `map_fingerprint` is a hash. The resolver cannot compute file overlap from persisted data without re-reading plan files. Additionally, the queue pop (STAGING) checks dependency readiness only and has never checked file overlap; adding file-overlap checking to the queue pop would change dispatch behavior. The filter (PLAN REVIEWED) and the queue pop (STAGING) operate at different stages: the filter determines what *can be staged* (deps done + no conflicts), the queue pop determines what *can be dispatched* (deps done, already staged = already conflict-checked).
> **Replaced with:** Two predicates, one shared:
> - **`isDependencyReady(planId)`** — shared by the filter and the queue pop. Checks that every `depends_on_plan_id` for the plan has `completed_at IS NOT NULL`. This is the exact check the pop-time gate already performs (`LocalApiServer.ts:2722-2731`); extract it into a named function so both consumers call the same code.
> - **`resolveSendableBatch(columnCards)`** — filter-only. Takes the cards in PLAN REVIEWED, filters to dependency-ready ones (via `isDependencyReady`), then greedily selects the non-conflicting subset: iterate in `compareByPrecedence` order, skip any card whose `analysisFileSet` overlaps a card already selected. Returns the batch as an ordered list of plan IDs.
>
> The file-overlap check reads `analysis_file_set` from the persisted column (item 3a below), not from plan files. The greedy algorithm and ordering must match the dispatch-analysis skill's selection — both iterate in `compareByPrecedence` order and skip overlapping cards. This is what makes the filter "a view of the dispatcher's answer, not a second opinion."

**Implementation:**

3a. **New `analysis_file_set` column on `plans`.**
- Add `analysis_file_set TEXT` to `SCHEMA_TABLES_SQL` and `SCHEMA_PLAN_COLUMN_DEFS` (`KanbanDatabase.ts:1044`). The reconciliation mechanism adds the column to existing DBs on next open.
- Add `analysisFileSet?: string[] | null` to `KanbanPlanRecord` (`KanbanDatabase.ts:58`).
- Add `analysis_file_set` to `PLAN_COLUMNS` (`KanbanDatabase.ts:1032-1038`).
- Add `setAnalysisFileSet(planId, fileSet)` and `getAnalysisFileSet(planId)` methods to `KanbanDatabase`, mirroring `setMapFingerprint` / `getMapFingerprint` (`KanbanDatabase.ts:11390-11410`).
- Extend `POST /kanban/dependencies` (`LocalApiServer.ts:3444-3504`) to accept and persist `fileSet` alongside `mapFingerprint`.

3b. **`isDependencyReady` function.**
- Extract the dependency-readiness check from the pop-time gate (`LocalApiServer.ts:2722-2731`) into a named, reusable function. The pop-time gate already resolves predecessors through the union (hot + cold) and treats absent predecessors as satisfied (`LocalApiServer.ts:2695-2730`); the extracted function must preserve this behavior.
- Place it in `kanbanOrdering.ts` or a new `sendableResolver.ts` — the same module the queue pop and the filter both import.

3c. **`resolveSendableBatch` function.**
- Takes an array of cards (the PLAN REVIEWED column cards), filters to dependency-ready ones via `isDependencyReady`, then greedily selects the non-conflicting subset.
- Ordering: `compareByPrecedence(a, b, 'PLAN REVIEWED', orderByMode)` — the same comparator the board display uses.
- File-overlap check: two cards conflict if their `analysisFileSet` arrays share any path. A card with no `analysisFileSet` (never analysed) is treated as conflicting with nothing — but the filter shows zero cards when no analysis has run (item 4), so this case is unreachable in the filter path.
- Returns `{ sendablePlanIds: string[], stalePlanIds: string[] }` — the batch plus any cards whose recomputed fingerprint differs from the stored one (item 5).

3d. **Extend `_buildBoardCards` to carry the needed fields.**
- Add `completedAt`, `mapFingerprint`, and `analysisFileSet` to the card objects built at `KanbanProvider.ts:2154-2183` (active cards) and `:2185-2202` (completed cards). All three fields are already in `PLAN_COLUMNS` and `KanbanPlanRecord`; the mapper drops them today.

3e. **Board update message carries `sendablePlanIds`.**
- The board refresh path (`_refreshBoardImpl` or `refreshWithData`) computes the sendable batch for PLAN REVIEWED via `resolveSendableBatch` and includes `sendablePlanIds: string[]` and `stalePlanIds: string[]` in the `updateBoard` message. The webview reads these to drive the filter (item 4) and staleness indicator (item 5).
- This is the "one resolver, not two opinions" invariant: the webview does not compute the batch; it reads the batch the backend computed.

**Edge Cases:**
- A predecessor that has been archived (status='completed'): the union resolver (`getPlanByPlanIdUnion`) finds it, and `completedAt` is set. The dependency is satisfied. This is the existing pop-time behavior, preserved by extraction.
- A predecessor that has been deleted: treated as satisfied (stale edge, `LocalApiServer.ts:2725-2729`). Preserved.
- A card with `analysisFileSet = null` (analysed before file-set persistence existed): treated as conflicting with nothing. The filter shows it as sendable if dependency-ready. This is a one-time edge case during the transition; re-running the analysis populates the file set.

### 4. A filter toggle on the column header, replacing the Copy-analysis-prompt button

**Target:** `kanban.html` (column header, card rendering)

**Context:** The `copyDispatchPromptSelected` button (`kanban.html:8261-8265`) is replaced by the filter toggle. The plan's reasoning: once Analyze no longer moves cards (item 1), Analyze itself becomes the safe non-committing action, and the clipboard escape hatch has nothing left to escape.

**Logic:** The toggle is a view: no card moves, no order is written, no mission appears. On shows the sendable batch; off restores the full column. The sendable batch comes from the `sendablePlanIds` field in the `updateBoard` message (item 3e) — the webview does not compute it.

**Implementation:**
- Replace the `copyDispatchPromptBtn` definition (`kanban.html:8261-8265`) with a filter toggle button. Use a distinct icon (e.g., a filter-funnel icon) and `data-action="toggleSendableFilter"`.
- Add a webview state variable `sendableFilterOn` (default `false`).
- In the card rendering path, after the existing `displayCards.filter(...)` calls (`kanban.html:8913`, `:9139`), add:
  ```
  if (sendableFilterOn && effectiveCol === 'PLAN REVIEWED') {
      displayCards = displayCards.filter(card => sendablePlanIds.includes(card.planId));
  }
  ```
  This follows the exact rendering precedent the plan identified — swap the predicate, gate it on the toggle.
- The `updateBoard` message handler stores `sendablePlanIds` and `stalePlanIds` from the message and triggers a re-render if the filter is on.
- Click handler for `toggleSendableFilter`: flip `sendableFilterOn`, re-render. No backend call — the data is already in the message.

**With no graph, it shows no cards.** When `sendablePlanIds` is empty (no analysis has run), the filter shows zero cards. This is the correct behaviour, not an error state and not a fallback to the full column. The filter renders what is *known* to be sendable, and before an analysis run nothing is known. An empty column is an honest "you have not analysed this column yet" — no banner, no disabled state, no tooltip. Falling back to the unfiltered column would look like an answer while being the absence of one.

**Edge Cases:**
- The filter is column-scoped to PLAN REVIEWED. Toggling it on STAGING (which also has an Analyze button) is a separate question — the plan's scope is the Planned column. If STAGING later wants the same filter, the same mechanism applies with a different `sendablePlanIds` set.
- A card that moves into PLAN REVIEWED while the filter is on: the next board refresh includes it in `sendablePlanIds` if it is sendable, or excludes it if not. The filter updates automatically — no manual refresh needed.

### 5. Surface staleness rather than hiding it

**Target:** `KanbanDatabase.ts`, `KanbanProvider.ts`, `kanban.html`

**Context:** `map_fingerprint` records the state a card was analysed against. When the filter is on and a card's recomputed fingerprint differs, the batch is stale and re-analysis is offered.

**Logic:** Staleness is detected server-side during the board refresh, not in the webview. The `resolveSendableBatch` function (item 3c) recomputes each candidate's fingerprint from its plan file and compares it to the stored `map_fingerprint`. Mismatches are returned as `stalePlanIds`. The webview shows a staleness indicator on the column header when `stalePlanIds` is non-empty.

**Implementation:**
- In `resolveSendableBatch`, after computing the sendable batch, recompute each candidate's fingerprint: SHA-256 of concatenated `{planId}:{sortedFileSet}` pairs (the same formula the dispatch-analysis skill uses, step 4). This requires reading each plan file to get the current file set — a server-side operation.
- Compare the recomputed fingerprint to `card.mapFingerprint`. If they differ, add the plan ID to `stalePlanIds`.
- The `updateBoard` message includes `stalePlanIds: string[]`.
- The webview shows a small "stale — re-analyze" indicator on the column header when `stalePlanIds.length > 0` and the filter is on. Clicking it triggers `dispatchAnalyze` (which re-runs the analysis and refreshes the graph).
- A silently stale batch is worse than no filter. The staleness indicator is not optional.

**Edge Cases:**
- A plan file that has been deleted: the fingerprint recomputation fails. Treat as stale (the file set has changed — it is now empty). The card is also a ghost plan and would be filtered by `_filterGhostPlans` (`KanbanProvider.ts:2074`) before reaching the resolver, so this case is unreachable in practice.
- Performance: recomputing fingerprints requires reading N plan files on each board refresh while the filter is on. For 3,000+ plans this is expensive. Mitigation: only recompute fingerprints for cards in PLAN REVIEWED (the filter's scope), not the entire board. The number of cards in PLAN REVIEWED is typically small (tens, not thousands).

### 6. Give the controller the two verbs step 5 names

**Target:** `LocalApiServer.ts`, `KanbanProvider.ts`

**Context:** The plan's original item 6 said "Both are plain reads over the existing HTTP surface." The architecture review found this is true for the dependency graph (`GET /kanban/dependencies` already exists) but not for the sendable set — the sendable set requires `resolveSendableBatch`, which is a computation, not a stored read. A new endpoint is needed.

> **Superseded:** "Both are plain reads over the existing HTTP surface; no mission or staging is involved in either."
> **Reason:** `GET /kanban/dependencies` is indeed an existing plain read and serves the "arrange missions" use case. The sendable set, however, is computed by `resolveSendableBatch` (dependency readiness + file overlap), which is not a stored read — it requires the resolver to run. No existing endpoint returns the sendable set.
> **Replaced with:** `GET /kanban/dependencies` (existing) returns the graph for mission arrangement. A new `GET /kanban/sendable?workspaceRoot=...&column=PLAN REVIEWED` endpoint returns `{ sendablePlanIds, stalePlanIds }` by running `resolveSendableBatch` server-side. Both are read-only — no mission, no staging, no card move.

**Implementation:**
- `GET /kanban/dependencies` — already exists (`LocalApiServer.ts:3409-3441`). Returns per-plan edges + fingerprint (with `planId` query param) or all edges (without). A controller reads this to arrange missions. No change needed.
- `GET /kanban/sendable` — new endpoint. Resolves the DB from the query, gets the board, filters to PLAN REVIEWED, runs `resolveSendableBatch`, returns `{ success: true, sendablePlanIds, stalePlanIds }`. This is the "dispatch all safe plans to coders" read: one query plus N dispatches, with no client-side graph maths.
- Register the route in the `pathname` dispatch (`LocalApiServer.ts:8846-8848`, near the dependencies route).

**Edge Cases:**
- The sendable set is a snapshot. By the time the controller dispatches N plans, some may have completed or moved. The controller should treat the set as "sendable now," not "sendable forever." This is the same perishability the plan's Problem Analysis identifies — but now the controller can re-query at any time, which is the improvement.
- No `workspaceRoot` in the query: the endpoint uses the server's configured root, same as other endpoints.

### Explicitly not in scope

- Multi-stream launch, per-mission `queue_position` scoping, and the mission card. Those are `missions-finish-the-card-the-drag-and-the-binding.md`. This plan deliberately makes the graph useful **without** missions, so that work is not a prerequisite.
- Changing `queue_position`, `column_order`, or the star. Ordering is untouched.

## Verification Plan

### Automated Tests

1. Pressing Analyze populates `plan_dependencies` and stamps `map_fingerprint` and `analysis_file_set`, and **no card changes column**. `missions` count is unchanged.
2. Re-running Analyze updates edges and file sets in place rather than duplicating them; a removed dependency disappears, a changed file set is overwritten.
3. A declared cycle is refused naming the closing path, and no partial order is written.
4. With the filter on, the Planned column shows exactly the sendable set; with it off, the full column returns. No DB write occurs in either direction.
4b. With the filter on and **no analysis ever run**, the column shows **zero cards** — not the full column, and not an error. Running the analysis then populates it without a page reload.
4c. `copyDispatchPromptSelected` is gone from the column header, the verb schema, the KanbanProvider arm, the webview handler, and the verb allowlist. No action is left orphaned by its removal.
5. The filter's set is identical to the set the dispatch path would choose — asserted by a test that calls `resolveSendableBatch` and the dispatch-analysis's selection (both using `compareByPrecedence` ordering) and compares, so the two cannot drift.
6. A chain A→B→C: only A is sendable. On A's `completed_at`, B becomes sendable without re-running the analysis.
7. `GET /kanban/dependencies` returns the graph for a controller, and `GET /kanban/sendable` returns the same batch the filter shows.
8. Editing a plan's files after analysis marks its batch stale via `map_fingerprint` mismatch; the staleness indicator appears on the column header.
9. `_buildBoardCards` includes `completedAt`, `mapFingerprint`, and `analysisFileSet` on each card object — asserted by a test that reads the card fields.
10. The `analysis_file_set` column is added to an existing DB on next open (schema reconciliation) — asserted by a test that opens a pre-column DB and checks the column exists.

### Goal Invariants

- `resolveSendableBatch` is defined and exported from `kanbanOrdering.ts` (or `sendableResolver.ts`).
- `isDependencyReady` is called by both the queue pop path (`LocalApiServer.ts`) and `resolveSendableBatch` — assert both import from the same module.
- `analysis_file_set` column exists in `PLAN_COLUMNS` (`KanbanDatabase.ts:1032-1038`) and in `SCHEMA_PLAN_COLUMN_DEFS`.
- `GET /kanban/sendable` route is registered in `LocalApiServer.ts` pathname dispatch.
- `copyDispatchPromptSelected` is absent from `verbAllowlist.ts`, `verbSchemas.ts`, `KanbanProvider.ts`, and `kanban.html`.
- `toggleSendableFilter` action is present in `kanban.html` column header for PLAN REVIEWED.
- `sendablePlanIds` field is present in the `updateBoard` message payload (assert by reading the message handler in `kanban.html`).
- `completedAt` and `mapFingerprint` fields are present on card objects built by `_buildBoardCards` (`KanbanProvider.ts:2154-2183`).

## Outstanding Questions

- **[user]** The removal of `copyDispatchPromptSelected` eliminates the clipboard path for the dispatch-analysis prompt. Once Analyze no longer moves cards (item 1), the reasoning is that Analyze itself becomes the safe non-committing action. Proceeding on the assumption that the user is comfortable with this — the button's purpose (escape hatch for a committing Analyze) is eliminated by making Analyze non-committing.
