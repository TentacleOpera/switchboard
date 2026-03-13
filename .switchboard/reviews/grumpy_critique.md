# Grumpy Critique — Restore Dynamic Complexity Routing in Autoban Engine

**Reviewer**: Principal Engineer (Adversarial)
**Target**: `feature_plan_20260314_092147_restore_autoban_complexity_routing.md`
**Date**: 2026-03-14

---

## CRITICAL

### CRIT-1: Double Session-File Read — You're Reading Every Session JSON Twice

The proposed patch splits cards in `_autobanTickColumn` by reading session JSON + plan file for each card. Then `_autobanTickColumn` calls `handleKanbanBatchTrigger(role, sessionIds, instruction)`. Look at what `handleKanbanBatchTrigger` does at line 575–592: **it reads every session JSON again** to resolve `planFile`. For a batch of 5, that's 10 JSON reads + 10 plan file reads in a single tick. The plan says "bounded by batchSize which maxes at 5" as if that makes it safe. Five session reads + five plan reads for complexity detection, then five more session reads inside `handleKanbanBatchTrigger` = 15 file system operations every tick per active column. This is not "negligible." It's unjustified duplication that should be eliminated by passing the already-resolved plan paths forward, not recalculating them.

**Receipt**: `TaskViewerProvider.ts:575–592` reads `${sid}.json` for every ID. The patch at plan lines 79–96 does the same for every card in the batch before calling `handleKanbanBatchTrigger`.

---

### CRIT-2: `_activeDispatchSessions.add()` Called AFTER the Existing Guard Already Ran (Or Was Bypassed)

The existing `_autobanTickColumn` at line 860 does:
```
batch.forEach(c => this._activeDispatchSessions.add(c.sessionId));
```
The proposed patch replaces the final dispatch block but **never removes this line**. In the new routing code path, the new `lowSessions.forEach(id => this._activeDispatchSessions.add(id))` and `highSessions.forEach(...)` calls run, but so does the original `batch.forEach(c => this._activeDispatchSessions.add(c.sessionId))` on line 860 of the current code. The patch shows inserting before line 111 (the existing guard). This means if the patch replaces `batch.forEach` at line 860 with the new routing block, the `return` at the end prevents the original `handleKanbanBatchTrigger` call — but the plan's diff does **not** show removal of the old `batch.forEach` line. The patch at plan line 111 shows the existing guard line as the tail end of the diff, suggesting it stays. If the new code path returns early, no problem. If it falls through? Double add + double dispatch.

**Receipt**: Plan diff lines 100–113 — the `return;` exits the new block, but lines 111–113 show the original `batch.forEach` / `const sessionIds` / (implied call) still exist below. If `this._kanbanProvider` is null, you fall through to the static block, which is correct — but the `lowSessions`/`highSessions` registration won't have run yet, leaving the `_activeDispatchSessions` guard in a split state.

---

### CRIT-3: `workspaceRoot` Is Not Available in the Proposed Tick Patch

The proposed code calls `path.join(workspaceRoot, '.switchboard', 'sessions', ...)` inside `_autobanTickColumn`. The real `_autobanTickColumn` at line 822 does:
```ts
const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
if (!workspaceRoot) { return; }
```
So `workspaceRoot` **is** defined locally inside `_autobanTickColumn`. However, the plan then calls `this._kanbanProvider.getComplexityFromPlan(workspaceRoot, session.planFile)`. The `getComplexityFromPlan` implementation in `KanbanProvider._getComplexityFromPlan` at line 384 does:
```ts
const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.join(workspaceRoot, planPath);
```
The `planFile` stored in session JSON may be an absolute path (from `path.resolve(workspaceRoot, session.planFile)` in `handleKanbanBatchTrigger:582`), **or** it may be relative (it depends on how the session was originally created). If it's absolute, the `workspaceRoot` passed to `getComplexityFromPlan` is harmless. If it's relative and the two workspaceRoot derivations ever differ (multi-root workspace, symlinks), you silently resolve to a wrong path and return `'Unknown'`, routing to `lead` — which is the safe fallback, but the silent failure is a bug.

---

## MAJOR

### MAJOR-1: Name Mismatch — Plan Says `_autobanColumnToInstruction`, Code Has Different Behavior

The plan at line 42 says: "Check if `sourceColumn === 'PLAN REVIEWED'`. If so, override." But the plan's patch starts with:
```
const instruction = this._autobanColumnToInstruction(sourceColumn);
```
then immediately gates on `sourceColumn === 'PLAN REVIEWED'`. The `instruction` for `'PLAN REVIEWED'` is `undefined` (see `_autobanColumnToInstruction` at line 783–786 — only `'CREATED'` returns `'enhance'`). This means `instruction` will be `undefined` when dispatching low or high sessions. For `lead`, `undefined` instruction is fine. For `coder`, `undefined` instruction causes it to use the default `_withCoderAccuracyInstruction` wrapper — which is also fine. But the log message and future readers will assume `instruction` is meaningful for this branch. It isn't. No explicit plan comment explains this. Confusion debt.

---

### MAJOR-2: Race Between Complexity Classification and setInterval Re-fire

If the batch tick fires at minute 0 and complexity reads take >1 second (large plan files, slow disk), and the interval is set to 1 minute minimum, the next tick fires at minute 1 while the `await`s are still resolving. The `_activeDispatchSessions` guard is the protection, but the **plan says** "eagerly add IDs to the set before the async dispatch" — which is correct. Verify the patch does this: yes, it does add to `_activeDispatchSessions` before `await this.handleKanbanBatchTrigger(...)`. But `_activeDispatchSessions` is cleared by `_stopAutobanEngine()`. If a user toggles Autoban off and back on while the async block is awaiting, `_stopAutobanEngine()` clears the set, re-fires setInterval, and a second dispatch can fire before the first completes. This is **not** solved by the plan.

---

### MAJOR-3: `handleKanbanBatchTrigger` with 1-session List Falls Through to Single Dispatch — Inconsistent Workflow Name

If `lowSessions` contains exactly 1 session (common case), `handleKanbanBatchTrigger` hits the early-exit path at line 558:
```ts
if (sessionIds.length === 1) {
    await this._handleTriggerAgentAction(role, sessionIds[0], instruction);
    return true;
}
```
`_handleTriggerAgentAction` produces a *single-plan prompt* instead of the *batch prompt*. This is intentional for efficiency. But the runsheet `.events` won't have a `start` event written by the batch path (which calls `_updateSessionRunSheet`). The single-dispatch path calls its own flow which should handle it. **But** the `_activeDispatchSessions` entry was added by the new routing code before `handleKanbanBatchTrigger` was called. After `_handleTriggerAgentAction` completes, the session ID stays in `_activeDispatchSessions` until the engine is restarted. If the single dispatch fails mid-way, the card is permanently stuck in-flight for this engine session. This is the same behavior as the existing code — but new complexity routing increases the frequency of 1-element batches.

---

### MAJOR-4: No Plan for Removing Sessions From `_activeDispatchSessions` on Dispatch Failure

If `handleKanbanBatchTrigger` returns `false` (no agent assigned, invalid name, etc.), the sessions were already added to `_activeDispatchSessions`. They will never be dispatched until the engine restarts. The plan's `try/catch` only handles file read failures — not dispatch failures. The fix is to remove session IDs from `_activeDispatchSessions` on dispatch failure. This is a pre-existing issue but the proposed complexity routing **splits** one dispatch into potentially two, doubling the failure surface — and if the second dispatch (`highSessions`) fails, those sessions are already locked out.

---

## NIT

### NIT-1: Proposed Public Rename is `getComplexityFromPlan` but Called as `this._kanbanProvider.getComplexityFromPlan`

The property is `_kanbanProvider?: KanbanProvider`. The optional chaining `?.` should be used: `this._kanbanProvider?.getComplexityFromPlan(...)`. The plan uses `this._kanbanProvider.getComplexityFromPlan(...)` without optional chaining inside the `if (this._kanbanProvider)` guard — which is actually valid and safe since null-check was done. However the `try/catch` means a null-deref here would be silently swallowed. TypeScript will compile it fine. Minor.

### NIT-2: Plan Comments Mismatch Reality

The plan explains `handleKanbanBatchTrigger` as "assumes all session IDs go to ONE role" in the Grumpy section. The current implementation literally dispatches a single batched prompt to one role per call. Splitting into two calls is architecturally sound — but the Balanced Response never clarifies that this is two full HTTP/terminal write operations, not just two array partitions. A future reader parsing the plan won't understand the operational weight.

### NIT-3: No Logging for Complexity Routing Decision

Neither the plan nor patch includes a `console.log` for which cards went to `coder` vs `lead`. This makes debugging Autoban routing decisions silent and requires reading raw terminal output. Add a log line.
