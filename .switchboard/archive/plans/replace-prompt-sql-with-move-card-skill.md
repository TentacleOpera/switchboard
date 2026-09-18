# Replace Raw Agent-Prompt SQL with move-card.js Skill Calls

## Goal

The Class 6 fix in the comprehensive epic plan appended a subtask-cascade UPDATE to the raw `sqlite3` commands embedded in agent prompts. This fixed the cascade for file-based plans but introduced two inherent problems that cannot be solved within the raw-SQL-in-prompt approach:

1. **Atomicity gap (Issue 3):** The epic's own UPDATE and the subtask-cascade UPDATE are two separate SQL statements inside one `sqlite3` invocation. A crash between them orphans subtasks (epic moved, subtasks not). The extension has no transaction handle because it doesn't execute the SQL — an external agent process does.

2. **`move-card.js` direct-DB fallback is already BROKEN (calls a non-existent method).** If we route prompt moves through `move-card.js` (the cleaner option (b) from the comprehensive plan's User Review #5), its direct-DB fallback (line 128) calls `db.updateColumnWithEpicCascade(sessionId, subtaskSessionIds, targetColumn)` — **a method that does NOT EXIST** in `KanbanDatabase.ts`. The only cascade method is `updateColumnWithEpicCascadeByPlanId` (line 3826, plan_id-keyed). The fallback path throws `TypeError: db.updateColumnWithEpicCascade is not a function` every time it's hit. The extension API path works (it routes through `moveCardToColumn` at line 4873 → `updateColumnWithEpicCascadeByPlanId` at line 4897), but the fallback crashes.

**Root cause:** The raw SQL in prompts bypasses the validated DB layer entirely. The fix is to replace the raw SQL with instructions to call `move-card.js`, which routes through the extension's API server (transactional, validated, cascading, integration-syncing) with a direct-DB fallback. But `move-card.js` itself needs to be fixed first: its fallback calls a non-existent method and must be replaced with `updateColumnWithEpicCascadeByPlanId` (or `cascadeEpicByPlanId` if Plan 2 is implemented first), plus it needs planFile-to-planId resolution for the Split Plan prompt case.

**Background:** The comprehensive plan's User Review #5 explicitly named this as option (b): "replace the raw SQL block with an instruction to call the `kanban_operations` skill's move-card, routing the move through the validated DB layer." This plan implements that deferred option.

## Metadata

**Tags:** bugfix, backend, api, cli
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
- Prompt text edits in 4 sites: replace the `sqlite3` command block with a `node .agents/skills/kanban_operations/move-card.js` call. Mechanical text change. Sites verified: KanbanProvider.ts batch prompt at lines 3573-3587, single-plan prompt (same file), agentPromptBuilder.ts Split Plan prompts at lines 1118 and 1144.
- `move-card.js` direct-DB fallback fix (line 128): replace the call to non-existent `updateColumnWithEpicCascade` with `updateColumnWithEpicCascadeByPlanId` (line 3826 in KanbanDatabase.ts, plan_id-keyed) or `cascadeEpicByPlanId` if Plan 2 is implemented first. ~5 line change. This fixes a **crash** (TypeError), not just a logic bug.

### Complex / Risky
- **`move-card.js` takes `sessionId` as argv[2], not `planId`.** Verified: argv[2]=sessionId, argv[3]=targetColumn, argv[4]=optionalPlanFile, argv[5]=workspaceRoot. For file-based plans, `sessionId` is empty. The prompts have `planId` available (not `sessionId`). Passing `planId` as the first arg works through the extension API path (because `getPlanBySessionId` at line 2556 has a planId fallback at lines 2566-2575), but the script's variable name and usage text say "session_id". This is a naming/documentation issue, not a functional one — but it should be clarified to avoid confusion. The script should document that the first arg can be either `sessionId` or `planId`.
- **`move-card.js` direct-DB fallback requires compiled `out/` directory.** Verified: line 112 has `const { KanbanDatabase, VALID_KANBAN_COLUMNS } = require('../../../out/services/KanbanDatabase')`. If the extension hasn't been compiled (dev environment), the fallback fails with a module-not-found error. The extension API path doesn't need compilation. This is pre-existing, not introduced by this plan, but now it's the ONLY fallback if the extension isn't running. **Regression note:** the raw-SQL path being replaced always works (modulo atomicity); the `move-card.js` fallback sometimes doesn't work at all (no `out/`). The prompt should document the `out/` requirement and include a clear error message if `move-card.js` fails entirely.
- **Split Plan agent prompt uses `<relative_path>` placeholder.** Verified: agentPromptBuilder.ts lines 1118 and 1144 both use `plan_file = '<relative_path>'` in the SQL WHERE clause, NOT `plan_id`. The `move-card.js` script takes `sessionId`/`planId` as argv[2], not `planFile`. The script currently passes `optionalPlanFile` (argv[4]) to the API as `planFile` and calls `db.updatePlanFile(sessionId, optionalPlanFile)` in the fallback — it does NOT resolve a planFile to a planId. **Required fix:** `move-card.js` must detect when argv[2] is a plan file path (contains `/` or ends in `.md`), resolve it to a planId via `db.getPlanByPlanFile(planFile, workspaceId)` (exists at KanbanDatabase.ts line 2669) BEFORE the cascade lookup, then use the resolved planId for the cascade call. This resolution must happen in BOTH the API path (pass planId instead of sessionId) and the fallback path (use `getPlanByPlanFile` not `getPlanBySessionId`).

## Edge-Case & Dependency Audit

**Race Conditions**
- The extension API path (`moveCardToColumn`) still has the read-then-write race from the explicit-ID cascade (Issue 4). If Plan 2 (Atomic Race-Free Cascade) is implemented first, the extension path inherits the atomic cascade. If not, the race is pre-existing and unchanged.
- The direct-DB fallback in `move-card.js` will use `cascadeEpicByPlanId` (from Plan 2) or `updateColumnWithEpicCascadeByPlanId` (from the comprehensive fix) — both are plan_id-keyed and work for file-based plans.

**Side Effects**
- Agent prompts become dependent on Node.js and the `kanban_operations` skill scripts being present in the workspace. If the scripts are missing (e.g., the workspace predates the skill), the agent can't move cards. Mitigation: the prompt should include a clear error message instructing the user to update their workspace if `move-card.js` is not found.
- The `SELECT total_changes()` verification (from the reviewer pass fix) is removed — `move-card.js` prints `OK` or `FAILED` to stdout, which is clearer for the agent to interpret.
- Linear/ClickUp integration sync: the extension API path syncs to external trackers; the direct-DB fallback does not. This is pre-existing behavior of `move-card.js`, not a change.

**Dependencies & Conflicts**
- **Depends on the comprehensive epic fix** (already implemented) — `updateColumnWithEpicCascadeByPlanId` (KanbanDatabase.ts line 3826) must exist for the `move-card.js` fallback fix. Verified: exists.
- **Depends on Plan 2 (Atomic Race-Free Cascade) if implemented first** — `cascadeEpicByPlanId` would be the preferred method for the `move-card.js` fallback. If Plan 2 is not yet implemented, use `updateColumnWithEpicCascadeByPlanId` (from the comprehensive fix) as a stopgap. **Reviewer update 2026-06-28:** `cascadeEpicByPlanId` now EXISTS (KanbanDatabase.ts:3877, commit 957df2a) and is the active cascade method used by `move-card.js`.
- **Conflict with `move-card.js` line 128:** the direct-DB fallback calls `updateColumnWithEpicCascade` — a method that does NOT EXIST in KanbanDatabase.ts. This is a crash (TypeError), not just a logic bug. This must be fixed in this plan.

## Dependencies

- **Comprehensive Epic Fix** (already implemented) — provides `updateColumnWithEpicCascadeByPlanId` (KanbanDatabase.ts line 3826) and the Class 6 agent-prompt subtask-cascade SQL that this plan replaces.
- **Atomic Race-Free Cascade plan** (if implemented first) — provides `cascadeEpicByPlanId` (atomic, race-free, optional status cascade) which is the preferred method for the `move-card.js` fallback. If not yet implemented, use `updateColumnWithEpicCascadeByPlanId` as a stopgap.
- **Recommended implementation order:** Plan 2 (Atomic Cascade) → Plan 1 (this plan) → Plan 3 (Notion Restore). This ensures `cascadeEpicByPlanId` is available for both this plan and Plan 3.

## Adversarial Synthesis

Key risks: (1) the `move-card.js` fallback at line 128 calls `updateColumnWithEpicCascade` — a method that does NOT EXIST; this is a crash (TypeError), not a "silent no-op" as the original plan framed it — the fix replaces a broken call with `updateColumnWithEpicCascadeByPlanId` (line 3826) or `cascadeEpicByPlanId` (Plan 2); (2) the Split Plan prompt uses `plan_file` as the key — `move-card.js` must detect plan-file-as-argv[2] and resolve via `getPlanByPlanFile` (line 2669) BEFORE the cascade lookup, in both the API and fallback paths; (3) the `out/` compilation requirement means the fallback fails entirely in uncompiled dev environments — this is a regression from raw-SQL (which always worked); mitigate by documenting the requirement in the prompt and keeping a clear error path. Mitigations: reorder the planFile resolution before the cascade lookup; document `out/` requirement; confirm agent hosts run in-workspace (User Review #1); verify whether `getPlanBySessionId`'s planId fallback already handles planId-as-sessionId in the API path (may make the LocalApiServer `planId` field a clarity-only change).

## Proposed Changes

### `.agents/skills/kanban_operations/move-card.js`
- **Context:** Skill script for moving kanban cards (161 lines). Two paths: extension API (preferred) + direct DB (fallback). Verified argv: [2]=sessionId/planId/planFile, [3]=targetColumn, [4]=optionalPlanFile, [5]=workspaceRoot.
- **Logic:**
  1. **Resolve planFile to planId FIRST (new step, before any cascade lookup):** if argv[2] looks like a file path (contains `/` or ends in `.md`), resolve it to a planId:
     ```javascript
     let effectiveKey = process.argv[2]; // sessionId, planId, or planFile
     let resolvedPlanFile = optionalPlanFile;
     if (effectiveKey.includes('/') || effectiveKey.endsWith('.md')) {
         // It's a plan file path — resolve to planId for both API and fallback paths.
         // In the fallback path, use db.getPlanByPlanFile(planFile, workspaceId) (KanbanDatabase.ts line 2669).
         // In the API path, pass the resolved planId as the key (or pass planFile in the planFile field).
         resolvedPlanFile = effectiveKey;
         // effectiveKey will be resolved to planId inside the fallback (see step 2).
     }
     ```
  2. **Fix direct-DB fallback (line 128):** replace the call to non-existent `updateColumnWithEpicCascade` with `updateColumnWithEpicCascadeByPlanId` (or `cascadeEpicByPlanId` if Plan 2 is implemented). If the key was a planFile, resolve via `getPlanByPlanFile` first:
     ```javascript
     // Resolve the plan: use getPlanByPlanFile if the key is a file path, else getPlanBySessionId.
     let plan;
     if (resolvedPlanFile) {
         plan = await db.getPlanByPlanFile(resolvedPlanFile, workspaceRoot);
     } else {
         plan = await db.getPlanBySessionId(effectiveKey);
     }
     let columnSuccess;
     if (plan && plan.isEpic) {
         // Use plan_id-keyed cascade (works for file-based plans with session_id='').
         // If cascadeEpicByPlanId is available (Plan 2), prefer it for race-free atomic cascade.
         const cascadeFn = db.cascadeEpicByPlanId || db.updateColumnWithEpicCascadeByPlanId;
         columnSuccess = await cascadeFn.call(db, plan.planId, targetColumn);
     } else {
         columnSuccess = await db.updateColumn(plan ? plan.sessionId : effectiveKey, targetColumn);
     }
     ```
  3. **Update usage text:** document that the first arg (argv[2]) can be `sessionId`, `planId`, or `planFile` (relative path). When a planFile is passed, the script resolves it to a planId internally.
- **Edge Cases:** `out/` not compiled → `require('../../../out/services/KanbanDatabase')` at line 112 fails with module error; the extension API path is the only option. This is a regression from raw-SQL (which always worked) — the prompt should document this and include a clear error message. `getPlanByPlanFile` returns null for unregistered plan files → script prints `FAILED`, agent notifies user to manually drag the card.

### `src/services/KanbanProvider.ts`
- **Context:** Scheduler prompt generation — batch and single-plan variants. Verified: batch prompt with raw `sqlite3` UPDATE at lines 3573-3587, null-next-column guard at lines 3554-3568, `batchPlans = columnPlans.slice(-batchSize)` at line 3548.
- **Logic:**
  1. **Batch prompt (lines 3573-3587):** replace the `sqlite3` command block (which contains two UPDATEs + `SELECT total_changes()`) with:
     ```bash
     # After completing the coding work, move each plan to the next column.
     # Uses the kanban_operations skill (routes through the extension for cascade + sync).
     for plan_id in ${batchPlans.map(p => `'${p.planId}'`).join(' ')}; do
         node .agents/skills/kanban_operations/move-card.js "$plan_id" "${resolvedNextColumn}" "" "${workspaceRoot}"
     done
     ```
     Remove the `SELECT total_changes()` verification text — `move-card.js` prints `OK`/`FAILED` (verified at lines 146/150/156).
  2. **Single-plan prompt (in the same scheduler prompt builder):** replace the `sqlite3` command with:
     ```bash
     node .agents/skills/kanban_operations/move-card.js "${oldestPlan.planId}" "${resolvedNextColumn}" "" "${workspaceRoot}"
     ```
  3. **Null-next-column guard (lines 3554-3568):** keep the existing guard that emits a "do NOT move" warning when `resolvedNextColumn === null`. The `sqlite3 SELECT` inspection command can stay (it's read-only and useful for debugging).
- **Edge Cases:** `move-card.js` not found → agent reports error, user moves card manually. Extension not running → `move-card.js` falls back to direct DB (works if `out/` exists; fails if not — document this in the prompt).

### `src/services/agentPromptBuilder.ts`
- **Context:** Split Plan agent prompt generation. Verified: both prompt sites at lines 1118 and 1144 use `plan_file = '<relative_path>'` in the SQL WHERE clause (NOT `plan_id`), with raw `sqlite3` UPDATE + `SELECT total_changes()`.
- **Logic:**
  1. **Both Split Plan prompt sites (lines 1118, 1144):** replace the `sqlite3` command with:
     ```bash
     node .agents/skills/kanban_operations/move-card.js "<relative_path>" "PLAN REVIEWED" "" "$(pwd)"
     ```
     The `move-card.js` script detects that `<relative_path>` is a plan file path (contains `/` or ends in `.md`), resolves it to a planId via `getPlanByPlanFile` (per the `move-card.js` change above, step 1). Use `"$(pwd)"` as the workspace root since the Split Plan agent runs in the workspace root.
  2. Update the verification text: "If the output is `OK`: success. If the output is `FAILED`: the file may not be registered yet; notify the user to manually drag the card to the Planned column."
- **Edge Cases:** `<relative_path>` is a plan_file, not a planId — `move-card.js` must handle this via `getPlanByPlanFile` resolution (per the `move-card.js` change above). If the plan file is not yet registered in the DB, `getPlanByPlanFile` returns null → script prints `FAILED`.

### `src/services/LocalApiServer.ts`
- **Context:** API server endpoint for kanban moves. Verified: JSDoc at line 230, handler `_handleKanbanMove` at line 237, body parsing at lines 256-259 reads `sessionId`, `targetColumn`, `workspaceRoot`, `planFile` (does NOT currently accept `planId`).
- **Logic:**
  1. **Accept `planId` as alternative to `sessionId` (lines 256-259):** add `const planId = String(body?.planId || '').trim()` and use it as a fallback when `sessionId` is empty:
     ```typescript
     const sessionId = String(body?.sessionId || '').trim();
     const planId = String(body?.planId || '').trim();
     const effectiveKey = sessionId || planId;
     if (!effectiveKey || !targetColumn) { ... }
     const result = await moveCard(workspaceRoot, effectiveKey, targetColumn, planFile);
     ```
  2. Update the JSDoc (line 230) to document `planId` as an accepted field.
  3. **Verification note:** `getPlanBySessionId` (KanbanDatabase.ts line 2556) already has a planId fallback at lines 2566-2575 — it tries session_id first, then falls back to plan_id lookup. This means passing a planId in the existing `sessionId` field may already work through the API path. The explicit `planId` field is primarily a **clarity/documentation improvement**, not a functional necessity. The implementer should verify whether `moveCard` → `moveCardToColumn` → `getPlanBySessionId` already handles planId-as-sessionId before deciding whether the new field is strictly needed.
- **Edge Cases:** Both `sessionId` and `planId` provided → prefer `sessionId` (backward compat). Only `planId` → works via `getPlanBySessionId` planId fallback in `moveCardToColumn`.

## Reviewer Pass — 2026-06-28

### Findings (Grumpy → Balanced)

| # | Severity | File:Line | Finding | Fix Applied |
|---|----------|-----------|---------|-------------|
| 1 | CRITICAL | `move-card.js:130` | `getPlanByPlanFile(resolvedPlanFile, workspaceRoot)` passes the filesystem root path as `workspaceId`, but `workspace_id` in the DB is a UUID (e.g. `038bffef-…`). The planFile-to-planId resolution in the direct-DB fallback ALWAYS returned null → `FAILED` for every Split Plan prompt when extension not running. | Resolved `wsId = await db.getWorkspaceId() \|\| await db.getDominantWorkspaceId() \|\| ''` before calling `getPlanByPlanFile`. |
| 2 | CRITICAL | `TaskViewerProvider.ts:927` | Same bug in the `moveCard` API callback: `getPlanByPlanFile(sessionId, wsRoot)` passed `wsRoot` as `workspaceId`. The API path also failed to resolve planFiles. Pre-existing, but this plan made it load-bearing (Split Plan prompt now routes through it). | Same fix: resolve `wsId` from DB before `getPlanByPlanFile`. |
| 3 | MAJOR | `move-card.js:137` | `\|\|` fallback between `cascadeEpicByPlanId(epicPlanId, targetColumn)` [2 args] and `updateColumnWithEpicCascadeByPlanId(epicPlanId, subtaskPlanIds[], targetColumn)` [3 args] — incompatible signatures. 2-arg `.call()` worked for the first (always picked since `cascadeEpicByPlanId` now exists) but would silently pass `targetColumn` as `subtaskPlanIds` if the fallback were ever hit. Latent time bomb. | Replaced `\|\|` with explicit `if (typeof db.cascadeEpicByPlanId === 'function')` branch; fallback now fetches subtaskPlanIds via `getSubtasksByEpicId` and passes all 3 args correctly. |
| 4 | NIT | Plan text line 60 | Plan states `cascadeEpicByPlanId` "does NOT yet exist" — it now exists (KanbanDatabase.ts:3877, commit 957df2a). The `\|\|` fallback was dead code. | Updated plan text below. |

### Files Changed (Reviewer Pass)

- `.agents/skills/kanban_operations/move-card.js` — lines 128-149: workspaceId resolution fix + cascade signature fix.
- `src/services/TaskViewerProvider.ts` — lines 923-935: workspaceId resolution fix in `moveCard` API callback.

### Validation Results

- **Grep: `sqlite3.*UPDATE plans SET kanban_column` in `src/services/`** → 0 matches in prompt files (only in KanbanDatabase.ts DB layer). ✅
- **Grep: `sqlite3` in `agentPromptBuilder.ts`** → 0 matches. ✅
- **Grep: `updateColumnWithEpicCascade\b` (non-existent method) in `move-card.js`** → 0 matches. ✅
- **Grep: `getPlanByPlanFile(sessionId, wsRoot)` in `TaskViewerProvider.ts`** → 0 matches (bug eliminated). ✅
- **Compilation:** Skipped per session directive.
- **Automated tests:** Skipped per session directive.

### Remaining Risks

1. **`out/` compilation requirement** (pre-existing, documented in plan): the direct-DB fallback in `move-card.js` requires `require('../../../out/services/KanbanDatabase')`. In uncompiled dev environments, the fallback fails with a module-not-found error. The extension API path is the only option. This is a regression from raw-SQL (which always worked), documented in the prompt error message.
2. **`getDominantWorkspaceId` fallback**: if both `getWorkspaceId()` and `getDominantWorkspaceId()` return null (empty DB or fresh workspace), `wsId` is `''`. `getPlanByPlanFile` will query `WHERE workspace_id = ''` which won't match. This is an edge case for completely empty workspaces — the plan file wouldn't be registered yet anyway, so `FAILED` is the correct outcome.
3. **`updatePlanFile` at `move-card.js:158`**: when `plan` is null (unregistered plan file), it passes `effectiveKey` (a planFile path) as `sessionId` to `updatePlanFile`, which calls `getPlanBySessionId` — this won't match a file path and returns false. This is the correct error behavior (plan not found → `FAILED`), not a bug.

## Verification Plan

> Per project conventions: skip compilation and automated tests during implementation; the user runs the suite separately.

### Automated Tests

Skipped per session directive — the user runs the test suite separately. No compilation or automated test steps are included in this plan.

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

Complexity 5 (Medium: 4 prompt text edits + `move-card.js` fallback fix [crash → working method] + planFile-to-planId resolution + API server planId support, with the planFile resolution being the only non-obvious part) → **Send to Coder**. The implementer should confirm User Review #1 (agent hosts run in-workspace) before proceeding. If Plan 2 (Atomic Race-Free Cascade) is implemented first, use `cascadeEpicByPlanId` in the `move-card.js` fallback; otherwise use `updateColumnWithEpicCascadeByPlanId` as a stopgap. **Critical:** the planFile-to-planId resolution (step 1 of the move-card.js changes) must be implemented BEFORE the fallback fix (step 2) — otherwise the Split Plan prompt path will call `getPlanBySessionId` with a file path and fail.
