---
name: clickup_move_task
description: Move a ClickUp task to a different list via LocalApiServer
---

# Move ClickUp Task

## When to Use
- User asks to move a task to a different list
- Need to relocate a ticket to another list within the workspace

## Prerequisites
VS Code setting `switchboard.apiToken` must be configured.

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call PUT "/task/clickup/$TASK_ID/move" \
  -H "Content-Type: application/json" \
  -d '{
    "targetListId": "list-uuid-here",
    "moveCustomFields": true
  }'
```

## Parameters
- **targetListId** (required): ID of the destination list
- **moveCustomFields** (optional, default true): Bring custom fields to the new list
- **statusMappings** (optional): Array of `{ source_status, destination_status }`. Usually omit it — when the task's status has no name match in the target list, the server auto-maps to the target list's first status and returns a `warning`

## Response
```json
{
  "success": true,
  "taskId": "...",
  "targetListId": "...",
  "warning": null,
  "remainsInLists": 0
}
```

- **warning**: non-null when the status was auto-mapped to the target list's first status
- **remainsInLists**: number of additional lists (e.g. sprint lists) the task still appears in

## Limitations
- Only the task's **home list** changes. A task that is also in additional lists (Tasks in Multiple Lists — sprint lists are the common case) remains in them after the move; check `remainsInLists` in the response.

## Error Handling
- 401 Unauthorized: Token not configured
- 400 Bad Request: Missing targetListId
- 503: ClickUp service unavailable
- 500: Move failed (see error message)
