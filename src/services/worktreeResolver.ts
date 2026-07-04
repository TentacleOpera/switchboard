import type { WorktreeRow } from './KanbanDatabase';

/**
 * THE shared, pure worktree-path resolver for every record-mode dispatch path
 * (CLI / batch / single-card-trigger / copy). Three-tier precedence:
 *
 *   1. per-subtask dedicated worktree — `planId` matches `subtask_plan_id`
 *   2. epic worktree — `epicId` matches `epic_id`
 *   3. project worktree — `project` matches `project`
 *
 * No sole-entry fallback. The board/map path owns the sole-entry fallback and
 * resolves via a pre-built `worktreePathMap` instead of calling this function.
 *
 * `worktrees` SHOULD already be filtered to `status='active'` —
 * `getWorktrees()` filters `status='active'` in SQL, so callers passing the
 * raw result get the right set. A defensive `.filter(w => w.status === 'active')`
 * is kept here so callers that pass unfiltered rows still behave correctly.
 *
 * Centralizing this here avoids a circular import between `KanbanProvider` and
 * `TaskViewerProvider` (both delegate to this free function) and gives the
 * dispatch-builder consolidation a single testable choke point for the
 * record-mode worktree heuristic.
 */
export function matchWorktreePath(
    worktrees: WorktreeRow[],
    plan: { epicId?: string | null; project?: string | null; planId?: string | null }
): string | undefined {
    const active = worktrees.filter(w => w.status === 'active');
    if (plan.planId) {
        const subtaskWt = active.find(w => w.subtask_plan_id && String(w.subtask_plan_id) === String(plan.planId));
        if (subtaskWt) {
            return subtaskWt.path;
        }
    }
    if (plan.epicId) {
        const epicWt = active.find(w => String(w.epic_id) === String(plan.epicId));
        if (epicWt) {
            return epicWt.path;
        }
    }
    if (plan.project) {
        const projectWt = active.find(w => w.project === plan.project);
        if (projectWt) {
            return projectWt.path;
        }
    }
    return undefined;
}
