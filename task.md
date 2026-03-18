# Task Tracking

## Kanban micro-fixes execution (feature_plan_20260318_134331, feature_plan_20260318_135346, feature_plan_20260318_140355)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the three source plan files.
- [x] Read impacted implementation surfaces (`src/webview/kanban.html`) and related regression coverage (`src/test/kanban-view-plan-removal-regression.test.js`).
- [x] Run baseline verification (`npm run compile`, `npm run lint`) and capture status.
- [x] Implement the Add Plan button centering fix in `src/webview/kanban.html`.
- [x] Verify the Add Plan button fix (`npm run compile`) and read back changed lines.
- [x] Implement the Jules button visibility fix in `src/webview/kanban.html`.
- [x] Verify the Jules button fix (`npm run compile`) and read back changed lines.
- [x] Implement the Review Plan icon swap in `src/webview/kanban.html`.
- [x] Verify the Review Plan icon swap (`npm run compile`) and read back changed lines.
- [x] Perform red-team self-review with concrete failure modes and line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Remove the `line-height: 1` declaration from `.btn-add-plan` and verify the file still builds.
2. Add the render-time Jules visibility guard and implement the live DOM visibility sync function, then verify the file still builds.
3. Replace the review button SVG with the requested pencil/edit icon and verify the file still builds.
4. Read back the modified ranges after each group, then perform a hostile self-review against all touched lines.
5. Run final project verification and inspect the final diff for scope control.

### Dependency Map

- Step 2 depends on Step 1 preserving the surrounding Kanban header markup.
- Step 3 depends on Step 2 keeping the card action structure intact.
- Step 4 depends on all implementation groups completing.
- Step 5 depends on Step 4 closing any issues found during self-review.

### Risks

- A render-time Jules guard could accidentally hide the button by default if it treats `undefined` as disabled.
- Live visibility toggling could target the wrong buttons if the selector is broader than the Jules action button.
- The icon swap could unintentionally alter button sizing/alignment if the replacement SVG changes dimensions or stroke behavior.

### Verification Plan

- `npm run compile`
- `npm run lint` (expected to fail due to the repository's existing ESLint v9 flat-config migration gap)
- `node src/test/kanban-view-plan-removal-regression.test.js`
- Read back the modified `src/webview/kanban.html` ranges
- Review the scoped `git --no-pager diff`

### Verification Record

- Baseline `npm run compile`: PASS.
- Baseline `npm run lint`: FAIL (pre-existing ESLint v9 config issue: `eslint.config.*` missing).
- Post-change `npm run compile` after Add Plan button fix: PASS.
- Post-change `npm run compile` after Jules button visibility fix: PASS.
- Post-change `npm run compile` after Review Plan icon swap: PASS.
- Final `npm run compile-tests`: PASS.
- Final `npm run compile`: PASS.
- Final `node src/test/kanban-view-plan-removal-regression.test.js`: PASS.
- Final `npm run lint`: FAIL (same pre-existing ESLint v9 config issue: `eslint.config.*` missing).
- Final diff review: scoped to `src/webview/kanban.html` plus this `task.md` execution block.

### Red Team Findings

- `src/webview/kanban.html:172-188` — Failure mode: if a later refactor reintroduces a fixed line box on `.btn-add-plan`, the plus glyph can drift off optical center again; mitigation: the rule now relies on flex centering without a conflicting `line-height`.
- `src/webview/kanban.html:850-853` — Failure mode: a malformed `visibleAgents` payload could set `jules` to a non-boolean value; mitigation: the guard only hides on explicit `false`, preserving the existing default-visible behavior.
- `src/webview/kanban.html:996-999` — Failure mode: a `visibleAgents` update can arrive before or after column re-renders; mitigation: both the render-time guard and the DOM toggle are now present, so either timing still produces the right button state.
- `src/webview/kanban.html:1119-1120` — Failure mode: swapping the icon path could unintentionally change button sizing or theme contrast; mitigation: the replacement SVG keeps the original width, height, `viewBox`, stroke width, and `currentColor` usage.
- `task.md:3-15` — Failure mode: checklist drift if additional edits happen after this run without updating the boxes; mitigation: every completed gate in this execution block is now recorded immediately after verification.
- `task.md:46-57` — Failure mode: verification evidence can become stale if commands are re-run later and the record is not refreshed; mitigation: this section captures the exact command outcomes for this execution snapshot.
- `task.md:59-67` — Failure mode: line references in red-team notes can age as files evolve; mitigation: the references are explicitly tied to this completed run and should be regenerated on future edits.

## MCP polling removal execution (feature_plan_20260312_053351_remove_mcp_server_polling)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the source plan file.
- [x] Read impacted implementation surfaces (`src/extension.ts`) and related tests/interfaces.
- [x] Run baseline verification (`npm run compile`, `npm run lint`) and capture status.
- [x] Apply plan changes plus inline challenge corrections in `src/extension.ts`.
- [x] Verify implementation gate (`npm run compile`) and read back modified code.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Verification Record (MCP polling removal)

- Baseline `npm run compile`: PASS.
- Baseline `npm run lint`: FAIL (pre-existing ESLint v9 config migration issue: missing `eslint.config.*`).
- Post-change `npm run compile`: PASS.
- Final `npm run compile`: PASS.
- Final `npm run lint`: FAIL (same pre-existing ESLint config issue, unchanged by this task).
- Scoped diff review: only `src/extension.ts` logic and this `task.md` tracking section.

### Red Team Findings (MCP polling removal)

- `src/extension.ts:2712-2715` — Failure mode: non-standard packaging path could miss `mcp-server.js` and show false negative; mitigation: check both `dist` and `src` extension layouts.
- `src/extension.ts:2728-2732` — Failure mode: MCP config read exceptions were previously silent; mitigation: explicit output-channel logging plus `Unable to read IDE MCP config` diagnostic.
- `src/extension.ts:2740-2742` — Failure mode: prior diagnostic implied runtime tool health; mitigation: wording changed to static signal (`MCP server file detected`) to avoid false observability claims.
- `task.md:3-11` — Failure mode: checklist drift if execution order changes; mitigation: checklist now reflects completed gates in-order for this plan run.
- `task.md:13-19` — Failure mode: verification evidence can become stale after additional edits; mitigation: this run records baseline/post/final command outcomes explicitly.
- `task.md:21-27` — Failure mode: line references can age as file evolves; mitigation: references are snapshot-scoped to this execution block and not reused across tasks.

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the source plan file.
- [x] Read all impacted sources and dependencies (`src/extension.ts`, `src/webview/implementation.html`, `src/services/TaskViewerProvider.ts`, related Jules tests).
- [x] Run baseline verification (`npm run compile`, `npm run lint`) and capture current status.
- [x] Implement UI/default behavior updates required by the plan (validated existing Jules setup toggle wiring in `implementation.html`).
- [x] Implement terminal creation gating in `createAgentGrid` based on visible agent settings.
- [x] Verify implementation group with compile/lint and readback.
- [x] Perform red-team self-review with concrete failure modes and line numbers.
- [x] Run final verification and diff review.

### Detailed Plan

1. Confirm current setup visibility controls in `implementation.html` and ensure Jules toggle behavior is explicit and synchronized with `lastVisibleAgents`.
2. Update `createAgentGrid` in `extension.ts` to read `await taskViewerProvider.getVisibleAgents()` and only include `Jules Monitor` when `visibleAgents.jules !== false`.
3. Run verification gate commands after implementation (`npm run compile` then `npm run lint`) and capture output.
4. Read back modified sections in both files to verify exact logic.
5. Perform red-team review on modified files and document failure modes.
6. Run final compile/lint and review git diff consistency.

### Dependency Map

- Step 2 depends on Step 1 confirming current visibility wiring in webview and provider.
- Step 3 depends on Step 2 completing both coordinated changes.
- Step 4 depends on Step 3 results.
- Step 5 depends on Step 4 readback.

### Dependencies

- `TaskViewerProvider.getVisibleAgents()` is the source of persisted visibility state from `.switchboard/state.json`.
- `renderAgentList()` already honors `lastVisibleAgents.jules` for sidebar card visibility.
- `createAgentGrid()` currently hardcodes terminal list and must align with visibility state to prevent unwanted Jules Monitor startup.

### Risks

- If `getVisibleAgents()` fails or returns defaults unexpectedly, Jules Monitor may still appear due to default `true`.
- Filtering the agents list changes cleanup behavior in `clearGridBlockers`; stale Jules terminals may persist unless explicitly handled.
- UI toggles can desynchronize if startup visibility and onboarding visibility controls are updated inconsistently.

### Verification Plan

- `npm run compile`
- `npm run lint` (expected existing config failure unless repo-level lint config changes)
- Read back modified ranges in `src/extension.ts` and `src/webview/implementation.html`
- Review git diff for only intended files and logic

### Verification Record

- Baseline `npm run compile`: PASS.
- Baseline `npm run lint`: FAIL (ESLint v9 config missing: `eslint.config.*` not present).
- Post-change `npm run compile`: PASS.
- Post-change `npm run lint`: FAIL (same pre-existing ESLint v9 config issue).
- Final `npm run compile`: PASS.
- Final `npm run lint`: FAIL (same pre-existing ESLint v9 config issue).
- Final diff review: scoped logic change confirmed in `src/extension.ts`; no `implementation.html` functional changes required because Jules setup toggle wiring already exists.
- Readback confirmed `createAgentGrid` now gates Jules terminal inclusion via `visibleAgents.jules` and disposes hidden Jules Monitor terminals (`src/extension.ts:1453-1501`).
- Readback confirmed setup still exposes Jules visibility toggle and defaults are sourced from `lastVisibleAgents` (`src/webview/implementation.html:1354`, `src/webview/implementation.html:1754`).

### Red Team Findings

- `src/extension.ts:1453-1454`: If `.switchboard/state.json` cannot be read, `getVisibleAgents()` falls back to defaults and may re-enable Jules unexpectedly.
- `src/extension.ts:1493-1499`: Name-based matching for `Jules Monitor` could dispose a user terminal with a colliding name prefix.
- `src/extension.ts:1493-1500`: Disposing the terminal does not explicitly verify child process shutdown beyond terminal lifecycle; external detached subprocesses could survive.
- `task.md:8-10`: Checklist state is manually maintained and can become inaccurate if commands are re-run but status lines are not updated in lockstep.
- `task.md:47-55`: Verification records can become stale if new command runs occur after edits and the log is not appended.
- `task.md:57-64`: Red-team findings are point-in-time; future refactors can invalidate line references without obvious signal.

## Kanban controls strip execution (feature_plan_20260316_065159_add_main_controls_strip_at_top_of_kanban_board)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the source plan file.
- [x] Read impacted implementation surfaces (`src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, related types/tests).
- [x] Run baseline verification (`npm run compile`, `npm run lint`) and capture status.
- [x] Perform inline adversarial review and apply corrections before coding.
- [x] Implement controls strip UI wiring in `src/webview/kanban.html`.
- [x] Implement backend handlers/prompts/auto-advance logic in `src/services/KanbanProvider.ts`.
- [x] Verify implementation gate (`npm run compile`) and read back modified files.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Verification Record (Kanban controls strip)

- Baseline `npm run compile`: FAIL (pre-existing TypeScript syntax errors in `src/services/KanbanDatabase.ts`, e.g. around lines 175/187/197/202).
- Baseline `npm run lint`: NOT RUN (compile failed first in chained baseline command).
- Post-change `npm run compile` (first pass): FAIL (pre-existing `src/services/KanbanDatabase.ts` parse/syntax errors in workspace state during that run).
- Final `npm run compile`: PASS.
- Final `npm run lint`: FAIL (pre-existing ESLint v9 config migration issue: missing `eslint.config.*`).
- `npm test`: FAIL at pretest lint step (same pre-existing ESLint config issue); compile/tests setup otherwise reaches `compile-tests` and webpack compile.
- Diff/readback review completed for: `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/extension.ts`.

### Red Team Findings (Kanban controls strip)

- `src/webview/kanban.html:455-465` — Failure mode: controls strip can wrap on narrow width and push action order around; mitigation: keep actions id-based and avoid positional assumptions in listeners.
- `src/webview/kanban.html:657-666` — Failure mode: Jules button visibility can stale if no `visibleAgents` message arrives yet; mitigation: initialize with hidden default + call `updateJulesButtonVisibility()` at startup.
- `src/webview/kanban.html:989-1004` — Failure mode: rapid multi-click on batch buttons can issue duplicate backend actions; mitigation: backend re-validates current column before advancing sessions.

- `src/services/KanbanProvider.ts:374-439` — Failure mode: stale UI snapshots could move cards already changed by other flows; mitigation: `_advanceSessionsInColumn` re-derives current column from runsheet before writing workflow event.
- `src/services/KanbanProvider.ts:781-816` — Failure mode: batch prompt buttons could claim advancement despite partial eligibility; mitigation: status messages now report actual advanced count after guarded checks.
- `src/services/KanbanProvider.ts:819-826` — Failure mode: Jules dispatch could run while Jules is disabled; mitigation: explicit `visibleAgents.jules` guard and warning before dispatch.

- `src/services/TaskViewerProvider.ts:1007-1022` — Failure mode: UI toggle desync if autoban state persisted but engine not restarted/stopped; mitigation: method updates workspace state and applies the same start/stop semantics as sidebar updates.
- `src/services/TaskViewerProvider.ts:1012-1019` — Failure mode: enabling while already enabled could keep stale timer config; mitigation: restarts engine when enabled to rehydrate active timers/rules.
- `src/services/TaskViewerProvider.ts:1021` — Failure mode: kanban indicator lag after toggle; mitigation: `_postAutobanState()` rebroadcasts to both sidebar and kanban views.

- `src/extension.ts:829-832` — Failure mode: missing command registration would make AUTOBAN button no-op; mitigation: explicit command registration routes to `TaskViewerProvider.setAutobanEnabledFromKanban`.
- `src/extension.ts:829-832` — Failure mode: non-boolean payload from webview could produce inconsistent state; mitigation: command coerces with `!!enabled`.
- `src/extension.ts:829-832` — Failure mode: un-awaited state transition could race with subsequent UI refresh; mitigation: registration awaits provider method.

- `task.md:96-136` — Failure mode: checklist drift if another edit happens after verification; mitigation: this block records exact command outcomes and touched files for this run only.
- `task.md:112-117` — Failure mode: lint/test failures could be misattributed to this feature; mitigation: records unchanged pre-existing ESLint config blocker explicitly.
- `task.md:120-136` — Failure mode: line references may age as files move; mitigation: references are scoped to this execution snapshot and should be refreshed on future edits.

## Batch summary after automated review execution (feature_plan_20260313_071421_add_a_summarise_all_plans_command_at_end_of_automated_review_session)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, the source plan file, and current `task.md`.
- [x] Read impacted implementation surfaces and dependencies (`src/services/PipelineOrchestrator.ts`, `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/extension.ts`, existing regression test).
- [x] Run baseline verification (`npm run compile`) and capture status.
- [x] Implement pipeline final-batch detection and dispatch signature updates.
- [x] Implement current automated-kanban equivalent final-review detection in the autoban engine and reviewer double-dispatch logic.
- [x] Update regression coverage / task tracking, then run verification gate (`npm run compile`) and read back modified code.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Update `PipelineOrchestrator.ts` so the dispatch callback accepts `isFinalInBatch?: boolean` and `_advance()` passes `pending.length === 1` for the last automated pipeline item.
2. Update the pipeline callback wiring in `TaskViewerProvider.ts` and the extension command bridge in `src/extension.ts` so single-plan kanban dispatches can carry the same flag without breaking existing call sites.
3. Adapt the plan’s outdated `KanbanProvider` auto-move step to the current codebase’s autoban engine in `TaskViewerProvider.ts`: detect when the reviewer dispatch drains the current column queue and pass the final-batch signal into the shared dispatch core.
4. Extend `TaskViewerProvider` reviewer dispatch logic to send a second paced reviewer message only after the primary final-plan dispatch succeeds.
5. Update regression coverage to assert the new callback/signature/final-batch flow, then verify with `npm run compile` and readback.

### Dependency Map

- Step 2 depends on Step 1 because the callback/command signatures must agree first.
- Step 3 depends on Step 4’s target dispatch API shape being settled, otherwise autoban would fork a separate path.
- Step 5 depends on Steps 1-4 being complete so verification reflects the actual final behavior.

### Inline Challenge Corrections

- The plan references `KanbanProvider._autoMoveOneCard`, but the current automated kanban path is the autoban engine in `TaskViewerProvider.ts`. Correction: implement the final-batch reviewer summary at the autoban dispatch point used today.
- `columnCards.length === 1` is fragile if the dispatch happens from a filtered/subset view. Correction: compute final-batch state from the exact pending reviewer dispatch set at dispatch time, after filtering out ineligible/in-flight sessions.
- The reviewer summary prompt must never send if the main reviewer dispatch fails. Correction: gate the second `_dispatchExecuteMessage` behind a successful first dispatch and preserve existing dedupe/error semantics.

### Risks

- A new optional dispatch flag can silently drift across `PipelineOrchestrator`, `TaskViewerProvider`, and the extension command bridge if signatures are not updated together.
- The reviewer double-dispatch could bypass pacing or clash with the dedupe lock if inserted in the wrong layer.
- Autoban batch dispatch currently uses a multi-plan prompt path; the final-summary behavior must attach only when the reviewer queue is actually drained, not on every reviewer send.

### Verification Results

- Baseline verification: `npm run compile` passed before implementation.
- Post-change verification: `npm run compile && node src\test\pipeline-orchestrator-regression.test.js` passed (`7 passed, 0 failed`).
- Final verification: reran `npm run compile && node src\test\pipeline-orchestrator-regression.test.js` and reviewed `git --no-pager diff --stat -- src/services/PipelineOrchestrator.ts src/services/TaskViewerProvider.ts src/extension.ts src/test/pipeline-orchestrator-regression.test.js task.md`.
- Modified files reviewed back after compile: `src/services/PipelineOrchestrator.ts`, `src/services/TaskViewerProvider.ts`, `src/extension.ts`, `src/test/pipeline-orchestrator-regression.test.js`.

### Red Team Findings

- `src/services/PipelineOrchestrator.ts:17` — Failure mode: callback signature drift could compile in one layer but silently drop the final-batch signal downstream; mitigation: the shared `DispatchCallback` type now carries `isFinalInBatch?: boolean`, forcing the orchestrator wiring to stay aligned.
- `src/services/PipelineOrchestrator.ts:190-214` — Failure mode: the queue could send a summary for an already-drained pipeline or for a non-final plan; mitigation: the `pending.length === 0` branch exits before dispatch, and the dispatch call passes `pending.length === 1` only for the final remaining plan.
- `src/services/PipelineOrchestrator.ts:199-214` — Failure mode: oldest-first ordering could be broken while adding the final-batch flag; mitigation: the existing `pending.sort(...)` remains intact and the new flag is computed from queue size, not from a reordered index mutation.

- `src/services/TaskViewerProvider.ts:889-981` — Failure mode: autoban reviewer batches could send the summary before the real batched review prompt or on failed dispatch; mitigation: `handleKanbanBatchTrigger(...)` sends the primary batch prompt first and only queues the summary after that `await` resolves.
- `src/services/TaskViewerProvider.ts:1425-1488` — Failure mode: a stale `columnCards.length === 1` style check would misfire when some cards are already in flight or filtered out; mitigation: the code now computes `eligibleCards` first and marks `isFinalInBatch` only when the selected batch drains that exact reviewer-eligible set.
- `src/services/TaskViewerProvider.ts:5527-5564` — Failure mode: the standalone summary could trigger workflows again or lose pacing in direct terminal mode; mitigation: the helper sends with sender `system`, sets reviewer `phase_gate` metadata with `bypass_workflow_triggers: 'true'`, and surfaces a warning if the follow-up queueing fails.
- `src/services/TaskViewerProvider.ts:6028-6035` — Failure mode: single-plan final reviewer dispatches from the pipeline could skip the summary path while autoban batches use it; mitigation: the single-plan dispatch path now calls the same `_dispatchReviewerBatchSummary(...)` helper before advancing runsheets/kanban state.

- `src/extension.ts:825-831` — Failure mode: command-bridge drift could leave the new boolean stuck in the extension layer and never reach the provider; mitigation: both single-plan and batch kanban command registrations now accept `isFinalInBatch?: boolean` and forward it to `TaskViewerProvider`.
- `src/extension.ts:825-831` — Failure mode: existing callers could break if the new flag changed argument order; mitigation: the boolean was appended as an optional trailing parameter, preserving the existing `(role, session, instruction, workspaceRoot)` call shape.
- `src/extension.ts:825-831` — Failure mode: undefined or omitted flags from older callers could be treated inconsistently; mitigation: the bridge normalizes the value with `Boolean(isFinalInBatch)` so old call sites continue to behave as non-final dispatches.

- `src/test/pipeline-orchestrator-regression.test.js:74-100` — Failure mode: future refactors could remove the final-batch callback plumb-through without obvious runtime symptoms; mitigation: the regression suite now asserts the provider callback forwards `isFinalInBatch` into `_handleTriggerAgentActionInternal(...)`.
- `src/test/pipeline-orchestrator-regression.test.js:82-87` — Failure mode: the orchestrator could stop tagging the last pending plan while still compiling; mitigation: a dedicated regex assertion now guards the `pending.length === 1` dispatch contract.
- `src/test/pipeline-orchestrator-regression.test.js:90-100` — Failure mode: reviewer summary metadata or helper usage could be dropped during later edits; mitigation: the regression suite now asserts both the helper call on final reviewer dispatch and the `batchCompletionSummary: true` metadata marker.

## Conversational kanban control via smart router (feature_plan_20260313_135545_conversational_kanban_control_via_smart_router)

## Review comment transport reliability execution (feature_plan_20260317_160347_review_functionality_in_tickets_is_not_reliable)

## Send to agent button should ignore trigger setting (feature_plan_20260317_155208_send_to_agent_button_should_ignore_trigger_setting)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, the source plan file, current `task.md`, and session `plan.md`.
- [x] Read impacted implementation surfaces and dependencies (`src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/ReviewProvider.ts`, `src/webview/review.html`, `src/extension.ts`, related tests).
- [x] Run baseline verification (`npm run compile`, `npm run compile-tests`) and capture current status.
- [x] Remove Kanban CLI trigger gating from the ticket-view send path in `src/services/TaskViewerProvider.ts`.
- [x] Add focused regression coverage proving ticket-view send ignores the Kanban CLI trigger toggle.
- [x] Verify the implementation group (`npm run compile`, `npm run compile-tests`, targeted regression test) and read back modified files.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Run baseline compile and test-compilation before editing so any failures are clearly separated from this bug fix.
2. Update `sendReviewTicketToNextAgent()` in `src/services/TaskViewerProvider.ts` to always use the standard next-agent dispatch path and remove the `_kanbanProvider?.cliTriggersEnabled` early exit.
3. Add a focused regression test that inspects `TaskViewerProvider.ts` and asserts the ticket-view send method no longer branches on `_kanbanProvider?.cliTriggersEnabled`, while preserving the `handleKanbanTrigger(...)` dispatch call.
4. Run the verification gate commands, then read back the changed ranges to confirm the behavior matches the plan exactly.
5. Red-team the modified files for scope leaks, fallback-move regressions, and brittle test risks before final verification.

### Dependency Map

- Baseline verification must complete before implementation so unchanged failures are attributable.
- The regression test depends on the final `sendReviewTicketToNextAgent()` implementation.
- Final verification depends on both the code fix and the regression coverage.

### Risks

- Removing the ticket-view gate must not alter the existing fallback move-only behavior when no target role exists.
- A source-level regression test can become brittle if it relies on exact formatting rather than behavior-shaping strings.
- Kanban drag/drop gating must remain intact in `src/services/KanbanProvider.ts` even after the ticket-view exemption.

### Verification Record

- Baseline `npm run compile`: PASS.
- Baseline `npm run compile-tests`: PASS.
- Verification gate `npm run compile`: PASS.
- Verification gate `npm run compile-tests`: PASS.
- Verification gate `node src\test\review-send-agent-trigger-regression.test.js`: PASS (`review send-agent trigger regression test passed`).
- Final `npm run compile`: PASS.
- Final `npm run compile-tests`: PASS.
- Final `node src\test\review-send-agent-trigger-regression.test.js`: PASS (`review send-agent trigger regression test passed`).
- Final scoped diff/status review: confirmed current task surfaces remain limited to `src/services/TaskViewerProvider.ts`, `src/test/review-send-agent-trigger-regression.test.js`, `src/services/KanbanProvider.ts`, and `task.md` for this plan's behavior.
- Readback confirmed `src/services/TaskViewerProvider.ts:1147-1166` has no `cliTriggersEnabled` branch in `sendReviewTicketToNextAgent()` and still preserves final-column, no-role fallback, and normal dispatch behavior.
- Readback confirmed `src/services/KanbanProvider.ts:968-1000` still gates Kanban `triggerAction` and `triggerBatchAction` on `_cliTriggersEnabled`.
- Readback confirmed `src/test/review-send-agent-trigger-regression.test.js:23-50` covers the dedicated ticket-view button path, the absence of the trigger toggle branch, and the continued Kanban-only gating.

## Max batch size should be 1, 2, 3, 4, 5 (feature_plan_20260317_194328_max_batch_size_should_be_1_2_3_4_5)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, the source plan file, current `task.md`, and session `plan.md`.
- [x] Read impacted implementation surfaces and dependencies (`src/services/autobanState.ts`, `src/webview/implementation.html`, `src/services/TaskViewerProvider.ts`, `src/test/autoban-controls-regression.test.js`, `src/test/autoban-state-regression.test.js`).
- [x] Run baseline verification (`npm run compile-tests`, `npm run compile`) and capture current status.
- [x] Tighten autoban batch-size normalization to the explicit supported range `1..5` in `src/services/autobanState.ts`.
- [x] Update the sidebar `MAX BATCH SIZE` selector in `src/webview/implementation.html` to offer `1, 2, 3, 4, 5`.
- [x] Refresh focused regression coverage for autoban controls/state batch-size support.
- [x] Verify the implementation group (`npm run compile-tests`, `npm run compile`, targeted autoban regressions) and read back modified files.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Run baseline `compile-tests` and `compile` first so any existing failures are separated from this batch-size change.
2. Update `src/services/autobanState.ts` to define and enforce the supported autoban batch-size contract `1..5` with a default of `3`.
3. Update `src/webview/implementation.html` so the batch-size selector exposes `1, 2, 3, 4, 5` and keeps the existing `emitAutobanState()` behavior unchanged.
4. Refresh `src/test/autoban-controls-regression.test.js` and `src/test/autoban-state-regression.test.js` to prove the UI offers all five values, `2` and `4` survive normalization, and out-of-range values are clamped back into contract.
5. Run the verification gate commands, then read back the changed ranges to confirm the implementation matches the plan exactly.
6. Red-team the modified files for persisted-state drift, brittle selector assertions, and unintended autoban runtime side effects before final verification.

### Dependency Map

- Baseline verification must complete before implementation so unchanged failures are attributable.
- Regression updates depend on the final normalization and selector implementation.
- Final verification depends on both the implementation and the refreshed regressions.

### Risks

- Batch-size normalization could accidentally continue accepting values above `5`, leaving the UI and stored-state contract inconsistent.
- The webview selector could still mis-render persisted `2` or `4` if the option list and selected state drift apart.
- Regression tests could become too formatting-sensitive if they assert exact HTML instead of the intended supported values.

### Verification Record

- Baseline `npm run compile-tests`: FAIL at first pass with unrelated `TaskViewerProvider.ts` `_refreshConfiguredPlanWatcher` reference errors already present in the dirty workspace.
- Baseline `npm run compile`: FAIL at first pass with the same unrelated `TaskViewerProvider.ts` `_refreshConfiguredPlanWatcher` reference errors.
- Verification gate `npm run compile-tests`: PASS.
- Verification gate `npm run compile`: PASS.
- Verification gate `node src\test\autoban-controls-regression.test.js`: PASS (`autoban controls regression test passed`).
- Verification gate `node src\test\autoban-state-regression.test.js`: PASS (`autoban state regression test passed`).
- Final `npm run compile-tests`: PASS.
- Final `npm run compile`: PASS.
- Final `node src\test\autoban-controls-regression.test.js`: PASS (`autoban controls regression test passed`).
- Final `node src\test\autoban-state-regression.test.js`: PASS (`autoban state regression test passed`).
- Final scoped diff/status review: confirmed the batch-size contract work is isolated to `src/services/autobanState.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/implementation.html`, `src/test/autoban-controls-regression.test.js`, `src/test/autoban-state-regression.test.js`, and `task.md`.
- Readback confirmed `src/services/autobanState.ts:11-12` defines the explicit supported batch-size contract and `src/services/autobanState.ts:51-57,181` funnels normalization through `normalizeAutobanBatchSize(...)`.
- Readback confirmed `src/webview/implementation.html:2928-2939` now renders batch-size options `1, 2, 3, 4, 5` while preserving the existing `emitAutobanState()` flow.
- Readback confirmed `src/services/TaskViewerProvider.ts:2504` reuses the shared `normalizeAutobanBatchSize(...)` helper instead of a local numeric fallback.
- Readback confirmed `src/test/autoban-controls-regression.test.js:50-53` and `src/test/autoban-state-regression.test.js:68-71,113-123,193-195` cover the widened selector values, valid `2`/`4`, oversized-value clamping, and provider alignment.

### Red Team Findings

- `src/services/autobanState.ts:11-12` — Failure mode: the supported batch-size contract could drift again if future UI work adds values without updating shared state expectations. Mitigation: the explicit exported constants centralize the `1..5` contract beside the autoban config type.
- `src/services/autobanState.ts:51-57` — Failure mode: out-of-band persisted values like `6` or `9` could silently survive and create UI/state mismatch. Mitigation: `normalizeAutobanBatchSize(...)` now clamps everything into the supported range before state is reused.
- `src/services/autobanState.ts:181` — Failure mode: one state-construction path could bypass the new helper and keep accepting arbitrary integers. Mitigation: `normalizeAutobanConfigState(...)` now routes the stored `batchSize` through the shared helper in the main normalization return path.

- `src/webview/implementation.html:2928-2937` — Failure mode: persisted `2` or `4` values would appear invalid if the selector omitted those options. Mitigation: the selector now renders all supported values `1..5`, so persisted valid values remain selectable and visible.
- `src/webview/implementation.html:2930-2931` — Failure mode: the UI’s allowed values could diverge from the plan again if the dropdown were edited ad hoc. Mitigation: the options are now declared in one local constant instead of spread across conditionals.
- `src/webview/implementation.html:2938-2948` — Failure mode: changing the selector could break existing warning recalculation or state emission. Mitigation: the existing change handler and `emitAutobanState()` flow remain intact; only the supported value set changed.

- `src/services/TaskViewerProvider.ts:2504` — Failure mode: manual low-complexity batch dispatch could bypass state normalization and keep accepting arbitrary values above `5`. Mitigation: the local numeric fallback now reuses `normalizeAutobanBatchSize(...)`.
- `src/services/TaskViewerProvider.ts:2504` — Failure mode: invalid `0`/`NaN` batch sizes from stale workspace state could collapse dispatch to zero or one unpredictably. Mitigation: the shared helper preserves the default fallback of `3`.
- `src/services/TaskViewerProvider.ts:2504` — Failure mode: provider-specific fallback rules could diverge from the autoban engine’s normalized state over time. Mitigation: both the provider and the config-normalization path now depend on the same helper.

- `src/test/autoban-controls-regression.test.js:50-53` — Failure mode: a future refactor could quietly drop `2` or `4` from the selector without touching runtime logic. Mitigation: the regression now fails unless all five supported values appear in the source.
- `src/test/autoban-controls-regression.test.js:50-53` — Failure mode: the selector could be refactored away from the expected naming and make the test too brittle. Mitigation: the regex checks the supported-value contract and loop shape rather than an exact DOM fragment.
- `src/test/autoban-controls-regression.test.js:35-53` — Failure mode: control-surface tests could miss wider autoban regressions and give false confidence. Mitigation: this file continues to assert the broader autoban control defaults alongside the new batch-size selector contract.

- `src/test/autoban-state-regression.test.js:68-71` — Failure mode: normalization could regress and start rejecting valid `2` or `4` values again. Mitigation: direct assertions now lock those values in.
- `src/test/autoban-state-regression.test.js:113-123` — Failure mode: oversized persisted values could keep leaking through because only valid examples were tested. Mitigation: the new `batchSize: 8` case proves clamping back to `5`.
- `src/test/autoban-state-regression.test.js:193-195` — Failure mode: provider/runtime drift could reintroduce a local batch-size fallback even if state normalization stays correct. Mitigation: the regression now asserts the provider uses `normalizeAutobanBatchSize(...)` directly.

- `task.md:253-308` — Failure mode: checklist state can drift if later edits land without rerunning the gates. Mitigation: this section records exact command outcomes and readback evidence for this execution pass.
- `task.md:286-297` — Failure mode: the transient initial baseline failure could be confused with this feature change. Mitigation: the verification record separates the first-pass baseline blocker from the later passing verification gate.
- `task.md:299-321` — Failure mode: line references may age as the files continue to move. Mitigation: these findings are snapshot-scoped to the current workspace state and should be refreshed on future edits.

### Red Team Findings

- `src/services/TaskViewerProvider.ts:1154-1157` — Failure mode: if `_roleForKanbanColumn(targetColumn)` returns no role for a valid next column, the ticket falls back to a move-only transition. Mitigation: that fallback remains explicit and scoped to the no-role case only, rather than to the Kanban CLI trigger toggle.
- `src/services/TaskViewerProvider.ts:1160-1163` — Failure mode: dispatch failures could silently advance the ticket if the code moved the column before checking `dispatched`. Mitigation: the current path returns `Failed to send plan...` and avoids the silent move for role-backed dispatches.
- `src/services/TaskViewerProvider.ts:1149-1152` — Failure mode: a final-column ticket could accidentally re-dispatch if next-column resolution regressed. Mitigation: the early `!targetColumn` guard still hard-stops with `Plan is already in the final column.` before any send logic runs.

- `src/test/review-send-agent-trigger-regression.test.js:16-21` — Failure mode: the source-slice boundary depends on neighboring method names, so major refactors could break the test lookup even if behavior stays correct. Mitigation: the assertions fail loudly when the method boundary can no longer be located.
- `src/test/review-send-agent-trigger-regression.test.js:41-44` — Failure mode: the regression guard is string-based and could miss a semantic reintroduction of toggle gating under different wording. Mitigation: it checks both the implementation token (`cliTriggersEnabled`) and the old fallback message to cover the known regressions from two angles.
- `src/test/review-send-agent-trigger-regression.test.js:46-50` — Failure mode: the Kanban gating assertion is broad and could pass if `_cliTriggersEnabled` appears in unrelated code. Mitigation: it also asserts the presence of both `triggerAction` and `triggerBatchAction`, keeping the scope tied to the intended handlers.

- `task.md:207-244` — Failure mode: checklist state can drift if more edits happen after verification. Mitigation: this section records concrete command outcomes and readback evidence, not just completion claims.
- `task.md:238-246` — Failure mode: verification logs can become stale if later changes land without rerunning commands. Mitigation: the record distinguishes baseline and verification-gate runs explicitly for this execution pass.
- `task.md:248-259` — Failure mode: line references can age as the files continue to move. Mitigation: the findings are snapshot-scoped to the current workspace state and should be refreshed on future edits.

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the source plan file.
- [x] Read impacted implementation surfaces and dependencies (`src/extension.ts`, `src/services/terminalUtils.ts`, `src/services/ReviewProvider.ts`, `src/webview/review.html`, related send-path tests).
- [x] Run baseline verification (`npm run compile`, `npm run compile-tests`) and capture current status.
- [x] Replace the duplicated review-comment terminal send path in `src/extension.ts` with the shared `src/services/terminalUtils.ts` helper.
- [x] Add focused regression coverage preventing review-comment transport drift.
- [x] Verify implementation gate (`npm run compile`, `npm run compile-tests`, targeted regression test) and read back modified files.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Confirm baseline repository status for compile and test compilation before edits so any failures are clearly attributable.
2. Import the shared `sendRobustText` helper into `src/extension.ts`, remove the local duplicate helper, and keep the existing review-comment payload/terminal resolution logic unchanged.
3. Add a focused source-level regression test that asserts `switchboard.sendReviewComment` delegates to the shared helper and that `extension.ts` no longer defines its own `sendRobustText`.
4. Run the verification gate commands, then read back the changed ranges to confirm the wiring is exactly as intended.
5. Red-team the modified files for transport regressions, helper drift, and review-command edge cases before final verification.

### Dependency Map

- Baseline verification must happen before implementation so pre-existing failures are separated from this plan's changes.
- The regression test depends on the final helper wiring in `src/extension.ts`.
- Final verification depends on both the implementation and regression coverage being complete.

### Risks

- Removing the local helper could break MCP `sendToTerminal` delivery if the shared helper is not imported and reused consistently.
- A source-level regression test can become too brittle if it overfits whitespace or unrelated refactors.
- Review comments rely on target-terminal resolution from `state.json`; transport changes must not alter role selection or payload formatting.

### Verification Record

- Baseline `npm run compile`: PASS.
- Baseline `npm run compile-tests`: PASS.
- Baseline `npm run lint`: FAIL (pre-existing ESLint v9 config migration issue: missing `eslint.config.*`).
- Implementation gate `npm run compile`: PASS.
- Implementation gate `npm run compile-tests`: PASS.
- Implementation gate `node src\test\review-comment-transport-regression.test.js`: PASS (`3 passed, 0 failed`).
- Final `npm run compile`: PASS.
- Final `npm run compile-tests`: PASS.
- Final `node src\test\review-comment-transport-regression.test.js`: PASS (`3 passed, 0 failed`).
- Final `npm run lint`: FAIL (same pre-existing ESLint v9 config migration issue, unchanged by this task).
- Readback completed for `src/extension.ts`, `src/test/review-comment-transport-regression.test.js`, and the shared send callsite in `src/extension.ts` MCP bridging.
- Scoped diff/status review confirmed the intended file set: `src/extension.ts`, `src/test/review-comment-transport-regression.test.js`, and `task.md`.

### Red Team Findings

- `src/extension.ts:11` — Failure mode: if the shared helper import drifts or is renamed, both review comments and MCP terminal delivery lose the aligned send path. Mitigation: the new regression test asserts the shared import exists and the local helper is gone.
- `src/extension.ts:435` — Failure mode: removing the local helper changes MCP `sendToTerminal` to the shared helper too, so any future divergence in `terminalUtils.ts` now affects both paths. Mitigation: this alignment is intentional, and readback confirmed both callsites now share the same helper entrypoint.
- `src/extension.ts:1486` — Failure mode: review comments could silently regress to bespoke terminal submission logic while still keeping the same payload shape. Mitigation: the command now delegates directly to `sendRobustText(selectedTerminal, payload, true)` and the regression suite guards that exact call.

- `src/test/review-comment-transport-regression.test.js:29-41` — Failure mode: command-body extraction could break if the command callback is radically restructured. Mitigation: the extractor anchors on the command id first, then searches for the async handler near that command instead of scanning the whole file blindly.
- `src/test/review-comment-transport-regression.test.js:90-99` — Failure mode: a later refactor could preserve the shared import but stop using it in the review command. Mitigation: the test separately asserts the awaited `sendRobustText(selectedTerminal, payload, true)` call inside the command body.
- `src/test/review-comment-transport-regression.test.js:111-125` — Failure mode: the shared helper could lose the repeated-submit CLI behavior and reintroduce the “text left in input box” bug for agent terminals. Mitigation: the test asserts the shared helper still contains the CLI detection and repeated submit calls.

- `task.md:238-245` — Failure mode: checklist state can drift if verification is rerun without updating the record. Mitigation: this block now marks all completed gates only after the final command evidence was captured.
- `task.md:267-278` — Failure mode: future readers could misattribute the lint failure to this transport fix. Mitigation: the verification record explicitly labels the ESLint config failure as pre-existing and unchanged.
- `task.md:280-289` — Failure mode: line references can age as the codebase moves. Mitigation: the red-team findings are scoped to this execution snapshot and cite the exact files touched in this run.

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, the source plan file, current `task.md`, and session `plan.md`.
- [x] Read impacted implementation surfaces and dependencies (`src/mcp-server/register-tools.js`, `src/extension.ts`, `src/services/KanbanProvider.ts`, `src/services/agentConfig.ts`, `AGENTS.md`, `src/test/workflow-contract-consistency.test.js`).
- [x] Run baseline verification and capture status.
- [x] Implement the MCP tool, extension IPC bridge, and KanbanProvider smart-router logic.
- [x] Update agent protocol documentation to advertise the new conversational routing tool.
- [x] Verify the implementation group and read back modified files.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Add a `move_kanban_card` MCP tool in `src/mcp-server/register-tools.js` that validates its inputs, emits a `triggerKanbanMove` IPC message, and returns a queueing receipt rather than falsely implying the route already succeeded.
2. Extend `src/extension.ts` to handle the new `triggerKanbanMove` IPC message and register a `switchboard.mcpMoveKanbanCard` command that delegates to `KanbanProvider`.
3. Implement `KanbanProvider.handleMcpMove(sessionId, target, workspaceRoot?)` plus private normalization helpers that resolve conversational target strings against built-in columns, built-in roles, and current custom kanban agents.
4. Preserve the plan’s smart-router intent while correcting for current architecture: apply complexity routing only for generic conversational targets like `coded` / `team`, while explicit roles or explicit custom-agent targets bypass complexity overrides.
5. Update `AGENTS.md` to document the new conversational tool in the global architecture/protocol guidance, then verify with compile plus the workflow-contract regression test.

### Dependency Map

- Step 2 depends on Step 1 because the extension can only route a tool once the MCP server emits a matching IPC message.
- Step 3 depends on Step 2 because the smart router needs a stable command entrypoint.
- Step 4 depends on Step 3 because the normalization and complexity-routing rules must share the same backend helper.
- Step 5 depends on Steps 1-4 so verification matches the real shipped flow.

### Inline Challenge Corrections

- The appendix’s immediate-success wording can mislead agents when host-side routing later fails. Correction: return a queueing receipt (`queued for routing`) from the MCP tool, keep hard errors for missing IPC, and surface extension routing failures to the human via VS Code notifications/logging.
- The sample normalization logic is too brittle for the current board because it ignores custom kanban agents and the live column model. Correction: normalize against `buildKanbanColumns(customAgents)` and explicit role aliases instead of only hardcoded strings.
- A blanket `coded -> complexity route` override would stomp explicit destinations like custom agents or an explicitly requested `lead`. Correction: restrict complexity routing to generic conversational targets (`coded`, `team`, similar aliases) and preserve explicit role/custom-agent targets as requested.

### Risks

- The new tool introduces an MCP-to-extension IPC path; mismatched message types or command registration drift would fail silently unless both ends are updated together.
- Fuzzy target normalization can accidentally map conversational input to the wrong role if aliases are too permissive.
- Session/workspace resolution must stay scoped to the correct workspace; otherwise routing could fail or target the wrong board in multi-root setups.

### Verification Results

- Baseline `npm run compile`: PASS.
- Baseline `node src\test\workflow-contract-consistency.test.js`: FAIL on pre-existing `challenge` workflow parity assertions (`markdown max phase 5 vs runtime steps 44`, unchanged baseline blocker outside this task).
- Post-change `npm run compile`: PASS.
- Post-change `node src\test\kanban-smart-router-regression.test.js`: PASS (`4 passed, 0 failed`).
- Final verification command: `npm run compile; node src\test\kanban-smart-router-regression.test.js; node src\test\workflow-contract-consistency.test.js`.
- Final exit summary: `compile=0`, `smart-router=0`, `workflow-contract=1`.
- Final `node src\test\workflow-contract-consistency.test.js`: FAIL on the same pre-existing `challenge` workflow parity assertions as baseline (unchanged by this task).
- Readback completed for `src/mcp-server/register-tools.js`, `src/extension.ts`, `src/services/KanbanProvider.ts`, `src/test/kanban-smart-router-regression.test.js`, and `AGENTS.md`.
- Scoped diff review completed for `src/mcp-server/register-tools.js`, `src/extension.ts`, `src/services/KanbanProvider.ts`, `src/test/kanban-smart-router-regression.test.js`, `AGENTS.md`, and this `task.md`.

### Red Team Findings

- `src/mcp-server/register-tools.js:2110-2145` — Failure mode: the MCP tool could falsely imply the move already succeeded even though host-side routing is asynchronous. Mitigation: the response now explicitly says the plan was *queued for routing* and preserves a hard error when IPC is unavailable.
- `src/mcp-server/register-tools.js:2121-2128` — Failure mode: empty `sessionId` or `target` inputs could generate meaningless IPC messages. Mitigation: the tool rejects blank values before emitting `triggerKanbanMove`.
- `src/mcp-server/register-tools.js:2131-2135` — Failure mode: multi-root or rehosted MCP sessions could lose workspace context during IPC. Mitigation: the message includes `workspaceRoot: getWorkspaceRoot()` so the extension can route against the correct board.

- `src/extension.ts:527-538` — Failure mode: malformed IPC payloads from the MCP child process could hit command execution with undefined inputs. Mitigation: the bridge now validates `sessionId` and `target` and logs malformed messages instead of dispatching them.
- `src/extension.ts:527-538` — Failure mode: a smart-router request could be routed against the wrong workspace in multi-root setups. Mitigation: the IPC case forwards the message’s `workspaceRoot` and falls back to the current MCP workspace root only when absent.
- `src/extension.ts:889-892` — Failure mode: the new VS Code command could drift from the provider signature during later refactors. Mitigation: `switchboard.mcpMoveKanbanCard` is a thin pass-through to `kanbanProvider.handleMcpMove(...)`, and the regression test asserts that registration shape directly.

- `src/services/KanbanProvider.ts:782-850` — Failure mode: conversational inputs like `to the planner agent` or `planner column` could fail strict alias matching. Mitigation: `_normalizeMcpTarget(...)` strips leading `to` / `the` and trailing `column|lane|stage|queue|agent|role|terminal` suffixes before alias resolution.
- `src/services/KanbanProvider.ts:810-846` — Failure mode: explicit custom-agent destinations could route to hidden or non-kanban agents and strand cards in invisible columns. Mitigation: custom-agent aliases are registered only for `includeInKanban` agents, matching the live board model.
- `src/services/KanbanProvider.ts:852-885` — Failure mode: generic conversational `coded` / `team` targets could bypass the plan’s complexity-routing requirement. Mitigation: `_resolveComplexityRoutedRole(...)` reads the plan complexity and resolves `Low -> coder`, otherwise `lead`.
- `src/services/KanbanProvider.ts:908-940` — Failure mode: routing failures could disappear silently after target normalization. Mitigation: `handleMcpMove(...)` now hard-fails on missing session, unsupported targets, invisible/unassigned roles, and downstream dispatch failure with explicit VS Code error messages.

- `src/test/kanban-smart-router-regression.test.js:41-97` — Failure mode: future edits could remove the tool, IPC bridge, or smart-router normalization without any obvious runtime signal until an agent tries the feature. Mitigation: the new regression file asserts all three seams plus the AGENTS.md protocol note.
- `src/test/kanban-smart-router-regression.test.js:67-87` — Failure mode: tests could become brittle to helper ordering rather than behavior. Mitigation: the regexes assert the presence of normalization, complexity-routing, and dispatch behavior instead of exact contiguous formatting.
- `src/test/kanban-smart-router-regression.test.js:90-97` — Failure mode: documentation drift could cause agents to keep defaulting to `send_message`. Mitigation: the regression suite asserts the AGENTS.md guidance string for `move_kanban_card`.

- `AGENTS.md:69-74` — Failure mode: agents may continue using raw `send_message` out of habit and bypass the kanban router. Mitigation: the protocol section now explicitly prefers `move_kanban_card(sessionId, target)` for conversational progression and explains the accepted target shapes.

## Add upper limit of autoban sends (feature_plan_20260317_054643_add_upper_limit_of_autoban_sends)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, the source plan file, current `task.md`, and session `plan.md`.
- [x] Read impacted implementation surfaces and dependencies (`src/services/autobanState.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/implementation.html`, `src/services/KanbanProvider.ts`, `src/extension.ts`, terminal registry paths, and existing autoban regression coverage).
- [x] Run baseline verification and capture status.
- [x] Perform inline adversarial review and apply corrections before coding.
- [x] Implement autoban state extensions, terminal override dispatch plumbing, and send-limit / pool lifecycle helpers.
- [x] Implement autoban pool management UI plus provider message handlers and reset behavior.
- [x] Verify the implementation group and read back modified files.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Extend `src/services/autobanState.ts` so the persisted/broadcast autoban shape can carry per-terminal quotas, send counters, per-role pools, round-robin cursors, and a global session cap without breaking existing state hydration.
2. Update `src/services/TaskViewerProvider.ts` to normalize legacy autoban state, track per-session send counts, select an eligible terminal per role, trim each batch to the selected terminal's remaining capacity, and auto-stop when every enabled column is out of quota or the global safety cap is reached.
3. Add an optional terminal-name override to the kanban batch dispatch path so autoban can target a specific pooled terminal while preserving the existing role-based behavior for all other callers.
4. Reuse the provider's existing terminal lifecycle ownership to add backup-terminal creation/reset handlers, register those terminals into the shared Switchboard registry, and avoid auto-clearing anything unless the user explicitly presses reset.
5. Expand `src/webview/implementation.html` so the Autoban tab exposes the max-sends control, per-role pool rows with counts/status, add/remove controls up to 5 terminals per role, and a clear/reset action that also resets the running engine state.
6. Propagate the richer autoban state through `KanbanProvider` and the existing autoban regression test, then verify with compile plus focused autoban regression coverage.

### Dependency Map

- Step 2 depends on Step 1 because the provider, kanban relay, and webview all share the same autoban state contract.
- Step 3 depends on Step 2 because the pooled-terminal selector needs a stable dispatch seam before send accounting is meaningful.
- Step 4 depends on Step 3 because backup terminals must be created in the same registry shape that the selector dispatches against.
- Step 5 depends on Steps 1-4 so the UI reflects the real backend state and lifecycle operations.
- Step 6 depends on Steps 1-5 so the verification covers the shipped state model, routing seam, and UI messaging together.

### Inline Challenge Corrections

- The plan contradicts itself by calling the send cap a hardcoded floor of `10` while also requiring a numeric input with `min 1` and a verification case using `3`. Correction: implement `10` as the default/fallback, not a hard minimum, so the UI and verification flow can use smaller per-session caps.
- The proposed `sendCounts += batchSize` logic can overrun quota when `batchSize` exceeds a terminal's remaining sends. Correction: cap each autoban dispatch to the selected terminal's remaining capacity before dispatch, then increment the counter by the actual dispatched plan count.
- `handleKanbanBatchTrigger(...)` currently routes only by role, so pooled round-robin dispatch has no way to target a specific backup terminal. Correction: add an optional terminal-name override that autoban can supply while keeping the existing role-only call shape intact for everyone else.
- The plan itself flags the missing runaway safeguard. Correction: add a global autoban session cap (`200` by default) so the engine cannot keep burning through pooled terminals indefinitely even if every per-terminal quota is still positive.

### Risks

- The provider now needs to reconcile persisted autoban state across older workspace snapshots; missing-field hydration bugs could leave the engine enabled with malformed counters or empty pools.
- Creating backup terminals from the sidebar touches the same registry and heartbeat flows used by the main agent grid; naming collisions or incorrect cleanup could dispose the wrong terminal.
- Targeting specific terminals in batch dispatch changes a mature dispatch seam; any signature drift between provider callers and implementation could silently route the batch to the wrong agent.
- Pool exhaustion must stop the engine cleanly without leaving stale timers or stale countdown state behind in the sidebar and kanban views.

### Verification Results

- Baseline `npm run compile`: PASS.
- Post-backend `npm run compile`: PASS.
- Post-UI `npm run compile`: PASS.
- Final `npm run compile && node src\test\autoban-state-regression.test.js`: PASS.
- Readback completed for `src/services/autobanState.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/implementation.html`, `src/extension.ts`, and `src/test/autoban-state-regression.test.js`.
- Scoped diff review completed for `src/services/autobanState.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/implementation.html`, `src/extension.ts`, `src/test/autoban-state-regression.test.js`, and this `task.md`.

### Red Team Findings

- `src/services/autobanState.ts:35-44` — Failure mode: malformed persisted numeric values could silently resurrect bad quotas or cursor state after reload. Mitigation: `normalizeFiniteCount(...)` now rejects non-finite and below-minimum values and restores safe defaults instead of trusting raw workspace state.
- `src/services/autobanState.ts:57-74` — Failure mode: duplicate/blank terminal names in stored pools could over-count capacity or create phantom pool entries. Mitigation: `normalizeStringArrayRecord(...)` trims, dedupes, and caps each role pool at five entries.
- `src/services/autobanState.ts:94-123` — Failure mode: older workspaces without the new autoban fields could crash the provider/webview or lose relay shape. Mitigation: `normalizeAutobanConfigState(...)` supplies defaults for all new fields (`maxSendsPerTerminal`, `globalSessionCap`, counters, pools, and cursors) while preserving the existing rule defaults.

- `src/services/TaskViewerProvider.ts:922-950` — Failure mode: a pooled autoban send targeting one specific backup terminal could accidentally fall through to the old single-plan role path and lose the override. Mitigation: `handleKanbanBatchTrigger(...)` only uses the single-plan shortcut when no `targetTerminalOverride` is present.
- `src/services/TaskViewerProvider.ts:1341-1458` — Failure mode: explicit user-managed pools could silently fall back to arbitrary same-role terminals when configured pool members went offline. Mitigation: `_resolveAutobanEffectivePool(...)` now honors explicit pools strictly and only falls back to all live same-role terminals when no stored pool exists.
- `src/services/TaskViewerProvider.ts:1461-1481` — Failure mode: `batchSize > remaining sends` could over-consume quota and mis-rotate the next terminal. Mitigation: `_recordAutobanDispatch(...)` records only the actual dispatched plan count, and `_selectAutobanTerminal(...)` exposes the true remaining capacity per terminal.
- `src/services/TaskViewerProvider.ts:1587-1679` — Failure mode: backup-terminal creation could exceed the intended five-terminal cap when some configured pool members were offline. Mitigation: `_createAutobanTerminal(...)` now counts the stored pool size when present, not just the currently alive subset, before allowing another backup to be created.
- `src/services/TaskViewerProvider.ts:1700-1718` — Failure mode: reset/removal paths could leave stale pool references or counters behind and keep autoban routing to dead names. Mitigation: `_resetAutobanPools()` and `_removeAutobanTerminalReferences(...)` clear stored pool membership, managed backup membership, and send counters together before rebroadcasting state.
- `src/services/TaskViewerProvider.ts:1757-1770` — Failure mode: innocuous config changes while autoban is already enabled could accidentally reset a live send-count session. Mitigation: `setAutobanEnabledFromKanban(...)` only resets counters on a true disabled->enabled session start; rule restarts keep current counters intact.
- `src/services/TaskViewerProvider.ts:2016-2148` — Failure mode: autoban could keep dispatching forever across a large pool or overrun a terminal quota mid-batch. Mitigation: `_autobanTickColumn(...)` now enforces the hidden global session cap, trims each dispatch to the selected terminal's remaining capacity, and auto-stops once every enabled autoban role is exhausted.
- `src/services/TaskViewerProvider.ts:2511-2558` — Failure mode: webview-triggered pool actions could mutate live autoban counters accidentally or leave the engine running with stale timers. Mitigation: the new message handlers keep config updates, max-send updates, add/remove terminal actions, and clear/reset behavior on separate backend paths with explicit persistence and rebroadcast.
- `src/services/TaskViewerProvider.ts:5979-6012` — Failure mode: closing a managed backup terminal outside the autoban UI could strand stale pool entries and make the remaining pool count lie. Mitigation: `handleTerminalClosed(...)` now removes closed terminal references from stored autoban pools/counters as part of terminal cleanup.

- `src/webview/implementation.html:1949-1966` — Failure mode: sidebar startup before the first backend sync could render missing-field errors or undefined send-count badges. Mitigation: the local `autobanState` bootstrap now includes defaults for all new counter/pool fields.
- `src/webview/implementation.html:2326-2329` — Failure mode: inbound autoban syncs could partially update the UI and leave stale runtime counters or pools on screen. Mitigation: the webview still merges the full backend autoban payload and immediately rerenders the sidebar after every `autobanStateSync`.
- `src/webview/implementation.html:2899-3335` — Failure mode: posting the full autoban state back to the extension on every toggle change would overwrite live counters/pools with stale UI copies. Mitigation: `emitAutobanState()` now sends only the editable config subset, while `updateAutobanMaxSends`, `addAutobanTerminal`, `removeAutobanTerminal`, and `resetAutobanPools` use dedicated messages.
- `src/webview/implementation.html:2932-2952` — Failure mode: the pool list could misrepresent explicit pools versus ad-hoc same-role terminals and confuse the operator. Mitigation: `getRolePoolEntries(...)` shows the configured pool when one exists, otherwise it falls back to the live same-role terminals, matching the backend routing contract.
- `src/webview/implementation.html:3184-3335` — Failure mode: operators could destroy backup terminals accidentally with no review step. Mitigation: managed backups expose explicit remove buttons, and the destructive `CLEAR & RESET` path now requires a confirmation prompt.

- `src/extension.ts:844-845` — Failure mode: the new terminal override could get lost in the extension bridge even though the provider supports it. Mitigation: `switchboard.triggerBatchAgentFromKanban` now forwards the trailing `targetTerminalOverride?: string` argument directly to `TaskViewerProvider.handleKanbanBatchTrigger(...)`.
- `src/extension.ts:844-845` — Failure mode: existing callers could break if the new override changed the established argument order. Mitigation: the terminal override was appended as a trailing optional parameter, preserving the existing `(role, sessionIds, instruction, workspaceRoot, isFinalInBatch)` call shape.
- `src/extension.ts:844-845` — Failure mode: the final-batch boolean and terminal override could be conflated by later edits. Mitigation: the bridge still normalizes the boolean separately with `Boolean(isFinalInBatch)` and forwards the terminal override as a distinct final argument.

- `src/test/autoban-state-regression.test.js:12-49` — Failure mode: future edits could drop the new quota/pool fields from the broadcast state while still compiling. Mitigation: the regression now asserts preservation of per-terminal caps, global session cap, session send counts, pool membership, managed backups, and pool cursor state.
- `src/test/autoban-state-regression.test.js:51-95` — Failure mode: legacy workspaces or malformed persisted pool config could regress restore behavior without any UI smoke test catching it. Mitigation: the regression now locks defaulting/clamping behavior for legacy state, invalid caps, send counts, deduped pool entries, and pool cursor normalization.
- `src/test/autoban-state-regression.test.js:97-118` — Failure mode: a later refactor could remove the pooled-autoban provider hooks or sidebar controls without touching the shared state codec. Mitigation: the regression also inspects the provider and webview sources for the new selection helper, pool-management messages, terminal-override seam, and visible sidebar controls.

- `task.md:274-324` — Failure mode: checklist drift could hide an incomplete accuracy phase if the execution order changes later. Mitigation: this section records the completed gates in the same order the work was actually performed.
- `task.md:317-324` — Failure mode: verification notes can go stale if future commands are run and not recorded. Mitigation: the section captures baseline, post-backend, post-UI, and final verification outcomes separately for this task run.
- `task.md:326-357` — Failure mode: line references in red-team notes age as files continue to move. Mitigation: these findings are snapshot-scoped to this execution and should be refreshed on any later edit pass.

## Fix complexity parsing bug (feature_plan_20260317_113032_fix_complexity_parsing_bug)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, the source plan file, current `task.md`, and session `plan.md`.
- [x] Read impacted implementation surfaces and dependencies (`src/services/KanbanProvider.ts`, `src/mcp-server/register-tools.js`, `src/services/TaskViewerProvider.ts`, and `src/test/kanban-complexity.test.ts`).
- [x] Run baseline verification and capture status.
- [x] Perform inline adversarial review and apply corrections before coding.
- [x] Implement aligned complexity parser fixes in the kanban provider and MCP registry.
- [x] Extend focused regression coverage, verify the implementation group, and read back modified code.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Update `src/services/KanbanProvider.ts` so `getComplexityFromPlan(...)` ignores label-only Band B heading text such as `(Complex/Risky)` and `— Complex / Risky`, and only treats substantive Band B items as High complexity.
2. Mirror the same normalization in `src/mcp-server/register-tools.js` so `get_kanban_state` and the kanban UI do not drift.
3. Extend `src/test/kanban-complexity.test.ts` with the exact failing markdown shape from the source plan plus a true High-complexity Band B case.
4. Verify with `npm run compile` and focused complexity regression coverage, then read back the changed code before red-team review.

### Dependency Map

- Step 2 depends on Step 1 because the MCP parser must stay aligned with the canonical kanban parser behavior.
- Step 3 depends on Steps 1-2 so the regression cases lock the final shared behavior instead of a partially fixed parser.
- Step 4 depends on Steps 1-3 so compile/test evidence reflects the shipped parser logic end-to-end.

### Inline Challenge Corrections

- The current parser assumes any non-empty text after `Band B` is meaningful, which wrongly counts same-line labels like `(Complex/Risky)` as real work. Correction: ignore label-only Band B heading text before checking for `None` or substantive bullets.
- `src/mcp-server/register-tools.js` duplicates the same complexity parsing logic. Correction: patch both implementations in the same change so the UI, routing, and `get_kanban_state` stay consistent.
- The existing focused test already covers a failing `### Band B (Complex/Risky)` + `- None.` case but has not been part of routine verification. Correction: rerun that regression and add an explicit High case so the parser boundary is locked from both sides.

### Risks

- Over-normalizing Band B text could accidentally discard genuine complex bullets if the matcher is too broad.
- Fixing only the TypeScript parser would leave MCP complexity reporting stale and make the system disagree about the same plan.
- Broad regex edits in parser code can silently change fallback behavior for plans that do not contain a `Complexity Audit` section.

### Verification Results

- Baseline `npm run compile`: PASS.
- Implementation verification `npm run compile-tests && npm run compile && node src\test\kanban-complexity-regression.test.js`: PASS.
- Final verification `npm run compile-tests && npm run compile && node src\test\kanban-complexity-regression.test.js`: PASS.
- Final diff review: `git --no-pager diff --stat -- src/services/KanbanProvider.ts src/mcp-server/register-tools.js src/test/kanban-complexity.test.ts src/test/kanban-complexity-regression.test.js task.md` reviewed after verification. Note: the new standalone regression file is untracked, so Git's tracked-file diff stat only reported the tracked file subset.
- Readback completed for `src/services/KanbanProvider.ts`, `src/mcp-server/register-tools.js`, `src/test/kanban-complexity.test.ts`, and `src/test/kanban-complexity-regression.test.js`.

### Red Team Findings

- `src/services/KanbanProvider.ts:59-60` — Failure mode: the type contract with `TaskViewerProvider` could drift again and break `compile-tests`. Mitigation: restored an explicit `getCodedColumnTarget()` method that returns the live legacy default `'lead'` instead of depending on removed state.
- `src/services/KanbanProvider.ts:748-757` — Failure mode: parenthesized Band B labels such as `(Complex/Risky)` could still be misread as substantive work. Mitigation: `normalizeBandBLine()` now unwraps parenthesized heading labels and strips heading punctuation before classification.
- `src/services/KanbanProvider.ts:760-776` — Failure mode: label-only lines or embedded recommendation markers inside Band B could still force false High complexity. Mitigation: the final `meaningful` filter now excludes empty markers, pure Band B labels, and `Recommendation` prefixes before deciding `Low` vs `High`.

- `src/mcp-server/register-tools.js:637-657` — Failure mode: MCP `get_kanban_state` could disagree with the UI on the same `(Complex/Risky) + None` plan shape. Mitigation: the MCP parser now mirrors the same normalization, label stripping, and empty-marker checks as `KanbanProvider`.
- `src/mcp-server/register-tools.js:663-668` — Failure mode: recommendation-only plans without a formal `Complexity Audit` could remain `unknown` in MCP while the UI/runtime classify them. Mitigation: `getComplexityFromContent()` now matches lead/coder recommendation text before falling back to `unknown`.
- `src/mcp-server/register-tools.js:674-685` — Failure mode: Band B extraction could absorb later headings or recommendation sections and produce false High ratings. Mitigation: the section-boundary regex now stops at headings, later band markers, recommendation labels, and horizontal rules before normalization.

- `src/test/kanban-complexity.test.ts:9-43` — Failure mode: the exact user-reported `(Complex/Risky)` + `- None.` case could regress if only generic low-complexity fixtures were covered. Mitigation: the low-case test keeps the precise failing markdown shape in the future VS Code test harness.
- `src/test/kanban-complexity.test.ts:45-79` — Failure mode: over-correcting the parser could accidentally downgrade real Band B work to `Low`. Mitigation: the added high-case test locks substantive Band B bullets to `High`.
- `src/test/kanban-complexity.test.ts:12-18` and `48-54` — Failure mode: test scaffolding could become coupled to a broader fake VS Code context and hide environment-specific failures. Mitigation: both tests keep the context stub minimal (`workspaceState.get` only), reducing incidental behavior assumptions.

- `src/test/kanban-complexity-regression.test.js:10-13` — Failure mode: the MCP parser could become harder to verify directly and drift silently. Mitigation: `getComplexityFromContent` is now exported and exercised directly by the standalone regression.
- `src/test/kanban-complexity-regression.test.js:79-90` — Failure mode: future edits could break recommendation-only fallback alignment without touching Band B parsing. Mitigation: the standalone regression now locks both coder and lead recommendation-only classifications.
- `src/test/kanban-complexity-regression.test.js:92-100` — Failure mode: a Node-only regression cannot instantiate the VS Code-backed provider runtime, so source-only assertions could miss behavioral drift there. Mitigation: this lightweight regression is paired with the stronger provider-facing Mocha suite in `src/test/kanban-complexity.test.ts`.

- `task.md:360-430` — Failure mode: checklist drift could make an accuracy phase look complete when verification or review has not actually happened. Mitigation: this section now records the complexity-fix task in the exact order it was executed, from context gathering through final diff review.
- `task.md:396-404` — Failure mode: verification evidence can become stale after additional edits. Mitigation: the command sequence that passed is captured explicitly, including `compile-tests`, `compile`, and the standalone regression.
- `task.md:406-430` — Failure mode: line references in the hostile review will age as files continue to move. Mitigation: these findings are snapshot-scoped to this execution and should be refreshed on any later edit pass.

## Autoban prompt parity execution (feature_plan_20260317_160207_autoban_prompts_are_terrible)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, the source plan file, and current `task.md`.
- [x] Read impacted implementation surfaces and dependencies (`src/services/TaskViewerProvider.ts`, `src/test/kanban-batch-prompt-regression.test.js`, `src/test/challenge-prompt-regression.test.js`, reviewer prompt regression coverage).
- [x] Run baseline verification (`npm run compile-tests`, `npm run compile`, `npm run lint`) and capture status.
- [x] Refactor reviewer autoban/batch prompt wording so it matches manual reviewer intent for single-plan and multi-plan sends.
- [x] Audit planner/coder/lead autoban prompt branches for manual-parity regressions and adjust only if needed.
- [x] Add focused regression coverage for reviewer autoban prompt semantics and any shared prompt helper introduced.
- [x] Verify implementation gate (`npm run compile`, targeted prompt tests) and read back changed code.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Inspect the existing autoban batch prompt builder and the manual single-plan reviewer payload to identify the smallest shared prompt-intent seam.
2. Refactor `src/services/TaskViewerProvider.ts` so reviewer batch/autoban prompts clearly describe code review against implementation and the plan requirements, while preserving existing planner/coder/lead semantics and inline challenge behavior.
3. Handle the single-plan autoban + `targetTerminalOverride` case by making the batch prompt builder emit reviewer-executor semantics equivalent to the manual path without changing routing side effects.
4. Add prompt-focused regression tests that assert reviewer batch prompts mention code review / implementation review, reference plan requirements as criteria, and avoid ambiguous “review the plan” framing.
5. Re-run compile plus focused prompt regressions, then read back modified ranges and review the diff before red-team review.

### Dependency Map

- Step 2 depends on Step 1 confirming the exact wording and structure used by the manual reviewer path.
- Step 3 depends on Step 2 because the single-plan override case should reuse the same reviewer intent rather than add a third prompt variant.
- Step 4 depends on Steps 2-3 settling the new prompt contract.
- Step 5 depends on Steps 2-4 being complete so verification reflects the real shipped behavior.

### Risks

- Reviewer autoban wording could drift again if manual and batch prompts continue to duplicate role intent in multiple places.
- Tightening reviewer language must not accidentally change planner/coder/lead batch prompt behavior or break lead inline challenge / coder accuracy instructions.
- Prompt-focused regressions that rely on brittle raw strings can create false failures unless they assert semantic anchors rather than byte-for-byte text.

### Verification Plan

- `npm run compile-tests`
- `npm run compile`
- `npm run lint` (expected pre-existing ESLint v9 config failure unless repo config changes)
- `node src\test\kanban-batch-prompt-regression.test.js`
- focused autoban prompt regression test(s)
- read back modified `TaskViewerProvider.ts` and test files

### Verification Record

- Baseline `npm run compile-tests`: PASS.
- Baseline `npm run compile`: PASS.
- Baseline `npm run lint`: FAIL (pre-existing ESLint v9 config migration issue: missing `eslint.config.*`).
- Implementation verification: `npm run compile-tests`, `npm run compile`, `node src\test\autoban-reviewer-prompt-regression.test.js`, and `node src\test\challenge-prompt-regression.test.js`: PASS.
- Final verification: `npm run compile-tests`, `npm run compile`, `node src\test\autoban-reviewer-prompt-regression.test.js`, `node src\test\challenge-prompt-regression.test.js`, and `node src\test\kanban-batch-prompt-regression.test.js`: PASS.
- Readback review completed for `src/services/TaskViewerProvider.ts` shared reviewer helpers, reviewer autoban batch branch, manual reviewer prompt branch, and `src/test/autoban-reviewer-prompt-regression.test.js`.
- Final scoped diff review: `git --no-pager diff --stat -- src\services\TaskViewerProvider.ts src\test\autoban-reviewer-prompt-regression.test.js task.md` plus scoped diff output confirmed only intended reviewer prompt parity / task tracking changes in this execution block.

### Red Team Findings

- `src/services/TaskViewerProvider.ts:989-1002` — Failure mode: manual and autoban reviewer semantics could drift again if one path stops using the shared intro/mode helpers; mitigation: both single-plan reviewer prompts and the reviewer batch branch now call `_buildReviewerExecutionIntro(...)` / `_buildReviewerExecutionModeLine(...)`.
- `src/services/TaskViewerProvider.ts:2016-2035` — Failure mode: reviewer autoban could regress back into plan-review wording and send the wrong task framing to pooled reviewer terminals; mitigation: the reviewer batch branch now explicitly says implementation/code review, anchors against plan requirements, and calls out per-plan validation results.
- `src/services/TaskViewerProvider.ts:2017-2019` — Failure mode: singular pooled sends could sound plural or ambiguous in the single-plan override case; mitigation: `planTarget` and `_buildReviewerExecutionIntro(plans.length)` switch wording between `this plan` and `each listed plan`.
- `src/services/TaskViewerProvider.ts:6833-6869` — Failure mode: tightening autoban reviewer prompts could accidentally weaken the manual reviewer flow; mitigation: the manual light/strict reviewer prompts retain their existing downstream requirements while reusing the shared reviewer-executor intro/mode contract.

- `src/test/autoban-reviewer-prompt-regression.test.js:11-46` — Failure mode: a future refactor could reintroduce ambiguous reviewer batch wording without changing runtime types or compile output; mitigation: the regression asserts shared helper presence plus implementation-review / plan-requirements anchors.
- `src/test/autoban-reviewer-prompt-regression.test.js:31-37` — Failure mode: the old `Please review the following ... plans` phrasing could quietly return and pass weaker tests; mitigation: the regression explicitly forbids both prior ambiguous reviewer strings.
- `src/test/autoban-reviewer-prompt-regression.test.js:43-45` — Failure mode: exact newline/indent assertions can false-fail on harmless formatting churn; mitigation: the per-plan guidance assertion now uses a newline-tolerant regex instead of a brittle raw string.

- `task.md:428-436` — Failure mode: checklist state can drift from actual implementation/verification progress if this block is not updated immediately after each gate; mitigation: all execution items for this plan are now closed out in the same run that completed verification.
- `task.md:468-477` — Failure mode: verification evidence can become misleading if only implementation-pass results are recorded; mitigation: this block now distinguishes baseline, implementation verification, and final verification command sets.
- `task.md:479-489` — Failure mode: red-team notes can lose value if they omit the new regression file or shared-helper seam; mitigation: this section records concrete failure modes for `TaskViewerProvider.ts`, the reviewer prompt regression test, and this task artifact itself.

## Kanban remove view option execution (feature_plan_20260317_165350_remove_view_plan_option_from_kanban_cards)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the source plan file.
- [x] Read impacted implementation surfaces and dependencies (`src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/extension.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/implementation.html`, related regression tests).
- [x] Run baseline verification (`npm run compile`, `npm run compile-tests`, relevant regression tests) and capture current status.
- [x] Remove the Kanban-only `View` button markup, click binding, provider case, extension command, and unused `handleKanbanViewPlan(...)` wrapper.
- [x] Add/update focused regression coverage proving the Kanban `View` path is gone while the generic non-Kanban `viewPlan` flow remains.
- [x] Verify the implementation group (`npm run compile`, `npm run compile-tests`, targeted regression tests) and read back modified files.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Capture a clean baseline with compile, test compile, and the existing `review-send-agent-trigger-regression` test because it currently depends on the Kanban wrapper boundary.
2. Remove the Kanban card `View` icon/button and `viewPlan` click binding from `src/webview/kanban.html` while preserving the remaining `Copy Prompt`, `Review`, and `Complete` actions.
3. Remove the Kanban-only backend chain in `src/services/KanbanProvider.ts`, `src/extension.ts`, and `src/services/TaskViewerProvider.ts`, but keep the generic `_handleViewPlan(...)` path and the sidebar `implementation.html` `viewPlan` message intact.
4. Add a focused regression test for the removed Kanban view path, and update the existing send-agent regression test so it no longer depends on a deleted Kanban-only wrapper method.
5. Run the verification gate commands, read back the modified ranges, then perform red-team review before final verification.

### Dependency Map

- Baseline verification must complete before implementation so unchanged failures are attributable.
- The backend deletions depend on confirming that `_handleViewPlan(...)` still has a non-Kanban caller in `implementation.html`.
- Regression updates depend on the final symbol/command removal shape.
- Final verification depends on both the removals and the regression coverage landing together.

### Risks

- Removing `handleKanbanViewPlan(...)` can break unrelated source-level tests that use it as a slice boundary.
- Removing the button without deleting the message handler chain would leave dead code that can drift silently.
- Over-aggressive regression assertions could accidentally fail on harmless formatting changes instead of guarding behavior.

### Verification Record

- Baseline `npm run compile`: PASS.
- Baseline `npm run compile-tests`: PASS.
- Baseline `node src\test\review-send-agent-trigger-regression.test.js`: PASS.
- Baseline `npm run lint`: FAIL (pre-existing ESLint v9 config migration issue: missing `eslint.config.*`).
- Implementation gate `npm run compile`: PASS.
- Implementation gate `npm run compile-tests`: PASS.
- Implementation gate `node src\test\review-send-agent-trigger-regression.test.js`: PASS.
- Implementation gate `node src\test\kanban-view-plan-removal-regression.test.js`: PASS.
- Final `npm run compile`: PASS.
- Final `npm run compile-tests`: PASS.
- Final `node src\test\review-send-agent-trigger-regression.test.js`: PASS.
- Final `node src\test\kanban-view-plan-removal-regression.test.js`: PASS.
- Final `npm run lint`: FAIL (same pre-existing ESLint v9 config migration issue, unchanged by this task).
- Readback completed for `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/extension.ts`, `src/services/TaskViewerProvider.ts`, `src/test/review-send-agent-trigger-regression.test.js`, and `src/test/kanban-view-plan-removal-regression.test.js`.
- Audit search confirmed the Kanban-only path is gone from TypeScript/HTML sources (`viewPlanFromKanban`, `handleKanbanViewPlan(...)`, `case 'viewPlan'`, `.card-btn.view`).

### Red Team Findings

- `src/webview/kanban.html:794-845` — Failure mode: removing the `View` button could leave a dead click binding that still posts `viewPlan`. Mitigation: the DOM listener and button markup are both removed, and the regression test asserts both are absent.
- `src/webview/kanban.html:837-845` — Failure mode: removing one icon could break action-row spacing or accidentally drop neighboring actions. Mitigation: readback confirmed `Copy Prompt`, `Review`, and `Complete` remain in the same action cluster.
- `src/webview/kanban.html:840-844` — Failure mode: the remaining action titles could drift and hide intent from users. Mitigation: the regression test explicitly checks `Review Plan Ticket` and `Complete Plan` still render.

- `src/services/KanbanProvider.ts:1096-1108` — Failure mode: the webview backend could keep a stale `case 'viewPlan'` and silently route dead messages. Mitigation: the case is removed entirely and the audit search found no remaining TypeScript handler.
- `src/services/KanbanProvider.ts:1101-1104` — Failure mode: removing the wrong case could break the ticket-review action instead of the redundant view action. Mitigation: readback confirmed `reviewPlan` still dispatches through `switchboard.reviewPlanFromKanban`.
- `src/services/KanbanProvider.ts:1106-1109` — Failure mode: adjacent copy-link behavior could be damaged by case reshuffling. Mitigation: readback confirmed `copyPlanLink` still delegates and posts its result message.

- `src/extension.ts:838-846` — Failure mode: a stale `switchboard.viewPlanFromKanban` registration could linger even after the webview button is removed. Mitigation: the command registration is gone and the new regression test asserts that exact command string is absent.
- `src/extension.ts:843-846` — Failure mode: removing the wrong registration could break the preferred review flow from Kanban. Mitigation: readback confirmed `switchboard.reviewPlanFromKanban` still routes to `handleKanbanReviewPlan(...)`.
- `src/extension.ts:838-846` — Failure mode: deleting a command without verifying compile could leave activation wiring inconsistent. Mitigation: both compile passes succeeded after the registration removal.

- `src/services/TaskViewerProvider.ts:1169-1170` — Failure mode: removing `handleKanbanViewPlan(...)` could accidentally remove the generic plan-opening implementation too. Mitigation: `_handleViewPlan(...)` remains intact and is asserted by the new regression test.
- `src/services/TaskViewerProvider.ts:1169-1170` — Failure mode: source-level tests that slice by the deleted wrapper could start failing for unrelated reasons. Mitigation: the existing send-agent regression was updated to use `handleKanbanReviewPlan(...)` as its boundary instead.
- `src/services/TaskViewerProvider.ts:2525-2531` — Failure mode: the generic sidebar `viewPlan` message path could be removed by over-scoping the cleanup. Mitigation: audit search and regression coverage confirmed the generic `case 'viewPlan'` flow still exists.

- `src/test/review-send-agent-trigger-regression.test.js:16-21` — Failure mode: the test could fail for the wrong reason by slicing to a method that no longer exists. Mitigation: the boundary now ends at `handleKanbanReviewPlan(...)`, which remains stable after this cleanup.
- `src/test/review-send-agent-trigger-regression.test.js:23-50` — Failure mode: updating the slice boundary could accidentally weaken the original trigger-scope assertions. Mitigation: the assertions about normal dispatch, fallback move behavior, and CLI-trigger independence were left intact.
- `src/test/review-send-agent-trigger-regression.test.js:16-18` — Failure mode: future adjacent-method reordering could still invalidate the slice. Mitigation: the boundary now anchors on the next surviving public Kanban review method rather than the removed view wrapper.

- `src/test/kanban-view-plan-removal-regression.test.js:20-37` — Failure mode: the new regression could only check one surface and miss partial reintroduction of the feature. Mitigation: it asserts button markup removal, click-binding removal, and preservation of the remaining Kanban actions.
- `src/test/kanban-view-plan-removal-regression.test.js:39-49` — Failure mode: backend cleanup could regress independently of the webview. Mitigation: the test separately asserts the provider case, extension command, and TaskViewer wrapper are all absent.
- `src/test/kanban-view-plan-removal-regression.test.js:52-58` — Failure mode: the cleanup could accidentally break non-Kanban plan opening. Mitigation: the test asserts both `implementation.html` and `_handleViewPlan(...)` still carry the generic flow.

- `task.md:584-646` — Failure mode: verification evidence can drift from the actual commands run. Mitigation: the section records baseline, implementation-gate, and final command outcomes separately.
- `task.md:620-631` — Failure mode: future readers could misattribute lint failure to this feature. Mitigation: the record explicitly marks the ESLint config failure as pre-existing and unchanged.
- `task.md:633-646` — Failure mode: red-team findings can become stale as nearby code moves. Mitigation: the findings cite the exact files and current line ranges from this execution snapshot.

## Denied button brightness execution (feature_plan_20260317_170659_access_main_program_button_denied_too_dark)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the source plan file.
- [x] Read impacted implementation surfaces and dependencies (`src/webview/implementation.html`, shared button styling, and existing implementation webview regression patterns).
- [x] Run baseline verification (`npm run compile`, `npm run compile-tests`, `npm run lint`) and capture current status.
- [x] Isolate the temporary `DENIED` visual state from generic `.secondary-btn:disabled` dimming while preserving the neutral idle button styling and one-second reset behavior.
- [x] Add focused regression coverage that guards the bright denied state and keeps the generic disabled secondary-button rule intact.
- [x] Verify the implementation group (`npm run compile`, `npm run compile-tests`, targeted regression test) and read back modified files.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Baseline the repository with compile, test compile, and lint before changing the webview so any failures are clearly attributable.
2. Replace the denied state's inline styling with an explicit scoped class in `implementation.html` that preserves the bright red appearance even while the button is temporarily disabled.
3. Keep the idle `Access main program` button neutral and keep the existing label rotation / one-second deny timing unchanged.
4. Add a focused source-level regression test that asserts the denied-state class overrides disabled dimming while the generic `.secondary-btn:disabled` rule remains present.
5. Run the verification gate commands, read back the modified sections, then perform red-team review before final verification.

### Dependency Map

- Baseline verification must complete before implementation so unchanged failures are attributable.
- The CSS class and JavaScript toggle must land together; otherwise the denied state will either never activate or stay muted.
- The regression test depends on the final class name and denied-state logic shape.
- Final verification depends on both the styling change and the regression coverage.

### Risks

- Overriding disabled styling too broadly could brighten unrelated disabled buttons in the sidebar.
- Leaving inline styles in place while adding a class could create conflicting reset behavior after the one-second timeout.
- A brittle regression test could overfit formatting instead of guarding the denied-state behavior.

### Verification Record

- Baseline `npm run compile`: PASS.
- Baseline `npm run compile-tests`: PASS.
- Baseline `npm run lint`: FAIL (pre-existing ESLint v9 config migration issue: missing `eslint.config.*`).
- Implementation gate `npm run compile`: PASS.
- Implementation gate `npm run compile-tests`: PASS.
- Implementation gate `node src\test\access-main-program-denied-regression.test.js`: PASS.
- Final `npm run compile`: PASS.
- Final `npm run compile-tests`: PASS.
- Final `node src\test\access-main-program-denied-regression.test.js`: PASS.
- Final `npm run lint`: FAIL (same pre-existing ESLint v9 config migration issue, unchanged by this task).
- Readback completed for `src/webview/implementation.html` and `src/test/access-main-program-denied-regression.test.js`.
- Scoped diff review confirmed the intended change set is limited to `src/webview/implementation.html`, `src/test/access-main-program-denied-regression.test.js`, and `task.md`.

### Red Team Findings

- `src/webview/implementation.html:758-764` — Failure mode: broad disabled-button styling could still wash out the temporary denied state. Mitigation: the generic `.secondary-btn:disabled` rule is left unchanged, and the new `.secondary-btn.is-denied:disabled` override restores `opacity: 1` only for this transient state.
- `src/webview/implementation.html:803-814` — Failure mode: an over-broad denied-state selector could accidentally brighten unrelated secondary buttons. Mitigation: the styling is scoped to the explicit `is-denied` class and reuses existing `--accent-red` / `--glow-red` tokens instead of touching the global disabled palette.
- `src/webview/implementation.html:1758-1771` — Failure mode: the button could get stuck red or disabled if the reset path forgets to remove the class. Mitigation: the timeout now explicitly removes `is-denied`, rotates the label, and clears `disabled` in the same reset block.

- `src/test/access-main-program-denied-regression.test.js:11-31` — Failure mode: future edits could brighten the denied state by weakening the generic disabled rule instead of scoping the override. Mitigation: the regression test asserts the original `.secondary-btn:disabled` rule still contains `opacity: 0.3` while the denied-state override explicitly restores brightness.
- `src/test/access-main-program-denied-regression.test.js:34-45` — Failure mode: the visual fix could make the button bright but accidentally re-enable click spam during the one-second denied window. Mitigation: the test asserts the handler still sets `disabled = true` on deny and `disabled = false` only on reset.
- `src/test/access-main-program-denied-regression.test.js:48-50` — Failure mode: the idle button could regress back to a persistent red variant. Mitigation: the regression test asserts the original neutral markup for `btn-easter-egg` remains unchanged.

- `task.md:693-747` — Failure mode: verification evidence could drift from the actual commands run. Mitigation: this section records baseline, implementation-gate, and final command results separately and notes the unchanged lint blocker explicitly.

## Autoban CLEAR & RESET reload reconciliation execution (feature_plan_20260317_194503_in_autoban_terminals_the_clear_reset_button_does_nothing)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the source plan file.
- [x] Read impacted implementation surfaces and dependencies (`src/services/TaskViewerProvider.ts`, `src/webview/implementation.html`, `src/services/autobanState.ts`, `src/test/autoban-state-regression.test.js`, `src/test/autoban-controls-regression.test.js`).
- [x] Run baseline verification (`npm run compile-tests`, `npm run compile`, `npm run lint`, `node src\test\autoban-state-regression.test.js`, `node src\test\autoban-controls-regression.test.js`) and capture current status.
- [x] Reconcile persisted Autoban pool state against alive Autoban candidates during reload restore and after `CLEAR & RESET`.
- [x] Tighten the Autoban webview pool rendering so reset no longer falls back to raw role-tagged `lastTerminals`.
- [x] Add focused regression coverage for the reset/reload reconciliation path.
- [x] Verify the implementation group (`npm run compile-tests`, `npm run compile`, targeted Autoban regressions) and read back modified files.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Add a provider helper that reconciles `terminalPools`, `managedTerminalPools`, `sendCounts`, and `poolCursor` against the alive Autoban registry so reload-time stale entries are pruned consistently.
2. Run that helper before `_tryRestoreAutoban()` broadcasts restored Autoban state and again after `_resetAutobanPools()` closes managed backup terminals.
3. If safe, prune dead `purpose === 'autoban-backup'` records from `.switchboard/state.json` instead of waiting for the 24-hour stale-terminal housekeeping path.
4. Update `getRolePoolEntries()` in `implementation.html` to render the same alive/effective-pool membership that the provider uses, rather than the raw `(configuredPool.length > 0 ? configuredPool : liveRoleTerminals)` fallback.
5. Extend focused source-level regression coverage so both the provider reconciliation path and the webview fallback rule are locked in.

### Dependency Map

- The provider reconciliation helper must land before the restore/reset call sites can use it.
- The webview fallback change depends on the provider-side alive/effective-pool rule being chosen first so both sides stay aligned.
- Regression coverage depends on the final helper name and fallback shape.
- Final verification depends on the provider change, the webview change, and the regression coverage all landing together.

### Risks

- Over-pruning terminal records could hide legitimate live role terminals after reload.
- Changing the webview fallback without matching provider semantics could desynchronize the displayed pool from actual Autoban dispatch selection.
- Closing or deleting the wrong records during reset could broaden the fix into an unsafe general terminal cleanup.

### Verification Record

- Baseline `npm run compile-tests`: PASS.
- Baseline `npm run compile`: PASS.
- Baseline `npm run lint`: FAIL (pre-existing ESLint v9 config migration issue: missing `eslint.config.*`).
- Baseline `node src\test\autoban-state-regression.test.js`: PASS.
- Baseline `node src\test\autoban-controls-regression.test.js`: PASS.
- Implementation gate `npm run compile-tests`: PASS.
- Implementation gate `npm run compile`: PASS.
- Implementation gate `node src\test\autoban-state-regression.test.js`: PASS.
- Implementation gate `node src\test\autoban-controls-regression.test.js`: PASS.
- Final `npm run compile-tests`: PASS.
- Final `npm run compile`: PASS.
- Final `npm run lint`: FAIL (same pre-existing ESLint v9 config migration issue, unchanged by this task).
- Final `node src\test\autoban-state-regression.test.js`: PASS.
- Final `node src\test\autoban-controls-regression.test.js`: PASS.
- Manual reload regression check in the VS Code extension host: NOT RUN in this CLI environment.
- Readback completed for `src/services/TaskViewerProvider.ts`, `src/webview/implementation.html`, and `src/test/autoban-state-regression.test.js`.
- Scoped diff stat was reviewed for `src/services/TaskViewerProvider.ts`, `src/webview/implementation.html`, `src/test/autoban-state-regression.test.js`, and `task.md`; raw file-level stats are inflated because the worktree already carried unrelated edits in some of the same files, so readback was used to verify the reset-specific hunks directly.

### Red Team Findings

- `src/services/TaskViewerProvider.ts:1500-1501` — Failure mode: backup detection could hide a legitimate manual terminal if another feature reused the exact `purpose: 'autoban-backup'` marker. Mitigation: the new primary-terminal fallback only excludes that exact normalized purpose string and does not special-case any other terminal metadata.
- `src/services/TaskViewerProvider.ts:1620-1688` — Failure mode: reconciliation could silently discard active pool members if alive detection diverged from dispatch selection. Mitigation: the helper reuses `_getAliveAutobanTerminalRegistry(...)` and the same alive/effective-pool contract that dispatch already depends on.
- `src/services/TaskViewerProvider.ts:1690-1704` — Failure mode: stale backup pruning could broaden into unsafe registry cleanup after reload. Mitigation: deletion is limited to dead entries that still identify as `autoban-backup`; non-backup/manual terminals are never removed by this path.
- `src/services/TaskViewerProvider.ts:2128-2168` — Failure mode: restore/reset could still rebroadcast ghost pool members if reconciliation happened after the UI sync. Mitigation: both `_resetAutobanPools()` and `_tryRestoreAutoban()` now await `_reconcileAutobanPoolState(...)` before the next broadcast/start step.

- `src/webview/implementation.html:2863-2873` — Failure mode: the UI could remain broader than the backend if empty pools still fell back to every alive role-tagged terminal. Mitigation: the fallback now uses `alivePrimaryRoleTerminals`, matching the provider’s post-reset rule.
- `src/webview/implementation.html:2867-2868` — Failure mode: backup terminals could still masquerade as primaries after reset. Mitigation: the fallback explicitly excludes entries whose `purpose` normalizes to `autoban-backup`.
- `src/webview/implementation.html:2869-2873` — Failure mode: configured pools could still show offline ghosts if render-time filtering only happened in the provider. Mitigation: configured entries are intersected with currently alive role terminals before the UI maps them into pool cards.

- `src/test/autoban-state-regression.test.js:227-243` — Failure mode: the new source assertions could false-fail on harmless refactors. Mitigation: the test now anchors on the reconciliation contract, restore/reset hook calls, and backup-pruning seam instead of a single implementation string.
- `src/test/autoban-state-regression.test.js:252-255` — Failure mode: the webview assertion could miss the stricter primary-terminal fallback and allow drift back to backup ghosts. Mitigation: the regex explicitly requires `alivePrimaryRoleTerminals`, the `autoban-backup` exclusion, and the new effective-pool fallback.
- `src/test/autoban-state-regression.test.js:227-255` — Failure mode: source-level coverage cannot prove interactive extension-host behavior on its own. Mitigation: this regression test is treated as a contract guard, while the verification record explicitly calls out the manual reload check as not run here.

- `task.md:829-879` — Failure mode: task tracking could overstate completion without preserving the actual command evidence. Mitigation: baseline, implementation-gate, and final command outcomes are recorded separately, including the unchanged lint blocker.
- `task.md:874-879` — Failure mode: readers could misread the raw diff stat as belonging only to this fix in a dirty worktree. Mitigation: the record explicitly notes that file-level diff stats were inflated and that readback was used for the reset-specific hunks.
- `task.md:871-879` — Failure mode: the missing manual extension-host verification could get lost once the task is handed off. Mitigation: the verification record keeps that gap explicit so the remaining manual check is visible.

## Kanban CREATED label revert execution (feature_plan_20260318_053929_change_colum_name_back)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, the source plan file, current `task.md`, and session `plan.md`.
- [x] Run baseline verification (`npm run compile-tests`, `npm run compile`, `npm run lint`, focused kanban label regressions) and capture current status.
- [x] Update the shared built-in Kanban column labels and alias handling so `CREATED` displays as `New` while still accepting legacy `Plan Created`.
- [x] Update the Kanban webview seed definition and focused regressions to match the restored `New` label.
- [x] Verify the implementation group, read back modified code, and confirm only intended hunks changed.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Detailed Plan

1. Capture a baseline with `compile-tests`, `compile`, `lint`, and the existing focused kanban label regressions so unchanged failures are attributable before editing.
2. Update the shared label sources in `src/services/agentConfig.ts` and `src/mcp-server/register-tools.js` so the canonical built-in `CREATED` label is `New`, while keeping internal routing/storage on the stable `CREATED` identifier and preserving `Plan Created` as a lookup alias.
3. Update `src/webview/kanban.html` so its bootstrapped column label matches the shared runtime/MCP label.
4. Update `src/test/kanban-state-filter-regression.test.js` and `src/test/kanban-mcp-state.test.js` to assert the restored `New` label while locking compatibility for the old `Plan Created` alias.
5. Re-run verification, read back changed ranges, and review the scoped diff before final red-team review.

### Dependency Map

- Baseline verification must complete before implementation so failures remain attributable.
- Shared definitions must change before UI/test updates so all dependent surfaces converge on one label contract.
- Regression updates depend on the final alias/label shape.
- Final verification depends on code and tests landing together.

### Risks

- Any remaining `Plan Created` label in a canonical definition would leave UI/MCP drift.
- Removing the legacy alias could break existing prompts, scripts, or tests that still pass `Plan Created`.
- Because the worktree is already dirty in overlapping areas, diff review alone is not enough; readback must confirm the exact edited lines.

### Verification Plan

- `npm run compile-tests`
- `npm run compile`
- `npm run lint` (expected existing ESLint v9 config failure unless repo config changes)
- `node src\test\kanban-state-filter-regression.test.js`
- `node src\test\kanban-mcp-state.test.js`
- Read back modified files and review scoped diff

### Verification Record

- Baseline `npm run compile-tests`: PASS.
- Baseline `npm run compile`: PASS.
- Baseline `npm run lint`: FAIL (pre-existing ESLint v9 config migration issue: missing `eslint.config.*`).
- Baseline `node src\test\kanban-state-filter-regression.test.js`: PASS.
- Baseline `node src\test\kanban-mcp-state.test.js`: PASS.
- Implementation gate `npm run compile-tests`: PASS.
- Implementation gate `npm run compile`: PASS.
- Implementation gate `node src\test\kanban-state-filter-regression.test.js`: PASS.
- Implementation gate `node src\test\kanban-mcp-state.test.js`: PASS.
- Implementation gate `npm run lint`: FAIL (same pre-existing ESLint v9 config migration issue, unchanged).
- Readback completed for `src/services/agentConfig.ts`, `src/webview/kanban.html`, `src/mcp-server/register-tools.js`, `src/test/kanban-state-filter-regression.test.js`, and `src/test/kanban-mcp-state.test.js`.
- Scoped diff review confirmed the intended label change in `src/services/agentConfig.ts`, `src/webview/kanban.html`, `src/mcp-server/register-tools.js`, `src/test/kanban-state-filter-regression.test.js`, and `src/test/kanban-mcp-state.test.js`. Note: `src/mcp-server/register-tools.js` also has pre-existing unrelated worktree edits outside this label-revert hunk.

### Red Team Findings

- `src/services/agentConfig.ts:30-35` — Failure mode: if the canonical built-in column definition kept `Plan Created`, any consumer using shared Kanban definitions would still render the wrong header. Mitigation: the `CREATED` definition now restores the label to `New` at the shared source.
- `src/services/agentConfig.ts:30-35` — Failure mode: renaming the internal column ID instead of the label would break persisted runsheets, routing, and MCP filters that rely on `CREATED`. Mitigation: only the display label changed; the stable ID remains `CREATED`.
- `src/services/agentConfig.ts:30-35` — Failure mode: changing sort order or autoban metadata while touching the label could silently reorder the board or alter automation. Mitigation: order, kind, and `autobanEnabled` were left unchanged.

- `src/webview/kanban.html:536-541` — Failure mode: the board can briefly render its bootstrapped local column labels before backend sync, so a stale `Plan Created` seed would still show the wrong header on load. Mitigation: the seeded `CREATED` label now matches the restored `New` contract.
- `src/webview/kanban.html:536-541` — Failure mode: a partial UI-only fix could drift from MCP/runtime definitions and cause visible label flicker after sync. Mitigation: the webview label was updated in tandem with the shared definition and MCP definition.
- `src/webview/kanban.html:536-541` — Failure mode: editing the wrong object in the seed array could break the role mapping or disable autoban on another column. Mitigation: only the `CREATED` label string changed; role/order behavior stayed intact.

- `src/mcp-server/register-tools.js:292-305` — Failure mode: `get_kanban_state` could continue emitting `Plan Created` even if the UI changed, leaving CLI and extension surfaces inconsistent. Mitigation: the built-in MCP column definition now labels `CREATED` as `New`.
- `src/mcp-server/register-tools.js:302-305` — Failure mode: removing the `PLAN CREATED` alias would break existing prompts, scripts, or tests that still address the old label text. Mitigation: both `NEW` and legacy `PLAN CREATED` still resolve to `CREATED`.
- `src/mcp-server/register-tools.js:2196-2200` — Failure mode: the schema description could advertise the wrong UI label and mislead users of the MCP tool even after behavior changed. Mitigation: the tool description now names `New` as the UI label.

- `src/test/kanban-state-filter-regression.test.js:31-57` — Failure mode: future edits could restore `Plan Created` in formatter output without breaking compile. Mitigation: the regression now asserts the formatted built-in label is exactly `New`.
- `src/test/kanban-state-filter-regression.test.js:49-57` — Failure mode: restoring the label could accidentally drop alias compatibility for older callers. Mitigation: the regression explicitly keeps both `New` and `Plan Created` resolving to `CREATED`.
- `src/test/kanban-state-filter-regression.test.js:31-57` — Failure mode: a narrower assertion could miss custom-column formatting regressions while focusing on the renamed built-in column. Mitigation: the existing custom-column expectations remain intact alongside the updated `CREATED` label check.

- `src/test/kanban-mcp-state.test.js:92-149` — Failure mode: MCP output could regress to the old label while filtered-column behavior still passes. Mitigation: the test now asserts `payload.CREATED.label === 'New'` on full-board output and filtered responses.
- `src/test/kanban-mcp-state.test.js:111-139` — Failure mode: switching only to the new label could hide a backward-compatibility break for callers that still send `Plan Created`. Mitigation: the test now covers both `column: 'New'` and `column: 'Plan Created'`.
- `src/test/kanban-mcp-state.test.js:141-148` — Failure mode: error messages for unknown columns could still advertise the stale display name and misdirect users. Mitigation: the regression now requires `CREATED (New)` in the available-columns error text.

- `task.md:900-940` — Failure mode: the accuracy checklist could overstate completion if baseline and verification gates were not recorded immediately after they ran. Mitigation: this section now marks the completed gates in execution order and leaves final verification pending until it is rerun.
- `task.md:942-953` — Failure mode: verification evidence could become ambiguous if baseline and post-change results were mixed together. Mitigation: the record separates baseline and implementation-gate outcomes and calls out the unchanged ESLint blocker explicitly.
- `task.md:955-972` — Failure mode: red-team notes could miss the dirty-worktree nuance and over-trust a raw diff in overlapping files. Mitigation: the findings explicitly record that `register-tools.js` carries pre-existing unrelated edits outside the reverted label hunk.

### Final Verification Addendum

- Final `npm run compile-tests`: PASS.
- Final `npm run compile`: PASS.
- Final `node src\test\kanban-state-filter-regression.test.js`: PASS.
- Final `node src\test\kanban-mcp-state.test.js`: PASS.
- Final `npm run lint`: FAIL (same pre-existing ESLint v9 config migration issue, unchanged).
- Final scoped diff stat reviewed for `src/services/agentConfig.ts`, `src/webview/kanban.html`, `src/mcp-server/register-tools.js`, `src/test/kanban-state-filter-regression.test.js`, `src/test/kanban-mcp-state.test.js`, and `task.md`.
