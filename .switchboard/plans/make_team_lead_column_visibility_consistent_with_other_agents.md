# Make Team Lead Column Visibility Consistent with Other Agents

## Goal
Make the `TEAM LEAD CODED` Kanban column follow the same hidden-by-default behavior as the current optional-role visibility model, while preserving the existing exception that occupied columns stay visible. This should fix the Team Lead column appearing by default when no Team Lead visibility preference has been intentionally enabled.

## Metadata
**Tags:** frontend, backend, UI, bugfix
**Complexity:** 5

## User Review Required
> [!NOTE]
> This fix should correct **default visibility**, not introduce a new startup-command-based visibility model. Existing workspaces that already persisted `visibleAgents['team-lead'] = true` will remain visible until the user changes that preference; this plan does **not** add a migration that rewrites saved user state.
>
> Because the Kanban column and the sidebar agent row are driven by the same `visibleAgents` flag, Team Lead will also become unchecked / hidden by default in the sidebar and onboarding UI. That is a direct consequence of the shared visibility model, not a separate product change.

## Complexity Audit
### Routine
- Change the Team Lead default from `true` to `false` in the shared visibility providers: `src/services/KanbanProvider.ts` and `src/services/TaskViewerProvider.ts`.
- Update the initial client-side visibility defaults in `src/webview/kanban.html` and `src/webview/implementation.html`.
- Remove the `checked` attribute from Team Lead onboarding and terminal-operations checkboxes in `src/webview/implementation.html`.
- Update the onboarding save payload in `src/webview/implementation.html` so Team Lead is not reintroduced as visible by default when onboarding is completed.
- Add a focused regression test that locks down the Team Lead default-hidden behavior and preserves the occupied-column exception.

### Complex / Risky
- **Shared-state chain (Clarification):** the bug is not isolated to `KanbanProvider._getVisibleAgents()`. The same default lives in `TaskViewerProvider.ts`, `implementation.html`, and `kanban.html`; fixing only one layer creates mismatched UI where the board, sidebar, and saved preferences disagree.
- **Do not broaden the filtering contract:** the current `_filterDynamicColumns()` logic already preserves hidden columns when cards occupy them. Adding startup-command or "assigned terminal" checks there would change semantics for other roles and exceeds the stated scope.
- **Persisted legacy state remains authoritative:** changing defaults alone will not rewrite already-saved `visibleAgents['team-lead'] = true` entries. The plan must state this explicitly so the implementation does not overpromise a migration that was never requested.

## Edge-Case & Dependency Audit
- **Race Conditions:** `visibleAgents` is loaded asynchronously into both the sidebar and Kanban webviews. To avoid a transient "checked then unchecked" mismatch on first render, the DOM-level Team Lead checkboxes and the client-side `lastVisibleAgents` objects must both be updated alongside the provider defaults.
- **Security:** No credential, path, or IPC surface changes are required. This is a local visibility/state-consistency fix only.
- **Side Effects:** Team Lead will no longer count as visible by default in onboarding guard logic, sidebar rendering, or Kanban filtering. The occupied-column safeguard in `KanbanProvider._filterDynamicColumns()` must remain unchanged so existing `TEAM LEAD CODED` cards still surface even when Team Lead is hidden.
- **Dependencies & Conflicts:** `get_kanban_state` currently shows this as the only active plan in `PLAN REVIEWED`, so there are no blocking New/Planned plan dependencies. The plans folder does contain nearby, non-active overlap in `fix_team_lead_ui_visibility.md`, plus recently coded work in `src/webview/implementation.html`, `src/webview/kanban.html`, and `src/services/TaskViewerProvider.ts`; treat those as merge hotspots, but not active Kanban blockers under the planning rules.

## Adversarial Synthesis
### Grumpy Critique
> This draft is the classic "one-line fix" fantasy: charming, tidy, and wrong.
>
> 1. **You blamed the wrong layer.** `KanbanProvider._getVisibleAgents()` is only one stop in the visibility pipeline. `TaskViewerProvider.ts` also defaults Team Lead to `true`, `implementation.html` pre-checks Team Lead in two places, `implementation.html` saves Team Lead as visible during onboarding, and `kanban.html` boots with Team Lead visible locally. Change one flag and the UI still argues with itself.
>
> 2. **You pointed at `_filterDynamicColumns()` like it committed the crime.** It did not. That function already does the right thing for this scope: if the role is hidden but cards already exist in the column, the column stays visible. If you start stuffing startup-command checks into it, congratulations, you just invented a new visibility policy for every optional role in the app.
>
> 3. **You quietly ignored persisted state.** Existing workspaces may already have `visibleAgents['team-lead'] = true` stored on disk because the onboarding UI shipped pre-checked. A defaults-only fix does not magically cleanse history. If your plan promises that all existing workspaces will "just work," it is lying through its teeth.

### Balanced Response
Grumpy is right that the bug is a shared-default inconsistency, not a single-provider defect. The corrected plan below keeps the scope tight and accurate:
1. Update the **entire default chain** that controls first-render visibility: both providers plus both relevant webviews.
2. Leave `_filterDynamicColumns()` **unchanged** so occupied Team Lead columns still render exactly as they do today.
3. Call out persisted `visibleAgents['team-lead']` entries as an explicit non-goal of this bugfix, avoiding accidental migration work that the request did not authorize.
4. Add one focused regression test so future UI refactors do not silently reintroduce Team Lead as checked/visible by default.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** The implementation below is intentionally scoped to the files that currently participate in Team Lead default visibility. Do not add startup-command-based filtering or saved-state migration unless the product requirement is expanded separately.

### 0. Scope Guard (Clarification)
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The current draft identifies `_filterDynamicColumns()` as part of the root cause, but live code inspection shows that function already preserves the desired occupied-column fallback.
- **Logic:**
  1. Keep `_filterDynamicColumns()` behavior unchanged.
  2. Fix the default source feeding it (`_getVisibleAgents()`), not the filter itself.
  3. Preserve `hideWhenNoAgent: true` on `TEAM LEAD CODED` in `src/services/agentConfig.ts`; that flag is already correct.
- **Implementation:**
```typescript
/** Remove columns flagged hideWhenNoAgent when their role has no visible agent AND no cards occupy the column. */
private _filterDynamicColumns(
    columns: KanbanColumnDefinition[],
    visibleAgents: Record<string, boolean>,
    cards: KanbanCard[]
): KanbanColumnDefinition[] {
    const occupiedColumns = new Set(cards.map(c => c.column));
    return columns.filter(col => {
        if (!col.hideWhenNoAgent) return true;
        if (col.role && visibleAgents[col.role] !== false) return true;
        if (occupiedColumns.has(col.id)) return true;
        return false;
    });
}
```
- **Edge Cases Handled:** Retains the current "show occupied hidden columns" behavior so existing Team Lead cards are still visible after the default is flipped.

### 1. Kanban Visibility Defaults
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The Kanban board ultimately filters dynamic columns using the provider-level `visibleAgents` state returned here.
- **Logic:**
  1. Change the Team Lead default from `true` to `false`.
  2. Leave all other role defaults unchanged.
  3. Keep the merge with `state.visibleAgents` intact so explicit saved user choices still override defaults.
- **Implementation:**
```typescript
private async _getVisibleAgents(workspaceRoot: string): Promise<Record<string, boolean>> {
    const defaults: Record<string, boolean> = {
        lead: true,
        coder: true,
        intern: true,
        reviewer: true,
        tester: false,
        planner: true,
        analyst: true,
        'team-lead': false,
        jules: true
    };
    const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
    try {
        if (fs.existsSync(statePath)) {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            const customAgents = parseCustomAgents(state.customAgents);
            for (const agent of customAgents) {
                defaults[agent.role] = true;
            }
            return { ...defaults, ...state.visibleAgents };
        }
    } catch (e) {
        console.error('[KanbanProvider] Failed to read visible agents from state:', e);
    }
    return defaults;
}
```
- **Edge Cases Handled:** New/unconfigured workspaces stop surfacing `TEAM LEAD CODED` by default, while explicit saved choices and occupied Team Lead columns continue to render.

### 2. Shared Visibility Source for Sidebar and Setup
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** The sidebar, setup panel, and extension-level terminal-opening flow all query `TaskViewerProvider.getVisibleAgents()`. If this file stays `true`, Team Lead remains visible in non-Kanban surfaces even after the board is fixed.
- **Logic:**
  1. Change the Team Lead default from `true` to `false`.
  2. Keep the custom-agent merge intact.
  3. Do not change `handleSaveStartupCommands()` merge behavior; persisted values should still override defaults.
- **Implementation:**
```typescript
public async getVisibleAgents(workspaceRoot?: string): Promise<Record<string, boolean>> {
    const defaults: Record<string, boolean> = {
        lead: true,
        coder: true,
        intern: true,
        reviewer: true,
        tester: false,
        planner: true,
        analyst: true,
        'team-lead': false,
        jules: true
    };
    const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedRoot) return defaults;
    const statePath = path.join(resolvedRoot, '.switchboard', 'state.json');
    try {
        const content = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(content);
        for (const agent of parseCustomAgents(state.customAgents)) {
            defaults[agent.role] = true;
        }
        return { ...defaults, ...state.visibleAgents };
    } catch {
        return defaults;
    }
}
```
- **Edge Cases Handled:** Prevents the sidebar and setup panel from booting with Team Lead visible while the Kanban board treats it as hidden.

### 3. Sidebar / Onboarding Defaults
#### [MODIFY] `src/webview/implementation.html`
- **Context:** This webview hardcodes Team Lead as pre-checked in onboarding and terminal operations, and also seeds the client-side `lastVisibleAgents` and onboarding save payload with Team Lead visible by default.
- **Logic:**
  1. Remove `checked` from the Team Lead onboarding checkbox.
  2. Remove `checked` from the Team Lead terminal-operations visibility checkbox.
  3. Flip the client-side `lastVisibleAgents['team-lead']` bootstrap default to `false`.
  4. Flip the onboarding save payload’s `'team-lead'` default to `false` so completing onboarding does not re-enable Team Lead unless the user checks it.
  5. Leave the existing Team Lead rows, render logic, and saved-command fields in place; they will now be driven by the shared false default.
- **Implementation:**
```html
<div class="startup-row" style="display:flex; align-items:center; gap:6px;">
    <input type="checkbox" class="onboard-agent-toggle" data-role="team-lead"
        style="width:auto; margin:0; flex-shrink:0;">
    <label style="min-width:70px;">Team Lead</label><input type="text" id="onboard-cli-team-lead"
        placeholder="e.g. opencode" style="flex:1;">
</div>
```

```html
<div class="startup-row" style="display:flex; align-items:center; gap:6px;">
    <input type="checkbox" class="agent-visible-toggle" data-role="team-lead"
        style="width:auto; margin:0; flex-shrink:0;">
    <label style="min-width:70px;">Team Lead</label><input type="text" data-role="team-lead"
        placeholder="e.g. opencode" style="flex:1;">
</div>
```

```javascript
let lastVisibleAgents = {
    planner: true,
    lead: true,
    coder: true,
    intern: true,
    reviewer: true,
    tester: false,
    analyst: true,
    'team-lead': false,
    jules: true
};
```

```javascript
const visibleAgents = {
    lead: true,
    coder: true,
    intern: true,
    reviewer: true,
    tester: false,
    planner: true,
    analyst: true,
    'team-lead': false,
    jules: true
};
```
- **Edge Cases Handled:** Eliminates first-render checkbox drift and prevents onboarding from re-persisting Team Lead as visible unless the user deliberately opts into it.

### 4. Kanban Webview Bootstrap Defaults
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The Kanban webview seeds its local `lastVisibleAgents` before the provider pushes real state. If Team Lead remains `true` here, the column can briefly render visible even when the provider default is fixed.
- **Logic:** Change only the Team Lead local bootstrap default from `true` to `false`.
- **Implementation:**
```javascript
let lastVisibleAgents = {
    lead: true,
    coder: true,
    intern: true,
    reviewer: true,
    tester: false,
    planner: true,
    analyst: true,
    'team-lead': false,
    jules: true
};
```
- **Edge Cases Handled:** Keeps first paint aligned with provider-driven state so the Kanban board does not flash the Team Lead column before `visibleAgents` arrives.

### 5. Regression Coverage
#### [CREATE] `src/test/team-lead-visibility-defaults-regression.test.js`
- **Context:** There is currently no focused regression test for Team Lead’s default-hidden behavior. Existing tests cover dispatch and setup migration, but not this shared visibility default chain.
- **Logic:**
  1. Assert both provider defaults set `'team-lead': false`.
  2. Assert `implementation.html` no longer hardcodes Team Lead checkboxes as checked.
  3. Assert `implementation.html` and `kanban.html` local visibility defaults set `'team-lead': false`.
  4. Assert `TEAM LEAD CODED` still retains `hideWhenNoAgent: true` in `agentConfig.ts`.
  5. Assert `_filterDynamicColumns()` still preserves occupied hidden columns.
- **Implementation:**
```javascript
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanProviderPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const implementationPath = path.join(process.cwd(), 'src', 'webview', 'implementation.html');
    const kanbanPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const agentConfigPath = path.join(process.cwd(), 'src', 'services', 'agentConfig.ts');

    const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');
    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');
    const implementationSource = fs.readFileSync(implementationPath, 'utf8');
    const kanbanSource = fs.readFileSync(kanbanPath, 'utf8');
    const agentConfigSource = fs.readFileSync(agentConfigPath, 'utf8');

    assert.match(
        kanbanProviderSource,
        /const defaults: Record<string, boolean> = \{[\s\S]*'team-lead': false[\s\S]*jules: true[\s\S]*\};/m,
        "Expected KanbanProvider visible-agent defaults to hide Team Lead by default."
    );

    assert.match(
        taskViewerSource,
        /const defaults: Record<string, boolean> = \{[\s\S]*'team-lead': false[\s\S]*jules: true[\s\S]*\};/m,
        "Expected TaskViewerProvider visible-agent defaults to hide Team Lead by default."
    );

    assert.match(
        implementationSource,
        /let lastVisibleAgents = \{[\s\S]*'team-lead': false[\s\S]*jules: true \};/m,
        "Expected implementation.html bootstrap visibility to hide Team Lead by default."
    );

    assert.match(
        implementationSource,
        /const visibleAgents = \{[\s\S]*'team-lead': false[\s\S]*jules: true \};/m,
        "Expected onboarding save defaults to keep Team Lead hidden unless explicitly enabled."
    );

    assert.doesNotMatch(
        implementationSource,
        /class="onboard-agent-toggle" data-role="team-lead" checked/,
        "Expected Team Lead onboarding checkbox not to be pre-checked."
    );

    assert.doesNotMatch(
        implementationSource,
        /class="agent-visible-toggle" data-role="team-lead" checked/,
        "Expected Team Lead terminal-operations checkbox not to be pre-checked."
    );

    assert.match(
        kanbanSource,
        /let lastVisibleAgents = \{[\s\S]*'team-lead': false[\s\S]*jules: true \};/m,
        "Expected kanban.html bootstrap visibility to hide Team Lead by default."
    );

    assert.match(
        agentConfigSource,
        /\{ id: 'TEAM LEAD CODED', label: 'Team Lead', role: 'team-lead', order: 170, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true \}/,
        'Expected TEAM LEAD CODED to remain a hideWhenNoAgent column.'
    );

    assert.match(
        kanbanProviderSource,
        /if \(occupiedColumns\.has\(col\.id\)\) return true;/,
        'Expected KanbanProvider to keep occupied hidden columns visible.'
    );

    console.log('team lead visibility defaults regression test passed');
}

try {
    run();
} catch (error) {
    console.error('team lead visibility defaults regression test failed:', error);
    process.exit(1);
}
```
- **Edge Cases Handled:** Locks down both the default-hidden Team Lead behavior and the occupied-column fallback so a later refactor cannot "fix" one by breaking the other.

### 6. Explicit Non-Changes (Clarification)
#### [MODIFY] `src/webview/setup.html`
- **Context:** `setup.html` currently contains a local `lastVisibleAgents` object that also lists `'team-lead': true`, but this panel saves only `getCustomVisibleAgentsPatch()` for custom agents and receives authoritative built-in visibility from `TaskViewerProvider.getVisibleAgents()`.
- **Logic:** Do **not** treat `setup.html` as a required behavior fix for this bug unless manual testing shows a user-visible Team Lead flash in the central setup panel itself.
- **Implementation:**
```javascript
document.getElementById('btn-save-startup')?.addEventListener('click', () => {
    const accurateCodingEnabled = !!document.getElementById('accurate-coding-toggle')?.checked;
    const advancedReviewerEnabled = !!document.getElementById('advanced-reviewer-toggle')?.checked;
    const leadChallengeEnabled = !!document.getElementById('lead-challenge-toggle')?.checked;
    const aggressivePairProgramming = !!document.getElementById('aggressive-pair-toggle')?.checked;
    const designDocEnabled = !!document.getElementById('design-doc-toggle')?.checked;
    const planIngestionFolder = document.getElementById('plan-ingestion-folder-input')?.value.trim() || '';
    saveStartupButton.textContent = 'SAVING...';
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
        visibleAgents: getCustomVisibleAgentsPatch()
    });
});
```
- **Edge Cases Handled:** Prevents the implementation from broadening the change set into setup-panel code that is not part of the persisted built-in Team Lead visibility bug.

## Verification Plan
### Automated Tests
- Run `npx tsc --noEmit`.
- Run `npm run compile`.
- Run `node src/test/team-lead-visibility-defaults-regression.test.js`.

### Manual Checks
- Open Switchboard in a workspace with no saved `.switchboard/state.json`; confirm `TEAM LEAD CODED` does not appear on the Kanban board by default.
- Confirm the Team Lead checkbox is unchecked in onboarding and in Terminal Operations on first load.
- Enable Team Lead in the sidebar / terminal settings and confirm the Team Lead agent row and `TEAM LEAD CODED` column appear.
- Move or load a plan into `TEAM LEAD CODED`, then disable Team Lead and refresh; confirm the column remains visible because it is occupied.
- Open an older workspace that already has `visibleAgents['team-lead'] = true` persisted and confirm the column remains visible until the user changes that saved preference.

**Recommended Agent:** Send to Coder

## Preserved Original Draft Content
> [!NOTE]
> The original plan content below is preserved verbatim so the enhancement pass does not delete the pre-existing problem statement or implementation steps.

## Problem
The TEAM LEAD CODED column in the kanban board shows up by default even when no team lead agent is active/assigned. This is inconsistent with other agent columns which only appear when their corresponding agents are active.

## Root Cause
In `src/services/KanbanProvider.ts`, the `_getVisibleAgents` method sets the default visibility for 'team-lead' to `true`:
```typescript
const defaults: Record<string, boolean> = { 
  lead: true, coder: true, intern: true, reviewer: true, tester: false, 
  planner: true, analyst: true, 'team-lead': true, jules: true 
};
```

The `_filterDynamicColumns` method only checks the `visibleAgents` flag, not whether the agent actually has an assigned startup command.

## Solution
Change the default visibility for 'team-lead' from `true` to `false` in the defaults object. This will make the TEAM LEAD CODED column behave consistently with other columns that have `hideWhenNoAgent: true` - it will only appear when:
- The agent is explicitly enabled in setup, OR
- There are cards already in the column

## Implementation Steps

1. Edit `src/services/KanbanProvider.ts`
   - In the `_getVisibleAgents` method (around line 1270)
   - Change `'team-lead': true` to `'team-lead': false` in the defaults object

2. Test the fix
   - Verify that TEAM LEAD CODED column is hidden by default
   - Verify that enabling the team lead agent in setup makes the column appear
   - Verify that existing cards in TEAM LEAD CODED column still show the column

## Reviewer Execution Update

### Stage 1 - Grumpy Principal Engineer
> **MAJOR:** The regression coverage wandered off the reservation. The plan explicitly carved `setup.html` out as a non-required surface unless manual testing proved a real first-paint defect, and the test promptly shackled it into the contract anyway. That is how "small bugfixes" metastasize into folklore requirements.
>
> **NIT:** `setup.html` was flipped along with the real target surfaces. It is not harmful, but it was also not necessary to satisfy the plan as written. Cute consistency tweak; wrong place to turn preference into policy.
>
> **KEEP:** The actual fix path is sound. Provider defaults, Kanban bootstrap defaults, onboarding defaults, checkbox markup, and the occupied-column escape hatch all line up with the stated goal.

### Stage 2 - Balanced Synthesis
1. **Keep now:** the shared Team Lead default-hidden changes in `KanbanProvider.ts`, `TaskViewerProvider.ts`, `implementation.html`, and `kanban.html`, plus the regression checks for those surfaces and for the occupied-column fallback.
2. **Fix now:** remove the over-scoped `setup.html` assertion from the regression test and revert the incidental `setup.html` bootstrap flip so the implementation matches the plan's explicit non-change boundary.
3. **Defer:** no migration for persisted `visibleAgents['team-lead'] = true` state; the plan correctly leaves that behavior unchanged.

### Fixed Items
- Removed the regression assertion that treated `src/webview/setup.html` as a required part of this bugfix.
- Reverted the incidental `src/webview/setup.html` Team Lead bootstrap default so the implementation stays within the plan's declared scope.

### Files Changed During Review Pass
- `src/test/team-lead-visibility-defaults-regression.test.js`
- `src/webview/setup.html`

### Validation Results
- `npx tsc --noEmit` -> **fails**, but only on the pre-existing TS2835 dynamic import issue at `src/services/KanbanProvider.ts:2197` (`await import('./ArchiveManager')`).
- `npm run compile` -> **passed**
- `node src/test/team-lead-visibility-defaults-regression.test.js` -> **passed**

### Remaining Risks
- Existing workspaces with persisted `visibleAgents['team-lead'] = true` will continue to show Team Lead until the user changes that saved preference; this remains an intentional non-goal.
- Manual UI verification of first paint was not performed here, so the review relies on source inspection plus the focused regression test rather than an interactive webview check.
