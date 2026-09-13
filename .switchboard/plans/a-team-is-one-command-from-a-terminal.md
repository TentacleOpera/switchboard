# A Team Is One Command From a Terminal

## Goal

`switchboard team attach coding` starts the Coding team if it is not up, puts the operator in
the lead's terminal, and leaves the members running where the browser can watch them. One
command, from an SSH session, with no seat names to look up first.

### Why this is not just `attach`

`switchboard attach <seat>` (see `attach-a-seat-from-any-terminal-client-without-tmux.md`) is
the primitive: one named seat that already exists. It is the right primitive and the wrong
front door. Working with a team from a terminal today would mean: list the teams, find the
head's seat name, start the team through a verb, wait, discover the member names, then attach.
That is five steps to reach the thing the operator actually wanted, and four of them are
lookups.

The unit of work is the **team**. The command should take the team.

### What the operator is actually asking for

"Put me in the lead, and have the members running somewhere I can see them." The lead is where
a human types — it is the seat that takes direction and dispatches. The members are watched,
not driven, and the browser grid is already good at watching several seats at once. So the
split is not arbitrary: **the terminal gets the one seat you talk to, the browser gets the
ones you observe.**

### Three facts that constrain the design

1. **`startAgentGroup` takes a group id, never a definition** (`KanbanProvider.ts:14466`). The
   verb is reachable over HTTP and a definition carries `startupCommand` strings the host
   would run, so the name→id resolution happens client-side and only the id goes on the wire.

2. **Starting is NOT idempotent.** `ptyCreateTerminal` refuses a name that already exists —
   *"terminal name already exists"* — as a hard error, deliberately (*"the caller asked for a
   name that already exists"*). So `team attach` cannot simply always call start and let it
   sort itself out. It must look first.

3. **The operator is on SSH, so `127.0.0.1` is a useless thing to print.** The board already
   resolves the address it is reachable at (the URL resolver landed in `7179f9d2`); the team
   command must print that, not a loopback URL that means nothing on the laptop the operator
   would open the browser on.

### Non-goals

- **Running the members in the terminal too.** No splits, no multiplexing, no grid in the
  CLI. That is the multiplexer this whole direction is getting out of.
- **A new team lifecycle.** Teams are started by the existing verb with the existing
  semantics. This is a front door onto it, not a second way to create teams.
- **Repairing a half-started team.** Reported, not silently patched — see change 3.

## Metadata

- **Complexity:** 4
- **Tags:** cli, teams, terminals, ux

## User Review Required

None.

## Dependencies

Builds on `attach-a-seat-from-any-terminal-client-without-tmux.md` — this plan is the
workflow layer over that primitive and cannot land before it.

## Proposed Changes

### 1. `switchboard team list`

Teams from `getAgentGroups`, each with its seat count and whether it is currently up, so the
operator can see what there is to attach to. `--json` for scripting.

### 2. `switchboard team attach <name>`

Name resolution is case-insensitive and accepts an unambiguous prefix, so `coding` reaches
`Coding`. An ambiguous prefix lists the candidates and exits non-zero rather than picking one
— guessing which team to start is exactly the kind of silent wrong answer that is expensive
here.

Then, having resolved the group and read `ptyListTerminals` once:

| State | Action |
| :--- | :--- |
| No seat of this team exists | start the team, wait for the head, attach |
| The head exists | attach; do not start |
| Some seats exist, head among them | attach, and name the missing seats on stderr |
| Some seats exist, head missing | refuse; print what is up and what is missing |

The last two rows are why this probes rather than starting blind: a partial start would hit
the duplicate-name error on the seats that are already there, and a team half-created by a
failed call is worse than one the operator was told about.

`--no-start` refuses instead of starting, for a session that means to observe and not to
create. `--seat <name|role>` attaches to a member instead of the head, so the same command
covers "get me into coder-1" without a second lookup.

### 3. Print the roster, then the address, then attach

Before the screen is handed over, the operator sees what came up and where the rest of it is:

```
Team Coding — starting
  Coding           lead     attaching
  Coding-coder-1   coder    running
  Coding-coder-2   coder    running
  Coding-intern    intern   running
Watch the members at https://<board address>/terminals
Detach with Ctrl-\ q — the team keeps running.
```

and on detach:

```
Detached from Coding. Team still running: 4 seats — https://<board address>/terminals
```

The detach line is the one that matters. Every multiplexer habit says detaching might have
killed something; saying plainly that it did not, and where the work now lives, is what stops
the operator re-attaching to check.

The address comes from the board's own URL resolver, never a hardcoded `127.0.0.1`.

### 4. `switchboard team start <name>` and `switchboard team stop <name>`

The same resolution and the same reporting, without taking the screen. `start` is what a
script or a scheduled job calls; `stop` closes the team's seats through the existing close
path so the terminal front door is not a one-way street that always sends people back to the
browser to shut things down.

## Verification Plan

### Automated Tests

1. **New** `src/test/cli-team-attach-contract.test.js`, wired as `test:contract:cli-team-attach`
   **and invoked from `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is
   not a gate. Asserts each row of the state table against a real host: cold start attaches the
   head; a second invocation attaches without starting; a team whose head is missing is refused
   with the missing seats named.
2. Name resolution: `coding` resolves `Coding`; an ambiguous prefix exits non-zero and lists
   candidates; an unknown name exits non-zero. A resolver that silently picks the first match
   is the failure being pinned.
3. Assert the wire payload for `startAgentGroup` carries `groupId` and **no** group definition
   — the rule at `KanbanProvider.ts:14466` is a security boundary, so it gets a test rather
   than a comment.
4. Assert the printed address is the resolved board URL and never `127.0.0.1` when a non-loopback
   address is available.
5. Regression: `test:contract:cli-attach`, `test:contract:pty-host-blackbox`, `go test ./cmd/...`.

### Goal Invariants

- From a fresh SSH session with nothing running, `switchboard team attach coding` ends with the
  operator typing to the lead and three members visible in the browser.
- Running it a second time attaches without starting anything, and creates no duplicate seat.
- Detaching leaves every seat running; `switchboard team list` afterwards shows the team up.
- A team that cannot be fully started reports which seats are missing instead of leaving a
  half-built team behind.
- The URL printed is one the operator can open from another machine.
