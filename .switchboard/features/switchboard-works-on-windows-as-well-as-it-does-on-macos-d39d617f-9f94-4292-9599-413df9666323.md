# Switchboard works on Windows as well as it does on macOS

<!-- board-collapse-01b -->
> **PATH CORRECTION 2026-09-04 (Board Collapse 01).** This file names `.agents/skills/_lib/sb_api_call.sh`, which was **deleted** in commit `96fb16df`. All eight `kanban_operations/*.js` scripts now share `.agents/skills/_lib/cli-call.js`, and `switchboard api` is the shell-side escape hatch. Read every `sb_api_call` reference below as `cli-call.js` / `switchboard api`, and do not restore the shell helper.


**Complexity:** 5

## Goal

Windows is a deliberately supported platform — 21 win32 branches across 8 non-test source files, PowerShell selection in the PTY backend, case-insensitive path normalisation — but three defects sit on top of that support, and one of them silently loses board state while orphaning every running agent. Close all three: replace the signal-based shutdown that Windows cannot honour with an authenticated HTTP verb, give dispatched terminals a usable shell and PATH from both Git Bash and Task Scheduler, and repoint three skills off POSIX-only tooling onto the Node equivalents that already exist. Deliberately excluded: no new Windows-only features, and no attempt to make the reserved .localhost TLD resolve on a resolver that does not implement it.

## How the Subtasks Achieve This

- **Windows `switchboard stop` is a hard kill — replace signal-based shutdown with an authenticated HTTP verb**: `cli.ts:779` sends SIGTERM, which on Windows Node maps to `TerminateProcess()` — immediate, unconditional, no handler runs. So `bootstrap.ts:2721`'s handler never fires, the 5-second grace period written to cover the debounced 300 ms `kanban.db` persist is dead code, a card moved just before `stop` is lost while the operator is told the server stopped cleanly, and because Windows does not terminate a process tree with its parent, every dispatched agent CLI is orphaned — still holding worktree handles, still consuming quota, invisible to the board. This subtask adds an authenticated `POST /shutdown` that runs the existing teardown and makes `stop` prefer it on **every** platform, so the two implementations cannot drift. Review also discovered that `disposeAll()` is broken on Windows: `pty.kill('SIGTERM')` throws `'Signals not supported on windows.'` in node-pty, and the catch swallows it — so even with the HTTP verb, orphans survive unless `disposeAll()` is fixed to call `pty.kill()` without a signal on Windows (which triggers node-pty's built-in `getConsoleProcessList()` reaper).
- **Windows terminals get an unusable environment — the wrong shell from Git Bash, no PATH from Task Scheduler**: two independent defects with one symptom — a dispatched terminal that never spawns an agent. `ptyBackend.ts:84` consults `process.env.SHELL` ahead of its own `win32` default, so Git Bash's `SHELL=/usr/bin/bash` (an MSYS path meaningless to ConPTY) wins and the correct PowerShell branch is unreachable. Separately, `README.md:19`/`:25` instruct the reader to set `PATH` "explicitly in the unit" for all three service managers, but Task Scheduler XML has no environment-variable mechanism at all, leaving the documented agent-CLI requirement unmeetable. This subtask fixes the shell precedence, ships a wrapper `.cmd` as the only place PATH can be set for Task Scheduler, and documents the `.localhost` fallback Windows users currently hit unwarned.
- **Three skills instruct agents to use POSIX-only tooling — point them at the existing Node equivalents**: `query-kanban`, `manage-features` and `kanban_operations` reach for `sqlite3`, `curl` and `jq`, so an agent on Windows reads an authoritative instruction and runs a command that does not exist. The failure is not a crash but an improvisation — and an agent told to query state and unable to may reach for the direct DB writes the protocol forbids. Only `kanban_operations` has `.js` siblings (and already uses them); `query-kanban` and `manage-features` have none, so their SQL templates and prerequisite checks must be rewritten as `get-state.js` output filtered through `node -e` one-liners or HTTP API calls. `_lib/sb_api_call.sh` has no Node equivalent and is marked POSIX-only.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Three skills instruct agents to use POSIX-only tooling — point them at the existing Node equivalents](../plans/skills-posix-only-tooling.md) — **PLAN REVIEWED** — ID: 35fead7a-2119-4c4c-9067-60a4ce6554cc
- [ ] [Windows `switchboard stop` is a hard kill — replace signal-based shutdown with an authenticated HTTP verb](../plans/windows-graceful-stop-http-verb.md) — **PLAN REVIEWED** — ID: 8eba302d-5203-41fd-b1aa-56a8a5e8689a
- [ ] [Windows terminals get an unusable environment — the wrong shell from Git Bash, no PATH from Task Scheduler](../plans/windows-terminal-environment.md) — **PLAN REVIEWED** — ID: a6ed1ade-d43f-48ec-b874-99a205390dbd
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **The shutdown verb has a soft dependency on the durable-session-token subtask**, not on its siblings here. `_checkAuth` reads an empty stored token as *allow everything*, so `POST /shutdown` — a denial-of-service primitive if the gate is wrong — benefits from that fail-closed fix. However, `bootstrap.ts:482-485` already guards the standalone path: a blank stored token falls through to a random 32-byte session token, so the standalone server always has a non-empty expected token. The dependency is defence-in-depth, not a blocker.
- **The two code subtasks are independent of each other** and share no files: one touches `LocalApiServer.ts` plus the `stop` command body, the other `ptyBackend.ts` and the autostart templates. They can run in parallel.
- **The skills subtask is independent of both** — it edits only `.agents/skills/` instruction text, with no ordering constraint and no shared files.
- **Two subtasks collide with `standalone-daemon-lifecycle.md` in `docs/autostart/`.** That card carries its own unreviewed `--detach`-under-a-service-manager defect, which edits `README.md` and `switchboard-windows.xml` — the same two files this feature's terminal-environment subtask edits. Land them under one reviewer, or take conflicting edits. That defect is explicitly *not* in scope here: it affects all three platforms equally and belongs on the card that introduced it.
- **All three subtasks are in PLAN REVIEWED** — plan review is complete. Ready to drag the feature to a coder column.

