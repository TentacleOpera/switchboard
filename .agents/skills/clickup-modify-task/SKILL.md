---
name: ClickUp Modify Task
description: Update ClickUp task properties via LocalApiServer
---

# Modify ClickUp Task

## When to Use
- User asks to update a task
- Need to change task status, assignees, priority, etc.

## Prerequisites
VS Code setting `switchboard.apiToken` must be configured.

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call PUT "/task/clickup/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "in progress",
    "assignees": [12345],
    "priority": 2
  }'
```

## Parameters (provide at least one)
- **name**: New task name
- **description**: New description
- **status**: Status name (e.g., "to do", "in progress", "done")
- **assignees**: Array of user IDs to set as assignees
- **dueDate**: Due date in YYYY-MM-DD format
- **priority**: 1 (urgent), 2 (high), 3 (normal), 4 (low)
- **tags**: Array of tag names to apply

## Response
```json
{
  "success": true,
  "task": { "id": "...", ... },
  "updatedFields": ["status", "assignees", "priority"]
}
```

## Error Handling
- 401 Unauthorized: Token not configured
- 400 Bad Request: No fields provided
- 503: ClickUp service unavailable
