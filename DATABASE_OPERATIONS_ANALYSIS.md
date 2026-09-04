# Database Operations Sidebar Panel - Comprehensive Analysis

## Overview
This document analyzes the current behavior vs expected behavior for all database operations in the Switchboard sidebar panel.

## UI Location
File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`
Section: Database Operations panel (lines 1691-1764)

---

## Database Operations Panel Structure

The panel is divided into 4 subsections:

### 1. Cloud Database Location (lines 1698-1719)
**UI Elements:**
- Path display showing current DB location
- Status badge (local/cloud synced/custom)
- **Edit Path** button (`db-edit-path-btn`)
- **Test** button (`db-test-connection-btn`)
- **Use Local DB** button (`db-use-local-btn`)
- Cloud preset buttons: *Retired* (Google Drive, Dropbox, iCloud presets removed; cloud sync folder warnings active)

### 2. Archive Storage (lines 1720-1730)
**UI Elements:**
- Path display for archive location
- Status badge (configured/not configured)
- **Set Archive Path** button (`db-edit-archive-btn`)

### 3. CLI Tools (lines 1731-1743)
**UI Elements:**
- DuckDB status indicator
- **Install** button (`duckdb-install-btn`)
- **Open DuckDB Terminal** button (`open-duckdb-btn`)

### 4. Quick Actions (lines 1744-1763)
**UI Elements:**
- **EXPORT** button (`db-export-btn`) - "Export completed plans to archive"
- **STATS** button (`db-stats-btn`) - "View database statistics"
- **RESET** button (`db-reset-btn`) - "WARNING: Permanently delete database"

---

## Operation-by-Operation Analysis

### 1. Edit Path (db-edit-path-btn)

**Frontend Handler** (`implementation.html:3956-3958`):
```javascript
document.getElementById('db-edit-path-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'editDbPath' });
});
```

**Backend Handler** (`TaskViewerProvider.ts` - needs verification):
Expected to handle `editDbPath` message type to open a file picker for database path selection.

**Status:** Needs verification - handler may be incomplete or missing.

---

### 2. Test Connection (db-test-connection-btn)

**Frontend Handler** (`implementation.html:3959-3961`):
```javascript
document.getElementById('db-test-connection-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'testDbConnection' });
});
```

**Backend Handler** (TaskViewerProvider.ts - needs verification):
Expected to test database connectivity and return result via `dbConnectionResult` message.

**Frontend Result Handler** (`implementation.html:2777-2784`):
```javascript
case 'dbConnectionResult': {
    const dbPathEl2 = document.getElementById('current-db-path');
    if (dbPathEl2) {
        dbPathEl2.style.borderLeft = message.success ? '3px solid #28a745' : '3px solid #dc3545';
        if (!message.success) dbPathEl2.title = message.error || 'Connection failed';
        setTimeout(() => { dbPathEl2.style.borderLeft = ''; }, 2000);
    }
    break;
}
```

**Status:** UI feedback mechanism exists but backend handler needs verification.

---

### 3. Use Local DB (db-use-local-btn)

**Frontend Handler** (`implementation.html:3962-3964`):
```javascript
document.getElementById('db-use-local-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'setLocalDb' });
});
```

**Expected Behavior:** Reset database path to default local location (.switchboard/kanban.db)

**Status:** Needs verification - handler may be missing.

---

### 4. Cloud Preset Buttons (RETIRED)

**Status:** Retired. The preset buttons (`db-preset-google-btn`, `db-preset-dropbox-btn`, `db-preset-icloud-btn`) and the `setPresetDbPath` verb have been removed. Cloud sync folders (Google Drive, Dropbox, iCloud, OneDrive) are incompatible with SQLite full-file replacement and cause corruption/conflicts. Users pointed at presets are automatically migrated to the global store on launch with sources preserved as `.migrated.bak`. Custom paths inside sync folders trigger a warning with an explicit override.

---

### 5. Set Archive Path (db-edit-archive-btn)

**Frontend Handler** (`implementation.html:3974-3976`):
```javascript
document.getElementById('db-edit-archive-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'editArchivePath' });
});
```

**Expected Behavior:** Configure path for DuckDB archive database.

**Status:** Needs verification.

---

### 6. Install DuckDB (duckdb-install-btn)

**Frontend Handler** (`implementation.html:3977-3979`):
```javascript
document.getElementById('duckdb-install-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'installCliTool', tool: 'duckdb' });
});
```

**Expected Behavior:** Guide user through DuckDB CLI installation.

**Status:** Needs verification.

---

### 7. Open DuckDB Terminal (open-duckdb-btn)

**Frontend Handler** (`implementation.html:3980-3982`):
```javascript
document.getElementById('open-duckdb-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openCliTerminal', tool: 'duckdb' });
});
```

**Backend Handler** (`TaskViewerProvider.ts:3640-3653`):
```typescript
case 'openCliTerminal': {
    const tool = message.tool as string;
    if (tool === 'duckdb') {
        const duckdbTerminal = vscode.window.createTerminal('DuckDB CLI');
        // ... terminal setup
    }
    break;
}
```

**Status:** Handler exists but needs verification of full implementation.

---

### 8. EXPORT to Archive (db-export-btn) ⚠️ **CRITICAL ISSUE**

**Frontend Handler** (`implementation.html:3983-3985`):
```javascript
document.getElementById('db-export-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'exportToArchive' });
});
```

**Backend Handler** (`TaskViewerProvider.ts:3655-3658`):
```typescript
case 'exportToArchive': {
    vscode.commands.executeCommand('switchboard.exportAllToArchive');
    break;
}
```

**CRITICAL ISSUE:** The command `switchboard.exportAllToArchive` is **NOT REGISTERED** in `extension.ts`.

Search results confirm:
- No `registerCommand('switchboard.exportAllToArchive', ...)` found in extension.ts
- The command is called but doesn't exist

**Expected Behavior:** Export all completed plans from SQLite kanban.db to DuckDB archive.

**Actual Behavior:** Command not found error (likely silent failure).

**Status:** ❌ **BROKEN - Command implementation missing**

---

### 9. STATS (db-stats-btn)

**Frontend Handler** (`implementation.html:3986-3988`):
```javascript
document.getElementById('db-stats-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'viewDbStats' });
});
```

**Backend Handler** (`TaskViewerProvider.ts:3659-3678`):
```typescript
case 'viewDbStats': {
    const statsRoot = this._getWorkspaceRoot();
    if (statsRoot) {
        try {
            const statsDb = KanbanDatabase.forWorkspace(statsRoot);
            await statsDb.ensureReady();
            const allPlans = await statsDb.getAllPlans(statsRoot);
            const stats = {
                totalPlans: allPlans.length,
                active: allPlans.filter((p: any) => p.status === 'active').length,
                completed: allPlans.filter((p: any) => p.status === 'completed').length,
            };
            vscode.window.showInformationMessage(
                `📊 Database Stats: ${stats.totalPlans} plans (${stats.active} active, ${stats.completed} completed)`
            );
        } catch (statsErr: any) {
            vscode.window.showErrorMessage(`Failed to get stats: ${statsErr.message}`);
        }
    }
    break;
}
```

**Status:** ✅ **IMPLEMENTED** - Full implementation exists and should work.

---

### 10. RESET Database (db-reset-btn)

**Frontend Handler** (`implementation.html:3989-3991`):
```javascript
document.getElementById('db-reset-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'resetDatabase' });
});
```

**Backend Handler** (`TaskViewerProvider.ts:3680-3690`):
```typescript
case 'resetDatabase': {
    const resetConfirm = await vscode.window.showWarningMessage(
        'Reset the kanban database? All plan metadata will be permanently deleted.',
        { modal: true },
        'Reset Database'
    );
    if (resetConfirm === 'Reset Database') {
        vscode.commands.executeCommand('switchboard.resetKanbanDb');
    }
    break;
}
```

**Command Registration** (`extension.ts:1002-1033`):
```typescript
const resetKanbanDbDisposable = vscode.commands.registerCommand('switchboard.resetKanbanDb', async () => {
    // Full implementation with confirmation, DB deletion, and rebuild
});
```

**Status:** ✅ **IMPLEMENTED** - Full implementation exists.

---

## Summary of Issues Found

### Critical Issues (Broken)
1. **EXPORT button** - Calls `switchboard.exportAllToArchive` but command is not registered

### Needs Verification
2. **Edit Path** - Handler existence unverified
3. **Test Connection** - Handler existence needs verification
4. **Use Local DB** - Handler existence unverified
5. **Cloud Presets** - Handler existence unverified
6. **Set Archive Path** - Handler existence unverified
7. **Install DuckDB** - Handler existence unverified
8. **Open DuckDB Terminal** - Handler exists but needs end-to-end testing

### Working
9. **STATS** - Fully implemented
10. **RESET** - Fully implemented

---

## Recommended Fixes

### Immediate (Critical)
1. **Implement exportAllToArchive command** in extension.ts:
   - Register the command
   - Query completed plans from KanbanDatabase
   - Use ArchiveManager to export to DuckDB
   - Show progress and completion feedback

### Short-term (High Priority)
2. Verify and implement missing handlers:
   - editDbPath
   - testDbConnection
   - setLocalDb
   - setPresetDbPath
   - editArchivePath
   - installCliTool

### Medium-term
3. Add visual feedback for long-running operations (export, reset)
4. Implement error handling for all database operations
5. Add confirmation dialogs for destructive operations

---

## Files to Modify

1. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts`
   - Add: `switchboard.exportAllToArchive` command registration
   - Add: Missing message handlers for database operations

2. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`
   - Verify: All message handlers exist and are functional
   - Add: Any missing message handlers

3. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/ArchiveManager.ts`
   - Verify: Export functionality is complete
   - May need: Batch export method for all completed plans

---

## Testing Checklist

- [ ] EXPORT button exports completed plans to DuckDB archive
- [ ] STATS button displays accurate database statistics
- [ ] RESET button properly clears and rebuilds database
- [ ] Edit Path button opens file picker and updates path
- [ ] Test button validates database connectivity
- [ ] Use Local DB resets to default location
- [x] Cloud preset buttons retired; preset paths migrate to global store on launch
- [x] Custom sync-folder DB paths warn with explicit override
- [ ] Set Archive Path configures DuckDB archive location
- [ ] Install DuckDB button guides installation
- [ ] Open DuckDB Terminal launches CLI
