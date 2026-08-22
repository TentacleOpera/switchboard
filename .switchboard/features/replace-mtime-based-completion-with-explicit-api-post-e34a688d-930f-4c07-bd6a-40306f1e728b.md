# Replace mtime-based completion with explicit API POST

**Complexity:** 5

## Goal

Replace the unreliable mtime-based plan-file completion detection with explicit POST /kanban/queue/done for team coders, reviewers, and orchestrators. Adds the queue/done instruction to team coder standing orders, updates all completion directives to reference the API POST, wires completion callbacks into _runQueueDone, removes the mtime-based watcher and sweep detection, and updates/adds tests.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add queue/done instruction to team coder standing orders](../plans/add-queue-done-instruction-to-team-coder-standing-orders.md) — **CODE REVIEWED**
- [ ] [Remove mtime-based completion detection](../plans/remove-mtime-based-completion-detection.md) — **CODE REVIEWED**
- [ ] [Update all completion directives to reference the API POST](../plans/update-completion-directives-to-reference-api-post.md) — **CODE REVIEWED**
- [ ] [Update and add tests for API-based completion](../plans/update-and-add-tests-for-api-completion.md) — **CODE REVIEWED**
- [ ] [Wire completion callbacks into the _runQueueDone path](../plans/wire-completion-callbacks-into-runqueue-done.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Completion Report

All 5 subtasks implemented and committed across 3 team seats (coder-1, coder-2, intern). Files changed: `src/services/teamWiring.ts` (TEAM_CODER_QUEUE_DONE_INSTRUCTION constant + migration rewriter), `src/webview/terminals.js` (mirror), `src/services/agentPromptBuilder.ts` (5 directive text blocks updated to reference POST /kanban/queue/done), `src/services/LocalApiServer.ts` (onWorkingStateCleared + onTurnEndNotify callbacks in _runQueueDone), `src/services/TaskViewerProvider.ts` (extension host callback wiring), `src/standalone/bootstrap.ts` (standalone host callback wiring + handleTurnEndNotify extraction), `src/services/PlanIngestionEngine.ts` (mtime-based watcher + sweep completion detection removed), and 4 test files updated/extended. One issue: intern accidentally edited 3 plan files under .switchboard/plans/ (accuracy protocol side effect) — restored before commit, no data loss. No reviewer seat on team; card stays in CODER CODED.


## Review Findings

Reviewed all 5 subtasks in place; 1 CRITICAL and 3 MAJOR findings fixed. Files changed: `src/services/LocalApiServer.ts` (completion callbacks gated on `outcome === 'finished'` — a `failed` report was notifying the lead "finished" and mirroring a `kind: finished` orchestrator report while the escalation ladder re-staged the card; release-arm skipped on the team-in-flight 409 so a coder's POST no longer rebinds the workspace queue watch to itself), `src/services/TaskViewerProvider.ts` + `src/standalone/bootstrap.ts` (board refresh restored on the completion callback — the retired watcher cleared and fired `planDiscovered` in one tick, so without it the card kept a lit activity light), `src/services/PlanIngestionEngine.ts`/`src/extension.ts`/`bootstrap.ts` (docblocks corrected: the `setOnWorkingStateCleared` seam and the engine's `completed` arm are now dormant), plus `src/test/queue-pipeline-contract.test.js` (+2 tests) and `src/test/terminal-plan-attribution-contract.test.js` (3 stale mtime contract tests migrated to the new API contract — they were left RED by subtask 4 and are CI-wired). Validation: `npm run compile-tests` clean, eslint 0 errors, all 7 CI-wired gates for this work green (queue-pipeline, stage-marker-commit 70/70, terminal-plan-attribution 41/41, reviewer-prompt, reviewer-prompt-behaviour 68/68, orchestrator-tick) plus catalog/parity/standalone-parity/push-routing/verb-returns/mirror ratchets; two `seat-safeguards` `_dispatchExecuteMessage` call-site ratchets fail identically at the pre-feature commit `f9988585` (pre-existing red), and orchestrator-tick's launcher-path check fails on an uncommitted `.agents/workflows/switchboard.md` edit belonging to other in-flight work. Remaining risk: `POST /kanban/queue/done` is release-**and-pop**, so every seat now carrying the directive (board dispatches, reviewers, head-paced team coders) answers a normal completion with a 409 `success:false` "Team already in flight" body, and a card the head moved out of its coding column before the coder posts would let that pop dispatch a staged card without the head — worth a follow-up decision on skipping the pop for head-paced team members. Second risk: with the mtime arm gone the silence sweep can stamp a finished-but-quiet seat `blocked` before its POST lands, yielding a false blocked notice followed by the real completed one.
