---
description: Make direct ClickUp API calls via LocalApiServer proxy
---

# ClickUp API Proxy

## When to Use
- Need to make custom ClickUp API calls not covered by specific skills
- Direct API access required for advanced operations

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -f "$CUR/.switchboard/api-server-port.txt" ]; do CUR=$(dirname "$CUR"); done
PORT=$(cat "$CUR/.switchboard/api-server-port.txt" 2>/dev/null)

if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

curl -s -X POST http://localhost:$PORT/api/clickup \
  -H "Content-Type: application/json" \
  -d '{
    "method": "GET",
    "endpoint": "/v2/task/12345",
    "query": {},
    "body": null
  }'
```

## Parameters
- method: HTTP method (GET, POST, PUT, DELETE)
- endpoint: ClickUp API endpoint path (e.g., "/v2/task/12345")
- query: Optional query parameters object
- body: Optional request body object

## Response
JSON response from ClickUp API or error object with `error` field.
