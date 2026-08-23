---
name: worktree-cleanup
description: Mark a worktree merged and clean it up (kind-aware) via LocalApiServer
allowed-tools: Bash
disable-model-invocation: true
---

# Worktree Cleanup

## When to Use
- ONLY after a merge the agent performed at the user's request, and ONLY when the user has confirmed they want the worktree cleaned up.

## Prerequisites

1. **VS Code setting `switchboard.apiToken`** must be configured with your API token.
2. **LocalApiServer must be reachable.** This skill calls `POST /worktree/cleanup`, which the
   standalone host serves as `503` and a no-server call fails entirely — there is no direct-DB
   fallback. Probe exactly as `manage-features` does:
   1. Check for `.switchboard/api-server-port.txt` in the workspace root.
   2. If present, health-check it: `GET http://127.0.0.1:<port>/health` must respond `ok`.
   3. If the port file is absent **or** the health check fails, **stop**: tell the user the
      Switchboard extension is not running and worktree cleanup is unavailable until it is — do
      not attempt to clean the worktree by hand (deleting a worktree branch out from under the
      extension orphans its DB row). A stale port file or a failed health check means the server
      is down; treat it the same as absent.

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
