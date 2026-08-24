# WITHDRAWN — column demotion at creation is the chosen mechanism; forbidding the agent from proposing a mix is not

**Status: withdrawn. Do not implement. Kept only so the rejected approach is not re-proposed.**

## Why this existed

The `manage-features` Group flow instructs an agent to create a column-mixed feature and then
warn about it: step 3 (`.agents/skills/manage-features/SKILL.md:325-336`) prescribes a
**⚠ CROSS-COLUMN** warning block, and step 5 (`:378-392`) has the agent write a
**⚠ Cross-Column Review Note** into the feature file telling the operator to press **Replan**
afterwards. `.agents/skills/kanban_operations/SKILL.md` carries the same guidance at `:131-135`,
`:193`, `:195` and `:256`.

The observation was that this is advisory at the wrong moment — the agent is told to warn, not to
avoid — so the mixed feature is created by design and the remedy is deferred to a human who has
to notice a note and act on it before the feature reaches a coder column. This plan proposed
closing that by rule: forbid the agent from proposing a group whose members span columns, split
the cluster along the column line, and send a leftover single plan to the Standalone section.

## Why it is withdrawn

**Demotion at creation is the chosen mechanism, and it makes the agent-side prohibition
pointless.** `feature_plan_20260814110809_feature-creation-produces-column-mixed-features.md`
(planId `3b1e22b2-8e09-483a-8fee-a836c380902c`, PLAN REVIEWED, subtask of *Board State Integrity
and the Agent Instructions That Describe It*) has `createFeatureFromPlanIds` resolve one column
for the whole set and write it back to every subtask — the same thing the function already does
for `project`. Its change 4 then has the agent proceed with a cross-column grouping when that is
the best capability fit, stating plainly that creation will demote the later plans to the earliest
member's column and naming which plans those are, for the user to approve alongside everything
else.

Under that mechanism a mixed *proposal* cannot produce a mixed *feature*. The invariant is held by
the code at the point of creation, not by agent discipline at the point of proposal. Adding a
prohibition on top of it guards against nothing the system still permits, and it costs something
real: the agent can no longer group by genuine capability fit when the best cluster happens to
span two columns. A capability theme is the thing a feature is supposed to express; the column is
an execution state that creation now settles on its own.

The proposal's framing — that a warning is the wrong instrument — was correct. It drew the wrong
conclusion from it. The right instrument is the coercion in `createFeatureFromPlanIds`, plus an
honest statement of the consequence in the proposal. Both are already specified in `3b1e22b2`.

## The rejected approach, recorded so it is not revived

**A single-column rule in the Group flow** — every member of a proposed feature must share a
kanban column; a spanning cluster splits into one feature per column; a split leaving one plan
sends it to Standalone; the cross-split dependency is recorded in each half's
`Dependencies & sequencing` prose. Rejected for the reason above: it duplicates an invariant the
creation path now enforces, and it forbids a grouping shape that is sometimes the correct one.

Worked cost, measured on a real run: 104 candidate plans grouped on 2026-08-24 produced 30
features under the existing flow, 9 of them column-mixed. Reworked under the single-column rule
the same 104 plans yielded 31 features and 14 standalone plans — two clean 2-way splits, five
features that shed a lone minority member, and two that dissolved entirely into standalone plans.
Three dependency relationships that had been implicit inside one feature file became cross-feature
ordering notes. That is the price of the rule, and with demotion in place there is nothing bought
with it.

## What remains true and is NOT covered by `3b1e22b2`

One finding from this plan's research survives and is a real defect in `3b1e22b2` itself:

- **Its changes 4 and 5 target a deleted path.** Both are written against
  `.agents/skills/group-into-features/SKILL.md`. That directory no longer exists — its body was
  merged into `manage-features`, and neither `.agents/skills/group-into-features` nor
  `.claude/skills/group-into-features` is present. The changes need repointing at
  `.agents/skills/manage-features/SKILL.md` with current anchors: the step-3 warning block at
  `:325-336` and the step-5 note template at `:378-392`.
- **Three dangling references to that same dead path.** `.agents/skills/kanban_operations/SKILL.md`
  sends the reader to `group-into-features/SKILL.md` for the warning text and the note template at
  `:135`, `:193` and `:195`, so the guidance is unreachable as well as superseded. The mirrored
  copies at `.claude/skills/kanban-operations/SKILL.md:142`, `:200` and `:202` carry it too.
- `3b1e22b2`'s change 7 (regenerate the `.claude/` mirrors) still applies unchanged. Both skills
  are already in `MIRROR_MANIFEST` (`src/services/ClaudeCodeMirrorService.ts:47`) and nothing
  moves, so no manifest edit is needed. Note the source-to-target rename:
  `skills/kanban_operations` mirrors to `kanban-operations`.

These belong in `3b1e22b2` as an in-place amendment, not in a plan of their own.

## Metadata

**Complexity:** 0
**Tags:** docs, planning
**Project:** Browser Switchboard
