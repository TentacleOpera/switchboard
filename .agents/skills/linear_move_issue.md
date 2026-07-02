---
description: Move a Linear issue to a different project via LocalApiServer
---

# Move Linear Issue

## When to Use
- User asks to move an issue to a different project
- Need to relocate a ticket to another project within the same team

## Prerequisites
VS Code setting `switchboard.apiToken` must be configured.

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call PUT "/task/linear/$ISSUE_ID/move" \
  -H "Content-Type: application/json" \
  -d '{
    "targetProjectId": "project-uuid-here"
  }'
```

## Parameters
- **targetProjectId** (required): UUID of the destination project, or null to remove from project

## Response
```json
{
  "success": true,
  "issueId": "...",
  "targetProjectId": "..."
}
```

## Limitations
- Linear does NOT support moving issues between teams. The target project must be in the same team as the issue.
- To move to a different team, create a new issue in the target team and close the original.

## Error Handling
- 401 Unauthorized: Token not configured
- 400 Bad Request: Missing targetProjectId
- 503: Linear service unavailable
