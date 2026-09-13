# VS Code Becomes a Sidebar, and Stops Being a Second Host

**Complexity:** 9

## Goal

The extension keeps its sidebar and loses everything else: no editor panels, and no board of its own. It spawns or attaches to the standalone host and talks to it over HTTP like the browser does. One host, one UI, one implementation.

Two hosts is the single largest source of defects in this codebase, by its own account. The defence against it is three parity gates — and the rule itself records that `standalone-parity:check` is *"scoped to the browser read-back path, not the composition root"* — so it does not catch the class it was built for. Removing the extension as a second host eliminates the entire class of bug.

## How the Subtasks Achieve This

- **Stage 1 — The Panels Leave the Editor**: Deletes the 7 `createWebviewPanel` sites that have browser equivalents and redirects their commands to open the browser. Also deletes `DiagramRenderer` (dead code). `ConnectionsPanelProvider` is deferred (no browser equivalent yet). Reversible, low-risk, no data path change.
- **Stage 2 — The Extension Stops Being a Host**: The extension stops constructing `LocalApiServer` in-process and instead spawns the standalone host with `--detach` (survives window close) or attaches to an already-running host via `findRunningInstance`. The parity checkers are rewritten as assertions that the extension holds no host state. This is the stage that eliminates the two-hosts divergence.
- **Stage 2b — vscodeShim Removal**: Deletes `vscodeShim.ts` (645 lines) and removes `import * as vscode from 'vscode'` from 28 service files (280 call sites in TaskViewerProvider alone). Services become "the product" instead of "shared". The standalone host keeps the shim until this stage lands — Stage 2 does not depend on 2b.
- **Stage 3 — The Sidebar Becomes a Host Client**: The sidebar stops imitating the board and becomes a status panel: host status, fleet liveness, open-in-browser. Read-only — it must not become a second board.
- **Stage 4 — Migrate VS Code Settings to the Settings Window**: 96 configuration keys are classified and ~91 are migrated to the settings window's store. Each key is read once from VS Code config and written to the host. Blocked on the settings window plan delivering a durable write surface.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Stage 1 — The Panels Leave the Editor](../plans/vs-code-becomes-a-sidebar-and-stops-being-a-host.md) — **PLAN REVIEWED** — ID: d9672359-0280-4d4c-80bf-3c72c88284a8
- [ ] [Stage 2 — The Extension Stops Being a Host](../plans/extension-spawns-or-attaches-to-standalone-host.md) — **PLAN REVIEWED** — ID: 50e67f9d-028b-49f1-88ee-7060b1d34afc
- [ ] [Stage 2b — vscodeShim Removal](../plans/vscode-shim-removal.md) — **PLAN REVIEWED** — ID: 0c68a9c6-bd0d-48b2-93ea-e57cee79f512
- [ ] [Stage 3 — The Sidebar Becomes a Host Client](../plans/sidebar-becomes-a-host-client.md) — **PLAN REVIEWED** — ID: 736e9701-2646-431f-92c1-58c5adda13c5
- [ ] [Stage 4 — Migrate VS Code Settings to the Settings Window](../plans/migrate-vscode-settings-to-settings-window.md) — **PLAN REVIEWED** — ID: 43da4bd6-b690-4f9b-bda5-8832f7381a5e
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Stage 1 → Stage 2**: Stage 1 (panels → browser) must land before Stage 2 (extension → client). Ship in separate releases so a regression has one cause.
- **Stage 2 → Stage 2b**: The extension must stop being a host before the shim removal makes sense. Stage 2 does not depend on 2b — the standalone host keeps the shim until 2b lands.
- **Stage 2 → Stage 3**: The sidebar can only become a client after the extension stops being a host.
- **Stage 2 → Stage 4**: Settings migration requires the extension to be a client (reading from the host, not from VS Code config).
- **Stage 4 → settings window plan**: Stage 4 is blocked on `settings-window-and-the-write-path-review-deleted.md` delivering a durable write surface. That plan is at `kanbanColumn: CREATED` with its write path un-delivered.
- **Stage 1 and Stage 2 must not ship in one release.** Stage 1 is reversible and low-risk; Stage 2 changes where the database lives for every extension user.
