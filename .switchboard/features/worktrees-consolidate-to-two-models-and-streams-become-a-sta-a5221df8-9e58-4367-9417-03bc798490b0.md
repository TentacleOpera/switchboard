# Worktree Models and Dependency-Gated Dispatch

**Complexity:** 3

## Goal

Settle the two things that decide how parallel work is set up and when it is allowed to start. Reduce four overlapping worktree models to the two the operator actually wants - per project, driven by the existing strip button, and per feature, driven by a STAGING toggle. Then persist dependency edges per card and evaluate them at queue-pop time against asserted completion, so a dependent plan cannot be dispatched before the work it waits on has actually reported finished.

## How the Subtasks Achieve This

- **Consolidate the worktree models: a STAGING toggle for features, the strip button for projects** — reduces four overlapping worktree models to the two the operator actually wants, so there is one answer to where a piece of parallel work runs.
- **Persist dependency edges and gate dispatch on asserted completion at pop time** — stores the dependency edges per card and evaluates them in `_runQueuePop` against `completed_at IS NOT NULL`, so ordering is enforced at dispatch rather than assumed. It also builds the mission card that carries the map (item 7) and the membership that fills it (items 10–12): a plan dragged into STAGING joins the open mission, stops rendering as a loose board card, and is refused once that mission has launched. The card title names only the dispatch gate; the plan is wider than its title.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Persist dependency edges and gate dispatch on asserted completion at pop time](../plans/staging-streams-parallel-dispatch-and-worktrees.md) — **PLAN REVIEWED**
- [ ] [Consolidate the worktree models: a STAGING toggle for features, the strip button for projects](../plans/worktree-models-consolidate-and-a-staging-toggle.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Consolidate the worktree models first, so the dispatch-gating work targets two models rather than four. The two plans cross-reference each other.

**Scope history — read before opening the second subtask.** It was created as *Mission cards: turn dispatch analysis into a stream map on a card* at complexity 6. On 2026-08-24 commit `c630a80f` amended it in place, per the *Revise the in-flight plans for asserted completion* plan: the `stream_id` / `stream_seq` encoding and the argument against `base_branch` were superseded in favour of persisting dependency edges evaluated at pop time, and its complexity dropped to 3. **The mission-card material is still in this feature.** A note in the plan recommended splitting it to `the-automation-model-four-things-not-a-mode-axis.md` and `mission-control-panel-ui-specification.md`, and that split was never performed — the note says so itself (*"Recommendation Only — Not Performed Here"*). Neither named file contains the phrase "mission card" even once; the subtask plan contains it 28 times, and building the mission card is Proposed Change item 7 there, with membership items 10–12 alongside it. Do not skip that material when opening this subtask. The file name on disk still reads `staging-streams-parallel-dispatch-and-worktrees.md` and predates that rescoping; the card title is authoritative.

No remaining blockers — that revision has landed and its own card is in CODER CODED.
