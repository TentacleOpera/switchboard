# DB Settings Sync — Optionally Persist VS Code Settings to Kanban DB

## Goal

Add an **optional DB sync** mode so that Switchboard VS Code extension settings (status bar toggles, theme, CLI config, plan scanner, polling, workflow toggles, etc.) are mirrored to the workspace `kanban.db`, enabling cross-IDE consistency (VS Code, Cursor, Windsurf) for users who share `.switchboard/` across IDEs.

### Core Problem
All Switchboard VS Code extension settings (status bar toggles, theme, CLI config, plan scanner, polling, etc.) are stored exclusively in the VS Code settings store (`vscode.workspace.getConfiguration()`). This store is per-IDE and per-workspace — there is no cross-IDE sync. Users who run Switchboard in multiple IDEs (VS Code, Cursor, Windsurf) see different status bar layouts, different themes, different scanner configs, etc., even though their kanban data and plan files are shared via `.switchboard/kanban.db`.

### Background
- Kanban state (cards, columns, epics, workspace mappings) already lives in `kanban.db` (SQLite) and syncs across IDEs via shared `.switchboard/` folder or cloud-synced DB paths.
- Plan files live in `.switchboard/plans/*.md` — also shared.
- The Setup panel already has a "PROMPT SETTINGS EXPORT / IMPORT" section (`src/webview/setup.html` line 638) that manually writes/reads `.switchboard/settings.json`. **Clarification:** this existing mechanism is NARROW — `exportPromptSettings()`/`importPromptSettings()` in `src/services/TaskViewerProvider.ts` (lines 627–719) only serializes `switchboard.prompts.roleConfig_*` keys held in `globalState`/`workspaceState`, NOT the 73 VS Code config settings. It is a manual one-shot sync for prompt role configs only, not a general settings sync.

### Root Cause
Settings were implemented as standard VS Code extension settings (`package.json` configuration schema + `vscode.workspace.getConfiguration().update()`). No DB-backed alternative was built. The existing export/import is manual, prompt-role-only, and only covers a separate storage layer (extension Memento state, not VS Code config).

## Metadata

**Tags:** backend, database, feature, refactor, reliability
**Complexity:** 7
**Repo:** (single-repo — no sub-repo)

## User Review Required

Yes — before implementation, the reviewer must confirm three scope decisions documented in **Scope Clarifications** below:
1. Whether prompt role configs (`globalState`/`workspaceState`) are IN or OUT of DB sync scope.
2. Whether `Global`-scoped settings (persistPanels, memo.hotkey) are synced to workspace DBs or excluded.
3. Whether `dbSyncEnabled` should default ON (opt-out) or OFF (opt-in) given the ~4,000 published installs.

## Scope Clarifications (require user decision)

The plan as originally written says "all 73 settings" and "intercept all `config.update()` calls in `handleSet*Setting`." Code inspection reveals three scope ambiguities that must be resolved before coding:

1. **Prompt role configs live in Memento state, not VS Code config.** `exportPromptSettings()` reads from `context.globalState`/`workspaceState` (keys prefixed `switchboard.prompts.roleConfig_`), and `saveRoleConfig()` writes there — these NEVER go through `config.update()`. The "intercept `config.update()`" strategy will NOT capture them. Decision needed: (a) keep role configs out of DB sync (simplest; they remain IDE-local), or (b) extend `SettingsSyncService` to also wrap `saveRoleConfig`/`getRoleConfig` so prompt role configs sync too. Option (b) is more useful for cross-IDE users but adds a second storage layer to manage.

2. **Mixed `ConfigurationTarget` scopes.** `config.update()` calls in the codebase use three different targets:
   - `Workspace` — the majority (statusBar.*, theme.*, preventAgentFileOpening, ignoreStrategy/Rules, accurateCoding.enabled, etc.)
   - `Global` — `persistPanels` (`SetupPanelProvider.ts:593`), `memo.hotkey` (`SetupPanelProvider.ts:688`)
   - `WorkspaceFolder` — `planning.enabledSources` (`SetupPanelProvider.ts:793`), `kanban.controlPlaneRoot` (`SetupPanelProvider.ts:1308`), `research.localFolderPath` (`LocalFolderService.ts`)
   Writing a `Global` setting into a per-workspace `kanban.db` is semantically wrong (a global toggle would desync across workspaces). Recommendation: **DB sync only `Workspace`-scoped settings**; skip `Global` and `WorkspaceFolder` settings (they're inherently local). Document this in the Setup panel UI.

3. **Default ON vs OFF.** Plan specifies `dbSyncEnabled` default `true`. For ~4,000 existing installs, upgrading would silently start writing a `settings`/`config` table to their `kanban.db` on first setting change, and the one-time bulk-push migration (see Edge Cases) would push all their current settings into the DB on first activation. Recommendation: **default OFF** to avoid surprise writes to existing users' shared DBs; new users can opt in. If default ON is kept, the bulk-push migration must be gated behind an explicit "Import current settings to DB" button rather than running automatically on activation.

## Solution

When enabled via a checkbox in the Setup panel, Switchboard VS Code settings (scoped per the clarifications above) are automatically mirrored to the active workspace `kanban.db`. This is a one-way sync (VS Code → DB) on write, and a one-way restore (DB → VS Code) on activation. The manual export/import buttons remain as-is.

### UX Changes

1. **Rename the Setup panel section** currently titled "PROMPT SETTINGS EXPORT / IMPORT" (`src/webview/setup.html` line 638) to **"SAVE SETTINGS TO DATABASE"** (or similar).
2. **Add a checkbox** in that section: "Sync VS Code settings to Kanban database" — default per Scope Clarification #3.
   - When checked: every setting write via `config.update()` (for in-scope settings) also writes to the active workspace `kanban.db`.
   - When unchecked: settings stay VS Code-only (current behavior).
3. **Keep the existing Export / Import buttons** below the checkbox. They continue to write/read `.switchboard/settings.json` for prompt role configs as a manual fallback.
4. **Add a one-line scope note** under the checkbox: "Syncs workspace-scoped settings (status bar, theme, workflow toggles). Global and per-folder settings are not synced."

### DB Schema

**Clarification — reuse existing `config` table.** `kanban.db` already has a `config` table (`KanbanDatabase.ts:147`): `key TEXT PRIMARY KEY, value TEXT NOT NULL`. It is used for `workspace_id`, `stitch.manifest`, and workspace mappings. Rather than adding a duplicate `settings` table, **reuse `config` with a namespaced key prefix** `setting.*` (e.g. `setting.statusBar.showKanbanButton`). This avoids a new table, a new migration, and a parallel read/write path. The existing `getConfigValue`/`setConfigValue` helpers (`KanbanDatabase.ts:3150`, `:3162`) can be reused directly.

If a separate `updated_at` column is required for last-write-wins conflict resolution, add it via a one-time `ALTER TABLE config ADD COLUMN updated_at TEXT` migration (gated by column-existence check, matching the existing migration pattern at `KanbanDatabase.ts:253`). Store `updated_at` only for `setting.*` rows; other config rows leave it NULL.

```sql
-- Reuse existing config table. Setting rows use the 'setting.' key prefix.
-- Optional column for conflict resolution:
ALTER TABLE config ADD COLUMN updated_at TEXT;  -- one-time migration, guarded
```

A single row per setting key. Value is JSON-encoded to handle all types (boolean, string, integer, array, object).

### Sync Logic

#### Write path (VS Code → DB)
- Intercept in-scope `config.update('switchboard.*', ...)` calls via a **SettingsSyncService** that wraps the update. All existing setting-write call sites route through it (see **Files to Modify** for the full list — it is NOT only `handleSet*Setting` in `TaskViewerProvider`).
- When DB sync is enabled, after writing to VS Code config, upsert into the `config` table of the **active workspace** `kanban.db` with key `setting.<dotpath>` and JSON-encoded value.
- When DB sync is disabled, only write to VS Code config (current behavior).
- **Multi-DB note:** the original plan said "write to every known `kanban.db`." Since scope is now limited to `Workspace`-scoped settings (Clarification #2), write only to the active workspace's DB. Multi-DB fan-out is unnecessary for workspace-scoped settings and avoids the partial-write atomicity problem. (Control Plane DBs hold kanban state, not settings.)

#### Read path (DB → VS Code, on activation)
- On extension activation, if DB sync is enabled:
  - Read all `setting.*` rows from the `config` table of the active workspace's `kanban.db`.
  - For each row, call `config.update(key, value, ConfigurationTarget.Workspace)` to restore the VS Code setting.
  - This runs once at startup, before `updateStatusBarVisibility()` and other config-dependent init.
  - **Guard against feedback loop:** set an `_isRestoring` flag during restore so the `onDidChangeConfiguration` listener (below) skips syncing back to DB for changes the restore itself caused.
- If DB sync is disabled, skip this entirely.

#### Sync enable/disable toggle itself
- The "Sync VS Code settings to Kanban database" checkbox state is stored as a VS Code setting (`switchboard.settings.dbSyncEnabled`, default per Clarification #3) AND in the DB `config` table (key `setting.settings.dbSyncEnabled`) so it survives across IDEs once enabled on one.

#### Configuration-change listener
- `extension.ts` already registers multiple `onDidChangeConfiguration` listeners (lines 547, 1146, 2108). Add a new listener (or extend the existing one at line 2108) that, when DB sync is enabled and `_isRestoring` is false, syncs any in-scope `switchboard.*` change to the DB. This catches settings changed via the VS Code Settings UI, not just the Setup panel.
- **Avoid duplicate work:** the listener must check `e.affectsConfiguration('switchboard.')` and only sync keys that are in the syncable set (workspace-scoped, not the `dbSyncEnabled` toggle itself to avoid a self-trigger).

### Files to Modify

**Clarification — `config.update()` call sites are spread across 4 files, not just `TaskViewerProvider.handleSet*Setting`.** All in-scope call sites must route through `SettingsSyncService` or the listener-based path will be the only catch-all (which is acceptable but means the wrapper is redundant — pick one primary mechanism).

| File | Change |
|------|--------|
| `package.json` | Add `switchboard.settings.dbSyncEnabled` (boolean, default per Clarification #3, scope `window`). |
| `src/services/SettingsSyncService.ts` | **NEW** — manages DB read/write of settings; wraps `config.update()` for in-scope settings; exposes `restoreFromDb()`, `syncToDb(key, value)`, `isEnabled()`. Holds the `_isRestoring` guard flag. |
| `src/services/TaskViewerProvider.ts` | 14 `config.update()` call sites (lines 4064, 4073, 4082, 4091, 4100, 4109, 4118, 4127, 4136, 4145, 4154, 4163, 4386, 4387, 4415) — route through `SettingsSyncService`. |
| `src/services/KanbanProvider.ts` | 7 `config.update()` call sites in `_savePromptsConfig` (lines 3675–3693) — route through `SettingsSyncService`. |
| `src/services/SetupPanelProvider.ts` | `Workspace`-scoped call sites (lines 606 `protocol.target`, + 2 others at 793/1308 are `WorkspaceFolder` — skip those). `persistPanels` (593) and `memo.hotkey` (688) are `Global` — skip per Clarification #2. Add `setDbSyncEnabled` message handler. |
| `src/services/LocalFolderService.ts` | `research.localFolderPath` (line 71) is `WorkspaceFolder`-scoped — skip per Clarification #2. |
| `src/extension.ts` | On activation: instantiate `SettingsSyncService`, call `restoreFromDb()` if sync enabled (before `updateStatusBarVisibility()`). Add/extend `onDidChangeConfiguration` listener (near line 2108) to sync external changes to DB. The `preventAgentFileOpening` toggle at line 1772 should also route through the service. |
| `src/webview/setup.html` | Rename section heading (line 638), add checkbox + scope note, keep existing export/import buttons (lines 643–644). |
| `src/services/KanbanDatabase.ts` | Add guarded `ALTER TABLE config ADD COLUMN updated_at TEXT` migration (only if column missing). No new table. |

### Edge Cases

- **Multiple kanban DBs / Control Plane:** With scope limited to `Workspace`-scoped settings, only the active workspace DB is written. No fan-out needed. (Original plan's "write to all known DBs" is dropped as unnecessary for workspace-scoped settings.)
- **DB not yet created:** If `kanban.db` doesn't exist yet (fresh workspace), skip DB sync until it's created. The `config` table already exists on every DB (created at `KanbanDatabase` init), so no lazy table creation needed — only the optional `updated_at` column migration.
- **Conflict between IDEs:** If two IDEs write different values, last-write-wins via `updated_at` timestamp (if column present) or last-upsert-wins without it. On activation, the DB value always wins (restores into VS Code config).
- **Setting changed via VS Code Settings UI:** The `onDidChangeConfiguration` listener catches external changes and syncs them to DB if sync is enabled and `_isRestoring` is false.
- **Feedback loop on restore:** `_isRestoring` flag prevents the activation-time restore from re-syncing back to the DB it just read from.
- **Migration for existing users (bulk push):** On first activation with `dbSyncEnabled = true` and no `setting.*` rows in the DB, do a one-time bulk push of current in-scope VS Code settings into the DB. **The key list must be hardcoded** in `SettingsSyncService` (derived from `package.json` configuration schema) because the VS Code API does not expose "all settings of an extension." This list is a maintenance burden — it must be updated when new settings are added to `package.json`. Per Clarification #3, if default is ON, gate this bulk push behind an explicit button rather than auto-running on activation.
- **Deprecation:** `switchboard.workspaceDatabaseMappings` is already deprecated (mappings moved to DB). No change needed there.
- **Per-DB write failure:** If the DB write fails (locked, corrupt, missing), log and continue — the VS Code config write must still succeed. Wrap DB writes in try/catch per call.

### What Does NOT Change

- The manual Export/Import to `.switchboard/settings.json` stays exactly as-is — it's a separate mechanism for prompt role configs (Memento state), not VS Code config settings.
- The `package.json` configuration schema stays — settings are still declared as VS Code extension settings so they appear in the Settings UI and the Setup panel can read/write them. DB sync is an additional layer, not a replacement.
- Kanban data, plan files, epics, workspace mappings — untouched.
- `Global`-scoped and `WorkspaceFolder`-scoped settings are NOT synced (per Clarification #2).

## Complexity Audit

### Routine
- Adding `dbSyncEnabled` boolean to `package.json` configuration schema.
- Renaming the Setup panel section heading and adding a checkbox + scope note in `setup.html`.
- Wiring the `setDbSyncEnabled` message handler in `SetupPanelProvider`.
- Reusing the existing `config` table `getConfigValue`/`setConfigValue` helpers for DB reads/writes.
- The guarded `ALTER TABLE config ADD COLUMN updated_at` migration (matches existing migration patterns).

### Complex / Risky
- **Enumerating and routing all 21+ `config.update()` call sites across 4 files** (TaskViewerProvider, KanbanProvider, SetupPanelProvider, extension.ts) through `SettingsSyncService` — missing one means that setting silently doesn't sync. The `onDidChangeConfiguration` listener is the safety net, but only if it correctly identifies in-scope keys.
- **Hardcoded key list for bulk-push migration** — must be kept in sync with `package.json` schema or it drifts; no VS Code API to enumerate extension settings.
- **Feedback-loop guard (`_isRestoring`)** — must be set/cleared correctly around the activation restore or the listener will redundantly write back to the DB it just read from (and, if the guard is wrong, could loop on every activation).
- **Default-ON behavior change for ~4,000 existing installs** — silently starts writing to shared `kanban.db` files; migration concern per AGENTS.md.
- **Scope boundaries (Global vs Workspace vs WorkspaceFolder)** — getting this wrong means a global toggle desyncs across workspaces or a per-folder setting leaks into the wrong workspace's DB.

## Edge-Case & Dependency Audit

- **Race Conditions:** Two IDEs writing the same setting simultaneously — last-write-wins via `updated_at` (or last-upsert-wins). Acceptable for v1; no locking. Activation restore is single-threaded per IDE.
- **Security:** Settings stored in `kanban.db` are not encrypted. No secrets are among the 73 settings (verified — they're toggles, theme names, paths, prompt configs). No new attack surface. The `dbSyncEnabled` toggle itself is not security-sensitive.
- **Side Effects:** Activation restore mutates VS Code config (`ConfigurationTarget.Workspace`) — this writes to the workspace `.vscode/settings.json` if the user has one, or to the workspace state. This is a visible side effect: enabling sync on IDE B will overwrite IDE A's workspace settings on IDE B's next activation. Document this in the UI.
- **Dependencies & Conflicts:** Reuses existing `config` table — no schema conflict. The `ALTER TABLE ... ADD COLUMN updated_at` is additive and guarded. No dependency on other plans. The `onDidChangeConfiguration` listener must coexist with the three existing listeners in `extension.ts` (lines 547, 1146, 2108) without duplicate work.

## Dependencies

- None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) the "intercept all `config.update()`" strategy misses call sites outside `TaskViewerProvider` and misses prompt role configs stored in Memento state — the `onDidChangeConfiguration` listener is the only real catch-all and must be the primary mechanism, not the wrapper; (2) default-ON for ~4,000 published installs silently writes to shared `kanban.db` files and auto-runs a bulk-push migration — should default OFF or gate the bulk push behind a button; (3) mixing `Global`/`WorkspaceFolder` settings into a per-workspace DB is semantically wrong and must be scoped out. Mitigations: make the listener the primary sync path (wrapper is a convenience), default OFF or gate the bulk push, and restrict scope to `Workspace`-scoped settings only.

## Proposed Changes

### `package.json`
- **Context:** VS Code extension manifest; declares the `switchboard.*` configuration schema (~106 `switchboard.` references).
- **Logic:** Add a new boolean setting `switchboard.settings.dbSyncEnabled` to the `configuration` section, with `default` per Scope Clarification #3, `scope: "window"`, and a description noting it mirrors workspace-scoped settings to `kanban.db`.
- **Implementation:** Add the entry alongside the existing `switchboard.settings.*` group (if one exists) or create it.
- **Edge Cases:** None — additive schema change, no migration for existing users (they get the default).

### `src/services/SettingsSyncService.ts` (NEW)
- **Context:** New service instantiated once in `extension.ts` activate() and shared with `TaskViewerProvider`, `KanbanProvider`, `SetupPanelProvider`.
- **Logic:**
  - `isEnabled(): boolean` — reads `switchboard.settings.dbSyncEnabled`.
  - `async updateSetting(key: string, value: unknown, target: ConfigurationTarget): Promise<void>` — wraps `config.update()`; if `target === Workspace` and `isEnabled()` and `!_isRestoring`, also upserts to the active workspace `kanban.db` `config` table with key `setting.${key}` and JSON-encoded value. Per-DB write failure is caught and logged.
  - `async restoreFromDb(): Promise<void>` — sets `_isRestoring = true`, reads all `setting.*` rows from the active workspace DB, calls `config.update(key, JSON.parse(value), ConfigurationTarget.Workspace)` for each, then clears `_isRestoring`.
  - `async bulkPushCurrentSettings(): Promise<void>` — one-time migration; iterates the hardcoded in-scope key list, reads each from VS Code config, upserts to DB. Gated behind explicit button if default is ON.
  - `isInScope(key: string, target: ConfigurationTarget): boolean` — returns `true` only for `Workspace`-targeted `switchboard.*` keys (excluding `settings.dbSyncEnabled` itself).
  - Hardcoded `SYNCABLE_KEYS: string[]` — derived from `package.json` schema, workspace-scoped only.
- **Implementation:** Use the existing `KanbanDatabase.forWorkspace(root)` pattern to get the active DB; reuse `getConfigValue`/`setConfigValue` (`KanbanDatabase.ts:3150/3162`) with `setting.`-prefixed keys.
- **Edge Cases:** DB missing → skip silently. DB locked → catch, log, continue. `_isRestoring` must be cleared in a `finally` block.

### `src/services/TaskViewerProvider.ts`
- **Context:** 14 `config.update()` call sites (lines 4064–4415) for status bar toggles, theme, ignore strategy/rules.
- **Logic:** Replace each `await config.update(key, value, vscode.ConfigurationTarget.Workspace)` with `await this._settingsSyncService.updateSetting(key, value, vscode.ConfigurationTarget.Workspace)`. The service handles the DB mirror internally.
- **Implementation:** Inject `SettingsSyncService` via constructor or setter (the provider is already instantiated in `extension.ts`).
- **Edge Cases:** The `handleSetIgnoreStrategySetting`/`handleSetIgnoreRulesSetting` (lines 4386–4387) write two keys in one method — both route through the service.

### `src/services/KanbanProvider.ts`
- **Context:** `_savePromptsConfig` (lines 3671–3697) writes 7 workflow-toggle settings via `config.update(..., true)` (the `true` is `ConfigurationTarget.Workspace`).
- **Logic:** Route each through `SettingsSyncService.updateSetting`.
- **Implementation:** Inject the service into `KanbanProvider`.
- **Edge Cases:** The `true` argument is `ConfigurationTarget.Workspace` (numeric 1) — confirm the service treats it as in-scope.

### `src/services/SetupPanelProvider.ts`
- **Context:** 6 `config.update()` call sites; mixed scopes.
- **Logic:** Route only the `Workspace`-scoped calls (line 606 `protocol.target`, and any others that are `Workspace`) through the service. Skip `persistPanels` (593, `Global`), `memo.hotkey` (688, `Global`), `planning.enabledSources` (793, `WorkspaceFolder`), `kanban.controlPlaneRoot` (1308, `WorkspaceFolder`). Add a `setDbSyncEnabled` message handler that calls `SettingsSyncService.updateSetting('settings.dbSyncEnabled', value, Workspace)` (which writes to both VS Code config and DB).
- **Implementation:** Add the message case alongside existing handlers (lines 156–163).
- **Edge Cases:** The `dbSyncEnabled` write itself goes through the service — ensure the service doesn't skip it as "out of scope" (it's the toggle, explicitly in-scope for persistence).

### `src/extension.ts`
- **Context:** Activation entry point; already has 3 `onDidChangeConfiguration` listeners (547, 1146, 2108).
- **Logic:**
  - Instantiate `SettingsSyncService` early in `activate()` (after `kanbanProvider` is created, before `updateStatusBarVisibility()`).
  - If `isEnabled()`, call `await settingsSyncService.restoreFromDb()` before config-dependent init.
  - Extend the listener at line 2108 (or add a new one) to sync in-scope `switchboard.*` changes to DB when `isEnabled()` and `!_isRestoring`.
  - Route the `preventAgentFileOpening` toggle at line 1772 through the service.
- **Implementation:** Add the listener in the same `context.subscriptions.push` pattern.
- **Edge Cases:** The restore must complete before the existing listeners at 2108 fire for the restored keys — since restore runs synchronously before those listeners are registered (or the `_isRestoring` guard handles it), this is safe.

### `src/webview/setup.html`
- **Context:** Setup panel; "PROMPT SETTINGS EXPORT / IMPORT" section at line 638.
- **Logic:** Rename heading to "SAVE SETTINGS TO DATABASE"; add a checkbox `id="db-sync-toggle"` with label "Sync VS Code settings to Kanban database" and a one-line scope note; keep the existing Export/Import buttons (643–644) below.
- **Implementation:** Add a `change` listener on the checkbox that posts `{ type: 'setDbSyncEnabled', value: checked }`.
- **Edge Cases:** The checkbox state must be hydrated on panel open from `switchboard.settings.dbSyncEnabled`.

### `src/services/KanbanDatabase.ts`
- **Context:** Schema definition and migrations.
- **Logic:** Add a guarded `ALTER TABLE config ADD COLUMN updated_at TEXT` migration (check column existence first, matching the pattern at line 253). No new table.
- **Implementation:** Add to the migration array applied at DB init.
- **Edge Cases:** Existing DBs without the column get it added; new DBs include it in the base schema.

## Verification Plan

### Automated Tests
- **Skipped per session directive.** The test suite will be run separately by the user.

### Manual Verification (no compile, no automated tests)
1. **Schema migration:** Open a pre-existing `kanban.db` (from a released version) in a SQLite browser; confirm the `config` table exists and that after activation with the new build, the `updated_at` column is present without data loss.
2. **Write path:** With `dbSyncEnabled = true`, toggle a status bar setting in the Setup panel; confirm a `setting.statusBar.*` row appears in the active workspace `kanban.db` `config` table with the correct JSON-encoded value.
3. **Read path:** In a second IDE sharing the same `.switchboard/`, activate the extension; confirm the status bar setting is restored from the DB before `updateStatusBarVisibility()` runs (status bar reflects the synced value).
4. **Listener path:** Change a `switchboard.*` setting via the VS Code Settings UI (not the Setup panel); confirm it syncs to the DB when sync is enabled.
5. **Feedback loop:** On activation with a populated `setting.*` table, confirm no redundant DB writes occur during restore (check logs / DB `updated_at` timestamps).
6. **Scope exclusion:** Change `persistPanels` (Global) and `planning.enabledSources` (WorkspaceFolder); confirm NO `setting.*` row is written for them.
7. **Disabled mode:** With `dbSyncEnabled = false`, toggle settings; confirm no `setting.*` rows are written and existing rows are not restored on activation.
8. **DB failure:** Lock or rename the `kanban.db`; toggle a setting; confirm the VS Code config write still succeeds and the error is logged.
9. **Existing-user migration:** On a workspace with an older `kanban.db` (no `setting.*` rows), confirm activation does NOT auto-bulk-push (if default OFF) or prompts via button (if default ON).

## Recommendation

Complexity 7 → **Send to Lead Coder.** The per-call-site routing and scope boundaries require careful coordination across 4 files, and the default-ON migration concern plus the feedback-loop guard are subtle enough to warrant lead-level review.
