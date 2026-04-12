# Remove Blanket Git Ignore Default for Custom Mode

## Goal

Remove the blanket default git ignore patterns (`.switchboard/*` and `.agent/*`) that appear when switching to 'custom' git ignore mode in the setup menu. The default strategy is `targetedGitignore`, but when users switch to `custom`, the rules textarea auto-fills with these blanket patterns, which is problematic because cloud agents often need plans in the repository.

## Metadata
**Tags:** frontend, backend, UI, bugfix
**Complexity:** 5

## User Review Required
> [!NOTE]
> - Existing saved `switchboard.workspace.ignoreRules` values must remain untouched. This plan changes only the unsaved default state for fresh or unset workspaces.
> - **Clarification:** `switchboard.workspace.ignoreRules` is shared by both `localExclude` and `custom`, so removing the implicit blanket defaults must be done in the package contribution schema and the runtime fallbacks together. Changing only the setup webview would leave the old defaults coming back from configuration hydration.
> - **Clarification:** This plan does not change the default strategy (`targetedGitignore`), the targeted managed block contents, or the set of available strategies.
> - **Recommended Agent:** Send to Coder

## Complexity Audit
### Routine
- Change the default `switchboard.workspace.ignoreRules` contribution in `package.json` from `['.switchboard/*', '.agent/*']` to `[]` so fresh workspaces do not implicitly seed blanket exclusions.
- Update `src/webview/setup.html` so the setup panel initializes and hydrates custom/local rules with an empty array when no rules are saved, and update the existing warning copy below the textarea to explain the cloud-agent constraint.
- Update `src/services/TaskViewerProvider.ts` to stop supplying the blanket fallback when hydrating the setup panel.
- Add a focused source-level regression test under `src/test/` that locks all of the above defaults together.

### Complex / Risky
- `src/services/WorkspaceExcludeService.ts` still owns a blanket `DEFAULT_RULES` array. If that remains unchanged, backend apply behavior can still treat the old blanket patterns as the default source of truth even after the UI looks fixed.
- The real risk is split defaults: `package.json`, `WorkspaceExcludeService`, `TaskViewerProvider`, and `setup.html` can each independently repopulate the old blanket rules. The implementation must remove the implicit default from every origin so the setup panel, saved config contract, and file-application layer stay consistent.
- Because `localExclude` and `custom` share the same stored `ignoreRules` array, this change intentionally means both presets start empty on a fresh workspace. That is an implied consequence of the requirement, not a new product requirement.

## Edge-Case & Dependency Audit
- **Race Conditions:** `src/extension.ts` already debounces workspace-exclusion re-application through `scheduleWorkspaceExcludeApply()` with a 75 ms timer, so this plan does not introduce a new write race. The real consistency hazard is stale default data re-entering during setup hydration if any one fallback source is left unchanged.
- **Security:** There is no code-execution surface here, but blanket defaults are a workflow-visibility problem: `.switchboard/*` can hide `.switchboard/plans/` from git, which directly undermines cloud-agent and shared-repo workflows. The warning copy should make that risk explicit without inventing new behavior.
- **Side Effects:** Fresh workspaces that switch to `custom` or `localExclude` will now see an empty rules list until the user enters rules explicitly. Existing workspaces with saved rules remain unchanged because saved configuration still wins over defaults. `targetedGitignore` remains the default preset and continues to show the backend-provided targeted preview.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` succeeded. The active Kanban state has no items in **New** and only this plan in **Planned**, so there are no active-plan dependencies or conflicts to sequence around. A scan of `.switchboard/plans/` found historical same-area plans (`add_git_ignore_ui_to_setup_menu.md` and `brain_a5243677e6100f40a729fd8c8416490e12fe5b5d0e5eb4fd73a7e3a42a58d694_restore_targeted_gitignore_strategy_as_default_for_workspace_exclusion_system.md`) that touch the same files, but they are already non-active and should be treated only as context, not as active blockers.

## Adversarial Synthesis
### Grumpy Critique
> Oh, marvelous — a “tiny custom-mode tweak” that somehow forgot the defaults live in four different places. If you only zero out the textarea state in `setup.html`, the backend politely shoves the old blanket rules right back in on the next hydration. If you only change `TaskViewerProvider`, VS Code still serves the blanket array from `package.json`. If you only change the schema, `WorkspaceExcludeService` still clings to `['.switchboard/*', '.agent/*']` like it’s a sacred relic. That is how you get a feature that looks fixed during a demo and mysteriously resurrects the exact bad defaults in real use. And the original draft warning note is clumsy too — the DOM already has a warning block, so blindly adding a second one is how you make a tiny form noisier while still missing the real problem. The plan must treat “blanket default” as a contract issue across schema, hydration, and apply logic, or it is not a plan; it is wishful thinking with a textarea.

### Balanced Response
> The critique is correct, so the implementation scope is tightened without expanding product scope. The plan now removes the implicit blanket default from every authoritative source: `package.json` for configuration defaults, `WorkspaceExcludeService` for backend apply behavior, `TaskViewerProvider` for setup hydration, and `setup.html` for initial webview state plus user-facing warning copy. The UI change reuses the existing `#git-ignore-warning` element instead of introducing redundant markup, and the regression coverage explicitly asserts all four default sources so the bug cannot quietly reappear through one untouched fallback. This preserves the original intent — custom mode should start empty and users should be warned not to hide `.switchboard/plans/` — while making the plan technically complete.

## Problem

The setup menu's git ignore strategy dropdown has four options:
1. `targetedGitignore` — .gitignore (targeted, recommended) — **this is the default**
2. `localExclude` — .git/info/exclude (local only)
3. `custom` — .gitignore (you manage the rules)
4. `none` — do not manage ignore files

When a user switches from the default `targetedGitignore` to `custom`, the rules textarea auto-populates with:
- `.switchboard/*`
- `.agent/*`

This blanket default is problematic because:
1. **Cloud agents require plans in the repo** — Cloud coders (like Jules) need `.switchboard/plans/` to be committed to the repository to work properly. The blanket `.switchboard/*` pattern would exclude them.
2. Users may not realize these defaults are being applied when they switch to custom mode
3. It forces users to manually remove patterns they don't want excluded
4. The default assumes a local-only workflow that doesn't account for cloud agent use cases
5. **Clarification:** The blanket defaults do not come from only one place. They are currently seeded by the package configuration default, the webview's local initial state, the webview hydration fallback, and `WorkspaceExcludeService.DEFAULT_RULES`.

## Solution

Remove the default patterns from the initial state when switching to `custom` mode. Start with an empty rules array and let users explicitly add patterns they want to ignore. Add a warning note in the UI that cloud coders require plans to be in the repository.

**Clarification:** To make that behavior real instead of cosmetic, the implementation must remove the implicit blanket defaults from every unsaved default source:
1. `package.json` default for `switchboard.workspace.ignoreRules`
2. `src/services/WorkspaceExcludeService.ts` fallback default rules
3. `src/services/TaskViewerProvider.ts` setup-panel hydration fallback
4. `src/webview/setup.html` initial local state and message fallback

---

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Low-Complexity / Routine Implementation Steps
1. Update `package.json` so `switchboard.workspace.ignoreRules` defaults to `[]` for fresh workspaces instead of blanket exclusions.
2. Update `src/webview/setup.html` to initialize `lastGitIgnoreConfig.rules` as `[]`, fall back to `[]` when `gitIgnoreConfig` arrives without saved rules, and replace the existing warning copy with text that explicitly calls out the cloud-agent `.switchboard/plans/` requirement.
3. Update `src/services/TaskViewerProvider.ts` so `handleGetGitIgnoreConfig()` stops providing the blanket fallback array when hydrating the setup panel.
4. Add a focused regression test in `src/test/git-ignore-custom-default-regression.test.js` that asserts the schema default, setup initial state, hydration fallback, provider fallback, backend fallback, and warning copy all match the intended behavior.

### High-Complexity / Complex / Risky Implementation Steps
1. Update `src/services/WorkspaceExcludeService.ts` so the backend apply layer also treats the unsaved default as empty. This prevents the bug from reappearing when config is missing and the service writes managed blocks based on stale defaults.
2. Keep the shared `ignoreRules` contract intact across `localExclude` and `custom`: saved rules still load and persist normally, but fresh/unset state must remain empty. The implementation must not accidentally serialize targeted preview rules into the editable custom/local rules array.
3. Ensure the cloud-agent warning is additive only. It should explain why blanket `.switchboard/*` rules are dangerous without changing preset behavior, adding new toggles, or introducing new validation rules.

### Workspace configuration defaults
#### [MODIFY] `package.json`
- **Context:** `switchboard.workspace.ignoreRules` currently defaults to `[".switchboard/*", ".agent/*"]`, which means the configuration system itself seeds the blanket rules before the setup panel renders.
- **Logic:**
  1. Change the contribution default to an empty array.
  2. Keep the same setting name and description so existing saved workspace settings continue to override the default normally.
  3. Do not change `ignoreStrategy`; `targetedGitignore` remains the default strategy.
- **Implementation:**

```diff
@@
         "switchboard.workspace.ignoreRules": {
           "type": "array",
           "items": {
             "type": "string"
           },
-          "default": [
-            ".switchboard/*",
-            ".agent/*"
-          ],
+          "default": [],
           "description": "Stored ignore rules used by the localExclude preset and the editable custom preset. Each entry is appended as a separate line.",
           "scope": "resource"
         },
```

- **Edge Cases Handled:** Fresh workspaces no longer auto-seed blanket exclusions, while existing saved arrays still override this default exactly as before.

### Setup panel UI state and hydration
#### [MODIFY] `src/webview/setup.html`
- **Context:** The setup webview currently hardcodes the blanket rules twice: once in the initial `lastGitIgnoreConfig` state and again in the `gitIgnoreConfig` message fallback. It also already has a warning block below the textarea, so the plan should update that existing block rather than add duplicate warning UI.
- **Logic:**
  1. Change the initial `lastGitIgnoreConfig.rules` array to `[]`.
  2. Change the `gitIgnoreConfig` message fallback to `[]` so hydration does not reinsert blanket defaults when no rules are saved.
  3. Replace the existing warning text with copy that preserves the read-only note and adds the cloud-agent guidance in the same block.
  4. Leave `collectSetupSavePayload()` unchanged: it already keeps preset display rules separate from editable custom rules by only sanitizing the textarea when `strategy === 'custom'`.
- **Implementation:**

```diff
@@
                 <div id="git-ignore-warning" style="font-size:10px; color:var(--text-secondary); line-height:1.4; font-family:var(--font-mono);">
-                    Preset strategies are read-only. Switchboard updates only its fenced managed block and preserves unrelated rules.
+                    Preset strategies are read-only. Switchboard updates only its fenced managed block and preserves unrelated rules. Cloud coders (e.g., Jules) require .switchboard/plans/ to be in the repository, so avoid blanket .switchboard/* rules unless you intentionally want to hide plans from git.
                 </div>
@@
         let lastGitIgnoreConfig = {
             strategy: 'targetedGitignore',
-            rules: ['.switchboard/*', '.agent/*'],
+            rules: [],
             targetedRulesDisplay: ''
         };
@@
                         const rules = Array.isArray(message.rules)
                             ? message.rules.map(rule => String(rule).trim()).filter(Boolean)
-                            : ['.switchboard/*', '.agent/*'];
+                            : [];
                         const targetedRulesDisplay = Array.isArray(message.targetedRulesDisplay)
                             ? message.targetedRulesDisplay.map(rule => String(rule)).join('\n')
                             : '';
```

- **Retained original draft snippet (verbatim):**

```diff
@@
         let lastGitIgnoreConfig = {
             strategy: 'localExclude',
-            rules: ['.switchboard/*', '.agent/*']
+            rules: []
         };
```

Add warning note after the git ignore rules textarea (find the textarea around line 456):

```diff
@@
                 <div class="startup-row" style="display:flex; flex-direction:column; gap:6px; align-items:stretch;">
                     <label for="git-ignore-rules" style="font-size:11px; color:var(--text-secondary);">Ignore rules (one glob per line)</label>
                     <textarea id="git-ignore-rules" class="modal-textarea" style="min-height:96px; font-size:11px;" readonly placeholder="Rules displayed here (read-only for preset strategies)"></textarea>
                 </div>
+                <div id="git-ignore-cloud-warning" style="font-size:10px; color:var(--accent-orange); line-height:1.4; font-family:var(--font-mono); margin-top:4px;">
+                    ⚠️ Cloud coders (e.g., Jules) require .switchboard/plans/ to be in the repository. Do not add .switchboard/* to your ignore rules if using cloud agents.
+                </div>
```

- **Clarification:** The retained draft snippet above identified the user-facing problem correctly, but the authoritative implementation reuses the existing `#git-ignore-warning` block and the real current default strategy (`targetedGitignore`) instead of adding redundant DOM and regressing the initialized strategy.
- **Edge Cases Handled:** Fresh setup hydration no longer repopulates blanket rules, the warning is visible without duplicate UI, and the existing custom-draft preservation logic remains unchanged.

### Setup-panel hydration contract
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `handleGetGitIgnoreConfig()` still asks VS Code for `ignoreRules` with a blanket fallback array. Even if the webview defaults are fixed, this method can hydrate the old rules back into the setup panel when no configuration is saved.
- **Logic:**
  1. Change the `ignoreRules` fallback from the blanket array to `[]`.
  2. Leave `_normalizeGitIgnoreConfig()` unchanged; it already trims and deduplicates arrays while converting non-arrays to `[]`.
  3. Keep returning `targetedRulesDisplay` from `WorkspaceExcludeService.getTargetedRules()` so targeted preview behavior stays unchanged.
- **Implementation:**

```diff
@@
         const { strategy, rules } = this._normalizeGitIgnoreConfig(
             config.get<string>('ignoreStrategy', 'targetedGitignore'),
-            config.get<string[]>('ignoreRules', ['.switchboard/*', '.agent/*'])
+            config.get<string[]>('ignoreRules', [])
         );
         return {
             strategy,
             rules,
             targetedRulesDisplay: WorkspaceExcludeService.getTargetedRules()
```

- **Retained original draft snippet (verbatim):**

```diff
@@
         const rawRules = config.get('ignoreRules');
         const rules = Array.isArray(rawRules)
             ? rawRules.map(rule => String(rule).trim()).filter(Boolean)
-            : ['.switchboard/*', '.agent/*'];
+            : [];
         return { strategy, rules };
```

- **Clarification:** The retained snippet captures the intended empty fallback, but the current codebase already centralizes normalization in `_normalizeGitIgnoreConfig()`, so the authoritative change belongs at the `config.get<string[]>('ignoreRules', ...)` call site shown above.
- **Edge Cases Handled:** Setup hydration now matches the configuration schema and does not reinsert blanket defaults on unopened or freshly created workspaces.

### Backend apply fallback
#### [MODIFY] `src/services/WorkspaceExcludeService.ts`
- **Context:** `WorkspaceExcludeService.apply()` still reads `ignoreRules` with `WorkspaceExcludeService.DEFAULT_RULES`, and that default is currently the blanket array. Leaving this unchanged would make the backend apply layer inconsistent with the setup panel and config schema.
- **Logic:**
  1. Change `DEFAULT_RULES` to an explicitly typed empty `string[]`.
  2. Keep the rest of `apply()` unchanged so saved rules still flow through `localExclude` and `custom` exactly as before.
  3. Do not alter `TARGETED_RULES`; the targeted strategy is not part of this bug.
- **Implementation:**

```diff
@@
-    private static readonly DEFAULT_RULES = ['.switchboard/*', '.agent/*'];
+    private static readonly DEFAULT_RULES: string[] = [];
```

- **Edge Cases Handled:** Backend writes no longer synthesize blanket ignore rules when no editable rules are configured, and the empty array remains type-safe for `config.get('ignoreRules', WorkspaceExcludeService.DEFAULT_RULES)`.

### Setup-panel message routing
#### [NO CHANGE] `src/services/SetupPanelProvider.ts`
- **Context:** The provider already forwards `getGitIgnoreConfig` through `handleGetGitIgnoreConfig()` and posts `{ type: 'gitIgnoreConfig', ...config }` to the webview.
- **Logic:** No code change is required because the enriched empty-default behavior flows through the existing message transport automatically.
- **Implementation:** No code change required.
- **Edge Cases Handled:** Avoids unnecessary parallel plumbing changes in a file that already acts as a transparent transport layer for this payload.

### Regression coverage
#### [CREATE] `src/test/git-ignore-custom-default-regression.test.js`
- **Context:** This bug spans schema defaults, setup initial state, hydration fallback, provider fallback, backend fallback, and warning copy. A focused source-level regression test is the lowest-risk way to lock the contract together without adding new test infrastructure.
- **Logic:**
  1. Read `package.json`, `setup.html`, `TaskViewerProvider.ts`, and `WorkspaceExcludeService.ts` from disk.
  2. Assert that the configuration default is `[]`.
  3. Assert that the setup webview initializes and hydrates with `[]`.
  4. Assert that the provider and backend fallback arrays are empty.
  5. Assert that the warning copy explicitly mentions `.switchboard/plans/` and cloud coders.
- **Implementation:**

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

function run() {
    const packageSource = readSource('package.json');
    const setupSource = readSource('src', 'webview', 'setup.html');
    const providerSource = readSource('src', 'services', 'TaskViewerProvider.ts');
    const excludeServiceSource = readSource('src', 'services', 'WorkspaceExcludeService.ts');

    assert.match(
        packageSource,
        /"switchboard\.workspace\.ignoreRules":[\s\S]*"default": \[\]/m,
        'Expected ignoreRules setting to default to an empty array so custom mode does not seed blanket exclusions.'
    );

    assert.match(
        setupSource,
        /let lastGitIgnoreConfig = \{\s*strategy: 'targetedGitignore',\s*rules: \[\],\s*targetedRulesDisplay: ''\s*\};/m,
        'Expected setup.html to initialize custom/local git-ignore rules as empty.'
    );

    assert.match(
        setupSource,
        /const rules = Array\.isArray\(message\.rules\)\s*\?\s*message\.rules\.map\(rule => String\(rule\)\.trim\(\)\)\.filter\(Boolean\)\s*:\s*\[\];/m,
        'Expected setup.html hydration to fall back to an empty rules list when no custom rules are saved.'
    );

    assert.match(
        providerSource,
        /config\.get<string\[\]>\('ignoreRules', \[\]\)/m,
        'Expected TaskViewerProvider to stop hydrating blanket ignore defaults.'
    );

    assert.match(
        excludeServiceSource,
        /private static readonly DEFAULT_RULES: string\[\] = \[\];/m,
        'Expected WorkspaceExcludeService to treat the unsaved editable rule default as empty.'
    );

    assert.ok(
        setupSource.includes('Cloud coders (e.g., Jules) require .switchboard/plans/ to be in the repository'),
        'Expected setup warning copy to explain the cloud-agent requirement for committed plans.'
    );

    console.log('git ignore custom default regression test passed');
}

try {
    run();
} catch (error) {
    console.error('git ignore custom default regression test failed:', error);
    process.exit(1);
}
```

- **Edge Cases Handled:** The test fails if any one of the four default sources or the warning copy regresses independently, which is the exact failure mode that made the original plan under-specified.

---

## Edge Cases & Considerations

- **Existing users:** Users who already have saved configurations will not be affected. Their saved rules will be loaded normally.
- **New users:** New users will see an empty rules textarea when they switch to `custom`, and an empty local rules list when they switch to `localExclude` with no saved rules. This is the intended consequence of removing the implicit blanket defaults.
- **Clarification:** No `targetedGitignore` logic changes are required. The targeted preview continues to come from `WorkspaceExcludeService.getTargetedRules()`.
- **Clarification:** No `SetupPanelProvider` transport changes are required because it already forwards the git-ignore payload end-to-end.
- **Documentation:** No direct README update is required unless other setup documentation explicitly claims that custom/local rules start with blanket defaults. This plan should not add speculative documentation churn.
- **Placeholder:** The current textarea placeholder is generic read-only copy, not example blanket patterns. Do not rely on placeholder text as the mechanism for warning users.

---

## Verification Plan
### Automated Tests
- `npm run compile`
- `node src/test/workspace-exclude-strategy-regression.test.js`
- `node src/test/setup-autosave-regression.test.js`
- `node src/test/git-ignore-custom-default-regression.test.js`

### Manual Validation
1. Open the setup menu and navigate to the Git Ignore Strategy section.
2. Verify `targetedGitignore` still renders its targeted preview unchanged.
3. Switch to `custom` in a workspace with no saved `ignoreRules` and verify the textarea is empty.
4. Verify the warning below the textarea explicitly explains that cloud coders require `.switchboard/plans/` to stay in the repository.
5. Enter a custom rule, let autosave persist it, reload the setup panel, and verify the rule still loads.
6. Switch back to `custom` after viewing preset strategies and verify the saved custom rules still return instead of being replaced by targeted preview rules.
7. Verify an existing workspace with saved blanket rules still shows those saved rules rather than silently deleting them.

## Testing

1. Open the setup menu and navigate to the Git Ignore Strategy section
2. Verify that the ignore rules textarea is empty (no pre-populated patterns)
3. Add a custom pattern and click APPLY
4. Verify the pattern is saved and persists after reload
5. Verify that existing saved configurations still load correctly

## Recommended Agent

Send to Coder

---

## Reviewer Pass (2026-04-12)

### Fixed Items
- No additional CRITICAL or MAJOR code fixes were required during the reviewer pass. The implementation already removed the blanket editable-rule defaults from every authoritative source named in this plan: `package.json`, `src/webview/setup.html`, `src/services/TaskViewerProvider.ts`, and `src/services/WorkspaceExcludeService.ts`.

### Files Changed During Reviewer Pass
- `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/remove_blanket_gitignore_default_for_custom_mode.md` — appended reviewer-pass findings and validation record.

### Validation Results
- `npm run compile` — passed.
- `node src/test/workspace-exclude-strategy-regression.test.js` — passed.
- `node src/test/setup-autosave-regression.test.js` — passed.
- `node src/test/git-ignore-custom-default-regression.test.js` — passed.
- `npm run lint` — failed with the pre-existing ESLint 9 repository configuration issue (`eslint.config.*` missing).
- `npx tsc --noEmit` — failed with the pre-existing `TS2835` dynamic-import extension error at `src/services/KanbanProvider.ts:2453` for `await import('./ArchiveManager')`.

### Remaining Risks
- Manual VS Code interaction for the setup panel was not exercised in this reviewer pass, so the user-facing flow is still relying on source-level and build/test validation rather than a live UI click-through.
- The worktree still contains an unrelated `.gitignore` modification outside this plan's implementation contract; it was not changed here.

### Reviewer Verdict
- Ready. The implemented code satisfies the plan requirements, the regression coverage locks the intended contract in place, and no additional material defects were found in the plan-scoped code.

### Reviewer Correction (2026-04-12)
- Follow-up review found a missed repo-level regression: `.vscode/settings.json` had committed `switchboard.workspace.ignoreStrategy` / `switchboard.workspace.ignoreRules` overrides. Those workspace settings would have seeded fresh users in this repository with shared git-ignore behavior instead of letting the extension's intended defaults apply.
- Fix applied: removed the committed workspace overrides from `.vscode/settings.json` so fresh users inherit the real product defaults (`targetedGitignore` strategy, empty editable-rule storage until users intentionally save custom/local rules).
- Regression test hardening: `src/test/git-ignore-custom-default-regression.test.js` now also asserts that:
  - `switchboard.workspace.ignoreStrategy` still defaults to `targetedGitignore` in `package.json`.
  - `.vscode/settings.json` does not override `switchboard.workspace.ignoreStrategy`.
  - `.vscode/settings.json` does not seed `switchboard.workspace.ignoreRules`.
- Follow-up validation:
  - `npm run compile` — passed.
  - `node src/test/setup-autosave-regression.test.js` — passed.
  - `node src/test/git-ignore-custom-default-regression.test.js` — passed.
