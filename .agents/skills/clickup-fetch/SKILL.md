---
name: ClickUp Fetch
description: Fetch ClickUp tasks/lists with automatic name resolution
---

# ClickUp Fetch with Name Resolution

## When to Use
- Need to resolve a task/list name to its ID
- Fetch task details by name instead of ID

## Usage

### Resolve name to ID:
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

# Resolve a task name
sb_api_call GET "/resolve/clickup/name/My%20Task%20Name"

# Resolve a list name
sb_api_call GET "/resolve/clickup/name/My%20List%20Name"
```

## Response
```json
{
  "id": "123456789",
  "cached": false
}
```

## Parameters
- source: "clickup" (or "linear" for Linear issues)
- name: URL-encoded name to resolve

## Notes
- Results are cached for 30 seconds to reduce API calls
- Cached responses include `"cached": true`
