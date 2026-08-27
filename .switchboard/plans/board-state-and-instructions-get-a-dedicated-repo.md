# Board state and instructions get a dedicated repo — not the code repo, and never the control plane

## Goal

Add a **dedicated board repository** as a destination for board state, instructions
and receipts: a private repo that holds nothing else, so read access to board data
and write access to the command channel are governed by their own repo permissions.

Mechanically this is not a new mechanism. It is
`git-carried-shared-board-state.md`'s mechanism pointed at a different remote, and
it activates the `boardStateExport.remoteUrl` setting that already ships marked
*"Reserved… currently unused"* (`package.json:648`).

### Problem Analysis

**Only one destination is built today, and it is the code repo.**
`switchboard.boardStateExport` ships as `none | read-only-snapshot`
(`package.json:638`); `read-only-snapshot` publishes to the orphan branch
`switchboard/board` on the code repo's own remote. `control-plane` and `wiki` are
planned in `board-state-remote-mirror-channels.md` and unbuilt.

**Read access on a git repo is repo-wide, and includes non-human readers.** Every
collaborator sees the board, and so does every CI job, GitHub App and automation
token with `contents: read`. Branch rulesets cannot narrow this — they restrict
*writes* to a ref pattern, and read access has no ref granularity. Once
instructions ride the same destination, `contents: write` becomes the ability to
move someone's cards and dispatch their agents.

`git-carried-shared-board-state.md` accepts that trade deliberately for its own
use case — *"anyone with repo read access sees the board. That is the intended
trust model — it is the team's existing boundary"* — and it is right for a team
that wants a shared board with no infrastructure. It is the wrong default for a
command channel, and it should not be the only option.

### Why not the control plane — the rejection this plan reopens

`board-state-remote-mirror-channels.md` lists *"per-project dedicated private
companion repo"* under **Rejected alternatives**, superseded by extending the
control plane, on the grounds that the control plane already aggregates sibling
projects under one location. That premise does not survive contact with an inbound
command channel, for three reasons — the first of which is disqualifying on its
own.

**1. The control plane holds the definitions agents execute.** It collects
`personas`, `workflows` and `skills` across repos
(`ControlPlaneMigrationService.ts:873`), plus the `CLAUDE.md` managed block and
`.claude/` skills (`:722`) — the retention plan sizes it at roughly 744K of text.
Board state is *data about work*. Control-plane content is *the instructions
agents follow*.

Putting the command channel in the same repo means anyone who can file an
instruction can also rewrite a persona, a workflow, or a skill — for every project
that control plane serves. That is not a wider blast radius, it is a different and
larger capability: the narrow, allowlisted action set that makes the instruction
channel defensible becomes irrelevant when the same push can edit the prompt the
agent runs on. A closed allowlist is worthless beside an open door.

**2. Aggregation is the wrong shape here.** The control plane spans sibling
projects. One project's board state and command channel would land in a repo scoped
to all of them, coupling projects that have no reason to be coupled and making the
access decision for every one of them at once.

**3. Mirror-channels' own argument applies with more force.** That plan refuses to
default to `control-plane` because doing so *"would obligate it to become a git repo
with a configured remote and a background push loop the moment this feature ships —
a new infrastructure and network-activity commitment the user never asked for."*
That reasoning is stronger, not weaker, when the loop is also **inbound**: the
directory holding your agent definitions acquires a remote that other parties can
push to.

### Root Cause

The rejection was made while the channel was outbound-only. A read-only mirror in a
repo full of agent definitions is untidy; a command channel there is an escalation
path. The alternative was rejected against the wrong threat model.

### Non-goals

- **Changing `git-carried-shared-board-state.md`'s mechanism.** Its CAS retry loop,
  its intent log, its ingest path and its ref hygiene are unchanged. This plan
  supplies a remote, not a protocol. In particular this plan does **not**
  reintroduce a "one writer per repo" invariant or remove the force-push — an
  earlier draft did both and contradicted that plan.
- **Retiring `read-only-snapshot` or the orphan-ref destination.** They ship and
  they stay. A team that wants the board in the code repo keeps it.
- **Building `control-plane` or `wiki`.** Mirror-channels owns those; this plan
  neither requires nor blocks them.
- **Holding terminal logs.** Those go to the Archive store
  (`terminal-logs-are-archived-and-status-is-published.md`), for lifecycle reasons
  that have nothing to do with access.
- **Creating the repository, or handling credentials.** The user creates a private
  repo and supplies its URL; git uses the credentials it already has.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 4
**Tags:** security, backend, devops, infrastructure
**Feature:** 2440474a-cbe2-4876-b65d-3ccffd000aa3

## Dependencies

- **Composes with** `git-carried-shared-board-state.md` — that plan's publisher and
  ingest path gain a configurable remote. It is not a hard prerequisite for the
  outbound half (the shipped publisher already pushes; it just always pushes to
  `origin`), but the CAS loop should land before two machines share one board repo.
- **Required by** `board-control-instruction-format-and-executor.md` if the
  instruction channel is to be private. Without it, that channel's only available
  destination is the code repo.
- **Fits** `storage-topology-one-choice-three-stores.md`'s model as a *target*, not
  as an eleventh mechanism: the operator picks where the Board store lives, and a
  dedicated repo is one of the answers.

## Proposed Changes

### 1. A third value on a setting that already exists

`switchboard.boardStateExport` gains `board-repo`, alongside the shipped `none` and
`read-only-snapshot`. It requires `switchboard.boardStateExport.remoteUrl` — which
ships today as a documented placeholder and stops being reserved.

Adding a value rather than a mechanism is the point: nothing new is invented, and
the enum stays one setting rather than becoming two.

- `read-only-snapshot` → orphan ref `switchboard/board` on `origin` (today's
  behaviour, unchanged).
- `board-repo` → the same content on the default branch of `remoteUrl`.
- No URL with `board-repo` selected → publish nothing and say why. Never fall back
  to `origin`: a silent fallback to the code repo defeats the only reason to choose
  this value.

### 2. One layout, at the repo root

The dedicated repo holds, all at the root:

```
board.json  board.md  board.html      # BoardSnapshotPublisher's existing output
instructions/<id>.json                # inbound, from a remote author
receipts/<id>.json                    # outbound, the machine's answer
status.json                           # Runtime-safe activity, per the logs plan
```

This matches `BoardSnapshotPublisher`'s existing root-level layout rather than
mirror-channels' `control-plane` layout, which reuses that repo's `.switchboard/`
directory with `kanban-board.md` / `kanban-state-*.md`. Two destinations with two
layouts would force every reader — including the agent skill — to branch on
destination. One layout for the dedicated repo, and the orphan ref already uses it.

### 3. Say what choosing it means

In Setup, beside the destination choice, one line per option rather than a warning
buried in docs:

- **`read-only-snapshot`** — the board is visible to everyone who can read the code
  repo, including its CI and App tokens. Right for a team sharing a board; wrong if
  the board should be narrower than the code.
- **`board-repo`** — visibility and push access are that repo's own. Anyone you add
  to it can read the board, and (with the instruction channel enabled) move your
  cards.

Neither is a security claim about the mechanism; both are statements about who the
audience is, which is the only thing that actually differs.

### Migration

Additive. The shipped enum gains a value and keeps both existing ones with
unchanged meaning; `remoteUrl` gains a use and keeps its name. An install on `none`
or `read-only-snapshot` behaves identically until someone changes it. No content
format changes, so a repo already carrying a `switchboard/board` ref is unaffected.

## Verification Plan

1. **Existing behaviour preserved** — `none` publishes nothing; `read-only-snapshot`
   publishes to `switchboard/board` on `origin`, byte-identical to today. Assert
   against the current output, not against a description of it.
2. **No silent fallback** — `board-repo` with an empty `remoteUrl` publishes
   nothing, raises the reason once, and **never pushes to `origin`**. This is the
   assertion that stops the plan becoming a no-op.
3. **Layout** — a `board-repo` destination carries `board.json` and the three
   directories at the root; assert a reader needs no per-destination branching.
4. **The code repo is untouched under `board-repo`** — run publishes with the
   checkout dirty; assert no ref created or updated on `origin`, and branch, index
   and files unchanged.
5. **Instructions and receipts round-trip** — file an instruction into the
   dedicated repo, run a poll cycle, assert the action applied and the receipt
   published to the same repo.
6. **Control plane is never a destination** — assert by source text that no code
   path resolves a board-state or instruction path inside a control-plane root, and
   that `board-repo` cannot be pointed at one by configuration alone without it
   being an ordinary repo the user nominated. The rejection in this plan is the kind
   that gets quietly undone by a later convenience.
7. **CAS composes** — with `git-carried-shared-board-state.md` landed, two machines
   on one dedicated board repo: assert both moves land and a same-card conflict
   surfaces, exactly as that plan specifies. Assert this plan added no second
   arbitration path.
8. **Both hosts** — publish and ingest under the extension host and the standalone
   host.

### Goal Invariants

- Board state and instructions can live in a repo whose only contents are board
  state and instructions.
- No board-state or instruction path ever resolves inside a control plane.
- Choosing a destination never silently produces a different destination.
- `read-only-snapshot` installs are unaffected.
- One arbitration protocol, owned by the git-carried plan.
- One layout for a dedicated board repo, so no reader branches on destination.
