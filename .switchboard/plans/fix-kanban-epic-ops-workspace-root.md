# Fix: Kanban Epic Operations Use Global Workspace Root Instead of the Plan's Own Root

## Metadata
- **Tags:** frontend, bugfix
- **Complexity:** 2
- **Part of:** `per-tab-workspace-scoping-and-persistence.md` (sub-plan 0; standalone, no dependencies)

## Goal
Kanban epic operations (`getEpicDetails`, `addSubtaskToEpic`, `deleteEpic`, `removeSubtaskFromEpic`) must target the workspace root of the plan card being acted on, not the global `currentWorkspaceRoot`.

## Background
The kanban tab filters and renders correctly per-root, and normal card actions already carry per-card roots via `data-workspace-root` (e.g. `planning.js:3924`, dropdowns rendered at `planning.js:3692`). But the four epic handlers send the global `currentWorkspaceRoot` (`planning.js:55`), which is set by the `integrationProviderPreference` message (`planning.js:3137`) — i.e. whatever repo the ticket-integration preference last pointed at. In a multi-root window, opening/deleting an epic that belongs to repo B while the global root is repo A makes the backend look up (or **delete**) in the wrong repo. `deleteEpic` is destructive, so this is the worst instance of the shared-root disease.

## Proposed Changes

**File:** `src/webview/planning.js`

1. **Render the root onto epic accordions.** Where epic accordions are built in `renderKanbanPlans()` (the `_kanbanViewMode === 'epics'` branch ending ~`planning.js:3820-3850`), the epic's plan object from `_kanbanPlansCache` has a `workspaceRoot` field (same field card filters use, `planning.js:3606`). Add `data-workspace-root="${escapeHtml(plan.workspaceRoot)}"` to the `.epic-accordion` element if not already present.

2. **Use the per-card root in all four handlers:**
   - `planning.js:3826` — `getEpicDetails`: `workspaceRoot: details.dataset.workspaceRoot`
   - `planning.js:3838` — `addSubtaskToEpic`: same, from the enclosing `.epic-accordion`
   - `planning.js:3847` — `deleteEpic`: same
   - `planning.js:3860` — `removeSubtaskFromEpic`: the remove button is inside epic details rendered after `getEpicDetails`; carry the root via a `data-workspace-root` on the button (set when rendering subtask rows) or read from the closest `.epic-accordion`

3. **Subtask candidate select** (`epic-add-subtask-select` near `planning.js:3830-3838`): verify the candidate list offered for "add subtask" is filtered to plans from the same `workspaceRoot` as the epic — cross-repo epic/subtask links are meaningless. If it isn't filtered, filter it.

4. Do NOT touch any other `currentWorkspaceRoot` references — they are covered by other sub-plans.

## Edge Cases
- Plan objects lacking `workspaceRoot` (shouldn't happen — backend tags every plan): fall back to `''` and let the backend's existing resolution handle it; do not fall back to `currentWorkspaceRoot`.
- NO confirmation dialogs (project rule) — `deleteEpic` stays immediate.

## Verification
- `npm run compile`.
- Multi-root window (switchboard + viaapp): create/view an epic belonging to the repo that is NOT the integration-preference root; expand it (details load), add/remove a subtask, delete it — all must affect the correct repo's `.switchboard` data.
- `src/test/kanban-linear-project-tab-regression.test.js` passes.

## Execution Results

**Status:** Completed

**Files Changed:**
- `src/webview/planning.js`

**Changes Applied:**
1. `data-workspace-root` added to `.epic-accordion` (line 3902), sourced from `plan.workspaceRoot || ''`.
2. `getEpicDetails` handler (line 4058): now sends `details.dataset.workspaceRoot || ''` instead of `currentWorkspaceRoot`.
3. `addSubtaskToEpic` handler (line 4070): now sends `details.dataset.workspaceRoot || ''` instead of `currentWorkspaceRoot`.
4. `deleteEpic` handler (line 4079): now sends `details.dataset.workspaceRoot || ''` instead of `currentWorkspaceRoot`.
5. `removeSubtaskFromEpic` handler (line 4093): reads `data-workspace-root` from the remove button (injected at render time) instead of `currentWorkspaceRoot`.
6. `epicDetails` message renderer (line 2558-2577): queries the parent `.epic-accordion` to get its `workspaceRoot`, then stamps it onto each `.epic-remove-subtask-btn` as `data-workspace-root`.
7. Subtask candidate select (line 3906): removed global `availableSubtaskOptions` and replaced with inline per-plan filter `_kanbanPlansCache.filter(p => !p.isEpic && !p.epicId && (p.workspaceRoot || '') === (plan.workspaceRoot || ''))`, preventing cross-repo epic/subtask links.

**Validation:**
- Compilation skipped per session instructions.
- Tests skipped per session instructions (user will run separately).
- No other `currentWorkspaceRoot` references touched.

**Remaining Risks:**
- None identified. All four epic handlers now use per-card workspace roots with empty-string fallback as specified.

## Review Findings

Reviewer pass completed. All four epic handlers in `src/webview/planning.js` correctly source `workspaceRoot` from the per-card `data-workspace-root` attribute rather than the global `currentWorkspaceRoot`. The subtask candidate select is properly filtered by matching `workspaceRoot`. No CRITICAL or MAJOR issues were found; three NIT-level observations were logged but do not require code changes. Files changed: none (implementation verified as correct). Validation skipped per session instructions. Remaining risk: backend `_resolveWorkspaceRoot('')` still falls back to `currentWorkspaceRoot` for edge cases where a plan lacks `workspaceRoot`, but this matches the plan's specified behavior.
