# Automation Is a Scheduler: Internal and External Modes

**Complexity:** 6

## Goal

Automation is really just a scheduler. What varies is not the kind of job but who runs the clock, so there are exactly two modes: Internal, where Switchboard runs the run sheet on its own schedule and dispatches to local terminals with the orchestrator available as optional oversight; and External, where Switchboard emits a copyable prompt for a tool that runs agent cron jobs and runs no clock itself.

Today the tab offers three peer modes in which the run sheet is buried inside an entry labelled Switchboard Single Column, oversight costs you board progression because automationMode is a single-valued enum, and the scheduler is a five-source by three-target job matrix in which the one thing anybody wants is a single cell.

The target usage is that a scheduled agent can be told kick off the switchboard automation, or review the plans in the CREATED column in sequence, and that instruction is what External mode hands you.

## How the Subtasks Achieve This

- **Orchestration Stops Being a Mode — Oversight Becomes a Flag**: closes a half-migrated tree. The OVERSIGHT AGENT toggle already renders in `kanban.html`, but seven sites still branch on the mode, so it checks and the engine never hears about it. Repoints those to `orchestrationConfig.enabled`, splits arming oversight from starting automation, and moves **both halves** of the worktree-topology switch (stash *and* restore) onto the oversight-arming path. After this, oversight is additive rather than an alternative — which is the modelling fix the whole feature rests on.
- **Internal / External: Rename the Modes and Make External Actually External**: renames the surviving modes to `internal` / `external` (~21 mechanical sites), then gives External a real enforcement point. This is not a presentation change: nothing in the tree consults `automationMode` at engine start today, so "External runs no clock" is currently enforced by nothing. Adds the gate at `_startAutobanEngine` *and* at `resetAutobanTimersFromKanban`, which bypasses it, decides the scheduler job loops explicitly, and builds the copy-prompt surface from the run sheet as data — with no database read, so the prompt is evergreen.
- **Delete the Comms Schedule Mode and Collapse Scheduling to Two Controls**: deletes `comms` outright across four files and nine verbs in two allowlists, and reduces run-sheet scheduling to a single WHEN control instead of a job record assembled from a source, a source config, a target and a target contract. Persisted comms jobs are dropped **on read**, so no destructive pass is ever written against `integration-config.json`. Keeps the residual `fetch-plans` / `reconcile` job list — demoted from a mode to a section — because those jobs are persisted, start from activation, and are editable nowhere else.

The through-line is that every current "mode" is really one property of a single thing wearing a mode's clothes: `orchestration` is a supervision flag, `scheduler` is a clock. Modelling them as peers of board progression is what makes the tab both confusing and unable to combine them.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Orchestration Stops Being a Mode — Oversight Becomes a Flag](../plans/feature_plan_20260816150001_oversight-stops-being-a-mode.md) — **CODE REVIEWED**
- [ ] [Internal / External: Rename the Modes and Make External Actually External](../plans/feature_plan_20260816150002_internal-external-rename-and-external-mode.md) — **CODE REVIEWED**
- [ ] [Delete the Comms Schedule Mode and Collapse Scheduling to Two Controls](../plans/feature_plan_20260816150003_delete-comms-and-collapse-scheduler.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Strictly sequential, in the order listed.** All three edit `TaskViewerProvider.ts` and `kanban.html`, so per the project PRD's one-stream-per-file rule they serialise rather than run in parallel. There are also real content dependencies:

1. **Oversight first.** It is nearly done and it unblocks the tab on its own — after it, the toggle works. Running the rename first would churn identifiers while this subtask is mid-way through repointing them.
2. **Rename + external second.** It depends on the oversight subtask's naming being settled, and it should not run against a tree where the mode axis still carries `orchestration`.
3. **Comms deletion + scheduler collapse last.** It removes `scheduler` as a mode value and places the residual job list inside the Internal panel, both of which assume the internal/external names exist.

**The tree is HALF-MIGRATED at the start of this feature.** An earlier pass already landed: `AutobanAutomationMode` as `'run-sheet' | 'scheduler'`, the `normalizeAutomationMode` mapping, the `orchestration` → oversight state migration (`autobanState.ts:314–322`), the OVERSIGHT AGENT toggle (`kanban.html:11073–11116`), the toolbar click handler (`kanban.html:9788`), and a `single-column` → `run-sheet` rename. **The structure is right and the names are wrong.** Read each subtask's Problem section before editing; re-doing landed work will conflict.

**The three failures that produce no error anywhere:**
- `isAutomationArmed` (`TaskViewerProvider.ts:1058`) silently stops guarding once arming oversight no longer sets `autobanState.enabled` — the result is two engines dispatching the same cards, with no type error and no UI symptom. **It is not a mode branch** — it reads `autobanState.enabled` and arming the orchestrator trips it only incidentally, so grepping for a mode comparison finds nothing and the change gets skipped.
- The worktree-topology switch (`KanbanProvider.ts:8448–8483`) fails in *two* directions: the `if` arm becomes unreachable, and the `else` arm — which restores and consumes the stashed prior — starts firing on every ordinary mode switch.
- `resetAutobanTimersFromKanban` (`TaskViewerProvider.ts:10565`) installs its own `setInterval`. Its `!enabled` early-return reads like cover for external mode but is not: gating `_startAutobanEngine` leaves `enabled` true, so *enable → external → reset-timers* starts a clock in the mode that is supposed to run none.

### Contended symbols — one reconciled end-state each

Three symbols are edited by more than one subtask. Implement to these, do not re-derive:

| Symbol | Reconciled end state |
| :--- | :--- |
| `TaskViewerProvider.ts:10289` — `setAutomationModeFromKanban`'s accepted-modes array | Subtask 1 drops `'orchestration'` → `['run-sheet','scheduler']`; subtask 2 renames → `['internal','external']`; subtask 3 does not narrow it further. Final: `if (newMode !== 'internal' && newMode !== 'external') return;` |
| `KanbanProvider._buildBoardBatchPromptCore` (`:5554`) | **Survives.** Subtask 3 deletes the `board-batch` *job source* (dropdown option, `sourceConfig` branch, new-job default) — not the builder, which keeps three callers. Subtask 2 does **not** add a fourth: it must not build the external prompt from a DB snapshot that fails closed on an empty column. |
| The external prompt's board-driving half | Lifted from `_buildReconcilePrompt` (`KanbanProvider.ts:5726–5730`) into one shared constant. **Not** from `SCHEDULER_TARGET_CONTRACTS`, which contains target prerequisites (laptop-on, Antigravity Scheduled Tasks, cloud routine setup) and no board-driving contract at all. |

**Do not** rename `singleColumnConfig` or the `'singleColumn.autoban.state'` key — the persisted key is shipped state.

## Review Findings

Reviewed all three subtasks in dependency order on 2026-08-16, as one combined regression trace across the shared symbols. The feature's modelling thesis landed: oversight is a flag that survives a mode switch, `internal`/`external` are the only mode values, external is enforced at every timer-install path rather than only labelled, and comms is gone with its persisted jobs dropped on read instead of rewritten. Three CRITICALs and two MAJORs were fixed: the tree did not compile at all (a `*/N` cron token inside a docblock plus a stray paren in a nested template literal, both in the WHEN control), the WHEN cron evaluator dispatched the run sheet once a second for the whole minute a schedule matched, the oversight toggle was hidden in External so an armed orchestrator had no off-switch, and resume-from-pause was an ungated third clock in External. Files changed by the review pass: `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `src/test/autoban-state-regression.test.js`. Verification: `compile-tests`, `compile`, `lint` (0 errors), `catalog:check`, `parity:check`, `mirror:check`, `verb-returns:check`, `push-routing:check` and the autoban/scheduler/kanban-webview contract tests all green; the plans' named automated checks did not exist, so ~30 discriminating assertions were added to the CI-wired `test:contract:autoban-state`. Remaining risk: `src/test/integration-config-backup.test.js` is red and wired into neither `package.json` nor CI.
