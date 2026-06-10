# Fix LocalFolderService Child Workspace Pollution

## Goal
Stop `LocalFolderService` from creating `.switchboard/` directories in mapped child workspace folders. The multi-repo control plane architecture (`isAllowedSwitchboardLocation`, `resolveEffectiveWorkspaceRoot`) already protects `kanban.db`, `state.json`, and `plans/` — but `LocalFolderService` bypasses this guard entirely, causing `.switchboard/` scaffolding to appear in `be`, `viaapp`, `fe`, and any other child repo.

### Background — What LocalFolderService Actually Does
`LocalFolderService` is just a path registry for the Planning Panel. It stores paths to external docs, HTML files, and design files that the Planning Panel can pull into context. Think of it as "these are the folders outside the repo that I want Switchboard to be aware of." The actual files live wherever the user points them — they are not stored inside any repo.

This is inherently a **workspace-level** feature, not a **repo-level** feature. In a multi-repo setup the user has already declared: "all these child repos belong to one workspace, manage everything centrally." So local folder config should live in that central workspace root only — not be replicated per child repo.

The control plane was designed exactly for this: child workspaces map to a shared parent workspace. All Switchboard runtime state lives in the parent workspace root only. `KanbanProvider.resolveEffectiveWorkspaceRoot()` and `isAllowedSwitchboardLocation()` enforce this for the core runtime (`kanban.db`, `state.json`, `plans/`).

However, `PlanningPanelProvider._setupLocalFolderWatchers()` iterates **all VS Code workspace roots** and instantiates `new LocalFolderService(root)` for each one. `LocalFolderService.getFolderPaths()` triggers a one-time migration that calls `saveFolderPathsConfig()`, which unconditionally does:

```typescript
await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
```

`this._configPath` is hardcoded to `{workspaceRoot}/.switchboard/local-folder-config.json`. No location validation. No awareness of effective roots. It writes wherever it is told.

### Root Cause
1. `LocalFolderService` constructor receives a raw `workspaceRoot` and writes `{root}/.switchboard/` without checking if that root is an allowed Switchboard location.
2. `PlanningPanelProvider` creates a `LocalFolderService` per-workspace-root rather than per-effective-root.
3. There is no single gate that every `.switchboard/` writer must pass through.

### Fix Approach: Option A + B (chosen)

#### A — Route LocalFolderService writes through the effective root
`LocalFolderService` should resolve the effective workspace root (via `resolveEffectiveWorkspaceRootFromMappings`, same as `KanbanDatabase`) and write to `{effectiveRoot}/.switchboard/local-folder-config.json`, not `{rawRoot}/.switchboard/local-folder-config.json`.

This mirrors how `KanbanDatabase._getKanbanDb` already works: it resolves the effective root before creating the DB. Local folder config is a workspace-wide setting — shared across all mapped child repos — so centralizing to the effective root is the correct architecture.

#### B — Add `isAllowedSwitchboardLocation` guard to all write methods
Before every `mkdir(..., { recursive: true })` in `saveConfig`, `saveFolderPathsConfig`, and `saveCachedContent`, assert `isAllowedSwitchboardLocation(path.dirname(this._configPath), this._rawWorkspaceRoot)`. If blocked, throw an explicit error so callers fail fast. This is a catch-all backup for any future caller that passes a raw child workspace root.

Combined: A fixes the current bug; B prevents regression if someone else instantiates `LocalFolderService` with the wrong root later.

## Metadata
- **Tags:** backend, bugfix
- **Complexity:** 4

## User Review Required
- [ ] Confirm that the `isAllowedSwitchboardLocation` guard should **throw** when it blocks a write, rather than silently skip. This plan recommends throwing to fail fast.

## Complexity Audit

### Routine
- Adding a dynamic require for `WorkspaceIdentityService.resolveEffectiveWorkspaceRootFromMappings` inside the `LocalFolderService` constructor (same pattern as `KanbanDatabase._redirectToParentIfMapped`).
- Replacing raw `workspaceRoot` usage with a resolved `_effectiveWorkspaceRoot` for `_configPath` and `_cachePath`.
- Applying the existing `isAllowedSwitchboardLocation` guard to three write methods.

### Complex / Risky
- Multiple `LocalFolderService` instances (one per child root) will share the same effective root config file. Concurrent one-time migrations may race during `read-merge-write` operations, and per-instance `_folderPathsCache` may briefly diverge.
- The `isAllowedSwitchboardLocation` guard depends on the mapping index being built. During very early activation the index may not exist, causing the guard to fall back to the default `candidate === workspaceRoot` check. This is safe only if the root has already been resolved to the effective root.

## Edge-Case & Dependency Audit

### Race Conditions
- `PlanningPanelProvider._setupLocalFolderWatchers` (lines 401-443) creates a new `LocalFolderService` for every workspace root. Each instance performs a one-time migration (`getFolderPaths`, `getHtmlFolderPaths`, `getDesignFolderPaths`) that reads the shared config file, updates migration flags, and writes it back. These are non-atomic `read -> merge -> write` sequences. Rapid concurrent initialization from multiple child roots could drop a migration flag or folder path. **Mitigation:** migration data is sourced from global VS Code settings and is idempotent. The probability of data loss is low for a one-time operation. No file locking is added to keep the fix minimal.

### Security
- `isAllowedSwitchboardLocation` must be applied to **all** write paths (`saveConfig`, `saveFolderPathsConfig`, `saveCachedContent`) to prevent `.switchboard` scaffolding in child repos if the effective root resolution ever fails or is bypassed.

### Side Effects
- `LocalFolderService` instances will all point to the same effective root config. The `_folderPathsCache` is per-instance, so stale caches may exist briefly across different child-root instances. This is acceptable because the cache is only used for in-memory migration flags and is re-read from disk on every new instance.

### Dependencies & Conflicts
- `LocalFolderService` must dynamically require `../services/WorkspaceIdentityService` to avoid circular dependencies. This mirrors the `KanbanDatabase` pattern.
- `LocalFolderService` must also dynamically require `../utils/switchboardLocationGuard` for the guard.
- No conflicts with other features. `PlanningPanelProvider` already deduplicates file system watchers by absolute folder path (`watchedPaths` Set), so multiple instances won't create duplicate OS watchers.

## Dependencies
- `sess_WorkspaceIdentityService` — `resolveEffectiveWorkspaceRootFromMappings` must be available and return the correct parent for mapped children.
- `sess_switchboardLocationGuard` — `isAllowedSwitchboardLocation` must correctly block child workspace folders and allow the parent / effective root.

## Adversarial Synthesis
Key risks: concurrent migration races from multiple child-root instances sharing one config file; and the `isAllowedSwitchboardLocation` guard could be bypassed if the mapping index is not yet built. Mitigations: migration is one-time and idempotent; the guard is applied to the write target directory (`path.dirname(this._configPath)`) rather than the raw root; the guard throws on block to fail fast.

## Proposed Changes

### `src/services/LocalFolderService.ts`
- **Context:** The constructor (line 37) hardcodes `_configPath` and `_cachePath` to `{workspaceRoot}/.switchboard/...` using the raw root passed in. In multi-repo workspaces this root is a mapped child workspace folder, causing `.switchboard/` pollution.
- **Logic:** Dynamically require `../services/WorkspaceIdentityService` and call `resolveEffectiveWorkspaceRootFromMappings(workspaceRoot)` to obtain the effective root. Fall back to the raw root if the module is unavailable (e.g., outside the extension host). Store `_rawWorkspaceRoot` (the original argument) and `_effectiveWorkspaceRoot` (the resolved path). Set `_configPath = path.join(_effectiveWorkspaceRoot, '.switchboard', 'local-folder-config.json')` and `_cachePath = path.join(_effectiveWorkspaceRoot, '.switchboard', 'local-folder-cache.md')`.
- **Implementation:** Add a private `_assertAllowedWrite(targetDir: string)` helper that dynamically requires `../utils/switchboardLocationGuard` and calls `isAllowedSwitchboardLocation(targetDir, this._rawWorkspaceRoot)`. If it returns `false`, throw `Error('Blocked: attempted to write .switchboard data to a child workspace folder')`. Call this helper inside `saveConfig()` (line 55), `saveFolderPathsConfig()` (line 82), and `saveCachedContent()` (line 99) before the `mkdir` call.
- **Edge Cases:** If `resolveEffectiveWorkspaceRootFromMappings` throws or returns `undefined`, fall back to `this._rawWorkspaceRoot`. If `isAllowedSwitchboardLocation` throws, allow the write but log a warning to the console.

### `src/extension.ts`
- **Context:** The `PlannerPromptWriter` config factory `getLocalFolderService: (root) => new LocalFolderService(root)` (line 742) passes the raw root.
- **Logic:** Because `LocalFolderService` now resolves the effective root internally, this factory does **not** need to change. No code modification is required.
- **Verification:** Confirm `extension.ts` does not instantiate `LocalFolderService` anywhere else with a hardcoded child path. Search shows only this factory and `PlanningPanelProvider._getLocalFolderService` create instances.

### `src/services/PlanningPanelProvider.ts`
- **Context:** `_setupLocalFolderWatchers` (lines 401-443), `_setupHtmlFolderWatchers` (lines 445-487), and `_setupDesignFolderWatchers` (lines 489-530) iterate `this._getWorkspaceRoots()` and call `this._getLocalFolderService(root)` for each root.
- **Logic:** After the fix, each instance resolves to the same effective root config, and watchers are deduplicated by the `watchedPaths` Set. `_getLocalFolderService` (line 3324) simply returns `new LocalFolderService(workspaceRoot)`, so it automatically benefits from the internal resolution.
- **Implementation:** No code change required. Verify only.
- **Edge Cases:** `_getLocalFolderService` is not memoized; multiple calls create multiple instances sharing the same config file. This is existing behavior and acceptable.

## Verification Plan

### Manual Verification
- [ ] Open a VS Code workspace with mapped child repos (e.g. `Gitlab/` parent with `be`, `fe`, `viaapp` children)
- [ ] Trigger Planning Panel local folder setup (or wait for auto-initialization)
- [ ] Check each child repo: **no `.switchboard/` directory should exist** in `be/`, `fe/`, or `viaapp/`
- [ ] Check parent/control plane workspace: `.switchboard/local-folder-config.json` **should** exist there
- [ ] Regression: verify local folder features still work (add/remove folder paths, list files, fetch docs)

## Risk Assessment
- **Low risk.** The fix aligns `LocalFolderService` with the existing control plane architecture. There is no legitimate use case for per-repo local folder configs — local folders are paths to external docs, and a user can already point to any folder on disk regardless of repo boundaries. Centralizing the config to the effective root is the only behavior that makes sense in a multi-repo workspace.

## Recommendation
Send to Coder
