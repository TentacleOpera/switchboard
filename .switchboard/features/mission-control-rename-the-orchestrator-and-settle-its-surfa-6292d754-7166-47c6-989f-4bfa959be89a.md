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
- [ ] [Mission Control panel: UI specification](../plans/mission-control-panel-ui-specification.md) — **CODER CODED**
- [ ] [One controller, enforced at the service](../plans/one-controller-enforced-at-the-service.md) — **CODER CODED**
- [ ] [Rename the orchestrator to Mission Control](../plans/rename-the-orchestrator-to-mission-control.md) — **CODER CODED**
- [ ] [The automation model: four things, not a mode axis](../plans/the-automation-model-four-things-not-a-mode-axis.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Sequenced, not parallel. **Rename the orchestrator to Mission Control** is first — it fixes the noun the other three use. **The automation model** is second: the UI specification presents the four things it names, so writing the panel spec against the old mode-axis model would need reworking. **One controller, enforced at the service** is a precondition for **Mission Control panel: UI specification** — the panel, the dock and the rail button all reach the same start path, and three entry points over an unenforced singleton is three ways to break it. The one-controller plan's scoped ops block and rail-button change must land before or with the panel.

**Cross-feature note — naming authority.** The pre-existing feature *Trackers are for bulk queueing, and the orchestrator is a PM you consult* has a subtask covering the same ground ("Two orchestrator entry points are dead or inconsistent, and one concept has four names — delete, and settle the vocabulary"). **The newly imported work takes priority: this feature's rename is the authoritative one.** Treat the Trackers subtask's vocabulary half as subordinate to the rename landed here, and do not settle the naming twice.

