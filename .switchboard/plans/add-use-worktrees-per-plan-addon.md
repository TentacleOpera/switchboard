# Add "Worktrees Per Plan" Prompt Add-On

## Goal

Add a **Worktrees Per Plan** checkbox to the prompt builder for the `lead`, `coder`, and `intern` roles, and for custom agents. When enabled, it appends a generic instruction telling the downstream CLI to use its native subagent/orchestration capabilities to process each plan in an isolated git worktree. The checkbox sits below the Subagent Policy radio group and defaults to off.

This delegates worktree management entirely to the downstream tool (e.g. Claude CLI). Switchboard emits the instruction; the CLI decides how to act on it.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, cli

## User Review Required

No — the change is additive only. No existing behaviour is altered.

## Complexity Audit

### Routine
- Adding one entry to `ROLE_ADDONS` in `sharedDefaults.js` for `lead`, `coder`, `intern`
- Adding `useWorktreesPerPlan: false` to `DEFAULT_ROLE_CONFIG` addons for `lead`, `coder`, `intern`
- Expanding the custom agent fallback in `renderRoleAddons` in `kanban.html` to include the new addon
- Adding one field to `PromptBuilderOptions` in `agentPromptBuilder.ts` and one text injection
- Adding one `byRole` map in `KanbanProvider.ts` and threading it into options
- Adding `useWorktreesPerPlan` to `CustomAgentAddons` interface in `agentConfig.ts`
- Adding `useWorktreesPerPlan` extraction to `parseCustomAgentAddons` in `agentConfig.ts`
- Adding worktree directive injection to `buildCustomAgentPrompt` in `agentPromptBuilder.ts`

### Complex / Risky
- None — fully additive, no routing or rendering logic touched.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Checkbox state is read at prompt-build time, not during async operations.
- **Security:** No security implications. The directive is advisory text only.
- **Side Effects:** Adding `useWorktreesPerPlan: false` to `DEFAULT_ROLE_CONFIG` ensures first-load consistency. Without it, `roleConfigs[role]?.addons?.useWorktreesPerPlan` returns `undefined` which falsy-checks the same, but explicit `false` is safer for UI checkbox rendering.
- **Dependencies & Conflicts:** The worktree directive appends to `subagentBlock` after any subagent policy directive. If `noSubagents` is enabled simultaneously, the "No Subagents" directive takes precedence in the block, but the worktree directive still appends after it — creating a contradictory prompt ("don't use subagents" + "use worktrees via subagents"). Mitigation: the UI should be clear that these are independent toggles, and the downstream CLI will resolve contradictions. No code-level conflict prevention needed at this complexity level.

## Dependencies

None — this is a self-contained additive feature.

## Adversarial Synthesis

Key risks: (1) Missing `CustomAgentAddons` interface field and parser entry would cause custom agent worktree directive to silently fail on reload. (2) `buildCustomAgentPrompt` has a separate `subagentBlock` assembly that the original plan omitted — custom agents would never emit the directive. (3) Contradictory prompt if both "No Subagents" and "Worktrees Per Plan" are enabled simultaneously. Mitigations: All three code gaps are mechanical additions following existing patterns. The contradiction risk is acceptable because the directive is advisory and downstream CLIs resolve conflicts naturally.

## Implementation Plan

### Step 1: Define the addon in `sharedDefaults.js`

**File**: `src/webview/sharedDefaults.js`

After the `subagentPolicy` entry in each of `lead`, `coder`, and `intern`, add:

```js
{ id: 'useWorktreesPerPlan', label: 'Worktrees Per Plan', tooltip: 'Instruct the agent to use its native subagent/orchestration capabilities to process each plan in an isolated git worktree', default: false }
```

Position: immediately after the closing `}` of the `subagentPolicy` object in each role array, before `workflowFilePath`.

The entry goes into `lead` (after line 93, before line 94), `coder` (after line 111, before line 112), and `intern` (after line 160, before line 161).

### Step 2: Add defaults to `DEFAULT_ROLE_CONFIG` in `sharedDefaults.js`

**File**: `src/webview/sharedDefaults.js`

Add `useWorktreesPerPlan: false` to the `addons` object for `lead` (line 24), `coder` (line 25), and `intern` (line 28).

For example, in `lead`:
```js
lead: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, leadChallenge: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '' } },
```

Same pattern for `coder` and `intern`.

### Step 3: Expand the custom agent fallback in `renderRoleAddons`

**File**: `src/webview/kanban.html`

Custom agents are not in `ROLE_ADDONS` by key, so `renderRoleAddons` falls back at line 3036:

```js
if (addons.length === 0 && role.startsWith('custom_agent_')) {
    addons = [{ id: 'workflowFilePath', label: 'Workflow File', tooltip: '...', type: 'file', default: false }];
}
```

Expand this fallback to include the new addon after `workflowFilePath`:

```js
if (addons.length === 0 && role.startsWith('custom_agent_')) {
    addons = [
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false },
        { id: 'useWorktreesPerPlan', label: 'Worktrees Per Plan', tooltip: 'Instruct the agent to use its native subagent/orchestration capabilities to process each plan in an isolated git worktree', default: false }
    ];
}
```

No AGENTS tab HTML changes required. Custom agents configure all addons in the PROMPTS tab via `renderRoleAddons`.

### Step 4: Add `useWorktreesPerPlan` to `CustomAgentAddons` interface

**File**: `src/services/agentConfig.ts`

Add to the `CustomAgentAddons` interface (after `customSubagentName` at line 24):

```ts
useWorktreesPerPlan?: boolean;
```

### Step 5: Add extraction to `parseCustomAgentAddons`

**File**: `src/services/agentConfig.ts`

In the `parseCustomAgentAddons` function (around line 149), add after the `customSubagentName` extraction (line 182):

```ts
if (s.useWorktreesPerPlan === true) a.useWorktreesPerPlan = true;
```

### Step 6: Add option to `agentPromptBuilder.ts`

**File**: `src/services/agentPromptBuilder.ts`

Add to `PromptBuilderOptions` (after `customSubagentName` at line 128):

```ts
/** When true, instructs the agent to use native subagent/worktree capabilities to isolate each plan. */
useWorktreesPerPlanEnabled?: boolean;
```

In the prompt build logic (wherever `subagentBlock` is assembled, around line 381):

```ts
const useWorktreesPerPlanEnabled = options?.useWorktreesPerPlanEnabled ?? false;
```

Append to `subagentBlock` when enabled (after the existing subagent policy block assembly, around line 391):

```ts
if (useWorktreesPerPlanEnabled) {
    const worktreeDirective = 'Where possible, process each plan as an isolated unit using your native subagent or orchestration capabilities, creating a dedicated git worktree per plan to prevent file conflicts between concurrent tasks.';
    subagentBlock = subagentBlock ? subagentBlock + '\n\n' + worktreeDirective : worktreeDirective;
}
```

### Step 7: Add worktree directive to `buildCustomAgentPrompt`

**File**: `src/services/agentPromptBuilder.ts`

In `buildCustomAgentPrompt` (line 1205), after the custom agent's own `subagentBlock` assembly (around line 1238), add:

```ts
if (addons?.useWorktreesPerPlan) {
    const worktreeDirective = 'Where possible, process each plan as an isolated unit using your native subagent or orchestration capabilities, creating a dedicated git worktree per plan to prevent file conflicts between concurrent tasks.';
    subagentBlock = subagentBlock ? subagentBlock + '\n\n' + worktreeDirective : worktreeDirective;
}
```

### Step 8: Wire into `KanbanProvider.ts`

**File**: `src/services/KanbanProvider.ts`

In the `promptsConfig` assembly block (after `customSubagentNameByRole` around line 2708), add a new `useWorktreesPerPlanByRole` map:

```ts
useWorktreesPerPlanByRole: {
    lead: leadConfig?.addons?.useWorktreesPerPlan === true,
    coder: coderConfig?.addons?.useWorktreesPerPlan === true,
    intern: internConfig?.addons?.useWorktreesPerPlan === true,
},
```

In the options spread passed to the prompt builder (around line 2481, after `customSubagentName`), add:

```ts
useWorktreesPerPlanEnabled: promptsConfig.useWorktreesPerPlanByRole?.[role] ?? false,
```

For custom agents, the addon value is already stored in `roleConfig.addons.useWorktreesPerPlan` — it flows through `buildCustomAgentPrompt` via the `addons` parameter (Step 7 handles this).

## Proposed Changes

### `src/webview/sharedDefaults.js`
- **Context:** `ROLE_ADDONS.lead`, `ROLE_ADDONS.coder`, `ROLE_ADDONS.intern` each end with `subagentPolicy` then `workflowFilePath`
- **Change:** Insert `useWorktreesPerPlan` entry after `subagentPolicy`, before `workflowFilePath`, in all three roles
- **Change:** Add `useWorktreesPerPlan: false` to `DEFAULT_ROLE_CONFIG` addons for `lead`, `coder`, `intern`
- **Edge cases:** `default: false` ensures opt-in only; no existing prompts are affected. Explicit `false` in `DEFAULT_ROLE_CONFIG` ensures UI checkbox renders consistently on first load.

### `src/webview/kanban.html`
- **Context:** `renderRoleAddons` fallback for `custom_agent_*` roles (line 3036) — currently only provides `workflowFilePath`
- **Change:** Expand the fallback array to include `useWorktreesPerPlan` entry
- **Edge cases:** The fallback only runs when `ROLE_ADDONS[role]` is empty (i.e., any `custom_agent_*`). Existing saved configs without this key default to unchecked via `addon.default: false`

### `src/services/agentConfig.ts`
- **Context:** `CustomAgentAddons` interface (line 3) and `parseCustomAgentAddons` function (line 149)
- **Change:** Add `useWorktreesPerPlan?: boolean` to interface; add extraction `if (s.useWorktreesPerPlan === true) a.useWorktreesPerPlan = true` to parser
- **Edge cases:** Missing key in saved config defaults to `undefined` (falsy), consistent with checkbox unchecked state

### `src/services/agentPromptBuilder.ts`
- **Context:** `PromptBuilderOptions` interface (line 75) and `subagentBlock` assembly (line 381) in `buildKanbanBatchPrompt`; `subagentBlock` assembly (line 1228) in `buildCustomAgentPrompt`
- **Change:** Add `useWorktreesPerPlanEnabled` option to `PromptBuilderOptions`; append worktree directive to `subagentBlock` when true in both `buildKanbanBatchPrompt` and `buildCustomAgentPrompt`
- **Edge cases:** Directive appends after any subagent policy directive so order is: policy first, worktree instruction second. If `subagentBlock` is empty, the directive stands alone without a leading `\n\n`. If both "No Subagents" and "Worktrees Per Plan" are enabled, both directives appear — the downstream CLI resolves the contradiction.

### `src/services/KanbanProvider.ts`
- **Context:** `promptsConfig` assembly (line 2667 area) and options spread (line 2475)
- **Change:** Add `useWorktreesPerPlanByRole` map with `lead`, `coder`, `intern` keys; pass result into prompt builder options
- **Edge cases:** Missing `addons` object on a role config defaults to `false` safely via `=== true`

## Acceptance Criteria

- [ ] PROMPTS tab → Lead Coder shows "Worktrees Per Plan" checkbox below Subagent Policy, unchecked by default
- [ ] PROMPTS tab → Coder shows the same checkbox in the same position
- [ ] PROMPTS tab → Intern shows the same checkbox in the same position
- [ ] AGENTS tab → custom agent add-ons section shows "Worktrees Per Plan" checkbox
- [ ] Checking the box and copying a coder prompt includes the worktree directive in the output
- [ ] Checking the box for a custom agent prompt includes the worktree directive in the output
- [ ] Directive text is generic and not CLI-specific
- [ ] Unchecked state produces no change to existing prompt output
- [ ] Setting persists across panel reloads (saved via `saveRoleConfig` and parsed by `parseCustomAgentAddons`)

## Verification Plan

### Automated Tests
- No automated tests required. Feature is UI-only additive checkbox with text injection. Manual verification via acceptance criteria above.

**Recommendation:** Complexity 2 → Send to Intern
