---
description: "Feature management lives as six methods on the ~12,000-line KanbanProvider, so the standalone host — which never constructs that provider — cannot reach it. Extract createFeatureFromPlanIds, assignPlansToFeature, _removeSubtaskFromFeature, _deleteFeature, splitFeature and reconcileFeatures into a host-agnostic FeatureManagementService with injected dependencies; KanbanProvider becomes six thin forwarders. STRICT NO-OP for the extension — gated on golden fixtures captured before any code moves. This plan wires nothing new; it only makes the logic reachable."
---

# Extract a Host-Agnostic FeatureManagementService

## Goal

**Definition of done: the six feature-management operations live in a service with no `vscode` dependency that either host can construct, and the extension's behaviour is byte-for-byte unchanged.**

### Core problem (root-cause analysis)

The standalone (`npx switchboard`) host cannot do feature management because the logic is welded to a provider it never builds.

Six `LocalApiServerOptions` hooks serve seven POST routes, and every one is supplied only by the extension:

| Option | Route(s) | Supplier | Delegates to |
|---|---|---|---|
| `createFeature` | `/kanban/feature` | `TaskViewerProvider.ts:1672` | `KanbanProvider.createFeatureFromPlanIds` |
| `assignToFeature` | `/kanban/feature/assign`, `/kanban/features/assign` | `:1684` | `KanbanProvider.assignPlansToFeature` |
| `removeSubtaskFromFeature` | `/kanban/feature/remove` | `:1696` | `KanbanProvider._removeSubtaskFromFeature` |
| `deleteFeature` | `/kanban/feature/delete` | `:1707` | `KanbanProvider._deleteFeature` |
| `splitFeature` | `/kanban/feature/split` | `:1718` | `KanbanProvider.splitFeature` |
| `reconcileFeatures` | `/kanban/features/reconcile` | `:1729` | `KanbanProvider.reconcileFeatures` |

Each supplier is the same four lines — null-check `this._kanbanProvider`, call one method, wrap errors. **The routes are already shared**; `LocalApiServer` serves both hosts. The gap is that the six *methods* exist only on `KanbanProvider`.

And **the standalone host never constructs `KanbanProvider`.** `src/standalone/bootstrap.ts` hand-rolls a `kanbanVerb` switch (`:578-841`) and re-implements provider behaviour ad hoc where it needs it — its own comments say so: *"mirrors the extension's KanbanProvider subscription"* (`:351`), *"Standalone mirror of `KanbanProvider.improvePlan`"* (`:770`).

#### Why extraction, and not the alternatives

- **Re-implement the six in `bootstrap.ts`** (the `improvePlan` precedent) — **rejected.** This is exactly the divergence the PRD's anti-divergence contract exists to prevent, and it doubles the surface for the orphaned-feature failure that `create-feature.js` explicitly refuses to risk in its own header comment: feature creation *"spans project inheritance, column resolution, a YAML-safe file write, and per-subtask linking — replicating that in raw DB calls risks an orphaned feature (DB record with no file, or unlinked subtasks)."*
- **Construct `KanbanProvider` in the standalone bootstrap** — **rejected.** ~12,000 lines with VS Code coupling far beyond feature management. That is the A2b burndown, not this plan.
- **Extract a host-agnostic domain service** — **chosen.** Precisely the shape PRD contract #3 prescribes: *"extract the shared logic behind the `switchboard.*` commands into host-agnostic domain services so arms don't call `executeCommand`."*

**This plan deliberately wires nothing new.** It ends with the extension behaving identically and the standalone host still returning 503. Making that a separate, gated step is what keeps the risky part of this work reviewable in isolation.

## Metadata
- **Tags:** refactor, backend, reliability
- **Complexity:** 7
- **Project:** browser-switchboard

## User Review Required
- **None.**

## Scope

### ✅ IN SCOPE
1. `src/services/featureManagementService.ts` — a host-agnostic class holding the six operations, dependencies injected via a context object.
2. `KanbanProvider`'s six methods become thin forwarders; all existing callers (including `TaskViewerProvider.ts:1672-1740`) are untouched.
3. Golden fixtures captured from the extension **before** any code moves, and asserted after.
4. A no-`vscode` acceptance test running the operations under the test-seam bundle.

### ⚙️ OUT OF SCOPE
- Supplying any `LocalApiServerOptions` hook in the standalone host, or adding any verb. That is the companion wiring plan; after this plan, standalone still returns 503 and that is the expected end state.
- Behaviour changes of any kind — including ones that look like obvious improvements. If something is wrong, note it and leave it; a behaviour delta inside a move is unreviewable.
- Linear/ClickUp sync on feature creation (has never synced; preserved).
- The feature-file format and the auto-managed `<!-- BEGIN SUBTASKS -->` block.
- `GET /kanban/features` and other read paths.

## Implementation Steps

1. **Capture golden fixtures first.** For each of the seven routes, record the extension's current request→response pairs plus the resulting DB rows and feature-file contents. Include: a create with subtasks, a create with **zero resolvable** subtasks, an assign with a mix of valid/already-attached/missing plan IDs, a remove, a delete with and without `deleteSubtasks`, a split, and a reconcile that creates, assigns and removes. These fixtures are the merge gate — capture them before touching code.
2. **Inventory host coupling.** For each of the six methods, list every `vscode.*` call, `executeCommand`, direct `postMessage`, filesystem write, and provider-private helper it reaches (`_normalizeLegacyKanbanColumn`, `_getCustomKanbanColumns`, `_buildKanbanColumns`, `_regenerateFeatureFile`, and the worktree/tracker helpers used by delete and remove). This inventory defines the injected context.
3. **Create the service** with a context object mirroring the established `KanbanServiceContext` pattern (`KanbanProvider.ts:6958-6980`), including a **live getter** for `workspaceRoot`.
4. **Move the bodies** one operation at a time, smallest first: `assignPlansToFeature` → `_removeSubtaskFromFeature` → `_deleteFeature` → `splitFeature` → `createFeatureFromPlanIds` → `reconcileFeatures`. Re-run the fixtures after each.
5. **Repoint the provider methods** to forwarders.
6. Add the no-`vscode` acceptance test and the tests below.

## Proposed Changes

### New — `src/services/featureManagementService.ts`

- **Context.** The six operations currently live on `KanbanProvider` (`createFeatureFromPlanIds` at `:11840+` and its siblings), reaching provider privates and the broadcaster.
- **Logic.** One class, dependencies injected, no `vscode` import.
- **Implementation.**
  ```ts
  export interface FeatureManagementContext {
      /** Live getter — the extension can switch workspace after construction.
       *  A captured value made path-resolving operations run against the OLD
       *  root; the provider already hit this (see KanbanProvider.ts:6959-6965). */
      get workspaceRoot(): string;
      getDb(root: string): KanbanDatabase;
      seams: HostSeams;
      broadcaster?: BroadcastHub;
      getCustomKanbanColumns(root: string): Promise<any[]>;
      buildKanbanColumns(agents: any[], custom?: any[]): Promise<any[]>;
      normalizeLegacyKanbanColumn(col: string | null | undefined): string | null;
      regenerateFeatureFile(root: string, featurePlanId: string): Promise<void>;
      abandonWorktreeForPlan(root: string, planId: string): Promise<void>;
      unlinkFromTrackers(root: string, planId: string): Promise<void>;
  }

  export class FeatureManagementService {
      constructor(private readonly ctx: FeatureManagementContext) {}
      // createFeature, assignToFeature, removeSubtaskFromFeature,
      // deleteFeature, splitFeature, reconcileFeatures
  }
  ```
- **Edge cases.** No `vscode` import — and the acceptance signal is the operations running under the test-seam bundle with `vscode` unreachable, **not** that the file compiles (PRD contract #3 says this explicitly). The worktree and tracker dependencies are injected rather than reimplemented; dropping them silently is the failure mode called out below.

### `src/services/KanbanProvider.ts` — six forwarders

- **Context.** Six methods, called by `TaskViewerProvider.ts:1672-1740` and internally.
- **Logic.** Bodies move out; signatures and return shapes stay identical.
- **Edge cases.**
  - Preserve the **blank-feature contract** at `:11875-11884` verbatim: `createFeatureFromPlanIds` deliberately succeeds when zero supplied plan IDs resolve, creating a blank feature. The `create-feature-from-plans` skill documents this and describes the delete-and-retry recovery around it. Changing it during the move breaks a documented workflow.
  - Preserve **subtask project inheritance** and its `kanban.activeProjectFilter` fallback (`:11870-11884`) exactly. Note another in-flight plan changes how that fallback resolves — do not pre-empt it here.
  - Preserve the **feature-column self-heal** guard (`recomputeFeatureColumnFromSubtasks`, `:6498-6537`), whose comment documents that a feature's non-`CREATED` column must never be re-derived from subtasks.

### Test seams

- Add `FeatureManagementService` to the existing headless/test-seam harness so the no-`vscode` assertion is mechanical rather than by inspection.

## Complexity Audit

### Routine
- Six forwarders.
- Mirroring an established context-object pattern.

### Complex / Risky
- **This is the plan in the set that can break ~4,000 shipped installs.** Everything else in the feature is additive or browser-only; this moves live, mutating code out of the provider the extension depends on. The fixtures in step 1 are not documentation — they are the merge gate.
- **Side effects must travel with the operations.** `_deleteFeature` abandons child worktrees, tombstones or detaches subtasks, and unlinks external trackers; `_removeSubtaskFromFeature` abandons the subtask's worktree and regenerates the feature file. A move that drops one produces a tombstoned row with an orphaned worktree — worse than the current 503, and silent on the board.
- **`createFeatureFromPlanIds` is the operation `create-feature.js` refuses to reimplement**, for four named reasons: project inheritance, column resolution, YAML-safe file write, per-subtask linking. All four must survive the move intact.
- **`reconcileFeatures` is the largest and least-exercised.** Declarative convergence over paths/slugs/planIds with optional deletion of unmentioned features, and the operation an external agent host is most likely to drive. Extract it last, with its own fixture covering create + assign + remove in one call.
- **Two hosts, two lifetimes.** The extension rebuilds its service context on workspace switch (`_initKanbanService`); standalone has one root for the process. A root captured at construction is a bug the provider already shipped and fixed — the live getter is mandatory.

## Edge-Case & Dependency Audit

- **Race conditions:** feature creation writes into `.switchboard/features/` while `GlobalPlanWatcherService` is watching. The extension deliberately skips the new feature file on import; that exclusion must move with the write, not be left behind in provider code.
- **Security:** no new endpoints, no new input. The seven routes remain `_checkAuth`-gated in `LocalApiServer` and are untouched.
- **Side effects:** all six mutate DB and filesystem; two also touch worktrees and external trackers. Enumerated in step 2 and asserted by test.
- **Migration / shipped state:** no persisted state changes. The extension path must be behaviourally identical — that is the entire acceptance criterion.
- **Dependencies & conflicts:** touches `KanbanProvider.ts`, which the *Cross-Client Project Scope Independence* feature also edits. Per the PRD's one-stream-per-provider-file discipline these **must serialise** — not concurrent. Different methods, no shared helper, so no logical conflict.
- **No confirmation dialogs** are added — including for `deleteFeature`, which deletes immediately (project rule).

## Dependencies

- None blocking. Must **precede** the standalone wiring plan, which consumes this service.
- Serialise against the *Cross-Client Project Scope Independence* subtasks for `KanbanProvider.ts` file access.

## Verification Plan

### Automated Tests
1. **Golden fixtures reproduce byte-for-byte** across all seven routes after the extraction — responses, DB rows, and feature-file contents.
2. **Existing `KanbanProvider` feature tests pass unmodified.** Any test that needs editing is evidence of a behaviour change and must be justified or reverted.
3. **No-`vscode` acceptance.** All six operations run under the test-seam bundle with `vscode` unreachable.
4. **Blank-feature contract.** Zero resolvable plan IDs still returns success and creates a blank feature.
5. **Side effects travel.** `deleteFeature` still abandons child worktrees and unlinks trackers; `removeSubtaskFromFeature` still abandons the subtask worktree and regenerates the feature file.
6. **Live workspace root.** Switching workspace after construction routes a subsequent operation to the new root, not the construction-time one.
7. **`reconcileFeatures` convergence** — a single call that creates a feature, assigns an existing plan by path, and removes an unmentioned one produces the same end state as before the move.
8. **Standalone still 503s.** Explicitly asserted, so the split between this plan and the wiring plan stays honest and a partial wiring cannot land here unnoticed.

### Manual
- In VS Code: create, promote, add subtask, remove subtask, split, and delete a feature; confirm board refresh, feature-file contents, and worktree cleanup match pre-change behaviour.

---

**Recommendation:** Complexity 7 → **Send to Lead Coder.**

**Stage Complete:** CREATED
