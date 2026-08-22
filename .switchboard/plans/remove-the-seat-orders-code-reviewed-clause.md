# Remove the seat order's hand-to-review clause

## Goal

Delete the clause in `TEAM_QUEUE_DONE_ORDER_BODY` that tells any seat to move a feature to `CODE REVIEWED` on a board-state check, because it grants a permission the head's own standing order explicitly withholds and can cause concurrent edits to the same files.

### Problem Analysis

Two standing orders are installed on the same team and contradict each other. Both are live today.

**The seat order** — `TEAM_QUEUE_DONE_ORDER_BODY` (`teamWiring.ts:322-325`), installed by `applyTeamQueueOrders` at **both** `team` scope (members) and `team-head` scope (the head seat):

> "Before posting, check `GET /kanban/plans?featureId=<your feature id>` — if all subtasks are in `LEAD CODED`, POST `/kanban/dispatch` with `{"plan":"<featurePlanId>","targetColumn":"CODE REVIEWED",…}` instead of posting to `queue/done`. The feature is complete — hand it to review."

**The head order** — (`teamWiring.ts:757-770`):

> "Check your team roster … for a seat with role `reviewer`. If your team has a reviewer seat, make one call: POST `/kanban/dispatch` … **If your team has NO reviewer seat, do NOT move the card to `CODE REVIEWED` — that is not your role.** Post a finished report … and stop. The card stays where it is."

The head holds both, because `applyTeamQueueOrders` installs the seat body at `team-head` scope too (`:378-393`).

**Why the seat version is the dangerous one, and why it is likelier to be obeyed:**

- **No roster check.** It never asks whether a reviewer seat exists. The head order's whole point is that condition.
- **It is cheaper to satisfy.** One board read versus a roster lookup plus a conditional. Given two instructions, the one requiring less work is the one an agent acts on.
- **It authorises the exact hazard the head rule prevents.** Moving the feature to `CODE REVIEWED` with no reviewer on the team hands the work to an off-team reviewer, which then edits the same files while the team pulls its next queue item and codes concurrently. File conflicts, from two agents legitimately following their instructions.

**And its premise is wrong regardless.** Cards move to a coding column on coding *start* — `LocalApiServer.ts:1682-1684` relies on exactly that ("cards move on coding *start* and never on finish") to explain why the in-flight refusal is skipped under seat pacing. So "all subtasks are in `LEAD CODED`" means *every subtask has been started at lead tier*, which the clause then labels "The feature is complete". It names an assignment state as an attestation.

**Nothing depends on it.** Server-side, completion is already a report: `LocalApiServer.ts:4119-4122` relays `[queue/done] ${from} reports its dispatched task complete` to the head, then clears and dispatches the next item. No board-state inference anywhere in the handler. The clause is guidance layered on top of a report-based design, contradicting it.

### Root Cause

The clause was written to solve a real problem — how does a *feature* (as opposed to a subtask) get advanced when its last subtask finishes? — and solved it with the information a seat had to hand: the board. The head order later solved the same problem correctly, with the roster check and the reviewer-seat condition. The seat version was never removed, so both shipped.

## Metadata

**Complexity:** 2
**Tags:** bugfix, reliability, backend

## User Review Required

- **Sequencing matters more than the edit.** Deleting this leaves a no-reviewer-seat team with no completion signal except the report file, until `add-a-task-complete-endpoint-for-the-lead.md` lands. Ship the endpoint first, or ship both together. Deleting alone is safe but leaves the in-flight gap wider.

## Complexity Audit

### Routine

- Removing the final sentences of `TEAM_QUEUE_DONE_ORDER_BODY` (`teamWiring.ts:322-325`), keeping the `queue/done` instruction that precedes them.
- Updating any test that byte-pins that body.

### Complex / Risky

- **Existing installed orders are stale until rewritten.** Orders live in DB config (`terminals.standingOrders`); changing the constant does not change what is already installed. The repo already has a known-failure plan for this exact class — `a-stale-standing-order-can-still-reach-a-live-agent.md`, cited at `teamWiring.ts:342-343`. So the change needs a rewrite pass over installed orders, in the manner of `rewriteStandingOrdersForRename` (`standingOrders.ts:63`), not just a new constant. This is the whole risk: a constant edit alone ships nothing to a live team.
- **The deterministic ids make reinstall the easy path.** `applyTeamQueueOrders` keys on `TEAM_QUEUE_ORDER_ID_PREFIX + groupId + ':' + scope` and skips an order that exists. Either the rewrite updates bodies in place, or the install path must detect an old body and replace it — otherwise a team keeps the old text indefinitely.
- **Do not remove the whole order.** The `queue/done` instruction in the same body is load-bearing: it is the completion-driven dispatch signal. Only the hand-to-review clause goes.
- **The head order stays exactly as it is.** It already encodes the correct rule. This plan does not touch it, and should not be an occasion to "tidy" it.

## Edge-Case & Dependency Audit

**Migration.** Required, and it is the substance of the change: installed orders carrying the old body must be rewritten. Per this project's rules the state shipped, so it migrates rather than being left.

**Security.** None. Removing an instruction that authorises a board mutation narrows what agents are told they may do.

**Side effects.** A feature whose last subtask finishes will no longer be advanced by a seat. For a reviewer-seat team the head order advances it. For a no-reviewer-seat team it correctly stays put — which is why the endpoint plan should land first.

**Ordering.** After (or with) the task-complete endpoint.

## Dependencies

- **Should follow** `add-a-task-complete-endpoint-for-the-lead.md`.
- **Subsumed by** `compose-standing-orders-from-a-library.md` if that ships first — a composed order set would not emit this clause to a team without a reviewer seat. Shipping this deletion separately is worth it because it is a two-line fix for a live hazard and the library is a larger build.

## Adversarial Synthesis

**"Fix the clause instead — add the roster check."** Then two orders say the same thing in two places and both must be maintained. The head order already says it correctly; a second copy is how this happened.

**"Without it, who advances the feature?"** The head, per its own order, when a reviewer seat exists. When one does not, nobody should — that is the point. The gap is the *completion signal*, which the endpoint plan fills, not the card move.

**"It has presumably worked in practice."** It fires only when every subtask has been started at lead tier, so on a mixed-complexity feature it never fires at all — which is why the hazard is latent rather than constant. A latent authorisation to cause file conflicts is still worth deleting.

## Proposed Changes

1. **Delete the hand-to-review clause** from `TEAM_QUEUE_DONE_ORDER_BODY` (`teamWiring.ts:322-325`); keep the `queue/done` instruction.
2. **Rewrite installed orders** carrying the old body, following `rewriteStandingOrdersForRename`'s pattern (`standingOrders.ts:63`).
3. **Make the install path replace an outdated body** rather than skipping on id match.
4. **Leave the head order untouched.**
5. **Update tests** that pin the old body.

### Migration

Installed orders in `terminals.standingOrders` are rewritten in place. Without this the constant change reaches nobody.

## Verification Plan

### Goal Invariants

- No standing order body instructs a non-head seat to move a card to `CODE REVIEWED`.
- The `queue/done` instruction still reaches every seat.
- The head order is byte-identical to before.
- A team with the old body installed has it rewritten.

### Automated Tests

- **Clause gone from the constant:** assert `TEAM_QUEUE_DONE_ORDER_BODY` contains no `CODE REVIEWED`, and still contains its `queue/done` instruction. Both halves — deleting too much is the likelier slip.
- **Installed orders rewritten:** seed a workspace with the old body installed at `team` and `team-head` scope, run the migration, assert both are updated. This is the test that distinguishes a shipped fix from an edited constant, and its absence is exactly the known failure the repo already documents.
- **Reinstall does not resurrect it:** run `applyTeamQueueOrders` after migration; assert the old text does not return via the id-match skip.
- **Head order unchanged:** byte-compare it, so this change cannot quietly alter the rule it defers to.
- **No seat can advance a feature:** with orders installed, assert no non-head scope carries an instruction to move a card.

## Outstanding Questions

- Are there other installed bodies naming `CODE REVIEWED` at a non-head scope? The two known are the `team`/`team-head` pair from one installer; a sweep of all order bodies would confirm the deletion is complete rather than just correct where it was found.
