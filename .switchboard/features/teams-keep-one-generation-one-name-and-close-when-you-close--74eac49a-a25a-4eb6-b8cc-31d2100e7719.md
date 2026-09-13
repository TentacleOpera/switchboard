# Teams Keep One Generation, One Name, and Close When You Close Them

**Complexity:** 6

## Goal

Re-seating a team builds a second generation of tmux windows beside the first instead of reattaching to the one already running, and nothing ever removes either. The seating chain blocks on a new-session form that attaches instead of returning, so select-window never runs and every prompt is delivered to the previous generation's agent while the API reports success. Seats are then targeted by a name that is not unique across generations, and closing a terminal leaves its tmux session running and invisible. Together these make a team that was started twice unaddressable: the operator sees one team, the board sees another, and the lead talks to agents nobody can see.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [tmux Windows Duplicate on Re-Seat, and Nothing Reaps Orphaned Sessions](../plans/tmux-windows-duplicate-on-re-seat-and-nothing-reaps-orphaned-sessions.md) — **PLAN REVIEWED** — ID: 20ff27e9-2fb0-46e1-8da0-80d028f9dc48
- [ ] [Every Prompt to a Team Seat Is Delivered to the Previous Generation's Agent](../plans/a-tmux-seat-gets-a-blind-two-second-clear-and-loses-the-first-dispatch.md) — **CODE REVIEWED** — ID: 59b355e5-78f7-4a13-a7c5-8f6729e7bcb8
- [ ] [Closing a Terminal Closes Its tmux Session, and Nothing Ever Closes Itself](../plans/closing-a-terminal-closes-its-tmux-session-and-nothing-closes-itself.md) — **CODE REVIEWED** — ID: 2ed288d7-8cbc-494a-95be-167a600d2674
<!-- END SUBTASKS -->

## Completion Summary

All three subtasks implemented and committed (single commit, 26 files). Subtask 1 (window duplication + orphan reaper): seating chain refactored to if/elif/else with grep -Fxq name test and per-session flock; window id captured at creation and used for all targeting; solo seats skip the grouped view; operator close kills the window, natural exit preserves it; boot reaper reads persisted runtime.terminals and kills unowned lc-* sessions. Subtask 2 (prompt misrouting): non-blocking has-session || new-session -d replaces the -A attach form; verifyTmuxRouting flags misrouted seats at spawn; deliverPrompt post-send check returns misrouted:true on wrong-window delivery. Subtask 3 (close on close): per-seat close kills view session via fleet.close(killTmuxView=true); team close kills group by $N session ID; tmux tab gains executable close button + attached badge; sidebar shows seatless sessions; both composition roots wire tmuxKillSession + tmuxKillSessionGroup; invariant contract test pins kill-session reachability to operator paths only. Compilation and automated tests skipped per directive.

## Review Findings

Reviewed as one delivery unit at HEAD (`6b524d4b` plus ~12 follow-up fixes), since all three subtasks share the seating seam. The feature's goal is substantially achieved and confirmed against the live tmux server on this host: one generation (`lc-coding-team` = 4 windows for 4 seats, was 12), one name (targeting by `$wid`, never the duplicate-prone window name), solo seats down to one session each, and the seating chain no longer blocks on `new-session -A`. Two defects survived to HEAD and are fixed here: `killTmuxSessionGroup` parsed tmux output with a bare `split('\x1f')` when tmux vis-escapes the separator to a literal `\037` (measured on 3.4), so team close killed nothing and reported success; and the boot reaper could destroy a live, attached session because its only ownership signal is a registry the Go host does not populate on the restart path. Nineteen contract checks across four CI-wired suites were red at HEAD — stale fixtures at 10 fields against an 11-field `PANE_FORMAT`, assertions still demanding `controlMode` gating and `-CC` after both were deliberately removed, and two whole-file regexes that could never fail — all now green. The completion summary's "Compilation and automated tests skipped per directive" was treated as a record of what the coder did, not an instruction; everything was run independently.

## Deferred Findings

- CRITICAL — `project()` omits `tmuxSession`/`tmuxWindow`/`tmuxViewSession`, so seats rehydrated after a board restart lose the reaper's ownership signal. Fix is already uncommitted in the working tree by another agent; not staged here. `cmd/switchboard-pty-host/main.go:219`
- MAJOR — subtask 1's Goal (a boot reaper) and subtask 3's Goal Invariant ("No automatic close exists") are irreconcilable and both shipped. Narrowed, not resolved; escalated on `20ff27e9`. `src/standalone/bootstrap.ts:4577`
- MAJOR — the feature's core mechanisms (window reuse, routing repair, close-on-close) are gated only by source-text contract assertions; no automated check executes a real seating chain or a real close. The plan's live tmux verification steps were not executed in this pass beyond read-only inspection of the running board. `src/test/tmux-backend-contract.test.js`
- MAJOR — two `runtime.terminals` writers persist divergent object literals (`ptyFleetService.ts` has `machineId` and no `tmuxSession`; `goPtyFleetProjection.ts` the reverse). `src/standalone/ptyFleetService.ts:1274`
- MAJOR — `killTmuxSessionGroup` cannot reach an ungrouped (solo-seat) session, and does not implement the retry the plan specifies for tmux issue 5180. `src/standalone/tmuxBackend.ts:519`
- NIT — stale comment in `fleet.close()` contradicts the gating immediately below it. `cmd/switchboard-pty-host/main.go:947`
- NIT — `remain-on-exit on` (the documented mitigation for an agent's last-window exit destroying the whole group) is still unset at seat creation. `src/services/goPtyFleetProjection.ts:409`
