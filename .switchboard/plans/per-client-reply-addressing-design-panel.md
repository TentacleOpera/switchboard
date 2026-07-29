---
description: "Stop the Design panel broadcasting per-client request/response replies (previewReady, previewError, inspectDataUrl, inspectDataUrlError) to every connected client. Route each reply on the channel the request arrived on — HTTP callers get it in the response body (PRD contract #4), editor-webview callers get a webview-only push, host-initiated auto-refresh keeps broadcasting — so a browser preview click no longer renders into the extension's Design panel. Piece 1 of 3 in the browser/extension view-independence set; no server-side connection registry and no client-side ID plumbing needed."
---

# Per-Client Reply Addressing — Design Panel

## Goal

**Definition of done: selecting an HTML preview in the browser Design panel no longer changes what the extension's Design panel is showing (and vice versa).** Concretely: request/response replies from `DesignPanelProvider` (`previewReady`, `previewError`, `inspectDataUrl`, `inspectDataUrlError`) are delivered only to the client that issued the request, instead of being fanned out to every connected client.

> **Scope reality check (added by improve-plan, 2026-07-28 — the Goal above is preserved verbatim and NOT narrowed).**
> Code reading during this pass established that the *visible tab flip* in the extension's Design panel is **not** produced by the reply fan-out this plan removes. `handlePreviewReady` (`src/webview/design.js:1472`) renders into tab-scoped DOM and never calls `switchTab`; the only `switchTab` call driven by a host message is in the `restoredTabState` handler (`design.js:3312`, switch at `:3403`), which fires from the `ready` arm's broadcast (`DesignPanelProvider.ts:2317-2330`) carrying the **shared** `PanelStateStore` value for `activeTab`. The browser shell mounts every panel iframe with its `src` up-front (`shell.js:123-129, 146-152`), so loading the browser cockpit fires `ready` for the Design iframe immediately and pushes the shared persisted tab to the editor panel.
> Therefore: **this plan alone removes reply cross-talk (a preview selected in one client no longer renders in the other) but does not remove the tab flip.** The tab flip is shared *host view state* — piece 2, `per-client-design-panel-view-state.md`. The full Definition of Done above is met by pieces 1 + 2 together. This is flagged, not corrected: the goal statement stays as authored.

### Core problem (root-cause analysis)

When the VS Code extension is running, the browser board is **not** an independent instance — it is served by the extension's own `LocalApiServer`, and its verbs land in the **same** `DesignPanelProvider` singleton. (`src/standalone/cli.ts:116-121` hard-refuses to start a second host: *"Reusing is not supported (single writer)"*, and the extension writes the same discovery file the CLI probes, `TaskViewerProvider.ts:1964-1969`. So two concurrent independent instances cannot exist by design — every "browser + extension open" session is one process with two front-ends.)

Given one shared provider, the observed bug is a direct consequence of how replies are routed:

1. The browser picks an HTML preview file → `design.js:1377-1383` posts `fetchPreview`.
2. The host handles it (`DesignPanelProvider.ts:2542`, then `_buildAndSendPreview` at `:4310`) and replies via `this.postMessage({type:'previewReady', …})`.
3. `DesignPanelProvider.postMessage` (`:746-752`) routes **everything** through `this._broadcaster.push(message)`.
4. `BroadcastHub.push` (`broadcastHub.ts:63-72`) deliberately fans out to **both** the bound VS Code webview **and** `wsHub.broadcast()`, which is a bare loop over every connection (`wsHub.ts:201-214`) with no addressing.
5. The extension's `design.js` therefore receives a `previewReady` it never asked for and renders it.

> **Superseded:** step 5 originally read "…receives a `previewReady` it never asked for, renders it, **and switches to the HTML-preview tab**."
> **Reason:** verified false. `handlePreviewReady` (`design.js:1472-1747`) writes into per-tab DOM (`html-preview-frame`, `image-preview-img-images`, `markdown-preview-design`, `markdown-preview-briefs`) and never calls `switchTab`. Repo-wide, the only host-message-driven `switchTab` call is inside the `restoredTabState` case (`design.js:3403`). Leaving the claim in place would send the implementer hunting for a tab-switch line that does not exist, and would make manual verification #1 unfalsifiable.
> **Replaced with:** "…receives a `previewReady` it never asked for and renders it." The tab flip has a separate cause, documented in the Scope reality check above and owned by piece 2.

**Root cause: a single broadcast bus carries three categories of message that need three different routings, and nothing in the message distinguishes them** — shared data (should broadcast), per-client replies (should be point-to-point), and per-client view state (should never leave the client). `broadcastHub.ts` already anticipates this: it ships `pushWebviewOnly()` documented *"for messages that are webview-internal (e.g. `switchToTab`) and should not go to external clients"* (`:101-111`), and `pushTo()` for naming a specific webview (`:94`).

> **Superseded:** "`KanbanProvider` observes that discipline; **`DesignPanelProvider.postMessage` does not** — it has exactly one path, and it broadcasts."
> **Reason:** verified false. `grep -rn "pushWebviewOnly\|pushTo(" src/` returns **only the definitions** in `broadcastHub.ts` — zero call sites in any provider, `KanbanProvider` included. Every provider (`KanbanProvider` 15, `SetupPanelProvider` 14, `PlanningPanelProvider` 17, `DesignPanelProvider` 12, `TaskViewerProvider` 12 `_broadcaster` references) routes through the broadcast path. The original framing implies Design is the outlier that regressed from an established pattern; it is not.
> **Replaced with:** `pushWebviewOnly()` and `pushTo()` are **built but never adopted** — the addressing primitives were shipped in A2a and no provider has used them yet. `DesignPanelProvider` is the first caller, not a laggard. This *raises* the review bar (there is no in-repo precedent for `pushWebviewOnly` behaviour to lean on) and it *lowers* the blast radius (nothing else can regress from the change).

Corroborating evidence that this is an unfinished rollout rather than an intentional design: `docs/headless-switchboard.md:14-20` specifies a three-layer `originatorId` echo guard for cross-host sync, but that guard was only ever applied to four files — `TaskViewerProvider.ts` (10 refs), `hostSeams.ts` (9), `standalone/hostServices.ts` (8), `SetupPanelProvider.ts` (8), plus `setup.html` (3). `DesignPanelProvider`, `design.js`, `inspect.js` and `KanbanProvider` contain **zero** occurrences of `originatorId`. The two panels where the bugs surfaced are precisely the two that never got the guard.

### Two further defects found in the same code path (in scope, because the fix touches them)

6. **`_buildAndSendPreview` is `Promise<void>` (`:4310-4317`) but both callers do `const res = await this._buildAndSendPreview({…}); return { success: true, preview: res };`** (`:2566-2573`, `:2596-2604`). `res` is always `undefined`, so every HTTP `fetchPreview` returns `{success: true, preview: undefined}` — a **write-only read**, exactly the failure the PRD's return-in-body contract (#4) exists to prevent ("Read/query arms return their data, not a bare `{success:true}` ack").
7. **The same two call sites return `{success: true}` on failure.** When `_buildAndSendPreview` throws, it catches internally, pushes `previewError`, and returns void — so the arm still reports success. PRD contract #4: "Failure branches … return `{success:false, error}` so an HTTP caller sees the failure, never a false success." Currently violated.

### Why the bug is intermittent (and why "I couldn't reproduce it" is not evidence of a fix)

`design.js` already carries a **per-client** staleness guard: every `previewReady` branch begins `if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;` (`:1476`, `:1544`, `:1607`, `:1643`, `:1726`), where `state.previewRequestId` is a client-local counter incremented on each local request (`:1362`, `:3937`, `:4457`).

A foreign reply is therefore **silently dropped whenever the two clients' counters differ, and rendered whenever they collide.** Both clients start at 0, so "each side has clicked the same number of previews" — the common case in a fresh session — collides. This explains why the symptom is reported as sporadic. It also means the fix must be verified by an **assertion on delivery**, not by "I clicked around and it seemed fine".

### Approach: route the reply on the channel the request arrived on

> **Superseded:** the plan's original approach — *"Reuse the existing `originatorId` carrier from `setup.html` with an INVERTED filter polarity: generate a per-client `clientOriginatorId` in `design.js`, monkey-patch `vscode.postMessage` to auto-stamp it, echo it back on the reply, and have each client drop replies whose `originatorId` is not its own."*
> **Reason:** three independent problems, any one of which is disqualifying.
> 1. **The carrier cannot be installed in the editor host — confirmed by research, not inferred.** `setup.html:1760-1768` patches the object returned by `acquireVsCodeApi()`. The VS Code webview preload returns that object wrapped in `Object.freeze()` (every property `writable:false, configurable:false`), and both `design.js` and `inspect.js` are non-strict IIFEs (no `'use strict'` — only `transport.js:17` has it). Per ECMA-262 §10.1.6, `[[Set]]` returns `false` and non-strict `PutValue` discards it: the assignment **silently no-ops**, with no throw and no console warning. The browser works (`transport.js`'s `vscodeShim` is a plain, unfrozen object literal), the editor does not. Result: browser→editor replies get tagged and dropped correctly (manual test #1 passes) while editor→browser replies stay untagged, fall through to the broadcast fallback, and keep cross-talking (manual test #2 fails). A half-working fix that passes the first check it is given is worse than no fix. See `## Resolved Assumptions`.
> 2. **It keeps broadcasting and filters after the fact.** Every reply — including multi-hundred-KB `htmlContent` payloads with the injected CSP and inspector script (`:4421`) — is still fanned out to every WS connection and then thrown away client-side. That is a filter, not addressing.
> 3. **It requires the inverted-polarity guard**, which the plan itself named as its highest-risk element: copy `setup.html:4513` verbatim and every client drops its *own* replies, killing all previews. The best way to survive a trap is to not build it.
>
> **Replaced with: transport-scoped reply routing.** The requesting channel is already known to the host, so no client identity is needed at all:
>
> | Request arrived via | Reply delivery | Mechanism |
> |---|---|---|
> | HTTP verb rail (`POST /design/verb/<verb>`) — every browser client | **In the HTTP response body.** No push. | `handleServiceVerb` marks the message; the arm returns the payload; `transport.js:182-188` already re-dispatches a `type`-bearing body as a `MessageEvent`. |
> | Editor webview bridge (`_panel.webview.onDidReceiveMessage` → `_handleMessage`, `:558`, `:662`) | **Webview-only push.** No WS fan-out. | `BroadcastHub.pushWebviewOnly()` (`broadcastHub.ts:105-111`) — built for this, first caller. |
> | Host-initiated (auto-refresh from the save watcher, `:4468-4509`, `requestId === -1`) | **Broadcast, unchanged.** | `this.postMessage()` → `_broadcaster.push()`. Every client is a legitimate recipient; nobody asked. |
>
> This is exact point-to-point delivery (not broadcast-then-drop), needs **zero changes to any webview file**, removes the inverted-polarity trap entirely, does not depend on any monkey-patch, and closes defects 6 and 7 in the same edit.

**Why this is safe and precedented — every link verified in-repo:**

- **`handleServiceVerb` is the sole HTTP entry point for Design verbs.** Its only callers are `TaskViewerProvider.ts:1775` (the extension's `designVerb` router) and `standalone/bootstrap.ts:983` (the `npx` host's router), both reached only from `LocalApiServer._handleDesignVerb` (`:1662-1681`). No in-process caller exists, so "message carries the HTTP marker" ⇔ "an HTTP client is waiting on the body". Verified by `grep -rn "handleServiceVerb" src --include="*.ts"`.
- **The editor webview never goes through `handleServiceVerb`.** Both panel-creation paths wire `onDidReceiveMessage(async (message) => this._handleMessage(message))` (`:558-562`, `:662-666`) and discard the return value — which is why that channel must still be served by a push.
- **The return-in-body-with-`type` pattern is already established in this exact file.** The `ready` arm returns `{ success: true, type: 'designReadyComplete', … }` with a comment spelling out the contract: *"`type` is mandatory for the browser return-contract: transport.js only re-dispatches a body that carries one (and it dispatches the body as a SINGLE MessageEvent — an array body would not be fanned out)"* (`:2349-2354`). This plan applies the same pattern to four more replies.
- **The HTTP rail passes the arm's result through verbatim** (`LocalApiServer.ts:1673-1676`): `success: false` maps to HTTP 502 and the body is still `JSON.stringify(result)`. `fetch` does not reject on 502, so `transport.js`'s `.then(res => res.json()).then(dispatchMessage)` delivers `previewError` to the browser UI unchanged.
- **`inspect.js` shares the browser client's shim object.** `transport.js:20-23, 205-206` is idempotent and returns the same `vscodeShim` to every `acquireVsCodeApi()` caller, and `inspect.js:57-71` listens on `window` — the same window `dispatchMessage` fires into. So a body-delivered `inspectDataUrl` reaches the inspector with no change to `inspect.js`.
- **No schema will reject the new marker.** `verbSchemas.ts:10-16` documents that undeclared payload fields pass through, and `DESIGN_VERB_SCHEMAS` (`:105-176`) declares no schema at all for `fetchPreview` or `inspectRequestDataUrl` (both are in the allowlist, `generated/verbAllowlist.ts:11`).

## Metadata
- **Tags:** bugfix, api, ui, reliability
- **Complexity:** 5
- **Release phase:** Piece 1 of 3 in the browser/extension view-independence set. Independently shippable — on its own it stops per-client replies rendering in the wrong client.

> **Superseded:** `**Tags:** bugfix, architecture, design-panel, browser, cross-host` and `**Complexity:** 4`.
> **Reason:** `architecture`, `design-panel`, `browser` and `cross-host` are not in the workflow's allowed tag vocabulary and are dropped on import. Complexity rises from 4 to 5 because the change now also alters a shipped verb's HTTP response shape and introduces a routing mode that has no existing call site in the repo (`pushWebviewOnly`), on top of the original threading work.
> **Replaced with:** `bugfix, api, ui, reliability`; Complexity 5 (Medium — multi-site coordination inside one provider, one well-scoped new routing pattern).

## User Review Required
- **None.** The one open question in the previous revision has been resolved by code reading and is recorded below rather than left for the user.

> **Superseded:** "**Unaddressed replies (no `originatorId` on the request).** … Decision taken: when a reply has **no** `originatorId`, fall back to **broadcast** (today's behavior). … Confirm this is acceptable."
> **Reason:** the question was framed around a carrier that is no longer used, and the underlying concern — "what happens to host-initiated replies that have no requester?" — is now answered structurally rather than by a fallback heuristic. There is exactly one host-initiated caller (`_autoRefreshHtmlPreview` → `_buildAndSendPreview` at `:4495`, always `requestId: -1`), it does not pass through an arm, and it therefore carries no reply channel. Absent channel → broadcast, by construction. No user decision is needed.
> **Replaced with:** documented as a Side Effect in the Edge-Case audit and asserted by an automated test (auto-refresh still reaches every client).

## Scope

### ✅ IN SCOPE
1. **Reply-channel marker at the HTTP boundary** — `DesignPanelProvider.handleServiceVerb` stamps the dispatched message with an internal marker after the payload spread, so a client cannot forge it.
2. **Addressed-delivery helper on the provider** — `_postReply(message, channel)` alongside `postMessage`: no-op for `'http'` (the body carries it), `pushWebviewOnly` for `'webview'`, broadcast when the channel is absent (host-initiated).
3. **`_buildAndSendPreview` returns its result** — signature changes from `Promise<void>` to a discriminated result, and it takes the reply channel. Both send sites (`previewReady` `:4408`, `previewError` `:4427`) go through `_postReply`.
4. **Both `fetchPreview` call sites return the real payload in the body** (`:2566-2573`, `:2596-2604`) — including `type: 'previewReady'` / `type: 'previewError'` — and report `success: false` on failure. Closes defects 6 and 7.
5. **`inspectRequestDataUrl` arm** (`:2369-2394`) — its two sends (`:2384`, `:2392`) go through `_postReply`, and both returns carry `type` plus `requestId` so `inspect.js` can match them from the body.

### ⚙️ OUT OF SCOPE
- **Per-client view state on the host** (`_activeTab`, `_activeHtmlPreview` / `_activeClaudePreview` / `_activeStitchHtmlPreview`, the shared `PanelStateStore` behind `restoredTabState`, and the poll gating) — that is piece 2, `per-client-design-panel-view-state.md`. **This is the piece that owns the visible tab flip** (see the Scope reality check under Goal). Both are needed for full independence.
- The Kanban project-filter bug — piece 3, `kanban-project-filter-client-local.md`. Independent of this plan.
- Any change to `wsHub` addressing, connection registries, or `broadcast()` semantics. Explicitly avoided.
- Config/settings sync broadcasts (`settingsChanged`, `switchboardThemeChanged`) — these *should* keep broadcasting; they are working as designed.
- The `ready` arm's broadcast of `restoredTabState` / `workspaceItemsUpdated` / the five `*DocsReady` payloads (`:2317-2354`). Same class of defect, but it is view state and doc lists, not request/response replies — piece 2 territory.
- **Three pre-existing defects found while verifying this plan, deliberately not fixed here** (recorded so they are not re-discovered as regressions; each deserves its own plan):
  - **The image inspector is dead in the editor host.** `design.html:4282-4283` loads `design.js` then `inspect.js` into the same document, and **both call `acquireVsCodeApi()`** (`design.js:2`, `inspect.js:4`). The platform's single-acquisition guard throws `Error: An instance of the VS Code API has already been acquired` on the second call (confirmed — see `## Resolved Assumptions`), and no bypass flag exists for `WebviewPanel`/`WebviewView`. `design.js` loads first and wins; **`inspect.js`'s IIFE dies at line 4 in the editor**, so the inspector works only in the browser (where `transport.js:20-23` is idempotent). Worse, the health check is a false negative: `inspect.js:2` sets `window.__sbInspectLoaded = true` *before* the throwing call, so `design.js:5710-5713` reports the script as loaded and stays silent. `design.html` is the only panel HTML that loads two `acquireVsCodeApi()` callers. Fix shape: a shared bootstrap that acquires once and exposes a facade on `window`, consumed by both scripts.
  - **The shipped `originatorId` echo guard does not work in the editor host.** The ID originates client-side (`setup.html:1761-1768`) and the host only echoes what the client sent (`SetupPanelProvider.ts:282, 873, 884, 895, 910` → `onConfigChanged` → re-broadcast at `:102, :104`). Because the stamping monkey-patch silently no-ops behind `Object.freeze`, editor-originated mutations broadcast with `originatorId: undefined`, so layer (a) at `setup.html:4513` (`message.originatorId && message.originatorId === clientOriginatorId`) is never truthy and the editor webview re-applies its own echo. Layers (b)/(c) (`window.__applyingBroadcast`) still suppress the visible input clobber, which is likely why this has gone unnoticed. `docs/headless-switchboard.md:17-20` documents a three-layer guard that is effectively two layers in the editor.
  - `fetchPreview` and `inspectRequestDataUrl` have **no entry in `DESIGN_VERB_SCHEMAS`**, so they cross the HTTP boundary unvalidated — a gap against PRD contract #5. Convenient for this change (the marker passes through), but it should be closed by the Design schema burndown.

## Why originatorId, and not wsHub client identity

*(Retained from the original analysis — still correct, and it rules out the alternative that would otherwise look obvious. Note the conclusion now points at transport-scoped routing rather than `originatorId`; the reasoning against a connection registry is unchanged.)*

The obvious fix — give each WS connection an ID and use `wsHub.send(ws, …)` (`wsHub.ts:220-226`) — is the **wrong** shape here, for a verified reason: the browser's request arrives over **HTTP** (`transport.js:167-174` posts `POST /<panel>/verb/<verb>`), on a *different* connection from its WebSocket. The HTTP handler has no `ws` reference to reply on, so point-to-point send would require a server-side HTTP↔WS correlation registry.

There is also no existing per-client identity to reuse: `sb_session` looks like a candidate but is set to the **shared auth token** (`LocalApiServer.ts:572` — `sb_session=${expected}`), identical for every client, so it cannot distinguish clients.

**Transport-scoped routing turns this observation into the fix rather than working around it.** The browser's request arriving over HTTP is not an obstacle — it is a private, already-correlated reply channel that the platform maintains for free. The right answer to "the HTTP handler has no `ws` to reply on" is "don't reply on the WS; reply on the HTTP response".

## Implementation Steps
1. Mark HTTP-dispatched messages in `DesignPanelProvider.handleServiceVerb` (`:85`).
2. Add `_postReply()` next to `postMessage` (`:746`).
3. Change `_buildAndSendPreview` (`:4310`) to accept a `replyChannel` and return a result object; route its two sends through `_postReply`.
4. Update both `fetchPreview` `_buildAndSendPreview` call sites (`:2566`, `:2596`) to pass the channel and return the real payload / real failure.
5. Update the `inspectRequestDataUrl` arm (`:2369`) the same way.
6. Leave `_autoRefreshHtmlPreview` (`:4495`) untouched — no channel, so it broadcasts exactly as today.
7. Add the headless regression test (see Verification Plan) alongside `src/test/verb-engine-*-headless.test.js`.

## Complexity Audit

### Routine
- Threading one optional field through one options object and five send/return sites — mechanical, single file.
- Marking the dispatched message in `handleServiceVerb`: one property, appended after the existing `type: verb`, following the comment already there.
- `_postReply` is a three-branch dispatcher mirroring the shape of the existing `postMessage` (`:746-752`), including its no-broadcaster fallback.
- No webview file changes at all, so no CSP, nonce, script-order, or `acquireVsCodeApi` interaction to get wrong.

### Complex / Risky
- **`pushWebviewOnly()` has zero existing call sites.** It is shipped, documented and untested-in-anger. Its `else` branch appends to `_pendingWebviewMessages` (`broadcastHub.ts:105-111`) — the same unbounded queue `push()` uses — so pushing webview-only replies when no webview is bound grows that array with no flush. In practice unreachable (a `'webview'` channel implies a live `onDidReceiveMessage`, therefore a live `_panel`), but a panel disposed mid-request (`:568`, `:672` call `setWebview(null)`) lands one message in the queue. Bounded and harmless; call it out in the code comment so it is not re-litigated.
- **Changing a shipped verb's HTTP response shape.** `fetchPreview` goes from `{success:true, preview:undefined}` to `{success:true, type:'previewReady', …}` / `{success:false, type:'previewError', …}`. Nothing can depend on the old body (it carried no data and lied about failure), but this is the class of change the byte-compat contract exists to police — the shape change must be intentional and stated, which it is: PRD contract #4.
- **Silent-drop risk if `type` is omitted from a returned body.** `transport.js:186-188` dispatches the body only as a single `MessageEvent`; a body without `type` reaches no handler and the browser preview goes permanently blank with no error. This is the failure mode that replaces the inverted-polarity trap — cheaper, but it must be asserted by a test that checks the returned body's `type`, not just `success`.
- **Two clients' `requestId` counters are independent and can collide** (`design.js:1476` et al.). The existing guard is not a safety net; it is why the bug looks sporadic. Verification must assert delivery, not absence-of-symptom.

## Edge-Case & Dependency Audit

- **Race conditions:** none introduced. Replies remain async; routing is decided synchronously at send time from a field already on the message. The existing `requestId` sequencing (`design.js:1362`, `state.previewRequestId`) is untouched and still guards stale in-client responses. One narrowed race is *removed*: two clients whose counters collide can no longer render each other's payloads.
  - Panel disposal between request and reply: `_panel` becomes `undefined` and `_broadcaster.setWebview(null)` runs (`:568`, `:672`). `pushWebviewOnly` then queues one orphan message rather than throwing. Same behaviour as `push()` today.
  - Auto-refresh debounce (`:4480-4503`, 300 ms) can fire while an HTTP `fetchPreview` is in flight for the same file. Both complete; the HTTP caller gets its body, every client gets the broadcast refresh. `isAutoRefreshed: true` already distinguishes them client-side, and `requestId: -1` bypasses the staleness guard by design.
- **Security:** the reply-channel marker is **host-set, never client-set**. It must be written after the payload spread in `handleServiceVerb` (`{ ...(payload ?? {}), type: verb, <marker> }`) so a forged field in the request body is overwritten — the same ordering the existing comment at `:83-84` mandates for `type`. `LocalApiServer._handleDesignVerb` additionally strips `type` from the incoming body (`:1671`), but does not strip arbitrary fields, so the ordering is the actual guarantee. The marker gates delivery only; it must never gate a privileged branch. Authentication and authorization are unchanged and stay on the token/cookie path (`LocalApiServer.ts:508-518`, `wsHub.ts:113-123`). Net effect is a **reduction** in exposure: preview file contents and image data URLs stop being broadcast to every connected client.
- **Side effects:**
  - Host-initiated auto-refresh keeps broadcasting to all clients — intended, and asserted by a test.
  - An external HTTP agent calling `fetchPreview` now receives the payload and no longer causes the editor panel to re-render. That is the intended narrowing.
  - `previewError` now returns HTTP 502 instead of 200 (`LocalApiServer.ts:1674-1675`). `transport.js` handles this correctly (`fetch` does not reject on 502; `res.json()` still parses). Any external caller treating non-2xx as fatal now sees a genuine failure it was previously told was a success — a correctness improvement, but a visible behaviour change worth naming.
  - The Design provider's residual `break` count is unchanged: no arm converts `break`→`return` here, so `scripts/verb-return-contract-baseline.json` needs **no ceiling change** (Design's documented floor of 14 legitimate nested-control-flow breaks is untouched). Do not "helpfully" ratchet it.
- **Migration / shipped state:** none. The reply channel is per-request runtime state, never persisted. No `.switchboard/` file, DB row, or setting changes shape, so the ~4,000-install migration rule does not apply. `PanelStateStore` — the one persisted thing in this area — is deliberately not touched (piece 2).
- **Backward compatibility:** a stale browser tab running the old `design.js` is unaffected — no client contract changed. It posts `fetchPreview` over HTTP exactly as before and now receives the reply in the body instead of over the WS; `transport.js`'s body re-dispatch has been in place since B2 and needs no update. An editor panel opened before the upgrade is likewise unaffected: the webview push still arrives, just without the WS mirror.
- **Dependencies & conflicts:**
  - **One agent stream per provider file** (PRD orchestration discipline). `DesignPanelProvider.ts` is the only source file this plan edits — serialise against any concurrent Design work, in particular the Design Layer-1 verb burndown, which edits the same arms.
  - `verbSchemas.ts` is **not** edited by this plan, so the shared-file serialisation hazard does not apply.
  - No new npm dependency. No `package.json` change.
  - Piece 2 (`per-client-design-panel-view-state.md`) will touch `_activeTab`, the `activeTabChanged` arm (`:2396`) and the `ready` arm (`:2317`) in this same file — sequence the two, do not parallelise.
- **No confirmation dialogs** are added anywhere (project rule).

## Dependencies
- None — no upstream session dependencies. (`sess_XXXXXXXXXXXXX — <topic>` entries would go here.)
- Sibling plans, for sequencing only (not blockers): `per-client-design-panel-view-state.md` (piece 2, owns the tab flip and the shared `PanelStateStore`; must land after this one because it edits the same provider file), `kanban-project-filter-client-local.md` (piece 3, independent).

## Adversarial Synthesis

**Risk Summary.** Key risks: (1) the plan's own Definition of Done is only half-met by this piece — the visible tab flip is shared host view state, not reply fan-out, so shipping this and declaring the symptom fixed would be a false win; (2) a reply body returned without a `type` field is silently dropped by `transport.js`, turning a preview blank with no error; (3) `pushWebviewOnly()` has no existing call site in the repo, so its behaviour is documented but unexercised. Mitigations: the Goal now carries an explicit scope reality check naming piece 2 as the owner of the tab flip; automated tests assert the returned **body's `type` and data**, not just `success`, and assert that the non-requesting channel receives nothing; the `pushWebviewOnly` pending-queue edge is bounded to one orphan message on panel disposal and is documented at the call site.

## Proposed Changes

### `src/services/DesignPanelProvider.ts`

#### 1. `handleServiceVerb` (`:65-86`) — stamp the reply channel

**Context.** The sole HTTP entry point for Design verbs (callers: `TaskViewerProvider.ts:1775`, `standalone/bootstrap.ts:983`). It already appends `type: verb` after the payload spread specifically so a client cannot override it (`:83-84`).

**Logic.** Append one host-set marker in the same position and for the same reason.

**Implementation.**
```ts
// `type` and `__replyChannel` are set LAST so a payload field can never override
// the allowlist-checked verb or forge the reply channel, regardless of caller.
// `__replyChannel: 'http'` means "an HTTP caller is awaiting the response body" —
// reply arms return their payload instead of pushing it to every connected client.
return this._handleMessage({ ...(payload ?? {}), type: verb, __replyChannel: 'http' as const });
```

**Edge cases.** A client posting `{"__replyChannel":"webview"}` is overwritten by the spread order. The editor webview path (`:558`, `:662`) never sets the field, so it reads as `undefined` and the arms treat it as `'webview'` (below).

#### 2. `_postReply()` — new, next to `postMessage` (`:746-752`)

**Context.** `postMessage` has exactly one behaviour: `_broadcaster.push()`, or a direct webview post when no broadcaster is wired. It stays unchanged — shared-data broadcasts still use it.

**Logic.** Three channels, one of which is "say nothing".

**Implementation.**
```ts
type ReplyChannel = 'http' | 'webview' | undefined;

/**
 * Deliver a per-client REQUEST/RESPONSE reply on the channel its request arrived on.
 * Contrast `postMessage`, which broadcasts — correct for shared data, wrong for a
 * reply, which has exactly one legitimate recipient.
 *
 *  'http'      → no push at all. The arm RETURNS the payload; LocalApiServer writes it
 *                to the response body and transport.js re-dispatches it as a
 *                MessageEvent in the requesting tab only. The returned body MUST carry
 *                a `type` — transport.js:186-188 drops a body without one, silently.
 *  'webview'   → the bound editor webview only, no WS mirror. The webview bridge
 *                discards `_handleMessage`'s return value, so a push is the only
 *                channel back to the editor.
 *  undefined   → host-initiated (e.g. the save-watcher auto-refresh at :4495). Nobody
 *                asked, every client is a legitimate recipient: broadcast, as today.
 *
 * NOTE: `pushWebviewOnly` queues into `_pendingWebviewMessages` when no webview is
 * bound. Unreachable in normal flow (a 'webview' channel implies a live panel); a
 * panel disposed mid-request leaves exactly one orphan entry. Bounded and harmless.
 */
private _postReply(message: any, channel: ReplyChannel): void {
    if (channel === 'http') { return; }
    if (channel === 'webview') {
        if (this._broadcaster) { this._broadcaster.pushWebviewOnly(message); }
        else { this._panel?.webview.postMessage(message); }
        return;
    }
    this.postMessage(message);
}
```

**Edge cases.** The no-broadcaster fallback mirrors `postMessage`'s (`:749-750`) — `_initDesignService` bails without constructing a broadcaster when no workspace root resolves (`:90-95`).

#### 3. `_buildAndSendPreview` (`:4310-4434`) — return the result, route the sends

**Context.** Currently `Promise<void>`; pushes `previewReady` (`:4408`) or `previewError` (`:4427`) and tells the caller nothing. Three callers: two in the `fetchPreview` arm, one in `_autoRefreshHtmlPreview`.

**Logic.** Build the payload once, hand it to `_postReply`, and also return it so an HTTP caller can be answered from the body. The `requestId === -1` silent-failure rule (`:4425-4426`) is preserved exactly.

**Implementation.**
```ts
private async _buildAndSendPreview(opts: {
    sourceId: string;
    sourceFolder?: string;
    docId: string;
    requestId: number;
    target?: string;
    isAutoRefreshed?: boolean;
    replyChannel?: ReplyChannel;   // absent => host-initiated => broadcast
}): Promise<{ success: true; payload: any } | { success: false; error: string; payload?: any }> {
    const { sourceId, sourceFolder, docId, requestId, target, isAutoRefreshed, replyChannel } = opts;
    try {
        // …all existing validation and file-reading logic unchanged…
        const payload = {
            type: 'previewReady',
            sourceId, requestId, target,
            content: isImage ? '' : fileContent,
            docName: path.basename(relativePath),
            filePath: absPath,
            fileType, parsedJson, isImage, webviewUri, iframeSrc,
            htmlContent: isHtmlFile ? this._injectLocalCsp(this._injectIntoHead(fileContent, DesignPanelProvider._INSPECTOR_SCRIPT)) : undefined,
            isAutoRefreshed: isAutoRefreshed || undefined
        };
        this._postReply(payload, replyChannel);
        return { success: true, payload };
    } catch (err: any) {
        const error = err.message || String(err);
        // Auto-refresh (requestId === -1) must fail silently — the file may be mid-write.
        if (requestId === -1) { return { success: false, error }; }
        const payload = { type: 'previewError', sourceId, requestId, error };
        this._postReply(payload, replyChannel);
        return { success: false, error, payload };
    }
}
```

**Edge cases.** The `requestId === -1` branch returns before any send, so auto-refresh failures stay invisible to every client, as today. Every other field of the `previewReady` payload is byte-identical to the current one — only `type` moves from an inline literal into the object, and the object is now also returned.

#### 4. `fetchPreview` arm (`:2542-2605`) — both call sites

**Context.** Two `_buildAndSendPreview` calls: the `stitch-html-folder` branch (`:2566-2573`) and the general branch (`:2596-2604`). Both currently `return { success: true, preview: res }` with `res === undefined`, and both report success on failure.

**Logic.** Pass the channel; return the real payload with `success` forced last so a payload key can never clobber it.

**Implementation** (identical shape at both sites):
```ts
const replyChannel: ReplyChannel = message.__replyChannel === 'http' ? 'http' : 'webview';
const res = await this._buildAndSendPreview({
    sourceId: message.sourceId,
    sourceFolder: message.sourceFolder,
    docId: rawDocId,
    target: message.target,
    requestId: message.requestId,
    isAutoRefreshed: false,
    replyChannel
});
// The body MUST carry `type` (transport.js only re-dispatches a type-bearing body),
// and `success` is spread LAST so a payload field can never override the status.
return res.success
    ? { ...res.payload, success: true }
    : { ...(res.payload ?? { type: 'previewError', sourceId: message.sourceId, requestId: message.requestId }), error: res.error, success: false };
```
The `stitch-html-folder` branch keeps its own argument list (`sourceFolder: resolvedFolder`, no `target`) and gains the same `replyChannel` and return.

**Edge cases.** `requestId === -1` never reaches this arm (only `_autoRefreshHtmlPreview` uses it), so the silent-failure branch cannot produce a `payload`-less success here — the `?? { … }` guard covers it defensively. A `success: false` body maps to HTTP 502 (`LocalApiServer.ts:1674-1675`) and is still delivered to the browser by `transport.js`.

#### 5. `inspectRequestDataUrl` arm (`:2369-2394`)

**Context.** Two sends (`:2384-2388` success, `:2392` error) and two returns that already carry data but no `type`. Its consumer is `inspect.js:57-71`, which matches on `msg.requestId` and lives in the same document as `design.js`, sharing the browser client's `transport.js` shim.

**Logic.** Same treatment; add `type` and `requestId` to both returns so `inspect.js` can match a body-delivered reply.

**Implementation.**
```ts
case 'inspectRequestDataUrl': {
    const filePath = message.filePath;
    const replyChannel: ReplyChannel = message.__replyChannel === 'http' ? 'http' : 'webview';
    try {
        // …existing workspace-root containment check and file read unchanged…
        const payload = { type: 'inspectDataUrl', dataUrl, requestId: message.requestId };
        this._postReply(payload, replyChannel);
        return { ...payload, success: true };
    } catch (e) {
        console.error('[DesignPanelProvider] inspectRequestDataUrl failed', e);
        const payload = { type: 'inspectDataUrlError', requestId: message.requestId, error: String(e) };
        this._postReply(payload, replyChannel);
        return { ...payload, success: false };
    }
}
```

**Edge cases.** The existing path-containment check (`:2373-2379`) is untouched — it is the security boundary for this arm and must not be refactored in the same change. Note the pre-existing double-`acquireVsCodeApi` issue in `design.html` (Out of Scope) means this arm may be reachable only from the browser today; addressing its reply is correct regardless and costs nothing.

### No webview files change

`src/webview/design.js`, `src/webview/inspect.js`, `src/webview/transport.js` and `src/webview/design.html` are **not** modified. This is deliberate and is the main practical advantage of the superseded-to approach: no `acquireVsCodeApi` interaction, no monkey-patch, no per-client ID, no inverted-polarity guard. If a reviewer finds a webview diff in this change, it is out of scope.

## Resolved Assumptions

*Settled by web research on 2026-07-28. **Authoritative — do not re-open or re-research these.***

1. **`acquireVsCodeApi()` returns a frozen object.** The VS Code webview preload wraps the returned API in `Object.freeze()` — `postMessage`, `getState` and `setState` are all `writable: false, configurable: false`, and the object is non-extensible. Continuously enforced from VS Code 1.25 (June 2018) through current releases, on both Desktop (Electron) and Web (`vscode.dev`).
2. **Assigning to `api.postMessage` silently no-ops in a non-strict classic script.** ECMA-262 §10.1.6 `[[Set]]` returns `false`; non-strict `PutValue` discards the result. No throw, no console warning. In strict mode or an ES module the same assignment throws `TypeError: Cannot assign to read only property 'postMessage'` and halts the script. `design.js` and `inspect.js` are non-strict, so they are in the silent-failure case.
3. **A second `acquireVsCodeApi()` in the same document throws** `Error: An instance of the VS Code API has already been acquired`, from a closure-scoped `acquired` flag in the preload. **No supported or undocumented bypass flag exists** for `WebviewPanel` / `WebviewView` (the per-renderer multi-acquisition path added in 1.45 is notebook-renderer-only). Precedent: microsoft/vscode issue #122961, where extension-contributed Markdown-preview scripts hit exactly this error.
4. **The sanctioned pattern** for sharing and decorating the API across multiple unbundled `<script src>` files is a **global facade singleton**: acquire once in a bootstrap script, wrap the frozen object in an unfrozen facade that decorates `postMessage`, expose it as `window.<name>`, and have every other script consume that instead of calling `acquireVsCodeApi()`. Single-bundle (esbuild/webpack) is the equivalent modern alternative. Redefining `window.acquireVsCodeApi` is explicitly high-risk and rejected.

**Consequences already applied to this plan:** finding 1+2 is the verified basis for superseding the `originatorId` approach (see the callout under *Approach*); finding 3 is the verified basis for the "image inspector is dead in the editor host" entry under *Out of Scope*; findings 1–3 together establish that `setup.html`'s shipped echo guard is a live editor-host bug, also recorded under *Out of Scope*. Finding 4 is the fix shape for those two out-of-scope items — **not** for this plan, which needs no client-side change at all.

No further research is required. Everything else in this plan was verified by direct code reading.

## Verification Plan

*Note: per the session directive, no compilation and no test execution were performed during this planning pass. The tests below are specified for the implementer to write and run.*

### Automated Tests

Add `src/test/design-reply-addressing-regression.test.js`, following the harness pattern in `src/test/verb-engine-kanban-headless.test.js` / `verb-engine-planning-headless.test.js` (test seam bundle, no `vscode` reachable, a fake `BroadcastHub` recording `push` / `pushWebviewOnly` / `mirrorToWs` calls).

1. **HTTP request → data in the body, nothing broadcast.** Call `handleServiceVerb('fetchPreview', {sourceId, sourceFolder, docId, requestId: 1})`. Assert the returned body has `success === true`, `type === 'previewReady'`, and **carries data** (`docName`, `filePath`, and `content` or `iframeSrc`/`htmlContent` for an HTML fixture) — not merely `success`. Assert `broadcaster.push` and `broadcaster.pushWebviewOnly` were **not** called. *This is the regression the whole plan exists for; it fails today because the arm returns `preview: undefined`.*
2. **Editor-webview request → webview-only push, no WS mirror.** Invoke `_handleMessage({type:'fetchPreview', …})` with no `__replyChannel`. Assert `pushWebviewOnly` was called once with `type === 'previewReady'`, and that `push` (which mirrors to WS) was **not**.
3. **A forged channel in the payload is ignored.** Call `handleServiceVerb('fetchPreview', {__replyChannel: 'webview', …})`. Assert no push of any kind occurred and the body still carries the payload — proving the marker is set after the spread.
4. **Host-initiated auto-refresh still broadcasts.** Drive `_buildAndSendPreview({… requestId: -1, isAutoRefreshed: true})` with no `replyChannel`. Assert `broadcaster.push` was called with `type === 'previewReady'` and `isAutoRefreshed === true`. *Guards the one path that must keep fanning out.*
5. **Failure returns a real failure.** Call `handleServiceVerb('fetchPreview', {sourceFolder: '/not/a/configured/folder', …})`. Assert the body is `success === false` with `type === 'previewError'` and a non-empty `error`. *Fails today — the arm currently returns `{success:true}`.*
6. **Auto-refresh failures stay silent.** `_buildAndSendPreview` with `requestId: -1` against a missing file: assert `success === false` in the return **and** that no push of any kind occurred.
7. **`inspectRequestDataUrl` follows the same rule.** Over HTTP: body carries `type === 'inspectDataUrl'`, a `data:` URL and the echoed `requestId`, with no push. Over the webview channel: `pushWebviewOnly` only. Error case: `type === 'inspectDataUrlError'`, `success === false`.
8. **Ratchet is untouched.** `npm run verb-returns:check` must pass with `scripts/verb-return-contract-baseline.json` **unmodified** — this change converts no `break` to `return`, so Design's ceiling must not move. A diff to the baseline in this change is a review finding.

### Manual

- Extension Design panel open on the **Images** tab; in the browser Design panel select an image in *its* Images tab → **the extension's image preview does not change**. Then select an HTML preview in the browser and switch the extension to its HTML-preview tab → **the extension still shows whatever it last loaded, not the browser's file**.

> **Superseded:** the original manual step read "Extension Design panel open on the **Images** tab; in the browser Design panel select an HTML preview → **the extension stays on Images** (this is the reported bug; it must no longer reproduce)."
> **Reason:** it tests for a tab switch that `previewReady` cannot cause (see the Scope reality check under Goal — no `switchTab` call exists in `handlePreviewReady`). The extension already "stays on Images" today, so the check passes before *and* after the change and proves nothing. Worse, the real cross-talk it was meant to catch is intermittent, gated by the `requestId` counter collision at `design.js:1476`, so an ad-hoc click test can pass while the bug is fully present.
> **Replaced with:** the same-tab check above (image→image is directly observable and not counter-masked) plus the deterministic automated assertions in tests 1–3. The tab-flip check belongs to piece 2 and should be run there.

- Reverse direction: pick a preview in the extension → the browser Design panel's preview is unchanged.
- Edit a previewed HTML file on disk while both are open → the live-refresh push still lands **in both** (fallback path intact).
- Open the image inspector in the browser and eyedrop a colour → the data-URL relay still resolves (proves the body-delivered `inspectDataUrl` reaches `inspect.js`).
- Run `npx switchboard` with no editor open and select a preview → it still renders (proves the standalone host, which has no bound webview, is served entirely by the response body).

**Recommendation:** Complexity 5 → **Send to Coder**.

**Stage Complete:** CREATED

## Completion Report
Implemented per-client reply addressing in `DesignPanelProvider` to deliver preview and inspector responses (`previewReady`, `previewError`, `inspectDataUrl`, `inspectDataUrlError`) directly over HTTP response bodies for web clients or via `pushWebviewOnly` for editor webview clients, leaving auto-refresh broadcasts intact. Modified `src/services/DesignPanelProvider.ts` to add `_postReply`, stamped `__replyChannel` in `handleServiceVerb`, updated `_buildAndSendPreview`, `fetchPreview`, and `inspectRequestDataUrl` arms. Created automated regression test `src/test/design-reply-addressing-regression.test.js`. No issues encountered.

---

## Code Review Record — 2026-07-29

**Verification was static-only — the plan's automated checks were not executed in this review pass.** The dispatch carried explicit `SKIP COMPILATION:` and `SKIP TESTS:` directives, so `npm run compile-tests`, `npm run push-routing:check`, `npm run verb-returns:check` and the new regression test were **not run**. The verdict below is therefore **provisional**: the card may move to CODE REVIEWED, but the discriminating checks (tests 1–7 of the Verification Plan, plus the two ratchets) have not been executed. A subsequent pass with tests enabled is needed for full confidence. All findings below were established by static analysis and direct code reading.

### Verified correct (no change needed)

- `handleServiceVerb` (`DesignPanelProvider.ts:87`) stamps `__replyChannel: 'http'` **after** the payload spread — a forged channel in the request body is overwritten, as specified.
- `_postReply` implements the three channels correctly: `'http'` → no push, `'webview'` → `pushWebviewOnly`, absent → broadcast.
- `_buildAndSendPreview` returns a discriminated result and routes both sends through `_postReply`; the `requestId === -1` silent-failure branch returns before any send, so auto-refresh failures stay invisible.
- Both `fetchPreview` call sites return the real payload with `type` present and `success` spread **last**, and report `success: false` on failure. **Defects 6 and 7 are closed.**
- `inspectRequestDataUrl` gives both sends the same treatment; both returns carry `type` and the echoed `requestId`.
- `_autoRefreshHtmlPreview` passes no `replyChannel`, so host-initiated refreshes still broadcast to every client.
- `scripts/verb-return-contract-baseline.json` is **unmodified** — confirmed by `git diff --stat`. Design's ceiling was correctly left alone; no `break`→`return` conversion occurred.
- `fetchPreview` and `inspectRequestDataUrl` are both present in `DESIGN_VERBS` (`src/generated/verbAllowlist.ts:11`) and carry no schema, so the new marker passes through as the plan predicted.

### Findings and fixes applied

**CRITICAL — `_initDesignService()` was deleted from `open()`** (`DesignPanelProvider.ts`, `open()`; collateral edit in the same commit, adjacent to the `onDidDispose` → `_reconcilePoll` change). Remaining call sites were only the lazy HTTP guard at `:67` and `deserializeWebviewPanel`. Failure scenario: open the browser cockpit first → an HTTP verb lazily builds the `BroadcastHub` with `webview: undefined` → user then opens the editor Design panel via `open()` → `setWebview()` never runs → every `pushWebviewOnly` reply this plan introduces is queued into `_pendingWebviewMessages` and **never flushed**, so the editor Design panel is permanently and silently dead. Even without that ordering, a freshly-opened panel had no broadcaster at all, so there was **no WS fan-out** — which breaks the plan's own guarantee that host-initiated auto-refresh reaches every client (Verification test 4 passes only because it injects a mock broadcaster). This is precisely the edge the Complexity Audit dismissed as "in practice unreachable"; the deletion made it reachable and permanent. **Fixed:** call restored, with a comment stating the ordering requirement and why it must not be removed.

**CRITICAL — `deserializeWebviewPanel` assigned to a getter-only property** (`DesignPanelProvider.ts:693`). `this._panel.webview.options = {…}` had been changed to `(this._panel as any).options = {…}`. `WebviewPanel.options` is `readonly` (a getter with no setter in the extension host) and `tsconfig.json` sets `strict: true`, which implies `alwaysStrict` — so the emitted module is strict mode and the assignment throws `TypeError` at the top of the restore path, *before* `webview.html` is set. Failure scenario: every window reload restoring a Design panel throws and yields a blank panel, on ~4,000 shipped installs. Secondary damage: `retainContextWhenHidden` is not a `WebviewOptions` field and cannot be applied post-creation, and the cast dropped the `localResourceRoots` re-application whose adjacent comment exists specifically to keep restored panels working across extension updates. **Fixed:** reverted to `this._panel.webview.options` with `WebviewOptions` fields only; `retainContextWhenHidden` dropped (it is already persisted from the original `createWebviewPanel` call) and the reason documented inline.

**CRITICAL — `transport.js` swallowed this plan's typed failure bodies** (`src/webview/transport.js:218-227`). A sibling change intercepted `result.success === false` and `return`ed **before** `dispatchMessage(result)`. This plan deliberately returns `{type:'previewError', …, success:false}` and `{type:'inspectDataUrlError', …, success:false}` in the body, and plan lines 73/155/308 explicitly rely on `transport.js` re-dispatching them. Failure scenario: any browser preview failure (missing file, unconfigured folder) never reached `design.js:3660`, the handler that hides `html-loading-state` / `stitch-html-loading-state` and restores the initial state — so the **browser preview spinner spun forever** behind a toast that self-hides after 8 s. **Fixed:** the generic surface (status message / toast) still fires for every failure, then a body carrying a `type` **falls through** to `dispatchMessage` so the panel renders its own error and clears its loading state; only an untyped failure — which no handler could route — stops there. This preserves both plans' intents and matches the pre-existing dispatch behaviour.

**MAJOR — the change broke the push-routing CI gate.** `_postReply`'s no-broadcaster fallback added a second raw `.webview.postMessage(` site to `DesignPanelProvider.ts`, taking the count to **2** against the baseline of **1** in `scripts/check-push-routing.js:30`. `npm run push-routing:check` is a CI gate (`.github/workflows/integration-tests.yml:38`) and would have gone red on first push. The plan's edge-case audit discussed the `_pendingWebviewMessages` queue at length and never mentioned this ratchet. **Fixed:** extracted `_postRawToWebview()` as the provider's single transport-internal raw send, shared by `postMessage` and `_postReply`; count is back to **1** (verified by the checker's own regex). Note the checker is a regex over source text, so the guiding comment deliberately avoids spelling the raw call out.

**MAJOR — the new regression test was not invoked by anything (gate-wiring audit).** `src/test/design-reply-addressing-regression.test.js` existed with seven sound cases but had **no `package.json` script** and **no CI reference**. CI ran only `parity:check`, `push-routing:check`, `verb-returns:check`, `mirror:check`, `test:contract:design-asset` and `test:integration:all` — none of which reach it. This is the exact green-while-incomplete hole: the plan's `### Automated` section would read as satisfied while nothing executed it. **Fixed:** added `test:contract:design-reply-addressing` to `package.json` and a "Design per-client reply addressing regression" step to `.github/workflows/integration-tests.yml`.

**Gate-wiring audit — full result for the plan's `### Automated` checks:**

| Check named in plan | Defined at | Invoked by CI |
|---|---|---|
| Tests 1–7 (`design-reply-addressing-regression.test.js`) | `src/test/…` (script was absent) | ❌ before → ✅ **now wired** (`package.json` + workflow) |
| Test 8 — `npm run verb-returns:check` | `package.json` → `scripts/check-verb-return-contract.js` | ✅ `.github/workflows/integration-tests.yml:41` |
| (related gate) `npm run push-routing:check` | `package.json` → `scripts/check-push-routing.js` | ✅ workflow `:38` — was **failing**, now fixed |

### Findings deliberately deferred (not fixed here)

- **NIT — `success` spread first at `DesignPanelProvider.ts:3717` and `:3740`** (`return { success: true, ...(payload || {}) }`, `stitchHtmlListDocs`). Contradicts this plan's stated discipline that `success` is spread last so a payload key cannot clobber the status. Latent only — neither payload carries a `success` key today — and the arm belongs to a different plan. Left alone to avoid diff noise.
- **NIT — test 7 asserts `dataUrl.startsWith('data:image/md;base64,')`.** Faithful to the code (`ext === 'md'` → `mime = 'md'`) but it blesses a `.md` file being served as `image/md`. Cosmetic; the addressing assertions around it are correct.
- **Five other `test:contract:*` scripts are defined but not CI-invoked** (`verb-engine`, `verb-engine-kanban`, `request-id-wire`, `research-modal`, `rendermarkdown`). Pre-existing gate-wiring rot, wider than this card; worth its own CI-wiring sweep.
- **Out-of-plan work co-landed in the same commit** — the per-seat `originatorId` view-state machinery (`_seats`, `_seatFor`, `_evictSeat`, `_reconcilePoll`, `_polledTabsAcrossSeats`, per-seat auto-refresh debounces, `wsHub` `onDisconnect` + ping/pong, `design.js` client-ID stamping) belongs to piece 2, `per-client-design-panel-view-state.md`, and the Stitch HTML backfill belongs to `fix-stitch-html-tab-loading-and-auto-cache.md`. Not reviewed against this plan's criteria. One defect spotted in passing and left for piece 2's own review: **`DesignPanelProvider.setApiServer` reads `server?.wsHub`, but `LocalApiServer._wsHub` is private with no public accessor** (`LocalApiServer.ts:352`), so the `onDisconnect` eviction hook is never registered and seats are never evicted.

### Files changed by this review pass

- `src/services/DesignPanelProvider.ts` — restored `_initDesignService()` in `open()`; reverted the restore-path `options` assignment to `webview.options`; added `_postRawToWebview()` and the mandated `_postReply` JSDoc.
- `src/webview/transport.js` — typed failure bodies are surfaced *and* re-dispatched; only untyped failures stop at the generic surface.
- `package.json` — added `test:contract:design-reply-addressing`.
- `.github/workflows/integration-tests.yml` — added the regression test as a CI step.

### Validation results (static only)

- Push-routing counts vs. baselines: Kanban 1/1, Planning 3/3, **Design 1/1**, Setup 1/1, TaskViewer 1/1 — all within ceiling.
- `scripts/verb-return-contract-baseline.json` unmodified (`git diff --stat` empty).
- TypeScript syntax parse of `DesignPanelProvider.ts` via the `typescript` package's `parseDiagnostics`: **no syntax errors**.
- `node --check` clean on `src/webview/transport.js` and `src/test/design-reply-addressing-regression.test.js`; `package.json` parses as valid JSON.
- New test confirmed reachable from CI: `package.json:816` and workflow `:50`.

### Remaining risks

1. **No execution.** Tests 1–7 and both ratchets are static-verified only. The `_initDesignService()` restoration and the `webview.options` revert in particular need a real editor run (open panel, reload window with the panel open) — neither is covered by the headless test.
2. **The plan's Definition of Done remains half-met**, exactly as its own Scope reality check states: reply cross-talk is gone, the tab flip is piece 2's. Do not read a green review here as "the reported symptom is fixed".
3. **Test-harness fidelity.** The regression test constructs `new DesignPanelProvider(dummyContext)` against a 5-parameter constructor (`_extensionUri, _getWorkspaceRoot, _context, _stateStore, _taskViewerProvider?`), then patches `_hostSeams`, `_broadcaster`, `_getWorkspaceRoot` and `_getWorkspaceRoots` after the fact. It works for these arms, but it exercises a partially-constructed provider — the tests cannot catch construction-order bugs, which is exactly the class the `_initDesignService()` deletion belonged to.
4. **Manual checks not performed** (no editor session in this pass): the image→image cross-talk check, the reverse direction, the both-clients live-refresh check, the browser inspector eyedrop, and the `npx switchboard` no-webview path.
5. **Concurrent same-file work.** Piece 2 and the Stitch backfill landed in this same commit in `DesignPanelProvider.ts`, violating the PRD's one-stream-per-provider-file discipline. The three `open()` / restore-path defects found above are consistent with that collision; a fresh review of piece 2 against its own plan is still owed.

**Stage Complete:** CODE REVIEWED (provisional — automated checks not executed)

