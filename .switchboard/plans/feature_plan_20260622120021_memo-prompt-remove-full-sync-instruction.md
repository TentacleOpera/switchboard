# Remove the Useless "Run a Full Sync" Instruction From the Memo Planner Prompt

## Goal

The generated memo planner prompt ends with an instruction to "run a full sync so they appear on the kanban board." That step is useless because an active file watcher already picks up new plan files. Remove it from the generated prompt.

### Problem Analysis

The memo planner prompt is built in `_buildMemoPlannerPrompt` ([KanbanProvider.ts:6989-7023](src/services/KanbanProvider.ts#L6989)). Its final instruction line is:

```ts
- After creating all plans, run a full sync so they appear on the kanban board`;   // line 7022
```

This is generated for both **Copy Prompt** and **Send to Planner** ([memoGeneratePrompt handler, 6917-6952](src/services/KanbanProvider.ts#L6917)). Switchboard runs a file watcher over `.switchboard/plans/`, so newly created plan files appear on the board automatically — the manual sync instruction is redundant, adds an unnecessary action for the agent, and can prompt it to run an extra (possibly disruptive) command.

### Root Cause

A leftover manual-sync instruction in the prompt template predates / ignores the active plans file watcher.

## Metadata

**Complexity:** 1
**Tags:** backend, memo, prompt-engineering, cleanup

## Complexity Audit

### Routine
- Deleting one trailing instruction line from the prompt template string.

### Complex / Risky
- None. Pure prompt text removal; no behavioral code changes.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** Confirm the plans file watcher is indeed active and reliably ingests new plans (it is — the watcher/continuous-sync is the mechanism the rest of the app relies on). With the line removed, the prompt no longer asks the agent to sync.
- **Dependencies & Conflicts:** The preceding line ([7021](src/services/KanbanProvider.ts#L7021)) ends the template's earlier bullets; ensure the template still closes its template literal correctly after removing the final bullet. Coordinate with the memo-modal intro-text plan (same feature, different file) so messaging stays consistent.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — drop the sync bullet
In `_buildMemoPlannerPrompt`, remove the final bullet so the `## Important` list ends at the prior line ([7018-7022](src/services/KanbanProvider.ts#L7018)):

```ts
## Important
- Create ${issues.length} plan file(s) total — one per issue
- Write each plan to: ${plansDir}/feature_plan_<YYYYMMDDHHMMSS>_<slug>.md
- Do NOT skip the investigation step — read the relevant code before writing each plan`;
```

(Delete the line: `- After creating all plans, run a full sync so they appear on the kanban board`.) Ensure the backtick that closes the template literal now follows the "investigation step" bullet.

## Verification Plan

1. Build; open Kanban → Memo, add an entry, click **Copy Prompt**.
2. Paste the clipboard contents → confirm the prompt no longer contains "run a full sync."
3. Use **Send to Planner** → confirm the dispatched prompt likewise omits the sync line.
4. Create a plan via the prompt and confirm it appears on the kanban board automatically (file watcher), with no manual sync.
5. Confirm the prompt string is still well-formed (no stray characters from the removed bullet).
