# Terminal Buffer Snapshot API — `GET /terminals/:name/buffer`

## Goal

Add an HTTP endpoint that returns the current scrollback content of a named terminal, enabling external team leads (Antigravity, Cursor, Zed, any agent with curl access) to observe what their worker terminals are doing in real-time. This fills the one genuine gap in the external-headed team mode: the current model is asynchronous (workers report when done, head verifies via git), with no way to see what a worker is doing *right now* — is it mid-coding? Stuck on an error? Waiting for input?

### Problem & background

The external-headed team mode plan (`feature_plan_20260818_external-headed-team-mode.md`) enables a non-terminal agent to lead a team of terminal workers via HTTP + filesystem. The head dispatches subtasks (`POST /kanban/dispatch`), sends prompts (`POST /terminals/verb/ptySendPrompt`), reads reports (`.switchboard/teams/<teamId>/reports/`), and verifies work (git). The `switchboard-orchestration` skill documents the complete HTTP surface.

The one missing capability is **terminal content observation**. The API can tell you a terminal is alive (`ptyListTerminals` → `status: 'active'`, `lastDataAt`), and that a card is still dispatched (`GET /kanban/board` → `dispatchedAt`), but it cannot tell you *what the terminal is outputting*. An external head that sees a worker has been "active" for 10 minutes with no report cannot distinguish "making good progress" from "stuck on a compile error" from "waiting for a password prompt."

Browser automation (Antigravity's browser capabilities) could fill this gap by reading the xterm.js DOM, but that approach is fragile (depends on xterm.js internal APIs and DOM structure) and architecturally inconsistent (mixing API-driven control with DOM-scraping observation). The clean solution is an API endpoint.

### Root cause — the scrollback buffer exists but is only exposed via WebSocket

The `TerminalWsGateway` (`src/standalone/terminalWsGateway.ts:280`) already maintains a server-side scrollback buffer: `scrollbackBuffers = new Map<string, ScrollbackBuffer>()`. Each terminal gets a `ScrollbackBuffer` with `chunks: ScrollbackChunk[]` (each chunk has `seq` and `data`), `totalBytes`, `headSafeStart`, and `nextSeq`. The buffer is capped at `MAX_SCROLLBACK_BYTES = 256KB` and is used for WS client reattach — when a browser reconnects, the gateway replays the missed chunks.

This buffer contains the exact same PTY output stream that xterm.js renders in the browser. It is the authoritative server-side copy of terminal content. But it is only exposed via the WebSocket replay path (`setupClient` at line 953), never via HTTP. An external agent with only HTTP access cannot read it.

The `PtyFleetService` (`src/standalone/ptyFleetService.ts:117`) tracks `lastDataAt` (a heartbeat timestamp) on each `ExtendedTerminalHandle`, exposed via `getLiveness()` and `ptyListTerminals`. This tells you *when* the terminal last produced output, but not *what* it produced.

### Scope note — observation only, not control

This plan adds a **read-only observation endpoint**. It does not modify the terminal control surface (dispatch, send prompt, clear) or the external-headed team mode architecture. It is a complement to the existing HTTP API, filling the observation gap that browser capabilities motivated but doing so through the architecturally consistent path (API, not DOM scraping).

---

## Metadata

- **Complexity:** 5
- **Tags:** backend, api, feature
- **Project:** Browser Switchboard

---

## User Review Required

This plan adds a new read-only HTTP endpoint to `LocalApiServer.ts` and a new public method to `TerminalWsGateway`. It touches both host architectures (standalone in-process and extension host child process). The endpoint exposes terminal content over HTTP — review the auth boundary (same localhost + Bearer token as all other endpoints) and the scrollback size ceiling (256KB raw, potentially large for an HTTP response — the `tailLines` param mitigates this).

---

## Complexity Audit

### Routine
- Adding a public method to `TerminalWsGateway` that reads from the existing `scrollbackBuffers` map — the data is already there, just not exposed.
- Adding a `ptyGetBuffer` case to both hosts' `handlePtyVerb` switch statements — same pattern as `ptyListTerminals`, `ptyClearTerminal`, etc.
- Adding a `GET /terminals/:name/buffer` route to `LocalApiServer`'s request router — same pattern as `GET /terminals/standing-orders`.
- Adding a `ptyGetBuffer` entry to `TASK_VIEWER_VERB_SCHEMAS` in `verbSchemas.ts` — same pattern as `ptySendPrompt`.
- Updating skill documentation (`switchboard-orchestration`, `external-team-lead`) to document the new endpoint.

### Complex / risky
- **ANSI escape sequence stripping.** The scrollback buffer contains raw PTY output with ANSI escape sequences (colors, cursor movement, alternate screen modes). For an external agent consuming the buffer, plain text is more useful. A `?stripAnsi=true` query param will strip these. The stripping must handle CSI sequences (`\x1b[...m`), OSC sequences (`\x1b]0;title\x07`), charset designation (`\x1b(B`), and simple escapes (`\x1bc`, `\x1b=`). No `strip-ansi` dependency exists in the codebase; a lightweight utility function with a comprehensive regex will be added. The regex must be correct — an incomplete pattern leaves escape fragments in the output, which are worse than raw output for an agent consuming the text.
- **Pending output coalescing.** The gateway coalesces PTY output with a ~6ms flush window (`OUTPUT_FLUSH_MS = 6`). Output that has arrived but not yet been flushed to the scrollback buffer sits in `pendingOutput`. For a snapshot, this at-most-6ms-old data should be included. The `getScrollbackSnapshot` method will drain `pendingOutput` into the snapshot (read-only — it will NOT mutate the pending state, just read the `parts` array and concatenate).
- **Two-host architecture.** The standalone host has `terminalWsGateway` in-process (passed to `LocalApiServer` via options). The extension host has the gateway in the pty-host child process — `LocalApiServer` reaches it via `terminalVerb('ptyGetBuffer', ...)` which forwards through `handlePtyVerb` → `_ptyHostVerb` → child's HTTP server. The dedicated `GET /terminals/:name/buffer` route in `LocalApiServer` will call `terminalVerb('ptyGetBuffer', { name, ... })` for host-agnostic access — same pattern as `/terminals/relay`.

---

## Edge-Case & Dependency Audit

| Case | Behaviour |
|---|---|
| Terminal not found | 404 `{ success: false, error: "No such terminal: <name>" }` |
| Terminal exited | Scrollback is deleted on terminal close (`terminalWsGateway.ts:716`: `this.scrollbackBuffers.delete(name)`). Return 404 with `"Terminal <name> has exited — no buffer retained"`. |
| No gateway (ptyReady false) | The verb handler returns `{ success: false, error: "PTY terminals are unavailable..." }`. The route returns 503. |
| Empty buffer (terminal just spawned, no output yet) | 200 `{ success: true, data: { content: "", bytes: 0, lines: 0, ... } }` |
| Pending output not yet flushed | Included in the snapshot — `getScrollbackSnapshot` reads `pendingOutput.get(name).parts` and concatenates with the scrollback chunks. |
| `?stripAnsi=true` | ANSI escape sequences are stripped from the content. `data.stripped` is `true`. |
| `?stripAnsi=false` (default) | Raw PTY output with ANSI sequences preserved. `data.stripped` is `false`. |
| `?tailLines=N` | Only the last N lines are returned (split on `\n`, take last N, join with `\n`). `data.truncated` is `true` if the original had more than N lines. |
| `?tailLines=N&stripAnsi=true` | Strip ANSI first, then apply tailLines. |
| Multi-root workspace | `?workspaceRoot=<root>` query param, same as all other endpoints. |
| Terminal name with special characters | URL-decoded from the path segment. The `:name` route parameter is `decodeURIComponent`'d. |
| Auth | Same as all other endpoints: `Authorization: Bearer <token>` if configured, localhost boundary otherwise. |
| Scrollback eviction | The ring buffer evicts at 256KB. The snapshot returns whatever is currently retained — if the terminal has produced more than 256KB, the snapshot starts from the oldest retained chunk (with `headSafeStart` trimming for escape sequence safety). `data.evicted` is `true` when `buffer.chunks[0].seq > 1` (the first chunk's seq started at 1; a higher value means earlier chunks were evicted). |

**Dependencies:** none outside this repo. Reuses `TerminalWsGateway.scrollbackBuffers` (existing), `PtyFleetService.get()` (existing), `LocalApiServer` routing patterns (existing), `handlePtyVerb` forwarding (existing).

---

## Dependencies

- None — this plan reuses existing internal infrastructure only: `TerminalWsGateway.scrollbackBuffers` (the server-side ring buffer), `PtyFleetService.get()` (fleet handle lookup for `lastDataAt`/`status`), `LocalApiServer` routing patterns, and the `handlePtyVerb` → `terminalVerb` forwarding seam. No external packages, no new modules, no `strip-ansi` dependency.

---

## Proposed Changes

### 1. `src/standalone/terminalWsGateway.ts` — public scrollback snapshot method

**1a. `getScrollbackSnapshot(name, opts)` — new public method.**

```typescript
public interface ScrollbackSnapshot {
    content: string;
    bytes: number;
    lines: number;
    lastDataAt: number;
    status: 'active' | 'exited';
    stripped: boolean;
    truncated: boolean;
    evicted: boolean;
}

public getScrollbackSnapshot(
    name: string,
    opts?: { stripAnsi?: boolean; tailLines?: number }
): ScrollbackSnapshot | null
```

Implementation:
1. Look up `this.scrollbackBuffers.get(name)`. If not found, return `null` (caller distinguishes "no terminal" from "no buffer").
2. Concatenate all `chunk.data` from `buffer.chunks`, applying `buffer.headSafeStart` as a start offset on the first chunk (same trimming as the replay path at line 1013).
3. Read `this.pendingOutput.get(name)` — if it exists, concatenate `pendingOutput.parts.join('')` to the end of the content. This captures output that has arrived but not yet been flushed (at most ~6ms old).
4. If `opts.stripAnsi`, apply the ANSI stripping function (see 1b).
5. If `opts.tailLines` is a positive number, split on `\n`, take the last N lines, join with `\n`. Set `truncated = originalLineCount > N`.
6. Count bytes (`Buffer.byteLength(content, 'utf8')`) and lines (`content.split('\n').length`).
7. Look up the fleet handle via `this.fleetService.get(name)` for `lastDataAt` and `status`. If the handle doesn't exist, use `Date.now()` and `'exited'` respectively.
8. Set `evicted = buffer.chunks.length > 0 && buffer.chunks[0].seq > 1`.

   > **Superseded:** `evicted = buffer.totalBytes >= MAX_SCROLLBACK_BYTES`
   > **Reason:** The eviction loop (line 584: `while (buffer.totalBytes > MAX_SCROLLBACK_BYTES && buffer.chunks.length > 1)`) reduces `totalBytes` BELOW the cap after eviction, so `>= MAX` is `false` right after eviction occurred — the flag is backwards. It is only `true` in the edge case of a single chunk exceeding 256KB (where the loop stops at `chunks.length === 1`), which is a false positive, not an eviction signal.
   > **Replaced with:** `buffer.chunks.length > 0 && buffer.chunks[0].seq > 1` — the first chunk's sequence number starts at 1 (from `nextSeq` initialization at line 510), so if it's greater than 1, earlier chunks were evicted. This is the reliable eviction indicator.

9. Return the snapshot object.

**1b. ANSI stripping utility — `stripAnsiEscapes(str: string): string`.**

A module-level function in `terminalWsGateway.ts` (or a shared utility if the codebase has a preferred location). Uses a comprehensive regex that handles:
- CSI sequences: `\x1b[<params><intermediate>*<final>` (parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F, final byte 0x40-0x7E)
- OSC sequences: `\x1b]<string>\x07` or `\x1b]<string>\x1b\\`
- Charset designation: `\x1b(<char>` or `\x1b)<char>`
- Simple escapes: `\x1b<single byte>` (ESC c, ESC 7, ESC =, etc.)

```typescript
// Matches the ANSI escape sequence families produced by real PTY streams.
// CSI:      ESC [ <0x30-0x3F>* <0x20-0x2F>* <0x40-0x7E>
// OSC:      ESC ] <string> ST  (BEL or ESC \)
// Charset:  ESC ( or ) + designation char
// Simple:   ESC + single byte from the common set
const ANSI_ESCAPE_PATTERN =
    /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78McDEZ*]/g;
```

> **Superseded:** The original regex was written as a multi-line literal with inline `// CSI` comments inside the pattern.
> **Reason:** JavaScript regex literals do not support inline comments or the `/x` (extended) flag. The `//` inside `/.../g` terminates the regex literal at the first `/`, producing a syntax error. The pattern would not compile.
> **Replaced with:** A single-line regex literal with no inline comments. The comment above the literal documents the families.

> **Superseded:** The CSI parameter class was `[0-9;?]*`.
> **Reason:** This misses `:` (0x3A), `<` (0x3C), `=` (0x3D), `>` (0x3E) — all valid CSI parameter bytes in the range 0x30-0x3F. Sequences like `\x1b[3:1m` (colon sub-parameters, used in modern terminal features) would not be stripped, leaving the entire escape sequence in the output — exactly the failure mode Risk 1 warns about.
> **Replaced with:** `[0-?]*` — the range `0` (0x30) through `?` (0x3F) covers the full CSI parameter byte range per ECMA-48.

**Known limitation — simple escape list is not exhaustive.** The character class `[=>78McDEZ*]` covers the most common two-byte escapes but misses `ESC H` (tab set, 0x48) and `ESC #` (DEC line size, 0x23). These are rare in modern PTY output. If they appear in a specific worker's stream, they will pass through unstripped. A catch-all `\x1b[\x20-\x2f]*[\x40-\x7e]` could replace the simple-escape alternative, but it risks over-matching in edge cases; the explicit list is safer for the common case.

**Design note — no `strip-ansi` dependency.** The codebase does not use `strip-ansi` or `ansi-regex`. Adding a dependency for a single regex is unnecessary. The pattern above covers the same sequence families as `strip-ansi` v7 (CSI + OSC + simple escapes) plus charset designation, which `strip-ansi` does not handle but real PTY streams produce.

### 2. `src/standalone/ptyHost.ts` — `ptyGetBuffer` verb case

Add a `case 'ptyGetBuffer':` to the `handlePtyVerb` switch statement (after `ptySendPrompt`, before `default:`):

```typescript
case 'ptyGetBuffer': {
    const handle = fleet.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    const snapshot = gateway.getScrollbackSnapshot(payload.name, {
        stripAnsi: payload.stripAnsi === true,
        tailLines: typeof payload.tailLines === 'number' && payload.tailLines > 0
            ? Math.floor(payload.tailLines) : undefined,
    });
    if (!snapshot) {
        return { success: false, error: `Terminal ${payload.name} has exited — no buffer retained` };
    }
    return { success: true, data: { name: payload.name, ...snapshot } };
}
```

The `gateway` variable is in scope (line 45: `const gateway = new TerminalWsGateway(fleet, ...)`).

### 3. `src/standalone/bootstrap.ts` — `ptyGetBuffer` verb case

Add a `case 'ptyGetBuffer':` to the standalone host's `handlePtyVerb` switch statement. The `terminalWsGateway` variable is in the same function scope (line 2333), accessible from the closure:

```typescript
case 'ptyGetBuffer': {
    const handle = ptyFleetService.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (!terminalWsGateway) {
        return { success: false, error: 'Terminal buffer snapshot unavailable — WS gateway not initialized' };
    }
    const snapshot = terminalWsGateway.getScrollbackSnapshot(payload.name, {
        stripAnsi: payload.stripAnsi === true,
        tailLines: typeof payload.tailLines === 'number' && payload.tailLines > 0
            ? Math.floor(payload.tailLines) : undefined,
    });
    if (!snapshot) {
        return { success: false, error: `Terminal ${payload.name} has exited — no buffer retained` };
    }
    return { success: true, data: { name: payload.name, ...snapshot } };
}
```

**Note on closure scope:** `handlePtyVerb` is defined at line 1340, and `terminalWsGateway` is declared at line 2284 (the `terminalVerb` closure that *calls* `handlePtyVerb` is at line 2333). Since `handlePtyVerb` is only *called* after the full function body has executed (the server starts after all variables are initialized), the closure safely accesses `terminalWsGateway` at call time. This is the same pattern the standalone host uses for `ptyFleetService` (declared at line 2070, also after `handlePtyVerb` in the source but accessed in the same closure).

### 4. `src/services/LocalApiServer.ts` — `GET /terminals/:name/buffer` route

**4a. Route registration.** Add to the request router (in the `else if` chain around line 4387):

```typescript
} else if (pathname.startsWith('/terminals/') && pathname.endsWith('/buffer') && req.method === 'GET') {
    // Extract terminal name: /terminals/<name>/buffer → <name>
    const name = decodeURIComponent(pathname.slice('/terminals/'.length, -'/buffer'.length));
    await this._handleTerminalBufferGet(req, res, name);
```

**4b. Handler method.** `_handleTerminalBufferGet`:

```typescript
private async _handleTerminalBufferGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    name: string
): Promise<void> {
    if (!await this._checkAuth(req, true)) {
        this._sendUnauthorized(res);
        return;
    }
    const terminalVerb = this._options.terminalVerb;
    if (!terminalVerb) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Terminal verb dispatch not available' }));
        return;
    }
    try {
        // Parse query params
        const url = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
        const stripAnsi = url.searchParams.get('stripAnsi') === 'true';
        const tailLinesRaw = url.searchParams.get('tailLines');
        const tailLines = tailLinesRaw ? parseInt(tailLinesRaw, 10) : undefined;
        const workspaceRoot = url.searchParams.get('workspaceRoot') || undefined;

        if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Terminal name is required' }));
            return;
        }

        const result = await terminalVerb('ptyGetBuffer', {
            name,
            stripAnsi,
            tailLines: typeof tailLines === 'number' && !isNaN(tailLines) && tailLines > 0
                ? tailLines : undefined,
            workspaceRoot,
        }, workspaceRoot);

        if (!result || result.success === false) {
            const status = result?.error?.includes('No such terminal') || result?.error?.includes('exited') ? 404 : 502;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: false, error: 'ptyGetBuffer failed' }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (err) {
        console.error('[LocalApiServer] /terminals/:name/buffer error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'buffer read failed' }));
    }
}
```

**4c. Route ordering concern.** The route pattern `/terminals/<name>/buffer` must not conflict with existing `/terminals/` routes. The existing routes are:
- `/terminals/standing-orders` (GET, POST)
- `/terminals/relay` (POST)
- `/terminals/verb/<verb>` (POST)

The new route is `GET /terminals/<name>/buffer`. Since the existing routes are either exact matches (`standing-orders`, `relay`) or prefix matches (`verb/`), and the new route requires both a `<name>` segment AND a `/buffer` suffix, there is no conflict. The `endsWith('/buffer')` check ensures it only matches the buffer route, not `/terminals/standing-orders` or `/terminals/relay`.

### 5. `src/services/verbSchemas.ts` — `ptyGetBuffer` schema (optional, for rail consistency)

Add to `TASK_VIEWER_VERB_SCHEMAS`:

```typescript
ptyGetBuffer: {
    fields: {
        name: { type: 'string', required: true },
        stripAnsi: { type: 'boolean' },
        tailLines: { type: 'number' },
        workspaceRoot: { type: 'string' },
    },
},
```

This is not strictly required (the dedicated route bypasses the verb rail, and `validateVerbPayload` returns `{ ok: true }` for unregistered verbs), but it documents the accepted fields and enables validation if the verb is ever called through the generic `/terminals/verb/ptyGetBuffer` rail.

### 6. Skill documentation updates

**6a. `switchboard-orchestration` skill** (`.agents/skills/switchboard-orchestration/SKILL.md` and `.claude/skills/switchboard-orchestration/SKILL.md`):

Add to the read endpoints table in Section 2:

| Endpoint | Returns |
|---|---|
| `GET /terminals/<name>/buffer?stripAnsi=true&tailLines=N` | `{ success: true, data: { name, content, bytes, lines, lastDataAt, status, stripped, truncated, evicted } }` — the terminal's current scrollback content (up to 256KB). `stripAnsi=true` strips ANSI escape sequences for plain-text consumption. `tailLines=N` returns only the last N lines. |

Add a usage example:

```bash
# Read the last 50 lines of a worker's terminal output (plain text)
curl -s "$BASE/terminals/coder-1/buffer?stripAnsi=true&tailLines=50" | jq -r '.data.content'
```

**6b. `external-team-lead` skill** (`.agents/skills/external-team-lead/SKILL.md` and `.claude/skills/external-team-lead/SKILL.md`):

Add a new step in the tick loop (between Step 2: Read Reports and Step 3: Verify Work):

### Step 2b: Observe Stuck Workers (Optional)

If a worker has been active for a long time with no report, check what it's doing:

```bash
curl -s "$BASE/terminals/<workerName>/buffer?stripAnsi=true&tailLines=80" | jq -r '.data.content'
```

This returns the last 80 lines of plain-text terminal output. Use it to distinguish "making progress" from "stuck on an error" from "waiting for input." Do NOT act on the content reflexively — if the worker is mid-task, let it finish. Only intervene if it's genuinely stuck (repeated errors, waiting for a prompt, idle with no activity).

---

## Verification Plan

### Automated Tests

**Unit test — `getScrollbackSnapshot`:**
1. Create a `TerminalWsGateway` with a mock `PtyFleetService`.
2. Manually populate `scrollbackBuffers` with test chunks (raw PTY output with ANSI sequences).
3. Call `getScrollbackSnapshot('test-term')` — verify content matches the concatenated chunks.
4. Call `getScrollbackSnapshot('test-term', { stripAnsi: true })` — verify ANSI sequences are removed.
5. Call `getScrollbackSnapshot('test-term', { tailLines: 5 })` — verify only the last 5 lines are returned.
6. Call `getScrollbackSnapshot('nonexistent')` — verify returns `null`.

**Integration test — `GET /terminals/:name/buffer`:**
1. Start `LocalApiServer` with a mock `terminalVerb` that returns a canned snapshot.
2. `GET /terminals/coder-1/buffer` — verify 200 with correct JSON structure.
3. `GET /terminals/coder-1/buffer?stripAnsi=true&tailLines=10` — verify params are forwarded.
4. `GET /terminals/nonexistent/buffer` — verify 404.
5. `GET /terminals/` — verify 400 (missing name).

**ANSI stripping test:**
1. Feed a string with CSI, OSC, charset, and simple escape sequences.
2. Verify all are stripped and no partial escape fragments remain.
3. Feed a string with no escape sequences — verify it passes through unchanged.

### Manual Checks
1. **Start a terminal, send output, read buffer:**
   - Create a terminal via `POST /terminals/verb/ptyCreateTerminal`.
   - Send a command that produces output (e.g., `echo "hello world"`).
   - `GET /terminals/<name>/buffer` — verify the output appears in `content`.
   - `GET /terminals/<name>/buffer?stripAnsi=true` — verify ANSI sequences are removed.
2. **Tail lines:**
   - Send a command that produces many lines (e.g., `seq 1 100`).
   - `GET /terminals/<name>/buffer?tailLines=5` — verify only the last 5 lines are returned.
3. **Exited terminal:**
   - Close a terminal via `POST /terminals/verb/ptyCloseTerminal`.
   - `GET /terminals/<name>/buffer` — verify 404 with "exited" message.
4. **External team lead scenario:**
   - Create an external-headed team (`POST /teams/create-external`).
   - Dispatch a subtask to a worker.
   - While the worker is coding, `GET /terminals/<workerName>/buffer?stripAnsi=true&tailLines=50` — verify you can see the worker's current output.

---

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the ANSI stripping regex must cover all escape families with correct byte ranges — the original pattern had a syntax error (inline comments in a JS regex literal) and an incomplete CSI parameter class (`[0-9;?]*` missing `:<>`), both fixed via superseded callouts; (2) the `evicted` flag was unreliable (`totalBytes >= MAX` is false after eviction), replaced with `chunks[0].seq > 1`; (3) large 256KB responses are mitigated by `tailLines`. The pending-output read is atomic under Node's single-threaded model (no race), route ordering is conflict-free, and the closure-scope timing in `bootstrap.ts` follows the established `ptyFleetService` pattern. Mitigations: comprehensive ANSI unit test, `tailLines` param for polling, `stripAnsi=false` default as fallback for regex edge cases.

---

**Recommendation:** Complexity 5 (mixed — routine two-host wiring with one moderate-risk regex). Send to Coder.
