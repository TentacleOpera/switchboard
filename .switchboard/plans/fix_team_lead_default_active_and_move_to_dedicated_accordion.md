# Fix: Team Lead Should Not Be Active by Default and Should Be Moved to Dedicated Accordion

## Goal
1. Change team lead default state from active to inactive
2. Move team lead selection from the main agent visibility section to a dedicated accordion called "Orchestration Framework Integration" in the setup view, as it is more niche and complicated than other agent terminals
3. Clarification: keep existing Team Lead dispatch wiring intact; only the default state and configuration surface should change.

## Metadata
**Tags:** frontend, backend, ui, bugfix
**Complexity:** 5

## User Review Required
> [!NOTE]
> No migration or manual cleanup is required. Existing `team-lead` values in `state.visibleAgents` and `state.startupCommands` remain valid; this change only changes the defaults and relocates the editing UI.

## Complexity Audit
### Routine
- Flip the Team Lead default to `false` in the shared visibility defaults in `src/services/TaskViewerProvider.ts` and `src/services/KanbanProvider.ts`.
- Update the initial webview bootstrap maps in `src/webview/setup.html`, `src/webview/kanban.html`, and `src/webview/implementation.html` so the DOM and provider state start from the same inactive default.
- Remove the hardcoded `checked` attributes from the Team Lead rows in `src/webview/implementation.html`.
- Add the new Team Lead accordion markup and local state in `src/webview/setup.html`.

### Complex / Risky
- Move the Team Lead editing controls without breaking the existing `startupCommands` / `visibleAgents` save-and-hydrate flow.
- Keep the sidebar dispatch row in `src/webview/implementation.html` intact; the new accordion is a configuration move, not a removal of Team Lead dispatch support.
- Avoid introducing a separate Team Lead persistence schema when the current setup panel already saves through shared state objects.

## Edge-Case & Dependency Audit
- **Race Conditions:** `visibleAgents` and `startupCommands` hydrate asynchronously. The new accordion must initialize from the latest message payloads and not assume the DOM has Team Lead state before `ready` / accordion-open callbacks finish.
- **Security:** No new privilege boundary or credential flow is introduced. This is a UI/default-state change only.
- **Side Effects:** Team Lead will no longer be preselected in onboarding or terminal-operations configuration, but it should still appear in the sidebar dispatch list when enabled.
- **Dependencies & Conflicts:** No blocking New/Planned dependency was found in the kanban scan. Relevant overlap exists with `Cleanup: Remove Central Setup Panel Header` (`sess_1775874942070`, Planned) in `src/webview/setup.html`, plus reviewed overlap with `Add Git Ignore Strategy UI to Setup Menu`, `Fix Team Lead UI Visibility`, and `Make Team Lead Column Visibility Consistent with Other Agents`. Treat those as same-file merge hotspots, especially around `src/webview/setup.html` and `src/webview/implementation.html`.

## Grumpy Critique
> Oh, splendid. The old draft tried to solve a multi-surface state problem by flipping one default and hoping the DOM would stop lying. It would not.
>
> If `TaskViewerProvider.ts` and `KanbanProvider.ts` still say Team Lead is visible, the webviews will happily resurrect it on load no matter what the accordion says. If `implementation.html` keeps the `checked` attributes, first paint will still advertise Team Lead as active even when the saved state says otherwise. That is not a fix; that is a contradiction with better formatting.
>
> And do not, under any circumstances, "remove Team Lead from standard agent lists" if that means deleting the sidebar dispatch row. The requested change is a relocation of the configuration UI, not an exorcism of Team Lead from the product.

## Balanced Synthesis
> The safe path is to treat Team Lead visibility as one chain: provider defaults, webview bootstrap state, and saved-state hydration must all agree. Flip the defaults everywhere, move only the configuration controls into the new accordion, and leave the sidebar dispatch path alone.
>
> That keeps the change narrow, preserves existing saved state, and avoids inventing a new persistence path when the setup panel already has a shared save flow.

## Background
The team lead agent is currently set as active by default across multiple files, and its configuration is mixed in with the standard agent terminal settings. Since team lead is a more specialized orchestration framework integration (unlike standard CLI agents like planner, coder, etc.), it should:
- Be inactive by default (opt-in rather than opt-out)
- Have its own dedicated configuration section in the setup panel to avoid cluttering the main agent visibility controls
- Continue to appear in dispatch/sidebar surfaces when enabled; this plan is only about where the user configures it.

## Root Cause Analysis

### Issue 1: Team Lead Active by Default
Team lead is hardcoded as active (`true`) in multiple default state objects and bootstrap maps:

**Files affected:**
1. `src/services/TaskViewerProvider.ts`:
   ```typescript
   const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': true, jules: true };
   ```

2. `src/services/KanbanProvider.ts`:
   ```typescript
   const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': true, jules: true };
   ```

3. `src/webview/setup.html` (line 639):
    ```javascript
    let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, tester: false, analyst: true, 'team-lead': true, jules: true };
    ```

4. `src/webview/kanban.html` (line 1320):
    ```javascript
    let lastVisibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': true, jules: true };
    ```

5. `src/webview/implementation.html` (line 1796):
    ```javascript
    let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, tester: false, analyst: true, 'team-lead': true, jules: true };
    ```

6. `src/webview/implementation.html` (line 3894):
    ```javascript
    const visibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': true, jules: true };
    ```

### Issue 2: Hardcoded Checked Attribute
The HTML checkboxes have `checked` hardcoded:

**Files affected:**
1. `src/webview/implementation.html` (line 1257) - Onboarding panel:
   ```html
   <input type="checkbox" class="onboard-agent-toggle" data-role="team-lead" checked
   ```

2. `src/webview/implementation.html` (line 1408) - Terminal operations panel:
   ```html
   <input type="checkbox" class="agent-visible-toggle" data-role="team-lead" checked
   ```

### Issue 3: Team Lead Mixed with Standard Agents
Team lead configuration is currently mixed in with standard agent CLI commands in:
- Onboarding panel (`implementation.html` lines 1256-1261)
- Terminal operations panel (`implementation.html` lines 1407-1412)

These should be moved to a dedicated accordion in `setup.html`.
Clarification: leave the sidebar `renderAgentList()` entry and the existing `startupCommands` / `visibleAgents` plumbing intact so Team Lead still dispatches normally once enabled.

## Proposed Changes

### Part 1: Change Default State to Inactive

**File:** `src/webview/setup.html`
**Line:** 639
**Change:** `'team-lead': true` → `'team-lead': false`

```javascript
let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, tester: false, analyst: true, 'team-lead': false, jules: true };
```

**File:** `src/webview/kanban.html`
**Line:** 1320
**Change:** `'team-lead': true` → `'team-lead': false`

```javascript
let lastVisibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true };
```

**File:** `src/webview/implementation.html`
**Line:** 1796
**Change:** `'team-lead': true` → `'team-lead': false`

```javascript
let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, tester: false, analyst: true, 'team-lead': false, jules: true };
```

**File:** `src/webview/implementation.html`
**Line:** 3894
**Change:** `'team-lead': true` → `'team-lead': false`

```javascript
const visibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true };
```

### Part 2: Remove Hardcoded Checked Attributes

**File:** `src/webview/implementation.html`
**Line:** 1257
**Change:** Remove `checked` attribute

```html
<input type="checkbox" class="onboard-agent-toggle" data-role="team-lead"
```

**File:** `src/webview/implementation.html`
**Line:** 1408
**Change:** Remove `checked` attribute

```html
<input type="checkbox" class="agent-visible-toggle" data-role="team-lead"
```

### Part 3: Add Dedicated Accordion in Setup View

**File:** `src/webview/setup.html`  
**Location:** Insert a new `startup-section` between the existing `Custom Agents` block and `Default Prompt Overrides` block.
**Clarification:** This accordion is only a new editing surface for the existing `team-lead` entries already stored in `startupCommands` and `visibleAgents`.

Add markup shaped like the existing setup accordions, but limit it to the Team Lead toggle and command field:

```html
<div class="startup-section">
    <div class="startup-toggle" id="orchestration-toggle">
        <div class="section-label">Orchestration Framework Integration</div>
        <span class="chevron" id="orchestration-chevron">▶</span>
    </div>
    <div class="startup-fields" id="orchestration-fields" data-accordion="true">
        <div style="font-size: 10px; color: var(--text-secondary); margin: 10px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
            TEAM LEAD (OPENCODE)
        </div>
        <div style="font-size: 10px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4;">
            Team Lead is an orchestration-oriented role and should be configured here instead of in the standard agent list.
        </div>
        <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
            <input id="team-lead-visible-toggle" type="checkbox" style="width:auto; margin:0;">
            <span>Enable Team Lead agent</span>
        </label>
        <label class="startup-row" style="display:block; margin-top:6px;">
            <span style="display:block; margin-bottom:4px;">Team Lead startup command</span>
            <input id="team-lead-command-input" type="text" placeholder="e.g. opencode" style="width:100%;">
        </label>
    </div>
</div>
```

### Part 4: Extend the Existing Setup Save/Hydrate Wiring

**File:** `src/webview/setup.html`  
**Location:** Reuse the current `saveStartupCommands`, `getStartupCommands`, and `getVisibleAgents` logic; do not add new message types.

Update the accordion binding so opening the new section refreshes the existing shared Team Lead state:

```javascript
bindAccordion('orchestration-toggle', 'orchestration-fields', 'orchestration-chevron', () => {
    vscode.postMessage({ type: 'getStartupCommands' });
    vscode.postMessage({ type: 'getVisibleAgents' });
});
```

Add DOM references near the existing setup-panel element lookups:

```javascript
const teamLeadVisibleToggle = document.getElementById('team-lead-visible-toggle');
const teamLeadCommandInput = document.getElementById('team-lead-command-input');
```

Extend the existing `btn-save-startup` handler so it persists Team Lead through the same payload instead of only sending custom-agent visibility:

```javascript
const commands = {
    ...lastStartupCommands,
    'team-lead': teamLeadCommandInput?.value.trim() || ''
};

const visibleAgents = {
    ...getCustomVisibleAgentsPatch(),
    'team-lead': !!teamLeadVisibleToggle?.checked
};

vscode.postMessage({
    type: 'saveStartupCommands',
    accurateCodingEnabled,
    advancedReviewerEnabled,
    leadChallengeEnabled,
    aggressivePairProgramming,
    designDocEnabled,
    designDocLink: lastDesignDocLink,
    planIngestionFolder,
    customAgents: lastCustomAgents,
    commands,
    visibleAgents
});
```

Update the existing message handlers so the new controls hydrate from shared state:

```javascript
case 'startupCommands': {
    lastStartupCommands = message.commands || {};
    if (teamLeadCommandInput) {
        teamLeadCommandInput.value = lastStartupCommands['team-lead'] || '';
    }
    break;
}

case 'visibleAgents':
    if (message.agents) {
        lastVisibleAgents = { ...lastVisibleAgents, ...message.agents };
        if (teamLeadVisibleToggle) {
            teamLeadVisibleToggle.checked = lastVisibleAgents['team-lead'] !== false;
        }
        renderCustomAgentConfigList();
    }
    break;
```

### Part 5: Align Shared Defaults and Keep the Existing Provider Relay

**Files:** `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/setup.html`, `src/webview/kanban.html`, `src/webview/implementation.html`

Apply the default-state fix everywhere Team Lead is still seeded as active:

1. Change `getVisibleAgents()` in `src/services/TaskViewerProvider.ts` so `'team-lead': false`.
2. Change `_getVisibleAgents()` in `src/services/KanbanProvider.ts` so `'team-lead': false`.
3. Change `lastVisibleAgents` in `src/webview/setup.html`, `src/webview/kanban.html`, and `src/webview/implementation.html` so first paint matches the providers.
4. Change the onboarding `const visibleAgents = { ... }` seed in `src/webview/implementation.html` so Team Lead is no longer forced to `true`.

**Clarification:** `src/services/SetupPanelProvider.ts` already relays `saveStartupCommands`, `getStartupCommands`, and `getVisibleAgents`. No `getTeamLeadConfig` / `saveTeamLeadConfig` API should be introduced.

### Part 6: Remove Team Lead from Standard Agent Lists Without Losing Hidden State

**File:** `src/webview/implementation.html`

Remove only the Team Lead configuration rows from:
- onboarding panel (`onboard-agent-toggle` row at lines 1256-1261)
- terminal operations (`agent-visible-toggle` row at lines 1407-1412)

Keep the sidebar dispatch rendering intact:

```javascript
if (va['team-lead'] !== false) {
    agentListStandard.appendChild(createAgentRow('TEAM LEAD', 'team-lead', ...));
}
```

Then fix the existing save/hydrate code so deleting the visible rows does not wipe `team-lead` out of state:

```javascript
// startupCommands message handler: remove the deleted onboarding field lookup.
const onboardingFields = {
    lead: document.getElementById('onboard-cli-lead'),
    coder: document.getElementById('onboard-cli-coder'),
    intern: document.getElementById('onboard-cli-intern'),
    reviewer: document.getElementById('onboard-cli-reviewer'),
    tester: document.getElementById('onboard-cli-tester'),
    planner: document.getElementById('onboard-cli-planner'),
    analyst: document.getElementById('onboard-cli-analyst')
};

// Terminal-operations save path: preserve Team Lead before collecting visible DOM rows.
const commands = { ...lastStartupCommands, 'team-lead': lastStartupCommands['team-lead'] || '' };
const visibleAgents = { 'team-lead': lastVisibleAgents['team-lead'] !== false };

// Onboarding save path: preserve Team Lead instead of reading a removed input.
const agents = {
    ...lastStartupCommands,
    lead: document.getElementById('onboard-cli-lead').value,
    coder: document.getElementById('onboard-cli-coder').value,
    intern: document.getElementById('onboard-cli-intern').value,
    reviewer: document.getElementById('onboard-cli-reviewer').value,
    tester: document.getElementById('onboard-cli-tester').value,
    planner: document.getElementById('onboard-cli-planner').value,
    analyst: document.getElementById('onboard-cli-analyst').value,
    'team-lead': lastStartupCommands['team-lead'] || ''
};
const visibleAgents = {
    lead: true,
    coder: true,
    intern: true,
    reviewer: true,
    tester: false,
    planner: true,
    analyst: true,
    'team-lead': lastVisibleAgents['team-lead'] !== false,
    jules: true
};
```

## Clarified Implementation Steps (Final)

### Low Complexity
1. Flip every Team Lead default from `true` to `false` in `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/setup.html`, `src/webview/kanban.html`, and the two bootstrap maps in `src/webview/implementation.html`.
2. Remove the hardcoded `checked` attributes from the Team Lead onboarding and terminal-operations checkboxes in `src/webview/implementation.html`.
3. Insert the new `Orchestration Framework Integration` accordion in `src/webview/setup.html`.

### High Complexity / Risky
1. Extend the existing setup-panel save payload so Team Lead is now saved through `commands['team-lead']` and `visibleAgents['team-lead']` instead of being omitted from `src/webview/setup.html`.
2. Remove the old Team Lead configuration rows from `src/webview/implementation.html` without letting `saveStartupCommands` erase the hidden Team Lead command or visibility state.
3. Keep hydration paths aligned by updating existing `startupCommands` and `visibleAgents` handlers rather than inventing a second Team Lead config channel.

## Implementation Order

1. **First:** Change default states to inactive (Part 1) - ensures immediate fix for the default behavior
2. **Second:** Remove hardcoded checked attributes (Part 2) - ensures UI consistency
3. **Third:** Add dedicated accordion in setup.html (Part 3) - creates the new UI location
4. **Fourth:** Add JavaScript handlers (Part 4) - makes the new accordion functional
5. **Fifth:** Update backend relay / state handling (Part 5) - keeps Team Lead in the existing state model while exposing the new accordion
6. **Sixth:** Remove Team Lead from the old configuration rows only (Part 6) - leaves the sidebar dispatch row untouched

## Verification Plan

1. Open setup panel and verify "Orchestration Framework Integration" accordion exists
2. Verify team lead checkbox is unchecked by default
3. Enable team lead in the new accordion and save
4. Open terminal operations panel and verify Team Lead does NOT appear in the onboarding or terminal-operations configuration rows
5. Verify team lead agent appears in the sidebar when enabled
6. Test onboarding flow to ensure team lead is not shown in standard agent setup
7. Restart VS Code and verify team lead state persists correctly

## Related Files
- `src/webview/setup.html` - Main setup panel, needs new accordion
- `src/services/TaskViewerProvider.ts` - Shared visibility state defaults and Team Lead config handlers
- `src/webview/kanban.html` - Default state needs update
- `src/webview/implementation.html` - Default states and HTML need updates, Team Lead rows need removal from the two config blocks only
- `src/services/KanbanProvider.ts` - Kanban visible-agent defaults
- `src/services/SetupPanelProvider.ts` - Backend relay for setup-panel messages

## Agent Recommendation
Send to Coder

## Reviewer Execution Update

### Stage 1 (Grumpy Principal Engineer)
> **NIT** Against all odds, this one does not merely rearrange the furniture while the wiring burns. The defaults are flipped in both providers and all bootstrap maps, the old standard-agent configuration rows are gone, and the sidebar dispatch row survived the surgery. The only lingering odor is that the regression coverage is still source-pattern heavy rather than a true interaction round-trip, so a future refactor could technically satisfy the regex while upsetting the live webview.

### Stage 2 (Balanced)
Keep the implementation. No CRITICAL or MAJOR defect was found, so no production code change was required in this reviewer pass. The main persistence risk is already handled because `handleSaveStartupCommands()` merges `visibleAgents` patches instead of replacing the map, and the dedicated regression test covers the new defaults, relocated setup controls, and preserved dispatch path.

### Fixed Items
- No reviewer-applied production code fixes were needed.

### Files Changed
- Observed implementation files:
  - `src/services/TaskViewerProvider.ts`
  - `src/services/KanbanProvider.ts`
  - `src/webview/setup.html`
  - `src/webview/kanban.html`
  - `src/webview/implementation.html`
  - `src/test/team-lead-visibility-defaults-regression.test.js`
- Reviewer update: `.switchboard/plans/fix_team_lead_default_active_and_move_to_dedicated_accordion.md`

### Validation Results
- `node src/test/team-lead-visibility-defaults-regression.test.js` → passed
- `node src/test/setup-panel-migration.test.js` → passed
- `npm run compile` → passed
- `npx tsc --noEmit` → pre-existing TS2835 at `src/services/KanbanProvider.ts:2197` for `await import('./ArchiveManager')`

### Remaining Risks
- `src/webview/setup.html` and `src/webview/implementation.html` are active merge hotspots for adjacent Team Lead and setup-panel work.
- Regression coverage is source-level rather than a browser interaction test, so future UI rewrites should keep an eye on hydration behavior.
