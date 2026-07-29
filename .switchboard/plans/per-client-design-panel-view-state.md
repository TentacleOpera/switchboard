---
description: "Move Design panel view state off the shared host singleton and into per-client seats keyed by originatorId: _activeTab, _activeHtmlPreview/_activeClaudePreview/_activeStitchHtmlPreview. Also fixes a second bug the shared state hides — the browser's live file-refresh poll is gated on the EXTENSION panel being visible (_pollTick), so it silently never fires with VS Code minimised. Piece 2 of 3; depends on piece 1's originatorId carrier."
---

# Per-Client Design Panel View State

## Goal

**Definition of done: each Design panel client (browser tab or extension webview) independently owns which tab it is on and which document it is previewing, and live file-refresh works for a browser client while the extension's Design panel is closed or hidden.**

Concretely: `_activeTab` and the three `_active*Preview` fields stop being one shared value per provider and become per-client seats keyed by `originatorId`; the external-file poll is driven by *whether any client is on a polled tab*, not by the extension webview's visibility.

### Core problem (root-cause analysis)

Piece 1 (`per-client-reply-addressing-design-panel.md`) stops per-client *replies* from being broadcast. That fixes the visible symptom but not the cause underneath it: **the Design panel's view state lives on the host as a single value, so the architecture cannot represent "which tab is *this* client on".**

```
DesignPanelProvider.ts:192   private _activeTab: string = ''
DesignPanelProvider.ts:513   private _activeHtmlPreview  = null
DesignPanelProvider.ts:514   private _activeClaudePreview = null
DesignPanelProvider.ts:515   private _activeStitchHtmlPreview = null
```

*(File path confirmed during the improve pass: `src/services/DesignPanelProvider.ts`, 4,574 lines — not `src/providers/`. All line numbers in this plan were re-verified against that file.)*

One `_activeTab` for every connected client. The `activeTabChanged` arm (`:2396-2413`) makes the coupling concrete and destructive: whenever *any* client changes tab, the host overwrites `_activeTab` **and nulls the other clients' active previews** —

```ts
case 'activeTabChanged': {
    this._activeTab = message.tab;
    if (message.tab !== 'html-preview') { this._activeHtmlPreview = null; }
    if (message.tab !== 'claude')       { this._activeClaudePreview = null; }
    if (message.tab !== 'stitch-html')  { this._activeStitchHtmlPreview = null; }
```

So a browser client moving to the Images tab **erases the extension's** in-flight HTML preview registration, and vice versa. Those fields are what the file watchers consult to decide what to re-push on change, so the erased client stops receiving live updates for the document it is still looking at — with no visible cause.

**A second cross-nulling site the original plan's audit missed:** `stitchHtmlListDocs` (`:3550-3564`) also clears shared preview state —

```ts
if (projectId !== this._activeStitchHtmlProjectId || workspaceRoot !== this._activeStitchHtmlWorkspaceRoot) {
    this._activeStitchHtmlProjectId = projectId;
    this._activeStitchHtmlWorkspaceRoot = workspaceRoot;
    this._activeStitchHtmlPreview = null;          // :3559 — nulls ANOTHER client's preview
    void this._setupStitchHtmlFolderWatchers().catch(() => {});
}
```

Client B merely *entering* the Stitch HTML tab under a different project erases client A's Stitch preview registration. Fixing only `activeTabChanged` leaves this path shared, so the plan would not meet its own definition of done. It is now explicitly in scope (see Scope §2).

### Second bug this exposes: browser live-refresh is gated on the extension's panel

`_pollTick()` (`:4180-4185`) opens with:

```ts
const tab = this._activeTab;
const visible = !!this._panel?.visible;
if (!visible || !this._isPolledTab(tab) || !this._panel) { return; }
```

`this._panel` is the **VS Code webview panel**. A browser client has no `_panel`. So external-file polling — the live-refresh for the `html-preview`, `claude`, `images` and `briefs` tabs (`_isPolledTab`, `:4153`) — **only ever runs while the extension's Design panel is open and visible.**

The improve pass enumerated **every** gate of this class. The original plan listed four; there are eight, in three families:

| Site | Gate | Effect on a browser client |
| :-- | :-- | :-- |
| `:4183` | `!visible \|\| !this._panel` | poll tick no-ops |
| `:4220` | `this._activeTab !== tab \|\| !this._panel?.visible` | post-scan recheck discards a completed scan |
| `:4158` | `_onVisibilityChanged`: `visible && _isPolledTab(_activeTab)` | hiding the extension panel stops everyone's poll |
| `:2407` | `_isPolledTab(message.tab) && this._panel?.visible` | a browser tab change can never *start* the poll |
| `:630`, `:736` | config-change restart gated on `_panel?.visible` | changing `design.externalFilePollMs` kills a browser-only poll |
| `:570`, `:674` | `onDidDispose` → `_stopExternalFilePoll()` unconditionally | **closing** the extension Design panel kills browser live-refresh |
| `:4439` | `_registerSaveTextDocListener`: `if (!this._panel?.visible) return;` | saving a file *in VS Code* does not refresh the browser preview when the panel is hidden |
| `:4487` | inside the auto-refresh debounce: `if (!current \|\| !this._panel) return;` | watcher-driven preview re-push dies with no panel at all |

The last three are the ones that matter most for the stated goal: `:570`/`:674` mean the *close* case (not just hidden) hard-stops the poll, and `:4439`/`:4487` mean the **watcher/save-driven** refresh — the path that pushes a changed *document*, not just a changed folder listing — is panel-gated independently of the poll. Fixing only the poll would leave the marquee scenario ("edit the previewed file, browser updates") still broken.

This directly contradicts the purpose of the mode it runs in: the Feature A plan describes this surface as *"complete manager while VS Code is minimised"* — and a minimised VS Code means `_panel.visible === false`, so the browser's live refresh is off exactly when the browser is the only thing being used. It fails silently: no error, the tab simply never updates.

> **Flagged for the user — the sentence above is preserved verbatim, but its mechanism is falsified by research (2026-07-28).** `WebviewPanel.visible` tracks **editor-tab / editor-group layout only**. Minimising, occluding or unfocusing the OS window does **not** flip it and does **not** fire `onDidChangeViewState` (OS-window focus is the separate `window.onDidChangeWindowState` / `WindowState.focused` API), and this is platform-agnostic and stable across releases. So with the Design panel as the foreground tab in its group, a **minimised** VS Code still polls today.
>
> **The bug is unchanged in severity — only the repro is wrong**, and the corrected framing is worse than the original: live refresh for browser clients is gated on the extension's Design tab being the **foreground tab of its editor group**. It therefore dies precisely when the user is doing anything else in VS Code (any other editor tab in that group is foreground ⇒ `visible === false`), when the Design panel is **closed** (`onDidDispose` ⇒ `_stopExternalFilePoll` + `_panel === undefined`), and **always** in the standalone host (no `_panel` at all). All three are confirmed by code inspection. The product intent quoted above still holds; only "minimised" must be read as "not looking at the Design tab in VS Code". Manual tests updated accordingly; the minimise case is retained as a **negative control** (it should already work today).

**Amplification found during the improve pass — in the standalone host the poll never runs at all.** `src/standalone/bootstrap.ts:502-510` constructs the same `DesignPanelProvider` with no webview panel (it injects `_hostSeams` and `_broadcaster` directly and calls `setApiServer(server)` at `:1009`). `this._panel` is therefore permanently `undefined` under `npx switchboard`, so `_pollTick` returns on its first line forever, and `_registerSaveTextDocListener` is never even registered. The live-refresh feature is not degraded in the standalone host — it is entirely absent. The same decoupling fixes both hosts by construction, which is why no standalone-specific work is added.

**Root cause (both bugs): per-client view state was parked on a host singleton, and the poll lifecycle was written when the webview was the only possible client.** There is no per-client seat, so "which tab am I on" and "is *a* client watching" are questions the current code cannot ask.

Corroborating evidence that per-client view state is the intended direction: `kanban.html:7202-7215` already hand-rolls a client-local shadow (`boardProjectFilter`) with the comment *"so browser and webview never reset each other"* — someone hit this class of bug and patched one instance of it locally. This plan generalises that instinct for the Design panel.

### Verified constraints that shape the design

Four facts were established by reading the transport layer. They are the reason the seat-lifecycle design below differs from the original plan's recommendation.

1. **The WebSocket is push-only and anonymous.** `wsHub` never registers `ws.on('message')`; `ConnectionMeta` is `{ ws, seq }` (`wsHub.ts:127`) and carries no client identity. `transport.js:64-68` connects to `/ws` with no identifying parameter and never sends anything upstream. Auth is a *shared* token (`?token=` or the `sb_session` cookie, `wsHub.ts:113-116`), identical for every client. **So there is today no mapping from a WS connection to an `originatorId`** — the original plan's "evict a seat on WS close where the connection is known" has no `where` to stand on.
2. **`BroadcastHub` has no per-client send.** Its whole surface is `push` (webview + `broadcastWs` fan-out), `mirrorToWs`, `pushTo(webview…)` and `pushWebviewOnly` (`broadcastHub.ts`). `wsHub.broadcast` (`:201-214`) is a loop over all connections; `wsHub.send(ws, …)` (`:220`) needs a `ws` reference nobody has on the HTTP path. Piece 1's "addressed reply" is therefore necessarily **tag-in-message + client-side filter**, not a targeted socket write. Consequence: "address a push to N seats" costs N tagged copies on the wire, and a *single*-tagged broadcast is **dropped by every other client** under piece 1's inverted-polarity guard.
3. **The provider cannot tell the two transports apart.** The webview path calls `_handleMessage(message)` (`:558-562`, `:662-666`); the HTTP path calls `handleServiceVerb` → `_handleMessage({ ...payload, type: verb })` (`:85`). The messages are indistinguishable at the arm. Identifying "the extension webview's seat" therefore requires an explicit, non-forgeable stamp.
4. **An abrupt client death does not close the socket (research, 2026-07-28).** `ws` does **not** reliably emit `close`/`error` when a browser tab or process is killed without a close frame or TCP FIN/RST — the connection goes **half-open**, stays `readyState === OPEN` on the server, and kernel TCP keepalive defaults leave it there for up to **2 hours** (Linux `tcp_keepalive_time` = 7200 s). `ws` ships **no** automatic keepalive; the documented remedy is a server-side 30 s ping / `pong`-flag / `terminate()` loop. `wsHub` (`:87-161`) has no such loop today, so connection-scoped seats need one — without it a killed browser tab leaves a phantom connection, a phantom seat, and a poll timer that never stops. Decisive advantage over the lease alternative: protocol-level ping/pong is answered by the browser's **network stack**, not by page JavaScript, so it is immune to the background-tab timer throttling in constraint #5.
5. **Browser background-tab timer throttling makes a client-side heartbeat unreliable (research, 2026-07-28).** A hidden tab's `setInterval` is clamped to ~1 Hz after ~5 s, and Chrome's *intensive* tier clamps it to **once per minute** once the page has been hidden >5 min (with nesting depth ≥5, silent ≥30 s, no WebRTC); Safari applies Page Throttler / App Nap and may suspend outright. **An open WebSocket does not exempt a page from throttling.** A main-thread heartbeat therefore needs a **10–15 minute** server TTL to be safe, or a Web Worker (not subject to main-thread DOM timer clamps) plus a `visibilitychange` flush. This is why the lease design is the fallback, not the primary.
6. **Schema validation will not reject the new fields.** `validateVerbPayload` (`verbSchemas.ts:49-77`) only type-checks *declared* fields and ignores unknown ones; `activeTabChanged`'s schema declares `tab` only (`:145-149`). So `originatorId` and a transport stamp pass without a schema change — and no new verb is required by the design below, so `protocol-catalog.json` / `src/generated/verbAllowlist.ts` need no regeneration and the Design return-contract ceiling (`scripts/verb-return-contract-baseline.json` → `"Design": 10`) is unaffected, provided no new `break` is introduced in `_handleMessage`.

## Metadata
- **Tags:** bugfix, refactor, reliability, backend, ui
- **Complexity:** 7
- **Release phase:** Piece 2 of 3 in the browser/extension view-independence set. **Depends on piece 1** (`per-client-reply-addressing-design-panel.md`) for the `originatorId` carrier — the seat key. Ship piece 1 first.

> **Superseded:** `**Tags:** bugfix, architecture, design-panel, browser, cross-host, live-refresh`
> **Reason:** `architecture`, `design-panel`, `browser`, `cross-host` and `live-refresh` are not in the allowed tag vocabulary, so they are dropped silently on import and the plan ends up effectively tagged `bugfix` only.
> **Replaced with:** `bugfix, refactor, reliability, backend, ui` — all in-vocabulary, and `reliability` carries the live-refresh/leak dimension the invented tags were reaching for.

> **Superseded:** `**Complexity:** 5`
> **Reason:** 5 was scored against the field-to-seat migration alone. The work also introduces a **new state-ownership pattern** in a 4,574-line shipped provider, **inverts a timer lifecycle** whose failure mode is an unbounded `setInterval` in the extension host, touches **four files across two hosts** (`DesignPanelProvider.ts`, `design.js`, `transport.js`, `wsHub.ts`), and its worst failure is silent. That is the 7–8 band ("new patterns, complex state"), not the 5–6 band.
> **Replaced with:** **Complexity: 7** → route to Lead Coder.

## User Review Required

- **None.** The single open call — the narrow `wsHub` liveness exception — was **approved by the user on 2026-07-28**. Recorded as a decision below; nothing here is left for the implementer to ask about.

### Decision: narrow `wsHub` liveness exception — APPROVED (2026-07-28)

The seat-lifecycle design needs *one* thing the original plan (and piece 1) declared out of scope: the WS connection must know which client owns it, **and it must be able to tell when that client dies**. Approved scope:

- `?originatorId=` on the WS URL (`transport.js:64-68`);
- an `originatorId` field on `ConnectionMeta` (`wsHub.ts:127`) plus an `onDisconnect` callback;
- a server-side **30 s ping / `pong`-flag / `terminate()` keepalive loop** — not optional. Per constraint #4 an abruptly-killed tab sends nothing, so without the ping loop "the seat dies with its socket" is false and the poll timer never stops.

Still excluded: addressed sends and any HTTP↔WS reply-correlation registry (piece 1's actual objection). ~25 lines total, liveness only.

**Rationale for approving rather than taking the lease fallback.** The keepalive fixes a defect that already exists independently of this plan: `broadcast()` (`wsHub.ts:201-214`) loops every connection and `_safeSend` gates on `readyState === OPEN` (`:191-195`) — but a **half-open socket reads OPEN**, so today `wsHub` accumulates dead connections until the kernel gives up (hours), `connectionCount` (`:229`) overstates reality, and every panel writes pushes into the void. Harmless while nothing depends on connection liveness; harmful the moment seats do. The lease fallback, by contrast, leaves the plan's headline leak only half-fixed and prices it at a 15-minute TTL that is dictated by browser power-management behaviour rather than chosen (constraint #5).

**Mandatory sequencing — the keepalive lands FIRST, as its own commit.** It is the widest-blast-radius edit in the change set (it applies to every panel's connections, not just Design), so it ships and is verified alone: Board, Project, Design and Setup all keep receiving pushes across at least three 30 s ticks with no healthy client terminated, and the interval is cleared by `close()`. Only then does the seat work land on a transport already proven. This keeps the cross-panel risk independently revertable.

> **Superseded:** *"Seat lifecycle / eviction … Recommended: evict a seat on WS close where the connection is known, plus a last-seen timestamp with idle expiry (a few minutes past the poll interval) … Confirm the idle-expiry approach rather than relying only on disconnect detection."*
> **Reason:** Both halves are broken as written. (a) "WS close where the connection is known" — verified: the connection is *never* known; `ConnectionMeta` is `{ws, seq}` and nothing upstream carries `originatorId` (`wsHub.ts:127`, `transport.js:64-68`). (b) **Idle expiry actively re-creates the bug this plan exists to fix**: a client passively watching a preview sends *zero* messages for as long as it watches, so any finite idle timeout evicts a live watcher, stops the poll, and kills live refresh silently — the exact symptom. Adding a client heartbeat to refresh the lease then walks into browser **background-tab timer throttling** — confirmed by research (constraint #5): a hidden tab is clamped to ~1 Hz, Chrome's intensive tier to **once per minute** after 5 minutes hidden, Safari may suspend the page outright, and **an open WebSocket does not exempt it**. The beat interval and TTL become a guess about throttling behaviour.
> **Replaced with:** **connection-scoped seats.** A browser seat's lifetime *is* its WebSocket's lifetime — no timers, no leases, no throttling exposure:
> 1. `transport.js` appends `?originatorId=<clientOriginatorId>` to the WS URL (piece 1 already generates that ID in `design.js`; export it on `window` so `transport.js` can read it).
> 2. `wsHub` stores it on `ConnectionMeta` and invokes a registered `onDisconnect(originatorId)` callback from the existing `ws.on('close')` / `ws.on('error')` handlers (`:153-159`).
> 2b. **`wsHub` runs the documented `ws` keepalive** — a 30 s interval that `terminate()`s any connection whose `pong` did not arrive since the last tick, so an abruptly-killed tab is detected in ≤60 s instead of never (constraint #4). `terminate()` fires `close`, which feeds step 2, so eviction needs no separate path. Protocol-level ping/pong is answered by the browser's network stack, so this is **immune** to the timer throttling that sinks the lease alternative.
> 3. `DesignPanelProvider` evicts that seat **after a 60-second grace** — `transport.js`'s reconnect backoff caps at 30 s (`:126-133`), so a transient drop must not evict. Worst-case total from abrupt tab kill to poll stop: ping detection (≤60 s) + grace (60 s) ≈ 2 minutes, bounded and observable.
> 4. **Re-assertion on reconnect** closes the recovery hole: `transport.js` dispatches a `sbTransportReconnected` window event on a *re*-open, and `design.js` responds by re-posting `activeTabChanged` plus re-registering its active preview from `state.activeSource` / `state.activeDocId` / `state.activeDocSourceFolder` (already tracked, `design.js:1358-1362`). This makes seats self-healing and also fixes today's silent post-blip staleness.
> 5. The **extension webview's seat is pinned** to the panel's lifetime (created on its first message, dropped in `onDidDispose`) and is the only seat whose contribution tracks `_panel.visible`.
> Residual bound: seats ≤ live WS connections + 1, checked by an assertion in the disconnect path.

> **Superseded:** *"Poll scope with multiple clients on different polled tabs … Confirm the union-scan is acceptable versus its extra I/O per tick."*
> **Reason:** Framed as an open question, but it has a determinate answer: `_isPolledTab` (`:4153`) admits exactly four tabs, so the union is bounded at **4** regardless of client count. Worst-case tick I/O equals what a single client already costs by visiting all four tabs, and `_lastFolderSignature` is already keyed by tab (`:194`) so no new bookkeeping is needed. There is nothing for the user to weigh.
> **Replaced with:** **Decision: one shared timer, union-iterate the distinct polled tabs across live seats.** Cost is bounded by 4 tab-scans per tick, not by client count, and `design.externalFilePollMs` (`:4168`, default 4000; `<= 0` disables) remains the escape hatch. **Accepted trade-off:** `shell.js` mounts every panel iframe up-front and keeps each one's WebSocket alive across panel switches (`shell.js:5-6`, `:124-127`), so the Design seat persists — and the poll keeps running — while the user is looking at the Board. That is the same cost the extension pays today whenever its Design panel is visible, and it is user-tunable via the same setting. Do **not** add shell→iframe deactivation messaging for this.

### Rejected alternative — heartbeat lease (recorded for audit; do NOT implement)

Retained only so the trade-off is auditable. The `wsHub` exception was approved, so this variant is **not** the path. Had it been vetoed, the shape would have been:

Heartbeat lease, in this exact shape (the details are what make it survivable — research tightened all three numbers): `design.js` posts an existing-verb re-assertion — `activeTabChanged` carrying its `originatorId` — every **30 s**, *and* on `visibilitychange`/`focus` as an immediate flush; the host expires a seat after **15 minutes** without a beat. The TTL must clear Chrome's intensive tier (1 beat/minute) *and* Safari's App Nap suspension with headroom, so 5 minutes — the original guess — is **not** safe; 15 is. Because the beat *is* a full re-assertion, an over-eager eviction self-heals on the next beat. If a 15-minute leak window for a dead client is unacceptable, drive the beat from a **Web Worker** (not subject to main-thread DOM timer clamps) and the TTL can come back down to ~2 minutes — at the cost of a new worker file in the shared webview. Emit the beat from every client uniformly (do not sniff for the headless host) so `design.js` stays byte-identical across hosts per PRD contract #1. No new verb, no catalog regeneration.

## Scope

### ✅ IN SCOPE
1. **Per-client seat store** — replace `_activeTab` and the three `_active*Preview` singletons with a `Map<originatorId, DesignClientSeat>` holding `{ activeTab, htmlPreview, claudePreview, stitchHtmlPreview, isExtensionWebview }`, plus a seat for the extension webview. Lifetime per the connection-scoped decision above.
2. **Rewrite the `activeTabChanged` arm (`:2396-2413`)** to mutate only the calling client's seat — so it can no longer null another client's preview registration. **Also make `stitchHtmlListDocs`'s `_activeStitchHtmlPreview = null` (`:3559`) seat-local**, for the same reason.
3. **Re-point the `fetchPreview` arm's preview registrations** (`:2557`, `:2577`, `:2583`, `:2591`, `:2593`) at the caller's seat instead of the shared fields.
4. **Decouple the poll lifecycle from `_panel.visible`** — drive start/stop from "does any live seat sit on a polled tab", where the extension's own seat still contributes its visibility (a hidden extension panel withdraws *its* seat, it does not gate everyone else's). Covers all eight gates enumerated in the table above: `_pollTick` (`:4183`, `:4220`), `_onVisibilityChanged` (`:4158`), `activeTabChanged` (`:2407`), the config-change restarts (`:630`, `:736`), the two `onDidDispose` stops (`:570`, `:674`), and the watcher/save path's panel gates (`:4439`, `:4487`).
5. **Poll-driven pushes.** See the superseded callout below — these stay broadcast.
6. **Re-point the watcher-driven auto-refresh** (`_autoRefreshHtmlPreview`, `:4468-4509`) at seats, so a file change re-pushes to each client previewing that document rather than to whatever the last shared registration happened to be. **This requires keying `_autoRefreshDebounce` per (seat, target)** — see the Complex/Risky audit; a single shared debounce silently collapses N seats into one refresh.
7. **Transport stamp** — mark messages arriving via `handleServiceVerb` so the provider can identify the extension webview's seat. Stamp it **after** the payload spread (`:85`) exactly as `type` already is, so a client cannot forge it.
8. **Narrow `wsHub` liveness extension (approved)** — `originatorId` on the WS URL + `ConnectionMeta`, an `onDisconnect` hook, the 30 s ping/`terminate()` keepalive, and the reconnect re-assertion event. **Ships as its own commit, before the seat work** (see the approved decision above). Side benefit, in scope by consequence: the keepalive also reaps the half-open connections `wsHub` accumulates today, so `connectionCount` stops overstating and no panel keeps broadcasting into dead sockets.

> **Superseded:** *"Address poll-driven pushes to the seats that want them — a re-push for a polled tab goes to the clients on that tab, via piece 1's addressed-reply path."*
> **Reason:** Wrong by piece 1's own taxonomy, and actively harmful. The poll's only outputs are the four `_send*DocsReady` folder listings (`:4226-4234`), which are **shared data**, not per-client replies — piece 1 classifies shared data as "should broadcast". Their `design.js` handlers (`:3408`, `:3553`, `:3568`) are idempotent list re-renders: they update `state.*FolderPathsByRoot` and re-render that tab's tree, with no tab switch and no selection change, so a client on another tab is unaffected. Worse: `BroadcastHub` has no per-client send (constraint #2), so "addressed" means tagging the payload with **one** `originatorId` — and piece 1's inverted-polarity guard sits on `design.js`'s single `message` listener, so every *other* client would **drop** its folder-list update. Addressing this push would therefore manufacture a new silent-staleness bug. The watchers already broadcast these same payloads regardless of tab today, so broadcasting from the poll is behaviour-consistent.
> **Replaced with:** **Poll-driven `*DocsReady` pushes stay broadcast, untagged** (untagged messages pass piece 1's guard by design). Only the *preview* re-push — `previewReady` out of `_buildAndSendPreview` (`:4408-4423`) on the watcher/save path — becomes seat-addressed, one tagged emit per matching seat.

### ⚙️ OUT OF SCOPE
- The reply-addressing mechanism itself (piece 1 delivers `originatorId` end-to-end; this plan consumes it).
- The Kanban project filter (piece 3, `kanban-project-filter-client-local.md`).
- Persisting view state across reloads. Seats are in-memory only. Note that `persistTabState` (`:2357`) already persists tab state to `PanelStateStore`, and that store is **panel-scoped, not client-scoped** (`PanelStateStore.ts:46` keys on `switchboard.panelState.<panelKey>.<tabKey>`) — so two clients still share persisted tab state across restarts. Deliberately unchanged here: it is a restart-time seed, not live cross-talk, and re-keying it would change shipped persisted state (see Migration below).
- `wsHub` **addressing** — targeted sends, an HTTP↔WS reply-correlation registry, or any change to `broadcast()` semantics. This remains out of scope; only the liveness fields/hook in Scope §8 are admitted.

> **Superseded:** *"OUT OF SCOPE: `wsHub` addressing / connection-registry changes."* (as a blanket exclusion)
> **Reason:** The exclusion was inherited from piece 1, where it ruled out an HTTP↔WS correlation registry for *replies* — a real and still-valid objection. But taken literally it also forbids the only throttle-proof liveness signal available, which leaves eviction with no correct implementation (see the eviction callout). The objection's substance is "no targeted sends, no reply registry", not "never touch `wsHub`".
> **Replaced with:** addressed sends and reply registries stay out of scope; a **liveness-only** extension (`originatorId` on `ConnectionMeta` + a disconnect hook + the reconnect re-assertion event) is in scope, gated on the User Review approval above.
- Stitch **project** targeting stays global. `_activeStitchHtmlProjectId` / `_activeStitchHtmlWorkspaceRoot` (`:516-517`) drive a single per-project watcher and its race guards (`:3542`, `:3548`, `:3558`); making the *watcher* per-client is a separate, larger change. Consequence to accept and document in code: two clients on different Stitch projects still fight over which project is watched, though each keeps its own *preview registration* after §2. Out of scope here.

## Complexity Audit

### Routine
- Mechanical field-to-seat migration for the four state fields; call sites are enumerated above and few.
- The transport stamp: one line in `handleServiceVerb`, mirroring the existing `type`-set-last idiom (`:83-85`).
- No schema, catalog, allowlist or ratchet-baseline changes (verified constraint #6) — so none of the CI gates (`parity:check`, `verb-returns:check`, `push-routing:check`) need touching, provided the new/rewritten arms `return` and never `break`.

### Complex / Risky
- **Poll lifecycle inversion** is the risk centre: the timer must start when a browser-only client needs it and reliably stop when the last interested seat goes away, or the extension host keeps a `setInterval` doing folder I/O forever. Eviction correctness *is* poll-stop correctness — the two are the same bug if seats leak. Note the inversion now runs in **eight** places, not four, including the two `onDidDispose` handlers that today stop the poll unconditionally.
- **The shared `_autoRefreshDebounce` becomes incorrect the moment the cross-nulling is deleted.** Today at most one `_active*Preview` is non-null, *because* `activeTabChanged` nulls the other two (`:2398-2406`) — that accident is what makes a single debounce field safe for the three `checkAndRefresh` calls at `:4506-4508`. Delete the cross-nulling (Scope §2) and multiple registrations coexist across multiple seats, so each `checkAndRefresh` call `clearTimeout`s the previous one (`:4480-4481`) and **only the last seat/target refreshes** — a silent, per-client data-loss bug introduced *by* the fix. The debounce must become a `Map` keyed by `originatorId` + target, and every keyed timer must be cleared in `dispose()` (`:769-772`) and on seat eviction.
- **Seat leak → silent resource growth**, the failure mode least likely to be caught by a test and most likely to be reported as "the extension got slow". Connection-scoped lifetime is what removes the leak; assert `seats ≤ wsHub.connectionCount + 1` in the disconnect path.
- **Union scanning** raises per-tick I/O with several clients on different tabs; keep one timer. Bounded at 4 tabs (`_isPolledTab`, `:4153`).
- **Behavioural change on shipped installs (~4,000).** Today a hidden Design panel means zero poll timers and zero watcher pushes; after this change a live browser seat keeps a 4-second folder scan running in the extension host with the panel hidden *or closed*. That is the intended fix, but it is new background work for anyone running the browser cockpit, and it must not run when there are no seats at all.
- **The `wsHub` keepalive is a shared-transport change.** A 30 s ping/`terminate()` loop applies to **every** panel's connections, not just Design, and a mis-set `isAlive` flag would terminate healthy Board/Project clients — a cross-panel outage sourced from a Design-panel plan. It is nine lines of well-documented boilerplate, but it is the highest-blast-radius edit in the change set and must be reviewed against the `ws` FAQ pattern line by line, including the interval teardown in `close()` (a leaked interval keeps the standalone process alive after shutdown).

## Edge-Case & Dependency Audit

- **Race conditions:**
  - A client can change tab while a poll tick is mid-scan; push results must be re-checked against the seat's *current* tab before delivery, or a client gets data for a tab it just left. Existing per-client `requestId` sequencing (`design.js:1362`) remains the in-client staleness guard. The post-scan recheck at `:4220` becomes "is any live seat still on `tab`" rather than "`_activeTab === tab && _panel.visible`".
  - **Eviction vs. in-flight tick:** a seat can be evicted between the start of a tick and its push. Re-read the seat map after every `await` — never capture a seat object across one.
  - **Grace-window reconnect:** a WS drop schedules eviction in 60 s; a reconnect inside that window must **cancel** it (same `originatorId`), and the re-assertion event must be idempotent if it arrives before the cancel.
  - **Concurrent `fetchPreview` from two seats for the same document:** both seats register; the per-(seat,target) debounce keys keep their refreshes independent.
- **Migration / shipped state:** no persisted state changes shape. Seats are in-memory. `PanelStateStore` keys are deliberately untouched — re-keying them per client *would* be a shipped-state change for ~4,000 installs and is explicitly out of scope. No DB migration, no `.switchboard/` file format change, no setting rename.
- **Backward compatibility:**
  - A request with no `originatorId` (host-initiated auto-refresh, or an unmigrated client) must map to a default/legacy seat and keep working, matching piece 1's broadcast fallback. When a panel exists, the default seat *is* the extension webview's seat — that is the real-world unmigrated case.
  - An older browser tab that stamps no `originatorId` gets the default seat and behaves as today (shared state with the webview) rather than breaking.
  - `activeTabChanged` must keep returning `{ success: true, activeTab }` (`:2412`) — `src/test/verb-engine-headless-seams.test.js:299-301` asserts exactly that shape headlessly. Return the *calling seat's* tab.
- **Side effects:**
  - The extension host now runs a poll timer with the Design panel closed. Bound it strictly to "≥1 live seat on a polled tab" and verify the timer is cleared when the last seat goes.
  - Stitch watcher re-targeting stays global (see Out of Scope) — a second client on another project still re-points the watcher.
  - Poll-driven `*DocsReady` broadcasts reach clients on non-polled tabs. Already true today via the watchers; handlers are idempotent (`design.js:3408`, `:3553`, `:3568`).
- **Dependencies & Conflicts:**
  - **Requires piece 1 merged.** Without the `originatorId` carrier there is no seat key and this plan cannot be implemented.
  - **Same-file serialisation (PRD orchestration discipline):** `DesignPanelProvider.ts` is the single largest edit surface here; no other agent stream may hold that file concurrently. `design.js` is also touched by piece 1 — serialise, do not parallelise.
  - `transport.js` / `wsHub.ts` are shared across **all** panels; the liveness edit must be additive and must not alter `broadcast()`/`send()` behaviour, or every panel's push path is at risk.
  - No new verb ⇒ no `protocol-catalog.json` / `verbAllowlist.ts` regeneration and no `verbSchemas.ts` edit (verified constraint #6).
- **Security:** `originatorId` remains a routing hint only, never an authorization input. Seat lookup must not be a path to read another client's state — a forged ID can only reach view state, which carries no secrets, but do not widen it beyond that. Two specifics for this plan: (a) the transport stamp must be set **after** the payload spread so a client cannot claim to be the extension webview (`:83-85` idiom); (b) `originatorId` on the WS URL is a label, not a credential — the existing token/Origin/Host checks (`wsHub.ts:87-123`) stay the only auth, and a forged ID must at worst cancel *its own* seat's eviction, never another's.
- **No confirmation dialogs** are added anywhere (project rule).

## Dependencies

- `per-client-reply-addressing-design-panel.md` — piece 1; delivers the `originatorId` carrier that is this plan's seat key. **Hard blocker.**
- `kanban-project-filter-client-local.md` — piece 3; independent, no ordering constraint.
- No agent session IDs apply (`sess_…`): this plan's dependency is on a sibling plan's *merge*, not on a prior session's output.

## Adversarial Synthesis

Key risks: (1) the poll-lifecycle inversion leaves an unbounded `setInterval` doing folder I/O in the extension host if seat eviction is wrong — eviction correctness and poll-stop correctness are the same bug; (2) deleting the cross-nulling removes the accidental invariant that makes the single shared `_autoRefreshDebounce` safe, so per-seat refreshes silently collapse to one unless the debounce is keyed per (seat, target); (3) the original eviction recommendation was unimplementable (the WS carries no client identity) and its idle-timer half would have re-created the very silent-staleness bug being fixed. Mitigations: connection-scoped seat lifetime with the documented `ws` 30 s ping/`terminate()` keepalive (an abruptly-killed tab otherwise leaves a half-open socket for hours, and with it a phantom seat and an immortal timer) plus a 60 s reconnect grace and client re-assertion on reconnect; a keyed debounce map cleared on eviction and dispose; all eight `_panel`-visibility gates replaced together (including the two `onDidDispose` stops and the save/watcher gates) so the marquee scenario actually works; poll-driven folder listings left as untagged broadcasts so piece 1's inverted guard cannot drop them. Residual: the keepalive is shared by every panel's WS connections, which is the change set's widest blast radius.

## Proposed Changes

**Commit order is fixed: `wsHub.ts` keepalive first and alone, verified against all four panels, then everything else.** Within the second commit, execution order is the numbered list below; each step is independently reviewable and each file is edited by one stream only.

### `src/services/DesignPanelProvider.ts`

**Context.** 4,574 lines; the provider is the shared singleton behind both hosts (`TaskViewerProvider._startLocalApiServer` wires `designVerb` in the extension; `standalone/bootstrap.ts:502-510,982-983,1009` wires the same provider headless). Four fields (`:192`, `:513-515`) hold per-client view state; eight sites gate live-refresh on `_panel`.

**Logic.**
1. **Seat type + store.** Add
   ```ts
   interface DesignClientSeat {
       activeTab: string;
       htmlPreview: { sourceFolder: string; docId: string; sourceId: string } | null;
       claudePreview: { sourceFolder: string; docId: string; sourceId: string } | null;
       stitchHtmlPreview: { sourceFolder: string; docId: string; sourceId: string; projectId: string; workspaceRoot: string } | null;
       isExtensionWebview: boolean;
   }
   private _seats = new Map<string, DesignClientSeat>();
   private static readonly _DEFAULT_SEAT = '__default__';
   ```
   and a `_seatFor(message): DesignClientSeat` accessor that resolves `message.originatorId || _DEFAULT_SEAT`, creates on miss, and sets `isExtensionWebview` from the transport stamp. Keep the old fields **deleted**, not shadowed — a leftover shadow copy is how this bug comes back.
2. **Transport stamp.** In `handleServiceVerb` (`:85`) dispatch `{ ...(payload ?? {}), type: verb, __viaHttp: true }` — after the spread, so it cannot be forged; the existing comment at `:83-84` documents exactly this idiom for `type`. Leave the webview wiring (`:558-562`, `:662-666`) unstamped; absence means webview.
3. **`activeTabChanged` (`:2396-2413`).** Set `seat.activeTab = message.tab`; null only *that seat's* previews for the non-matching tabs; replace the poll gate (`:2407`) with `_reconcilePoll()`; return `{ success: true, activeTab: seat.activeTab }` (shape asserted by `verb-engine-headless-seams.test.js:299-301`).
4. **`fetchPreview` (`:2542-2605`).** Registrations at `:2557`, `:2577`, `:2583` and the null branches at `:2591`/`:2593` all move onto `_seatFor(message)`. The stitch branch keeps writing the *global* `_activeStitchHtmlProjectId`/`_activeStitchHtmlWorkspaceRoot` (`:2561-2565`) — watcher targeting stays global by decision.
5. **`stitchHtmlListDocs` (`:3550-3564`).** `:3559`'s `_activeStitchHtmlPreview = null` becomes `_seatFor(message).stitchHtmlPreview = null`. Project/root reassignment and the watcher re-target stay global.
6. **Poll predicate + reconcile.** Add
   ```ts
   private _polledTabsAcrossSeats(): Set<string>   // seat.activeTab where _isPolledTab, skipping the
                                                    // extension seat when !this._panel?.visible
   private _reconcilePoll(): void                   // size ? _startExternalFilePoll() : _stopExternalFilePoll()
   ```
   Replace every gate with `_reconcilePoll()` / `_polledTabsAcrossSeats()`: `:630`, `:736`, `:2407`, `:4158`, and both `onDidDispose` bodies (`:570`, `:674`) — where the panel's seat is *dropped* first, then `_reconcilePoll()` runs, so closing the panel no longer stops a browser-only poll.
7. **`_pollTick` (`:4180-4239`).** Replace the opening gate with `const tabs = this._polledTabsAcrossSeats(); if (!tabs.size) { this._stopExternalFilePoll(); return; }` and loop the existing scan body per `tab` of `tabs`. Keep `_lastFolderSignature[tab]` (`:194`) as-is. The post-scan recheck (`:4220`) becomes "`tab` still present in a freshly-computed `_polledTabsAcrossSeats()`". Keep the `catch` swallow (`:4236`) so one bad tab cannot kill the tick.
8. **Save/watcher path.** `_registerSaveTextDocListener` (`:4436-4444`): drop the `!this._panel?.visible` gate (`:4439`) and replace the "any active preview" test (`:4440`) with "any seat holds a preview". `_autoRefreshHtmlPreview` (`:4468-4509`): iterate seats × the three targets; drop the `!this._panel` gate (`:4487`); re-read the seat inside the debounce callback and bail if it vanished.
9. **Keyed debounce.** Replace `_autoRefreshDebounce` (`:518`) with `private _autoRefreshDebounces = new Map<string, NodeJS.Timeout>()` keyed `` `${originatorId}::${target ?? 'html'}` ``. Clear all entries in `dispose()` (`:769-772`) and on seat eviction.
10. **Addressed preview re-push.** `_buildAndSendPreview` (`:4310-4434`) takes an optional `originatorId` (piece 1 already threads one) and emits `previewReady` (`:4408`) / `previewError` (`:4427`) through piece 1's `_postReply`. The watcher path emits **one tagged copy per matching seat**. Leave the `requestId === -1` silent-failure branch (`:4426`) intact.
11. **Eviction + disconnect hook.** On `setApiServer`, register `onDisconnect(originatorId)`; schedule eviction at 60 s; cancel on re-registration of the same ID; on eviction, clear that seat's debounce timers and call `_reconcilePoll()`. Assert `_seats.size <= connectionCount + 1` and log (do not throw) on violation.

**Implementation notes.** Every new/rewritten arm must `return` its result — no `break` — or the Design ratchet ceiling (`"Design": 10`) fails CI. Reach the host only through `_seams()` (PRD contract #3): the new code touches no `vscode.*` except the already-`_panel`-scoped visibility read.

**Edge cases.** Default seat when `originatorId` is absent; default seat *is* the webview seat when a panel exists; seat evicted mid-tick; reconnect inside the grace window; `design.externalFilePollMs <= 0` still disables polling entirely (`:4169`); no seats at all ⇒ no timer.

### `src/webview/design.js`

**Context.** Shared byte-identical by both hosts (PRD contract #1). Piece 1 adds `clientOriginatorId` generation and the outbound auto-stamp here.

**Logic.** (a) Expose the ID for `transport.js` (e.g. `window.__sbClientOriginatorId`). (b) Add a `sbTransportReconnected` listener that re-posts `activeTabChanged` for the current tab and re-registers the active preview from `state.activeSource` / `state.activeDocId` / `state.activeDocSourceFolder` (`:1358-1362`). (c) No change to the `*DocsReady` handlers (`:3408`, `:3553`, `:3568`) — they keep receiving untagged broadcasts.

**Edge cases.** Re-assertion must be a no-op when nothing is selected; must not double-fire on the *first* connect (only on re-open); must not bypass piece 1's outbound stamp.

### `src/webview/transport.js`

**Context.** Loaded only in the browser host (`:12-13`); provides the `acquireVsCodeApi` shim and the single WS per panel iframe.

**Logic.** Append `?originatorId=` to `wsUrl()` (`:64-68`), URL-encoded, omitted when unset. In `ws.onopen` (`:80-83`), dispatch `sbTransportReconnected` when this open follows a prior close (track a boolean). Leave `onclose`/backoff (`:118-133`) unchanged.

**Edge cases.** Token still arrives via cookie or `?token=`, so the added parameter must not disturb `searchParams.get('token')` (`wsHub.ts:114-116`); the reconnect event must not fire on the initial connect.

### `src/services/wsHub.ts`

**Context.** 244 lines, shared by every panel. Auth and DNS-rebinding defenses at `:87-123` must not be touched. **This file is commit #1, landed and verified on its own** — the keepalive affects every panel's connections, so it must be revertable without unwinding the seat work.

**Logic.**
1. Add `originatorId?: string` to `ConnectionMeta`, populated from `reqUrl.searchParams.get('originatorId')` at `:114` (the `URL` is already parsed there for the token).
2. Add an `onDisconnect(cb: (originatorId: string) => void)` registration and invoke it from the existing `close`/`error` handlers (`:153-159`) when the meta carries an ID.
3. Add the keepalive from the `ws` FAQ — `isAlive` on the meta, `ws.on('pong', …)` sets it true, a **30 s** interval that calls `ws.terminate()` on any meta still `false` and otherwise sets `false` + `ws.ping()`. Clear the interval in `close()` (`:234-243`) and on `wss` close, or the standalone process will not exit.
4. **No change** to `broadcast` (`:201`), `send` (`:220`), `connectionCount` (`:229`), or the Origin/Host/token checks (`:87-123`).

**Edge cases.** Missing/empty parameter ⇒ no callback (unmigrated client). The callback must be exception-safe — a throwing consumer must not break connection teardown. `error` and `close` can both fire ⇒ the callback must be idempotent. `terminate()` on an already-closed socket must be guarded. `_safeSend`'s `readyState === OPEN` check (`:191-195`) does **not** cover a half-open socket, which is exactly why the ping loop is needed rather than relying on send failures. The keepalive is **shared by every panel** — verify the Board and Project panels still receive pushes across a full 30 s tick and that no client is terminated while healthy.

### `src/test/` (new coverage)

Add the assertions listed under Verification Plan to the existing headless-seams harness (`verb-engine-headless-seams.test.js`) so seats are exercised with **no `vscode` reachable** (PRD contract #3's acceptance signal).

## Verification Plan

*This improve pass ran **no** compilation and **no** tests (session directive). Everything below is specification for the implementer.*

### Automated Tests

**Gate for commit #1 (`wsHub` keepalive) — must pass before any seat work lands:** a healthy client answering `pong` survives at least three 30 s ticks untouched; a client that stops answering is `terminate()`d and its `close` fires; `close()` clears the interval (no live handle keeps the process alive); `broadcast()`, `send()` and `connectionCount` behave exactly as before for healthy connections. Manual companion: Board, Project, Design and Setup all still receive pushes after several minutes of an idle session.

**Commit #2 (seats):**
- Client A on `html-preview` with a registered preview; client B sends `activeTabChanged: 'images'` → **A's preview registration survives** (this is the cross-nulling regression; assert it directly).
- Same assertion for the Stitch path: client B sends `stitchHtmlListDocs` for a different `projectId` → **A's `stitchHtmlPreview` survives** (`:3559` regression).
- Two clients on different tabs each receive pushes only for their own tab *previews*; both still receive the untagged `*DocsReady` folder listings.
- With **no** extension panel (or `_panel.visible === false`) but one browser seat on `html-preview`, the poll timer **runs** and a file change reaches that client.
- Closing the extension Design panel (`onDidDispose`) with a live browser seat on a polled tab **does not** stop the timer.
- When the last seat leaves every polled tab, the timer stops (assert `_externalFilePollTimer` cleared — the leak guard). Same assertion after the last seat is *evicted*.
- Two seats previewing the **same** document both receive an auto-refresh from one file change (the keyed-debounce regression; a shared debounce makes this fail with exactly one push).
- A WS disconnect schedules eviction; a reconnect with the same `originatorId` inside the grace window cancels it and the seat's tab/preview survive.
- **Abrupt client death** (simulate a half-open socket: hold a connection open and stop answering `pong`) → the keepalive `terminate()`s it, `onDisconnect` fires, the seat is evicted after the grace, and the poll timer stops. Without the keepalive this test hangs indefinitely — that is the point of it.
- The `wsHub` keepalive interval is cleared by `close()` (assert no live handle keeps the process alive), and a client answering `pong` normally is **never** terminated across at least three ticks.
- A message with **no** `originatorId` maps to the default seat and behaves as today.
- `activeTabChanged` still returns `{ success: true, activeTab }` (existing assertion, `verb-engine-headless-seams.test.js:299-301`).
- Seat count never exceeds `wsHub.connectionCount + 1` across a connect/disconnect churn loop.

### Manual
- **Primary repro (corrected).** Browser Design panel on HTML preview; in VS Code, click any **other editor tab in the Design panel's group** so the Design webview is no longer foreground (`visible === false`); edit the previewed file on disk → the browser updates. Today it does not — this is the silent second bug.
- Same check with the Design panel **closed** (`onDidDispose`) → the browser still updates.
- **Negative control:** **minimise VS Code** with the Design panel still the foreground tab of its group, and edit the previewed file → the browser updates. Per research this already works *today* (minimise does not clear `visible`), so it must keep working after the change; if it fails, the new seat/visibility wiring has regressed the extension seat's contribution.
- Browser on Images, extension on HTML preview, edit the previewed HTML → the extension updates and the browser stays on Images.
- Save a previewed file **from the VS Code editor** with the Design panel hidden → the browser preview refreshes (the `:4439` gate).
- Close the browser tab, confirm the extension still live-refreshes and no stray timer remains.
- Close the **extension** Design panel with the browser open on a polled tab → the browser keeps live-refreshing.
- `npx switchboard` with no extension running: pick an HTML preview, edit the file on disk → the browser updates (today the poll never runs at all in this host).
- Kill the network to the WS (or suspend/resume the machine) → after reconnect the browser resumes live refresh without a manual tab click.
- Force-kill the browser (not a graceful tab close) with a seat on a polled tab → within ~2 minutes the seat is evicted and the poll timer stops.

## Uncertain Assumptions

**None open.** All three assumptions this plan depended on were resolved by web research on 2026-07-28 and folded into the body above. Recorded here so the implementer does not re-litigate them:

1. **`WebviewPanel.visible` tracks editor-tab/editor-group layout only** — OS-window minimise, occlusion and focus loss do **not** flip it and do **not** fire `onDidChangeViewState` (that is `window.onDidChangeWindowState` / `WindowState.focused`). Platform-agnostic and stable across releases; `retainContextWhenHidden` does not change it. **Consequence:** the plan's "minimised VS Code" mechanism is falsified (flagged in the Goal, original sentence preserved); the real gate is "Design tab is not the foreground tab of its group", plus the closed-panel and standalone cases. Repro steps and manual tests corrected; the fix is unchanged.
2. **`ws` does not reliably emit `close`/`error` on abrupt client death** — half-open sockets stay `OPEN`, kernel TCP keepalive defaults to 2 hours, and `ws` ships no automatic keepalive. **Consequence:** the `wsHub` liveness change must include the documented 30 s ping / `pong`-flag / `terminate()` loop (constraint #4, Scope §8, `wsHub` proposed changes).
3. **Background-tab timers are clamped to ~1 Hz when hidden and to once per minute under Chrome's intensive tier (>5 min hidden, nesting ≥5, silent ≥30 s, no WebRTC); Safari may suspend via App Nap; an open WebSocket grants no exemption.** **Consequence:** the client-heartbeat fallback needs a **15-minute** TTL (not the 5 minutes originally guessed) or a Web Worker beat; the connection-scoped primary is throttle-immune because ping/pong is handled by the network stack, not page JS.

**Stage Complete:** CREATED

**Recommendation:** Complexity 7 → **Send to Lead Coder.**

## Completion Report

- **What was implemented:** Added `originatorId`, liveness tracking (`isAlive`), ping/pong keepalive, and `onDisconnect` listener support to `wsHub.ts`. Updated `transport.js` to pass `originatorId` query param and dispatch `sbTransportReconnected` on reconnect. Updated `design.js` to expose `window.__sbClientOriginatorId` and handle `sbTransportReconnected` to re-assert active tab and preview. Refactored `DesignPanelProvider.ts` to replace single shared `_activeTab` and `_active*Preview` singletons with per-client seats (`_seats` Map), keyed auto-refresh debounces (`_autoRefreshDebounces` Map), and decoupled poll lifecycle (`_polledTabsAcrossSeats`, `_reconcilePoll`) so browser clients retain independent view states and polling continues even when the VS Code panel is hidden or closed.
- **Files changed:**
  - `src/services/wsHub.ts`
  - `src/webview/transport.js`
  - `src/webview/design.js`
  - `src/services/DesignPanelProvider.ts`
- **Issues encountered:** None. All edits implemented without disrupting existing return contracts or host seams.
