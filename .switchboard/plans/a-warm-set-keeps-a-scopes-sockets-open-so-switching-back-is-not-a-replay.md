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

## User Review Required

None blocking. One gate is a *measurement*, not a decision: the Adversarial
Synthesis requires instrumenting one switch (replay time vs `renderPaneGrid`
time) before building — if replay is not dominant this subtask is re-aimed, not
shipped on faith. The cap's interim value (constant `2`) and its seam
(`getWarmScopeCap()`) are settled by the configuration subtask, which replaces
the constant.

## Scope: standalone only

`src/webview/terminals.js` and `src/webview/terminalViewport.js` — the browser
cockpit, served by the standalone host. Per CLAUDE.md the VS Code extension host
is out of scope; "the extension does not have it" is the intended state, not a
divergence.

## Proposed changes

### 1. An explicit retention ledger, separate from visibility

`warmScopes` — an ordered list of scope ids (`null` for unassigned, or a team's
`groupId`), most-recently-viewed first, capped at the configured size.

The cap is read through **one named seam**, `getWarmScopeCap()` — a constant
`2` until the configuration subtask replaces its body with the tagged read.
Eviction and the ledger push both consult it; nothing else may hard-code the
number, or the later swap has to go hunting.

The ledger mutates only at scope-entry, and only in the call that *wins*:
`enterTeamScope` pushes after its post-await `teamScopeId === groupId` re-check
(`terminals.js:11745`), and the unassigned entry pushes `null` after its
equivalent `teamScopeId === null` re-check — `enterUnassignedScope` once the
unassigned-entry subtask has landed (`exitTeamScope` until then). A losing call
that wakes late must not touch the ledger.

### 2. Split the suspend predicate

The reconcile's trailing loop (`terminals.js:6649-6668`) gains a third arm:

```js
if (isTerminalRendered(name)) {
    viewport.resumeTerminalStream(entry);   // no-op for a warm entry — it was never suspended
    viewport.ensureSizeVote(entry);          // no-op unless the vote was withdrawn below
} else if (isInWarmScope(name)) {
    viewport.releaseSizeVote(entry);
    viewport.armRendererRelease(entry);
} else {
    viewport.suspendTerminalStream(entry);
}
```

`isInWarmScope(name)` resolves the terminal's scope **live at reconcile time** —
`const g = findGroupForTerminalName(name); const scope = (g &&
isSpawnedTeamGroup(g)) ? g.id : null;` — then tests ledger membership. No cached
per-terminal scope: a terminal grouped into a team while its old scope is warm
must follow the team, and one ungrouped must follow `null`. Membership
resolution is the same question `getUnassignedTerminalNames` already asks, per
terminal.

A terminal in a warm scope keeps its socket and its `entry.lastSeq`. It does
**not** keep two other things suspend would have taken, and giving them back is
explicit, not incidental:

- **The size vote.** `suspendTerminalStream` calls `releaseSizeVote` before
  closing the socket because `client.reportedSize` is sticky server-side
  (`terminalViewport.js:416-420`): a client that goes hidden stops sending and
  its final size keeps clamping the shared pty **until the socket closes**.
  Warmth is exactly that case — the socket stays open, so without an explicit
  `releaseSizeVote(entry)` a warm terminal's stale vote clamps the pty for every
  other viewer of it (a pop-out, the dock) for as long as the scope stays warm.
  The vote is withdrawn on the way out and re-cast on re-entry by
  `ensureSizeVote` (`terminalViewport.js:445`) — whose docblock exists for
  precisely this ("re-cast a withdrawn vote"). The `ensureSizeVote` call in the
  rendered arm above is what covers re-entry: `resumeTerminalStream`
  early-returns on `!entry.suspended` and never reaches its own re-vote.
- **The renderer.** It must go back — a WebGL context held by an invisible
  surface is the thing the 1 GB work was actually protecting — but not through
  the suspend path, which never runs for a warm entry.

> **Superseded:** "`armRendererRelease`'s 5 s timer still runs" as the release
> mechanism for warm terminals.
> **Reason:** That timer is armed *inside* `suspendTerminalStream`, which the
> warm arm deliberately bypasses — so under the original wording nothing would
> ever arm it. The release actually comes from two existing paths that do not
> go through suspend: each container's debounced ResizeObserver
> (`terminals.js:1493`) funnels into `reconcileRendererForVisibility`
> (`terminalViewport.js:681`), which swaps WebGL→canvas the moment the box is
> gone; and the `panelVisibility` hide path (`terminals.js:1461-1465`) arms the
> 5 s timer on every entry when the whole panel is hidden. Arming
> `armRendererRelease` in the warm arm above is belt-and-braces on top — it is
> idempotent and re-reads `isRendered` before acting.
> **Replaced with:** The warm arm calls `releaseSizeVote` + `armRendererRelease`
> explicitly; the RO/`reconcileRendererForVisibility` path then does the actual
> context release on box loss, and reacquisition on return repaints from
> xterm's own buffer with no network round trip.

The socket is the expensive half, and warmth buys only that.

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

This applies to **both** entry points — `enterTeamScope` and, once the
unassigned-entry subtask has landed, `enterUnassignedScope` (which holds the
same `await loadLayoutSettings()` at its step 3). A warm `null` scope re-entered
through the rail button or "← All" must not round-trip either.

### 5. Eviction

When a push takes the ledger past `getWarmScopeCap()`, the tail scope is
evicted and its terminals go through `suspendTerminalStream` — the same path as
today, never a bespoke close. Membership is resolved live, the same way
`isInWarmScope` resolves it: iterate `terminalsMap`, compute each entry's scope,
suspend those matching the evicted id. No stored member list — one that was
snapshotted at entry goes stale the moment a terminal is grouped or exits.

A scope whose group is no longer registered is dropped from the ledger, or it
holds a slot forever.

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
  can name — and so the ledger push for `null` hooks `enterUnassignedScope`,
  the single entry path that subtask creates, rather than today's
  `exitTeamScope`.
- **Warm-set configuration subtask** supplies the cap. This subtask lands first
  with the cap behind `getWarmScopeCap()` returning `2`; that subtask replaces
  the seam's body with the tagged read and wires cap-changed eviction. Nothing
  else may read or hard-code the number.
- No pending plan competes for `terminals.js` here — the stale-fleet work has
  already shipped (`47c1deca`).

## Dependencies

- `team-switching-is-a-rebuild-and-unassigned-is-unreachable.md` — lands first.
  Creates `enterUnassignedScope`, the single unassigned-entry path this
  subtask's ledger push for `null` hooks, and the warm-layout skip at §4
  targets.
- `the-warm-set-size-is-operator-configuration-and-its-read-says-where-it-came-from.md`
  — lands after. Replaces `getWarmScopeCap()`'s constant with the tagged read;
  this subtask must leave exactly one seam for it to replace.
- `47c1deca` (shipped) — the `lastSeatedLiveCount`-gated re-seat at
  `terminals.js:2579` is existing behaviour to preserve, not pending work.

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

## Verification Plan

### Automated Tests

- Team A → B → A with warm set 2: the second entry to A opens **no new
  WebSocket** (assert on connection count, not on wall clock) and shows no
  replay-gap toast.
- Team A → B → C → A with warm set 2: A was evicted, reconnects, and its
  scrollback is intact.
- A warm scope's renderer is released once its containers lose their box and
  reacquired on return with no network round trip.
- A warm terminal's size vote is withdrawn on scope exit
  (`entry.sizeVoteActive === false` while `entry.ws` stays open) and re-cast on
  re-entry — a second viewer of the same pty is not clamped by the warm scope's
  last viewport.
- Stop a team while it is warm: the ledger drops it and no slot is held.
- A grid reflow that transiently measures 0x0 does not evict or suspend a seated
  terminal.
- Two rapid scope entries land on the second scope and the ledger names only
  the winner.
- `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. `warmScopes` exists in `src/webview/terminals.js` as an MRU-ordered list of
   scope ids (`null` or team `groupId`), and every bound check reads
   `getWarmScopeCap()` — no other site hard-codes the number.
2. The reconcile's trailing loop keeps `isTerminalRendered(name)` as the resume
   predicate and adds `isInWarmScope(name)` as a distinct warm arm —
   `isTerminalRendered` itself is unchanged. *(Negative — visibility is not
   redefined.)*
3. A terminal whose scope is warm retains `entry.ws` open across the switch and
   shows `entry.sizeVoteActive === false` while warm. *(Paired — socket kept,
   vote released.)*
4. Eviction of a scope routes its terminals through `suspendTerminalStream`;
   no warm-path code closes a socket directly. *(Negative — no bespoke close.)*
5. The "SINGLE owner of `entry.suspended`" docblock at `terminals.js:390-397`
   no longer claims there is no second reason — the reason is recorded on the
   entry or the comment is corrected.

## No migration

The ledger is in-memory and has never shipped. No persisted key changes shape.
