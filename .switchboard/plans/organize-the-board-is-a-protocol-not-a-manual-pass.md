# Organising the Board Is a Protocol, Not a Manual Pass

## Goal

Make board organisation a repeatable operation with two entry points — a button on the kanban and
`switchboard organize` — that **audits** the board, **proposes** changes, and applies them only on
approval.

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

**The board hides its own condition.** `_filterGhostPlans` (`KanbanProvider.ts:2092`, called at
`:2143`, `:2286`, `:2297`, and two `_buildBoardCards` sites) strips rows whose plan file is missing
out of every board read. Right for the UI — they cannot be worked — but the operator cannot see or
count them. On this board: **512 of 3,141 rows**, 31 of them in CREATED and PLAN REVIEWED.

**And the remnants are made by consolidating the way it has always been done.** 29 of those 31 are
`is_feature=1` — features whose file is gone — and **28 feature files were deleted in commits**, by
passes named `board: create five features from thirty loose and scattered plans` and
`board: consolidate the test gates and settle the last clusters` (2026-09-04). Deleting the file
through git never tells the board, so the row survives. This protocol would reproduce that exactly
unless it deletes through `/kanban/feature/delete` instead — see change 10.

**Consolidation is entirely manual and therefore rare.** Nothing computes "which cards are loose".
The answer on 2026-09-10 was 36 in CREATED and 21 in PLAN REVIEWED — findable only by joining
`isFeature`, `featureId` and column, per card, by hand.

**The apply half already exists and was not used.** `POST /kanban/features/reconcile`
(`LocalApiServer.ts:7044`, `:12466`) is declarative and idempotent: *"converges the whole feature
structure to a desired end state in one call"*, and the `/switchboard-manage` skill already reaches
it. The manual pass instead issued **12 separate `POST /kanban/feature` calls**, which is neither
atomic nor reviewable.

**Completion has a correct path that is easy to miss.** `POST /kanban/move` sets the column and
nothing else; `POST /kanban/task/complete` (`LocalApiServer.ts:4196`) routes through
`completeCardInternal` (`LocalApiServer.ts:4018`) → `setCompletedAt` (`KanbanDatabase.ts:3470`)
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
**Tags:** cli, ux
**Project:** Browser Switchboard
**Dependencies:** none. Uses `POST /kanban/features/reconcile` (`LocalApiServer.ts:7044`),
`/kanban/task/complete` (`LocalApiServer.ts:4196`), `/kanban/feature/remove`
(`LocalApiServer.ts:6908`) and `/kanban/move`, all of which ship today. Related:
`board-hygiene-cards-that-leave-and-cards-that-should-not-arr-4b69fe8b-8bdb-4669-82dc-06e5460c184a`
(feature, PLAN REVIEWED) covers arrival and departure rules; this plan covers the periodic audit.

## User Review Required

None. Two open questions below are refinements, not blockers.

## Complexity Audit

### Routine
- Loose-cards query: `SELECT … WHERE is_feature=0 AND (feature_id IS NULL OR feature_id='')` per column — single SQL pass over `kanban.db` (`KanbanDatabase.ts`, `plans` table, columns `is_feature`/`feature_id` at `:372-373`).
- Remnant rows: resolve each `plan_file` against the workspace root with `existsSync`; count by column. Reuses the resolution `_filterGhostPlans` already does (`KanbanProvider.ts:2092-2125`), but reports instead of filtering.
- Spanning features: `SELECT feature_id, COUNT(DISTINCT kanban_column) FROM plans WHERE is_feature=0 AND feature_id!='' GROUP BY feature_id` — one query.
- Cluster proposal: group loose cards by shared tag + topic keyword, within one column. Presentation only.
- Apply via `features/reconcile` with `removeUnmentionedFeatures` for deletions (`KanbanProvider.ts:16762`) — endpoint already ships.
- Complete via `task/complete` with `outcome`/`note` (`LocalApiServer.ts:4196-4207`) — endpoint already ships.
- Detach via `feature/remove { subtaskPlanId }` (`LocalApiServer.ts:6908`) — endpoint already ships.
- Kanban button: one `<button class="strip-btn">` in the existing `kanban-controls-strip` (`project.html:1312-1333`) opening a findings panel.
- CLI verb: one new `cmdOrganize` in `cli.ts` mirroring `cmdPlans`/`cmdReady` shape, dispatched at the `if (process.argv[2] === 'organize')` arm (after `cli.ts:4241`), added to `KNOWN_SUBCOMMANDS` (`cli.ts:3218-3227`) and the `subcommandTargetsCwd` exclusion (`cli.ts:3315-3324`).

### Complex / Risky
- **Overlap detection by plan-body content (change 7).** Parsing plan bodies to extract `src/**` *edit targets* (not mere citations) and joining across 527 plans. The extractor must distinguish "proposes editing `goPtyFleetProjection.ts:258`" from "cites `KanbanProvider.ts:2143` to describe it" — a naive `src/` regex flags this very plan as overlapping every kanban plan it references. Three signals, ordered strongest-first; the "name the overlap" requirement is the guard against a false-positive flood.
- **Merge action composed from non-primitives (change 8).** No merge/supersede endpoint, no `superseded_by` column. `plan_dependencies` (`KanbanDatabase.ts:397`) means "depends on", not "replaced by" — overloading it corrupts dependency reads. Merge is a multi-step composition (fold content → record in completion note → `task/complete` with `outcome:"superseded"`), and "folding content is a judgement, not a concatenation" — the protocol proposes the pair + direction, a human/agent writes the merged plan.
- **Premise-expiry check (changes 9/9a).** Deliberately not a heuristic — the mission-control-http example shows no heuristic would have beaten the operator's two-wrong-then-right reading. "Same area" grouping (shared `src/**` subtree or shared tag) is mechanical; the supersession *decision* is the operator's. The "tell" filter (a quoted constraint still true but irrelevant) requires reading the plan body and reasoning about whether the constraint dissolved — judgment-laden, not a lookup.
- **Two-host parity.** The audit engine and the CLI verb must land in both the extension (`src/extension.ts`) and the standalone host (`src/standalone/bootstrap.ts`). The button is extension/webview-only by nature, but the audit service it calls must be the same service the CLI calls. Per CLAUDE.md: diff the two composition roots by hand — the seams each host wires are the audit, not the verbs each host answers.
- **512 remnants have no remediation path in this protocol.** The audit reports them read-only (requirement 3). Archiving (the cure) is out of scope and unscheduled — the protocol delivers diagnosis, not cure, for the largest finding. Tracked in Outstanding Questions.

## Edge-Case & Dependency Audit

**Race Conditions**
- The audit is read-only; the only race is the audit reading a row the operator simultaneously moves via the UI. Findings are a snapshot with a timestamp; applying them re-runs the audit (idempotent apply). A finding that references a card the operator already moved is stale and the re-audit drops it. No locking needed — the apply is "re-audit → reconcile", not "apply stale findings".
- `features/reconcile` is idempotent, **not single-transaction atomic** (per the A3 feature plan: "a single cross-method `BEGIN/COMMIT` is not feasible... idempotency is the practical safety net"). A mid-reconcile failure leaves partial state; the apply must be "re-run audit → re-apply reconcile", never "one-shot and trust". The coder must not wrap the apply in a single "fire and forget" call.

**Security**
- The audit reads plan files from disk (`existsSync`, plan-body parsing for overlap/premise checks). All paths resolve against the workspace root (requirement 1) — never the process cwd. A `plan_file` containing `..` or absolute paths outside the workspace is reported as a remnant (unresolvable), not followed.
- The CLI verb and the button both reach the audit through the LocalApiServer (`_checkAuth` gated). No new unauthenticated surface.
- `task/complete` rejects path separators in `planId` (`LocalApiServer.ts:4225`) — the protocol's close action inherits this guard.

**Side Effects**
- Dry run (default): none. The board is byte-identical after a report.
- Apply: `features/reconcile` creates/removes features and assigns/removes subtasks; `task/complete` stamps `completed_at` and writes a `plan_events` row; `feature/remove` detaches a subtask. All are existing, audited endpoints — the protocol composes them, it does not add writes.
- Remnant rows are never deleted by this protocol (requirement 3). Change 10 only stops *new* remnants; the existing 512 stay until archiving ships.

**Dependencies & Conflicts**
- `board-hygiene-cards-that-leave-and-cards-that-should-not-arr-4b69fe8b…` (feature, PLAN REVIEWED) covers arrival/departure *rules*; this plan covers the periodic *audit*. No overlap in scope; the audit could surface cards that violate the hygiene rules as an additional check, but that is a Phase 2+ refinement, not a dependency.
- `standalone-kanban-column-parity-audit.md` (PLAN REVIEWED) is about standalone/extension column-resolution divergence — orthogonal to this audit, but the two-host parity requirement above means this plan's CLI verb must not regress that work.
- No `superseded_by` column exists; `plan_dependencies` (`KanbanDatabase.ts:397`) is semantically "depends on" and must not be overloaded for merge recording (change 8). The completion note is the merge record for now — readable, not queryable; a problem at a hundred merges (Outstanding Questions).

## Dependencies

None. All apply paths ship today (see Metadata). This plan adds the audit engine and two surfaces; it consumes existing endpoints.

## Adversarial Synthesis

Key risks: (1) the 512 remnants are diagnosed but never cured — the audit reports them read-only and archiving is unscheduled, so the protocol risks becoming a permanent counter of a problem it refuses to fix; (2) `features/reconcile` is idempotent, not atomic — the apply must be "re-audit → re-apply", never one-shot, or a mid-failure leaves partial state; (3) the overlap extractor must distinguish *edit targets* from *citations* or it flags every plan that references a shared file. Mitigations: track archiving in Outstanding Questions; document the apply as re-runnable; require the overlap check to name the specific proposed edit, not the mere shared path.

## Proposed Changes

> **Phased delivery.** The audit engine (changes 1-4, 10) is the spine and ships first — it alone replaces the 3-hour manual pass. Surfaces (5, 6) ship with it (both hosts). Overlap + merge (7, 8) and premise-expiry (9, 9a) are additional check implementations that plug into the same findings list and can ship after. Phases are execution-ordering within one plan, not separate plans.

### 1. An audit that reads the board and returns findings, applying nothing

- **Context:** new server-side audit service, reached identically by the button (change 5) and the CLI verb (change 6). Lives behind the LocalApiServer as a new method (e.g. `auditBoard(workspaceRoot, options)`) wired in both composition roots (`src/extension.ts`, `src/standalone/bootstrap.ts`) — per the two-host parity rule, the seams each host wires are the audit.
- **Logic:** one read-only pass producing a typed findings list. Default behaviour everywhere — button, CLI and verb — is to report.
- **The checks**, each with its measured yield from the manual pass:

| check | what it finds | 2026-09-10 yield |
|---|---|---|
| loose cards | `is_feature=0` AND (`feature_id` NULL or empty), per column | 36 CREATED / 21 PLAN REVIEWED |
| cluster proposal | loose cards sharing a theme, **within one column** | 12 features, 39 cards |
| remnant rows | `plan_file` unresolvable against the workspace root | 512 board-wide, 31 active |
| duplicate topics | identical topic strings | **0 — too weak, see change 7** |
| dead references | plan cites `src/**` paths that no longer exist | e.g. `tmuxTeamSeating.ts`, deleted |
| already shipped | plan's subject is present in the tree | 3 (groups-ephemeral, stop teardown, pty-host) |
| expired premise | a *different* mechanism shipped after the card was written that answers its problem | see change 9a |
| spanning features | feature whose members sit in >1 column, at rest | 5 pre-existing |

- **Never mix columns in a proposed feature.** Hard constraint: a feature whose members straddle CREATED and PLAN REVIEWED cannot be reviewed or dispatched as a unit.
- **Each finding carries its source.** Per requirement 2: a count states whether it came from the API (ghosts filtered) or the DB (ghosts included).

### 2. Clustering proposes, the operator disposes

- **Logic:** cluster on topic and tags, and present each proposal as `name + members + why`. The operator accepts, edits or rejects per cluster.
- **Do not auto-apply.** The manual pass produced 12 clusters and two were wrong on first attempt: one card belonged in a different theme, one target feature was a remnant with no body. Both caught by a human reading the list.
- **Leave large self-contained cards loose.** 16 cards deliberately left loose because each is a whole piece of work; a protocol that consolidates everything is worse than one that consolidates the obvious.

### 3. Apply through `features/reconcile`, not a sequence of creates

- **Context:** `POST /kanban/features/reconcile` (`LocalApiServer.ts:7044`), service method `reconcileFeatures` (`KanbanProvider.ts:16559`), with `removeUnmentionedFeatures` option (`KanbanProvider.ts:16762`) for deletions.
- **Logic:** build the desired end state and send it once. Idempotent (re-run = no-op) and re-runnable. **Not single-transaction atomic** — a mid-failure leaves partial state a retry converges (per the A3 feature plan). The apply is therefore "re-audit → re-apply reconcile", never "fire once and trust".
- **Detach before completing.** Completing a member of a feature in another column silently creates a spanning feature. `POST /kanban/feature/remove { subtaskPlanId }` (`LocalApiServer.ts:6908`) first — the manual pass needed this for three of five cards and only did it because the spanning check ran immediately after.

### 4. Completion goes through `task/complete`, with a reason

- **Context:** `POST /kanban/task/complete` (`LocalApiServer.ts:4196`), body `{ from, planId, workspaceRoot?, outcome?, note? }` (`:4179`). Routes through `completeCardInternal` (`:4018`) → `setCompletedAt` (`KanbanDatabase.ts:3470`).
- **Logic:** any card the audit recommends closing is closed with `POST /kanban/task/complete { planId, from, workspaceRoot, outcome, note }`. `from: "operator"` is accepted with no live terminal — verified at `LocalApiServer.ts:4147-4153`: `acceptedCodingSeat` is undefined, `clearReason: "No coding seat attributed to plan"`.
- **The note is the point.** A card moved to COMPLETED with no note is indistinguishable from one that vanished. Every close the protocol performs records why.
- **`/kanban/move` is for BACKLOG**, and for nothing that means "done".

### 5. The kanban button

- **Context:** the `kanban-controls-strip` in `project.html:1312-1333` (the strip holding Import/Create/Chat Prompt/Improve). A new `<button id="btn-organize-kanban" class="strip-btn">Organise</button>` joins it; the handler in `project.js` calls the audit service and renders a findings panel.
- **Logic:** an **Organise** control in the board's control rail. Opens a panel listing findings by check, with counts, and per-item accept/dismiss. Applying calls changes 3 and 4.
- **Must show remnants read-only** — visible, counted, not actionable. They are the one category the operator currently cannot see at all.

### 6. `switchboard organize`

> **Superseded:** `lc organize`
> **Reason:** `lc` is not a command, alias, or function anywhere in this repo. The CLI binary is `switchboard` (`package.json:14-16`); every existing verb (`done`, `next`, `verb`, `api`, `plans`, `ready`, `dispatch`) is dispatched as `switchboard <verb>` in `cli.ts` (`:4199-4241`). Using `lc` would ship a command that does not exist.
> **Replaced with:** `switchboard organize` — a new verb dispatched at `if (process.argv[2] === 'organize')` (after the `api` arm at `cli.ts:4241`), added to `KNOWN_SUBCOMMANDS` (`cli.ts:3218`) and the `subcommandTargetsCwd` exclusion list (`cli.ts:3315-3324`).

- **Context:** `src/standalone/cli.ts` — a new `cmdOrganize(workspaceRoot, argv)` mirroring `cmdPlans`/`cmdReady` (`:1226`, `:1314`). Dispatched alongside the other board verbs.
- **Logic:** the same audit from a terminal, so the protocol is reachable where the fleet works.
- **Shape:** `switchboard organize [--column CREATED|"PLAN REVIEWED"] [--check loose,clusters,remnants,…] [--json] [--apply]`. Dry-run is the default; `--apply` is explicit.
- **`--json` is the contract for agents.** The controller agent should be able to run the audit and act on it without scraping a table.

### 7. Overlap detection by content, because title matching finds nothing

- **Why:** exact-topic matching returned **0 duplicates across 527 cards**, while the operator's own account is that *"a lot of badly written plans were deleted due to overlap."* Overlap here is between plan **bodies**, not titles. `standalone-board-parity-946b24db…` and `standalone-board-parity-aa872dcc…` were two attempts at one piece of work, and `board-anywhere` existed as three separate files. Title matching sees none of that.
- **Signals, strongest first:**
  1. **Shared *edit-target* references** — two plans proposing to edit the same `src/**` path are competing for the same seam. This is the most useful signal by far. The extractor must distinguish an *edit proposal* (a `### N.` change heading naming a file, or a path in an "Implementation"/"Logic" context) from a mere *citation* (a path referenced to *describe* the codebase, e.g. this plan citing `KanbanProvider.ts:2092`). A naive `src/` regex flags this plan as overlapping every plan it references — the distinction is load-bearing.
  2. **Shared change titles** — overlapping `### N.` headings inside two plans.
  3. **Title similarity after slug and UUID-suffix normalisation** — catches the twins above.
- **Name the overlap, never just a score.** "Both propose editing `goPtyFleetProjection.ts:258`" is actionable; "0.71 similar" is not. If the check cannot name a specific shared edit-target or heading, it reports nothing — honest silence beats a false-positive flood.

### 8. A merge action, composed from what exists

- **There is no primitive.** No merge or supersede endpoint, and no `superseded_by` column. The schema offers `plan_dependencies (plan_id, depends_on_plan_id)` (`KanbanDatabase.ts:397`) — which means "depends on", not "replaced by" — and `merged_source_databases` (`dbMerge.ts:27`), which merges whole boards. So merge must be composed:
  1. fold the loser's content into the winner, or into the feature that now owns both;
  2. record the relationship (see Outstanding Questions — there is no good home for it yet);
  3. `POST /kanban/task/complete` (`LocalApiServer.ts:4196`) the loser with `outcome: "superseded"` and `note: "superseded by <planId> — <topic>"`.
- **The note is the merge record.** Without it the loser is indistinguishable from abandoned work, which is the same confusion the 512 remnant rows already cause.
- **Never delete the loser** — same rule as remnants; it is a record until archiving runs.
- **Folding content is a judgement, not a concatenation.** The protocol proposes the pair and the direction; a human or an agent writes the merged plan.

### 9. Ask whether a plan still matches intent — do not try to infer it

- **The audit cannot know.** In the manual pass the stale extension and parity cards were only identifiable once the operator said what the current intent was — and the first two readings of it were wrong: "the extension is being deprecated" (it survives as a launcher) and "retire the parity audits" (they are migration-completeness checks, so they matter more, not less). No heuristic would have done better.
- **So the protocol asks.** It groups cards by the subsystem or framing their plans lean on (shared `src/**` subtree or shared tag — mechanical grouping), presents each group, and asks whether that work is still wanted. The operator answers; the audit acts on the answer. If more detail is needed, that is a conversation, not a lookup.
- **No register, no config, nothing to maintain** — a file of standing decisions would go stale as fast as the cards, leaving two things to keep true instead of one. The output is a short list of "is this still what you want?", never a set of cards marked obsolete.

### 9a. Check the card's premise against what shipped after it was written

**Distinct from "already shipped".** That signal asks whether the card's own subject is in the tree.
This one asks whether the *problem* still exists, because something else solved it. A card can be
entirely unimplemented and still dead.

**The worked example, dated from git.** The operator's read on this was that a lot of the file-inbox
and HTTP-surface work predates the CLI and got superseded. Two thirds right, and the remaining third
is worse:

| | date |
| :--- | :--- |
| file inbox (`writeInboxFile`, `ScheduledJobsService.ts:74`) | 2026-08-19 |
| card *Register an Agent in Any Local Terminal* created | 2026-08-24 |
| `writeMissionControlReport` (`ScheduledJobsService.ts:304`) | 2026-08-24 |
| **CLI `verb`** (`cli.ts:1776`) | **2026-08-31** |
| **CLI `next`** (`cli.ts:2078`) | **2026-09-01** |
| **CLI `api`** (`cli.ts:1853`) | **2026-09-03** |
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
since, and present the cards whose framing predates a shipped mechanism in the same area (shared
`src/**` subtree or shared tag) as a question: *"this was written before X shipped — does X answer
it?"* Do not attempt to decide. Same rule as change 9: the audit asks, the operator answers.

**And check the card's own plan file for the tell.** These cards usually quote the constraint that
has since dissolved. `register-an-agent-in-any-local-terminal.md:11` quotes *"there is no portable OS
mechanism to write into an unrelated process's stdin. This is a genuine capability gap"* — still
true, and irrelevant once the agent pulls instead of being pushed to. A quoted constraint that is
still true is not evidence the card is still needed.

### 10. Delete features through the API, never by removing the file

- **This is the cause of the 512 remnants**, and the one thing this protocol must not repeat. Removing
  a feature file with `git rm` or by hand leaves the row behind forever; `POST /kanban/feature/delete`
  (`LocalApiServer.ts:6947`, service `deleteFeature` at `KanbanProvider.ts:16012`) is the path that
  tells the board.
- **Consequence for change 3:** the desired end state sent to `features/reconcile` must express
  removals (`removeUnmentionedFeatures: true`, `KanbanProvider.ts:16762`), so the board performs them
  through `_deleteFeature` (`KanbanProvider.ts:16765`). Never delete a file and let the board find out.
- The existing residue stays (requirement 3) — this only stops new residue.
- **Enforcement is visibility, not a code gate.** `git rm` cannot be prevented in code. The audit
  detects new remnants (count delta between runs); the SKILL.md documents the rule. A remnant count
  that rises after a consolidation pass is the signal that someone deleted a file instead of using
  the endpoint.

## Verification Plan

> **Note:** For this run, compilation and automated tests are skipped per session directive. The
> checks below remain the verification contract for implementation; they are simply not executed
> in this improve pass.

### Automated Tests
- The audit writes nothing — assert the board is byte-identical after a dry run (compare `kanban.db` hash before/after, and the `GET /kanban/plans` response).
- No proposed feature spans columns — assert every cluster proposal's members share a single `kanban_column`.
- No remnant row is deleted; features are removed through `/kanban/feature/delete`, never by unlinking the file (change 10) — assert remnant count is unchanged by an audit run, and assert `removeUnmentionedFeatures` routes through `_deleteFeature` (`KanbanProvider.ts:16765`), not a file unlink.
- Every card the protocol closes has `completed_at` and a note — assert `completed_at IS NOT NULL AND note present in plan_events` for each card closed by an `--apply` run.
- `plan_file` resolves against the workspace root — assert the audit's remnant set is invariant to the process cwd (run the audit from `/tmp` and from the workspace root; same set).
- Re-running the audit after applying a cluster no longer proposes it — assert the cluster is absent from a second audit's findings.
- Two-host parity — assert the audit service is wired in both `src/extension.ts` and `src/standalone/bootstrap.ts` (composition-root seam audit, per CLAUDE.md).
- `switchboard organize --json` emits a parseable findings contract — assert `jq .` succeeds on the output.

### Goal Invariants
- `switchboard organize` is resolvable as a verb: `KNOWN_SUBCOMMANDS` in `src/standalone/cli.ts` contains `'organize'`, and a `cmdOrganize` function exists and is dispatched at an `if (process.argv[2] === 'organize')` arm.
- The `lc` command is absent: no `lc` binary, alias, or dispatch arm is introduced anywhere in `src/` or `package.json` (negative invariant — the superseded name must not survive).
- The audit service is wired in both composition roots: a `auditBoard` (or equivalent) seam is callable from `src/extension.ts` AND `src/standalone/bootstrap.ts`.
- The Organise button exists in the kanban controls strip: `src/webview/project.html` contains an element with id `btn-organize-kanban` inside the `kanban-controls-strip`.
- `plan_dependencies` is not overloaded for merge recording: no write to `plan_dependencies` with a "superseded" semantic is introduced by this plan (negative invariant — the merge record is the completion note, not a dependency edge).

**Baseline to reproduce:** on this board, 2026-09-10 — 36 loose in CREATED, 21 in PLAN REVIEWED, 512
remnants, 0 exact-duplicate topics, 5 features spanning columns.

## Outstanding Questions

- Change 9a settles half of the question below: premise-expiry belongs here, because it needs the
  operator in the loop and that is what this protocol is for.
- **[user]** Should the "already shipped" check be part of this protocol or its own? It is the most
  valuable and the least reliable — proving a plan's subject exists in the tree needs per-plan
  reasoning, not a grep. Reporting it as *candidates for verification* rather than as fact is the
  honest option. — proceeding on the assumption that it ships as a check *candidate* in this
  protocol, labelled "needs verification", not as a fact.
- **[user]** Should the audit run on a schedule and post findings, or only on demand? On demand is
  safer, but the 512 remnants accumulated precisely because nothing looked. — proceeding on the
  assumption that on-demand is the Phase 1 default and scheduling is a later decision, because a
  scheduled audit that posts findings into a channel nobody reads reproduces the "nothing looked"
  failure in a different shape.
- **[user]** **When does archiving land?** The 512 remnant rows are reported read-only (requirement
  3) and this protocol cannot cure them — it diagnoses. Without an archiving path the remnant count
  only ever rises. — proceeding on the assumption that archiving is a separate, later plan and the
  audit's remnant report is the input to it, not a substitute for it.
- **Where is a supersession recorded?** `plan_dependencies` (`KanbanDatabase.ts:397`) means "depends
  on", so overloading it would corrupt dependency reads. The completion note is readable but not
  queryable — fine for now, a problem at a hundred merges. — proceeding on the assumption that the
  completion note is the Phase 1 merge record and a queryable `superseded_by` column is a later
  schema migration if merge volume warrants it.
