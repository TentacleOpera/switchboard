# Connections Jobs Tab — Standing Jobs, Inbox Lifecycle and Run-Log View

**Feature:** 1dafe7bf-13b4-4360-93e3-ecfdf4ce5f4b

## Goal

Give the Connections panel's **Jobs** sub-tab real content: a read-mostly activity view over the external-agent job machinery — standing-job definitions, inbox lifecycle (pending / claimed / done / stuck), declared-move outcomes, and run history — plus the three write actions the machinery already defines (drop an instruction, clear a stuck claim, copy the cron prompt).

### Problem & background

**The jobs machinery is deliberately headless — but headless is not the same as invisible.** The sibling plan *Scheduled External-Agent Jobs* ships the file-based protocol (`.switchboard/instructions/` inbox, standing jobs, claim markers, declared moves, run-log) with no UI, ingesting activity into kanban-db tables (`job_runs`, `job_instructions`, `board_move_requests`). Without this tab, the only way to answer "did the overnight job run? what did it do? why is this item stuck?" is hunting through a hidden directory by hand — and the stuck-claim remediation path in that plan already names the UI as the intended place for it ("a human action, **in the UI** or the filesystem").

**Root cause of the gap in the panel plan.** The Connections panel's sub-tab table lists **Jobs** with its source as "sibling plan" — but the machinery plan explicitly disclaims UI. This plan is the third leg: panel builds the container, machinery builds the protocol, this fills the tab.

**What the tab deliberately is not.** It is not a control surface. Nothing here starts, stops, or triggers a run — no push channel to Spark/Cowork exists (resolved assumption, 2026-08-05), so a "run now" button would be a dead control under PRD contract #6. The schedule lives in the external agent's own cron; the tab shows the *advisory* schedule from each job definition and the *actual* history from the run-log. It also shows **last run**, not "next run" — next run is unknowable by construction and the tab must not fake it.

**Why the tab reads the DB, not the files.** The machinery plan's files-as-wire/DB-as-record split: agents write files (universal capability), Switchboard ingests into `job_runs` / `job_instructions` / `board_move_requests`. This tab queries those tables, exactly as the board queries plan rows rather than parsing `.md` files. A tab that re-parses wire files would fork the ingestion logic and see unvalidated state.

---

## Metadata
**Complexity:** 5
**Tags:** ui, ux, frontend, backend, feature
**Project:** browser-switchboard

---

## User Review Required

**None.** Decisions made here:

* **Read-mostly, three write actions only:** drop an instruction (textarea → instruction writer), clear a stuck claim (delete the claim file — the machinery plan's documented remediation), copy the cron prompt (existing `copyTextToClipboard` verb). Anything further is scope creep into control, which the transport cannot honour.
* **Honest absence:** when no jobs are defined, the tab shows the setup path (define a standing job, leave Switchboard running during scheduled windows, upload the context artifact) rather than an empty table. First-run guidance is the empty state, not a separate doc.

---

## Complexity Audit
* **Score:** 5 / 10

### Routine
* A new sub-tab in `connections.html` following the panel's established sub-tab strip pattern.
* Read verbs over already-ingested DB tables — the same shape as every other panel's fetch verbs.
* Reusing `copyTextToClipboard` (`TaskViewerProvider.ts:12148`, schema at `verbSchemas.ts:1316`).

### Complex / Risky
* **Depends on two unlanded siblings.** The tab renders into the Connections panel (subtask 1) and queries tables the machinery plan creates (subtask 5). Buildable against stubs — the table names and the instruction-writer contract are fixed in the machinery plan — but not verifiable end to end until both land.
* **Stuck-claim detection must match the machinery's rule exactly.** A claim is stuck when it has no result line and its timestamp is older than the staleness window (default 24h). If the tab computes "stuck" differently from the agent's skip rule, the UI offers to clear claims the agent still considers live. The ingestion pass owns the status; the tab renders `job_instructions.status`, it does not recompute it.
* **Two hosts.** Verbs must return in-body and be schema-validated per PRD contracts #4/#5; the tab is absent-or-disabled where its verbs are not wired (contract #6).

---

## Edge-Case & Dependency Audit

### Race Conditions
* **Ingestion lag.** The agent writes files at 3am; the tables update on watch/next-open. The tab shows state as of the last ingestion — panel copy says so ("updated when Switchboard imports job activity"). A manual refresh verb re-triggers ingestion rather than re-reading files.
* **Clear-stuck-claim racing a retry.** The staleness window may expire between the tab rendering a stuck item and the user clearing it. Clearing deletes the claim file; if the agent retried in between, the delete removes a live claim and the item reprocesses — acceptable (idempotent by design) and documented in the confirmation copy.

### Security
* Instruction bodies are rendered as text, never executed — they are inputs to an external agent, and the tab must not add a path that turns displayed markdown into webview HTML with scripts. Render escaped; no `innerHTML` on file content.
* No secrets: job definitions and run-log lines are local file content with no tokens by contract (machinery plan's security section).

### Side Effects
* The Connections panel gains its fourth sub-tab, completing the sub-tab table in the panel plan.
* One new verb block in `TASKVIEWER_VERBS` (the arms live in `TaskViewerProvider`, which owns `.switchboard` file I/O and the instruction writer) — allowlist regenerated via `npm run catalog:generate`, never hand-edited; schemas appended to `verbSchemas.ts` per PRD contract #5.

### Dependencies & Conflicts
* **Connections panel plan (subtask 1)** — the sub-tab strip and panel container. Blocking.
* **Scheduled-jobs machinery plan (subtask 5)** — the directory contract, instruction writer, staleness rule, and the job-activity tables this tab queries. Blocking for end-to-end; stub-buildable.
* Routing per the reconciled decision: no `/connections/verb/` route — the webview addresses `/taskviewer/verb/<name>` for these arms (file I/O lives in `TaskViewerProvider`), `/setup/verb/` and `/planning/verb/` stay untouched by this plan.
* Verb routing construction in both hosts (PRD contract #7): `TaskViewerProvider._startLocalApiServer` and `src/standalone/bootstrap.ts` must both construct the taskViewer router.

---

## Dependencies
* Connections Panel — Rename Remote Control and Give It a Rail Entry. Blocking.
* Scheduled External-Agent Jobs — Instruction Inbox and Standing Jobs. Blocking for end-to-end verification.

---

## Adversarial Synthesis

Key risks: (1) **dead tab** — the tab renders but its verbs are not wired in one host, violating capability honesty; (2) **status drift** — the tab recomputing "stuck" instead of reading the ingestion-owned status, offering to clear live claims; (3) **fake control** — pressure to add "run now" or "next run" displays that the transport cannot honour. Mitigations: manifest/verb gating per PRD contracts #6/#7 in both hosts; render `job_instructions.status` verbatim with the staleness rule owned solely by ingestion; the tab is explicitly read-mostly, and the empty state teaches the setup path instead of implying control.

---

## Proposed Changes

**Build order:** (1) verbs → (2) tab markup + script → (3) empty state + copy.

### 1. `src/services/TaskViewerProvider.ts` — the verb arms

**Context:** `TaskViewerProvider` owns `.switchboard` file I/O and the machinery plan's instruction writer; per the reconciled routing decision the arms live here and the Connections webview calls `/taskviewer/verb/<name>`.

**Implementation:** six arms, each returning in-body (PRD contract #4) with a schema (contract #5):
* `jobsList` — standing-job definitions from the wire files (name, advisory schedule, reads/writes) joined with each job's last `job_runs` row. Returns the list.
* `jobsInboxList` — `job_instructions` rows grouped by status (pending / claimed / done / stuck). Returns the groups.
* `jobsMovesList` — recent `board_move_requests` rows (planId, to_column, applied/skipped + reason, ts). Returns the list.
* `jobsDropInstruction` — writes the submitted body through the machinery plan's instruction writer (frontmatter-flattened, unique filename). Returns the created file path.
* `jobsClearStuckClaim` — deletes the named claim file **only if** its ingested status is `stuck`. Returns the outcome; refuses otherwise (a live claim is not user-clearable by accident).
* `jobsRefresh` — re-runs the ingestion pass and returns updated counts.

Add the verbs to the TaskViewer allowlist source and regenerate (`npm run catalog:generate`); append schemas to `verbSchemas.ts`.

**Edge cases:** empty everything is a valid response (empty arrays), not an error — the tab's empty state depends on distinguishing "no jobs yet" from "verb failed".

### 2. `src/webview/connections.html` + its script — the Jobs sub-tab

**Implementation:** add the **Jobs** sub-tab to the panel's strip, after Hand-offs. Three sections:
* **Standing jobs** — card per job: name, advisory schedule ("daily — schedule lives in your agent's cron"), reads/writes, last run (timestamp + one-line result from `job_runs`), and a subtle "never run" state.
* **Instruction inbox** — the lifecycle table: pending / claimed (with agent id + age) / done / **stuck** (highlighted, with a **Clear claim** action that confirms and calls `jobsClearStuckClaim`). A textarea + **Drop instruction** button calling `jobsDropInstruction`.
* **Declared moves** — recent outcomes: plan title, target column, applied or skipped-with-reason. Skipped rows show the reason verbatim — this is where the user learns an agent hallucinated a planId.

Copy the cron prompt button at the top ("Follow your Switchboard context and process your instruction folder") via `copyTextToClipboard`.

**Logic:** the layout answers the three morning questions in order — *is anything defined? did it run? did anything go wrong?* — without offering controls that cannot work.

**Edge cases:** render all file-derived text escaped; a stuck claim older than a week still clears through the same path; section visibility under capability gating — if `jobsList` is not wired in this host, the tab is disabled per the manifest, not half-rendered.

### 3. Empty state and panel copy

**Implementation:** when `jobsList` returns empty, the section shows the setup path in three steps: (1) upload the `switchboard-spark` context artifact to your external surface, (2) tell it to check `.switchboard/instructions/` on a schedule, (3) **leave Switchboard running during scheduled windows** so imports, the board mirror and declared moves apply live. This is the operational guidance from the machinery plan, surfaced where the user needs it.

---

## Verification Plan

### Automated Tests
Tests are skipped per session directive, and compilation is skipped per session directive. Target coverage for the coding pass:
* Verb tests: each arm returns data in-body (not a bare ack); `jobsClearStuckClaim` refuses a non-stuck claim; `jobsDropInstruction` output matches the machinery plan's filename/frontmatter contract.
* A schema test: the six schemas accept exactly the fields the arms dereference (contract #5 — permissive and field-accurate).
* An allowlist test: the six verbs exist in regenerated `TASKVIEWER_VERBS`.

### Manual Verification
1. **End to end:** define one standing job, drop one instruction, run an external agent against the inbox, and watch the tab reflect pending → claimed → done plus a `job_runs` row — without reloading the panel after a `jobsRefresh`.
2. **Stuck flow:** fabricate a stale claim, confirm it renders as stuck, clear it from the tab, confirm the claim file is gone and the item is eligible for retry.
3. **Moves display:** after a declared-moves run (machinery plan verification 11), applied and skipped rows render with the skip reason verbatim.
4. **Empty state:** in a workspace with no `instructions/` directory, the setup path renders and no errors fire.
5. **Capability honesty:** in a host without the taskViewer router, the Jobs tab is disabled with a reason — never a dead tab (PRD contract #6).
6. **Escaping:** an instruction body containing markup renders as text, unexecuted.
7. **Both hosts:** works in the extension and under `npx switchboard`.
8. **Plan import:** confirm the importer registers this plan on the board.

---

## Recommendation

Complexity 5 → **Send to Coder.**
