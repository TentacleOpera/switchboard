---
description: Make direct Linear GraphQL API calls via LocalApiServer proxy
---

# Linear API Proxy

## When to Use
- Need to make custom Linear GraphQL queries not covered by specific skills
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

curl -s -X POST http://localhost:$PORT/api/linear \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query { issues(first: 10) { nodes { id title } } }"
  }'
```

## Parameters
- query: GraphQL query string (required)
- variables: Optional GraphQL variables object

## Response
JSON response from Linear API or error object with `error` field.
