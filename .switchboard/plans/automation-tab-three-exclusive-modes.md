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

**Oversight as a flag alongside automation is being removed because it earns nothing.** `feature_plan_20260816150001_oversight-stops-being-a-mode.md` landed `orchestrationConfig.enabled` — an agent that watches while the run sheet drives. Watching adds nothing: the run sheet is already mechanical and correct, so a supervisor over it has no decision to make. The orchestrator is only worth running when it *is* the automation — deciding and taking the next action itself. That makes it a mode, and makes it exclusive with the run sheet: two things dispatching the same board is the double-dispatch hazard `isAutomationArmed` exists to guard.

This is a deliberate reversal of 150001, not a misreading of it.

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

**Agent-managed** — a CLI startup command and a wake interval. That is the mode.

The orchestrator is an ordinary agent: a terminal running a CLI with a skill, like a lead or a planner. So the tab configures it the way any agent is configured — which command starts it — and how often Switchboard wakes it. There is no bespoke orchestrator machinery to expose, and the tab does not enumerate the actions it may take; that is the persona's job.

Pressing Start here does not begin orchestration. It brings the agent up for a pre-flight conversation, and the session begins only when the user answers in the terminal — see `orchestration-starts-as-a-conversation.md`.

**Scheduled** — an interval, and the run-sheet rules that genuinely differ per install.

**External** — the copy button and the evergreen prompt, unchanged from what ships today.

## Controls being deleted

Say the word if any of these earn their place — they are gone otherwise:

- The **scheduler** in its entirety — UI and persistence both. Source picker, target picker, per-job interval, per-job START/STOP, per-job COPY PROMPT, the target-contract round-trip, and the stored job records. This is the second clock, and it has never been released, so it goes without a trace.
- `KANBAN AUTOMATION RULES` as a section. Whatever inside it is still real moves into Scheduled's small set; the box goes.
- `OVERSIGHT AGENT` as a section. It becomes the Agent-managed mode.
- The toolbar's separate arming path as a second way in. One ON/OFF, on the tab.

## Data

`automationMode` becomes `'agent-managed' | 'scheduled' | 'external'`. It is shipped state, so retarget the mapping that `normalizeAutomationMode` already performs — one function, one fall-through, no new migration machinery:

| Persisted | Becomes |
| :--- | :--- |
| `internal`, `run-sheet`, `scheduler`, `single-column` | `scheduled` |
| `orchestration` | `agent-managed` |
| `external` | `external` |
| unrecognised | `scheduled` — keeps the board ticking, as today |

**The scheduler is deleted outright — it has never left the source tree.** No migration, no checkboxes, no drop-on-read, no preserved job records, no `integration-config.json` handling. Per the repo's own rule, unreleased work takes a clean break. Delete the job list, the source and target pickers, the per-job intervals and START/STOP, the target-contract round-trip, and the persistence behind them.

**`orchestrationConfig.enabled` is deleted, not migrated.** It landed days ago in 150001 and never shipped, so nothing on disk needs carrying across. `orchestrationConfig` keeps one field: the wake interval.

Agent-managed needs that wake interval, which does not exist yet — `normalizeOrchestrationConfig` carries only `enabled`. Replace it with `intervalMinutes`, defaulting to the run sheet's current default.

## Order — second of four

Land `worktree-strategy-is-the-users-choice.md` first. It removes `applyOversightWorktreeTopology`, which fires on the `orchestrationConfig.enabled` false→true transition — the very field this plan deletes. Delete the field while that caller still exists and the topology machinery is left reaching for state that is gone.

`orchestration-starts-as-a-conversation.md` and `orchestrator-persona-becomes-a-tick.md` both follow this plan, since neither has anywhere to live until agent-managed mode exists.

## Metadata

**Complexity:** 6
**Tags:** ui, ux, refactor, backend

## Verification Plan

1. Open AUTOMATION: three radio options, one interval, one ON/OFF, one status line. No job rows, no second START anywhere on the page.
2. Pick Agent-managed, set 10 minutes, turn it on — the orchestrator wakes on the interval and takes an action; the status line names what it did.
3. Pick Scheduled, turn it on — the run sheet advances cards on the interval; the orchestrator is not running.
4. Switching between the two does not leave both live — count installed timers, not just UI state.
5. Pick External — no timer is installed, no scheduled job runs, COPY PROMPT yields a prompt that builds against an empty board.
6. An install persisted as `orchestration` opens on Agent-managed; one persisted as `internal` or `single-column` opens on Scheduled.
7. Nothing in the tree still references the scheduler job surface — no orphaned verbs, no dead message handlers, no `getSchedulerTargetContracts` round-trip.
