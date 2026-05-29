# Add SQL Column Update Instruction to Antigravity Automation Prompt

## Goal
When the antigravity automation feature is used in kanban.html, the prompt supplied to antigravity must include an instruction for the agent to use SQL to update the plan column in the kanban database to the appropriate next column after it has finished coding. This ensures switchboard knows when antigravity completes a plan and can move it forward in the workflow.

## Metadata
- **Tags:** backend, workflow, database
- **Complexity:** 3

## User Review Required

> [!IMPORTANT]
> The original goal hardcoded the target column as `'CODED'`. After code review, `'CODED'` is a valid but non-standard column (most roles advance to `LEAD CODED`, `CODER CODED`, etc.). The plan now uses `_getNextColumnId(column, workspaceRoot)` to dynamically compute the correct target column. **Confirm**: should the SQL always target `'CODED'` (a specific custom staging column), or should it use the role-appropriate next column? If `'CODED'` is intentional for this antigravity flow specifically, the coder should hardcode it rather than calling `_getNextColumnId`.

## Complexity Audit

### Routine
- Adding a post-completion instruction to the prompt template via string concatenation
- `KanbanDatabase` already exposes `db.dbPath` (public getter at line 1001) — no new method needed
- The SQL statement is a simple UPDATE query — pattern exists throughout the codebase
- No database schema changes required
- No new API endpoints needed
- Insertion point is a single line change at `KanbanProvider.ts:2601`

### Complex / Risky
- **Wrong insertion point** in the original plan — actual `buildKanbanBatchPrompt` call for the antigravity path is at line ~2601, not line ~2359. The method at ~2359 is a preview-only path (`_getDefaultPromptPreviews`). Only `_generateAntigravityPrompt` (line 2479) generates the real prompt.
- **Plan file path format** — post-V18 migration, `planFile` is stored as a **relative** path in the DB (e.g., `.switchboard/plans/foo.md`). The SQL `WHERE plan_file = '...'` must use the relative path, not the absolute path.
- **Hardcoded `'CODED'` column** — may be wrong for non-coder roles. Use `_getNextColumnId` or confirm the column is always `'CODED'` for this flow.
- **Scheduling block interaction** — the existing `schedulingBlock` already says "move the plan to the next column in the pipeline." The SQL instruction supplements this with a concrete command; the coder should note in the instruction text that the SQL UPDATE is the mechanism for that move.

## Edge-Case & Dependency Audit

- **Race Conditions**: None — this is a one-time instruction executed after the agent completes coding. The agent is single-threaded relative to this plan.
- **Security**: UPDATE only, no DELETE/DROP. The agent is trusted (antigravity system). Database path is provided by switchboard, not user input.
- **Side Effects**: The UPDATE changes the plan's `kanban_column`, which triggers switchboard's kanban refresh and integration sync (existing behavior — identical to a manual column move).
- **Dependencies & Conflicts**: Depends on the kanban DB path being accessible to the antigravity agent (reasonable for a local system). No conflict with existing automation rules.
- **Silent failure (0 rows)**: If the agent passes the wrong `plan_file` path format (absolute vs. relative), the UPDATE hits 0 rows with no error. Add a `SELECT changes()` check instruction so the agent can verify 1 row was affected.
- **`columnPlans` sort order**: `getPlansByColumn` sorts `ORDER BY updated_at DESC`, so `columnPlans[columnPlans.length - 1]` is the oldest plan by `updated_at` (a reasonable proxy for oldest-to-process). This is an existing codebase convention; no change needed.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) wrong plan file path format (absolute vs. relative) silently produces a 0-row UPDATE — mitigate by instructing the agent to run `SELECT changes()` after the UPDATE and verify it returns 1; (2) hardcoded `'CODED'` column may be wrong for the actual role — mitigate by using `_getNextColumnId` or confirming the column is intentionally fixed to `'CODED'` for this antigravity flow; (3) the original plan referenced the wrong insertion point (preview path vs. real prompt path) — corrected to line 2601.

## Proposed Changes

### 1. Add SQL Update Instruction to Antigravity Prompt

**File:** [`src/services/KanbanProvider.ts`](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

**Method:** `_generateAntigravityPrompt` (line 2479)

**Insertion point:** Line 2601 — after `prompt = preamble + schedulingBlock` is assembled, append the SQL instruction.

**Context (actual current code, lines 2596–2607):**
```typescript
// Build the role-configuration preamble, then strip the trailing empty
// "PLANS TO PROCESS:" section (produced when plans=[] — it's replaced
// by the scheduling block below and would be contradictory noise).
let preamble = buildKanbanBatchPrompt(role, [], options);
preamble = preamble.replace(/\n*PLANS TO PROCESS:\n?\s*$/, '').trimEnd();
prompt = preamble + schedulingBlock;
```

**Modified code:**
```typescript
// Build the role-configuration preamble, then strip the trailing empty
// "PLANS TO PROCESS:" section (produced when plans=[] — it's replaced
// by the scheduling block below and would be contradictory noise).
let preamble = buildKanbanBatchPrompt(role, [], options);
preamble = preamble.replace(/\n*PLANS TO PROCESS:\n?\s*$/, '').trimEnd();
prompt = preamble + schedulingBlock;

// Append SQL update instruction so the agent can move the plan forward
// in the kanban DB after completing the work.
// NOTE: plan_file is stored as a RELATIVE path post-V18 (e.g. '.switchboard/plans/foo.md').
// NOTE: If 'CODED' should always be the target column for this flow regardless of role,
//       replace `nextColumn` with the string literal 'CODED'.
const nextColumn = await this._getNextColumnId(column, workspaceRoot) ?? 'CODED';
const oldestPlan = columnPlans[columnPlans.length - 1]; // oldest by updated_at
const sqlInstruction = `

---

**IMPORTANT: After completing the coding work for this plan, update the kanban database to move it to the next column.**

Run the following command (uses the sqlite3 CLI — it must be installed):

\`\`\`bash
sqlite3 "${db.dbPath}" "UPDATE plans SET kanban_column = '${nextColumn}', updated_at = datetime('now') WHERE plan_file = '${oldestPlan.planFile}' AND workspace_id = '${workspaceId}'; SELECT changes();"
\`\`\`

Verify that the output is \`1\` (one row updated). If it is \`0\`, the plan_file path may not match — check the DB with:

\`\`\`bash
sqlite3 "${db.dbPath}" "SELECT plan_file, kanban_column FROM plans WHERE workspace_id = '${workspaceId}';"
\`\`\`

Database: \`${db.dbPath}\`
Target column: \`${nextColumn}\`

This step is what moves the plan forward in the Switchboard pipeline.
`;
prompt = prompt + sqlInstruction;
```

**Key implementation notes:**
- `db` is already in scope (line 2491: `const db = this._getKanbanDb(workspaceRoot)`)
- `workspaceId` is already in scope (line 2501–2503)
- `columnPlans` is already in scope (line 2515: `const columnPlans = await db.getPlansByColumn(workspaceId, column)`)
- `column` is the method parameter (source column, e.g., `'CREATED'`)
- `db.dbPath` is the **existing public getter** on `KanbanDatabase` (line 1001 in `KanbanDatabase.ts`) — **no new method needed**
- The `sqlInstruction` must be added inside the `else` block (line 2558) that handles non-`custom_agent_*` roles, after `prompt = preamble + schedulingBlock` (line 2601)
- For `custom_agent_*` roles (line 2557), append the same `sqlInstruction` after `prompt = \`Please process plans as a custom agent.${schedulingBlock}\``

### ~~2. Add Database Path Getter Method~~ (SKIP — already exists)

**`KanbanDatabase.ts` already has:**
```typescript
public get dbPath(): string {  // line 1001
    return this._dbPath;
}
```

No changes needed to `KanbanDatabase.ts`.

## Verification Plan

### Automated Tests
- No automated tests are proposed for this prompt modification. Manual verification is required.

### Manual Testing Steps
1. Open the kanban webview
2. Navigate to the Automation tab
3. Ensure there is at least one plan in the source column (`CREATED` or `PLAN REVIEWED`)
4. Select an agent from the antigravity automation dropdown
5. Click the **"COPY PROMPT"** button
6. Paste the prompt and verify it includes the SQL update instruction at the end
7. Verify the SQL instruction includes:
   - The correct `sqlite3` command with the full DB path
   - The `plan_file` value filled with the actual relative plan file path (e.g., `.switchboard/plans/foo.md`)
   - The `workspace_id` filled with the actual workspace ID
   - The `nextColumn` value (should be `LEAD CODED`, `CODER CODED`, etc. depending on role — or `CODED` if intentionally fixed)
   - A `SELECT changes()` verification step
8. (Optional) Run the generated SQL command manually against the DB and verify 1 row is updated
9. After antigravity completes, refresh the kanban board and verify the plan has moved to the expected column
10. Verify `updated_at` has been updated on the plan row

## Notes
- The SQL instruction uses the `sqlite3` CLI (not the VS Code `sql.js` in-process driver). The agent must have `sqlite3` installed and accessible in PATH. This is a reasonable assumption for local automation.
- `plan_file` is stored as a relative path post-V18 migration (e.g., `.switchboard/plans/foo.md`). The SQL WHERE clause must use this relative form.
- The instruction is appended after the scheduling block so it integrates with the existing per-run workflow description.
- The `SELECT changes()` check is the simplest way for the agent to detect a 0-row UPDATE without requiring a separate query.

## Alternative Approaches Considered

### Alternative 1: API Endpoint for Column Update
Instead of including SQL in the prompt, create a new Switchboard API endpoint that antigravity can call to update the column.

**Pros:**
- No need for antigravity to have direct database access
- More secure (no raw SQL execution)
- Better error handling and logging

**Cons:**
- Requires new API endpoint implementation
- Requires antigravity to be configured with the API endpoint URL
- More complex integration

**Decision:** Not chosen because it requires more infrastructure changes. The SQL instruction approach is simpler and assumes antigravity has file system access (reasonable for a local automation system).

### Alternative 2: Polling for Plan Completion
Have Switchboard poll the plan file for completion markers or timestamps.

**Pros:**
- No changes to antigravity prompt needed
- Works even if antigravity doesn't execute the SQL

**Cons:**
- Adds polling overhead
- May have delays in detecting completion
- Requires defining a clear completion marker

**Decision:** Not chosen because it's less reliable and adds unnecessary polling. The SQL instruction provides explicit feedback when the agent completes the work.

### Alternative 3: Options object parameter to `buildKanbanBatchPrompt`
Pass the SQL instruction as a `postCompletionSqlInstruction` option.

**Decision:** Not viable — `buildKanbanBatchPrompt` has no such option and adding one would require touching the prompt builder. String concatenation is simpler and sufficient.

## Recommendation
Complexity 3 → **Send to Coder**
