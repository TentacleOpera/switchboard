# Switchboard Remote-Control API

**Complexity:** 8

## Goal

The Switchboard Remote-Control API turns the VS Code extension into a host-agnostic execution engine: external clients (conversational agents, custom boards, CI) discover and drive the full board surface over localhost HTTP/WebSocket without the webview. This solves the problem that Switchboard today is reachable only through its VS Code webview — third-party agent hosts (Claude Code, Codex, Zed, Antigravity) and external UIs cannot drive the board, manage features, or dispatch coding without a human clicking in VS Code. These plans are grouped because they form one coherent delivery: the protocol catalog (A1) is the fixture the transport infrastructure (A2a) and per-verb burn-down (A2b) build on, the declarative feature API (A3) makes feature reorganization usable by agents, and the management console skill (Manage) is the human-facing entry point that consumes all three.

## How the Subtasks Achieve This

- **A1 — Protocol Catalog + Discovery Endpoint**: Builds the machine-readable catalog of the full webview↔host message contract (432 verbs, 706 arms across 5 providers, 988 push sites, 575 UI call sites) and serves it as `GET /catalog` on the LocalApiServer. This is the foundational fixture A2b burns down against and the CI parity gate checks; it is also the discoverability layer the Manage skill and external clients use to self-enumerate the surface without reading skill docs.
- **A2a — Transport Infrastructure: wsHub, Auth, Seams**: Builds the transport rails that A2b's per-verb burn-down rides on — a token-gated `wsHub` with per-connection ordered push and full-state resync, real auth on `LocalApiServer` (replacing the current no-op `_checkAuth`), seam interfaces for all 6 vscode-coupled surfaces the handler extraction will encounter, the broadcast abstraction that dual-fans push sites to webview + WS, and the `ws` npm dependency. No handler extraction happens here — this is infrastructure only.
- **A2b — Per-Verb Handler Burn-Down (All Panels)**: Mechanically extracts all 706 provider handler `case` arms into host-agnostic service methods behind A2a's seam interfaces, exposes every catalogued verb over HTTP (request/response) + WebSocket (host→UI push), audits the 988 push sites through A2a's broadcast abstraction, and gates parity in CI. This is the long pole — the mechanical grind that makes the extension a real remote-control engine rather than a webview-only tool.
- **Switchboard Manage — Host-Agnostic Management Console Skill**: Adds `/switchboard-manage`, a conversational management console skill for driving Switchboard from any agentic host with VS Code minimised. Repoints the human `/switchboard-orchestrator` mirror to this consultative persona (closing the footgun where a human slash command launches unattended automation), adds `POST /orchestration/start` and `POST /orchestration/stop` endpoints, and documents the HTTP surface by reference to the `switchboard-orchestration` skill. Consumes A1's `GET /catalog` for self-discovery and A3's reconcile for feature management.
- **A3 — Declarative, Path-Addressed Feature Management**: Replaces UUID-choreography feature ops with path/slug-addressed, declarative `POST /kanban/features/reconcile` — one idempotent, atomic call that converges the whole feature structure (create/assign/remove/move + inline plan-splitting). Rewrites the existing feature scripts/skills around the new model, adds public wrappers for the currently-private remove/delete methods, and fixes stdout hygiene so `get-state.js | jq` works. This is the feature-management UX that makes `/switchboard-manage` usable for reorganizing features from outside the webview.

## Dependencies & sequencing

- **Cross-feature dependencies:** None — all subtasks are self-contained within Feature A. No other feature must land first.
- **Shipping order within this feature:**
  1. **A1 first** — the protocol catalog is A2a's seam inventory + A2b's burn-down fixture + CI parity gate, and Manage's discoverability layer. Everything depends on it.
  2. **A2a second** — transport infrastructure. Depends on A1's catalog (seam inventory). Must build real token validation (current `_checkAuth` is a no-op) + `wsHub` + all 6 seams + broadcast abstraction. `ws` dependency added here (net-new to the published extension).
  3. **A2b, A3, and Manage all parallelize after A2a** — A2b is the 706-arm mechanical burn-down (depends on A2a's infrastructure + A1's catalog); A3 is feature-structure verbs (independent of the transport surface); Manage is the skill + `POST /orchestration/start|stop` endpoints (independent of A2's transport work). Manage references A1's `GET /catalog` (A1 owns the route) and A3's reconcile (A3 owns the endpoint); both are consumed by reference, not blocking.
- **Prerequisites / guards:**
  - `ws` npm dependency must be added in A2a before any wsHub work begins.
  - A2a must build real token validation + Origin checking before any WS endpoint goes live (current auth is a no-op — local RCE risk once terminal streams ride the hub).
  - A2b cannot start until A2a lands (wsHub, auth, seams, broadcast abstraction must be in place).
  - A3 must add public wrappers for the underscore-prefixed `_removeSubtaskFromFeature` / `_deleteFeature` methods before reconcile can call them from an HTTP handler.
  - A3's reconcile must wrap DB operations in a single transaction (`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`) — the existing feature primitives are NOT atomic individually.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [x] [Feature A · A1 — Protocol Catalog + Discovery Endpoint](../plans/extract-standalone-npx-01-protocol-core.md) — **DONE** (commit 8c8a845)
- [x] [Feature A · A2a — Transport Infrastructure: wsHub, Auth, Seams](../plans/extract-standalone-npx-03-transport-migration.md) — **DONE** (commits b06f3be + 4ede350)
- [ ] [Switchboard Manage — Host-Agnostic Management Console Skill](../plans/switchboard-manage-console-skill.md) — **LEAD CODED**
- [ ] [Feature A · A3 — Declarative, Path-Addressed Feature Management](../plans/feature-management-declarative-path-addressed.md) — **LEAD CODED**
- [ ] [Feature A · A2b — Per-Verb Handler Burn-Down (All Panels)](../plans/transport-migration-per-verb-burndown.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Implementation Progress (session 2026-07-08)

### ✅ A1 — Protocol Catalog + Discovery Endpoint (DONE)
- `scripts/generate-protocol-catalog.js`: scanner with brace-depth tracking to count only message-handler `case` arms (not unrelated switches). Emits `protocol-catalog.json` at repo root.
- `protocol-catalog.json` checked in: **606 arms, 518 verbs, 598 push sites, 39 existing API endpoints, 1 manual-review item** (genuine dynamic `removeType` variable in `planning.js:2931`).
- `GET /catalog` route on `LocalApiServer` via `_handleGetCatalog` using `_handleReadEndpoint` helper. `catalogProvider` callback in `LocalApiServerOptions`; wired in `TaskViewerProvider`.
- CI drift check step added to `.github/workflows/integration-tests.yml`.
- npm scripts: `catalog:generate`, `catalog:check`.
- **Note:** scanner counts differ from plan's 706/432/988/575 — my scanner is stricter (brace-depth isolates the message-handler switch only; the plan's counts likely included unrelated `switch` statements). The 1 manual-review item is a genuine dynamic type that A2b must handle explicitly.

### ✅ A2a — Transport Infrastructure (DONE)
- `ws` 8.21.0 + `@types/ws` 8.5.13 pinned in `package.json` (exact versions, not floating).
- `src/services/wsHub.ts`: token-gated WS upgrade (Origin + `?token=` validation before `handleUpgrade`), per-connection monotonic sequence numbers, full-state resync on connect, `broadcast(verb, payload)`. **Already committed in b06f3be** (parallel work — identical content).
- `_checkAuth` rewrite: validates `Authorization: Bearer <token>` when header present (constant-time compare), falls through to localhost-only trust when absent (preserves backward compat). **Already in b06f3be.**
- `src/services/hostSeams.ts` (commit 4ede350): 5 seam interfaces + vscode-backed implementations — `HostPathConfigProvider`, `TerminalBackend`, `HostCommands`, `HostUI`, `HostEditor`. `createVscodeHostSeams(workspaceRoot)` bundle for A2b injection.
- `src/services/broadcastHub.ts` (commit 4ede350): dual-fan-out abstraction — `push(msg)` sends to webview `postMessage` (with `_pendingWebviewMessages` queue) AND `wsHub.broadcast`. `pushWebviewOnly()` for webview-internal messages. This is the rail A2b's 988 push-site audit routes through.
- `getFullState` callback wired in `TaskViewerProvider` — returns current board snapshot for WS resync-on-reconnect.

### ⏳ Remaining subtasks (next session)

#### A3 — Declarative, Path-Addressed Feature Management
Plan: `.switchboard/plans/feature-management-declarative-path-addressed.md`
1. **Path/slug resolver** in `KanbanProvider`/`KanbanDatabase` — resolve `path|slug|planId` → planId (reuse `getPlanByPlanFile` at `KanbanDatabase.ts:3420`).
2. **`reconcile` service method** — diff desired-vs-current, apply create/assign/remove/move atomically in a single `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` transaction. Handle inline new-plan creation (write file → import → link).
3. **`POST /kanban/features/reconcile`** route + `LocalApiServer` option; wire in `TaskViewerProvider`.
4. **Public wrappers** for `_removeSubtaskFromFeature` (`KanbanProvider.ts:10339`) and `_deleteFeature` (`:10385`) — currently private, reconcile needs them.
5. **Revise scripts/skills** — verb scripts accept path/slug; rewrite `create_feature.md` and `group-into-features` around reconcile.
6. **Fix stdout hygiene** — move `[KanbanDatabase] Resolved DB path…` log (`KanbanDatabase.ts:902`) from stdout to stderr so `node get-state.js | jq` works.
7. **Dispatch ID injection** — every prompt-building path stamps `PLAN_ID=<real DB id>` + plan file path into agent prompts.
8. **Cheatsheet** in `kanban_operations/SKILL.md`.

#### Switchboard Manage — Host-Agnostic Management Console Skill
Plan: `.switchboard/plans/switchboard-manage-console-skill.md`
1. `LocalApiServer`: add `orchestrationStart`, `orchestrationStop` callbacks to options type; add `_handleOrchestrationStart` + `_handleOrchestrationStop` route arms mirroring `_handleOrchestrationDispatch` (`:791-839`).
2. Provider wiring: pass `orchestrationStart: (root) => this.startOrchestratorFromKanban(root)` and `orchestrationStop: () => this.stopOrchestratorFromKanban()`. Both methods already `public` (`:7579` and `:7769`).
3. Author `.agents/skills/switchboard-manage/SKILL.md` (persona + HTTP surface by reference to `switchboard-orchestration` skill + hard rules).
4. `ClaudeCodeMirrorService` `MIRROR_MANIFEST`: repoint `/switchboard-orchestrator` human command → `switchboard-manage`. Remove automation persona from human-invocable commands.
5. Reference A1's `GET /catalog` (already done) and A3's reconcile (must land first or skill falls back to existing verb scripts).

#### A2b — Per-Verb Handler Burn-Down (LONG POLE — 706 arms)
Plan: `.switchboard/plans/transport-migration-per-verb-burndown.md`
- **This is the mechanical grind.** 606 arms across 5 providers (per A1's catalog: Kanban 144, Planning 173, Design 62, TaskViewer 110, Setup 117).
- Burn-down order: **kanban → planning → project → design/Stitch → setup → TaskViewer/sidebar**.
- Per-verb recipe: (1) extract arm body into service method, (2) route vscode-coupled calls through A2a's seams, (3) arm becomes `case 'verb': return svc.verb(payload)`, (4) add HTTP/WS endpoint, (5) add parity-test row.
- Push-site audit: 598 `postMessage` sites route through `BroadcastHub.push()`.
- CI parity gate: catalogued verbs ⊆ live endpoints; missing verb fails build.
- **Honest ceiling:** this is NOT one-session work. Establish the recipe on the kanban panel first, then burn down as many arms as feasible per session.

### Suggested next-session sequencing
1. **A3 first** (independent of transport, unblocks Manage's feature-mgmt UX).
2. **Manage second** (consumes A1's `/catalog` ✅ + A3's reconcile).
3. **A2b last** (long pole — start with kanban panel recipe, then mechanical burn-down).

