# Fix Dropdown Workspace Plan Filtering and Identity Files

## Goal

Fix three interrelated bugs in the dropdown workspace feature: ghost plan filtering uses the wrong root path (Bug 1), dead `workspace-id` files are written to dropdown folders (Bug 2), and dropdown labels lacked a parent-mapping prefix (Bug 3 — **already fixed in codebase**).

## Metadata

- **Tags:** bugfix, reliability
- **Complexity:** 4

## User Review Required

> [!IMPORTANT]
> **Bug 3 (dropdown label prefix) is already implemented** at `KanbanProvider.ts:745`. The plan describes it as pending work, but the code already contains the correct `${m.name ? m.name + ' › ' : ''}${path.basename(resolvedDw)}` label. No code change is needed for Bug 3 — only verification.

> [!WARNING]
> **Bug 2 has a broader scope than originally described.** The original plan gates only the PRIORITY 5 `tryWriteCommittedWorkspaceIdIfDifferent` call. But PRIORITY 2 (line 242) also calls this function unconditionally for dropdowns that already have a valid `workspace-id` file on disk. Both call-sites must be guarded with `!isDropdown`.

## Complexity Audit

### Routine
- Bug 1 fix: add 3 lines before the existing filter block (`isDropdown` check + `effectiveRootForPaths` variable)
- Bug 2 fix: wrap two `tryWriteCommittedWorkspaceIdIfDifferent` call-sites in `!isDropdown` guard (PRIORITY 2 and PRIORITY 5)
- Bug 3: already done — verify only
- Cleanup function: small async helper in `extension.ts`

### Complex / Risky
- Adding an import of `isDropdownWorkspace` and `resolveEffectiveWorkspaceRootFromMappings` into `KanbanProvider.ts` — currently zero imports from `WorkspaceIdentityService` in that file; must not create circular dependencies
- The PRIORITY 2 path in `ensureWorkspaceIdentity`: dropdowns with an existing valid `workspace-id` file currently have that file silently refreshed on every activation; after the fix those files will persist (harmless but stale) until the optional cleanup runs

## Edge-Case & Dependency Audit

### Race Conditions
- `cleanupDropdownIdentityFiles()` runs at extension activation. If a dropdown workspace is added to the config between the cleanup scan and the next `ensureWorkspaceIdentity` call, no file will be written (correct). Concurrent activations are unlikely in VS Code's single-threaded extension host.
- The `_refreshBoardImpl` fix is synchronous path resolution — no async gap.

### Security
- None: file deletion is scoped to `<dropdownRoot>/.switchboard/workspace-id`, a known Switchboard-managed path.

### Side Effects
- Dropping the PRIORITY 2 write means a dropdown folder that previously had a valid `workspace-id` will no longer have it refreshed. The kanban never reads it (confirmed), so this is purely cosmetic dead data. No functional regression.
- `resolveEffectiveWorkspaceRootFromMappings` uses a module-level cache (`_mappingCache`). This is already used in `ensureWorkspaceIdentity`. Calling it from `KanbanProvider._refreshBoardImpl` introduces a second call-site to this cache. Cache invalidation is triggered by `clearMappingCache()` on config change — already wired up. No new risk.

### Dependencies & Conflicts
- `KanbanProvider.ts` currently imports nothing from `WorkspaceIdentityService.ts`. The new import must be verified to be non-circular. `WorkspaceIdentityService` imports from `KanbanDatabase` — `KanbanProvider` also imports from `KanbanDatabase`. Triangular, not circular. Safe.

## Dependencies

- None (self-contained bugfix, no plan dependencies)

## Adversarial Synthesis

Key risks: (1) Bug 3 is already fixed — implementing it again would silently no-op but wastes a coder's time and review bandwidth; (2) the import of `resolveEffectiveWorkspaceRootFromMappings` into KanbanProvider is a new cross-service dependency that must be checked for circularity; (3) the PRIORITY 2 write path in `ensureWorkspaceIdentity` is a real second bug site missed in the original plan. Mitigations: mark Bug 3 as verified-done, confirm non-circular import via grep before coding, and expand the Bug 2 fix to guard both PRIORITY 2 and PRIORITY 5 write call-sites with `!isDropdown`.

## Proposed Changes

### `src/services/KanbanProvider.ts`

#### Bug 1: Ghost Plan Filter Fix (lines 1696–1702)

**Context:** `_refreshBoardImpl()` resolves relative plan paths against `resolvedWorkspaceRoot`. For dropdown workspaces this is wrong — it should resolve against the parent (effective) root.

**Current import block (lines 7–34):** No import from `WorkspaceIdentityService`. Must add:
```typescript
import { isDropdownWorkspace, resolveEffectiveWorkspaceRootFromMappings } from './WorkspaceIdentityService';
```
Add after line 34 (after the `RelayPromptService` import).

> [!IMPORTANT]
> The plan's original code used `this.resolveEffectiveWorkspaceRoot(...)` — **this method does not exist on KanbanProvider**. Use the module-level function `resolveEffectiveWorkspaceRootFromMappings(resolvedWorkspaceRoot)` instead.

**Logic change (~line 1696):**
```typescript
// BEFORE
const activeRows = dbRows.filter(row => {
    const planFile = row.planFile || '';
    if (!planFile) return false;
    const planPath = path.isAbsolute(planFile) ? planFile : path.resolve(resolvedWorkspaceRoot, planFile);
    return fs.existsSync(planPath);
});

// AFTER
const isDropdown = isDropdownWorkspace(resolvedWorkspaceRoot);
const effectiveRootForPaths = isDropdown
    ? resolveEffectiveWorkspaceRootFromMappings(resolvedWorkspaceRoot)  // parent root
    : resolvedWorkspaceRoot;

const activeRows = dbRows.filter(row => {
    const planFile = row.planFile || '';
    if (!planFile) return false;
    const planPath = path.isAbsolute(planFile) ? planFile : path.resolve(effectiveRootForPaths, planFile);
    return fs.existsSync(planPath);
});
```

**Edge cases:**
- Absolute plan paths: unchanged (`path.isAbsolute` guard still fires)
- Parent workspace: `isDropdown` is false → `effectiveRootForPaths === resolvedWorkspaceRoot` — no regression
- Dropdown with no parent mapping: `resolveEffectiveWorkspaceRootFromMappings` returns `resolvedWorkspaceRoot` — no regression (same as before)

---

#### Bug 3: Dropdown Label Prefix — **ALREADY FIXED**

Verified at line 745:
```typescript
label: `${m.name ? m.name + ' › ' : ''}${path.basename(resolvedDw)}`,
```
**No code change required.** Acceptance criterion should be verified manually (visual check in workspace picker).

---

### `src/services/WorkspaceIdentityService.ts`

#### Bug 2: Skip File Creation for Dropdowns — Expanded Fix

**Context:** The original plan only targets PRIORITY 5 (the fallback hash generation at line 283). But PRIORITY 2 (line 242) also calls `tryWriteCommittedWorkspaceIdIfDifferent` unconditionally, even for dropdowns.

**PRIORITY 2 fix (lines 233–247):**
```typescript
// BEFORE
    try {
        const fileContent = await fs.promises.readFile(committedPath, 'utf8');
        const lines = fileContent.split('\n');
        const trimmed = (lines[0] ?? '').trim();
        if (isValidWorkspaceId(trimmed)) {
            if (!isDropdown && dbReady) {
                await db.setWorkspaceId(trimmed);
            }
            await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, trimmed);
            return trimmed;
        }
    } catch {
        // File does not exist or is unreadable - continue to fallback
    }

// AFTER
    try {
        const fileContent = await fs.promises.readFile(committedPath, 'utf8');
        const lines = fileContent.split('\n');
        const trimmed = (lines[0] ?? '').trim();
        if (isValidWorkspaceId(trimmed)) {
            if (!isDropdown && dbReady) {
                await db.setWorkspaceId(trimmed);
            }
            // Only refresh the local file for standalone workspaces.
            // Dropdowns share the parent DB; their local ID is never read by the kanban.
            if (!isDropdown) {
                await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, trimmed);
            }
            return trimmed;
        }
    } catch {
        // File does not exist or is unreadable - continue to fallback
    }
```

**PRIORITY 5 fix (lines 278–284):**
```typescript
// BEFORE
    const hashId = crypto.createHash('sha256').update(resolvedRoot).digest('hex').slice(0, 12);
    if (!isDropdown && dbReady) {
        await db.setWorkspaceId(hashId);
    }
    await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, hashId);
    return hashId;

// AFTER
    const hashId = crypto.createHash('sha256').update(resolvedRoot).digest('hex').slice(0, 12);
    if (!isDropdown && dbReady) {
        await db.setWorkspaceId(hashId);
    }
    // Only write local identity file for standalone workspaces.
    // Dropdowns share the parent DB; their local ID is never read by the kanban system.
    if (!isDropdown) {
        await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, hashId);
    }
    return hashId;
```

---

### `src/extension.ts` — Optional Cleanup Helper

Add `cleanupDropdownIdentityFiles()` call during extension activation to remove existing stale files.

> [!WARNING]
> The plan's original snippet used `fs.unlinkSync` — **this is synchronous and blocks the extension host event loop**. Use `fs.promises.unlink` instead.

```typescript
async function cleanupDropdownIdentityFiles(): Promise<void> {
    const { isDropdownWorkspace } = await import('./services/WorkspaceIdentityService');
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const resolved = path.resolve(folder.uri.fsPath);
        if (isDropdownWorkspace(resolved)) {
            const idFile = path.join(resolved, '.switchboard', 'workspace-id');
            if (fs.existsSync(idFile)) {
                try {
                    await fs.promises.unlink(idFile);
                    console.log(`[Switchboard] Removed dead identity file in dropdown workspace: ${idFile}`);
                } catch (err) {
                    console.warn(`[Switchboard] Failed to remove dead identity file: ${idFile}`, err);
                }
            }
        }
    }
}
```

Call early in `activate()` after workspaceFolders are available.

---

## Acceptance Criteria

- [ ] Dropdown workspaces show the same plans as their parent workspace (not a random subset)
- [ ] Dropdown workspaces do NOT create `.switchboard/workspace-id` files on fresh activation
- [ ] Dropdown workspaces with an existing (stale) `workspace-id` file do NOT have it refreshed on activation (PRIORITY 2 path)
- [x] Workspace picker shows prefixed labels for dropdowns (e.g., "Autism360 › analytics-dashboard") — **already implemented**
- [ ] Existing dead `workspace-id` files in dropdown folders are removed on activation (optional cleanup)
- [ ] Parent workspace and child workspace behavior is unchanged
- [x] No new TypeScript compilation errors introduced — **verified** (two pre-existing TS2835 errors in unrelated files; none introduced by this plan)

## Files Changed

| File | Change |
|------|--------|
| `src/services/KanbanProvider.ts` | Add import of `isDropdownWorkspace`, `resolveEffectiveWorkspaceRootFromMappings`; ghost filter uses `effectiveRootForPaths` |
| `src/services/WorkspaceIdentityService.ts` | Guard PRIORITY 2 and PRIORITY 5 `tryWriteCommittedWorkspaceIdIfDifferent` calls with `!isDropdown` |
| `src/extension.ts` | Add static import of `isDropdownWorkspace`; add async `cleanupDropdownIdentityFiles()` and `migrateWorkspaceDatabaseMappings()` helpers called in `activate()` |

## Verification Plan

### Automated Tests
- `tsc --noEmit` — confirm no TypeScript compilation errors after import addition
- Grep for circular import: `WorkspaceIdentityService` must not import from `KanbanProvider`

### Manual Verification
1. **Ghost filter test**: Open dropdown workspace → verify all parent plans are visible (same plan list as parent workspace)
2. **Identity file test (fresh)**: Delete dropdown folder `.switchboard/` → reload extension → confirm no `workspace-id` file is created
3. **Identity file test (stale re-activation)**: Place a fake `workspace-id` file in dropdown folder → reload extension → confirm file is NOT refreshed (PRIORITY 2 path)
4. **Label test**: Open workspace picker → dropdown should show "MappingName › foldername" (**already working, just verify**)
5. **Regression test**: Open parent workspace → verify plans still resolve correctly
6. **Regression test**: Open child workspace (non-dropdown mapped folder) → verify it still redirects to parent DB correctly
7. **Cleanup test**: Place a stale `workspace-id` in dropdown folder → activate extension → confirm file is deleted and log message appears

---

## Reviewer Notes (2026-05-22)

### Issues Found

| Severity | Finding | Status |
|----------|---------|--------|
| MAJOR | `cleanupDropdownIdentityFiles()` used `await import('./services/WorkspaceIdentityService')` (dynamic import) despite a static import already existing at the top of `extension.ts`. The dynamic import caused a **new TS2835 error** (`node16` module resolution requires `.js` extension on dynamic imports). Redundant and incorrect. | **Fixed by reviewer** |
| NIT | `fs.existsSync(idFile)` is synchronous inside an async function — inconsistent with async context. | Deferred (low risk) |

### Code Fix Applied

Removed the `await import(...)` line from `cleanupDropdownIdentityFiles()`. The statically-imported `isDropdownWorkspace` from the top-level import is used directly.

### Validation Results

```
# Before fix
src/extension.ts(1170,50): error TS2835  ← NEW, introduced by this implementation
src/services/ClickUpSyncService.ts(2309,40): error TS2835  ← pre-existing
src/services/KanbanProvider.ts(4483,57): error TS2835  ← pre-existing

# After fix
src/services/ClickUpSyncService.ts(2309,40): error TS2835  ← pre-existing (unchanged)
src/services/KanbanProvider.ts(4483,57): error TS2835  ← pre-existing (unchanged)
```

No new errors introduced by this plan. Circular import check: `WorkspaceIdentityService.ts` does not import `KanbanProvider` (grep confirmed empty).

### Remaining Risks

- `fs.existsSync` in async cleanup (NIT) — low risk, does not affect correctness
- Manual verification items 1–7 in Verification Plan above must be tested in a live VS Code window

**Status: APPROVED — ready to commit**
