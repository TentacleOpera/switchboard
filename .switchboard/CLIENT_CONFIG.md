# Switchboard Client Configuration Guide

## Transport Options

Switchboard supports two transport modes. Clients should attempt HTTP/SSE first, falling back to the manual file protocol if unavailable.

### 1. Stdio Transport (VS Code Extension)

This is the default for IDE-integrated agents. No configuration needed — the VS Code extension manages the MCP server lifecycle automatically.

**MCP Config** (`.gemini/antigravity/mcp_config.json`):
```json
{
  "mcpServers": {
    "switchboard-<hash>": {
      "command": "node",
      "args": ["<path>/.switchboard/MCP/mcp-server.js"],
      "env": {
        "SWITCHBOARD_WORKSPACE_ROOT": "<workspace-root>"
      }
    }
  }
}
```

### 2. HTTP/SSE Transport (External Agents)

For agents running outside VS Code (CLI tools, containers, remote machines with workspace access).

#### Discovery

```bash
# 1. Check if HTTP server is running
cat .switchboard/server_info.json
# Returns: { "port": 3100, "host": "127.0.0.1", ... }

# 2. Read auth token
cat .switchboard/auth_token
```

#### MCP Client Config (SSE)

For MCP clients that support SSE transport:
```json
{
  "mcpServers": {
    "switchboard-sse": {
      "transport": "sse",
      "url": "http://127.0.0.1:3100/sse",
      "headers": {
        "Authorization": "Bearer <token-from-auth_token-file>"
      }
    }
  }
}
```

#### cURL Testing

```bash
# Health check (no auth)
curl http://127.0.0.1:3100/health

# Establish SSE stream
TOKEN=$(cat .switchboard/auth_token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3100/sse

# Or with query string auth
curl "http://127.0.0.1:3100/sse?token=$TOKEN"
```

### 3. Manual File Protocol (No MCP)

For agents that cannot use MCP at all. See `.agent/skills/manual_messaging.md` for the full file-based messaging protocol.

## Fallback Strategy

```
┌─────────────────────────────────┐
│ Agent starts                    │
├─────────────────────────────────┤
│ 1. Check server_info.json       │
│    ├─ exists → Try HTTP/SSE     │
│    │   ├─ GET /health OK → Use  │
│    │   └─ Failed → Step 2       │
│    └─ missing → Step 2          │
├─────────────────────────────────┤
│ 2. Check MCP stdio available?   │
│    ├─ yes → Use stdio transport │
│    └─ no → Step 3               │
├─────────────────────────────────┤
│ 3. Use manual file protocol     │
│    Read/write .switchboard/     │
│    inbox/<agent>/*.json         │
└─────────────────────────────────┘
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SWITCHBOARD_WORKSPACE_ROOT` | `process.cwd()` | Workspace root directory |
| `SWITCHBOARD_PORT` | `3100` | HTTP/SSE server port (tries +5 range) |

## Port Discovery

The HTTP server tries ports `3100`–`3104`. The actual bound port is written to `.switchboard/server_info.json`. Always read this file for the correct port — do not hardcode `3100`.

## Security Notes

- The HTTP server binds to `127.0.0.1` only (localhost)
- Auth token is stored in `.switchboard/auth_token` (file permissions should be restricted)
- Token persists across server restarts for session continuity
- `server_info.json` is cleaned up on graceful shutdown
- If `server_info.json` exists but `/health` fails, the server crashed — fall back to file protocol
