# Internal / External: Rename the Modes and Make External Actually External

## Goal

Rename the two surviving automation modes to **`internal`** and **`external`**, and give external mode a real enforcement point so that "Switchboard runs no clock in external mode" is true in code rather than only in the label.

| Mode | What it does |
| :--- | :--- |
| **Internal** | Switchboard runs the run sheet on its own schedule, dispatching to local terminals. Oversight agent optional. |
| **External** | Switchboard emits a **copyable prompt** for a tool that runs agent cron jobs (Antigravity, a Claude scheduled agent). Switchboard runs no clock and dispatches nothing. |

The axis is *who runs the clock*. Internal executes; external emits text.

The target usage: a scheduled agent should be able to be told **"kick off the switchboard automation"** or **"review the plans in the CREATED column in sequence"** — and that instruction is what external mode hands you.

### Problem & background

**The names are wrong.** An earlier pass collapsed the modes to `'run-sheet' | 'scheduler'` before the internal/external axis was settled. The structure is right; the names describe the old model.

**External mode is not enforced by anything.** Verified in the working tree 2026-08-16 — this is the load-bearing finding and the reason external mode is not a presentation change. (**Line numbers drift — anchor on the symbol names.**)

* `_startAutobanEngine` (`TaskViewerProvider.ts:11691`) **does not consult `automationMode` at all**. Six call sites across four methods reach it: `_tryRestoreAutoban` at startup (`:10058`), `setAutobanEnabledFromKanban` (`:10068`, `:10075`), `setAutomationModeFromKanban` (`:10331`), and the `updateAutobanState` verb arm (`:13434`, `:13439`).
* `resetAutobanTimersFromKanban` (`:10565`) installs its **own** `setInterval` (`:10586–10589`) and calls `_enqueueRunSheetTick` without going through `_startAutobanEngine` — a gate at the choke point alone misses it.
* Scheduler job loops start from activation (`:1108` → `_startAllSchedulerLoops`, `:25736`) for every enabled `local-terminal` job, with **no reference to `automationMode` anywhere in that path**. Switching modes has never affected them.

Ship the label without the gate and external mode is a name over a running clock — the exact hollow-success failure this work exists to remove.

**A second finding, load-bearing for the emitted prompt (§3).** The earlier draft of this plan named the wrong builders. Verified in the tree:

* `KanbanProvider.SCHEDULER_TARGET_CONTRACTS` (`:5760–5773`) does **not** contain the board-driving contract. Its three entries are *target* prerequisites: local-terminal ("requires the laptop to be on"), antigravity ("open the AUTOMATION tab → Scheduled Tasks"), cloud ("board-state export must be `read-only-snapshot`…"). Not one of them mentions the port file, `POST /kanban/move`, or the no-raw-SQL rule.
* `_buildBoardBatchPromptCore` (`:5554`) is a **snapshot** builder, not an evergreen one. It queries `getPlansByColumn` and returns `{ prompt: null, error: 'No plans found in <column> column' }` when the column is empty (`:5577–5579`); when it is not empty it inlines the *current* plan IDs and this machine's absolute sqlite path (`:5616`, `:5628–5630`). A prompt for a cron job runs later, against a board that has changed. Copy it on an empty column and you get no prompt at all.

---

## Metadata

**Complexity:** 6
**Tags:** refactor, backend, ui, reliability

---

## User Review Required

**None.** Six decisions made here:

* **Two modes: `internal` and `external`.** The axis is who runs the clock.
* **`scheduler` migrates to `internal`, not external.** A scheduler job Switchboard itself ran on a timer *is* internal scheduled automation. **Nothing** migrates to `external` — it holds no running state, only a prompt.
* **External mode installs no timer and dispatches nothing.** Enforced at the engine, asserted by counting installed timers.
* **Local scheduled jobs pause in external mode**, and the panel says so. A user who set one up and finds it stopped must be told, not left to discover it.
* **The toolbar Start button is hidden in external mode**, not toast-guarded. A button that explains why it does nothing is still a button that does nothing (PRD contract #6). This replaces the existing `showInfo` toast at `kanban.html:9789–9796`.
* **The emitted prompt is evergreen and board-state-free.** It names the run sheet's columns and roles, never today's plan IDs, and it must build successfully with an empty board.

---

## Complexity Audit

* **Score:** 6 / 10

### Routine

* A ~21-site identifier rename with no behaviour change (14 in `kanban.html`, 7 in `TaskViewerProvider.ts`, plus the type and normalizer in `autobanState.ts`).

### Complex / Risky

* **The gate has two entry points, not one.** `resetAutobanTimersFromKanban` bypasses `_startAutobanEngine` entirely. Its existing `if (!this._autobanState.enabled) { return; }` (`:10566`) is not cover: the gate at `_startAutobanEngine` makes the *engine* a no-op but leaves `enabled === true`, and both `setAutobanEnabledFromKanban(true)` and the `updateAutobanState` verb can set it in external mode. So the sequence *enable → switch to external → press reset-timers* installs a live clock. Gate the reset path explicitly.
* **Scheduler job loops are a third clock, independent of both.** They have never consulted the mode. Leaving them undecided means external mode still dispatches locally.
* **`_tryRestoreAutoban` broadcasts before starting** (`:10056` then `:10057`). In external mode it can broadcast a persisted `enabled: true` that nothing acts on — a panel reading "running" with no engine.
* **The prompt builders are not the obvious ones, and the obvious ones are wrong.** See the two superseded notes in §3.

---

## Edge-Case & Dependency Audit

### Race Conditions

* Mode transition while a tick is in flight: the transition into `external` must call `_stopAutobanEngine()` after setting the mode, so an in-flight tick cannot re-arm a timer behind it.

### Security

* Not a privilege change. The emitted prompt carries whatever the external agent needs to reach this workspace's board — it must not embed the API bearer token in copyable text, and it must not embed the absolute sqlite path (which `_buildBoardBatchPromptCore` does at `:5616`).

### Side Effects

* Installs persisted in `scheduler` come up on `internal`, still scheduled.
* Anyone with a `local-terminal` scheduled job who selects external mode sees it pause. Stated in the panel.

### Dependencies & Conflicts

* **`src/services/autobanState.ts`** — `AutobanAutomationMode` (`:39`), `normalizeAutomationMode` (`:251–256`) and its doc comment (`:241–250`). The orchestration→oversight migration (`:314–322`) stays untouched.
* **`src/services/TaskViewerProvider.ts`** — the 7 renamed sites (`:1317`, `:9455`, `:9723`, `:10289`, `:10298`, `:10322`, `:11640`), plus `_startAutobanEngine` (`:11691`), `resetAutobanTimersFromKanban` (`:10565`), `_tryRestoreAutoban` (`:10051`), `_startAllSchedulerLoops` (`:25736`), `setAutobanEnabledFromKanban` (`:10063`), the `updateAutobanState` verb arm (`:13434`, `:13439`).
* **`src/services/KanbanProvider.ts`** — `_buildReconcilePrompt` (`:5713`, board-driving paragraph at `:5726–5730`), `_buildSchedulerPrompt` (`:5790`), `SCHEDULER_TARGET_CONTRACTS` (`:5760`), `getSchedulerTargetContracts` verb (`:11319`).
* **`src/webview/kanban.html`** — 14 `'run-sheet'` literal sites (`:6910`, `:8400`, `:9514`, `:9555`, `:10260`, `:10316`, `:10338`, `:10347`, `:10449`, `:10522`, `:10546`, `:10597`, `:10635`, `:11078`), the mode dropdown (`:10316–10317`), the `'scheduler'` branches (`:6942`, `:6948`, `:9392`, `:9518`, `:9559`, `:9789`, `:10339`, `:10670`), the toolbar Start handler (`:9788`) and `updateAutobanButtonState` (`:6904`).
* **Prerequisite — the oversight plan.** Lands first. Both edit the same files; they serialise under the PRD's one-stream-per-file rule.
* **Shared symbol with both siblings:** the accepted-modes array at `TaskViewerProvider.ts:10289`. The oversight plan leaves it `['run-sheet', 'scheduler']`; this plan renames it to `['internal', 'external']`; the comms plan does not touch it further. Reconciled end state: `if (newMode !== 'internal' && newMode !== 'external') return;`.
* **Shared symbol with the comms plan:** `_buildBoardBatchPromptCore`. The comms plan deletes the `board-batch` **job source**; it does **not** delete this builder, which still has three other callers (`:5536` `generateAntigravityPrompt`, `:5815` `_buildSchedulerPrompt`, `:11292` the `schedulerPrompt` verb). This plan does not add a fourth.

### Note: no test literals to rename

`src/test/` mentions "run-sheet" only in assertion messages and comments (`autoban-state-regression.test.js`, `local-plan-duplicate-regression.test.js`, `plan-creation-status-regression.test.js`). No test asserts on the string as a mode value, so the rename does not red them.

---

## Adversarial Synthesis

Key risks: (1) **gating only `_startAutobanEngine`** and leaving `resetAutobanTimersFromKanban` live, so external mode runs a clock reachable from one button — and its `!enabled` early-return reads like cover when it is not; (2) **scheduler job loops left undecided**, dispatching locally in external mode; (3) **asserting the gate by reading the mode back** — the test that passes while the clock runs; (4) **building the emitted prompt from a board snapshot**, so it is empty on an idle board and stale plan IDs on a busy one — a cron prompt that only works if you copy it at the right moment is worse than none; (5) **using `composeExternalPrompt`**, whose output forbids the very thing the prompt asks for. Mitigations: gate both paths and re-run `_startAllSchedulerLoops()` on every transition; assert by counting installed timers, never by reading the mode; build the prompt from the run sheet as data, with no DB read at all.

---

## Proposed Changes

### 1. Rename the modes

* `autobanState.ts:39` — `AutobanAutomationMode` becomes `'internal' | 'external'`.
* `autobanState.ts:251–256` — `normalizeAutomationMode()` returns `'external'` for `'external'` and **`'internal'` for everything else**, including `single-column`, `multi-column`, `orchestration`, `run-sheet`, `scheduler`, `undefined` and anything unrecognised. Keep the default-to-internal shape — falling through a whitelist is what would silently disarm shipped installs. Update the doc comment at `:241–250` accordingly (it is also the last place the retired names are written down; keep that record).
* `kanban.html` — the 14 `'run-sheet'` sites → `'internal'`; the `'scheduler'` mode branches → `'external'`; the dropdown (`:10316–10317`) becomes **Internal** + **External** with rewritten descriptions (`:10338–10339`).
* `TaskViewerProvider.ts` — the 7 sites.

**Edge cases:** no behaviour change in this step; it should review on a grep. Do **not** rename `singleColumnConfig` or the `'singleColumn.autoban.state'` key — that is shipped persisted state.

### 2. Gate external mode

* Top of `_startAutobanEngine` (`:11691`): return early when the mode is `external`, **after** calling `_stopAutobanEngine()` so any surviving timer is cleared. Log the refusal — a silent no-op is indistinguishable from the bug it prevents.
* Same early return at the top of `resetAutobanTimersFromKanban` (`:10565`), **beside and independent of** its existing `!enabled` return. Do not rely on the `!enabled` guard: the engine gate leaves `enabled` true.
* `setAutomationModeFromKanban`, transitioning into `external`, sets `enabled: false` and calls `_stopAutobanEngine()`.
* `_tryRestoreAutoban` (`:10051`) — ensure the broadcast at `:10056` reports `enabled: false` in external mode rather than a persisted `true` nothing acts on.
* **Scheduler job loops:** skip `local-terminal` jobs in `_startAllSchedulerLoops` (`:25736–25751`) while the mode is `external` — the existing "stop loops for jobs that vanished or were disabled" sweep at `:25746–25750` then tears down any already-running loop for free. Re-run `_startAllSchedulerLoops()` on every mode transition so switching back re-arms them.

### 3. The external surface

* A **copy-prompt** button plus a short editable line describing what the external agent should do.
* One line in the panel stating that local scheduled jobs are paused while external mode is selected.
* Hide the toolbar Start button in external mode, in `updateAutobanButtonState` (`kanban.html:6904`, which currently ends with an unconditional `autobanBtn.style.display = ''`). Delete the `showInfo` toast at `:9789–9796` — it is the toast-guard this decision replaces.

**The emitted prompt carries BOTH halves — this is the design, not a nice-to-have.**

1. **The work instruction (the "dumb" half).** Plain English, self-contained, of the *"review the oldest plan in the PLAN REVIEWED column"* shape that already exists — oldest-first ordering, the column and the agent named, one card at a time, walk the steps in order. An agent that can only read the repo can act on this alone.
2. **The board-driving contract.** How to reach this workspace's board — read the port from `.switchboard/api-server-port.txt`, move cards via `move-card.js` / `POST /kanban/move`, **never** raw SQL.

An agent that can reach the extension drives the board; one that cannot still has a complete work instruction and does the work. **One prompt, no target picker, no mode-within-a-mode** — the agent's own reachability is the branch, and it is the only thing that actually differs between the existing `antigravity` and `cloud` targets.

**How to build it.**

* **The work half comes from the run sheet as DATA.** Render `_getAutobanRunSheet()` → `DEFAULT_AUTOBAN_RUN_SHEET` (`autobanState.ts:71–74`: `CREATED → planner`, then `PLAN REVIEWED → coder`) into ordered prose. This is the correct anti-drift anchor: it is the same accessor the internal tick walks (`_enqueueRunSheetTick`, `:11657`), and it is the documented seam for a future user-editable sheet. Editing the run sheet therefore changes the emitted text, for free.
* **No database read.** The builder must produce its text with the board empty and must not name a single plan ID. It describes *which column and which role*, not *which cards*.
* **The board-driving half is lifted from `_buildReconcilePrompt`** (`KanbanProvider.ts:5726–5730`), which already carries the exact wording — forward-only, `move-card.js` / `POST /kanban/move`, "NEVER raw SQL. Raw SQL strands cards and bypasses the move-card.js side-effects (cascades, syncs)". Extract that paragraph into one shared constant used by both the reconcile prompt and the external prompt, so the two cannot drift. Add the port-file discovery line (`.switchboard/api-server-port.txt`) — the same instruction the orchestrator kickoff already gives (`TaskViewerProvider.ts:10237`).
* Optionally append the interval-floor / recurrence guidance from `SCHEDULER_TARGET_CONTRACTS` for whichever external scheduler the user names in the editable line — but **do not** treat that record as the source of the board-driving contract; it does not contain one.

**Edge cases:** the work instruction must stand alone — read it with the board-driving paragraph deleted and confirm it still says what to do. If it only makes sense alongside the API contract, half the requirement is missing. The prompt must not embed the API bearer token or an absolute database path; a copied prompt goes into someone else's tool and probably its logs.

  > **Superseded:** "Reuse the existing external-agent prompt builder (`externalAgentPrompts.ts`)."
  > **Reason:** `composeExternalPrompt` (`externalAgentPrompts.ts:13`) is the *skill-file-to-artifact* builder: it loads a `LauncherSpec`'s SKILL.md, embeds a target file's content, and closes with a Write-Back Requirement stating **"Do not invent board cards, modify kanban.db, or create API calls."** (`:45`). Pasted into a scheduled agent asked to kick off Switchboard automation, that prompt forbids the job — the button copies, the paste succeeds, the agent declines.

  > **Superseded:** "Build it from `_buildSchedulerPrompt` → the board-batch core, with prerequisites from `SCHEDULER_TARGET_CONTRACTS`."
  > **Reason (three separate defects, all verified in the tree):**
  > 1. `_buildBoardBatchPromptCore` (`KanbanProvider.ts:5554`) reads the board and **fails closed on an empty column** (`:5577–5579`). Copying the prompt on an idle board yields no prompt. A cron prompt must be evergreen.
  > 2. When the column is *not* empty it inlines today's plan IDs and this machine's absolute sqlite path (`:5616`, `:5628–5630`) — stale by the time the scheduled agent runs, and a local-path leak into someone else's tool.
  > 3. The stated anti-drift rationale ("already shared with the local-terminal tick") does not hold for the run sheet. `_enqueueRunSheetTick` → `_autobanTickColumn` dispatches through the ordinary dispatch path and never calls `_buildSchedulerPrompt`; that builder is shared with *scheduler-job* ticks only. The genuine shared anchor is `_getAutobanRunSheet()`.
  >
  > **Replaced with:** a small run-sheet prompt builder over `_getAutobanRunSheet()` plus the shared board-driving constant extracted from `_buildReconcilePrompt`. `_buildSchedulerPrompt` and `_buildBoardBatchPromptCore` are left alone — they keep serving the scheduler job list and the Antigravity copy button.

---

## Verification Plan

### Automated Tests

* `normalizeAutomationMode()` returns `'internal'` for `'single-column'`, `'multi-column'`, `'orchestration'`, `'scheduler'`, `'run-sheet'`, `''` and `undefined`; `'external'` only for `'external'`.
* **External mode installs zero timers** — assert by counting installed timer handles after each of the six `_startAutobanEngine` call sites *and* after `resetAutobanTimersFromKanban`. Do not assert by reading the mode back.
* **The reset-timers bypass specifically:** set `enabled: true`, switch to `external`, call `resetAutobanTimersFromKanban()`, assert zero timers. This is the case the `!enabled` early-return does not cover.
* No terminal receives a prompt while in external mode, including from scheduler job loops.
* Switching `external` → `internal` re-arms scheduler job loops.
* **The emitted prompt builds with an empty board** — no DB rows in any column, and the builder still returns a non-empty prompt. This is the assertion that catches a snapshot builder being reused.
* The emitted prompt names the run sheet's actual steps (`CREATED`/planner, `PLAN REVIEWED`/coder) and changes when `DEFAULT_AUTOBAN_RUN_SHEET` changes.
* The emitted prompt contains no bearer token, no plan ID, and no absolute filesystem path to `kanban.db`.
* **The emitted prompt contains both halves:** assert it carries a self-contained work instruction naming the column and oldest-first ordering, **and** the board-driving prerequisites (port file, `move-card.js` / `POST /kanban/move`, no direct SQL).
* **The work half stands alone:** strip the board-driving paragraph and the remaining text still states what to do — this is the assertion that catches a prompt which only works when the API is reachable.
* The board-driving paragraph is a single shared constant — `_buildReconcilePrompt` and the external prompt reference the same symbol, not two copies.
* Grepping `src/` (excluding `src/test/` prose) for `'run-sheet'`, `'single-column'` and `'scheduler'` as `automationMode` values returns nothing.

### Manual Verification

1. **Dropdown:** MODE offers exactly Internal and External.
2. **External emits, never runs:** switch to External, copy the prompt, confirm nothing dispatched and no timer running. Paste into a Claude scheduled agent and confirm **"kick off the switchboard automation"** and **"review the plans in the CREATED column in sequence"** both work from the copied text alone.
3. **Board-driving path:** with the extension running, let the pasted agent act — confirm it moves cards through the API rather than only reporting.
4. **Work-only path:** with the extension NOT running, paste the same prompt and confirm the agent still does the work from the instruction alone rather than stalling on an unreachable API.
5. **Empty-board copy:** clear CREATED and PLAN REVIEWED, then press Copy prompt. Confirm a full prompt is produced, not an error toast.
6. **Timers-reset bypass:** in External, press the timers-reset control and confirm no clock starts.
7. **Scheduled job pauses:** with a `local-terminal` job enabled, switch to External, confirm it stops and the panel says so; switch back, confirm it re-arms.
8. **No toast-guard survives:** in External the toolbar Start button is absent, not present-and-explaining.

---

## Recommendation

Complexity 6 → **Send to Lead Coder.**

**The thing to get right:** the gate has **two** entry points. `resetAutobanTimersFromKanban` installs its own interval without going through `_startAutobanEngine`, and its `!enabled` early-return is not cover — the engine gate leaves `enabled` true, so *enable → external → reset* starts a clock. Scheduler job loops are a third clock that has never consulted the mode. Assert by counting timers — reading the mode back is exactly the test that passes while the clock runs.

**Second:** do not build the emitted prompt from `_buildBoardBatchPromptCore`. It fails closed on an empty column and inlines today's plan IDs and this machine's sqlite path. Build it from `_getAutobanRunSheet()` with no DB read, and lift the board-driving paragraph out of `_buildReconcilePrompt` into a shared constant. And do not use `composeExternalPrompt` — its output forbids the action the prompt is asking for.

**Migration:** mapping only, already the right shape — just change the targets. Nothing migrates to `external`.

---

## Completion Report

Renamed the two automation modes from `'run-sheet'`/`'scheduler'` to `'internal'`/`'external'` and gave external mode a real enforcement point. Files changed: `src/services/autobanState.ts` (type + `normalizeAutomationMode` + doc comments — default-to-internal preserved, not a whitelist), `src/services/TaskViewerProvider.ts` (7 rename sites + external-mode gate at `_startAutobanEngine`, `resetAutobanTimersFromKanban`, `_tryRestoreAutoban`, and `_startAllSchedulerLoops`; `_startAllSchedulerLoops()` re-runs on every mode transition), `src/services/KanbanProvider.ts` (shared `BOARD_DRIVING_CONTRACT` constant extracted from `_buildReconcilePrompt`, new `_buildExternalAutomationPrompt` builder over `DEFAULT_AUTOBAN_RUN_SHEET` with no DB read, new `externalAutomationPrompt` verb arm), `src/webview/kanban.html` (14 `'run-sheet'`→`'internal'` sites, all `'scheduler'` mode branches→`'external'`, dropdown rewritten to Internal/External, scheduler panel replaced with external surface — copy-prompt button + editable line + paused-jobs line, toolbar Start button hidden in external mode, showInfo toast deleted, `externalAutomationPrompt` response handler added), and `protocol-catalog.json` + `src/generated/verbAllowlist.ts` (regenerated to include the new verb). The gate covers both entry points: `_startAutobanEngine` refuses in external mode (stops any surviving timer, logs), and `resetAutobanTimersFromKanban` has an independent early return beside its `!enabled` guard. Scheduler job loops skip `local-terminal` jobs in external mode and the existing sweep tears down already-running loops for free. The emitted prompt carries both halves — a self-contained work instruction from the run sheet as data, and the shared board-driving contract (port file, `move-card.js`/`POST /kanban/move`, no raw SQL). No issues hit; `singleColumnConfig` and the `'singleColumn.autoban.state'` key were left untouched as shipped persisted state.

### Revision (review pass 1)

Four defects fixed plus two small ones. (1) Restored the entire scheduler job list — `createSchedulerJobRow`, `collectJobFromRow`, `collectSchedulerJobs`, `renderSchedulerPrereq`, the `scheduler-job-list`/`scheduler-comms-root`/`scheduler-prereq-root` roots, the ADD JOB button, and the guarded `getSchedulerConfig`/`getSchedulerTargetContracts` fetch with its infinite-render-loop comment — VERBATIM into the Internal panel branch as a plain section, so fetch-plans/reconcile/custom jobs are never orphaned. (2) Fixed the `updateSchedulerConfig` handler: `currentAutomationMode === 'external'` → `'internal'` — the job list lives in Internal, so the config push now re-renders in the mode that has it. (3) Wired the editable instruction line: `instructionInput.value` is sent in the `externalAutomationPrompt` message payload, `_buildExternalAutomationPrompt(instruction)` opens the prompt with it, and the field is added to `verbSchemas.ts` as an optional string (permissive per PRD contract #5). (4) Added a public `getAutobanRunSheet()` accessor on `TaskViewerProvider` (wrapping the private `_getAutobanRunSheet`); `_buildExternalAutomationPrompt` reads it via `this._taskViewerProvider?.getAutobanRunSheet()` with `DEFAULT_AUTOBAN_RUN_SHEET` fallback, so a future user-edited sheet flows into the emitted prompt for free. Small fixes: `await this._startAllSchedulerLoops()` in `setAutomationModeFromKanban` so teardown completes before state is persisted; `setAutobanEnabledFromKanban` and the `updateAutobanState` verb arm both refuse `enabled:true` in external mode (force false + stop engine) so the panel never reads "running" with no clock. Catalog regenerated.

## Review Findings

Reviewed 2026-08-16. The rename and both named gate entry points landed correctly — `normalizeAutomationMode` maps rather than whitelists, `_startAutobanEngine` and `resetAutobanTimersFromKanban` each refuse independently, `_tryRestoreAutoban`/`setAutobanEnabledFromKanban`/the `updateAutobanState` verb all force `enabled:false` in external, `_startAllSchedulerLoops` skips `local-terminal` jobs and re-runs on every transition, and `_buildExternalAutomationPrompt` reads the run sheet as data with no DB call and shares `BOARD_DRIVING_CONTRACT` with `_buildReconcilePrompt`. One MAJOR fixed: `setAutobanPausedFromKanban`'s resume branch is a **third** timer-install path — `paused` survives the switch into external (only `enabled` is forced false), so *pause in Internal → switch to External → resume* installed a live interval in the mode that runs no clock; it now clears the paused flag, stops the engine, and installs nothing. One NIT fixed: the work half ended with "advance its card (see below)", which dangles under the plan's own "strip the board-driving paragraph and it still says what to do" assertion — it now names the forward-only action self-containedly. Files changed by this pass: `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/test/autoban-state-regression.test.js`. Validation: typecheck, webpack build and all five catalog/parity/mirror/verb-return/push-routing gates green; `test:contract:autoban-state` now asserts the mode mapping, all three external gates, the scheduler-loop skip, and that the emitted prompt performs no DB read — remaining risk is that "zero timers installed" is asserted on source shape, not by counting live handles.
