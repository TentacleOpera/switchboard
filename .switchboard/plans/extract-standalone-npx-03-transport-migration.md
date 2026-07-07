---
description: "Standalone npx Switchboard, subtask 3 of 4: lift all 706 provider handler arms into host-agnostic services, add HTTP/WS endpoints per catalogued verb, ship the webview transport shim, and secure the browser origin — full parity across all five panels (Phase 3)"
---

# Standalone Switchboard 3/4 — Handler Extraction + Transport Migration (All Panels)

## Goal

Migrate the full webview↔host contract off VS Code's `postMessage` bridge: lift each of the **706 handler `case` arms** out of the five Provider files into shared host-agnostic service methods, expose each catalogued verb over HTTP (request/response) + WebSocket (host→UI push), and ship a transport shim so the unchanged `src/webview/*` UI runs in both the VS Code webview and the browser. Full parity — **all five panels ship before this subtask is done**; there is no deferred panel.

**Context (parent architecture):** Subtask 3 of the feature decomposing `.switchboard/plans/extract-standalone-npx-browser-service.md` (Plan ID `81299C8F-E2FA-4F93-881D-83231E1798A1`). This is the parent's Phase 3 — the long pole, ≈ half the total effort. The contract surface (measured 2026-07-07): 432 distinct message types, 706 case arms (TaskViewer 191, Kanban 168, Planning 168, Setup 117, Design 62), 988 host→webview push sites, 575 UI `postMessage` call sites. Parent hard constraint applies with maximum force here: every handler-body lift changes code the shipped extension (~4,000 installs) runs — the extension's provider layer becomes a thin `postMessage`→service adapter calling the *same* extracted methods the standalone service serves over HTTP.

## Metadata
- **Plan ID:** aaeafbeb-f4f0-40b4-a335-53e69febc8f7
- **Tags:** refactor, backend, frontend, api, security
- **Complexity:** 9

## User Review Required
- None — panel sequencing and full-parity requirement fixed in the parent plan's review.

## Scope

### ✅ IN SCOPE
- **Handler extraction, all 706 arms:** each `case` arm's body moves to a shared service module; the arm becomes `case 'verb': return svc.verb(payload)`. Provider-by-provider burn-down: **kanban → planning → project → design/Stitch → setup**, driven by subtask 1's `protocol-catalog.json`.
- **Endpoint per verb:** HTTP route (request/response verbs) or WS push (broadcast verbs) added to `LocalApiServer` for every catalogued verb, following its existing injected-callback pattern (`src/services/LocalApiServer.ts:9–80`) rather than run-mode branches inside handlers.
- **`wsHub` (`src/standalone/wsHub.ts`, new):** WS server owning token-gated upgrade, per-connection ordered push queue, and **full-state resync on every (re)connect** — pushes missed while disconnected must not leave a stale board. Also carries subtask 2's terminal streams (envelope agreed with that subtask).
- **Transport shim (`src/webview/transport.js`, new):** API-compatible `acquireVsCodeApi()` surface — in a VS Code webview it wraps the real bridge; in a browser it backs `postMessage` with fetch/WS and `getState`/`setState` with `localStorage`. The **575 UI call sites are untouched**; only each panel's bootstrap loads the shim first.
- **Browser-origin security:** session token gates the WS upgrade handshake itself (query-param or `Sec-WebSocket-Protocol`, validated before upgrade completes — CORS does not govern WebSockets); `Host`/`Origin` validation on every HTTP route; bind stays `127.0.0.1`.
- **Catalog-driven parity test in CI:** every catalogued verb must have a live endpoint and a matching UI call site; a missing verb fails the build.

### ⚙️ OUT OF SCOPE
- PTY pool itself (subtask 2); npx packaging/launcher + one-time-token browser bootstrap (subtask 4 — but the token *validation* server side lands here).

## Implementation Steps

1. **`wsHub` + auth first** — token-gated upgrade, ordered push queue, resync-on-connect, Host/Origin middleware. Everything else hangs off this.
2. **Transport shim** — implement + wire into one panel (kanban) end-to-end as the pattern-proving slice.
3. **Kanban panel burn-down** (168 arms) — extract → endpoint → shim wiring → parity-test row, per verb. Establish the mechanical per-verb recipe here.
4. **Planning (168) → project → design/Stitch (62) → setup (117) → TaskViewer/sidebar (191)** — repeat the recipe; catalog burned down to zero.
5. **Push-site audit** — the 988 host→push sites route through a broadcast abstraction that fans out to webview postMessage (extension) and wsHub (standalone); ordering preserved per connection.
6. **Parity gate** — CI check: catalog verbs ⊆ live endpoints ∧ catalog verbs ⊆ UI call sites.

## Complexity Audit

### Routine
- The per-verb recipe once proven (step 3): mechanical, catalog-driven, highly patterned — the parent plan's compression lever (AI-agent-driven porting can roughly halve this phase).
- Parity-test harness itself.

### Complex / Risky
- **Silent extension behavior change** — the central risk of the whole feature. 706 lifts, each touching shipped code; reply-message timing, error shapes, and ack semantics must be byte-compatible. Existing provider tests cover a fraction of the surface; the catalog gate + per-verb parity rows are the real tripwire.
- **Request/response coupling over two transports** — verbs with paired reply messages must keep identical reply `type:` names and payload shapes in both transports; fire-and-forget verbs must not gain new acks.
- **Push fidelity at 988 sites** — missing or mis-ordered pushes manifest as a subtly stale board (the worst historical bug class in this product); resync-on-reconnect is the backstop, per-connection ordering the contract.
- **WS auth** — an unauthenticated upgrade path is local RCE via subtask 2's terminal streams; DNS rebinding walks past origin assumptions, so token validation at upgrade is non-negotiable.

## Edge-Case & Dependency Audit

### Race Conditions
- Push emitted during WS reconnect window → covered by full resync on connect; no per-message replay queue needed.
- Two browser tabs on one board → both get full push fan-out; last-writer-wins on conflicting mutations (same semantics as two webview panels today — no new arbitration).
- In-extension shim path must remain synchronous-ordered exactly like raw `postMessage` (no microtask reordering introduced by the wrapper).

### Security
- Token at upgrade; `Host`/`Origin` allowlist; `127.0.0.1` bind; no wildcard CORS — the CORS story is deliberately strict-allowlist, not `*`.
- Payload validation at HTTP boundaries (postMessage trusted webview input becomes untrusted network input — every endpoint validates shape).

### Side Effects
- Provider files shrink drastically; keep the thin adapters' message names/casing byte-identical (external tooling and tests grep for them).
- `getState`/`setState` size limits differ (webview state vs `localStorage`) — cap and warn, don't throw.

### Dependencies & Conflicts
- **Depends on subtask 1** (`eb75281d-d8f3-4e50-b396-f7626abed020`): catalog + extracted-core bootstrap are the fixture and the target of every lift.
- **Coordinates with subtask 2** (`341ac949-57bf-4223-847d-0ba8876771dc`): wsHub carries terminal streams; envelope agreed early.
- Dep: `ws`. No other new runtime deps.

## Dependencies
- **Session dependencies:** subtask 1 (`eb75281d-d8f3-4e50-b396-f7626abed020` — protocol catalog + core service) is a hard prerequisite; subtask 2 (`341ac949-57bf-4223-847d-0ba8876771dc`) shares the wsHub envelope.
- Parent architecture reference: `.switchboard/plans/extract-standalone-npx-browser-service.md`.

## Adversarial Synthesis

Key risks: silently changing shipped-extension behavior across 706 lifts, stale-board push-fidelity failures across 988 sites, and the WS upgrade becoming an RCE vector. Mitigations: catalog-driven CI parity gate + byte-compatible reply semantics + unchanged provider tests; per-connection ordered push queues with full resync-on-reconnect; token-validated upgrade with Host/Origin allowlisting on a 127.0.0.1 bind.

## Proposed Changes

### `src/services/{TaskViewer,Kanban,PlanningPanel,DesignPanel,SetupPanel}Provider.ts`
- **Context:** 706 arms embed business logic (191/168/168/62/117).
- **Logic:** Each arm → thin call-through to a shared service method.
- **Implementation:** Provider-by-provider per the burn-down order; each verb lands with endpoint + shim wiring + parity row in the same change.
- **Edge Cases:** reply-coupled verbs keep identical reply types/payloads; no new acks on fire-and-forget verbs.

### `src/services/LocalApiServer.ts`
- **Context:** vscode-free HTTP server, injected callbacks, `/health` at `:1320`, `_checkAuth` at `:219`.
- **Logic:** Static board assets, WS upgrade delegation to wsHub, per-verb routes.
- **Implementation:** Extend `LocalApiServerOptions` with optional callbacks (existing "absent in headless harnesses" pattern); port file written only after listen succeeds.
- **Edge Cases:** unauthenticated upgrade rejected pre-protocol-switch; Host/Origin on every route.

### `src/standalone/wsHub.ts` (new)
- **Context:** No WS layer exists.
- **Logic:** Token-gated upgrade, ordered per-connection push queue, resync-on-connect, terminal-stream channels.
- **Implementation:** Single WS per client; message envelope shared with subtask 2.
- **Edge Cases:** reconnect storm → resync coalescing; slow consumer → bounded queue with disconnect-and-resync rather than unbounded buffering.

### `src/webview/transport.js` (new, loaded by all five panels)
- **Context:** 575 call sites acquire the bridge via `acquireVsCodeApi()`.
- **Logic:** Host detection; API-compatible shim per Scope.
- **Implementation:** Zero per-call-site rewrites; panel bootstraps load the shim first.
- **Edge Cases:** WS drop → reconnect with backoff + full resync; storage size caps warn not throw.

## Verification Plan

### Automated Tests
- **Catalog parity gate (CI):** every catalogued verb has a live endpoint and a UI call site; failures name the missing verb.
- Existing provider tests pass unchanged after every provider's burn-down (per-provider checkpoint, not just at the end).
- WS auth tests: upgrade without valid token rejected; bad Host/Origin rejected.
- Push-order test: burst of ordered pushes arrives in order; reconnect triggers resync.

### Manual
- Full board in the browser: plan moves across columns, feature create/assign, planning + design/Stitch + setup panels all functional — burned-down catalog is the checklist.
- Same workspace in VS Code extension afterwards (sequentially): identical behavior, board state consistent.
- Kill WS in dev tools mid-session → reconnect resyncs, no stale cards.

**Stage Complete:** PLAN REVIEWED
