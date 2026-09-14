# Tmux retired plans

**Complexity:** 7

## Goal

Parked work for tmux seating, retired 2026-09-14 when the decision was taken that the board stops creating its own tmux sessions. Switchboard clears agent context at regular checkpoints, so session persistence preserved a conversation the next checkpoint deleted, and the reach-a-seat-from-any-terminal requirement it was really serving is met by switchboard attach over the existing pty WebSocket. Two of these subtasks shipped and describe code to be removed rather than work to do. Kept intact so tmux seating can be revived if the decision is revisited.

## How the Subtasks Achieve This

Two of these shipped and are an inventory of code to remove. Four were never built and are simply
dropped. All six are kept verbatim so the decision is reversible.

- **A Team Can Be Seated Into A tmux Session Switchboard Owns** (SHIPPED) — the plan that introduced
  seating. Its stated benefit was reaching a team from the Mac, the iPad or another network; that is
  served by `switchboard attach` with no session to orphan. Treat as the removal inventory.
- **Every Prompt to a Team Seat Is Delivered to the Previous Generation's Agent** (SHIPPED) — fixed the
  seating chain blocking before `select-window`. No chain, no window generations, no fix needed.
- **tmux Windows Duplicate on Re-Seat, and Nothing Reaps Orphaned Sessions** — both halves are
  board-owned-session problems. A board that never creates a session never appends to a stale one and
  has nothing to reap.
- **A Dead Seat's View Follows tmux to a Sibling's Window** — grouped view sessions exist only to give
  each seated member its own current-window pointer. Without seating the defect cannot occur.
- **Re-seat a Running Terminal Into tmux** — moves a running seat into tmux. Also the plan whose
  Non-goals supplied the argument for retiring seating: *"Team members are cleared regularly, so this
  costs nothing that is not already routinely spent."*
- **tmux Seating Is Team-Only, So a Panel Group Never Gets a Session** — widens seating to more
  surfaces, and is written against `tmuxTeamSeating.ts`, which no longer exists.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A Team Can Be Seated Into A tmux Session Switchboard Owns](../plans/seat-a-team-into-a-switchboard-owned-tmux-session.md) — **BACKLOG** — ID: 05f70823-595e-42db-ae95-07cd01b0a860
- [ ] [tmux Seating Is Team-Only, So a Panel Group Never Gets a Session](../plans/tmux-seating-is-team-only-so-a-panel-group-never-gets-a-session.md) — **BACKLOG** — ID: 2d342194-ad9b-4c0c-9db0-6fa0d67459e6
- [ ] [tmux Windows Duplicate on Re-Seat, and Nothing Reaps Orphaned Sessions](../plans/tmux-windows-duplicate-on-re-seat-and-nothing-reaps-orphaned-sessions.md) — **BACKLOG** — ID: 20ff27e9-2fb0-46e1-8da0-80d028f9dc48
- [ ] [Every Prompt to a Team Seat Is Delivered to the Previous Generation's Agent](../plans/a-tmux-seat-gets-a-blind-two-second-clear-and-loses-the-first-dispatch.md) — **BACKLOG** — ID: 59b355e5-78f7-4a13-a7c5-8f6729e7bcb8
- [ ] [Re-seat a Running Terminal Into tmux](../plans/re-seat-a-running-terminal-into-tmux.md) — **BACKLOG** — ID: d23ef964-f848-41d7-880f-e9308790e4ff
- [ ] [A Dead Seat's View Follows tmux to a Sibling's Window](../plans/a-dead-seats-view-follows-tmux-to-a-siblings-window.md) — **BACKLOG** — ID: 37b3f151-aeed-4c62-bc3e-1cc566c05075
<!-- END SUBTASKS -->

