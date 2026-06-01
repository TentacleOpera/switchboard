# Fix Splitter Agent New Files Default to Planned Column

## Goal
Fix the bug where new plan files created by the splitter agent always appear in the New (CREATED) column instead of the Planned (PLAN REVIEWED) column, requiring manual dragging.

## Metadata
- **Created**: 2026-05-29
- **Complexity**: 3
- **Status**: active
- **Tags**: bugfix, UI
- **Dependencies**: None

## User Review Required
- Confirm that the SQL UPDATE approach (rather than a metadata-based approach) is preferred. Note: the metadata approach is currently broken for multi-word column names — `parsePlanMetadata` uses the regex `/kanbanColumn[:\s]+(\w+)/i` which only matches single words and cannot capture "PLAN REVIEWED".
- Confirm the exact relative path format the planner agent should use (workspace-root-relative, e.g., `.switchboard/plans/my_plan.md`).
- Review whether a verification step (confirming `changes() > 0` after the UPDATE) should be added to the splitter prompt, or whether silent failure with manual-drag fallback is acceptable.

## Complexity Audit

**Manual Complexity Override:** 3


### Routine
- Single-file change: only `src/services/agentPromptBuilder.ts`
- Prompt string update — no logic, no type changes
- Uses existing SQL UPDATE access that planner agents already have
- Two symmetric changes (complexity-scoring variant + non-complexity-scoring variant)

### Complex / Risky
- None.



## Edge-Case & Dependency Audit

### Race Conditions
- **Watcher vs. SQL UPDATE**: `GlobalPlanWatcherService` may detect and register the new file with `kanban_column = 'CREATED'` before the agent runs the SQL UPDATE. This is not fatal — the UPDATE overwrites the column value afterward — but the board UI may briefly flash the card in "New" before it moves. Mitigated by instructing the agent to run the UPDATE immediately per-file.
- **UPDATE before INSERT**: If the agent writes the file and immediately runs the UPDATE before the watcher's debounce fires and INSERTs the row, the UPDATE will silently match 0 rows. The watcher debounce is typically ~300ms–1s; agent execution is usually slower, so this is unlikely but possible. The prompt should include a check.

### Security
- No security implications. The planner agent already has full SQL access to the kanban database per established protocol.

### Side Effects
- The `_routine.md` companion file will also be registered in `CREATED` first; the prompt must instruct the agent to UPDATE both files, not just the complex one.
- Manual drag instructions to `Lead Coder` and `Coder` columns remain in place and continue working — the UPDATE only moves files to `PLAN REVIEWED`, not to coder columns.

### Dependencies & Conflicts
- No conflicts with existing kanban operations.
- The `SPLIT_PLAN_DIRECTIVE` (line 225 of `agentPromptBuilder.ts`) is a shared constant used both by the standalone splitter role and the planner role (when `splitPlan: true`). The STEP 3 instructions live only in the splitter role block (lines 884–901) and do **not** affect the planner role's use of `SPLIT_PLAN_DIRECTIVE`, so no cross-role impact.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Silent 0-row SQL UPDATE if the file isn't yet registered when the UPDATE runs (timing), and (2) incorrect path format in the `WHERE plan_file` clause causing no-op. Mitigations: instruct the agent to run the UPDATE immediately per-file (not batched), specify the workspace-root-relative path format explicitly in the prompt, and include a verification check (e.g., a `SELECT` confirmation or `changes()` assertion) so the agent can notify the user if the UPDATE failed rather than silently proceeding. **Send to Coder.**

## Bug Description
When using the splitter agent planner add-on to divide a plan into multiple phases and plan files, the newly created files always appear in the New (CREATED) column. The user must manually drag them to the Planned (PLAN REVIEWED) column before proceeding with the workflow.

## Root Cause
The splitter agent prompt in `src/services/agentPromptBuilder.ts` (lines 864-901) instructs the agent to create new plan files but does not specify the target kanban column. When the file system watcher detects the new files, `_handlePlanCreation` in `GlobalPlanWatcherService.ts` automatically registers them with the default column `CREATED` (New) as per the pattern `kanbanColumn: metadata.kanbanColumn || 'CREATED'` (line 430).

The current prompt instructs:
- "Manually drag the original file (Complex) to the Lead Coder column"
- "Manually drag the _routine.md file to the Coder column"

This assumes the files start in the New column, but the user workflow expects them to start in the Planned column for proper planning workflow.

**Note on metadata-based alternative**: Writing `kanbanColumn: PLAN REVIEWED` into the plan file's `## Metadata` section does NOT work with the current parser. The regex in `parsePlanMetadata` (`/kanbanColumn[:\s]+(\w+)/i`) uses `\w+` which only matches a single word — it would capture only "PLAN" and not "PLAN REVIEWED". SQL UPDATE is therefore the only viable fix without additional parser changes.

**Important**: The SQL UPDATE prohibition in `query_switchboard_kanban.md` applies specifically to **execution agents**. The planner/splitter agent has full SQL access including UPDATE operations on the kanban database.

## Proposed Changes

### `src/services/agentPromptBuilder.ts` — Update splitter agent STEP 3 (complexity-scoring variant, lines 884-889)

**Context**: Lines 884-889 contain the dispatch instructions for the complexity-scoring variant of the splitter agent prompt. They currently instruct the user to manually drag files into coder columns without first placing them in the Planned column.

**Logic**: Update STEP 3 to instruct the agent to:
1. Read workspace ID and DB path from `.switchboard/workspace-id` (line 1 = workspace ID, line 2 = DB path; fallback to `.switchboard/kanban.db` if line 2 is empty)
2. Immediately after creating each file, run `sqlite3 <db_path> "UPDATE plans SET kanban_column = 'PLAN REVIEWED' WHERE plan_file = '<workspace-root-relative-path>' AND workspace_id = '<workspace_id>';"` — run this per-file, not batched
3. Verify the UPDATE matched at least one row (e.g., run `sqlite3 <db_path> "SELECT changes();"` and confirm output is `1`; if `0`, notify the user to manually drag the card to the Planned column)
4. Proceed with the existing manual drag instructions to Lead Coder and Coder columns

**Path format**: The `plan_file` column stores paths relative to the workspace root, e.g., `.switchboard/plans/my_plan_routine.md`. The agent must use this format, not an absolute path.

**Implementation** (replace lines 884-889):

```typescript
STEP 3: Dispatch Instructions (for the USER, not automated)
After creating both files:
1. For each new file (both the complex original and the _routine.md companion), immediately after creation:
   a. Read workspace config:
      WORKSPACE_ID=$(head -n 1 .switchboard/workspace-id)
      DB_PATH=$(head -n 2 .switchboard/workspace-id | tail -n 1)
      [ -z "$DB_PATH" ] && DB_PATH=".switchboard/kanban.db"
   b. Run SQL UPDATE using the workspace-root-relative path:
      sqlite3 "$DB_PATH" "UPDATE plans SET kanban_column = 'PLAN REVIEWED' WHERE plan_file = '<relative_path>' AND workspace_id = '$WORKSPACE_ID';"
   c. Verify: sqlite3 "$DB_PATH" "SELECT changes();"
      - If output is 1: success (card moved to Planned column)
      - If output is 0: the file may not be registered yet; notify the user to manually drag the card to the Planned column
2. Manually drag the original file (Complex) to the Lead Coder column
3. Manually drag the _routine.md file to the Coder column

Create both files in the same directory as the original plan.
```

**Specific change**: `src/services/agentPromptBuilder.ts` lines 884-889 (complexity-scoring variant)

---

### `src/services/agentPromptBuilder.ts` — Update splitter agent STEP 2 (non-complexity-scoring variant, lines 896-901)

**Context**: Lines 896-901 contain the dispatch instructions for the non-complexity-scoring variant. Same issue and same fix as above.

**Implementation** (replace lines 896-901):

```typescript
STEP 2: Dispatch Instructions (for the USER, not automated)
After creating both files:
1. For each new file (both the complex original and the _routine.md companion), immediately after creation:
   a. Read workspace config:
      WORKSPACE_ID=$(head -n 1 .switchboard/workspace-id)
      DB_PATH=$(head -n 2 .switchboard/workspace-id | tail -n 1)
      [ -z "$DB_PATH" ] && DB_PATH=".switchboard/kanban.db"
   b. Run SQL UPDATE using the workspace-root-relative path:
      sqlite3 "$DB_PATH" "UPDATE plans SET kanban_column = 'PLAN REVIEWED' WHERE plan_file = '<relative_path>' AND workspace_id = '$WORKSPACE_ID';"
   c. Verify: sqlite3 "$DB_PATH" "SELECT changes();"
      - If output is 1: success (card moved to Planned column)
      - If output is 0: the file may not be registered yet; notify the user to manually drag the card to the Planned column
2. Manually drag the original file (Complex) to the Lead Coder column
3. Manually drag the _routine.md file to the Coder column

Create both files in the same directory as the original plan.
```

**Specific change**: `src/services/agentPromptBuilder.ts` lines 896-901 (non-complexity-scoring variant)

## Verification Plan

### Manual Verification
1. Use the splitter agent add-on on a plan in the Planned column
2. Observe the agent's output — it should print the `sqlite3` commands and confirm `changes() = 1` for each file
3. After the agent completes, verify both new files appear in the **Planned** column (not New) in the Kanban board
4. Verify the manual drag instructions to Lead Coder and Coder columns still work correctly
5. Verify that if the UPDATE returns `changes() = 0`, the agent notifies the user rather than silently continuing

### Regression Tests
- Verify existing splitter agent tests still pass (prompt-only change; no behavioral logic changes)
- No new automated tests needed

## Risks
- **Low risk overall**: Prompt-only change using existing SQL access the planner agent already has
- **Timing risk (mitigated)**: Per-file UPDATE instruction and `changes()` verification handles the race condition gracefully
- **Path format risk (mitigated)**: Explicit documentation of workspace-root-relative path format in the prompt
- **Backward compatibility**: If the SQL UPDATE fails or the agent omits it, the existing manual drag workflow still works

## Files Changed
- `src/services/agentPromptBuilder.ts` — Update splitter agent prompt STEP 3 (complexity-scoring variant) and STEP 2 (non-complexity-scoring variant) to include SQL UPDATE for setting kanban_column to 'PLAN REVIEWED'

## Review Pass (2026-06-01)

### Stage 1 — Grumpy Principal Engineer Findings

| ID | Severity | Finding |
|----|----------|---------|
| CRITICAL-1 | CRITICAL | **`SELECT changes()` in a separate `sqlite3` invocation always returns 0.** Each `sqlite3` CLI call opens a new database connection; `changes()` only reflects DML within the same connection. A fresh connection has no prior DML, so `changes()` = 0 always. Verified empirically: separate invocations → 0, combined → 1. The project's own `KanbanProvider.ts` (lines 2765, 2808) already does this correctly by combining UPDATE + SELECT changes() in a single command. The plan itself contained this bug and the implementation faithfully reproduced it. |
| MAJOR-1 | MAJOR | **Step header "for the USER, not automated" is now misleading.** The original step only contained manual drag instructions — appropriate for a "for the USER" label. After adding automated SQL commands the agent should execute, the header creates ambiguity: an agent may interpret the SQL commands as instructions to print for the user rather than execute itself, defeating the purpose of the fix. |
| NIT-1 | NIT | **`<relative_path>` placeholder is abstract.** The plan specifies "workspace-root-relative path format" in prose but the prompt just says `<relative_path>`. A concrete example (e.g., `.switchboard/plans/my_plan_routine.md`) would reduce the chance of the agent using an incorrect path format. |

### Stage 2 — Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| CRITICAL-1 | Fix now | Combine UPDATE + SELECT changes() into single `sqlite3` command, matching established pattern in `KanbanProvider.ts` |
| MAJOR-1 | Fix now | Split step into two labeled sub-sections: "Automated actions (execute these yourself)" and "Manual actions (instruct the USER to perform)" |
| NIT-1 | Fix now (trivial) | Add concrete path example inline with the SQL command |

### Fixes Applied

**`src/services/agentPromptBuilder.ts`** — Both splitter variants (complexity-scoring STEP 3, non-complexity-scoring STEP 2):

1. **CRITICAL-1 fix**: Changed from two separate `sqlite3` commands:
   ```
   sqlite3 "$DB_PATH" "UPDATE plans SET kanban_column = 'PLAN REVIEWED' WHERE plan_file = '<relative_path>' AND workspace_id = '$WORKSPACE_ID';"
   sqlite3 "$DB_PATH" "SELECT changes();"
   ```
   To a single combined command:
   ```
   sqlite3 "$DB_PATH" "UPDATE plans SET kanban_column = 'PLAN REVIEWED' WHERE plan_file = '<relative_path>' AND workspace_id = '$WORKSPACE_ID'; SELECT changes();"
   ```

2. **MAJOR-1 fix**: Changed step header from `STEP N: Dispatch Instructions (for the USER, not automated)` to `STEP N: Dispatch Instructions` with two clearly labeled sub-sections:
   - `Automated actions (execute these yourself):` — SQL UPDATE commands
   - `Manual actions (instruct the USER to perform):` — drag instructions

3. **NIT-1 fix**: Added concrete path example: `(workspace-root-relative path, e.g. .switchboard/plans/my_plan_routine.md)`

### Validation Results

- **grep sweep**: Zero instances of `for the USER, not automated` remain in `agentPromptBuilder.ts`
- **grep sweep**: Both `SELECT changes()` occurrences are now combined with UPDATE in a single `sqlite3` command (lines 962, 987)
- **grep sweep**: Zero instances of standalone `Verify: sqlite3` remain
- **Pattern consistency**: Combined UPDATE+changes() pattern matches `KanbanProvider.ts` lines 2765 and 2808
- **Compilation**: Skipped per session instructions
- **Tests**: Skipped per session instructions

### Remaining Risks

- **Low**: The `UPDATE before INSERT` race condition (agent runs UPDATE before watcher registers the file) still applies. The `changes() = 0` output now correctly detects this case and instructs the agent to notify the user. Previously, this detection was broken because `changes()` always returned 0 regardless.
- **Low**: SQL injection via file path — the agent substitutes `<relative_path>` itself, so this is not a user-input vector. File paths under `.switchboard/plans/` are typically safe characters.
- **Deferred**: `ICON_SPLITTER` reuses `ICON_28` (same as Jules). A dedicated SVG asset would improve UX distinguishability but is not blocking and is tracked separately.
