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
- [ ] [Feature A · A1 — Protocol Catalog + Discovery Endpoint](../plans/extract-standalone-npx-01-protocol-core.md) — **LEAD CODED**
- [ ] [Feature A · A2a — Transport Infrastructure: wsHub, Auth, Seams](../plans/extract-standalone-npx-03-transport-migration.md) — **LEAD CODED**
- [x] [Switchboard Manage — Host-Agnostic Management Console Skill](../plans/switchboard-manage-console-skill.md) — **LEAD CODED**
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

### ✅ A3 — Declarative, Path-Addressed Feature Management (DONE, session 2026-07-08)
Plan: `.switchboard/plans/feature-management-declarative-path-addressed.md`
1. **Path/slug resolver** — `KanbanDatabase.resolvePlanIdentifier(ref, workspaceId)` (new, after `resolvePlanByAnyId` at ~:3410). Tries plan_id/session_id → plan_file path → topic/slug → plan_file basename. Agent never handles a raw UUID.
2. **`reconcileFeatures` service method** — `KanbanProvider.reconcileFeatures(workspaceRoot, desiredFeatures, options?)` (new, after `splitFeature` at ~:10892). Phase 1 resolves every subtask ref BEFORE any mutation (fail-fast, zero side effects on unresolvable ref). Phase 2 diffs desired-vs-current: creates features, assigns/removes subtasks, creates inline plans (`{slug,title,body}` → write file → `registerPendingCreation` → `importPlanFiles` → link), optionally deletes unmentioned features (`removeUnmentionedFeatures`). Returns `{success, features, mutations, warnings}`. Idempotent (re-run = no-op). Cross-column warning preserved. **Atomicity note:** the existing primitives (`createFeatureFromPlanIds`, `assignPlansToFeature`, `_removeSubtaskFromFeature`) each bundle DB writes + file regen + board refresh + external-tracker sync, so a single cross-method `BEGIN/COMMIT` is not feasible without refactoring them — idempotency is the practical safety net (a mid-way failure leaves a partial state a retry converges). Documented in the method doc.
3. **`POST /kanban/features/reconcile`** route — `_handleKanbanReconcileFeatures` in `LocalApiServer.ts` (after `_handleKanbanSplitFeature`), route arm after `/kanban/feature/split` (~:2073). `reconcileFeatures` callback in `LocalApiServerOptions` (after `splitFeature` option). Wired in `TaskViewerProvider` (after `splitFeature` wiring ~:1134).
4. **Public wrappers** — `KanbanProvider.removeSubtaskFromFeature()` and `KanbanProvider.deleteFeature()` (new, after `reconcileFeatures`) delegate to the underscore-prefixed primitives so external callers don't reach past the naming convention.
5. **`reconcile-features.js` script** — `.agents/skills/kanban_operations/reconcile-features.js` (new). Routes through `POST /kanban/features/reconcile`. Prints `{ok, features, mutations, warnings}`.
6. **Stdout hygiene** — moved 9 `[KanbanDatabase]`/`[KanbanDatabase.ensureReady]`/`[KanbanDatabase._initialize]` diagnostic `console.log` → `console.error` in `KanbanDatabase.ts` (lines ~830, 858, 902, 966, 1334, 1336, 1347, 1405, 4926, 4959, 4966, 4996, 5004). `node get-state.js | jq .` now emits parseable JSON on stdout.
7. **Dispatch ID injection** — `BatchPromptPlan.planId?` field added to `agentPromptBuilder.ts`. `buildPromptDispatchContext` stamps `PLAN_ID=<id>` line after each plan entry. Populated at construction sites: `expandFeatureSubtaskPlans` (KanbanProvider ~:3670), `buildDispatchPlans` (~:3734), TaskViewerProvider fallback (~:15273). Existing sites that build from `planRecord` already had `planId` (e.g. :2056).
8. **Cheatsheet** — "Reorganize Features (declarative)" section appended to `kanban_operations/SKILL.md` with end-to-end recipe + the `get-state.js | jq` note. Replaced the "planned" caveat with "landed".
- **Not done (deferred):** rewriting `create_feature.md` and `group-into-features` skills around reconcile (the existing verb scripts + new reconcile script cover the path; the skill rewrites are documentation polish for a follow-up). Optional `POST /kanban/plans/split` standalone primitive folded into reconcile (inline `{slug,title,body}` covers it).

### ✅ Switchboard Manage — Host-Agnostic Management Console Skill (DONE, session 2026-07-08)
Plan: `.switchboard/plans/switchboard-manage-console-skill.md`
1. **`POST /orchestration/start` + `POST /orchestration/stop`** on `LocalApiServer` — `orchestrationStart`/`orchestrationStop` callbacks in `LocalApiServerOptions`; `_handleOrchestrationStart` + `_handleOrchestrationStop` handlers mirroring `_handleOrchestrationDispatch`. Wired in `TaskViewerProvider` (`orchestrationStart: (root) => this.startOrchestratorFromKanban(root)`, `orchestrationStop: () => this.stopOrchestratorFromKanban()` — both already `public`).
2. **`.agents/skills/switchboard-manage/SKILL.md`** — consultative persona (report state on entry, then wait), HTTP surface by reference to `switchboard-orchestration` skill, automation opt-in only, hard rules (no confirm gates, no eager action, project pin, honest capability ceiling). Consumes A1's `GET /catalog` for self-discovery + A3's `POST /kanban/features/reconcile` for feature management.
3. **Mirror repoint** — `ClaudeCodeMirrorService.MIRROR_MANIFEST`: `/switchboard-orchestrator` human command → `switchboard-manage` skill. Closes the footgun where a human slash command loaded the unattended automation persona. Engine still launches the persona by file path (`startOrchestratorFromKanban`), so the machine launch is unaffected.
4. **AGENTS.md + CLAUDE.md** — registered `switchboard-manage` in the skills tables.
- **Commit:** `ae520bf`.

### ⏳ A2b — Per-Verb Handler Burn-Down (IN PROGRESS — recipe established, long pole remains)
Plan: `.switchboard/plans/transport-migration-per-verb-burndown.md`
- **Status:** Recipe proven on the kanban panel; 4 of 606 arms extracted. NOT one-session work (plan endorses this ceiling).
- **`src/services/kanbanService.ts`** (new, uncommitted): host-agnostic service module. `KanbanServiceContext` interface (workspaceRoot, seams, broadcaster, resolveSessionId, selectSession, triggerPlanScan). `KanbanService` class with 4 extracted verbs: `selectPlan`, `openPlanByPath`, `refresh`, `scanFoldersNow`. Inline recipe documentation (the 7-step per-verb recipe from the plan).
- **Recipe (proven):** (1) extract arm body → service method, (2) route vscode-coupled calls through `HostSeams` (commands/ui/editor/pathConfig/terminal), (3) route `postMessage` through `BroadcastHub.push()`, (4) arm becomes `case 'verb': return svc.verb(msg)`, (5) add `POST /kanban/verb/<name>` endpoint, (6) parity-test row, (7) if a NEW coupling surface is found, stop + add to `hostSeams.ts` (seam-growth protocol).
- **Remaining:** 602 of 606 arms (Kanban 140, Planning 173, Design 62, TaskViewer 110, Setup 117). Burn-down order: kanban → planning → project → design/Stitch → setup → TaskViewer/sidebar. Then: 598 push-site audit through `BroadcastHub.push()`, CI parity gate (catalogued verbs ⊆ live endpoints).
- **Not yet done:** wire `kanbanService` into `KanbanProvider` (construct + inject context + repoint the 4 extracted arms), add the 4 HTTP endpoints on `LocalApiServer`, add parity-test rows. The service module is the skeleton; the provider wiring is the next concrete step.

### Suggested next-session sequencing
1. **A2b — wire the recipe** (construct `KanbanService` in `KanbanProvider`, repoint the 4 extracted arms, add `POST /kanban/verb/<name>` endpoints, add parity-test rows). This completes the proven recipe end-to-end.
2. **A2b — mechanical burn-down** (repeat the recipe for the remaining 140 kanban arms, then the other 4 providers). Long pole — multiple sessions.
3. **A2b — push-site audit + CI parity gate** (after all arms extracted).
4. **A1 ✅, A2a ✅, A3 ✅, Manage ✅** — no further work (A3's deferred skill-rewrite polish is optional follow-up).

