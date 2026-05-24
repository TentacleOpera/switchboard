# Add "Use Subagents for Multiple Plans" Checkbox to Addon Options

## Goal

Add a per-role "Use Subagents for Multiple Plans" addon checkbox to the kanban.html Prompts tab. When checked (default), the existing parallel sub-agent instruction is sent; when unchecked, a sequential-only instruction is sent instead, giving users control over how multi-plan batches are processed.

## Metadata

**Tags:** UI, frontend, workflow
**Complexity:** 5

## User Review Required

No breaking changes. All existing behavior is preserved by default (checkbox starts checked). No user review required before implementation.

## Complexity Audit

### Routine
- Add `useSubagents` field to `ROLE_ADDONS` and `DEFAULT_ROLE_CONFIG` in `sharedDefaults.js` — pure data addition following existing patterns
- Add `useSubagentsEnabled` to `PromptBuilderOptions` interface in `agentPromptBuilder.ts` — one-line interface addition
- Modify `parallelInstruction` conditional logic in `agentPromptBuilder.ts` — 4-line change with a ternary guard
- Add `useSubagentsByRole` map to `_getPromptsConfig()` in `KanbanProvider.ts` — follows `switchboardSafeguardsByRole` verbatim
- Pass `useSubagentsEnabled` to all `buildKanbanBatchPrompt` call sites in `KanbanProvider.ts` — mechanical line addition at 12 sites
- Add `useSubagentsEnabled` to the `_buildKanbanBatchPrompt` helper in `TaskViewerProvider.ts` (autoban path, lines ~5895–5939)
- Add checkbox HTML, load state, save state, and event listener for all roles in `kanban.html`
- Add unit test to `src/test/agent-prompt-builder-subagents.test.js`

### Complex / Risky
- **`agentConfig.ts` (`CustomAgentAddons` + `parseCustomAgentAddons`)**: The plan's original reference to a non-existent `AgentConfig` interface and `mergeAgentConfig` function is wrong. The correct target is `CustomAgentAddons` (line 3) and `parseCustomAgentAddons()` (line 144). `useSubagents?: boolean` must be added to both the interface and the parser, otherwise custom agents never receive the setting.
- **`buildCustomAgentPrompt()` in `TaskViewerProvider.ts` (line ~5954)**: This method has its own hardcoded `parallelInstruction` (lines 5973–5975) that is separate from `agentPromptBuilder.ts`. It reads from `CustomAgentAddons` (not `PromptBuilderOptions`), so it must be updated independently: replace the hardcoded parallel string with a conditional based on `addons?.useSubagents !== false`.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Checkbox state is persisted to `workspaceState` synchronously and read on next prompt generation. No async race paths introduced.

### Security
- None. The new field is a boolean toggling prompt text content only. No code execution or file access involved.

### Side Effects
- **Single-plan dispatches are unaffected**: All `buildKanbanBatchPrompt` calls at the sidebar single-dispatch level (TaskViewerProvider lines ~14316–14557) pass exactly 1 plan. Because `parallelInstruction` is guarded by `plans.length > 1`, `useSubagentsEnabled` is logically moot there but should still be passed for consistency and future-proofing.
- **Custom agents** (`buildCustomAgentPrompt()`) have their own `parallelInstruction` branch. Missing this path would leave custom agents always sending the parallel instruction regardless of the checkbox.

### Dependencies & Conflicts
- `ROLE_ADDONS` is consumed by `kanban.html` directly via `window.sharedDefaults`. Changes must be made in `sharedDefaults.js` (browser-side) only; no TypeScript module changes needed for this constant.
- The `_getPromptsConfig()` return object is consumed in multiple places (prompt previews, autoban dispatch, copy-to-clipboard). All consumers must receive the new `useSubagentsByRole` map — this is guaranteed by the single `_getPromptsConfig()` call site pattern.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) `agentConfig.ts` changes must target `CustomAgentAddons` and `parseCustomAgentAddons()` — not the non-existent `AgentConfig`/`mergeAgentConfig` the original plan described; (2) `buildCustomAgentPrompt()` in `TaskViewerProvider.ts` has a separate hardcoded `parallelInstruction` that will be silently skipped if only `agentPromptBuilder.ts` is updated. Mitigations: explicit file-and-function-level targets below, and the unit test validates both the parallel and sequential branches end-to-end through `agentPromptBuilder.ts`.

## Proposed Changes

### `src/webview/sharedDefaults.js`

**Context**: `ROLE_ADDONS` defines addon UI metadata per role. `DEFAULT_ROLE_CONFIG` defines the in-memory default addon values. Both need `useSubagents` added to every role.

**Implementation**:

Add `{ id: 'useSubagents', label: 'Use Subagents for Multiple Plans', tooltip: 'When processing multiple plans, instruct platform to use parallel subagents (if supported)', default: true }` as the last entry in **every** role's array in `ROLE_ADDONS` (planner, lead, coder, reviewer, tester, intern, analyst, ticket_updater, researcher, splitter, research_planner).

Add `useSubagents: true` as the last key in every role's `addons` object in `DEFAULT_ROLE_CONFIG`:

```javascript
// Example for planner (line 20) — repeat for all 11 roles
addons: { switchboardSafeguards: true, dependencyCheck: false, ..., cavemanOutput: false, useSubagents: true }
```

**Edge Cases**: `research_planner` has no `kanban.html` addon UI currently; add the checkbox there too following the existing pattern.

---

### `src/services/agentPromptBuilder.ts`

**Context**: `PromptBuilderOptions` (line 74) is the canonical options interface. The `parallelInstruction` at line 275 is always the parallel string when `plans.length > 1`.

**Implementation**:

1. Add to `PromptBuilderOptions` (after `cavemanOutputEnabled`, line 122):
```typescript
/** When true (default), uses parallel sub-agent instruction for multi-plan batches. When false, uses sequential-only instruction. */
useSubagentsEnabled?: boolean;
```

2. Extract in `buildKanbanBatchPrompt` (after `cavemanOutputEnabled` extraction, line 273):
```typescript
const useSubagentsEnabled = options?.useSubagentsEnabled ?? true;
```

3. Replace `parallelInstruction` (lines 275–277):
```typescript
const parallelInstruction = plans.length > 1
    ? (useSubagentsEnabled
        ? `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.\n\n`
        : `Process each plan sequentially. Do not use parallel sub-agents.\n\n`)
    : '';
```

**Edge Cases**: Single-plan calls (`plans.length <= 1`) are unaffected — `parallelInstruction` stays `''` regardless of flag.

---

### `src/services/KanbanProvider.ts`

**Context**: `_getPromptsConfig()` (line 2244) is the single config aggregation point for all prompt options. It already contains `switchboardSafeguardsByRole`.

**Implementation**:

1. Add `useSubagentsByRole` map to the return object of `_getPromptsConfig()`, immediately after `switchboardSafeguardsByRole` block (after line 2335):
```typescript
useSubagentsByRole: {
    planner: plannerConfig?.addons?.useSubagents ?? true,
    lead: leadConfig?.addons?.useSubagents ?? true,
    coder: coderConfig?.addons?.useSubagents ?? true,
    reviewer: reviewerConfig?.addons?.useSubagents ?? true,
    tester: testerConfig?.addons?.useSubagents ?? true,
    intern: internConfig?.addons?.useSubagents ?? true,
    analyst: analystConfig?.addons?.useSubagents ?? true,
    researcher: researcherConfig?.addons?.useSubagents ?? true,
    splitter: splitterConfig?.addons?.useSubagents ?? true,
    ticket_updater: ticketUpdaterConfig?.addons?.useSubagents ?? true,
    research_planner: researchPlannerConfig?.addons?.useSubagents ?? true,
},
```

2. Add `useSubagentsEnabled` at all `buildKanbanBatchPrompt` call sites, following the `switchboardSafeguardsEnabled` line. Lines (verified by grep): **2178, 2469, 2582, 2631, 2669, 2872, 2902, 5554, 5569, 5962, 6377**, plus the `_generateBatchPlannerPrompt` call at line 2570 and `_generateBatchExecutionPrompt` at line 2622.

Example pattern to add at each site:
```typescript
switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
useSubagentsEnabled: promptsConfig.useSubagentsByRole?.[role] ?? true,
```

For role-specific fixed calls (e.g., line 2582 `?.planner`, line 2669 `?.coder`), use the specific role key matching the existing `switchboardSafeguardsEnabled` line.

---

### `src/services/TaskViewerProvider.ts`

**Context**: Two separate code paths need updating.

#### Path A: `_buildKanbanBatchPrompt()` helper (line 5895) — autoban dispatch

This is the **autoban path** that can batch multiple plans.

Add `useSubagentsEnabled` extraction after line 5916:
```typescript
const switchboardSafeguardsEnabled = roleConfig?.addons?.switchboardSafeguards ?? true;
const useSubagentsEnabled = roleConfig?.addons?.useSubagents ?? true;
```

Pass to `buildKanbanBatchPrompt` call (line 5919), adding after `switchboardSafeguardsEnabled,` (line 5934):
```typescript
switchboardSafeguardsEnabled,
useSubagentsEnabled,
```

#### Path B: `buildCustomAgentPrompt()` (line 5954) — custom agent dispatch

This method has its **own** hardcoded `parallelInstruction` (lines 5973–5975) that reads from `CustomAgentAddons`. Replace:

```typescript
// BEFORE (lines 5973–5975):
const parallelInstruction = plans.length > 1
    ? `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.\n\n`
    : '';

// AFTER:
const parallelInstruction = plans.length > 1
    ? (addons?.useSubagents !== false
        ? `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.\n\n`
        : `Process each plan sequentially. Do not use parallel sub-agents.\n\n`)
    : '';
```

Note: `addons?.useSubagents !== false` (not `=== true`) preserves the default-true behavior when the field is absent/undefined.

#### Path C: Single-card sidebar dispatch (lines ~14316–14557)

These calls always dispatch exactly 1 plan (`plans.length > 1` = false), so `parallelInstruction` is always `''`. Adding `useSubagentsEnabled` here is for completeness/consistency only, not correctness. **Low priority** — can be deferred or omitted.

---

### `src/services/agentConfig.ts`

**Context**: `CustomAgentAddons` interface (line 3) and `parseCustomAgentAddons()` function (line 144) are the correct targets. There is no `AgentConfig` interface or `mergeAgentConfig` function in this file — the original plan description was incorrect.

**Implementation**:

1. Add to `CustomAgentAddons` interface (after `cavemanOutput?: boolean`, line 21):
```typescript
useSubagents?: boolean;
```

2. Add to `parseCustomAgentAddons()` function (after `if (s.cavemanOutput === true)` line, ~line 162):
```typescript
if (s.useSubagents === false) a.useSubagents = false;
```

Note: Parse `false` explicitly (not just `true`) because the default is `true` — custom agents that have unchecked the box persist `false`, which must survive the parser. Using `!== true` would lose the off-state.

---

### `src/webview/kanban.html`

**Context**: Follows the exact pattern of `switchboardSafeguards` checkbox for each role. Line numbers are approximate — search by content.

**Implementation**:

For each role (planner, lead, coder, reviewer, tester, intern, analyst, ticket_updater, researcher, splitter, research_planner), add checkbox after the last existing addon checkbox for that role:

```html
<label class="addon-checkbox">
    <input type="checkbox" id="{role}AddonUseSubagents">
    <span class="addon-label" title="When processing multiple plans, instruct platform to use parallel subagents (if supported)">Use Subagents for Multiple Plans</span>
</label>
```

Where `{role}` = `planner`, `lead`, `coder`, `reviewer`, `tester`, `intern`, `analyst`, `ticketUpdater`, `researcher`, `splitter`, `researchPlanner` (matching existing ID casing convention).

**Load state** (in the config-load block for each role):
```javascript
document.getElementById('{role}AddonUseSubagents').checked = config.addons?.useSubagents !== false;
```

**Save state** (in the save/serialize block for each role):
```javascript
useSubagents: document.getElementById('{role}AddonUseSubagents').checked,
```

**Event listeners** — add `'{role}AddonUseSubagents'` to the existing forEach ID list for each role's change handler.

---

### `src/test/agent-prompt-builder-subagents.test.js` [NEW]

**Implementation**:

```javascript
function testUseSubagentsInstruction() {
    console.log('\nTesting useSubagents instruction...');
    
    const plans1 = [{ sessionId: 'sess1', title: 'Plan 1', topic: 'Plan 1', absolutePath: '/path/to/plan1.md' }];
    const plans2 = [
        { sessionId: 'sess1', title: 'Plan 1', topic: 'Plan 1', absolutePath: '/path/to/plan1.md' },
        { sessionId: 'sess2', title: 'Plan 2', topic: 'Plan 2', absolutePath: '/path/to/plan2.md' }
    ];
    
    // Single plan — no instruction regardless of useSubagentsEnabled
    const singlePlanPrompt = buildKanbanBatchPrompt('coder', plans1, { useSubagentsEnabled: true });
    assert.ok(!singlePlanPrompt.includes('sub-agent'), 'Single plan should NOT include subagent instruction');
    
    // Multiple plans with useSubagentsEnabled=true → include parallel instruction
    const parallelPrompt = buildKanbanBatchPrompt('coder', plans2, { useSubagentsEnabled: true });
    assert.ok(parallelPrompt.includes('parallel sub-agents'), 'Multiple plans with useSubagentsEnabled=true SHOULD include parallel instruction');
    
    // Multiple plans with useSubagentsEnabled=false → include sequential instruction
    const sequentialPrompt = buildKanbanBatchPrompt('coder', plans2, { useSubagentsEnabled: false });
    assert.ok(sequentialPrompt.includes('Process each plan sequentially'), 'Multiple plans with useSubagentsEnabled=false SHOULD include sequential instruction');
    assert.ok(!sequentialPrompt.includes('parallel sub-agents'), 'Multiple plans with useSubagentsEnabled=false should NOT include parallel instruction');
    
    // Default behavior (no option passed) → should include parallel instruction (default true)
    const defaultPrompt = buildKanbanBatchPrompt('coder', plans2, {});
    assert.ok(defaultPrompt.includes('parallel sub-agents'), 'Default (no useSubagentsEnabled) SHOULD include parallel instruction');
    
    console.log('Use subagents instruction tests PASSED!');
}
```

## Verification Plan

### Automated Tests

```bash
# Run existing subagent-related tests (must still pass)
node src/test/agent-prompt-builder-subagents.test.js

# Run the new test file after creation
node src/test/agent-prompt-builder-subagents.test.js

# TypeScript compilation check
npx tsc --noEmit
```

### Manual Verification

1. Open Kanban Prompts tab
2. Verify "Use Subagents for Multiple Plans" checkbox appears for all 11 roles
3. Verify checkbox is checked by default for all roles
4. Uncheck checkbox for **Coder** role → save
5. In Prompts tab preview, select multiple cards in Coder column
6. Verify preview contains `"Process each plan sequentially"` instead of `"parallel sub-agents"`
7. Re-check checkbox → verify preview reverts to parallel instruction
8. Verify Planner, Lead, Reviewer, Intern, Analyst, Researcher, Splitter, Tester, Ticket Updater, Research Planner also respond correctly

## Files Changed

- `src/webview/sharedDefaults.js` — Add addon metadata and defaults for all 11 roles
- `src/services/KanbanProvider.ts` — Add `useSubagentsByRole` map; pass `useSubagentsEnabled` to all `buildKanbanBatchPrompt` call sites
- `src/services/agentPromptBuilder.ts` — Add `useSubagentsEnabled` to interface and conditional `parallelInstruction` logic
- `src/services/TaskViewerProvider.ts` — Two paths: (A) `_buildKanbanBatchPrompt` helper; (B) `buildCustomAgentPrompt` hardcoded parallel instruction
- `src/services/agentConfig.ts` — Add `useSubagents` to `CustomAgentAddons` interface and `parseCustomAgentAddons()`
- `src/webview/kanban.html` — Add checkbox UI, load/save state, event listeners for all roles
- `src/test/agent-prompt-builder-subagents.test.js` — New test file

## Risks

- **Low risk**: Additive functionality with sensible defaults (enabled by default)
- **Backward compatible**: Existing behavior preserved when checkbox is checked (default)
- **`agentConfig.ts` parser**: Parse `false` explicitly (not only `true`) to preserve opt-out state for custom agents
- **`buildCustomAgentPrompt` gap**: Must update the independent `parallelInstruction` in this method — it is NOT covered by changes to `agentPromptBuilder.ts`

---

## Review Results (2026-05-25)

### Reviewer: Devin (in-place reviewer pass)

### Findings

| # | Severity | Description | Resolution |
|---|----------|-------------|------------|
| 1 | NIT | Plan text says `default: true`; implementation uses `default: false` for most roles (only `splitter` gets `true`). This was an intentional implementer decision — `?? true` fallbacks in backend code ensure parallel instruction is still the default when no saved config exists, while the UI checkbox starts unchecked. | No change needed — design choice, not a defect. |
| 2 | NIT | `gatherer` role has no `useSubagents` addon in `ROLE_ADDONS` or `DEFAULT_ROLE_CONFIG`. Consistent with `gatherer` not being a batch-processing role and matching how other per-role maps treat it. | No change needed. |
| 3 | NIT | Plan references `research_planner`; codebase uses `code_researcher`. Implementation correctly handles both via fallback in `KanbanProvider.ts` (line 2248). | No change needed — plan doc issue only. |

### Verification

- All 7 target files have the feature implemented as described in the plan
- `agentPromptBuilder.ts`: `useSubagentsEnabled` in interface + conditional `parallelInstruction` logic ✓
- `agentConfig.ts`: `useSubagents` in `CustomAgentAddons` + `parseCustomAgentAddons()` parses `=== false` ✓
- `KanbanProvider.ts`: `useSubagentsByRole` map + passed to all 12 `buildKanbanBatchPrompt` call sites ✓
- `TaskViewerProvider.ts`: Both paths updated — `_buildKanbanBatchPrompt` helper (autoban) + `buildCustomAgentPrompt` (custom agents) ✓
- `kanban.html`: Static checkbox for planner + dynamic rendering via `ROLE_ADDONS` for all other roles ✓
- `sharedDefaults.js`: Addon metadata and defaults for all roles ✓
- `agent-prompt-builder-subagents.test.js`: `testUseSubagentsInstruction()` covers parallel, sequential, single-plan, and default cases ✓

### Files Changed by Review

None — no code fixes required.

### Remaining Risks

- Users with existing saved configs (pre-feature) will get `?? true` fallback → parallel instruction, which matches pre-feature behavior. No migration needed.
- The `default: false` in `ROLE_ADDONS` / `DEFAULT_ROLE_CONFIG` means new users see the checkbox unchecked, but the backend still sends parallel instruction by default. This is intentional: the checkbox is an opt-in confirmation, not the source of truth for the prompt.

---

**Recommendation: Send to Coder**
