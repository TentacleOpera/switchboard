# Adjust Default Batch Size and Interval Configuration for Kanban Automation

This plan outlines adjustments to the default batch size and execution interval configs for both single-column and multi-column automation in Switchboard.
Specifically:
- Single Column Automation: Max batch size defaults to `1` (previously `3`), and execution interval (time between sends) defaults to `10` minutes (previously `15`/`20`).
- Multi-Column Automation: Max batch size defaults to `1` (previously `3`).

## Goal

Reduce the default concurrent terminal dispatch count for both automation modes to 1 and shorten the single-column tick interval to 10 minutes, optimizing execution for a single-agent or low-concurrency default flow.

## Metadata

- **Tags:** [workflow, reliability]
- **Complexity:** 3

## User Review Required

> [!NOTE]
> Setting default batch size to `1` reduces the default concurrent terminal dispatch count for both automation modes, optimizing execution for a single-agent or low-concurrency default flow.
>
> **Migration note:** Existing users with persisted `workspaceState` containing valid `batchSize: 3` will continue to get 3 after upgrade — `normalizeAutobanBatchSize` preserves valid values (1–5). The new defaults only affect fresh installations or cases where persisted data is invalid/missing. This is correct behavior; no forced migration is needed.

## Complexity Audit

### Routine
- Changing numeric constant defaults (`DEFAULT_AUTOBAN_BATCH_SIZE`, `DEFAULT_SINGLE_COLUMN_CONFIG`)
- Updating `|| 3` / `|| 15` / `?? 15` fallback literals in backend and webview code
- Updating test assertions to match new fallback expectations

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Default-value changes are read at initialization and normalization time; no concurrent mutation paths are affected.
- **Security:** No impact. Batch size and interval are operational tuning knobs, not security boundaries.
- **Side Effects:** Users with existing persisted state retain their old values (valid batch sizes 1–5 are preserved by normalization). Only fresh or invalid-state sessions get the new defaults.
- **Dependencies & Conflicts:** The `normalizeAutobanBatchSize` function uses `DEFAULT_AUTOBAN_BATCH_SIZE` as its fallback — changing the constant automatically updates all callers. No other plans depend on the old default values.

## Dependencies

None.

## Adversarial Synthesis

Key risks: kanban.html interval fallback on line 6936 (`|| 15`) was not explicitly called out in the original plan and could be missed by an implementer; test fixture values (line 18 `batchSize: 3`) must not be confused with fallback-assertion values (line 74). Mitigations: all fallback sites are now enumerated with exact line numbers; test changes are scoped to assertion targets only.

## Open Questions

None. The requirements for configuration default alignments are fully specified.

## Proposed Changes

---

### Core State & Configuration

#### [MODIFY] [autobanState.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/autobanState.ts)
- **Line 12:** Update `DEFAULT_AUTOBAN_BATCH_SIZE` to `1` (from `3`).
  - This constant is the fallback used by `normalizeAutobanBatchSize` (line 97), which in turn is called by `normalizeAutobanConfigState` (line 225) and `normalizeSingleColumnConfig` (line 40). Changing it updates the default for **both** single-column and multi-column modes.
- **Line 28:** Update `DEFAULT_SINGLE_COLUMN_CONFIG.intervalMinutes` to `10` (from `15`).
- **Line 29:** Update `DEFAULT_SINGLE_COLUMN_CONFIG.batchSize` to `1` (from `3`).
- **Line 39:** Update the ternary fallback in `normalizeSingleColumnConfig` from `: 15` to `: 10`:
  ```typescript
  // Before:
  intervalMinutes: Math.max(1, Math.min(60, Number.isFinite(state?.intervalMinutes as number) ? Math.floor(state!.intervalMinutes!) : 15)),
  // After:
  intervalMinutes: Math.max(1, Math.min(60, Number.isFinite(state?.intervalMinutes as number) ? Math.floor(state!.intervalMinutes!) : 10)),
  ```

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)
- **Line 5030:** Update `_persistAutobanState` nullish-coalescing fallback from `?? 15` to `?? 10`:
  ```typescript
  // Before:
  this._singleColumnAutobanState.intervalMinutes = this._autobanState.rules[sc]?.intervalMinutes ?? 15;
  // After:
  this._singleColumnAutobanState.intervalMinutes = this._autobanState.rules[sc]?.intervalMinutes ?? 10;
  ```
- **Line 5877:** Update state-setting message handler logical-OR fallback from `|| 15` to `|| 10`:
  ```typescript
  // Before:
  const intervalMinutes = msg.intervalMinutes || this._singleColumnAutobanState.intervalMinutes || 15;
  // After:
  const intervalMinutes = msg.intervalMinutes || this._singleColumnAutobanState.intervalMinutes || 10;
  ```
- **Line 5878:** Update state-setting message handler logical-OR fallback from `|| 3` to `|| 1`:
  ```typescript
  // Before:
  const batchSize = msg.batchSize || this._singleColumnAutobanState.batchSize || 3;
  // After:
  const batchSize = msg.batchSize || this._singleColumnAutobanState.batchSize || 1;
  ```

---

### Frontend Webviews

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)
- **Line 6823:** Update single-column default configuration fallback object from `intervalMinutes: 15, batchSize: 3` to `intervalMinutes: 10, batchSize: 1`:
  ```javascript
  // Before:
  const singleColumnConfig = state.singleColumnConfig || { enabled: false, intervalMinutes: 15, batchSize: 3, complexityFilter: 'all', terminalPools: {}, sourceColumn: 'PLAN REVIEWED', sourceColumnRole: 'lead' };
  // After:
  const singleColumnConfig = state.singleColumnConfig || { enabled: false, intervalMinutes: 10, batchSize: 1, complexityFilter: 'all', terminalPools: {}, sourceColumn: 'PLAN REVIEWED', sourceColumnRole: 'lead' };
  ```
- **Line 6936:** Update single-column interval input-change fallback from `|| 15` to `|| 10`:
  ```javascript
  // Before:
  const val = Math.max(1, Math.min(60, parseInt(minInputSc.value, 10) || 15));
  // After:
  const val = Math.max(1, Math.min(60, parseInt(minInputSc.value, 10) || 10));
  ```
- **Line 6990:** Update single-column batch-size select-change fallback from `|| 3` to `|| 1`:
  ```javascript
  // Before:
  singleColumnConfig.batchSize = parseInt(batchSelectSc.value, 10) || 3;
  // After:
  singleColumnConfig.batchSize = parseInt(batchSelectSc.value, 10) || 1;
  ```
- **Line 7304:** Update multi-column batch-size select-change fallback from `|| 3` to `|| 1`:
  ```javascript
  // Before:
  state.batchSize = parseInt(batchSelect.value, 10) || 3;
  // After:
  state.batchSize = parseInt(batchSelect.value, 10) || 1;
  ```

#### [MODIFY] [implementation.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html)
- **Line 2298:** Update `autobanState` object initialization `batchSize` default to `1` (from `3`):
  ```javascript
  // Before:
  batchSize: 3,
  // After:
  batchSize: 1,
  ```

---

### Automated Verification & Regression Tests

#### [MODIFY] [autoban-state-regression.test.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/test/autoban-state-regression.test.js)
- **Line 74:** Update the fallback-assertion to expect `1` instead of `3`:
  ```javascript
  // Before:
  assert.strictEqual(normalizedLegacy.batchSize, 3, 'legacy states should fall back to the default batch size when persisted data is invalid');
  // After:
  assert.strictEqual(normalizedLegacy.batchSize, 1, 'legacy states should fall back to the default batch size when persisted data is invalid');
  ```
  > **Important:** Do NOT change `baseState.batchSize = 3` on line 18 — that is a valid test *input* value (3 is still in `AUTOBAN_BATCH_SIZE_OPTIONS`), not a default assertion. Changing it would weaken test coverage.

#### [MODIFY] [autoban-controls-regression.test.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/test/autoban-controls-regression.test.js)
- **Line 37:** Update regex match expectation for `autobanState` initialization to check for `batchSize: 1` instead of `batchSize: 3`:
  ```javascript
  // Before:
  /let\s+autobanState\s*=\s*\{\s*enabled:\s*false,\s*batchSize:\s*3,\s*complexityFilter:\s*'all',\s*routingMode:\s*'dynamic'/s
  // After:
  /let\s+autobanState\s*=\s*\{\s*enabled:\s*false,\s*batchSize:\s*1,\s*complexityFilter:\s*'all',\s*routingMode:\s*'dynamic'/s
  ```

## Verification Plan

### Automated Tests
Run the project's regression tests using npm/node:
- `node src/test/autoban-state-regression.test.js`
- `node src/test/autoban-controls-regression.test.js`

> **SKIP:** Per session directives, compilation and automated test execution are not performed. The user will run tests separately.

---

**Recommendation:** Complexity 3 → Send to Intern

---

## Review & Execution

### Stage 1: Grumpy Review
*Grumbles and adjusts glasses.* 

Let's see what disaster we have here. You wanted to update the batch sizes to 1 and intervals to 10 across the codebase to stop the agent from DDoSing our LLM queues.

- **`src/services/autobanState.ts`**: The defaults are set. `DEFAULT_AUTOBAN_BATCH_SIZE = 1`, `DEFAULT_SINGLE_COLUMN_CONFIG` is `10` and `1`. Fallbacks are updated. I couldn't find a single missed fallback in the AST.
- **`src/services/TaskViewerProvider.ts`**: The `?? 10` is there. The `|| 1` and `|| 10` are there. 
- **`src/webview/kanban.html`**: `singleColumnConfig` fallback is updated. `minInputSc.value` parses to `10`. The select dropdowns default to `1`. No weird `15`s or `3`s hiding in the shadows.
- **`src/webview/implementation.html`**: The UI state initializes `batchSize` to `1`.
- **Tests**: `autoban-state-regression.test.js` correctly asserts `1`. `autoban-controls-regression.test.js` regex expects `1`.

*Sigh.* I spent 15 minutes hunting for line number drift because `kanban.html` shifted by 50 lines, but you actually handled the logic perfectly. I have no CRITICAL or MAJOR findings. This is a rare, adequately executed plan.

- **NIT**: Line number drift. The implementation file `kanban.html` had changes offset by 50+ lines due to concurrent modifications, but the logic was placed correctly.

### Stage 2: Balanced Synthesis
The implementation matches the specification exactly. The configuration adjustments for the Kanban automation have been safely applied across the constants, fallbacks, webview elements, and test cases.

No code fixes are necessary.

### Verification
- **Typecheck / Tests**: Skipped as per strict directives.
- **Status**: Completed without further modifications.

### Updated Files
- `src/services/autobanState.ts`
- `src/services/TaskViewerProvider.ts`
- `src/webview/kanban.html`
- `src/webview/implementation.html`
- `src/test/autoban-state-regression.test.js`
- `src/test/autoban-controls-regression.test.js`
