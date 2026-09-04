# Coding Rounds 05 — The Lead Is Told Its New Contract, and the Board Shows the Rounds

kanbanColumn: CREATED

## Goal

The lead's standing orders describe registering rounds and marking them done — and nothing about dispatching seats. The board shows which round a team is on.

### Problem analysis

A lead knows `/kanban/task/complete` exists for exactly one reason: `buildHeadCompletionFragment()` (`standingOrderFragments.ts:77-86`) spells out the verb, path and payload, delivered as fragment `headCompletion` (`:146`). An endpoint the standing orders never name will never be called.

So the endpoints in subtasks 02 and 04 are dead code until this lands, and the dispatch instructions the lead currently follows will race the system path from subtask 03.

Separately, a registered round is state nobody can see. The operator watching a team has no way to know it is on round 2 of 3, or that a round was dispatched with one prompt missing.

## Metadata

- **Complexity:** 4
- **Feature:** Coding Rounds
- **Tags:** teams, prompts, ui, both-hosts

## User Review Required

Change 1 carries one decision: whether a planning head and a review head get any of this.

## Proposed Changes

### 1. Rewrite the head's standing orders around rounds **[decision]**

The lead's loop becomes: read the feature, decide the rounds, register them, then mark each one done as its seats report in. Remove the instructions telling it to dispatch subtasks to seats and to post per-subtask completions — leaving those live means two paths racing to seat the same work.

Keep the contract sentence. *"Your POST is the only fact the system acts on"* is what stops a lead inferring completion from board position, and it is more load-bearing now, not less.

**The decision:** the fragment is gated on `ctx.inTeam && ctx.isHead && ctx.headRole === 'lead'`, so a planning head (`'planner'`) and a review head (`'reviewer'`) receive none of it. Settle whether rounds apply to them before widening or leaving the gate.

### 2. Per-subtask completion stays available

A lead accepting one subtask mid-round still needs it. What changes is that it is no longer how a round is closed.

### 3. Show the round on the board

A team working a feature displays which round it is on and how many there are. A round dispatched with a prompt that did not land shows that, rather than looking identical to one that is working.

This is the visibility that would have made the 2026-09-04 incident obvious in seconds instead of hours.

## Edge-Case & Dependency Audit

1. **Depends on 02, 03 and 04** — this names endpoints they create.
2. **Half the deliverable is the prompt.** Routes without the fragment ship endpoints no agent calls; the fragment without the routes tells the lead to call something that 404s.
3. **A team with no registered rounds** shows nothing new and behaves exactly as it does today.
4. **Both hosts** render the board.

## Verification Plan

1. A lead's standing orders name register and round-complete, and contain no instruction to dispatch subtasks to seats.
2. A real lead handed a feature registers rounds without being prompted to.
3. The board shows the current round and the total for a team mid-feature.
4. A round with an undelivered prompt is visibly distinct from a healthy one.
5. A planning head and a review head receive whatever the decision settled — not silently nothing.
6. Both hosts show the same round state.
