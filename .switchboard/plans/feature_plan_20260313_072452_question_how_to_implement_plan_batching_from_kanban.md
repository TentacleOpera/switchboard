# Implement Backend Kanban Auto-Batching Prompt Engine

## Goal
Now that the Kanban automation engine has been moved to the background ("Autoban"), the system needs the backend capability to execute a batch of plans simultaneously. This plan focuses strictly on updating the `TaskViewerProvider` to take an array of `sessionIds` (provided by the Autoban engine), update all of their runsheets simultaneously, and construct a single multi-plan prompt that leverages parallel sub-agents to save time and context tokens.

## Complexity Audit
### Band A — Routine
* **Backend Signature Updates**: Creating a new internal method `_handleTriggerBatchAgentActionInternal` that accepts an array of `sessionIds`.

### Band B — Complex / Risky
* **State Management**: Iterating over the array of batched `sessionIds` and successfully updating *each* runsheet sequentially so the Kanban board accurately advances all cards without triggering file-locking collisions in `SessionActionLog`.
* **Prompt Construction**: Generating a unified batch payload that safely bounds the AI and prevents context hallucination across multiple files.

## Edge-Case & Dependency Audit
* **Race Conditions:** Updating multiple runsheets simultaneously could cause file-locking contention. We must use sequential `for...of` awaiting for runsheet updates to ensure deterministic writes before dispatching the prompt.
* **AI Hallucination:** Batching too many files into a single prompt risks context bleed. The Autoban engine will cap the input array, but the prompt itself must explicitly instruct the agent to isolate contexts.
* **Dependencies & Conflicts:** **CRITICAL DEPENDENCY** - This plan acts as the payload execution dependency for the "Transform Auto Tab into Autoban" plan. The Autoban polling loop will directly call the batching function built in this plan.

## Adversarial Synthesis
### Grumpy Critique
Why are we grouping these at all? If one plan fails to compile, the AI is going to get confused and halt the whole batch! And what happens when the Autoban engine sends a batch of 5, but the AI platform being used doesn't support parallel sub-agents? It's just going to lock up the user's terminal for an hour while it grinds through 5 tasks sequentially.

### Balanced Response
Grumpy is right that failure isolation is harder in a batch. To address the sequential grinding risk, the prompt will explicitly instruct the AI: "If your platform supports parallel sub-agents, dispatch one per plan. If not, process them sequentially." This is an opt-in optimization for advanced users utilizing agents like Cascade or Claude Code that *can* handle parallel routing. Context bleed is managed by explicitly commanding the agent to isolate each file path.

## Proposed Changes

### 1. Task Viewer Provider Engine (`src/services/TaskViewerProvider.ts`)
* **Create `handleKanbanBatchTrigger(role, sessionIds[], instruction)`**:
    1. Resolve all valid, active plan absolute paths from the provided `sessionIds`.
    2. Iterate through the valid IDs and `await this._updateSessionRunSheet(id, workflowName)` for each to advance their state on the Kanban board (using a sequential `for...of` loop to prevent file lock contention).
    3. Construct the aggregated parallel prompt:
       ```typescript
       let prompt = `Please process the following ${validPlans.length} plans.
If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.

CRITICAL INSTRUCTIONS:
1. Treat each file path below as a completely isolated context. Do not mix requirements.
2. Upon completing ALL plans, save a read receipt to the inbox.

PLANS TO PROCESS:\n`;
       
       for (const plan of validPlans) {
           prompt += `- [${plan.topic}](${plan.uri})\n`;
       }
       ```
    4. Call `_dispatchExecuteMessage` to send the payload to the target terminal.

## Verification Plan
### Automated Tests
- Run `npm run compile` to verify TypeScript signatures.

### Manual Testing
1. **Trigger Engine**: Since Autoban is handling the UI, manually invoke the new batch function programmatically (e.g., via a temporary test command or by letting the Autoban engine call it).
2. **State Updates**: Pass an array of 3 `sessionIds`. Verify that all 3 cards visually move to the correct column on the Kanban board without file-lock errors.
3. **Prompt Validation**: Check the target terminal to verify it received a single unified prompt containing all 3 plan paths and the parallel sub-agent instructions.

## Review & Execution Assessment

### Grumpy Critique (Stage 1)
*"Wait a second! You completely forgot one of the most critical parts of the prompt! You didn't tell the AI to leave a read receipt! How is the system supposed to know when the entire batch is finished if the AI just silently stops? And another thing, you told the AI 'Execute each plan fully before moving to the next' – while fine for sequential execution, the plan explicitly asked for the read receipt to trigger upon completion of ALL plans. Without that, Autoban is going to sit there staring at the wall forever waiting for a completion signal!"*

### Balanced Synthesis (Stage 2)
- **Implemented Well**: `handleKanbanBatchTrigger` accurately resolves valid plan paths, handles single-plan fallback efficiently, successfully runs sequential runsheet updates to avoid file locks, and builds the batched prompt loop using exact paths.
- **Issues Found**: (MAJOR) The prompt constructed in `handleKanbanBatchTrigger` was missing the "save a read receipt to the inbox" instruction explicitly called out in the plan.
- **Fixes Applied**: Injected the exact instruction (`3. Upon completing ALL plans, save a read receipt to the inbox.`) into the batched prompt in `TaskViewerProvider.ts`.
- **Validation Results**: Ran `npm run compile` successfully. Code structure matches the single-file focus directive.
- **Remaining Risks**: If the target AI ignores the read receipt instruction or fails mid-batch, Autoban may stall on those session IDs until a manual override.
- **Final Verdict**: Ready.