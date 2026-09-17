# The Controller Wakes on a Clock, Diagnoses, and Reports

## Goal

The Agent panel — in the dock and in the mobile command surface — arms a **controller**: a process
that wakes on a clock, runs a triage checklist over the board, **diagnoses why work is stuck**,
fixes what it can, and appends what it did to a Markdown report the operator reads when they come
back.

Switchboard is a rules engine augmented by AI. The controller is the augmentation: it runs the
rules, and uses a model only where a rule needs judgement. It is not a feature of Missions, and its
checklist is not limited to dispatch.

**The controller is a client, not a part of the board.** It runs on the board host or on another
machine over the tailnet, and it drives the board through the existing CLI surface. Both
placements are supported and ship together.

### Problem analysis

**The panel shipped as a synchronous remote control, and that was never the design.** Today the
Agent panel is seven buttons and a card dropdown. Six buttons are one mechanical POST each
(the `quickActions` array in `_handleAgentControlConfig`, `LocalApiServer.ts:10776-10782`); the seventh, `resolve-card`, is the only `needsModel: true`
action in the entire surface. Its whole job is to pick one of `advance|move|star|unstar|none` for a
card the operator already selected by hand, in a single request/response
(`_callModelForAction`, `LocalApiServer.ts:10918`).

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

#### The stuck-seat problem is diagnosis, and nothing does it

Four stall **nudge** sweeps already run, back to back, on every tick
(`PlanIngestionEngine.ts:680-763`): the feature nudge (`_runFeatureNudgeSweep`, `:1203`), the queue
nudge (`_runQueueNudgeSweep`, `:1465`), the member completion reminder
(`_runMemberCompletionReminderSweep`, `:2104`), and the dispatch-stall nudge
(`_runDispatchStallSweep`, `:2434`). They share a liveness snapshot, `turnEndSilenceMs` and
`nudgeSilenceMs`, and they all take the **same** action — re-deliver a prompt.

**A fifth sweep runs on the same tick and does not nudge: it abandons.**
`_runDispatchTimeoutSweep` (`PlanIngestionEngine.ts:2768`) fires at `dispatchTimeoutMs` (default
**4 hours**, `:625`), writes `timed out (seat=…, elapsed=…)` to `last_action`, and then releases the
seat — nulling `owner_since`. Its own docblock names it *"the sole abandonment path that nulls
`owner_since` for a live-but-silent seat"*. The engine also warns when
`dispatchTimeoutMs <= dispatchStallMs`, because the abandonment must not overtake the nudge.

This is the one existing mechanism that **competes** with the controller rather than duplicating it.
Three collisions follow, and each is a bug if unhandled:

1. **The ladder and the timeout race.** A seat the controller is walking up
   nudge → clear → reroute can be abandoned out from under it at the 4-hour mark. `owner_since`
   disappears, and the controller's next wake sees a card with no owner — a *different* diagnosis
   from the one it was pursuing, with the ladder state now unanchored.
2. **`owner_since` is the controller's own clock input.** Every "how long has this been stuck"
   question the matrix asks is answered from `owner_since`. A `clear + respawn` (row 4) or a reroute
   (row 5) that re-stamps it silently resets the timeout countdown; one that does not re-stamp
   leaves the controller reading an age that belongs to a seat that no longer holds the work.
3. **A `timed out` card is evidence, not a blank.** The controller must read `last_action` and treat
   `timed out` as a *prior verdict* — a card the board already gave up on is not a fresh row-1 case.

**Resolution this plan adopts:** the controller does not replace the timeout sweep and does not
disable it. It **reads** `owner_since`, `completed_at` and `last_action` as inputs, records the
`owner_since` value it acted on in each report entry, and every remediation that changes seat
ownership states explicitly whether it re-stamps `owner_since`. Where the controller has an open
ladder on a subject, the report names the remaining time to `dispatchTimeoutMs` so the abandonment
is visible before it happens rather than discovered afterwards.

**None of them asks why the seat went quiet.** There is no cause classification for seats anywhere
in the codebase; the only quota and rate-limit machinery is for tracker APIs (ClickUp, Linear,
Notion), nothing for an agent CLI running out.

That matters because the causes need opposite responses:

- A seat **waiting on a human answer** is healthy. A nudge is noise; a clear destroys work in
  progress. The right move is to surface the question, or answer it.
- A seat **out of quota** cannot be fixed by any board verb. Re-dispatch burns more quota or fails
  instantly. The right move is to stand down and route the work elsewhere.
- A seat hitting an **undiscovered bug** has no remediation at all. The value is the written
  diagnosis.

A controller whose stuck-seat rule is "quiet → nudge" adds nothing that is not already running four
times per tick. **Diagnosis is the job worth a model.** Remediation selection, once the cause is
known, is mostly mechanical.

`_runMemberCompletionReminderSweep` (`PlanIngestionEngine.ts:2104`, and the `completed_at` note at `:1255`) documents a further case the sweeps already get wrong: `completed_at`
has one writer, the *lead's* assertion via `POST /kanban/task/complete`, so a member that has
already reported and is waiting on its lead still trips the "gone quiet holding an uncompleted
card" gate.

#### The evidence exists; the endpoint is already there

`GET /terminals/<name>/log` (`LocalApiServer.ts:8683`) serves a ranged tail of a seat's session log
— 256 KB default, 2 MB ceiling, `?tail`/`?offset`/`?session`, fence-normalized markdown, with
`/terminals/<name>/logs` (`:8783`) listing sessions. That is the diagnosis input for every
judgement rule, and it works over the tailnet because it is an ordinary authenticated GET, not the
WS hub.

Its docblock also carries a constraint this plan must respect: *"The log files may contain secrets
(agent terminals echo tokens, env and paths), so the auth gate is load-bearing."*

#### Restart is two different actions wearing one name

`terminal.fleet.surviveBoard` (default `false`, `package.json:404`) decides whether the PTY host
outlives a board restart. With it **off**, `stop()` runs `ptyFleetService.disposeAll()`
(`bootstrap.ts:5695`) and restarting the board kills every seat and every agent CLI. With it
**on**, the host is spawned detached with `--survive-parent` and `unref()`
(`ptyHostSupervisor.ts:301-316`) and the successor board adopts the live host — a restart costs
almost nothing.

A controller that picks "restart the board" without reading that setting is doing one of two wildly
different things and recording neither. Same verb, opposite blast radius.

`POST /shutdown` (`LocalApiServer.ts:12957`) is **loopback-only and explicitly refuses tailnet
peers**, and requires `host.kind === 'standalone'`, `capabilities.shutdown.enabled === true`, and a
wired callback — a mismatch is refused as a wiring bug. Nothing restarts the board afterwards.

#### There is no reroute verb, and the column it would have used is gone

Moving work from an exhausted seat to a different one does not exist today in any form.

> **Superseded:** "`routed_to` is a column with no verb behind it."
> **Reason:** `routed_to` no longer exists. Migration **V81** (*the-board-never-refuses-a-dispatch*,
> `KanbanDatabase.ts:12524-12545`) drops every refusal/ownership column from `plans` —
> `routed_to`, `dispatched_agent`, `dispatched_ide`, `dispatched_terminal`, `dispatched_at`,
> `queue_position`, `released_at`, `outcome`, `workflow`, `last_liveness_at`, `blocked_at` — and
> replaces them with the advisory pair `owner_seat` / `owner_since`. `LocalApiServer.ts:4252`
> records the consequence: *"V81: `routed_to` is gone — the role check now goes through the live
> fleet lookup only."* Planning a reroute around a dropped column would have produced a migration
> that reintroduces state V81 deliberately removed.
> **Replaced with:** reroute is built on the surviving shape below.

**What reroute actually has to be, post-V81.** The advisory pair is *display metadata, never a gate*
(`KanbanDatabase.ts:12530`), so a reroute is not a state transition on the card — it is a
re-dispatch to a different seat plus an owner re-stamp. It needs three things that do not exist:

- **Provider recorded per seat.** Today the provider is a property of the seat's startup command and
  its CLI family, not a queryable field. Row 5's "reroute to another provider's seat" cannot be
  resolved without it, and its precondition (≥2 distinct providers seated) cannot be *evaluated*
  without it either — so the capability probe in change 6 needs this too.
- **A resolver for "which other seat could take this."** Role-compatible, live, not the supervisor,
  not parked, and on a different provider.
- **Quota state that survives a board restart.** Without it the controller reroutes straight back
  into the exhausted seat on the next wake. This is board state (the `config` table, change 11), not
  controller state — a controller that restarts must not lose it, and a second controller must not
  disagree about it.

**V81 also removes the safety net the plan was implicitly counting on.** *The board never refuses a
dispatch* is an explicit invariant (`LocalApiServer.ts:3628`, `:5452-5453`, `:5572`, `:5690`): the
board will happily dispatch onto the exhausted seat the controller just stood down. **Stand-down is
therefore enforceable only in the controller**, as a rule precondition it checks before acting. Any
design that expects the board to refuse is wrong on this codebase.

**What already exists and should be reused rather than rebuilt:**

- **The CLI is the client.** `switchboard api <METHOD> <path> [jsonBody] [--json] [--data @<file>]
  [--timeout <ms>]` and `switchboard verb <verbName> [jsonPayload] [--json]` cover every read and
  every action, and `fleet`, `clear`, `dispatch`, `plans`, `ready`, `reports`, `done`, `next` and
  `status` all take `--json` (`cli.ts:27-40`). The controller needs no second client.
- **Capability declaration.** `capabilities.shutdown` (`LocalApiServer.ts:869-872`) is the shipped
  pattern for "this host can or cannot do this, and here is why", and `getLauncherState` is the
  matching pattern for data: `{ unavailable: true, reason, source }`, never an empty value that
  reads as "none configured".
- A per-job clock: `_startSurvivorJobsTimer` (`TaskViewerProvider.ts:29086`, armed standalone via `restoreAutobanOnStartup` at `bootstrap.ts:5683`) ticks every 60s and
  runs a job when its own `intervalMinutes` / `lastRunAt` say it is due.
- Report primitives: `ScheduledJobsService` exports `bootstrapTeamReportsDirectory` and
  `writeTeamReport`.
- Stall detection: the four sweeps above, and the seat-gone-quiet liveness snapshot they share.


This subtask builds the **spine**: the CLI client, its clock, its board lease, its capability
declaration, the matrix as a data store, the escalation ladder, and the Markdown report — with the
**mechanical rows only**. It deliberately contains **no model call at all**. The judgement rows, the
tiered backends, the supervisor seat and reroute are the *Judgement Tiers, the Supervisor Seat and
Reroute* subtask; the panel that arms and configures it is *The Agent Panel Becomes a Standing
Controller, Not a Button Row*.

Shipping the spine modelless first is deliberate. It is independently useful — a board that
mechanically diagnoses and fixes rows 1, 2 and 4, declares its arming state honestly, and writes a
report an operator can read from a phone — and it forces the highest-risk seam in the whole feature
(the collision with `_runDispatchTimeoutSweep`) to be settled before anything is layered on it.

## Dependencies

**None that block.** The controller is co-located with the board and resolves a loopback target, which
works with today's code. `the-cli-reaches-a-remote-board-over-the-tailnet.md` (board column
**CREATED**) is **not** a dependency of this subtask — it was one only for the off-board controller
placement, which has been cut (see change 1).

**Naming: the CLI is being renamed.** *One Name End to End: Switchboard Becomes LABCOM, and the CLI
Becomes `lc`* is in PLAN REVIEWED alongside this feature. Every `switchboard …` command written here
is the current spelling; whichever plan lands second adopts the other's name. Nothing here should be
implemented as a second, competing rename.

## Metadata

- **Complexity:** 7
- **Tags:** backend, cli, api, reliability, feature

## Host Scope

**Standalone only.** `src/extension.ts` is the legacy host and is being removed; wiring this there
is throwaway work, and "the extension does not have it" is the intended state, not a divergence.
No `extension.ts` composition-root seam is touched, and none should be added.


## Complexity Audit

### Routine

- Appending a Markdown report through `writeTeamReport` / `bootstrapTeamReportsDirectory`
  (`ScheduledJobsService.ts:248`, `:264`), which already exist and are already called from two places.
- Reading the log tail for evidence: `GET /terminals/<name>/log` (`LocalApiServer.ts:8683`) and
  `GET /terminals/<name>/logs` (`:8783`) ship, are authenticated, and are fence-normalized.
- Mechanical matrix rows 1, 2 and 4 — each is an existing verb behind a condition on data the board
  already returns.
- The 60s due-check tick itself.

### Complex / Risky

- **The board-side lease.** A single-writer claim with renewal, staleness and a refusal path is new
  state with a concurrency contract, and it is what stops two controllers double-remediating. Getting
  it wrong is silent double-action, not an error.
- **Interaction with `_runDispatchTimeoutSweep`** (`PlanIngestionEngine.ts:2768`). Two independent
  actors now mutate `owner_since` on the same cards on overlapping clocks. This is the single
  highest-risk seam in the feature.
- **Redaction of log slices before they leave the board.** The log endpoint's own docblock says the
  files carry tokens, env and paths. A redaction miss ships secrets into a Markdown report, and the
  failure is invisible until someone reads the report.
- **The matrix as data, not branches.** Adding a row must not mean editing the controller.

## Edge-Case & Dependency Audit

### Race Conditions

- **Two controllers, one board.** The lease is the mitigation; the race is between claim and renew,
  and between a stale lease expiring and the original controller waking from sleep still believing it
  holds it. A returning controller must re-read the lease before acting, not assume it.
- **Controller ladder vs. dispatch-timeout abandonment.** Detailed in the Goal's sweep section. The
  4-hour sweep can null `owner_since` mid-ladder.
- **Controller vs. the four nudge sweeps.** Both can nudge the same seat in the same minute. The
  sweeps de-duplicate among themselves via `notifiedSeatsThisTick` (`PlanIngestionEngine.ts:671`,
  threaded into all four sweeps at `:690`-`:743`), a set the controller — a separate process — cannot
  join. A seat therefore receives the board's nudge and the controller's nudge back to back. The
  controller's row-2 condition must require silence *since the last board nudge*, not silence since
  last output.
- **Config edited mid-wake.** Read the config once at the top of a wake and use that snapshot for the
  whole pass, recording its version.

### Security

- **Log tails carry secrets.** `_handleTerminalLog`'s docblock is explicit. Every slice that reaches a
  report entry is redacted first, and the smallest window that answers the rule is the window used.
- **The lease is an authorization boundary in miniature.** Whatever identity a controller claims with
  must be the identity the report records; a claim that can be spoofed makes every report entry's
  attribution worthless.
- **`POST /shutdown` stays loopback-only.** `_isTailnetSocket` refusal at
  `LocalApiServer.ts:12968-12975` is not relaxed.

### Side Effects

- Every remediation is an existing verb with its existing blast radius — `clear` kills a running agent
  process; a reroute re-stamps ownership; a board restart with `terminal.fleet.surviveBoard` **off**
  (the default, `package.json:404`) destroys the entire fleet.
- The report file grows without bound. It is append-only by design; rotation or a size ceiling is
  needed or the panel eventually renders a multi-megabyte file on a phone.
- Arming a controller changes board behaviour for every operator of that board, not just the one who
  armed it.

### Dependencies & Conflicts

- **No blocking dependency.** `the-cli-reaches-a-remote-board-over-the-tailnet.md` is no longer
  relevant to this subtask — it supported the off-board controller placement, which is cut.
- **Conflict:** `_runDispatchTimeoutSweep` and the four nudge sweeps — existing shipped behaviour this
  subtask must compose with, not replace.
- **Reads but does not change:** `ScheduledJobsService`'s report primitives, the terminal log
  endpoints, `GlobalIntegrationConfigService`'s `agentControlProviders` rows.

## Adversarial Synthesis

Key risks: the controller shares mutation of `owner_since` with the 4-hour `_runDispatchTimeoutSweep`
and with four nudge sweeps it cannot coordinate with, so a ladder can be abandoned or double-nudged
underneath it; redaction of log tails is the only thing standing between evidence gathering and
secrets in a Markdown report; and a modelless spine can satisfy every liveness check while diagnosing
nothing correctly. Mitigations: `owner_since`/`last_action` are read inputs recorded per entry, row 2
requires silence since the *last board nudge*, redaction carries a paired negative/positive
invariant, and the mechanical rows are verified against fixtures for correctness, not just for
firing.

## Proposed Changes

### 0. Which files "the Agent panel" means (read this before grepping)

There are two unrelated things in this repo called *Agent Control*, and the larger one is **not**
what this plan touches. A coder who greps for the name will land on the wrong file first.

| file | what it is | this plan |
| --- | --- | --- |
| `src/webview/dock.js:140-560` (markup in `dock.html`) | the **dock's Agent tab** — log, quick actions, card/column pickers, provider config | **in scope** |
| `src/webview/command.js:2625-2900` (markup in `command.html:1113-1145`) | the **mobile command surface's `agent` view** — a near-verbatim copy of the above | **in scope** |
| `src/webview/agent-control.js` (4001 lines) + `agent-control.html` | the **Agent Control panel** — Agents, Teams, Prompts, Standing Orders tabs, extracted from `kanban.html` | **out of scope; do not edit** |
| `src/webview/terminals.js:8187` `renderStatusPane` (CSS `terminals.css:1530`) | the **seat status pane** | in scope for change 12 only |

The two in-scope copies are genuinely duplicated: the same element ids
(`agent-control-log`, `agent-control-quickactions`, `agent-control-card-select`,
`agent-control-provider`, …) are queried independently in each file, and each has its own render and
fetch path. That duplication is the divergence risk change 2 names, and it is why change 12's shared
renderer is not optional polish.


This subtask writes the controller and the report. It does **not** rebuild the panel — the panel
subtask consumes what this one publishes.

### 1. The controller is a CLI client, co-located with the board

`switchboard controller` is a new CLI mode: a long-running process that resolves one `ApiTarget`
and drives the board through the same request path every other command uses. It is not a webview
loop, and it is not a service inside `bootstrap.ts`.

**Why a separate process, and not a thread in the board.** The controller's job includes
**restarting the board** — matrix row 7, and the reason a memory leak or an unexplained wedge has
anything watching it at all. A component cannot restart the process it lives inside. That is the
whole argument, and everything below is secondary to it:

1. **It must be able to restart the board.** A leaking or wedged board needs something outside it to
   recycle it. In-process, the only recovery is a human noticing.
2. **Blast radius the other way.** A wedged or crashed controller must not take the board with it.
   In-process, recovery means restarting the board — and with `terminal.fleet.surviveBoard` **off**
   (the default, `package.json:404`), `stop()` calls `ptyFleetService.disposeAll()`
   (`bootstrap.ts:5695`) and kills every seat and every agent CLI. A judgement loop must never be able
   to cost the fleet.
3. **Arming must not require a board restart.** As a process, arm is *start* and disarm is *stop*.
4. **A board with no controller is the normal deployment, not a disabled one.** Most installs will
   never stand up a judgement backend, so the controller must be *omittable*, not present-and-off.
5. **The board must not grow a model client** — an HTTP client to an operator-supplied endpoint, its
   timeout and retry policy and its redaction path do not belong on the component that owns the
   single SQLite store.

> **Superseded:** two supported placements — the controller on the board host (loopback) or **on
> another machine over the tailnet** — shipping together, with a worked table of controller-placement
> × model-placement combinations and a hard dependency on
> `the-cli-reaches-a-remote-board-over-the-tailnet` for the remote case.
> **Reason:** the off-board placement was never asked for. It appeared in an uncommitted edit to this
> plan attributed to "the operator"; the committed version at `HEAD` carries no placement requirement
> at all, and the operator confirms they did not request it. No use case survived examination — the
> "Pi spends no CPU on judgement" argument is delivered by the *model endpoint* being remote, not the
> controller; "survives a power cycle" is thin for a process that already survives a board
> stop/start; "minimal appliance image" does not justify a dependency on an unimplemented plan.
> The intended shape was always **model on the board or in the homelab**, never a controller in a
> remote location.
> **Replaced with:** **the controller always runs on the board host.** One placement.

**One placement: co-located with the board.** The controller resolves a loopback `ApiTarget` and
drives the board through the same request path every other CLI command uses. Consequences, all
simplifications:

- **No dependency on `the-cli-reaches-a-remote-board-over-the-tailnet`.** It is not on this subtask's
  critical path in any form.
- **`POST /shutdown` is reachable.** It is loopback-only and refuses tailnet peers
  (`LocalApiServer.ts:12968-12975`); a co-located controller passes that gate unconditionally. This
  was previously a limitation of the remote case and is now simply not a constraint.
- **Nothing sensitive crosses a wire to reach the controller.** Log tails are read from the board's
  own `.switchboard/logs/` over loopback and are redacted before any model call. There is no
  arrangement in which an unredacted slice leaves the machine.
- **The arming states lose their "the controller's machine slept" reasoning** but keep the states
  themselves: a co-located controller can still crash or hang, so "armed and healthy" must remain
  distinguishable from "armed but not reporting" (change 6).
- **The lease is still required.** Two `switchboard controller` processes started by accident on one
  box is the case it prevents.

**The model endpoint is a separate question and is unchanged.** It is a URL the controller holds, and
it may be on the board host, elsewhere in the homelab over the tailnet, or a hosted API. That is
configuration, not placement, and none of the above constrains it.

**Reuse the CLI's own request path rather than writing a client.** Rules are expressed as CLI
invocations (`switchboard api GET /kanban/plans --json`, `switchboard clear <seat> --json`), and
the report records the equivalent command line so any action the controller took is a line the
operator can paste and reproduce.

*Implementation note (small, decide during build):* invoke `apiRequest` in-process rather than
spawning a subprocess per action — same code path, no spawn cost — while still recording the
command line. Spawning is acceptable if it proves simpler; what is not acceptable is a second
client that can drift from the CLI.

The clock is the controller's own: reuse the existing due-check *shape* (a 60s tick; each rule's
`intervalMinutes` and `lastRunAt` decide whether it runs). A phone with the page closed must not
stop the controller, and neither must a closed dock.

**"Shape", not the runner — and the SCHEDULING RULE needs an explicit answer.**
`TaskViewerProvider.ts:29104-29112` states the rule a reviewer will cite: *"Recurring work is
dispatched by exactly ONE runner — this ScheduledJob poll (`_survivorJobsTimer` →
`runSchedulerJob`) … any timer that dispatches work/prompts agents MUST use this runner."* The
controller prompts agents, so the rule is on point.

The controller is nonetheless **outside** that rule, and the plan states why rather than leaving it
to be argued at review time: the ScheduledJob runner is a timer **inside the board process**, and
this plan's central commitment is that the controller is a **client**, which may not share the
board's process or lifetime — it must be able to **restart the board**, which a `ScheduledJob` inside
the board cannot do. What the rule is protecting — one
authority for recurring prompts, no shadow timers inside the board — is preserved by a different
mechanism: the board-side **lease** of change 6, which admits exactly one controller. Nothing new
ticks inside `bootstrap.ts`.

Note also that the survivor-jobs runner **does** run on the standalone host: `restoreAutobanOnStartup`
(`TaskViewerProvider.ts:13011`) is wired at `bootstrap.ts:5683`. It is therefore available as
precedent and as a place the operator's other recurring jobs already live; it is simply not where a
client-side loop belongs.


### 3. The checklist is a solutions matrix, and it is data

Switchboard is a rules engine; the controller runs rules. The checklist is an ordered list of
rules — each with a condition, an evidence source, a judge, a remediation, and a **precondition** —
not a function with branches. Adding a row must not mean editing the controller.

| # | Cause | Evidence | Judge | Remediation | Precondition |
| --- | --- | --- | --- | --- | --- |
| 1 | Finished, never reported | `completed_at` NULL + seat at rest | mechanical | mark complete / advance | — |
| 2 | Idle, no blocker | silence + clean log tail | mechanical | nudge | — |
| 3 | Waiting on a human | log tail ends in a question or prompt | **model** | relay the answer if derivable, else hand to the supervisor, else escalate with the question quoted | model |
| 4 | Crashed / dead process | liveness gone, non-zero exit in tail | mechanical | `switchboard clear <seat>` — family-aware respawn | — |
| 5 | Out of quota / rate-limited | provider error text in tail | **model** | stand down, record the reset, reroute to another provider's seat | model + ≥2 providers seated |
| 6 | Looping / undiscovered bug | repeated identical output, error churn | **model** | hand to the supervisor seat; with none configured, write the diagnosis and escalate | model; supervisor to remediate |
| 7 | Board-level wedge | ≥N seats stuck, no single cause | **model** + threshold | restart the board | supervisor present |
| 8 | Unknown | nothing above matches | **model** | record evidence, escalate, act not at all | model |

**Row 8 is load-bearing.** Without an explicit `unknown` outcome the model is forced to name a
plausible class, which is the quiet wrong answer CLAUDE.md's fallback rule exists to prevent.

**Order matters and is part of the data. Diagnosis of held work runs before any new dispatch:** a
seat already holding work that has gone quiet is a worse failure than a card that has not started,
and dispatching onto a stalled fleet compounds it. Note the framing is *diagnose* first, not *kick*
first — "keep it moving" presumes a nudge is the answer, which is wrong for rows 3, 5 and 6.

A rule needing judgement is where the model is called — and only there. Mechanical rows never cost
a model call, so the controller keeps running when no model is configured at all.

**A row whose precondition is unmet is reported as unavailable with its reason, never skipped
silently.** "Reroute unavailable — one provider seated" is a different fact from "reroute was not
needed", and collapsing them is the fallback rule again.


**Scope note for this subtask.** The full matrix above is the shipped data — all eight rows,
including the judgement ones — because it is a *store*, and a row that does not exist cannot declare
itself unavailable. What this subtask implements is the **mechanical** evaluation path: rows 1, 2 and
4 run; rows 3, 5, 6, 7 and 8 are present in the store and report as unavailable with the reason
`no judgement backend configured`, which is exactly the state a modelless deployment ships in
permanently. The *Judgement Tiers* subtask makes them reachable.

### 4. The controller acts, on a ladder, one rung per pass

When a rule fires, the controller applies its remediation rather than recording a to-do. That is
the point of it running while the operator is away.

What bounds this is an **escalation ladder**: the controller may raise a given seat or card by one
rung per wake, and the report records the rung and the evidence.

```
nudge → relay/answer → clear + respawn → reroute → stand down → supervisor → escalate to human → restart board
```

A seat nudged twice earns a clear; a seat cleared twice earns an escalation. Nothing jumps
straight to a board restart on one weak classification at 3am.

**Decided — stand down and escalate are actions, not an advisory tier.** The original framing of
this decision — "every rule acts, or some rules only advise" — was wrong: for row 5 the correct
*act* is to stop acting and record why. **There is no advisory tier**; stand-down and escalate are
first-class remediations with their own rungs, and every row either acts or records `unknown`.

The remediations available are the **existing verbs**, reached through the CLI. The controller
composes rules; it does not invent actions. Two verbs do not exist yet and are split out (changes
9 and 10).

Per CLAUDE.md, no confirmation dialog gates any of it, on any surface.


**Scope note for this subtask.** The full ladder is specified and enforced here — one rung per wake,
the rung recorded in the report — because the bound is a property of the controller, not of the
model. The rungs this subtask can actually reach are `nudge`, `clear + respawn`, and
`escalate to human`; `relay/answer`, `reroute`, `stand down` and `supervisor` become reachable when
the judgement rows do, and `restart board` is deferred entirely.

### 5. The report is a Markdown file, written to the board

One file, appended per wake, rendered by the panel. Reading it costs **no model call**: it is
readable when the model is down, survives restarts, and is the same artifact whether read from the
dock, the phone, or a text editor.

**The controller writes it to the board over the API, never to its own disk.** A report on the
Mac's filesystem is unreadable from the phone, which defeats the entire purpose. Reuse
`writeTeamReport` / `bootstrapTeamReportsDirectory` behind an API verb.

Each entry records the wake time, the controller's identity and target source, which rules fired,
the rung taken, the command run, the evidence, the outcome, and what failed. Following the
fallback rule: every action names the rule that triggered it and the source that answered — "which
rule did this, and on what evidence" must be answerable after the fact, not inferred.

**Redact before the evidence leaves the board.** Log tails carry tokens, env and paths by the log
endpoint's own docblock. Any slice that goes into a report entry or into a model call is redacted
first, and the smallest window that answers the rule is the window sent.

> **Superseded:** "A model-written summary across passes may sit **on top** of the file as a later
> addition. It is never the only way in."
> **Reason:** it was the only place in the whole design where a model authored text that lands in a
> durable artifact, and it earns nothing. The "why" of every entry is already the rule that fired, the
> evidence window it read, the rung it took and the command it ran — all of which the controller knows
> exactly and the model would only paraphrase. On a decode-bound judgement host a prose summary is
> also the most expensive output the system could ask for. Leaving it in invited the reasonable
> misreading that *the model writes the report*.
> **Replaced with:** nothing. **The model never writes to this file, and never writes any file.** It
> is asked for one label per judgement call and has no filesystem, no verb vocabulary and no command
> surface. The controller composes every report entry from facts it holds, and writes the file to the
> board over the API.


### 5b. The controller can restart the board

This is why the controller is a separate process (change 1), and it needs no model. Row 7's
*trigger* — "≥N seats stuck, no single cause" — is judgement and lives in the *Judgement Tiers*
subtask. The **mechanism** lives here, and is reachable from mechanical conditions too.

**The mechanical trigger is the founding case: a leaking board.** The board process is long-lived
(measured at ~630 MB RSS on a working machine, 182 MB fresh on a Pi 400). An RSS threshold is a
mechanical rule — no judgement, no model — so a board with no judgement backend configured can still
recycle a board that is leaking. Likewise an unresponsive `/health`.

**Sequence, and every step is load-bearing:**

1. **Write the report entry first.** The reason for a restart must survive the process that decided
   it. An entry written after the fact is an entry that is never written when step 4 fails.
2. **Capture how to start it again, before stopping it.** `GET /health` returns the board's `pid`,
   `port` and `roots`; the controller records the invocation it will need. A controller that shuts
   the board down and then discovers it does not know how to start it has bricked the appliance.
3. **`POST /shutdown`**, which is loopback-only and therefore always available to a co-located
   controller (`LocalApiServer.ts:12968-12975`). Then wait for the port to free.
4. **Fall back on the pid.** A board wedged badly enough to need restarting may not answer
   `/shutdown`. After the graceful deadline: `SIGTERM` to the recorded pid, then `SIGKILL` after a
   second deadline. Each escalation is recorded.
5. **Spawn the successor detached.** `detached: true` plus `child.unref()`, the same pattern
   `ptyHostSupervisor.ts:301-316` already uses for `--survive-parent`. **The board must not be a
   child that dies with the controller** — that would make the controller's own crash a board
   outage, inverting the reason it exists.
6. **Verify health, and report the outcome.** A restart that did not come back is the most important
   line the report will ever carry.

**Read `terminal.fleet.surviveBoard` and record it.** Off (the default, `package.json:404`), `stop()`
runs `ptyFleetService.disposeAll()` (`bootstrap.ts:5695`) and the restart kills every seat and every
agent CLI. On, the successor adopts the live pty host and the restart costs almost nothing. Same
verb, opposite blast radius; the entry says which one happened.

**Rate-limit the restart, and make the limit visible.** A board that wedges immediately after start
would otherwise be restarted forever. A declared minimum interval and a consecutive-restart ceiling,
both reported when reached — a controller that silently stops restarting is indistinguishable from a
board that stopped wedging.

**Nothing supervises the controller, and that is the accepted state.** With the board restart handled
in-process by the controller, the only remaining supervision question is who restarts the
*controller*. The answer is: nobody, by default. That fails safe — a dead controller means no
automation, not a dead board — and the operator may put it under systemd on Linux if they want more.
The capability probe reports what it can determine here rather than gating anything on it.

### 6. Arming, capability and liveness are three declared states, never collapsed

A controller that is armed must be distinguishable from one that was never armed, and from one
whose arming failed. `armed: false` is not the same value as "no controller configured".

**The controller holds a lease on the board.** It claims with its identity, renews on each wake,
and the board refuses a second claimant. Without this an on-board controller and a remote one
double-remediate the same stuck seat — two nudges, two clears, two reroutes.

**The lease renewal is also the heartbeat, and on a laptop it is the state that will actually
fire.** Lids close; a Mac controller stops silently. The board must be able to say so.

| state | meaning |
| --- | --- |
| no controller configured | nothing was ever armed |
| armed, controller healthy | lease current, last wake recent |
| armed, controller late | lease stale — the controller's machine slept or died |
| armed, model unreachable | mechanical rows only — the controller still runs |

The report records transitions between them, not just arm/disarm. A model that answers with garbage
trips the unreachable path: a judgement rule that cannot produce a valid remediation has not run,
whatever the HTTP status said.

**The available row set is declared, not assumed.** Following `capabilities.shutdown`, the
controller publishes `{ enabled, reason, source }` per row, computed from four probes:

**The probes run at the top of every wake, not once at arm.** Fleet composition changes under a live
controller — a machine that only hosts seats in off-hours (configuration 1 above) makes
"≥2 distinct providers seated" true at night and false by morning, and a model host sleeps and wakes.
A capability set computed once at arm is either permanently unavailable or permanently claimed, and
both are wrong in a way the report would never show. Each wake re-probes, uses that snapshot for the
whole pass, and records it; a row whose availability *changed* since the previous wake is called out
in the entry rather than silently differing.

| probe | gates |
| --- | --- |
| model endpoint: configured / reachable / constrained-output capable | rows 3, 5, 6, 8 |
| supervisor present (systemd, launchd, Docker restart policy, none) | row 7 |
| `terminal.fleet.surviveBoard` | the blast radius of a controller-issued restart (change 5b), not its availability |
| ≥2 distinct providers seated | row 5's reroute |

**Decided — the panel shows unavailable rows, greyed, with their reason.** A controller whose
capability set is invisible is one the operator cannot reason about, and a hidden row is
indistinguishable from a row that never existed — the fallback rule applied to the surface itself.
Hiding was rejected.


**Scope note for this subtask.** All four probes are implemented, because the capability declaration
is what makes a modelless board legible rather than broken. The model probe correctly reports "not
configured" in this subtask; it does not need a model to do so.

## Non-goals

- **A Missions feature.** The controller supervises the board under whatever rules exist. Missions
  is one caller among others, not its container.
- **Reintroducing the intent-parsing text box.** The removed box keyword-matched typed phrases
  into verbs; goals are buttons and stay buttons. The supervisor chat in change 2 is not that box:
  it is a conversation with a seat that can act, it replies in structured cards, and the operator
  answers by tapping.
- **Reintroducing a terminal.** The panel renders no emulator.
- **Wiring the VS Code host.** Out of scope by the cutover rule.
- **A second client.** The controller drives the board through the CLI's request path. A bespoke
  HTTP client that can drift from the CLI is the thing this avoids.
- **A second clock.** Reuse the existing due-check shape.
- **Routing mechanical rows through the model.** A row that does not need judgement does not get a
  model call.
- **Bundling or supervising a model runtime.** Nothing installs weights, starts `llama-server`,
  health-checks it or restarts it.
- **Assuming the model is local.** No code path may treat the endpoint as in-process, instant, or
  always up.
- **Blocking the controller on the model.** The model is a dependency of the judgement rows, not of
  the loop. A sleeping host degrades the pass; it never stops it.
- **Assuming the controller is local.** The inverse, and equally important: the board must not
  assume the controller shares its filesystem, its clock or its uptime.


## Verification Plan

### Automated Tests

- The controller wakes, runs its checklist and appends to the report with **every panel closed**.
- The controller resolves a loopback target and the report names which board answered.
- A board restart with the controller armed resumes it, and the report records the restart. The
  controller process survives a board `stop`/`start` and records the gap.
- With no model configured, mechanical rows still run, remediations still apply, and the report says
  which rows were unavailable and why.
- A stalled seat is diagnosed **before** any new dispatch in the same pass.
- The escalation ladder raises a seat by exactly one rung per pass; a seat cannot reach restart from
  a single classification.
- The report is readable with the model unconfigured, and contains no unredacted token, env value or
  absolute path drawn from a log tail.
- Two controllers armed at once: the second is refused the lease, and the board says so.
- A controller that stops reporting shows as **late**, distinctly from healthy and from disarmed.
- A board restart issued by the controller writes its report entry **before** the shutdown call, and
  that entry is present after the board comes back.
- With `/shutdown` unanswered, the controller escalates to `SIGTERM` then `SIGKILL` against the pid
  from `/health`, recording each escalation, and still brings the board back.
- The successor board is spawned detached: assert killing the controller immediately after a restart
  leaves the board running.
- A restart records the observed `terminal.fleet.surviveBoard` value, and with it **off** the entry
  states that the fleet was disposed.
- A board that wedges repeatedly hits the consecutive-restart ceiling and the report says so rather
  than the controller falling quiet.
- An RSS-threshold restart fires with **no judgement backend configured** — the memory-leak case needs
  no model.
- Every applied remediation in the report names its rule, its rung, its evidence and the command run.
- **A card the controller is walking up the ladder, taken to `dispatchTimeoutMs` by
  `_runDispatchTimeoutSweep`, produces a report entry that named the impending abandonment before it
  happened** — and the pass after the abandonment re-diagnoses the card as unowned rather than
  continuing the old ladder.
- A remediation that changes seat ownership states in the report whether it re-stamped `owner_since`,
  and the recorded value matches the row afterwards.
- A card whose `last_action` reads `timed out` is not diagnosed as a fresh row-1 case.
- A seat nudged by a board sweep in the same minute is **not** also nudged by the controller: row 2
  requires silence since the last board nudge, not since last output.
- Capability probes re-run at the top of **every** wake: with a seat fleet that gains a second
  provider between wake N and wake N+1, row 5 reports unavailable on N and available on N+1, and the
  N+1 entry names the change.
- With seats running on another machine via an `ssh` transport prefix, the controller still reads
  their evidence through `GET /terminals/<name>/log` against the board's own
  `.switchboard/logs/` — assert no code path fetches a log from the seat's host.
- A row whose precondition is unmet reports as unavailable **with its reason**, never silently
  skipped: assert rows 3, 5, 6, 7 and 8 each name `no judgement backend configured` on a modelless
  board.
- No code added by this subtask reads, writes or migrates `routed_to`, `dispatched_agent`,
  `dispatched_ide`, `dispatched_terminal`, `queue_position`, `released_at`, `outcome` or `workflow`.
- `POST /shutdown` still refuses a tailnet peer after this change.
- The supervisor probe returns **three** distinguishable outcomes — present, absent, and
  `platform-undetectable` — and `$INVOCATION_ID` alone yields `platform-undetectable`, never
  `present`.

### Goal Invariants

1. A `controller` command is reachable from `src/standalone/cli.ts`'s command dispatch, and its usage
   line appears in `usage()`.
2. The controller's board access goes through the CLI's own `apiRequest` path in `cli.ts`; grep the
   controller module for `http.request(`, `https.request(` and a bare `fetch(` and assert **zero**
   hits — a second client is the named non-goal.
3. `setInterval` count in `src/standalone/bootstrap.ts` is unchanged from before this subtask
   (currently **1**, at `:4724`): the controller adds no timer inside the board process.
4. The matrix is data: the rule set is loaded from a store at runtime, and the controller module
   contains no `switch`/`if` chain keyed on a rule id. Adding a ninth row requires no edit to the
   controller module.
5. Every row in the shipped matrix declares `{ enabled, reason, source }`; assert no row's capability
   projection is a bare boolean.
6. `capabilities` for the controller are computed from the four probes named in change 6, and each
   probe's result appears in the report.
7. No unredacted token, absolute path or env value drawn from a log tail appears in a report entry —
   **paired with:** the entry still carries an evidence window sufficient to identify the rule's
   trigger.

**Goal-vs-appearance:** a controller that wakes, writes a report, and takes no correct action
satisfies invariants 1-6 while achieving nothing the Goal asks for. So:

8. Against a fixture set of seat states — one finished-but-unreported, one clean-but-silent, one with
   a non-zero exit in its tail — the mechanical rows produce the **correct row** for each and apply
   the correct remediation. Diagnosis accuracy, not loop liveness, is the measure.

---

**Recommendation: Send to Lead Coder.** Complexity 7 — a new long-running client, new board state with
a concurrency contract, and composition with five existing sweeps that mutate the same rows.

---

## Implementation summary (2026-09-17)

The spine shipped modelless and standalone-only. A new `switchboard controller` CLI mode runs a
long-lived client that claims a board lease, re-probes four capabilities at the top of every wake,
loads the eight-row matrix as data, evaluates the mechanical rows (1 finished-never-reported, 2
idle-no-blocker, 4 crashed/dead-process) through generic condition kinds, and applies one
escalation-ladder rung per subject per pass (`nudge` -> `clear-respawn` -> `escalate-human`
reachable; the judgement rungs and `restart-board` are declared unavailable with their reason).

Board state lives in the board's own `config` table behind six standalone-only `/controller/*`
routes (`lease` GET/POST/DELETE, `state` GET/PUT, `nudges` GET, `report` POST), backed by a new
`ControllerBoardStore`; the extension host wires none of it, which is the intended state under the
cutover rule. The board's own nudge ledger is fed at the single turn-end delivery seam in
`bootstrap.ts`, so the controller's row 2 requires silence since the last board nudge rather than
since last output. The report is a Markdown file appended per wake under
`.switchboard/teams/controller/reports/controller-report.md` with size-based rotation, composed
entirely from facts the controller holds, with every log slice redacted before it is written.

The restart mechanism (change 5b) is implemented behind an explicit `--board-start-command`
(refused otherwise), rate-limited by interval and consecutive ceiling, and writes its report entry
before `POST /shutdown`. No model call, no second HTTP client, and no new `setInterval` inside the
board process; `protocol-catalog.json` was regenerated for the six new routes. Untested in this run
by directive — the plan's verification checks remain the gate.


## Review Findings

Reviewed the spine against the shipped code; changed `src/standalone/controller/controller.ts` and
`src/standalone/controller/matrix.ts`, and regenerated `protocol-catalog.json`. Two defects were
fixed: the restart rate limit both failed to report a suppressed restart and cleared
`consecutiveRestarts` on every suppressed pass, so the declared ceiling was unreachable and a wedging
board would have been recycled every `restartMinIntervalMs` for ever (`decideRestart` now returns a
third `suppressed` outcome, the counter clears only when nothing was wrong, and the suppression is
written to the report); and `loadMatrix` validated only the shape of an override, so a row naming an
unknown `condition.kind`, `remediation` or `requires` capability loaded cleanly and then matched no
evaluator arm — silently inert, which is the 3am failure the plan forbids. Verification:
`compile-tests` clean, `catalog:check` now passes (it failed at HEAD — the checked-in catalog carried
`apiEndpointCount: 167` against its own 175-entry array plus stale line numbers), `standalone-parity:check`,
`standalone-fork:check`, `verb-returns:check`, `dispatch-surface:check`, `parity:check`,
`push-routing:check`, `kanban-dispatch-callers:check`, `icons:parity` and `banner:check` all pass, and
the three touched contract suites pass. Inbound field checks confirmed against the writers:
`plans.ownerSeat/ownerSince/completedAt/lastAction/kanbanColumn/planId`, `getTurnEndReports`'
`planId/timestamp/action`, `ptyListTerminals`' `friendlyName/status/lastDataAt/hidden/role/cliFamily/planId`,
and `/health`'s `pid`, `memory.rss` and `ptyHost.surviveBoard`. **The core mechanism has no automated
check** — every verification item in this plan is manual and none was executed against a live board,
so passing the unrelated suites above is not evidence that the wake loop diagnoses or remediates
correctly; the verdict on the loop itself is provisional.

## Deferred Findings

- MAJOR — No automated check discriminates on the wake loop, the ladder, the lease or redaction; the plan's entire `### Automated` list is manual and nothing in `.github/workflows/integration-tests.yml` exercises `src/standalone/controller/`. `src/standalone/controller/controller.ts:210`
- MAJOR — `claimLease` is a read-then-write with no compare-and-swap, so two controllers claiming in the same tick can both be granted; the arm path's pre-checks and the TTL cover the realistic case but not a true race. `src/services/ControllerBoardStore.ts:226`
- NIT — A corrupt matrix override aborts the pass before any report is written, so the reason reaches the controller's stdout and `GET /controller/matrix` but never the report file the operator reads. `src/standalone/controller/controller.ts:262`
- NIT — `hasUsableEvidence` gates rows 2 and the judgement path, so a tail that redaction blanks produces no diagnosis and no record of why. `src/standalone/controller/redact.ts:74`
- NIT — `boardNudgeLedger` is in-memory, so after a board restart row 2's "silence since the last board nudge" reads as "never nudged" and the controller may nudge immediately. `src/standalone/bootstrap.ts:4334`
- NIT — The panel-armed controller is spawned without `--board-start-command`, so the restart mechanism (change 5b) is unreachable from the panel by construction. `src/standalone/bootstrap.ts:5637`
