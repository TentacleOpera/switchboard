# Orchestrator Persona — One Tick, One Action, No Miscellaneous

## Goal

Rewrite `.agents/skills/switchboard-orchestrator/SKILL.md` for how agent-managed mode actually runs: Switchboard wakes the orchestrator on an interval, it assesses the board, it takes at most one action, and it stops. No kickoff ceremony, no forced grouping, no `Miscellaneous`.

### Why the current persona is wrong for this

**It is a batch manager, not a tick.** Its entry point is *"your first and only system-injected prompt"* — scan the board, group everything into features, sweep the leftovers into `Miscellaneous`, message every lead, then STOP. It ends with *"Do not restart or re-group."* On an interval, wake two has no defined behaviour: a naive implementation either re-runs the kickoff or does nothing forever.

**Its grouping step exists to satisfy a constraint that is being removed.** The `Miscellaneous` sweep is there because per-feature worktrees were forced on it, and a featureless plan had nowhere to be coded (see `worktree-strategy-is-the-users-choice.md`). With the default becoming one checkout, one team at a time, a standalone plan dispatches straight to a team and the sweep has no reason to exist.

**Nothing in it is idempotent or bounded.** It has no rule against acting twice on work already in flight, and no notion of a wake arriving while the previous pass is still running — a reentrancy the event-driven design never had.

## The tick

On each wake, assess, take **the first** thing that applies, then stop:

1. Something already escalated and unresolved → do nothing. Never retry an escalation on a timer.
2. A feature or plan whose work is verified complete and merged → close it out.
3. Work verified complete in git but not advanced on the board → advance it.
4. An idle team with reviewed work waiting → dispatch to it.
5. Nothing applies → **wait.** This is a legitimate outcome, not a failure.

Grouping loose plans into features is **not** on this list. It is a judgement about what belongs together, and it happens when someone asks for it.

## Rules the tick needs and the current persona lacks

- **One action per wake.** Bounds the blast radius and lets the status line say something true: *"last pass dispatched Fix reviewer routing to Coding."*
- **Silent when idle.** A no-op wake writes nothing to the session log. At a ten-minute interval, logging every wake makes the overnight record unreadable — which defeats the log's only purpose.
- **A wake arriving mid-pass is dropped, not queued.** Never two passes at once.
- **Re-derive every wake.** State comes from git and the board, never from what a previous wake believed.
- **Obey the worktree setting; never write it.** Read it, follow it. Under `none`, dispatch one team at a time and wait — with a single checkout, a second concurrent team corrupts the first.

## Rules that carry over unchanged

- Ground truth over self-report — an agent saying "done" is a nudge to verify, never status of record.
- Board ops through the API path only (`move-card.js` → `POST /kanban/move`), never sqlite writes.
- No confirmation gates; it runs unattended. Escalations go to the session log and it moves on.
- Scope stays coding and code review. Planner-stage questions escalate rather than being decided.
- Merge-back one feature at a time, abort-eject-escalate on a conflict it cannot resolve coherently — and this whole section is inert under `none`, where there is nothing to merge back.

## Metadata

**Complexity:** 3
**Tags:** docs, refactor, reliability

## Verification Plan

Run agent-managed mode on a real board and watch several wakes:

1. A wake with nothing to do writes nothing and dispatches nothing.
2. A wake with one idle team and reviewed work dispatches to that team and stops — it does not also advance a card in the same pass.
3. Under `none`, a second wake while a team is still coding does not start another team.
4. No `Miscellaneous` feature is ever created, and loose plans dispatch without being grouped first.
5. An escalated item stays escalated — it is not retried on every wake.
6. The worktree setting is identical before and after a full session.
7. Ten consecutive idle wakes produce a session log with no new entries.
