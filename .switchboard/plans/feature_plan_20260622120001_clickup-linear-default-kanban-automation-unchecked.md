# Default ClickUp/Linear Setup to Unchecked "Enable Kanban Sync" and "Enable Automation"

## Goal

In `setup.html`, the ClickUp and Linear integration sections must NOT default to having the **Enable Kanban sync** and **Enable automation** disclosure checkboxes checked. A fresh / unconfigured integration should present both master toggles unchecked (and their bodies collapsed).

### Problem Analysis

The two master disclosure checkboxes — `clickup-disclosure-kanban` / `clickup-disclosure-automation` (and the Linear equivalents `linear-disclosure-kanban` / `linear-disclosure-automation`) — are not driven by their own persisted value. Instead, `syncSectionDisclosure(provider)` in [setup.html](src/webview/setup.html#L2783-L2833) **derives** the master checked state from whether any of the child sub-options are checked, OR whether the inner editor section is visible:

```js
const kOpen = !!(mappingsEditorVisible || createFolder || createLists || createFields);
kMaster.checked = kOpen;
...
const aOpen = !!(automationEditorVisible || realtimeSync || deleteSync || autoPull);
aMaster.checked = aOpen;
```

The child checkboxes are populated from backend state via `setCheckboxState(...)` in `renderClickupOptionSummary` / `renderLinearOptionSummary` ([setup.html:2453-2527](src/webview/setup.html#L2453-L2527)). For Linear specifically, two children default to ON even when unset:

```js
setCheckboxState('linear-option-enable-complete-sync', state.completeSyncEnabled !== false); // defaults ON
setCheckboxState('linear-option-exclude-backlog', state.excludeBacklog !== false);          // defaults ON
```

While `exclude-backlog` and `complete-sync` are not themselves part of the kanban/automation `OR` expressions, they are related default-ON issues on a fresh integration (out of scope for this plan — see Edge-Case Audit).

### Root Cause

**The primary root cause is the `mappingsEditorVisible` / `automationEditorVisible` terms in the `kOpen` / `aOpen` OR expressions.** These terms check whether the inner editor sections (`clickup-mappings-section`, `clickup-automation-section`, `linear-automation-section`) have the `hidden` class. Critically, these sections' visibility is gated on `setupComplete === true` by their render functions:

- `renderClickupMappings` ([setup.html:2608](src/webview/setup.html#L2608)): `const visible = !!state && state.setupComplete === true;`
- `renderClickupAutomation` ([setup.html:2691](src/webview/setup.html#L2691)): `const configured = !!state && state.setupComplete === true;`
- `renderLinearAutomation` ([setup.html:2853](src/webview/setup.html#L2853)): `const configured = !!state && state.setupComplete === true;`

So whenever `setupComplete === true`, the editor sections are visible, which makes `mappingsEditorVisible` / `automationEditorVisible` evaluate to `true`, which **unconditionally forces `kOpen` and `aOpen` to `true`** — regardless of whether the user actually enabled any kanban sync options or automation features. The child checkbox state becomes irrelevant.

This means: a user who completed the initial ClickUp/Linear setup wizard (setting `setupComplete = true`) but never explicitly enabled kanban sync or automation will see both master toggles checked and their bodies expanded on every revisit, falsely implying they opted into sync/automation.

**Secondary factor:** `syncSectionDisclosure()` has no "unconfigured ⇒ collapsed/unchecked" guard. Even if the section-visibility terms were removed, the master is still a pure function of child checkbox state, and child state can be truthy as a side-effect of the setup wizard (e.g. `folderReady` / `listsReady` become true during ClickUp setup). However, these child-state truths are arguably correct signals (the user DID create a folder/lists), unlike the section-visibility terms which are false positives.

**Affected expressions:**
- ClickUp kanban `kOpen` ([setup.html:2795](src/webview/setup.html#L2795)): includes `mappingsEditorVisible` → forced true when `setupComplete`.
- ClickUp automation `aOpen` ([setup.html:2804](src/webview/setup.html#L2804)): includes `automationEditorVisible` → forced true when `setupComplete`.
- Linear automation `aOpen` ([setup.html:2828](src/webview/setup.html#L2828)): includes `automationEditorVisible` → forced true when `setupComplete`.
- Linear kanban `kOpen` ([setup.html:2819](src/webview/setup.html#L2819)): does NOT include a section-visibility term — only checks `mapColumns || createLabel || includeProj || excludeProj`. Not affected by the primary root cause, but may still light up from setup-wizard child state (arguably correct).

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, bugfix

## User Review Required

Yes — the fix changes when the kanban/automation master disclosure toggles render as checked. Specifically, users who completed the initial setup wizard (`setupComplete = true`) but did NOT explicitly enable any kanban sync options or automation features will now see both masters **unchecked and collapsed** on revisit (previously: checked and expanded). This is the intended behavior change but should be confirmed as the desired UX, since some users may have relied on the auto-expanded bodies to discover configuration options.

## Complexity Audit

### Routine
- Removing the `mappingsEditorVisible` / `automationEditorVisible` terms from the `kOpen` / `aOpen` OR expressions in `syncSectionDisclosure()` — a single function, four lines changed.
- Adding an automation-rules-presence check to `aOpen` so users who have saved automation rules (but no realtime/delete/autopull enabled) still see the automation master checked and body expanded.
- Single-file change (`src/webview/setup.html`). No backend changes required — the existing state payload (`setupComplete`, `mappedCount`, `mappingsReady`, `realTimeSyncEnabled`, `autoPullEnabled`, `deleteSyncEnabled`, `automationRules`) is sufficient.

### Complex / Risky
- Must not regress the case where a user HAS enabled sync/automation — reopening setup should still restore their real state. The fix only removes false-positive signals (section visibility), not genuine child-state signals.
- Automation rules edge case: a user with saved automation rules but no realtime/delete/autopull checkboxes checked would have had `aOpen = true` via `automationEditorVisible`. After removing that term, `aOpen` would be `false` unless we add an explicit automation-rules-presence check. This must be handled to avoid hiding the user's automation rules behind a collapsed master.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `syncSectionDisclosure()` is called synchronously AFTER `renderClickupOptionSummary` / `renderClickupMappings` / `renderClickupAutomation` in `renderClickupSetupState()` ([setup.html:2835-2846](src/webview/setup.html#L2835-L2846)) and `renderLinearSetupState()` ([setup.html:2952-2962](src/webview/setup.html#L2952-L2962)). The DOM state is fully settled before derivation runs.
- **Security:** None.
- **Side Effects:** The master checkboxes are display-only disclosure toggles; they are not persisted directly (the SAVE buttons persist child options). Changing their default render does not change what gets saved. The `change` event listeners on the masters ([setup.html:3266-3277](src/webview/setup.html#L3266-L3277)) only toggle body visibility — no save side-effect.
- **Dependencies & Conflicts:** Depends on the backend `state` object shape returned for ClickUp/Linear setup status. Confirmed: `setupComplete`, `mappedCount` (ClickUp), `mappingsReady` (Linear), `realTimeSyncEnabled`, `autoPullEnabled`, `deleteSyncEnabled`, and `automationRules` are all present in the state payload from `getIntegrationSetupStates()` in [TaskViewerProvider.ts:3956-4118](src/services/TaskViewerProvider.ts#L3956-L4118). No backend change needed.
- **Out of scope (noting for awareness):** The `linear-option-exclude-backlog` checkbox has `checked` hardcoded in the HTML ([setup.html:940](src/webview/setup.html#L940)) and defaults ON via `state.excludeBacklog !== false` ([setup.html:2511](src/webview/setup.html#L2511)). Similarly, `linear-option-enable-complete-sync` defaults ON via `state.completeSyncEnabled !== false` ([setup.html:2509](src/webview/setup.html#L2509)). These are child-level defaults, not master-toggle issues, and are not part of the `kOpen`/`aOpen` OR expressions. They are left as-is by this plan. If the user wants those unchecked by default on fresh integrations, that would be a separate plan.

## Dependencies

- None — this is a self-contained frontend-only fix.

## Adversarial Synthesis

Key risks: (1) removing `automationEditorVisible` from `aOpen` without adding an automation-rules-presence check would hide saved automation rules behind a collapsed master — a data-visibility regression. (2) The `mappingsEditorVisible` term was likely added intentionally to keep the kanban master open when the mappings editor has content; removing it means a user with `setupComplete=true` but no folder/lists/fields checked would see a collapsed kanban body even though the mappings editor (inside the body) is rendered. Mitigations: add `hasAutomationRules` DOM check to `aOpen`; the kanban case is acceptable because if no child options are checked, the user has no kanban configuration to review.

## Proposed Changes

### 1. `src/webview/setup.html` — remove section-visibility terms from `kOpen`/`aOpen` OR expressions

In `syncSectionDisclosure(provider)` ([setup.html:2783](src/webview/setup.html#L2783)), remove the `mappingsEditorVisible` and `automationEditorVisible` terms from the OR expressions. These terms are false positives: they evaluate to `true` whenever `setupComplete === true` (because the render functions un-hide the editor sections based on `setupComplete`), which forces the masters checked regardless of actual child option state.

Add an automation-rules-presence check to each `aOpen` expression so users with saved automation rules (but no realtime/delete/autopull enabled) still see the automation master checked.

**ClickUp branch** ([setup.html:2791-2807](src/webview/setup.html#L2791-L2807)):

```js
function syncSectionDisclosure(provider) {
    if (provider === 'clickup') {
        const kMaster = document.getElementById('clickup-disclosure-kanban');
        const kBody = document.getElementById('clickup-kanban-body');
        const aMaster = document.getElementById('clickup-disclosure-automation');
        const aBody = document.getElementById('clickup-automation-body');
        if (!kMaster || !kBody || !aMaster || !aBody) return;

        // REMOVED: mappingsEditorVisible — it is true whenever setupComplete=true,
        // which falsely forces the kanban master checked even with no kanban options enabled.
        const createFolder = document.getElementById('clickup-option-create-folder')?.checked;
        const createLists = document.getElementById('clickup-option-create-lists')?.checked;
        const createFields = document.getElementById('clickup-option-create-custom-fields')?.checked;
        const kOpen = !!(createFolder || createLists || createFields);

        kMaster.checked = kOpen;
        kBody.classList.toggle('hidden', !kOpen);

        // REMOVED: automationEditorVisible — same false-positive issue.
        const realtimeSync = document.getElementById('clickup-option-enable-realtime-sync')?.checked;
        const deleteSync = document.getElementById('clickup-option-delete-sync')?.checked;
        const autoPull = document.getElementById('clickup-option-enable-auto-pull')?.checked;
        // ADDED: automation-rules presence so saved rules keep the master open.
        const hasAutomationRules = document.querySelectorAll('[data-clickup-rule-card="true"]').length > 0;
        const aOpen = !!(realtimeSync || deleteSync || autoPull || hasAutomationRules);

        aMaster.checked = aOpen;
        aBody.classList.toggle('hidden', !aOpen);
    } else if (provider === 'linear') {
        const kMaster = document.getElementById('linear-disclosure-kanban');
        const kBody = document.getElementById('linear-kanban-body');
        const aMaster = document.getElementById('linear-disclosure-automation');
        const aBody = document.getElementById('linear-automation-body');
        if (!kMaster || !kBody || !aMaster || !aBody) return;

        // Linear kanban already has no section-visibility term — unchanged.
        const mapColumns = document.getElementById('linear-option-map-columns')?.checked;
        const createLabel = document.getElementById('linear-option-create-label')?.checked;
        const includeProj = document.getElementById('linear-option-include-projects')?.value?.trim();
        const excludeProj = document.getElementById('linear-option-exclude-projects')?.value?.trim();
        const kOpen = !!(mapColumns || createLabel || includeProj || excludeProj);

        kMaster.checked = kOpen;
        kBody.classList.toggle('hidden', !kOpen);

        // REMOVED: automationEditorVisible — same false-positive issue as ClickUp.
        const realtimeSync = document.getElementById('linear-option-enable-realtime-sync')?.checked;
        const deleteSync = document.getElementById('linear-option-delete-sync')?.checked;
        const autoPull = document.getElementById('linear-option-enable-auto-pull')?.checked;
        // ADDED: automation-rules presence so saved rules keep the master open.
        const hasAutomationRules = document.querySelectorAll('[data-linear-rule-card="true"]').length > 0;
        const aOpen = !!(realtimeSync || deleteSync || autoPull || hasAutomationRules);

        aMaster.checked = aOpen;
        aBody.classList.toggle('hidden', !aOpen);
    }
}
```

**Why this works:**
- On a truly fresh integration (`state` undefined → `renderOptionSummary` returns early → child checkboxes retain HTML defaults = unchecked): `kOpen = false`, `aOpen = false` → masters unchecked, bodies collapsed. (This already worked, and still works.)
- On `setupComplete = true` but no kanban options / automation features enabled: Previously `mappingsEditorVisible` / `automationEditorVisible` forced `kOpen` / `aOpen` to `true`. Now they derive purely from child state → `kOpen = false`, `aOpen = false` → masters unchecked, bodies collapsed. **This is the fix.**
- On `setupComplete = true` with folder/lists/fields configured: `createFolder` / `createLists` / `createFields` checked → `kOpen = true` → master checked, body expanded. Correct.
- On `setupComplete = true` with realtime sync enabled: `realtimeSync` checked → `aOpen = true` → master checked, body expanded. Correct.
- On `setupComplete = true` with saved automation rules but no realtime/delete/autopull: `hasAutomationRules = true` → `aOpen = true` → master checked, body expanded. Correct (no regression).

### 2. No backend change required

The plan's original section 2 proposed adding `kanbanConfigured` / `automationConfigured` booleans to the backend state payload. **This is not needed.** The existing state fields (`setupComplete`, `mappedCount`, `mappingsReady`, `realTimeSyncEnabled`, `autoPullEnabled`, `deleteSyncEnabled`, `automationRules`) are sufficient. The fix is entirely frontend-side in `syncSectionDisclosure()`. The backend state shape in `getIntegrationSetupStates()` ([TaskViewerProvider.ts:3956-4118](src/services/TaskViewerProvider.ts#L3956-L4118)) and the type definitions (`ClickUpSetupState` / `LinearSetupState` at [TaskViewerProvider.ts:173-208](src/services/TaskViewerProvider.ts#L173-L208)) remain unchanged.

## Verification Plan

### Automated Tests

> **SKIP COMPILATION:** Do NOT run `npm run compile` or any project compilation step. The project is assumed to be in a pre-compiled or compilation-free state for this session.
>
> **SKIP TESTS:** Do NOT run automated tests (unit, integration, or e2e). The test suite will be run separately by the user.

**Recommended test to add (for the user to run later):**

Add/adjust a source-level regression test mirroring `src/test/setup-panel-refresh-regression.test.js` that reads `src/webview/setup.html` and asserts:
1. The `kOpen` expression for ClickUp does NOT contain `mappingsEditorVisible`.
2. The `aOpen` expression for ClickUp does NOT contain `automationEditorVisible`.
3. The `aOpen` expression for Linear does NOT contain `automationEditorVisible`.
4. Both `aOpen` expressions include an automation-rules-presence check (`data-clickup-rule-card` / `data-linear-rule-card`).

Example assertion pattern (regex against the source file):
```js
assert.doesNotMatch(setupSource, /const kOpen = !!\(mappingsEditorVisible/, 'ClickUp kOpen must not include mappingsEditorVisible');
assert.doesNotMatch(setupSource, /const aOpen = !!\(automationEditorVisible/, 'aOpen must not include automationEditorVisible');
assert.match(setupSource, /data-clickup-rule-card="true"\\]\\)\.length > 0/, 'ClickUp aOpen must check automation-rules presence');
assert.match(setupSource, /data-linear-rule-card="true"\\]\)\.length > 0/, 'Linear aOpen must check automation-rules presence');
```

### Manual Verification

1. Open Setup → Integrations with a fresh (unconfigured) ClickUp and a fresh Linear integration. Confirm **Enable Kanban sync** and **Enable automation** are unchecked and their bodies are collapsed for both providers.
2. Complete the ClickUp setup wizard (enter token, create folder/lists/fields) but do NOT enable realtime sync, delete sync, or auto-pull. Close Setup, reopen → confirm **Enable Kanban sync** is checked (folder/lists/fields are configured) but **Enable automation** is unchecked and collapsed. (Previously: both were checked.)
3. Complete the Linear setup wizard (enter token, map columns) but do NOT enable realtime sync, delete sync, or auto-pull. Close Setup, reopen → confirm **Enable Kanban sync** is checked (mappings ready) but **Enable automation** is unchecked and collapsed. (Previously: both were checked.)
4. Enable realtime sync on ClickUp, SAVE, close Setup, reopen → confirm **Enable automation** master is now checked and body expanded with realtime sync checked.
5. Add an automation rule on Linear (no realtime/delete/autopull enabled), SAVE, reopen → confirm **Enable automation** master is checked (automation rules present) and body expanded showing the rule.
6. Disable everything (uncheck all kanban options, all automation features, remove all automation rules), SAVE, reopen → confirm both masters render unchecked and collapsed.

---

**Recommendation:** Complexity 3 → **Send to Intern**. Single-file, four-line change with one added DOM-query check. No backend changes, no architectural patterns, no data consistency risks.
