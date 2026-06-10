# Fix LocalFolderService Child Workspace Pollution

## Goal
Stop `LocalFolderService` from creating `.switchboard/` directories in mapped child workspace folders. The multi-repo control plane architecture (`isAllowedSwitchboardLocation`, `resolveEffectiveWorkspaceRoot`) already protects `kanban.db`, `state.json`, and `plans/` — but `LocalFolderService` bypasses this guard entirely, causing `.switchboard/` scaffolding to appear in `be`, `viaapp`, `fe`, and any other child repo.

## Background — What LocalFolderService Actually Does
`LocalFolderService` is just a path registry for the Planning Panel. It stores paths to external docs, HTML files, and design files that the Planning Panel can pull into context. Think of it as "these are the folders outside the repo that I want Switchboard to be aware of." The actual files live wherever the user points them — they are not stored inside any repo.

This is inherently a **workspace-level** feature, not a **repo-level** feature. In a multi-repo setup the user has already declared: "all these child repos belong to one workspace, manage everything centrally." So local folder config should live in that central workspace root only — not be replicated per child repo.

The control plane was designed exactly for this: child workspaces map to a shared parent workspace. All Switchboard runtime state lives in the parent workspace root only. `KanbanProvider.resolveEffectiveWorkspaceRoot()` and `isAllowedSwitchboardLocation()` enforce this for the core runtime (`kanban.db`, `state.json`, `plans/`).

However, `PlanningPanelProvider._setupLocalFolderWatchers()` iterates **all VS Code workspace roots** and instantiates `new LocalFolderService(root)` for each one. `LocalFolderService.getFolderPaths()` triggers a one-time migration that calls `saveFolderPathsConfig()`, which unconditionally does:

```typescript
await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
```

`this._configPath` is hardcoded to `{workspaceRoot}/.switchboard/local-folder-config.json`. No location validation. No awareness of effective roots. It writes wherever it is told.

## Root Cause
1. `LocalFolderService` constructor receives a raw `workspaceRoot` and writes `{root}/.switchboard/` without checking if that root is an allowed Switchboard location.
2. `PlanningPanelProvider` creates a `LocalFolderService` per-workspace-root rather than per-effective-root.
3. There is no single gate that every `.switchboard/` writer must pass through.

## Fix Approach: Option A + B (chosen)

### A — Route LocalFolderService writes through the effective root
`LocalFolderService` should resolve the effective workspace root (via `resolveEffectiveWorkspaceRootFromMappings`, same as `KanbanDatabase`) and write to `{effectiveRoot}/.switchboard/local-folder-config.json`, not `{rawRoot}/.switchboard/local-folder-config.json`.

This mirrors how `KanbanDatabase._getKanbanDb` already works: it resolves the effective root before creating the DB. Local folder config is a workspace-wide setting — shared across all mapped child repos — so centralizing to the effective root is the correct architecture.

### B — Add `isAllowedSwitchboardLocation` guard in `saveFolderPathsConfig()`
Before `mkdir(..., { recursive: true })`, assert `isAllowedSwitchboardLocation(workspaceRoot, workspaceRoot)`. If blocked, silently skip (or throw). This is a catch-all backup for any future caller that passes a raw child workspace root.

Combined: A fixes the current bug; B prevents regression if someone else instantiates `LocalFolderService` with the wrong root later.

## Files to Modify
- `src/services/LocalFolderService.ts` — resolve effective root; add `isAllowedSwitchboardLocation` guard
- `src/extension.ts` — update `getLocalFolderService` factory to pass effective root or use `resolveEffectiveWorkspaceRoot`
- `src/services/PlanningPanelProvider.ts` — verify `_setupLocalFolderWatchers` doesn't need changes after LocalFolderService fix

## Verification
- [ ] Open a VS Code workspace with mapped child repos (e.g. `Gitlab/` parent with `be`, `fe`, `viaapp` children)
- [ ] Trigger Planning Panel local folder setup (or wait for auto-initialization)
- [ ] Check each child repo: **no `.switchboard/` directory should exist** in `be/`, `fe/`, or `viaapp/`
- [ ] Check parent/control plane workspace: `.switchboard/local-folder-config.json` **should** exist there
- [ ] Regression: verify local folder features still work (add/remove folder paths, list files, fetch docs)

## Risk Assessment
- **Low risk.** The fix aligns `LocalFolderService` with the existing control plane architecture. There is no legitimate use case for per-repo local folder configs — local folders are paths to external docs, and a user can already point to any folder on disk regardless of repo boundaries. Centralizing the config to the effective root is the only behavior that makes sense in a multi-repo workspace.

## Complexity
**Low.** Two small changes in `LocalFolderService` + verification.
