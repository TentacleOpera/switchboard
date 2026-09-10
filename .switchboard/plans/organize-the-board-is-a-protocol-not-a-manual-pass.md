# Organising the Board Is a Protocol, Not a Manual Pass

## Goal

Make board organisation a repeatable operation with two entry points — a button on the kanban and
`lc organize` — that **audits** the board, **proposes** changes, and applies them only on approval.

Four things it must deliver, in the operator's terms: **group loose cards into features**, **merge
duplicates**, **surface plans that are out of date**, and **make the board's own condition visible**.
Grouping is the straightforward one. The other three each need a mechanism that does not exist today —
changes 7, 8 and 9 are those mechanisms, and without them this protocol would only do the easy third
of the job.

Everything it does was done by hand on 2026-09-09/10 across roughly three hours: finding loose cards,
clustering them into features, spotting remnant rows, checking cards against the code, and completing
what should not be worked. Every check below earned its place by mattering during that pass, and
several of the requirements exist because the manual attempt got them wrong.

### Problem analysis

**The board hides its own condition.** `_filterGhostPlans` (`KanbanProvider.ts:2143` and four other
sites) strips rows whose plan file is missing out of every board read. Right for the UI — they cannot
be worked — but the operator cannot see or count them. On this board: **512 of 3,141 rows**, 31 of
them in CREATED and PLAN REVIEWED.

**And the remnants are made by consolidating the way it has always been done.** 29 of those 31 are
`is_feature=1` — features whose file is gone — and **28 feature files were deleted in commits**, by
passes named `board: create five features from thirty loose and scattered plans` and
`board: consolidate the test gates and settle the last clusters` (2026-09-04). Deleting the file
through git never tells the board, so the row survives. This protocol would reproduce that exactly
unless it deletes through `/kanban/feature/delete` instead — see change 10.

**Consolidation is entirely manual and therefore rare.** Nothing computes "which cards are loose".
The answer on 2026-09-10 was 36 in CREATED and 21 in PLAN REVIEWED — findable only by joining
`isFeature`, `featureId` and column, per card, by hand.

**The apply half already exists and was not used.** `POST /kanban/features/reconcile` is declarative
and idempotent: *"converges the whole feature structure to a desired end state in one call"*, and the
`/switchboard-manage` skill already reaches it. The manual pass instead issued **12 separate
`POST /kanban/feature` calls**, which is neither atomic nor reviewable.

**Completion has a correct path that is easy to miss.** `POST /kanban/move` sets the column and
nothing else; `POST /kanban/task/complete` routes through `completeCardInternal` → `setCompletedAt`
and is the **only** thing that stamps `completed_at`, and it carries `outcome` and `note`. The manual
pass used `move` for five cards, left `completed_at` null, and misdiagnosed that as an API defect
before re-completing them properly.

#### Requirements that exist because the manual pass got them wrong

1. **Resolve `plan_file` against the workspace root, never the process cwd.** All 3,141 paths are
   relative, so `existsSync` answers differently depending on where the checker runs. This was the
   single largest source of wrong numbers in the manual pass — counts that did not move even after a
   file was restored.
2. **Say which source a count came from.** The API returns 527 cards (ghosts filtered); the database
   holds 3,141 rows (ghosts included). Both correct; a report that does not say which is unreadable.
3. **A remnant row is a record** — report, never delete, until archiving runs in standalone.
4. **Two non-signals, both measured:** age (nothing over 60 days; 104 cards entered their column this
   week) and `max(updated_at)` (some rows hold `reviewer-pass`, not a timestamp). And a feature
   spanning columns *mid-flight* is normal drift — only at rest is it a finding.

## Metadata

**Complexity:** 6
**Tags:** kanban, cli, board-hygiene, ux
**Dependencies:** none. Uses `POST /kanban/features/reconcile`, `/kanban/task/complete`,
`/kanban/feature/remove` and `/kanban/move`, all of which ship today. Related:
`board-hygiene-cards-that-leave-and-cards-that-should-not-arrive` (PLAN REVIEWED) covers arrival and
departure rules; this plan covers the periodic audit.

## User Review Required

None. Two open questions below are refinements, not blockers.

## Proposed Changes

### 1. An audit that reads the board and returns findings, applying nothing

- **Logic:** one read-only pass producing a typed findings list. Default behaviour everywhere —
  button, CLI and verb — is to report.
- **The checks**, each with its measured yield from the manual pass:

| check | what it finds | 2026-09-10 yield |
|---|---|---|
| loose cards | not a feature, no `featureId`, per column | 36 CREATED / 21 PLAN REVIEWED |
| cluster proposal | loose cards sharing a theme, **within one column** | 12 features, 39 cards |
| remnant rows | `plan_file` unresolvable against the workspace root | 512 board-wide, 31 active |
| duplicate topics | identical topic strings | **0 — too weak, see change 7** |
| dead references | plan cites `src/**` paths that no longer exist | e.g. `tmuxTeamSeating.ts`, deleted |
| already shipped | plan's subject is present in the tree | 3 (groups-ephemeral, stop teardown, pty-host) |
| expired premise | a *different* mechanism shipped after the card was written that answers its problem | see change 9a |
| spanning features | feature whose members sit in >1 column, at rest | 5 pre-existing |

- **Never mix columns in a proposed feature.** This is a hard constraint, not a preference: a feature
  whose members straddle CREATED and PLAN REVIEWED cannot be reviewed or dispatched as a unit.

### 2. Clustering proposes, the operator disposes

- **Logic:** cluster on topic and tags, and present each proposal as `name + members + why`. The
  operator accepts, edits or rejects per cluster.
- **Do not auto-apply.** The manual pass produced 12 clusters and two of them were wrong on first
  attempt: one card belonged in a different theme, and one target feature turned out to be a remnant
  with no body. Both were caught by a human reading the list.
- **Leave large self-contained cards loose.** 16 cards were deliberately left loose because each is
  a whole piece of work; a protocol that consolidates everything is worse than one that consolidates
  the obvious.

### 3. Apply through `features/reconcile`, not a sequence of creates

- **Logic:** build the desired end state and send it once. Idempotent, atomic where the endpoint
  supports it, and re-runnable, which a series of `POST /kanban/feature` calls is not.
- **Detach before completing.** Completing a member of a feature in another column silently creates a
  spanning feature. `POST /kanban/feature/remove { subtaskPlanId }` first — the manual pass needed
  this for three of five cards and only did it because the spanning check ran immediately after.

### 4. Completion goes through `task/complete`, with a reason

- **Logic:** any card the audit recommends closing is closed with
  `POST /kanban/task/complete { planId, from, workspaceRoot, outcome, note }`. `from: "operator"` is
  accepted with no live terminal — verified; the response reports
  `clearReason: "No coding seat attributed to plan"`.
- **The note is the point.** A card moved to COMPLETED with no note is indistinguishable from one
  that vanished. Every close the protocol performs records why.
- **`/kanban/move` is for BACKLOG**, and for nothing that means "done".

### 5. The kanban button

- **Logic:** an **Organise** control in the board's control rail. Opens a panel listing findings by
  check, with counts, and per-item accept/dismiss. Applying calls change 3 and 4.
- **Must show remnants read-only** — visible, counted, not actionable. They are the one category the
  operator currently cannot see at all.

### 6. `lc organize`

- **Logic:** the same audit from a terminal, so the protocol is reachable where the fleet works.
- **Shape:** `lc organize [--column CREATED|"PLAN REVIEWED"] [--check loose,clusters,remnants,…]
  [--json] [--apply]`. Dry-run is the default; `--apply` is explicit.
- **`--json` is the contract for agents.** The controller agent should be able to run the audit and
  act on it without scraping a table.

### 7. Overlap detection by content, because title matching finds nothing

- **Why:** exact-topic matching returned **0 duplicates across 527 cards**, while the operator's own
  account is that *"a lot of badly written plans were deleted due to overlap."* Overlap here is
  between plan **bodies**, not titles. `standalone-board-parity-946b24db…` and
  `standalone-board-parity-aa872dcc…` were two attempts at one piece of work, and `board-anywhere`
  existed as three separate files. Title matching sees none of that.
- **Signals, strongest first:**
  1. **Shared source references** — two plans citing the same `src/**` paths are competing for the
     same seam. This is the most useful signal by far.
  2. **Shared change titles** — overlapping `### N.` headings inside two plans.
  3. **Title similarity after slug and UUID-suffix normalisation** — catches the twins above.
- **Name the overlap, never just a score.** "Both propose editing `goPtyFleetProjection.ts:258`" is
  actionable; "0.71 similar" is not.

### 8. A merge action, composed from what exists

- **There is no primitive.** No merge or supersede endpoint, and no `superseded_by` column. The schema
  offers `plan_dependencies (plan_id, depends_on_plan_id)` — which means "depends on", not "replaced
  by" — and `merged_source_databases`, which merges whole boards. So merge must be composed:
  1. fold the loser's content into the winner, or into the feature that now owns both;
  2. record the relationship (see Outstanding Questions — there is no good home for it yet);
  3. `POST /kanban/task/complete` the loser with `outcome: "superseded"` and
     `note: "superseded by <planId> — <topic>"`.
- **The note is the merge record.** Without it the loser is indistinguishable from abandoned work,
  which is the same confusion the 512 remnant rows already cause.
- **Never delete the loser** — same rule as remnants; it is a record until archiving runs.
- **Folding content is a judgement, not a concatenation.** The protocol proposes the pair and the
  direction; a human or an agent writes the merged plan.

### 9. Ask whether a plan still matches intent — do not try to infer it

- **The audit cannot know.** In the manual pass the stale extension and parity cards were only
  identifiable once the operator said what the current intent was — and the first two readings of it
  were wrong: "the extension is being deprecated" (it survives as a launcher) and "retire the parity
  audits" (they are migration-completeness checks, so they matter more, not less). No heuristic would
  have done better.
- **So the protocol asks.** It groups cards by the subsystem or framing their plans lean on, presents
  each group, and asks whether that work is still wanted. The operator answers; the audit acts on the
  answer. If more detail is needed, that is a conversation, not a lookup.
- **No register, no config, nothing to maintain** — a file of standing decisions would go stale as
  fast as the cards, leaving two things to keep true instead of one. The output is a short list of
  "is this still what you want?", never a set of cards marked obsolete.

### 9a. Check the card's premise against what shipped after it was written

**Distinct from "already shipped".** That signal asks whether the card's own subject is in the tree.
This one asks whether the *problem* still exists, because something else solved it. A card can be
entirely unimplemented and still dead.

**The worked example, dated from git.** The operator's read on this was that a lot of the file-inbox
and HTTP-surface work predates the CLI and got superseded. Two thirds right, and the remaining third
is worse:

| | date |
| :--- | :--- |
| file inbox (`writeInboxFile`) | 2026-08-19 |
| card *Register an Agent in Any Local Terminal* created | 2026-08-24 |
| `writeMissionControlReport` | 2026-08-24 |
| **CLI `verb`** | **2026-08-31** |
| **CLI `next`** | **2026-09-01** |
| **CLI `api`** | **2026-09-03** |
| `switchboard-mission-control-http` protocol (34.7 KB of prompt text) | 2026-09-04 |
| card *`/switchboard-next`* created, then PLAN REVIEWED | 2026-09-06 |
| **`/agents/register` + heartbeat + inbox shipped** (`e4ee66a1`) | **2026-09-09** |

The file inbox and the report mirror do predate the CLI, so they are ordinary supersession. But
`mission-control-http` was written *after* `verb`, `next` and `api` existed, and `/agents/register`
shipped **eight days after `next`** and **three days after its own replacement was written and
reviewed**.

**So the failure is not that old ideas linger. It is that a card written before the CLI got built
after it, with nobody re-reading its premise.** The card was correct on 2026-08-24 and wrong by
2026-09-01; it was implemented on 2026-09-09. That is the specific thing this check exists to catch,
and no clustering or duplicate-detection pass would have seen it — the card had no duplicate and its
subject was genuinely absent from the tree.

**How the audit surfaces it.** Compare each card's `created_at` against the mechanisms that landed
since, and present the cards whose framing predates a shipped mechanism in the same area as a
question: *"this was written before X shipped — does X answer it?"* Do not attempt to decide. Same
rule as change 9: the audit asks, the operator answers.

**And check the card's own plan file for the tell.** These cards usually quote the constraint that
has since dissolved. `register-an-agent-in-any-local-terminal.md` quotes *"there is no portable OS
mechanism to write into an unrelated process's stdin. This is a genuine capability gap"* — still
true, and irrelevant once the agent pulls instead of being pushed to. A quoted constraint that is
still true is not evidence the card is still needed.

### 10. Delete features through the API, never by removing the file

- **This is the cause of the 512 remnants**, and the one thing this protocol must not repeat. Removing
  a feature file with `git rm` or by hand leaves the row behind forever; `POST /kanban/feature/delete`
  is the path that tells the board.
- **Consequence for change 3:** the desired end state sent to `features/reconcile` must express
  removals, so the board performs them. Never delete a file and let the board find out.
- The existing residue stays (requirement 3) — this only stops new residue.

## Verification Plan

The properties that must hold, each already argued in the change that needs it:

- The audit writes nothing — the board is byte-identical after a dry run.
- No proposed feature spans columns.
- No remnant row is deleted; features are removed through `/kanban/feature/delete`, never by
  unlinking the file (change 10).
- Every card the protocol closes has `completed_at` and a note.
- `plan_file` resolves against the workspace root, so a checker's cwd cannot change the result.
- Re-running the audit after applying a cluster no longer proposes it.

**Baseline to reproduce:** on this board, 2026-09-10 — 36 loose in CREATED, 21 in PLAN REVIEWED, 512
remnants, 0 exact-duplicate topics, 5 features spanning columns.

## Outstanding Questions

- Change 9a settles half of the question below: premise-expiry belongs here, because it needs the
  operator in the loop and that is what this protocol is for.
- Should the "already shipped" check be part of this protocol or its own? It is the most valuable and
  the least reliable — proving a plan's subject exists in the tree needs per-plan reasoning, not a
  grep. Reporting it as *candidates for verification* rather than as fact is the honest option.
- Should the audit run on a schedule and post findings, or only on demand? On demand is safer, but the
  512 remnants accumulated precisely because nothing looked.
- **Where is a supersession recorded?** `plan_dependencies` means "depends on", so overloading it
  would corrupt dependency reads. The completion note is readable but not queryable — fine for now,
  a problem at a hundred merges.
