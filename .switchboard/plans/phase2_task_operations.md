---
description: Phase 2 - Add task creation and modification endpoints to LocalApiServer with full authentication
---

# Phase 2: Task Operations (Create and Modify)

## Goal
Add task creation and modification endpoints to LocalApiServer with strict authentication enforcement, replacing clickup_create_task and clickup_modify_task MCP tools.

## Metadata
**Tags:** infrastructure, backend, workflow
**Complexity:** 6
**Repo:** switchboard

## User Review Required
None - internal tooling

## Complexity Audit

### Routine
- Create 2 skill documentation files (clickup_create_task.md, clickup_modify_task.md)
- Update AGENTS.md skills table

### Complex / Risky
- First write operations in LocalApiServer (data mutation)
- Strict authentication enforcement (breaking change from Phase 1)
- Task creation with optional subtask handling (reporting partial failures)
- Task update with partial field updates
- Input validation for write operations

## Edge-Case & Dependency Audit

**Race Conditions:** 
- Concurrent task creation with same name could create duplicates
- Mitigation: ClickUp API handles uniqueness; we pass through errors

**Security:** 
- **CRITICAL:** Authentication now strictly enforced (Phase 1 was permissive)
- API token required via VS Code SecretStorage
- No hardcoded fallback tokens
- All write operations require valid Bearer token

**Side Effects:**
- Tasks will be created/updated in ClickUp
- Failed operations may leave partial state (ClickUp handles this)

**Dependencies & Conflicts:**
- Depends on Phase 1 (sess_1777642403254). 
- Blocks Phase 3 (sess_1777642442632). 
- Kanban query shows no conflicts with unrelated active features (no overlapping file edits detected in backlog/planned columns).

## Dependencies
sess_1777642403254 — Phase 1: API Proxy Endpoints and Name Resolution

## Adversarial Synthesis
Key risks: Strict auth enforcement may break workflows relying on Phase 1 permissive mode; subtask creation could partially fail, leaving inconsistent state. Mitigations: Document auth setup requirements clearly; track and report failed subtasks explicitly in the response payload rather than failing silently; rely on upstream API for field validation.

## Proposed Changes

### [Target File] `src/services/LocalApiServer.ts`

**Context:** Add task creation and modification endpoints with strict authentication.

**Logic:**
1. Enable strict authentication enforcement (breaking change from Phase 1)
2. Add task creation endpoint with transparent partial failure reporting for subtasks
3. Add task update endpoint with partial field support

**Implementation:**

1. Update authentication check to enforce strictly:
```typescript
// Modify _checkAuth (line ~82-90) - NOW ENFORCED
private async _checkAuth(req: http.IncomingMessage, requireAuth: boolean = true): Promise<boolean> {
    const authHeader = req.headers['authorization'];
    const expectedToken = await this._options.getAuthToken();
    
    // CLARIFICATION: Phase 2 - strict enforcement for write operations
    if (!expectedToken) {
        if (requireAuth) {
            return false; // No token configured, deny write operations
        }
        return true; // Allow read-only if no token (backward compat)
    }
    
    return authHeader === `Bearer ${expectedToken}`;
}
```

2. Implement task creation endpoint:
```typescript
} else if (pathname === '/task/clickup' && req.method === 'POST') {
    await this._handleCreateClickUpTask(req, res);
```

3. Implement handler:
```typescript
private async _handleCreateClickUpTask(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CLARIFICATION: Strict auth enforcement for write operations
    if (!await this._checkAuth(req, true)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'Unauthorized',
            detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
        }));
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
        const { name, listId, description, assignees, dueDate, subtasks } = body;
        
        // Validation
        if (!name || !listId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required fields: name and listId' }));
            return;
        }
        
        // Create parent task first
        const parentTask = await service.createTask({
            name,
            listId,
            description,
            assignees,
            dueDate
        });
        
        // Create subtasks if provided
        let createdSubtasks: any[] = [];
        let failedSubtasks: any[] = [];
        
        if (subtasks && Array.isArray(subtasks) && subtasks.length > 0) {
            for (let i = 0; i < subtasks.length; i++) {
                const subtask = subtasks[i];
                try {
                    const created = await service.createTask({
                        name: subtask.name,
                        listId,
                        description: subtask.description,
                        assignees: subtask.assignees,
                        dueDate: subtask.dueDate,
                        parent: parentTask.id
                    });
                    createdSubtasks.push(created);
                } catch (err) {
                    console.warn(`[LocalApiServer] Subtask creation failed for index ${i}:`, err);
                    // CLARIFICATION: Record failed subtasks instead of failing silently
                    failedSubtasks.push({
                        index: i,
                        name: subtask.name,
                        error: err instanceof Error ? err.message : String(err)
                    });
                }
            }
        }
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            task: parentTask,
            subtasks: createdSubtasks,
            subtaskCount: createdSubtasks.length,
            failedSubtasks: failedSubtasks.length > 0 ? failedSubtasks : undefined
        }));
    } catch (err) {
        console.error('[LocalApiServer] Task creation error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task creation failed' }));
    }
}
```

4. Implement task update endpoint:
```typescript
} else if (pathname.startsWith('/task/clickup/') && req.method === 'PUT') {
    const taskId = pathname.split('/')[3];
    await this._handleUpdateClickUpTask(taskId, req, res);
```

5. Implement handler with partial updates:
```typescript
private async _handleUpdateClickUpTask(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!await this._checkAuth(req, true)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'Unauthorized',
            detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
        }));
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
        
        // CLARIFICATION: Build update payload only with provided fields
        const updatePayload: any = {};
        
        if ('name' in body) updatePayload.name = body.name;
        if ('description' in body) updatePayload.description = body.description;
        if ('status' in body) updatePayload.status = body.status;
        if ('assignees' in body) updatePayload.assignees = body.assignees;
        if ('dueDate' in body) updatePayload.due_date = body.dueDate;
        if ('priority' in body) updatePayload.priority = body.priority;
        if ('tags' in body) updatePayload.tags = body.tags;
        
        // Validate at least one field provided
        if (Object.keys(updatePayload).length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No fields provided for update' }));
            return;
        }
        
        const result = await service.updateTask(taskId, updatePayload);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            task: result,
            updatedFields: Object.keys(updatePayload)
        }));
    } catch (err) {
        console.error('[LocalApiServer] Task update error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task update failed' }));
    }
}
```

**Edge Cases Handled:**
- Strict 401 for unauthorized write operations with helpful setup message
- 400 Bad Request for missing required fields
- Partial subtask creation failure doesn't fail parent task, but surface errors explicitly
- Partial updates (only send fields that were provided)
- Service unavailable (503) with clear error message

### [Target Directory] `.agent/skills/`

**Context:** Create 2 skill files for task operations.

**Logic:** Create skill files with full authentication handling.

**Implementation:**

1. **clickup_create_task.md**:
```markdown
---
description: Create ClickUp tasks with optional subtasks via LocalApiServer
---

# Create ClickUp Task

## When to Use
- User asks to create a ClickUp task
- Plan requires task creation with subtasks

## Prerequisites
VS Code setting `switchboard.apiToken` must be configured with your API token.

## Usage
```bash
PORT=$(cat .switchboard/api-server-port.txt 2>/dev/null)
if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

# Get token from VS Code SecretStorage
TOKEN=$(curl -s http://localhost:$PORT/config/token 2>/dev/null || echo "")

curl -s -X POST http://localhost:$PORT/task/clickup \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Task name",
    "listId": "list123",
    "description": "Task description",
    "assignees": [12345],
    "dueDate": "2025-12-31",
    "subtasks": [
      {"name": "Subtask 1"},
      {"name": "Subtask 2", "description": "Details"}
    ]
  }'
```

## Parameters
- **name** (required): Task name
- **listId** (required): ClickUp list ID
- **description** (optional): Task description
- **assignees** (optional): Array of user IDs
- **dueDate** (optional): Due date in YYYY-MM-DD format
- **subtasks** (optional): Array of subtask objects (name required, others optional)

## Response
```json
{
  "success": true,
  "task": { "id": "...", "name": "..." },
  "subtasks": [...],
  "subtaskCount": 2,
  "failedSubtasks": [] // Only present if some subtasks failed to create
}
```

## Error Handling
- 401 Unauthorized: Token not configured
- 400 Bad Request: Missing name or listId
- 503: ClickUp service unavailable
```

2. **clickup_modify_task.md**:
```markdown
---
description: Update ClickUp task properties via LocalApiServer
---

# Modify ClickUp Task

## When to Use
- User asks to update a task
- Need to change task status, assignees, priority, etc.

## Prerequisites
VS Code setting `switchboard.apiToken` must be configured.

## Usage
```bash
PORT=$(cat .switchboard/api-server-port.txt 2>/dev/null)
if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

TOKEN=$(curl -s http://localhost:$PORT/config/token 2>/dev/null || echo "")

curl -s -X PUT "http://localhost:$PORT/task/clickup/$TASK_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "in progress",
    "assignees": [12345],
    "priority": 2
  }'
```

## Parameters (provide at least one)
- **name**: New task name
- **description**: New description
- **status**: Status name (e.g., "to do", "in progress", "done")
- **assignees**: Array of user IDs to set as assignees
- **dueDate**: Due date in YYYY-MM-DD format
- **priority**: 1 (urgent), 2 (high), 3 (normal), 4 (low)
- **tags**: Array of tag names to apply

## Response
```json
{
  "success": true,
  "task": { "id": "...", ... },
  "updatedFields": ["status", "assignees", "priority"]
}
```

## Error Handling
- 401 Unauthorized: Token not configured
- 400 Bad Request: No fields provided
- 503: ClickUp service unavailable
```

**Edge Cases Handled:**
- Port file missing detection
- Token retrieval from `/config/token` endpoint
- 401 error handling with setup instructions
- Partial field updates (no need to send all fields)

### [Target File] `AGENTS.md`

**Context:** Add new skills to Available Skills table.

**Logic:** Insert 2 new skill entries in alphabetical order.

**Implementation:**
Add to skills table:
```markdown
| `clickup_create_task` | Create ClickUp tasks with optional subtasks via LocalApiServer (replaces clickup_create_task) |
| `clickup_modify_task` | Update ClickUp task properties via LocalApiServer (replaces clickup_modify_task) |
```

**Edge Cases Handled:** None - documentation only.

### [Target File] `src/services/ClickUpSyncService.ts` (Optional Enhancement)

**Context:** Add helper methods if not already present.

**Logic:** Ensure service has `createTask` and `updateTask` methods.

**Implementation:**
If methods don't exist, add:
```typescript
async createTask(params: {
    name: string;
    listId: string;
    description?: string;
    assignees?: number[];
    dueDate?: string;
    parent?: string;
}): Promise<any> {
    // Implementation using ClickUp API
}

async updateTask(taskId: string, updates: any): Promise<any> {
    // Implementation using ClickUp API PUT /v2/task/{taskId}
}
```

**Edge Cases Handled:**
- Parent task ID for subtasks
- Date format conversion
- Assignee array validation

## Verification Plan

### Automated Tests
- Unit test: Auth enforcement (401 when no token)
- Unit test: Task creation with all fields
- Unit test: Task creation with subtasks, including explicit failure reporting
- Unit test: Task creation validation (400 on missing fields)
- Unit test: Task update with partial fields
- Unit test: Task update validation (400 on empty body)

### Manual Verification
1. Configure token: VS Code settings → Switchboard: Api Token
2. Reload VS Code window
3. Test task creation:
   ```bash
   PORT=$(cat .switchboard/api-server-port.txt)
   TOKEN=$(curl -s http://localhost:$PORT/config/token)
   curl -X POST http://localhost:$PORT/task/clickup \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name": "Test Task", "listId": "YOUR_LIST_ID"}'
   ```
4. Test without token (should fail 401)
5. Test task update
6. Verify subtask creation works

## Rollback Plan
- If issues, revert to using MCP tools for task operations
- Phase 1 endpoints remain functional (read-only)
- Document fallback procedure in AGENTS.md

---

**Agent Recommendation:** Send to Coder (Complexity 6)
