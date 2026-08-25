# The Plan-Authoring Contract

**Complexity:** 5

## Goal

Fix what authoring agents are required to do, and what their output must contain. The split gate is a soft recommendation planners rationalise past, and a halted gate's split proposal has nowhere to go; plans lose the user's original words; agents spawn subagent fleets on memo and chat prompts; the create-feature skill's stale sections produce features with no subtasks attached; and project assignment is carried by thousands of characters of directive that should simply be a board setting.

## How the Subtasks Achieve This

- **Enforce mandatory split gate in improve-plan protocol** — turns the scope and split check from a soft recommendation planners rationalise past into a hard stop.
- **Split-gate return routing via standing orders** — gives a halted gate's split proposal somewhere to go, with runtime instructions for what to do with the return.
- **Require a verbatim User Instructions section in every authored plan** — carries the user's original request and clarifying question-and-answer pairs into the plan file itself.
- **Prohibit subagents in memo and chat prompts** — adds an explicit prohibition to the generated prompts, so a receiving agent stops spawning a subagent fleet for work it should do itself.
- **The create-feature skill documents the link mechanism that works without the extension** — fixes the two stale sections that make an agent produce a feature with no subtasks attached and tell it not to commit the file it just wrote.
- **Replace agent-authored project pinning with a sticky-project UI setting** — takes project assignment off the agent entirely: a board-level toggle the importer consults, and the deletion of the directive that currently carries it.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Prohibit Subagents in Memo and Chat Prompts](../plans/feature_plan_20260818093006_prohibit-subagents-in-memo-and-chat-prompts.md) — **PLAN REVIEWED**
- [ ] [Require a verbatim ## User Instructions section in every authored plan](../plans/feature_plan_20260819140000_verbatim-user-instructions-in-plans.md) — **PLAN REVIEWED**
- [ ] [The create-feature Skill Documents the Link Mechanism That Works Without the Extension](../plans/create-feature-skill-documents-the-frontmatter-carrier.md) — **PLAN REVIEWED**
- [ ] [Enforce Mandatory Split Gate in improve-plan Protocol](../plans/enforce-mandatory-split-gate-in-improve-plan-protocol.md) — **PLAN REVIEWED**
- [ ] [Split-Gate Return Routing via Standing Orders](../plans/split-gate-return-routing-for-automation.md) — **PLAN REVIEWED**
- [ ] [Replace agent-authored project pinning with a sticky-project UI setting](../plans/replace-agent-project-pinning-with-a-sticky-ui-setting.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

The split gate lands before its return routing — the routing has nothing to route until the gate actually halts. The other four subtasks are independent of each other and of the gate work, and can be executed in parallel.

