---
description: 'Agent Prompt Rail Contract'
---

# Agent Prompt Rail Contract

## Goal

Fix three defects in the contract between agents and the prompt rail, all of the same shape:
the rail already does the right thing, and nothing tells the agent so. A lead sleeps to wait
for coders that are guaranteed to wake it. An agent asked to clear a terminal sends "/clear"
as prompt text, which is delivered as literal text on a path that cannot carry a slash
command, and returns success. An agent relaying a short message to a lead sends it wrapped in
the lead's full standing orders and seat directive block, because the appends default to on
and the flag that suppresses them is named for machine origin rather than for what it means.

Each is instructional or default-level, not a missing capability: the wake fires, ptyClearTerminal
works in both hosts, and the suppression flag exists. What is missing is the agent knowing it.

## How the Subtasks Achieve This

- **A lead must never sleep to wait for its coders**: states the wake guarantee and forbids
  sleeping/polling on both lead-facing surfaces — the head's standing order and the drive
  prefix — and says what to do with the turn instead, since the unanswered "then what?" is what
  produced the sleep.
- **A clear is not a prompt**: makes the wrong call fail loudly instead of silently succeeding,
  rejecting a bare slash command sent as prompt data with an error naming ptyClearTerminal, and
  puts the clear verb in front of the /switchboard and Mission Control agents that reach for
  ptySendPrompt by habit.
- **An agent relaying a message is not a dispatch**: re-keys the append suppression from "who
  sent it" to "is this a dispatch", fixes the default for agent-initiated sends behind a caller
  audit, and documents the three payload kinds so an agent can say which it is sending.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; the three subtasks touch different surfaces and can be executed
in parallel.

Two soft couplings worth knowing:

- "A clear is not a prompt" and "An agent relaying a message is not a dispatch" both edit
  `.agents/workflows/switchboard.md` and the Mission Control persona's `## Messaging Leads`
  section. Landing them in either order is fine; landing them simultaneously will conflict in
  those two files.
- "A lead must never sleep" edits `NEW_CODING_HEAD_PROMPT`, which
  `team-lead-escalation-dead-end-recovery-ladder.md` (not part of this feature) also edits. Both
  are clean text edits with no migration — teams are unreleased dev work — but they share the
  three byte-identical copies and the same contract test, so coordinate them.

## Notes

**No migrations anywhere in this feature.** The team/lead feature has only ever existed in
unreleased dev work, so stored head prompts and team standing orders take a clean break: no
`migrateAgentGroups` step, no frozen snapshot constants, no recognisers for text that never
shipped. A dev team carrying an old prompt is recreated, not migrated.
