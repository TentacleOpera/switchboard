# @switchboard/mcp

A local **stdio MCP server** that bridges **Claude Desktop** (and any other MCP-only chat host) to Switchboard's [`LocalApiServer`](../services/LocalApiServer.ts) HTTP surface. It lets a chat app with no shell and no filesystem access drive the Switchboard kanban board — read state, create/move/delete plans, reconcile features, dispatch orchestration — while VS Code sits minimised as the background execution engine.

The MCP process is a **thin, stateless HTTP client**. It adds a transport, not new capability. Every tool call re-reads the LocalApiServer port (chosen by `listen(0)` — a fresh OS-assigned port on each VS Code restart) and hits the live HTTP surface. It never touches `kanban.db` and never re-implements a handler.

## Install

### Option A — Claude Desktop config (manual / other stdio hosts)

Add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "switchboard-mcp": {
      "command": "npx",
      "args": ["-y", "@switchboard/mcp"],
      "env": {
        "SWITCHBOARD_WORKSPACE_ROOT": "/absolute/path/to/your/workspace"
      }
    }
  }
}
```

Restart Claude Desktop. The `switchboard_*` tools appear.

### Option B — `.mcpb` (Desktop Extension, one-click install)

Use the `.mcpb` bundle in `.mcpb/` (zip the `manifest.json` + `dist/` + `node_modules/`). Desktop renders an install-time form for `workspace_path` (required) and `api_token` (optional, sensitive).

### Option C — from source

```sh
cd src/mcp
npm install
npm run build
node ./dist/index.js /path/to/workspace
```

## Configuration

| Var / arg | Required | Description |
|---|---|---|
| `SWITCHBOARD_WORKSPACE_ROOT` (env) or first positional arg | yes | Absolute path to the workspace opened in VS Code with the Switchboard extension active. |
| `SWITCHBOARD_API_TOKEN` (env) | no | Bearer token. **Leave unset for the default token-less localhost path.** Only set if LocalApiServer auth is enabled; sending a bearer header against a token-less server will 401. |

## Tools

Curated verbs (hand-schema'd for good Desktop UX) plus a generic passthrough:

| Tool | Method + Path |
|---|---|
| `board_read` | `GET /kanban/board` |
| `columns_read` | `GET /kanban/columns` |
| `plan_read` | `GET /kanban/plan` / `GET /kanban/plans` |
| `plan_create` | `POST /kanban/plans` (201) |
| `plan_delete` | `DELETE /kanban/plans` |
| `plan_set_project` | `PUT /kanban/plans/project` |
| `plan_set_complexity` | `PUT /kanban/plans/complexity` |
| `card_move` | `POST /kanban/move` |
| `features_reconcile` | `POST /kanban/feature*` + `/kanban/features/*` |
| `orchestration_dispatch` | `POST /kanban/orchestration/dispatch` |
| `worktree_list` | `GET /worktree/list` |
| `worktree_cleanup` | `POST /worktree/cleanup` |
| `clickup_request` / `linear_request` | `POST /api/clickup` / `POST /api/linear` |
| `catalog_read` | `GET /catalog` |
| `switchboard_request` | generic `{method, path, body}` passthrough |

## Persona

Claude Desktop **ignores** the MCP `instructions` field and surfaces prompts **only** as explicit user-invoked slash commands. The management-console discipline (report-then-wait, no eager automation, no confirm gates, deletes execute immediately, never ask which project to pin) is therefore baked into the **tool descriptions** — the only channel that passively reaches Desktop's model. An opt-in `switchboard_console` prompt loads the full persona on demand. Full fidelity on Desktop may require pasting the persona into your Claude Project/profile custom instructions.

## Naming note (config scrubber)

The Switchboard VS Code extension scrubs any MCP entry keyed literally `switchboard` from `.vscode/mcp.json`, `.cursor/mcp.json`, `.mcp.json`, `.kiro/settings/mcp.json`, `.gemini/settings.json`, and `~/.codeium/windsurf/mcp_config.json` on every activation (legacy cleanup from the removed in-extension MCP server). **Always register this server under the key `switchboard-mcp`**, never `switchboard`, or a non-Desktop host will silently uninstall it on the next VS Code reload. `claude_desktop_config.json` is not in the scrub list, so the primary Desktop path is unaffected — but use `switchboard-mcp` for consistency.

## Requirements

- Node.js >= 18 (the MCP SDK requires >= 18).
- The Switchboard VS Code extension active with the target workspace open. If VS Code is closed, every tool call returns a structured `SWITCHBOARD_NOT_RUNNING` error and the MCP process stays alive; reopening VS Code restores function without restarting the subprocess (the port is re-read per call).
