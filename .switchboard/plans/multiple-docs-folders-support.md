# Multiple Docs Folders Support

## Problem
The ARTIFACTS view (planning.html) currently only supports a single local docs folder via the `switchboard.research.localFolderPath` setting. Users with documentation spread across multiple directories cannot access all their research materials from one interface.

## Solution
Extend the Local Docs tab to support multiple folder paths with a unified tree view.

## Implementation Plan

### Phase 1: Configuration Migration
- **File**: `src/services/LocalFolderService.ts`
- Change config from `research.localFolderPath` (string) to `research.localFolderPaths` (array of strings)
- Add migration logic:
  - On service init, check if old `research.localFolderPath` exists
  - If present and non-empty, migrate to `research.localFolderPaths` array
  - Clear old setting after successful migration
- Update `getFolderPath()` to return first path from array (backward compatibility for single-folder code paths)
- Add new methods:
  - `getFolderPaths(): string[]` - returns all configured paths
  - `addFolderPath(path: string): Promise<void>` - adds a new path to config
  - `removeFolderPath(path: string): Promise<void>` - removes a path from config

### Phase 2: Multi-Folder Scanning
- **File**: `src/services/LocalFolderService.ts`
- Update `listFiles()` to:
  - Scan all configured folders
  - Tag each file with its source folder path
  - Deduplicate files if same path exists in multiple folders (first folder wins)
- Update return type to include source folder:
  ```typescript
  { id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string; sourceFolder?: string }
  ```
- Update `fetchDocContent()` to accept source folder parameter for path resolution

### Phase 3: UI Updates - Add/Remove Folders
- **File**: `src/webview/planning.html`
- Add controls above tree pane in LOCAL DOCS tab:
  - "Add Folder" button (opens folder picker dialog)
  - List of configured folders with "Remove" buttons
  - Display folder paths with relative workspace indicators
- Add CSS for folder list styling
- Add empty state when no folders configured

- **File**: `src/webview/planning.js`
- Add message handler for `addLocalFolder`:
  - Call `vscode.window.showOpenDialog` for folder selection
  - Call `LocalFolderService.addFolderPath()`
  - Refresh tree view
- Add message handler for `removeLocalFolder`:
  - Call `LocalFolderService.removeFolderPath()`
  - Refresh tree view
- Add message handler for `listLocalFolders`:
  - Return array of configured folder paths
  - Render folder list in UI

### Phase 4: UI Updates - Tree View
- **File**: `src/webview/planning.js`
- Update tree rendering to show source folder badge:
  - Add folder indicator next to file/folder names
  - Use different color or icon for each source folder
  - Collapse folder structure by default to reduce clutter
- Add folder grouping option:
  - Toggle between "flat view" (all files mixed) and "grouped by folder" view
- Update file selection to pass source folder to fetch handler

### Phase 5: Watcher Updates
- **File**: `src/services/PlanningPanelProvider.ts`
- Update `_setupLocalFolderWatchers()` to:
  - Create watchers for all configured folders
  - Deduplicate watchers if same path configured multiple times
  - Handle folder addition/removal dynamically
- Update watcher refresh logic to identify which folder changed

### Phase 6: Testing
- Test migration from single to multi-folder config
- Test adding/removing folders via UI
- Test file access from multiple folders
- Test watcher behavior with multiple folders
- Test deduplication when same file exists in multiple folders
- Test backward compatibility with existing single-folder setups

## Files to Modify
- `src/services/LocalFolderService.ts` - Core service logic
- `src/services/PlanningPanelProvider.ts` - Watcher setup
- `src/webview/planning.html` - UI structure
- `src/webview/planning.js` - UI logic and message handlers
- `package.json` - Update settings schema if needed

## Edge Cases
- Empty folder path array (show empty state, prompt user to add folder)
- Duplicate folder paths (deduplicate in config)
- Non-existent folders (validate on add, show error)
- Folder with no text files (show empty subtree)
- File name collisions across folders (use source folder as tiebreaker)
- Large number of folders (consider pagination or virtual scrolling)
