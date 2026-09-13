# Batch low-complexity button passes undefined workflow and claims a move it never makes

## Goal

The `batchLowComplexity` case in `KanbanProvider.ts` (line 11742) calls `_advanceSessionsInColumn` with `undefined` as the workflow argument. Inside `_advanceSessionsInColumn` (line 7836), when `workflow` is `undefined`:

1. A `{workflow: undefined, action: 'start'}` event is pushed to the runsheet (line 7868).
2. `workflowName` becomes `''` (line 7887), so `derivedTarget` is `''` (line 7888 — the ternary short-circuits, `deriveKanbanColumn` is never called).
3. `targetColumn` is `''` (line 7892), and `normalizedColumn` is falsy (line 7893).
4. `moveCardToColumn` is never called (line 7894–7895) — **no card moves in the DB**.
5. `advanced.push({ sessionId, targetColumn: '' })` still fires (line 7955) — entries exist but carry an empty `targetColumn`.
6. `_postMoveCardsByTarget` (line 7968, called at line 11759) skips every pair because `!targetColumn` is true (line 7975) — **the board UI never receives a `moveCards` delta either**.
7. But the status message at line 11760 tells the user: `"Copied batch low-complexity prompt (N plans). Advanced ${advanced.length} plans to CODER CODED."`

The `advanced` array still gets entries (the runsheet event was pushed at step 1, setting `didAdvance = true`), so `advanced.length` is non-zero even though no column move happened and no UI delta fired. The user is told a move occurred that did not — in the DB, in the runsheet derivation, and in the board UI.

The codebase already documents this as a known scenario: the comment at lines 7920–7926 explicitly calls out "when `workflow` is undefined (the batch low-complexity button passes none)" as a case that produces no target column. The guard was written to *prevent* a backwards move from stale events, but the side effect is that the low-complexity button becomes a no-op for column advancement while reporting success.

**Root cause:** `batchLowComplexity` passes `undefined` instead of a workflow name that `deriveKanbanColumn` maps to `'CODER CODED'`. The `batchPlannerPrompt` case (line 11714) correctly passes `'improve-plan'` (line 11728), which maps to `'PLAN REVIEWED'`. The low-complexity button has no equivalent workflow name.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, ui
**Project:** Browser Switchboard

## User Review Required

No user decision needed. The fix is a single workflow-name substitution plus one additive switch case. The workflow name `'low-complexity'` is already used as the `instruction` parameter to `generateUnifiedPrompt` at line 11755, so reusing it as the runsheet workflow name keeps the event semantically aligned with the prompt that was copied. No product behavior change beyond making the move actually happen.

## Complexity Audit

### Routine
- Pass a workflow name that `deriveKanbanColumn` maps to `'CODER CODED'` instead of `undefined`.
- The `SLUG_MAP` in `kanbanColumnDerivationImpl.js` already has `'coder-coded': 'CODER CODED'` (line 26). A manual-move workflow name like `'move-to-coder-coded'` would map via the `manualMatch` regex at line 50 — no switch change needed.
- Alternatively, add `'low-complexity'` to the `switch` statement in `deriveKanbanColumn` (line 67) as a case returning `'CODER CODED'`, then pass `'low-complexity'` as the workflow. **This is the chosen approach** — it keeps the runsheet event semantically aligned with the `instruction: 'low-complexity'` string already passed to `generateUnifiedPrompt` at line 11755.

### Complex / Risky
- Must verify that adding `'low-complexity'` to the `switch` in `deriveKanbanColumn` does not break any existing contract test that scans the switch body. The `completion-asserted-never-inferred.test.js` contract test scans `PlanIngestionEngine.ts`, `KanbanDatabase.ts`, `TaskViewerProvider.ts`, and `kanban.html` — **not** `KanbanProvider.ts` or `kanbanColumnDerivationImpl.js` — so it is unaffected.
- The `kanban-batch-prompt-regression.test.js` scans the `batchLowComplexity` case block in `KanbanProvider.ts` source and asserts it contains `_advanceSessionsInColumn` (line 22–23). The fix preserves that call (only changes the third argument), so the regression test still passes.

## Edge-Case & Dependency Audit

- **Race Conditions:** The dedup check at line 7865 (`lastEvent.workflow === workflow`) currently compares against `undefined`. After the fix it compares against `'low-complexity'`, which correctly prevents duplicate `'low-complexity'` start events on a double-click. With `undefined`, the dedup could match any prior `undefined`-workflow event from a different code path — the fix tightens this.
- **Security:** No security surface — this is a column-derivation mapping change.
- **Side Effects:** After the fix, `moveCardToColumn` is called for each low-complexity card, moving it from `PLAN REVIEWED` to `CODER CODED` in the DB. `_postMoveCardsByTarget` emits a `moveCards` delta for the `CODER CODED` target (previously all pairs were skipped). The board UI updates without a full refresh.
- **Dependencies & Conflicts:** `kanbanColumnDerivationImpl.js` switch statement — adding a new case is additive; the `default` arm already `continue`s for unknown workflows (line 98), so existing callers are unaffected. `KanbanProvider.ts` is shared between both composition roots (instantiated in `extension.ts` line 609 and `standalone/bootstrap.ts` line 1666), so both hosts get the fix.
- **Standalone parity:** The `batchLowComplexity` case is in the shared `KanbanProvider` message handler, so both the extension and standalone hosts receive the fix. No composition-root wiring difference — this is a single argument change in shared code.

## Dependencies

None. This is a self-contained bugfix with no prerequisite sessions.

## Adversarial Synthesis

Key risks: (1) stale line numbers in the original plan would send the implementer to the wrong locations — corrected to current values. (2) The original plan missed the `_postMoveCardsByTarget` symptom — the board UI never receives a `moveCards` delta, so the card appears stuck in `PLAN REVIEWED` even after the button reports success. (3) The dedup check comparing against `undefined` was looser than intended. Mitigations: line numbers updated, third symptom documented, and the workflow-name change tightens the dedup as a side benefit.

## Proposed Changes

### 1. `src/services/kanbanColumnDerivationImpl.js` — add `low-complexity` case

Add `'low-complexity'` to the `switch` statement (line 67) so it maps to `'CODER CODED'`. Place it in the standard-progression block, before the `review` case:

```javascript
// In the switch statement (after 'implementation', before 'review'):
case 'low-complexity':
    return 'CODER CODED';
```

**Context:** The switch maps workflow names to kanban column IDs. The `default` arm `continue`s for unknown workflows (line 98), so this additive case cannot affect existing callers.

**Edge Cases:** If a custom agent role is literally named `'low-complexity'`, the switch case takes precedence over the custom-role `default` arm. This is the same precedence as every other named case (`improve-plan`, `implementation`, etc.) — not a new conflict.

### 2. `src/services/KanbanProvider.ts` — pass `'low-complexity'` as workflow

Change line 11757 from:

```typescript
const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'PLAN REVIEWED', undefined, workspaceRoot);
```

to:

```typescript
const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'PLAN REVIEWED', 'low-complexity', workspaceRoot);
```

**Context:** `_advanceSessionsInColumn` (line 7836) uses the workflow name to derive the target column via `deriveKanbanColumn([{ workflow: workflowName }], customAgents)` at line 7888. With `'low-complexity'`, the new switch case returns `'CODER CODED'`, so `moveCardToColumn` is called (line 7895), `advanced` entries carry `targetColumn: 'CODER CODED'` (line 7955), and `_postMoveCardsByTarget` emits the `moveCards` delta (line 7975 no longer skips).

**Logic:** The `instruction: 'low-complexity'` string is already passed to `generateUnifiedPrompt` at line 11755. Reusing it as the workflow name keeps the runsheet event `{workflow: 'low-complexity', action: 'start'}` semantically aligned with the copied prompt.

**Edge Cases:** The dedup check at line 7865 now compares `lastEvent.workflow === 'low-complexity'`, correctly preventing duplicate start events on a rapid double-click. Previously it compared against `undefined`, which could match unrelated `undefined`-workflow events.

### 3. `src/services/__tests__/kanbanColumnDerivation.test.ts` — add test case

Add a test for the new mapping:

```typescript
test('maps low-complexity workflow to CODER CODED', () => {
    const result = deriveKanbanColumn([{ workflow: 'low-complexity' }]);
    assert.strictEqual(result, 'CODER CODED');
});
```

## Verification Plan

### Automated Tests

1. Run `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/kanban-batch-prompt-regression.test.js` — assert no regressions. This test scans `KanbanProvider.ts` source for the `batchLowComplexity` case block and asserts it contains `_advanceSessionsInColumn`; the fix preserves that call.
2. Run `npm run compile-tests && npx vscode-test --grep KanbanProvider` — assert the KanbanProvider suite passes (if vscode-test is available locally; otherwise verify on CI).
3. Run `node -e "const {deriveKanbanColumn} = require('./out/services/kanbanColumnDerivationImpl.js'); console.log(deriveKanbanColumn([{workflow: 'low-complexity'}]))"` — assert output is `CODER CODED`.
4. Run the full contract suite to verify no regressions from the new `switch` case. In particular, `completion-asserted-never-inferred.test.js` does not scan `kanbanColumnDerivationImpl.js` or `KanbanProvider.ts`, so it is unaffected.

### Goal Invariants

- **Assert** `src/services/kanbanColumnDerivationImpl.js` contains a `case 'low-complexity':` returning `'CODER CODED'` in the `deriveKanbanColumn` switch.
- **Assert** `src/services/KanbanProvider.ts` line containing `case 'batchLowComplexity':` passes `'low-complexity'` (not `undefined`) as the third argument to `_advanceSessionsInColumn`.
- **Assert** no call to `_advanceSessionsInColumn` in the `batchLowComplexity` case block passes `undefined` as the workflow argument (negative invariant — the bug was `undefined` being passed).
- **Assert** `deriveKanbanColumn([{ workflow: 'low-complexity' }])` returns `'CODER CODED'` (executable check via the test in Proposed Change 3).

### Manual Verification

With plans in `PLAN REVIEWED`, click the batch low-complexity button and confirm: (a) cards move to `CODER CODED` in the DB, (b) the board UI updates without a full refresh (the `moveCards` delta fires), and (c) the status message count matches the number of cards that actually moved.

---

**Recommendation:** Complexity 3 → Send to Intern.
