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
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call POST /doc/clickup \
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
