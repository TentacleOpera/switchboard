# Remove the Useless "Run a Full Sync" Instruction From the Memo Planner Prompt

## Goal

The generated memo planner prompt ends with an instruction to "run a full sync so they appear on the kanban board." That step is useless because an active file watcher already picks up new plan files. Remove it from the generated prompt.

### Problem Analysis

The memo planner prompt is built in `_buildMemoPlannerPrompt` ([KanbanProvider.ts:7041-7075](src/services/KanbanProvider.ts#L7041)). Its final instruction line is:

```ts
- After creating all plans, run a full sync so they appear on the kanban board`;   // line 7074
```

This is generated for both **Copy Prompt** and **Send to Planner** ([memoGeneratePrompt handler, 6969-7004](src/services/KanbanProvider.ts#L6969)). Switchboard runs a file watcher over `.switchboard/plans/`, so newly created plan files appear on the board automatically — the manual sync instruction is redundant, adds an unnecessary action for the agent, and can prompt it to run an extra (possibly disruptive) command.

The watcher is substantiated by two systems:
- `GlobalPlanWatcherService` (held in `KanbanProvider._globalPlanWatcher`, [KanbanProvider.ts:155](src/services/KanbanProvider.ts#L155)) — fires `onPlanDiscovered` and triggers a scan when new plan files appear.
- `_configuredPlanWatcher` in `TaskViewerProvider.ts` ([TaskViewerProvider.ts:10134-10137](src/services/TaskViewerProvider.ts#L10134)) — a `vscode.FileSystemWatcher` whose `onDidCreate` / `onDidChange` / `onDidDelete` events are bound to `guardedScheduleSync`, ensuring new plan files are ingested automatically.

### Root Cause

A leftover manual-sync instruction in the prompt template predates / ignores the active plans file watcher.

## Metadata

**Complexity:** 1
**Tags:** backend, refactor

## User Review Required

No. This is a pure prompt-text removal with no behavioral, schema, or API change. The deletion target is a single string literal line; no user-facing dialog, setting, or data shape is affected. Safe to execute without review.

## Complexity Audit

### Routine
- Deleting one trailing instruction line from the prompt template string at [KanbanProvider.ts:7074](src/services/KanbanProvider.ts#L7074).
- Moving the closing backtick of the template literal to follow the "investigation step" bullet at [KanbanProvider.ts:7073](src/services/KanbanProvider.ts#L7073).
- Confirming the resulting template string is still well-formed (no stray characters, correct backtick placement).

### Complex / Risky
- None. Pure prompt text removal; no behavioral code changes.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The prompt is built synchronously inside `_buildMemoPlannerPrompt` and consumed immediately by the clipboard write or `_dispatchMemoToPlanner`. No concurrent state is touched.
- **Security:** None. The change removes an instruction from a generated prompt string; no credentials, paths, or user input handling are affected.
- **Side Effects:** With the line removed, the planner agent is no longer asked to run a manual sync. The file watcher (`GlobalPlanWatcherService` + `_configuredPlanWatcher`) ingests new plan files automatically, so board appearance is unaffected. The only behavioral delta is that the agent will not run an extra `switchboard.fullSync` command — which is the desired outcome.
- **Dependencies & Conflicts:** The preceding bullet ([7073](src/services/KanbanProvider.ts#L7073)) ends the template's `## Important` list; ensure the template still closes its template literal correctly after removing the final bullet (the backtick must now follow the "investigation step" line). Soft coordination: the memo-modal intro-text plan (same feature area, different file) should keep messaging consistent — the modal's intro text and the generated prompt should both avoid implying a manual sync is required.

## Dependencies

- None (hard). The change is self-contained within `_buildMemoPlannerPrompt`.
- Soft coordination: memo-modal intro-text plan (messaging consistency only — no session ID available; ensure the modal's intro text does not re-introduce a "sync required" implication).

## Adversarial Synthesis

Key risks: stale line-number citations (corrected to 7041-7075 / 6969 / 7074), fabricated tags outside the allowed list (corrected to `backend, refactor`), and an unsubstantiated watcher claim (now cited via `GlobalPlanWatcherService` and `TaskViewerProvider._configuredPlanWatcher`). Mitigations: all citations re-verified against current source; tags restricted to the allowed list; watcher references backed by concrete file/line evidence. Residual risk is negligible — a single string-literal line deletion with no behavioral code change.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — drop the sync bullet
In `_buildMemoPlannerPrompt` ([7041-7075](src/services/KanbanProvider.ts#L7041)), remove the final bullet so the `## Important` list ends at the prior line ([7070-7073](src/services/KanbanProvider.ts#L7070)):

**Context:** The function builds a prompt string via a template literal. The `## Important` section is the last block before the closing backtick.

**Logic:** Delete the line `- After creating all plans, run a full sync so they appear on the kanban board` (line 7074) and move the closing backtick to the end of the "investigation step" bullet (line 7073).

**Implementation:**
```ts
## Important
- Create ${issues.length} plan file(s) total — one per issue
- Write each plan to: ${plansDir}/feature_plan_<YYYYMMDDHHMMSS>_<slug>.md
- Do NOT skip the investigation step — read the relevant code before writing each plan`;
```

(Delete the line: `- After creating all plans, run a full sync so they appear on the kanban board`.) Ensure the backtick that closes the template literal now follows the "investigation step" bullet.

**Edge Cases:** Confirm the template literal still compiles (no trailing comma, no orphaned backtick). The `return` statement at [7045](src/services/KanbanProvider.ts#L7045) opens the literal; the backtick at the end of the "investigation step" line closes it. No other references to the sync line exist in the file (verified — single match at 7074).

## Verification Plan

### Automated Tests
None required. This is a prompt-text-only change with no behavioral code path. The test suite (run separately by the user) should remain green since no function signatures, control flow, or data shapes are modified.

### Manual Verification
1. Build; open Kanban → Memo, add an entry, click **Copy Prompt**.
2. Paste the clipboard contents → confirm the prompt no longer contains "run a full sync."
3. Use **Send to Planner** → confirm the dispatched prompt likewise omits the sync line.
4. Create a plan via the prompt and confirm it appears on the kanban board automatically (file watcher), with no manual sync.
5. Confirm the prompt string is still well-formed (no stray characters from the removed bullet; template literal closes correctly).

## Recommendation

Complexity 1 → **Send to Intern**.
