# Plan: Standardise ClickUp and Linear Integration (Deep Planning Edition)

## Goal

Achieve feature parity for ClickUp and Linear integrations by addressing ONLY the inconsistencies that are NOT justified by API differences. Both integrations were built independently, leading to gaps where one platform has features the other doesn't, despite both APIs supporting equivalent functionality.

## Metadata

**Tags:** integration, refactor, parity, ClickUp, Linear
**Complexity**: 5
**Planning Depth:** Deep (50-100+ sources analyzed)

## Executive Summary

**Key Changes:**
1. Add `deleteSyncEnabled`, `completeSyncEnabled`, `excludeBacklog` to ClickUp config (all default: false for safety)
2. Implement ClickUp `archiveTask()` using DELETE endpoint (per ClickUp API documentation)
3. Make Linear's `_createIssue()` public (rename to `createIssue()`) - verified 2 internal callers
4. Add public `importIssuesFromLinear()` method to match ClickUp's `importTasksFromClickUp()`
5. Add ClickUp delete sync handler in TaskViewerProvider (same pattern as Linear)
6. Add UI controls in setup.html for new ClickUp config fields

**Rationale:** Both APIs support these capabilities - inconsistency is unjustified. Research confirms ClickUp DELETE endpoint exists, Linear uses GraphQL `archivedAt` mutation. Integration best practices emphasize consistent interfaces and uniform patterns across similar services.

## Problem

The ClickUp and Linear integrations have unjustified inconsistencies where one platform has features the other doesn't, despite both APIs supporting equivalent functionality:

### Critical Inconsistencies (Both APIs Support, But Only One Implemented)
1. **Delete Sync**: Linear has `deleteSyncEnabled` (defaults to `true`) + `archiveIssue()` method, ClickUp has neither - both APIs support deletion
2. **Complete Sync**: Linear has `completeSyncEnabled` (syncs completed status), ClickUp has none - both APIs support status/state updates
3. **Import Functionality**: ClickUp has public `importTasksFromClickUp()` method, Linear has no equivalent public method - both APIs can fetch tasks/issues
4. **Backlog Filtering**: Linear has `excludeBacklog` (filters out Triage state), ClickUp has none - both platforms support backlog via status filtering

### Medium Priority Inconsistencies (Implementation Pattern Differences)
5. **Task Creation Visibility**: ClickUp has public `createTask()`, Linear has private `_createIssue()` - both APIs support creation, visibility should be consistent

### NOT In Scope (Justified by API Differences)
- **Hierarchy Model**: ClickUp (workspace/space/folder/list) vs Linear (team/project) - different data models
- **Categorization**: ClickUp (custom fields) vs Linear (labels) - different API approaches
- **Filtering Approach**: ClickUp (single list selection) vs Linear (project arrays) - different data models
- **Database Lookup Naming**: Different naming reflects terminology differences - not worth changing
- **Automation Rule Types**: Different types for platform-specific automation - not a parity issue

## Current State Analysis

### Codebase Findings

**ClickUpSyncService.ts:**
- Config interface lacks `deleteSyncEnabled`, `completeSyncEnabled`, `excludeBacklog` fields
- Has public `createTask()` method (line 1236)
- Has public `importTasksFromClickUp()` method (line 2233)
- No `archiveTask()` method exists
- Uses `columnMappings` (Record<string, string>) for status-to-list mapping
- Backlog detection: checks status name for "backlog" (line 2342-2343)

**LinearSyncService.ts:**
- Config interface has `deleteSyncEnabled` (default: true), `completeSyncEnabled` (default: true), `excludeBacklog` (default: true)
- Has private `_createIssue()` method (line 1583) - called in 2 places (lines 1530, 1535)
- Has public `archiveIssue()` method (line 1132) using GraphQL `archivedAt` mutation
- No public import method exists
- Uses `columnToStateId` (Record<string, string>) for column-to-state mapping
- Backlog detection: checks state.type === 'backlog' (line 1841)

**TaskViewerProvider.ts:**
- Delete handler (lines 12349-12370) only handles Linear archive
- Uses Linear's `archiveIssue()` when `deleteSyncEnabled !== false`
- No ClickUp archive handling exists

**Test Files:**
- `LinearSyncService.createIssue.cleanup.test.ts` references `_createIssue()` - will need update

### External Research Findings

**ClickUp API Documentation:**
- DELETE endpoint exists: `DELETE /api/v2/task/{task_id}` (per Delete Task reference)
- Update Task endpoint can set status via `status` field
- Filter Views documentation shows status filtering by name or type (active, done, closed)
- Archived field can be filtered: `{ "field": "archived", "op": "EQ", "values": [] }`

**Linear API Documentation:**
- GraphQL API uses `issueUpdate` mutation with `archivedAt` field for archiving
- Triage is a special inbox/state type for backlog issues
- Status types include: active, done, closed, backlog, triage
- Default status for new issues is first Backlog status

**Integration Best Practices:**
- Uniform Interface: Consistent and standardized interface simplifies interactions
- API Architecture: REST APIs should adhere to consistent patterns
- Integration Patterns: Emphasize consistent interfaces across similar services

## Root Cause

- Different developers implemented each integration independently
- No unified integration specification or interface was defined
- Linear integration was built first with more features, ClickUp added later with less parity
- No code review comparing implementations for consistency

## Complexity Audit

### Simple / Low Risk
- Step 1: Add `deleteSyncEnabled` to ClickUp config (default: false)
- Step 2: Add `completeSyncEnabled` to ClickUp config (default: false)
- Step 3: Add `excludeBacklog` to ClickUp config (default: false)
- Step 4: Make Linear's `_createIssue()` public (rename to `createIssue()`) - verified 2 internal callers
- Step 5: Add public `importIssuesFromLinear()` method to Linear

### Complex / Risky
- Step 6: Implement ClickUp archive/delete task method using DELETE endpoint
- Step 7: Add ClickUp delete sync handler in TaskViewerProvider

## Dependencies

- Depends on: `remove_delete_sync_default_true.md` plan (should be executed first to establish safe defaults for Linear)

## Implementation Status

- **Step 1**: ⏳ PENDING - Add deleteSyncEnabled to ClickUp
- **Step 2**: ⏳ PENDING - Add completeSyncEnabled to ClickUp
- **Step 3**: ⏳ PENDING - Add excludeBacklog to ClickUp
- **Step 4**: ⏳ PENDING - Make Linear's _createIssue() public
- **Step 5**: ⏳ PENDING - Add public import method to Linear
- **Step 6**: ⏳ PENDING - Implement ClickUp archive task method
- **Step 7**: ⏳ PENDING - Add ClickUp delete handler

## Proposed Implementation Plan

### `src/services/ClickUpSyncService.ts`

**Context 1:** Config interface (lines 12-32) needs new fields to match Linear.

**Logic:** Add `deleteSyncEnabled`, `completeSyncEnabled`, and `excludeBacklog` fields (both APIs support these operations).

**Implementation (add after line 31):**
```typescript
export interface ClickUpConfig {
  workspaceId: string;
  folderId: string;
  spaceId: string;
  columnMappings: Record<string, string>;
  customFields: {
    sessionId: string;
    planId: string;
    syncTimestamp: string;
  };
  setupComplete: boolean;
  lastSync: string | null;
  realTimeSyncEnabled: boolean;
  autoPullEnabled: boolean;
  pullIntervalMinutes: AutoPullIntervalMinutes;
  automationRules: ClickUpAutomationRule[];
  selectedListId: string;
  selectedListName: string;
  selectedSpaceId: string;
  selectedFolderId: string;
  deleteSyncEnabled?: boolean;  // default: false - delete ClickUp task when plan is deleted
  completeSyncEnabled?: boolean;  // default: false - sync completed status to ClickUp
  excludeBacklog?: boolean;  // default: false - exclude tasks with backlog status from sync
}
```

**Context 2:** Config normalization (lines 254-287) needs to handle new fields.

**Implementation (add after line 285):**
```typescript
deleteSyncEnabled: raw.deleteSyncEnabled === undefined
  ? false  // Default to false - require explicit opt-in
  : raw.deleteSyncEnabled === true,
completeSyncEnabled: raw.completeSyncEnabled === undefined
  ? false  // Default to false - require explicit opt-in
  : raw.completeSyncEnabled === true,
excludeBacklog: raw.excludeBacklog === undefined
  ? false  // Default to false - include all tasks
  : raw.excludeBacklog === true,
```

**Context 3:** Empty config creation (lines 234-252) needs to initialize new fields.

**Implementation (add after line 250):**
```typescript
deleteSyncEnabled: false,
completeSyncEnabled: false,
excludeBacklog: false,
```

**Context 4:** Add `archiveTask()` method to handle task deletion using ClickUp DELETE endpoint.

**Logic:** Use ClickUp's DELETE endpoint (`DELETE /api/v2/task/{task_id}`) per API documentation. This is the correct approach for deletion, not status change.

**Implementation (add new method after existing sync methods):**
```typescript
/**
 * Delete a ClickUp task.
 * Used when a Switchboard plan is deleted and deleteSyncEnabled is true.
 * Uses ClickUp DELETE endpoint per API documentation.
 */
public async archiveTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) {
    return { success: false, error: 'Task ID is required' };
  }

  try {
    const result = await this.httpRequest('DELETE', `/task/${normalizedTaskId}`);
    if (result.status === 204) {
      console.log(`[ClickUpSync] Deleted ClickUp task ${normalizedTaskId}`);
      return { success: true };
    } else {
      return { success: false, error: `Failed to delete task: HTTP ${result.status}` };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
```

**Rationale:** ClickUp API documentation confirms DELETE endpoint exists and returns 204 on success. This matches Linear's `archiveIssue()` pattern of using the platform's native deletion mechanism.

**Context 5:** Add backlog filtering to import/sync operations.

**Logic:** Use existing status name heuristic (checks for "backlog" in status name) - already implemented in `importTasksFromClickUp` (line 2342-2343). Apply this filter when `excludeBacklog` is true.

**Implementation:** In sync/import methods, add check:
```typescript
if (config.excludeBacklog === true) {
  const statusName = (task.status?.status || '').toLowerCase();
  if (statusName === 'backlog') {
    continue;  // Skip backlog tasks
  }
}
```

**Rationale:** ClickUp doesn't have a built-in "backlog" state type like Linear's "Triage". The existing heuristic (status name contains "backlog") is appropriate and already tested.

---

### `src/services/LinearSyncService.ts`

**Context 6:** `_createIssue()` is private (line 1583), should be public to match ClickUp's pattern.

**Logic:** Rename from `_createIssue()` to `createIssue()` and make it public.

**Verified Callers:** 2 internal callers at lines 1530, 1535. Test file `LinearSyncService.createIssue.cleanup.test.ts` also references it.

**Implementation:**
1. Rename method from `_createIssue` to `createIssue` (remove underscore, make public)
2. Update callers at lines 1530, 1535 to use `createIssue()`
3. Update test file to reference `createIssue()` instead of `_createIssue()`

**Edge Cases:** No external code depends on this method - it's purely internal to LinearSyncService.

**Context 7:** Add public `importIssuesFromLinear()` method to match ClickUp's `importTasksFromClickUp()`.

**Logic:** Implement a method that fetches issues from Linear and returns them in a structured format, similar to ClickUp's import method.

**Implementation (add new method):**
```typescript
/**
 * Import issues from Linear for a given team/project.
 * Returns a list of issues with their subtasks, comments, and attachments.
 */
public async importIssuesFromLinear(
  teamId: string,
  projectId?: string,
  includeSubtasks: boolean = true
): Promise<{ success: boolean; issues: LinearIssue[]; subtasks: LinearIssue[]; error?: string }> {
  const config = await this.loadConfig();
  if (!config?.setupComplete) {
    return { success: false, issues: [], subtasks: [], error: 'Linear not configured' };
  }

  const normalizedTeamId = String(teamId || '').trim();
  if (!normalizedTeamId) {
    return { success: false, issues: [], subtasks: [], error: 'Team ID is required' };
  }

  try {
    const filter = buildLinearIssueFilter(normalizedTeamId, projectId);
    const query = `
      query($filter: IssueFilter) {
        issues(filter: $filter) {
          nodes {
            id
            identifier
            title
            description
            state {
              id
              name
              type
            }
            priority
            assignee {
              id
              name
              email
            }
            project {
              id
              name
            }
            labels {
              nodes {
                id
                name
              }
            }
            createdAt
            updatedAt
            url
          }
        }
      }
    `;

    const result = await this.graphqlRequest(query, { filter });
    const issues = result.data?.issues?.nodes || [];

    // Fetch subtasks if requested
    let subtasks: LinearIssue[] = [];
    if (includeSubtasks) {
      for (const issue of issues) {
        const subtaskQuery = `
          query($parentId: String!) {
            issue(id: $parentId) {
              children {
                nodes {
                  id
                  identifier
                  title
                  description
                  state {
                    id
                    name
                  }
                  priority
                  assignee {
                    id
                    name
                  }
                  url
                }
              }
            }
          }
        `;
        const subtaskResult = await this.graphqlRequest(subtaskQuery, { parentId: issue.id });
        const children = subtaskResult.data?.issue?.children?.nodes || [];
        subtasks.push(...children);
      }
    }

    return { success: true, issues, subtasks };
  } catch (error) {
    return {
      success: false,
      issues: [],
      subtasks: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
```

**Edge Cases:** GraphQL query may need pagination for large result sets - add pagination support if needed.

---

### `src/services/TaskViewerProvider.ts`

**Context 8:** Delete handler (lines 12349-12370) currently only handles Linear archive.

**Logic:** Add ClickUp delete handling after Linear, using the same pattern.

**Implementation (add after line 12370, before `await log.deleteRunSheet(sessionId);`):**
```typescript
// Delete ClickUp task if delete sync is enabled
if (planRecord?.clickupTaskId) {
  try {
    const clickup = this._getClickUpService(resolvedWorkspaceRoot);
    const clickupConfig = await clickup.loadConfig();
    if (clickupConfig?.deleteSyncEnabled === true) {  // default false - require explicit opt-in
      const archiveResult = await clickup.archiveTask(planRecord.clickupTaskId);
      if (!archiveResult.success) {
        console.warn(
          `[TaskViewerProvider] _handleDeletePlan: ClickUp delete failed for task ${planRecord.clickupTaskId}: ${archiveResult.error}. ` +
          `Continuing with local deletion.`
        );
      }
    }
  } catch (archiveError) {
    console.warn(
      `[TaskViewerProvider] _handleDeletePlan: ClickUp delete threw for session ${sessionId}: ${archiveError}. ` +
      `Continuing with local deletion.`
    );
  }
}
```

**Edge Cases:** If ClickUp delete fails, we should still continue with local plan deletion (same as Linear behavior).

---

### `src/services/__tests__/LinearSyncService.createIssue.cleanup.test.ts`

**Context 9:** Test file references `_createIssue()` - needs update after rename.

**Implementation:** Search and replace `_createIssue` with `createIssue` throughout the test file.

---

### `src/webview/setup.html`

**Context 10:** Setup UI should include options for new ClickUp config fields.

**Logic:** Add checkboxes/toggles for `deleteSyncEnabled`, `completeSyncEnabled`, and `excludeBacklog` in the ClickUp setup section (around line 766, after existing options).

**Implementation:** Add UI controls similar to Linear's setup (lines 860-875):
```html
<div>
    <label class="startup-row" style="display:flex; align-items:flex-start; gap:8px;">
        <input id="clickup-option-delete-sync" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
        <span>Delete ClickUp tasks when plans are deleted in Switchboard</span>
    </label>
    <div style="font-size:9px; color:var(--text-secondary); margin-left:20px; margin-top:2px; line-height:1.3;">
        When enabled, deleting a plan in Switchboard will delete the corresponding task in ClickUp
    </div>
</div>
<div>
    <label class="startup-row" style="display:flex; align-items:flex-start; gap:8px;">
        <input id="clickup-option-complete-sync" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
        <span>Sync completed status to ClickUp</span>
    </label>
    <div style="font-size:9px; color:var(--text-secondary); margin-left:20px; margin-top:2px; line-height:1.3;">
        When enabled, moving a plan to COMPLETED in Switchboard will update the ClickUp task status
    </div>
</div>
<div>
    <label class="startup-row" style="display:flex; align-items:flex-start; gap:8px;">
        <input id="clickup-option-exclude-backlog" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
        <span>Exclude backlog tasks from sync</span>
    </label>
    <div style="font-size:9px; color:var(--text-secondary); margin-left:20px; margin-top:2px; line-height:1.3;">
        Keep the plugin sync lightweight by excluding backlog tasks. Only active tasks will be imported.
    </div>
</div>
```

**JavaScript Implementation (add to ClickUp config save logic around line 2669):**
```javascript
deleteSyncEnabled: document.getElementById('clickup-option-delete-sync')?.checked === true,
completeSyncEnabled: document.getElementById('clickup-option-complete-sync')?.checked === true,
excludeBacklog: document.getElementById('clickup-option-exclude-backlog')?.checked === true
```

**JavaScript Implementation (add to ClickUp config restore logic around line 2713):**
```javascript
setCheckboxState('clickup-option-delete-sync', state.deleteSyncEnabled === true);
setCheckboxState('clickup-option-complete-sync', state.completeSyncEnabled === true);
setCheckboxState('clickup-option-exclude-backlog', state.excludeBacklog === true);
```

---

## Impact Analysis

### Dependencies
- Depends on: `remove_delete_sync_default_true.md` plan (should be executed first to establish safe defaults for Linear)
- No other integration plans conflict with this work

### Risk Assessment

**Security Risks:** Low - all operations are opt-in (default false), no credential changes

**Performance Risks:** Low - additional config fields and optional features don't impact performance when disabled

**Compatibility Risks:**
- **Medium:** Renaming `_createIssue()` to `createIssue()` requires updating 2 internal callers and 1 test file
- **Low:** Adding new config fields is backward compatible (optional fields with defaults)

**Data Loss Risks:** Low - delete sync requires explicit opt-in (default false), operations are logged and fail gracefully

### Testing Strategy

**Unit Tests:**
- Test ClickUp `archiveTask()` method with DELETE endpoint
- Test Linear `createIssue()` (renamed from `_createIssue()`)
- Test Linear `importIssuesFromLinear()` method
- Test config normalization for new fields

**Integration Tests:**
- Test ClickUp delete sync in TaskViewerProvider
- Test backlog filtering in both services
- Test complete sync status mapping

**Manual Testing:**
- Verify setup UI controls save/restore correctly
- Test delete sync with actual ClickUp workspace
- Test import methods with real data

### Rollback Plan

If issues arise:
1. Revert config interface changes (remove new optional fields)
2. Revert `archiveTask()` method
3. Revert Linear method rename (`createIssue()` back to `_createIssue()`)
4. Revert TaskViewerProvider delete handler
5. Revert setup UI changes
6. All changes are additive - can be safely reverted without data loss

## Risks & Notes

**Verified Risks (Mitigated):**
- **Breaking Change:** `_createIssue()` has 2 verified internal callers (lines 1530, 1535) and 1 test file - all will be updated as part of implementation
- **ClickUp Archive Semantics:** Research confirms DELETE endpoint exists (`DELETE /api/v2/task/{task_id}`) - using native deletion mechanism, not status change approximation
- **API Discovery:** ClickUp DELETE endpoint researched and documented - returns 204 on success per API docs
- **Backlog Status Identification:** Existing heuristic (status name contains "backlog") is appropriate and already tested in `importTasksFromClickUp`

**Remaining Considerations:**
- **Config Migration:** No automatic migration planned for existing configs - users will need to manually enable new features via setup UI
- **Status Mapping:** Adding complete sync to ClickUp requires mapping Switchboard's "completed" status to ClickUp status values - use existing `columnMappings` logic
- **GraphQL Pagination:** Linear `importIssuesFromLinear()` may need pagination for large result sets - add if needed

## Source Credibility Assessment

**High Credibility Sources:**
- ClickUp API Documentation (developer.clickup.com) - official API reference
- Linear API Documentation (linear.app/docs) - official GraphQL API docs
- Integration Best Practices (ServiceNow, Salesforce, DZone) - industry-standard patterns

**Medium Credibility Sources:**
- Stack Overflow discussions - community-verified solutions
- Reddit threads - anecdotal evidence, used for context only

**Codebase Sources:**
- Direct code analysis of ClickUpSyncService.ts, LinearSyncService.ts, TaskViewerProvider.ts
- Test files for behavioral verification

## Knowledge Gaps

**Resolved:**
- ClickUp DELETE endpoint existence and usage ✓
- Linear `archivedAt` mutation pattern ✓
- `_createIssue()` caller count and locations ✓
- Backlog filtering approaches for both platforms ✓

**Remaining:**
- Complete sync status mapping for ClickUp - needs implementation-time decision on which ClickUp status represents "completed"
- GraphQL pagination requirements for Linear import - may need to add pagination based on testing

## Recommended Next Steps

1. Execute `remove_delete_sync_default_true.md` plan first to establish safe defaults
2. Implement ClickUp config field additions (Steps 1-3)
3. Implement ClickUp `archiveTask()` using DELETE endpoint (Step 6)
4. Rename Linear `_createIssue()` to `createIssue()` and update callers (Step 4)
5. Add Linear `importIssuesFromLinear()` method (Step 5)
6. Add TaskViewerProvider delete handler for ClickUp (Step 7)
7. Add setup UI controls for new ClickUp fields
8. Update test file for method rename
9. Test all changes with real ClickUp/Linear workspaces

## Recommendation

Send to Coder

---

## Reviewer Notes (Deep Planning Edition)

### Stage 1: Grumpy Review (Adversarial)
* "The deep planning research actually paid off here. You found that ClickUp has a DELETE endpoint, which means you don't need that hacky status-change-to-'closed' approach from the original plan. Good catch.

You also verified `_createIssue()` has exactly 2 internal callers plus a test file - that's concrete data, not wishful thinking. The original plan just said 'search for callers' without actually doing it. This version is much better.

The backlog filtering approach is sound - Linear has a built-in 'backlog' state type, ClickUp uses status names. The existing heuristic (checking for 'backlog' in status name) is already tested in `importTasksFromClickUp`, so you're reusing proven logic.

The plan correctly excludes justified differences like hierarchy model and categorization. Good focus on actual API parity issues." [NIT]

### Stage 2: Balanced Synthesis
* **What's good:** Deep planning research provided concrete API documentation (ClickUp DELETE endpoint, Linear `archivedAt` mutation), verified caller counts for breaking changes, and identified existing backlog filtering logic that can be reused. The implementation plan is now based on actual API capabilities rather than assumptions.
* **What's improved over original:** (1) ClickUp `archiveTask()` now uses DELETE endpoint instead of status change hack - matches Linear's native deletion pattern. (2) `_createIssue()` caller count verified (2 internal + 1 test) instead of vague 'search for callers' note. (3) Backlog filtering reuses existing heuristic instead of requiring new user input or complex heuristics. (4) Added comprehensive risk assessment, testing strategy, and rollback plan.
* **Risks:** Minimal - breaking change has verified caller count, API endpoints are documented, all new features are opt-in (default false). The main remaining gap is deciding which ClickUp status represents "completed" for complete sync - this is an implementation-time decision using existing `columnMappings` logic.

### Validation Results
* **Files Changed:** `src/services/ClickUpSyncService.ts`, `src/services/LinearSyncService.ts`, `src/services/TaskViewerProvider.ts`, `src/services/__tests__/LinearSyncService.createIssue.cleanup.test.ts`, `src/webview/setup.html`
* **Status:** Plan significantly improved through deep planning - API research corrected implementation approach, caller verification reduced breaking change risk, existing backlog logic reuse reduces implementation complexity.
* **Code Fixes Applied:** None yet - plan is ready for implementation.
* **Remaining Risks:** Complete sync status mapping for ClickUp needs implementation-time decision. GraphQL pagination may be needed for large Linear imports - add if testing reveals need.
