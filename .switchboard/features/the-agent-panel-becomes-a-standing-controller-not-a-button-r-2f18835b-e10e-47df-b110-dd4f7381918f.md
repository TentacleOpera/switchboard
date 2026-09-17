# The Agent Panel Becomes a Standing Controller, Not a Button Row

**Complexity:** 7

## Goal

The Agent panel arms a controller: a process that wakes on a clock, runs a triage checklist over the board, diagnoses why work is stuck, fixes what it can, and appends what it did to a Markdown report the operator reads when they come back.

Switchboard is a rules engine augmented by AI. The controller is the augmentation: it runs the rules, and uses a model only where a rule needs judgement. The controller is a client, not a part of the board — it runs on the board host or on another machine over the tailnet, and drives the board through the existing CLI surface. Both placements are supported and ship together.

Today the panel is seven buttons and a card dropdown, six of them one mechanical POST each. The model is asked to choose a verb — the part the operator knows better than it does — after the operator has already done the card resolution, which is the part a model would actually help with. There is no loop, nothing runs between presses, and nothing accumulates. This feature replaces that with a standing controller, a solutions matrix held as data, an escalation ladder, and a report.

## How the Subtasks Achieve This

- **Structured Cards Render in One Module on Three Surfaces**: builds the shared webview card
  renderer and restyles the seat status pane to the product's brand, reading the turn-end reports the
  board already holds. It has **no dependency on the controller**, ships alone, and is deliberately
  first because it de-risks the three-surface script-wiring trap before anything else relies on it.
- **The Controller Wakes on a Clock, Diagnoses, and Reports**: the spine. A `switchboard controller`
  CLI client with its own clock, a board-side lease that admits exactly one controller, the solutions
  matrix held as data, the one-rung-per-pass escalation ladder, the four capability probes, and the
  Markdown report — with the **mechanical rows only and no model call at all**. Independently useful
  as a modelless board that fixes rows 1, 2 and 4 and reports honestly, and it forces the feature's
  highest-risk seam (the collision with `_runDispatchTimeoutSweep`) to be settled first.
- **The Agent Panel Becomes a Standing Controller, Not a Button Row**: the surface. The dock Agent tab
  and the mobile command surface stop being a row of endpoint buttons and become the console that
  arms, configures and reads the controller, including the supervisor chat. Everything it shows about
  the controller is second-hand, because the controller may be on another machine.
- **Judgement Tiers, the Supervisor Seat, and Reroute**: the expensive half. Makes matrix rows 3, 5, 6
  and 8 reachable via an ordered list of judgement backends (small local model → larger API model →
  supervisor seat), adds the supervisor as an ordinary seat with an explicit self-exclusion, and adds
  the reroute verb row 5 needs. Row 7's board-restart remediation is **deferred by decision** — off
  systemd it is not knowable from inside the process whether a restart would be recovered.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Agent Panel Becomes a Standing Controller, Not a Button Row](../plans/the-agent-panel-becomes-a-standing-controller.md) — **CODE REVIEWED** — ID: ca45cf9a-98d8-4289-8474-23974fd89a60
- [ ] [Structured Cards Render in One Module on Three Surfaces](../plans/structured-cards-render-in-one-module-on-three-surfaces.md) — **CODE REVIEWED** — ID: 7c26ace7-3bed-4345-b946-445f7ceaf4b9
- [ ] [The Controller Wakes on a Clock, Diagnoses, and Reports](../plans/the-controller-wakes-on-a-clock-diagnoses-and-reports.md) — **CODE REVIEWED** — ID: 7bc77681-fe26-494e-a391-3464aeeb7a68
- [ ] [Judgement Tiers, the Supervisor Seat, and Reroute](../plans/judgement-tiers-the-supervisor-seat-and-reroute.md) — **CODE REVIEWED** — ID: 00ff3928-88b1-49f5-8b81-124490016f81
<!-- END SUBTASKS -->

## Column note — these subtasks do NOT need replanning

Three subtasks sit in CREATED and one in PLAN REVIEWED. **This is a filesystem artefact, not a review
state.** All four were carved from a single plan that had already been through `improve-plan`; the
subtask that was rewritten in place kept its reviewed column, and the three new files landed in
CREATED simply because that is where the watcher imports a new `.md`.

**Do not press Replan on this feature.** Replan exists to send genuinely un-reviewed plans to the
planner. Sending these would re-author reviewed content, and an improve pass is explicitly warned not
to re-open a `## Resolved Assumptions` section — which this feature has one of.

The correct action is to move the three CREATED subtasks to PLAN REVIEWED on the board.

## Dependencies & sequencing

Ordering is constrained. Do not treat these as parallel.

1. **Structured Cards** — no dependencies. Ship first, alone.
2. **The Controller Wakes on a Clock** — depends on nothing in this feature and nothing outside it.
   Ship second (or in parallel with Structured Cards). The controller always runs co-located with the
   board; the off-board placement was cut, so *The CLI Reaches a Remote Board Over the Tailnet* is
   **not** a dependency of this feature in any form.
3. **The Agent Panel** — hard dependency on both of the above. There is nothing to arm, no arming
   state to render, no report to display and no capability set to grey out until the controller
   exists, and its supervisor chat consumes the card renderer.
4. **Judgement Tiers** — hard dependency on *The Controller Wakes on a Clock* (it adds evaluation
   paths to structures that subtask creates); soft dependency on *Structured Cards* (the supervisor
   can post without it, the posts are simply not yet drawn as cards). Not a dependency of the panel
   in either direction.

**Two things must land in subtask 2 regardless of how the work is re-cut**, because they are
correctness rather than scope:

- `_runDispatchTimeoutSweep` (`PlanIngestionEngine.ts:2768`) abandons a dispatched card at 4 hours and
  nulls `owner_since`. It will pull a card out from under the controller's ladder.
- The four nudge sweeps de-duplicate via `notifiedSeatsThisTick` (`PlanIngestionEngine.ts:671`), a set
  a separate process cannot join. The controller's row 2 must require silence since the *last board
  nudge*, not since last output.

**Settled, do not re-open:**

- No runtime's constrained-output facility is depended on — the model emits one enum label as plain
  text. Evidence in `## Resolved Assumptions` §A of *Judgement Tiers*.
- **The controller always runs on the board host.** The off-board placement was cut: it was never
  requested (the committed plan at `HEAD` carries no placement requirement), and no use case survived
  examination.
- **The controller restarts the board itself**, which is the founding reason it is a separate process
  — an unexplained wedge, or a memory leak. `§B`'s finding that platform-supervisor presence is not
  reliably detectable is true but does not apply: no platform supervisor is involved.

**Host scope, all four subtasks:** standalone only. `src/extension.ts` is the legacy host and is being
removed; wiring any of this there is throwaway work, and "the extension does not have it" is the
intended state, not a divergence.

## Completion report (lead: Coding)

All four subtasks coded and accepted. Round 1 (Structured Cards, Controller Wakes)
and round 2 (Agent Panel, Judgement Tiers) both closed; the system released the
team.

- Structured Cards shipped the shared renderer `statusCards.js` + `statusCards.css`
  consumed by the dock, the mobile command surface and the seat status pane.
- Controller Wakes shipped the `switchboard controller` client, board lease, matrix
  store, ladder, capability probes and the Markdown report.
- Judgement Tiers added the ordered tier chain, the supervisor seat (with an explicit
  matrix exclusion), reroute, and board-owned quota/escalation state.
- Agent Panel replaced the dock/mobile button row and card picker with one shared
  controller console (`controllerConsole.js`) and added the panel-facing board routes
  (report read, config, matrix, arm/disarm/run), with membership validated at save.

Two review defects were found and fixed before acceptance: the missing supervisor
matrix exclusion (Judgement Tiers), and save-time membership validation for matrix
remediation/`requires` and judgement tier providerIds (Agent Panel).

Standalone-only throughout; `src/extension.ts` untouched. Compilation and the
automated suites were skipped this run by directive — the plans' verification checks
remain the gate, and runtime verification on a rebuilt standalone host is outstanding.

## Review Findings

All four subtasks reviewed in one pass against their plan files and the shipped code; five files
changed (`src/standalone/controller/controller.ts`, `src/standalone/controller/matrix.ts`,
`src/services/ControllerBoardStore.ts`, `src/webview/controllerConsole.js`, `protocol-catalog.json`).
Five defects were fixed: the board-restart rate limit both failed to report a suppressed restart and
cleared `consecutiveRestarts` on every suppressed pass, making the declared ceiling unreachable;
matrix-override membership was unvalidated for `condition.kind` everywhere and for `remediation`/
`requires` in the controller's own loader, so a bad row loaded cleanly and was then silently inert;
the console's 15-second staleness poll rebuilt the config editor on every tick and wiped in-progress
edits; the console composed its own hardcoded reasons for unavailable capabilities instead of
rendering the controller's; and `catalog:check` — a CI gate — was failing at HEAD on a stale
`protocol-catalog.json`. Verification: `compile-tests` clean, `catalog:check`, `standalone-parity:check`,
`standalone-fork:check`, `verb-returns:check`, `dispatch-surface:check`, `parity:check`,
`push-routing:check`, `kanban-dispatch-callers:check`, `icons:parity`, `banner:check` and the three
touched contract suites all pass; `host-seam-parity:check`, `mirror:check` and
`test:contract:panel-runtime-surface` fail for pre-existing reasons unrelated to this feature
(`setOnBoardMutated` from V81, a broken mirror script, and `memo.html`'s CSP). **The feature ships
with no automated check on any of its core mechanisms** — no suite exercises the wake loop, the
judgement chain, the lease or the three-surface renderer load — so the gates above are not evidence
that the controller works, and the runtime verdict is provisional pending a pass against a rebuilt
standalone host.

## Deferred Findings

- MAJOR — No automated check discriminates on any core mechanism of this feature: the wake loop, the ladder, the lease, redaction, the tier chain and the three-surface renderer load are all manual-only, and nothing in `.github/workflows/integration-tests.yml` touches `src/standalone/controller/`, `src/standalone/judgement/` or `src/webview/controllerConsole.js`. `src/standalone/controller/controller.ts:210`
- MAJOR — `claimLease` is a read-then-write with no compare-and-swap, so two controllers claiming in the same tick can both be granted the board. `src/services/ControllerBoardStore.ts:226`
- MAJOR — `ControllerBoardStore`'s save-time closed sets are a hand-maintained mirror of the controller's own (`KNOWN_REMEDIATIONS`/`KNOWN_CAPABILITIES`/`KNOWN_CONDITION_KINDS` versus `MATRIX_REMEDIATIONS`/`MATRIX_CAPABILITY_KEYS`/`MATRIX_CONDITION_KINDS`), and nothing gates the two against each other; a tenth remediation added to one and not the other reopens the silent-inert-row hole. `src/services/ControllerBoardStore.ts:750`
- NIT — Pre-existing gate failures left untouched because they predate this feature: `host-seam-parity:check` (`setOnBoardMutated`, from commit 2da42df4), `mirror:check` (`generateClaudeMirror is not a function`), `test:contract:panel-runtime-surface` (`memo.html` CSP). `scripts/check-claude-mirror.js:115`
- NIT — The per-subtask deferred lists in the four subtask plan files carry the remaining findings and are not repeated here.
