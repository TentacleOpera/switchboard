# Plan: Disable Team Lead Column by Default and Add Routing Options to Setup

## Goal
Preserve the existing default-hidden Team Lead behavior and add two Setup-controlled Kanban settings: a Team Lead complexity cutoff slider and a Team Lead column order override. The finished behavior should let Team Lead act as an optional alternative coded lane without changing the current default lead/coder/intern flow unless the user explicitly enables Team Lead routing.

## Metadata
**Tags:** frontend, backend, UI, bugfix
**Complexity:** 6

## User Review Required
> [!NOTE]
> The “disable Team Lead by default” portion is already implemented in the codebase today. This plan must preserve those defaults and add the missing routing/order configuration on top of them rather than re-implementing the hidden-by-default behavior a second time.
>
> If users leave the Team Lead cutoff at `0`, existing complexity routing and pair-programming behavior must remain unchanged.

## Complexity Audit
### Routine
- Keep the existing Team Lead hidden-by-default behavior intact in `src/services/agentConfig.ts`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/setup.html`, and `src/webview/kanban.html`.
- Extend the existing `Orchestration Framework Integration` accordion in `src/webview/setup.html` with two more controls: a Team Lead complexity cutoff slider and a Team Lead Kanban order input.
- Add setup-panel relay/hydration for those two values in `src/services/SetupPanelProvider.ts` and `src/services/TaskViewerProvider.ts`.
- Document the behavior in `docs/TECHNICAL_DOC.md` and `README.md`.
- Extend the existing Team Lead default-visibility regression test rather than replacing it.

### Complex / Risky
- Extend complexity routing in `src/services/KanbanProvider.ts` so Team Lead can override the standard lead/coder/intern routing only for the configured ranges while leaving the rest of the routing map untouched.
- Update every typed call site that currently assumes routed roles are only `'lead' | 'coder' | 'intern'`, including partitioning helpers and regression tests.
- Add Team Lead order overrides to `buildKanbanColumns()` without mutating the shared `DEFAULT_KANBAN_COLUMNS` object graph, or the override will leak across future calls and workspaces.

## Edge-Case & Dependency Audit
- **Race Conditions:** Setup-panel state hydrates asynchronously. The new Team Lead routing/order inputs in `src/webview/setup.html` must request their current values on accordion open and on initial setup-panel state post so the UI does not display stale defaults after Kanban state changes elsewhere.
- **Security:** No new secrets, filesystem writes, or external APIs are introduced. The change is limited to workspace state, webview UI, routing logic, and documentation.
- **Side Effects:** Changing the Team Lead cutoff slider can reroute `PLAN REVIEWED` cards that previously went to Lead/Coder/Intern. Changing Team Lead order affects board ordering anywhere `buildKanbanColumns()` is used, so sidebar/kanban-derived column lists must stay in sync.
- **Dependencies & Conflicts:** `get_kanban_state` shows no active **New** plans. The only active **Planned** overlap is `Update README with Recent Features`, which does not touch the same code paths. Historical reviewed Team Lead cards already landed in `src/webview/setup.html`, `src/webview/implementation.html`, and Team Lead visibility defaults; treat those as prior art, not work to duplicate.

## Adversarial Synthesis
### Grumpy Critique
> This draft is trying to solve yesterday’s bug again. Team Lead is already hidden by default, and Setup already has a Team Lead accordion. So if you blindly implement this as written, you will duplicate shipped behavior, spray dead state into the codebase, and congratulate yourself for fixing a problem the repo no longer has.
>
> If the UI is going to expose a slider, then commit to it properly. A slider without labels is just numerology with CSS. Users should not have to reverse-engineer whether `5` means “medium and above” or whether `7` means “high only” by spelunking TypeScript. The control needs explicit helper text and a live label, or it is just a polished confusion machine.
>
> And for the love of type safety, do not mutate `DEFAULT_KANBAN_COLUMNS` in place. Those objects are shared. One sloppy override and you will make Team Lead ordering bleed into later calls, tests, or even other workspaces. Congratulations: you turned a settings feature into ambient state corruption.
>
> Also, changing `resolveRoutedRole()` to return `'team-lead'` is not a one-line tweak. That union flows into partitioning, dispatch targeting, MCP routing, test fixtures, and any helper still pretending the only coded roles are lead/coder/intern. Miss one and you buy yourself a compile error or, worse, a silent misroute.

### Balanced Synthesis
The safe plan is to acknowledge the shipped baseline, preserve it, and implement only the missing configuration surface. Use a slider-backed cutoff because that is the preferred UX, but make the slider semantics explicit in the UI and code: `0` disables Team Lead routing, `1` routes everything, `5` means medium-and-above, and `7` means high-only. Route those settings through the existing Setup panel and Kanban provider plumbing, and clone built-in column definitions before applying per-workspace Team Lead order overrides. That keeps the change narrow, avoids duplicating already-landed Team Lead visibility work, and makes the resulting routing behavior explicit and testable.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** The authoritative implementation is the section below. The older draft preserved later in this file is historical context only. Where the preserved draft conflicts with this section, follow this section.

### 1. Preserve current default-hidden Team Lead behavior while adding order overrides
#### [MODIFY] `src/services/agentConfig.ts`
- **Context:** `TEAM LEAD CODED` is already hidden by default via `hideWhenNoAgent: true`, which satisfies the “disabled by default” requirement today. The missing capability is a per-workspace order override for that built-in column.
- **Logic:**
  1. Keep the current `TEAM LEAD CODED` built-in definition unchanged so new workspaces still hide the Team Lead column when no Team Lead agent is visible.
  2. Introduce an optional override object for `buildKanbanColumns()` such as `{ teamLeadOrder?: number }`.
  3. Clone `DEFAULT_KANBAN_COLUMNS` with `map(column => ({ ...column }))` before applying overrides; do **not** mutate the module-level constant objects in place.
  4. Apply the override only to the `TEAM LEAD CODED` column and return the fully sorted built-in + custom column list.
- **Implementation:**
```typescript
export interface KanbanColumnBuildOverrides {
    teamLeadOrder?: number;
}

export function buildKanbanColumns(
    customAgents: CustomAgentConfig[],
    overrides: KanbanColumnBuildOverrides = {}
): KanbanColumnDefinition[] {
    const defaultColumns = DEFAULT_KANBAN_COLUMNS.map(column => ({ ...column }));
    if (typeof overrides.teamLeadOrder === 'number') {
        const teamLeadColumn = defaultColumns.find(column => column.id === 'TEAM LEAD CODED');
        if (teamLeadColumn) {
            teamLeadColumn.order = overrides.teamLeadOrder;
        }
    }

    const customColumns = customAgents
        .filter(agent => agent.includeInKanban)
        .map(agent => ({
            id: agent.role,
            label: agent.name,
            role: agent.role,
            order: agent.kanbanOrder,
            kind: 'custom' as const,
            autobanEnabled: false,
            dragDropMode: agent.dragDropMode,
        }));

    return [...defaultColumns, ...customColumns]
        .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
```
- **Edge Cases Handled:** Preserves the existing hidden-by-default Team Lead behavior while preventing cross-call mutation of shared column definitions.

### 2. Add Team Lead routing cutoff and Team Lead order to KanbanProvider
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** KanbanProvider is the source of truth for complexity routing, dynamic columns, workspace-state persistence, and board refreshes. The current provider supports lead/coder/intern routing and Team Lead dispatch, but it does not expose Team Lead as a configurable routing override.
- **Logic:**
  1. Use a numeric cutoff stored as `kanban.teamLeadComplexityCutoff`, with explicit semantics:
     - `0`: disabled
     - `1`: all plans route to Team Lead
     - `5`: medium and above
     - `7`: high only
  2. Persist two new workspace-state keys:
     - `kanban.teamLeadComplexityCutoff`
     - `kanban.teamLeadKanbanOrder`
  3. Add getters/setters that clamp/validate inputs, persist them, and trigger the existing refresh flow.
  4. Extend `resolveRoutedRole()` so Team Lead overrides only when `score >= teamLeadComplexityCutoff` and the cutoff is greater than `0`, then falls through to the existing `_routingMapConfig` / `scoreToRoutingRole()` logic for the remaining scores.
  5. Extend the return unions and typed helpers that currently assume only `'lead' | 'coder' | 'intern'`, including:
      - `resolveRoutedRole()`
      - `_resolveComplexityRoutedRole()`
      - `_partitionByComplexityRoute()`
      - `_targetColumnForDispatchRole()`
  6. Update all `buildKanbanColumns(...)` calls inside `KanbanProvider.ts` to pass the Team Lead order override.
  7. Preserve the existing `_resolveMcpMoveTarget()` mapping that already includes `'team-lead': 'TEAM LEAD CODED'`; do not duplicate that mapping unnecessarily.
- **Implementation:**
```typescript
private _teamLeadComplexityCutoff: number;
private _teamLeadKanbanOrder: number;

constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
) {
    // existing constructor state ...
    this._teamLeadComplexityCutoff = this._context.workspaceState.get<number>(
        'kanban.teamLeadComplexityCutoff',
        0
    );
    this._teamLeadKanbanOrder = this._context.workspaceState.get<number>(
        'kanban.teamLeadKanbanOrder',
        170
    );
}

public getTeamLeadRoutingSettings(): { complexityCutoff: number; kanbanOrder: number } {
    return {
        complexityCutoff: this._teamLeadComplexityCutoff,
        kanbanOrder: this._teamLeadKanbanOrder
    };
}

public async setTeamLeadComplexityCutoff(cutoff: number): Promise<void> {
    this._teamLeadComplexityCutoff = Math.max(0, Math.min(10, Math.round(cutoff)));
    await this._context.workspaceState.update('kanban.teamLeadComplexityCutoff', this._teamLeadComplexityCutoff);
}

public async setTeamLeadKanbanOrder(order: number): Promise<void> {
    this._teamLeadKanbanOrder = Number.isFinite(order) ? order : 170;
    await this._context.workspaceState.update('kanban.teamLeadKanbanOrder', this._teamLeadKanbanOrder);
}

public resolveRoutedRole(score: number): 'lead' | 'coder' | 'intern' | 'team-lead' {
    if (this._teamLeadComplexityCutoff > 0 && score >= this._teamLeadComplexityCutoff) {
        return 'team-lead';
    }

    let role: 'lead' | 'coder' | 'intern';
    if (this._routingMapConfig) {
        if (this._routingMapConfig.intern.includes(score)) {
            role = 'intern';
        } else if (this._routingMapConfig.coder.includes(score)) {
            role = 'coder';
        } else {
            role = 'lead';
        }
    } else {
        role = scoreToRoutingRole(score);
    }

    const isPairMode = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';
    if (isPairMode && role === 'intern') {
        role = 'coder';
    }
    return role;
}

private _targetColumnForDispatchRole(role: 'lead' | 'coder' | 'intern' | 'team-lead'): string {
    if (role === 'team-lead') return 'TEAM LEAD CODED';
    if (role === 'intern') return 'INTERN CODED';
    return role === 'coder' ? 'CODER CODED' : 'LEAD CODED';
}
```
- **Edge Cases Handled:** Keeps Team Lead routing disabled by default, preserves pair-programming intern bypass for non-Team-Lead cases, and avoids breaking MCP routing that already understands Team Lead.

### 3. Relay Team Lead routing settings through the existing Setup panel plumbing
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** Setup webviews already flow through `TaskViewerProvider` for startup commands, visible agents, prompt settings, and setup-state hydration. The Team Lead routing/order settings need to use the same plumbing or the Setup view will diverge from Kanban state.
- **Logic:**
  1. Add a small helper such as `handleGetTeamLeadRoutingSettings()` that returns `this._kanbanProvider?.getTeamLeadRoutingSettings()` with defaults when the provider is unavailable.
  2. Extend `postSetupPanelState()` to post a `teamLeadRoutingSettings` message alongside the existing setup state.
  3. Extend `handleSaveStartupCommands()` so when the setup webview includes `teamLeadComplexityCutoff` and `teamLeadKanbanOrder`, the method forwards them to `KanbanProvider.setTeamLeadComplexityCutoff()` / `setTeamLeadKanbanOrder()` and then schedules a board refresh.
  4. Introduce a local helper for ordered columns, for example `_buildKanbanColumnsForWorkspace(customAgents)`, and replace existing raw `buildKanbanColumns(customAgents)` calls that drive visible column lists in `TaskViewerProvider.ts`. This keeps sidebar, dropdown, and Kanban-adjacent column order consistent with the Team Lead order override.
- **Implementation:**
```typescript
 public handleGetTeamLeadRoutingSettings(): { complexityCutoff: number; kanbanOrder: number } {
    return this._kanbanProvider?.getTeamLeadRoutingSettings() ?? {
        complexityCutoff: 0,
        kanbanOrder: 170
    };
}

private _buildKanbanColumnsForWorkspace(customAgents: CustomAgentConfig[]) {
    const teamLeadSettings = this._kanbanProvider?.getTeamLeadRoutingSettings();
    return buildKanbanColumns(customAgents, {
        teamLeadOrder: teamLeadSettings?.kanbanOrder
    });
}
```
- **Edge Cases Handled:** Prevents setup-panel state drift and ensures non-Kanban consumers of `buildKanbanColumns()` do not show stale Team Lead ordering.

### 4. Add Setup-panel relay for Team Lead routing settings
#### [MODIFY] `src/services/SetupPanelProvider.ts`
- **Context:** `SetupPanelProvider` currently relays setup requests like `getStartupCommands`, `getVisibleAgents`, and `saveStartupCommands`. Team Lead routing settings need one matching getter path for setup hydration.
- **Logic:**
  1. Add a new `getTeamLeadRoutingSettings` message case.
  2. Call `this._taskViewerProvider.handleGetTeamLeadRoutingSettings()`.
  3. Post the result back to the setup webview as `type: 'teamLeadRoutingSettings'`.
  4. Reuse `saveStartupCommands` for persistence; no separate “save Team Lead routing settings” message is required.
- **Implementation:**
```typescript
case 'getTeamLeadRoutingSettings': {
    const settings = this._taskViewerProvider.handleGetTeamLeadRoutingSettings();
    this._panel.webview.postMessage({ type: 'teamLeadRoutingSettings', ...settings });
    break;
}
```
- **Edge Cases Handled:** Keeps Team Lead routing/order hydration in the same setup-panel lifecycle as the rest of the configuration state.

### 5. Extend the existing Team Lead Setup accordion with the two missing controls
#### [MODIFY] `src/webview/setup.html`
- **Context:** The Team Lead accordion already exists in the Setup view and already persists Team Lead visibility + command. The missing UI is a Team Lead routing cutoff slider and a Team Lead Kanban order configuration.
- **Logic:**
  1. Reuse the existing `Orchestration Framework Integration` block in `src/webview/setup.html`; do not add a second Team Lead section.
  2. Add an `input[type="range"]` slider for `teamLeadComplexityCutoff` with bounds `0..10`.
  3. Add a live label next to or below the slider that translates key values into user-facing meaning:
     - `0 (disabled)`
     - `1 (all plans)`
     - `5 (medium and above)`
     - `7 (high only)`
  4. Add a numeric input for Team Lead Kanban order.
  5. On accordion open, request `getStartupCommands`, `getVisibleAgents`, and `getTeamLeadRoutingSettings`.
  6. Extend the existing global Save Configuration payload to include `teamLeadComplexityCutoff` and `teamLeadKanbanOrder`.
  7. Hydrate the new inputs from `teamLeadRoutingSettings`.
  8. **Clarification:** The slider is intentionally a bounded 0–10 scale because complexity scores are already stored on that scale elsewhere in the product.
- **Implementation:**
```html
<label class="startup-row" style="display:block; margin-top:6px;">
    <span style="display:block; margin-bottom:4px;">Team Lead complexity cutoff</span>
    <input id="team-lead-complexity-cutoff" type="range" min="0" max="10" step="1" value="0" style="width:100%;">
    <span id="team-lead-complexity-cutoff-label" style="display:block; margin-top:4px; font-size:10px; color:var(--text-secondary);">
        0 (disabled)
    </span>
</label>
<label class="startup-row" style="display:block; margin-top:6px;">
    <span style="display:block; margin-bottom:4px;">Team Lead Kanban position</span>
    <input id="team-lead-kanban-order" type="number" min="0" step="10" placeholder="170" style="width:100%;">
</label>
```

```javascript
const teamLeadComplexityCutoffInput = document.getElementById('team-lead-complexity-cutoff');
const teamLeadComplexityCutoffLabel = document.getElementById('team-lead-complexity-cutoff-label');
const teamLeadKanbanOrderInput = document.getElementById('team-lead-kanban-order');

function describeTeamLeadCutoff(value) {
    const numeric = Number(value);
    if (numeric <= 0) return '0 (disabled)';
    if (numeric <= 1) return '1 (all plans)';
    if (numeric >= 7) return `${numeric} (high only)`;
    if (numeric >= 5) return `${numeric} (medium and above)`;
    return `${numeric} (low+ scores also route to Team Lead)`;
}

bindAccordion('orchestration-toggle', 'orchestration-fields', 'orchestration-chevron', () => {
    vscode.postMessage({ type: 'getStartupCommands' });
    vscode.postMessage({ type: 'getVisibleAgents' });
    vscode.postMessage({ type: 'getTeamLeadRoutingSettings' });
});

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
    visibleAgents,
    teamLeadComplexityCutoff: Number(teamLeadComplexityCutoffInput?.value || 0),
    teamLeadKanbanOrder: Number(teamLeadKanbanOrderInput?.value || 170)
});

case 'teamLeadRoutingSettings':
    if (teamLeadComplexityCutoffInput) {
        teamLeadComplexityCutoffInput.value = String(message.complexityCutoff ?? 0);
    }
    if (teamLeadComplexityCutoffLabel) {
        teamLeadComplexityCutoffLabel.textContent = describeTeamLeadCutoff(message.complexityCutoff ?? 0);
    }
    if (teamLeadKanbanOrderInput) {
        teamLeadKanbanOrderInput.value = String(message.kanbanOrder ?? 170);
    }
    break;
```
- **Edge Cases Handled:** Reuses the already-landed Team Lead accordion instead of duplicating UI, and keeps the Setup experience aligned with Kanban workspace state.

### 6. Update regression coverage for the new Team Lead routing/options behavior
#### [MODIFY] `src/test/team-lead-visibility-defaults-regression.test.js`
- **Context:** This regression test already proves Team Lead stays hidden by default and that the Team Lead setup accordion exists. It should remain the source of truth for the shipped default-hidden behavior.
- **Logic:**
  1. Keep the current assertions that verify Team Lead stays hidden by default.
  2. Add assertions for the new setup control IDs:
     - `team-lead-complexity-cutoff`
     - `team-lead-complexity-cutoff-label`
     - `team-lead-kanban-order`
  3. Add assertions that the setup accordion requests `getTeamLeadRoutingSettings`.
  4. Add assertions that `saveStartupCommands` now carries `teamLeadComplexityCutoff` and `teamLeadKanbanOrder`.
- **Edge Cases Handled:** Protects the already-landed default-hidden behavior while proving the new setup controls are wired in.

#### [MODIFY] `src/test/pair-programming-routing-bypass.test.ts`
- **Context:** The existing test assumes routed roles are only lead/coder/intern. Once Team Lead can override standard complexity routing, the test needs to prove pair programming still only bypasses intern routing and does not silently demote Team Lead.
- **Logic:**
  1. Add a small simulation helper for Team Lead cutoff precedence.
  2. Assert that:
     - `teamLeadComplexityCutoff = 0` preserves current behavior.
     - `teamLeadComplexityCutoff = 5` routes 5–10 to Team Lead before the standard map.
     - `teamLeadComplexityCutoff = 7` routes 7–10 to Team Lead before the standard map.
     - Pair-programming only rewrites `'intern' -> 'coder'`; it must not rewrite `'team-lead'`.
- **Edge Cases Handled:** Prevents regressions where Team Lead routing gets accidentally bypassed or where pair programming starts rewriting Team Lead routes.

#### [CREATE] `src/test/team-lead-routing-options-regression.test.js`
- **Context:** The routing-cutoff + column-order feature adds enough wiring that a source-level regression test is justified.
- **Logic:** Read the relevant sources from disk and assert that:
  1. `agentConfig.ts` clones `DEFAULT_KANBAN_COLUMNS` before applying Team Lead order overrides.
  2. `KanbanProvider.ts` persists `kanban.teamLeadComplexityCutoff` and `kanban.teamLeadKanbanOrder`.
  3. `setup.html` uses a bounded slider plus helper label for Team Lead routing.
  4. `TaskViewerProvider.ts` and `SetupPanelProvider.ts` expose `teamLeadRoutingSettings`.
- **Edge Cases Handled:** Catches the exact regressions most likely to reappear: in-place column mutation, missing persistence, and slider wiring drift.

### 7. Update documentation to describe the final Team Lead routing model
#### [MODIFY] `docs/TECHNICAL_DOC.md`
- **Context:** The technical doc already has sections for complexity classification, auto-routing, and AUTOBAN automation. Team Lead routing/order belongs there, not in a disconnected note.
- **Logic:** Add a subsection under the existing complexity-routing/AUTOBAN sections that documents:
  1. Team Lead is default-hidden unless enabled.
  2. Team Lead routing uses a 0–10 cutoff slider where `0` disables routing and higher values route any score at or above the cutoff to Team Lead.
  3. Team Lead order is a built-in column override, not a custom-agent column.
  4. Standard lead/coder/intern routing remains the fallback when the Team Lead cutoff is `0` or when a score falls below the chosen Team Lead range.

#### [MODIFY] `README.md`
- **Context:** README already documents Setup, AUTOBAN routing, and agent roles. It needs only a brief update, not a large feature essay.
- **Logic:** Add a concise note in the Setup/AUTOBAN sections that:
  1. Team Lead is off by default.
  2. Setup now exposes a Team Lead complexity cutoff slider and Team Lead board position.
  3. Enabling Team Lead routing changes how `PLAN REVIEWED` cards are auto-routed.

## Verification Plan
### Automated Tests
- Run `npx tsc -p tsconfig.test.json`.
- Run `node src/test/team-lead-visibility-defaults-regression.test.js`.
- Run `node src/test/team-lead-routing-options-regression.test.js`.
- Run `node out/test/pair-programming-routing-bypass.test.js`.

### Manual Checks
1. Open a workspace with no Team Lead terminal configured and verify the Team Lead column stays hidden by default.
2. Open **Setup → Orchestration Framework Integration** and verify the existing Team Lead toggle/command plus the new cutoff slider and Kanban order controls all hydrate correctly.
3. Save `teamLeadComplexityCutoff = 0`; verify complexity-routed cards still resolve to Lead/Coder/Intern using the current routing map.
4. Save `teamLeadComplexityCutoff = 5`; verify complexity 5+ plans route to `TEAM LEAD CODED`, while lower-complexity plans still route to Coder/Intern according to the existing routing map.
5. Save `teamLeadComplexityCutoff = 7`; verify only complexity 7+ plans route to `TEAM LEAD CODED`.
6. Change Team Lead Kanban order and verify the column moves relative to `LEAD CODED`, `CODER CODED`, and `INTERN CODED` anywhere the board/column lists are rendered.
7. Enable pair programming and verify Team Lead-routed plans stay Team Lead-routed; only Intern fallthrough should be elevated to Coder.

## Agent Recommendation
Send to Coder

## Reviewer Execution Update

### Stage 1 (Grumpy Principal Engineer)
> **NIT** Mercifully, this implementation did not re-fix a bug that was already fixed. It preserves the shipped “Team Lead hidden by default” baseline, adds the routing/order controls to the existing accordion, and avoids the classic amateur stunt of mutating `DEFAULT_KANBAN_COLUMNS` in place. Good — because that would have turned one settings tweak into ambient board-order corruption.
>
> **NIT** The remaining ugliness is mostly architectural gravity, not a broken feature. The routed-role expansion to `'team-lead'` is wired through the real dispatch paths, but the regression coverage is still largely source-shape based. A sufficiently creative refactor could keep the regexes happy while subtly upsetting live hydration or column-order consumers. Not a blocker, just the sort of thing that grows teeth later if nobody watches it.

### Stage 2 (Balanced)
Keep the implementation as shipped. No CRITICAL or MAJOR defect was found in this reviewer pass, so no production-code fix was warranted. The plan’s core requirements are satisfied: Team Lead remains default-hidden, the setup accordion now carries the cutoff slider and board-order input, the settings relay through the existing setup plumbing, the routed-role union includes Team Lead where it matters, the built-in column definitions are cloned before override, and the docs/tests were updated to match the feature.

### Fixed Items
- No reviewer-applied production code fixes were needed.

### Files Changed
- Observed implementation files:
  - `src/services/agentConfig.ts`
  - `src/services/KanbanProvider.ts`
  - `src/services/TaskViewerProvider.ts`
  - `src/services/SetupPanelProvider.ts`
  - `src/webview/setup.html`
  - `src/test/team-lead-visibility-defaults-regression.test.js`
  - `src/test/team-lead-routing-options-regression.test.js`
  - `src/test/pair-programming-routing-bypass.test.ts`
  - `README.md`
  - `docs/TECHNICAL_DOC.md`
- Reviewer update:
  - `.switchboard/plans/disable_team_lead_column_by_default_and_add_routing_options.md`

### Validation Results
- `npx tsc -p tsconfig.test.json` → passed
- `node src/test/team-lead-visibility-defaults-regression.test.js` → passed
- `node src/test/team-lead-routing-options-regression.test.js` → passed
- `node out/test/pair-programming-routing-bypass.test.js` → passed
- `npm run compile` → passed
- `npx tsc --noEmit` → pre-existing TS2835 at `src/services/KanbanProvider.ts:2238` for `await import('./ArchiveManager')`

### Remaining Risks
- Regression coverage is strong for source invariants, but still lighter on true UI interaction/runtime verification.
- `src/webview/setup.html` and Team Lead routing paths remain active merge hotspots for adjacent setup/autoban work.

> [!NOTE]
> The original draft sections below are preserved for traceability. Where they differ from the authoritative plan above, follow the authoritative plan above.

## Original Draft Problem

The Team Lead column (`TEAM LEAD CODED`) is currently enabled by default and positioned in the kanban workflow as if it's a complementary stage alongside Lead Coder, Coder, and Intern. However, Team Lead is actually an **alternative** to these roles, not a complement. This creates confusion because:

1. Users expect Team Lead to replace the standard coded lanes, not sit alongside them
2. The current default configuration shows all coded columns active simultaneously
3. There's no UI guidance on how Team Lead routing should work vs. the standard lead/coder/intern routing

## Original Draft Solution

Disable the Team Lead column by default and add two simple configuration options in the Setup view:
1. **Complexity routing for Team Lead**: Which complexity ranges should route to Team Lead (all, medium and above, high only, none)
2. **Team Lead kanban position**: Where the Team Lead column appears in the kanban workflow

## Original Draft Implementation Steps

### 1. Update Default Column Configuration

**File**: `src/services/agentConfig.ts`

Change the `TEAM LEAD CODED` column definition to be hidden by default:

```typescript
{ id: 'TEAM LEAD CODED', label: 'Team Lead', role: 'team-lead', order: 170, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true }
```

The `hideWhenNoAgent: true` flag already exists - this should be sufficient to hide Team Lead by default when no team-lead terminal is configured.

### 2. Add Team Lead Configuration State

**File**: `src/services/KanbanProvider.ts`

Add state properties for Team Lead configuration:

```typescript
private _teamLeadComplexityCutoff: number; // 0-10, 0 = no routing
private _teamLeadKanbanOrder: number;
```

Add getter/setter methods:

```typescript
public get teamLeadComplexityCutoff(): number {
    return this._teamLeadComplexityCutoff ?? 0;
}

public async setTeamLeadComplexityCutoff(cutoff: number) {
    this._teamLeadComplexityCutoff = Math.max(0, Math.min(10, cutoff));
    await this._context.workspaceState.update('kanban.teamLeadComplexityCutoff', this._teamLeadComplexityCutoff);
    await this._refreshBoard();
}

public get teamLeadKanbanOrder(): number {
    return this._teamLeadKanbanOrder ?? 170;
}

public async setTeamLeadKanbanOrder(order: number) {
    this._teamLeadKanbanOrder = order;
    await this._context.workspaceState.update('kanban.teamLeadKanbanOrder', order);
    await this._refreshBoard();
}
```

Load from workspace state in constructor:

```typescript
this._teamLeadComplexityCutoff = this._context.workspaceState.get<number>('kanban.teamLeadComplexityCutoff', 0);
this._teamLeadKanbanOrder = this._context.workspaceState.get<number>('kanban.teamLeadKanbanOrder', 170);
```

### 3. Update buildKanbanColumns to Apply Team Lead Order

**File**: `src/services/agentConfig.ts`

Modify `buildKanbanColumns` to accept an optional `teamLeadKanbanOrder` parameter:

```typescript
export function buildKanbanColumns(
    customAgents: CustomAgentConfig[],
    teamLeadKanbanOrder?: number
): KanbanColumnDefinition[] {
    const customColumns = customAgents
        .filter(agent => agent.includeInKanban)
        .map(agent => ({
            id: agent.role,
            label: agent.name,
            role: agent.role,
            order: agent.kanbanOrder,
            kind: 'custom' as const,
            autobanEnabled: false,
            dragDropMode: agent.dragDropMode,
        }));

    const defaultColumns = [...DEFAULT_KANBAN_COLUMNS];
    
    // Apply custom Team Lead order if provided
    if (teamLeadKanbanOrder !== undefined) {
        const teamLeadCol = defaultColumns.find(c => c.id === 'TEAM LEAD CODED');
        if (teamLeadCol) {
            teamLeadCol.order = teamLeadKanbanOrder;
        }
    }

    return [...defaultColumns, ...customColumns].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
```

Update callers in `KanbanProvider.ts` to pass the team lead order:

```typescript
columns = buildKanbanColumns(customAgents, this._teamLeadKanbanOrder);
```

### 4. Update Complexity Routing to Include Team Lead

**File**: `src/services/KanbanProvider.ts`

Modify `resolveRoutedRole` to handle Team Lead complexity routing:

```typescript
public resolveRoutedRole(score: number): 'lead' | 'coder' | 'intern' | 'team-lead' {
    // Check if this score should route to Team Lead based on cutoff threshold
    const cutoff = this._teamLeadComplexityCutoff;
    
    // Cutoff of 0 means no routing to Team Lead
    // Cutoff of 1 means all tasks route to Team Lead
    // Cutoff of 5 means tasks 5-10 route to Team Lead
    // Cutoff of 7 means tasks 7-10 route to Team Lead
    if (cutoff > 0 && score >= cutoff) {
        return 'team-lead';
    }

    let role: 'lead' | 'coder' | 'intern';

    // Apply custom routing map if configured
    if (this._routingMapConfig) {
        if (this._routingMapConfig.intern.includes(score)) {
            role = 'intern';
        } else if (this._routingMapConfig.coder.includes(score)) {
            role = 'coder';
        } else {
            role = 'lead';
        }
    } else {
        role = scoreToRoutingRole(score);
    }

    // Pair programming bypass: never route to intern when pair mode is active.
    const isPairMode = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';
    if (isPairMode && role === 'intern') {
        console.log(`[KanbanProvider] Pair programming bypass: score=${score} intern → coder`);
        role = 'coder';
    }

    return role;
}
```

Update `_targetColumnForDispatchRole` to handle team-lead:

```typescript
private _targetColumnForDispatchRole(role: 'lead' | 'coder' | 'intern' | 'team-lead'): string {
    if (role === 'team-lead') return 'TEAM LEAD CODED';
    if (role === 'intern') return 'INTERN CODED';
    return role === 'coder' ? 'CODER CODED' : 'LEAD CODED';
}
```

Update the role mapping in `_recordDispatchIdentity`:

```typescript
const roleFromColumn: Record<string, string> = {
    'PLAN REVIEWED': 'planner',
    'TEAM LEAD CODED': 'team-lead',
    'LEAD CODED': 'lead',
    'CODER CODED': 'coder',
    'INTERN CODED': 'intern',
    'PLANNED': 'planner',
    'CODE REVIEWED': 'reviewer',
    'ACCEPTANCE TESTED': 'tester',
};
```

### 5. Add UI to Setup View

**File**: `src/webview/setup.html`

Add a "Team Lead Configuration" section in the Setup view, likely near the terminal configuration or in its own accordion.

The UI should include:

**Complexity Cutoff Slider:**
```
Team Lead Complexity Cutoff:
[slider from 0 to 10, default: 0]
[display: "0 (disabled)" or "5 (medium and above)" or "7 (high only)" etc.]

Tasks with complexity >= cutoff will route to Team Lead.
- 0: Disabled (no routing to Team Lead)
- 1: All tasks route to Team Lead
- 5: Medium and above (5-10) route to Team Lead
- 7: High only (7-10) route to Team Lead
```

**Kanban Position Input:**
```
Team Lead Kanban Position:
[number input, default: 170]
Position in kanban workflow (lower = earlier)
```

Add state management for these controls and emit messages when changed:

```typescript
case 'setTeamLeadComplexityCutoff': {
    const cutoff = msg.cutoff as number;
    await kanbanProvider.setTeamLeadComplexityCutoff(cutoff);
    break;
}

case 'setTeamLeadKanbanOrder': {
    const order = msg.order as number;
    await kanbanProvider.setTeamLeadKanbanOrder(order);
    break;
}
```

### 6. Update MCP Role Mapping

**File**: `src/services/KanbanProvider.ts`

Update the role mapping in `_resolveMcpMoveTarget` to include team-lead:

```typescript
const roleToCol: Record<string, string> = {
    'lead': 'LEAD CODED', 'coder': 'CODER CODED', 'intern': 'INTERN CODED',
    'team-lead': 'TEAM LEAD CODED',
    'planner': 'PLANNED', 'reviewer': 'CODE REVIEWED', 'tester': 'ACCEPTANCE TESTED',
};
```

### 7. Update Documentation

**File**: `docs/TECHNICAL_DOC.md`

Add a section explaining Team Lead configuration:
- When to use Team Lead for complexity routing
- How the kanban position affects workflow
- Comparison with standard lead/coder/intern routing

**File**: README.md**

Add a brief mention of Team Lead configuration in the Setup section.

## Original Draft Testing

1. **Default Behavior**: Verify that new workspaces start with Team Lead complexity cutoff set to 0 (disabled) and Team Lead column hidden
2. **Complexity Routing**: 
   - Test various cutoff values (0, 1, 5, 7, 10)
   - Verify plans route correctly based on their complexity scores relative to the cutoff
3. **Kanban Position**: 
   - Test changing the kanban order value
   - Verify Team Lead column moves to the correct position
4. **Setup View**: Verify the UI controls work correctly and persist state
5. **Integration**: Verify that Team Lead routing works with autoban and manual dispatch

## Original Draft Success Criteria

- Team Lead column is hidden by default (no team-lead terminal configured)
- Setup view provides two simple configuration options for Team Lead
- Complexity slider (0-10) correctly routes tasks to Team Lead based on cutoff threshold
- Kanban position can be adjusted and persists correctly
- Documentation explains when to use Team Lead vs. standard routing
