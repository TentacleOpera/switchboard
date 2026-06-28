# Promote-to-Epic Creates Epic File Without Subtask List in Description

## Goal

Fix the multi-plan "Promote to Epic" flow in `kanban.html` so that the resulting epic file always contains a populated `## Subtasks` section listing every selected plan. Currently, selecting multiple plans and clicking "PROMOTE TO EPIC" creates an epic file with only a bare `## Goal` description — the auto-generated subtask list is missing, making the epic file unusable.

### Problem Analysis

When a user selects multiple plans on the kanban board and clicks "PROMOTE TO EPIC", the frontend opens the "Create Epic" modal. On submit, the frontend dispatches a `createEpic` message with `subtaskPlanIds` (the selected card IDs). The backend handler in `KanbanProvider.ts` delegates to `createEpicFromPlanIds()`, which:

1. Upserts a new epic plan record with `isEpic: 1` (line 8666)
2. Writes the epic file with `## Goal` section (line 8708)
3. Links each subtask via `db.updateEpicStatus(st.planId, 0, planId)` (lines 8709–8712)
4. Calls `_regenerateEpicFile()` to append the `## Subtasks` section (line 8714)

The user reports that step 4 produces no subtask list — the epic file contains only the frontmatter, `# Title`, and `## Goal` description.

### Root Cause

`_regenerateEpicFile()` (line 8565) has an early-return guard:

```typescript
const epic = await db.getPlanByPlanId(epicPlanId);
if (!epic || !epic.isEpic) return;  // ← silently aborts, leaving file without subtask section
```

If `getPlanByPlanId(epicPlanId)` returns `null` or a record with `isEpic` falsy (`0` or `undefined`), the function returns without writing the subtask section. The epic file remains as-written at step 2 — bare description, no subtasks.

The most likely mechanism is a **race between `upsertPlan` and the file watcher**. Although `registerPendingCreation` is called before the `writeFile` at step 2, the watcher debounces events by 300ms (`GlobalPlanWatcherService.ts` line 443). If the watcher's `_handlePlanFile` fires within the 3-second suppression window but after a `getPlanByPlanFile` lookup that returns a stale record, or if the `upsertPlan` ON CONFLICT clause hits a pre-existing record for the same `plan_file` (keeping an old `plan_id` that doesn't match the new `planId`), then `getPlanByPlanId(newPlanId)` returns `null` and `_regenerateEpicFile` silently aborts.

A secondary possibility is that `getSubtasksByEpicId(epicPlanId)` returns empty because the subtask linking at step 3 failed silently — `updateEpicStatus` returns `false` on failure but the return value is not checked. In this case `_regenerateEpicFile` would write `"- [ ] (no subtasks)"` rather than nothing, so the absence of ANY subtask section points to the early-return guard as the primary cause.

## Metadata
- **Tags:** bugfix, backend, kanban, epic, reliability
- **Complexity:** 6/10

## Complexity Audit

### Routine
- Adding diagnostic logging after `upsertPlan`, after each `updateEpicStatus`, and inside `_regenerateEpicFile` to trace the exact failure point.
- Checking return values of `updateEpicStatus` in the subtask linking loop.
- Adding a fallback subtask-section write if `_regenerateEpicFile` aborts.

### Complex / Risky
- The file watcher (`GlobalPlanWatcherService`) has subtle timing behavior; any change to `registerPendingCreation` timing could affect other flows (single-plan `promoteToEpic`, normal plan imports).
- The `upsertPlan` ON CONFLICT clause is sticky for `is_epic` but does NOT update `plan_id` — if a pre-existing record conflicts on `plan_file`, the new `planId` is silently ignored, orphaning all downstream `getPlanByPlanId(newPlanId)` lookups. This is a structural issue that requires careful handling to avoid breaking the rename/move flows.

## Edge-Case & Dependency Audit
- **Race Conditions:** The `registerPendingCreation` 3-second window vs. the 300ms debounce delay means the watcher event fires well within the window. However, if `upsertPlan` is slow (large DB, disk I/O), the window could be tight. The fix must not rely on timing.
- **ON CONFLICT plan_id mismatch:** If the epic file already exists in the DB (e.g., from a prior failed attempt that left a record), `upsertPlan` updates the existing record but keeps the old `plan_id`. The new `planId` (from `crypto.randomUUID()`) doesn't match any record, so `getPlanByPlanId(newPlanId)` returns `null`. This is the most plausible structural root cause.
- **Subtask ID mismatch:** `selectedCards` keys are `card.planId || card.sessionId`. If a card has no `planId` (only `sessionId`), `getPlanByPlanId(pid)` fails for that subtask. However, if ALL subtasks fail, `createEpicFromPlanIds` returns an error and no file is written — contradicting the user's report. So this is not the primary cause.
- **Security:** None. No new input surfaces, no external calls.
- **Dependencies:** The single-plan `promoteToEpic` path must remain unaffected. The `_regenerateEpicFile` function is shared by many handlers (moveCard, completePlan, addSubtask, etc.) — any change must not break those paths.

## Proposed Changes

### Change 1: Verify upsert succeeded and re-query by plan_file if getPlanByPlanId fails

**File:** `src/services/KanbanProvider.ts` — `createEpicFromPlanIds()` (line 8605)

After the `upsertPlan` call, verify the record is findable by the new `planId`. If not, fall back to querying by `planFile` and use the actual DB `plan_id` for all downstream operations.

```typescript
// After upsertPlan (line 8694)
if (!upsertOk) {
    return { success: false, error: 'Failed to create epic: DB upsert failed. The epic file was not written.' };
}

// Verify the record is findable by the new planId. If ON CONFLICT kept an old
// plan_id (pre-existing record for the same plan_file), use the actual DB plan_id.
let effectiveEpicPlanId = planId;
const verifyRecord = await db.getPlanByPlanId(planId);
if (!verifyRecord) {
    // ON CONFLICT kept an old plan_id — look up by plan_file
    const existingByFile = await db.getPlanByPlanFile(epicPlanFile, workspaceId);
    if (existingByFile) {
        effectiveEpicPlanId = existingByFile.planId;
        console.warn(`[KanbanProvider] createEpicFromPlanIds: planId mismatch — upsert kept old plan_id ${effectiveEpicPlanId}, expected ${planId}. Using DB plan_id for all downstream operations.`);
    } else {
        return { success: false, error: 'Failed to create epic: record not found after upsert.' };
    }
}
```

Then use `effectiveEpicPlanId` for all downstream operations (subtask linking, `_regenerateEpicFile`, `updateEpicStatus`):

```typescript
// Line 8709-8712 — use effectiveEpicPlanId
for (const st of subtasks) {
    const linkOk = await db.updateEpicStatus(st.planId || st.sessionId, 0, effectiveEpicPlanId);
    if (!linkOk) {
        console.warn(`[KanbanProvider] createEpicFromPlanIds: updateEpicStatus failed for subtask ${st.planId}`);
    }
}
// Line 8714 — use effectiveEpicPlanId
await this._regenerateEpicFile(workspaceRoot, effectiveEpicPlanId, db);
// Line 8718 — use effectiveEpicPlanId
await db.updateEpicStatus(effectiveEpicPlanId, 1, '');
```

### Change 2: Add diagnostic logging inside `_regenerateEpicFile`

**File:** `src/services/KanbanProvider.ts` — `_regenerateEpicFile()` (line 8565)

```typescript
private async _regenerateEpicFile(workspaceRoot: string, epicPlanId: string, db: KanbanDatabase): Promise<void> {
    const epic = await db.getPlanByPlanId(epicPlanId);
    if (!epic) {
        console.warn(`[KanbanProvider] _regenerateEpicFile: epic not found for planId=${epicPlanId}, aborting.`);
        return;
    }
    if (!epic.isEpic) {
        console.warn(`[KanbanProvider] _regenerateEpicFile: epic.isEpic is falsy (${epic.isEpic}) for planId=${epicPlanId}, aborting.`);
        return;
    }
    const subtasks = await db.getSubtasksByEpicId(epicPlanId);
    console.log(`[KanbanProvider] _regenerateEpicFile: epicPlanId=${epicPlanId}, subtasks found=${subtasks.length}`);
    // ... rest of function unchanged
}
```

### Change 3: Fallback — write subtask section directly if `_regenerateEpicFile` aborts

**File:** `src/services/KanbanProvider.ts` — `createEpicFromPlanIds()` (after line 8714)

If `_regenerateEpicFile` silently aborts (epic not found or isEpic falsy), write the subtask section directly as a fallback:

```typescript
await this._regenerateEpicFile(workspaceRoot, effectiveEpicPlanId, db);

// Fallback: verify the subtask section was actually written
const epicAfterRegen = await db.getPlanByPlanId(effectiveEpicPlanId);
if (epicAfterRegen && epicAfterRegen.isEpic) {
    const epicAbsPath = path.resolve(workspaceRoot, epicAfterRegen.planFile);
    try {
        const content = await fs.promises.readFile(epicAbsPath, 'utf8');
        if (!content.includes('<!-- BEGIN SUBTASKS')) {
            console.warn(`[KanbanProvider] createEpicFromPlanIds: subtask section missing after _regenerateEpicFile, writing fallback.`);
            const allSubs = await db.getSubtasksByEpicId(effectiveEpicPlanId);
            const subtaskLines = allSubs.map(st => {
                const basename = path.basename(st.planFile);
                const topic = st.topic || basename;
                const column = this._normalizeLegacyKanbanColumn(st.kanbanColumn) || 'CREATED';
                return `- [ ] [${topic}](../plans/${basename}) — **${column}**`;
            });
            const subtaskSection = `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n${subtaskLines.join('\n') || '- [ ] (no subtasks)'}\n<!-- END SUBTASKS -->`;
            const newContent = content.replace(/\n*$/, '') + '\n\n' + subtaskSection + '\n';
            GlobalPlanWatcherService.registerPendingCreation(epicAbsPath);
            await fs.promises.writeFile(epicAbsPath, newContent, 'utf8');
        }
    } catch (verifyErr) {
        console.warn(`[KanbanProvider] createEpicFromPlanIds: fallback verification failed: ${verifyErr}`);
    }
}
```

## Verification Plan

1. **Reproduce the bug:** Select 2+ plans on the kanban board, click "PROMOTE TO EPIC", enter a name, click "Create Epic". Observe the epic file in `.switchboard/epics/` — confirm it lacks the `## Subtasks` section.
2. **Check diagnostic logs:** After adding Change 2, reproduce again and check the Output panel for `_regenerateEpicFile` warnings. This confirms whether the early-return guard is the failure point.
3. **Apply fixes:** Implement Changes 1–3, rebuild, and re-test.
4. **Verify subtask section appears:** After the fix, the epic file should contain:
   ```
   <!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
   ## Subtasks
   - [ ] [Subtask 1](../plans/subtask1-uuid.md) — **CREATED**
   - [ ] [Subtask 2](../plans/subtask2-uuid.md) — **CREATED**
   <!-- END SUBTASKS -->
   ```
5. **Verify single-plan path still works:** Select one plan, click "PROMOTE TO EPIC", confirm the promoted plan's file is moved to `epics/` and the subtask section (if any subtasks exist) is populated.
6. **Verify board refresh:** After multi-plan epic creation, the board should refresh and show the new epic card with the `EPIC · N subtasks` badge.
7. **Verify existing epic operations:** Add subtask to an existing epic, remove subtask, move epic to another column — confirm `_regenerateEpicFile` still works correctly for all these operations.
