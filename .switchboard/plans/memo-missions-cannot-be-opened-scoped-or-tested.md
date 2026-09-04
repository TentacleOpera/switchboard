# A Mission Cannot Be Opened, Its Launch Is Not Scoped To It, and Nothing Tests the Mechanism

## Goal

The mission mechanism on the board — the card, its drag, its launch — must be reachable, correctly scoped, affordable to render, and covered by something that actually exercises it.

### Problem analysis

Six reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. They cover the board-facing half of missions, which the active *Mission Control* feature does not: that feature holds the ready flag and the supervision wake, both of which assume a mission you can already open and launch.

## Metadata

- **Complexity:** 5
- **Tags:** missions, kanban, testing, bugfix

## User Review Required

Change 1 is a small author decision. The rest are defects.

## Proposed Changes

### 1. Clicking a mission card opens the wrong panel **[decision]**

`kanban.html:9809` and `:10201` both post `openSetupPanel` with `section: 'mission-control'`, for the card click and the cross-column drag. `grep MissionControl src/generated/verbAllowlist.ts` returns nothing — **there is no verb that opens Mission Control**, so both gestures land on Setup.

Decide between adding the verb and giving Mission Control its own panel identity.

### 2. `launchMission` pops workspace-wide, so mission A can dispatch mission B's card

`KanbanProvider.ts:15171` calls `apiServer.dispatchNextFromQueue({ workspaceRoot, from: head })`. The mission's member list is used only to count streams; it never scopes the pop.

Launching one mission can therefore start work belonging to another. Scope the pop to the mission's members.

### 3. `getMissions` is an unbounded cost on every board refresh

`KanbanDatabase.getMissions` (`:11488`) loops `getMissionMembers` and then `_hydrateDerivedMissionFields`, which walks `getPlanByPlanId` and `getPlanDependencies` per member. `KanbanProvider` calls it from three board-refresh sites (`:1412`, `:2389`, `:4036`).

Every refresh pays members × dependencies per mission. This compounds with the board's existing render cost — see *The Board Renders Every Card It Has Ever Held*, which this should be measured alongside rather than in isolation.

Add a board-only mission query that returns what the board draws.

### 4. The drop rule contradicts its own verification, and nothing tests either

The originating plan states "empty space creates a new mission" at `:336` and `:563`, and a manual step at `:626` requiring "four cards → ONE mission with four members". Its own review note at `:654` records the contradiction. The code follows the manual step.

Restate the rule first — that is the precondition for testing it — and then test it, because today the only mission test file is `mission-control-tick-and-reports-contract.test.js`, whose four concerns are persona coherence, a skill sweep, relocated verb-rail facts and the reports channel. **None touches the board mechanism.** Every gate covering the STAGING card, its drag and its launch is source text.

### 5. The question and status report channel writes to a dead path

The head prompt and two skill/workflow documents point agents at `.switchboard/orchestrator/reports/`, while the writer and reader use `mission-control/reports/`. `bootstrapMissionControlReportsDirectory`'s legacy adopt is gated by `_legacyMissionControlMigrated`, a once-per-process flag, so anything written to the old path **after** the first bootstrap is never merged.

Three text edits, plus a decision on whether the adopt should re-run rather than run once.

## Verification Plan

1. Clicking a mission card opens Mission Control, not Setup. The same for a cross-column drag.
2. Launching a mission with two other missions queued dispatches only its own members' cards.
3. A board refresh on a board with several missions issues one bounded query; the per-member dependency walk is gone from the refresh path.
4. The drop rule is stated once, consistently, and a runtime test exercises the STAGING card, its drag and its launch — not the source text of the file that implements them.
5. An agent following the head prompt writes a report the reader finds, on a second and subsequent bootstrap as well as the first.
