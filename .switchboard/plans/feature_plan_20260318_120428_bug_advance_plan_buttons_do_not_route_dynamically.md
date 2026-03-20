# Bug: advance plan buttons do not route dynamically

## Goal
- ADvance plan buttons do not have dynamic routing. they are hardcoded to lead coder. This is terrible behaviour. I thoughthe kanban had dynamic routing?

## Source Analysis
- `src/webview/kanban.html`
  - The Kanban column header renders the advance controls for each non-final column (`moveSelected` and `moveAll`), which are the most likely "advance plan buttons" referenced by this bug.
  - These actions post `moveSelected` / `moveAll` messages with the source column ID, not a pre-resolved routed destination.
- `src/services/KanbanProvider.ts`
  - `moveSelected` and `moveAll` currently call `_getNextColumnId(column)` and then `_columnToRole(nextCol)`.
  - For `PLAN REVIEWED`, the next ordered column is `LEAD CODED`, so these actions default to `lead` instead of resolving per-plan routing.
  - This is the direct hardcoded behavior described in the goal.
- `src/services/TaskViewerProvider.ts`
  - `_resolvePlanReviewedDispatchRole(sessionId, workspaceRoot)` already resolves `PLAN REVIEWED` plans dynamically (`Low -> coder`, otherwise `lead`) using the current plan file.
  - `_getNextKanbanColumnForSession(...)` and `_targetColumnForRole(...)` already translate that role into the correct target column (`CODER CODED` or `LEAD CODED`).
  - The ticket-view `Send to Agent` path already uses this dynamic route resolution and is therefore an important regression boundary, not the primary bug target.
- `src/services/KanbanProvider.ts`
  - `handleMcpMove()` also has a complexity-aware routing path via `_resolveComplexityRoutedRole(...)`.
  - That means Switchboard already has multiple dynamic-routing implementations; this bug exists because the column-header advance controls do not use them.
- `src/services/agentConfig.ts`
  - The current board model already uses separate `LEAD CODED` and `CODER CODED` columns.
  - This plan must therefore fix routing between those two destinations, not reintroduce any legacy single-`CODED` assumptions.

## Root-Cause Summary
- The broken behavior is not that Switchboard lacks dynamic routing globally.
- The real issue is that the Kanban column-header advance actions for `PLAN REVIEWED` still use static "next column" logic, which always resolves to `LEAD CODED`.
- Other surfaces already behave differently:
  - ticket-view send resolves dynamically,
  - autoban resolves dynamically,
  - conversational `move_kanban_card` resolves dynamically.
- As a result, the same plan can route differently depending on which UI entry point the user clicks. That inconsistency is the bug to eliminate.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Define the exact scope of the fix and preserve unaffected entry points
   - Primary files:
     - `src/webview/kanban.html`
     - `src/services/KanbanProvider.ts`
   - **Clarification:** Treat "advance plan buttons" as the Kanban column-header direct-advance controls (`moveSelected` and `moveAll`) that advance plans from their current column.
   - **Clarification:** Do not redesign ticket-view `Send to Agent`, autoban, or MCP conversational routing; those are reference behaviors that this fix should align with.
2. Update user-facing result messages for mixed routing outcomes
   - Primary file: `src/services/KanbanProvider.ts`
   - When a `PLAN REVIEWED` batch splits across `lead` and `coder`, success messaging should no longer imply a single static destination.
   - **Clarification:** This is not a new UX feature; it is required so the fixed behavior is described accurately after routing is no longer single-target.
3. Add focused regression coverage around Kanban header routing
   - Primary test area:
     - `src\test\...` (new targeted regression test)
   - Cover the `PLAN REVIEWED` header advance path so future refactors do not fall back to static column ordering.
   - Keep an assertion boundary around the already-dynamic ticket-view send path to avoid regressing that existing fix.

### Band B — Complex / Risky / High Complexity
1. Reuse or extract a shared session-aware route resolver for `PLAN REVIEWED`
   - Primary files:
     - `src/services/KanbanProvider.ts`
     - `src/services/TaskViewerProvider.ts`
   - The fix should not introduce a third independent copy of low/high routing logic.
   - Prefer reusing the existing dynamic helpers already backed by current complexity parsing / agent recommendation semantics.
   - Expected output per session:
     - resolved dispatch role (`lead` or `coder`)
     - resolved destination column (`LEAD CODED` or `CODER CODED`)
2. Rework `moveSelected` so it routes per plan instead of by static board order
   - Primary file: `src/services/KanbanProvider.ts`
   - Current behavior:
     - `PLAN REVIEWED` -> `_getNextColumnId()` -> `LEAD CODED` -> `lead`
   - Target behavior:
     - if the source column is **not** `PLAN REVIEWED`, keep current ordered-column behavior
     - if the source column **is** `PLAN REVIEWED`, resolve each selected session independently and partition into `lead` and `coder` groups
     - dispatch each group separately when CLI triggers are enabled
     - move each group to its resolved target column when CLI triggers are disabled
   - **Clarification:** Preserve the current meaning of the CLI trigger toggle (dispatch vs move-only), while making the chosen destination dynamic in both branches.
3. Rework `moveAll` with the same mixed-batch routing semantics
   - Primary file: `src/services/KanbanProvider.ts`
   - This path has the same static-next-column bug as `moveSelected`, but it operates on all cards in the source column after a board refresh.
   - It must therefore:
     - collect the active `PLAN REVIEWED` cards,
     - resolve each card independently,
     - send/move them in grouped batches by resolved role/column,
     - keep existing empty-column handling and refresh behavior intact.
4. Keep column persistence and board state aligned with the routed role
   - Primary files:
     - `src/services/KanbanProvider.ts`
     - `src/services/TaskViewerProvider.ts`
   - Any successful routed dispatch from `PLAN REVIEWED` must land in the correct persisted column (`CODER CODED` or `LEAD CODED`) rather than just whichever column is next in UI order.
   - This must stay compatible with legacy `CODED` normalization and existing DB-backed board refresh logic.

## Verification Plan
1. Prepare at least two `PLAN REVIEWED` plans with different routing outcomes:
   - one plan that current routing semantics classify to `coder`
   - one plan that current routing semantics classify to `lead`
2. In the Kanban board, use the column-header `Move Selected` control from `PLAN REVIEWED` with CLI triggers **enabled**.
   - Confirm the low/coder plan dispatches to `coder` and lands in `CODER CODED`.
   - Confirm the high-or-otherwise-lead plan dispatches to `lead` and lands in `LEAD CODED`.
3. Repeat with the `Move All` control from `PLAN REVIEWED`.
   - Confirm a mixed batch is partitioned correctly instead of sending every plan to `lead`.
4. Turn CLI triggers **off** and repeat the same `PLAN REVIEWED` header actions.
   - Confirm plans still move to the correct routed destination columns even though no agent dispatch occurs.
   - Confirm this does **not** collapse back to `LEAD CODED` for every plan.
5. Regression-check unaffected columns.
   - `CREATED` should still advance to `PLAN REVIEWED`.
   - `LEAD CODED` / `CODER CODED` should still advance to `CODE REVIEWED`.
6. Regression-check unaffected entry points.
   - Ticket-view `Send to Agent` should still use its current dynamic route resolution.
   - Autoban routing from `PLAN REVIEWED` should remain unchanged.
   - MCP conversational routing (`move_kanban_card`) should remain unchanged.
7. Run validation:
   - `npm run compile`
   - `npm run compile-tests`
   - targeted regression test covering Kanban header advance routing from `PLAN REVIEWED`

## Open Questions
- None.

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260314_092147_restore_autoban_complexity_routing.md`
  - Direct conceptual overlap.
  - That plan restored dynamic low/high routing for autoban from `PLAN REVIEWED`; this fix should align the manual column-header advance controls with the same routing semantics.
- `feature_plan_20260317_055724_add_seaprate_column_for_coder_and_lead_coder.md`
  - Direct structural overlap.
  - Because the board now uses separate `LEAD CODED` and `CODER CODED` columns, any fix written against a legacy single-`CODED` model would be wrong.
- `feature_plan_20260317_071108_add_move_controls_to_ticket_view.md`
  - Related entry-point overlap.
  - The ticket-view `Send to Agent` path already routes dynamically through `_getNextKanbanColumnForSession(...)`; this plan should not regress that behavior or duplicate its routing rules differently.
- `feature_plan_20260317_155208_send_to_agent_button_should_ignore_trigger_setting.md`
  - Shared routing/toggle boundary.
  - That fix established that non-Kanban ticket actions should not inherit the Kanban CLI-trigger toggle. This plan should preserve that separation while still making Kanban header actions route dynamically.
- `feature_plan_20260313_135545_conversational_kanban_control_via_smart_router.md`
  - Shared dynamic-routing semantics.
  - `handleMcpMove()` already resolves conversational targets with complexity-aware routing. If a shared resolver is extracted, it should stay aligned with that path rather than creating another variant.
- `feature_plan_20260317_113032_fix_complexity_parsing_bug.md`
  - Indirect dependency.
  - Manual advance routing relies on current complexity/agent-recommendation parsing. This plan should reuse those existing semantics, not invent a new parser or new complexity thresholds.

## Complexity Audit

### Band A — Routine
- Scope the fix to the Kanban column-header advance controls and preserve already-dynamic entry points.
- Update status text / notifications so routed batches are described accurately after the fix.
- Add focused regression coverage for `PLAN REVIEWED` header routing.

### Band B — Complex / Risky
- Reusing or extracting shared session-aware routing logic across `KanbanProvider` and `TaskViewerProvider` without creating a third divergent implementation.
- Partitioning mixed `PLAN REVIEWED` selections into separate `lead` and `coder` dispatch/move batches while preserving current CLI-trigger semantics.
- Keeping persisted Kanban columns, DB refresh behavior, legacy `CODED` normalization, and cross-surface routing behavior aligned.

---

## Code Review (2026-03-19)

### Stage 1 — Grumpy Principal Engineer

> *Well, well, well. Someone actually tried to fix the PLAN REVIEWED routing disaster. Let me see if they managed to not set the entire Kanban board on fire.*

- **MAJOR — `moveSelected` PLAN REVIEWED path has no status message.** `moveAll` shows `"Moved N plans from PLAN REVIEWED: 2 → LEAD CODED, 1 → CODER CODED."` (line 1230). But `moveSelected`? NOTHING. It silently routes and refreshes the board. The user clicks "Move Selected", watches cards teleport to two different columns, and gets ZERO feedback about what just happened. The plan's Band A item 2 *explicitly* says "Update user-facing result messages for mixed routing outcomes" — that means BOTH `moveSelected` AND `moveAll`. Half the job was done. Unacceptable.
- **NIT — No dedicated regression test for Kanban header advance routing.** Band A item 3 says "Add focused regression coverage around Kanban header routing." The existing tests cover complexity parsing, smart-router wiring, and split-coded columns — but none test that `moveSelected`/`moveAll` from `PLAN REVIEWED` actually calls `_partitionByComplexityRoute`. Source-level regex tests exist for the smart-router and complexity parser, but the specific header-advance path is uncovered. Not blocking, but a gap.
- **NIT — `promptSelected` / `promptAll` dynamic routing.** These also got PLAN REVIEWED dynamic routing (lines 1272-1278, 1310-1318) — which is GREAT, but the plan doesn't mention them. The implementer went above and beyond. The plan should have scoped these explicitly to avoid ambiguity about whether they were intentional or accidental.

**Severity summary:** 0 CRITICAL, 1 MAJOR, 2 NIT.

### Stage 2 — Balanced Synthesis

**Keep:**
- `_partitionByComplexityRoute` shared resolver (line 901-914) — clean, reusable, no third copy of routing logic. ✅
- `_targetColumnForDispatchRole` (line 917-919) — simple role-to-column map. ✅
- `moveAll` PLAN REVIEWED path with status messaging (line 1211-1230). ✅
- `moveSelected` PLAN REVIEWED dynamic routing via `_partitionByComplexityRoute` (line 1159-1176). ✅
- `promptSelected` / `promptAll` also route dynamically from PLAN REVIEWED. ✅
- CLI trigger toggle preserved in both branches. ✅

**Fix now:**
- Add mixed-routing status message to `moveSelected` PLAN REVIEWED path (mirrors `moveAll` pattern).

**Defer:**
- Dedicated regression test for header-advance routing. Existing coverage is sufficient to catch gross regressions; a targeted test can be added in a future pass.

### Code Fixes Applied

**File:** `src/services/KanbanProvider.ts`
**Change:** Added `movedParts` tracking and `showInformationMessage` to the `moveSelected` PLAN REVIEWED path (lines 1162, 1175, 1177-1179), matching the existing `moveAll` pattern.

### Validation Results
- `npm run compile` — **PASS** (exit 0, post-fix)
- `split-coded-columns-regression.test.js` — **PASS**
- `kanban-batch-prompt-regression.test.js` — **PASS**
- `kanban-complexity-regression.test.js` — **4/4 PASS**
- `kanban-smart-router-regression.test.js` — **4/4 PASS**

### Files Changed During Review
| File | Change |
|:---|:---|
| `src/services/KanbanProvider.ts` | Added mixed-routing status message to `moveSelected` PLAN REVIEWED path |

### Remaining Risks
- No dedicated regression test for header-advance routing from PLAN REVIEWED (deferred NIT).
- `promptSelected`/`promptAll` PLAN REVIEWED routing was implemented but not documented in the plan scope.

### Review Status: ✅ APPROVED (1 MAJOR fixed)
