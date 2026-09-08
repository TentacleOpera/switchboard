# An Agent Seat Can Run Its CLI on Another Machine, Over SSH

kanbanColumn: CREATED

## Goal

A per-agent host setting in the Agents tab. When it is set, that seat's CLI runs on the named machine over SSH instead of locally. The PTY, the board and the database stay where they are.

### Problem analysis

**The operator wants the board on a low-power always-on machine and the CLI work on a bigger one.** A Raspberry Pi cabled to the modem serves the board well — measured 0.28 ms to the tower over the direct link, against 48 ms and 26 ms jitter over wifi — but it is not where compilation and repo-wide work belong. The tower has the cores and the checkout, and can be off when nothing needs it.

**Nothing in the config expresses this.** `agents.startupCommands` holds a per-role command — `lead: claude`, `coder: agy`, `planner: devin --permission-mode bypass` — and a repo-wide search finds no host, user or remote field anywhere in agent config. The command is *"an arbitrary shell line the host executes in the user's tree"*, typed into the seat's shell via `sendText`.

> **Superseded:** `ptyHost.ts:114-120` cited as the site where the command is typed into the seat's shell.
> **Reason:** `src/standalone/ptyHost.ts` is a retired 7-line compatibility stub that throws on call (`runPtyHost`); PTY ownership moved to the Go host `cmd/switchboard-pty-host/main.go`. The cited line range no longer exists.
> **Replaced with:** The startup command is resolved and injected in `src/standalone/ptyFleetService.ts` — `PtyFleetService.create` resolves the effective command (`:548-561`), derives `cliFamily` (`:562`), and `injectStartupCommand` (`:719-752`) types it into the seat via `handle.sendText(cmd, true)` (`:745`) after a readiness delay. The PTY process itself is spawned by `fleet.create` in `cmd/switchboard-pty-host/main.go:115-184` (`exec.Command(shell, "-l")`, `pty.StartWithSize`). The structured host field this plan adds must compose its SSH invocation into the string that reaches `sendText` at `ptyFleetService.ts:745`, BEFORE `deriveCliFamily` runs at `:562`.

So an SSH invocation already works if hand-written into the command; what is missing is a way to say it that is not a hand-written string.

**Why this is small.** Nothing about the architecture moves. The PTY still runs on the board host, the database is still local to it, only one host is live, and no shared store, sync lease or tier split is needed — those exist for two machines contending over one board, which this is not. The only thing that changes is where the process at the far end of the terminal lives.

**And it avoids the pty defect class on the far side.** A seat reached over SSH is still a terminal locally, so readiness and clear semantics still apply — but the remote CLI's own restarts, session boundaries and paste handling are the same as they are today. This does not make those problems worse; it just does not solve them.

## Metadata

- **Complexity:** 4
- **Tags:** cli, infrastructure, feature

## User Review Required

None.

## Complexity Audit

### Routine
- Adding a structured host/user/port/remote-cwd field beside the existing startup command in the Agents tab UI and its backing config stores.
- Composing an `ssh -tt <user>@<host> -p <port> -- 'cd <remoteCwd> && <startupCommand>'` string from structured fields — straightforward string composition with quoting.
- Surfacing the resolved host (and branch, per change 2a) in the fleet list / `ptyListTerminals` projection (`cmd/switchboard-pty-host/main.go:100-113` `project()`, `ptyFleetService.ts` `ExtendedTerminalHandle`).
- Defaulting the remote working directory to the local workspace path.

### Complex / Risky
- **CLI family misclassification of a wrapped command.** `deriveCliFamily` (`src/services/cliIdentity.ts:59`) takes `cmd.split(/\s+/)[0]` as the binary, so `ssh -tt … claude` reads as `ssh` → family `unknown`. Per the repo's own rule an unrecognised family takes the longest readiness ceiling, so the failure direction is slow dispatch rather than a dropped prompt — but the family must be re-derived from the *inner* command, not the wrapper, or every remote seat pays the worst-case readiness wait forever. This is the one design decision the composer has to get right.
- **Plan-path resolution on the remote disk.** The dispatch prompt today emits `Plan File: <absolutePath>` via `buildPromptDispatchContext` (`src/services/agentPromptBuilder.ts:600-614`); the seat is expected to read that path. On a remote seat the path points at the remote filesystem, where the plan does not live. Wiring the API channel (change 2b) is the load-bearing piece of the feature — without it the seat launches on the right machine and then reads the wrong (or no) plan.
- **Loud-failure discipline for an unreachable host.** The temptation to fall back to a local CLI is exactly the quiet-wrong-answer class the repo's fallback rule exists to prevent; the failure path must be guarded against regression.
- **Commit reachability across machines (change 5).** A named SHA is invisible across hosts; this adds a push/fetch clause to the head's prompt on top of the `75a2d809` trailer dependency.

## Edge-Case & Dependency Audit

1. **CLI family detection will not classify a wrapped command.** A seat's family is derived once at spawn and frozen (`d8f86774`), and `ssh -tt … claude` is unlikely to read as Claude. Per the repository's own rule an unrecognised family must take the **longest** readiness ceiling, so the failure direction is slow dispatch rather than a dropped prompt — but confirm that is what happens rather than assuming it. **Clarification (implied by this plan, not new scope):** the SSH composer should extract the inner CLI binary (the token after the `--` in the composed invocation) and feed *that* to `deriveCliFamily`, so a remote Claude seat is still recognised as `claude` rather than permanently classified `unknown`. This is strictly implied by "the seat's CLI runs on the named machine" — the CLI is Claude, not ssh.
2. **Plan paths must resolve on the target.** Dispatch hands an agent an absolute path to a plan file that lives with the board. On a remote seat that path resolves to whatever is at the same location on the target — possibly a stale copy, possibly nothing, and neither errors. **Decided in change 2b: the API, not the filesystem.** The mount and shared-checkout options are rejected — plans are not code, they live in a different repository under the canonical layout, and two synchronised copies is the replication problem this product has already declined. This remains the part most likely to be discovered late and the reason the feature is not complete without it.
3. **Authentication is the operator's.** Key-based SSH, configured outside Switchboard. Do not build a credential manager, do not prompt for passwords, and fail with a clear message when the key is not accepted.
4. **The remote CLI holds the agent's credentials**, not the board host. Worth stating in the setting's description so it is a deliberate choice.
5. **Both hosts** compose startup commands and must produce the same invocation.
6. **Waking the target is out of scope**, but adjacent: an always-on board host can wake a sleeping worker over Wake-on-LAN. Worth its own card if wanted; it is not needed for this to work.

## Dependencies

- `75a2d809` — *A Team Commits Once, And The Reviewer Reviews That Commit*. Supplies the plan↔commit trailers and the reviewer's named review unit. Change 5 adds one reachability clause on top and depends on the rest of it.
- `canonical-control-plane-layout-with-sibling-repos` — establishes that plans live in a sibling repository rather than the code checkout, which is why a worker has no plans directory to synchronise.

## Adversarial Synthesis

Key risks: (1) the dispatch prompt hands a remote seat a filesystem path it cannot read — change 2b must rewire `buildPromptDispatchContext` (`agentPromptBuilder.ts:600`) to either embed the plan body or emit an API-fetch directive for remote seats, or the seat launches correctly and then works blind; (2) `deriveCliFamily` classifies every SSH-wrapped command as `unknown`, silently imposing the worst-case readiness ceiling on every remote seat — the composer must re-derive family from the inner binary; (3) the host field has three config homes (per-role `agents.startupCommands`, per-instance `customAgents[].startupCommand`, per-delegate `delegates[].startupCommand`) and the plan must say which it touches or the setting will exist for some seats and not others. Mitigations: name `buildPromptDispatchContext` and `cliIdentity.ts:59` as concrete touch points; add a loud-failure guard with no local fallback; resolve the config-home question up front.

## Proposed Changes

### 1. A host field per agent in the Agents tab

Alongside the existing startup command: a target the seat runs on. Empty means local, which is every seat today and stays the default.

**A structured field, not a command prefix.** Let the operator name a host (and where needed a user, port and remote working directory); Switchboard composes the SSH invocation. A free-text prefix box would be quicker to build and would be a command-injection surface, a quoting minefield, and impossible to validate.

**Clarification (implied by existing config shape, not new scope):** the startup command today lives in THREE stores — the per-role global map `agents.startupCommands[role]` (`GlobalIntegrationConfigService.ts:29-33`, read by `getAgentStartupCommands` at `:464`), the per-instance `customAgents[].startupCommand` (`agentConfig.ts:100-109`), and the per-delegate `delegates[].startupCommand` (`agentConfig.ts:3-12`). A host field must be added in parallel to whichever of these the operator expects to remote; minimum viable is the per-role map (covers built-in lead/coder/planner) plus `customAgents[]` (covers named custom seats). Delegates inherit from their definition, so `DelegateDefinition` gains the field too. The composed SSH string is built in `PtyFleetService.create` (`ptyFleetService.ts:548-562`) right before `deriveCliFamily` runs, so the family sees the inner CLI, not `ssh`.

### 2. The remote working directory is explicit

The repository path on the target need not match the local one. The composed command changes directory before launching the CLI, using a value the operator sets rather than an assumption that both machines are laid out identically.

Default it to the same path as the local workspace, since that is the common case, but make it visible and editable — a silently assumed path that happens to exist on the target is the worst outcome.

### 2a. The checkout on the target is a precondition, and it is checked

Change 2 makes the remote path explicit and stops there — nothing clones
it, pulls it, checks its branch, or notices it is mid-conflict. An agent is
`cd`'d into a directory and starts coding. A stale checkout does not error; it
produces a plausible diff against the wrong base.

**Check, do not provision.** Before the CLI launches, assert the remote path is a
git repository and report its branch and whether the tree is clean. If it is not a
repo, fail the way change 3 fails an unreachable host — loudly, with no local
fallback. Switchboard does not clone for the operator, does not pull, and does not
switch branches: those are decisions with consequences on a machine the operator
may be using for something else. It reports, and the operator fixes it once.

Surface the branch alongside the host in the fleet (change 4), because "which
machine" and "which branch" are the same question when the answer is wrong.

### 2b. A plan reaches a remote seat over the API, never as a path

Audit item 2 below names this and leaves the resolution open between a mount, a
shared checkout and the dispatch carrying the body. **It is the API**, and the two
filesystem options should not be built.

Plans are not code. Under the canonical control-plane layout they are not even in
the code repository — `Switchboard-plans/` is a sibling — so a worker that clones
the code repo has no plans directory and should not be given one. Two synchronised
plan directories is bidirectional replication of a mutable document store, which
is the distributed-state problem this product has already declined twice (libSQL,
Turso), and its failure mode is not hypothetical: on 2026-09-07 ten board rows
carried a `plan_file` that existed on one machine only, rendering as `missing`
everywhere else, and two were lost outright.

So plan content travels over HTTP, which every seat already uses:

- **Inbound** — the dispatch carries the body, or the seat reads
  `GET /kanban/plan?planId=` (`.data.content`).
- **Outbound** — `POST /kanban/plans` for a new plan, plus the completion,
  complexity, priority and feature endpoints that already exist.

**This is the channel that must not be reverse SSH.** A worker writing back over
SSH would need a key *into the board host* — the machine holding the database and
every plan — inverting the one-way trust this feature is built on (the board host
shells into workers, never the reverse). The seat must already reach the API to
post completion, so the route and its credentials exist; a second channel earns
nothing and grants a shell.

**The concrete consequence for reviewers.** Reviewer findings are written as one
plan file per finding into `.switchboard/plans/`. On a remote seat that is the
wrong disk and the finding is lost exactly as the two features above were. That
path becomes `POST /kanban/plans` — which is better regardless, since it routes
through the importer and gets a DB-assigned planId, project stamping and column
resolution rather than a raw file.

**Concrete touch point (Clarification, implied by the existing dispatch path):**
`buildPromptDispatchContext` (`src/services/agentPromptBuilder.ts:600-614`) today emits `Plan File: <absolutePath>` and `PLAN_ID=<id>` — a filesystem path the seat is expected to read. For a remote seat that path is on the wrong disk. The fix is one of:
- **(a) Embed the body** — for a seat whose resolved host is non-empty, replace `Plan File: <path>` with the plan content read via the existing `GET /kanban/plan?planId=` path on the board host, inlined into the prompt; OR
- **(b) Emit an API-fetch directive** — keep `PLAN_ID=<id>` and append `Fetch the plan body from GET http://<boardHost>:<port>/kanban/plan?planId=<id> (.data.content); do not read the path locally.`

Option (b) is smaller and keeps prompt size bounded for large plans; option (a) is robust when the remote seat cannot reach the API (which would also break completion POST, so (a) only helps if the operator misconfigured reachability — a loud failure is preferable there). Recommend (b), with the board host and port already known to the seat via `SWITCHBOARD_API_TOKEN` and the dispatch context. The outbound path (reviewer findings → `POST /kanban/plans`) is already correct and needs no prompt change beyond ensuring the seat uses the API, not a local write.

### 3. An unreachable host fails loudly

If SSH cannot connect, the seat must report that and stop. It must not fall back to running the CLI locally.

A silent local fallback would run the agent on the wrong machine, against the wrong checkout, with everything appearing to work — the exact class of quiet wrong answer the repository's fallback rule exists to prevent. Where the seat is running is a fact the board must be able to state, not infer.

### 4. Say which machine a seat is on

The seat's identity now includes its host. Show it where seats are listed, so an operator looking at the fleet can tell local from remote without opening a terminal. The projection lives in `cmd/switchboard-pty-host/main.go:100-113` (`project()`) and `ptyFleetService.ts` `ExtendedTerminalHandle`; both gain a `host` field surfaced through `ptyListTerminals`.

### 5. A remote seat's commit must be reachable, not merely named

**No new mechanism — a dependency and one clause.** The plan↔commit association
already belongs to *A Team Commits Once, And The Reviewer Reviews That Commit*
(`75a2d809`): the head's commit carries the stage and plan ids as **git trailers**,
and *The Reviewer Is Never Told What To Review* resolves them and names the commit
in the reviewer's prompt. That is the right home for it and it crosses machines by
construction — a trailer travels with the commit, where a database column would
not. This plan depends on it and re-solves none of it.

What SSH adds is that **identified is not the same as reachable**. Locally the
reviewer shares a clone, so a named SHA is a resolvable object. Split the coder and
reviewer across machines and the SHA is correct, findable and invisible: `git show`
fails, and the reviewer has nothing.

So when a seat is remote, its commit must be pushed — or the reviewer must fetch
from the worker. One clause in the head's prompt, on the same path that already
tells it to commit the body. Nothing gates the completion POST: a refusal keyed on
a missing SHA would fire on every non-git seat and every workspace with no remote,
and the reviewer prompt already degrades to today's text when no commit resolves.

`the-reviewer-is-never-told-what-to-review.md` mentions push and fetch **zero**
times, so this clause has no owner today.

**Uncommitted work is the sharper form of the same problem.** Today a coder that
forgets to commit is recoverable: the reviewer shares the tree and the operator can
see it. Across machines it is invisible to everyone while the card advances on the
seat's word — `composeCompletionEvidence`

> **Superseded:** `composeCompletionEvidence` cited at `PlanIngestionEngine.ts:2378`.
> **Reason:** The function moved; it is now at `src/services/PlanIngestionEngine.ts:3060-3089`. The line number drifted with file growth; the substance of the claim is unchanged.
> **Replaced with:** `composeCompletionEvidence` (`PlanIngestionEngine.ts:3060`) carries `topic`, `kanbanColumn`, `featureId`, and `dispatchedAt` — and no SHA, diff, or file list. The no-SHA observation stands; only the citation was stale.

(`PlanIngestionEngine.ts:3060`) carries
topic, column, feature and duration, and no SHA, diff or file list. This does not
add an enforcement gate; it records that SSH promotes committing from good practice
to a hard requirement of the architecture, which is a reason to depend on
`75a2d809` rather than to ship without it.

## Verification Plan

1. A seat with a host set runs its CLI on that machine; the PTY, board and database stay local.
2. A seat with no host set behaves exactly as it does today.
3. An unreachable host reports the failure and does not start a local CLI.
4. A remote working directory different from the local one is honoured.
5. Prompt delivery, clear and completion reporting work against a remote seat.
6. The fleet shows which machine each seat is on.
7. A plan dispatched to a remote seat is readable by that seat, per the change decided in audit item 2.
8. Both hosts compose the same invocation for the same settings.
9. A remote path that is not a git repository fails the dispatch loudly, names the
   path and the host, and starts no local CLI.
10. The fleet shows the branch a remote seat's checkout is on, and a seat on the
    wrong branch is visible without opening a terminal.
11. A remote reviewer files a finding and the plan lands on the **board host**, with
    a DB-assigned planId and the project stamped — assert nothing was written to the
    worker's disk.
12. No plan file is read from, or written to, the worker's filesystem on any path.
13. A remote seat's commit is reachable by the reviewer: fetch and `git show` the
    SHA named in the reviewer's prompt, from the reviewing machine.
14. With no commit resolvable, the reviewer prompt degrades to today's text and the
    dispatch still succeeds — assert no completion is refused for a missing SHA.
15. A remote Claude seat's CLI family resolves to `claude` (not `unknown`), so it
    receives the Claude readiness ceiling rather than the worst-case wait — assert
    `deriveCliFamily` sees the inner binary, not `ssh`.

### Goal Invariants
- Assert `ExtendedTerminalHandle` for a seat with a non-empty host carries a `host` value equal to the configured host, and a seat with no host carries an empty/absent `host`.
- Assert `PtyFleetService.create` composes an `ssh -tt` invocation when host is set, and passes the bare startup command (no `ssh` prefix) when host is empty.
- Assert `deriveCliFamily` is called with the inner CLI binary (e.g. `claude`), not the wrapper (`ssh`), for a remote seat whose startup command is `claude`.
- Assert `buildPromptDispatchContext` emits no local `Plan File: <absolutePath>` line for a seat whose resolved host is non-empty (the API-fetch directive replaces it).
- Assert no code path writes a plan file to the worker's filesystem when the seat is remote; reviewer findings route through `POST /kanban/plans`.
- Assert an unreachable host produces a failure result with no spawned local CLI process (count of locally-spawned agent CLIs does not increase).
