# tmux Belongs in the Go Host, Not a Second Fleet in TypeScript

## Goal

Move tmux ownership into the Go PTY host so Switchboard has **one fleet**. A tmux pane becomes another
kind of process the host manages, reached through the same verbs as a PTY seat — not a parallel fleet
service in TypeScript that every consumer has to be taught about separately.

> **Clarification (2026-09-09 improve pass):** The Goal is preserved verbatim above. The execution path
> to it has changed since the plan was first written — see the second Superseded callout below. "One
> fleet" is now achieved for **seating** by the supplement path that shipped in `e60e3982` (the seat is
> a Go PTY whose startup command runs `tmux attach`). What remains is **deletion of the duplicate seating
> module**, a decision on the **external-pane adoption** feature (which the supplement path does not
> cover), and **collapse of the legacy scoped setting**. The Goal's intent — one fleet, no parallel TS
> service — still stands; the mechanism is deletion + decision, not a port.

### Problem analysis

**tmux was never part of the Go migration.** *Go Where It Pays* scoped three things — the launcher, the
PTY host, and the CLI's client verbs — and all four of its cards are in CODE REVIEWED. tmux landed
afterwards, in TypeScript, and the Go host has **zero** references to it. This is not unfinished
migration work; it is a feature built beside the host rather than inside it.

#### What that decision cost

`tmuxBackend.ts` executes every tmux operation with `execFile('tmux', argv)` from Node. Fourteen
argv verbs in total:

```
has-session   new-session    kill-session   list-sessions
list-panes    split-window*  kill-pane      resize-pane
select-pane   select-window  select-layout  send-keys
load-buffer   paste-buffer   delete-buffer
```

Every one is a subprocess invocation with an argv array — precisely what the Go host already does to
spawn and supervise PTYs. Nothing about them needs Node.

Building it in TypeScript forced a **second fleet service**, and that is where the real damage is:

| | owns | created by | lines |
| :--- | :--- | :--- | ---: |
| `GoPtyFleetProjection` | PTYs in the Go host | `ptyFleetService.create()` | — |
| `TmuxFleetService` | tmux panes | `createTmuxHeadWithDelegates`, `adopt` | 446 |
| `tmuxBackend` | the argv shell-outs | — | 499 |
| `tmuxTeamSeating` | session creation, seating, reconcile | — | 605 |

Roughly 1,550 lines of TypeScript implementing a fleet the Go host could own.

**Three consequences, all of them live today:**

1. **Seat ownership is decided by call path, not by intent.** `bootstrap.ts:3990` picks a backend at
   the `createHeadWithDelegates` seam — the *team* path. A Terminals-panel group is spawned one
   terminal at a time through `ptyFleetService.create()`, which has no tmux branch at all. So no
   setting can put a group in tmux. That is filed separately as
   *tmux seating is team-only, so a panel group never gets a session*; **this plan supersedes the
   design half of it**, because with one create path the group case stops being a design problem.
2. **Two settings, both unreachable until today.** `switchboard.terminal.tmux.enabled` arms the probe
   and fleet construction; a separate scoped `terminalBackend` decides whether a team is actually
   seated in tmux. Two switches exist because two fleets exist.
3. **Every name-resolver has to span both fleets.** Dispatch pre-flight, prompt delivery, the liveness
   sweep and the panel's pane assignments each have to resolve a seat that may live in either. A name
   that resolves for dispatch but not for liveness produces a seat that works and reports dead.

### The trade, stated plainly

Moving tmux into Go adds another TypeScript↔Go boundary, and this repository has already paid for one.
`nothing-asserts-the-go-pty-host-and-the-webview-agree-on-a-wire-format` records four wire mismatches
that shipped in a single commit — origin allowlist, a missing route, output framing, and input framing
— each hiding the next, every gate green throughout, found by taking a screenshot of a black
rectangle. A fifth (`198dba7a`) came from the same root.

That is the honest cost of this plan, and it is why the contract test is a prerequisite rather than a
nicety: **the way to make this boundary safe is to assert it, not to avoid it.** The alternative —
leaving tmux in TypeScript — keeps a second fleet forever and pays for it at every consumer instead.

---

> **Superseded (2026-09-08, by shipped code — commit `e60e3982`):** the framing that the two-fleet
> split is what blocks tmux for individual agents and panel groups, and that this plan is the
> prerequisite for them.
> **Reason:** It was not the blocker. A single missing branch in `ptyCreateTerminal` was, and it is
> fixed — an individually-created agent now lands in a Switchboard-owned tmux session. The consumers I
> assumed would each need teaching already resolve tmux seats: `triggerAction` (6 lookups),
> `sendToTerminal` (3), plus the dedicated `tmuxAdoptPane` / `tmuxReleasePane` / `tmuxListPanes` /
> `tmuxClearPane` verbs.
> **What remains true, and why this card is still worth doing:** ~1,550 lines of TypeScript
> (`tmuxBackend` 499, `tmuxFleetService` 446, `tmuxTeamSeating` 605) implement a fleet the Go host
> could own; two settings still exist because two fleets do (`terminal.tmux.enabled` and the scoped
> `terminalBackend`); every seat resolver still has to span both; and tmux still shells out from Node
> via `execFile` while the Go host spawns every other process.
> **Reprice it.** This is consolidation, not enablement — nothing is blocked on it, so the complexity-8
> justification no longer includes "unblocks groups". Judge it on the cost of carrying two fleets
> against the cost of adding another TypeScript↔Go boundary.

> **Superseded (2026-09-09 improve pass):** Proposed Change #1 as originally written — "Port the
> fourteen argv operations to `exec.Command` inside the Go host as a new tmux-backed terminal kind,
> so a tmux pane becomes a process the host manages directly."
> **Reason:** The supplement path (`goPtyFleetProjection.ts:218-282`, shipped in `e60e3982`) already
> achieves one-fleet seating by a different and superior mechanism: the seat stays a Go-host PTY and
> the PTY's startup command runs `tmux attach`. The Go host owns the seat; tmux is a client inside it;
> the board renders the pane through the same PTY socket it always used. Porting argv to Go as a
> *new terminal kind* would (a) duplicate the supplement path for seating, (b) **regress output
> rendering** — a tmux pane created via `exec.Command` has no PTY output stream the Go host owns, and
> the TS `TmuxTerminalHandle` already no-ops `onData`/`onExit` because tmux has no event stream
> (`tmuxBackend.ts:360-368`), so the board would render a black pane unless `capture-pane` polling were
> added (explicitly out of scope), and (c) create a third architecture alongside the supplement path
> and the legacy alternative-backend.
> **Replaced with:** Do NOT port argv to Go as a new terminal kind. The remaining consolidation is
> (1) delete the duplicate *seating* module `tmuxTeamSeating.ts` (its behaviour is already covered by
> the supplement path), (2) decide the fate of the *adoption* fleet (`tmuxFleetService` + `tmuxBackend`)
> — see Outstanding Questions — and (3) collapse the legacy scoped `terminalBackend` setting. The
> "port 14 argv ops to Go" framing applied to *seating*; it does not apply to the supplement path
> that already won.

## Metadata

**Complexity:** 6
**Tags:** go, tmux, fleet, architecture, standalone, refactor
**Dependencies:** the Go/webview wire-contract test (`Nothing Asserts That the Go PTY Host and the Webview Agree on a Wire Format`) should land first — it is the gate that makes this boundary checkable.

> **Dependency status (2026-09-09):** recorded by plan name, not a `sess_` session id — the importer
> keys dependency identity by session, so this line does not resolve as a tracked dependency. The
> blackbox test exists (`src/test/pty-host-blackbox-contract.test.js`, `test:contract:pty-host-blackbox`)
> but reads WebSocket frames with `JSON.parse(String(raw))` while the Go host publishes
> `websocket.BinaryMessage` via `encodeOutputFrame` (`main.go:246`) — the framing the test parses may
> not match the framing the host sends. Confirm the base wire-contract is solid (and that the
> blackbox test asserts binary output, `replayChars`, binary input, origin rule, and board `/ws/terminal`
> proxy) before relying on it as the gate for new tmux frames.

## User Review Required

The adoption decision (see Outstanding Questions) changes the deletion scope and the Goal Invariants.
A human should confirm whether external-pane adoption stays in TS, moves to Go, or is dropped before
the deletion phase executes.

## Complexity Audit

### Routine
- Deleting `tmuxTeamSeating.ts` and its import in `bootstrap.ts` (the `backend === 'tmux'` branch at
  `bootstrap.ts:4011-4029`): the supplement path already covers team seating, so this is dead/duplicate
  code removal.
- Removing the scoped `terminalBackend` setting reads (`bootstrap.ts:4009, 4196`;
  `TaskViewerProvider.ts:14079`) and the `hostServices.ts:341,357,365` `terminalBackend` option, with a
  migration that keeps tmux on for installs that stored `terminalBackend: 'tmux'`.
- Extending the wire-contract test to cover any new tmux frames (none expected under the revised
  approach, since no new Go frames are added — but the assertion is retained for safety).

### Complex / Risky
- **Adoption fleet deletion (conditional):** `tmuxFleetService` is wired into dispatch pre-flight,
  prompt delivery, and the liveness sweep (`bootstrap.ts:2983, 3003, 3060, 3076, 3167, 3332, 3378`),
  not just the four adoption verbs. Removing it requires either migrating adoption to Go or ripping
  the tmux branch out of every resolver — a multi-file coordination change with data-consistency risk
  (a name that resolves for dispatch but not liveness produces a seat that works and reports dead).
- **Setting migration:** an install with `terminalBackend: 'tmux'` stored must keep tmux on rather
  than silently revert; getting the migration direction wrong silently changes a user's running
  fleet on next launch.
- **Wire-contract gate confidence:** building on a contract test whose framing may not match the
  host's actual output encoding (see Dependency status) — a green gate over an untested contract is
  the exact failure mode the wire-contract plan exists to close.

## Edge-Case & Dependency Audit

- **Race Conditions:** `tmuxFleetService._updateRegistry` serializes registry writes through
  `_registryWrite` (`tmuxFleetService.ts:404-428`); any adoption migration must preserve this or
  concurrent adopt/release bursts will interleave read-modify-write cycles and drop entries. The
  supplement path writes through `goPtyFleetProjection.updateRegistryState`, which has its own
  serialization — the two must not both write `runtime.terminals` tmux rows without the `tmuxOwner`
  discriminator (`TMUX_OWNER_ADOPT` / `TMUX_OWNER_SEAT`), or each silently deletes the other's rows.
- **Security:** `tmuxBackend.ts` validates every pane id against `/^%\d+$/` before it reaches any
  `-t` argument (`validatePaneId`, line 55), and uses argv arrays with no shell (`execFile`, line 81).
  Whatever survives deletion must carry this invariant forward — a `session:window.pane` string
  derived from user input is re-numberable and parseable by tmux in ways `%id` is not.
- **Side Effects:** `tmuxTerminalHandle.dispose()` is unregister-only and NEVER `kill-pane`
  (`tmuxBackend.ts:384-386`) — Switchboard did not create adopted panes and must not destroy the
  user's shell. The supplement path's seats ARE owned by Switchboard and ARE killed on close; the
  asymmetry between owned (supplement) and adopted (fleet) seats must survive any refactor.
- **Dependencies & Conflicts:** `tmuxPromptDelivery.ts` (282 lines, `sendPromptToTmux`) is imported
  by `extension.ts`, `standingOrdersDelivery.ts`, `TaskViewerProvider.ts`, `tmuxBackend.ts`,
  `tmuxTeamSeating.ts`, and `bootstrap.ts` — it is a *shared* module, not part of the three deletion
  targets. Deleting `tmuxTeamSeating` leaves `tmuxPromptDelivery` with five other importers; it
  survives. The plan's original "delete all three" did not account for this shared dependency. The
  supplement path does NOT use `sendPromptToTmux` (it writes through the normal PTY verb), so
  `sendPromptToTmux` is only load-bearing for the adoption/alternative-backend path.

## Dependencies

- `sess_XXXXXXXXXXXXX — Go/webview wire-contract test` *(no session id available; the dependency is
  recorded by plan name in Metadata — see Dependency status note there. The gate is the
  `test:contract:pty-host-blackbox` suite, which must be confirmed to assert the four fault shapes
  before this plan's tmux-frame extension is meaningful.)*

## Adversarial Synthesis

Key risks: (1) the original "port 14 argv ops to Go as a new terminal kind" proposal is superseded by
the shipped supplement path and would regress tmux-seat output rendering (no PTY stream; the TS
handle no-ops `onData`/`onExit`); (2) the plan's "delete all three modules" conflates the duplicate
*seating* module (`tmuxTeamSeating`) with the live *adoption* fleet (`tmuxFleetService`+`tmuxBackend`),
whose resolvers span dispatch/delivery/liveness — deleting adoption silently removes a wired feature;
(3) the wire-contract gate may be green over a framing mismatch (test parses JSON, host sends binary).
Mitigations: drop the argv-port proposal in favour of the supplement path; split the deletion into
seating (safe) vs adoption (decision-gated); confirm the blackbox test's framing before extending it.

## Proposed Changes

### 1. Delete the duplicate seating module (`tmuxTeamSeating.ts`)

- **Context:** The supplement path (`goPtyFleetProjection.ts:218-282`) already seats teams and groups
  in tmux by running `tmux attach` inside a Go-host PTY. `tmuxTeamSeating.createTmuxHeadWithDelegates`
  is the legacy alternative-backend path, reachable only via the scoped `terminalBackend: 'tmux'`
  setting (`bootstrap.ts:4011-4029`). It is a duplicate, not a peer.
- **Logic:** Remove `tmuxTeamSeating.ts` and its import in `bootstrap.ts`. Remove the
  `backend === 'tmux'` branch at `bootstrap.ts:4011-4029` so all team/group creation goes through the
  fleet (supplement) path. The supplement path already names sessions for the team/group and reattaches
  on restart via `tmux new-session -A` (`goPtyFleetProjection.ts:261`).
- **Behaviour that must survive (now provided by the supplement path):** session naming
  (`deriveTmuxSessionName`, already called at `goPtyFleetProjection.ts:231`), the reattach branch
  (`new-session -A`, line 261), and per-window grouping (lines 244-256).
- **Edge cases:** A team currently seated via the legacy `terminalBackend: 'tmux'` path must, on next
  launch, re-seat through the supplement path without losing its session — the `new-session -A`
  reattach handles this. Verify a team created the old way reattaches the new way.

### 2. Decide the fate of the adoption fleet (`tmuxFleetService.ts` + `tmuxBackend.ts`)

- **Context:** External-pane adoption (`tmuxAdoptPane`/`tmuxReleasePane`/`tmuxListPanes`/`tmuxClearPane`,
  `bootstrap.ts:3441-3519`) is a *live feature* the supplement path does not cover: the supplement path
  creates Switchboard-owned sessions; adoption attaches to panes Switchboard did NOT create. The
  adoption fleet is also wired into the dispatch/delivery/liveness resolvers
  (`bootstrap.ts:2983-3378`), not just the four verbs.
- **Logic:** This is a decision point — see **Outstanding Questions**. The three options:
  1. **Keep adoption in TS** (lowest cost): retain `tmuxFleetService` + `tmuxBackend` for adoption
     only; delete only `tmuxTeamSeating` (Proposed Change #1). The "one fleet" Goal is met for
     *seating*; adoption remains a TS-side operator feature for external panes. The scoped
     `terminalBackend` setting still collapses (Proposed Change #3) because it only gated the
     seating backend, not adoption.
  2. **Port adoption to Go**: add tmux adoption verbs to the Go host. High cost, low frequency
     (adoption is an operator action, not a hot path), and inherits the wire-contract risk. Not
     recommended unless adoption is strategic.
  3. **Drop adoption**: delete `tmuxFleetService` + `tmuxBackend` and the four adoption verbs, and
     rip the tmux branch out of every resolver. Feature regression — operators lose the ability to
     dispatch into their own existing tmux panes.
- **Edge cases:** Whichever option is chosen, the `tmuxOwner` discriminator
  (`TMUX_OWNER_ADOPT`/`TMUX_OWNER_SEAT`, `tmuxFleetService.ts:100-108`) and the registry merge
  discipline (preserve rows not owned by this writer) must be preserved or migrated — two writers
  sharing `runtime.terminals` without the discriminator silently delete each other's rows.

### 3. Collapse the two settings into one

- **Logic:** `switchboard.terminal.tmux.enabled` becomes the single switch, already surfaced as the
  **Enable tmux** checkbox in the Terminals panel and already read as the master gate
  (`bootstrap.ts:3688, 4130`). The scoped `terminalBackend` setting goes — its only live consumer was
  the legacy seating branch (Proposed Change #1), and its reads at `bootstrap.ts:4009, 4196` and
  `TaskViewerProvider.ts:14079` are removed with that branch. The `hostServices.ts:341,357,365`
  `terminalBackend` option is removed.
- **Edge cases:** An install with `terminalBackend: 'tmux'` stored should keep tmux on rather than
  silently reverting. Migration: on first launch after upgrade, if `terminalBackend === 'tmux'` is
  present in scoped config, set `terminal.tmux.enabled = true` (if not already explicitly false) and
  drop the scoped key. This preserves the operator's intent.

### 4. One create path, so groups work without a design

- **Logic:** With the legacy `backend === 'tmux'` branch removed (Proposed Change #1), all team and
  group creation goes through `ptyFleetService.create()` → `goPtyFleetProjection.create()`, which
  already honours the `tmuxSession` option (`goPtyFleetProjection.ts:230-282`). A Terminals-panel group
  gets a session named for the group and its terminals as named windows, on the same code that serves
  a team. The companion plan's requirements 2 and 3 are satisfied by construction — no new code, just
  the deletion of the branch that bypassed this path.
- **Edge cases:** Verify the group case actually passes `tmuxSession` through. The team path sets
  `teamSession` at `bootstrap.ts:4051-4053`; confirm the panel-group path (one terminal at a time via
  `ptyFleetService.create()`) sets an equivalent group-named session, or groups will still fragment.

### 5. Extend the wire-contract test to the tmux frames (if any)

- **Logic:** Under the revised approach, **no new Go frames are added** — the supplement path uses
  the existing PTY verbs and the existing binary output frame. So this section is retained as a
  safety assertion rather than a primary deliverable: whatever frames or fields the deletion/migration
  touches are covered by the same `test:contract:pty-host-blackbox` suite that starts the real binary
  and drives real frames. A comment describing the contract is what failed last time.
- **Prerequisite:** Confirm the blackbox test asserts the four fault shapes (binary output frame,
  `replayChars` in `hello`, binary `0x01`+UTF-8 input with socket-still-open, origin rule) before
  relying on it — see Dependency status. If the test parses JSON while the host sends binary, extend
  the test FIRST, then extend for tmux.

## Verification Plan

### Automated Tests
- The contract test starts the real host and exercises a tmux-backed seat end to end: create, list,
  write, prompt, rename, close — all through the existing PTY verbs, since a tmux seat is now a PTY
  running `tmux attach`.
- With the setting on and tmux present: a team **and** a panel group each get a session named for them,
  with windows named for their terminals (supplement path, `goPtyFleetProjection.ts:230-282`).
- With tmux absent: creates fall back to PTY seats (no `tmux attach` wrapper), with a log line saying
  why; no failed create.
- Restart with both a team and a group running: sessions and window names are reused via
  `new-session -A`, nothing recreated.
- **Adoption (if kept, Option 1):** `tmuxAdoptPane`/`tmuxReleasePane`/`tmuxListPanes`/`tmuxClearPane`
  still resolve an external pane by name for dispatch, delivery, liveness and pane assignment.
- **Adoption (if dropped, Option 3):** the four verbs return a clear "feature removed" error and the
  resolvers no longer carry the tmux branch.
- **Setting migration:** an install with `terminalBackend: 'tmux'` stored keeps tmux on after upgrade.

### Goal Invariants
- Exactly one **seating** fleet path exists: `goPtyFleetProjection` (supplement). The legacy
  `backend === 'tmux'` branch in `bootstrap.ts` is absent.
- `tmuxTeamSeating.ts` is absent from `src/standalone/`.
- Backend is a property of a seat (the PTY's startup command), never of the call path that made it.
- One setting decides tmux (`terminal.tmux.enabled`); the scoped `terminalBackend` key is absent from
  `bootstrap.ts` and `TaskViewerProvider.ts` reads, and migrated for legacy installs.
- **Conditional on the adoption decision (Outstanding Questions):**
  - If adoption is **kept (Option 1):** `tmuxFleetService` + `tmuxBackend` remain; the four adoption
    verbs resolve; `child_process` reference to `tmux` remains in `src/standalone/tmuxBackend.ts` only
    (adoption path), NOT in any seating path.
  - If adoption is **dropped (Option 3):** no `child_process` reference to `tmux` remains in `src/`;
    `tmuxFleetService` + `tmuxBackend` are absent; the four adoption verbs are absent or stubbed.

### Manual
- Open four terminals, SAVE AS GROUP, confirm `tmux ls` shows a session named for the group; attach
  from an SSH client and confirm it is the terminal the board is driving.
- Start a team; confirm the same, and that a board restart reattaches both with names intact.
- **Adoption (if kept):** adopt an external `coder-1` pane by title, dispatch a prompt, confirm it
  lands and the pane reports live (not "works and reports dead").

## Outstanding Questions

- **[user]** Should external-pane adoption (`tmuxAdoptPane`/`tmuxReleasePane`/`tmuxListPanes`/
  `tmuxClearPane`) be kept in TypeScript (Option 1, lowest cost), ported to Go (Option 2, high cost),
  or dropped (Option 3, feature regression)? — proceeding on the assumption that **Option 1 (keep in
  TS)** is the default: delete only the duplicate seating module `tmuxTeamSeating`, retain
  `tmuxFleetService`+`tmuxBackend` for adoption, collapse the scoped setting. This keeps the
  "one fleet" Goal for seating while preserving a live operator feature; the Goal Invariants above
  are written to branch on this decision.
- **[user]** Does the panel-group create path actually pass a group-named `tmuxSession` through to
  `goPtyFleetProjection.create()`, or does it create one terminal at a time with no session name
  (fragmenting the group)? — proceeding on the assumption that it does NOT today (the team path sets
  `teamSession` at `bootstrap.ts:4051-4053`; the group path appears to call `ptyFleetService.create()`
  per-terminal without an equivalent). If confirmed, Proposed Change #4 needs a small wiring fix to
  pass a group-named session, not just a deletion.

---

## Completion Summary (2026-09-09)

Executed under Option 1 (keep external-pane adoption in TypeScript). Deleted the duplicate seating module `tmuxTeamSeating.ts` (605 lines) and removed its `backend === 'tmux'` branch in both `bootstrap.ts` and `TaskViewerProvider.ts`, so all team/group creation now flows through the single fleet path (`goPtyFleetProjection.create()`, which wraps the startup command in `tmux attach` when `terminal.tmux.enabled` is on). Collapsed the scoped `terminalBackend` setting: added a one-time, idempotent migration in `bootstrap.ts` that promotes a stored `terminalBackend: 'tmux'` to `terminal.tmux.enabled = true` (unless that switch is explicitly false) and drops the scoped key; removed the `terminalBackend` option from the dead `createHeadlessHostSeams` seam. Relocated `startTmuxReconcilePoll` into `tmuxFleetService.ts` so the adoption fleet keeps its liveness poll, and removed the now-dead `resolveTmuxSeatFromRegistry`/`deliverToTmuxSeat`/`sendControlToTmuxSeat` delivery arms (team-seated panes are now Go PTYs resolved by the fleet path). The `tmuxOwner` discriminator and registry-merge discipline are preserved so stale pre-upgrade seat rows are reaped, not clobbered. The panel-group `tmuxSession` gap (Outstanding Question #2) was confirmed: `SAVE AS GROUP` is a post-hoc grouping of already-created terminals, so no group name exists at create time — the deletion achieves one create path, but a group-named shared tmux session remains a separate follow-up feature, not part of this consolidation. Updated the `tmux-backend-contract` test to drop source-reading assertions on the deleted module while keeping the behavioral `tmuxOwner` regression guard. Verification (compilation/tests) skipped per run directives.
