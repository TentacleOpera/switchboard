# Complexity label does not auto update

When the planner agent moves plans to the "planned" column (PLAN REVIEWED), the _advanceSessionsInColumn method in KanbanProvider.ts (lines 2590-2639) updates:

The runsheet events to record the column change
The database column field via db.updateColumn(sessionId, normalizedColumn)
However, it does NOT update the database complexity field. The planner agent writes the new complexity to the plan file, but the kanban board reads complexity from the database, not the plan file. The complexity label only updates when the user manually saves the plan ticket, which triggers the setComplexity case in updateReviewTicket that calls db.updateComplexity.

Fix Required: Add a call to db.updateComplexity in _advanceSessionsInColumn (and potentially in moveCardForward) to sync the complexity from the plan file to the database when plans are moved to the planned column.

## Goal
Sync the complexity value from the plan file to the kanban database whenever `_advanceSessionsInColumn` advances a session, so the kanban board complexity label reflects the planner agent's updated complexity immediately without requiring a manual ticket save.

## Metadata
- **Tags:** [backend, bugfix, workflow]
- **Complexity:** 3

## User Review Required
- None — this is a straightforward data-sync bug fix with no UX or product scope changes.

## Complexity Audit

### Routine
- Adding a complexity read + DB write call inside an existing loop in `_advanceSessionsInColumn`
- Reusing the existing `getComplexityFromPlan()` method (KanbanProvider.ts:2935) which already handles priority resolution (manual override > DB > metadata > agent rec > heuristic)
- Reusing the existing `db.updateComplexityByPlanFile()` method (KanbanDatabase.ts:1202) which already validates complexity values via `isValidComplexityValue()`
- The sheet object already has `planFile` available at the point where the fix is needed (line 2600: `const sheet = await log.getRunSheet(sessionId)`)

### Complex / Risky
- Overwriting a valid DB complexity with "Unknown" if the plan file can't be parsed — must guard against this regression
- Complexity sync failure must not block the column advance (the primary operation)

## Edge-Case & Dependency Audit
- **Race Conditions:** The planner agent writes complexity to the plan file before `_advanceSessionsInColumn` is triggered. The file write is `await`ed, so stale reads are unlikely. However, defensive try/catch is needed so a transient read failure doesn't block the column advance.
- **Security:** No security implications — complexity is a display/routing value, not security-sensitive.
- **Side Effects:** If `getComplexityFromPlan` returns "Unknown" and we write that to DB, we would overwrite a previously valid complexity value (e.g., "5" → "Unknown"). This is a regression risk. Mitigation: only update DB complexity when the plan file yields a valid (non-"Unknown") value.
- **Dependencies & Conflicts:** The `updateComplexityByPlanFile` method requires `workspaceId`, which can be obtained from `db.getWorkspaceId()` or from the plan record via `db.getPlanBySessionId(sessionId)`. Since we already have the `db` instance and `sessionId`, this is straightforward.

## Dependencies
- None

## Adversarial Synthesis
Key risks: overwriting valid DB complexity with "Unknown" from a stale/unparseable plan file; complexity sync failure blocking the column advance. Mitigations: only write to DB when plan file yields a valid complexity value; wrap complexity sync in try/catch so failures are non-blocking.

## Proposed Changes

### src/services/KanbanProvider.ts — `_advanceSessionsInColumn` (lines 2628-2641)

**Context:** After `didAdvance` is confirmed and the column is updated in the DB (line 2637: `await db.updateColumn(sessionId, normalizedColumn)`), the complexity from the plan file must also be synced to the DB.

**Logic:**
1. After the existing `db.updateColumn(sessionId, normalizedColumn)` call on line 2637
2. Read the plan file path from the sheet: `sheet.planFile` (available from line 2600)
3. Call `this.getComplexityFromPlan(resolvedWorkspaceRoot, sheet.planFile)` to read complexity from the plan file
4. If the result is not "Unknown", call `db.updateComplexityByPlanFile(sheet.planFile, workspaceId, complexity)` to write it to the DB
5. Get `workspaceId` from `await db.getWorkspaceId() || await db.getDominantWorkspaceId() || ''`
6. Wrap the entire complexity sync block in try/catch so failure never blocks the column advance

**Implementation:**
Insert after line 2637 (`await db.updateColumn(sessionId, normalizedColumn);`), before line 2638:

```typescript
// Sync complexity from plan file to DB so the kanban label updates immediately
try {
    const planFile = sheet.planFile || updatedSheet?.planFile;
    if (planFile) {
        const complexity = await this.getComplexityFromPlan(resolvedWorkspaceRoot, planFile);
        if (complexity && complexity !== 'Unknown') {
            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
            if (workspaceId) {
                await db.updateComplexityByPlanFile(planFile, workspaceId, complexity);
            }
        }
    }
} catch { /* complexity sync failure must not block column advance */ }
```

**Edge Cases:**
- If `sheet.planFile` is empty or undefined, skip complexity sync (no regression — DB retains existing value)
- If `getComplexityFromPlan` returns "Unknown", skip the DB write to avoid overwriting a valid existing value
- If `workspaceId` is empty, skip the DB write (the `updateComplexityByPlanFile` method requires it)
- If the plan file doesn't exist on disk, `getComplexityFromPlan` returns "Unknown" and we skip — safe

### src/services/KanbanProvider.ts — `moveCardForward` (lines 3944-3956) — Optional Follow-up

**Context:** When a user manually drags a card forward, the DB column is updated but complexity is not synced from the plan file. This is a secondary concern because the plan file complexity typically doesn't change during a manual drag — it only changes when the planner agent writes to the plan file.

**Logic (if implemented):**
1. After `db.updateColumn(sid, targetColumn)` on line 3952
2. Look up the plan record: `const plan = await db.getPlanBySessionId(sid)`
3. If plan has a `planFile`, call `this.getComplexityFromPlan(workspaceRoot, plan.planFile)`
4. If complexity is not "Unknown", call `db.updateComplexityByPlanFile(plan.planFile, plan.workspaceId, complexity)`
5. Wrap in try/catch

**Note:** This is lower priority because it adds 2-3 extra async operations per card in a batch move (DB lookup + file read + DB write). Defer unless the user specifically needs it.

## Verification Plan

### Automated Tests
- **Unit test:** Create a test that calls `_advanceSessionsInColumn` with a session whose plan file has a complexity of "7" in the `## Metadata` section. Verify that after the advance, `db.getPlanBySessionId(sessionId).complexity` returns "7" (not "Unknown").
- **Regression test:** Create a test where the plan file has no complexity metadata (returns "Unknown" from `getComplexityFromPlan`). Verify that the existing DB complexity is NOT overwritten — i.e., if DB had "5", it should still be "5" after the advance.
- **Error resilience test:** Create a test where the plan file is temporarily unreadable during `_advanceSessionsInColumn`. Verify that the column advance still succeeds and the DB complexity is unchanged.

### Manual Verification
1. Create a plan in the CREATED column with complexity "Unknown" in the DB
2. Run the planner agent on the plan, which writes complexity "5" to the plan file
3. Advance the plan to PLAN REVIEWED via the batch planner button
4. Verify the complexity label on the kanban card immediately shows "5" without requiring a manual ticket save

## Open Questions
- None

## Review & Execution Pass

### 🔍 Stage 1 (Grumpy Principal Engineer Findings)
> [!NOTE]
> **Adversarial Audit: Grumpy Principal Engineer Review**
> 
> *   **`moveCardForward` Sync Bypass** [MAJOR]: The plan notes that manual drag-and-drop complexity sync via `moveCardForward` is "lower priority" and deferred. While dragging a card manually doesn't *typically* change its complexity, a developer might manually edit the plan file complexity on disk and expect a simple drag-and-drop action to sync it. Skipping this leaves a minor feature gap.
> *   **Disk I/O Concurrency Overhead** [NIT]: Reading files from disk asynchronously inside `_advanceSessionsInColumn` is fine for isolated cards, but could cause minor overhead in heavily automated batch scenarios. We wrap it in a `try/catch`, which is defensive, but it is a potential performance hot-spot under high load.
> *   **Silent Catch Ignored** [NIT]: Catching all exceptions with an empty `catch` block (as originally drafted in the plan) is a classic anti-pattern. Swallowing the error without logging makes debugging extremely difficult. (Fortunately, the actual implemented code resolved this by adding a proper log statement).

### ⚖️ Stage 2 (Balanced Synthesis)
*   **Manual Drag-and-Drop Sync:** We will defer the `moveCardForward` follow-up as initially planned because the manual edit-on-disk use case is extremely rare and can already be resolved via manual ticket save or next auto-run.
*   **Error Handling:** The implemented catch block correctly logs using `console.error('[KanbanProvider] Failed to sync complexity during column advance:', err)`. This is production-grade.
*   **No Code Fixes Required:** The core implementation in `_advanceSessionsInColumn` matches the plan perfectly, has robust checks against overwriting with "Unknown", and is fully validated by our unit and regression tests.

### 🛡️ Verification Phase
The codebase was compiled, and the test suite was executed via `npx vscode-test`.
*   **Files Changed:**
    *   `src/services/KanbanProvider.ts`
    *   `src/test/kanban-complexity.test.ts`
*   **Test Results:** All tests passed successfully:
    ```
    Kanban complexity parsing
      ✔ treats Complex heading with None as Low complexity (backward compat: Band B format)
      ✔ treats plan as Low complexity even if "Complex" is mentioned in Routine text
      ✔ treats substantive Complex tasks as High complexity
      ✔ _columnToRole maps INTERN CODED to intern
      ✔ _columnToRole maps ACCEPTANCE TESTED to tester
      ✔ treats plan with no blank lines after headings correctly as 3
      ✔ treats plan with plain text under subsections correctly as 3
      ✔ treats plan with mixed bullets correctly as 3
      ✔ sync complexity from plan file to DB during _advanceSessionsInColumn
      ✔ does NOT overwrite valid complexity in DB with "Unknown" if the file is unparseable or missing
    ```
*   **Remaining Risks:**
    *   Stale `workspaceId` if the workspace root changes dynamically between operations, though extremely unlikely given standard VS Code workspace lifecycles.

**ACCURACY VERIFICATION COMPLETE**
