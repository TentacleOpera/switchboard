# Stale _registeredTerminals References for Non-MCP Terminals on Close

## Goal

Clean up the in-memory `_registeredTerminals` dispatch map in the **generic** path of `handleTerminalClosed()`, so that all terminal types (not just the MCP monitor) have their disposed `vscode.Terminal` object removed when they close. This closes a pre-existing asymmetry surfaced during the MCP monitor leak fix review.

### Problem

`handleTerminalClosed()` (TaskViewerProvider.ts:15887) is the generic close handler that fires for every terminal VS Code closes. It cleans up `state.terminals` (persistent, line 15914) and `_terminalAgentInfo` (line 15921) for **all** closed terminals. However, `_registeredTerminals?.delete(...)` only runs inside the MCP-monitor-specific `if (closedStripped === monitorStripped)` branch (line 15940). For every other terminal type (planner, coder, lead, reviewer, analyst, custom agents, worktree terminals), the disposed `vscode.Terminal` object is never removed from `_registeredTerminals` and lingers as a stale reference until a full map clear (workspace switch, Reset button, or extension restart rebuild).

### Background Context

`_registeredTerminals` is an in-memory `Map<string, vscode.Terminal>` (line 329) used as a dispatch map — when the agent grid or message-routing code needs to send text to a terminal by name, it looks up the live `vscode.Terminal` object here. Entries are added whenever a terminal is created or registered (lines 2850, 7019, 15808, 15862, 20662). The map is keyed by **suffixed** names (via `_suffixedName()`, which appends `-${vscode.env.appName}`).

The MCP monitor leak fix (feature_plan_20260704224643) added `_registeredTerminals?.delete(...)` to the MCP-monitor branch of `handleTerminalClosed` but left the generic path untouched, making the asymmetry more visible.

### Root Cause Analysis

The root cause is a **cleanup asymmetry** in `handleTerminalClosed()`:

1. `state.terminals[name]` is deleted for all closed terminals (line 15914, inside the `if (terminalName)` block).
2. `_terminalAgentInfo` is cleared for all closed terminals (line 15921, via `clearTerminalAgentInfo(cleanedTerminalName)`).
3. `_registeredTerminals?.delete(...)` is only called for the MCP monitor (line 15940, inside the MCP-specific `if` block).

The fix is to move the `_registeredTerminals` cleanup into the generic `if (terminalName)` block (alongside the `state.terminals` delete and `clearTerminalAgentInfo` call), so it runs for all terminal types. The existing live-terminal-name guard at lines 15905-15910 (which prevents deleting a newly-registered terminal's `state.terminals` entry when a name collision occurs) already protects `terminalName` — the same guard protects the `_registeredTerminals` delete since it uses the same `terminalName` value.

**Key alignment consideration:** `terminalName` is resolved two ways:
- **PID match** (line 15897): returns the suffixed key from `state.terminals` — aligns with `_registeredTerminals` keys.
- **Name fallback** (line 15909): returns `terminal.name` (raw VS Code name). This only matches `state.terminals[terminal.name]` if `terminal.name` already ends with the IDE suffix (since state keys are suffixed). In practice, if the name fallback fires, `terminal.name` IS the suffixed key (otherwise `terminals[terminal.name]` wouldn't have matched). So key alignment holds in both paths.

To be defensive, the delete should try both `terminalName` and `this._suffixedName(terminalName)` — `_suffixedName` is idempotent (returns the input unchanged if it already ends with the suffix), so this is a safe no-op when the key is already suffixed.

## Metadata
- **Tags:** bugfix, backend
- **Complexity:** 3
- **Affected Files:** `src/services/TaskViewerProvider.ts`

## User Review Required

No — this is a straightforward cleanup with no behavioral trade-offs. The fix makes an existing cleanup path more complete; it doesn't change any control flow or add new state writes.

## Complexity Audit

### Routine
- Add `_registeredTerminals?.delete(terminalName)` (with a defensive `_suffixedName` fallback) to the generic `if (terminalName)` block in `handleTerminalClosed()` (TaskViewerProvider.ts:15913-15917), alongside the existing `state.terminals` delete and `cleanedTerminalName` assignment.
- The MCP-monitor-specific `_registeredTerminals?.delete(...)` at line 15940 becomes redundant (the generic cleanup now covers it) but is **left in place** — it's idempotent (`Map.delete` on a missing key is a no-op) and provides belt-and-suspenders coverage if the generic block's `terminalName` resolution fails for the MCP monitor edge case.

### Complex / Risky
- **Name-collision guard interaction:** The existing guard at lines 15905-15910 skips the `state.terminals` delete when a live terminal with the same name exists (prevents a race where old close events delete newly registered terminals). The `_registeredTerminals` delete uses the same `terminalName` value, so it inherits the same guard protection. No additional guarding needed.
- **Key alignment:** As analyzed above, `terminalName` is always a suffixed key when resolved (both PID-match and name-fallback paths produce suffixed keys). The defensive `this._suffixedName(terminalName)` fallback is a no-op when the key is already suffixed, so it adds safety without risk.
- **No new state writes:** This change only mutates the in-memory `_registeredTerminals` map. No `updateState`, no `GlobalIntegrationConfigService`, no persistent state changes. No race conditions with file watchers or cross-IDE sync.

## Edge-Case & Dependency Audit

- **Race Conditions:** None introduced. The `_registeredTerminals` delete is synchronous and occurs after the `state.terminals` delete (inside the same `if (terminalName)` block). The `updateState` lock has already been acquired and released by this point (the `await this.updateState(...)` block ends at line 15918). No concurrent state mutation risk.
- **Security:** No security implications. No secrets, credentials, or elevated operations touched. `_registeredTerminals` is an in-memory dispatch map only.
- **Side Effects:**
  - `_registeredTerminals?.delete(terminalName)` mutates the in-memory dispatch map; safe — the disposed terminal is no longer dispatchable. Dispatch callers (e.g. `_executeLocal` at line 15687) already have fallback resolution via `vscode.window.terminals` (line 15700), so removing the stale entry doesn't break any caller — it just prevents them from finding a dead terminal object first.
  - The MCP-monitor-specific delete at line 15940 remains — redundant but harmless.
- **Dependencies & Conflicts:**
  - No dependency on other plans or in-flight work.
  - The MCP monitor leak fix (feature_plan_20260704224643) is a prerequisite in the sense that this plan generalizes its pattern, but there's no code-level dependency — this plan can be applied independently.

1. **Normal terminal close (user closes via X):** `handleTerminalClosed` fires, `terminalName` is resolved via PID match or name fallback, generic block deletes from `state.terminals` + `_terminalAgentInfo` + `_registeredTerminals`. Covered by the fix.

2. **Name collision (old close event for a terminal whose name was reused by a new terminal):** The guard at lines 15905-15910 skips the entire `if (terminalName)` block, so neither `state.terminals` nor `_registeredTerminals` is touched. The new terminal's entries survive. Correct behavior — no change from current.

3. **MCP monitor close:** Both the generic block (new fix) and the MCP-specific block (line 15940) attempt to delete from `_registeredTerminals`. Idempotent — `Map.delete` on a missing key is a no-op. No issue.

4. **`terminalName` is `undefined` (PID didn't resolve and name didn't match):** The `if (terminalName)` block is skipped entirely. `_registeredTerminals` is not touched. This is the same behavior as today for `state.terminals` and `_terminalAgentInfo` — no regression.

## Dependencies

None. Self-contained single-file bugfix in `src/services/TaskViewerProvider.ts`.

## Adversarial Synthesis

Key risks: (1) Key misalignment between `terminalName` and `_registeredTerminals` keys — mitigated by the defensive `_suffixedName` fallback (idempotent, no-op when already suffixed). (2) Name-collision guard interaction — mitigated by using the same `terminalName` value that the guard already protects. (3) Double-delete with the MCP-specific block — mitigated by `Map.delete` idempotency. No persistent state writes, no async races, no new side effects beyond removing a stale in-memory reference. The fix is strictly more correct than the current code — it makes the generic close path symmetric with the MCP-specific path.

## Proposed Changes

### File: `src/services/TaskViewerProvider.ts`

#### Change 1: Add generic `_registeredTerminals` cleanup in `handleTerminalClosed()` (TaskViewerProvider.ts:15913-15917)

Add the `_registeredTerminals` delete to the generic `if (terminalName)` block, alongside the existing `state.terminals` delete and `cleanedTerminalName` assignment. Use a defensive `_suffixedName` fallback to handle both PID-match (already suffixed) and name-fallback (should be suffixed but defensive) resolution paths.

```typescript
if (terminalName) {
    delete state.terminals[terminalName];
    cleanedTerminalName = terminalName;
    console.log(`[TaskViewerProvider] Auto-cleaned state for closed terminal: ${terminalName}`);
    // Clean up in-memory dispatch map (defensive: try both raw and suffixed keys)
    this._registeredTerminals?.delete(terminalName);
    this._registeredTerminals?.delete(this._suffixedName(terminalName));
}
```

**Note:** The MCP-monitor-specific `_registeredTerminals?.delete(...)` at line 15940 is left in place — it's now redundant (the generic block covers it) but harmless (`Map.delete` on a missing key is a no-op) and provides belt-and-suspenders coverage.

## Verification Plan

> Per session directives: **compilation and automated tests are SKIPPED**. Verification is manual, via an installed VSIX.

### Automated Tests
Skipped per session directive. No unit/integration tests will be run as part of this plan's verification.

### Manual Verification

1. **Open agent terminal → close via X → check dispatch:** Launch a standard agent terminal (e.g. coder). Close it via the X button. Attempt to send a message to it via the agent grid. Confirm the message is not silently swallowed (the stale `_registeredTerminals` entry is gone, so the dispatch falls through to the `vscode.window.terminals` fallback which shows the "Terminal not found" warning).

2. **Open agent terminal → close via X → reopen agent grid:** Launch a coder terminal. Close it. Open the agent grid. Confirm no stale/disposed terminal appears in the grid (the `state.terminals` cleanup already handles this, but the `_registeredTerminals` cleanup ensures the dispatch map doesn't hold a dead reference).

3. **MCP monitor close (regression check):** Launch the MCP monitor. Close it via X. Open the agent grid. Confirm the MCP monitor does NOT appear (verifies the generic cleanup doesn't interfere with the MCP-specific cleanup — both are idempotent).

4. **Name collision (edge case):** Launch a coder terminal. Close it. Immediately launch another coder terminal with the same name (before the close event fires). Confirm the new terminal survives — the guard at lines 15905-15910 prevents both `state.terminals` and `_registeredTerminals` from being cleaned for the new terminal.

5. **Check `_registeredTerminals` after generic close:** After closing a non-MCP agent terminal, confirm `_registeredTerminals` no longer contains the terminal's key (no stale disposed-terminal reference). This can be verified via debug logging or by observing that dispatch to the closed terminal no longer finds a stale entry.

---

**Recommendation:** Complexity 3 → **Send to Coder**. Routine single-file bugfix; generalizes an existing cleanup pattern; no persistent state writes or async races.
