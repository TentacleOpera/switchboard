# Scope automation to missions: keep the schedule, bound its target

## Goal

Keep the queue schedule and the orchestrator wake exactly as they are, and change only **what they act on**: a mission's finite membership instead of whatever happens to be sitting in a column. Automation gains an end state without losing a trigger.

### Problem Analysis

**Two** automation surfaces ship today, and both are unbounded by construction:

| Surface | Shape | Bound |
|---|---|---|
| `enabled` (`autobanState`) | queue schedule — a clock | none; runs until switched off |
| `orchestratorArmed` + `orchestrationConfig.intervalMinutes` | orchestrator wake interval | none; wakes until disarmed |

**Correction to an earlier revision: this plan retires nothing.** It was first written as a removal of both triggers, on a misreading of "automation queues become mission launches" as "delete open-ended automation". Scheduling survives untouched. The unboundedness never lived in the *trigger* — a clock is fine — it lived in the **target**: "whatever is in the column when it fires". Point the same trigger at a mission and it is bounded, because a mission's membership is explicit and finite. That is a far smaller change than a retirement, and it removes nothing users rely on.

**Second correction: `autobanEnabled` is not an automation surface and must not be touched.** It gates no automation. All 25 references are declarations plus one consumer, and the consumer is presentational: `autobanColumns` (`kanban.html:6164`, `:10299`) filters columns by the flag and feeds `badgeData` (`:10826`, `:10868`) plus a `sourceIdx` for badge ordering. Nothing dispatches or schedules on it. Its distribution — true on `CREATED`, `PLAN REVIEWED`, `LEAD CODED`, `CODER CODED`, `INTERN CODED`; false on `RESEARCHER`, `STAGING`, `CODE REVIEWED`, `TICKET UPDATER`, `COMPLETED` — reads as "columns that have a next automated step", a display property marking pipeline participation rather than a switch. The earlier revision inferred a behaviour from the flag's name; removing it would break column badges and retire nothing.

A clock and a wake have no notion of "done". They act on whatever is in the column when they fire, so the work set is defined by timing rather than by intent. That is the root of the surprise the project has already recorded: `switchboard-manage-console-skill.md` describes invoking the orchestrator as a human and having it *"grouped loose plans into a feature and fired dispatch with no confirmation"* — correct for the machine caller, wrong for a person, and possible only because the trigger was open-ended.

**A mission is the missing bound.** Its membership is finite and explicit, so a mission launch has a definite scope and a definite end: the streams complete, and nothing else was eligible.

**The precedent for this retirement already exists in the codebase.** `automationMode` — an entire exclusive mode axis — was retired the same way (`autobanState.ts:141-146`): *"Every `automationMode` value that has ever shipped. ALL of them are retired … so a shipped install carrying ANY of these must not keep its clock running."* The migration forced the schedule off, required an explicit re-arm, and surfaced a one-time notice (`retiredAutomationModeNotice`, `:135-137`). That is the exact shape this plan needs, including the crucial detail: **a retired trigger is forced off, not silently migrated to the new mechanism.**

### Root Cause

Each automation surface was added to remove a manual step — press a button less often — and a timer is the cheapest way to do that. Nothing forced the question "what is the set of work this applies to?", so the answer stayed implicit: whatever is in the column when the timer fires.

## Metadata

**Complexity:** 3
**Tags:** backend, reliability, ui, devops

## User Review Required

- **The one behaviour change on an armed install:** a fired trigger with no mission does nothing, where today it would act on the column. Nobody loses a feature, but an armed schedule goes quiet until a mission exists. Confirm that is the intended feel, and whether it warrants a one-time notice.
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
- **Do not touch `autobanEnabled` while in the neighbourhood.** It is named as though it were an automation switch and is not (see the correction above). It travels through `_columnsSignature` (`KanbanProvider.ts:4299`) and the webview column definitions, so it will show up in any grep for automation state — and removing it breaks column badges while retiring nothing.

## Edge-Case & Dependency Audit

**Migration.** Much lighter than a retirement. A user with a schedule armed keeps it armed; on the first fire after upgrade there may be no mission yet, so the trigger no-ops instead of sweeping the column. That is a behaviour change on an armed install and wants a one-time notice explaining that automation now runs missions — but nothing is forced off and nothing needs re-arming. Note the contrast with `automationMode`'s retirement (`autobanState.ts:141-146`), which *did* force clocks off; that precedent applies to removals, and this is not one.

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

1. **Keep `enabled`** (queue schedule) and its UI. Its target becomes the open mission rather than the column contents.
2. **Keep `orchestratorArmed` / `orchestrationConfig.intervalMinutes`** and the protocol's `armed` session state. The wake assesses missions rather than columns.
3. **A fired trigger with no mission is a no-op, not a sweep.** Today a clock acts on whatever is in the column; after this, no mission means nothing to do. That single change is what makes automation bounded, and it is the whole plan.
4. **Keep `armQueueWatch`** — bounded and reactive already: one nudge then escalate.
5. **Leave `ScheduledJobsService` standing jobs alone** — user-authored, different axis, and they will surface in any search for scheduled things.
6. **Do not touch `autobanEnabled`** (see correction above).
7. **Retire the AUTOMATION tab's mode machinery, not just its wording.** Enumerated from `createAutobanPanel` (`kanban.html:11568`), missions supersede all of it: the `DRAIN` / `WATCH` / `ON DONE` / `AGENT-MANAGED` modes, `COLUMN RULES`, `QUEUE POP`, `MAX BATCH SIZE`, `COMPLEXITY`, `STARTS WITH` and `WAKE EVERY` — every one answers "how do we pick and pace work out of columns", which a mission answers with explicit membership and a stream map. What remains after that is only the scheduler, which moves to its own panel (`scheduled-jobs-get-their-own-panel.md`). So the tab does not get reworded; it empties, and should then go.

### Migration

Detect on load, force off, notice once. No silent conversion.

## Verification Plan

### Goal Invariants

- No code path dispatches work on a timer or wake interval.
- Every automated dispatch traces to a mission launch with explicit membership.
- An upgraded install with automation armed lands disarmed, with one notice.
- User-authored standing jobs still run.

### Automated Tests

- **A trigger with no mission is a no-op:** arm the schedule with cards in columns and no mission; assert nothing is dispatched. This is the invariant the whole plan rests on — a sweep here is the unbounded behaviour surviving.
- **A trigger with a mission acts only within it:** stage a mission plus loose cards elsewhere; assert only mission members are dispatched.
- **The schedule still works:** assert an armed schedule with an open mission dispatches as it does today. A plan that bounds automation by breaking it has failed.
- **Standing jobs survive:** seed a `.switchboard/instructions/standing/` job with `schedule: daily`; assert it still runs. The boundary this plan must not cross.
- **Queue watch survives:** assert an idle lead with staged cards still gets one nudge and one escalation.
- **Every dispatch has a mission:** assert no automated dispatch path exists that is not reachable from a mission launch.
- **Column badges intact:** assert `autobanColumns` still resolves and badges still render, pinning that the flag was left alone.
- **Notice is once:** re-load twice; assert the notice does not repeat, per the consuming-drain pattern the prior retirement used.

## Outstanding Questions

- **[user]** Should a schedule be able to *launch* a mission, or only advance one already launched? Launching on a timer is closer to today's behaviour; advance-only keeps a person on every start.
- Does anything outside the AUTOMATION tab read `enabled` or `orchestratorArmed` as a general "is automation on" signal? A consumer treating either as a mode flag would silently change behaviour when both disappear.
