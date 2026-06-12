# Consolidate `.switchboard/*.json` Configuration Into kanban.db

## Goal

Make `kanban.db` the single home for extension configuration and state. Migrate every `.switchboard/*.json` file — including **all of `state.json`** — into the database's existing `config` key-value table (`KanbanDatabase.ts:125`, `getConfig`/`setConfig` at `KanbanDatabase.ts:2586-2600`), with relational data going to a real table. The only files that remain under `.switchboard/` are caches, backups, `db-pointer`, and the genuine message-passing directories (`inbox/`, `outbox/`, `archive/`). Establish one blessed rule for future work: **new state goes in the db, not a new JSON file.**

## Metadata

**Complexity:** 7
**Tags:** refactor, backend, reliability

## Problem Analysis

The extension is meant to be db-first, but config has sprawled across ~10 ad-hoc JSON files under `.switchboard/`. The db already has exactly the right primitive — a generic `config` key-value table that `workspace_mappings` and `import_registry_migrated` already use — but most services bypass it with direct `fs` reads/writes of their own JSON files.

A previous plan proposed consolidating into VS Code settings + `globalState`. That direction is rejected:

- `.vscode/settings.json` scopes by **open VS Code workspace folder**, but Switchboard's multi-repo model (db-pointer, workspace mappings, effective workspace root) deliberately routes around VS Code's workspace concept. `ConfigurationTarget.WorkspaceFolder` throws when the effective root is not an open folder; the fallback writes repo A's config into repo B's workspace. The db already follows the effective root correctly.
- `globalState` is per-machine and shared across all workspaces — wrong scope for per-repo config, and plaintext (so wrong for secrets too). API tokens already live in `vscode.SecretStorage` (`ClickUpSyncService.ts:142`, `LinearSyncService.ts:110`, `NotionFetchService.ts:60`) and stay there — no change needed.
- Settings would require registering ~20 keys in `package.json` `contributes.configuration` and pollute git diffs with machine-managed state.

### `state.json` has no external consumers — it goes entirely

The protocol docs (`SWITCHBOARD_PROTOCOL.md`) describe `state.json` as "shared agent state" written by multiple processes, justifying its proper-lockfile locking (`TaskViewerProvider.ts:1623`) and file watcher (`TaskViewerProvider.ts:8889`). **Verified: this multi-process story does not exist in practice.**

- The only writer outside `src/` is `.agent/scripts/set-presence.js` — which is referenced by *nothing* (no prompt, no doc, no code; it arrived in the initial launch commit and was never wired up). Dead scaffolding; delete it.
- Agents are explicitly forbidden from editing the file (`.agent/rules/terminal_governance.md:6`: "Directly editing `.switchboard/state.json` is a FAIL-STATE").
- The watcher mostly observes the extension's own writes — it carries a self-write guard (`TaskViewerProvider.ts:8892`) for exactly that reason.

`state.json` is a single-writer file owned by the extension. Every key moves to the db, and the file — plus its lockfile machinery, watcher, retry-parse loops, and background zombie-pruner — is deleted. The `inbox/`/`outbox/` message directories are a separate, genuinely file-based channel and are out of scope.

### Target inventory

| File | Contents | Target |
|---|---|---|
| `state.json` — config keys: `startupCommands`, `visibleAgents`, `customAgents`, `customColumns`, `agentAssignments`, `promptOverrides`, `liveSyncConfig`, `julesAutoSyncEnabled`, `autoCommitOnCodeReview`, `planIngestionFolder`, last-accessed lists/projects (`TaskViewerProvider.ts:5098-5140`) | Extension config | **db `config` table** |
| `state.json` — runtime keys: `terminals`, `chatAgents`, `session`, `context`, `tasks`, `teams`, `julesSessions`, `julesPolling*` | Terminal/agent registrations, session state | **db `config` table** (then delete the file) |
| `local-folder-config.json` | Folder paths (local, html, design, tickets, images, stitch, briefs) | **db `config` table** |
| `planning-sync-config.json` | Planning sync mode + selected containers | **db `config` table** |
| `clickup-config.json` | ClickUp team/space/list IDs | **db `config` table** |
| `linear-config.json` | Linear team/project IDs | **db `config` table** |
| `notion-config.json` | Notion page/database IDs | **db `config` table** |
| `linear-sync.json` | Linear issue ID ↔ plan file mapping | **db — new `linear_issue_links` table** (relational) |
| `workspace_database_mappings.json` | Multi-repo DB mappings | **Already in db** (`config.workspace_mappings`, `KanbanDatabase.ts:612-639`) — delete file + any code still reading it |
| `imported-docs.json` | Legacy import registry | **Delete** — db migration already complete (`import_registry_migrated` flag, `KanbanDatabase.ts:1926`) |
| `clickup-tasks.json`, `linear-tasks.json` | Task metadata caches | **Move into `planning-cache/`** (stay files) |
| `planning-cache/*/*.json`, `notion-cache.md` | Caches | **Keep as files** |
| `kanban-state-backup.json` | Board state backup | **Keep as file** |
| `bridge.json`, `inbox/`, `outbox/`, `archive/` | Message-passing channel | **Out of scope** — untouched |
| API tokens | Credentials | **Already in SecretStorage** — no change |

### Migration style

This is a dev-only, single-user extension: clean breaks, no `_migrated` flags, no multi-release fallback windows. Each service does a one-shot inline migration at first load: if the legacy JSON file exists, read it, write its keys to the db, **delete the file**, continue. If the file is corrupt, log and fall back to defaults (same outcome as today).

## Edge Cases

- **Async boundary**: `getConfig`/`setConfig` are async; several current consumers read `state.json` synchronously. Pattern: each provider hydrates its keys from the db once at init into an in-memory cache, and writes are write-through (update cache, fire-and-forget `setConfig` with error logging). No call site should block on a db read in a hot path.
- **Pre-db-init reads**: `extension.ts:556` reads old terminal names from `state.json` *before* `cleanWorkspace` resets it. After migration this becomes a db read, so `KanbanDatabase` init for the effective workspace root must precede terminal reclaim in the activation sequence. Audit activation ordering once; the db open is already early because the kanban provider needs it.
- **Watcher replacement**: the state watcher currently drives agent-status UI refreshes. Since the extension is the only writer, file-change events are unnecessary — replace with a direct in-process refresh call at each write site (the writer knows it wrote). This also retires the self-write guard, the JSON retry-parse loop (`extension.ts:1621`), and the proper-lockfile dance — all of which exist solely to cope with file-based sharing that never happened.
- **Multi-window**: if the same workspace is ever open in two VS Code windows, SQLite's own locking handles concurrent writes more safely than the current lockfile-around-JSON approach. Cross-window live UI sync was never reliable anyway (the watcher guard suppressed most events) — not a regression.
- **Multi-repo**: config naturally follows the db, which follows the effective workspace root via db-pointer/mappings. Each tab's independently selected workspace resolves its own db and therefore its own config — no shared-root coupling.
- **JSON values in a TEXT column**: store structured values as JSON strings via typed helpers (below); no schema explosion, one parse point.

## Proposed Changes

### Phase 1: Typed config accessors + migration helper

#### [MODIFY] `src/services/KanbanDatabase.ts`

Add thin typed wrappers over the existing `config` table:

```typescript
public async getConfigJson<T>(key: string, defaultValue: T): Promise<T> {
    const raw = await this.getConfig(key);
    if (raw === null) { return defaultValue; }
    try { return JSON.parse(raw) as T; } catch { return defaultValue; }
}

public async setConfigJson(key: string, value: unknown): Promise<boolean> {
    return this.setConfig(key, JSON.stringify(value));
}
```

Add a one-shot file migration helper:

```typescript
/** Reads a legacy .switchboard JSON file, writes selected keys to the config
 *  table, deletes the file. No-op if the file is absent. */
public async migrateJsonFileToConfig(
    filePath: string,
    mapKeys: (parsed: any) => Record<string, unknown>
): Promise<void>
```

Key namespace convention (flat, dot-separated): `kanban.*`, `agents.*`, `runtime.*`, `folders.*`, `planning.*`, `clickup.*`, `linear.*`, `notion.*`.

### Phase 2: Eliminate `state.json`

All keys move to the db; the file, and every piece of machinery that exists to share it, is deleted.

Key mapping:

| `state.json` key | db `config` key |
|---|---|
| `customColumns` | `kanban.customColumns` |
| `customAgents` | `agents.customAgents` |
| `agentAssignments` | `agents.assignments` |
| `startupCommands` | `agents.startupCommands` |
| `visibleAgents` | `agents.visibleAgents` |
| `promptOverrides` | `agents.promptOverrides` |
| `liveSyncConfig` | `planning.liveSyncConfig` |
| `julesAutoSyncEnabled` | `agents.julesAutoSyncEnabled` |
| `autoCommitOnCodeReview` | `kanban.autoCommitOnCodeReview` |
| `planIngestionFolder` | `planning.ingestionFolder` |
| `terminals` | `runtime.terminals` |
| `chatAgents` | `runtime.chatAgents` |
| `session` | `runtime.session` |
| `tasks` | `runtime.tasks` |
| `context` | `runtime.context` |
| `teams` | `runtime.teams` |
| `julesSessions` / `julesPolling*` | `runtime.jules` |

One inline migration on first db init for a workspace: if `state.json` exists, import all keys per the table above, delete the file.

#### [MODIFY] `src/services/KanbanProvider.ts`

Replace every `state.json` read/write (`KanbanProvider.ts:188, 426, 2197, 2223, 2328, 2349, 3236, 3354, 3420, 3438`) with db accessors via a hydrated cache.

#### [MODIFY] `src/services/TaskViewerProvider.ts`

- Terminal/chat-agent registration and the locked-update helper (`_updateStateWithLock`, `:1576-1623`) → plain db writes; **remove `proper-lockfile`** (and drop the dependency from `package.json` if nothing else uses it).
- Delete the state watcher (`:8888-8903`) and self-write guard; replace with direct refresh calls at each write site.
- Last-accessed lists/projects (`:5098-5140`) → `clickup.lastAccessedLists` / `linear.lastAccessedProjects`.

#### [MODIFY] `src/extension.ts`

- Terminal re-claim on startup (`:556-585`, `:1516-1533`) reads `runtime.terminals` from the db (after db init — see activation-ordering edge case).
- Delete the state-watcher wiring (`:1533`), the JSON retry-parse loop (`:1617-1653`), and convert the background zombie-terminal pruner (`:1946`) to prune `runtime.terminals` in the db.
- "Reset state" command (`:1933`) clears the `runtime.*` config keys instead of rewriting the file.

#### [MODIFY] `src/services/agentPromptBuilder.ts`, `src/services/agentConfig.ts`, `src/services/PlanningPanelProvider.ts` (`:4990`), `src/services/SetupPanelProvider.ts`

Point their reads of migrated keys at the db accessors (via the owning provider's hydrated cache where the call site is sync).

#### [DELETE] `.agent/scripts/set-presence.js`

Referenced by nothing; never wired up.

#### [MODIFY] `.switchboard/SWITCHBOARD_PROTOCOL.md`, `.switchboard/README.md`, `.agent/rules/terminal_governance.md`

Remove `state.json` from the protocol; document the new contract: **all extension state and config live in `kanban.db`; `inbox/`/`outbox/` are the only agent-facing files.** This is the line that stops future agents from inventing new JSON files.

### Phase 3: `local-folder-config.json` → db

#### [MODIFY] `src/services/LocalFolderService.ts`

- `loadFolderPathsConfig()` / `saveFolderPathsConfig()` read/write `config` key `folders.paths` (one JSON object holding all seven path arrays) instead of the JSON file.
- Inline migration: if `local-folder-config.json` exists, import it, delete it.
- Drop the `_migrated*` flag fields from `LocalFolderPathsConfig` — they were bookkeeping for the old (reversed) settings migration.

#### [MODIFY] `src/services/PlanningPanelProvider.ts`, `src/services/DesignPanelProvider.ts`

Delete the old migration code that copies VS Code global settings → `local-folder-config.json` (the previous failed attempt that ran the migration backwards). All folder config flows through `LocalFolderService`.

### Phase 4: Integration configs → db

#### [MODIFY] `src/services/SetupPanelProvider.ts`

`planning-sync-config.json` → `config` keys `planning.syncMode`, `planning.selectedContainers`. Inline migrate + delete file.

#### [MODIFY] `src/services/ClickUpDocsAdapter.ts`, `src/services/ClickUpSyncService.ts`

`clickup-config.json` (team/space/list IDs) → `config` key `clickup.config`. Tokens stay in SecretStorage exactly as they are.

#### [MODIFY] `src/services/LinearDocsAdapter.ts`, `src/services/LinearSyncService.ts`

- `linear-config.json` → `config` key `linear.config`.
- `linear-sync.json` → new db table (it's relational):

```sql
CREATE TABLE IF NOT EXISTS linear_issue_links (
    issue_id   TEXT PRIMARY KEY,
    plan_path  TEXT NOT NULL,
    synced_at  TEXT
);
```

Inline migrate from the JSON file, then delete it.

#### [MODIFY] `src/services/NotionBrowseService.ts`

`notion-config.json` → `config` key `notion.config`. `notion-cache.md` stays a cache file.

### Phase 5: Delete dead files and code

- `workspace_database_mappings.json`: mappings already live in `config.workspace_mappings` — remove any remaining file reads/writes in `KanbanProvider.ts` / `SetupPanelProvider.ts`, delete the file on activation if present.
- `imported-docs.json`: db migration already complete — remove the file dependency and delete the file on activation if present.
- Delete the stale scratch files at repo root that reference old state keys: `temp.js`, `temp_script.js`, `previous_kanban.html`.
- Update `WorkspaceExcludeService.ts` and any `.gitignore` templates for the removed filenames.

### Phase 6: Cache tidy-up

#### [MODIFY] `src/services/PlanningPanelCacheService.ts`

Move `clickup-tasks.json` and `linear-tasks.json` from `.switchboard/` root into `planning-cache/`:

```typescript
this._clickupMetadataPath = path.join(cacheBaseDir, 'clickup-tasks.json');
this._linearMetadataPath = path.join(cacheBaseDir, 'linear-tasks.json');
```

Caches need no migration — delete the old-location files if present; they repopulate.

## Verification Plan

1. `npm run compile` — no TypeScript errors.
2. Open a workspace with populated legacy files. After activation: `sqlite3 .switchboard/kanban.db "SELECT key FROM config"` lists the new keys; `state.json`, `local-folder-config.json`, `planning-sync-config.json`, `clickup-config.json`, `linear-config.json`, `linear-sync.json`, `workspace_database_mappings.json`, `imported-docs.json` are all gone from `.switchboard/`.
3. Spawn agent terminals, close one manually, reload the VS Code window — terminals re-claim correctly from `runtime.terminals`; the closed terminal is pruned; agent status UI updates on registration without a file watcher.
4. Add/remove a folder via "Manage Folders" — `folders.paths` updates in the db; no JSON file reappears.
5. Toggle agent visibility, edit a startup command, add a custom kanban column — each persists across a VS Code restart and updates only the db.
6. Inbox/outbox messaging round-trip between two agents still works (protocol regression — unaffected paths).
7. Switch the workspace dropdown to a second mapped repo — config follows the resolved db (per-repo config isolation).
8. ClickUp/Linear/Notion sync round-trip — IDs read from db, tokens from SecretStorage, Linear issue↔plan links resolve from `linear_issue_links`.
9. Clean-install test: scratch workspace with no `.switchboard/` — extension starts with defaults and creates **no JSON config files** (only `kanban.db`, caches as needed).
10. Update and run the regression tests that stub `state.json`: `src/test/plan-ingestion-target-regression.test.js`, `review-column-persistence-regression.test.js`, `kanban-backward-reset-regression.test.js`, `onboarding-regression.test.js` — fixtures move from file stubs to db seeding.

## Dependencies

- **Blocker**: `fix-workspace-picker-persistence-and-all-workspaces.md` first — it touches the same `LocalFolderService` and `PlanningPanelProvider` code paths.
- Phase 1 (accessors + helper) blocks all other phases; Phase 2 is the largest and should land alone; Phases 3–6 are independent of each other.

## Remaining Risks

- **Activation ordering**: terminal re-claim moves from a pre-db file read to a post-db-init db read. If db init ever fails (corrupt db), terminal re-claim is skipped — acceptable: the same failure already takes down the kanban board, and terminals just respawn fresh.
- **Sync→async rewiring**: some `state.json` reads sit in sync paths; the hydrate-at-init cache pattern covers them, but any missed call site reading before hydration gets defaults for one render. Acceptable for a dev tool.
- **Write frequency**: `runtime.terminals` updates on terminal lifecycle events (sub-second bursts during agent spawn). SQLite handles this trivially; it replaces a full-file JSON rewrite under a retry-lockfile, so it's strictly cheaper.
- **Regression test fixtures**: the four tests above construct `state.json` by hand; they will fail until updated. That's the desired clean break, called out so it isn't mistaken for a behavioral regression.
