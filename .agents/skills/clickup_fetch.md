---
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
while [ "$CUR" != "/" ] && [ ! -f "$CUR/.switchboard/api-server-port.txt" ]; do CUR=$(dirname "$CUR"); done
PORT=$(cat "$CUR/.switchboard/api-server-port.txt" 2>/dev/null)

if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

# Resolve a task name
curl -s http://localhost:$PORT/resolve/clickup/name/My%20Task%20Name

# Resolve a list name
curl -s http://localhost:$PORT/resolve/clickup/name/My%20List%20Name
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
