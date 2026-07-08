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
- [ ] [Feature A · A1 — Protocol Catalog + Discovery Endpoint](../plans/extract-standalone-npx-01-protocol-core.md) — **PLAN REVIEWED**
- [ ] [Feature A · A2a — Transport Infrastructure: wsHub, Auth, Seams](../plans/extract-standalone-npx-03-transport-migration.md) — **PLAN REVIEWED**
- [ ] [Switchboard Manage — Host-Agnostic Management Console Skill](../plans/switchboard-manage-console-skill.md) — **PLAN REVIEWED**
- [ ] [Feature A · A3 — Declarative, Path-Addressed Feature Management](../plans/feature-management-declarative-path-addressed.md) — **PLAN REVIEWED**
- [ ] [Feature A · A2b — Per-Verb Handler Burn-Down (All Panels)](../plans/transport-migration-per-verb-burndown.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
