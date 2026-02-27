# .switchboard/

This folder contains runtime state for the Switchboard extension. It is created automatically on first activation.

**Do not edit files here manually** — they are managed by the extension and MCP server.

## Contents

| Path | Purpose |
|:-----|:--------|
| `inbox/<agent>/` | Incoming messages for each agent |
| `archive/<agent>/` | Processed messages (auto-cleaned by housekeeping) |
| `plans/features/` | Plan files tracked by the sidebar |
| `handoff/` | Artifacts staged for delegation to other agents |
| `sessions/` | Session run sheets and activity logs |
| `reviews/` | Review workflow outputs |
| `state.json` | Shared agent state (managed by MCP server) |
| `server_info.json` | HTTP/SSE discovery info (port, token endpoint) |

## Documentation

- `CLIENT_CONFIG.md` — transport options and MCP connection guide
- `SWITCHBOARD_PROTOCOL.md` — full protocol specification and message schema