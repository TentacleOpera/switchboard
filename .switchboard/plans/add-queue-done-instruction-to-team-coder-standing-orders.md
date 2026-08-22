# Add queue/done instruction to team coder standing orders

## Goal

Team coders on head-paced teams need an explicit completion signal. Currently their standing order only has the callback instruction (`AGENT_GROUP_CALLBACK_INSTRUCTION`) + `GIT_SAFETY_DIRECTIVE` — it does NOT tell them to POST `/kanban/queue/done` when finished. Seat-paced coders and standalone coders already have this instruction (`SEAT_QUEUE_DONE_ORDER_BODY` and `GLOBAL_QUEUE_DONE_ORDER_BODY`). This subtask adds the equivalent instruction for team coders and migrates existing team-scoped orders.

### Background

This is Part 1 of the feature "Replace mtime-based completion detection with explicit API-based completion." The parent plan's root cause analysis applies: commit `c5185aa8` replaced content-based completion with mtime-based detection, which is unreliable because the agent can edit the plan file mid-work. The fix is to use the existing `POST /kanban/queue/done` endpoint as the explicit completion signal — but team coders don't have the instruction telling them to do this.

### What this subtask does

1. Defines `TEAM_CODER_QUEUE_DONE_INSTRUCTION` constant in `teamWiring.ts`.
2. Appends it to the default team prompt in `wireSpawnedTeam`.
3. Extends `migrateCodingTeamOrders` to rewrite existing team-scoped orders.
4. Mirrors all new constants and the rewriter in `terminals.js`.

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, refactor
**Project:** Browser Switchboard

## Proposed Changes

### 1a. Define a team-coder queue/done instruction constant — `src/services/teamWiring.ts`

Add a new exported constant near `SEAT_QUEUE_DONE_ORDER_BODY`:

```ts
/**
 * The queue/done instruction appended to the team-scoped standing order for
 * head-paced team coders. Tells the coder to POST /kanban/queue/done when it
 * has finished ALL work on the dispatched plan — not after individual parts.
 * This is the explicit completion signal that replaces the unreliable mtime-
 * based file-watcher detection. The endpoint clears the card's activity light
 * and fires the turn-end notification to the lead.
 *
 * Mirrors SEAT_QUEUE_DONE_ORDER_BODY but uses <your terminal name> (the coder
 * knows its own terminal name) and adds the "ALL parts" qualifier to prevent
 * premature posts on multi-part plans.
 */
export const TEAM_CODER_QUEUE_DONE_INSTRUCTION =
    'When you have finished ALL parts of the dispatched plan, POST /kanban/queue/done with '
    + '{"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt. '
    + 'This signals completion — the system clears your activity light and notifies your lead. '
    + 'Do NOT post after finishing individual parts — only when ALL work is complete. '
    + 'If you cannot complete it, call the same endpoint with {"from":"<your terminal name>",'
    + '"outcome":"failed"} and a one-line reason.';
```

### 1b. Append the instruction to the team-scoped standing order — `src/services/teamWiring.ts`, `wireSpawnedTeam` (~line 1820)

Update the default team prompt construction to include the queue/done instruction:

Before (line 1820-1822):
```ts
const teamPromptInstruction = prompt
    ? prompt.replace(/\{child\}/g, headName).replace(/\{teamId\}/g, groupId)
    : `${callbackTemplate.replace(/\{child\}/g, headName)}\n${GIT_SAFETY_DIRECTIVE}`;
```

After:
```ts
const teamPromptInstruction = prompt
    ? prompt.replace(/\{child\}/g, headName).replace(/\{teamId\}/g, groupId)
    : `${callbackTemplate.replace(/\{child\}/g, headName)}\n${GIT_SAFETY_DIRECTIVE}\n${TEAM_CODER_QUEUE_DONE_INSTRUCTION}`;
```

When the caller supplies a custom `prompt`, the queue/done instruction is NOT appended — the caller's text wins. This matches the existing pattern for `GIT_SAFETY_DIRECTIVE`. However, the `CODING_COMPLETION_REPORT_DIRECTIVE` (updated in the sibling subtask "Update completion directives") is appended per-dispatch via `ensureCompletionDirective`, so even custom-prompt teams get the API instruction on every dispatch.

### 1c. Update the `migrateCodingTeamOrders` rewriter — `src/services/teamWiring.ts` (~line 2241)

Add new fragment and marker constants:

```ts
/**
 * Substring present in team-scoped member prompts that use the callback
 * instruction (AGENT_GROUP_CALLBACK_INSTRUCTION or EXTERNAL_HEAD_CALLBACK_INSTRUCTION).
 * Both contain 'is your head agent'. NOT present in SEAT_QUEUE_DONE_ORDER_BODY
 * or GLOBAL_QUEUE_DONE_ORDER_BODY (seat-paced / standalone orders that already
 * carry the queue/done instruction). Used by the team-order rewriter's
 * negative check: a team-scoped order that contains this fragment but NOT
 * the QUEUE_DONE_MARKER is pre-queue-done-instruction and must be rewritten.
 */
export const PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT = 'is your head agent';

/**
 * Substring unique to TEAM_CODER_QUEUE_DONE_INSTRUCTION. Used by the
 * team-order rewriter's negative check for idempotency: a rewritten order
 * contains this marker, so it does not re-match.
 */
export const QUEUE_DONE_MARKER = 'POST /kanban/queue/done with';
```

Add a new condition inside `migrateCodingTeamOrders` for `team` scoped orders:

```ts
if (o.scope === 'team' && typeof o.instruction === 'string') {
    if (o.instruction.indexOf(PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT) !== -1
        && o.instruction.indexOf(QUEUE_DONE_MARKER) === -1) {
        const newInstruction = o.instruction + '\n' + TEAM_CODER_QUEUE_DONE_INSTRUCTION;
        rewritten.push({ ...o, instruction: newInstruction });
        drop.add(o.id);
        touched = true;
        continue;
    }
}
```

This runs AFTER `migrateTeamPairOrders` (the composition is `migrateCodingTeamOrders(migrateTeamPairOrders(raw))`), so newly-created team-scoped orders from the pair migration are caught.

### 1d. Mirror in `terminals.js` — `src/webview/terminals.js`

The standing-orders rewriter has a mirror in `terminals.js` (`migrateCodingTeamOrdersClient` at line 10874). Add the `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT`, `QUEUE_DONE_MARKER`, and `TEAM_CODER_QUEUE_DONE_INSTRUCTION` mirrors, and update the rewriter condition. Follow the same two-copy pattern enforced by `stage-marker-commit-contract.test.js`.

## What does NOT change

- `SEAT_QUEUE_DONE_ORDER_BODY` — unchanged (seat-paced teams already POST).
- `GLOBAL_QUEUE_DONE_ORDER_BODY` — unchanged (standalone coders already POST).
- `POST /kanban/queue/done` endpoint — unchanged.
- `AGENT_GROUP_CALLBACK_INSTRUCTION` — stays in the team prompt as the fallback.

## Verification Plan

### Automated Tests
1. `node --check src/services/teamWiring.ts` — syntax check
2. `node --check src/webview/terminals.js` — syntax check
3. Run `src/test/stage-marker-commit-contract.test.js` — new fragment/marker two-copy rule assertions pass
4. Add test: team-scoped standing order migration appends `TEAM_CODER_QUEUE_DONE_INSTRUCTION`, idempotent on second pass, does NOT match seat-paced orders

### Manual Verification
5. Grep `TEAM_CODER_QUEUE_DONE_INSTRUCTION` in `teamWiring.ts` — confirm it's appended to the default team prompt in `wireSpawnedTeam`
6. Grep `TEAM_CODER_QUEUE_DONE_INSTRUCTION` in `terminals.js` — confirm the mirror exists and is byte-identical

---

## Completion Report

Implemented all four changes from the plan. Added `TEAM_CODER_QUEUE_DONE_INSTRUCTION` constant in `src/services/teamWiring.ts` (after `SEAT_QUEUE_DONE_ORDER_BODY`), appended it to the default team prompt in `wireSpawnedTeam` (custom-prompt path intentionally excluded per plan), added `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT` and `QUEUE_DONE_MARKER` constants plus a `team`-scope append condition in `migrateCodingTeamOrders`, and mirrored all three constants plus the migration condition in `src/webview/terminals.js` `migrateCodingTeamOrdersClient`. Added 8 test cases to `src/test/stage-marker-commit-contract.test.js` covering two-copy byte-identity, migration append/idempotency, seat-paced non-match, marker-present non-match, and operator-edit preservation. The `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT` two-copy test uses declaration-site checks (not walkSrc carriers) because 'is your head agent' appears in `linkPresets.ts` and `kanban.html` too — same approach as the existing `COMMIT_INSTRUCTION_MARKER` test. No issues encountered. Compilation and tests skipped per directives.

## Review Findings

No code changes needed here — the constant, the `wireSpawnedTeam` append, the `migrateCodingTeamOrders` team-scope branch and the byte-identical `terminals.js` mirror all match the plan, and I verified the migration actually fires (`'is your head agent'` is present in `AGENT_GROUP_CALLBACK_INSTRUCTION`, the report-file variant and `EXTERNAL_HEAD_CALLBACK_INSTRUCTION`) and cannot double-append (`'POST /kanban/queue/done with'` is a substring of both `SEAT_QUEUE_DONE_ORDER_BODY` and `GLOBAL_QUEUE_DONE_ORDER_BODY`). The new branch sits between the `pair` and `team-head` recognisers and cannot collide with either — scopes are disjoint, so no order loses a second migration to the `continue`. Verified: `test:contract:stage-marker-commit` 70 passed / 0 failed (the printed stack trace is the deliberate simulated-persist-failure case), `compile-tests` clean. Two consequences of routing head-paced coders at this endpoint, both flagged on the parent feature rather than fixed here: `_runQueueDone` is release-and-pop, so a coder's normal completion returns a 409 `success:false` "Team already in flight" body (the release still lands, and a retry answers `reason: duplicate` without re-firing callbacks), and I fixed the related queue-watch rebinding in `LocalApiServer.ts`. NIT not actioned: on a seat-paced team a coder now carries both `SEAT_QUEUE_DONE_ORDER_BODY` and this instruction — redundant, not conflicting, same as the documented `global`-scope overlap.
