---
description: "Ingestion piece 2 of 3: wire the standalone (npx) host onto the extracted PlanIngestionEngine. Native fs.watch host seam, boot-time full scan, live watching of .switchboard/plans/ AND the external scanner folders, deletes, headless feature recompute/regen callbacks backed by KanbanDatabase, and the create/scan/import verb wiring. Depends on piece 1 (the engine + seam). Additive — zero extension risk."
---

# Headless Ingestion 2 — Standalone Ingestion (adapter + bootstrap + verbs)

## Goal

**Definition of done: `npx switchboard` ingests plans identically to the extension** — boot-time scan seeds the board, dropping/editing/deleting a `.md` in `.switchboard/plans/` and in the external scanner folders updates the board live, feature files recompute their column and regenerate, and the board's +Add Plan / Scan Folders / Import from Clipboard buttons drive the same engine path as a file drop.

### Core problem (root-cause analysis) — shared context for all three ingestion pieces

Headless ingests nothing today: empty board on boot, file drops do nothing, and the create/scan/import verbs are **fake-success no-ops** — verified against source, `createPlan` / `scanFoldersNow` / `importFromClipboard` are three fall-through `case` labels that all resolve to `return { success: true }` at `bootstrap.ts:521-524`; the `default` arm at `:527` returns `"Verb '<verb>' not implemented in standalone mode"` only for *unknown* verbs. A fake `{success:true}` is arguably worse than an explicit failure — the board button reports success while nothing ingests. Piece 1 extracts the host-agnostic `PlanIngestionEngine` behind a `PlanIngestionHost` seam; this piece supplies the **standalone** implementation of that seam and wires it into the standalone bootstrap so headless drives the exact same engine as the extension — no second ingestion path.

> Piece 2 of 3 (all three ship for parity — they are phases, not options): (1) engine + VS Code adapter, **(2) standalone ingestion [this plan]**, (3) headless provider sync. Depends on piece 1.

## Metadata
- **Tags:** standalone, npx, headless, plan-watcher, ingestion, bootstrap
- **Complexity:** 6
- **Project:** Browser Switchboard
- **Release phase:** Headless go-live blocker; additive standalone code (no extension path change, so no VSIX gate). Depends on piece 1's engine + seam.

## Scope

### ✅ IN SCOPE
- **Standalone host seam** (`src/standalone/planIngestionHost.ts`): native `fs.watch` recursive (with per-platform non-recursive fallback + periodic reconcile), `StandaloneHostPathConfigProvider`-backed config, console logger, single/Control-Plane roots.
- **Bootstrap wiring:** construct the engine with the standalone seam; boot-time `scanAll()` before the first state push (seeds `workspace_id` via the same identity path); supply **headless implementations of feature-column recompute + feature-file regeneration** backed by `KanbanDatabase` (matching the extension's KanbanProvider logic); push board state on every ingestion batch; dispose on SIGINT/SIGTERM.
- **Live watching** of `.switchboard/plans/` **and** the external scanner folders (Claude Code / Antigravity app+IDE+CLI brains / Cursor / Devin / custom Setup paths), plus deletes.
- **Verb wiring:** `createPlan` (create-then-ingest), `scanFoldersNow` (scan-now), `importFromClipboard` (parse-clipboard-then-ingest) call the engine so the board buttons match file drops — replacing the `bootstrap.ts:521-524` fake-success arms.
- **Config parity:** `switchboard.planWatcher.periodicScanEnabled` / `scanIntervalMs` and the Setup watched-folders list resolve identically in both hosts.

### ⚙️ OUT OF SCOPE
- Real provider (ClickUp/Linear/Notion) factories → **piece 3** (this piece leaves the engine's provider callbacks as the current `() => null` until piece 3 lands).
- The engine/seam extraction itself → **piece 1**.
- Terminals/CLI dispatch.

## Implementation Steps
1. **Standalone adapter** — `planIngestionHost.ts`: native `fs.watch` recursive **inside a `try/catch` that falls back to a per-subdirectory non-recursive tree-walk on `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`** (BSD/Solaris, old Node), plus periodic reconcile, plus a `fs.watchFile` polling option for WSL/network-mount roots; directory-exclusion rules (`.git`, `node_modules`, build artifacts) to avoid inotify exhaustion; `null`-`filename` events fall back to a root rescan; config via `StandaloneHostPathConfigProvider`, console logger, roots list.
2. **Bootstrap wiring** — construct the engine with the standalone adapter; boot-time `scanAll()` before first `pushFullState`; watcher starts post `server.start()`.
3. **Headless feature callbacks** — implement `featureColumnRecomputer` + `featureFileRegenerator` backed by the same `KanbanDatabase` primitives the extension's provider uses. **Note: standalone has no `KanbanProvider`** — the extension's `recomputeFeatureColumnFromSubtasks` (public, `KanbanProvider.ts:6145`) and `_regenerateFeatureFile` (private, called at `KanbanProvider.ts:4541` and throughout the move/import paths) are VS Code-coupled and unavailable headless. Reimplement the two callbacks directly against `KanbanDatabase`, following the DB-direct pattern the bootstrap already uses for column moves (`moveSessionsToColumn`, `bootstrap.ts:381`). Extract any shared column-derivation logic if practical, but do not depend on `KanbanProvider`.
4. **Verb wiring** — replace the `bootstrap.ts:521-524` fake-success arms: `createPlan` / `scanFoldersNow` / `importFromClipboard` → engine.
5. **Disposal** — dispose watcher + engine on SIGINT/SIGTERM.
6. **Standalone integration test** — the standalone adapter feeds the engine equivalently to the VS Code adapter for a representative fixture set (same inputs → same DB state).

## Complexity Audit
- **Complex / Risky:** native `fs.watch` fidelity (recursive support varies; atomic temp+rename → delete+add storms; editor churn). Mitigation: debounce (reuse the engine's constants) + periodic reconcile backstop + idempotent upsert.
- **Complex / Risky:** feature recompute/regen must match the extension. Mitigation: back the headless callbacks with the same `KanbanDatabase` primitives; assert equivalence in the shared suite (piece 1) + the standalone integration test.

## Edge-Case & Dependency Audit
- **Races:** boot scan runs before first `pushFullState`; watcher starts post-`server.start()`; atomic save (delete+create) handled by debounce + reconcile; concurrent multi-file drops serialized against the single in-memory DB.
- **Integrity:** watch only inside configured roots; ignore symlink escapes; skip brain-mirror/runtime-mirror files (engine already does).
- **Migration:** legacy JSON migration already runs in `ensureReady`; boot scan must not double-migrate (config-flag guarded).
- **Depends on:** piece 1 (engine + seam); reuses `KanbanDatabase`, `ensureWorkspaceIdentity`, `purgeOrphanedPlans`.
- **Shared file with piece 3:** both this piece and piece 3 edit `bootstrap.ts` and `hostServices.ts`. This piece lands the engine-construction call with `() => null` provider callbacks; piece 3 amends that same call to pass the two real provider factories. Land piece 2 first (ordering dependency), then piece 3 edits the region this piece created — no merge, distinct concerns in sequence.

## Adversarial Synthesis
The risk is native `fs.watch` missing or duplicating events, making headless behave subtly differently. Handled by debounce + periodic reconcile + idempotent import so correctness never depends on catching every raw FS event — the same shape the extension already uses.

## `fs.watch` platform behaviour (confirmed via research — supersedes the earlier "Linux unsupported" assumption)
- **Recursive support IS available on Linux** as of **Node.js v19.1.0** (via libuv nested-inotify tracking), in addition to macOS (`FSEvents`) and Windows (`ReadDirectoryChangesW`), plus AIX/IBMi. It is **NOT** available on BSD/FreeBSD or Solaris/SmartOS. So the earlier "macOS/Windows only" framing was wrong — do not assume Linux needs the manual tree-walk fallback on a modern Node.
- **Unsupported platform = a thrown error, not a silent no-op.** On **Node ≥14.0.0**, passing `{ recursive: true }` on an unsupported platform throws `TypeError` code **`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`**. The standalone adapter MUST `try/catch` the recursive `fs.watch` construction and, on that error, drop to the non-recursive tree-walk (attach a watcher per subdirectory) — the recursive call cannot be assumed to succeed everywhere and will hard-throw when it can't.
- **Still keep the fallback + periodic-reconcile backstop** for: BSD/Solaris (no recursive), Node <19.1.0 on Linux, and WSL/`/mnt/c`/Docker-shared/network mounts where OS events don't cross the virtualization boundary (there, allow a `fs.watchFile` polling fallback). Correctness must never depend on catching every raw FS event.
- **Documented event caveats to defend against** (all handled by the engine's debounce + reconcile + idempotent upsert, but the adapter must not fight them): duplicate/fired-twice events on a single write; the atomic-save delete→rename dance producing transient `rename` + `ENOENT` (stat/verify existence before read); `filename` can arrive `null` under load → fall back to rescanning the watched root; inotify watch-exhaustion on large trees → enforce directory-exclusion rules (`.git`, `node_modules`, build artifacts) so recursive watching does not hit `/proc/sys/fs/inotify/max_user_watches`.

## Proposed Changes
### `src/standalone/planIngestionHost.ts` (new)
- Native-`fs.watch` host seam implementing `PlanIngestionHost` (recursive + fallback + reconcile), config, logger, roots.
### `src/standalone/bootstrap.ts`
- Construct the engine with the standalone adapter; boot scan; headless feature recompute/regen callbacks; verb wiring (replace the `:521-524` fake-success arms); disposal.
### `src/standalone/hostServices.ts`
- Surface `planWatcher.*` and the watched-folders list.

## Verification Plan
### Automated
- **Standalone integration:** the standalone adapter feeds the engine equivalently to the VS Code adapter for a representative fixture set.
- **Boot-import:** fresh workspace with pre-existing plans → `workspace_id` seeded, board non-empty.
### Manual
- `npx switchboard` in a fresh dir → board populates; drop/edit/delete a `.md` in `.switchboard/plans/` → card appears/updates/leaves; drop a plan in a configured external folder → it appears.
- Board **+ Add Plan / Scan Folders / Import from Clipboard** all work headless.
- Stop npx, open the same workspace in the extension → identical board.

**Stage Complete:** CREATED
