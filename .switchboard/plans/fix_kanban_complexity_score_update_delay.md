# Fix Kanban Complexity Score Update Delay

## Goal
When a user manually edits a plan file to change complexity, tags, or dependencies, the kanban board must reflect the change within ~400ms without requiring an IDE restart or manual "Sync Board" click.

## Metadata
**Tags:** backend, bugfix, UI, workflow
**Complexity:** 5

## User Review Required
> [!NOTE]
> No user-facing breaking changes. The fix is purely additive — it wires the existing file watcher to also update the DB and refresh the board. Users who edit plans via the ReviewProvider dropdown already get DB+refresh via `updateReviewTicket`; this fix extends the same behavior to direct file edits.

## Complexity Audit
### Routine
- **R1:** Add `_metadataDebounceTimers` Map field to `KanbanProvider` class (one line, follows existing `_refreshDebounceTimer` pattern)
- **R2:** Add plan-lookup logic in `onDidChange` handler (absolute → relative fallback, already used in the ClickUp sync block at lines 569–573 — replicate the same pattern)
- **R3:** Call existing `db.updateComplexity`, `db.updateTags`, `db.updateDependencies` methods (3 one-liner calls, all methods already exist and are tested)
- **R4:** Call existing `_scheduleBoardRefresh(workspaceRoot)` after DB updates (one line, same pattern used by 10+ other call sites in KanbanProvider)
- **R5:** Dispose `_metadataDebounceTimers` entries in `dispose()` method (follows existing cleanup pattern for `_refreshDebounceTimer`)

### Complex / Risky
- **C1:** Plan lookup must happen OUTSIDE the `realTimeSyncEnabled` guard — the current ClickUp sync block (lines 562–591) does the lookup inside the guard, so the `plan` variable is scoped to that block. The metadata update path needs its own independent lookup, or the lookup must be hoisted above the guard. Hoisting avoids a duplicate DB round-trip but changes the control flow of the existing handler.
- **C2:** Debounce per file path — `_scheduleBoardRefresh` already debounces at 100ms globally, but the metadata extraction + DB update is more expensive than just a board refresh. A per-file 300ms debounce prevents redundant file reads and DB writes during rapid edits without blocking the board refresh path.

## Edge-Case & Dependency Audit
- **Race Conditions:** The `onDidChange` handler is async and may fire concurrently for different files. The per-file debounce timer prevents the same file from being processed twice in rapid succession. `_scheduleBoardRefresh` has its own 100ms global debounce that coalesces multiple refresh requests. The `db.updateComplexity`/`updateTags`/`updateDependencies` methods use `_persistedUpdate` which is a single SQL UPDATE — DuckDB serializes writes, so concurrent updates to different rows are safe.
- **Security:** No new file system access — the watcher already reads the file; `getComplexityFromPlan`/`getTagsFromPlan`/`getDependenciesFromPlan` use the same `fs.promises.readFile` path already used by ClickUp sync and ContinuousSyncService.
- **Side Effects:** The `_planFileChangeEmitter.fire(uri)` at line 595 will still fire, so ContinuousSyncService will also process the change. This is harmless — ContinuousSyncService does its own hash-based change detection and won't re-sync if the content hasn't actually changed. The DB update from this fix happens BEFORE ContinuousSyncService processes the event, so the board will already reflect the new metadata by the time ContinuousSyncService runs.
- **Dependencies & Conflicts:**
  - `sess_1777117955608` (Remove Complexity and Tag Self-Healing from Kanban Refresh) is in CODE REVIEWED — already implemented. This plan is complementary: the self-heal removal means the board NO LONGER re-parses files during refresh, so the file-watcher-driven DB update becomes the ONLY path for complexity to flow from file → DB → board. This makes the fix more critical, not less.
  - `sess_1777182388046` (Fix Plan Watcher: Orphan Registration Gap and Duplicate Row Creation) is in CODE REVIEWED — modifies `_handlePlanCreation` in TaskViewerProvider. No overlap with `_setupPlanContentWatcher`.
  - `sess_1777182256190` (Fix Slow Plan Registration in Kanban) is in CODE REVIEWED — modifies DB registration paths. No overlap.
  - `sess_1777206335666` (Replace MCP Operations with Direct DB Access Skill) is in CREATED — proposes DB access changes. No overlap with file watcher logic.

## Dependencies
> [!IMPORTANT]
> None

## Adversarial Synthesis

### Grumpy Critique

*Slams keyboard*

Oh, ANOTHER "just add a refresh call" plan. How ORIGINAL. Let me count the ways this will blow up:

1. **Double Read, Double Trouble**: Your "Step 1" says "use the existing `getComplexityFromPlan` method". That method READS THE FILE FROM DISK (line 2123: `fs.promises.readFile`). The file watcher ALREADY detected the change — you're going to read the same file AGAIN? And then `getTagsFromPlan` reads it AGAIN? And `getDependenciesFromPlan` reads it a THIRD time? That's THREE file reads per change event. For a file that was JUST modified. On a system where the file watcher might fire 5 times for a single save. Brilliant. Just brilliant.

2. **The ClickUp Scope Trap**: The current handler does plan lookup INSIDE the `realTimeSyncEnabled` guard (lines 562–591). Your new metadata update code needs the plan record too. If you naively add a second lookup OUTSIDE the guard, you've just doubled the DB queries for every file change. If you hoist the lookup ABOVE the guard, you change the control flow of the ClickUp sync path — a path that's been working fine. Pick your poison.

3. **Debounce Inception**: You want a 300ms per-file debounce for metadata extraction, PLUS the existing 100ms global debounce for `_scheduleBoardRefresh`. So the total delay from edit → board update is up to 400ms. But wait — the `_planFileChangeEmitter.fire(uri)` at line 595 fires IMMEDIATELY, so ContinuousSyncService will also process the change. Its quiet period is configurable (default 2s). So now you have TWO independent code paths both trying to update the same plan's metadata from the same file change, with different debounce windows. What could POSSIBLY go wrong?

4. **The ReviewProvider Double-Write**: When a user changes complexity via the ReviewProvider dropdown, `updateReviewTicket` (TaskViewerProvider.ts line 10787) writes the new complexity to the plan file AND updates the DB AND calls `refreshViews()`. Then the file watcher fires and YOUR new code reads the same file and updates the DB AGAIN. Same value, so it's "idempotent" — but you're doing a completely redundant file read + 3 DB writes for every ReviewProvider complexity change. That's not "idempotent", that's WASTEFUL.

5. **Missing Dispose**: Your "Step 4" says "add a debounce timer per file path" but you never mention cleaning up those timers in `dispose()`. Memory leak much?

6. **The `plan` Variable Scope Problem**: The current handler structure is:
   ```
   onDidChange(async (uri) => {
       try { /* ClickUp sync — plan lookup inside here */ } catch {}
       this._planFileChangeEmitter.fire(uri);
   });
   ```
   The `plan` variable from the ClickUp block is NOT accessible outside. You need to restructure this, but your plan doesn't show the actual code. "Add debouncing" is not an implementation spec — it's a wish.

### Balanced Response

Grumpy's points are valid but solvable. Here's how each is addressed:

**On Triple File Read (Point 1)**: Valid. The fix is to read the file ONCE and pass the content string to lightweight regex extractors instead of calling `getComplexityFromPlan` which reads the file again. We can extract complexity, tags, and dependencies from the already-read content using the same regex patterns those methods use internally. This eliminates 2 of the 3 redundant reads.

**On ClickUp Scope (Point 2)**: Hoist the plan lookup above the `realTimeSyncEnabled` guard. The lookup is a single DB query — cheap. The ClickUp sync block then reuses the `plan` variable instead of doing its own lookup. This is a net REDUCTION in DB queries when ClickUp sync IS enabled (was 1 lookup, still 1 lookup) and adds 1 lookup when it's not (was 0, now 1 — but we need it for the metadata update).

**On Debounce Inception (Point 3)**: The two paths serve different purposes. ContinuousSyncService syncs to external integrations (ClickUp/Linear/Notion). Our new path updates the local DB and refreshes the board. They write to different targets. The local DB update at 300ms will complete before ContinuousSyncService's 2s quiet period expires, so the board will show the change first. No conflict.

**On ReviewProvider Double-Write (Point 4)**: Valid concern but low impact. The redundant DB write is a single SQL UPDATE with the same value — DuckDB handles this in microseconds. The file read is the real cost, but the per-file debounce will collapse the ReviewProvider-triggered file watcher event with any other events within the 300ms window. In practice, the ReviewProvider writes the file → file watcher fires → debounce timer starts → 300ms later we read and update. By then, the DB already has the correct value from `updateReviewTicket`, so the SQL UPDATE is a no-op. We could add a short-circuit check (compare extracted value to DB value before writing), but the overhead of the comparison likely exceeds the cost of the no-op UPDATE.

**On Missing Dispose (Point 5)**: Valid. Added as R5 in the Complexity Audit. The `_metadataDebounceTimers` Map entries must be cleared in `dispose()`.

**On `plan` Variable Scope (Point 6)**: Valid — the implementation spec below shows the exact restructured code with the plan lookup hoisted above the ClickUp guard.

**Clarification**: The per-file debounce timer stores `NodeJS.Timeout` values keyed by the URI's `fsPath`. On each `onDidChange` event for the same file, the previous timer is cleared and a new 300ms timer is set. When the timer fires, it reads the file once, extracts all three metadata fields, updates the DB, and calls `_scheduleBoardRefresh`. The timer entry is deleted after firing.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### 1. Add per-file debounce timer storage

#### MODIFY `src/services/KanbanProvider.ts`

- **Context:** The class already has `_refreshDebounceTimer` (line 116) for global board refresh debouncing. We need a parallel Map for per-file metadata update debouncing.
- **Logic:** Add a `Map<string, NodeJS.Timeout>` field keyed by file path. This prevents redundant file reads + DB writes when the same file changes multiple times within 300ms (common during IDE saves which can trigger multiple watcher events).
- **Implementation:** Add after line 116 (`private _refreshDebounceTimer?: NodeJS.Timeout;`):

```typescript
    private _metadataDebounceTimers = new Map<string, NodeJS.Timeout>();
```

- **Edge Cases Handled:** The Map is bounded by the number of plan files being actively edited — typically 1–3. No risk of unbounded growth.

---

### 2. Restructure `_setupPlanContentWatcher` handler

#### MODIFY `src/services/KanbanProvider.ts`

- **Context:** The current `onDidChange` handler (lines 560–596) does plan lookup INSIDE the `realTimeSyncEnabled` guard, making the `plan` variable inaccessible to the new metadata update logic. The handler needs restructuring to: (a) hoist plan lookup above the ClickUp guard, (b) add metadata extraction + DB update + board refresh after the ClickUp block, (c) add per-file debouncing for the metadata path.
- **Logic:**
  1. The plan lookup (absolute path → relative fallback) is moved ABOVE the ClickUp guard so both paths can use it.
  2. The ClickUp sync block reuses the hoisted `plan` variable instead of doing its own lookup.
  3. After the ClickUp block (and its catch), a new block handles metadata extraction with per-file debouncing:
     - Clear any existing debounce timer for this file path
     - Set a 300ms timer that:
       - Reads the file once via `fs.promises.readFile`
       - Extracts complexity using the same regex as `getComplexityFromPlan` (but from the in-memory content, not re-reading the file)
       - Extracts tags using the same regex as `getTagsFromPlan` (from the same content)
       - Extracts dependencies using the same regex as `getDependenciesFromPlan` (from the same content)
       - Calls `db.updateComplexity`, `db.updateTags`, `db.updateDependencies` if the plan was found
       - Calls `_scheduleBoardRefresh(workspaceRoot)` to push updated DB state to the board
       - Deletes the timer entry from the Map
     - If no plan was found in DB, skip the metadata update (safe no-op)
  4. The `_planFileChangeEmitter.fire(uri)` remains at the end as before.

- **Implementation:** Replace the entire `onDidChange` handler body (lines 560–596) with:

```typescript
        this._planContentWatcher.onDidChange(async (uri) => {
            try {
                const db = this._getKanbanDb(workspaceRoot);
                const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';

                // Hoist plan lookup above ClickUp guard so both paths can use it.
                let plan: any = null;
                if (workspaceId) {
                    plan = await db.getPlanByPlanFile(uri.fsPath, workspaceId);
                    if (!plan) {
                        const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
                        plan = await db.getPlanByPlanFile(relativePath, workspaceId);
                    }
                }

                // ClickUp real-time sync (unchanged logic, reuses hoisted plan)
                try {
                    const clickUp = this._getClickUpService(workspaceRoot);
                    const clickUpConfig = await clickUp.loadConfig();
                    if (clickUpConfig?.setupComplete === true && clickUpConfig.realTimeSyncEnabled === true) {
                        if (workspaceId && plan) {
                            clickUp.debouncedSync(plan.sessionId, {
                                planId: plan.planId,
                                sessionId: plan.sessionId,
                                topic: plan.topic,
                                planFile: plan.planFile,
                                kanbanColumn: plan.kanbanColumn,
                                status: plan.status,
                                complexity: plan.complexity,
                                tags: plan.tags,
                                dependencies: plan.dependencies,
                                createdAt: plan.createdAt,
                                updatedAt: plan.updatedAt,
                                lastAction: plan.lastAction
                            });
                        }
                    }
                } catch { /* ClickUp sync failure must never block operations */ }

                // Metadata update path: per-file debounced extraction + DB write + board refresh.
                // Reads the file ONCE and extracts complexity, tags, and dependencies from the
                // in-memory content — avoids the triple file-read that calling
                // getComplexityFromPlan/getTagsFromPlan/getDependenciesFromPlan would cause.
                if (plan) {
                    const filePath = uri.fsPath;
                    const existingTimer = this._metadataDebounceTimers.get(filePath);
                    if (existingTimer) { clearTimeout(existingTimer); }

                    const timer = setTimeout(async () => {
                        try {
                            this._metadataDebounceTimers.delete(filePath);
                            const content = await fs.promises.readFile(uri.fsPath, 'utf8');

                            // Extract complexity (same logic as getComplexityFromPlan, but from in-memory content)
                            let newComplexity: string | null = null;
                            const overrideMatch = content.match(/\*\*Manual Complexity Override:\*\*\s*(\d{1,2}|Low|High|Unknown)/i);
                            if (overrideMatch) {
                                const val = overrideMatch[1];
                                if (val.toLowerCase() === 'unknown') {
                                    // fall through to metadata section
                                } else {
                                    const num = parseInt(val, 10);
                                    if (!isNaN(num) && num >= 1 && num <= 10) newComplexity = String(num);
                                    else {
                                        const { legacyToScore } = require('./complexityScale');
                                        const legacy = legacyToScore(val);
                                        if (legacy > 0) newComplexity = String(legacy);
                                    }
                                }
                            }
                            if (!newComplexity) {
                                const metadataMatch = content.match(/\*\*Complexity:\*\*\s*(\d{1,2}|Low|High)/i);
                                if (metadataMatch) {
                                    const val = metadataMatch[1];
                                    const num = parseInt(val, 10);
                                    if (!isNaN(num) && num >= 1 && num <= 10) newComplexity = String(num);
                                    else {
                                        const { legacyToScore } = require('./complexityScale');
                                        const legacy = legacyToScore(val);
                                        if (legacy > 0) newComplexity = String(legacy);
                                    }
                                }
                            }

                            // Extract tags (same regex as getTagsFromPlan; sanitizeTags is a local function in this class)
                            let newTags: string | null = null;
                            const tagsMatch = content.match(/\*\*Tags:\*\*\s*(.+)/i);
                            if (tagsMatch) {
                                newTags = sanitizeTags(tagsMatch[1]);
                            }

                            // Extract dependencies (same logic as getDependenciesFromPlan)
                            let newDeps: string | null = null;
                            const sectionMatch = content.match(/^#{1,4}\s+Dependencies\b[^\n]*$/im);
                            if (sectionMatch && sectionMatch.index !== undefined) {
                                const afterHeading = content.slice(sectionMatch.index + sectionMatch[0].length);
                                const nextHeadingMatch = afterHeading.match(/^\s*#{1,4}\s+/m);
                                const sectionBody = nextHeadingMatch
                                    ? afterHeading.slice(0, nextHeadingMatch.index)
                                    : afterHeading;
                                const deps = sectionBody
                                    .split(/\r?\n/)
                                    .map(line => line.trim())
                                    .map(line => line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim())
                                    .filter(line => line.length > 0)
                                    .filter(line => !/^(none|n\/a|na|unknown)$/i.test(line));
                                newDeps = [...new Set(deps)].join(', ');
                            }

                            // Write to DB only if we extracted something
                            const sessionId = plan.sessionId;
                            const updateDb = this._getKanbanDb(workspaceRoot);
                            if (newComplexity) { await updateDb.updateComplexity(sessionId, newComplexity); }
                            if (newTags !== null) { await updateDb.updateTags(sessionId, newTags); }
                            if (newDeps !== null) { await updateDb.updateDependencies(sessionId, newDeps); }

                            // Push updated DB state to the board (~100ms debounce via _scheduleBoardRefresh)
                            this._scheduleBoardRefresh(workspaceRoot);
                        } catch (err) {
                            console.warn('[KanbanProvider] Metadata update failed for', uri.fsPath, err);
                        }
                    }, 300);

                    this._metadataDebounceTimers.set(filePath, timer);
                }
            } catch { /* File watcher failures must never block operations */ }

            // Emit for continuous sync service (unchanged)
            this._planFileChangeEmitter.fire(uri);
        });
    }
```

- **Edge Cases Handled:**
  - Plan file not in DB: `plan` is null, metadata update block is skipped entirely
  - File deleted between watcher event and timer fire: `readFile` throws, caught by inner try-catch, logged as warning
  - Rapid successive edits: per-file 300ms debounce collapses them into a single read + DB update
  - ReviewProvider-triggered changes: the file watcher fires, but the 300ms debounce means the DB update happens after `updateReviewTicket` has already written the same values — the SQL UPDATE is a no-op
  - No complexity/tags in file: `newComplexity`/`newTags`/`newDeps` remain null, their respective `updateDb` calls are skipped

---

### 3. Clean up debounce timers in `dispose()`

#### MODIFY `src/services/KanbanProvider.ts`

- **Context:** The `dispose()` method already cleans up `_refreshDebounceTimer` and various watchers. The `_metadataDebounceTimers` Map must also be cleared to prevent leaked timers.
- **Logic:** Iterate the Map, clear each timeout, then clear the Map.
- **Implementation:** Find the existing `dispose()` method and add before the closing logic:

```typescript
        // Clean up metadata debounce timers
        for (const timer of this._metadataDebounceTimers.values()) {
            clearTimeout(timer);
        }
        this._metadataDebounceTimers.clear();
```

- **Edge Cases Handled:** If a timer fires after `dispose()` is called, the `clearTimeout` ensures it won't execute. The Map clear prevents stale references.

---

### 4. Add `fs` import if not already present

#### MODIFY `src/services/KanbanProvider.ts`

- **Context:** The new metadata extraction path uses `fs.promises.readFile` directly instead of going through `getComplexityFromPlan`. The `fs` module is already imported at the top of KanbanProvider.ts (used by `getComplexityFromPlan` at line 2123, `getTagsFromPlan` at line 2237, etc.). No new import needed.
- **Logic:** Verify `fs` is imported. It is — confirmed by existing usage patterns.

---

## Verification Plan

### Automated Tests
- Run existing kanban tests: `npm test -- --grep "Kanban"`
- Run complexity-specific tests: `npm test -- src/test/kanban-complexity.test.ts`
- Verify no TypeScript compilation errors: `npx tsc --noEmit`

### Manual Verification
1. **Open kanban board**: Run `Switchboard: Open Kanban` command
2. **Edit plan file directly**: Open a `.switchboard/plans/*.md` file, change `**Complexity:** 4` to `**Complexity:** 7` → verify the kanban card updates within ~400ms
3. **Edit via ReviewProvider dropdown**: Change complexity via the review panel dropdown → verify the kanban card updates (no double-refresh or flicker)
4. **Rapid edits**: Change complexity 3 times within 1 second → verify only ONE board refresh occurs (debounce working)
5. **Tags edit**: Add/change `**Tags:** backend, bugfix` in a plan file → verify tags update on the kanban card
6. **No DB record**: Create a new `.md` file in the plans folder that isn't registered → verify no error in console
7. **ClickUp sync still works**: With realTimeSync enabled, edit a plan → verify ClickUp still receives the sync

### Regression Test (Add to test suite)
Create new test in `src/test/kanban-metadata-watcher.test.ts`:
```typescript
describe('Kanban Metadata File Watcher', () => {
    it('should update DB complexity when plan file changes', async () => {
        // 1. Create a plan with known complexity in DB
        // 2. Modify the plan file to change complexity
        // 3. Wait 400ms (300ms debounce + 100ms board refresh)
        // 4. Verify db.getPlanBySessionId returns new complexity
    });

    it('should debounce multiple rapid file changes', async () => {
        // 1. Create a plan with known complexity
        // 2. Modify the file 3 times within 200ms
        // 3. Wait 500ms
        // 4. Verify only ONE db.updateComplexity call occurred
    });

    it('should not crash for files not in DB', async () => {
        // 1. Create a .md file in plans/ that has no DB record
        // 2. Modify it
        // 3. Verify no error thrown
    });
});
```

## Files Changed
- `src/services/KanbanProvider.ts` — Modified `_setupPlanContentWatcher` method:
  1. Added `_metadataDebounceTimers` Map field
  2. Hoisted plan lookup above ClickUp guard
  3. Added per-file debounced metadata extraction + DB update + board refresh
  4. Added timer cleanup in `dispose()`

## Findings Summary
- Root cause confirmed: `_planContentWatcher.onDidChange` only does ClickUp sync, never updates DB or refreshes board for metadata changes
- The `updateReviewTicket` path (ReviewProvider dropdown) already works correctly because it explicitly calls `db.updateComplexity` + `refreshViews()`
- The fix must work independently of ClickUp config — metadata updates are local-only
- Triple file read avoided by extracting all metadata from a single `readFile` call using the same regex patterns as the public `get*FromPlan` methods
- Per-file debounce (300ms) + global board refresh debounce (100ms) = max ~400ms from edit to board update

## Validation Results
- TypeScript compilation: ✅ Passed (1 pre-existing unrelated error at line 3218 for ArchiveManager import)
- Implementation complete:
  1. ✅ Added `_metadataDebounceTimers` Map field at line 119
  2. ✅ Restructured `onDidChange` handler with hoisted plan lookup (lines 584-711)
  3. ✅ Added per-file debounced metadata extraction + DB update + board refresh
  4. ✅ Added timer cleanup in `dispose()` (lines 491-495)
- Manual test checklist: pending user verification

## Remaining Risks
1. **Low**: The `require('./complexityScale')` call inside the timer callback uses dynamic require to avoid circular imports. If this module is refactored to ESM-only in the future, the call would need updating. However, the existing `getComplexityFromPlan` method already uses the same `legacyToScore` function, so the import pattern is consistent. `sanitizeTags` is a local function in KanbanProvider.ts (line 78) — no external import needed.

## Recommendation
**Send to Coder** — Complexity 5 (medium), single-file change with clear implementation spec.
