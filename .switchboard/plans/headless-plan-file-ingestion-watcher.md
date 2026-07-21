---
description: "Full headless (npx) plan-ingestion PARITY: extract the vscode-bound GlobalPlanWatcherService into one host-agnostic ingestion engine that BOTH the extension and the standalone host consume. No MVP subset, no follow-ups — headless ingests exactly what the extension does (local plans, external scanner folders, feature recompute/regen, deletes, project stamping, provider sync). Verified by one shared behavioural suite run against both hosts."
---

# Headless Plan-Ingestion — Full Parity via a Shared Engine

## Goal

**Definition of done: the standalone `npx switchboard` host ingests plans identically to the VS Code extension.** Same triggers, same results, same edge-case handling — verified by a single behavioural test suite executed against *both* hosts. The only thing headless is permitted to lack is agent terminals / CLI dispatch (which the site already scopes to VS Code). Everything the site advertises about plans "entering from anywhere" MUST work headless.

This plan does **not** ship a subset. There is no "MVP tier," no "feature files as plain cards," no "external folders later." Those carve-outs are the exact reason headless can't go live, and they are explicitly rejected here.

### Core problem (root-cause analysis)

Headless ingests nothing today (empty board on boot; dropping a `.md` does nothing; the create/scan/import buttons are stubs). The deeper cause — and the reason every prior attempt scoped down — is that the entire ingestion engine, `GlobalPlanWatcherService`, is welded to VS Code and constructed only in `src/extension.ts:688`. Faced with that, the tempting move is to reimplement a thin slice (`importPlanFiles`) in standalone and defer the rest. That produces **two divergent ingestion paths** that will never stay in sync, so the extension and headless behave differently forever and the site's "same workspace, same board" promise is false.

The coupling does not actually justify the scope-down. Measured against the source, `GlobalPlanWatcherService` touches only a thin, fully-abstractable vscode surface:

- `vscode.Uri` / `Uri.file` → plain filesystem paths.
- `vscode.workspace.getConfiguration` → a config-provider seam (standalone already has `StandaloneHostPathConfigProvider`).
- `vscode.workspace.createFileSystemWatcher` / `RelativePattern` / `FileSystemWatcher` → **native `fs.watch`, which the service already implements as a fallback** (`:566`).
- `vscode.OutputChannel` → a logger interface.
- `vscode.Disposable` / `vscode.EventEmitter` → trivial host-neutral shims.
- `vscode.workspace.workspaceFolders` / `onDidChangeWorkspaceFolders` → the watched-roots list (single root in standalone).

The genuinely rich logic — feature-column recompute, feature-file regeneration, provider (ClickUp/Linear) sync — is **already dependency-injected as callbacks/factories** (`setFeatureColumnRecomputer`, `setFeatureFileRegenerator`, the `getClickUp`/`getLinear` constructor args), so it is not vscode-locked at all. Headless can supply its own implementations backed by the host-agnostic `KanbanDatabase`.

Conclusion: extract, don't reimplement. One engine, two host adapters.

## Metadata
- **Plan ID:** ed88bf95-0993-4c8e-939b-431c72317f36
- **Tags:** standalone, npx, headless, plan-watcher, ingestion, parity, refactor
- **Complexity:** 7
- **Release phase:** Headless go-live blocker. This is the gate on advertising headless as parity-complete. Touches the extension's ingestion path, so it carries the VSIX-parity release gate from `extract-standalone-npx-04`.

## User Review Required
- **None on scope.** Scope is fixed: full parity. The decisions a prior draft deferred to you (feature fidelity, external folders, provider sync) are all resolved as *in scope*.
- **One implementation choice to confirm:** whether the shared engine lands as a new `src/services/PlanIngestionEngine.ts` that `GlobalPlanWatcherService` becomes a thin vscode adapter over (recommended — cleanest separation), **or** `GlobalPlanWatcherService` is refactored in place to accept an injected host-seam object with a vscode default. Both reach parity; the first is more testable, the second is a smaller extension diff. Default to the first unless you object.

## Scope

### ✅ IN SCOPE (all of it — this is the parity contract)
- **Extract a host-agnostic ingestion engine** holding every current behaviour of `GlobalPlanWatcherService`: plan discovery, `_handlePlanFile` upsert (incl. `is_feature` re-assert), `_handlePlanDelete`, feature-column recompute, feature-file regeneration, project stamping from `kanban.activeProjectFilter`, brain-mirror skip, debounce, periodic scan, startup scan.
- **A host-seam interface** the engine depends on instead of `vscode`: `{ watchFactory, config, logger, listWatchedRoots, onRootsChanged }`. Ship two implementations:
  - **VS Code adapter** — wraps `createFileSystemWatcher` + `workspace.*` (existing behaviour, byte-for-byte).
  - **Standalone adapter** — native `fs.watch` (recursive with non-recursive fallback) + `StandaloneHostPathConfigProvider` + a console logger + single-root.
- **Extension re-wired onto the engine** via the VS Code adapter — no behavioural change, verified by the shared suite + VSIX-content parity.
- **Standalone wired onto the engine** in `bootstrap.ts`: boot-time full scan (seeds `workspace_id` via the same identity path), live watching of `.switchboard/plans/` **and** the external scanner folders (Claude Code / Antigravity app+IDE+CLI brains / Cursor / Devin / custom Setup paths), deletes, feature handling.
- **Provider sync in headless.** Replace `bootstrap.ts`'s `getClickUpService`/`getLinearService`/`getNotionService` `() => null` stubs with real factories backed by the existing `clickup.json`/`linear.json` metadata paths + `StandaloneHostSecrets`, so provider-linked plans sync headless as the site claims ("syncs with Linear, Notion, and ClickUp").
- **Wire the stub verbs** (`createPlan`/`scanFoldersNow`/`importFromClipboard`) to the engine so the board buttons drive the same path as file drops.
- **Config parity.** `switchboard.planWatcher.periodicScanEnabled` / `scanIntervalMs` and the Setup watched-folders list resolve identically in both hosts.

### ⚙️ OUT OF SCOPE (only the genuinely host-locked)
- **Agent terminals / CLI dispatch / autoban / orchestrator** — require the VS Code terminal host (and the separately-backlogged node-pty fleet). The site already scopes these to VS Code; they are not ingestion.
- Nothing else. If a behaviour exists in the extension's ingestion path and is not terminal-bound, it is in scope.

## Implementation Steps

1. **Define the host seam** (`PlanIngestionHost` interface): watcher factory (create/dispose a recursive path watcher returning add/change/delete events), config getters, logger, watched-roots provider + change signal.
2. **Extract `PlanIngestionEngine`** from `GlobalPlanWatcherService`: move all non-vscode logic verbatim; replace `vscode.Uri` with paths, `OutputChannel` with the logger, `getConfiguration` with the config getter, `createFileSystemWatcher` with the seam's watch factory. Keep the injected feature/provider callbacks as-is.
3. **VS Code adapter** — `GlobalPlanWatcherService` becomes a thin shell: constructs the engine with a vscode-backed host seam; keeps its public API (`initialize`, `setFeatureColumnRecomputer`, `setFeatureFileRegenerator`, `registerPendingCreation`, disposal) so `extension.ts` is essentially untouched.
4. **Standalone adapter** — `src/standalone/planIngestionHost.ts`: native `fs.watch` recursive (with per-platform fallback + periodic reconcile), `StandaloneHostPathConfigProvider`-backed config, console logger, single/Control-Plane roots.
5. **Bootstrap wiring** — construct the engine with the standalone adapter; boot-time `scanAll()` before first state push; supply headless implementations of feature recompute/regen (backed by `KanbanDatabase`) and real provider factories; push board state on every ingestion batch; dispose on SIGINT/SIGTERM.
6. **Verb wiring** — `createPlan`/`scanFoldersNow`/`importFromClipboard` call the engine (create-then-ingest / scan-now / parse-clipboard-then-ingest).
7. **Shared behavioural suite** — one test file exercising the engine through a **fake host seam**, plus thin per-host integration tests proving the VS Code and standalone adapters feed the engine equivalently. Parity is a passing suite, not a claim.
8. **Docs check** — confirm `headless-switchboard.md` / `creating-plans.md` / `plan-scanner.md` are now true for headless; correct only if some behaviour remains terminal-bound.

## Complexity Audit

### Routine
- Standalone adapter (native fs.watch + config + logger).
- Verb wiring and boot scan.
- Provider factory wiring (metadata paths + secrets already exist).

### Complex / Risky
- **Extension regression risk** — the engine extraction rewrites the extension's live ingestion path. Mitigation: the VS Code adapter preserves the public API and behaviour; the shared suite + VSIX-content parity gate are the guards; land behind review with the extension exercised end-to-end.
- **Native `fs.watch` fidelity** — recursive support varies; atomic temp+rename → delete+add storms; editor churn. Mitigation: debounce (reuse the engine's existing constants) + periodic reconcile backstop + idempotent upsert.
- **Feature recompute/regen in headless** — must match the extension's KanbanProvider logic. Mitigation: back the headless callbacks with the same `KanbanDatabase` primitives the provider uses; assert equivalence in the shared suite.

## Edge-Case & Dependency Audit

### Race Conditions
- Boot scan vs first `pushFullState` → scan runs first; watcher starts post-`server.start()`.
- Atomic save surfacing as delete+create → debounce + reconcile prevents card flicker.
- Concurrent multi-file drops → batch/serialize imports against the single in-memory DB.

### Security / Integrity
- Watch only inside configured roots; ignore symlink escapes; skip brain-mirror/runtime-mirror files (engine already does).
- Provider secrets read via `StandaloneHostSecrets` only; no new network surface beyond the providers the user configured.

### Side Effects
- Legacy JSON migration already runs in `ensureReady`; boot scan must not double-migrate (config-flag guarded).
- Periodic reconcile bounded to the same scan shape as the extension.

### Dependencies & Conflicts
- Builds on shipped MVP `extract-standalone-npx-04` (5674b039), core bootstrap, transport shim.
- Must NOT diverge the extension: VSIX-content parity gate is mandatory.
- Reuses `KanbanDatabase`, `ensureWorkspaceIdentity`, `purgeOrphanedPlans`, existing provider services.

## Adversarial Synthesis

The failure mode this plan exists to prevent is *silent divergence*: a headless subset that looks done but behaves differently from the extension, so "parity" is asserted and untrue. The structural defense is a single shared engine with one behavioural suite run against both hosts — parity becomes falsifiable, not a promise. The counter-risk is regressing the shipped extension (~4,000 installs) by rewriting its ingestion path; the VS Code adapter's preserved API, the shared suite, and the VSIX-content parity gate contain that. The remaining real risk is native `fs.watch` fidelity, handled by debounce + reconcile + idempotent import so correctness never depends on catching every raw FS event. Terminals are the one honest exclusion — and the site already draws that line.

## Proposed Changes

### `src/services/PlanIngestionEngine.ts` (new)
- **Context:** Ingestion logic currently trapped inside a vscode class.
- **Logic:** Host-agnostic engine holding all discovery/import/delete/feature/project/debounce/scan behaviour, depending on a `PlanIngestionHost` seam.
- **Edge Cases:** No `vscode` import; all platform/host specifics behind the seam.

### `src/services/GlobalPlanWatcherService.ts`
- **Context:** The vscode-bound engine + watcher, constructed in `extension.ts`.
- **Logic:** Becomes a thin VS Code adapter over the engine; public API preserved.
- **Edge Cases:** Behaviour byte-stable; `extension.ts` largely untouched; VSIX parity.

### `src/standalone/planIngestionHost.ts` (new) + `bootstrap.ts`
- **Context:** No headless ingestion exists; provider factories stubbed to null.
- **Logic:** Native-fs.watch host seam; boot scan; engine wiring; headless feature-recompute/regen callbacks; real provider factories; verb wiring; disposal.
- **Edge Cases:** recursive-watch fallback; clipboard parse; single/Control-Plane roots.

### `src/standalone/hostServices.ts`
- **Context:** File-backed config + secrets.
- **Logic:** Surface `planWatcher.*` and the watched-folders list; provide provider secrets to the factories.

### `switchboard-site` (reconciliation only)
- **Context:** Site claims headless imports from `.switchboard/plans/` and external folders and syncs providers.
- **Logic:** After parity lands, claims are true; adjust only if a behaviour is genuinely terminal-bound.

## Verification Plan

### Automated Tests
- **Shared behavioural suite** driven through a fake host seam: add/change/delete of plain plans, feature files (column recompute + regen), external-folder discovery, brain-mirror skip, debounce coalescing, periodic-reconcile recovery of a missed event, project stamping.
- **Per-host integration:** the VS Code adapter and the standalone adapter each feed the engine equivalently for a representative fixture set (same inputs → same DB state).
- **Boot-import:** fresh workspace with pre-existing plans → `workspace_id` seeded, board non-empty.
- **Extension parity gate:** `extension.ts` behaviourally unchanged; VSIX-content diff clean.

### Manual
- `npx switchboard` in a fresh dir → board populates; drop/edit/delete a `.md` in `.switchboard/plans/` → card appears/updates/leaves; drop a plan in a configured external folder → it appears; a provider-linked plan syncs.
- Board **+ Add Plan / Scan Folders / Import from Clipboard** all work headless.
- Stop npx, open the same workspace in the extension → identical board and identical behaviour on the same operations.

**Stage Complete:** CREATED
