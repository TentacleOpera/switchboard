# The Agent Panel Becomes a Standing Controller, Not a Button Row

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


### What this subtask is, after the split

This plan is now one subtask of the feature of the same name. It owns **the surface**: the dock Agent
tab and the mobile command surface stop being a row of endpoint buttons and become the console that
arms, configures and reads a controller — including the supervisor chat.

The controller itself is elsewhere in the feature: its clock, lease, report, matrix store, ladder and
capability declaration are *The Controller Wakes on a Clock, Diagnoses, and Reports*; its judgement
tiers, supervisor seat and reroute verb are *Judgement Tiers, the Supervisor Seat, and Reroute*; the
card renderer this panel's chat consumes is *Structured Cards Render in One Module on Three
Surfaces*.

**Everything the panel shows about the controller is second-hand.** The controller is a separate
process, so the board renders what the controller last told it and says when that was — it never
infers controller state. This holds even though the two are co-located: a separate process can crash,
hang or be stopped without the board knowing.

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


This subtask owns the **first two rows** of that table — `dock.js` / `dock.html` and `command.js` /
`command.html`. It must not edit `src/webview/agent-control.*`, and it consumes rather than defines
the card renderer in `terminals.js`.

## Metadata

- **Complexity:** 6
- **Tags:** ui, frontend, mobile, api, feature

## Host Scope

**Standalone only.** `src/extension.ts` is the legacy host and is being removed; wiring this there
is throwaway work, and "the extension does not have it" is the intended state, not a divergence.
No `extension.ts` composition-root seam is touched, and none should be added.


## Dependencies

**Hard: *The Controller Wakes on a Clock, Diagnoses, and Reports*.** There is nothing to arm, no
arming state to render, no report to display and no capability set to grey out until that subtask
ships. A panel built first would render four empty states.

**Hard for the chat pane: *Structured Cards Render in One Module on Three Surfaces*.** The supervisor
chat replies in structured cards, and this subtask consumes that renderer rather than growing a third
copy of it.

**Soft: *Judgement Tiers, the Supervisor Seat, and Reroute*.** The tier list and escalation criteria
are editable here whether or not a tier is implemented; a panel that can configure tiers on a board
with none simply shows them unavailable with a reason, which is the required behaviour anyway.

**Naming: the CLI is being renamed.** *One Name End to End: Switchboard Becomes LABCOM, and the CLI
Becomes `lc`* is in PLAN REVIEWED alongside this feature, and the site is already `labcom.dev`. Every
`switchboard …` command written here is the current spelling; whichever plan lands second adopts the
other's name. Nothing in this subtask should be implemented as a second, competing rename.

## User Review Required

Settled by the operator: the controller lives behind the dock and mobile command panels; when it
spots something wrong it fixes it; the report is a Markdown file the controller appends to; keeping
stuck agents moving is the highest-priority check.

> **Superseded:** the same list with "**both on-board and off-board placement must exist**" appended
> as an operator decision.
> **Reason:** it was not one. The committed plan at `HEAD` reads *"None on shape — the operator
> specified it: the controller lives in the dock and mobile command panels; when it spots something
> wrong it fixes it; the report is a Markdown file the agent appends to; keeping stuck agents moving
> is the highest-priority check"* — **no placement requirement, and no mention of off-board, another
> machine or the tailnet anywhere in the file**. The clause appeared in a later uncommitted edit,
> attributed to the operator, and was then cited downstream as settled scope. The operator confirms
> they did not ask for it. A false attribution is worse than a wrong requirement: it is a requirement
> nobody will question.
> **Replaced with:** the operator's actual decisions, above. **The controller always runs on the board
> host.** Its separateness from the board is a process boundary, not a machine boundary — it exists
> so that the controller can restart a wedged or leaking board, which a component inside that board
> cannot do.

All previously open `[decision]` markers are now decided and recorded inline in the subtask that owns
them. Nothing in this subtask is blocked on a human answer.

## Complexity Audit

### Routine

- Rendering arm/disarm, run-now, report, last-woke and target controls in the two panel copies — the
  panes already fetch `/agent/control/config` and render a dynamic button list from it
  (`dock.js:301`, `command.js:2696`).
- Keeping the six mechanical POSTs reachable as the model-down fallback.
- Storing credentials write-only via the `encryptedSecretsStore` seam (`bootstrap.ts:5371-5374`), a
  pattern the existing surface already honours.

### Complex / Risky

- **Two hand-maintained copies of the same pane.** `dock.js:140-560` and `command.js:2625-2900` query
  the same element ids independently and each has its own render and fetch path. Every control added
  here is added twice, and nothing gates the second one.
- **Config corruption vs. absence.** Both candidate config stores swallow a parse error by design, and
  this panel is where the difference becomes visible to a human.
- **Edit validation at save time**, refusing a row that names a tier or verb that does not exist —
  which means the panel needs the controller's vocabulary, not just its values.

## Edge-Case & Dependency Audit

### Race Conditions

- **Concurrent matrix writes from dock and mobile.** `updateConfigJson` (`KanbanDatabase.ts:6943`)
  serialises per key; a hand-rolled read-modify-write does not.
- **Config edited mid-wake.** The controller reads config once per wake. An operator saving a
  matrix change from the phone mid-pass must not produce a half-old, half-new pass — the controller
  snapshots at the top of a wake, so the panel must show *which* version is in force, not just the
  saved one.
- **A late or dead controller.** The panel renders second-hand state; "armed, controller late" must be
  visibly distinct from "armed, healthy" and from "no controller configured". A co-located controller
  can still crash or hang, so this is not a remote-only concern.

### Security

- **Credentials.** The panel field is write-only and never rendered back; the config records that a
  credential is *set*, and its source, never its value. The existing surface already returns `keySet`
  rather than the key (`_handleAgentControlConfig`) and this must not regress.
- **The report is rendered in a webview.** Report content derives from redacted log slices; the panel
  must not re-fetch raw log tails to "enrich" a report entry.

### Side Effects

- Arming from the panel changes board behaviour for every operator of that board.
- Removing the card dropdown removes a control some muscle memory depends on; the mechanical POSTs
  stay reachable so the surface never goes blank.

### Dependencies & Conflicts

- **Supersedes in spirit, not in file:** `the-dock-agent-tab-is-a-control-surface-not-a-terminal.md`
  and `the-agent-control-surface-cannot-be-configured-and-is-driven-by-typing.md` (both **CODE
  REVIEWED**). Their surface is what this rebuilds; their non-goals — no terminal, no intent-parsing
  text box — are carried forward intact.
- **Reads, does not fork:** `GlobalIntegrationConfigService`'s `agentControlProviders` rows.

## Adversarial Synthesis

Key risks: the dock and mobile copies drift, because every control here is written twice and no gate
catches the second; a corrupt controller config renders as "no controller configured", which is the
one distinction this panel exists to make; and the supervisor chat re-becomes the intent-parsing text
box that was correctly removed. Mitigations: the two copies are diffed by hand for the seams each
wires, the config read is raw-and-validated with three tagged outcomes, and the chat is structured
cards with tap-to-answer, never a phrase the backend keyword-matches into a verb.

## Proposed Changes

### 2. The panel's button row becomes goals, not endpoints

The card dropdown goes. A button names an outcome the controller pursues; it does not name an
endpoint.

The mechanical POSTs stay reachable — they are the fallback when the model is unusable, and the
existing rule holds: *a control surface that goes blank is worse than a terminal*. But they stop
being the primary vocabulary.

The panel gains: **arm / disarm**, **run a pass now**, **the report**, **when it last woke**,
**where the controller is running**, and **the controller's whole configuration** (change 11). Both
surfaces render it — `dock.js` and `command.js` each carry their own copy of this pane and must not
drift, and the card renderer they share is the one change 12 also gives to the seat status pane.

**The panel gains a chat with the supervisor, and this is not the old text box.** The box that was
removed was an *intent parser*: the operator typed a phrase, the backend keyword-matched it into a
verb, and that lossiness was the whole problem. A chat with the supervisor seat (change 8) is a
conversation with something that can act and ask back — a different mechanism with a different
failure mode.

What keeps it usable on a phone is asymmetry: **the supervisor replies in structured cards and the
operator answers by tapping.** The payload carries its own reply options, so typing is available
where it is natural — the dock — and is rarely required anywhere. The card types are a closed set,
validated on arrival; a payload that fails validation renders as plain text rather than vanishing.

Because the controller may be elsewhere, everything the panel shows about it is second-hand: the
board renders what the controller last told it, and says when that was (change 6).


### 11. The controller is configured from the Agent panel, and the config lives on the board

Arming is not the only thing the panel owns. The tier list (endpoints, credentials, the supervisor's
seat name), the matrix rows (order, enabled, thresholds, and which tier each row may reach), the
escalation criteria of change 7, and the wake interval are all edited there. An operator should
never have to hand-edit a file to configure a controller, and on a phone they cannot.

**The config lives on the board, never with the controller.** One store, one authority. A remote
controller reads it over the API each wake, so an edit made on the phone reaches a Mac controller
without touching the Mac. A controller-local config file would be a second store that can disagree
with the first — the four-level startup-command lookup that CLAUDE.md names as precedent, where a
stale value from a retired store wins and nothing records which store answered.

**"On the board" means the board's SQLite `config` table, not `integration-config.json`.** There are
two candidate stores on the board host and they are not equivalent:

| store | what it is | verdict |
| --- | --- | --- |
| `GlobalIntegrationConfigService` (`stateFile('integration-config.json')`) | a **machine-global** JSON file shared across every workspace and IDE on that host | wrong scope |
| `KanbanDatabase` `config` table (`getConfig`/`setConfig` at `KanbanDatabase.ts:6879`/`:6890`, JSON helpers at `:6933`/`:6939`/`:6943`) | the board's own store, per board | **use this** |

Two reasons, both load-bearing:

1. **Scope.** `integration-config.json` is machine-global. Two boards on one Pi would share one
   controller config, one supervisor seat name and one matrix — and a matrix row naming a seat is
   board state, not machine state. CLAUDE.md's *one store, one host* points at the DB.
2. **The existing model config already lives in the wrong place, and moving it is out of scope.**
   The Agent panel's provider rows (`agentControlProviders`, `AgentGlobalKey` in
   `GlobalIntegrationConfigService.ts:103`, read by `_handleAgentControlConfig`) are machine-global
   today. The tier list of change 7 is a *superset* of that data. Rather than fork it, **the tier
   list reads the existing `agentControlProviders` rows as its endpoint/model/key source** and adds
   only tier ordering and per-tier enablement in the DB `config` table. One endpoint store, one
   credential path, plus board-scoped ordering on top.

**Both candidate stores swallow a corrupt read, and the controller must not.** This is the exact
antipattern CLAUDE.md names by hand:

- `GlobalIntegrationConfigService.loadGlobal` (`:179-191`) is `catch { … return {} }`.
- `KanbanDatabase.getConfigJson` (`:6933-6937`) is `try { JSON.parse } catch { return defaultValue }`.

Either one turns *corrupt controller config* into *no controller configured* — and change 6's whole
premise is that those two are different states the operator must be able to tell apart. So the
controller config is read with `getConfig` (**raw string**) and parsed and validated by the
controller-config module itself, which returns one of three tagged outcomes — `{ kind: 'configured',
value, source }`, `{ kind: 'absent' }`, `{ kind: 'corrupt', reason, raw }` — and **never** calls
`getConfigJson` for this key. A `corrupt` read arms nothing, surfaces in the panel with its reason,
and is written to the report. `updateConfigJson` (`:6943`) remains the correct writer: it serialises
concurrent updates per key, which two panels editing the matrix will do.

**Credentials go to SecretStorage, not into the config row.** `secrets.get/store/delete`
(`bootstrap.ts:5372-5374`) is the existing seam. The panel field is write-only and is never
rendered back; the config records that a credential is *set*, and its source, never its value.

**Edits are validated at save and refused with a reason.** A row naming a tier that does not exist,
or a remediation verb that does not exist, is refused at edit time — not silently ignored at 3am
when the rule fires. A refusal names what was wrong.

**Every config value carries its source.** This is configuration and routing, so the fallback rule
applies in full: "set in the panel", "left at its default" and "never configured" are three
distinguishable states, and the report records which answered.

Per CLAUDE.md, no confirmation dialog gates any edit, including deletions.


## Non-goals

- **Reintroducing the intent-parsing text box.** The removed box keyword-matched typed phrases into
  verbs; goals are buttons and stay buttons. The supervisor chat is not that box: it is a
  conversation with a seat that can act, it replies in structured cards, and the operator answers by
  tapping.
- **Reintroducing a terminal.** The panel renders no emulator.
- **Wiring the VS Code host.** Out of scope by the cutover rule.
- **Editing `src/webview/agent-control.*`.** A different panel with a confusingly similar name.
- **Growing a third copy of the card renderer.** The panel consumes the shared module.
- **Holding controller state on the board's behalf.** The panel renders what the controller last
  reported and says when that was; it does not infer, cache or synthesise controller state.

## Verification Plan

### Automated Tests

- Every controller setting is reachable from the panel on a phone, with no file editing.
- A rule saved against a non-existent tier or verb is refused at save time, with a reason.
- A credential entered in the panel is never rendered back, and the config reports it as set with a
  source but without its value.
- A config edit made in the panel changes the behaviour of a controller running on another machine on
  its next wake, with no change on that machine.
- The controller's config is read from the board DB `config` table, and a deliberately corrupted value
  reports **corrupt with its reason** — distinct from "no controller configured" — and arms nothing.
  Assert specifically that the read does **not** go through `getConfigJson`.
- A reply typed into the supervisor chat reaches the seat, and its structured answer animates into
  both the dock and mobile panes.
- A malformed supervisor payload renders as plain text and is reported, not dropped.
- The four arming states — no controller configured, healthy, late, model unreachable — each render
  distinctly in both panes.
- An unavailable matrix row renders greyed **with its reason**, not hidden.
- The dock and mobile panes are diffed by hand for the seams each wires — not the verbs each answers.
- No file under `src/webview/agent-control.*` is modified by this change.

### Goal Invariants

1. The card-selection `<select>` (`agent-control-card-select`) is **absent** from `dock.html` and
   `command.html` — **paired with:** the arm/disarm, run-now, report, last-woke and target controls
   are **present** in both. (Absent alone passes if someone deletes the pane.)
2. `resolve-card` is **absent** from the `quickActions` array in `_handleAgentControlConfig`
   (`LocalApiServer.ts:10776-10782`) — **paired with:** the six mechanical actions are still present
   and still `needsModel: false`, so the panel does not go blank when the model is down.
3. No `confirm(`, `window.confirm(` or `showWarningMessage` appears on any path added by this subtask
   — **paired with:** the destructive controls (disarm, delete a matrix row, clear a credential) are
   present and act on first press.
4. The panel holds **no** model endpoint call of its own: grep the webview sources added here for a
   `/v1/chat/completions` literal and assert zero hits. Judgement belongs to the controller.
5. Every control added to `dock.js` has a counterpart in `command.js` and vice versa — enumerate the
   element ids each queries and assert the two sets are equal.

**Goal-vs-appearance:** a panel that renders every control and reports nothing real satisfies
invariants 1-5. So:

6. With a controller armed and then killed, the panel transitions to **late** within the declared
   staleness window without any operator action, and the report pane still renders the last entry.
   Second-hand state that never goes stale is not second-hand state.

---

**Recommendation: Send to Coder.** Complexity 6 — two hand-maintained surface copies and a config
read whose failure modes are the point, but no new long-running process and no new board concurrency.

---

## Implementation summary (Coding-coder-1) — BLOCKED

No code was changed. The plan's own hard dependency — *The Controller Wakes on a Clock, Diagnoses,
and Reports* — publishes only six board routes (`/controller/lease` GET/POST/DELETE,
`/controller/state` GET/PUT, `/controller/nudges` GET, `/controller/report` POST), which is not a
surface this panel can drive: there is **no** route to arm or disarm the controller, run a pass now,
read the report back, read or write the controller configuration, or reach the supervisor chat, so
invariant 1 and changes 2/11 have no backend. The config store also diverges between the two plans —
this plan mandates the board DB `config` table, while the shipped spine loads its matrix from
`.switchboard/controller/matrix.json` and takes wake interval / model endpoint from CLI flags,
reading no board config at all, so a panel config editor would write a store nothing consumes (the
exact quiet-wrong-answer the fallback rule forbids). The report pane is blocked too: the controller
writes to team id `controller`, but `GET /teams/<id>/reports` rejects any id not matching
`^team_[A-Za-z0-9_-]+$`, and no report-read route exists. The controller sources
(`src/standalone/controller/*`, `ControllerBoardStore.ts`, `cli.ts`) were being edited minutes before
this run and `ControllerBoardStore` is mid-refactor (LocalApiServer calls `readBoardNudges`/
`writeReport`, which the store does not yet define), so editing the shared backend now would collide
with in-flight work; the running board at :7777 is a `dist` build that does not serve `/controller/*`
at all, so nothing can be verified at runtime. **Next step:** land the controller subtask, then
publish a panel-facing contract (arm/disarm, run-now, report-read, and the board-scoped controller
config the spine actually reads) and re-dispatch this panel against it.

## Implementation summary (2026-09-17, second pass) — coded

Shipped on the second dispatch, after the controller and judgement subtasks landed their board routes.
The dock Agent tab and the mobile command surface now render one **controller console** from a single
shared module, `src/webview/controllerConsole.js`, mounted by both `dock.js` and `command.js` so the
two panes cannot drift; the static controls live in `dock.html` and `command.html` and the styles in
the shared `statusCards.css`. The console shows the four arming states (no controller configured /
healthy / late / armed-but-model-unreachable) from the board's own lease and state, last-woke,
target/holder, the capability rows greyed with their reason, the Markdown report, the supervisor
escalations, and a config editor for the wake interval, the matrix override and the judgement tiers —
all second-hand reads with no model call of the panel's own. The card picker and the model-backed
`resolve-card` action are retired; the six mechanical actions stay served as the model-down fallback
and the target-less three stay on the surface.

The standalone board gained the panel-facing routes this subtask owns: `GET /controller/report`,
`GET|PUT /controller/config`, `GET|PUT /controller/matrix` (validated at save, refused with a reason),
and the process lifecycle `POST /controller/arm`, `/controller/disarm`, `/controller/run`, backed by
new `ControllerBoardStore` reads/writes and a bootstrap lifecycle seam that spawns the controller
detached. `protocol-catalog.json` was regenerated for the new routes. No file under
`src/webview/agent-control.*` was modified, and no confirmation dialog gates any control. Compilation
and the automated suites were skipped this run by directive; the plan's verification checks remain the
gate.

## Fix round (2026-09-17) — change 11 membership validation

Review found change 11 unmet: `validateMatrixRows` checked only shape, so a matrix row naming an
unknown remediation verb (or an unknown `requires` capability) was accepted, and `writeJudgementConfig`
wrote a tier list without checking that each tier's `providerId` resolved to an existing
`agentControlProviders` row — an unknown remediation then fell through the controller's apply switch and
was silently ignored at wake time. `validateMatrixRows` now refuses an unknown remediation against the
closed verb set and an unknown `requires` entry against the known capability keys, and
`writeJudgementConfig` now refuses a tier whose provider is unconfigured, naming the offending tier in
the reason. Both edits are in `src/services/ControllerBoardStore.ts`; nothing else changed.

## Review Findings

Reviewed the console against the plan; changed `src/webview/controllerConsole.js`,
`src/services/ControllerBoardStore.ts` and `src/standalone/controller/controller.ts`. Two defects were
fixed: the 15-second staleness poll rebuilt the config editor on every tick, wiping half-typed matrix
and judgement JSON and the interval field — which on a phone makes change 11's editor unusable, the
exact thing it exists to replace (`renderConfig` now skips a rebuild while a field is focused or
dirty, and a successful save clears the flag); and `renderRows` composed its own hardcoded "reason"
strings for unavailable capabilities, a fallback indistinguishable from a reported value, so the
controller now persists `{enabled, reason, source}` per capability and the console renders what it
reported or says the reason was not reported. Save-time membership was also extended: `validateMatrixRows`
now refuses an unknown `condition.kind` alongside the unknown remediation and capability it already
caught, because a row whose kind matches no evaluator arm is silently inert. Goal invariants verified:
`agent-control-card-select` is absent from both `dock.html` and `command.html` while the arm/disarm/
run-now/report/last-woke/target controls are present in both under identical ids; `resolve-card` is
gone from `quickActions` and all six mechanical actions remain `needsModel: false`; no `confirm(`/
`window.confirm(`/`showWarningMessage` on any added path; no `/v1/chat/completions` literal in any
file this subtask added; `src/webview/agent-control.*` untouched. Verification: `compile-tests` clean,
`catalog:check` (which failed at HEAD) now passes, and `test:contract:shell-agent-dock`,
`test:contract:agent-control-config` and `test:contract:terminals-payload` all pass — but **no
automated check exercises the console itself**, so the four arming states, the report pane and the
supervisor chat remain unverified at runtime and that part of the verdict is provisional.

## Deferred Findings

- MAJOR — No automated check covers the console: the four arming states, the late transition, the report pane and the config editor are all manual-only, and nothing in `.github/workflows/integration-tests.yml` loads `controllerConsole.js`. `src/webview/controllerConsole.js:217`
- NIT — `dock.html` loads `controllerConsole.js` from a literal `/static/webview/` path while its sibling `statusCards.js` uses the `{{STATUS_CARDS_URI}}` placeholder; harmless today because only the standalone route serves `dock.html`, but the two mechanisms sit one line apart. `src/webview/dock.html:583`
- NIT — `configDirty` is module-scoped rather than per-console, so a second `create()` in one document would share it. `src/webview/controllerConsole.js:143`
- NIT — The legacy quick-action pane still uses different element ids in the two copies (`agent-control-quickactions`/`agent-control-status` versus `agent-quick-actions`/`agent-status-chip`); pre-existing, outside the controls this subtask added. `src/webview/command.html:1113`
- NIT — The supervisor reply box posts to `ptySendPrompt` without `machineOrigin`, unlike every controller-issued prompt. `src/webview/controllerConsole.js:294`
