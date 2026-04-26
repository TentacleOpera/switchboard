# .switchboard/

This folder contains runtime state for the Switchboard extension. It is created automatically on first activation.

**Do not edit files here manually** — they are managed by the extension and MCP server.

## Contents

| Path | Purpose |
|:-----|:--------|
| `inbox/<agent>/` | Incoming messages for each agent |
| `archive/<agent>/` | Processed messages (auto-cleaned by housekeeping) |
| `plans/` | Top-level plan directory tracked by the sidebar; control-plane migrations may add one immediate repo-name sub-folder layer under `plans/`; deeper nesting is not used |
| `handoff/` | Artifacts staged for delegation to other agents |
| `sessions/` | Session run sheets and activity logs |
| `reviews/` | Review workflow outputs |
| `kanban.db` | SQLite database tracking all active and completed plans |
| `state.json` | Shared agent state (managed by MCP server) |
| `server_info.json` | HTTP/SSE discovery info (port, token endpoint) |

## Documentation

- `CLIENT_CONFIG.md` — transport options and MCP connection guide
- `SWITCHBOARD_PROTOCOL.md` — full protocol specification and message schema

## Cloud Sync Note

The `kanban.db` file can be stored in a cloud-synced folder (via `switchboard.kanban.dbPath`). If multiple machines modify the database simultaneously, your cloud provider (e.g., Google Drive, Dropbox) may create **conflict copies** (e.g., `kanban (1).db`). Switchboard will warn you if it detects these files, but it will not automatically merge them. You should manually resolve conflicts by ensuring only one `kanban.db` exists in the target directory.
