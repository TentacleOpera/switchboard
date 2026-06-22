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

---

## Reviewer Pass — 2026-06-22

### Stage 1: Grumpy Findings

| Severity | Finding | Location |
|:---------|:--------|:---------|
| NIT | Template literal closes correctly with `` `; `` after the "investigation step" bullet — no orphaned backtick or stray comma. | `src/services/KanbanProvider.ts:7079` |
| NIT | Plan file line citations (7041-7075, 7074, 6969) are pre-change numbers; post-edit the function starts at line 7047 and the sync line is gone. Cosmetic only. | Plan file citations |
| NIT | Plan's "no other references" claim re-verified: `run a full sync` → 0 matches in `src/`. The 3 remaining `full sync` hits in `KanbanProvider.ts` (lines 914, 962, 4323) are unrelated "Sync Board" button comments. Claim holds. | `src/services/KanbanProvider.ts:914,962,4323` |

**No CRITICAL findings. No MAJOR findings.**

### Stage 2: Balanced Synthesis

- **Keep**: The deletion is correct, minimal, and well-scoped. Template literal integrity verified.
- **Fix now**: None — no code fixes required.
- **Defer**: Plan line-citation refresh is cosmetic only (noted above).

### Code Fixes Applied

None. The implementation as committed matches the plan exactly.

### Verification Results

- **Grep — `run a full sync` in `src/`**: 0 matches. ✓
- **Grep — `full sync` in `KanbanProvider.ts`**: 3 matches, all unrelated "Sync Board" button code comments (lines 914, 962, 4323). ✓
- **Watcher substantiation**: `GlobalPlanWatcherService` confirmed at `KanbanProvider.ts:155,430`; `_configuredPlanWatcher` confirmed at `TaskViewerProvider.ts:260,10137-10138` (bound to `guardedScheduleSync`). ✓
- **Template literal integrity**: Opens at `KanbanProvider.ts:7051` (`return \``), closes at `KanbanProvider.ts:7079` (`` `; ``). Well-formed, no stray characters. ✓
- **Compilation**: Skipped per reviewer instructions.
- **Tests**: Skipped per reviewer instructions (suite run separately by user).

### Files Changed

- `src/services/KanbanProvider.ts` — removed the `- After creating all plans, run a full sync so they appear on the kanban board` line from `_buildMemoPlannerPrompt`; closing backtick now follows the "investigation step" bullet (line 7079).

### Remaining Risks

None material. The file watcher ingests new plan files automatically, so board appearance is unaffected. The only behavioral delta is the planner agent no longer being prompted to run an extra `switchboard.fullSync` command — which is the desired outcome.
