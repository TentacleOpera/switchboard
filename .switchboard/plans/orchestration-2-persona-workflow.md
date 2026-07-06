# Author the Orchestrator Persona Workflow (`.agents/workflows/orchestrator.md`)

## Metadata
**Complexity:** 5
**Tags:** docs, backend, feature, automation
**Project:** Switchboard

## Goal

Author the orchestrator agent's persona as a Switchboard workflow at `.agents/workflows/orchestrator.md`, and register it in the mirror manifest so it is discoverable as a skill. This is the agent that the Orchestration mode launches into the orchestrator terminal; it encodes the wake/triage protocol, the verify-via-git rule, the planner-escalation boundary, and the merge-back procedure that subtasks 4 and 5 rely on.

### Problem / background / root cause

Every role in Switchboard is defined by a workflow/skill file under `.agents/` (the single source of truth), which `ClaudeCodeMirrorService` mirrors into `.claude/skills/` for native discovery (`src/services/ClaudeCodeMirrorService.ts:46`, `MIRROR_MANIFEST`). The orchestrator must follow the same pattern rather than hard-coding behaviour in a prompt string, so its behaviour is versioned, editable, and consistent with `improve-plan`, `switchboard-chat`, etc. Subtasks 4 (kickoff) and 5 (wake/triage/merge) are the *engine*; this file is the *behaviour* those hooks invoke, so it must exist as a stable, referenceable artifact.

## Content the workflow must specify

- **Role & scope.** The orchestrator manages a batch through **coding and code review only**. It never automates planning; planner-stage questions escalate to the human.
- **Kickoff protocol** (consumed by subtask 4): run `group-into-features` end-to-end **without the confirm gate**, then sweep all remaining standalone plans into a single **`Miscellaneous`** feature so nothing is ungrouped; ensure each feature has worktrees + terminals; dispatch each feature's subtasks by stage; then stop and sleep.
- **Wake/triage protocol** (consumed by subtask 5): on each system wake, (1) read the request inbox, (2) **verify real progress from git and board state — never trust an agent's self-reported "done"**, (3) write a triage summary to the session log, (4) act: advance a stage, dispatch a research agent for a well-formed request, escalate planner-stage or unresolvable items to the human, or run merge-back for a completed feature.
- **Verify-via-git rule.** Define the concrete signals: branch ahead of base, commits present, tests where applicable, card column. Self-report is a nudge, not status of record.
- **Merge-back procedure.** Feature by feature, following the agent-driven merge pattern (subtask → feature integration branch → main), resolving conflicts as it goes; then request worktree cleanup. Never a bulk `git merge`.
- **Escalation boundary.** Exactly what goes to the human (planner questions, unresolvable conflicts, stalled agents) vs. what the orchestrator handles itself.
- **Comms.** How to read `.switchboard/orchestrator/inbox/` and append to `.switchboard/orchestrator/session-log.md` (defined in subtask 3).

## Registration

- Add an entry to `MIRROR_MANIFEST` in `ClaudeCodeMirrorService.ts` for `workflows/orchestrator.md` → skill name `orchestrator` (choose the appropriate invocation mode — likely `no-user`/model-launched, since the mode launches it rather than the user typing `/orchestrator`).
- Add it to the skills/workflow tables in `CLAUDE.md`/`AGENTS.md` for discoverability, consistent with the other entries.

## Edge cases & constraints

- Keep the persona aligned with the "system-woken, not self-scheduling" decision — the workflow must not instruct the agent to set its own timers.
- The workflow references file paths and skills defined in sibling subtasks; note the dependency so it is authored after (or alongside) subtask 3's inbox/log convention is fixed.

## Testing

- Mirror regeneration picks up the new workflow into `.claude/skills/orchestrator/SKILL.md` without touching user-authored skills.
- A dry read of the workflow by an agent yields an unambiguous kickoff and wake/triage procedure (reviewed manually).

## Out of scope

- The engine hooks that launch and wake the orchestrator (subtasks 1, 4, 5) and the inbox/log implementation (subtask 3). This subtask is the persona document + its registration.
