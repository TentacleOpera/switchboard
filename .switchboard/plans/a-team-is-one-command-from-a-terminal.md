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

1. **`startAgentGroup` takes a group id, never a definition** (`KanbanProvider.ts:14478`). The
   verb is reachable over HTTP and a definition carries `startupCommand` strings the host
   would run, so the name→id resolution happens client-side and only the id goes on the wire.

2. **Starting is NOT idempotent.** `ptyCreateTerminal` refuses a name that already exists —
   *"terminal name already exists"* — as a hard error, deliberately (*"the caller asked for a
   name that already exists"*, `cmd/switchboard-pty-host/main.go:262-274`). So `team attach`
   cannot simply always call start and let it sort itself out. It must look first.

3. **The operator is on SSH, so `127.0.0.1` is a useless thing to print.** The board already
   resolves the address it is reachable at (the URL resolver landed in `7179f9d2`); the team
   command must print that, not a loopback URL that means nothing on the laptop the operator
   would open the browser on.

> **Superseded (fact 3 — "the board already resolves the address"):** The plan asserted the
> resolved URL is available for the team command to print. It is not. `resolveTailnetOrigin`
> (`src/utils/tailnetOrigin.ts:133`) runs ONCE at startup to select the URL `openBrowser`
> receives (`src/standalone/cli.ts:4793`), and its output is then discarded — it is written to
> no state file and exposed by no endpoint. `CmdStatus` prints `c.Routes.Endpoint.Value.BaseURL`
> (`internal/client/verbs.go:1165`), which is the loopback endpoint the CLI dialled, not the
> resolved board URL. `/health` and `/launcher/state` were both inspected and carry no board
> URL field. So a later `team attach` invocation cannot retrieve the resolved URL as the plan
> assumes.
>
> **Reason:** A goal stated as a constraint that the host does not satisfy is a load-bearing
> false assumption — the Goal Invariant "the URL printed is one the operator can open from
> another machine" is unimplementable as written and would silently degrade to printing
> `127.0.0.1`.
>
> **Replaced with:** Make the resolved URL retrievable. Minimal path: persist
> `resolveTailnetOrigin`'s result to a state file at startup (mirroring the
> `<root>/.switchboard/pty-host-state.json` pattern the pty host already writes), and have the
> CLI read it. Robust path: add a `/board-url` read endpoint that re-runs the resolver on
> demand. Either way the loopback fallback is *removed*, not papered over — a missing resolved
> URL is reported, never silently substituted with `127.0.0.1` (AGENTS.md fallback rule).

### Non-goals

- **Running the members in the terminal too.** No splits, no multiplexing, no grid in the
  CLI. That is the multiplexer this whole direction is getting out of.
- **A new team lifecycle.** Teams are started by the existing verb with the existing
  semantics. This is a front door onto it, not a second way to create teams.
- **Repairing a half-started team.** Reported, not silently patched — see change 3.

## Metadata

**Feature:** ce72d301-2d9b-4dbd-8266-ff3e085e450e
- **Complexity:** 6
- **Tags:** cli, ux, feature

## User Review Required

None.

## Complexity Audit

### Routine

- Name resolution: case-insensitive, unambiguous-prefix match over `getAgentGroups` names —
  a pure client-side string match. Ambiguous prefix lists candidates and exits non-zero;
  unknown name exits non-zero. No guessing.
- Driving `startAgentGroup` over `POST /kanban/verb/startAgentGroup` with `{ groupId }` only —
  the verb already exists and already rejects a definition payload (`KanbanProvider.ts:14479`).
- Delegating the actual screen hand-off to the existing `attach` primitive
  (`attach-a-seat-from-any-terminal-client-without-tmux.md`). No new terminal client code.
- `team list` rendering: a table join of `getAgentGroups` (definitions) with `ptyListTerminals`
  (live seats), both existing verbs. `--json` for scripting, consistent with `fleet`.
- `--no-start` is a flag that swaps the "start then attach" arm for a refusal — a branch, not
  a new mechanism.

### Complex / Risky

- **Seat-to-team mapping has no authoritative source over HTTP.** `ptyListTerminals`
  (`f.project(t)`, `cmd/switchboard-pty-host/main.go:204`) returns `friendlyName`, `role`,
  `status`, `parentInstanceId` — no `groupId`, no `isHead`. `getAgentGroups` returns team
  *definitions* (`_loadAgentGroups`, `KanbanProvider.ts:4973`), not live groups. So mapping live
  seats to a team is an inference, not a read. The deterministic naming convention
  (`seatNameFromTeamName` for the head, `${headName}-${role}-${n}` for per-team members,
  `${teamName}-${role}-${n}` for shared members — `agentGroupInstantiation.ts:101`,
  `ptyFleetService.ts:1092`) lets the CLI *compute* expected seat names from a definition, but
  a standalone seat whose name happens to match the convention is misidentified. See the
  Superseded callout in change 2 for the chosen resolution.
- **The resolved board URL is not retrievable by a later CLI call** (see the fact-3 Superseded
  callout above). Closing this is a new write surface (state file) or a new read endpoint.
- **`team stop` has no team-aware close verb.** There is no `stopAgentGroup`; the pty path
  closes seats one at a time via `ptyCloseTerminal`. `stop` must compute the same seat names
  `attach` computes and close each — and a wrong name closes a seat that is not the team's
  (destructive, no confirm gate by codebase rule). The tmux path has `tmuxKillSessionGroup`
  (`TaskViewerProvider.ts:1854`) but the pty path does not.
- **`--seat <role>` resolution.** "coder" maps to potentially several live seats
  (`Coding-coder-1`, `Coding-coder-2`). Pick-first is a silent wrong answer; the rule must be
  refuse-on-ambiguity.
- **"Wait for the head" is pty-exists, not agent-ready.** `startAgentGroup` returns when seats
  are created, not when the agent CLI has booted. The wait must be defined as polling
  `ptyListTerminals` for the head seat name to appear (bounded), then attaching — and the plan
  must not claim readiness it does not measure.

## Edge-Case & Dependency Audit

### Race Conditions

- **Start-then-list race.** `startAgentGroup` returns after seat creation, but `ptyListTerminals`
  is a separate round-trip. A probe immediately after start may not yet show the head. The
  "wait for the head" poll (change 2) absorbs this; the poll must have a bounded timeout and
  report a failed start rather than hanging.
- **Concurrent `team attach` from two SSH sessions.** Both resolve "no seat exists", both
  call `startAgentGroup`. The second hits `ptyCreateTerminal`'s "terminal name already exists"
  hard error. The CLI must treat that error on the start arm as "another caller started it" —
  re-probe and attach if the head now exists, rather than surfacing a duplicate-name error to
  the operator.
- **Seat disappears between probe and attach.** The probe sees the head; by the time `attach`
  dials the WS, the seat is gone. `attach` already handles a missing seat (the dependency
  plan); `team attach` must surface that as "the head went away", not a raw WS error.

### Security

- `startAgentGroup` is a kanban verb behind the board's auth + CSRF guard; the Go CLI's
  transport already sets `X-Switchboard-Client: switchboard-cli` (`internal/client/transport.go:160`).
  No new surface is exposed — `team attach` only composes existing authenticated verbs.
- The resolved board URL, once persisted/exposed, carries no token (it is the tailnet/serve
  URL). Printing it reveals the hostname, not a credential — consistent with the existing
  startup banner that already prints it.

### Side Effects

- `team attach` with no team up *starts* one — a side effect for a command whose name says
  "attach". Mitigated by `--no-start` for observe-only sessions, and by the roster print that
  names what came up. The operator is told, not surprised.
- `team stop` closes seats — destructive and irreversible (no confirm gate by codebase rule).
  The seat-name computation must be the *same* path `attach` uses, and a name that does not
  resolve to a live seat of this team is skipped, not closed.
- Detach (Ctrl-\ q) closes only the WS; the team keeps running. No seat is killed on detach.

### Dependencies & Conflicts

- **Hard dependency on `attach-a-seat-from-any-terminal-client-without-tmux.md`.** `team attach`
  delegates the screen hand-off to the `attach` primitive; it cannot land before that plan. The
  `attach` verb must be in the Go client's `ownedVerbs` map and `dispatchOwned` switch first.
- **`getAgentGroups` and `startAgentGroup` are kanban verbs** at `POST /kanban/verb/<name>`.
  The Go CLI's `CmdVerb` tries `/terminals/verb/<name>` then falls back to `/kanban/verb/<name>`
  (`internal/client/verbs.go:822-827`), so both are reachable. The new `team` verb must be
  added to `ownedVerbs` and `dispatchOwned` (`cmd/switchboard/main.go:22`, `:172`), same as
  `attach`/`fleet`.
- **No conflict with `fleet`.** `fleet` lists seats; `team list` lists teams (with per-team
  seat counts/up-state). Different aggregations of the same underlying verbs, no fork.
- **New read surface for the resolved URL** (state file or `/board-url` endpoint) is a
  standalone-host change. Per the no-divergence rule, if it is an endpoint it must be wired in
  both `bootstrap.ts` and `extension.ts`; if it is a state-file write, the write site
  (`resolveTailnetOrigin`'s caller in both roots) must write in both.

## Dependencies

Builds on `attach-a-seat-from-any-terminal-client-without-tmux.md` — this plan is the
workflow layer over that primitive and cannot land before it. The `attach` verb, the
`ownedVerbs`/`dispatchOwned` wiring for it, and the WS client must all be in place first.

## Adversarial Synthesis

Key risks: (1) the resolved board URL the plan assumes is printable is not retrievable by a
later CLI call — it is computed once at startup and discarded; (2) `ptyListTerminals` carries
no team membership, so the state table's seat-to-team mapping is an inference by naming
convention that misidentifies colliding standalone seats; (3) `team stop` has no team-aware
close verb and must compute seat names to close per-seat — a wrong name closes a seat that is
not the team's, destructively. Mitigations: persist or expose the resolved URL and remove the
loopback fallback; specify the seat-mapping mechanism with a refuse-on-collision rule (or add
a live-groups read endpoint for authoritative membership); make `stop` reuse the exact
seat-name computation `attach` uses and skip non-team names rather than closing them.

## Proposed Changes

### 1. `switchboard team list`

- **Context.** The operator needs to see what there is to attach to. `getAgentGroups`
  (`POST /kanban/verb/getAgentGroups`) returns team *definitions* — name, id, headRole,
  members[] (role/count/scope). It does not return live state. `ptyListTerminals`
  (`POST /terminals/verb/ptyListTerminals`) returns live seats but no team id.
- **Logic.** Fetch both. For each definition, compute the expected head seat name via the
  `seatNameFromTeamName` rule (strip trailing "team", sanitise — `agentGroupInstantiation.ts:101`)
  and the expected member names via the delegate convention. Mark the team "up" when its head
  seat name is present in `ptyListTerminals`. Print one row per team: name, seat count (defined
  vs live), up/down. `--json` for scripting.
- **Implementation.** New `CmdTeam` in `internal/client/verbs.go`, routed from `dispatchOwned`
  (`cmd/switchboard/main.go:172`) with `team` added to `ownedVerbs` (`:22`). Subcommand
  dispatch on `list`/`attach`/`start`/`stop`.
- **Edge Cases.** A team whose head seat name collides with a standalone seat is reported
  "up (head name shared with a standalone seat — verify)" rather than a confident "up". The
  collision is surfaced, not hidden.

### 2. `switchboard team attach <name>`

- **Context.** The front door. Name resolution is case-insensitive and accepts an unambiguous
  prefix, so `coding` reaches `Coding`. An ambiguous prefix lists the candidates and exits
  non-zero rather than picking one — guessing which team to start is exactly the kind of
  silent wrong answer that is expensive here.
- **Logic.** Having resolved the group id from `getAgentGroups` and read `ptyListTerminals`
  once, compute the team's expected seat names (head via `seatNameFromTeamName`, members via
  the delegate convention) and match them against live seats:

| State | Action |
| :--- | :--- |
| No seat of this team exists | start the team, wait for the head, attach |
| The head exists | attach; do not start |
| Some seats exist, head among them | attach, and name the missing seats on stderr |
| Some seats exist, head missing | refuse; print what is up and what is missing |

  The last two rows are why this probes rather than starting blind: a partial start would hit
  the duplicate-name error on the seats that are already there, and a team half-created by a
  failed call is worse than one the operator was told about.

> **Superseded (seat-to-team mapping):** The original state table assumed `ptyListTerminals`
> alone reveals which seats belong to the team. It does not — `f.project(t)`
> (`cmd/switchboard-pty-host/main.go:204`) returns no `groupId`/`isHead`. The plan left the
> mapping mechanism unspecified.
>
> **Reason:** An unspecified mapping hides the standalone-seat-collision risk: a seat named
> `Coding-coder-1` that is not part of the Coding team is misidentified as a member, producing
> a false "head missing" refusal or, on the head name, attaching to the wrong seat. The plan's
> own verification passes against a clean test host and fails in the install base.
>
> **Replaced with:** Compute expected seat names client-side from the `getAgentGroups`
> definition using the deterministic naming convention (`seatNameFromTeamName` for the head,
> `${headName}-${role}-${n}` for per-team members, `${teamName}-${role}-${n}` for shared
> members — `agentGroupInstantiation.ts:101`, `ptyFleetService.ts:1092`), then match against
> `ptyListTerminals`. A live seat whose name matches the convention but whose
> `parentInstanceId` does not chain to the team's head is treated as a collision: the seat is
> not counted as the team's, and the collision is reported on stderr. The authoritative fix —
> a read endpoint exposing the live `terminals.groups` row (which carries the actual
> `headName` + member names) — is recommended as a follow-up if the naming-convention path
> proves brittle in practice; it removes the inference entirely.

- **Implementation.** Subcommand of `CmdTeam`. "Wait for the head" = poll `ptyListTerminals`
  for the computed head seat name to appear, bounded (e.g. 20s), then delegate to the existing
  `attach` primitive. A `startAgentGroup` call that returns a duplicate-name error on the
  start arm is treated as "another caller started it" — re-probe and attach if the head now
  exists. `--no-start` refuses instead of starting. `--seat <name|role>` attaches to a member
  instead of the head: by exact name, or by role (refuse on ambiguous role, never pick-first).
- **Edge Cases.** Head seat name collision with a standalone seat: refuse and report, do not
  attach to the standalone seat. Seat disappears between probe and attach: surface as "the
  head went away", not a raw WS error. Two concurrent `team attach` calls: the loser's
  duplicate-name error is absorbed into a re-probe (see Race Conditions).

### 3. Print the roster, then the address, then attach

- **Context.** Before the screen is handed over, the operator sees what came up and where the
  rest of it is:

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

- **Logic.** The detach line is the one that matters. Every multiplexer habit says detaching
  might have killed something; saying plainly that it did not, and where the work now lives,
  is what stops the operator re-attaching to check. The address comes from the board's own URL
  resolver, never a hardcoded `127.0.0.1`.
- **Implementation.** The `<board address>` is the resolved URL retrieved per the fact-3
  Superseded callout (state file written at startup, or `/board-url` endpoint). If the
  resolved URL is unavailable, the CLI *reports* that it cannot print a reachable address
  rather than substituting `127.0.0.1` — a missing resolved URL is a loud failure, not a quiet
  wrong answer (AGENTS.md fallback rule).
- **Edge Cases.** Tailnet disabled / resolver returns only loopback: print the loopback URL
  with an explicit "(loopback only — reachable from this machine, not another)" caveat so the
  operator is not misled into opening it from a laptop.

### 4. `switchboard team start <name>` and `switchboard team stop <name>`

- **Context.** The same resolution and the same reporting, without taking the screen. `start`
  is what a script or a scheduled job calls. `stop` closes the team's seats so the terminal
  front door is not a one-way street that always sends people back to the browser to shut
  things down.
- **Logic.** `start` resolves the team, applies the same state-table probe as `attach`, starts
  if no head exists, prints the roster. `stop` resolves the team, computes the same seat
  names `attach` computes (head + members via the naming convention), and closes each via
  `POST /terminals/verb/ptyCloseTerminal`.
- **Implementation.** Subcommands of `CmdTeam`. There is no `stopAgentGroup` verb; `stop` is a
  per-seat fan-out over `ptyCloseTerminal`. A seat name that does not resolve to a live seat of
  this team (collision or already gone) is skipped and named on stderr, not closed.
- **Edge Cases.** Closing a standalone seat whose name matched the convention would be
  destructive and irreversible (no confirm gate by codebase rule). The `parentInstanceId`
  chain check from change 2 is reused: only seats whose parent chains to the team's head (or
  the head itself) are closed. A shared member (`scope: 'shared'`) is closed only if no other
  live team references it — otherwise it is left and reported, because killing a shared
  researcher another team is using is the silent wrong answer this plan exists to avoid.

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
   — the rule at `KanbanProvider.ts:14478` is a security boundary, so it gets a test rather
   than a comment.
4. Assert the printed address is the resolved board URL and never `127.0.0.1` when a
   non-loopback address is available. A separate assertion covers the "resolved URL
   unavailable" path: the CLI reports the missing URL and does not substitute loopback.
5. Seat-mapping collision: a standalone seat named `Coding-coder-1` (no `parentInstanceId`
   chain to the team head) is not counted as a team member; `team attach` reports the
   collision on stderr and does not attach to the standalone seat.
6. `team stop` closes only seats whose `parentInstanceId` chains to the team head (or the head
   itself); a colliding standalone seat is skipped and named, not closed.
7. Regression: `test:contract:cli-attach`, `test:contract:pty-host-blackbox`, `go test ./cmd/...`.

### Goal Invariants

- From a fresh SSH session with nothing running, `switchboard team attach coding` ends with the
  operator typing to the lead and three members visible in the browser.
- Running it a second time attaches without starting anything, and creates no duplicate seat.
- Detaching leaves every seat running; `switchboard team list` afterwards shows the team up.
- A team that cannot be fully started reports which seats are missing instead of leaving a
  half-built team behind.
- The URL printed is one the operator can open from another machine; when no non-loopback URL
  is resolvable, the CLI says so plainly rather than printing a loopback URL as if it were
  reachable.
- A standalone seat whose name matches the team's naming convention is never attached to as
  the head and never closed by `team stop`.
