# Build the JSON config and planning-cache sidecar migrations

## Goal

Actually migrate the seven machine-local JSON config files and the five planning-cache JSON sidecars that `control-plane-scaffold-out-of-the-repo.md` specified as change 4 and change 6. The scaffold subtask's Implementation Summary states both migrations happened; measured, neither was built.

### Problem Analysis

**The migrations do not exist.** Measured across `src/` after `8258ce4b`:

| File | live `src/` refs | `*.migrated.bak` refs |
| :--- | :--- | :--- |
| `config.json` | 43 | 0 |
| `settings.json` | 17 | 0 |
| `integration-config.json` | 6 | 0 |
| `kanban-state.json` | 5 | 0 |
| `kanban-state-backup.json` | 5 | 0 |
| `workspace_identity.json` | 5 | 0 |
| `.agent_version.json` | 4 | 0 |
| `documentIdMap.json` | 5 | — |
| `documentTitles.json` | 4 | — |
| `cache-metadata.json` | 2 | — |
| `clickup-tasks.json` | 3 | — |
| `linear-tasks.json` | 3 | — |

102 call sites, all still reading and writing files on disk, and not a single `*.migrated.bak` reference for any of the seven. Only the sync-base cache relocation to `~/.switchboard/cache/<workspace-id>/` was genuinely built.

**The scaffold plan already identified why these belong in the store.** Seven machine-local JSON files sit "next to a database that already has `config` and `project_config` tables", and five sidecars duplicate columns `imported_docs` already carries: `documentIdMap.json` duplicates `remote_doc_id` ↔ `slug_prefix`, `documentTitles.json` duplicates `doc_name`, `cache-metadata.json` duplicates `last_synced_at`. `ImportRegistryEntry.remoteContentHash` duplicates `imported_docs.content_hash` — the same hash in a JSON file and a column, with no arbiter.

**The pattern is proven in this codebase, not invented here.** `stateConfigBridge.ts` already did exactly this for `state.json`: its header records that "state.json no longer exists on disk" and that ~40 legacy call sites route through a facade to the `config` table at a single choke point, via `STATE_KEY_TO_CONFIG`. The risk is not the pattern — it is that each of the twelve files has its own read/write call sites to inventory, and `integration-config.json` overlaps `GlobalIntegrationConfigService`, which is already machine-global (`AGENT_GLOBAL_FILE_KEYS` routes `startupCommands`, `visibleAgents`, `customAgents` and `config` there).

**One file must not move, and it is the one that looks most like the others.** `workspace_identity.json` overlaps `.switchboard/workspace-id`, and the committed file is the thing that *correctly* stays in the repository — the repo holds identity, the store holds state. `workspace_identity.json` is the **legacy** form and is PRIORITY 2 in `ensureWorkspaceIdentity`; it gets imported and archived, and the committed `workspace-id` is untouched.

### Root Cause

The subtask bundled twelve independent file migrations behind one summary line. Each needs its own call-site inventory and its own per-key scope decision, and none of them fails a gate when absent — a file that is still being read works exactly as it always did.

### Non-goals

- Migrating the `instructions/` filesystem message queue to tables. Identified in the scaffold plan, explicitly scoped separately — it is a behaviour change to work claiming.
- Moving `.switchboard/api-server-port.txt`. It must stay a real file: a CLI that has not connected yet has no way to discover the port except by reading it, and it is the most-referenced non-artifact path in the directory.
- Deleting the sync-base `planning-cache/{sourceId}/{docId}.md` bodies. Those are the conflict-detection base, not a duplicate, and their relocation already shipped.

## Metadata

**Complexity:** 6
**Tags:** refactor, database, infrastructure, migration, reliability

## User Review Required

No. The per-key scope rule is determined by an existing precedent rather than taste: keys already routed through `AGENT_GLOBAL_FILE_KEYS` are machine-global and stay in `GlobalIntegrationConfigService`; everything else is per-workspace and lands in the board database's `config` / `project_config`. `workspace_identity.json` is imported-and-archived, never authoritative. The five sidecars fold into `imported_docs`, whose columns already hold every value they carry.

## Complexity Audit

### Routine

- A `stateConfigBridge`-shaped facade per file, with a key map, so existing call sites change import target rather than call shape.
- Import-before-delete: read the file, write the values, archive as `*.migrated.bak`, never unlink.
- Dropping `ImportRegistryEntry.remoteContentHash` in favour of `imported_docs.content_hash`.

### Complex / Risky

- **Unknown keys must be preserved, not dropped.** These files shipped in released versions across ~4,000 installs. A user on a newer dev build can have keys this code does not know. Every migration reads the whole object and preserves unrecognised keys rather than mapping a known list and discarding the rest.
- **`integration-config.json` overlaps a machine-global service that already owns some of its keys.** Migrating the whole file into the per-workspace `config` table would move machine-global values into one workspace. Split it by `AGENT_GLOBAL_FILE_KEYS` before writing anything.
- **`kanban-state.json` / `kanban-state-backup.json` are the v1 interim restore path.** `board-backup-and-per-project-export.md` cross-references them as "the only restore available before the sidecar lands". The *writer* was removed from the persist tick in `8258ce4b` and `_writeKanbanStateBackup()` is now dead code with zero callers. Migrating the readers must not delete the ability to read a legacy file a user still has on disk.
- **`.agent_version.json` gates control-plane version comparisons.** Moving it changes when a downgrade is detected. It must land before or with the projection's version stamp, not after.
- **The five sidecars are read on a hot path.** `PlanningPanelCacheService` reads `documentIdMap.json` and `documentTitles.json` during doc resolution. Folding them into `imported_docs` turns file reads into queries; those must be batched, not per-document, or the planning panel gains an N+1.

## Edge-Case & Dependency Audit

**Race conditions**
- Two windows migrating the same file concurrently: the migration is per-workspace and idempotent, and the marker is written before the source is archived, so a second host sees "already migrated" rather than re-importing.
- `integration-config.json` has documented churn writers and a corruption history (three or more recorded corruptions). Read it once, validate it parses, and refuse to migrate a file that does not — preserving it untouched and reporting, exactly as the cloud-sync adoption path does.

**Security**
- None of the twelve holds credentials. `secrets.enc` and `.master-key` are separate and untouched by this plan.

**Side effects**
- Removing seven files from `.switchboard/` also removes them from every agent's file-search surface.
- `stateConfigBridge`'s existing facade is the model and may absorb some of these key maps rather than each getting its own module.

**Migration**
- Import before delete, archive as `*.migrated.bak`, never unlink, preserve unknown keys. A file that fails to parse is preserved and surfaced, never partially imported. Assume no prior migration ran.
- **Note:** `.gitignore` gained `.switchboard/**/*.bak` in `8258ce4b`, which hides these archives from `git status`. That line is removed by the storage-hardening subtask; if these ship first, the archives are invisible to the user.

## Dependencies

- **Requires** the `config` / `project_config` tables (long shipped) and `imported_docs` (shipped).
- **Interacts with** the Board-store retarget: with one board per project, `config` is per-workspace again, which is what these per-workspace keys assume. If that subtask has not landed, the per-workspace keys land in a shared table — so **sequence this after it**.
- **Independent** of the protocols reconnect.

## Adversarial Synthesis

Key risks: dropping unknown keys on a file that shipped to ~4,000 installs is silent data loss; `integration-config.json` mixes machine-global and per-workspace keys and has a corruption history, so migrating it wholesale moves one workspace's values machine-wide or imports a corrupt file as an empty one; and folding the two hot-path sidecars into `imported_docs` risks an N+1 in the planning panel. Mitigations: read whole objects and preserve unrecognised keys; split `integration-config.json` by `AGENT_GLOBAL_FILE_KEYS` and refuse a file that does not parse; batch the `imported_docs` reads.

## Proposed Changes

1. **A facade per file**, modelled on `stateConfigBridge.ts`, with an explicit key map and unknown-key passthrough. Existing call sites change import target, not call shape.
2. **Split `integration-config.json`** by `AGENT_GLOBAL_FILE_KEYS`: machine-global keys to `GlobalIntegrationConfigService`, the rest to `config`.
3. **Fold the five sidecars into `imported_docs`**, batching the reads `PlanningPanelCacheService` performs per document, and drop `ImportRegistryEntry.remoteContentHash` so the hash has one home.
4. **Import and archive `workspace_identity.json`**; leave the committed `.switchboard/workspace-id` untouched and authoritative.
5. **Keep legacy readers** for `kanban-state.json` / `kanban-state-backup.json` so an existing file on disk still restores, and delete the now-callerless `_writeKanbanStateBackup()`.
6. **Per-file migration**: parse-check, import, write marker, archive `*.migrated.bak`, never unlink; a parse failure preserves and reports.

## Verification Plan

### Automated

- **Per file, all twelve:** seed with known values plus an unrecognised legacy key; migrate; assert every value readable through the new path, the unknown key preserved, a `*.migrated.bak` present with original bytes, and the source not unlinked.
- **Corrupt source:** truncate each file mid-object; assert no partial import, source untouched, clear report.
- **`integration-config.json` split:** seed both a machine-global key and a per-workspace key; assert each lands in its correct store and neither leaks into the other.
- **Idempotency:** run every migration twice; assert no error, no duplicated rows, no second `.bak`.
- **Sidecar fold:** assert every value previously read from the five JSON files resolves from `imported_docs`, and that doc resolution issues a bounded number of queries rather than one per document.
- **Legacy restore:** with `kanban-state-backup.json` present on disk, assert it is still readable after migration.
- **`api-server-port.txt` untouched:** explicit regression test that it remains a real file at its current path and the CLI scripts still find it.
- Each new check gets a `package.json` script **and** a workflow step.

### Goal Invariants

- None of the seven JSON config files is read or written by `src/` after migration; each exists only as `*.migrated.bak`.
- Every value from every migrated file is readable through the store, including keys this code does not recognise.
- The five sidecars are gone and `imported_docs` is the single home for the values they held.
- `.switchboard/api-server-port.txt` is still a real file at its current path.
- The committed `.switchboard/workspace-id` is unchanged.

## Outstanding Questions

- None.

## Implementation Summary

Built facades and rewired call sites for all twelve files. config.json reads/writes now route through `configJsonBridge.ts` (modelled on `stateConfigBridge.ts`) — both `VscodeHostPathConfigProvider` and `StandaloneHostPathConfigProvider` hit the DB config table instead of the file, and `themeBodyClass.ts`/`SetupPanelProvider.ts` direct reads use `readAllConfigSync`. settings.json export/import moved to `prompt-settings-export.json` so it no longer collides with the migrated internal store. integration-config.json migration now splits by `AGENT_GLOBAL_FILE_KEYS` — machine-global keys go to `GlobalIntegrationConfigService`, per-workspace keys to `config`, unknowns preserved under `legacy.integrationConfig`. kanban-state-backup.json readers (extension.ts reset, LocalApiServer diagnostics) now fall back to `.migrated.bak`; the dead `_writeKanbanStateBackup()` was deleted. workspace_identity.json PRIORITY 2 reader checks `.migrated.bak`; the committed `workspace-id` stays authoritative. .agent_version.json readers in extension.ts and ControlPlaneMigrationService now read/write `agents.lastCopiedVersion` in the DB. The five sidecars fold into `imported_docs` via batched `getImportedDocsBySource` queries (no N+1); `ImportRegistryEntry.remoteContentHash` is deprecated in favour of `contentHash`, and task metadata JSON files (clickup-tasks.json, linear-tasks.json) are retired (in-memory LRU cache is the sole home).
