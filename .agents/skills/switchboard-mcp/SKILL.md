# Switchboard MCP

## When to Use
- When connecting **Claude Desktop** (or any other MCP-only chat host that has no shell/filesystem) to a Switchboard workspace.
- This skill is for **filesystem hosts** (Claude Code, Antigravity) that honor the MCP server's `instructions` field and can read this SKILL.md. Claude Desktop ignores `instructions` and does not read skill files — its persona is delivered via tool descriptions + the opt-in `switchboard_console` prompt.

## What It Is
A **local stdio MCP server** (`@switchboard/mcp`) that Claude Desktop launches as its own subprocess. The subprocess resolves `127.0.0.1` to the same box running VS Code and proxies every tool call to Switchboard's `LocalApiServer` HTTP surface. It is a **stateless thin HTTP client** — it holds no state, never touches `kanban.db`, and re-reads the ephemeral port on every call.

This is **not** the old in-extension MCP server (which was removed in commit `0b7ef13`). That server was bundled into the extension build, held its own state, and was spawned/tracked by the extension. This server is external, stateless, and launched by the chat host.

## Install

### Claude Desktop (config snippet)
Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "switchboard-mcp": {
      "command": "npx",
      "args": ["-y", "@switchboard/mcp"],
      "env": { "SWITCHBOARD_WORKSPACE_ROOT": "/abs/path/to/workspace" }
    }
  }
}
```
Or use the in-extension **Connect Claude Desktop** button (Setup panel) to write this entry idempotently with the workspace root pre-filled.

### From source
```sh
cd src/mcp && npm install && npm run build
node ./dist/index.js /abs/path/to/workspace
```

## Configuration
- `SWITCHBOARD_WORKSPACE_ROOT` (env) or first positional arg (required): absolute path to the workspace opened in VS Code with the Switchboard extension active.
- `SWITCHBOARD_API_TOKEN` (env, optional): bearer token. **Leave unset for the default token-less localhost path.** Sending a bearer header against a token-less server will 401.

## Tools
Curated verbs: `board_read`, `health_read` (liveness + registered terminal agents), `columns_read`, `plan_read`, `plan_create`, `plan_delete`, `plan_set_project`, `plan_set_complexity`, `card_move` (move only — fires no agent), `card_dispatch` (ONE-call advance-and-dispatch via `POST /kanban/dispatch`; omit `targetColumn` for complexity auto-routing; DB-verified honest response), `features_reconcile`, `orchestration_dispatch`, `worktree_list`, `worktree_cleanup`, `clickup_request`, `linear_request`, `catalog_read`, plus a generic `switchboard_request` passthrough (method + path + body).

## Persona
The management-console discipline (report-then-wait, no eager automation, no confirm gates, deletes execute immediately, never ask which project to pin) is baked into the tool descriptions. An opt-in `switchboard_console` prompt loads the full persona. The server `instructions` field is set for clients that honor it (Claude Code).

## Naming Note
Always register the server under the key **`switchboard-mcp`**, never `switchboard`. The VS Code extension scrubs any `switchboard`-keyed MCP entry from `.vscode/mcp.json`, `.cursor/mcp.json`, `.mcp.json`, `.kiro/settings/mcp.json`, `.gemini/settings.json`, and `~/.codeium/windsurf/mcp_config.json` on every activation (legacy cleanup). `claude_desktop_config.json` is not scrubbed, but use `switchboard-mcp` for consistency.

## Requirements
- Node.js >= 18.
- Switchboard VS Code extension active with the target workspace open. If VS Code is closed, tool calls return a structured `SWITCHBOARD_NOT_RUNNING` error and the process stays alive; reopening VS Code restores function without restarting the subprocess.
