# A Card Can Name Who Is Meant to Pick It Up, and the Board Can Filter to Yours

## Goal

Give a card an assignee, and give the board a filter for it, so two or three people
sharing one LABCOM can each see their own cards without partitioning the board.
Advisory only: an assignee is a label and a filter, never a permission.

### Problem analysis

**Asked for as:** *"just the ability to scope cards to users… literally just a filter
option for use by very small teams who trust each other."*

**There is no identity in the board today.** No users, accounts or sessions tables;
the only member-shaped table is `mission_members`, which holds agent seats. `plans`
has `routed_to`, `dispatched_agent` and `dispatched_terminal` — all agent seats, no
human field. `_checkAuth` answers *whether* a request is allowed, never *who* sent
it: any tailnet peer returns `true` at `LocalApiServer.ts:1620` (inside `_checkAuth`
at `:1609`, which delegates to `_isTailnetSocket` at `:1563`), and loopback
returns `true` when no token is configured (`:1636`).

**But identity is already available for free, and the client for it is already
written.** On the tailnet listener a request carries the peer's
`remoteAddress:remotePort`, and the Tailscale LocalAPI turns that into a user:

```
$ tailscale whois 100.111.169.88:1234
  User:  patvuleta@gmail.com   ID: 4019534851849169
```

`tailnetDetect.ts` already probes that socket for `/localapi/v0/status` through
`candidateLocalApiSockets()` (`:52`, used at `:125` and `:144`), with its own
timeouts and fallbacks. `whois` is a second endpoint on a connection the code
already knows how to make. So this needs **no credentials, no sessions, no login
screen** — the network authenticated the peer before the request arrived, and this
only asks its name.

The identity it returns is the shape already in the board: `plan_events.user_id`
holds `patvuleta@gmail.com` on 111 rows today, written by `resolveUserId()`
(`machineAttribution.ts:89`). That function resolves **once per process** from a
setting, then `git config user.email`, then `'unknown'` — it answers "whose machine
is this", which is the right answer for attribution and the wrong one for "who is
asking". It gains a per-request sibling; it is not replaced.

**And scoping already exists end to end — the project filter is the template.**

| layer | project filter |
| :--- | :--- |
| DB | `getBoardFilteredByProject` (`KanbanDatabase.ts:5030`) |
| provider state | `_projectFilter` — 39 refs in `KanbanProvider` (init at `:316`) |
| per-connection push | `meta.project`, `?scope=`, `__scope` — in `wsHub.ts` (`:335-337`, `:372-376`, `:474-484`) |
| UI | 42 refs in `kanban.html` |

Including the part that would otherwise be hard: `wsHub.broadcast` already renders
one payload **per distinct scope** and caches it, keyed three ways — undeclared,
declared-null, and named (`wsHub.ts:474-484`). An assignee scope is that mechanism
with a second dimension, not a new mechanism.

**The operator's three answers, which keep this small.** Assignees are *advisory*;
an unassigned card belongs to *everyone*; and the whole point is a filter. Each of
those removes a category of work — enforcement would re-introduce authorization,
and "unassigned belongs to no one" would make the filter able to hide work from the
person who has to do it.

## Metadata

**Feature:** 90b5ad18-7e5e-431d-9c05-f9b33387a243
**Complexity:** 6
**Tags:** feature, database, api, ui, backend
**Dependencies:** none. Deliberately not part of `Launch Gate` — this is new
capability, not a defect, and must not gate the site.

## User Review Required

None. The three decisions that would have needed one are settled: advisory,
unassigned-is-everyone, filter-only.

## Complexity Audit

### Routine

- Adding a `TEXT DEFAULT ''` column and a two-column index to an existing table —
  the project filter's `idx_plans_project ON plans(workspace_id, project)`
  (`KanbanDatabase.ts:1320`) is the exact template.
- Mirroring the project filter's provider state pattern: a private field, a
  getter, a setter that persists to a DB config key, and a refresh-time read.
  `setProjectFilter` (`KanbanProvider.ts:8620`) and `getProjectFilter` (`:8399`)
  are the templates.
- Appending a `plan_events` row — `appendPlanEventByPlanId`
  (`KanbanDatabase.ts:12643`) already takes a `payload` string. (It does **not**
  take a `user_id` parameter — see Change 5 for the signature extension required
  to thread the per-request actor.)
- The UI toggle beside the project selector — the project filter dropdown in
  `kanban.html` is the shape to follow.

### Complex / Risky

- **WS scope protocol extension.** `meta.project` (`wsHub.ts:148`) is a single
  string today, set by `?scope=` at upgrade (`:335-337`) and `__scope` messages
  post-connect (`:372-376`). Adding a second dimension (assignee) touches the
  upgrade query protocol, the `__scope` message schema, the `ConnectionMeta`
  interface, the broadcast factory cache key (`:474-484`), and the
  `getFullState` callback signature (`wsHub.ts:111`, `LocalApiServer.ts:790`).
  See Proposed Changes §3 for the chosen approach.
- **Composition-root divergence.** The standalone host seeds `_projectFilter`
  at boot (`bootstrap.ts:1696-1706`) because `_refreshBoardImpl` returns early on
  `!this._panel` and standalone has no panel. The extension seeds it in
  `_refreshBoardImpl` because it does have a panel. An `_assigneeFilter` must be
  wired in **both** roots or the filter silently resets on every standalone
  restart — the exact PlanIngestionEngine queue-seams bug documented in AGENTS.md.
- **Tailscale LocalAPI `whois` endpoint.** Confirmed stable (see Resolved
  Assumptions): `GET /localapi/v0/whois?addr=<ip>[:port]` on the same unix socket
  as `/localapi/v0/status`. Response carries `Node.StableID` (durable node key)
  and `UserProfile.LoginName` (email) / `UserProfile.ID` (numeric user key). The
  `tailnetDetect.ts:17` comment calling the LocalAPI "explicitly unstable" is
  now stale for whois specifically — a July 2026 change added an explicit
  `// API maturity: this is considered a stable API` marker to `WhoIs` and its
  siblings. The comment should be updated when this lands.
- **`Tailscale-User-Login` header from `tailscale serve`.** Confirmed (see
  Resolved Assumptions): `Tailscale-User-Login`, `Tailscale-User-Name`,
  `Tailscale-User-Profile-Pic` — always-on for HTTP serve, no flag required.
  Serve *strips* client-supplied identity headers before injecting its own, so
  spoofing is blocked on the serve path. Direct tailnet connections carry no
  Tailscale headers and any client-supplied header is fully spoofable — the
  loopback-only trust gate in Proposed Changes §2 is mandatory, not optional.
- **Tagged nodes.** A tagged node (ACL tag, not a person) returns
  `UserProfile.LoginName === 'tagged-devices'` with a shared synthetic ID. The
  whois resolver must check `Node.IsTagged()` (i.e. `len(Node.Tags) > 0`) and
  treat a tagged node as unidentified — never populate the peer map with
  `tagged-devices` as a user identity.
- **LocalAPI Host header requirement.** The LocalAPI handler rejects requests
  with `403 invalid localapi request` unless `Host` is `local-tailscaled.sock`
  or empty. Most HTTP-over-unix-socket clients set `Host: localhost` by default.
  The whois probe must override the `Host` header explicitly — the existing
  `probeLocalApiSocket` (`tailnetDetect.ts:82`) does not set `Host` and works
  only because `/localapi/v0/status` is on the lenient path; whois is not.
- **Peer identity map storage.** The durable node→user map is a new persistence
  surface. It must survive restarts (the operator's "resolve once" constraint)
  and have an explicit forget hatch. See Proposed Changes §2.

## Edge-Case & Dependency Audit

**Race Conditions**
- Two requests from the same unseen node arriving simultaneously: both trigger
  a whois call before either writes the map. Resolve with a per-node in-flight
  promise (memoise the whois call, not just its result) so the second request
  awaits the first's resolution rather than racing a second socket call.
- A `setProjectFilter` / `setAssigneeFilter` arriving during a board refresh: the
  refresh reads the filter at the top (`_refreshBoardImpl`), so a mid-refresh
  change is picked up on the next refresh. Same behaviour as the project filter
  today — acceptable, documented.

**Security**
- `Tailscale-User-Login` header honoured from the tailnet listener would let any
  peer claim any identity. The plan restricts it to loopback only (serve proxies
  from 127.0.0.1). This is stated in Proposed Changes §2 and is a verification
  invariant.
- Assignees are advisory — no enforcement. A card assigned to another operator
  remains dispatchable, movable, and completable by anyone. This is the core
  contract and is a verification invariant.

**Side Effects**
- The `assignee` column must be added to `PLAN_COLUMNS` (`KanbanDatabase.ts:1555`)
  or every board read silently drops it — the column is written by the migration
  but never returned to the provider or the UI.
- The UPSERT path (`UPSERT_PLAN_SQL` near `:1449`) must include `assignee` or
  the import path overwrites it to the default on every re-import.
- `getFullStateMessages` (`KanbanProvider.ts:1328`) currently passes `null` for
  project to `getBoardFilteredByProject` (`:1349`) — the card data is NOT
  server-filtered, the client filters from `boardProjectFilter` (`kanban.html:6681`).
  The assignee filter follows the same pattern: server sends all cards, client
  filters. This avoids threading the assignee scope into every DB read, but
  means the broadcast factory must render the `updateBoard` push per
  (project, assignee) scope pair so each connection gets its filtered card set.

**Dependencies & Conflicts**
- No dependency on other plans. Deliberately not part of Launch Gate.
- The `tailscale serve` identity path interacts with `_isTailnetSocket`
  (`LocalApiServer.ts:1563`) and `_checkAuth` (`:1609`): serve moves every
  request to loopback, so the tailnet-trust branch stops firing and the loopback
  branch takes over. Access still works (both return `true`), but
  `starting-the-board-prints-one-address-never-a-token` and
  `browser-board-csrf-cross-site-rejection` both reason about that boundary
  and should be re-read against serve before either lands.

## Dependencies

None. Deliberately not part of `Launch Gate`.

## Adversarial Synthesis

Key risks: the WS scope protocol extension is underspecified (compound key
threading) and the composition-root wiring is unnamed (standalone vs extension
seed). Both Tailscale external-API details (whois endpoint path, serve header
names) were confirmed via web research — see Resolved Assumptions. New risks
surfaced by the research: tagged nodes return a synthetic `tagged-devices`
identity that must be rejected, the LocalAPI requires a `Host:
local-tailscaled.sock` header or it 403s, and serve Q-encodes non-ASCII header
values. Mitigations: specify the second-scope-dimension approach explicitly
(second `meta` field + `?assignee=` param, not an encoded compound string),
name both composition roots with line numbers, reject tagged nodes in the
whois resolver, set the Host header on every LocalAPI whois call, and Q-decode
the serve identity headers. Additional risks surfaced by this improve pass:
the client has no way to learn its own identity (the `GET /whoami` bridge in
Change 2 is the connective tissue between server-side resolution and
client-side filtering — without it the "mine" toggle has no default);
`appendPlanEventByPlanId` does not accept a `user_id` parameter and must be
signature-extended to thread the per-request actor; and the UPSERT conflict
SET needs a `COALESCE(NULLIF(...))` guard on `assignee` (mirroring `project` at
`:1483`) or every file-watcher re-import clears all assignments.

## Proposed Changes

### 1. An `assignee` column on `plans`

- Migration **V76** (V75 is the highest defined, at `KanbanDatabase.ts:1075`).
  `assignee TEXT DEFAULT ''`, plus an index on `(workspace_id, assignee)` to
  match how the project index is shaped (`idx_plans_project` at `:1320`).
- Empty string means unassigned, and unassigned is visible to everyone. Do **not**
  add a sentinel: the project filter needs `UNASSIGNED_PROJECT_FILTER`
  (`KanbanDatabase.ts:1690`) because an unassigned project is a filterable value in
  its own right. Here it is the default state, and giving it a sentinel would imply
  a "nobody's cards" view that the operator explicitly does not want.
- **Add `assignee` to `PLAN_COLUMNS`** (`KanbanDatabase.ts:1555-1560`). Without
  this the column is written by the migration but never returned by any board
  read — every `SELECT ${PLAN_COLUMNS} FROM plans` silently drops it.
- **Add `assignee` to the UPSERT statement** (`UPSERT_PLAN_SQL` near `:1449`,
  column list at `:1446`). Mirror the `project` column's pattern **exactly**,
  including the COALESCE guard — `project` is in `UPSERT_PLAN_INSERT_COLUMNS`
  (`:1447`) and in `UPSERT_PLAN_CONFLICT_SQL` as
  `project = COALESCE(NULLIF(excluded.project, ''), plans.project)` (`:1483`).
  Add `assignee` to the INSERT columns, and add
  `assignee = COALESCE(NULLIF(excluded.assignee, ''), plans.assignee)` to the
  conflict SET. Plan files do not carry assignee (it is board state, not file
  state), so `excluded.assignee` is always `''` on re-import; the COALESCE guard
  preserves the existing assignment. **A bare `assignee = excluded.assignee`
  would clear every assignment on every file-watcher re-import sweep** — the
  exact data-loss bug this bullet exists to prevent, caused by omitting the one
  line that makes mirroring safe.
- **Add `assignee` to the `plans` CREATE TABLE schema** (`:344`) so fresh
  installs get the column without the migration.

### 2. Resolve each peer once, and remember it

The operator's constraint: *"we don't need to constantly check for tailscale
identity — can assume that they'll use the same machines, so no need to constantly
check."* So this is a durable map, not a per-request lookup with a TTL.

- `whois` returns a **machine** and a **user** as separate identities, and the two
  have different jobs here. Verified against the live tailnet:

  ```
  ipad-gen-7         nodeID=niPPZPH4jF11CNTRL    userID=4019534851849169
  motorola-edge-50   nodeID=nkZYHEy7u711CNTRL    userID=4019534851849169
  patrickremotedev   nodeID=n9X9ddBTM111CNTRL    userID=4019534851849169
                                    5 devices, 1 UserID
  ```

  - **The node `StableID` is the cache key** — one entry per device, which is
    what "resolve once and remember" remembers. Use `Node.StableID` (e.g.
    `nABCdef…`), NOT `Node.ID` (an ephemeral numeric ID that changes on
    re-registration).
  - **The user `LoginName` (email) is the assignee identity** — what the
    assignee column and the filter key on. This matches `plan_events.user_id`
    which already holds `patvuleta@gmail.com`. `UserProfile.ID` (numeric) is
    available from whois but NOT from serve headers (which carry only
    `Tailscale-User-Login`); using email as the key keeps both identity paths
    consistent. Trade-off: email breaks if a user's login name changes —
    acceptable for a small-team advisory filter, noted here so it is a choice.

  One person on a phone, a laptop and a tablet is **one operator with one filtered
  board**. Reverse the two and they get three different boards, one per device.
  This is obvious now and is exactly the kind of thing that is implemented wrong
  later, so it is stated rather than implied. Do not key on the address: it is
  stable in practice, the node ID is stable by contract.
- Resolve on first sight of an unknown node, then persist and never ask again.
  `machineAttribution.ts` is the precedent and the place it belongs: it already
  writes `machine-identity.json` through `stateFile()` with a tmp-then-rename
  (`:40`, `:64-66`), and its `MachineIdentity` interface **already carries an
  optional `userId`** (`:20`) that nothing currently populates. This is that field
  finding its use.
- **The peer identity map is a new file**, not an extension of
  `machine-identity.json`. That file is the host's own identity (one record);
  the peer map is a directory of every peer the board has seen (N records). Use
  `stateFile('peer-identities.json')` — same `stateFile()` helper, same
  tmp-then-rename write pattern. The map is `{ [nodeId]: { userId, login, label, firstSeen } }`.
  This file is also the roster source: the UI picker populates from the known
  peers, not from a list anyone maintains. Adding someone to Tailscale should be
  the only step.
- Reuse `candidateLocalApiSockets()` (`tailnetDetect.ts:52`) rather than shelling
  out to `tailscale`. The `whois` endpoint is `GET /localapi/v0/whois?addr=<ip>[:port]`
  on the same socket — confirmed (see Resolved Assumptions). The response is
  `{ Node: { StableID, Name, Tags, … }, UserProfile: { ID, LoginName, DisplayName, … }, CapMap }`.
  **Set `Host: local-tailscaled.sock`** on the request — the handler 403s
  otherwise. The existing `probeLocalApiSocket` (`tailnetDetect.ts:82`) does not
  set `Host`; a new `probeLocalApiWhois` helper must. **Reject tagged nodes**
  (`Node.Tags` non-empty → `LoginName === 'tagged-devices'`) — treat as
  unidentified, do not populate the peer map.

**Two identity sources, neither of them required.** The board must work whether it
is reached directly on its port or through `tailscale serve`, because serve is a
nicer URL, not a prerequisite — nobody should have to enable HTTPS certificates in
a Tailscale admin console to use LABCOM.

- **Direct** (`http://host:7777`) — the request arrives from the peer, so `whois`
  on `remoteAddress:remotePort` resolves it. The durable node map above applies.
- **Behind `tailscale serve`** (`https://host/`) — the request arrives from the
  proxy on **127.0.0.1**, so the peer address is useless and `whois` would resolve
  the local node. Serve supplies the identity instead, already resolved, as
  `Tailscale-User-Login` (email), `Tailscale-User-Name` (display name), and
  `Tailscale-User-Profile-Pic` headers on every request — confirmed always-on
  for HTTP serve, no flag required (see Resolved Assumptions). No socket, no map,
  no cache. **Q-decode** `Tailscale-User-Login` and `Tailscale-User-Name` — serve
  RFC 2047 Q-encodes non-ASCII values (e.g. `=?utf-8?q?Ferris_B=C3=BCller?=`).
  `Tailscale-User-Profile-Pic` is set raw, no Q-decoding needed.
- **Order:** prefer the header when present, fall back to `whois`, and if neither
  answers, no identity — which means the unfiltered board, never a refusal.

**Only trust that header from loopback.** Serve proxies from 127.0.0.1, so a
`Tailscale-User-Login` arriving on the tailnet listener did not come from serve —
it came from a client that set it. Assignees are advisory and the tailnet is
trusted, so the stakes are low, but a header that is honoured from anywhere makes
the identity claimable by anyone and is free to get right at the start. The
gate is `_isTailnetSocket` (`LocalApiServer.ts:1563`): honour the header only
when `_isTailnetSocket(req)` returns `false` (i.e. loopback). Confirmed: serve
*strips* client-supplied `Tailscale-User-Login`/`-Name`/`-Profile-Pic` before
injecting its own, so spoofing is blocked on the serve path — but direct
tailnet connections carry no Tailscale headers at all and any client-supplied
value is fully spoofable. The loopback-only gate is mandatory, not a
defence-in-depth nicety.

**This also touches `_isTailnetSocket`, which is why it is stated here.** Serve
moves every request to loopback, so the tailnet-trust branch in `_checkAuth` stops
firing and the loopback branch takes over. Access still works — both return true —
but `starting-the-board-prints-one-address-never-a-token` and
`browser-board-csrf-cross-site-rejection` both reason about that boundary, and
should be re-read against serve before either lands.
- **Failure must never block.** `resolveUserId()`'s existing rule is the one to
  copy — *"attribution only — a missing value degrades, it never blocks the write"*
  (`machineAttribution.ts:86`). An unreachable Tailscale socket on a *first*
  sighting means "no identity", which means the unfiltered board, never a refused
  request. A locked-out operator would be a far worse bug than a missing filter.
  Once a peer is in the map, Tailscale being down is irrelevant, which is the
  main benefit of resolving once.
- **In-flight de-duplication.** Two requests from the same unseen node arriving
  simultaneously must not trigger two whois calls. Memoise the whois *promise*
  per node ID (not just the result), so the second request awaits the first's
  resolution. The map stores the resolved value; the in-flight promise is
  discarded after it settles.
- Loopback has no peer identity to resolve. Treat it as unidentified and show
  everything; the operator at the machine is not a second user.
- **Provide a way to forget a mapping.** A machine changing hands is rare but a
  wrong sticky identity would be invisible and permanent, and
  `resetUserAttributionCache()` (`machineAttribution.ts:109`) already establishes
  that these caches get an explicit escape hatch. The wire path: a
  `forgetPeerIdentity` API verb (mirroring `setProjectFilter`'s verb pattern at
  `KanbanProvider.ts:10348`) that removes the entry from the in-memory map and
  rewrites `peer-identities.json`. No UI button is required for the first cut —
  the verb is the escape hatch, and a UI affordance can follow if the operator
  asks for one.
- **The client must learn its own identity — `GET /whoami`.** The server resolves
  the peer's identity (whois or `Tailscale-User-Login` header), but the WS scope
  is client-declared: the browser sends `?assignee=<userId>`. Without a bridge,
  the "mine" toggle has no default — the user must manually pick themselves from
  the roster on every page load, which is "a filter exists" but not "I see my
  cards." Add a `GET /whoami` endpoint in `LocalApiServer.ts` that returns the
  resolved identity for the current connection (`{ userId, login, label }` or
  `null` when unidentified). The browser fetches it on load, defaults the "mine"
  filter to the returned `userId`, and connects the WS with `?assignee=<userId>`.
  No endpoint exists today (no `whoami`/`/me`/identity route in
  `LocalApiServer.ts`); this is the connective tissue between Change 2
  (server-side identity) and Change 3 (client-side filter), strictly implied by
  the goal. The endpoint reuses the same resolution path (header → whois →
  null) and the same loopback-only header gate as every other identity read.

### 3. The filter, mirroring the project filter at all four layers

> **Superseded:** "Reuse the existing three-way scope key rather than inventing a
> second keying scheme; the combination is a compound key, not a parallel one."
> **Reason:** "Compound key, not a parallel one" is ambiguous — it could mean
> encoding `project|assignee` into the single `?scope=` string, which would
> corrupt the existing WS upgrade protocol and break every client that sends
> `?scope=`. The clean approach is a second scope *dimension* on the connection
> metadata, with the broadcast cache key becoming a compound of both dimensions.
> **Replaced with:** Add a second `meta.assignee` field to `ConnectionMeta`
> (`wsHub.ts:139`), a second `?assignee=` query param at upgrade (alongside
> `?scope=` at `:335-337`), and extend the `__scope` message (`:372-376`) to carry
> an optional `assignee` field. The broadcast factory cache key (`:474-484`)
> becomes `${projectKey}|${assigneeKey}` where each dimension retains its
> three-way (undeclared/null/named) encoding. `getFullState` (`wsHub.ts:111`)
> gains a second parameter `(scope?, assignee?)` and the provider's
> `getFullStateMessages` (`KanbanProvider.ts:1328`) threads both to the
> scope-dependent accessors. **The `getFullState` call site at `wsHub.ts:388`
> (currently `this._options.getFullState!(meta.project)`) must also pass
> `meta.assignee`** — the signature change is half a change without the call
> site, and a reconnecting client whose resync is rendered without the assignee
> dimension gets the unfiltered board regardless of its declared scope. The
> `setPushScope` verb (`:10343`) gains an optional `assignee` field, and
> `BroadcastHub.setWebviewScope` (`broadcastHub.ts:52`) gains a sibling
> `setWebviewAssignee`.

- DB: a filtered board read alongside `getBoardFilteredByProject`
  (`KanbanDatabase.ts:5030`) — `getBoardFilteredByAssignee`, same shape, filtering
  on `plans.assignee` instead of `plans.project_id`. However, the current
  architecture sends ALL cards and filters client-side (see
  `getFullStateMessages` at `KanbanProvider.ts:1349` passing `null` for project),
  so the DB filter may not be needed for the board read. It IS needed for
  `getPlansByColumn` (`:5071`) if the assignee filter is to narrow column counts.
  Follow the project filter's pattern: add the parameter, keep the unfiltered
  path as the default.
- Provider: an `_assigneeFilter` beside `_projectFilter` (`KanbanProvider.ts:316`),
  persisted to config the same way (`setProjectFilter` at `:8620` writes
  `kanban.activeProjectFilter`; the assignee filter writes
  `kanban.activeAssigneeFilter`), and seeded at boot the same way. **Both
  composition roots must wire the seed:**
  - **Standalone:** `bootstrap.ts:1696-1706` seeds `_projectFilter` from
    `kanban.activeProjectFilter` because `_refreshBoardImpl` returns early on
    `!this._panel` and standalone has no panel. Add a parallel block reading
    `kanban.activeAssigneeFilter` into `(kanbanProvider as any)._assigneeFilter`.
  - **Extension:** `_refreshBoardImpl` reads `kanban.activeProjectFilter` into
    `_projectFilter` at the top of every refresh (the read block is at
    `KanbanProvider.ts:3960-4001`). Add a parallel read for
    `kanban.activeAssigneeFilter` into `_assigneeFilter` in the same block.
  Without both, the filter silently resets on every standalone restart — the
  exact composition-root divergence AGENTS.md documents.
- Push: extend the per-connection scope so the resync and broadcasts respect it,
  per the Superseded callout above. The `updateBoard` push factory must render
  per (project, assignee) scope pair so each connection receives its filtered
  card set. The broadcast cache key at `wsHub.ts:476` changes from
  `p:${meta.project}` to `p:${meta.project}|a:${meta.assignee}`.
- The filter is **additive with the project filter**, not exclusive. Someone on a
  two-person team will want "my cards, in this project".

### 4. Where it renders — and where it deliberately does not

**Not on the kanban card.** The operator's call, and the right one: the board is
already dense and an owner chip on every card buys nothing the filter does not.
This stays a filter dimension, not card decoration.

- **Board header** — a mine/everyone toggle beside the project selector. Same shape
  of control, same mental model, and it composes with the project filter rather
  than replacing it. The project selector is in `kanban.html` (42 refs to
  `boardProjectFilter` / `activeProjectFilter`); the toggle follows the same
  client-side filter pattern (`kanban.html:6681-6685`).
- **Card detail** — the picker to set or clear an assignee, with the reassignment
  history from change 5 beside it.
- **The roster fills itself** from `peer-identities.json` (see change 2), not from
  a list anyone maintains. Adding someone to Tailscale should be the only step.
- **Naming: operator.** Settled, and it needs no coinage — it is already the house
  word for the human, 487 uses in `src/` and 2,407 across plans (*"the operator can
  see"*, *"the operator types into"*, *"the operator goes remote"*), and never once
  used for an agent. So *"assigned to an operator"* cannot be misread, where
  *"assigned to a team member"* certainly can: "team" is taken by the agent team —
  `headRole: lead` with coders and interns, its own TEAMS tab.

  `assignee` stays the column and the picker label; **operator** is the noun for the
  person. Rejected alternatives, with the reason: **roster** is taken for the agent
  lineup (507 uses) and reusing it would be the worst available choice; **member** is
  taken by `mission_members`; **crew/squad/staff** have zero prior use and would be
  new vocabulary to teach.

  *Squad* was considered. It is a **group** noun, and this design has no group — a
  per-card assignee and a filter, with nothing joining people together. Naming an
  entity the data model does not have tends to summon one. If it is wanted as UI
  chrome on the filter toggle that is harmless, but nothing named `squad` should
  reach the schema or the API.

The consequence of keeping it off the card, stated so it is a choice rather than an
oversight: with the filter off, ownership is invisible until a card is opened. That
is acceptable because the filter is the affordance — but it means the toggle has to
be obvious, and a filtered board should say so plainly rather than looking like a
board that has lost cards.

### 5. Record an assignee change in `plan_events`

- Append an event when a card's assignee changes — from, to, and who made the
  change. The `user_id` column added by V72 (`KanbanDatabase.ts:1008`) is already
  there for the actor, and `payload` carries the rest (`{ from, to }` as JSON).
  Use `appendPlanEventByPlanId` (`KanbanDatabase.ts:12643`), which accepts
  `payload` (and `eventType`, `workflow`, `action`, `timestamp`, `workspaceId`).

  > **Superseded:** "Use `appendPlanEventByPlanId` (`:12665`), which already
  > accepts `payload` and `user_id`."
  > **Reason:** The function does NOT accept a `user_id` parameter. Its
  > signature (`:12643`) is `{ eventType, workflow?, action?, timestamp?,
  > payload?, workspaceId? }` — no `userId`. It computes `userId` internally
  > from `resolveUserId()` at `:12654` and hardcodes it into the INSERT params
  > at `:12675`. The original wording conflated the internal `userId` variable
  > with a function parameter, implying the actor can be threaded by "passing a
  > different value to an existing parameter" — there is no such parameter.
  > **Replaced with:** Extend the `appendPlanEventByPlanId` signature with an
  > optional `userId?: string` parameter. When provided, it overrides the
  > internal `resolveUserId()` call (use `event.userId ?? resolveUserId().value`
  > at `:12654`). The assignee-change path passes the request-scoped identity
  > (from `GET /whoami` resolution) as `userId`; all other callers omit it and
  > get the existing host-attribution behaviour unchanged. This is a signature
  > change, not a call-site-only change.
- **The actor is the per-request identity** (the whois-resolved or
  header-resolved operator), NOT `resolveUserId()`. `resolveUserId()` answers
  "whose machine is this" (the host operator); the actor of an assignee change
  is "who made the request" (the peer). These are different people on a shared
  LABCOM. Thread the per-request identity via the new `userId` parameter (see
  the Superseded callout above) — the internal `resolveUserId().value` at
  `:12654` is overridden by the request-scoped identity on the assignee-change
  path only.
- This is the history a small team actually wants: not "who owns this now" but "who
  handed it over, and when". The column alone answers the first and loses the
  second.
- It also makes the advisory contract auditable. If a card keeps being reassigned
  away from someone, that is visible rather than folklore.

## Verification Plan

### Automated Tests

- A card assigned to another tailnet user is still dispatchable, movable and
  completable by you. This is the test that proves it stayed advisory; if it fails,
  authorization has crept in.
- With the filter on, unassigned cards remain visible to every user.
- Two tailnet peers connected at once each see their own filtered board, and a move
  by one reaches the other — the push scope narrows what is shown, not what is
  synced.
- Stopping Tailscale's daemon leaves the board fully usable and unfiltered. No
  request is refused for want of an identity.
- The filter composes with the project filter in both orders.
- `whois` is called **once per unseen node**, never per request. Assert that a
  burst from a known peer makes no LocalAPI call at all, and that restarting the
  host does not re-resolve a peer already in the map.
- Two simultaneous requests from the same unseen node trigger exactly one whois
  call (in-flight promise de-duplication).
- An assignee change appends exactly one `plan_events` row carrying the actor, the
  old value and the new one.
- The board identifies the caller both ways: reached directly on its port, and
  reached through `tailscale serve`. Neither path is required for the board to work,
  and with neither available the board is unfiltered rather than unusable.
- A `Tailscale-User-Login` header sent to the tailnet listener by a client is
  ignored; only the loopback path honours it.
- The same operator connecting from two devices sees **one** filtered board, not
  two. This is the node-vs-user distinction in change 2 and is the test that proves
  it was implemented the right way round.
- `PLAN_COLUMNS` includes `assignee` — assert that `getBoard` returns rows with
  a non-empty `assignee` field when seeded.
- The standalone host restores `_assigneeFilter` from
  `kanban.activeAssigneeFilter` on restart (composition-root parity with
  `_projectFilter` at `bootstrap.ts:1696-1706`).
- The `updateBoard` broadcast factory renders a distinct payload per
  (project, assignee) scope pair — assert that two connections with different
  assignee scopes receive different card sets from a single `broadcast()` call.
- `GET /whoami` returns the resolved identity (`{ userId, login, label }`) for
  the current connection — a tailnet peer gets its whois-resolved email, a
  serve-fronted request gets its `Tailscale-User-Login`, and loopback gets
  `null` (unidentified). The "mine" toggle defaults to the returned `userId`
  without a manual roster pick.

### Goal Invariants

- Assert `plans` table has column `assignee TEXT DEFAULT ''` (migration V76
  applied).
- Assert `PLAN_COLUMNS` (`KanbanDatabase.ts:1555`) includes `assignee`.
- Assert `ConnectionMeta` in `wsHub.ts` has an `assignee` field.
- Assert `wsHub.ts` broadcast cache key (`:476`) incorporates both `meta.project`
  and `meta.assignee`.
- Assert the `getFullState` call site at `wsHub.ts:388` passes `meta.assignee`
  alongside `meta.project` (resync rendered with both dimensions).
- Assert `bootstrap.ts` reads `kanban.activeAssigneeFilter` into
  `_assigneeFilter` (standalone composition-root seed).
- Assert `peer-identities.json` is written via `stateFile()` with tmp-then-rename.
- Assert `_isTailnetSocket` (`LocalApiServer.ts:1563`) returning `true` causes
  `Tailscale-User-Login` to be ignored (header honoured on loopback only).
- Assert a whois response for a tagged node (`Node.Tags` non-empty) is treated
  as unidentified — the peer map is NOT populated with `tagged-devices` as a
  user identity.
- Assert every LocalAPI whois request sets `Host: local-tailscaled.sock` — a
  request with `Host: localhost` receives a 403.
- Assert `Tailscale-User-Login` values are Q-decoded (a Q-encoded non-ASCII
  login name decodes to its UTF-8 form before being used as the assignee
  identity).
- Assert `GET /whoami` exists as a route in `LocalApiServer.ts` and returns
  `{ userId, login, label }` (or `null` for unidentified/loopback).
- Assert `appendPlanEventByPlanId` (`KanbanDatabase.ts:12643`) accepts an
  optional `userId` parameter that overrides the internal `resolveUserId()`.
- Assert `UPSERT_PLAN_CONFLICT_SQL` includes
  `assignee = COALESCE(NULLIF(excluded.assignee, ''), plans.assignee)` (not a
  bare `assignee = excluded.assignee`).

## Resolved Assumptions

The following were confirmed via web research against the Tailscale Go source
(`ipn/localapi/localapi.go`, `ipn/ipnlocal/serve.go`, `client/local/local.go`,
`apitype/apitype.go`, `tailcfg/tailcfg.go`) and official documentation. They are
authoritative for this plan — do not re-research.

- **Tailscale LocalAPI `whois` endpoint.** Path is
  `GET /localapi/v0/whois?addr=<ip>[:port]` on the same unix socket as
  `/localapi/v0/status`. Query params: `addr` (required, accepts bare IP or
  IP:port or `nodekey:<key>`), `proto` (optional, `tcp`/`udp`), `svc_name`
  (optional), `dst_ip` (optional). Response is `application/json` with three
  top-level fields: `Node` (a `tailcfg.Node`), `UserProfile` (a
  `tailcfg.UserProfile`), `CapMap`. Both `Node` and `UserProfile` are never nil
  in a 200 response. **Stability:** whois carries an explicit
  `// API maturity: this is considered a stable API` marker as of a July 2026
  change — the `tailnetDetect.ts:17` "explicitly unstable" comment is stale for
  whois specifically (though still accurate for other LocalAPI endpoints).
  **Host header:** the handler 403s unless `Host` is `local-tailscaled.sock` or
  empty — most HTTP-over-unix-socket clients set `Host: localhost` and fail.
  **Permissions:** on Linux the socket is `0666` and whois needs only
  `PermitRead`, so an unprivileged Switchboard process can call it — no root.
  **Tagged nodes:** a node with ACL tags returns
  `UserProfile.LoginName === 'tagged-devices'` with a shared synthetic ID —
  must be rejected as a user identity.
- **`tailscale serve` identity headers.** Exact names: `Tailscale-User-Login`
  (email), `Tailscale-User-Name` (display name), `Tailscale-User-Profile-Pic`
  (profile pic URL). Plus `Tailscale-Headers-Info` (constant docs URL) and
  `X-Forwarded-For` (source IP only, no port). Always-on for HTTP/HTTPS serve —
  no flag required. NOT injected for `--tcp`, Funnel traffic (replaced by
  `Tailscale-Funnel-Request: ?1`), tagged source nodes, or non-proxy serve
  targets. **Spoofing protection:** serve *strips* client-supplied
  `Tailscale-User-Login`/`-Name`/`-Profile-Pic` before injecting its own, so
  spoofing is blocked on the serve path. Direct tailnet connections carry no
  Tailscale headers and any client-supplied value is fully spoofable — the
  loopback-only trust gate is mandatory. **Q-encoding:** non-ASCII values in
  `Tailscale-User-Login` and `Tailscale-User-Name` are RFC 2047 Q-encoded
  (e.g. `=?utf-8?q?Ferris_B=C3=BCller?=`); `Tailscale-User-Profile-Pic` is raw.
  **No stable user ID in headers:** serve headers carry only `LoginName`
  (email), not `UserProfile.ID` (numeric). The assignee column keys on email
  to keep both identity paths consistent — see Proposed Changes §2.
- **No `Tailscale-User-Id` or `Tailscale-Node` header exists.** `X-Tailscale-User`
  and `X-Webauth-User`/`X-Webauth-Name` are third-party conventions
  (caddy-tailscale), not Tailscale's own. `cmd/nginx-auth` emits a *different*
  set (`Tailscale-Login`, `Tailscale-User`, `Tailscale-Name`,
  `Tailscale-Profile-Picture`, `Tailscale-Tailnet`) — do not confuse those with
  serve's headers.

## Outstanding Questions

None. The four decisions that would have needed one are settled: assignees are
advisory, unassigned belongs to everyone, identity is resolved once per machine
rather than per request, and assignee changes are recorded in `plan_events`.
