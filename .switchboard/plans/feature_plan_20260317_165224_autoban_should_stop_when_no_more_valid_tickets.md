# Autoban should stop when no more valid tickets

## Goal
- If there are no more valid tickets in the kanban columsn targeted by autoban, the autoban mode should stop. 

## Source Analysis
- `src/services/TaskViewerProvider.ts:2076-2095`
  - `_startAutobanEngine()` creates one timer per enabled autoban rule and immediately enqueues a tick for each enabled source column.
- `src/services/TaskViewerProvider.ts:2110-2253`
  - `_autobanTickColumn(...)` currently exits early when a column has no cards, no eligible cards, or no selected cards after filtering, but those no-op exits do **not** disable autoban.
  - The engine therefore keeps running even when there is no remaining dispatchable work.
- `src/services/TaskViewerProvider.ts:2129-2130`
  - Eligibility already excludes sessions currently tracked in `_activeDispatchSessions`, so “valid tickets” cannot be defined as raw card count alone.
- `src/services/TaskViewerProvider.ts:2181-2230`
  - `PLAN REVIEWED` has extra eligibility rules: complexity must survive `complexityFilter`, and routing is derived from `routingMode`.
  - A correct no-work stop check must respect those existing filters rather than treating every plan in `PLAN REVIEWED` as dispatchable.
- `src/services/TaskViewerProvider.ts:1605-1613`
  - The only explicit stop path today is `_stopAutobanForExhaustion(...)`, which is used for session-cap or terminal-exhaustion conditions.
  - There is no stop path for “no more valid tickets remain.”

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260317_154731_autoban_bugs.md`
  - Direct overlap in `_autobanTickColumn(...)`.
  - If that reviewer-lane coordination plan lands, this no-work detector must still correctly decide whether any coded-column tickets remain eligible for reviewer dispatch.
- `feature_plan_20260315_084645_add_more_controls_to_autoban_config.md`
  - Direct overlap with `complexityFilter` and `routingMode`.
  - The no-work check must respect those controls so autoban stops when no tickets match the active filter, not merely when columns are visually empty.
- `feature_plan_20260314_092147_restore_autoban_complexity_routing.md`
  - Shared `PLAN REVIEWED` routing logic.
  - This plan must not duplicate a second, drifting definition of plan eligibility for routed batches.
- `feature_plan_20260317_054643_add_upper_limit_of_autoban_sends.md`
  - Shared stop conditions and autoban state transitions.
  - The new no-work stop reason must not regress the existing stop behavior for terminal/session exhaustion.
- `feature_plan_20260316_231438_autoban_needs_countdown_in_ui.md`
  - Shared user-visible autoban state.
  - When autoban stops because no valid tickets remain, the webview state should reflect that the engine is disabled rather than showing a stale active countdown.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Define “valid tickets” in terms of existing autoban eligibility rules
   - **File:** `src/services/TaskViewerProvider.ts`
   - **Relevant logic:** `2110-2253`
   - Document and implement the no-work check so it uses the same filters already applied by dispatch:
     - card is in an enabled source column,
     - card is not currently in `_activeDispatchSessions`,
     - `PLAN REVIEWED` cards satisfy the active `complexityFilter`.
   - **Clarification:** terminal exhaustion is a separate stop condition and should continue using the existing exhaustion path.
2. Add an explicit stop reason for “no more valid tickets remain”
   - **File:** `src/services/TaskViewerProvider.ts`
   - **Relevant logic:** `1605-1613`
   - Refactor the stop logic just enough to support a non-exhaustion stop message such as:
     - `Autoban stopped: no more valid tickets remain in enabled columns.`
   - Avoid reusing the exhaustion wording for this case because it would misdescribe the actual reason.
3. Check for global no-work after the last successful dispatch
   - **File:** `src/services/TaskViewerProvider.ts`
   - After a batch dispatch succeeds, re-evaluate whether any enabled source column still has eligible tickets.
   - If the just-dispatched batch drained the final remaining work, stop autoban immediately instead of leaving timers running until the next empty tick.

### Band B — Complex / Risky
1. Add a global enabled-column eligibility scan instead of a naive per-column empty check
   - **File:** `src/services/TaskViewerProvider.ts`
   - **Relevant logic:** `2076-2095`, `2110-2253`
   - Do **not** stop autoban just because the current tick’s column is empty. Other enabled columns may still have work.
   - Add a helper that evaluates all enabled autoban source columns and returns whether any still have dispatchable tickets under the current filters.
   - This helper should be reused from the no-op branches in `_autobanTickColumn(...)`, not reimplemented ad hoc in several places.
2. Cover the “filtered out” no-work cases, not just literally empty columns
   - A column may contain cards but still have zero valid work because:
     - every session is already in `_activeDispatchSessions`,
     - every `PLAN REVIEWED` card is excluded by `complexityFilter`,
     - the candidate batch resolves to zero eligible cards after applying the existing routing/filter rules.
   - The stop check must treat these states as “no more valid tickets” when they are true across **all** enabled columns.
3. Keep the scan aligned with existing routing behavior instead of inventing a second ruleset
   - Reuse or extract the current eligibility logic so dispatch and stop detection agree.
   - **Clarification:** this plan should not redesign routing; it should only detect when the current routing/filter configuration leaves no remaining valid work.

## Verification Plan
1. Enable autoban for multiple columns, leave one enabled column empty, and keep another enabled column populated.
   - Confirm autoban **does not** stop prematurely just because one column has no work.
2. Drain the final eligible tickets from all enabled columns.
   - Confirm autoban stops automatically and the UI reflects the disabled state.
3. Configure `PLAN REVIEWED` autoban with a restrictive filter (for example, `low_only`) and populate the column only with non-matching plans.
   - Confirm autoban stops because there are no valid tickets under the active filter, even though cards are present in the column.
4. Verify existing terminal/session-cap stop behavior still works and continues to show the correct exhaustion message.
5. Run targeted validation:
   - `npm run compile`
   - `npm run compile-tests`
   - existing autoban regression tests, especially `src/test/autoban-controls-regression.test.js` and `src/test/autoban-state-regression.test.js`
   - a focused regression test for the new no-work stop condition.

## Open Questions
- None.

## Complexity Audit

### Band A — Routine
- Add a clear non-exhaustion stop reason for “no more valid tickets.”
- Stop autoban immediately after the final successful dispatch if no eligible work remains.
- Add focused regression coverage for the no-work stop condition.

### Band B — Complex / Risky
- Introduce a global enabled-column eligibility scan so autoban stops only when **all** enabled columns are out of valid work.
- Ensure the scan exactly matches existing dispatch filters, especially `_activeDispatchSessions` handling and `PLAN REVIEWED` complexity filtering.
