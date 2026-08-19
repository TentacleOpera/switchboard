# ~~Add Unix domain socket transport to LocalApiServer so agents bypass sandbox loopback blocks~~

> **SUPERSEDED — do not implement.** Web research (2026-08-19) confirmed macOS Seatbelt blocks Unix domain socket `connect()` by default alongside TCP. The user's primary platform is macOS (Darwin 25.2.0). The Unix socket approach works on Linux but requires per-agent sandbox config on macOS that the extension cannot automate — making it a non-solution for the user's platform. Replaced by two new plans:
> - `add-file-based-ipc-transport.md` — universal file-based IPC for sandboxed agents (all platforms, zero config)
> - `add-mcp-stdio-transport.md` — MCP stdio server for platforms that support it (server runs outside sandbox, bypasses network restrictions entirely)
>
> This plan is retained as a historical record of the analysis. The `_handleRequest` remoteAddress finding (change #1b) remains valid if Unix sockets are revisited in the future.

## Goal

Agentic coding platforms (Devin, Cursor, Windsurf) sandbox shell commands and block "direct IP access" — including `127.0.0.1`. Agents running Switchboard skills must use `BypassSandbox: true` to reach the LocalApiServer over TCP loopback, which is a retry-and-workaround pattern that makes users uncomfortable and wastes a round-trip on every launch. Unix domain sockets are filesystem-based IPC — not TCP, not IP. On Linux sandboxes (Bubblewrap, Docker, nsjail), filesystem-bound Unix sockets bypass network namespace isolation (`CLONE_NEWNET`) because path resolution goes through the mount namespace, not the network stack. On macOS, Apple's Seatbelt (`sandbox-exec` / SBPL) MAC framework blocks Unix socket `connect()` calls by default alongside TCP — but allows explicit per-path exceptions via sandbox config directives (e.g., Claude Code's `sandbox.network.allowUnixSockets`, Cursor's `~/.cursor/sandbox.json`). Add a Unix domain socket listener to LocalApiServer alongside the existing TCP listener, write the socket path to a discovery file, update all skill/workflow discovery blocks and curl calls to prefer the socket when available (falling back to TCP when it is not), and document the macOS sandbox config required to unblock the socket path on Seatbelt-based agent platforms.

### Problem analysis and root cause

Observed 2026-08-19: the orchestrator agent's pre-flight health check and adopt call to `http://127.0.0.1:51011` were blocked by the sandbox with "Direct IP access is not allowed" (HTTP 400). The agent retried with `BypassSandbox: true`, which worked. The user does not want to rely on sandbox bypass.

The sandbox blocks TCP connections to IP addresses. Unix domain sockets are filesystem-based IPC — they are not TCP, not IP. On Linux, filesystem-bound Unix sockets bypass network namespace isolation because the kernel resolves the socket path through the mount namespace (VFS), not the network stack. `curl --unix-socket /path/to/sock http://localhost/health` connects via the socket file, not via IP. On macOS, the Seatbelt MAC framework intercepts socket syscalls at the kernel level — Unix socket `connect()` is blocked by default under restrictive profiles, but can be allowed via explicit per-path sandbox config rules (see `## Resolved Assumptions` below for the full platform breakdown).

Switchboard previously had an MCP server (removed July 2026 — see `.switchboard/plans/remove-claude-desktop-mcp-bridge-and-cowork-skill.md`) as an alternative transport for shell-less hosts. That was a different problem (no shell at all) with a different solution (MCP stdio). This plan solves a different problem (sandboxed shell, no loopback) with a simpler solution (Unix socket) that does not require bringing back MCP.

## Metadata

**Complexity:** 6
**Tags:** backend, infrastructure, api, reliability, cli

## User Review Required

No — the core sandbox compatibility assumption has been resolved by web research (see `## Resolved Assumptions`). The user should review the macOS Seatbelt limitation (change #8) and decide whether to proceed with the Unix socket + macOS config approach, or defer until a file-based IPC fallback (recommended follow-up plan) is also available.

## Complexity Audit

### Routine
- Adding a second `http.Server` with the same request handler — standard Node.js `server.listen(path)` API.
- Writing a discovery text file (`api-server-socket.txt`) alongside the existing port file — same tmp+rename pattern.
- Adding `getSocketPath()` accessor — one-liner getter.
- Adding `socketPath` to the `/health` response — one field in an existing JSON object.
- Updating `sb_api_call.sh` to check for socket file first — conditional branch before existing TCP logic.
- Updating Node.js skill scripts (`findApiInfo` / `httpJson`) — mechanical pattern change across 8 files.

### Complex / Risky
- **`_handleRequest` remoteAddress check** — the shared request handler rejects connections where `req.socket.remoteAddress` is not `127.0.0.1` or `::1`. Unix socket connections have `remoteAddress === undefined`. Without a fix, every socket request returns 403. This is the #1 risk and must be addressed (see change #1b).
- **macOS Seatbelt blocks Unix sockets by default** — on macOS, Apple's Seatbelt MAC framework intercepts `connect()` to Unix domain sockets at the kernel level. Restrictive sandbox profiles (used by Claude Code, Cursor) block Unix sockets alongside TCP. The socket path must be explicitly allowed via per-platform sandbox config (see change #8). Without this config, the Unix socket is created on the server side but agents cannot connect to it — they fall back to TCP, which the sandbox also blocks. The feature works on Linux out of the box but requires a one-time config step on macOS.
- **Skill/workflow discovery block updates** — 7 files, 50+ curl calls must be updated to include `$CURL_SOCKET`. A single missed call silently falls back to TCP, which the sandbox blocks. No automated test catches a missed curl call; a grep-based completeness check is required.
- **Multi-host socket collision** — two Switchboard extensions sharing a root both attempt to create the same socket file. The `unlink` before `listen` means the second server overwrites the first's socket. Cleanup on stop must verify ownership before unlinking.
- **Socket path length limits** — Unix domain socket paths have a system limit (108 bytes on Linux, 104 on macOS). Deep workspace roots could exceed this. The try/catch fallback handles it, but the failure is silent.

## Proposed Changes

### 1a. `src/services/LocalApiServer.ts` — add field declarations

Add two new private fields alongside `_server` (line 484) and `_wsHub` (line 496):

```ts
private _socketPath: string | null = null;
private _socketServer: http.Server | null = null;
```

### 1b. `src/services/LocalApiServer.ts` — fix `_handleRequest` remoteAddress check

> **Superseded:** Same request handler — `_handleRequest` is shared, so every endpoint works identically over the socket.
> **Reason:** `_handleRequest` (line 4412-4417) checks `req.socket.remoteAddress` and requires `127.0.0.1` or `::1`. For Unix domain socket connections, `req.socket.remoteAddress` is `undefined` (Node.js docs: "For Unix socket sockets, this is undefined"). Every request over the Unix socket would be rejected with 403 "Access denied: localhost only." The feature would be dead on arrival — agents connect, get 403, fall back to TCP, get blocked by the sandbox.
> **Replaced with:** The socket server's request handler marks requests with a server-side flag (`__fromUnixSocket`), and `_handleRequest` allows flagged requests through the remoteAddress check. The flag is set by the server code, not by the client — a TCP client cannot inject this property on the request object.

In `_handleRequest` (line 4410-4417), update the remoteAddress guard:

```ts
private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Restrict to localhost only. Unix socket connections have
    // remoteAddress === undefined; the socket server marks them with
    // __fromUnixSocket so they pass this guard. The flag is set by the
    // server code (not the client), so a TCP peer cannot bypass this check.
    const remoteAddress = req.socket.remoteAddress;
    const fromUnixSocket = (req as any).__fromUnixSocket === true;
    if (!fromUnixSocket && remoteAddress !== '127.0.0.1' && remoteAddress !== '::1') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied: localhost only' }));
        return;
    }
    // ... rest of _handleRequest unchanged
```

### 1c. `src/services/LocalApiServer.ts` — add Unix socket listener in `start()`

After the TCP listener succeeds in `start()` (line 533, inside the listen callback after `resolve(this._port)` is called but before or after — the socket is additive and non-blocking), create a second `http.Server` with a wrapper handler that sets the `__fromUnixSocket` flag, listening on a Unix domain socket:

> **Superseded:** The original code sample used `fs.promises.unlink`, `fs.chmodSync`, and `fs.unlinkSync`.
> **Reason:** The file imports `import * as fs from 'fs/promises'` (already the promises API — `fs.promises` does not exist on it) and `import * as fsSync from 'fs'` (the sync API). The original sample would throw a runtime TypeError on the first line.
> **Replaced with:** Corrected imports — `fs.unlink` (promises), `fsSync.chmodSync`, `fsSync.unlinkSync`.

```ts
// Unix domain socket — sandbox-safe transport for agent/CLI access.
// Sandboxes that block "direct IP access" (127.0.0.1) typically allow
// Unix socket connections. The TCP listener remains for browser/webview
// access (WebSocket upgrades, board HTML). The socket is agent-only.
this._socketPath = path.join(this._options.workspaceRoot, '.switchboard', 'api-server.sock');
try {
    // Clean up stale socket from a previous crash
    try { await fs.unlink(this._socketPath); } catch { /* not present */ }
    this._socketServer = http.createServer(async (req, res) => {
        // Mark request as socket-originated so _handleRequest's
        // remoteAddress guard allows it through.
        (req as any).__fromUnixSocket = true;
        await this._handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
        this._socketServer!.listen(this._socketPath, () => {
            // Restrict to owner-only (0o600) — same trust model as TCP loopback
            try { fsSync.chmodSync(this._socketPath!, 0o600); } catch { /* best-effort */ }
            console.log(`[LocalApiServer] Unix socket listening at ${this._socketPath}`);
            resolve();
        });
        this._socketServer!.on('error', reject);
    });
} catch (err) {
    // Socket is additive — if it fails (Windows, permissions, path too long),
    // TCP still works. Log and continue.
    console.warn(`[LocalApiServer] Unix socket failed (non-fatal, TCP still active): ${err}`);
    this._socketServer = null;
    this._socketPath = null;
}
```

Key design decisions:
- **Wrapper handler with `__fromUnixSocket` flag** — the socket server's handler sets a server-side flag on each request before delegating to `_handleRequest`. This allows the request through the remoteAddress guard (change #1b). The flag cannot be set by a TCP client.
- **No WebSocket on the socket** — agents use HTTP only; WebSocket upgrades are for the browser board. The socket server does not attach `wsHub` or handle `upgrade` events.
- **Permissions `0o600`** — owner-only read/write, matching the trust model of TCP loopback binding.
- **Non-fatal failure** — if the socket cannot be created (Windows, restrictive permissions, path length limits), the server continues on TCP alone. The discovery file (change #3) is not written when the socket fails, so agents fall back to TCP automatically.
- **Stale socket cleanup** — `unlink` before `listen` handles the case where a previous server crashed without cleaning up.

### 1d. `src/services/LocalApiServer.ts` — expose socket path and clean up on stop

Add a `getSocketPath()` accessor (alongside `getPort()` at line 611):

```ts
public getSocketPath(): string | null {
    return this._socketPath;
}
```

In `stop()` (line 630), add socket server cleanup **before** the TCP server close, so both are handled even if the TCP server is null:

```ts
async stop(): Promise<void> {
    this._isListening = false;
    if (this._wsHub) {
        this._wsHub.close();
        this._wsHub = null;
    }
    // Close Unix socket server and unlink the socket file
    if (this._socketServer) {
        await new Promise<void>((resolve) => {
            this._socketServer?.close(() => {
                try { fsSync.unlinkSync(this._socketPath!); } catch { /* already gone */ }
                this._socketServer = null;
                resolve();
            });
        });
    }
    // Close TCP server
    if (this._server) {
        return new Promise((resolve) => {
            this._server?.close(() => {
                console.log('[LocalApiServer] Stopped');
                resolve();
            });
        });
    }
}
```

### 1e. `src/services/LocalApiServer.ts` — update `_cleanupTempFiles`

In `_cleanupTempFiles` (line 649-663), add the socket discovery tmp file to the cleanup list:

```ts
if (file.endsWith('.json.tmp') || file === 'api-server-port.txt.tmp' || file === 'api-server-socket.txt.tmp') {
```

### 2. `src/services/TaskViewerProvider.ts` — write socket path discovery file

In `_startLocalApiServer` (line 3584-3601), after writing the port file, also write the socket path. Use the same per-eligible-root, tmp+rename, never-create-`.switchboard/` pattern:

```ts
const socketPath = this._localApiServer?.getSocketPath?.();
if (socketPath) {
    for (const root of this._filterPortFileEligibleRoots(allRoots)) {
        const socketFilePath = path.join(root, '.switchboard', 'api-server-socket.txt');
        const tempSocketPath = socketFilePath + '.tmp';
        try {
            await fs.promises.writeFile(tempSocketPath, socketPath, 'utf8');
            await fs.promises.rename(tempSocketPath, socketFilePath);
        } catch (writeErr) {
            console.warn(`[TaskViewerProvider] Failed to write socket file to ${root}:`, writeErr);
        }
    }
}
```

The socket file itself (`api-server.sock`) lives in the primary workspace root's `.switchboard/` only (the server creates it from `this._options.workspaceRoot`). The discovery file (`api-server-socket.txt`) is written to every eligible root, same as the port file. Agents read the discovery file to find the socket path.

In `_stopLocalApiServer` (line 3669-3687), add the socket discovery file to the existing unlink loop:

```ts
for (const root of allRoots) {
    const portFilePath = path.join(root, '.switchboard', 'api-server-port.txt');
    await fs.promises.unlink(portFilePath).catch(() => {});
    const socketFilePath = path.join(root, '.switchboard', 'api-server-socket.txt');
    await fs.promises.unlink(socketFilePath).catch(() => {});
}
```

> **Note on "own-port-only guard":** The original plan referenced "the same own-port-only guard pattern as the port file" from `api-server-port-file-missing-from-eligible-roots.md`. That guard pattern does not exist in the current code — `_stopLocalApiServer` unlinks unconditionally across all mapped roots. This plan follows the current code's pattern (unconditional unlink). If the port-file plan lands first and introduces a scoped unlink guard, the socket file unlink should adopt the same guard.

In `_checkApiServerLiveness` (line 3633-3664), add the socket discovery file to the existence check alongside the port file. If the server is alive but the socket discovery file is missing, the current behavior is to restart the server (which rewrites both files). Follow the same pattern — do not add a separate repair step:

```ts
let portFileExists = eligibleRoots.length === 0;
let socketFileExists = eligibleRoots.length === 0;
for (const root of eligibleRoots) {
    const portFilePath = path.join(root, '.switchboard', 'api-server-port.txt');
    const socketFilePath = path.join(root, '.switchboard', 'api-server-socket.txt');
    if (fs.existsSync(portFilePath)) { portFileExists = true; }
    if (fs.existsSync(socketFilePath)) { socketFileExists = true; }
    if (portFileExists && socketFileExists) break;
}

if (serverAlive && portFileExists && socketFileExists) return; // healthy
```

### 3. `src/standalone/bootstrap.ts` — write socket path discovery file

After `server.start()` (line 2493), write the socket path file alongside the port file:

```ts
const socketPath = server.getSocketPath?.();
const socketDiscoveryFile = socketPath ? path.join(switchboardDir, 'api-server-socket.txt') : null;
if (socketPath && socketDiscoveryFile) {
    fs.writeFileSync(socketDiscoveryFile, socketPath, 'utf8');
}
```

In the standalone shutdown handler (line 2569-2579), extend `syncUnlinkPortFile` to also unlink the socket discovery file and the socket file itself:

```ts
const syncUnlinkPortFile = () => {
    try { if (fs.existsSync(portFile)) fs.unlinkSync(portFile); } catch { /* ignore */ }
    if (socketDiscoveryFile) {
        try { if (fs.existsSync(socketDiscoveryFile)) fs.unlinkSync(socketDiscoveryFile); } catch { /* ignore */ }
    }
    if (socketPath) {
        try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch { /* ignore */ }
    }
};
```

Note: `process.on('exit')` runs synchronously — the async `stop()` cleanup may not complete before exit. The sync unlink here is the safety net for the socket file and discovery file. The `unlink` before `listen` in `start()` (change #1c) handles stale sockets from `kill -9` where no shutdown handler fires.

### 4. `.agents/skills/_lib/sb_api_call.sh` — prefer Unix socket in discovery

This shared library is sourced by many skills. Update the discovery in `sb_api_call()` (line 54) to check for the socket file first, inside the existing retry loop. The socket discovery file path uses the already-discovered `SB_ROOT`:

```bash
# Inside the retry loop, before the TCP health check:
local SOCK_FILE="$SB_ROOT/.switchboard/api-server-socket.txt"
local SOCK_PATH=""
if [ -f "$SOCK_FILE" ]; then
    SOCK_PATH=$(cat "$SOCK_FILE" 2>/dev/null)
fi
if [ -n "$SOCK_PATH" ] && [ -S "$SOCK_PATH" ]; then
    # Unix socket — verify health
    local HEALTH_RESPONSE
    HEALTH_RESPONSE=$(curl -s -f --max-time 2 --unix-socket "$SOCK_PATH" "http://localhost/health" 2>/dev/null)
    if [ $? -eq 0 ] && verify_health_json "$HEALTH_RESPONSE" "$SB_ROOT"; then
        HEALTH_OK=1
        # Use socket for the actual API call
        local TEMP_BODY
        TEMP_BODY=$(mktemp /tmp/sb_api_body.XXXXXX 2>/dev/null || echo "/tmp/sb_api_body.$$")
        local HTTP_STATUS
        HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$TEMP_BODY" --unix-socket "$SOCK_PATH" -X "$METHOD" "http://localhost$PATH_NAME" "$@")
        local EXIT_CODE=$?
        # Retry once on transient failure or 5xx (same pattern as TCP)
        if [ $EXIT_CODE -ne 0 ] || { [ "$HTTP_STATUS" -ge 500 ] && [ "$HTTP_STATUS" -le 599 ]; }; then
            sleep 1
            HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$TEMP_BODY" --unix-socket "$SOCK_PATH" -X "$METHOD" "http://localhost$PATH_NAME" "$@")
            EXIT_CODE=$?
        fi
        local RESPONSE_BODY
        RESPONSE_BODY=$(cat "$TEMP_BODY" 2>/dev/null)
        rm -f "$TEMP_BODY"
        if [ $EXIT_CODE -ne 0 ]; then
            echo '{"error":"Switchboard API server not reachable via Unix socket."}' >&2
            return 1
        fi
        echo "$RESPONSE_BODY"
        if [ "$HTTP_STATUS" -ge 400 ]; then
            return 1
        fi
        return 0
    fi
fi
# Fall back to TCP if socket not available or health check failed
# ... existing TCP logic unchanged (lines 84-145)
```

**Important integration note:** The socket check must be **inside** the retry loop (line 83-111), not before it. The socket discovery file may appear after a delay if the server is still starting. The TCP fallback remains as the existing code. If the socket health check succeeds, the function returns early with the socket-based API call. If it fails, execution falls through to the existing TCP logic.

### 5. Skill/workflow discovery blocks — update to prefer socket

All bash discovery blocks in skills follow the same pattern. Update them to check for the socket first:

```bash
# Standard discovery block (updated)
SOCK_FILE="${WORKSPACE_ROOT:-$PWD}/.switchboard/api-server-socket.txt"
PORT=$(tr -d '[:space:]' < "${WORKSPACE_ROOT:-$PWD}/.switchboard/api-server-port.txt" 2>/dev/null)
if [ -f "$SOCK_FILE" ] && [ -S "$(cat "$SOCK_FILE" 2>/dev/null)" ]; then
  SOCK=$(cat "$SOCK_FILE" 2>/dev/null)
  BASE="http://localhost"
  CURL_SOCKET="--unix-socket $SOCK"
else
  BASE="http://127.0.0.1:$PORT"
  CURL_SOCKET=""
fi
[ -n "$PORT" ] || [ -n "$SOCK" ] && [ "$(curl -s $CURL_SOCKET -o /dev/null -w '%{http_code}' "$BASE/health" 2>/dev/null)" = "200" ] \
  || { echo "Board not answering — stale port/socket file, board is down."; exit 1; }
```

Then every `curl -s "$BASE/..."` becomes `curl -s $CURL_SOCKET "$BASE/..."`.

**Files to update (discovery blocks + curl calls):**

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

**Completeness verification:** After updating all files, run a grep to find any curl calls to `$BASE` that do NOT include `$CURL_SOCKET`:

```bash
grep -rn 'curl.*"\$BASE' .agents/workflows/ .agents/skills/ \
  | grep -v 'CURL_SOCKET' \
  | grep -v 'sb_api_call'
```

Any output from this grep is a missed update. Zero output = all curl calls updated.

### 6. Node.js skill scripts — prefer Unix socket

Update `findApiPortInfo` in `kanban_operations/create-feature.js` (and the shared pattern in other `kanban_operations/*.js` files) to also discover the socket path:

```js
function findApiInfo(startDir) {
    let cur = path.resolve(startDir);
    while (true) {
        const switchboardDir = path.join(cur, '.switchboard');
        const portFile = path.join(switchboardDir, 'api-server-port.txt');
        const socketFile = path.join(switchboardDir, 'api-server-socket.txt');
        try {
            if (fs.existsSync(socketFile)) {
                const socketPath = fs.readFileSync(socketFile, 'utf8').trim();
                if (socketPath && fs.existsSync(socketPath)) {
                    return { port: null, socketPath, root: cur };
                }
            }
            if (fs.existsSync(portFile)) {
                const port = fs.readFileSync(portFile, 'utf8').trim();
                if (port) return { port, socketPath: null, root: cur };
            }
        } catch { /* keep walking */ }
        const next = path.dirname(cur);
        if (next === cur) return null;
        cur = next;
    }
}
```

Update `httpJson` to use `socketPath` when available:

```js
function httpJson(method, info, urlPath, bodyObj, timeoutMs) {
    return new Promise((resolve, reject) => {
        const payload = bodyObj ? JSON.stringify(bodyObj) : '';
        const options = info.socketPath
            ? { socketPath: info.socketPath, path: urlPath, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }
            : { host: '127.0.0.1', port: Number(info.port), path: urlPath, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
        const req = http.request(options, (res) => { /* unchanged */ });
        // ... rest unchanged
    });
}
```

**Files to update:**
- `kanban_operations/create-feature.js`
- `kanban_operations/move-card.js`
- `kanban_operations/split-feature.js`
- `kanban_operations/assign-to-feature.js`
- `kanban_operations/remove-from-feature.js`
- `kanban_operations/delete-feature.js`
- `kanban_operations/reconcile-features.js`
- `kanban_operations/get-state.js`

### 7. `GET /health` — include socket path

In the health endpoint response (line 4462-4471), add the socket path:

```ts
res.end(JSON.stringify({
    service: 'switchboard',
    status: 'ok',
    port: this._port,
    socketPath: this._socketPath,   // <-- new
    pid: process.pid,
    roots: this._allRoots,
    // ... existing fields
}));
```

This lets external managers verify socket availability in a single health check.

### 8. macOS sandbox config — document and export Seatbelt socket allow rules

On macOS, agent platforms use Apple's Seatbelt (`sandbox-exec` / SBPL) MAC framework, which blocks Unix domain socket `connect()` calls by default under restrictive profiles. The socket is created server-side but agents cannot connect to it without explicit per-path allow rules. This change documents the required config and, where possible, auto-generates it.

**Claude Code** — add the socket path to `settings.json`:

```json
{
  "sandbox": {
    "network": {
      "allowUnixSockets": [".switchboard/api-server.sock"]
    }
  }
}
```

Or the broader wildcard (less secure, but covers any workspace):

```json
{
  "sandbox": {
    "permissions": {
      "allowAllUnixSockets": true
    }
  }
}
```

**Cursor** — add the socket path to `~/.cursor/sandbox.json` read/write paths so the Seatbelt profile permits `connect()` to the socket file.

**Devin** — Devin's sandbox on macOS blocks "direct IP access" (TCP `127.0.0.1`). Whether Devin's sandbox allows Unix socket connections is not confirmed by the research. The socket path is inside the workspace root (`.switchboard/api-server.sock`), which some sandbox profiles treat as workspace-local and allow. If Devin blocks Unix sockets on macOS, the TCP fallback with `BypassSandbox: true` remains the only option until a file-based IPC fallback is implemented (see `## Recommended Follow-Up`).

**Documentation** — add a section to the Switchboard README or setup guide:

> **macOS agents: Unix socket sandbox config**
>
> Switchboard's Unix domain socket (`.switchboard/api-server.sock`) bypasses TCP loopback sandbox blocks on Linux automatically. On macOS, agent platforms using Apple's Seatbelt sandbox (Claude Code, Cursor) block Unix socket connections by default. Add the socket path to your agent's sandbox config:
> - **Claude Code:** `sandbox.network.allowUnixSockets` in `settings.json`
> - **Cursor:** socket path in `~/.cursor/sandbox.json` read/write paths
>
> Without this config, agents fall back to TCP (which the sandbox blocks) and must use `BypassSandbox: true`.

**Auto-detection (optional, clarification)** — if the Switchboard extension detects it is running on macOS (`process.platform === 'darwin'`), it could log a diagnostic message on startup advising the user to configure their agent's sandbox to allow the socket path. This is a console log only — the extension cannot modify agent sandbox configs.

## Edge-Case & Dependency Audit

**`_handleRequest` remoteAddress rejection** — Unix domain socket connections have `req.socket.remoteAddress === undefined`. The existing guard at line 4412-4417 rejects anything that is not `127.0.0.1` or `::1`. Without the `__fromUnixSocket` flag fix (change #1b), every socket request returns 403. This is the #1 finding from the adversarial review. The fix is a server-side flag set by the socket server's wrapper handler — a TCP client cannot inject this property.

**Windows** — Unix domain sockets are supported on Windows 10 1803+ but the path format and permissions model differ. The server's `try/catch` around socket creation (change #1c) handles this: if the socket fails, `getSocketPath()` returns null, no discovery file is written, and agents fall back to TCP. No Windows-specific code needed — the failure is silent and graceful.

**macOS Seatbelt (SBPL)** — on macOS, Apple's Seatbelt MAC framework intercepts socket syscalls at the kernel level. Restrictive sandbox profiles (used by Claude Code, Cursor) block Unix domain socket `connect()` calls by default — the socket file exists and is readable, but `connect()` returns `EPERM`. This is fundamentally different from Linux, where network namespace isolation (`CLONE_NEWNET`) does not affect filesystem-bound Unix sockets. The fix is per-platform sandbox config (change #8): Claude Code's `sandbox.network.allowUnixSockets`, Cursor's `~/.cursor/sandbox.json`. Without this config, the Unix socket is created server-side but agents cannot connect — they fall back to TCP, which the sandbox also blocks. The feature requires a one-time config step on macOS. Devin's macOS sandbox behavior with Unix sockets is not confirmed by research; the socket path is workspace-local (`.switchboard/api-server.sock`), which some sandbox profiles allow. If Devin blocks it, `BypassSandbox: true` remains the fallback until a file-based IPC transport is implemented (see `## Recommended Follow-Up`).

**gVisor / microVM sandboxes (E2B, cloud VMs)** — gVisor's Sentry intercepts all socket syscalls in userspace and blocks host Unix domain sockets by default unless `--host-uds=all` is explicitly enabled. Firecracker microVMs (E2B) have separate guest kernels — host filesystem Unix sockets cannot be shared. These are cloud-only sandboxes; local agent development on macOS/Linux does not encounter them. Not in scope for this plan — a file-based IPC fallback (recommended follow-up) would be the resilient transport for these environments.

**Multi-host (two Switchboard extensions sharing a root)** — both servers attempt to create `.switchboard/api-server.sock` in the same directory. The `unlink` before `listen` (change #1c) means the second server overwrites the first's socket. This is the same behaviour as the port file: last writer wins, and either server is reachable. The `stop()` cleanup (change #1d) unlinks the socket file unconditionally — if the other server is still running, its socket file is removed and its next connection attempt fails. This is the same risk as the existing port file cleanup. A scoped "verify ownership before unlink" guard would mitigate this but does not exist in the current code (see note in change #2).

**Stale socket after crash** — the `unlink` before `listen` (change #1c) handles this. If the socket file exists but no server is listening, `unlink` removes it and the new server creates a fresh one. The standalone `syncUnlinkPortFile` (change #3) also unlinks the socket file on process exit.

**Socket file path length limits** — Unix domain socket paths have a system limit (108 bytes on Linux, 104 on macOS). `.switchboard/api-server.sock` relative to a deep workspace root could exceed this. If `listen()` fails with `ENAMETOOLONG`, the catch block logs a warning and falls back to TCP. An alternative path (e.g., `/tmp/switchboard-<hash>.sock`) could be used as a fallback, but this adds complexity and is not needed unless the path limit is hit in practice.

**WebSocket** — the Unix socket server does not handle WebSocket upgrades. Browser board access, terminal streaming, and webview panels continue to use TCP. No change to WebSocket behaviour.

**`sb_api_call.sh` uses `localhost` not `127.0.0.1`** — the existing script (line 87) uses `http://localhost:$PORT/health`. With `--unix-socket`, the host in the URL is ignored (the socket path is the transport), so `http://localhost/health` works correctly. No change needed to the URL format.

**`terminal-coder-dispatch/SKILL.md` explicitly says "never `localhost`"** (line 19) because the TCP listener is v4-only and `localhost` can resolve to `::1`. With `--unix-socket`, this concern does not apply — the host is ignored. The skill's documentation should note that the `localhost` avoidance applies to TCP only; when using the socket, `localhost` is fine.

**`_cleanupTempFiles` stale tmp** — the socket discovery file is written via tmp+rename, leaving `api-server-socket.txt.tmp` behind on a crash. Change #1e adds this filename to the cleanup list.

**Existing port file plan** — the plan `api-server-port-file-missing-from-eligible-roots.md` fixes per-root port file propagation. The socket discovery file should follow the same per-root write/repair/stop pattern. If that plan has not yet been implemented, this plan's change #2 follows the current code's pattern (unconditional unlink across mapped roots) and can be consolidated later.

**`agentGroupInstantiation.ts:232`** — tells agents to try `.switchboard/api-port` as a fallback filename. This is a pre-existing dead reference (noted in the port file plan). Not in scope for this plan, but the socket discovery should not replicate the dead fallback pattern.

## Dependencies

- The port file per-root propagation fix (`api-server-port-file-missing-from-eligible-roots.md`) should ideally land first, as change #2 reuses its write helper pattern. If it has not landed, this plan can proceed independently by duplicating the loop (and the duplication can be consolidated later).

## Adversarial Synthesis

Key risks: (1) `_handleRequest` rejects Unix socket connections via `remoteAddress === undefined` — fixed by a server-side `__fromUnixSocket` flag; (2) macOS Seatbelt blocks Unix socket `connect()` by default — the socket is created but agents cannot connect without per-platform sandbox config (change #8); on Linux, filesystem-bound Unix sockets bypass network namespace isolation and work out of the box; (3) 50+ curl calls across 7 skill files must be updated with `$CURL_SOCKET` — a single miss silently falls back to TCP (sandbox-blocked), mitigated by a grep-based completeness check; (4) import name mismatch (`fs` vs `fsSync`) and missing field declarations would cause runtime/compile errors — corrected in the updated code samples. Mitigations: server-side flag for the remoteAddress guard, macOS sandbox config documentation + auto-detection diagnostic, grep verification for curl completeness, corrected imports and field declarations. Residual risk: on macOS, the feature requires a one-time per-agent sandbox config step that the extension cannot perform automatically — if the user skips this step, agents fall back to TCP (blocked) and must use `BypassSandbox: true` (the current workaround). A file-based IPC fallback (recommended follow-up plan) would eliminate this residual risk.

## Resolved Assumptions

- **Sandbox behavior with Unix sockets (resolved by web research, 2026-08-19)** — the core assumption was that agentic coding platform sandboxes blocking TCP `127.0.0.1` would allow Unix domain socket connections. Research confirmed this is **platform-dependent**:
  - **Linux (Bubblewrap, Docker, nsjail, Firejail):** filesystem-bound Unix sockets bypass network namespace isolation (`CLONE_NEWNET`). Path resolution goes through the mount namespace (VFS), not the network stack. Standard seccomp profiles allow `socket(AF_UNIX, ...)` because glibc and core runtimes require it. Unix sockets work out of the box if the socket path is in a bind-mounted directory. **Confirmed: works.**
  - **macOS (Seatbelt / SBPL):** Apple's Seatbelt MAC framework intercepts socket syscalls at the kernel level. Restrictive profiles block Unix socket `connect()` by default — `EPERM` even if the file is readable/writable. Claude Code provides `sandbox.network.allowUnixSockets` and `sandbox.permissions.allowAllUnixSockets` config directives. Cursor uses `~/.cursor/sandbox.json` path config. **Confirmed: blocked by default, unblockable via per-path config.**
  - **gVisor (runsc):** Sentry intercepts all socket syscalls in userspace. Host Unix sockets blocked unless `--host-uds=all` flag is set. **Confirmed: blocked by default.**
  - **Firecracker microVMs (E2B):** separate guest kernels — host filesystem Unix sockets cannot be shared. Only `AF_VSOCK` or network bridge works. **Confirmed: blocked by VM boundary.**
  - **Devin (macOS):** not specifically covered in research. Devin's sandbox blocks TCP "direct IP access." Whether it allows Unix sockets is unconfirmed. The socket path is workspace-local (`.switchboard/api-server.sock`), which some sandbox profiles treat as workspace-local and allow. **Unconfirmed — proceed with the socket approach and test; `BypassSandbox: true` remains the fallback.**

## Recommended Follow-Up

**File-based IPC fallback** — for strict sandboxes where both TCP loopback and Unix sockets are blocked (macOS Seatbelt without config, gVisor without `--host-uds`, cloud microVMs), the research recommends an atomic file-based request/response queue in `.switchboard/ipc/` as a resilient fallback. The host server watches the directory (inotify/kqueue/fs.watch), processes JSON request files, and writes response files. Any sandbox that permits workspace file writes (which all coding agents require) supports this pattern. This is a separate plan — it adds a new transport, new discovery, and new cleanup, and would push complexity beyond this plan's scope. Recommended as a follow-up plan after this one lands.

## Verification Plan

### Automated Tests
- **New:** `src/test/api-server-unix-socket-contract.test.js` — behavioural tests against a temp-directory fixture:
  - server creates the socket file and it is accessible via `curl --unix-socket`;
  - `GET /health` over the socket returns the same response as over TCP (including `socketPath` field);
  - `POST /orchestration/adopt` over the socket works identically to TCP (verifies the `__fromUnixSocket` flag allows requests through the `remoteAddress` guard);
  - `getSocketPath()` returns null when socket creation fails (simulate by using an invalid path);
  - `stop()` unlinks the socket file;
  - stale socket before `listen()` is cleaned up and the new server starts successfully.
- **New:** grep-based completeness check for skill/workflow curl updates:
  ```bash
  grep -rn 'curl.*"\$BASE' .agents/workflows/ .agents/skills/ \
    | grep -v 'CURL_SOCKET' \
    | grep -v 'sb_api_call'
  ```
  Zero output = all curl calls updated. Any output = missed update.
- `npm run test:contract:orchestrator-tick` — exercises adopt/dispatch paths. Establish pre-existing counts before starting.
- `npm run compile-tests` must be clean for `LocalApiServer.ts` and `TaskViewerProvider.ts`.
- `npm run catalog:check`, `npm run parity:check` — unaffected by design; run to confirm.

### Manual
1. Start the Switchboard extension in a workspace with `.switchboard/`. Confirm `.switchboard/api-server.sock` exists and `.switchboard/api-server-socket.txt` contains its path.
2. `curl --unix-socket .switchboard/api-server.sock http://localhost/health` — confirm 200 with `socketPath` in the response.
3. From a sandboxed agent shell (Devin), run the `/switchboard` workflow. Confirm the health check and adopt call succeed without `BypassSandbox: true`.
4. Stop the extension. Confirm the socket file and discovery file are removed.
5. Crash the extension (kill -9). Restart. Confirm the stale socket is cleaned up and a new one created.
6. On Windows (if available), confirm the socket is not created, the discovery file is not written, and agents fall back to TCP.
7. From a skill that uses `sb_api_call.sh` (e.g., `kanban_operations/create-feature.js`), confirm the API call uses the socket when available and falls back to TCP when not.
8. **macOS Seatbelt test:** On macOS, without any sandbox config, confirm that a sandboxed agent shell (Claude Code or Cursor) CANNOT connect to the Unix socket (expected — Seatbelt blocks it by default). Then add the per-platform sandbox config (change #8) and confirm the agent CAN connect. This verifies the macOS config path is documented correctly.
9. **macOS diagnostic log:** On macOS (`process.platform === 'darwin'`), confirm the extension logs a diagnostic message on startup advising the user to configure their agent's sandbox to allow the socket path.

**Recommendation:** Complexity 6 → **Send to Coder.**
