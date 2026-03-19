# Add detail requirement to planning prompt

## Goal
- The current automated prompt sent through the kanban (manual move, but may also apply to autoban) does not specify that the planner actually has to add sufficient details. This wastes back and forth with the user reprompting the agent to make the plans actually useful.

Instead of just adding a weak instruction to the prompt, we should take the highly detailed "How to Plan" guide currently generated for NotebookLM in the airlock and turn it into a reusable `.agent/rules/how_to_plan.md` file. The planner prompt should then explicitly reference this rule file to force compliance with the highest planning standards.

## Proposed Changes
1. **Extract the How To Plan Guide**:
   Create a new file `.agent/rules/how_to_plan.md` using the markdown template currently hardcoded in `src/services/TaskViewerProvider.ts` (around line 9015). This file will serve as the canonical instruction set for both NotebookLM and the internal Planner agent.
   
2. **Modify `src/services/TaskViewerProvider.ts`**:
   - Update the `_exportAirlockZip` method to read from the newly created `.agent/rules/how_to_plan.md` file instead of relying on the hardcoded string array. Write the file into the airlock directory as before.
   - Update the `messagePayload` assigned when `role === 'planner'` (inside the `_executePlanInTerminal` method). For both the strict and light mode prompts, inject a directive right after "Add extra detail." or within the rules section:
     ```text
     MANDATORY: You MUST read and strictly adhere to `.agent/rules/how_to_plan.md` to format your output and ensure sufficient technical detail. Do not make assumptions about which files need to be changed; provide exact file paths and explicit implementation steps as required by the guide.
     ```

## Verification Plan
- Send a plan to the Planner column.
- Verify the Planner reads `.agent/rules/how_to_plan.md` (if using an agent capable of reading files, or simply outputs a plan that adheres to its structure).
- Verify the `Export Airlock` button still correctly includes the timestamped `how_to_plan.md` file in the generated zip.

## Complexity Audit

### Band A — Routine
- Extract the hardcoded guide from `TaskViewerProvider.ts` into `.agent/rules/how_to_plan.md`.
- Update the airlock export logic to read the file.
- Add the reference to `.agent/rules/how_to_plan.md` in the planner prompt strings.

### Band B — Complex / Risky
- None

## Open Questions
- None
