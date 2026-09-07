# An Agent Seat Can Run Its CLI on Another Machine, Over SSH

kanbanColumn: CREATED

## Goal

A per-agent host setting in the Agents tab. When it is set, that seat's CLI runs on the named machine over SSH instead of locally. The PTY, the board and the database stay where they are.

### Problem analysis

**The operator wants the board on a low-power always-on machine and the CLI work on a bigger one.** A Raspberry Pi cabled to the modem serves the board well — measured 0.28 ms to the tower over the direct link, against 48 ms and 26 ms jitter over wifi — but it is not where compilation and repo-wide work belong. The tower has the cores and the checkout, and can be off when nothing needs it.

**Nothing in the config expresses this.** `agents.startupCommands` holds a per-role command — `lead: claude`, `coder: agy`, `planner: devin --permission-mode bypass` — and a repo-wide search finds no host, user or remote field anywhere in agent config. The command is *"an arbitrary shell line the host executes in the user's tree"* (`ptyHost.ts:114-120`), typed into the seat's shell via `sendText`. So an SSH invocation already works if hand-written into the command; what is missing is a way to say it that is not a hand-written string.

**Why this is small.** Nothing about the architecture moves. The PTY still runs on the board host, the database is still local to it, only one host is live, and no shared store, sync lease or tier split is needed — those exist for two machines contending over one board, which this is not. The only thing that changes is where the process at the far end of the terminal lives.

**And it avoids the pty defect class on the far side.** A seat reached over SSH is still a terminal locally, so readiness and clear semantics still apply — but the remote CLI's own restarts, session boundaries and paste handling are the same as they are today. This does not make those problems worse; it just does not solve them.

## Metadata

- **Complexity:** 4
- **Tags:** agents, config, remote, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. A host field per agent in the Agents tab

Alongside the existing startup command: a target the seat runs on. Empty means local, which is every seat today and stays the default.

**A structured field, not a command prefix.** Let the operator name a host (and where needed a user, port and remote working directory); Switchboard composes the SSH invocation. A free-text prefix box would be quicker to build and would be a command-injection surface, a quoting minefield, and impossible to validate.

### 2. The remote working directory is explicit

The repository path on the target need not match the local one. The composed command changes directory before launching the CLI, using a value the operator sets rather than an assumption that both machines are laid out identically.

Default it to the same path as the local workspace, since that is the common case, but make it visible and editable — a silently assumed path that happens to exist on the target is the worst outcome.

### 2a. The checkout on the target is a precondition, and it is checked

Change 2 makes the remote path explicit and stops there — nothing clones it, pulls
it, checks its branch, or notices it is mid-conflict. An agent is `cd`'d into a
directory and starts coding. A stale checkout does not error; it produces a
plausible diff against the wrong base.

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

### 3. An unreachable host fails loudly

If SSH cannot connect, the seat must report that and stop. It must not fall back to running the CLI locally.

A silent local fallback would run the agent on the wrong machine, against the wrong checkout, with everything appearing to work — the exact class of quiet wrong answer the repository's fallback rule exists to prevent. Where the seat is running is a fact the board must be able to state, not infer.

### 4. Say which machine a seat is on

The seat's identity now includes its host. Show it where seats are listed, so an operator looking at the fleet can tell local from remote without opening a terminal.

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
seat's word — `composeCompletionEvidence` (`PlanIngestionEngine.ts:2378`) carries
topic, column, feature and duration, and no SHA, diff or file list. This does not
add an enforcement gate; it records that SSH promotes committing from good practice
to a hard requirement of the architecture, which is a reason to depend on
`75a2d809` rather than to ship without it.

## Dependencies

- `75a2d809` — *A Team Commits Once, And The Reviewer Reviews That Commit*. Supplies
  the plan↔commit trailers and the reviewer's named review unit. Change 5 adds one
  reachability clause on top and depends on the rest of it.
- `canonical-control-plane-layout-with-sibling-repos` — establishes that plans live
  in a sibling repository rather than the code checkout, which is why a worker has
  no plans directory to synchronise.

## Edge-Case & Dependency Audit

1. **CLI family detection will not classify a wrapped command.** A seat's family is derived once at spawn and frozen (`d8f86774`), and `ssh -tt … claude` is unlikely to read as Claude. Per the repository's own rule an unrecognised family must take the **longest** readiness ceiling, so the failure direction is slow dispatch rather than a dropped prompt — but confirm that is what happens rather than assuming it.
2. **Plan paths must resolve on the target.** Dispatch hands an agent an absolute path to a plan file that lives with the board. On a remote seat that path resolves to whatever is at the same location on the target — possibly a stale copy, possibly nothing, and neither errors. **Decided in change 2b: the API, not the filesystem.** The mount and shared-checkout options are rejected — plans are not code, they live in a different repository under the canonical layout, and two synchronised copies is the replication problem this product has already declined. This remains the part most likely to be discovered late and the reason the feature is not complete without it.
3. **Authentication is the operator's.** Key-based SSH, configured outside Switchboard. Do not build a credential manager, do not prompt for passwords, and fail with a clear message when the key is not accepted.
4. **The remote CLI holds the agent's credentials**, not the board host. Worth stating in the setting's description so it is a deliberate choice.
5. **Both hosts** compose startup commands and must produce the same invocation.
6. **Waking the target is out of scope**, but adjacent: an always-on board host can wake a sleeping worker over Wake-on-LAN. Worth its own card if wanted; it is not needed for this to work.

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
