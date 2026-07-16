# Browser Board: Serve the Kanban Webview from LocalApiServer

## Goal

Serve the Kanban board as a live web page from LocalApiServer, so any agentic coding app user (Claude Code CLI, Codex, Cursor CLI, a plain terminal) can open the board in a browser without VS Code.

**Problem & background.** The board is currently visible only inside the VS Code webview. Users driving Switchboard from agentic coding apps over the local HTTP API work blind — they can mutate the board through verbs but cannot see it. The Host-Agnostic Verb Engine (A2b) removed the hard blocker: all 144 kanban verbs are now allowlist-gated, schema-validated, and return their results in the HTTP response body (`{ success, ...data }`), which means a non-VS Code host can round-trip every board interaction over plain HTTP. A browser board is the first concrete second host for the webview and the practical payoff of that migration.

**Root cause of the gap.** `kanban.html`/`kanban.js` are coupled to the VS Code host through exactly one seam: `acquireVsCodeApi()` + `postMessage` outbound, and extension-pushed `message` events inbound. Everything else (markup, CSS, rendering, verb payload shapes) is host-neutral. The work is a transport shim, not a rewrite.

## Implementation Steps

1. **Static route.** Add `GET /ui/board` to `LocalApiServer.ts` serving `kanban.html` plus its JS/CSS assets. Rewrite the webview resource URIs (the `vscode-webview://` asset scheme) to plain relative paths at serve time; do not fork the HTML file.
2. **Host shim.** Add a small `browser-host-shim.js` injected only on the browser route (never in the VS Code webview build). It provides an `acquireVsCodeApi()`-compatible object whose `postMessage({ command, ... })` maps to `fetch('/kanban/verb/<command>')` using the existing verb rails, and dispatches the JSON body back to the page as a synthetic `message` event so existing response handlers keep working unmodified.
3. **Inbound refresh.** Replace extension push with polling of a cheap board-state hash endpoint (or SSE if trivially available): on hash change, refetch board state and re-render through the existing refresh path. Reuse the snapshot hash already computed by `BoardSnapshotPublisher` if practical.
4. **Read-only first, then interactive.** Phase A ships the board rendering + auto-refresh with mutations disabled (drag/buttons no-op with a tooltip). Phase B enables interactions verb-by-verb, relying on the verb allowlist + schemas as the safety gate. Phase A alone is shippable.
5. **Auth token.** Once a browser is a client, loopback-without-auth is no longer acceptable (any local webpage can issue cross-origin requests to the port, and DNS rebinding makes "localhost only" porous). Generate a random token alongside `api-server-port.txt` (e.g. `.switchboard/api-server-token.txt`), require it on `/ui/board` (query param on first load, then cookie/header) and on verb calls originating from the browser route. Existing local-agent flows that read the port file read the token file the same way — keep this additive and non-breaking.
6. **Docs.** Add the browser board to the Agentic Coding Apps page and the Local API Server reference on switchboard-site.

## User Review

- Phasing decision needed at dispatch: ship Phase A (read-only) alone first, or A+B together.

## Acceptance Criteria

- Opening `http://127.0.0.1:<port>/ui/board?token=<token>` in a browser (no VS Code involved) renders the current board with columns, cards, features, and project filter state.
- Board mutations made elsewhere (VS Code webview, verb calls) appear in the browser within the polling interval without manual reload.
- Requests without the token are rejected (401) on the browser route; existing loopback agent flows are unaffected.
- `kanban.html`/`kanban.js` remain a single source — no forked copy; the VS Code webview behaves identically before and after.
- (Phase B) Moving a card by drag in the browser persists via the existing verb path and shows up in the VS Code webview.

## Metadata

- **Complexity:** 7
- **Tags:** verb-engine, browser-host, local-api-server, kanban
