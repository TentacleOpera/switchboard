# Worktrees Part 2: Tab UI

## Goal

Replace the broken single-worktree UI with a proper list view backed by a new `worktrees` DB table. Each row shows branch name, creation date, dirty/clean status, and Merge/Abandon actions. Remove the old single-worktree meta keys.

## Dependencies

**Requires Part 1 complete.** Part 1 establishes the correct worktree creation path (`<control-plane>/worktrees/`) and ensures the control plane is always set. This plan's DB migration and UI both assume that invariant holds.

## Problem Analysis

### Bug 4: Broken Status Display
The current status section reads `active_safety_session_branch` (a single meta key) and shows a static text string. It does not list multiple worktrees, does not show git status (dirty/clean), and does not update after creation.

### Bug 5: No List View
There is no per-worktree row UI. Users cannot see all worktrees at a glance, nor take action (merge/abandon) on individual ones.

### DB Migration V30: `worktrees` Table
The current schema stores a single active worktree as loose meta keys (`active_safety_session_branch`, `active_safety_session_path`, etc.). Replace these with a proper `worktrees` table supporting multiple concurrent worktrees.

**Schema**:
```sql
CREATE TABLE IF NOT EXISTS worktrees (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    branch      TEXT NOT NULL UNIQUE,
    path        TEXT NOT NULL,
    epic_id     INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    status      TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'merged' | 'abandoned'
);
```

**Migration**: On V30, copy any existing `active_safety_session_branch` / `active_safety_session_path` values into the new table, then delete the old meta keys. Never blindly drop — import first.

### Git Status (Dirty/Clean)
For each worktree in the list, run `git -C <worktreePath> diff --stat HEAD` (or `git status --porcelain`). If output is non-empty → dirty. This is fast and does not require a full `git log` traversal.

**Important**: Run status checks lazily in the background after the list renders. Don't block the tab load on N git status calls.

## Metadata

**Tags:** backend, frontend, db-migration, bugfix
**Complexity:** 6

## User Review Required

None.

## Complexity Audit

### Routine
- DB migration V30 with import of legacy meta keys
- `db.getWorktrees()` / `db.addWorktree()` / `db.updateWorktreeStatus()` helper methods
- List view HTML/JS in `kanban.html`
- Git status background check

### Complex / Risky
- **Migration on shipped state**: `active_safety_session_branch` and `active_safety_session_path` exist in released versions — must import before deleting.
- **`git -C` path**: Must point to the worktree directory (not the main repo) to read that worktree's status.

## Edge-Case & Dependency Audit

### Migration Safety
- Import existing `active_safety_session_branch` / `active_safety_session_path` values as a single row in `worktrees` with `status='active'`.
- If `active_safety_session_branch` is empty/null, skip the import (no existing worktree to migrate).
- Archive the old keys as `active_safety_session_branch.migrated.bak` in meta, then delete the originals. This preserves them for debugging without polluting normal reads.

### Race Conditions
- Git status checks are fire-and-forget per row. No concurrency issue — each check uses a different `cwd`.

### Security
- `git -C <path>` uses `execFile` with args array — safe.

## Proposed Changes

### Phase 3: DB Migration V30 — `worktrees` Table

**Files: `src/services/KanbanDb.ts`**

**Context**: Current schema uses loose meta keys for single-worktree state. Migration must import before deleting — `active_safety_session_*` keys exist in shipped versions.

**Change — add migration block for V30 in `KanbanDb.ts`**:

```typescript
// V30: Replace single-worktree meta keys with worktrees table
if (currentVersion < 30) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS worktrees (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            branch      TEXT NOT NULL UNIQUE,
            path        TEXT NOT NULL,
            epic_id     INTEGER REFERENCES plans(id) ON DELETE SET NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            status      TEXT NOT NULL DEFAULT 'active'
        );
    `);

    // Import existing single-worktree state before deleting legacy keys
    const legacyBranch = db.prepare(`SELECT value FROM meta WHERE key='active_safety_session_branch'`).get() as { value: string } | undefined;
    const legacyPath   = db.prepare(`SELECT value FROM meta WHERE key='active_safety_session_path'`).get() as { value: string } | undefined;
    if (legacyBranch?.value) {
        db.prepare(`INSERT OR IGNORE INTO worktrees (branch, path, status) VALUES (?, ?, 'active')`)
          .run(legacyBranch.value, legacyPath?.value ?? '');
    }

    // Archive then delete legacy keys
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('active_safety_session_branch.migrated.bak', ?)`)
      .run(legacyBranch?.value ?? '');
    db.prepare(`DELETE FROM meta WHERE key IN ('active_safety_session_branch', 'active_safety_session_path', 'active_safety_session_started_at')`).run();

    db.prepare(`UPDATE meta SET value=30 WHERE key='schema_version'`).run();
}
```

**Add helper methods on `KanbanDb`**:

```typescript
getWorktrees(): WorktreeRow[] {
    return this.db.prepare(`SELECT * FROM worktrees WHERE status='active' ORDER BY created_at DESC`).all() as WorktreeRow[];
}

addWorktree(branch: string, wtPath: string, epicId?: number): number {
    const result = this.db.prepare(
        `INSERT INTO worktrees (branch, path, epic_id) VALUES (?, ?, ?)`
    ).run(branch, wtPath, epicId ?? null);
    return result.lastInsertRowid as number;
}

updateWorktreeStatus(id: number, status: 'merged' | 'abandoned'): void {
    this.db.prepare(`UPDATE worktrees SET status=? WHERE id=?`).run(status, id);
}

getWorktreeByBranch(branch: string): WorktreeRow | undefined {
    return this.db.prepare(`SELECT * FROM worktrees WHERE branch=?`).get(branch) as WorktreeRow | undefined;
}
```

**Add `WorktreeRow` interface**:

```typescript
export interface WorktreeRow {
    id: number;
    branch: string;
    path: string;
    epic_id: number | null;
    created_at: string;
    status: 'active' | 'merged' | 'abandoned';
}
```

**Update `createWorktree` handler** (in KanbanProvider.ts, after Part 1 changes) to call `db.addWorktree(branch, wtPath)` after the git command succeeds, replacing the old `meta.set('active_safety_session_branch', ...)` calls.

**Verification**: Fresh DB → V30 migration runs → `worktrees` table exists. Existing DB with `active_safety_session_branch='feat/my-session'` → migrated to `worktrees` row → old key archived to `.migrated.bak` key → original key deleted.

---

### Phase 4: Git Status Display (Dirty/Clean)

**Files: `src/services/KanbanProvider.ts`, `src/webview/kanban.html`**

**Context**: Worktree list needs a live dirty/clean indicator per row. Must not block tab load.

**Change — add `_getWorktreeStatus` helper in `KanbanProvider.ts`**:

```typescript
private async _getWorktreeStatus(wtPath: string): Promise<'dirty' | 'clean' | 'unknown'> {
    if (!fs.existsSync(wtPath)) return 'unknown';
    try {
        const { stdout } = await execFileAsync('git', ['-C', wtPath, 'status', '--porcelain'], { timeout: 3000 });
        return stdout.trim().length > 0 ? 'dirty' : 'clean';
    } catch {
        return 'unknown';
    }
}
```

**Change — add `worktreeStatuses` message handler**: After the tab sends `getWorktreeStatuses` with a list of `{ id, path }` pairs, run `_getWorktreeStatus` for each and reply with `{ type: 'worktreeStatuses', statuses: [{ id, status }] }`.

**Change — `kanban.html`**: On tab load, render each row with a pending `⋯` status badge. After render, send `getWorktreeStatuses` to the extension. When `worktreeStatuses` arrives, update each row's badge in place:
- `clean` → green dot + "clean"
- `dirty` → amber dot + "dirty"
- `unknown` → grey dot + "—"

**Verification**: Create a worktree, make a file change in it → tab shows "dirty". Worktree with no changes → "clean". Worktree path deleted externally → "unknown".

---

### Phase 5: Worktree List View with Merge / Abandon

**Files: `src/services/KanbanProvider.ts`, `src/webview/kanban.html`**

**Context**: The tab needs a proper list view replacing the broken single-worktree display. Each row: branch name, created date, status badge (from Phase 4), linked epic (if any), Merge button, Abandon button.

**Change — `getWorktreeConfig` handler in `KanbanProvider.ts`**: Replace the existing `_getWorktreeConfigData` helper to read from `db.getWorktrees()` instead of meta keys:

```typescript
const worktrees = db.getWorktrees();
this._panel?.webview.postMessage({
    type: 'worktreeConfig',
    worktrees: worktrees.map(w => ({
        id: w.id,
        branch: w.branch,
        path: w.path,
        epicId: w.epic_id,
        createdAt: w.created_at,
    })),
    controlPlaneMode: cpStatus.mode,
});
```

**Change — `mergeWorktree` handler in `KanbanProvider.ts`**:

```typescript
case 'mergeWorktree': {
    const { worktreeId, branch, wtPath, workspaceRoot: msgRoot } = msg;
    const workspaceRoot = this._resolveWorkspaceRoot(msgRoot);
    if (!workspaceRoot) break;
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !await db.ensureReady()) break;
    try {
        await execFileAsync('git', ['-C', workspaceRoot, 'merge', branch], { timeout: 30000 });
        await execFileAsync('git', ['worktree', 'remove', wtPath], { cwd: workspaceRoot });
        db.updateWorktreeStatus(worktreeId, 'merged');
        vscode.window.showInformationMessage(`Merged and removed worktree: ${branch}`);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Merge failed: ${e.message}`);
    }
    // Refresh list regardless of outcome
    this._sendWorktreeConfig(workspaceRoot);
    break;
}
```

**Change — `abandonWorktree` handler in `KanbanProvider.ts`**: Same as merge but skips the `git merge` step, only runs `git worktree remove --force` then `db.updateWorktreeStatus(id, 'abandoned')`.

**No confirmation dialogs** on Merge or Abandon — see CLAUDE.md. Buttons execute immediately.

**Change — `kanban.html` `createWorktreesPanel`**: Replace static status section with a dynamic list:

```html
<div id="worktree-list" style="margin-top:8px;"></div>
```

Rendered by JS as:

```javascript
function renderWorktreeList(worktrees) {
    const list = document.getElementById('worktree-list');
    if (!worktrees.length) {
        list.innerHTML = '<div style="font-size:11px; color:var(--text-secondary); padding:4px 0;">No active worktrees.</div>';
        return;
    }
    list.innerHTML = worktrees.map(w => `
        <div class="worktree-row" data-id="${w.id}" style="display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid var(--border-subtle);">
            <span class="wt-status-badge" data-wt-id="${w.id}" style="font-size:10px; color:var(--text-secondary);">⋯</span>
            <span style="flex:1; font-size:11px; font-family:monospace;">${w.branch}</span>
            <span style="font-size:10px; color:var(--text-secondary);">${w.createdAt.slice(0, 10)}</span>
            <button class="btn-sm" onclick="mergeWorktree(${w.id},'${w.branch}','${w.path}')">Merge</button>
            <button class="btn-sm btn-danger" onclick="abandonWorktree(${w.id},'${w.branch}','${w.path}')">Abandon</button>
        </div>
    `).join('');
}
```

**Verification**: Create two worktrees → both appear in list. Merge one → row disappears, branch merged into main. Abandon one → row disappears, branch not merged. Status badges update after background check.

---

## Files Changed

- `src/services/KanbanDb.ts` — V30 migration, `worktrees` table, helper methods
- `src/services/KanbanProvider.ts` — Update `createWorktree` handler, add `mergeWorktree`/`abandonWorktree`/`getWorktreeStatuses` handlers, `_getWorktreeStatus` helper
- `src/webview/kanban.html` — Replace static status section with dynamic list, status badge update logic

## Verification Plan

1. **V30 migration**: Fresh DB → `worktrees` table created. DB with legacy `active_safety_session_branch` → row imported, key archived.
2. **Create worktree**: Creates a `worktrees` row with correct branch, path, created_at.
3. **List render**: Open tab → list populated from DB.
4. **Status badges**: After ~1s, badges update from `⋯` to dirty/clean/unknown.
5. **Merge**: Click Merge → `git merge` runs, worktree removed, row disappears.
6. **Abandon**: Click Abandon → worktree removed (force), row disappears, no merge.
7. **No confirmation dialog**: Merge and Abandon execute immediately — no confirm() call.

## Risks

- **`git merge` failures**: Conflicts will cause the merge handler to show an error toast and leave the row in place. Users resolve conflicts manually. This is acceptable — the Merge button is not a "safe" operation, just a convenience trigger.
- **Worktree path deleted externally**: `git worktree remove` will fail if the directory is already gone. Add `--force` flag or catch the error and still call `db.updateWorktreeStatus` so the row is cleaned up from the list.

## Recommendation

**Complexity: 6 → Send to Coder**

The migration is the highest-risk piece — import-before-delete pattern is mandatory because `active_safety_session_branch` shipped in released versions.
