# Add Split Plan Checkbox to Kanban Prompts Menu

## Goal
Add a 'Split Plan' checkbox option to the planner role's prompt add-ons in the Kanban PROMPTS tab. When enabled, the planner prompt instructs the AI to produce **two separate plan files** per plan instead of one:

1. **Original file** (e.g. `plan_name.md`): Contains **only high-complexity (Complex / Risky) items**, plus full shared context. Includes a note in the Complexity Audit that routine/low-complexity items are assumed to be implemented by a Coder agent.
2. **Routine file** (e.g. `plan_name_routine.md`): Contains **only low-complexity (Routine) items**, plus full shared context. Self-contained and implementable by a Coder agent without cross-referencing the Complex plan.

Both files retain the same full contextual sections (Goal, Metadata, Current State, Edge-Case & Dependency Audit, Dependencies) so each can be executed independently.

## Metadata
**Tags:** frontend, UI, workflow
**Complexity:** 5

## User Review Required
- Confirm the default-off behavior (`splitPlan: false`) is acceptable for all workspaces
- Confirm the `_routine.md` suffix is acceptable (no configurable suffix in this iteration)
- Confirm the preview box should show the split-plan directive when the checkbox is enabled

## Current State
- The Kanban PROMPTS tab has role-based add-ons defined in `ROLE_ADDONS` in `kanban.html`
- Planner add-ons currently: `dependencyCheck`, `designDoc`, `aggressivePairProgramming`
- The `_getPromptsConfig()` method in `KanbanProvider.ts` reads planner add-ons from `workspaceState.get('switchboard.prompts.roleConfig_planner')`
- `agentPromptBuilder.ts` is the canonical prompt builder; all prompt generation routes through `buildKanbanBatchPrompt()`
- The planner prompt already instructs the AI to create a `## Complexity Audit` section with `### Routine` and `### Complex / Risky` subsections
- Pair Programming mode exists as a related but separate feature: it tells the planner to classify more tasks as Routine (`aggressivePairProgramming`) and dispatches Routine tasks to a Coder agent concurrently. Split Plan differs by physically splitting the plan into two files at planning time
- `TaskViewerProvider.ts` has existing boolean helpers like `_isAggressivePairProgrammingEnabled()`, `_isDependencyCheckEnabled()`, etc.

## Complexity Audit

### Routine
- [x] Add `splitPlan` addon to `ROLE_ADDONS.planner` array in `kanban.html` (id: `splitPlan`, label: `Split Plan`, tooltip: `Produce separate Routine and Complex plan files`, default: false)
- [x] Add `splitPlan: false` to `DEFAULT_CONFIG.planner.addons` in `kanban.html`
- [x] Add `plannerAddonSplitPlan` checkbox to the planner-specific add-on DOM in `kanban.html` (in the `#prompts-tab` section near the other planner checkboxes)
- [x] Add checkbox state sync in `handleRoleChange()` for `currentRole === 'planner'`
- [x] Add `plannerAddonSplitPlan` event listener in `initPromptsTabListeners()` for planner-specific add-ons
- [x] Add `splitPlan` field to the `_getPromptsConfig()` return object in `KanbanProvider.ts`
- [x] Add `_isSplitPlanEnabled()` helper in `TaskViewerProvider.ts` following the existing pattern

### Complex / Risky
- [x] Modify `agentPromptBuilder.ts`:
  - [x] Add `splitPlan?: boolean` to `PromptBuilderOptions` interface
  - [x] In the `role === 'planner'` branch, conditionally inject a `SPLIT PLAN MODE` directive when `splitPlan` is true
  - [x] The directive must work for both the **default Switchboard workflow** and **custom workflow** branches
  - [x] The injected text must be clear that the AI outputs **two distinct files** per plan, not a single file with a Complexity Audit section
  - [x] Must specify the naming convention: original file keeps its name; routine file is `<original_stem>_routine.md` (same directory)
- [x] Update `KanbanProvider._generateBatchPlannerPrompt()` to pass `splitPlan` into `buildKanbanBatchPrompt()` options
- [x] Update `TaskViewerProvider._generatePlannerPrompt()` (or equivalent dispatch path) to pass `splitPlan` option
- [x] Add/update tests in `test/agent-prompt-builder-subagents.test.js` to assert split-plan prompt generation

## Review Results

### Adversarial Findings (Grumpy Principal Engineer) — Pass 1

**😠 CRITICAL: LEAKY ABSTRACTIONS & COUPLING**
Hardcoded `plannerAddonSplitPlan` into `initPromptsTabListeners` bypasses the generic `renderRoleAddons` system, creating a "Special Snowflake" problem for the planner role. Accepted for now due to unique Planner UI structure, but noted as architectural debt.

**😤 MAJOR: PREVIEW FIDELITY**
The initial preview was too concise, not reflecting the actual detail of the split-plan manifesto sent to the agent. Updated to be more descriptive of the two-file requirement.

**🙄 NIT: WHITESPACE CARNAGE**
Concatenation of multiple directives resulted in excessive newlines (`\n\n\n\n`). Applied regex cleanup to ensure standard double-newline spacing.

### Balanced Synthesis — Pass 1
The implementation is solid and correctly covers all three primary prompt generation call sites (`_buildKanbanBatchPrompt`, `_copyPromptForPlan`, `_dispatchPlanToRole`). The minor refinements for delimiter cleanup and preview clarity have been applied.

---

### Adversarial Findings (Grumpy Principal Engineer) — Pass 2 (Reviewer-Executor)

**🔥 CRITICAL: BROKEN TEMPLATE LITERAL — FILE WON'T COMPILE**
The refactoring of the planner prompt in `agentPromptBuilder.ts` shattered a multi-line template literal. The original code had ONE template literal spanning ~30 lines. The splitPlan change closed that literal on line 291, opened a NEW one on line 292, and closed it again on the same line — orphaning lines 293-325 as raw text outside any string context. TypeScript saw `Do not add net-new product requirements or scope.` as a statement and choked. `npx tsc --noEmit` produced 50+ errors from this single breakage. The tests only passed because they imported from `out/services/agentPromptBuilder` (previously compiled JS), not the broken TS source. **FIX APPLIED:** Removed premature closing backtick on line 292, letting the template literal continue through line 325 where `${planList}\``;` properly closes it.

**😤 MAJOR: PLAN FILE REFERENCES NON-EXISTENT METHOD NAMES**
Plan file referenced `_copyPromptForPlan` and `_dispatchPlanToRole` as call sites. These methods do not exist. The actual method names are `_handleCopyPlanLink` and `_handleTriggerAgentActionInternal`. **FIX APPLIED:** Updated plan file to reference correct method names.

**😤 MAJOR: `dependencyCheckEnabled` MISSING FROM TWO PLANNER CALL SITES (PRE-EXISTING)**
`_handleCopyPlanLink` and `_handleTriggerAgentActionInternal` planner dispatch do NOT pass `dependencyCheckEnabled` to `buildKanbanBatchPrompt`. Since the default is `true`, dependency check is always forced on for Copy Prompt and Advance dispatch regardless of the user's setting. This is a pre-existing defect, not introduced by splitPlan. **DEFERRED** — separate issue needed.

**🙄 NIT: CUSTOM WORKFLOW PATH LACKS WHITESPACE CLEANUP**
The original Switchboard prompt path uses `.replace(/\n{3,}/g, '\n\n')` but the custom workflow path has no such cleanup. Minor inconsistency. **DEFERRED.**

**🙄 NIT: `_isSplitPlanEnabled` LACKS VS CODE CONFIG FALLBACK**
Unlike `_isAggressivePairProgrammingEnabled` which falls back to VS Code config, `_isSplitPlanEnabled` just returns `false`. Acceptable per plan scope. **DEFERRED.**

### Balanced Synthesis — Pass 2
| Finding | Severity | Action |
|---------|----------|--------|
| Broken template literal (lines 292-293) | CRITICAL | **Fixed.** Removed premature closing backtick. |
| Plan file wrong method names | MAJOR | **Fixed.** Updated to actual method names. |
| `dependencyCheckEnabled` missing from 2 call sites | MAJOR | **Deferred.** Pre-existing bug; separate issue. |
| Custom workflow no whitespace cleanup | NIT | **Deferred.** Low impact. |
| No VS Code config fallback | NIT | **Deferred.** By design. |

## Files Modified
- `src/webview/kanban.html`
- `src/services/KanbanProvider.ts`
- `src/services/agentPromptBuilder.ts`
- `src/services/TaskViewerProvider.ts`
- `src/test/agent-prompt-builder-subagents.test.js`

## Validation Results

### Automated Tests
- `testSplitPlanDefaultDisabled`: **PASS**
- `testSplitPlanEnabledDefaultWorkflow`: **PASS**
- `testSplitPlanEnabledCustomWorkflow`: **PASS**
- `testSplitPlanWithAggressivePairProgramming`: **PASS**

### TypeScript Compilation (Post-Fix)
- `npx tsc --noEmit`: **0 errors in splitPlan-related files** (2 pre-existing errors in unrelated files: `ClickUpSyncService.ts` and `KanbanProvider.ts` import path extensions)

### Manual Verification
- UI sync verified: Checkbox persists and updates correctly.
- Preview sync verified: Preview textarea correctly displays enhanced split-plan summary.
- Prompt wiring verified: "Copy Prompt" and "Advance" paths correctly include the split directive.

### Reviewer-Executor Fixes Applied
- **CRITICAL FIX**: `agentPromptBuilder.ts` line 292 — removed premature closing backtick on template literal, restoring the multi-line prompt string that was orphaned (lines 293-325).
- **MAJOR FIX**: Plan file — corrected method name references from `_copyPromptForPlan` → `_handleCopyPlanLink` and `_dispatchPlanToRole` → `_handleTriggerAgentActionInternal`.

## Remaining Risks
- **AI Adherence**: While the prompt is detailed, some models might still hallucinate the file splitting. Monitor output quality.
- **Filename Conflicts**: No hard-coded check for existing `_routine.md` files; relies on AI's ability to overwrite if instructed.
- **Pre-existing `dependencyCheckEnabled` gap**: `_handleCopyPlanLink` and `_handleTriggerAgentActionInternal` planner dispatches don't pass `dependencyCheckEnabled`, causing it to always default to `true` regardless of user setting. This is a pre-existing defect unrelated to splitPlan but should be filed as a separate issue.


## Edge-Case & Dependency Audit
- **Interaction with Pair Programming**: `splitPlan` and `aggressivePairProgramming` can be enabled simultaneously. The prompt should include both directives without contradiction. `aggressivePairProgramming` affects classification; `splitPlan` affects output file structure. Order: classify first (aggressive), then split.
- **Custom workflows**: Custom workflow mode (`isCustomWorkflow === true`) generates a shorter prompt. The split directive must still be injected clearly so custom-workflow users know to produce two files.
- **Single plan vs batch**: The directive must work when `plans.length === 1` and `plans.length > 1`.
- **Filename collisions**: If a `_routine.md` file already exists, the prompt should instruct the AI to overwrite it (same as how plan improvement overwrites the original).
- **Backward compatibility**: When `splitPlan` is disabled (default), the planner prompt must be byte-identical to the current output.
- **Preview sync**: The `refreshPreview()` function in `kanban.html` manually constructs the preview prompt by reading each planner checkbox. If `plannerAddonSplitPlan` is not included in this function, the preview will not update when the checkbox is toggled, creating broken UX.
- **TaskViewerProvider.ts wiring**: There are THREE distinct call sites that invoke `buildKanbanBatchPrompt` for the planner role: `_buildKanbanBatchPrompt` (canonical path, line ~5375), `_handleCopyPlanLink` (clipboard copy, line ~11726), and `_handleTriggerAgentActionInternal` (autoban dispatch, line ~13553). All three must read `_isSplitPlanEnabled()` and pass the option. Missing any one will cause prompt divergence between Copy Prompt, Advance, and autoban dispatch.
- **Race Conditions / Security**: None. This is a pure prompt-generation change; no file writes, network calls, or concurrent state mutations.
- **Side Effects**: None beyond increased prompt token count.
- **Dependencies & Conflicts**: Active architectural refactor plans in CREATED (`sess_1777759330075`, `sess_1777759329250`, `sess_1777759332501`, `sess_1777759332549`) may touch `KanbanProvider.ts`, `TaskViewerProvider.ts`, and `kanban.html`. Coordinate merge order or isolate changes to avoid conflicts.

## Dependencies
- `sess_1777759330075` — Architectural Refactor 1/4: Event System Foundation (CREATED — may touch KanbanProvider.ts / kanban.html)
- `sess_1777759329250` — Architectural Refactor 2/4: Update All Call Sites (CREATED — may touch KanbanProvider.ts / TaskViewerProvider.ts)
- `sess_1777759332501` — Architectural Refactor 3/4: Remove Distributed State (CREATED — may touch KanbanProvider.ts)
- `sess_1777759332549` — Architectural Refactor 4/4: Validation & Cleanup (CREATED — may touch KanbanProvider.ts / TaskViewerProvider.ts)

*Note: These dependencies are potential file-conflict risks, not hard functional dependencies. If the refactor plans land first, this plan may need minor rebasing.*

## Adversarial Synthesis
Key risks: (1) The injected split-plan text could accidentally leak into the default (non-split) prompt path if the conditional gate is imprecise; mitigate with strict `if (splitPlan)` guards and a regression test asserting the default prompt excludes "SPLIT PLAN" and "_routine.md". (2) Three separate `buildKanbanBatchPrompt` call sites in `TaskViewerProvider.ts` must all receive the `splitPlan` option; missing one creates silent prompt divergence between Copy Prompt, Advance, and autoban dispatch. (3) Four active architectural refactor plans in CREATED may modify the same source files; coordinate landing order or expect rebase work.

## Proposed Changes

### Phase 1: UI Add-on (kanban.html)

1. **Add to ROLE_ADDONS**
   - Location: `ROLE_ADDONS.planner` array, line ~2208
   - Add: `{ id: 'splitPlan', label: 'Split Plan', tooltip: 'Produce separate Routine and Complex plan files', default: false }`

2. **Add to DEFAULT_CONFIG**
   - Location: `DEFAULT_CONFIG.planner.addons`, line ~2233
   - Add: `splitPlan: false`

3. **Add checkbox to planner add-on section**
   - Location: In the `#prompts-tab` DOM near existing planner checkboxes (around the `plannerAddonAggressivePairProgramming` checkbox, line ~2048)
   - Add:
     ```html
     <label class="checkbox-item" title="Produce separate Routine and Complex plan files">
       <input type="checkbox" id="plannerAddonSplitPlan">
       <span>Split Plan</span>
       <span class="tooltip">Produce separate Routine and Complex plan files</span>
     </label>
     ```

4. **Sync in handleRoleChange**
   - Location: `if (currentRole === 'planner')` block, line ~2274
   - Add: `document.getElementById('plannerAddonSplitPlan').checked = !!config.addons?.splitPlan;`

5. **Event listener in initPromptsTabListeners**
   - Location: planner-specific add-on listener array, line ~2803
   - Add `'plannerAddonSplitPlan'` to the array:
     ```javascript
     ['plannerAddonDependencyCheck', 'plannerAddonDesignDoc', 'plannerAddonAggressivePairProgramming', 'plannerAddonSplitPlan'].forEach(id => { ... });
     ```
   - The existing loop handles the rest via `id.replace('plannerAddon', '').toLowerCase()`
   - For `'plannerAddonSplitPlan'`, `addonId` = `'SplitPlan'`, `finalAddonId` = `'splitPlan'` — correct.

6. **Sync in refreshPreview**
   - Location: `refreshPreview()` function, line ~2337
   - After `const desDoc = document.getElementById('plannerAddonDesignDoc').checked;`, add:
     ```javascript
     const splitPlan = document.getElementById('plannerAddonSplitPlan').checked;
     ```
   - After the `desDoc` block (around line ~2354), add:
     ```javascript
     if (splitPlan) {
         prompt += `SPLIT PLAN MODE: Enabled. Planner will produce TWO files per plan (original + _routine.md).\n\n`;
     }
     ```

### Phase 2: Prompt Configuration (KanbanProvider.ts)

1. **_getPromptsConfig**
   - Location: return object, line ~1911
   - Add: `splitPlan: plannerConfig?.addons?.splitPlan ?? false`

2. **_savePromptsConfig** (Clarification)
   - No changes required. The planner role config is saved as an opaque object via `workspaceState` through `saveRoleConfig('planner')` in `kanban.html`. The new `splitPlan` boolean is automatically persisted as part of `roleConfigs.planner.addons`.

### Phase 3: Prompt Builder (agentPromptBuilder.ts)

1. **Add to PromptBuilderOptions**
   - Location: interface definition, line ~65
   - Add: `/** When true, planner produces separate Routine and Complex plan files. */ splitPlan?: boolean;`

2. **Extract option in buildKanbanBatchPrompt**
   - Location: destructuring block, line ~188
   - Add: `const splitPlan = options?.splitPlan ?? false;`

3. **Inject split directive in default workflow branch**
   - Location: `if (role === 'planner')` → default Switchboard prompt (after `isCustomWorkflow === false`), line ~280
   - After `const designDocLink = options?.designDocLink?.trim();`, define:
     ```typescript
     const splitPlanDirective = splitPlan
         ? `\n\nSPLIT PLAN MODE: For each plan, produce TWO separate markdown files instead of one.\n\n1. **Original file** (keep existing filename): Contains ONLY the Complex / Risky implementation steps. Routine steps are REMOVED from Proposed Changes. In the ## Complexity Audit section, write under ### Routine: \"See <filename_stem>_routine.md — handled by Coder agent.\" The ### Complex / Risky section contains the actual complex steps. Include all shared context sections (Goal, Metadata, Current State, Edge-Case & Dependency Audit, Dependencies, Adversarial Synthesis) verbatim. Add a note: \"Assume all Routine items from the companion _routine.md file are already implemented by a Coder agent.\"\n\n2. **Routine file** (\`<filename_stem>_routine.md\`): Contains ONLY the Routine implementation steps. Complex steps are REMOVED from Proposed Changes. In the ## Complexity Audit section, write under ### Complex / Risky: \"See <original_filename> — handled by Lead Coder.\" The ### Routine section contains the actual routine steps. Include all shared context sections verbatim so the file is fully self-contained.\n\nApply this two-file output to EVERY plan in the batch.`
         : '';
     ```
   - Append `splitPlanDirective` to `plannerPrompt` before the `MANDATORY:` line in the default workflow branch.

4. **Inject split directive in custom workflow branch**
   - Location: `if (isCustomWorkflow)` branch, line ~242
   - After `plannerPrompt += aggressiveDirective + dependencyCheckInstruction;`, add:
     ```typescript
     if (splitPlan) {
         plannerPrompt += `\n\nSPLIT PLAN MODE: Produce TWO files per plan. Original file = Complex / Risky only. Companion file (\`<stem>_routine.md\`) = Routine only. Both files must include full shared context (Goal, Metadata, Current State, Edge-Case audit, Dependencies). Original file notes: \"Assume Routine items implemented by Coder agent.\"`;
     }
     ```

### Phase 4: TaskViewerProvider.ts Helper

1. **Add _isSplitPlanEnabled**
   - Location: near existing `_isAggressivePairProgrammingEnabled()` (~13006)
   - Add:
     ```typescript
     private _isSplitPlanEnabled(): boolean {
         const plannerConfig: any = this._context.workspaceState.get('switchboard.prompts.roleConfig_planner');
         if (plannerConfig?.addons?.splitPlan !== undefined) return plannerConfig.addons.splitPlan;
         return false;
     }
     ```

### Phase 5: Wiring

1. **KanbanProvider._generateBatchPlannerPrompt**
   - Location: `buildKanbanBatchPrompt` call, line ~1981
   - Add to options object: `splitPlan: promptsConfig.splitPlan`

2. **TaskViewerProvider._buildKanbanBatchPrompt**
   - Location: line ~5375
   - After `const aggressivePairProgramming = this._isAggressivePairProgrammingEnabled();`, add:
     ```typescript
     const splitPlan = this._isSplitPlanEnabled();
     ```
   - In the `buildKanbanBatchPrompt` call options (line ~5394), add: `splitPlan`

3. **TaskViewerProvider._handleCopyPlanLink**
   - Location: `buildKanbanBatchPrompt` call, line ~11726
   - In the options object, add: `splitPlan: this._isSplitPlanEnabled()`

4. **TaskViewerProvider._handleTriggerAgentActionInternal (planner branch)**
   - Location: `buildKanbanBatchPrompt` call, line ~13553
   - In the options object, add: `splitPlan: this._isSplitPlanEnabled()`

## Files to Modify

1. `/src/webview/kanban.html` — Add `splitPlan` addon checkbox, event listeners, preview support
2. `/src/services/KanbanProvider.ts` — Add `splitPlan` to `_getPromptsConfig()`
3. `/src/services/agentPromptBuilder.ts` — Add `splitPlan` to options, inject split directives
4. `/src/services/TaskViewerProvider.ts` — Add `_isSplitPlanEnabled()` helper
5. `/src/test/agent-prompt-builder-subagents.test.js` — Add test coverage for split-plan prompt generation

## Verification Plan

### Automated Tests
- Add test in `/src/test/agent-prompt-builder-subagents.test.js`:
  - `testSplitPlanDefaultDisabled`: Assert that default planner prompt (no `splitPlan` option) does NOT contain "SPLIT PLAN" or "_routine.md"
  - `testSplitPlanEnabledDefaultWorkflow`: Assert that planner prompt with `splitPlan: true` and default workflow contains "SPLIT PLAN MODE", "_routine.md", and "Apply this two-file output to EVERY plan"
  - `testSplitPlanEnabledCustomWorkflow`: Assert that planner prompt with `splitPlan: true` and custom workflow contains "SPLIT PLAN MODE" and "_routine.md"
  - `testSplitPlanWithAggressivePairProgramming`: Assert that planner prompt with both `splitPlan: true` and `aggressivePairProgramming: true` contains both directives without contradiction

### Manual Verification
1. **UI Verification**
   - Open Kanban board → PROMPTS tab
   - Select "planner" role
   - Verify "Split Plan" checkbox appears below existing add-ons
   - Check/uncheck the box, reload webview, verify state persists

2. **Preview Verification**
   - Enable "Split Plan" while in the PROMPTS tab
   - Verify the preview textarea shows the "SPLIT PLAN MODE: Enabled..." line
   - Disable "Split Plan"
   - Verify the preview textarea no longer contains the split-plan text

3. **Prompt Verification**
   - Enable "Split Plan", click "Copy Prompt" for a plan
   - Verify prompt contains "SPLIT PLAN MODE" and instructions for two files
   - Disable "Split Plan", copy prompt again
   - Verify prompt does NOT contain "SPLIT PLAN" or "_routine.md"
   - Compare default (non-split) prompt against pre-change output to ensure byte-identical behavior

4. **Custom Workflow Verification**
   - Set workflow path to a custom file (e.g. `.agent/workflows/custom.md`)
   - Enable "Split Plan", copy prompt
   - Verify the shorter custom prompt still contains the concise split directive

5. **Edge Cases**
   - Enable both "Aggressive Pair Programming" and "Split Plan"
   - Verify prompt contains both directives without contradiction
   - Test with batch of 2+ plans; verify directive says "Apply this two-file output to EVERY plan"

## Risks and Considerations

- **Prompt token count**: The split directive adds ~200 tokens to the planner prompt. Acceptable given the planner prompts are already long.
- **AI comprehension**: The directive must be unambiguous so the AI (Claude, GPT-4, etc.) consistently produces two files. Using explicit filename conventions (`<stem>_routine.md`) and clear section-level instructions mitigates ambiguity.
- **Backward compatibility**: Default behavior is unchanged (`splitPlan: false`). No migration needed.

## Future Enhancements (Out of Scope)

- Automatic `_routine.md` file creation by Switchboard instead of relying on the AI to produce it
- A "Merge Plans" feature to recombine split plans after execution
- Configurable suffix instead of hardcoded `_routine`

## Recommendation

**Send to Coder**
