---
name: ClickUp Create Task
description: Create ClickUp tasks with optional subtasks via LocalApiServer
---

# Create ClickUp Task

## When to Use
- User asks to create a ClickUp task
- Plan requires task creation with subtasks

## Prerequisites
VS Code setting `switchboard.apiToken` must be configured with your API token.

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call POST /task/clickup \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Task name",
    "listId": "list123",
    "description": "Task description",
    "assignees": [12345],
    "dueDate": "2025-12-31",
    "subtasks": [
      {"name": "Subtask 1"},
      {"name": "Subtask 2", "description": "Details"}
    ]
  }'
```

## Parameters
- **name** (required): Task name
- **listId** (required): ClickUp list ID
- **description** (optional): Task description
- **assignees** (optional): Array of user IDs
- **dueDate** (optional): Due date in YYYY-MM-DD format
- **subtasks** (optional): Array of subtask objects (name required, others optional)

## Response
```json
{
  "success": true,
  "task": { "id": "...", "name": "..." },
  "subtasks": [...],
  "subtaskCount": 2,
  "failedSubtasks": [] // Only present if some subtasks failed to create
}
```

## Error Handling
- 401 Unauthorized: Token not configured
- 400 Bad Request: Missing name or listId
- 503: ClickUp service unavailable
