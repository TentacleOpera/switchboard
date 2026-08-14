# Remove the Instruction-Inbox / Standing-Jobs / Declared-Moves Subsystem Entirely

## Goal

Delete the instruction-inbox, standing-jobs and declared-board-moves subsystem from the codebase, the database schema, the Connections panel and the generated Spark context — completely enough that grepping the repository for it returns nothing.

It is unreachable dead code: the only function that creates its directories has **no production callers**, so the subsystem has never run on any install. But it is extensively *described* — in Spark's generated context, in a Connections sub-tab, in three DB tables and in a passing test file — and that description is what matters. Every piece of residue is evidence to a future agent (or user) that Switchboard has an inbox system, and they will build on it. The removal has to leave nothing to reason from.

### Why this is a deletion and not a fix

> **Superseded:** every prior version of this plan — first "gate the declared-move channel with a default-OFF toggle, column scope, rate caps, a held-move queue and controls in Connections", then "gate on move provenance so both the file channel and `POST /kanban/move` are covered", then "retire the file channel and point its consumer at the HTTP API".
> **Reason:** all three were built on the premise that the declared-move channel is **live and dispatching coding agents right now**. Investigation on 2026-08-14 disproved it. `bootstrapInstructionsDirectory()` (`ScheduledJobsService.ts:42`) is the only code that creates `.switchboard/instructions/{inbox,claimed,standing,moves,applied}` and seeds the standing jobs, and its only callers are in `src/test/scheduled-jobs-and-connections.test.js` — eight call sites, all tests. `writeInstruction()` is the same. No production path invokes either.
>
> Everything downstream is guarded on a directory that is therefore never created: the moves watcher is inside `if (fs.existsSync(movesDir))` (`KanbanProvider.ts:891`), and `ingestJobActivity` returns early when the inbox is missing. Verified on the author's own install: **`.switchboard/instructions/` does not exist**, and `job_instructions`, `job_runs` and `board_move_requests` all hold **0 rows**.
>
> So there was never an ungated channel to gate. A user would have to hand-create `.switchboard/instructions/moves/` before a single line of that machinery could execute. Every urgency claim in the previous versions — including the ones added during review — was wrong.
> **Replaced with:** delete the subsystem. There is no behaviour to preserve, no migration to write, and no consumer to migrate.

### The actual problem: it is described far more thoroughly than it is implemented

**1. Spark is taught the whole protocol as though it were live.** `SparkContextExporter.ts:209-238` writes a `## Scheduled Jobs & Instruction Inbox Protocol` section into the uploadable context: one-shot task instructions in `.switchboard/instructions/inbox/`, claim markers at `inbox/claimed/<file>.claim` with `claimed_ts` + `agent`, a **24-hour claim lease** after which an item is `stuck` and retryable, a `result:` line written on completion, standing-job definitions with `schedule:` frontmatter that "Switchboard uses to decide cadence", a `run-log.md` whose last line is read as an **mtime cursor**, and the declared-board-moves file format. None of it is wired. The surface is instructed to claim work off a queue that nothing fills and nothing reads.

This also contradicts the same file four separate times — `:199` (*"Do not claim to have moved a card"*), `:205`, `:252` and `:256` all state that writing a plan file is the **only** permitted side effect.

**2. The Connections Jobs sub-tab presents it as a running feature.** `connections.html:461-488`:
* *"Standing background jobs scan the instruction inbox `.switchboard/instructions/` and apply declared board moves."* — describes a system with no entry point.
* A "Standing Job Definitions" list naming `memo-to-plans.md`, `nightly-code-review.md` and `research-unknowns.md`. Those names are real — `seedDefaultStandingJobs` (`ScheduledJobsService.ts:374-428`) writes those three plus `notes-to-plans.md` — but the seeder is only reachable from the uncalled bootstrap, so none of the files is ever created.
* A "Recent Job Activity" panel whose `#jobs-list` div has **no JavaScript wiring whatsoever** in `connections.js` (the only handler in that card is `regenerateSparkContext` at `:355`). It is a hardcoded string that can never change, backed by tables with no reader.

This is a PRD contract #6 violation — a panel describing capability the host has not wired — and it is the single most persuasive piece of residue.

**3. Three DB tables exist with writers and no readers.** `job_runs` (`KanbanDatabase.ts:247`), `job_instructions` (`:254`) and `board_move_requests` (`:262`). Their only writers — `recordJobRun` (`:3974`), `upsertJobInstruction` (`:4008`), `recordBoardMoveRequest` (`:3994`) — are called only from `ingestJobActivity` and `processDeclaredMoves`, both of which are being deleted. Nothing anywhere reads any of the three.

**4. A test file keeps all of it compiling and green.** `src/test/scheduled-jobs-and-connections.test.js` exercises the subsystem directly, which is why it has survived: it looks maintained.

### What this is not

**The orchestrator's inbox is a different thing and is NOT touched.** `.switchboard/orchestrator/inbox/`, `POST /orchestrator/request` (`LocalApiServer.ts:3999`), `GET /orchestrator/inbox` (`:4029`) and `_handleOrchestratorInboxRequest` (`TaskViewerProvider.ts:4962`) are the orchestrator persona's **upward request channel** — fleet agents inside worktrees filing questions to their orchestrator, drained by the persona on wake (`switchboard-orchestrator/SKILL.md:50`). It is wired, coherent, and out of scope. The two systems share only the word "inbox", and conflating them during this removal is the main hazard.

Also untouched: the board-state export (`kanban-state-<column>.md`, `setBoardStateExport`), the Spark context exporter itself and its Connections button, and the memo system.

---

## Metadata

**Complexity:** 3
**Tags:** refactor, backend, ui, docs, database
**Project:** Browser Switchboard

---

## User Review Required

**None.** Three decisions made here:

* **Total removal, not deprecation.** No compatibility shim, no feature flag, no "retired" stub. The acceptance test is that the greps in Verification return nothing.
* **No tombstone comments.** A comment reading *"the instruction inbox was removed in favour of X"* is itself residue — it tells a future agent the concept existed and invites its reconstruction. Delete the code and let git history hold the record. This is the one instruction most likely to be violated by a well-meaning implementer.
* **The three DB tables are dropped, not orphaned.** They landed 2026-08-05 (`4505876a`) in unreleased dev work — the marketplace VSIX is 1.5.9 from March 2026 — so no released version has them and this is a clean break. Leaving them in place would leave `job_instructions` and `board_move_requests` visible to anyone reading the schema, which is exactly the residue this plan exists to eliminate.

---

## Complexity Audit

* **Score:** 3 / 10

### Routine

* Deleting one whole file, one test file, three table definitions, three writer methods, two UI cards and one generated-context section.
* Removing an import and two call sites.

### Complex / Risky

* **Conflating the two inboxes.** `.switchboard/orchestrator/inbox/` must survive untouched. A grep-and-delete on the word "inbox" destroys a working subsystem. Every deletion must be checked against the explicit keep-list.
* **Residue is the whole point, so a partial removal fails the plan's purpose** even if it compiles. A leftover table, a leftover doc line, or a helpful tombstone comment reconstitutes the belief this plan exists to remove.
* **The Jobs sub-tab is not deleted wholesale** — it also hosts the Spark Context Exporter button, which is real and wired. Only the jobs fiction comes out.

---

## Edge-Case & Dependency Audit

### Race Conditions

* None introduced. The removal *eliminates* the only concurrency hazard here — two `fs.watch` events 200ms apart starting overlapping `processDeclaredMoves` runs over the same directory (`KanbanProvider.ts:892-896`), which was safe only because the `fs.rename` into `applied/` happens to be atomic.

### Security

* Not a security change and must not be described as one. The subsystem never ran. Removing it narrows the surface incidentally.

### Side Effects

* None user-visible. Nothing has ever executed, no rows exist, and no directory is created.
* Users who hand-created `.switchboard/instructions/` for experimentation keep their files; they simply stop being read (see change 1 edge cases).

### Dependencies & Conflicts

* **`src/services/ScheduledJobsService.ts`** — 443 lines, and **every export belongs to this subsystem**: `InstructionRequest`, `InstructionWriteResult`, `bootstrapInstructionsDirectory`, `writeInstruction`, `isInboxItemClaimed`, `claimInboxItem`, `getLastRunCursor`, `MoveDirective`, `processDeclaredMoves`, `ingestJobActivity`, plus the module-private `canonColumnRef`, `BUILTIN_COLUMN_REFS`, `LEGACY_PIPELINE_MANAGER_BODY`, `seedDefaultStandingJobs` and `retireLegacyPipelineManager`. Nothing in the file survives, so the file is deleted rather than edited.
* **`src/services/KanbanProvider.ts`** — the import at `:42`, the `processDeclaredMoves` / `ingestJobActivity` calls at `:886-887`, the `fs.watch` block at `:888-899`, and the `_movesFsWatchers` field with its disposal.
* **`src/services/KanbanDatabase.ts`** — `job_runs` (`:247`), `job_instructions` (`:254`) and `board_move_requests` (`:262`) DDL in `SCHEMA_TABLES_SQL`; `recordJobRun` (`:3974`), `recordBoardMoveRequest` (`:3994`), `upsertJobInstruction` (`:4008`); plus any index entries for those tables in `SCHEMA_INDEX_STATEMENTS`.
* **`src/services/SparkContextExporter.ts`** — the section at `:209-238`, its `sections.push('scheduled-jobs-protocol')`, the moves bullet at `:250`, and the comment at `:112` referencing `bootstrapInstructionsDirectory`.
* **`src/webview/connections.html`** — the two jobs cards at `:461-475` and the "Recent Job Activity" block at `:485-488`. **Keep** the "Uploadable AI Surface Context" block (`:478-483`).
* **`src/test/scheduled-jobs-and-connections.test.js`** — covers both this subsystem and Connections; split before deleting (see change 6).
* **Control-plane docs** — already clean. Grepping `.agents/` and `.claude/` for `instructions/inbox`, `instructions/standing`, `instructions/moves`, `standing job`, `claim marker` and `run-log` returns **nothing**. No skill or workflow teaches this protocol; only the generated Spark context does.

---

## Dependencies

* No session dependencies; lands against HEAD.
* **Sibling subtask (`DELETE /kanban/plans` parity)** — no shared file. That subtask edits `LocalApiServer.ts`, both hosts' option bags, and two files under `.agents/skills/`; this plan touches none of them. The two can land in any order.

---

## Adversarial Synthesis

Key risks: (1) **deleting the wrong inbox** — `.switchboard/orchestrator/inbox/` and its `POST /orchestrator/request` / `GET /orchestrator/inbox` endpoints are a live, coherent upward-request channel for the orchestrator persona and share only a word with the subsystem being removed; (2) **partial removal**, which compiles and passes review while leaving a table, a UI string or a doc line from which a future agent reconstructs the whole concept — the failure this plan exists to prevent; (3) **a tombstone comment**, the most likely well-intentioned violation, which preserves the idea in the exact place someone will read it; (4) **deleting the Jobs sub-tab wholesale** and taking the working Spark Context Exporter button with it; (5) **deleting a user's hand-created files** while removing the code that read them. Mitigations: work from the explicit keep-list in change 7; make the greps in Verification the acceptance criterion rather than compilation; forbid tombstones in the plan text and check for them in review; remove only the two jobs cards from the Jobs tab; never touch anything under `.switchboard/` on a user's disk.

---

## Proposed Changes

**Build order:** (1) source → (2) schema → (3) generated context → (4) UI → (5) drop tables → (6) tests → (7) residue sweep. The sweep is the acceptance gate, not a formality.

### 1. Delete `src/services/ScheduledJobsService.ts` and its call sites

**Implementation:**
* `git rm src/services/ScheduledJobsService.ts`. Every export in its 443 lines belongs to this subsystem; there is nothing to salvage.
* In `src/services/KanbanProvider.ts`: remove the import at `:42`; remove the `await processDeclaredMoves(folder, this)` and `await ingestJobActivity(folder, db)` calls at `:886-887`; remove the entire `fs.watch` block at `:888-899`; remove the `_movesFsWatchers` field declaration and its disposal loop.

**Logic:** the file has no production entry point, so removing it cannot change behaviour. The `setGlobalPlanWatcher` initial-scan loop keeps its plan-scan and complexity-backfill work — only the two job calls and the watcher block come out.

**Edge cases:** **do not delete anything under a user's `.switchboard/instructions/`.** If the directory exists it simply stops being read. Do not add a startup log line announcing that it is now ignored — that is a tombstone (see change 7).

### 2. Remove the three tables from the schema

**Implementation:** in `src/services/KanbanDatabase.ts`, delete the `job_runs` (`:247`), `job_instructions` (`:254`) and `board_move_requests` (`:262`) blocks from `SCHEMA_TABLES_SQL`, any matching entries in `SCHEMA_INDEX_STATEMENTS`, and the three writer methods `recordJobRun` (`:3974`), `recordBoardMoveRequest` (`:3994`) and `upsertJobInstruction` (`:4008`).

**Logic:** with `ScheduledJobsService` gone the writers have no callers, and nothing has ever read the tables. Removing them from `SCHEMA_TABLES_SQL` means a fresh database never creates them.

**Edge cases:** do **not** edit any historical `MIGRATION_Vnn_SQL` body to retro-remove these tables — shipped migration SQL is immutable, and rewriting it corrupts the upgrade chain for existing installs. Removing the tables from the forward schema plus the drop migration in change 5 is the complete change.

### 3. Strip the protocol from the generated Spark context

**Implementation:** in `src/services/SparkContextExporter.ts`:
* Delete the entire `## Scheduled Jobs & Instruction Inbox Protocol` section (`:209-238`) — Inbox & Claim Markers, Standing Jobs, Declared Board Moves, Run Log — and its `sections.push('scheduled-jobs-protocol')`.
* **Keep** the `### Kanban State Files` subsection describing `kanban-state-<column-slug>.md`; that export is a real, separately-wired feature. Relocate it under the write-back section so it survives the section deletion.
* Delete the "What to do instead" bullet at `:250` (*"write a declared board-moves file… and let the user apply it"*), leaving the research-sub-agent and plan-file bullets.
* Delete the comment at `:112` referencing `bootstrapInstructionsDirectory`.
* **Keep the exclusion list at `:243-247` exactly as written**, including *"You cannot make HTTP calls to Switchboard's LocalApiServer"*, *"You cannot run… `curl`, `wget`, `node *.js`"*, *"You cannot directly move cards, change board columns, or mutate board state"* and *"You cannot dispatch a Switchboard coding, review, orchestrator or terminal agent."* This is the intended posture for that surface: a planning-and-research worker whose only side effect is a file written to `.switchboard/plans/`. Removing the protocol brings the rest of the document into agreement with what these lines and `:199` / `:205` / `:252` / `:256` already say.

**Logic:** the surface's capabilities are defined by the file we generate for it. Removing the section removes the capability and resolves a four-times-repeated self-contradiction in the same document.

**Edge cases:** the context file is only rewritten on `regenerateSparkContext`, so an existing upload keeps the stale protocol until the user re-exports. Regenerate automatically on activation when the on-disk `.switchboard/switchboard-spark.md` still contains the `Scheduled Jobs & Instruction Inbox Protocol` heading, so a stale copy cannot outlive the code.

### 4. Remove the jobs fiction from the Connections panel

**Implementation:** in `src/webview/connections.html`, delete:
* the `conn-card` at `:461-465` ("Scheduled External Jobs & Context Exporter" + the sentence about standing jobs scanning the instruction inbox) — retitle the remaining content rather than leaving the heading orphaned;
* the "Standing Job Definitions" card at `:467-475`;
* the "Recent Job Activity" block at `:485-488`, including the unwired `#jobs-list` div.

**Keep** the "Uploadable AI Surface Context" block at `:478-483` and its `btn-regenerate-spark-context` handler (`connections.js:355`) — that is a working feature. With the jobs content gone, the sub-tab holds only the context exporter; rename the tab from **Jobs** to **AI Surfaces** (or fold it into an adjacent sub-tab) rather than leaving a tab called "Jobs" that has no jobs in it.

**Logic:** a panel describing a subsystem the host has not wired is a PRD contract #6 violation, and this one is the most convincing residue in the product — it reads as a shipped feature.

**Edge cases:** if the tab is renamed, update the `data-tab` / `data-tab-content` pair together (`:311` and the content div) — the shared tab script matches on those attributes, and changing one silently produces a tab that selects nothing.

### 5. Drop the tables from existing databases

**Implementation:** add one new forward migration — a **new** `MIGRATION_Vnn_SQL` entry, never an edit to an existing one — containing `DROP TABLE IF EXISTS job_runs; DROP TABLE IF EXISTS job_instructions; DROP TABLE IF EXISTS board_move_requests;`.

**Logic:** the tables landed 2026-08-05 (`4505876a`) in unreleased dev work; the marketplace VSIX is 1.5.9 (March 2026), so no released install has them and no user data can be lost. Dropping them is what makes the schema itself free of residue — a developer or agent running `.schema` should find no trace.

**Edge cases:** `DROP TABLE IF EXISTS` is a no-op where the tables were never created, so the migration is safe on every database including fresh ones. Do not gate the drop on a row count; the tables are provably empty because their only writers were unreachable.

### 6. Split and delete the test file

**Implementation:** `src/test/scheduled-jobs-and-connections.test.js` covers both this subsystem and Connections. Move any assertions that genuinely test Connections behaviour into the appropriate Connections test file, then `git rm` the original. Do not leave a skipped or commented-out block.

**Logic:** the test file is why the dead code looked maintained. Leaving even a `describe.skip` preserves the appearance of a real feature.

### 7. Residue sweep — the acceptance gate

**Implementation:** run the greps in Verification and confirm each returns nothing. Then check the diff for tombstones.

**No tombstone comments.** Do not write *"the instruction inbox was removed"*, *"formerly used for standing jobs"*, *"declared moves are no longer supported"*, or a `@deprecated` marker anywhere — not in source, not in the Spark context, not in the Connections panel, not in a changelog line an agent will read as a feature list. A comment explaining what used to exist is the most efficient possible way to convince the next agent it should exist again. Git history is the record.

**Explicit keep-list — do NOT delete any of these:**
* `.switchboard/orchestrator/inbox/`, `POST /orchestrator/request`, `GET /orchestrator/inbox`, `_handleOrchestratorInboxRequest`, `last-wake-complete` — the orchestrator's upward request channel.
* `.switchboard/kanban-state-<column>.md` export, `setBoardStateExport`, `setBoardStateExportRemoteUrl`.
* `SparkContextExporter` itself and its Connections button.
* The memo system (`.switchboard/memo.md`).
* `POST /kanban/move`, `move-card.js`, `POST /kanban/orchestration/dispatch`.

---

## Verification Plan

Tests are skipped per session directive, and compilation is skipped per session directive. The greps below are the acceptance criteria.

### Automated / mechanical checks

Each of these must return **no results** across `src/`, `.agents/`, `.claude/` and `scripts/`:

```
grep -rn "instructions/inbox\|instructions/standing\|instructions/moves"
grep -rn "ScheduledJobsService\|processDeclaredMoves\|ingestJobActivity"
grep -rn "bootstrapInstructionsDirectory\|writeInstruction\|claimInboxItem\|isInboxItemClaimed\|getLastRunCursor"
grep -rn "seedDefaultStandingJobs\|retireLegacyPipelineManager\|pipeline-manager"
grep -rn "job_instructions\|job_runs\|board_move_requests"
grep -rn "recordJobRun\|upsertJobInstruction\|recordBoardMoveRequest"
grep -rn "claim marker\|claimed_ts\|standing job\|run-log"
```

These must still return results (the keep-list):

```
grep -rn "orchestrator/inbox"          # orchestrator upward channel — MUST survive
grep -rn "last-wake-complete"          # orchestrator wake handshake — MUST survive
grep -rn "kanban-state-"               # board-state export — MUST survive
grep -rn "regenerateSparkContext"      # Spark exporter button — MUST survive
```

And a fresh database must contain none of the three tables, while an existing one has them dropped by the change-5 migration.

### Manual Verification

1. **Nothing regressed in the plan watcher:** open a workspace, confirm plans still import, cards still appear, and the complexity backfill still runs — the `setGlobalPlanWatcher` loop keeps everything except the two removed job calls.
2. **Regenerate the Spark context** and read it end to end. There is no inbox, no claim marker, no standing job, no run log, no board-moves section — and the exclusion list and Kanban State Files section are both intact.
3. **Connections panel:** the sub-tab shows only the AI-surface context exporter, the button still regenerates, and no card mentions jobs or the instruction inbox.
4. **Orchestrator still works:** start it from the AUTOMATION tab, confirm the kickoff prompt is delivered, and confirm `.switchboard/orchestrator/inbox/` is untouched.
5. **Schema:** run `.schema` against a fresh DB and an upgraded one. Neither mentions `job_runs`, `job_instructions` or `board_move_requests`.
6. **Tombstone check:** read the full diff. Any comment, string or doc line that explains what was removed is a defect — delete it.

---

## Recommendation

Complexity 3 → **Send to Intern.**

> **Superseded:** "Complexity 6 → Send to Coder", then "Complexity 7 → Send to Lead Coder", then "Complexity 4 → Send to Coder."
> **Reason:** each earlier score priced a system that turned out never to have run. With the gate, scope, caps, provenance threading, brake integration and audit reader all removed, what remains is a bounded deletion with an explicit keep-list.
> **Replaced with:** Complexity 3 → Intern.

This is a deletion with a checklist. The two ways to get it wrong are both listed explicitly: deleting the **orchestrator's** inbox by mistake, and leaving a tombstone comment that reconstitutes the idea. Treat the residue greps as the definition of done — compilation proves nothing here, because the subsystem never ran in the first place.

**Migration:** one new forward migration dropping three tables that no released version contains. No user data is affected; no files on disk are touched.

---

## Follow-up recorded, not planned here

**The orchestrator may be partly superseded by agent teams.** Investigation on 2026-08-14 found that `_orchestrationDispatchFeature` (`TaskViewerProvider.ts:10068`) fans out a feature to **one shared worktree and one terminal** as a single batch (cap `maxConcurrentSubtasks`, default 5), while the newer agent-teams mechanism (`teamWiring.ts`, `agentGroupInstantiation.ts`, `terminals.agentGroups`) spawns a **head with up to 8 delegate children**, auto-installs a callback standing order on each, registers the set as one terminals group with an auto-sized layout, and is host-agnostic across both hosts. Teams additionally have a structured result contract (`POST /delegates/result`, correlationIds, size caps, `resultRef`) where the orchestrator has a file inbox and an mtime handshake.

The overlap is the fan-out concern. The orchestrator's still-unique responsibilities are grouping plans into features, worktree lifecycle and merge-back, and the unattended wake cadence. The stated product direction — *"all the orchestrator needs to do is manage different agent teams"* — would keep those three and move fan-out onto the teams mechanism, retiring the orchestrator's own inbox and mtime handshake with it.

That is an architecture change with its own design surface and is **deliberately not part of this plan**. Recorded here so the finding is not lost.
