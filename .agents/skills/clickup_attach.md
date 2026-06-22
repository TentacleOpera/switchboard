---
description: Attach files to ClickUp tasks via LocalApiServer
---

# Attach File to ClickUp Task

## When to Use
- User asks to attach a file to a task
- Need to upload screenshots, documents, or other files

## Prerequisites
- VS Code setting `switchboard.apiToken` configured
- File must be under 10MB
- Allowed types: .png, .jpg, .jpeg, .gif, .pdf, .txt, .md, .json

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

# Encode file as Base64 (macOS/Linux)
FILE_BASE64=$(base64 -i "./screenshot.png" | tr -d '\n')

curl -s -X POST "http://localhost:$PORT/task/clickup/$TASK_ID/attach" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"fileName\": \"screenshot.png\",
    \"fileDataBase64\": \"$FILE_BASE64\",
    \"comment\": \"Screenshot of issue\"
  }"
```

## Parameters
- **fileName** (required): Name of the file with extension
- **fileDataBase64** (required): Base64-encoded file content
- **comment** (optional): Comment to accompany attachment

## Response
```json
{
  "success": true,
  "url": "https://...",
  "fileName": "screenshot.png",
  "size": 12345
}
```

## Error Handling
- 400: Invalid file type or missing fields
- 401: Unauthorized
- 413: File too large (>10MB)
- 503: ClickUp service unavailable
