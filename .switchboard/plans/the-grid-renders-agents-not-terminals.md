# The grid's unit should be an agent, not a terminal — nine terminals is worse than one terminal nine times

## Goal

Give a pane the option to render its seat as **state** rather than as terminal output, so a grid shows
one live terminal for the seat you are talking to and status for the seats you are only watching.

### Problem Analysis

**The terminal grid competes on ground it cannot win, and handicaps itself doing so.** Nine panes of a
3x3 give each seat ~40 columns of a TUI drawn for 80+. It reflows badly, it is hard to read, and it is
still judged against dedicated terminals that will always win on rendering, fonts, selection and
search. The feature gets *worse* as you add panes, which is backwards for something whose entire
pitch is "many at once".

**What no multiplexer can do is the thing Switchboard already knows.** tmux can tile nine panes; it
cannot say *"coder-2 is blocked on a decision, coder-1 finished four minutes ago, the lead is waiting
on you."* That needs a model of what an agent **is** — role, assigned plan, dispatch state, liveness,
completion — and Switchboard is the only thing holding one.

**The model exists; it has no renderer.** The pieces are already computed and scattered across
presentation code:

- `postFleetStateToShell` derives a `light` and `doneStamp` per terminal for the rail
- `renderWorkingSilence` already has the copy — *"<agent> is working — no output yet"* — and the
  `lastPrintableAt` / `lastFrameAt` / `firstFrameAt` stamps behind it
- `resolveInputState` resolves live / connecting / read-only / paste-queued
- `terminalBadges` carries DONE; the plan strip carries the assigned plan

**And the pane already has a mode axis.** `paneModes[i]` is per-slot, persisted, padded to
`getMaxSlotCount()` and never trimmed — with two values today, `'terminal'` and `'kanban'`. A third
value is an extension of a shipped abstraction, not a new concept.

**The team model already assumes this shape.** A team commits once as its head; members do not commit;
standing orders are head↔member only; one subtask goes to one clean seat, so members are numerous and
individually uninteresting minute to minute. The lead genuinely is the interlocutor and the members
genuinely are monitored. The grid is the only part of the product that does not say so.

### Root Cause

The grid's unit became the terminal because a terminal was the only renderer available when it was
built. Density then made the fleet model *less* visible rather than more, because every additional
pane bought another cramped viewport instead of another readable fact.

### Non-goals

- **Not a three-way mode picker.** `status` is not a peer of `kanban`. It is a **terminal pane with
  its output off**, and it must be presented as a toggle on a terminal pane. Peer modes in a picker
  matrix is the recurring UI failure in this codebase; do not reskin it, do not build it.
- **Do not enforce one live pane per grid.** Per-pane choice, with a solo gesture. Two leads in a 2x2
  is a real thing to want.
- **Do not infer state.** A pane must render what an agent *declared*, not what the host guessed —
  see the dependency on the report inbox, and Change 4.
- Not a replacement for the terminal. Typing needs a real terminal, full size, and that stays.
- Not remote-fleet rendering. Change 5 leaves the seam for it; it does not build it.

## Metadata

**Topic:** A pane can render its seat as state instead of as terminal output
**Complexity:** 6
**Tags:** terminals, webview, ux, feature, standalone, teams

## User Review Required

None. Presentation (toggle, not picker), the no-enforcement decision, and the declared-over-inferred
rule are all settled above.

## Dependencies

- **`suspend-terminal-streams-for-panes-nobody-renders.md`** — hard prerequisite. A status pane is a
  pane whose terminal is suspended; that plan owns the suspend/resume mechanism and the replay-gap
  reporting this one consumes.
- **`agent-reports-go-to-a-file-inbox.md`** — hard prerequisite for Change 4. The inbox's vocabulary
  (`finished | blocked | question | status`) is what fills a pane. Without it the panes can only show
  inferred state, which is the one thing this plan must not ship.

## Both Hosts

`terminals.js` is served by both hosts — standalone via `bootstrap.ts`, and the extension via
`TaskViewerProvider.ts`'s `serveStatic` (`getShellHtml` / `getPanelsManifest` / `getPanelHtml`, with
`terminals: ptyHostReady()`). So the client change reaches both.

The extension reaches its fleet through the pty-host sidecar (`ptyHost.ts:46`) and the standalone host
in-process (`bootstrap.ts:3202`). Change 3 relies only on the suspend mechanism, which is inside the
shared gateway and client, so no seam is added at either root. Verify the pane's state content against
both — the extension's fleet rows and the standalone's come from different `PtyFleetService` instances
and the fields present are not guaranteed identical.

## Proposed Changes

**1. A third `paneModes` value, and the audit that makes it safe.**

Add `'status'`. The work is not the value, it is that **~15 call sites currently binary-test the mode**
and every one of them silently means "terminal" for any non-`kanban` value:

`terminals.js` — `:3987` (`isFreeSlot`), `:5578` (`isFree`), `:5589`, `:5591`, `:6179`, `:6211`,
`:6456`, `:6560`, `:6567`, `:6619`, `:6630`, `:6631`, `:6843` (pop-out gating), `:7650`, `:7651`, plus
the `paneModes[0] = 'kanban'` at `:854` and the pad loop at `:5931`.

Each must be classified deliberately: does this site mean "not kanban", "is terminal", or "has a
seat"? A third value inheriting the wrong branch compiles clean and is exactly the class of defect
this codebase's own rules warn about. This audit **is** the plan's risk.

**2. Presentation: an output toggle, plus solo.**

On a pane with a seat, a control that turns output off (status) and on (terminal). Plus one gesture —
"make this the live pane" — that flips the other seated panes to status. No picker, no third peer
entry in any mode menu.

**3. A status pane holds no terminal socket.**

Entering status suspends the pane's terminal through the mechanism in the prerequisite plan; leaving
it resumes from `?lastSeq=` and reports a replay gap if one occurred. The performance win is a
consequence of the design, not its justification — do not implement it as a cache.

**4. Content: declared first, inferred clearly labelled.**

Render, in priority order:

- the seat's identity — role, name, brand, and the assigned plan from the plan strip
- **the latest declared report** from the inbox: `finished | blocked | question | status`, with its
  timestamp and its text
- then, and only visibly *subordinate* to the above, host-derived signals: DONE badge, time since last
  printable output, input state

The ordering is the point. `blocked` because an agent said so is a fact; "no output for 90 seconds" is
a guess, and this codebase has shipped false `blocked` notices before. A pane that presents a guess as
a fact is worse than a terminal showing raw bytes, because raw bytes are at least honest about being
raw.

**5. The pane's data comes from a resolver, not from a hardcoded local read.**

Route the pane's state through one function that answers "state for seat X", rather than reading
`fleetList` and the inbox inline. This plan implements only the local answer. It exists so a later
plan can answer for a *remote* fleet without re-opening every render site — the seam, not the feature.

**6. Honest failure, mandatory.**

A status pane whose state cannot be resolved must render **unreachable**, never idle, never empty.
`board-read-endpoints-must-survive-the-storage-topology.md` names this exact hazard — *"an unreachable
store and an empty result are indistinguishable to a caller … a clean `200 []` looks like success"*.
On a pane whose whole job is telling you what your fleet is doing, a quiet wrong answer is the
anti-feature.

## Verification Plan

1. A 3x3 with one terminal pane and eight status panes: the eight sockets are closed
   (`__sbTerminalStats()`), and the live pane is unaffected.
2. Toggle a status pane back to terminal. Output resumes from replay with scrollback intact; a long
   suspension reports a gap rather than a silent hole.
3. Solo gesture: with three seated panes, invoking it on one flips the other two to status and leaves
   unseated panes alone.
4. Two live terminal panes at once is possible — the design does not enforce a single live pane.
5. `paneModes` round trip: set a status pane in slot 5, switch layout to `1`, switch back to 3x3. The
   mode survives, as `kanban` does today.
6. A kanban pane is unaffected by the audit — every `=== 'kanban'` site behaves exactly as before.
7. Pop-out: the pop-out button's gating (`:6843`) does the right thing for a status pane — decide and
   assert which, rather than inheriting the terminal branch by accident.
8. An agent writes a `blocked` report to the inbox; the pane shows it, attributed and timestamped,
   above any host-derived signal.
9. With the inbox empty, a pane shows host-derived signals only and does not present them as
   declarations.
10. Kill the state source for one seat; its pane reads **unreachable**, not idle.
11. Density: 16 seats in status mode remain individually readable. If they do not, the pane's content
    is too heavy — fix the pane, not the ceiling.
12. **Both hosts:** run 1, 2, 5 and 8 against standalone and against the VS Code extension with its
    pty-host sidecar.

### Goal Invariants

- Assert `paneModes` accepts `'status'` and that every site listed in Change 1 was classified — no
  site left testing `!== 'kanban'` where it means "is terminal".
- Assert a status pane has no open terminal WebSocket.
- Assert `entry.term` is not disposed when a pane enters status mode.
- Assert the status control is a per-pane toggle and that no mode *picker* offering three peers exists.
- Assert nothing enforces a maximum of one terminal-mode pane.
- Assert a declared report renders above host-derived signals when both are present.
- Assert an unresolvable state renders as unreachable and is visually distinct from idle.
- Assert the pane's state is read through a single resolver function, not inline per render site.
