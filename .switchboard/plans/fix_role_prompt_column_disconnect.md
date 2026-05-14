# Bug Fix: Prompts Tab Preview and Actual Prompts Are Completely Disconnected

## Goal

Unify the Prompts tab preview and the actual kanban batch prompt generation so they share a single code path, and make the prompt builder persona-aware so custom prompts replace (not append to) the base instruction block while preserving role-specific framing.

## Metadata

- **Tags:** bugfix, frontend, backend, UI
- **Complexity:** 6

## User Review Required

**Yes.** The change from `mode: 'append'` to `mode: 'replace'` for custom prompts is a breaking behavior change for users who have already typed text into the Prompts tab textarea. Existing custom prompts that were designed to be tacked onto the end of the hardcoded template will now become the entire instruction block. Users should review the new preview behavior before this ships.

## Complexity Audit

### Routine
- Change `_getDefaultPromptOverrides` in `KanbanProvider.ts` and `TaskViewerProvider.ts` from `mode: 'append'` to `mode: 'replace'`.
- Add `getPromptPreview` message handler in `KanbanProvider.ts`.
- Add `promptPreviewResult` message handler in `kanban.html`.
- Preserve existing `state.json` `defaultPromptOverrides` merge logic.

### Complex / Risky
- Refactor `buildKanbanBatchPrompt` to separate **base instructions** (persona / override / hardcoded fallback) from **role framing** (execution intro, mode lines, add-on directives, dispatch context). This touches every role template in the function.
- Refactor `applyPromptOverride`'s `replace` mode so it injects role framing around the replaced text instead of stripping it entirely.
- Plumbing `personaContent` through all call sites: `_generateBatchPlannerPrompt`, `_generateBatchExecutionPrompt`, `_generatePromptForDestinationRole`, `_buildKanbanBatchPrompt` (TaskViewerProvider), and the new preview handler.

## Problem Statement

The **Prompts tab** in `kanban.html` shows a preview that bears no resemblance to the actual prompt generated when cards are dropped into kanban columns. For the **reviewer** role specifically:

1. **The preview shows persona file content** — when no custom prompt is typed, it loads `.agent/personas/reviewer.md` and appends toy add-on labels (`[Switchboard Safeguards]\nInclude batch execution rules...`).
2. **The actual generated prompt is a hardcoded template** — `buildKanbanBatchPrompt` builds a ~20-line reviewer template (execution intro, grumpy/balanced instructions, etc.) that has nothing to do with the persona file.
3. **Custom prompts from the textarea are appended as an afterthought** — via `_getDefaultPromptOverrides` with `mode: 'append'`, the custom text is tacked onto the end of the hardcoded template, making it feel invisible.
4. **Add-ons in the preview show labels/tooltips** — not the actual directive text that gets injected.

The result: the preview and the actual prompt share almost nothing in common. The user customizes in the prompts tab, but the generated prompt is completely different.

## Root Cause

### Cause 1: Two independent prompt systems that never meet

**System A — The Prompts Tab Preview** (`kanban.html:2519-2577`):
- For non-planner roles, if no custom prompt is set, requests `getPersonaForRole` from the backend
- Backend reads `.agent/personas/<role>.md` via `_getPersonaForRole` (`TaskViewerProvider.ts:14825`)
- Preview shows: persona file content + add-on labels/tooltips (`[Switchboard Safeguards]\nInclude batch execution rules...`)
- If a custom prompt is typed, shows: custom text + add-on labels/tooltips

**System B — The Actual Prompt Builder** (`agentPromptBuilder.ts:229`):
- `buildKanbanBatchPrompt` has hardcoded templates for every built-in role
- For reviewer (`agentPromptBuilder.ts:340`), it generates execution intro, mode block, grumpy/balanced instructions, etc.
- It never reads persona files
- Custom prompts are loaded via `_getDefaultPromptOverrides` as `mode: 'append'`:
  ```ts
  // KanbanProvider.ts:1966
  overrides[role] = { text: config.prompt, mode: 'append' };
  ```
- `applyPromptOverride` appends the custom text at the very end

These two systems never intersect. The preview is a fiction.

### Cause 2: `defaultPromptOverrides` merges are append-only and strip add-ons on replace

In `applyPromptOverride` (`agentPromptBuilder.ts:101`):
```ts
case 'append':
    return `${generated}\n\n${override.text}`;
case 'replace':
    return `${override.text}${dispatchContextBlock ? ... : ''}\n\nPLANS TO PROCESS:\n${planList}`;
```

- `append`: Custom text is added after the full hardcoded template. If the custom text is short, it feels invisible.
- `replace`: Strips ALL role-specific add-ons (advanced regression, inline challenge, etc.). The user would lose their add-on selections.

### Cause 3: The preview is client-side rendered and never calls the actual prompt builder

`refreshPreview()` in `kanban.html` does its own string concatenation. It does not call `buildKanbanBatchPrompt` or even request a preview from the backend's `_getDefaultPromptPreviews` (`KanbanProvider.ts:1995`).

`_getDefaultPromptPreviews` does call `buildKanbanBatchPrompt`, but it is only used to populate `defaultPromptPreviews` for setup.html — the Prompts tab preview ignores this entirely.

## Edge-Case & Dependency Audit

- **Race Conditions:** Every addon checkbox toggle in the Prompts tab triggers `refreshPreview()`. If the backend round-trip is slow and the user toggles multiple checkboxes rapidly, stale responses could overwrite newer ones. The frontend handler should guard against this with a `currentRole` check (already present) and optionally ignore responses older than the most recent request.
- **Security:** No new attack surface. The preview handler only calls the existing `buildKanbanBatchPrompt` with empty plans; it does not execute or dispatch anything.
- **Side Effects:** Changing `_getDefaultPromptOverrides` from `mode: 'append'` to `mode: 'replace'` for `roleConfig_<role>.prompt` is a **breaking behavior change** for existing users. Their previously "invisible" custom prompts will suddenly become the dominant instruction block.
- **Dependencies & Conflicts:** None blocking. This change is self-contained within the prompt-generation layer.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) `applyPromptOverride`'s `replace` mode currently strips all role framing, so switching `_getDefaultPromptOverrides` to `replace` will break add-on injection unless `applyPromptOverride` is refactored to wrap the replaced text with framing; (2) The async preview round-trip needs error handling and debouncing to avoid UI jank; (3) Missing persona files must gracefully fall back to hardcoded templates, but an empty string from a zero-byte persona file should NOT be treated as valid content. Mitigations: Refactor `applyPromptOverride` to inject role-specific framing around replaced text; add a loading state and try/catch in the preview handler; validate `personaContent` with `?.trim()` before use.

## Files to Change

| File | Lines | Change |
|------|-------|--------|
| `src/webview/kanban.html` | ~2519-2577, ~4625-4643 | Replace client-side `refreshPreview` with a backend call that returns the actual `buildKanbanBatchPrompt` output for the current role. |
| `src/services/agentPromptBuilder.ts` | ~101-118, ~229-562 | Refactor `buildKanbanBatchPrompt` to accept a `personaContent` parameter. Use persona/custom prompt as the base instruction block, and inject role-specific directives around it. |
| `src/services/KanbanProvider.ts` | ~1995-2017 | Extend `_getDefaultPromptPreviews` to pass `defaultPromptOverrides` so setup.html previews include custom prompts. |
| `src/services/KanbanProvider.ts` | ~1950-1973 | Change `_getDefaultPromptOverrides` to use `mode: 'replace'` for `roleConfig_<role>.prompt`. |
| `src/services/TaskViewerProvider.ts` | ~5799-5824 | Same change as KanbanProvider. |

## Proposed Changes

### `src/services/agentPromptBuilder.ts`

**Context:** This is the canonical prompt builder. Every UI surface that produces a prompt for an agent role must call this function so that "Copy Prompt", "Advance", autoban, and ticket-view dispatch all emit identical text.

**Logic:**
1. Add `personaContent?: string` to `PromptBuilderOptions`.
2. Refactor `applyPromptOverride` so that `replace` mode **wraps** the override text with role framing instead of stripping it. The current `replace` implementation returns only `override.text + dispatchContextBlock + planList`, which drops execution intros, mode lines, and add-ons. The new `replace` must:
   ```ts
   case 'replace':
       // Build the FULL prompt with the override text as the base instruction block
       return buildFullPromptForRole(role, override.text, /* all other options */);
   ```
   **Clarification:** This means `applyPromptOverride` can no longer be a simple string-replacement function. Instead, each role's template must be restructured into a helper that accepts `baseInstructions` as a parameter, and `applyPromptOverride` calls that helper with `override.text` as the base.
3. For the `reviewer` role, extract the hardcoded instruction body into `DEFAULT_REVIEWER_BASE_INSTRUCTIONS`, then the role helper becomes:
   ```ts
   function buildReviewerPrompt(baseInstructions: string, plans: BatchPromptPlan[], options: ReviewerFramingOptions): string {
       const { advancedReviewerEnabled, switchboardSafeguardsEnabled, gitProhibitionEnabled, ... } = options;
       const intro = buildReviewerExecutionIntro(plans.length);
       const mode = buildReviewerExecutionModeLine(`For ${plans.length <= 1 ? 'this plan' : 'each listed plan'}, assess the actual code changes against the plan requirements, fix valid material issues in code when needed, then verify.`);
       const advancedBlock = advancedReviewerEnabled ? ADVANCED_REVIEWER_DIRECTIVE : '';
       const safeguardsBlock = switchboardSafeguardsEnabled ? `${batchExecutionRules}\n\n` : '';
       const { planList, dispatchContextBlock } = buildPromptDispatchContext(plans);
       const dispatchContextPrefix = dispatchContextBlock ? `${dispatchContextBlock}\n\n` : '';

       return `${intro}\n\n${safeguardsBlock}${mode}${advancedBlock}\n\n${baseInstructions}\n\n${dispatchContextPrefix}${switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : ''}${gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : ''}\n\nPLANS TO PROCESS:\n${planList}`;
   }
   ```
4. The `baseInstructions` precedence for any role is:
   - `defaultPromptOverrides[role]` with `mode: 'replace'` and non-empty `text` → use `override.text`
   - `personaContent?.trim()` is truthy → use that
   - Fallback → the current hardcoded template's instruction body (e.g., `DEFAULT_REVIEWER_BASE_INSTRUCTIONS`)

**Edge Cases:**
- Empty string persona file: `personaContent?.trim()` returns `''` → falls through to hardcoded default.
- Empty custom prompt in textarea: `_getDefaultPromptOverrides` should skip creating an override for empty strings.
- No persona file: `_getPersonaForRole` returns `undefined` → falls through to hardcoded default.

### `src/services/KanbanProvider.ts`

**Logic:**
1. **Change `_getDefaultPromptOverrides`** (`~1950-1973`) from `mode: 'append'` to `mode: 'replace'`:
   ```ts
   overrides[role] = { text: config.prompt, mode: 'replace' };
   ```
   **Also add a guard:** only create the override if `config.prompt.trim()` is non-empty.
2. **Add `getPromptPreview` message handler** near the other message handlers (`~5243` area):
   ```ts
   case 'getPromptPreview': {
       const { role } = msg;
       const workspaceRoot = this._resolveWorkspaceRoot();
       if (!workspaceRoot) break;
       try {
           const promptsConfig = await this._getPromptsConfig(workspaceRoot);
           const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
           const personaContent = await this._taskViewerProvider?.getPersonaForRole(role);
           const preview = buildKanbanBatchPrompt(role, [], {
               workspaceRoot,
               personaContent: personaContent?.trim() || undefined,
               defaultPromptOverrides,
               gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role] ?? true,
               switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
               advancedReviewerEnabled: role === 'reviewer' ? promptsConfig.advancedReviewerEnabled : undefined,
               // Include all other role-relevant options from promptsConfig
           });
           this._panel?.webview.postMessage({ type: 'promptPreviewResult', role, preview });
       } catch (err) {
           this._panel?.webview.postMessage({ type: 'promptPreviewResult', role, preview: 'Error generating preview: ' + (err as Error).message });
       }
       break;
   }
   ```
3. **Plumb `personaContent` through dispatch paths.** In `_generateBatchPlannerPrompt`, `_generateBatchExecutionPrompt`, and `_generatePromptForDestinationRole`, load the persona file before calling `buildKanbanBatchPrompt`:
   ```ts
   const personaContent = await this._taskViewerProvider?.getPersonaForRole(role);
   return buildKanbanBatchPrompt(role, plans, {
       // existing options...
       personaContent: personaContent?.trim() || undefined,
   });
   ```
4. **Note on `_getDefaultPromptPreviews` (`~1995-2017`):** This method currently generates previews without `defaultPromptOverrides`. After this fix, it should also pass `defaultPromptOverrides` so the setup.html preview is consistent. However, the primary fix is the new `getPromptPreview` handler for the Prompts tab.

### `src/services/TaskViewerProvider.ts`

**Logic:**
1. **Change `_getDefaultPromptOverrides`** (`~5799-5824`) from `mode: 'append'` to `mode: 'replace'`, with the same empty-string guard.
2. **Plumb `personaContent` through `_buildKanbanBatchPrompt`** (`~5669-5710`):
   ```ts
   const personaContent = await this.getPersonaForRole(role);
   return buildKanbanBatchPrompt(role, plans, {
       // existing options...
       personaContent: personaContent?.trim() || undefined,
   });
   ```

### `src/webview/kanban.html`

**Logic:**
1. **Replace `refreshPreview()`** (`~2519-2577`) to call the backend:
   ```js
   async function refreshPreview() {
       const preview = document.getElementById('promptPreview');
       if (!preview) return;
       postKanbanMessage({ type: 'getPromptPreview', role: currentRole });
       preview.value = 'Loading preview...';
   }
   ```
2. **Add `promptPreviewResult` message handler** (`~4625` area, replacing `personaContent` handler):
   ```js
   case 'promptPreviewResult': {
       const { role, preview } = msg;
       if (role !== currentRole) break;
       const previewEl = document.getElementById('promptPreview');
       if (previewEl) previewEl.value = preview || '(No prompt content)';
       break;
   }
   ```
3. **Remove the old `personaContent` handler** since `getPromptPreview` now returns the fully-built prompt including persona content.

### `src/services/__tests__/agentPromptBuilder.test.ts`

**Logic:**
Add test coverage for the new persona-aware behavior:
```ts
describe('buildKanbanBatchPrompt — persona-aware reviewer', () => {
    test('uses personaContent as base instructions when no override exists', () => {
        const persona = 'Custom reviewer persona from file.';
        const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
            personaContent: persona,
            switchboardSafeguardsEnabled: false,
            gitProhibitionEnabled: false
        });
        assert.ok(prompt.includes(persona), 'Should include persona content');
        assert.ok(prompt.includes('reviewer-executor'), 'Should still include role framing');
    });

    test('replace override takes precedence over personaContent', () => {
        const override = 'Override text';
        const persona = 'Persona text';
        const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
            personaContent: persona,
            defaultPromptOverrides: { reviewer: { text: override, mode: 'replace' } },
            switchboardSafeguardsEnabled: false,
            gitProhibitionEnabled: false
        });
        assert.ok(prompt.includes(override), 'Should include override text');
        assert.ok(!prompt.includes(persona), 'Should NOT include persona text');
    });

    test('falls back to hardcoded template when personaContent is undefined', () => {
        const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
            switchboardSafeguardsEnabled: false,
            gitProhibitionEnabled: false
        });
        assert.ok(prompt.includes('For each plan:'), 'Should include hardcoded reviewer instructions');
    });

    test('ignores empty string personaContent', () => {
        const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
            personaContent: '',
            switchboardSafeguardsEnabled: false,
            gitProhibitionEnabled: false
        });
        assert.ok(prompt.includes('For each plan:'), 'Should fall back to hardcoded template');
    });
});
```

## Verification Plan

### Automated Tests

- Add `buildKanbanBatchPrompt` tests for reviewer role with `personaContent` (see test code in `agentPromptBuilder.test.ts` subsection above).
- Add tests for `replace` mode preserving role framing (execution intro, mode lines, add-ons).
- Add tests for fallback chain: `replace override > personaContent > hardcoded default`.
- Add tests for empty-string personaContent and empty-string override.
- Run existing `agentPromptBuilder.test.ts` suite to confirm no regressions in coder/lead/sourceColumnLabel behavior.

### Manual Verification

1. Open the Prompts tab. Select **reviewer**.
2. With no custom prompt typed, the preview should show the reviewer persona file content + actual add-on directive text (not labels).
3. Enable **Advanced Regression Analysis** — the preview should show the actual `ADVANCED_REVIEWER_DIRECTIVE` text injected.
4. Type a custom prompt: `Focus only on security vulnerabilities.`
5. The preview should show the custom text as the base instructions, with role framing and add-ons still injected.
6. Drag a plan card to the **Reviewed** column and copy the prompt.
7. The copied prompt should match the preview exactly.

## Regression Risks

- **Persona files for terminal dispatch**: Terminal agent dispatch wraps personas with `---PERSONA---`. This path (`_dispatchToTerminal`, `_executeLocal`) is separate and unaffected.
- **No persona file exists**: If `.agent/personas/reviewer.md` doesn't exist, `personaContent` is undefined and the current hardcoded template is used as fallback.
- **Empty custom prompt**: If the user clears the textarea, `roleConfig_<role>.prompt` becomes empty string. `_getDefaultPromptOverrides` should not create an override for empty strings.
- **Custom agents**: Use `buildCustomAgentPrompt`, unaffected.

## Complexity Estimate

See ## Complexity Audit above. Score raised from 5 to **6** after adversarial review revealed that refactoring `applyPromptOverride`'s `replace` mode is more invasive than initially estimated (it requires restructuring every role template into a helper that accepts `baseInstructions`).

**Recommendation: Send to Coder.**
