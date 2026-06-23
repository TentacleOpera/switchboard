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
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call POST /api/linear \
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
