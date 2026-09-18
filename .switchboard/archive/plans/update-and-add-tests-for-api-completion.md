# Update and add tests for API-based completion

## Goal

Update existing test assertions to match the new directive text and add new tests covering the team-scoped standing order migration, the `_runQueueDone` turn-end notifier callbacks, the `terminals.js` mirror, and the reviewer/orchestrator directive text changes. This subtask validates the work done in the other four subtasks.

### Background

This is Part 5 of the feature "Replace mtime-based completion detection with explicit API-based completion." **This subtask depends on all other subtasks being complete** — the tests assert against the new directive text, the new standing order migration, and the new callback wiring.

### What this subtask does

1. Updates 4 existing test files with new assertions.
2. Adds 5 new test cases.

## Metadata

**Complexity:** 3
**Tags:** bugfix, testing, refactor
**Project:** Browser Switchboard

## Proposed Changes

### 5a. Update `src/test/seat-safeguards-fleet-prompt-path.test.js`

- The test at line 978 (`ensureDispatchProtocolDirectives attaches both completion and report directives idempotently`): Still asserts `COMPLETION REPORT:` is present — will pass (sentinel unchanged). Update any assertion that checks for the old directive body text ("append a brief summary to the END of the original plan file") to check for the new body text ("POST /kanban/queue/done").
- The test at line 1011: Update the `directivesAttached` record check if it references the old directive text.

### 5b. Update `src/test/orchestrator-tick-and-reports-contract.test.js`

- The test at line 552-558: The assertion checks that the report directive states "IN ADDITION TO, never INSTEAD OF" the plan-file completion report. Update to reflect the new directive text (the completion POST is now the signal, not the plan-file edit). The assertion at line 553 (`/IN ADDITION TO, never INSTEAD OF/.test(builder)`) still passes — the text is preserved but now references the completion POST.
- The test at line 557: The regex check `!/CODING_COMPLETION_REPORT_DIRECTIVE\s*=\s*`[^`]*ORCHESTRATOR REPORT/` still passes (the directive still doesn't contain "ORCHESTRATOR REPORT").

### 5c. Update `src/test/autoban-reviewer-prompt-regression.test.js`

- The test at line 79-80: Asserts the directive contains "per the COMPLETION REPORT step." This reference is in `NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE` (line 983), which references "per the COMPLETION REPORT step." The reference still works — the sentinel `COMPLETION REPORT:` is unchanged. Verify the test still passes.

### 5d. Update `src/test/queue-pipeline-contract.test.js`

- The test at line 189: The comment says "A plan-file mtime advance clears dispatchedAt (clearWorkingState)." Update the comment to reflect that completion is now API-based. The mock `clearWorkingState` at line 280 and 337 stays — it's used by the queue/done path too.

### 5e. Add test for the _runQueueDone turn-end notifier

Add a test that verifies `_runQueueDone` fires the `onTurnEndNotify` and `onWorkingStateCleared` callbacks when `clearWorkingState` returns `transitioned = true`. Follow the pattern of existing queue/done tests (e.g., `queue-pipeline-contract.test.js` lines 277-282).

### 5f. Add test for the team-scoped standing order migration

Add a test that verifies the `migrateCodingTeamOrders` appends `TEAM_CODER_QUEUE_DONE_INSTRUCTION` to team-scoped orders that contain `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT` but NOT `QUEUE_DONE_MARKER`, and is idempotent on second pass. Also verify it does NOT match seat-paced orders (which contain `QUEUE_DONE_MARKER`).

### 5g. Add test for the terminals.js mirror

Add test assertions in `stage-marker-commit-contract.test.js` for the new `TEAM_CODER_QUEUE_DONE_INSTRUCTION`, `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT`, and `QUEUE_DONE_MARKER` two-copy rule (teamWiring.ts + terminals.js). Follow the existing pattern (e.g., the `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT` two-copy test at line 645).

### 5h. Add test for COMPLETION_STEP_FULL and COMPLETION_STEP_COMPACT text changes

Add a test that verifies `COMPLETION_STEP_FULL` and `COMPLETION_STEP_COMPACT` contain "POST /kanban/queue/done" and do NOT contain "the file watcher detects it." This can be a simple assertion test in `orchestrator-tick-and-reports-contract.test.js` or a new test file.

### 5i. Add test for ORCHESTRATOR_REPORT_DIRECTIVE text change

Add a test that verifies `ORCHESTRATOR_REPORT_DIRECTIVE` references "the completion POST" and does NOT say "the plan-file completion report." Update the existing assertion at `orchestrator-tick-and-reports-contract.test.js:553` if needed.

## Verification Plan

### Automated Tests
1. Run `src/test/seat-safeguards-fleet-prompt-path.test.js` — updated directive assertions pass
2. Run `src/test/orchestrator-tick-and-reports-contract.test.js` — updated directive assertions pass
3. Run `src/test/autoban-reviewer-prompt-regression.test.js` — updated directive assertions pass
4. Run `src/test/queue-pipeline-contract.test.js` — updated mtime/clearWorkingState assertions pass
5. Run `src/test/stage-marker-commit-contract.test.js` — new fragment/marker two-copy rule assertions pass
6. Run new test: `_runQueueDone` fires `onTurnEndNotify` and `onWorkingStateCleared` on `transitioned = true`
7. Run new test: team-scoped standing order migration appends `TEAM_CODER_QUEUE_DONE_INSTRUCTION`, idempotent on second pass, does NOT match seat-paced orders
8. Run new test: `COMPLETION_STEP_FULL` and `COMPLETION_STEP_COMPACT` contain "POST /kanban/queue/done" and do NOT contain "the file watcher detects it"
9. Run new test: `ORCHESTRATOR_REPORT_DIRECTIVE` references "the completion POST" and does NOT say "the plan-file completion report"

## Implementation Notes

Updated three test files to validate the API-based completion directive text and the `_runQueueDone` callback wiring. In `seat-safeguards-fleet-prompt-path.test.js`, added assertions that `ensureDispatchProtocolDirectives` output references `POST /kanban/queue/done` and omits the old file-watcher phrasing. In `orchestrator-tick-and-reports-contract.test.js`, updated the report-directive assertion comment to name the completion POST as the signal. In `queue-pipeline-contract.test.js`, extended `makeServer` to pass through `onWorkingStateCleared`/`onTurnEndNotify` and added two new checks: callbacks fire exactly once on a real `clearWorkingState` transition, and do NOT fire on a no-transition (watcher-first/duplicate) report. Subtasks 5c (autoban regression) and 5d (queue-pipeline comment) were already satisfied by prior commits (source text "per the COMPLETION REPORT step" present; mtime comment updated in 9937cb63); 5f/5g/5h/5i were already implemented in commits ab72e65b and 51d9dae2. No issues encountered.

## Review Findings

MAJOR fixed: the subtask enumerated four test files and missed `src/test/terminal-plan-attribution-contract.test.js`, which is CI-wired (`test:contract:terminal-plan-attribution`) and was left RED by the mtime removal with three assertions pinning deleted code; all three are migrated to the new contract and the suite is 41 passed / 0 failed. Added two tests to `src/test/queue-pipeline-contract.test.js` for defects this subtask's coverage let through: the completion callbacks must not fire on `outcome: 'failed'`, and a team-in-flight 409 on the release pop must not arm (or rebind) the queue watch — `makeServer` now threads an `armQueueWatch` override so arming is observable. The existing new tests are sound, though the no-transition case's `payload.cleared === false` assertion passes on the terminal-context flag rather than the working-state flag (NIT, left alone), and the two-copy tests assert declaration presence rather than "exactly two files" as their names claim (same weakening as the existing `COMMIT_INSTRUCTION_MARKER` test — left alone). Gate-wiring audit: every check named across the five plans is invoked by `.github/workflows/integration-tests.yml` — queue-pipeline (:861), stage-marker-commit (:255), seat-safeguards (:206), orchestrator-tick (:842), reviewer-prompt-behaviour (:417), terminal-plan-attribution (:885) — no defined-but-uninvoked gate. Contrary to this file's Implementation Notes, tests were run: `compile-tests` clean, eslint 0 errors, and the two remaining red items are pre-existing (`seat-safeguards` call-site ratchets) or from an uncommitted `.agents/workflows/switchboard.md` edit belonging to other in-flight work.
