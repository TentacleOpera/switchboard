---
description: Generate architectural diagrams via LocalApiServer
---

# Generate Architectural Diagram

## When to Use
- User asks for an architecture diagram
- Need to visualize code structure or relationships

## Prerequisites
- Optional: mermaid-cli installed (`npm install -g @mermaid-js/mermaid-cli`)
- Without mermaid-cli: Returns Mermaid syntax text instead of image

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

# Generate and upload to ClickUp task
sb_api_call POST /diagram/generate \
  -H "Content-Type: application/json" \
  -d '{
    "diagramType": "flowchart",
    "maxNodes": 30,
    "focusPath": "src/services/",
    "targetId": "task123456",
    "platform": "clickup"
  }'
```

## Parameters
- **diagramType** (required): "flowchart", "sequence", or "component"
- **maxNodes** (optional): Maximum nodes to include (default: 50)
- **focusPath** (optional): Relative path to focus analysis on
- **targetId** (optional): Task/issue ID to upload to
- **platform** (optional): "clickup" or "linear" (required if targetId provided)

## Response

### With mermaid-cli installed:
```json
{
  "success": true,
  "rendered": true,
  "url": "https://..."
}
```

### Without mermaid-cli:
```json
{
  "success": true,
  "rendered": false,
  "warning": "mermaid-cli not installed...",
  "mermaidSyntax": "graph TD\nA --> B",
  "installCommand": "npm install -g @mermaid-js/mermaid-cli"
}
```

## Error Handling
- 400: Missing diagramType
- 401: Unauthorized
- 500: Generation failed
- 503: Service unavailable
