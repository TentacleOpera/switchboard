# Multi-Agent Planning Runs

**Complexity:** 6

## Goal

Add a planning mode that attacks one problem with N independent agents instead of one, then reconciles their output against the code rather than by taste. The problem being solved is anchoring: a single planner forms a root-cause hypothesis early and spends the rest of its budget elaborating it, producing a plan that reads complete and rests on a false premise. These three subtasks are one pipeline - dispatch N isolated investigators, map where they disagreed, then adjudicate the disagreements against the codebase - and each stage's output is the next stage's typed input.

## How the Subtasks Achieve This

- **Multi-Agent Planning 01 — Fan-In Dispatch**: Provisions the run as a Switchboard team, splits the brief across the team prompt (invariant half) and an N-way per-seat dispatch (run-specific half), and writes N independent drafts into `.switchboard/planning-runs/<run-id>/` — outside the watched plans directory so the board gains no junk cards. Produces the run directory and manifest everything downstream reads.
- **Multi-Agent Planning 02 — Divergence Map Before Synthesis**: Has the team head compress N drafts into a claim table bucketed unanimous / split / singleton / contradicted *before* any merged plan exists, flagging clusters that merely echo the shared team prompt. Encodes the rule that singletons are resolved by citation-checking and never dropped by vote.
- **Multi-Agent Planning 03 — Adjudication Round**: Dispatches bounded, self-contained verification tasks for the disputed claims to a stake-free `shared`-scope adjudicator seat, folds verdicts back into the map, and re-runs synthesis. Converts open questions into settled facts where the code can settle them.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Multi-Agent Planning 01 — Fan-In Dispatch: N Agents, One Problem, N Independent Plans](../plans/multi-agent-planning-01-fan-in-dispatch.md) — **PLAN REVIEWED**
- [ ] [Multi-Agent Planning 02 — Divergence Map Before Synthesis](../plans/multi-agent-planning-02-divergence-map.md) — **PLAN REVIEWED**
- [ ] [Multi-Agent Planning 03 — Adjudication Round: Resolving Divergence Against the Code](../plans/multi-agent-planning-03-adjudication-round.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Hard chain, **01 → 02 → 03**. Subtask 02 cannot start without 01's run directory and its manifest record of the in-force team prompt; 03 consumes 02's claim schema, and its own recommendation is to wait until that schema is settled because the adjudication prompt is a direct function of it.

Each stage ships useful alone: 01 alone produces N diffable drafts in a run directory; 02 alone produces a synthesized plan with explicit open questions, which is already a better artifact than a single-agent plan that never knew the questions existed.

All three depend on the **teams feature** (already landed) — team definitions, `spawnDelegates`, `wireSpawnedTeam`, the team `prompt` carrier and the auto-start trigger. None of them adds a terminal, a role or a messaging mechanism of its own.
