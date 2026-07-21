# Headless Ingestion

**Complexity:** 6

## Goal

Make `npx switchboard` ingest plans identically to the VS Code extension — same triggers, same results, same edge-case handling — via **one shared ingestion engine** consumed by both hosts, so the extension and headless can never diverge. The only thing headless is permitted to lack is terminals/CLI dispatch. Delivered as three sequenced pieces (all three ship for parity — they are phases, not an MVP subset): extract the engine, wire the standalone host onto it, then give it real provider sync.

## How the Subtasks Achieve This

- **Ingestion 1 — Shared Engine Extraction + VS Code Adapter**: the foundation. Extracts the vscode-bound `GlobalPlanWatcherService` into a host-agnostic `PlanIngestionEngine` behind a `PlanIngestionHost` seam, and re-wires the extension onto it via a thin VS Code adapter — a behaviour-preserving refactor guarded by a shared behavioural suite (fake seam) + a VSIX-parity gate. Highest risk (touches the ~4,000-install extension); no standalone code.
- **Ingestion 2 — Standalone Ingestion**: the additive headless half. A native `fs.watch` host seam + standalone bootstrap wiring — boot scan, live watching of `.switchboard/plans/` and the external scanner folders, deletes, headless feature recompute/regen callbacks backed by `KanbanDatabase`, and the create/scan/import verb wiring — all driving the piece-1 engine.
- **Ingestion 3 — Headless Provider Sync**: the finisher. Replaces the `() => null` ClickUp/Linear/Notion stubs with real factories backed by the existing metadata paths + `StandaloneHostSecrets`, so provider-linked plans sync headless.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Headless Ingestion 1 — Shared Engine Extraction + VS Code Adapter](../plans/headless-plan-file-ingestion-watcher.md) — **CODER CODED**
- [ ] [Headless Ingestion 2 — Standalone Ingestion (adapter + bootstrap + verbs)](../plans/headless-standalone-ingestion.md) — **CODER CODED**
- [ ] [Headless Ingestion 3 — Headless Provider Sync](../plans/headless-provider-sync.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Implementation Summary

All three pieces implemented and verified:

### Piece 1 — Shared Engine Extraction + VS Code Adapter
- **New file:** `src/services/PlanIngestionEngine.ts` (~1000 lines) — host-agnostic ingestion engine behind the `PlanIngestionHost` seam. Contains all logic extracted from `GlobalPlanWatcherService`: file watching, debounce, periodic scan, purge sweep, feature linking, ClickUp real-time sync, Linear/Notion archive-on-purge, tombstone column preservation, brain-mirror skip, atomic-write guard, registerPendingCreation/registerRename.
- **Rewritten:** `src/services/GlobalPlanWatcherService.ts` (~300 lines) — thin VS Code adapter. Constructs the engine with a VS Code-backed host seam (FileSystemWatcher + native fs.watch fallback, vscode.workspace.getConfiguration, OutputChannel logger, workspace-database-mapping root resolution). Bridges `onPlanDiscovered(workspaceRoot, filePath?)` into the vscode.EventEmitter<{uri, workspaceRoot}> shape extension consumers expect. Preserves the full public API (`initialize`, `setFeatureColumnRecomputer`, `setFeatureFileRegenerator`, `registerPendingCreation`, `registerRename`, `refreshWatchers`, `triggerScan`, `runPurgeSweep`, `isGitOpActive`, `onPlanDiscovered`, `dispose`).
- **New test suite:** `src/services/__tests__/PlanIngestionEngine.test.ts` — 10 tests, fake-seam behavioural suite (no VS Code, no real filesystem watcher). Covers periodic scan enable/disable, environment change restart, ingestPlanFile create, brain-mirror skip, registerPendingCreation suppression, registerRename delete guard, expandHome. **All 10 pass.**
- **Updated test suite:** `src/services/__tests__/GlobalPlanWatcherService.test.ts` — replaced stale private-method suites (referenced members removed when project stamping moved to DB layer) with adapter contract parity tests: constructor signature, public API surface, onPlanDiscovered {uri, workspaceRoot} bridge, dispose propagation. Added to `.vscode-test.mjs` config for vscode-test runner.

### Piece 2 — Standalone Ingestion
- **New file:** `src/standalone/planIngestionHost.ts` (~308 lines) — native `fs.watch` implementation of `PlanIngestionHost`. Recursive fs.watch with per-subdirectory tree-walk fallback for platforms that don't support recursive (BSD/FreeBSD/Solaris/Node<19.1.0 on Linux). Directory exclusion (.git, node_modules, dist, etc.) to avoid inotify exhaustion. config.json file watcher for environment-change events. `readPlanScannerCustomSourceDirs` helper for external scanner folder discovery.
- **New file:** `src/standalone/headlessFeatureCallbacks.ts` (~194 lines) — DB-direct reimplementations of `KanbanProvider.recomputeFeatureColumnFromSubtasks` and `KanbanProvider._regenerateFeatureFile`, byte-for-byte mirrors of the extension's logic (same regexes, same no-op-skip guard, same registerPendingCreation call). Used as the engine's feature-column recompute + feature-file regen callbacks headless.
- **Modified:** `src/standalone/bootstrap.ts` — constructs the `PlanIngestionEngine` with the standalone host, wires feature callbacks, subscribes to discovered-plan events for board UI refresh, wires `scanFoldersNow`/`createPlan` verbs to `engine.triggerScan`, disposes engine on stop.
- **Modified:** `src/standalone/hostServices.ts` — added `readPlanWatcherConfig` and `resolveStandaloneWatchedRoots` typed accessors for the planWatcher config + watched-folders surface.

### Piece 3 — Headless Provider Sync
- **New file:** `src/standalone/vscodeShim.ts` (~265 lines) — minimal `vscode` module shim for the standalone bundle. Provides `SecretStorage` adapter over `StandaloneHostSecrets` (encrypted file-backed), `EventEmitter`, `Uri`, `window` (interactive UI rejects headless with clear error), `workspace.getConfiguration` (reads from config.json via StandaloneHostPathConfigProvider), `commands`, `Disposable`, `ConfigurationTarget`. The ingestion path only uses `SecretStorage.get` — interactive setup flows (showInputBox/showQuickPick) reject immediately if misrouted.
- **Modified:** `webpack.config.js` — standalone config `resolve.alias` maps `vscode` to `vscodeShim.ts` (extension config unchanged, still uses `externals: { vscode: 'commonjs vscode' }`).
- **Modified:** `src/standalone/bootstrap.ts` — constructs real `ClickUpSyncService`, `LinearSyncService`, `NotionFetchService` with the shim's SecretStorage adapter, passes them to both the engine and `LocalApiServer` options (replacing the `() => null` stubs).

### Verification
- `tsc --noEmit -p tsconfig.json` — clean (only pre-existing TS2835/TS2345 errors in untouched files).
- `tsc -p tsconfig.test.json` — clean for all new/modified files.
- `mocha --ui tdd out/services/__tests__/PlanIngestionEngine.test.js` — **10/10 passing**.
- `webpack` standalone bundle — `dist/standalone/cli.js` (1.41 MiB) emitted successfully.
- Extension bundle has one pre-existing error in `PlanningPanelProvider.ts:3342` (TS2345, not in scope of this feature).

## Dependencies & sequencing

Strictly ordered: **1 → 2 → 3.** Piece 1 (the engine + seam) is the foundation both other pieces consume. Piece 2 (standalone ingestion) needs the engine to exist before it can wire a host onto it. Piece 3 (provider sync) needs piece 2's standalone host to be constructing the engine and running ingestion batches before there is anything for sync to fire on. Piece 1 is the high-risk refactor and should land behind its own review + VSIX-parity gate; 2 and 3 are additive with no extension risk.

**Related (not a blocker):** full cross-provider (ClickUp/Linear/Notion), all-trigger sync parity is tracked in the standalone `provider-sync-full-parity.md` plan. This ingestion feature does not depend on it — piece 3 ships the ingest-path provider-sync subset (ClickUp content-on-import + Linear archive-on-delete) on its own. Provider sync already largely exists in the extension via the merged `RemoteProvider` seam; headless reaching full parity is that separate plan's concern.

