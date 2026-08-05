# Scheduled External-Agent Jobs — Instruction Inbox and Standing Jobs

## Goal

Give cron-capable external AI surfaces (Gemini Spark, Claude Cowork) a durable, file-based work queue so they can do **unattended scheduled work** against the board — process memos into plans overnight, ingest notes from their own connected sources, review coded plans nightly — without the user engaging a local agent or spending Anthropic quota.

### Problem & background

**This is the capability that separates an external surface from a terminal.** A terminal agent is synchronous, attended, and on the Anthropic quota pool. Spark and Cowork have their own cron scheduling, their own quota, and their own data sources (Spark reaches Google Drive; Switchboard never sees it). That combination — *unattended, scheduled, different quota, different inputs* — is not something a terminal can be made to do, and it is the reason to build for these surfaces at all rather than treating them as a slower terminal.

The concrete jobs this unlocks:
* **Memo → plans on a schedule.** The user dumps thoughts into the memo and never opens the memo planner; an overnight pass turns each entry into a plan file.
* **External notes → plans.** The user writes into a Google Drive doc; Spark processes it daily into plans. Switchboard has no Drive integration and needs none — the document is the external agent's own connected source, and only the output lands in `.switchboard/plans/`.
* **Nightly code review.** Every plan sitting in a coded column gets reviewed overnight, so the morning board already carries findings.

**Root cause: there is no durable work queue an external agent can poll.** Everything Switchboard offers a filesystem-only agent today is *pull on demand* — a prompt the user copies at the moment they want work done. There is nowhere to leave standing instructions, and nothing that survives between an agent's scheduled runs.

**Two enablers already exist and are the reason this plan is small.**

1. **The board is already mirrored to files a filesystem-only agent can read.** `.switchboard/kanban-state-<column>.md` exists per column (`created`, `coded`, `coder-coded`, `intern-coded`, `lead-coded`, `code-reviewed`, `acceptance-tested`, `completed`, `backlog`, `orchestrating`, and role columns). Each entry is fully machine-readable — verified format:
   ```
   - [<absolute plan path>](<absolute plan path>) — <title> <!-- planId:<uuid> subtask-of:"<feature>" project:"<project>" -->
   ```
   So "find everything in CODED and review it" needs no API, no database and no HTTP. It needs one file read.
2. **The inbox-with-`processed/` pattern is already implemented and proven** at `TaskViewerProvider.ts:4475-4517` (`_handleOrchestratorInboxRequest`): bootstrap `inbox/` + `processed/`, write `req-<compactUTC>-<stage>-<rand5>.md` with YAML frontmatter whose values are newline-flattened so a clumsy body cannot forge keys, free-form body below the closing `---` and never parsed. The reader (`_handleGetOrchestratorInbox`, `LocalApiServer.ts:2460-2479`, route at `:3595`) skips the `processed` directory and tolerates a missing inbox by returning empty. This plan mirrors that structure rather than inventing one.

**Why a separate directory from the orchestrator inbox.** `.switchboard/orchestrator/inbox/` carries requests flowing *inward* from fleet agents *to* the orchestrator, and `GET /orchestrator/inbox` returns every file in it that is not `processed`. Dropping external-agent instructions there would surface them to the orchestrator as fleet requests. Same pattern, different channel.

> ### Amended after design review (2026-08-05) — wire vs record, mirror freshness, and board-state jobs
>
> Three clarifications came out of review. They extend the plan; they do not change its file-based core.
>
> **Files are the wire, the DB is the record.** Every file in this plan exists because one endpoint of the channel is a filesystem-only external agent. Spark and Cowork can read and write files via folder access; they cannot open `kanban.db`, and they must never be given direct write access to it (raw SQL bypasses validation, derived-state triggers and the audit trail — and AGENTS.md already forbids direct column SQL for *local* fleet agents). A dedicated agent-writable DB was considered and rejected: DuckDB's single-writer model cannot serve multi-process IPC, and SQLite authorship requires local code execution, which Spark does not have (user-confirmed 2026-08-05). So files remain the exchange format — but Switchboard ingests job activity (runs, claims, moves) into kanban-db tables for the UI, following the `PlanIngestionEngine` precedent of watch-`.md`-upsert-row. The metadata-into-DB direction is honoured on Switchboard's side of the boundary; the wire side stays files.
>
> **The board mirror is frozen between Switchboard sessions.** `kanban-state-<column>.md` is DB-export-driven (written at `KanbanDatabase.ts:8761`), so it only regenerates while Switchboard runs. Consecutive unattended cron runs with Switchboard closed compound drift: night 1's `memo-to-plans` output is absent from the mirror night 2's `nightly-code-review` reads. The primary mitigation is **operational**: leave Switchboard running during scheduled windows (an idle VS Code window or `npx switchboard`) — imports land live, the mirror re-exports, the board updates in real time (`KanbanProvider.refreshIfShowing`; standalone `pushFullState` at `bootstrap.ts:417-419`). The safety net for the closed case is a per-job **last-run cursor** in the run-log plus a filesystem mtime scan (Proposed Changes §3). The activation-time scan (`KanbanProvider.ts:800-811`) reconciles the DB on next open and the export rides that path, so the mirror is never stale *after* a session — only *between* them.
>
> **Jobs that produce board state, not files.** The v1 rule "external agents produce artifacts, never board state" blocks a legitimate job class — e.g. *"manage all plans from planned → coded → reviewed using subagents"* — whose output IS column transitions. This plan now covers it via **declared-intent moves**: the agent writes a moves *file* declaring `planId → column` intent; Switchboard validates each line (planId exists, column exists, transition legal) and applies it through the same move-card path a human click uses. The agent proposes; Switchboard disposes. Direct DB writes stay forbidden.

---

## Metadata
**Complexity:** 7
**Tags:** feature, backend, infrastructure, reliability
**Project:** browser-switchboard

---

## User Review Required

**None.** Three decisions made here:

* **Two directories, not one.** `.switchboard/instructions/inbox/` for one-shot instructions that are consumed, and `.switchboard/instructions/standing/` for recurring job definitions that are re-read every run and never consumed. A single folder cannot hold both — a standing job dropped in an inbox gets marked done on its first run and never fires again.
* **Completion is marked, not moved.** The agent writes a marker rather than relocating the file. Detailed below; the short reason is that "move" requires delete permission an external surface may not have been granted.
> **Superseded:** External agents produce artifacts, never board state. A scheduled job writes plan files and review content. It does not move cards, dispatch agents, or link features — it cannot reach the API, and it must not be told to fake it.
> **Reason:** too broad — it blocks the legitimate "pipeline manager" job class whose work product is column transitions, leaving cards stuck in NEW while the work is actually done. The blanket ban conflated *direct* mutation (always forbidden) with *declared* intent (safe, because Switchboard validates and applies it).
> **Replaced with:** **External agents never mutate board state directly — they declare it.** A job writes a moves file (`.switchboard/instructions/moves/`) listing `planId → column` intent; Switchboard validates every line and applies legal moves through the human-click path, skipping and logging invalid ones. Direct DB writes, API fabrication, and claims of having moved cards remain forbidden — the moves file is the only channel, and Switchboard is the only executor.

---

## Complexity Audit
* **Score:** 7 / 10 — raised from 6 after the design-review amendments added a DB migration (job-activity tables), a board-mutating apply path (declared moves), and a second watcher family.

### Routine
* Creating two directories following an existing bootstrap pattern.
* Writing instruction files with the same frontmatter shape already implemented for the orchestrator inbox.
* Documenting the polling contract in the `switchboard-spark` context artifact.

### Complex / Risky
* **Idempotency is the whole correctness story.** A cron agent that cannot tell "already done" from "new" reprocesses its inbox on every tick. That is not a cosmetic bug: each reprocess spends quota and, for a memo-to-plans job, creates duplicate plan files on every run until someone notices. This is the single thing most likely to go wrong.
* **The completion mechanism depends on a permission we do not control.** Moving a file to `processed/` means read + write + **delete**. Spark's Connected Folders grants folder access, but whether delete is included is unverified. A design that assumes delete and silently lacks it produces exactly the runaway-reprocessing failure above.
* **Unattended writes with no supervision.** A scheduled job producing malformed plans at 3am fills the board with junk that the watcher imports faithfully. There is no review step by construction.
* **Concurrency with local work.** A nightly review pass reading a plan file while a local agent edits the same file. No locks exist; the plan watcher is last-write-wins.
* **The standing-job format is a small language.** It must be expressive enough for "review everything in these columns" and constrained enough that a model reads it the same way twice.

---

## Edge-Case & Dependency Audit

### Race Conditions
* **Reprocessing on overlapping runs.** A long job still running when the next cron tick fires sees the same un-marked inbox items and starts them again. Mitigation: the agent writes its marker **on claim, not on completion**, carrying a timestamp, and skips items claimed within a staleness window. Accept the cost: a job that dies mid-run leaves a claimed-but-unfinished item that needs the window to expire before it retries.
* **External write vs. local edit.** A review pass appending to a plan file that a local agent is rewriting. Do not add locking. Scope standing jobs to columns that are quiescent by definition — a plan awaiting review is not being coded — and say so in the job-definition guidance.
* **Watcher import mid-write.** An external agent writing a plan in chunks can be imported truncated. `GlobalPlanWatcherService` already handles the general case for local writers; verify behaviour under a slow external write rather than assuming.

### Security
* **Instruction files are inputs to an unattended agent — treat them as a code path, not as notes.** Reuse the orchestrator inbox's guard exactly: frontmatter values newline-flattened so a body cannot forge keys, body below the closing `---` never parsed as directives.
* **No secrets in instructions or job definitions.** They are read by a third-party AI service. Same rule as the `switchboard-spark` artifact.
* **The blast radius of a standing job is whatever the external agent can write.** It has folder access to the workspace. A job definition saying "review plans" cannot technically be prevented from writing source files. State the boundary explicitly in the job guidance; do not pretend it is enforced.

### Side Effects
* **Plans appear on the board with no human in the loop.** That is the feature. It also means a misconfigured job is a board-flooding mechanism. The generated guidance should recommend starting with one job on a daily schedule before adding more.
* Two new directories under `.switchboard/`. **Create them lazily, on first use, and only in workspaces that already have a `.switchboard/`** — never eagerly on activation. Eager creation is the documented scaffold-litter failure.

### Dependencies & Conflicts
* **Pattern to mirror — `src/services/TaskViewerProvider.ts:4475-4517`** (`_handleOrchestratorInboxRequest`): directory bootstrap, filename shape, frontmatter flattening, unparsed body.
> **Superseded:** Reader precedent — `src/services/LocalApiServer.ts:2416-2434`: skips `processed`, tolerates a missing directory by returning empty.
> **Reason:** wrong line range — `:2416-2434` is the tail of the protocol-catalog handler and `_handleGetPlans`. The inbox reader is `_handleGetOrchestratorInbox` at `:2460-2479` (`if (f === 'processed') continue;` at `:2468`; missing-directory → empty via the bare `catch` at `:2476`), served at route `/orchestrator/inbox` (`:3595`).
> **Replaced with:** **Reader precedent — `_handleGetOrchestratorInbox`, `src/services/LocalApiServer.ts:2460-2479`**: skips `processed`, tolerates a missing directory by returning empty.
* **Board mirror — `.switchboard/kanban-state-<column>.md`**, format verified above. This is the read surface for every standing job; treat its line format as a contract this plan now depends on. **Freshness bound:** written by the DB export at `KanbanDatabase.ts:8761`, frozen between Switchboard sessions — see the mtime supplement in §3 and the activation-scan reconcile at `KanbanProvider.ts:800-811`.
* **Move apply path — `POST /kanban/move` / the KanbanProvider move handler.** Declared moves are applied through this path only, so feature recomputation, mirror re-export, provider sync and broadcasts all fire normally.
* **Sibling — `switchboard-spark` context artifact** (`feature_plan_20260805130000_…`). The polling contract, the marker protocol and the board-mirror format must be documented **in that artifact**, because the scheduled agent's only knowledge of Switchboard comes from it. That plan's generator gains a section; this plan defines its content.
* Memo path — `TaskViewerProvider.ts:4674`; the memo-to-plans job reads it and the sibling watcher plan makes the result visible without a reload.
* Plan watcher — `GlobalPlanWatcherService.ts:141, 186`.
* **Not a dependency:** the Connections panel. This machinery ships without UI; the Jobs tab arrives in its own sibling plan (`feature_plan_20260805153000_…`), which reads the job-activity store this plan creates.

---

## Dependencies
* None blocking. Sequencing: the `switchboard-spark` artifact is where this contract gets published to the agent, so land that first or in parallel.

---

## Adversarial Synthesis

Key risks: (1) **runaway reprocessing** — a cron agent with no reliable done-marker re-runs its whole inbox every tick, spending quota and duplicating plan files until a human notices, and the obvious mechanism (move to `processed/`) needs a delete permission the external surface may not have; (2) **unsupervised junk at scale** — there is no review step, so a malformed job quietly fills the board overnight; (3) **board-truth staleness** — the `kanban-state-<column>.md` mirror is DB-export-driven and frozen between Switchboard sessions, so unattended chains read day-old state, and (before the moves mechanism) jobs whose product is column transitions left cards stuck in NEW; (4) **contract drift** — the mirror line format is an internal detail nothing pins. Mitigations: mark on claim with a timestamp and staleness window using write-only markers; ship one daily job first and document scaling up; treat the mirror as column truth *as of the last session* and supplement with an mtime scan against the run-log cursor, with leave-Switchboard-open as the operational primary; declared-intent moves for board-state jobs — agent proposes in a strict-grammar file, Switchboard validates and applies through the human-click path, direct DB writes stay forbidden; pin the mirror format with a test and publish it in the `switchboard-spark` artifact.

---

## Proposed Changes

**Build order:** (1) directory contract + marker protocol → (2) instruction writer → (3) standing-job format and the shipped examples → (4) declared-intent moves → (5) job-activity store → (6) publish the contract into the Spark artifact.

### 1. `.switchboard/instructions/` — the directory contract

```
.switchboard/instructions/
  inbox/                     one-shot instructions
    claimed/                 claim markers, one per inbox item
  standing/                  recurring job definitions, never consumed
  moves/                     declared-intent board moves (agent-written)
    applied/                 moves files Switchboard has processed
  run-log.md                 append-only: one line per job run
```

**Implementation:** bootstrap lazily via the `TaskViewerProvider.ts:4491-4492` pattern (`mkdir(..., {recursive:true})` on first write), and only when `.switchboard/` already exists.

**The run-log protocol:**
* On completing any run (standing job or inbox item), the agent **appends one line** to `run-log.md`: ISO timestamp, job name, what it read, what it wrote (counts + paths), one-line result. Append-only, never rewritten.
* Each job reads **its own last line** as its last-run cursor — the basis of the mtime supplement in §3.
* The run-log is machine-consumed, not decorative: Switchboard ingests it into the job-activity store (§6) on watch/next-open, which is what the Jobs tab (sibling plan) renders — including "N jobs ran while Switchboard was closed."

**The marker protocol — the load-bearing detail:**
* To claim `inbox/foo.md`, the agent **writes** `inbox/claimed/foo.md.claim` containing an ISO timestamp and an agent identifier.
* Before processing anything, it skips any item with a claim newer than the staleness window (default 24h, stated in the job guidance).
* On completion it appends a result line to the same claim file. It never needs to delete or move anything.

**Logic:** write-only means the protocol works under read+write access alone. A `processed/`-move design silently degrades to infinite reprocessing on a surface without delete, and that failure is invisible until the duplicate plans pile up.

**Edge cases:** a crashed run leaves a claim with no result; it retries after the window expires. Document that a stuck item is cleared by deleting its claim file — a human action, in the UI or the filesystem, not something the agent does.

### 2. Instruction writer

**Implementation:** a function mirroring `_handleOrchestratorInboxRequest` — same filename shape (`instr-<compactUTC>-<kind>-<rand5>.md`), same YAML frontmatter with newline-flattened values, same never-parsed body. Frontmatter carries `kind`, `created`, and optionally `planId` / `feature`.

**Edge cases:** the writer is not the point of this plan and needs no UI yet; a user can drop a markdown file into `inbox/` by hand and it must work. Make the hand-written path first-class — malformed or missing frontmatter degrades to "treat the whole file as the instruction body", never an error.

### 3. Standing-job format, and the three jobs to ship

A job definition is one markdown file in `standing/` with frontmatter:

```yaml
---
job: memo-to-plans
schedule: daily            # advisory — the schedule lives in the agent's own cron
reads: .switchboard/memo.md
writes: .switchboard/plans/
---
```

Body: what to do, in the imperative, referencing the protocol the Spark artifact already carries.

**Ship four, matching the stated use cases:**

| Job | Reads | Writes | Notes |
|---|---|---|---|
| `memo-to-plans` | `.switchboard/memo.md` | `.switchboard/plans/` | one plan per entry; clears the memo on success, matching the local memo protocol |
| `notes-to-plans` | *(the agent's own connected source — a Drive doc, named by the user in the body)* | `.switchboard/plans/` | Switchboard never sees the source; only the output lands here |
| `nightly-code-review` | `.switchboard/kanban-state-coded.md` (+ `coder-coded`, `intern-coded`, `lead-coded`) | review content appended to each plan file | **does not move cards** — the user or a local pass advances them |
| `research-unknowns` | `.switchboard/kanban-state-created.md` | `## Uncertain Assumptions` in each plan file | dispatches the agent's **own** research sub-agents for each unknown and folds the findings back in — see below |
| `pipeline-manager` | mirror + mtime scan (all active columns) | plan files + **declared moves** in `instructions/moves/` | the board-state job class: advances work through planned → coded → reviewed using its own subagents, declaring every transition for Switchboard to validate and apply |

> **Superseded:** `nightly-code-review` is the job that proves the board mirror is sufficient. It parses plan paths and planIds straight out of the state file's `<!-- planId:… -->` comments, opens each plan file, and appends findings. No API, no database.
> **Reason:** the mirror is DB-export-driven (`KanbanDatabase.ts:8761`) and frozen between Switchboard sessions, so it is NOT sufficient for unattended chains — consecutive cron runs with Switchboard closed read day-old board truth and miss plans created since the last session.
> **Replaced with:** **every column-reading job combines two sources.** (1) The mirror, for column membership as of the last Switchboard session — parsing plan paths and planIds from the `<!-- planId:… -->` comments, no API, no database. (2) A filesystem scan of `.switchboard/plans/*.md` filtered to mtime **newer than the job's own last-run cursor** in `run-log.md`, catching anything created while Switchboard was closed. The scan is cheap, correct in both the open and closed cases, and depends on nothing Switchboard-side being alive.

**`research-unknowns` is the job that exploits a capability the local pipeline does not have.** Switchboard's `advise_research` directive today either POSTs to `/research/dispatch` when a Researcher agent is registered, or falls back to leaving a ready-to-run research prompt in the chat for the user to run (`agentPromptBuilder.ts:744, 747`). In most workspaces no Researcher is registered, so uncertainties accumulate as unrun prompts. An external surface that can dispatch its own research sub-agents can simply resolve them — unattended, overnight, on its own quota. The job walks new plans, finds their `## Uncertain Assumptions` items (and any assumption the plan asserts without a citation), researches each, and rewrites the section marking items resolved with findings or still open with why.

**Edge cases for this job specifically:** it must **rewrite the section in place, not append** — a nightly job that appends grows an unbounded research log in every plan. It must be idempotent against already-resolved items: an assumption already marked resolved is skipped, not re-researched, or every night costs a full research pass per plan in CREATED. And it must not silently delete an item it failed to resolve — unresolved stays unresolved, with a note.

**Edge cases:** every job body must state the project-pinning rule — the agent does not guess a `**Project:**` pin and omits it when it has none. An external agent cannot resolve the active project, and a guessed pin is silently dropped to unassigned at import.

### 4. Declared-intent board moves — the agent proposes, Switchboard disposes

**Context:** some jobs' work product is column transitions, not files. The agent can never touch `kanban.db` (validation, derived-state triggers and audit all live in Switchboard's move path, and direct SQL is forbidden even for local fleet agents). So board changes are *declared* as files and *applied* by Switchboard.

**The moves grammar — deliberately tiny and strict:**

```yaml
# .switchboard/instructions/moves/moves-<compactUTC>-<rand5>.md
---
kind: board-moves
job: pipeline-manager
created: 2026-08-06T03:00:00Z
---
- planId: 6d42449c-21bd-4649-9e50-8de29eadc26a  to: CODED
- planId: 11034208-d73a-4652-bed2-b5c00500491c  to: CODE REVIEWED
```

Body lines below the frontmatter, one move per line; anything not matching the grammar rejects the **file** (skipped + logged), never a partial guess.

**Apply path (Switchboard-side):** watch `instructions/moves/` through the same watcher family as plans (host seam + native fallback), and sweep it on activation alongside the plan scan (`KanbanProvider.ts:800-811` precedent). For each unprocessed file, validate every line — planId exists in the kanban DB, target column is a real column, the transition is legal — then apply legal moves through the **same move-card path a human click uses** (`POST /kanban/move` / the KanbanProvider move handler), so feature recomputation, mirror re-export, provider sync and broadcasts all fire normally. Move the file to `moves/applied/` when done (Switchboard has delete; the agent never needs it). Record per-line outcomes in the job-activity store (§5): applied, or skipped with the reason.

**Logic:** live when Switchboard is running (seconds after the agent writes), reconciled on next open when it was closed. Either way nothing is stuck in NEW, and every move carries an auditable record — the file itself, plus its DB outcome rows.

**Edge cases:** a move racing a human's local move is last-writer-wins through the same validated path — acceptable, both are legitimate actors. A move for a planId that no longer exists is skipped, not erroring the batch. Duplicate declarations of the same move are idempotent (the second is a no-op because the card is already there).

### 5. Job-activity store — DB as the record

**Context:** files are the wire; the UI needs queryable history. Precedent: `PlanIngestionEngine` watches `.md` files and upserts DB rows — the board reads the DB, never the files.

**Implementation:** add job-activity tables to the kanban DB (migrations through `KanbanDatabase`, honouring the metadata-into-DB direction): `job_runs` (ts, job, summary, source = run-log line), `job_instructions` (file, status pending/claimed/done/stuck, claimed_ts, agent, result), `board_move_requests` (file, planId, to_column, status applied/skipped, reason, ts). An ingestion pass — riding the same watcher/activation-scan path as §4 — parses `run-log.md` appended lines, claim files, and applied moves files into these tables. The Jobs tab (sibling plan) queries the tables, never the raw files.

**Edge cases:** ingestion must be idempotent against re-reads (cursor or content hash per source file). A malformed wire file is skipped and logged with its name — the parse failure is visible, never silent.

### 6. Publish the contract into the `switchboard-spark` artifact

**Implementation:** the sibling plan's generator gains a section covering: the full `instructions/` directory tree, the claim-marker protocol with the staleness window, the run-log line format (and the rule that a job reads its own last line as its cursor), the `kanban-state-<column>.md` line format **plus its frozen-between-sessions caveat and the mtime supplement**, the moves grammar from §4, and the standing-job frontmatter shape. Add a "check your instruction folder" opening so a cron prompt can be as short as *"Follow your Switchboard context and process your instruction folder."*

**Operational guidance for the user, stated in the panel copy and the artifact's preamble:** for scheduled runs, leave Switchboard running (an idle VS Code window or `npx switchboard`) — imports, the mirror and the board then stay live, and declared moves apply within seconds. The file protocol degrades gracefully when it is closed; it is just better when it is open.

**Edge cases:** this section is what a cron agent reads at 3am with nobody watching. It must state the boundaries in the imperative — no direct DB access, no card moves except through declared moves files, no dispatch of Switchboard agents, no feature linking, no shell, no invented API calls — because omitting a capability invites the model to invent it and report success. Dispatching its **own** subagents (research, coding) is expected; claiming to have moved a card directly is a contract violation.

---

## Verification Plan

### Automated Tests
Tests are skipped per session directive, and compilation is skipped per session directive. Target coverage for the coding pass:
* Instruction-writer tests mirroring the orchestrator inbox's: frontmatter flattening blocks key forgery from a multi-line body; filenames are unique under rapid succession.
* **A board-mirror format test** asserting `kanban-state-<column>.md` lines still carry a parseable absolute path and `planId`. This plan makes an internal detail into a contract; pin it.
* A claim-protocol test: a claimed item inside the staleness window is skipped; outside it, retried.

### Manual Verification
1. **Lazy creation:** the directories appear on first use and **not** on activation in a workspace that has never used the feature.
2. **Hand-dropped instruction:** a plain markdown file with no frontmatter dropped into `inbox/` is treated as an instruction body, not an error.
3. **Claim protocol, no delete:** with a folder grant that allows read and write but **not** delete, the agent claims, processes and records a result. Confirm no second processing on the next run — this is the test that validates the central design decision, so run the agent twice.
4. **`memo-to-plans` end to end:** write memo entries, let the scheduled job run, confirm one plan file per entry, correct structure, **no invented `**Project:**` pin**, and cards on the board after the watcher imports.
5. **`nightly-code-review` end to end:** put plans in a coded column, run the job, confirm findings are appended to the right plan files and that **no card has moved**.
6. **Reprocessing negative control:** run the same job twice with no new input. The second run must produce nothing — no duplicate plans, no duplicate review sections, no re-researched assumptions.
7. **`research-unknowns` end to end:** put a plan with genuine unknowns in CREATED, run the job, confirm `## Uncertain Assumptions` is **rewritten in place** with findings, that resolved items are not re-researched on the second run, and that items it could not resolve survive with a reason rather than being dropped.
8. **Stuck claim:** kill a run mid-job; confirm the item retries only after the staleness window, and that deleting the claim file clears it immediately.
9. **Boundary honesty:** inspect a run's output for claims of actions it cannot perform — moved cards, dispatched *coding* agents, database queries. Any such claim means the guidance section is not explicit enough. Note the asymmetry: dispatching its **own research sub-agents** is expected and encouraged; dispatching a Switchboard agent is impossible and must never be claimed.
10. **Stale-mirror supplement:** with Switchboard closed, create a plan file externally (simulating night 1), then run `nightly-code-review` (night 2) **without opening Switchboard**. The new plan must be picked up via the mtime cursor despite being absent from the mirror.
11. **Declared moves end to end:** drop a moves file with one valid and one invalid line (bad planId). With Switchboard running, the valid move applies within seconds through the human-click path (mirror re-exports, board updates); the invalid line is skipped and logged with a reason, visible in the job-activity store. Repeat with Switchboard closed and confirm apply-on-next-open.
12. **Job-activity ingestion:** run a job, confirm `job_runs` / `job_instructions` rows appear, and that a second ingestion pass creates no duplicates.
13. **Plan import:** confirm the importer registers this plan on the board.

---

## Scope note — the provider lane (documented variant, not v1)

For users with Remote Control configured, a second transport exists. Spark and Cowork reach Notion / Linear / ClickUp through their own integrations, and Remote Control's ingest/full modes already reconcile provider-side changes on startup and on poll — including, in full mode, column state. A standing job naming the provider as its surface (`reads: notion:jobs-inbox`) would have **no staleness class at all**: the provider is fresh for the 3am agent and fresh for the next Switchboard session, and cards moved on the provider board reconcile through shipped sync machinery.

It is a variant, not a replacement, because it is conditional on provider setup (the file lane is zero-setup), it puts a third party's uptime and rate limits inside the unattended loop, and representing non-plan job outputs (reviews, run records) as provider items needs conventions that deserve their own design pass. Record the lane in the artifact's job guidance as "preferred where configured"; implementing its conventions is a separate plan.

---

## Recommendation

Complexity 7 → **Send to Lead Coder.** (Raised from 6 → Coder when the moves apply path and job-activity store were added: the plan now mutates board state and owns a DB migration, both Lead-Coder territory.)

---

## Review Findings

**Roughly a fifth implemented, and unreachable.** `src/services/ScheduledJobsService.ts` delivers directory bootstrap, an instruction writer and four seeded standing-job files — with **zero callers**, so nothing bootstraps, writes or reads. Four CRITICALs beyond that: the **claim-marker protocol** (§1) is absent — `claimed/` is created but nothing writes or reads a claim and there is no staleness window, leaving the runaway-reprocessing failure the plan called "the single thing most likely to go wrong" completely unguarded; **declared-intent moves** (§4) are absent — `moves/` is created and never watched, validated or applied, so the board-state job class silently does nothing; the **job-activity store** (§5) is absent — no `job_runs` / `job_instructions` / `board_move_requests` tables and no migration (the +31 lines in `KanbanDatabase.ts` are unrelated column-label work); and `run-log.md` is never created or ingested, so the per-job cursor and the mtime supplement that answers the frozen-mirror problem do not exist. MAJOR: `bootstrapInstructionsDirectory` violates the plan's explicit lazy rule — it `mkdir -p`s the whole tree (creating `.switchboard/` itself if absent) and eagerly seeds four job files on every call with no "only when `.switchboard/` already exists" guard, which is the documented scaffold-litter failure; `notes-to-plans` is missing from the seeded set. No fixes applied — this is the Lead-Coder implementation the plan scoped, not a defect to repair in review; validation was `tsc --noEmit` and `npm run lint` (both pass), and the plan's instruction-writer, claim-protocol and board-mirror-format tests do not exist.

### Second review pass (post-coder)

**Still not functional.** The three job-activity tables were added to `SCHEMA_TABLES_SQL` (`KanbanDatabase.ts:207-230`) and do reach existing installs, since that DDL is `CREATE TABLE IF NOT EXISTS` and re-executes on every existing-DB open (`:6380`) — no migration defect, though peers such as `MIGRATION_V52_SQL` also add a belt-and-braces migration entry. `processDeclaredMoves` and `ingestJobActivity` were written, and both still have **zero callers**, so nothing watches `moves/`, nothing sweeps on activation and nothing ingests. Four defects in the new code: (1) moves are applied via `db.movePlanToColumn(planId, toColumn)` — **a method that does not exist on `KanbanDatabase`** — so the `typeof … === 'function'` guard makes every declared move silently record `skipped / "Plan or column not found"`; (2) even if it existed, that is a direct DB write, not the human-click path (`POST /kanban/move`) the plan mandates, so feature recomputation, mirror re-export, provider sync and broadcasts would all be skipped; (3) no validation of planId existence, column existence or transition legality, and no column canonicalisation, while the plan's "a non-matching line rejects the **whole file**" rule is inverted — bad lines are skipped silently and the file is still moved to `applied/`; (4) `ingestJobActivity` relies on `INSERT OR IGNORE` for idempotency, but `job_runs` has no UNIQUE constraint, so every pass duplicates every run-log line. The claim-marker protocol and the mtime cursor remain unimplemented, and `bootstrapInstructionsDirectory` still eagerly creates the tree and seeds four job files — now called unconditionally at the top of both new functions, so merely ingesting would scaffold a workspace.

### Third review pass (post-coder)

**Now wired and, after this pass, actually functional.** `processDeclaredMoves` / `ingestJobActivity` are called from the activation scan (`KanbanProvider.ts:812-813`); the lazy `.switchboard` guard, the claim-marker protocol with staleness window (`isInboxItemClaimed` / `claimInboxItem`), `getLastRunCursor` and whole-file rejection on a malformed line all landed correctly. Three defects made the feature a no-op and are fixed here. (1) **Moves were keyed on the wrong identifier:** `KanbanProvider.moveCardToColumn(root, sessionId, col)` looks the row up with `getPlanBySessionId`, and the service passed a `planId` — no row matched, so every declared move returned false and recorded as skipped; it now resolves `getPlanByPlanId` first and routes file-based plans (`session_id = ''`) through `moveCardToColumnByPlanFile`. (2) **`db.run` / `db.all` do not exist on `KanbanDatabase`** — it exposes no generic query API, so the outcome rows and the run-log ingestion wrote nothing at all and the three tables stayed empty forever; added `recordJobRun` (owning the dedup check, since `job_runs` has no UNIQUE constraint and `INSERT OR IGNORE` therefore never ignores), `recordBoardMoveRequest` and `upsertJobInstruction` as the sanctioned writers. (3) **`VALID_COLUMNS` was a hand-listed set** that mixed formats and contained `CODED`, which is not a built-in column id, while omitting `RESEARCHER`, `PLAN REVIEWED` and `TICKET UPDATER`; it now derives built-ins from `DEFAULT_KANBAN_COLUMNS`, canonicalises refs the way `LocalApiServer` does, and validates custom columns against the live board. **Note for the Spark artifact:** the moves grammar published to the agent uses `to: CODED`, which validates only where the board actually has that column.

**Two gaps found after the fixes above, still open.** (1) **Declared moves apply on the activation sweep only.** `processDeclaredMoves` is called from one place — `KanbanProvider.ts:813`, inside the activation/plan-scan path — so a moves file written while Switchboard is running does not apply until the next open. §4 of this plan specifies **both**: a watcher over `instructions/moves/` through the same watcher family as plans (host seam + native fallback) *and* an activation sweep. Only the sweep exists, so the "live when Switchboard is running (seconds after the agent writes)" behaviour the plan promises is absent, and the operational guidance to "leave Switchboard running during scheduled windows" currently buys nothing for moves. (2) **`upsertJobInstruction` has no caller.** The method exists and `job_instructions` has its UNIQUE key, but nothing walks `inbox/` and `inbox/claimed/` to upsert lifecycle rows — so pending / claimed / done / **stuck** never reaches the DB. `job_runs` and `board_move_requests` are populated; the inbox table stays empty, which means the Jobs tab plan (`feature_plan_20260805153000_…`) will render an empty inbox lifecycle even once it lands. Also still open from the original scope: `notes-to-plans` is not among the seeded standing jobs, and the mtime supplement is implemented as `getLastRunCursor` but no job body consumes it.
