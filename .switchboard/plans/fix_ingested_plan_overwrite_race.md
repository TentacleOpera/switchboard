# Fix ingested plan overwrite race condition

## Goal

Prevent `ingested_*.md` mirror files from being overwritten with stale source content when a state.json change triggers an immediate, unguarded source→mirror sync while a mirror→source writeback is still in flight.

## Metadata

**Tags:** bugfix, reliability
**Complexity:** 4

## User Review Required

- Confirm that a 300ms debounce on initial sync after watcher refresh is acceptable (vs. the current immediate sync behavior). In practice this is imperceptible to users since state.json changes are background events.

## Root cause

A race condition between the staging watcher (mirror→source writeback) and the configured-plan-folder sync (source→mirror overwrite).

- `_setupStateWatcher` fires `_refreshConfiguredPlanWatcher` every time `.switchboard/state.json` changes (frequent in this extension).
- `_refreshConfiguredPlanWatcher` disposes old watchers, sets up new ones, then **immediately** calls `_syncConfiguredPlanFolder` with no debounce and no `_recentSourceWrites` guard.
- `_syncConfiguredPlanFolder` reads the source file and the mirror at different times. If the staging watcher is still processing a mirror→source writeback when state.json changes, the source still contains old content. The sync sees source ≠ mirror and overwrites the mirror with the old source content.

**Timeline of the race:**
```
T=0ms    User edits ingested_*.md mirror file
T=0ms    Staging watcher fires (500ms debounce)
T=200ms  state.json changes (unrelated)
T=200ms  _setupStateWatcher → _refreshConfiguredPlanWatcher()
T=200ms  _refreshConfiguredPlanWatcher calls _syncConfiguredPlanFolder() IMMEDIATELY
T=200ms  _syncConfiguredPlanFolder reads STALE source → overwrites mirror
T=500ms  Staging watcher callback finally fires → writes mirror content to source (too late)
```

## Complexity Audit

### Routine

- Replace direct `_syncConfiguredPlanFolder` call with existing `scheduleSync()` closure (1 line change)
- Add `_recentSourceWrites` echo guard inside `alreadyExists` block (4 lines)
- Add `console.log` on guard hit for observability (1 line)

### Complex / Risky

- **TTL-before-write ordering in staging watcher** — The `_recentSourceWrites` TTL is currently set *before* `writeFile` completes (lines 8086-8091). If the write is slow, the 2000ms TTL could start draining before the source file is actually updated, creating a window where the guard in `_syncConfiguredPlanFolder` sees the entry has expired while the staging watcher is still mid-write. Fix: move TTL registration after the `await writeFile`. Low probability for local markdown files, but the fix is trivial and eliminates the theoretical gap.

## Edge-Case & Dependency Audit

- **Race Conditions:** The primary race is documented above. A secondary concern: if `_refreshConfiguredPlanWatcher` is called while a previous `scheduleSync` timer is pending, `_disposeConfiguredPlanWatcher` clears the old timer and a new 300ms debounce starts. This loses coalescing but each rescan is idempotent — acceptable tradeoff.
- **Security:** No security implications. The guard only prevents overwriting mirror files with stale content from the same workspace.
- **Side Effects:** The 300ms debounce on initial sync means newly-appearing source files won't be mirrored until the timer fires. This is imperceptible since state.json changes are background events and the watcher-based `scheduleSync` already uses the same 300ms debounce for ongoing changes.
- **Dependencies & Conflicts:** The architectural refactor plans in CREATED column (`architectural_refactor_1_event_system.md`, `architectural_refactor_2_update_call_sites.md`) may restructure the watcher system. This fix should be applied **before** those refactors to establish the correct behavior first; the refactors can then preserve the guard pattern in the new architecture.

## Dependencies

- `sess_1777759330075 — Architectural Refactor 1/4: Event System Foundation` (potential conflict: may restructure watcher system; apply this fix first)
- `sess_1777759329250 — Architectural Refactor 2/4: Update All Call Sites` (same concern)

## Adversarial Synthesis

Key risks: (1) TTL-before-write ordering creates a theoretical window where the echo guard expires before the staging watcher write completes; (2) silent guard hits make production debugging impossible. Mitigations: move TTL registration after `writeFile`, add `console.log` on guard hit. The two-step fix is correct and uses existing patterns — no new architectural concepts introduced.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### Change 1: `_refreshConfiguredPlanWatcher` — replace immediate sync with debounced schedule

**Context:** At the end of `_refreshConfiguredPlanWatcher` (currently line ~8356), after setting up the VS Code watcher and fs.watch fallback, the method calls `_syncConfiguredPlanFolder` directly. This bypasses the 300ms debounce that `scheduleSync` provides.

**Logic:** Replace the direct `await this._syncConfiguredPlanFolder(...)` call with `scheduleSync()`, which uses the existing 300ms debounce timer (`_configuredPlanSyncTimer`). This gives any pending mirror→source writeback time to complete before the reverse sync runs.

**Implementation:**
```ts
// Before (line ~8356):
await this._syncConfiguredPlanFolder(configuredPlanFolder, resolvedWorkspaceRoot);

// After:
scheduleSync();
```

**Edge Cases:** If `_refreshConfiguredPlanWatcher` is called while a previous `scheduleSync` timer is pending, `_disposeConfiguredPlanWatcher` (called at the top of `_refreshConfiguredPlanWatcher`) clears the old timer. The new `scheduleSync()` call starts a fresh 300ms debounce. Each rescan is idempotent, so losing coalescing is acceptable.

#### Change 2: `_syncConfiguredPlanFolder` — add `_recentSourceWrites` echo guard

**Context:** Inside the `alreadyExists` block of `_syncConfiguredPlanFolder` (currently lines ~8243-8251), after the content-equality check, the method proceeds to overwrite the mirror with source content. It does not check whether the source was recently written by the staging watcher (mirror→source writeback), so it can overwrite fresh mirror edits with stale source content.

**Logic:** Before overwriting, check if the source file's stable path is in `_recentSourceWrites`. If so, skip the overwrite — the staging watcher recently wrote to the source from this mirror, so the source content is stale relative to the mirror.

**Implementation:**
```ts
if (alreadyExists) {
    const existingContent = await fs.promises.readFile(mirrorPath, 'utf8');
    if (existingContent === content) {
        continue;
    }

    // Skip if source was recently written from mirror (staging watcher echo).
    // This prevents overwriting fresh mirror edits with stale source content
    // when the staging watcher's mirror→source writeback is still in flight.
    const sourceStable = this._getStablePath(filePath);
    if (this._recentSourceWrites.has(sourceStable)) {
        console.log(`[TaskViewerProvider] Skipping source→mirror sync: source recently written from mirror (${path.basename(filePath)})`);
        continue;
    }

    // With bidirectional sync, source and mirror should stay in lockstep.
    // If they differ, the source was likely edited directly (legitimate update).
}
```

**Edge Cases:** The `_recentSourceWrites` TTL is 2000ms. If the staging watcher writes to the source and then more than 2 seconds pass before `_syncConfiguredPlanFolder` runs, the guard will have expired. However, with the 300ms `scheduleSync` debounce, the sync runs well within the 2s window. The guard is a safety net, not the primary defense — the debounce is the primary defense.

#### Change 3: Staging watcher — move TTL registration after write

**Context:** In the staging watcher's ingested branch (currently lines ~8084-8091), the `_recentSourceWrites` TTL is set *before* `writeFile` completes. If the write is slow, the 2000ms TTL starts draining before the source file is actually updated.

**Logic:** Move the TTL registration to after the `await writeFile` call, so the 2000ms window starts from when the write actually completes.

**Implementation:**
```ts
// Before (lines ~8084-8091):
const existingTimer = this._recentSourceWrites.get(sourceStable);
if (existingTimer) clearTimeout(existingTimer);
this._recentSourceWrites.set(
    sourceStable,
    setTimeout(() => this._recentSourceWrites.delete(sourceStable), 2000)
);

await fs.promises.writeFile(sourcePath, mirrorContent);

// After:
await fs.promises.writeFile(sourcePath, mirrorContent);

const existingTimer = this._recentSourceWrites.get(sourceStable);
if (existingTimer) clearTimeout(existingTimer);
this._recentSourceWrites.set(
    sourceStable,
    setTimeout(() => this._recentSourceWrites.delete(sourceStable), 2000)
);
```

**Edge Cases:** If `writeFile` throws (read-only source), the TTL is never set. This is correct — if the write failed, the source wasn't updated, so there's no echo to guard against. The existing catch block (lines 8093-8098) already handles this gracefully.

## Verification Plan

### Automated Tests

No automated regression test is feasible for this race condition (it requires precise timing of file watcher events). Manual verification steps:

1. **Reproduction (before fix):**
   - Configure a plan ingestion folder with at least one `.md` file
   - Open the ingested mirror in VS Code and make an edit
   - In a terminal, run `touch .switchboard/state.json` to trigger a state.json change
   - Observe the mirror file being overwritten with stale source content

2. **Verification (after fix):**
   - Repeat the reproduction steps
   - Verify the mirror is NOT overwritten (check file content and console for "Skipping source→mirror sync" log)
   - Edit the source file directly (outside VS Code) and verify it still syncs to the mirror normally
   - Create a new `.md` file in the ingestion folder and verify it appears as a mirror

3. **TTL ordering verification:**
   - Edit the mirror, wait >2 seconds, then trigger state.json change
   - Verify the sync proceeds normally (guard has expired, legitimate sync)

## Status

- [x] Coded
- [x] Reviewed
- [ ] Done

**Recommendation:** Send to Coder (complexity 4 ≤ 6)

---

## Execution Results

### UAT Failure (Round 1) — Root Cause Analysis

**Status:** FAILED — mirror content still overwritten immediately after user edits.

**Why the first fix failed:** The original plan's guard (`_recentSourceWrites` check in `_syncConfiguredPlanFolder`) only catches the case where the staging watcher has *already completed* the mirror→source writeback. But the actual race occurs when `_syncConfiguredPlanFolder` runs *before* the staging watcher's 500ms debounce fires:

```
T=0ms    User edits mirror → staging watcher starts 500ms debounce
T=100ms  state.json changes → _refreshConfiguredPlanWatcher → scheduleSync() (300ms)
T=400ms  _syncConfiguredPlanFolder runs
         - reads source (STALE, writeback hasn't happened)
         - reads mirror (FRESH, user's edit)
         - existingContent !== content
         - _recentSourceWrites.has(sourceStable)? NO — writeback hasn't started!
         - OVERWRITES mirror with stale source content
T=500ms  Staging watcher fires → writes fresh mirror content to source (too late)
```

The `_recentSourceWrites` TTL is set *after* the staging writeback completes. During the 500ms debounce window, the map is empty. The guard is useless against the primary race.

### Files Changed (Round 2 — Proper Fix)

- `src/services/TaskViewerProvider.ts` (4 changes applied)

### Changes Applied

**Change 1** (line ~8387): Replaced immediate `_syncConfiguredPlanFolder` call with debounced `scheduleSync()` in `_refreshConfiguredPlanWatcher`. Retained from first round.

**Change 2** (lines ~8271-8275): Added `_pendingMirrorToSourceWritebacks` guard in `_syncConfiguredPlanFolder`. This is the **primary defense**. Before overwriting an existing mirror, check if the staging watcher has a pending writeback for it (detected a mirror edit but hasn't completed the 500ms debounce/writeback yet). If so, skip the overwrite. The pending entry is set immediately when the staging watcher detects the mirror change, not after the writeback completes.

**Change 3** (lines ~8277-8284): Retained `_recentSourceWrites` echo guard from first round. This is a **secondary defense** for the case where the writeback has completed but a subsequent state.json change triggers another sync within the 2000ms TTL window.

**Change 4** (lines ~8028-8049): Added `_pendingMirrorToSourceWritebacks` tracking in the staging watcher:
- When an ingested mirror event is detected, immediately register the stable mirror path with a 2000ms TTL
- Reset the TTL if another event fires for the same mirror (handles rapid successive edits)
- Delete the entry when the debounce callback fires (whether it proceeds with the writeback or returns early)
- This makes the pending state visible to `_syncConfiguredPlanFolder` for the entire duration from detection through writeback completion

**Change 5** (lines ~8084-8091): Retained from first round — moved `_recentSourceWrites` TTL registration after `writeFile` in the staging watcher.

### Validation Results

**TypeScript Compilation:** 2 pre-existing errors in unrelated files — no regression.

**Manual Verification Required:**

1. Configure a plan ingestion folder with at least one `.md` file
2. Open the ingested mirror in VS Code and make an edit
3. Run `touch .switchboard/state.json` to trigger a state.json change
4. **Verify the mirror is NOT overwritten** (check file content and console for "mirror→source writeback pending" log)
5. Edit the source file directly and verify it still syncs to the mirror normally
6. Create a new `.md` file in the ingestion folder and verify it appears as a mirror
7. Edit the mirror, wait >2 seconds, then trigger state.json change to verify normal sync proceeds

### Remaining Risks

**Round 3 (UAT Failure — Delayed Overwrite):** The three-layer TTL-based defense (pending-writeback + recent-writeback + debounce) covers the immediate ~2-second window but fails when a delayed sync arrives after the TTLs expire. In practice, `_syncConfiguredPlanFolder` can be triggered by cascading watchers (e.g., state.json updates from `_refreshJulesStatus` or other background processes) 10–30 seconds after the mirror edit, by which time the 2000ms TTLs have long expired.

**Root Cause of Delayed Overwrite:**
TTL-based guards are inherently time-bound. Once the 2000ms window passes, `_syncConfiguredPlanFolder` sees no guard entries and proceeds to overwrite the mirror with whatever source content is on disk — even if that source content is stale relative to the user's mirror edit (e.g., the staging writeback hasn't completed yet, or a subsequent mirror edit is fresher).

**Round 3 Fix — Durable mtime Guard:**
Added a **file-modification-time guard** in `_syncConfiguredPlanFolder` (lines ~8286-8303) that compares `mirrorStat.mtimeMs` vs `sourceStat.mtimeMs`. If the mirror is newer than the source, the sync is skipped regardless of how much time has passed. This is a durable, TTL-independent check that protects against both immediate races and delayed overwrites.

Why mtime works:
- When user edits mirror → mirror mtime becomes newer → sync skipped.
- When staging watcher writes back to source → source mtime becomes newer (or equal) → sync proceeds, but content check (`existingContent === content`) catches identical content.
- When user edits source directly → source mtime becomes newer → sync proceeds (correct behavior).
- Works on all platforms and requires no in-memory state.

### Files Changed (Round 3 — mtime Guard)

- `src/services/TaskViewerProvider.ts` (1 change applied)

### Changes Applied

**Change 6** (lines ~8286-8303): Added `mirrorStat.mtimeMs > sourceStat.mtimeMs` guard in `_syncConfiguredPlanFolder`. Before overwriting an existing mirror, stat both the source and mirror. If the mirror was modified more recently than the source, skip the sync. This is the **durable defense** that remains effective indefinitely, unlike TTL-based guards.

### Validation Results

**TypeScript Compilation:** 2 pre-existing errors in unrelated files — no regression.

### Manual Verification Required

1. Configure a plan ingestion folder with at least one `.md` file
2. Open the ingested mirror in VS Code and make an edit
3. Run `touch .switchboard/state.json` to trigger a state.json change
4. **Verify the mirror is NOT overwritten** immediately (check console for "mirror→source writeback pending" log)
5. Wait ~15 seconds, then trigger another `touch .switchboard/state.json`
6. **Verify the mirror is STILL NOT overwritten** (check console for "mirror is newer than source" log)
7. Edit the source file directly and verify it still syncs to the mirror normally
8. Create a new `.md` file in the ingestion folder and verify it appears as a mirror
9. Edit the mirror, wait >2 seconds, then trigger state.json change to verify normal sync proceeds when writeback has completed

### Remaining Risks

**None material.** The four-layer defense (pending-writeback guard + recent-writeback guard + scheduleSync debounce + durable mtime guard) covers:
1. Immediate races (pending-writeback guard during 500ms debounce)
2. Short-delay echoes (recent-writeback guard during 2000ms TTL)
3. Long-delay overwrites (mtime guard — effective indefinitely)
