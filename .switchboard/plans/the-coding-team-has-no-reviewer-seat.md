# The coding team has no reviewer seat

## Goal

Remove the reviewer from the coding team's operating model. The lead's job for a subtask
ends when it commits and posts `/kanban/task/complete`; it never hands work to a reviewer
and never moves a card. Delete the one card-movement exception the reviewer seat exists to
justify.

### Problem Analysis

`teamWiring.ts:904` records the current rule:

> Never move a card to a new column yourself — with ONE named exception: the POST
> `/kanban/dispatch` call, and only when the team has a reviewer seat.

The docblock goes on to explain why the exception had to be spelled out: the payload
carries `targetColumn`, so an absolute prohibition read as "do not make that call" and
leads stopped dispatching for review entirely.

That exception is the only reason a coding card ever leaves a coding column while its team
is working it, and a card leaving a coding column releases the team (see the sibling
subtask). The lead then pulls its next subtask and starts coding while the reviewer is
still reading the previous one — two agents editing the same worktree, landing in the same
commit.

It also gives the lead **two different endings** for a subtask: post completion, or hand it
to the reviewer. Two endings is why neither is reliably taken, and why the completion post
is skipped in practice.

Review is not lost. It moves to the standalone Review team
(`OFFERED_REVIEW_TEAM_GROUP`, `teamWiring.ts:676`) and board-level reviewer dispatch, both
unchanged by this plan.

### Release Status

Spawned teams have never been in a released version. `NEW_CODING_HEAD_PROMPT` is
unreleased dev state and takes a clean break: edit in place, no frozen snapshot, no
recogniser, no migration arm. A dev install carrying a stale persisted group keeps its
stale prompt until the team is recreated.

Do not read the fifteen `OLD_` / `PRE_` / `CURRENT_BUGGY_` prompt constants in
`teamWiring.ts` as evidence to the contrary — they are dev-churn residue for this same
unreleased surface, and a sibling subtask deletes them.

## Metadata

**Tags:** backend, agents, reliability

**Complexity:** 4

## User Review Required

None. Review relocating to the standalone Review team is settled; a reviewer seat placed on
a coding team is ignored, not rejected.

## Complexity Audit

### Routine

- Delete seven lines from one string constant.
- Update the matching client copy.

### Complex / Risky

- The constant is the lead's entire operating contract. Removing the handoff without
  stating the replacement ending leaves a lead with no defined way to finish a subtask.
- `src/webview/terminals.js:11050` carries a duplicated copy. Editing one side hands the
  extension and the browser different orders — a text split, silent, with every gate green.

## Edge-Case & Dependency Audit

### Race Conditions

None. This subtask changes prompt text only; no runtime ordering is affected.

### Security

- `targetColumn` leaves the lead's vocabulary but stays on the endpoint for Mission
  Control and operator use. No endpoint is narrowed, so no caller is broken.

### Side Effects

- An operator may still place a reviewer seat on a coding team. It receives no work from
  that lead. Validating roster composition would be a new guard on operator configuration
  and is out of scope.
- Leads that previously ended a feature by dispatching for review now end it by posting
  completion for each subtask — already the mandatory path.

### Dependencies & Conflicts

- Touches the same two files as the compat-machinery deletion subtask, which must follow
  this one.
- Independent of the release-contract subtask (different files); the two may run
  concurrently on separate seats.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) a prompt that removes the handoff and forgets to state the replacement —
a lead with no reviewer path and no explicit "commit, then post" ending simply stops, or
invents a card move; (2) the planId silently staying as the FEATURE planId, which
deadlocks the team after the sibling subtask removes the column check; (3) the two-copy
sync drifting because the contract test is RED AT HEAD. Mitigations: the rewrite states
exactly one ending with the subtask planId (called out explicitly above); the byte-identical
test gates both copies, with pre-change failure output recorded for diff comparison.

## Proposed Changes

### 1. `src/services/teamWiring.ts:920-964` — rewrite `NEW_CODING_HEAD_PROMPT`

Remove:

- the roster check for a seat with role `"reviewer"`;
- the `POST /kanban/dispatch` call with `targetColumn: "CODE REVIEWED"`;
- the "if your team has NO reviewer seat, do NOT move the card" branch;
- the `queue/next`-after-the-reviewer-reports instruction.

State one ending: finish the subtask, commit, POST `/kanban/task/complete` with that
**subtask's** planId (not the FEATURE planId — see the Critical planId change below), then
POST `/kanban/queue/next` with `{"from":"{head}"}` to ask for the next card. Make card
movement unconditional — no exception to name.

**Critical planId change — load-bearing for the sibling release-contract subtask.** The
current prompt posts `task/complete` with `"<the FEATURE planId>"`. That sets
`completed_at` on the FEATURE row, not the subtask row. Today the column check in the
in-flight predicate masks this — a card leaving the coding column releases the team
regardless of which row got `completed_at`. But the sibling subtask (*A queued card has no
holder*) removes the column check, making `completed_at` the sole release signal. After
that change, `completed_at` on the FEATURE row does NOT release the team — the in-flight
predicate checks the SUBTASK card (the row with `dispatchedTerminal` set), and its
`completed_at` is still NULL. The team stays held forever. Posting the **subtask's**
planId sets `completed_at` on the subtask row, which IS the row the in-flight predicate
checks. This is not a stylistic rewrite — it is the fix that makes the sibling subtask's
release contract work.

**Shift from "post once" to "post per subtask".** The current prompt tells the lead to
post completion once, after every subtask is finished. The new prompt tells the lead to
post completion after each individual subtask. This is necessary: the release contract
releases the team per subtask (so the lead can pull the next one), not per feature.

Update the docblock at `:895-918` so it describes the rule that now exists. **Preserve the
lesson** about why exceptions must be named explicitly: the payload carries `targetColumn`,
so an absolute prohibition reads as "do not make that call." That lesson outlives the
exception — if a future change adds a new card-movement exception, the docblock is the
guidance. Remove the exception itself; keep the reasoning.

### 2. `src/webview/terminals.js:11050` — client copy

Replace `NEW_CODING_HEAD_PROMPT_CLIENT` with the same text. This is a duplicated literal,
not a migration.

### 3. Tests

- The live coding head prompt contains no `targetColumn` and no `"reviewer"` roster check.
- The `teamWiring.ts` and `terminals.js` copies are byte-identical.
- The prompt states the completion post with the **subtask's** planId (not the FEATURE planId).
- The prompt states `POST /kanban/queue/next` as the "ask for the next card" call.

## Verification Plan

### Automated Tests

- New coding-head-prompt contract (content + cross-file identity).
- Existing `standing-orders-marker`, `team-scoped-routing`, `stage-marker-commit` — all
  three are RED at HEAD for unrelated reasons; record their pre-change state before
  editing so a new failure is distinguishable.

### Goal Invariants

- The live coding head prompt contains no `targetColumn`.
- The live coding head prompt contains no reviewer roster check.
- Card movement is stated as unconditional, with no named exception.
- The completion post uses the **subtask's** planId, not the FEATURE planId.
- Extension and browser copies are byte-identical.

### Manual Verification

1. Start a coding team with no reviewer seat: the lead dispatches subtasks, commits, and
   posts completion for each without attempting a card move.
2. Start one WITH a reviewer seat: the lead ignores it and behaves identically.
3. Standalone Review team dispatches and relays unchanged.

## Recommendation

Send to Coder. Ships with the release-contract subtask; alone it leaves the second release
signal reachable by any other card mover.

## Implementation Summary

Removed reviewer seat check, reviewer dispatch call, and card-movement exception from `NEW_CODING_HEAD_PROMPT` in `src/services/teamWiring.ts`, `src/webview/terminals.js`, and `src/webview/kanban.html`. Replaced completion post target with the subtask's planId rather than the feature planId, and retained unconditional card movement rules. Added contract test `src/test/coding-head-prompt-contract.test.js` validating cross-file byte identity and prompt invariants.


## Review Findings

One MAJOR gate-wiring defect fixed. The new `src/test/coding-head-prompt-contract.test.js` was
named in this plan's `### Automated` verification, exists, and passes — but had no
`package.json` script and no `.github/workflows/integration-tests.yml` step, so nothing ever ran
it; the exact "green while incomplete" hole. Added `test:contract:coding-head-prompt` and a CI
step next to the stage-marker-commit gate. The prompt work itself is correct: no `targetColumn`,
no reviewer roster check, no `/kanban/dispatch`, one ending, subtask planId (not FEATURE
planId), and all three copies — `teamWiring.ts`, `terminals.js`, `kanban.html` — verified
byte-identical by the now-wired gate. Remaining risk: none beyond the plan's stated side effect
that a reviewer seat placed on a coding team is silently ignored rather than rejected.
