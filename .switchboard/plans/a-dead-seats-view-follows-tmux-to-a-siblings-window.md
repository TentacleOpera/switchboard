# A Dead Seat's View Follows tmux to a Sibling's Window

## Goal

When a seat's agent dies, its pane says so. It never renders a sibling, and a prompt addressed to
it never reaches one.

### What was observed, 2026-09-14

The operator watched, in this order:

1. the lead stopped showing in its pane;
2. `Coding-coder-2` appeared **in the lead's panel** — two panes rendering the same agent.

### The mechanism

Seats in a team share one tmux window list through a session group, and every session in that
group keeps its **own current window**. That is the property the grouping exists for: each seat's
view is pinned to its own window by `select-window` at seating time.

It is also the property that breaks here. **When a window is destroyed, tmux moves any session
whose current window it was to a surviving neighbour.** So the moment the lead's window went away,
`lc-coding-team-lead` did not go blank — it followed the shared list to the next window, which was
`Coding-coder-2`. The lead's browser pane attaches to that view, so it began rendering coder-2.

Nothing re-pins it, because the thing that would is disabled by the same event.

### Why the routing repair does not catch it

`ensureTmuxRouting` (`cmd/switchboard-pty-host/main.go`) exists to correct exactly this class —
a view pointed at the wrong window — and it opens:

```go
own = tmuxOwnWindowID(t)
if own == "" {
    return "", true          // "cannot verify" → allow
}
```

`tmuxOwnWindowID` resolves the seat's own window by id or by `session:window` name. When that
window has been destroyed it resolves to nothing, so the function returns *cannot verify* and
permits whatever the view is currently showing.

A seat whose window is **gone** and a seat whose window **cannot be looked up** produce the same
empty string and take the same permissive branch. That is the rule `CLAUDE.md` names as the
largest source of bugs in this codebase: a fallback that behaves exactly like a real value. Here
it converts "this agent is dead" into "carry on, showing someone else's".

### The serious half is delivery, not display

`deliverPrompt` calls the same function and proceeds when it returns `ok`. A seat whose window has
died therefore passes the routing check, and the delivery writes into the seat's pty — which is a
`tmux attach` client pointed at **the sibling's window**. So a fix round, a dispatch or a report
addressed to the lead is typed into coder-2's agent, and the receipt reports success.

That is the same failure shape already recorded in
`a-finished-seat-is-told-its-own-card-blocks-it-and-re-derives-the-call`: a send whose receipt is
built from `bytesWritten`, with nothing confirming the intended recipient consumed it.

### Non-goals

- **Keeping a dead seat's window alive.** A window whose process exited should go; this plan is
  about what the view does afterwards.
- **Reviving the agent.** Out of scope — the seat is closed or respawned by the existing paths.
- **Changing the session-group model.** Grouping is what lets an operator attach to a whole team
  over SSH, and it is not the defect. The defect is treating an unresolvable window as permission.

## Metadata

- **Complexity:** 3
- **Tags:** pty-host, tmux, routing, bugfix

## User Review Required

None.

## Proposed Changes

### 1. Distinguish "window gone" from "cannot verify"

`tmuxOwnWindowID` returns one empty string for two different facts. Split them: a seat whose
session and window are known, where the window is absent from `list-windows`, is **dead** — not
unverifiable. Only a failure to reach tmux at all is unverifiable.

### 2. A dead seat's view is never allowed to show a sibling

On the dead branch, the pane reports the seat exited rather than rendering whatever tmux moved the
view to. The operator sees an exited seat, which is true, instead of a duplicate, which is not.

### 3. Delivery to a dead seat fails loudly

`deliverPrompt` must refuse when the seat's own window is gone, naming the seat. Writing into a
sibling's window and reporting success is worse than any error — the sender records a delivered
prompt, the wrong agent acts on it, and the intended recipient never existed at the time of the
call.

### 4. Say when a seat dies, once

A seat whose window disappears is a fact the board can observe and nothing currently reports. Emit
it once, so a seat that dies mid-run is visible without an operator noticing a pane looks wrong.

## Verification Plan

### Automated Tests

1. **New** `src/test/dead-seat-routing-contract.test.js`, wired as
   `test:contract:dead-seat-routing` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate. Seats a
   two-member team against a real tmux, kills one member's window, and asserts: the survivor's
   view is unchanged; the dead seat's view is not reported as healthy; and no two views resolve to
   the same window id.
2. **Go test** over the split from change 1 — a seat with a known session/window whose window is
   absent is classified dead, and a seat whose tmux is unreachable is classified unverifiable.
   Same empty string today, different verdicts required.
3. Assert `deliverPrompt` refuses for a seat whose window is gone, and that the refusal names the
   seat rather than reporting `bytesWritten`.

### Goal Invariants

- A seat whose agent has died renders as exited, never as another seat.
- No two panes in a team ever show the same agent.
- A prompt addressed to a dead seat is refused, and is never written into a sibling's window.
- Killing one seat's window leaves every other seat's view exactly where it was.
