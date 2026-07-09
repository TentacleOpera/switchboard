# Project panel fixes

**Complexity:** 4

## Goal

Fix two independent defects in `PlanningPanelProvider`'s Project-panel surfacing that both present as a **duplicate or misplaced PROJECT panel**. These subtasks are grouped because they edit the *same* method (`openProject()` / `_doOpenProject()`) and must ship with a single, consistent reveal contract — reconciling them is the whole point of the feature. The feature eliminates: (a) a **duplicate PROJECT tab** created by a serializer-restore race after a window reload when `switchboard.persistPanels` is on; and (b) a **steal-back** where clicking *Review Plan* yanks a Project panel out of an auxiliary ("Move Editor into New Window") window back into the main IDE window, un-minimising it.

## How the Subtasks Achieve This

- **Review Plan opens a duplicate Project panel instead of targeting the one moved to a new window**: swaps the reveal target at all **four** Project-panel reveal sites from `reveal(vscode.ViewColumn.One)` (which *relocates* the panel into the main window) to `reveal(undefined, true)` (reveal in place, preserve focus). A floated panel is therefore never dragged back and the main window is never raised/un-minimised; the plan selection already routes correctly via `postMessage`. This subtask **owns the feature's reveal-target contract**.
- **Fix: Project panel duplicate on window restore (serializer ghost)**: adds a `_projectPanelRestoring` guard — armed only when a `switchboard-project` ghost tab is detected via the TabGroups API — so `openProject()` briefly waits (`_waitForRestore`, ≤1.5s) for VS Code's deferred serializer instead of creating a second panel; and disposes a late-arriving ghost in `deserializeProjectPanel` if a fresh panel already exists. It builds its guard *around* the reveal sites the sibling corrects, and its reveal calls defer to the reveal-target contract above.

## Dependencies & sequencing

- **(a) Cross-feature dependencies:** none. Both subtasks build on the already-present `_projectPanelOpening` promise lock (predecessor plan `feature_plan_20260708095648_review-plan-tab-pileup-race-condition.md`); neither modifies it.
- **(b) Shipping order within this feature (they are NOT independent — shared surface):**
  1. **Reveal-target subtask first** — *"Review Plan opens a duplicate Project panel…"*. It fixes the four reveal sites to their final form (`reveal(undefined, true)`).
  2. **Serializer-ghost subtask second** — *"…duplicate on window restore"*. It then wraps the restore guard around those already-corrected reveal sites.
  Rationale: landing the guard first would reintroduce `reveal(vscode.ViewColumn.One)` in its `openProject()` code, which the reveal-target subtask would then have to unwind. Ordering removes the churn.
- **(c) Prerequisites / guards:** `switchboard.persistPanels` (default **off**) gates *only* the serializer-ghost subtask — with it off, that subtask is a no-op and no serializer/flag exists. The reveal-target subtask applies regardless of `persistPanels`.
- **(d) API behavior confirmed (web research 2026-07-09):** `reveal(undefined, true)` reveals a floated panel *in place* in its auxiliary window (explicit `ViewColumn.One` is what steals it back); `tabGroups.all` enumerates aux-window groups with correct `TabInputWebview.viewType`; the serializer fires for aux-floated webviews; lazy background restoration (deferred `deserializeWebviewPanel`) is real. Both subtask designs are validated — no open API questions remain. **Deferred follow-up (out of scope):** because reveal is now confirmed non-destructive, the `isProjectInCurrentWindow()` caller gate could be removed so hidden main-window Project tabs also surface on Review Plan (touches `KanbanProvider`/`TaskViewerProvider` — wider blast radius).

### Reconciled shared-surface end-state (authoritative — implement to this one design)

Both subtasks touch `PlanningPanelProvider`. The single reconciled end-state for every contended symbol:

| Symbol / site | Reveal-target subtask | Serializer-ghost subtask | Reconciled end-state |
| :-- | :-- | :-- | :-- |
| `openProject()` reveal calls (opening-await branch, existing-panel fast path) | → `reveal(undefined, true)` | adds `_projectPanelRestoring` guard + `_waitForRestore()` around them | Guard block **and** `reveal(undefined, true)` at every reveal — never `ViewColumn.One` |
| `_doOpenProject()` existing-panel guard reveal | → `reveal(undefined, true)` | adds `_projectPanelRestoring = false` to its `onDidDispose` | Both changes apply (different lines, no conflict) |
| `_doOpenProject()` `createWebviewPanel(..., ViewColumn.One, ...)` | **unchanged** | **unchanged** | **Unchanged** — a brand-new panel still docks in main-window column one |
| `revealProject()` reveal | → `reveal(undefined, true)` | not touched | `reveal(undefined, true)` |
| `deserializeProjectPanel()` | not touched | clears `_projectPanelRestoring` + disposes incoming ghost if `_projectPanel` already set | Serializer-ghost version |
| `_projectPanelOpening` clear-sites (3× `onDidDispose` + `_updateWebviewRoots` catch @7946) | not touched | each also clears `_projectPanelRestoring` | Serializer-ghost version (all **four** sites) |
| `isProjectInCurrentWindow()` / `hasProjectPanel()` | retained, no longer safety-critical | not touched | Unchanged |

There is **no contradiction left** after reconciliation: the only true overlap was the reveal target inside `openProject()`, resolved by making the serializer-ghost plan defer to the reveal-target plan (recorded as a Superseded callout in that plan's Change 4).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix: Project panel duplicate on window restore (serializer ghost)](../plans/fix_project-panel-restore-serializer-ghost-duplicate.md) — **PLAN REVIEWED**
- [ ] [Review Plan opens a duplicate Project panel instead of targeting the one moved to a new window](../plans/feature_plan_20260709092124_review-plan-steals-project-panel-from-new-window.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

