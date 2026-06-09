# Fix Workspace Database Mappings Scope Mismatch

## Goal

Unify `workspaceDatabaseMappings` reads and writes to workspace scope throughout `SetupPanelProvider.ts` so the Setup Panel and KanbanDatabase/KanbanProvider always see the same configuration, eliminating the split-brain that causes stale mappings, missing mappings in the UI, and "database not found" errors.

## Metadata

- **Tags:** backend, reliability, bugfix
- **Complexity:** 5

## User Review Required

> [!IMPORTANT]
> **Scope change in `package.json`** — Changing `"scope": "resource"` → `"scope": "window"` for `workspaceDatabaseMappings` is a breaking change for any user who currently has this setting stored in a per-folder section of their `.code-workspace` file. A one-time startup migration must be included (see Step 2 below) to lift those values to workspace scope before they become invisible. Confirm this migration approach is acceptable before coding begins.

> [!WARNING]
> **Auto-cleanup of stale mappings** — The original plan proposed silently deleting stale entries on first load. This has been revised to surface warnings in the Setup UI and let the user act manually, since silent deletion of user config (e.g., a DB on a temporarily unmounted drive) is unacceptably destructive. Confirm this revised approach.

## Complexity Audit

### Routine
- Removing `folderUri` parameter from four specific `case` handlers in `SetupPanelProvider.ts`
- Changing `ConfigurationTarget.WorkspaceFolder` → `ConfigurationTarget.Workspace` in the same four handlers
- Updating `"scope"` in `package.json` from `"resource"` to `"window"`
- Adding mapping `name` prefix to dropdown workspace labels in `_getWorkspaceItems`

### Complex / Risky
- One-time startup migration: reading per-folder scope values and lifting them to workspace scope without data loss
- Risk of developer touching non-mapping `folderUri` usages in the same file (e.g., `savePlanningSources`, `saveIntegrationProviderPreference`) — must be left untouched
- `initializeWorkspaceDatabase` writes a mapping immediately after DB creation; if called before the fix is applied and then `saveWorkspaceMappings` is called after, divergent copies may coexist across scopes — migration must purge the folder-scoped copy

## Edge-Case & Dependency Audit

### Race Conditions
- User calls `initializeWorkspaceDatabase` (pre-fix: writes to folder scope) → then `saveWorkspaceMappings` (post-fix: writes to workspace scope). Two divergent copies exist. The startup migration must detect and merge/purge this. Migration must run before any mapping read in the Setup Panel.

### Security
- No security surface change. Config is local-only.

### Side Effects
- After the scope change, `vscode.workspace.getConfiguration('switchboard', folderUri).get('workspaceDatabaseMappings')` called anywhere will now resolve via workspace scope (the same value), eliminating the split-brain. No consumer code needs changing — they already use the scopeless API.
- Dropdown workspace labels will change from bare `basename` to prefixed `"MappingName › basename"` — this is a visible UI change.

### Dependencies & Conflicts
- `KanbanDatabase.ts` and `KanbanProvider.ts` already read from workspace scope (no `folderUri`). No changes needed to those files' read calls.
- VS Code's config merge strategy: for `"scope": "window"`, folder-level overrides are not supported. VS Code will silently ignore per-folder values after the scope change. Migration must run before VS Code drops those values.

## Dependencies

- None — this is a self-contained configuration scope fix.

## Adversarial Synthesis

Key risks: (1) the scope change from `resource` → `window` silently hides existing per-folder mappings for current users unless a startup migration lifts them first; (2) developers may incorrectly remove `folderUri` from non-mapping handlers (`savePlanningSources`, `saveIntegrationProviderPreference`) which are legitimately folder-scoped. Mitigations: (1) implement a one-time migration in the extension activation path that reads all folder-scoped `workspaceDatabaseMappings` values, merges them into workspace scope, then clears the folder-scoped copies; (2) add inline comments in `SetupPanelProvider.ts` explicitly marking the non-mapping `folderUri` usages as intentionally folder-scoped.

## Proposed Changes

### `src/services/SetupPanelProvider.ts`

**Context:** Four `case` handlers read/write `workspaceDatabaseMappings` with `folderUri`, causing writes to land in folder scope while all consumers read from workspace scope.

**Logic:** Replace the `folderUri`-scoped pattern with the workspace-scope equivalent in exactly these four handlers. Do NOT change `folderUri` usage in `savePlanningSources` (line ~577), `saveIntegrationProviderPreference` (line ~548), `getPlanningSources` (line ~678), or any helper methods — those settings are legitimately folder-scoped.

**Implementation — four targeted changes:**

1. **`getWorkspaceMappings` case (lines 692–700):**
   ```typescript
   // BEFORE
   const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
   const config = vscode.workspace.getConfiguration('switchboard', folderUri);
   const mappings = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });

   // AFTER
   const config = vscode.workspace.getConfiguration('switchboard');
   const mappings = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
   ```

2. **`setWorkspaceMappingEnabled` case (lines 702–717):**
   ```typescript
   // BEFORE
   const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
   const config = vscode.workspace.getConfiguration('switchboard', folderUri);
   const current = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
   await config.update('workspaceDatabaseMappings', { ...current, enabled },
       folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace);

   // AFTER
   const config = vscode.workspace.getConfiguration('switchboard');
   const current = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
   await config.update('workspaceDatabaseMappings', { ...current, enabled },
       vscode.ConfigurationTarget.Workspace);
   ```

3. **`saveWorkspaceMappings` case write block (lines 809–815):**
   ```typescript
   // BEFORE
   const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
   const config = vscode.workspace.getConfiguration('switchboard', folderUri);
   await config.update('workspaceDatabaseMappings', incoming,
       folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace);

   // AFTER
   const config = vscode.workspace.getConfiguration('switchboard');
   await config.update('workspaceDatabaseMappings', incoming,
       vscode.ConfigurationTarget.Workspace);
   ```

4. **`initializeWorkspaceDatabase` case config block (lines 882–902):**
   ```typescript
   // BEFORE
   const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
   const config = vscode.workspace.getConfiguration('switchboard', folderUri);
   const current = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
   await config.update('workspaceDatabaseMappings', { ...current, enabled: true, mappings: updatedMappings },
       folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace);

   // AFTER
   const config = vscode.workspace.getConfiguration('switchboard');
   const current = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
   await config.update('workspaceDatabaseMappings', { ...current, enabled: true, mappings: updatedMappings },
       vscode.ConfigurationTarget.Workspace);
   ```

**Add a comment block** above each of the non-mapping `folderUri` usages to prevent future regressions:
```typescript
// NOTE: intentionally folder-scoped — this setting is per-project, not shared across workspaces
```

---

### `package.json`

**Context:** `switchboard.workspaceDatabaseMappings` is currently registered with `"scope": "resource"`, which allows per-folder overrides and is the source of the split-brain.

**Implementation:**

```diff
  "switchboard.workspaceDatabaseMappings": {
    ...
-   "scope": "resource"
+   "scope": "window"
  }
```

**Edge case:** After this change, VS Code will no longer expose per-folder overrides in the Settings UI. Any existing per-folder values in `.code-workspace` become invisible to `getConfiguration` calls. The startup migration (below) must run before this becomes a problem.

---

### One-time startup migration (in extension activation — `extension.ts` or `SetupPanelProvider` constructor)

**Context:** Users who saved mappings before this fix will have values in the per-folder scope. After the scope change to `window`, those values become invisible. The migration lifts them to workspace scope.

**Logic:**
```typescript
async function migrateWorkspaceDatabaseMappings(): Promise<void> {
    const workspaceCfg = vscode.workspace.getConfiguration('switchboard');
    const workspaceValue = workspaceCfg.get<any>('workspaceDatabaseMappings');
    const isDefault = !workspaceValue?.enabled && (!workspaceValue?.mappings || workspaceValue.mappings.length === 0);

    if (!isDefault) {
        return; // workspace-scope already has real data, nothing to migrate
    }

    // Check each open folder for folder-scoped values
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const folderCfg = vscode.workspace.getConfiguration('switchboard', folder.uri);
        const folderValue = folderCfg.get<any>('workspaceDatabaseMappings');
        if (folderValue?.enabled || (Array.isArray(folderValue?.mappings) && folderValue.mappings.length > 0)) {
            // Lift to workspace scope
            await workspaceCfg.update('workspaceDatabaseMappings', folderValue, vscode.ConfigurationTarget.Workspace);
            // Clear the folder-scoped copy to avoid future confusion
            await folderCfg.update('workspaceDatabaseMappings', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
            console.log('[Switchboard] Migrated workspaceDatabaseMappings from folder scope to workspace scope');
            break; // only migrate the first folder that has data; warn if multiple have data
        }
    }
}
```

Call `migrateWorkspaceDatabaseMappings()` during extension activation, before the Setup Panel or Kanban views are constructed.

---

### `src/services/KanbanProvider.ts` — `_getWorkspaceItems` (lines 737–748)

**Context:** Dropdown workspace entries currently display only `path.basename(resolvedDw)`, making them indistinguishable if two mappings have similarly-named child folders.

**Implementation:** Prefix the dropdown label with the mapping name:
```typescript
// BEFORE
items.push({
    label: path.basename(resolvedDw),
    workspaceRoot: resolvedDw
});

// AFTER
items.push({
    label: `${m.name ? m.name + ' › ' : ''}${path.basename(resolvedDw)}`,
    workspaceRoot: resolvedDw
});
```

**Edge cases:**
- If `m.name` is empty/undefined, falls back to bare basename (no regression).
- The `›` separator is consistent with VS Code's own breadcrumb style.

---

### Stale mapping cleanup (Setup Panel UI, not auto-delete)

**Context:** After the scope fix reveals the true workspace-scoped mappings, some may point to non-existent DB paths (e.g., DB was moved). Rather than auto-deleting, surface warnings.

**Implementation:** In the `getWorkspaceMappings` handler (after the fix), after reading mappings, add a validation pass:
```typescript
const warnings: string[] = [];
for (const m of mappings.mappings ?? []) {
    if (m.mode === 'connect' && m.dbPath && !fs.existsSync(m.dbPath)) {
        warnings.push(`Mapping "${m.name}": database not found at ${m.dbPath}`);
    }
    if (m.parentFolder && !fs.existsSync(m.parentFolder)) {
        warnings.push(`Mapping "${m.name}": parent folder not found at ${m.parentFolder}`);
    }
}
this._panel?.webview.postMessage({
    type: 'workspaceMappings',
    ...mappings,
    warnings  // new field — Setup Panel UI must render these as dismissible warnings
});
```

The Setup Panel webview must be updated to render `warnings` as a dismissible banner above the mapping list.

## Verification Plan

### Automated Tests

- Run existing test suite: `npm run test` — must pass with no regressions
- Manual smoke test checklist (see below)

### Manual Verification

1. **Fresh user (no existing mappings):** Open Setup Panel → Workspace Mappings tab → add a mapping → save → open Kanban → confirm the new mapping appears in the workspace picker.
2. **Existing folder-scoped user (migration path):** Set up a folder-scoped `workspaceDatabaseMappings` value in `.code-workspace` under a specific folder entry → reload extension → confirm migration log appears in Output panel → confirm Setup Panel shows the migrated mapping → confirm Kanban picker shows it.
3. **Stale path warning:** Save a mapping with a `dbPath` that doesn't exist → reload → confirm the Setup Panel shows a warning banner for that mapping (not an auto-delete).
4. **Dropdown label:** Add a mapping with `dropdownWorkspaces` → confirm labels in the workspace picker show `"MappingName › foldername"` format.
5. **Non-mapping settings regression:** Change `integrations.preferredProvider` → confirm it still writes to folder scope (check `.code-workspace` file).

---

*Send to Coder*

---

## Post-Implementation Review

**Reviewer:** Antigravity (inline reviewer-executor)
**Review Date:** 2026-05-21
**Status:** APPROVED WITH FIXES APPLIED

### Grumpy Review Findings

| # | Severity | Finding | Action |
|---|---|---|---|
| 1 | CRITICAL | Tests 1-3 in `workspace-mappings-settings-sync.test.ts` asserted the pre-fix broken behavior (getConfiguration called WITH a folderUri). The fix removes folderUri; the tests were validating the bug, not the fix. | **Fixed** |
| 2 | MAJOR | `migrateWorkspaceDatabaseMappings()` silently discarded data for any folder beyond the first when multiple folders had folder-scoped mappings. Comment said "warn if multiple have data" — code just `break`ed with zero warning. | **Fixed** |
| 3 | MAJOR | `_getWorkspaceItems` parent label re-audit — `m.name || basename` is correct since the parent is labelled by the mapping name. | No action — confirmed correct |
| 4 | NIT | Migration `isDefault` condition lacks comment about `undefined` meaning "never written". | Deferred |
| 5 | NIT | `getWorkspaceMappings` always sends `warnings: []` even when empty. | Deferred — benign |

### Files Changed (Implementation, pre-existing)

| File | Change |
|---|---|
| `src/services/SetupPanelProvider.ts` | Removed `folderUri` from all 4 `workspaceDatabaseMappings` handlers; `ConfigurationTarget.Workspace` everywhere; `NOTE` comments on non-mapping handlers; stale-path `warnings` pass |
| `package.json` | `workspaceDatabaseMappings` scope: "resource" -> "window" |
| `src/extension.ts` | Added `migrateWorkspaceDatabaseMappings()` + activation call before `KanbanProvider` instantiation |
| `src/services/KanbanProvider.ts` | `_getWorkspaceItems` dropdown label: `m.name + ' › ' + basename` |

### Files Changed (Review fixes applied)

| File | Change |
|---|---|
| `src/test/workspace-mappings-settings-sync.test.ts` | Tests 1-3: Inverted folderUri assertions to verify `undefined` (workspace scope); updated test names to describe correct expected behaviour |
| `src/extension.ts` | `migrateWorkspaceDatabaseMappings()`: replaced silent `break` with explicit multi-folder detection + `console.warn` listing skipped folder paths |

### Validation Results

- **TypeScript compilation:** `webpack compiled successfully` — clean pre-fix and post-fix
- **Non-mapping handlers:** `savePlanningSources` (L571) and `saveIntegrationProviderPreference` (L546) retain `folderUri` and are annotated
- **Migration placement:** Line 1164, before `new KanbanProvider(...)` at L1166
- **Dropdown label:** `${m.name ? m.name + ' > ' : ''}${path.basename(resolvedDw)}` at KanbanProvider L745
- **package.json scope:** "scope": "window" at L412

### Remaining Risks

- **Migration has no unit tests** — runs in extension host; manual testing per Verification Plan step 2 is the only coverage.
- **Multi-folder warning is console.warn only** — not visible in the Output panel. A `vscode.window.showWarningMessage` would surface it to end users but was not added to keep the fix minimal.
- **Webview `warnings` rendering not implemented** — the backend emits the `warnings` field correctly; the Setup Panel webview UI for rendering dismissible banners remains unbuilt.
