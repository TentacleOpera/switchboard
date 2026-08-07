# Standalone Kanban Column-Parity Audit

## Metadata

**Complexity:** 6
**Tags:** backend, refactor, reliability, api
**Project:** Browser Switchboard

## Goal

Audit every standalone-host kanban column/verb behavior against its extension-host equivalent, classify each as parity / diverges / editor-only, and close the divergences — so adding a new built-in column (like DISPATCH) does not require a per-column standalone fix to keep the two hosts in sync.

### Problem

The Standalone Board Parity feature (`standalone-board-parity-aa872dcc`) wired the `default:` verb fallthrough and fixed silent settings/command failures, but it deliberately left the **explicit-case verbs** in `bootstrap.ts`'s hand-written switch alone — `moveSelected`, `promptSelected`, and the `triggerAction` dispatch path all call `getNextKanbanColumn`, a hardcoded map that duplicates the extension's `_getNextColumnId` logic with no visibility awareness and no awareness of columns added after the map was written. The parity feature's triage classified these as "works" because they return `{success: true}` and move cards — the divergence is behavioral, not functional, and only manifests when a new column lands between existing ones (DISPATCH is the first).

### Root Cause

Two independent next-column resolution implementations exist: `_getNextColumnId` (KanbanProvider, walks `_buildKanbanColumns()` in order with `shouldSkip` visibility/feature-only/disabled gating) and `getNextKanbanColumn` (bootstrap.ts, a static `Record<string,string>` map with no gating). The parity feature unified verb *routing* (the `default:` arm) but not verb *logic* (the explicit cases that carry their own column-resolution). Any column-aware behavior authored in the extension must be manually mirrored in the standalone map, and there is no test or gate that detects the drift.

## Background

The standalone host (`src/standalone/bootstrap.ts`) drives the same shared board HTML as the extension. The parity feature established that the `default:` arm delegates to `KanbanProvider.handleServiceVerb`, but the hand-written cases above it (`moveSelected` ~817, `promptSelected` ~846, `triggerAction` dispatch ~1241) retain standalone-specific logic. Three call sites use `getNextKanbanColumn` (line 128): a 9-entry hardcoded map with no `DISPATCH` entry and no visibility check. The extension's `_getNextColumnId` (KanbanProvider:5687) walks the built column list in order and applies `shouldSkip` (skips `featureOnly`, hidden roles via `visibleAgents[role]===false`, `dragDropMode==='disabled'`, inactive ACCEPTANCE TESTED). The standalone map cannot replicate this because it receives only `sourceColumn` — it has no access to `visibleAgents`, custom columns, or column ordering.

`getNextKanbanColumn` is not the only candidate divergence. The `isDispatchColumn` check at bootstrap:834 (`dragDropMode === 'cli' && !!targetDef.role`) determines whether `moveSelected` dispatches to a terminal or moves-only; the extension's equivalent lives inside the `moveCardForward` handler in KanbanProvider and may use different criteria. Any hardcoded lookup, column-order assumption, or visibility check in bootstrap that duplicates extension logic is a parity hazard.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Audit scope | All explicit-case verbs in bootstrap's `kanbanVerb` switch + all standalone helper functions that duplicate extension column logic | The parity feature covered the `default:` arm; this audit covers everything it deliberately left alone. |
| Classification | parity / diverges / editor-only (same four-outcome scheme as the parity feature's triage) | Reuses the established vocabulary; "editor-only" means legitimately vscode-bound, not a defect. |
| Fix strategy | Close small divergences in-plan; spawn follow-on plans for any fix touching 3+ files or requiring architectural change | Keeps the audit deliverable bounded; avoids a mega-plan. |
| `getNextKanbanColumn` fix | Replace the hardcoded map with a call into the shared `_getNextColumnId` logic (or a standalone-callable extraction of it) | Eliminates the duplicate implementation entirely — the root cause — rather than patching the map per-column. |
| Test gate | A parity test that asserts standalone and extension resolve the same next-column for every built-in column ID, across visible/hidden states | Prevents future drift; the absence of this gate is why DISPATCH exposed the gap. |

## User Review Required

Yes — one decision:

- **`getNextKanbanColumn` replacement strategy.** Two options: (a) extract `_getNextColumnId`'s core into a standalone-callable function (shared module, both hosts call it) — cleanest, eliminates duplication, but touches KanbanProvider's internal structure; (b) replicate the `shouldSkip` logic inline in bootstrap by threading `visibleAgents` + custom columns into `getNextKanbanColumn` — less invasive to KanbanProvider but keeps two implementations. Recommendation: (a) — the root cause is the duplicate, and keeping two implementations means the next column addition risks re-drifting. Confirm before coding.

## Complexity Audit

### Routine
- Enumerating bootstrap's explicit-case verbs and their extension equivalents.
- Building the classification table.
- Adding `DISPATCH` handling once `getNextKanbanColumn` is replaced/deleted.
- Writing the parity test.

### Complex / Risky
- **Extracting `_getNextColumnId` core logic** into a shared callable without breaking the extension's internal callers (it reads `this._getCustomAgents`, `this._getVisibleAgents`, `this._buildKanbanColumns` — all instance methods with state).
- **Threading dependencies into standalone** — the shared function needs `visibleAgents`, custom columns, and the built column list; standalone has access to these via `db` + config but not via the same instance-method shape.
- **`isDispatchColumn` parity** — verifying the standalone terminal-dispatch gate matches the extension's criteria, not just the `dragDropMode` check.
- **Regression risk on shipped installs** (contract #2) — any change to `moveSelected`/`promptSelected` behavior affects ~4,000 extension installs if the shared function is extracted incorrectly.

## Edge-Case & Dependency Audit

**Race Conditions**
- None — column resolution is synchronous within a single verb handler.

**Security**
- None — no new surface; audit reads existing code and runs parity assertions.

**Side Effects**
- Replacing `getNextKanbanColumn` changes the next-column resolution for every standalone batch-move. If the extraction is wrong, standalone batch-move silently routes to the wrong column (no error, just wrong behavior — the same silent-failure mode the parity feature warned about).
- The parity feature's review noted `featureManagement: true` was over-reporting and was fixed; verify that fix still holds and isn't re-broken by column-logic changes.

**Dependencies & Conflicts**
- Depends on the Standalone Board Parity feature having landed (it has — all 6 subtasks CODE REVIEWED). The `default:` fallthrough and command bridge are prerequisites for any standalone verb work.
- Conflicts with the dispatcher plan (`dispatcher-column-and-bounce-analysis.md`) on the `getNextKanbanColumn` fix site — both touch it. **Sequencing:** this audit plan should land first (replaces the map with the shared function), then the dispatcher plan adds `DISPATCH` to the shared function (one line) rather than to the standalone map. If the dispatcher plan lands first, it threads `visibleAgents` into the map; this audit then replaces that threading with the shared-function call. Either order works, but audit-first avoids throwaway work.
- `verbSchemas.ts` is shared — this plan adds NO new verbs, so no schema append.

## Dependencies

- `standalone-board-parity-aa872dcc` — all 6 subtasks CODE REVIEWED. The `default:` fallthrough and command bridge are prerequisites.

## Adversarial Synthesis

Key risks: (1) the `getNextKanbanColumn` replacement is the root-cause fix but carries the highest regression risk — a wrong extraction silently routes every standalone batch-move to the wrong column with no error; (2) the audit may find more divergences than expected (the `isDispatchColumn` check, column ordering, visibility filtering in the board render vs the verb layer), turning this into a multi-fix effort that should split; (3) a parity test that only checks next-column resolution misses verb-logic divergences inside the explicit cases. Mitigations: extract the shared function behind the existing instance-method signature so extension callers are unchanged; classify all divergences before fixing and spawn follow-on plans for any 3+ file fix; expand the parity test to cover `isDispatchColumn` criteria and column-order rendering, not just next-column resolution.

## Implementation

### 1. Enumerate and classify

**File:** `src/standalone/bootstrap.ts` (read-only audit)

- List every `case` in the `kanbanVerb` switch (lines ~700-1062) that is NOT the `default:` fallthrough.
- For each, identify its extension equivalent in `KanbanProvider.handleServiceVerb` / `_handleMessage`.
- Classify each as:
  - **parity** — same logic, same outcome.
  - **diverges** — different logic or different outcome (e.g. `getNextKanbanColumn` vs `_getNextColumnId`).
  - **editor-only** — legitimately vscode-bound (no standalone equivalent expected).
- Produce a classification table in the plan's completion summary.

### 2. Replace `getNextKanbanColumn` with shared logic

**File:** `src/services/KanbanProvider.ts` + `src/standalone/bootstrap.ts`

- Extract the core of `_getNextColumnId` (lines 5687-5746) into a standalone-callable function that accepts `(column: string, allColumns: KanbanColumnDefinition[], visibleAgents: Record<string, boolean>, options: { acceptanceTesterActive: boolean })` and returns `string | null`.
- Keep `_getNextColumnId` as a thin wrapper that resolves its instance-method dependencies (`_getCustomAgents`, `_getVisibleAgents`, `_buildKanbanColumns`, `_isAcceptanceTesterDesignDocConfigured`) and delegates to the extracted function. Extension callers unchanged.
- In `bootstrap.ts`, replace all three `getNextKanbanColumn(sourceColumn)` call sites (lines 824, 851, 1241) with calls to the shared function, resolving `allColumns` and `visibleAgents` from the standalone host's existing access (`db`, config provider, `DEFAULT_KANBAN_COLUMNS`).
- Delete the hardcoded `getNextKanbanColumn` map (lines 128-141).

### 3. Audit `isDispatchColumn` parity

**File:** `src/standalone/bootstrap.ts` (line 834) vs `src/services/KanbanProvider.ts` (`moveCardForward` handler)

- Compare the standalone `isDispatchColumn` check (`dragDropMode === 'cli' && !!targetDef.role`) against the extension's terminal-dispatch gating in the `moveCardForward` path.
- If they diverge, align them — either by sharing the check or by documenting why the standalone check is intentionally simpler (and gating the difference).
- This is the check that would misroute DISPATCH to a coder terminal if not excluded — verify the dispatcher plan's exclusion holds after the shared-function extraction.

### 4. Audit column-order and visibility-filter parity

**File:** `src/standalone/bootstrap.ts` (board render path) vs `src/services/TaskViewerProvider.ts` (`_filterVisibleColumns`)

- Verify standalone renders columns in the same order as the extension (`_buildKanbanColumns` sort by `order`).
- Verify standalone filters hidden columns the same way (`visibleAgents[role] === false` for built-in columns).
- If the board render already uses the shared `pushFullState` payload (which publishes `DEFAULT_KANBAN_COLUMNS` + visibility), confirm no standalone-side re-filtering diverges.

### 5. Parity test

**File:** `src/services/__tests__/` (new test file)

- Assert that for every built-in column ID, the shared next-column function returns the same result under: default visibility, all-hidden, all-visible, and with custom columns present.
- Assert `isDispatchColumn` (or its shared equivalent) returns the same result for every built-in column.
- This is the gate that prevents the next column addition from re-drifting.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** Owns `_getNextColumnId`, the extension's next-column resolver.
- **Logic:** Extract the core into a standalone-callable function; keep `_getNextColumnId` as a thin wrapper.
- **Edge Cases:** The extracted function must not depend on `this` — all inputs passed as args. The `CODE REVIEWED`/`INTERN CODED` parallel-lane logic (`_isParallelCodedLane`) must be preserved in the extraction.

### `src/standalone/bootstrap.ts`
- **Context:** Standalone host verb handlers and the hardcoded `getNextKanbanColumn` map.
- **Logic:** Replace `getNextKanbanColumn` call sites with the shared function; delete the map; audit `isDispatchColumn` and column-order/visibility render paths.
- **Edge Cases:** The shared function needs `visibleAgents` and `allColumns` — resolve these from the standalone host's existing access without duplicating the extension's instance-method resolution.

### `src/services/__tests__/` (new)
- **Context:** No existing parity test for next-column resolution.
- **Logic:** Assert standalone and extension resolve the same next-column for every built-in column across visibility states.
- **Edge Cases:** Include custom-column and feature-only-column cases in the test matrix.

## Verification Plan

> Per session directives: SKIP compilation and SKIP automated tests. Verification is manual/inspection-based.

### Automated Tests
- Skipped per session directive. (The parity test in Implementation step 5 is authored but not run as part of this plan's verification — it is the deliverable that prevents future drift, run in CI thereafter.)

### Manual Verification (inspection + behavior)
1. **Classification table:** Every explicit-case verb in bootstrap's switch is classified parity/diverges/editor-only with a one-line justification.
2. **`getNextKanbanColumn` deletion:** Grep bootstrap.ts for `getNextKanbanColumn` — expect zero references after the shared-function replacement.
3. **Shared function extraction:** Grep KanbanProvider.ts for the extracted function — confirm `_getNextColumnId` delegates to it and no instance-state is captured in the extracted body.
4. **Next-column parity (manual):** For each built-in column, trace the shared function's output under default visibility — confirm it matches the pre-change extension output (no regression on shipped installs, contract #2).
5. **DISPATCH routing:** With `dispatcher` hidden, confirm the shared function skips DISPATCH (returns LEAD CODED from PLAN REVIEWED). With `dispatcher` visible, confirm it returns DISPATCH.
6. **`isDispatchColumn` parity:** Confirm the standalone terminal-dispatch gate and the extension's `moveCardForward` gating agree on every built-in column.
7. **Column-order render parity:** Confirm standalone and extension render columns in the same order with the same visibility filtering.
8. **Parity test authored:** The test file exists, imports the shared function, and covers the visibility-state matrix for every built-in column.

## Recommendation

Complexity 6 → **Send to Coder.** Multi-file extraction with regression risk, but no new architectural patterns — the logic already exists in the extension and is being shared, not invented. The audit classification is routine; the extraction is the careful part.
