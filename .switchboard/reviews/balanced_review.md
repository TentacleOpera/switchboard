# Balanced Review — Runsheet Race Condition Fix

**Reviewer**: Lead Developer
**Input**: Grumpy Critique + Implementation Plan

---

## Summary of Review

The plan correctly identifies the root cause (unguarded read-modify-write in `updateRunSheet`) and proposes the right class of solution (in-process promise-chain serialization). The mutex approach is sound. However, three significant defects in the plan will cause the fix to be incomplete or subtly wrong: one critical gap in the `_handlePlanTitleSync` fix, one closure bug in the cleanup code, and an unacknowledged stale-snapshot bypass in `_handleCompletePlan`. All three are fixable without changing the overall approach. The MAJORs are real but lower priority.

---

## Valid Concerns

**C1 — `_handlePlanTitleSync` fix is underspecified (CONFIRMED)**
The plan's diff for this function is correct in intent but its implementation sketch glosses over an important detail: `_handlePlanTitleSync` doesn't currently have a `log` reference, derives the session ID as `path.basename(file, '.json')`, not from `sheet.sessionId`. The implementer must:
1. Acquire `log = _getSessionLog(workspaceRoot)` at the top of the function (it's available via the `workspaceRoot` already derived there).
2. Key the mutex on `path.basename(file, '.json')` (i.e., the filename stem, which IS the sessionId for all runsheet files) — not on `sheet.sessionId`, which could be stale.

**C2 — Cleanup code closure footgun (CONFIRMED)**
The multi-step snippet in the plan with `chainedNext` referenced before assignment is unsafe to copy-paste literally. The correct pattern is:

```typescript
async updateRunSheet(sessionId: string, updater: (current: any) => any): Promise<void> {
    const tail = this._writeLocks.get(sessionId) ?? Promise.resolve();
    const self = this;
    const next: Promise<void> = tail.then(() => self._doUpdateRunSheet(sessionId, updater));
    this._writeLocks.set(sessionId, next.catch(() => {}).finally(() => {
        if ((this._writeLocks.get(sessionId) as unknown) === next) {
            this._writeLocks.delete(sessionId);
        }
    }));
    return next;
}
```
Store `next` first, then chain `.catch().finally()` as the map value. No forward-reference issue.

**C3 — `_handleCompletePlan` stale-snapshot (CONFIRMED)**
The `updater: () => sheet` pattern ignores `current`, so a write queued between the outer `getRunSheet` read and the `updateRunSheet` call will be silently discarded. The fix: change the updater to merge:

```typescript
await log.updateRunSheet(sessionId, (current: any) => ({
    ...current,
    completed: true,
    completedAt: new Date().toISOString(),
    brainSourcePath: sheet.brainSourcePath // already patched above
}));
```

This is a **separate bug** from the race condition and should be fixed in the same PR since the mutex makes the gap worse (it serializes but doesn't merge).

**M2 — Debounce is a valid alternative for consideration (ACKNOWLEDGED, DEFERRED)**
Serialization is correct but doesn't eliminate unnecessary writes from rapid file-system events. Debouncing the watcher trigger at 150ms would reduce N sequential disk writes to 1. This is a valid follow-up optimization but out of scope for this fix. Acknowledge it in a TODO comment.

**M3 — Test needs a stale-snapshot case (CONFIRMED)**
Add a second sub-test: concurrent calls where one updater ignores `current` (simulating the `_handleCompletePlan` pattern) — verify that after the fix (C3 resolution), the merge-updater version preserves all prior events.

---

## Action Plan

> These items are ordered by priority. Items 1–3 are required before merge.

1. **[Must] Fix `_handlePlanTitleSync` to acquire `log` reference and key mutex on filename stem**
   - Add `const log = this._getSessionLog(workspaceRoot);` near top of function
   - Replace raw `writeFile` with `await log.updateRunSheet(path.basename(file, '.json'), (s) => { s.topic = newTopic; return s; })`

2. **[Must] Fix `updateRunSheet` mutex cleanup — store `next` before chaining `.finally()`**
   - Use the corrected pattern from C2 above; do not literally copy the plan's inconsistent snippets

3. **[Must] Fix `_handleCompletePlan` stale-snapshot — change `() => sheet` to a merge updater**
   - Use spread-merge: `(current) => ({ ...current, completed: true, completedAt: ..., brainSourcePath: ... })`

4. **[Should] Add Test 9b — stale-snapshot regression test**
   - Fire a concurrent pair: one updater appends an event, one uses `() => snapshot` (the bad pattern) — verify the merge-updater variant doesn't lose the first event

5. **[Nice-to-have] Add a TODO comment in `_updateSessionRunSheet` for debounce exploration**
   - Do not implement now; mark it for a follow-up

---

## Dismissed Points

**M1 — createRunSheet mutex scope creep**: Grumpy is right that there's no proven race path for `createRunSheet`. However, wrapping it is still the correct defensive posture since it's nearly free (one extra `.then()`) and prevents a future caller from introducing the bug. Not dismissed — just accept it as defensive hygiene.

**M4 — `_handlePlanTitleSync` re-entrancy loop**: Grumpy's concern requires `_refreshRunSheets` to emit a file event on `.switchboard/sessions/*.json` that re-triggers `_handlePlanTitleSync`. The `_handlePlanTitleSync` watcher listens on plan files (`.md`), not session JSON. `_refreshRunSheets` only posts to the webview — no filesystem write. Re-entrancy loop dismissed as a theoretical concern that won't materialise with current code.

**N1 — Inconsistent plan snippets**: Valid NIT but editorial, not a defect. Dismissed from action plan; implementer should use the corrected C2 pattern and ignore the plan's draft snippets.

**N2, N3**: Purely documentation issues. Dismissed.
