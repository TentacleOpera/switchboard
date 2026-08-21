# Replace the DISPATCH display mode with a real STAGING column

## Design Decisions (settled during consultation)

These decisions were made collaboratively and are the authoritative spec for this plan. Do not re-litigate them during implementation.

1. **DISPATCH view is removed entirely.** It was a display mode (toggle) of PLAN REVIEWED doing double duty as both an organizational swimlane and the dispatch queue. That overloading caused a UI discoverability problem — there was no way to drag plans into the staging area because it wasn't a real column. The only entry path was the STAGE FOR QUEUE sub-bar button, which was disabled until you had a selection and wasn't discoverable.

2. **A new real column, STAGING, replaces it.** STAGING is a first-class kanban column stored in the DB (like every other column), positioned between PLAN REVIEWED and the coder columns (LEAD/CODER/INTERN CODED). You drag cards into it like any other column. No special button needed.

3. **STAGING has no agent registered.** It is a queue, not a coding seat. No dispatch role, no terminal. Cards sit there until dispatched out by STAGING's own buttons or by the completion-driven queue pop.

4. **No enable/disable toggle on STAGING.** The toggle was considered and rejected: since STAGING has no agent, the PLAN REVIEWED advance buttons would naturally skip it anyway (the advance path resolves a dispatch role, and STAGING has none). The column just exists. You drag into it or you don't.

5. **No advance buttons on any column target STAGING.** `getNextColumn` must skip columns with no dispatch role. STAGING is reachable only by drag-and-drop or orchestrator placement.

6. **STAGING has five buttons in its column header:**
   - **Advance selected** — move selected cards to coder columns (complexity routing)
   - **Advance all** — move all cards to coder columns
   - **Copy prompt selected** — copy prompt for selected cards and advance
   - **Copy prompt all** — copy prompt for all cards and advance
   - **Run queue** — completion-driven dispatch: first card goes to a coder terminal, rest follow on completion

7. **PLAN REVIEWED's prompt mode does not disable STAGING.** A user may prefer prompt mode on PLAN REVIEWED while still using STAGING as an automated queue. The two are independent. Run queue simply won't work if no coding terminal is live — which the existing "no coding terminal is live" gate already handles.

8. **STAGING stays visible when AUTOCODE collapse is on.** It is a distinct pipeline stage, not a coder seat. The collapse toggle only merges the three coder columns into the synthetic AUTOCODE bucket.

9. **The queue pop reads from STAGING instead of DISPATCH.** `_runQueuePop` changes its filter from `kanbanColumn === 'DISPATCH'` to `kanbanColumn === 'STAGING'`. Everything else about the pop mechanism stays as-is.

10. **DISPATCH is unreleased dev work — no migration needed.** Clean break. No data migration, no compat shims, no legacy file handling.

11. **Features are dispatched as units, never broken up.** This is existing behavior and does not change. A feature in STAGING pops as a whole to the team lead; the lead delegates subtasks internally.

12. **Standalone plans use auto complexity routing.** Existing behavior, unchanged.

13. **No teams → basic completion-driven enqueue.** Most appropriate coder gets the card, posts completion, next card pops. Existing behavior, unchanged.

14. **Auto-sorting rules are the existing ones, not new logic.** (1) If a team is in flight, don't dispatch a card (existing in-flight refusal). (2) Don't dispatch a plan across worktrees (existing worktree affinity). Anything more complex is the orchestrator's job.

15. **The STAGE FOR QUEUE sub-bar button is removed.** It was the workaround for DISPATCH not being a real column. Drag-and-drop into STAGING replaces it entirely.

16. **The DISPATCH-specific buttons (Send to Coder, Send all to coders) are removed.** Their function is absorbed by STAGING's five buttons. Run queue is the completion-driven path; advance/copy-prompt buttons are the manual paths.

## Goal

Replace the overloaded DISPATCH display mode with a single real STAGING column that serves as the pre-dispatch queue. This solves the UI discoverability problem (no drag-into-staging), separates the organizational swimlane (PLAN REVIEWED) from the queue (STAGING), and keeps the existing completion-driven dispatch mechanics intact with a one-line filter change.

### Problem Analysis

DISPATCH is a toggle view on PLAN REVIEWED (like BACKLOG is a toggle on CREATED). When active, it shows only cards staged into the queue. The problem: because it's a display mode and not a real column, you cannot drag cards into it. The only entry path is the STAGE FOR QUEUE button in the sub-bar — a button that is disabled until you select cards and is not discoverable as the way to enqueue work.

This creates a fundamental UX inconsistency: every other column transition in the kanban is a drag-and-drop operation, but entering the dispatch queue requires selecting cards and clicking a sub-bar button. Users are confused about how to actually move plans into the staging area.

The root cause is that DISPATCH does double duty: it's both an organizational view of PLAN REVIEWED (for triaging parallel-safe sets) and the dispatch queue (with Run queue, Send all to coders, Send to Coder buttons). These two concerns should be separate.

### Root Cause

DISPATCH was built as a display mode because the queue needed to live somewhere, and adding a real column to the board was more work than adding a toggle to an existing one. The staging/queue function got bolted onto PLAN REVIEWED's view, creating the discoverability problem and the conceptual overloading.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, ui, ux, refactor, feature
**Project:** Browser Switchboard

## User Review Required

None.

## Implementation

### Phase 1: Column definition and registration

1. **Add STAGING to `DEFAULT_KANB_COLUMNS`** in `agentConfig.ts` (or wherever the canonical column list lives). Position it between PLAN REVIEWED and the first coder column (INTERN CODED). Properties:
   - `id: 'STAGING'`
   - `label: 'Staging'`
   - `role: null` (no dispatch role — no agent)
   - `kind: 'staging'` (new kind, or reuse a non-coded/non-completed kind)
   - No `dragDropMode` (or default to 'cli' — irrelevant since no agent)

2. **Remove DISPATCH from `DISPLAY_MODE_COLUMNS`** (or wherever display-mode columns are defined). The DISPATCH toggle on PLAN REVIEWED goes away entirely.

3. **Remove the DISPATCH toggle button** from the PLAN REVIEWED column header in `kanban.html` (the `btn-toggle-dispatch` element and its handler).

4. **Remove the `showingDispatch` state** and all code paths that branch on it in `kanban.html`:
   - `resolveDisplayColumn` — remove the `showingDispatch` branch
   - `effectiveColumnOf` / `isHiddenByView` — remove DISPATCH cases
   - `getAllInColumn` — remove DISPATCH case
   - `suppressPipeline` — remove the `(isPlanReviewed && showingDispatch)` condition
   - `dispatchViewControls` — remove entirely
   - Any other `showingDispatch` references

### Phase 2: Queue pop retarget

5. **Change `_runQueuePop` filter** in `LocalApiServer.ts` (line ~1878): change `p.kanbanColumn === 'DISPATCH'` to `p.kanbanColumn === 'STAGING'`.

6. **Update the queue source comment** (lines ~1842-1854) to reference STAGING instead of DISPATCH.

7. **Update `stageForQueue` verb** in `KanbanProvider.ts` — either remove it entirely (since STAGE FOR QUEUE button is going away) or retarget it to move cards to STAGING. Since the button is being removed, the verb can likely be removed too. Check for other callers first.

8. **Update `STAGEABLE_COLUMNS`** in `kanban.html` (line ~6143) — remove 'DISPATCH', add 'STAGING'. Though if the STAGE FOR QUEUE button is removed, this constant may be unused.

### Phase 3: getNextColumn skip logic

9. **Make `getNextColumn` in `kanban.html` skip columns with no dispatch role.** Currently it's a pure index walk: `columns[idx + 1]`. It needs to skip STAGING (and any future role-less column) and return the next column that has a role. The simplest approach: check `columnDragDropModes` or the column definition's role — if null/undefined, skip to the next.

   **Important:** PLAN REVIEWED's advance path already bypasses `getNextColumn` via `_partitionByComplexityRoute` and `_targetColumnForDispatchRole` — it routes directly to coder columns. So this change only affects other columns' advance paths (CREATED, coder columns advancing to CODE REVIEWED, etc.). Verify that no existing column's advance path relies on landing on a role-less column.

10. **Check the backend advance path** in `KanbanProvider.ts` `moveSelected`/`moveAll` — the general path (lines ~10725-10762) resolves `nextCol` from the frontend's `getNextColumn` result (passed as `targetColumn` in the message). If the frontend skips STAGING, the backend receives the correct target. But verify there's no backend-side `getNextColumn` equivalent that also needs updating.

### Phase 4: STAGING column buttons

11. **Add the five buttons to STAGING's column header** in `kanban.html`'s `renderColumns`:
    - Advance selected (`moveSelected` action, targets coder columns via complexity routing)
    - Advance all (`moveAll` action, targets coder columns via complexity routing)
    - Copy prompt selected (`promptSelected` action)
    - Copy prompt all (`promptAll` action)
    - Run queue (`runQueue` action — same as the current DISPATCH Run queue button)

12. **STAGING advance buttons must complexity-route.** Like PLAN REVIEWED, advancing from STAGING should route by complexity to the appropriate coder column (intern/coder/lead). The backend `moveSelected`/`moveAll` handlers have a `column === 'PLAN REVIEWED'` special case for complexity routing. Either:
    - Extend that special case to `column === 'STAGING'`, or
    - Generalize the complexity routing to apply to any column whose next target is the coder columns.

13. **Run queue button gating** — same as current: disabled when no cards are staged or no coding terminal is live. Reuse the existing `dispatchStagedCount()` and `lastCodingHeadLive`/`lastAnyCodingTerminalLive` checks, retargeted to count cards in STAGING.

### Phase 5: Remove DISPATCH remnants

14. **Remove the STAGE FOR QUEUE button** (`btn-stage-for-queue`) from the sub-bar in `kanban.html` and its event handler (line ~13415).

15. **Remove `sendDispatchToCoder`, `sendDispatchSetToCoders` actions** and their handlers — these were DISPATCH-view-specific. Their function is covered by STAGING's advance/Run queue buttons.

16. **Remove `dispatchAnalyze` action** if it was DISPATCH-specific. Check whether it serves any other purpose.

17. **Remove the `dispatchStagedCount()` function** if it's DISPATCH-specific, or retarget it to count STAGING cards.

18. **Clean up DISPATCH references** in:
    - `COLUMN_ABBREV` (line ~6413) — remove DISPATCH entry, add STAGING
    - `resolveDomColumn` / `resolveDisplayColumn` — remove DISPATCH branches
    - Any drag-drop handlers that special-case DISPATCH
    - `performKanbanDispatch` in `LocalApiServer.ts` — check for DISPATCH references
    - `KanbanProvider.ts` — search for all DISPATCH references and update/remove

19. **Remove DISPATCH from `LEGACY_COLUMN_LABELS`** if present, and from any column canonicalization logic.

### Phase 6: Orchestrator and skills

20. **Update the orchestrator skill** (`.agents/protocols/switchboard-orchestrator/SKILL.md`) — references to DISPATCH as the queue column become STAGING. The handoff sequence's `stageForQueue` verb call becomes either a move to STAGING or is removed (orchestrator can move cards to STAGING via the standard move API).

21. **Update `manage-features` skill** and any other skills that reference DISPATCH as a staging area.

22. **Update `switchboard-contracts`** protocol if it documents DISPATCH as the queue column.

### Phase 7: Tests

23. **Update existing tests** that reference DISPATCH:
    - `kanban-auto-export.test.ts` — DISPATCH references
    - Any queue/dispatch tests in `src/test/`
    - Column canonicalization tests

24. **Add new tests:**
    - STAGING column appears in `DEFAULT_KANB_COLUMNS` at the correct position
    - `getNextColumn` skips STAGING (returns coder columns from PLAN REVIEWED)
    - `_runQueuePop` filters on `kanbanColumn === 'STAGING'` (not DISPATCH)
    - STAGING advance buttons complexity-route to coder columns
    - Run queue from STAGING dispatches to a coder terminal and pulls next on completion

## Complexity Audit

### Routine
- Adding a column to the canonical list
- Changing a string filter in `_runQueuePop`
- Removing a toggle button and its state
- Removing a sub-bar button
- Updating comments and skill documentation

### Complex / Risky
- **`getNextColumn` skip logic** — this function is called from many places (advance buttons, copy-prompt, card rendering). Changing it to skip role-less columns must not break any existing advance path. Must verify every caller.
- **STAGING advance complexity routing** — the backend's `moveSelected`/`moveAll` have a `column === 'PLAN REVIEWED'` special case. Extending or generalizing this to STAGING must produce identical routing behavior.
- **DISPATCH removal sweep** — DISPATCH is referenced across `kanban.html` (38+ matches), `LocalApiServer.ts`, `KanbanProvider.ts`, skills, and tests. Missing a reference could cause a card to land in a non-existent column or a UI toggle to break.
- **Run queue from STAGING** — the completion-driven dispatch chain (`_runQueuePop` → `performKanbanDispatch` → `queue/done` → pop) must work identically with STAGING as the source. The only change is the column filter, but the chain is long and has in-flight refusal, worktree affinity, and team routing logic that all assume DISPATCH today.

## Edge-Case & Dependency Audit

- **Cards already in DISPATCH** — DISPATCH is unreleased, so no shipped data. But if any dev workspace has cards in DISPATCH, they'll be orphaned. A one-time cleanup (or just leaving them — they'll be invisible) is fine.
- **`queue_position` column in the DB** — used for ordering the DISPATCH queue. STAGING should reuse it identically. No schema change needed.
- **AUTOCODE collapse** — when coder columns collapse into CODED_AUTO, STAGING stays visible. Verify the `renderColumns` logic handles this: STAGING is not in `CODED_IDS`, so `resolveDomColumn('STAGING')` returns `'STAGING'` unchanged.
- **Backlog toggle** — BACKLOG is a toggle on CREATED, independent of DISPATCH. It stays as-is. Verify no code couples the two toggles.
- **Feature cards in STAGING** — features (isFeature=1) should appear in STAGING like any other card. The queue pop already excludes subtasks (`!p.featureId`). No change needed.
- **Orchestrator handoff** — the orchestrator stages cards into the queue via `POST /kanban/verb/stageForQueue`. If this verb is removed, the orchestrator must use `POST /kanban/move` to move cards to STAGING instead. Update the orchestrator skill's handoff sequence.
- **`resolveKanbanDispatch` pre-flight** — `performKanbanDispatch` checks the target column's role. STAGING has no role, so a direct dispatch to STAGING would fail with "no dispatch role configured." This is correct — you don't dispatch TO staging, you dispatch FROM it. But verify no code path tries to dispatch to STAGING.
- **Column drag-drop** — dragging a card to STAGING should be a visual move only (no agent trigger). The backend's `triggerAction` handler should see no role for STAGING and do a move-only. Verify this matches the existing "no role → visual move only" path (line ~10759).

## Dependencies

- No external dependencies.
- No migration (DISPATCH is unreleased).
- All changes are within the existing codebase.

## Verification Plan

1. **Column layout** — STAGING appears between PLAN REVIEWED and coder columns. No DISPATCH toggle on PLAN REVIEWED.
2. **Drag into STAGING** — Drag a card from PLAN REVIEWED to STAGING. Card moves. No agent triggers.
3. **Advance from PLAN REVIEWED** — Click advance/prompt buttons on PLAN REVIEWED. Cards go to coder columns (complexity routing), NOT to STAGING.
4. **STAGING advance buttons** — Put cards in STAGING. Click "Advance selected" — cards route to coder columns by complexity. Click "Advance all" — same for all cards.
5. **Copy prompt from STAGING** — Click "Copy prompt selected" — prompt copied to clipboard, card advances to coder column.
6. **Run queue from STAGING** — Put cards in STAGING, ensure a coding terminal is live, click "Run queue" — first card dispatches to coder, completion pulls next.
7. **AUTOCODE collapse** — Toggle collapse. Coder columns merge into AUTOCODE. STAGING stays visible as its own column.
8. **No teams** — With no team seated, Run queue dispatches to the most appropriate coder. Completion pops next card.
9. **Feature in STAGING** — Drag a feature card into STAGING. Run queue dispatches it as a unit to the team lead.
10. **Orchestrator** — Orchestrator handoff moves cards to STAGING and dispatches the first card via Run queue.
11. **No DISPATCH references remain** — Grep for DISPATCH across the codebase. No references in active code (only in git history).

## Open Questions

1. **Run queue vs Start Automation interaction.** Both the STAGING column's "Run queue" button and the global "Start Automation" (autoban) button call `dispatchNextFromQueue` → `_runQueuePop`, reading from the same STAGING queue. Run queue is a one-shot completion-driven trigger (first card dispatches, completion pulls the rest). Start Automation is a timer-driven trigger (pops up to `batchSize` cards every N minutes). The `_queueNextChain` serialization prevents double-dispatch at the pop level, but the conceptual overlap remains: when would a user use both? If automation is running on a timer and the user also clicks Run queue, the timer may try to pop cards already being pulled by completion. This is not a new problem (it exists today with DISPATCH), but the next planner should evaluate whether the two buttons need mutual exclusion, clearer separation of concerns, or whether Run queue should simply be the manual equivalent of "start automation for this one batch."

## Amendments (added after the settled decisions above; they do not re-litigate them)

Three findings from tracing the queue path. All point the same way: **arrival in STAGING is a staging operation, and the ordering machinery it depends on already exists.** None changes a Design Decision — they close gaps in the phase list that would otherwise silently drop behaviour.

### A. `stageForQueue` has a live non-UI caller and must be retargeted, not removed

Phase 2 item 7 says *"Since the button is being removed, the verb can likely be removed too. Check for other callers first."* There is one: **`onStageForQueue` at `KanbanProvider:2593`**, the remote-control staging dep, which calls `this.stageForQueue(resolved, [plan.planId])` and reads back `queuePosition` to give the remote user a truthful "staged at position N" ack. `RemoteControlService.ts` also holds four DISPATCH references the phase list never names — `:117` (`'DISPATCH'` in `QUEUEABLE_TARGET_COLUMNS`), `:135`, `:342`, and `:769-770`.

More importantly, `stageForQueue` is not a button handler. It is the staging **operation**, and it does four things a column move does not:

1. `_resolveStageablePlanIds` — refuses subtasks and already-dispatched plans, returning a `refused` count.
2. `db.appendQueuePositions` — assigns `queue_position` from MAX+1. This is its **only** caller anywhere in the codebase.
3. `_refreshBoard` — so staged cards render in order.
4. **Arms the queue-level stall watch**, resolving the live coding head (lead first, then coder). Its own comment: *"Staging is the EARLIEST moment a silent night becomes possible — a queue staged but never dispatched is the worst case, not an exempt one."*

Under Decision 2, drag-and-drop is the primary way into STAGING, and a drop currently lands in the generic move branch (`moveCardToColumnWithReason` at `KanbanProvider:~10763`), which sets the column and stops. So a dragged card gets `queue_position = NULL`, no subtask refusal, and **no stall watch** — and nothing fails, so the missing watch is only noticed as a silent night much later.

This is not a limitation of drag-and-drop. The move path already returns `{ ok, detail }` per card and collects `failures` with reasons, and refusing a drop has precedent (`:9639` describes making a one-card CODED_AUTO drop refuse outright; `:7281` notes the webview `handleDrop` guard is the gate with the backend as defence-in-depth). It is simply a missing conditional.

**Amendment:** keep `stageForQueue` and route STAGING arrivals through it — drag drops, remote list mapping, and orchestrator placement alike. One operation, several triggers.

### B. Decision 5's "only" enumerates triggers, not mechanisms

Decision 5 reads *"reachable only by drag-and-drop or orchestrator placement."* The remote path is not a third entry point — it is the remote form of the same operation, and with STAGING a real column a provider list maps to it via `stateKeyToColumn` like any other column. Read Decision 5 as a list of *triggers*, all funnelling through amendment A's single operation.

Two consequences worth stating:

- **`mode` and `QUEUEABLE_TARGET_COLUMNS` become unnecessary.** `RemoteControlService`'s `ingest`/`queue` modes exist only because the same column move had to mean two different things depending on a global flag, and `QUEUEABLE_TARGET_COLUMNS` guards against an unguarded queue branch staging a card someone moved to COMPLETED. Once the destination carries the meaning, there is nothing to infer and nothing to guard. This also makes staging per-card rather than per-config — some cards queued, others dispatched directly, in one session — which a global mode cannot express.
- **The provider mapping must be an explicit list → STAGING link, never a name match.** `stateKeyToColumn` maps a remote state onto *any* local column, so a name-based match reintroduces the COMPLETED-gets-coded failure that `RemoteControlService:776` calls load-bearing, by a different route.

### C. Queue reorder already exists and is gated on the view being deleted

Sequential planning inside STAGING needs no new button. Drag-within-column reorder is built end to end:

- `kanban.html:9478-9528` — *"REORDER, not a no-op … full ordered id list to `reorderQueue`. Do not fall through to the column-move path. A multi-card drag reorders the whole selection"*, with an optimistic DOM reorder at `:9512` before the round trip.
- `reorderQueue` is in `KANBAN_VERBS`, schema at `verbSchemas.ts:409`, landing on `setQueuePositions` (`KanbanDatabase:10114`), which rewrites the whole set in one transaction.
- `_runQueuePop` pops in `queue_position` order.

But `:9055` gates it: *"Dispatch view reorders the queue."* Phase 5 deletes that view. A coder following the phase list would remove the gate and leave the reorder handler unreachable — and no test would fail, because this plan has no reorder test.

**Amendment:** re-point the reorder drop path at STAGING rather than rebuilding it, and note that reorder is only meaningful if arrival assigns positions (amendment A) — cards arriving with `queue_position = NULL` all sort last together, so there is no order to rearrange.

### Verification steps to add

12. **Dragged cards are fully staged.** Drag several cards into STAGING and confirm each receives a sequential `queue_position` (not NULL), that a subtask dragged in is refused with a reason, and that the queue-level stall watch is armed.
13. **Reorder survives the DISPATCH removal.** Drag cards within STAGING to reorder them, confirm `queue_position` is rewritten, and confirm `Run queue` pops in the new order.
14. **Remote staging still works.** Map a provider list to STAGING, move a card into it remotely, and confirm it is staged with a position and acknowledged with that position — proving `stageForQueue` was retargeted rather than removed.
15. **One operation, three triggers.** Stage the same plan by drag, by remote mapping, and by orchestrator placement; confirm the resulting DB state is identical in each case.
