# Switching Between Teams And Unassigned Is a Selection, Not a Rebuild

**Complexity:** 7

## Goal

Moving between teams, and between a team and the unassigned fleet, should be a selection made from the shell rail — not a reconstruction of the panel. Today unassigned cannot be reached from the rail at all, the one gesture that reaches it seats the wrong terminals into the wrong number of panes, and every switch closes and reopens every WebSocket, replaying up to 256 KB per seat through xterm. This feature makes entry correct first, then makes the common gesture free by keeping a bounded set of recently-used scopes connected, with the bound under the operator's control.

## How the Subtasks Achieve This

- **Unassigned Is Reachable From The Rail, And Entering It Seats Only Unassigned
  Terminals**: adds the missing rail button and collapses two seating
  implementations into one, so entering unassigned — from the rail or from a
  team's back button — produces exactly the unassigned terminals at exactly the
  right size. This is the correctness half, and it fixes the blank panes and the
  team bleed on its own.
- **A Warm Set Keeps a Scope's Sockets Open, So Switching Back Is Not a Replay**:
  splits the suspend decision, which today asks one question ("is this on
  screen?") to answer two, so a recently-left scope keeps its WebSockets while
  still giving back its renderer. This is what makes the common A -> B -> A
  gesture cost nothing.
- **The Warm-Set Size Is Operator Configuration, and Its Read Says Where It Came
  From**: puts the bound in the Config tab at a default of 2, and reads it
  through a tagged reader so a failed settings fetch can never be mistaken for a
  deliberate choice.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Unassigned Is Reachable From The Rail, And Entering It Seats Only Unassigned Terminals](../plans/team-switching-is-a-rebuild-and-unassigned-is-unreachable.md) — **CREATED** — ID: 0e13233b-6069-4a48-919c-b7fcaa6d88d5
- [ ] [A Warm Set Keeps a Scope's Sockets Open, So Switching Back Is Not a Replay](../plans/a-warm-set-keeps-a-scopes-sockets-open-so-switching-back-is-not-a-replay.md) — **CREATED** — ID: 22833067-d3a5-4d57-8630-b07bbd250737
- [ ] [The Warm-Set Size Is Operator Configuration, and Its Read Says Where It Came From](../plans/the-warm-set-size-is-operator-configuration-and-its-read-says-where-it-came-from.md) — **CREATED** — ID: d30e7543-dc9c-4cf2-b5d6-0d2715283bb2
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Ordered, and the first subtask is independently valuable.**

1. **Unassigned entry lands first.** It is correctness, not performance, and it
   is what gives the warm ledger a second scope worth naming. It does not depend
   on either other subtask.
2. **Warm set second.** It can land with the cap hard-coded to 2 and be useful
   immediately.
3. **Configuration last.** It replaces that constant with a tagged read.

**Measure before building subtask 2.** Its central claim is that the closed
socket and its replay are most of the switch cost. Instrument one switch and
compare time in replay against time in `renderPaneGrid` first. If replay is not
dominant, re-aim that subtask — subtask 1 stands regardless.

**The unassigned model is decided, and it is the shipped one.** Unassigned stays
`activeGroupId === null` plus the computed complement from
`getUnassignedTerminalNames()`. The `__unassigned__` pseudo-group proposed by
*Clicking an ungrouped terminal silently conscripts it into the locked group* is
**not** to be introduced: teaching `findGroupForTerminalName()` to return it
inverts that function's filter to always-false and
`getUnassignedTerminalNames()` returns an empty list. That plan has been trimmed
to the click-router scope it uniquely owns.

**Two rail plans are already implemented despite their cards.** *Shell Rail
Restructure* and *Three Fixed Team Slots In The Rail* sit in PLAN REVIEWED but
are in `shell.js` today. Build against the shipped `renderTerminalSection`, not
against either plan's "before" description. There is nothing to wait for.

**Check the code, not the column, before sequencing.** Three plans that look
like prerequisites are already implemented despite their cards: *Shell Rail
Restructure* and *Three Fixed Team Slots In The Rail* (PLAN REVIEWED, in
`shell.js`), and *Team grid shows too few terminals on first click* (LEAD CODED,
shipped in commit `47c1deca`). None of them is pending work to wait for. Their
shipped behaviour is context these subtasks must preserve — in particular the
`lastSeatedLiveCount`-gated re-seat at `terminals.js:2558`.

**File contention:** all three subtasks touch `src/webview/terminals.js` and must
be sequenced against each other.

