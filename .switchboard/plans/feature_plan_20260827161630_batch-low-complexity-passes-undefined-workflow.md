# Batch low-complexity button passes undefined workflow and claims a move it never makes

## Goal

The `batchLowComplexity` case in `KanbanProvider.ts` (line 11242) calls `_advanceSessionsInColumn` with `undefined` as the workflow argument. Inside `_advanceSessionsInColumn` (line 7453), when `workflow` is `undefined`:

1. A `{workflow: undefined, action: 'start'}` event is pushed to the runsheet (line 7485).
2. `workflowName` becomes `''` (line 7504), so `derivedTarget` is `''` (line 7505).
3. `targetColumn` is `''` (line 7509), and `normalizedColumn` is falsy.
4. `moveCardToColumn` is never called (line 7511–7512) — **no card moves**.
5. But the status message at line 11260 tells the user: `"Advanced ${advanced.length} plans to CODER CODED."`

The `advanced` array still gets entries (the runsheet event was pushed), so `advanced.length` is non-zero even though no column move happened. The user is told a move occurred that did not.

**Root cause:** `batchLowComplexity` passes `undefined` instead of a workflow name that `deriveKanbanColumn` maps to `'CODER CODED'`. The `batchPlannerPrompt` case (line 11228) correctly passes `'improve-plan'`, which maps to `'PLAN REVIEWED'`. The low-complexity button has no equivalent workflow name.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, ui
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Pass a workflow name that `deriveKanbanColumn` maps to `'CODER CODED'` instead of `undefined`.
- The `SLUG_MAP` in `kanbanColumnDerivationImpl.js` already has `'coder-coded': 'CODER CODED'` (line 26). A manual-move workflow name like `'move-to-coder-coded'` would map via the `manualMatch` regex at line 50.
- Alternatively, add `'low-complexity'` to the `switch` statement in `deriveKanbanColumn` (line 67) as a case returning `'CODER CODED'`, then pass `'low-complexity'` as the workflow.

**Complex/Risky:**
- The `instruction` parameter passed to `generateUnifiedPrompt` is already `'low-complexity'` (line 11255). Using the same string as the workflow name is the cleanest option — it avoids inventing a new workflow name and keeps the runsheet event semantically aligned with the prompt instruction.
- Must verify that adding `'low-complexity'` to the `switch` in `deriveKanbanColumn` does not break any existing contract test that scans the switch body.

## Edge-Case & Dependency Audit

- **`kanbanColumnDerivationImpl.js` switch statement:** Adding a new case is additive — the `default` arm already `continue`s for unknown workflows, so existing callers are unaffected.
- **`_advanceSessionsInColumn` dedup check (line 7482):** The dedup checks `lastEvent.workflow === workflow`. Changing from `undefined` to `'low-complexity'` means the dedup now correctly prevents duplicate `'low-complexity'` start events, which is the intended behavior.
- **`completion-asserted-never-inferred.test.js`:** This contract test scans `PlanIngestionEngine.ts` source, not `KanbanProvider.ts` or `kanbanColumnDerivationImpl.js`, so it is unaffected.
- **`kanban-batch-prompt-regression.test.js`:** References `batchLowComplexity` — must verify it still passes after the workflow name change.
- **Standalone parity:** `KanbanProvider.ts` is shared between both hosts. The `batchLowComplexity` case is in the shared message handler, so both hosts get the fix.

## Proposed Changes

### 1. `src/services/kanbanColumnDerivationImpl.js` — add `low-complexity` case

Add `'low-complexity'` to the `switch` statement so it maps to `'CODER CODED'`:

```javascript
// In the switch statement (after 'implementation' / before 'review'):
case 'low-complexity':
    return 'CODER CODED';
```

### 2. `src/services/KanbanProvider.ts` — pass `'low-complexity'` as workflow

Change line 11257 from:

```typescript
const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'PLAN REVIEWED', undefined, workspaceRoot);
```

to:

```typescript
const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'PLAN REVIEWED', 'low-complexity', workspaceRoot);
```

### 3. `src/services/__tests__/kanbanColumnDerivation.test.ts` — add test case

Add a test for the new mapping:

```typescript
test('maps low-complexity workflow to CODER CODED', () => {
    const result = deriveKanbanColumn([{ workflow: 'low-complexity' }]);
    assert.strictEqual(result, 'CODER CODED');
});
```

## Verification Plan

1. Run `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/kanban-batch-prompt-regression.test.js` — assert no regressions.
2. Run `npm run compile-tests && npx vscode-test --grep KanbanProvider` — assert the KanbanProvider suite passes (if vscode-test is available locally; otherwise verify on CI).
3. Run `node -e "const {deriveKanbanColumn} = require('./out/services/kanbanColumnDerivationImpl.js'); console.log(deriveKanbanColumn([{workflow: 'low-complexity'}]))"` — assert output is `CODER CODED`.
4. Manually verify: with plans in PLAN REVIEWED, click the batch low-complexity button and confirm cards move to CODER CODED and the status message is accurate.
5. Run the full contract suite to verify no regressions from the new `switch` case.
