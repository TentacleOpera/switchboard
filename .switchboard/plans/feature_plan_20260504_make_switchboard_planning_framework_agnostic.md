# Feature Plan: Make Switchboard Planning Framework Agnostic

## Goal
Decouple Switchboard's planning logic from its hardcoded methodology. Allow users to specify a custom workflow file (e.g., GSD, Superpowers) that completely replaces the Switchboard 8-step prompt, while still supporting Switchboard add-ons (Dependency Checks, Design Docs, Aggressive Mode).

## Proposed Changes

### UI Layer (Kanban Prompts Tab)
- Added Role dropdown to switch between Planner and Coder.
- Added Workflow File Path input field (defaulting to `.agent/workflows/improve-plan.md`).
- Implemented dynamic preview logic in `kanban.js` that branches based on the selected workflow path.

### Backend (Prompt Generation)
- Modified `buildKanbanBatchPrompt()` in `src/services/agentPromptBuilder.ts` to check `options.plannerWorkflowPath`.
- **Switchboard Mode:** If path is default, use the full legacy prompt (backward compatibility).
- **Agnostic Mode:** If path is custom, generate a minimal prompt: `Read ${workflowPath} and follow it step-by-step.`
- Integrated add-ons (Aggressive Mode, Dependency Check, Design Doc) into both prompt branches.

## Verification Plan
- Verify UI preview matches generated prompt.
- Test that custom workflows receive minimal instructions.
- Test that default workflow still receives full Switchboard instructions.

---

## Reviewer Findings (Reviewer-Executor Pass)

### Stage 1: Grumpy Principal Engineer Review
**CRITICAL:** The implementation completely missed the core requirement! The UI looked pretty, but `buildKanbanBatchPrompt()` just hardcoded the full Switchboard prompt and casually appends "Read this workflow file" at the end. This completely breaks the contract for custom workflows.
**MAJOR:** Tests are broken! A previous developer used `sinon.stub(vscode.env.clipboard, 'writeText')` in `src/test/pair-programming-comprehensive.test.ts`, which now throws `TypeError`.

### Stage 2: Balanced Synthesis
**Actionable Fixes:**
1. Update `buildKanbanBatchPrompt()` to correctly branch. If it's a custom path, return a minimal prompt with just the "Read X" instruction and add-ons.
2. Fix the Sinon stubbing in `pair-programming-comprehensive.test.ts` using `sandbox.replaceGetter`.

## Final Resolution & Execution
- **Code Fixes:** Branching logic implemented in `agentPromptBuilder.ts`.
- **Infrastructure Fix:** Fixed Sinon stubbing in `pair-programming-comprehensive.test.ts` to handle immutable VS Code getters.
- **Verification:** All 28 tests in the comprehensive suite now pass.
- **Files Modified:** `src/webview/kanban.html`, `src/webview/kanban.js`, `src/services/agentPromptBuilder.ts`, `src/test/pair-programming-comprehensive.test.ts`.

## Complexity Audit
**Manual Complexity Override:** 5

### Complex / Risky
- Medium complexity (5/10).
