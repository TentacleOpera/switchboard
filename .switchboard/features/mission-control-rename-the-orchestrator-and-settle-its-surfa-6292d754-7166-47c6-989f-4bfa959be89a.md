# Mission Control: rename the orchestrator and settle its surfaces

**Complexity:** 6

## Goal

Rename the orchestrator persona to Mission Control and build out the surfaces that follow from the rename. The concept currently answers to several names across the codebase and the UI, which makes every other plan that touches it ambiguous. This feature settles the vocabulary first, then specifies the panel, enforces a single controller at the service layer, and replaces the mode-axis mental model with the four distinct things it actually is.

## How the Subtasks Achieve This

- **Rename the orchestrator to Mission Control**: settles the name. Everything else here specs against the renamed concept, so this lands first or the other three are written twice.
- **The automation model: four things, not a mode axis**: replaces the single mode-axis mental model with the four distinct things it actually is. This is the vocabulary the UI spec depends on — a panel cannot present four things coherently while the model says they are positions on one axis.
- **Mission Control panel: UI specification**: specifies the panel itself, including the persistent controller strip that hosts the seat's terminal at widths where the shell dock is gated off.
- **One controller, enforced at the service**: moves the single-controller rule from convention into the service layer, so the panel and every other entry point cannot disagree about who is in charge.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Mission Control panel: UI specification](../plans/mission-control-panel-ui-specification.md) — **CODE REVIEWED**
- [ ] [One controller, enforced at the service](../plans/one-controller-enforced-at-the-service.md) — **CODE REVIEWED**
- [ ] [Rename the orchestrator to Mission Control](../plans/rename-the-orchestrator-to-mission-control.md) — **CODE REVIEWED**
- [ ] [The automation model: four things, not a mode axis](../plans/the-automation-model-four-things-not-a-mode-axis.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Sequenced, not parallel. **Rename the orchestrator to Mission Control** is first — it fixes the noun the other three use. **The automation model** is second: the UI specification presents the four things it names, so writing the panel spec against the old mode-axis model would need reworking. **One controller, enforced at the service** is a precondition for **Mission Control panel: UI specification** — the panel, the dock and the rail button all reach the same start path, and three entry points over an unenforced singleton is three ways to break it. The one-controller plan's scoped ops block and rail-button change must land before or with the panel.

**Cross-feature note — naming authority.** The pre-existing feature *Trackers are for bulk queueing, and the orchestrator is a PM you consult* has a subtask covering the same ground ("Two orchestrator entry points are dead or inconsistent, and one concept has four names — delete, and settle the vocabulary"). **The newly imported work takes priority: this feature's rename is the authoritative one.** Treat the Trackers subtask's vocabulary half as subordinate to the rename landed here, and do not settle the naming twice.


## Review Findings

Reviewed all four subtasks as one delivery unit (they landed together in `87080f98`). Six CRITICALs and eleven MAJORs fixed; per-subtask detail is in each plan file. The four that mattered most: CI was broken (`test:contract:orchestrator-tick` pointed at a renamed-away file and `integration-tests.yml:873` ran it), both copies of the `/switchboard` launcher were never renamed and POSTed to deleted routes, the rename's "nothing shipped" premise was false on two counts (609 on-disk reports orphaned; four persisted `autoban.state` keys renamed with no compat read, which force-disarmed the schedule on every already-migrated install), and the mode axis was orphaned rather than deleted — leaving ~720 lines of live-looking radio machinery plus four mode-keyed branches that hid a running schedule's own controls. Files changed: `src/services/{autobanState,ScheduledJobsService,LocalApiServer,TaskViewerProvider,headlessPanelHtml}.ts`, `src/standalone/{ptyFleetService,bootstrap}.ts`, `src/webview/{kanban.html,mission-control.html,mission-control.js,terminals.js,transport.js,shell.js,implementation.html}`, five test files, `package.json`, `.github/workflows/integration-tests.yml`, and the control plane (`.agents/`, `.claude/`, `CLAUDE.md`). Verification: webpack + `tsc` clean (only pre-existing TS2835), 22 affected contract suites green including a CI gate (`headless-feature-management-contract`) that this delivery had turned red; four suites stay red on defects predating this work (`seat-safeguards` ×2, `browser-stray-dispatch-surface` ×1, `stage-marker-commit` ×2, `browser-panel-verb-routing` ×1 — all verified against `87080f98^`).

**Remaining risks:** the missions and schedules tabs still have no host wiring (blocked on `staging-streams-parallel-dispatch-and-worktrees.md`), the `startOrchestrator`/`stopOrchestrator`/`setAutomationMode` verbs keep their old names, and `prompts-tab-move-regression.test.js` / `planner-workflow-path-migration.test.js` remain uninvoked by CI and red on pre-existing drift.
