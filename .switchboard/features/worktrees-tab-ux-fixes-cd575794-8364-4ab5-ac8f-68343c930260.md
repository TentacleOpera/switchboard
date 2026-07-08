# Worktrees Tab UX Fixes

**Complexity:** 5

## Goal

Group of 3 worktree-tab fixes: abandon button lag (optimistic UI + N+1 query optimisation), remove autoban 5-terminal cap from manual worktree creation, and add column subheaders to the worktree creation dropdown. Each fix targets a distinct user-facing friction point in the Worktrees tab — laggy destructive action, an artificial limit blocking manual workflows, and a flat ungrouped dropdown that makes feature selection hard at scale. Together they make the Worktrees tab feel responsive, uncapped for manual use, and organised for findability.

## How the Subtasks Achieve This

- **Fix Abandon Worktree Button Lag with Optimistic UI**: Adds immediate visual feedback (button disable + "Removing..." text + row fade-out) on Abandon click, tracks in-flight abandonments so intermediate re-renders don't flash the row back, and optimises `_sendWorktreeConfig` to batch-fetch plan data instead of an N+1 per-worktree query. This eliminates the multi-second frozen-button wait that is the most jarring UX defect in the tab.
- **Remove Autoban 5-Terminal Cap from Manual Worktree Creation**: Gates the `MAX_AUTOBAN_TERMINALS_PER_ROLE` cap check in `ensureWorktreeTerminals()` behind an `isManual` flag so that manual UI-initiated worktree creation is never blocked by the autoban runaway-protection limit, while autoban automation retains its 5-terminal cap via its separate code path. This unblocks users who need more than 5 worktrees for parallel manual work.
- **Add Column Subheaders to Worktree Creation Dropdown**: Replaces the flat `<option>` list in the feature worktree creation dropdown with `<optgroup>` elements grouped by kanban column (following the established pattern in `implementation.html`'s plan-select), sorted by column order. This improves findability when many features exist across different workflow stages.

## Dependencies & sequencing

- **Cross-feature dependencies**: None. All three subtasks are self-contained changes to different code areas (optimistic UI + DB query, terminal cap gating, dropdown rendering) with no overlap.
- **Shipping order within this feature**: Subtasks are independent and can land in any order. If sequencing for minimal review friction: land the dropdown subheaders first (pure UI, lowest risk, complexity 3), then the terminal cap fix (single-file logic gate, complexity 4), then the optimistic UI + N+1 optimisation (multi-file, complexity 5) last so the most complex change benefits from the cleanest base.
- **Prerequisites/guards**: None. No migrations, no config changes, no schema changes. The `getPlansByPlanIds` batch method (plan 1) is a new additive DB method — no existing callers depend on it.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature Plan: Fix Abandon Worktree Button Lag with Optimistic UI](../plans/feature_plan_20260708120903_abandon-worktree-optimistic-ui.md) — **CODER CODED**
- [ ] [Feature Plan: Remove Autoban 5-Terminal Cap from Manual Worktree Creation](../plans/feature_plan_20260708120904_worktree-terminal-limit-manual-vs-autoban.md) — **CODER CODED**
- [ ] [Feature Plan: Add Column Subheaders to Worktree Creation Dropdown](../plans/feature_plan_20260708120907_worktree-creation-dropdown-column-subheaders.md) — **CODER CODED**
<!-- END SUBTASKS -->

