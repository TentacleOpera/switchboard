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
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call POST /api/clickup \
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
