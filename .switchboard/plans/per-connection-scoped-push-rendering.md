---
description: "Give each connected client its own push scope. Today BroadcastHub renders ONE payload and fans it to every client, so scoped settings embedded in pushes (updateBoard.routingConfig, updateColumnDragDropModes.modes, cliTriggersState.enabled) always reflect whichever client switched project last. Adds per-connection project state on WsHub's ConnectionMeta, a scope-aware payload factory in BroadcastHub, and a pseudo-connection for the VS Code webview. Successor to the client-local project filter plan — subsumes its initiatorProject threading for the push path."
---

# Per-Connection Client Identity and Scoped Push Rendering

## Goal

**Definition of done: a host→UI push that embeds project-scoped settings is rendered per connection, so two clients on different projects each receive their own project's values — and the VS Code webview is treated as one of those connections, not as a privileged default.**

### Core problem (root-cause analysis)

The companion plan (`kanban-project-filter-client-local.md`) makes *request-scoped* state per-client by threading an `initiatorProject` value through the verb payload. That works because a verb has an initiator. **A push does not.**

`KanbanProvider.postMessage` (`:2090-2100`) delegates to `BroadcastHub.push` (`broadcastHub.ts:63-71`), which does two fan-outs from **one already-rendered payload**:

```ts
push(msg: any, surface?: string): void {
    if (this._target.webview) { this._target.webview.postMessage(msg)…; }
    else { this._pendingWebviewMessages.push(msg); }
    this.mirrorToWs(surface, msg);        // → apiServer.broadcastWs(verb, msg, surface)
}
```

and `WsHub.broadcast` (`wsHub.ts:201-214`) loops connections sending that same `payload` to each:

```ts
broadcast(verb: string, payload?: any, surface?: string): void {
    for (const meta of this._connections) {
        meta.seq += 1;
        this._safeSend(meta.ws, { type: verb, seq: meta.seq, surface, payload });
    }
}
```

The message is composed **before** the loop. Any scoped value baked into it is therefore identical for every client, and the value baked in is whatever the provider singleton held at compose time — i.e. whichever client switched project most recently.

**The affected push types, with every emit site:**

| Message | Scoped field | Emit sites (`src/services/KanbanProvider.ts`) |
|---|---|---|
| `updateBoard` | `routingConfig` ← `_routingMapConfig` | `:1113` (resync), `:2012`, `:3519`, `:3686` |
| `updateColumnDragDropModes` | `modes` ← `_columnDragDropModes` | `:2055`, `:3546`, `:3705` (composed at `:2048-2054` etc.) |
| `cliTriggersState` | `enabled` ← `_cliTriggersEnabled` | `:1112` (resync), `:2021`, `:3522`, `:3687` |
| **`overrideState`** | `activeScope`, `activeProjectName`, `projectSwitchEnabled` ← `_projectFilter` | `:2022`, `:3523`, `:3688` — the refresh push cluster, via `_postOverrideState()` (`:6437`) |

**Fourteen emit sites across four message types.**

> **Superseded:** "**The three affected push types**" / "ten emit sites" / "Ten mechanical emit-site conversions".
> **Reason:** Two counting errors, one of them load-bearing.
> **(a) Arithmetic.** The plan's own table already listed 4 + 3 + 4 = **eleven** sites while the prose said ten, in three separate places. This is a checklist number — an implementer ticking off ten and stopping leaves one push rendering from the singleton, which presents as "it works except sometimes", the hardest possible bug to chase in a fan-out path.
> **(b) A fourth message type.** `overrideState` is scope-dependent in exactly the same way and was absent entirely. `_postOverrideState()` (`:6437`) derives `projectSwitchEnabled`, `activeProjectName` and the `activeScope` string (`Project 'X'` / `Workspace` / `Global (default)`) directly from the singleton `this._projectFilter`, then pushes through the same `postMessage` → `BroadcastHub.push` rail. Its own docstring (`:6436`) names the emitters: *"Called from toggle handlers, setProjectFilter, and the refresh push cluster."* The companion plan removes the `setProjectFilter` emitter (its step 6, returning the state in the verb body instead) and keeps the toggle emitters (`:8158`, `:8170`, `:8193` — genuinely workspace-global). **The three refresh-cluster emitters are left over, and they are the frequent ones** — they fire on every board refresh, including all 35 `_refreshBoard` call sites. The practical effect on the predecessor: a client applies its correct per-client override state from the verb response, then the next refresh broadcasts a singleton-rendered `overrideState` to everyone and silently reverts it. **The companion plan's bug-2 fix does not hold end-to-end until this plan converts `overrideState`.** That makes it not an optional addition but the piece that closes the predecessor.
> **Replaced with:** The four-row table above; fourteen emit sites; `overrideState` in scope.

**Consequence.** With project override ON and two clients on different projects, client B's board displays client A's project's routing map, drag-drop affordances, CLI-trigger state, and "Active scope:" indicator. The companion plan makes the *decisions* those settings drive correct per initiator (its stage 4), but the *displayed* affordances still follow the last switch — so a user can see "drag-drop: disabled" on a column that will in fact accept a drag, or a routing legend that does not match how their own dispatches will route. Display and behaviour disagree, which is worse than either being uniformly wrong.

**A guard to resolve before converting `overrideState`.** `_postOverrideState` opens with `if (!this._panel) return;`. That is a webview-era guard predating the broadcaster: it means the message is emitted **only when the VS Code panel exists**, so a browser-only session receives no `overrideState` by any path today. Converting the payload to a factory without addressing the guard produces per-connection rendering that never runs for exactly the clients this plan exists to serve. The fix is to gate on delivery capability rather than on `_panel` — emit when `this._broadcaster` is present **or** `this._panel` is — which is additive (the extension-only case is unchanged) and is what makes the browser board show a correct scope indicator for the first time. Treat this as a deliberate, tested behaviour change, not a drive-by.

#### Why this cannot be solved by threading

Threading requires an initiator. These pushes originate from the **server**: a refresh tick, a plan-watcher import, a config change, a resync. There is no request in scope and no client to attribute the push to. The only way a push can carry per-client values is for the **fan-out loop itself** to render per client — which requires the server to know each connection's project.

#### Why the two channels are not associated today

Verbs arrive over **HTTP** (`transport.js:169` → `POST /{panel}/verb/{verb}` → `handleServiceVerb(verb, payload)`), and pushes leave over **WebSocket** (`transport.js:73` → `wsHub`). Nothing links a given HTTP call to a given WS connection: `handleServiceVerb(verb, payload)` receives no connection handle and no client identity.

**Important: the fix does not need that association.** An earlier framing assumed a `clientId` correlating the two channels. That is unnecessary and more expensive. The push path only needs to know *this connection's* project — which the connection itself can declare on its own channel. Verbs keep using the companion plan's `initiatorProject`; pushes use per-connection scope. Two mechanisms, one shared precedence rule, no correlation layer.

#### What already exists

- `WsHub._connections: Set<ConnectionMeta>` (`wsHub.ts:49`) — per-connection objects already exist, currently `{ ws, seq }`.
- `WsHub.send(ws, verb, payload)` (`:220-226`) — targeted single-connection push already exists.
- Per-connection monotonic sequence numbers and `__resync`-on-connect (`:126-160`).

#### What is missing (the actual work)

1. **A project field on `ConnectionMeta`**, and a way for the client to set it.
2. **No inbound WS channel at all.** `_handleUpgrade` registers `ws.on('close')` and `ws.on('error')` — there is **no `ws.on('message')`**, and `transport.js` never calls `ws.send()`. Client→server over WS is entirely net-new.
3. **Scope-aware rendering** in `WsHub.broadcast` and `BroadcastHub.push`.
4. **The VS Code webview is not a WS connection.** `BroadcastHub` pushes to it directly via `_target.webview.postMessage`. It must become a pseudo-connection with its own scope, or the editor board silently keeps receiving singleton-rendered payloads while browser clients get correct ones — a half-fix that is harder to diagnose than the current uniform wrongness.
5. **Scope must be known before the resync.** `_handleUpgrade` calls `getFullState()` and sends `__resync` **before** `this._connections.add(meta)` (`:137-151`) — a deliberate ordering guarantee documented at `:129-136`. A scope declared by an upstream message after connect arrives too late for the resync payload.

## Metadata
- **Tags:** feature, refactor, backend, reliability, security
- **Complexity:** 9
- **Project:** browser-switchboard
- **Release phase:** Successor to `kanban-project-filter-client-local.md`. Must land **after** it. Subtask 2 of 2 in the *Cross-Client Project Scope Independence* feature.

> **Superseded:** **Complexity:** 8
> **Reason:** The improve-feature pass added a fourth push type (`overrideState`, three more emit sites), a guard relaxation that is the plan's only non-behaviour-preserving change and needs its own stage and two tests, four more declaration sites in `kanban.html` behind a new helper, and a second predecessor contract to flip. The mechanism is unchanged and still shallow, but the surface grew ~40% and now includes one deliberate behaviour change on a shipped provider.
> **Replaced with:** **Complexity:** 9. Routing is unchanged (Lead Coder either way); the bump is honest sizing, not a re-route.

## User Review Required

- **None.** The design decisions below are made and justified; see *Design decisions*.

## Design decisions

- **Scope travels on the WS URL at connect, plus an upstream `__scope` message for later changes.** `transport.js` appends `?scope=<project>` when opening the socket, so `_handleUpgrade` has it before calling `getFullState()` and the resync is rendered correctly. A later in-session project switch sends `{type:'__scope', project}` upstream. Rejected alternative: upstream-message-only — it cannot reach the resync (see *What is missing* #5) and would make every reconnect briefly render the wrong scope.
- **No `clientId`, no HTTP↔WS correlation layer.** Verbs stay on the companion plan's `initiatorProject`; pushes use per-connection scope. Correlating the channels would add a second identity concept with a lifetime problem (what happens when the socket drops but HTTP calls continue) for no benefit.
- **The webview is a pseudo-connection.** `BroadcastHub` holds a `_webviewScope` alongside `_target.webview` and renders the webview copy from it, exactly as `WsHub` renders each socket's copy. The webview declares its scope through the ordinary `postMessage` rail (a `setPushScope` verb), not through WS.
- **Scope-dependent pushes opt in via a factory; everything else stays a static payload.** `broadcast()` accepts either a payload or a `(scope) => payload` function. Only the three affected message types pay the per-connection render cost; the other ~100 push sites are untouched and keep composing once. Rejected alternative: rendering every push per connection — needless cost and a much larger diff for no correctness gain.
- **The inbound WS channel accepts exactly one message type.** See *Security* in the audit.

## Scope

### ✅ IN SCOPE
1. `ConnectionMeta.project` on `WsHub`, set from the `?scope=` query param at upgrade and updated by an upstream `__scope` message.
2. An inbound `ws.on('message')` handler on `WsHub` with a strict one-message allowlist.
3. `WsHub.broadcast` accepting a payload factory and rendering per connection when given one.
4. `BroadcastHub.push` accepting the same factory, plus `_webviewScope` state and a `setWebviewScope` setter, so the webview is rendered like any other connection.
5. A `setPushScope` verb on `KanbanProvider` so the VS Code webview declares its scope; `kanban.html` calls it at **every** site that mutates `boardProjectFilter` (three, see step 9).
6. Converting the **four** affected push types to factories at all **fourteen** emit sites, including relaxing `_postOverrideState`'s `!this._panel` guard so the browser path is reachable.
7. `getFullState(scope?)` threading so the connect-time resync renders in the connection's scope — in **both** hosts (`TaskViewerProvider:1923`, `standalone/bootstrap.ts:321`).
8. `transport.js`: send `?scope=` on connect and reconnect; send `__scope` on project switch.
9. Tests, including two that flip the companion plan's deliberately-pinned assertions: its test 13 ("push payloads stay shared") and its test 17 ("`overrideState` still broadcasts from the refresh cluster").

### ⚙️ OUT OF SCOPE
- Changing the verb path's `initiatorProject` mechanism. This plan is additive to it, not a replacement — verbs keep threading, pushes get scope.
- Turning the WS into a second verb rail. The inbound handler accepts `__scope` and nothing else; verbs stay on HTTP where schema validation lives (PRD contract #5).
- Per-connection scoping of pushes that carry **no** scoped state. Only the three identified message types change.
- Per-connection scoping of anything outside `KanbanProvider`'s push set. Other providers' scoped pushes, if any, are a follow-up sweep.
- Removing the singleton `_projectFilter`. It remains the workspace authoring default and the fallback for connections that declare no scope.

## Implementation Steps

1. **`WsHub`: per-connection scope.** Add `project?: string | null` to `ConnectionMeta`. In `_handleUpgrade`, parse `reqUrl.searchParams.get('scope')` (the `URL` is already constructed at `:114` for token parsing — reuse it) and set it on `meta` **before** the `getFullState()` call, so the resync can use it.
2. **`WsHub`: inbound channel.** Register `ws.on('message')` inside the `handleUpgrade` callback. Parse JSON defensively; accept **only** `{type:'__scope', project}` where `project` is a string or null; ignore everything else silently. Bound the accepted frame size and reject non-JSON without logging the payload.
3. **`WsHub.broadcast`: per-connection render.** Accept `payload?: any | ((scope: string | null | undefined) => any)`. When it is a function, call it once per connection with `meta.project`; otherwise keep today's single compose. Memoise per distinct scope within one broadcast so N connections on the same project render once.
4. **`BroadcastHub`: webview as a connection.** Add `_webviewScope` and `setWebviewScope(scope)`. In `push()`, when `msg` is a factory, render the webview copy with `_webviewScope` and pass the factory through to `mirrorToWs`. Keep the `_pendingWebviewMessages` queue behaviour — queue the **rendered** message, not the factory, so a message queued before the webview is ready is not re-rendered against a later scope.
5. **`KanbanProvider`: scope declaration verb.** Add a `setPushScope` arm that records the webview's scope via `this._broadcaster?.setWebviewScope(...)`. Add it to the verb allowlist and to `verbSchemas.ts` (optional nullable string).
6. **Convert the four push types.** At each of the fourteen emit sites, replace the static object with a factory that resolves the scoped field through the companion plan's `_projectTier(scope)` helper. Reuse that helper — do not write a second precedence rule. For `overrideState`, extract the payload construction out of `_postOverrideState` into a pure `_buildOverrideState(scope)` (the companion plan's step 6 already does this extraction — build on it, do not redo it) and relax the `!this._panel` early-return to `if (!this._panel && !this._broadcaster) return;`.
7. **Thread `getFullState(scope?)`.** `WsHubOptions.getFullState` (`wsHub.ts:38`) becomes `(scope?: string | null) => Promise<any>`; `LocalApiServer` forwards it (`:303` type, `:390` wiring); `TaskViewerProvider:1923` and `KanbanProvider.getFullStateMessages(wsRoot, scope?)` (`:1059`) accept and use it; `standalone/bootstrap.ts:321` matches.
8. **`transport.js`.** Append `?scope=` in `wsUrl()` (`:64-68`) from the panel's current project filter; send `{type:'__scope', project}` on switch. Both must survive reconnect — `connectWs()` (`:70`) re-reads the current scope rather than a value captured at first connect.
9. **`kanban.html` — declare at all three mutation sites, not one.** Every place that assigns `boardProjectFilter` must re-declare the push scope, or the connection's scope silently diverges from what the board renders:

   | Site | Trigger | Verb posted alongside |
   |---|---|---|
   | `:8336` (branch at `:8322-8340`) | dropdown project change (same workspace) | `setProjectFilter` with `noRefresh: true` |
   | `:8286` | reassign selection → project (same workspace) | `assignSelectedToProject` then `setProjectFilter` (`:8288`) |
   | `:8269` | reassign selection → different workspace | `reassignPlansWorkspace` then `selectWorkspace` (`:8272`) |

   Plus the two **seed** assignments at `:7209` and `:7214` (the `updateWorkspaceSelection` re-seed), which change the rendered filter without any user gesture and therefore without any natural declaration point. Factor a single `setBoardProjectFilter(next)` helper that assigns the variable **and** declares the scope, then route all five assignments through it — otherwise this list is one more sweep that will be incomplete next time. Browser path calls `window.__switchboardSetPushScope`; webview path posts `setPushScope`. Declare **before** posting the accompanying verb (see the race note in the audit).

   > **Superseded:** "Call `setPushScope` on project switch (webview path) and `__scope` (browser path); the existing `boardProjectFilter` is the value for both."
   > **Reason:** "On project switch" reads as one site, and the Proposed Changes section cites only the dropdown branch (`:8326-8340`). There are five assignments to `boardProjectFilter` across three user-facing paths plus the re-seed. A missed one leaves the connection declaring a stale project while the board renders a different one — pushes then arrive scoped to the wrong project, which is precisely the failure this plan removes, reintroduced by an incomplete declaration.
   > **Replaced with:** The table above and the single-helper mandate.

### Staging and gates

| Stage | Steps | Gate |
|---|---|---|
| **1 — Plumbing, no behaviour change** | 1–4, 7 | Scope is carried and stored; all pushes still static. Tests 7–9. Full existing test suite green — this stage must be a strict no-op. |
| **2 — Declaration** | 5, 8, 9 | Both clients declare scope; server observes correct values per connection. Test 12. Still no rendering change. |
| **3 — Rendering** | 6 (thirteen behaviour-preserving sites) | Tests 1–6. This is the stage that changes what clients see. |
| **4 — `overrideState` guard** | 6 (the `!this._panel` relaxation only) | Tests 10–11. Split out because it is the single conversion that is *not* behaviour-preserving: it delivers a message to browser clients that they have never received. Last, so a surprise here cannot block stages 1–3. |

## Complexity Audit

### Routine
- Adding a field to a 4-line interface and setting it from an already-parsed URL.
- Fourteen mechanical emit-site conversions, all the same shape.
- Mirroring one option signature into the standalone bootstrap.

### Complex / Risky
- **A net-new inbound WS channel on a hub that currently ignores all client input.** This is the security-relevant part of the plan (see audit). It is small but must be written defensively the first time.
- **Resync ordering is load-bearing and already documented as a past bug.** `wsHub.ts:129-136` explains why the snapshot is sent before the connection joins `_connections`. Step 1 adds work before that snapshot; it must not move the `add(meta)` call or introduce an await that widens the window.
- **The webview pseudo-connection is the likeliest thing to be skipped.** If steps 4/5/9 are dropped, browser clients get correct payloads and the editor keeps getting singleton ones — the resulting inconsistency is harder to diagnose than today's uniform behaviour. Test 4 exists specifically to prevent this.
- **Pending-message queue interaction — three enqueue/flush paths, not one.** `BroadcastHub` queues messages when the webview isn't ready. Queuing a *factory* and rendering it on flush would render against a scope that may have changed in between. Step 4 mandates queuing the **rendered** message. Verify all the paths: `_pendingWebviewMessages` is written by `push()` (`:68`) **and** `pushWebviewOnly()` (`:109`), and drained by **both** `setWebview()` (`:43-49`) and `flushPending()` (`:119-127`). Rendering at enqueue time in `push()` covers both drains automatically — which is the reason to render there rather than at flush. `pushWebviewOnly` has no scoped callers today; if its signature is widened for symmetry it must render at enqueue too.
- **`overrideState`'s `!this._panel` guard is a behaviour change, not a refactor.** Relaxing it makes browser sessions receive a message they have never received. Any webview handler assumptions (`kanban.html:7602`) must hold for a browser client on first delivery, and the standalone host must tolerate the message. This is the one place in the plan where a conversion is not behaviour-preserving; stage it with its own test rather than folding it into the bulk emit-site sweep.
- **Per-panel sockets.** `transport.js` runs per panel iframe (`document.body.dataset.panel`, `:25`), so one browser user holds several WS connections. Scope is therefore per-panel, which is correct, but "one client" and "one connection" are not the same thing — do not build anything that assumes a 1:1 mapping.

## Edge-Case & Dependency Audit

- **Race conditions:** a project switch produces two near-simultaneous events — the verb (`setProjectFilter`, carrying `initiatorProject`) and the scope declaration (`__scope` / `setPushScope`). A push landing between them renders in the old scope. This is self-correcting (the next push is right) and is a display-only transient, but the client must send the scope declaration **before** the verb so the window is as small as possible, not after.
- **Reconnect:** the scope must be re-sent on every reconnect. `transport.js:126-133` reconnects with backoff; `connectWs()` must re-read the live scope, not a captured one. A reconnected client that forgets its scope silently reverts to the singleton — the failure this plan exists to remove.
- **Connections that declare no scope** (external HTTP/WS clients, tests, older browser builds) must fall back to the singleton — i.e. today's behaviour exactly. Scope is optional forever; never require it.
- **Security:** adding `ws.on('message')` opens the first client→server path on the hub. The upgrade is already Origin- and token-gated (`wsHub.ts:87-123`), so this is not an unauthenticated surface, but the handler must still: accept only `__scope`, validate `project` is a string or null, ignore unknown types without echoing them, bound frame size, and **never** dispatch verbs. Turning the WS into a verb rail would bypass the HTTP boundary's schema validation (PRD contract #5).
- **Side effects:** none of the three converted pushes has a side effect; they are pure state pushes. The conversion must stay pure — a factory called once per distinct scope must not mutate provider state.
- **Migration / shipped state:** no persisted state changes. `?scope=` is an additive query param an older server ignores, and an older client simply never sends — both directions degrade to today's behaviour. No migration needed for the ~4,000 installs.
- **Dependencies & conflicts:** this plan and its predecessor both edit `KanbanProvider.ts`, `kanban.html`, and `verbSchemas.ts`. Per the PRD's orchestration discipline they **must serialise** — this plan starts only after the predecessor merges. It also reuses the predecessor's `_projectTier` helper, so starting early would mean inventing it twice.
- **No confirmation dialogs** are added anywhere (project rule).

## Dependencies

- `kanban-project-filter-client-local.md` — **must merge first.** Three distinct couplings, not one:
  1. **Reuse.** This plan calls its `_projectTier(scope)` precedence helper. Building concurrently means inventing it twice, and its `!== undefined`-not-truthiness contract is the single most likely thing in either plan to be implemented wrong.
  2. **Reuse.** This plan's `overrideState` factory builds on the pure `_buildOverrideState(...)` that the predecessor's step 6 extracts out of `_postOverrideState`. Without that extraction landing first, this plan does the extraction itself and the predecessor's step 6 collides with it.
  3. **Contract flips.** This plan replaces the predecessor's test 13 ("push payloads stay shared") and test 17 ("`overrideState` still broadcasts from the refresh cluster") with their inverses. Both are pinned deliberately by the predecessor so the hand-off is a tested fact.
- **This plan completes the predecessor's bug 2.** The predecessor stops `setProjectFilter` from broadcasting `overrideState` and returns it in the verb body — correct, but immediately overwritten by the refresh cluster's singleton-rendered broadcast. Until this plan converts `overrideState`, the predecessor's bug-2 fix is observable only in the moment between a project switch and the next refresh. Do not report bug 2 as closed on the predecessor alone.
- Both plans edit `KanbanProvider.ts`, `kanban.html`, and `verbSchemas.ts`; per the PRD's orchestration discipline they serialise regardless of the logical dependencies above.

## Adversarial Synthesis

**Risk Summary.** The correctness risk is concentrated in a few named places rather than spread across the diff: the resync ordering window in `_handleUpgrade` — which `wsHub.ts:129-136` documents as a previously-shipped stale-client bug; the webview pseudo-connection, whose omission produces a half-fix where browser clients are right and the editor is quietly wrong; and, added by the improve pass, the **declaration side** — five assignments to `boardProjectFilter` in `kanban.html`, of which the original revision cited one. A connection that declares a stale scope is worse than one that declares none, because the fallback path is correct-by-construction while a wrong declaration renders confidently wrong payloads. The `overrideState` conversion carries the plan's only non-behaviour-preserving change: relaxing `_postOverrideState`'s `!this._panel` guard delivers a message to browser clients that they have never received. The security risk is the net-new inbound WS channel on a hub that has never accepted client input; it is token- and Origin-gated already, but must accept exactly one message type and must never become a verb rail that bypasses HTTP schema validation.

Mitigations: stage the plumbing as a strict no-op before any rendering changes; isolate the guard relaxation into its own stage with its own before/after tests; funnel all five `boardProjectFilter` assignments through one `setBoardProjectFilter` helper so the declaration set is enforced by structure rather than by a sweep; keep scope optional so undeclared connections behave exactly as today; render at enqueue rather than at flush so both pending-queue drains are covered; reuse the predecessor's single precedence helper and its `_buildOverrideState` extraction; and pin the webview-parity case with its own test.

## Proposed Changes

### `src/services/wsHub.ts` — `ConnectionMeta`, upgrade, inbound handler, broadcast

- **Context.** 244-line file. `ConnectionMeta` is `{ ws, seq }` (`:41-44`); `_handleUpgrade` already builds a `URL` at `:114`; `broadcast` composes nothing and forwards the caller's payload (`:201-214`); there is no `ws.on('message')`.
- **Logic.** Carry an optional project per connection; render per connection only when the caller supplies a factory.
- **Implementation.**
  ```ts
  interface ConnectionMeta {
      ws: WebSocket;
      seq: number;
      /** This connection's project scope, declared via ?scope= or a __scope
       *  message. undefined/null = no declaration → host falls back to the
       *  workspace singleton, i.e. pre-plan behaviour. */
      project?: string | null;
  }

  export type ScopedPayload = any | ((scope: string | null | undefined) => any);

  broadcast(verb: string, payload?: ScopedPayload, surface?: string): void {
      const isFactory = typeof payload === 'function';
      const rendered = new Map<string, any>();   // memoise per distinct scope
      for (const meta of this._connections) {
          let body = payload;
          if (isFactory) {
              const key = meta.project ?? ' none';
              if (!rendered.has(key)) rendered.set(key, (payload as Function)(meta.project));
              body = rendered.get(key);
          }
          meta.seq += 1;
          this._safeSend(meta.ws, { type: verb, seq: meta.seq, surface, payload: body });
      }
  }
  ```
  In `_handleUpgrade`, set `project` on `meta` at construction (`:127`), reading `reqUrl.searchParams.get('scope')`. Register the inbound handler alongside `close`/`error`:
  ```ts
  ws.on('message', (raw) => {
      if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
      const text = raw.toString();
      if (text.length > 4096) return;                 // scope declarations are tiny
      let msg: any;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || msg.type !== '__scope') return;     // one type, nothing else
      const p = msg.project;
      if (p !== null && typeof p !== 'string') return;
      meta.project = p;
  });
  ```
- **Edge cases.** Do **not** move `this._connections.add(meta)` (`:151`) or add an await before the resync — the subscribe-after-snapshot ordering at `:129-136` is a fixed bug, not an implementation detail. `send()` (`:220`) is unchanged; it already targets one connection and carries no scoped state today.

### `src/services/broadcastHub.ts` — webview as a scoped pseudo-connection

- **Context.** `push()` (`:63-71`) renders once and fans out to the webview plus `mirrorToWs`. `_pendingWebviewMessages` queues for initial-load ordering.
- **Logic.** Give the webview its own scope and render its copy from it; forward the factory unchanged to the WS side.
- **Implementation.**
  ```ts
  private _webviewScope: string | null | undefined;
  setWebviewScope(scope: string | null | undefined): void { this._webviewScope = scope; }

  push(msg: ScopedPayload, surface?: string): void {
      const isFactory = typeof msg === 'function';
      const webviewMsg = isFactory ? (msg as Function)(this._webviewScope) : msg;
      if (this._target.webview) {
          this._target.webview.postMessage(webviewMsg).then(undefined, () => {});
      } else {
          this._pendingWebviewMessages.push(webviewMsg);   // rendered, never the factory
      }
      this.mirrorToWs(surface, msg);                       // factory passes through
  }
  ```
- **Edge cases.** `pushTo` and `pushWebviewOnly` (`:96`, `:107`) should accept factories for symmetry but have no scoped callers today — convert the signatures, leave the call sites alone. `mirrorToWs` (`:81-86`) forwards to `broadcastWs`; its `msg?.type ?? '__unknown'` verb extraction reads a **property of the payload**, which a factory does not have — the verb must be passed explicitly rather than sniffed once factories are in play. This is the single easiest thing to get wrong in this file.

### `src/services/KanbanProvider.ts` — the fourteen emit sites and the `setPushScope` arm

- **Context.** Four message types, fourteen sites, listed in the table under *Core problem*.
- **Logic.** Each becomes a factory resolving its scoped field through the predecessor's `_projectTier(scope)`.
- **Implementation.** e.g. at `:2012`:
  ```ts
  this.postMessage((scope) => ({
      type: 'updateBoard', cards, dbUnavailable: false,
      showingBacklog: this._showingBacklog,
      routingConfig: this._routingMapForScope(scope),
      featureWorktrees,
  }));
  ```
  with `_routingMapForScope(scope)` / `_dragDropModesForScope(scope)` / `_cliTriggersForScope(scope)` each resolving via `_getScopedSetting(key, default, this._projectTier(scope))` and falling back to the cached singleton field when `scope` is undefined. Add the `setPushScope` arm returning `{ success: true }` and calling `this._broadcaster?.setWebviewScope(msg.project)`.

  For `overrideState`, the fourth type, the three refresh-cluster call sites (`:2022`, `:3523`, `:3688`) call `this._postOverrideState()` rather than composing inline, so the conversion happens **once** inside that function:
  ```ts
  private _postOverrideState(): void {
      if (!this._panel && !this._broadcaster) return;   // was: if (!this._panel) return;
      this.postMessage((scope) => this._buildOverrideState(scope));
  }
  ```
  `_buildOverrideState(scope)` is the pure builder the predecessor's step 6 extracts; it must resolve `projectSwitchEnabled` / `activeProjectName` / `activeScope` from `this._projectTier(scope)` instead of `this._projectFilter`, falling back to the singleton when `scope` is undefined. The toggle emitters (`:8158`, `:8170`, `:8193`) go through the same function and get per-connection rendering for free — correct, since only the *project* tier of the string varies per client; the workspace/global tiers do not.
- **Edge cases.** `postMessage` (`:2090`) must accept a factory and pass it through when a broadcaster exists; on the `_panel`-only path (no broadcaster) it renders with the webview scope. `cards` and `featureWorktrees` are captured by the closure and must not be recomputed per scope — only the scoped field varies. `_filterDynamicColumns` output must stay outside the factory for the same reason. `_postOverrideState` is the one factory whose *guard* changes as well as its payload — call that out in review so it is not waved through as "same as the other thirteen".

### `src/webview/transport.js` — scope on connect and on change

- **Context.** `wsUrl()` (`:64-68`) builds the URL; `connectWs()` (`:70`) opens it; reconnect at `:126-133`. The shim never sends upstream today.
- **Logic.** Append the current scope at connect; send `__scope` on change.
- **Implementation.** A module-level `let pushScope = null;` plus `window.__switchboardSetPushScope = (p) => { pushScope = p; if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:'__scope', project: p})); };` and `wsUrl()` appending `?scope=${encodeURIComponent(pushScope ?? '')}` when set.
- **Edge cases.** `wsUrl()` must read `pushScope` at call time so reconnects pick up the current value. Do not send `__scope` when the socket is not OPEN — the query param covers the next connect.

### `src/webview/kanban.html` — declare at every `boardProjectFilter` assignment

- **Context.** `boardProjectFilter` (`:4230`) is assigned in **five** places: the dropdown branch (`:8332`, inside `:8322-8340`), the reassign-to-project path (`:8286`), the reassign-to-workspace path (`:8269`), and the two `updateWorkspaceSelection` re-seeds (`:7209`, `:7214`). Only the first was cited previously.
- **Logic.** Introduce `setBoardProjectFilter(next)` that assigns the variable and declares the push scope in one place; route all five assignments through it. Declare the scope **before** posting the accompanying verb, so the transient window in the audit is minimal. Browser path calls `window.__switchboardSetPushScope`; webview path posts `setPushScope`.
- **Edge cases.**
  - Send `boardProjectFilter` verbatim including `null` and `'__unassigned__'` — same sentinel discipline as the predecessor.
  - The two re-seed sites (`:7209`, `:7214`) fire from an inbound message, not a user gesture. Declaring from inside a message handler is fine (the socket is open by definition at that point), but it must not post the webview `setPushScope` verb in a loop — guard on an actual change of value.
  - This file is also edited by the predecessor (which adds `initiatorProject` to authoring verb payloads in the same dropdown branch). Per the PRD's orchestration discipline the two must serialise; the helper introduced here should wrap the predecessor's already-landed code, not replace it.

### `src/services/LocalApiServer.ts`, `TaskViewerProvider.ts`, `standalone/bootstrap.ts` — `getFullState(scope?)`

- **Context.** `getFullState?: () => Promise<any>` (`LocalApiServer.ts:303`), wired at `:390`, implemented at `TaskViewerProvider.ts:1923` → `KanbanProvider.getFullStateMessages(root)` (`:1059`) and at `standalone/bootstrap.ts:321`.
- **Logic.** Thread an optional scope so the connect-time resync renders in the connecting client's project.
- **Edge cases.** Both hosts must change together (PRD contract #7, two-layer completion). `getFullStateMessages` builds `updateBoard` and `cliTriggersState` inline at `:1112-1113` — those two lines are part of the ten emit sites and must use the passed scope, not the singleton.

## Verification Plan

*(Session directive: no compilation or test execution during this planning pass. These are specifications for the implementer.)*

### Automated Tests

1. **Two connections, two scopes, one broadcast.** Connect two fake WS clients declaring projects X and Y, each with a different `routingMapConfig`. Emit one `updateBoard`. Assert each client received its **own** project's `routingConfig` from a single `broadcast()` call. Repeat for `updateColumnDragDropModes`, `cliTriggersState`, and **`overrideState`** (assert `activeScope` reads `Project 'X'` for one and `Project 'Y'` for the other from one emit).
2. **Undeclared connection falls back.** A third client declaring no scope receives the singleton-rendered values — byte-identical to pre-change behaviour. This is the compatibility guard for external clients and the ~4,000-install path.
3. **Resync renders in the connection's scope.** Connect with `?scope=Y` while the singleton is on X; assert the `__resync` payload's `updateBoard.routingConfig` and `cliTriggersState.enabled` are Y's. Guards the ordering requirement in step 1.
4. **Webview parity.** With the webview scope set to X and a WS client on Y, one push yields X's values to the webview and Y's to the socket. Directly prevents the half-fix failure mode.
5. **Flips the predecessor's two pinned contracts.** The companion plan's test 13 asserts push payloads are shared and its test 17 asserts the refresh cluster still broadcasts singleton `overrideState`; this plan replaces both with their inverses. **Update, do not delete** — the diff should show the contracts changing hands. Test 17's flip is the one that closes the predecessor's bug 2 end-to-end: assert that after a `setProjectFilter` on client A, a subsequent refresh does **not** overwrite client B's override indicator.
6. **Scope survives reconnect.** Drop and reconnect a client; assert the new connection's first `__resync` and subsequent pushes use the same scope without a further declaration.
7. **Inbound handler rejects everything but `__scope`.** Non-JSON, oversized frames, unknown `type`, and a non-string non-null `project` all leave `meta.project` unchanged and dispatch no verb.
8. **Factory purity and memoisation.** A factory is invoked once per **distinct scope**, not once per connection: three connections on two projects → exactly two invocations.
9. **Static pushes unchanged.** A non-factory payload takes the original single-compose path; the other push sites are unaffected.
10. **`overrideState` reaches a browser-only session.** With no VS Code panel bound (`_panel` null) but a broadcaster wired, `_postOverrideState()` emits. Pre-change this asserts **nothing is emitted**; post-change it asserts the WS client receives an `overrideState` rendered in its own scope. This is the plan's only non-behaviour-preserving conversion — it gets its own test so the change is deliberate and visible in review.
11. **Extension-only path is byte-identical.** With a panel bound and no broadcaster, `_postOverrideState()` produces exactly today's payload. The ~4,000-install guard for the guard relaxation.
12. **Every `boardProjectFilter` assignment declares scope.** Drive each of the five assignment sites (dropdown `:8332`, reassign-to-project `:8286`, reassign-to-workspace `:8269`, both re-seeds `:7209`/`:7214`) and assert the connection's declared scope matches the rendered filter afterwards. Written against the `setBoardProjectFilter` helper so a sixth assignment added later without the helper fails the test rather than silently desynchronising.

### Manual

- Two clients on different projects with project override ON: confirm each board's routing legend, drag-drop affordances, CLI-trigger toggle, and **"Active scope:" indicator** reflect its **own** project, and that switching in one no longer changes the other. Then force several board refreshes and confirm the indicators stay put — that is the predecessor's remaining hole closing.
- With the VS Code panel **closed** and only a browser client connected, confirm the browser board now shows a correct "Active scope:" indicator (pre-change it received no `overrideState` at all).
- Kill the browser's network briefly; on reconnect confirm the board comes back in its own project's scope, not the editor's.
- Confirm an external HTTP/WS client that declares no scope still receives a coherent board.

## Uncertain Assumptions

None. Every mechanism in this plan was verified by reading `wsHub.ts`, `broadcastHub.ts`, `transport.js`, and the `KanbanProvider` emit sites. No web research is required before implementation.

---

**Recommendation:** Complexity 9 → **Send to Lead Coder.**

*Dispatch only after `kanban-project-filter-client-local.md` has merged — the two plans edit the same three files, this one reuses that plan's `_projectTier` precedence helper and its `_buildOverrideState` extraction, and it flips two contracts that plan pins deliberately.*

**Stage Complete:** PLAN REVIEWED
