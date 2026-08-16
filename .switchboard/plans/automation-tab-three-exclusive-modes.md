# AUTOMATION Tab — Three Exclusive Modes, and Almost No Other Controls

## Goal

You open AUTOMATION, pick one of three modes, set one interval, and turn it on. That is the tab.

| Mode | What Switchboard does |
| :--- | :--- |
| **Agent-managed** | Wakes the orchestrator agent every N minutes to decide and take the next action — dispatch a card to a team, group loose plans into a feature, or nothing. Judgement lives in the agent. |
| **Scheduled** | Applies the run sheet every N minutes. Mechanical, no agent deciding. |
| **External** | Emits a copyable prompt for a tool that runs its own cron. Switchboard runs no clock and dispatches nothing. |

Exactly one is active. The whole tab is a three-way choice, an interval, an on/off, and a line saying what just happened.

### Why the tab is wrong now

**It has three sections because it was built by three plans, not designed as a tab.** In internal mode you get `COLUMN RULES`, `KANBAN AUTOMATION RULES`, and `SCHEDULER` stacked as peers, with `OVERSIGHT AGENT` hanging below the mode branch entirely. The first two configure the same engine and their names don't distinguish them.

**There are two clocks and three start affordances on one screen.** The run sheet arms from the toolbar; every scheduler job row carries its own START/STOP and its own interval; external offers COPY PROMPT. Nothing says which one is "the automation."

**The scheduler and the run sheet are the same feature wearing different clothes.** Both are "every N minutes, do a thing to the board." They were built separately, so they got separate UI, separate persistence, separate arming. Merging them removes a whole surface rather than reorganising it.

**Oversight was modelled as a flag alongside automation** (`feature_plan_20260816150001_oversight-stops-being-a-mode.md`, shipped — `orchestrationConfig.enabled`). The correct model is that an orchestrator deciding the next action and a run sheet mechanically applying rules are *alternatives*. You run one or the other, never both — two things dispatching the same board is the double-dispatch hazard `isAutomationArmed` already exists to guard.

## The tab

```
AUTOMATION                                    [ OFF ]

  ( ) Agent-managed   Wake the orchestrator every [ 10 ] min to
                      decide the next action.

  (•) Scheduled       Apply the run sheet every [ 10 ] min.

  ( ) External        Switchboard runs no clock.   [ COPY PROMPT ]

  Last pass 3m ago — moved "Fix reviewer routing" to CODED.
  Next in 7m.
```

Selecting a mode reveals only that mode's controls. The status line is one sentence and always present — an armed automation that has done nothing yet says so.

## What each mode carries

**Agent-managed** — a wake interval, nothing else. On each wake Switchboard prompts the orchestrator to assess the board and take the next action. Which action is the agent's call; the tab does not enumerate them.

**Scheduled** — an interval, and the run-sheet rules that genuinely differ per install. Two checkboxes absorb the surviving scheduler jobs (below).

**External** — the copy button and the evergreen prompt, unchanged from what ships today.

## Controls being deleted

Say the word if any of these earn their place — they are gone otherwise:

- The **scheduler job list** in its entirety: source picker, target picker, per-job interval, per-job START/STOP, per-job COPY PROMPT, and the target-contract message round-trip. This is the second clock.
- `KANBAN AUTOMATION RULES` as a section. Whatever inside it is still real moves into Scheduled's small set; the box goes.
- `OVERSIGHT AGENT` as a section. It becomes the Agent-managed mode.
- The toolbar's separate arming path as a second way in. One ON/OFF, on the tab.

## Data

`automationMode` becomes `'agent-managed' | 'scheduled' | 'external'`. Shipped state on ~4,000 installs, so every retired value maps rather than falls through:

| Persisted | Becomes | Why |
| :--- | :--- | :--- |
| `internal`, `run-sheet`, `scheduler`, `single-column` | `scheduled` | All were Switchboard running the run sheet on its own clock. |
| `external` | `external` | Unchanged. |
| `orchestration` | `agent-managed` | Restores the original intent, which 150001 had mapped to `internal` + a flag. |
| anything with `orchestrationConfig.enabled === true` | `agent-managed` | The 150001 round-trip: that flag is how an orchestration install was recorded after the earlier migration. Read it once, then stop treating it as an arming flag. |
| unrecognised | `scheduled` | Safe default — keeps the board ticking, matching today's fall-through. |

Keep the `orchestrationConfig` key in the persisted blob rather than scrubbing it; per the repo's migration rule an inert legacy key is preserved, not dropped.

Persisted scheduler jobs, which are live configuration on real installs:

- `fetch-plans` and `reconcile` become two checkboxes inside Scheduled, running on the one clock. Interval preserved only insofar as the run sheet's interval now governs them; their own intervals are dropped.
- `custom` — an arbitrary prompt on a timer — has no home in a run-sheet model. Dropped on read, following the `comms` precedent: no flag, no disabled-but-present option, no bespoke rewrite pass over `integration-config.json`.
- A migrated job arrives **off**. Its arming is yours.

Agent-managed needs a wake interval, which `orchestrationConfig` does not currently have (`normalizeOrchestrationConfig` carries only `enabled`). Add `intervalMinutes`, defaulting to the run sheet's current default so a migrated orchestration install wakes on a familiar cadence.

## Metadata

**Complexity:** 6
**Tags:** ui, ux, refactor, backend

## Verification Plan

1. Open AUTOMATION: three radio options, one interval, one ON/OFF, one status line. No job rows, no second START anywhere on the page.
2. Pick Agent-managed, set 10 minutes, turn it on — the orchestrator wakes on the interval and takes an action; the status line names what it did.
3. Pick Scheduled, turn it on — the run sheet advances cards on the interval; the orchestrator is not running.
4. Switching between the two does not leave both live — count installed timers, not just UI state.
5. Pick External — no timer is installed, no scheduled job runs, COPY PROMPT yields a prompt that builds against an empty board.
6. An install persisted as `orchestration` opens on Agent-managed. An install persisted as `internal` with `orchestrationConfig.enabled = true` also opens on Agent-managed.
7. An install with a persisted `fetch-plans` job opens on Scheduled with that checkbox present and off, and nothing running until armed.
8. An install with a persisted `custom` job loses it without an error, and `integration-config.json` is otherwise byte-intact.
