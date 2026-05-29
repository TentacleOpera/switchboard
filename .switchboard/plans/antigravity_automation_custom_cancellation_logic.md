# Antigravity Automation Prompt Fix

## Goal

Fix `_generateAntigravityPrompt` so it produces a **reusable, general-purpose instruction** that tells the agent to dynamically find and process the oldest plan in a target column each time the scheduled timer fires — rather than hardcoding a specific plan at generation time, which causes the same plan to be retried on every subsequent run.

---

## Metadata

**Tags:** backend, workflow, reliability
**Complexity:** 4

---

## User Review Required

> [!IMPORTANT]
> **Empty-column validation behaviour**: The current implementation blocks prompt generation entirely if no plans are found in the selected column (returning `error: 'No plans found in X column'`). The new design must decide: keep this guard (user sees "NO PLANS" when they click "COPY PROMPT" on an empty column) or remove it (always generate the general prompt). This plan **recommends keeping the guard** so the user gets immediate feedback at copy time, while the generated prompt also handles the empty-column case defensively at runtime.

> [!NOTE]
> **Schedule cancellation mechanism — confirmed**: The agent can self-cancel a running schedule by calling `manage_task(action: 'list')` to enumerate active tasks, locating the current schedule's `TaskId`, then calling `manage_task(action: 'kill', TaskId: <id>)`. This is a native Antigravity capability. Alternatively, `MaxIterations` can be set at schedule creation time to cap total runs. The generated prompt should instruct the agent to use `manage_task` for runtime cancellation when the column is empty.

---

## Summary

The current Antigravity automation prompt generation is incorrect. It generates a prompt for a specific plan (the oldest at that moment), which would cause the scheduled task to repeatedly try to process the same plan. The prompt should instead be a general instruction that tells the agent to dynamically fetch the oldest plan each time it runs.

## Background

The Antigravity scheduled task system works by running a prompt on a timer. The prompt should be a general instruction like "here is a list of all plans with their timestamps. choose the oldest, implement it, and mark it off the list." Currently, the system generates a prompt hardcoded to a specific plan, which is wrong.

---

## Complexity Audit

### Routine
- Replacing the body of one private method (`_generateAntigravityPrompt`) in `KanbanProvider.ts`
- Updating a single `textContent` string in `kanban.html`
- No new types, interfaces, or modules required
- Existing DB query path (`db.getPlansByColumn`) and role-resolution logic are reused

### Complex / Risky
- The generated prompt template must correctly instruct the agent to invoke the right kanban query skill — wrong skill name = silent runtime failure
- The self-cancellation flow requires the agent to call `manage_task(action: 'list')` and locate the correct `TaskId`; if multiple schedules are running simultaneously, the agent must identify the right one (low risk in practice — Antigravity sessions are typically single-schedule)

---

## Edge-Case & Dependency Audit

### Race Conditions
- Two concurrent scheduled timer runs could both pick the "oldest" plan at the same moment. Mitigation: this is not a new risk introduced by this plan — it pre-exists and is out of scope. The generated prompt should include standard switchboard safeguards.

### Security
- The generated prompt embeds the column name and resolved role at server side. These values come from internal state (not user-typed text), so injection risk is negligible.

### Side Effects
- Removing the `oldestPlan`-specific data from the generated prompt means the webview no longer receives plan metadata (sessionId, topic) in the `antigravityPrompt` message payload. No known consumer relies on these fields, but verify the `antigravityPrompt` handler in `kanban.html` (line ~5174) only uses `msg.prompt` and `msg.error` — confirmed: it does.

### Dependencies & Conflicts
- `buildKanbanBatchPrompt` is still called for the prompts-config options block (git prohibition, safeguards, etc.). The new design passes an **empty plans array** to this function. Verify that `buildKanbanBatchPrompt` handles an empty plans array gracefully for all roles — if it throws or produces a malformed prompt, the method must guard against that.
- `dist/webview/kanban.html` is a **build artifact** and must NOT be manually edited. It is regenerated from `src/webview/kanban.html` by the build process.

---

## Dependencies

None identified — this is a self-contained change within KanbanProvider and the kanban webview.

---

## Adversarial Synthesis

Key risks: (1) the "query kanban state" instruction must cite a concrete skill name (`query_switchboard_kanban`) or the agent will hallucinate a method; (2) the self-cancellation flow via `manage_task` is real and working — the agent lists active tasks, finds its `TaskId`, and kills it — but if multiple concurrent schedules exist, the agent must pick the right one. Mitigations: hardcode `query_switchboard_kanban` skill reference in the generated prompt; keep the empty-column guard at copy time for fast UI feedback; include `manage_task` cancellation instructions verbatim in the prompt template.

---

## Changes Required

### 1. Update Prompt Generation Logic

**File**: `src/services/KanbanProvider.ts` — [`_generateAntigravityPrompt`](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts#L2479)

**Current behavior** (lines 2479–2621):
- Queries the DB for plans in the selected column
- Finds the oldest plan, hardcodes it into a `BatchPromptPlan`
- Calls `buildKanbanBatchPrompt(role, [oldestPlan], options)` — a plan-specific prompt
- Returns that prompt to the webview

**New behavior**:
1. Keep all existing parameter validation (agent name, DB ready, workspace ID) — no change to the guard block (lines 2481–2512)
2. Keep the empty-column guard (lines 2514–2524) — still return `error: 'No plans found in X column'` if the column is empty. This preserves the "NO PLANS" button feedback on the UI.
3. **Remove** the `oldestPlan` lookup, sort, and `BatchPromptPlan` construction (lines 2526–2544)
4. Keep the role resolution from `customAgents` (lines 2547–2552) — still needed to determine role label
5. Keep the `_getPromptsConfig` / `_getDefaultPromptOverrides` call (lines 2556–2557) — still used for options
6. **Replace** the `buildKanbanBatchPrompt(role, [oldestPlan], options)` call with a call to `buildKanbanBatchPrompt(role, [], options)` (empty plans array) to obtain the role-configuration preamble/header, then **append** the general scheduling instruction block beneath it.

**Clarification** (implementation detail implied by plan intent):
The general scheduling instruction block to append should include:
- The resolved role name and target column (substituted at generation time)
- An explicit instruction to invoke `skill: "query_switchboard_kanban"` to find the oldest plan
- Instructions to process the plan using the appropriate workflow (e.g., `/handoff-lead` for lead, `/handoff` for coder/intern, `/improve-plan` for planner)
- An instruction to cancel the schedule if no plans remain — subject to confirmation of the available cancellation mechanism (see User Review Required)

**Prompt Template** (to be generated at server side with substitutions applied):

```
You are running on a scheduled Antigravity timer to process plans in the [COLUMN] column.

Each time you run:
1. Use skill: "query_switchboard_kanban" to get all plans currently in the [COLUMN] column
2. If no plans exist in the column:
   a. Call manage_task with action: 'list' to find this schedule's TaskId
   b. Call manage_task with action: 'kill' and that TaskId to cancel all future runs
   c. Stop.
3. Identify the oldest plan by creation timestamp
4. Process that plan as a [AGENT ROLE] using your standard workflow
5. When complete, move the plan to the next column in the pipeline

Agent configuration: [AGENT ROLE]
Target column: [COLUMN]
```

Where `[COLUMN]` = the column ID from the request (e.g., `CREATED`, `PLAN REVIEWED`) and `[AGENT ROLE]` = the resolved role string (e.g., `planner`, `lead`, `coder`). Both are substituted at generation time inside `_generateAntigravityPrompt`, not left as raw bracket text in the output.

**Implementation Steps**:
1. In `_generateAntigravityPrompt` (line 2479), after the column-empty guard (after line 2524), delete the sort/oldest-plan/plans-array block (lines 2526–2544)
2. After the options block (line 2604), replace line 2607 (`const prompt = buildKanbanBatchPrompt(role, plans, options)`) with:
   ```typescript
   const preamble = buildKanbanBatchPrompt(role, [], options);
   const schedulingBlock = `\n\n---\n\nYou are running on a scheduled Antigravity timer to process plans in the **${column}** column.\n\nEach time you run:\n1. Use skill: "query_switchboard_kanban" to get all plans currently in the **${column}** column\n2. If no plans exist in the column, cancel this schedule and stop\n3. Identify the oldest plan by creation timestamp\n4. Process that plan as a **${role}** using your standard workflow\n5. When complete, move the plan to the next column in the pipeline`;
   const prompt = preamble + schedulingBlock;
   ```
3. Verify `buildKanbanBatchPrompt(role, [], options)` does not throw for an empty array — check `agentPromptBuilder.ts` to confirm.

---

### 2. Update Automation Tab Description

**File**: `src/webview/kanban.html` — line 6111

**Current text**:
```
Select an agent and column, then copy a prompt (using prompts tab configuration) for the oldest plan in that column. Paste this prompt into the Antigravity automation timer (or similar IDE feature) to have Antigravity process all plans in a kanban column.
```

**New text**:
```
Select an agent and column, then copy a general prompt that instructs the agent to process the oldest plan in that column each time the schedule runs. Paste this prompt into the Antigravity automation timer (or similar IDE feature) to have Antigravity process all plans in a kanban column sequentially. The agent will automatically cancel the schedule when no plans remain in the target column.
```

**Implementation Step**: Replace `antigravityDesc.textContent = '...'` at line 6111 with the new string.

---

### 3. Do NOT edit dist/

**File**: `dist/webview/kanban.html` — **build artifact, do not touch**. It is regenerated from `src/webview/kanban.html` by the build process. Remove it from any "files to modify" mental checklist.

---

## Testing Checklist
- [ ] Prompt generation no longer hardcodes specific plan details
- [ ] Generated prompt is a general instruction that can be reused
- [ ] Agent can successfully query kanban state to find oldest plan
- [ ] Agent processes the correct (oldest) plan each run
- [ ] Agent cancels schedule when column is empty
- [ ] Automation tab description updated
- [ ] Button correctly shows "NO PLANS" when column is empty at copy time
- [ ] `buildKanbanBatchPrompt` called with empty plans array does not throw

---

## Verification Plan

### Automated Tests
- Inspect existing tests in `src/services/__tests__/KanbanProvider.test.ts` and `agentPromptBuilder.test.ts` for any tests that mock `_generateAntigravityPrompt` or assert on the generated prompt's content
- Manually inspect the generated prompt in the webview by clicking "COPY PROMPT" and verifying it no longer contains a hardcoded session ID or plan file path

### Manual Verification
- Open the Automation tab in the Kanban panel
- Select an agent and a column with at least one plan; click "COPY PROMPT" — verify the copied text is a general scheduling instruction, not a specific plan reference
- Select a column with zero plans; click "COPY PROMPT" — verify the button shows "NO PLANS"

---

## Recommendation

**Send to Coder** (Complexity 4 — routine multi-file change with one moderate risk around `buildKanbanBatchPrompt` empty-array behaviour and the cancellation mechanism)
