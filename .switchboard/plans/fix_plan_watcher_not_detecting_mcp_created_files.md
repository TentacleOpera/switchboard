# Fix Plan Watcher Not Detecting MCP-Created Plan Files

## Goal
Ensure plan files created via MCP tools (e.g., `write_to_file`) are automatically detected and imported into the kanban database within seconds, eliminating the current requirement for a manual editor save.

## Metadata
- **Tags:** backend, bugfix, workflow
- **Complexity:** 5

## User Review Required
- [ ] Confirm 10-second default scan interval is acceptable for your workflow
- [ ] Decide whether to expose the `switchboard.planWatcher.periodicScanEnabled` / `scanIntervalMs` settings in package.json or keep them internal

## Complexity Audit

### Routine
- Add three private fields (`_scanInterval`, `_scanIntervalMs`, `_lastScanTime`) to `GlobalPlanWatcherService`
- Add `_startPeriodicScan()` and `_scanForNewFiles()` methods
- Wire `clearInterval` into existing `dispose()` method
- Add two configuration keys to `package.json`

### Complex / Risky
- Concurrent scan overlap: if `_scanForNewFiles` takes longer than the interval, multiple scans could run simultaneously. Mitigated by `_scanInProgress` guard.
- `_lastScanTime` ordering: must be set before scanning (not after) to avoid re-processing files on mid-scan errors.

## Edge-Case & Dependency Audit

- **Race Conditions**
  - If a file is created by MCP but not fully flushed, `_scanForNewFiles` may attempt to read partial content. `_handlePlanFile` already has try/catch, but a malformed read could produce invalid metadata. Recommended: skip files whose `birthtimeMs` is within 500ms of `Date.now()`.
  - Concurrent scan + native watcher event on the same file: both may call `_handlePlanFile`. The existing debounce (300ms) is per-uri, but scans bypass the debounce map entirely. This means the scan and a watcher event could race. Recommended: route scan discoveries through `_debounceHandleFile(uri, workspaceRoot)` instead of calling `_handlePlanFile` directly.
- **Security**
  - Scanning traverses only `.switchboard/plans`. The directory is already controlled by the workspace. No new attack surface.
- **Side Effects**
  - A persistent `setInterval` keeps the Node event loop alive. Must be cleared in `dispose()` (already in plan). If `initialize()` is called multiple times without dispose, a second interval leaks. Recommended: clear any existing interval before starting a new one.
  - `db.getAllPlans(workspaceId)` loads every active plan into memory. For workspaces with 500+ plans, this is non-trivial. However, `triggerScan` already does this on manual scan, so this is existing behavior.
- **Dependencies & Conflicts**
  - None

## Dependencies
- None

## Adversarial Synthesis
Key risks: race between scan and native watcher (duplicate processing), concurrent scan overlap if a cycle exceeds the interval, and `_lastScanTime` not being set before scanning (causing re-processing on mid-scan errors). Mitigations: route scan discoveries through `_debounceHandleFile` (coalesces with watcher events), add `_scanInProgress` guard to skip overlapping cycles, set `_lastScanTime` before the scan loop, and defensively clear the interval in `_startPeriodicScan` before creating a new one. The 500ms grace window for partial writes is conservative; files that miss the window will be caught on the next 10s cycle.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/GlobalPlanWatcherService.ts`

**Context:** The service currently relies on VS Code's `FileSystemWatcher` and Node's `fs.watch` to detect plan file changes. Both mechanisms can miss files created outside the editor (e.g., by MCP tools). A lightweight periodic scan fills the gap.

**Logic & Implementation:**

1. **Add scan state fields** (after line 24, near existing `_debounceTimers`):
   ```typescript
   private _scanInterval?: NodeJS.Timeout;
   private _scanIntervalMs = 10000; // 10 seconds default
   private _lastScanTime = new Map<string, number>(); // Track last scan per workspace
   private _scanInProgress = false; // Guard against overlapping scans
   ```
   - `_scanInterval` holds the active `setInterval` handle.
   - `_scanIntervalMs` is hardcoded to 10s for now; can be made configurable later.
   - `_lastScanTime` prevents re-scanning old files on extension reload.
   - `_scanInProgress` prevents concurrent scans if one cycle takes longer than the interval.

2. **Start the interval in `initialize()`** (around line 33):
   ```typescript
   public async initialize(): Promise<void> {
       this._outputChannel?.appendLine('[GlobalPlanWatcher] Initializing...');
       await this._refreshWatchers();
       this._startPeriodicScan();
       // ... existing listeners
   }
   ```

3. **Add `_startPeriodicScan()` and `_scanForNewFiles()`** (new methods after `initialize`):
   ```typescript
   private _startPeriodicScan(): void {
       if (this._scanInterval) {
           clearInterval(this._scanInterval);
           this._scanInterval = undefined;
       }
       this._scanInterval = setInterval(async () => {
           if (this._scanInProgress) { return; } // Skip if previous scan still running
           this._scanInProgress = true;
           try {
               const folders = await this._getAllMappedFolders();
               for (const folder of folders) {
                   await this._scanForNewFiles(folder);
               }
           } finally {
               this._scanInProgress = false;
           }
       }, this._scanIntervalMs);
       this._outputChannel?.appendLine(`[GlobalPlanWatcher] Periodic scan started (${this._scanIntervalMs}ms)`);
   }

   private async _scanForNewFiles(workspaceRoot: string): Promise<void> {
       const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
       if (!fs.existsSync(plansDir)) { return; }

       try {
           const db = KanbanDatabase.forWorkspace(workspaceRoot);
           await db.ensureReady();
           const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();
           if (!workspaceId) { return; }

           const existingPlans = await db.getAllPlans(workspaceId);
           const existingPaths = new Set(existingPlans.map(p => p.planFile));
           const now = Date.now();
           const lastScan = this._lastScanTime.get(workspaceRoot) || 0;
           // Set lastScanTime BEFORE scanning so mid-scan errors don't cause re-processing
           // on the next cycle. Uses 'now' (current timestamp) so files created during
           // this scan won't be missed on the next cycle either.
           this._lastScanTime.set(workspaceRoot, now);

           const scanDir = async (dir: string): Promise<void> => {
               const entries = await fs.promises.readdir(dir, { withFileTypes: true });
               for (const entry of entries) {
                   const entryPath = path.join(dir, entry.name);
                   if (entry.isDirectory()) {
                       await scanDir(entryPath);
                   } else if (entry.isFile() && entry.name.endsWith('.md')) {
                       const relativePath = path.relative(workspaceRoot, entryPath).replace(/\\/g, '/');
                       if (existingPaths.has(relativePath)) { continue; }

                       const stats = await fs.promises.stat(entryPath);
                       // Skip files older than the last scan to avoid re-importing
                       if (stats.mtimeMs < lastScan) { continue; }
                       // Skip very recently created files to avoid reading partial writes
                       if (now - stats.mtimeMs < 500) { continue; }

                       this._outputChannel?.appendLine(`[GlobalPlanWatcher] Periodic scan found new file: ${relativePath}`);
                       const uri = vscode.Uri.file(entryPath);
                       // Route through debounce to avoid races with fs.watch events
                       this._debounceHandleFile(uri, workspaceRoot);
                   }
               }
           };

           await scanDir(plansDir);
       } catch (err) {
           this._outputChannel?.appendLine(`[GlobalPlanWatcher] Periodic scan error in ${workspaceRoot}: ${err}`);
       }
   }
   ```
   - **Important:** `_scanForNewFiles` routes new-file discoveries through `_debounceHandleFile(uri, workspaceRoot)` (not `_handlePlanFile` directly). This coalesces scan events with native/VS Code watcher events and prevents duplicate imports.
   - Uses `mtimeMs` instead of `birthtimeMs` because `birthtime` is unreliable on Linux/ext4 and some copy operations reset it.
   - The 500ms grace window (`now - stats.mtimeMs < 500`) gives MCP tools time to finish flushing the file before we read it.

4. **Update `dispose()`** (around line 400):
   ```typescript
   public dispose(): void {
       if (this._scanInterval) {
           clearInterval(this._scanInterval);
           this._scanInterval = undefined;
       }
       // ... existing disposal code
   }
   ```

### `/Users/patrickvuleta/Documents/GitHub/switchboard/package.json`

**Context:** VS Code extension settings are declared in `package.json` under the `configuration` contribution point.

**Implementation:** Add two new properties inside the existing `"switchboard.*"` configuration block:
   ```json
   "switchboard.planWatcher.periodicScanEnabled": {
       "type": "boolean",
       "default": true,
       "description": "Enable periodic scanning for plan files created outside the editor (e.g., by MCP tools).",
       "scope": "resource"
   },
   "switchboard.planWatcher.scanIntervalMs": {
       "type": "integer",
       "default": 10000,
       "minimum": 2000,
       "maximum": 300000,
       "description": "Interval in milliseconds between periodic scans for new plan files. Minimum 2s, maximum 5m.",
       "scope": "resource"
   }
   ```
   - If you prefer to keep these internal (not user-facing), skip this file and read the hardcoded `_scanIntervalMs` from a private constant.

**Edge Cases:**
- If `periodicScanEnabled` is toggled at runtime, the service must restart its interval. The existing `vscode.workspace.onDidChangeConfiguration` listener only reacts to `workspaceDatabaseMappings` changes. If we expose the planWatcher settings, extend that listener to also call `_startPeriodicScan()` when `switchboard.planWatcher.*` changes.

## Verification Plan

### Automated Tests
- [ ] Unit test: mock `fs.promises.readdir` to return a fake `.md` file, assert that `_debounceHandleFile` is called with the correct URI.
- [ ] Unit test: mock `db.getAllPlans` to return a plan whose `planFile` matches the scanned file, assert `_debounceHandleFile` is NOT called (no duplicate import).
- [ ] Unit test: simulate a file with `mtimeMs` older than `_lastScanTime`, assert it is skipped.
- [ ] Unit test: call `dispose()`, assert `clearInterval` was invoked and the timer is undefined.
- [ ] Unit test: call `initialize()` twice, assert only one interval exists (no leak).
- [ ] Unit test: simulate a scan that takes longer than the interval, assert `_scanInProgress` guard prevents overlap.
- [ ] Unit test: simulate a mid-scan error, assert `_lastScanTime` was already set (no re-processing on next cycle).

### Manual Verification
1. Open the kanban panel (Switchboard: Open AUTOBAN).
2. Use an MCP tool (e.g., `write_to_file`) to create a new `.md` file in `.switchboard/plans/`.
3. Within 15 seconds, verify the new plan card appears in the "Created" column.
4. Open the Output panel > "Switchboard" channel and confirm the log line: `[GlobalPlanWatcher] Periodic scan found new file: ...`
5. Rapidly create 3 plan files in quick succession; verify all 3 appear in the kanban without errors.
6. Reload the VS Code window and confirm the periodic scan restarts (check Output logs).
7. Disable `switchboard.planWatcher.periodicScanEnabled` in settings, reload, and confirm MCP-created files are no longer auto-detected.

## Problem Description
When plan files are created via MCP tools (e.g., `write_to_file`), the GlobalPlanWatcherService does not detect them automatically. The files only appear in the kanban "New" column after the user manually saves the file in the editor.

## Root Cause Analysis
The GlobalPlanWatcherService uses two mechanisms to detect plan file changes:

1. **VS Code FileSystemWatcher** (lines 152-173 in GlobalPlanWatcherService.ts):
   - Watches `.switchboard/plans/**/*.md` pattern
   - Fires `onDidCreate` when files are created within VS Code
   - Fires `onDidChange` when files are modified

2. **Native fs.watch** (lines 196-225):
   - Fallback for non-workspace folders or when VS Code watcher misses events
   - Uses Node.js `fs.watch` with recursive option
   - Should detect all file system changes regardless of source

The issue occurs because:

1. **VS Code FileSystemWatcher limitation**: Files created programmatically via MCP tools (outside VS Code's editor) may not trigger the `onDidCreate` event in VS Code's FileSystemWatcher. This is a known limitation - VS Code's watcher primarily tracks changes made through its own editor and related operations.

2. **Native fs.watch timing/debounce**: While the native watcher should catch the file creation, there may be:
   - A delay in the file system event firing
   - The 300ms debounce timer (line 232-236) not completing before the user checks the kanban
   - The file not being fully flushed to disk when the watcher checks

3. **File metadata validation**: The plan file created via `write_to_file` lacks explicit metadata fields (sessionId, kanbanColumn, complexity, tags, dependencies). The watcher's `parsePlanMetadata` function infers these from the filename and content, but if validation fails or the inferred data is incomplete, the import might be silently skipped.

## Alternative Approach
If periodic scanning is too resource-intensive, consider:

1. **Force immediate scan after MCP file operations**:
   - Add a post-write hook in the MCP server to trigger `triggerScan`
   - This ensures immediate detection without polling overhead

2. **Improve native fs.watch reliability**:
   - Increase debounce time to 500ms or 1000ms
   - Add retry logic for failed watch events
   - Log all watch events for debugging

## Edge Cases
- **Workspace not configured**: Scan should skip workspaces without database
- **Large plan directories**: Scan should be efficient and not block UI
- **Concurrent file operations**: Scan should handle files being written during scan
- **Deleted files**: Scan should not try to import deleted files

---

**Recommendation:** Send to Coder
