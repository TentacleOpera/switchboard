# Replace mtime-based completion with explicit API POST

**Complexity:** 5

## Goal

Replace the unreliable mtime-based plan-file completion detection with explicit POST /kanban/queue/done for team coders, reviewers, and orchestrators. Adds the queue/done instruction to team coder standing orders, updates all completion directives to reference the API POST, wires completion callbacks into _runQueueDone, removes the mtime-based watcher and sweep detection, and updates/adds tests.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add queue/done instruction to team coder standing orders](../plans/add-queue-done-instruction-to-team-coder-standing-orders.md) — **CODE REVIEWED** — ID: 14648a04-d9ae-4a6f-9832-31e9acea8992
- [ ] [Remove mtime-based completion detection](../plans/remove-mtime-based-completion-detection.md) — **CODE REVIEWED** — ID: d9b07f12-06b3-4001-a023-3369e8e98447
- [ ] [Update all completion directives to reference the API POST](../plans/update-completion-directives-to-reference-api-post.md) — **CODE REVIEWED** — ID: 51ed91ad-b396-4d30-aec4-7bcb794a907c
- [ ] [Update and add tests for API-based completion](../plans/update-and-add-tests-for-api-completion.md) — **CODE REVIEWED** — ID: 35526218-8107-4490-a518-39f403d51e34
- [ ] [Wire completion callbacks into the _runQueueDone path](../plans/wire-completion-callbacks-into-runqueue-done.md) — **CODE REVIEWED** — ID: 2f28b86b-b9d6-4c4a-ae08-8574e75f818e
<!-- END SUBTASKS -->

## Completion Report

All 5 subtasks implemented and committed across 3 team seats (coder-1, coder-2, intern). Files changed: `src/services/teamWiring.ts` (TEAM_CODER_QUEUE_DONE_INSTRUCTION constant + migration rewriter), `src/webview/terminals.js` (mirror), `src/services/agentPromptBuilder.ts` (5 directive text blocks updated to reference POST /kanban/queue/done), `src/services/LocalApiServer.ts` (onWorkingStateCleared + onTurnEndNotify callbacks in _runQueueDone), `src/services/TaskViewerProvider.ts` (extension host callback wiring), `src/standalone/bootstrap.ts` (standalone host callback wiring + handleTurnEndNotify extraction), `src/services/PlanIngestionEngine.ts` (mtime-based watcher + sweep completion detection removed), and 4 test files updated/extended. One issue: intern accidentally edited 3 plan files under .switchboard/plans/ (accuracy protocol side effect) — restored before commit, no data loss. No reviewer seat on team; card stays in CODER CODED.

## Review Findings

Reviewed all 5 subtasks in place; 1 CRITICAL and 3 MAJOR findings fixed. Files changed: `src/services/LocalApiServer.ts` (completion callbacks gated on `outcome === 'finished'` — a `failed` report was notifying the lead "finished" and mirroring a `kind: finished` orchestrator report while the escalation ladder re-staged the card; release-arm skipped on the team-in-flight 409 so a coder's POST no longer rebinds the workspace queue watch to itself), `src/services/TaskViewerProvider.ts` + `src/standalone/bootstrap.ts` (board refresh restored on the completion callback — the retired watcher cleared and fired `planDiscovered` in one tick, so without it the card kept a lit activity light), `src/services/PlanIngestionEngine.ts`/`src/extension.ts`/`bootstrap.ts` (docblocks corrected: the `setOnWorkingStateCleared` seam and the engine's `completed` arm are now dormant), plus `src/test/queue-pipeline-contract.test.js` (+2 tests) and `src/test/terminal-plan-attribution-contract.test.js` (3 stale mtime contract tests migrated to the new API contract — they were left RED by subtask 4 and are CI-wired). Validation: `npm run compile-tests` clean, eslint 0 errors, all 7 CI-wired gates for this work green (queue-pipeline, stage-marker-commit 70/70, terminal-plan-attribution 41/41, reviewer-prompt, reviewer-prompt-behaviour 68/68, orchestrator-tick) plus catalog/parity/standalone-parity/push-routing/verb-returns/mirror ratchets; two `seat-safeguards` `_dispatchExecuteMessage` call-site ratchets fail identically at the pre-feature commit `f9988585` (pre-existing red), and orchestrator-tick's launcher-path check fails on an uncommitted `.agents/workflows/switchboard.md` edit belonging to other in-flight work. Remaining risk: `POST /kanban/queue/done` is release-**and-pop**, so every seat now carrying the directive (board dispatches, reviewers, head-paced team coders) answers a normal completion with a 409 `success:false` "Team already in flight" body, and a card the head moved out of its coding column before the coder posts would let that pop dispatch a staged card without the head — worth a follow-up decision on skipping the pop for head-paced team members. Second risk: with the mtime arm gone the silence sweep can stamp a finished-but-quiet seat `blocked` before its POST lands, yielding a false blocked notice followed by the real completed one.

## Design notes — carried from the source plan

Preserved verbatim from `.switchboard/plans/replace-mtime-completion-with-explicit-api-post.md`, the single plan this feature was decomposed from (its Parts 1–5 are the five subtasks). These two sections had no home in any subtask; the source plan is retired now that the work has shipped. Where implementation or review moved something, a **Since implementation** line follows the original text — the original is left unedited.

### What does NOT change

- **`POST /kanban/queue/done` endpoint** — the endpoint itself is unchanged. It already calls `clearWorkingState`, handles duplicates, and pops the next card. The only addition is firing the two new callbacks.
  - **Since implementation:** the pop is the one loose end. For a head-paced team member the pop is refused by that member's own just-finished card (still in its coding column with `dispatched_terminal` set), so a normal completion answers `409 {success:false, "Team already in flight"}` with the release metadata merged in; a retry answers `200 reason:"duplicate"` and the callbacks do not re-fire, so the state converges. Cosmetic, not corrupting. The theoretical "pop dispatches a staged card without the head" case requires the card to leave its coding column mid-turn, which only happens if a team moves its own card — already forbidden by the contracts — so it is a symptom of that violation, not a defect of this path. **Standing design position: completion must never be measured off card status.** A card's column advances when work *starts* and never when it finishes, so column state cannot answer "is this seat done" — that is the whole reason this feature exists, and the same reasoning applies to any future guard tempted to read it. A better fix than gating the pop is planned; nothing further is to be done here in the meantime.
- **Seat-paced teams** — `SEAT_QUEUE_DONE_ORDER_BODY` is unchanged. Seat-paced teams already POST when done.
- **Standalone coders** — `GLOBAL_QUEUE_DONE_ORDER_BODY` is unchanged. Standalone coders already POST when done.
- **File-based team queue** — `POST /terminals/teams/<groupId>/queue/done` is unchanged. It already relays to the lead.
- **`clearStaleWorkingState` (timeout sweep)** — remains as the fallback for when a coder never calls the API.
- **The silence/blocked detection** — the sweep's `else if (!record.blockedAt)` arm (silence → blocked) is unchanged. A coder that goes silent without posting is still marked blocked.
  - **Since implementation:** the `else` is gone with the mtime arm, and the blocked stamp now holds one tick (`PlanIngestionEngine._blockedCandidates`). Silence is measured on PTY output, not progress, so a seat that finished and went quiet before its POST landed would otherwise be reported to its lead as having stalled. The first silent tick records a candidate; only the second consecutive one stamps. Delays a genuine blocked notice by one scan interval (~10s against a 90s threshold); can never fabricate one.
- **`ensureCompletionDirective` sentinel** — stays `'COMPLETION REPORT:'`. The idempotent guard is unchanged.
- **`AGENT_GROUP_CALLBACK_INSTRUCTION`** — the "report to head" instruction stays in the team prompt. It's the fallback for when the API call fails (the coder reports to the head directly via ptySendPrompt). The queue/done instruction is appended alongside it, not replacing it.
- **Per-dispatch GIT POLICY block** — `buildGitPolicyBlock` continues to compose branch/commit/push/safety per-dispatch. Unchanged.
- **`seatBlock: false` on turn-end notifications** — unchanged. A machine notice has no task to constrain.
- **`clearBeforePrompt: false` on turn-end notifications** — unchanged. Never wipe the recipient's context.

### Edge cases

- **Coder can't reach the API (server not running):** The `AGENT_GROUP_CALLBACK_INSTRUCTION` is the fallback — the coder reports to the head directly via `POST /terminals/verb/ptySendPrompt`. The head receives the report and can act on it. The timeout sweep (`clearStaleWorkingState`) clears the working state after 20 minutes if no API call is made.
- **Coder posts prematurely (after finishing one part, not all):** The standing order and directive both say "Do NOT post after finishing individual parts — only when ALL work is complete." This is the same LLM-compliance risk as any instruction, but the explicit API call is a more deliberate action than a file edit — the coder has to construct and send a curl command, which is harder to do accidentally than editing a file. The premature-post risk is lower than the premature-mtime risk.
- **Duplicate posts (network retry):** The `clearWorkingState` `IS NOT NULL` gate makes the second post a no-op (returns `transitioned = false`). The callbacks only fire on `transitioned = true`, so no double-notification.
- **File watcher still fires on plan file edits:** The watcher still updates plan metadata, feature links, and ClickUp sync. It just no longer calls `clearWorkingState` or fires the turn-end notifier. A plan file edit while dispatched is logged but does not trigger completion.
- **Custom-prompt teams:** When the caller supplies a custom `prompt` to `wireSpawnedTeam`, the queue/done instruction is NOT appended to the standing order (the caller's text wins). But the `CODING_COMPLETION_REPORT_DIRECTIVE` (updated in Part 2) is still appended per-dispatch via `ensureCompletionDirective`, so even custom-prompt teams get the API instruction on every dispatch.
- **Reviewer and tester roles:** The `CODING_COMPLETION_REPORT_DIRECTIVE` is appended to all code-touching roles via `ensureCompletionDirective`. Reviewers and testers will also be told to POST when done. This is correct — their completion should also be explicit, not mtime-based.
- **Standalone host (bootstrap.ts):** The standalone host has its own turn-end notifier callback. The new `onTurnEndNotify` callback on `LocalApiServer` needs to be wired in the standalone host too, using the standalone `deliverPrompt` pattern.
- **`terminals.js` mirror synchronization:** The standing-orders rewriter mirror in `terminals.js` must be updated alongside `teamWiring.ts`. The `stage-marker-commit-contract.test.js` enforces byte-identity — a missed mirror breaks the test and ships divergent delivery between host and webview.

### Dependencies

None — this plan is self-contained. No other plan or session is a prerequisite.
