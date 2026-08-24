# Mission Control panel: UI specification

## Goal

Give automation one comprehensible home. Remove the kanban AUTOMATION tab, add a Mission Control panel to the shell rail, and put the two things a user actually configures — **missions** and **schedules** — behind one tab each, with a sidebar-list-plus-detail layout in both, plus a **Control** tab hosting the persona's terminal so it is reachable at any window width.

### Problem Analysis

The automation model settled in `the-automation-model-four-things-not-a-mode-axis.md` has no home. Today its parts are scattered: an exclusive mode axis in a kanban tab, a scheduler sharing that tab for no reason, a prompt generator disguised as a mode, and mission running with nowhere to live at all. Without a single surface the model is four ideas competing for one radio, and the UI stays incomprehensible however good the model is.

This plan is the UI half. It assumes the model and specifies where each part lives.

### The rail already has an orchestrator control — consolidate, do not stack

`shell.js:271` creates **`#strip-orchestrator`**, a UFO button at the top of `#strip-terminals` that already is the start/stop control:

- lights when a session is active, dims when inactive; state arrives via `orchestratorState` postMessages relayed from `terminals.js` off the WS broadcast rail
- **lit click → `POST /orchestration/stop`**; **dimmed click → `POST /orchestration/start`**, where the *server* picks the path — a pty terminal carrying the persona prompt when a lead/coder agent is configured, else the `/switchboard` launcher text as a clipboard fallback
- carries a double-click in-flight guard, because the agent adopts the seat seconds after creation so two fast clicks would otherwise spawn `orchestrator-2` via the collision loop
- no confirmation dialog, per project rule

**This supersedes the start controls earlier revisions proposed** — one in this panel, one in the dock's empty state. Neither is needed: the rail button exists, has the right semantics, is already stateful, and already solves the double-start race that a naive second control would reintroduce.

**Reconciliation with `one-controller-enforced-at-the-service.md`:** that plan changes the rail button's lit-click from **stop** to **reveal** (select the Mission Control panel or focus the controller terminal), making it navigational like every other button in the rail. The stop control moves to a labelled `btn-controller-*` button in the scoped `.sidebar-ops` block. This plan defers to that change — the affordance table below reflects the post-reconciliation semantics, not the current stop-on-lit-click behaviour. The double-click guard also moves: the one-controller plan demotes the client-side `orchestrationStartInFlight` flag from guard to UI affordance, because the service-layer singleton check at `create()` becomes the real guard.

**And it fixes an affordance count that was heading for three.** With the fighter-jet panel icon plus the dock toggle plus this button, Mission Control would have had three rail entries, one duplicating another's function. The intended set is two, each doing a distinct thing:

| Rail affordance | Does |
|---|---|
| `#strip-orchestrator` (existing, restyled to the fighter-jet/Mission Control identity) | **start (dimmed) / reveal (lit)** the persona, with live state — navigational, per `one-controller-enforced-at-the-service.md`; stop moves to the scoped ops block |
| Mission Control panel icon | opens the panel — missions, schedules, Control |
| ~~dock toggle~~ | folded into the dock plan's own bottom-cluster toggle, which shows/hides a pane rather than starting anything |

So the rename plan's mechanical pass should reach this button's tooltip and identity, and the dock's empty state **points at the existing rail button** rather than offering a start of its own.

**One thing to preserve rather than re-derive:** the clipboard fallback. When no agent is configured the server returns launcher text instead of creating a terminal, and that path is why the button works on an install with no pty. Any new surface that starts the persona must keep both outcomes, or it works only where `node-pty` does.

### Rail placement

The rail renders from `getPanelsManifest` in array order, with `placement: 'bottom'` the only override (`headlessPanelHtml.ts:520-529`, `shell.js:501`). Target order:

```
board
mission-control      ← new; fighter-jet icon
agent-control        ← moved beneath mission control
terminals            ← moved beneath mission control
… (project, memo, tickets, planning, design, connections)
setup                (placement: bottom)
```

So this is a manifest insert plus a reorder — no `shell.js` change, per its own comment that "adding a panel route later adds a strip icon with no shell code change".

The **fighter-jet icon** ties to the brand: the product's second homepage illustration is a radar scope with tagged interceptors (`agent-fleet-air-combat-detailed.svg`), and the persona rename settles on Mission Control (`rename-the-orchestrator-to-mission-control.md`).

### Layout

Both tabs use **sidebar list + detail**, the pattern `tickets.html` already implements — `#tree-pane` inside a `.content-row`, with a `.sidebar-toggle-row` and a `collapsed` state (`tickets.html:364-366`). Reuse it rather than inventing a third layout.

---

## Guaranteed terminal access — as panel chrome, not a third tab

The Mission Control **dock** (`feature_plan_20260808220200_shell-right-agent-dock-terminal.md`) is gated at `DOCK_VIABLE_MIN = 980`, because `48 + 4 + 648 + 280` is the narrowest viewport that fits a legible terminal *beside* the board. Below that the toggle is disabled, and on a `node-pty`-less install the dock does not exist at all. So on a laptop, or in a split window, the controller is reachable only through the full-screen terminals panel or a solo pop-out — the mode switch the dock was built to remove.

**The panel has no such constraint, because there is no board to preserve inside it.** The content area is the viewport minus the 48px rail, so at 1280px it is ~1232px — comfortably past the 648px a terminal needs. The dock's floor is about *coexistence*, not legibility.

So the panel hosts the same `?solo=<seat>` frame the dock uses. **But not as a peer tab** — as a persistent strip the tabs sit beside, the same relationship the dock has to the board, one level in.

### Why not a tab: a terminal in a hidden tab keeps resources it must release

A terminal is not a view. It holds two things a hidden surface must give back, and **the only carrier for giving them back is a message the shell sends on panel switch** — which a tab switch is not.

`shell.js:147-152` posts `panelVisibility` to every frame from `selectPanel`, and `terminals.js:1229-1270` is the arm that acts on it. Its comment states why the message has to exist at all: *"This document then stops being rendered, so its ResizeObservers no longer run — the container observer above cannot see this transition in either direction… The shell is the only thing that knows, so the shell has to say so."* It adds that two prior plans of this same feature *"reached OPPOSITE research conclusions about whether an in-iframe ResizeObserver sees the parent's `display:none`"*, so the release deliberately does not bet on the observer.

What rides that carrier:

1. **The shared pty size vote.** The pty is shared across clients and each client's reported size *clamps* it. `releaseSizeVote`'s comment: *"`client.reportedSize` is sticky server-side: fitAndReportSize returns early when the box is 0x0, so a client that goes hidden simply stops sending and its final size clamps the pty until the socket closes. That is why switching the shell to another panel did not release the cockpit's hold on a popped-out terminal."*
2. **The WebGL renderer context**, via `armRendererRelease`, against a per-document context ceiling. *"The release machinery's headline case is 'a panel switched away from keeps every context it took'."*

Tabs inside a panel are the panel's own `display:none` toggles. They never pass through `selectPanel`, so a terminal in a hidden tab gets **neither** message. Switch from Control to Missions and the controller's pty stays clamped to whatever the tab last measured — for every *other* viewer of that same terminal: the dock, a pop-out, the terminals panel. That is the exact bug quoted above, reintroduced one level down, and its symptom appears on a surface the user was not touching.

**As panel chrome the problem does not arise.** A strip outside the tabbed content area is hidden only when the whole panel is, which `selectPanel` already covers, correctly and for free. No new relay, no new failure mode, and it matches what the dock is *for*: the controller sits alongside the work, not in a tab that competes with it for the same rectangle.

That settles the access story:

| Width | Path |
|---|---|
| ≥ 980px | dock beside the board — the point of the dock |
| < 980px, or split window | **the panel's controller strip** — no mode switch away from Mission Control |
| no `node-pty` | neither; both absent by the same manifest gate |

**The strip hosts the controller's scoped controls, not just its terminal.** `one-controller-enforced-at-the-service.md` puts the controller's labelled controls (`btn-controller-*` — stop, restart, ack) in a scoped `.sidebar-ops` block, mirroring the team-scoped pattern in the terminals panel. When the controller is viewed in the Mission Control panel's strip rather than the terminals panel, the same scoped ops must appear alongside it — otherwise the strip is a terminal with no exit, and the one-controller plan's sequencing rule (panel stop ships before the rail button's change of meaning) is violated. The strip is a viewing context for the same terminal, so the `is-controller-scoped` body class and `btn-controller-*` buttons apply here too, not only in `terminals.html`.

**If it ships as a tab anyway**, the panel must relay a `panelVisibility`-equivalent into the embedded frame on every tab switch, reusing that same arm rather than a new one. That is the minimum, not a nicety — and it is worth noting the failure is silent and remote, so it will not show up in testing the tab itself.

It also makes the dock honestly optional: a convenience for wide monitors rather than the only front door, which is what a capability-gated front door would be. And it gives the first-run intro a home that every user can reach — the reason the dock's empty state is a copy rather than the canonical surface.

**Do not solve this by lowering the dock's 648px floor.** That number exists so the terminal stays legible; shrinking it produces an unusable terminal *and* a squeezed board.

## Missions tab

**Sidebar:** selectable missions. **Content:** the selected mission.

| Field | Behaviour |
|---|---|
| **Goal** | user-entered free text |
| **Type** | `mission` (unsupervised) or `operation` (supervised) |
| **Status** | not started · in flight · aborted · completed |
| **Team** | assign one or more teams |
| **Max extra worktrees** | how many **additional** worktrees this mission may create. Default `0` = work in whatever tree the mission starts in. A **mission** may not exceed `1`; an **operation** may go higher |
| **Features and plans** | add and remove members |
| **Sequencing** | shows the order; **defaults to sequential when no stream map exists** |
| **Log** | events so far |

**Global controls:** workspace/project selector · Launch · New mission · switch view by status · Delete mission · Stop mission · **Ready mission**.

**Ready is a flag, not a status.** The status set is not-started/in-flight/aborted/completed, so readiness is orthogonal: it marks a mission as eligible for pickup, and **a scheduler or Mission Control must not take an unready mission**. That is the safety property that makes "build missions in advance" usable — a half-assembled mission sitting in the list cannot be grabbed.

**The field counts *extra* worktrees, and the name matters.** "Max parallel worktrees" reads as a total and invites `1` to mean "one tree", which is the mission's starting tree and therefore no isolation at all. **Max extra worktrees** with `0` meaning "stay in the tree the mission started in" is unambiguous, and it makes the default honest: most missions add nothing.

**The cap is a real constraint, not a default.** `mission ≤ 1 extra` keeps unsupervised runs from fanning out into parallel trees with no one watching; an operation may go higher because a supervised run has someone to resolve conflicts. Enforce it where the run starts, not only in the form — a mission whose type is changed after launch must not silently gain parallelism.

---

## Schedules tab

**Sidebar:** scheduled actions, each active or not. **Content:** the selected action. Multiple actions allowed; **no cap on active actions** — that is the user's problem to manage.

**Type:** internal or external.

### Internal

**Time:** dropdown from every 5 minutes to once a week, plus **custom (cron)**.

**Action** dropdown:

- advance plan
- phone a friend on a coded plan (skips features)
- advance feature (goes to a team if configured)
- batch advance to planning team
- review code vs intent on CODE REVIEWED plans in the last period, produce a doc
- process memo
- improve docs
- update readme
- send plans to Jules
- start a ready mission
- research (requires a research terminal)
- git pull/push
- custom

**Conditional fields, by action class:**

| When the action… | Show |
|---|---|
| advances a plan or feature | **from** and **to** column fields |
| involves coding | **complexity filters** (e.g. filter what goes to Jules) |
| produces an artifact (research, intent reviews) | **artifacts folder** |
| is *not* a board action | **target terminal** (changeable) and the **prompt**, editable |

### Most actions are prompts, not features

**The action list is largely prompt templates, not new subsystems.** Each non-board action is: a **wording** this plan supplies, a **target terminal** the user picks, and whatever conditional fields its class declares. So "which of these exist today" is the wrong question — the deliverable is the set of wordings, and the dispatch path already exists.

That reframes the work: the schedules tab needs a prompt template per action, each editable before send, rather than thirteen features. It also sets where the difficulty actually is — the wordings must be good enough to run **unattended**, since nobody is reading the reply.

### The unattended standing order

Every planner-class action carries a standing order stating the terms of an unattended run. Three clauses:

1. **This is an unattended task; user questions will not be answered.**
2. **If user answers are required to proceed:** move the plan back to `CREATED` with the open questions listed on it.
3. **If research is required but no researcher is available:** move the plan back to `CREATED` with a note that the planning workflow is complete but needs uncertainty resolved.

The distinction between 2 and 3 is worth preserving rather than collapsing into "blocked": the first is *incomplete pending a decision*, the second is *complete pending evidence*. A plan returned for the second reason does not need re-planning, and a single "blocked" state would send it through planning again.

This is a standing order attached to the prompt, not new machinery — the same mechanism `teamWiring.ts` already uses to append durable instructions. **Confirmed: no equivalent exists, so this plan owns the wording.**

**Structurally it belongs in the orders library.** `compose-standing-orders-from-a-library.md` composes orders along four axes — reviewer-seat presence, work kind, pacing mode, orchestrator presence. This is a **fifth: attended vs unattended.** The order applies when the action is planner-class *and* nobody is reading the reply, which is precisely a situational fragment rather than a body installed per team. If that plan lands first, this order is a fragment in it; if this panel lands first, the order lives here and moves later. Either way it should not become a second monolithic body — that is the failure that plan exists to fix.

### External

Same action dropdown **with the board actions removed**, plus a **Copy prompt** button. No clock, no ON/OFF, and — per the model plan — **no pausing of anything local**.

**Global controls:** New schedule · Delete · Start · Stop · **Logs** (switches the content view to the log markdown file, with a link to it).

---

## Metadata

**Complexity:** 6
**Tags:** ui, frontend, ux, feature, backend

## User Review Required

- **Batch advance to planning team ships enabled.** Its dependency is being coded before this panel ships, so the dead-control concern does not apply. An earlier revision of this plan recommended shipping it disabled — withdrawn.
- **The prompt wordings are the real deliverable** for the non-board actions, and they need review. Each must work with nobody reading the reply.
- **Does the missions tab own mission *creation* from the board?** `staging-streams-parallel-dispatch-and-worktrees.md` has a mission auto-created by dropping a card into STAGING. This panel adds a New mission button. Both should be fine, but the panel must show a board-created mission identically to a panel-created one.

## Complexity Audit

### Routine

- Manifest insert plus reorder; no `shell.js` change.
- `mission-control.html` + `mission-control.js`, following the companion-`.js` convention seven panels already use.
- Reusing `tickets.html`'s sidebar/content/collapse pattern.
- Deleting `automation-tab-content` and `automation-panel-root` from `kanban.html`.

### Complex / Risky

- **The conditional-field matrix is where this gets fragile.** Four field groups keyed on action class, over thirteen actions, means a wrong classification silently shows the wrong form — a board action asking for a terminal, or an artifact producer with nowhere to write. The action list should carry its classes as **data** (`needsColumns`, `needsComplexity`, `needsArtifactsFolder`, `needsTerminal`), not as branching in the render function, and the test should assert the matrix rather than the rendering.
- **Two `enabled`/active concepts must not blur.** A *schedule* is active or not; a *mission* is ready or not, and separately has a status. Reusing one word across both is how the current tab became unreadable.
- **Removing the AUTOMATION tab strands its persisted state.** `autoban.state` in `workspaceState` holds mode selections that no longer have UI. Per the model plan they are forced off with one notice — but this plan deletes the surface, so the notice needs somewhere to appear. Mission Control on first open is the obvious place.
- **`kanban.html`'s tab strip loses a member.** Same flex-wrap check as the agent-control retirement.
- **The log view is a markdown file, not a live stream.** "Logs switches the content view to a MD file" — so it is a document render, and it needs to say how current it is. A log that looks live and is not is worse than a link to the file.
- **`status` and the run are two sources of truth.** A mission shows `in flight`, but the actual state lives in the queue and the board. The panel must derive status rather than store its own copy, or a killed run leaves a mission reading `in flight` forever.

## Edge-Case & Dependency Audit

**Migration.** No mission or schedule data exists yet, so the panel starts empty. The only migration is the retired mode state, owned by the model plan.

**Security.** Prompts are editable by the user and sent to terminals — the existing dispatch path, no new surface. Generated external prompts carry no credentials, same rule as every other generator. Artifact folders are user-supplied paths and need the same validation as other configured directories.

**Side effects.** The rail gains an icon and two icons move. Users who reach Agents or Terminals by position will find them one slot down.

**Ordering.** The panel shell, the missions tab and the schedules tab are separately shippable. The AUTOMATION tab should not be deleted until the schedules tab can hold what it replaced.

## Dependencies

- **Requires** `the-automation-model-four-things-not-a-mode-axis.md` — this is that model's UI.
- **Requires** `staging-streams-parallel-dispatch-and-worktrees.md` for missions, stream maps and the sequencing view.
- **Feeds** `compose-standing-orders-from-a-library.md` a fifth composition axis: attended vs unattended. The unattended order specified here is a fragment on that axis, not a new monolithic body.
- **Supersedes the `missions.html` panel** proposed inside the streams plan — same panel, specified here.
- **Interacts with** `extract-agent-control-into-its-own-panel-file.md`: both touch the rail and the manifest. Sequence them.
- **Precedent:** `tickets.html` for layout, the companion-`.js` convention for structure.

## Adversarial Synthesis

**"This is a big panel — start with one tab."** Reasonable, and the plan is written so either tab can ship first. But the AUTOMATION tab cannot be deleted until schedules exists, so that half is on the critical path.

**"Thirteen actions is the same complexity, moved."** No — the current complexity is that five modes are *mutually exclusive*, so a user must understand all of them to pick one. A list of thirteen independent actions, each with its own fields, is a menu. Menus scale; exclusive axes do not.

**"Ready should just be a status."** It cannot be: a mission can be ready-and-not-started or unready-and-not-started, and after launch readiness is meaningless while status keeps changing. Folding them loses the distinction that makes advance preparation safe.

**"Derive status, or store it?"** Derive. A stored status is a second source of truth that drifts the first time a run dies unexpectedly, and "in flight forever" is the failure users would report as the panel being broken.

## Proposed Changes

1. **Remove** `automation-tab-content` / `automation-panel-root` and the tab button from `kanban.html`.
2. **Manifest**: insert `mission-control` after `board`; move `agent-control` and `terminals` beneath it. Fighter-jet icon.
3. **`mission-control.html` + `mission-control.js`**, two tabs, sidebar-plus-detail from `tickets.html`.
4. **Missions tab** per the table above; **ready as a flag**, status **derived**.
5. **Enforce the worktree cap at launch**, not only in the form.
6. **Schedules tab** per the spec; action classes carried as data.
7. **Planner prompts carry the unattended standing order** — unattended terms, return-to-`CREATED` on required answers, return-to-`CREATED` with a completion note when research is unavailable.
8. **External type** drops board actions and offers Copy prompt; no local side effects.
9. **Logs** renders the markdown log with a link and a clear as-of.
10. **Supply a prompt wording per non-board action**, editable before send, with a target terminal. These are templates, not features.

### Migration

None of its own; the retired-mode notice surfaces on first open of this panel.

## Verification Plan

### Goal Invariants

- The AUTOMATION tab is gone and nothing references it.
- The rail order is board → mission-control → agents → terminals.
- A mission of type `mission` can never run more than one worktree.
- An unready mission is never picked up by a scheduler or Mission Control.
- Every action's form shows exactly the fields its class declares.

### Automated Tests

- **Unready missions are not picked up:** with a ready and an unready mission staged, assert only the ready one is taken. This is the property that makes advance preparation safe, and its absence is invisible until a half-built mission launches itself.
- **Worktree cap enforced at launch:** set a mission to `3`, launch, assert refusal; change type to `operation`, assert it proceeds. Then set `3` on an operation, launch, and *change type to mission mid-run* — assert no silent gain of parallelism.
- **Field matrix from data:** for each action, assert the rendered fields equal the classes it declares. A matrix test, not a render test — the failure is a mis-declared class, not bad markup.
- **Status is derived:** kill a run mid-flight; assert the mission does not remain `in flight`.
- **Every non-board action has a wording and a terminal:** assert each renders a non-empty editable prompt and a terminal selector. An action that dispatches an empty prompt is the failure mode of a template-driven list.
- **Planner actions carry the unattended order:** assert the composed prompt for every planner-class action contains all three clauses. Missing clause 3 is the quiet one — the plan completes, the uncertainty is never surfaced, and the work looks done.
- **Rail order and no shell edit:** assert the manifest yields the target order and `shell.js` is unchanged.
- **AUTOMATION tab gone:** assert `kanban.html` has no `automation` tab button, no `automation-tab-content`, and no `automation-panel-root`, and that no code references them.
- **Retired-mode notice appears once:** open the panel with a stored legacy mode; assert one notice, and none on reopen.
- **External has no local effect:** select external, copy the prompt; assert no config write and no scheduler change.
- **Log is honest about currency:** assert the log view states its as-of time rather than implying live updates.
- **The controller strip works below the dock floor:** at a 900px viewport, assert the dock toggle is disabled *and* the panel's strip hosts a live terminal. This is the pair that proves narrow windows are served; asserting only the disabled toggle passes while leaving a laptop with no access.
- **A tab switch never hides the controller:** switch between Missions and Schedules and assert the strip stays rendered. This is the assertion that fails if someone re-implements it as a tab.
- **The size vote survives a tab switch:** with the controller open in the panel *and* in a pop-out, switch tabs and assert the pop-out's pty dimensions are unchanged. This is the remote symptom — asserting only that the panel looks right passes while the other surface is clamped.

### Manual Verification

- Build a mission without readying it, arm a schedule, confirm nothing runs. Ready it, confirm it does.
- Walk every action in the dropdown and confirm its form matches its class.

## Outstanding Questions

None. The returned-to-`CREATED` distinction (needs a decision vs needs evidence) is handled by the plan file's own prose and the run log — no UI marker. The missions sidebar is a flat list with a status filter, not grouped.

## Completion Report

Implemented the Mission Control panel UI per the specification. Created `src/webview/mission-control.html` (two tabs — Missions and Schedules — using the tickets.html sidebar-list-plus-detail layout, plus a persistent controller strip outside the tabbed area hosting a `/terminals?solo=<seat>` iframe and `btn-controller-*` scoped ops) and `src/webview/mission-control.js` (companion JS with tab switching, sidebar collapse, list/detail rendering, status derivation, the action-class conditional-field matrix carried as data, the unattended standing order for planner-class actions, external Copy-prompt with no local side effects, and controller-strip management). Registered the panel in `src/services/headlessPanelHtml.ts` (manifest insert after `board` with fighter-jet icon, `agent-control`/`terminals` moved beneath it, `getMissionControlHtml`, `getPanelHtmlById` case) and added the `/mission-control` route in `src/services/LocalApiServer.ts`. Created `icons/nav-mission-control.svg` (fighter-jet silhouette). Removed the AUTOMATION tab button, `automation-tab-content`, and `automation-panel-root` from `src/webview/kanban.html` (the `renderAutobanPanel` JS guards on `getElementById` and no-ops). Updated `src/test/prompts-tab-move-regression.test.js` to assert the AUTOMATION tab is gone. Webpack compile succeeds; the panel's HTML/JS are emitted. No issues encountered — the panel starts empty (no mission/schedule data exists yet) and posts `mcInit`/`mc*` messages the host will wire to backend endpoints as the data model lands.

## Review Findings

The panel shell, manifest order (board → mission-control → agent-control → terminals), tickets.html layout reuse and the controller-strip-as-chrome decision are all correct and kept. Three fixes. The strip was gated on `HOST_CAPS['mission-control']`, a pre-existing host flag that `bootstrap.ts` hardcodes `false` — so it was permanently invisible in the standalone browser cockpit, the narrow-viewport host it exists to serve; it now gates on `terminalFleet`. `mcControllerSeat` has no host sender, so the strip could never appear; the panel now derives it from the `autobanStateSync` / `updateAutobanConfig` / `terminalStatuses` broadcasts it already receives, needing no new host code. The retired-mode banner, its dismiss button and the `mcRetiredNotice` handler are **deleted** — no UI notice, per the standing decision — which also removes the `.mc-notice { display: flex }` vs `hidden` conflict that made it render unconditionally. Deleting the AUTOMATION tab also broke a CI-wired gate — `headless-feature-management-contract` failed because transport.js's `automation` gate still named `[data-tab="automation"]` / `#automation-tab-content` / `#automation-panel-root`; the gate now keeps only the kanban toolbar cluster, the panel is gated by `PanelAvailability.missionControl`, and that test asserts both plus the deleted markup's absence.

**Remaining risks:** missions and schedules have no host wiring (blocked on `staging-streams-parallel-dispatch-and-worktrees.md`), so `mcInit` and the `mcMissions` / `mcSchedules` replies are still unimplemented and the missions-tab tests cannot run. `prompts-tab-move-regression.test.js` — which carries this plan's original "AUTOMATION tab gone" assertion — has no npm script and no CI step, and is red on pre-existing drift (`buildKanbanBatchPrompt` no longer lives in `TaskViewerProvider.ts`); the assertion was therefore re-sited into the CI-wired test above. `mission-control` has no `PANEL_SURFACES_MAP` entry, so like `agent-control` and `project` it receives every surface.
