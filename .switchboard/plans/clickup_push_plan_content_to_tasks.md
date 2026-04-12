# ClickUp: Push Plan File Content to Tasks

## Goal

When agents update plan `.md` files with review findings, extra detail, and structured steps, none of that content is currently pushed to ClickUp. The ClickUp task description is set once at creation from `plan.topic` (the title only) and never updated. `_updateTask()` only syncs the task name and a timestamp.

This plan adds (a) a `_readPlanContent()` helper in `ClickUpSyncService` that reads the `.md` file and returns the full content, (b) updates `_createTask()` and `_updateTask()` to push that content as the ClickUp task description, and (c) adds a `_planContentWatcher` in `KanbanProvider` that fires a debounced ClickUp sync whenever an agent saves a plan file — so content reaches ClickUp immediately, not just on column moves.

## Metadata

**Tags:** backend
**Complexity:** 4

## Current State Analysis

**Verified gap in `_createTask()` (`ClickUpSyncService.ts:419-451`):**
- `description` is built from `plan.topic` stripped of HTML, capped at 10,000 chars.
- The `.md` plan file (`plan.planFile`) is never read.
- Rich structured content — steps, review findings, complexity audit, adversarial notes — is silently discarded.

**Verified gap in `_updateTask()` (`ClickUpSyncService.ts:457-478`):**
- PUT body only contains `name` (title) and `sync_timestamp`.
- `description` field is absent — the ClickUp task description is frozen at its creation value forever.

**Verified gap: no file watcher for plan content changes:**
- `KanbanProvider._setupSessionWatcher()` (line 260) is a teardown-only method despite the name — it disposes `_sessionWatcher`, `_stateWatcher`, `_fsSessionWatcher`, and `_fsStateWatcher`. It does NOT create new watchers. DB is the source of truth for board state.
- There is no watcher watching `.switchboard/plans/**/*.md` to catch agent content edits.
- ClickUp sync only fires on `moveCardForward` / `moveCardBackward` (lines 1865, 1811). An agent that rewrites a plan without moving the card will never push to ClickUp.

**Existing `getPlanByPlanFile()` confirmed (`KanbanDatabase.ts:764`):**
- Method exists, takes `(planFile: string, workspaceId: string)`, returns `KanbanPlanRecord | null`.
- Used in `KanbanProvider._refreshBoardImpl()` already.

**Existing `_readWorkspaceId()` pattern (`KanbanProvider.ts:504`):**
- Calls `db.getWorkspaceId()` then `db.getDominantWorkspaceId()` as fallback.

## Complexity Audit

### Routine
- **R1: `_readPlanContent()` helper in `ClickUpSyncService`** — Reads plan `.md` file. Handles relative vs. absolute path (`path.isAbsolute` check against `_workspaceRoot`). Returns empty string on any error. Caps at 50,000 chars. `fs` and `path` already imported.
- **R2: Update `_createTask()` description** — Replace the stripped `plan.topic` description with `_readPlanContent()` output. Falls back to `plan.topic` if file unreadable.
- **R3: Update `_updateTask()` to include description** — Add `description` field to the PUT body. Only include if `fileContent` is non-empty to avoid nulling out the ClickUp field when the file is missing.
- **R4: Add `_planContentWatcher` field to `KanbanProvider`** — New `private _planContentWatcher?: vscode.FileSystemWatcher` field alongside existing `_sessionWatcher` / `_stateWatcher` (line 88).
- **R5: `dispose()` cleanup** — Add `this._planContentWatcher?.dispose()` alongside existing watcher disposes (line 199).

### Complex / Risky
- **C1: `_setupPlanContentWatcher()` method** — New private method in `KanbanProvider`. Uses `vscode.RelativePattern` scoped to `_currentWorkspaceRoot`. Creates watcher with `ignoreCreateEvents: true` (creation handled by DB upsert path), `ignoreChangeEvents: false`, `ignoreDeleteEvents: true`. `onDidChange` handler: loads ClickUp config, bails if not set up; calls `db.getWorkspaceId()` / `db.getDominantWorkspaceId()`; calls `db.getPlanByPlanFile(uri.fsPath, workspaceId)`; fires `clickUp.debouncedSync()` with the plan record. Entire handler wrapped in try/catch — must never block normal operation. Risk: `_currentWorkspaceRoot` could be null when method is called. Mitigated by guard at top of method.
- **C2: Watcher lifecycle** — Must be called from `open()` after `_setupSessionWatcher()` (line 253) AND from `selectWorkspace` handler after `_setupSessionWatcher()` (line 1702). Note: `_setupSessionWatcher()` is a teardown-only method — it disposes old watchers but does not create new ones. So `_setupPlanContentWatcher()` is the only real watcher setup happening at these call sites. Must dispose old watcher before creating new one (workspace switch). Risk: duplicate watchers if lifecycle hooks are missed. Mitigated by always disposing in `_setupPlanContentWatcher()` before creating.
- **C3: ClickUp rate limits from frequent saves** — Agents auto-save frequently. The 500ms debounce on `debouncedSync` coalesces rapid saves into one sync. However, if a large plan is being written incrementally, each debounce window could fire a full PUT with `description`. Risk: ClickUp rate limit (100 req/min). Mitigated by existing 1-second `_rateLimitDelay` in `syncColumn()` and the 500ms debounce. Acceptable for the usage pattern.

## Edge-Case & Dependency Audit

- **Relative vs. absolute `planFile` paths:** `KanbanDatabase._normalizePath()` stores forward-slash paths. Whether absolute or relative depends on how the plan was registered. `_readPlanContent()` must handle both — `path.isAbsolute(planFile) ? planFile : path.join(this._workspaceRoot, planFile)`.
- **File not found:** Plan file may have been deleted or not yet written. `_readPlanContent()` returns `''` on any error. `_updateTask()` omits description from the PUT if empty. `_createTask()` falls back to `plan.topic`.
- **ClickUp description field limit:** ClickUp accepts up to ~100,000 chars per task description. 50,000 char cap in `_readPlanContent()` leaves comfortable headroom. Plans rarely exceed 30KB.
- **`_currentWorkspaceRoot` null at watcher setup:** Guard at top of `_setupPlanContentWatcher()` — if null, exits silently. Watcher will be set up correctly on next `open()` or `selectWorkspace` which always resolves the root first.
- **ClickUp not configured:** `onDidChange` handler loads config and returns early if `!clickUpConfig?.setupComplete`. Zero API calls when ClickUp is not set up.
- **`getPlanByPlanFile()` receives absolute `uri.fsPath` but DB stores relative:** `_normalizePath()` only replaces backslashes — it does NOT make paths relative. Passing `uri.fsPath` (absolute) may not match a relatively-stored `plan_file`. Mitigation: try both `uri.fsPath` (absolute) and `path.relative(workspaceRoot, uri.fsPath)` (relative) — query whichever returns a result.
- **No conflict with existing plans:** This change is purely additive. `_updateTask` and `_createTask` already exist. `KanbanProvider` already imports `ClickUpSyncService`. No schema changes, no new DB methods needed.

#### Cross-Plan Conflict Analysis

Plans scanned in `.switchboard/plans/`:

- **`clickup_import_pull_tasks.md`** — Import direction is ClickUp→Switchboard (read-only pull). This plan is Switchboard→ClickUp (write push). No conflict. If an imported task is later updated in Switchboard and the push watcher fires, it will push plan content back to ClickUp — which is the desired bidirectional behavior.
- **`clickup_3_sync_on_move.md`** — Sync-on-move fires from `moveCardForward`/`moveCardBackward`. This plan adds a file watcher that also calls `debouncedSync`. Both use the same `_debounceTimers` Map (keyed by `sessionId`), so rapid concurrent triggers coalesce correctly into a single API call. No conflict.
- **`clickup_1_foundation.md`** / **`clickup_2_setup_flow.md`** — Already implemented foundation and setup wizard. This plan builds on those (uses `loadConfig()`, `httpRequest()`, `retry()` from foundation). Additive only.
- **`linear_*` / `notion_*` plans** — Different integration services. No shared files except `KanbanProvider.ts`, where changes are additive to different sections (new field, new method, new lines in `open()`/`selectWorkspace`/`dispose()`). No conflict.

## Adversarial Synthesis

### Grumpy Critique

*Squints at the plan.*

Three things wrong here:

1. **The path matching problem is understated as a "mitigation" footnote.** Look at `KanbanDatabase._normalizePath()` — it only replaces backslashes. On macOS/Linux, `planFile` stored in the DB could be an absolute path like `/Users/user/project/.switchboard/plans/foo.md` OR a relative one like `.switchboard/plans/foo.md`. The file watcher's `uri.fsPath` is always absolute. If the DB stored a relative path, `getPlanByPlanFile(uri.fsPath, workspaceId)` returns null every single time and the watcher silently does nothing. The plan mentions a try-both approach but doesn't specify where in the code — the "mitigation" is hand-waved.

2. **`_updateTask()` is called on every column move, even if the plan file hasn't changed.** You're now making an extra `fs.readFile` call + adding a potentially large `description` field to every `PUT /task/:id` — which fires on every card drag. On boards with dozens of cards, a manual bulk-reorder will fire N file reads + N large PUTs. The plan says rate limits are fine because of debounce, but the debounce is 500ms — ten rapid card moves across 10 different sessions all fire within 500ms = 10 separate debounce timers coalescing to 10 syncs with large description payloads. That's likely to 429 ClickUp.

3. **`_readPlanContent()` is `async` but it's called inside `_createTask()` and `_updateTask()` which are already called inside `retry()` loops.** If the file read is slow (network drive, locked by another process), you're inside a retry loop that will re-read the file 3 times on failure. The file content should be read ONCE before entering the retry, then the retry only wraps the HTTP call.

### Balanced Response

1. **Path matching specificity:** Fair and important. The `onDidChange` handler in `_setupPlanContentWatcher()` should explicitly attempt both forms: first `db.getPlanByPlanFile(uri.fsPath, workspaceId)`, and if null, retry with `path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/')`. This two-attempt pattern is already used in `_refreshBoardImpl()` (lines 306-309 and 583-586) for the same reason. The Proposed Changes section below shows this explicitly.

2. **Oversized PUT on every column move:** Valid concern. The fix: add a simple content hash check in `_updateTask()`. Store a `_descriptionHashes: Map<string, string>` in `ClickUpSyncService` (keyed by `taskId`). Before including `description` in the PUT, hash the file content with a cheap `Buffer.byteLength` check or a short slice comparison. Only include description if the hash changed since last sync. This eliminates redundant large payloads on repeated column moves. Alternatively (simpler): only read and push file content in `_updateTask()` when triggered from the file watcher path, not from column-move triggers. This is achieved by adding a `syncContent?: boolean` flag to `KanbanPlanRecord` or as a separate parameter to `syncPlan()`.

3. **File read inside retry loop:** Correct. `_readPlanContent()` must be called in `syncPlan()` before delegating to `_createTask()` / `_updateTask()`, and the resolved content passed as an argument. Retry only wraps the HTTP portion.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Complete code and step-by-step logic follow.

### 1. `_readPlanContent()` helper
#### [MODIFY] `src/services/ClickUpSyncService.ts`
- **Context:** New private method. Reads plan `.md` file. `fs` and `path` already imported.
- **Location:** Add after the `_updateTask()` method (~line 478).
- **Implementation:**
  ```typescript
  private async _readPlanContent(planFile: string): Promise<string> {
    if (!planFile) { return ''; }
    try {
      const filePath = path.isAbsolute(planFile)
        ? planFile
        : path.join(this._workspaceRoot, planFile);
      const content = await fs.promises.readFile(filePath, 'utf8');
      return content.slice(0, 50000);
    } catch {
      return '';
    }
  }
  ```
- **Edge Cases Handled:** Relative and absolute paths. File not found / read error → empty string.

---

### 2. Hoist file read out of retry loop + thread content through `syncPlan()`
#### [MODIFY] `src/services/ClickUpSyncService.ts` — `syncPlan()` (line 348)
- **Context:** File content must be read once before retry loops. Pass as argument to `_createTask()` and `_updateTask()`.
- **Logic:** Call `_readPlanContent(plan.planFile)` immediately after config load, store as `planContent`. Pass to both task methods.
- **Implementation:**
  ```typescript
  // After config load, before findTaskByPlanId:
  const planContent = await this._readPlanContent(plan.planFile);

  // Then:
  if (existingTaskId) {
    await this._updateTask(existingTaskId, plan, config, planContent);
    ...
  } else {
    const taskId = await this._createTask(listId, plan, config, planContent);
    ...
  }
  ```
- Update `_createTask` signature: `private async _createTask(listId: string, plan: KanbanPlanRecord, config: ClickUpConfig, planContent: string): Promise<string | null>`
- Update `_updateTask` signature: `private async _updateTask(taskId: string, plan: KanbanPlanRecord, config: ClickUpConfig, planContent: string): Promise<void>`

---

### 3. Update `_createTask()` to use file content as description
#### [MODIFY] `src/services/ClickUpSyncService.ts` — `_createTask()` (line 419)
- **Context:** Replace stripped `plan.topic` description with actual plan file content.
- **Logic:** Use `planContent` if non-empty, else fall back to stripped topic.
- **Implementation:** Replace the existing `description` line:
  ```typescript
  // Before (line 425):
  const description = (plan.topic || '').replace(/<[^>]*>/g, '').slice(0, 10000);

  // After:
  const description = planContent || (plan.topic || '').replace(/<[^>]*>/g, '');
  ```
  The body assignment stays the same:
  ```typescript
  description: `${description}\n\n---\n[Switchboard] Session: ${plan.sessionId} | Plan: ${plan.planId}`,
  ```

---

### 4. Update `_updateTask()` to push description
#### [MODIFY] `src/services/ClickUpSyncService.ts` — `_updateTask()` (line 457)
- **Context:** Currently PUT body has no `description`. Add it when content is available.
- **Logic:** Only include `description` in PUT body if `planContent` is non-empty (avoids clearing existing ClickUp description if file is missing at sync time).
- **Implementation:**
  ```typescript
  private async _updateTask(taskId: string, plan: KanbanPlanRecord, config: ClickUpConfig, planContent: string): Promise<void> {
    const body: Record<string, unknown> = {
      name: plan.topic || `Plan ${plan.planId}`,
      custom_fields: config.customFields.syncTimestamp
        ? [{ id: config.customFields.syncTimestamp, value: Date.now() }]
        : []
    };
    if (planContent) {
      body.description = `${planContent}\n\n---\n[Switchboard] Session: ${plan.sessionId} | Plan: ${plan.planId}`;
    }
    await this.retry(() => this.httpRequest('PUT', `/task/${taskId}`, body));

    // Move task to correct list if column changed
    const targetListId = config.columnMappings[plan.kanbanColumn];
    if (targetListId) {
      try {
        await this.retry(() =>
          this.httpRequest('POST', `/list/${targetListId}/task/${taskId}`)
        );
      } catch (err) {
        console.warn(`[ClickUpSync] Failed to move task ${taskId} to list ${targetListId}:`, err);
      }
    }
  }
  ```

---

### 5. Add `_planContentWatcher` field
#### [MODIFY] `src/services/KanbanProvider.ts` — field declarations (~line 88)
- **Context:** New watcher alongside existing `_sessionWatcher` / `_stateWatcher`.
- **Implementation:** Add after line 89:
  ```typescript
  private _planContentWatcher?: vscode.FileSystemWatcher;
  ```

---

### 6. Add `_setupPlanContentWatcher()` method
#### [MODIFY] `src/services/KanbanProvider.ts` — after `_setupSessionWatcher()` (~line 273)
- **Context:** Creates a file watcher for `.switchboard/plans/**/*.md`. Fires debounced ClickUp sync on content change.
- **Logic:**
  1. Dispose any existing `_planContentWatcher`.
  2. Guard on `_currentWorkspaceRoot` being non-null.
  3. Create watcher with `ignoreCreateEvents: true`, `ignoreChangeEvents: false`, `ignoreDeleteEvents: true`.
  4. `onDidChange`: load ClickUp config → bail if not set up → get `workspaceId` → call `getPlanByPlanFile()` with `uri.fsPath` (absolute); if null, retry with `path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/')` → if plan found, call `clickUp.debouncedSync()`.
  5. Entire handler wrapped in try/catch.
- **Implementation:**
  ```typescript
  private _setupPlanContentWatcher(): void {
    this._planContentWatcher?.dispose();
    this._planContentWatcher = undefined;

    const workspaceRoot = this._currentWorkspaceRoot;
    if (!workspaceRoot) { return; }

    const pattern = new vscode.RelativePattern(workspaceRoot, '.switchboard/plans/**/*.md');
    this._planContentWatcher = vscode.workspace.createFileSystemWatcher(pattern, true, false, true);

    this._planContentWatcher.onDidChange(async (uri) => {
      try {
        const clickUp = this._getClickUpService(workspaceRoot);
        const clickUpConfig = await clickUp.loadConfig();
        if (!clickUpConfig?.setupComplete) { return; }

        const db = this._getKanbanDb(workspaceRoot);
        const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
        if (!workspaceId) { return; }

        // Try absolute path first, then relative (DB may store either form)
        let plan = await db.getPlanByPlanFile(uri.fsPath, workspaceId);
        if (!plan) {
          const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
          plan = await db.getPlanByPlanFile(relativePath, workspaceId);
        }
        if (!plan) { return; }

        clickUp.debouncedSync(plan.sessionId, {
          planId: plan.planId,
          sessionId: plan.sessionId,
          topic: plan.topic,
          planFile: plan.planFile,
          kanbanColumn: plan.kanbanColumn,
          status: plan.status,
          complexity: plan.complexity,
          tags: plan.tags,
          dependencies: plan.dependencies,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
          lastAction: plan.lastAction
        });
      } catch { /* ClickUp sync failure must never block operations */ }
    });
  }
  ```

---

### 7. Hook watcher into `open()` and `selectWorkspace`
#### [MODIFY] `src/services/KanbanProvider.ts`

**`open()` (line 253):**
```typescript
this._setupSessionWatcher();
this._setupPlanContentWatcher();   // ← add this line
```

**`selectWorkspace` handler (line 1701-1703):**
```typescript
this._resolveWorkspaceRoot(msg.workspaceRoot);
this._setupSessionWatcher();
this._setupPlanContentWatcher();   // ← add this line
await this._refreshBoard(msg.workspaceRoot);
```

---

### 8. Clean up in `dispose()`
#### [MODIFY] `src/services/KanbanProvider.ts` — `dispose()` (line 196-204)
```typescript
dispose() {
    this._panel?.dispose();
    if (this._refreshDebounceTimer) clearTimeout(this._refreshDebounceTimer);
    this._sessionWatcher?.dispose();
    this._stateWatcher?.dispose();
    this._planContentWatcher?.dispose();   // ← add this line
    try { this._fsSessionWatcher?.close(); } catch { }
    try { this._fsStateWatcher?.close(); } catch { }
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
}
```

## Files to Modify

1. `src/services/ClickUpSyncService.ts` — Add `_readPlanContent()`, update `syncPlan()`, `_createTask()`, `_updateTask()` signatures and bodies
2. `src/services/KanbanProvider.ts` — Add `_planContentWatcher` field, `_setupPlanContentWatcher()` method, hook into `open()` / `selectWorkspace`, clean up in `dispose()`

## Verification Plan

### Build Verification
```bash
npx tsc --noEmit
npm run compile
npm run compile-tests
npm test
```

### Manual Verification Checklist
- [ ] Create a plan card. Open the ClickUp task — description should contain the full `.md` file content, not just the topic line.
- [ ] Add review findings to the plan file (save). Within ~1 second, verify the ClickUp task description updates (allow 500ms debounce + API latency).
- [ ] Move the card to a new column. Verify ClickUp task moves list AND description is current content.
- [ ] Delete the plan file. Move the card — verify the PUT still succeeds (omitting description, preserving existing ClickUp description).
- [ ] With ClickUp not configured: save a plan file → no errors thrown, board continues to function normally.
- [ ] Workspace switch (`selectWorkspace`): verify watcher is recreated for the new workspace root, old watcher disposed.

### Grep Verification
```bash
grep "_readPlanContent" src/services/ClickUpSyncService.ts
grep "planContent" src/services/ClickUpSyncService.ts
grep "_planContentWatcher" src/services/KanbanProvider.ts
grep "_setupPlanContentWatcher" src/services/KanbanProvider.ts
```

## Agent Recommendation

**Send to Coder** — Complexity 4. Two files, additive changes only. No schema changes. The trickiest part is threading `planContent` through `syncPlan()` to avoid re-reading inside retry loops, and the two-attempt path lookup (absolute → relative) in the file watcher handler. No new dependencies.

---

## Review (Adversarial + Balanced)

**Reviewer:** Copilot (Claude Opus 4.6)
**Date:** Review executed inline
**Mode:** Light (findings in chat, fixes applied directly)

### Stage 1 — Grumpy Principal Engineer

| # | Severity | Finding |
|---|----------|---------|
| 1 | NIT | Watcher `onDidChange` handler manually constructs a `KanbanPlanRecord`-shaped object (11 lines) instead of passing the `plan` object directly from `getPlanByPlanFile()` — redundant noise |
| 2 | NIT | Empty catch block in watcher handler (`catch { }`) — `console.warn` would aid debugging without blocking operations |
| 3 | NIT | `_readPlanContent()` 50K-char cap silently truncates with no indicator — a `[...truncated]` suffix would prevent confusion |
| 4 | NIT | `_normalizePath` correctness is platform-coincidental (backslash replace is no-op on macOS/Linux) — works by accident, not design |

### Stage 2 — Balanced Synthesis

**Implemented Well:**
- `_readPlanContent()` handles relative/absolute paths, caps at 50K, returns `''` on error
- File read hoisted BEFORE retry loop in `syncPlan()` — adversarial plan concern correctly addressed
- `_createTask()` falls back to `plan.topic` when file content empty
- `_updateTask()` conditionally includes `description` only when content available
- Watcher uses `RelativePattern` scoped to workspace with correct event flags
- Two-attempt path lookup (absolute → relative) in watcher handler
- ClickUp config guard — zero API calls when not configured
- Workspace ID resolution chain (getWorkspaceId → getDominantWorkspaceId)
- Watcher hooked into both `open()` and `selectWorkspace`
- Proper dispose in `dispose()`

**Fixes Applied:** None — no CRITICAL or MAJOR findings

### Validation Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ Pass (pre-existing ArchiveManager error only) |
| `npm run compile` | ✅ Pass (webpack compiled successfully) |

### Remaining Risks
- Heavy-save agents could trigger many debounced syncs (mitigated by 500ms debounce + rate limit delay)
- DB path format edge cases in two-attempt lookup — low probability

### Verdict: ✅ READY
