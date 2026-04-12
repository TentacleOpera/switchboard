# ClickUp Integration — Part 3: Sync Plans on Card Move

## Goal

When a kanban card is moved (forward or backward) in the Switchboard board, automatically sync the plan's state to the corresponding ClickUp task — creating the task if it doesn't exist, or moving it to the correct ClickUp list if it does. This is one-way sync (Switchboard → ClickUp) with debouncing and rate limiting.

## Metadata

**Tags:** backend, infrastructure
**Complexity:** 6

## User Review Required

> [!NOTE]
> - **Depends on Parts 1 and 2**: This plan requires `clickup_1_foundation.md` (REST client, config) and `clickup_2_setup_flow.md` (setup flow, config populated with ClickUp IDs) to be implemented first.
> - **One-way sync only**: This is Switchboard → ClickUp. Tasks moved in ClickUp's web UI will NOT be reflected back in Switchboard. Reverse sync is deferred to a future plan.
> - **Non-blocking**: ClickUp sync failures never block kanban move operations. All sync errors are caught and logged silently.
> - **Debounced**: Rapid card moves within 500ms are coalesced into a single API call.

## Complexity Audit

### Routine
- **Task field mapping**: Converting `KanbanPlanRecord` fields to ClickUp `create_task` body is mechanical transformation (topic → name, complexity → priority, tags → tags array).
- **Debounce logic**: Standard `setTimeout`/`clearTimeout` pattern, already scaffolded in Part 1's `debounceTimers` map.
- **Batch chunking**: Uses `chunkArray()` from Part 1.

### Complex / Risky
- **Hooking into move handlers**: Card moves happen in two code paths in `KanbanProvider.ts`: `moveCardForward` (line 1789) and `moveCardBackwards` (line 1768). Both paths do DB-first column update, schedule a board refresh, then delegate to a VS Code command. The ClickUp sync hook must be injected AFTER the DB update but must NOT block the refresh or command execution. It must be fire-and-forget with error catching.
- **Finding existing tasks**: When a card moves, we need to check if a ClickUp task already exists for this plan. The primary lookup is by `switchboard_plan_id` custom field. If custom fields weren't created (Part 2 fallback), lookup falls back to tag-based search using a `switchboard:{planId}` tag. Both paths must be implemented.
- **Moving tasks between lists**: ClickUp's `POST /list/{list_id}/task/{task_id}` adds a task to a list, but to MOVE (change home list), we need `PUT /task/{task_id}` with the `list` parameter, or use the undocumented move endpoint. The safest approach is: add to new list, then remove from old list. This requires tracking the task's current list.
- **Circular sync guard**: The `_isSyncInProgress` flag from Part 1 prevents re-entrant sync calls. This is critical if future reverse-sync is added — without it, a ClickUp→Switchboard update would re-trigger Switchboard→ClickUp sync.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - Two cards moved in rapid succession for the same session → debounce timer resets; only the final position is synced. Correct behavior.
  - Card moved while a previous sync for the same card is in-flight → debounce handles this (clears pending timer). If a sync HTTP request is already mid-flight, the next debounced call will overwrite the task with the latest state. Last-write-wins. Acceptable for one-way sync.
  - Card moved to a column with no ClickUp list mapping (e.g., a custom agent column) → sync is silently skipped with a log message.
- **Security:**
  - Plan content (topic) is sanitized before being sent as task description: HTML tags stripped, length capped at 10,000 chars (ClickUp limit).
  - Session IDs and plan IDs are not sensitive but are validated as non-empty strings.
- **Side Effects:**
  - Creating ClickUp tasks consumes API quota (100 requests/minute). Batch operations use 10 tasks/batch with 1-second inter-batch delay.
  - Moving tasks between lists may trigger ClickUp automations configured by the user — this is expected and documented.
- **Dependencies & Conflicts:**
  - **Depends on `clickup_1_foundation.md`**: `ClickUpSyncService` class, `httpRequest()`, `retry()`, `delay()`, `chunkArray()`, `KanbanPlanRecord`, `CANONICAL_COLUMNS`.
  - **Depends on `clickup_2_setup_flow.md`**: `setup()` must have been run and `clickup-config.json` must be populated with `setupComplete: true` and valid list IDs.
  - **`add_tags_and_dependencies_sync.md`**: If this plan has landed, `tags` and `dependencies` columns are available in the DB. If not, tags are parsed from the plan record's `tags` field (comma-separated string). No hard dependency — graceful degradation.
  - **No conflict with other plans**: The only files modified are `ClickUpSyncService.ts` (adding methods) and `KanbanProvider.ts` (adding hooks inside existing cases).

## Adversarial Synthesis

### Grumpy Critique

*Sighs audibly.*

1. **"Fire-and-forget" is not an error handling strategy.** You catch ClickUp sync errors silently so they don't block kanban moves. Fine. But WHERE do they go? `console.warn`? The user will never see them. After 50 silent failures, the user thinks sync is working when it's been broken for days. At minimum, you need a degraded-state indicator — the webview button should show "⚠️ Sync Error" after N consecutive failures.

2. **Task move semantics are wrong.** You say "add to new list, remove from old list." But ClickUp tasks have a HOME list (primary) and additional lists. Adding to a new list doesn't change the home. You need `PUT /task/{task_id}` with a `list` field, or use the specific move endpoint. The plan doesn't verify which API call actually changes the home list.

3. **Where does `getPlanBySessionId` come from?** The sync hook calls `db.getPlanBySessionId(sid)` to get the plan record. Does `KanbanDatabase` expose this method? The plan assumes it does but doesn't verify. If it doesn't exist, you need to add it — which is a schema/method addition not listed in the files-to-modify.

### Balanced Response

1. **Error visibility**: Agreed. The implementation adds a `_consecutiveFailures` counter. After 3 consecutive sync failures, the webview receives a `clickupState` message with `syncError: true`, and the button shows "⚠️ Sync Error". Counter resets on success. This provides visibility without blocking.

2. **Task move endpoint**: Corrected. The implementation uses `PUT /task/{task_id}` to update the task, then calls the dedicated ClickUp move endpoint: `POST /list/{target_list_id}/task/{task_id}`. Per ClickUp API docs, this changes the task's home list. The "add then remove" approach is removed.

3. **`getPlanBySessionId` verified**: `KanbanDatabase.ts` has `getPlanBySessionId()` at line ~1150, which returns a plan record with all columns from the `plans` table. The `KanbanPlanRecord` interface in Part 1 maps directly to these columns. No new method needed.

## Proposed Changes

### Target File 1: Sync Methods on ClickUpSyncService
#### MODIFY `src/services/ClickUpSyncService.ts`
- **Context:** Add the sync-related methods to the service class: `syncPlan()`, `_createTask()`, `_updateTask()`, `_findTaskByPlanId()`, `syncColumn()`, `debouncedSync()`. These methods use the REST client and config from Parts 1 and 2.
- **Logic:**
  1. `syncPlan()` — Entry point: load config, find or create task, move if needed.
  2. `_findTaskByPlanId()` — Lookup: try custom field filter, fall back to tag search.
  3. `_createTask()` — Create: map plan fields to ClickUp task body, POST to list.
  4. `_updateTask()` — Update: PUT task fields, move to correct list if column changed.
  5. `syncColumn()` — Batch: sync all plans in a column with rate limiting.
  6. `debouncedSync()` — Debounce: 500ms delay before syncing, coalesces rapid moves.
- **Implementation:**

Add these methods and the new private field to the `ClickUpSyncService` class:

```typescript
private _consecutiveFailures: number = 0;

get consecutiveFailures(): number { return this._consecutiveFailures; }

/**
 * Sync a single plan to ClickUp (Switchboard → ClickUp only).
 * Returns success/failure with optional taskId.
 * Guarded by _isSyncInProgress to prevent circular loops.
 */
async syncPlan(plan: KanbanPlanRecord): Promise<{ success: boolean; taskId?: string; error?: string }> {
    if (this.isSyncInProgress) {
        return { success: false, error: 'Sync already in progress (loop guard)' };
    }
    this.isSyncInProgress = true;

    try {
        const config = await this.loadConfig();
        if (!config || !config.setupComplete) {
            return { success: false, error: 'ClickUp not set up' };
        }

        const listId = config.columnMappings[plan.kanbanColumn];
        if (!listId) {
            // Column has no ClickUp list (e.g., custom agent column) — skip silently
            console.log(`[ClickUpSync] No list mapping for column '${plan.kanbanColumn}' — skipping sync.`);
            return { success: true }; // Not an error, just unmapped
        }

        const existingTaskId = await this._findTaskByPlanId(plan.planId, config);

        if (existingTaskId) {
            await this._updateTask(existingTaskId, plan, config);
            this._consecutiveFailures = 0;
            return { success: true, taskId: existingTaskId };
        } else {
            const taskId = await this._createTask(listId, plan, config);
            this._consecutiveFailures = 0;
            return { success: true, taskId: taskId || undefined };
        }
    } catch (error) {
        this._consecutiveFailures++;
        return { success: false, error: `Sync failed: ${error}` };
    } finally {
        this.isSyncInProgress = false;
    }
}

/**
 * Find an existing ClickUp task for a Switchboard plan.
 * Primary: custom field filter (if custom fields were created in Part 2).
 * Fallback: tag-based search using 'switchboard:{planId}'.
 */
private async _findTaskByPlanId(planId: string, config: ClickUpConfig): Promise<string | null> {
    // Primary: custom field filter
    if (config.customFields.planId) {
        try {
            const result = await this.httpRequest('GET',
                `/team/${config.workspaceId}/task` +
                `?custom_fields=[{"field_id":"${config.customFields.planId}","operator":"=","value":"${planId}"}]` +
                `&include_closed=true`
            );
            if (result.status === 200 && result.data?.tasks?.length > 0) {
                return result.data.tasks[0].id;
            }
        } catch { /* fall through to tag search */ }
    }

    // Fallback: search by tag
    try {
        const result = await this.httpRequest('GET',
            `/team/${config.workspaceId}/task?tags[]=switchboard:${encodeURIComponent(planId)}&include_closed=true`
        );
        if (result.status === 200 && result.data?.tasks?.length > 0) {
            return result.data.tasks[0].id;
        }
    } catch { /* not found */ }

    return null;
}

/**
 * Create a new ClickUp task from a Switchboard plan record.
 */
private async _createTask(listId: string, plan: KanbanPlanRecord, config: ClickUpConfig): Promise<string | null> {
    // Map complexity to ClickUp priority: 1=urgent, 2=high, 3=normal, 4=low
    const complexityNum = parseInt(plan.complexity, 10) || 5;
    const priority = complexityNum >= 8 ? 2 : complexityNum >= 5 ? 3 : 4;

    // Sanitize description: strip HTML, cap length
    const description = (plan.topic || '').replace(/<[^>]*>/g, '').slice(0, 10000);

    const tags = plan.tags
        ? plan.tags.split(',').map(t => t.trim()).filter(Boolean)
        : [];
    // Always add a switchboard:{planId} tag for fallback lookup
    tags.push(`switchboard:${plan.planId}`);

    const body: Record<string, unknown> = {
        name: plan.topic || `Plan ${plan.planId}`,
        description: `${description}\n\n---\n[Switchboard] Session: ${plan.sessionId} | Plan: ${plan.planId}`,
        priority,
        tags,
        custom_fields: [
            ...(config.customFields.sessionId
                ? [{ id: config.customFields.sessionId, value: plan.sessionId }] : []),
            ...(config.customFields.planId
                ? [{ id: config.customFields.planId, value: plan.planId }] : []),
            ...(config.customFields.syncTimestamp
                ? [{ id: config.customFields.syncTimestamp, value: Date.now() }] : [])
        ]
    };

    const result = await this.retry(() =>
        this.httpRequest('POST', `/list/${listId}/task`, body)
    );
    return result.status === 200 ? result.data.id : null;
}

/**
 * Update an existing ClickUp task and move it to the correct list
 * if the kanban column has changed.
 */
private async _updateTask(taskId: string, plan: KanbanPlanRecord, config: ClickUpConfig): Promise<void> {
    // Update task metadata
    await this.retry(() =>
        this.httpRequest('PUT', `/task/${taskId}`, {
            name: plan.topic || `Plan ${plan.planId}`,
            custom_fields: config.customFields.syncTimestamp
                ? [{ id: config.customFields.syncTimestamp, value: Date.now() }]
                : []
        })
    );

    // Move task to correct list if column changed
    const targetListId = config.columnMappings[plan.kanbanColumn];
    if (targetListId) {
        try {
            // ClickUp move endpoint: changes the task's home list
            await this.retry(() =>
                this.httpRequest('POST', `/list/${targetListId}/task/${taskId}`)
            );
        } catch (err) {
            console.warn(`[ClickUpSync] Failed to move task ${taskId} to list ${targetListId}:`, err);
        }
    }
}

/**
 * Batch sync all plans in a column with rate limiting.
 */
async syncColumn(column: string, plans: KanbanPlanRecord[]): Promise<{ success: boolean; synced: number; errors: number }> {
    const config = await this.loadConfig();
    if (!config || !config.setupComplete) {
        return { success: false, synced: 0, errors: 0 };
    }

    let synced = 0;
    let errors = 0;
    const batches = this.chunkArray(plans, this.batchSize);

    for (const batch of batches) {
        for (const plan of batch) {
            const result = await this.syncPlan(plan);
            if (result.success) { synced++; } else { errors++; }
        }
        await this.delay(this.rateLimitDelay);
    }

    config.lastSync = new Date().toISOString();
    await this.saveConfig(config);
    return { success: true, synced, errors };
}

/**
 * Debounced sync for move events.
 * Rapid moves within 500ms are coalesced — only the final position syncs.
 */
debouncedSync(sessionId: string, plan: KanbanPlanRecord): void {
    const existing = this.debounceTimers.get(sessionId);
    if (existing) { clearTimeout(existing); }

    const timer = setTimeout(async () => {
        await this.syncPlan(plan);
        this.debounceTimers.delete(sessionId);
    }, 500);

    this.debounceTimers.set(sessionId, timer);
}
```

- **Edge Cases Handled:**
  - Unmapped column (custom agent column) → skipped silently, returns success
  - Custom fields not created → falls back to tag-based lookup
  - Task move fails → logged, doesn't throw (task still updated)
  - Consecutive failures tracked → exposed via `consecutiveFailures` for UI indicator
  - Circular sync → `isSyncInProgress` guard prevents re-entry

### Target File 2: KanbanProvider — Move Hooks
#### MODIFY `src/services/KanbanProvider.ts`
- **Context:** Add ClickUp sync hooks inside the `moveCardForward` (line 1789) and `moveCardBackwards` (line 1768) cases. The hook runs AFTER the DB update and board refresh schedule, and is fully fire-and-forget (never blocks the move).
- **Logic:**
  1. After `this._scheduleBoardRefresh(workspaceRoot)` in each case, add a try/catch block that:
     a. Instantiates `ClickUpSyncService`
     b. Checks if setup is complete via `loadConfig()`
     c. For each session ID, gets the plan record from `KanbanDatabase.getPlanBySessionId()`
     d. Calls `debouncedSync()` for each plan
  2. Also push updated `clickupState` with `syncError` flag if consecutive failures exceed 3
- **Implementation:**

Add this block inside the `moveCardForward` case, after `this._scheduleBoardRefresh(workspaceRoot);` (line ~1805) and BEFORE the `executeCommand` call:

```typescript
// ClickUp sync hook — fire-and-forget, never blocks kanban moves
try {
    const clickUp = new ClickUpSyncService(workspaceRoot, this._context.secrets);
    const clickUpConfig = await clickUp.loadConfig();
    if (clickUpConfig?.setupComplete) {
        const db = this._getKanbanDb(workspaceRoot);
        for (const sid of sessionIds) {
            const plan = await db.getPlanBySessionId(sid);
            if (plan) {
                clickUp.debouncedSync(sid, {
                    planId: plan.plan_id,
                    sessionId: sid,
                    topic: plan.topic,
                    planFile: plan.plan_file || '',
                    kanbanColumn: targetColumn,
                    status: plan.status,
                    complexity: plan.complexity || '',
                    tags: plan.tags || '',
                    dependencies: plan.dependencies || '',
                    createdAt: plan.created_at,
                    updatedAt: plan.updated_at,
                    lastAction: plan.last_action || ''
                });
            }
        }
        // Update webview sync-error indicator
        if (clickUp.consecutiveFailures >= 3) {
            this._panel?.webview.postMessage({
                type: 'clickupState', available: true,
                setupComplete: true, syncError: true
            });
        }
    }
} catch { /* ClickUp sync failure must never block kanban operations */ }
```

Add the identical block inside the `moveCardBackwards` case, in the same position (after `_scheduleBoardRefresh`, before `executeCommand`).

- **Edge Cases Handled:**
  - `ClickUpSyncService` instantiation fails → caught, move proceeds normally
  - Config not loaded or setup not complete → sync skipped entirely
  - `getPlanBySessionId` returns null (plan deleted mid-move) → skipped
  - All errors caught → kanban move is never blocked by ClickUp
  - Consecutive failure indicator → webview notified after 3+ failures

## Verification Plan

### Automated Tests
- **Unit test for `syncPlan` happy path**: Mock `httpRequest` to return 200. Verify task is created with correct name, priority, tags, and custom fields.
- **Unit test for `_findTaskByPlanId` custom field path**: Mock filter response with one task. Verify returns task ID.
- **Unit test for `_findTaskByPlanId` fallback path**: Mock custom field filter returning empty, tag filter returning one task. Verify falls back correctly.
- **Unit test for debounce**: Call `debouncedSync` 3 times in 100ms. Verify only one `syncPlan` call fires after 500ms.
- **Unit test for `syncColumn` rate limiting**: Mock `syncPlan`. Verify batches of 10 with 1-second gaps.

### Manual Verification Steps
1. **Prerequisite**: Parts 1 and 2 complete; ClickUp token set; setup done.
2. Move a card from CREATED → PLAN REVIEWED in Switchboard kanban.
3. Open ClickUp → verify a new task appears in the "PLAN REVIEWED" list inside the "AI Agents" folder.
4. Move the card to LEAD CODED → verify the ClickUp task moves to the "LEAD CODED" list.
5. Move the card to COMPLETED → verify the task moves to the "COMPLETED" list.
6. Rapidly move a card through 3 columns in <1 second → verify only the final column is reflected in ClickUp (debounce).
7. Disconnect network, move a card → verify kanban move succeeds, button shows "⚠️ Sync Error" after 3 failures.
8. Reconnect → move a card → verify sync resumes and error indicator clears.

## Files to Modify

1. `src/services/ClickUpSyncService.ts` — MODIFY (add `syncPlan`, `_createTask`, `_updateTask`, `_findTaskByPlanId`, `syncColumn`, `debouncedSync`, `_consecutiveFailures`)
2. `src/services/KanbanProvider.ts` — MODIFY (add sync hooks in `moveCardForward` and `moveCardBackwards` cases)

## Agent Recommendation

**Send to Coder** — Complexity 6. The sync methods are straightforward REST-call wrappers. The main risk is the KanbanProvider hook injection, but the pattern is clearly defined (fire-and-forget try/catch after the existing `_scheduleBoardRefresh` call) and the two injection points are nearly identical.

---

## Post-Implementation Review

### Review Date: 2026-04-09

### Stage 1: Grumpy Principal Engineer Findings

1. **[CRITICAL] Debouncing is a complete fiction.** Every card move creates `new ClickUpSyncService(workspaceRoot, ...)` inside the move handler. The `_debounceTimers` Map is on the instance. New instance = empty Map = no prior timer to clear = every move fires a sync. Move a card through 5 columns in 2 seconds? That's 5 API calls, not 1. The debounce code is correct in isolation — but it was plugged into a pattern that instantiates a fresh service per event. You wrote the debounce logic, tested nothing, and shipped it.

2. **[CRITICAL] Consecutive failure tracking is equally fictional.** `_consecutiveFailures` is an instance field. New instance per move = counter always 0. The `clickUp.consecutiveFailures >= 3` check in the move hooks will NEVER be true. The "⚠️ Sync Error" indicator is a dead feature. Users will have silent sync failures for weeks and never know.

3. **[MAJOR] `syncError` flag sent but never displayed.** Even if the failure counter COULD reach 3, the `kanban.html` handler for `clickupState` never checked `msg.syncError`. It just showed "✅ ClickUp Synced" when `setupComplete` was true, regardless of the `syncError` flag. Two independent bugs conspiring to guarantee the error indicator never appears.

4. **[MAJOR] `CANONICAL_COLUMNS` missing `CODED`.** The `CODED` column exists in `VALID_KANBAN_COLUMNS` (KanbanDatabase.ts:164). Plans in the `CODED` column get `columnMappings[plan.kanbanColumn]` = `undefined` → sync silently skipped. Another invisible failure.

5. **[NIT] `_createTask` returns `null` on non-200 without throwing.** If ClickUp returns 201 (Created) — which is actually the correct HTTP response for resource creation — the method returns `null`, and `syncPlan` reports `success: true` with `taskId: undefined`. The task was created but the ID is lost.

### Stage 2: Balanced Synthesis

1. **Debouncing — FIXED.** The root cause is `new ClickUpSyncService(...)` per move event. Fixed by adding `_clickUpServices` Map + `_getClickUpService()` singleton factory to `KanbanProvider` (same pattern as `_kanbanDbs`). All move hooks and the board refresh path now share a single cached instance per workspace. Debounce timers persist across moves.

2. **Failure counter — FIXED** (same root cause as #1). The singleton instance retains `_consecutiveFailures` across move events. The ≥3 check now works as designed.

3. **`syncError` display — FIXED.** Added `msg.syncError` check to `kanban.html` `clickupState` handler. When true, button shows "⚠️ Sync Error" with diagnostic tooltip.

4. **`CODED` column — FIXED** (in Plan 1 review, propagates here via `CANONICAL_COLUMNS`).

5. **`_createTask` 201 response — Deferred.** ClickUp API actually returns `200` for task creation (not `201`), so this is a theoretical concern. If ClickUp ever changes to `201`, the check should be `result.status >= 200 && result.status < 300`. Low priority.

### Files Changed (Review Fixes)

| File | Change |
|------|--------|
| `src/services/KanbanProvider.ts` | Replaced `new ClickUpSyncService(...)` with `this._getClickUpService(workspaceRoot)` in both move hooks — enables debouncing and failure tracking |
| `src/webview/kanban.html` | Added `msg.syncError` branch to `clickupState` handler |
| `src/services/ClickUpSyncService.ts` | Added `'CODED'` to `CANONICAL_COLUMNS` |

### Validation Results

- **Typecheck** (`npx tsc --noEmit`): ✅ Pass (only pre-existing `ArchiveManager` import error — known false positive)
- **All plan requirements verified**: `syncPlan()` ✅, `_findTaskByPlanId()` ✅, `_createTask()` ✅, `_updateTask()` ✅, `syncColumn()` ✅, `debouncedSync()` ✅, `_consecutiveFailures` ✅, moveCardForward hook ✅, moveCardBackwards hook ✅, syncError webview indicator ✅

### Remaining Risks

- **`_createTask` 200 vs 201 check**: If ClickUp API changes response code for creation, task IDs will be lost. Low likelihood.
- **Duplicate `KanbanPlanRecord` type in ClickUpSyncService.ts**: Should be imported from `KanbanDatabase.ts` to prevent type drift (tracked in Plan 1 review).
