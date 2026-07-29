---
description: "src/standalone/headlessFeatureCallbacks.ts reimplements KanbanProvider's feature-column recompute and feature-file regeneration because — per its own header — 'standalone has no KanbanProvider'. That premise is now false: bootstrap constructs the real provider (Headless Feature Management, 2026-07-29). The mirror has already drifted (stale line citations; hardcodes DEFAULT_KANBAN_COLUMNS while the provider consults custom columns), and two writers now regenerate the same feature files in one process. Re-point the ingestion engine's two callbacks at the provider's real public methods — the exact lambdas extension.ts:749-761 already uses — and delete the mirror. Zero changes to KanbanProvider.ts."
---

# Standalone Ingestion Feature Callbacks — Delegate to the Real Provider

## Goal

**Definition of done: one — and only one — implementation of feature-column recompute and feature-file regeneration exists in the standalone process, and it is `KanbanProvider`'s own; `headlessFeatureCallbacks.ts` is deleted and the ingestion engine's callbacks are wired the same way the extension wires them.**

### Core problem (root-cause analysis)

`src/standalone/headlessFeatureCallbacks.ts` opens with its own justification:

> *"The extension's `KanbanProvider.recomputeFeatureColumnFromSubtasks` and `KanbanProvider._regenerateFeatureFile` are VS Code-coupled and unavailable headless (**standalone has no `KanbanProvider`**). These factories reimplement the two callbacks directly against `KanbanDatabase`…"*

Since the *Headless Feature Management* feature landed (2026-07-29), that premise is false: `bootstrap.ts:536-545` constructs the real `KanbanProvider` under the shim, and the six feature hooks plus three UI verbs already run its real code. The mirror is now the **second of two writers** regenerating the same feature files in one process, and it exhibits exactly the drift the feature's design record predicted ("mirrored copies drift", cited as reason #3 against ever adding a third copy):

1. **Stale citations:** the header pins behaviour to `KanbanProvider.ts:6213` (recompute) and `:10971` (regen); the real locations are `:6619` and `:11581`.
2. **Column-model divergence:** `headlessFeatureCallbacks.ts:26/:37` builds its column ordinal map from hardcoded `DEFAULT_KANBAN_COLUMNS`, while the provider's regenerator consults the workspace's **custom** kanban columns. With custom columns configured, the two writers can produce different subtask status labels for the same DB state. Both carry a no-op-skip guard, so they don't fight in a loop — but each divergent rewrite advances the feature file's mtime, and **plan-file mtime advance is the board's completion signal**, so the drift isn't cosmetic.

The extension already solved this exact wiring problem, and its shape is the template. `extension.ts:749-761`:

```ts
globalPlanWatcher.setFeatureColumnRecomputer(
    (featurePlanId, watchedRoot) =>
        kanbanProvider?.recomputeFeatureColumnFromSubtasks(featurePlanId, watchedRoot) ?? Promise.resolve()
);
globalPlanWatcher.setFeatureFileRegenerator(
    (ws, fid) => kanbanProvider?.regenerateFeatureFile(ws, fid) ?? Promise.resolve()
);
```

Both provider methods are **public** with the right signatures: `recomputeFeatureColumnFromSubtasks(featurePlanId, workspaceRoot)` at `KanbanProvider.ts:6619` and the `regenerateFeatureFile(workspaceRoot, featureId)` wrapper at `:11774`. `bootstrap.ts` needs the same two lambdas pointed at its `kanbanProvider`, replacing the mirror wiring at `bootstrap.ts:270-271`. `KanbanProvider.ts` changes by zero lines.

### The ordering wrinkle (the only real work)

Bootstrap currently wires the mirror callbacks at `:270-271`, **before** the provider exists (`:536`). The fix is to move the two `ingestionEngine.setFeatureColumnRecomputer/setFeatureFileRegenerator` calls to after the provider's construction. Between engine initialization and that point there is a window where feature-file ingestion could fire a callback:

- If the engine's initial scan starts before `:536`, either delay `ingestionEngine.initialize()` until after the provider is constructed, or accept the window with null-guarded lambdas exactly like the extension's (`kanbanProvider?.… ?? Promise.resolve()`). Read the bootstrap's actual initialize timing before choosing; prefer whichever preserves the current startup sequence with the smallest diff.

## Metadata
- **Tags:** refactor, reliability, backend
- **Complexity:** 3
- **Project:** browser-switchboard

## User Review Required
- **None.** Deleting the mirror rather than patching its column model is the decision, and it is the feature design record's own stated direction ("It avoids a third copy of the feature-file regenerator" — this plan removes the second).

## Scope

### ✅ IN SCOPE
1. In `bootstrap.ts`: wire `setFeatureColumnRecomputer` / `setFeatureFileRegenerator` to `kanbanProvider.recomputeFeatureColumnFromSubtasks` / `kanbanProvider.regenerateFeatureFile`, after provider construction, resolving the ordering wrinkle above.
2. Delete `src/standalone/headlessFeatureCallbacks.ts` and its imports (`bootstrap.ts:29-30`). Grep confirms bootstrap is the only consumer.
3. A regression test pinning the delegation: with custom kanban columns configured in the temp workspace DB, a watcher-driven regeneration produces subtask labels from the **custom** columns (the exact divergence the mirror had), and the bootstrap source no longer references `headlessFeatureCallbacks`.

### ⚙️ OUT OF SCOPE
- **Any change to `src/services/KanbanProvider.ts`** — both needed methods are already public.
- Changing `PlanIngestionEngine`'s callback setter API (stable, shared with the extension path).
- Byte-identity testing between the two writers — meaningless once there is one writer; the destructive-paths test plan already dropped it for this reason.
- Migration/compat shims for the deleted module: it is compiled into the standalone bundle, has no persisted state, and nothing outside `bootstrap.ts` imports it. Whether or not an npx build has shipped, deleting an internal module is not a shipped-state migration concern.

## Implementation Steps

1. Read `bootstrap.ts`'s engine initialization sequence around `:250-271` and determine whether the initial scan can fire before `:536`; choose the ordering resolution accordingly (move setters vs. null-guarded early wiring).
2. Replace the two callback wirings with provider-delegating lambdas (extension shape).
3. Delete `headlessFeatureCallbacks.ts` and the imports.
4. Add the regression test (extend `src/test/headless-feature-management-contract.test.js` — it already constructs the provider and seeds a DB; one custom-columns case and one source contract).
5. Run the full verification battery below.

## Proposed Changes

### `src/standalone/bootstrap.ts`

- **Context.** Engine constructed and mirror callbacks set at `:269-271`; provider constructed at `:536-545`.
- **Logic.** Same engine, same setters, real implementation.
- **Implementation.**
  ```ts
  // Feature callbacks delegate to the real provider (the mirror in
  // headlessFeatureCallbacks.ts was written when standalone had no
  // KanbanProvider; it drifted — hardcoded DEFAULT_KANBAN_COLUMNS — and is
  // deleted). Same lambdas as extension.ts.
  ingestionEngine.setFeatureColumnRecomputer(
      (featurePlanId, watchedRoot) => kanbanProvider.recomputeFeatureColumnFromSubtasks(featurePlanId, watchedRoot)
  );
  ingestionEngine.setFeatureFileRegenerator(
      (ws, fid) => kanbanProvider.regenerateFeatureFile(ws, fid)
  );
  ```
- **Edge cases.** The provider methods resolve their DB via `KanbanDatabase.forWorkspace` — the same process-wide instance the engine uses, so no dual-instance hazard (verified during the feature's planning). The provider's regenerator registers watcher suppression via the `PlanIngestionEngine` static, so engine-driven regeneration cannot re-trigger itself.

### `src/standalone/headlessFeatureCallbacks.ts`

- Deleted. If any behaviour of the mirror is discovered to be intentionally different from the provider's (none is documented), that is a finding to surface, not silently preserve.

## Complexity Audit

### Routine
- Two lambdas, one file deletion, one import cleanup.

### Complex / Risky
- **The ordering wrinkle is the entire risk.** A callback firing in the pre-provider window with naive wiring is a TDZ/undefined crash at startup. Resolve it deliberately (step 1), don't discover it in production.
- **Behavioural delta is intended:** custom-columns workspaces will see *changed* (corrected) subtask labels after an ingestion-driven regen. That is the fix, not a regression — but note it in the completion summary.

## Edge-Case & Dependency Audit

- **Race conditions:** two writers previously converged via no-op guards; with one writer the class disappears. The provider's regenerator is already reentrancy-safe under the extension's heavier call pattern (ten call sites).
- **Security:** none — no new inputs or endpoints.
- **Side effects:** ingestion-driven regens now also get the provider's suppression registration and custom-column awareness. No tracker sync is triggered by regeneration.
- **Migration / shipped state:** none (see out-of-scope rationale).
- **Dependencies & conflicts:** edits `bootstrap.ts` — serialise with any other in-flight plan touching it (the destructive-paths test plan does not; it only reads). Zero contention on `KanbanProvider.ts`.
- **No confirmation dialogs** are added.

## Dependencies

- **None hard.** Best landed before or alongside *Headless Feature Management — Destructive & Convergence Path Tests*, which assumes a single writer (it dropped the byte-identity pin on this plan's promise).

## Verification Plan

### Automated Tests
1. Source contract: `bootstrap.ts` contains the two provider-delegating setter calls and no reference to `headlessFeatureCallbacks`; the file itself is gone.
2. Behavioral: with custom kanban columns in the DB, `regenerateFeatureFile` output labels subtasks by the custom columns (the mirror's divergence case, now asserted against the single remaining writer).
3. Existing suites stay green: `test:contract:headless-feature-mgmt`, `npm run compile-tests`, lint, parity/push-routing/verb-returns/catalog gates.

### Manual
- `npx switchboard` in a workspace with custom columns: drop a subtask `.md` deletion on disk, confirm the parent feature file's `## Subtasks` block regenerates with custom-column labels and the board updates.

---

**Recommendation:** Complexity 3 → **Send to Coder.**

**Stage Complete:** CREATED
