# Headless Feature Management — Hardening

**Complexity:** 5

## Goal

Close the residual risks the 2026-07-29 code review of Headless Feature Management identified: automate the destructive and convergence paths (reconcileFeatures, delete/split side effects, watcher exclusion, WS board push) that the review suite could not carry, collapse the two feature-file writers into one by delegating the standalone ingestion callbacks to the now-constructed real KanbanProvider, and repair the verb-engine kanban seam harness whose duplicate pathConfig key left the kanban config-seam contract unguarded — then CI-wire every suite so none of these gates can silently rot again.

## How the Subtasks Achieve This

- **Headless Feature Management — Destructive & Convergence Path Tests** (Cx 5): Adds the second contract suite the review deferred — `reconcileFeatures` convergence (the operation external agents drive unattended), `deleteFeature`/`splitFeature`/`removeSubtaskFromFeature` side effects including worktree-row abandonment, watcher exclusion with a *running* `PlanIngestionEngine`, the WS board push over a real socket, and a live hook-route smoke. Reuses the two proven harnesses (shim-mapped provider construction; real `LocalApiServer` + `ws` client) and CI-wires itself in the same change.
- **Standalone Ingestion Feature Callbacks — Delegate to the Real Provider** (Cx 3): `headlessFeatureCallbacks.ts` exists because "standalone has no KanbanProvider" — false since the parent feature landed. Re-points the ingestion engine's two callbacks at the provider's real public methods (the exact lambdas `extension.ts:749-761` uses) and deletes the mirror, eliminating the two-writer divergence class (hardcoded `DEFAULT_KANBAN_COLUMNS` vs custom columns) at the root instead of pinning it with a byte-identity test. Zero changes to `KanbanProvider.ts`.
- **Fix the Verb-Engine Kanban Seam Harness (and CI-Wire the Verb-Engine Suites)** (Cx 2): Merges the duplicate `pathConfig` key in `verbEngineTestSeams.js` that silently killed the harness's `config` option (the `getDbPath` seam test has been red since it was written, 2026-07-16), diagnoses the `_initKanbanService` seam-rebuild clobber harness-side only, and closes the gate-wiring hole: the verb-engine contract suites are defined in `package.json` but invoked by no CI step.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Headless Feature Management — Destructive & Convergence Path Tests](../plans/headless-feature-destructive-path-tests.md) — **PLAN REVIEWED**
- [ ] [Standalone Ingestion Feature Callbacks — Delegate to the Real Provider](../plans/standalone-feature-callbacks-provider-delegation.md) — **PLAN REVIEWED**
- [ ] [Fix the Verb-Engine Kanban Seam Harness (and CI-Wire the Verb-Engine Suites)](../plans/fix-verb-engine-kanban-seam-harness.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**No hard dependencies** — each subtask is independently shippable. Two soft preferences:

| # | Subtask | Constraint |
|---|---|---|
| 1 | Delegate callbacks to the provider | Prefer first: removing the second feature-file writer means the test subtask never has to pin two-writer byte-identity (its plan already assumes a single writer). |
| 2 | Destructive & convergence tests | Best after #1. Also edits `.github/workflows/integration-tests.yml` — serialise with #3 on that file. |
| 3 | Verb-engine seam harness fix | Fully independent of #1/#2 in logic; shares only the CI workflow file with #2 — land their CI edits sequentially, not concurrently. |

Shared-file contention: `.github/workflows/integration-tests.yml` (#2, #3 — both append steps; serialise) and `src/standalone/bootstrap.ts` (#1 only). Nothing here touches `src/services/KanbanProvider.ts`, so this feature contends with no provider-file work stream.
