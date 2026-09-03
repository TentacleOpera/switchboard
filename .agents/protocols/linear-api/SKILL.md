# Linear API Proxy

## When to Use
- Need to make custom Linear GraphQL queries not covered by specific skills
- Direct API access required for advanced operations

## Usage
```bash
switchboard api POST /api/linear '{
  "query": "query { issues(first: 10) { nodes { id title } } }"
}'
```

## Parameters
- query: GraphQL query string (required)
- variables: Optional GraphQL variables object

## Response
JSON response from Linear API or error object with `error` field.

## Post a Comment (use this for replies / questions / triage verdicts)
Always post comments through the dedicated `/comment` route — NOT a raw `commentCreate`
GraphQL call. The host adds the hidden `<!-- switchboard -->` self-marker so the inbound
poll skips your own comment and you don't trigger a feedback loop. The token stays host-side.

```bash
switchboard api POST /comment '{
  "provider": "linear",
  "id": "<Linear Issue ID UUID from the plan metadata>",
  "body": "Your comment text here."
}'
```

- provider: "linear"
- id: the issue UUID (the `**Linear Issue ID:**` line in the plan file), NOT the ENG-123 identifier
- body: the comment markdown. Do not add any marker yourself — the host stamps it.
