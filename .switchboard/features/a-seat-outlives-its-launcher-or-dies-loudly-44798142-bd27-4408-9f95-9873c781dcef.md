# A Seat Outlives Its Launcher, or Dies Loudly

**Complexity:** 7

## Goal

Six defects in one seam: what a seat inherits when it starts, what survives when its host dies, and what is reported when it exits. A pty-host death empties the board while tmux still holds the agents; a seat's pty inherits TERM from whoever launched the board, so the fleet depends on the launching shell; tmux seating and the tmux bridge share one switch though only the bridge is wanted; an agent exit destroys the seat and the error with it; a role with no startup command can still be seated; and there is no way to attach a seat from an ordinary terminal client. Grouped because they share the seat lifecycle and will otherwise be fixed one at a time by agents who each re-derive the same model.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A Pty-Host Death Empties the Board While tmux Still Holds the Agents](../plans/a-pty-host-death-empties-the-board-while-tmux-still-holds-the-agents.md) — **PLAN REVIEWED** — ID: 0b467d08-bd47-4586-9c1b-d007afad2d41
- [ ] [Attach a Seat From Any Terminal Client, Without tmux](../plans/attach-a-seat-from-any-terminal-client-without-tmux.md) — **PLAN REVIEWED** — ID: d13a7a34-bcd6-4ce5-8c21-e80956f09269
- [ ] [tmux Seating and the tmux Bridge Are Separate Switches](../plans/tmux-seating-and-the-tmux-bridge-are-separate-switches.md) — **PLAN REVIEWED** — ID: 17eb8a87-5971-4a92-9735-fb4ab88f8352
- [ ] [A Seat's pty Inherits `TERM`, So the Fleet Depends on Who Launched the Board](../plans/a-seats-pty-inherits-term-so-the-fleet-depends-on-who-launched-the-board.md) — **PLAN REVIEWED** — ID: ca07368e-ec29-4f6c-ba01-bfad7e65d0f9
- [ ] [An Agent Exit Destroys the Seat and Its Error With It](../plans/an-agent-exit-destroys-the-seat-and-its-error-with-it.md) — **PLAN REVIEWED** — ID: d7155efc-afa6-46f3-9a71-456ae2a267b3
- [ ] [A role with no startup command can still be seated](../plans/a-role-with-no-startup-command-can-still-be-seated.md) — **PLAN REVIEWED** — ID: 763689b1-700d-4b8b-adf1-91ab09096cc5
<!-- END SUBTASKS -->
