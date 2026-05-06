# Fix Planning Panel Random Context on Login

## Goal
Prevent the planning panel from automatically setting imported documents as the active planning context. The design doc link should only be set when users explicitly click "Set as active planning context".

## Metadata
**Tags:** frontend, UI, bugfix
**Complexity:** 3

## User Review Required
No

## Complexity Audit

### Routine
- Add `skipDesignDocLink: true` parameter to 5 existing method calls
- All changes confined to single file (`PlanningPanelProvider.ts`)
- No new logic patterns — reuses existing option flag
- Zero breaking changes to user-facing functionality

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None — all operations are synchronous within handler scope
- **Security**: None — no new security surfaces introduced
- **Side Effects**: Clarification: The `_sendActiveDesignDocState()` call at line 1226 will still execute after import, but it will simply broadcast the unchanged state since the design doc wasn't modified
- **Dependencies & Conflicts**: None (kanban board query shows empty state across all columns)

## Dependencies
None

## Adversarial Synthesis
Key risks: Missing any of the 5 call sites could leave residual auto-setting behavior, causing inconsistent user experience. The `writeFromPlanningCache` and `writeContentToDocsDir` methods have different signatures — must ensure options object is correctly formed for each. Mitigations: All 5 locations identified through grep search; verified method signatures in `PlannerPromptWriter.ts`; will validate each change compiles.

## Proposed Changes

### src/services/PlanningPanelProvider.ts

**Context**: The `PlannerPromptWriter._writeDocToDocsDir()` method accepts an options object with `skipDesignDocLink` flag. When true, it bypasses the VSCode configuration update that sets `planner.designDocLink`. Currently, this flag is not passed during import operations, causing every imported document to become the active planning context.

**Logic**:
1. Pass `skipDesignDocLink: true` for `writeContentToDocsDir` calls in `_handleAppendToPlannerPrompt`
2. Pass `skipDesignDocLink: true` for `writeFromPlanningCache` calls in `_handleAppendToPlannerPrompt`
3. Pass `skipDesignDocLink: true` for all `writeContentToDocsDir` calls in `_handleImportFullDoc` (local-folder, page imports, fallback single doc)

**Implementation**:

#### 1. Update `_handleAppendToPlannerPrompt` (around line 1206-1231)

```typescript
// Line 1211: Add skipDesignDocLink option
result = await this._plannerPromptWriter.writeContentToDocsDir(workspaceRoot, content, docName, sourceId, { skipDesignDocLink: true });

// Line 1213: Add skipDesignDocLink option  
result = await this._plannerPromptWriter.writeFromPlanningCache(workspaceRoot, sourceId, docId, docName, { skipDesignDocLink: true });
```

#### 2. Update `_handleImportFullDoc` local-folder branch (around line 1468)

```typescript
// Line 1468-1473: Add skipDesignDocLink option
const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
    workspaceRoot,
    result.content || '',
    docName,
    sourceId,
    { skipDesignDocLink: true }
);
```

#### 3. Update `_handleImportFullDoc` page import loop (around line 1513)

```typescript
// Line 1513-1519: Add skipDesignDocLink option
const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
    workspaceRoot,
    result.content,
    pageDocName,
    sourceId,
    { pageOrder: pageIndex, parentDocName: docName, skipDesignDocLink: true }
);
```

#### 4. Update `_handleImportFullDoc` fallback single doc import (around line 1575)

```typescript
// Line 1575-1580: Add skipDesignDocLink option
const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
    workspaceRoot,
    content,
    docName,
    sourceId,
    { skipDesignDocLink: true }
);
```

**Edge Cases**:
- The `_sendActiveDesignDocState()` call after import (line 1226) remains unchanged — it broadcasts the current state, which will now correctly reflect the unchanged design doc context
- The "Set as active planning context" button (handled by `_handleSetActivePlanningContext` at line 839) continues to work as designed — it explicitly sets the design doc link via VSCode configuration
- Import failures (writeResult.error) are handled before any state changes, maintaining consistency

## Verification Plan

### Automated Tests
None — UI behavior fix, manual verification sufficient.

### Manual Verification Steps
1. Open planning panel — should show "None" or previously explicitly set context
2. Import a document from any source (ClickUp, Linear, Notion, local-folder) — should import without changing active context
3. Click "Set as active planning context" on a document — should set that document as active context
4. Close and reopen the planning panel — should persist the explicitly set context
5. Import another document — should not change the active context
6. Test multi-page document import — verify none of the pages become active context
7. Test append to planner prompt — verify document is added to prompt without becoming active context

**Expected behavior after fix**:
- Documents import silently without hijacking the planning context
- Users must explicitly set their planning context via the UI button
- Context persists across sessions as before

Send to Coder

---

## Original Problem Statement (Preserved)

## Problem
The planning panel sets a random document as the active planning context every time the user logs in or opens the panel. This happens because:

1. When any document is imported via the planning panel, `PlannerPromptWriter._writeDocToDocsDir()` automatically sets the VSCode configuration `planner.designDocLink` to the newly imported document path
2. When the planning panel opens, `_sendActiveDesignDocState()` reads this persisted configuration and displays that document as the active planning context
3. The `skipDesignDocLink` option exists in the API but is not being used during import operations.

## Root Cause
In `src/services/PlannerPromptWriter.ts` lines 78-89:
```typescript
if (!options.skipDesignDocLink) {
    // Point designDocLink at the structured docs/ path AND enable the feature
    await vscode.workspace.getConfiguration('switchboard').update(
        'planner.designDocLink',
        newDocPath,
        vscode.ConfigurationTarget.Workspace
    );
    await vscode.workspace.getConfiguration('switchboard').update(
        'planner.designDocEnabled',
        true,
        vscode.ConfigurationTarget.Workspace
    );
```

This code runs whenever a document is written to `.switchboard/docs/`, which includes:
- Importing full documents from online sources (ClickUp, Linear, Notion)
- Appending to planner prompt
- Importing pages from multi-page documents

## Solution
Pass `skipDesignDocLink: true` for all import operations so documents are not automatically set as the design doc. The design doc link should only be set when the user explicitly clicks "Set as active planning context" in the planning panel.

## Original Implementation Steps (Preserved)

### 1. Update `_handleAppendToPlannerPrompt` in `PlanningPanelProvider.ts`
- Line 1211: Pass `skipDesignDocLink: true` to `writeContentToDocsDir()`
- Line 1213: Pass `skipDesignDocLink: true` to `writeFromPlanningCache()`

### 2. Update `_handleImportFullDoc` in `PlanningPanelProvider.ts`
- Line 1468: Pass `skipDesignDocLink: true` to `writeContentToDocsDir()` for local-folder imports
- Line 1513: Pass `skipDesignDocLink: true` to `writeContentToDocsDir()` for page imports
- Line 1575: Pass `skipDesignDocLink: true` to `writeContentToDocsDir()` for fallback single doc imports

### 3. Verify `_handleSetActivePlanningContext` still works correctly
- This method (line 839) explicitly sets the design doc link when user clicks "Set as active planning context"
- This should remain unchanged as it's the intended user action

### 4. Test the fix
- Import a document from any source
- Verify the document is imported but NOT set as active planning context
- Click "Set as active planning context" on a document
- Verify that document is now set as active context
- Close and reopen the planning panel
- Verify the explicitly set context persists
- Import another document
- Verify the active context does NOT change to the newly imported document

## Files to Modify
- `src/services/PlanningPanelProvider.ts` (5 locations: lines 1211, 1213, 1468, 1513, 1575)

## Risk Assessment
- **Low risk**: This change only affects when the design doc link is set during import
- The "Set as active planning context" button will still work as intended
- No breaking changes to existing functionality
- Users will need to explicitly set their planning context after this fix (which is the correct behavior)

## Reviewer Pass - Completed

### Stage 1: Grumpy Adversarial Critique

**CRITICAL**: None found. The implementation correctly adds `skipDesignDocLink: true` to all 5 required call sites.

**MAJOR**: None found. All method signatures match the expected patterns.

**NIT**: 
- Line 1211, 1213: The options object is correctly formed for both `writeContentToDocsDir` and `writeFromPlanningCache` methods.
- Line 1468-1473: Local-folder import correctly passes `skipDesignDocLink: true` as the 5th parameter.
- Line 1514-1519: Page import correctly includes `skipDesignDocLink: true` alongside existing `pageOrder` and `parentDocName` options.
- Line 1576-1581: Fallback single doc import correctly passes `skipDesignDocLink: true`.

**Observations**: 
- The `_sendActiveDesignDocState()` call at line 1226 correctly remains in place — it broadcasts the unchanged state as designed.
- The `_handleSetActivePlanningContext` method (line 839) was correctly left untouched — this is the intentional user action path.

### Stage 2: Balanced Synthesis

**What to keep**: All 5 call sites have been correctly updated with `skipDesignDocLink: true`. The implementation exactly matches the plan specification.

**What was fixed**: N/A — no material issues found. The implementation is correct as-is.

**What can defer**: Nothing. All requirements met.

### Code Fixes Applied

No fixes required — implementation was correct.

### Validation Results

**Compilation**: ✅ Passed (`npm run compile` succeeded, webpack compiled successfully in 9312ms)

**Typecheck**: ⚠️ 2 pre-existing errors unrelated to this change (import path extensions in `ClickUpSyncService.ts` and `KanbanProvider.ts` at lines 2114 and 3718)

**Files Changed**: 
- `src/services/PlanningPanelProvider.ts` (5 locations: lines 1211, 1213, 1468, 1519, 1581)

### Remaining Risks

None. The implementation correctly prevents imported documents from automatically becoming the active planning context while preserving the explicit "Set as active planning context" button functionality.

---

## Validation
After implementing the fix:
1. Open planning panel - should show "None" or previously explicitly set context
2. Import a document - should import without changing active context
3. Set active context explicitly - should persist across sessions
4. Import another document - should not change the active context
