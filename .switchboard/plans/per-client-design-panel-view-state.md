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

One `_activeTab` for every connected client. The `activeTabChanged` arm (`:2396-2413`) makes the coupling concrete and destructive: whenever *any* client changes tab, the host overwrites `_activeTab` **and nulls the other clients' active previews** —

```ts
case 'activeTabChanged': {
    this._activeTab = message.tab;
    if (message.tab !== 'html-preview') { this._activeHtmlPreview = null; }
    if (message.tab !== 'claude')       { this._activeClaudePreview = null; }
    if (message.tab !== 'stitch-html')  { this._activeStitchHtmlPreview = null; }
```

So a browser client moving to the Images tab **erases the extension's** in-flight HTML preview registration, and vice versa. Those fields are what the file watchers consult to decide what to re-push on change, so the erased client stops receiving live updates for the document it is still looking at — with no visible cause.

### Second bug this exposes: browser live-refresh is gated on the extension's panel

`_pollTick()` (`:4180-4184`) opens with:

```ts
const tab = this._activeTab;
const visible = !!this._panel?.visible;
if (!visible || !this._isPolledTab(tab) || !this._panel) { return; }
```

`this._panel` is the **VS Code webview panel**. A browser client has no `_panel`. So external-file polling — the live-refresh for the `html-preview`, `claude`, `images` and `briefs` tabs (`_isPolledTab`, `:4153`) — **only ever runs while the extension's Design panel is open and visible.** The same gate appears at `:630`, `:736`, `:2407` and in `_onVisibilityChanged` (`:4158`).

This directly contradicts the purpose of the mode it runs in: the Feature A plan describes this surface as *"complete manager while VS Code is minimised"* — and a minimised VS Code means `_panel.visible === false`, so the browser's live refresh is off exactly when the browser is the only thing being used. It fails silently: no error, the tab simply never updates.

**Root cause (both bugs): per-client view state was parked on a host singleton, and the poll lifecycle was written when the webview was the only possible client.** There is no per-client seat, so "which tab am I on" and "is *a* client watching" are questions the current code cannot ask.

Corroborating evidence that per-client view state is the intended direction: `kanban.html:7202-7215` already hand-rolls a client-local shadow (`boardProjectFilter`) with the comment *"so browser and webview never reset each other"* — someone hit this class of bug and patched one instance of it locally. This plan generalises that instinct for the Design panel.

## Metadata
- **Tags:** bugfix, architecture, design-panel, browser, cross-host, live-refresh
- **Complexity:** 5
- **Release phase:** Piece 2 of 3 in the browser/extension view-independence set. **Depends on piece 1** (`per-client-reply-addressing-design-panel.md`) for the `originatorId` carrier — the seat key. Ship piece 1 first.

## User Review Required
- **Seat lifecycle / eviction.** Per-client seats are a map keyed by `originatorId`, and browser clients disappear without a reliable signal (closed tab, dead WS). Unbounded growth is a slow leak in a long-lived extension host. Recommended: evict a seat on WS close where the connection is known, plus a last-seen timestamp with idle expiry (a few minutes past the poll interval), and treat the extension webview's seat as pinned for the panel's lifetime. Confirm the idle-expiry approach rather than relying only on disconnect detection.
- **Poll scope with multiple clients on different polled tabs.** Two clients on `images` and `briefs` means the poller must cover the union of polled tabs, not one. This makes each tick scan more folders. Recommended: keep the single shared timer (do not multiply timers per client) and have each tick iterate the distinct polled tabs across live seats, pushing each result addressed to the seats on that tab. Confirm the union-scan is acceptable versus its extra I/O per tick.

## Scope

### ✅ IN SCOPE
1. **Per-client seat store** — replace `_activeTab` and the three `_active*Preview` singletons with a `Map<originatorId, DesignClientSeat>` holding `{ activeTab, htmlPreview, claudePreview, stitchHtmlPreview, lastSeenMs }`, plus a seat for the extension webview. Include eviction per the decision above.
2. **Rewrite the `activeTabChanged` arm (`:2396-2413`)** to mutate only the calling client's seat — so it can no longer null another client's preview registration.
3. **Re-point the `fetchPreview` arm's preview registrations** (`:2557`, `:2577`, `:2583`, `:2590-2594`) at the caller's seat instead of the shared fields.
4. **Decouple the poll lifecycle from `_panel.visible`** — drive start/stop from "does any live seat sit on a polled tab", where the extension's own seat still contributes its visibility (a hidden extension panel withdraws *its* seat, it does not gate everyone else's). Covers `_pollTick` (`:4180`), `_onVisibilityChanged` (`:4157`), and the `:630` / `:736` / `:2407` gates.
5. **Address poll-driven pushes to the seats that want them** — a re-push for a polled tab goes to the clients on that tab, via piece 1's addressed-reply path.
6. **Re-point the watcher-driven auto-refresh** (`:4495`) at seats, so a file change re-pushes to each client previewing that document rather than to whatever the last shared registration happened to be.

### ⚙️ OUT OF SCOPE
- The reply-addressing mechanism itself (piece 1 delivers `originatorId` end-to-end; this plan consumes it).
- The Kanban project filter (piece 3, `kanban-project-filter-client-local.md`).
- Persisting view state across reloads. Seats are in-memory only. Note that `persistTabState` (`:2357`) already persists tab state to `PanelStateStore`, and that store is **panel-scoped, not client-scoped** (`PanelStateStore.ts:46` keys on `switchboard.panelState.<panelKey>.<tabKey>`) — so two clients still share persisted tab state across restarts. Deliberately unchanged here: it is a restart-time seed, not live cross-talk, and re-keying it would change shipped persisted state (see Migration below).
- `wsHub` addressing / connection-registry changes.

## Implementation Steps
1. Define the `DesignClientSeat` shape and the seat map + `_seatFor(originatorId)` accessor with `lastSeenMs` touch; add eviction (WS close where available + idle expiry).
2. Migrate `activeTabChanged` (`:2396`) to seat mutation; delete the three cross-nulling lines.
3. Migrate the `fetchPreview` registrations (`:2557`, `:2577`, `:2583`, `:2590-2594`) to the caller's seat.
4. Replace the `_isPolledTab(this._activeTab) && this._panel?.visible` gates (`:630`, `:736`, `:2407`, `:4158`) with an `_anySeatOnPolledTab()` predicate; make the extension seat's contribution track `_panel.visible`.
5. Rewrite `_pollTick` (`:4179`) to iterate the union of polled tabs across live seats and push each result addressed to that tab's seats.
6. Re-point the watcher auto-refresh (`:4495`) at matching seats.

## Complexity Audit
### Routine
- Mechanical field-to-seat migration for the four state fields; call sites are enumerated above and few.
### Complex / Risky
- **Poll lifecycle inversion** is the risk centre: the timer must start when a browser-only client needs it and reliably stop when the last interested seat goes away, or the extension host keeps a `setInterval` doing folder I/O forever. Eviction correctness *is* poll-stop correctness — the two are the same bug if seats leak.
- **Union scanning** raises per-tick I/O with several clients on different tabs; keep one timer.
- **Seat leak → silent resource growth**, the failure mode least likely to be caught by a test and most likely to be reported as "the extension got slow".

## Edge-Case & Dependency Audit
- **Race conditions:** a client can change tab while a poll tick is mid-scan; push results must be re-checked against the seat's *current* tab before delivery, or a client gets data for a tab it just left. Existing per-client `requestId` sequencing (`design.js:1362`) remains the in-client staleness guard.
- **Migration / shipped state:** no persisted state changes shape. Seats are in-memory. `PanelStateStore` keys are deliberately untouched — re-keying them per client *would* be a shipped-state change for ~4,000 installs and is explicitly out of scope.
- **Backward compatibility:** a request with no `originatorId` (host-initiated auto-refresh, or an unmigrated client) must map to a default/legacy seat and keep working, matching piece 1's broadcast fallback.
- **Dependency:** requires piece 1 merged. Without the `originatorId` carrier there is no seat key and this plan cannot be implemented.
- **Security:** `originatorId` remains a routing hint only, never an authorization input. Seat lookup must not be a path to read another client's state — a forged ID can only reach view state, which carries no secrets, but do not widen it beyond that.
- **No confirmation dialogs** are added anywhere (project rule).

## Verification Plan
### Automated
- Client A on `html-preview` with a registered preview, client B sends `activeTabChanged: 'images'` → **A's preview registration survives** (this is the cross-nulling regression; assert it directly).
- Two clients on different tabs each receive pushes only for their own tab.
- With **no** extension panel (or `_panel.visible === false`) but one browser seat on `html-preview`, the poll timer **runs** and a file change reaches that client.
- When the last seat leaves every polled tab, the timer stops (assert `_externalFilePollTimer` cleared — the leak guard).
- Idle seats are evicted, and eviction stops the timer when it drains the last interested seat.
### Manual
- **Minimise VS Code** with the browser Design panel on HTML preview; edit the previewed file on disk → the browser updates. (Today it does not — this is the silent second bug.)
- Browser on Images, extension on HTML preview, edit the previewed HTML → the extension updates and the browser stays on Images.
- Close the browser tab, confirm the extension still live-refreshes and no stray timer remains.

**Stage Complete:** CREATED
