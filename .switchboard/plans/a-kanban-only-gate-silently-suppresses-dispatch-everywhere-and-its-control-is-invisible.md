# A kanban-only gate silently suppresses dispatch everywhere, and the standalone host hides the only control that could turn it off

## Goal

`kanban.cliTriggersEnabled` does what it was built to do and nothing else: let an
operator rearrange cards on the kanban board without waking agents. It must not
decide whether a dispatch from any other surface fires. And whatever state it is
in, the control that changes it must be visible and reachable from the surface
the operator is actually using.

### Problem analysis

**Observed 2026-09-17 on the live board, end to end.** An operator advanced a card
to Planned from the mobile command surface. The card moved. Nothing was
dispatched. Measured against the `planner-1` seat and the store:

| | before | after |
|---|---|---|
| `planner-1` `promptCount` | 1 | **1 — unchanged** |
| card `owner_seat` | — | **`''`, never stamped** |
| `dispatched` event in `plan_events` | — | **none** |
| rows written | — | one `workflow_event` / `stop` |

No delivery was attempted. The board's console, captured live for the window,
contains no delivery error — because the arm never reached the delivery half.

The board's setting:

```
kanban.cliTriggersEnabled = false
```

**1. The gate has escaped the surface it was written for.** Its stated purpose is
to let a user arrange cards on the kanban without triggering them. It is read at
**ten sites** in `KanbanProvider.ts`, and they are not drag-and-drop:

```
:9809   _advanceCards — mayDispatch && (this._cliTriggersEnabled || options.bypassTriggerGate)
:9863   _advanceCards — same
:11300  verb handler  — dispatchAllowed = this._cliTriggersEnabled || !!msg?.bypassTriggerGate
:11588  verb handler  — same
:12315  :12337  :12445  :12466 — column/role dispatch arms
```

`:9809` and `:9863` are the advance path. A setting scoped to one gesture on one
surface is deciding whether a dispatch from a different surface fires at all.

**2. The mobile surface calls the gated endpoint and never the ungated one.**
`command.js` posts `/kanban/advance` (`:1821`, `:2805`, `:2821`) and polls
`/kanban/dispatch/state`. It **never** calls `POST /kanban/dispatch` — the
endpoint whose own docblock calls it *"the ONE-CALL 'advance a card and fire its
agent' endpoint"*, which passes `bypassTriggerGate: true`, and which verifies the
outcome before answering. The comment at `command.js:92` describes a two-phase
`/kanban/dispatch` flow with `ack: true`; `grep -n "ack: true" src/webview/command.js`
returns only that comment. The surface documents a call it does not make.

The same dispatch through `POST /kanban/dispatch` on the same board, same seat,
minutes apart, **delivered** — seat stamped, `dispatched` event written,
`promptCount` incremented. The difference is entirely which endpoint was called.

**3. There is no control or indicator on the surface where it matters.**
`cliTriggersEnabled` appears in exactly **one** webview file: `kanban.html`.
Nothing in `command.html` or `command.js` reads it, shows it, or mentions it. A
mobile operator presses a dispatch control, watches the card move, gets no agent,
and has nothing on screen that could explain why.

**4. And the standalone host removes the only control that could change it.**
`#btn-cli-triggers` (`kanban.html:2456`) is real, and the markup is served — but
`transport.js:712` injects a stylesheet over it:

```js
if (caps.automation === false) {
    document.body.classList.add('host-automation-false');
    style.textContent = `
.host-automation-false #btn-cli-triggers,
.host-automation-false #btn-remote-control,
.host-automation-false button[data-action="julesSelected"],
.host-automation-false #btn-build-via-planner,
.host-automation-false #btn-update-via-planner,
.host-automation-false #btn-build-system,
.host-automation-false #btn-build-prd-via-planner {
    display: none !important;
}`;
}
```

The live board's `<body data-host-capabilities=...>` carries
`"automation": false`, hardcoded at `bootstrap.ts:1403`. So on the standalone
host the toggle is **`display: none !important`** — not dim, not small: absent
from layout. The setting is therefore unreachable and un-turn-off-able from the
only host the appliance runs, while still gating dispatch from every surface.

**This is an un-reversed migration decision, not an accident.** Standalone was
originally not meant to run CLI triggers at all, so the controls were hidden
deliberately at the first standalone migration. The product changed — triggers
now matter on standalone — and the hiding was never undone.

The declaration shows it. Its neighbours carry measured justifications:

```ts
// `boardStructure` stays false for a measured reason, not an assumed one:
// pushFullState publishes `updateColumns` from the CONSTANT
// DEFAULT_KANBAN_COLUMNS (:334, :363) ... `featureAdvanced` likewise ...
// Flip each when its path is.
const baseStandaloneCapabilities: HostCapabilities = {
    terminalDispatch: ptyReady,
    automation: false,          // <- no stated reason, unlike its neighbours
    'mission-control': false,
    ...
```

`automation: false` carries **no reason at all**, in a block where every other
false flag explains itself and names the condition for flipping it.

**The flag is also over-broad.** `automation` sweeps in controls that are not
automation services: `#btn-cli-triggers` is a board gesture setting, and
`#btn-remote-control` is Remote Control. The file's own neighbouring comment warns
about exactly this reuse — *"`mission-control` here is a HOST capability flag that
predates the Mission Control panel ... Do NOT reuse it to gate anything"* — and
records that the Mission Control strip became permanently invisible the last time
it happened.

**Other controls are hidden by the same pass.** `boardStructure: false` removes
`#btn-add-kanban-column`, `#btn-restore-kanban-defaults` and
`#kanban-structure-list`; `featureAdvanced: false` removes `#btn-suggest-features`.
Those two flags do carry stated reasons and are **not** in scope here, but they
should be re-checked against current behaviour rather than assumed still true.

**Contributing, but not the cause.** `.strip-icon-btn.is-off` sets
`border-color: transparent; opacity: 0.5` with a grayscale/brightness filter on a
dark theme, and `#btn-cli-triggers` gets that class exactly when the setting is
off (`kanban.html:3612-3613`). On a host where the button is *not* removed, that
still renders the control least visible in the state an operator most needs to
find it. Four more strip buttons ship `is-off` hardcoded in the static markup —
`btn-feature-ultracode`, `btn-feature-goal`, `btn-feature-drive`,
`btn-collapse-coders`.

**Why this has survived.** Each layer hides the next. The gate is a documented
behaviour ("advance moves cards without dispatching"), so the code looks correct.
The surface calls a gated endpoint, so the gate looks relevant. The control that
would reveal the state is `display: none` on this host, so the operator cannot
see the cause. And nothing writes a record: the card moves, one `stop` event is
appended, and no failure is reported anywhere.

### Corrections from the improve pass (2026-09-17)

The observations above stand — they were measured live. Three of the causal
conclusions drawn from them did not survive reading the code, and are corrected
here with the audit trail:

> **Superseded:** "A setting scoped to one gesture on one surface is deciding
> whether a dispatch from a different surface fires at all" — i.e., the gate
> suppressed the observed mobile dispatch.
> **Reason:** The observed call never reached the gate. `POST /kanban/advance`
> (`LocalApiServer.ts:3178`) calls `kanbanVerb('promptSelected', …)`, and
> `promptSelected` (`KanbanProvider.ts:12552`) invokes
> `_advanceCards(…, dispatch: false)` on every built-in path (`:12634`, `:12660`)
> — move-only *by construction*, gate never evaluated. With
> `cliTriggersEnabled = true` the identical call still dispatches nothing; the
> toggle's `false` was incidental to the incident. (`promptSelected` DOES dispatch
> for `custom-user` destinations — `dragDropMode: 'prompt'`, `:12593` — a
> clipboard dispatch that is ungated.) The endpoint's docblock (`:3173`) claims
> it "honours the CLI-triggers gate" — true only vacuously, and it implies a
> dispatch capability the route does not have.
> **Replaced with:** The observed failure is a dispatch-labelled control wired to
> a move-only endpoint. The gate is real and worth correcting (below), but it is
> not what silenced this call — the fix is required *regardless of the toggle's
> state*, which the original framing obscured.

> **Superseded:** The ten `_cliTriggersEnabled` read sites "are not drag-and-drop"
> and should mostly stop reading the setting.
> **Reason:** The classification was wrong — the eight dispatch-adjacent reads
> ARE the kanban-gesture set. A card drop posts `triggerAction` /
> `triggerBatchAction` (`kanban.html:7167-7169`, `:6804-6806`) — the verb
> handlers at `:11300`/`:11588` are the drag-drop entry points, not a foreign
> surface. `:12315`/`:12445` sit inside `moveSelected`/`moveAll`, board buttons
> whose shipped tooltip reads "Move selected plans to next stage (triggers CLI
> if enabled)" (`kanban.html:4376`, `:5158`) — the gate applying there is
> documented behaviour. `:12337`/`:12466` are the same arms' planner branch.
> `_advanceCards` (`:9809`, `:9863`) is shared by all of them. Removing these
> reads either breaks suppression (gestures fire with the toggle off) or breaks
> dispatch (a bare `!!bypassTriggerGate` is false for every gesture, so a drag
> with triggers ON never fires). Every site already discriminates via
> `bypassTriggerGate`, which `POST /kanban/dispatch` sets server-side.
> **Replaced with:** The gate stays at every kanban-move-gesture site. Its real
> over-reach is narrower and elsewhere — see the next callout.

The over-gated surface the triage missed: `_handleKanbanVerb`
(`LocalApiServer.ts:8224`, mirrored at `:8252`/`:8280`/`:8388`) runs
`delete body.bypassTriggerGate` on every inbound verb-route call, so an explicit
`POST /kanban/verb/triggerAction` from an authenticated external caller can never
dispatch while the toggle is off — and the strip protects nothing, because the
same caller can simply `POST /kanban/dispatch`. That is the one place a
non-kanban surface is genuinely gated today. (The standalone kanban webview
itself speaks over `/kanban/verb` — `transport.js:26` — so the route is
"board-equivalent" by design; keeping the strip is defensible, but then the
gate's contract must be *documented* as covering it rather than discovered.)

An eleventh read the triage missed: `bootstrap.ts:3336`, inside the standalone
`triggerAction` arm (`handlePtyVerb`, `:3257`). It is both the standalone
drag-drop gate (webview → `/kanban/verb/triggerAction` → `handlePtyVerb`) and
the `/kanban/dispatch` bypass point on this host — it already honours
`payload.bypassTriggerGate` at `:3337`. Any site enumeration must include it.

> **Superseded:** "`grep -c` for `startRemoteControl`/`stopRemoteControl` in
> `bootstrap.ts` returns 0 — so on current evidence that button has nothing to
> call on this host."
> **Reason:** This is the verb-reachability fallacy the repo's own rules warn
> about — `bootstrap.ts`'s `default:` arm delegates every `KANBAN_VERBS` entry
> to `kanbanProvider.handleServiceVerb`, and both verbs are allowlisted with
> real arms (`KanbanProvider.ts:11221`, `:11225`) driving the provider-internal
> `_getRemoteControl()` → `RemoteControlService`. A grep of the composition root
> cannot see it.
> **Replaced with:** The audit question for `#btn-remote-control` is not "is the
> verb reachable" (it is, via the `default:` arm) but "does `RemoteControlService`
> work on this host" — trace what `_getRemoteControl` constructs and what it
> needs, in code, before deciding to unhide.

Two further facts found while reading:

- `caps.automation` also gates the **`mission` view on the command surface**
  (`command.js:165`, `{ name: 'mission', cap: 'automation' }`) — a second
  surface affected by the same flag the plan scopes to `transport.js`.
- `command.js` already contains the entire client half of the two-phase flow —
  `pollDispatchDelivery(planId, since, deadline)` at `:1741` polls
  `/kanban/dispatch/state` and settles the status chip. Only the `ack: true`
  POST is missing; "implement or delete the comment" resolves to *wire the
  existing poll to the real endpoint*. Note `/kanban/dispatch` takes ONE plan
  ref per call — the multi-select dispatch control (`:1819`) and
  `dispatch-starred` (`:2781`) send arrays, so the re-point needs a per-card
  loop with per-card outcomes, not one call.
- The actual `/kanban/advance` posts in `command.js` are at `:1821`
  (`executeDispatch`) and `:2781` (`dispatch-starred` via `agentFetchMobile`) —
  the `:2805`/`:2821` line numbers in the analysis drifted.
- `kanban.cliTriggersEnabled` is resolved through `_getScopedSetting`
  (`KanbanProvider.ts:891`), a **four-tier silent fallback** (project config →
  workspace db → globalState → legacy db) returning a bare value — the exact
  "which store answered?" anti-pattern the repo's fallback rule cites. The
  rename's tagged-source requirement therefore needs a new resolver wrapper,
  not a rename of the existing call.
- `RemoteProviderCapabilities.automation` (`StoreRemoteProvider.ts:90`,
  `false`) is a different field that happens to share the word — confirmed;
  do not conflate when re-deriving the host flag.

### Corrections from the second improve pass (2026-09-17)

The first pass's conclusions stand — every load-bearing claim was re-read
against the code. This pass found one missed surface and several
underspecifications:

- **The same mislabelled control exists on the desktop dock.**
  `dock.js:349-358` runs the identical `dispatch-starred` action against
  `/kanban/advance` — a dispatch-named quick action on a second surface the
  enumeration missed. The dock has no `pollDispatchDelivery`; its report
  path is `renderControlEntry` + `agent-control-status`. Scope extended in
  Proposed Changes.
- **The button literally says ADVANCE.** `command.html:1030` labels the
  Dispatch view's primary action `ADVANCE`. Re-pointing it at
  `/kanban/dispatch` without re-labelling swaps the mislabel's direction —
  a control that says "advance" and fires agents. Re-point and re-label
  land together.
- **`pollDispatchDelivery` is single-slot.** It opens with
  `cancelDispatchPoll()` (`command.js:1742`) — a per-card ack loop as
  written would cancel every poll but the last, so N dispatched cards
  report delivery for exactly one. The poll state must become a
  `Map<planId, poll>` before the loop, or the loop reports acks only.
- **Two plumbing reads the enumeration missed:** the constructor seed
  (`KanbanProvider.ts:605`) and `_reloadSettingsFromStore` (`:1016`) read
  the key by literal string — the rename touches them too. Client-side,
  `kanban.html` holds a message-fed `cliTriggersEnabled` variable
  (`:2989`, `:7076`, `:7164`, `:7811`, `:8404-8406`) — the key rename does
  not reach message field names, but the enumeration should say so.
- **Tests assert the old key and field name.**
  `cross-client-scope-contract.test.js:129` asserts the literal
  `kanban.cliTriggersEnabled` in a `_getScopedSetting` call list;
  `standalone-kanban-fork-detector.test.js:119` greps for the literal in
  `bootstrap.ts`; `KanbanProvider.test.ts` sets `_cliTriggersEnabled` ~20
  times; `external-headed-team-contract.test.js`,
  `team-scoped-role-routing.test.js` and
  `verb-engine-kanban-headless.test.js` carry the name in fixtures. The
  rename diff must update them — they are the gate that would otherwise go
  red for reasons that look unrelated.
- **Four of the eleven reads never see `bypassTriggerGate`.**
  `moveSelected`/`moveAll`'s custom-user (`:12315`, `:12445`) and planner
  (`:12337`, `:12466`) branches read the toggle directly; the flag is
  threaded to `_advanceCards` (`:12290`, `:12354`, `:12420`, `:12484`) for
  built-in targets only. After the strip is removed, a verb-route
  `moveSelected` with `bypassTriggerGate: true` still gates on those two
  branch types — decided: leave gated (they are board gestures), but the
  asymmetry is written down here, not left to be discovered.
- **`getSetting` cannot read `kanban.*` keys.** The arm prefixes every
  non-`switchboard.` key with `switchboard.prompts.` (`KanbanProvider.ts:14213`),
  so the command-surface indicator cannot use it as-is — the read path
  needs one new branch (see the indicator change below).
- **`moveAll`'s tooltip does not document the gate** (`kanban.html:4379` —
  "Move all plans in this column to next stage"). Only `moveSelected`'s
  does (`:4376`, `:5158`). The gate on `moveAll` is real but undocumented
  on the button itself; the rename is the moment to fix that.
- **All four statically-`is-off` buttons are live-initialised** — including
  `btn-collapse-coders` (`:3686-3689`), whose polarity is INVERTED: it
  applies `is-off` when `collapseCodersEnabled` is `true`. A global
  `is-off` restyle therefore changes that button's ON-state appearance, not
  only off-states.
- **The strip removal covers three route prefixes.** `/kanban/verb/*`,
  `/mission-control/verb/*` and `/agent-control/verb/*` all dispatch into
  `_handleKanbanVerb` (`LocalApiServer.ts:14278`, `:14282`, `:14293`) — one
  `delete` line gates all three. The same authenticated-caller argument
  covers all three, but the diff must say so.
- **`verbSchemas` is not a second strip.** `triggerAction`'s schema already
  declares `bypassTriggerGate` optional (`verbSchemas.ts:266`), and
  `validateVerbPayload` validates declared fields only — undeclared fields
  pass through (`:62-75`), so `triggerBatchAction`/`moveSelected`/`moveAll`
  receive the flag undeclared. The one-line removal really is one line.

## Metadata

- **Tags:** backend, ui, api, bugfix, reliability, mobile
- **Complexity:** 7
- **Project:** Orchestration

## User Review Required

**None.** The scope question is already answered by the setting's purpose, stated
by its owner: it exists to let a user arrange cards on the kanban without
triggering them, and it applies to nothing else.

## Complexity Audit

### Routine

- Pointing the mobile dispatch control at `POST /kanban/dispatch` — the endpoint
  exists, bypasses the gate by design, verifies its outcome, and the ack/poll
  client half (`pollDispatchDelivery`, `command.js:1741`) is already written.
  The remaining work is the `ack: true` POST and a per-card loop — after the
  poll goes multi-slot (see Complex/Risky).
- The dock twin (`dock.js:349-358`): same re-point, no poll to port — the
  blocking `/kanban/dispatch` response already carries the verified outcome.
- The `ADVANCE` → `DISPATCH` re-label (`command.html:1030`) — one attribute.
- Correcting the `/kanban/advance` docblock to state what the route does
  (move-only), one comment.
- Removing `delete body.bypassTriggerGate` from the kanbanVerb route — one line.
- Removing `#btn-cli-triggers` from the `host-automation-false` selector list —
  `toggleCliTriggers` needs no automation service and works on standalone today
  via the `default:` verb arm.
- The off-state legibility fix on `.strip-icon-btn.is-off`. CSS, one rule.

### Complex / Risky

- **The settings rename + migration across a four-tier store.** The value can
  live in project config, workspace db config, globalState, or the legacy db
  read — a migration that only checks one tier silently invents a default for
  boards that set it in another. The resolver must report which tier and which
  key answered, and the toggle must read/write/round-trip in all five
  key-presence states. The rename also touches six test files that assert the
  literal key or poke the field (enumerated in the second-pass corrections).
- **The dispatch poll goes multi-slot.** `pollDispatchDelivery` is
  single-slot by design — `activeDispatchPoll`, cancelled on view switch,
  card change, new dispatch. The per-card loop needs `Map<planId, poll>`
  with per-card settle reporting, or multi-dispatch reports delivery for
  the last card only.
- **The gate stays — that is the risk now.** The original plan's hazard was
  deleting the check and making drag-drop fire; the corrected hazard is
  classifying wrong the OTHER way — leaving a read somewhere that is not a
  kanban gesture. The enumeration (ten provider sites + `bootstrap.ts:3336`)
  must be written into the diff, site by site, with the caller identified.
- **Removing the verb-route strip widens an explicit-dispatch surface.** Safe
  because `/kanban/dispatch` already grants the identical power to the same
  authenticated caller — but it must be stated, not silently equivalent.
- **`is-off` legibility without losing the off signal.** The fix is a distinct
  visual state, not deletion; and four buttons ship `is-off` statically, each
  needing its real initial state established before the styling changes.
- **Per-control capability audit on `transport.js`.** Whether to unhide
  `#btn-remote-control`, the Jules action, and the four planner build buttons
  turns on what each one's backing path does on this host — determined by
  tracing `handleServiceVerb` and the services behind it, never by grepping
  the composition root for the verb name.

## Edge-Case & Dependency Audit

### Race Conditions

None introduced. The gate is read synchronously from a cached setting; the acked
dispatch flow already exists server-side (`performKanbanDispatchAcked`,
`LocalApiServer.ts:3526`) and its in-flight map is deadline-pruned.

### Security

`/kanban/dispatch` is already auth-gated and CSRF-guarded identically to
`/kanban/advance`. Removing the `bypassTriggerGate` strip from the kanbanVerb
route grants a capability the same authenticated caller already holds via
`/kanban/dispatch` — equivalent exposure, no new privilege. The strips on the
planning/tickets/taskViewer verb routes stay: `bypassTriggerGate` is meaningless
to those providers' verbs, and the strip is harmless hygiene there. (If
`taskViewerVerb` ever forwards to a gate-reading arm, re-examine.)

### Side Effects

- Mobile dispatch begins actually dispatching — the intent, and a behaviour
  change for anyone relying on the command surface as a card-mover.
- `/kanban/advance` is affirmed move-only; its docblock stops claiming gate
  semantics. Callers wanting dispatch use `/kanban/dispatch`.
- `POST /kanban/verb/triggerAction` with `bypassTriggerGate: true` begins
  dispatching with the toggle off. Without the flag it stays gated — the route
  keeps board-equivalent semantics.
- If `caps.automation` is re-derived rather than merely narrowed, the `mission`
  view on the command surface (`command.js:165`) unhides too — its backing
  (`/kanban/queue/next`, `runQueue`) must be verified on standalone first.
  Narrowing the selector list does not touch this.

### Dependencies & Conflicts

- **`.switchboard/plans/a-dispatch-erases-its-own-evidence-46ms-after-writing-it.md`**
  (New) covers the *other* dispatch defect: on `/kanban/dispatch`, delivery
  succeeds and the evidence is erased 46 ms later by a column-move write, so the
  verifier reports failure. Different path, different failure, no overlap — that
  one is about a dispatch that happened being reported as failed; this one is
  about a dispatch that never happened at all. **They interact:** pointing the
  mobile surface at `/kanban/dispatch` (Change 1 here) sends it onto the path
  that plan fixes, so landing this one first would trade a silent non-dispatch
  for a successful dispatch reported as failed. Land that plan first, or land
  both together. The `ack: true` path shares `performKanbanDispatchAcked`'s
  pre-delivery resolution, so the interaction applies to it identically.
- **`.switchboard/plans/memo-the-command-surface-can-fire-twice-and-claims-delivery-it-cannot-know.md`**
  (Planned) also edits `command.js` dispatch wiring. Do not run concurrently.
- No verb surface change — `toggleCliTriggers` already exists and is allowlisted.
- Standalone host is the target; the extension is out of scope per the cutover.
  (`KanbanProvider.ts`, `LocalApiServer.ts`, `command.js`, `transport.js`,
  `kanban.html` are shared — edits there ride both hosts while the extension
  lives; `bootstrap.ts` is standalone-only. No new code is written in
  `extension.ts`.)

## Dependencies

No `sess_` session dependencies. File dependencies are the two sibling plans
named above.

## Adversarial Synthesis

**Key risks:** (1) the corrected per-site classification is applied carelessly
and a read survives somewhere non-kanban — or a gesture read is deleted and the
documented "triggers off = quiet board" behaviour breaks; (2) the mobile surface
is re-pointed at `/kanban/dispatch` before the evidence-erasure defect lands,
converting a silent non-dispatch into a dispatch reported as failed; (3) the
four-tier settings store makes the migration seed a phantom default for boards
that configured the legacy key in a tier nobody checked; (4) `is-off` restyling
erases the off signal, recreating this bug's invisible-state class pointed the
other way. **Mitigations:** write the eleven-site enumeration with callers into
the diff; sequence behind the sibling plan; migrate through `_getScopedSetting`'s
tier order with the answered tier+key logged; keep `is-off` visually distinct,
not absent.

## Proposed Changes

### `src/webview/command.js` — a dispatch control should dispatch

**Context.** `executeDispatch` (`:1808`) and `dispatch-starred`
(`:2775`–`:2784`) are labelled as dispatch and post `/kanban/advance` — a
move-only route (`promptSelected` passes `dispatch: false` on every built-in
path). The two-phase client half already exists: `pollDispatchDelivery`
(`:1741`) polls `/kanban/dispatch/state`; only the `ack: true` POST described
at `:91-98` was never written.

**Logic.** The dispatch control posts `POST /kanban/dispatch` with
`{ plan: <id>, ack: true, workspaceRoot }` per selected card — the endpoint is
single-ref, so multi-select is a per-card loop, not one call. On each 200 ack
(`{ planId, dispatchedAtBefore, deadline, seat }`, `LocalApiServer.ts:3581-3597`),
call `pollDispatchDelivery(planId, dispatchedAtBefore, deadline)`; non-200 legs are
pre-flight refusals (400/409) reported per card, never aggregated into a bare
success. `dispatch-starred` does the same per starred card. After the re-point,
no dispatch-labelled control on the surface posts `/kanban/advance` — the
comment at `:91-98` finally describes real code; keep it, corrected if wording
drifts.

Two preconditions the re-point depends on:

- **The poll goes multi-slot first.** `pollDispatchDelivery` opens with
  `cancelDispatchPoll()` (`:1742`) and `activeDispatchPoll` holds one entry —
  a per-card loop as written reports delivery for the last card only. Convert
  the poll registry to `Map<planId, poll>` (view-switch/card-change still
  cancels all), with the chip aggregating per-card settles.
- **Re-label the button.** `command.html:1030` reads `ADVANCE`. Once it fires
  dispatch the label must say `DISPATCH` — otherwise the mislabel persists in
  the opposite direction.

**`dock.js` — the desktop twin.** `runAgentAction('dispatch-starred')`
(`:349-358`) posts `/kanban/advance` identically. The dock has no poll
machinery and needs none: per starred card, POST `/kanban/dispatch` WITHOUT
`ack` — the blocking variant verifies the outcome before answering, which is
all a quick-action feed entry needs. Report per card via `renderControlEntry`.

**Edge cases.** A mid-loop failure must not read as total failure: report per
card ("dispatched 3/5; 2 refused: …"). The dispatch view's column picker
(`dispatchSourceColSelect`, `:966`) is a *source* filter, not a target — either
omit `targetColumn` (auto-routes by complexity) or extend the surface with a
real target picker; do not feed the source filter in as a target. If a
genuinely-move-only control is wanted later, `/kanban/move` exists — label it
as a move.

### `src/services/LocalApiServer.ts` — one honest contract per route

**Context.** `/kanban/advance`'s docblock (`:3169-3173`) claims the route
"honours the CLI-triggers gate" — the route is move-only by construction and
never evaluates the gate. And `_handleKanbanVerb` (`:8224`) strips
client-supplied `bypassTriggerGate`, so an explicit verb-route dispatch cannot
fire with the toggle off — the one genuinely over-gated non-kanban surface.

**Logic.** Two small edits:

- Docblock: state the real contract — advance moves the card to its next stage
  and never fires a CLI trigger (`promptSelected` semantics); callers wanting
  dispatch use `POST /kanban/dispatch`. Decision recorded: advance stays
  move-only rather than becoming gate-honouring, because flipping existing
  callers from never-dispatch to sometimes-dispatch is the dangerous direction
  of surprise, and `/kanban/dispatch` is the explicit path.
- Remove `delete body.bypassTriggerGate` at `:8224` (kanbanVerb route only), so
  `POST /kanban/verb/triggerAction { …, bypassTriggerGate: true }` dispatches
  with the toggle off — the identical capability `/kanban/dispatch` already
  grants the same authenticated caller. Leave the strips at `:8252`, `:8280`,
  `:8388` (planning/tickets/taskViewer routes): the flag is meaningless to
  those providers' verbs. Note the scope: `_handleKanbanVerb` serves three
  prefixes — `/kanban/verb/*`, `/mission-control/verb/*`,
  `/agent-control/verb/*` (`:14278`, `:14282`, `:14293`) — so the removal
  un-strips all three. Same caller, same verb space, same argument; the diff
  states it anyway. `verbSchemas` is no obstacle: `triggerAction` already
  declares the field optional (`verbSchemas.ts:266`) and the validator never
  strips undeclared fields (`verbSchemas.ts:62-75`).

**Edge cases.** A standalone-board drag goes over this same route
(`transport.js:26`) — the webview never sends `bypassTriggerGate`, so board
semantics are unchanged. Document in the diff that the verb route remains
board-equivalent for callers that do not pass the flag. Also written down:
the flag reaches only `_advanceCards`' reads — `moveSelected`/`moveAll`'s
custom-user and planner direct reads (`KanbanProvider.ts:12315`, `:12337`,
`:12445`, `:12466`) gate regardless of it. Deliberate: those branches are
board gestures, and explicit dispatch has `/kanban/dispatch` +
`triggerAction`.

### `src/services/KanbanProvider.ts` + `src/standalone/bootstrap.ts` — the gate stays; the name stops lying

**Context.** Every one of the eleven read sites is a kanban-move-gesture site
that already discriminates explicit dispatch via `bypassTriggerGate`:
`_advanceCards` (`:9809`, `:9863` — shared by drag, `moveSelected`, `moveAll`),
`triggerAction`/`triggerBatchAction` (`:11300`, `:11588` — what a drop posts),
the `moveSelected`/`moveAll` custom-user and planner arms (`:12315`, `:12337`,
`:12445`, `:12466`), and the standalone `triggerAction` arm
(`bootstrap.ts:3336`). No read is removed. What is wrong is the *name*:
`kanban.cliTriggersEnabled` reads as a global switch, which is what invited the
scope-creep reading in the first place.

> **Superseded:** Rename to `kanban.dragDropCliTriggersEnabled`.
> **Reason:** `dragDrop` under-names the gesture set — `moveSelected` and
> `moveAll` are button moves, not drops, and their tooltips document the gate.
> A name that excludes them recreates the same ambiguity under a new key.
> **Replaced with:** Rename to `kanban.boardMoveCliTriggersEnabled` — covers
> drag, move-selected and move-all, and a read outside a kanban move gesture is
> self-evidently wrong.

**Logic.** Rename the setting key, the cached field, the getter (`:1168`), the
scoped read (`:8835`), the toggle write (`:11785-11788`), the gate-report field
(`:10187-10196`, mirrored in `LocalApiServer.ts:530` and the
`resolveKanbanDispatch` return shape at `bootstrap.ts:5025`), the constructor
seed (`:605`) and the `_reloadSettingsFromStore` read (`:1016`) — both key on
the literal string — and the bootstrap read (`:3336`). Update
`SCOPE_AWARE_KEYS` (`:956`) and
`TaskViewerProvider._MIGRATABLE_NON_ROLE_KEYS` (`:3322`) — both lists key on
the literal string. UI label and tooltip (`kanban.html:2456`,
`"Toggle CLI triggers on/off"`) follow the same rule, and `moveAll`'s tooltip
(`kanban.html:4379`) gains the trigger note `moveSelected` already carries.
The `toggleCliTriggers` verb may keep its name (it is in
`src/generated/verbAllowlist.ts`; a verb rename requires
`npm run catalog:generate` and `npm run parity:check` passes) —
if the verb is left alone, say so in the diff rather than leaving the mismatch
to be discovered. The webview's message-fed `cliTriggersEnabled` variable and
the `enabled` field in `cliTriggersState`/`toggleCliTriggers` messages are
payload names, not the setting key — they may stay, but the diff says so.

**Test updates the rename owes.** `cross-client-scope-contract.test.js:129`
asserts the literal key in a `_getScopedSetting` call list;
`standalone-kanban-fork-detector.test.js:119` greps `bootstrap.ts` for the
literal; `KanbanProvider.test.ts` sets `_cliTriggersEnabled` ~20 times;
`external-headed-team-contract.test.js`, `team-scoped-role-routing.test.js`
and `verb-engine-kanban-headless.test.js` carry the name in fixtures. All
move to the new key/field in the same diff — a rename that leaves them red
is exactly the quiet-breakage class this plan exists to remove.

**Migration — this setting shipped, and it must narrow, never spread.** Per the
repo's users-and-migrations rule, state that exists in a released version is
migrated rather than assumed absent. The migration carries the value into a
**narrower** claim about scope, and that is the whole point:

- The migrated value governs **kanban board move gestures and nothing else**.
  No explicit-dispatch path ever needed this setting — `/kanban/dispatch`
  bypasses unconditionally and, after the route fix above, verb-route callers
  can pass `bypassTriggerGate` — so **there is no state of the migration,
  successful or not, that can leave explicit dispatch suppressed.** A board
  upgrading from legacy `false` ends with gestures quiet (their intent,
  preserved) and every explicit dispatch path live (the fix). That property
  comes from the bypass contract, not from the migration running correctly.
- **The new toggle works regardless of migration state.** Enumerate and handle
  all five: legacy key only; new key only; both (new wins, legacy ignored);
  neither (default, matching today's `true`); legacy present but unparseable
  (treat as unset and say so — per the repo's fallback rule a corrupt config
  must not read as a configured one). The toggle must read, write and
  round-trip in every case, and must never depend on a prior migration having
  run.
- **The value can sit in any of four tiers.** `_getScopedSetting` (`:891`)
  resolves project config → workspace db config → globalState → legacy db, in
  that order, and returns a bare value. The migration must walk the same tier
  order for the legacy key — a legacy `false` in workspace config loses to a
  legacy `true` in project config only if project scope is actually selected,
  exactly as today's resolution does. Write the new key to the tier the legacy
  value came from.
- **Tag the source.** The resolved value carries where it came from —
  `{ value, source }` where source names key AND tier (`new:project`,
  `legacy:workspace`, `default`, …) — logged where it is used. "Which store
  answered?" must be answerable after the fact. `_getScopedSetting` returns a
  bare `T`, so this is a new resolver wrapper for this setting, not a change to
  the shared helper's signature.
- Legacy key is read to seed and then left in place, never rewritten from the
  new one — a two-way sync gives two sources of truth that can disagree.

**Edge cases.** The standalone `kanbanVerb` `default:` arm forwards
`toggleCliTriggers` to `handleServiceVerb`, so the toggle works on standalone
today — nothing to wire, only to unhide (below). `promptSelected` /
`promptAll`'s custom-user branches dispatch `dragDropMode: 'prompt'` ungated —
that is clipboard dispatch, deliberately outside this setting's scope; leave it.

### `src/standalone/bootstrap.ts` — retire an un-reversed migration decision

**Context.** `automation: false` (`:1404`) sits in a declaration where every
other false flag states a measured reason and names the condition for flipping
it. It states none. It was set when standalone was not meant to run CLI
triggers at all; the product changed and the flag did not.

**Logic.** Once `#btn-cli-triggers` (and whatever else proves wired) leaves the
`automation` selector list, the flag gates only what genuinely needs automation
services: the Jules action, the four planner build buttons, and — via
`command.js:165` — the `mission` view. Give `automation` the same written
justification its neighbours carry: state which services are not wired on this
host, and the condition for flipping. If on inspection those paths ARE wired
(the `default:` arm reaches every `KANBAN_VERBS` entry — `runQueue`,
`julesSelected`, `dispatchProjectManager` included), flip the flag and let the
mission view and build buttons appear; either outcome must be earned by
tracing, not assumed.

**Edge cases.** `automation` is also the name of a field on
`RemoteProviderCapabilities` (`StoreRemoteProvider.ts:90`), where it means
something different. Do not conflate them; the host flag and the provider
capability are separate facts with the same word.

### `src/webview/transport.js` — gate each control on the capability it actually needs

**Context.** `caps.automation === false` (`:712-722`) applies `display: none
!important` to `#btn-cli-triggers`, `#btn-remote-control`, the Jules action and
four planner build buttons in one rule.

**Logic.** Split the selector list by what each control needs.
`#btn-cli-triggers` changes a board gesture setting via `toggleCliTriggers` —
wired on standalone through the `default:` arm, needing no automation service.
It leaves this rule unconditionally. Each remaining entry is audited per
control: trace the verb through `handleServiceVerb` to the service behind it
(`#btn-remote-control` → `remoteStart`/`remoteStop` → `_getRemoteControl()` →
`RemoteControlService`; the build buttons → their dispatch verbs), and gate
each on an honestly-derived flag for the thing it drives — per the file's own
standing instruction about `mission-control`: *"Gate those on a new,
honestly-derived flag instead."* Unhide only what works; a dead control left
visible is this bug pointed the other way.

**Edge cases.** The verb-presence test is meaningless — the `default:` arm
makes every allowlisted verb reachable. The test is whether the backing
service functions on this host: `RemoteControlService` polls remote trackers
against the local db, which standalone has — trace its constructor deps before
deciding.

### `src/webview/kanban.html` — a control must be legible in both states

**Context.** `.strip-icon-btn.is-off` (`:656-663`) sets `border-color:
transparent; opacity: 0.5` plus a grayscale/brightness filter on a dark theme,
and `#btn-cli-triggers` gets that class exactly when the setting is off
(`:3612-3613`).

**Logic.** Make the off state visually *distinct* rather than *faint*: full
opacity, visible border, and off signalled by a different affordance (e.g. a
struck-through or hollow icon treatment, a red/amber state dot — pick one and
apply it consistently). Once the button is no longer removed by the capability
pass, this is what decides whether an operator can find it.

**Edge cases.** All four statically-`is-off` buttons ARE live-initialised —
`btn-feature-ultracode`/`-goal`/`-drive` at `:3621-3684`, and
`btn-collapse-coders` at `:3686-3689`, whose polarity is INVERTED (`is-off`
applied when `collapseCodersEnabled` is `true`, i.e. the collapse view is
active). Audit polarity per button, not just presence of an initialiser: a
global `is-off` restyle otherwise repaints collapse-coders' ON state. A real
default-off control must not become indistinguishable from an enabled one.

### `src/webview/command.html` + `command.js` — show the state that changes the outcome

**Context.** The setting appears in no mobile file. An operator has no way to
see, from the surface, whether board-move triggers are on.

**Logic.** Surface the trigger state on the command surface — read-only is
acceptable — so board state is explicable on the screen where the operator
works. Once the verb route honours `bypassTriggerGate`, this indicator stops
being a dispatch gate explanation and becomes plain board state; still worth
showing while any surface honours it.

**Read path — pinned, because the obvious verb cannot serve it.** The
`getSetting` arm prefixes every non-`switchboard.` key with
`switchboard.prompts.` (`KanbanProvider.ts:14213`), so it cannot read a
`kanban.*` key today. Add one branch: keys starting `kanban.` skip the
prompts prefix and resolve through the new tagged resolver, returning
`{ success, key, value, source }`. `command.js` then POSTs
`/kanban/verb/getSetting { key: 'kanban.boardMoveCliTriggersEnabled' }` on
dispatch-view entry and on board refresh, and renders `value` read-only.
(Refreshing on entry is sufficient — the operator toggles on the board, then
looks at the phone; a live push is optional follow-up, not required.)

**Edge cases.** Do not add a second place to change the setting without
deciding which is authoritative; an indicator that disagrees with the board is
worse than none.

### A ratchet, so this cannot recur silently

**Context.** Three separate controls have now been made permanently invisible
by a host-capability flag — the Mission Control strip (recorded in
`transport.js`'s own comment), and `#btn-cli-triggers` here.

**Logic.** A contract test that enumerates every selector in `transport.js`'s
capability blocks and asserts (a) each id exists in the panel it claims to
gate, and (b) each gated control's backing path is wired in a host that
declares the flag true — "wired" meaning traceable through `handleServiceVerb`
to a working service, not greppable in the composition root. A selector
matching nothing is dead; a control hidden on a host where its path *is* wired
is this bug.

**Edge cases.** Several selectors are documented as forward-compatibility only
and currently match nothing on purpose. Those need an explicit exemption entry
rather than silent tolerance, or the test decays into noise.

## Verification Plan

### Automated Tests

1. With the setting `false`, an explicit dispatch through
   `POST /kanban/dispatch` delivers — seat stamped, `dispatched` event written.
2. With the setting `false`, dragging a card on the kanban moves it and
   dispatches nothing. **The setting's purpose, asserted directly.** Repeat for
   `moveSelected` and `moveAll` — the button gestures are gated identically.
3. With the setting `false`, the mobile dispatch control delivers — per card,
   via the `ack: true` flow.
4. The mobile dispatch control's request targets `/kanban/dispatch`, not
   `/kanban/advance`; `dispatch-starred` likewise — on BOTH `command.js` and
   `dock.js`. The Dispatch view's primary button reads `DISPATCH`
   (`command.html:1030`).
5. With the setting `false`: `POST /kanban/verb/triggerAction` *with*
   `bypassTriggerGate: true` dispatches; *without* it, moves-and-stays-quiet
   (board-equivalent semantics preserved). Same via `/mission-control/verb/`
   and `/agent-control/verb/` — one strip gated all three.
6. With the setting `true`, `POST /kanban/advance` still does not dispatch —
   the route's move-only contract is pinned, not just documented.
7. `grep -n "ack: true" src/webview/command.js` finds the POST, not only the
   comment.
8. Every read of the renamed setting sits in a kanban-move-gesture path or the
   setting's own read/write/toggle plumbing — enumerated site by site in the
   diff, including `bootstrap.ts:3336`, the constructor seed (`:605`) and
   `_reloadSettingsFromStore` (`:1016`).
9. Migration matrix: the five key-presence states each resolve the documented
   value and log the source; the four store tiers are each exercised as the
   answering tier.
10. Multi-card dispatch: N acked dispatches yield N independent delivery
    outcomes — the poll registry is a `Map`, and cancelling on view switch
    clears all, not one.
11. The rename's test surface goes green:
    `cross-client-scope-contract.test.js`,
    `standalone-kanban-fork-detector.test.js`, `KanbanProvider.test.ts`,
    `external-headed-team-contract.test.js`,
    `team-scoped-role-routing.test.js`,
    `verb-engine-kanban-headless.test.js` — all updated to the new key/field
    in the same diff.

### Goal Invariants

- No explicit-dispatch path is suppressed by the setting under either key:
  `/kanban/dispatch` bypasses unconditionally, and the kanbanVerb route no
  longer strips `bypassTriggerGate`.
- Every remaining read of the setting is reachable only from a kanban-originated
  move gesture (drag, `moveSelected`, `moveAll`) or the setting's own
  plumbing — the enumeration in the diff is the assertion.
- The setting's name contains the gesture class it governs; `cliTriggersEnabled`
  read as a global switch is what invited the scope creep.
- The setting resolver returns its source (key + tier) alongside its value; a
  bare boolean whose origin cannot be recovered is a schema violation of the
  repo's fallback rule.
- `command.js` AND `dock.js` contain no `/kanban/advance` call behind a
  control labelled as dispatch — and no dispatch-firing control labelled
  `ADVANCE`.
- `.strip-icon-btn.is-off` does not reduce opacity below legibility; the off
  state is signalled by something other than fading out.
- `automation` in `bootstrap.ts` either carries a written, measured reason
  naming the condition for flipping it — matching the standard its neighbouring
  flags already meet — or is gone from the selectors that do not need it.
- `src/extension.ts` gains nothing from this plan — standalone only.

### Manual / UAT

1. With triggers off, dispatch from the mobile command surface to a live seat.
   The seat receives the prompt; the chip reports the seat name via the poll.
2. With triggers off, drag a card across the kanban. It moves; no agent fires.
   Then "Move all" a column — same result.
3. With triggers off, find the CLI-triggers button on the standalone board
   **without being told where it is**, and turn it back on. It is currently
   `display: none` there, so this step fails before the change and is the
   headline acceptance test.
4. Load the board and confirm the four statically-off strip buttons are
   identifiable as controls rather than reading as absent.

---

**Recommendation: Send to Lead Coder.** (Complexity 7 — the four-tier
settings migration plus a six-file test surface and a multi-slot poll refactor
push it past routine multi-file work.)
