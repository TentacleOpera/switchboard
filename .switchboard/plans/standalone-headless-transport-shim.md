---
description: "Feature B (Standalone Headless), subtask B2: ship the webview transport shim so Switchboard's own src/webview/* UI runs unchanged in a browser — an API-compatible acquireVsCodeApi() surface backed by fetch/WS (A2's endpoints/wsHub) and localStorage, loaded first by each panel. Only needed to serve Switchboard's OWN board headlessly."
---

# Feature B · B2 — Transport Shim (run the real webview UI in a browser)

## Goal

Ship a **transport shim** so Switchboard's existing `src/webview/*` UI runs **unchanged** in a plain browser: an API-compatible `acquireVsCodeApi()` surface that, in a browser, backs `postMessage` with fetch/WebSocket (A2's endpoints + wsHub) and `getState`/`setState` with `localStorage`; in a VS Code webview it wraps the real bridge. The **575 UI call sites are untouched** — each panel's bootstrap just loads the shim first.

**Context:** Split 2026-07-08 out of the original `extract-standalone-npx-03-transport-migration.md`. The endpoint/wsHub/extraction work is now **A2** (near-term, in the extension); this shim is **post-release** because it exists only to serve Switchboard's *own* board UI headlessly — a conversational agent (`/switchboard-manage`) or a custom BYO board never needs it, they call the endpoints directly.

> **Post-split note (2026-07-08):** the original A2 was split into **A2a** (wsHub + auth + broadcast + seams) and **A2b** (per-verb HTTP/WS endpoints + push-site audit). Where this plan says "A2": the wsHub/resync/reply-shape guarantees are **A2a**; the per-verb endpoints are **A2b**.

## Metadata
- **Tags:** frontend, refactor, api
- **Complexity:** 5
- **Release phase:** Post-release / headless (Feature B). Depends on A2a (wsHub/resync) + A2b (per-verb endpoints) and B1 (a served origin).

## User Review Required
- None.

## Scope

### ✅ IN SCOPE
- **`src/webview/transport.js` (new):** host detection; in a VS Code webview → wrap the real `acquireVsCodeApi()`; in a browser → an API-compatible shim mapping `postMessage(verb,payload)` to A2's HTTP routes (request/response) and subscribing to A2's wsHub for host→UI push, and mapping `getState`/`setState` to `localStorage`.
- **Panel bootstraps load the shim first** — zero per-call-site rewrites across the 575 sites.
- **Reconnect handling:** WS drop → reconnect with backoff + full resync (A2's resync-on-connect is the backstop); `getState`/`setState` size caps warn, don't throw (webview state vs `localStorage` limits differ).
- **Serve the board assets:** static-serve `src/webview/*` from `LocalApiServer` (or the standalone service) so a browser can load the real panels.

### ⚙️ OUT OF SCOPE
- Endpoints, wsHub, handler extraction, parity gate (all A2). node-pty terminal grid (B3). npx one-time-token browser bootstrap (B4 — token *validation* server side lands in A2).

## Implementation Steps
1. Implement `transport.js` and wire it into one panel (kanban) end-to-end as the pattern-proving slice.
2. Roll to the remaining panels (planning, project, design/Stitch, setup, sidebar) — bootstrap loads shim first; verify each renders and round-trips in a browser.
3. Static-serve the webview assets; confirm same-origin against the API/wsHub.

## Complexity Audit
### Routine
- Per-panel bootstrap wiring once the shim is proven.
### Complex / Risky
- **In-extension shim path must stay synchronous-ordered** exactly like raw `postMessage` (no microtask reordering introduced by the wrapper) — otherwise subtle ordering bugs in the shipped extension.
- **Request/response coupling over two transports** — reply-coupled verbs must keep identical reply `type:` names/shapes whether over the bridge or fetch/WS (A2 guarantees the endpoint side; the shim must not diverge).

## Edge-Case & Dependency Audit
- **Two browser tabs** on one board → both get full push fan-out; last-writer-wins (same as two webview panels).
- **Dependencies:** **A2a** (wsHub + reply-shape/auth) + **A2b** (per-verb endpoints), **B1** (a served origin). Shares the WS envelope agreed in A2a.

## Verification Plan
- The full board renders in a browser via the shim; plan moves, feature ops, and the planning/design/setup panels all round-trip.
- Same workspace opened in the VS Code extension afterwards behaves identically (shim wraps the real bridge there).
- Kill the WS in dev tools mid-session → reconnect + resync, no stale cards; oversized `setState` warns rather than throwing.

**Stage Complete:** PLAN REVIEWED
