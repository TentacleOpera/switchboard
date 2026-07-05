# Projects improvements

**Complexity:** 5

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Move Auto-Fetch Controls Into a Modal in project.html Kanban Plans Tab](../plans/feature_plan_20260701141143_autofetch-controls-into-modal.md) — **CODE REVIEWED**
- [ ] [Fix: Parent Board Shows Blank After Creating New Project](../plans/feature_plan_20260702000830_fix-blank-board-after-project-creation.md) — **CODE REVIEWED**
- [ ] [Fix: Reduce Sidebar Width for project.html Governance Tabs](../plans/feature_plan_20260702000840_reduce-governance-tab-sidebar-width.md) — **CODE REVIEWED**
- [ ] [Fix: New Project Not Showing in project.html Dropdown Until Reopen](../plans/feature_plan_20260702000855_fix-project-dropdown-not-updating-on-creation.md) — **CODE REVIEWED**
- [ ] [Fix: Projects Tab Missing Theme Styles and Weird File Path Display](../plans/feature_plan_20260702000850_fix-projects-tab-theme-styles-and-filepath.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependency Sequence

Three subtask plans edit `project.html` CSS/HTML (Plans 1, 3, 5). Two edit `KanbanProvider.ts` (Plans 2, 4). No direct line conflicts between any plans, but two ordering constraints exist to avoid edit collisions:

### Ordering constraints

1. **Plan 3 before Plan 5** — Plan 3 splits the cyber-theme sidebar rule at lines 745-755 into two selector groups. Plan 5 appends `#projects-preview-content` to 36 CSS rules. If Plan 5 runs first, it appends to the unsplit rule; Plan 3's split then needs to account for the appended selector. Apply Plan 3's split first, then Plan 5's appends.

2. **Plan 2 before Plan 4** — Both append code after line 5487 in `KanbanProvider.ts` (`addProject` handler). Plan 2's fix is frontend-only (`kanban.html`), but Plan 4 appends a `postMessageToProjectWebview` call after the same `_refreshBoard` line. Apply Plan 2 first (no backend change), then Plan 4 (appends the notification call).

### Safe parallel groups

- **Group A (parallel-safe):** Plans 1, 2, 3 — touch different files/regions (`project.html` controls strip + modal, `kanban.html` dropdown logic, `project.html` sidebar CSS).
- **Group B (after Group A):** Plans 4, 5 — Plan 4 appends to `KanbanProvider.ts` after Plan 2's region is settled; Plan 5 appends CSS selectors after Plan 3's split is done.

### Recommended sequence

```
1. Plan 3 (sidebar width split)     ──┐
   Plan 2 (blank board fix)         ──┤── Group A, parallel-safe
   Plan 1 (AutoFetch modal)         ──┘
2. Plan 5 (theme styles + filepath) ──┐── Group B, after Group A
   Plan 4 (dropdown notification)   ──┘
```

### No dependencies between plans

No plan's correctness depends on another plan being implemented first. The ordering is purely to avoid edit collisions in shared files. If plans are implemented in separate worktrees or branches and merged independently, the only merge conflicts would be in the two regions noted above (lines 745-755 of `project.html` and line 5487 of `KanbanProvider.ts`).
