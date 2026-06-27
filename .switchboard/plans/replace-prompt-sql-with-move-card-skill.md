# Replace Raw Agent-Prompt SQL with move-card.js Skill Calls

## Goal

The Class 6 fix in the comprehensive epic plan appended a subtask-cascade UPDATE to the raw `sqlite3` commands embedded in agent prompts. This fixed the cascade for file-based plans but introduced two inherent problems that cannot be solved within the raw-SQL-in-prompt approach:

1. **Atomicity gap (Issue 3):** The epic's own UPDATE and the subtask-cascade UPDATE are two separate SQL statements inside one `sqlite3` invocation. A crash between them orphans subtasks (epic moved, subtasks not). The extension has no transaction handle because it doesn't execute the SQL — an external agent process does.

2. **`move-card.js` direct-DB fallback has the same Class 2 bug.** If we route prompt moves through `move-card.js` (the cleaner option (b) from the comprehensive plan's User Review #5), its direct-DB fallback (line 128) still calls the old session_id-keyed `updateColumnWithEpicCascade` — file-based epics with `session_id=''` silently no-op. The extension API path works (it routes through `moveCardToColumn` → `updateColumnWithEpicCascadeByPlanId`), but the fallback doesn't.

**Root cause:** The raw SQL in prompts bypasses the validated DB layer entirely. The fix is to replace the raw SQL with instructions to call `move-card.js`, which routes through the extension's API server (transactional, validated, cascading, integration-syncing) with a direct-DB fallback. But `move-card.js` itself needs to be fixed first to handle `planId`-keyed moves in its fallback.

**Background:** The comprehensive plan's User Review #5 explicitly named this as option (b): "replace the raw SQL block with an instruction to call the `kanban_operations` skill's move-card, routing the move through the validated DB layer." This plan implements that deferred option.

## Metadata

**Tags:** bugfix, backend, agent-prompts, epics, kanban-operations
**Complexity:** 5

## User Review Required

1. **Agent host skill availability.** Option (b) requires the agent host (Antigravity scheduler, Split Plan agent, lead/coder) to have access to the `kanban_operations` skill scripts and Node.js. The scripts live at `.agents/skills/kanban_operations/` in the repo, so any agent running inside the workspace has access. **Confirm** that all agent hosts that consume these prompts run inside the workspace (not in a separate container/sandbox without repo access). If any agent host runs outside the workspace, option (b) won't work for that host and a hybrid approach is needed (skill call for in-workspace agents, raw SQL fallback for external agents).

2. **Batch move via multiple `move-card.js` calls vs. a new batch script.** The scheduler batch prompt currently moves N plans in one `sqlite3` invocation. Switching to `move-card.js` means N separate `node` invocations (one per plan). Options:
   - **(a) Loop in the prompt** — instruct the agent to run `move-card.js` once per plan. Simple, reuses existing script, but N process spawns.
   - **(b) New batch script** — add `move-cards.js` that takes a JSON array of `{ planId, targetColumn }` and moves them in one process. More efficient, but new code to maintain.

   **Default below uses (a)** — simpler, and the batch sizes are small (typically 1-5 plans). Option (b) can be a follow-up if batch sizes grow.

3. **Should the raw SQL be kept as a fallback in the prompt?** If `move-card.js` fails (Node not installed, extension not running, direct-DB fallback fails), should the prompt instruct the agent to fall back to raw SQL? Options:
   - **(a) No fallback** — if `move-card.js` fails, the agent reports the error and the user moves the card manually. Cleaner, avoids the atomicity gap.
   - **(b) Keep raw SQL as fallback** — the prompt includes both the `move-card.js` call and the raw SQL, with instructions to try the skill first and fall back to SQL only if it fails. Preserves the self-contained nature but re-introduces the atomicity gap for the fallback case.

   **Default below uses (a)** — the atomicity gap is the problem we're solving; re-introducing it as a fallback defeats the purpose. The `move-card.js` script already has its own fallback (extension API → direct DB), so adding another fallback layer is unnecessary.

## Complexity Audit

### Routine
- Prompt text edits in 4 sites: replace the `sqlite3` command block with a `node .agents/skills/kanban_operations/move-card.js` call. Mechanical text change.
- `move-card.js` direct-DB fallback fix: swap `updateColumnWithEpicCascade` → `updateColumnWithEpicCascadeByPlanId` (or `cascadeEpicByPlanId` if Plan 2 is implemented first). ~5 line change.

### Complex / Risky
- **`move-card.js` takes `sessionId` as argv[2], not `planId`.** For file-based plans, `sessionId` is empty. The prompts have `planId` available (not `sessionId`). Passing `planId` as the first arg works through the extension API path (because `getPlanBySessionId` has a planId fallback), but the script's variable name and usage text say "session_id". This is a naming/documentation issue, not a functional one — but it should be clarified to avoid confusion. The script should document that the first arg can be either `sessionId` or `planId`.
- **`move-card.js` direct-DB fallback requires compiled `out/` directory.** Line 112: `require('../../../out/services/KanbanDatabase')`. If the extension hasn't been compiled (dev environment), the fallback fails with a module-not-found error. The extension API path doesn't need compilation. This is pre-existing, not introduced by this plan, but worth noting: if the extension isn't running AND `out/` doesn't exist, `move-card.js` fails entirely. The agent would report the error and the user moves the card manually.
- **Split Plan agent prompt uses `<relative_path>` placeholder.** The Split Plan prompt (agentPromptBuilder.ts:1118) uses `plan_file` in the SQL WHERE clause, not `plan_id`. The `move-card.js` script takes `sessionId`/`planId`, not `planFile`. The prompt would need to instruct the agent to look up the `planId` from the plan file, or `move-card.js` would need to accept `planFile` as an alternative key. **The cleaner approach:** `move-card.js` already accepts an optional `planFile` as argv[4] (used for `updatePlanFile`), but the primary lookup is still `sessionId`. The script should be extended to resolve a `planFile` to a `planId` when the first arg is a plan file path.

## Edge-Case & Dependency Audit

**Race Conditions**
- The extension API path (`moveCardToColumn`) still has the read-then-write race from the explicit-ID cascade (Issue 4). If Plan 2 (Atomic Race-Free Cascade) is implemented first, the extension path inherits the atomic cascade. If not, the race is pre-existing and unchanged.
- The direct-DB fallback in `move-card.js` will use `cascadeEpicByPlanId` (from Plan 2) or `updateColumnWithEpicCascadeByPlanId` (from the comprehensive fix) — both are plan_id-keyed and work for file-based plans.

**Side Effects**
- Agent prompts become dependent on Node.js and the `kanban_operations` skill scripts being present in the workspace. If the scripts are missing (e.g., the workspace predates the skill), the agent can't move cards. Mitigation: the prompt should include a clear error message instructing the user to update their workspace if `move-card.js` is not found.
- The `SELECT total_changes()` verification (from the reviewer pass fix) is removed — `move-card.js` prints `OK` or `FAILED` to stdout, which is clearer for the agent to interpret.
- Linear/ClickUp integration sync: the extension API path syncs to external trackers; the direct-DB fallback does not. This is pre-existing behavior of `move-card.js`, not a change.

**Dependencies & Conflicts**
- **Depends on the comprehensive epic fix** (already implemented) — `updateColumnWithEpicCascadeByPlanId` must exist for the `move-card.js` fallback fix.
- **Depends on Plan 2 (Atomic Race-Free Cascade) if implemented first** — `cascadeEpicByPlanId` would be the preferred method for the `move-card.js` fallback. If Plan 2 is not yet implemented, use `updateColumnWithEpicCascadeByPlanId` (from the comprehensive fix) as a stopgap.
- **Conflict with `move-card.js` line 128:** the direct-DB fallback uses the old `updateColumnWithEpicCascade` (session_id-keyed). This must be fixed in this plan.

## Adversarial Synthesis

Key risks: (1) the Split Plan agent prompt uses `plan_file` as the key, not `plan_id` — `move-card.js` needs to accept `planFile` as an alternative lookup key, or the prompt needs to instruct the agent to resolve the planId first (adding a `sqlite3 SELECT` step back into the prompt, which partially defeats the purpose); (2) the `move-card.js` direct-DB fallback requires `out/` to exist — if the extension isn't compiled, the fallback fails entirely (pre-existing, but now it's the only path if the extension isn't running); (3) agent hosts running outside the workspace can't access `.agents/skills/` — if any do, they need a hybrid prompt. Mitigations: extend `move-card.js` to accept `planFile` as a fallback key; document the `out/` requirement; confirm agent hosts run in-workspace (User Review #1).

## Proposed Changes

### `.agents/skills/kanban_operations/move-card.js`
- **Context:** Skill script for moving kanban cards. Two paths: extension API (preferred) + direct DB (fallback).
- **Logic:**
  1. **Fix direct-DB fallback (line 123-131):** replace `updateColumnWithEpicCascade` with `updateColumnWithEpicCascadeByPlanId` (or `cascadeEpicByPlanId` if Plan 2 is implemented). Use `plan.planId` and `subtasks.map(st => st.planId)` instead of `sessionId`:
     ```javascript
     const plan = await db.getPlanBySessionId(sessionId);
     let columnSuccess;
     if (plan && plan.isEpic) {
         // Use plan_id-keyed cascade (works for file-based plans with session_id='').
         // If cascadeEpicByPlanId is available (Plan 2), prefer it for race-free atomic cascade.
         const cascadeFn = db.cascadeEpicByPlanId || db.updateColumnWithEpicCascadeByPlanId;
         columnSuccess = await cascadeFn.call(db, plan.planId, targetColumn);
     } else {
         columnSuccess = await db.updateColumn(sessionId, targetColumn);
     }
     ```
  2. **Accept `planFile` as alternative key:** if the first arg looks like a file path (contains `/` or ends in `.md`), resolve it to a planId via `db.getPlanByPlanFile(planFile, workspaceId)` before proceeding. This supports the Split Plan agent prompt which has `plan_file` but not `plan_id`.
  3. **Update usage text:** document that the first arg can be `sessionId`, `planId`, or `planFile` (relative path).
- **Edge Cases:** `out/` not compiled → direct-DB fallback fails with module error; the extension API path is the only option. Pre-existing, not introduced here.

### `src/services/KanbanProvider.ts`
- **Context:** Scheduler prompt generation — batch and single-plan variants.
- **Logic:**
  1. **Batch prompt (line 3576):** replace the `sqlite3` command block with:
     ```bash
     # After completing the coding work, move each plan to the next column.
     # Uses the kanban_operations skill (routes through the extension for cascade + sync).
     for plan_id in ${batchPlans.map(p => `'${p.planId}'`).join(' ')}; do
         node .agents/skills/kanban_operations/move-card.js "$plan_id" "${resolvedNextColumn}" "" "${workspaceRoot}"
     done
     ```
     Remove the `SELECT total_changes()` verification text — `move-card.js` prints `OK`/`FAILED`.
  2. **Single-plan prompt (line 3619):** replace with:
     ```bash
     node .agents/skills/kanban_operations/move-card.js "${oldestPlan.planId}" "${resolvedNextColumn}" "" "${workspaceRoot}"
     ```
  3. **Null-next-column guard (line 3554-3568):** keep the existing guard that emits a "do NOT move" warning when `resolvedNextColumn === null`. The `sqlite3 SELECT` inspection command can stay (it's read-only and useful for debugging).
- **Edge Cases:** `move-card.js` not found → agent reports error, user moves card manually. Extension not running → `move-card.js` falls back to direct DB (works if `out/` exists).

### `src/services/agentPromptBuilder.ts`
- **Context:** Split Plan agent prompt generation.
- **Logic:**
  1. **Both Split Plan prompt sites (lines 1118, 1144):** replace the `sqlite3` command with:
     ```bash
     node .agents/skills/kanban_operations/move-card.js "<relative_path>" "PLAN REVIEWED" "" "$(pwd)"
     ```
     The `move-card.js` script resolves `<relative_path>` (a plan_file) to a planId internally (per the `move-card.js` change above). Use `"$(pwd)"` as the workspace root since the Split Plan agent runs in the workspace root.
  2. Update the verification text: "If the output is `OK`: success. If the output is `FAILED`: the file may not be registered yet; notify the user to manually drag the card to the Planned column."
- **Edge Cases:** `<relative_path>` is a plan_file, not a planId — `move-card.js` must handle this (per the `move-card.js` change above).

### `src/services/LocalApiServer.ts`
- **Context:** API server endpoint for kanban moves.
- **Logic:**
  1. **Accept `planId` as alternative to `sessionId` (line 256):** add `const planId = String(body?.planId || '').trim()` and use it as a fallback when `sessionId` is empty:
     ```typescript
     const sessionId = String(body?.sessionId || '').trim();
     const planId = String(body?.planId || '').trim();
     const effectiveKey = sessionId || planId;
     if (!effectiveKey || !targetColumn) { ... }
     const result = await moveCard(workspaceRoot, effectiveKey, targetColumn, planFile);
     ```
  2. Update the JSDoc (line 235) to document `planId` as an accepted field.
- **Edge Cases:** Both `sessionId` and `planId` provided → prefer `sessionId` (backward compat). Only `planId` → works via `getPlanBySessionId` planId fallback in `moveCardToColumn`.

## Verification Plan

> Per project conventions: skip compilation and automated tests during implementation; the user runs the suite separately.

### Manual tests
- Scheduler agent processes a file-based epic (`session_id=''`) → `move-card.js` moves the epic + cascades subtasks (extension running). Verify `OK` output.
- Scheduler agent processes a file-based epic with extension NOT running → `move-card.js` direct-DB fallback moves the epic + cascades subtasks (requires `out/` compiled). Verify `OK` output.
- Scheduler agent processes a batch of 3 plans (mixed epic + non-epic) → each plan moves via separate `move-card.js` call; epic cascades subtasks.
- Split Plan agent creates a new plan file → `move-card.js` resolves the `plan_file` to `planId` and moves the card to PLAN REVIEWED.
- `move-card.js` with invalid column → prints `FAILED`, agent reports error.
- `move-card.js` when Node.js is not installed → agent reports error, user moves card manually.
- API server: POST `/kanban/move` with `{ planId: '<planId>', targetColumn: 'COMPLETED' }` (no `sessionId`) → move succeeds.
- API server: POST `/kanban/move` with `{ sessionId: '<sessionId>', targetColumn: 'COMPLETED' }` (no `planId`) → move succeeds (backward compat).
- Verify no `sqlite3` UPDATE commands remain in agent prompts (grep for `sqlite3.*UPDATE plans SET kanban_column` in `KanbanProvider.ts` and `agentPromptBuilder.ts` — should only find read-only SELECTs in the null-next-column guard).

## Recommendation

Complexity 5 (Medium: 4 prompt text edits + `move-card.js` fallback fix + API server planId support, with the `planFile`-as-key extension being the only non-obvious part) → **Send to Coder**. The implementer should confirm User Review #1 (agent hosts run in-workspace) before proceeding. If Plan 2 (Atomic Race-Free Cascade) is implemented first, use `cascadeEpicByPlanId` in the `move-card.js` fallback; otherwise use `updateColumnWithEpicCascadeByPlanId` as a stopgap.
