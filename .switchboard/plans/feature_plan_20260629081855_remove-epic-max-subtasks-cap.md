# Remove the Epic Subtask Cap (`epic_max_subtasks`) Entirely

## Metadata
**Complexity:** 3
**Tags:** backend, frontend, epic, kanban, cleanup, bugfix

## Goal

Remove the `epic_max_subtasks` cap completely. When an epic is dispatched (board "Pair", board step-mode, or the Epics-tab "Orchestrate"), include **every** active subtask in the prompt — no truncation, no `[WARNING:]` line, no configurable limit. Delete the now-dead config knob and its orphaned handlers.

### Problem Analysis

The cap exists for exactly one reason, stated in the original design doc's risk table (`.switchboard/plans/epic-subtask-system.md:319`):

> **Prompt bloat** — an epic with 15 subtasks could exceed token limits. → Cap subtasks at a configurable limit (default 20). If exceeded, include only first N and append a warning line to the prompt. Truncated subtasks stay in their current column.

That rationale does not hold. Each subtask contributes **exactly one line** to the dispatched prompt (`agentPromptBuilder.ts:262-263`):

```
  - [SUBTASK] <topic> Plan File: <absolutePath>
```

It is a topic + file path — **not** the plan body (the agent reads each file itself). A 100-subtask epic adds ~100 lines (low thousands of tokens), which is no threat to any modern context window. The cap guards against a non-problem.

The cap is **dispatch-only**. It is not applied during ClickUp/Linear import, board storage, or any sync path — confirmed by grepping every file that references `epic_max_subtasks` / `getSubtasksByEpicId` (only `KanbanProvider`, `KanbanDatabase`, `PlanningPanelProvider`, `agentPromptBuilder`; no sync/import service). So a ClickUp task with 40 subtasks imports intact, then silently loses 20 the moment a user clicks Pair or Orchestrate. The mismatch the user feels is real; it lands at dispatch time, not import time.

### Root Cause (and the bug this also fixes)

The cap was wired up independently of the column cascade, producing a latent data-integrity bug:

- **Prompt expansion is capped** — `_cardsToPromptPlans` (`KanbanProvider.ts:2530`) and `buildEpicOrchestrationPrompt` (`KanbanProvider.ts:3127`) `slice(0, maxSubtasks)`, so only the first 20 subtasks reach the agent.
- **The column advance is NOT capped** — advancing the epic runs `cascadeEpicByPlanId` (`KanbanDatabase.ts:3945-3948`), a blanket `UPDATE plans SET kanban_column = ? WHERE epic_id = ? AND status = 'active'` that moves **all** active subtasks forward.

Result for an epic with >20 subtasks: subtasks 21…N are moved to LEAD CODED (marked coded) but never appeared in any prompt — no agent was told to code them. They then flow downstream looking implemented. The design doc explicitly intended the opposite ("Truncated subtasks stay in their current column", `epic-subtask-system.md:46,178,319`), and the synthetic warning line even *claims* `Remaining subtasks stay in column: <column>` — which the cascade then contradicts.

Removing the cap makes the dispatched set equal the cascaded set again, so it closes this inconsistency as a side effect. **No separate cascade fix is required.**

Additional dead-code findings (all removable in this change):
- No webview sends the `updateEpicConfig` message anymore (zero senders in `src/webview/`). Both handlers (`KanbanProvider.ts:8137-8154`, `PlanningPanelProvider.ts:3430-3445`) write *only* `epic_max_subtasks` and are otherwise no-ops — fully dead.
- `epicMaxSubtasks?: number` in `PromptBuilderOptions` (`agentPromptBuilder.ts:190`) is declared but never consumed; truncation happens in `KanbanProvider` before the builder is called.

## Decision (no open product questions)

- **Remove entirely**, not "default to unlimited but keep the knob." An unused, UI-less config key is confusing surface area. (User confirmed: remove entirely.)
- **No migration; do not delete stored config rows.** Per CLAUDE.md, legacy DB keys are never dropped — we simply stop reading/writing `epic_max_subtasks`. Any value a user set via a previously shipped UI becomes inert. This cannot destroy data: removing a cap only makes dispatch *more* inclusive (the user's intent). A no-op orphan row in the `config` table is harmless.
- **Keep the `buildEpicOrchestrationPrompt` return shape** (`{ prompt, epicTopic, subtaskCount, totalSubtasks }`) to avoid churn across its three consumers; set `subtaskCount === totalSubtasks === subtasks.length`. Strip the now-dead "capped at X of Y" UI branch.

### Rejected Alternatives
- *Keep an inert `epic_max_subtasks` knob as a safety valve* — rejected: no UI, no demand, and it re-introduces the truncation-vs-cascade bug for anyone who sets it.
- *Only cap the cascade to match the prompt* — rejected: that would preserve truncation (the actual problem) and merely make it consistent; the user wants all subtasks dispatched.

## Complexity Audit

### Routine
- Delete cap read + `slice` + `[WARNING:]` push in `_cardsToPromptPlans`.
- Delete cap read + `slice` + `[WARNING:]` push in `buildEpicOrchestrationPrompt`; set both counts to the full subtask count.
- Delete the two dead `updateEpicConfig` handler cases.
- Delete the dead `epicMaxSubtasks?: number` option field.
- Strip the dead "capped at" branch in `project.js`.

### Complex / Risky
- None. This is deletion of dispatch-time truncation; no new control flow, no schema change, no migration.

## Edge-Case & Dependency Audit

- **Very large epics (hundreds of subtasks):** prompt is still only path-lines, far under any clipboard/terminal paste limit. The downstream cost (agent reads N plan files, or spawns N subagents) is the user's explicit intent and is orthogonal to this cap.
- **`generateUnifiedPrompt` subtask count** (`KanbanProvider.ts:3067`) filters out `[WARNING:`-prefixed pseudo-plans. Once WARNING entries are never created, this guard is harmless but redundant — simplify it.
- **`EPIC_ORCHESTRATION_DIRECTIVE(epicTopic, subtaskCount)`** (`agentPromptBuilder.ts:534`) — unaffected; `subtaskCount` is now simply the full count.
- **Board card meta `subtaskCount`** (e.g. `kanban.html:5385`, `KanbanProvider.ts:1242`) is computed from a count map, unrelated to the cap — leave untouched.

### Dependencies
- `buildEpicOrchestrationPrompt` consumers that pass `subtaskCount`/`totalSubtasks` through unchanged: `PlanningPanelProvider.ts:3277,3288`, `KanbanProvider.ts:7041`. Return shape is preserved, so no edits needed there.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — `_cardsToPromptPlans` (epic branch, ~2526-2554)
Replace the capped block:
```ts
if (card.isEpic && hasDb && card.planId) {
    const maxRaw = await db.getConfig('epic_max_subtasks');
    const maxSubtasks = maxRaw ? parseInt(maxRaw, 10) : 20;
    const subtasks = await db.getSubtasksByEpicId(card.planId);
    const limited = subtasks.slice(0, maxSubtasks);
    for (const st of limited) { /* push [SUBTASK] ... */ }
    if (subtasks.length > maxSubtasks) { /* push [WARNING:] ... */ }
}
```
with an uncapped iteration over **all** subtasks (drop `maxRaw`, `maxSubtasks`, `limited`, and the entire `[WARNING:]` push; iterate `subtasks` directly).

### 2. `src/services/KanbanProvider.ts` — `buildEpicOrchestrationPrompt` (~3105-3159)
- Remove `maxRaw` / `maxSubtasks` / `limited`; iterate all `subtasks` when pushing `[SUBTASK]` plans.
- Remove the `if (subtasks.length > maxSubtasks)` `[WARNING:]` push.
- Change the return to `{ prompt, epicTopic: epic.topic, subtaskCount: subtasks.length, totalSubtasks: subtasks.length }`.
- Update the doc comment (3105-3110) to drop the "capped at `epic_max_subtasks`" and "[WARNING] line" language.

### 3. `src/services/KanbanProvider.ts` — `generateUnifiedPrompt` subtask count (~3067)
Simplify `plans.filter(p => p.isSubtask && !p.topic.startsWith('[WARNING:'))` to `plans.filter(p => p.isSubtask)` (WARNING entries are no longer produced).

### 4. `src/services/KanbanProvider.ts` — remove dead `updateEpicConfig` case (8137-8154)
Delete the entire `case 'updateEpicConfig':` block. It only wrote `epic_max_subtasks` and has no webview sender.

### 5. `src/services/PlanningPanelProvider.ts` — remove dead `updateEpicConfig` case (3430-3445)
Delete the entire `case 'updateEpicConfig':` block (same reasoning).

### 6. `src/services/agentPromptBuilder.ts` — remove dead option (190)
Delete `epicMaxSubtasks?: number;` from `PromptBuilderOptions`.

### 7. `src/webview/project.js` — strip dead "capped" UI (1943-1946)
Replace:
```js
let status = `${msg.subtaskCount || 0} subtask(s) included`;
if (msg.totalSubtasks && msg.totalSubtasks > (msg.subtaskCount || 0)) {
    status += ` (capped at ${msg.subtaskCount} of ${msg.totalSubtasks})`;
}
```
with just the first line (the `capped at` branch is now unreachable).

### 8. Stored config — leave as-is
Do **not** add a migration and do **not** delete `epic_max_subtasks` rows from the `config` table. The key is simply no longer read or written.

## Verification Plan

### Automated
- `npm test` — full suite must stay green. No existing test references `epic_max_subtasks` / `maxSubtasks` / the WARNING line (confirmed by grep), so nothing breaks; the epic/pair suites (`pair-programming-comprehensive.test.ts`, `kanban-default-prompt-previews.test.js`) must still pass.
- **Add a regression test:** an epic with subtask count > old default (e.g. 25) must expand to 25 `[SUBTASK]` entries in both `_cardsToPromptPlans` and `buildEpicOrchestrationPrompt`, and the generated prompt must contain **no** `[WARNING:` line. Assert `buildEpicOrchestrationPrompt` returns `subtaskCount === totalSubtasks === 25`.

### Manual (installed VSIX — dev does not use `dist/`)
1. Create an epic with 25 subtasks (or import a ClickUp/Linear epic with >20).
2. Move it to PLAN REVIEWED, high complexity; click **Pair**. Inspect the clipboard Lead prompt + the Coder terminal prompt: all 25 `[SUBTASK]` lines present, no WARNING line.
3. From the Epics tab, click **Orchestrate** (copy mode): prompt shows all 25; status reads "25 subtask(s) included" with no "capped at" suffix.
4. Confirm the epic + all 25 subtasks advance to LEAD CODED together (dispatched set == moved set — the prior inconsistency is gone).
