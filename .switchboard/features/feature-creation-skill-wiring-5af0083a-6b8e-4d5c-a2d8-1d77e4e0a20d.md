# Feature-Creation Skill Wiring

**Complexity:** 5

## Goal

Ensure that every agent instructed to create a Switchboard feature uses the authoritative create-feature skill or create-feature.js script — which perform DB upsert, subtask linking, and board refresh atomically — instead of hand-writing the feature file by copying a format. Today, one plan creates the direct-creation skill and wires it into the planner persona and improve-plan workflow, while a second plan fixes three other prompt sources (memo processing, refine-ticket, switchboard-chat) that still carry the stale See .switchboard/features/ for the format instruction that leads to orphaned feature files with no DB record. Together they close the gap across all feature-creation entry points.

## How the Subtasks Achieve This

- **Add Direct Create Feature from Plans Skill + Wire Into Planner and Improve-Plan**: Authors a new create-feature-from-plans skill that documents the direct creation path (given known plan IDs and a goal, create the feature via create-feature.js), and updates the planner persona (switchboard-chat) and improve-plan workflow to invoke it when the user confirms they want a feature created.
- **Fix: Feature-creation prompts must reference the create-feature skill, not see the format**: Updates the three remaining prompt/workflow files (memo.md, TaskViewerProvider.ts refine-ticket prompt, switchboard-chat.md) that still say See .switchboard/features/ for the format to explicitly direct the agent to use the create-feature skill or create-feature.js script, matching the correct pattern already in sw-remote.md.
- **Fix: kanban-board.md snapshot gets stale — refresh more reliably**: Restores the wrongly-retired local `kanban-board.md` file mirror (`exportStateToFile`, no-op'd in commit `ca80a8a`) and fixes the staleness bug in its refresh mechanism with a debounced + content-hash-skipped write. This ensures the Suggest Features prompt's `cat {{WORKSPACE_ROOT}}/.switchboard/kanban-board.md` directive reads a current board state, not a stale snapshot that misleads the grouping agent into proposing outdated plan groupings.
- **Fix: Suggest Features prompt — project-scope section is wildly over-worded**: Rewrites section 1a of the `group-into-features` skill from ~100 words to ~35, collapsing three verbose filter-state descriptions into two terse directives. This reduces prompt noise so the grouping agent focuses on capability clustering rather than parsing redundant filter instructions, and keeps the Suggest Features clipboard prompt compact for token efficiency.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add Direct "Create Feature from Plans" Skill + Wire Into Planner & Improve-Plan](../plans/add-direct-create-feature-skill.md) — **PLAN REVIEWED**
- [ ] [Fix: kanban-board.md snapshot gets stale — refresh more reliably](../plans/feature_plan_20260707124454_suggest-features-board-snapshot-staleness.md) — **PLAN REVIEWED**
- [ ] [Fix: Suggest Features prompt — project-scope section is wildly over-worded](../plans/feature_plan_20260707124454_suggest-features-project-scope-wording.md) — **PLAN REVIEWED**
- [ ] [Fix: Feature-creation prompts must reference the create-feature skill, not "see the format"](../plans/feature_plan_20260707132952_feature-creation-must-use-skill-not-handwrite.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraint — a53b7fa1 creates the skill that b11f4303 references, but b11f4303 also references the pre-existing create-feature skill, so it is meaningful even if a53b7fa1 has not landed yet. If both land together, the full set of feature-creation entry points is covered. Subtasks can be executed in parallel; coordinate the switchboard-chat.md edit since both plans touch it (different sections — a53b7fa1 updates the feature-grouping section to invoke the new skill; b11f4303 updates the same section see-the-format wording).
