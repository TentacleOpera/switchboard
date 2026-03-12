# Fix Sidebar Plan Discovery Delay and Kanban Scoping Bug

## Goal
Ensure newly created brain plans immediately appear in the sidebar dropdown by adding a filesystem watcher for `.switchboard/sessions/*.json` to `TaskViewerProvider.ts`. Additionally, correct a state leakage bug by updating `KanbanProvider.ts` to strictly enforce workspace ownership, tombstones, and blacklists using `plan_registry.json` and `workspace_identity.json`, ensuring the Kanban board only shows active plans owned by the current workspace.

## Review Status: Approved with Revisions
> [!NOTE]
> The lifecycle of the new `_sessionWatcher` in `TaskViewerProvider` must be carefully managed to prevent memory leaks during extension reload.
> [!WARNING]
> Updating Kanban scoping will instantly hide any plans on the Kanban board that belong to other workspaces. Users who intentionally shared runsheets across workspaces via symlinks or manual copies will no longer see them unless they are correctly registered to the active workspace.

### Reviewer Feedback
- **Grumpy**: What is this? We're dropping synchronous IO (`fs.existsSync`) inside `_refreshBoard` and copying the `getStablePath` function? This is how extensions freeze! Extract that into a shared utility!
- **Balanced**: The core logic is sound and correctly scopes the Kanban board. However, the duplicated `getStablePath` and synchronous file checks should ideally be abstracted or optimized. We will proceed, but the executing agent must ensure we avoid synchronous blocking where possible and consider moving `getStablePath` to a utility if time permits.

## Complexity Audit

### Band A — Routine
- Adding the `_sessionWatcher` and `_fsSessionWatcher` properties and lifecycle hooks to `TaskViewerProvider.ts`.
- Triggering `_refreshRunSheets()` on session file events.

### Band B — Complex / Risky
- Re-implementing the strict workspace ownership logic (`_isOwnedActiveRunSheet`) inside `KanbanProvider.ts` to filter the loaded sheets.
- Ensuring `KanbanProvider.ts` respects `plan_tombstones.json` and `brain_plan_blacklist.json` so archived/deleted/blacklisted plans do not reappear as zombied cards.

## Edge-Case Audit
- **Race Conditions**: High frequency of session file writes (e.g., fast sequential agent steps) could cause excessive UI refreshes. We must debounce the watcher events using a timeout.
- **Security**: Without proper path normalization (`getStablePath`), Windows casing differences could bypass the blacklist or tombstone checks, leaking plans onto the board.
- **Side Effects**: Failing to fall back to `fs.watch` might result in missed events on systems where VS Code's native `createFileSystemWatcher` ignores `.switchboard` due to `.gitignore` rules.

## Adversarial Synthesis

### Grumpy Critique
Why are we duplicating the massive `_isOwnedActiveRunSheet` logic from `TaskViewerProvider` directly into `KanbanProvider`? That is textbook code duplication! Plus, just looking at `plan_registry.json` isn't enough; what about the `brain_plan_blacklist.json` and the tombstones? If you don't check those, deleted plans will resurrect themselves as zombie cards on the board! And don't even get me started on the session watcher—if you don't add an `fs.watch` fallback, the sidebar will still stay stale on Windows because VS Code ignores gitignored directories!

### Balanced Response
Grumpy is entirely correct about the fallback watcher and the risk of zombie cards. The Kanban board must apply the exact same rigorous checks (registry ownership, tombstones, blacklist, stable path hashing) that the sidebar does. While duplicating the scoping logic into `KanbanProvider.ts` isn't perfectly DRY, `KanbanProvider` currently operates independently of `TaskViewerProvider`. A standalone verification check inside `KanbanProvider._refreshBoard` is the safest, most decoupled way to enforce this without a heavy architectural refactor. We will also include the `fs.watch` fallback for the sessions directory to guarantee events fire across all OS environments,.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing the code.

### 1. TaskViewerProvider (Sidebar Discovery)
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context**: The sidebar plan dropdown stays stale because `TaskViewerProvider` watches `.switchboard/plans/` but not `.switchboard/sessions/`,. Since runsheets dictate plan state, we need to refresh when sessions change.
- **Logic**: Add `_sessionWatcher` and `_fsSessionWatcher` properties. Create `_setupSessionWatcher()` which initializes a `FileSystemWatcher` and an `fs.watch` fallback. Bind `onDidCreate`, `onDidChange`, and `onDidDelete` to a debounced `_refreshRunSheets()` call.
- **Implementation**:
```typescript
    private _sessionWatcher?: vscode.FileSystemWatcher;
    private _fsSessionWatcher?: fs.FSWatcher;

    private _setupSessionWatcher() {
        if (this._sessionWatcher) {
            this._sessionWatcher.dispose();
        }
        try { this._fsSessionWatcher?.close(); } catch { }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders.uri.fsPath;
        const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');

        if (!fs.existsSync(sessionsDir)) {
            try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch { }
        }

        let sessionSyncTimer: NodeJS.Timeout | undefined;
        const debouncedSessionSync = () => {
            if (sessionSyncTimer) clearTimeout(sessionSyncTimer);
            sessionSyncTimer = setTimeout(() => this._refreshRunSheets(), 300);
        };

        this._sessionWatcher = vscode.workspace.createFileSystemWatcher('**/.switchboard/sessions/*.json');
        this._sessionWatcher.onDidCreate(() => debouncedSessionSync());
        this._sessionWatcher.onDidChange(() => debouncedSessionSync());
        this._sessionWatcher.onDidDelete(() => debouncedSessionSync());

        const watchSessionDirectory = (dir: string): fs.FSWatcher | undefined => {
            try {
                return fs.watch(dir, (_eventType, filename) => {
                    if (!filename || !filename.toString().endsWith('.json')) return;
                    debouncedSessionSync();
                });
            } catch (e) {
                console.error(`[TaskViewerProvider] fs.watch fallback failed for '${dir}':`, e);
                return undefined;
            }
        };
        this._fsSessionWatcher = watchSessionDirectory(sessionsDir);
    }
```
- **Edge Cases Handled**: Utilizes a 300ms debounce to prevent UI stuttering when multiple session events fire sequentially. Uses `fs.watch` fallback to circumvent VS Code's `.gitignore` watcher limitations.

### 2. KanbanProvider (Workspace Scoping)
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context**: The Kanban board currently renders all runsheets found in the sessions directory, ignoring `plan_registry.json` and `workspace_identity.json`,.
- **Logic**: Inside `_refreshBoard()`, load the `workspace_identity.json`, `plan_registry.json`, `plan_tombstones.json`, and `brain_plan_blacklist.json`. Filter the parsed runsheets so only those explicitly owned by the active workspace and not tombstoned/blacklisted are converted into `KanbanCard`s.
- **Implementation**:
```typescript
    private async _refreshBoard() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || !this._panel) return;
        const workspaceRoot = workspaceFolders.uri.fsPath;
        try {
            const log = this._getSessionLog(workspaceRoot);
            const sheets = await log.getRunSheets();

            // Load ownership and exclusion state
            let workspaceId: string | null = null;
            let registry: any = { entries: {} };
            let tombstones = new Set<string>();
            let blacklist = new Set<string>();

            try {
                const switchboardDir = path.join(workspaceRoot, '.switchboard');
                const identityPath = path.join(switchboardDir, 'workspace_identity.json');
                const registryPath = path.join(switchboardDir, 'plan_registry.json');
                const tombstonePath = path.join(switchboardDir, 'plan_tombstones.json');
                const blacklistPath = path.join(switchboardDir, 'brain_plan_blacklist.json');

                if (fs.existsSync(identityPath)) {
                    workspaceId = JSON.parse(await fs.promises.readFile(identityPath, 'utf8')).workspaceId;
                }
                if (fs.existsSync(registryPath)) {
                    registry = JSON.parse(await fs.promises.readFile(registryPath, 'utf8'));
                }
                if (fs.existsSync(tombstonePath)) {
                    tombstones = new Set(JSON.parse(await fs.promises.readFile(tombstonePath, 'utf8')));
                }
                if (fs.existsSync(blacklistPath)) {
                    const parsed = JSON.parse(await fs.promises.readFile(blacklistPath, 'utf8'));
                    const rawEntries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : []);
                    blacklist = new Set(rawEntries);
                }
            } catch (e) {
                console.error('[KanbanProvider] Failed to read registry/identity for scoping:', e);
            }

            const getStablePath = (p: string) => {
                const normalized = path.normalize(p);
                const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
                const rootPath = path.parse(stable).root;
                return stable.length > rootPath.length ? stable.replace(/[\\\/]+$/, '') : stable;
            };

            const getBaseBrainPath = (p: string) => p.replace(/\.resolved(\.\d+)?$/i, '');

            const activeSheets = sheets.filter((sheet: any) => {
                if (sheet.completed) return false;

                let planId = sheet.sessionId;
                if (sheet.brainSourcePath) {
                    const stablePath = getStablePath(getBaseBrainPath(path.resolve(sheet.brainSourcePath)));
                    if (blacklist.has(stablePath)) return false;
                    planId = crypto.createHash('sha256').update(stablePath).digest('hex');
                    if (tombstones.has(planId)) return false;
                }

                if (!planId) return false;
                const entry = registry.entries[planId];
                if (!entry) return false;
                
                return entry.ownerWorkspaceId === workspaceId && entry.status === 'active';
            });

            const cards: KanbanCard[] = activeSheets.map((sheet: any) => this._sheetToCard(sheet));
            this._panel.webview.postMessage({ type: 'render', cards });
        } catch (e) {
            console.error('[KanbanProvider] Failed to refresh board:', e);
        }
    }
```
- **Edge Cases Handled**: Normalizes Windows paths before hashing to accurately match tombstones/blacklists. Safely catches file read errors if the Switchboard protocol hasn't initialized these files yet.

## Verification Plan

### Automated Tests
- Validate that `_refreshBoard` properly drops mock sheets when `ownerWorkspaceId` does not match the workspace identity.

### Manual Testing
1. **Sidebar Discovery**: Start the Switchboard extension. Trigger an agent workflow that creates a new plan session. Verify the plan instantly appears in the Sidebar's `PLAN SELECT` dropdown without manual refreshing.
2. **Kanban Scoping**: Open two different VS Code windows pointing to two different Switchboard-enabled workspaces.
3. Open the `CLI-BAN` in both windows.
4. Create a plan in Workspace A. Verify it appears in Workspace A's Kanban board, but does **not** appear in Workspace B's Kanban board.

## Appendix: Implementation Patch
Apply the following patch to implement the changes across both files:

```diff
--- src/services/TaskViewerProvider.ts
+++ src/services/TaskViewerProvider.ts
@@ -... +... @@
     private _planFsDebounceTimers = new Map<string, NodeJS.Timeout>(); // debounce native plan watcher events
+    private _sessionWatcher?: vscode.FileSystemWatcher;
+    private _fsSessionWatcher?: fs.FSWatcher;
     private _refreshTimeout?: NodeJS.Timeout;
@@ -... +... @@
         this._setupStateWatcher();
         this._setupPlanWatcher();
+        this._setupSessionWatcher();
         this._setupGitCommitWatcher();
@@ -... +... @@
     public dispose() {
         this._stateWatcher?.dispose();
         this._planWatcher?.dispose();
+        this._sessionWatcher?.dispose();
         try { this._fsStateWatcher?.close(); } catch { }
         try { this._fsPlansWatcher?.close(); } catch { }
+        try { this._fsSessionWatcher?.close(); } catch { }
         if (this._refreshTimeout) clearTimeout(this._refreshTimeout);
@@ -... +... @@
         };
         this._fsPlansWatcher = watchPlanDirectory(plansRootDir);
     }
+
+    private _setupSessionWatcher() {
+        if (this._sessionWatcher) {
+            this._sessionWatcher.dispose();
+        }
+        try { this._fsSessionWatcher?.close(); } catch { }
+
+        const workspaceFolders = vscode.workspace.workspaceFolders;
+        if (!workspaceFolders) return;
+        const workspaceRoot = workspaceFolders.uri.fsPath;
+        const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');
+
+        if (!fs.existsSync(sessionsDir)) {
+            try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch { }
+        }
+
+        let sessionSyncTimer: NodeJS.Timeout | undefined;
+        const debouncedSessionSync = () => {
+            if (sessionSyncTimer) clearTimeout(sessionSyncTimer);
+            sessionSyncTimer = setTimeout(() => this._refreshRunSheets(), 300);
+        };
+
+        this._sessionWatcher = vscode.workspace.createFileSystemWatcher('**/.switchboard/sessions/*.json');
+        this._sessionWatcher.onDidCreate(() => debouncedSessionSync());
+        this._sessionWatcher.onDidChange(() => debouncedSessionSync());
+        this._sessionWatcher.onDidDelete(() => debouncedSessionSync());
+
+        const watchSessionDirectory = (dir: string): fs.FSWatcher | undefined => {
+            try {
+                return fs.watch(dir, (_eventType, filename) => {
+                    if (!filename || !filename.toString().endsWith('.json')) return;
+                    debouncedSessionSync();
+                });
+            } catch (e) {
+                console.error(`[TaskViewerProvider] fs.watch fallback failed for '${dir}':`, e);
+                return undefined;
+            }
+        };
+        this._fsSessionWatcher = watchSessionDirectory(sessionsDir);
+    }
 
     private _setupBrainWatcher() {

--- src/services/KanbanProvider.ts
+++ src/services/KanbanProvider.ts
@@ -... +... @@
     private async _refreshBoard() {
         const workspaceFolders = vscode.workspace.workspaceFolders;
         if (!workspaceFolders || !this._panel) return;
         const workspaceRoot = workspaceFolders.uri.fsPath;
         try {
             const log = this._getSessionLog(workspaceRoot);
             const sheets = await log.getRunSheets();
-            const activeSheets = sheets.filter((sheet: any) => sheet.completed !== true);
-            const cards: KanbanCard[] = activeSheets.map((sheet: any) => this._sheetToCard(sheet));
+
+            let workspaceId: string | null = null;
+            let registry: any = { entries: {} };
+            let tombstones = new Set<string>();
+            let blacklist = new Set<string>();
+
+            try {
+                const switchboardDir = path.join(workspaceRoot, '.switchboard');
+                const identityPath = path.join(switchboardDir, 'workspace_identity.json');
+                const registryPath = path.join(switchboardDir, 'plan_registry.json');
+                const tombstonePath = path.join(switchboardDir, 'plan_tombstones.json');
+                const blacklistPath = path.join(switchboardDir, 'brain_plan_blacklist.json');
+
+                if (fs.existsSync(identityPath)) {
+                    workspaceId = JSON.parse(await fs.promises.readFile(identityPath, 'utf8')).workspaceId;
+                }
+                if (fs.existsSync(registryPath)) {
+                    registry = JSON.parse(await fs.promises.readFile(registryPath, 'utf8'));
+                }
+                if (fs.existsSync(tombstonePath)) {
+                    tombstones = new Set(JSON.parse(await fs.promises.readFile(tombstonePath, 'utf8')));
+                }
+                if (fs.existsSync(blacklistPath)) {
+                    const parsed = JSON.parse(await fs.promises.readFile(blacklistPath, 'utf8'));
+                    const rawEntries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : []);
+                    blacklist = new Set(rawEntries);
+                }
+            } catch (e) {
+                console.error('[KanbanProvider] Failed to read registry/identity for scoping:', e);
+            }
+
+            const getStablePath = (p: string) => {
+                const normalized = path.normalize(p);
+                const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
+                const rootPath = path.parse(stable).root;
+                return stable.length > rootPath.length ? stable.replace(/[\\\/]+$/, '') : stable;
+            };
+
+            const getBaseBrainPath = (p: string) => p.replace(/\.resolved(\.\d+)?$/i, '');
+
+            const activeSheets = sheets.filter((sheet: any) => {
+                if (sheet.completed) return false;
+
+                let planId = sheet.sessionId;
+                if (sheet.brainSourcePath) {
+                    const stablePath = getStablePath(getBaseBrainPath(path.resolve(sheet.brainSourcePath)));
+                    if (blacklist.has(stablePath)) return false;
+                    planId = crypto.createHash('sha256').update(stablePath).digest('hex');
+                    if (tombstones.has(planId)) return false;
+                }
+
+                if (!planId) return false;
+                const entry = registry.entries[planId];
+                if (!entry) return false;
+                
+                return entry.ownerWorkspaceId === workspaceId && entry.status === 'active';
+            });
+
+            const cards: KanbanCard[] = activeSheets.map((sheet: any) => this._sheetToCard(sheet));
             this._panel.webview.postMessage({ type: 'render', cards });
         } catch (e) {
             console.error('[KanbanProvider] Failed to refresh board:', e);
         }
```

## Reviewer-Executor Pass (2026-03-12)

### Findings Summary
- CRITICAL: None.
- MAJOR: The new session watcher in `TaskViewerProvider.ts` stored its debounce timer in a local variable inside `_setupSessionWatcher()`. That timer could not be cleared during watcher re-setup or `dispose()`, which is exactly the lifecycle leak risk called out in the plan’s note.
- NIT: The worktree contains unrelated stale/generated JS drift in `src/services/TaskViewerProvider.js`, but that is outside this plan’s TypeScript implementation path and was not required to satisfy the approved scope here.

### Plan Requirement Check
- [x] `TaskViewerProvider.ts` now watches `.switchboard/sessions/*.json`.
- [x] The watcher includes an `fs.watch` fallback for gitignored session directories.
- [x] Watcher-triggered refreshes are debounced.
- [x] The debounce timer lifecycle is now explicitly managed across watcher re-setup and provider disposal.
- [x] `KanbanProvider.ts` enforces workspace ownership, tombstones, and blacklist filtering for active plans.

### Fixes Applied
- Promoted the session watcher debounce timer to a provider field (`_sessionSyncTimer`) so it can be cleared safely during `_setupSessionWatcher()` and `dispose()`.
- Updated the debounce callback to reset the timer field after firing, preventing stale handles from lingering.
- Rebuilt the extension bundle to verify the active implementation compiles cleanly.

### Files Changed in This Reviewer Pass
- `C:\Users\patvu\Documents\GitHub\switchboard\src\services\TaskViewerProvider.ts`
- `C:\Users\patvu\Documents\GitHub\switchboard\dist\extension.js`
- `C:\Users\patvu\Documents\GitHub\switchboard\.switchboard\plans\feature_plan_20260312_135938_fix_plan_detection.md`

### Validation Results
- `npx tsc -p . --noEmit`: PASS (exit code `0`).
- `npm run compile`: PASS (webpack completed successfully).

### Remaining Risks
- Manual verification is still required to confirm sidebar plan discovery refreshes immediately when new session JSON files land under `.switchboard/sessions/`.
- The repository still contains broader source-vs-generated JS drift in unrelated files; that was intentionally not expanded in this reviewer pass because it is outside this plan’s direct requirements.
