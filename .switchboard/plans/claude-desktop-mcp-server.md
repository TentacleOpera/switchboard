# Claude Desktop MCP Server — Local stdio Bridge to Switchboard's LocalApiServer

## Goal

Ship a **local stdio MCP server** that lets **Claude Desktop** (and any other MCP-only chat host) drive Switchboard's management surface — read the board, create/move/delete plans, reconcile features, dispatch coding — while VS Code sits minimised as the background execution engine. The MCP process is a **thin client** over the existing `LocalApiServer` HTTP surface; it adds a transport, not new capability.

### Problem & background

Every host that can drive Switchboard today does so because it has a **shell + filesystem**: Claude Code, Cursor, Codex CLI, Zed, Antigravity all read `.switchboard/api-server-port.txt` and `curl http://127.0.0.1:<port>` directly (documented in the `switchboard-orchestration` and `switchboard-manage` skills). That path needs no new code.

**Claude Desktop is the one large-userbase host that structurally cannot use it.** It is a chat app whose model loop runs in the cloud and which has **no shell, no arbitrary-URL fetch, and no agentic filesystem access**. Its *only* channel to anything on the user's machine is an **MCP server** — either a local **stdio** server it launches itself (via `claude_desktop_config.json` or a bundled `.mcpb` Extension) or a remote MCP over a public URL.

Root cause / why this is the correct bridge: a local stdio MCP server is **launched by Desktop as a subprocess on the user's machine**, so that subprocess resolves `127.0.0.1` to the *same box* and can reach `LocalApiServer` with no tunnel and no public exposure. This is precisely the case the `switchboard-manage` plan explicitly deferred — *"MCP server (explicitly deferred; revisit only for a host that permits MCP but forbids shell)"* (`switchboard-manage-console-skill.md`, Out of Scope). Desktop **is** that host, and its install base now justifies building it.

Why not the alternatives (already reasoned through):
- **Notion/Linear MCP relay** — works today with zero new Switchboard code, but it is a two-hop, poll-latency path limited to what maps onto a remote-control card. A native MCP is one hop, full `/catalog` surface, synchronous.
- **Remote/tunnel MCP** — needed only for the fully-hosted browser case (claude.ai web); it punches a public hole in a deliberately localhost-only server. Out of scope here.

## Metadata
- **Tags:** backend, api, cli, feature
- **Complexity:** 6

## User Review Required
Four design forks — recommendations noted; confirm or redirect before build:

1. **Tool granularity — recommend HYBRID.** A curated set of typed tools for the core management verbs (board read, plan CRUD, project/complexity set, move, feature reconcile, dispatch, worktree list/cleanup, ClickUp/Linear proxy, catalog) **plus** one generic `switchboard_request` passthrough (method + path + body). Rationale: `GET /catalog`'s `apiEndpoints[]` gives `path`+`method` but **not payload schemas**, so fully auto-generated tools would have empty input schemas. Curate schemas for the ~12 core verbs (good Desktop UX); let the passthrough cover the long tail and any endpoints the transport-parity work adds later, so the server doesn't need a rewrite each time `/catalog` grows.
2. **Workspace targeting — recommend config/env arg.** Desktop has no cwd or repo. The MCP takes a `workspaceRoot` from its launch config (env var or MCP server arg), reads the port file under it, and passes `workspaceRoot` on multi-root calls. One MCP entry per workspace the user wants to manage.
3. **Distribution — recommend BOTH.** A `.mcpb` (DXT) Desktop Extension for one-click install as the primary Desktop path, plus an `npx` bin (`npx @switchboard/mcp`) for other stdio hosts and manual `claude_desktop_config.json` setup. Reuse the packaging spine from the `extract-standalone-npx-*` feature.
4. **Auth — recommend env/config bearer token.** The MCP reads the token from its launch env/config and forwards `Authorization: Bearer <token>`; it does not read VS Code secret storage (different process, no access). If the user set `Switchboard: Api Token`, they paste the same value into the MCP config; if none is set, localhost requests are accepted as today.

## Scope

### ✅ IN SCOPE
- **New local stdio MCP server** (in-repo under `src/mcp/`, compiled to a standalone Node bin; built on `@modelcontextprotocol/sdk`). Pure HTTP client of `LocalApiServer` — never touches `kanban.db`, never re-implements a handler.
- **Bootstrap & liveness:** resolve `workspaceRoot` (arg/env/config) → read `.switchboard/api-server-port.txt` under it → `GET /health`. On failure, tool calls return a clear structured error ("Switchboard not running — open this workspace in VS Code with the extension active"), the server stays alive, and it **re-reads the port file on every call** (the port changes on each VS Code restart — never cache it for the process lifetime).
- **Curated tools** mapping 1:1 to documented endpoints (`switchboard-orchestration/SKILL.md` §2–6): `board_read`, `plan_read`, `plan_create`, `plan_delete`, `plan_set_project`, `plan_set_complexity`, `card_move`, `features_reconcile` (+ imperative feature verbs), `orchestration_dispatch`, `worktree_list`, `worktree_cleanup`, `clickup_request`/`linear_request`, `catalog_read`, and the generic `switchboard_request` passthrough.
- **Management-console persona doc** — a companion skill/README (`.agents/skills/switchboard-mcp/` or a README shipped in the package) that mirrors the `switchboard-manage` persona: report board state on entry, then wait; **no eager automation, no eager research, deletes execute immediately (no confirm gates — project rule), never ask about project pinning, state the capability ceiling honestly.**
- **Distribution artifacts:** `.mcpb` bundle manifest + an `npx` bin entry; a documented `claude_desktop_config.json` snippet.
- **Docs:** add the MCP host to the `AGENTS.md` / `CLAUDE.md` host tables and the `switchboard-manage` skill's capability notes ("Desktop reaches this surface via the MCP server, not shell").

### ⚙️ OUT OF SCOPE
- **Any change to `LocalApiServer` endpoints or handlers.** The MCP consumes today's surface (plus whatever the transport-parity work adds); it adds no routes.
- **Remote/hosted MCP (public URL / tunnel)** — the claude.ai-web case. Not this plan.
- **The Notion/Linear relay** — already exists; this is the direct alternative, not a replacement.
- **Capabilities the API doesn't expose yet** (terminal control, worktree creation, project/column creation). They light up automatically when the standalone transport work lands endpoints and the passthrough tool reaches them.
- **`node-pty`/browser board/npx product packaging** beyond reusing its build spine (that's the standalone feature).

## Implementation Steps
1. **Scaffold `src/mcp/`** — a standalone Node entrypoint using `@modelcontextprotocol/sdk` (stdio transport). Add a `bin` entry and a build target (tsc/esbuild) producing a self-contained script; keep it out of the VS Code webpack bundle.
2. **Bootstrap module** — `resolveWorkspaceRoot()` (arg → env → config), `readPort(root)` (re-read every call), `healthCheck(base)`, and a `call(method, path, body?)` helper that adds `Authorization: Bearer` when a token is configured and maps HTTP status → MCP tool errors (400/401/404/409/503/500 per the orchestration skill's envelope).
3. **Curated tool registrations** — one MCP tool per core verb with a hand-authored input schema, each delegating to `call(...)`. Read endpoints unwrap `.data`; mutations return `{ success, ...fields }` verbatim.
4. **Generic passthrough tool** — `switchboard_request({ method, path, body?, workspaceRoot? })` for the long tail and future endpoints; optionally validate `path` against `GET /catalog`'s `apiEndpoints[]` and surface the catalog via `catalog_read`.
5. **Persona doc + config docs** — write the console-persona skill/README and the `claude_desktop_config.json` / `.mcpb` install instructions.
6. **Packaging** — `.mcpb` manifest (name, entrypoint, `workspaceRoot`/token config prompts) and the `npx` bin; wire into the standalone-npx build if that feature has landed, else a standalone `package.json`.
7. **Docs wiring** — add the MCP host row to `AGENTS.md`/`CLAUDE.md` and note it in `switchboard-manage`.

## Edge cases & risks
- **VS Code not running when Desktop launches the MCP** → health check fails; return the clear "start VS Code + Switchboard" error, keep the server alive, retry on the next call. Never crash the stdio process (Desktop would drop all tools).
- **Port changes across VS Code restarts** → re-read `.switchboard/api-server-port.txt` on every call; never cache the port for the process lifetime.
- **Multi-root workspace / multiple VS Code windows** → the MCP is pinned to one `workspaceRoot`; pass `workspaceRoot` on calls; document one MCP entry per managed workspace.
- **Auth token rotation** → read the token from env/config at call time, not once at startup (or accept a restart on config change — Desktop restarts the subprocess on config edit anyway).
- **Deletes** → immediate, no confirm gate (project rule); `plan_delete` exposes `deleteFile` and the tool description warns about the re-import-on-next-scan gotcha (orchestration skill §3).
- **Tool-count / naming limits in Desktop** → keep the curated set tight (~12) and lean on the passthrough for breadth; prefix tool names `switchboard_` to avoid collisions with other connectors.
- **Security** → stdio subprocess on the user's machine calling loopback only; no public listener is opened. Token posture matches the existing HTTP surface.

## Verification
- Install the `.mcpb` (or add the `claude_desktop_config.json` snippet), open a Switchboard workspace in VS Code, minimise it. In Claude Desktop: the `switchboard_*` tools appear; `board_read` returns the live board; `plan_create` / `card_move` / `features_reconcile` / `orchestration_dispatch` each take effect on the board — all with VS Code minimised.
- With VS Code **closed**, every tool call returns the structured "not running" error and the MCP process stays alive; reopening VS Code restores function without restarting Desktop's subprocess (port re-read).
- Restart VS Code (new port) mid-session → next tool call succeeds against the new port.
- Persona check: on entry the agent reports board state and waits; no eager grouping/dispatch; never emits a confirm gate; never asks about project pinning.

## Files changed
- `src/mcp/**` — new stdio MCP server (entrypoint, bootstrap, tools, passthrough).
- `package.json` — `bin` entry + build target + `@modelcontextprotocol/sdk` dep (or a dedicated `src/mcp/package.json` if shipped as its own npx package).
- `.mcpb` manifest + `claude_desktop_config.json` example (docs).
- `.agents/skills/switchboard-mcp/SKILL.md` (or README) — management-console persona for the MCP host.
- `AGENTS.md` / `CLAUDE.md` — add the MCP host row; note in `switchboard-manage` capability text.

## Complexity Audit
### Routine
- Each curated tool is a thin `call(method, path, body)` delegate over an already-documented endpoint — mechanical, patterned after the orchestration skill's curl examples.
- The persona doc reuses the `switchboard-manage` persona nearly verbatim (report-then-wait, no automation, no confirm gates).
- Docs/table edits.
### Complex / Risky
- **stdio lifecycle robustness** — the process must never crash on a failed backend call (Desktop drops every tool if the subprocess dies); all errors become tool-level results, and the port is re-read per call.
- **Packaging/distribution** (`.mcpb` + npx) — new build target outside the webpack bundle; getting the self-contained bin and the SDK dependency right is the main non-trivial engineering.
- **Workspace/token config UX** — Desktop users aren't in a repo; the config prompts (`workspaceRoot`, optional token) must be clear or the health check fails opaquely.

## Dependencies
- **`extract-standalone-npx-*` feature** — reuse its packaging/build spine for the npx bin; not a hard blocker (the MCP can ship with its own minimal `package.json`), but aligning avoids a second distribution mechanism.
- **`GET /catalog` (Feature A · A1)** — already shipped (`protocol-catalog.json`, `apiEndpoints[]`); the passthrough/`catalog_read` tool consumes it for discovery. Note the catalog carries `path`+`method` only, not payload schemas, which is why the core tools are hand-schema'd.
- No session dependencies. Purely additive: no `LocalApiServer` change, no migration, no shipped-state change.
