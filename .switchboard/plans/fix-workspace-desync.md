# Fix Backend-UI Workspace Selection Desync

## Goal

Resolve the state desync between the backend's `resolvedWorkspaceRoot` and the UI's `currentWorkspaceRoot` by removing spoofed mapping logic, and allow the UI dropdown to respect intentional backend-driven workspace changes while preventing unintended DOM clobbering.

## Metadata

- **Tags:** backend, frontend, bugfix, reliability
- **Complexity:** 5

## User Review Required

No schema or database changes required. **Behavioral change:** removing `workspaceDatabaseMappings` selection-spoofing means the dropdown will now show the actual resolved workspace (e.g., a child workspace) instead of the mapped parent. This is an intentional transparency improvement — the previous behavior was architecturally broken (cards from B, dropdown showed A).

## Complexity Audit

### Routine
- Modifying `updateWorkspaceSelector` in `kanban.html` to accept an `explicitRoot` parameter (`src/webview/kanban.html:2984-3014`).
- Removing rogue state mutations (`currentWorkspaceRoot = msg.workspaceRoot`) in `customAgents` handlers in both `kanban.html:4814` and `implementation.html:3064`.
- Removing the three identical `workspaceDatabaseMappings` logic blocks in `KanbanProvider.ts` (lines 951-978, 1699-1725, 1844-1870).

### Complex / Risky
- The `explicitRoot` guard logic must correctly distinguish intentional backend workspace switches from incidental updates. The `previousRoot !== ''` condition means on cold start (initial load), `explicitChange` is false — but this is safe because there is no `savedSelection` to conflict with on first render, and the fallback path at line 3003-3012 already uses `currentWorkspaceRoot`.

## Edge-Case & Dependency Audit

### Race Conditions
- The previous UI fix created a race condition where backend-driven changes were ignored if the user had previously selected a valid option. By conditionally applying `explicitRoot`, we resolve the race condition where `innerHTML` clobbers the DOM while preserving backend authority.

### Security
- None.

### Side Effects
- Removing the `workspaceDatabaseMappings` selection-spoofing in `KanbanProvider.ts` means the dropdown will accurately show the workspace used to fetch cards (e.g., if a child workspace is resolved, the dropdown shows the child workspace, not the control plane parent). This increases transparency.
- Removing `currentWorkspaceRoot = msg.workspaceRoot` from `customAgents` handlers means the agents tab will no longer silently change the active workspace context. The `customAgents` message is purely informational and should not affect workspace state.

### Dependencies & Conflicts
- Follows up on the implementation of `.switchboard/plans/fix-workspace-switching-issue.md`.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) `implementation.html` has the same rogue `customAgents` mutation as `kanban.html` — must be fixed in both or the desync persists in that view. (2) Cold-start `explicitChange` guard is safe due to no competing `savedSelection`, but should be documented. (3) Removing `workspaceDatabaseMappings` spoofing is a behavioral change for users with that config enabled, but justified since the feature was architecturally broken. Mitigations: fix both webviews, add inline comment explaining the cold-start guard, note the transparency improvement in User Review Required.

## Problem

1. **Backend Desync:** In `KanbanProvider.ts`, when `workspaceDatabaseMappings` is enabled, the backend spoofs the `selectionRoot` it sends to the UI in `updateWorkspaceSelection` (mapping a child workspace to its parent). However, the cards sent to the board are fetched using the original `resolvedWorkspaceRoot`. This creates a split-brain state where the UI dropdown shows Workspace A but the cards are from Workspace B.
2. **Frontend Masking:** The UI permanently prioritizes `savedSelection` over the backend's `currentWorkspaceRoot`, meaning valid backend workspace switches are ignored. 
3. **Rogue State Mutations:** The `customAgents` message handler in both `kanban.html` and `implementation.html` silently mutates `currentWorkspaceRoot` without updating the UI, triggering fallback paths that clobber the user's selection.

## Root Cause Analysis

### Location
- `src/services/KanbanProvider.ts` (lines 951-978, 1699-1725, 1844-1870)
- `src/webview/kanban.html` (`updateWorkspaceSelector()` at line 2984, `case 'customAgents'` at line 4810)
- `src/webview/implementation.html` (`case 'customAgents'` at line 3061)

### Issue Details
- The UI was forced to lock into `savedSelection` because stray messages were silently updating `currentWorkspaceRoot`.
- The backend actively deceives the UI about the active workspace to try to group mapped items, but fails to fetch cards for the grouped item, causing a visual desync.
- The `customAgents` handler in `implementation.html` has the same rogue mutation as `kanban.html`, meaning the desync affects multiple webviews.

## Proposed Changes

### `src/services/KanbanProvider.ts`
1. **Block 1** (`_refreshBoardWithData`, lines 951-978): Delete lines 952-978 (the entire `try { const cfg = vscode.workspace.getConfiguration... } catch { }` block). Change line 982 from `workspaceRoot: selectionRoot` to `workspaceRoot: resolvedWorkspaceRoot`.
2. **Block 2** (`_refreshBoardImpl`, lines 1699-1725): Delete lines 1700-1725 (identical mapping block). Change line 1729 from `workspaceRoot: selectionRoot` to `workspaceRoot: resolvedWorkspaceRoot`.
3. **Block 3** (original kanban post message logic, lines 1844-1870): Delete lines 1845-1870 (identical mapping block). Change line 1874 from `workspaceRoot: selectionRoot` to `workspaceRoot: resolvedWorkspaceRoot`.
4. After all three deletions, the `let selectionRoot = resolvedWorkspaceRoot;` declaration on lines 951/1699/1844 becomes unused — remove it and inline `resolvedWorkspaceRoot` directly in the `postMessage` call.

**Context:** Each block follows the same pattern: declare `let selectionRoot = resolvedWorkspaceRoot`, then attempt to override it via `workspaceDatabaseMappings` config. The fix is to remove the override and use `resolvedWorkspaceRoot` directly.

**Edge Cases:** If `workspaceDatabaseMappings` config is present but `enabled: false`, the current code already falls through — no behavioral change for that case. If `enabled: true`, the spoofing is removed (the broken behavior is fixed).

### `src/webview/kanban.html`
1. **`updateWorkspaceSelector`** (line 2984): Update signature to `updateWorkspaceSelector(explicitRoot = null)`.
   - After rebuilding options (line 2997), before the `savedSelection` check (line 3000), add:
     ```javascript
     // If the backend explicitly changed workspace, honor that over savedSelection
     if (explicitRoot && workspaceItems.some(item => item.workspaceRoot === explicitRoot)) {
         select.value = explicitRoot;
         return;
     }
     ```
   - This short-circuits before `savedSelection` restoration when the backend intentionally changed the active workspace.
2. **`updateWorkspaceSelection` handler** (lines 4471-4479): Replace with:
   ```javascript
   case 'updateWorkspaceSelection':
       const previousRoot = currentWorkspaceRoot;
       currentWorkspaceRoot = msg.workspaceRoot || '';
       activeWorkspaceFilter = msg.activeFilter || null;
       workspaceItems = Array.isArray(msg.workspaces) ? msg.workspaces : [];
       currentControlPlaneMode = msg.controlPlaneMode || msg.mode || 'none';
       currentControlPlaneRoot = msg.controlPlaneRoot || msg.effectiveControlPlaneRoot || '';
       
       // On cold start previousRoot is '', so explicitChange is false — safe because
       // there's no savedSelection to conflict with; the fallback path handles it.
       const explicitChange = previousRoot !== '' && previousRoot !== currentWorkspaceRoot;
       updateWorkspaceSelector(explicitChange ? currentWorkspaceRoot : null);
       updateWorkspaceFilterBadge();
       break;
   ```
3. **`customAgents` handler** (line 4813-4815): Remove the three lines:
   ```javascript
   if (msg.workspaceRoot) {
       currentWorkspaceRoot = msg.workspaceRoot;
   }
   ```
   The `customAgents` message is informational only — it should not mutate workspace state.

### `src/webview/implementation.html`
1. **`customAgents` handler** (lines 3061-3064): Remove the same rogue mutation:
   ```javascript
   if (message.workspaceRoot) {
       currentWorkspaceRoot = message.workspaceRoot;
   }
   ```
   Same rationale as `kanban.html` — the `customAgents` message should not drive workspace selection.

## Implementation Steps

1. Modify `KanbanProvider.ts` — remove all three `workspaceDatabaseMappings` blocks and inline `resolvedWorkspaceRoot` (lines 951-982, 1699-1729, 1844-1874).
2. Modify `kanban.html` — add `explicitRoot` parameter to `updateWorkspaceSelector` (line 2984).
3. Modify `kanban.html` — update `updateWorkspaceSelection` handler with `explicitChange` logic (lines 4471-4479).
4. Modify `kanban.html` — remove `currentWorkspaceRoot` assignment from `customAgents` handler (lines 4813-4815).
5. Modify `implementation.html` — remove `currentWorkspaceRoot` assignment from `customAgents` handler (lines 3063-3064).

## Verification Plan

### Automated Tests
- **Unit test for `updateWorkspaceSelector` logic:** Test that when `explicitRoot` is provided and exists in `workspaceItems`, it takes priority over `savedSelection`. Test that when `explicitRoot` is null, `savedSelection` is restored as before. Test cold-start path (no savedSelection, no explicitRoot) falls back to `currentWorkspaceRoot`.
- **Compile check:** `npm run compile` must pass with no type errors after removing `selectionRoot` variable declarations.

### Manual Verification Steps
1. Open the Kanban view.
2. Ensure the dropdown displays the workspace corresponding to the cards shown on the board.
3. Switch active workspaces (via the extension or active text editor, depending on how `KanbanProvider` is triggered). 
4. Ensure the UI dropdown correctly follows the backend's intentional switch, updating to the new workspace.
5. Trigger a `customAgents` refresh or other non-navigation message and verify the dropdown does *not* reset or switch.
6. Open the Implementation view and repeat steps 2-5 to verify the `implementation.html` fix.

## Validation

After implementing the fix, verify that:
- `npm run compile` completes without errors.
- The UI dropdown accurately reflects the backend's active workspace.
- The UI correctly processes intentional workspace shifts while protecting against random DOM clobbers.
- The Implementation view does not experience workspace desync after `customAgents` messages.

---

**Send to Coder** (complexity ≤ 6)

## Reviewer Pass (Grumpy & Balanced)

### 🚨 Stage 1: Grumpy Review (Adversarial Findings)
1. **CRITICAL FINDING: Missing the True Source of the UI Dropdown Spoofing.** The plan proudly eliminated `workspaceDatabaseMappings` spoofing for `selectionRoot` to send the correct child `resolvedWorkspaceRoot` to the UI. However, the plan completely missed `KanbanProvider.ts`'s `_getWorkspaceItems()` method! This method STILL forcefully overwrote the entire `workspaceItems` array with the `parentFolder` when `workspaceDatabaseMappings` was enabled. Because the UI's `updateWorkspaceSelector` logic was updated to strictly check if `explicitRoot` exists in `workspaceItems` before honoring it, it ALWAYS failed to find the child root in the array. This forced the UI dropdown to silently fall back to selecting the parent mapping option while rendering cards from the child workspace — exactly recreating the split-brain state we sought to destroy! The `explicitRoot` guard is useless if the `explicitRoot` isn't actually sent in the list of available options!
2. **NIT FINDING: Cold Start Guard Documentation.** The plan states that `explicitChange` is safe on cold start because `previousRoot` is `''`. While true, it relies on implicit DOM initialization state. It's safe, but only barely.

### ⚖️ Stage 2: Balanced Synthesis & Actionable Fixes
- **What to Keep:** The core logic of sending `resolvedWorkspaceRoot` from the backend and the new `explicitChange` guard in the frontend are conceptually correct and performant. They should be retained. The removal of the `customAgents` rogue state mutations was also correct.
- **What to Fix Now (CRITICAL):** We must update `_getWorkspaceItems()` in `KanbanProvider.ts` to populate the `workspaceItems` array using the *actual* allowed roots from `_getAllowedRoots()`, rather than spoofing the array with the `parentFolder` mapping config. This ensures the dropdown options accurately reflect the real child workspaces being used, satisfying the plan's goal of "increasing transparency" and allowing the UI `explicitChange` guard to successfully find the child workspace in the dropdown options.
- **What can Defer:** Making the cold-start DOM logic more explicit. The current `previousRoot !== ''` check is sufficient.

### 🛠️ Execution & Verification
- **Code Fixes Applied:** Updated `_getWorkspaceItems()` in `src/services/KanbanProvider.ts` to derive the dropdown items directly from `_getAllowedRoots()`. This maps all valid VSCode workspace folders and allowed mapped folders directly to their real paths, completely eliminating the parent mapping spoofing.
- **Files Modified:** 
  - `src/services/KanbanProvider.ts` (Modified `_getWorkspaceItems`)
- **Verification Results:** 
  - Typecheck (`npm run compile`) passed successfully with 0 errors.
  - The UI dropdown will now receive the true `resolvedWorkspaceRoot` *and* find it inside the `workspaces` array, successfully honoring backend-driven workspace selection.

**ACCURACY VERIFICATION COMPLETE**
