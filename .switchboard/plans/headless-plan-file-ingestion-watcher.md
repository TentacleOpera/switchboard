---
description: "Headless (npx) plan-file ingestion: boot-time import, a vscode-free .switchboard/plans watcher, and wiring the stubbed create/scan/import verbs to the real importer — so the standalone board actually ingests plans as the site advertises."
---

# Headless Plan-File Ingestion + Watcher (npx / standalone)

## Goal

Make the standalone `npx switchboard` board **ingest plan files** — at boot, live on file change, and via the board's own buttons — so the headless host honours the promise the marketing site already makes. Today none of these paths work in standalone; the board comes up empty and stays empty.

### Core problems (root-cause analysis)

The standalone host boots `LocalApiServer` + `KanbanDatabase` (`src/standalone/bootstrap.ts`) but **never ingests plans**, through any path:

1. **No boot-time import.** `startHeadlessSwitchboard` creates the DB and starts the server, but never calls `importPlanFiles(workspaceRoot)`. Because `importPlanFiles` is also the only standalone code path that calls `ensureWorkspaceIdentity()` (→ `db.setWorkspaceId()`), a fresh workspace never gets a persisted `workspace_id`. `bootstrap.getWorkspaceId()` reads only the `workspace_id` config key, so `pushFullState`/`getFullState` short-circuit on `!workspaceId` and broadcast *"No workspace configured yet."* → empty board even when `.switchboard/plans/*.md` already exist on disk.

2. **No plan watcher.** `GlobalPlanWatcherService` — the service that live-imports `.switchboard/plans/` (and, per the site, external scanner folders) — is constructed **only** in `src/extension.ts:688` and is built on `vscode.FileSystemWatcher` / `vscode.workspace.*` / `vscode.OutputChannel` / `vscode.Uri` (`GlobalPlanWatcherService.ts:2-35, 408, 435`). It cannot load in the plain-Node standalone process and is never instantiated there. So dropping a `.md` into `.switchboard/plans/` in headless does **nothing** — the exact scenario the docs promise works.

3. **The board's own ingestion buttons are stubs.** The webview posts `{type:'createPlan'|'scanFoldersNow'|'importFromClipboard'}`; the transport shim routes these to `/kanban/verb/<verb>` (`src/webview/transport.js:26,144-148`) → `bootstrap.ts:521-524`, where all three `return { success:true }` and do nothing. The real, working logic already exists behind REST routes `POST /kanban/plans` (`LocalApiServer._handleCreatePlan`, `:2060`) and `POST /kanban/plans/import` (`:2235`), both of which call `importPlanFiles` — but the shipped UI never calls them in standalone.

### Why this matters (advertised, not aspirational)

`switchboard-site` sells headless as feature-complete minus terminals:

- `docs/getting-started/headless-switchboard.md`: *"the same `.switchboard/` workspace, and the same `kanban.db` the extension uses; the only thing missing is the editor around it."* The **only** documented headless limitation is agent terminals / CLI dispatch / autoban / orchestrator.
- `docs/board/kanban-board/creating-plans.md`: *"drop a markdown file into `.switchboard/plans/` yourself — **the watcher imports it**."*
- Passive, file-based plan entry ("work enters *passively*… Open at every seam") is a headline differentiator on `docs/getting-started/how-switchboard-compares.md` and the landing page.

Headless is precisely the surface aimed at GUI-agent users (Claude Desktop et al.) who *write plan files* and expect them to appear. The feature is advertised, central, and currently non-functional.

## Metadata
- **Plan ID:** ed88bf95-0993-4c8e-939b-431c72317f36
- **Tags:** standalone, npx, headless, plan-watcher, ingestion, bug
- **Complexity:** 5
- **Release phase:** Post-MVP headless. Closes the ingestion gap in the shipped `npx` MVP (`extract-standalone-npx-04`). No VS Code / extension behaviour changes.

## User Review Required
- **Fidelity tier for Phase 2 (feature-file handling).** MVP reuses `importPlanFiles`, which does *not* parse feature subtasks / recompute feature columns / sync providers the way the extension watcher does. Confirm that "plans + feature files import as plain cards, provider sync stays extension-only" is acceptable for headless v1 (recommended), or whether feature-column recompute must ship in this plan.
- **External scanner folders.** The site's "Plan Scanner" (Claude Code / Antigravity / Cursor / Devin / custom paths) is broader than `.switchboard/plans/`. This plan scopes the `.switchboard/plans/` watcher only; external-folder scanning in headless is called out as a follow-up. Confirm that split.

## Scope

### ✅ IN SCOPE
- **Boot-time import.** Call `importPlanFiles(workspaceRoot)` once during `startHeadlessSwitchboard`, before the first `pushFullState`, so identity is seeded and existing plans load immediately.
- **Headless watcher (`src/standalone/`).** A vscode-free watcher over `<workspaceRoot>/.switchboard/plans/` (top level + one `<repoScope>/` layer, matching `importPlanFiles`' scan shape): native `fs.watch` (recursive where supported, with a non-recursive fallback), per-file debounce (coalesce editor save churn / atomic temp+rename), plus a periodic reconcile timer as a backstop for missed events. On any add/change → `importPlanFiles`; on delete → `KanbanDatabase.purgeOrphanedPlans` (or targeted tombstone). Push board state after each batch.
- **Config reuse.** Honour `switchboard.planWatcher.periodicScanEnabled` (default `true`) and `switchboard.planWatcher.scanIntervalMs` (default `10000`, clamp 2000–300000) via `StandaloneHostPathConfigProvider`, so headless matches documented settings.
- **Wire the stub verbs to real logic.** `createPlan` → `_handleCreatePlan` logic; `scanFoldersNow` / `importFromClipboard` → `importPlanFiles` (+ clipboard payload parse for the latter). Board buttons work without the browser hitting REST directly.
- **Lifecycle + single-writer.** Watcher starts after server ready, disposes on SIGINT/SIGTERM shutdown (clear timers, close `fs.watch` handles). No behaviour change to the existing `api-server-port.txt` single-writer guard.

### ⚙️ OUT OF SCOPE
- **External plan-scanner folders** (Claude Code / Antigravity brains / Cursor / Devin / custom Setup paths) in headless — follow-up plan; this covers `.switchboard/plans/` only.
- **Provider sync** (ClickUp/Linear debounced sync on import) — standalone already stubs those services to `null` (`bootstrap.ts` `getClickUpService/getLinearService` → `null`); no regression, just not added here.
- **Feature-subtask recompute / feature-file regeneration** beyond plain import (gated by the User-Review decision above).
- **Any change to `GlobalPlanWatcherService` or `src/extension.ts`.** The extension path stays byte-for-byte unchanged (protects the ~4,000-install VSIX). If shared logic is extracted, it must be additive and import-neutral for the extension.

## Implementation Steps

1. **Boot import** — in `startHeadlessSwitchboard`, after `db.ensureReady()` and before the server's first state push, `await importPlanFiles(workspaceRoot)` (wrapped in try/catch + `log()`), so identity seeds and cards populate on first load.
2. **`StandalonePlanWatcher`** — new `src/standalone/planWatcher.ts`: constructor `(workspaceRoot, onChanged, config)`; `start()` registers `fs.watch` on the plans dir (+ existing `<repoScope>/` subdirs) and a `setInterval` reconcile; `_debounce(file)` coalesces events; add/change → `importPlanFiles`, delete → orphan purge; `dispose()` tears everything down. Reuse the extension watcher's debounce constants/semantics for parity, but no `vscode` import.
3. **Instantiate in bootstrap** — create + `start()` the watcher after `server.start()`; on each import batch call `pushFullState()`; add `dispose()` to the returned `instance.stop()`.
4. **Verb wiring** — replace the three stub cases in `bootstrap.ts` `kanbanVerb` with calls into the real importer/create logic; `importFromClipboard` parses the clipboard markdown payload then imports. Return the same shapes the webview expects.
5. **Config plumbing** — read `planWatcher.*` keys from `StandaloneHostPathConfigProvider` (add defaults if the provider doesn't already surface them).
6. **Docs reconciliation** — verify `headless-switchboard.md` / `creating-plans.md` now match reality; adjust copy if any sub-behaviour (e.g. external scanner folders) remains extension-only, so the site never over-promises again.

## Complexity Audit

### Routine
- Boot-time `importPlanFiles` call and `pushFullState` after import.
- Verb-stub replacement (logic already exists behind REST handlers).
- Config key reads with clamping.

### Complex / Risky
- **Native `fs.watch` reliability** across platforms: `recursive` is unsupported on Linux in older Node (mitigated by Node 22+ floor, but confirm), duplicate/rename event storms, atomic temp+rename writes firing delete-then-add. The periodic reconcile is the safety net; debounce must coalesce.
- **Deletion semantics** — `importPlanFiles` is upsert-only. Choosing purge-orphaned vs targeted tombstone, and not nuking cards for transient editor churn (honour the confirmation-delay logic `purgeOrphanedPlans` already has).
- **No extension regression** — if any code is shared/extracted, the extension target must not pick up standalone-only deps or behaviour changes (VSIX-content parity, per the npx-distribution plan's release gate).

## Edge-Case & Dependency Audit

### Race Conditions
- Watcher fires before first `pushFullState` → boot import (Step 1) runs first; watcher only starts post-`server.start()`.
- Atomic save (temp → rename) surfacing as delete+create → debounce window + reconcile backstop prevents a card from flickering out.
- Concurrent import batches (rapid multi-file drop) → serialize imports or debounce at the batch level so `insertFileDerivedPlan` isn't racing itself on the same in-memory DB.

### Security / Integrity
- Watch only inside `<workspaceRoot>/.switchboard/plans/`; ignore symlinks escaping the tree; skip runtime-mirror files (`isRuntimeMirrorPlanFile`, already handled by `importPlanFiles`).
- No new network surface; no new auth path — ingestion is local FS only.

### Side Effects
- `import_registry_migrated` / legacy JSON migration already runs inside `ensureReady`/`_runConfigMigrations`; boot import must not double-migrate (it won't — guarded by the config flag).
- Periodic reconcile must be cheap on large plan sets (bounded scan: top level + one subdir layer, same as importer).

### Dependencies & Conflicts
- Builds on the shipped MVP: `extract-standalone-npx-04-npx-distribution.md` (5674b039), `standalone-headless-core-service-bootstrap.md`, `standalone-headless-transport-shim.md`.
- Reuses existing `PlanFileImporter.importPlanFiles`, `WorkspaceIdentityService.ensureWorkspaceIdentity`, `KanbanDatabase.purgeOrphanedPlans` — no new external deps.
- Must not touch `GlobalPlanWatcherService` / `extension.ts` (VSIX isolation).

## Adversarial Synthesis

The central risk is a flaky native watcher: platform-dependent `fs.watch` behaviour producing missed events (board goes stale) or event storms (redundant imports, card flicker on atomic writes). Mitigation is defense-in-depth — debounce + a periodic reconcile backstop + upsert-idempotent imports — so correctness never depends on catching every raw FS event. The second risk is scope-honesty: reusing `importPlanFiles` means feature files import as plain cards and providers don't sync in headless; if that's not explicitly documented, the site over-promises again — hence the docs-reconciliation step and the User-Review gate. The extension path is deliberately untouched to protect the shipped VSIX.

## Proposed Changes

### `src/standalone/bootstrap.ts`
- **Context:** Boots DB + server; never imports plans; `getWorkspaceId` reads only the config key; three ingestion verbs are stubs.
- **Logic:** Boot-time `importPlanFiles`; instantiate + start `StandalonePlanWatcher`; push state on import; wire real logic into `createPlan`/`scanFoldersNow`/`importFromClipboard`; dispose watcher in `stop()`.
- **Edge Cases:** Import failure must not crash boot (try/catch + log); watcher only after server ready.

### `src/standalone/planWatcher.ts` (new)
- **Context:** No headless watcher exists; `GlobalPlanWatcherService` is vscode-bound.
- **Logic:** Native `fs.watch` + debounce + periodic reconcile over `.switchboard/plans/`; add/change → import, delete → purge; config-driven interval; full `dispose()`.
- **Edge Cases:** recursive-watch unsupported → non-recursive fallback; atomic-rename delete+create; symlink escape guard.

### `src/standalone/hostServices.ts` (`StandaloneHostPathConfigProvider`)
- **Context:** File-backed config provider.
- **Logic:** Surface `planWatcher.periodicScanEnabled` / `planWatcher.scanIntervalMs` with documented defaults.
- **Edge Cases:** clamp interval 2000–300000; boolean coercion.

### `switchboard-site` docs (reconciliation only)
- **Context:** Site claims headless imports dropped plan files and is "same workspace minus editor."
- **Logic:** After code lands, verify claims hold; annotate any behaviour that stays extension-only (external scanner folders / provider sync / feature recompute).
- **Edge Cases:** Keep the headline promise ("drop a file → it imports") true; scope the fine print honestly.

## Verification Plan

### Automated Tests
- `StandalonePlanWatcher` unit tests: add fires import; modify re-imports; delete purges; debounce coalesces a rapid rewrite into one import; periodic reconcile catches a missed event (simulated).
- Boot-import test: fresh workspace with pre-existing `.switchboard/plans/*.md` → after boot, `getWorkspaceId()` is set and `getFullState()` returns those cards (no "No workspace configured yet").
- Verb tests: `createPlan` verb writes+imports a plan; `scanFoldersNow` picks up a dropped file; `importFromClipboard` imports a pasted payload.
- Extension-parity guard: `GlobalPlanWatcherService` / `extension.ts` unchanged; VSIX-content diff clean (release checklist item from the npx-distribution plan).

### Manual
- `npx switchboard` in a fresh dir → board loads; drop a `.md` into `.switchboard/plans/` → card appears within the debounce/scan window; edit it → card updates; delete it → card leaves. All without VS Code.
- The **+ Add Plan** / **Scan Folders** / **Import from Clipboard** board buttons work in the browser.
- Start extension on the same workspace after stopping npx → identical board (single-writer, same `kanban.db`).

**Stage Complete:** CREATED
