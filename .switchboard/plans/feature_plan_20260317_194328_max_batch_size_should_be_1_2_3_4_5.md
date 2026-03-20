# Max batch size should be 1, 2, 3, 4, 5

## Goal
- In the autoban setup, the max batch size is 1, 3, 5. I wanted to set it to 2, so it should be 1, 2, 3, 4, 5.

## Current Findings
- `src\webview\implementation.html` is the current UI bottleneck: the `MAX BATCH SIZE` dropdown is hardcoded to `[1, 3, 5]`, so users cannot select `2` or `4` from the sidebar.
- `src\services\autobanState.ts` already normalizes `batchSize` as any positive integer with a default of `3`, which means the runtime can already handle `2` and `4` if they are injected into saved state, but it also means unsupported values above `5` can still persist unless this plan tightens the contract.
- `src\services\TaskViewerProvider.ts` already consumes `_autobanState.batchSize` in the recurring autoban engine (`_startAutobanEngine()`, `_autobanTickColumn(...)`) and in manual low-complexity batch dispatch (`handleBatchDispatchLow(...)`). It also restarts the engine when `updateAutobanState` arrives, so newly selected values should take effect immediately once the UI can emit them.
- `src\webview\kanban.html` only renders the current batch size in read-only countdown text (`Batch: ${autobanConfig.batchSize}`), so it should reflect `2` or `4` automatically once the provider broadcasts those values; no separate UX redesign is indicated.

## Proposed Changes
1. **Tighten the supported batch-size contract in `src\services\autobanState.ts`.**
   - Add an explicit supported range/option definition for autoban batch size so the code documents that the intended contract is `1, 2, 3, 4, 5` with default `3`.
   - Update `normalizeAutobanConfigState(...)` so persisted state still falls back safely to `3` when missing/invalid, but also constrains manually injected/out-of-band values to the supported range instead of allowing arbitrary integers above `5`.
   - Keep this scoped to batch-size normalization only; do not broaden the change into unrelated autoban rule/timer behavior.
2. **Update the sidebar control in `src\webview\implementation.html`.**
   - Change the `MAX BATCH SIZE` dropdown options from `[1, 3, 5]` to `[1, 2, 3, 4, 5]`.
   - Preserve the existing `emitAutobanState()` flow so selecting `2` or `4` updates the shared autoban config exactly the same way as the existing values.
   - Ensure the rendered selection reflects persisted `2`/`4` values instead of visually snapping to the first available option because those values are absent from the current list.
3. **Verify `src\services\TaskViewerProvider.ts` stays aligned with the normalized value.**
   - Confirm `_startAutobanEngine()`, `_autobanTickColumn(...)`, `handleBatchDispatchLow(...)`, and the `updateAutobanState` webview message handler continue to read the normalized `_autobanState.batchSize`.
   - If any local `Number(...batchSize)` fallback could bypass the new `1..5` contract, consolidate that usage around the normalized state instead of duplicating separate range logic.
   - No routing-mode, complexity-filter, or dispatch-target changes are in scope for this plan.
4. **Refresh the targeted regression tests.**
   - Update `src\test\autoban-controls-regression.test.js` so it fails unless the webview source offers all five supported values (`1, 2, 3, 4, 5`) for the batch-size selector.
   - Update `src\test\autoban-state-regression.test.js` so it explicitly proves `2` and `4` survive normalization/broadcast, and—if the implementation clamps unsupported values—add a case showing out-of-range persisted values are brought back into the supported contract.
   - `src\test\session-action-log.test.ts` already exercises `batchSize: 1`; it should only need attention if the normalization refactor accidentally changes the serialized shape of autoban payloads.

## Verification Plan
- `npm run compile-tests`
- `npm run compile`
- `node src\test\autoban-controls-regression.test.js`
- `node src\test\autoban-state-regression.test.js`

## Dependency / Conflict Findings
- **Primary implementation dependency:** `src\webview\implementation.html` must change, because the current UI is the only confirmed place that restricts users to `1`, `3`, and `5`.
- **Persisted-state consistency risk:** `src\services\autobanState.ts` currently accepts any positive integer, so a UI-only fix would make `2`/`4` selectable but still leave workspace state capable of storing `6+`. This plan should resolve that mismatch so UI and backend advertise the same contract.
- **Runtime conflict risk:** low. `src\services\TaskViewerProvider.ts` already uses numeric `batchSize` values generically, so adding `2` and `4` should not require a dispatch-engine rewrite.
- **Read-only UI impact:** `src\webview\kanban.html` does not appear to need a direct code change, but it should be spot-checked after implementation because it displays the broadcast batch size and is the most visible confirmation that `2`/`4` propagated through the system.

## Complexity Audit
- **Surface area:** small; expected touch points are `src\services\autobanState.ts`, `src\webview\implementation.html`, `src\services\TaskViewerProvider.ts` (validation/alignment only), and the two autoban regression tests.
- **Execution risk:** low-to-moderate. The only meaningful risk is letting the UI and persisted-state normalization drift apart, which would create misleading controls or silently unsupported values.
- **Testing burden:** light; existing targeted regression tests already cover the autoban UI source and state normalization seams that matter for this feature.
- **Routing recommendation:** keep this as a standard coder-sized task / small feature. It does not justify lead-coder routing unless it is being bundled with broader autoban work.

## Open Questions
- None blocking. Preferred implementation is to make `1..5` the explicit supported contract in both the UI and state normalization, rather than only widening the dropdown while leaving backend behavior broader.
