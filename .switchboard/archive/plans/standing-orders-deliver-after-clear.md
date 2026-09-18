# Deliver Standing Orders After Terminal Clear

## Goal
After a terminal is cleared (context reset via `clearTerminalContext`), the system re-sends the terminal its applicable standing orders as a one-shot prompt. A cleared terminal re-establishes its orders without waiting for the next dispatch.

### The problem, and the root cause
When `clearTerminalContext` (TaskViewerProvider.ts:10206) pastes `/clear` into a terminal, the terminal's context is reset. The standing orders block was part of that context — it was appended to the previous prompt by `applyStandingOrders`. After the clear, the terminal does not see its orders again until the next dispatch carries them back in. Between clear and next dispatch, the terminal is running without orders — it does not know its role, its callback target, or its constraints.

The fix: after `clearTerminalContext` completes (`cleared: true`), the system sends a one-shot standing-orders prompt containing the terminal's applicable orders, using the same `_deliverStandingOrdersOnEstablish` method from the establish-delivery subtask. (That method should be named neutrally — e.g. `_deliverStandingOrdersOneShot` — since it is now shared by the establish and clear lifecycle hooks. The establish plan owns its definition; this plan is its second caller.)

## Metadata
- **Complexity:** 4
- **Tags:** backend, reliability, feature
- **Feature:** standing-orders-on-terminal-establish-and-clear

## User Review Required
No — adds a delivery path for existing standing orders. No new product decisions.

## Complexity Audit

### Routine
- Calling `_deliverStandingOrdersOnEstablish` at the end of `clearTerminalContext` in the `cleared: true` branch.
- Resolving the terminal's role from `_terminalAgentInfo` (the role doesn't change on clear).

### Complex / Risky
- Timing: the one-shot orders prompt must be sent after the clear takes effect, not before. The clear path already has a delay (`clearBeforePromptDelay`, default 2000ms) between the `/clear` paste and the return. The one-shot is sent after the clear returns, so the clear has taken effect.
- Clear followed immediately by dispatch (the `queue/done` handler does clear → dispatch as one chain): the one-shot fires after clear, then the dispatch carries the orders again. **This yields two blocks in the terminal's context** — `stripStandingOrdersBlock` only strips a block from a single *prompt string*; it does NOT scan the terminal's accumulated context, so it cannot dedup across the one-shot prompt and the subsequent dispatch prompt. The redundancy is idempotent noise (same orders, twice), not a correctness bug. The only cost is a redundant prompt — acceptable, and the same trade-off the establish-delivery subtask accepts for the grid/worktree path.

## Edge-Case & Dependency Audit
- **Race Conditions:** Clear followed immediately by dispatch → the one-shot fires, then the dispatch carries the block. Two idempotent blocks in context — acceptable (NOT deduped by `stripStandingOrdersBlock`, which is prompt-scoped, not context-scoped). The per-terminal `withTerminalSendLock` serializes the one-shot against the dispatch, so the two sends cannot interleave.
- **Security:** No new endpoints. Uses the existing `ptySendPrompt` path.
- **Side Effects:** A cleared terminal now receives its standing orders immediately after the clear, rather than waiting for the next dispatch. For terminals with no applicable orders, the delivery is a no-op.
- **Dependencies & Conflicts:** Depends on the establish-delivery subtask (`_deliverStandingOrdersOnEstablish` / `_deliverStandingOrdersOneShot` method). Depends on the role-scope subtask (`renderStandaloneOrdersBlock`). Depends on `clearTerminalContext` (TaskViewerProvider.ts:10206, already landed). Does not conflict with any other plan.

## Dependencies
- `standing-orders-deliver-on-establish.md` — provides the shared one-shot delivery method. Must land first.
- `standing-orders-role-scope.md` — provides `renderStandaloneOrdersBlock` and the `roleMap` parameter. Must land first (transitive via establish-delivery).
- `clearTerminalContext` (TaskViewerProvider.ts:10206) — the clear path. Already landed.

## Adversarial Synthesis
Key risks: (1) the one-shot orders prompt arrives before the clear takes effect — mitigated by waiting for the clear to complete (the `clearTerminalContext` callback returns after the clipboard paste + delay); (2) the original plan's claim that `stripStandingOrdersBlock` dedups the one-shot and the subsequent dispatch into one block — it does NOT; it is prompt-scoped, not context-scoped, so clear-then-dispatch yields two idempotent blocks (reframed as acceptable noise, same as the establish path); (3) a terminal with no orders receives an empty prompt — mitigated by `renderStandaloneOrdersBlock` returning `null`. Mitigations: wait for clear, accept idempotent redundancy, null-check.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — deliver standing orders after clear
**Context:** `clearTerminalContext` (TaskViewerProvider.ts:10206) pastes `/clear` into a terminal and returns `{ cleared: boolean }`. There are TWO `cleared: true` return points: the PTY-fleet path (TaskViewerProvider.ts:10237) and the VS Code terminal path (TaskViewerProvider.ts:10280). After the clear, the terminal has no standing orders until the next dispatch.

**Logic:**
1. At BOTH `cleared: true` return points (10237 PTY, 10280 VS Code terminal), call `_deliverStandingOrdersOnEstablish(workspaceRoot, terminalName, role)` (the shared method from the establish-delivery subtask) BEFORE returning. The operation is identical to establish: "send this terminal its standing orders as a one-shot prompt." Hook both paths so PTY-fleet and VS Code terminals behave identically.
2. The role is resolved from `_terminalAgentInfo` (the terminal's role doesn't change on clear).
3. Guard: do not fire if `cleared` is false (the clear didn't happen — `clearBeforePrompt` was off, the terminal wasn't found, or the paste failed). Do not fire if no orders apply (`renderStandaloneOrdersBlock` returns `null`).
4. Timing: the clear path already has a delay (`clearBeforePromptDelay`, default 2000ms) between the `/clear` paste and the return. The one-shot orders prompt is sent after the clear returns, so the clear has taken effect. The orders prompt is a new context entry, not wiped by the clear.

> **Superseded:** "Add the call at the end of `clearTerminalContext`, in the `cleared: true` branch (after line 10213 for the PTY path, and the equivalent VS Code terminal path)."
> **Reason:** The line number was stale (actual `clearTerminalContext` is at 10206), and the `cleared: true` returns are at 10237 (PTY) and 10280 (VS Code terminal) — two distinct return points that must BOTH be hooked, not a single "branch."
> **Replaced with:** Hook both return points (10237 and 10280) with the shared one-shot delivery call before returning.

**Implementation:** Add the call at both `cleared: true` returns. The call is async and not awaited — the clear returns immediately, the orders delivery happens in the background (serialized against any concurrent dispatch by the per-terminal `withTerminalSendLock`). If the orders delivery fails, it logs a warning but does not affect the clear result.

**Edge Cases:** Clear followed immediately by dispatch (the `queue/done` handler) → the one-shot fires, then the dispatch carries the orders again → two idempotent blocks in context (NOT deduped by `stripStandingOrdersBlock`, which is prompt-scoped). Acceptable. Clear with no orders → no prompt sent. Clear with `clearBeforePrompt` off → `cleared: false` → no one-shot. Clear fails → `cleared: false` → no one-shot.

## Verification Plan
1. `npm run compile` — clean.
2. Unit: `clearTerminalContext` with `cleared: true` → calls `_deliverStandingOrdersOnEstablish` after the clear. `cleared: false` → does not call.
3. Manual: clear a coder terminal that is on a team. After the clear, the terminal receives its team-scoped and role-scoped standing orders as a one-shot prompt. The terminal knows its callback target and constraints without waiting for a dispatch.
4. Manual: clear a terminal with no standing orders. No prompt is sent (no noise).
5. Manual: clear a terminal, then immediately dispatch to it (the `queue/done` path). The one-shot fires after clear, the dispatch carries the block. Two idempotent blocks land in context (NOT deduped — `stripStandingOrdersBlock` is prompt-scoped). Verify no send corruption/garbling (the `withTerminalSendLock` serializes the two sends).

## Completion Report
Implemented the deliver-after-clear subtask. Added a private helper `_deliverStandingOrdersAfterClear(terminalName)` to `src/services/TaskViewerProvider.ts` that resolves the terminal's role from `_terminalAgentInfo` (normalized lookup, role unchanged by clear) and fire-and-forgets the shared `_deliverStandingOrdersOnEstablish` method. Wired this helper into both `cleared: true` return points in `clearTerminalContext`: the PTY-fleet path (uses `target.friendlyName`) and the VS Code terminal path (uses `terminal.name || terminalName`). The call is not awaited — the clear returns immediately and the orders delivery runs in the background, serialized against concurrent dispatch by the per-terminal `withTerminalSendLock`. The `cleared: false` paths (gate off, terminal not found, paste/clear failure) are untouched, so no one-shot fires when the clear did not happen. No issues encountered. Per the run directives, compilation and automated tests were skipped.

## Review Findings

Reviewed and fixed. CRITICAL (inherited from the shared method this plan calls): the one-shot ran with the configured `clearBeforePrompt`, default **on**, so the post-clear delivery pasted a second `/clear` — and because it is fire-and-forget it races the clear-then-dispatch chain that both `clearTerminalContext` callers run next (`LocalApiServer.ts:2210`, `:4108`, whose comment pins that ordering as "Do NOT reorder"), meaning a late one-shot could wipe the task prompt the seat had just been given. MAJOR: `terminalName` here is the PTY `friendlyName` / `terminal.name`, while the shared method's `roleMap` was keyed only on the IDE-suffixed `_terminalAgentInfo` keys, so `selectOrders`' exact lookup missed and role-scoped orders — this feature's entire payload — never resolved after a clear. MINOR: the helper's normalized role lookup fed only the orchestrator skip, which is an establish-time concern (nothing follows a clear, and both callers' next dispatch usually targets a *different* seat), so a cleared orchestrator silently lost its orders. Files changed in review: `src/services/TaskViewerProvider.ts` — `clearBeforePrompt: false` + `standingOrders: false` overrides on the delivery, dual-keyspace `roleMap`, and `_deliverStandingOrdersAfterClear` reduced to a single call passing `{ skipOrchestrator: false }`. Validation: typecheck + `npm run compile` clean, `standing-orders-marker` 63/0, `terminal-rest-clear` and `queue-pipeline` pass; residual risk is ordering only — the orders block may still land after a same-seat dispatch, which is now idempotent noise.
