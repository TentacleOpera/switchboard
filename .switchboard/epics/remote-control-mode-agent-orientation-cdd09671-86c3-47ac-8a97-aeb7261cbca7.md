---
description: 'Remote Control Mode & Agent Orientation'
---

# Remote Control Mode & Agent Orientation

## Goal

Establish the operational boundaries of Remote Control mode and provide orientation tooling for external agents that drive Switchboard boards. Remote Control mode lets an external agent (Claude web, Linear's native agent) operate a Switchboard kanban board through an external tracker. Today, Remote Control can conflict with Bug-Triage mode, external agents have no orientation instructions, and the Linear Remote tab lacks a way to generate agent-specific skill text.

## How the Subtasks Achieve This

- **Enforce Mutual Exclusivity Between Remote Control and Bug-Triage Modes**: Both modes manipulate kanban state and can conflict if active simultaneously on the same workspace. This plan adds a per-workspace mutual exclusivity guard — enabling Remote Control disables Bug-Triage and vice versa, preventing state corruption from concurrent mode operations.

- **Add /switchboard-remote Orientation Skill for Claude Web Sessions**: When a user starts a Claude web session to drive Switchboard via Remote Control, the agent needs orientation — what Switchboard is, how the kanban board works, what commands are available, and how to interact with the board through the external tracker. This plan creates a `/switchboard-remote` skill file that provides that orientation context.

- **Linear Remote Tab: Dynamic Agent Skill Copy Button**: The Linear Remote tab currently has no way to generate tailored instruction text for Linear's native agent. This plan adds a dynamic "Copy Agent Skill" button that generates orientation text parameterized by the current workspace's configuration — board state, available commands, tracker integration details — so the user can paste it into Linear's agent prompt.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add /switchboard-remote Orientation Skill for Claude Web Sessions](../plans/add-switchboard-remote-skill.md) — **PLAN REVIEWED**
- [ ] [Linear Remote Tab: Dynamic Agent Skill Copy Button](../plans/linear-remote-agent-skill-copy-button.md) — **PLAN REVIEWED**
- [ ] [Enforce Mutual Exclusivity Between Remote Control and Bug-Triage Modes](../plans/remote-control-triage-mutual-exclusivity.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
