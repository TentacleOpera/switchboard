# Fix Role Addon Configuration

## Goal

Correct logical inconsistencies in role addon configuration across `sharedDefaults.js`, `KanbanProvider.ts`, and `agentPromptBuilder.ts` so that skip-compilation/skip-tests, pair-programming, and accurate-coding addons are available to the correct roles (coding roles: lead, coder, intern, reviewer) and absent from non-applicable roles (planner, researcher).

## Metadata

**Tags:** frontend, backend, UI, bugfix
**Complexity:** 5

## User Review Required

> [!IMPORTANT]
> **Accuracy of `accurateCodingEnabled` as shared vs. per-role**: The current codebase uses a single boolean for `accurateCodingEnabled` shared across coder/lead. The plan proposes adding intern to the fallback chain (`coderConfig ?? leadConfig ?? internConfig`), but this means intern's toggle can be masked by coder or lead returning `false`. A per-role map (matching `pairProgrammingEnabled`) is the safer design. See Adversarial Synthesis below. Executor should implement as a per-role map unless the user prefers the simpler fallback chain.

> [!IMPORTANT]
> **`_generateBatchExecutionPrompt` scope**: This function (the copy-to-clipboard path) currently does not pass `skipCompilation`, `skipTests`, `pairProgrammingEnabled`, or `accurateCodingEnabled` for intern. Whether to add these to the copy path is a design decision — currently the copy path intentionally omits accuracy mode (comment at line 2589 explains why). Executor should skip accuracy mode for the copy path but should add `skipCompilation`/`skipTests` for intern in that path if desired.

## Complexity Audit

### Routine
- Updating `DEFAULT_ROLE_CONFIG` addon objects in `sharedDefaults.js` (add/remove keys)
- Updating `ROLE_ADDONS` arrays in `sharedDefaults.js` (add/remove addon metadata entries)
- Adding `intern` to `pairProgrammingEnabled` map in `_getPromptsConfig`
- Extending the `accurateCodingEnabled` chain (or map) to include intern
- Adding `skipCompilationByRole` and `skipTestsByRole` maps to `_getPromptsConfig`
- Injecting `skipBlock` into intern `promptParts` in `agentPromptBuilder.ts`
- Adding pair programming and accuracy support to the intern role block in `agentPromptBuilder.ts`

### Complex / Risky
- Updating **three separate call sites** in `KanbanProvider.ts` that hardcode `role === 'planner'` for skip flags — missing any one leaves the preview/dispatch broken for the new roles
- Restructuring `accurateCodingEnabled` from a shared scalar to a per-role map requires updating every consumer downstream

## Edge-Case & Dependency Audit

### Race Conditions
- None. All changes are config loading and prompt string assembly; no concurrent state mutations.

### Security
- None. Addons only affect prompt text injection; no auth or permissions changes.

### Side Effects
- **Preview vs. dispatch inconsistency**: There are three call sites in `KanbanProvider.ts` (lines 2188, 2445, 5927) that pass `skipCompilation`/`skipTests` with a planner-only guard. All three must be updated to use `promptsConfig.skipCompilationByRole?.[role]` to keep preview and dispatch in sync.
- **Copy-to-clipboard path (`_generateBatchExecutionPrompt`)**: Currently does not pass skip options for any role. Adding skip support for intern in this path requires extending this function too (currently out of scope for accuracy mode but in scope for skip flags).

### Dependencies & Conflicts
- No cross-plan dependencies identified.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) Three separate KanbanProvider call sites must all be updated or previews/dispatch diverge for the new roles; (2) `accurateCodingEnabled` as a shared scalar masks intern's own setting. Mitigations: Implement `accurateCodingEnabled` as a per-role map matching `pairProgrammingEnabled`; explicitly enumerate all three KanbanProvider call sites in execution steps.

## Problem Statement
The role addon configuration in `src/webview/sharedDefaults.js` has several logical inconsistencies that need to be corrected.

## Changes Required

### 1. Add Missing Addons to Intern
**File**: `src/webview/sharedDefaults.js`

**Current Intern addons**:
```javascript
intern: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: false } }
```

**Change to**:
```javascript
intern: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: false } }
```

**Rationale**: Intern is a coding role and should have access to the same coding-focused capabilities as Coder and Lead Coder.

### 2. Remove Caveman Output from Researcher
**File**: `src/webview/sharedDefaults.js`

**Current Researcher addons**:
```javascript
researcher: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, researchEnabled: false, clearAntigravityContext: false, cavemanOutput: false } }
```

**Change to**:
```javascript
researcher: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, researchEnabled: false, clearAntigravityContext: false } }
```

**Rationale**: Research work requires full verbose output for proper analysis. Caveman output compression is inappropriate for research tasks.

**Also update ROLE_ADDONS for researcher** (remove `cavemanOutput` entry):
```javascript
researcher: [
    { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
    { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
    { id: 'researchEnabled', label: 'Deep Research', tooltip: 'Enable deep research mode', default: false },
    { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
]
```

### 3. Add Recompile and Automated Tests to Lead Coder, Coder, and Intern
**File**: `src/webview/sharedDefaults.js`

**Current Lead Coder addons**:
```javascript
lead: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, leadChallenge: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: false } }
```

**Change to**:
```javascript
lead: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, leadChallenge: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: false, skipCompilation: false, skipTests: false } }
```

**Current Coder addons**:
```javascript
coder: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: false } }
```

**Change to**:
```javascript
coder: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: false, skipCompilation: false, skipTests: false } }
```

**Current Intern addons** (after change from step 1):
```javascript
intern: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: false } }
```

**Change to**:
```javascript
intern: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: false, skipCompilation: false, skipTests: false } }
```

**Also update ROLE_ADDONS for lead, coder, and intern** to include:
```javascript
{ id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: false },
{ id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: false }
```

**Also update ROLE_ADDONS for intern** to include `pairProgramming` and `accurateCoding` entries (insert after `switchboardSafeguards`):
```javascript
{ id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Only do Routine (Band A) work', default: false },
{ id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
```

**Rationale**: Coding roles may want to skip compilation and test execution in certain scenarios (e.g., when just making documentation changes, or when tests are known to be slow/flaky).

### 4. Remove Recompile and Automated Tests from Planner
**File**: `src/webview/sharedDefaults.js`

**Current Planner addons**:
```javascript
planner: {
    workflowFilePath: '.agent/workflows/improve-plan.md',
    addons: { switchboardSafeguards: true, dependencyCheck: false, designDoc: false, aggressivePairProgramming: false, gitProhibition: false, splitPlan: false, clearAntigravityContext: false, skipCompilation: false, skipTests: false, cavemanOutput: false }
}
```

**Change to**:
```javascript
planner: {
    workflowFilePath: '.agent/workflows/improve-plan.md',
    addons: { switchboardSafeguards: true, dependencyCheck: false, designDoc: false, aggressivePairProgramming: false, gitProhibition: false, splitPlan: false, clearAntigravityContext: false, cavemanOutput: false }
}
```

**Also update ROLE_ADDONS for planner** (remove `skipCompilation` and `skipTests` entries):
```javascript
planner: [
    { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
    { id: 'dependencyCheck', label: 'Dependency Check', tooltip: 'Query Kanban for cross-plan dependencies', default: false },
    { id: 'designDoc', label: 'Design Doc Reference', tooltip: 'Include design doc as planning context', default: false },
    { id: 'aggressivePairProgramming', label: 'Aggressive Pair Programming', tooltip: 'Assume Coder can handle more independently', default: false },
    { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: false },
    { id: 'splitPlan', label: 'Split Plan', tooltip: 'Produce separate Routine and Complex plan files', default: false },
    { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
    { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false }
]
```

**Rationale**: Planner only improves plan files and never runs compilation or tests. These addons are meaningless for this role.

### 5. Add Recompile and Automated Tests to Reviewer
**File**: `src/webview/sharedDefaults.js`

**Current Reviewer addons**:
```javascript
reviewer: { prompt: '', addons: { switchboardSafeguards: true, advancedRegression: false, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false } }
```

**Change to**:
```javascript
reviewer: { prompt: '', addons: { switchboardSafeguards: true, advancedRegression: false, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, skipCompilation: false, skipTests: false } }
```

**Also update ROLE_ADDONS for reviewer**:
```javascript
reviewer: [
    { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
    { id: 'advancedRegression', label: 'Advanced Regression Analysis', tooltip: 'Trace all callers of modified functions', default: false },
    { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
    { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
    { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false },
    { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: false },
    { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: false }
]
```

**Rationale**: Reviewer may want to skip compilation and test execution when doing pure code review without running the code.

## Backend Implementation

### Step 1: Update `_getPromptsConfig` in `KanbanProvider.ts`

**File**: `src/services/KanbanProvider.ts` — function starts at line 2244.

#### 1.1 Make `skipCompilation` and `skipTests` per-role
Replace the current top-level `skipCompilation` and `skipTests` fields (lines 2274–2275) with per-role maps, following the same pattern as `gitProhibitionByRole`:

```ts
skipCompilationByRole: {
    planner: plannerConfig?.addons?.skipCompilation ?? false,
    lead: leadConfig?.addons?.skipCompilation ?? false,
    coder: coderConfig?.addons?.skipCompilation ?? false,
    reviewer: reviewerConfig?.addons?.skipCompilation ?? false,
    tester: testerConfig?.addons?.skipCompilation ?? false,
    intern: internConfig?.addons?.skipCompilation ?? false,
    analyst: analystConfig?.addons?.skipCompilation ?? false,
    researcher: researcherConfig?.addons?.skipCompilation ?? false,
    splitter: splitterConfig?.addons?.skipCompilation ?? false,
    ticket_updater: ticketUpdaterConfig?.addons?.skipCompilation ?? false,
    research_planner: researchPlannerConfig?.addons?.skipCompilation ?? false,
},
skipTestsByRole: {
    planner: plannerConfig?.addons?.skipTests ?? false,
    lead: leadConfig?.addons?.skipTests ?? false,
    coder: coderConfig?.addons?.skipTests ?? false,
    reviewer: reviewerConfig?.addons?.skipTests ?? false,
    tester: testerConfig?.addons?.skipTests ?? false,
    intern: internConfig?.addons?.skipTests ?? false,
    analyst: analystConfig?.addons?.skipTests ?? false,
    researcher: researcherConfig?.addons?.skipTests ?? false,
    splitter: splitterConfig?.addons?.skipTests ?? false,
    ticket_updater: ticketUpdaterConfig?.addons?.skipTests ?? false,
    research_planner: researchPlannerConfig?.addons?.skipTests ?? false,
},
```

> **Clarification**: The old `skipCompilation` and `skipTests` scalar fields (lines 2274–2275) must be **removed** from the returned object. All consumers that reference `promptsConfig.skipCompilation` must be updated to `promptsConfig.skipCompilationByRole?.[role]`.

#### 1.2 Make `accurateCodingEnabled` per-role (preferred) or extend fallback chain
**Preferred (per-role map)**: Replace the scalar `accurateCodingEnabled` with a per-role map to avoid intern's toggle being masked by coder/lead returning `false`:

```ts
accurateCodingEnabledByRole: {
    lead: leadConfig?.addons?.accurateCoding ?? config.get<boolean>('accurateCoding.enabled', false),
    coder: coderConfig?.addons?.accurateCoding ?? config.get<boolean>('accurateCoding.enabled', false),
    intern: internConfig?.addons?.accurateCoding ?? false,
},
```

**Alternative (fallback chain, simpler but imprecise)**:
```ts
accurateCodingEnabled: coderConfig?.addons?.accurateCoding ?? leadConfig?.addons?.accurateCoding ?? internConfig?.addons?.accurateCoding ?? config.get<boolean>('accurateCoding.enabled', false),
```
If using the per-role map, all downstream consumers must be updated accordingly.

#### 1.3 Include `intern` in `pairProgrammingEnabled` map
Add `intern` to the existing map (line 2262–2265):

```ts
pairProgrammingEnabled: {
    lead: leadConfig?.addons?.pairProgramming ?? false,
    coder: coderConfig?.addons?.pairProgramming ?? false,
    intern: internConfig?.addons?.pairProgramming ?? false,
},
```

### Step 2: Update all three prompt dispatch call sites in `KanbanProvider.ts`

> **Critical**: There are **three** places that hardcode `role === 'planner'` guards for `skipCompilation`/`skipTests`. All three must be updated.

#### 2.1 `_getDefaultPromptPreviews` (lines 2188–2189, 2195, 2197)

```ts
skipCompilation: promptsConfig.skipCompilationByRole?.[role] ?? false,
skipTests: promptsConfig.skipTestsByRole?.[role] ?? false,
```

Also update:
```ts
accurateCodingEnabled: (role === 'coder' || role === 'lead' || role === 'intern') ? promptsConfig.accurateCodingEnabled : undefined,
// or, if using per-role map:
accurateCodingEnabled: (role === 'coder' || role === 'lead' || role === 'intern') ? (promptsConfig.accurateCodingEnabledByRole?.[role] ?? false) : undefined,
```

```ts
pairProgrammingEnabled: (role === 'lead' || role === 'coder' || role === 'intern') ? (promptsConfig.pairProgrammingEnabled?.[role as any] ?? false) : undefined,
```

#### 2.2 `_generateAntigravityPrompt` (lines 2445–2446, 2453, 2455)

```ts
skipCompilation: promptsConfig.skipCompilationByRole?.[role] ?? false,
skipTests: promptsConfig.skipTestsByRole?.[role] ?? false,
```

Also update:
```ts
accurateCodingEnabled: (role === 'coder' || role === 'lead' || role === 'intern') ? promptsConfig.accurateCodingEnabled : undefined,
pairProgrammingEnabled: (role === 'lead' || role === 'coder' || role === 'intern') ? (promptsConfig.pairProgrammingEnabled?.[role] ?? false) : undefined,
```

#### 2.3 `getPromptPreview` message handler (lines 5927–5928, 5935, 5939)

```ts
skipCompilation: promptsConfig.skipCompilationByRole?.[role] ?? false,
skipTests: promptsConfig.skipTestsByRole?.[role] ?? false,
```

Also update:
```ts
accurateCodingEnabled: (role === 'coder' || role === 'lead' || role === 'intern') ? promptsConfig.accurateCodingEnabled : undefined,
pairProgrammingEnabled: (role === 'lead' || role === 'coder' || role === 'intern') ? (promptsConfig.pairProgrammingEnabled?.[role] ?? false) : undefined,
```

### Step 3: Update `buildKanbanBatchPrompt` in `agentPromptBuilder.ts`

#### 3.1 Add `skipBlock` to the relevant role branches — leave planner untouched

The planner block already handles skip directives correctly (lines 352–357). **Do not touch it.**

Build a `skipBlock` string alongside the existing `antigravityBlock` declaration (around line 285):

```ts
const skipBlock = [
    skipCompilation ? SKIP_COMPILATION_DIRECTIVE : '',
    skipTests ? SKIP_TESTS_DIRECTIVE : '',
].filter(Boolean).join('\n\n');
```

Then include `skipBlock` in the `suffixBlock` for the **lead, coder, intern, and reviewer** role branches only. For each of those branches, update their `suffixBlock` construction:

```ts
const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock]
    .filter(Boolean)
    .join('\n\n');
```

All other role branches (analyst, tester, ticket_updater, researcher, research_planner, splitter) do not need skip support and should remain unchanged.

#### 3.2 Enable `pairProgrammingEnabled` and `accurateCodingEnabled` for `intern`

In the `intern` role block (lines 571–595), add support for pair programming and accuracy:

```ts
if (role === 'intern') {
    let internBase = '';
    if (pairProgrammingEnabled) {
        internBase += `Additional Instructions: only do Routine (Band A) work.`;
    }

    let baseInstructions = resolveBaseInstructions('intern', internBase, options);
    if (cavemanOutputEnabled) {
        baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
    }

    const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
    const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
    const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
    const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock]
        .filter(Boolean)
        .join('\n\n'); // skipBlock carries skip directives if enabled

    const suppressWalkthroughBlock = suppressWalkthroughEnabled ? SUPPRESS_WALKTHROUGH_DIRECTIVE : '';
    const promptParts = [
        `Please process the following ${plans.length} plans.`,
        safeguardsBlock,
        baseInstructions,
        suffixBlock,
        `PLANS TO PROCESS:\n${planList}`,
        suppressWalkthroughBlock
    ].filter(Boolean).join('\n\n');

    const internPrompt = withCoderAccuracyInstruction(normalizeNewlines(promptParts), accurateCodingEnabled);
    return normalizeNewlines(internPrompt);
}
```

## Files to Modify
- `src/webview/sharedDefaults.js` — Update `DEFAULT_ROLE_CONFIG` and `ROLE_ADDONS`
- `src/services/KanbanProvider.ts` — Update `_getPromptsConfig` (per-role skip maps, accuracy map, intern in pairProgramming map) and all three `buildKanbanBatchPrompt` call sites
- `src/services/agentPromptBuilder.ts` — Add `skipBlock` to lead/coder/intern/reviewer suffixBlocks; enable pair programming and accuracy for intern. **Planner block is not touched.**

## Verification Plan

After changes, verify that:

### Configuration Changes
1. Intern has `pairProgramming` and `accurateCoding` addons in `ROLE_ADDONS`
2. Researcher does not have `cavemanOutput` addon in `ROLE_ADDONS`
3. Lead Coder, Coder, and Intern have `skipCompilation` and `skipTests` addons in `ROLE_ADDONS`
4. Planner does not have `skipCompilation` and `skipTests` addons in `ROLE_ADDONS`
5. Reviewer has `skipCompilation` and `skipTests` addons in `ROLE_ADDONS`

### Automated Tests
- Run TypeScript compile: `npm run compile` or `tsc --noEmit` to verify no type errors from per-role map refactoring
- Grep for `promptsConfig.skipCompilation` (non-byRole): should return zero results after migration

### UI Verification
1. Open the Switchboard Kanban panel → Prompts tab
2. Select Lead Coder, Coder, Intern, and Reviewer from the dropdown and confirm "Do not recompile" and "Do not run automated tests" appear in the Add-ons section
3. Select Intern and confirm "Accurate Coding" and "Pair Programming" appear
4. Select Researcher and confirm "Caveman Output" does NOT appear
5. Select Planner and confirm "Do not recompile" and "Do not run automated tests" do NOT appear
6. Toggle the checkboxes, switch roles, and switch back — confirm state persists

### Backend Verification
1. Generate a prompt preview for Lead, Coder, Intern, and Reviewer with skip options enabled and verify SKIP COMPILATION and SKIP TESTS directives appear in the preview text
2. Verify planner prompt preview still works correctly (planner block was not modified)
3. Generate a prompt preview for Intern with `pairProgramming` enabled and verify the "only do Routine (Band A) work" directive appears
4. Generate a prompt preview for Intern with `accurateCoding` enabled and verify the accuracy directive appears

---

## Reviewer Pass

### Stage 1: Grumpy Review (Adversarial Findings)
- **[MAJOR] Lead Prompt Pair Programming Shortchange**: When using the Pair Programming dispatch to IDE, `KanbanProvider.ts` invokes `buildKanbanBatchPrompt` for both `lead` and `coder`. It dutifully passes `accurateCodingEnabled` to the `coderPrompt` builder but *completely omits* it for the `leadPrompt`. If a Lead relies on accuracy mode during pair programming handoff, they just get silently ignored because someone forgot to add one line of code to the options map.
- **[NIT] Lazy Typing on Maps**: In `KanbanProvider.ts` (around line 2195), `promptsConfig.pairProgrammingEnabled?.[role as any]` is sloppy. `role` is already typed. A cast to `as 'lead' | 'coder' | 'intern'` would have been better than `any`, but it functions correctly.

### Stage 2: Balanced Synthesis
- The **MAJOR** omission of `accurateCodingEnabled` for the `leadPrompt` during `_dispatchWithPairProgrammingIfNeeded`'s caller (`pairProgramCard` action handler) is a genuine material defect that violates the plan's intent to support accuracy mode for the lead role fully. I will fix this immediately.
- The **NIT** typing issue is pedantic and doesn't affect runtime correctness. I will leave it alone as the original executor's choice is safe.
- All other plan instructions — `intern` addons UI and map logic, `planner` UI pruning, copy-path omissions, and `reviewer` enhancements — were executed perfectly. 

### Fixes Applied
- **Fixed:** Added `accurateCodingEnabled: promptsConfig.accurateCodingEnabledByRole?.lead ?? false` to the `leadPrompt` options map inside the `pairProgramCard` message handler in `src/services/KanbanProvider.ts` to ensure the lead role gets accuracy mode instructions during IDE pair programming dispatch.
- **Validation:** Ran `npm run compile` and confirmed 0 TypeScript errors.

**Status:** Plan complete and verified.
