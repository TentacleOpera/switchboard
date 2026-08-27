# The Card Is A Two-Way Channel

**Complexity:** 4

## Goal

Make a synced card the place where progress appears and where the operator can intervene, without any agent having to remember to narrate anything.

Today the operator learns about progress only if an agent chooses to tell them. The remote-mode directive instructs every role to post questions and blockers as a comment on the linked issue, which is the right instruction and the wrong mechanism to depend on: a queue advancing normally produces no comment, so an absence of information is indistinguishable from a suspicious silence. Switchboard itself should post dispatch and completion events, mentioning the operator, so the queue is legible from a phone and a silence reads as a silence.

Two intervention paths are also missing. An inbound comment is routed to the card current column agent, which is right for a planning conversation and wrong for waking a worker - the seat holding an in-flight subtask is not necessarily the column agent, and on a feature card there may be no single agent at all. And a team has no card to report to: the write-back primitive, its guard and the agents instruction to use it all exist, but every existing write-back is scoped to a plan own card, so there is no destination for a team.

All three run on the same comment bridge - postManagedComment, the comment route, and the per-board remote-control gate.

## How the Subtasks Achieve This

- **The Queue Is Invisible Unless An Agent Remembers To Narrate It**: has Switchboard itself post dispatch and completion comments mentioning the operator, so progress does not depend on an agent choosing to report and a suspicious silence is visible as a silence rather than as an absence of information.
- **A Card Comment Cannot Reach The Seat Holding The Work**: routes an inbound comment to the card's `dispatched_terminal` through the existing relay, and surfaces the feature-stall evidence the engine already composes. Routing to the column agent is right for a planning conversation and wrong for waking a worker — on a feature card there may be no single agent at all.
- **Standing Orders Can Post A Team Status Report To A Card**: supplies the one missing piece — a destination for a **team**. The write-back primitive, its guard, and the agents' instruction to use it all exist, but every existing write-back is scoped to a plan's own card.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A team has no card to report to, though the comment primitive that would carry the report is built](../plans/standing-orders-can-post-a-team-status-report-to-a-card.md) — **CREATED** — ID: 0236a001-8f64-430f-8423-d006d7930fb2
- [ ] [The queue is invisible from a phone unless an agent remembers to narrate it](../plans/the-queue-is-invisible-unless-an-agent-remembers-to-narrate-it.md) — **CREATED** — ID: 295c2435-d2ee-4e6f-b82f-eaf63852bab9
- [ ] [A comment on a card cannot reach the seat holding the work, and the stall the system already detected is never shown](../plans/a-card-comment-cannot-reach-the-seat-holding-the-work.md) — **CREATED** — ID: 3a368a6c-30a1-4f25-bff9-4ef9f4327975
<!-- END SUBTASKS -->

## Dependencies & sequencing

`the-queue-is-invisible` lands **first**. The stall comment in `a-card-comment-cannot-reach-the-seat` is a fourth event type on that plan's notification bridge and should reuse its gating, toggles, dedupe, best-effort delivery and mention handling rather than building a parallel path — it also supplies the visibility that makes a manual wake-up worth having.

All three need `postManagedComment` threaded with `parentId` and `mentions`, which it currently drops. Do that once, as shared work; other callers benefit. All three must also use the same per-board remote-control gate the remote-mode directive already applies, so that "remote control on" means one thing.

`standing-orders` owns the `teamId` to `issueId` binding. `automation-rules-can-target-a-column-but-not-a-team.md` (outside this feature, in the Linear work) needs the same binding for its completion write-back — define it here, once, and consume it there.

One reconciliation from the consistency audit, worth recording because a keyword read gets it backwards: `retire-comment-delta-dispatch.md` retires comment-triggered **column re-dispatch**, and `switchboard-as-a-linear-app-user.md` resolves the apparent collision — a mention to an agent is a message, not a dispatch, and it names this feature's seat-routing rule as the one it adopts. Nothing here is superseded. On Linear these events become native agent activities; the comment path remains for ClickUp, Notion and personal-key installs.

`a-card-comment-cannot-reach-the-seat` adds **no** new stall detection — it reuses the engine's existing evidence composition, gates and one-nudge policy. This is unrelated to the silence-based `blocked_at` state being removed elsewhere; that is a different subsystem.
