# Fix Plan Watcher: Orphan Registration Gap and Duplicate Row Creation

## Goal

Fix three related bugs in the plan file watcher / reconciler pipeline: (1) plan files dropped directly into `.switchboard/plans/` by external agents are silently skipped by `_reconcileOnDiskLocalPlanFiles` because the method only acts on rows with `status='deleted'`, never on truly absent rows; (2) both the VS Code `createFileSystemWatcher` and the native `fs.watch` fallback fire for the same creation event, and the `_planCreationInFlight` mutex clears before the 250ms-debounced native event fires, producing a second DB row; (3) the resulting duplicate kanban card persists indefinitely because `cleanupDuplicateLocalPlans` runs only at the top of `_collectAndSyncKanbanSnapshot`, before both rows have committed.

## Metadata
**Tags:** backend, reliability, bugfix, workflow
**Complexity:** 6
**Repo:**

## User Review Required
> [!NOTE]
> All three bugs have been confirmed in production:
> - Bug 1: a plan dropped by an AI agent was visible on disk for 12+ minutes with zero DB registration across multiple reconciler cycles.
> - Bug 2: `touch`-ing a plan file produced two DB rows with session IDs only ~2ms apart (`sess_<T>` and `sess_<T+2>`).
> - Bug 3: the duplicate kanban card only disappeared after a full IDE window reload — not automatically.
>
> This plan touches `_reconcileOnDiskLocalPlanFiles`, `schedulePlanSync` (the native watcher closure), and `_handlePlanCreation` — all in `src/services/TaskViewerProvider.ts`. The companion plan `sess_1777182256190` (Fix Slow Plan Registration) also modifies the tail of `_handlePlanCreation`; the two must be merged or landed in order (this plan first).

## Complexity Audit

### Routine
- Extend `_reconcileOnDiskLocalPlanFiles` to call `_handlePlanCreation` for files with no DB row at all (passing `suppressFollowupSync: true` to prevent thundering-herd full syncs)
- Add a `_recentNativePlanCreations: Map<string, NodeJS.Timeout>` field and a 4-second TTL guard inside the `schedulePlanSync` debounce callback, before `_handlePlanCreation` is awaited
- Add a `_postRegistrationCleanupTimer: NodeJS.Timeout | undefined` field and a 1.5s debounced deferred call to `cleanupDuplicateLocalPlans + _refreshRunSheets` at the tail of `_handlePlanCreation`
- Clear both new timers in `dispose()` alongside the existing `_planFsDebounceTimers` cleanup (line 14786)

### Complex / Risky
- **Orphan guard ordering:** The reconciler must check both `_pendingPlanCreations` and `_planCreationInFlight` before calling `_handlePlanCreation`; skipping either check risks a second DB row being created concurrently with an in-progress watcher-initiated creation for the same path
- **Native watcher TTL scope:** The 4-second TTL key must be path-only (not `path+mtime`). A delete-then-recreate within 4 seconds will be incorrectly suppressed by the native watcher path; however the VS Code `createFileSystemWatcher` fires `onDidCreate` on its own independent code path, so the plan will still register — this is the accepted tradeoff
- **Deferred cleanup debounce:** If 10 orphan files are registered in one reconciler loop, the deferred cleanup timer must be reset on each `_handlePlanCreation` completion, ensuring a single cleanup fires ~1.5s after the last registration, not 10 separate cleanup runs
- **Infinite loop guard:** The deferred cleanup calls `_syncFilesAndRefreshRunSheets` (through `_refreshRunSheets`), which calls `_collectAndSyncKanbanSnapshot`, which calls `cleanupDuplicateLocalPlans`. This is the *existing* sync path and is not watcher-triggered, so it does not re-arm the cleanup timer

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - *Orphan + concurrent watcher:* If the VS Code watcher fires for the same orphan file at the same time as the reconciler loop, `_planCreationInFlight` is the deciding mutex — `_handlePlanCreation` adds the path on entry and removes it in `finally`. Whichever caller wins adds the path first; the second caller sees it and returns immediately. Safe.
  - *Reconciler bulk drop:* 10 files dropped simultaneously → 10 `_handlePlanCreation` calls (each with `suppressFollowupSync: true`) run sequentially inside the existing `for` loop. No per-file full sync. The single `_syncFilesAndRefreshRunSheets` at the end of `_collectAndSyncKanbanSnapshot` covers the batch. `_postRegistrationCleanupTimer` resets on each call but fires once after the last.
  - *Native watcher + VS Code watcher double-fire:* VS Code watcher fires first → `_handlePlanCreation` runs and exits. 250ms later the native debounce fires; the new `_recentNativePlanCreations` guard sees the path already present and returns. Zero second DB row.
- **Security:** No change to authentication, path validation, or trust boundaries. The reconciler already scopes to the workspace plans dir via `_listSupportedLocalPlanPaths`.
- **Side Effects:** `_reviveDeletedLocalPlanForPath` already performs two `getPlanByPlanFile` DB lookups (relative + absolute) before returning `null`. The orphan path adds no extra DB reads beyond what `_reviveDeletedLocalPlanForPath` already did — we reuse its result.
- **Dependencies & Conflicts:** `sess_1777182256190` (Fix Slow Plan Registration) replaces the `_syncFilesAndRefreshRunSheets` call at the tail of `_handlePlanCreation` (lines 10205–10209) with a lightweight `_incrementallyRegisterPlan` helper. This plan adds `_postRegistrationCleanupTimer` at the same tail. If both plans are implemented, the cleanup timer block must be placed *inside* `_incrementallyRegisterPlan`'s success path (not in the slow-path catch branch, which already triggers a full sync). **Land this plan first.**

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line. Format: `sess_XXXXXXXXXXXXX — <topic>`. This section is parsed by the Kanban database for ordering and dispatch gating. If this plan has no cross-plan dependencies, write a single line: `None`.

None

## Adversarial Synthesis

### Grumpy Critique

*"Oh, where do I start. Let's go through this disaster one bug at a time.*

*Bug 1 fix: You're calling `_handlePlanCreation` from inside `_reconcileOnDiskLocalPlanFiles`. Great. `_handlePlanCreation` calls `_reviveDeletedLocalPlanForPath` AGAIN as its very first step — which means you're doing the same two `getPlanByPlanFile` DB lookups a second time, milliseconds after the reconciler already did them. That's not 'avoiding thundering herd', that's just being sloppy with DB round-trips on every sync cycle. And your code snippet shows `const existingByRelative = db && workspaceId ? await db.getPlanByPlanFile(...) : null` — but `_reviveDeletedLocalPlanForPath` already does EXACTLY this lookup. You're duplicating work.*

*Bug 2 fix: A 4-second TTL on a Map keyed by path. Wonderful. You clear this in `dispose()` — fine. But you DON'T clear it in `_setupPlanWatcher()`, which is called when the watcher is reset mid-session (line 7224). So if the plan watcher is torn down and rebuilt, old entries in `_recentNativePlanCreations` from the previous watcher instance persist. A file created just before watcher reset will be suppressed from native watcher events for up to 4 seconds in the new watcher instance — even though no VS Code watcher event may fire because the watcher was just rebuilt.*

*Bug 3 fix: `_postRegistrationCleanupTimer` fires `_syncFilesAndRefreshRunSheets` 1.5 seconds after the last `_handlePlanCreation`. But `_handlePlanCreation` can be called with `suppressFollowupSync: true` from the reconciler path you just added. You gate the timer behind `if (!suppressFollowupSync)`. So if ALL watcher-triggered registrations in a session come from the reconciler (i.e. an agent drops 10 files while VS Code is backgrounded and no watcher fires), the timer NEVER arms, and duplicate rows from before this fix are never cleaned up by the deferred path. The fix for Bug 3 is a no-op in the exact scenario where Bug 2 is most likely to have produced duplicates.*

*Finally: where is the `_normalizePendingPlanPath` call in the reconciler guard? Your code snippet uses `this._normalizePendingPlanPath(filePath)` — but `_normalizePendingPlanPath` normalises for the PENDING set (UI-initiated plans). The in-flight set uses `this._normalizePendingPlanPath(uri.fsPath)` at line 10048. These are the same function but you need to verify the normalisation is consistent between reconciler-called (absolute path from readdir) and watcher-called (absolute URI fsPath). If the OS returns a symlink-expanded path from readdir but the URI contains the original path, the Set lookup fails and you bypass the mutex.*"

### Balanced Response

1. **Double DB lookup:** The reconciler can avoid the redundant lookups by extracting the result of `_reviveDeletedLocalPlanForPath`'s internal DB lookup. However, `_reviveDeletedLocalPlanForPath` currently returns only a `KanbanPlanRecord | null` — it doesn't expose whether the null was "deleted entry found" vs "no entry at all". The cleanest fix without refactoring that signature is to call `_reviveDeletedLocalPlanForPath` first; if it returns `null`, then do a targeted `db.getPlanByPlanFile` check for any status (not just `deleted`). This is exactly what the code block shows — the two extra DB calls only execute if `_reviveDeletedLocalPlanForPath` returned `null`, and they are guarded by `db && workspaceId` which are already resolved. Total extra latency per file per sync cycle: ~1–2ms on a warm SQLite page cache. Acceptable.

2. **Watcher reset stale TTL:** Valid catch. The `_recentNativePlanCreations` map must be cleared inside `_setupPlanWatcher()` at the top of the method, alongside the existing `_fsPlansWatchers = []` reset (line 7231). The implementation spec below adds this one-liner.

3. **Deferred timer gated behind `suppressFollowupSync`:** Valid edge case but narrow. The deferred cleanup's primary purpose is to handle the double-fire case (Bug 2), where both the VS Code and native watcher call `_handlePlanCreation` with `suppressFollowupSync = false`. The reconciler path uses `suppressFollowupSync = true` — and crucially, the reconciler runs inside `_collectAndSyncKanbanSnapshot`, which calls `cleanupDuplicateLocalPlans` at its own top. So any duplicates visible at sync time are cleaned by the existing path. The deferred timer is belt-and-suspenders for the post-watcher window only. The gap Grumpy describes (agent drops files while VS Code is backgrounded, watcher never fires, duplicates linger) does not involve the deferred timer at all — it's handled by the reconciler's `cleanupDuplicateLocalPlans` call on the *next* sync cycle.

4. **`_normalizePendingPlanPath` consistency:** `_normalizePendingPlanPath` (line 7692) calls `path.resolve()` + lowercases on case-insensitive platforms. `_listSupportedLocalPlanPaths` uses `fs.promises.readdir` which returns real filesystem paths. Both the reconciler `filePath` and the watcher `uri.fsPath` will be absolute paths after `path.join(plansDir, entry.name)`. On macOS with APFS (case-insensitive), `path.resolve` and `uri.fsPath` produce identical strings for the same file. The implementation spec explicitly uses `this._normalizePendingPlanPath(filePath)` — the same call as `_handlePlanCreation` line 10048.

## Proposed Changes

### Component 1: Field declarations (class body, ~line 268)

#### MODIFY `src/services/TaskViewerProvider.ts`
- **Context:** Two new class fields are required. They must sit alongside the existing `_planFsDebounceTimers` and `_pendingPlanCreations` fields (lines 266–268) so the dispose method can reach them easily.
- **Logic:** `_recentNativePlanCreations` tracks paths that the native `fs.watch` callback has recently fired for, with a self-clearing TTL timer as the value. `_postRegistrationCleanupTimer` holds a debounced handle for the deferred duplicate-cleanup run.
- **Implementation:**

```typescript
// AFTER line 268 (private _planFsDebounceTimers = new Map<string, NodeJS.Timeout>();)
// INSERT:
private _recentNativePlanCreations = new Map<string, NodeJS.Timeout>(); // 4s TTL dedup: prevents native fs.watch double-fire after VS Code watcher has already handled the creation
private _postRegistrationCleanupTimer: NodeJS.Timeout | undefined;      // deferred duplicate-row cleanup after watcher-triggered registrations
```

- **Edge Cases Handled:** Both fields are initialized to safe empty values so no guard is needed before first use.

---

### Component 2: `_setupPlanWatcher` — clear stale TTL on watcher reset + insert native dedup guard

#### MODIFY `src/services/TaskViewerProvider.ts` (lines 7224–7287)

- **Context:** `_setupPlanWatcher` tears down and rebuilds both the VS Code file system watcher and the native `fs.watch` instances whenever the workspace root changes. Without clearing `_recentNativePlanCreations` here, stale TTL entries from the previous watcher instance would suppress legitimate native watcher events in the new instance for up to 4 seconds.
- **Logic:**
  1. At the top of `_setupPlanWatcher`, after the existing `this._fsPlansWatchers = []` reset (line 7231), clear `_recentNativePlanCreations`.
  2. Inside the `schedulePlanSync` closure, after the 250ms `setTimeout` fires and before `_handlePlanCreation` is awaited, check the map. If the path is already present, return immediately (VS Code watcher handled it). Otherwise, insert the path with a 4-second self-deleting timer.

- **Implementation:**

```typescript
// === CHANGE A: clear stale TTL map on watcher reset ===
// In _setupPlanWatcher(), after line 7231 (this._fsPlansWatchers = [];):
this._recentNativePlanCreations.forEach(t => clearTimeout(t));
this._recentNativePlanCreations.clear();

// === CHANGE B: native watcher dedup guard inside schedulePlanSync ===
// Replace lines 7272–7286 (the setTimeout body):

this._planFsDebounceTimers.set(stablePath, setTimeout(async () => {
    this._planFsDebounceTimers.delete(stablePath);
    if (!fs.existsSync(fullPath)) return;

    // DEDUP GUARD: if the VS Code createFileSystemWatcher already fired onDidCreate
    // for this path, _handlePlanCreation will have been called (and _planCreationInFlight
    // will be set or already cleared). Suppress the native watcher's redundant call.
    if (this._recentNativePlanCreations.has(stablePath)) {
        console.log(`[TaskViewerProvider] Native watcher suppressed (VS Code watcher handled): ${fullPath}`);
        return;
    }
    // Mark this path as "native watcher has claimed it" for 4 seconds.
    // TTL must exceed: 250ms debounce + typical _handlePlanCreation async duration (~100–300ms DB write).
    const nativeTtlTimer = setTimeout(
        () => this._recentNativePlanCreations.delete(stablePath),
        4000
    );
    this._recentNativePlanCreations.set(stablePath, nativeTtlTimer);

    const uri = vscode.Uri.file(fullPath);
    try {
        await this._handlePlanCreation(uri, workspaceRoot);
    } catch (e) {
        console.error('[TaskViewerProvider] Native plan create sync failed:', e);
    }
    try {
        debouncedTitleSync(uri);
    } catch (e) {
        console.error('[TaskViewerProvider] Native plan title sync failed:', e);
    }
}, 250));
```

- **Edge Cases Handled:** Watcher reset clears stale entries (Change A). The guard only suppresses the *native* path — the VS Code `onDidCreate` callback fires independently and is unguarded, so it always processes the event first. If the VS Code watcher is excluded by gitignore/workspace settings and *only* the native watcher fires, `_recentNativePlanCreations` will be empty and the native path proceeds normally.

---

### Component 3: `_reconcileOnDiskLocalPlanFiles` — register orphan files

#### MODIFY `src/services/TaskViewerProvider.ts` (lines 8738–8752)

- **Context:** The current loop calls `_reviveDeletedLocalPlanForPath` and silently skips files for which it returns `null`. `null` can mean either (a) a `deleted` row exists but could not be revived, or (b) NO DB row exists at all. Case (b) is the orphan gap: a file dropped by an external agent that the watcher missed.
- **Logic:**
  1. Call `_reviveDeletedLocalPlanForPath` as before; `continue` on success (non-null return with `status === 'active'`).
  2. If it returned `null`, check `_pendingPlanCreations` and `_planCreationInFlight` using the same normalization as `_handlePlanCreation`.
  3. Do a single `db.getPlanByPlanFile` lookup (relative path first, then absolute) to distinguish "no row" from "deleted row revival failure".
  4. If no row exists, call `_handlePlanCreation(uri, workspaceRoot, false, true)` — `suppressFollowupSync: true` prevents a per-file full sync.
- **Implementation:**

```typescript
// Replace the inner try block at lines 8744–8751:

try {
    const relativePlanPath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
    
    // Step 1: attempt revival of soft-deleted rows (existing behaviour)
    const revivedOrActive = await this._reviveDeletedLocalPlanForPath(
        workspaceRoot, relativePlanPath, filePath
    );
    if (revivedOrActive?.status === 'active') {
        continue; // already handled — either revived or was already active
    }

    // Step 2: guard against concurrent watcher-initiated creation for the same path
    const stablePath = this._normalizePendingPlanPath(filePath);
    if (this._pendingPlanCreations.has(stablePath) || this._planCreationInFlight.has(stablePath)) {
        // Watcher has claimed this path — do not race
        continue;
    }

    // Step 3: check whether ANY DB row exists (active, deleted, completed) for this file.
    // _reviveDeletedLocalPlanForPath already resolved the db/workspaceId — we must re-fetch
    // here because that method does not expose whether null = "no row" vs "revival failed".
    const db = await this._getKanbanDb(workspaceRoot);
    const workspaceId = db ? await this._getWorkspaceIdForRoot(workspaceRoot) : '';
    let anyDbRow: KanbanPlanRecord | null = null;
    if (db && workspaceId) {
        anyDbRow = await db.getPlanByPlanFile(relativePlanPath, workspaceId);
        if (!anyDbRow) {
            // Fallback: try absolute path (PlanFileImporter may have stored it this way)
            anyDbRow = await db.getPlanByPlanFile(
                path.resolve(filePath).replace(/\\/g, '/'),
                workspaceId
            );
        }
    }

    if (!anyDbRow) {
        // Step 4: truly orphaned file — no DB row of any status. Register it.
        // suppressFollowupSync=true: the single _syncFilesAndRefreshRunSheets at the end
        // of _collectAndSyncKanbanSnapshot covers the whole batch.
        console.log(`[TaskViewerProvider] Registering orphaned plan file found during reconcile: ${relativePlanPath}`);
        const uri = vscode.Uri.file(filePath);
        await this._handlePlanCreation(uri, workspaceRoot, false /* _internal */, true /* suppressFollowupSync */);
    }
} catch (error) {
    console.error(`[TaskViewerProvider] Failed to reconcile on-disk local plan ${filePath}:`, error);
}
```

- **Edge Cases Handled:** The `_pendingPlanCreations` / `_planCreationInFlight` guard (Step 2) prevents a race between the reconciler and a concurrent watcher-initiated creation. The dual relative+absolute lookup (Step 3) mirrors the same pattern used in `_handlePlanCreation` lines 10093–10100 to handle plans stored by `PlanFileImporter` with absolute paths.

---

### Component 4: `_handlePlanCreation` tail — deferred duplicate cleanup

#### MODIFY `src/services/TaskViewerProvider.ts` (lines 10205–10209)

- **Context:** After `_registerPlan` completes and `_syncFilesAndRefreshRunSheets` fires, there is a window of ~1.8 seconds in which both the VS Code watcher event and the native watcher event may have resolved, each creating a separate DB row. The existing `cleanupDuplicateLocalPlans` call in `_collectAndSyncKanbanSnapshot` only runs at the *start* of the *next* sync — which may not happen automatically. A deferred cleanup fires 1.5s after the last watcher-triggered registration, guaranteed to post-date both events.
- **Logic:** After the existing `_syncFilesAndRefreshRunSheets` + `selectSession` postMessage block, arm or reset a debounced 1.5-second timer. The timer calls `cleanupDuplicateLocalPlans` then `_refreshRunSheets` to push a deduplicated board snapshot to the webview.
- **Implementation:**

```typescript
// Replace lines 10205–10209:

if (!suppressFollowupSync) {
    await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
    // Auto-focus the new plan in the dropdown
    this._view?.webview.postMessage({ type: 'selectSession', sessionId });

    // Deferred safety net: if Bug 2 (double-fire) slipped a duplicate row through
    // the prevention guards, clean it up 1.5s after the last registration event.
    // 1.5s > 250ms native debounce + ~300ms typical DB write → both rows committed by then.
    if (this._postRegistrationCleanupTimer) {
        clearTimeout(this._postRegistrationCleanupTimer);
    }
    this._postRegistrationCleanupTimer = setTimeout(async () => {
        this._postRegistrationCleanupTimer = undefined;
        try {
            const wsRoot = this._resolveWorkspaceRoot();
            if (!wsRoot) return;
            const db = await this._getKanbanDb(wsRoot);
            const wsId = await this._getWorkspaceIdForRoot(wsRoot);
            if (db && wsId) {
                const removed = await db.cleanupDuplicateLocalPlans(wsId);
                if (removed > 0) {
                    console.log(`[TaskViewerProvider] Post-registration cleanup removed ${removed} duplicate plan row(s)`);
                }
            }
            await this._refreshRunSheets(wsRoot);
        } catch (e) {
            console.error('[TaskViewerProvider] Post-registration cleanup failed:', e);
        }
    }, 1500);
}
```

- **Edge Cases Handled:** The `if (!suppressFollowupSync)` guard means reconciler-path calls (which pass `suppressFollowupSync: true`) never arm the timer — they don't need it because the reconciler runs inside `_collectAndSyncKanbanSnapshot`, which calls `cleanupDuplicateLocalPlans` at its own top. The timer is reset on every `_handlePlanCreation` completion, so 10 rapid watcher events produce exactly one cleanup run 1.5s after the last.

---

### Component 5: `dispose()` — clear new timers on teardown

#### MODIFY `src/services/TaskViewerProvider.ts` (lines 14785–14790)

- **Context:** `dispose()` already clears `_planFsDebounceTimers`, `_recentMirrorWrites`, etc. The two new timer fields must be cleared here to prevent callbacks from firing after extension teardown.
- **Implementation:**

```typescript
// After line 14786 (this._planFsDebounceTimers.forEach(t => clearTimeout(t));):
this._recentNativePlanCreations.forEach(t => clearTimeout(t));
this._recentNativePlanCreations.clear();
if (this._postRegistrationCleanupTimer) {
    clearTimeout(this._postRegistrationCleanupTimer);
    this._postRegistrationCleanupTimer = undefined;
}
```

---

## Verification Plan

### Automated Tests
- `npm run compile` — must produce zero TypeScript errors.
- If a `TaskViewerProvider` unit-test suite exists: `npm test`.

### Manual Testing — Bug 1 (Orphan Registration)
1. Close VS Code's file watcher by backgrounding the window (or confirm watcher is active).
2. Drop a `.md` plan file directly into `.switchboard/plans/` from Terminal (`cp somefile.md .switchboard/plans/new_orphan.md`).
3. Wait for the next reconciler cycle (~1–2s). Verify the plan appears in the kanban **without** touching the file or triggering any watcher event.
4. Confirm a single DB row is created (`SELECT * FROM plans WHERE plan_file LIKE '%new_orphan%'`).

### Manual Testing — Bug 2 (Duplicate Row Prevention)
1. `touch .switchboard/plans/some_plan.md` (or create a new plan file).
2. Inspect the DB within 3 seconds: `SELECT session_id, plan_file FROM plans WHERE plan_file LIKE '%some_plan%'`.
3. Verify exactly **one row** is present. (Previously two rows with session IDs ~2ms apart would appear.)

### Manual Testing — Bug 3 (Deferred Cleanup)
1. Temporarily comment out the `_recentNativePlanCreations` guard (Bug 2 fix) to force a duplicate row.
2. Create a plan file and confirm two kanban cards appear.
3. Wait 1.5–2 seconds. Verify the duplicate card disappears **without** an IDE reload.
4. Restore the guard.

### Regression Testing
1. Create a plan via the UI ("New Plan" button) — verify the `_pendingPlanCreations` guard still suppresses the watcher, single DB row, correct topic.
2. Verify `brain_<64hex>.md` files in `.switchboard/plans/` are **not** orphan-registered (excluded by `_listSupportedLocalPlanPaths`).
3. Drop 10 plan files simultaneously (`for i in {1..10}; do cp template.md .switchboard/plans/batch_$i.md; done`) — verify all 10 appear in kanban, deferred cleanup fires once, no duplicates.
4. Trigger a watcher reset (change workspace root config) — verify `_recentNativePlanCreations` is cleared and a subsequent plan creation is registered correctly.
5. Verify the `suppressFollowupSync=true` caller path (reconciler, brain-mirror) is unaffected: no `_postRegistrationCleanupTimer` is armed, no `selectSession` message posted.

## Reviewer Pass — 2026-04-26

### Findings

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | **CRITICAL** | VS Code `onDidCreate` callback never populated `_recentNativePlanCreations`. The native watcher dedup guard (Bug 2 fix) checked a map that was always empty from the VS Code side — the guard was a no-op for its primary scenario. DB-level dedup in `_handlePlanCreation` prevented actual duplicate rows, but the guard was supposed to avoid the redundant call entirely. | **Fixed:** Added 4s TTL entry in `onDidCreate` callback before calling `_handlePlanCreation`, using `this._getStablePath(uri.fsPath)` as the key (consistent with native watcher's key function). |
| 2 | **MAJOR** | Deferred cleanup (`_postRegistrationCleanupTimer`) gated behind `if (!suppressFollowupSync)`. Reconciler calls pass `suppressFollowupSync: true`, so the timer never arms for reconciler-path registrations. | **Deferred:** The scenario (agent drops files while VS Code backgrounded) cannot produce VS Code + native double-fire duplicates because no VS Code event fires. Pre-existing duplicates are cleaned by `cleanupDuplicateLocalPlans` at `_collectAndSyncKanbanSnapshot` top on the next sync cycle. Not a real gap. |
| 3 | **NIT** | `_getStablePath` (native watcher key) vs `_normalizePendingPlanPath` (reconciler key) — different functions but produce identical results for absolute paths from `readdir`. | **No change needed.** Fix #1 uses `_getStablePath` consistently with the native watcher, ensuring cross-lookup works. |

### Files Changed

- `src/services/TaskViewerProvider.ts` — line ~7244: VS Code `onDidCreate` handler now marks `_recentNativePlanCreations` with 4s TTL before calling `_handlePlanCreation`, enabling the native watcher dedup guard to actually suppress redundant calls.

### Validation

- `npx tsc --noEmit` — zero new errors (2 pre-existing errors in `ClickUpSyncService.ts:2008` and `KanbanProvider.ts:3098`, unrelated to this change).
- Dedup flow verified end-to-end: VS Code `onDidCreate` → marks map → native watcher 250ms later → sees entry → suppressed.

### Remaining Risks

- If `_handlePlanCreation` takes >4 seconds (extremely unlikely — typical is 100–300ms), the TTL could expire before the native watcher debounce fires, allowing a redundant call. The DB-level dedup still prevents duplicate rows in this case.
- The deferred cleanup timer (Bug 3 fix) does not arm for reconciler-path registrations. This is acceptable per Finding #2 but could be revisited if reconciler-path duplicates are observed in production.

## Switchboard State
**Kanban Column:** PLAN REVIEWED
**Status:** active
**Last Updated:** 2026-04-26T09:12:00.000Z
**Format Version:** 1

