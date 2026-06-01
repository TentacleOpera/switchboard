# Switchboard Configuration for Github

This project uses the **Switchboard** protocol for cross-IDE agent collaboration.

## Available Workflow Tools

You have access to these tools:

### Messaging (Cross-IDE)
- **get_team_roster** — Discover registered terminals/chat agents and role assignments.

### Workflow Management
- **start_workflow** — Begin a workflow (e.g., `improve-plan`, `accuracy`).
- **get_workflow_state** — Inspect active workflow and phase state.
- **complete_workflow_phase** — Mark a workflow phase as done (enforces step ordering and required artifacts).
- **stop_workflow** — End the current workflow.

### Terminal Management
- **run_in_terminal** — Send commands to a registered terminal.
- **set_agent_status** — Update terminal/chat status.
- **handoff_clipboard** — Copy staged handoff artifacts to clipboard.

## Workflow Triggers

| Trigger | Workflow | Description |
|:--------|:---------|:------------|
| `/improve-plan` | improve-plan | Deep planning, dependency checks, and adversarial review |
| `/accuracy` | accuracy | High-accuracy solo mode |
| `/chat` | chat | Product Manager consultation (no code) |
