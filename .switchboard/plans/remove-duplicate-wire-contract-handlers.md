# Remove Duplicate Wire Contract Handlers

## Goal
Remove all 10 redundant integration message handlers from KanbanProvider.ts that were added by a rogue agent on the `planning-features` branch. These handlers duplicate functionality that already exists in TaskViewerProvider (for the Kanban/Task webview) and PlanningPanelProvider (for the Planning panel). None of them are needed in KanbanProvider.

## Metadata
- **Tags:** [reliability, bugfix]
- **Complexity:** 3

## User Review Required
No

## Complexity Audit
### Routine
- Removing 10 unused message handler `case` blocks from the switch statement in `_handleMessage` (lines 5665–6037).
- Removing `_getLocalFolderService` getter method (lines 1182–1189), `_localFolderServices` map (line 124), and `LocalFolderService` import (line 32) — these are only reachable through the dead handlers.
- Removing `_getNotionBrowseService` getter method (lines 1173–1180) and `_notionBrowseServices` map (line 123) — these are only called internally from the dead `searchNotionPages` handler. (PlanningPanelProvider gets its NotionBrowseService via a separate factory in extension.ts, not through this method.)
- Deleting the test file `planning-modal-request-id-wire-contract.test.js` — it tests handlers that are all being removed.

### Complex / Risky
- `_getNotionBrowseService` is exposed to `PlanningPanelProvider` via `extension.ts` line 1410 as `(kanbanProvider as any)._getNotionBrowseService(root)`. After removing the method from KanbanProvider, this call will fail at runtime. The fix: change extension.ts to instantiate `NotionBrowseService` directly (like it already does for `LocalFolderService` on line ~1399: `new LocalFolderService(root)`), or move the factory into PlanningPanelProvider itself.

## Edge-Case & Dependency Audit
- **Race Conditions**: None. The removed handlers are never invoked by any webview that routes to KanbanProvider.
- **Security**: None.
- **Side Effects**: None. On `main`, `implementation.html` sends `fetchNotionContent` and `getNotionFetchState` messages, but these are handled by TaskViewerProvider (lines 5011, 5047 on main), not KanbanProvider. The rogue agent duplicated these handlers into KanbanProvider where they were never needed.
- **Dependencies & Conflicts**:
  - `extension.ts` line 1410 exposes `_getNotionBrowseService` to `PlanningPanelProvider`. This is the one external consumer that must be updated when the method is removed from KanbanProvider.
  - `extension.ts` lines 1388–1391 expose `_getNotionService`, `_getLinearDocsAdapter`, `_getClickUpDocsAdapter` — these are NOT being removed (they predate the rogue agent's work and are used by other providers).
  - `TaskViewerProvider.ts` has its own independent handlers for `fetchNotionContent` and `getNotionFetchState` — these are the real handlers and are unaffected.
  - `PlanningPanelProvider.ts` has its own `_getLocalFolderService` and `setLocalFolderPath` handler — separate and unaffected.

## Dependencies
None

## Adversarial Synthesis
Key risks: The `_getNotionBrowseService` method is referenced externally by PlanningPanelProvider via extension.ts, so removing it from KanbanProvider requires updating that call site. Mitigations: The fix is a one-line change in extension.ts to instantiate NotionBrowseService directly (matching the existing pattern for LocalFolderService). All 10 handlers are confirmed dead code — on `main`, the same message types are handled by TaskViewerProvider, and KanbanProvider had zero handlers for them.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context/Implementation**:
  - **REMOVE** the following (all added by the rogue agent, all dead code in KanbanProvider):
    - `NotionBrowseService` import (line 31) — only used by `_getNotionBrowseService`
    - `LocalFolderService` import (line 32) — only used by `_getLocalFolderService`
    - `_notionBrowseServices` map (line 123) — only used by `_getNotionBrowseService`
    - `_localFolderServices` map (line 124) — only used by `_getLocalFolderService`
    - `_getNotionBrowseService` method (lines 1173–1180) — only called from dead `searchNotionPages` handler
    - `_getLocalFolderService` method (lines 1182–1189) — only called from dead handlers
    - `getNotionFetchState` handler (lines 5665–5702) — TaskViewerProvider handles this
    - `fetchNotionContent` handler (lines 5703–5741) — TaskViewerProvider handles this
    - `searchNotionPages` handler (lines 5742–5773) — no webview caller
    - `getLocalFolderFetchState` handler (lines 5774–5813) — no webview caller
    - `setLocalFolderPath` handler (lines 5814–5846) — PlanningPanelProvider has its own
    - `fetchLocalFolderContent` handler (lines 5847–5885) — no webview caller
    - `getLinearFetchState` handler (lines 5886–5923) — no webview caller
    - `fetchLinearContent` handler (lines 5924–5961) — no webview caller
    - `getClickUpFetchState` handler (lines 5962–5999) — no webview caller
    - `fetchClickUpContent` handler (lines 6000–6037) — no webview caller

- **Edge Cases**:
  - The `searchNotionPages` handler (line 5742) calls `_getNotionBrowseService` (line 5754). Both are being removed together — no orphaned reference.
  - The `setLocalFolderPath` handler (line 5814) has a bug: its error response sends `type: 'localFolderFetchState'` instead of `localFolderPathUpdated` (line 5840). This confirms it was never properly integrated.

### `src/extension.ts`
- **Context/Implementation**:
  - **CHANGE** line 1410 from `(kanbanProvider as any)._getNotionBrowseService(root)` to `new NotionBrowseService(root, (kanbanProvider as any)._getNotionService(root))` — this matches the existing pattern where `LocalFolderService` is instantiated directly on line ~1399.
  - This requires adding `import { NotionBrowseService } from './services/NotionBrowseService';` at the top of extension.ts if not already present.

### `src/test/planning-modal-request-id-wire-contract.test.js`
- **Context/Implementation**:
  - **DELETE** the entire file. It tests the 10 handlers being removed from KanbanProvider. The test name references a "planning modal" that doesn't exist, and all 21 scenarios test dead code.
  - If requestId echo regression coverage is desired for the retained TaskViewerProvider handlers, a new test should be written against TaskViewerProvider — but that is out of scope for this plan.

## Background

**1. KanbanProvider.ts — 428 lines changed**
What: Added 10 integration message handlers (getNotionFetchState, fetchNotionContent, searchNotionPages, getLocalFolderFetchState, setLocalFolderPath, fetchLocalFolderContent, getLinearFetchState, fetchLinearContent, getClickUpFetchState, fetchClickUpContent) plus imports and private service maps for NotionBrowseService and LocalFolderService.

Why: This was the primary task inherited from the truncated prior conversation — implementing missing handlers to satisfy planning-modal-request-id-wire-contract.test.js (21 test scenarios). There is no planning modal, so that seems like an outdated test.

On `main`, `implementation.html` sends `fetchNotionContent` and `getNotionFetchState` messages, but these are handled by **TaskViewerProvider** (not KanbanProvider). The rogue agent duplicated these handlers into KanbanProvider where they were never needed. The other 8 handlers have no webview callers at all.

## Verification Plan

### Automated Tests
- TypeScript compilation must pass with no errors after removing the dead code.
- Delete the test file and confirm no other test references it.
- Run the full test suite to verify no regressions.

### Manual Testing
- Verify that the Kanban/Task panel's "Sync from Notion" button still works correctly (this is handled by TaskViewerProvider, which is unaffected).
- Verify that the Planning panel's online docs tab still works correctly for importing from Notion, Linear, ClickUp, and Local Folder sources (these use PlanningPanelProvider, which is unaffected).
- Verify that the Kanban board functions normally without any errors.
- Check that no webview console errors appear related to the removed message handlers.

**Recommendation:** Send to Intern
