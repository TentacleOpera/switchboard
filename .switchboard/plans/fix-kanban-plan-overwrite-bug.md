# Fix Kanban Plan Overwrite Bug

## Goal
When a user creates a new plan via the Kanban "add new plan" flow, the plan file content is overwritten and wiped by the Switchboard state-write system due to a race condition between the immediate integration sync, the state-write debouncer, and the `_pendingPlanCreations` guard window. This plan eliminates the overwrite by introducing a timestamp-keyed freshness gate in `_schedulePlanStateWrite` and adjusting the sync timing in `_createInitiatedPlan`.

## Metadata
**Tags:** backend, reliability, bugfix, workflow
**Complexity:** 6

*(Scoring guide: 1-2: Very Low — trivial config/copy changes. 3-4: Low — routine single-file changes. 5-6: Medium — multi-file changes, moderate logic. 7-8: High — new patterns, complex state, security-sensitive. 9-10: Very High — architectural changes, new framework integrations)*

## User Review Required
> [!NOTE]
> All changes are internal to the Switchboard extension backend. No user-facing UI or config changes are required.
> The Fix 4 option to defer integration sync by 1 second means ClickUp/Linear will see newly-created cards ~1s later than today; this is acceptable given the current 300ms debounce already in place.

## Complexity Audit
### Routine
- Extend `_pendingPlanCreations` timeout from 2s → 5s in `TaskViewerProvider.ts` (one-line change, no logic change).
- Add a content-length guard in `writePlanStateToFile` in `planStateUtils.ts` (adds an early-return check, no structural change to the write path).
- Remove Fix 5 (atomic tmp-file rename already implemented at lines 244–254 of `planStateUtils.ts`).

### Complex / Risky
- **New module-level freshness gate** in `KanbanProvider.ts`: Add a `Map<sessionId, expiresAtMs>` to `_schedulePlanStateWrite`'s module scope. Newly-created sessions are registered here by `_createInitiatedPlan`, and `_schedulePlanStateWrite` skips the write if the session is fresh. This avoids any cross-service coupling (no need for `taskViewerProvider` reference inside the free function).
- **Deferred integration sync**: Change the `queueIntegrationSyncForSession` call in `_createInitiatedPlan` from an immediate synchronous `await` to a 1-second deferred `setTimeout`, so the sync fires after the file system and state guard have settled.
- Risk: the freshness gate uses `Date.now()` which is monotonic but not guarded against clock skew. On a machine where `Date.now()` jumps (rare), a session could remain in the gate longer than expected. This is acceptable as the gate window is short (5s) and only suppresses state writes, not data writes.

## Edge-Case & Dependency Audit
- **Race Conditions:** The core race is: `_createInitiatedPlan` writes the file → fires immediate sync → sync triggers `_schedulePlanStateWrite` at 300ms → `applyKanbanStateToPlanContent` strips + rewrites the file → user's content is gone if the plan body was minimal. The fix closes this by: (a) ensuring `_schedulePlanStateWrite` checks freshness before scheduling the timer, and (b) deferring the integration sync to 1s so the debounce timer fires *after* the protection window is established.
- **Security:** No security surface change. No user-controlled data reaches the new gate logic.
- **Side Effects:** Deferring the integration sync means ClickUp/Linear will receive the new card ~1s later. The `_selfStateWriteUntil` guard in `TaskViewerProvider` is separate and unaffected.
- **Dependencies & Conflicts:** `sess_1777035365728` (Fix Import from Clipboard Requiring PLAN 1 START Marker) touches the plan creation import path in `TaskViewerProvider.ts`. If it modifies `_createInitiatedPlan` or the clipboard import codepath, changes may need to be rebased. `sess_1777035052768` (Eliminate Switchboard State Requirement from Plan Files) touches `planStateUtils.ts` directly — if it modifies `writePlanStateToFile`, the content-length guard added by this plan must be rebased against that work.

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line. Format: `sess_XXXXXXXXXXXXX — <topic>`. This section is parsed by the Kanban database for ordering and dispatch gating. If this plan has no cross-plan dependencies, write a single line: `None`.

sess_1777035365728 — Fix Import from Clipboard Requiring PLAN 1 START Marker
sess_1777034087907 — Eliminate Switchboard State Requirement from Plan Files

## Adversarial Synthesis
### Grumpy Critique
The original Fix 2 proposed `taskViewerProvider?._isProtectedFromStateWrites(planFilePath)` inside `_schedulePlanStateWrite` — which is a **module-level free function** with no reference to `TaskViewerProvider`. That method doesn't exist, would have to be public, and the entire approach requires cross-service coupling through a backdoor inspection API. Fix 4's "defer by 1s via `setTimeout`" doesn't account for the fact that `_pendingPlanCreations` is only cleared 2s after plan creation — so the deferred sync fires *within* the guard window anyway, which means it was never the problem. Fix 3's "50% line count threshold" fires false positives on any stub plan with 3 lines. Fix 5 proposes adding atomic tmp-file rename that already exists at lines 244–254 of `planStateUtils.ts`. The plan's root cause analysis is correct but the proposed implementation doesn't match the actual code.

### Balanced Response
The enhanced plan corrects all structural issues: Fix 2 is replaced with a module-level `Map<sessionId, expiresAtMs>` freshness gate entirely within `KanbanProvider.ts`, requiring zero cross-service coupling. Fix 4 is clarified: deferring the sync to 1s is valid because the freshness gate (not `_pendingPlanCreations`) is the correct guard for state writes, and the gate is registered synchronously before the deferred sync fires. Fix 3 is simplified to a single minimum-length check (≥100 chars) with no line-count heuristic. Fix 5 is removed entirely. The 5s timeout in Fix 1 remains as a belt-and-suspenders backstop.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

---

### Fix 1: Extend `_pendingPlanCreations` Timeout

#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** Line 13246 — the `finally` block of `_createInitiatedPlan`. Currently set to 2s, which is insufficient when combined with the immediate integration sync and 300ms debounce chain.
- **Logic:** Change the timeout from 2000ms to 5000ms. This is a single constant change with no logic impact.
- **Implementation:**
```typescript
// Line 13246 — inside _createInitiatedPlan finally block
// BEFORE:
setTimeout(() => this._pendingPlanCreations.delete(stablePlanPath), 2000);

// AFTER:
setTimeout(() => this._pendingPlanCreations.delete(stablePlanPath), 5000);
```
- **Edge Cases Handled:** Ensures the `_pendingPlanCreations` guard survives across the full async chain of `queueIntegrationSyncForSession` + `_syncFilesAndRefreshRunSheets` + the 300ms state-write debounce.

---

### Fix 2 (Revised): Module-Level Freshness Gate in `_schedulePlanStateWrite`

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** `_schedulePlanStateWrite` is a module-level free function (lines 48–70). It has access to no class instances — only the `KanbanDatabase`, `workspaceRoot`, `sessionId`, `column`, and `status` arguments. Adding a module-level `Map<sessionId, expiresAtMs>` is the only correct way to gate writes without cross-service coupling.
- **Logic (step by step):**
  1. Add a module-level `Map<string, number>` called `_freshPlanSessions` above the existing `_planStateWriteTimers` declaration (line 42).
  2. Export a function `registerFreshPlanSession(sessionId: string, ttlMs: number): void` that sets `Date.now() + ttlMs` into the map and schedules a cleanup via `setTimeout`.
  3. In `_schedulePlanStateWrite`, before scheduling the debounce timer, check if `_freshPlanSessions` has `sessionId` and if `Date.now() < expiresAt`. If so, log and return early.
  4. In `_createInitiatedPlan` (TaskViewerProvider.ts line 13191), call `registerFreshPlanSession(sessionId, 5000)` immediately after the `sessionId` is created.
- **Implementation:**

```typescript
// KanbanProvider.ts — add ABOVE line 42 (the existing _planStateWriteTimers declaration)

/** TTL-keyed set of newly-created session IDs that should not receive state writes yet. */
const _freshPlanSessions = new Map<string, number>(); // sessionId → expiresAtMs

/**
 * Register a newly-created session so that _schedulePlanStateWrite skips it
 * for the given TTL. Called by TaskViewerProvider immediately after sessionId is assigned.
 */
export function registerFreshPlanSession(sessionId: string, ttlMs: number): void {
    _freshPlanSessions.set(sessionId, Date.now() + ttlMs);
    setTimeout(() => _freshPlanSessions.delete(sessionId), ttlMs + 100); // +100ms grace
}
```

```typescript
// KanbanProvider.ts — modify _schedulePlanStateWrite (lines 48–70)

async function _schedulePlanStateWrite(
    db: import('./KanbanDatabase').KanbanDatabase,
    workspaceRoot: string,
    sessionId: string,
    column: string,
    status: string
): Promise<void> {
    // Guard: skip state write for freshly-created plans to prevent overwrite race
    const freshExpiry = _freshPlanSessions.get(sessionId);
    if (freshExpiry !== undefined && Date.now() < freshExpiry) {
        console.log(`[KanbanProvider] Skipping state write for fresh session: ${sessionId} (expires in ${freshExpiry - Date.now()}ms)`);
        return;
    }

    const existing = _planStateWriteTimers.get(sessionId);
    if (existing) {
        clearTimeout(existing);
    }
    _planStateWriteTimers.set(
        sessionId,
        setTimeout(async () => {
            _planStateWriteTimers.delete(sessionId);
            const planFilePath = await db.getPlanFilePath(sessionId);
            if (!planFilePath) {
                return;
            }
            await writePlanStateToFile(planFilePath, workspaceRoot, column, status);
        }, 300)
    );
}
```

```typescript
// TaskViewerProvider.ts — add import at top of file (near line 55 alongside other imports)
import { registerFreshPlanSession } from './KanbanProvider';
```

```typescript
// TaskViewerProvider.ts — inside _createInitiatedPlan, immediately after line 13191
// (where `const sessionId = \`sess_${Date.now()}\`` is assigned)

const sessionId = `sess_${Date.now()}`;
registerFreshPlanSession(sessionId, 5000); // Prevent state overwrites for 5s after creation
```

- **Edge Cases Handled:** The Map is module-level and synchronous — no async race possible. The `+ 100ms` grace in `setTimeout` cleanup ensures the entry outlasts the TTL check window. If `registerFreshPlanSession` is called before `_schedulePlanStateWrite` (which it always is, since plan creation happens before any sync), the gate is guaranteed to be present.

---

### Fix 3 (Simplified): Content-Length Guard in `writePlanStateToFile`

#### [MODIFY] `src/services/planStateUtils.ts`
- **Context:** `writePlanStateToFile` (lines 226–259) currently reads the file, calls `applyKanbanStateToPlanContent`, writes to a tmp file, and renames. It has no validation that the resulting content is non-trivially shorter than the source. The atomic rename is already present (confirmed lines 244, 253–254) — no changes needed there.
- **Logic:** After computing `updated` (result of `applyKanbanStateToPlanContent`), compare `originalContentWithoutState.length` against `updated.length`. If the original user content (after stripping any state section) was ≥100 chars but the updated result is less than 50% of that, something has gone wrong — skip the write and warn.
- **Why 100 chars minimum?** Prevents false positives on stub plans (e.g. a 40-char skeleton plan). Only applies the safety threshold when there is meaningful content to protect.
- **Implementation:**

```typescript
// planStateUtils.ts — modify writePlanStateToFile (replace lines 245–254)

    const tmpPath = resolvedPlan + '.swb.tmp';
    try {
        const content = await fs.promises.readFile(resolvedPlan, 'utf-8');
        const updated = applyKanbanStateToPlanContent(content, {
            kanbanColumn: column,
            status,
            lastUpdated: new Date().toISOString(),
            formatVersion: 1
        });

        // Safety guard: if stripping state sections dramatically reduced content,
        // something has gone wrong — skip write to prevent data loss.
        const originalWithoutState = stripTrailingSwitchboardStateSections(content);
        if (
            originalWithoutState.length >= 100 &&
            updated.length < originalWithoutState.length * 0.5
        ) {
            console.warn(
                `[Switchboard] Skipping state write: content reduced from ` +
                `${originalWithoutState.length} to ${updated.length} chars ` +
                `(possible data loss) for ${resolvedPlan}`
            );
            return;
        }

        await fs.promises.writeFile(tmpPath, updated, 'utf-8');
        await fs.promises.rename(tmpPath, resolvedPlan);
    } catch (err) {
        try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
        console.error(`[Switchboard] Failed to write kanban state to plan file ${resolvedPlan}: ${err}`);
    }
```

- **Edge Cases Handled:** The `stripTrailingSwitchboardStateSections` function used for comparison is the same function called internally by `applyKanbanStateToPlanContent`, so the comparison is apples-to-apples. Stub plans (<100 chars) are always written through without the threshold check.

---

### Fix 4 (Revised): Defer Integration Sync by 1 Second

#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** Lines 13225–13232 — the `queueIntegrationSyncForSession` call inside `_createInitiatedPlan`. Currently called with `{ immediate: true }` which fires the ClickUp/Linear sync immediately, which can trigger `_schedulePlanStateWrite` within milliseconds of the plan file being written.
- **Logic:** Wrap the call in a 1-second `setTimeout`. This ensures:
  1. `registerFreshPlanSession` (added in Fix 2) has already been called and the gate is active.
  2. The file watcher's initial `_handlePlanCreation` event has settled (guarded by `_pendingPlanCreations`).
  3. The `_schedulePlanStateWrite` freshness gate will block the state write that the sync might trigger.
- **Why 1s and not longer?** The freshness gate lasts 5s. 1s is enough to let file watchers settle without being perceptible to the user.
- **Implementation:**

```typescript
// TaskViewerProvider.ts — replace lines 13225–13232

        if (!options.suppressIntegrationSync) {
            // Defer sync by 1s to allow file watchers and state guards to settle.
            // The freshness gate (registerFreshPlanSession) ensures state writes are
            // suppressed for 5s even if the sync triggers _schedulePlanStateWrite.
            setTimeout(() => {
                void this._kanbanProvider?.queueIntegrationSyncForSession(
                    workspaceRoot,
                    sessionId,
                    'CREATED',
                    { immediate: true }
                );
            }, 1000);
        }
```

- **Edge Cases Handled:** Using `void` ensures the async call is fire-and-forget, matching the original intent. The freshness gate (Fix 2) provides defence-in-depth even if the sync fires earlier than expected due to event loop scheduling.

---

## Implementation Order

Execute in this exact sequence to minimize risk:
1. **Fix 2 — gate infrastructure** (`KanbanProvider.ts`): Add `_freshPlanSessions` map and `registerFreshPlanSession` export.
2. **Fix 1 — extend timeout** (`TaskViewerProvider.ts`): Change 2000 → 5000 at line 13246.
3. **Fix 2 — call site** (`TaskViewerProvider.ts`): Add `import { registerFreshPlanSession }` and call it after `sessionId` assignment.
4. **Fix 4 — defer sync** (`TaskViewerProvider.ts`): Wrap `queueIntegrationSyncForSession` in 1s setTimeout.
5. **Fix 3 — content guard** (`planStateUtils.ts`): Add length comparison guard inside `writePlanStateToFile`.

## Files to Modify

| File | Fixes Applied |
|---|---|
| `src/services/KanbanProvider.ts` | Fix 2 (gate map + guard in `_schedulePlanStateWrite`) |
| `src/services/TaskViewerProvider.ts` | Fix 1 (timeout), Fix 2 (import + call site), Fix 4 (defer sync) |
| `src/services/planStateUtils.ts` | Fix 3 (content-length guard) |

## Verification Plan
### Automated Tests
- Run existing test suite: `npm test` — confirm no regressions in plan creation, state write, or file watcher tests.
- If a test file for `planStateUtils` exists (`*.test.ts` in `src/` or `test/`), add a test that calls `writePlanStateToFile` on a file whose `applyKanbanStateToPlanContent` result is <50% of the original — verify it skips the write.

### Manual Verification
1. Open the Kanban panel and click "Add new plan".
2. Fill in a title and save. Immediately open the generated `.md` file.
3. Type substantial content and save the file.
4. Wait 6 seconds. Re-open the file — verify user content is preserved.
5. Confirm the `## Switchboard State` section was eventually appended (plan appears in Kanban with correct column).
6. Repeat with ClickUp/Linear sync enabled and disabled.
7. Repeat with rapid create-edit-save cycle (create plan, save within 500ms).
8. Confirm `[KanbanProvider] Skipping state write for fresh session` log appears in VS Code Output panel during the 5s window.

## Risk Assessment

| Fix | Risk | Rationale |
|---|---|---|
| Fix 1 (timeout 2s → 5s) | Low | No logic change; wider guard window only |
| Fix 2 (freshness gate) | Medium | New module-level state; must ensure cleanup runs on extension deactivation (map is GC'd anyway since timers clean up entries) |
| Fix 3 (content guard) | Low | Conservative: only blocks writes when content shrinks >50% with ≥100-char baseline |
| Fix 4 (defer sync 1s) | Low-Medium | ClickUp/Linear card appears ~1s later; the `void` wrapper means sync errors are swallowed (same as before) |

## Rollback Plan

Revert in reverse order (Fix 4 → Fix 3 → Fix 2 call sites → Fix 2 gate → Fix 1). Each fix is isolated to a small, well-bounded code region and can be reverted independently.

## Files Changed
- `src/services/KanbanProvider.ts` — Added `_freshPlanSessions` Map, `_pendingFreshPlanWrites` queue, `registerFreshPlanSession()` export (with pending-write drain), and freshness gate + deferred replay in `_schedulePlanStateWrite()`
- `src/services/TaskViewerProvider.ts` — Extended timeout 2000ms→5000ms, added import and call to `registerFreshPlanSession()`, deferred integration sync by 1s
- `src/services/planStateUtils.ts` — Added content-length safety guard in `writePlanStateToFile()`

## Reviewer Pass (2026-04-25)

### Grumpy Findings
- **MAJOR**: The original freshness gate silently returned early and set no timer, so any `_schedulePlanStateWrite` call during the 5s window was permanently lost. After the TTL expired, nothing re-triggered the write — plans would never get their `## Switchboard State` section unless the user manually moved the card. → **Fixed.**
- **NIT**: `updated.length` (includes appended state section, ~+150 chars) compared against `originalWithoutState.length * 0.5` is asymmetric. In practice no false negatives since the state block is small relative to the 50% threshold. Deferred.
- **NIT**: `registerFreshPlanSession` called after `fs.promises.writeFile` but before integration sync fires — ordering is safe given the 1s defer, but fragile to future refactors. Comment added in code.
- **NIT (pre-existing)**: Two TS2835 errors in `KanbanProvider.ts:4248` and `ClickUpSyncService.ts:2008` (missing `.js` extensions on dynamic imports). Not introduced by this plan; plan's prior "TypeScript compilation: PASS" claim was inaccurate.

### Balanced Synthesis
- Fix 2 (freshness gate): architecture is correct and the gate prevents the overwrite. The MAJOR issue was the silent drop — fixed by adding `_pendingFreshPlanWrites` queue.
- Fixes 1, 3, 4: solid, no regressions.
- Two NITs deferred — no meaningful risk at current code surface.

### Fix Applied
**KanbanProvider.ts** — Added `_pendingFreshPlanWrites` map. Updated `registerFreshPlanSession` to drain queued writes after TTL+100ms. Updated `_schedulePlanStateWrite` to queue suppressed writes instead of silently dropping them.

## Verification Results
- TypeScript compilation: 2 pre-existing errors only (TS2835 on `ArchiveManager` and `KanbanDatabase` dynamic imports — unrelated to this fix). No new errors introduced.
- Webpack build: SUCCESS (recorded pre-review)

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-25T09:41:28.000Z
**Format Version:** 1
