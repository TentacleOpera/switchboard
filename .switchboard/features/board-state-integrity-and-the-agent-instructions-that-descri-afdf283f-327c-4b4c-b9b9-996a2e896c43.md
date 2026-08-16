# Board State Integrity and the Agent Instructions That Describe It

**Complexity:** 6

## Goal

Make the board's own state internally consistent, and make the agent-facing instructions describe the mechanism that actually exists. Three divergences compose into the same operator experience, a board that asserts something false: a plan file removed while nothing was watching leaves its row active forever with no tool to find it; the improve-feature skill tells agents a git rm hard-deletes the card, which is false in both halves; and feature creation derives one column for a feature and then never writes it back, so a CREATED feature card can hold a PLAN REVIEWED child and dragging it dispatches an unreviewed plan straight to coding. Grouped because each is the board disagreeing with itself, and two of the three are fixed by rewriting the same skill file and its generated mirror.

## How the Subtasks Achieve This

- **`improve-feature` Tells Agents Plan Deletion Hard-Deletes the Card**: replaces the false parenthetical with the real five-step chain, split by session type — locally the watcher clears the card within a second and purges the row within a day; remotely a `git rm` removes the file and **nothing else, now or ever**. Complexity 2, with the replacement wording specified verbatim to transcribe rather than re-derive.
- **A Reconciliation Skill for When the Board and Disk Disagree**: adds `reconcile-board`, the tool the corrected instruction implies must exist. Reports rows whose plan file is gone and, on `--fix`, routes the delete three ways by row kind — because the obvious endpoint is the one delete path that skips feature-file regeneration, and using it for a subtask row would have the reconciler manufacturing the very defect it exists to clear.
- **Feature Creation Can Produce a Column-Mixed Feature**: mirrors the column propagate onto the project propagate that already sits eleven lines away — one atomic cascade, guarded by a pre-computed diff so the uniform case stays a true no-op — plus a refusal when a grouping spans the coding boundary, a one-shot reconcile for existing mixed features, and skill rewrites replacing the advisory cross-column warning with a guarantee.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature Creation Can Produce a Column-Mixed Feature — Propagate the Column to the Subtasks, Not Just the Feature Card](../plans/feature_plan_20260814110809_feature-creation-produces-column-mixed-features.md) — **PLAN REVIEWED**
- [ ] [`improve-feature` Tells Agents Plan Deletion Hard-Deletes the Card. It Soft-Deletes, and the Card Stays.](../plans/fix-improve-feature-plan-deletion-instruction.md) — **PLAN REVIEWED**
- [ ] [A Reconciliation Skill for When the Board and Disk Disagree](../plans/add-board-disk-reconciliation-skill.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- The wording fix and the reconciliation skill are **independent** — either order. The wording fix tells an agent that a remote `git rm` strands the card; the skill is what cleans up after one. They complete each other, but neither blocks.
- **Intra-feature file conflict, must be sequenced.** The wording fix edits `.agents/skills/improve-feature/SKILL.md` at lines 19 and 67; the column-propagation subtask edits line 51 of the same file. Both must regenerate the `.claude/` mirror. Land the wording fix first — it is three lines — and let the column work build on the corrected file.
- The `reconcile-board` skill needs a `MIRROR_MANIFEST` entry. Coordinate with *The .claude/skills Mirror* feature, which owns that file, and note the entry must be `invocation: 'default'`, not `'no-model'`. Every script-bearing sibling is `'no-model'`, and copying them would make the skill undiscoverable by the agents it exists for, defeating its entire rationale.
- The column-propagation subtask rewrites **`group-into-features/SKILL.md` itself**, including the incorrect claim that the Suggest Features button copies the skill's text — it copies a *path*. It also regenerates **three** mirrors, because `skills/kanban_operations` is listed twice in the manifest under two different names; updating one and not the other leaves a stale copy under a name the model can still resolve.
- That subtask adds a **new refusal** to a path that previously always succeeded. Auditing existing callers is in scope, and the reconcile loop currently hard-returns mid-batch on a failure, so it must be converted to skip-and-warn or a batch converge can half-apply.

