# Fix: Plan Watcher Ignores Active Project When Assigning New Plans

## Goal

Ensure that new plans discovered by the plan watcher are assigned to the active project selected in the kanban board, rather than falling back to the base workspace kanban, by aligning `_handlePlanFile`'s workspace root resolution with `setCurrentProject`'s storage key.

## Problem

When a project is selected in the kanban board's workspace/project dropdown, new plans detected by the plan watcher are placed in the base workspace kanban instead of the active project kanban.

### Root Cause

`setCurrentProject()` stores the active project keyed by the **resolved** effective workspace root (via `resolveEffectiveWorkspaceRootFromMappings()`). But `_handlePlanFile()` performs its `_currentProjects` lookup using the **raw** workspace root passed to it. When workspace mappings cause these two paths to differ, the lookup returns `undefined` and the project falls back to `''` (base workspace).

All five watcher entry points (VS Code create/change events, native fs watcher, periodic scan, manual trigger scan, startup scan) converge on `_handlePlanFile()` — so the fix is in exactly one place.

## Metadata

- **Tags:** bugfix, reliability
- **Complexity:** 2

## User Review Required

No — this is a mechanical bugfix with no product or UX change.

## Complexity Audit

### Routine
- Single-file, single-line logic change
- Reuses existing `resolveEffectiveWorkspaceRootFromMappings` utility already imported in the same file
- No schema, API, or UI changes

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** `_currentProjects` is a plain `Map` accessed across async boundaries. Rapid project switching during file I/O could yield a stale read, but the worst-case transient behavior (plan lands in previously selected project) is acceptable for a UI-driven toggle.
- **Security:** None — no auth, input, or network surface touched.
- **Side Effects:** None beyond correct kanban project assignment.
- **Dependencies & Conflicts:** None. `resolveEffectiveWorkspaceRootFromMappings` is already imported and used elsewhere in `GlobalPlanWatcherService.ts`.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) Missing symmetric log line after resolution makes future diagnostics harder; (2) No automated regression test leaves the path vulnerable to re-breakage if `_handlePlanFile` is refactored. Mitigations: add a debug log mirroring `setCurrentProject`, and add a targeted unit test mocking the resolver to assert the resolved root is used for the `_currentProjects` lookup.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts`

**Context:** `_handlePlanFile()` currently resolves the active project on L495 using the raw `workspaceRoot` parameter:

```typescript
const project = metadata.project || this._currentProjects.get(workspaceRoot) || '';
```

This mismatches `setCurrentProject()` (L54-67), which stores the project keyed by the effective workspace root after calling `resolveEffectiveWorkspaceRootFromMappings(workspaceRoot)`.

**Logic:** When workspace mappings map a physical folder to a different effective root, the lookup key and storage key diverge, causing every new plan to default to the base workspace (`''`).

**Implementation:**

```typescript
// Before (broken):
const project = metadata.project || this._currentProjects.get(workspaceRoot) || '';

// After (fixed):
const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(workspaceRoot);
const project = metadata.project || this._currentProjects.get(effectiveRoot) || '';
```

Clarification: optionally add a log line for symmetry with `setCurrentProject`:

```typescript
if (effectiveRoot !== workspaceRoot) {
    this._outputChannel?.appendLine(`[GlobalPlanWatcher] _handlePlanFile: resolved ${workspaceRoot} → ${effectiveRoot} for project lookup`);
}
```

**Edge Cases:**
- If `metadata.project` is explicitly set in the plan frontmatter, it overrides the active project (existing behavior, preserved).
- If no project is active (`_currentProjects` has no entry for the effective root), the fallback to `''` remains correct.

## Scope

- **1 file changed:** `src/services/GlobalPlanWatcherService.ts`
- **2 lines changed:** replace the single `_currentProjects.get(workspaceRoot)` call with an effectiveRoot-resolved equivalent
- No schema changes, no UI changes, no new dependencies

## Verification Plan

### Manual Tests
1. Open a workspace with at least one project defined.
2. Select a project in the kanban dropdown.
3. Create a new plan file (via the plan creation UI or by dropping a `.md` file into the plans directory).
4. Confirm the new plan card appears in the selected project's kanban, not the base workspace kanban.
5. Switch to a different project and repeat — confirm plans land in whichever project is active at creation time.
6. Confirm plans created with no project selected still land in the base workspace kanban.

### Automated Tests
- Add a unit test for `GlobalPlanWatcherService` that mocks `resolveEffectiveWorkspaceRootFromMappings` to return a different path, pre-seeds `_currentProjects` with the resolved key, and asserts that `_handlePlanFile` uses the resolved key for the project lookup.

## Recommendation

**Send to Intern**
