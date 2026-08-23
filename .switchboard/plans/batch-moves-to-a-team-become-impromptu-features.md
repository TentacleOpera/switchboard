# Batch moves to a team become impromptu features

## Goal

Change what a batch move means when the target is a team lead: instead of sending one prompt that tells the recipient to work N plans itself in isolation, group the selection into an **impromptu feature** of up to five plans and hand it to the lead to allocate across its seats, exactly as it allocates a real feature's subtasks.

### Problem Analysis

**The batch prompt tells the recipient to do the work, which is the wrong instruction for a lead.** `BATCH_EXECUTION_RULES` (`agentPromptBuilder.ts:833-836`) is unambiguous:

> *"1. Treat each plan file path below as a completely isolated context. Do not mix requirements between plans. 2. Execute each plan fully before moving to the next (if sequential). 3. If one plan hits an issue, report it clearly but continue processing the remaining plans when safe to do so."*

Sent to a lone coder that is correct. Sent to a team lead it is a straight contradiction of the lead's own standing order, which says the lead **distributes**: *"Your coders work the subtasks of one feature. Each subtask carries a recommendedRole; dispatch it to a seat of that role on your team"* (`teamWiring.ts:784-789`). So a batch move to a team either serialises five plans behind the lead's own hands, or the lead has to disregard the dispatch instructions to do its actual job. The team's other seats sit idle either way.

**Fan-out already exists for the other role, and this is its team-shaped counterpart.** `_distributePlannerDispatch` is a round-robin distributor that resolves the live planner pool, sorts oldest-first, applies a per-terminal limit and buckets one plan per terminal — and `feature_plan_20260820220404_created-column-batch-move-planner-fanout-toggle.md` gives it an explicit toggle. That model does not transfer to a team: a planner pool is a flat set of equivalent seats, whereas a team has a head that owns routing and seats of differing roles. The team answer is not round-robin from the board; it is *hand the set to the head and let it route*.

**The routing inputs are already present on loose plans.** `_withRecommendedRole` (`LocalApiServer.ts:4796-4809`) stamps `recommendedRole` on **plan rows** from each row's own complexity score — not from feature membership — *"Resolved by the board (operator routing map + pair-mode bypass), never by an agent reading the plan file's `Recommendation:` line."* Absence is handled too: *"the head prompt's documented fallback ('dispatch to a coder and say why') covers absence, and a guessed role would be worse than none."* So a lead handed five loose plans can already route them correctly. Nothing needs computing.

**What is missing is that the set is not a thing.** Five loose cards dispatched together are five independent cards: they do not move as a unit, they have no combined complexity, they cannot share a worktree, and the queue treats them as five items rather than one piece of work. Every downstream mechanic that would make a batch behave sensibly is keyed on a feature.

### Root Cause

Batch dispatch was built as a delivery optimisation — one prompt instead of N — rather than as a unit of work. Because the batch has no identity, the only thing that could be said about it was "here are N plans, do them", and that instruction is addressed to whoever receives it rather than to the structure of the team receiving it.

## Metadata

**Complexity:** 5
**Tags:** feature, backend, agents, ui

## Settled Design

- **A batch move to a team creates a real feature**, not a synthetic framing. The lead's allocation logic, derived complexity, atomic cascade moves, and per-feature worktree provisioning are all keyed on a feature row; a pretend one gets none of them. `createFeature` with `subtaskPlanIds` is the existing path (the same one the Project panel's Features tab uses).
- **Cap of five plans per impromptu feature.**
- **A selection larger than five is chunked, not truncated and not refused.** Twelve plans become three impromptu features of five, five and two. Silently dropping seven of a user's selection is the worst option; refusing makes the user do arithmetic the board can do.
- **The overflow queues rather than dispatching.** Head pacing's one-in-one-out already means one feature at a time per team, so the extra impromptu features stage and wait. This needs no new gate.
- **`BATCH_EXECUTION_RULES` is not sent to a team lead.** It is replaced by the feature-allocation framing, because the two instructions contradict each other.

## Complexity Audit

### Routine

- Detecting that a batch move's target is a team head rather than a standalone seat.
- Chunking a selection into groups of five in board order.
- Calling the existing feature-creation path with the chunk's plan ids.

### Complex / Risky

- **Suppressing `BATCH_EXECUTION_RULES` on the team path is the load-bearing change.** It is currently gated on `plans.length > 1 && switchboardSafeguardsEnabled` and applied uniformly. Leaving it in place alongside feature framing gives the lead both "execute each plan yourself in isolation" and "dispatch each subtask to a seat", which is the seat/head contradiction pattern this programme has already been bitten by — the cheaper instruction wins, and here the cheaper one is to do the work itself.
- **An impromptu feature is indistinguishable from a deliberate one unless it is marked.** That matters in two directions: the features list fills with ad-hoc groupings a user did not author, and `dispatch-analysis` treats a feature as indivisible, *unioning both file sets and dependencies across its subtasks* — so an arbitrary grouping of five unrelated plans becomes one large conflict set and may never stage alongside anything. Grouping plans that share nothing is not free.
- **Naming and provenance.** An impromptu feature needs a name a user can recognise a week later, and a record that the board created it from a batch move rather than a human grouping it. Without that, the only way to tell is to notice that the subtasks have nothing in common.
- **Feature complexity is derived as the max of active subtasks** (`recomputeFeatureComplexity` — *"Feature complexity is purely derived"*). So an impromptu feature containing one complexity-8 plan routes as an 8 even if the other four are 2s. That is correct for routing the *feature*, and it is a behaviour change from five cards routing individually — worth stating, because a user batching five small plans and one large one will see the whole group go to a lead.
- **Undo.** A user who batch-moves by mistake has created a feature row plus subtask links, not just moved five cards. Reversing that is more than moving the cards back, and the board has no batch-undo today.
- **Chunk boundaries are arbitrary and visible.** Five-and-two is a different allocation from four-and-three, and the user did not choose it. Ordering must be deterministic (board order, oldest-first, matching `_distributePlannerDispatch`'s sort) so the same selection always chunks the same way.

## Edge-Case & Dependency Audit

**Migration.** None structural. The behaviour of an existing control changes: a batch move onto a team stops sending one multi-plan prompt and starts creating features. Existing installs that batch-move to teams will see a different result, so it belongs in release notes — and, given ~4,000 installs, behind the same kind of explicit toggle the planner fan-out is getting rather than as a silent switch.

**Security.** Neutral. No new endpoint; feature creation and dispatch both go through existing paths.

**Side effects.** More feature rows. A team receiving one impromptu feature at a time will take longer to clear a large selection than N seats each grabbing a card would — that is the correct trade (the lead routes by role) but it is slower for a batch of uniformly trivial plans.

**Ordering.** Independent. Sits alongside the planner fan-out toggle as its team-side counterpart, and the two should share a UI idiom so the board does not grow two unrelated batch controls.

## Dependencies

- **Sibling of** `feature_plan_20260820220404_created-column-batch-move-planner-fanout-toggle.md` — same surface, different role. Align the control's look and wording.
- **Uses** the existing `createFeature` / `subtaskPlanIds` path that `manage-features` (Create from Plans) already drives.
- Independent of the completion-signal and review-team work.

## Adversarial Synthesis

**"Just round-robin the batch across the team's seats like the planner fan-out does."** That bypasses the head, which is the one thing on a team that knows which seat should get which plan. It also breaks the head's own accounting: seats would hold work the lead never dispatched and cannot report on, which is the failure mode behind `restrictToOriginTeam` and the cross-team dispatch guard.

**"Send the batch to the lead without creating a feature — the lead can allocate loose plans."** It can, since `recommendedRole` is stamped per row. But then the batch is not a unit: the five cards move independently, have no combined complexity, cannot share a worktree, and occupy five queue slots. Every mechanic that makes a group of work behave like a group is keyed on a feature, so declining to create one means reimplementing each of them at the batch layer.

**"Five is arbitrary."** It is, and it is the user's call. What matters is that overflow chunks rather than truncating, so the cap bounds a feature's size without bounding what a user may select.

**"Grouping unrelated plans into a feature corrupts the features list."** A real cost, which is why impromptu features must be marked as such. The alternative — a fake feature — pays the same cost in confusion while getting none of the machinery.

## Proposed Changes

1. **Detect a team-headed target** on batch move (Move Selected / Move All) and branch.
2. **Chunk the selection into groups of five** in deterministic board order, oldest-first.
3. **Create one impromptu feature per chunk** via the existing `createFeature` + `subtaskPlanIds` path.
4. **Mark impromptu features as board-created**, with a recognisable generated name.
5. **Dispatch the first feature to the lead** and let the rest stage; head pacing serialises them with no new gate.
6. **Suppress `BATCH_EXECUTION_RULES` on the team path** and send the feature-allocation framing the head order already expects.
7. **Put it behind an explicit toggle**, sharing the idiom of the planner fan-out control.

### Migration

None structural. Behaviour of batch moves onto teams changes; ship behind the toggle and note it in release notes.

## Verification Plan

### Goal Invariants

- A batch move onto a team never tells the lead to execute plans itself.
- Every plan in the selection ends up in exactly one impromptu feature.
- The same selection always chunks identically.
- Batch moves onto non-team targets are unchanged.

### Automated Tests

- **The lead is not told to execute:** assert `BATCH_EXECUTION_RULES` is absent from a team-path batch dispatch and the feature-allocation framing is present. This is the contradiction the plan exists to remove, so it is the first test.
- **Nothing is dropped:** batch twelve plans; assert three features of five, five and two, and that all twelve are subtasks of exactly one feature each. A cap implemented as truncation passes a "≤5 per feature" test while losing seven plans.
- **Deterministic chunking:** run the same twelve-plan selection twice; assert identical grouping.
- **One at a time per team:** assert the second impromptu feature stages rather than dispatching, and that no new refusal was added to achieve it.
- **Routing still comes from the board:** assert each subtask carries `recommendedRole` from its own complexity, and that a plan with unknown complexity carries none rather than a guess.
- **Derived feature complexity:** build an impromptu feature from four 2s and one 8; assert the feature scores 8 and routes to a lead.
- **Non-team batches are untouched:** assert a batch move to a standalone seat still sends `BATCH_EXECUTION_RULES` and creates no feature.
- **Planner fan-out is unaffected:** assert the planner path still round-robins and creates no feature.
- **Impromptu features are identifiable:** assert the marker is set and distinguishes them from user-authored features.

### Manual Verification

- Batch six plans onto a team and confirm the lead allocates rather than working them itself, and that the sixth lands in a second feature that waits.

## Outstanding Questions

- **[user]** Should an impromptu feature be archivable/dissolvable back into loose plans once its work is done, or does it stay as a permanent grouping in the features list?
