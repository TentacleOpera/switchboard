# A Feature Must Be True Of The Plans Inside It

**Complexity:** 4

## Goal

Fix the grouping and backfill passes at their shared root: they read plan bodies to decide which plans belong together, then write the feature title and prose from the subtask titles.

The skill already knows titles are not enough, but only for clustering - step 2 says to read the full plan file and use that, not just titles, to determine groupings. Nothing carries that instruction into what gets written. Step 3 and the backfill prompt are both keyed on the plan name. So when a subtask title is narrower than its plan, the feature narrows with it and the plan remaining content becomes invisible to anyone reading the feature.

The same pass treats a declared dependency as a clustering hint rather than a rule about placement, so features ship holding half a capability while the other half sits in a different feature. A plan and the plans it declares it requires must land together, unless that would push the feature past ten subtasks - in which case the split is deliberate and the cross-feature dependency is stated.


## How the Subtasks Achieve This

- **A Feature Title And Prose Must Be True Of The Plans Inside It**: carries the read-the-bodies instruction into what actually gets written. Step 2 of the Group flow says to read the full plan file and use that, not just titles, to determine groupings — but step 3 and the backfill prompt are both keyed on the plan name, so an agent reads bodies to decide placement and then writes the description from titles. Also forbids asserting that material moved somewhere without checking it arrived.
- **A Feature Contains Its Dependencies**: makes a declared `Requires` a rule about placement rather than a clustering hint, with a deliberate ten-subtask cap and an explicit statement whenever a split is chosen. Stops features shipping with half a capability while the other half sits elsewhere.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A feature's title and prose must be true of the plans inside it](../plans/feature-titles-and-prose-must-be-true-of-the-plans-inside.md) — **PLAN REVIEWED** — ID: 3f1fe37c-0df7-48b4-9aa6-db62fd087ff6
- [ ] [A feature contains its dependencies](../plans/a-feature-contains-its-dependencies.md) — **PLAN REVIEWED** — ID: 5443800d-54f0-4287-84fd-f418aeae4a00
<!-- END SUBTASKS -->

## Dependencies & sequencing

These are siblings — same skill, same pass, same root cause: grouping reads bodies to decide and then works from titles. One governs what a feature is **called**, the other what it **contains**. Land them together; splitting them leaves the shared root half-fixed.

Both require a mirror step. `.claude/skills/manage-features/` is generated from `.agents/skills/manage-features/`, and `npm run mirror:check` gates the two being in step, so an edit to one copy without the other is a red gate. `improve-feature` is **not** mirrored and carries no `mirror:check` coverage — but it does have a two-copy divergence of its own, so a coder must edit both copies or delete the alias first.

That alias deletion is the one cross-feature coupling: `protocol-paths-in-agent-instructions-point-nowhere.md` (outside this feature) conflicts on file if it deletes the alias. Sequence, do not parallelise.

Worth noting for whoever codes these: the plans were verified against a real instance during the consistency audit, and this feature's own creation followed the corrected procedure — bodies read, retirements swept, groupings proposed before creation.
