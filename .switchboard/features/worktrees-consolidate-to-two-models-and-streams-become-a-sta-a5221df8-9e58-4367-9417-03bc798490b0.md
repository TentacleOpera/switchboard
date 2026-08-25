# Missions: Cards, Membership, and Dependency-Gated Dispatch

**Complexity:** 3

## Goal

Settle the two things that decide how parallel work is set up and when it is allowed to start. Reduce four overlapping worktree models to the two the operator actually wants - per project, driven by the existing strip button, and per feature, driven by a STAGING toggle. Then persist dependency edges per card and evaluate them at queue-pop time against asserted completion, so a dependent plan cannot be dispatched before the work it waits on has actually reported finished.

## How the Subtasks Achieve This

- **Consolidate the worktree models: a STAGING toggle for features, the strip button for projects** — reduces four overlapping worktree models to the two the operator actually wants, so there is one answer to where a piece of parallel work runs.
- **Persist dependency edges and gate dispatch on asserted completion at pop time** — stores the dependency edges per card and evaluates them in `_runQueuePop` against `completed_at IS NOT NULL`, so ordering is enforced at dispatch rather than assumed. It also builds the mission card that carries the map (item 7) and the membership that fills it (items 10–12): a plan dragged into STAGING joins the open mission, stops rendering as a loose board card, and is refused once that mission has launched. The card title names only the dispatch gate; the plan is wider than its title.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Persist dependency edges and gate dispatch on asserted completion at pop time](../plans/staging-streams-parallel-dispatch-and-worktrees.md) — **CODE REVIEWED**
- [ ] [Consolidate the worktree models: a STAGING toggle for features, the strip button for projects](../plans/worktree-models-consolidate-and-a-staging-toggle.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Consolidate the worktree models first, so the dispatch-gating work targets two models rather than four. The two plans cross-reference each other.

**Scope history — read before opening the second subtask.** It was created as *Mission cards: turn dispatch analysis into a stream map on a card* at complexity 6. On 2026-08-24 commit `c630a80f` amended it in place, per the *Revise the in-flight plans for asserted completion* plan: the `stream_id` / `stream_seq` encoding and the argument against `base_branch` were superseded in favour of persisting dependency edges evaluated at pop time, and its complexity dropped to 3. **The mission-card material is still in this feature.** A note in the plan recommended splitting it to `the-automation-model-four-things-not-a-mode-axis.md` and `mission-control-panel-ui-specification.md`, and that split was never performed — the note says so itself (*"Recommendation Only — Not Performed Here"*). Neither named file contains the phrase "mission card" even once; the subtask plan contains it 28 times, and building the mission card is Proposed Change item 7 there, with membership items 10–12 alongside it. Do not skip that material when opening this subtask. The file name on disk still reads `staging-streams-parallel-dispatch-and-worktrees.md` and predates that rescoping; the card title is authoritative.

No remaining blockers — that revision has landed and its own card is in CODER CODED.

## Review Findings

Both subtasks reviewed in place against their plan files. The worktree consolidation is sound and complete; its only gap was a surviving "Create Feature Worktree" form in the WORKTREES tab, removed on the user's instruction. The dependency-edge subtask shipped with nine compile errors (every `mc*` verb called a method that does not exist), a head-of-line-blocking dependency gate that broke the plan's own parallel-chains invariant, a stored `run_state` column the plan forbids, a permanent queue deadlock on archived predecessors, no cycle refusal, an unwired `map_fingerprint`, and zero of the ~30 tests the plan named — all fixed or, where they are unbuilt features rather than defects, reported. Validation: typecheck clean, 0 lint errors, new `dependency-gate` gate 16/16, all seven drift gates green, two pre-existing failures proven to predate this work. Remaining risk: the mission card is a data model without a launch — items 8b–8d and 10–12 (drag interception, launch fan-out and idempotency, membership containment) are unimplemented and need their own card. A follow-up plan, `worktrees-tab-is-a-list-not-a-console.md`, was written at the user's request to finish the WORKTREES tab cleanup.

### Second review pass

An independent pass at HEAD found five defects the first review missed, all fixed: `mcAddMissionMember` reported `success: true` while adding nothing (the panel's "+ add" posts no member and no picker exists); the pop-time dependency gate's `catch` cleared every blocker, so one transient fault dispatched unverified dependents; the codename collision check the plan's item 7 required was never built (`generateCodename`'s `salt` had no caller); a mission member whose plan row is deleted wedged `runState` at `not-started` forever; and the "shipped panel lights up" assertion the plan says *"no other check catches"* did not exist — it now pins all 13 fields and 9 `mc*` verbs, negative-controlled. Validation: `compile-tests` clean, 0 lint errors, `dependency-gate` 21/21, all eight drift gates and nine sibling contracts green, and the two red assertions in `staging-column` / `queue-pipeline` proven byte-identical at the pre-work commit `209cd7fc`. The two highest remaining risks are a **seam between the subtasks** — `POST /kanban/move`, the route this feature's own Analyze pass uses to reach STAGING, assigns no queue position and provisions no worktree, so Analyze-staged features get no integration branch with the toggle on — and the fact that **missions were built as a table, not as board cards**, which makes items 7, 8b and 10–12 a different design rather than more code.
