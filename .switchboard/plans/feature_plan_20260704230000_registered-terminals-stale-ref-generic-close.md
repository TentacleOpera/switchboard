# Stale _registeredTerminals References for Non-MCP Terminals on Close

**Plan ID:** D1210C16-3DD2-4490-B80D-33E45DA982FD

## Goal

Clean up the in-memory `_registeredTerminals` dispatch map in the **generic** path of `handleTerminalClosed()`, so that all terminal types (not just the MCP monitor) have their disposed `vscode.Terminal` object removed when they close. This closes a pre-existing asymmetry surfaced during the MCP monitor leak fix review.

### Problem

`handleTerminalClosed()` (TaskViewerProvider.ts:15973) is the generic close handler that fires for every terminal VS Code closes. It cleans up `state.terminals` (persistent, line 16000) and `_terminalAgentInfo` (line 16007) for **all** closed terminals. However, `_registeredTerminals?.delete(...)` only runs inside the MCP-monitor-specific `if (closedStripped === monitorStripped)` branch (line 16026). For every other terminal type (planner, coder, lead, reviewer, analyst, custom agents, worktree terminals), the disposed `vscode.Terminal` object is never removed from `_registeredTerminals` and lingers as a stale reference until a full map clear (workspace switch via `clearRegisteredTerminalsMap()` at line 565, deregister-all at line 16087, or extension restart rebuild).

### Background Context

`_registeredTerminals` is an in-memory `Map<string, vscode.Terminal>` (line 329) used as a dispatch map — when the agent grid or message-routing code needs to send text to a terminal by name, it looks up the live `vscode.Terminal` object here. Entries are added whenever a terminal is created or registered (lines 2883, 7048, 15894, 15948, 20748). The map is keyed by **suffixed** names (via `_suffixedName()` at line 1538, which appends `-${vscode.env.appName}`).

The MCP monitor leak fix (feature_plan_20260704224643) added `_registeredTerminals?.delete(...)` to the MCP-monitor branch of `handleTerminalClosed` but left the generic path untouched, making the asymmetry more visible.

### Root Cause Analysis

The root cause is a **cleanup asymmetry** in `handleTerminalClosed()`:

1. `state.terminals[name]` is deleted for all closed terminals (line 16000, inside the `if (terminalName)` block within the `updateState` callback).
2. `_terminalAgentInfo` is cleared for all closed terminals (line 16007, via `clearTerminalAgentInfo(cleanedTerminalName)` — note: this runs in a **separate** `if (cleanedTerminalName)` block **after** the `updateState` callback closes at line 16004, NOT inside the `if (terminalName)` block).
3. `_registeredTerminals?.delete(...)` is only called for the MCP monitor (line 16026, inside the MCP-specific `if` block).

The fix is to add a `_registeredTerminals` cleanup that runs for all terminal types, mirroring `clearTerminalAgentInfo`. The existing live-terminal-name guard at lines 15988-15997 (which prevents deleting a newly-registered terminal's `state.terminals` entry when a name collision occurs) already protects `terminalName`/`cleanedTerminalName` — the same guard protects the `_registeredTerminals` delete since it uses the same resolved name value.

**Placement decision (Clarification — see Adversarial Synthesis):** Two valid insertion points exist:
- **Option A (original proposal):** inside the `if (terminalName)` block at lines 15999-16003, alongside the `state.terminals` delete. Runs while the `updateState` state-lock is held (synchronous, no await, no deadlock risk).
- **Option B (recommended):** in the `if (cleanedTerminalName)` block at lines 16006-16008, alongside `clearTerminalAgentInfo(cleanedTerminalName)`. This is the **preferred** placement because `_registeredTerminals` and `_terminalAgentInfo` are both in-memory Maps keyed by suffixed name, both cleaned for all terminal types, and both intentionally kept outside the persistent-state lock. Placing both in-memory map cleanups in the same block makes the generic close path symmetric and keeps the state lock focused on persistent state.

**Key alignment consideration:** `terminalName`/`cleanedTerminalName` is resolved two ways:
- **PID match** (lines 15981-15986): returns the suffixed key from `state.terminals` — aligns with `_registeredTerminals` keys.
- **Name fallback** (line 15995): returns `terminal.name` (raw VS Code name). This only matches `state.terminals[terminal.name]` if `terminal.name` already ends with the IDE suffix (since state keys are suffixed). In practice, if the name fallback fires, `terminal.name` IS the suffixed key (otherwise `terminals[terminal.name]` wouldn't have matched). So key alignment holds in both paths.

To be defensive, the delete should try both `cleanedTerminalName` and `this._suffixedName(cleanedTerminalName)` — `_suffixedName` is idempotent (returns the input unchanged if it already ends with the suffix, line 1540), so the second delete is a safe no-op when the key is already suffixed. (Clarification: because both resolution paths already yield suffixed keys, the `_suffixedName` fallback is in practice always a no-op; it is retained as harmless belt-and-suspenders, not because either path actually produces an unsuffixed key.)

## Metadata
- **Tags:** bugfix, backend
- **Complexity:** 4
- **Affected Files:** `src/services/TaskViewerProvider.ts`

## User Review Required

No — this is a straightforward cleanup with no behavioral trade-offs. The fix makes an existing cleanup path more complete; it doesn't change any control flow or add new state writes. (Clarification: the only open question is the A-vs-B placement choice, which is a code-organization preference, not a behavioral change. Option B is recommended; see Proposed Changes.)

## Complexity Audit

### Routine
- Add `_registeredTerminals?.delete(cleanedTerminalName)` (with a defensive `_suffixedName` fallback) — recommended placement: the generic `if (cleanedTerminalName)` block in `handleTerminalClosed()` (TaskViewerProvider.ts:16006-16008), alongside the existing `clearTerminalAgentInfo(cleanedTerminalName)` call. (Original proposal Option A placed it in the `if (terminalName)` block at lines 15999-16003; both are functionally equivalent, Option B is preferred for consistency with the sibling in-memory map cleanup.)
- The MCP-monitor-specific `_registeredTerminals?.delete(...)` at line 16026 is **left in place** — see Complex/Risky for why it is NOT merely redundant.

### Complex / Risky
- **Name-collision guard interaction:** The existing guard at lines 15988-15997 skips the `state.terminals` delete when a live terminal with the same name exists (prevents a race where old close events delete newly registered terminals). The `_registeredTerminals` delete uses the same `cleanedTerminalName` value (derived from `terminalName`), so it inherits the same guard protection. No additional guarding needed.
- **Key alignment:** As analyzed above, `terminalName`/`cleanedTerminalName` is always a suffixed key when resolved (both PID-match and name-fallback paths produce suffixed keys). The defensive `this._suffixedName(cleanedTerminalName)` fallback is a no-op when the key is already suffixed, so it adds safety without risk.
- **MCP-specific delete is a fallback, NOT redundant (correction):** The original draft called the line-16026 delete "redundant but harmless." That framing is incorrect. When `terminal.processId` does not resolve within the 1-second timeout (line 15975), `terminalName` is `undefined` and the generic `if (terminalName)`/`if (cleanedTerminalName)` blocks are SKIPPED entirely. For the MCP monitor specifically, the name-fallback at line 15988 also fails, because `terminal.name` is the raw `"Comms Monitor"` while `state.terminals` is keyed by the suffixed `"Comms Monitor-${appName}"`. In that PID-timeout case the generic cleanup does nothing for the monitor, and the MCP-specific block (which matches by stripped NAME at lines 16018-16020, not PID) is the ONLY path that removes the monitor from `_registeredTerminals`. It is therefore a load-bearing fallback for the PID-timeout edge case, not redundant. Leave it.
- **No new state writes:** This change only mutates the in-memory `_registeredTerminals` map. No `updateState`, no `GlobalIntegrationConfigService`, no persistent state changes. No race conditions with file watchers or cross-IDE sync.

## Edge-Case & Dependency Audit

- **Race Conditions (corrected):** None introduced. With the recommended Option B placement, the `_registeredTerminals` delete runs in the `if (cleanedTerminalName)` block at lines 16006-16008, which executes AFTER the `await this.updateState(...)` callback has returned (the callback closes at line 16004) — i.e., the persistent-state lock is no longer held. The `_registeredTerminals.delete` is a synchronous in-memory operation with no await, so there is no re-entrancy or deadlock risk. (The original draft's claim that the lock was "already acquired and released" while also placing the delete "inside the same `if (terminalName)` block" was self-contradictory; Option B makes the lock-released statement accurate. Under Option A the lock would still be held during the delete — also safe, since the delete is synchronous, but Option B's semantics are cleaner.)
- **Security:** No security implications. No secrets, credentials, or elevated operations touched. `_registeredTerminals` is an in-memory dispatch map only.
- **Side Effects:**
  - `_registeredTerminals?.delete(cleanedTerminalName)` mutates the in-memory dispatch map; safe — the disposed terminal is no longer dispatchable. Dispatch callers (e.g. `_executeLocal` at line 15772) already have fallback resolution via `vscode.window.terminals` (line 15786), so removing the stale entry doesn't break any caller — it just prevents them from finding a dead terminal object first. **API behavior confirmed (web research):** `vscode.Terminal.sendText()` on a closed-but-not-`.dispose()`'d terminal does NOT throw, reject, or return a promise — it is a void, fire-and-forget RPC (`$sendText`) whose only disposal guard (`_checkDisposed()`) fires on the `.dispose()` path, NOT on the close/`onDidCloseTerminal` path. Consequently, a lingering stale `_registeredTerminals` entry causes `sendText` to **silently no-op** (the message is swallowed with no visible warning and no catchable error); the `_executeLocal` sendText calls (lines 15791-15799) being unguarded by try/catch is therefore NOT a rejection risk for this case — a try/catch would not catch this failure mode anyway. **Observable improvement from the fix:** with the stale entry removed, `_executeLocal`'s `get()` returns undefined, falls through to the `vscode.window.terminals.find()` fallback (line 15786), fails to find the closed terminal (VS Code splices it from `window.terminals` before firing `onDidCloseTerminal`), and surfaces the visible "Terminal not found" warning at line 15788. The fix changes dispatch-to-a-closed-terminal from a **silent swallow** to a **visible warning** — strictly better observability.
  - The MCP-monitor-specific delete at line 16026 remains — load-bearing fallback for the PID-timeout case, not redundant (see Complex/Risky).
  - **Optional complementary hardening (OUT OF SCOPE for this plan):** the research notes that the only reliable in-band liveness signal for a cached `Terminal` is `terminal.exitStatus !== undefined` (set by `$acceptTerminalClosed` at the same moment `onDidCloseTerminal` fires). A defensive `exitStatus` pre-check in `_executeLocal` before `sendText` would cover the narrow window where a dispatch is in flight concurrently with the close event, or where the close-handler prune has a bug. This is a separate dispatch-path concern and is NOT part of this plan's scope (this plan is strictly the close-handler cleanup); it is noted here only so the implementer is aware. Filing it as a follow-up plan is appropriate if desired.
- **Dependencies & Conflicts:**
  - No dependency on other plans or in-flight work.
  - The MCP monitor leak fix (feature_plan_20260704224643) is a prerequisite in the sense that this plan generalizes its pattern, but there's no code-level dependency — this plan can be applied independently.

1. **Normal terminal close (user closes via X):** `handleTerminalClosed` fires, `terminalName` is resolved via PID match or name fallback, `cleanedTerminalName` is set, the `updateState` block deletes from `state.terminals`, then the post-lock block clears `_terminalAgentInfo` + `_registeredTerminals`. Covered by the fix.

2. **Name collision (old close event for a terminal whose name was reused by a new terminal):** The guard at lines 15988-15997 skips resolving `terminalName` (sets it undefined), so `cleanedTerminalName` stays undefined and neither the `state.terminals` delete nor the post-lock `_registeredTerminals`/`_terminalAgentInfo` cleanup runs. The new terminal's entries survive. Correct behavior — no change from current.

3. **MCP monitor close (PID resolves normally):** The generic block resolves `cleanedTerminalName` (PID match against the suffixed monitor key in `state.terminals`) and removes it from `_registeredTerminals`. The MCP-specific block (line 16026) then attempts the same delete — idempotent (`Map.delete` on a missing key is a no-op). No issue.

4. **MCP monitor close (PID times out):** `terminalName` is undefined, generic block skipped. The MCP-specific block matches by stripped NAME and performs the delete — this is the load-bearing fallback (see Complex/Risky). Without leaving line 16026 in place, the monitor's stale entry would linger in this edge case.

5. **`terminalName` is `undefined` (PID didn't resolve and name didn't match):** The `if (terminalName)` block is skipped entirely and `cleanedTerminalName` is undefined, so the post-lock `if (cleanedTerminalName)` block is also skipped. `_registeredTerminals` is not touched. This is the same behavior as today for `state.terminals` and `_terminalAgentInfo` — no regression.

## Dependencies

None. Self-contained single-file bugfix in `src/services/TaskViewerProvider.ts`.

## Adversarial Synthesis

Key risks: (1) Stale line numbers throughout the original draft (handler at 15973, not 15887; delete at 16026, not 15940) — re-anchored to the current file. (2) Structural conflation of `clearTerminalAgentInfo` (post-lock, line 16007) with the in-lock `state.terminals` delete — corrected; Option B placement (alongside `clearTerminalAgentInfo`) is recommended so both in-memory map cleanups share one block and the lock-released race reasoning becomes accurate. (3) The MCP-specific delete at 16026 was mislabeled "redundant" — it is a load-bearing fallback for the PID-timeout case (generic block skipped, name-fallback fails for the raw monitor name) and must remain. (4) `sendText`-on-disposed-terminal behavior — **resolved via web research**: confirmed silent fire-and-forget no-op (no throw/reject), so a stale entry causes a silent swallow (not an unhandled rejection as the prior draft speculated); the fix upgrades this to a visible "Terminal not found" warning via the `vscode.window.terminals` fallback. Mitigations: re-anchored line numbers; Option B placement; retain the MCP delete; verification Step 1 wording locked to confirmed API behavior. Net: strictly more correct than current code; the fix makes the generic close path symmetric with the MCP-specific path and improves dispatch observability.

## Proposed Changes

### File: `src/services/TaskViewerProvider.ts`

#### Change 1 (Option A — original proposal): Add generic `_registeredTerminals` cleanup inside the `updateState` callback in `handleTerminalClosed()` (TaskViewerProvider.ts:15999-16003)

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

**Note:** The MCP-monitor-specific `_registeredTerminals?.delete(...)` at line 16026 is left in place — it is a load-bearing fallback for the PID-timeout case (not redundant; see Complexity Audit). `Map.delete` on a missing key is a no-op, so when the generic block already removed the key there is no conflict.

#### Change 1 (Option B — RECOMMENDED): Add generic `_registeredTerminals` cleanup in the post-lock `if (cleanedTerminalName)` block (TaskViewerProvider.ts:16006-16008)

Place the delete next to `clearTerminalAgentInfo(cleanedTerminalName)`, mirroring the sibling in-memory map cleanup. This keeps both in-memory Map deletions in one block, runs after the persistent-state lock is released, and makes the generic close path symmetric with how `_terminalAgentInfo` is already handled for all terminal types.

```typescript
if (cleanedTerminalName) {
    this.clearTerminalAgentInfo(cleanedTerminalName);
    // Clean up in-memory dispatch map for all terminal types (defensive: try both raw and suffixed keys)
    this._registeredTerminals?.delete(cleanedTerminalName);
    this._registeredTerminals?.delete(this._suffixedName(cleanedTerminalName));
}
```

**Why Option B is preferred over Option A:** `_registeredTerminals` and `_terminalAgentInfo` are both in-memory `Map`s keyed by suffixed name, both non-persistent, and both already cleaned for all terminal types only in the case of `_terminalAgentInfo`. Co-locating their cleanup (a) makes the symmetry the plan is trying to achieve explicit, (b) keeps the `updateState` lock focused solely on persistent `state.terminals` mutation, and (c) makes the "lock already released" race reasoning accurate. Option A is functionally safe but leaves the two in-memory map cleanups split across the lock boundary for no benefit.

**Either option is safe; pick one.** Option B is the reviewer's recommendation. Do NOT apply both — that would double-delete (harmless via `Map.delete` idempotency, but unnecessary).

## Verification Plan

> Per session directives: **compilation and automated tests are SKIPPED**. Verification is manual, via an installed VSIX.

### Automated Tests
Skipped per session directive. No unit/integration tests will be run as part of this plan's verification.

### Manual Verification

> **API behavior confirmed (web research):** `vscode.Terminal.sendText()` on a closed-but-not-`.dispose()`'d terminal is a void, fire-and-forget RPC that silently no-ops — it does NOT throw, reject, or return a promise, so a try/catch around `sendText` cannot catch this failure mode. The reliable liveness signal is `terminal.exitStatus !== undefined` (set at the moment `onDidCloseTerminal` fires). The observable claims in Steps 1 and 6 below are grounded in this confirmed behavior.

1. **Open agent terminal → close via X → check dispatch:** Launch a standard agent terminal (e.g. coder). Close it via the X button. Attempt to send a message to it via the agent grid. **Before the fix (current bug):** the stale `_registeredTerminals` entry is found by `get()`, `sendText` silently no-ops (per confirmed API behavior), and the message is swallowed with NO visible warning. **After the fix:** the stale entry is gone, `_executeLocal`'s `get()` returns undefined, dispatch falls through to the `vscode.window.terminals.find()` fallback at line 15786, the closed terminal is absent from `window.terminals` (VS Code splices it before firing `onDidCloseTerminal`), and the visible "Terminal not found" warning at line 15788 is shown. Confirm the post-fix behavior shows the warning (i.e. the fix upgrades dispatch-to-a-closed-terminal from silent swallow to visible warning).

2. **Open agent terminal → close via X → reopen agent grid:** Launch a coder terminal. Close it. Open the agent grid. Confirm no stale/disposed terminal appears in the grid (the `state.terminals` cleanup already handles this, but the `_registeredTerminals` cleanup ensures the dispatch map doesn't hold a dead reference).

3. **MCP monitor close (regression check, PID resolves):** Launch the MCP monitor. Close it via X. Open the agent grid. Confirm the MCP monitor does NOT appear (verifies the generic cleanup doesn't interfere with the MCP-specific cleanup — both are idempotent).

4. **MCP monitor close (PID timeout edge case):** Launch the MCP monitor. Close it via X under conditions where `terminal.processId` is slow/unavailable (e.g. very fast close). Confirm the MCP monitor still disappears from `_registeredTerminals` — this verifies the retained MCP-specific delete at line 16026 is doing its load-bearing fallback job when the generic block is skipped.

5. **Name collision (edge case):** Launch a coder terminal. Close it. Immediately launch another coder terminal with the same name (before the close event fires). Confirm the new terminal survives — the guard at lines 15988-15997 prevents `cleanedTerminalName` from being set, so neither `state.terminals` nor `_registeredTerminals` is cleaned for the new terminal.

6. **Check `_registeredTerminals` after generic close:** After closing a non-MCP agent terminal, confirm `_registeredTerminals` no longer contains the terminal's key (no stale disposed-terminal reference). This can be verified via debug logging or by observing that dispatch to the closed terminal no longer finds a stale entry.

## Resolved Assumptions (Web Research Completed)

The single uncertainty flagged in the prior draft — `vscode.Terminal.sendText()` behavior on a closed/disposed terminal — has been confirmed via web research against the VS Code extension-host source (`extHostTerminalService.ts`), the `vscode.d.ts` API reference, and the microsoft/vscode issue tracker. Findings, now integrated into the Side Effects and Verification Plan sections:

- `sendText()` on a closed-but-not-`.dispose()`'d terminal is a **void, fire-and-forget RPC** (`$sendText`) that **silently no-ops** — no throw, no reject, no return value. The extension-host `_checkDisposed()` guard fires only on the `.dispose()` path, NOT on the `onDidCloseTerminal` close path.
- A try/catch around `sendText` cannot catch this failure mode (no exception is raised).
- The reliable liveness signal is `terminal.exitStatus !== undefined`, set at the moment `onDidCloseTerminal` fires.
- Observable impact on this plan: a stale `_registeredTerminals` entry causes a **silent swallow** (not an unhandled rejection, as the prior draft speculated); the fix upgrades this to a **visible "Terminal not found" warning** via the `vscode.window.terminals` fallback.

No further research is needed. All other claims (line numbers, `_suffixedName` idempotency at line 1540, `Map.delete` idempotency, the guard semantics at lines 15988-15997, the registration sites, the full-map-clear sites at lines 565 and 16087, and the dispatch fallback in `_executeLocal` at lines 15779-15794) were verified directly against the current source.

---

**Recommendation:** Complexity 4 → **Send to Coder**. Routine single-file bugfix that generalizes an existing cleanup pattern. The `sendText`-on-disposed API behavior is now confirmed (silent no-op, not a throw), so verification Step 1's observable claim is locked. The implementer must choose and apply the correct placement (Option B recommended) and leave the MCP-specific delete at line 16026 in place as the PID-timeout fallback. No persistent state writes or async races.

## Review Findings

Implemented as recommended (Option B): `src/services/TaskViewerProvider.ts:16186-16191` adds `_registeredTerminals?.delete(cleanedTerminalName)` + `_suffixedName(...)` fallback in the post-lock `if (cleanedTerminalName)` block, alongside `clearTerminalAgentInfo`; the MCP-specific delete at line 16209 is correctly retained as the PID-timeout fallback and only one placement was applied (no double-delete). Regression analysis passed: all nine `_registeredTerminals.get()` consumers fall back through suffixed → case-insensitive scan → `vscode.window.terminals` → null-guard, so removing a stale entry is strictly safe; the name-collision guard (16168-16177) still gates `cleanedTerminalName` so a live reused-name terminal can't be evicted; no UI double-trigger introduced (the delete correctly adds no `_notifyTerminalAgentNamesChanged`, unlike the role-driven `_terminalAgentInfo`). Verification: compilation and tests skipped per session directive; verified inline against the plan's manual scenarios and key-alignment claims. No CRITICAL/MAJOR findings and no code fixes applied — only two NITs (the `_suffixedName` fallback and its "raw" comment are dead-in-practice belt-and-suspenders), left as-is per the plan's explicit design decision. Remaining risk: none material; the optional `exitStatus` dispatch-path hardening remains an out-of-scope follow-up.
