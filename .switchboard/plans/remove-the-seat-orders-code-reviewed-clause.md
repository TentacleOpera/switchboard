# Remove the seat order's hand-to-review clause

## Goal

Delete the clause in `TEAM_QUEUE_DONE_ORDER_BODY` that tells any seat to move a feature to `CODE REVIEWED` on a board-state check. This is the first concrete application of the category rule that completion is asserted, never inferred (`completion-is-asserted-never-inferred.md`), landing alongside the anchor plan to eliminate an invalid board-position inference that grants a permission the head's own standing order explicitly withholds and causes concurrent edits to the same files.

### Problem Analysis

Two instructions are installed on the same team and contradict each other. Both are live today.

**The seat order** — `TEAM_QUEUE_DONE_ORDER_BODY` (`teamWiring.ts:343-355`), a standing order installed by `applyTeamQueueOrders` at **both** `team` scope (members, `teamWiring.ts:411-417`) and `team-head` scope (the head seat, `teamWiring.ts:419-425`):

> "Before posting, check `GET /kanban/plans?featureId=<your feature id>` — if all subtasks are in `LEAD CODED`, POST `/kanban/dispatch` with `{"plan":"<featurePlanId>","targetColumn":"CODE REVIEWED",…}` instead of posting to `queue/done`. The feature is complete — hand it to review."

**The head's headPrompt** — `NEW_CODING_HEAD_PROMPT` (`teamWiring.ts:879-921`), the team group's `headPrompt` field delivered as the head's system prompt (not a standing order — a different delivery mechanism that also reaches the head):

> "Check your team roster … for a seat with role `reviewer`. If your team has a reviewer seat, make one call: POST `/kanban/dispatch` … **If your team has NO reviewer seat, do NOT move the card to `CODE REVIEWED` — that is not your role.** Post a finished report … and stop. The card stays where it is."

The head holds both, because `applyTeamQueueOrders` installs the seat body at `team-head` scope too (`teamWiring.ts:419-425`).

> **Superseded:** The head order — (`teamWiring.ts:757-770`): a standing order installed on the head.
> **Reason:** `teamWiring.ts:757-770` is `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` — a frozen snapshot that the codebase says "NEVER edit." The live head prompt is `NEW_CODING_HEAD_PROMPT` at `:879-921`. Furthermore, the head's reviewer-check rule is a **headPrompt** (the team group's `headPrompt` field, delivered as the head's system prompt via `wireSpawnedTeam`), not a standing order. Standing orders are installed via `mutateStandingOrders` and rendered by `selectOrders`; headPrompts are installed via the group config and rendered by the team-prompt builder. The contradiction is between one standing order and one headPrompt, not two standing orders.
> **Replaced with:** The head's headPrompt — `NEW_CODING_HEAD_PROMPT` (`teamWiring.ts:879-921`), the team group's `headPrompt` field delivered as the head's system prompt. Both the standing order and the headPrompt reach the head, but through different mechanisms.

**Why the seat version is the dangerous one, and why it is likelier to be obeyed:**

- **No roster check.** It never asks whether a reviewer seat exists. The headPrompt's whole point is that condition.
- **It is cheaper to satisfy.** One board read versus a roster lookup plus a conditional. Given two instructions, the one requiring less work is the one an agent acts on.
- **It authorises the exact hazard the head rule prevents.** Moving the feature to `CODE REVIEWED` with no reviewer on the team hands the work to an off-team reviewer, which then edits the same files while the team pulls its next queue item and codes concurrently. File conflicts, from two agents legitimately following their instructions.

**And its premise is wrong regardless.** Cards move to a coding column on coding *start* — `LocalApiServer.ts:1703` relies on exactly that ("cards move on coding *start* and never on finish") to explain why the in-flight refusal is skipped under seat pacing. So "all subtasks are in `LEAD CODED`" means *every subtask has been started at lead tier*, which the clause then labels "The feature is complete". It names an assignment state as an attestation.

**Nothing depends on it.** Server-side, completion is already a report: `LocalApiServer.ts:4117-4128` relays `[queue/done] ${from} reports its dispatched task complete` to the head, then clears and dispatches the next item. No board-state inference anywhere in the handler. The clause is guidance layered on top of a report-based design, contradicting it.

### Why the premise changed: first application of the category rule (completion is asserted, never inferred)

> **Framing & Premise Change (citing `completion-is-asserted-never-inferred.md`):**
> This change is the first concrete application of the system-wide category rule: **completion is an asserted event (`POST /kanban/task/complete` writing `completed_at`), never inferred from board position.**
> 
> Previously, because the system lacked an explicit completion signal, consumers attempted to guess completion from whatever durable trace was available. The seat order looked at board position ("all subtasks are in `LEAD CODED`") and inferred "The feature is complete — hand it to review." But cards move to coding columns on coding *start*, not finish, so that clause named an assignment state as an attestation and manufactured a "probably done" state out of silence.
> 
> With `completion-is-asserted-never-inferred.md` establishing explicit asserted completion and silence-halts semantics, all inference paths are eliminated as a category rather than site-by-site. This plan lands alongside the anchor plan (`completion-is-asserted-never-inferred.md`) as its first application.

### Root Cause

The clause was written to solve a real problem — how does a *feature* (as opposed to a subtask) get advanced when its last subtask finishes? — and solved it with the information a seat had to hand: the board. The headPrompt later solved the same problem correctly, with the roster check and the reviewer-seat condition. The seat version was never removed, so both shipped.

### Why the premise changed: this is the first application of the category rule

> **Premise change (citing `completion-is-asserted-never-inferred.md`):** This plan was originally scoped as a local cleanup — one contradictory clause at one site. With the anchor plan's decision that completion is an asserted event (`POST /kanban/task/complete` writes `completed_at`), this plan is recognisably the **first application of the category rule**: no consumer derives completion from a kanban column. The clause it removes is one instance of that pattern — inferring "the feature is complete" from "all subtasks are in `LEAD CODED`" — and the anchor plan makes the pattern explicit so the next consumer does not re-derive it.
>
> This plan should land alongside the anchor plan (`completion-is-asserted-never-inferred.md`) so the category rule and its first application do not disagree in the interim. The anchor plan retires the report-file instruction in the head order and repoints the in-flight predicate at `completed_at`; this plan removes the seat order's board-position clause. Together they close all three inference sites identified by the anchor.

## Metadata

**Complexity:** 3
**Tags:** bugfix, reliability, backend

## User Review Required

- **Sequencing: lands alongside the anchor plan.** This plan is the first application of the category rule and lands alongside `completion-is-asserted-never-inferred.md`. It requires `add-a-task-complete-endpoint-for-the-lead.md` for the explicit completion post. Shipping both together ensures no team is left with contradictory instructions or unhandled completion signals.

## Complexity Audit

### Routine

- Removing the hand-to-review clause from `TEAM_QUEUE_DONE_ORDER_BODY` (`teamWiring.ts:351-354` — the four lines starting with `'Before posting, check GET /kanban/plans?featureId='`), keeping the `queue/done` instruction that precedes them (`:344-350`).
- Updating the doc comment above the function (`teamWiring.ts:336-341`) which describes the clause as "the existing feature-completion path."

### Complex / Risky

- **Existing installed orders are stale until rewritten.** Orders live in DB config (`terminals.standingOrders`); changing the constant does not change what is already installed. The repo already has a known-failure plan for this exact class — `a-stale-standing-order-can-still-reach-a-live-agent.md`, cited at `teamWiring.ts:370-372`. The fix needs a read-path migration recogniser, not just a new constant. This is the whole risk: a constant edit alone ships nothing to a live team.
- **The deterministic IDs make the recogniser precise.** `applyTeamQueueOrders` keys on `TEAM_QUEUE_ORDER_ID_PREFIX + groupId + ':' + scope` (`teamWiring.ts:407-408`, prefix at `:362`). The recogniser matches by ID prefix (`team-queue-done:`) AND clause fragment — more precise than the headPrompt recognisers, which match by fragment alone.
- **The `groupId` is recoverable from `o.teamId`.** `applyTeamQueueOrders` passes `groupId` as the `teamId` parameter to `makeStandingOrder` (`teamWiring.ts:413`). So the host recogniser can call `TEAM_QUEUE_DONE_ORDER_BODY(o.teamId)` to generate the clean new body. The client mirror can truncate the instruction at the clause start fragment, since the clause is always the trailing portion.
- **Do not remove the whole order.** The `queue/done` instruction in the same body is load-bearing: it is the completion-driven dispatch signal. Only the hand-to-review clause goes.
- **The headPrompt stays exactly as it is.** It already encodes the correct rule. This plan does not touch it, and should not be an occasion to "tidy" it.
- **Client mirror required.** Every existing migration fragment in the codebase notes "Two copies only: this one and the `terminals.js` mirror." The client mirror `migrateCodingTeamOrdersClient` (`terminals.js:10897`) must also get the new recogniser, or the Teams tab UI shows stale text while agents receive the corrected order.

## Edge-Case & Dependency Audit

**Migration.** Required, and it is the substance of the change: installed orders carrying the old body must be rewritten. Per this project's rules the state shipped, so it migrates rather than being left. The migration follows the established read-path pattern (see Proposed Changes).

**Security.** None. Removing an instruction that authorises a board mutation narrows what agents are told they may do.

**Side effects.** A feature whose last subtask finishes will no longer be advanced by a seat. For a reviewer-seat team the headPrompt advances it. For a no-reviewer-seat team it correctly stays put — which is why the endpoint plan should land first.

**Ordering.** After (or with) the task-complete endpoint.

**Dependencies & Conflicts.** None at the code level. The migration recogniser is a new branch in an existing pure transform; it does not conflict with any other recogniser because it matches by ID prefix, which is unique to `applyTeamQueueOrders`-installed orders.

## Dependencies

- **Lands alongside** `completion-is-asserted-never-inferred.md` — the anchor plan establishing the category rule.
- **Should follow (or land with)** `add-a-task-complete-endpoint-for-the-lead.md` — providing the authoritative completion post.
- **Subsumed by** `compose-standing-orders-from-a-library.md` if that ships first — a composed order set would not emit this clause to a team without a reviewer seat. Shipping this deletion separately is worth it because it is a two-line fix for a live hazard and the library is a larger build.
- **Also subsumed by** `context-aware-completion-reporting.md` if that ships first — it replaces the entire `TEAM_QUEUE_DONE_ORDER_BODY` with a context-aware order. Same calculus: this is a smaller, faster fix for a live hazard.

## Adversarial Synthesis

Key risks: (1) the clause fragment must be unique to the seat order — verified: "The feature is complete — hand it to review" is distinct from both `NEW_CODING_HEAD_PROMPT` ("triggers review by dispatching") and `OLD_HEADPROMPT_FRAGMENT` ("hand it to review yourself"). (2) The migration must be idempotent — the new body lacks the fragment, so the recogniser doesn't re-match. (3) The client mirror must stay in sync or the UI diverges from delivery. Mitigations: match by ID prefix AND clause fragment; return input by reference when nothing matches; mirror in `migrateCodingTeamOrdersClient`.

## Proposed Changes

### `src/services/teamWiring.ts`

**1. Delete the hand-to-review clause from `TEAM_QUEUE_DONE_ORDER_BODY`** (`teamWiring.ts:351-354`).

Remove these four lines from the function body (`:343-355`):
```
+ 'Before posting, check GET /kanban/plans?featureId=<your feature id> — if all subtasks '
+ 'are in LEAD CODED, POST /kanban/dispatch with '
+ '{"plan":"<featurePlanId>","targetColumn":"CODE REVIEWED","from":"<your terminal name>"} '
+ 'instead of posting to queue/done. The feature is complete — hand it to review.';
```
Keep the preceding `queue/done` instruction (`:344-350`). The function should end after the fallback line: `'If the POST fails, report to your head directly via ptySendPrompt as a fallback.'`.

**2. Update the doc comment** (`teamWiring.ts:336-341`) that describes the feature-completion check as "the existing feature-completion path from `agentGroupInstantiation.ts`." Remove or rewrite the paragraph that documents the clause — the clause is gone.

**3. Add a read-path migration recogniser.**

> **Superseded:** Rewrite installed orders carrying the old body, following `rewriteStandingOrdersForRename`'s pattern (`standingOrders.ts:63`); and make the install path replace an outdated body rather than skipping on id match.
> **Reason:** `rewriteStandingOrdersForRename` (at `standingOrders.ts:218`, not `:63`) is a name-based rename, not a body-text migration. The codebase already has a lazy read-path migration pipeline — `loadEffectiveStandingOrders` (`teamWiring.ts:2861`) runs `migrateCodingTeamOrders(migrateTeamPairOrders(raw))` on every read, persists once, and backs up pre-migration state. Every previous headPrompt migration (`OLD_HEADPROMPT_FRAGMENT`, `BUGGY_HEADPROMPT_FRAGMENT`, `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT`, `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT`) uses this pattern. The install-path change is redundant — the read-path migration catches stale bodies on the next prompt regardless of whether `applyTeamQueueOrders` re-runs. No existing migration changes the install path.
> **Replaced with:** Add a recogniser to `migrateCodingTeamOrders` (or a new pure transform composed into `loadEffectiveStandingOrders` at `:2866`) that matches seat orders by deterministic ID prefix (`team-queue-done:`, constant `TEAM_QUEUE_ORDER_ID_PREFIX` at `teamWiring.ts:362`) AND clause fragment, and replaces the instruction with `TEAM_QUEUE_DONE_ORDER_BODY(o.teamId)`. No install-path change.

The recogniser:
- **Match condition:** `o.id` starts with `TEAM_QUEUE_ORDER_ID_PREFIX` AND `o.instruction` contains the clause fragment `'The feature is complete — hand it to review'` (unique to the old seat order body — verified against all `CODE REVIEWED` occurrences in `teamWiring.ts`).
- **Replacement:** `{ ...o, instruction: TEAM_QUEUE_DONE_ORDER_BODY(o.teamId!) }` — regenerates the clean body from the order's `teamId` field (which IS the `groupId` passed to `makeStandingOrder` at install time).
- **Idempotency:** The new body lacks the clause fragment, so the recogniser does not re-match on a subsequent read.
- **Identity short-circuit:** Return the input array by reference when nothing matches, preserving `loadEffectiveStandingOrders`' "did anything change?" identity test (`teamWiring.ts:2867`).
- **Scope:** Both `team` and `team-head` scopes carry the same body; the ID-prefix match covers both.

### `src/webview/terminals.js`

**4. Mirror the recogniser in `migrateCodingTeamOrdersClient`** (`terminals.js:10897`).

The client mirror cannot import `TEAM_QUEUE_DONE_ORDER_BODY`, so it truncates the instruction at the clause start fragment instead of regenerating:
- **Match condition:** same — `o.id` starts with `'team-queue-done:'` AND `o.instruction` contains `'The feature is complete — hand it to review'`.
- **Replacement:** truncate `o.instruction` at the index of `'Before posting, check GET /kanban/plans?featureId='` (the clause start), keeping everything before it. The `queue/done` instruction that precedes the clause is preserved.
- **Idempotency:** the truncated instruction lacks the fragment, so the recogniser does not re-match.

This follows the "two copies" pattern every existing migration fragment uses. The client mirror is for Teams tab UI display; authoritative agent delivery goes through the server-side `loadEffectiveStandingOrders` path.

### Tests

**5. Write new tests** (no existing test pins `TEAM_QUEUE_DONE_ORDER_BODY`).

> **Superseded:** Updating any test that byte-pins that body.
> **Reason:** No test pins `TEAM_QUEUE_DONE_ORDER_BODY`. `queue-pipeline-contract.test.js:684-685` checks `applyTeamQueueOrders` exists and the `team-queue-done:` prefix is present (structural, not body-pinning). `stage-marker-commit-contract.test.js:404-421` pins `NEW_CODING_HEAD_PROMPT` literals (the head prompt, not the seat order). There is nothing to update; new tests are needed.
> **Replaced with:** Write new tests asserting the clause is gone, the `queue/done` instruction remains, and the migration recogniser rewrites installed orders.

### Migration

Installed orders in `terminals.standingOrders` are rewritten by the read-path migration on the next `loadEffectiveStandingOrders` call, which persists once and backs up the pre-migration state (`teamWiring.ts:2867-2876`). Without this the constant change reaches nobody.

## Verification Plan

### Goal Invariants

- No standing order body instructs a non-head seat to move a card to `CODE REVIEWED`.
- The `queue/done` instruction still reaches every seat.
- The headPrompt (`NEW_CODING_HEAD_PROMPT`) is byte-identical to before.
- A team with the old body installed has it rewritten by the read-path migration.

### Automated Tests

- **Clause gone from the constant:** assert `TEAM_QUEUE_DONE_ORDER_BODY('test-team')` contains no `CODE REVIEWED`, and still contains its `queue/done` instruction (`POST /terminals/teams/test-team/queue/done`). Both halves — deleting too much is the likelier slip.
- **Migration recogniser rewrites installed orders:** seed a standing-orders array with the old body installed at `team` and `team-head` scope (using `TEAM_QUEUE_ORDER_ID_PREFIX + 'test-team:team'` and `:team-head` IDs), run the migration transform, assert both instructions are updated to the new body (no `CODE REVIEWED`, still has `queue/done`). This is the test that distinguishes a shipped fix from an edited constant, and its absence is exactly the known failure the repo already documents.
- **Migration is idempotent:** run the migration transform on an array with the NEW body already installed; assert it returns the input by reference (no re-match, no write).
- **Migration leaves unrelated orders untouched:** seed an operator-authored ad-hoc order that happens to contain "hand it to review" but does NOT have a `team-queue-done:` ID prefix; assert it is not modified.
- **Reinstall does not resurrect it:** run `applyTeamQueueOrders` after migration; assert the old text does not return via the id-match skip (the install path still skips on id match, and the constant no longer contains the clause, so a fresh install also lacks it).
- **HeadPrompt unchanged:** byte-compare `NEW_CODING_HEAD_PROMPT` before and after, so this change cannot quietly alter the rule it defers to.
- **Client mirror matches host behaviour:** seed the same old-body array through `migrateCodingTeamOrdersClient` and assert the clause is stripped from both scopes.
- **No seat can advance a feature:** with orders installed, assert no non-head scope carries an instruction to move a card to `CODE REVIEWED`.

## Outstanding Questions

- **[user]** Are there other installed bodies naming `CODE REVIEWED` at a non-head scope? The two known are the `team`/`team-head` pair from one installer; a sweep of all order bodies would confirm the deletion is complete rather than just correct where it was found. — proceeding on the assumption that the `team-queue-done:` ID prefix is unique to `applyTeamQueueOrders` and no other installer emits a `CODE REVIEWED` instruction at `team` or `team-head` scope.
