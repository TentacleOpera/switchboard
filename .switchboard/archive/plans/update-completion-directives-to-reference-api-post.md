# Update all completion directives to reference the API POST

## Goal

All completion directives in `agentPromptBuilder.ts` currently tell agents to append a summary to the plan file as the completion signal (the mtime-based mechanism). This subtask changes every directive that carries the `COMPLETION REPORT:` sentinel to tell agents to POST `/kanban/queue/done` as the primary completion signal, keeping the plan-file summary as a secondary "for the record" step.

### Background

This is Part 2 of the feature "Replace mtime-based completion detection with explicit API-based completion." The directives affected are:
- `CODING_COMPLETION_REPORT_DIRECTIVE` — the per-dispatch completion handshake for coders
- `COMPLETION_STEP_FULL` and `COMPLETION_STEP_COMPACT` — the reviewer completion steps
- `ORCHESTRATOR_REPORT_DIRECTIVE` — references "the plan-file completion report"
- `STAGGERED_IMPLEMENTATION_DIRECTIVE` — references "the per-plan completion report"

If these directives are not updated, agents will think the file edit is the completion signal and skip the POST — recreating the exact bug this feature fixes.

### What this subtask does

Updates 6 directive text blocks and their associated comments in `agentPromptBuilder.ts`. The sentinel `'COMPLETION REPORT:'` stays unchanged so `ensureCompletionDirective`'s idempotent guard still works.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, refactor
**Project:** Browser Switchboard

## Proposed Changes

### 2a. Change the `CODING_COMPLETION_REPORT_DIRECTIVE` text — `src/services/agentPromptBuilder.ts` (~line 996)

Before:
```ts
export const CODING_COMPLETION_REPORT_DIRECTIVE = `COMPLETION REPORT: When you have finished implementing the plan, append a brief summary (3-5 sentences) to the END of the original plan file. Include: what you implemented, files changed, and any issues encountered. This edit signals task completion to the kanban board — the file watcher detects it and clears the card's working-state light. Do NOT skip this step.`;
```

After:
```ts
export const CODING_COMPLETION_REPORT_DIRECTIVE = `COMPLETION REPORT: When you have finished implementing ALL parts of the plan, POST /kanban/queue/done with {"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt. This signals task completion to the kanban board — the system clears your card's activity light and notifies your lead. Do NOT post after finishing individual parts — only when ALL work is complete. Also append a brief summary (3-5 sentences) to the END of the original plan file for the record. Do NOT skip the POST.`;
```

The plan-file summary is kept as a secondary "for the record" step — the POST is the completion signal, not the file edit. The sentinel for `ensureCompletionDirective` stays `'COMPLETION REPORT:'` (unchanged), so the idempotent guard still works.

### 2b. Update the load-bearing comment — `src/services/agentPromptBuilder.ts` (~lines 985-995)

```ts
// CODING_COMPLETION_REPORT_DIRECTIVE is the completion-protocol handshake. It
// tells the dispatched agent to POST /kanban/queue/done when ALL work is complete.
// The API endpoint calls clearWorkingState (activity-light off-switch) and fires
// the turn-end notification to the lead. The autoban wake and the switchboard-manage
// skill's Column Oversight pass depend on this handshake. The directive is
// deliberately NON-overridable for code-touching roles: ensureCompletionDirective()
// re-appends it idempotently AFTER any defaultPromptOverride is applied, so a `replace`-
// mode role override cannot silently drop the handshake and leave cards stuck on. Do NOT
// treat this as prose, move it before the override application, or remove the post-override
// placement — the consumers above will break silently (cards never clear, oversight
// passes time out on work that succeeded).
```

### 2c. Verify `ensureCompletionDirective` — `src/services/agentPromptBuilder.ts` (~line 1061)

The sentinel check stays `'COMPLETION REPORT:'` — no change needed to the function itself. But verify the tests that check for this sentinel still pass.

### 2d. Update `COMPLETION_STEP_FULL` and `COMPLETION_STEP_COMPACT` — `src/services/agentPromptBuilder.ts` (~lines 1049, 1051)

These are the REVIEWER completion steps (used at line 1868 in the reviewer steps array). Both say "the file watcher detects it and clears the card's working-state light." Removing the mtime watcher (sibling subtask "Remove mtime-based completion detection") without updating these breaks reviewer completion.

Before:
```ts
export const COMPLETION_STEP_FULL = `COMPLETION REPORT: Update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps. This edit signals task completion to the kanban board — the file watcher detects it and clears the card's working-state light. Do NOT skip this step.`;

export const COMPLETION_STEP_COMPACT = `COMPLETION REPORT: Update the original plan file by appending a brief summary (≤ 5 sentences) under \`## Review Findings\` — list files changed, validation results, and remaining risks. Do NOT reproduce the full implementation steps or copy large blocks of the original plan. This edit signals task completion to the kanban board — the file watcher detects it and clears the card's working-state light. Do NOT skip this step.`;
```

After:
```ts
export const COMPLETION_STEP_FULL = `COMPLETION REPORT: When you have finished ALL parts of the review, POST /kanban/queue/done with {"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt. This signals task completion to the kanban board — the system clears your card's activity light and notifies your lead. Do NOT post after finishing individual parts — only when ALL work is complete. Also update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps. Do NOT skip the POST.`;

export const COMPLETION_STEP_COMPACT = `COMPLETION REPORT: When you have finished ALL parts of the review, POST /kanban/queue/done with {"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt. This signals task completion to the kanban board — the system clears your card's activity light and notifies your lead. Do NOT post after finishing individual parts — only when ALL work is complete. Also update the original plan file by appending a brief summary (≤ 5 sentences) under \`## Review Findings\` — list files changed, validation results, and remaining risks. Do NOT reproduce the full implementation steps or copy large blocks of the original plan. Do NOT skip the POST.`;
```

The sentinel `'COMPLETION REPORT:'` is unchanged — `ensureCompletionDirective` still works.

### 2e. Update `ORCHESTRATOR_REPORT_DIRECTIVE` — `src/services/agentPromptBuilder.ts` (~lines 1068-1083)

Before (line 1083):
```ts
This is IN ADDITION TO, never INSTEAD OF, the plan-file completion report — the completion report stays in the plan file. Do NOT skip the completion report.
```

After:
```ts
This is IN ADDITION TO, never INSTEAD OF, the completion POST (POST /kanban/queue/done) — the completion POST is the signal that clears your card. Do NOT skip the completion POST.
```

Also update the comment above the directive (lines 1068-1074) to reflect the new mechanism.

### 2f. Update `STAGGERED_IMPLEMENTATION_DIRECTIVE` — `src/services/agentPromptBuilder.ts` (~line 984)

Before:
```ts
This is in addition to the per-plan completion report (which still goes to each subtask's own plan file); do not skip either. Do NOT skip this step.
```

After:
```ts
This is in addition to the per-plan completion POST (POST /kanban/queue/done, which signals task completion to the kanban board); do not skip either. Do NOT skip this step.
```

## What does NOT change

- `ensureCompletionDirective` sentinel — stays `'COMPLETION REPORT:'`.
- `NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE` — references "per the COMPLETION REPORT step" (sentinel unchanged, still works).
- The reviewer steps array composition at line 1868 — unchanged (it composes the updated directives).

## Verification Plan

### Automated Tests
1. `node --check src/services/agentPromptBuilder.ts` — syntax check
2. Run `src/test/seat-safeguards-fleet-prompt-path.test.js` — updated directive assertions pass (sentinel unchanged, body text updated)
3. Run `src/test/orchestrator-tick-and-reports-contract.test.js` — updated directive assertions pass
4. Run `src/test/autoban-reviewer-prompt-regression.test.js` — updated directive assertions pass
5. Add test: `COMPLETION_STEP_FULL` and `COMPLETION_STEP_COMPACT` contain "POST /kanban/queue/done" and do NOT contain "the file watcher detects it"
6. Add test: `ORCHESTRATOR_REPORT_DIRECTIVE` references "the completion POST" and does NOT say "the plan-file completion report"

### Manual Verification
7. Grep `CODING_COMPLETION_REPORT_DIRECTIVE` in `agentPromptBuilder.ts` — confirm the directive text says "POST /kanban/queue/done" and "Do NOT post after finishing individual parts"
8. Grep `COMPLETION_STEP_FULL` and `COMPLETION_STEP_COMPACT` in `agentPromptBuilder.ts` — confirm both say "POST /kanban/queue/done" and do NOT say "the file watcher detects it"
9. Grep `ORCHESTRATOR_REPORT_DIRECTIVE` in `agentPromptBuilder.ts` — confirm it references "the completion POST" and does NOT say "the plan-file completion report"

## Completion Report

Updated all completion directives (`CODING_COMPLETION_REPORT_DIRECTIVE`, `COMPLETION_STEP_FULL`, `COMPLETION_STEP_COMPACT`, `ORCHESTRATOR_REPORT_DIRECTIVE`, `STAGGERED_IMPLEMENTATION_DIRECTIVE`) and their doc comments in `src/services/agentPromptBuilder.ts` to instruct agents to POST `/kanban/queue/done` for completion signaling while preserving the `COMPLETION REPORT:` sentinel and plan-file summary for records. Added unit test coverage in `src/services/__tests__/agentPromptBuilder.test.ts` verifying all directives reference the API POST and contain no legacy file-watcher detection phrasing. Files modified: `src/services/agentPromptBuilder.ts`, `src/services/__tests__/agentPromptBuilder.test.ts`, and `.switchboard/plans/update-completion-directives-to-reference-api-post.md`. No issues encountered during implementation.

## Review Findings

All six directive blocks and their load-bearing comments match the plan text, the `'COMPLETION REPORT:'` sentinel is intact so `ensureCompletionDirective` stays idempotent, and the new `agentPromptBuilder.test.ts` case pins both the POST reference and the absence of the old file-watcher phrasing. No code changes required. Verified: `compile-tests` clean, `test:contract:reviewer-prompt-behaviour` 68 passing, `test:contract:seat-safeguards` directive assertions green (its 2 failures are pre-existing `_dispatchExecuteMessage` call-site ratchets, identical at the pre-feature commit `f9988585` and untouched by this work), `test:contract:reviewer-prompt` and `test:contract:orchestrator-tick` directive checks green. Remaining risk: `CODING_COMPLETION_REPORT_DIRECTIVE` is appended to every code-touching dispatch, so plain board dispatches and reviewers now also POST to a release-**and-pop** endpoint — the pop is refused for a team still holding a coding card, but a card moved out of its coding column first would let it dispatch a staged card unattended; carried on the parent feature as a follow-up decision. One stale claim worth noting: the directive comment credits "the autoban wake", but `handleAutobanTurnEnd` is a no-op in both hosts, so the lead notification is the only live consumer.
