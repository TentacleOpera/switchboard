---
description: Create doc pages in ClickUp via LocalApiServer
---

# Create ClickUp Doc Subpage

## When to Use
- User asks to create a doc page
- Plan requires documentation creation in ClickUp

## Prerequisites
- VS Code setting `switchboard.apiToken` configured
- Valid docId from an existing ClickUp doc

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -f "$CUR/.switchboard/api-server-port.txt" ]; do CUR=$(dirname "$CUR"); done
PORT=$(cat "$CUR/.switchboard/api-server-port.txt" 2>/dev/null)

if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

TOKEN=$(curl -s http://localhost:$PORT/config/token 2>/dev/null || echo "")

curl -s -X POST http://localhost:$PORT/doc/clickup \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "docId": "doc123456",
    "pageName": "Architecture Overview",
    "content": "# Architecture\n\nThis system consists of...",
    "parentPageId": "page789"
  }'
```

## Parameters
- **docId** (required): ClickUp doc ID
- **pageName** (required): Name for the new page
- **content** (required): Page content in Markdown
- **parentPageId** (optional): Parent page ID for nested pages

## Response
```json
{
  "success": true,
  "pageId": "page987654",
  "url": "https://app.clickup.com/...",
  "docId": "doc123456",
  "pageName": "Architecture Overview"
}
```

## Error Handling
- 400: Missing required fields
- 401: Unauthorized
- 500: Doc creation failed (check docId and permissions)
- 503: ClickUp service unavailable
