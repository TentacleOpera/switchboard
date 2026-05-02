---
description: Phase 3 - Add file attachments, doc pages, and diagram generation to LocalApiServer
---

# Phase 3: File Attachments and Diagrams

## Goal
Add file attachment, doc page creation, and diagram generation endpoints to LocalApiServer, completing the MCP tool migration with optional external dependencies and graceful degradation.

## Metadata
**Tags:** infrastructure, backend, workflow
**Complexity:** 6
**Repo:** switchboard

## User Review Required
None - internal tooling; mermaid-cli installation optional

## Complexity Audit

### Routine
- Create 3 skill documentation files (clickup_attach.md, clickup_create_subpage.md, generate_diagram.md)
- Update AGENTS.md skills table
- Base64 file upload handling (simpler than multipart)

### Complex / Risky
- File upload size limits and validation
- Optional mermaid-cli dependency with graceful degradation
- Diagram generation with temp file management (collision prevention)
- Doc page creation in ClickUp (complex API)
- Security: file upload validation (type, size, content)

## Edge-Case & Dependency Audit

**Race Conditions:** 
- Concurrent file uploads may hit rate limits
- Temp file cleanup may conflict with concurrent diagram generation if names collide
- Mitigation: Unique temp filenames with crypto random IDs; proper cleanup in finally blocks

**Security:** 
- File upload validation required (size limits, allowed types)
- Base64 decoding errors handled gracefully
- Authentication strictly enforced (same as Phase 2)
- Temp files written to system temp dir (not project directory)

**Side Effects:**
- Files uploaded to ClickUp tasks
- Doc pages created in ClickUp
- Temp files created/deleted in system temp directory

**Dependencies & Conflicts:**
- Depends on Phase 1 (sess_1777642403254) and Phase 2 (sess_1777642418579).
- Optional: mermaid-cli binary in PATH.
- Kanban query shows no conflicts with unrelated active features (no overlapping file edits detected in backlog/planned columns).

## Dependencies
sess_1777642403254 — Phase 1: API Proxy Endpoints and Name Resolution
sess_1777642418579 — Phase 2: Task Operations (Create and Modify)

## Adversarial Synthesis
Key risks: mermaid-cli dependency is heavy and may not be available in all environments; `Date.now()` temp file names could collide on concurrent requests causing cleanup races; file uploads buffer heavily in memory. Mitigations: Make diagram generation optional with text fallback; use `crypto.randomUUID()` for guaranteed unique temp file names; enforce a strict 10MB payload size limit to prevent out-of-memory errors.

## Proposed Changes

### [Target File] `src/services/LocalApiServer.ts`

**Context:** Add file attachment, doc page, and diagram generation endpoints.

**Logic:**
1. File attachment endpoint with Base64 decoding
2. Doc page creation endpoint
3. Diagram generation with optional mermaid-cli and crypto-safe temp files

**Implementation:**

1. Add file size limit constant:
```typescript
// Add at class level (after line ~17)
private readonly _MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
```

2. Implement file attachment endpoint:
```typescript
} else if (pathname.startsWith('/task/clickup/') && pathname.endsWith('/attach') && req.method === 'POST') {
    const taskId = pathname.split('/')[3];
    await this._handleAttachFile(taskId, req, res);
```

3. Implement handler:
```typescript
private async _handleAttachFile(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!await this._checkAuth(req, true)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }
    
    const service = this._options.getClickUpService();
    if (!service) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ClickUp service not available' }));
        return;
    }

    try {
        const body = await this._parseJsonBody(req);
        const { fileName, fileDataBase64, comment } = body;
        
        // Validation
        if (!fileName || !fileDataBase64) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required fields: fileName and fileDataBase64' }));
            return;
        }
        
        // Check file size (Base64 is ~4/3 of binary size)
        const estimatedSize = (fileDataBase64.length * 3) / 4;
        if (estimatedSize > this._MAX_FILE_SIZE_BYTES) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'File too large',
                maxSize: `${this._MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`,
                receivedSize: `${(estimatedSize / 1024 / 1024).toFixed(2)}MB`
            }));
            return;
        }
        
        // Validate file extension
        const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.txt', '.md', '.json'];
        const ext = path.extname(fileName).toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'File type not allowed',
                allowedTypes: allowedExtensions
            }));
            return;
        }
        
        // Decode Base64
        let buffer: Buffer;
        try {
            buffer = Buffer.from(fileDataBase64, 'base64');
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid Base64 data' }));
            return;
        }
        
        // Upload via service
        const result = await service.attachFile(taskId, fileName, buffer, comment);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            url: result.url,
            fileName: result.fileName,
            size: buffer.length
        }));
    } catch (err) {
        console.error('[LocalApiServer] File attachment error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Upload failed' }));
    }
}
```

4. Implement doc page creation endpoint:
```typescript
} else if (pathname === '/doc/clickup' && req.method === 'POST') {
    await this._handleCreateDocPage(req, res);
```

5. Implement handler:
```typescript
private async _handleCreateDocPage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!await this._checkAuth(req, true)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }
    
    const service = this._options.getClickUpService();
    if (!service) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ClickUp service not available' }));
        return;
    }

    try {
        const body = await this._parseJsonBody(req);
        const { workspaceId, docId, pageName, content, parentPageId } = body;
        
        // Validation
        if (!docId || !pageName || !content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required fields: docId, pageName, content' }));
            return;
        }
        
        const result = await service.createDocPage({
            workspaceId,
            docId,
            pageName,
            content,
            parentPageId
        });
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            pageId: result.id,
            url: result.url,
            docId,
            pageName
        }));
    } catch (err) {
        console.error('[LocalApiServer] Doc page creation error:', err);
        // CLARIFICATION: Provide detailed error for doc API which can be finicky
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: err instanceof Error ? err.message : 'Doc page creation failed',
            hint: 'Ensure docId is valid and you have write access to the document'
        }));
    }
}
```

6. Implement diagram generation with mermaid-cli detection:
```typescript
// Add at class level (after line ~17)
private _mermaidCliAvailable: boolean | null = null;

} else if (pathname === '/diagram/generate' && req.method === 'POST') {
    await this._handleGenerateDiagram(req, res);
```

7. Implement handler with graceful degradation and safe temp files:
```typescript
private async _checkMermaidCli(): Promise<boolean> {
    if (this._mermaidCliAvailable !== null) {
        return this._mermaidCliAvailable;
    }
    try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        // Check for mmdc (mermaid-cli binary)
        const cmd = process.platform === 'win32' ? 'where mmdc' : 'which mmdc';
        await execAsync(cmd);
        this._mermaidCliAvailable = true;
    } catch {
        this._mermaidCliAvailable = false;
    }
    return this._mermaidCliAvailable;
}

private _generateMermaidSyntax(diagramType: string, maxNodes: number, focusPath?: string): string {
    // CLARIFICATION: This is a placeholder - actual implementation depends on ArchitectureAnalyzer
    // Generate Mermaid syntax based on diagram type (flowchart, sequence, component)
    return `graph TD\nA[Start] --> B[End]`; // Simplified example
}

private async _handleGenerateDiagram(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!await this._checkAuth(req, true)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }
    
    try {
        const body = await this._parseJsonBody(req);
        const { diagramType, maxNodes, focusPath, detailLevel, targetId, platform } = body;
        
        // Validate required fields
        if (!diagramType) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: diagramType' }));
            return;
        }
        
        // Generate Mermaid syntax (always available)
        const mermaidSyntax = this._generateMermaidSyntax(diagramType, maxNodes || 50, focusPath);
        
        // Check if mermaid-cli is available
        const canRender = await this._checkMermaidCli();
        
        if (!canRender) {
            // CLARIFICATION: Graceful degradation - return syntax with clear instructions
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                rendered: false,
                warning: 'mermaid-cli not installed. Install with: npm install -g @mermaid-js/mermaid-cli',
                mermaidSyntax: mermaidSyntax,
                installCommand: 'npm install -g @mermaid-js/mermaid-cli'
            }));
            return;
        }
        
        // Render using mermaid-cli
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        const os = require('os');
        const crypto = require('crypto');
        
        // CLARIFICATION: Use crypto.randomUUID() to prevent temp file collision race conditions
        const safeId = crypto.randomUUID();
        const tempPath = path.join(os.tmpdir(), `diagram-${safeId}.mmd`);
        const tempOutputPath = `${tempPath}.png`;
        
        // Write Mermaid syntax to temp file
        await fs.writeFile(tempPath, mermaidSyntax);
        
        try {
            // Render with mermaid-cli
            await execAsync(`mmdc -i "${tempPath}" -o "${tempOutputPath}" -b transparent`);
            
            // Read rendered image
            const imageBuffer = await fs.readFile(tempOutputPath);
            
            // Upload to platform if target provided
            if (targetId && platform) {
                let uploadResult;
                if (platform === 'clickup') {
                    const service = this._options.getClickUpService();
                    if (!service) throw new Error('ClickUp service not available');
                    uploadResult = await service.attachFile(targetId, 'diagram.png', imageBuffer, 'Generated diagram');
                } else if (platform === 'linear') {
                    const service = this._options.getLinearService();
                    if (!service) throw new Error('Linear service not available');
                    uploadResult = await service.uploadAttachment(targetId, imageBuffer, 'diagram.png');
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    rendered: true, 
                    url: uploadResult?.url,
                    uploadedTo: platform,
                    targetId
                }));
            } else {
                // Return image directly
                res.writeHead(200, { 
                    'Content-Type': 'image/png',
                    'Content-Disposition': 'attachment; filename="diagram.png"'
                });
                res.end(imageBuffer);
            }
        } catch (renderErr) {
            // CLARIFICATION: Render failure still returns syntax
            console.warn('[LocalApiServer] Diagram render failed:', renderErr);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                rendered: false,
                warning: 'Render failed: ' + (renderErr instanceof Error ? renderErr.message : 'Unknown error'),
                mermaidSyntax: mermaidSyntax,
                renderError: renderErr instanceof Error ? renderErr.message : 'Unknown'
            }));
        } finally {
            // Cleanup temp files
            await fs.unlink(tempPath).catch(() => {});
            await fs.unlink(tempOutputPath).catch(() => {});
        }
    } catch (err) {
        console.error('[LocalApiServer] Diagram generation error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Diagram generation failed' }));
    }
}
```

**Edge Cases Handled:**
- File size validation (413 Payload Too Large)
- File type validation (400 with allowed types list)
- Invalid Base64 handling (400 Bad Request)
- mermaid-cli not installed (200 with text fallback, not error)
- Render failure still returns Mermaid syntax
- Temp file collision prevented with UUIDs
- Temp file cleanup in finally block
- Service unavailable (503) for all operations

### [Target Directory] `.agent/skills/`

**Context:** Create 3 skill files for file attachments, doc pages, and diagrams.

**Logic:** Create skill files with proper error handling and graceful degradation.

**Implementation:**

1. **clickup_attach.md**:
```markdown
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
PORT=$(cat .switchboard/api-server-port.txt 2>/dev/null)
if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

TOKEN=$(curl -s http://localhost:$PORT/config/token 2>/dev/null || echo "")

# Encode file as Base64
FILE_BASE64=$(base64 -i "./screenshot.png")

curl -s -X POST "http://localhost:$PORT/task/clickup/$TASK_ID/attach" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"fileName\": \"screenshot.png\",
    \"fileDataBase64\": \"$FILE_BASE64\",
    \"comment\": \"Screenshot of issue\""
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
```

2. **clickup_create_subpage.md**:
```markdown
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
PORT=$(cat .switchboard/api-server-port.txt 2>/dev/null)
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
```

3. **generate_diagram.md**:
```markdown
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
PORT=$(cat .switchboard/api-server-port.txt 2>/dev/null)
if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

TOKEN=$(curl -s http://localhost:$PORT/config/token 2>/dev/null || echo "")

# Generate and upload to ClickUp task
curl -s -X POST http://localhost:$PORT/diagram/generate \
  -H "Authorization: Bearer $TOKEN" \
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
```

**Edge Cases Handled:**
- Port file missing detection
- Token retrieval
- mermaid-cli optional handling
- Base64 file encoding instructions
- Doc page creation error hints

### [Target File] `AGENTS.md`

**Context:** Add new skills to Available Skills table.

**Logic:** Insert 3 new skill entries in alphabetical order.

**Implementation:**
Add to skills table:
```markdown
| `clickup_attach` | Attach files to ClickUp tasks via LocalApiServer (replaces clickup_attach) |
| `clickup_create_subpage` | Create doc pages in ClickUp via LocalApiServer (replaces clickup_create_subpage) |
| `generate_diagram` | Generate architectural diagrams via LocalApiServer (replaces generate_architectural_diagram) |
```

**Edge Cases Handled:** None - documentation only.

### [Target File] `package.json` (Optional)

**Context:** Document optional dependency.

**Logic:** Add mermaid-cli as optional peer dependency or devDependency.

**Implementation:**
```json
{
  "devDependencies": {
    "@mermaid-js/mermaid-cli": "^10.0.0"
  },
  "peerDependenciesMeta": {
    "@mermaid-js/mermaid-cli": {
      "optional": true
    }
  }
}
```

**Edge Cases Handled:** Optional dependency won't fail install if unavailable.

## Verification Plan

### Automated Tests
- Unit test: File attachment with size validation
- Unit test: File type validation (reject .exe)
- Unit test: Invalid Base64 handling
- Unit test: Doc page creation
- Unit test: Diagram generation without mermaid-cli (graceful degradation)
- Unit test: Diagram generation with mermaid-cli (if available)
- Unit test: Temp file cleanup and collision avoidance verification

### Manual Verification
1. Test file attachment:
   ```bash
   PORT=$(cat .switchboard/api-server-port.txt)
   TOKEN=$(curl -s http://localhost:$PORT/config/token)
   
   # Create a small test file
   echo "Test content" > /tmp/test.txt
   FILE_B64=$(base64 -i /tmp/test.txt)
   
   curl -X POST "http://localhost:$PORT/task/clickup/YOUR_TASK_ID/attach" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d "{\"fileName\": \"test.txt\", \"fileDataBase64\": \"$FILE_B64\"}"
   ```

2. Test without mermaid-cli (should return syntax):
   ```bash
   curl -X POST http://localhost:$PORT/diagram/generate \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"diagramType": "flowchart"}'
   ```

3. Install mermaid-cli and test again (should render image):
   ```bash
   npm install -g @mermaid-js/mermaid-cli
   # Restart VS Code, test again
   ```

4. Test doc page creation
5. Test file size limit (try uploading >10MB file)

## Rollback Plan
- If issues, revert to using MCP tools for these operations
- All phases 1 and 2 functionality remains intact
- Document mermaid-cli as optional in troubleshooting guide

---

**Agent Recommendation:** Send to Coder (Complexity 6)
