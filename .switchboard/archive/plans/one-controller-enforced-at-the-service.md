# One controller, enforced at the service

## Goal

Make "there is never more than one controller terminal" an invariant the pty service enforces, rather than a property a client-side flag hopes for. A singleton role refuses a second seat instead of falling through to the name-collision loop.

### Problem Analysis

The rule is stated nowhere and enforced nowhere that covers the race. Three layers exist and each misses:

**1. `ptyFleetService.create()` is designed to make a second one.** `:222-227`:

```
let name = friendlyName || `${role}-1`;
let counter = 1;
while (this.terminals.has(name)) {
    counter++;
    name = `${role}-${counter}`;
}
```

A taken name increments. No role is exempt — the word "orchestrator" does not appear in the file at all, so the service has no notion that any role is unique. For a coder, `coder-2` is correct behaviour; for the controller it manufactures the state that must never exist.

**2. The server guard checks adoption, not occupancy.** `TaskViewerProvider.ts:11307-11308` reads `this._autobanState.orchestratorSeat` and short-circuits when a session has already adopted the role. But adoption happens **after** the terminal exists — `shell.js`'s own comment measures the gap: *"the agent adopts the seat seconds or minutes after the terminal is created, so two rapid clicks both see an empty seat and spawn a second 'Orchestrator' terminal (renamed to 'orchestrator-2' by ptyFleetService.create's collision loop)."* So the guard is blind for the whole window in which the mistake is possible.

**3. The only guard over that window is client-side and per-tab.** `orchestrationStartInFlight` is a module-level JS variable in `shell.js`. It is defeated by: two shell tabs, a shell tab plus the extension panel, a reload mid-flight, or any other caller of the start path. The comment is explicit that *"the server's seat guard cannot help here"* — which is true, and is an argument for a different server guard rather than for a client one.

**Why a second controller is worse than a second coder.** The persona holds session state that assumes it is alone: it stages queues, dispatches card one, arms watches, and posts handoff reports. Two instances race on the same board — both may stage, both may dispatch, both may hand off — and the second's existence is invisible except as a terminal named `orchestrator-2`. Nothing downstream checks for a sibling, because nothing was built expecting one.

### Root Cause

The collision loop is a good default for the fleet — a user wanting three coders should get `coder-2` and `coder-3` rather than an error. Singleton-ness was never expressed as a property of a role, so the one role that needs it inherits the many-seat behaviour, and every guard added since has been placed at the layer that happened to be convenient rather than the layer that owns creation.

## Metadata

**Complexity:** 4
**Tags:** bugfix, reliability, backend

## User Review Required

### The singleton is global — and that is real work, not a removed scope key

One controller across every control-plane directory. The obstacle is where the fact lives: `orchestratorSeat` sits in `_autobanState`, restored from `this._context.workspaceState.get('autoban.state')` (`TaskViewerProvider.ts:1452`). Per-workspace storage cannot answer a global question. The global check has to come from either `globalState` or the pty service's own in-process registry, which is global to the host by construction.

Note this is the *opposite* of the `worktrees.branch` lesson from this programme: there, unscoped uniqueness was the bug; here it is the requirement. Worth saying so in the code, because the two look identical to a reviewer applying the earlier fix by analogy.

### The singleton set is the controller alone

**`project_manager` is the controller under another name** — the same seat, not a second singleton. Two role keys exist for it today: `orchestrator` is in `SYSTEM_ONLY_ROLES` (`GlobalIntegrationConfigService.ts:373`), while `project_manager` is a user-configurable role with a label, a visibility checkbox and a command field (`sharedDefaults.js:51`, `kanban.html:3222`), and PM delivery runs through `_tryFleetDeliveryForRole('project_manager', …)` (`TaskViewerProvider.ts:27900`). So the guard must treat the two keys as **one identity**. A set listing both as separate entries would still permit one of each — which is two controllers. Consolidating the keys belongs to the rename plan; this plan simply must not assume there is only one key.

**`researcher` is out.** It is a legitimate team role: a team can have one, and several teams can each have one. Singleton-ness there would break the fleet. Same for every other pool role.

### The rail button should reveal, not stop

Every other button in `#strip-terminals` navigates. Verified:

- **team button** → `selectPanel('terminals')` plus a `switchToTeam` message: *"the team view replaces the fleet view inside the existing panel, with a back button to return"* (`shell.js:809-830`).
- **ungrouped terminal button** → focus an existing pop-out if one is open, otherwise peek (`shell.js:945+`).

Neither ends anything. `#strip-orchestrator` is the only button in the rail whose press is destructive — lit press → `POST /orchestration/stop`. That is an inconsistency in a row of otherwise navigational icons, on the one surface where an icon carries no label to warn you.

**So the rail button matches its neighbours:** dimmed press → start; lit press → **reveal** (select the Mission Control panel, or focus the controller terminal), exactly as a team button switches the panel to team scope. Purely navigational, like everything next to it.

**What stop actually does, verified:** it disarms the session and archives it, and **deliberately leaves the terminal alive**. `TaskViewerProvider.ts:11668-11670` states why: *"This intentionally differs from stopOrchestratorFromKanban (which leaves the terminal alive because a running agent might have uncommitted context)."* Only `/handoff` closes the seat, and only because the persona has just posted its report so *"there is nothing in-flight to lose."*

That is a **session** end, not a terminal kill — which is precisely why it reads wrong as an unlabelled toggle and reads fine as a labelled control. No confirmation dialog is available (project rule, and `confirm()` is inert in a webview), so the label is the whole protection, and a nav-rail icon cannot carry one.

**Controls specific to the controller belong in the controller's own frame — and that pattern is already shipped.** The terminals panel keeps a `.sidebar-ops` block of labelled full-width buttons, and it *swaps scope*: `document.body.classList.add('is-team-scoped')` (`terminals.js:778`, `:10555`) hides the general-purpose buttons via CSS (`terminals.html:2129-2137`), while `renderSidebarList` reveals the team-specific ones keyed on `teamScopeId` — `#btn-team-orders`, `#btn-team-automations`, `#btn-team-clear`, `#btn-team-close`, `#btn-team-restart`, `#btn-team-ack`, `#btn-team-add`.

So the controller gets the same treatment: an `is-controller-scoped` body class and `btn-controller-*` buttons in that same ops block, shown when the panel is scoped to the controller. Not bespoke panel chrome invented for this plan — the existing slot, one more scope.

**The destructive-button precedent is already there too:** `#btn-team-close` reads **STOP ALL TERMINALS**, titled *"End every member process immediately"* — labelled, immediate, no confirm gate, exactly per project rule. An end-session button for the controller is the same shape as a control that already ships, which is the strongest argument that this is the right slot: nothing new has to be justified.

**And that control is required, not optional — because `/handoff` is not an exit.** It exists and is fully wired (route `LocalApiServer.ts:6157`, handler `:4639`, implementation `handoffOrchestrationSession` at `TaskViewerProvider.ts:11585`, with a contract test suite asserting the persona documents `## The handoff sequence`). But read what it does: it is *"hand off orchestration to a coding lead and exit"* — a **graduation**, permitted only when the pipeline can run without the controller. It refuses with 409 in five cases:

1. already handed off;
2. **the session is armed** (`orchestratorArmed`) — *"cannot hand off an armed session"*;
3. no live coding head — *"handoff requires an active lead to pace the pipeline"*;
4. self-reported `stagedCount <= 0`;
5. no dispatchable top-level STAGING cards, verified against the board rather than trusted from the caller — the comment explains that a handoff off an empty queue *"would exit the orchestrator having handed the lead nothing it will actually be given, which is the outage this gate exists to refuse."*

So handoff cannot end an armed session, a session with no lead, or a session with an empty queue — which is to say it cannot end any session that has gone wrong. The rail toggle is currently the **only** general way out. Removing it without landing the panel control first would leave a controller session with no exit at all.

**Sequencing, therefore:** the labelled panel control ships *before or with* the rail button's change of meaning, never after.

**The guard still needs the disarmed-but-alive state**, wherever stop lives. After a stop there is a terminal but no seat: neither "no terminal" nor "live controller". A start in that state must re-seat the existing terminal, because the name is taken and the collision loop would otherwise increment. This is the likeliest duplicate path in practice — stop, then start from any surface — and a naive "is there a live seat?" check misses it exactly.

### Existing tests this breaks — checked, and it is two, not zero

**Nothing relies on a second controller.** Swept `src/test/` (228 files) and `src/services/__tests__/`: zero references to `orchestrator-2`, `ORCHESTRATOR_TERMINAL_NAME`, or `role: 'orchestrator'` in any fixture, and no multi-root harness that spawns one per root (`multi-parent-terminals-contract.test.js` runs terminals in two repo cwds but never a controller). The collision-loop fixtures that do exist are all pool roles — `lead-1-coder-2`, `lead-1-coder-3` — which this plan deliberately leaves alone. So the global singleton costs no fixture.

**But two tests in `shell-terminal-strip.test.js` assert the behaviour this plan changes**, and they read source text via `block(shellJs, …)`, so they fail loudly rather than rot silently:

1. **`:756` — *"lit-click posts /orchestration/stop and dimmed-click posts /orchestration/start"*.** It asserts `fetch('/orchestration/stop')` appears in the lit path. Change 4b removes exactly that, so the test fails by design. Rewrite rather than delete: the new assertion is that the lit path navigates and posts **no** stop. Its comment also needs replacing — *"The two click paths are the shell rail's only orchestrator controls"* stops being true the moment the scoped ops block exists, and that sentence is precisely where a future reader would go to learn the rule.
2. **`:778` — *"the dimmed-click has an in-flight guard against double-click"*.** It asserts `orchestrationStartInFlight` exists, that `if (orchestrationStartInFlight) { return; }` makes a second click a silent no-op, and that it clears via `.finally`. Change 4 demotes that flag from guard to UI affordance, so these assertions must move with it. Its comment restates the very race this plan's Problem Analysis quotes — *"the agent adopts the seat seconds or minutes after the terminal is created"* — so it should end up pointing at the service guard instead of the client flag. Leaving it as-is would leave the codebase asserting that the client flag is the protection, after it stopped being.

Both are behaviour-change fallout rather than surprises, but they belong in the plan: a coder who sees two red tests in a file they did not touch will otherwise assume they broke something.

## Complexity Audit

### Routine

- A singleton-identity declaration, and a branch in `create()` that consults it before the collision loop.
- Removing the now-redundant client-side in-flight flag, or keeping it purely as a UI affordance (disabled button) rather than as the guard.

### Complex / Risky

- **Enforce at `create()`, not at the callers.** The reason the current guards fail is that they sit above creation, and each new surface adds another place to forget. `create()` is the one chokepoint every path goes through — the rail button, `startOrchestratorFromKanban`, the standalone host, and any future panel or dock control.
- **The correct guard already exists in one caller — lift it, do not reinvent it.** `startOrchestratorFromSidebar` (`TaskViewerProvider.ts:11307-11327`) checks the seat *before* creating anything: with a named seat it delivers the kickoff to that terminal and returns; with an unnamed seat it declines and says *"An agent session already holds the orchestrator seat. Talk to it there, or stop orchestration first."* Its comment states the principle outright: *"Creating a terminal here would be the duplicate the adopt door removes."* That is exactly the return-and-reveal behaviour this plan wants, already written and already reasoned. The defect is only that it lives in one caller out of several. Move it down to the service; do not draft a new rule beside it.
- **An adopted controller wears no controller role, so a role-keyed check cannot see it.** `:1719-1721`: *"an adopted seat is the orchestrator even though no terminal is named 'Orchestrator' and no fleet row carries role 'orchestrator'."* A singleton check that only asks "is there a live terminal with role `orchestrator`?" returns no and mints one alongside the adopted session. So the guard must consult the **seat record** as well as the role — which makes the seat check load-bearing rather than the redundant legacy it might look like.
- **Role-based delivery already assumes singletons and will silently pick one.** `_tryFleetDeliveryForRole(role, …)` selects by role; with two controllers it delivers to whichever it finds first. So today a duplicate does not announce itself as an error — it announces itself as work going to the wrong terminal, which is far harder to diagnose. Fixing creation fixes that class without touching delivery.
- **A dead terminal holding the name must not lock the role out permanently.** If `orchestrator` exists but its process is gone, a refusal would leave the user unable to start one. The check must be for a *live* seat, and the reuse path must handle "named terminal exists, process dead" by reclaiming rather than refusing.
- **`orchestrator-2` may already exist in the wild.** Anyone who double-clicked has one. The change should not orphan it: on startup, or on the first singleton check, a duplicate should be reported (not silently killed — it may have unsaved context in its scrollback).
- **The standalone host has its own creation path.** Verify `bootstrap.ts` routes through the same `create()`; if it constructs terminals another way, the guard needs to cover both or the invariant holds only in the extension.

## Edge-Case & Dependency Audit

**Migration.** No stored state. Existing `orchestrator-2` terminals are reported rather than removed. No test fixture creates one, so nothing in CI has to be migrated — only the two rail tests rewritten.

**Security.** Neutral. No new surface; a refusal path is added.

**Side effects.** The rail button changes meaning: today a lit press ends the session, after this it reveals. That is a deliberate behaviour change to a shipped control, and the only one here — worth calling out in release notes, since a user who has learned the toggle will expect stop. The compensating control is the labelled one in the panel, so the capability is not lost, only moved somewhere it can be read.

**Ordering.** Internally ordered: the panel's stop control precedes the rail button's change of meaning, or there is a window with no way to end a session. Otherwise independent and shippable now. It is a **precondition** for the Mission Control surfaces: the panel, the dock and the rail button all reach the same start path, and three entry points over an unenforced singleton is three ways to break it.

## Dependencies

- **Constrains** `mission-control-panel-ui-specification.md`: its "Stop mission" and global controls should land in the scoped `.sidebar-ops` block rather than as new panel chrome, for the same reason. Also a **precondition for** it and `feature_plan_20260808220200_shell-right-agent-dock-terminal.md` — both add surfaces that touch the controller, and neither should ship while the invariant is client-side.
- Independent of the missions and automation work.

## Adversarial Synthesis

**"The in-flight flag already handles this."** It handles one tab. The comment that introduces it says the server cannot help, which is the tell: a client guard was chosen because the available server guard checked the wrong thing, not because a client guard was sufficient.

**"Two controllers is a user error — let them."** A user cannot see it. The duplicate is named `orchestrator-2` and nothing surfaces it as a problem; role-based delivery just starts sending work to one of them. An invariant the system relies on internally should not be the user's job to maintain.

**"Make the collision loop refuse for every role."** No — three coders is a legitimate configuration and the loop serves it correctly. Singleton-ness is a property of specific roles, so it belongs in a list, not in the loop's general behaviour.

**"Guard in the start handler instead — it is one place."** It is one place *today*. The panel, the dock and the rail all reach the controller, and the last two revisions of those plans each proposed a start control before finding the existing one. Creation is the chokepoint that cannot be bypassed by a new surface.

## Proposed Changes

1. **Declare the singleton identity** as data: the controller, covering **both** role keys (`orchestrator` and `project_manager`) as one identity. Pool roles — `researcher` included — stay many-seat.
2. **`create()` consults it before the collision loop**: for the singleton identity with a live terminal, return that handle rather than minting `<role>-2`. **The check is global** — never scoped by workspace root.
2a. **Consult the seat record, not only the role** — an adopted controller carries neither the name nor the role, so a role-only check mints a duplicate beside it.
2b. **Handle the disarmed-but-alive state**: a start when the terminal exists and the seat is disarmed re-seats that terminal. Likeliest duplicate path in practice, and the one a live-seat check misses.
2c. **Source the global fact from somewhere global** — `globalState` or the service's in-process registry, not `workspaceState`, which cannot answer it.
3. **Reclaim, do not refuse, when the named terminal is dead** — a stale name must not lock the role out.
4. **Demote the client flag** to a UI affordance (disable the button while a start is pending); it is no longer the guard.
4a. **Put the controller's controls in the controller's own scope**, reusing the `.sidebar-ops` pattern: an `is-controller-scoped` body class and `btn-controller-*` buttons, mirroring `is-team-scoped` / `btn-team-*`. The end-session button goes here, shaped like `#btn-team-close`. This lands **before or with** 4b — `/handoff` refuses armed, lead-less and empty-queue sessions, so the rail toggle is today's only general exit.
4b. **Make the rail button navigational.** Dimmed → start; lit → reveal, matching every other button in the rail.
5. **Report pre-existing duplicates** rather than removing them — scrollback may matter.
6. **Verify the standalone creation path** routes through the same `create()`.
7. **Rewrite the two rail tests** at `shell-terminal-strip.test.js:756` and `:778`, comments included — they currently assert the toggle and the client flag are the design.

### Migration

None. Existing duplicates are reported, not deleted.

## Verification Plan

### Goal Invariants

- No sequence of calls produces two live terminals for a singleton role.
- A dead singleton terminal can always be replaced.
- Non-singleton roles still get `<role>-2`.

### Automated Tests

- **Concurrent starts yield one terminal:** fire two `/orchestration/start` calls with no delay between them and assert exactly one controller exists. This is the actual bug — the existing client flag passes a sequential test and fails this one, so a sequential-only test would certify the defect.
- **Two surfaces, one controller:** start from the rail path and the panel path simultaneously; assert one. The per-tab flag cannot cover this and it is the realistic failure once three surfaces exist.
- **Adoption-window race:** create the terminal, and before adoption, call start again; assert no second terminal. This is the window `shell.js` documents as "seconds or minutes".
- **Dead terminal is reclaimable:** kill the process, leave the name, call start; assert a working controller rather than a refusal.
- **Stop-then-start re-seats, never duplicates:** press stop, assert the terminal survives (per `:11668`), then call start from a *different* surface and assert the same terminal is re-seated with no `orchestrator-2`. This is the realistic duplicate path and the one a naive "is there a live seat?" check would miss, because after stop there is no seat but there is a terminal.
- **Global, not per workspace:** with two control-plane roots open, start from each; assert one controller total. Asserting per-root uniqueness would pass while violating the requirement.
- **The rail button never stops:** press it while lit and assert it navigates — no `/orchestration/stop` call from any rail path. This is the behaviour change, so it needs the test that would fail today.
- **Controller scope swaps the ops block, and unscopes cleanly:** enter controller scope and assert the general-purpose buttons hide and `btn-controller-*` show; leave and assert the reverse. The team-scoped path has the same failure mode — a scope that hides but never restores — so this mirrors an assertion that already earns its place.
- **The panel can end any session handoff refuses:** arm a session, then assert `/handoff` 409s while the panel's stop succeeds. This is the pair that proves the exit exists — testing stop alone would pass even if handoff were the only route.
- **An adopted controller blocks creation:** adopt an ordinary terminal into the seat, then call start; assert no new terminal. A role scan alone passes this test wrongly, because the adopted terminal's role is not `orchestrator`.
- **The PM key is the same singleton:** create a `project_manager` seat, then start the controller; assert one, not two. Two separate set entries would fail this while looking correct.
- **Collision loop intact for others:** create three coders; assert `coder-2` and `coder-3`.
- **Standalone parity:** run the same concurrent-start assertion against the standalone host.
- **Pre-existing duplicate is reported:** seed `orchestrator-2`; assert it is surfaced and not deleted.

## Outstanding Questions

None. The last open one — whether anything relies on creating a second controller — is answered under *Existing tests this breaks* above: nothing does, but two rail tests must be rewritten with the behaviour change.

## Completion Report

Implemented the singleton guard in `ptyFleetService.create()` — a `_findSingletonHandle` check before the collision loop returns the existing live handle (or reclaims a dead one) for `mission-control` and `project_manager` roles, which share identity `'controller'`. Wired `setControllerSeatResolver` in `bootstrap.ts` (standalone) and via a new `ptySetControllerSeat` verb in `ptyHost.ts` + `_pushControllerSeatToPtyHost()` in `TaskViewerProvider.ts` (extension host child process), so the guard sees adopted seats that carry neither the role nor the name. In `shell.js`, made the rail icon navigational (lit click → `selectPanel('terminals')` + `switchToController` postMessage, no `/mission-control/stop`) and demoted `missionControlStartInFlight` to a UI affordance (disables button while pending). Added `is-controller-scoped` body class + `#btn-controller-stop` button in `terminals.html`, wired `enterControllerScope`/`exitControllerScope` + the stop button in `terminals.js`. Rewrote all six rail-icon tests in `shell-terminal-strip.test.js` to match the new names and navigational behaviour. A mid-task rename (`orchestrator` → `mission-control`) swept the codebase and required updating all identifiers in the tests and comments; no functional issues encountered.

## Review Findings

The singleton design is sound and kept as built. Five fixes. `reportSingletonDuplicates` had zero callers — Proposed Change #5 was an unreachable method; it is now called from the guard's own path and reports without removing. Controller scope was a one-way door: `exitControllerScope` was reachable only from END SESSION while the `is-controller-scoped` CSS hid every general-purpose button, so `renderGroupTabStrip` now renders the same "← All" exit team scope has (returning `false`, since that value is `pickerRendered`, not "did I draw"). `enterControllerScope`'s docblock promised an adopted-seat lookup the code never did — the seat name is now cached off the autoban rail and checked first. `_pushControllerSeatToPtyHost` only fired on seat *change*, so a window reload with a seat already adopted left the pty child holding `null` for the session; it is now seeded at child spawn. Finally, the claim that `create()` is "the one chokepoint every path goes through" is false — `startMissionControlFromKanban` uses `vscode.window.createTerminal` — so the comment now states the real scope and why that path is nonetheless race-safe (synchronous registration before the first await).

**Remaining risks:** the extension host's controller is a second enforcement point, not this guard; the duplicate report is a console warning plus a change event, with no UI surface.
