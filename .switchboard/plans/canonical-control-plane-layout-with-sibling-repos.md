# The canonical layout: a control plane containing one sibling per purpose

<!-- board-collapse-audit -->
> **REDIRECT 2026-09-04 (Board Collapse audit).** This plan names `backups-that-can-actually-be-restored.md` twice. That plan has been **merged into `board-backup-and-per-project-export.md` and deleted**; the surviving plan carries its definition of a backup as a verified set of database, plan files and manifest. Read both references as pointing there.
> > 
> > **2026-09-07:** both backup references above are moot — the `-backups` sibling is gone (see the supersession in change 2) because `9c367927` deletes backup entirely.
> > 
> > Note also that this plan is now **parked in Backlog** behind the storage programme's first step, as are the plans that depend on its `controlPlaneRoot`.


## Goal

Define the layout Switchboard should guide users toward, and make setup create and
link it: a **control plane folder that agents start in**, containing the code repo
and one sibling per purpose — plans and board state, remote control, cloud
instructions, logs — each separately permissioned.

Then derive every path from the control plane root, so the operator makes one
choice and never types five paths. And degrade cleanly, because most users will
have something else.

### The layout

```
Switchboard-Agents/          ← control plane. Agents start here.
│                              Holds personas, workflows, skills, rules.
│                              Holds NO board data.
├── Switchboard/             ← code repo                 (own git)
├── Switchboard-plans/       ← plans + board state       (own git)
├── Switchboard-remote/      ← instructions + receipts   (own git)
└── Switchboard-logs/        ← terminal logs             (plain folder, or a repo)
```

Naming convention: `<code-repo-name>-<purpose>`, so setup can propose names and a
human reading a directory listing can tell what everything is.

**Three data siblings, not four.** `-remote` is the instructions channel — the
name is the user's, and there is one such channel, not a separate `-cloud`. A
cloud session and any other remote author file into the same place; who may do so
is a question about that repo's collaborators, not about having a repo each.

**Linear and Notion are not siblings, and this is the part that could easily have
been got wrong.** That path is not a git channel at all: `RemoteControlService`
is constructed in-process (`KanbanProvider.ts:2730`) and polls the provider's API
on a timer. It needs no repo, no folder and no clone — so it appears nowhere in
this layout, and the layout must not grow a folder for it. Two remote-control
paths exist and they are separated by *mechanism*: git-carried instructions get a
sibling; tracker sync gets a service.

One consequence worth checking during implementation rather than assuming:
`_getRemoteControl` is keyed per **workspace root** (`:2726`). Under this layout,
"Linear interfaces with the control plane" implies one sync rooted at the control
plane across sibling projects rather than one per project. That is a small change
in where the service is keyed, and it is a behaviour change for anyone running
several mapped workspaces today.

### Problem Analysis

**This resolves the control-plane objection structurally rather than by
exception.** The control plane collects the `personas`, `workflows` and `skills`
agents execute (`ControlPlaneMigrationService.ts:873`) plus the `CLAUDE.md`
managed block and `.claude/` skills (`:722`). Board data must not share a repo
with those, because a write channel there could rewrite the prompt an agent runs
on — no action allowlist survives that.

The layout makes the control plane a **container** of separately-permissioned
repos rather than a repo that holds data. The definitions and the data an agent
acts on become siblings, not co-tenants. Nothing needs an exception because
nothing shares a boundary.

**This supersedes mirror-channels' `control-plane` destination.**
`board-state-remote-mirror-channels.md` §2 has the mirror pushed *into* the
control plane's own `.switchboard/` — *"reuses the control plane's existing
`.switchboard/` location… no new subfolder"*. That is the shape being ruled out.
The rest of that plan stands: `GitStateProvider`, the cursor, the trust guard, the
`wiki` option, and the §5 pull are unaffected. Only the destination changes, from
*the control plane* to *a sibling of it*.

**One purpose per sibling means one grant per purpose.** That is the property
worth the extra folders:

| Party | code | plans | remote | logs |
|---|---|---|---|---|
| the user's machine | write | write | **read** | write |
| a cloud / remote author | — | read | **write** | — |
| a teammate reviewing code | write | — | — | — |
| CI on the code repo | write | — | — | — |

No row is "everything", which is what a branch or a shared repo forces. A
compromised remote credential can file instructions and cannot read the code, edit
plans, or forge a receipt — because receipts are written by the machine into
`-plans`, which the remote author only reads.

Linear/Notion sync holds no row: it reaches the board through the in-process
service, not through any of these.

**Most of the machinery already exists.** This is a layout and a setup flow, not
new plumbing:

- `switchboard.kanban.controlPlaneRoot` ships (`package.json:490`) — *"Explicit
  Control Plane folder override."*
- A **configured plan folder watcher** already exists
  (`TaskViewerProvider.ts:16975`), with a mirror→source sync and echo guards
  (`_recentSourceWrites`), so plans outside the code repo are already watched.
- `ControlPlaneMigrationService` already generates `.gitignore` content and
  reasons about nested repos; mirror-channels §2 already specified excluding
  managed project subdirectories by name.
- `BoardSnapshotPublisher` already produces `board.json` / `.md` / `.html`.

> **Superseded 2026-09-07:** this plan carried a `-backups` sibling and a case for
> it ("*backups currently live inside the thing they back up*" — `dbbackup/` and
> `kanban-state-backup.json` writing inside the code checkout).
> **Reason:** Switchboard no longer backs up at all. *The Board Takes an Hourly
> Backup Nobody Asked For, Onto the Same Disk, With No Way to Turn It Off*
> (`9c367927`) deletes every backup mechanism, on the position that backup is the
> wrong layer for this product and is already handled by system-managed backup.
> A sibling for an artefact that is being removed is work on a deleted feature.
> **Replaced with:** four siblings, not five. The recovery story the backups
> sibling was reaching for is now served by the plans sibling being a real git
> repo that commits every operation (change 3a) — history and restore come from
> git, which is the tool that already does this well.

**On storing plans as database entries.** Worth doing for *history*, not as the
medium for *current*. The line, and the reason:

- **A plan's job is to be recoverable without the tool that wrote it.** A plan
  `.md` is recoverable with `cp` and readable by a human in ten years. A row is
  recoverable only by code that still understands the schema, which is exactly the
  code you may be recovering *from*.
- **Plan identity keys on the file path today.** The importer assigns the id and
  keys identity by path — plan bodies carry no id line, and one written there is
  never parsed. So a plan that exists only as a row has no identity under the
  current model; making rows primary is a change to the identity model, not a
  storage choice.
- **Where rows genuinely win is revision history.** One row per revision with a
  version and a content hash gives "what did this plan say last Tuesday" cheaply,
  which files cannot without a file per revision. There is precedent in the
  direction already: the scaffold work moves control-plane definitions into the
  store as bodies with a version and content hash per row.

So the rule: **the plans sibling keeps plan files as files, and a revision
database beside them is additive.** A database may be the only copy of history; it
must never be the only copy of current. Building that revision store is a separate,
optional plan — not folded in here, because it has its own schema, its own growth
profile, and its own recovery story.

And this is what change 3a rests on: if the plan file is the medium of record,
then losing one is losing the work, which is why the sibling commits every write
rather than waiting for something else to notice.

**Logs do not need to be a repo, and that is a feature.** A plain folder has no
history, so retention is deleting files and long retention costs nothing but disk.
A git repo is the opt-in for the case where logs should be *shared*, and it brings
monotonic history with it. Default to the folder.

**And the layout must be a recommendation, not a requirement.** Most existing
users have plans in the code repo and no control plane. The work is to make the
canonical setup easy and one click away, and to make every partial arrangement
keep working.

### Root Cause

Placement was decided per-feature — a path setting here, an export destination
there — so there was no shape to guide anyone toward, and each new need produced
another setting. The storage topology plan diagnosed this ("ten answers to where
does my data live"); this plan supplies the answer for the git-carried side.

### Non-goals

- **Forcing the layout, or moving anyone's files without being asked.**
- **The control plane holding board data.** Ever.
- **Retiring `read-only-snapshot`** or the orphan-ref destination. They ship and
  they stay for users who want the board in the code repo.
- **New watching, syncing or publishing machinery.** Existing components gain a
  derived path.
- **The arbitration protocol** — `git-carried-shared-board-state.md` owns CAS, the
  intent log and ref hygiene. This supplies remotes, not a protocol.
- **Creating remote repositories, or handling credentials.** Setup can `git init`
  and `git remote add` locally; the user creates the remotes and supplies URLs.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 6
**Tags:** infrastructure, devops, backend, ux, security
**Feature:** 2440474a-cbe2-4876-b65d-3ccffd000aa3

## Dependencies

- **Composes with** `git-carried-shared-board-state.md` (its publisher and ingest
  path gain a derived remote) and `board-state-remote-mirror-channels.md` (whose
  `GitStateProvider` reads a sibling instead of the control plane).
- **Required by** `board-control-instruction-format-and-executor.md` for a
  private channel and `terminal-logs-live-in-the-logs-sibling.md` for the logs
  location.

## Proposed Changes

### 1. One choice, four derived paths

The operator picks the **control plane root**. Everything else derives by
convention — which is exactly the storage topology plan's model ("*a target, not a
path*", and "*derive Archive placement from the target*"), applied here.

```
controlPlaneRoot/<codeRepoName>-plans      → plans + board state
controlPlaneRoot/<codeRepoName>-remote     → instructions + receipts
controlPlaneRoot/<codeRepoName>-logs       → logs
```

Per-purpose overrides exist behind an advanced surface, for the operator who
disagrees, with a stated support posture — again the topology plan's pattern
(custom paths preserved as overrides rather than moved).

**This is what stops the enum sprawl.** Rather than one `boardStateExport` value
per destination, the setting gains **one** value meaning "use the canonical
siblings" alongside the shipped `none` and `read-only-snapshot`. Four plans
currently propose four different value sets for that setting (shipped is
`none | read-only-snapshot`; mirror-channels drops a shipped value; git-carried
adds a bidirectional mode). Reconciling them is a decision this plan should carry
to the topology plan rather than resolve unilaterally — flagged, not silently
picked.

### 2. Guided setup

In Setup, a **Canonical layout** panel that detects, proposes and creates:

- **Detect** — is the workspace's parent a control plane? Which siblings exist?
  Which are git repos with remotes?
- **Propose** — show the layout with what is present, missing, and would be
  created, using derived names the user can edit.
- **Create, only when asked** — `mkdir`, `git init`, `git remote add` for the data
  siblings; a plain folder for logs; the managed-subdirectory `.gitignore` in the
  control plane so a stray `git add .` there can never stage a nested repo.
- **Explain the grants** — render the access table above with the user's real
  names in it. This is the part that makes the layout worth adopting rather than
  merely tidy.

Nothing is created, initialised, or given a remote without an explicit action.
Mirror-channels' rule holds and generalises: turning on remote behaviour is never
inferred.

### 3. Plans move only if asked, and never by moving

Plans in the code repo keep working — the configured plan folder watcher already
handles a plans directory elsewhere, so this is configuration, not new code.

When a user opts to relocate: **copy, verify, then leave the originals in place**
until they confirm. Per project rules, state that shipped is migrated rather than
unlinked, and plan files are user content — the most valuable content in the
system. A relocation that moves 2,000 plan files and half-fails is unrecoverable;
one that copies is not.

### 3a. The plans sibling commits itself, on every atomic operation

`Switchboard-plans/` **auto-commits**. Writing a plan, improving a plan and
deleting a plan are each one complete unit of work, so each is one commit — made
by the repo, not by whoever wrote the file.

**This is the change that makes the sibling worth having.** A dedicated repo that
nothing commits to loses files exactly the way `.switchboard/plans/` does today.
Observed 2026-09-07: ten board rows carried a `plan_file` that existed only in
one machine's working tree. On every other machine the watcher resolved the path
to nothing and set `status='missing'`, which drops the card from the board while
its subtasks stay active — an orphaned feature with visible children and no
parent. Eight were recovered off the Pi; two (`94122291`, `d723cc0c`) were not
found on any machine and their hand-written content is gone.

The mechanism behind that loss is that **nothing commits board state
deliberately**. Plan and feature files reach git only when an agent happens to
commit *code* while they sit in its tree — every commit touching
`.switchboard/features/` also carries `src/` changes. So survival is a
coincidence: a card that gets dispatched has its file swept up by the coder's
commit; a card that sits in PLAN REVIEWED never does. Two features created in the
*same second* went different ways on exactly that.

**Do not fix this by asking agents to commit.** That is the failure mode already
on the board: `agent-commits-sweep-the-whole-shared-tree` exists because a
coder's `git add -A` swept a peer's unfinished work into commit `226b7f09`. An
agent instruction is a rule that has to be delivered, retained across a clear,
and obeyed; the loss above happened on a machine whose planner is *prohibited*
from git (`roleConfig_planner` carries `gitProhibition: true` and no
`gitCommitStrategy`). Auto-commit needs none of that — no role learns a git verb,
and it behaves the same on every host and every machine.

**Hang it off the watcher that already fires.** The plan watcher already observes
create, change and delete in this directory — it is what imports a plan and hard-
deletes its row when the file goes away. The commit rides that existing event, so
the operation is known at the point it fires and the message needs no author:

```
plan: add <title>
plan: improve <title>
plan: delete <title>
```

**Why this is safe here and not in the code repo.** Every objection to committing
plans is an objection to committing them *into a code review*: diff noise, a
peer's half-finished work, an unrelated tree swept in. A sibling repo has no code
in it, so a commit per plan costs nothing and reviews nothing. This is the payoff
that justifies the split, not merely a tidier directory listing.

**A deletion becomes recoverable.** Today a removed plan file is unrecoverable —
the two lost features above are not in any commit, any branch, or any loose
object, so there is nothing to restore. Under auto-commit a delete is a commit,
and the content is one `git show` away.

Scope: commits only. Pushing is a separate question and is not assumed here — a
committed file already survives a clean tree and a machine handoff via git, which
is the failure this addresses.

### 4. Degradation is the common case

Every sibling is independent. Absent means that capability is off, with a
one-line reason where the user would look for it — never a broken state and never
a silent one:

- no `-plans` → plans and board state stay where they are;
- no `-remote` → the instruction channel is unavailable; Linear/Notion sync is
  unaffected, since it never used a sibling;
- no `-logs` → logs stay in `.switchboard/logs/`, as today;
- no control plane at all → everything behaves exactly as it does now.

### Migration

Additive. `controlPlaneRoot` keeps its meaning; `read-only-snapshot` keeps its
behaviour; no file moves without an explicit action; no default changes. An
install that ignores this panel is unaffected.

## Verification Plan

1. **Detection** — a workspace whose parent contains all four siblings is
   recognised; one with none is recognised as unconfigured; a partial arrangement
   reports exactly which pieces are present.
2. **Derivation** — with only the control plane root set, all four paths resolve by
   convention; an override redirects one without affecting the others.
3. **Nothing is created unasked** — run detection on a bare parent folder and
   assert no `mkdir`, no `git init`, no `git remote add`, and no network call.
4. **The control plane holds no board data** — after a full setup and a publish
   cycle, assert no `board.json`, `instructions/`, `receipts/`, `status.json`, or
   log file exists anywhere under the control plane root **outside** the siblings.
   This is the invariant the whole layout exists for, and the one a later
   convenience will erode.
4a. **Tracker sync needs no sibling** — with `-remote` absent entirely, assert
    Linear/Notion remote control still starts, polls and applies deltas. The two
    remote paths must not have been accidentally coupled through the layout.
5. **The `.gitignore` guard** — `git add .` in the control plane stages no nested
   repo's content and no gitlink.
6. **Plans from a sibling** — plans in `-plans` are watched, imported, and
   round-trip through the mirror→source sync with no echo loop.
7. **Relocation is a copy** — opting to relocate leaves the originals in place and
   verifies every file arrived before reporting success; a mid-way failure leaves
   both sides readable.
8. **Board state to `-plans`** — a publish lands there, not on `origin` and not in
   the control plane.
9. **Logs as a folder** — logs work with `-logs` as a plain non-git folder; assert
   no git command is run against it. Then as a repo, and assert it is opt-in.
10. **Degradation** — remove each sibling in turn; assert the matching capability
    reports unavailable with a reason, and that the board keeps working.
11. **Both hosts** — detection, derivation and publishing under the extension host
    and the standalone host.
12. **Every atomic plan operation is one commit** — write a plan, improve it, then
   delete it, and assert the plans sibling gained exactly three commits naming
   those operations. No agent was given a git instruction in any of the three.
13. **A deleted plan is recoverable** — after the delete in 12, `git show` returns
   the file's last content. This is the check the 2026-09-07 loss would have
   failed.
14. **A second machine sees no `missing` rows** — author a plan on machine A, let
   the auto-commit land, sync, and assert machine B resolves the `plan_file` and
   the card renders. Then assert the reverse of the observed bug: no row in the
   shared database has `status='missing'` while its file exists in the sibling.
15. **The code repo is untouched** — after the three operations in 12, `git status`
   in the code repo is unchanged and its log gained no commit.


### Goal Invariants

- The operator sets one path; the rest are derived.
- No plan exists only as a database row.
- No board data, instruction, receipt or log ever lands under the control plane
  root outside a sibling.
- Every capability degrades to off with a reason, never to broken.
- No file is moved, and no repo initialised, without an explicit action.
- Each purpose is one grant, so no party needs access to more than its purpose.
