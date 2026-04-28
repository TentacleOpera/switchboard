# Make Improve-Plan Self-Contained and Remove MCP Tool Call

## Goal
Make `.agent/workflows/improve-plan.md` self-contained by embedding all section requirements from `.agent/rules/how_to_plan.md` (so planners only need to read one file), update the Kanban planner prompt to reference improve-plan (for improving existing plans), and remove the MCP tool call from improve-plan since it's not appropriate for copy-prompt scenarios. Keep `how_to_plan.md` for airlock/sprint scenarios where agents write new plans from scratch.

## Metadata
**Tags:** workflow, documentation, bugfix
**Complexity:** 5
**Repo:** switchboard

## User Review Required
> [!NOTE]
> This change affects the Kanban UI planner prompts and the improve-plan workflow definition. The airlock bundler and sprint prompt continue to use `how_to_plan.md` (correct for writing new plans from scratch). The Kanban planner (which improves existing plans) will now reference `improve-plan.md`.

## Complexity Audit
### Routine
- Update single line in `agentPromptBuilder.ts` (line 184) to reference correct workflow file (for improving existing plans)
- Update single line in `docs/TECHNICAL_DOC.md` (line 593) to reflect the new reference
- Remove Step 6 from `improve-plan.md` (3 lines)
- Update Step 4 in `improve-plan.md` to include the agent recommendation

### Complex / Risky
- Embedding all section requirements from `how_to_plan.md` into `improve-plan.md` Step 2 requires careful integration to ensure no information is lost and the workflow remains coherent — this is the core change and must be verified against the source template line-by-line
- The `get_kanban_state` MCP tool reference in the proposed Step 2 content (under Dependencies & Conflicts) is inconsistent with the plan's goal of making the workflow suitable for copy-prompt scenarios where MCP tools may not be available — this reference must be softened to a conditional instruction
- Reorganizing the `## Adversarial Synthesis` section to eliminate token-heavy Grumpy/Balanced subsections from plan files while preserving the process value — this changes the plan format and must be clearly communicated

## Edge-Case & Dependency Audit
- **Race Conditions:** None - these are file read/write operations with no concurrent state mutations
- **Security:** None - no security-sensitive changes
- **Side Effects:** Kanban planner prompts will now correctly reference the improve-plan workflow (for improving plans) which is self-contained. The improve-plan workflow will no longer require MCP tool calls, making it suitable for copy-prompt scenarios where MCP tools may not be available. The airlock bundler and sprint prompt correctly remain using `how_to_plan.md` for writing new plans from scratch.
- **Dependencies & Conflicts:** None — this plan is standalone. The active plan `sess_1777279374860` (Relax Plan Validation for Additional Plan Folder) touches plan validation logic but does not overlap with the files changed here.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) Conflating airlock bundler (new plans) with Kanban planner (improving plans) — mitigated by keeping separate file references; (2) `get_kanban_state` MCP reference incompatible with copy-prompt scenarios — mitigated by softening to conditional instruction; (3) Token bloat from full Grumpy/Balanced sections in every plan — mitigated by moving critiques to chat-only. Full Grumpy and Balanced critiques were produced during planning and included in the chat response for user review.

## Proposed Changes

### src/services/agentPromptBuilder.ts
#### MODIFY `src/services/agentPromptBuilder.ts`
- **Context:** The planner role prompt currently references `.agent/rules/how_to_plan.md` which is a template for creating new plans, but the planner role is used for improving existing plans in the Kanban
- **Logic:** Change line 184 to reference the correct workflow file `.agent/workflows/improve-plan.md` instead, and update the trailing word from "guide" to "workflow"
- **Implementation:**
```typescript
// Line 184 - change from:
MANDATORY: You MUST read and strictly adhere to \`.agent/rules/how_to_plan.md\` to format your output and ensure sufficient technical detail. Do not make assumptions about which files need to be changed; provide exact file paths and explicit implementation steps as required by the guide.

// To:
MANDATORY: You MUST read and strictly adhere to \`.agent/workflows/improve-plan.md\` to format your output and ensure sufficient technical detail. Do not make assumptions about which files need to be changed; provide exact file paths and explicit implementation steps as required by the workflow.
```
- **Edge Cases Handled:** None - this is a simple string replacement that aligns the prompt with the actual workflow being executed

### .agent/workflows/improve-plan.md
#### MODIFY `.agent/workflows/improve-plan.md`
- **Context:** The workflow is incomplete - it only mentions adding Complexity Audit and Dependencies sections, missing critical sections from how_to_plan.md like Metadata, Goal, Edge-Case & Dependency Audit, Proposed Changes, Verification Plan. Also Step 6 requires an MCP tool call that doesn't make sense for copy-prompt scenarios.
- **Logic:** Embed all section requirements from how_to_plan.md into Step 2 of improve-plan.md, soften the MCP tool reference for copy-prompt compatibility, remove Step 6 (MCP tool call), and update Step 4 to include the agent recommendation
- **Implementation:**

**Change 1 — Replace Step 2 entirely (lines 27–53) with expanded version:**

```markdown
2. **Improve the plan**
   - Fill in underspecified sections.
   - Break work into clear execution steps with file paths and line numbers.
   - Ensure the plan has ALL of the following sections (add any that are missing):

   **Required Sections (in order):**

   1. **## Goal** - 1-2 sentences summarizing the objective

   2. **## Metadata** (immediately after Goal) - Must include:
      - **Tags:** Comma-separated list chosen ONLY from: frontend, backend, authentication, database, UI, UX, devops, infrastructure, bugfix, documentation, reliability, workflow, testing, security, performance, analytics
      - **Complexity:** Integer 1-10 (scoring: 1-2 Very Low, 3-4 Low, 5-6 Medium, 7-8 High, 9-10 Very High)
      - **Repo:** Bare sub-repo folder name (e.g. 'be'), omit if not applicable

   3. **## User Review Required** - Any user-facing warnings, breaking changes, or manual steps required

   4. **## Complexity Audit** - Must have subsections:
      - ### Routine - List routine, safe changes
      - ### Complex / Risky - List complex logic, state mutations, or risky changes

   5. **## Edge-Case & Dependency Audit** - Must include:
      - **Race Conditions:** Analysis
      - **Security:** Analysis
      - **Side Effects:** Analysis
      - **Dependencies & Conflicts:** Human-readable prose explaining WHY each dependency/conflict matters. Reference plans by session IDs (sess_XXXXXXXXXXXXX). If MCP tools are available, use `get_kanban_state` to retrieve active session IDs; otherwise, document the uncertainty.

   6. **## Dependencies** - Machine-readable format (one per line): `sess_XXXXXXXXXXXXX — <topic>`. If no dependencies, write `None`.

   7. **## Adversarial Synthesis** - 2-3 sentence Risk Summary (e.g., "Key risks: X, Y, Z. Mitigations: A, B."). 
      - **Note:** Full Grumpy and Balanced critiques are produced during planning and shown in chat for user review; only the Risk Summary is persisted to the plan file to optimize tokens. The process rigor is preserved—only the storage location changes.

   8. **## Proposed Changes** - For each target file/component:
      - ### [Target File or Component]
        - #### [MODIFY / CREATE / DELETE] `path/to/file.ext`
        - **Context:** Why this file needs changing
        - **Logic:** Step-by-step breakdown of changes
        - **Implementation:** Complete code block, unified diff, or full function rewrite without truncation
        - **Edge Cases Handled:** How the code mitigates risks

   9. **## Verification Plan** - Must include:
      - ### Automated Tests - What existing or new tests need to be run/written

   - Do not add net-new product scope unless strictly implied by the existing plan.

   **Complexity Criteria:**

   **Routine:**
   - Single-file, localized changes (text updates, button renames, CSS tweaks)
   - Reuses existing patterns (calling an already-implemented handler, adding a field to an existing struct)
   - Low risk (no architectural changes, no multi-system coordination)
   - Small scope (typically <20 lines of code per change)

   **Complex / Risky:**
   - Multi-file coordination (changes span 3+ files with tight coupling)
   - New architectural patterns (introducing new state management, new message types, new DB schema)
   - Data consistency risks (race conditions, state synchronization across systems)
   - Breaking changes (modifying core data structures, changing column definitions)

   **"Routine + Moderate" (Mixed Complexity):**
   - Use when a plan has BOTH routine and moderate components
   - Majority is routine (70%+ of changes are straightforward)
   - One or two moderate pieces that add risk but are well-scoped
   - No architectural rewrites — the moderate parts extend existing patterns
```

**Change 2 — Update Step 4 (lines 59–62) to include the agent recommendation:**

```markdown
// From:
4. **Update the original plan file**
   - Write the improvement findings back into the same feature plan file.
   - Preserve all existing implementation steps, code blocks, and goal statements.
   - Mark completed checklist items when appropriate.

// To:
4. **Update the original plan file**
   - Write the improvement findings back into the same feature plan file.
   - Preserve all existing implementation steps, code blocks, and goal statements.
   - Mark completed checklist items when appropriate.
   - End with a recommendation: if complexity ≤ 6, say "Send to Coder". If complexity ≥ 7, say "Send to Lead Coder".
```

**Change 3 — Remove Step 6 entirely (lines 72–74):**

```markdown
// Delete these lines:
6. **Complete the workflow**
   - Call `complete_workflow_phase` with `workflow: "improve-plan"`, `phase: 1`, and the updated plan as the artifact.
   - End by recommending whether the plan should go to the Coder agent or the Lead Coder.
```

- **Edge Cases Handled:** The workflow now ends naturally after updating the plan file (Step 4) and the optional diagram generation (Step 5). All section requirements are embedded in Step 2 so planners don't need to reference how_to_plan.md. The `get_kanban_state` reference is conditional, preserving functionality when MCP tools are available while remaining usable in copy-prompt scenarios.

**Change 4 — Update Step 3 to specify chat-only critiques:**

```markdown
// Lines 55-57 - change from:
3. **Run the internal adversarial review**
   - First, produce a sharp Grumpy-style critique focused on assumptions, risks, race conditions, missing error handling, and validation gaps.
   - Immediately follow with a balanced synthesis that keeps valid concerns, rejects weak ones, and converges on the strongest execution strategy.

// To:
3. **Run the internal adversarial review**
   - First, produce a sharp Grumpy-style critique focused on assumptions, risks, race conditions, missing error handling, and validation gaps.
   - Immediately follow with a balanced synthesis that keeps valid concerns, rejects weak ones, and converges on the strongest execution strategy.
   - **Output:** Write the full Grumpy and Balanced critiques to the chat response for user review. In the plan file's `## Adversarial Synthesis` section, include only a 2-3 sentence Risk Summary (e.g., "Key risks: X, Y, Z. Mitigations: A, B.").
```

- **Edge Cases Handled:** Clarifies the split: full critiques for user communication (chat), condensed summary for coder reference (plan file). Preserves process rigor while optimizing tokens.

### .agent/rules/how_to_plan.md
#### MODIFY `.agent/rules/how_to_plan.md`
- **Context:** The `## Adversarial Synthesis` section template (lines 78-83) currently expects full Grumpy and Balanced subsections in the plan file. This is token-heavy and redundant since the critiques are primarily for process and user communication.
- **Logic:** Replace the full subsections with a streamlined Risk Summary format and add a note that full critiques go to chat
- **Implementation:**
```markdown
// Lines 78-83 - change from:
## Adversarial Synthesis
### Grumpy Critique
[Simulate the Grumpy Engineer: Attack the plan's weaknesses, missing error handling, and naive assumptions.]

### Balanced Response
[Simulate the Lead Developer: Address Grumpy's concerns and explain how the implementation steps below have been adjusted to prevent them.]

// To:
## Adversarial Synthesis
2-3 sentence summary of key risks identified and how they are mitigated in the implementation below.

> **Process Note:** Full Grumpy and Balanced critiques are produced during planning and included in the chat response for user review. Only this Risk Summary is persisted to the plan file to optimize token usage.
```
- **Edge Cases Handled:** None - this is a template change. Existing plans with the old format remain valid; new plans follow the streamlined format.

### docs/TECHNICAL_DOC.md
#### MODIFY `docs/TECHNICAL_DOC.md`
- **Context:** Line 593 documents that the Planner role references `.agent/rules/how_to_plan.md`, which will be incorrect after the fix
- **Logic:** Update the documentation to reflect the correct workflow reference
- **Implementation:**
```markdown
// Line 593 - change from:
- **Planner**: improve/enhance instructions referencing `.agent/rules/how_to_plan.md`, with plan file list

// To:
- **Planner**: improve/enhance instructions referencing `.agent/workflows/improve-plan.md`, with plan file list
```
- **Edge Cases Handled:** None - this is a documentation update to match the code change

## Verification Plan
### Automated Tests
- No automated tests exist for prompt generation; manual verification by:
  1. Triggering a planner prompt from the Kanban (copy button on card or batch button at top of Planned column)
  2. Verifying the prompt text references `.agent/workflows/improve-plan.md` instead of `.agent/rules/how_to_plan.md`
  3. Verifying the improve-plan.md file contains all section requirements and no MCP tool call step
  4. Testing that a planner using only improve-plan.md can produce a complete plan with all required sections
- **Grep verification:** Run `grep -rn "how_to_plan" src/services/agentPromptBuilder.ts src/services/TaskViewerProvider.ts src/webview/implementation.html` to confirm only the correct references remain:
  - `agentPromptBuilder.ts` should reference `improve-plan.md` (for improving plans)
  - `TaskViewerProvider.ts` should reference `how_to_plan.md` (for writing new plans)
  - `implementation.html` should reference `how_to_plan.md` (for writing new plans)

## Reviewer Pass Results

### Findings
| # | Severity | Description | Status |
|---|----------|-------------|--------|
| 1 | **CRITICAL** | `agentPromptBuilder.ts:184` — Raw backticks inside template literal break JavaScript. Original used escaped backticks `\`` but implementation used raw backticks, causing TS2339/TS2304/TS2552 errors. | **Fixed** |
| 2 | NIT | `improve-plan.md:51` — `kanban_operations` skill reference uses CLI script, not MCP tool call. Consistent with plan intent. | No change needed |
| 3 | NIT | `how_to_plan.md:25-26` — Grumpy/Balanced personas in Step 3 are process descriptions (not template). Template section was correctly updated. | No change needed |
| 4 | MAJOR | TypeScript compilation broken (consequence of #1). | **Fixed** (via #1) |

### Files Changed
- `src/services/agentPromptBuilder.ts:184` — Escaped backticks: `` `.agent/workflows/improve-plan.md` `` → `` \`.agent/workflows/improve-plan.md\` ``

### Validation Results
- **TypeScript check:** `npx tsc --noEmit` — 0 errors in `agentPromptBuilder.ts` (2 pre-existing errors in unrelated files)
- **Grep verification:** `grep -rn "how_to_plan" src/services/agentPromptBuilder.ts src/services/TaskViewerProvider.ts src/webview/implementation.html`
  - `agentPromptBuilder.ts`: No references to `how_to_plan` ✅
  - `TaskViewerProvider.ts`: 3 references in airlock bundler path ✅ (correct for new plans)
  - `implementation.html`: 1 reference in Sprint/NotebookLM prompt ✅ (correct for new plans)
- **MCP tool call removal:** `grep "complete_workflow_phase" .agent/workflows/improve-plan.md` — 0 results ✅
- **Section requirements embedding:** `improve-plan.md` Step 2 contains all 9 required sections ✅
- **Adversarial Synthesis template:** Both `improve-plan.md` and `how_to_plan.md` use Risk Summary format ✅

### Remaining Risks
- None. All plan requirements verified and CRITICAL/MAJOR findings resolved.
