# The Host Mirrors Every Turn-End Into an Inbox With No Reader and No Listener

## Goal

Stop writing Mission Control reports as files. The host holds the database, so a turn-end belongs in
`plan_events` — indexed, pruned, and joined to its plan. The file mirror has no reader it can
reach in any configuration, so it goes.

### Problem analysis

**Reported as:** *"these reports get written when no one is there to listen"* — and the operator has
barely exercised Mission Control at all.

**Confirmed. They are not written by team leads.** Every recent file carries `from: system`:

```
report-20260910T052342Z-finished-82711.md   from: system  kind: finished
report-20260909T153633Z-blocked-96586.md    from: system  kind: blocked
report-20260909T145403Z-blocked-49958.md    from: system  kind: blocked
report-20260909T141613Z-finished-73453.md   from: system  kind: finished
report-20260909T090244Z-blocked-84398.md    from: system  kind: blocked
report-20260909T090244Z-blocked-39346.md    from: system  kind: blocked
```

The host writes them. Two sites, one per composition root, byte-aligned twins:
`bootstrap.ts:3973` and `TaskViewerProvider.ts:2550`, both calling
`writeMissionControlReport` on **every turn-end** — a seat finishing, a feature stalling, or a
Phone-a-Friend dispatch dropping.

```
190 report files
187 with `kind:` frontmatter
171 kind: blocked
 16 kind: finished
Sep 5 23:27  →  Sep 10 15:23, still arriving
```

**And the write is deliberately unconditional.** Both sites carry the same comment:

> *"Fire-and-forget mirror to the reports directory — a non-pty Mission Control reads the same
> notice as a file. Never awaited ahead of the pty send, **never able to suppress it**."*

`TaskViewerProvider.ts:2545` goes further:

> *"This mirror **MUST** run before the `_ptyHostPort` guard below: with no pty host the file is the
> ONLY thing that survives — exactly the unattended case where the report is the only channel a
> Mission Control has. The guard skips live delivery, not the durable write."*

That reasoning is sound **when a Mission Control exists.** The missing part is the existence test.
Nothing anywhere asks whether one is armed before writing, and on this box none ever has been:
`.switchboard/mission-control/` contains `reports/` and nothing else — no mission state, no
session. So the answer is available and never consulted.

**The gate that does exist protects the wrong path.** `missionControlActive`
(`TaskViewerProvider.ts:1330`, `:702`) suppresses `MISSION_CONTROL_REPORT_DIRECTIVE` — the
*agent-facing* instruction telling seats to write reports — precisely because *"[it] tells the seat
to post report files to a directory nothing reads when no Mission Control is armed."* So the
problem was recognised, and the fix was applied to the directive while the host's own mirror, which
writes far more, stayed unguarded.

**Nothing can read them even when a Mission Control is armed.** Live against the running host:

```
GET /mission-control/reports  ->  404
GET /teams/x/reports          ->  400   (route exists, rejects the bad id)
```

`reports/claimed/` exists on disk, so claiming is expected, but there is no claim route — so no
report can ever be marked handled. Write-only plus never-claimed is the accumulation mechanism.

**This area has already burned one plan.** `ScheduledJobsService.ts:181`:

> *"The orchestrator→Mission Control rename moved this directory with no migration, on the plan's
> premise that the feature 'has not shipped' and there were 'no on-disk reports'. **Both halves were
> wrong**: a live workspace carries hundreds of `report-*.md` files here… the report is on disk, in
> a directory nothing reads any more."*

So a previous plan reasoned from "untested feature, therefore no data" and was wrong on both counts.
Do not repeat it. Deleting the *writer* (change 2) is right; deleting the *records* is not — the
files are real and some are substantive, which is why change 5 imports them before anything is
removed.

**And a host-written report should not be a file at all — the table already exists and is empty.**
The board DB carries the DB twin of every file-based coordination directory, and the file
implementations are the live ones:

```
plan_events          10378 rows    (workflow_event 10166, completed 212)
activity_log           257 rows
job_instructions         0 rows    <- twin of the file `inbox/`
job_runs                 0 rows
board_move_requests      0 rows    <- twin of the file `moves/`
```

`plan_events` is exactly this shape and is already indexed for the query the reports need:

```sql
plan_id, event_type, workflow, action, timestamp, device_id, payload, workspace_id
FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
INDEX (plan_id, timestamp) / (timestamp) / (workspace_id, timestamp)
```

A turn-end report *is* a plan event: a `planId`, a kind (`finished` / `blocked`), a one-line body.
Writing it as a file gives up everything the table provides:

- **No query.** `?kind=blocked` means walking 190 files and parsing frontmatter; in SQL it is a
  `WHERE` on an indexed column.
- **No referential integrity.** `plan_events` has a foreign key to `plans`. The files carry
  `planId` as a raw **absolute** path (`planId: /home/patrick/switchboard/.switchboard/plans/….md`)
  — the same absolute-path class the mapping-state work is unwinding, reintroduced in a directory
  nothing validates.
- **No retention.** `RetentionService` prunes DB rows; nothing prunes this directory. That is why
  190 accumulate and why nothing would ever have stopped.
- **No atomicity** with the board state the event describes.

The file form has exactly one claimed justification: an agent with only filesystem access can write
one. That class is already small — a cloud or CI agent, a web session with a repo but no route to
the box. **And for this directory it is empty, because the files are gitignored.** `.gitignore:60`:

```
.switchboard/*
!.switchboard/reviews/
!.switchboard/plans/
!.switchboard/features/
```

`git ls-files .switchboard/mission-control/` returns **0**, and `git check-ignore` confirms both
`.switchboard/mission-control/reports/` and `.switchboard/teams/<id>/reports/` are ignored. So the
files never leave the machine. They serve:

- **not** an agent on the box — it has the API and the database;
- **not** an agent on the tailnet — the API answers with no credential;
- **not** a disconnected CI, cloud or web agent — the files are never committed, so nothing
  transports them.

The only reader that could ever exist is a process on that same box with filesystem access, which
is precisely the case that also has the API and the DB. The "filesystem but no API" justification
does not survive contact with the ignore rules.

Note the contrast, because it is the design that already works: `plans/` and `features/` are
deliberately **un-ignored**. A cross-machine agent is reached through a tracked plan file, not
through an ignored inbox. If a git-transported report channel is ever wanted, that is the shape it
has to take.

## Metadata

**Complexity:** 3
**Tags:** mission-control, backend, api, cli, reports
**Dependencies:** none — and deliberately so. This no longer waits on
`mission-control-reads-its-protocols-from-a-directory-nothing-writes` or on whether Mission Control
is kept at all: the turn-end record belongs in `plan_events` either way, and the file mirror has no
reader in any configuration. Change 3 should match the command shape of
`switchboard-next-a-seat-asks-for-its-own-card.md`.

## User Review Required

None. An earlier draft deferred to the "is Mission Control wanted?" decision; that turned out to be
irrelevant here. The mirror's output is unreachable whether or not Mission Control exists, so this
plan stands on its own.

## Proposed Changes

### 1. Record the host's turn-end in `plan_events`

- `event_type` `turn_end`, `action` `finished` / `blocked`, `plan_id` the plan's **relative** path
  (never the absolute one the files carry), the one-line message in `payload`.
- No existence gate is needed. The row is cheap, indexed, joined to `plans`, and pruned by
  `RetentionService` — the properties whose absence is what made 190 files a problem. Write it
  always, whether or not a Mission Control exists.
- Both composition roots, byte-aligned: `bootstrap.ts:3973` and `TaskViewerProvider.ts:2550` are
  deliberate twins and the comments say so.

### 2. Delete the file mirror

- Remove `writeMissionControlReport` and both call sites. Nothing can read what it writes: the
  directory is gitignored, so it never reaches another machine, and any process that *can* read it
  is on the box and already has the API and the database.
- Keep `.switchboard/mission-control/reports/` on disk for the existing 190 until change 5 has
  triaged them. Deleting the writer does not delete the record.
- The comments at `TaskViewerProvider.ts:2545` defending an unguarded write ("with no pty host the
  file is the ONLY thing that survives") must be removed with it, not left contradicting the code.
  A `plan_events` row survives a missing pty host strictly better than a file does.

### 3. Read the reports out of the DB, not the directory

- The reader this needed is now a query, not a route: `plan_events` filtered by `event_type` and
  `action`, joined to `plans` for the card's current column — which immediately answers the
  question the files could not, namely whether a blocked card is still blocked.
- `switchboard reports [--kind blocked]`, in the pull shape of `switchboard next`, over that query.
- **Do not** build `GET /mission-control/reports` or a claim route. Claiming was file bookkeeping
  standing in for a query; a row joined to live board state needs neither.

### 4. Settle `orchestratorPresent`

- The `orchestratorReport` fragment (`standingOrderFragments.ts:238`) is gated on
  `ctx.orchestratorPresent`, and the only production assignment is `teamWiring.ts:1631`:
  `orchestratorPresent: false`. `standingOrders.ts:511` reads
  `options.orchestratorPresent === true` and nothing passes it.
- That fragment tells an agent to write a file to the directory change 2 stops writing. Delete the
  fragment and the ungated duplicates of its text at `teamWiring.ts:870` and `terminals.js:11411`,
  or replace them with the CLI call that records a `plan_events` row.

### 5. Triage the existing 190 by machine

- `planId` is in the frontmatter, so cross-reference the board: a report whose card has since moved
  on is stale; one whose card is still parked is real backlog. Import the latter as `plan_events`
  rows so the record survives the directory.
- Do not bulk-delete — see the `ScheduledJobsService.ts:181` history above. Several are plainly
  substantive: `2026-09-05-half-delivered-dispatch-no-seat.md`,
  `feature-dfcbc7eb-libsql-rejected.md`, `feature-dfcbc7eb-open-question.md`.

### 6. Note, do not fix: the other file/DB twins

`job_instructions`, `job_runs` and `board_move_requests` are the same pattern — DB tables at 0 rows
with a live file implementation beside them (`inbox/`, `moves/`). The team report inbox
(`.switchboard/teams/<id>/reports/`) differs in one respect that matters: it has a working local
reader (`GET /teams/<id>/reports`, used by the terminals panel for seat declarations), so it is
functioning local coordination rather than a write-only directory. All of it deserves the same
question and none of it belongs in this plan.

## Verification Plan

- A full dispatch → turn-end cycle writes a `plan_events` row with a relative `plan_id` and **no**
  file under `.switchboard/mission-control/reports/`.
- The row is present whether or not a Mission Control is armed, and whether or not a pty host is
  running — the case the deleted comments were defending.
- Both hosts produce identical rows; assert it rather than reading the two sites and assuming.
- `switchboard reports --kind blocked` lists blocked turn-ends with each card's current column, in
  a terminal.
- `RetentionService` prunes these rows on its normal schedule, so the count is bounded without
  anything new.
- After triage, the surviving report count and how many were imported are stated in the completion
  report.

## Outstanding Questions

- Should a blocked report be able to act on its card — move it back to a review column, or flag it —
  rather than only being readable? That is the difference between an inbox and a queue and is a
  larger decision. Gating the writes (change 1) is worth doing regardless.
