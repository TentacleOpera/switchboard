# Switchboard Protocol Instructions

## Overview

This project uses the **Switchboard** cross-IDE agent orchestration protocol. Workflows are defined in `.agent/workflows/` and enforced via a bundled MCP server.

## For AI Agents

1. **Read `AGENTS.md`** in the project root before starting work. It contains the workflow registry and execution rules.
2. If a user request matches a known workflow trigger (e.g. "review", "handoff", "standby"), execute the corresponding workflow from `.agent/workflows/`.
3. The MCP server provides tools like `send_message`, `check_inbox`, `list_active_terminals`, and `list_agents` for cross-agent coordination.

## Key Directories

- `.agent/workflows/` — Workflow definitions (markdown, enforced by MCP)
- `.switchboard/` — Runtime state (terminals, inbox/outbox messaging)
- `switchboard/` — Documentation and reference files
- `src/` — VS Code extension source (TypeScript)
- `src/mcp-server/` — Bundled MCP server (JavaScript)

## Workflow Trigger Words

| Trigger | Workflow |
|:---|:---|
| `review`, `critique` | `/review` — Adversarial two-persona review |
| `handoff`, `delegate` | `/handoff` — Terminal-based task delegation |
| `team`, `peer review` | `/team` — Implementation with review checkpoints |
| `accuracy`, `careful` | `/accuracy` — High-accuracy solo mode |
| `standby`, `watch` | `/standby` — Watch workspace for changes |
| `chat`, `pm` | `/chat` — Product Manager consultation (no code) |

## Agent Protocol

1. Check `AGENTS.md` for workflow matches before acting
2. Follow workflow steps exactly as defined in the `.md` file
3. Use MCP tools for cross-agent messaging when available
4. Do not skip verification gates or persona adoption steps
