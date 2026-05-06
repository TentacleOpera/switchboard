# Simplify Default Switchboard Prompt to Minimal Base

## Goal

Refactor the default Switchboard planner prompt to be minimal by default: just "Read this workflow file and follow it step-by-step". The improve-plan workflow itself should define the core structure (complexity audit, metadata, adversarial review, etc.). Checkboxes should only control optional add-ons that are NOT part of the standard workflow (aggressive pair programming, dependency check, design doc reference, git prohibition).

## Metadata

**Tags:** frontend, backend, workflow, testing
**Complexity:** 7

## User Review Required

- [ ] Confirm that moving core instructions from the prompt builder into improve-plan.md is acceptable (plan quality depends on the workflow file being comprehensive)
- [ ] Confirm git prohibition should become an optional checkbox (currently always-on; risk of accidental disable)
- [ ] Confirm the isCustomWorkflow branch should be unified with the new default path (removes code duplication)

## Current State

The default Switchboard planner prompt (lines 272-325 in `agentPromptBuilder.ts`) is a monolithic 50+ line prompt that includes:

1. Base instruction ("Please enhance/improve the following plans...")
2. Workflow file reference ("MANDATORY: You MUST read...")
3. Batch execution rules (parallel/sequential processing, isolation rules)
4. TODO filling instruction
5. Complexity audit instruction (Routine/Complex subsections)
6. Metadata section instruction (Tags, Complexity, Repo)
7. Scoring guide (1-10 complexity levels)
8. Adversarial review instruction (Grumpy + Balanced synthesis)
9. Chat critique directive (verbatim markdown output)
10. Plan update instruction (no truncation)
11. Agent recommendation instruction (Coder vs Lead Coder)
12. Focus directive (single source of truth)
13. Git prohibition directive
14. Dispatch context
15. Plan list
16. Aggressive pair programming directive (add-on)
17. Dependency check instruction (add-on)
18. Design doc reference (add-on)

The issue is that items 1-14 are hardcoded in the prompt builder, but they should be defined in the improve-plan workflow itself. Only items 16-18 (the add-ons) should be optional checkboxes.

**Key observation:** The `isCustomWorkflow` branch (lines 240-270) already implements the minimal prompt pattern for custom workflows. This plan extends that same pattern to the default workflow, then unifies both branches.

## Issues

1. **Prompt bloat**: Default prompt is massive and includes instructions that should be in the workflow file
2. **Not framework-agnostic**: The prompt assumes Switchboard methodology even when using custom workflows
3. **Workflow duplication**: Instructions like complexity audit, metadata, adversarial review are hardcoded but should be in improve-plan.md

## Complexity Audit

### Routine
- Add `gitProhibition` to `ROLE_ADDONS` planner array in `kanban.html` (line 2207-2212)
- Add `gitProhibition` to `DEFAULT_CONFIG.planner.addons` in `kanban.html` (line 2230-2234)
- Add `gitProhibition` checkbox HTML in `kanban.html` (near line 2049)
- Add `gitProhibition` to planner addon event listener array in `kanban.html` (line 2803)
- Add `gitProhibition` to `renderPlannerConfig` checkbox state loading in `kanban.html` (near line 2277-2279)
- Add `gitProhibitionEnabled` to `PromptBuilderOptions` interface in `agentPromptBuilder.ts` (line 65-90)
- Add `gitProhibitionEnabled` read from `plannerConfig` in `_getPromptsConfig` in `KanbanProvider.ts` (line 1902-1921)
- Add `gitProhibitionEnabled` save in `_savePromptsConfig` in `KanbanProvider.ts` (line 1923-1955)
- Pass `gitProhibitionEnabled` to `buildKanbanBatchPrompt` call in `_generateBatchPlannerPrompt` in `KanbanProvider.ts` (line 1981-1988)
- Update `refreshPreview` in `kanban.html` to include git prohibition in preview generation (near line 2336-2354)
- Add scoring guide and tag prohibition to `improve-plan.md` (minor content additions)

### Complex / Risky
- **Unify the planner prompt branches**: Replace the two-path structure (isCustomWorkflow vs default) with a single minimal prompt path. This is the core architectural change — the default Switchboard prompt (lines 272-325) must be replaced with the minimal pattern, and the `isCustomWorkflow` conditional removed. Risk: if improve-plan.md lacks sufficient detail, plan quality degrades.
- **Make git prohibition conditional**: Currently `GIT_PROHIBITION_DIRECTIVE` is always appended (lines 267, 313). Making it conditional via a checkbox introduces a foot-gun where users accidentally disable it. Mitigation: default to `true`, add clear tooltip warning.
- **Preserve designDocContent handling**: The current default prompt branch handles both `designDocLink` and `designDocContent` (pre-fetched Notion content, lines 318-323). The plan's Phase 1 code only handles `designDocLink`. Must include `designDocContent` in the unified path to avoid breaking Notion integration.

## Edge-Case & Dependency Audit

- **Race Conditions:** None identified. The prompt builder is synchronous and called per-dispatch.
- **Security:** Git prohibition checkbox could be accidentally unchecked, allowing agents to commit directly to repos. Mitigation: default to `true`, tooltip should warn "Include git prohibition directive (recommended)".
- **Side Effects:**
  - Plans generated with the new minimal prompt may have subtly different structure than plans generated with the old monolithic prompt, since the workflow file's instructions are less rigidly formatted than the hardcoded prompt.
  - The `refreshPreview` function in `kanban.html` generates preview prompts — it must be updated to reflect the new minimal prompt structure, otherwise the preview will be misleading.
- **Dependencies & Conflicts:**
  - **sess_1777862817416** — Fix Dependency Check Toggle Persistence (CODER CODED): Modified the same `_savePromptsConfig` / `_getPromptsConfig` patterns. Our git prohibition changes follow the same pattern; no conflict since that plan is already merged.
  - **sess_1777726305471** — Refactor improve-plan.md Workflow to Reduce Token Bloat (CODE REVIEWED): Already modified improve-plan.md. Our Phase 2 additions (scoring guide, tag prohibition) are additive and won't conflict.
  - **sess_1777950492978** — Fix Plan Delete Silent Failure and Zombie Plan Resurrection (PLAN REVIEWED): No overlap.
  - **Architectural Refactor 1-4** (CREATED): These refactor the event/state system. No direct overlap with prompt builder changes, but if they change how `workspaceState` is accessed, our `_getPromptsConfig` / `_savePromptsConfig` changes may need adjustment.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) Plan quality may degrade if improve-plan.md lacks the formatting precision of the hardcoded prompt — the workflow file uses descriptive prose while the prompt used rigid formatting directives. (2) Git prohibition as a checkbox is a security foot-gun despite defaulting to true. (3) The `designDocContent` (Notion pre-fetch) path is missing from the proposed code and will break Notion integration if not included. Mitigations: audit improve-plan.md for completeness before merging, keep git prohibition default=true with warning tooltip, include designDocContent in unified path.

## Proposed Changes

### [src/services/agentPromptBuilder.ts]

**Context:** The file contains two planner prompt branches: `isCustomWorkflow` (lines 240-270, minimal) and the default Switchboard prompt (lines 272-325, monolithic). Both branches share add-on logic (aggressive pair programming, dependency check, design doc). The goal is to unify them into a single minimal prompt path.

**Logic:** Remove the `isCustomWorkflow` conditional. Both branches become one: "Read workflow file and follow it step-by-step" + add-ons + dispatch context + plan list. Git prohibition becomes conditional via the new `gitProhibitionEnabled` option.

**Implementation:**

1. Add `gitProhibitionEnabled?: boolean` to `PromptBuilderOptions` interface (after line 83, before `workspaceRoot`).

2. In `buildKanbanBatchPrompt`, inside the `role === 'planner'` block (starting line 226):
   - Remove the `isCustomWorkflow` variable (line 228) and the entire `if (isCustomWorkflow) { ... }` block (lines 240-270).
   - Replace the entire planner prompt section (lines 226-325) with a unified minimal prompt:

```typescript
if (role === 'planner') {
    const workflowPath = options?.plannerWorkflowPath || DEFAULT_PLANNER_WORKFLOW;
    const gitProhibitionEnabled = options?.gitProhibitionEnabled ?? true;

    let workspaceTypeBlock = '';
    if (options?.workspaceRoot) {
        const { isMultiRepo, subRepoNames } = detectWorkspaceType(options.workspaceRoot);
        if (isMultiRepo) {
            workspaceTypeBlock = `\nWORKSPACE TYPE: This workspace is multi-repo. Valid sub-repo folder names are: ${subRepoNames.join(', ')}. Set **Repo:** to the appropriate sub-repo folder name.`;
        } else {
            workspaceTypeBlock = `\nWORKSPACE TYPE: This workspace is single-repo. Do NOT include a **Repo:** line in the plan metadata.`;
        }
    }

    // Minimal base prompt (framework-agnostic)
    let plannerPrompt = `Read ${workflowPath} and follow it step-by-step.\n\n`;

    // Append add-on instructions if enabled
    const aggressiveDirective = aggressivePairProgramming
        ? `\n\nPAIR PROGRAMMING OPTIMISATION: Aggressive mode is enabled. Assume the Coder agent is highly competent and can handle most implementation tasks independently, including multi-file changes, test updates, and straightforward refactors. Only classify tasks as Complex / Risky if they involve: (a) new architectural patterns or framework integrations the codebase hasn't used before, (b) security-sensitive logic (auth, crypto, permissions), (c) complex state machines or concurrency, or (d) changes that could silently break existing behaviour without obvious test failures. Everything else — even if it touches multiple files or requires careful reading — should be Routine.\n`
        : '';

    const dependencyCheckInstruction = dependencyCheckEnabled
        ? `\n\n[DEPENDENCY CHECK ENABLED]\nWhen loading the plan, also query active Kanban plans for dependencies using kanban_operations skill: run \`node .agent/skills/kanban_operations/get-state.js <workspace_id>\`. Inspect New and Planned columns for conflicts; exclude Completed, Intern, Lead Coder, Coder, and Reviewed columns. If query fails, note uncertainty in Edge-Case & Dependency Audit. Emit dependencies in plan's \`## Dependencies\` section as \`sess_XXXXXXXXXXXXX — <topic>\` lines, or \`None\` if none.\n`
        : '';

    const designDocLink = options?.designDocLink?.trim();
    if (designDocLink) {
        plannerPrompt += `DESIGN DOC REFERENCE:\nThe following design document provides the project's product requirements and specifications. Use it as foundational context for all planning decisions:\n${designDocLink}\n\n`;
    }

    plannerPrompt += aggressiveDirective + dependencyCheckInstruction;
    if (workspaceTypeBlock) {
        plannerPrompt += workspaceTypeBlock + '\n';
    }

    // Add dispatch context and plan list
    const { planList, dispatchContextBlock } = buildPromptDispatchContext(plans);
    const dispatchContextPrefix = dispatchContextBlock ? `${dispatchContextBlock}\n\n` : '';

    plannerPrompt += `${dispatchContextPrefix}${focusDirective}`;

    // Append git prohibition if enabled (add-on, default true)
    if (gitProhibitionEnabled) {
        plannerPrompt += GIT_PROHIBITION_DIRECTIVE;
    }

    plannerPrompt += `\n\nPLANS TO PROCESS:\n${planList}`;

    // Append design doc content (pre-fetched Notion) — Clarification: this was missing from original plan
    const designDocContent = options?.designDocContent?.trim();
    if (designDocContent) {
        plannerPrompt += `\n\nDESIGN DOC REFERENCE (pre-fetched from Notion):\nThe following is the full content of the project's design document / PRD. Use it as foundational context for all planning decisions:\n\n${designDocContent}`;
    }

    return applyPromptOverride(plannerPrompt, dispatchContextBlock, planList, promptOverride);
}
```

**Edge Cases:**
- When `gitProhibitionEnabled` is undefined, default to `true` for backward compatibility.
- `designDocContent` takes precedence over `designDocLink` (same as current behavior).
- `workspaceTypeBlock` must be included (was in the isCustomWorkflow branch but missing from original plan's Phase 1 code).

### [.agent/workflows/improve-plan.md]

**Context:** The workflow file (64 lines) already contains most core instructions. However, it's missing the detailed scoring guide and the explicit tag prohibition that were in the hardcoded prompt. These must be added so the minimal prompt produces equivalent output.

**Logic:** Add the scoring guide and tag prohibition to the workflow's Step 2 (Improve the plan) section.

**Implementation:**

After line 31 (the Tags list in Required Sections), add:

```markdown
      - Do NOT invent tags outside the allowed list. If no tags apply, write **Tags:** none
```

After line 52 (the Mixed complexity criteria), add the scoring guide:

```markdown
   **Scoring Guide:**
   - 1-2: Very Low — trivial config/copy changes
   - 3-4: Low — routine single-file changes
   - 5-6: Medium — multi-file changes, moderate logic
   - 7-8: High — new patterns, complex state, security-sensitive
   - 9-10: Very High — architectural changes, new framework integrations
```

Also, in Step 3 (line 55-58), add the chat critique directive explicitly:

```markdown
   - **Output:** Write the full Grumpy and Balanced critiques to the chat response as formatted markdown — do not only write them to the plan file. The user must be able to read the critique directly in chat without opening the plan. In the plan file's `## Adversarial Synthesis` section, include only a 2-3 sentence Risk Summary.
```

And in Step 2, after "Do not add net-new product scope" (line 53), add:

```markdown
   - You may add clarifying implementation detail only if strictly implied by existing requirements; label it as "Clarification", not a new requirement.
```

**Edge Cases:**
- The workflow file must remain concise to avoid token bloat (per the already-completed "Reduce Token Bloat" plan). Additions should be minimal.
- The `Repo:` metadata line should note "Omit if not a multi-repo setup" (already present at line 32).

### [src/webview/kanban.html]

**Context:** The kanban.html file contains the ROLE_ADDONS definition (line 2207), DEFAULT_CONFIG (line 2230), planner addon checkboxes (lines 2037-2052), renderPlannerConfig (lines 2274-2287), refreshPreview (lines 2336-2354), and planner addon event listeners (line 2803).

**Logic:** Add `gitProhibition` as a fourth planner addon checkbox, following the exact same pattern as the existing three addons.

**Implementation:**

1. **Add checkbox HTML** (after line 2051, after the aggressive pair programming checkbox):

```html
<label class="checkbox-item" title="Prohibit git commands in the prompt">
  <input type="checkbox" id="plannerAddonGitProhibition" checked>
  <span>Git Prohibition</span>
  <span class="tooltip">Include git prohibition directive (recommended)</span>
</label>
```

2. **Add to ROLE_ADDONS** (line 2211, after aggressivePairProgramming entry):

```javascript
{ id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive (recommended)', default: true }
```

3. **Add to DEFAULT_CONFIG** (line 2233, in planner.addons):

```javascript
addons: { dependencyCheck: true, designDoc: false, aggressivePairProgramming: false, gitProhibition: true }
```

4. **Add to renderPlannerConfig** (after line 2279):

```javascript
document.getElementById('plannerAddonGitProhibition').checked = !!config.addons?.gitProhibition;
```

5. **Add to planner addon event listener array** (line 2803):

Change from:
```javascript
['plannerAddonDependencyCheck', 'plannerAddonDesignDoc', 'plannerAddonAggressivePairProgramming'].forEach(id => {
```
To:
```javascript
['plannerAddonDependencyCheck', 'plannerAddonDesignDoc', 'plannerAddonAggressivePairProgramming', 'plannerAddonGitProhibition'].forEach(id => {
```

6. **Update refreshPreview** (near line 2336-2354): Add git prohibition to the preview prompt generation:

```javascript
const gitProhib = document.getElementById('plannerAddonGitProhibition')?.checked;
// ... in the prompt construction:
if (gitProhib) {
    prompt += `\nGIT POLICY: Do NOT execute state-mutating git commands...`;
}
```

**Edge Cases:**
- The `gitProhibition` checkbox must default to `checked` (matching `DEFAULT_CONFIG` default of `true`).
- The `plannerAddonGitProhibition` element ID follows the existing naming convention (`plannerAddon` + camelCase addon ID).

### [src/services/KanbanProvider.ts]

**Context:** The `_getPromptsConfig` method (line 1902) reads planner config from workspaceState and returns a config object. The `_savePromptsConfig` method (line 1923) persists config changes. The `_generateBatchPlannerPrompt` method (line 1957) calls `buildKanbanBatchPrompt` with the config.

**Logic:** Add `gitProhibitionEnabled` to the config pipeline: read from plannerConfig, save to VS Code settings, pass to prompt builder.

**Implementation:**

1. **In `_getPromptsConfig`** (line 1911-1920, in the return object), add:

```typescript
gitProhibitionEnabled: plannerConfig?.addons?.gitProhibition ?? config.get<boolean>('planner.gitProhibitionEnabled', true),
```

2. **In `_savePromptsConfig`** (after line 1950, before the catch), add:

```typescript
if (typeof msg.gitProhibitionEnabled === 'boolean') {
    await config.update('planner.gitProhibitionEnabled', msg.gitProhibitionEnabled, true);
}
```

3. **In `_generateBatchPlannerPrompt`** (line 1981-1988, in the `buildKanbanBatchPrompt` options), add:

```typescript
gitProhibitionEnabled: promptsConfig.gitProhibitionEnabled,
```

**Edge Cases:**
- Default to `true` when no config is set (backward compatibility).
- The `plannerConfig.addons.gitProhibition` comes from the kanban.html checkbox state stored in workspaceState.

### [src/test/minimal-prompt.test.js]

**Context:** New test file to verify the minimal prompt behavior.

**Logic:** Test that the default prompt is minimal, add-ons are appended when enabled, git prohibition is conditional, and design doc content is handled.

**Implementation:**

```javascript
describe('Minimal Planner Prompt', () => {
    test('default prompt is minimal', () => {
        const prompt = buildKanbanBatchPrompt('planner', [mockPlan], {
            plannerWorkflowPath: '.agent/workflows/improve-plan.md',
            aggressivePairProgramming: false,
            dependencyCheckEnabled: false,
            gitProhibitionEnabled: true
        });

        expect(prompt).toContain('Read .agent/workflows/improve-plan.md and follow it step-by-step');
        expect(prompt).not.toContain('Complexity Audit');
        expect(prompt).not.toContain('Metadata section');
        expect(prompt).not.toContain('Scoring guide');
        expect(prompt).toContain('GIT POLICY');
    });

    test('add-ons are appended when enabled', () => {
        const prompt = buildKanbanBatchPrompt('planner', [mockPlan], {
            plannerWorkflowPath: '.agent/workflows/improve-plan.md',
            aggressivePairProgramming: true,
            dependencyCheckEnabled: true
        });

        expect(prompt).toContain('PAIR PROGRAMMING OPTIMISATION');
        expect(prompt).toContain('DEPENDENCY CHECK ENABLED');
    });

    test('git prohibition is included when enabled (default)', () => {
        const prompt = buildKanbanBatchPrompt('planner', [mockPlan], {
            plannerWorkflowPath: '.agent/workflows/improve-plan.md'
        });

        expect(prompt).toContain('GIT POLICY');
    });

    test('git prohibition is excluded when disabled', () => {
        const prompt = buildKanbanBatchPrompt('planner', [mockPlan], {
            plannerWorkflowPath: '.agent/workflows/improve-plan.md',
            gitProhibitionEnabled: false
        });

        expect(prompt).not.toContain('GIT POLICY');
    });

    test('dispatch context and plan list are included', () => {
        const prompt = buildKanbanBatchPrompt('planner', [mockPlan], {
            plannerWorkflowPath: '.agent/workflows/improve-plan.md'
        });

        expect(prompt).toContain('PLANS TO PROCESS');
        expect(prompt).toContain('FOCUS DIRECTIVE');
    });

    test('design doc content is appended when provided', () => {
        const prompt = buildKanbanBatchPrompt('planner', [mockPlan], {
            plannerWorkflowPath: '.agent/workflows/improve-plan.md',
            designDocContent: 'Pre-fetched Notion content here'
        });

        expect(prompt).toContain('DESIGN DOC REFERENCE (pre-fetched from Notion)');
        expect(prompt).toContain('Pre-fetched Notion content here');
    });

    test('workspace type block is included for single-repo', () => {
        const prompt = buildKanbanBatchPrompt('planner', [mockPlan], {
            plannerWorkflowPath: '.agent/workflows/improve-plan.md',
            workspaceRoot: '/path/to/workspace'
        });

        expect(prompt).toContain('WORKSPACE TYPE: This workspace is single-repo');
    });
});
```

## Execution Steps Grouped by Complexity

### HIGH COMPLEXITY (execute first, require careful verification)

1. **Unify planner prompt branches in agentPromptBuilder.ts** (lines 226-325)
   - Remove the `isCustomWorkflow` conditional and the entire `if (isCustomWorkflow)` block (lines 240-270)
   - Replace the default prompt section (lines 272-325) with the unified minimal prompt
   - Add `gitProhibitionEnabled` option and conditional git prohibition logic
   - Include `designDocContent` handling (pre-fetched Notion) — Clarification: this was missing from original plan
   - Include `workspaceTypeBlock` — Clarification: this was in the isCustomWorkflow branch but missing from original plan's Phase 1 code
   - Risk: if improve-plan.md lacks sufficient detail, plan quality degrades

2. **Update improve-plan.md with missing core instructions** (lines 31, 52-53, 55-58)
   - Add tag prohibition after line 31
   - Add scoring guide after line 52
   - Add chat critique directive in Step 3
   - Add clarification instruction after line 53
   - Risk: workflow file must remain concise to avoid token bloat

3. **Make git prohibition conditional** (agentPromptBuilder.ts, kanban.html, KanbanProvider.ts)
   - Currently `GIT_PROHIBITION_DIRECTIVE` is always appended (lines 267, 313)
   - Making it conditional via a checkbox introduces a foot-gun where users accidentally disable it
   - Mitigation: default to `true`, add clear tooltip warning "(recommended)"

### LOW COMPLEXITY (execute after high-complexity steps)

4. **Add git prohibition checkbox to kanban.html** (lines 2049, 2207-2212, 2230-2234, 2277-2279, 2803)
   - Add checkbox HTML, ROLE_ADDONS entry, DEFAULT_CONFIG entry, renderPlannerConfig, event listener

5. **Add gitProhibitionEnabled to KanbanProvider.ts config pipeline** (lines 1902-1921, 1923-1955, 1981-1988)
   - Add to `_getPromptsConfig`, `_savePromptsConfig`, and `_generateBatchPlannerPrompt`
   - Clarification: `_savePromptsConfig` was missing from original plan

6. **Update refreshPreview in kanban.html** (lines 2336-2354)
   - Add git prohibition to preview prompt generation

7. **Create test file** `src/test/minimal-prompt.test.js`
   - 7 test cases: minimal default, add-ons, git prohibition on/off, dispatch context, design doc content, workspace type block

## Verification Plan

### Automated Tests

- **[CREATE]** `src/test/minimal-prompt.test.js` — 7 test cases covering: minimal default prompt, add-on appending, git prohibition conditional inclusion/exclusion, dispatch context, design doc content, workspace type block.

### Manual Verification

1. Generate a plan with default settings → verify prompt starts with "Read .agent/workflows/improve-plan.md and follow it step-by-step"
2. Enable Aggressive Pair Programming → verify directive is appended
3. Enable Dependency Check → verify directive is appended
4. Enable Design Doc → verify reference is appended
5. Enable Git Prohibition (default) → verify git prohibition directive is included
6. Disable Git Prohibition → verify git prohibition directive is NOT included
7. Verify the improve-plan.md workflow still contains all core instructions (complexity audit, metadata, scoring guide, tag prohibition, adversarial review, chat critique)
8. Test that plan generation produces same quality output as before
9. Verify the kanban.html preview reflects the new minimal prompt structure
10. Verify gitProhibitionEnabled persists across IDE restarts

## Success Criteria

- [ ] Default planner prompt is minimal: "Read workflow file and follow it step-by-step"
- [ ] Core instructions (complexity audit, metadata, scoring guide, adversarial review, etc.) are in improve-plan.md
- [ ] The `isCustomWorkflow` branch is removed — single unified prompt path
- [ ] Add-on checkboxes (aggressive pair programming, dependency check, design doc, git prohibition) work
- [ ] Git prohibition checkbox controls whether git prohibition directive is included (default: on)
- [ ] Dispatch context and plan list are included
- [ ] `designDocContent` (Notion pre-fetch) is handled correctly
- [ ] `workspaceTypeBlock` is included in the unified prompt
- [ ] Plan generation produces same quality output as before
- [ ] All automated tests pass
- [ ] gitProhibitionEnabled persists across IDE restarts

## Files to Modify

1. `src/services/agentPromptBuilder.ts` — Replace monolithic prompt with minimal base + add-ons; remove isCustomWorkflow branch; add gitProhibitionEnabled option
2. `.agent/workflows/improve-plan.md` — Add scoring guide, tag prohibition, chat critique directive, clarification instruction
3. `src/webview/kanban.html` — Add git prohibition checkbox, ROLE_ADDONS entry, DEFAULT_CONFIG entry, event listener, preview update
4. `src/services/KanbanProvider.ts` — Add gitProhibitionEnabled to _getPromptsConfig, _savePromptsConfig, and _generateBatchPlannerPrompt
5. `src/test/minimal-prompt.test.js` — NEW test file for minimal prompt verification

## Rollback Plan

Revert `agentPromptBuilder.ts` to restore original monolithic prompt (lines 272-325) and isCustomWorkflow branch (lines 240-270). Remove gitProhibition from kanban.html and KanbanProvider.ts.

## Risks

- **improve-plan.md may be missing instructions**: Need to verify the workflow file contains all necessary instructions (scoring guide, tag prohibition, chat critique directive)
- **Plan quality may degrade**: If improve-plan.md doesn't have comprehensive instructions, plan quality may suffer since the workflow file uses descriptive prose vs the rigid formatting of the hardcoded prompt
- **Add-on logic may need adjustment**: The add-on directives may need to be reworded to work with minimal base prompt
- **Git prohibition foot-gun**: Making git prohibition optional introduces risk of accidental disable; mitigated by default=true and warning tooltip

## Notes

This approach is much simpler than the original modular component system. Instead of 14 checkboxes, we only have 4 add-on checkboxes (3 existing + git prohibition). The core structure comes from the workflow file itself, which is the correct separation of concerns. The `isCustomWorkflow` branch is eliminated since both paths now produce the same minimal prompt.

**Recommendation:** Send to Lead Coder

---

## Review Results (Reviewer Pass — 2026-05-06)

### Stage 1: Grumpy Principal Engineer Findings

| ID | Severity | Finding |
|----|----------|---------|
| MAJOR-1 | MAJOR | Batch execution rules silently dropped from planner prompt. Old monolithic prompt included `${batchExecutionRules}` (CRITICAL INSTRUCTIONS: plan isolation, sequential execution, error continuation). New minimal prompt omits them entirely, and improve-plan.md doesn't include them either. Multi-plan dispatches have zero instruction to keep plans isolated or continue on error. |
| MAJOR-2 | MAJOR | Redundant `buildPromptDispatchContext(plans)` call inside planner block (line 271) shadows outer variables already computed at line 217. Pure waste — function reads filesystem and produces identical result. |
| NIT-1 | NIT | Preview order in `refreshPreview` (depCheck → aggPair → gitProhib → desDoc → splitPlan) doesn't match actual prompt order (designDocLink → aggressive + depCheck → splitPlan → workspaceType → dispatch + focus → gitProhib → planList → designDocContent). Approximation by design but misleading. |
| NIT-2 | NIT | `_savePromptsConfig` `gitProhibitionEnabled` path writes to VS Code settings but is never triggered by the checkbox UI (checkbox only sends `saveSetting` → workspaceState). Not a functional bug (workspaceState takes precedence) but VS Code settings key will be stale. |
| NIT-3 | NIT | Tag list expanded from 8 to 16 tags in improve-plan.md without plan documentation. Positive change but undocumented scope creep. |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| MAJOR-1 | **Fixed** | Added `batchExecutionRules` to planner prompt conditionally when `plans.length > 1`. Single-plan dispatches stay minimal; multi-plan dispatches get isolation/continuation rules. |
| MAJOR-2 | **Fixed** | Removed redundant inner `buildPromptDispatchContext` call and `dispatchContextPrefix` computation. Reused outer variables. |
| NIT-1 | **Deferred** | Preview is approximation by design. Not worth risk of introducing bug. |
| NIT-2 | **Deferred** | Not a functional bug. WorkspaceState path works correctly. |
| NIT-3 | **Kept** | Expanded tag list is an improvement. |

### Fixes Applied

1. **`src/services/agentPromptBuilder.ts`** (lines 248-251): Added conditional batch execution rules for multi-plan dispatches:
   ```typescript
   if (plans.length > 1) {
       plannerPrompt += `${batchExecutionRules}\n\n`;
   }
   ```

2. **`src/services/agentPromptBuilder.ts`** (line 275-276): Removed redundant `buildPromptDispatchContext` call and `dispatchContextPrefix` recomputation inside planner block. Now reuses outer variables from line 217-218.

3. **`src/test/minimal-prompt.test.js`**: Added 2 new test cases:
   - `testBatchExecutionRulesIncludedForMultiPlan` — verifies CRITICAL INSTRUCTIONS present for 2+ plans
   - `testBatchExecutionRulesExcludedForSinglePlan` — verifies CRITICAL INSTRUCTIONS absent for single plan

4. **`.agent/workflows/improve-plan.md`** (line 37): Added "- None" explicit directive for empty Complex/Risky: `### Complex / Risky (if empty, write "- None" explicitly)`

### Content Preservation Audit

Full audit of old monolithic prompt instructions vs. new system (improve-plan.md + agentPromptBuilder.ts):

| Old Directive | New Location | Status |
|-------------|--------------|--------|
| Fill out TODO/underspecified parts | improve-plan.md Step 2 | ✅ Covered |
| Scan Kanban for cross-plan conflicts | improve-plan.md Step 1 [OPTIONAL] | ✅ Covered (now optional) |
| Complexity Audit with Routine/Complex-Risky | improve-plan.md Required Sections #4 | ✅ Covered |
| If Complex/Risky empty, write "- None" | improve-plan.md Required Sections #4 | ✅ Fixed (added) |
| Metadata section with Tags/Complexity | improve-plan.md Required Sections #2 | ✅ Covered |
| Scoring guide (1-10) | improve-plan.md Scoring Guide | ✅ Covered |
| Do NOT invent tags | improve-plan.md Tags | ✅ Covered |
| Adversarial review: Grumpy then Balanced | improve-plan.md Step 3 | ✅ Covered |
| Chat critique directive (verbatim markdown) | improve-plan.md Step 3 Output | ✅ Covered |
| Do NOT truncate/delete existing steps | improve-plan.md CONTENT PRESERVATION + Step 4 | ✅ Covered |
| Agent recommendation (Coder vs Lead) | improve-plan.md Step 4 | ✅ Covered |
| No net-new product scope | improve-plan.md Complexity Criteria | ✅ Covered |
| Clarification labeling | improve-plan.md Complexity Criteria | ✅ Covered |
| Batch execution rules (isolation, continuation) | agentPromptBuilder.ts (multi-plan conditional) | ✅ Fixed |
| `how_to_plan.md` MANDATORY reference | Deliberately removed | ✅ Correct — that's for new-plan creation, not plan improvement |
| "Do not make assumptions about files" | improve-plan.md Step 2 | ✅ Covered ("file paths and line numbers") |

### Validation Results

- **TypeScript compilation** (`tsc -p tsconfig.test.json`): ✅ Pass (0 errors in modified files; 2 pre-existing errors in unrelated files)
- **Webpack build** (`npm run compile`): ✅ Pass (compiled successfully)
- **Test suite** (`node src/test/minimal-prompt.test.js`): ✅ All 9/9 tests pass (7 original + 2 new batch execution tests)

### Remaining Risks

- **NIT-1**: Preview order mismatch — deferred, not a functional issue
- **NIT-2**: `_savePromptsConfig` gitProhibitionEnabled dead path for checkbox — deferred, workspaceState path works
- **Plan quality with minimal prompt**: The workflow file (improve-plan.md) now carries the full burden of instruction quality. If the workflow file is incomplete or poorly structured, plan quality will degrade. The scoring guide, tag prohibition, chat critique directive, and clarification instruction have been verified as present.
- **Batch execution rules only for multi-plan**: Single-plan dispatches don't get batch execution rules, which is correct (they're unnecessary for a single plan). But if the agent platform has different behavior for single vs multi-plan, this conditional inclusion should be monitored.

### Final Verdict: **Ready**
