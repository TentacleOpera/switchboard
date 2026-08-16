# Orchestrator Persona — One Tick, One Action, No Miscellaneous

## Goal

Rewrite `.agents/skills/switchboard-orchestrator/SKILL.md` for how agent-managed mode actually runs: Switchboard wakes the orchestrator on an interval, it assesses the board, it takes at most one action, and it stops. No kickoff ceremony, no forced grouping, no `Miscellaneous`.

### Why the current persona is wrong for this

**It is a batch manager, not a tick.** Its entry point is *"your first and only system-injected prompt"* — scan the board, group everything into features, sweep the leftovers into `Miscellaneous`, message every lead, then STOP. It ends with *"Do not restart or re-group."* On an interval, wake two has no defined behaviour: a naive implementation either re-runs the kickoff or does nothing forever.

**Its grouping step exists to satisfy a constraint that is being removed.** The `Miscellaneous` sweep is there because per-feature worktrees were forced on it, and a featureless plan had nowhere to be coded (see `worktree-strategy-is-the-users-choice.md`). With the default becoming one checkout, one team at a time, a standalone plan dispatches straight to a team and the sweep has no reason to exist.

**Nothing in it is idempotent or bounded.** It has no rule against acting twice on work already in flight, and no notion of a wake arriving while the previous pass is still running — a reentrancy the event-driven design never had.

## The tick

The orchestrator's whole job is to keep two lanes fed. Each lane has a capacity guard and a dispatch action, and the lanes are **independent** — a busy coding team must never stop a plan reaching a free planner.

**Coding lane**

1. Coding team still working → **wait.**
2. Otherwise, a feature in PLAN REVIEWED → dispatch it to the coding team.

**Planning lane**

3. Planner not available → **wait.**
4. Otherwise, plans in CREATED → dispatch to the planning team or planner.

Assess both lanes on every wake. Waiting is the expected outcome most of the time, not a failure.

### How the guards are answered

Two signals, both of which the orchestrator can read or ask for directly:

1. **Completion reports in the plan files.** A dispatched agent appends a completion summary to its plan file when it finishes (`CODING_COMPLETION_REPORT_DIRECTIVE`; plan files are write-once-at-the-end). The report's presence is the fact.
2. **Ask the lead.** Message it for a status update via `ptySendPrompt` when the files are ambiguous.

**Two things that look like signals and are not:**

- **Column state.** Cards move on coding *start* — the move **is** the dispatch, and they never move on finish (`switchboard-contracts` #1). A card in a coding column means work began, not that it ended.
- **Terminal silence.** A lead is idle most of the time by design: it hands a subtask to a coder and waits. Silence is its normal working state, not a completion.

**What is deliberately not on this list:**

- **Grouping loose plans into features.** It is a judgement about what belongs together, not something a timer should do every ten minutes.
- **Advancing cards.** The coding team's head now owns the advance to CODE REVIEWED through board dispatch (see `coding-team-sends-the-feature-to-review-not-each-subtask.md`). The orchestrator must not also do it, or the two race on the same card.
- **Merge-back**, under the default `none` topology — there is nothing to merge back. It applies only when the user has chosen `per-feature`.

## Context is cleared every tick

Each wake clears the terminal and hands the agent a fresh prompt: the persona, plus `.switchboard/orchestrator/session.md` — the agreed goal and scope, and the log of what has happened. It re-reads the board and git from scratch and decides from that.

**Why cleared rather than continuous.** Every other rule here already says so. "Ground truth over self-report" and "re-derive every wake" are instructions to distrust memory — and a context that has been accumulating since 9pm is precisely a memory competing with the board. A long-lived context also grows without bound across an overnight run, and the compaction that eventually follows can silently drop the session goal, which is the one thing that must survive to 6am.

Clearing makes tick N and tick N+40 identical in construction. It also makes the session recoverable: kill the terminal, restart it, and nothing is lost, because everything that mattered was on disk. The mechanism already exists — `ptySendPrompt` takes `clearBeforePrompt`.

**What this demands in exchange:** anything the next tick needs must be written to the session file when it happens. A dispatch that is not logged is a dispatch the next tick will make again. That is a real constraint, and it is the reason the log is append-only and written at the moment of action rather than at the end of a pass.

## Rules the tick needs and the current persona lacks

- **One dispatch per lane per wake.** A wake may feed both lanes, never the same lane twice.
- **Silent when idle.** A no-op wake writes nothing to the session log. At a ten-minute interval, logging every wake makes the overnight record unreadable — which defeats the log's only purpose. Most wakes are no-ops.
- **A wake arriving mid-pass is dropped, not queued.** Never two passes at once.
- **Re-derive every wake.** Read the plan files and the board fresh; never trust what a previous wake believed. "Still working" is a fact about the world, not a remembered flag.
- **Obey the worktree setting; never write it.** Read it, follow it.

## Rules that carry over unchanged

- Ground truth over self-report — an agent saying "done" is a nudge to verify, never status of record.
- Board ops through the API path only (`move-card.js` → `POST /kanban/move`), never sqlite writes.
- No confirmation gates; it runs unattended. Escalations go to the session log and it moves on.
- Merge-back one feature at a time, abort-eject-escalate on a conflict it cannot resolve coherently — reachable only under `per-feature`.

## Scope widens to planning

The current persona is coding and code review only: *"You never automate planning; planner-stage questions/warnings escalate to the human."* The planning lane above overturns that — dispatching a CREATED plan to a planner is now the orchestrator's job.

What still escalates is unchanged in kind: a **question** it cannot answer, a stalled agent, a conflict it cannot resolve. Feeding the planning lane is routine work; deciding a planner's open question is not.

## Order — land this last

This is **4 of 4** in the orchestration set, and it is the one that consumes everything the other three build:

- `worktree-strategy-is-the-users-choice.md` (1 of 4) — the tick obeys the worktree setting and assumes `none` is the default. Without it, the setting is still being forced out from under the user and "obey it, never write it" describes nothing.
- `automation-tab-three-exclusive-modes.md` (2 of 4) — supplies the interval that produces the wake. Without it there are no ticks to describe.
- `orchestration-starts-as-a-conversation.md` (3 of 4) — writes `session.md` at confirmation. This plan clears context every tick and hands the agent that file; land the persona first and each tick wakes with no goal, no scope and no log.

Landing it early is not merely premature — it replaces a persona that works today with one describing a world that does not exist yet, so orchestration is worse in the interval, not just unchanged.

## Metadata

**Complexity:** 3
**Tags:** docs, refactor, reliability

## Verification Plan

Run agent-managed mode on a real board and watch several wakes:

1. A wake with nothing to do writes nothing and dispatches nothing.
2. A feature in PLAN REVIEWED with a free coding team is dispatched; a wake while that team is still working dispatches nothing to it.
3. Plans in CREATED with a free planner are dispatched; a wake while the planner is busy dispatches nothing to it.
4. **The lanes are independent:** with the coding team busy and the planner free, a CREATED plan is still dispatched.
5. No `Miscellaneous` feature is ever created, and loose plans dispatch without being grouped first.
6. The orchestrator never advances a card to CODE REVIEWED — that advance comes from the coding team's head.
7. An escalated item stays escalated — it is not retried on every wake.
8. The worktree setting is identical before and after a full session.
9. Ten consecutive idle wakes produce a session log with no new entries.
