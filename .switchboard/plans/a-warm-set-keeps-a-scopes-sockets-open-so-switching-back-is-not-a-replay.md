# A Warm Set Keeps a Scope's Sockets Open, So Switching Back Is Not a Replay

## Goal

Make returning to a scope you were just looking at cost nothing. Today every
switch between teams — and between a team and unassigned — closes every
WebSocket on the way out and reopens every WebSocket on the way in, each
reconnect replaying up to 256 KB of ring buffer through xterm. Keep the sockets
of the most recently used scopes open, bounded by an explicit cap, so the common
gesture (A → B → A) does no network work at all.

### The problem, and the root cause

`enterTeamScope` (`src/webview/terminals.js:11711`) awaits `loadLayoutSettings()`
— which is **not** a local read; `loadSetting` (`terminals.js:2140`) issues
`fetch('/kanban/verb/getSetting')` per key — then calls `switchToGroup`, then
`renderPaneGrid`. The reconcile's trailing loop (`terminals.js:6643`) then calls
`suspendTerminalStream` on everything leaving and `resumeTerminalStream` on
everything arriving.

Suspend is not cheap. `suspendTerminalStream` (`terminalViewport.js:1835`)
**closes the WebSocket** and releases the renderer; resume reconnects with
`?lastSeq=<entry.lastSeq>` and the gateway **replays up to 256 KB** of ring
buffer, a size stated at `terminals.js:3013`. Three seats per team means six
teardowns, six reconnects, six replays and six renderer re-acquisitions per
switch, all on the main thread. On a Pi that is seconds, and it is paid again on
the way back.

**The root cause is that one predicate answers two different questions.**
`isTerminalRendered` (`terminals.js:398`) bottoms out in `viewport.isRendered` —
`getBoundingClientRect().width > 0 && height > 0` — and it is the sole input to
the suspend decision. "Is this terminal on screen" and "should this terminal keep
its connection" are currently the same question, so leaving a scope always means
disconnecting it.

That collision is deliberate. It is what *Suspend terminal streams for panes
nobody renders* installed to protect the board's memory budget on a 1 GB Pi, and
it is not to be removed — only bounded.

### The approach that does not work, recorded so it is not retried

The shell mounts every panel as a same-origin iframe toggled by `.is-active`
(`shell.js:186`), so "give each team its own iframe" looks free. It is not: a
document inside a hidden iframe measures 0x0 — `shell.js:189` says so outright —
so `isRendered` returns false for every seat in a hidden team and the replay
happens anyway. Per-iframe isolation relocates the teardown rather than removing
it. The retention policy below is the fix, and with it one document is enough.

## Metadata

- **Complexity:** 7
- **Tags:** frontend, performance, ux
- **Project:** Browser Switchboard

## Scope: standalone only

`src/webview/terminals.js` and `src/webview/terminalViewport.js` — the browser
cockpit, served by the standalone host. Per CLAUDE.md the VS Code extension host
is out of scope; "the extension does not have it" is the intended state, not a
divergence.

## Proposed changes

### 1. An explicit retention ledger, separate from visibility

`warmScopes` — an ordered list of scope ids (`null` for unassigned, or a team's
`groupId`), most-recently-viewed first, capped at the configured size.

### 2. Split the suspend predicate

The reconcile's decision changes from `isTerminalRendered(name)` to
`isTerminalRendered(name) || isInWarmScope(name)`.

A terminal in a warm scope keeps its socket and its `entry.lastSeq`. It does
**not** keep the renderer: `armRendererRelease`'s 5 s timer still runs, because
a WebGL context held by an invisible surface is the thing the 1 GB work was
actually protecting, and reacquiring one repaints from xterm's own buffer with
no network round trip. The socket is the expensive half, and warmth buys only
that.

### 3. Correct the single-owner comment

`terminals.js:390-397` documents `isTerminalRendered` as the SINGLE owner of
`entry.suspended`: *"There is no second reason a terminal can be suspended, so
nothing has to record why it was set."* Warmth introduces exactly that second
reason. The comment must be corrected and the reason recorded on the entry, or
the next reader trusts a guarantee that no longer holds.

### 4. Warm layout state, so the warm path does not round-trip

Layout settings for a warm scope are held in memory and not re-fetched on
re-entry, removing the blocking `await loadLayoutSettings()` from the warm path.
The cold path keeps it unchanged.

### 5. Eviction

Evicting a scope past the cap suspends its terminals through
`suspendTerminalStream` — the same path as today, never a bespoke close. A scope
whose group is no longer registered is dropped from the ledger, or it holds a
slot forever.

## Complexity Audit

### Routine
- The ledger itself: an ordered array, a cap, a membership test.
- Threading `isInWarmScope` into the reconcile's trailing loop.

### Complex / Risky
- **The re-box case.** `suspendTerminalStream` already delays renderer release
  when a terminal is seated but transiently 0x0 during a grid reflow — that is
  the `RENDERER_RELEASE_DELAY_MS` short-circuit its comment describes at length.
  A warm-but-unseated terminal and a seated-but-unmeasured one are different
  states and must not share a flag.
- **Two layout states live at once.** `saveLayoutSettings()` computes its key
  from `teamScopeId` at call time. A save that fires after the scope changed
  writes under the wrong prefix — the clobber `enterTeamScope` already guards
  against on entry, now possible on a longer timeline because a warm scope's
  state outlives its visit.
- **Eviction mid-reconnect.** Evicting a scope whose terminals are mid-reconnect
  must not leave a half-open socket.
- **Interaction with the shipped fleet-fetch re-seat.** `fetchTerminalList`
  re-seats the locked group on every fleet fetch, gated on `lastSeatedLiveCount`
  changing (`terminals.js:2558`, shipped in `47c1deca`). It keys on
  `activeGroupId` — the *visible* scope. A warm-but-unviewed scope must not be
  re-seated by it, and `lastSeatedLiveCount` is a single scalar: with more than
  one scope warm it can only ever track the visible one, so it must not be
  repurposed as a per-scope tracker.

## Edge-Case & Dependency Audit

**Race conditions**
- Rapid clicks across three scopes: the ledger must be mutated only by the
  entry that wins the `teamScopeId` re-check, not by every call that started.

**Side effects**
- A team stopped while warm: its seats exit and `armDetachTimer`'s `isExited`
  branch destroys the views after the 5 min grace. The ledger must drop the
  scope, not hold a slot for a team that no longer exists.
- Memory. A warm set of 2 roughly doubles held sockets versus today's single
  live scope. It does **not** multiply by team count — that bound is the
  property that keeps it inside the board-only budget.

**Security**
- None. No new endpoint, no new message, no change to what is sent.

**Dependencies & conflicts**
- **Depends on nothing in this feature**, but is best landed after the
  unassigned-entry subtask so that "unassigned" is already a scope the ledger
  can name.
- **Warm-set configuration subtask** supplies the cap. This subtask can land
  first with the cap hard-coded to 2.
- No pending plan competes for `terminals.js` here — the stale-fleet work has
  already shipped (`47c1deca`).

## Adversarial Synthesis

The weakest claim here is that the socket is most of the cost. If the dominant
cost turns out to be xterm reflow on re-seat rather than replay, warmth buys less
than advertised. **Measure before building:** instrument one switch and record
time in replay versus time in `renderPaneGrid`. If replay is not dominant,
re-aim this subtask rather than shipping it on faith — the unassigned-entry
subtask stands on its own regardless, because it is correctness, not speed.

Second risk: warmth makes staleness harder to see, because a scope now persists
instead of being rebuilt from truth on every entry. The prior art is unkind here
— *Switching Between Group And Team Views Intermittently Corrupts Pane Glyphs*
was a COMPLETED fix for exactly that shape. Mitigation: warm state holds sockets
and layout only. The roster, group membership and fleet list continue to come
from the live fetch on every entry, warm or cold.

## Verification

- Team A → B → A with warm set 2: the second entry to A opens **no new
  WebSocket** (assert on connection count, not on wall clock) and shows no
  replay-gap toast.
- Team A → B → C → A with warm set 2: A was evicted, reconnects, and its
  scrollback is intact.
- A warm scope's renderer is released after 5 s and reacquired on return with no
  network round trip.
- Stop a team while it is warm: the ledger drops it and no slot is held.
- A grid reflow that transiently measures 0x0 does not evict or suspend a seated
  terminal.
- `npm run compile-tests` before any `test:contract:*` script.

## No migration

The ledger is in-memory and has never shipped. No persisted key changes shape.
