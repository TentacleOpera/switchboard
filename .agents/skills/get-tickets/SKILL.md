---
name: Local Ticket Access
description: Fetch tickets from the local Switchboard API proxy (ClickUp/Linear) for the current workspace.
---

# Local Ticket Access

Use this skill to access ClickUp/Linear ticket data via the local API server (no MCP required).

## When to Use

- User asks about ClickUp/Linear tickets (e.g., "list all tickets this sprint", "show me task XYZ")
- You need full task details (descriptions, comments, attachments)
- You need to filter tickets by status, sprint, or project
- You want faster access without MCP round-trips

## How to Use

> **Important:** `sb_api_call` is a bash function defined by sourcing the helper. Run the `source` line in the **same shell session** as the call — each self-contained block below already does this.

### Step 1: Get Metadata (List View)

**ClickUp metadata:**
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call GET /metadata/clickup
```

**Linear metadata:**
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call GET /metadata/linear
```

Response structure:
```json
{
  "version": 1,
  "sourceId": "clickup",
  "metadata": [
    {
      "id": "task123",
      "name": "Task name",
      "status": "In Progress",
      "listId": "list456",
      "sprint": "Sprint 1",
      "lastUpdated": 1234567890
    }
  ],
  "writtenAt": 1234567890
}
```

Use this metadata to:
- Filter tickets by status, sprint, list, or project
- Identify task IDs for full detail queries
- Answer questions that don't require full task descriptions

### Step 2: Get Full Task Details

**ClickUp task with full details (description, comments, attachments):**
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call GET /task/clickup/TASK_ID
```

Response includes:
- `task` - full task object with description, markdownDescription, assignees, status
- `subtasks` - array of subtasks
- `comments` - array of comments with user info
- `attachments` - array of attachments with URLs

**Linear issue with full details:**
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call GET /task/linear/ISSUE_ID
```

Response includes:
- `issue` - full issue object with description, state, assignee
- `subtasks` - array of sub-issues
- `comments` - array of comments
- `attachments` - array of attachments

### Step 3: Handle Errors

- **Port file doesn't exist:** Extension not running or API server not started
- **API server not responding:** Extension may have crashed
- **503 Service Unavailable:** ClickUp/Linear not configured in this workspace
- **404 Not Found:** Task/issue ID doesn't exist
- **Empty metadata:** No tickets cached — tasks may not have been synced yet

## Security Notes

- API server is bound to localhost only (127.0.0.1)
- Uses the extension's existing ClickUp/Linear credentials from VS Code secret storage
- No additional credential management needed
