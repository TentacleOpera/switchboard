# Claude Desktop MCP Server — Local stdio Bridge to Switchboard's LocalApiServer

## Goal

Ship a **local stdio MCP server** that lets **Claude Desktop** (and any other MCP-only chat host) drive Switchboard's management surface — read the board, create/move/delete plans, reconcile features, dispatch coding — while VS Code sits minimised as the background execution engine. The MCP process is a **thin client** over the existing `LocalApiServer` HTTP surface; it adds a transport, not new capability.

### Problem & background

Every host that can drive Switchboard today does so because it has a **shell + filesystem**: Claude Code, Cursor, Codex CLI, Zed, Antigravity all read `.switchboard/api-server-port.txt` and `curl http://127.0.0.1:<port>` directly (documented in the `switchboard-orchestration` and `switchboard-manage` skills). That path needs no new code.

**Claude Desktop is the one large-userbase host that structurally cannot use it.** It is a chat app whose model loop runs in the cloud and which has **no shell, no arbitrary-URL fetch, and no agentic filesystem access**. Its *only* channel to anything on the user's machine is an **MCP server** — either a local **stdio** server it launches itself (via `claude_desktop_config.json` or a bundled `.mcpb` Extension) or a remote MCP over a public URL.

Root cause / why this is the correct bridge: a local stdio MCP server is **launched by Desktop as a subprocess on the user's machine**, so that subprocess resolves `127.0.0.1` to the *same box* and can reach `LocalApiServer` with no tunnel and no public exposure. This is precisely the case the `switchboard-manage` plan explicitly deferred — *"MCP server (explicitly deferred; revisit only for a host that permits MCP but forbids shell)"* (`switchboard-manage-console-skill.md:42`, ⚙️ OUT OF SCOPE). Desktop **is** that host, and its install base now justifies building it.

#### Prior-art / historical context (added during review — factual, do not drop)

Switchboard **previously shipped an in-extension MCP server and deliberately removed it.** The old `src/mcp-server/` tree (`register-tools.js` was 3466 lines, plus `mcp-server.js`, `register-mcp.js`, `state-manager.js`, `workflows.js`, and a dedicated `mcpServerConfig` webpack entry) was deleted in commit `0b7ef13 "removed mcp"` (2026-05-25), per the shipped plans `remove-all-mcp-server-references.md` (complexity 7) and `replace-mcp-with-skills.md`. Rationale on record: workflow coordination moved to IDE chat commands, and API operations moved to **skills over the `LocalApiServer` HTTP surface**. The old server was a chronic maintenance sink (`fix_sql_wasm_missing_from_mcp_bundle`, repeated `mcp_setup_still_broken` / `mcp_setup_is_still_screwed` / CSP-fix plans).

**This plan is not a resurrection of that server — it is a fundamentally different shape**, and the distinction is load-bearing:

| | Old (removed) MCP server | This plan's MCP server |
|---|---|---|
| Process owner | The VS Code extension spawned & tracked it (`.switchboard/.mcp_server.pid`) | **Claude Desktop** launches it as its own subprocess |
| Coupling | Bundled *into* the extension build (webpack entry, sql.js WASM) | **External**, zero coupling to the extension build |
| Role | Stateful server + workflow coordination tools | **Stateless thin HTTP client** of `LocalApiServer` |
| State | Held its own state (`state-manager.js`) | Holds none; every call hits the live HTTP surface |

Two pieces of the old server's **removal cleanup are still live in `src/extension.ts` (~lines 612–668)** and this plan must navigate them (see Edge-Case & Dependency Audit):
- an **orphan-PID killer** that SIGKILLs any process whose PID sits in `.switchboard/.mcp_server.pid`;
- a **config scrubber** that, on every activation, deletes any entry keyed literally `switchboard` from `.vscode/mcp.json`, `.cursor/mcp.json`, `.mcp.json`, `.kiro/settings/mcp.json`, `.gemini/settings.json`, and `~/.codeium/windsurf/mcp_config.json`.

Why not the alternatives (already reasoned through):
- **Notion/Linear MCP relay** — works today with zero new Switchboard code, but it is a two-hop, poll-latency path limited to what maps onto a remote-control card. A native MCP is one hop, full `/catalog` surface, synchronous.
- **Remote/tunnel MCP** — needed only for the fully-hosted browser case (claude.ai web); it punches a public hole in a deliberately localhost-only server. Out of scope here.
- **MCP transport bolted onto `LocalApiServer` directly** — one process, no bin, but it would open an MCP surface on the 127.0.0.1-only server and still not give Desktop a tunnel-free path (Desktop's local option *is* stdio). Same out-of-scope bucket as remote MCP.

## Metadata
- **Tags:** feature, api, cli, infrastructure, docs
- **Complexity:** 7

> **Superseded:** Complexity: 6
> **Reason:** Review surfaced three risk multipliers the original score didn't weigh: (1) a **new build pattern with no precedent in the repo** — a Node bin compiled outside the single webpack entry (Agent-confirmed: no `bin`, no esbuild, no second target, no `src/mcp` today); (2) **packaging correctness under `.vscodeignore`**, which excludes both `node_modules/**` and `src/**`, so the bin must be self-bundled or shipped as its own package — a real trap, not boilerplate; (3) **re-introducing a subsystem that was removed**, over two live activation-time landmines (PID killer + config scrubber), plus a persona-delivery redesign. That is "new patterns + multi-artifact coordination + risk of silent regression," which the scoring guide places at 7 (High).
> **Replaced with:** Complexity: 7 → recommendation "Send to Lead Coder."

## User Review Required

These are **design decisions the plan commits to**, with rationale — not open questions. Each is overridable if you redirect; otherwise build as stated.

1. **Tool granularity — DECIDED: HYBRID.** A curated set of typed tools for the core management verbs (board read, plan CRUD, project/complexity set, move, feature reconcile + imperative verbs, dispatch, worktree list/cleanup, ClickUp/Linear proxy, catalog) **plus** one generic `switchboard_request` passthrough (method + path + body). Rationale — **now confirmed against ground truth**: `GET /catalog`'s `apiEndpoints[]` returns `{path, method, prefix}` only and carries **zero payload schemas** (verified: 48 entries, no `schema`/`properties`/`payload` keys anywhere in `protocol-catalog.json`). Fully auto-generated tools would therefore have **empty input schemas** and be unusable in Desktop. Hand-schema the ~14 core verbs (good Desktop UX); let the passthrough cover the long tail and any endpoints the transport-parity work adds later, so the server needs no rewrite each time `/catalog` grows.
2. **Workspace targeting — DECIDED: config/env arg.** Desktop has no cwd or repo. The MCP takes a `workspaceRoot` from its launch config (env var or MCP server arg), reads the port file under it, and passes `workspaceRoot` on multi-root calls. One MCP entry per workspace the user wants to manage. **(Product scope note: multi-root support is a preserved product requirement — do not narrow it, even though the current dev session is single-repo.)**
3. **Distribution — DECIDED: BOTH, but own-package first.** A `.mcpb` (Desktop Extension) for one-click Desktop install as the primary Desktop path, plus an `npx` bin for other stdio hosts and manual `claude_desktop_config.json` setup.

   > **Superseded:** "Reuse the packaging spine from the `extract-standalone-npx-*` feature."
   > **Reason:** Ground truth: the `standalone-headless-switchboard-npx` feature and all its subtasks (including B4, the npx-distribution packaging plan) are in the **CREATED** column — not landed. `node-pty` is not installed, there is no `src/standalone/`, no `bin`, and no second webpack target in the tree. The spine does not exist to reuse yet.
   > **Replaced with:** Ship the MCP bin as **its own self-contained package** (dedicated `src/mcp/package.json` with `@modelcontextprotocol/sdk` as a runtime dep, resolved at `npx`/install time) as the primary and currently-only viable mechanism. If/when the standalone-npx spine lands its second-webpack-target pattern, *converge onto it* (shared build, `files` allowlist, extension-VSIX-byte-stable release gate) — but do not block on it.
4. **Auth — DECIDED: env/config bearer token, token-less by default.** The MCP reads an optional token from its launch env/config and forwards `Authorization: Bearer <token>`; it does **not** read VS Code secret storage (different process, no access — architecturally correct and preserved).

   > **Superseded:** "If the user set `Switchboard: Api Token`, they paste the same value into the MCP config; if none is set, localhost requests are accepted as today."
   > **Reason:** Verified: `switchboard.apiToken` is a **VS Code SecretStorage key that is only ever read** (`TaskViewerProvider.ts:1232`) — there is **no `contributes.configuration` property, no command, and no `secrets.store` call** that ever writes it (setters exist only for clickup/linear/notion/stitch tokens). The "Switchboard: Api Token setting" named in the plan (and in `LocalApiServer.ts`'s own 401 error text) **does not exist in the shipped extension**; directing users to set it would send them nowhere.
   > **Replaced with:** The realistic default is **token-less**: `_checkAuth` (`LocalApiServer.ts:352-377`) accepts any request with **no `Authorization` header** (localhost bind is the gate), so the MCP works out of the box forwarding no token. **Trap:** since `getAuthToken()` always returns `''` today (no setter writes `switchboard.apiToken`), `_checkAuth` **401s any request that *does* send a bearer header** — it compares against the empty stored token. So the MCP must send **no `Authorization` header by default**; forwarding a user-supplied token would break auth (401), not enable it, until an extension-side token-setter exists. Keep the env/config `SWITCHBOARD_API_TOKEN` option as **forward-looking** only, document it as optional, and do **not** reference a non-existent settings UI.

## Scope

### ✅ IN SCOPE
- **New local stdio MCP server** (in-repo under `src/mcp/`, compiled to a standalone Node bin; built on `@modelcontextprotocol/sdk`, already a declared dependency). Pure HTTP client of `LocalApiServer` — never touches `kanban.db`, never re-implements a handler.
- **Bootstrap & liveness:** resolve `workspaceRoot` (arg/env/config) → read `.switchboard/api-server-port.txt` under it → `GET /health`. On failure, tool calls return a clear structured error ("Switchboard not running — open this workspace in VS Code with the extension active"), the server stays alive, and it **re-reads the port file on every call** (the port is chosen by `listen(0)` — a fresh OS-assigned port on each VS Code restart — so never cache it for the process lifetime).
- **Curated tools** mapping 1:1 to documented endpoints (exact paths verified — see Proposed Changes): `board_read`, `columns_read`, `plan_read`, `plan_create`, `plan_delete`, `plan_set_project`, `plan_set_complexity`, `card_move`, `features_reconcile` (+ the imperative feature verbs), `orchestration_dispatch`, `worktree_list`, `worktree_cleanup`, `clickup_request`/`linear_request`, `catalog_read`, and the generic `switchboard_request` passthrough.
- **Management-console persona, delivered over the MCP protocol** — see the Superseded callout below. The persona mirrors `switchboard-manage`: report board state on entry then wait; **no eager automation, no eager research, deletes execute immediately (no confirm gates — project rule), never ask about project pinning, state the capability ceiling honestly.**

  > **Superseded:** "Management-console persona doc — a companion skill/README (`.agents/skills/switchboard-mcp/` or a README shipped in the package)."
  > **Reason:** **Claude Desktop has no filesystem skill discovery** — it will never read a `.agents/skills/…/SKILL.md`. Delivering the persona as a skill file means the tools appear and work while the agent exhibits *none* of the console discipline the persona defines (it would eagerly automate, emit confirm gates, and ask which project to pin — exactly what the persona forbids). This is a goal-vs-appearance gap: the surface is reachable but the behavioural goal is unmet.
  > **Replaced with:** Do **not** rely on a filesystem skill for Desktop. **Web research (2026-07, confirmed) established that Claude Desktop ignores the MCP `instructions` field entirely and surfaces registered prompts *only* as explicit user-invoked slash commands — there is no fully-passive persona channel on Desktop.** Deliver the persona in three layers, strongest-passive first:
  >   1. **Tool descriptions — the only channel that passively reaches Desktop's model.** Bake the non-negotiable console rules into the descriptions of the mutating tools especially: *deletes execute immediately (no confirm gate), no eager automation, never ask which project to pin, report-then-wait on entry.* This is now the primary persona vehicle for Desktop, not a garnish.
  >   2. **A `registerPrompt` named `switchboard_console`** (SDK `mcp.js:726`) — an opt-in slash command that loads the full persona on demand. Closest thing to on-demand persona; the user must invoke it.
  >   3. **Still set the server `instructions` field** (SDK-supported, `dist/esm/server/index.js`) — harmless, and honored by MCP clients that *do* consume it (e.g. Claude Code). Document that full persona fidelity on Desktop may require the user to paste the persona into their Claude Project/profile custom instructions.
  > Additionally ship a **README** (human-facing) and, **only for filesystem hosts using the npx bin** (Claude Code / Antigravity — which *do* honor `instructions`), an `.agents/skills/switchboard-mcp/SKILL.md` — which, for Claude Code, **must be added to `MIRROR_MANIFEST` in `ClaudeCodeMirrorService.ts` (46-159)** or it is never generated into `.claude/skills/` (the dynamic scan only auto-picks flat `switchboard-*.md` files, not directories).
- **Distribution artifacts:** `.mcpb` bundle manifest + an `npx` bin entry; a documented `claude_desktop_config.json` snippet.
- **Docs:** add the MCP host to the `AGENTS.md` / `CLAUDE.md` host tables and the `switchboard-manage` skill's capability notes ("Desktop reaches this surface via the MCP server, not shell").
- **Discovery & onboarding — in-extension one-click "Connect Claude Desktop"** (the discovery surface; without it the ~4,000 existing VS Code users never learn the bridge exists — `AGENTS.md`/`CLAUDE.md` are agent-facing, and a README is circular). A button in the **Setup panel** (`SetupPanelProvider`/`setup.html`) backed by a `switchboard.connectClaudeDesktop` command that:
  - resolves Claude Desktop's per-OS config path (macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`), reads-or-creates the JSON, and **idempotently merges** an `mcpServers["switchboard-mcp"]` entry — overwriting only our own key, never clobbering other servers;
  - writes `{ command: "npx", args: ["-y", "@switchboard/mcp"], env: { SWITCHBOARD_WORKSPACE_ROOT: "<resolved root>" } }`, **pre-filling the workspace root the extension already knows** (the no-download happy path); the env var reuses the exact `SWITCHBOARD_WORKSPACE_ROOT` name the old `connectMcp` templates used (commit 31c3937);
  - tells the user to restart Claude Desktop, and also offers **"Reveal .mcpb"** for users who prefer Desktop's native extension-install UI.
  This directly reuses the removed `connectMcp` precedent (commits 31c3937 / 76780bd; the old MCP also had buttons in `setup.html`). Distribution is **self-hosted only** — the `.mcpb` and npx bin are handed out directly (repo release / npm); **no submission to Claude Desktop's extension directory** (explicit user decision).

### ⚙️ OUT OF SCOPE
- **Any change to `LocalApiServer` endpoints or handlers.** The MCP consumes today's surface (plus whatever the transport-parity work adds); it adds no routes.
- **Remote/hosted MCP (public URL / tunnel)** — the claude.ai-web case. Not this plan.
- **The Notion/Linear relay** — already exists; this is the direct alternative, not a replacement.
- **Capabilities the API doesn't expose yet** (terminal control, worktree creation, project/column creation). They light up automatically when the standalone transport work lands endpoints and the passthrough tool reaches them.
- **`node-pty`/browser board/npx product packaging** beyond the MCP bin's own packaging (that's the standalone feature).
- **Adding a token-setter UI** for `switchboard.apiToken` — out of scope here, but noted as the missing piece that would make the bearer-token path usable (see User Review #4).

## Complexity Audit

### Routine
- Each curated tool is a thin `call(method, path, body)` delegate over an already-documented, ground-truth-verified endpoint — mechanical, patterned after the orchestration skill's curl examples.
- The persona *content* reuses the `switchboard-manage` persona nearly verbatim (report-then-wait, no automation, no confirm gates).
- Docs/table edits (`AGENTS.md`, `CLAUDE.md`, `switchboard-manage` capability text).
- Adding `@modelcontextprotocol/sdk` as a dep is a near no-op — it is already declared (`package.json:852`, `^1.0.3`, resolved 1.25.3).

### Complex / Risky
- **stdio lifecycle robustness** — the process must never crash on a failed backend call (Desktop drops every tool if the subprocess dies); all errors become tool-level results, and the port is re-read per call.
- **Packaging/distribution** (`.mcpb` + npx) — a **new build pattern with no precedent in this repo**. `.vscodeignore` excludes both `node_modules/**` and `src/**`, so the bin cannot rely on loose node_modules if it ever rode inside the vsix; it must be **self-bundled or shipped as its own package**. The SDK is **ESM** (`"type": "module"`, Node16 resolution) — the bin must be authored/emitted as ESM (or handled via the bundler's ESM/CJS interop). This is the main non-trivial engineering.
- **Persona delivery on Desktop** (new — the sharpest correctness risk): research-confirmed that Desktop **ignores `instructions`** and surfaces prompts **only on explicit user invocation**, so the console discipline must live in **tool descriptions** (the only passive channel) plus an opt-in `switchboard_console` prompt. Full persona fidelity on Desktop is inherently best-effort; the mutating-tool descriptions carry the load-bearing rules.
- **Config-scrubber collision** (new): the activation-time scrubber deletes any `switchboard`-keyed MCP entry from six host configs. The server key/name must avoid the literal `switchboard` (use `switchboard-mcp`) or the npx-into-Cursor path self-destructs on the next VS Code reload.
- **Workspace/token config UX** — Desktop users aren't in a repo; the config prompts (`workspaceRoot`, optional token) must be clear or the health check fails opaquely.
- **Extension-side onboarding surface** (new — scope expansion): the "Connect Claude Desktop" command writes to **another app's global config file** (`claude_desktop_config.json`). Must be an idempotent merge (never clobber the user's other MCP servers), per-OS-path-correct, and multi-root-aware (one entry per root, keyed distinctly — see Side Effects). Precedented by the old `connectMcp` but it is genuine extension work, not part of the standalone bin.

## Edge-Case & Dependency Audit

### Race Conditions
- **Ephemeral port re-read.** `LocalApiServer` binds via `listen(0, '127.0.0.1')` (`LocalApiServer.ts:254`); the port is written atomically (temp-then-rename) to `<root>/.switchboard/api-server-port.txt` by `TaskViewerProvider` (`1459-1472`) and **deleted on stop / rewritten by a watchdog if missing** (`1512-1546`). The MCP must re-read the file on **every** call — never cache — and tolerate a transient missing-file window (retry / return the structured "not running" error).
- **Mid-session VS Code restart** → new port; the per-call re-read handles it with no Desktop-subprocess restart.

### Security
- **Loopback-only, enforced twice.** The server binds `127.0.0.1` only and additionally rejects any non-loopback socket with **403** (`_handleRequest`, `LocalApiServer.ts:2346-2352`). The MCP is a subprocess on the same box calling loopback — no public listener is opened by this work.
- **Auth posture matches the existing surface.** No `Authorization` header → accepted (localhost trust, `_checkAuth` 359-365); header present → `Bearer <token>` required with constant-time compare (366-376). The MCP forwards a bearer token only if one is configured; token-less is the working default (see User Review #4).
- **Token isolation is correct by construction** — the MCP subprocess cannot read VS Code SecretStorage, so it can only ever forward a token supplied to *it*.

### Side Effects
- **Config scrubber (`extension.ts` ~635-668).** On every activation the extension deletes any entry keyed `switchboard` from `.vscode/mcp.json` (key `servers`), `.cursor/mcp.json`, `.mcp.json`, `.kiro/settings/mcp.json`, `.gemini/settings.json`, `~/.codeium/windsurf/mcp_config.json` (key `mcpServers`). **`claude_desktop_config.json` is NOT in the list**, so the primary Desktop path is safe. The npx-into-a-scrubbed-host path is **not** safe under the key `switchboard`. Mitigation: register the server under **`switchboard-mcp`** and document it; call the scrubber out in the README so users don't reuse the doomed name.
- **Orphan-PID killer (`extension.ts` ~612-633).** SIGKILLs any process whose PID is in `.switchboard/.mcp_server.pid`. The Desktop-launched MCP is owned by Desktop and must **not** write that file — doing so would arm the extension to kill it on the next activation. Implementation note: the MCP writes no PID file under `.switchboard/`.
- **Deletes are immediate** — no confirm gate (project rule). `plan_delete` exposes `deleteFile` (a **query param**, `?deleteFile=true`, path-traversal-guarded to `.switchboard/plans/`, `LocalApiServer.ts:1619`); the tool description must warn about the re-import-on-next-scan gotcha (without `deleteFile`, the `.md` re-appears on the next `import_plans`).
- **"Connect Claude Desktop" writes another app's global config.** The command edits `claude_desktop_config.json` (outside the workspace, in the user's home/AppData). It must: read-or-create; **merge** only the `mcpServers["switchboard-mcp"]` key (preserve all other servers and unknown keys — same non-destructive discipline the codebase applies to host configs); resolve the correct per-OS path; and, for a **multi-root** workspace, write one entry per root under distinct keys (e.g. `switchboard-mcp-<slug>`) rather than a single ambiguous entry. Claude Desktop reads this config at launch, so surface a "restart Claude Desktop" nudge. Note: Desktop's config is **not** touched by the extension's own `switchboard`-key scrubber, so no self-destruct — but still use the `switchboard-mcp` key for consistency with the scrubber-safe naming rule.

### Dependencies & Conflicts
- **`LocalApiServer` HTTP surface** — the entire contract this MCP depends on. Every curated endpoint is verified present (see Proposed Changes). **No backend change required.**
- **`GET /catalog`** — verified present (`LocalApiServer.ts:2487`, auth-gated, `{success,data}` envelope; serves the checked-in `protocol-catalog.json`; 404 with a "run generate-protocol-catalog" message if missing). Its `apiEndpoints[]` is `{path, method, prefix}` only — no payload schemas — which is *why* the core tools are hand-schema'd.
- **`extract-standalone-npx` packaging spine** — **not landed** (all subtasks CREATED). Not a blocker: ship the MCP as its own package now; converge later. See User Review #3.
- **`ClaudeCodeMirrorService.ts` `MIRROR_MANIFEST`** — a hard dependency *only if* an `.agents/skills/switchboard-mcp/` skill is shipped for filesystem hosts: it must be added there or Claude Code never generates it.

## Dependencies
- No session dependencies (`sess_…`). The work is **additive at the API layer** — no `LocalApiServer` route/handler change, no migration, no schema change.

> **Superseded:** "Purely additive: no `LocalApiServer` change, no migration, no shipped-state change."
> **Reason:** Additive at the *HTTP-API* layer is accurate, but "no shipped-state change" overstates it: the work interacts with **shipped activation-time state-cleanup code** — the config scrubber and orphan-PID killer in `extension.ts` — which will actively delete or kill a naively-named/placed MCP registration. The interaction is navigable (naming + not writing a PID file) but it is not "nothing to see here."
> **Replaced with:** No backend/route/migration change (`LocalApiServer` is untouched). **Two extension-side interactions to navigate:** (1) the MCP-removal cleanup (scrubber + PID killer) — mitigated by the server key `switchboard-mcp` and writing no `.switchboard/.mcp_server.pid`; (2) the **new "Connect Claude Desktop" onboarding command + Setup-panel button** — a deliberate, precedented (`connectMcp`) addition to the extension, not part of the standalone bin. The `@modelcontextprotocol/sdk` dependency is already declared; no new dep to add for the core.

## Adversarial Synthesis

**Risk Summary:** The architecture (external thin stdio client over the unchanged HTTP surface) is sound and validated by ground truth; the real risks are (1) **persona delivery** — a `.agents/skills` file is invisible to Desktop, and research confirms Desktop also ignores MCP `instructions` and treats prompts as user-only slash commands, so the console discipline must live in **tool descriptions** (the sole passive channel) or the tools work while the *behaviour* silently doesn't; (2) **the activation-time config scrubber**, which deletes `switchboard`-keyed MCP entries and will silently uninstall the npx path unless the server key is `switchboard-mcp`; and (3) **packaging**, a new build pattern that must be self-contained because the vsix ships no `node_modules`. Mitigations: bake console rules into (esp. mutating) tool descriptions + an opt-in `switchboard_console` prompt (and still set `instructions` for clients that honor it), name the server `switchboard-mcp`, ship the bin as its own ESM package, re-read the ephemeral port every call, and correct the non-existent auth-setting reference (token-less localhost is the working default).

## Proposed Changes

**Build order:** (1) scaffold `src/mcp/` + own `package.json`/tsconfig → (2) bootstrap module → (3) curated tools → (4) passthrough + catalog → (5) persona via tool-descriptions + `switchboard_console` prompt → (6) packaging (`.mcpb` + npx) → (7) in-extension "Connect Claude Desktop" onboarding surface → (8) docs + manifest.

### `src/mcp/**` (new — entrypoint, bootstrap, tools, passthrough, persona)
- **Context:** A standalone ESM Node entrypoint using `@modelcontextprotocol/sdk` stdio transport (`StdioServerTransport`). Kept **out** of the VS Code webpack bundle (single entry `./src/extension.ts`, `dist/extension.js`). Built via its own `tsconfig.mcp.json` (base `tsconfig.json` has `noEmit:true` — a dedicated emit config or bundler is required) or a self-contained bundle.
- **Logic — bootstrap module:**
  - `resolveWorkspaceRoot()` — arg → env (`SWITCHBOARD_WORKSPACE_ROOT`) → config.
  - `readPort(root)` — read `<root>/.switchboard/api-server-port.txt` **on every call** (never cache); missing → structured `SWITCHBOARD_NOT_RUNNING` error.
  - `healthCheck(base)` — `GET /health` (no auth; returns `{status, port, roots}`).
  - `call(method, path, body?, workspaceRoot?)` — adds `Authorization: Bearer <token>` **only if** a token is configured; maps HTTP status → MCP tool result. **Success = any 2xx (200/201/204)** — do not assume 200 (`plan_create` returns **201**). **Error mapping must cover 400/401/403/404/405/409/413/500/502/503** (note **502** is emitted by move/cleanup/feature handlers on `{success:false}` upstream failure, and **413** for oversized plan bodies). Error body is `{error}` or `{error, detail}` — surface both.
- **Logic — curated tools (exact verified paths):**

  | Tool | Method + Path | Notes |
  |---|---|---|
  | `board_read` | `GET /kanban/board` | full board |
  | `columns_read` | `GET /kanban/columns` | `{builtIn, custom}` |
  | `plan_read` | `GET /kanban/plan?planId=` (single, incl. `.data.content`) / `GET /kanban/plans?column=`/`?featureId=` (list) | |
  | `plan_create` | `POST /kanban/plans` | returns **201** + assigned `planId`; **409** if slug file exists; **400** path-traversal slug |
  | `plan_delete` | `DELETE /kanban/plans?planId=[&deleteFile=true]` | query params, not body |
  | `plan_set_project` | `PUT /kanban/plans/project` `{planId, project, workspaceRoot?}` | |
  | `plan_set_complexity` | `PUT /kanban/plans/complexity` `{planId, complexity, workspaceRoot?}` | |
  | `card_move` | `POST /kanban/move` `{planId\|sessionId, targetColumn, workspaceRoot?}` | **502** on upstream failure |
  | `features_reconcile` | `POST /kanban/features/reconcile` | + imperative verbs: `/kanban/feature`, `/kanban/feature/assign`, `/kanban/feature/remove`, `/kanban/feature/delete`, `/kanban/feature/split`, `/kanban/features/assign` |
  | `orchestration_dispatch` | `POST /kanban/orchestration/dispatch` `{featurePlanId, workspaceRoot}` | **path is `/kanban/orchestration/dispatch`**, not `/orchestration/dispatch` |
  | `worktree_list` | `GET /worktree/list` | |
  | `worktree_cleanup` | `POST /worktree/cleanup` `{worktreeId\|branch, workspaceRoot?}` | **502** on upstream failure |
  | `clickup_request` / `linear_request` | `POST /api/clickup` / `POST /api/linear` | raw proxy, tokens stay server-side |
  | `catalog_read` | `GET /catalog` | auth-gated; `{success,data}` with `apiEndpoints[]` |
  | `switchboard_request` | generic `{method, path, body?, workspaceRoot?}` | long tail + future endpoints; optionally validate `path` against `catalog.apiEndpoints[]` |

  Read endpoints unwrap `.data`; mutations return `{success, ...fields}` verbatim.
- **Edge cases:** VS Code not running → structured "not running" error, process stays alive, retry next call; never `process.exit` on a backend failure.

### `src/mcp/package.json` (new) + `tsconfig.mcp.json` (new)
- **Context/Logic:** Own package manifest declaring `@modelcontextprotocol/sdk` as a runtime dep, `bin` mapping (`switchboard-mcp` → the built entry), `"type": "module"`, `engines.node >=18` (SDK requires ≥18; align to ≥22 if converging with the npx spine), and a `files` allowlist. `tsconfig.mcp.json` extends the base with `noEmit:false` + `outDir` (mirrors the existing `tsconfig.test.json` precedent) or is replaced by a self-contained bundle step.
- **Edge cases:** Because the vsix excludes `node_modules/**`, this package is **not** shipped inside the vsix — it is provisioned by `npx`/install (own node_modules) or self-bundled. Keep the extension's webpack output byte-stable.

### `.mcpb` manifest + `claude_desktop_config.json` example (docs/new)
- **Context/Logic:** `.mcpb` manifest (name **`switchboard-mcp`**, entrypoint, config prompts for `workspaceRoot` and optional token) for one-click Desktop install; a documented `claude_desktop_config.json` `mcpServers` snippet (`command`/`args`/`env`) for manual/other-host setup.
- **Edge cases:** Server key/name must be `switchboard-mcp` (never `switchboard`) to dodge the config scrubber on non-Desktop hosts.

### `src/services/SetupPanelProvider.ts` + `src/webview/setup.html` + `switchboard.connectClaudeDesktop` command (new — discovery surface)
- **Context:** The only surface that lets the existing VS Code user base *discover* the bridge. Precedent: the removed MCP server had install buttons in `setup.html` and a `connectMcp` command that wrote host MCP configs (commits 31c3937 / 76780bd).
- **Logic:** Register a `switchboard.connectClaudeDesktop` command (`contributes.commands` in `package.json` + handler in `extension.ts`), invoked by a "Connect Claude Desktop" button added to the Setup panel. The handler resolves Desktop's per-OS config path, reads-or-creates the JSON, and **idempotently merges** the `mcpServers["switchboard-mcp"]` entry.
- **Implementation:**
  - Entry written: `{ "command": "npx", "args": ["-y", "@switchboard/mcp"], "env": { "SWITCHBOARD_WORKSPACE_ROOT": "<resolved root>" } }` — root pre-filled from the extension's known workspace. (`.mcpb` is the alternative install; expose a "Reveal .mcpb" action alongside.)
  - Per-OS path: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`; skip/inform on unsupported platforms.
  - Preserve all other `mcpServers` and unknown top-level keys; write pretty-printed JSON + trailing newline (match the codebase's existing host-config write style).
  - Post-write: info message with a "restart Claude Desktop" nudge.
- **Edge Cases:** Multi-root workspace → one entry per root under distinct keys (`switchboard-mcp-<slug>`), never a single ambiguous entry. Config file missing → create with just our entry. Config file corrupt/unparseable → do not destroy it; surface an error and offer the manual snippet. No confirm gate (project rule) — the button acts immediately and is reversible by re-running/removing the entry.

### `src/services/ClaudeCodeMirrorService.ts` (conditional)
- **Context/Logic:** *Only if* an `.agents/skills/switchboard-mcp/SKILL.md` is shipped for filesystem hosts — add a `MIRROR_MANIFEST` entry (directory-form skill; the dynamic scan won't auto-pick a directory). Not needed for the Desktop path.

### `AGENTS.md` / `CLAUDE.md` / `switchboard-manage` (docs)
- **Context/Logic:** Add the MCP host row to the host tables; note in `switchboard-manage` that "Desktop reaches this surface via the MCP server, not shell." No behavioural code change.

## Verification Plan

### Manual (integration — inherently manual; Desktop + stdio can't be driven by unit tests)
- **Discovery/onboarding flow:** in the Setup panel, click **Connect Claude Desktop** → the command writes an idempotent `mcpServers["switchboard-mcp"]` entry into `claude_desktop_config.json` with the correct pre-filled `SWITCHBOARD_WORKSPACE_ROOT`, without disturbing other MCP servers already present; re-running is a no-op / clean overwrite of only our key. On a multi-root workspace, one distinctly-keyed entry per root is written. Corrupt config → clear error, no data loss.
- Install the `.mcpb` (or add the `claude_desktop_config.json` snippet — or use the Connect button above), open a Switchboard workspace in VS Code, minimise it. In Claude Desktop (after restart): the `switchboard_*` tools appear; `board_read` returns the live board; `plan_create` / `card_move` / `features_reconcile` / `orchestration_dispatch` each take effect on the board — all with VS Code minimised.
- **Persona check (the goal-vs-appearance guard):** on entry the agent reports board state and waits; no eager grouping/dispatch; never emits a confirm gate; never asks about project pinning — confirming the console discipline actually reached Desktop's model via the **tool descriptions** (Desktop ignores `instructions`), and that invoking the `switchboard_console` prompt loads the full persona. Best-effort on Desktop by design — verify the mutating-tool descriptions alone produce acceptable behaviour without the prompt.
- With VS Code **closed**, every tool call returns the structured "not running" error and the MCP process stays alive; reopening VS Code restores function without restarting Desktop's subprocess (port re-read).
- Restart VS Code (new `listen(0)` port) mid-session → next tool call succeeds against the new port.
- **Scrubber regression:** register the npx bin under `switchboard-mcp` in `.cursor/mcp.json`, reload the VS Code window, confirm the entry survives (a `switchboard`-keyed entry would be deleted — the negative control).

### Automated Tests
- Unit-test the **pure bootstrap helpers** in isolation (no Desktop, no VS Code): `resolveWorkspaceRoot()` precedence (arg > env > config); `readPort()` missing-file → structured error and no caching; `call()` **status→result mapping** across 200/201/204/400/401/404/409/413/500/502/503 and the `{error}`/`{error,detail}` body shapes; bearer-header added only when a token is configured.
- A lightweight **contract check** that every curated tool's path/method is present in `protocol-catalog.json`'s `apiEndpoints[]` (guards against endpoint drift), analogous to the repo's existing `catalog:check`/`parity:check` gates.
- (Per session directive, no compile/test run is performed as part of *this planning pass*; the above defines the coder's target coverage.)

## Research Findings (resolved — web research run 2026-07)

The external/host-behaviour uncertainties were confirmed by web research. Build on these as facts; only item 4's exact schema idiom remains a local-verify step.

1. **Bundle format — `.mcpb` ("MCP Bundle").** Renamed from the earlier `.dxt` ("Desktop Extension") and moved under the MCP project. A `.mcpb` is a ZIP of `manifest.json` + the server + deps. Current `manifest_version: "0.3"`. It **does** support user-facing config: a `user_config` block (typed fields, `required`, `sensitive` for masked secrets) rendered as an install-time form, with values injected into the subprocess via `${user_config.<key>}` templating inside `server.mcp_config.env` (and `${__dirname}` for the entry path). → Use `user_config` for `workspace_path` (required) and `api_token` (optional, `sensitive: true`).
2. **`claude_desktop_config.json`** — confirmed shape: `mcpServers.<key> = { command, args[], env{} }`; env vars are plain key/value strings in `env`, passed to the spawned stdio child. macOS path `~/Library/Application Support/Claude/claude_desktop_config.json`.
3. **Persona channel — confirmed the key correction.** Claude Desktop **does not surface an MCP server's `instructions`** to the model, and **prompts appear only as explicit user-invoked slash commands** — not passive context. (Claude Code *does* honor `instructions`.) → Console discipline for Desktop lives in **tool descriptions**; `switchboard_console` prompt is opt-in; `instructions` set for clients that honor it; full fidelity may need the user's Project/profile custom instructions. (Folded into Scope / Complexity Audit / Adversarial Synthesis above.)
4. **SDK v1.x construction** — `new McpServer({name, version}, { instructions })`; `server.registerTool(name, { description, inputSchema }, cb)`; `server.registerPrompt(name, { description, argsSchema }, cb)`; `new StdioServerTransport()` + `await server.connect(transport)`. Log diagnostics to **stderr only** (stdout is reserved for JSON-RPC). **Local-verify (residual):** pin the exact `inputSchema` idiom to the installed **v1.25.3** — recent SDKs expect a **Zod raw shape** (`inputSchema: { folderName: z.string() }`) rather than a wrapped `z.object({...})`; confirm against `node_modules/@modelcontextprotocol/sdk` before writing tools.

---

**Recommendation:** Complexity 7 → **Send to Lead Coder.**
