---
description: "Feature A (Remote Control), subtask A2b: mechanically extract all 706 provider handler case arms into host-agnostic service methods behind A2a's seam interfaces, expose every catalogued verb over HTTP/WS, audit the 988 push sites through the broadcast abstraction, and gate parity in CI. Rides on A2a's infrastructure."
---

# Feature A · A2b — Per-Verb Handler Burn-Down (All Panels)

## Goal

Mechanically extract all **706 handler `case` arms** out of the five Provider files into shared host-agnostic service methods behind A2a's seam interfaces, expose every catalogued verb over HTTP (request/response) + WebSocket (host→UI push), audit the 988 push sites through A2a's broadcast abstraction, and gate parity in CI. This is the mechanical grind — A2a built the rails, A2b runs the train. Runs **inside the running extension** — the extension's providers become thin `postMessage`→service adapters calling the same extracted methods the API serves; VS Code stays the engine, minimised.

**Context:** Split 2026-07-08 from A2 during improve-feature. A2 bundled infrastructure + burn-down — two distinct units with a clean prerequisite line. A2a built wsHub + auth + seams + broadcast abstraction. A2b uses them mechanically. Parent hard constraint applies with maximum force: every handler-body lift changes code the shipped extension (~4,000 installs) runs. The contract surface (2026-07-07): 432 verbs, 706 arms, 988 push sites, 575 UI call sites.

## Metadata
- **Plan ID:** c05762a3-8aef-4502-9b91-f72c2a2b2b81
- **Feature:** 511977b8-6f6d-41ec-b1a2-00e959f03ef1
- **Tags:** refactor, backend, api
- **Complexity:** 8
- **Release phase:** Near-term / extension-as-engine (Feature A). Depends on A1's catalog + A2a's infrastructure. The long pole — 706 arms across 5 providers.

## User Review Required
- None — panel sequencing and full-parity requirement fixed in the parent plan's review.

## Scope

### ✅ IN SCOPE
- **Handler extraction, all 706 arms:** each `case` arm's body moves to a shared host-agnostic service module; the arm becomes `case 'verb': return svc.verb(payload)`. Burn-down order: **kanban → planning → project → design/Stitch → setup → TaskViewer/sidebar**, driven by A1's `protocol-catalog.json`.
- **Endpoint per verb:** HTTP route (request/response verbs) or WS push (broadcast verbs) added to `LocalApiServer` for every catalogued verb, via its injected-callback pattern. A2a's auth + wsHub are already in place.
- **Push-site audit:** the 988 `webview.postMessage` push sites route through A2a's broadcast abstraction (webview + wsHub); ordering preserved per connection via wsHub sequence numbers.
- **Catalog-driven parity gate in CI:** every catalogued verb must have a live endpoint; a missing verb fails the build.

### ⚙️ OUT OF SCOPE
- **Transport infrastructure (wsHub, auth, seams, broadcast abstraction, ws dep)** → **A2a** (`aaeafbeb-...`).
- **Transport shim** (running the real webview UI in a browser) → **B2**.
- `node-pty` `TerminalBackend` implementation + xterm browser grid → **B3**.
- Standalone composition root / keyring / config-file / Memento→config → **B1**. npx packaging → **B4**.

## Implementation Steps
1. **Kanban panel burn-down** (168 arms) — extract arm body → service method → seam-inject (using A2a's seams) → HTTP/WS endpoint → parity-test row, per verb. Establish the mechanical per-verb recipe.
2. **Planning panel** (168 arms) — repeat the recipe.
3. **Project → design/Stitch (62) → setup (117) → TaskViewer/sidebar (191)** — repeat; catalog burned to zero.
4. **Push-site audit** — the 988 sites route through A2a's broadcast abstraction (webview + wsHub); ordering preserved per connection.
5. **Parity gate** — CI: catalogued verbs ⊆ live endpoints. Missing verb → build fails with the verb name.

## Complexity Audit
### Routine
- The per-verb recipe once proven on kanban: mechanical, catalog-driven, patterned. Extract → service method → endpoint → parity-test row. Repeat 706 times.
- Adding route arms to the `_handleRequest` if-else chain — same pattern as existing routes.
### Complex / Risky
- **Silent extension behavior change** — 706 lifts, each touching shipped code; reply timing, error shapes, ack semantics must be byte-compatible. The catalog gate + per-verb parity rows are the tripwire; provider tests must pass unchanged per-provider.
- **Push fidelity at 988 sites** — missing/mis-ordered pushes = a subtly stale board (worst historical bug class); A2a's resync-on-reconnect is the backstop, per-connection ordering the contract.
- **Seam discovery during burn-down** — if A2a missed a vscode-coupling surface, A2b encounters it mid-extraction. The seam set may need to grow. Stop, add the seam to A2a's set, then continue.
- **Terminal-seam boundary** — migrating terminal-control verbs against A2a's vscode adapter is fine; do NOT let any verb assume readable terminal output (that arrives only with B3's node-pty backend).

## Edge-Case & Dependency Audit
- **Race:** push during WS reconnect → covered by A2a's full resync on connect. Two browser tabs → both get full fan-out; last-writer-wins (same as two webview panels today).
- **Side effects:** provider files shrink to thin adapters — keep message names/casing byte-identical (tests/tooling grep for them).
- **Dependencies:** **A1** (`eb75281d-...`) — catalog is the burn-down checklist + parity gate fixture. **A2a** (`aaeafbeb-...`) — wsHub + auth + seams + broadcast abstraction must be in place before any handler extraction begins. Does NOT depend on B1.

## Dependencies
- **A1** (`eb75281d-d8f3-4e50-b396-f7626abed020`) — protocol catalog is the burn-down checklist. Every catalogued verb must be extracted + have an endpoint.
- **A2a** (`aaeafbeb-f4f0-40b4-a335-53e69febc8f7`) — transport infrastructure (wsHub, auth, seams, broadcast abstraction, `ws` dep). A2b cannot start until A2a lands.
- Does NOT depend on B1's standalone bootstrap. Coordinates the WS envelope with B3 (terminal streams ride wsHub).

## Adversarial Synthesis

Key risks: (1) **706 silent behavior changes** — each arm lift touches shipped code that 4,000 installs run; reply timing, error shapes, ack semantics must be byte-compatible. The per-verb parity-test row + provider tests passing unchanged per-provider are the tripwire. (2) **Push-site audit scale** — 988 sites is the worst historical bug class (stale boards); A2a's resync-on-reconnect is the backstop but every site must route through the broadcast abstraction, not just the obvious ones. (3) **Seam gaps** — if A2a missed a vscode-coupling surface, A2b stalls mid-burn-down. Mitigation: stop and add the seam to A2a's set, then resume — don't hack around it. Mitigations: per-verb parity rows + byte-compatibility tests; exhaustive push-site audit driven by A1's catalog; seam-growth protocol (stop, add, resume).

## Proposed Changes

### `src/services/{Kanban,Planning,Setup,Design,TaskViewer}Provider.ts`
- **Context:** 706 handler `case` arms across 5 providers. Each arm body contains vscode-coupled calls. Representative examples: `KanbanProvider.ts:6393` (`selectPlan` — internal service call), `:6400` (`openPlanByPath` — `vscode.window.showWarningMessage`, `vscode.workspace.openTextDocument`, `vscode.window.showTextDocument`, `fs`), `:6424` (`refresh` — `vscode.commands.executeCommand`), `:6613` (`addProject` — `this._panel?.webview.postMessage`). A2a's seams (`HostPathConfigProvider`, `TerminalBackend`, `HostCommands`, `HostUI`, `HostEditor`) are in place.
- **Logic:** Each arm body moves to a shared host-agnostic service module; the arm becomes `case 'verb': return svc.verb(payload)`. Burn-down order: kanban (168) → planning (168) → project → design/Stitch (62) → setup (117) → TaskViewer/sidebar (191), driven by A1's `protocol-catalog.json`.
- **Implementation:** Per-verb: (1) extract arm body into a service method, (2) identify vscode-coupled calls in the body, (3) route each through the appropriate A2a seam, (4) if a NEW coupling surface is found (not in A2a's seam set), stop and add it to A2a, (5) the arm becomes a thin `postMessage`→service adapter, (6) add the HTTP/WS endpoint, (7) add a parity-test row. Follow the existing `RemoteProvider` interface pattern (`src/services/remote/RemoteProvider.ts:107-182`) and `PlanningPanelAdapterFactories` pattern (`PlanningPanelProvider.ts:41-49`).
- **Edge cases:** Silent extension behavior change — 706 lifts, each touching shipped code. Reply timing, error shapes, ack semantics must be byte-compatible. The catalog gate + per-verb parity rows are the tripwire; provider tests must pass unchanged per-provider. Provider files shrink to thin adapters — keep message names/casing byte-identical (tests/tooling grep for them).

### `src/services/LocalApiServer.ts`
- **Context:** A2a already added `wsHub` to options + rewrote `_checkAuth`. Route dispatch is a sequential `if/else if` chain in `_handleRequest` (lines 1889-1980). A2a's auth + wsHub are in place.
- **Logic:** For each catalogued verb: add HTTP route arm (request/response verbs) or WS broadcast registration (broadcast verbs) via the injected-callback pattern, mirroring `orchestrationDispatch` (lines 791-839, route at 1925-1926). Every endpoint validates payload shape — webview-trusted `postMessage` input becomes untrusted network input.
- **Implementation:** Per-verb route arm: parse body, validate shape (typeof checks, required fields), call the injected callback, return `{ success, data }` or `{ error }`. For broadcast verbs: the service method calls `wsHub.broadcast(verb, payload)` AND `webview.postMessage(payload)` (dual fan-out via A2a's broadcast abstraction).
- **Edge cases:** Untrusted payloads from network — every endpoint must validate shape before calling the service method. Reply timing/error shapes must be byte-compatible with the webview's expectations. A missing verb in the route chain → CI parity gate fails the build.

### `src/webview/*` (push-site audit)
- **Context:** 988 host→webview push sites across the 5 providers. A2a's broadcast abstraction is in place.
- **Logic:** Route every `webview.postMessage({ type: '...' })` push site through A2a's broadcast abstraction (webview `postMessage` + `wsHub.broadcast`). Ordering preserved per connection via wsHub sequence numbers.
- **Implementation:** Audit each push site. Replace direct `this._panel?.webview.postMessage(payload)` calls with `this._broadcast(payload)` (A2a's abstraction). The abstraction dual-fans to webview + wsHub.
- **Edge cases:** Missing/mis-ordered pushes = a subtly stale board (worst historical bug class). A2a's resync-on-reconnect is the backstop. Every push site must be audited — missing one means that verb's push doesn't reach WS clients.

### `.github/workflows/integration-tests.yml`
- **Context:** A1 already added the catalog drift check. CI runs `npm ci` → `npm run compile-tests` → `npm run compile` → `npm run test:integration:all`.
- **Logic:** Add a "Protocol parity gate" step after A1's drift check: load `protocol-catalog.json`, enumerate live HTTP/WS endpoints, assert every catalogued verb has a live endpoint. Missing verb → build fails with the verb name.
- **Implementation:** New step in the `integration-tests` job. The parity gate script (`scripts/check-protocol-parity.js`) reads the catalog and checks endpoint coverage. Builds on A1's drift check.
- **Edge cases:** Broadcast verbs (host→UI push) don't have HTTP routes — they're WS-only. The parity gate must distinguish request/response verbs (HTTP route required) from broadcast verbs (WS registration required).

## Verification Plan
### Automated Tests
- Skipped per session directive — no automated test run required. The CI parity gate (catalogued verbs ⊆ live endpoints) serves as the automated gate when implemented.
### Manual Verification
- **Catalog parity gate (CI):** every catalogued verb has a live endpoint; failures name the missing verb.
- Existing provider tests pass unchanged after each provider's burn-down (run per-provider, not batched).
- **Push fidelity:** kill WS mid-session → reconnect → A2a's resync delivers full state, no stale cards. Two browser tabs → both get full fan-out. Sequence numbers monotonic per connection.
- Manual: full board driven from a localhost HTTP/WS client (plan moves, feature ops, planning/design/setup verbs) with VS Code minimised; verify reply timing, error shapes, ack semantics are byte-compatible with the webview's expectations.

**Stage Complete:** PLAN REVIEWED
