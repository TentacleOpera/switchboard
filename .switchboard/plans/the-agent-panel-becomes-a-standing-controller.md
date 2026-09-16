# The Agent Panel Becomes a Standing Controller, Not a Button Row

## Goal

The Agent panel — in the dock and in the mobile command surface — arms a controller that wakes on
a clock, runs a triage checklist over the board, **fixes what it finds**, and appends what it did to
a Markdown report the operator reads when they come back.

Switchboard is a rules engine augmented by AI. The controller is the augmentation: it runs the
rules, and uses a model only where a rule needs judgement. It is not a feature of Missions, and its
checklist is not limited to dispatch.

### Problem analysis

**The panel shipped as a synchronous remote control, and that was never the design.** Today the
Agent panel is seven buttons and a card dropdown. Six buttons are one mechanical POST each
(`LocalApiServer.ts:11341-11346`); the seventh, `resolve-card`, is the only `needsModel: true`
action in the entire surface. Its whole job is to pick one of `advance|move|star|unstar|none` for a
card the operator already selected by hand, in a single request/response
(`_callModelForAction`, `LocalApiServer.ts:11443`).

So the model is asked to choose a verb — the part the operator knows better than it does — after
the operator has already done the card resolution, which is the part a model would actually help
with. There is no loop, nothing runs between presses, and nothing accumulates.

**How the design was lost, in two steps.**

1. `the-dock-agent-tab-is-a-control-surface-not-a-terminal.md` specified *"The operator types an
   intent or picks an action"* — a text box. The quick-action buttons existed only as shortcuts
   that stuffed their own label into that box, which the backend then keyword-parsed.
2. `the-agent-control-surface-cannot-be-configured-and-is-driven-by-typing.md` correctly removed
   the text box (free text on a phone is exactly what the mobile surface exists to avoid) and
   replaced it with a card dropdown. Its job was "remove the box"; it rewired each button to a
   direct mechanical POST and treated the surviving set as merely under-populated — *"The buttons
   are the right shape; there are simply not enough of them."*

Neither plan asked what a button should **mean**. A button means a goal the controller pursues, not
an endpoint it calls once.

**The clock that would have carried this was deleted.** The kanban AUTOMATION tab held an
`Agent-managed` mode — *"Wakes the orchestrator agent every N minutes to decide and take the next
action."* The tab button was removed in `87080f98` (2026-08-24), and the 2026-08-29 consolidation
(`25fdb6d9`) re-homed only **two** recurring jobs into Mission Control → SCHEDULES: FETCH CLOUD
PLANS and RECONCILE CLOUD WORK, both mechanical (`mission-control.html:327-340`). The agent-managed
mode did not survive. There is now no surface anywhere that arms a judgement-bearing loop.

**And it would not have run on the Pi anyway.** Diffing the composition roots:
`src/standalone/bootstrap.ts` contains **zero** references to `automationMode`, `intervalMinutes`
or `agentManaged`; its only `orchestrat` match is a comment (`:2999`); its `autobanState` imports
are all for the mission-control *seat*. The shipped arming was `switchboard.startOrchestrator`, a
**VS Code command** (`extension.ts:1345`). The loop lived in the host that is being removed — the
same composition-root divergence as the `PlanIngestionEngine` queue seams.

**What already exists and should be reused rather than rebuilt:**

- A per-job clock: `_startSurvivorJobsTimer` (`TaskViewerProvider.ts:29114`) ticks every 60s and
  runs a job when its own `intervalMinutes` / `lastRunAt` say it is due. A 5-minute wake is the
  native shape. (Unverified: whether standalone's activation path reaches this private timer.
  Subtask 1 settles it.)
- Report primitives: `ScheduledJobsService` exports `bootstrapTeamReportsDirectory` and
  `writeTeamReport`.
- Stall detection: the dispatch-stall backstop, the queue watch seams, the seat-gone-quiet notice.

The controller does not need new infrastructure. It needs a home, a checklist, and the authority
to act.

## Metadata

- **Complexity:** 8
- **Feature:** Agent Control
- **Tags:** agents, orchestration, standalone, ui, mobile

## User Review Required

None on shape — the operator specified it: the controller lives in the dock and mobile command
panels; when it spots something wrong it fixes it; the report is a Markdown file the agent appends
to; keeping stuck agents moving is the highest-priority check.

One bounded decision remains in change 4 (what the controller may do without asking).

## Proposed Changes

### 1. The loop runs in the standalone host, not in the panel

The panel arms and observes; it does not tick. A phone with the page closed must not stop the
controller, so the clock is server-side in `src/standalone/bootstrap.ts` and survives every
surface being shut.

**The standalone root is the only composition root in scope.** `src/extension.ts` is the legacy
host and is being removed; wiring this there is throwaway work, and "the extension does not have
it" is the intended state, not a divergence.

Reuse the existing due-check shape (a 60s tick; each job's own `intervalMinutes` and `lastRunAt`
decide whether it runs). Arming state is persisted, so a board restart resumes a controller that
was on — and records that it did.

### 2. The panel's button row becomes goals, not endpoints

The card dropdown goes. A button names an outcome the controller pursues; it does not name an
endpoint.

The mechanical POSTs stay reachable — they are the fallback when the model is unusable, and the
existing rule holds: *a control surface that goes blank is worse than a terminal*. But they stop
being the primary vocabulary.

The panel gains: **arm / disarm**, **run a pass now**, **the report**, and **when it last woke**.
Both surfaces render it — `dock.js` and `command.js` each carry their own copy of this pane and
must not drift.

### 3. The checklist is a rule list, not three hard-coded checks

Switchboard is a rules engine; the controller runs rules. The checklist is data — an ordered list
of rules, each with a condition, a remediation, and whether it needs judgement — not a function
with three branches. Adding a fourth check must not mean editing the controller.

Order matters and is part of the data. **Keeping stuck agents moving runs first**, ahead of
dispatching anything new: a seat already holding work that has gone quiet is a worse failure than
a card that has not started, and dispatching more work onto a stalled fleet compounds it.

A rule needing judgement is where the model is called — and only there. A rule that is purely
mechanical never costs a model call, so the controller keeps running when the model is down, in
degraded form, and says so in the report.

### 4. The controller fixes what it finds **[decision]**

When a rule fires, the controller applies its remediation rather than recording a to-do. That is
the point of it running while the operator is away.

What bounds this: the remediations available to the controller are the **existing verbs** — re-stage
a dead seat, re-dispatch, nudge, seat a team the work needs, move a card. The controller composes
rules; it does not invent actions.

The decision to confirm: whether any rule is allowed to be *advisory* (record, do not act) in v1,
or whether every rule acts and the report is purely a record of what was done. Recommend every
rule acts — an advisory tier is how a controller becomes a thing you have to check, which is the
failure this replaces.

Per CLAUDE.md, no confirmation dialog gates any of it, on any surface.

### 5. The report is a Markdown file the controller appends to

One file, appended per wake, rendered by the panel. Reading it costs **no model call**: it is
readable when the model is down, survives restarts, and is the same artifact whether read from the
dock, the phone, or a text editor.

Each entry records the wake time, which rules fired, what was done, and what failed. Following the
fallback rule: every action names the rule that triggered it and the source that answered — "which
rule did this, and on what evidence" must be answerable after the fact, not inferred.

A model-written summary across passes may sit **on top** of the file as a later addition. It is
never the only way in.

### 6. Arming is one path, and it reports its source

A controller that is armed must be distinguishable from one that was never armed, and from one
whose arming failed. `armed: false` is not the same value as "no controller configured" — the
panel shows which, and the report records transitions.

## Non-goals

- **A Missions feature.** The controller supervises the board under whatever rules exist. Missions
  is one caller among others, not its container.
- **Reintroducing a text box.** Goals are buttons. The mobile surface designed typing out
  deliberately and this does not bring it back.
- **Reintroducing a terminal.** The panel renders no emulator.
- **Wiring the VS Code host.** Out of scope by the cutover rule.
- **A second clock.** Reuse the existing due-check; a second interval is a second clock.
- **Routing mechanical actions through the model.** A rule that does not need judgement does not
  get a model call.

## Verification

- The controller wakes, runs its checklist and appends to the report with **every panel closed** —
  the test that it is not a webview loop.
- A board restart with the controller armed resumes it, and the report records the restart.
- With the model unreachable, mechanical rules still run, remediations still apply, and the report
  says the judgement rules were skipped and why.
- A stalled seat is recovered **before** any new dispatch in the same pass.
- The report is readable with the model unconfigured.
- The dock and mobile panes are diffed by hand for the seams each wires — not the verbs each
  answers.
