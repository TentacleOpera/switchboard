# Teams Keep One Generation, One Name, and Close When You Close Them

**Complexity:** 6

## Goal

Re-seating a team builds a second generation of tmux windows beside the first instead of reattaching to the one already running, and nothing ever removes either. The seating chain blocks on a new-session form that attaches instead of returning, so select-window never runs and every prompt is delivered to the previous generation's agent while the API reports success. Seats are then targeted by a name that is not unique across generations, and closing a terminal leaves its tmux session running and invisible. Together these make a team that was started twice unaddressable: the operator sees one team, the board sees another, and the lead talks to agents nobody can see.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [tmux Windows Duplicate on Re-Seat, and Nothing Reaps Orphaned Sessions](../plans/tmux-windows-duplicate-on-re-seat-and-nothing-reaps-orphaned-sessions.md) — **LEAD CODED** — ID: 20ff27e9-2fb0-46e1-8da0-80d028f9dc48
- [ ] [Every Prompt to a Team Seat Is Delivered to the Previous Generation's Agent](../plans/a-tmux-seat-gets-a-blind-two-second-clear-and-loses-the-first-dispatch.md) — **LEAD CODED** — ID: 59b355e5-78f7-4a13-a7c5-8f6729e7bcb8
- [ ] [Closing a Terminal Closes Its tmux Session, and Nothing Ever Closes Itself](../plans/closing-a-terminal-closes-its-tmux-session-and-nothing-closes-itself.md) — **LEAD CODED** — ID: 2ed288d7-8cbc-494a-95be-167a600d2674
<!-- END SUBTASKS -->

## Completion Summary

All three subtasks implemented and committed (single commit, 26 files). Subtask 1 (window duplication + orphan reaper): seating chain refactored to if/elif/else with grep -Fxq name test and per-session flock; window id captured at creation and used for all targeting; solo seats skip the grouped view; operator close kills the window, natural exit preserves it; boot reaper reads persisted runtime.terminals and kills unowned lc-* sessions. Subtask 2 (prompt misrouting): non-blocking has-session || new-session -d replaces the -A attach form; verifyTmuxRouting flags misrouted seats at spawn; deliverPrompt post-send check returns misrouted:true on wrong-window delivery. Subtask 3 (close on close): per-seat close kills view session via fleet.close(killTmuxView=true); team close kills group by $N session ID; tmux tab gains executable close button + attached badge; sidebar shows seatless sessions; both composition roots wire tmuxKillSession + tmuxKillSessionGroup; invariant contract test pins kill-session reachability to operator paths only. Compilation and automated tests skipped per directive.

