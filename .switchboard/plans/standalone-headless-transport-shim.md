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
- **Serve the board assets:** static-serve `src/webview/*` from `LocalApiServer` (or the standalone service) so a browser can load the real panels. *(Serving specifics consolidated from the retired Board Anywhere · Browser Board plan.)* The server serves **zero** static assets today, so this is net-new: a content-type-by-extension handler + asset routes. The on-disk panel HTML is **not** directly servable — it carries `{{...}}` placeholder tokens (icons `{{ICON_*}}`, fonts, `<!-- SHARED_DEFAULTS_SCRIPT -->`) that `KanbanProvider._getHtml` (`:10517-10606`) rewrites at serve time via `asWebviewUri`, and has **no CSP/nonce** on disk. The HTTP path must run its own equivalent replacement (tokens → HTTP asset routes) and inject a **browser CSP** — critically `connect-src 'self'` so fetch + WS work (the webview CSP is `connect-src 'none'`, which would block the shim entirely). Serve from the same resolved path `_getHtml` uses (`dist` → `webview` → `src`) to keep a single source, no forked HTML.
- **Two-channel transport (verified):** commands go out over `postMessage.type → fetch('/kanban/verb/'+type)` — a 1:1 mapping (`handleServiceVerb` injects the verb as `msg.type` into the same `_handleMessage` switch; `KANBAN_VERBS` == the switch cases). Renders come **in over the wsHub**, which already broadcasts the exact `updateBoard`/`moveCards`/… vocabulary the inbound handlers consume — the verb's `{ success, ... }` HTTP reply is an **ack, not a render**, so the shim must drive re-render from the WS channel, never from the fetch response.
- **Read-only-first rollout (optional, de-risks the shim):** a panel can ship view + auto-refresh with mutations disabled first, then enable interactions verb-by-verb behind the allowlist + `validateVerbPayload` gate — the kanban panel is the natural proving slice (Implementation Step 1).
- **Host-adaptive UI (capability-gated pathways):** read B1's host-capability flag (the `data-host-capabilities` body attribute at first paint, `/health` as the programmatic source) and, when `terminalDispatch` is false, **hide the terminal/CLI-dispatch, autoban, and orchestrator pathways** rather than render buttons that silently no-op. Concretely, gate the terminal-mode dispatch controls (`triggerAction`/`triggerBatchAction`/`promptAll`/`promptOnDrop`/`dispatchManagerForSelected`, the CLI role-dispatch buttons, `julesSelected`/batch dispatch), the automation surface (`toggleAutoban`/autoban terminals, `startOrchestrator`/`stopOrchestrator`, `setAutomationMode` orchestration mode), and terminal utilities (`focusTerminal`, `openWorktreeTerminals`, MCP-monitor terminals). **Keep the full Copy-Prompt surface** (all `copy*Prompt`/`chatCopyPrompt` verbs — they return the prompt in the response body, so the browser copies client-side via `navigator.clipboard`, secure-context-OK on `127.0.0.1`) plus board/plan/feature/project management, refine, and ticket sync. Default the drag/drop dispatch mode to **prompt (Copy)** since terminal mode is unavailable. `promptSelected` stays — in a terminal-less host it degrades to copy-only (its own code already skips dispatch when there is no dispatch spec). This is a **persistent capability difference, not a race** — omit the paths, no warning toasts.

### ⚙️ OUT OF SCOPE
- Endpoints, wsHub, handler extraction, parity gate (all A2). node-pty terminal grid (B3). npx one-time-token browser bootstrap (B4 — token *validation* server side lands in A2).

## Implementation Steps
1. Implement `transport.js` and wire it into one panel (kanban) end-to-end as the pattern-proving slice.
2. Roll to the remaining panels (planning, project, design/Stitch, setup, sidebar) — bootstrap loads shim first; verify each renders and round-trips in a browser.
3. Static-serve the webview assets; confirm same-origin against the API/wsHub.
4. **Capability-gate the UI:** read the host-capability flag at first paint; in a terminal-less host, hide the terminal/CLI/automation pathways and default dispatch to Copy-Prompt (per Scope). Prove both states: headless (flag false → CLI paths absent, Copy-Prompt works) and VS-Code/fleet host (flag true → full surface).

## Complexity Audit
### Routine
- Per-panel bootstrap wiring once the shim is proven.
### Complex / Risky
- **In-extension shim path must stay synchronous-ordered** exactly like raw `postMessage` (no microtask reordering introduced by the wrapper) — otherwise subtle ordering bugs in the shipped extension.
- **Request/response coupling over two transports** — reply-coupled verbs must keep identical reply `type:` names/shapes whether over the bridge or fetch/WS (A2 guarantees the endpoint side; the shim must not diverge).

## Edge-Case & Dependency Audit
- **Two browser tabs** on one board → both get full push fan-out; last-writer-wins (same as two webview panels).
- **Dependencies:** **A2a** (wsHub + reply-shape/auth) + **A2b** (per-verb endpoints), **B1** (a served origin **and the host-capability descriptor** the adaptive UI reads). Shares the WS envelope agreed in A2a.

## Verification Plan
- The full board renders in a browser via the shim; plan moves, feature ops, and the planning/design/setup panels all round-trip.
- Same workspace opened in the VS Code extension afterwards behaves identically (shim wraps the real bridge there).
- Kill the WS in dev tools mid-session → reconnect + resync, no stale cards; oversized `setState` warns rather than throwing.
- **Headless host (`terminalDispatch: false`):** CLI/terminal/autoban/orchestrator controls are absent (not just disabled); Copy-Prompt copies to the browser clipboard and advances the card; no dead buttons. **VS-Code/fleet host (`terminalDispatch: true`):** full surface renders.

**Stage Complete:** PLAN REVIEWED
