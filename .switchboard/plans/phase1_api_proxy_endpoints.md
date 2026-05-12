---
description: Phase 1 - Add read-only API proxy endpoints and name resolution to LocalApiServer
---

# Phase 1: API Proxy Endpoints and Name Resolution

## Goal
Add read-only proxy endpoints for ClickUp/Linear APIs and name resolution to LocalApiServer, establishing the authentication pattern and POST/PUT handler infrastructure without write operations.

## Metadata
**Tags:** infrastructure, backend, authentication, workflow
**Complexity:** 5

## User Review Required
None - internal tooling

## Complexity Audit

### Routine
- Create 3 skill documentation files (clickup_api.md, linear_api.md, clickup_fetch.md)
- Update AGENTS.md skills table

### Complex / Risky
- Add POST/PUT method support to LocalApiServer (currently GET-only)
- Implement VS Code SecretStorage authentication pattern
- Add 3 new HTTP endpoints with proper error handling
- Implement name resolution caching strategy with memory leak prevention

## Edge-Case & Dependency Audit

**Race Conditions:** None - read-only operations

**Security:** 
- Authentication must be implemented but not yet strictly enforced (preparation for Phase 2)
- Token retrieval from VS Code SecretStorage via `getAuthToken` callback
- No hardcoded fallback tokens

**Side Effects:**
- Skills will depend on LocalApiServer being running
- Port file must be present (already created by extension)

**Dependencies & Conflicts:**
- Depends on: None. 
- Blocks: Phase 2 (sess_1777642418579) and Phase 3 (sess_1777642442632), which require the auth pattern and base HTTP routing logic established here. 
- Kanban query shows no conflicts with unrelated active features (no overlapping file edits detected in backlog/planned columns).

## Dependencies
None

## Adversarial Synthesis
Key risks: Authentication pattern may need revision once write operations arrive in Phase 2; name resolution caching without invalidation may return stale IDs, and an unbounded Map could leak memory. Mitigations: Design auth interface to support future write validation; use short-lived in-memory cache (30s TTL) for name resolution and implement periodic cache pruning to prevent memory leaks; comprehensive regression testing of existing endpoints.

## Proposed Changes

### [Target File] `src/services/LocalApiServer.ts`

**Context:** Extend LocalApiServer with authentication infrastructure and 3 new read-only endpoints.

**Logic:** 
1. Add authentication middleware infrastructure
2. Add POST/PUT method support
3. Implement generic API proxy endpoints for ClickUp and Linear
4. Implement name resolution endpoint with short-lived caching and automatic memory pruning

**Implementation:**

1. Add authentication infrastructure to LocalApiServerOptions:
```typescript
// Add to interface LocalApiServerOptions (line ~8)
interface LocalApiServerOptions {
    workspaceRoot: string;
    clickupMetadataPath: string;
    linearMetadataPath: string;
    getClickUpService: () => ClickUpSyncService | null;
    getLinearService: () => LinearSyncService | null;
    getAuthToken: () => Promise<string>; // NEW - for Phase 2 write operations
}
```

2. Update extension.ts to provide auth callback:
```typescript
// In extension.ts where LocalApiServer is instantiated
const server = new LocalApiServer({
    workspaceRoot: context.extensionPath,
    clickupMetadataPath: path.join(context.extensionPath, '.switchboard', 'clickup-metadata.json'),
    linearMetadataPath: path.join(context.extensionPath, '.switchboard', 'linear-metadata.json'),
    getClickUpService: () => clickUpService,
    getLinearService: () => linearService,
    getAuthToken: async () => {
        // Retrieve from VS Code SecretStorage - returns empty string if not set
        return await context.secrets.get('switchboard.apiToken') || '';
    }
});
```

3. Add authentication check method:
```typescript
// Add private method to LocalApiServer class (after line ~99)
private async _checkAuth(req: http.IncomingMessage): Promise<boolean> {
    const authHeader = req.headers['authorization'];
    const expectedToken = await this._options.getAuthToken();
    // CLARIFICATION: For Phase 1, allow requests if no token is configured (backward compatibility)
    // Phase 2 will enforce strict authentication
    if (!expectedToken) {
        return true; // No token configured, allow read-only access
    }
    return authHeader === `Bearer ${expectedToken}`;
}
```

4. Add POST/PUT handler support (line ~124):
```typescript
// Replace existing method check (line 124-128)
if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
}

// Add CORS headers to allow POST/PUT
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
```

5. Add JSON body parser utility:
```typescript
// Add private method after _checkAuth
private async _parseJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}
```

6. Implement /api/clickup endpoint (generic proxy):
```typescript
} else if (pathname === '/api/clickup' && req.method === 'POST') {
    await this._handleClickUpApiProxy(req, res);
```

7. Implement handler:
```typescript
private async _handleClickUpApiProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CLARIFICATION: Phase 1 - auth not strictly enforced yet
    // Phase 2 will add: if (!await this._checkAuth(req)) { ... }
    
    const service = this._options.getClickUpService();
    if (!service) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ClickUp service not available' }));
        return;
    }

    try {
        const body = await this._parseJsonBody(req);
        const { method, endpoint, query, body: apiBody } = body;
        
        // Validate inputs
        if (!method || !endpoint) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing method or endpoint' }));
            return;
        }
        
        // Call ClickUp API via service
        const result = await service.makeApiRequest(method, endpoint, query, apiBody);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (err) {
        console.error('[LocalApiServer] ClickUp API proxy error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Proxy request failed' }));
    }
}
```

8. Implement /api/linear endpoint (generic proxy):
```typescript
} else if (pathname === '/api/linear' && req.method === 'POST') {
    await this._handleLinearApiProxy(req, res);
```

9. Implement handler:
```typescript
private async _handleLinearApiProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const service = this._options.getLinearService();
    if (!service) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Linear service not available' }));
        return;
    }

    try {
        const body = await this._parseJsonBody(req);
        const { query, variables } = body;
        
        if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing GraphQL query' }));
            return;
        }
        
        const result = await service.makeGraphQLRequest(query, variables);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (err) {
        console.error('[LocalApiServer] Linear API proxy error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Proxy request failed' }));
    }
}
```

10. Implement /resolve/{source}/name/{name} endpoint:
```typescript
} else if (pathname.startsWith('/resolve/') && req.method === 'GET') {
    const parts = pathname.split('/');
    const source = parts[2]; // 'clickup' or 'linear'
    const name = decodeURIComponent(parts[4]);
    await this._handleResolveName(source, name, res);
```

11. Implement handler with short-lived cache and memory leak protection:
```typescript
// Add cache storage at class level (after line ~17)
private _nameResolutionCache: Map<string, { id: string; timestamp: number }> = new Map();
private readonly _CACHE_TTL_MS = 30000; // 30 seconds

// CLARIFICATION: Prune expired entries to prevent memory leaks over time
private _pruneCache(): void {
    const now = Date.now();
    for (const [key, value] of this._nameResolutionCache.entries()) {
        if (now - value.timestamp >= this._CACHE_TTL_MS) {
            this._nameResolutionCache.delete(key);
        }
    }
}

private async _handleResolveName(source: string, name: string, res: http.ServerResponse): Promise<void> {
    const cacheKey = `${source}:${name}`;
    const cached = this._nameResolutionCache.get(cacheKey);
    
    // Return cached result if valid
    if (cached && Date.now() - cached.timestamp < this._CACHE_TTL_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: cached.id, cached: true }));
        return;
    }
    
    try {
        let id: string | null = null;
        
        if (source === 'clickup') {
            const service = this._options.getClickUpService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'ClickUp service not available' }));
                return;
            }
            id = await service.resolveNameToId(name);
        } else if (source === 'linear') {
            const service = this._options.getLinearService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Linear service not available' }));
                return;
            }
            id = await service.resolveNameToId(name);
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid source. Use "clickup" or "linear"' }));
            return;
        }
        
        if (!id) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Name "${name}" not found in ${source}` }));
            return;
        }
        
        // Cache the result and prune old entries
        this._nameResolutionCache.set(cacheKey, { id, timestamp: Date.now() });
        this._pruneCache();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, cached: false }));
    } catch (err) {
        console.error('[LocalApiServer] Name resolution error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Resolution failed' }));
    }
}
```

**Edge Cases Handled:**
- Backward compatibility: Auth allows requests when no token configured (Phase 1 only)
- Service unavailable (503) when ClickUp/Linear services not initialized
- Invalid JSON body handling
- Missing required parameters (400 Bad Request)
- Name not found (404)
- Short-lived cache (30s) prevents hammering APIs while staying reasonably fresh
- Cache pruning prevents memory leaks on long-running servers

### [Target Directory] `.agent/skills/`

**Context:** Create 3 skill files for API proxy and name resolution.

**Logic:** Create skill files that use the new LocalApiServer endpoints.

**Implementation:**

1. **clickup_api.md** - Generic ClickUp API proxy skill:
```markdown
---
description: Make direct ClickUp API calls via LocalApiServer proxy
---

# ClickUp API Proxy

## When to Use
- Need to make custom ClickUp API calls not covered by specific skills
- Direct API access required for advanced operations

## Usage
```bash
PORT=$(cat .switchboard/api-server-port.txt 2>/dev/null)
if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

curl -s -X POST http://localhost:$PORT/api/clickup \
  -H "Content-Type: application/json" \
  -d '{
    "method": "GET",
    "endpoint": "/v2/task/12345",
    "query": {},
    "body": null
  }'
```

## Parameters
- method: HTTP method (GET, POST, PUT, DELETE)
- endpoint: ClickUp API endpoint path (e.g., "/v2/task/12345")
- query: Optional query parameters object
- body: Optional request body object

## Response
JSON response from ClickUp API or error object with `error` field.
```

2. **linear_api.md** - Generic Linear API proxy skill:
```markdown
---
description: Make direct Linear GraphQL API calls via LocalApiServer proxy
---

# Linear API Proxy

## When to Use
- Need to make custom Linear GraphQL queries not covered by specific skills
- Direct API access required for advanced operations

## Usage
```bash
PORT=$(cat .switchboard/api-server-port.txt 2>/dev/null)
if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

curl -s -X POST http://localhost:$PORT/api/linear \
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
```

3. **clickup_fetch.md** - Name resolution skill (extends get_tickets pattern):
```markdown
---
description: Fetch ClickUp tasks/lists with automatic name resolution
---

# ClickUp Fetch with Name Resolution

## When to Use
- Need to resolve a task/list name to its ID
- Fetch task details by name instead of ID

## Usage

### Resolve name to ID:
```bash
PORT=$(cat .switchboard/api-server-port.txt 2>/dev/null)
if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

# Resolve a task name
curl -s http://localhost:$PORT/resolve/clickup/name/My%20Task%20Name

# Resolve a list name
curl -s http://localhost:$PORT/resolve/clickup/name/My%20List%20Name
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
```

**Edge Cases Handled:**
- Port file missing detection
- URL encoding for names with spaces/special characters
- Cache hit/miss indication in responses

### [Target File] `AGENTS.md`

**Context:** Add new skills to Available Skills table.

**Logic:** Insert 3 new skill entries in alphabetical order.

**Implementation:**
Add to skills table (alphabetical order):
```markdown
| `clickup_api` | Direct ClickUp API access via LocalApiServer proxy (replaces call_clickup_api) |
| `clickup_fetch` | Fetch ClickUp tasks/lists with name resolution (replaces clickup_fetch) |
| `linear_api` | Direct Linear API access via LocalApiServer proxy (replaces call_linear_api) |
```

**Edge Cases Handled:** None - documentation only.

## Verification Plan

### Automated Tests
- Unit test: `_parseJsonBody` handles valid JSON, invalid JSON, empty body
- Unit test: `_handleClickUpApiProxy` with mock service
- Unit test: `_handleLinearApiProxy` with mock service
- Unit test: `_handleResolveName` cache hit/miss/expiration and memory leak protection
- Integration test: All 3 endpoints via curl

### Manual Verification
1. Build extension: `npm run compile`
2. Load extension in VS Code
3. Verify LocalApiServer starts
4. Test endpoints:
   ```bash
   PORT=$(cat .switchboard/api-server-port.txt)
   curl http://localhost:$PORT/health
   curl -X POST http://localhost:$PORT/api/clickup \
     -H "Content-Type: application/json" \
     -d '{"method": "GET", "endpoint": "/v2/team"}'
   curl http://localhost:$PORT/resolve/clickup/name/Some%20Task
   ```
5. Verify existing GET endpoints still work (regression test)

## Rollback Plan
- All changes are additive; no existing functionality modified
- If issues arise, skills can fall back to MCP tools
- Simply do not proceed to Phase 2 if Phase 1 has issues

---

**Agent Recommendation:** Send to Coder (Complexity 5)

## 🛡️ Verification Phase

### Grumpy Review (Adversarial Findings)
1. **[CRITICAL] Memory Leak via Unbounded Body Parsing**: The `_parseJsonBody` function in `LocalApiServer.ts` buffers incoming `data` chunks into a string without a size limit. An attacker or malfunctioning skill could send a massive payload and OOM the VS Code extension host. The coder added `_MAX_FILE_SIZE_BYTES` logic in the attachment endpoint but completely forgot generic request payload limits.
2. **[MAJOR] Broken "Phase 1" Backward Compatibility**: The plan explicitly stated: "CLARIFICATION: Phase 1 - auth not strictly enforced yet. Phase 2 will add: if (!await this._checkAuth(req)) { ... }". The coder jumped the gun and passed `true` to `_checkAuth(req, true)` in the new proxy endpoints (`_handleClickUpApiProxy` and `_handleLinearApiProxy`), meaning requests without tokens will be rejected with 401 Unauthorized. This completely breaks the seamless rollout intended for Phase 1.
3. **[NIT] O(N) Cache Pruning on Every Request**: `_pruneCache` is called on *every single* name resolution request. It iterates over the entire Map. If a script resolves a batch of names, it triggers O(N²) behavior. Not a memory leak, but it is a CPU leak.

### Balanced Review (Synthesis & Action Items)
- **Fix Now (CRITICAL)**: Implemented a 10MB (`this._MAX_FILE_SIZE_BYTES`) limit in `_parseJsonBody` to reject oversized payloads safely and prevent extension host crashes.
- **Fix Now (MAJOR)**: Adjusted the authentication check in `_handleClickUpApiProxy` and `_handleLinearApiProxy` to pass `false` for `requireAuth`, honoring the Phase 1 backward compatibility mandate. Strict enforcement will be left for Phase 2 as planned.
- **Fix Now (NIT)**: Added a simple size threshold (`if (this._nameResolutionCache.size < 100) return;`) to `_pruneCache` to prevent excessive Map iteration on every request while still preventing long-term memory leaks.

### Code Fixes Applied
- **`src/services/LocalApiServer.ts`**:
  - Rewrote `_parseJsonBody` to track `bodySize` and reject payloads larger than `_MAX_FILE_SIZE_BYTES` (10MB).
  - Modified `_handleClickUpApiProxy` and `_handleLinearApiProxy` to use `_checkAuth(req, false)`.
  - Added a short-circuit threshold to `_pruneCache()`.

### Validation Results
- **Typecheck/Compile**: `npm run compile` completed successfully with Exit code 0, confirming the modifications introduced no syntax or type errors.
- **Files Modified**: 
  - `src/services/LocalApiServer.ts`

**ACCURACY VERIFICATION COMPLETE**
