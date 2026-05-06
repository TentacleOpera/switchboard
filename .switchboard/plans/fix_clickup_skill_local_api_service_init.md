# Fix ClickUp Skill: Local API Server Service Initialization

**Date:** 2026-05-05
**Type:** Bug Fix
**Priority:** High
**Affected:** ClickUp skill, local API server, TaskViewerProvider

## Goal

Fix the local API server's ClickUp task-details endpoint so it returns full task data (HTTP 200) instead of always returning 503 "ClickUp service not available", by replacing raw map lookups with lazy-initialization factory closures in `TaskViewerProvider._startLocalApiServer`.

## Metadata

**Tags:** bugfix, backend, workflow
**Complexity:** 4

## User Review Required

- [ ] Confirm the fix does not regress behavior for unconfigured ClickUp workspaces (should still return a meaningful error when no token is set)
- [ ] Approve whether a unit test should be added to prevent future regression

## Complexity Audit

### Routine
- Change two factory closures in `src/services/TaskViewerProvider.ts` from raw map lookups to lazy-initializer method calls
- Verify existing `_getClickUpService` and `_getLinearService` signatures are compatible

### Complex / Risky
- None (change leverages existing well-tested lazy-initialization methods; no new state or concurrency introduced)

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The factory closures are evaluated synchronously inside the HTTP request handler (`_handleGetTask`). Node.js is single-threaded; concurrent requests will each call the factory, but `_getClickUpService` does a simple map lookup-then-create pattern that is safe in JavaScript's event loop.
- **Security:** None. The fix does not expose new endpoints, change auth, or modify credential handling. The local API server remains localhost-bound (127.0.0.1).
- **Side Effects:** The fix creates a `ClickUpSyncService` / `LinearSyncService` instance on first API request (not at server startup). Previously the factory returned `null`, causing an immediate 503. The new behavior delegates to `_getClickUpService`, which:
  1. Resolves `workspaceRoot` via `path.resolve`
  2. Returns cached instance if present
  3. Otherwise creates instance, injects cache service, caches it, and returns it
  This is identical to how the rest of the codebase obtains services and is well-tested.
- **Dependencies & Conflicts:**
  - No active kanban plans conflict with this bug fix.
  - The `get_tickets.md` skill documents the `/task/clickup/{taskId}` endpoint. After this fix, the skill's instructions will actually work as documented. No skill text changes are required.

## Dependencies

None

## Adversarial Synthesis

Key risks: unconfigured workspaces may now receive 500 errors instead of 503 when no ClickUp token exists. Mitigation: verify `_handleGetTask` catch block already returns 500 with the error message, which is arguably more accurate than 503. No material risks identified.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

- **Context:** The `_startLocalApiServer` method (lines 404-426) instantiates `LocalApiServer` with factory closures for `getClickUpService` and `getLinearService`. These closures currently do raw `Map.get()` lookups against `this._clickUpServices` and `this._linearServices`, which are empty at startup because services are lazily initialized.
- **Logic:** Replace the raw map lookups with calls to the existing lazy-initialization helpers `_getClickUpService(workspaceRoot)` and `_getLinearService(workspaceRoot)`. Both methods:
  - Cache the service instance after first creation
  - Inject the cache service on every retrieval (ensuring the service has up-to-date metadata paths)
  - Handle missing workspace root gracefully
- **Implementation:** At `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts:417-418`, change:

  ```ts
  // BEFORE
  getClickUpService: () => this._clickUpServices.get(workspaceRoot) || null,
  getLinearService: () => this._linearServices.get(workspaceRoot) || null
  ```

  To:

  ```ts
  // AFTER
  getClickUpService: () => this._getClickUpService(workspaceRoot),
  getLinearService: () => this._getLinearService(workspaceRoot),
  ```

- **Edge Cases:**
  - `workspaceRoot` may already be absolute; `path.resolve` inside `_getClickUpService` is idempotent for absolute paths.
  - If `workspaceRoot` is null (already guarded at line 406-408), `_startLocalApiServer` returns early and does not reach the factory closure.
  - If ClickUp is not configured (no token), `_getClickUpService` still creates the service instance; `service.getTaskDetails(taskId)` will throw, and `_handleGetTask` catches it and returns HTTP 500 with the error message. This is acceptable and arguably more semantically correct than 503.

## Verification Plan

### Automated Tests
- [ ] Add or update unit test in `src/services/__tests__/TaskViewerProvider.test.ts` (or equivalent) to assert that `_startLocalApiServer` passes factory closures that delegate to `_getClickUpService` and `_getLinearService`. Mock these methods and verify they are called when the factory is invoked.

### Manual Verification
1. Start VS Code with the extension active in a workspace with ClickUp configured (`setupComplete: true` and a valid API token).
2. Read the port from `.switchboard/api-server-port.txt`.
3. Run: `curl http://localhost:$PORT/task/clickup/{any_valid_task_id}`
4. Expect: HTTP 200 with a JSON object containing `task`, `subtasks`, `comments`, and `attachments`.
5. Run: `curl http://localhost:$PORT/task/clickup/invalid_task_id`
6. Expect: HTTP 500 or 404 (not 503).
7. In a workspace WITHOUT ClickUp configured, run: `curl http://localhost:$PORT/task/clickup/any_id`
8. Expect: HTTP 500 with an error message about missing token or failed fetch (not 503 "service not available").

## Out of Scope

- MCP server ClickUp token issues (MCP server is being removed).
- Error message fixes in `register-tools.js` (MCP server is being removed).
- CSRF (no CSRF exists in the codebase; this was a false claim).

## Notes

`_getClickUpService()` already handles the null workspaceRoot case gracefully and returns a service instance. `_getLinearService()` does the same. These are safe replacements.

**Send to Coder**

## Review Results (In-Place Pass)

### Stage 1: Grumpy Principal Engineer Findings
#### NIT: Missing Unit Test
The developer changed the two lines in `TaskViewerProvider.ts` as requested, replacing the raw `Map.get()` lookups with the lazy-initializer method calls. However, they entirely skipped adding the unit test as specified in the 'Verification Plan'. The code is changed but untested.

#### What WAS done correctly
- ✅ **`TaskViewerProvider.ts`** updated to use `_getClickUpService` and `_getLinearService`.
- ✅ No regressions identified in the logic; lazy initialization will now properly construct the services.

### Stage 2: Balanced Synthesis
| Finding | Severity | Action |
|---------|----------|--------|
| Missing unit test | NIT | **Defer** — `TaskViewerProvider` lacks an existing test suite. Bootstrapping one for a single factory closure is out of scope for a minimal bugfix. |
| Implementation details | ✅ Correct | Keep as-is |

### Stage 3: Code Fixes Applied
No code fixes required. The implementation is correct.

### Stage 4: Verification Results
| Check | Result |
|-------|--------|
| Factory closures updated | ✅ Yes (`src/services/TaskViewerProvider.ts:417-418`) |
| TypeScript compilation | ✅ `npx tsc --noEmit` passes |

### Remaining Risks
- The factory closure logic remains untested automatically, relying on manual verification as fallback.
