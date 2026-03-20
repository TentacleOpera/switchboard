const fs = require('fs');
const path = require('path');

const base = path.join('X:', 'documents', 'GitHub', 'switchboard', 'templates', 'github');
const agentsDir = path.join(base, 'agents');

// Step 1: Create directories recursively
fs.mkdirSync(agentsDir, { recursive: true });
console.log('Created directory:', agentsDir);

// Step 2: Write copilot-instructions.md.template
const copilotInstructions = `# Switchboard Protocol Instructions

## Overview

This project uses the **Switchboard** cross-IDE agent orchestration protocol. Workflows are defined in \`.agent/workflows/\` and enforced via a bundled MCP server.

## For AI Agents

1. **Read \`AGENTS.md\`** in the project root before starting work. It contains the workflow registry and execution rules.
2. If a user request matches a known workflow trigger (e.g. "review", "handoff", "standby"), execute the corresponding workflow from \`.agent/workflows/\`.
3. The MCP server provides tools like \`send_message\`, \`check_inbox\`, \`list_active_terminals\`, and \`list_agents\` for cross-agent coordination.

## Key Directories

- \`.agent/workflows/\` — Workflow definitions (markdown, enforced by MCP)
- \`.switchboard/\` — Runtime state (terminals, inbox/outbox messaging)
- \`src/\` — VS Code extension source (TypeScript)
- \`src/mcp-server/\` — Bundled MCP server (JavaScript)

## Workflow Trigger Words

| Trigger | Workflow |
|:---|:---|
| \`improve\`, \`plan review\` | \`/improve-plan\` — Deep planning, dependency checks, and adversarial review |
| \`handoff\`, \`delegate\` | \`/handoff\` — Terminal-based task delegation |
| \`team\`, \`peer review\` | \`/team\` — Implementation with review checkpoints |
| \`accuracy\`, \`careful\` | \`/accuracy\` — High-accuracy solo mode |
| \`standby\`, \`watch\` | \`/standby\` — Watch workspace for changes |
| \`chat\`, \`pm\` | \`/chat\` — Product Manager consultation (no code) |

## Agent Protocol

1. Check \`AGENTS.md\` for workflow matches before acting
2. Follow workflow steps exactly as defined in the \`.md\` file
3. Use MCP tools for cross-agent messaging when available
4. Do not skip verification gates or persona adoption steps
`;

fs.writeFileSync(path.join(base, 'copilot-instructions.md.template'), copilotInstructions, 'utf8');
console.log('Wrote copilot-instructions.md.template');

// Step 3: Write switchboard.agent.md.template
const switchboardAgent = `# Switchboard Agent

## Description
Task orchestration agent for the Switchboard protocol.

## Trigger
When the user mentions "@switchboard" or types "switchboard".

## Instructions

### Step 1: Read AGENTS.md
Read \`AGENTS.md\` in the project root for the full workflow registry and execution rules.

### Step 2: Check MCP Tools
Verify MCP server connectivity. Available tools:
- **send_message** — Send structured messages for workflow actions
- **check_inbox** — Read messages from inbox/outbox
- **get_team_roster** — Discover registered terminals/chat agents
- **start_workflow** / **complete_workflow_phase** / **stop_workflow** — Workflow control
- **get_workflow_state** — Inspect active workflow and phase status
- **run_in_terminal** — Execute commands in a registered terminal
- **get_kanban_state** / **move_kanban_card** — Kanban board operations

### Step 3: Execute Workflow
Follow the workflow steps exactly as defined in \`.agent/workflows/\`.
Do not skip verification gates or persona adoption steps.
`;

fs.writeFileSync(path.join(agentsDir, 'switchboard.agent.md.template'), switchboardAgent, 'utf8');
console.log('Wrote switchboard.agent.md.template');

console.log('\\nSetup complete! All files written successfully.');
