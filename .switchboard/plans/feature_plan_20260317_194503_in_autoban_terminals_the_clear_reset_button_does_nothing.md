# In autoban terminals the clear reset button does nothing

## Goal
- Fix the Autoban-tab reload regression only: after a VS Code window reload, `CLEAR & RESET` should clear Autoban counters/timers and remove orphaned Autoban pool entries from the Autoban UI so the user does not have to close each leftover terminal individually.
- Keep scope limited to Autoban terminal pool/reset behavior. Do not broaden this into a general terminal reset or registry rewrite.

## Findings
- `src\services\TaskViewerProvider.ts` restores persisted Autoban state from `workspaceState` on startup, including `terminalPools` and `managedTerminalPools`.
- `src\services\TaskViewerProvider.ts` `_resetAutobanPools()` clears pool metadata and session counters, then closes only the managed Autoban backup terminals it knows about.
- `src\webview\implementation.html` `getRolePoolEntries()` renders the Autoban pool from `(configuredPool.length > 0 ? configuredPool : liveRoleTerminals)`, where `liveRoleTerminals` is derived from `lastTerminals`.
- `src\services\TaskViewerProvider.ts` `_refreshTerminalStatuses()` intentionally publishes the full terminal registry into `lastTerminals`, including entries that are still role-tagged after reload. That means clearing the configured pool can immediately repopulate the Autoban list from reloaded/orphaned role terminals.
- `src\services\TaskViewerProvider.ts` `_getAliveAutobanTerminalRegistry()` and `_resolveAutobanEffectivePool()` already apply alive-only filtering for actual Autoban dispatch selection. The backend dispatch path is more defensive than the webview display path.
- `src\services\TaskViewerProvider.ts` `housekeepStaleTerminals()` only prunes terminals older than 24 hours, so it does not address the immediate post-reload regression.

## Root Cause Call
- **Primary issue:** stale terminal enumeration after reload, combined with the Autoban webview fallback that rebuilds the displayed pool from role-tagged terminals when `terminalPools` is empty.
- **Secondary issue:** reset logic clears Autoban pool metadata, but it does not fully reconcile/remove orphaned Autoban terminal records that still flow through `lastTerminals`.
- **Not the primary issue:** UI refresh wiring. `terminalStatuses` and `autobanStateSync` already trigger `renderAgentList()`.
- **Not the primary issue:** `normalizeAutobanConfigState()` pool normalization. Normalization preserves pool arrays but does not itself create the ghost entries.

## Concrete Implementation Steps
1. **Reconcile persisted Autoban pools against live terminals in `src\services\TaskViewerProvider.ts`.**
   - Add a helper that compares `this._autobanState.terminalPools` / `managedTerminalPools` against `_getAliveAutobanTerminalRegistry(workspaceRoot)`.
   - Prune names that are no longer valid Autoban candidates, and remove their related `sendCounts` / `poolCursor` entries so reset state is internally consistent.
   - Call the helper during reload restoration, before `_tryRestoreAutoban()` posts Autoban state back to the UI.

2. **Tighten `CLEAR & RESET` behavior in `src\services\TaskViewerProvider.ts`.**
   - Keep the existing responsibilities: stop the engine, clear send counters, clear pool metadata, close managed Autoban backup terminals, restart the engine if it was enabled.
   - After closing managed terminals, explicitly reconcile Autoban pool state again so reload leftovers do not immediately reappear from persisted state.
   - If safe, remove stale `state.terminals[name]` entries for Autoban backup terminals (`purpose === 'autoban-backup'`) that are no longer alive, instead of relying on the 24-hour stale-terminal housekeeping path.

3. **Make the Autoban webview render from effective/alive pool data in `src\webview\implementation.html`.**
   - Update `getRolePoolEntries()` so configured pool entries are intersected with currently alive/eligible terminals before rendering.
   - Do **not** keep the current raw fallback of “empty configured pool means render every role-tagged terminal from `lastTerminals`” after `CLEAR & RESET`.
   - Preserve READY/OFFLINE badges for diagnostics, but OFFLINE/reloaded orphan entries should no longer be treated as active pool members after reset.
   - Prefer reusing the same alive/effective-pool rules already enforced in `TaskViewerProvider` so the webview and dispatch engine stay aligned.

4. **Add regression coverage in `src\test\autoban-state-regression.test.js`.**
   - Extend the existing source-level assertions to cover the reload/reset reconciliation path in `TaskViewerProvider.ts`.
   - Add an assertion that `implementation.html` no longer relies on the raw `(configuredPool.length > 0 ? configuredPool : liveRoleTerminals)` fallback for reset behavior.
   - If the existing regex-style test becomes too brittle, add one narrowly scoped companion regression test, but keep the coverage focused on reload + `CLEAR & RESET`.

## Dependency / Conflict Findings
- `src\services\TaskViewerProvider.ts` `_refreshTerminalStatuses()` feeds the entire terminal registry to the sidebar. That broad behavior is useful outside Autoban, so avoid a global “hide all offline terminals” change unless the Autoban-only fix proves impossible.
- `src\services\TaskViewerProvider.ts` `_getAliveAutobanTerminalRegistry()` / `_resolveAutobanEffectivePool()` already encode the backend notion of “alive Autoban candidate.” Reuse those semantics instead of inventing a second, divergent pool rule in the webview.
- `src\services\TaskViewerProvider.ts` `_resetAutobanPools()` only closes managed backup terminals. If the reported leftovers are restored non-managed role terminals, the correct fix is to filter them out of the Autoban pool, not to start closing arbitrary user terminals.
- `src\services\TaskViewerProvider.ts` `housekeepStaleTerminals()` is too delayed to solve a reload-time bug and should not be treated as the main fix.

## Verification Plan
1. `npm run compile-tests`
2. `npm run compile`
3. `npm run lint`
4. `node src\test\autoban-state-regression.test.js`
5. `node src\test\autoban-controls-regression.test.js`
6. Manual reload regression check in the VS Code extension host:
   - Create or preserve multiple Autoban terminals.
   - Reload the VS Code window.
   - Open the Autoban tab and verify the pre-fix repro still matches the reported behavior.
   - Click `CLEAR & RESET`.
   - Confirm send counters clear, timers restart if Autoban stays enabled, and orphaned Autoban entries disappear from the pool list without using each terminal’s individual remove/close control.
   - Confirm legitimate non-Autoban/manual terminals are not unintentionally closed.

## Open Questions
- If no configured Autoban pool remains after reset, should the UI stay empty until the user re-adds terminals, or should the provider reseed only from confirmed-alive primary role terminals? Decide this once and implement the same rule in both provider and webview code.
- If a restored terminal is alive by name but no longer matches the old PID after reload, prefer name + IDE matching before aggressive cleanup so legitimate terminals are not misidentified as orphaned.

## Complexity Audit
- **Implementation surface:** Medium — expected changes in `src\services\TaskViewerProvider.ts`, `src\webview\implementation.html`, and `src\test\autoban-state-regression.test.js`.
- **Risk:** Medium — terminal registry state is shared with the broader sidebar, so a careless fix could hide or close legitimate user terminals.
- **Why this is not high complexity:** the bug is localized to Autoban pool/reset behavior after reload; no workflow, MCP, or plan-routing protocol changes are required.
- **Routing recommendation:** standard coder / accuracy-style implementation is appropriate. Do not escalate to `handoff-lead`; this is a focused bugfix, but it needs careful manual reload verification.
