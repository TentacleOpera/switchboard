---
description: Mark a worktree merged and clean it up (kind-aware) via LocalApiServer
---

# Worktree Cleanup

## When to Use
- ONLY after a merge the agent performed at the user's request, and ONLY when the user has confirmed they want the worktree cleaned up.

## Prerequisites
VS Code setting `switchboard.apiToken` must be configured with your API token.

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call POST /worktree/cleanup \
  -H "Content-Type: application/json" \
  -d '{ "worktreeId": "<id-or-branch>", "workspaceRoot": "/abs/path/to/workspace" }'
```

## Parameters
- **worktreeId** (required): The worktree database ID (integer) or git branch name (string).
- **workspaceRoot** (optional): Absolute path to the workspace root.

## Response
```json
{
  "success": true
}
```

## Error Handling
- 401 Unauthorized: Token not configured.
- 400 Bad Request: Missing worktreeId.
- 502/500: Database or filesystem worktree cleanup failure.
