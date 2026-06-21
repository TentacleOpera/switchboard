# Globalize Tickets Tab — Remove Workspace-Root Scoping

## Metadata
- **Tags:** backend, frontend, bugfix, refactor
- **Complexity:** 6
- **Root cause of:** Tickets tab not fetching data from ClickUp or Linear after commit `ec4ae27` ("Globalize Integration Config")

## Goal

Make the tickets tab fully global: remove all workspace-root scoping from the tickets flow so that tickets fetch correctly regardless of which workspace folders are open. The integration config is already global (`~/.switchboard/integration-config.json`); the tickets UI and message routing must catch up.

## Problem Analysis & Root Cause

### What changed
Commit `ec4ae27` globalized ClickUp and Linear config storage. `ClickUpSyncService.loadConfig()` and `LinearSyncService.loadConfig()` now read from `GlobalIntegrationConfigService` (`~/.switchboard/integration-config.json`) instead of per-workspace `.switchboard/clickup-config.json` / `linear-config.json`. This means **every** workspace root reports having an integration configured, because `loadConfig()` returns the same global config regardless of which `workspaceRoot` the service was constructed with.

### The break
`_getIntegrationWorkspaces()` (`PlanningPanelProvider.ts:1322`) iterates all workspace roots and calls `loadConfig()` on each. Since config is now global, **every** open workspace folder is returned as having an integration — false positives for all roots.

This cascades through the tickets flow:

1. **`ticketsDefaultRoot` handler** (`PlanningPanelProvider.ts:1660`): picks `integrationWorkspaces[0].workspaceRoot` as the default — an arbitrary workspace root, not necessarily the one the user expects.

2. **`integrationProviderStates` from `fetchRoots`** (`PlanningPanelProvider.ts:1631`): sent with `workspaceRoot` = `this._getWorkspaceRoot() || allRoots[0]` (line 1573) — potentially a **different** root than the `ticketsDefaultRoot` response.

3. **Webview race-protection guard** (`planning.js:2767`): drops any tickets message where `msg.workspaceRoot !== ticketsWorkspaceRoot`. When `integrationProviderStates` arrives with a mismatched root, the webview ignores it — `lastIntegrationProvider` is never set, `ticketsAutoSync` is never set, and the tab never triggers a load.

4. **`integrationProviderStates` guard** (`planning.js:4203`): `if (msg.workspaceRoot === ticketsWorkspaceRoot)` — silently skips the entire provider-state update when roots don't match.

5. **Result**: The tickets tab shows no data. No error, no loading state — just empty, because the provider-state message that would trigger `loadClickUpSpaces()` / `loadLinearProject()` / `loadLocalTicketFiles()` is dropped.

### Why workspace-root scoping is now meaningless for tickets
- Config is global → `ClickUpSyncService(rootA).loadConfig()` === `ClickUpSyncService(rootB).loadConfig()`.
- API keys are in `secretStorage` (global, not per-workspace).
- `ticketsAutoSync` is now in `GlobalIntegrationConfigService` (line 10, 104-113) — though `LocalFolderService.getTicketsAutoSync()` still reads from per-workspace DB (`folders.paths` config). This is a secondary inconsistency.
- The `tickets-workspace-filter` dropdown (`planning.html:3330`) is now misleading — it implies per-workspace integrations that don't exist.

## User Review Required

Yes — this plan changes the semantics of the `tickets-workspace-filter` dropdown (from "integration picker" to "save-location picker") and removes a race-protection guard. The user should confirm:
1. That reframing the dropdown as a save-location selector (rather than removing it) is the desired UX.
2. That removing the race-protection guard entirely (Option A) is acceptable vs. narrowing it to local-file-only messages (Option B).
3. That the `ticketsAutoSync` migration (read from per-workspace DB on first run, write to global) is the desired migration path.

## Complexity Audit

### Routine
- Removing the `if (msg.workspaceRoot === ticketsWorkspaceRoot)` guard at `planning.js:4203` — single-line deletion plus matching brace.
- Changing `_activeTicketsProvider` from `Map<string, ...>` to a single scalar and updating the 6 usage sites (lines 103, 1614, 1624, 1700, 1710, 1735) — mechanical `.get(root)`/`.set(root, x)` → direct read/write.
- Simplifying `ticketsDefaultRoot` handler to drop the per-root integration iteration.
- Switching `ticketsAutoSync` reads from `LocalFolderService.getTicketsAutoSync()` to `GlobalIntegrationConfigService.getTicketsAutoSync()` at lines 1629, 1715, 1744 — three call-site swaps (note: `getTicketsAutoSync` becomes `async`, returning `Promise<boolean>`).

### Complex / Risky
- **`_getIntegrationWorkspaces()` rewrite drops the `buildWorkspaceItems` filter.** The original (line 1324) restricts roots to those `buildWorkspaceItems(allRoots)` returns — which, when workspace-identity mappings are enabled, may be a *subset* of `allRoots` (parent mapping names, not individual folders). The plan's proposed replacement iterates `allRoots` directly and returns `allRoots.map(root => ...)`, which would change the dropdown contents in mapped multi-root contexts. Must preserve the `buildWorkspaceItems` filter.
- **Race-protection guard removal (Option A).** The guard at `planning.js:2766-2771` covers ~20 message types. Removing it entirely means `localTicketFilesListed` and `ticketSyncStatusesLoaded` (which *are* per-root — they read from per-workspace DB) would no longer be protected. A stale response from root A could overwrite root B's local-file list. Option B (narrowing) is safer.
- **`ticketsAutoSync` migration on first run.** Reading from any workspace's `LocalFolderService` and writing to global requires picking *which* workspace's value wins when multiple exist. Ambiguous — needs a deterministic rule (e.g. first root alphabetically, or the active root).
- **`ticketsRootChanged` dropdown handler still resets all in-memory state** (`planning.js:5828-5831` calls `saveTicketsState()` + `resetTicketsInMemoryState()`). With global config, switching the dropdown re-fetches identical data and wipes the user's current view. Wasteful UX even if not broken.

## Edge-Case & Dependency Audit

### Race Conditions
- **`integrationProviderStates` vs `ticketsDefaultRoot` ordering.** Both are sent during `fetchRoots`. `ticketsDefaultRoot` sets `ticketsWorkspaceRoot`; `integrationProviderStates` (post-fix) no longer gates on it. But the webview's `integrationProviderStates` handler (line 4228) calls `loadClickUpSpaces()`/`loadLinearProject()` only `if (isTicketsTabActive() && lastIntegrationProvider)`. If `ticketsDefaultRoot` hasn't arrived yet, `ticketsWorkspaceRoot` may be empty and `loadLocalTicketFiles()`/file watchers won't have a root. Order is currently: `integrationWorkspaces` → `_handleFetchRoots` → `integrationProviderStates` (line 1598-1638). `ticketsDefaultRoot` is sent separately when the webview requests it. Verify the webview requests `ticketsDefaultRoot` early (before or alongside `fetchRoots`).
- **`switchTicketsProvider` (line 1732)** sends a new `integrationProviderStates` with `workspaceRoot`. After the fix removes the webview guard, this message is always accepted — correct, but means a rapid provider switch could land an outdated message. Low risk since provider switches are user-initiated and infrequent.

### Security
- No new secret exposure. Config reads remain behind the same `loadConfig()` path. `ticketsAutoSync` migration writes to `~/.switchboard/integration-config.json` (already mode `0o600` via `saveGlobal`).

### Side Effects
- **`_updateTicketsAutoSyncWatcher(workspaceRoot, ...)`** (line 7248) is keyed per-`workspaceRoot` in `_ticketsAutoSyncWatchers` map. After globalizing `ticketsAutoSync`, the watcher is still set up per-root (line 7268 watches `path.join(workspaceRoot, '.switchboard/tickets/**/*.md')`). This is correct — file watchers *should* be per-root. But the `enabled` flag now comes from global config, so all roots get the same flag. No bug, but the watcher map remains per-root by design.
- **Dropdown `change` handler** (`planning.js:5823`) triggers `ticketsRootChanged` → backend re-loads config (now redundant since global) → re-sends `integrationProviderStates`. With the guard removed, this lands and re-triggers `loadClickUpSpaces()`/`loadLinearProject()`, re-fetching identical data. Functional but noisy.

### Dependencies & Conflicts
- **Depends on commit `ec4ae27`** (globalized integration config) already being in the tree. Confirmed present (git log shows it).
- **`SetupPanelProvider.ts:1160`** already writes `ticketsAutoSync` via `GlobalIntegrationConfigService.setTicketsAutoSync()`. This plan makes the *read* side consistent. No conflict — the setup panel is the single writer.
- **`LocalFolderService.setTicketsAutoSync()`** (line 709) becomes dead code for new writes but must remain for migration reads. Do not delete.
- **`kanban-linear-project-tab-regression.test.js`** — the plan's verification references it. Per session directives, tests are deferred to the user.

## Dependencies
- `ec4ae27` — Globalize Integration Config & Fix Docs Tab Source Filter (already merged; the root-cause commit this plan fixes).
- `GlobalIntegrationConfigService` (lines 104-113) — provides `getTicketsAutoSync()` / `setTicketsAutoSync()`; already present.

## Adversarial Synthesis

Key risks: (1) the proposed `_getIntegrationWorkspaces()` rewrite silently drops the `buildWorkspaceItems` filter, changing dropdown contents in mapped multi-root contexts; (2) removing the race-protection guard entirely (Option A) leaves per-root local-file messages (`localTicketFilesListed`, `ticketSyncStatusesLoaded`) unprotected against stale cross-root responses; (3) the `ticketsAutoSync` migration picks an ambiguous "any workspace" source when multiple roots have conflicting per-workspace values. Mitigations: preserve the `buildWorkspaceItems` filter in the rewrite; adopt Option B (narrow the guard to local-file-only message types) instead of Option A; specify a deterministic migration source (active root, else first root) for `ticketsAutoSync`.

## Proposed Changes

### Phase 1: Backend — Remove workspace-root from tickets message routing

#### 1.1 `_getIntegrationWorkspaces()` → replace with global check
**File:** `src/services/PlanningPanelProvider.ts:1322-1346`

Replace the per-root iteration with a single global config check. **Preserve the `buildWorkspaceItems` filter** that the original applies at line 1324 — do not iterate raw `allRoots`:
```typescript
private async _getIntegrationWorkspaces(): Promise<Array<{ workspaceRoot: string; provider: 'clickup' | 'linear' }>> {
    const allRoots = this._getWorkspaceRoots();
    const allowedRoots = new Set(buildWorkspaceItems(allRoots).map(item => item.workspaceRoot));
    if (allRoots.length === 0 || allowedRoots.size === 0) return [];
    try {
        // Config is global — check once using any allowed root, not per-root.
        const probeRoot = allRoots.find(r => allowedRoots.has(r)) || allRoots[0];
        const [clickUpConfig, linearConfig] = await Promise.all([
            this._adapterFactories.getClickUpSyncService(probeRoot).loadConfig(),
            this._adapterFactories.getLinearSyncService(probeRoot).loadConfig()
        ]);
        const provider = (clickUpConfig?.setupComplete) ? 'clickup'
            : (linearConfig?.setupComplete) ? 'linear'
            : null;
        if (!provider) return [];
        // Tag every allowed root with the global provider so the dropdown can
        // still show workspace names for file-save context.
        return Array.from(allowedRoots).map(root => ({ workspaceRoot: root, provider }));
    } catch {
        return [];
    }
}
```

**Rationale:** Since config is global, checking once is sufficient. We still return all *allowed* roots (tagged with the provider) so the webview can display workspace names — but the provider state is identical for all roots. Preserving the `buildWorkspaceItems` filter avoids changing dropdown contents in mapped multi-root contexts.

#### 1.2 `ticketsDefaultRoot` handler — simplify
**File:** `src/services/PlanningPanelProvider.ts:1660-1688`

Since all roots have the same provider, the "default root" concept is only needed for file-path context (where imported tickets are saved). Simplify:
- Keep the restored-root preference (for file save location).
- Fall back to `allRoots[0]` (or active root) — no need to iterate integration workspaces.
- The provider is global — determine it from a single config load, not per-root.

#### 1.3 `ticketsRootChanged` handler — keep but simplify
**File:** `src/services/PlanningPanelProvider.ts:1690-1730`

This handler is still needed (the dropdown still exists for file-save context), but the config loading is redundant per-root. Load config once, not per-root. The provider preference (`_activeTicketsProvider`) should be a single global value, not a `Map<string, ...>`.

#### 1.4 `_activeTicketsProvider` — make global
**File:** `src/services/PlanningPanelProvider.ts:103`

Change from `Map<string, 'clickup' | 'linear'>` to a single `private _activeTicketsProvider: 'clickup' | 'linear' | null = null;`. Update all 6 usage sites (lines 1614, 1624, 1700, 1710, 1735):
- `this._activeTicketsProvider.get(root)` → `this._activeTicketsProvider`
- `this._activeTicketsProvider.set(root, x)` → `this._activeTicketsProvider = x`

#### 1.5 `fetchRoots` handler — send `integrationProviderStates` without workspace gating
**File:** `src/services/PlanningPanelProvider.ts:1607-1638`

The `integrationProviderStates` message currently carries `workspaceRoot` and the webview gates on it. Since the provider state is global, either:
- **Option A (preferred):** Remove the `workspaceRoot` field from `integrationProviderStates` and remove the webview guard at `planning.js:4203`. The message becomes a global state update.
- **Option B:** Keep `workspaceRoot` but always send `allRoots[0]` and ensure the webview's `ticketsWorkspaceRoot` is set before this arrives. More fragile.

Choose Option A — cleaner, matches the global config reality.

#### 1.6 Ticket message handlers — keep `workspaceRoot` for file-path context
All ticket message handlers (`clickupLoadSpaces`, `clickupLoadProject`, `linearLoadProject`, etc.) still receive `msg.workspaceRoot` and pass it to `_resolveWorkspaceRoot()`. **Keep this** — the workspace root is still needed for:
- Determining where to save imported ticket files (`ticketSaveLocation` in config, resolved relative to workspace).
- `LocalFolderService` operations (tickets folder paths are per-workspace in the DB).
- File watcher setup (`_setupTicketsViewWatcher(root)`).

The key change is that the **response** messages should not be gated by root-matching in the webview. The data (spaces, lists, tasks) is the same regardless of which root is used to fetch it.

### Phase 2: Webview — Remove race-protection for provider-state, keep for data messages

#### 2.1 Remove `integrationProviderStates` root guard
**File:** `src/webview/planning.js:4203`

Change:
```javascript
case 'integrationProviderStates':
    if (msg.workspaceRoot === ticketsWorkspaceRoot) {
```
To:
```javascript
case 'integrationProviderStates':
    {
        // Provider state is global — no workspace-root gate.
```

Remove the closing brace that matched the `if`. The entire handler body stays the same.

#### 2.2 Race-protection guard — narrow scope (Option B recommended)
**File:** `src/webview/planning.js:2766-2771`

The guard currently drops ALL tickets messages with mismatched roots. Since data messages (spaces, lists, tasks) are global, the root mismatch is not a real race condition for them — but it **is** real for per-root local-file messages.

**Recommended (Option B):** Keep the guard but narrow the guarded message list to only truly per-root messages. Remove data-fetch messages from `ticketsMsgTypes` (lines 2758-2764), keeping only:
- `localTicketFilesListed` — reads from per-workspace DB.
- `ticketSyncStatusesLoaded` — reads from per-workspace DB.

This preserves protection where it matters (local file state is per-root) while letting global data through.

**Option A (remove entirely):** Simpler but risks stale `localTicketFilesListed` from root A overwriting root B's file list after a rapid dropdown switch. Only choose if local-file scoping is confirmed unnecessary.

#### 2.3 `ticketsDefaultRoot` handler — keep for file-path context
**File:** `src/webview/planning.js:4169-4200`

Keep this handler — it sets `ticketsWorkspaceRoot` for file-save context. The root is still needed for `loadLocalTicketFiles()` and `listTicketsFolders`. But it no longer gates data fetching.

#### 2.4 `tickets-workspace-filter` dropdown — reframe as "Save Location"
**File:** `src/webview/planning.html:3330`

The dropdown is still useful (it determines where imported ticket files are saved), but its label is misleading. Consider relabeling to "Save to:" or keep as-is with a tooltip. The dropdown should always show all workspace folders, not just "integration workspaces" (since all roots now have the global integration).

#### 2.5 `updateTicketsWorkspacePicker()` — simplify
**File:** `src/webview/planning.js:5742-5793`

Since all roots have the same provider, the "no integrations" / "one integration" / "multiple" branching is no longer about integration availability — it's about workspace folder count. Simplify:
- 0 workspace folders: show "Configure Integration" (same as before).
- 1+ workspace folders: show dropdown with all folders (for save-location selection).
- The provider is determined globally, not per-workspace.

#### 2.6 Dropdown `change` handler — avoid redundant full reload
**File:** `src/webview/planning.js:5823-5836`

Currently switching the dropdown calls `saveTicketsState()` + `resetTicketsInMemoryState()` + `ticketsRootChanged` (which re-fetches provider state and re-loads data). With global config, the provider state and remote data are identical across roots — only the local-file list and save location change. **Clarification (implied by global config):** after the fix, the dropdown switch should still reset in-memory state (because local ticket files differ per root), but the backend `ticketsRootChanged` handler should skip the redundant `loadConfig()` / `integrationProviderStates` round-trip for remote data. The webview's `ticketsRootChanged` response handler should only refresh local files, not re-trigger `loadClickUpSpaces()`/`loadLinearProject()` unless the provider actually changed.

### Phase 3: `ticketsAutoSync` consistency

#### 3.1 Use global `ticketsAutoSync`
**File:** `src/services/PlanningPanelProvider.ts` (lines 1629, 1715, 1744)

`ticketsAutoSync` is stored in both:
- `GlobalIntegrationConfigService` (`~/.switchboard/integration-config.json`, line 10) — global.
- `LocalFolderService` per-workspace DB (`folders.paths` config, `ticketsAutoSync` field) — per-workspace.

The provider currently reads from `LocalFolderService.getTicketsAutoSync()` (per-workspace, sync). Since the setting is global, switch to `GlobalIntegrationConfigService.getTicketsAutoSync()` (async, returns `Promise<boolean>`). Update the three call sites to `await` the result.

**Migration:** If `GlobalIntegrationConfigService.getTicketsAutoSync()` returns `false` (the default when the key is undefined — note: `false` is ambiguous with "explicitly disabled"), check whether the global config *file* lacks the `ticketsAutoSync` key entirely (via `loadGlobal()` and `=== undefined`). If the key is absent, read from the **active root's** `LocalFolderService.getTicketsAutoSync()` (deterministic: active root, else first root alphabetically), and if `true`, write it to `GlobalIntegrationConfigService.setTicketsAutoSync(true)`. Per `CLAUDE.md` rules — published extension, must migrate. Do not delete `LocalFolderService.setTicketsAutoSync()` (kept for migration reads).

### Phase 4: State persistence cleanup

#### 4.1 `tickets.root` panel state — keep but reframe
**File:** `src/services/PanelStateStore.ts` / `PlanningPanelProvider.ts:1661`

The `tickets.root` persisted state stores which workspace folder was selected for file-save context. Keep this — it's still valid. But it no longer determines which integration is used (that's global).

#### 4.2 Per-root tickets navigation state — keep
The per-root navigation state (ClickUp space/folder/list selections, Linear project pick, search filters) stored via `persistTab('tickets', state, root)` is still valid — different workspace folders may have different file-save locations, and the user may want to remember their navigation per save-location. Keep this as-is.

## Files Changed

| File | Changes |
|------|---------|
| `src/services/PlanningPanelProvider.ts` | `_getIntegrationWorkspaces()` global check (preserve `buildWorkspaceItems` filter); `_activeTicketsProvider` → single value; `ticketsDefaultRoot` simplified; `ticketsRootChanged` simplified; `fetchRoots` `integrationProviderStates` without root gate; `ticketsAutoSync` from global config (async) |
| `src/webview/planning.js` | Remove `integrationProviderStates` root guard (4203); narrow race-protection guard to local-file-only messages (2766); `updateTicketsWorkspacePicker()` simplified; dropdown `change` handler skips redundant remote reload |
| `src/webview/planning.html` | Optional: relabel `tickets-workspace-filter` dropdown |
| `src/services/GlobalIntegrationConfigService.ts` | No changes (already global) |
| `src/services/LocalFolderService.ts` | No changes — `setTicketsAutoSync` kept for migration reads |

## Edge Cases

- **Single workspace folder:** Dropdown hidden, `ticketsWorkspaceRoot` = that root. No behavior change.
- **Zero workspace folders:** "Configure Integration" empty state. No behavior change.
- **Multiple workspace folders, global ClickUp configured:** Dropdown shows all folders for save-location. Data fetches work regardless of selection. Imported tickets save to the selected folder's `ticketSaveLocation`.
- **Mapped multi-root context (workspace identity mappings enabled):** `buildWorkspaceItems` returns parent mapping names, not individual folders. The fixed `_getIntegrationWorkspaces()` preserves this filter — dropdown shows mapped names, not raw roots.
- **`ticketsAutoSync` migration:** First run after this change — global key absent → read from active root's `LocalFolderService`, write to global if `true`, continue.
- **Per-root navigation restore:** Still works — `restoredTabState` per-root map is still consulted on root change.
- **NO confirmation dialogs** (project rule) — no new dialogs added.

## Verification Plan

### Automated Tests
- **Deferred to user per session directives.** The existing `kanban-linear-project-tab-regression.test.js` should be run by the user after implementation to confirm no regression in Linear project tab behavior. No unit/integration/e2e tests are run as part of this planning session.

### Build
- **Deferred to user per session directives.** `npm run compile` (webpack) is not run during this session. The implementer/user should run it after applying changes to confirm the build succeeds (especially the `async`/`await` changes for `ticketsAutoSync`).

### Static Checks (planner-verified, read-only)
1. `grep -n "msg.workspaceRoot !== ticketsWorkspaceRoot" src/webview/planning.js` → confirm the race guard is narrowed (only `localTicketFilesListed` / `ticketSyncStatusesLoaded` remain guarded) or removed per chosen option.
2. `grep -n "if (msg.workspaceRoot === ticketsWorkspaceRoot)" src/webview/planning.js` → 0 results (provider-states guard removed).
3. `grep -n "_activeTicketsProvider" src/services/PlanningPanelProvider.ts` → confirm 1 declaration (scalar) and no `.get(` / `.set(` Map calls remain.

### Manual Tests (user-run, after build)
4. Single workspace with ClickUp configured:
   - Open tickets tab → spaces/lists/tasks load immediately.
   - No "Dropping tickets message" console logs.
5. Multi-root workspace (switchboard + viaapp), global ClickUp:
   - Open tickets tab → data loads.
   - Switch dropdown between roots → data stays loaded (same global config); only save-location context changes.
   - Import a ticket → file saves to the selected root's `ticketSaveLocation`.
6. Linear configured globally:
   - Open tickets tab → Linear projects load.
   - Switch provider selector → ClickUp/Linear data loads correctly.
7. `ticketsAutoSync` migration: delete `~/.switchboard/integration-config.json` `ticketsAutoSync` key, set `folders.paths.ticketsAutoSync` in a workspace DB → reload → verify global config picks up the value.
8. Mapped multi-root context (workspace identity mappings enabled): verify dropdown shows mapped parent names, not raw workspace folder paths.

## Review Notes

- **Why not just fix `_getIntegrationWorkspaces()` to check per-workspace config files?** Because the config files no longer exist per-workspace — they were migrated to global. Checking for per-workspace files would return empty for everyone, breaking the feature entirely.
- **Why keep `ticketsWorkspaceRoot` at all?** File-save context. `LocalFolderService` and ticket file watchers are still per-workspace. The root determines where `.switchboard/tickets/` lives and where imported markdown files are written.
- **Why not remove the dropdown entirely?** Multi-root users need to choose where ticket files are saved. The dropdown is still functional for that purpose — it just no longer gates data fetching.
- **Why narrow the race guard (Option B) instead of removing it (Option A)?** `localTicketFilesListed` and `ticketSyncStatusesLoaded` read from per-workspace DB — a stale response from root A can overwrite root B's local file list after a rapid dropdown switch. Narrowing preserves protection where it matters.

## Recommendation

Complexity is 6 (mixed: majority routine mechanical edits, with two moderate well-scoped risks — the `buildWorkspaceItems` filter preservation and the race-guard narrowing). **Send to Coder.**
