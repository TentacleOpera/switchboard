# Fix Dependency Regex and Add Dependency Instruction Addon

## Goal

1. Fix the `getDependenciesFromPlan` regex to stop incorrectly matching "Dependencies & Conflicts" subsections
2. Add an "Include Dependency Instructions" addon checkbox to the Prompts tab (via `ROLE_ADDONS` in `sharedDefaults.js`) for coder, lead, and intern roles, to control whether the DEPENDENCY ORDER section appears in execution prompts

## Metadata

**Tags:** bugfix, UI, frontend, workflow
**Complexity:** 4

## User Review Required

No breaking changes. The regex fix corrects a parsing bug. The addon defaults to including dependency instructions (current behavior). No user review required before implementation.

## Complexity Audit

### Routine
- Fix regex in `KanbanProvider.ts` `getDependenciesFromPlan` method — single line change
- Add `includeDependencyInstructions` field to `ROLE_ADDONS` for coder, lead, intern in `sharedDefaults.js`
- Add `includeDependencyInstructions: true` to `DEFAULT_ROLE_CONFIG` addons for coder, lead, intern in `sharedDefaults.js`
- Add `includeDependencyInstructions?: boolean` to `PromptBuilderOptions` interface in `agentPromptBuilder.ts`
- Extract `includeDependencyInstructions` constant in `buildKanbanBatchPrompt` in `agentPromptBuilder.ts`
- Modify `depSection` generation for lead and coder to be conditional on the flag (lines 307-317)
- Add `depSection.trim()` to intern's `promptParts` guarded by the flag (intern currently omits depSection entirely)
- Add `includeDependencyInstructionsByRole` map to `_getPromptsConfig()` return object in `KanbanProvider.ts`
- Pass `includeDependencyInstructions` to all execution-role `buildKanbanBatchPrompt` call sites in `KanbanProvider.ts` (lines ~2170, ~2638, ~2678)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. Checkbox state is persisted to `workspaceState` synchronously.

### Security
- None. The new field controls prompt text content only.

### Side Effects
- Plans with actual dependencies will have the DEPENDENCY ORDER section hidden if the addon is unchecked. This could lead to out-of-order execution if users disable the addon without understanding the consequences. Mitigation: default to enabled, add clear tooltip.
- Intern role currently does NOT include `depSection` in its `promptParts`. This change adds it conditionally, which is an additive improvement. Default enabled preserves current behavior (no depSection for intern), but this change means intern will now show DEPENDENCY ORDER by default when plans have deps. This is the correct behavior — flag it as intentional.

### Dependencies & Conflicts
- `ROLE_ADDONS` is consumed by `kanban.html` directly via `window.sharedDefaults` through the `renderRoleAddons()` dynamic rendering system. **Do NOT add hardcoded HTML for coder/lead/intern** — the `renderRoleAddons()` function in `kanban.html` automatically generates checkboxes from `ROLE_ADDONS`, handles load state from `roleConfigs[role].addons`, save via `saveRoleConfig(role)`, and event listeners. Adding to `ROLE_ADDONS` is sufficient.
- The `_getPromptsConfig()` return object is consumed in multiple places (prompt previews, autoban dispatch, copy-to-clipboard). All consumers must receive the new `includeDependencyInstructionsByRole` map.
- Planner uses hardcoded HTML (not `renderRoleAddons`), and does not receive `depSection` — no changes needed for planner.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) Regex fix must not break valid "Dependencies" section parsing; (2) The addon must default to enabled to preserve current behavior; (3) The `kanban.html` implementation must use the dynamic `renderRoleAddons` system, NOT hardcoded HTML; (4) Intern's `promptParts` must also include conditional `depSection` — without this, the intern addon checkbox is a no-op. Mitigations: regex change is minimal and verified, default enabled preserves behavior, sharedDefaults-only change triggers the correct UI pipeline, intern depSection addition is additive with no downside.

## Proposed Changes

### `src/services/KanbanProvider.ts` — Regex Fix

**Context**: `getDependenciesFromPlan` (line 3474) uses a regex that incorrectly matches "Dependencies & Conflicts" subsections.

**Implementation**:

Change line 3481 from:
```typescript
const sectionMatch = content.match(/^#{1,4}\s+Dependencies\b[^\n]*$/im);
```

To:
```typescript
const sectionMatch = content.match(/^#{1,4}\s+Dependencies\s*$/im);
```

**Explanation**: The original regex uses `\b` (word boundary) after "Dependencies", which matches before `&` since `&` is not a word character. This causes it to match "Dependencies & Conflicts" headings. The new regex uses `\s*` (optional whitespace) which only matches if the heading ends with whitespace or end-of-line, excluding "Dependencies & Conflicts".

---

### `src/webview/sharedDefaults.js`

**Context**: `ROLE_ADDONS` defines addon UI metadata per role. `DEFAULT_ROLE_CONFIG` defines default values. Add `includeDependencyInstructions` for coder, lead, intern roles only (execution roles that receive the DEPENDENCY ORDER section).

**Implementation**:

1. In `ROLE_ADDONS`, for each of `lead`, `coder`, and `intern`, add the following entry **before** the existing `useSubagents` entry:
   ```javascript
   { id: 'includeDependencyInstructions', label: 'Include Dependency Instructions', tooltip: 'Include DEPENDENCY ORDER section in prompts when plans have dependencies. Disable only if you are certain plans have no dependencies.', default: true },
   ```

2. In `DEFAULT_ROLE_CONFIG`, add `includeDependencyInstructions: true` to the `addons` object for `lead`, `coder`, and `intern`.

**Example result for `lead`** in `DEFAULT_ROLE_CONFIG`:
```javascript
lead: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, leadChallenge: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: false, skipCompilation: false, skipTests: false, useSubagents: true, includeDependencyInstructions: true } },
```

> **Note**: No HTML changes are required in `kanban.html`. The `renderRoleAddons()` function dynamically generates checkboxes from `ROLE_ADDONS`, reads state from `roleConfigs[role].addons[addon.id]`, and saves via `saveRoleConfig(role)` on change. Adding the entry to `ROLE_ADDONS` is sufficient for full UI integration.

---

### `src/services/agentPromptBuilder.ts`

**Context**: `PromptBuilderOptions` (line 74) needs the new option. The `depSection` (lines 306–317) should be conditional on the new flag. Intern's `promptParts` (lines 599–606) currently omits `depSection` and must be updated.

**Implementation**:

1. Add to `PromptBuilderOptions` interface (after `useSubagentsEnabled`, line 124):
```typescript
/** When true (default), includes DEPENDENCY ORDER section in prompts when plans have dependencies. */
includeDependencyInstructions?: boolean;
```

2. Extract in `buildKanbanBatchPrompt` (after `useSubagentsEnabled` extraction, line 276):
```typescript
const includeDependencyInstructions = options?.includeDependencyInstructions ?? true;
```

3. Modify `depSection` generation (lines 306–317) to wrap in conditional on the new flag:
```typescript
const depSection = includeDependencyInstructions && plansWithDeps.length > 0
    ? `\n\nDEPENDENCY ORDER: Execute in order; do not start a plan until its dependencies are implemented:\n${
        plansWithDeps.map((p, i) => {
            const depIds = (p.dependencies || '').split(',').map(d => d.trim()).filter(Boolean);
            const resolvedDeps = depIds.map(depId => {
                const resolved = sessionIdToTopic.get(depId);
                return resolved || depId;
            });
            return `${i + 1}. [${p.topic}] depends on: ${resolvedDeps.join(', ')}`;
        }).join('\n')}\n`
    : '';
```

4. Add `depSection.trim()` to intern's `promptParts` (after `planList`, before `suppressWalkthroughBlock`):
```typescript
const promptParts = [
    `Please process the following ${plans.length} plans.`,
    safeguardsBlock,
    baseInstructions,
    suffixBlock,
    `PLANS TO PROCESS:\n${planList}`,
    depSection.trim(),          // ADD THIS LINE
    suppressWalkthroughBlock
].filter(Boolean).join('\n\n');
```

---

### `src/services/KanbanProvider.ts` — `_getPromptsConfig` and Call Sites

**Context**: `_getPromptsConfig()` (line 2245) aggregates prompt options. Add `includeDependencyInstructionsByRole` map. Three `buildKanbanBatchPrompt` call sites for execution roles need the new flag: ~line 2170 (preview), ~line 2638 (`_generateBatchExecutionPrompt`), ~line 2678 (`_dispatchWithPairProgrammingIfNeeded`).

**Implementation**:

1. Add `includeDependencyInstructionsByRole` to the return object of `_getPromptsConfig()`, after the `useSubagentsByRole` block (lines 2337–2349):
```typescript
includeDependencyInstructionsByRole: {
    lead: leadConfig?.addons?.includeDependencyInstructions ?? true,
    coder: coderConfig?.addons?.includeDependencyInstructions ?? true,
    intern: internConfig?.addons?.includeDependencyInstructions ?? true,
},
```

2. At the preview call site (~line 2170), add to the options object:
```typescript
includeDependencyInstructions: (role === 'lead' || role === 'coder' || role === 'intern')
    ? (promptsConfig.includeDependencyInstructionsByRole?.[role as any] ?? true)
    : undefined,
```

3. At the copy-to-clipboard call site (~line 2638), add to the options object:
```typescript
includeDependencyInstructions: promptsConfig.includeDependencyInstructionsByRole?.[role] ?? true,
```

4. At the pair-programming coder call site (~line 2678), add to the options object:
```typescript
includeDependencyInstructions: promptsConfig.includeDependencyInstructionsByRole?.coder ?? true,
```

---

## Verification Plan

### Automated Tests

*(Compilation and test runs are skipped per session policy.)*

### Manual Verification

1. Open a plan file that has a "Dependencies & Conflicts" section in its Edge-Case & Dependency Audit
2. Save the plan file to trigger metadata sync
3. Check that the database `dependencies` field now shows `None` or empty instead of incorrect text extracted from "Dependencies & Conflicts" content
4. Open the Kanban Prompts tab and switch to "Lead Coder", "Coder", or "Intern" role
5. Verify "Include Dependency Instructions" checkbox appears for all three roles
6. Verify checkbox is checked by default
7. Select a plan with actual dependencies (a plan whose `## Dependencies` section has `sess_*` entries) in a coder/lead/intern column
8. Verify the prompt preview contains a DEPENDENCY ORDER section
9. Uncheck the "Include Dependency Instructions" checkbox for the role
10. Verify the prompt preview no longer contains the DEPENDENCY ORDER section
11. Re-check the checkbox → verify DEPENDENCY ORDER section reappears
12. Verify lead and intern roles behave the same way as coder

## Files Changed

- `src/services/KanbanProvider.ts` — Fix regex in `getDependenciesFromPlan`; add `includeDependencyInstructionsByRole` map; pass flag to all execution-role `buildKanbanBatchPrompt` call sites
- `src/services/agentPromptBuilder.ts` — Add `includeDependencyInstructions` to interface; extract constant; make `depSection` conditional; add `depSection.trim()` to intern's `promptParts`
- `src/webview/sharedDefaults.js` — Add addon metadata and defaults for lead, coder, intern (drives kanban.html UI automatically via `renderRoleAddons`)

## Risks

- **Low risk**: Regex fix is well-scoped; addon defaults to enabled preserving current behavior
- **Backward compatible**: Existing behavior preserved when checkbox is checked (default)
- **Intern depSection addition**: Intern will now show DEPENDENCY ORDER section when plans have deps and the addon is enabled. This is the correct behavior and matches lead/coder. Default enabled means no change in output until users actively disable it.
- **User error**: Users disabling the addon could execute plans out of order. Mitigation: clear tooltip warning, default enabled

---

**Recommendation: Send to Coder**
