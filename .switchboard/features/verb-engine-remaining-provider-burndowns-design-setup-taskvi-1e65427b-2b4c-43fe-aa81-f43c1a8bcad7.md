# Verb Engine — Remaining Provider Burndowns (Design, Setup, TaskViewer)

**Complexity:** 7

## Goal

The remaining A2b provider arm-migrations not needed for the board-only or Project-panel browser cockpit; backlog until those panels are browser-served. Each makes one more provider run without VS Code, unblocking that panel's headless/browser use later.

## How the Subtasks Achieve This

- **Verb Engine · 2 — DesignPanelProvider Burndown (62 arms)**: migrates the Design/Stitch tab's arms onto the seams. Was the original "proving panel" in the burndown order; the most deferrable for the cockpit (design/mockups aren't core to planning).
- **Verb Engine · 3 — SetupPanelProvider Burndown (117 arms)**: migrates the config/onboarding/integrations panel. Note: *configuration itself* in a headless cockpit is handled by B1's seams (config-file/env/keyring), so this burndown is only needed if the Setup **UI** is served in the browser.
- **Verb Engine · 5 — TaskViewerProvider Burndown (110 arms)**: migrates the sidebar / integration-token panel. Its server-hosting role (LocalApiServer, port/token files) is replaced by B1's composition root, not this burndown — this covers the panel's own UI arms.

## Dependencies & sequencing

- **Cross-feature:** all three depend on **·1 Foundations** (Core feature — already built). **None** is required for the board-only cockpit or the Project-panel upgrade; they gate only the Design / Setup / sidebar panels going headless.
- **Internal order:** independent — no cross-dependency among ·2/·3/·5. The only hard rule is the burndown's operational one: **one agent stream per provider file** (they touch different files, so they parallelise, but must not collide on the same file).
- **Guards:** byte-compatibility per provider (~4,000 installs); test-seam acceptance (no `vscode` reachable) per migrated arm.
- **Status:** backlog. Pull a subtask forward only when its panel is slated for browser/headless use.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [x] [Verb Engine · 2 — DesignPanelProvider Burndown (62 arms)](../plans/a2b-verb-engine-02-design-panel.md) — **LEAD CODED**
- [x] [Verb Engine · 3 — SetupPanelProvider Burndown (117 arms)](../plans/a2b-verb-engine-03-setup-panel.md) — **LEAD CODED**
- [x] [Verb Engine · 5 — TaskViewerProvider Burndown (110 arms)](../plans/a2b-verb-engine-05-taskviewer-provider.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Completion Report

`DesignPanelProvider`, `SetupPanelProvider`, and `TaskViewerProvider` `_handleMessage` switch arms have been migrated to route VS Code:-specific calls through injected `HostSeams`.

- Added/verified `_seams()` accessors in all three providers.
- Replaced `vscode.commands.executeCommand`, `vscode.window.show*Message`, `vscode.window.showInputBox`, `vscode.window.showQuickPick`, `vscode.window.showOpenDialog`, `vscode.env.openExternal`, `vscode.env.clipboard.writeText`, `vscode.window.withProgress`, `vscode.workspace.getConfiguration`, `vscode.workspace.fs`, and `vscode.window.terminals` usages inside the switch arms with the corresponding `HostSeams`/`HostTerminal` seam methods.
- Removed confirmation gates in `TaskViewerProvider.handleResetDatabase` and `importPlansFromClipboard` per `CLAUDE.md` (no confirmation dialogs policy).
- Extended `HostUI.showOpenDialog` to accept an optional `title` and added missing `pathConfig`/`ui`/`terminal` methods to the headless test-seam harness (`src/test/helpers/verbEngineTestSeams.js`).
- Removed Setup's `_panel` guard and `_getWorkspaceFolderUri` dead calls so the provider can run headlessly.

### Verification
- `npm run compile-tests` passes.
- `npm run parity:check` passes (allowlists ≡ catalogs, generic dispatchers).
- `npm run push-routing:check` passes (raw `.webview.postMessage` counts unchanged).
- `node src/test/verb-engine-headless-seams.test.js` passes (18/18 Design arms under the vscode trap).
- `node scripts/analyze-verb-migration2.js` reports 0 `vscode.*` references inside the `_handleMessage` switch blocks for Design, Setup, and TaskViewer.

### Remaining follow-up
- Per-verb JSON schemas for Setup and TaskViewer verbs were not added (`src/services/verbSchemas.ts` currently only has Design schemas).
- A small number of VS Code: couplings remain **outside** the `_handleMessage` switch blocks (e.g., Design `open()`/`deserializeWebviewPanel()` webview setup, TaskViewer `handleGet*/Set*` setting helpers, and type annotations for `vscode.Terminal`). These do not block the arm-level headless tests but should be migrated when those panels are wired for headless/browser serving.

