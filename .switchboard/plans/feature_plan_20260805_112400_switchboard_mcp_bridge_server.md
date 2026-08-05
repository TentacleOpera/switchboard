# Switchboard Model Context Protocol (MCP) Bridge Server

> ## ⏸️ PARKED — do not dispatch (2026-08-05)
>
> **Not cancelled. Blocked on a cost/benefit that currently does not clear.** Everything below is verified against the codebase and stays valid if the situation changes; nothing here needs re-deriving.
>
> **Why parked — what the research established:**
> 1. **Gemini Spark rejects `http://` and cannot reach loopback.** Its MCP fetch originates from Google's cloud, which cannot route to `127.0.0.1` on the user's machine. Local TLS does not help: a locally-trusted certificate on a loopback address is unreachable regardless of how valid it is.
> 2. **The only route is a public HTTPS tunnel** (ngrok / Cloudflare). That exposes a port publicly — and a tunnel forwards **every path on that port**, not just `/mcp`, so pointing one at `LocalApiServer` would publish `/kanban/*`, `/terminals/verb/*`, the board UI and the WS gateway. On the extension host, where `_checkAuth` short-circuits to loopback trust (`LocalApiServer.ts:528-529`), that is an unauthenticated control plane that can dispatch agents and write into live shells.
> 3. **Spark's *Connected Apps* dialog takes only a URL, an OAuth client id and an OAuth client secret** — no header field — so auth would likely mean standing up an OAuth 2.1 authorization server. The SDK's helpers are express-only (`server/auth/router.d.ts:1, 64, 88`), so on this raw `http.createServer` it is hand-rolled `/authorize` + `/token` + `/register` + two discovery documents.
> 4. **Spark is slow by design** (built for long-running tool calls), which makes synchronous tool calling a poor fit even if all of the above were solved.
>
> **What replaced it.** The actual goal — running long authoring and review work on Google's AI quota instead of Anthropic's — is served by an asynchronous prompt hand-off with a file-based return, needing no new transport at all. See the sibling plans: *Connections Panel*, *External-Agent Skill Launchers*, *Memo Write-Back Watcher*.
>
> **What is still worth keeping here.** The twelve-tool mapping in change 3 is ground-truth-verified against `LocalApiServer` on path *and* method, the in-process call paths are correct, and the transport mount in change 1 is accurate for the installed SDK 1.25.3. If a synchronous MCP surface is ever wanted — for a client that can reach localhost, or once a hardened dedicated listener exists — start from this plan rather than a blank file.
>
> **If unparked, it is three plans, not one:** (A) `/mcp` transport + tools on a dedicated MCP-only listener with mandatory auth; (B) tunnel integration and docs; (C) OAuth authorization server. Complexity 8-9 overall. Do **not** implement the plan below as a single unit.

## Goal
Build a local TypeScript-based Model Context Protocol (MCP) server that connects Gemini Spark (and other MCP-compatible AI models) directly to Switchboard's `LocalApiServer` over stdio IPC. This provides native, structured tool calling for board operations, plan dispatches, card movements, and terminal messaging, bypassing shell command policies and socket connection restrictions.

> **Superseded:** the transport clause of the Goal — *"over stdio IPC"*, and by extension the separate-package/subprocess shape it implies.
> **Reason:** Web research (August 2026) establishes that **Gemini Spark in the Gemini macOS app does not spawn local stdio MCP subprocesses.** Spark's only custom-tool channel is **Streamable HTTP/HTTPS (remote MCP)**, configured in-app under *Settings → Connected Apps*; local disk access is a separate, unrelated mechanism (*Settings → Connected Folders*, native macOS permissions). A stdio server would compile, pass a handshake test, and be **permanently unreachable by the named target host**. Sources: Google Blog *"Gemini Spark updates: macOS launch, connected apps and local folders"* (2026-06-30); Google Help Center *"Use Gemini Spark with the Gemini app on Mac"* (2026-07).
> **Replaced with:** **Streamable HTTP transport, mounted as a `/mcp` route on the existing `LocalApiServer`.** Everything else in the Goal — native structured tool calling for board operations, plan dispatches, card movements and terminal messaging, bypassing shell-command policy — is preserved unchanged and is better served by this shape. The stated *goal* was never stdio; stdio was an assumption about how to reach the host, and the research refutes it.

### Problem & background

**The core problem.** Every host that drives Switchboard today does so with a shell: Claude Code, Cursor, Codex CLI, Gemini CLI and Antigravity all read `.switchboard/api-server-port.txt` and `curl http://127.0.0.1:<port>/…` directly (`.agents/skills/switchboard-orchestration/SKILL.md:23-30`). Research confirms Gemini CLI and Antigravity have native terminal execution and are **not** limited to MCP — they need nothing new. Gemini Spark is different: it has approved-folder file access but **no arbitrary host terminal execution and no uninhibited localhost HTTP fetch**. Its only extension channel is a Streamable HTTP MCP endpoint. That is the gap, and it is a *transport* gap, not a capability gap — every board operation this plan exposes already exists and is already live in `src/services/LocalApiServer.ts`.

**Why the endpoint belongs on `LocalApiServer` rather than in a separate package.** Once the transport is HTTP rather than stdio, a second process buys nothing and costs plenty: it would need its own port, its own lifecycle, its own supervision, and it would reach the board by HTTP-calling a server that is already running — a loopback hop the codebase explicitly warns against (`LocalApiServer.ts:1141-1144`: *"callable in-process (the oversight-pass service uses it directly; never HTTP-call the server from within itself)"*). Mounting `/mcp` on the server that already owns the board means the tool handlers call the **same in-process code paths** the HTTP routes call — `performKanbanDispatch()`, `_options.moveCard`, `_resolveBoard()`, the verb routers — with zero extra hops, zero extra processes, and no npm package, no bin, no host config file, and therefore **no package-name to collide with anything.**

**Reachability is established.** Spark reaches the local filesystem and local ports on the user's machine — the Gemini macOS app dials out from the Mac, so `http://127.0.0.1:<port>/mcp` is a valid endpoint for it. This is the premise the plan was written on; treat it as given, not as something to re-test.

**The primary host is the standalone host, not the VS Code extension.** This plan sits under the Browser Switchboard project, whose product goal is making Switchboard usable **without VS Code**. Spark connects to `npx switchboard` (`src/standalone/bootstrap.ts`), not to the extension. Both hosts construct the same `LocalApiServer` with the same verb routers (PRD: *two hosts, one engine*), so mounting `/mcp` on the shared server gives the extension host the endpoint for free — but the standalone host is where the feature is used, and it is the host every design decision below is resolved against. Two consequences that flow directly from this and would have been wrong under an extension-first reading:

* **Port stability is already solved — no code needed.** `npx switchboard --port <n>` is an existing flag (`src/standalone/cli.ts:23, 65`) that flows through to the server (`cli.ts:217` → `bootstrap.ts:1483` → `options.port`, honoured at `LocalApiServer.ts:361`). The user launches on a fixed port, configures the URL in Spark once, and it stays valid across restarts. (The extension host, by contrast, never passes `port` and is stuck on `listen(0)` — irrelevant here.)
* **Auth is on the critical path, not a footnote.** The standalone host **always** mints a random in-memory `sessionToken` (`bootstrap.ts:311, 1489`), so `_checkAuth` requires a bearer header or an `sb_session` cookie and returns **401** to everything else (`LocalApiServer.ts:527-557`). Spark must therefore be able to send an `Authorization` header — see Complex / Risky.

---

## Metadata
**Complexity:** 7
**Tags:** api, backend, infrastructure, feature

> **Superseded:** `**Complexity:** 4` — *"Self-contained TypeScript project using `@modelcontextprotocol/sdk` with `stdio` transport."*
> **Reason:** The scope changed under the research and the remaining work is not self-contained. It adds a **new protocol surface to a shipped server with ~4,000 installs** (PRD contract #2: byte-compatibility, refactors in-place, new capabilities default-OFF); it must lazy-load an SDK that is currently in `package.json` but imported nowhere in `src/`, so bundling it naively grows `dist/extension.js` (today 6.75 MB) for every install including the ones that never use MCP; and it must map tool handlers onto in-process code paths rather than loopback HTTP.
> **Replaced with:** `**Complexity:** 7` → Send to Lead Coder.

> **Superseded:** `**Tags:** mcp, switchboard, typescript, api-bridge, tool-calling`
> **Reason:** None of the five are in the allowed tag vocabulary, so the importer's tag facet receives values it cannot filter on.
> **Replaced with:** `api, backend, infrastructure, feature`.

*(No `**Repo:**` line — this workspace is single-repo. No `**Project:**` line — no project-pin directive was supplied, and pins resolve at import only, so editing one on an already-imported plan is a no-op by design.)*

---

## User Review Required

**None.** The two decisions that could have been deferred are made here:

* **Server identity name: `board-bridge`.** The MCP `serverInfo.name` advertised on `initialize`, and the label the user types into Spark's *Connected Apps*. Deliberately **not** `switchboard-mcp` or `@switchboard/mcp` — those names belong to an unrelated project and would collide. Because this design ships no npm package, no `bin`, and no host config-file entry, the name exists in exactly one string literal and is a one-line change if a different label is preferred.
* **No npm publish, no separate package, no `.mcpb` bundle.** Research confirms **no Gemini-family host consumes `.mcpb`** (it is an Anthropic format for Claude Desktop). There is nothing to publish and nothing to install.

---

## Complexity Audit
* **Score:** 7 / 10

### Routine
* Adding one route branch to the existing `LocalApiServer` request chain (`src/services/LocalApiServer.ts:3395-3547`), which already handles GET/POST/PUT/DELETE and already sets CORS headers.
* Registering tools with Zod schemas via `registerTool` — the installed SDK **1.25.3** accepts either a raw Zod shape or a full `z.object(...)` for `inputSchema` (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:149-158`), so no idiom gamble.
* Wiring tool handlers to in-process methods that already exist and are already exercised by the HTTP routes.

### Complex / Risky
* **Auth on the standalone host is the highest-risk item, because standalone is the target host and the token is currently unobtainable by a non-browser client.** `bootstrap.ts:311, 1489` always mints a random in-memory `sessionToken`, so `/mcp` returns **401** to anything without `Authorization: Bearer <token>` or the `sb_session` cookie (`LocalApiServer.ts:527-557`). Both existing acquisition paths are browser-shaped — a cookie, or a single-use `?token=` that 303-redirects with `Set-Cookie` — and the CLI prints only the *one-time* token, never the session token (`cli.ts:224-233`). So today there is no value a user could paste into Spark even if Spark accepts headers. Change 2 exposes one; whether Spark can *send* it is the one open question (Uncertain Assumptions item 1).
* **Standalone callback coverage.** Standalone constructs `LocalApiServer` with its own options bundle (`bootstrap.ts:1481-1575`). Any tool whose backing callback is absent there must be **absent from `tools/list`, never a dead tool that fakes success** (PRD contract #6). This is a real gate on the target host, not a parity nicety.
* **Bundle weight in both bundles.** `@modelcontextprotocol/sdk` is declared in `package.json:884` but imported **nowhere** in `src/` — it is currently in neither bundle. Its transitive dependencies include `express`, `cors`, `ajv`, `jose`, `eventsource` and `@hono/node-server`. Because `LocalApiServer` is compiled into *both* `dist/extension.js` (~4,000 installs, most of which will never call an MCP tool) and `dist/standalone/cli.js`, a static top-level import inflates both. Must be a **lazy dynamic import on first `/mcp` request**.
* **New network-reachable protocol surface on a server that currently exposes only a hand-audited route list.** Tools are a *capability grant*: `card_dispatch` starts agents, `plan_delete` removes files, `terminal_send` types into a live shell.

---

## Edge-Case & Dependency Audit

### Race Conditions
* **Port stability — solved by an existing flag, no code.** Spark stores a literal URL, so an OS-assigned port would invalidate the configuration on every restart. The standalone host already accepts `npx switchboard --port <n>` (`src/standalone/cli.ts:23, 65` → `:217` → `bootstrap.ts:1483` → `LocalApiServer.ts:361`), so the user launches on a fixed port and configures Spark once. Document the flag; write no new port-management code. (`--port 0` remains the ephemeral default, and the extension host is unaffected — it never passes `port` — but neither matters for this feature.)
* **Single-writer collision.** `cli.ts:206-210` already refuses to start a second instance for the same workspace when one is live, so a fixed port cannot be double-bound by two Switchboard processes on one workspace. Two *different* workspaces launched on the same explicit `--port` will collide, and `start()` rejects on `EADDRINUSE` (`LocalApiServer.ts:433-436`) with no fallback — the launch fails loudly, which is the correct behaviour. Use a distinct port per workspace.
* **Transport lifecycle.** Build the `McpServer` + transport **once**, lazily, on first `/mcp` hit, and reuse it. Constructing a transport per request breaks streaming and leaks. Tear it down in `LocalApiServer.stop()`.
* **Stateless session mode** (`sessionIdGenerator: undefined`) avoids the stateful mode's 400/404 session-validation failure branches (`streamableHttp.d.ts:148-158`) and matches the stateless posture of the rest of the surface.

### Security
* Server stays bound to `127.0.0.1` — unchanged. **No tunnel, no public exposure, no HTTPS listener** is added by this plan.
* Enable the transport's own rebinding guard: `enableDnsRebindingProtection: true` with `allowedHosts: ['127.0.0.1:<port>', 'localhost:<port>']` (`webStandardStreamableHttp.d.ts:84-96`). This complements the server's existing `_isAllowedHost` guard (`LocalApiServer.ts:3344-3367`), which is only enforced when `serveStatic` is set.
* **Auth on the target host is mandatory, not optional.** The standalone host always mints a random in-memory `sessionToken` (`bootstrap.ts:311, 1489`) that is never written to disk, so an unauthenticated client gets **401** on every guarded route. `/mcp` goes through `_checkAuth` like every other endpoint — do not carve an exception. **There is currently no supported way for a non-browser client to obtain that token** — see change 2, which closes the gap. The two existing paths are both browser-shaped: the `sb_session` cookie, and the single-use `?token=` exchange that consumes a one-time token and 303-redirects with `Set-Cookie` (`LocalApiServer.ts:598-615, 651-667, 703-721`; minted at `bootstrap.ts:310`, consumed once at `:1560-1562`). The CLI prints only that **one-time** token (`cli.ts:224-233`); the session token is never printed and never written to disk. *(The extension host leaves `getAuthToken()` empty — the unset `switchboard.apiToken` secret at `TaskViewerProvider.ts:2016-2019` — so `_checkAuth` short-circuits to loopback trust there. That is a convenience on a secondary host, not the design point.)*
* CORS: the server currently allows `Content-Type, Authorization` (`LocalApiServer.ts:3380`). Streamable HTTP additionally uses `Mcp-Session-Id`, `mcp-protocol-version` and `Last-Event-ID`; add them to `Access-Control-Allow-Headers` and expose `Mcp-Session-Id` via `Access-Control-Expose-Headers`. Harmless for a native client, required for a browser-origin one.
* Tool surface is a capability grant — keep it to the twelve in change 3 plus nothing. No generic `{method, path}` passthrough in v1: a passthrough on a network-reachable endpoint converts a curated tool list into the entire private API. Plan authoring and plan-content reads were cut deliberately; do not reintroduce them as a convenience.

### Side Effects
* **`apiOriginated` stamping.** `_handleTaskViewerVerb` calls `_stampHttpSurface(body)` (`LocalApiServer.ts:1912`), flagging the call as HTTP-originated so terminal sends prefer the PTY fleet over invisible VS Code terminals. Tool handlers that reach a verb router must preserve this; handlers that call in-process methods directly must set it explicitly.
* **Board mutations are real** — cards move, files are written, agents start. No confirm dialogs (project rule); the discipline lives in tool descriptions.
* **Bundle size** is a side effect on all installs, not just MCP users — hence the lazy import.

### Dependencies & Conflicts
* **`@modelcontextprotocol/sdk` `^1.0.3` (installed 1.25.3) and `zod` `^3.23.8` are already root dependencies** (`package.json:884, 902`). No new dependency is added.
* **Do not move to SDK v2.0.** Research reports v2.0 (2026-07-28) **removed** `McpServer.prototype.tool()` and switched `inputSchema` to expect a wrapped `z.object(...)`. The installed 1.25.3 already provides the non-deprecated `registerTool` and accepts **both** schema idioms, so v1.x is the lower-risk pin. Keep `^1.0.3`; a caret range cannot cross the major, so there is no accidental v2 upgrade.
* `StreamableHTTPServerTransport` exists in the installed SDK and takes raw Node `IncomingMessage`/`ServerResponse` via `handleRequest(req, res, parsedBody?)` (`streamableHttp.d.ts:107-109`) — exactly the objects `LocalApiServer` already holds. This is what makes the mount a route branch rather than a rewrite.
* **Switchboard not running:** with no host up there is no port and no endpoint; Spark reports a connection failure directly. The stdio-era "read the port file and return a structured not-running error" concern does not apply to this shape.
* **Multi-root workspaces:** `LocalApiServer` handles multi-root by accepting a `workspaceRoot` parameter in the query string (GET) or request body (POST) — verified at `_resolveDbFromQuery` (read endpoints) and `String(body?.workspaceRoot || this._options.workspaceRoot)` (every write handler). All MCP tools must accept an optional `workspaceRoot`, defaulting to the server's configured root.
* **HTTP error handling:** map every non-2xx / `{success:false}` outcome to an MCP `isError` tool result — including **502**, which `/kanban/move`, `/worktree/cleanup` and the feature handlers emit on upstream failure. A tool must never hand the model an error body dressed as a successful result.
* **Webpack.** Extension entry is `./src/extension.ts` only (`webpack.config.js:17`); standalone entries are `cli` + `ptyHost` (`:131-134`). A dynamic `import()` inside `LocalApiServer` produces a split chunk — verify the chunk actually loads from `dist/` at runtime in both bundles, since the VSIX ships no `node_modules`.

---

## Dependencies
* None. Every board operation these tools expose is already shipped and live in `src/services/LocalApiServer.ts`.

---

## Adversarial Synthesis

Key risks: (1) **auth on the target host** — standalone always requires a token, and today no non-browser client can obtain one, so `/mcp` ships 401-only unless change 2 lands with it; (2) **bundle contamination** — the MCP SDK is imported nowhere in `src/` today, so a careless static import drags `express`/`cors`/`ajv`/`jose` into both `dist/extension.js` (~4,000 installs, most never calling a tool) and `dist/standalone/cli.js`; (3) **capability dishonesty** — a tool whose backing callback is missing in the standalone host, or that renders a 502 as a successful result, is exactly the dead-button failure PRD contract #6 forbids, and standalone is the host that matters; (4) **stream consumption** — pre-parsing the request body before `handleRequest` drains the stream, and every other handler in the file pre-parses, so the wrong habit is the local convention. Mitigations: change 2 surfaces the session token at launch (with a repeatable `?token=` fallback if Spark cannot send headers) and never weakens `_checkAuth`; the SDK loads via lazy dynamic `import()` with measured before/after sizes on both bundles; tools register only when their backing callback exists in that host and every non-2xx maps to an MCP `isError`; pass raw `req` to `handleRequest` and assert it in review.

---

## Proposed Changes

> **Superseded:** Create `mcp/package.json`, `mcp/tsconfig.json` and `mcp/index.ts` — a standalone npm package exposing 8 tools over `StdioServerTransport`, launched with `npx tsx mcp/index.ts`.
> **Reason:** Four independent defects, three of them fatal. **(a) Transport:** Gemini Spark does not spawn stdio subprocesses; the deliverable would be permanently unreachable by its own target host. **(b) Location:** `.vscodeignore:5` ignores `node_modules/**` at the top level only, and separately ignores `src/**`; a top-level `mcp/` directory matches neither, so its sources *and* its nested `node_modules` would ship inside the VSIX for ~4,000 installs against a 25–50 MB Marketplace cap. **(c) Wrong verb rail:** tool 6 posts `sendToTerminal` to `/kanban/verb/`, but `sendToTerminal` is a **TaskViewer** verb — present in `TASKVIEWER_VERBS` (`src/generated/verbAllowlist.ts:15`), absent from `KANBAN_VERBS`, so `KanbanProvider.ts:7199` rejects it at the allowlist gate — and its schema requires `{name, input}` (`src/services/verbSchemas.ts:1168-1175`) while the arm destructures `const { name, input, paced } = data` (`TaskViewerProvider.ts:12831`), so `{terminalName, text}` is dropped and the arm returns `{success:false, error:'invalid terminal name'}`. Two independent failures on one call. **(d) Error handling:** the draft's `apiRequest()` calls `res.json()` and returns it without ever inspecting `res.ok`, so 400/404/409/502/503 bodies are returned to the model as **successful** tool results — directly contradicting the draft's own Edge-Case audit line promising graceful 400/404/409/503 handling.
> **Replaced with:** a `/mcp` Streamable-HTTP route mounted on the existing `LocalApiServer`, with tool handlers calling in-process code paths. No new package, no new process, no npm name, no host config file.

**Build order:** (1) mount the transport → (2) make the session token obtainable → (3) the tools → (4) standalone host verification → (5) docs. Change 2 gates end-to-end use on the target host and should not be left until last.

### 1. `src/services/LocalApiServer.ts` — mount the Streamable HTTP transport

**Context:** the route chain at `:3395-3547` already dispatches on `pathname` + method, already permits GET/POST/PUT/DELETE (`:3388`), and already sets CORS headers (`:3376-3386`). Streamable HTTP needs POST (requests), GET (SSE stream) and DELETE (session teardown) on one path.

**Implementation:**
* Add a private lazily-initialised holder and a getter:

```ts
private _mcp?: { server: any; transport: any };

/** Lazy — keeps the MCP SDK (and its express/cors/ajv/jose graph) out of the
 *  startup path and out of every install that never calls an MCP tool. */
private async _getMcp(): Promise<{ server: any; transport: any }> {
    if (this._mcp) return this._mcp;
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const server = new McpServer({ name: 'board-bridge', version: '0.1.0' });
    registerBoardTools(server, this);           // change 2
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,           // stateless — no session 400/404 branches
        enableJsonResponse: true,                // plain JSON when the client doesn't want SSE
        enableDnsRebindingProtection: true,
        allowedHosts: [`127.0.0.1:${this._port}`, `localhost:${this._port}`]
    });
    await server.connect(transport);
    this._mcp = { server, transport };
    return this._mcp;
}
```

* Route branch, placed with the other POST routes:

```ts
} else if (pathname === '/mcp' && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
    if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
    const { transport } = await this._getMcp();
    await transport.handleRequest(req, res);   // raw req — do NOT pre-parse the body
}
```

* Extend the CORS headers at `:3380` with `Mcp-Session-Id, mcp-protocol-version, Last-Event-ID`, and add `Access-Control-Expose-Headers: Mcp-Session-Id`.
* Dispose in `stop()`: `await this._mcp?.transport?.close?.(); this._mcp = undefined;`

**Logic:** `handleRequest` takes the raw Node `IncomingMessage`/`ServerResponse` (`streamableHttp.d.ts:107-109`), so the transport reads the body itself. Passing a pre-parsed body via `this._parseJsonBody(req)` would consume the stream and leave the transport with an empty request — this is the single most likely implementation mistake in the change.

**Edge cases:** first request pays the dynamic-import cost — acceptable. If the import throws (chunk missing from a bundle), return `503 {error:'MCP transport unavailable'}` rather than a 500 stack; a missing chunk is a packaging bug and must be visible as one.

### 2. `src/standalone/cli.ts` — make the session token obtainable

**Context:** without this, `/mcp` is unusable on the target host. The standalone server always requires auth (`bootstrap.ts:311, 1489`), but the session token is in-memory only: the CLI prints the **one-time** token (`cli.ts:224-233`), which is single-use (`bootstrap.ts:1560-1562`) and exchanges for a cookie via a 303 redirect — a browser handshake Spark will not perform. There is no value a user can paste into an MCP client today.

**Implementation:** `startHeadlessSwitchboard` already returns the instance; surface the session token on it alongside `oneTimeToken` (`bootstrap.ts:1600-1606`, interface at `:79-84`), and print it from the CLI **only when the MCP endpoint is enabled**:

```
MCP endpoint:  http://127.0.0.1:<port>/mcp
MCP token:     <sessionToken>          (paste both into Gemini → Settings → Connected Apps)
```

**Logic:** the token already exists and already authorises every route; this exposes it to the user who owns the process, on the terminal they launched it from. It is not a new credential and not a new trust boundary. Gate the print behind the same opt-in flag that enables `/mcp` (PRD contract #2 — new capabilities default-OFF) so nothing changes for users who never touch MCP.

**Edge cases:** never write the token to `.switchboard/` or any file — an on-disk token is a materially weaker posture than the current in-memory one, and the port file's directory is world-readable. Printing to the owner's stdout is the whole mechanism. If Spark turns out not to accept custom headers (Uncertain Assumptions item 1), the fallback is a `?token=` query parameter on `/mcp` validated against the same `getAuthToken()` value — a **repeatable** check, distinct from the existing single-use one-time token, and still never an unauthenticated route.

### 3. `src/services/mcpBoardTools.ts` (new) — the tool surface

**Context:** one new host-agnostic module, registered from `_getMcp()`. Handlers call **in-process** paths, never loopback HTTP (`LocalApiServer.ts:1141-1144`).

> **Superseded:** the original eight-tool surface — `switchboard_health`, `switchboard_get_board`, `switchboard_get_plan`, `switchboard_dispatch`, `switchboard_move_card`, `switchboard_send_terminal_message`, `switchboard_create_plan`, `switchboard_reconcile_features`.
> **Reason:** that list was authored by an agent, not specified by the user, and an earlier pass of this plan preserved it as if it were a requirement. The stated need is **feature management, terminal interaction, card moves and card dispatch**. Plan authoring and plan-content retrieval are explicitly not wanted, so `plan_create` and `plan_read` are cut — which also shrinks the capability grant on a network-reachable endpoint and removes `plan_create`'s 409 / path-traversal error-mapping work. The single generic `switchboard_send_terminal_message` is replaced by four PTY-rail tools, because one send verb does not amount to terminal *interaction*. Feature management gains the read + restructure tools it needs and cannot function without.
> **Replaced with:** the twelve tools below, in three groups.

**Group A — features (6).** Note the addressing difference: `features_assign` and `features_reconcile` resolve plans by **file path / slug / title / planId** server-side, so the model never has to discover an opaque UUID; `feature_split` and `feature_delete` take a feature id.

| Tool | In-process path | Notes |
| --- | --- | --- |
| `features_list` | `_resolveDbFromQuery` → features read (`GET /kanban/features`, `:2397`) | the model's entry point — nothing else is usable without it |
| `plans_list` | `_resolveBoard(db)`, filtered by `column`, or `db.getSubtasksByFeatureId(featureId)` (`:2377-2395`) | needed to know what is available to group; returns records, **not** plan file content |
| `features_assign` | `POST /kanban/features/assign` handler (`:3450`) | **the additive single-add primitive** — `{feature, plan}` or `{feature, plans[]}`, path/slug-addressed, never detaches existing subtasks. Prefer this over reconcile for "add one plan" |
| `features_reconcile` | `_options.reconcileFeatures(root, features, {removeUnmentionedFeatures})` (`:1584-1610`) | declarative restructure. `features` must be a **non-empty array** or the handler 400s (`:1601-1605`) |
| `feature_split` | `POST /kanban/feature/split` handler (`:3448`) | one feature → two in a single call |
| `feature_delete` | `POST /kanban/feature/delete` handler (`:3446`) | |

**Group B — cards (2).**

| Tool | In-process path | Notes |
| --- | --- | --- |
| `card_move` | `_options.moveCard(...)` after `_canonicalColumnId()` (`:1263-1305`) | `_canonicalColumnId` rejects an unknown column with **400** listing the valid IDs — surface that text, it is the model's self-correction signal |
| `card_dispatch` | **`this.performKanbanDispatch(workspaceRoot, ref, rawColumn)`** — the documented in-process entry point (`:1141-1180`) | call the method, not the route. `ref` accepts planId or plan-file path; omitted/`"auto"` column ⇒ complexity routing. **409** when no live terminal exists |

**Group C — terminals (4), on the PTY rail.**

| Tool | In-process path | Notes |
| --- | --- | --- |
| `terminals_list` | `_options.terminalVerb('ptyListTerminals', …)` (`ptyHost.ts:89-102`) | returns `friendlyName`, `role`, `status`, `pid`, `startTime`, `cwd`, `worktreePath`. Call before any send — this is how the model learns valid names |
| `terminal_send_prompt` | `_options.terminalVerb('ptySendPrompt', {name, data, clearBeforePrompt?}, …)` (`ptyHost.ts:170-191`) | **`ptySendPrompt`, never `ptyWrite`** — see below |
| `terminal_create` | `_options.terminalVerb('ptyCreateTerminal', {role, name?, cwd?, worktreePath?}, …)` (`ptyHost.ts:69-84`) | |
| `terminal_close` | `_options.terminalVerb('ptyCloseTerminal', {name}, …)` (`ptyHost.ts:85-88`) | |

Plus `health` (`GET /health`, unauthenticated inline handler at `:3398-3414`) for liveness — returns `{status, port, roots, terminals, terminalCount}`.

> **Superseded (terminal send — two corrections, recorded together):**
> ```ts
> // original draft
> server.tool("switchboard_send_terminal_message", …,
>   { workspaceRoot: …, terminalName: z.string(), text: z.string() },
>   async ({ workspaceRoot, terminalName, text }) => {
>     const data = await apiRequest(`${baseUrl}/kanban/verb/sendToTerminal`, {
>       method: "POST", body: JSON.stringify({ workspaceRoot: root, terminalName, text }) });
> ```
> **Reason (1) — wrong rail and wrong payload.** `sendToTerminal` is a TaskViewer verb, not a Kanban verb (`verbAllowlist.ts:15`), so the Kanban rail rejects it at the allowlist gate; and the arm requires `{name, input}` (`verbSchemas.ts:1168-1175`, `TaskViewerProvider.ts:12831`), so `{terminalName, text}` yields `{success:false, error:'invalid terminal name'}`. Separately, `server.tool(...)` is `@deprecated` throughout the installed SDK 1.25.3 (`mcp.d.ts:108-141`).
> **Reason (2) — an earlier pass of this plan routed the fix through `taskViewerVerb('sendToTerminal', …)`, which is still wrong for this host.** That arm resolves the PTY fleet first and then falls back to VS Code terminals; standalone is the target host and has no VS Code terminals, so the fallback leg is dead weight and the indirection hides which fleet was hit. It also cannot reach the create/list/close verbs that terminal *interaction* needs.
> **Replaced with:** four tools on the PTY rail, sending via **`ptySendPrompt` — never `ptyWrite`**:
> ```ts
> server.registerTool('terminal_send_prompt', {
>     description: 'Send a prompt to a Switchboard PTY agent. Call terminals_list first for '
>         + 'valid names. WRITE-ONLY: this returns delivery status, not the agent\'s reply — '
>         + 'there is no way to read terminal output through this server.',
>     inputSchema: {
>         name: z.string().describe("Target terminal, e.g. 'lead-1' — from terminals_list."),
>         data: z.string().describe('Prompt text. Multi-line is safe; it submits as one prompt.'),
>         clearBeforePrompt: z.boolean().optional(),
>         workspaceRoot: z.string().optional()
>     }
> }, async (a) => toResult(await api.callTerminalVerb('ptySendPrompt', {
>     name: a.name, data: a.data,
>     ...(a.clearBeforePrompt !== undefined ? { clearBeforePrompt: a.clearBeforePrompt } : {})
> }, a.workspaceRoot)));
> ```
> `ptySendPrompt` owns bracketed-paste framing, chunked writes, the confirm CR and `withTerminalLock` serialisation, all of which live in the pty host because the lock is per-process state (`ptyHost.ts:170-191`). A raw `ptyWrite` submits a multi-line prompt line-by-line and the agent executes fragments.

**Known gap — terminals are write-only over HTTP.** `ptyFleetService.ts` keeps no scrollback ring buffer; output reaches clients only live over the `/ws/terminal` WebSocket gateway. MCP tools are request/response and cannot hold a socket, so an MCP client can send a prompt and **never read the reply**. Two-way interaction requires a retained buffer in the fleet plus a read verb (with a size cap and a since-cursor) — **net-new capability, out of scope for this plan, and its own plan if wanted.** The tool descriptions must say so plainly, or the model will send a prompt and hallucinate a response.

**Scope note — `features_reconcile` can create plan files.** Its subtask list accepts an inline `{slug, title, body}` form, and reconcile writes + imports + links the new plan. So plan authoring is reachable through this tool even though `plan_create` was cut. Flagged rather than silently accepted: cutting it would mean forbidding inline subtasks in the schema, which would also remove reconcile's main advantage for restructures.

**Implementation — three rules every handler follows:**
1. **`registerTool`, not `tool`.** `inputSchema` takes a raw Zod shape; 1.25.3 also accepts `z.object(...)` (`mcp.d.ts:149-158`), so either compiles — pick the raw shape and stay consistent.
2. **Every failure becomes an MCP error result**, never a success carrying an error body:
   ```ts
   const toResult = (r: any) => (r && r.success === false)
       ? { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: true }
       : { content: [{ type: 'text', text: JSON.stringify(r ?? { success: true }, null, 2) }] };
   ```
   Read tools unwrap `.data` (read endpoints wrap as `{success:true, data}` — `:2330-2332`); mutations return the body verbatim.
3. **Register conditionally.** If the backing callback is absent in this host (`_options.moveCard`, `_options.reconcileFeatures`, `_options.terminalVerb` are all optional), **do not register that tool** — an absent tool is honest; a registered tool that 503s is a dead button (PRD contract #6).

**Edge cases:**
* Every PTY verb returns `{success:false, error:"No such terminal: <name>"}` for an unknown name and `"Terminal <name> is not active"` for a dead one (`ptyHost.ts:118-126, 170-181`) → both map to `isError`. `terminals_list` is the model's only way to learn valid names; say so in every terminal tool's description.
* `health` reporting `terminalCount: 0` means no agent terminals are open and `card_dispatch` will 409 — surface that in the description rather than letting the model guess.
* `features_reconcile` is **converge-to-set**: omitting an existing subtask detaches it. The description must say "declare the feature's *entire* desired subtask list; use `features_assign` to add one plan without touching the rest." Without that sentence a model will orphan subtasks while believing it added one.

### 4. `src/standalone/bootstrap.ts` — the target host must carry every tool

**Context:** PRD contract #7 (two-layer completion) and #6 (capability honesty). Standalone is where Spark connects, so a tool missing its backing callback here is not a parity gap — it is the feature not working. The options bundle is built at `bootstrap.ts:1481-1575`.

**Implementation:** confirm every backing callback the twelve tools need is wired in the standalone bundle — `terminalVerb` (all four terminal tools), `moveCard`, `getKanbanDatabase` and `resolveAutoDispatchColumn` (cards), `reconcileFeatures`, `createFeature` and the feature assign/split/delete callbacks. Where one is not, either wire it (Layer 2 of the two-layer model) or accept that change 3's conditional registration drops the tool — but decide deliberately per tool rather than discovering it at runtime. Produce a written tool-by-tool table of what standalone actually supports.

`card_dispatch` deserves specific attention: `performKanbanDispatch` requires **both** `_options.kanbanVerb` and `getKanbanDatabase`, and returns a 503 "extension callbacks missing" when either is absent (`LocalApiServer.ts:1155-1159`). Confirm both exist under standalone, or `card_dispatch` — one of the two capabilities explicitly asked for — is a dead tool on the target host.

**Edge cases:** a tool present under the extension host and absent under standalone is the worst outcome — it demos fine and fails for the real user. Test tool discovery against `npx switchboard` first, and treat the extension host as the secondary check.

### 5. `README.md` / `AGENTS.md` — connection instructions

Document the standalone flow as the primary path: launch with a fixed port (`npx switchboard --port 47823`), take the printed MCP endpoint and token, paste both into the Gemini app under *Settings → Connected Apps*. Note that a fixed port makes the configuration durable across restarts, that a distinct port is needed per workspace, and that the extension host is a secondary path with no stable port. **Edit `.agents/` + `AGENTS.md` as the source of truth** — `CLAUDE.md` and `.claude/skills/` are generated mirrors.

---

## Verification Plan

### Automated Tests
Tests are skipped per session directive, and compilation is skipped per session directive. Target coverage for the coding pass:
* Unit-test the pure tool-result mapper against `{success:false,…}`, `{success:true,data}`, `undefined`, and a thrown error — asserting `isError` is set in exactly the failure cases and that read results are `.data`-unwrapped.
* A registration test asserting that with a stripped options bundle (no `moveCard` / `reconcileFeatures` / `terminalVerb` / `kanbanVerb`) the corresponding tools are **absent** from `tools/list` rather than present-and-failing.
* A contract check that every tool's backing path/method still appears in `protocol-catalog.json`'s `apiEndpoints[]`, mirroring the existing `catalog:check` / `parity:check` gates — the guard against endpoint drift silently turning a tool into a 404.

### Manual Verification

**Steps 1–10 run against `npx switchboard` — the target host. The extension host is checked afterwards, in step 12.**

1. **Launch and connect:** `npx switchboard --port 47823`; the CLI prints the `/mcp` endpoint and the session token. Paste both into the Gemini app under *Settings → Connected Apps*; Spark completes the `initialize` handshake.
2. **Auth is enforced, not bypassed:** `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:47823/mcp` → **401**. Repeat with `-H "Authorization: Bearer <token>"` → not 401. A `/mcp` that answers without a token is a bug, not a convenience.
3. **Durability across restarts — the whole point of the fixed port:** Ctrl+C, relaunch with the same `--port`, and confirm Spark reconnects **with no reconfiguration**. If the token rotates on restart and Spark has to be re-pasted anyway, that is a finding: consider persisting the token for the session or documenting the re-paste.
4. **Tool discovery:** the twelve tools appear with descriptions and typed parameters; `plan_create` / `plan_read` / `board_read` are **absent**.
5. **Reads carry data:** `features_list` and `plans_list` return real records in the body, not a bare `{success:true}` (PRD contract #4).
6. **Terminals, end to end:** `terminals_list` returns the live fleet with roles and statuses. `terminal_create` adds one and it appears in the next list. `terminal_send_prompt` with a **multi-line** prompt lands as a single submission — not line-by-line fragments, which is the whole reason it uses `ptySendPrompt` over `ptyWrite`. `terminal_close` removes it. Then send to a bogus name → MCP **error** result carrying `No such terminal: <name>`, not a success containing an error string.
7. **Cards:** `card_move` moves a real card and the board reflects it. `card_dispatch` with `targetColumn` omitted routes by complexity and starts an agent. With no live terminal, `card_dispatch` returns **409** as `isError`.
8. **Feature management:** `features_list` + `plans_list` give the model enough to work from. `features_assign` adds one plan **without detaching the others** — verify the rest of the subtask list survives, since this is the failure `features_reconcile` would cause. `features_reconcile` restructures. `feature_split` and `feature_delete` behave.
9. **Error-mapping negative controls:** `card_move` with a bogus `targetColumn` → **400** carrying the valid-column-ID list, as `isError`. `features_reconcile` with an empty array → **400**, as `isError`. None may render as a successful tool call.
10. **Capability honesty on the target host:** every tool listed in change 4's table is present and functional under standalone; any tool whose callback is unwired there is **absent** from `tools/list`, never present-and-503ing. Pay particular attention to `card_dispatch`, which needs both `kanbanVerb` and `getKanbanDatabase` or returns a 503.
11. **Bundle-weight measurement:** record `dist/extension.js` (**6,751,698 bytes** at plan time) and `dist/standalone/cli.js` before and after. Neither may grow materially; the SDK must land in a lazily-loaded split chunk. Growth of megabytes means the import is not actually lazy — fix before merging.
12. **Extension host (secondary):** hit `/mcp` from a packaged VSIX install (not the repo `dist/`) and confirm the dynamic import resolves — the VSIX ships no `node_modules`, so a chunk that resolves in dev and not in the VSIX is the failure mode to hunt. No bearer header needed there (loopback trust). Note the port is ephemeral on this host and Spark would need reconfiguring each launch; that is expected and is why standalone is primary.
13. **Byte-compat:** every existing route behaves unchanged; no per-provider test regressions; `npm run verb-returns:check`, `parity:check` and `push-routing:check` stay green.
14. **Plan import:** confirm Switchboard's plan importer registers this plan on the Kanban board.

---

## Uncertain Assumptions

Settled and not open to re-litigation: **Spark reaches the local filesystem and local ports on the user's machine** (stated by the plan's author, who uses it); Spark is HTTP-transport-only (no stdio subprocesses); Spark's MCP config is in-app UI, not a file; no Gemini host consumes `.mcpb`; SDK v2.0 removed `tool()` and changed the schema idiom, so v1.x is the pin. Everything asserted about the Switchboard codebase was verified directly against source.

Still open:

1. **Whether Spark's *Connected Apps* UI accepts custom request headers — the one item on the critical path.** Gemini CLI's file-based `httpUrl` shape supports a `headers` block; the Spark UI equivalent is unconfirmed. The standalone host always requires auth, so if Spark cannot send `Authorization`, change 2's fallback applies: a repeatable `?token=` query parameter on `/mcp` validated against the same `getAuthToken()` value. Answerable in one minute by opening the Connected Apps dialog and looking for a headers field — do that before writing change 2, since it decides which of the two auth paths gets built. Not a blocker: one of the two works.
2. **Which MCP protocol revision Spark negotiates.** The SDK transport handles version negotiation, so this is informational only.

---

## Recommendation

Complexity 7 → **Send to Lead Coder.**
