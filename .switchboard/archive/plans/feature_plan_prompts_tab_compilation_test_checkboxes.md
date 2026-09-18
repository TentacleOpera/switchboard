# Feature Plan: Add Compilation and Test Checkboxes to Prompts Tab

## Goal

Add two planner add-on checkboxes — "Do not recompile the project" and "Do not run automated tests" — to the Prompts Tab so users can suppress expensive verification steps when generating planner prompts.

## Metadata

- **Tags:** frontend, UI, UX
- **Complexity:** 5
- **Repo:** fe

## User Review Required

No breaking changes or data-migration concerns. New planner addon flags default to `false` (unchecked/opt-in), so existing prompt behaviour is unchanged for all current users.

> [!NOTE]
> **Clarification**: The plan originally marked backend integration as "if applicable". Investigation confirms it IS required — the full addon pipeline spans 5 files. All touch points are enumerated below.

## Complexity Audit

### Routine
- Adding two `<label class="checkbox-item">` elements to the existing HTML block in `kanban.html` (follows exact pattern of 7 existing planner checkboxes)
- Adding two entries to the hardcoded listener array in `initPromptsTabListeners()`
- Adding two `document.getElementById(...).checked = ...` lines in `handleRoleChange()` for state restore
- Adding two addon entries to `ROLE_ADDONS.planner[]` in `sharedDefaults.js`
- Adding two keys to `DEFAULT_ROLE_CONFIG.planner.addons` in `sharedDefaults.js`
- Declaring two new fields in `PromptBuilderOptions` interface in `agentPromptBuilder.ts`
- Wiring the two new option fields into the `planner` branch of `buildKanbanBatchPrompt()`

### Complex / Risky
- Wiring the new flags through `_getPromptsConfig()` in `KanbanProvider.ts` and propagating them to all three call sites (`_getDefaultPromptPreviews`, `_generateBatchPlannerPrompt`, `_generateAntigravityPrompt`) — if any call site is missed, the checkbox will save state but silently have no effect on the actual dispatched prompt.

## Edge-Case & Dependency Audit

### Race Conditions
- None. These are stateless checkbox flags read synchronously at prompt generation time.

### Security
- None. Flags are user-configurable preferences with no privilege escalation.

### Side Effects
- Toggling either checkbox calls `saveRoleConfig('planner')` and `refreshPreview()` (same as all existing planner addons). No additional side effects.
- The flags only affect planner prompts. Non-planner roles are unaffected.

### Dependencies & Conflicts
- No conflicts with existing addons. The two new keys (`skipCompilation`, `skipTests`) are unused by any current logic.
- `sharedDefaults.js` is consumed by both the webview (injected via `SHARED_DEFAULTS_SCRIPT`) and `KanbanProvider.ts` (via `require`). Changes must be consistent across both contexts.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Missing any of the 5 call sites in `KanbanProvider.ts` leaves the checkbox cosmetically functional but prompt-inert; (2) forgetting to add the IDs to the hardcoded listener array at line 3010 means state changes never trigger `saveRoleConfig`. Mitigations: The Proposed Changes below enumerate every required touch point with file/line precision; implementer must grep for existing analogous keys (e.g., `splitPlan`) to verify all call sites are covered.

## Proposed Changes

---

### 1. `src/webview/sharedDefaults.js`

**Two changes in this file:**

#### 1a. `DEFAULT_ROLE_CONFIG` — Add new keys to planner addons (line 20)

**Context**: The `DEFAULT_ROLE_CONFIG.planner.addons` object is the canonical shape for persisted planner state.

**Logic**: Add `skipCompilation: false` and `skipTests: false` alongside existing keys.

**Implementation**:
```js
// BEFORE (line 20):
addons: { switchboardSafeguards: true, dependencyCheck: false, designDoc: false, aggressivePairProgramming: false, gitProhibition: false, splitPlan: false, clearAntigravityContext: false }

// AFTER:
addons: { switchboardSafeguards: true, dependencyCheck: false, designDoc: false, aggressivePairProgramming: false, gitProhibition: false, splitPlan: false, clearAntigravityContext: false, skipCompilation: false, skipTests: false }
```

**Edge Cases**: Existing persisted configs that lack these keys will resolve to `false` via `?? false` fallback at read sites — no migration needed.

#### 1b. `ROLE_ADDONS.planner[]` — Add two addon descriptor entries (lines 60–68)

**Context**: `ROLE_ADDONS.planner` drives `renderRoleAddons()` in the dynamic tab path. Although the planner tab uses static HTML, `ROLE_ADDONS` must stay in sync with the actual checkboxes for consistency and potential future refactors.

**Logic**: Append two new entries after `clearAntigravityContext`.

**Implementation**:
```js
{ id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: false },
{ id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: false }
```

---

### 2. `src/webview/kanban.html`

**Three changes in this file:**

#### 2a. HTML checkboxes — Add after `plannerAddonClearAntigravityContext` label (after line 2221)

**Context**: The planner Add-ons section ends with the `plannerAddonClearAntigravityContext` label (lines 2217–2221), followed by `</div>` closing `checkbox-group` at line 2222.

**Logic**: Insert two new `<label class="checkbox-item">` elements before the closing `</div>` of the `checkbox-group`.

**Implementation**:
```html
<!-- Insert before the closing </div> of .checkbox-group, after plannerAddonClearAntigravityContext -->

<label class="checkbox-item" title="Skip project compilation step in generated prompts">
  <input type="checkbox" id="plannerAddonSkipCompilation">
  <span>Do not recompile the project</span>
  <span class="tooltip">Skip compilation step to save tokens</span>
</label>

<label class="checkbox-item" title="Skip automated test execution in generated prompts">
  <input type="checkbox" id="plannerAddonSkipTests">
  <span>Do not run automated tests</span>
  <span class="tooltip">Skip automated test execution to save tokens</span>
</label>
```

#### 2b. `handleRoleChange()` — Add state restore lines (after line 2454)

**Context**: Lines 2448–2454 restore each planner checkbox state when the role selector switches to `planner`. Without these, the checkboxes will not restore their saved values on panel re-open or role switch.

**Logic**: Add two `document.getElementById(...).checked = ...` lines matching the existing pattern.

**Implementation**:
```js
// Add after line 2454 (after clearAntigravityContext restore line):
document.getElementById('plannerAddonSkipCompilation').checked = !!config.addons?.skipCompilation;
document.getElementById('plannerAddonSkipTests').checked = !!config.addons?.skipTests;
```

#### 2c. `initPromptsTabListeners()` — Add IDs to the hardcoded listener array (line 3010)

**Context**: The array at line 3010 registers `change` event listeners for every planner addon checkbox. New IDs must be appended or the checkbox changes will never trigger `saveRoleConfig`.

**Logic**: Add `'plannerAddonSkipCompilation'` and `'plannerAddonSkipTests'` to the array.

**Implementation**:
```js
// BEFORE (line 3010):
['plannerAddonSwitchboardSafeguards', 'plannerAddonDependencyCheck', 'plannerAddonDesignDoc', 'plannerAddonAggressivePairProgramming', 'plannerAddonGitProhibition', 'plannerAddonSplitPlan', 'plannerAddonClearAntigravityContext'].forEach(id => {

// AFTER:
['plannerAddonSwitchboardSafeguards', 'plannerAddonDependencyCheck', 'plannerAddonDesignDoc', 'plannerAddonAggressivePairProgramming', 'plannerAddonGitProhibition', 'plannerAddonSplitPlan', 'plannerAddonClearAntigravityContext', 'plannerAddonSkipCompilation', 'plannerAddonSkipTests'].forEach(id => {
```

**Edge Cases**: The `addonId` derivation in the listener body uses `id.replace('plannerAddon', '')` then lowercases the first character — this produces `skipCompilation` and `skipTests` automatically, matching the `DEFAULT_ROLE_CONFIG` keys added in Step 1a.

---

### 3. `src/services/agentPromptBuilder.ts`

**Two changes in this file:**

#### 3a. `PromptBuilderOptions` interface — Declare new fields (after line 114)

**Context**: Every option consumed by `buildKanbanBatchPrompt` must be declared in this interface for TypeScript type safety.

**Implementation**:
```ts
/** When true, instructs planner agent to skip project compilation in its verification steps. */
skipCompilation?: boolean;
/** When true, instructs planner agent to skip automated test execution in its verification steps. */
skipTests?: boolean;
```

#### 3b. `buildKanbanBatchPrompt()` planner branch — Consume new flags (after line 334)

**Context**: The planner branch (lines 296–363) assembles `plannerBase` by conditionally appending directive blocks. The new flags should append to `plannerBase` using the same pattern as `splitPlan` and `dependencyCheckEnabled`.

**Logic**: Define directive text constants and append them when the flags are enabled.

**Implementation**:
```ts
// New constants (add near other directive constants, around line 207):
export const SKIP_COMPILATION_DIRECTIVE = `SKIP COMPILATION: Do NOT run any project compilation step (e.g. tsc, mvn compile, gradle build, make) as part of the verification plan. The project is assumed to be in a pre-compiled or compilation-free state for this session.`;
export const SKIP_TESTS_DIRECTIVE = `SKIP TESTS: Do NOT run automated tests (unit, integration, or e2e) as part of the verification plan. The test suite will be run separately by the user.`;

// In the planner branch (after the splitPlan block, around line 334):
const skipCompilation = options?.skipCompilation ?? false;
const skipTests = options?.skipTests ?? false;

if (skipCompilation) {
    plannerBase += '\n\n' + SKIP_COMPILATION_DIRECTIVE;
}
if (skipTests) {
    plannerBase += '\n\n' + SKIP_TESTS_DIRECTIVE;
}
```

---

### 4. `src/services/KanbanProvider.ts`

**Three call sites to update in this file:**

#### 4a. `_getPromptsConfig()` — Add the two new fields to the returned config object (around line 2261)

**Context**: This method is the single source of truth for reading persisted role config into a structured `promptsConfig` object. Both new flags should be read from `plannerConfig.addons` with `false` defaults.

**Implementation**:
```ts
// Add after `splitPlan: plannerConfig?.addons?.splitPlan ?? false,` (line 2261):
skipCompilation: plannerConfig?.addons?.skipCompilation ?? false,
skipTests: plannerConfig?.addons?.skipTests ?? false,
```

#### 4b. `_getDefaultPromptPreviews()` — Pass new flags to planner prompt builder (around line 2178–2180)

**Context**: The preview generator must pass the new flags to `buildKanbanBatchPrompt` for the `planner` role or the Prompts Tab preview won't reflect checkbox state.

**Implementation**:
```ts
// Add after `splitPlan: role === 'planner' ? promptsConfig.splitPlan : undefined,` (line 2180):
skipCompilation: role === 'planner' ? promptsConfig.skipCompilation : undefined,
skipTests: role === 'planner' ? promptsConfig.skipTests : undefined,
```

#### 4c. `_generateBatchPlannerPrompt()` — Pass new flags (around line 2510)

**Context**: This method generates the actual dispatched prompt when a card is moved. Without these flags here, the saved checkbox state has no effect on real prompt output.

**Implementation**:
```ts
// Add after `splitPlan: promptsConfig.splitPlan,` (line 2510):
skipCompilation: promptsConfig.skipCompilation,
skipTests: promptsConfig.skipTests,
```

#### 4d. `_generateAntigravityPrompt()` — Pass new flags (around line 2411)

**Context**: The Antigravity prompt generator also builds planner prompts and must include the new flags.

**Implementation**:
```ts
// Add after `splitPlan: role === 'planner' ? promptsConfig.splitPlan : undefined,` (line 2411):
skipCompilation: role === 'planner' ? promptsConfig.skipCompilation : undefined,
skipTests: role === 'planner' ? promptsConfig.skipTests : undefined,
```

---

### 5. `dist/webview/kanban.html`

**Context**: The `dist/` file is the compiled output. It will be rebuilt via `npm run build` or `npx webpack` after changes are made to the source file. Do NOT manually edit this file.

**Implementation**: Run the project build after all source changes are complete.

## Verification Plan

### Automated Tests

- Run existing test suite to confirm no regressions:
  ```
  npm test
  ```
- Verify the new constants appear in prompt output when flags are enabled:
  ```ts
  // In a test or REPL:
  import { buildKanbanBatchPrompt } from './src/services/agentPromptBuilder';
  const prompt = buildKanbanBatchPrompt('planner', [{ topic: 'Test', absolutePath: '/path/plan.md' }], { skipCompilation: true, skipTests: true });
  console.log(prompt.includes('SKIP COMPILATION')); // → true
  console.log(prompt.includes('SKIP TESTS'));        // → true
  ```

### Manual Verification

- [ ] Verify checkboxes appear in the prompts tab UI under Planner Add-ons
- [ ] Verify checkbox states persist across panel close/reopen (VSCode reload)
- [ ] Verify the Prompts Tab preview updates when checkboxes are toggled
- [ ] Verify that "Do not recompile" checked → `SKIP COMPILATION` directive appears in preview
- [ ] Verify that "Do not run automated tests" checked → `SKIP TESTS` directive appears in preview
- [ ] Verify unchecked boxes have zero effect on prompt output
- [ ] Verify tooltips display correctly on hover
- [ ] Verify that dispatching a card from CREATED column with both checkboxes on includes both directives in the clipboard/CLI prompt
- [ ] Test checkbox state isolation: toggling these checkboxes does not affect lead, coder, or reviewer prompts

## Files Changed

- `src/webview/sharedDefaults.js` — `DEFAULT_ROLE_CONFIG` + `ROLE_ADDONS`
- `src/webview/kanban.html` — HTML checkboxes + `handleRoleChange` restore + listener array
- `src/services/agentPromptBuilder.ts` — `PromptBuilderOptions` interface + planner branch + directive constants
- `src/services/KanbanProvider.ts` — `_getPromptsConfig` + 3 call sites
- `dist/webview/kanban.html` — rebuild artefact (do not manually edit)

---

**Recommendation: Send to Coder**

---

## Reviewer Pass — Results

**Reviewer:** Antigravity (inline, no auxiliary workflow)
**Reviewed At:** 2026-05-22

### Findings Summary

| # | Severity | Description | Outcome |
|---|---|---|---|
| 1 | NIT | `skipCompilation`/`skipTests` extracted at top-level scope, used only in planner branch | Keep — consistent with existing pattern for all planner-only flags |
| 2 | NIT | `SKIP_COMPILATION_DIRECTIVE` / `SKIP_TESTS_DIRECTIVE` constant ordering within export group | Deferred — no runtime effect, cosmetic only |
| 3 | MAJOR → RESOLVED | 5th KanbanProvider call site (line 5864) not enumerated in plan; verified as the `getPromptPreview` handler, correctly wired | Implementer correctly went beyond plan enumeration — no defect |
| 4 | NIT (pre-existing) | `promptCustomization.style.display` logic for `research_planner` shows both panels | Out of scope — pre-existing, not introduced by this plan |
| 5 | N/A | Listener key derivation (`plannerAddon` → `skipCompilation`) verified correct | Passes |

**CRITICAL/MAJOR defects requiring code fixes: 0**

### Validation Results

Full static signal-chain trace completed for both flags:

- **`plannerAddonSkipCompilation` → `skipCompilation` → `SKIP_COMPILATION_DIRECTIVE`**: All 13 links verified ✅
- **`plannerAddonSkipTests` → `skipTests` → `SKIP_TESTS_DIRECTIVE`**: All 13 links verified ✅

#### Files Verified

| File | Changes | Status |
|---|---|---|
| `src/webview/sharedDefaults.js` | `DEFAULT_ROLE_CONFIG.planner.addons` + `ROLE_ADDONS.planner[]` | ✅ Correct |
| `src/webview/kanban.html` | HTML checkboxes + `handleRoleChange()` restore + listener array | ✅ Correct |
| `src/services/agentPromptBuilder.ts` | `PromptBuilderOptions` interface + directive constants + planner branch | ✅ Correct |
| `src/services/KanbanProvider.ts` | `_getPromptsConfig()` + `_getDefaultPromptPreviews()` + `getPromptPreview` handler + `_generateAntigravityPrompt()` + `_generateBatchPlannerPrompt()` | ✅ Correct — 5 call sites all wired |
| `dist/webview/kanban.html` | Rebuild artifact | ⏳ Pending `npm run build` |

### Remaining Risks

- **Low:** `dist/webview/kanban.html` not yet rebuilt — the extension won't reflect checkbox changes until a build is run. This is expected; per the plan, the dist file is a build artifact.
- **Low:** Existing persisted configs without `skipCompilation`/`skipTests` keys resolve correctly to `false` via `?? false` fallbacks — no migration needed, confirmed.
- **None:** No regression risk to other roles — flags are planner-gated at every call site with `role === 'planner' ? ... : undefined` guards.

**ACCURACY VERIFICATION COMPLETE**
