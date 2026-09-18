# Fix Markdown Preview Spurious Rerender

## Goal
Fix the markdown preview in planning.html that continuously rerenders even when the user is only viewing the file without making any changes.

### Problem Analysis (Preserved)

#### Root Cause
The active document watcher in `PlanningPanelProvider.ts` is configured with incorrect parameters that cause it to watch for both create and change events, despite misleading comments suggesting otherwise.

In `_setupActiveDocWatcher` (lines 590-595):
```typescript
this._activeDocWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath)),
    false, // watch create
    false, // watch change
    true   // ignore delete (handled via onDidDelete)
);
```

The VS Code `createFileSystemWatcher` signature is:
- Parameter 1: `ignoreCreateEvents` (default false)
- Parameter 2: `ignoreChangeEvents` (default false)
- Parameter 3: `ignoreDeleteEvents` (default false)

The comments are inverted:
- `false, // watch create` actually means "do NOT ignore create" → it watches create events
- `false, // watch change` actually means "do NOT ignore change" → it watches change events

#### Why It Rerenders When Just Viewing
The `onDidChange` handler (line 598) fires on ANY file system change event detected by VS Code, including:

1. **External file modifications** (e.g., git operations, other editors)
2. **File metadata changes** (e.g., timestamp updates from git status checks)
3. **VS Code internal operations** (e.g., auto-save, language server operations)
4. **File system sync events** (e.g., cloud sync services like Dropbox/OneDrive)

While there are deduplication guards in place (content comparison in both backend and frontend), these can fail due to:
- Whitespace or encoding differences
- Timing issues during rapid file system events
- The content being read before the file write completes

Each failed deduplication causes a full rerender via `renderMarkdown(content)` and `innerHTML` update, making text appear to "jump" as the browser reflows the layout.

## Metadata
**Complexity:** 4
**Tags:** bugfix, ui, frontend

## User Review Required
No

## Complexity Audit

### Routine
- Fix boolean parameter comments in `createFileSystemWatcher` call.
- Toggle `ignoreCreateEvents` from `false` to `true`.
- Add backend content-dedup guard to `_handleFetchDocsFile` (mirrors existing pattern in `_handleFetchPreview` and `_handleFetchKanbanPlanPreview`).

### Complex / Risky
- Removing the `onDidCreate` handler block (lines 633-667) eliminates shared-debounce race condition but requires confirming no downstream logic relies on it (the file already exists when watcher is created, and `onDidDelete` disposes the watcher).
- `_handleFetchDocsFile` auto-refresh path lacks backend dedup; adding it changes the failure mode from "always re-post" to "skip unchanged," which is correct but must not accidentally suppress legitimate external updates.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `onDidChange` and `onDidCreate` handlers share `_activeDocWatchDebounce`. If both fire in rapid succession, they clear each other's timeouts. Setting `ignoreCreateEvents=true` and removing the `onDidCreate` handler eliminates this race.
- **Security:** None — no user input is processed differently; this is a local file watcher change.
- **Side Effects:** Removing the `onDidCreate` handler means if a watched file is deleted and then immediately recreated, the panel will not auto-refresh until the user manually re-selects the file. However, `onDidDelete` already disposes the watcher, so the old behavior would not have worked either.
- **Dependencies & Conflicts:** None. No external dependencies.

## Dependencies
none

## Adversarial Synthesis
Key risks: (1) Removing the `onDidCreate` handler could mask rare file-recreation edge cases if future code reuses the watcher without re-establishing it; (2) Adding dedup to `_handleFetchDocsFile` changes its contract from unconditional post to conditional post, which could affect callers expecting a side effect. Mitigations: preserve the unconditional post for user-initiated requests (`requestId >= 0`) and only guard auto-refresh requests (`requestId === -1`), matching the pattern in `_handleFetchPreview`.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

#### Context
`_setupActiveDocWatcher` (lines 588-688) creates a `FileSystemWatcher` for the currently previewed file. The watcher currently subscribes to both `onDidChange` and `onDidCreate` with inverted comments. Both handlers trigger the same auto-refresh logic and share a single debounce timer.

`_handleFetchDocsFile` (lines 4211-4309) handles auto-refresh for imported local docs but does not check `_lastPreviewContentByPath` before posting, unlike `_handleFetchPreview` (lines 3845-3917) and `_handleFetchKanbanPlanPreview` (lines 690-719).

#### Logic
1. **Watcher configuration:** Since the file already exists when the watcher is set up, create events are spurious. The correct configuration is `ignoreCreateEvents=true, ignoreChangeEvents=false, ignoreDeleteEvents=true`.
2. **Dead code removal:** The `onDidCreate` handler becomes unreachable once create events are ignored. It should be removed to eliminate the shared-debounce race and reduce maintenance burden (the TODO comment at line 633 explicitly warns about keeping the two handlers in sync).
3. **Backend dedup gap:** `_handleFetchDocsFile` should mirror the dedup pattern used by `_handleFetchPreview` and `_handleFetchKanbanPlanPreview`: compare fetched content against `_lastPreviewContentByPath` and skip the post when unchanged for auto-refresh requests (`requestId === -1`).

#### Implementation
- **Lines 590-595:** Update comments to match VS Code API semantics and set `ignoreCreateEvents=true`:
  ```typescript
  this._activeDocWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath)),
      true,  // ignore create events (file already exists when watcher is set up)
      false, // watch change events
      true   // ignore delete events (handled via onDidDelete)
  );
  ```
- **Lines 633-667:** Remove the entire `onDidCreate` handler block, including its TODO comment. The `onDidChange` handler (lines 597-631) remains the sole auto-refresh path.
- **Lines 4290-4299 (inside `_handleFetchDocsFile`):** Before posting `previewReady`, add a `_lastPreviewContentByPath` check for auto-refresh requests:
  ```typescript
  const cacheKey = this._getPreviewCacheKey('local-folder', slugPrefix, undefined);
  if (requestId === -1 && this._lastPreviewContentByPath.get(cacheKey) === displayContent) {
      return;
  }
  this._lastPreviewContentByPath.set(cacheKey, displayContent);
  ```
  *(Clarification: if `_getPreviewCacheKey` requires a `sourceFolder` argument, use `''` or `undefined` as appropriate to match the cache key format.)*

#### Edge Cases
- **User-initiated refresh must bypass dedup:** When the user explicitly clicks to refresh, `requestId >= 0`. The dedup guard must only apply when `requestId === -1` (auto-refresh), matching the existing behavior in `_handleFetchPreview` and `_handleFetchKanbanPlanPreview`.
- **File deleted and recreated:** `onDidDelete` disposes the watcher, so no auto-refresh occurs until the user re-selects the file. This behavior is unchanged by removing `onDidCreate`.
- **Frontmatter stripping:** `_handleFetchDocsFile` strips frontmatter before posting. The cache key must store the `displayContent` (stripped) so the comparison is apples-to-apples.

## Verification Plan

### Automated Tests
Skipped per session directive.

### Manual Validation
1. Open a markdown file in planning.html.
2. Observe that the preview does not rerender when:
   - Git status checks run
   - File metadata changes occur
   - Other VS Code operations happen
3. Verify that the preview still updates correctly when:
   - The file is actually modified externally
   - The file is saved from another editor
4. Verify the kanban plan preview (kanban-plan source) does not spuriously rerender when unchanged.

## Remaining Risks
- If the file system watcher still fires spurious events from external tools, the backend dedup guards (`_lastPreviewContentByPath`) are the final line of defense. They should now cover all three auto-refresh paths (`_handleFetchPreview`, `_handleFetchKanbanPlanPreview`, and `_handleFetchDocsFile`).
- Removing the `onDidCreate` handler assumes the watcher is always recreated after a deletion. If future code adds a "watch directory" fallback, the recreation logic must be revisited.

## Review Findings

All three plan changes implemented correctly in `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts`: watcher config updated (lines 590-595), `onDidCreate` handler removed, and backend dedup added to `_handleFetchDocsFile` (lines 4255-4259). No code fixes were required. One pre-existing MAJOR latent bug was identified in the execution path: `_handleFetchDocsFile` overwrites `_activePreviewSourceId` without updating `_activePreviewSourceFolder`, which can break subsequent auto-refreshes; this is out of scope for this plan and should be tracked separately. Verification skipped per session directive.
