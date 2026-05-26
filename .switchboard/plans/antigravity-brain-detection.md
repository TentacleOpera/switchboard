# Antigravity Brain Detection

## Problem
The ARTIFACTS view does not detect or display antigravity session artifacts stored in `~/.gemini/antigravity/brain/`. Users cannot access their antigravity session history and artifacts from the planning panel.

## Solution
Add automatic detection and display of antigravity brain folder contents in the LOCAL DOCS tab.

## Implementation Plan

### Phase 1: Antigravity Path Detection
- **File**: `src/services/LocalFolderService.ts`
- Add method `detectAntigravityBrainPath(): string | null`:
  - Check if `~/.gemini/antigravity/brain/` exists
  - Return absolute path if found, null otherwise
  - Use `os.homedir()` for cross-platform compatibility
- Add method `isAntigravitySessionFile(filename: string): boolean`:
  - Check for JSON files with UUID-like names (e.g., `c9f0312e1e2ec0bb202aeae9e5a130b424f591d87da028f5714c9a151b6aa808.json`)
  - Or check for `.json` extension in brain directory
- Add config flag `antigravityBrainEnabled: boolean` to `LocalFolderConfig`
  - Default to false (opt-in to avoid cluttering tree view)
  - Persist in `.switchboard/local-folder-config.json`

### Phase 2: Session File Parsing
- **File**: `src/services/LocalFolderService.ts`
- Add method `parseAntigravitySession(filePath: string): Promise<{ sessionId: string; timestamp: string; content?: string } | null>`:
  - Read JSON file
  - Extract session ID from filename
  - Extract timestamp from file mtime or JSON content
  - Return structured metadata
- Add method `listAntigravitySessions(): Promise<Array<{ id: string; name: string; timestamp: string; relativePath: string }>>`:
  - Scan brain directory for JSON files
  - Parse each file for metadata
  - Sort by timestamp (newest first)
  - Return list of sessions

### Phase 3: Service Integration
- **File**: `src/services/PlanningPanelProvider.ts`
- Update `_handleFetchRoots()` to include antigravity brain as a source if enabled
- Add message handler `toggleAntigravityBrain`:
  - Enable/disable antigravity brain scanning
  - Update config in `LocalFolderService`
  - Refresh tree view
- Add message handler `fetchAntigravitySession`:
  - Call `LocalFolderService.parseAntigravitySession()`
  - Return session content for preview
- Update `_sendLocalDocsReady()` to include antigravity sessions in tree if enabled

### Phase 4: UI Updates - Toggle Control
- **File**: `src/webview/planning.html`
- Add toggle switch in LOCAL DOCS tab controls strip:
  - Label: "Include Antigravity Sessions"
  - Position: below existing controls or in settings section
  - Use existing `.toggle-container` and `.toggle-switch` styles
- Add section header for antigravity sessions in tree pane:
  - "ANTIGRAVITY SESSIONS" header (styled like `.source-header`)
  - Only visible when toggle is enabled and sessions exist

### Phase 5: UI Updates - Tree View
- **File**: `src/webview/planning.js`
- Update tree rendering to show antigravity sessions as a separate section:
  - Group sessions under "ANTIGRAVITY SESSIONS" header
  - Display session ID (truncated to first 8 chars for readability)
  - Display timestamp in human-readable format (e.g., "2 hours ago")
  - Use different icon (e.g., brain icon or session icon)
- Add click handler for antigravity sessions:
  - Call `fetchAntigravitySession` message
  - Display session JSON content in preview pane
  - Format JSON with syntax highlighting if possible
- Add empty state when no sessions found:
  - "No antigravity sessions found in ~/.gemini/antigravity/brain/"

### Phase 6: Session Content Preview
- **File**: `src/webview/planning.js`
- Add JSON formatting for session preview:
  - Pretty-print JSON with indentation
  - Add syntax highlighting for keys vs values
  - Collapse large nested objects by default
  - Add expand/collapse controls for objects/arrays
- Add session metadata banner in preview:
  - Session ID
  - Timestamp
  - File path
  - Link to open file in editor

### Phase 7: Watcher Integration
- **File**: `src/services/PlanningPanelProvider.ts`
- Add watcher for antigravity brain directory:
  - Watch `~/.gemini/antigravity/brain/*.json`
  - Refresh session list on create/delete
  - Debounce rapid changes
- Update `_setupLocalFolderWatchers()` to include antigravity watcher if enabled

### Phase 8: Testing
- Test detection of antigravity brain path on different platforms (macOS, Linux, Windows)
- Test toggle enable/disable behavior
- Test session listing with various JSON file formats
- Test session content preview with large JSON files
- Test watcher behavior when sessions are added/removed externally
- Test error handling for malformed JSON files
- Test with no antigravity installation (should not crash)

## Files to Modify
- `src/services/LocalFolderService.ts` - Detection and parsing logic
- `src/services/PlanningPanelProvider.ts` - Message handlers and watchers
- `src/webview/planning.html` - Toggle control and tree structure
- `src/webview/planning.js` - Tree rendering and preview logic

## Edge Cases
- Antigravity not installed (hide toggle, show "not detected" message)
- Brain directory exists but no JSON files (show empty state)
- Malformed JSON files (skip with error log, don't crash)
- Very large session files (truncate preview or stream)
- Session files with non-UUID names (still display if valid JSON)
- User has both local docs and antigravity enabled (tree should show both sections)
- Rapid file changes in brain directory (debounce watcher)

## Future Enhancements
- Allow filtering sessions by date range
- Allow searching session content
- Allow exporting sessions to markdown
- Link sessions to associated plan files if metadata exists
- Show session duration or other metadata if available
