# Switchboard Configuration for Windsurf (Cascade)

This project uses the **Switchboard** protocol for cross-IDE agent collaboration.

## Setup

1. Coordinate with other agents using the workflow triggers below.

## Available Workflow Tools

- **get_team_roster** — Discover registered terminals/chat agents and their roles.
- **start_workflow** / **complete_workflow_phase** / **stop_workflow** — Workflow control.
- **get_workflow_state** — Inspect active workflow and phase status.
- **run_in_terminal** — Execute commands in a registered terminal.
- **set_agent_status** — Update terminal/chat availability status.
- **handoff_clipboard** — Copy prepared handoff artifacts to clipboard.

## Workflow Triggers

| Trigger | Workflow | Description |
|:--------|:---------|:------------|
| `/handoff` | handoff | Delegate tasks to external agents |
| `/handoff-chat` | handoff-chat | Clipboard/chat delegation workflow |
| `/handoff-relay` | handoff-relay | Execute-now, stage-rest relay workflow |
| `/handoff-lead` | handoff-lead | One-shot lead execution workflow |
| `/improve-plan` | improve-plan | Deep planning, dependency checks, and adversarial review |
| `/accuracy` | accuracy | High-accuracy solo mode |
| `/chat` | chat | Product Manager consultation (no code) |
