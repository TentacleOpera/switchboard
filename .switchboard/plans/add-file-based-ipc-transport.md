# Add file-based IPC transport to LocalApiServer for sandboxed agents

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** `.agents/skills/_lib/sb_api_call.sh` was **deleted** in commit `96fb16df`; all eight `kanban_operations/*.js` now route through `.agents/skills/_lib/cli-call.js`. Retarget every reference (sections 10 and 12, the `findApiPort`/`httpJson` rework, and the 50+ curl rewrites) to `cli-call.js`. Do not recreate the shell helper.


## Goal

External sandboxed agents (Devin, Cursor, Claude Code, Windsurf) cannot reach the LocalApiServer over TCP loopback (`127.0.0.1`) because their sandboxes block "direct IP access." The current workaround (`BypassSandbox: true`) is a retry-and-workaround pattern that makes users uncomfortable and wastes a round-trip on every launch. Unix domain sockets were investigated and rejected — macOS Seatbelt blocks them by default alongside TCP (see superseded plan `add-unix-domain-socket-transport.md`). Add a file-based IPC transport that uses the workspace filesystem (`.switchboard/ipc/`) as a request/response queue. Any sandbox that permits file writes to the workspace — which all coding agents require to edit code — supports this transport with zero configuration on all platforms (macOS, Linux, Windows).

### Problem analysis and root cause

Observed 2026-08-19: the orchestrator agent's pre-flight health check and adopt call to `http://127.0.0.1:51011` were blocked by the sandbox with "Direct IP access is not allowed" (HTTP 400). The agent retried with `BypassSandbox: true`, which worked. The user does not want to rely on sandbox bypass.

Web research (2026-08-19, 52 sources) confirmed:
- **Linux sandboxes** (Bubblewrap, Docker, nsjail): block TCP via `CLONE_NEWNET` but allow filesystem-bound Unix sockets. Unix sockets work but are Linux-only.
- **macOS sandboxes** (Seatbelt/SBPL): block both TCP and Unix socket `connect()` by default. Unix sockets require per-agent config the extension cannot automate.
- **All sandboxes**: allow file writes to the workspace directory (agents must edit code). File-based IPC exploits this universal capability.

The file-based IPC transport does not replace TCP — PTY terminal agents (Switchboard's internal fleet) continue using TCP `127.0.0.1:port` directly with no changes. File-based IPC is an additional transport for external sandboxed agents only. The discovery logic tries TCP first (works for PTY agents and non-sandboxed shells), falls back to file-based IPC when TCP is blocked.

## Metadata

**Complexity:** 6
**Tags:** backend, infrastructure, api, reliability, cli

## User Review Required

No — the core assumption (sandboxes allow workspace file writes) is universally true for all coding agents. No external research needed.

## Complexity Audit

### Routine
- Creating `.switchboard/ipc/requests/` and `.switchboard/ipc/responses/` directories on server start.
- Writing a shell script (`sb_ipc_call.sh`) that writes a JSON request file, polls for a response file, and outputs the result — standard file I/O.
- Updating `sb_api_call.sh` to try TCP first, fall back to file-based IPC.
- Updating Node.js skill scripts (`kanban_operations/*.js`) to support file-based IPC.
- Adding `ipcAvailable` to the `/health` response — one field.

### Complex / Risky
- **fs.watch reliability** — `fs.watch` is unreliable on network drives, some macOS configurations, and can fire duplicate events. The watcher needs a polling fallback (readdir every 500ms) and dedup logic (same pattern as TaskViewerProvider's native fs.watch fallback at line 15271).
- **Self-HTTP round-trip** — the server-side watcher makes an `http.request` to `127.0.0.1:port` to route the request through the existing `_handleRequest` pipeline. This is a same-process loopback call. The codebase warns against self-HTTP for liveness probes (times out on a starved host), but for actual API calls it is no worse than any external request — the request queues in the event loop like any other.
- **Orphaned file cleanup** — if the server crashes mid-request, request files may be left in `.switchboard/ipc/requests/` and response files in `.switchboard/ipc/responses/`. The server must clean these on startup. If the client crashes after writing a request but before reading the response, the response file is orphaned — the server should periodically purge old response files.
- **Concurrency** — multiple sandboxed agents may write request files simultaneously. Each request has a unique ID (UUID), so there are no file conflicts. The server processes requests concurrently (async).
- **Timeout handling** — the client polls for the response file with a timeout (default 10s). If the server is slow or down, the client must give up gracefully and report an error, not hang forever.

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — add IPC directory watcher in `start()`

After the TCP listener succeeds in `start()` (line 533), start watching the IPC requests directory:

```ts
// File-based IPC — sandbox-safe transport for external agents.
// Sandboxes that block TCP loopback (127.0.0.1) and Unix sockets
// (macOS Seatbelt) still allow file writes to the workspace.
// The watcher reads JSON request files, routes them through the
// existing HTTP pipeline via self-HTTP, and writes response files.
this._ipcDir = path.join(this._options.workspaceRoot, '.switchboard', 'ipc');
const ipcRequestsDir = path.join(this._ipcDir, 'requests');
const ipcResponsesDir = path.join(this._ipcDir, 'responses');
try {
    await fs.mkdir(ipcRequestsDir, { recursive: true });
    await fs.mkdir(ipcResponsesDir, { recursive: true });
    // Clean up orphaned files from a previous crash
    await this._cleanupIpcOrphans(ipcRequestsDir, ipcResponsesDir);
    // Start watcher (fs.watch with polling fallback)
    this._startIpcWatcher(ipcRequestsDir);
    console.log(`[LocalApiServer] IPC watcher active at ${this._ipcDir}`);
} catch (err) {
    // IPC is additive — if it fails, TCP still works.
    console.warn(`[LocalApiServer] IPC watcher failed (non-fatal, TCP still active): ${err}`);
    this._ipcDir = null;
}
```

Add field declarations alongside `_server` (line 484):

```ts
private _ipcDir: string | null = null;
private _ipcWatcher: fsSync.FSWatcher | null = null;
private _ipcPollTimer: NodeJS.Timeout | null = null;
private _ipcProcessing = new Set<string>(); // dedup: filenames currently being processed
```

### 2. `src/services/LocalApiServer.ts` — IPC watcher implementation

The watcher uses `fs.watch` as primary, with a polling fallback (readdir every 500ms) if `fs.watch` fails or is unreliable. Same pattern as TaskViewerProvider's native fs.watch fallback (line 15271).

```ts
private _startIpcWatcher(requestsDir: string): void {
    // Primary: fs.watch
    try {
        this._ipcWatcher = fsSync.watch(requestsDir, (eventType, filename) => {
            if (filename && filename.endsWith('.json')) {
                void this._processIpcRequest(requestsDir, filename);
            }
        });
        this._ipcWatcher.on('error', (err) => {
            console.warn(`[LocalApiServer] IPC fs.watch error, falling back to polling: ${err}`);
            this._ipcWatcher?.close();
        this._ipcWatcher = null;
            this._startIpcPolling(requestsDir);
        });
    } catch {
        // fs.watch not available — use polling
        this._startIpcPolling(requestsDir);
    }
}

private _startIpcPolling(requestsDir: string): void {
    this._ipcPollTimer = setInterval(async () => {
        try {
            const files = await fs.readdir(requestsDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    void this._processIpcRequest(requestsDir, file);
                }
            }
        } catch { /* directory may not exist yet */ }
    }, 500);
}

private async _processIpcRequest(requestsDir: string, filename: string): Promise<void> {
    // Dedup: fs.watch can fire duplicate events
    if (this._ipcProcessing.has(filename)) return;
    this._ipcProcessing.add(filename);

    // Guard against stop() racing with an in-flight watcher event: stop() sets
    // _ipcDir = null and closes the watcher, but a callback already queued may
    // still fire. Without this guard, `this._ipcDir!` is a null-deref.
    const ipcDir = this._ipcDir;
    if (!ipcDir) {
        this._ipcProcessing.delete(filename);
        return;
    }

    const requestsPath = path.join(requestsDir, filename);
    const responsesDir = path.join(ipcDir, 'responses');
    const responsePath = path.join(responsesDir, filename.replace('req-', 'resp-'));

    try {
        // Read the request
        const raw = await fs.readFile(requestsPath, 'utf8');
        const req = JSON.parse(raw);

        // Route through the existing HTTP pipeline via self-HTTP
        const response = await this._selfHttpRequest(
            req.method || 'GET',
            req.path || '/',
            req.headers || {},
            req.body || null
        );

        // Write the response (tmp+rename for atomicity)
        const tmpResponsePath = responsePath + '.tmp';
        await fs.writeFile(tmpResponsePath, JSON.stringify({
            id: req.id,
            status: response.status,
            headers: response.headers,
            body: response.body
        }), 'utf8');
        await fs.rename(tmpResponsePath, responsePath);

        // Delete the request file
        await fs.unlink(requestsPath).catch(() => { /* already gone */ });
    } catch (err) {
        // Write an error response so the client doesn't hang
        try {
            const tmpResponsePath = responsePath + '.tmp';
            await fs.writeFile(tmpResponsePath, JSON.stringify({
                error: String(err),
                status: 500
            }), 'utf8');
            await fs.rename(tmpResponsePath, responsePath);
        } catch { /* give up */ }
        await fs.unlink(requestsPath).catch(() => { /* already gone */ });
    } finally {
        this._ipcProcessing.delete(filename);
    }
}
```

### 3. `src/services/LocalApiServer.ts` — self-HTTP helper

The self-HTTP helper makes an `http.request` to `127.0.0.1:this._port`, routing the file-based request through the existing `_handleRequest` pipeline (auth, CORS, routing, body parsing, etc.) without any refactoring:

```ts
private _selfHttpRequest(
    method: string,
    urlPath: string,
    headers: Record<string, string>,
    body: string | null
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
        const payload = body || '';
        const options = {
            host: '127.0.0.1',
            port: this._port,
            path: urlPath,
            method: method.toUpperCase(),
            headers: {
                ...headers,
                'Content-Length': Buffer.byteLength(payload),
            },
        };
        const req = http.request(options, (res) => {
            let responseBody = '';
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
                if (typeof value === 'string') responseHeaders[key] = value;
            }
            res.on('data', (chunk) => { responseBody += chunk; });
            res.on('end', () => {
                resolve({ status: res.statusCode || 200, headers: responseHeaders, body: responseBody });
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy(new Error('IPC self-HTTP timeout'));
        });
        if (payload) req.write(payload);
        req.end();
    });
}
```

### 4. `src/services/LocalApiServer.ts` — cleanup and stop

Add orphan cleanup on start:

```ts
private async _cleanupIpcOrphans(requestsDir: string, responsesDir: string): Promise<void> {
    // Purge any request/response files from a previous crash
    for (const dir of [requestsDir, responsesDir]) {
        try {
            const files = await fs.readdir(dir);
            for (const file of files) {
                if (file.endsWith('.json') || file.endsWith('.json.tmp')) {
                    await fs.unlink(path.join(dir, file)).catch(() => {});
                }
            }
        } catch { /* directory may not exist yet */ }
    }
}
```

In `stop()` (line 630), stop the IPC watcher:

```ts
// Stop IPC watcher
if (this._ipcWatcher) {
    this._ipcWatcher.close();
    this._ipcWatcher = null;
}
if (this._ipcPollTimer) {
    clearInterval(this._ipcPollTimer);
    this._ipcPollTimer = null;
}
// Clean up IPC directory
if (this._ipcDir) {
    try {
        await fs.rm(this._ipcDir, { recursive: true, force: true }).catch(() => {});
    } catch { /* best-effort */ }
    this._ipcDir = null;
}
```

Add a periodic cleanup timer for old response files (orphaned when client crashes after writing request but before reading response):

```ts
// In start(), after IPC watcher starts:
this._ipcCleanupTimer = setInterval(() => {
    void this._purgeOldIpcResponses();
}, 60000); // every 60 seconds

private async _purgeOldIpcResponses(): Promise<void> {
    if (!this._ipcDir) return;
    const responsesDir = path.join(this._ipcDir, 'responses');
    try {
        const files = await fs.readdir(responsesDir);
        const now = Date.now();
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            const filePath = path.join(responsesDir, file);
            const stat = await fs.stat(filePath).catch(() => null);
            if (stat && now - stat.mtimeMs > 120000) { // older than 2 minutes
                await fs.unlink(filePath).catch(() => {});
            }
        }
    } catch { /* directory may not exist */ }
}
```

Add field: `private _ipcCleanupTimer: NodeJS.Timeout | null = null;`

In `stop()`, also clear the cleanup timer:
```ts
if (this._ipcCleanupTimer) {
    clearInterval(this._ipcCleanupTimer);
    this._ipcCleanupTimer = null;
}
```

### 5. `src/services/LocalApiServer.ts` — expose IPC availability

Add accessor:

```ts
public getIpcDir(): string | null {
    return this._ipcDir;
}
```

### 6. `GET /health` — include IPC availability

In the health endpoint response (line 4462-4471), add IPC directory:

```ts
res.end(JSON.stringify({
    service: 'switchboard',
    status: 'ok',
    port: this._port,
    ipcDir: this._ipcDir,   // <-- new
    pid: process.pid,
    roots: this._allRoots,
    // ... existing fields
}));
```

### 7. `src/services/TaskViewerProvider.ts` — write IPC discovery file

In `_startLocalApiServer` (line 3584-3601), after writing the port file, write an IPC marker file so agents know file-based IPC is available:

```ts
const ipcDir = this._localApiServer?.getIpcDir?.();
if (ipcDir) {
    for (const root of this._filterPortFileEligibleRoots(allRoots)) {
        const ipcMarkerPath = path.join(root, '.switchboard', 'ipc-available.txt');
        try {
            await fs.promises.writeFile(ipcMarkerPath, ipcDir, 'utf8');
        } catch (writeErr) {
            console.warn(`[TaskViewerProvider] Failed to write IPC marker to ${root}:`, writeErr);
        }
    }
}
```

In `_stopLocalApiServer` (line 3669-3687), unlink the IPC marker file:

```ts
const ipcMarkerPath = path.join(root, '.switchboard', 'ipc-available.txt');
await fs.promises.unlink(ipcMarkerPath).catch(() => {});
```

### 8. `src/standalone/bootstrap.ts` — IPC discovery in standalone mode

After `server.start()` (line 2493), write the IPC marker file:

```ts
const ipcDir = server.getIpcDir?.();
if (ipcDir) {
    const ipcMarkerFile = path.join(switchboardDir, 'ipc-available.txt');
    fs.writeFileSync(ipcMarkerFile, ipcDir, 'utf8');
}
```

In the standalone shutdown handler (line 2569-2579), extend `syncUnlinkPortFile` to also unlink the IPC marker:

```ts
const syncUnlinkPortFile = () => {
    try { if (fs.existsSync(portFile)) fs.unlinkSync(portFile); } catch { /* ignore */ }
    if (ipcMarkerFile) {
        try { if (fs.existsSync(ipcMarkerFile)) fs.unlinkSync(ipcMarkerFile); } catch { /* ignore */ }
    }
};
```

### 9. `.agents/skills/_lib/sb_ipc_call.sh` — new file-based IPC client

New shared library for file-based IPC calls. Sourced by skills when TCP is unavailable:

```bash
#!/bin/bash

# File-based IPC client for Switchboard LocalApiServer.
# Used when TCP loopback (127.0.0.1) is blocked by the sandbox.
# Writes a JSON request file, polls for a JSON response file.

sb_ipc_call() {
    local METHOD="$1"
    local PATH_NAME="$2"
    shift 2

    local CUR="$PWD"
    local SB_ROOT=""
    while [ "$CUR" != "/" ]; do
        if [ -f "$CUR/.switchboard/ipc-available.txt" ]; then
            SB_ROOT="$CUR"
            break
        fi
        local NEXT=$(dirname "$CUR")
        if [ "$NEXT" = "$CUR" ]; then break; fi
        CUR="$NEXT"
    done

    if [ -z "$SB_ROOT" ]; then
        echo '{"error":"Switchboard IPC not available. Ensure the extension is active."}' >&2
        return 1
    fi

    local IPC_DIR=$(cat "$SB_ROOT/.switchboard/ipc-available.txt" 2>/dev/null)
    local REQUESTS_DIR="$IPC_DIR/requests"
    local RESPONSES_DIR="$IPC_DIR/responses"

    if [ ! -d "$REQUESTS_DIR" ] || [ ! -d "$RESPONSES_DIR" ]; then
        echo '{"error":"Switchboard IPC directories not found."}' >&2
        return 1
    fi

    # ── Superseded callout (request ID + JSON body construction) ──
    # > **Superseded:** `REQ_ID="req-$(date +%s%N 2>/dev/null || date +%s)-$$-$RANDOM"`
    # >   and heredoc body `{"body":${BODY:-null}}`.
    # > **Reason:** macOS BSD `date` emits a literal "N" for `%N` (no nanosecond
    # >   support), producing a misleading but still-unique ID. Worse, heredoc
    # >   interpolation of `BODY` breaks JSON on any double-quote, backslash, or
    # >   newline in the request body — the server's `JSON.parse` throws and the
    # >   client hangs until timeout.
    # > **Replaced with:** `uuidgen`-based ID (cross-platform) and node/python3
    # >   JSON encoding of path + body from argv (no interpolation injection).
    # ── End callout ─

    # Generate unique request ID.
    # NOTE: macOS BSD `date` does NOT support %N (nanoseconds) — it emits the
    # literal character "N", producing a misleading ID like `req-<secs>N-<pid>`.
    # Use uuidgen when available (macOS + Linux), falling back to seconds+pid+random.
    local REQ_ID="req-$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || echo "$(date +%s)-$$-$RANDOM")"
    local REQ_FILE="$REQUESTS_DIR/$REQ_ID.json"
    local RESP_FILE="$RESPONSES_DIR/resp-${REQ_ID#req-}.json"

    # Build request JSON.
    # The body and path must be JSON-escaped — heredoc interpolation breaks on
    # double-quotes, backslashes, and newlines inside BODY. Use node (available
    # in every coding-agent sandbox) to build safe JSON from argv.
    local BODY="${1:-}"
    local HEADERS='{"Content-Type":"application/json"}'
    if [ -n "$SWITCHBOARD_API_TOKEN" ]; then
        HEADERS="{\"Content-Type\":\"application/json\",\"Authorization\":\"Bearer $SWITCHBOARD_API_TOKEN\"}"
    fi

    # Write request file (tmp+rename for atomicity).
    # Use node to JSON-encode path and body so no interpolation injection is
    # possible. Headers are constructed above from trusted env vars (safe).
    local TMP_REQ="$REQ_FILE.tmp"
    if command -v node >/dev/null 2>&1; then
        node -e '
            const fs = require("fs");
            const id = process.argv[1], method = process.argv[2], p = process.argv[3],
                  headers = process.argv[4], body = process.argv[5];
            const obj = { id, method, path: p, headers: JSON.parse(headers), body: body ? JSON.parse(body) : null };
            fs.writeFileSync(process.argv[6], JSON.stringify(obj));
        ' "$REQ_ID" "$METHOD" "$PATH_NAME" "$HEADERS" "$BODY" "$TMP_REQ"
    else
        # Fallback: python3 for JSON escaping
        python3 -c '
import json, sys
obj = {"id": sys.argv[1], "method": sys.argv[2], "path": sys.argv[3],
       "headers": json.loads(sys.argv[4]), "body": json.loads(sys.argv[5]) if sys.argv[5] else None}
with open(sys.argv[6], "w") as f: json.dump(obj, f)
' "$REQ_ID" "$METHOD" "$PATH_NAME" "$HEADERS" "$BODY" "$TMP_REQ"
    fi
    mv "$TMP_REQ" "$REQ_FILE"

    # Poll for response (50ms interval, 10s timeout)
    local ATTEMPTS=0
    local MAX_ATTEMPTS=200
    while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
        if [ -f "$RESP_FILE" ]; then
            local RESP_BODY
            RESP_BODY=$(cat "$RESP_FILE" 2>/dev/null)
            rm -f "$RESP_FILE" "$REQ_FILE" 2>/dev/null

            # Extract status and body from response JSON
            local STATUS
            STATUS=$(echo "$RESP_BODY" | node -e '
                try { const r = JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(r.status||200)); } catch { process.stdout.write("500"); }
            ' 2>/dev/null || echo "500")

            local BODY_OUT
            BODY_OUT=$(echo "$RESP_BODY" | node -e '
                try { const r = JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(r.body||""); } catch { process.stdout.write(""); }
            ' 2>/dev/null || echo "")

            echo "$BODY_OUT"
            if [ "$STATUS" -ge 400 ]; then
                return 1
            fi
            return 0
        fi
        sleep 0.05
        ATTEMPTS=$(( ATTEMPTS + 1 ))
    done

    # Timeout — clean up and fail
    rm -f "$REQ_FILE" 2>/dev/null
    echo '{"error":"Switchboard IPC timeout — server not responding."}' >&2
    return 1
}
```

### 10. `.agents/skills/_lib/sb_api_call.sh` — add IPC fallback

Update `sb_api_call()` to try TCP first, fall back to file-based IPC when TCP is blocked:

```bash
# After the TCP health check fails (line 113-116), before returning error:
if [ $HEALTH_OK -ne 1 ]; then
    # TCP failed — try file-based IPC
    if [ -f "$SB_ROOT/.switchboard/ipc-available.txt" ]; then
        # Source the IPC library and delegate
        local IPC_LIB="$(dirname "${BASH_SOURCE[0]}")/sb_ipc_call.sh"
        if [ -f "$IPC_LIB" ]; then
            source "$IPC_LIB"
            sb_ipc_call "$METHOD" "$PATH_NAME" "$@"
            return $?
        fi
    fi
    echo '{"error":"Switchboard API server not reachable via TCP or IPC."}' >&2
    return 1
fi
```

### 11. Skill/workflow discovery blocks — add IPC fallback

Update the standard discovery block in all skill files to try TCP first, fall back to IPC:

```bash
# Standard discovery block (updated)
PORT=$(tr -d '[:space:]' < "${WORKSPACE_ROOT:-$PWD}/.switchboard/api-server-port.txt" 2>/dev/null)
IPC_AVAILABLE="${WORKSPACE_ROOT:-$PWD}/.switchboard/ipc-available.txt"

# Try TCP first
if [ -n "$PORT" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null)" = "200" ]; then
  BASE="http://127.0.0.1:$PORT"
  TRANSPORT="tcp"
elif [ -f "$IPC_AVAILABLE" ]; then
  # TCP blocked — use file-based IPC
  TRANSPORT="ipc"
  BASE=""  # not used for IPC
else
  echo "Board not answering — no TCP, no IPC. Board is down."
  exit 1
fi

# Helper: make an API call via the active transport
sb_api() {
  local method="$1" path="$2" body="${3:-}"
  if [ "$TRANSPORT" = "tcp" ]; then
    curl -s -X "$method" "$BASE$path" -H "Content-Type: application/json" -d "$body"
  else
    # Source the IPC lib via the SAME walk-up the existing skills use to find
    # sb_api_call.sh. Do NOT use `$(dirname "$0")` — these bash snippets live
    # inline inside .md skill files, so `$0` is `bash`, not the .md path.
    local _CUR="$PWD"
    while [ "$_CUR" != "/" ] && [ ! -d "$_CUR/.agents/skills" ]; do _CUR=$(dirname "$_CUR"); done
    source "$_CUR/.agents/skills/_lib/sb_ipc_call.sh" 2>/dev/null
    if command -v sb_ipc_call >/dev/null 2>&1; then
      sb_ipc_call "$method" "$path" "$body"
    else
      echo '{"error":"sb_ipc_call.sh not found — IPC lib missing from .agents/skills/_lib/."}' >&2
      return 1
    fi
  fi
}
```

> **Superseded:** `source "$(dirname "$0")/../_lib/sb_ipc_call.sh" 2>/dev/null || true`
> **Reason:** These bash snippets are embedded inline in `.md` skill files and pasted into an agent's shell — `$0` is `bash` (or `/bin/bash`), so `dirname "$0"` resolves to `/bin`, not the skill directory. The source silently fails (`|| true`), `sb_ipc_call` is never defined, and the call errors. The grep completeness check still passes (curl → `sb_api`), masking a dead IPC transport behind a green metric.
> **Replaced with:** The `.agents/skills/` walk-up pattern used by every existing skill that sources `sb_api_call.sh` (e.g. `linear-api/SKILL.md`, `get-tickets/SKILL.md`): walk `$PWD` up until `.agents/skills/` is found, then `source "$_CUR/.agents/skills/_lib/sb_ipc_call.sh"`. A `command -v` guard makes the failure visible instead of swallowing it.

Then every `curl -s "$BASE/..."` call becomes `sb_api GET "/path"` or `sb_api POST "/path" "$BODY"`.

**Files to update (same set as the Unix socket plan):**

| File | Discovery blocks | Curl calls |
|------|-----------------|------------|
| `.agents/workflows/switchboard.md` | 2 | 3 |
| `.agents/skills/switchboard-orchestrator/SKILL.md` | 4 | 8 |
| `.agents/skills/switchboard-orchestration/SKILL.md` | 3 | 20 |
| `.agents/skills/terminal-coder-dispatch/SKILL.md` | 2 | 12 |
| `.agents/skills/external-team-lead/SKILL.md` | 1 | 6 |
| `.agents/skills/delegates/SKILL.md` | 0 (uses sb_api_call.sh) | 2 (inline) |
| `.agents/skills/rearrange-feature/SKILL.md` | 0 (uses sb_api_call.sh) | 2 (inline) |

The `.claude/skills/` mirrors are auto-regenerated from `.agents/` by `ClaudeCodeMirrorService` — no manual changes needed.

**Completeness verification:** After updating all files, grep for curl calls that don't use `sb_api` or `$CURL_SOCKET`:

```bash
grep -rn 'curl.*127\.0\.0\.1' .agents/workflows/ .agents/skills/ \
  | grep -v 'sb_api' \
  | grep -v 'sb_api_call' \
  | grep -v 'health'
```

Any output = a missed update. Zero output = all curl calls updated.

### 12. Node.js skill scripts — add IPC fallback

> **Superseded:** Rename `findApiPort` → `findApiInfo` (returning `{port, ipcDir, root}`) and change `httpJson`'s signature from `(method, port, urlPath, bodyObj, timeoutMs)` to `(method, info, urlPath, bodyObj, timeoutMs)`.
> **Reason:** The actual code in `kanban_operations/*.js` defines `findApiPort(startDir)` (returns a port **string**) and `httpJson(method, port, urlPath, bodyObj, timeoutMs)`. Every call site — `tryViaExtension`, health checks, `/kanban/move`, etc. — passes `port` (a string), not an `info` object. The plan's renamed `findApiInfo` and re-signed `httpJson` do not exist in the codebase. A coder following the plan literally writes code where `Number(info.port)` runs on a string (works by accident) but every existing call site still passes a bare port string where the new `httpJson` expects an object — `info.ipcDir` throws `undefined`. The IPC fallback is unreachable and the TCP path is broken. This is a signature-breaking refactor disguised as an additive change.
> **Replaced with:** Keep `findApiPort` and `httpJson` signatures **unchanged**. Add two new functions — `findIpcDir(startDir)` and `ipcCall(method, ipcDir, urlPath, bodyObj, timeoutMs)` — and modify `tryViaExtension` to fall back to IPC when the TCP health check fails. This is purely additive: zero existing call sites change.

**Add `findIpcDir`** (walks up for `ipc-available.txt`, same shape as `findApiPort`):

```js
function findIpcDir(startDir) {
  let cur = path.resolve(startDir);
  while (true) {
    const ipcFile = path.join(cur, '.switchboard', 'ipc-available.txt');
    try {
      if (fs.existsSync(ipcFile)) {
        const ipcDir = fs.readFileSync(ipcFile, 'utf8').trim();
        if (ipcDir) return ipcDir;
      }
    } catch { /* keep walking */ }
    const next = path.dirname(cur);
    if (next === cur) return null;
    cur = next;
  }
}
```

**Add `ipcCall`** (writes a request file, polls for the response file — same wire format as the shell client):

```js
function ipcCall(method, ipcDir, urlPath, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = `req-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const reqFile = path.join(ipcDir, 'requests', `${id}.json`);
    const respFile = path.join(ipcDir, 'responses', `resp-${id.slice(4)}.json`);
    const payload = bodyObj ? JSON.stringify(bodyObj) : '';
    const reqData = JSON.stringify({ id, method, path: urlPath, headers: {}, body: payload || null });
    const tmpReq = reqFile + '.tmp';
    try {
      fs.writeFileSync(tmpReq, reqData);
      fs.renameSync(tmpReq, reqFile);
    } catch (err) {
      reject(err);
      return;
    }
    const start = Date.now();
    const poll = setInterval(() => {
      if (fs.existsSync(respFile)) {
        clearInterval(poll);
        try {
          const resp = JSON.parse(fs.readFileSync(respFile, 'utf8'));
          try { fs.unlinkSync(respFile); } catch { /* already gone */ }
          try { fs.unlinkSync(reqFile); } catch { /* already gone */ }
          resolve({ status: resp.status, body: resp.body });
        } catch (err) {
          reject(err);
        }
      } else if (Date.now() - start > (timeoutMs || 30000)) {
        clearInterval(poll);
        try { fs.unlinkSync(reqFile); } catch { /* already gone */ }
        reject(new Error('IPC timeout'));
      }
    }, 50);
  });
}
```

**Modify `tryViaExtension`** to fall back to IPC when TCP health fails (example from `move-card.js`; same edit in every script):

```js
async function tryViaExtension() {
  const port = findApiPort(workspaceRoot) || findApiPort(process.cwd());
  if (port) {
    try {
      const health = await httpJson('GET', port, '/health', null, 2000);
      if (health && health.status === 200) {
        // TCP works — route through the extension as before (unchanged).
        try {
          const move = await httpJson('POST', port, '/kanban/move', {
            sessionId: effectiveKey, targetColumn, workspaceRoot,
            planFile: resolvedPlanFile || undefined
          }, 15000);
          let parsed = {};
          try { parsed = JSON.parse(move.body); } catch { /* non-JSON body */ }
          if (move.status >= 200 && move.status < 300 && parsed.success) {
            return { reachable: true, success: true };
          }
          return { reachable: true, success: false, error: parsed.error || `HTTP ${move.status}` };
        } catch (err) {
          return { reachable: true, success: false, error: err.message };
        }
      }
    } catch {
      // TCP health failed — fall through to IPC below.
    }
  }

  // TCP unreachable or blocked — try file-based IPC.
  const ipcDir = findIpcDir(workspaceRoot) || findIpcDir(process.cwd());
  if (ipcDir) {
    try {
      const move = await ipcCall('POST', ipcDir, '/kanban/move', {
        sessionId: effectiveKey, targetColumn, workspaceRoot,
        planFile: resolvedPlanFile || undefined
      }, 15000);
      let parsed = {};
      try { parsed = JSON.parse(move.body); } catch { /* non-JSON body */ }
      if (move.status >= 200 && move.status < 300 && parsed.success) {
        return { reachable: true, success: true };
      }
      return { reachable: true, success: false, error: parsed.error || `HTTP ${move.status}` };
    } catch (err) {
      return { reachable: true, success: false, error: err.message };
    }
  }

  return { reachable: false };
}
```

**Key differences from the superseded approach:**
- `findApiPort` and `httpJson` signatures are **untouched** — zero existing call sites change.
- `ipcCall` uses `try/catch` around `fs.unlinkSync` (the superseded version called `.catch()` on `unlinkSync`'s `undefined` return, which throws `TypeError`).
- `timeoutMs` is a parameter of `ipcCall` (the superseded version referenced it from the enclosing `httpJson` scope where it didn't exist).
- The TCP path in `tryViaExtension` is preserved verbatim; IPC is a fallback branch, not a replacement.

**Files to update:**
- `kanban_operations/create-feature.js`
- `kanban_operations/move-card.js`
- `kanban_operations/split-feature.js`
- `kanban_operations/assign-to-feature.js`
- `kanban_operations/remove-from-feature.js`
- `kanban_operations/delete-feature.js`
- `kanban_operations/reconcile-features.js`
- `kanban_operations/get-state.js`

## Edge-Case & Dependency Audit

**Self-HTTP round-trip latency** — the server-side watcher makes an `http.request` to `127.0.0.1:port` for each IPC request. This is a same-process loopback call (~0.5ms TCP overhead). The codebase warns against self-HTTP for liveness probes (line 594-600: "it times out on a starved host and produces a false negative"), but for actual API calls, the request queues in the event loop like any external request. If the host is starved, both IPC and external TCP requests would be equally delayed. The IPC transport adds ~50ms polling latency on the client side (50ms poll interval), so total latency is ~50.5ms per call vs ~0.5ms for direct TCP. Acceptable for Switchboard's API calls (health checks, plan reads, card moves — not high-frequency).

**fs.watch reliability** — `fs.watch` is unreliable on network drives (NFS, SMB), some macOS configurations, and can fire duplicate events. The watcher includes: (1) a polling fallback (readdir every 500ms) if `fs.watch` fails, (2) a dedup set (`_ipcProcessing`) to prevent duplicate processing, (3) atomic file writes (tmp+rename) to prevent partial reads. Same pattern as TaskViewerProvider's native fs.watch fallback (line 15271).

**Orphaned files** — if the server crashes mid-request, request files are left in `requests/` and response files in `responses/`. The server cleans these on startup (`_cleanupIpcOrphans`). If the client crashes after writing a request but before reading the response, the response file is orphaned — a periodic cleanup timer purges response files older than 2 minutes (`_purgeOldIpcResponses`).

**Concurrent agents** — multiple sandboxed agents may write request files simultaneously. Each request has a unique ID (timestamp + PID + random), so there are no file conflicts. The server processes requests concurrently (async, no serialization needed).

**Client timeout** — the client polls for the response file with a 10s timeout (200 attempts × 50ms). If the server is down or slow, the client gives up and reports an error. The request file is cleaned up on timeout.

**IPC directory creation** — the server creates `.switchboard/ipc/requests/` and `.switchboard/ipc/responses/` with `recursive: true` on start. The `never-create-.switchboard/` rule (from TaskViewerProvider) does not apply here — the server creates `ipc/` inside the existing `.switchboard/` directory, not the `.switchboard/` marker itself.

**Multi-root workspaces** — the IPC directory lives in the primary workspace root's `.switchboard/ipc/`. The IPC marker file (`ipc-available.txt`) is written to every eligible root (same pattern as the port file). Agents in secondary roots read the marker file to find the IPC directory path.

**`.claude/skills/` mirror gap (harmless)** — the `ClaudeCodeMirrorService` mirrors `.agents/skills/*/SKILL.md` into `.claude/skills/` but does **not** mirror the shared `_lib/` directory (`.claude/skills/_lib/` does not exist). This is harmless because both the existing `sb_api_call.sh` sourcing and the new `sb_ipc_call.sh` sourcing use a walk-up that finds `.agents/skills/` from the workspace root — they never reference `.claude/skills/_lib/`. The new `sb_ipc_call.sh` must be placed in `.agents/skills/_lib/` (where the walk-up finds it), not in `.claude/`.

**Standalone mode** — the standalone bootstrap (`bootstrap.ts`) starts the IPC watcher as part of `server.start()` and writes the IPC marker file alongside the port file. The shutdown handler unlinks the marker file.

**Auth token** — if a token is set (`SWITCHBOARD_API_TOKEN` env var), the IPC client includes it in the request headers. The self-HTTP helper passes it through to `_handleRequest`, which validates it. No change to auth logic.

**WebSocket** — file-based IPC is HTTP-only. WebSocket upgrades continue over TCP. No change to WebSocket behaviour.

**Existing port file plan** — the plan `api-server-port-file-missing-from-eligible-roots.md` fixes per-root port file propagation. The IPC marker file should follow the same per-root write/stop pattern. If that plan has not landed, this plan follows the current code's pattern.

**stop() / watcher race** — `stop()` sets `_ipcDir = null` and closes the watcher, but a watcher callback already queued in the event loop may still fire `_processIpcRequest`. The function guards against this by snapshotting `this._ipcDir` into a local and returning early if null (see §2). Without this guard, `this._ipcDir!` is a null-deref that leaves the filename in `_ipcProcessing` forever.

## Dependencies

- None. This plan is self-contained. The IPC transport is additive to the existing TCP transport.

## Adversarial Synthesis

Key risks: (1) the `sb_api` shell helper's IPC source path must use the `.agents/skills/` walk-up, not `$0`-relative — a wrong path silently kills the IPC transport while the grep completeness check stays green (fixed in §11); (2) the Node.js skill scripts must keep `findApiPort`/`httpJson` signatures unchanged and add IPC as a fallback branch — a signature-breaking refactor would break every existing call site (fixed in §12); (3) JSON body construction in `sb_ipc_call.sh` must escape via node/python3, not heredoc interpolation — unescaped quotes/backslashes/newlines produce malformed JSON and a client hang (fixed in §9); (4) `stop()` racing with an in-flight watcher event can null-deref `_ipcDir` — guarded by a local snapshot (fixed in §2); (5) 50+ curl calls across 7 skill files must be updated to `sb_api` — a single miss silently falls back to raw TCP (sandbox-blocked), mitigated by grep completeness check; (6) fs.watch reliability on network drives — mitigated by polling fallback and dedup; (7) orphaned files from crashes — mitigated by startup cleanup and periodic response purging. Residual risk: the 50ms polling interval adds latency to every IPC call — reducible to 10ms at higher CPU cost.

## Verification Plan

### Automated Tests
- **New:** `src/test/api-server-file-ipc-contract.test.js` — behavioural tests:
  - server creates IPC directories on start
  - writing a request file produces a response file with correct status and body
  - `GET /health` over IPC returns the same response as over TCP
  - `POST /orchestration/adopt` over IPC works identically to TCP
  - `stop()` cleans up IPC directories and stops the watcher
  - orphaned files are cleaned up on restart
  - concurrent requests (multiple request files) are processed without conflict
  - malformed request file produces an error response (not a crash)
  - client timeout (no response within 10s) is handled gracefully
  - **request body with double-quotes and newlines** is correctly JSON-escaped by `sb_ipc_call.sh` (regression test for the heredoc-injection bug)
  - **`stop()` during an in-flight IPC request** does not null-deref `_ipcDir` (the local-snapshot guard)
- **New:** grep-based completeness check for skill/workflow curl updates:
  ```bash
  grep -rn 'curl.*127\.0\.0\.1' .agents/workflows/ .agents/skills/ \
    | grep -v 'sb_api' | grep -v 'sb_api_call' | grep -v 'health'
  ```
  Zero output = all curl calls updated.
- **New:** grep check that no skill sources `sb_ipc_call.sh` via a `$0`-relative path (regression test for the broken source path):
  ```bash
  grep -rn 'dirname.*\$0.*sb_ipc_call' .agents/workflows/ .agents/skills/
  ```
  Zero output = all sourcing uses the `.agents/skills/` walk-up.
- **New:** `kanban_operations/*.js` IPC fallback test — start the server, block TCP (or point `findApiPort` at a dead port), confirm `tryViaExtension` falls back to `ipcCall` and succeeds. Verifies `findApiPort`/`httpJson` signatures are unchanged and the IPC branch is reachable.
- `npm run test:contract:orchestrator-tick` — exercises adopt/dispatch paths. Establish pre-existing counts before starting.
- `npm run compile-tests` must be clean for `LocalApiServer.ts` and `TaskViewerProvider.ts`.
- `npm run catalog:check`, `npm run parity:check` — unaffected by design; run to confirm.

### Manual
1. Start the Switchboard extension. Confirm `.switchboard/ipc/requests/` and `.switchboard/ipc/responses/` directories exist and `.switchboard/ipc-available.txt` contains the IPC directory path.
2. Write a test request file to `.switchboard/ipc/requests/req-test.json` with `{"method":"GET","path":"/health"}`. Confirm a response file appears in `responses/` with status 200.
3. From a sandboxed agent shell where TCP is blocked, run a skill that uses `sb_api_call.sh`. Confirm it falls back to file-based IPC and succeeds.
4. Stop the extension. Confirm IPC directories are removed and the marker file is unlinked.
5. Crash the extension (kill -9). Restart. Confirm orphaned IPC files are cleaned up.
6. From a PTY terminal agent (internal fleet), confirm it still uses TCP directly (no IPC fallback needed).
7. Write 10 concurrent request files simultaneously. Confirm all 10 responses are produced without conflict.
8. Send an IPC request whose body contains a double-quote and a newline (e.g. `{"query":"mutation { x }\\n"}`). Confirm the server receives valid JSON and returns a correct response — not a 500 from a parse failure.
9. Run a `kanban_operations/*.js` script (e.g. `move-card.js`) from a shell where TCP to `127.0.0.1` is blocked. Confirm it falls back to `ipcCall` and the card moves.

**Recommendation:** Complexity 6 → **Send to Coder.**
