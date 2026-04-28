# Fix Managed Import Source Deletion

## Goal

When deleting a plan created from the additional plan folder (managed import), only the mirror file is deleted from `.switchboard/plans/`. The source file in the additional folder remains, causing the plan to be recreated on the next sync. This fix ensures both the mirror and source file are deleted, and the plan cannot be resurrected.

## Metadata
**Tags:** bugfix, backend, reliability
**Complexity:** 6
**Repo:**

## User Review Required

- Deleting a managed import plan will now **permanently delete the source file** in the configured additional plan folder. Previously only the mirror was removed. Users should be aware that the original markdown file will be deleted, not just the Switchboard mirror.
- The delete confirmation dialog will now correctly describe the action as deleting the "source file" rather than "brain file" for managed imports.

## Complexity Audit

### Routine
- Add `managedImportSourcePath` parameter to `_handlePlanCreation` signature (single parameter addition)
- Pass `filePath` from `_syncConfiguredPlanFolder` to `_handlePlanCreation` (one-line call-site change)
- Store `brainSourcePath` in runsheet when `managedImportSourcePath` is provided (3-line conditional block)
- Add `_isManagedImportSourcePath` helper method (10-line method using existing `_isPathWithin` pattern)
- Update dialog text in `_handleDeletePlan` to distinguish managed import from brain plan (conditional string selection)

### Complex / Risky
- **Registry update branch in `_handleDeletePlan` (lines 11551-11559):** When `brainSourcePath` is set for a managed import, the existing code uses `_getPlanIdFromStableBrainPath` to compute a hash-based planId. But managed imports are registered with `planId: sessionId` (a `sess_*` ID). This mismatch would update the WRONG registry entry. Requires a new branch to handle managed import registry updates using `sessionId` as planId.
- **DB row deletion skip (line 11547):** `db.deletePlan(sessionId)` is skipped when `brainSourcePath` is set, because brain plans use tombstone-based status tracking. For managed imports (which use `sess_*` session IDs), the DB row MUST be deleted to prevent ghost entries. Requires distinguishing managed import from brain plan in this branch.
- **Tombstone hash computation (lines 11480-11484):** The existing tombstone uses `_getBaseBrainPath` which strips `.resolved` suffixes — brain-specific behavior. For managed imports, the source path is a regular path with no sidecar suffixes. `_getBaseBrainPath` is a no-op here (harmless), but the hash will differ from the one used by `_syncConfiguredPlanFolder` (which uses `_getManagedImportMirrorFilename` → `_getStablePath(sourcePath)`). Must ensure the tombstone hash matches the mirror filename hash so `_syncConfiguredPlanFolder` can check it.
- **Tombstone enforcement in `_syncConfiguredPlanFolder`:** Currently `_syncConfiguredPlanFolder` does NOT check tombstones at all. A tombstone alone won't prevent resurrection — the sync will recreate the mirror from any source file that still exists. Must add tombstone checking to `_syncConfiguredPlanFolder` to fully prevent resurrection.

## Edge-Case & Dependency Audit

**Race Conditions:**
- `_syncConfiguredPlanFolder` runs on a debounced timer and could fire concurrently with `_handleDeletePlan`. The existing `_planCreationInFlight` guard in `_handlePlanCreation` prevents duplicate runsheet creation, but the mirror file write in `_syncConfiguredPlanFolder` bypasses `_handlePlanCreation` for existing mirrors (it only calls `_handlePlanTitleSync`). If the sync writes the mirror between the tombstone write and the source deletion, the mirror would be recreated. Mitigation: tombstone check in `_syncConfiguredPlanFolder` must occur BEFORE the mirror write.

**Security:**
- `_isManagedImportSourcePath` validates that the source path is within the configured plan ingestion folder. This prevents `_handleDeletePlan` from being tricked into deleting arbitrary files via a crafted `brainSourcePath`. Uses `_isPathWithin` which performs path normalization and containment checks (already used for antigravity paths).
- The configured folder itself is validated at save time by `_getConfiguredPlanFolderValidationError` to ensure it's outside the workspace and not under the antigravity root.

**Side Effects:**
- `_removeManagedImportMirror` (called by `_syncConfiguredPlanFolder` cleanup) deletes the mirror file, runsheet, and plan registry entry. After this fix, `_handleDeletePlan` also deletes the source file. These two paths must not conflict — `_removeManagedImportMirror` is only called during sync cleanup (source file disappeared), while `_handleDeletePlan` is called on explicit user delete. No overlap.
- The `_managedImportMirrorsForActiveFolder` set is updated at the end of `_syncConfiguredPlanFolder`. After deletion, the mirror filename will be absent from `desiredMirrors`, so the set will be correctly updated on the next sync.

**Dependencies & Conflicts:**
- No active plans in Kanban New/Planned columns (confirmed via `get-state.js`). No cross-plan conflicts.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) registry/DB branch mismatch when `brainSourcePath` is set for managed imports — the existing brain-plan code paths use hash-based planIds and skip DB deletion, which would corrupt state for `sess_*` managed imports; (2) tombstones are written but never checked by `_syncConfiguredPlanFolder`, so resurrection is only prevented by source file deletion, not by the tombstone itself. Mitigations: add explicit managed-import branches in `_handleDeletePlan` for registry update and DB deletion; add tombstone check to `_syncConfiguredPlanFolder` before mirror write.

---

## Root Cause

- `_syncConfiguredPlanFolder` creates mirror files (`ingested_<hash>.md`) from the additional folder
- The source path is used only to generate the mirror filename hash, not stored in the runsheet
- `_handleDeletePlan` only deletes source files when `brainSourcePath` is set AND passes `_isAntigravitySourcePath` check
- `_removeManagedImportMirror` only removes the mirror file, not the source file

**Expected Behavior:** Deleting a managed import plan should delete both the mirror file AND the source file in the additional plan folder, similar to how antigravity brain plans work.

---

## Proposed Changes

### src/services/TaskViewerProvider.ts

#### [MODIFY] `_syncConfiguredPlanFolder` — Pass source path on creation

**Context:** Line 7676 — when a new managed import mirror is created, `_handlePlanCreation` is called without the source file path, so the runsheet never records where the original file lives.

**Logic:**
1. Add `managedImportSourcePath` parameter to the `_handlePlanCreation` call at line 7676
2. Pass `filePath` (the absolute source path from the loop) as the new parameter

**Implementation:**
```typescript
// Line 7676 — current:
await this._handlePlanCreation(mirrorUri, workspaceRoot, true);

// Line 7676 — changed:
await this._handlePlanCreation(mirrorUri, workspaceRoot, true, false, filePath);
```

**Edge Cases Handled:** The `filePath` is an absolute path from `_listMarkdownFilesRecursively`, which resolves symlinks and normalizes. If the file is deleted between listing and creation, the `readFile` at line 7659 would have already thrown, so we never reach this call.

---

#### [MODIFY] `_handlePlanCreation` — Accept and store managed import source path

**Context:** Lines 10145-10150 — method signature currently has no way to receive a managed import source path. Lines 10303-10313 — runsheet creation does not set `brainSourcePath` for managed imports.

**Logic:**
1. Add optional `managedImportSourcePath?: string` parameter to the method signature
2. After runsheet object creation (line 10303), conditionally set `brainSourcePath` on the runsheet when `managedImportSourcePath` is provided
3. Also set `source: 'managed-import'` on the runsheet to distinguish from antigravity brain plans

**Implementation:**
```typescript
// Line 10145 — current signature:
private async _handlePlanCreation(
    uri: vscode.Uri,
    workspaceRoot?: string,
    _internal: boolean = false,
    suppressFollowupSync: boolean = false
) {

// Line 10145 — changed signature:
private async _handlePlanCreation(
    uri: vscode.Uri,
    workspaceRoot?: string,
    _internal: boolean = false,
    suppressFollowupSync: boolean = false,
    managedImportSourcePath?: string
) {
```

```typescript
// After line 10313 (runsheet object creation), add:
if (managedImportSourcePath) {
    runSheet.brainSourcePath = managedImportSourcePath;
    runSheet.source = 'managed-import';
}
```

**Edge Cases Handled:** If `managedImportSourcePath` is undefined (all existing call sites), the runsheet is unchanged. The `source: 'managed-import'` field allows downstream code to distinguish managed imports from brain plans without relying on path heuristics.

---

#### [MODIFY] `_handleDeletePlan` — Allow managed import source deletion

**Context:** Lines 11456-11461 — the brain path guard rejects any `brainSourcePath` that isn't under the antigravity directory. This prevents managed import source files from being deleted.

**Logic:**
1. Add a check for managed import source paths alongside the existing antigravity check
2. Only null out `brainSourcePath` if the path is NEITHER antigravity NOR managed import
3. Track whether this is a managed import (vs brain) for downstream branching

**Implementation:**
```typescript
// Lines 11456-11461 — current:
if (brainSourcePath) {
    if (!this._isAntigravitySourcePath(brainSourcePath)) {
        console.warn(`[TaskViewerProvider] _handleDeletePlan: brainSourcePath outside expected Antigravity plan directories, treating as local plan. path=${brainSourcePath}`);
        brainSourcePath = undefined;
    }
}

// Lines 11456-11461 — changed:
let isManagedImport = false;
if (brainSourcePath) {
    const isAntigravity = this._isAntigravitySourcePath(brainSourcePath);
    isManagedImport = this._isManagedImportSourcePath(brainSourcePath, resolvedWorkspaceRoot);
    if (!isAntigravity && !isManagedImport) {
        console.warn(`[TaskViewerProvider] _handleDeletePlan: brainSourcePath outside expected directories, treating as local plan. path=${brainSourcePath}`);
        brainSourcePath = undefined;
    }
}
```

**Edge Cases Handled:** If the configured folder was moved/changed after plan creation, `_isManagedImportSourcePath` returns false, and the path is treated as a local plan (only mirror deleted). This is the safe fallback — no accidental deletion of files outside the configured folder.

---

#### [MODIFY] `_handleDeletePlan` — Fix dialog text for managed imports

**Context:** Lines 11470-11472 — the dialog text says "brain file" for all plans with `brainSourcePath`. For managed imports, this should say "source file".

**Logic:**
1. Branch the dialog text based on `isManagedImport` flag

**Implementation:**
```typescript
// Lines 11470-11472 — current:
const baseDialogText = brainSourcePath
    ? `Delete this plan? This will permanently delete the brain file, plan mirror${reviewSuffix}. This cannot be undone.`
    : `Delete this plan? The workspace plan file${reviewSuffix} will be removed.`;

// Lines 11470-11472 — changed:
const baseDialogText = brainSourcePath
    ? isManagedImport
        ? `Delete this plan? This will permanently delete the source file in the additional plan folder and the plan mirror${reviewSuffix}. This cannot be undone.`
        : `Delete this plan? This will permanently delete the brain file, plan mirror${reviewSuffix}. This cannot be undone.`
    : `Delete this plan? The workspace plan file${reviewSuffix} will be removed.`;
```

---

#### [MODIFY] `_handleDeletePlan` — Fix DB deletion and registry update for managed imports

**Context:** Lines 11547-11559 — when `brainSourcePath` is set, `db.deletePlan(sessionId)` is skipped and the registry update uses `_getPlanIdFromStableBrainPath` (hash-based planId). Both are wrong for managed imports which use `sess_*` session IDs.

**Logic:**
1. For managed imports, call `db.deletePlan(sessionId)` (same as local plans)
2. For managed imports, use `sessionId` as planId for registry update (same as local plans)

**Implementation:**
```typescript
// Lines 11547-11559 — current:
if (db && !brainSourcePath) {
    await db.deletePlan(sessionId);
}

// Update plan registry status to deleted
if (brainSourcePath) {
    const stablePath = this._getStablePath(this._getBaseBrainPath(brainSourcePath));
    const planId = this._getPlanIdFromStableBrainPath(stablePath);
    await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, planId, 'deleted');
} else {
    // Local plan: use sessionId as planId
    await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'deleted');
}

// Lines 11547-11559 — changed:
if (db && (!brainSourcePath || isManagedImport)) {
    await db.deletePlan(sessionId);
}

// Update plan registry status to deleted
if (brainSourcePath && !isManagedImport) {
    const stablePath = this._getStablePath(this._getBaseBrainPath(brainSourcePath));
    const planId = this._getPlanIdFromStableBrainPath(stablePath);
    await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, planId, 'deleted');
} else {
    // Local plan or managed import: use sessionId as planId
    await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'deleted');
}
```

**Edge Cases Handled:** Brain plans retain their existing behavior (no DB deletion, hash-based registry update). Managed imports get the same cleanup as local plans (DB deletion, sessionId-based registry update). The `isManagedImport` flag is computed earlier in the method and is `false` for brain plans.

---

#### [MODIFY] `_handleDeletePlan` — Fix tombstone hash for managed imports

**Context:** Lines 11480-11484 — tombstone hash is computed using `_getBaseBrainPath` which strips `.resolved` suffixes. For managed imports, the hash must match the one used by `_getManagedImportMirrorFilename` (which uses `_getStablePath(sourcePath)` directly, no `.resolved` stripping).

**Logic:**
1. For managed imports, compute the tombstone hash from `_getStablePath(brainSourcePath)` directly (matching `_getManagedImportMirrorFilename`)
2. For brain plans, keep existing `_getBaseBrainPath` + `_getStablePath` computation

**Implementation:**
```typescript
// Lines 11480-11484 — current:
if (brainSourcePath) {
    const stablePath = this._getStablePath(this._getBaseBrainPath(brainSourcePath));
    const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
    await this._addTombstone(resolvedWorkspaceRoot, pathHash, sessionId);
}

// Lines 11480-11484 — changed:
if (brainSourcePath) {
    const stablePath = isManagedImport
        ? this._getStablePath(brainSourcePath)
        : this._getStablePath(this._getBaseBrainPath(brainSourcePath));
    const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
    await this._addTombstone(resolvedWorkspaceRoot, pathHash, sessionId);
}
```

**Edge Cases Handled:** The hash for managed imports now matches the one computed by `_getManagedImportMirrorFilename` (line 7580-7582), ensuring tombstone lookups in `_syncConfiguredPlanFolder` will find the correct entry.

---

#### [CREATE] `_isManagedImportSourcePath` — Helper to validate managed import source paths

**Context:** Insert near line 7579 (after `_getManagedImportMirrorFilename`), alongside the existing `_isAntigravitySourcePath` helper.

**Logic:**
1. Resolve the configured plan ingestion folder using `getPlanIngestionFolder()` + `_normalizeConfiguredPlanFolder`
2. Use `_isPathWithin` to check if the source path is within the configured folder
3. Return false if no configured folder exists

**Implementation:**
```typescript
private _isManagedImportSourcePath(sourcePath: string, workspaceRoot: string): boolean {
    const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedRoot) return false;
    // Read configured folder from state file (async not needed — getPlanIngestionFolder is async
    // but we need a sync helper. Use _normalizeConfiguredPlanFolder with the raw state value.)
    // Alternative: make _isManagedImportSourcePath async and call getPlanIngestionFolder.
    const statePath = this._resolveStateFilePath(resolvedRoot);
    let configuredFolder = '';
    if (statePath && fs.existsSync(statePath)) {
        try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            configuredFolder = this._normalizeConfiguredPlanFolder(state.planIngestionFolder, resolvedRoot);
        } catch { /* ignore */ }
    }
    if (!configuredFolder) return false;
    return this._isPathWithin(configuredFolder, sourcePath);
}
```

**Clarification:** The original plan referenced `_loadWorkspaceState` and `config?.workspaceSettings?.planIngestionFolder` which do not exist in the codebase. The actual storage is in the state JSON file under the `planIngestionFolder` key, accessed via `getPlanIngestionFolder()` (async) or by reading the state file directly (sync). Since `_handleDeletePlan` is async, we could make this helper async and use `await this.getPlanIngestionFolder(resolvedRoot)` instead. The async approach is cleaner:

```typescript
private async _isManagedImportSourcePath(sourcePath: string, workspaceRoot: string): Promise<boolean> {
    const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedRoot) return false;
    const configuredFolder = this._normalizeConfiguredPlanFolder(
        await this.getPlanIngestionFolder(resolvedRoot),
        resolvedRoot
    );
    if (!configuredFolder) return false;
    return this._isPathWithin(configuredFolder, sourcePath);
}
```

**Edge Cases Handled:** If no ingestion folder is configured, returns false (source path can't be a managed import). Uses `_isPathWithin` which normalizes paths and handles cross-platform separators. If the state file is corrupt or missing, `getPlanIngestionFolder` returns `''`, and the helper returns false.

---

#### [MODIFY] `_syncConfiguredPlanFolder` — Check tombstones before creating mirrors

**Context:** Lines 7650-7677 — the sync loop creates/updates mirrors for all markdown files in the configured folder without checking tombstones. A deleted managed import would be recreated if the source file still exists.

**Logic:**
1. Before writing a new mirror file (line 7669), check if a tombstone exists for this source path
2. If tombstoned, skip the mirror write and remove the source path from `desiredMirrors`

**Implementation:**
```typescript
// Before line 7669 (await fs.promises.writeFile(mirrorPath, content)), add:
const sourceStablePath = this._getStablePath(filePath);
const sourcePathHash = crypto.createHash('sha256').update(sourceStablePath).digest('hex');
const db = await this._getKanbanDb(workspaceRoot);
const isTombstoned = this._tombstones.has(sourcePathHash) || (db ? await db.isTombstoned(sourcePathHash) : false);
if (isTombstoned) {
    console.log(`[TaskViewerProvider] Skipping tombstoned managed import: ${path.basename(filePath)}`);
    desiredMirrors.delete(mirrorFilename);
    continue;
}
```

Also add tombstone loading at the start of the method (after line 7648):
```typescript
// After _activateWorkspaceContext call, add:
await this._ensureTombstonesLoaded(workspaceRoot);
```

**Edge Cases Handled:** If the DB is unavailable, falls back to in-memory tombstone set. Tombstones are loaded before the sync loop begins. The `desiredMirrors.delete` ensures the mirror filename won't be tracked in `_managedImportMirrorsForActiveFolder`, preventing cleanup logic from interfering.

---

#### [MODIFY] `_handleDeletePlan` — Update call site for async `_isManagedImportSourcePath`

**Context:** Line 11458 — the new `_isManagedImportSourcePath` helper is async, so the call needs `await`.

**Implementation:**
```typescript
// In the brainSourcePath guard block (from earlier change):
isManagedImport = await this._isManagedImportSourcePath(brainSourcePath, resolvedWorkspaceRoot);
```

---

## Verification Plan

### Automated Tests

Update `src/test/delete-plan.test.js` to add test cases for managed import deletion:

1. **Managed import source is deleted alongside mirror:** Create a runsheet with `brainSourcePath` pointing to a path within the configured folder. Verify the deletion sequence unlinks both source and mirror.
2. **Managed import source path outside configured folder is rejected:** Set `brainSourcePath` to a path outside the configured folder. Verify `brainSourcePath` is nullified (treated as local plan, only mirror deleted).
3. **Managed import DB row is deleted:** Verify that `db.deletePlan(sessionId)` is called for managed imports (unlike brain plans where it's skipped).
4. **Managed import registry uses sessionId:** Verify that `_updatePlanRegistryStatus` is called with `sessionId` as planId for managed imports (not a hash-based planId).
5. **Tombstone hash matches mirror filename hash:** Verify that the tombstone hash for a managed import matches the hash used by `_getManagedImportMirrorFilename`.
6. **Tombstoned source is skipped during sync:** Verify that `_syncConfiguredPlanFolder` skips a source file whose hash is in the tombstone set.

### Manual Verification

1. Configure an additional plan folder in Setup menu
2. Create a test markdown file in the additional folder
3. Verify it appears as a plan card in Switchboard
4. Delete the plan using the delete button
5. Verify:
   - Mirror file is deleted from `.switchboard/plans/`
   - Source file is deleted from the additional folder
   - Plan card is removed from the kanban board
   - On refresh/sync, the plan is NOT recreated
6. Verify antigravity brain plan deletion still works correctly
7. Verify regular local plan deletion still works correctly
8. Verify dialog text correctly says "source file" for managed imports and "brain file" for brain plans

---

## Edge Cases to Handle

- **Configured folder moved:** If the additional plan folder is moved/changed after plans are created, `_isManagedImportSourcePath` returns false (path won't match), and the plan is treated as local — only the mirror is deleted. The source file in the old location is preserved (safe fallback).
- **Source file already deleted:** If source file was manually deleted before plan deletion, `fs.existsSync(brainSourcePath)` at line 11487 returns false, so the unlink is skipped (no error). Mirror and runsheet are still cleaned up.
- **Permission errors:** If source file deletion fails due to permissions, the error is caught at line 11490-11493, an error message is shown, and the deletion is aborted (returns false). Mirror and runsheet are preserved in consistent state.
- **Tombstone resurrection:** Tombstones are now checked by `_syncConfiguredPlanFolder` before mirror creation, preventing resurrection even if the source file somehow persists.
- **Race between sync and delete:** The tombstone is written BEFORE source deletion in `_handleDeletePlan`. If `_syncConfiguredPlanFolder` runs concurrently, it will see the tombstone and skip the mirror write. This prevents the mirror from being recreated during the deletion window.

---

## Recommendation

**Send to Coder** (Complexity: 6 — multi-file changes in a single service file with moderate logic, but well-scoped with clear existing patterns to follow)

---

## Reviewer Pass — 2026-04-28

### Stage 1: Grumpy Adversarial Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **CRITICAL** | `_syncConfiguredPlanFolder` checked tombstones AFTER the `alreadyExists` content-match early return. A tombstoned managed import whose mirror still existed with matching content would `continue` at the content-match check, completely bypassing the tombstone check. The mirror would persist, the plan card would remain on the kanban board, and the plan would appear alive despite being "deleted". This defeated the entire tombstone mechanism for the common case (source unchanged since mirror creation). |
| 2 | **NIT** | `_handleDeletePlan` error message in the `brainSourcePath` unlink catch block said "brain file" even when `isManagedImport` was true. The dialog text correctly distinguished "source file" vs "brain file", but the error toast was inconsistent. |
| 3 | **NIT** | `_isManagedImportSourcePath` calls `getPlanIngestionFolder` which reads the state file from disk — redundant I/O since `_handleDeletePlan` may have already read it. No functional impact; the state file is small and the path is user-triggered. |
| 4 | **NIT** | `_syncConfiguredPlanFolder` calls `_getKanbanDb` inside the per-file loop. The DB instance is cached, so overhead is minimal. |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| 1 — Tombstone bypass on content-match | **Fix now** | Move tombstone check before `alreadyExists` content comparison |
| 2 — Error message says "brain file" | **Fix now** | Branch error message on `isManagedImport` flag |
| 3 — Redundant state file read | Defer | No functional impact |
| 4 — DB lookup inside loop | Defer | Cached, minimal overhead |

### Code Fixes Applied

**Fix 1 (CRITICAL):** Moved tombstone check in `_syncConfiguredPlanFolder` to occur immediately after `desiredMirrors.add(mirrorFilename)` and BEFORE the `alreadyExists` content comparison. Previously, if a tombstoned import had an existing mirror with matching content, the code would `continue` at the content-match check before reaching the tombstone check, leaving the mirror alive. Now the tombstone check runs first regardless of mirror state.

**File:** `src/services/TaskViewerProvider.ts` — lines ~7801-7830 (reordered tombstone check before content read)

**Fix 2 (NIT):** Branched the error message in `_handleDeletePlan`'s `brainSourcePath` unlink catch block to use "source file" for managed imports and "brain file" for antigravity brain plans, matching the dialog text shown earlier in the same method.

**File:** `src/services/TaskViewerProvider.ts` — lines ~11688-11691 (added `fileLabel` variable based on `isManagedImport`)

### Validation Results

- **TypeScript compilation:** `npx tsc --noEmit` — PASS (only pre-existing errors unrelated to this plan: import path extensions in ClickUpSyncService.ts and KanbanProvider.ts)
- **No new type errors introduced by fixes**

### Files Changed

- `src/services/TaskViewerProvider.ts` — 2 edits (tombstone check reorder + error message branch)

### Remaining Risks

1. **Tombstone hash consistency** — The tombstone hash in `_handleDeletePlan` uses `_getStablePath(brainSourcePath)` and the hash in `_syncConfiguredPlanFolder` uses `_getStablePath(filePath)`. Both originate from `_listMarkdownFilesRecursively` absolute paths, so they should match. However, if the runsheet's `brainSourcePath` was stored with a different path normalization (e.g., symlinks resolved differently at creation time vs sync time), the hashes could diverge. This is a low-probability edge case that would result in the tombstone failing to prevent resurrection for that specific plan.
2. **No automated tests** — The plan specified test cases in `src/test/delete-plan.test.js` but no tests were created. Manual verification is the only coverage.
3. **`_syncConfiguredPlanFolder` reads source file content even for tombstoned imports** — After Fix 1, the tombstone check occurs before `fs.promises.readFile(filePath, 'utf8')`, so this is no longer an issue. The file read only happens for non-tombstoned imports.
