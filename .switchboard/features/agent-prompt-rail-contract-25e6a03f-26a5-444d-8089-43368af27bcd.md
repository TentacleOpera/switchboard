---
description: 'Agent Prompt Rail Contract'
---

# Agent Prompt Rail Contract

**Complexity:** 6

## Goal

Fix three defects in the contract between agents and the prompt rail, all of the same shape:
the rail already does the right thing, and nothing tells the agent so. A lead sleeps to wait
for coders that are guaranteed to wake it. An agent asked to clear a terminal sends "/clear"
as prompt text, which is delivered as literal text on a path that cannot carry a slash
command, and returns success. An agent relaying a short message to a lead sends it wrapped in
the lead's full standing orders and seat directive block, because the appends default to on
and the flag that suppresses them is named for machine origin rather than for what it means.

Two are instructional or default-level — the wake fires and the append-suppression flag exists,
the agent just does not know it. The clear is not: it needs a real endpoint.

## How the Subtasks Achieve This

- **A lead must never sleep to wait for its coders**: states the wake guarantee and forbids
  sleeping/polling on both lead-facing surfaces — the head's standing order and the drive
  prefix — and says what to do with the turn instead, since the unanswered "then what?" is what
  produced the sleep.
- **Clearing a terminal needs a dedicated endpoint**: adds POST /terminals/clear as the
  canonical, scope-aware clear (one seat or a whole team, never the caller, defers a busy seat,
  reports what it did), reconciles the two divergent clear implementations behind it, and makes
  a bare slash command sent as prompt data fail loudly instead of silently succeeding.
- **An agent relaying a message is not a dispatch**: re-keys the append suppression from "who
  sent it" to "is this a dispatch", fixes the default for agent-initiated sends behind a caller
  audit, and documents the three payload kinds so an agent can say which it is sending.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Clearing a terminal needs a dedicated endpoint: today it is a verb-tunnel call, a lesser clear, and a silent failure when done wrong](../plans/a-clear-is-not-a-prompt-agents-send-slash-clear-as-text.md) — **CREATED** — ID: 6fe201b3-d4a4-4d30-b605-b738b8bb4262
- [ ] [A lead must never sleep to wait for its coders — it is woken, and nothing tells it so](../plans/a-lead-must-never-sleep-to-wait-for-its-coders.md) — **CREATED** — ID: 776e83c9-ae52-462c-a715-d7ffd3f1e771
- [ ] [An agent relaying a message to a lead sends a dispatch-sized payload, because the appends default to on](../plans/an-agent-relayed-message-is-not-a-dispatch.md) — **CREATED** — ID: 4b8c7dc0-d02a-4ee5-9722-a92902c94ee9
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; the three subtasks touch different surfaces and can be executed
in parallel.

Two soft couplings worth knowing:

- The clear-endpoint plan depends on `lead-acceptance-post-silently-releases-no-seat.md` step 1
  (wiring `clearTerminalContext` in the standalone composition root); without it the new endpoint
  is inert in standalone. It also routes through the post-clear orders delivery owned by
  `after-clear-standing-orders-block-is-a-taskless-prompt.md`.
- The clear-endpoint plan and "An agent relaying a message is not a dispatch" both edit
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
