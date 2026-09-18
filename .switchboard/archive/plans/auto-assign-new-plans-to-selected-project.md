# Auto-Assign New Plans to Currently Selected Project

## Goal
When new plan files are created while a project filter is active in the kanban board, automatically assign those plans to the currently selected project instead of leaving the `project` field as an empty string.

## Metadata
- **Tags:** frontend, ui, workflow
- **Complexity:** 4

## User Review Required
- Should the metadata-based project override (reading `**Project:** X` from plan frontmatter) be included in this change, or deferred to a follow-up plan?
- Is the PlanFileImporter gap (plans imported at startup before any filter is set) acceptable as a known limitation?

## Complexity Audit

### Routine
- Adding `_currentProjects` map field to `GlobalPlanWatcherService`
- Adding `setCurrentProject(workspaceRoot, project)` method
- Setting `project` field on `newRecord` in `_handlePlanFile`
- Wiring up `setCurrentProject` call from `KanbanProvider` message handler
- Adding `project?: string` to `PlanMetadata` interface and extraction regex

### Complex / Risky
- Multi-workspace project bleed: a single `_currentProject` scalar would assign the wrong project to plans in other workspaces. Must use a per-workspace `Map<string, string>` instead.
- Race condition: `_handlePlanFile` is debounced by 300ms; a project filter change within that window could assign the wrong project. Practical risk is negligible but should be documented.

## Edge-Case & Dependency Audit

- **Race Conditions:** The 300ms debounce in `_debounceHandleFile` (line 349) means the project filter active when the handler *fires* may differ from the filter active when the file was *created*. This is a narrow window with negligible practical impact.
- **Security:** No security implications — project assignment is a UI organizational concept, not a security boundary.
- **Side Effects:** Setting `project` on new records will cause them to appear when that project filter is active, and disappear when a different filter is active. This is the desired behavior.
- **Dependencies & Conflicts:** The `PlanFileImporter` (lines 106-130) also creates `KanbanPlanRecord` objects without setting `project`. This path runs at startup/initial scan, typically before the user sets a project filter, so the practical impact is low. Documented as a known limitation.

## Dependencies
- None

## Adversarial Synthesis
Key risks: multi-workspace project bleed if using a scalar instead of per-workspace map; PlanFileImporter creates records without project assignment (separate code path). Mitigations: use `Map<string, string>` keyed by workspace root; document importer gap as known limitation with follow-up plan.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts`
- **Context:** This service watches for new/changed plan files and creates `KanbanPlanRecord` entries via `_handlePlanFile`. Currently, the `newRecord` at lines 417-441 omits the `project` field, defaulting to empty string via the upsert SQL (line 1073 of KanbanDatabase.ts).
- **Logic:**
  1. Add a private field `_currentProjects = new Map<string, string>()` (per-workspace project tracking) near line 31, alongside the other private fields.
  2. Add a public method `setCurrentProject(workspaceRoot: string, project: string | null): void` that sets or clears the project for a specific workspace root. When `project` is null, delete the entry from the map.
  3. In `_handlePlanFile` (line 368), after creating `metadata` (line 387) and before constructing `newRecord` (line 417), resolve the project: `const project = this._currentProjects.get(workspaceRoot) || metadata.project || ''`
  4. Add `project` field to the `newRecord` object (after line 439, before `linearIssueId`): `project,`
- **Implementation:**
  ```typescript
  // Near line 31, add:
  private _currentProjects = new Map<string, string>();

  // New public method (after registerRename, ~line 37):
  public setCurrentProject(workspaceRoot: string, project: string | null): void {
      if (project) {
          this._currentProjects.set(workspaceRoot, project);
      } else {
          this._currentProjects.delete(workspaceRoot);
      }
  }

  // In _handlePlanFile, before newRecord construction (~line 416):
  // NOTE: metadata.project takes precedence over _currentProjects so that explicit
  // **Project:** declarations in plan files override the implicit current filter.
  const project = metadata.project || this._currentProjects.get(workspaceRoot) || '';

  // In newRecord object (~line 439), add:
  project,
  ```
- **Edge Cases:** If `workspaceRoot` is not in the map and `metadata.project` is undefined, falls back to `''` (empty string), preserving current behavior.

### `src/services/planMetadataUtils.ts`
- **Context:** `parsePlanMetadata` (line 50) extracts metadata from plan file content. The `PlanMetadata` interface (line 23) does not currently include a `project` field.
- **Logic:**
  1. Add `project?: string` to the `PlanMetadata` interface (after line 29, before `dependencies`).
  2. Add extraction logic in `parsePlanMetadata` after the dependencies extraction (~line 109): match `**Project:** (.+)` pattern from plan content, similar to how `extractEmbeddedMetadata` works in PlanFileImporter.
  3. Return `project` in the metadata object (line 111-117).
- **Implementation:**
  ```typescript
  // In PlanMetadata interface (after line 29):
  project?: string;

  // In parsePlanMetadata, after dependencies extraction (~line 109):
  let project: string | undefined;
  const projectMatch = content.match(/^\*\*Project:\*\*\s*(.+)$/im);
  if (projectMatch) {
      project = projectMatch[1].trim() || undefined;
  }

  // In return object (add after dependencies):
  project,
  ```
- **Edge Cases:** Only matches `**Project:** X` at the start of a line (case-insensitive). If no match, `project` is `undefined`, which falls through to the watcher's `_currentProjects` map or empty string default.

### `src/services/KanbanProvider.ts`
- **Context:** The `setProjectFilter` message handler (lines 4217-4223) receives project filter changes from the webview UI and calls `this.setProjectFilter(msg.project || null)`. The public `setProjectFilter` method (line 3736) only sets `this._projectFilter`.
- **Logic:**
  1. In the `setProjectFilter` message handler (line 4217-4223), call `this.setProjectFilter(msg.project || null)` which internally propagates to the watcher, then call `_refreshBoard`. Do NOT call `setCurrentProject` directly — the public method already handles it.
  2. In the public `setProjectFilter` method (line 3736-3738), also propagate to the watcher for any programmatic callers: `this._globalPlanWatcher?.setCurrentProject(this._currentWorkspaceRoot || '', filter)`.
  3. In the `deleteProject` handler (line 4204-4219), when clearing the project filter because the active project was deleted, use `this.setProjectFilter(null)` instead of directly setting `this._projectFilter = null`, so the watcher is also updated.
- **Implementation:**
  ```typescript
  // In message handler 'setProjectFilter' (line 4217-4223):
  case 'setProjectFilter': {
      const workspaceRoot = this._currentWorkspaceRoot;
      if (workspaceRoot && (msg.project === null || typeof msg.project === 'string')) {
          this.setProjectFilter(msg.project || null);
          await this._refreshBoard(workspaceRoot);
      }
      break;
  }

  // In public setProjectFilter method (line 3736-3738):
  public setProjectFilter(filter: string | null): void {
      this._projectFilter = filter;
      if (this._currentWorkspaceRoot) {
          this._globalPlanWatcher?.setCurrentProject(this._currentWorkspaceRoot, filter);
      }
  }
  ```
- **Edge Cases:** `_globalPlanWatcher` may be undefined early in the lifecycle (it's set via `setGlobalPlanWatcher`). The optional chaining `?.` handles this gracefully. When `workspaceRoot` is null or empty, the watcher call is skipped.

### `src/services/PlanFileImporter.ts` (Known Limitation — Not Changed)
- **Context:** `PlanFileImporter` (lines 106-130) creates `KanbanPlanRecord` objects during initial import without setting `project`. This path runs at startup before the user interacts with the kanban UI.
- **Logic:** No change in this plan. The importer runs before any project filter is set, so all imported plans correctly default to empty string. If a user wants to bulk-assign imported plans to a project, they can use the existing "Assign to Project" UI action.
- **Edge Cases:** If the importer runs *after* a project filter is somehow already set (e.g., persisted state), those plans would still get empty project. This is a known limitation that can be addressed in a follow-up plan if needed.

## Verification Plan

### Automated Tests
- Test that `GlobalPlanWatcherService.setCurrentProject` stores and retrieves project per workspace root
- Test that `_handlePlanFile` assigns `project` from `_currentProjects` map when creating a new record
- Test that `_handlePlanFile` falls back to `metadata.project` when no current project is set
- Test that `_handlePlanFile` falls back to empty string when neither source provides a project
- Test that `parsePlanMetadata` extracts `project` from `**Project:** X` in plan content
- Test that `parsePlanMetadata` returns `project: undefined` when no project metadata is present

### Manual Verification
1. Open the kanban board and select a project from the project filter dropdown
2. Create a new plan file in `.switchboard/plans/`
3. Verify the plan appears in the kanban board with the correct project assignment
4. Clear the project filter (select "All Projects") and create another plan
5. Verify the new plan has an empty project field
6. Create a plan file with `**Project:** OverrideProject` in its content while a different project filter is active
7. Verify the plan is assigned to "OverrideProject" (metadata override takes precedence)

### Skip
- Compilation and automated test execution are skipped per session directives

## Recommendation
Complexity 4 → **Send to Coder**

---

## Review Results (Post-Implementation)

### Reviewer: Grumpy Principal Engineer In-Place Review
### Date: 2026-05-26

### Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Precedence order in plan spec contradicted implementation: plan said `_currentProjects \|\| metadata.project`, implementation had `metadata.project \|\| _currentProjects`. Implementation is correct (explicit metadata should override implicit filter, matching manual verification step 7). Plan spec updated. | MAJOR | **Fixed in plan spec** |
| 2 | Redundant `setCurrentProject` call in `setProjectFilter` message handler — `setProjectFilter()` already propagates to watcher internally. | NIT | **Fixed in code** (KanbanProvider.ts line 4224 removed) |
| 3 | `deleteProject` handler set `_projectFilter = null` directly, bypassing `setProjectFilter()`, so the watcher's `_currentProjects` map was not cleared. New plans would be auto-assigned to the deleted project. | MAJOR | **Fixed in code** (KanbanProvider.ts line 4208: now uses `this.setProjectFilter(null)`) |
| 4 | `PlanFileImporter` missing `project` field — documented as known limitation. | NIT | **Deferred** (documented) |
| 5 | `_handlePlanFile` only sets project on new plans, preserves on updates — correct behavior. | NONE | **No change needed** |

### Files Changed During Review

1. **`src/services/KanbanProvider.ts`** — Two fixes:
   - Line 4208: Changed `this._projectFilter = null` → `this.setProjectFilter(null)` in `deleteProject` handler (ensures watcher's `_currentProjects` is also cleared)
   - Line 4224: Removed redundant `this._globalPlanWatcher?.setCurrentProject(workspaceRoot, msg.project || null)` from `setProjectFilter` message handler (already handled by `setProjectFilter()` method internally)

2. **`.switchboard/plans/auto-assign-new-plans-to-selected-project.md`** — Three updates:
   - Corrected precedence order in code spec from `_currentProjects.get \|\| metadata.project` to `metadata.project \|\| _currentProjects.get` (matching implementation and manual verification intent)
   - Updated KanbanProvider Logic section to remove redundant `setCurrentProject` call and add `deleteProject` handler guidance
   - Added this review results section

### Validation

- **TypeScript check**: `npx tsc --noEmit` — 2 pre-existing errors (unrelated import path issues in `ClickUpSyncService.ts` and `KanbanProvider.ts` line 4591). Zero new errors from review fixes.
- **Compilation**: Skipped per session directives.
- **Automated tests**: Skipped per session directives.

### Remaining Risks

1. **Race condition with 300ms debounce** (documented in plan): The project filter active when `_handlePlanFile` fires may differ from when the file was created. Narrow window, negligible practical impact.
2. **PlanFileImporter gap** (documented as known limitation): Plans imported at startup before any filter is set will have empty `project`. Can be addressed in a follow-up plan if needed.
3. **No persistence of `_currentProjects`**: The watcher's `_currentProjects` map is in-memory only. If the extension host restarts, the map is empty until the user interacts with the project filter again. This is acceptable because the filter UI state is also not persisted across restarts.
