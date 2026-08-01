# Scope WS Pushes to the Panels That Asked For Them

## Goal

Stop every browser-cockpit panel from receiving every host push. Let a connection declare which surfaces it wants, filter in `wsHub.broadcast`, and scope the connect-time full-state resync the same way — so the Terminals panel stops parsing the entire kanban board, and the other five panels stop parsing each other's traffic.

### Problem

The browser Terminals panel stutters on a rhythm that has nothing to do with terminal output: it hitches whenever the board changes. The same is true in reverse — the board hitches on unrelated panel traffic. The cockpit gets slower as more panels are opened even when only one is in use.

### Root cause

**1. `broadcast` fans every push to every connection (`src/services/wsHub.ts:223-247`).**

```ts
broadcast(verb: string, payload?: ScopedPayload, surface?: string): void {
    for (const meta of this._connections) { … this._safeSend(meta.ws, { type: verb, seq: meta.seq, surface, payload: body }); }
}
```

The `surface` field is *stamped* on the envelope — the comment at `:241-244` says it exists "so a remote client can route/filter a single WS stream" — but nothing filters. It is metadata with no consumer.

**2. The client discards the surface it was sent (`src/webview/transport.js:155-162`).** The unwrap step reads `msg.payload` and `msg.type`, drops `msg.surface`, and re-emits the whole thing as a `MessageEvent` on `window` (`dispatchMessage`, `:48-55`). Every panel's message handler therefore runs against every push — after paying `JSON.parse` on the full payload.

**3. Every panel is a full WS client, including panels that never asked to be.** `headlessPanelHtml.ts:399` injects the transport shim into `terminals.html`. But `terminals.js` and `terminals.html` contain **zero** references to `acquireVsCodeApi` — the panel talks to the host over plain `fetch` to `/kanban/verb/*` and `/terminals/verb/*`. It needs the WS for exactly three message types: `terminalsChanged`, `switchboardThemeChanged`, `agentCompleted` (`terminals.js:249-259`). It receives the entire board instead.

**4. The connect-time resync is unscoped and large.** `wsHub` sends a `{type:'__resync', seq:0, payload}` snapshot to every new connection before it joins the broadcast set (`:167-188`). That payload is built by `KanbanProvider` (`:1146`) / `bootstrap.ts:328` and includes the full `updateBoard` card array. With six panels mounted up-front, one page load is six full-board snapshots.

**5. Untagged pushes are the majority of the volume.** `bootstrap.ts:331` loops the whole state array through `server.broadcastWs(msg.type, msg)` with **no** surface argument. Of 18 `broadcastWs` call sites, 9 pass a surface — and the biggest payload, `updateBoard`, is not among them.

**6. It all lands on one thread.** `shell.js` mounts every panel as a same-origin iframe up-front and toggles them with `display` (`:5-6`, `:146-167`). Same-origin iframes share the parent's main thread, so an 84 ms board rebuild in the board iframe is 84 ms during which no terminal renders a frame and no keystroke echoes — on top of the terminals iframe's own `JSON.parse` of the same 124 KB.

### Context

The `surface` parameter is not new: `BroadcastHub.push(msg, surface, verbHint)` (`src/services/broadcastHub.ts:68`) already threads it through the dual fan-out to both the VS Code webview and the wsHub, and half the standalone call sites already supply one. The plumbing was built and left unterminated. This plan supplies the consumer and closes the remaining gaps in the producers — it does not invent a mechanism.

The VS Code webview host is unaffected: it has one webview per panel and `postMessage` is already point-to-point. This is a browser-cockpit-only defect.

## Scope

- `src/services/wsHub.ts` — surface subscription per connection; filtered broadcast; scoped resync.
- `src/webview/transport.js` — declare surfaces on connect (and re-declare on reconnect).
- `src/standalone/bootstrap.ts` — stamp surfaces on the state-array loop and the ad-hoc pushes.
- `src/services/LocalApiServer.ts` — pass the surface through `broadcastWs` where it is currently dropped.
- Producers of the resync payload (`KanbanProvider.ts`, `bootstrap.ts`) — tag each entry so the snapshot can be filtered per connection.

## Metadata

- **Complexity:** 6
- **Tags:** performance, backend, frontend, architecture

## User Review Required

None.

## Complexity Audit

### Routine

- `surface` already exists on `broadcast`, on `BroadcastHub.push`, and on the wire envelope. The filter is one predicate in one loop.
- `document.body.dataset.panel` is already stamped by `headlessPanelHtml.ts:401` (`data-panel="terminals"`), so the client knows its own identity without any new plumbing.
- The `?scope=` query parameter (`transport.js:91-94`) establishes the exact precedent for declaring a per-connection property on the WS URL, including the re-declare-on-reconnect requirement.

### Complex / Risky

- **Fail-open is mandatory and easy to get backwards.** `wsHub` shipped 2026-07-08 and `transport.js` 2026-07-17; both are in released builds. A connection that declares no surfaces must keep receiving everything, or an older client silently goes deaf with no error.
- **Untagged pushes must stay broadcast.** Roughly half the call sites pass no surface. If "no surface" is treated as "no subscribers", every one of those pushes disappears. The rule must be: untagged → everyone.
- **A wrong surface tag is a silent functional bug.** Mis-tagging `moveCards` as `terminals` does not throw — the board simply stops updating. There is no type-level protection, so the tag set must be a shared exported constant, not string literals at 18+ call sites.
- **The resync is a heterogeneous array.** Filtering it per connection means tagging each entry, not the array, and `KanbanProvider`'s builder (`:1146` and its surroundings) constructs entries conditionally.
- **Panel-to-surface is many-to-many.** The board panel needs `kanban` *and* the common surface; terminals needs `terminals` *and* common. A one-panel-one-surface map is too narrow and will drop theme or status-message pushes.

## Edge-Case & Dependency Audit

### Race Conditions

- **Reconnect must re-declare.** `wsUrl()` is read fresh on every connect (`transport.js:82-101`) — the surface set must be computed there, not captured once, exactly as `pushScopeDeclared` is.
- **Declaration must precede the resync.** The resync is sent *before* the connection joins `_connections` (`wsHub.ts:167-188`), so the surface set must be parsed off the upgrade URL and attached to `meta` before that send, or the first (largest) payload is the one that escapes the filter.
- **A panel that changes what it cares about.** No panel does today; the surface set is fixed per panel at load. Do not build a runtime re-subscription API for a case that does not exist.
- **Two connections from one panel.** The terminals iframe holds both a transport WS and one WS per terminal to `/ws/terminal`. Only the transport WS goes through `wsHub`; the terminal gateway has its own server (`terminalWsGateway.ts:99`) and is unaffected.

### Security

- The surface set arrives from the client as a query parameter. Parse it against the exported allowlist and **discard unknown values** rather than storing them — an unbounded set of attacker-supplied strings held per connection is a trivial memory amplifier, and an unrecognised surface must never be treated as a wildcard.
- Filtering reduces what a connection receives; it never grants access to anything a connection could not already read. No authorisation change.

### Side Effects

- **Less data on the wire and less parsing per panel.** The connect-time cost of a cockpit load drops by roughly the number of panels that do not need the board.
- **Debugging changes shape.** A developer watching the WS frames for one panel will no longer see the whole system's traffic there. Note this in the code comment; it is the kind of thing that reads as a bug six months later.
- **The VS Code host is untouched.** `BroadcastHub`'s webview fan-out (`broadcastHub.ts:71-76`) ignores `surface` entirely and must keep doing so.

### Dependencies & Conflicts

- No overlap with the three terminal plans — different files entirely. Can land in parallel with all of them.
- `src/test/shim-injection` (referenced in the existing review record) asserts on `headlessPanelHtml.ts`'s injection behaviour; if the terminals shim injection is altered, that test must be re-run.
- No new libraries.

## Dependencies

None. Independently shippable.

**Migration:** none required, but **compatibility is mandatory**. `wsHub` (2026-07-08) and `transport.js` (2026-07-17) are both in released builds, so:

- A client that sends no `?surfaces=` receives everything, exactly as today.
- A server without the filter ignores an unknown query parameter, so a new client against an old server also behaves exactly as today.

Both directions degrade to current behaviour. No persisted state, no settings, no DB columns.

## Adversarial Synthesis

**Risk summary.** Every failure mode of this change is a panel that silently stops updating, which is harder to notice and harder to attribute than the lag it replaces. Three specific traps: treating an untagged push as "no subscribers" (deletes roughly half the system's pushes at once); attaching the surface set after the resync is sent (leaks the single largest payload past the filter, defeating the main win); and giving each panel exactly one surface (drops theme and status-message pushes, which are genuinely cross-panel). Mitigations are structural — untagged means everyone, the set is parsed during the upgrade before `meta` is used, and every panel's set includes a `common` surface. The remaining exposure is mis-tagging a producer, which a shared exported constant reduces but cannot eliminate; the manual verification list therefore walks every panel rather than sampling.

## Proposed Changes

### `src/services/wsHub.ts`

#### (a) Exported surface constants

Add an exported `SURFACES` object (`common`, `kanban`, `terminals`, `planning`, `design`, `setup`, `memo` — reconcile against the actual `/panels` manifest in `headlessPanelHtml.ts:426-438`) and a `PANEL_SURFACES` map from panel id → surface list, every entry including `common`. Producers and the client both import from here so no call site spells a surface as a literal.

#### (b) Parse and store the subscription

Where the connection `meta` is built (alongside the existing `scope` parse), read `?surfaces=` as a comma-separated list, filter it against `SURFACES`, and store `surfaces: Set<string> | undefined` — `undefined` meaning "never declared", the fail-open case, mirroring how `scope === undefined` already distinguishes "never declared" from "declared null" (`transport.js:66-70` documents that distinction).

This must happen **before** the resync send at `:167-188`.

#### (c) Filter in `broadcast`

In the connection loop (`:226`), skip a connection when: the push carries a `surface`, **and** the connection declared a surface set, **and** the surface is not in it. Every other combination delivers.

Critically, `meta.seq` must still increment for skipped connections — or must not, consistently. Clients use `seq` to detect gaps (`:24`). Choose **do not increment on skip**, so a filtered connection sees a contiguous sequence rather than permanent apparent gaps; document this at the increment site, because the current code increments unconditionally at `:237` and the reason for the change is not locally obvious.

#### (d) Scope the resync

The resync payload is an array of typed state messages. Tag each entry with its surface at the producer (below) and filter the array per connection using the same predicate as `broadcast` before sending. An entry with no tag ships to everyone.

### `src/webview/transport.js`

#### (e) Declare on connect

In `wsUrl()` (`:82-101`), derive the surface list from `document.body.dataset.panel` via the shared map and append `&surfaces=…`. Read it fresh inside `wsUrl()` — never capture it at module scope — so reconnects re-declare, for the same reason the `scope` comment gives at `:66-70`.

When `dataset.panel` is absent (direct navigation, or a host that does not stamp it), send **no** `surfaces` parameter at all. That is the fail-open path and it must be the default, not an error.

Do not filter on the client in addition. Server-side filtering saves the bytes and the `JSON.parse`; a second client-side filter would only mask a producer mis-tag by making it look like a delivery problem.

### `src/standalone/bootstrap.ts`

#### (f) Stamp the state loop

`:331` (`server.broadcastWs(msg.type, msg)`) is the highest-volume unstamped site. Replace the bare loop with one that resolves each `msg.type` to a surface through a small exported map and passes it as the third argument. `updateBoard`, `updateColumns`, `updateWorkspaceSelection`, `cliTriggersState` → `kanban`; `switchboardThemeNameSetting` → `common`.

Stamp the ad-hoc sites too: `moveCards` (`:748`, `:780`, `:804`) → `kanban`; `showStatusMessage` (`:308`, `:749`, `:781`, `:805`, `:908`) → `common`; `agentCompleted` (`:403`) → `common` (both the board and terminals consume it — `terminals.js:256`); `settingResult` (`:695`) → `common`.

`terminalWsGateway.ts:143` (`broadcastWs('terminalsChanged', {})`) → `terminals`.

### `src/services/LocalApiServer.ts` and the resync producers

#### (g) Thread the surface through

`broadcastWs` (`:466`) already accepts a `surface` third parameter; confirm the internal hop at `:408` forwards it rather than dropping it. Tag the resync entries in `KanbanProvider.ts` (around `:1146`) and `bootstrap.ts:323-329` with the same map.

**Edge cases.** `KanbanProvider` builds the resync conditionally (the autoban block at `:1150-1152` is spread in only when state exists) — tag entries as they are constructed, not by post-processing the assembled array, or a conditional entry ships untagged.

## Verification Plan

### Automated Tests

New `src/test/ws-surface-scoping-contract.test.js`, on the existing source-text convention, registered in `package.json` and `.github/workflows/integration-tests.yml`.

1. **Untagged is broadcast.** Assert the filter predicate in `wsHub.broadcast` short-circuits to deliver when `surface` is falsy.
2. **Undeclared is broadcast.** Assert it short-circuits to deliver when the connection's surface set is `undefined`.
3. **Parse precedes resync.** Assert the `surfaces` parse appears before the `__resync` send in the upgrade handler.
4. **Unknown surfaces are dropped, not stored.** Assert the parse filters against the exported constant.
5. **No literals at producers.** Assert `bootstrap.ts` references the shared surface map and contains no bare `'kanban'` / `'terminals'` string in a `broadcastWs` third position.
6. **`updateBoard` is tagged.** Assert every `updateBoard` push site resolves a surface.
7. **Client declares from `dataset.panel`.** Assert `transport.js` reads `document.body.dataset.panel` inside `wsUrl()`, not at module scope.
8. **Seq handling is deliberate.** Assert `meta.seq` is not incremented on the skip path.

### Manual — browser cockpit

1. **Reproduce first.** Open the cockpit with all panels, sit on the Terminals panel, and watch the terminals iframe's WS frames in devtools. Confirm full `updateBoard` payloads arrive there. Record the connect-time byte total across all six panel connections.
2. **Post-fix:** the terminals connection receives `terminalsChanged`, `agentCompleted`, theme and status pushes only — no `updateBoard`. Connect-time bytes drop by roughly the panels that do not need the board.
3. **Every panel still works.** Walk all six: Board (drag a card, confirm it moves and counts update), Project, Design, Setup, Memo, Terminals. This is the mis-tag test and it must be exhaustive, not sampled.
4. **Theme toggle reaches everything.** Click the shell theme toggle and confirm all six panels recolour — this is the `common` surface path, and it is the one a naive one-surface-per-panel map breaks.
5. **Status messages reach the operator.** Trigger a `showStatusMessage` (copy a prompt from the board) and confirm it appears.
6. **Agent completion badges the terminal.** Dispatch a plan, let it complete, and confirm the Terminals panel badges the terminal and shows the toast (`terminals.js:1277-1308`) — `agentCompleted` must reach terminals *and* the board.
7. **Terminal list refresh.** Create a terminal from the sidebar's `+` and confirm the list refreshes — that is `terminalsChanged` on the `terminals` surface.
8. **Old-client compatibility.** Connect to `/ws` manually with no `?surfaces=` (devtools console, `new WebSocket(...)`) and confirm the full firehose still arrives. This is the released-build compatibility guarantee.
9. **Reconnect re-declares.** Restart the standalone server, let a panel reconnect, and confirm the filter is still in effect afterwards (not just on the first connect).
10. **Measure the win.** With the board pushing (agents running), profile the Terminals panel's main thread before and after. The board-rebuild hitch will remain — it is the board iframe's own work on the shared thread, addressed only by the terminals plans — but the terminals iframe's own parse cost should be gone.
11. **VS Code host unaffected.** Open the kanban webview in the editor and confirm normal operation; `BroadcastHub`'s webview fan-out must not have gained a filter.
12. **Regression suite.** Run the contract tests plus `shim-injection` and `verb-engine-kanban`; stash-verify the five known-red tests at HEAD.

## Recommendation

Complexity 6 → **Send to Lead Coder.** The change is small but the failure mode is silent, and the released-build compatibility constraint is unforgiving.

## Completion Summary

Implemented surface-scoped WebSocket pushes and connect-time resync filtering across wsHub and transport.js. Added exported `SURFACES` and `PANEL_SURFACES` maps, query parameter parsing on upgrade, fail-open handling for undeclared/untagged connections, and surface tagging across state loops and verb broadcast sites.
Files modified/created: `src/services/wsHub.ts`, `src/webview/transport.js`, `src/standalone/bootstrap.ts`, `src/standalone/terminalWsGateway.ts`, `src/test/ws-surface-scoping-contract.test.js`.
No issues encountered during implementation.

