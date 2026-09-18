# Fix: Child Workspace `.switchboard/plans/` Scaffold Pollution

## Goal

Prevent Switchboard from scaffolding an empty `.switchboard/plans/` directory inside mapped child workspace folders on every activation, and clean up any pollution that already exists.

### Problem

When a mapped child workspace folder (e.g. `autism360-analytics`) is open in a multi-root VS Code workspace, Switchboard scaffolds an empty `.switchboard/plans/` directory inside it on every activation. This is pollution — the child should never have a `.switchboard` directory because it's mapped to a shared parent DB (the `Autism360App` control plane at `/Users/patrickvuleta/Documents/Gitlab`).

### Background

The workspace mappings config (stored in `kanban.db` `config` table, key `workspace_mappings`) defines:

- **Parent folders** (e.g. `/Users/patrickvuleta/Documents/Gitlab`) — allowed to contain `.switchboard/`
- **Child workspaceFolders** (e.g. `/Users/patrickvuleta/Documents/GitHub/autism360-analytics`) — must NEVER contain `.switchboard/`

The extension already has a guard utility (`isAllowedSwitchboardLocation`) and a cleanup routine (`_validateNoSwitchboardPollution`), but neither covers the code path that actually creates the pollution.

### Root Cause

`TaskViewerProvider._setupPlanWatcher()` (called during construction at line 682) builds a `foldersToWatch` list and then unconditionally `mkdirSync`s `.switchboard/plans/` for each folder:

```typescript
// TaskViewerProvider.ts line 11764
const effectiveRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(workspaceRoot) || workspaceRoot;
if (!foldersToWatch.includes(path.resolve(effectiveRoot))) {
    foldersToWatch.push(path.resolve(effectiveRoot));
}
```

At construction time, `this._kanbanProvider` is **null** — `setKanbanProvider()` is called ~75 lines later in `extension.ts` (line 822; `new TaskViewerProvider` is at line 747). So `resolveEffectiveWorkspaceRoot()` returns `undefined`, and the fallback is the **raw, unresolved workspace root**. If the currently-selected workspace root is a child folder like `autism360-analytics`, it gets added to `foldersToWatch` without being resolved to its parent.

Then at line 11776-11780:
```typescript
for (const folder of foldersToWatch) {
    const plansRootDir = path.join(folder, '.switchboard', 'plans');
    if (!fs.existsSync(plansRootDir)) {
        fs.mkdirSync(plansRootDir, { recursive: true });
    }
}
```

No guard check — the directory is created unconditionally.

### Why Existing Defenses Don't Catch It

1. **`isAllowedSwitchboardLocation`** (`src/utils/switchboardLocationGuard.ts`) — correctly blocks child folders, but is only called from `ControlPlaneMigrationService._bootstrapControlPlaneLayout` and `KanbanDatabase` migration. **Not** called in `_setupPlanWatcher`.

2. **`_validateNoSwitchboardPollution`** (`TaskViewerProvider.ts` line 1771) — runs on activation and detects `.switchboard` in child folders, but only deletes specific files (`api-server-port.txt`, `workspace-id`, empty `kanban.db`). It removes the `.switchboard` dir only if **empty** — and since `_setupPlanWatcher` created a `plans/` subdirectory, the dir is non-empty, so cleanup skips it.

3. **Regression tests** (`child-switchboard-creation-regression.test.ts`) — test the guard utility in isolation, but not the `_setupPlanWatcher` code path.

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, reliability

## User Review Required

Yes — this plan modifies the activation-time plan watcher setup and the pollution cleanup routine. The approach reuses an existing guard utility at a new call site rather than fixing the root cause (null `_kanbanProvider` at construction time). Review the architecture review below before approving.

## Complexity Audit

### Routine
- Adding a `require()` + `.filter()` call to an existing method — single-file change, reuses an existing utility already proven in `ControlPlaneMigrationService.ts:672` (same `isAllowedSwitchboardLocation(folder, folder)` pattern).
- Enhancing `_validateNoSwitchboardPollution` to remove empty subdirs before the empty-dir check — straightforward `readdir`/`rmdir` loop, consistent with the existing async cleanup style.
- Adding a test case to an existing test file — the test infrastructure (VS Code mock, guard import) is already in place.

### Complex / Risky
- The `_setupPlanWatcher` method has **two loops** over `foldersToWatch` — the `mkdirSync` loop (line 11776) and the VS Code watcher creation loop (line 11814). Both must use the filtered `safeFolders` list. Missing the second loop would create watchers for child folders without creating dirs — a subtle inconsistency.
- The guard degrades to `candidate === workspaceRoot` (→ `true` when both args are `folder`) if `getMappingsFromIndex()` returns `{ enabled: false }`. This means the fix is only effective when the mapping index is loaded. The index IS loaded before construction (extension.ts:414, awaited), but if it fails, the child folder still passes.
- Other code paths (line 12000 brain-watcher staging dir, line 18769 `createPlan` method) also create `.switchboard/plans/` without the guard. This plan does NOT cover those — they are conditional (brain watcher requires antigravity roots) or user-initiated (createPlan), but worth tracking for a follow-up.

## Edge-Case & Dependency Audit

### Race Conditions
- `_setupPlanWatcher` (constructor, synchronous) runs before `_validateNoSwitchboardPollution` (line 694, async fire-and-forget). With Part 1 in place, `_setupPlanWatcher` no longer creates the dir in child folders, so there's no race. For existing pollution, `_validateNoSwitchboardPollution` runs after construction and cleans it up.
- `reinitializePlanWatcher` (line 4917) calls `_setupPlanWatcher` again when the user switches workspace via the kanban dropdown. At this point `_kanbanProvider` IS set, so `resolveEffectiveWorkspaceRoot` works correctly. The guard is still applied as defense-in-depth.

### Security
- No security implications — the guard only prevents directory creation in mapped child folders; it does not affect file permissions or access control.

### Side Effects
- Filtering `foldersToWatch` means VS Code file watchers are NOT created for child folders. This is correct — child folders should not have `.switchboard/plans/`, so watching them is pointless.
- The cleanup in Part 2 removes empty `plans/`, `archive/`, `inbox/`, `features/` subdirs. This is defensive — not all may exist. The `try/catch` handles ENOENT. User content in any subdir is preserved (only removed if `entries.length === 0`).

### Dependencies & Conflicts
- **Depends on:** `getMappingsFromIndex()` from `WorkspaceIdentityService` being initialized before `TaskViewerProvider` construction (extension.ts:414, awaited). The guard calls `require('../services/WorkspaceIdentityService')` internally — same module already `require()`d at line 11738 in `_setupPlanWatcher`.
- **Conflicts:** None. The guard is additive — it only filters out folders that should never have been in the list.
- **Not covered by this plan:** Lines 12000 (brain watcher staging) and 18769 (`createPlan`) also create `.switchboard/plans/` without the guard. These are separate code paths that may need their own guards in a follow-up plan.

## Dependencies

None — this is a standalone bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the guard degrades to "allow" if the mapping index isn't loaded, leaving the child folder unprotected; (2) two separate loops over `foldersToWatch` must both be updated to use the filtered list; (3) other creation sites (lines 12000, 18769) remain unguarded. Mitigations: the mapping index is awaited before construction (extension.ts:414); the plan explicitly calls out both loops; the unguarded paths are conditional/user-initiated and tracked for follow-up.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — Part 1: Guard `_setupPlanWatcher` against child folders

**Context:** `_setupPlanWatcher()` (line 11721) builds `foldersToWatch` from mapping parents (lines 11748-11757), then adds the effective workspace root as a safety net (line 11764). When `_kanbanProvider` is null (construction time), the effective root is the raw workspace root — which may be a child folder. The `mkdirSync` loop (line 11776) and the VS Code watcher loop (line 11814) both iterate `foldersToWatch` unconditionally.

**Logic:** After building `foldersToWatch` (after line 11772, before line 11774), filter the list through `isAllowedSwitchboardLocation`. This blocks mapped child folders while allowing parents and unmapped roots.

**Implementation:**

Insert after line 11772 (after the fallback block), before line 11774 (the mkdirSync loop):

```typescript
// Guard: filter out mapped child workspaceFolders — they must never get .switchboard/
const { isAllowedSwitchboardLocation } = require('../utils/switchboardLocationGuard');
const safeFolders = foldersToWatch.filter(folder =>
    isAllowedSwitchboardLocation(folder, folder)
);
```

Then replace `foldersToWatch` with `safeFolders` in **both** subsequent loops:

1. **mkdirSync loop** (line 11776): `for (const folder of safeFolders)`
2. **VS Code watcher loop** (line 11814): `for (const folder of safeFolders)`

**Why pass `folder` as both args:** The guard checks (a) mapped child → block, (b) mapped parent → allow, (c) default `candidate === workspaceRoot` → allow. Passing `folder` as both args means: block children, allow parents, allow anything unmapped (`folder === folder` → `true`). This is the same pattern used at `ControlPlaneMigrationService.ts:672` (`isAllowedSwitchboardLocation(parentDir, parentDir)`).

**Edge case — `_kanbanProvider` is null at construction time:** The guard reads from `getMappingsFromIndex()` (the mapping index built in `extension.ts` line 414, before `TaskViewerProvider` construction at line 747). So even without `_kanbanProvider`, the guard has access to the mapping config and can correctly identify child folders. The guard doesn't depend on `KanbanProvider`.

**Edge case — mapping index not loaded:** If `getMappingsFromIndex()` returns `{ enabled: false, mappings: [] }` (e.g., `initializeMappingIndex` failed), the guard falls through to `candidate === workspaceRoot` → `folder === folder` → `true`. The child folder would pass and still get scaffolded. This is the same behavior as today (no regression), and `initializeMappingIndex` is awaited before construction so it should not happen in practice.

### `src/services/TaskViewerProvider.ts` — Part 2: Enhance `_validateNoSwitchboardPollution` to clean up `plans/` subdirs

**Context:** `_validateNoSwitchboardPollution()` (line 1771) removes specific auto-generated files (`api-server-port.txt`, `workspace-id`, empty `kanban.db`) from child folders, then removes the `.switchboard` dir only if empty (lines 1844-1850). But `_setupPlanWatcher` created a `plans/` subdirectory, making the dir non-empty, so cleanup skips it.

**Logic:** Before the "Remove empty .switchboard dir" block (line 1844), remove any empty known subdirectories. Once the subdirs are gone, the parent `.switchboard` dir becomes empty and is removed by the existing logic.

**Implementation:**

Insert before line 1844 (before the `// Remove empty .switchboard dir` block):

```typescript
// Remove empty known subdirectories so the .switchboard dir can be removed
const subDirsToClean = ['plans', 'archive', 'inbox', 'features'];
for (const subDir of subDirsToClean) {
    const subDirPath = path.join(switchboardDir, subDir);
    try {
        const entries = await fs.promises.readdir(subDirPath);
        if (entries.length === 0) {
            await fs.promises.rmdir(subDirPath);
        }
    } catch { /* not present — skip */ }
}
```

This ensures previously-polluted child folders get cleaned up on the next activation — the empty `plans/` dir is removed, then `.switchboard` becomes empty and is removed.

**Note:** The list `['plans', 'archive', 'inbox', 'features']` is defensive — not all subdirs may exist in every child folder. The `try/catch` handles ENOENT. Only **empty** subdirs are removed; user content is preserved.

### `src/test/child-switchboard-creation-regression.test.ts` — Part 3: Add regression test

**Context:** The existing test file has 4 tests covering `isAllowedSwitchboardLocation` in isolation. None test the exact `_setupPlanWatcher` scenario: `workspaceRoot` is the child itself, `_kanbanProvider` is null, and the guard must still block.

**Logic:** Add a test case that reproduces the bug scenario — a child folder that IS the workspace root, with mappings enabled, confirming the guard blocks it. This documents the exact regression and prevents future breaks.

**Implementation:**

Add as test 5 in the existing suite:

```typescript
test('5. _setupPlanWatcher scenario — child IS workspaceRoot, guard blocks', () => {
    // Reproduces the exact bug: _kanbanProvider is null at construction time,
    // so effectiveRoot falls back to the raw workspaceRoot. If the workspaceRoot
    // is a child folder, the guard must still block it.
    const mappingsConfig = {
        enabled: true,
        mappings: [
            {
                workspaceFolders: ['~/Documents/GitHub/autism360-analytics'],
                parentFolder: '~/Documents/Gitlab'
            }
        ]
    };
    const mock = installVsCodeMock(mappingsConfig);
    try {
        const guardPath = path.resolve(__dirname, '..', 'utils', 'switchboardLocationGuard');
        delete require.cache[require.resolve(guardPath)];
        const { isAllowedSwitchboardLocation } = require(guardPath);

        const home = os.homedir();
        const childResolved = path.join(home, 'Documents', 'GitHub', 'autism360-analytics');
        const parentResolved = path.join(home, 'Documents', 'Gitlab');

        // The child IS the workspaceRoot (as happens when _kanbanProvider is null)
        assert.strictEqual(
            isAllowedSwitchboardLocation(childResolved, childResolved),
            false,
            'Should block child folder even when it is the workspaceRoot — this is the _setupPlanWatcher bug scenario'
        );
        // The parent must still be allowed
        assert.strictEqual(
            isAllowedSwitchboardLocation(parentResolved, childResolved),
            true,
            'Should allow the configured parentFolder'
        );
    } finally {
        mock.restore();
    }
});
```

> **Superseded:** The original plan offered two options — (a) retest the guard, or (b) extract a `filterWatchFolders` pure function and test it. Option (b) would require Part 1 to use the extracted function, adding scope. Since Part 1 uses the guard directly (consistent with `ControlPlaneMigrationService.ts` and `LocalFolderService.ts`), option (a) is the consistent choice. The test above is option (a) but specifically documents the `_setupPlanWatcher` bug scenario (child as workspaceRoot, null provider) rather than duplicating test #2's generic child-blocking assertion.
>
> **Reason:** Extracting a new function adds scope and a new export surface for marginal testability gain — the guard is already pure and directly testable.
>
> **Replaced with:** A focused regression test (test 5) that documents the exact bug scenario and asserts the guard blocks it.

## Files Changed

| File | Change |
|------|--------|
| `src/services/TaskViewerProvider.ts` | Add `isAllowedSwitchboardLocation` guard in `_setupPlanWatcher` (filter `foldersToWatch` → `safeFolders` before both the mkdirSync loop and the watcher loop); enhance `_validateNoSwitchboardPollution` to clean empty `plans/`/`archive/`/`inbox/`/`features/` subdirs before the empty-dir check |
| `src/test/child-switchboard-creation-regression.test.ts` | Add test 5 for the `_setupPlanWatcher` filtering scenario (child IS workspaceRoot, guard blocks) |

## Verification Plan

### Automated Tests

> **Session directive:** Automated test execution and compilation are SKIPPED per session instructions. The steps below describe what WOULD be verified; they are not run in this session.

1. Run existing regression tests: `npm test -- --grep "Child Switchboard Creation"` — confirms tests 1-4 still pass and test 5 passes.
2. Type check: `npm run compile` (or equivalent) — confirms the `require()` import and `safeFolders` variable type-check cleanly.

### Manual Verification

1. **Repro:** Open the `autism360.code-workspace`, delete `autism360-analytics/.switchboard/` if it exists, reload the extension. Confirm `.switchboard/` is NOT recreated in `autism360-analytics/`.
2. **Existing pollution cleanup:** Pre-create `autism360-analytics/.switchboard/plans/` (empty), reload. Confirm it is removed on activation.
3. **Other mapped children:** Confirm `ai`, `be`, `fe`, `viaapp`, `viaapp-web`, `funnel-sandbox` also do not get `.switchboard/plans/`.
4. **Parent still works:** Confirm `/Users/patrickvuleta/Documents/Gitlab` still gets its `.switchboard/plans/` watched correctly (plans appear in the tree view).
5. **Standalone workspace:** Open a standalone workspace (no mappings configured). Confirm `.switchboard/plans/` scaffolds normally.
6. **User content preserved:** Pre-create `autism360-analytics/.switchboard/plans/some-plan.md`. Reload. Confirm the file is NOT deleted (only empty subdirs are removed).

## Recommendation

Complexity is 4 → **Send to Coder**.

## Completion Summary

Implemented all three parts. Part 1: added `isAllowedSwitchboardLocation` guard in `_setupPlanWatcher` (line 11774) filtering `foldersToWatch`→`safeFolders`; both the `mkdirSync` loop (line 11782) and VS Code watcher loop (line 11832) now iterate `safeFolders`, blocking mapped child folders from getting `.switchboard/plans/`. Part 2: enhanced `_validateNoSwitchboardPollution` (line 1844) to remove empty `plans`/`archive`/`inbox`/`features` subdirs before the empty-dir check, so previously-polluted child folders get cleaned on next activation. Part 3: added test 5 documenting the exact `_setupPlanWatcher` bug scenario (child IS workspaceRoot, null provider, guard blocks). Files changed: `src/services/TaskViewerProvider.ts`, `src/test/child-switchboard-creation-regression.test.ts`. No issues encountered; Red Team review passed (guard degrades safely, user content preserved, no circular deps).

## Review Findings

**Parts 1 & 2 (production code): correct.** The guard filter is placed after `foldersToWatch` is fully built and before both the `mkdirSync` and VS Code watcher loops; native `fs.watch` also uses `watchDirs` built from `safeFolders`. The subdir cleanup in `_validateNoSwitchboardPollution` is correctly scoped inside the child-root detection block. No orphaned references to unfiltered `foldersToWatch` remain after the filter point.

**Part 3 (test): CRITICAL fix applied.** The test mock `installVsCodeMock` was broken since commit `a94e7f6` (May 27) refactored the guard to use `getMappingsFromIndex()` instead of `vscode.workspace.getConfiguration`. The mock only intercepted `vscode`, so `getMappingsFromIndex()` returned `{ enabled: false, mappings: [] }` in tests — tests 2, 4, and 5 would fail when actually run. Fixed by extending `installVsCodeMock` to also intercept `WorkspaceIdentityService` requires and return a mock `getMappingsFromIndex` that returns the config directly, plus clearing the `WorkspaceIdentityService` cache. File changed in review: `src/test/child-switchboard-creation-regression.test.ts`.

**Additional fix during review:** `_setupBrainWatcher` (line 12020) had the same unguarded `mkdirSync` creating `.switchboard/plans/` — the plan deferred this as "conditional," but it fires during deferred constructor init (line 2061) when `_kanbanProvider` may still be null, same root cause. Added `isAllowedSwitchboardLocation` guard before the `mkdirSync`, early-returning the entire method if the workspace root is a mapped child. This also prevents the downstream staging watcher (`fs.watch(stagingDir)`) from being set up against a non-existent directory. Committed as `03a9283`.

**Verification:** Compilation and tests skipped per review instructions. Code-level trace confirms the mock now provides the mapping config through the correct code path. Remaining risk: the unrelated changes swept into commit `544888a` (MCP tools.ts, webview UI, KanbanProvider, tsconfig) are from other plans and were not reviewed. The `_createInitiatedPlan` path (line 18790) remains unguarded but is only reachable post-init when `_kanbanProvider` is set and `_resolveWorkspaceRoot()` resolves to the parent.
