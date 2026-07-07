# Suggest Features Prompt Quality

**Complexity:** 5

## Goal

Make the Suggest Features prompt point the agent at a current board snapshot and say the project-scope rule in 10 words instead of 100. Today the kanban-board.md local file mirror was wrongly retired to a no-op (the commit confused it with the remote orphan-branch publisher), so the file the prompt tells the agent to cat is stale or absent; and the project-scope section of the group-into-features skill is ~100 words of defensive prose enumerating every filter-state combination where ~10 words would do. Together these two plans restore the local file mirror with a staleness-free debounce, and rewrite the project-scope directive to a terse two-branch rule.

## How the Subtasks Achieve This

- **Fix: kanban-board.md snapshot gets stale — refresh more reliably**: Restores the real `exportStateToFile` implementation (retired to a no-op by commit `ca80a8a`) in `KanbanDatabase.ts`, replacing the old single-flight + boolean-pending debounce with a debounced + content-hash-skipped approach that guarantees the trailing write always fires. The local mirror is always-on for local agents, independent of the opt-in orphan-branch `BoardSnapshotPublisher`.
- **Fix: Suggest Features prompt — project-scope section is wildly over-worded**: Rewrites section 1a of `.agents/skills/group-into-features/SKILL.md` from ~100 words of three-state enumeration to a ~35-word two-branch directive: if a project name is injected, filter by it; if not (empty, `__unassigned__`, or literal placeholder), ignore all plans with a project tag. No code change to `KanbanProvider.ts` — the substitution machinery is unchanged.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix: kanban-board.md snapshot gets stale — refresh more reliably](../plans/feature_plan_20260707124454_suggest-features-board-snapshot-staleness.md) — **CREATED**
- [ ] [Fix: Suggest Features prompt — project-scope section is wildly over-worded](../plans/feature_plan_20260707124454_suggest-features-project-scope-wording.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraint — the board-snapshot plan edits `KanbanDatabase.ts` (backend) and the wording plan edits `group-into-features/SKILL.md` (prompt text), different files with no overlap. The plans explicitly note no conflict. Subtasks can be executed in parallel. Both must land for the Suggest Features prompt to be fully correct — a current snapshot with verbose wording is still wasteful, and terse wording pointing at a stale snapshot is still broken.
