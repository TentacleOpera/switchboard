# Switchboard Protocol Specification

## Overview

The Switchboard Protocol defines a file-based messaging system for multi-agent coordination. It enables AI agents across different IDEs, CLIs, and containers to communicate through a shared workspace directory.

## Transport Layers

### 1. MCP (Model Context Protocol) — Primary
Agents with MCP support use Switchboard tools directly:
- **Stdio**: VS Code extension IPC (default)
- **HTTP/SSE**: External agents connect via `http://127.0.0.1:<port>/sse`

### 2. File-Based Messaging — Fallback
Agents without MCP support can participate by reading/writing JSON files directly to the `.switchboard/` directory structure.

## Directory Structure

```
.switchboard/
├── auth_token              # Bearer token for HTTP/SSE auth
├── server_info.json        # HTTP server discovery (port, endpoints)
├── state.json              # Shared agent state (locked via proper-lockfile)
├── bridge.json             # IPC bridge for terminal input routing
├── inbox/
│   └── <agent-name>/       # Incoming messages for each agent
│       └── msg_*.json
├── archive/
│   └── <agent-name>/       # Processed messages
│       └── msg_*.json
└── reviews/                # Review workflow artifacts
```

## Message Schema

All messages in `.switchboard/inbox/<recipient>/` follow this JSON schema:

```json
{
  "id": "msg_<timestamp>_<random>",
  "action": "delegate_task | request_review | submit_result | status_update | execute",
  "sender": "<agent-name>",
  "recipient": "<agent-name>",
  "payload": "<string — task description, review content, result summary, etc.>",
  "replyTo": "<optional — message ID being responded to>",
  "metadata": { "<optional key-value pairs>" },
  "team": "<optional — team ID if sent via send_team_message>",
  "persona": "<optional — injected persona text for role-based agents>",
  "createdAt": "<ISO 8601 timestamp>"
}
```

### Action Types

| Action | Direction | Purpose |
|--------|-----------|---------|
| `delegate_task` | Lead → Agent | Assign work to an agent |
| `request_review` | Agent → Reviewer | Request code/plan review |
| `submit_result` | Agent → Lead | Return completed work |
| `status_update` | Any → Any | Progress notification |
| `execute` | Lead → Terminal Agent | Direct terminal command injection |

### Delivery Receipt Schema

Written to `.switchboard/outbox/<sender>/`:

```json
{
  "id": "receipt_<message-id>",
  "inReplyTo": "<message-id>",
  "status": "delivered",
  "summary": "Message delivered to '<recipient>' inbox",
  "processedAt": "<ISO 8601 timestamp>",
  "error": null
}
```

## HTTP/SSE Transport

### Discovery

Read `.switchboard/server_info.json`:
```json
{
  "port": 3100,
  "host": "127.0.0.1",
  "transport": "sse",
  "sseEndpoint": "/sse",
  "messagesEndpoint": "/messages",
  "healthEndpoint": "/health",
  "pid": 12345,
  "startedAt": "2025-01-01T00:00:00.000Z"
}
```

### Authentication

Read token from `.switchboard/auth_token`, then:
- **Header**: `Authorization: Bearer <token>`
- **Query string**: `?token=<token>` (fallback for CLIs)

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Server health check |
| `GET` | `/sse` | Yes | Establish SSE stream (MCP session) |
| `POST` | `/messages?sessionId=<id>` | Yes | Send JSON-RPC message to session |

### Connection Flow

1. `GET /health` — verify server is running
2. `GET /sse` with auth — receive SSE stream with `endpoint` event containing message URL
3. `POST /messages?sessionId=<id>` — send MCP tool calls as JSON-RPC

## Agent Registration

### Terminal Agents
Registered via `register_terminal` tool with PID, purpose, and optional styling.

### Chat Agents
Registered via `register_chat_agent` tool with interface type and capabilities.

### Roles
Agents can be assigned roles: `lead`, `coder 1`, `coder 2`, `reviewer`, `tester`, `researcher`, `execution`.

### Teams
Agents can be grouped into teams (manual grouping or composite single-agent teams).

## Security

- **Path traversal**: Recipient names are validated — no `..`, `/`, or `\` allowed
- **Token auth**: File-based bearer token, regenerated per server lifecycle
- **Localhost binding**: HTTP server binds to `127.0.0.1` only
- **Workspace isolation**: Clipboard and file operations restricted to workspace root

## Validation

- Malformed JSON in inbox files is logged and skipped (not fatal)
- Missing artifacts block workflow phase completion
- Workflow phase ordering is enforced (no skipping without explicit reason)
