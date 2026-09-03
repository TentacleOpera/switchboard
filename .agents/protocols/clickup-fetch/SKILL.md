# ClickUp Fetch with Name Resolution

## When to Use
- Need to resolve a task/list name to its ID
- Fetch task details by name instead of ID

## Usage

### Resolve name to ID:
```bash
# Resolve a task name
switchboard api GET "/resolve/clickup/name/My%20Task%20Name"

# Resolve a list name
switchboard api GET "/resolve/clickup/name/My%20List%20Name"
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
