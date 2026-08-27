# kanbanColumnDerivation test is red at HEAD and unwired from CI

## Goal

`src/services/__tests__/kanbanColumnDerivation.test.ts` is red at HEAD: it asserts that `deriveKanbanColumn([{ workflow: 'reset-to-coded' }])` returns `'LEAD CODED'` (line 17), but `kanbanColumnDerivationImpl.js` returns the legacy `'CODED'` (via `SLUG_MAP['coded']` at line 29). The test was written expecting a normalization that was never implemented in the impl.

Additionally, the test file is absent from `.vscode-test.mjs` (which lists only 5 test files) and from every CI step in `.github/workflows/integration-tests.yml`. Nothing has been running it, so the failure went unnoticed.

**Root cause:** Two issues:
1. **Impl/test mismatch:** The `SLUG_MAP` maps `'coded'` to `'CODED'` (the legacy column), but the test expects `'LEAD CODED'` (the current column). The `KanbanDerivedColumn` type in `kanbanColumnDerivation.ts` (line 3) lists both `'LEAD CODED'` and `'CODED'` as valid values. The impl should normalize `'CODED'` to `'LEAD CODED'` since `'CODED'` is a legacy column that was superseded by the role-specific coded lanes.
2. **CI wiring gap:** The test file is a TypeScript test (`*.test.ts`) in `src/services/__tests__/`, but `.vscode-test.mjs` only lists `out/services/__tests__/KanbanProvider.test.js` and `out/services/__tests__/agentPromptBuilder.test.js` from that directory. The `kanbanColumnDerivation.test.ts` file is never compiled or run.

## Metadata

**Complexity:** 3
**Tags:** test, bugfix, backend
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Fix the impl: normalize `'CODED'` to `'LEAD CODED'` in `kanbanColumnDerivationImpl.js` so `reset-to-coded` returns the current column, not the legacy one.
- Wire the test into `.vscode-test.mjs` and CI.

**Complex/Risky:**
- Normalizing `'CODED'` to `'LEAD CODED'` could affect callers that rely on the legacy `'CODED'` value. Must audit all callers of `deriveKanbanColumn` to verify none depend on receiving `'CODED'` rather than `'LEAD CODED'`.
- The `SLUG_MAP` is also used for `move-to-coded` and `reset-to-coded` manual workflows. Normalizing the map entry affects both.
- `'CODED'` still appears in `KanbanDerivedColumn` type and may be used as a valid column elsewhere. The normalization should happen at the `SLUG_MAP` level, not as a post-processing step, to keep the mapping centralized.

## Edge-Case & Dependency Audit

- **Callers of `deriveKanbanColumn`:** `KanbanProvider.ts` (lines 7498, 7505, 8396) and test files. The `_advanceSessionsInColumn` method (line 7505) uses the derived target to call `moveCardToColumn`, which calls `_normalizeLegacyKanbanColumn` — so even if `deriveKanbanColumn` returns `'CODED'`, the normalize step may already map it. Must verify.
- **`_normalizeLegacyKanbanColumn`:** Check whether this method already normalizes `'CODED'` to `'LEAD CODED'`. If it does, the impl fix may be redundant for the KanbanProvider path but still needed for direct callers.
- **`.vscode-test.mjs`:** Adding `out/services/__tests__/kanbanColumnDerivation.test.js` to the `files` array wires it into the vscode-test harness. The file compiles via `tsconfig.test.json` (already run as `compile-tests` in CI).
- **CI:** The vscode-test step in `integration-tests.yml` runs `npm test`, which uses `.vscode-test.mjs`. Adding the file there automatically wires it into CI.

## Proposed Changes

### 1. `src/services/kanbanColumnDerivationImpl.js` — normalize `CODED` to `LEAD CODED`

Change the `SLUG_MAP` entry:

```javascript
const SLUG_MAP = {
    'created': 'CREATED',
    'plan-reviewed': 'PLAN REVIEWED',
    'intern-coded': 'INTERN CODED',
    'lead-coded': 'LEAD CODED',
    'coder-coded': 'CODER CODED',
    'code-reviewed': 'CODE REVIEWED',
    'acceptance-tested': 'ACCEPTANCE TESTED',
    'coded': 'LEAD CODED'  // was 'CODED' — normalize legacy column to current
};
```

Also update the `implementation` case in the switch (line 77-78) to return `'LEAD CODED'` instead of `'CODED'`:

```javascript
case 'implementation':
    return 'LEAD CODED';
```

### 2. `.vscode-test.mjs` — wire the test file

Add to the `files` array:

```javascript
files: [
    'out/test/pair-programming-*.test.js',
    'out/services/__tests__/KanbanProvider.test.js',
    'out/services/__tests__/kanbanColumnDerivation.test.js',
    'out/services/__tests__/GlobalPlanWatcherService.test.js',
    'out/services/__tests__/agentPromptBuilder.test.js',
    'out/test/kanban-complexity.test.js',
],
```

### 3. Verify `_normalizeLegacyKanbanColumn` alignment

Check `KanbanProvider.ts`'s `_normalizeLegacyKanbanColumn` method to confirm it also maps `'CODED'` → `'LEAD CODED'`. If it does not, add the mapping there as well to keep both paths consistent.

## Verification Plan

1. Run `npx tsc -p tsconfig.test.json` — assert the test file compiles.
2. Run `node -e "const {deriveKanbanColumn} = require('./out/services/kanbanColumnDerivationImpl.js'); console.log(deriveKanbanColumn([{workflow: 'reset-to-coded'}]))"` — assert output is `LEAD CODED`.
3. Run `node -e "const {deriveKanbanColumn} = require('./out/services/kanbanColumnDerivationImpl.js'); console.log(deriveKanbanColumn([{workflow: 'implementation'}]))"` — assert output is `LEAD CODED`.
4. Run `npx vscode-test --grep kanbanColumnDerivation` — assert the suite passes (if vscode-test launches locally; otherwise verify on CI).
5. Run the full contract suite — assert no regressions from the `CODED` → `LEAD CODED` normalization.
6. Verify `.vscode-test.mjs` includes the new file by running `npm test --grep kanbanColumnDerivation` and confirming the suite is discovered.
