---
description: "Ingestion piece 1 of 3: extract the vscode-bound GlobalPlanWatcherService into a host-agnostic PlanIngestionEngine behind a host seam, and re-wire the extension onto it via a thin VS Code adapter. A behaviour-preserving refactor — no standalone code — verified by a shared behavioural suite driven through a fake seam plus a VSIX-content parity gate. The foundation the standalone-ingestion and provider-sync pieces consume."
---

# Headless Ingestion 1 — Shared Engine Extraction + VS Code Adapter

## Goal

**Definition of done: `GlobalPlanWatcherService`'s ingestion behaviour is extracted into one host-agnostic `PlanIngestionEngine`, the extension runs on it via a thin VS Code adapter, and the extension behaves identically to before** — verified by a shared behavioural suite (through a fake host seam) and a VSIX-content parity gate. This piece adds **no standalone code**; it is the pure refactor that pieces 2 (standalone ingestion) and 3 (provider sync) build on.

### Core problem (root-cause analysis) — shared context for all three ingestion pieces

Headless ingests nothing today (empty board on boot; dropping a `.md` does nothing; create/scan/import buttons are stubs). The deeper cause is that the entire ingestion engine, `GlobalPlanWatcherService`, is welded to VS Code and constructed only in `src/extension.ts:719` (import at `:11`; the extension passes its provider factories via `(kanbanProvider as any)._getClickUpService` / `._getLinearService`). The tempting fix — reimplement a thin slice in standalone — produces **two divergent ingestion paths** that never stay in sync, so the extension and headless behave differently forever and the site's "same workspace, same board" promise is false.

The coupling does not justify that. Measured against the source, `GlobalPlanWatcherService` touches only a thin, fully-abstractable vscode surface: `Uri`→paths; `getConfiguration`→a config seam (standalone already has `StandaloneHostPathConfigProvider`); `createFileSystemWatcher`/`RelativePattern`→native `fs.watch`, **already implemented as a fallback** (`:566`); `OutputChannel`→a logger; `Disposable`/`EventEmitter`→trivial shims; `workspaceFolders`→the watched-roots list. The genuinely rich logic (feature-column recompute, feature-file regeneration, provider sync) is **already dependency-injected** (`setFeatureColumnRecomputer`, `setFeatureFileRegenerator`, `getClickUp`/`getLinear`), so it is not vscode-locked. **Conclusion: extract, don't reimplement — one engine, two host adapters.**

> This is piece 1 of a 3-piece ingestion set (all three must ship for parity — they are phases, not options): **(1) engine + VS Code adapter [this plan]**, (2) standalone ingestion, (3) headless provider sync.

## Metadata
- **Tags:** standalone, npx, headless, plan-watcher, ingestion, refactor, engine-extraction
- **Complexity:** 6
- **Project:** Browser Switchboard
- **Release phase:** Headless go-live foundation and the **highest-risk** ingestion piece — it rewrites the extension's live ingestion path (~4,000 installs). Carries the VSIX-parity release gate. Pieces 2 and 3 depend on it.

## Scope

### ✅ IN SCOPE
- **`PlanIngestionEngine` (new, host-agnostic)** holding every current behaviour of `GlobalPlanWatcherService`: plan discovery, `_handlePlanFile` upsert (incl. `is_feature` re-assert), `_handlePlanDelete`, feature-column recompute, feature-file regeneration, project stamping from `kanban.activeProjectFilter`, brain-mirror skip, debounce, periodic scan, startup scan — depending on a `PlanIngestionHost` seam instead of `vscode`.
- **The `PlanIngestionHost` seam interface:** `{ watchFactory, config, logger, listWatchedRoots, onRootsChanged }`.
- **The engine's provider surface is exactly the two constructor factories the current watcher already carries — `getClickUpService` and `getLinearService`, and nothing else.** Verified against source: the ingestion path fires **ClickUp real-time `debouncedSync`** on `_handlePlanFile` (`GlobalPlanWatcherService.ts:1047`) and **Linear `archiveIssue`** only on delete/purge (`:531`). There is **no Notion factory** on the watcher/engine — Notion sync is a `KanbanProvider.queueIntegrationSync*` (column-move) concern, out of this engine entirely. Preserve exactly these two factories through the extraction; do **not** invent a Notion slot on the seam (piece 3 wires to this exact surface). Note: the watcher's ingest-path provider hooks are separate from the merged `RemoteProvider` column-move sync seam and from the cross-provider parity work tracked in `provider-sync-full-parity.md` — this extraction only needs to preserve the two watcher hooks byte-for-byte.
- **VS Code adapter** — `GlobalPlanWatcherService` becomes a thin shell that constructs the engine with a vscode-backed seam and **preserves its public API** (`initialize`, `setFeatureColumnRecomputer`, `setFeatureFileRegenerator`, `registerPendingCreation`, disposal), so `extension.ts` is essentially untouched.

### ⚙️ OUT OF SCOPE (later pieces)
- Any standalone adapter / bootstrap wiring / verb wiring → **piece 2**.
- Real headless provider factories → **piece 3**.
- Terminals/CLI dispatch — permanently VS Code-only.

## Implementation Steps
1. **Define the host seam** (`PlanIngestionHost`): watcher factory (create/dispose a recursive path watcher emitting add/change/delete), config getters, logger, watched-roots provider + change signal.
2. **Extract `PlanIngestionEngine`** from `GlobalPlanWatcherService`: move all non-vscode logic verbatim; replace `vscode.Uri`→paths, `OutputChannel`→logger, `getConfiguration`→config getter, `createFileSystemWatcher`→the seam's watch factory. Keep the injected feature/provider callbacks as-is.
3. **VS Code adapter** — `GlobalPlanWatcherService` constructs the engine with a vscode-backed host seam; public API preserved; `extension.ts` unchanged.
4. **Shared behavioural suite** exercising the engine through a **fake host seam** (add/change/delete plain plans, feature files with column recompute + regen, brain-mirror skip, debounce coalescing, periodic-reconcile recovery, project stamping) — parity becomes a passing suite, not a claim.

## Complexity Audit
- **Complex / Risky:** the extraction rewrites the extension's live ingestion path. Mitigation: the VS Code adapter preserves the public API and behaviour byte-for-byte; the shared suite + VSIX-content parity gate are the guards; land behind review with the extension exercised end-to-end.

## Edge-Case & Dependency Audit
- Must NOT diverge the extension: VSIX-content parity gate is mandatory.
- Reuses the existing injected feature/provider callbacks unchanged (no behaviour change to recompute/regen/sync in this piece).
- No standalone surface introduced here, so no new runtime risk beyond the refactor itself.

## Adversarial Synthesis
The failure this piece guards against is a botched refactor silently changing extension ingestion behaviour. The structural defence is the preserved public API + a single behavioural suite run through a fake seam + a VSIX-content parity gate: any behavioural drift shows up as a failing test or a VSIX diff, not a field report.

## Proposed Changes
### `src/services/PlanIngestionEngine.ts` (new)
- Host-agnostic engine holding all discovery/import/delete/feature/project/debounce/scan behaviour, depending on the `PlanIngestionHost` seam. No `vscode` import.
### `src/services/GlobalPlanWatcherService.ts`
- Becomes a thin VS Code adapter over the engine; public API preserved; behaviour byte-stable.

## Verification Plan
### Automated
- **Shared behavioural suite** via a fake host seam (the full behaviour list in Step 4).
- **Extension parity gate:** `extension.ts` behaviourally unchanged; VSIX-content diff clean.
### Manual
- Extension: existing plan ingestion (create/edit/delete, feature recompute/regen, project stamping) behaves exactly as before the refactor.

**Stage Complete:** CREATED
