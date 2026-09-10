# Launch Gate: Everything That Must Close Before the Site Ships

**Complexity:** 3

## Goal

The defects that make the board unreliable, make the GUI show errors that are not true, or make the first run leak a secret. Ordered: the seating chain first (it both misroutes prompts and silently detaches every seat), then Mission Control (it cannot start, and it gates the site MISSIONS screenshot), then the two GUI-visible defects, then the security chain in its forced order — curl in generated prompts, the CSRF guard, and only then the token deletion.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Standing Orders Tab Hydrates Once, Over the One Channel That Can Fail](../plans/the-standing-orders-tab-hydrates-once-over-the-one-channel-that-can-fail.md) — **CREATED** — ID: 9fe3046b-7256-4292-84d2-c7ba79b492de
- [ ] [One Shell Load Builds the Board Fourteen Times, Then Discards Half of Them](../plans/one-shell-load-builds-the-board-fourteen-times-then-discards-half.md) — **CREATED** — ID: 7ff55c0c-3fae-4df8-8570-b0127529c0c4
- [ ] [Starting the Board Prints One Address, Never a Token, and Opens Nothing](../plans/starting-the-board-prints-where-to-reach-it-and-opens-nothing.md) — **CREATED** — ID: 2580a5cb-2ba4-4624-a772-14da1cb77dc8
- [ ] [The Host Still Types curl Into Every Lead Prompt](../plans/the-host-still-types-curl-into-every-lead-prompt.md) — **CREATED** — ID: 2d22baeb-e9ae-4436-8a17-05d5f728bd98
- [ ] [The Host Mirrors Every Turn-End Into an Inbox With No Reader and No Listener](../plans/171-blocked-reports-nobody-can-read.md) — **CREATED** — ID: 56e50bc2-6cc2-47f8-a1f2-b9551209f07e
- [ ] [Mission Control Reads Its Protocols From a Directory Nothing Writes To](../plans/mission-control-reads-its-protocols-from-a-directory-nothing-writes.md) — **CREATED** — ID: 5372655c-4c2a-4157-9a9a-e43d601ec6f2
- [ ] [Every Prompt to a Team Seat Is Delivered to the Previous Generation's Agent](../plans/a-tmux-seat-gets-a-blind-two-second-clear-and-loses-the-first-dispatch.md) — **CREATED** — ID: 59b355e5-78f7-4a13-a7c5-8f6729e7bcb8
<!-- END SUBTASKS -->
