# Autoban prompts are terrible

## Goal
Autoban prompts need to match the same prompts used in manual move actions. For example, the autoban reviewer prompt says:

' Review 1 plan, using one parallel sub-agent per plan if supported.
   Treat the listed plan file path as a completely isolated context.
   Execute each plan fully before moving on.
   If one plan hits an issue, report it clearly but continue when safe.
   Review each plan independently and report concrete findings per plan.
   Focus directive: the plan file path is the single source of truth; ignore directory mirroring, “brain” vs “source”,
   and path hashing.'

That is so confusing. What is the agent actually meant to do - review the plan or review the code? they're meant to review the code! This is fucking terrible, whatever agent wrote this is a moron.

## Source Analysis
- `src/services/TaskViewerProvider.ts`
  - `handleKanbanBatchTrigger()` falls back to `_handleTriggerAgentAction()` only when there is exactly one session **and** no `targetTerminalOverride`.
  - Autoban dispatches currently pass a terminal override for pooled routing, so even a single-card autoban send is forced through `_buildKanbanBatchPrompt(...)` instead of the normal single-card manual-action prompt path.
  - `_buildKanbanBatchPrompt('reviewer', ...)` currently says `Please review the following N plans` and `Review each plan independently`, which reads like plan review rather than code review.
  - `_handleTriggerAgentAction()` for `role === 'reviewer'` already uses the correct intent: `The implementation for this plan is complete. Execute a direct reviewer pass in-place.` It explicitly tells the reviewer to assess actual code changes against the plan requirements.
- `src/services/TaskViewerProvider.ts` copy-prompt logic
  - `_handleCopyPlanLink()` already uses reviewer-language consistent with the intended behavior for coded items: `Please review the code against the plan requirements and identify any defects`.
  - That means the confusing reviewer wording is localized to the autoban/batch prompt path, not the overall review UX.
- `src/test/kanban-batch-prompt-regression.test.js`
  - There is already a regression-test surface for Kanban batch behavior, but it currently checks column advancement wiring rather than prompt semantics.

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260315_085942_add_prompt_batching.md`
  - Direct overlap. It introduced/depends on the batch prompt path in `handleKanbanBatchTrigger()` and `_buildKanbanBatchPrompt()`.
  - Any parity fix here must preserve multi-plan batching behavior while correcting the reviewer semantics.
- `feature_plan_20260312_174651_improve_planner_prompts.md`
  - Related prompt-family overlap. That plan already tightened planner prompt instructions and threaded planner-specific intent through Kanban flows.
  - This plan should follow the same principle: make autoban/batch prompts semantically match the correct manual role behavior instead of inventing a weaker alternate phrasing.
- `feature_plan_20260314_092454_include_challenge_step_in_lead_review_coder_prompt.md`
  - Shared prompt-construction surface in `TaskViewerProvider.ts`.
  - Refactoring prompt builders must not break the opt-in inline challenge handling for lead/coder dispatches.
- `feature_plan_20260317_154731_autoban_bugs.md`
  - Related autoban dispatch-path overlap.
  - Both plans touch `TaskViewerProvider.ts` and the coded-to-review autoban flow, so reviewer prompt changes should be coordinated with any reviewer-lane dispatch fixes.
- `feature_plan_20260317_055724_add_seaprate_column_for_coder_and_lead_coder.md`
  - Indirect overlap. Reviewer autoban traffic now originates from both `LEAD CODED` and `CODER CODED`, which increases the visibility of bad reviewer prompt wording.
  - This plan should preserve the split-column model and only fix prompt parity.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Document and codify the reviewer prompt parity requirement
   - **File:** `src/services/TaskViewerProvider.ts`
   - Update the reviewer branch of `_buildKanbanBatchPrompt()` so the prompt clearly describes a **code review against the plan**, not a plan review.
   - The wording should preserve batch semantics (`for each plan`) while matching the manual reviewer action’s job-to-be-done.
   - **Clarification:** “match manual move actions” does **not** require identical byte-for-byte text when multiple plans are present; it requires the same role intent and expected outcome.
2. Preserve batch-safe wording for multi-plan reviewer sends
   - Keep the per-plan isolation language, but make it explicit that each listed plan corresponds to an implementation that must be reviewed against its plan requirements.
   - Avoid wording that suggests the agent should edit/improve the plan document itself.
3. Add targeted regression coverage for reviewer autoban prompt semantics
   - Extend existing batch-prompt regression coverage or add a focused prompt regression test.
   - Assert that reviewer batch/autoban prompts:
     - mention implementation/code review,
     - reference the plan as the source of truth for review criteria,
     - do **not** frame the task as “review the plan” in the plan-audit sense.

### Band B — Complex / Risky / High Complexity
1. Eliminate prompt drift between manual and autoban dispatch paths
   - **File:** `src/services/TaskViewerProvider.ts`
   - Refactor prompt construction so manual single-card dispatch and autoban/batch dispatch reuse shared role-specific prompt intent instead of maintaining separate, drifting reviewer language.
   - The safest direction is to share role-specific reviewer/coder/lead/planner instruction fragments, then wrap them in single-plan vs multi-plan framing only where necessary.
2. Handle the pooled-terminal override case without degrading prompt quality
   - Today, single-plan autoban sends with `targetTerminalOverride` cannot reuse `_handleTriggerAgentAction()` because pooled routing forces the batch path.
   - Fix the prompt logic so single-plan autoban sends with a terminal override still get reviewer semantics equivalent to manual moves.
   - **Clarification:** this can be implemented either by allowing the single-plan path to accept a terminal override or by making the batch path generate equivalent reviewer-executor language for one-plan cases.
3. Audit other role branches for parity regressions while staying in scope
   - Verify planner, coder, and lead batch prompt branches are not materially contradicting their single-plan manual-action intent.
   - Only adjust them where needed to preserve the stated goal of autoban/manual parity; do not introduce new prompt modes or workflow behavior.
4. Keep existing orchestration side effects unchanged
   - Prompt changes must not alter:
     - run-sheet workflow updates,
     - kanban column movement,
     - reviewer batch-summary behavior,
     - inline challenge opt-in behavior for lead/coder,
     - pooled terminal selection/rotation.

## Verification Plan
1. Trigger a manual single-card reviewer move from a coded column.
   - Capture the prompt payload and confirm it clearly instructs code review against the plan requirements.
2. Trigger an autoban reviewer send for a single coded card.
   - Confirm the resulting prompt is semantically equivalent to the manual reviewer prompt, even if sent through the pooled-terminal path.
3. Trigger an autoban reviewer send for multiple coded cards.
   - Confirm the prompt still uses batch-safe language (`for each plan`) while clearly directing the agent to review implementation/code, not review the plan text itself.
4. Verify planner autoban behavior from `CREATED` is unchanged in intent.
   - Confirm it still asks for plan improvement/enhancement rather than code review.
5. Verify coder/lead autoban behavior remains aligned with their manual execution semantics.
   - Confirm no regression to inline challenge handling or coder accuracy instructions.
6. Run prompt-focused regression checks plus repo validation:
   - `npm run compile`
   - `npm run compile-tests`
   - targeted prompt regression test(s) covering reviewer batch/autoban wording.

## Open Questions
- None.

## Complexity Audit

### Band A — Routine
- Update the reviewer batch/autoban prompt wording so it explicitly describes code review against the plan.
- Preserve per-plan isolation language while removing plan-review ambiguity.
- Add/extend prompt regression tests to lock reviewer prompt semantics.

### Band B — Complex / Risky
- Refactor prompt construction so manual and autoban dispatches share role-specific intent instead of drifting across separate code paths.
- Handle the single-plan autoban + terminal-override case without breaking pooled terminal routing.
- Audit planner/coder/lead batch branches for parity issues while avoiding unintended workflow or orchestration changes.
