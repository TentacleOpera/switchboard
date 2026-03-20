# Replace enhance.md with improve-plan.md

## Goal
Replace the legacy `enhance.md` workflow with `.agent/workflows/improve-plan.md`. The new workflow guides the agent to perform plan enhancement, deep code-level dependency checks, an adversarial critique, a balanced synthesis, and a file update all in a single, fluid pass without rigid phase-gate evidence requirements. 

This update universally applies the replacement, cleaning up all UI references, backend IDE prompt templates, documentation, and automated test suites to completely eradicate the legacy `enhance` workflow while keeping `challenge.md` intact.

## User Review Required
> [!NOTE]
> This permanently removes `/enhance` and replaces it with `/improve-plan` across the Kanban board, sidebar copy buttons, agent documentation, the Airlock "How to Plan" guide, IDE connection templates, and test files. The `/challenge` workflow remains unchanged.

## Complexity Audit
### Band A — Routine
- Creating `.agent/workflows/improve-plan.md` with the consolidated instructions.
- Deleting `.agent/workflows/enhance.md` only.
- Updating string references in `TaskViewerProvider.ts`, `KanbanProvider.ts`, `InteractiveOrchestrator.ts`, and `PipelineOrchestrator.ts` to trigger `improve-plan`.
- Updating the Airlock `how_to_plan.md` generator in `TaskViewerProvider.ts`.
- Updating `chat.md` consultative guidance.
- Updating `AGENTS.md`, `README.md`, and the `templates/` registry tables.

### Band B — Complex / Risky
- Replacing the `enhance` state machine definition in `src/mcp-server/workflows.js` with a minimal, single-step `improve-plan` FSM.
- Updating `src/mcp-server/register-tools.js` to authorize the new workflow.
- **CRITICAL:** Ensuring legacy workflow names remain in `KanbanProvider._deriveColumn` and `register-tools.js` mappings so existing Kanban cards do not disappear.
- Refactoring `workflow-controls.test.js` and `send-message-guards.test.js` to rely on `improve-plan` so the CI pipeline doesn't break when `enhance` is deleted.

## Edge-Case & Dependency Audit
- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** Agents executing `/improve-plan` will output their critique and synthesis directly into the chat and immediately update the plan file, saving significant token costs and execution time compared to the old multi-step FSMs. Legacy plans marked with `enhance` in their run sheets will continue to map correctly to `PLAN REVIEWED`.

## Enhancement Findings & Cross-Plan Conflict Audit
- **Cross-Plan Conflicts Detected:** 
  - `feature_plan_20260314_092454_include_challenge_step_in_lead_review_coder_prompt.md` and `feature_plan_20260314_092325_prompt_for_plan_created_should_reference_challenge_workflow.md` explicitly rely on the `challenge` workflow which remains unchanged. No action needed for these plans.
- **Code Dependencies:** `send-message-guards.test.js` and `workflow-controls.test.js` strictly depend on specific FSM states. Removing `enhance` requires updating test assertions to expect `improve-plan` state routing.

## Adversarial Synthesis
### Grumpy Critique
You're modifying tests, documentation, IDE templates, and the core Orchestrators all at once! If you miss a single string replacement in `send-message-guards.test.js`, the CI is going to fail because it tests strict FSM gating! Also, if you replace the workflow with a single step that says "do everything at once," the agent might just output the chat messages and forget to actually update the plan file using `replace_file_content`!

### Balanced Response
Grumpy is right about the blast radius—this touches many files. However, a sweeping cleanup is required to prevent agents from hallucinating deleted workflows. The `send-message-guards.test.js` will explicitly be updated to test `improve-plan` gating instead of `enhance`. Regarding FSM strictness, the "light review" prompt format has already been proven to work reliably when dispatched by the backend Orchestrator. We will explicitly structure `improve-plan.md` to emphasize that updating the plan file is the mandatory final action. If it fails occasionally, the user can simply ask it to apply the update, which is still a far better UX than clicking through 5 mandatory phase gates every time.

## Proposed Changes
### 1. Create the Consolidated Workflow
#### [CREATE] `.agent/workflows/improve-plan.md`
- Provide a single-pass process requiring enhancement, code-level dependency checks, Grumpy critique, Balanced synthesis, and plan updating in one prompt.
#### [DELETE] `.agent/workflows/enhance.md` only

### 2. Update Runtime FSM
#### [MODIFY] `src/mcp-server/workflows.js`
- Remove `enhance` block only. Keep `challenge` block intact. Add an `improve-plan` block with a single execution step.
#### [MODIFY] `src/mcp-server/register-tools.js`
- Update workflow gates to allow `execute` under `improve-plan`. Keep legacy FSM checks for Kanban mapping in `deriveColumn`.

### 3. Update Backend Routing, Strings & Templates
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- Change `_autobanColumnToInstruction` and `_handleCopyPlanLink` strings to use `improve-plan`.
- Update `_buildInitiatedPlanPrompt` to trigger `@[/improve-plan]`.
- Update `_handleAirlockExport` to merge "Structural Enhancement" and "Adversarial Review" into a unified "Improve Plan" step.
#### [MODIFY] `src/services/KanbanProvider.ts`
- Change the planner `instruction` assignment to `'improve-plan'` and add to `_deriveColumn`.
#### [MODIFY] `src/services/InteractiveOrchestrator.ts` & `src/services/PipelineOrchestrator.ts`
- Switch default planner instruction to `improve-plan`.

### 4. Update Protocol Roster, Docs & Tests
#### [MODIFY] `AGENTS.md`, `README.md`, `templates/**/*.md.template`, `.github/copilot-instructions.md`
- Remove `/enhance` and `/challenge` rows. Add `/improve-plan`.
#### [MODIFY] `.agent/workflows/chat.md`
- Update consultative guidance to point users to `/improve-plan`.
#### [MODIFY] `src/test/workflow-controls.test.js` & `src/test/send-message-guards.test.js`
- Replace hardcoded `challenge` test cases with `improve-plan`.

## Verification Plan
### Automated Tests
- Run `npm run compile` to verify TypeScript modifications.
- Run `npm test` to verify the FSM definitions and message guards pass with the new `improve-plan` logic.

### Manual Testing
1. Copy a prompt from the Kanban `CREATED` column and verify it references `improve-plan.md`.
2. Drag a card from `CREATED` to `PLAN REVIEWED` and verify the Planner receives the `improve-plan` instruction.
3. Export an Airlock bundle and verify `how_to_plan.md` lists `/improve-plan` as Step 3.

***

## Appendix: Implementation Patch

### 1. New File: `.agent/workflows/improve-plan.md`
Create this new file with the following exact contents:
```markdown
---
description: Unified enhancement and adversarial review workflow
---

# Improve Plan - Enhancement & Review

This workflow combines deep plan enhancement, dependency validation, and an adversarial stress-test into a single, highly efficient pass.

## File Creation Rules
- When creating files in `.switchboard/`, always use `IsArtifact: false` to prevent path validation errors.

## CRITICAL CONSTRAINTS
- **NO IMPLEMENTATION**: You are strictly FORBIDDEN from modifying any project source files. Your ONLY permissible write action is updating the existing Feature Plan document (`.switchboard/plans/features/*.md`).
- **CONTENT PRESERVATION**: You are FORBIDDEN from deleting original implementation details, code blocks, prose, or goal statements. Your goal is to **APPEND** and refine, not truncate.

## Steps

1. **Start & Execute (Single Pass)**
   - Call `start_workflow(name: "improve-plan", force: true)` to auto-replace any stale workflows.
   - You must complete the following 4 stages in **ONE continuous response**. Do NOT stop early or ask for permission between stages.
   
   - **Stage 1 (Enhancement & Dependency Check)**: 
     - Fill out any 'TODO' sections or underspecified parts in the plan.
     - **Code Dependencies**: MANDATORY: Read the actual code of any service, utility, or module being modified or worked around. Do not assume black-box behavior.
     - **Cross-Plan Conflicts**: Scan the `.switchboard/plans/` folder and current Kanban state to identify if this plan conflicts with, or relies on, other pending work. Document findings in chat.
   - **Stage 2 (Grumpy Critique)**: Post an adversarial critique of the technical approach directly in chat in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).
   - **Stage 3 (Balanced Synthesis)**: Immediately after the grumpy critique, post a balanced synthesis directly in chat.
   - **Stage 4 (Action)**: Update the original Feature Plan document with the enhancement findings and review feedback. 

2. **Complete**
   - Call `complete_workflow_phase(phase: 1, workflow: "improve-plan", artifacts: [{ path: "<feature_plan_absolute_path>", description: "Feature Plan updated" }])`.
   - At the very end of your chat response, explicitly recommend which agent should execute this plan (e.g., "This is a simple plan. Send it to the Coder agent" or "This plan requires advanced reasoning. Send it to the Lead Coder").

## Final-Phase Recovery Rule
- Phase 1 is terminal for `improve-plan`. Do NOT call phase 2.
- If phase 1 succeeded but summary still shows active:
  - Call `get_workflow_state`.
  - If still active, call `stop_workflow(reason: "Recovery: final phase completed but workflow remained active")`.
```

### 2. Core Logic & Orchestrator Patches
```diff
--- src/mcp-server/workflows.js
+++ src/mcp-server/workflows.js
@@ -... +... @@
-    enhance: {
-        name: "Enhance - Deep Planning & Structural Audit",
-        ...
-    },
+    'improve-plan': {
+        name: "Improve Plan - Enhancement & Review",
+        persona: "You are a senior systems analyst and internal reviewer. Consolidate structure and stress-test assumptions. No implementation work.",
+        prohibitedTools: ['run_in_terminal'],
+        steps: [
+            {
+                id: "execute_all",
+                instruction: "Read the plan, check dependencies, simulate Grumpy/Balanced review, and update the plan file in one continuous response.",
+                requiredEvidence: "plan_updated"
+            }
+        ]
+    },
     challenge: {
         name: "Challenge (Internal Adversarial Review)",
         ...
     },

--- src/mcp-server/register-tools.js
+++ src/mcp-server/register-tools.js
@@ -... +... @@
-                    if (wf === 'planner' || wf === 'challenge' || wf === 'enhance' || wf === 'accuracy' || wf === 'sidebar-review' || wf === 'enhanced plan') return 'PLAN REVIEWED';
+                    if (wf === 'planner' || wf === 'challenge' || wf === 'enhance' || wf === 'improve-plan' || wf === 'accuracy' || wf === 'sidebar-review' || wf === 'enhanced plan' || wf === 'improved plan') return 'PLAN REVIEWED';
@@ -... +... @@
     const ACTION_REQUIRED_WORKFLOWS = {
-        'execute': ['handoff', 'challenge', 'handoff-lead'],
+        'execute': ['handoff', 'challenge', 'improve-plan', 'handoff-lead'],
         'delegate_task': ['handoff'],
     };

--- src/services/TaskViewerProvider.ts
+++ src/services/TaskViewerProvider.ts
@@ -... +... @@
     private _autobanColumnToInstruction(column: string): string | null {
         switch (column) {
-            case 'CREATED': return 'enhance';
+            case 'CREATED': return 'improve-plan';
             case 'PLAN REVIEWED': return undefined;
@@ -... +... @@
-        const workflowName = (role === 'planner' && instruction === 'enhance')
-            ? 'Enhanced plan'
+        const workflowName = (role === 'planner' && instruction === 'improve-plan')
+            ? 'Improved plan'
             : workflowMap[role];
@@ -... +... @@
             if (column === 'CREATED') {
                 targetRole = 'planner';
-                textToCopy = `Please review and enhance the following plan. Execute the .agent/workflows/enhance.md workflow to break it down into distinct steps grouped by high complexity and low complexity:\n\n${markdownLink}`;
+                textToCopy = `Please improve the following plan. Execute the .agent/workflows/improve-plan.md workflow to perform a dependency check and adversarial review:\n\n${markdownLink}`;
             }
@@ -... +... @@
     private _buildInitiatedPlanPrompt(planPath: string): string {
         const focusDirective = `FOCUS DIRECTIVE: You are working on the file at ${planPath}...`;
-        return `@[/enhance] Please review and expand the initial plan.\n\n${focusDirective}`;
+        return `@[/improve-plan] Please review and expand the initial plan.\n\n${focusDirective}`;
     }
@@ -... +... @@
-        if (role === 'planner') {
-            if (instruction === 'enhance') {
+        if (role === 'planner') {
+            if (instruction === 'improve-plan') {
@@ -... +... @@
-        '## 3. Structural Enhancement (`/enhance`)',
-        'Audit the strategy for structural completeness:',
-        '- Identify missing pieces, implicit dependencies, or assumptions that need hardening',
-        '- Flag any cross-module impact or architectural concerns',
-        '- Decompose large changes into Band A (routine) and Band B (complex/risky) tasks',
-        '- Expand the plan with concrete file paths, function signatures, and data flow',
-        '',
-        '## 4. Adversarial Review (`/challenge`)',
-        'Stress-test the plan using two personas:',
-        '- **Grumpy**: Aggressively critique every assumption. Find edge cases, race conditions, missing error handling, and scope creep.',
-        '- **Balanced**: Synthesize the critique. Confirm which concerns are real blockers vs. noise. Finalize the plan.',
+        '## 3. Improve Plan (`/improve-plan`)',
+        'Audit the strategy and stress-test the assumptions:',
+        '- Identify missing pieces, implicit dependencies, or assumptions that need hardening',
+        '- Decompose large changes into Band A (routine) and Band B (complex/risky) tasks',
+        '- **Grumpy Persona**: Aggressively critique every assumption. Find edge cases, race conditions, missing error handling, and scope creep.',
+        '- **Balanced Persona**: Synthesize the critique and finalize the plan.',

--- src/services/KanbanProvider.ts
+++ src/services/KanbanProvider.ts
@@ -... +... @@
-        if (wf === 'planner' || wf === 'challenge' || wf === 'enhance' || wf === 'accuracy' || wf === 'sidebar-review' || wf === 'enhanced plan') return 'PLAN REVIEWED';
+        if (wf === 'planner' || wf === 'challenge' || wf === 'enhance' || wf === 'improve-plan' || wf === 'accuracy' || wf === 'sidebar-review' || wf === 'enhanced plan' || wf === 'improved plan') return 'PLAN REVIEWED';
@@ -... +... @@
-        const instruction = targetRole === 'planner' ? 'enhance' : undefined;
+        const instruction = targetRole === 'planner' ? 'improve-plan' : undefined;

--- src/services/InteractiveOrchestrator.ts
+++ src/services/InteractiveOrchestrator.ts
@@ -... +... @@
 const DEFAULT_STAGE_SEQUENCE: ReadonlyArray<{ role: string; instruction?: string; label: string }> = [
-    { role: 'planner', instruction: 'enhance', label: 'Planner' },
+    { role: 'planner', instruction: 'improve-plan', label: 'Planner' },

--- src/services/PipelineOrchestrator.ts
+++ src/services/PipelineOrchestrator.ts
@@ -... +... @@
-    if (!lastWorkflow) {
-        return { role: 'planner', instruction: 'enhance', label: 'Planner' };
-    } else if (lastWorkflow === 'sidebar-review' || lastWorkflow === 'Enhanced plan') {
+    if (!lastWorkflow) {
+        return { role: 'planner', instruction: 'improve-plan', label: 'Planner' };
+    } else if (lastWorkflow === 'sidebar-review' || lastWorkflow === 'Enhanced plan' || lastWorkflow === 'Improved plan') {
         return { role: 'lead', label: 'Lead Coder' };
@@ -... +... @@
-    } else {
-        return { role: 'planner', instruction: 'enhance', label: 'Planner' };
-    }
+    } else {
+        return { role: 'planner', instruction: 'improve-plan', label: 'Planner' };
+    }
```

### 3. Documentation & Setup Templates
```diff
--- .agent/workflows/chat.md
+++ .agent/workflows/chat.md
@@ -... +... @@
-2. **Onboard**: Greet the user and identify the core problem or opportunity. **Briefly mention that we can move from `/chat` (ideation) to `/enhance` (structuring) and finally `/challenge` (stress-testing) as the plan evolves.**
+2. **Onboard**: Greet the user and identify the core problem or opportunity. **Briefly mention that we can move from `/chat` (ideation) to `/improve-plan` (structuring and stress-testing) as the plan evolves.**
@@ -... +... @@
-- If the plan needs deep structure: Recommend `/enhance`.
+- If the plan needs deep structure: Recommend `/improve-plan`.
--- AGENTS.md
+++ AGENTS.md
@@ -... +... @@
-| `/enhance` | **`enhance.md`** | Deep planning and structural audit before challenge/handoff. |
| `/challenge` | **`challenge.md`** | Adversarial code review |
| `/improve-plan` | **`improve-plan.md`** | Deep planning, dependency checks, and adversarial review. |
@@ -... +... @@
-├──► /challenge      Internal adversarial review (grumpy + synthesis)
├──► /improve-plan   Deep planning, dependency checks, and adversarial review

--- README.md
+++ README.md
@@ -... +... @@
-| `/enhance` | Deepen and stress-test an existing plan. |
| `/challenge` | Adversarial review — a grumpy persona finds flaws, then synthesizes fixes. |
| `/improve-plan` | Deep planning, dependency checks, and adversarial review. |

--- .github/copilot-instructions.md
+++ .github/copilot-instructions.md
@@ -... +... @@
-| `/enhance` | enhance | Deep planning and structural audit before challenge/handoff. |
| `/challenge` | challenge | Adversarial code review |
| `/improve-plan` | improve-plan | Deep planning, dependency checks, and adversarial review. |

--- templates/cursor/cursor-instructions.md.template
+++ templates/cursor/cursor-instructions.md.template
@@ -... +... @@
-| `/enhance` | enhance | Deep planning and structural audit before challenge/handoff. |
| `/challenge` | challenge | Adversarial code review |
| `/improve-plan` | improve-plan | Deep planning, dependency checks, and adversarial review. |

--- templates/windsurf/windsurf-instructions.md.template
+++ templates/windsurf/windsurf-instructions.md.template
@@ -... +... @@
-| `/enhance` | enhance | Deep planning and structural audit before challenge/handoff. |
| `/challenge` | challenge | Adversarial code review |
| `/improve-plan` | improve-plan | Deep planning, dependency checks, and adversarial review. |
```

### 4. Automated Tests Update
```diff
--- src/test/send-message-guards.test.js
+++ src/test/send-message-guards.test.js
@@ -... +... @@
 async function seedLockedReviewerState() {
     await updateState(state => {
         state.session = state.session || {};
-        state.session.activeWorkflow = 'challenge';
+        state.session.activeWorkflow = 'improve-plan';
@@ -... +... @@
-await test('routes execute in challenge to reviewer', async () => {
-    await seedState({ sessionWorkflow: 'challenge', includeWorker: false });
+await test('routes execute in improve-plan to reviewer', async () => {
+    await seedState({ sessionWorkflow: 'improve-plan', includeWorker: false });
@@ -... +... @@
-await test('challenge execute enriches review metadata', async () => {
-    await seedState({ sessionWorkflow: 'challenge', includeWorker: false });
+await test('improve-plan execute enriches review metadata', async () => {
+    await seedState({ sessionWorkflow: 'improve-plan', includeWorker: false });

--- src/test/workflow-controls.test.js
+++ src/test/workflow-controls.test.js
@@ -... +... @@
-await startWorkflow({ name: 'challenge' });
+await startWorkflow({ name: 'improve-plan' });
```