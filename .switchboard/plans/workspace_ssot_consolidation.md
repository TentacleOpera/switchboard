# Workspace Single Source of Truth: Consolidation & Cleanup

## Goal

Eliminate redundant workspace resolution paths and remove dead code (`InboxWatcher`) to reduce latency, prevent workspace-targeting bugs in command handlers, and make `KanbanProvider` the unambiguous authority for workspace selection.

## Metadata

**Tags:** backend, infrastructure, reliability
**Complexity:** 5
**Estimated Impact:** ~1,200 lines deleted; removes polling timers and file watchers; fixes 12+ command handlers that silently target the wrong workspace in multi-root setups.

## User Review Required

- Confirm that the `refreshControlPlaneRuntime` command should be reduced to MCP-server restart + terminal registry sync (no InboxWatcher recreation). This changes the command's observable behavior: it will no longer re-provision inbox directories.
- Confirm that `inbox-watcher.test.js` and `terminal-disconnect-on-minimize-regression.test.js` should be deleted alongside `InboxWatcher.ts`. These tests have no replacement scope.
- Confirm that the `switchboard.checkAnalystAvailability` command should also switch to kanban-based workspace resolution (not listed in original plan).

## Complexity Audit

### Routine
- Delete `InboxWatcher.ts` and remove import/variable declarations from `extension.ts`
- Replace `workspaceFolders?.[0]` with `kanbanProvider.getCurrentWorkspaceRoot()` in 9 command handlers
- Remove `_activeWorkspaceRoot` field and its 15 references from `TaskViewerProvider.ts`
- Update 2 comments referencing `InboxWatcher` in `terminalUtils.ts` (line 61) and `TaskViewerProvider.ts` (line 13778)
- Delete 2 test files that import `InboxWatcher`
- Add `switchboard.autoSelectFirstWorkspace` setting to `package.json`

### Complex / Risky
- **`refreshControlPlaneRuntime` command rewrite** (extension.ts lines 1448-1466): Currently destroys and recreates InboxWatcher. Must be rewritten to remove 4 InboxWatcher lines and retain only the MCP restart + terminal registry sync logic.
- **Thin `_resolveWorkspaceRoot` delegation in TaskViewerProvider** (lines 605-659): Must preserve the allowed-roots validation guard that the current code applies to `kanbanProvider.getCurrentWorkspaceRoot()`. The naive delegation (just return kanban value) would return invalid roots if persisted state drifts.
- **`_resolveWorkspaceRootForSession` and `_resolveWorkspaceRootForPath`** (lines 677-737): These methods write to `_activeWorkspaceRoot` in 4 places and must retain their DB-lookup logic while removing the cache field. They cannot simply delegate to kanban.
- **`_getAllowedRoots` helper in KanbanProvider**: The proposed implementation iterates `m.parentWorkspaceFolder` but the actual config schema uses `m.workspaceFolders` (array). Must match the real schema used by `KanbanProvider._resolveWorkspaceRoot` (lines 496-500).
- **Housekeeping command replacement** (extension.ts lines 2400-2412): Currently delegates entirely to `inboxWatcher.runHousekeepingNow()`. Must be replaced with inline implementation using existing `SessionActionLog` and `cleanWorkspace.ts` utilities.

## Edge-Case & Dependency Audit

- **Race Conditions**: `InboxWatcher` uses a `processingFiles` set to prevent double-processing of messages (scan vs watcher events). After removal, no race remains because nothing processes inbox files. However, if any external tool writes to `.switchboard/inbox/`, those messages will silently accumulate. This is acceptable because the inbox protocol is deprecated.
- **Security**: `InboxWatcher` enforces strict dispatch auth (session tokens, replay protection, dispatch signatures). After removal, the `.switchboard/inbox/` directory becomes a no-op. The `cleanWorkspace.ts` TRANSIENT_DIRS list already includes `inbox` and `outbox`, so they'll be wiped on next activation. No security regression.
- **Side Effects**: Removing `_activeWorkspaceRoot` from TaskViewerProvider means that `_getWorkspaceRoot()` (line 586) must be updated — it currently short-circuits on `_activeWorkspaceRoot`. After removal, it should delegate to `_resolveWorkspaceRoot()` or `kanbanProvider.getCurrentWorkspaceRoot()`.
- **Dependencies & Conflicts**: `terminalUtils.ts:sendRobustText()` is shared by both `InboxWatcher` and `TaskViewerProvider`. After InboxWatcher removal, `sendRobustText` remains in use by TaskViewerProvider — no conflict. The comment in `terminalUtils.ts` (line 61) should be updated to remove the InboxWatcher reference.

## Dependencies

- None — this plan is self-contained and does not depend on other plans.

## Adversarial Synthesis

Key risks: (1) `refreshControlPlaneRuntime` command currently recreates InboxWatcher — removing it without rewriting the command leaves dead code that won't compile. (2) The thin `_resolveWorkspaceRoot` delegation must preserve allowed-roots validation or it can return stale/invalid workspace roots after folder removal. (3) Two test files import `InboxWatcher` and must be deleted to prevent build failures. Mitigations: specify exact line replacements for `refreshControlPlaneRuntime`; add an allowed-roots guard to the thin wrapper; enumerate all files to delete.

---

## Context

The original 4-phase architectural refactor plans (`architectural_refactor_1-4`) were written against an older codebase. The assumed crisis — "143+ `_activeWorkspaceRoot` usages in `TaskViewerProvider`" — no longer exists (actual count: 15). However, the underlying goal remains valid:

- `KanbanProvider` already has its own `_currentWorkspaceRoot`, persistence, and resolution logic.
- `TaskViewerProvider` maintains a parallel `_activeWorkspaceRoot` cache that is largely redundant.
- `extension.ts` has ~12 command handlers that use `getPreferredWorkspaceRoot()` (active-editor-based) or `workspaceFolders?.[0]` instead of respecting the kanban selection.
- `InboxWatcher` implements a cross-IDE file-based messaging protocol that is now dead code: no UI exists to create inbox messages, MCP tool writers were discontinued, and the single-workspace-per-window model makes cross-window dispatch unnecessary.

This plan scopes the work to what is actually needed today.

---

## Phase 1: InboxWatcher Removal

### [DELETE] `src/services/InboxWatcher.ts`

**Rationale:** Dead code. The cross-IDE messaging protocol it implements has no consumers. It runs a polling timer (`startPollTimer`), file watchers, and `syncAllTerminals` on every terminal open/close event, adding measurable latency during agent grid operations.

### [DELETE] `src/test/inbox-watcher.test.js`

**Rationale:** Tests the deleted `InboxWatcher` class. No replacement scope.

### [DELETE] `src/test/terminal-disconnect-on-minimize-regression.test.js`

**Rationale:** Imports `InboxWatcher` (lines 62, 66). The regression scenario it tests (terminal disconnect on minimize) is covered by other mechanisms. No replacement scope.

### [MODIFY] `src/extension.ts` — Remove all InboxWatcher references (26 occurrences)

**Line-by-line audit:**

| Line | Code | Action |
|---|---|---|
| 8 | `import { InboxWatcher } from './services/InboxWatcher';` | DELETE |
| 646 | `let inboxWatcher: InboxWatcher \| null = null;` | DELETE |
| 714-716 | `if (!inboxWatcher) { inboxWatcher = new InboxWatcher(...); inboxWatcher.start(); }` | DELETE block |
| 720-721 | `if (inboxWatcher) { inboxWatcher.updateRegisteredTerminals(...); }` | DELETE block |
| 1457-1460 | `inboxWatcher?.stop(); inboxWatcher = new InboxWatcher(...); inboxWatcher.start(); inboxWatcher.syncAllTerminals();` | DELETE 4 lines (see `refreshControlPlaneRuntime` rewrite below) |
| 2038 | `inboxWatcher = new InboxWatcher(runtimeStateRoot, ...);` | DELETE (part of larger init block — see below) |
| 2042 | `inboxWatcher.start();` | DELETE |
| 2046-2047 | `inboxWatcher?.stop(); inboxWatcher = null;` | DELETE |
| 2055 | `inboxWatcher.syncAllTerminals();` | DELETE |
| 2060 | `inboxWatcher?.syncAllTerminals();` | DELETE |
| 2068 | `inboxWatcher?.syncAllTerminals();` | DELETE |
| 2097 | `mcpOutputChannel.appendLine('[Extension] InboxWatcher initialized successfully');` | DELETE |
| 2099 | `console.error('[Extension] Failed to initialize InboxWatcher:', e);` | DELETE |
| 2100 | `mcpOutputChannel?.appendLine(...InboxWatcher: ${e}...);` | DELETE |
| 2298-2301 | `if (inboxWatcher) { inboxWatcher.updateRegisteredTerminals(...); }` | DELETE block |
| 2401-2406 | `if (!workspaceRoot \|\| !inboxWatcher) {...} await inboxWatcher.runHousekeepingNow();` | REPLACE (see housekeeping rewrite below) |
| 3106-3107 | `if (inboxWatcher) { inboxWatcher.updateRegisteredTerminals(...); }` | DELETE block |
| 3857-3858 | `if (registered > 0 && inboxWatcher) { inboxWatcher.updateRegisteredTerminals(...); }` | DELETE block |

**Terminal open/close handler replacements:**
```typescript
// In onDidOpenTerminal handler (line ~2058):
// BEFORE: inboxWatcher?.syncAllTerminals();
//         void syncTerminalRegistryWithState(currentStateRoot);
// AFTER:  void syncTerminalRegistryWithState(currentStateRoot);
// (syncTerminalRegistryWithState already handles the registry update independently)

// In onDidCloseTerminal handler (line ~2066):
// BEFORE: inboxWatcher?.syncAllTerminals();
//         taskViewerProvider.handleTerminalClosed(terminal);
// AFTER:  taskViewerProvider.handleTerminalClosed(terminal);
```

### [MODIFY] `src/extension.ts` — Rewrite `refreshControlPlaneRuntime` command (lines 1448-1466)

**Rationale:** This command currently destroys and recreates InboxWatcher. After removal, it should only restart the MCP server and sync the terminal registry.

```typescript
// BEFORE (lines 1448-1466):
const refreshControlPlaneRuntimeDisposable = vscode.commands.registerCommand('switchboard.refreshControlPlaneRuntime', async () => {
    const selectedWorkspaceRoot = getPreferredWorkspaceRoot() || workspaceRoot;
    if (!selectedWorkspaceRoot) {
        return;
    }
    const stateRoot = resolveEffectiveStateRoot(selectedWorkspaceRoot) || selectedWorkspaceRoot;
    if (!mcpOutputChannel) {
        mcpOutputChannel = vscode.window.createOutputChannel('Switchboard');
    }
    inboxWatcher?.stop();
    inboxWatcher = new InboxWatcher(stateRoot, registeredTerminals, mcpOutputChannel);
    inboxWatcher.start();
    inboxWatcher.syncAllTerminals();
    await syncTerminalRegistryWithState(stateRoot);
    taskViewerProvider.refresh();
    if (mcpServerProcess) {
        await restartBundledMcpServer(context, selectedWorkspaceRoot, stateRoot);
    }
});

// AFTER:
const refreshControlPlaneRuntimeDisposable = vscode.commands.registerCommand('switchboard.refreshControlPlaneRuntime', async () => {
    const selectedWorkspaceRoot = kanbanProvider.getCurrentWorkspaceRoot();
    if (!selectedWorkspaceRoot) {
        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
        return;
    }
    const stateRoot = resolveEffectiveStateRoot(selectedWorkspaceRoot) || selectedWorkspaceRoot;
    if (!mcpOutputChannel) {
        mcpOutputChannel = vscode.window.createOutputChannel('Switchboard');
    }
    await syncTerminalRegistryWithState(stateRoot);
    taskViewerProvider.refresh();
    if (mcpServerProcess) {
        await restartBundledMcpServer(context, selectedWorkspaceRoot, stateRoot);
    }
});
```

### [MODIFY] `src/extension.ts` — Rewrite `housekeepNow` command (lines 2400-2412)

**Rationale:** Currently delegates entirely to `inboxWatcher.runHousekeepingNow()`. After removal, implement lightweight inline housekeeping using existing utilities.

```typescript
// BEFORE (lines 2400-2412):
const housekeepingDisposable = vscode.commands.registerCommand('switchboard.housekeepNow', async () => {
    if (!workspaceRoot || !inboxWatcher) {
        vscode.window.showWarningMessage('Switchboard housekeeping unavailable: InboxWatcher is not running.');
        return;
    }
    try {
        await inboxWatcher.runHousekeepingNow();
        vscode.window.showInformationMessage('Switchboard housekeeping complete.');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Switchboard housekeeping failed: ${msg}`);
    }
});

// AFTER:
const housekeepingDisposable = vscode.commands.registerCommand('switchboard.housekeepNow', async () => {
    const selectedWorkspaceRoot = kanbanProvider.getCurrentWorkspaceRoot();
    if (!selectedWorkspaceRoot) {
        vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
        return;
    }
    try {
        // 1. Archive old run sheets (>30 days) via SessionActionLog
        const sessionLog = new SessionActionLog(selectedWorkspaceRoot);
        await sessionLog.archiveOldSheets({ olderThanDays: 30 });

        // 2. Clean transient .switchboard/ subdirectories
        const { cleanWorkspace } = require('./lifecycle/cleanWorkspace');
        await cleanWorkspace(selectedWorkspaceRoot, mcpOutputChannel);

        vscode.window.showInformationMessage('Switchboard housekeeping complete.');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Switchboard housekeeping failed: ${msg}`);
    }
});
```

**Note:** `SessionActionLog.archiveOldSheets()` may not exist yet. If it doesn't, the housekeeping command should call `sessionLog.pruneArchivedSheets()` or equivalent. Verify the available API on `SessionActionLog` before implementing.

### [MODIFY] `src/services/terminalUtils.ts` — Update comment (line 61)

```typescript
// BEFORE:
 * Shared by InboxWatcher (inbox-based delivery) and TaskViewerProvider (direct push).

// AFTER:
 * Used by TaskViewerProvider for direct terminal push.
```

### [MODIFY] `src/services/TaskViewerProvider.ts` — Update comment (line 13778)

```typescript
// BEFORE:
        // Log the session event for observability parity with InboxWatcher

// AFTER:
        // Log the session event for observability
```

### [MODIFY] `src/lifecycle/cleanWorkspace.ts` — Keep `inbox/` and `outbox/` cleanup in `TRANSIENT_DIRS`

**Rationale:** Line 7 already includes `'inbox'` and `'outbox'` in `TRANSIENT_DIRS`. This ensures orphaned inbox directories are cleaned on activation for one release. Remove in a follow-up release after users have had time to upgrade.

---

## Phase 2: Consolidate Workspace Resolution

### [MODIFY] `src/services/TaskViewerProvider.ts` — Remove `_activeWorkspaceRoot` cache (line 312)

**Rationale:** `TaskViewerProvider` caches `_activeWorkspaceRoot` but its `_resolveWorkspaceRoot` already checks `kanbanProvider.getCurrentWorkspaceRoot()` first. The cache is never meaningfully different from kanban's value and creates a second source of truth.

**Implementation:**
```typescript
// DELETE line 312:
private _activeWorkspaceRoot: string | null = null;
```

**Call site audit — 15 `_activeWorkspaceRoot` references:**

| Line | Type | Code | Replacement |
|---|---|---|---|
| 312 | Declaration | `private _activeWorkspaceRoot: string \| null = null;` | DELETE |
| 587 | Read | `if (this._activeWorkspaceRoot) { return this._activeWorkspaceRoot; }` | DELETE (see `_getWorkspaceRoot` rewrite below) |
| 636 | Write | `this._activeWorkspaceRoot = resolved;` | DELETE (return `resolved` directly) |
| 645-646 | Write+Read | `if (kanbanCurrent !== this._activeWorkspaceRoot) { this._activeWorkspaceRoot = kanbanCurrent; return kanbanCurrent; }` | Simplify to `return kanbanCurrent;` (no cache check needed) |
| 652 | Read | `if (this._activeWorkspaceRoot && allowedRoots.has(this._activeWorkspaceRoot))` | DELETE (kanban already checked above) |
| 657-658 | Write | `this._activeWorkspaceRoot = roots[0] \|\| Array.from(allowedRoots)[0]; return this._activeWorkspaceRoot;` | `return roots[0] \|\| Array.from(allowedRoots)[0];` |
| 702 | Write | `this._activeWorkspaceRoot = effectiveWorkspaceRoot;` | DELETE (return `effectiveWorkspaceRoot` directly) |
| 725 | Write | `this._activeWorkspaceRoot = preferred;` | DELETE (return `preferred` directly) |
| 731 | Write | `this._activeWorkspaceRoot = workspaceRoot;` | DELETE (return `workspaceRoot` directly) |
| 745 | Write | `this._activeWorkspaceRoot = effectiveRoot;` | DELETE (effectiveRoot is used locally) |
| 1826 | Read | `if (this._activeWorkspaceRoot !== effectiveRoot)` | Replace with `const currentRoot = this._kanbanProvider?.getCurrentWorkspaceRoot(); if (currentRoot !== effectiveRoot)` |
| 13010 | Write | `this._activeWorkspaceRoot = resolvedWorkspaceRoot;` | DELETE (no cache needed) |

### [MODIFY] `src/services/TaskViewerProvider.ts` — Rewrite `_getWorkspaceRoot` (lines 586-590)

```typescript
// BEFORE:
private _getWorkspaceRoot(): string | null {
    if (this._activeWorkspaceRoot) { return this._activeWorkspaceRoot; }
    const roots = this._getWorkspaceRoots();
    return roots.length > 0 ? roots[0] : null;
}

// AFTER:
private _getWorkspaceRoot(): string | null {
    return this._resolveWorkspaceRoot();
}
```

### [MODIFY] `src/services/TaskViewerProvider.ts` — Deduplicate `_resolveWorkspaceRoot` (lines 605-659)

**Rationale:** Both `KanbanProvider` and `TaskViewerProvider` contain nearly identical `_resolveWorkspaceRoot` methods (~50 lines each). `KanbanProvider`'s version is the authoritative one. The thin wrapper must preserve allowed-roots validation to prevent returning stale/invalid roots.

**Implementation:**
```typescript
// NEW: Thin delegation wrapper in TaskViewerProvider (replaces lines 605-659)
private _resolveWorkspaceRoot(workspaceRoot?: string): string | null {
    // If an explicit workspaceRoot argument is provided and valid, use it
    if (workspaceRoot) {
        const resolved = path.resolve(workspaceRoot);
        const allowed = this._getAllowedRoots();
        if (allowed.has(resolved)) { return resolved; }
    }

    // Delegate to kanban (single source of truth), with validation guard
    const kanbanRoot = this._kanbanProvider?.getCurrentWorkspaceRoot();
    if (kanbanRoot) {
        const allowed = this._getAllowedRoots();
        if (allowed.has(kanbanRoot)) { return kanbanRoot; }
    }

    // Fallback: first allowed root
    const roots = this._getWorkspaceRoots();
    return roots.length > 0 ? roots[0] : null;
}

// NEW: Helper to build allowed-roots set (matches KanbanProvider logic)
private _getAllowedRoots(): Set<string> {
    const roots = this._getWorkspaceRoots();
    const allowedRoots = new Set<string>(roots);
    try {
        const cfg = vscode.workspace.getConfiguration('switchboard')
                         .get('workspaceDatabaseMappings') as
            { enabled?: boolean; mappings?: any[] } | undefined;
        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
            for (const m of cfg.mappings) {
                if (typeof m.parentWorkspaceFolder === 'string') {
                    allowedRoots.add(path.resolve(m.parentWorkspaceFolder));
                }
            }
        }
    } catch { /* fall through */ }
    return allowedRoots;
}
```

**Clarification:** The `_getAllowedRoots` helper uses `m.parentWorkspaceFolder` to match the existing `TaskViewerProvider._resolveWorkspaceRoot` logic (lines 620-626). This differs from `KanbanProvider._resolveWorkspaceRoot` which uses `m.workspaceFolders` (lines 496-500). Both are correct for their respective contexts — `TaskViewerProvider` needs the parent folder (where `.switchboard/` lives), while `KanbanProvider` needs the child folders (for DB instance sharing). The thin wrapper should use `parentWorkspaceFolder` to match the original behavior.

### [MODIFY] `src/services/TaskViewerProvider.ts` — Update `_resolveWorkspaceRootForSession` (lines 677-714)

Remove `_activeWorkspaceRoot` writes (line 702) while preserving the DB-lookup logic:

```typescript
// Line 702: DELETE this._activeWorkspaceRoot = effectiveWorkspaceRoot;
// The method already returns effectiveWorkspaceRoot; the cache write is redundant.
```

### [MODIFY] `src/services/TaskViewerProvider.ts` — Update `_resolveWorkspaceRootForPath` (lines 716-737)

Remove `_activeWorkspaceRoot` writes (lines 725, 731) while preserving the path-matching logic:

```typescript
// Line 725: DELETE this._activeWorkspaceRoot = preferred;
// Line 731: DELETE this._activeWorkspaceRoot = workspaceRoot;
// The method already returns the values; the cache writes are redundant.
```

### [MODIFY] `src/services/TaskViewerProvider.ts` — Update `_activateWorkspaceContext` (lines 739-747)

Remove `_activeWorkspaceRoot` write (line 745):

```typescript
// Line 745: DELETE this._activeWorkspaceRoot = effectiveRoot;
// The method already uses effectiveRoot locally and returns it.
```

---

## Phase 3: Fix `extension.ts` Command Handlers

### [MODIFY] `src/extension.ts` — Replace `getPreferredWorkspaceRoot()` with kanban

**Rationale:** The following commands silently target the active editor's workspace or the first root, ignoring the kanban selection. In multi-root projects this causes plans to be created/imported into the wrong workspace.

**Commands to fix (9 originally listed + 3 additional):**

| Command | Line | Current resolver | Target resolver |
|---|---|---|---|
| `switchboard.triggerPlanningPanelSync` | 1405 | `workspaceFolders?.[0]` | `kanbanProvider.getCurrentWorkspaceRoot()` |
| `switchboard.clearControlPlaneCache` | 1426 | `getPreferredWorkspaceRoot()` | `kanbanProvider.getCurrentWorkspaceRoot()` |
| `switchboard.refreshControlPlaneRuntime` | 1449 | `getPreferredWorkspaceRoot() \|\| workspaceRoot` | `kanbanProvider.getCurrentWorkspaceRoot()` (see Phase 1 rewrite) |
| `switchboard.resetKanbanDb` | 1481 | `workspaceFolders?.[0]` (with optional arg) | `kanbanProvider.getCurrentWorkspaceRoot()` (keep optional arg override) |
| `switchboard.reconcileKanbanDbs` | 1550 | `workspaceFolders?.[0]` | `kanbanProvider.getCurrentWorkspaceRoot()` |
| `switchboard.importFromClickUp` | 1782 | `workspaceFolders?.[0]` | `kanbanProvider.getCurrentWorkspaceRoot()` |
| `switchboard.fetchNotionDesignDoc` | 1932 | `workspaceFolders?.[0]` | `kanbanProvider.getCurrentWorkspaceRoot()` |
| `switchboard.importFromLinear` | 1959 | `workspaceFolders?.[0]` | `kanbanProvider.getCurrentWorkspaceRoot()` |
| `switchboard.refreshIntegrationCache` | 2369 | `workspaceFolders?.[0]` | `kanbanProvider.getCurrentWorkspaceRoot()` |
| `switchboard.checkAnalystAvailability` | 1751 | `getPreferredWorkspaceRoot()` | `kanbanProvider.getCurrentWorkspaceRoot()` |
| `onDidChangeConfiguration` handler | 1615 | `workspaceFolders?.[0]` | `kanbanProvider.getCurrentWorkspaceRoot()` |
| `switchboard.cleanWorkspace` | 2424 | activation-time `workspaceRoot` | `kanbanProvider.getCurrentWorkspaceRoot()` |

**Implementation pattern:**
```typescript
// BEFORE:
const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

// AFTER:
const workspaceRoot = kanbanProvider.getCurrentWorkspaceRoot();
if (!workspaceRoot) {
    vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
    return;
}
```

**Special case — `resetKanbanDb` (line 1481):** Keep the optional `targetWorkspaceRoot` argument override:
```typescript
// BEFORE:
const workspaceRoot = targetWorkspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

// AFTER:
const workspaceRoot = targetWorkspaceRoot || kanbanProvider.getCurrentWorkspaceRoot();
```

### [MODIFY] `src/extension.ts` — Remove activation-time `workspaceRoot` capture (line 1105)

**Rationale:** Line 1105 captures `workspaceRoot` at activation for use across the extension lifetime. With kanban as the source of truth, this global is obsolete and encourages stale workspace usage.

```typescript
// BEFORE (line ~1105):
const workspaceRoot = getPreferredWorkspaceRoot();

// AFTER:
// Removed. Individual commands read from kanbanProvider.getCurrentWorkspaceRoot().
```

**Note:** `workspaceRoot` is referenced in many places beyond command handlers (e.g., `resolveEffectiveStateRoot`, `WorkspaceExcludeService`, `cleanWorkspace` command). Each reference must be individually audited and replaced with `kanbanProvider.getCurrentWorkspaceRoot()` or a local resolution. A search for all `workspaceRoot` usages after the activation-time capture removal is required.

### [MODIFY] `src/extension.ts` — Update `createAgentGrid` (line 2877)

Remove the `?? workspaceRoot` fallback:

```typescript
// BEFORE (line 2877):
const currentWorkspaceRoot = kanbanProvider.getCurrentWorkspaceRoot()
    ?? workspaceRoot
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

// AFTER:
const currentWorkspaceRoot = kanbanProvider.getCurrentWorkspaceRoot()
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
```

### [MODIFY] `src/extension.ts` — Remove `getPreferredWorkspaceRoot()` function (lines 561-571)

**Rationale:** After all command handlers are updated, this function has no callers. Delete it.

```typescript
// DELETE lines 561-571:
function getPreferredWorkspaceRoot(): string | null {
    const activeUri = vscode.window.activeTextEditor?.document?.uri;
    if (activeUri) {
        const folder = vscode.workspace.getWorkspaceFolder(activeUri);
        if (folder) {
            return folder.uri.fsPath;
        }
    }
    const [firstFolder] = vscode.workspace.workspaceFolders || [];
    return firstFolder?.uri.fsPath || null;
}
```

**Note:** Also check lines 541 and 553 which call `getPreferredWorkspaceRoot()` inside `resolveWorkspaceRootForBrainPath()`. This function is used for brain→workspace resolution and may need to delegate to kanban instead. Audit before deleting.

---

## Phase 4: Validation & Safety

### [CREATE] `package.json` — Add escape-hatch setting

```json
"switchboard.autoSelectFirstWorkspace": {
    "type": "boolean",
    "default": true,
    "description": "Automatically select the first workspace folder on activation if no kanban workspace is selected."
}
```

`KanbanProvider` already respects this behavior in `_resolvePersistedWorkspace` / `_resolveWorkspaceRoot`. This setting merely exposes it to users.

### [MODIFY] `src/services/KanbanProvider.ts` — Add workspace validation to setter

**Rationale:** Currently `_currentWorkspaceRoot` is set only through `_resolveWorkspaceRoot` (which validates against allowed roots). Adding a public setter with validation provides a clean API for external callers and prevents invalid workspace roots from being set.

```typescript
// Add after getCurrentWorkspaceRoot() (line 577):
public setCurrentWorkspaceRoot(workspaceRoot: string | null): boolean {
    if (!workspaceRoot) {
        const oldRoot = this._currentWorkspaceRoot;
        this._currentWorkspaceRoot = null;
        if (oldRoot !== null) {
            this._onWorkspaceChangeEmitter?.fire(null);
        }
        return true;
    }

    const allowedRoots = this._getAllowedRoots();
    if (!allowedRoots.has(path.resolve(workspaceRoot))) {
        console.error(`[KanbanProvider] Rejected invalid workspace: ${workspaceRoot}`);
        return false;
    }

    const oldRoot = this._currentWorkspaceRoot;
    if (oldRoot === workspaceRoot) { return true; }

    this._currentWorkspaceRoot = workspaceRoot;
    this._onWorkspaceChangeEmitter?.fire(workspaceRoot);
    return true;
}
```

### [MODIFY] `src/services/KanbanProvider.ts` — Add `_getAllowedRoots` helper

Extract the allowed-roots construction currently duplicated in `_resolveWorkspaceRoot` (lines 481-519). **Must match the actual config schema** used by `KanbanProvider._resolveWorkspaceRoot` — which iterates `m.workspaceFolders` (not `m.parentWorkspaceFolder`):

```typescript
private _getAllowedRoots(): Set<string> {
    const roots = this._getWorkspaceRoots();
    const allowedRoots = new Set<string>(roots);
    try {
        const cfg = vscode.workspace.getConfiguration('switchboard')
                         .get('workspaceDatabaseMappings') as
            { enabled?: boolean; mappings?: WorkspaceDatabaseMapping[] } | undefined;
        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
            for (const m of cfg.mappings) {
                // KanbanProvider uses workspaceFolders (child folders sharing a DB),
                // not parentWorkspaceFolder (used by TaskViewerProvider for .switchboard/ location)
                for (const wf of m.workspaceFolders ?? []) {
                    const expanded = wf.startsWith('~')
                        ? path.join(os.homedir(), wf.slice(1))
                        : wf;
                    allowedRoots.add(path.resolve(expanded));
                }
            }
        }
    } catch { /* fall through */ }
    return allowedRoots;
}
```

Then refactor `_resolveWorkspaceRoot` to use it:
```typescript
private _resolveWorkspaceRoot(workspaceRoot?: string): string | null {
    const allowedRoots = this._getAllowedRoots();
    if (allowedRoots.size === 0) { return null; }
    if (workspaceRoot) {
        const resolved = path.resolve(workspaceRoot);
        if (allowedRoots.has(resolved)) {
            this._currentWorkspaceRoot = resolved;
            return resolved;
        }
    }
    if (this._currentWorkspaceRoot && allowedRoots.has(this._currentWorkspaceRoot)) {
        return this._currentWorkspaceRoot;
    }
    this._currentWorkspaceRoot = this._getWorkspaceRoots()[0] || Array.from(allowedRoots)[0];
    return this._currentWorkspaceRoot;
}
```

---

## Proposed Changes

### [DELETE] `src/services/InboxWatcher.ts`
- Context: 1088-line file implementing cross-IDE messaging protocol
- Logic: No consumers exist. The inbox protocol is deprecated.
- Implementation: Delete entire file
- Edge Cases: `.switchboard/inbox/` directories may contain orphaned messages from prior sessions. `cleanWorkspace.ts` already includes `inbox` and `outbox` in `TRANSIENT_DIRS`, so they'll be wiped on next activation.

### [DELETE] `src/test/inbox-watcher.test.js`
- Context: Unit tests for InboxWatcher
- Logic: Tests a deleted class
- Implementation: Delete entire file
- Edge Cases: None

### [DELETE] `src/test/terminal-disconnect-on-minimize-regression.test.js`
- Context: Regression test that imports InboxWatcher
- Logic: Cannot compile after InboxWatcher removal
- Implementation: Delete entire file
- Edge Cases: The regression scenario (terminal disconnect) is covered by other mechanisms

### [MODIFY] `src/extension.ts`
- Context: 4663-line main extension entry point
- Logic: Remove 26 InboxWatcher references, rewrite 2 commands, update 12 workspace resolvers, delete `getPreferredWorkspaceRoot()`
- Implementation: See Phase 1 and Phase 3 line-by-line tables
- Edge Cases: `resolveWorkspaceRootForBrainPath()` (lines 541, 553) also calls `getPreferredWorkspaceRoot()` — must be audited before deleting the function

### [MODIFY] `src/services/TaskViewerProvider.ts`
- Context: 16326-line sidebar provider
- Logic: Remove `_activeWorkspaceRoot` cache (15 references), thin-delegate `_resolveWorkspaceRoot` to kanban with validation guard, add `_getAllowedRoots` helper
- Implementation: See Phase 2 line-by-line tables
- Edge Cases: `_resolveWorkspaceRootForSession` and `_resolveWorkspaceRootForPath` must retain their DB-lookup logic; only the cache writes are removed

### [MODIFY] `src/services/KanbanProvider.ts`
- Context: 5709-line kanban board provider
- Logic: Add `setCurrentWorkspaceRoot()` public setter with validation, add `_getAllowedRoots()` helper, refactor `_resolveWorkspaceRoot` to use helper
- Implementation: See Phase 4 code blocks
- Edge Cases: `_getAllowedRoots` must use `m.workspaceFolders` (not `m.parentWorkspaceFolder`) to match the existing KanbanProvider config schema

### [MODIFY] `src/services/terminalUtils.ts`
- Context: Shared terminal text-sending utility
- Logic: Update comment on line 61 to remove InboxWatcher reference
- Implementation: Single line comment change
- Edge Cases: None

### [MODIFY] `src/lifecycle/cleanWorkspace.ts`
- Context: Workspace cleanup utility
- Logic: No code changes needed — `inbox` and `outbox` are already in `TRANSIENT_DIRS` (line 7)
- Implementation: No changes this release; remove from `TRANSIENT_DIRS` in a follow-up
- Edge Cases: None

---

## Verification Plan

### Automated Tests

**Test: KanbanProvider rejects invalid workspace**
```typescript
it('should reject workspace outside allowed roots', () => {
    const result = kanbanProvider.setCurrentWorkspaceRoot('/nonexistent/workspace');
    expect(result).toBe(false);
    expect(kanbanProvider.getCurrentWorkspaceRoot()).toBeNull();
});
```

**Test: KanbanProvider accepts valid workspace**
```typescript
it('should accept workspace within allowed roots', () => {
    // Assuming '/valid/workspace' is in workspaceFolders
    const result = kanbanProvider.setCurrentWorkspaceRoot('/valid/workspace');
    expect(result).toBe(true);
    expect(kanbanProvider.getCurrentWorkspaceRoot()).toBe('/valid/workspace');
});
```

**Test: TaskViewerProvider delegates to kanban**
```typescript
it('should return kanban workspace without side effects', () => {
    kanbanProvider.setCurrentWorkspaceRoot('/workspaceA');
    const resolved = taskViewerProvider['_resolveWorkspaceRoot']();
    expect(resolved).toBe('/workspaceA');
});
```

**Test: TaskViewerProvider validates kanban root against allowed roots**
```typescript
it('should fall back when kanban root is not in allowed roots', () => {
    // Simulate kanban returning a stale root
    (kanbanProvider as any)._currentWorkspaceRoot = '/removed/workspace';
    const resolved = taskViewerProvider['_resolveWorkspaceRoot']();
    // Should fall back to roots[0], not return the stale root
    expect(resolved).not.toBe('/removed/workspace');
});
```

**Build verification:**
```bash
npm run compile  # or equivalent TypeScript build
# Must succeed with zero errors after all changes
```

### Manual Integration Tests

**Test: Multi-root command consistency**
1. Open VS Code with 3 workspace folders (A, B, C).
2. Select workspace B in kanban.
3. Run `Switchboard: Import from ClickUp`.
4. **Verify:** Import targets workspace B (check `mcpOutputChannel` log for workspace path).
5. Switch to workspace C in kanban.
6. Run `Switchboard: Refresh Integration Cache`.
7. **Verify:** Refresh targets workspace C.

**Test: InboxWatcher absence**
1. Open Agent Grid.
2. Open/close terminals repeatedly.
3. **Verify:** No `[InboxWatcher]` log lines appear in `Switchboard` output channel.
4. **Verify:** Agent Grid still initializes correctly.

**Test: Reload persistence**
1. Select workspace B in kanban.
2. Reload VS Code window.
3. **Verify:** Kanban restores workspace B selection.
4. **Verify:** Sidebar populates with workspace B plans.

**Test: Housekeeping command**
1. Run `Switchboard: Housekeep Now`.
2. **Verify:** Command succeeds (no "InboxWatcher not running" error).
3. **Verify:** Old run sheets are archived.
4. **Verify:** Transient directories are cleaned.

**Test: Refresh Control Plane Runtime**
1. Run `Switchboard: Refresh Control Plane Runtime`.
2. **Verify:** Command succeeds without InboxWatcher-related errors.
3. **Verify:** MCP server restarts correctly.
4. **Verify:** Terminal registry syncs correctly.

### Regression Tests

- Single-workspace setup (should still auto-select on activation).
- Workspace mappings enabled (`resolveEffectiveWorkspaceRoot` still works).
- Plan creation from sidebar (creates in selected workspace).
- Database operations (all use correct workspace DB).
- Brain file mirroring (no cross-workspace contamination).
- `checkAnalystAvailability` command returns correct workspace.
- `onDidChangeConfiguration` handler uses correct workspace for DB invalidation.

---

## Rollback Plan

If critical issues emerge:
1. **Immediate:** Revert the PR. Partial revert is safe because the changes are additive (removing dead code + routing through existing kanban methods).
2. **Data safety:** User data in `kanban.db` and run sheets is untouched.
3. **User impact:** Users may need to re-select workspace in kanban after rollback.
4. **Escape hatch:** If any command handler regressions occur, the old `getPreferredWorkspaceRoot()` code can be restored per-command without reverting the entire change.

---

## Migration Guide (for future developers)

### Before (scattered resolvers):
```typescript
// In any command handler
const workspaceRoot = getPreferredWorkspaceRoot();
const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
```

### After (single source of truth):
```typescript
const workspaceRoot = kanbanProvider.getCurrentWorkspaceRoot();
if (!workspaceRoot) {
    vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
    return;
}
```

For async operations that need the workspace after user interaction:
```typescript
const effectiveRoot = kanbanProvider.resolveEffectiveWorkspaceRoot(workspaceRoot);
```

---

## Success Criteria
1. `InboxWatcher.ts` deleted and all 26 references removed from `extension.ts`.
2. `inbox-watcher.test.js` and `terminal-disconnect-on-minimize-regression.test.js` deleted.
3. `_activeWorkspaceRoot` field removed from `TaskViewerProvider` (all 15 references).
4. `_resolveWorkspaceRoot` in `TaskViewerProvider` is a thin delegation to `KanbanProvider` with allowed-roots validation guard.
5. All `extension.ts` command handlers that previously used `getPreferredWorkspaceRoot()` or `workspaceFolders?.[0]` now read from `kanbanProvider.getCurrentWorkspaceRoot()`.
6. Activation-time `workspaceRoot` capture removed from `activate()`.
7. `refreshControlPlaneRuntime` command rewritten without InboxWatcher.
8. `housekeepNow` command rewritten with inline implementation.
9. `getPreferredWorkspaceRoot()` function deleted (after auditing `resolveWorkspaceRootForBrainPath`).
10. Manual tests confirm commands target the kanban-selected workspace.
11. No `[InboxWatcher]` log lines appear during normal operation.
12. TypeScript build succeeds with zero errors.

---

**Recommendation:** Send to Coder (complexity ≤ 6).
