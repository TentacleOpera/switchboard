# Fix "Link All" Button to Copy Individual File Paths Respecting Filters

## Goal
The "Link all" button in the tickets sidebar should copy links for every individual file shown in the sidebar (respecting applied filters like status, search, project) rather than copying folder paths for all tickets.

**Core Problem / Background**
Currently, the "Link all" button copies folder paths for all ticket documents in the workspace, regardless of what filters are applied. Users may filter the sidebar to show only tickets with a certain status, tag, or search term, but clicking "Link all" ignores these filters and copies all ticket folder paths.

- The tickets sidebar displays Linear issues or ClickUp tasks
- Users can filter by:
  - Search text
  - State/status (Linear: state name, ClickUp: status)
  - Project (Linear only)
- The current implementation sends a `copyToClipboard` message with only provider and workspace root
- The backend handler (`PlanningPanelProvider.ts`) then copies all ticket document folder paths

## Metadata
- **Tags:** ui, bugfix, frontend, backend
- **Complexity:** 2

## User Review Required
- Confirm fallback behavior: when no filters are applied (or `ticketIds` is empty), should the button still copy folder paths (backward compatibility) or switch to copying all individual ticket file paths?

## Complexity Audit

### Routine
- Modify `linkAllButton` click handler in `src/webview/planning.js` to include filtered ticket IDs in the outgoing message
- Modify `copyToClipboard` case in `src/services/PlanningPanelProvider.ts` to construct per-ticket file paths when IDs are provided
- Maintain backward compatibility when `ticketIds` is absent or empty

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Clipboard write and message handling occur synchronously in the single webview ↔ extension message loop.
- **Security:** Ticket IDs are generally trusted (Linear UUIDs, ClickUp numeric IDs), but unsanitized IDs containing path separators (`../`, `/`) could allow directory traversal during `path.join`. Mitigation: validate each ID is a non-empty string free of path separators before constructing the path.
- **Side Effects:** Overwrites the system clipboard. No persistent data changes.
- **Dependencies & Conflicts:** None. No other feature consumes the `copyToClipboard` message payload.

## Dependencies
None

## Adversarial Synthesis
Key risks: malformed or unexpected `ticketIds` values could produce invalid or escaped file paths; empty `ticketIds` triggers legacy folder-path fallback, which may confuse users who expect filtered individual paths. Mitigations: sanitize IDs before path construction, and consider whether the fallback should instead copy all individual paths when no filters are active.

## Proposed Changes

### `src/webview/planning.js`
- **Context:** The `linkAllButton` click listener (around line 5546) currently posts a `copyToClipboard` message containing only `provider` and `workspaceRoot`.
- **Logic:** Reuse the existing filtered-ticket getters (`getFilteredLinearIssues` at line 6183 and `getFilteredClickUpTasks` at line 6692) that are already employed by the import-all buttons.
- **Implementation:** Inside the `linkAllButton` handler, determine the active provider, call the appropriate getter, map the results to their `id` values, and include a `ticketIds` array in the posted message.
  ```javascript
  vscode.postMessage({
      type: 'copyToClipboard',
      provider: lastIntegrationProvider,
      workspaceRoot: ticketsWorkspaceRoot,
      ticketIds: filteredIds // Array of ticket IDs currently visible in sidebar
  });
  ```
  After posting, keep the existing `flashCopyBtn(linkAllButton)` call.
- **Edge Cases:**
  - If no provider is selected, `lastIntegrationProvider` may be undefined; the handler should guard against this or allow the existing no-op behavior.
  - If filters yield zero visible tickets, `ticketIds` will be an empty array; the backend must handle this gracefully.

### `src/services/PlanningPanelProvider.ts`
- **Context:** The `copyToClipboard` case handler (around line 3529) currently iterates over `_getTicketDocumentDirs` and pushes folder paths into a `paths` array, then writes the joined string to the clipboard.
- **Logic:** If the incoming message contains a non-empty `ticketIds` array, construct an individual file path per ID; otherwise, preserve the legacy folder-path behavior for backward compatibility.
- **Implementation:**
  - Check `msg.ticketIds` before the existing directory loop.
  - If present and non-empty, map each ID to the deterministic ticket file path using `path.join` for cross-platform safety:
    - Linear: `{workspaceRoot}/.switchboard/tickets/linear/{issueId}.md`
    - ClickUp: `{workspaceRoot}/.switchboard/tickets/clickup/{taskId}.md`
  - Validate each ID (non-empty string, no path separators) before joining.
  - If `ticketIds` is missing or empty, fall through to the existing loop that copies folder paths.
  - Join all constructed paths with `\n` and write to the clipboard via `vscode.env.clipboard.writeText`.
- **Edge Cases:**
  - `workspaceRoot` resolved as `undefined` → existing guard (`if (workspaceRoot)`) prevents path construction.
  - Ticket files may not yet exist on disk; copying their paths is still valid because the paths are deterministic and will resolve once the tickets are imported.

### Implementation Steps
1. **Frontend: Modify linkAllButton handler**
   - Get filtered ticket IDs based on provider
   - Include IDs in the message

2. **Backend: Update copyToClipboard handler**
   - Accept optional `ticketIds` parameter
   - Construct individual file paths when IDs provided
   - Maintain backward compatibility

3. **Testing**
   - Apply status filter, verify "Link all" copies only filtered tickets
   - Apply search filter, verify "Link all" copies only matching tickets
   - Apply project filter (Linear), verify "Link all" copies only project tickets
   - Verify no filters applied copies all visible tickets
   - Verify clipboard content contains individual file paths, not folder paths

## Verification Plan

### Automated Tests
- **Frontend unit:** Simulate `linkAllButton` click with mocked filtered tickets for each provider and assert the posted message includes the correct `ticketIds` array.
- **Backend unit:** Call the `copyToClipboard` handler with a mocked message containing `ticketIds` and assert the clipboard receives the expected individual file paths; repeat with no `ticketIds` to confirm legacy folder-path output.
- **Integration:** Apply a status filter in the sidebar, trigger Link All, and assert clipboard content matches only the filtered ticket paths.
- **Regression:** Trigger Link All with no filters and verify all visible ticket paths are copied (or fallback folder paths, per product decision).

---

**Recommendation:** Send to Intern

## Review Findings

CRITICAL: the plan's path scheme `tickets/{provider}/{id}.md` was factually wrong — ticket files are named `${provider}_${id}_<slug>.md` and live in nested folder hierarchies (team/project/sprint), as the canonical `TaskViewerProvider._findTicketDocument` explicitly warns. The implementation faithfully built flat paths that never resolve, so the feature copied broken links. Fixed in `PlanningPanelProvider.ts`: added `_findTicketFilePath`/`_scanForTicketFile` (recursive prefix scan mirroring the canonical resolver) and the `copyToClipboard` handler now resolves real on-disk paths per filtered ID (sanitization + legacy folder fallback preserved). Frontend (`planning.js:5546-5561`) was correct: filtered getters supply `.id` values matching the filename prefix. Validation: static review only (compile/tests skipped per directive); behavior note — not-yet-imported tickets have no file and are silently skipped, since their real paths are non-deterministic and cannot be pre-constructed.
