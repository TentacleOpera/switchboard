# STAGING column — backend, column definition, and partial frontend (Session 1 COMPLETE)

> **This plan was split.** The original 8-phase mega-plan was divided into 3 independently-codeable plans after Session 1 burned a coder's context window. This file covers the backend + column definition + partial frontend (Phases 1-3 complete, Phase 4-6 partial). Remaining work is in:
> - `staging-column-2-frontend-dispatch-cleanup.md` — finish DISPATCH removal in kanban.html, drag-into-STAGING routing, reorder re-pointing, getNextColumn skip, btn-stage-for-queue removal
> - `staging-column-3-skills-docs-tests.md` — skill/protocol doc updates, test updates, new STAGING tests
>
> All 3 plans should be grouped into a feature: "STAGING column replaces DISPATCH view".

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

Replace the overloaded DISPATCH display mode with a single real STAGING column that serves as the pre-dispatch queue. This solves the UI discoverability problem (no drag-into-staging), separates the organizational swimlane (PLAN REVIEWED) from the queue (STAGING), and keeps the existing completion-driven dispatch mechanics intact with a filter change — though the change is a multi-file sweep, not a single line (see Proposed Changes).

### Problem Analysis

DISPATCH is a toggle view on PLAN REVIEWED (like BACKLOG is a toggle on CREATED). When active, it shows only cards staged into the queue. The problem: because it's a display mode and not a real column, you cannot drag cards into it. The only entry path is the STAGE FOR QUEUE button in the sub-bar — a button that is disabled until you select cards and is not discoverable as the way to enqueue work.

This creates a fundamental UX inconsistency: every other column transition in the kanban is a drag-and-drop operation, but entering the dispatch queue requires selecting cards and clicking a sub-bar button. Users are confused about how to actually move plans into the staging area.

The root cause is that DISPATCH does double duty: it's both an organizational view of PLAN REVIEWED (for triaging parallel-safe sets) and the dispatch queue (with Run queue, Send all to coders, Send to Coder buttons). These two concerns should be separate.

### Root Cause

DISPATCH was built as a display mode because the queue needed to live somewhere, and adding a real column to the board was more work than adding a toggle to an existing one. The staging/queue function got bolted onto PLAN REVIEWED's view, creating the discoverability problem and the conceptual overloading.

## Metadata

**Complexity:** 7
**Tags:** frontend, backend, ui, ux, refactor, feature
**Project:** Browser Switchboard

## User Review Required

None.

> **Complexity note:** Originally scored 5, then 6. Should have been 7-8 and split into a feature from the start. The 8-phase, 42-step, 6+ file scope burned a coder's context window in Session 1. Now split into 3 plans (this file + 2 siblings). This plan's remaining work is limited to what Session 1 already completed — the unfinished frontend work moved to `staging-column-2-frontend-dispatch-cleanup.md`.

## Complexity Audit

### Routine
- Adding a column to the canonical list (`DEFAULT_KANBAN_COLUMNS` in `agentConfig.ts`)
- Removing a toggle button and its state (`showingDispatch`)
- Removing a sub-bar button (`btn-stage-for-queue`)
- Updating comments and skill documentation
- Adding a `COLUMN_ABBREV` entry for STAGING

### Complex / Risky
- **`getNextColumn` / `_getNextColumnId` skip logic** — BOTH the frontend `getNextColumn` (kanban.html:7113) AND the backend `_getNextColumnId` (KanbanProvider.ts:6965) must skip columns with no dispatch role. The backend's `shouldSkip` function (KanbanProvider.ts:6979) currently skips `featureOnly`, `disabled`, and invisible-role columns — but NOT role-less columns. This is a MUST UPDATE, not a verify. Every column's advance path except PLAN REVIEWED's (which uses complexity routing) goes through `_getNextColumnId`. Missing this causes cards to land in STAGING from CREATED/RESEARCHER advance buttons.
- **STAGING advance complexity routing** — the backend's `moveSelected`/`moveAll` have a `column === 'PLAN REVIEWED'` special case for complexity routing (KanbanProvider.ts:10506, 10670, 10814). Extending this to `column === 'STAGING'` must produce identical routing behavior.
- **DISPATCH removal sweep** — DISPATCH is hardcoded in 13+ locations across 6+ source files (not counting tests, skills, and docs). Each is a silent-failure risk if missed: `appendQueuePositions` writes `kanban_column = 'DISPATCH'` in raw SQL (KanbanDatabase.ts:10094), `_resolveStageablePlanIds` has a `Set` including `'DISPATCH'` (KanbanProvider.ts:8178), `moveCardToColumnWithReason` checks `kanbanColumn === 'DISPATCH'` (KanbanProvider.ts:8120), `PlanIngestionEngine.ts:1338` filters the queue watch, `TaskViewerProvider.ts:10963` and `:11644` filter the autoban sweep and orchestrator handoff, `LocalApiServer.ts:2311` re-stages failed cards to `'DISPATCH'`, `KanbanDatabase.ts:9297` initializes a `'DISPATCH'` bucket, `KanbanDatabase.ts:967` includes `'DISPATCH'` in `VALID_KANBAN_COLUMNS`, `RemoteControlService.ts:117` includes `'DISPATCH'` in `QUEUEABLE_TARGET_COLUMNS`.
- **Run queue from STAGING** — the completion-driven dispatch chain (`_runQueuePop` → `performKanbanDispatch` → `queue/done` → pop) must work identically with STAGING as the source. The only change is the column filter, but the chain is long and has in-flight refusal, worktree affinity, and team routing logic that all assume DISPATCH today.
- **Drag-into-STAGING must route through `stageForQueue`** — a drag drop currently lands in the generic move branch (`moveCardToColumnWithReason`), which sets the column and stops. A dragged card would get `queue_position = NULL`, no subtask refusal, and no stall watch. The drop handler must detect STAGING as the target and call `stageForQueue` instead of the generic move (Amendment A).
- **Reorder handler re-pointing** — the same-column drag reorder (kanban.html:9487-9530) is gated on `showingDispatch && effectiveTargetColumn === 'DISPATCH'`. Removing DISPATCH makes this handler unreachable. It must be re-pointed at STAGING (Amendment C).

## Edge-Case & Dependency Audit

- **Cards already in DISPATCH** — DISPATCH is unreleased, so no shipped data. But if any dev workspace has cards in DISPATCH, they'll be orphaned. A one-time cleanup (or just leaving them — they'll be invisible) is fine.
- **`queue_position` column in the DB** — used for ordering the DISPATCH queue. STAGING should reuse it identically. No schema change needed. The `appendQueuePositions` function (KanbanDatabase.ts:10066) hardcodes `'DISPATCH'` in its SQL — must be changed to `'STAGING'`.
- **AUTOCODE collapse** — when coder columns collapse into CODED_AUTO, STAGING stays visible. Verify the `renderColumns` logic handles this: STAGING is not in `CODED_IDS`, so `resolveDomColumn('STAGING')` returns `'STAGING'` unchanged.
- **Backlog toggle** — BACKLOG is a toggle on CREATED, independent of DISPATCH. It stays as-is. Verify no code couples the two toggles.
- **Feature cards in STAGING** — features (isFeature=1) should appear in STAGING like any other card. The queue pop already excludes subtasks (`!p.featureId`). No change needed.
- **Orchestrator handoff** — the orchestrator stages cards into the queue via `POST /kanban/verb/stageForQueue`. With `stageForQueue` retargeted to STAGING (via `appendQueuePositions`), this works automatically. The orchestrator skill's handoff sequence must be updated to reference STAGING.
- **`resolveKanbanDispatch` pre-flight** — `performKanbanDispatch` checks the target column's role. STAGING has no role, so a direct dispatch to STAGING would fail with "no dispatch role configured." This is correct — you don't dispatch TO staging, you dispatch FROM it. But verify no code path tries to dispatch to STAGING.
- **Column drag-drop** — dragging a card to STAGING should trigger `stageForQueue` (Amendment A), not the generic move. The backend's `triggerAction` handler should see no role for STAGING and do a move-only — but the frontend drop handler must intercept STAGING drops and call `stageForQueue` before the generic move fires.
- **Column ordering** — RESEARCHER (order 110) sits between PLAN REVIEWED (100) and the coder columns (LEAD CODED=120). STAGING must be placed at order 115 (between RESEARCHER and LEAD CODED) so it is visually adjacent to the coder columns per Design Decision 2. With `_getNextColumnId` skip logic, advancing from RESEARCHER skips STAGING and lands on LEAD CODED.
- **`dispatchAnalyze` action** — the Analyze button on PLAN REVIEWED fires `dispatchAnalyze` (KanbanProvider.ts:11840), which triggers the planner with a 'dispatch-analysis' instruction. The dispatch-analysis skill (`.agents/protocols/dispatch-analysis/SKILL.md`) moves cards to DISPATCH. This skill must be updated to move cards to STAGING, or the Analyze button will stage cards into a non-existent column.
- **Backend `showingDispatch` messages** — the backend pushes `showingDispatch` in board updates (kanban.html:10007) and `dispatchViewState` messages (kanban.html:10348). These backend message sends must be removed alongside the frontend state.
- **`RemoteControlService.ts` mode/queue cleanup** — Amendment B says `mode` and `QUEUEABLE_TARGET_COLUMNS` become unnecessary once the destination column carries the meaning. The phase list must explicitly cover removing `QUEUEABLE_TARGET_COLUMNS` (line 117) and the `mode === 'queue'` branch (line 783), or an implementer following the phases will miss them.
- **`autobanState.ts` comment** — line 310 references "pop the DISPATCH queue on a timer" in a comment. `AUTOBAN_SOURCE_COLUMN = 'PLAN REVIEWED'` (line 22) is NOT DISPATCH and does not need changing, but the comment should be updated.
- **`teamWiring.ts` comments** — lines 303, 348 reference "kanban DISPATCH column" in comments. Update to STAGING.
- **`KanbanProvider.ts` line 138** — `queuePosition` field comment references "DISPATCH session queue". Update to STAGING.
- **`KanbanDatabase.ts` line 119** — `queuePosition` field comment references "DISPATCH session queue". Update to STAGING.

## Dependencies

- No external dependencies.
- No migration (DISPATCH is unreleased).
- All changes are within the existing codebase.

## Adversarial Synthesis

Key risks: (1) The DISPATCH removal is a 13+ location sweep across 6+ files, not a "one-line filter change" — missing any hardcoded reference causes silent failures (cards vanish, queue doesn't pop, stall watch doesn't arm). (2) The backend `_getNextColumnId` `shouldSkip` function must be extended to skip role-less columns — the plan originally treated this as a "verify" but it is a definite must-update. (3) Drag-into-STAGING must route through `stageForQueue` (not the generic move) to get `queue_position` assignment, subtask refusal, and stall-watch arming — the amendments close this gap but must be integrated into the phase list. Mitigations: integrate all amendments into the numbered phases, add a comprehensive DISPATCH reference sweep step with the full file/line list, and make the `_getNextColumnId` skip logic a definitive step.

## Proposed Changes

> **Completion status:** Steps marked `[x]` were completed in Session 1. Steps marked `[ ]` were NOT completed and have moved to a sibling plan (noted in brackets). This plan's remaining work is zero — all incomplete items have been extracted into `staging-column-2-frontend-dispatch-cleanup.md` and `staging-column-3-skills-docs-tests.md`.

### Phase 1: Column definition and registration

- [x] **1.** Add STAGING to `DEFAULT_KANBAN_COLUMNS` in `agentConfig.ts:149` at order 115 (between RESEARCHER at 110 and LEAD CODED at 120). Properties: `id: 'STAGING'`, `label: 'Staging'`, `role: undefined`, `order: 115`, `kind: 'staging'`, `source: 'built-in'`, `autobanEnabled: false`.

  > **Superseded:** Add STAGING to `DEFAULT_KANB_COLUMNS` in `agentConfig.ts` (or wherever the canonical column list lives). Position it between PLAN REVIEWED and the first coder column (INTERN CODED).
  > **Reason:** The actual export name is `DEFAULT_KANBAN_COLUMNS` (agentConfig.ts:149), not `DEFAULT_KANB_COLUMNS`. The first coder column by order is LEAD CODED (order 120), not INTERN CODED (order 200). RESEARCHER (order 110) sits between PLAN REVIEWED (100) and the coder columns. STAGING must be at order 115 to be visually adjacent to the coder columns per Design Decision 2.
  > **Replaced with:** Add STAGING to `DEFAULT_KANBAN_COLUMNS` in `agentConfig.ts:149` at order 115 (between RESEARCHER at 110 and LEAD CODED at 120).

- [x] **2.** Remove DISPATCH from `DISPLAY_MODE_COLUMNS` in `agentConfig.ts:167-170`. BACKLOG stays.
- [x] **3.** Remove the DISPATCH toggle button from the PLAN REVIEWED column header in `kanban.html` — `dispatchToggleBtn` element and its handler.
- [x] **4.** Remove the `showingDispatch` state and code paths that branch on it in `kanban.html` (resolveDisplayColumn, effectiveColumnOf/isHiddenByView, getAllInColumn, suppressPipeline, dispatchViewControls, computeColumnOccupancy, renderBoard displayCards filter, columnDisplayLabel, dispatchViewState handler, showingDispatch assignment from board update). **NOTE: ~7 `showingDispatch` references in drag-drop handlers remain — these are dead references to a deleted variable causing runtime errors. → Moved to `staging-column-2-frontend-dispatch-cleanup.md` step 1.**
- [x] **5.** Remove backend `showingDispatch` message pushes from `KanbanProvider.ts` (all 4 board-update sites).

### Phase 2: Queue pop retarget and DB hardcoding

- [x] **6.** Change `_runQueuePop` filter in `LocalApiServer.ts:1900`: `p.kanbanColumn === 'DISPATCH'` → `p.kanbanColumn === 'STAGING'`.
- [x] **7.** Update queue source comment in `LocalApiServer.ts:1864-1876` to reference STAGING.
- [x] **8.** Change `appendQueuePositions` hardcoded DISPATCH in `KanbanDatabase.ts` (line 10081 MAX query, line 10094 UPDATE SET) to `'STAGING'`.
- [x] **9.** Change `VALID_KANBAN_COLUMNS` in `KanbanDatabase.ts:967` — remove `'DISPATCH'`, add `'STAGING'` (via DEFAULT_KANBAN_COLUMNS).
- [x] **10.** Change `KanbanDatabase.ts:9297` — `columns.set('DISPATCH', [])` removed (STAGING added via DEFAULT_KANBAN_COLUMNS).
- [x] **11.** Keep `stageForQueue` and retarget via `appendQueuePositions` (Amendment A). Comments updated in verb handler and `onStageForQueue` dep.

  > **Superseded:** Update `stageForQueue` verb — either remove it entirely (since STAGE FOR QUEUE button is going away) or retarget it. Since the button is being removed, the verb can likely be removed too. Check for other callers first.
  > **Reason:** `stageForQueue` has a live non-UI caller: `onStageForQueue` at KanbanProvider.ts:2620. It is the staging operation itself (assigns queue_position, refuses subtasks, arms stall watch). Removing it would break remote staging and lose the stall watch.
  > **Replaced with:** Keep `stageForQueue` and retarget via `appendQueuePositions`. The verb handler and remote dep both call `this.stageForQueue()`, which works automatically once `appendQueuePositions` is retargeted.

- [x] **12.** Update `_resolveStageablePlanIds` in `KanbanProvider.ts:8178` — `'DISPATCH'` → `'STAGING'` in the Set.
- [x] **13.** Update `moveCardToColumnWithReason` in `KanbanProvider.ts:8120` — `kanbanColumn === 'DISPATCH'` → `'STAGING'` for queue_position clearing.
- [x] **14.** Update `STAGEABLE_COLUMNS` in `kanban.html:6143` — `'DISPATCH'` → `'STAGING'`.
- [x] **15.** Update `PlanIngestionEngine.ts:1338` — `'DISPATCH'` → `'STAGING'` in queue watch filter.
- [x] **16.** Update `TaskViewerProvider.ts` — both `_autobanHasStagedQueueCards` (line 10963) and orchestrator handoff (line 11644) changed to `'STAGING'`. All comments updated.
- [x] **17.** Update `LocalApiServer.ts:2311` — failed-card re-stage changed to `'STAGING'`. Comments updated (lines 75-76, 4042, 5103).

### Phase 3: getNextColumn / _getNextColumnId skip logic

- [ ] **18.** Frontend `getNextColumn` in `kanban.html:7113` — add skip logic for role-less columns. **→ Moved to `staging-column-2-frontend-dispatch-cleanup.md` step 5.**
- [x] **19.** Backend `_getNextColumnId` in `KanbanProvider.ts:6965` — `shouldSkip` function extended to skip columns with no `role` (STAGING has none).

  > **Superseded:** Check the backend advance path — verify there's no backend-side `getNextColumn` equivalent that also needs updating.
  > **Reason:** The backend does NOT receive the next column from the frontend. The backend independently calls `_getNextColumnId` in the `moveSelected` handler (line 10721), `moveAll` handler (line 10865), and `promptSelected` handler (line 11002). The backend's `shouldSkip` function does NOT skip role-less columns.
  > **Replaced with:** Make `_getNextColumnId` skip columns with no dispatch role by extending `shouldSkip`.

### Phase 4: STAGING column buttons

- [x] **20.** Add five buttons to STAGING's column header in `kanban.html` `renderColumns` (advance selected, advance all, copy prompt selected, copy prompt all, run queue). `stagingViewControls` added with Run queue + add coder terminal + info span.
- [x] **21.** STAGING advance complexity routing — `moveSelected`/`moveAll` special case extended from `column === 'PLAN REVIEWED'` to `(column === 'PLAN REVIEWED' || column === 'STAGING')` in both handlers.
- [x] **22.** Run queue button gating — reuses existing checks, retargeted to STAGING.
- [x] **23.** `dispatchStagedCount()` replaced with `stagingCount()` (counts `c.column === 'STAGING'`).
- [x] **24.** `updateDispatchToggleCount()` removed. `updateDispatchViewInfo()` replaced with `updateStagingViewInfo()`. All call sites updated.

### Phase 5: Drag-into-STAGING routing (Amendment A)

- [ ] **25.** Route STAGING drop targets through `stageForQueue` in `kanban.html` drop handler. **→ Moved to `staging-column-2-frontend-dispatch-cleanup.md` step 3.**
- [ ] **26.** Re-point the reorder drop path at STAGING (Amendment C). **→ Moved to `staging-column-2-frontend-dispatch-cleanup.md` step 4.**

### Phase 6: Remove DISPATCH remnants

- [ ] **27.** Remove `btn-stage-for-queue` button and handler from `kanban.html`. **→ Moved to `staging-column-2-frontend-dispatch-cleanup.md` step 6.**
- [x] **28.** Remove `sendDispatchToCoder`, `sendDispatchSetToCoders` verb handlers from `KanbanProvider.ts`. Schemas removed from `verbSchemas.ts`.
- [x] **29.** `dispatchAnalyze` action kept (NOT DISPATCH-specific — it's a PLAN REVIEWED button). Comment updated. Dispatch-analysis skill update → Moved to `staging-column-3-skills-docs-tests.md` step 2.
- [x] **30.** `sendDispatchBtn` and `dispatchViewControls` removed from column header template.
- [~] **31.** Clean up DISPATCH references. **Partially done** — `COLUMN_ABBREV` STAGING entry added, `resolveDomColumn`/`resolveDisplayColumn` DISPATCH branches removed, `promptSelected` DISPATCH resolution removed. **Remaining: ~10 DISPATCH references in drag-drop handlers, run sheet display, and stage-for-queue comment → Moved to `staging-column-2-frontend-dispatch-cleanup.md` steps 1-2.** Comment updates in KanbanDatabase.ts, autobanState.ts, teamWiring.ts, KanbanProvider.ts, LocalApiServer.ts all done.
- [x] **32.** DISPATCH not present in `LEGACY_COLUMN_LABELS` — no action needed.
- [~] **33.** `RemoteControlService.ts` `mode` and `QUEUEABLE_TARGET_COLUMNS` — **partially done**: `QUEUEABLE_TARGET_COLUMNS` moved inside `mode === 'queue'` branch and changed to `'STAGING'`. **Full removal of `mode` flag not done → Moved to `staging-column-2-frontend-dispatch-cleanup.md` (note: the sibling plan covers the remaining drag-drop DISPATCH refs; the `mode` removal may need its own assessment).**

### Phase 7: Orchestrator and skills

- [ ] **34-40.** All skill/protocol/doc updates. **→ Moved to `staging-column-3-skills-docs-tests.md` steps 1-8.**

### Phase 8: Tests

- [ ] **41-42.** All test updates and new tests. **→ Moved to `staging-column-3-skills-docs-tests.md` steps 9-18.**

## Verification Plan

### Manual Verification

1. **Column layout** — STAGING appears between RESEARCHER and LEAD CODED. No DISPATCH toggle on PLAN REVIEWED.
2. **Drag into STAGING** — Drag a card from PLAN REVIEWED to STAGING. Card moves, receives a `queue_position`, and the stall watch arms. No agent triggers.
3. **Advance from PLAN REVIEWED** — Click advance/prompt buttons on PLAN REVIEWED. Cards go to coder columns (complexity routing), NOT to STAGING.
4. **Advance from CREATED** — Click advance on CREATED. Cards go to PLAN REVIEWED (not STAGING). Verify `_getNextColumnId` skip logic.
5. **Advance from RESEARCHER** — Click advance on RESEARCHER. Cards go to LEAD CODED (not STAGING). Verify `_getNextColumnId` skip logic.
6. **STAGING advance buttons** — Put cards in STAGING. Click "Advance selected" — cards route to coder columns by complexity. Click "Advance all" — same for all cards.
7. **Copy prompt from STAGING** — Click "Copy prompt selected" — prompt copied to clipboard, card advances to coder column.
8. **Run queue from STAGING** — Put cards in STAGING, ensure a coding terminal is live, click "Run queue" — first card dispatches to coder, completion pulls next.
9. **AUTOCODE collapse** — Toggle collapse. Coder columns merge into AUTOCODE. STAGING stays visible as its own column.
10. **No teams** — With no team seated, Run queue dispatches to the most appropriate coder. Completion pops next card.
11. **Feature in STAGING** — Drag a feature card into STAGING. Run queue dispatches it as a unit to the team lead.
12. **Orchestrator** — Orchestrator handoff moves cards to STAGING and dispatches the first card via Run queue.
13. **No DISPATCH references remain** — Grep for DISPATCH across the codebase. No references in active code (only in git history).
14. **Dragged cards are fully staged** — Drag several cards into STAGING and confirm each receives a sequential `queue_position` (not NULL), that a subtask dragged in is refused with a reason, and that the queue-level stall watch is armed.
15. **Reorder survives the DISPATCH removal** — Drag cards within STAGING to reorder them, confirm `queue_position` is rewritten, and confirm `Run queue` pops in the new order.
16. **Remote staging still works** — Map a provider list to STAGING, move a card into it remotely, and confirm it is staged with a position and acknowledged with that position.
17. **One operation, three triggers** — Stage the same plan by drag, by remote mapping, and by orchestrator placement; confirm the resulting DB state is identical in each case.
18. **Analyze button** — Click Analyze on PLAN REVIEWED. The dispatch-analysis skill moves cards to STAGING (not DISPATCH).

### Automated Tests

- **Column definition test:** STAGING in `DEFAULT_KANBAN_COLUMNS` at order 115, `role: undefined`, `kind: 'staging'`.
- **`getNextColumn` skip test:** `getNextColumn('PLAN REVIEWED')` returns first coder column, not STAGING. `getNextColumn('RESEARCHER')` returns LEAD CODED, not STAGING.
- **`_getNextColumnId` skip test:** Same assertions for the backend function.
- **Queue pop filter test:** `_runQueuePop` filters on `kanbanColumn === 'STAGING'`.
- **`appendQueuePositions` test:** Writes `kanban_column = 'STAGING'` and assigns sequential `queue_position`.
- **STAGING advance complexity routing test:** Advancing from STAGING routes by complexity to coder columns, identical to PLAN REVIEWED.
- **Run queue from STAGING test:** First card dispatches, completion pulls next.
- **Drag-into-STAGING test:** Drop calls `stageForQueue`, assigns `queue_position`, refuses subtasks.
- **Reorder test:** Same-column drag in STAGING rewrites `queue_position`, Run queue pops in new order.
- **Remote staging test:** Provider list maps to STAGING, card staged with position, acknowledged.
- **DISPATCH sweep test:** Grep assertion — no `DISPATCH` column references in active source files (excluding git history and `.switchboard/plans/` archive).

> **Note:** The verification plan above documents all checks. Per session directives, compilation and automated tests are NOT executed during this planning run — they remain documented for the implementer.

## Outstanding Questions

1. **Run queue vs Start Automation interaction.** Both the STAGING column's "Run queue" button and the global "Start Automation" (autoban) button call `dispatchNextFromQueue` → `_runQueuePop`, reading from the same STAGING queue. Run queue is a one-shot completion-driven trigger (first card dispatches, completion pulls the rest). Start Automation is a timer-driven trigger (pops up to `batchSize` cards every N minutes). The `_queueNextChain` serialization prevents double-dispatch at the pop level, but the conceptual overlap remains: when would a user use both? If automation is running on a timer and the user also clicks Run queue, the timer may try to pop cards already being pulled by completion. This is not a new problem (it exists today with DISPATCH), but the next planner should evaluate whether the two buttons need mutual exclusion, clearer separation of concerns, or whether Run queue should simply be the manual equivalent of "start automation for this one batch." — proceeding on the assumption that the two coexist as they do today, with `_queueNextChain` serialization as the safety net.

---

## Implementation Progress Log

### Session 1 — 2026-07-14

**Completed:**

- **Phase 1 (steps 1–5):** STAGING added to `DEFAULT_KANBAN_COLUMNS` at order 115 with `kind: 'staging'`. DISPATCH removed from `DISPLAY_MODE_COLUMNS`. `showingDispatch` field, getter, `toggleDispatchView` handler, `dispatchViewState` push, and all `showingDispatch` board-update fields removed from `KanbanProvider.ts`. Backend `showingDispatch` message pushes removed from all 4 board-update sites.
- **Phase 2 (steps 6–17):** `_runQueuePop` filter changed to `kanbanColumn === 'STAGING'` in `LocalApiServer.ts`. `appendQueuePositions` SQL retargeted to `'STAGING'` (both MAX query and UPDATE). `VALID_KANBAN_COLUMNS` updated (DISPATCH removed, STAGING added via DEFAULT_KANBAN_COLUMNS). `columns.set('DISPATCH', [])` removed from board grouping. `stageForQueue` comments updated. `_resolveStageablePlanIds` Set changed to include `'STAGING'`. `moveCardToColumnWithReason` queue_position clearing changed to `'STAGING'`. `STAGEABLE_COLUMNS` in kanban.html updated. `PlanIngestionEngine.ts` queue watch filter changed to `'STAGING'`. `TaskViewerProvider.ts` — both `_autobanHasStagedQueueCards` and orchestrator handoff queue check changed to `'STAGING'`, all comments updated. `LocalApiServer.ts` failed-card re-stage changed to `'STAGING'`, all comments updated (lines 75-76, 4042, 5103). `autobanState.ts:310` comment updated. `teamWiring.ts` comments updated (lines 303, 348). `KanbanDatabase.ts` comments updated (lines 119, 508-509, 8567, 10048, 10066, 10068). `KanbanProvider.ts:138` queuePosition comment updated. `KanbanProvider.ts` `_isColumnBefore` order list updated (DISPATCH → STAGING). `KanbanProvider.ts` `stageForQueue`/`reorderQueue`/`runQueue` verb handler comments and status messages updated. `KanbanProvider.ts` `dispatchAnalyze` comment updated. `KanbanProvider.ts` `triggerAction` comment updated. `KanbanProvider.ts` `onStageForQueue` dep comment updated.
- **Phase 3 (steps 18–19):** `_getNextColumnId` `shouldSkip` function extended to skip columns with no `role` (STAGING has none). Frontend `getNextColumn` in kanban.html — NOT yet updated (STAGING is a real column in `columns[]`, so the index walk will land on it; needs the same role-less skip).
- **Phase 2/3 cross-cutting:** `moveSelected` and `moveAll` complexity routing special case extended from `column === 'PLAN REVIEWED'` to `(column === 'PLAN REVIEWED' || column === 'STAGING')` in KanbanProvider.ts (both the moveSelected and moveAll handlers). `sendDispatchToCoder` and `sendDispatchSetToCoders` verb handlers removed from KanbanProvider.ts. `sendDispatchToCoder` and `sendDispatchSetToCoders` schemas removed from `verbSchemas.ts`.
- **Phase 4–6 (kanban.html, PARTIAL):**
  - `COLUMN_ABBREV` — STAGING entry added (`'S'`).
  - `showingDispatch` state variable removed.
  - `dispatchViewState` message handler removed.
  - `showingDispatch` assignment from board update removed.
  - `resolveDisplayColumn` — DISPATCH branch removed.
  - `getAllInColumn` — DISPATCH cases removed from `effectiveColumnOf` and `isHiddenByView`.
  - `computeColumnOccupancy` — DISPATCH filter/remap removed.
  - `renderBoard` displayCards filter — DISPATCH filter/remap removed.
  - V60 queue sort condition changed from `(col === 'PLAN REVIEWED' && showingDispatch)` to `(col === 'STAGING')`.
  - `moveCardElements` queue insert condition changed from `(domTargetColumn === 'PLAN REVIEWED' && showingDispatch)` to `(domTargetColumn === 'STAGING')`.
  - Column header template: `dispatchToggleBtn` removed from template and event listener. `dispatchToggleBtn` variable definition removed. `sendDispatchBtn` removed. `dispatchViewControls` removed. `stagingViewControls` added (Run queue + add coder terminal + info span). `analyzeBtn` condition changed from `(isPlanReviewed && !showingDispatch)` to `(isPlanReviewed)`. `suppressPipeline` condition simplified to `(isCreated && showingBacklog)`. `columnDisplayLabel` DISPATCH case removed.
  - `dispatchStagedCount()` replaced with `stagingCount()` (counts `c.column === 'STAGING'`).
  - `updateDispatchToggleCount()` removed entirely.
  - `updateDispatchViewInfo()` replaced with `updateStagingViewInfo()` (targets `staging-view-info` element, removes `sendBtn` logic).
  - All `updateDispatchToggleCount()` / `updateDispatchViewInfo()` call sites updated to `updateStagingViewInfo()`.
  - Board update handler comments updated (`updateStagingViewInfo` references).
  - `promptSelected` DISPATCH resolution block removed (STAGING is a real column, no resolution needed). Complexity routing condition changed to `(column === 'PLAN REVIEWED' || column === 'STAGING')`.
  - `RemoteControlService.ts` — `QUEUEABLE_TARGET_COLUMNS` moved from module-level to inside the `mode === 'queue'` branch (now includes `'STAGING'` instead of `'DISPATCH'`). `onStageForQueue` dep comment and `_normalizeMode` comment updated.

**Remaining (in kanban.html):**
- ~15 DISPATCH references in drag-drop handlers: `effectiveTargetColumn` DISPATCH mapping (line ~9411), same-column reorder gate (line ~9423), source DOM column resolution (lines ~9354, 9509, 9584), card-level "→ Planned" button (line ~9001), copy-prompt DISPATCH resolution (line ~8949), source column index DISPATCH mapping (line ~9476), Stage-for-queue comment (line ~10919), run sheet display (lines ~11936, 11938).
- Frontend `getNextColumn` skip logic for STAGING (Phase 3 step 18 — not yet done).
- `btn-stage-for-queue` removal (Phase 6 step 27).
- `dispatchAnalyze` comment in copy-prompt button area (line ~7627, already partially cleaned).

**Remaining (other files):**
- `agentPromptBuilder.ts` — DISPATCH references not yet checked.
- `implementation.html` — DISPATCH references not yet checked.
- Phase 5 (step 25): Drag-into-STAGING routing through `stageForQueue` — not yet implemented.
- Phase 5 (step 26): Reorder drop path re-pointing at STAGING — not yet implemented.
- Phase 7 (steps 34–40): Orchestrator and skills docs — not yet started.
- Phase 8 (steps 41–42): Tests — not yet started.
- Red team review — not yet started.

**Not yet verified:**
- No compilation or test run has been done. All changes are uncommitted.
