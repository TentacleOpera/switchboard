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
* Reusing `copyTextToClipboard` (`TaskViewerProvider.ts:12172`, schema at `verbSchemas.ts:1323`).

### Complex / Risky
* **Depends on two siblings — one landed, one landed-as-stub.** The Connections panel plan landed the panel + sub-tab strip (the Jobs tab button and `#jobs-fields` container already exist at `connections.html:311,462`). The scheduled-jobs machinery plan landed its tables (`job_runs`/`job_instructions`/`board_move_requests` at `KanbanDatabase.ts:207-230`), the writers (`recordJobRun`/`recordBoardMoveRequest`/`upsertJobInstruction`), the ingestion pass (`ingestJobActivity`, `ScheduledJobsService.ts:286`), and the declared-moves watcher (`KanbanProvider.ts:818-827`) — so end-to-end verification is now possible, not stub-only. The remaining gap is on THIS plan's side: the six verbs, the resolver branch, the DB read methods, and the tab's live content do not exist yet.
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
* One new verb block in `TASKVIEWER_VERBS` (the arms live in `TaskViewerProvider`, which owns `.switchboard` file I/O) — allowlist regenerated via `npm run catalog:generate`, never hand-edited; schemas appended to `verbSchemas.ts` per PRD contract #5.
  > **Superseded:** "the arms live in `TaskViewerProvider`, which owns `.switchboard` file I/O **and the instruction writer**."
  > **Reason:** `TaskViewerProvider` does NOT own the instruction writer. The writer is `writeInstruction` in `src/services/ScheduledJobsService.ts:63` (filename `instr-<compactUTC>-<kind>-<rand5>.md`, frontmatter-flattened, `InstructionRequest` = `{from?, kind, planId?, feature?, body}`). `TaskViewerProvider` has zero imports of `ScheduledJobsService`, `writeInstruction`, or the job tables today (verified — no matches). The arms live in `TaskViewerProvider` (correct home for `.switchboard` file I/O and the taskViewer verb rail), but they CALL `writeInstruction` and the KanbanDatabase job-table methods; they do not contain the writer.
  > **Replaced with:** the arms live in `TaskViewerProvider` and call `writeInstruction` (imported from `ScheduledJobsService.ts:63`) for `jobsDropInstruction`, plus new KanbanDatabase read methods (see §1) for the three read arms.

### Dependencies & Conflicts
* **Connections panel plan (subtask 1)** — the sub-tab strip and panel container. Blocking.
* **Scheduled-jobs machinery plan (subtask 5)** — the directory contract, instruction writer, staleness rule, and the job-activity tables this tab queries. Blocking for end-to-end; stub-buildable.
* Routing per the reconciled decision:
  > **Superseded:** "no `/connections/verb/` route — the webview addresses `/taskviewer/verb/<name>` for these arms (file I/O lives in `TaskViewerProvider`), `/setup/verb/` and `/planning/verb/` stay untouched by this plan."
  > **Reason:** Doubly unimplementable. (a) `/connections/verb/` IS the route — the resolver exists at `LocalApiServer.ts:3552-3582`, and `transport.js:26` computes `routePrefix = '/' + panel + '/verb'` ONCE at script load from `data-panel`; a page stamped `data-panel="connections"` can address exactly one prefix — `/connections/verb/…` — and has no per-call override (`transport.js:282`: `url = ${routePrefix}/${verb}`). It CANNOT reach `/taskViewer/verb/`. (b) The six job verbs are in NEITHER `SETUP_VERBS` nor `PLANNING_VERBS`, so the existing `/connections/verb/` resolver (`:3569-3582`) 404s every one of them with an explicit "in neither SETUP_VERBS nor PLANNING_VERBS" error. The plan as written makes every verb a dead call and the tab a permanent empty state — a green "tab renders" check that hides a totally non-functional surface.
  > **Replaced with:** the six verbs are added to `TASKVIEWER_VERBS` (via `npm run catalog:generate`) AND the `/connections/verb/` resolver (`LocalApiServer.ts:3569-3582`) is extended with a third branch — `else if (TASKVIEWER_VERBS.has(verb)) await this._handleTaskViewerVerb(verb, req, res);` — after the SETUP/PLANNING checks, before the 404. The resolver already spans two providers by generated allowlist; a third is the same pattern, and the 404's own error message already tells the coder to "add the arm to its provider and run `npm run catalog:generate`". The arms live in `TaskViewerProvider` (gated on `TASKVIEWER_VERBS` at `TaskViewerProvider.ts:330`); the Connections webview calls `/connections/verb/jobsList` etc. — the only prefix `transport.js` will produce for it. `/setup/verb/` and `/planning/verb/` stay untouched.
* Verb routing construction in both hosts (PRD contract #7): `TaskViewerProvider._startLocalApiServer` and `src/standalone/bootstrap.ts` must both construct the taskViewer router.

---

## Dependencies
* Connections Panel — Rename Remote Control and Give It a Rail Entry. Blocking.
* Scheduled External-Agent Jobs — Instruction Inbox and Standing Jobs. Blocking for end-to-end verification.

---

## Adversarial Synthesis

Key risks: (1) **unreachable verbs (the load-bearing one)** — the original routing sent the Connections webview to `/taskViewer/verb/`, which `transport.js:26` cannot produce for a `connections`-stamped page, and the `/connections/verb/` resolver 404s verbs outside SETUP/PLANNING; the tab would render its stub forever while every verb silently fails — a green "tab renders" check hiding a dead surface; (2) **missing DB read methods** — `KanbanDatabase` has only writers for the job tables, so even with routing fixed the three read arms return empty/error; (3) **dead tab in one host** — verbs wired in the extension but not the standalone bootstrap (or vice-versa), violating capability honesty; (4) **status drift** — the tab recomputing "stuck" instead of reading the ingestion-owned `job_instructions.status`, offering to clear live claims; (5) **fake control** — pressure to add "run now" or "next run" displays the transport cannot honour. Mitigations: extend the `/connections/verb/` resolver with a `TASKVIEWER_VERBS` third branch and add the six verbs to that allowlist; add `listJobRuns`/`listJobInstructions`/`listBoardMoveRequests` to `KanbanDatabase`; manifest/verb gating per PRD contracts #6/#7 in both hosts with the new verbs on the transport shim (not raw `postMessage`); render `job_instructions.status` verbatim with the staleness rule owned solely by ingestion (`ScheduledJobsService.ts:321-352`); the tab is explicitly read-mostly, and the empty state teaches the setup path instead of implying control.

---

## Proposed Changes

**Build order:** (1) verbs → (2) tab markup + script → (3) empty state + copy.

### 1. `src/services/TaskViewerProvider.ts` — the verb arms

**Context:** `TaskViewerProvider` owns `.switchboard` file I/O and is the home of the `taskViewer` verb rail (allowlist-gated on `TASKVIEWER_VERBS` at `TaskViewerProvider.ts:330`, dispatched from `_handleTaskViewerVerb` at `LocalApiServer.ts:1945`).
> **Superseded:** "`TaskViewerProvider` owns `.switchboard` file I/O **and the machinery plan's instruction writer**; per the reconciled routing decision the arms live here and the Connections webview calls `/taskviewer/verb/<name>`."
> **Reason:** Two errors. (1) The instruction writer is `writeInstruction` in `ScheduledJobsService.ts:63`, not in `TaskViewerProvider` (verified: `TaskViewerProvider` has no `ScheduledJobsService` / `writeInstruction` / job-table imports). (2) The Connections webview is stamped `data-panel="connections"`, so `transport.js:26` fixes its route prefix to `/connections/verb` — it cannot call `/taskViewer/verb/`. See the routing supersession in *Dependencies & Conflicts*.
> **Replaced with:** the arms live in `TaskViewerProvider` and call `writeInstruction` (imported from `ScheduledJobsService`) for the drop action and new KanbanDatabase read methods for the three read arms. The Connections webview reaches them at `/connections/verb/<name>` via the extended resolver.

**Implementation:** six arms, each returning in-body (PRD contract #4) with a schema (contract #5):
* `jobsList` — standing-job definitions from the wire files (name, advisory schedule, reads/writes) joined with each job's last `job_runs` row. Returns the list.
* `jobsInboxList` — `job_instructions` rows grouped by status (pending / claimed / done / stuck). Returns the groups.
* `jobsMovesList` — recent `board_move_requests` rows (plan_id, to_column, status applied/skipped, reason, timestamp). Returns the list.
* `jobsDropInstruction` — calls `writeInstruction(workspaceRoot, { kind: 'manual', from: 'ui', body })` (imported from `ScheduledJobsService.ts:63`; filename `instr-<compactUTC>-<kind>-<rand5>.md`, frontmatter-flattened). Returns the created file path.
* `jobsClearStuckClaim` — deletes the named claim file at `inbox/claimed/<item>.md.claim` **only if** its ingested `job_instructions.status` is `stuck`. Returns the outcome; refuses otherwise (a live claim is not user-clearable by accident).
* `jobsRefresh` — re-runs `ingestJobActivity` (imported from `ScheduledJobsService.ts:286`) and returns updated counts.

**Three prerequisites the arms depend on (all in this plan's scope):**
1. **Resolver extension.** Add a third branch to the `/connections/verb/` resolver (`LocalApiServer.ts:3569-3582`): after `SETUP_VERBS`/`PLANNING_VERBS`, before the 404 — `else if (TASKVIEWER_VERBS.has(verb)) await this._handleTaskViewerVerb(verb, req, res);`. Import `TASKVIEWER_VERBS` from `../generated/verbAllowlist` (already imported for `SETUP_VERBS`/`PLANNING_VERBS` in that file). Without this, every job verb 404s — the tab's verbs are unreachable from the only prefix `transport.js` produces for a `connections`-stamped page.
2. **KanbanDatabase read methods.** The three read arms query `job_runs` / `job_instructions` / `board_move_requests`, but `KanbanDatabase` exposes ONLY writers today (`recordJobRun` `:3849`, `recordBoardMoveRequest` `:3869`, `upsertJobInstruction` `:3883`) — no read/query methods exist (verified: no `getJobRuns`/`listJobInstructions`/`listBoardMoveRequests`). Add three read methods mirroring the existing writer signatures: `listJobRuns(limit?)`, `listJobInstructions()` (returns `{file, status, claimed_ts, agent, result}` rows), `listBoardMoveRequests(limit?)` (returns `{file, plan_id, to_column, status, reason, timestamp}` rows). Each runs a `SELECT … ORDER BY … LIMIT` against the table; the column names are fixed in `SCHEMA_TABLES_SQL` (`KanbanDatabase.ts:207-230`).
3. **Allowlist + schemas.** Add the six verbs to the `TASKVIEWER_VERBS` source (regenerate via `npm run catalog:generate` — `package.json:843`, runs `generate-protocol-catalog.js` + `generate-verb-allowlist.js`); append six permissive schemas to `verbSchemas.ts` (contract #5 — require only the fields each arm dereferences: `jobsDropInstruction` needs `{workspaceRoot?, body}`, `jobsClearStuckClaim` needs `{workspaceRoot?, file}`, the read arms need `{workspaceRoot?}`).

**Edge cases:** empty everything is a valid response (empty arrays), not an error — the tab's empty state depends on distinguishing "no jobs yet" from "verb failed".

### 2. `src/webview/connections.html` + `src/webview/connections.js` — the Jobs sub-tab

> **Superseded:** "add the **Jobs** sub-tab to the panel's strip, after Hand-offs."
> **Reason:** The sub-tab already exists. The Connections panel plan landed the strip with all four tabs — the **Jobs** button is at `connections.html:311` and its content container `#jobs-fields` at `:462-489`. The current content is a static stub: a hardcoded standing-job list (`:468-476`), the spark-context regenerate button (`:478-483`, wired in `connections.js:352-356` via raw `vscode.postMessage({type:'regenerateSparkContext'})`), and a placeholder "No job runs recorded yet" line (`:487`). Adding a second Jobs tab would duplicate the button; the work is replacing the stub with the DB-backed view.
> **Replaced with:** replace the stub content inside `#jobs-fields` (`connections.html:462-489`) with the three live sections below. Keep the existing spark-context regenerate button (it is a separate, already-wired concern) — the new sections sit alongside it, not on top of it.

**Implementation:** three sections inside the existing `#jobs-fields` container:
* **Standing jobs** — card per job: name, advisory schedule ("daily — schedule lives in your agent's cron"), reads/writes, last run (timestamp + one-line result from `job_runs`), and a subtle "never run" state.
* **Instruction inbox** — the lifecycle table: pending / claimed (with agent id + age) / done / **stuck** (highlighted, with a **Clear claim** button that calls `jobsClearStuckClaim` immediately — no confirm dialog; per `CLAUDE.md`, confirm gates are forbidden in this codebase and `window.confirm` is a silent no-op in VS Code webviews). A textarea + **Drop instruction** button calling `jobsDropInstruction`.
* **Declared moves** — recent outcomes: plan title, target column, applied or skipped-with-reason. Skipped rows show the reason verbatim — this is where the user learns an agent hallucinated a planId.

Copy the cron prompt button at the top ("Follow your Switchboard context and process your instruction folder") via `copyTextToClipboard`.

**Logic:** the layout answers the three morning questions in order — *is anything defined? did it run? did anything go wrong?* — without offering controls that cannot work.

**Script wiring (`connections.js`):** the six job verbs MUST go through the transport shim's verb-call path (`window.sbTransport` → `POST /connections/verb/<name>`), NOT the raw `vscode.postMessage({type:…})` legacy path the existing spark-context and hand-off handlers use (`connections.js:352,342`). The raw path is in-process only and never reaches the `/connections/verb/` resolver; in the standalone host it is a dead call. The existing `regenerateSparkContext` handler is a pre-existing separate concern — do not rewrite it here, but the new job handlers use the transport from the start so they work in both hosts (PRD contract #7).

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
* **A resolver test (new — the load-bearing gate):** `POST /connections/verb/jobsList` routes to `_handleTaskViewerVerb` (not 404), and a verb in neither SETUP/PLANNING/TASKVIEWER still 404s. Without this, the tab's verbs are unreachable and every other test is moot.
* **A DB read-method test (new):** `listJobRuns` / `listJobInstructions` / `listBoardMoveRequests` return rows after `recordJobRun` / `upsertJobInstruction` / `recordBoardMoveRequest` write them, and empty arrays (not errors) on an empty DB.

### Manual Verification
1. **End to end:** define one standing job, drop one instruction, run an external agent against the inbox, and watch the tab reflect pending → claimed → done plus a `job_runs` row — without reloading the panel after a `jobsRefresh`.
2. **Stuck flow:** fabricate a stale claim, confirm it renders as stuck, clear it from the tab, confirm the claim file is gone and the item is eligible for retry.
3. **Moves display:** after a declared-moves run (machinery plan verification 11), applied and skipped rows render with the skip reason verbatim.
4. **Empty state:** in a workspace with no `instructions/` directory, the setup path renders and no errors fire.
5. **Capability honesty:** in a host without the taskViewer router, the Jobs tab is disabled with a reason — never a dead tab (PRD contract #6).
6. **Escaping:** an instruction body containing markup renders as text, unexecuted.
7. **Both hosts:** works in the extension and under `npx switchboard`.
8. **Resolver routing (the load-bearing check):** from the Connections panel in BOTH hosts, confirm `jobsList` reaches `_handleTaskViewerVerb` and returns data (not a 404 "in neither SETUP_VERBS nor PLANNING_VERBS" error). A tab that renders but 404s every verb is the specific failure mode this plan's routing correction exists to prevent.
9. **Transport, not raw postMessage:** confirm the six job verb calls go to `/connections/verb/<name>` via the transport shim (network tab / `window.sbTransport`), not the legacy `vscode.postMessage` path — the latter is a dead call in the standalone host.
10. **Plan import:** confirm the importer registers this plan on the board.

---

## Recommendation

Complexity 5 → **Send to Coder.**

## Completion Report

Implemented the Connections panel Jobs sub-tab activity view, connecting it to external agent job machinery and kanban DB tables (`job_runs`, `job_instructions`, `board_move_requests`). Added 3 read query methods to `KanbanDatabase`, 6 verb handler arms to `TaskViewerProvider`, updated `/connections/verb/` resolver routing in `LocalApiServer`, declared verb schemas in `verbSchemas.ts`, regenerated `protocol-catalog.json` & `verbAllowlist.ts`, and built the live multi-card UI with instruction dropping, claim clearing, prompt copying, and activity refresh in `connections.html` & `connections.js`. Files changed: `src/services/KanbanDatabase.ts`, `src/services/LocalApiServer.ts`, `src/services/verbSchemas.ts`, `src/services/TaskViewerProvider.ts`, `protocol-catalog.json`, `src/generated/verbAllowlist.ts`, `src/webview/connections.html`, `src/webview/connections.js`. No implementation issues encountered; all 6 verbs wired and catalogued successfully.

