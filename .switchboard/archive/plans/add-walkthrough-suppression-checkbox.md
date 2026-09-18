# Add Walkthrough Suppression Checkbox to Prompts Tab

## Goal
Add a checkbox to the Prompts tab for lead, coder, and intern roles (and custom agents) to suppress walkthrough.md artifact generation at the end of coding tasks, injecting a clear directive into the generated prompt when enabled.

## Metadata
- **Tags:** frontend, backend, UI, UX
- **Complexity:** 4

## User Review Required
None — this is a straightforward addon extension with no breaking changes or behavioral regressions.

## Problem
Currently, walkthrough artifacts (walkthrough.md) are automatically generated when the accuracy workflow completes during coding tasks. Users want the ability to disable this artifact generation for certain roles (lead, coder, intern) and custom agents to reduce file clutter and save tokens.

## Proposed Solution
Add a new addon checkbox "Suppress Walkthrough Artifact" to the prompts tab for lead, coder, and intern roles, and to the custom agents configuration. This follows the existing addon pattern in `ROLE_ADDONS` and integrates with the existing role config state management.

## Complexity Audit

### Routine
- Adding addon entry to `ROLE_ADDONS` in `sharedDefaults.js` for lead, coder, intern (follows existing pattern)
- Adding `suppressWalkthrough: false` default to `DEFAULT_ROLE_CONFIG` addons for lead, coder, intern
- Adding checkbox HTML and load/save event listener to custom agents section of `kanban.html`
- Defining `SUPPRESS_WALKTHROUGH_DIRECTIVE` exported constant in `agentPromptBuilder.ts`
- Adding `suppressWalkthroughEnabled?: boolean` to `PromptBuilderOptions` interface
- Injecting directive into `lead`, `coder`, `intern` role branches (parallel to how `clearAntigravityContext` is appended)

### Complex / Risky
- `_getPromptsConfig` in `KanbanProvider.ts` needs a new `suppressWalkthroughByRole` per-role map (must not accidentally share a single flag across roles — prior pattern for `accurateCodingEnabled` collapsed lead+coder into one flag, which is an anti-pattern to avoid here)
- Custom agents bypass `buildKanbanBatchPrompt` entirely (line 2842). Their `suppressWalkthrough` state must be read from `CustomAgentConfig.addons` and appended to the simple plan-link prompt at that call site. Requires verifying that `CustomAgentConfig` carries the `addons` object and that the UI-to-state save correctly persists the new checkbox key.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — addon state is loaded on tab activation and saved on change, following existing autosave pattern.
- **Security:** No security impact — this is a UI configuration option only.
- **Side Effects:** When walkthrough suppression is enabled, agents will not generate walkthrough.md files. This is the intended behavior. No other features are affected.
- **Dependencies & Conflicts:**
  - The `SUPPRESS_WALKTHROUGH_DIRECTIVE` only instructs the agent; it does not change any workflow file. No workflow files need modification.
  - `accurateCodingEnabled` in `_getPromptsConfig` is currently a collapsed shared flag across coder+lead — do NOT use this pattern for `suppressWalkthrough`. Use a per-role map like `clearAntigravityContextByRole`.
  - Custom agent config's `addons` field: confirm the `CustomAgentConfig` type definition includes an `addons?: Record<string, any>` or equivalent. If not, extend it.

## Dependencies
- None — self-contained feature addition.

## Adversarial Synthesis
Key risks: (1) custom agents bypass `buildKanbanBatchPrompt` and need separate wiring at line 2842 in KanbanProvider; (2) `DEFAULT_ROLE_CONFIG` addons must be updated alongside `ROLE_ADDONS` or first-load defaults will be wrong. Mitigations: add `suppressWalkthrough: false` to both sources; extend the custom agent prompt path to append `SUPPRESS_WALKTHROUGH_DIRECTIVE` when the addon is set.

## Implementation Plan

### 1. Update `src/webview/sharedDefaults.js`

**A) Add `suppressWalkthrough: false` to `DEFAULT_ROLE_CONFIG` addons for lead, coder, intern:**

```javascript
// Line ~22 — lead:
lead: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, leadChallenge: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false } },
// Line ~23 — coder:
coder: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false } },
// Line ~26 — intern:
intern: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false } },
```

**B) Add addon metadata entry to `ROLE_ADDONS` for lead, coder, intern:**

```javascript
// Append to lead array (after clearAntigravityContext entry, ~line 77):
{ id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false }

// Append to coder array (after clearAntigravityContext entry, ~line 84):
{ id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false }

// Append to intern array (after clearAntigravityContext entry, ~line 100):
{ id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false }
```

### 2. Update `src/webview/kanban.html` — Custom Agents Tab

**A) Add checkbox HTML** in the addon section near line 2082 (after `ca-addon-accuracy`):
```html
<label class="checkbox-label"><input type="checkbox" id="ca-addon-suppress-walkthrough" style="width:auto;margin:0;"> Suppress Walkthrough Artifact</label>
```

**B) Add load line** in the `loadCustomAgentAddons` block (after line 2601, where `ca-addon-accuracy` is loaded):
```javascript
document.getElementById('ca-addon-suppress-walkthrough').checked = addons.suppressWalkthrough === true;
```

**C) Add save line** in the addon save block (after line 2651, where `accurateCodingEnabled` is saved):
```javascript
suppressWalkthrough: document.getElementById('ca-addon-suppress-walkthrough').checked,
```

### 3. Update `src/services/agentPromptBuilder.ts`

**A) Add `suppressWalkthroughEnabled?: boolean` to `PromptBuilderOptions` interface** (after `skipTests` ~line 118):
```typescript
/** When true, instructs the agent to skip walkthrough.md artifact generation at task completion. */
suppressWalkthroughEnabled?: boolean;
```

**B) Add `SUPPRESS_WALKTHROUGH_DIRECTIVE` exported constant** (after `SKIP_TESTS_DIRECTIVE` ~line 213):
```typescript
export const SUPPRESS_WALKTHROUGH_DIRECTIVE = `SUPPRESS WALKTHROUGH: Do NOT generate a walkthrough.md artifact at the end of this task. Omit the walkthrough creation step entirely.`;
```

**C) Extract the flag in `buildKanbanBatchPrompt`** (after `skipTests` destructure ~line 265):
```typescript
const suppressWalkthroughEnabled = options?.suppressWalkthroughEnabled ?? false;
```

**D) Inject directive into `lead` branch** — append to `promptParts` array before `normalizeNewlines` is called:
```typescript
// In the lead role branch, add suppressWalkthroughEnabled ? SUPPRESS_WALKTHROUGH_DIRECTIVE : ''
// to the promptParts filter array (alongside the other directive blocks)
const suppressWalkthroughBlock = suppressWalkthroughEnabled ? SUPPRESS_WALKTHROUGH_DIRECTIVE : '';
// Add suppressWalkthroughBlock to the promptParts array for lead, coder, intern
```

Apply the same pattern in the `coder` branch (before `withCoderAccuracyInstruction` is called) and `intern` branch.

### 4. Update `src/services/KanbanProvider.ts`

**A) Add `suppressWalkthroughByRole` map to `_getPromptsConfig`** (after `clearAntigravityContextByRole` map ~line 2315):
```typescript
suppressWalkthroughByRole: {
    lead: leadConfig?.addons?.suppressWalkthrough ?? false,
    coder: coderConfig?.addons?.suppressWalkthrough ?? false,
    intern: internConfig?.addons?.suppressWalkthrough ?? false,
},
```

**B) Pass per-role value to `buildKanbanBatchPrompt`** in the preview/advance call (~line 2196):
```typescript
suppressWalkthroughEnabled: (role === 'lead' || role === 'coder' || role === 'intern')
    ? promptsConfig.suppressWalkthroughByRole?.[role as any] ?? false
    : undefined,
```

**C) Extend custom agent prompt path** at line 2842-2854 to append the directive when enabled:
```typescript
if (role?.startsWith('custom_agent_')) {
    // ... existing repoScopeMap building ...
    const { planList } = buildPromptDispatchContext(this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap));
    // Find the custom agent config to check suppressWalkthrough
    const customAgents = await this._getCustomAgents(workspaceRoot);
    const agentId = role.replace('custom_agent_', '');
    const agentConfig = customAgents.find(a => a.id === agentId || a.role === role);
    const suppressWalkthrough = agentConfig?.addons?.suppressWalkthrough === true;
    const suppressBlock = suppressWalkthrough ? `\n\n${SUPPRESS_WALKTHROUGH_DIRECTIVE}` : '';
    return `Please process the following plans.${suppressBlock}\n\nPLANS TO PROCESS:\n${planList}`;
}
```
> **Note:** Verify the `CustomAgentConfig` type includes an `addons` field. If not, add `addons?: Record<string, any>` to the type definition. Grep for `CustomAgentConfig` to find the type declaration.

## Verification Plan

### Automated Tests
- [x] Run `npm run compile` (or `npx tsc --noEmit`) to confirm TypeScript compiles cleanly with the new interface field and constant.
- [x] Run existing unit tests if present: `npm test`.

### Manual Verification
- [x] Verify checkbox appears in the Prompts tab for lead, coder, and intern roles (rendered via `ROLE_ADDONS`).
- [x] Verify checkbox appears in the custom agents tab.
- [x] Verify checkbox state persists across tab switches and extension reloads (stored in `switchboard.prompts.roleConfig_*`).
- [x] Enable suppression for coder, copy a prompt — confirm `SUPPRESS WALKTHROUGH:` directive appears in the copied text.
- [x] Enable suppression for lead — confirm directive appears.
- [x] Enable suppression for intern — confirm directive appears.
- [x] Disable suppression — confirm directive is absent.
- [x] Enable suppression for a custom agent — confirm directive appears in the custom agent's prompt.
- [x] Verify default state is `false` (unchecked) on fresh install.

## Files Changed
- `src/webview/sharedDefaults.js` — Add `suppressWalkthrough` to `DEFAULT_ROLE_CONFIG` addons and `ROLE_ADDONS` for lead, coder, intern
- `src/webview/kanban.html` — Add checkbox HTML + load/save wiring to custom agents tab
- `src/services/agentPromptBuilder.ts` — Add `SUPPRESS_WALKTHROUGH_DIRECTIVE` constant, `suppressWalkthroughEnabled` to `PromptBuilderOptions`, and inject into lead/coder/intern branches
- `src/services/KanbanProvider.ts` — Add `suppressWalkthroughByRole` to `_getPromptsConfig`, pass to prompt builder, extend custom agent prompt path
- `dist/webview/sharedDefaults.js` — Synced from source via build process
- `dist/webview/kanban.html` — Synced from source via build process

---
**Recommendation:** Send to Coder

## Execution Review (Direct Reviewer Pass)

### Stage 1: Grumpy Principal Engineer Review
"Alright, let's look at this 'walkthrough suppression' feature. The goal is simply adding a checkbox to not spit out walkthroughs when they aren't needed. 
- Did you hook it up to the `ROLE_ADDONS`? Yes, I see `suppressWalkthrough: false` in `sharedDefaults.js` for lead, coder, intern, and the metadata definitions. No typos there.
- What about custom agents? Ah, you added `ca-addon-suppress-walkthrough` to `kanban.html` and bound it to load/save properly.
- The `SUPPRESS_WALKTHROUGH_DIRECTIVE` is clearly defined and safely scoped inside `agentPromptBuilder.ts`.
- `KanbanProvider.ts` wires the state for execution roles and injects it for custom agents. The logic uses optional chaining and falls back to `false`.

Nothing explodes here. No architectural layering violations. It's almost boring."
**Findings:**
- None. (NIT) 

### Stage 2: Balanced Synthesis
The implementation faithfully respects the proposed technical approach.

**Actionable Fixes:**
- No code fixes required.

**Validation Status:**
- `npm run compile` passed with zero errors, verifying the `CustomAgentAddons` interface matches the usage.
- UI elements verify successfully in source (`kanban.html`, `sharedDefaults.js`).
- State plumbing confirms true/false mapping.

**Remaining Risks:**
- Minimal. The directive is appended as plain text during prompt compilation, so the worst-case failure mode is the prompt omitting the directive if the UI unchecks the box unexpectedly.
