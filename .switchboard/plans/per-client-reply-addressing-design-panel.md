---
description: "Stop the Design panel broadcasting per-client request/response replies (previewReady, previewError, inspectDataUrl) to every connected client. Reuse the existing originatorId carrier from setup.html with an INVERTED filter polarity (accept only my own reply) so a browser preview click no longer flips the extension's Design panel to the HTML-preview tab. Piece 1 of 3 in the browser/extension view-independence set; no server-side connection registry needed."
---

# Per-Client Reply Addressing — Design Panel

## Goal

**Definition of done: selecting an HTML preview in the browser Design panel no longer changes what the extension's Design panel is showing (and vice versa).** Concretely: request/response replies from `DesignPanelProvider` (`previewReady`, `previewError`, `inspectDataUrl`, `inspectDataUrlError`) are delivered only to the client that issued the request, instead of being fanned out to every connected client.

### Core problem (root-cause analysis)

When the VS Code extension is running, the browser board is **not** an independent instance — it is served by the extension's own `LocalApiServer`, and its verbs land in the **same** `DesignPanelProvider` singleton. (`src/standalone/cli.ts:113-118` hard-refuses to start a second host: *"Reusing is not supported (single writer)"*, and the extension writes the same discovery file the CLI probes, `TaskViewerProvider.ts:1965`. So two concurrent independent instances cannot exist by design — every "browser + extension open" session is one process with two front-ends.)

Given one shared provider, the observed bug is a direct consequence of how replies are routed:

1. The browser picks an HTML preview file → `design.js:1378` posts `fetchPreview`.
2. The host handles it (`DesignPanelProvider.ts:2542`, then `_buildAndSendPreview` at `:4310`) and replies via `this.postMessage({type:'previewReady', …})`.
3. `DesignPanelProvider.postMessage` (`:746-752`) routes **everything** through `this._broadcaster.push(message)`.
4. `BroadcastHub.push` (`broadcastHub.ts:63-72`) deliberately fans out to **both** the bound VS Code webview **and** `wsHub.broadcast()`, which is a bare loop over every connection (`wsHub.ts:201-214`) with no addressing.
5. The extension's `design.js` therefore receives a `previewReady` it never asked for, renders it, and switches to the HTML-preview tab.

**Root cause: a single broadcast bus carries three categories of message that need three different routings, and nothing in the message distinguishes them** — shared data (should broadcast), per-client replies (should be point-to-point), and per-client view state (should never leave the client). `broadcastHub.ts` already anticipates this: it ships `pushWebviewOnly()` documented *"for messages that are webview-internal (e.g. `switchToTab`) and should not go to external clients"* (`:101-111`), and `pushTo()` for naming a specific webview (`:94`). `KanbanProvider` observes that discipline; **`DesignPanelProvider.postMessage` does not** — it has exactly one path, and it broadcasts.

Corroborating evidence that this is an unfinished rollout rather than an intentional design: `docs/headless-switchboard.md` specifies a three-layer `originatorId` echo guard for cross-host sync, but that guard was only ever applied to three files — `SetupPanelProvider.ts`, `TaskViewerProvider.ts`, `hostSeams.ts` (+ `setup.html`). `DesignPanelProvider` and `KanbanProvider` contain **zero** occurrences of `originatorId`. The two panels where the bugs surfaced are precisely the two that never got the guard.

### Why originatorId, and not wsHub client identity

The obvious fix — give each WS connection an ID and use `wsHub.send(ws, …)` (`wsHub.ts:220`) — is the **wrong** shape here, for a verified reason: the browser's request arrives over **HTTP** (`transport.js` posts `POST /<panel>/verb/<verb>`), on a *different* connection from its WebSocket. The HTTP handler has no `ws` reference to reply on, so point-to-point send would require a server-side HTTP↔WS correlation registry.

There is also no existing per-client identity to reuse: `sb_session` looks like a candidate but is set to the **shared auth token** (`LocalApiServer.ts:572` — `sb_session=${expected}`), identical for every client, so it cannot distinguish clients.

**The cheap, idiomatic carrier already exists client-side.** `setup.html:1762-1768` generates a per-client `clientOriginatorId` and monkey-patches `vscode.postMessage` to auto-stamp it on every outbound message; `:4513` guards incoming messages against it. Because the ID rides *in the message*, the host only has to **echo the requester's `originatorId` back on the reply** — no registry, no connection tracking, and it works identically over the webview bridge and the WS hub.

**Critical detail — the filter polarity is inverted for replies.** The existing config-sync guard ignores messages bearing *my own* ID (don't re-apply my own echo). A per-client reply needs the opposite: **ignore replies bearing someone else's ID, accept my own.** Same carrier, opposite test. An implementer who copies `setup.html:4513` verbatim will invert the fix and break all previews — this must be stated in the code comment.

## Metadata
- **Tags:** bugfix, architecture, design-panel, browser, cross-host
- **Complexity:** 4
- **Release phase:** Piece 1 of 3 in the browser/extension view-independence set. Independently shippable — on its own it fixes the reported cross-talk symptom.

## User Review Required
- **Unaddressed replies (no `originatorId` on the request).** Some callers may post `fetchPreview` without an originator — notably the host's own auto-refresh path (`DesignPanelProvider.ts:4495` re-calls `_buildAndSendPreview` from a file watcher, which has no requesting client). Decision taken: when a reply has **no** `originatorId`, fall back to **broadcast** (today's behavior). This keeps host-initiated live-refresh working for every client and makes the change strictly narrowing — only *client-initiated* replies become addressed. Confirm this is acceptable.

## Scope

### ✅ IN SCOPE
1. **Client-side originator stamping in `design.js`** — mirror `setup.html:1762-1768`: generate a per-client `clientOriginatorId`, monkey-patch `vscode.postMessage` to auto-stamp `originatorId` on outbound messages.
2. **Echo the originator on Design replies** — thread `message.originatorId` from the `fetchPreview` / `inspectRequestDataUrl` arms (`DesignPanelProvider.ts:2542`, `:2369`) through `_buildAndSendPreview` (`:4310`) onto the `previewReady` / `previewError` / `inspectDataUrl` / `inspectDataUrlError` payloads.
3. **Addressed-delivery helper on the provider** — a `_postReply(message)` alongside `postMessage` that broadcasts as today when `originatorId` is absent, and otherwise emits the reply tagged for that originator. Route the four reply verbs through it.
4. **Inverted-polarity guard in `design.js`** — on receiving a tagged reply, drop it when `originatorId` is present and `!== clientOriginatorId`. Comment the inversion explicitly against the `setup.html` precedent.

### ⚙️ OUT OF SCOPE
- **Per-client view state on the host** (`_activeTab`, `_activeHtmlPreview` / `_activeClaudePreview` / `_activeStitchHtmlPreview`, and the poll gating) — that is piece 2, `per-client-design-panel-view-state.md`. This plan stops the *reply* leaking; piece 2 stops the *host state* being shared. Both are needed for full independence; this one alone fixes the visible symptom.
- The Kanban project-filter bug — piece 3, `kanban-project-filter-client-local.md`. Independent of this plan.
- Any change to `wsHub` addressing, connection registries, or `broadcast()` semantics. Explicitly avoided; see "Why originatorId" above.
- Config/settings sync broadcasts (`settingsChanged`, `switchboardThemeChanged`) — these *should* keep broadcasting; they are working as designed.

## Implementation Steps
1. Add `clientOriginatorId` generation + `postMessage` auto-stamp at the top of `src/webview/design.js` (mirroring `setup.html:1762-1768`).
2. Add `_postReply()` to `DesignPanelProvider` next to `postMessage` (`:746`). Absent `originatorId` → `_broadcaster.push` (unchanged). Present → tagged emit.
3. Thread `originatorId` into `_buildAndSendPreview`'s options (`:4310`) and onto its two send sites (`previewReady` ~`:4408`, `previewError` ~`:4427`); switch both to `_postReply`.
4. Same for the `inspectRequestDataUrl` arm's two sends (`:2384`, `:2392`).
5. Add the inverted-polarity guard to `design.js`'s `message` listener, with a comment naming the `setup.html:4513` precedent and why the test is reversed.

## Complexity Audit
### Routine
- Client-side ID generation + stamping: a direct copy of a working in-repo pattern.
- Threading one optional field through one options object and four send sites.
### Complex / Risky
- **The inverted polarity** is the single highest-risk element — copying the existing guard unchanged silently breaks every preview (all replies would be dropped by their own requester). Must be explicit in code comment and covered by a test asserting the requester *does* receive its reply.
- **The unaddressed-reply fallback** must stay broadcast, or the host-initiated auto-refresh path (`:4495`) goes dead for all clients.

## Edge-Case & Dependency Audit
- **Race conditions:** none introduced. Replies remain async; the tag only filters delivery. Existing `requestId` sequencing (`design.js:1362`, `state.previewRequestId`) is untouched and still guards stale in-client responses.
- **Migration / shipped state:** none. `originatorId` is per-session runtime state, never persisted. No `.switchboard/` file, DB row, or setting changes shape, so the ~4,000-install migration rule does not apply.
- **Backward compatibility:** an older client that doesn't stamp `originatorId` still gets broadcast replies (the fallback), so a stale browser tab or unmigrated panel keeps working.
- **Security:** `originatorId` is a client-supplied, non-authoritative routing hint, never an authorization input — auth stays on the token/cookie path (`LocalApiServer.ts:513`, `wsHub.ts:113-123`). A client forging another's ID can only cause itself to accept a reply it wasn't sent, which is not an escalation. Do **not** let it gate any privileged branch.
- **No confirmation dialogs** are added anywhere (project rule).

## Verification Plan
### Automated
- A `fetchPreview` carrying `originatorId: 'A'` produces a `previewReady` tagged `'A'`; a client whose ID is `'B'` drops it, and client `'A'` accepts it (asserts the polarity is not inverted the wrong way).
- A `fetchPreview` with **no** `originatorId` still reaches all clients (auto-refresh fallback preserved).
- `inspectRequestDataUrl` replies are addressed on the same rule.
### Manual
- Extension Design panel open on the **Images** tab; in the browser Design panel select an HTML preview → **the extension stays on Images** (this is the reported bug; it must no longer reproduce).
- Reverse direction: pick a preview in the extension → the browser's tab/preview is unchanged.
- Edit a previewed HTML file on disk while both are open → the live-refresh push still lands (fallback path intact).

**Stage Complete:** CREATED
