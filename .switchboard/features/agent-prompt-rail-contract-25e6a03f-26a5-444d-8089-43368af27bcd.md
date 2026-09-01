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

## Team Dispatch Instructions

### Clearing a terminal needs a dedicated endpoint
- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - `POST /terminals/clear` with `{name, from}` clears one seat and lists it under `cleared`; the caller is never cleared even when named in `seats`.
  - `{team}` clears non-head seats, defers a busy seat, and the result reports `cleared`/`deferred`/`skipped` accurately.
  - An agent-initiated clear and a system-initiated clear are indistinguishable: config honoured, standing orders redelivered, log boundary rolled.
  - `ptySendPrompt` with `{"data":"/clear"}` is rejected with an error naming `POST /terminals/clear`; prose quoting `/clear` still sends.
  - The endpoint actually clears under the standalone host (the `clearTerminalContext` seam is wired).
- **Must not touch:** `ptyPromptDelivery.ts` (the delivery layer — depended on, not changed). The `after-clear-standing-orders-block-is-a-taskless-prompt.md` plan's post-clear orders delivery (composed, not modified). The `feature_plan_20260817091718_clear-the-cli-input-line-before-every-slash-command.md` Ctrl+U reset (depended on, not changed).

### A lead must never sleep to wait for its coders
- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - `coding-head-prompt-contract.test.js` passes — the three byte-identical copies of `NEW_CODING_HEAD_PROMPT` are identical.
  - `stage-marker-commit-contract.test.js` passes at baseline (2 pre-existing failures, no new ones).
  - The head prompt states that a completion is delivered to the lead and forbids sleeping/polling.
  - The drive prefix carries the matching rule; `drive-mode-prompt-overhaul-contract.test.js` passes.
  - A team created before this change still runs (keeps old prompt, no migration); recreating picks up the new text.
- **Must not touch:** No migration code (`migrateAgentGroups`, recognisers, frozen snapshot constants). No form of "advance", `targetColumn`, or `/kanban/dispatch` in the new text.

### An agent relaying a message to a lead sends a dispatch-sized payload
- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - A `ptySendPrompt` with `kind: "message"` (or `machineOrigin: true`) delivers the message alone — no standing-orders marker, no seat directive block, no dispatch directives.
  - A dispatch-kind send (or a send carrying a `dispatch` object) still receives all three appends; `seat-safeguards-fleet-prompt-path.test.js` passes unchanged.
  - `kind: "orders-refresh"` is rejected with an error naming the after-clear path.
  - The default-flip audit is in the PR description: every internal `ptySendPrompt` caller is listed, what kind each sends, and which were changed.
  - `machineOrigin: true` and `kind: "message"` produce byte-identical delivered text.
- **Must not touch:** The HTTP boundary strip (`bootstrap.ts:2042-2043`) — do not add `kind` to it. The coder's step-3 standing-order text (which instructs `"machineOrigin":true` verbatim) — not reissued in this change. The `after-clear-standing-orders-block-is-a-taskless-prompt.md` plan's orders-refresh delivery (reserved, not implemented here).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Clearing a terminal needs a dedicated endpoint: today it is a verb-tunnel call, a lesser clear, and a silent failure when done wrong](../plans/a-clear-is-not-a-prompt-agents-send-slash-clear-as-text.md) — **CODER CODED** — ID: 6fe201b3-d4a4-4d30-b605-b738b8bb4262
- [ ] [A lead must never sleep to wait for its coders — it is woken, and nothing tells it so](../plans/a-lead-must-never-sleep-to-wait-for-its-coders.md) — **CODER CODED** — ID: 776e83c9-ae52-462c-a715-d7ffd3f1e771
- [ ] [An agent relaying a message to a lead sends a dispatch-sized payload, because the appends default to on](../plans/an-agent-relayed-message-is-not-a-dispatch.md) — **CODER CODED** — ID: 4b8c7dc0-d02a-4ee5-9722-a92902c94ee9
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

## Completion Summary

All three subtasks implemented and committed (99d1337f). POST /terminals/clear added as canonical scope-aware clear endpoint with caller exclusion, lead preservation, mid-turn deferral, and log boundary roll; clearTerminalContext wired in standalone bootstrap; bare slash commands in ptySendPrompt data rejected. NEW_CODING_HEAD_PROMPT (three byte-identical copies) and drive prefix now state the wake guarantee and forbid sleeping/polling; contract tests updated. ptySendPrompt gains a kind field ("dispatch"|"message") that re-keys append suppression from machine-origin to dispatch-identity; agent-initiated sends default to message (no appends); kind:"orders-refresh" rejected as reserved; machineOrigin:true and kind:"message" produce byte-identical delivered text.

## Review Summary

Reviewed in one pass across all three subtasks. The lead-sleep subtask needed no code changes.
The other two shared one root defect: the payload-kind default flip landed without the
caller audit the plan named as its deliverable — seven `ptySendPrompt` send sites declared no
kind, and three of them silently lost the appends they depended on (the standing-orders resend
button, the browser team-queue drain, and the pane drop onto a freshly-cleared seat), while
`sendToTerminal` diverged from its standalone twin. All seven now declare their kind. Also
fixed: a double log-session roll in standalone's new `clearTerminalContext`, and two CI gates
the implementation left red (`catalog:check`, from the unregenerated endpoint count, and
`roster-clear-mid-turn-deferral`, whose exhaustive payload-shape pin broke on the new field).
A new CI-wired gate, `test:contract:prompt-payload-kind`, covers both new mechanisms and
ratchets the undeclared-send class shut.
