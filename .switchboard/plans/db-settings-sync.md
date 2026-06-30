# DB Settings Sync — Optionally Persist VS Code Settings to Kanban DB

## Goal

### Core Problem
All 73 Switchboard VS Code extension settings (status bar toggles, theme, CLI config, plan scanner, polling, etc.) are stored exclusively in the VS Code settings store (`vscode.workspace.getConfiguration()`). This store is per-IDE and per-workspace — there is no cross-IDE sync. Users who run Switchboard in multiple IDEs (VS Code, Cursor, Windsurf) see different status bar layouts, different themes, different scanner configs, etc., even though their kanban data and plan files are shared via `.switchboard/kanban.db`.

### Background
- Kanban state (cards, columns, epics, workspace mappings) already lives in `kanban.db` (SQLite) and syncs across IDEs via shared `.switchboard/` folder or cloud-synced DB paths.
- Plan files live in `.switchboard/plans/*.md` — also shared.
- The Setup panel already has a "Prompt Settings Export / Import" section that manually writes/reads `.switchboard/settings.json`. This is a manual one-shot sync, not automatic.

### Root Cause
Settings were implemented as standard VS Code extension settings (`package.json` configuration schema + `vscode.workspace.getConfiguration().update()`). No DB-backed alternative was built. The existing export/import is manual and only covers prompt-related settings.

## Solution

Add an **optional DB sync** mode: when enabled via a checkbox in the Setup panel, all Switchboard VS Code settings are automatically mirrored to **every** `kanban.db` that Switchboard creates/uses. This is a one-way sync (VS Code → DB) on write, and a one-way restore (DB → VS Code) on activation. The manual export/import buttons remain as-is.

### UX Changes

1. **Rename the Setup panel section** currently titled "PROMPT SETTINGS EXPORT / IMPORT" to **"SAVE SETTINGS TO DATABASE"** (or similar).
2. **Add a checkbox** in that section: "Sync VS Code settings to Kanban database" — **default ON**.
   - When checked: every setting write via `config.update()` also writes to all known `kanban.db` files.
   - When unchecked: settings stay VS Code-only (current behavior).
3. **Keep the existing Export / Import buttons** below the checkbox. They continue to write/read `.switchboard/settings.json` as a manual fallback.

### DB Schema

Add a `settings` table to `kanban.db`:

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,        -- JSON-encoded value (handles bools, strings, arrays, objects)
  updated_at TEXT NOT NULL    -- ISO timestamp for conflict resolution
);
```

A single row per setting key. Value is JSON-encoded to handle all types (boolean, string, integer, array, object).

### Sync Logic

#### Write path (VS Code → DB)
- Intercept all `config.update('switchboard.*', ...)` calls. The cleanest approach: create a **SettingsSyncService** that wraps the update — all existing `handleSet*Setting` methods in `TaskViewerProvider.ts` route through it.
- When DB sync is enabled, after writing to VS Code config, also upsert into the `settings` table of **every** `kanban.db` that Switchboard knows about (the active workspace DB + any Control Plane / multi-workspace DBs).
- When DB sync is disabled, only write to VS Code config (current behavior).

#### Read path (DB → VS Code, on activation)
- On extension activation, if DB sync is enabled:
  - Read all rows from the `settings` table of the active workspace's `kanban.db`.
  - For each row, call `config.update(key, value, ConfigurationTarget.Workspace)` to restore the VS Code setting.
  - This runs once at startup, before `updateStatusBarVisibility()` and other config-dependent init.
- If DB sync is disabled, skip this entirely.

#### Sync enable/disable toggle itself
- The "Sync VS Code settings to Kanban database" checkbox state is stored as a VS Code setting (e.g. `switchboard.settings.dbSyncEnabled`, default `true`) AND in the DB `settings` table (so it survives across IDEs once enabled on one).

### Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add `switchboard.settings.dbSyncEnabled` (boolean, default `true`, scope `window`). |
| `src/services/SettingsSyncService.ts` | **NEW** — manages DB read/write of settings, wraps `config.update()`. |
| `src/services/TaskViewerProvider.ts` | All `handleSet*Setting` methods route through `SettingsSyncService` instead of calling `config.update()` directly. |
| `src/extension.ts` | On activation: instantiate `SettingsSyncService`, call `restoreFromDb()` if sync enabled. Register `ConfigurationTarget` change listener to catch settings changed outside the Setup panel (e.g. via VS Code Settings UI). |
| `src/services/SetupPanelProvider.ts` | Wire up the new checkbox message handler (`setDbSyncEnabled`). |
| `src/webview/setup.html` | Rename section heading, add checkbox, keep existing export/import buttons. |

### Edge Cases

- **Multiple kanban DBs**: If the user has Control Plane or multi-workspace mappings, settings must be written to all known DB paths. `SettingsSyncService` enumerates active DB paths from the kanban service.
- **DB not yet created**: If `kanban.db` doesn't exist yet (fresh workspace), skip DB sync until it's created. The `settings` table is created lazily on first write.
- **Conflict between IDEs**: If two IDEs write different values, last-write-wins via `updated_at` timestamp. On activation, the DB value always wins (restores into VS Code config).
- **Setting changed via VS Code Settings UI (not Setup panel)**: A `vscode.workspace.onDidChangeConfiguration` listener catches external changes and syncs them to DB if sync is enabled.
- **Migration for existing users**: On first activation with `dbSyncEnabled = true` and an empty `settings` table, do a one-time bulk push of all current VS Code settings into the DB. Subsequent activations only restore (DB → VS Code) if the table is non-empty.
- **Deprecation**: `switchboard.workspaceDatabaseMappings` is already deprecated (mappings moved to DB). No change needed there.

### What Does NOT Change

- The manual Export/Import to `.switchboard/settings.json` stays exactly as-is — it's a separate mechanism for users who want file-based portability.
- The `package.json` configuration schema stays — settings are still declared as VS Code extension settings so they appear in the Settings UI and the Setup panel can read/write them. DB sync is an additional layer, not a replacement.
- Kanban data, plan files, epics, workspace mappings — untouched.

## Complexity

7/10 — the logic is straightforward (wrap config.update, add a table, read on activation) but the surface area is large (73 settings, many `handleSet*` methods, multiple DB paths, config-change listener). The main risk is missing a setting write path that bypasses the wrapper.
