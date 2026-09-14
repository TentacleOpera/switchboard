---
description: 'A Seat Outlives Its Launcher, or Dies Loudly'
---

# A Seat Outlives Its Launcher, or Dies Loudly

## Goal

Six defects in one seam: what a seat inherits when it starts, what survives when its host dies, and what is reported when it exits. A pty-host death empties the board while tmux still holds the agents; a seat's pty inherits TERM from whoever launched the board, so the fleet depends on the launching shell; tmux seating and the tmux bridge share one switch though only the bridge is wanted; an agent exit destroys the seat and the error with it; a role with no startup command can still be seated; and there is no way to attach a seat from an ordinary terminal client. Grouped because they share the seat lifecycle and will otherwise be fixed one at a time by agents who each re-derive the same model.

## How the Subtasks Achieve This

- **A Pty-Host Death Empties the Board While tmux Still Holds the Agents**: the board's view of the fleet is derived from the pty host, so when that host dies the board reports an empty fleet while the agents are still alive inside tmux. Establishes that the board must read seat existence from the session owner, not from the process that happened to spawn it.
- **Attach a Seat From Any Terminal Client, Without tmux**: gives a seat an attach path that does not route through tmux at all, which is what makes the seating/bridge split below meaningful rather than cosmetic.
- **tmux Seating and the tmux Bridge Are Separate Switches**: one config flag currently governs two unrelated features — the board creating its own tmux sessions (unwanted) and the board messaging panes a human created (wanted). Splits them so the bridge can be kept without the seating.
- **A Seat's pty Inherits `TERM`, So the Fleet Depends on Who Launched the Board**: an unset or foreign `TERM` makes `tmux attach` fail, the pty exit, and the board report `exited` while the agent lives. Pins what a seat inherits at start instead of leaving it to the launching shell.
- **An Agent Exit Destroys the Seat and Its Error With It**: the seat teardown discards the agent's exit output, so the one artefact explaining why it died is lost. Makes the exit reportable.
- **A role with no startup command can still be seated**: a seat with nothing to run is created anyway and looks live. Closes the last way to get a seat that cannot do work.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A Pty-Host Death Empties the Board While tmux Still Holds the Agents](../plans/a-pty-host-death-empties-the-board-while-tmux-still-holds-the-agents.md) — **PLAN REVIEWED** — ID: 0b467d08-bd47-4586-9c1b-d007afad2d41
- [ ] [Attach a Seat From Any Terminal Client, Without tmux](../plans/attach-a-seat-from-any-terminal-client-without-tmux.md) — **PLAN REVIEWED** — ID: d13a7a34-bcd6-4ce5-8c21-e80956f09269
- [ ] [tmux Seating and the tmux Bridge Are Separate Switches](../plans/tmux-seating-and-the-tmux-bridge-are-separate-switches.md) — **PLAN REVIEWED** — ID: 17eb8a87-5971-4a92-9735-fb4ab88f8352
- [ ] [A Seat's pty Inherits `TERM`, So the Fleet Depends on Who Launched the Board](../plans/a-seats-pty-inherits-term-so-the-fleet-depends-on-who-launched-the-board.md) — **PLAN REVIEWED** — ID: ca07368e-ec29-4f6c-ba01-bfad7e65d0f9
- [ ] [An Agent Exit Destroys the Seat and Its Error With It](../plans/an-agent-exit-destroys-the-seat-and-its-error-with-it.md) — **PLAN REVIEWED** — ID: d7155efc-afa6-46f3-9a71-456ae2a267b3
- [ ] [A role with no startup command can still be seated](../plans/a-role-with-no-startup-command-can-still-be-seated.md) — **PLAN REVIEWED** — ID: 763689b1-700d-4b8b-adf1-91ab09096cc5
<!-- END SUBTASKS -->

## Dependencies & sequencing

The first three are ordered: **tmux Seating and the tmux Bridge Are Separate Switches** defines the boundary, and **Attach a Seat From Any Terminal Client** is what makes a bridge-only configuration usable — without it, splitting the switch leaves no way to attach. **A Pty-Host Death Empties the Board** depends on that boundary existing, since it changes where the board reads seat existence from.

The remaining three — `TERM` inheritance, exit reporting, and the command-less role — are independent of each other and of the tmux work, and can be executed in parallel.
