# One Shell Load Builds the Board Fourteen Times, Then Discards Half of Them

## Goal

Cut the cost of opening the browser shell from fourteen independent board snapshots to two or three.
A panel that does not render the board should never cause it to be built.

### Problem analysis

**Raised as:** *"28 open WS connections on a host that has only been up 16 minutes."*

**The connection count is not a leak.** Established first, because that was the suspicion:

- `/panels` returns exactly **14** panels. `shell.js:5-7` states the design: *"All iframes are
  mounted up-front and toggled via display; each panel keeps its state and its live WebSocket across
  switches (instant switch, no reconnect)."* So one shell load = 14 sockets, held for the life of
  the tab. 28 = two open shell tabs.
- `originatorId` is minted per page context (`transport.js:185`), fresh on every load. The live
  roster showed **0 duplicate originatorIds**, so reconnects are not accumulating metas.
- The reaper works: 30 s ping, reap on a missed pong (`wsHub.ts:222-249`), through the single
  removal path `_removeConnection` (`:262`) shared with `handleDisconnect`.
- Measured over 5 minutes: WS count flat at 28, host fds flat at 73-78, RSS sawtoothing 290-348 MB
  and returning to baseline. Nothing grows.
- All 32 established TCP peers were a single tailnet address — one device, two tabs.

Two cohorts were visible, 24.9 h apart in load time, both still connected: a shell tab open for a
day, and one loaded 80 s after a host restart. Both reconnected cleanly.

**Local and remote are not separate hosts, and this is easy to assume they are.** The process
listens on two addresses — `127.0.0.1:7777` and the tailnet address `100.94.172.32:7777` — but both
hand their upgrades to the same `upgradeRouter` and the same single `_wsHub`
(`LocalApiServer.ts:1246`). One process, one hub, one event loop, one board. A remote viewer is
another client of the same process, not a second server, so every device with the shell open adds
its own 14 connections to the same hub and its own 14 builds to the same queue. Two devices
reloading at once double the burst above.

**The real cost is at connect, and it is per connection.**

Idle traffic is nothing: 60 s on a live connection carried 2 messages. But every WS upgrade calls
`getFullState(meta.project)` (`wsHub.ts:388`) → `bootstrap.ts:1086` →
`KanbanProvider.getFullStateMessages` (`:1328`) → `db.getBoard` + `db.getCompletedPlans` +
`_buildBoardCards` + column building. **There is no cache and no coalescing.** Fourteen upgrades
inside ~1.5 s at shell load means fourteen full board builds.

Measured against the live host:

```
resync payload: 445.2 KB in 7 items
  443.2 KB  surface=kanban  updateBoard          <- 99.6% of it
    1.0 KB  surface=kanban  updateColumns
    0.6 KB  surface=kanban  updateWorkspaceSelection
    0.2 KB  surface=common  updateAutobanConfig
    0.1 KB  surface=kanban  cliTriggersState
    0.1 KB  surface=common  updatePairProgrammingMode
    0.1 KB  surface=common  switchboardThemeNameSetting

updateBoard: 641 cards, 707 bytes/card
  (541 active rows — all with plan files present — plus ~100 completed)
```

**And the filter runs after the build, not before.** `_filterResync` (`wsHub.ts:359`) drops items
whose `surface` the connection did not declare — correct, and it works. But the payload it filters
was already built in full. One resync per declared surface, measured:

```
setup        0.3 KB  items=3  517ms
terminals    0.3 KB  items=3  531ms
design       0.3 KB  items=3  551ms
memo         0.3 KB  items=3  541ms
kanban     445.2 KB  items=7  635ms
none       445.2 KB  items=7  650ms
```

Half a second and a full 641-card board build to deliver 0.3 KB. Per shell load that is **7 builds
delivered** (3 connections declare `kanban` — board, agent-control, command — and 4 declare nothing
at all) and **7 builds discarded outright**.

**Measured: a shell load saturates the host for 2.75 seconds and blocks everyone else.** Fourteen
concurrent upgrades with the real panel surface declarations, against the live host:

```
per-panel resync arrival (ms from first connect):
   2518 ms    0.3 KB  terminals        2687 ms  445.9 KB  board
   2520 ms    0.3 KB  planning         2700 ms  445.9 KB  command
   2521 ms    0.3 KB  tickets          2709 ms  445.9 KB  mission-control
   2525 ms    0.3 KB  design           2718 ms  445.9 KB  agent-control
   2529 ms    0.3 KB  setup            2727 ms  445.9 KB  linear
   2529 ms    0.3 KB  memo             2742 ms  445.9 KB  database
   2530 ms    0.3 KB  connections      2751 ms  445.9 KB  project

wall time for all 14:  2751 ms
host CPU consumed:     2.63 s  -> 96% of one core, saturated for the whole window
bytes delivered:       3123 KB
/health latency during the burst:  min 37 ms, median 758 ms, max 1508 ms
```

Two things this settles that arithmetic could not:

- **The builds serialize and nobody gets served early.** Node is single-threaded, so the fourteen
  builds queue. The *first* panel to answer still waited 2.5 s, and it is one of the ones whose
  board was thrown away. Every client pays the whole queue.
- **The event loop is blocked, so the cost is not confined to the browser.** `/health` — normally
  37 ms — ran at a 758 ms median and 1.5 s worst case throughout. Anything else talking to the host
  during a shell load waits: agent prompt delivery, card moves, `lc next`, the CLI. A page load
  stalls the whole board, not just the page loading it.

This is also why "do the open panels cost anything?" and "does opening the shell cost anything?"
have different answers. Idle, the fourteen connections are free — 2 messages in 60 s, measured. The
entire cost is at connect, and it lands as one burst that stops the host answering.

**Four panels pull a board they never render.** `mission-control`, `project`, `linear` and
`database` are absent from `PANEL_SURFACES` / `PANEL_SURFACES_MAP`, so they declare no surfaces and
fail open — by design, and for `project` deliberately (the comment on `PANEL_SURFACES` explains that
declaring a set for it breaks saving). The consequence is that each of them receives the entire
445 KB board on connect.

**Relationship to the existing board-payload plan.** `The Board Renders Every Card It Has Ever Held`
measured a *single* request and concluded, correctly, that the server was not the bottleneck on
either path. This is the multiplier that measurement could not see: the same build repeated fourteen
times per page load. That plan's numbers (2.8 MB, 2,475 rows) also predate archiving — the board is
now 445 KB and 641 cards, so its transfer argument has weakened while this one has not.

## Metadata

**Complexity:** 2
**Tags:** performance, standalone, websocket, resync, browser-shell
**Dependencies:** complements `The Board Renders Every Card It Has Ever Held, So Opening It Takes
Long Enough to Look Broken`. Independent of it — this is server CPU, that is wire bytes and DOM.

## User Review Required

None.

## Proposed Changes

### 1. Coalesce the snapshot across simultaneous connects

- **Logic:** memoize `getFullState` per declared scope with a short TTL (a second is enough to cover
  a shell load), or simply share one in-flight promise per scope so concurrent upgrades await the
  same build.
- Key it the way `broadcast()` already keys factory renders (`wsHub.ts:474-482`): the three-way
  "undeclared" / "declared null" / "project name" split, with the same NUL-prefixed sentinels.
  Undeclared and explicitly-null are different scopes and must not share a snapshot — that
  distinction already exists and must not be lost here.
- Expected effect: 14 builds → 2 or 3 (one per distinct scope in the tab).

### 2. Do not build what the connection cannot receive

- Thread `meta.surfaces` into `getFullState` so a connection declaring `design` never runs
  `db.getBoard`. `_filterResync` then becomes a safety net rather than the mechanism.
- This is the larger win of the two for panels like `setup` and `memo`: today they pay 500 ms and a
  full board build for 0.3 KB.

### 3. Decide what the four undeclared panels actually need

- `mission-control`, `project`, `linear`, `database` each pull 445 KB they do not render.
- `project`'s omission is deliberate and commented — do not just add an entry. Establish what each
  of the four consumes from the resync first, then declare a surface set for the ones that can take
  one, and leave a comment for any that genuinely cannot.

### 4. Reconsider mounting all fourteen iframes up front

- Out of scope to change here, but worth stating: the up-front mount is what turns any
  per-connection cost into a 14x cost, and it is the reason a shell load is the most expensive thing
  the host does. Changes 1 and 2 make it affordable rather than removing it. Lazy-mounting on first
  visit would remove it, at the cost of a slower first switch to each panel.

## Verification Plan

- Count `db.getBoard` calls across one shell load: 14 before, 3 or fewer after.
- A connection declaring `design` receives its 0.3 KB without any board query running.
- Re-run the 14-panel burst measurement. The baseline to beat, on this box: **2751 ms wall, 2.63 s
  CPU, 3123 KB delivered, `/health` at a 758 ms median during the window.** The `/health` median is
  the number that matters most — it is the one that shows other callers being starved.
- The first panel to receive its resync should no longer be waiting on the whole queue.
- Two connections declaring different scopes still receive correctly scoped snapshots — the
  coalescing must not collapse undeclared, null and named-project into one.
- The WS count still returns to baseline when a tab closes (the reaper and `_removeConnection` are
  working today; a caching change must not touch that).

## Outstanding Questions

- Is a short TTL cache safe against a board mutation landing mid-shell-load? The resync is a
  seq-0 baseline and every later broadcast increments from it, so a snapshot up to a second stale
  followed by deltas should converge — but the ordering comment at `wsHub.ts:378-386` is the thing to
  check this against, not an assumption.
