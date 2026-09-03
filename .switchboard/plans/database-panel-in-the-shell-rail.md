# A Database panel in the shell rail that owns storage, and the retirement of the Setup tab that half-owns it today

## Goal

Give storage one home: a `database` panel in the shell rail that states where board state actually lives, lets the operator choose an authoritative store, and exposes integrity, backup and projection controls. Delete the Setup panel's "Database Operations" section (in `setup.html`, not `implementation.html` — see the Problem Analysis correction), whose handlers work but are embedded in a settings form rather than an operational surface, and retire the three plans that propose redesigning it.

### Problem Analysis

**Storage has no home, and the surface that half-owns it is a settings form, not an operational surface.** `DATABASE_OPERATIONS_ANALYSIS.md` audits the current panel operation by operation and reaches "Needs verification — handler may be incomplete or missing" for Edit Path, Test Connection, Use Local DB, and the three cloud presets.

  > **Superseded:** "The document is the project's own admission that the surface is a facade: buttons post messages (`editDbPath`, `testDbConnection`, `setLocalDb`, `setPresetDbPath`) whose receivers were never confirmed to exist."
  > **Reason:** The analysis document is stale. The handlers DO exist and work: `editDbPath` at `TaskViewerProvider.ts:15818` (full implementation — input box, path validation, DB migration, config update), `testDbConnection` at `:15861` (opens DB, reports success/failure with error), `setLocalDb` at `:15814`, `setPresetDbPath` at `:15890`. They are delegated through `SetupPanelProvider.ts:971-987`. The "facade" claim was wrong — the buttons work. `DATABASE_OPERATIONS_ANALYSIS.md` should not be relied upon; it references `implementation.html` lines that no longer exist (the controls are in `setup.html`).
  > **Replaced with:** The surface is not a facade — it is a settings form. The handlers work, but a settings form cannot express reachability, sync lag, or authority. The problem is not broken buttons; it is the wrong surface type for a storage topology with failure modes.

**Three plans propose fixing it, and two of them are already dead.** `database-tab-dropdown-redesign.md` adds a dropdown when several databases exist. `multi_root_database_tab.md` enumerates every database across a multi-root workspace and routes mapped roots to the multi-repo tab. Both are UI over the workspace-mapping subsystem that `single-global-database-in-home-store.md` deletes outright — after consolidation there is exactly one database, so a selector between several has nothing to select and a mapped-root redirect points at a subsystem that no longer exists. `workspace_db_mapping_ui_redesign.md` is in the same position.

**And the storage program is about to make storage a real decision.** Once the store is authoritative-and-choosable — local file, libSQL (Turso or self-hosted sqld), or git-carried — the operator needs to see which one is live, whether it is reachable, when it last synced, and what happens if it is not. None of that has anywhere to go today. The Setup panel's Database tab is a settings form; this is an operational surface.

**The rail already accepts new panels without shell changes.** `shell.html` documents its strip as built "from the /panels manifest (data-driven), so adding a panel route later adds a strip icon with no shell code change", and `getPanelsManifest()` in `headlessPanelHtml.ts:547` is a flat array of eleven entries with an `enabled` gate per panel. Adding a twelfth is a manifest entry, a route arm in `LocalApiServer`, a `getPanelHtmlById` case, and a webview.

### Root Cause

Database controls were added incrementally to whichever surface was open at the time — the Setup panel, because DB path was a setting. Storage was a setting when there was one database per repo and nothing to decide. The storage overhaul turns it into a topology with failure modes, and a settings form cannot express reachability, sync lag, or authority.

### Non-goals

- Implementing any store backend. This plan builds the surface; the libSQL, git-carried and tiering plans build what it displays and switches between.
- Changing the DB path resolution logic. It reads whatever the store layer reports.
- Retaining the cloud-folder presets. `retire-cloud-file-sync-db-path-presets.md` removes them; this panel must not resurrect them in a new skin.

## Metadata

**Complexity:** 6
**Tags:** ui, ux, frontend, database, devops, refactor

## User Review Required

None — both decisions resolved by the user (2026-08-26):

1. **Rail placement: bottom cluster.** `placement: 'bottom'` — beside `setup`, in the settings cluster at the foot of the rail.
2. **Store switching: the panel owns it.** The panel offers switching, behind an explicit multi-step flow (not a toggle). Splitting "see your storage" from "change your storage" across two surfaces recreates the half-ownership problem this plan exists to fix.

## Complexity Audit

### Routine

- Manifest entry in `getPanelsManifest()` (`headlessPanelHtml.ts:547`) and a `getPanelHtmlById` case (`:571`).
- Route arm in `LocalApiServer._handleHttpRequest` beside the existing `_handleServePanelById` calls (`:7391` onwards — the `/setup` route is the pattern to copy). Both hosts share this routing: `bootstrap.ts` passes `getPanelHtml` and `getPanelsManifest` to `LocalApiServer` as options (`:3048`), so one route arm serves both.
- A `nav-database.svg` rail icon matching the existing `nav-*.svg` set.
- New `src/webview/database.html` / `database.js` following the `connections.html` pattern (a panel that renders configured integrations and their status is the closest existing analogue).
- Deleting the Database Operations block from `setup.html` (the controls are at lines ~2500–2570, posting `setLocalDb`, `setPresetDbPath`, `setCustomDbPath`, `resetDatabase`, `backupToNotion`, `restoreFromNotion`) and its listeners. Note: `DATABASE_OPERATIONS_ANALYSIS.md` references `implementation.html` lines 1691–1764 and 3956–3973 — those lines no longer exist; the controls were moved to `setup.html`.

### Complex / Risky

- **The panel must render honestly when the store layer is unreachable.** The failure it exists to explain is "the store is unavailable" — so it cannot be a panel that fails to load when the store is down. Every field needs an unknown/unreachable rendering, and status must come from the sidecar's health surface rather than from opening the database.
- **Deleting a shipped surface.** The Setup Database tab exists in released versions. The controls that survive (Edit Path, Test, Use Local DB) must exist in the new panel *before* the old block is deleted, or an install upgrading mid-program loses the only path to a misconfigured database.
- **Two hosts, one panel — the manifest is shared, the sidebar is not.** `getPanelsManifest()` and `getPanelHtmlById()` in `headlessPanelHtml.ts` are used by both `LocalApiServer` (extension) and `bootstrap.ts` (standalone, passed as options at `:3048`). One manifest entry + one route arm in `LocalApiServer._handleHttpRequest` serves both hosts — no divergence risk for the panel itself. The real gap is the VS Code sidebar: `TaskViewerProvider` renders `implementation.html`, not the shell rail, so the sidebar does not get the panel unless a separate view is registered (see Outstanding Questions). The panel reads a status API rather than talking to `KanbanDatabase` directly, so both hosts render from one source.
- **`confirm()` is a silent no-op in VS Code webviews** (per `CLAUDE.md`). The store-switch flow is a multi-step decision surface with a named target and an explicit action button — not a confirm gate, which would make the button do literally nothing.

## Edge-Case & Dependency Audit

**Race conditions**
- Status is polled; a switch in progress must render as in-progress rather than flickering between old and new store. Single-flight the switch and have the status endpoint report it.
- Two hosts open on one machine, both offering a switch. The switch must be idempotent and lease-guarded at the sidecar, not the UI.

**Security**
- Store credentials (a Turso token, a sqld URL with auth) are entered here and must go to `encryptedSecretsStore`, never `settings.json`, and never be echoed back to the webview in full — display a fingerprint, not the token.
- The panel exposes "where is my data" to any browser that can reach the shell. It inherits the shell's auth; it must not weaken it or expose paths pre-auth.

**Side effects**
- `SetupPanelProvider` currently owns the DB-path setting; the surviving verbs move or are re-exposed. The verbs (`setLocalDb`, `setCustomDbPath`, `setPresetDbPath`, `resetDatabase`, `backupToNotion`, `restoreFromNotion`) are posted from `setup.html:2519-2560` and handled in `SetupPanelProvider.ts:971-992` (delegating to `TaskViewerProvider`). Confirm nothing else posts these verbs before deleting the Setup section.
- `fix-kanban-db-error-for-unmapped-workspaces.md` and `feature_plan_20260816164107_kanban-status-bar-db-error-remediation-advice.md` both surface DB errors elsewhere; their remediation advice should point at this panel once it exists.

**Migration**
- No stored state of its own, so nothing to migrate — but the *deletion* half is a shipped-surface removal. Land the new panel first, delete the old block second, in that order, even if both are in one release.

## Dependencies

- **Reads from** the storage-tier split and the store-target layer: this panel displays what those expose. It can be built against a stubbed status contract and wired last.
- **Supersedes** `database-tab-dropdown-redesign.md`, `multi_root_database_tab.md`, and `workspace_db_mapping_ui_redesign.md`. All three should be closed rather than coded.
- **Must not** reintroduce the presets removed by `retire-cloud-file-sync-db-path-presets.md`.

## Adversarial Synthesis

Key risks: (1) a storage panel that cannot render when storage is down is useless precisely when needed; (2) deleting a shipped surface before its replacement is complete strands users with a misconfigured database and no control; (3) a `confirm()` gate on the switch flow would silently do nothing in a VS Code webview; (4) the plan's factual foundation was stale — `DATABASE_OPERATIONS_ANALYSIS.md` claimed the handlers were missing (they exist and work at `TaskViewerProvider.ts:15814-15893`), and every file reference pointed at `implementation.html` when the controls are in `setup.html`. Mitigations: status comes from the sidecar health surface with explicit unknown/unreachable renderings, never from opening the DB; new panel lands before the old block is deleted; the switch is an explicit multi-step flow with a named target, not a confirm gate; the stale analysis document is no longer relied upon and all file/line references have been corrected to the actual source.

## Proposed Changes

1. **`src/webview/database.html` / `database.js` (new)** — three sections:
   - **Store** — the authoritative target: kind, location or fingerprint, reachability, last sync, arbitration guarantee in plain words, and the switch flow.
   - **This machine** — the local runtime tier: file path, size, `PRAGMA integrity_check` result, backup set and last verified backup, export/import.
   - **Projections** — Notion / Linear / ClickUp: enabled, last push, last pull, and a separate break-glass restore control that states in the UI that it overwrites the authoritative store.
2. **Manifest + routes** — `{ id: 'database', label: 'Database', icon: '/static/icons/nav-database.svg', route: '/database', enabled: true, placement: 'bottom' }`, plus the `LocalApiServer` route arm and the `getPanelHtmlById` case.
3. **A read-only status contract** — one endpoint returning store kind, health, sync lag, integrity, backup and projection state, so both hosts and the VS Code sidebar render from one source and the panel survives an unreachable store.
4. **Delete** the Database Operations section from `setup.html` (lines ~2500–2570) and its listeners; re-expose Edit Path, Test and Use Local DB in the new panel first. The surviving verbs (`setLocalDb`, `setCustomDbPath`, `resetDatabase`) keep their `TaskViewerProvider` handlers — only the UI surface moves. The Notion buttons (`backupToNotion`, `restoreFromNotion`) move to the panel's Projections section.
5. **Close** the three superseded plans with a pointer here.

### Migration

No panel-owned state. The removal of the Setup block is ordered after the new panel is functional. Any user documentation or screenshots showing the Setup Database tab need updating.

## Verification Plan

- **Rail registration:** with the panel enabled, assert `/panels` includes `database` and the shell renders a strip icon with no shell-code change; with it disabled, assert no icon.
- **Unreachable store:** point the store at an unreachable target and load the panel. Assert it renders, shows the store as unreachable with a reason, and still shows the local tier's true integrity and backup state.
- **No confirm gates:** grep-level regression asserting `confirm(` appears nowhere in `database.js`, and a webview test that the switch flow's action button performs the switch on first activation.
- **Token hygiene:** enter a store credential; assert it lands in `encryptedSecretsStore`, is absent from `settings.json`, and that the status payload returns a fingerprint rather than the secret.
- **Surviving verbs:** assert Edit Path, Test and Use Local DB work from the new panel before the old block is removed, and that `setPresetDbPath` is absent from the new surface.
- **Both hosts:** render the panel in the browser shell (extension and standalone) against one status payload; assert identical state. The manifest and route are shared, so this is one code path — verify the standalone host's `getPanelsManifest` call at `bootstrap.ts:895` includes the new panel.
- **Supersession:** grep-level regression asserting the Database Operations block and its listener ids are gone from `setup.html` (NOT `implementation.html` — the controls were never there).

### Goal Invariants

- **assert** `getPanelsManifest()` in `headlessPanelHtml.ts` returns an entry with `id: 'database'` and `placement: 'bottom'`.
- **assert** `getPanelHtmlById('database', ...)` returns a non-null `PanelHtmlResult`.
- **assert** `LocalApiServer._handleHttpRequest` has a route arm for `pathname === '/database'` that calls `_handleServePanelById('database', ...)`.
- **assert** `confirm(` appears zero times in `src/webview/database.js` (per CLAUDE.md — confirm is a silent no-op in VS Code webviews).
- **assert** the Database Operations section (posting `setLocalDb`, `setPresetDbPath`, `setCustomDbPath`, `resetDatabase`, `backupToNotion`, `restoreFromNotion`) is absent from `setup.html` after the deletion lands (negative invariant — the retirement).
- **assert** the surviving verbs (`setLocalDb`, `setCustomDbPath`, `resetDatabase`) are posted from `database.js` and still handled by `TaskViewerProvider` (positive invariant — the relocation).
- **assert** `setPresetDbPath` is absent from `database.js` (the presets are retired by `retire-cloud-file-sync-db-path-presets.md`).

## Outstanding Questions

- Should the panel surface cross-workspace storage facts (total size, per-workspace row counts) once one global database holds every workspace, or does that belong to the retention plan's measurement surface?
- Does the VS Code sidebar get this as a view, or does it link out to the browser shell?

## Completion Summary

Implemented the dedicated Database panel in the shell rail, including its manifest entry (`placement: 'bottom'`, `group: 'cold'`), nav icon (`icons/nav-database.svg`), HTML/JS webview files (`src/webview/database.html`, `database.js`), and server routing/status endpoints (`/database`, `/database/status`, `/database/verb/*`). The webview exposes the authoritative store topology, local machine storage metrics and integrity inspection, and external projections (Notion, Linear, ClickUp) with break-glass restore guards and multi-step store switching without any `confirm()` dialogs. Retired the legacy Database Operations section and its click/change listeners from `setup.html`, re-routing all surviving verbs to the new operational surface, and marked the three superseded plans as closed. Both host composition roots (`TaskViewerProvider.ts` and `bootstrap.ts`) and contract routing tests were updated and verified.

