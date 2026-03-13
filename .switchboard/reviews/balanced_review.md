# Balanced Review — Restore Dynamic Complexity Routing in Autoban Engine

**Reviewer**: Lead Developer (Mediator)
**Source**: Grumpy Critique `grumpy_critique.md`
**Date**: 2026-03-14

---

## Summary of Review

The plan is structurally sound and targets a real regression. The complexity classification logic in `KanbanProvider` is well-tested and the insertion point in `_autobanTickColumn` is correct. However, a real implementation defect was found: the proposed patch reads session JSON files twice per card — once in the new routing block and once inside `handleKanbanBatchTrigger`. This is correctable with a minor refactor. Two pre-existing risks (dispatch failure not removing from `_activeDispatchSessions`, toggle-race clearing the in-flight set) are elevated by this change, but neither is a hard blocker for this plan if their surface is acknowledged and bounded. The plan is **conditionally approvable**.

---

## Valid Concerns

### ✅ CRIT-1: Double Session-File Read

**Accepted.** The new routing block reads `${card.sessionId}.json` to get `session.planFile`, then resolves complexity. Then `handleKanbanBatchTrigger` reads the same `.json` again for every session ID. With batchSize=5, that's up to 10 JSON reads where 5 are sufficient.

**This is a legitimate defect and must be fixed before implementation.**

### ✅ CRIT-2: `_activeDispatchSessions.add()` Ambiguity

**Partly accepted.** The patch's `return` at the end of the `if (sourceColumn === 'PLAN REVIEWED' && this._kanbanProvider)` block ensures the static routing block below is skipped. The existing `batch.forEach(c => this._activeDispatchSessions.add(c.sessionId))` at line 860 falls in the static block and is bypassed. The plan diff shows the static block intact below the `return`, which is correct — no double-add occurs in the PLAN REVIEWED + kanbanProvider path. **However**, the patch should explicitly replace the original `batch.forEach` + `handleKanbanBatchTrigger` call with the new block, not insert before it. The current diff presentation is ambiguous. The final patch must be explicit that the original static dispatch lines are replaced, not appended.

### ✅ MAJOR-4: Sessions Locked In-Flight on Dispatch Failure

**Accepted as elevatable risk.** Splitting into two dispatches doubles the failure surface. We should remove session IDs from `_activeDispatchSessions` if the corresponding `handleKanbanBatchTrigger` call returns `false`.

### ✅ NIT-3: No Logging

**Accepted.** A single `console.log` for routing decisions costs nothing and saves hours of debugging.

---

## Action Plan

### Action 1 — Eliminate Double Session-File Read (CRIT-1) `[REQUIRED]`

Refactor `_autobanTickColumn` to pre-resolve `{ sessionId, lastActivity, planFile }` in the card collection loop. Pass `planFile` through to the complexity routing block so no second JSON read is needed. The batch object passed to `handleKanbanBatchTrigger` can remain as `sessionIds: string[]` only (plan path is already re-read inside that method anyway for the prompt builder).

**Concrete change**: In the card collection loop (lines 834–847), also read `sheet.planFile` and include it in `cardsInColumn`. The new routing block uses `card.planFile` directly instead of re-reading the session JSON.

### Action 2 — Clarify Patch Boundaries (CRIT-2) `[REQUIRED]`

Update the implementation patch in the plan's Appendix to explicitly show that the three lines comprising the old static dispatch (`batch.forEach`, `const sessionIds`, `await this.handleKanbanBatchTrigger(role, sessionIds, instruction)`) are **deleted** and replaced by the new routing block. The current diff is ambiguous.

### Action 3 — Remove From In-Flight Set on Dispatch Failure (MAJOR-4) `[RECOMMENDED]`

After each `await this.handleKanbanBatchTrigger(...)` call in the new routing block, check the return value. If `false`, call `lowSessions.forEach(id => this._activeDispatchSessions.delete(id))` (or `highSessions.forEach(...)`) so those sessions are eligible to retry on the next tick.

```ts
const lowDispatched = await this.handleKanbanBatchTrigger('coder', lowSessions, instruction);
if (!lowDispatched) {
    lowSessions.forEach(id => this._activeDispatchSessions.delete(id));
}
```

### Action 4 — Add Routing Decision Log (NIT-3) `[RECOMMENDED]`

Add before the dispatch calls:
```ts
console.log(`[Autoban] Complexity routing: ${lowSessions.length} → coder, ${highSessions.length} → lead`);
```

---

## Dismissed Points

| Finding | Reason |
|---|---|
| **CRIT-3** (workspaceRoot multi-root mismatch) | Session files store absolute `planFile` paths (created by `path.resolve` in `handleKanbanBatchTrigger:582`). The `getComplexityFromPlan` absolute-path guard at line 384 handles this correctly. Low real-world risk. Dismissed. |
| **MAJOR-1** (instruction is `undefined` for PLAN REVIEWED) | Correct behavior. `undefined` instruction is the right signal for `coder` (triggers `_withCoderAccuracyInstruction`) and `lead` (vanilla prompt). The confusion is a documentation gap, not a bug. Add a code comment instead of changing behavior. |
| **MAJOR-2** (toggle-race clearing `_activeDispatchSessions`) | Pre-existing condition, not introduced by this change. Toggling Autoban off mid-tick is an edge case already accepted by the architecture. Out of scope for this plan. |
| **MAJOR-3** (1-session list uses `_handleTriggerAgentAction`) | Also pre-existing behavior. The plan correctly inherits this shortcut. No in-flight lock issue beyond what already exists. |
| **NIT-1** (optional chaining) | Guarded by explicit `if (this._kanbanProvider)` check. TypeScript compiler enforces this correctly. Non-issue. |
| **NIT-2** (comment quality) | Documentation improvement. Can be addressed in the PR description, not in the plan. |
