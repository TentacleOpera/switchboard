# Grumpy Critique — Runsheet Race Condition Fix

**Target**: `implementation_plan.md` (Promise-chain mutex for `SessionActionLog.updateRunSheet` + `_handlePlanTitleSync` inline write fix)

---

## CRITICAL

### C1 — The Lock Doesn't Protect `_handlePlanTitleSync` (The Fix Is Incomplete)

The plan claims to fix `_handlePlanTitleSync` by routing it through `log.updateRunSheet`. But look at the actual code (TVP line 3376–3378):

```typescript
const sheetContent = await fs.promises.readFile(sheetPath, 'utf8');
const sheet = JSON.parse(sheetContent);
```

`_handlePlanTitleSync` doesn't even have a reference to the `SessionActionLog` instance at that point in the code — it constructs the path itself (`sheetPath = path.join(sessionsDir, file)`) and works directly off the filesystem. The plan's diff sketch says to call `log.updateRunSheet(sessionIdForSheet, ...)`, which requires (a) knowing the `sessionIdForSheet` and (b) having a `log` reference. The function currently doesn't call `_getSessionLog`. If the refactor is done naively, it will work if and only if `sessionIdForSheet === path.basename(file, '.json')` — which is true for `antigravity_` sessions but not guaranteed. If JSON has a mismatched `sessionId` field (e.g., due to a prior corruption), the mutex keyed on the wrong ID gives **zero protection** against the concurrent write against `_doUpdateRunSheet` keyed on the correct ID. The plan doesn't acknowledge this.

**Receipt**: `TaskViewerProvider.ts:3373` uses `file` from `fs.readdirSync(sessionsDir)` — the filename stem is the key, not `sheet.sessionId`.

---

### C2 — `_writeLocks` Memory Leak Is Acknowledged But the Cleanup Code Is Wrong

The plan's own cleanup snippet is internally inconsistent:

```typescript
const next = tail.then(() => this._doUpdateRunSheet(...)).finally(() => {
    if (this._writeLocks.get(sessionId) === chainedNext) {
        this._writeLocks.delete(sessionId);
    }
});
const chainedNext = next.catch(() => {});
this._writeLocks.set(sessionId, chainedNext);
```

`chainedNext` is defined AFTER `next`, but `next` references `chainedNext` in its `.finally()`. In JavaScript, `chainedNext` is `undefined` at the time `.finally(() => { ... === chainedNext })` is registered. The comparison always evaluates against the value of `chainedNext` **at the time `.finally()` callback fires** (i.e., after `const chainedNext = ...` is assigned), so it actually works by accident — but this is a textbook closure-over-mutable-variable footgun. Any reviewer will flag this as a bug on sight. The plan's own code is the kind that fails code review, gets reverted, and reintroduces the original bug.

**Receipt**: JavaScript closures capture the binding, not the value — the snippet only "works" because `finally` fires asynchronously after synchronous assignment.

---

### C3 — `_handleCompletePlan` Does a Stale-Cache Double-Update That the Mutex Doesn't Protect

Look at `_handleCompletePlan` (TVP:2764–2781):

```typescript
const sheet = await log.getRunSheet(sessionId);   // read outside mutex
...
sheet.completed = true;
sheet.completedAt = new Date().toISOString();
await log.updateRunSheet(sessionId, () => sheet);  // write ignores current
```

The `updater` passed to `updateRunSheet` is `() => sheet` — it **completely ignores the `current` argument**. Even with the mutex in place, a sequence like:

1. `_handleCompletePlan` reads `sheet` (old state)
2. File watcher calls `_updateSessionRunSheet` → gets queued, runs, writes new `events[]`
3. `_handleCompletePlan`'s `updateRunSheet(() => sheet)` fires — OVERWRITES the new events with the stale snapshot

The mutex serializes the writes but doesn't prevent stale reads from outside the critical section. The plan doesn't address this at all.

---

## MAJOR

### M1 — `createRunSheet` Is Not in a Concurrent-With-Update Race Path — The Mutex Wrapping Is Scope Creep

The plan says "Also wrap `createRunSheet` in the same lock". Show the race: who calls `createRunSheet` concurrently with `updateRunSheet` on the **same** `sessionId`? Looking at the code:
- `createRunSheet` is called at session **creation** (TVP:2653, TVP:2969)
- `updateRunSheet` is called only on **existing** sessions

The only realistic window is `_handleMirrorPlanWriteback` / brain-merge flow (TVP:2969 calls `createRunSheet` on `mergedSessionId`). But that's a *new* ID being created for the first time. If there's already a `updateRunSheet` in-flight on the same `mergedSessionId` before `createRunSheet` completes, that implies two concurrent flows are both creating the same session — that's a deeper design bug outside the scope of this fix and the mutex doesn't help (because `if (!fs.existsSync(filePath)) return;` inside `updateRunSheet` would just bail). Wrapping `createRunSheet` adds complexity without a proven concurrent path.

### M2 — No Debounce or Coalescing on the File Watcher — We're Serializing Noise, Not Eliminating It

The root trigger is: file watcher fires N times in milliseconds → N `updateRunSheet` calls. The plan serializes those N calls. But N sequential disk reads + writes is ** objectively worse performance** than just debouncing the watcher and doing 1 write. The mutex is solving the race but not the cause. For a plan that already requires O(N) sequential awaits on disk I/O, under rapid editing this will queue up 10–20 writes where 1 would suffice. The plan should at minimum acknowledge debouncing as an alternative (even if deferred) instead of treating serialization as the complete answer.

**Receipt**: `_updateSessionRunSheet` is called from the watcher handler. Each call queues a `readFile → JSON.parse → writeFile` cycle. With 10 rapid saves and no debounce, you get 10 sequential disk round-trips.

### M3 — The Test Is Too Weak to Catch the Real Failure Mode

The proposed Test 9 fires 20 concurrent `updateRunSheet` calls and checks `events.length === 20`. That proves serialization is working against an in-memory mutex. It does NOT prove:
- The file isn't momentarily corrupt mid-write (only valid if Node's `fs.writeFile` is atomic, which it is on most POSIX but NOT on Windows with antivirus interference — relevant given this is a Windows-primary codebase)
- The stale-snapshot problem from C3 (because the test uses `() => s.events.push(...); return s` — a read-modify-return of the `current` arg, which is fine — but the real world caller in `_handleCompletePlan` ignores `current`)
- Recovery behavior if the write partially fails mid-queue

### M4 — `_handlePlanTitleSync` Runs as a File-Watcher Handler That Can Re-Enter Itself

`_handlePlanTitleSync` reads the plan file, updates `sheet.topic`, and then calls `_refreshRunSheets()`. If `_refreshRunSheets` triggers any UI update that causes another file-system event (possible given VS Code extension model), this could loop. The plan does nothing to make this handler idempotent or guarded by a `_isHandlingTitleSync` flag. After the refactor, if `log.updateRunSheet` triggers the watcher (because it writes to the sessions directory, not the plan directory) this is unlikely — but needs to be verified, not assumed.

---

## NIT

### N1 — The Plan's Diff Sketches Are Incomplete and Inconsistent

The plan shows three different, partially overlapping snippets for the `updateRunSheet` replacement. In the first snippet it uses `.catch(() => {})`, in the third it introduces `chainedNext` and `.finally()`. These contradictory sketches will confuse the implementer. A single, authoritative final implementation should be given, not three evolutionary attempts.

### N2 — Test 9 Uses `Array.from({length: 20})` — No Actual Concurrency Guarantee

`Promise.all` in Node.js is concurrent from the event-loop's perspective, but the actual execution of `async function` bodies up to the first `await` is **synchronous**. The test relies on `_writeLocks` being set asynchronously, but the first iteration of the loop will register its lock and begin the `readFile` before the others fire. This is fine for testing the mutex, but the test comment should say "20 back-to-back queued" not imply true parallel I/O.

### N3 — "proper-lockfile is already a dependency" Is Misleading Context

The plan notes `proper-lockfile` is in `package.json` as justification for not using it. The reason to not use it is that a per-process promise-chain mutex is sufficient and simpler — not that file locking exists. The note inverts the logic and could mislead future readers into thinking file locking was considered and rejected for dependency reasons.
