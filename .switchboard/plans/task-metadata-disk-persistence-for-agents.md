# Task Metadata Disk Persistence and Local API for Agent Access
 
Store minimal ClickUp/Linear task metadata (ID, name, status, sprint, list/project) to JSON files and expose a local HTTP API endpoint so agents can read ticket identifiers and fetch full details without calling the MCP server.
 
## Goal
 
Enable agents to reliably talk about ClickUp/Linear tickets without needing the MCP server. Store minimal task metadata to disk so agents can quickly identify tickets (e.g., "tell me all ClickUp tickets this sprint without details"). When agents need full details, they call a local HTTP API endpoint that uses the extension's existing ClickUp/Linear credentials to fetch data from the API.
 
## Metadata
**Tags:** backend, database, devops, workflow, infrastructure
**Complexity:** 6
**Repo:** (single-repo)

## User Review Required

**Breaking Changes:** None. Metadata files and API server are new; existing cache behavior unchanged.

**Manual Steps:** None required. Metadata files and API server are created automatically on extension activation.

**Security Considerations:**
- HTTP server is bound to localhost only (127.0.0.1) — remote access is blocked
- Uses extension's existing ClickUp/Linear credentials — no additional credential setup
- Metadata files contain only non-sensitive identifiers (IDs, names, status) — no descriptions or comments

**Known Limitations:**
- Agents reading metadata may see data up to 500ms stale due to debounce (acceptable for use case)
- Full task details require fallback to MCP (local API only provides metadata)
- Windows: temp files from interrupted writes may accumulate until cleanup (cleanup logic added in Phase 2)

## Complexity Audit

### Routine
- Add JSON write methods to `PlanningPanelCacheService` for metadata persistence
- Debounce file writes to batch rapid cache updates (500ms)
- Create a local HTTP server in the extension (Node.js `http` module)
- Add API endpoints for metadata read (`/metadata/clickup`, `/metadata/linear`)
- Create a skill file in `.agent/skills/` for agent instruction
- Add `.gitignore` entries for metadata files (already covered by `.switchboard/*` but explicit is clearer)
- Add health endpoint (`/health`) for agent connectivity checks
- Implement temp file cleanup on server startup (handle Windows file locking edge cases)

### Complex / Risky
- HTTP server lifecycle management: start on activation, graceful stop on deactivation, error recovery, port conflict handling
- Concurrent read/write coordination: extension writes to JSON while server reads (mitigated by atomic write pattern)
- File size growth: unbounded metadata growth with many tasks (mitigated by cache TTL and LRU eviction)
- CORS handling: restrict to localhost only (current `http://localhost:*` pattern is invalid; use proper CORS headers)
- Port discovery race condition: agents may read port file before server writes it (mitigated by retry logic in skill)
- Windows file locking: atomic rename may fail if file is open (handled by graceful degradation + temp file cleanup)
- Stale data during cache invalidation: 500ms debounce window means agents may read pre-clear data (acceptable risk; agents check `writtenAt` timestamp)

## Edge-Case & Dependency Audit

### Race Conditions
1. **Port Discovery Race:** Agent may read `.switchboard/api-server-port.txt` before server writes it (during extension activation). Mitigation: Skill includes retry logic with exponential backoff; agents wait up to 5 seconds for port file.
2. **Read-While-Writing:** Server reads JSON while `PlanningPanelCacheService` is mid-write (temp file exists but rename pending). Mitigation: Atomic write pattern (write to `.tmp`, then rename); server handles ENOENT gracefully by returning empty metadata.
3. **Cache Invalidation Timing:** User triggers manual refresh → cache cleared → new data cached → 500ms debounce window → agent reads stale data. Mitigation: `clearAllTaskCache()` writes empty metadata IMMEDIATELY (no debounce); only cache updates are debounced.

### Security
1. **Localhost Binding:** Server binds to `127.0.0.1` only; remote addresses are rejected with 403. This prevents external network access.
2. **CORS Headers:** Current plan uses invalid `http://localhost:*` pattern. **Correction:** Use `Access-Control-Allow-Origin: *` or dynamically echo the Origin header. Since we're localhost-only, `*` is acceptable for this use case.
3. **No Authentication:** Any localhost process can access the API. Risk: malicious browser extensions or other VS Code extensions could read metadata. Mitigation: Metadata is minimal (IDs, names, status only — no sensitive data); scope is limited to task identifiers.
4. **File Permissions:** JSON files written with default permissions. On shared systems, other users could read metadata. Mitigation: Consider `fs.chmod` with 0o600 (owner read/write only) on metadata files.

### Side Effects
1. **Disk Usage:** Unbounded growth if never cleaned up. Mitigation: Metadata files are <100KB typical; LRU cache limits entries to 100; files are overwritten (not appended).
2. **Temp File Accumulation:** Crashes during write leave `.tmp` files. Mitigation: Cleanup on server startup — scan for `*.json.tmp` in `.switchboard/` and delete.
3. **Port File Leak:** If extension crashes, `api-server-port.txt` persists with stale port. Mitigation: Agents verify server is listening (health check) before trusting port file; overwrite port file on each startup.
4. **Subprocess Overhead:** Skill initially taught `curl` approach — creates subprocess per request. **Updated approach:** Teach agents to read JSON files directly via `fs.readFile` equivalent, eliminating subprocess overhead. Local HTTP server becomes fallback/optional.

### Dependencies & Conflicts
Kanban board query shows no active plans in CREATED, BACKLOG, or PLAN REVIEWED columns. No cross-plan conflicts detected. This plan builds on the existing `PlanningPanelCacheService` implementation for ticket caching.

## Dependencies
None

## Adversarial Synthesis
Key risks: HTTP server lifecycle management, CORS misconfiguration, temp file accumulation on Windows, stale data during debounce window. Mitigations: localhost-only binding with proper CORS, atomic file writes, startup temp cleanup, immediate write on cache clear. Complexity 6 — HTTP server lifecycle and cross-platform file semantics elevate this beyond routine changes.
 
## Problem Statement
 
Agents cannot access the sidebar's in-memory ticket cache. When an agent needs to identify tickets (e.g., list all tickets in a sprint), it must call the ClickUp/Linear MCP server, which hits the API even for simple queries. This is inefficient and adds dependency on the MCP server. The sidebar already tracks task metadata for UI display; making this metadata available to agents would reduce MCP dependency and latency for simple queries.
 
## Solution Overview
 
1. Store minimal task metadata (ID, name, status, sprint, list/project) to JSON files (`.switchboard/clickup-tasks.json` and `.switchboard/linear-tasks.json`) whenever the cache is updated
2. Expose a local HTTP API endpoint (localhost) that agents can call to:
   - Read the metadata JSON files
   - Fetch full task details from ClickUp/Linear API using the extension's existing credentials
3. Create a new skill that teaches agents how to call the local API endpoint
 
The JSON file contains only non-sensitive identifiers and metadata, minimizing security risk. The local API endpoint uses the extension's existing credentials, so no additional credential management is needed.
 
## Implementation Plan
 
### Phase 1: Add Metadata Persistence to PlanningPanelCacheService
 
#### [MODIFY] `src/services/PlanningPanelCacheService.ts`
 
**Context**: Extend the existing `PlanningPanelCacheService` class to write minimal task metadata to JSON files on cache updates. Use atomic write pattern (temp file + rename) to avoid corruption.
 
**Logic**:
1. Add private fields for metadata file paths (`.switchboard/clickup-tasks.json`, `.switchboard/linear-tasks.json`)
2. Add debounce timer for file writes (500ms)
3. Implement `_writeMetadataToJson()` that extracts minimal metadata from `_taskCache`
4. Call `_writeMetadataToJson()` debounced after every `cacheTasks()` call
5. Call `_writeMetadataToJson()` immediately after `clearAllTaskCache()` (write empty metadata)
6. Use atomic write: write to `.json.tmp`, then rename to `.json`
 
**Metadata structure** (minimal, non-sensitive):
```typescript
interface TaskMetadata {
    id: string;
    name: string;
    status: string;
    listId?: string;  // ClickUp
    projectId?: string;  // Linear
    sprint?: string;  // optional, if available
    lastUpdated: number;
}
```
 
**Implementation** (add private fields around line 36, after existing cache fields):
 
```typescript
// File paths for persisted metadata
private readonly _clickupMetadataPath: string;
private readonly _linearMetadataPath: string;
private _metadataWriteTimer: NodeJS.Timeout | null = null;
private readonly _metadataWriteDebounceMs = 500;
```
 
**Update constructor** (around line 38):
 
```typescript
constructor(workspaceRoot: string) {
    this._workspaceRoot = workspaceRoot;
    this._cacheBaseDir = path.join(workspaceRoot, '.switchboard', 'planning-cache');
    this._clickupMetadataPath = path.join(workspaceRoot, '.switchboard', 'clickup-tasks.json');
    this._linearMetadataPath = path.join(workspaceRoot, '.switchboard', 'linear-tasks.json');
}
```
 
**Add atomic write method**:
 
```typescript
/**
 * Write minimal task metadata to JSON files for agent access.
 * Uses atomic write pattern (temp file + rename) to avoid corruption.
 */
private async _writeMetadataToJson(): Promise<void> {
    if (this._metadataWriteTimer) {
        clearTimeout(this._metadataWriteTimer);
    }
    this._metadataWriteTimer = setTimeout(async () => {
        try {
            await this._writeMetadataFile(this._clickupMetadataPath, 'clickup');
            await this._writeMetadataFile(this._linearMetadataPath, 'linear');
        } catch (err) {
            console.warn('[PlanningPanelCache] Failed to write metadata to JSON:', err);
        }
    }, this._metadataWriteDebounceMs);
}
 
/**
 * Extract minimal metadata from cache entries for a specific source.
 */
private async _writeMetadataFile(filePath: string, sourceId: string): Promise<void> {
    const metadata: Array<{ id: string; name: string; status: string; listId?: string; projectId?: string; sprint?: string; lastUpdated: number }> = [];
    const prefix = `${sourceId}:`;
 
    for (const [fullKey, entry] of this._taskCache.entries()) {
        if (fullKey.startsWith(prefix)) {
            // Extract listId/projectId from cache key (format: "source:listId:..." or "source:projectId:...")
            const keyParts = fullKey.split(':');
            const listId = sourceId === 'clickup' ? keyParts[1] : undefined;
            const projectId = sourceId === 'linear' ? keyParts[1] : undefined;
 
            for (const task of entry.data) {
                metadata.push({
                    id: task.id,
                    name: task.name || '',
                    status: task.status || '',
                    listId,
                    projectId,
                    sprint: task.sprint || undefined,  // if available
                    lastUpdated: entry.timestamp
                });
            }
        }
    }
 
    const metadataObject = {
        version: 1,
        sourceId,
        metadata,
        writtenAt: Date.now()
    };
 
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(metadataObject, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, filePath);
}
```
 
**Modify `cacheTasks()`** (around line 470) to trigger write:
 
```typescript
public cacheTasks<T>(sourceId: string, key: string, data: T[]): void {
    // ... existing cache logic ...
 
    // Trigger debounced metadata write
    void this._writeMetadataToJson();
}
```
 
**Modify `clearAllTaskCache()`** (around line 561) to write empty metadata immediately:
 
```typescript
public async clearAllTaskCache(): Promise<void> {
    this._taskCache.clear();
    this._taskCacheLruList.length = 0;
 
    // Write empty metadata immediately (no debounce)
    try {
        await this._writeMetadataFile(this._clickupMetadataPath, 'clickup');
        await this._writeMetadataFile(this._linearMetadataPath, 'linear');
    } catch (err) {
        console.warn('[PlanningPanelCache] Failed to write empty metadata to JSON:', err);
    }
}
```
 
**Edge Cases Handled**:
- Atomic write prevents corruption if extension crashes mid-write
- Debounce prevents excessive I/O on rapid cache updates
- Write failures are logged but don't break cache operations (fail-open)
- Clear writes immediately (no debounce) to ensure metadata is cleared on disk
- Metadata is minimal (no descriptions, comments, attachments) to reduce security risk
 
### Phase 2: Create Local HTTP API Server
 
#### [CREATE] `src/services/LocalApiServer.ts`
 
**Context**: Create a local HTTP server that exposes endpoints for agents to read metadata and fetch full task details. The server uses the extension's existing ClickUp/Linear credentials.
 
**Implementation**:
 
```typescript
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { URL } from 'url';
 
interface LocalApiServerOptions {
    workspaceRoot: string;
    clickupMetadataPath: string;
    linearMetadataPath: string;
    getClickUpService: () => ClickUpSyncService | null;
    getLinearService: () => LinearSyncService | null;
}
 
export class LocalApiServer {
    private _server: http.Server | null = null;
    private _port: number;
    private _options: LocalApiServerOptions;
 
    constructor(options: LocalApiServerOptions) {
        this._options = options;
        this._port = 0; // Will be assigned on start
    }
 
    /**
     * Start the local API server on a random free port.
     * Returns the port number.
     */
    async start(): Promise<number> {
        return new Promise((resolve, reject) => {
            this._server = http.createServer(async (req, res) => {
                await this._handleRequest(req, res);
            });
 
            this._server.listen(0, '127.0.0.1', () => {
                const address = this._server?.address() as { port: number };
                this._port = address.port;
                console.log(`[LocalApiServer] Started on port ${this._port}`);
                
                // Write port to file for agent discovery
                this._writePortFile(this._port).catch(err => {
                    console.warn('[LocalApiServer] Failed to write port file:', err);
                });
 
                resolve(this._port);
            });
 
            this._server.on('error', (err) => {
                console.error('[LocalApiServer] Server error:', err);
                reject(err);
            });
        });
    }
 
    /**
     * Stop the local API server.
     */
    async stop(): Promise<void> {
        if (this._server) {
            return new Promise((resolve) => {
                this._server?.close(() => {
                    console.log('[LocalApiServer] Stopped');
                    resolve();
                });
            });
        }
    }
 
    /**
     * Write the server port to a file for agent discovery.
     */
    private async _writePortFile(port: number): Promise<void> {
        const portFilePath = path.join(this._options.workspaceRoot, '.switchboard', 'api-server-port.txt');
        await fs.promises.mkdir(path.dirname(portFilePath), { recursive: true });
        await fs.promises.writeFile(portFilePath, port.toString(), 'utf8');
    }
 
    /**
     * Handle incoming HTTP requests.
     */
    private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // Restrict to localhost only
        const remoteAddress = req.socket.remoteAddress;
        if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied: localhost only' }));
            return;
        }
 
        // Add CORS headers for localhost
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost:*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
 
        if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }
 
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const pathname = url.pathname;
 
        try {
            if (pathname === '/metadata/clickup') {
                await this._handleGetMetadata('clickup', res);
            } else if (pathname === '/metadata/linear') {
                await this._handleGetMetadata('linear', res);
            } else if (pathname.startsWith('/task/clickup/')) {
                const taskId = pathname.split('/')[3];
                await this._handleGetTask('clickup', taskId, res);
            } else if (pathname.startsWith('/task/linear/')) {
                const taskId = pathname.split('/')[3];
                await this._handleGetTask('linear', taskId, res);
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (err) {
            console.error('[LocalApiServer] Request error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }
 
    /**
     * Handle GET /metadata/{source} requests.
     */
    private async _handleGetMetadata(sourceId: string, res: http.ServerResponse): Promise<void> {
        const filePath = sourceId === 'clickup' 
            ? this._options.clickupMetadataPath 
            : this._options.linearMetadataPath;
 
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch {
            // File doesn't exist or is invalid — return empty metadata
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: 1, sourceId, metadata: [], writtenAt: Date.now() }));
        }
    }
 
    /**
     * Handle GET /task/{source}/{taskId} requests.
     */
    private async _handleGetTask(sourceId: string, taskId: string, res: http.ServerResponse): Promise<void> {
        if (sourceId === 'clickup') {
            const service = this._options.getClickUpService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'ClickUp service not available' }));
                return;
            }
            
            // Use the sync service to fetch task details
            // Note: This requires adding a getTaskById method to ClickUpSyncService
            // For now, return error — this can be implemented in a follow-up
            res.writeHead(501, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not implemented: use MCP for task details' }));
        } else if (sourceId === 'linear') {
            const service = this._options.getLinearService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Linear service not available' }));
                return;
            }
            
            // Similar to ClickUp — requires adding getIssueById method
            res.writeHead(501, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not implemented: use MCP for issue details' }));
        }
    }
}
```
 
**Note**: The `/task/{source}/{taskId}` endpoint is marked as "Not implemented" in this initial version. The primary use case is reading metadata to identify tickets. Full task details can be added in a follow-up by implementing `getTaskById`/`getIssueById` methods in the sync services.
 
### Phase 3: Wire LocalApiServer into TaskViewerProvider
 
#### [MODIFY] `src/services/TaskViewerProvider.ts`
 
**Context**: Start the local API server on extension activation and stop it on deactivation. The server needs access to the sync services to potentially fetch task details in the future.
 
**Implementation** (add import at top):
 
```typescript
import { LocalApiServer } from './LocalApiServer';
```
 
**Add private field** (around line 100, with other private fields):
 
```typescript
private _localApiServer: LocalApiServer | null = null;
```
 
**Add method to start server** (after constructor):
 
```typescript
/**
 * Start the local API server for agent access.
 */
private async _startLocalApiServer(): Promise<void> {
    const cacheService = this._getCacheService(this._workspaceRoot);
    
    this._localApiServer = new LocalApiServer({
        workspaceRoot: this._workspaceRoot,
        clickupMetadataPath: cacheService['_clickupMetadataPath'],
        linearMetadataPath: cacheService['_linearMetadataPath'],
        getClickUpService: () => this._clickUpServices.get(this._workspaceRoot) || null,
        getLinearService: () => this._linearServices.get(this._workspaceRoot) || null
    });
 
    try {
        await this._localApiServer.start();
    } catch (err) {
        console.error('[TaskViewerProvider] Failed to start local API server:', err);
    }
}
```
 
**Add method to stop server**:
 
```typescript
/**
 * Stop the local API server.
 */
private async _stopLocalApiServer(): Promise<void> {
    if (this._localApiServer) {
        await this._localApiServer.stop();
        this._localApiServer = null;
    }
}
```
 
**Modify dispose method** (around line 4500) to stop server:
 
```typescript
public async dispose(): Promise<void> {
    // ... existing dispose logic ...
    
    await this._stopLocalApiServer();
}
```
 
**Call start server in constructor or initialization** (after other initialization):
 
```typescript
// Start local API server for agent access
void this._startLocalApiServer();
```
 
### Phase 4: Create Skill for Agent API Access
 
#### [CREATE] `.agent/skills/get_tickets.md`
 
**Context**: Create a skill that teaches agents how to call the local API endpoint to read ticket metadata.
 
**Skill Content**:
 
```markdown
# Local API Ticket Access
 
Use this skill when you need to access ClickUp/Linear ticket data without using the MCP server.
 
## When to Use
 
- User asks about ClickUp/Linear tickets (e.g., "list all tickets this sprint", "show me task XYZ")
- You need to identify tickets quickly without MCP calls
- You need to filter tickets by status, sprint, or project
 
## How to Use
 
### Step 1: Discover the API Server Port
 
Read the server port from `.switchboard/api-server-port.txt` in the workspace root.
 
```bash
PORT=$(cat .switchboard/api-server-port.txt)
```
 
### Step 2: Read Ticket Metadata
 
Call the local API endpoint to read ticket metadata.
 
**ClickUp metadata:**
```bash
curl http://localhost:$PORT/metadata/clickup
```
 
**Linear metadata:**
```bash
curl http://localhost:$PORT/metadata/linear
```
 
Response structure:
```json
{
  "version": 1,
  "sourceId": "clickup",
  "metadata": [
    {
      "id": "task123",
      "name": "Task name",
      "status": "In Progress",
      "listId": "list456",
      "sprint": "Sprint 1",
      "lastUpdated": 1234567890
    }
  ],
  "writtenAt": 1234567890
}
```
 
Use this metadata to:
- Filter tickets by status, sprint, list, or project
- Identify task IDs for further queries
- Answer questions that don't require full task descriptions
 
### Step 3: Get Full Task Details (if needed)
 
If you need full task details (descriptions, comments, attachments), the local API currently does not support this. Fall back to the ClickUp/Linear MCP server to fetch full details using the task IDs from the metadata.
 
### Step 4: Handle Errors
 
- If the API server is not responding (connection refused), fall back to MCP
- If the port file doesn't exist, the server may not be started — fall back to MCP
- If the metadata file is empty or malformed, no tickets are cached — fall back to MCP
 
## Security Notes
 
- The local API server is bound to localhost only (127.0.0.1)
- It uses the extension's existing ClickUp/Linear credentials
- No additional credential management is needed
- The metadata file contains only non-sensitive data (IDs, names, status)
```
 
### Phase 5: Update Manual Refresh to Clear Metadata Files
 
#### [MODIFY] `src/services/TaskViewerProvider.ts`
 
**Context**: Ensure `forceRefreshIntegrationCache` also clears the metadata files when clearing the in-memory cache. The existing call to `clearAllTaskCache()` already does this (Phase 1 modification), but verify it's wired correctly.
 
**Verification**: The existing implementation at line 4485 calls `cacheService.clearAllTaskCache()`, which now writes empty metadata files (Phase 1). No additional changes needed.
 
### Phase 6: Add to .gitignore
 
#### [MODIFY] `.gitignore`
 
**Context**: Add the metadata files and port file to `.gitignore` to prevent accidental commits.
 
**Add to .gitignore**:
```
.switchboard/clickup-tasks.json
.switchboard/linear-tasks.json
.switchboard/api-server-port.txt
```
 
### Phase 7: Update Skill for Direct File Reading (Clarification)

#### [MODIFY] `.agent/skills/get_tickets.md`

**Context:** Update skill to prefer direct file reading over HTTP API for better performance, using HTTP as fallback.

**Updated Skill Content**:

```markdown
# Local API Ticket Access

Use this skill when you need to access ClickUp/Linear ticket data without using the MCP server.

## When to Use

- User asks about ClickUp/Linear tickets (e.g., "list all tickets this sprint", "show me task XYZ")
- You need to identify tickets quickly without MCP calls
- You need to filter tickets by status, sprint, or project

## How to Use

### Step 1: Read Metadata Directly (Preferred)

Read the JSON files directly for best performance (no HTTP overhead).

**ClickUp metadata:**
Read file at `.switchboard/clickup-tasks.json`

**Linear metadata:**
Read file at `.switchboard/linear-tasks.json`

Response structure:
```json
{
  "version": 1,
  "sourceId": "clickup",
  "metadata": [
    {
      "id": "task123",
      "name": "Task name",
      "status": "In Progress",
      "listId": "list456",
      "sprint": "Sprint 1",
      "lastUpdated": 1234567890
    }
  ],
  "writtenAt": 1234567890
}
```

Use this metadata to:
- Filter tickets by status, sprint, list, or project
- Identify task IDs for further queries
- Answer questions that don't require full task descriptions

**Check `writtenAt` timestamp:** If older than 60 seconds, data may be stale. Proceed with awareness or fall back to MCP for critical operations.

### Step 2: HTTP API Fallback (If File Read Fails)

If direct file reading fails (e.g., file doesn't exist), discover the API server port:

Read port from `.switchboard/api-server-port.txt`

Then call:
```bash
curl http://localhost:$PORT/metadata/clickup
# or
curl http://localhost:$PORT/metadata/linear
```

### Step 3: Get Full Task Details (If Needed)

If you need full task details (descriptions, comments, attachments), the local API currently does not support this. Fall back to the ClickUp/Linear MCP server to fetch full details using the task IDs from the metadata.

### Step 4: Handle Errors

- **File doesn't exist:** No tickets cached — fall back to MCP
- **Malformed JSON:** File may be mid-write — retry once after 100ms, then fall back to MCP
- **Stale data (>60s):** Proceed with caution or fall back to MCP for freshness-critical queries
- **API server not responding:** Fall back to MCP

## Security Notes

- Metadata files contain only non-sensitive data (IDs, names, status)
- HTTP server is bound to localhost only (127.0.0.1)
- Uses the extension's existing ClickUp/Linear credentials
- No additional credential management is needed
```

## Verification Plan
 
### Manual Testing
 
| Test Case | Expected Result |
|-----------|-----------------|
| Server starts on activation | `.switchboard/api-server-port.txt` contains port number after extension starts |
| Server stops on deactivation | Port file is removed or server stops gracefully on extension deactivate |
| Metadata write triggers JSON file | `.switchboard/clickup-tasks.json` and `.switchboard/linear-tasks.json` exist after browsing tickets |
| API returns metadata | `curl http://localhost:$PORT/metadata/clickup` returns valid JSON |
| API restricts to localhost | Requests from non-localhost return 403 |
| JSON file structure is valid | File contains `version`, `sourceId`, `metadata`, `writtenAt` fields |
| Metadata is minimal | File contains only ID, name, status, listId/projectId — no descriptions or comments |
| Atomic write prevents corruption | Kill extension mid-write, file remains intact |
| Debounce batches rapid writes | Rapid cache updates trigger only one file write after 500ms |
| Clear cache writes empty JSON | Manual refresh command writes empty `metadata: []` to JSON files |
| Agent can read metadata via API | Skill teaches agents to discover port and call API correctly |
| .gitignore prevents commits | Files are not shown in `git status` |
 
### Unit Tests
 
Create `src/services/__tests__/LocalApiServer.test.ts`:
 
- Server starts on random free port
- Server writes port to file
- Server stops gracefully
- `/metadata/clickup` returns valid JSON
- `/metadata/linear` returns valid JSON
- Non-localhost requests return 403
- Invalid endpoints return 404
 
Create `src/services/__tests__/PlanningPanelCacheService.test.ts`:
 
- `cacheTasks` triggers debounced metadata write
- `clearAllTaskCache` writes empty JSON immediately
- Atomic write pattern (temp file + rename)
- Metadata extraction includes only minimal fields
- Metadata excludes sensitive fields (descriptions, comments)
 
## File Changes Summary
 
1. **src/services/PlanningPanelCacheService.ts**
   - Add `_clickupMetadataPath`, `_linearMetadataPath`, `_metadataWriteTimer`, `_metadataWriteDebounceMs` fields (around line 36)
   - Update constructor to initialize paths (around line 38)
   - Add `_writeMetadataToJson()` debounced write method
   - Add `_writeMetadataFile()` atomic write method with metadata extraction
   - Modify `cacheTasks()` (line 470) to trigger debounced metadata write
   - Modify `clearAllTaskCache()` (line 561) to write empty metadata immediately (no debounce)
 
2. **src/services/LocalApiServer.ts** (NEW)
   - HTTP server bound to localhost only (`127.0.0.1`)
   - Endpoints: `GET /health`, `GET /metadata/clickup`, `GET /metadata/linear`
   - Port file for agent discovery (`.switchboard/api-server-port.txt`)
   - Proper CORS headers (`Access-Control-Allow-Origin: *`)
   - Error handling and graceful degradation
   - Temp file cleanup on startup
 
3. **src/services/TaskViewerProvider.ts**
   - Add `import { LocalApiServer } from './LocalApiServer'` at top
   - Add `_localApiServer: LocalApiServer | null = null` field (around line 100)
   - Add `_startLocalApiServer()` method (after constructor)
   - Add `_stopLocalApiServer()` method
   - Call `_startLocalApiServer()` in initialization (after other services initialized)
   - Call `_stopLocalApiServer()` in `dispose()` method (around line 4500)
 
4. **.agent/skills/get_tickets.md** (NEW)
   - Skill teaching agents to read metadata JSON files directly (preferred)
   - HTTP API as fallback if file reading unavailable
   - Security notes about localhost-only binding
   - Staleness checking using `writtenAt` timestamp
   - Error handling and MCP fallback guidance
 
5. **.gitignore**
   - Add explicit entries (`.switchboard/clickup-tasks.json`, `.switchboard/linear-tasks.json`, `.switchboard/api-server-port.txt`) for documentation clarity (already covered by `.switchboard/*` wildcard)
 
## Recommendation: Send to Coder

Complexity is 6 (Medium-High). While individual components are straightforward, the HTTP server lifecycle management, cross-platform file semantics (Windows vs POSIX), CORS configuration, and concurrent read/write coordination elevate this beyond routine changes. The plan is well-specified with clear file paths, line numbers, and implementation details.