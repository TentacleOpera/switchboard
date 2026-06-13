# Switchboard Protocol Specification

## Overview

The Switchboard Protocol defines a file-based messaging system for multi-agent coordination. It enables AI agents across different IDEs, CLIs, and containers to communicate through a shared workspace directory.

## Transport Layers

### File-Based Messaging
Agents participate by reading/writing JSON files directly to the `.switchboard/` directory structure.

## Directory Structure

```
.switchboard/
├── kanban.db               # SQLite database — ALL extension state and config
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


## Agent Registration

The extension registers terminals and chat agents in `kanban.db` (config table,
`runtime.terminals` / `runtime.chatAgents` keys). There is no `state.json` file;
all extension state and configuration live in the database. Agents interact with
Switchboard exclusively through the `inbox/`/`outbox/` message directories and
registered tools — never by writing state files.

### Roles
Agents can be assigned roles: `lead`, `coder 1`, `coder 2`, `reviewer`, `tester`, `researcher`, `execution`.

### Teams
Agents can be grouped into teams (manual grouping or composite single-agent teams).

## Security

- **Path traversal**: Recipient names are validated — no `..`, `/`, or `\` allowed
- **Workspace isolation**: Clipboard and file operations restricted to workspace root

## Validation

- Malformed JSON in inbox files is logged and skipped (not fatal)
- Missing artifacts block workflow phase completion
- Workflow phase ordering is enforced (no skipping without explicit reason)
