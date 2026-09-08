# tmux Belongs in the Go Host, Not a Second Fleet in TypeScript

## Goal

Move tmux ownership into the Go PTY host so Switchboard has **one fleet**. A tmux pane becomes another
kind of process the host manages, reached through the same verbs as a PTY seat — not a parallel fleet
service in TypeScript that every consumer has to be taught about separately.

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
| `tmuxTeamSeating` | session creation, seating, reconcile | — | 550 |

Roughly 1,500 lines of TypeScript implementing a fleet the Go host could own.

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

## Metadata

**Complexity:** 8
**Tags:** go, tmux, fleet, architecture, standalone
**Dependencies:** the Go/webview wire-contract test (`Nothing Asserts That the Go PTY Host and the Webview Agree on a Wire Format`) should land first — it is the gate that makes this boundary checkable.

## User Review Required

None.

## Proposed Changes

### 1. A tmux backend inside the Go host (`cmd/switchboard-pty-host/`)

- **Logic:** Port the fourteen argv operations to `exec.Command`, keeping the argv-array discipline —
  no shell, ever. `tmuxBackend.ts`'s security note ("every tmux invocation uses `execFile` with an argv
  array") is the invariant to carry over, not to re-derive.
- **Edge cases:** tmux absent, or absent on native Windows (`wslDetect.ts` covers this today and its
  rule must move with the code). A pane that vanishes between list and use.

### 2. A tmux seat is a terminal, answered by the existing verbs

- **Logic:** The host already answers `ptyCreateTerminal`, `ptyListTerminals`, `ptyWrite`,
  `ptySendPrompt`, `ptyCloseTerminal`, `ptyRenameTerminal` and the rest. A tmux-backed seat should be
  reachable through the same verbs, with the backend an attribute of the seat rather than a different
  API. That is what collapses the two fleets into one.
- **Edge cases:** `ptyListTerminals` must report backend per seat so the panel can show it; nothing
  else should need to care.

### 3. Delete the second fleet (`src/standalone/tmuxFleetService.ts`, `tmuxBackend.ts`, `tmuxTeamSeating.ts`)

- **Logic:** With ownership in Go, `GoPtyFleetProjection` is the only fleet and these three modules go.
  Their behaviour that must survive: session naming (`deriveTmuxSessionName`), the reattach branch that
  reuses existing panes and names on restart, bare-shell adoption refusal, and newline flattening on
  send.
- **Rationale:** Leaving them as a fallback recreates the two-fleet split this plan exists to end.

### 4. Collapse the two settings into one

- **Logic:** `switchboard.terminal.tmux.enabled` becomes the single switch, already surfaced as the
  **Enable tmux** checkbox in the Terminals panel. The scoped `terminalBackend` setting goes.
- **Edge cases:** An install with `terminalBackend: 'tmux'` stored should keep tmux on rather than
  silently reverting.

### 5. One create path, so groups work without a design

- **Logic:** With the backend chosen inside the host at create time, a Terminals-panel group gets a
  session named for the group and its terminals as named panes, on the same code that serves a team.
  The companion plan's requirements 2 and 3 are satisfied by construction.

### 6. Extend the wire-contract test to the tmux frames

- **Logic:** Whatever new frames or fields this adds are covered by the same test that starts the real
  binary and drives real frames. A comment describing the contract is what failed last time.

## Verification Plan

### Automated Tests
- The contract test starts the real host and exercises a tmux-backed seat end to end: create, list,
  write, prompt, rename, close.
- With the setting on and tmux present: a team **and** a panel group each get a session named for them,
  with panes named for their terminals.
- With tmux absent: creates fall back to PTY seats, with a log line saying why; no failed create.
- Restart with both a team and a group running: sessions and pane names are reused, nothing recreated.
- A tmux-backed seat and a PTY seat resolve identically for dispatch, delivery, liveness and pane
  assignment.

### Goal Invariants
- Exactly one fleet service exists in TypeScript.
- Backend is a property of a seat, never of the call path that made it.
- One setting decides tmux; the checkbox drives it.
- No `child_process` reference to `tmux` remains in `src/`.

### Manual
- Open four terminals, SAVE AS GROUP, confirm `tmux ls` shows a session named for the group; attach
  from an SSH client and confirm it is the terminal the board is driving.
- Start a team; confirm the same, and that a board restart reattaches both with names intact.

## Outstanding Questions

- None.
