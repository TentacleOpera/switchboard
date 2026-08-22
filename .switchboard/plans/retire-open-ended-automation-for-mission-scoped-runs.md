# Retire open-ended automation in favour of mission-scoped runs

## Goal

Replace every unbounded automation surface — a queue-schedule clock, an orchestrator wake interval, and per-column auto-advance — with runs scoped to a mission's finite membership, so automation always has an end state and nothing runs against work the user did not put in a mission.

### Problem Analysis

Three automation surfaces ship today, and all three are unbounded by construction:

| Surface | Shape | Bound |
|---|---|---|
| `enabled` (`autobanState`) | queue schedule — a clock | none; runs until switched off |
| `orchestratorArmed` + `orchestrationConfig.intervalMinutes` | orchestrator wake interval | none; wakes until disarmed |
| `autobanEnabled` per column (`agentConfig.ts:150`) | auto-advance on a column, **on by default for `CREATED`** | none; applies to whatever lands there |

A clock and a wake have no notion of "done". They act on whatever is in the column when they fire, so the work set is defined by timing rather than by intent. That is the root of the surprise the project has already recorded: `switchboard-manage-console-skill.md` describes invoking the orchestrator as a human and having it *"grouped loose plans into a feature and fired dispatch with no confirmation"* — correct for the machine caller, wrong for a person, and possible only because the trigger was open-ended.

**A mission is the missing bound.** Its membership is finite and explicit, so a mission launch has a definite scope and a definite end: the streams complete, and nothing else was eligible.

**The precedent for this retirement already exists in the codebase.** `automationMode` — an entire exclusive mode axis — was retired the same way (`autobanState.ts:141-146`): *"Every `automationMode` value that has ever shipped. ALL of them are retired … so a shipped install carrying ANY of these must not keep its clock running."* The migration forced the schedule off, required an explicit re-arm, and surfaced a one-time notice (`retiredAutomationModeNotice`, `:135-137`). That is the exact shape this plan needs, including the crucial detail: **a retired trigger is forced off, not silently migrated to the new mechanism.**

### Root Cause

Each automation surface was added to remove a manual step — press a button less often — and a timer is the cheapest way to do that. Nothing forced the question "what is the set of work this applies to?", so the answer stayed implicit: whatever is in the column when the timer fires.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, ui, devops

## User Review Required

- **This removes shipped functionality from ~4,000 installs.** Anyone running a queue schedule or an armed orchestrator loses it and must build a mission instead. That is the intent — "no open-ended automation" — but it is a product decision, not a refactor, and it needs your explicit confirmation before anything is deleted.
- **`autobanEnabled` on `CREATED` is on by default** (`agentConfig.ts:150`), so this is not only opt-in behaviour being removed. Does auto-advance on `CREATED` survive as a special case (new plans get triaged automatically) or go with the rest?
- **What replaces a genuinely recurring need?** A nightly sweep of new plans is a real want and a mission is one-shot. Options: a scheduled *mission creation* (the schedule builds a mission and stops, leaving the launch to a person), or nothing. The first keeps the bound; recommending it if any recurrence survives at all.

## Complexity Audit

### Routine

- Removing the two switches and their UI, and the per-column flag.
- A forced-off migration with a one-time notice, following `retiredAutomationModeNotice`'s pattern.

### Complex / Risky

- **Force off; never auto-convert.** A shipped install with an armed orchestrator must land disarmed, with a notice — not with a mission silently synthesised from whatever was in its columns. Auto-conversion would launch work the user never scoped, which is the failure this plan exists to prevent, delivered by the fix.
- **`ScheduledJobsService` and standing jobs are a separate axis and must not be swept up.** `.switchboard/instructions/standing/` job definitions carry `schedule: <daily|hourly|...>` frontmatter, and those are *user-authored* jobs, not Switchboard automation. This plan retires Switchboard's own unbounded triggers; it must not silently disable a user's standing job. The boundary needs stating precisely, because both are "scheduled things".
- **The orchestrator's `armed` session state is defined in the protocol** (`switchboard-orchestrator/SKILL.md:249-250`) as one of two session states — *"`armed` — multi-team coordination with a wake interval installed on `orchestrationConfig`"*. Retiring the wake removes a documented state, so the protocol changes with the code, or agents read a contract the system no longer honours.
- **The queue watch is not the same thing as a schedule and should survive.** `armQueueWatch` sends *one* nudge when a lead goes idle with cards staged, then escalates once and stops (`:245`). It is bounded and reactive, not a clock. Deleting it along with the schedule would remove the backstop that stops a stalled queue sitting silently.
- **`autobanEnabled` is per-column config with a default**, so removing it changes `agentConfig`'s shape and every place that reads a column definition. Check `_columnsSignature` (`KanbanProvider.ts:4299`) and the webview column rendering, which both carry the flag.

## Edge-Case & Dependency Audit

**Migration.** Forced-off, one-time notice, explicit re-arm impossible (there is nothing to re-arm — the replacement is a mission). Follow `retiredAutomationModeNotice` exactly: detect the retired state on load, force the clock off, surface the notice once. Never carry a running clock across the upgrade.

**Security.** Net positive: fewer unattended paths that dispatch work without a person in the loop.

**Side effects.** The AUTOMATION tab loses most of its controls. Whatever remains should say plainly that automation is now mission-scoped, or the tab reads as broken.

**Ordering.** Requires missions to exist and be launchable first — otherwise this removes automation and leaves nothing in its place.

## Dependencies

- **Requires** `staging-streams-parallel-dispatch-and-worktrees.md` (mission cards, the missions panel, launch).
- **Resolves** the surprise recorded in `switchboard-manage-console-skill.md`: with no open-ended trigger, invoking a persona cannot silently start batch work.
- **Adjacent, do not conflate:** `ScheduledJobsService` standing jobs are user-authored and out of scope.

## Adversarial Synthesis

**"Unattended automation is the product — this removes the reason people use it."** It removes *unbounded* automation. A mission launch is still unattended once started: N teams work N streams to completion with nobody watching. What goes is the clock that decides *when* and *what* on its own. The user picks the work; the machine still does it.

**"Then just add a confirmation to the existing triggers."** A confirmation on a recurring clock is worse than either option — it fires at an arbitrary time and demands attention, which is precisely what a schedule was meant to avoid. And plain confirm gates are banned by project rule anyway.

**"Keep the schedule but scope it to a project or column."** A column is still "whatever is in it when the timer fires". A project is a filter, not a work set. The bound has to be an explicit membership list, which is what a mission is.

**"This is a lot of deletion for a design principle."** The principle has already cost the project once — a live session where dispatch fired unasked. And the deletion is small: two switches, one per-column flag, and a migration whose shape is already written.

## Proposed Changes

1. **Retire `enabled`** (queue-schedule clock) and its UI.
2. **Retire `orchestratorArmed` / `orchestrationConfig.intervalMinutes`**, and update `switchboard-orchestrator/SKILL.md` to drop `armed` as a session state.
3. **Retire `autobanEnabled` per column**, pending the `CREATED` decision above.
4. **Forced-off migration with a one-time notice**, following `retiredAutomationModeNotice` (`autobanState.ts:135-137`). Never auto-convert a running clock into a mission.
5. **Keep `armQueueWatch`** — bounded, reactive, one nudge then escalate.
6. **Leave `ScheduledJobsService` standing jobs alone**, and say so where a reader would otherwise assume otherwise.
7. **Restate the AUTOMATION tab** around mission-scoped runs so the remaining surface is legible.

### Migration

Detect on load, force off, notice once. No silent conversion.

## Verification Plan

### Goal Invariants

- No code path dispatches work on a timer or wake interval.
- Every automated dispatch traces to a mission launch with explicit membership.
- An upgraded install with automation armed lands disarmed, with one notice.
- User-authored standing jobs still run.

### Automated Tests

- **No clock remains:** assert no interval or wake schedules a dispatch. The invariant the whole plan rests on, and the one a partial deletion would leave silently violated.
- **Forced off, not converted:** seed a state with `enabled` and `orchestratorArmed` set; assert both land off, a notice is surfaced exactly once, and **no mission was created**. The second half matters more than the first — an auto-conversion would look like a smooth upgrade while launching unscoped work.
- **Standing jobs survive:** seed a `.switchboard/instructions/standing/` job with `schedule: daily`; assert it still runs. The boundary this plan must not cross.
- **Queue watch survives:** assert an idle lead with staged cards still gets one nudge and one escalation.
- **Every dispatch has a mission:** assert no automated dispatch path exists that is not reachable from a mission launch.
- **Notice is once:** re-load twice; assert the notice does not repeat, per the consuming-drain pattern the prior retirement used.

## Outstanding Questions

- **[user]** Confirm removal of shipped automation from ~4,000 installs.
- **[user]** Does `autobanEnabled` on `CREATED` survive as a triage special case?
- **[user]** Does any recurrence survive as *scheduled mission creation* (build a mission, stop, leave the launch to a person)?
- Does anything outside the AUTOMATION tab read `enabled` or `orchestratorArmed` as a general "is automation on" signal? A consumer treating either as a mode flag would silently change behaviour when both disappear.
