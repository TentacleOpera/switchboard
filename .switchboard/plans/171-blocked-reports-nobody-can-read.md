# The Host Mirrors Every Turn-End Into an Inbox With No Reader and No Listener

## Goal

Stop writing Mission Control reports when no Mission Control exists. When one does exist, make its
reports readable and claimable through the API and the CLI, the way `switchboard next` hands a seat
its work.

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
Do not repeat it: the files are real, some are substantive, and the fix is not a delete.

## Metadata

**Complexity:** 3
**Tags:** mission-control, backend, api, cli, reports
**Dependencies:** none. Change 3 should match the command shape of
`switchboard-next-a-seat-asks-for-its-own-card.md`.

## User Review Required

None.

## Proposed Changes

### 1. Gate the mirror on a Mission Control existing — the primary fix

- Add the existence test the comments assume and never make: is a Mission Control armed for this
  workspace? Skip the mirror when the answer is no.
- Keep the two sites byte-aligned. They are deliberate twins and the comments say so; a gate added
  to one only is the composition-root divergence CLAUDE.md warns about.
- Preserve the property those comments are actually defending: when a Mission Control **is** armed
  and there is no pty host, the file must still be written. Gate on *existence*, never on pty
  readiness — that distinction is the whole point of the `_ptyHostPort` note at
  `TaskViewerProvider.ts:2545`.
- Decide what "armed" means from state that survives a restart. `missionControlActive` already
  answers a version of this for the directive; reuse it rather than inventing a second predicate.

### 2. Read and claim routes, from one shared helper

- `GET /mission-control/reports` and `POST /mission-control/reports/claim`, moving into the existing
  `claimed/`.
- Extract the team handler's body (`LocalApiServer.ts:9500`, claim at `:9532`) into a helper taking
  a directory, and call it from both. Not a copy — the claim path validation (`..`, `/`, `\`, the
  `^[\w.-]+\.md$` test) is security-relevant and must not fork.
- Listing returns `filename` plus parsed frontmatter (`from`, `kind`, `planId`, `created`), not
  bodies; `?kind=blocked` filters; content comes from a per-report fetch. The team route returns
  every body in one unpaginated response today — fix that in the same pass.

### 3. A CLI surface shaped like `switchboard next`

- `switchboard reports [--kind blocked] [--json]` to list, `switchboard reports <filename>` to read
  one, `switchboard reports claim <filename>` to claim.
- Same reasoning as `switchboard-next`: the operator is already in a terminal, so handing them the
  text is delivery.

### 4. Settle `orchestratorPresent`

- The `orchestratorReport` fragment (`standingOrderFragments.ts:238`) is gated on
  `ctx.orchestratorPresent`, and the only production assignment is `teamWiring.ts:1631`:
  `orchestratorPresent: false`. `standingOrders.ts:511` reads
  `options.orchestratorPresent === true` and nothing passes it.
- So the disciplined instruction may never install while the same text sits as ungated prose at
  `teamWiring.ts:870` and `terminals.js:11411`. Wire it or delete it; do not leave a
  permanently-false gate beside an ungated duplicate.

### 5. Triage the existing 190 by machine

- `planId` is in the frontmatter, so cross-reference the board: a report whose card has since moved
  on is stale and bulk-claimable; one whose card is still parked is real backlog.
- Do not bulk-delete — see the `ScheduledJobsService.ts:181` history above. Several are plainly
  substantive: `2026-09-05-half-delivered-dispatch-no-seat.md`,
  `feature-dfcbc7eb-libsql-rejected.md`, `feature-dfcbc7eb-open-question.md`.

## Verification Plan

- With no Mission Control armed, run a full dispatch → turn-end cycle: **no new report file
  appears**, and the live pty send still lands. This is the fix.
- With one armed and the pty host stopped, the same cycle **does** write the file — the unattended
  channel the comments protect still works.
- Both hosts behave identically; assert it rather than reading the two sites and assuming.
- `GET /mission-control/reports` returns metadata for 190 entries; `?kind=blocked` returns 171.
- `switchboard reports --kind blocked` prints those rows in a terminal.
- Claiming moves a file into `claimed/` and drops it from the listing; a path-traversal filename is
  rejected.
- After triage, state the surviving unclaimed count in the completion report.

## Outstanding Questions

- Should a blocked report be able to act on its card — move it back to a review column, or flag it —
  rather than only being readable? That is the difference between an inbox and a queue and is a
  larger decision. Gating the writes (change 1) is worth doing regardless.
