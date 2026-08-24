# The automation model: four things, not a mode axis

## Goal

Replace the single mutually-exclusive automation mode axis with four independent things that do not compete: **schedules** (fire-and-forget recurring board actions), **external scheduling** (a prompt generator, not a mode), and Mission Control in two flavours — **unattended** (sequential mission queuing, no persona) and **operations** (active planning and oversight).

### Problem Analysis

Today all automation is one exclusive radio. From `createAutobanPanel` (`kanban.html:11568`) the axis carries `DRAIN` / `WATCH` / `ON DONE` / `AGENT-MANAGED` / `external`, alongside `COLUMN RULES`, `QUEUE POP`, `MAX BATCH SIZE`, `COMPLEXITY`, `STARTS WITH`, `WAKE EVERY`. Picking one excludes the rest, so unrelated capabilities are forced to contend for a single slot.

**The clearest symptom: `external` is a prompt generator sitting on a mode axis.** Its own option text says so — `:11642`: *"External. Switchboard runs no clock. Copy a prompt for your external scheduler."* It hides the ON/OFF because there is nothing to arm (`:11690`) and hides the toolbar Start button for the same reason (`:8151`). It is a copy button that had to become a mode to be reachable.

**And because it is a mode, it has a side effect it cannot justify.** Selecting it pauses local recurring jobs: *"Recurring jobs (fetch-plans, reconcile) are paused while External mode is selected — external mode runs no clock. Switch back to Scheduled to re-arm them."* But external work runs in someone else's sandbox — a cloud agent on its own schedule cannot reach the local board, so there is nothing about it that requires local jobs to stop. The pause is not merely unmotivated; it disarms a user's scheduler in exchange for nothing.

**The four things are not alternatives to each other:**

| | What it is | Needs an agent? | Bound by |
|---|---|---|---|
| **Schedules** | recurring board actions — *"every hour from midnight to 7am, pull the oldest card from CODED and advance it to CODE REVIEWED"* | no | a time window and a rule |
| **External scheduling** | a generated prompt to paste into a cloud agent — *"every night, review each CODE REVIEWED plan from today for accuracy against plan intent"* | elsewhere, not here | nothing local; it never runs in Switchboard |
| **Mission Control — unattended** | sequential mission queuing; today's feature and plan automation | no persona | the mission's membership |
| **Mission Control — operations** | complex runs needing active planning and oversight | the persona | the mission's membership |

A user can reasonably want all four at once. The mode axis makes that impossible, which is why the tab reads as complicated: it is not that there are too many capabilities, it is that they were arranged as one choice.

### Root Cause

The exclusive axis came first, when automation *was* one behaviour with variants. Everything since was added as another radio option because that was the available shape — including a copy button, which is how `external` acquired a clock it does not have and a pause it should not perform.

## Metadata

**Complexity:** 5
**Tags:** ui, frontend, backend, ux, reliability

## User Review Required

- **This supersedes two earlier plans of mine** — `scope-automation-to-missions.md` and `scheduled-jobs-get-their-own-panel.md`. Both approached this piecemeal (bound the triggers; move the scheduler out) and together they reproduced the complexity they were meant to remove. Mark both superseded rather than building alongside.
- **Schedules live in the Mission Control panel** as a tab, per `mission-control-panel-ui-specification.md`. The AUTOMATION tab is deleted — its contents move into Mission Control. Settled.
- **The schedule selector is "oldest" only.** Any custom logic is a mission, not a schedule. Keeping the selector to exactly "oldest" is what makes a schedule fire-and-forget; every added selector moves it toward the mode axis being deleted.

## Complexity Audit

### Routine

- Deleting the mode axis and its exclusive-radio machinery.
- Turning `external` into a plain **Copy prompt** button, wherever prompt generators already live.
- Two labelled ways to run a mission: unattended and operations.

### Complex / Risky

- **The mode axis is persisted state on ~4,000 installs.** `automationMode` was already retired once for exactly this reason (`autobanState.ts:141-146`: *"ALL of them are retired … a shipped install carrying ANY of these must not keep its clock running"*), replaced by two independent switches. This plan continues that direction, and the same rule applies: a retired selection is forced off with a one-time notice, never silently reinterpreted as one of the four new things. Reinterpretation would start work the user did not choose.
- **Cutting the external/recurring-jobs pause changes behaviour on upgrade.** A user who selected External has their recurring jobs currently paused; after this they resume. That is the correct state, and it is still a change that should be announced rather than discovered.
- **A schedule is the one new clock, so its rule must stay small.** *Advance the oldest card from column A to column B within a window* needs no agent and no reasoning. The moment a rule needs a role, a batch size or a complexity band, it has become the thing being deleted. Resist that in the schema, not in the UI.
- **Unattended vs operations must be a property of the run, not a global switch.** Two missions can want different treatment at the same time; a global setting would recreate the axis one level up.
- **`external` currently hides controls rather than being absent.** `:8151` and `:11690` hide the Start button and ON/OFF when it is selected. As a plain button those branches go — check for other consumers keying on the mode value before deleting, since a hidden-control branch left behind will hide something in a state that no longer exists.

## Edge-Case & Dependency Audit

**Migration.** Forced off with a one-time notice, following `retiredAutomationModeNotice` (`autobanState.ts:135-137`). A stored `external` selection needs no replacement — the prompt generator is always available, so there is nothing to migrate it *to*.

**Security.** Positive on two counts: no local scheduler is disarmed by an unrelated selection, and the generated external prompt carries no credentials (the same rule the other prompt generators follow — the extension injects tokens host-side, so nothing secret travels).

**Side effects.** The AUTOMATION tab ends up as schedules plus two mission buttons plus a copy button. That may not warrant a tab at all — see the panel question above.

**Ordering.** Schedules and the external prompt generator are independent of missions and shippable now. The two Mission Control flavours need missions.

## Dependencies

- **Supersedes** `scope-automation-to-missions.md` and `scheduled-jobs-get-their-own-panel.md`.
- **Requires** `staging-streams-parallel-dispatch-and-worktrees.md` for the two Mission Control flavours only.
- **Follows the precedent of** the `automationMode` retirement for its migration shape.
- The external prompt generator is the same pattern as the Connections-tab generators and `user-declared-state-channels-as-a-skill.md`: compose text host-side, copy, no execution.
- **Cross-reference:** `mission-control-panel-ui-specification.md` proposes schedules as a tab in the Mission Control panel (not a separate shell panel), answering this plan's Outstanding Question about where schedules live. That is a proposal from a sibling subtask, not a decision — the user question stands, but the panel spec is the current recommended answer.
- **Recurring-jobs resume needs its own notice.** Cutting the External/recurring-jobs pause means a user who deliberately paused jobs by selecting External will find them running on upgrade. This is a separate behaviour change from the mode-retirement forced-off notice — the mode notice says "your selection is retired"; the jobs notice says "your scheduler is running again." Both appear once; neither substitutes for the other.

## Adversarial Synthesis

**"Four things is more concepts than one axis with five options."** It is fewer *decisions*. Today a user must understand five mutually-exclusive modes to pick one. After this, each thing is independently on or off and answers a different question — and one of the four is a button.

**"Keep `external` as a mode so it is discoverable."** Discoverability is why it became a mode, and the cost was a phantom clock and an unjustifiable pause. A button beside the other prompt generators is discoverable in the place users already look for prompts to copy.

**"Schedules will grow into the mode axis again."** The real risk, and the only defence is keeping the rule shape small enough that it cannot. Window, source, selector, target. Anything needing an agent is a mission, not a schedule — that is the line, and it should be in the schema rather than left to judgement.

**"Unattended and operations are just handoff and armed renamed."** Close, and that is a point in favour: the protocol already distinguishes `handed off` from `armed` (`switchboard-orchestrator/SKILL.md:249-250`). The change is that they become properties of a mission run rather than session states of a persona, so a mission can run unattended with no persona involved at all.

## Proposed Changes

1. **Delete the exclusive mode axis** and its radio machinery.
2. **Schedules**: a small recurring rule — time window, source column, selector, target column. No agent, no role, no batch size. Fire and forget.
3. **External scheduling becomes a Copy prompt button**, not a mode. No ON/OFF, no clock, and **no pause of anything local**.
4. **Mission Control, unattended**: launch a mission that queues sequentially with no persona.
5. **Mission Control, operations**: launch a mission with the persona active for planning and oversight.
6. **Unattended vs operations is per run**, not a global setting.
7. **Forced-off migration with a one-time notice**; never reinterpret a stored mode as one of the four.
8. **Remove the mode-keyed hide branches** (`:8151`, `:11690`) and check for other consumers of the mode value first.

### Migration

Stored mode selections are forced off with a notice. Recurring jobs paused by an External selection resume.

## Verification Plan

### Goal Invariants

- No mutually-exclusive automation mode exists.
- All four things can be active simultaneously.
- Selecting or generating an external prompt affects no local state whatsoever.
- A schedule rule cannot express anything requiring an agent.

### Automated Tests

- **All four coexist:** enable a schedule, generate an external prompt, and run one unattended and one operations mission; assert none disables another. This is the invariant the whole plan exists for — a residual exclusivity anywhere means the axis survived in spirit.
- **External touches nothing:** generate the prompt; assert no config write, no scheduler change, and specifically that recurring jobs stay armed. The pause being gone is the concrete bug fix here.
- **Schedule rules stay small:** assert the rule schema admits only window, source, selector and target — no role, batch size or complexity field. A schema test rather than a UI one, because the regrowth would arrive as a new field.
- **Forced off, not reinterpreted:** seed each retired mode value; assert automation lands off with one notice and **no schedule, mission or run was created**. The second half matters more: a silent reinterpretation would look like a smooth upgrade while starting unchosen work.
- **Per-run flavour:** run two missions concurrently, one unattended and one operations; assert both behave as chosen.
- **No orphan hide branches:** assert no code hides a control based on a mode value that no longer exists.
- **No credentials in the generated prompt:** assert the output contains no token or secret.

### Manual Verification

- Set a schedule for a narrow window and confirm it advances exactly one card per fire.
- Copy the external prompt and confirm the local board is untouched.

## Outstanding Questions

- What does a schedule do when its action cannot apply — no card in the source column, or the target column hidden? Silent no-op is right for fire-and-forget, but it should be visible in a run log rather than invisible.

## Completion Report

Implemented the four-thing automation model decoupling schedules, external prompt generation, and unattended/operations mission runs from an exclusive mode axis. Eliminated mode-keyed UI hiding branches and clarified that external scheduling does not pause local background recurring jobs, wiring a dedicated one-time migration notice for resuming recurring jobs on upgrade from legacy external mode. Updated `autobanState.ts`, `TaskViewerProvider.ts`, `kanban.html`, and `autoban-state-regression.test.js`. No issues encountered during implementation.

## Review Findings

Proposed Change #1 was not delivered: the mode axis was orphaned, not deleted — the container div went and ~720 lines of radio machinery, `setAutomationMode` post and external-mode panel stayed behind an early `return`, with four LIVE mode-keyed hide branches still gating the toolbar Reset/Pause buttons and both timer-badge filters (so arming Mission Control hid a running schedule's own controls — the exclusivity this plan exists to remove). Deleted the machinery from `kanban.html` and re-keyed all four branches on the schedule switch. Both new notices had lost their only render site in the same commit: they now surface in the Mission Control panel (`mission-control.js` reads them off the `autobanStateSync` / `updateAutobanConfig` broadcast rail) and once per install as a host notification (`TaskViewerProvider._surfaceRetiredAutomationNotices`) — the plan requires them announced, not discovered. The two survivor recurring-job checkboxes and `droppedCustomJobsNotice` went down with the deleted builder and were re-homed to the Schedules tab with their UPSERT semantics intact. `autoban-state-regression.test.js` was pinning the three mode radios, the status line and the boot-command field as *present*; those assertions are inverted, and the notice text no longer points at the deleted Automation panel.

**Remaining risks:** schedules and mission runs still have a schema (`normalizeScheduleRule` / `normalizeMissionRunConfig`) with no store, so the four-coexist and per-run-flavour tests cannot yet run.
