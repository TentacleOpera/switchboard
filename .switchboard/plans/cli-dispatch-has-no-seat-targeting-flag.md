# CLI dispatch ignores planner round-robin — all dispatches land on the same seat

## Goal

Fix the planner round-robin so that sequential `switchboard dispatch` calls actually spread work across planner seats, and add a `--seat <name>` escape hatch for explicit targeting.

### Problem Analysis

**Round-robin is implemented but not working from the CLI.** `KanbanProvider.ts:10619-10625` has a planner rotation cursor (`getPlannerRotationCursor` / `advancePlannerRotationCursor`, `TaskViewerProvider.ts:8151-8163`) that picks `terminals[cursor % terminals.length]` and advances after successful dispatch. This is wired on both the `custom-user` branch (`:10521`) and the built-in branch (`:10619`). The cursor is stored in `globalState` (`switchboard.planner.rotationCursor`), keyed by `locationKey` from `getRoleTerminalSet`.

**Observed behaviour:** dispatching 2 cards via `switchboard dispatch <id> "PLAN REVIEWED"` sent both to `planner-1`. The second dispatch should have gone to `planner-2` because the cursor should have advanced after the first successful dispatch.

**Possible root causes:**
1. **The CLI path doesn't reach the round-robin branch.** `performKanbanDispatch` (`LocalApiServer.ts:2007`) calls `kanbanVerb('triggerAction', ...)` which enters the `triggerAction` case. The round-robin lives inside `if (canDispatch)` at `:10590` — if `canDispatch` was false (no agent CLI available), the round-robin is never reached and the card dispatches through a fallback that doesn't rotate.
2. **`advancePlannerRotationCursor` failed silently.** The advance is inside a `if (dispatched && plannerCursorLocationKey && tvp)` guard (`:10633`). If `dispatched` came back `false` or `undefined` despite the card moving, the cursor stays at 0.
3. **`getRoleTerminalSet` returned a different `locationKey`** between calls, so the second dispatch read a fresh cursor (0) instead of the advanced one.
4. **`globalState` is VS Code extension state** — the standalone/CLI host may not have a real `globalState` implementation, so the cursor writes go nowhere and every dispatch reads 0.

**Root cause 4 is the most likely.** The standalone host's `ExtensionContext` mock may not persist `globalState` across requests, which would make the round-robin permanently stuck on terminal index 0.

### Root Cause

The planner rotation cursor is stored in VS Code's `globalState` (`context.globalState.get/update`). The standalone host must provide a persistent equivalent. If the standalone context's `globalState` is an in-memory map that resets between requests (or doesn't persist writes), every dispatch reads cursor = 0 and picks `terminals[0]` = `planner-1`.

## Metadata

**Complexity:** 3
**Tags:** cli, bugfix, standalone-parity
**Project:** Browser Switchboard

## Proposed Changes

1. **Investigate** whether the standalone host's `globalState` persists across HTTP requests. Check `bootstrap.ts`'s context mock.
2. **If not persistent:** wire `globalState.update` to the same JSON state file the standalone host already uses for other persistent state, or to the kanban DB's `settings` table.
3. **Add `--seat <name>` to `cmdDispatch`** as an escape hatch — pass through to `dispatchOptions.targetTerminalOverride`. The round-robin should work, but explicit targeting is useful regardless.
4. **Verify** by dispatching 4 cards sequentially and confirming each lands on a different planner.

## Verification Plan

1. `switchboard dispatch <id1> "PLAN REVIEWED"` → lands on `planner-1`.
2. `switchboard dispatch <id2> "PLAN REVIEWED"` → lands on `planner-2` (not `planner-1`).
3. `switchboard dispatch <id3> "PLAN REVIEWED"` → lands on `planner-3`.
4. `switchboard dispatch <id4> "PLAN REVIEWED"` → lands on `planner-4`.
5. `switchboard dispatch <id5> --seat planner-3` → lands on `planner-3` regardless of cursor.
6. Rotation cursor persists across server restarts.
