# Global Settings Unification

## Goal
Make all user-configurable settings globally scoped across workspaces, with VS Code `globalState` as the primary source of truth and `kanban.db` as a mirror for cross-IDE import/export. Add a "Copy DB Settings to Global" button in `setup.html` for one-click migration of legacy per-workspace DB configs.

## Metadata
- **Tags:** frontend, backend, database, UX, reliability
- **Complexity:** 8
- **Recommendation:** Send to Lead Coder

## User Review Required
The following decisions change product behavior and should be confirmed before implementation:

1. **`planIngestionFolder` going global is risky.** It holds an *absolute* directory path that is validated with `fs.stat` in `handleSaveStartupCommands` (`TaskViewerProvider.ts:6899`). A global value set in workspace A (e.g. `/Users/me/repoA/plans`) will not exist when workspace B opens, producing a validation warning and an empty ingestion folder. **Recommend: keep `planIngestionFolder` per-workspace (DB-only), excluded from the global set.**
2. **`liveSyncConfig` going global is questionable.** Live-sync targets (ClickUp lists / Linear projects) are usually repo-specific. **Recommend: keep per-workspace unless the user explicitly wants one sync target shared across all repos.**
3. **One-time legacy migration is mandatory (see Complexity Audit / Edge-Case Audit).** Users who currently have the "Global Settings" toggle **OFF** hold their `roleConfig_*` prompt overrides and the six `kanban.*` keys **only in `workspaceState`**. The "Copy DB Settings to Global" button does NOT cover these (they are not DB-backed). Without an automatic activation-time migration, removing the toggle will silently hide these users' data. Confirm the migration approach in Phase 0.
4. **Loss of per-repo overrides is intentional.** After this change a user can no longer have different startup commands / visible agents / custom columns per repository. This is the stated Goal ("configure once, use in every repo") — confirm it is acceptable for all migrated keys.

## Complexity Audit

### Routine
- Removing the `global-settings-toggle` checkbox from `setup.html` and adding a "Copy DB Settings to Global" button (`setup.html:621-627`, `:3543`).
- Adding the `copyDbSettingsToGlobal` message case in `SetupPanelProvider.ts` (mirrors the existing `setGlobalSettingsEnabled` case at `:154`).
- Defining the canonical globalState key list (reuse, do not duplicate, `STATE_KEY_TO_CONFIG`).

### Complex / Risky
- **Data-loss migration (Phase 0).** Toggle-off users' `roleConfig_*` + `kanban.*` keys live only in `workspaceState`. Dropping the flag without a one-time `workspaceState → globalState` copy silently hides them. Highest-risk item.
- **Three undocumented parallel read/write paths** that the original plan missed and that will desync if not routed through globalState:
  - `KanbanProvider._saveStartupCommands()` (`KanbanProvider.ts:2393`), wired to the `saveStartupCommands` message (`:5868`) — a second writer for `startupCommands`, `visibleAgents`, `julesAutoSyncEnabled`, `autoCommitOnCodeReview`.
  - `KanbanProvider.getAutoCommitOnCodeReview()` (`:2388`) / `_getStartupCommands()` (`:2372`) — the *actual* primary read path that `TaskViewerProvider.handleGetAutoCommitOnCodeReviewSetting` delegates to (`:3328`).
  - `PlanningPanelProvider.ts:2397` — independently reads `switchboard.globalSettingsEnabled` to choose the store for `roleConfig_planner`.
- **Read-path write side-effects.** "Auto-sync on read" inside hot getters (`getVisibleAgents`/`getCustomAgents`, called every board render) risks a write-amplification loop via `notifyStateChanged() → refresh() → read → write`. Must be a one-time activation migration, not a per-getter side-effect.
- **Removal of `_globalSettingsEnabled`** touches `TaskViewerProvider`, `KanbanProvider` (`_isGlobalSettingsEnabled`, `_getSetting`, `_updateSetting`, `_reloadSettingsFromStore`, `onGlobalSettingsFlagChanged`), `SetupPanelProvider`, `PlanningPanelProvider`, and four test files.

## Edge-Case & Dependency Audit

### Race Conditions
- **Hot-getter write loop (must avoid):** `getVisibleAgents`/`getCustomAgents` run on every board render. A `globalState.update()` side-effect inside them can trigger `notifyStateChanged() → refresh()`, re-entering the getter. **Resolution: do the DB→globalState backfill once at activation (Phase 0), never inside a getter.**
- **Multi-window last-writer-wins:** `globalState` is shared across all VS Code windows; two windows writing the same key race. This is the *same* exposure the DB already has — `stateConfigBridge.ts:138` documents sql.js as last-writer-wins. Acceptable; do not add locking.
- **Batched `updateState` ordering:** `updateState` debounces 100ms and batches updaters (`TaskViewerProvider.ts:1633`). When a setter writes globalState *and* mirrors via `updateState`, the two stores are briefly out of sync within that window. Acceptable (both eventually consistent); ensure globalState is written first so reads (globalState-first) are never stale.

### Security
- No new external surface. Settings remain local to the user's VS Code profile. `globalState` is per-user, not synced unless the user enables Settings Sync.
- `copyDbSettingsToGlobal` only copies known keys from the current workspace DB; no arbitrary-key injection.

### Side Effects
- Removing the toggle changes behavior for existing toggle-off users — covered by Phase 0 migration.
- `planIngestionFolder`/`liveSyncConfig` global scope can surface stale absolute paths in unrelated workspaces (see User Review #1, #2).
- `getVisibleAgents` merges `defaults + customAgents-derived + state.visibleAgents`. `visibleAgents` and `customAgents` MUST migrate together — a partial migration (one global, one DB) loses custom-agent column visibility defaults.

### Dependencies & Conflicts
- **`stateConfigBridge` is the foundation, not a thing to build.** Both providers import `stateFs as fs` / `stateLockfile as lockfile` (`TaskViewerProvider.ts:3`, `KanbanProvider.ts:3`). Every `fs.promises.readFile(statePath)` already resolves to `kanban.db` config via `synthesizeStateJson()`. The DB read/write mirror **already exists** — this work only adds a globalState layer on top.
- **Reuse `STATE_KEY_TO_CONFIG`** (`stateConfigBridge.ts:15`) for any globalState-key → DB-config-key mapping. Do NOT create a second static table (`_mirrorSettingToDb`'s proposed map) — the bridge comment requires the mapping stay single-sourced (also referenced by `KanbanDatabase._runConfigMigrations`).
- Tests reference the flag: `src/test/kanban-persistence.test.ts`, `kanban-complexity.test.ts`, `kanban-timestamp-preserve.test.ts`, `src/services/__tests__/KanbanProvider.test.ts`. They will need updating once the API is removed (run separately by the user).

## Dependencies
- `sess_XXXXXXXXXXXXX — stateConfigBridge / KanbanDatabase config-table architecture` (the DB mirror this plan builds on)
- None other identified. No upstream session blocks this work.

## Adversarial Synthesis
**Key risks:** (1) silent data loss for toggle-off users whose `roleConfig_*`/`kanban.*` keys live only in `workspaceState` — not covered by the DB-copy button; (2) three parallel read/write paths (`KanbanProvider._saveStartupCommands`, `KanbanProvider.getAutoCommitOnCodeReview`, `PlanningPanelProvider.ts:2397`) the original scope missed, which desync if not routed through globalState; (3) write-amplification if globalState backfill runs inside hot getters. **Mitigations:** add a one-time activation migration (Phase 0) that copies `workspaceState` legacy keys → `globalState` before the flag is dropped; expand the file list and route every writer through globalState; perform DB→globalState backfill once at activation, never in a getter; reuse `STATE_KEY_TO_CONFIG` instead of a duplicate mapping table.

---

## Problem
- Agent configs (`visibleAgents`, `startupCommands`, `customAgents`, `customKanbanColumns`, `planIngestionFolder`, `autoCommitOnCodeReview`) live in each workspace's `kanban.db`
- Opening a new workspace starts with empty/default configs
- The "Global Settings" toggle only migrates prompt overrides (`switchboard.prompts.roleConfig_*`) and six kanban keys — nothing else
- Users expect "configure once, use in every repo" behavior

## Root Cause

### Where configs currently live
**Clarification:** `.switchboard/state.json` no longer exists on disk. `stateConfigBridge.ts` redirects every state-file read/write to the `kanban.db` `config` table via `STATE_KEY_TO_CONFIG`. Both providers import the bridged facade (`stateFs as fs`). So the per-workspace mapping is:
```
customKanbanColumns    → kanban.customColumns
customAgents           → agents.customAgents
startupCommands        → agents.startupCommands
visibleAgents          → agents.visibleAgents
defaultPromptOverrides → agents.promptOverrides
liveSyncConfig         → planning.liveSyncConfig
julesAutoSyncEnabled   → agents.julesAutoSyncEnabled
autoCommitOnCodeReview → kanban.autoCommitOnCodeReview
planIngestionFolder    → planning.ingestionFolder
```
(Source of truth: `stateConfigBridge.ts:15`.)

### Why the global toggle is broken
`TaskViewerProvider.getSetting()` / `updateSetting()` are the only methods that check `_globalSettingsEnabled` (`:565`, `:572`):
```typescript
public getSetting<T>(key: string, defaultValue: T): T {
    if (this._globalSettingsEnabled) {
        return this._context.globalState.get<T>(key, defaultValue);
    }
    return this._context.workspaceState.get<T>(key, defaultValue);
}
```
These methods only handle prompt overrides and `_MIGRATABLE_NON_ROLE_KEYS` (`kanban.cliTriggersEnabled`, `kanban.columnDragDropModes`, etc., `:701`).

Meanwhile, `getVisibleAgents()`, `getStartupCommands()`, `getCustomAgents()`, `getPlanIngestionFolder()` all call `_resolveStateFilePath()` → read the bridged state path (i.e. the DB) — completely bypassing the global toggle.

Same for saves: `handleSaveStartupCommands()`, `handleSaveCustomAgent()`, `updateState()` write only to the per-workspace DB.

**Clarification (missed paths):** `KanbanProvider` *also* reads and writes these configs directly via its own `_getCustomAgents`/`_getVisibleAgents`/`_getCustomKanbanColumns`/`_hasAssignedAgent` (DB reads) and `_saveStartupCommands` (`:2393`, DB write wired to the `saveStartupCommands` message at `:5868`). `KanbanProvider.getAutoCommitOnCodeReview` (`:2388`) is the primary auto-commit read path that `TaskViewerProvider.handleGetAutoCommitOnCodeReviewSetting` delegates to. `PlanningPanelProvider.ts:2397` independently reads `switchboard.globalSettingsEnabled` for `roleConfig_planner`.

## Solution

### Architecture
| Layer | Role | Scope |
|-------|------|-------|
| VS Code `globalState` | Primary source of truth | Global (all workspaces) |
| `kanban.db` config table | Mirror / export format (via existing `stateConfigBridge`) | Per-workspace (for cross-IDE import) |
| VS Code `workspaceState` | **Removed entirely** (after Phase 0 migration) | N/A |

### GlobalState keys
Reuse `STATE_KEY_TO_CONFIG` to map these globalState keys to their DB config keys (no duplicate table):
```
switchboard.agents.visibleAgents
switchboard.agents.startupCommands
switchboard.agents.customAgents
switchboard.agents.promptOverrides
switchboard.agents.julesAutoSyncEnabled
switchboard.kanban.customColumns
switchboard.kanban.autoCommitOnCodeReview
switchboard.planning.ingestionFolder      (see User Review #1 — consider excluding)
switchboard.planning.liveSyncConfig        (see User Review #2 — consider excluding)
```
Plus existing prompt keys (`switchboard.prompts.roleConfig_*`) and kanban keys (`kanban.cliTriggersEnabled`, etc.).

### Phase 0: One-time legacy migration (NEW — run at activation)
Before dropping the flag, migrate any legacy data so nothing is hidden:
1. On activation, if `switchboard.globalSettingsEnabled === false`, run the existing `_migrateWorkspaceStateToGlobal()` once (it already copies `_MIGRATABLE_NON_ROLE_KEYS` + discovered `roleConfig_*` keys from `workspaceState` → `globalState`).
2. Backfill the DB-backed config keys into `globalState` for the current workspace (DB→globalState), so first run after upgrade reflects existing per-workspace configs. Do this **once at activation**, never inside a getter.
3. Record a completion marker (e.g. `globalState.update('switchboard.settingsUnified.v1', true)`) so it does not re-run.

### Phase 1: Read path — TaskViewerProvider
Update these getters to read `globalState` first, fall back to the existing DB read (`fs.promises.readFile(statePath)` via the bridge). **No write side-effects inside getters** — backfill is Phase 0 only:
- `getVisibleAgents()` (`:3230`)
- `getStartupCommands()` (`:3183`)
- `getCustomAgents()` (`:3260`)
- `getPlanIngestionFolder()` (`:3216`)
- `handleGetAutoCommitOnCodeReviewSetting()` (`:3326`) — and its inline read in `handleGetStartupCommands` (`:3314-3322`)
- `_getDefaultPromptOverrides()` (`:6799`)
- `_getCustomKanbanColumns()` (`:3272`)

### Phase 2: Write path — TaskViewerProvider
Update these setters to write to `globalState` first, then mirror to DB (the existing `updateState()` call already writes the DB via the bridge — keep it as the mirror):
- `handleSaveStartupCommands()` (`:6876`) — also handles visibleAgents, customAgents, customKanbanColumns, planIngestionFolder, autoCommitOnCodeReview
- `handleSaveCustomAgent()` (`:7157`)
- `handleDeleteCustomAgent()` (`:7175`)
- `handleSaveDefaultPromptOverrides()` (`:7200`)
- `handleSaveKanbanStructure()` / `handleUpdateKanbanStructure()` (`:6826`, customKanbanColumns reordering) and `handleSaveKanbanColumn`/`handleDeleteKanbanColumn`/`handleToggleKanbanColumnVisibility`/`handleRestoreKanbanDefaults` (`:7071`–`:7155`)
- `saveRoleConfig()` (`:580`, already uses `updateSetting()`)

**Clarification:** prefer writing globalState then letting the existing `updateState()` serve as the DB mirror (it already maps state keys → DB via the bridge). If a dedicated helper is still wanted, name it `_mirrorSettingToDb(stateKey, value)` and have it derive the DB key from `STATE_KEY_TO_CONFIG[stateKey]` — do NOT introduce a parallel mapping table.

### Phase 3: Remove workspace-local scoping
- `getSetting()` (`:565`) → always read `globalState`
- `updateSetting()` (`:572`) → always write `globalState`, then mirror via existing path
- Remove `_globalSettingsEnabled` property (`:355`) and `setGlobalSettingsEnabled()` (`:536`), `getGlobalSettingsEnabled()` (`:532`)
- Remove `_migrateWorkspaceStateToGlobal()` and `_migrateGlobalStateToWorkspace()` (`:721`, `:732`) **only after Phase 0 reuses the former** — i.e. inline/retain the copy logic for the one-time migration, then drop the toggle-driven callers.
- Keep `_MIGRATABLE_NON_ROLE_KEYS` (`:701`) for reference but repurpose as "keys that should also be mirrored to DB"
- **KanbanProvider:** remove `_isGlobalSettingsEnabled()` (`:330`), simplify `_getSetting`/`_updateSetting` (`:334`, `:348`) to always use `globalState`, and keep `_reloadSettingsFromStore()` (`:356`) reading globalState. `onGlobalSettingsFlagChanged()` (`:324`) becomes dead — remove it and its caller.
- **PlanningPanelProvider.ts:2397** — drop the `globalSettingsEnabled` branch; always read `roleConfig_planner` from `globalState`.

### Phase 4: KanbanProvider compat
`KanbanProvider` has its own direct DB readers and a parallel writer. Route them through `TaskViewerProvider` so a single source of truth (globalState) governs all access:
```typescript
private async _getCustomAgents(workspaceRoot: string): Promise<CustomAgentConfig[]> {
    // currently reads bridged state.json (DB) directly — KanbanProvider.ts:3306
}
```
- Replace `_getCustomAgents()` (`:3306`) → `this._taskViewerProvider?.getCustomAgents()`
- Replace `_getVisibleAgents()` (`:3476`) → `this._taskViewerProvider?.getVisibleAgents()`
- Replace `_getCustomKanbanColumns()` (`:428`) → `this._taskViewerProvider?.handleGetCustomKanbanColumns()`
- Replace `_hasAssignedAgent()` (`:3508`) startup-command read → `this._taskViewerProvider?.getStartupCommands()`
- **Route `_saveStartupCommands()` (`:2393`) and `getAutoCommitOnCodeReview()`/`_getStartupCommands()` (`:2388`, `:2372`) through `TaskViewerProvider`** (e.g. `handleSaveStartupCommands` / `handleGetStartupCommands`) so the `saveStartupCommands`/`getStartupCommands` message handlers (`:5861-5873`) do not write/read the DB independently of globalState.

### Phase 5: Setup UI
In `setup.html` Multi-Repo tab (`global-settings-toggle` at `:621-627`, listener at `:3543`):
- Remove the "Global Settings" checkbox and its description
- Remove the `setGlobalSettingsEnabled` listener (`:3543`) and the `globalSettingsEnabled` message handler (`:3904`)
- Add a button: **"Copy DB Settings to Global"**
- On click, post message `copyDbSettingsToGlobal` to the extension
- Show status: "Copied N settings to global" or "No DB settings found"

In `SetupPanelProvider.ts`, replace the `setGlobalSettingsEnabled`/`getGlobalSettingsEnabled` cases (`:154`–`:161`) with a `copyDbSettingsToGlobal` case that calls `TaskViewerProvider.copyDbSettingsToGlobal()`.

Add `copyDbSettingsToGlobal()` method to `TaskViewerProvider` that:
1. Reads the current workspace DB config values — via the existing getters (`getVisibleAgents`, `getCustomAgents`, `getStartupCommands`, `getPlanIngestionFolder`, `handleGetCustomKanbanColumns`, `_getDefaultPromptOverrides`) or `KanbanDatabase.forWorkspace(root).getConfigJson(configKey)`. **(`_readDbState()` does not exist — do not reference it.)**
2. For each key in `STATE_KEY_TO_CONFIG`, writes the DB value to the corresponding `switchboard.*` `globalState` key.
3. Returns a summary `{ copied: number }` of what was copied.

### Phase 6: Runtime state stays local
These keys are NOT migrated to global — they are per-workspace runtime state (already DB-only via the bridge; see `STATE_KEY_TO_CONFIG` runtime.* entries):
```
terminals, chatAgents, session, context, teams, tasks,
julesSessions, julesPollingDegraded, julesPollingLastCheckedAt,
julesPollingDegradedAt, autoban
```
`updateState()` continues to write these to DB only.

## Proposed Changes

### src/services/TaskViewerProvider.ts
- **Context:** Owns the canonical getters/setters and the (to-be-removed) `_globalSettingsEnabled` flag. `fs`/`lockfile` here are the `stateConfigBridge` facades, so existing reads/writes already hit `kanban.db`.
- **Logic:** Add globalState-first reads (Phase 1), globalState-write + DB-mirror writes (Phase 2), a one-time activation migration (Phase 0), `copyDbSettingsToGlobal()` (Phase 5), and remove the flag + toggle methods (Phase 3).
- **Implementation:** Getters at `:3183`–`:3340`, `:3272`, `:6799`; setters at `:6876`, `:7157`, `:7175`, `:7200`, `:6826`, `:7071`–`:7155`; flag at `:355`/`:389`/`:532`–`:578`; migration helpers `:721`/`:732`.
- **Edge Cases:** No write side-effects inside getters; migrate `visibleAgents`+`customAgents` together; write globalState before DB mirror to avoid stale globalState-first reads.

### src/services/KanbanProvider.ts
- **Context:** Has parallel direct-DB readers and a parallel writer (`_saveStartupCommands`) plus its own flag branching.
- **Logic:** Replace direct DB reads with `TaskViewerProvider` calls; route `_saveStartupCommands`/`getStartupCommands` message handlers through `TaskViewerProvider`; simplify `_getSetting`/`_updateSetting` to always-globalState; remove `_isGlobalSettingsEnabled`/`onGlobalSettingsFlagChanged`.
- **Implementation:** `:324`, `:330`, `:334`, `:348`, `:356`, `:428`, `:2372`, `:2388`, `:2393`, `:3306`, `:3476`, `:3508`, `:5861`–`:5873`.
- **Edge Cases:** Guard `this._taskViewerProvider?` (already nullable); board renders call these getters frequently — ensure delegated getters stay read-only.

### src/services/PlanningPanelProvider.ts
- **Context:** Independently gates `roleConfig_planner` store selection on `switchboard.globalSettingsEnabled` (`:2397`).
- **Logic:** Always read from `globalState`; remove the flag branch.
- **Edge Cases:** Default of the removed read was `true` (globalState), so behavior is unchanged for default users.

### src/services/SetupPanelProvider.ts
- **Context:** Message router for the setup panel; currently handles `setGlobalSettingsEnabled`/`getGlobalSettingsEnabled` (`:154`–`:161`).
- **Logic:** Replace those cases with a `copyDbSettingsToGlobal` case delegating to `TaskViewerProvider.copyDbSettingsToGlobal()` and posting a result summary.
- **Edge Cases:** Post a clear "no DB settings found" result when the count is 0.

### src/webview/setup.html
- **Context:** Multi-Repo tab toggle (`:621-627`), change listener (`:3543`), inbound `globalSettingsEnabled` handler (`:3904`).
- **Logic:** Remove toggle + listener + handler; add "Copy DB Settings to Global" button, its click→`copyDbSettingsToGlobal` postMessage, and a status line bound to the result message.
- **Edge Cases:** Show copied-count feedback; disable the button briefly while the copy is in flight to avoid double-posts.

## Validation
1. Open workspace A, create custom agent "my-agent", set its startup command, toggle visibility
2. Open workspace B, verify "my-agent" appears with the same command and visibility
3. In workspace B, change a startup command, verify workspace A sees the change
4. In a fresh workspace C (no `.switchboard` dir / no DB), verify all agent configs appear from global state
5. Click "Copy DB Settings to Global" in setup.html on a workspace with legacy DB-only settings, verify they migrate and the count is reported
6. Export `.switchboard/kanban.db`, open in another IDE, verify configs are readable
7. **Migration:** Simulate a toggle-off user (set `switchboard.globalSettingsEnabled=false`, write `roleConfig_coder` to `workspaceState`), upgrade, and verify the prompt override survives in `globalState` after activation
8. **No write loop:** Open the Kanban board with many cards and confirm no repeated `notifyStateChanged → refresh` cycle is triggered by reads (getters stay read-only)

## Verification Plan

> Per session directive: do NOT run compilation (`tsc`) or the automated test suite as part of this verification — they are run separately by the user. The items below describe the intended test coverage; author the tests but leave execution to the user.

### Automated Tests
- **Read fallthrough:** `getVisibleAgents`/`getStartupCommands`/`getCustomAgents` return `globalState` when present, fall back to DB when globalState is empty, and perform NO `globalState.update` during a read.
- **Write mirror:** `handleSaveStartupCommands`/`handleSaveCustomAgent`/`handleSaveDefaultPromptOverrides` write the `switchboard.*` `globalState` key AND mirror to the DB config key (assert both stores via mocked `globalState` + `KanbanDatabase`).
- **Phase 0 migration:** with `globalSettingsEnabled=false` and a `roleConfig_*` key only in `workspaceState`, activation copies it to `globalState` and sets the completion marker; a second activation is a no-op.
- **`copyDbSettingsToGlobal`:** copies each `STATE_KEY_TO_CONFIG` key's DB value to the matching globalState key and returns the correct count; returns 0 with no DB settings.
- **KanbanProvider delegation:** `_getCustomAgents`/`_getVisibleAgents`/`_getCustomKanbanColumns`/`_hasAssignedAgent` and the `saveStartupCommands` handler invoke the `TaskViewerProvider` methods rather than touching the DB directly.
- **Flag removal regressions:** update `src/test/kanban-persistence.test.ts`, `kanban-complexity.test.ts`, `kanban-timestamp-preserve.test.ts`, `src/services/__tests__/KanbanProvider.test.ts` to drop `globalSettingsEnabled` assumptions; they must pass without the removed API.

---

**Recommendation:** Complexity 8 → **Send to Lead Coder.**
