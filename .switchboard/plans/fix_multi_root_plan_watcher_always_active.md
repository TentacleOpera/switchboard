---
description: Fix plan file watchers to run for all configured workspaces, not just the active kanban workspace
---

# Fix Multi-Root Plan File Watchers Always Active

## Goal
Ensure plan file watchers run continuously for ALL configured workspaces in the workspace database mappings, not just the workspace currently active in the kanban panel. Currently, plans written in a non-active workspace don't appear until the file is re-saved or the kanban is switched.

## Metadata
**Tags:** backend, bugfix, reliability, workflow, testing
**Complexity:** 7
**Repo:** switchboard

## User Review Required
- [ ] Confirm: Kanban shows only current workspace plans, but watchers import plans from ALL workspaces to database

## Complexity Audit

### Routine
- **Service scaffolding:** Add `src/services/GlobalPlanWatcherService.ts` with `vscode.Disposable` lifecycle, watcher maps, and output-channel logging.
- **Configuration parsing:** Reuse the existing `workspaceDatabaseMappings` shape from `src/services/KanbanDatabase.ts:287-329` and `package.json:371-392`, including `parentFolder` support where present.
- **Watcher creation:** Move the folder collection pattern from `src/services/KanbanProvider.ts:693-733` into the global service so it can run without a selected kanban workspace.
- **Event wiring:** Register `onDidCreate`, `onDidChange`, and `onDidDelete` handlers using the same event types already used in `src/services/KanbanProvider.ts:777-792`.
- **Verification:** Add focused tests for folder de-duplication, watcher refresh behavior, and metadata extraction without requiring a live VS Code webview.

### Complex / Risky
- **Lifecycle decoupling:** The current watcher setup is owned by `KanbanProvider._setupPlanContentWatcher()` at `src/services/KanbanProvider.ts:735-842` and is recreated/disposed with UI state. Moving discovery to activation-time service ownership changes extension lifecycle behavior.
- **Database attribution:** Global imports must call `KanbanDatabase.forWorkspace(watchFolder)` with an actual filesystem root, not a workspace ID, and must preserve shared database workspace attribution via `getWorkspaceId()` / `getDominantWorkspaceId()` at `src/services/KanbanDatabase.ts:1694-1715`.
- **Duplicate events:** VS Code watchers and native `fs.watch` can both fire for the same file. The implementation must add per-file debouncing or reuse the existing metadata debounce strategy from `src/services/KanbanProvider.ts:932-1012`.
- **Configuration refresh leaks:** `vscode.workspace.onDidChangeConfiguration` registration must be stored in service disposables; otherwise every activation/config refresh can leave stale watchers or listeners behind.
- **UI refresh isolation:** `KanbanProvider` must refresh only when the currently displayed workspace matches the discovered file's workspace root; global discovery must not make the board show all workspaces at once.

## Edge-Case & Dependency Audit

**Race Conditions:**
- File change detected during workspace switch could be lost if UI-owned watchers are still the only active mechanism; global service mitigates this by running independently of `_currentWorkspaceRoot`.
- Multiple watchers for the same folder can be created if config changes rapidly; `_refreshWatchers()` must diff desired folders against existing watcher maps before creating new watchers.
- VS Code watcher and native watcher can process the same create/change event twice; use a short per-file debounce keyed by absolute path before database writes.
- Delete followed quickly by recreate can be misclassified by `fs.watch` `rename`; handlers must re-check `fs.existsSync(uri.fsPath)` immediately before delete processing.

**Security:**
- Watchers run for all configured folders; path traversal remains bounded by `path.resolve()` plus explicit directory existence checks before watcher creation.
- The service must not pass ClickUp workspace IDs or other external IDs into `KanbanDatabase.forWorkspace()`. Only resolved filesystem folders from `workspaceDatabaseMappings.parentFolder`, `workspaceDatabaseMappings.workspaceFolders`, or the active workspace fallback are valid.

**Side Effects:**
- Higher baseline file handle usage (watchers always active for all mapped folders)
- Database writes occurring "in background" for non-active workspaces
- Potential confusion if user expects kanban to only show "current" workspace
- More output-channel logging during activation and config changes.

**Dependencies & Conflicts:**
- Active Kanban board query returned no cards in CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, or COMPLETED columns, so no active-board dependency conflict was detected.
- `fix_plan_watcher_multi_root_workspace_mapping.md` is a related completed plan. It added multi-folder watching inside `KanbanProvider`; this plan must not regress its native watcher fallback or mapped-folder support.
- `bug_20260430_kanban_shared_db_workspace_id_sync.md` is a related completed plan. It added `parentFolder` mapping semantics; this plan must read both `parentFolder` and `workspaceFolders` consistently.
- `fix_kanbandatabase_directory_pollution_bug.md` is a same-batch plan. This plan's `GlobalPlanWatcherService` must only call `KanbanDatabase.forWorkspace()` with validated filesystem roots to avoid reintroducing directory pollution.

## Dependencies
- None

## Adversarial Synthesis
Key risks: Global watcher ownership can duplicate existing `KanbanProvider` watcher behavior, produce duplicate database writes, or leak watchers on configuration changes. Mitigations: centralize folder diffing in `GlobalPlanWatcherService`, debounce per-file handling, store configuration-listener disposables, and keep kanban UI filtering scoped to the selected workspace. Recommendation: Send to Lead Coder.

## Problem Analysis

### Current Behavior (Broken)

1. User opens kanban panel for workspace A → watchers set up for workspace A's folders
2. User creates plan in workspace B (different mapped folder) - either manually or via agent
3. **File watcher NOT active for workspace B** (kanban is showing workspace A)
4. Plan file created but no watcher detects it
5. Plan not imported to database
6. User switches kanban to workspace B → expects to see the plan → **plan NOT there**
7. User "touches" (re-saves) the file → now watcher detects it → plan appears

### Root Cause

The file watchers are set up in `_setupPlanContentWatcher()` which is called:
- When kanban panel is opened (`showKanban()`)
- When workspace is switched (`setWorkspaceRoot()`)

BUT watchers are **disposed** when:
- Panel is closed
- Workspace is switched (old watchers cleaned up, new ones created)

This means only ONE workspace's folders are watched at any given time.

### Expected Behavior (Fixed)

1. Extension activates → watchers set up for ALL configured workspace mappings
2. User creates plan in workspace B (while kanban is showing workspace A)
3. **Global file watcher detects the change** (runs for all mapped workspaces)
4. Plan imported to shared database with workspace B attribution
5. User switches kanban to workspace B → **plan IS there** (was imported in step 4)

## Proposed Changes

### Option A: Global Watcher Service (Recommended)

Create a new service `GlobalPlanWatcherService` that:
- Initializes on extension activation
- Watches ALL mapped workspace folders continuously
- Imports plans to database regardless of kanban UI state
- Emits events that KanbanProvider can listen to for UI refresh

### Option B: Persist Watchers Across Workspace Switches

Modify KanbanProvider to:
- NOT dispose watchers on workspace switch
- Keep a Map of folder → watcher
- Add new watchers when new workspace encountered
- Only dispose on extension deactivation

### Implementation: Option A (Global Watcher Service)

### Execution Breakdown by Complexity

#### Low Complexity Steps

1. **Add service file skeleton**
   - **File:** `src/services/GlobalPlanWatcherService.ts`
   - **Context:** New service alongside existing services in `src/services/`.
   - **Implementation:** Define `GlobalPlanWatcherService implements vscode.Disposable` with `_watchers`, `_nativeWatchers`, `_disposables`, optional `_outputChannel`, and `onPlanDiscovered`.
   - **Clarification:** The service is infrastructure only; it does not change which plans are displayed in the kanban board.

2. **Extract mapped folder resolution**
   - **File:** `src/services/GlobalPlanWatcherService.ts`
   - **Reference:** Existing folder collection in `src/services/KanbanProvider.ts:693-733`.
   - **Implementation:** Add `_getAllMappedFolders()` that reads `switchboard.workspaceDatabaseMappings`, expands `~`, resolves paths, prefers `mapping.parentFolder` where configured, includes valid `mapping.workspaceFolders` only when needed, and de-duplicates resolved paths.
   - **Clarification:** If no mappings are enabled, use the VS Code workspace folders as fallback rather than requiring the kanban panel to be open.

3. **Register activation-time service**
   - **File:** `src/extension.ts`
   - **Context:** `activate()` already constructs `KanbanProvider` and shared output channel imports are at `src/extension.ts:1-27`.
   - **Implementation:** Import `GlobalPlanWatcherService`, instantiate it after `KanbanProvider` exists, push it into `context.subscriptions`, and call `await globalPlanWatcher.initialize()`.

4. **Expose targeted refresh method**
   - **File:** `src/services/KanbanProvider.ts`
   - **Reference:** `_currentWorkspaceRoot` at `src/services/KanbanProvider.ts:141`; `_refreshBoard()` is the existing board refresh path.
   - **Implementation:** Add a public `refreshIfShowing(workspaceRoot: string): void | Promise<void>` that resolves both paths and schedules/executes refresh only when `workspaceRoot` matches `_currentWorkspaceRoot`.

5. **Add unit-test coverage for pure helpers**
   - **File:** `src/services/__tests__/GlobalPlanWatcherService.test.ts`
   - **Implementation:** Test folder de-duplication, home expansion, and metadata extraction as pure helper behavior with temporary directories.

#### High Complexity Steps

1. **Implement watcher diffing and disposal**
   - **File:** `src/services/GlobalPlanWatcherService.ts`
   - **Reference:** Current UI-bound cleanup at `src/services/KanbanProvider.ts:738-748`.
   - **Implementation:** `_refreshWatchers()` must compute desired folders, close watchers removed from config, keep existing watchers unchanged, and create watchers only for new folders.
   - **Risk:** Incorrect diffing leaks `fs.FSWatcher` handles or creates duplicate events after config changes.

2. **Implement debounced plan-file handling**
   - **File:** `src/services/GlobalPlanWatcherService.ts`
   - **Reference:** Existing metadata debounce map in `src/services/KanbanProvider.ts:932-1012`.
   - **Implementation:** Add a per-absolute-path debounce timer before calling `_handlePlanFile()` or `_handlePlanDelete()` so VS Code watcher and native watcher events coalesce.
   - **Risk:** Too-long debounce makes the board feel stale; no debounce risks duplicate DB writes and repeated integration sync.

3. **Preserve database attribution**
   - **File:** `src/services/GlobalPlanWatcherService.ts`
   - **Reference:** `KanbanDatabase.forWorkspace()` at `src/services/KanbanDatabase.ts:287-369`; workspace ID helpers at `src/services/KanbanDatabase.ts:1694-1715`.
   - **Implementation:** Use `watchFolder` as the filesystem root for DB lookup, compute relative plan path with `path.relative(watchFolder, uri.fsPath)`, and resolve workspace ID from DB config before inserting/updating.
   - **Risk:** Passing a ClickUp workspace ID or raw session ID into `forWorkspace()` reintroduces the directory pollution bug covered by `fix_kanbandatabase_directory_pollution_bug.md`.

4. **Avoid conflicting ownership with `KanbanProvider` watchers**
   - **File:** `src/services/KanbanProvider.ts`
   - **Reference:** Existing `_setupPlanContentWatcher()` at `src/services/KanbanProvider.ts:735-842`.
   - **Implementation:** Decide whether `KanbanProvider` keeps UI-local watchers for current workspace refresh or delegates all plan-content watching to `GlobalPlanWatcherService`. If both remain, document why duplicate events are harmless and ensure debouncing is shared or independently safe.
   - **Risk:** Two independent watcher systems can race on updates and deletes.

5. **Config-change listener lifecycle**
   - **File:** `src/services/GlobalPlanWatcherService.ts`
   - **Implementation:** Store the `vscode.workspace.onDidChangeConfiguration` disposable in `_disposables` and dispose it in `dispose()`.
   - **Risk:** Missing disposal creates hidden listeners after extension reloads/tests.

#### [NEW] `src/services/GlobalPlanWatcherService.ts`

```typescript
export class GlobalPlanWatcherService implements vscode.Disposable {
    private _watchers = new Map<string, vscode.FileSystemWatcher>();
    private _nativeWatchers = new Map<string, fs.FSWatcher>();
    private _outputChannel?: vscode.OutputChannel;
    private _onPlanDiscovered = new vscode.EventEmitter<{
        uri: vscode.Uri;
        workspaceRoot: string;
    }>();
    public readonly onPlanDiscovered = this._onPlanDiscovered.event;

    constructor(outputChannel?: vscode.OutputChannel) {
        this._outputChannel = outputChannel;
    }

    public async initialize(): Promise<void> {
        this._outputChannel?.appendLine('[GlobalPlanWatcher] Initializing...');
        await this._refreshWatchers();
        
        // Watch for configuration changes
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('switchboard.workspaceDatabaseMappings')) {
                this._outputChannel?.appendLine('[GlobalPlanWatcher] Config changed, refreshing watchers...');
                await this._refreshWatchers();
            }
        });
    }

    private async _refreshWatchers(): Promise<void> {
        // Get all folders that should be watched
        const foldersToWatch = await this._getAllMappedFolders();
        
        // Dispose watchers for folders no longer in config
        for (const [folder, watcher] of this._watchers) {
            if (!foldersToWatch.includes(folder)) {
                watcher.dispose();
                this._watchers.delete(folder);
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Stopped watching: ${folder}`);
            }
        }

        // Create watchers for new folders
        for (const folder of foldersToWatch) {
            if (!this._watchers.has(folder)) {
                this._setupWatcherForFolder(folder);
            }
        }
    }

    private async _getAllMappedFolders(): Promise<string[]> {
        const folders: string[] = [];
        
        try {
            const cfg = vscode.workspace.getConfiguration('switchboard')
                .get('workspaceDatabaseMappings') as
                { enabled?: boolean; mappings?: any[] } | undefined;

            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                for (const mapping of cfg.mappings) {
                    if (typeof mapping.parentWorkspaceFolder === 'string') {
                        const resolved = path.resolve(this._expandHome(mapping.parentWorkspaceFolder));
                        if (!folders.includes(resolved)) {
                            folders.push(resolved);
                        }
                    }
                }
            }
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Error reading config: ${err}`);
        }

        return folders;
    }

    private _expandHome(p: string): string {
        const trimmed = p.trim();
        return trimmed.startsWith('~')
            ? path.join(os.homedir(), trimmed.slice(1))
            : trimmed;
    }

    private _setupWatcherForFolder(folder: string): void {
        const plansDir = path.join(folder, '.switchboard', 'plans');
        if (!fs.existsSync(plansDir)) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Plans dir missing, skipping: ${plansDir}`);
            return;
        }

        // VS Code watcher
        const pattern = new vscode.RelativePattern(folder, '.switchboard/plans/**/*.md');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern, true, false, true);

        watcher.onDidCreate((uri) => {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Created: ${uri.fsPath}`);
            this._handlePlanFile(uri, folder);
        });

        watcher.onDidChange((uri) => {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Changed: ${uri.fsPath}`);
            this._handlePlanFile(uri, folder);
        });

        watcher.onDidDelete((uri) => {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Deleted: ${uri.fsPath}`);
            this._handlePlanDelete(uri, folder);
        });

        this._watchers.set(folder, watcher);
        this._outputChannel?.appendLine(`[GlobalPlanWatcher] Watching: ${folder}`);

        // Native fs.watch fallback (same as existing pattern)
        this._setupNativeWatcher(plansDir, folder);
    }

    private _setupNativeWatcher(plansDir: string, folder: string): void {
        try {
            const nativeWatcher = fs.watch(plansDir, { recursive: true }, (eventType, filename) => {
                if (!filename || !filename.endsWith('.md')) return;
                const fullPath = path.join(plansDir, filename);
                
                if (eventType === 'rename' || !fs.existsSync(fullPath)) {
                    if (!fs.existsSync(fullPath)) {
                        this._outputChannel?.appendLine(`[GlobalPlanWatcher] Native delete: ${fullPath}`);
                        this._handlePlanDelete(vscode.Uri.file(fullPath), folder);
                        return;
                    }
                }

                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Native change: ${fullPath}`);
                this._handlePlanFile(vscode.Uri.file(fullPath), folder);
            });

            this._nativeWatchers.set(folder, nativeWatcher);
        } catch (e) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Native watch failed: ${e}`);
        }
    }

    private async _handlePlanFile(uri: vscode.Uri, workspaceRoot: string): Promise<void> {
        // Import plan to database (similar to KanbanProvider._handlePlanFileChange)
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            
            // Check if plan already exists
            const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
            
            let plan = await db.getPlanByPlanFile(relativePath, workspaceId);
            
            if (!plan) {
                // New plan - parse and insert
                const content = await fs.promises.readFile(uri.fsPath, 'utf8');
                const metadata = this._parsePlanMetadata(content, relativePath);
                
                await db.upsertPlan({
                    sessionId: metadata.sessionId,
                    topic: metadata.topic,
                    planFile: relativePath,
                    kanbanColumn: metadata.kanbanColumn || 'CREATED',
                    status: 'active',
                    complexity: metadata.complexity,
                    tags: metadata.tags,
                    dependencies: metadata.dependencies,
                    workspaceId: workspaceId,
                    sourceType: 'local'
                });

                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Imported new plan: ${metadata.sessionId}`);
            } else {
                // Existing plan - update metadata
                const content = await fs.promises.readFile(uri.fsPath, 'utf8');
                const metadata = this._parsePlanMetadata(content, relativePath);
                
                await db.updateComplexity(plan.sessionId, metadata.complexity);
                await db.updateTags(plan.sessionId, metadata.tags);
                await db.updateDependencies(plan.sessionId, metadata.dependencies);
                
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Updated plan: ${plan.sessionId}`);
            }

            // Emit event for UI refresh
            this._onPlanDiscovered.fire({ uri, workspaceRoot });
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Error handling plan: ${err}`);
        }
    }

    private async _handlePlanDelete(uri: vscode.Uri, workspaceRoot: string): Promise<void> {
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            
            const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
            const plan = await db.getPlanByPlanFile(relativePath, workspaceId);
            
            if (plan) {
                await db.deletePlan(plan.sessionId);
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Deleted plan: ${plan.sessionId}`);
                this._onPlanDiscovered.fire({ uri, workspaceRoot });
            }
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Error deleting plan: ${err}`);
        }
    }

    private _parsePlanMetadata(content: string, planFile: string): {
        sessionId: string;
        topic: string;
        kanbanColumn?: string;
        complexity: string;
        tags: string;
        dependencies: string;
    } {
        // Extract metadata from plan content (reuse existing parsing logic)
        const sessionIdMatch = content.match(/sessionId:\s*([a-z0-9_]+)/i) || 
                               content.match(/## Metadata[\s\S]*?session[_\s]?id[:\s]+([a-z0-9_]+)/i);
        const sessionId = sessionIdMatch?.[1] || 
                         path.basename(planFile, '.md').replace(/^(feature_plan_\d+_|brain_|ingested_)/, '');

        const topicMatch = content.match(/^#\s+(.+)$/m) || 
                          content.match(/topic:\s*(.+)$/im);
        const topic = topicMatch?.[1] || 'Untitled Plan';

        const columnMatch = content.match(/kanbanColumn[:\s]+(\w+)/i);
        const complexityMatch = content.match(/\*\*Complexity:\*\*\s*(\d+|Low|High|Unknown)/i);
        const tagsMatch = content.match(/\*\*Tags:\*\*\s*(.+)$/im);

        return {
            sessionId,
            topic,
            kanbanColumn: columnMatch?.[1],
            complexity: complexityMatch?.[1] || 'Unknown',
            tags: tagsMatch?.[1] || '',
            dependencies: '' // Extract from Dependencies section
        };
    }

    public dispose(): void {
        for (const watcher of this._watchers.values()) {
            watcher.dispose();
        }
        this._watchers.clear();

        for (const watcher of this._nativeWatchers.values()) {
            watcher.close();
        }
        this._nativeWatchers.clear();
    }
}
```

#### [MODIFY] `src/extension.ts` - Initialize Global Watcher

```typescript
// In activate() function, after KanbanProvider initialization
const globalPlanWatcher = new GlobalPlanWatcherService(mcpOutputChannel);
context.subscriptions.push(globalPlanWatcher);
await globalPlanWatcher.initialize();

// Pass events to KanbanProvider for UI refresh
globalPlanWatcher.onPlanDiscovered(({ uri, workspaceRoot }) => {
    // Trigger kanban refresh if showing relevant workspace
    kanbanProvider.refreshIfShowing(workspaceRoot);
});
```

#### [MODIFY] `src/services/KanbanProvider.ts` - React to Global Events

```typescript
// KanbanProvider listens for new plans from any workspace and refreshes if showing that workspace
public refreshIfShowing(workspaceRoot: string): void {
    if (this._currentWorkspaceRoot === workspaceRoot) {
        this._refreshBoard(workspaceRoot);
    }
}

// Kanban continues to show ONLY current workspace plans
// The global watcher just ensures all workspaces' plans are in the database
```

## Verification Plan

### Automated Tests
- [ ] Unit tests for GlobalPlanWatcherService
- [ ] Tests for plan metadata extraction
- [ ] Tests for database operations

### Manual Verification
1. Configure workspace mappings (2+ workspaces → shared DB)
2. Open kanban for workspace A
3. Create plan in workspace B (without kanban open for B)
4. **Verify**: Kanban still shows workspace A plans only (no change)
5. Switch kanban to workspace B
6. **Verify**: Plan IS there (was imported by global watcher)
7. Modify plan in workspace B (while kanban still on workspace B)
8. **Verify**: Changes reflected in kanban
9. Switch kanban back to workspace A
10. Create another plan in workspace B
11. Switch kanban to workspace B
12. **Verify**: New plan is there (was imported while kanban was on workspace A)
13. Delete plan in workspace B
14. **Verify**: Plan removed from kanban

## Recommendation

**Send to Lead Coder** — Complexity 7 (High). This involves a new activation-time watcher service, decoupling plan discovery from the kanban UI lifecycle, preventing duplicate VS Code/native watcher events, and ensuring database operations work correctly across mapped workspaces.

## Related Plans

- `investigate_plan_file_watcher_not_detecting_new_plans.md` - COMPLETED (added logging + native fs.watch)
- `fix_plan_watcher_multi_root_workspace_mapping.md` - COMPLETED (added multi-folder watching for single kanban instance)
- **This plan addresses**: Watchers only active for current kanban workspace, not all mapped workspaces

### Relationship to Architectural Refactor Plans (1-4)

The 4-phase architectural refactor makes the **kanban workspace switcher the source of truth for workspace SELECTION** (which workspace the user is viewing).

This global watcher plan makes **file watching independent of workspace selection** — it imports plans from ALL configured workspaces to the database.

**How they work together:**

| Aspect | Architectural Refactor | Global Watcher Plan |
|:---|:---|:---|
| **Scope** | UI state (what user sees) | Background file watching |
| **Source of truth** | Kanban dropdown = which workspace is "active" | Database = all plans from all workspaces |
| **When it runs** | When user switches workspaces in kanban | Always, for ALL mapped workspaces |
| **Affects** | What appears in kanban panel | What gets imported to database |

**Example flow with both implemented:**
1. User has workspace A selected in kanban → sees workspace A's plans
2. User creates plan in workspace B (via agent or manually)
3. **Global watcher** (this plan) → detects file, imports to database
4. **Kanban still shows workspace A** (architectural refactor maintains selection)
5. User switches kanban to workspace B → **plan is already there** (imported in step 3)

**No conflict:** The architectural refactor doesn't change file watching behavior — it only centralizes workspace selection state. This plan adds global watching that runs independently of which workspace is selected.

**Integration point:** `GlobalPlanWatcherService` initializes in `extension.ts` alongside `KanbanProvider`, before any workspace is selected, and runs continuously.
