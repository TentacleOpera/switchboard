# Feature Plan: Add Acceptance Tester Role

## Goal
Add a new `tester` built-in agent role and corresponding `ACCEPTANCE TESTED` Kanban column. This role executes after the `Reviewer` and is responsible for comparing the implemented code strictly against the original product requirements document (PRD) to identify any missed requirements. Because it relies heavily on the design document, this role is **disabled by default** and strictly requires a Design Doc / PRD to be attached in the Switchboard setup.

## Metadata
**Tags:** backend, frontend, UI
**Complexity:** 8

## User Review Required
> [!NOTE]
> Acceptance Tester must remain hidden by default and must reuse the existing Design Doc / PRD settings (`planner.designDocEnabled` and `planner.designDocLink`) rather than introducing a second document configuration path.
>
> Manual enablement is required for the full reviewer -> tester -> completed flow: the user must enable the Acceptance Tester role in Setup and attach a PRD / Design Doc first. Otherwise the plan should continue to terminate at `CODE REVIEWED`.

## Complexity Audit
### Routine
- Add `tester` to the built-in role union, labels, default columns, and prompt-override parsing in `src/services/agentConfig.ts`.
- Add `ACCEPTANCE TESTED` to `VALID_COLUMNS` in `src/services/planStateUtils.ts`.
- Add the tester role to prompt-override setup UI in `src/webview/setup.html`.
- Add tester visibility / CLI command rows and default `visibleAgents` state in `src/webview/implementation.html` and `src/webview/kanban.html`.
- Extend existing regression tests that hardcode the current built-in role and built-in column lists.

### Complex / Risky
- **Distinct workflow token required (Clarification):** the tester stage needs its own workflow/history marker (for example `tester-pass`) across dispatch, history derivation, pipeline progression, and manual move persistence. Reusing `reviewer-pass` would make refreshed cards derive back to `CODE REVIEWED` instead of `ACCEPTANCE TESTED`.
- **Conditional reviewer -> tester routing:** `CODE REVIEWED` can only advance to `ACCEPTANCE TESTED` when the tester role is visible **and** the shared Design Doc / PRD gate is enabled. Otherwise the feature creates a hidden dead-end column or repeated dispatch failures.
- **Two dispatch surfaces must stay consistent:** both `TaskViewerProvider.ts` sidebar dispatch and `KanbanProvider.ts` board/batch prompt generation must map the **source** `CODE REVIEWED` column to the tester role. Updating only the target column mappings is insufficient.
- **Pipeline automation drift:** `src/services/PipelineOrchestrator.ts` currently treats `reviewer-pass` as terminal. Without a coordinated update, the timer pipeline will bypass the tester stage entirely even if the UI and Kanban board support it.

## Edge-Case & Dependency Audit
- **Race Conditions:** `visibleAgents` can change between reviewer completion and tester dispatch. Mirror the same eligibility gate in both `TaskViewerProvider.ts` and `PipelineOrchestrator.ts` so the sidebar path, Kanban path, and timer path do not disagree. Preserve the existing "dispatch first, then update runsheet/DB" ordering so a failed tester dispatch does not incorrectly move cards forward.
- **Security:** Do not introduce a second PRD storage path or new outbound fetch. Reuse the existing design-doc configuration and cached Notion content path. If the design doc feature is disabled or the link is empty, block tester dispatch instead of sending a prompt that falsely implies the PRD is attached.
- **Side Effects:** If `ACCEPTANCE TESTED` is added only to the UI column list and not to the derivation / validation / review-log layers, cards will disappear, regress to `CREATED`, or show misleading audit history after refresh. Also note that `TaskViewerProvider.ts` and `register-tools.js` already map `tester` to `tester.md`, but no `.agent/personas/roles/tester.md` exists in this repo today; the loader currently fails open and returns `undefined`/`null`, so this feature must not depend on persona file presence.
- **Dependencies & Conflicts:** `get_kanban_state` currently shows this plan as the only active item in `PLAN REVIEWED`, so there are no blocking dependencies on other active New / Planned plans. There is still likely merge churn with recently coded/reviewed work touching `src/webview/setup.html`, `src/webview/implementation.html`, and `src/services/TaskViewerProvider.ts`, but those are not active Kanban blockers under the planning rules.

## Adversarial Synthesis
### Grumpy Critique
> This draft was one polite suggestion away from shipping a ghost role.
>
> 1. **You targeted the wrong file for prompt overrides.** `PROMPT_ROLES` is in `src/webview/setup.html`, not `src/webview/implementation.html`. If you "implement the plan" as written, the Acceptance Tester prompt override UI never appears and everyone wonders why the role exists but cannot be configured.
>
> 2. **You tried to smuggle a new stage through reviewer history.** Mapping tester dispatch to `reviewer-pass` is not a clever shortcut; it is a state-corruption bug wearing a fake mustache. The derivation layer will happily read that event and reconstruct `CODE REVIEWED`, so your shiny new `ACCEPTANCE TESTED` column evaporates on refresh.
>
> 3. **You ignored the real default-visibility surface area.** This is not one checkbox in one file. The onboarding rows, terminal-ops rows, `lastVisibleAgents` defaults, onboarding rehydration map, save payload, "no agents connected" guard list, sidebar render order, TaskViewerProvider defaults, KanbanProvider defaults, and Kanban webview defaults all hardcode built-in roles today. Miss even one and the role becomes a Schrödinger agent: visible in one view, absent in another, impossible to persist cleanly.
>
> 4. **You forgot the timer pipeline even exists.** `PipelineOrchestrator.ts` currently ends the lifecycle after reviewer success. So unless you explicitly thread tester eligibility into that pipeline, automated progression will skip the feature while manual clicks use it. Congratulations: now you have two incompatible product definitions depending on which button the user pressed.

### Balanced Response
Grumpy is right about the failure modes, and the corrected plan below hardens each one without expanding product scope:
1. **Authoritative file targeting:** the plan now treats `src/webview/setup.html` as the prompt-override surface and `src/webview/implementation.html` / `src/webview/kanban.html` as the visibility / CLI-command surfaces.
2. **Distinct tester workflow history:** the plan introduces a dedicated tester workflow token (`tester-pass` as the concrete recommendation) so dispatch, derived-state recovery, manual move persistence, and pipeline automation all converge on `ACCEPTANCE TESTED`.
3. **Single eligibility rule across all entry points:** reviewer -> tester progression is explicitly gated on tester visibility plus the existing Design Doc / PRD switch, so disabled-by-default behavior remains safe.
4. **Explicit regression coverage:** the plan calls out the exact existing tests whose hardcoded built-in role/column expectations must be updated, instead of pretending this is a one-file feature.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Use the file paths below as the authoritative implementation surface. The preserved draft snippets at the end of this file are historical context only wherever they conflict with the corrected implementation spec below.

### 0. Scope Corrections (Clarification)
#### [MODIFY] `src/webview/setup.html`, `src/webview/implementation.html`, `src/webview/kanban.html`, `src/services/agentConfig.ts`, `src/services/planStateUtils.ts`, `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/agentPromptBuilder.ts`, `src/services/kanbanColumnDerivationImpl.js`, `src/services/PipelineOrchestrator.ts`
- **Context:** The original draft is directionally correct about adding a role and column, but it is stale about where the current architecture actually lives.
- **Logic:**
  1. Treat `src/services/agentConfig.ts` as the canonical built-in role / built-in column definition source.
  2. Treat `src/webview/setup.html` as the prompt-override UI surface.
  3. Treat `src/webview/implementation.html` as the sidebar / onboarding / terminal-ops built-in-role visibility surface.
  4. Treat `src/webview/kanban.html` plus provider defaults as the Kanban visibility baseline.
  5. Treat `TaskViewerProvider.ts`, `KanbanProvider.ts`, `kanbanColumnDerivationImpl.js`, and `PipelineOrchestrator.ts` as one coupled state machine that must be updated together.
- **Implementation:** Before changing code, search these exact files for hardcoded built-in role arrays, hardcoded built-in column arrays, and workflow-to-column mappings. Do not assume that updating only the prompt builder and one provider file is sufficient.
- **Edge Cases Handled:** Prevents stale implementation against obsolete file locations, which is the main reason this feature would otherwise land half-wired.

### 1. Role and Column Definitions
#### [MODIFY] `src/services/agentConfig.ts`
- **Context:** This file is the canonical source for built-in roles, built-in labels, built-in columns, and valid default-prompt-override roles.
- **Logic:**
  1. Add `tester` to `BuiltInAgentRole`.
  2. Add a human-readable label of `Acceptance Tester`.
  3. Insert an `ACCEPTANCE TESTED` built-in Kanban column between `CODE REVIEWED` and `COMPLETED`.
  4. Keep `hideWhenNoAgent: true` so the column stays hidden by default when tester is disabled.
  5. Add `tester` to `parseDefaultPromptOverrides()` so the Setup prompt-override UI can persist tester overrides.
- **Implementation:**
```typescript
export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'tester' | 'planner' | 'analyst' | 'team-lead';

export const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    tester: 'Acceptance Tester',
    planner: 'Planner',
    analyst: 'Analyst',
    'team-lead': 'Team Lead'
};

const DEFAULT_KANBAN_COLUMNS: KanbanColumnDefinition[] = [
    { id: 'CREATED', label: 'New', order: 0, kind: 'created', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'TEAM LEAD CODED', label: 'Team Lead', role: 'team-lead', order: 170, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
    { id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', order: 180, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'CODER CODED', label: 'Coder', role: 'coder', order: 190, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'INTERN CODED', label: 'Intern', role: 'intern', order: 200, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
    { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', autobanEnabled: false, dragDropMode: 'cli' },
    { id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested', role: 'tester', order: 350, kind: 'reviewed', autobanEnabled: false, dragDropMode: 'cli', hideWhenNoAgent: true },
    { id: 'COMPLETED', label: 'Completed', order: 9999, kind: 'completed', autobanEnabled: false, dragDropMode: 'cli' },
];

const VALID_ROLES: BuiltInAgentRole[] = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'team-lead'];
```
- **Edge Cases Handled:** Makes the column available to every consumer that already derives built-in roles from `buildKanbanColumns([])`, while keeping it safely hidden when no tester is configured.

#### [MODIFY] `src/services/planStateUtils.ts`
- **Context:** Plan-file state parsing rejects unknown Kanban columns.
- **Logic:** Add `ACCEPTANCE TESTED` to `VALID_COLUMNS`; otherwise imported / persisted plan state for tester-reviewed items will fail validation and fall back incorrectly.
- **Implementation:**
```typescript
const VALID_COLUMNS = new Set([
    'CREATED', 'BACKLOG', 'PLANNED', 'TEAM LEAD CODED', 'INTERN CODED', 'CODER CODED',
    'LEAD CODED', 'CODE REVIEWED', 'ACCEPTANCE TESTED', 'CODED', 'PLAN REVIEWED', 'COMPLETED'
]);
```
- **Edge Cases Handled:** Prevents plan-state loss during clipboard import, disk refresh, and any path that reparses the `## Switchboard State` section.

### 2. Workflow History, Derived State, and Pipeline Progression
#### [MODIFY] `src/services/kanbanColumnDerivationImpl.js`
- **Context:** Refresh/reload state is reconstructed from workflow history, not just the current in-memory column.
- **Logic:**
  1. Add `acceptance-tested` to the manual move/reset slug map.
  2. Preserve `reviewer-pass -> CODE REVIEWED`.
  3. Add a distinct tester completion event (`tester-pass`) that derives to `ACCEPTANCE TESTED`.
  4. Do not overload `reviewer-pass` to mean both reviewed and acceptance-tested.
- **Implementation:**
```javascript
const SLUG_MAP = {
    'created': 'CREATED',
    'plan-reviewed': 'PLAN REVIEWED',
    'intern-coded': 'INTERN CODED',
    'lead-coded': 'LEAD CODED',
    'coder-coded': 'CODER CODED',
    'code-reviewed': 'CODE REVIEWED',
    'acceptance-tested': 'ACCEPTANCE TESTED',
    'coded': 'CODED'
};

switch (workflow) {
    case 'initiate-plan':
        return 'CREATED';

    case 'improve-plan':
    case 'improved plan':
    case 'enhanced plan':
    case 'sidebar-review':
        return 'PLAN REVIEWED';

    case 'handoff':
    case 'handoff-lead':
    case 'handoff-chat':
    case 'handoff-relay':
    case 'implementation':
        return 'CODED';

    case 'review':
    case 'reviewer-pass':
        return 'CODE REVIEWED';

    case 'tester-pass':
        return 'ACCEPTANCE TESTED';
}
```
- **Edge Cases Handled:** Ensures manual moves like `move-to-acceptance-tested` and persisted workflow events both survive refresh without snapping back to `CODE REVIEWED`.

#### [MODIFY] `src/services/PipelineOrchestrator.ts`
- **Context:** The timer pipeline currently stops after reviewer success.
- **Logic:**
  1. Replace the current hardcoded "reviewer-pass means done" rule with an eligibility-aware tester stage.
  2. Because tester is disabled by default, stage resolution must consult the same runtime eligibility that manual dispatch uses.
  3. The cleanest implementation is to inject a callback from `TaskViewerProvider.ts` that answers whether tester is currently active for the workspace/session.
  4. `reviewer-pass` should become either `{ role: 'tester', label: 'Acceptance Tester' }` or `'done'` depending on that callback; `tester-pass` should be terminal.
- **Implementation:**
```typescript
// Recommended refactor shape:
type IsAcceptanceTesterActive = (sheet: any) => Promise<boolean>;

function getNextStage(
    sheet: any,
    isAcceptanceTesterActive: IsAcceptanceTesterActive
): Promise<{ role: string; instruction?: string; label: string } | 'done'>;

// Required state-machine outcome:
// - no last workflow => planner
// - sidebar-review / improved plan => lead
// - handoff / handoff-lead => reviewer
// - reviewer-pass => tester if active, otherwise done
// - tester-pass => done
```
- **Edge Cases Handled:** Prevents the automated timer path from either skipping the tester stage when enabled or repeatedly attempting a tester dispatch that is guaranteed to fail because the user left the feature disabled.

### 3. Prompt Builder
#### [MODIFY] `src/services/agentPromptBuilder.ts`
- **Context:** The prompt builder needs a dedicated tester instruction set, and the processor mapping must point from the **source** review-complete column to the tester role.
- **Logic:**
  1. Add a `role === 'tester'` branch in `buildKanbanBatchPrompt()`.
  2. Reuse the existing design-doc plumbing style already used for planner prompts: prefer prefetched Notion content when available; otherwise include the configured doc URL.
  3. Update `columnToPromptRole()` so `CODE REVIEWED` maps to `tester`. Do **not** map `ACCEPTANCE TESTED` to `tester`, because that would mean re-processing cards that are already at the terminal tester stage.
- **Implementation:**
```typescript
if (role === 'tester') {
    let testerPrompt = `check the code against the relevant sections of the prd and advise if it complies.\n
${batchExecutionRules}
${focusDirective}${GIT_PROHIBITION_DIRECTIVE}

PLANS TO PROCESS:
${planList}`;

    const designDocContent = options?.designDocContent?.trim();
    const designDocLink = options?.designDocLink?.trim();

    if (designDocContent) {
        testerPrompt += `\n\nDESIGN DOC REFERENCE (pre-fetched from Notion):\nThe following is the full content of the project's design document / PRD. Use it as foundational context to verify adherence:\n\n${designDocContent}`;
    } else if (designDocLink) {
        testerPrompt += `\n\nDESIGN DOC REFERENCE:\nThe following design document provides the project's product requirements and specifications. Use it as foundational context to verify adherence:\n${designDocLink}`;
    }

    return applyPromptOverride(testerPrompt, planList, promptOverride);
}

export function columnToPromptRole(column: string): string | null {
    const normalized = column === 'CODED' ? 'LEAD CODED' : column;
    switch (normalized) {
        case 'CREATED': return 'planner';
        case 'PLAN REVIEWED': return 'lead';
        case 'TEAM LEAD CODED':
        case 'LEAD CODED':
        case 'CODER CODED':
        case 'INTERN CODED':
            return 'reviewer';
        case 'CODE REVIEWED':
            return 'tester';
        default:
            return column.startsWith('custom_agent_') ? column : null;
    }
}
```
- **Edge Cases Handled:** Keeps batch/board prompt generation aligned with the actual Kanban lifecycle and avoids dispatching tester prompts for already-completed tester-stage cards.

### 4. Sidebar Dispatch, Review Logs, and Role Routing
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** This file controls direct sidebar dispatch, column-to-role routing, next-column computation, visible-agent defaults, and review-log labeling.
- **Logic:**
  1. Add `tester` to `_targetColumnForRole()`.
  2. Add `ACCEPTANCE TESTED -> tester` to `_roleForKanbanColumn()`.
  3. Add `tester: false` to `getVisibleAgents()` defaults.
  4. Update `_getNextKanbanColumnForSession()` so `CODE REVIEWED` conditionally advances to `ACCEPTANCE TESTED` only when tester is visible **and** the design-doc feature is enabled; otherwise it remains terminal for disabled-by-default behavior.
  5. Add a `tester` branch in `_handleTriggerAgentActionInternal()` that blocks dispatch when `_isDesignDocEnabled()` is false, and passes both `designDocLink` and `designDocContent`.
  6. Change the workflow map from the draft's `reviewer-pass` shortcut to a dedicated tester event (`tester-pass`).
  7. Add `ACCEPTANCE TESTED: 'Acceptance Tester'` to `_getReviewLogEntries()` so review history remains legible.
  8. `ROLE_TO_PERSONA_FILE` already contains `tester`, so no new persona-file plumbing is required for this plan; do not add a persona dependency unless a separate persona-content plan is approved.
- **Implementation:**
```typescript
private _targetColumnForRole(role: string): string | null {
    switch (role) {
        case 'planner':
            return 'PLAN REVIEWED';
        case 'lead':
        case 'coder':
        case 'intern':
        case 'jules':
        case 'team':
        case 'team-lead':
            return this._codedColumnForRole(role);
        case 'reviewer':
            return 'CODE REVIEWED';
        case 'tester':
            return 'ACCEPTANCE TESTED';
        default:
            return role.startsWith('custom_agent_') ? role : null;
    }
}

private _roleForKanbanColumn(column: string): string | null {
    switch (this._normalizeLegacyKanbanColumn(column)) {
        case 'PLAN REVIEWED':
            return 'planner';
        case 'LEAD CODED':
            return 'lead';
        case 'CODER CODED':
            return 'coder';
        case 'INTERN CODED':
            return 'intern';
        case 'TEAM LEAD CODED':
            return 'team-lead';
        case 'CODE REVIEWED':
            return 'reviewer';
        case 'ACCEPTANCE TESTED':
            return 'tester';
        default:
            return column.startsWith('custom_agent_') ? column : null;
    }
}

public async getVisibleAgents(workspaceRoot?: string): Promise<Record<string, boolean>> {
    const defaults: Record<string, boolean> = {
        lead: true,
        coder: true,
        intern: true,
        reviewer: true,
        tester: false,
        planner: true,
        analyst: true,
        'team-lead': true,
        jules: true
    };
    // existing state merge stays unchanged
}

private async _getNextKanbanColumnForSession(
    currentColumn: string,
    sessionId: string,
    workspaceRoot: string,
    customAgents: CustomAgentConfig[]
): Promise<string | null> {
    const normalizedCurrent = this._normalizeLegacyKanbanColumn(currentColumn);
    switch (normalizedCurrent) {
        case 'CREATED':
            return 'PLAN REVIEWED';
        case 'PLAN REVIEWED':
            return this._targetColumnForRole(await this._resolvePlanReviewedDispatchRole(sessionId, workspaceRoot));
        case 'LEAD CODED':
        case 'CODER CODED':
        case 'INTERN CODED':
        case 'TEAM LEAD CODED':
            return 'CODE REVIEWED';
        case 'CODE REVIEWED': {
            const visibleAgents = await this.getVisibleAgents(workspaceRoot);
            return visibleAgents.tester !== false && this._isDesignDocEnabled()
                ? 'ACCEPTANCE TESTED'
                : null;
        }
        case 'ACCEPTANCE TESTED':
            return null;
        default: {
            const columnIds = buildKanbanColumns(customAgents).map(column => column.id);
            const currentIndex = columnIds.indexOf(normalizedCurrent);
            if (currentIndex < 0 || currentIndex >= columnIds.length - 1) {
                return null;
            }
            return columnIds[currentIndex + 1];
        }
    }
}

// New tester dispatch branch in _handleTriggerAgentActionInternal():
} else if (role === 'tester') {
    if (!this._isDesignDocEnabled()) {
        clearDispatchLock();
        vscode.window.showErrorMessage('Acceptance Tester requires a Design Doc / PRD to be enabled and attached in Setup.');
        return false;
    }

    messagePayload = buildKanbanBatchPrompt('tester', [dispatchPlan], {
        designDocLink: this._getDesignDocLink(),
        designDocContent: await this._getDesignDocContent(resolvedWorkspaceRoot) || undefined,
        defaultPromptOverrides: this._cachedDefaultPromptOverrides
    });
    messageMetadata.phase_gate = { enforce_persona: 'tester' };
}

const workflowMap: Record<string, string> = {
    'planner': 'sidebar-review',
    'reviewer': 'reviewer-pass',
    'tester': 'tester-pass',
    'lead': 'handoff-lead',
    'team-lead': 'handoff-lead',
    'coder': 'handoff',
    'intern': 'handoff',
    'jules': 'jules'
};

const columnRoleMap: Record<string, string> = {
    'CREATED': 'Planner',
    'PLAN REVIEWED': 'Planner',
    'LEAD CODED': 'Lead Coder',
    'TEAM LEAD CODED': 'Team Lead',
    'CODER CODED': 'Coder',
    'CODE REVIEWED': 'Reviewer',
    'ACCEPTANCE TESTED': 'Acceptance Tester'
};
```
- **Edge Cases Handled:** Prevents hidden-column dead ends, ensures non-Notion design-doc links still flow to the tester prompt, and keeps session audit history readable after the new stage is introduced.

### 5. Kanban Board Mappings and Batch Dispatch
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The Kanban provider maintains its own role/column maps, visible-agent defaults, workflow selection for batch advance, and prompt generation for batch copy/dispatch.
- **Logic:**
  1. Add `ACCEPTANCE TESTED -> tester` to all built-in role/column lookup tables (`roleFromColumn`, `_columnToRole`, `roleToCol`).
  2. Add `tester: false` to `_getVisibleAgents()` defaults so the board agrees with the sidebar defaults.
  3. Update the prompt-generation path so source column `CODE REVIEWED` generates tester prompts, including design-doc link/content.
  4. Update the workflow-selection path for source `CODE REVIEWED` so advancing from review-complete records `tester-pass`, not generic `handoff`.
  5. Because tester eligibility is conditional, convert the current source-column workflow selection into an eligibility-aware async helper that the existing call sites use before mutating runsheet history.
- **Implementation:**
```typescript
const roleFromColumn: Record<string, string> = {
    'TEAM LEAD CODED': 'team-lead',
    'LEAD CODED': 'lead',
    'CODER CODED': 'coder',
    'INTERN CODED': 'intern',
    'PLANNED': 'planner',
    'CODE REVIEWED': 'reviewer',
    'ACCEPTANCE TESTED': 'tester',
};

private async _getVisibleAgents(workspaceRoot: string): Promise<Record<string, boolean>> {
    const defaults: Record<string, boolean> = {
        lead: true,
        coder: true,
        intern: true,
        reviewer: true,
        tester: false,
        planner: true,
        analyst: true,
        'team-lead': true,
        jules: true
    };
    // existing state merge stays unchanged
}

private _columnToRole(column: string): string | null {
    switch (column) {
        case 'PLAN REVIEWED': return 'planner';
        case 'TEAM LEAD CODED': return 'team-lead';
        case 'LEAD CODED': return 'lead';
        case 'CODER CODED': return 'coder';
        case 'INTERN CODED': return 'intern';
        case 'CODED': return 'lead';
        case 'CODE REVIEWED': return 'reviewer';
        case 'ACCEPTANCE TESTED': return 'tester';
        case 'COMPLETED': return null;
        default: return column.startsWith('custom_agent_') ? column : null;
    }
}

const roleToCol: Record<string, string> = {
    'lead': 'LEAD CODED',
    'coder': 'CODER CODED',
    'intern': 'INTERN CODED',
    'team-lead': 'TEAM LEAD CODED',
    'planner': 'PLANNED',
    'reviewer': 'CODE REVIEWED',
    'tester': 'ACCEPTANCE TESTED',
};
```

```typescript
// Recommended correction to the source-column prompt/workflow path:
// 1. columnToPromptRole('CODE REVIEWED') now returns 'tester'
// 2. _generatePromptForColumn() must branch on role === 'tester'
// 3. reuse the same design-doc link/content loading pattern already used by _generateBatchPlannerPrompt()
// 4. replace the sync _workflowForColumn('CODE REVIEWED') -> 'handoff' behavior with an eligibility-aware async path that returns:
//    - 'tester-pass' when tester is active
//    - null / no advance when tester is inactive, so the board remains terminal at CODE REVIEWED
```
- **Edge Cases Handled:** Prevents the Kanban board from being the one place that still emits a generic handoff prompt from `CODE REVIEWED`, which would drift from both the sidebar dispatch logic and the derived-column history logic.

### 6. Setup, Sidebar, and Kanban UI Surfaces
#### [MODIFY] `src/webview/setup.html`
- **Context:** The prompt override UI for built-in roles lives here now, not in `implementation.html`.
- **Logic:** Add the Acceptance Tester role to `PROMPT_ROLES` so users can define tester-specific prompt overrides through the existing setup panel.
- **Implementation:**
```javascript
const PROMPT_ROLES = [
    { key: 'planner', label: 'Planner' },
    { key: 'lead', label: 'Lead Coder' },
    { key: 'coder', label: 'Coder' },
    { key: 'reviewer', label: 'Reviewer' },
    { key: 'tester', label: 'Acceptance Tester' },
    { key: 'intern', label: 'Intern' },
    { key: 'analyst', label: 'Analyst' },
];
```
- **Edge Cases Handled:** Prevents the role from existing in backend config while remaining impossible to customize in the current setup UI.

#### [MODIFY] `src/webview/implementation.html`
- **Context:** This file hardcodes nearly every built-in-role onboarding and visibility surface.
- **Logic:**
  1. Add a tester onboarding row in the `CONFIGURE CLI AGENTS` section, unchecked by default.
  2. Add a tester terminal-ops row in the `AGENT VISIBILITY & CLI COMMANDS` section, unchecked by default.
  3. Add `tester: false` to `lastVisibleAgents`.
  4. Add `tester` to the onboarding rehydration map so saved commands round-trip.
  5. Add `tester` to the onboarding save payload and default `visibleAgents`.
  6. Add `tester` to the onboarding "allRoles" guard list.
  7. Render an Acceptance Tester row in the sidebar agent list when visible, immediately after Reviewer.
- **Implementation:**
```html
<!-- Onboarding row -->
<div class="startup-row" style="display:flex; align-items:center; gap:6px;">
    <input type="checkbox" class="onboard-agent-toggle" data-role="tester"
        style="width:auto; margin:0; flex-shrink:0;">
    <label style="min-width:70px;">Acceptance Tester</label><input type="text" id="onboard-cli-tester"
        placeholder="e.g. copilot --allow-all-tools" style="flex:1;">
</div>
```

```html
<!-- Terminal operations row -->
<div class="startup-row" style="display:flex; align-items:center; gap:6px;">
    <input type="checkbox" class="agent-visible-toggle" data-role="tester"
        style="width:auto; margin:0; flex-shrink:0;">
    <label style="min-width:70px;">Acceptance Tester</label><input type="text" data-role="tester"
        placeholder="e.g. copilot --allow-all-tools" style="flex:1;">
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
    jules: true
};

const onboardingFields = {
    lead: document.getElementById('onboard-cli-lead'),
    coder: document.getElementById('onboard-cli-coder'),
    reviewer: document.getElementById('onboard-cli-reviewer'),
    tester: document.getElementById('onboard-cli-tester'),
    planner: document.getElementById('onboard-cli-planner'),
    analyst: document.getElementById('onboard-cli-analyst')
};

const allRoles = [
    ...(va.planner !== false ? ['planner'] : []),
    ...(va.lead !== false ? ['lead'] : []),
    ...(va.coder !== false ? ['coder'] : []),
    ...(va.intern !== false ? ['intern'] : []),
    ...(va.reviewer !== false ? ['reviewer'] : []),
    ...(va.tester !== false ? ['tester'] : []),
    ...(va.analyst !== false ? ['analyst'] : []),
    ...lastCustomAgents.filter(a => va[a.role] !== false).map(a => a.role)
];

const agents = {
    lead: document.getElementById('onboard-cli-lead').value,
    coder: document.getElementById('onboard-cli-coder').value,
    intern: document.getElementById('onboard-cli-intern').value,
    reviewer: document.getElementById('onboard-cli-reviewer').value,
    tester: document.getElementById('onboard-cli-tester').value,
    planner: document.getElementById('onboard-cli-planner').value,
    analyst: document.getElementById('onboard-cli-analyst').value
};

const visibleAgents = {
    lead: true,
    coder: true,
    intern: true,
    reviewer: true,
    tester: false,
    planner: true,
    analyst: true,
    jules: true
};
```

```javascript
// Sidebar row, immediately after Reviewer:
if (va.tester !== false) {
    agentListStandard.appendChild(createAgentRow('ACCEPTANCE TESTER', 'tester',
        'TEST REQUIREMENTS',
        terminals => Object.keys(terminals).find(key => terminals[key].role === 'tester')
    ));
}
```
- **Edge Cases Handled:** Avoids the partial-visibility bug where a role appears in the Kanban board or dispatch maps but is missing from onboarding, persistence, or the live sidebar.

#### [MODIFY] `src/webview/kanban.html`
- **Context:** The Kanban webview maintains its own last-known visible-agent defaults.
- **Logic:** Add `tester: false` to the default `lastVisibleAgents` object so hidden-by-default behavior matches the providers and sidebar.
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
    jules: true
};
```
- **Edge Cases Handled:** Prevents the Kanban board from showing the Acceptance Tester column or agent row by default while the sidebar still considers the role hidden.

### 7. Regression Tests
#### [MODIFY] `src/test/builtin-role-dispatch-coverage.test.js`
- **Context:** This test hardcodes the expected built-in roles and dispatch branches.
- **Logic:** Add `tester` to the expected built-in role list and assert there is a dedicated tester dispatch branch plus `workflowMap['tester'] = 'tester-pass'`.
- **Implementation:** Extend the existing role loop and add a tester-specific assertion parallel to the current intern/team-lead checks.
- **Edge Cases Handled:** Prevents future refactors from adding the role to config but forgetting sidebar dispatch.

#### [MODIFY] `src/test/kanban-complexity.test.ts`
- **Context:** This file already checks `_columnToRole()` for a built-in coded column.
- **Logic:** Add an assertion that `_columnToRole('ACCEPTANCE TESTED') === 'tester'`.
- **Implementation:** Add a new test alongside the existing `_columnToRole maps INTERN CODED to intern` case.
- **Edge Cases Handled:** Locks down the provider-side mapping used by Kanban dispatch and alias resolution.

#### [MODIFY] `src/test/kanban-backward-reset-regression.test.js`
- **Context:** Manual move/reset derivation is already regression-tested for `CODE REVIEWED` and custom columns.
- **Logic:** Add `reset-to-acceptance-tested` and `move-to-acceptance-tested` expectations.
- **Implementation:** Mirror the existing code-reviewed assertions with the new acceptance-tested slug.
- **Edge Cases Handled:** Ensures manual stage adjustments do not lose the tester column after refresh.

#### [MODIFY] `src/test/review-ticket-column-persistence-regression.test.js`
- **Context:** Review-ticket column persistence checks rely on `deriveKanbanColumn()`.
- **Logic:** Add a forward or backward acceptance-tested case so ticket-view column edits survive reload for the new stage.
- **Implementation:** Add one more `deriveKanbanColumn([{ workflow: 'move-to-acceptance-tested' }], []) === 'ACCEPTANCE TESTED'` assertion.
- **Edge Cases Handled:** Keeps the ticket view aligned with the Kanban board after manual column changes.

#### [MODIFY] `src/test/kanban-state-filter-regression.test.js` and `src/test/kanban-mcp-state.test.js`
- **Context:** These tests hardcode the currently exposed built-in column lists and user-facing labels.
- **Logic:** Add `ACCEPTANCE TESTED` / `Acceptance Tested` to the expected built-in board ordering and column-resolution assertions.
- **Implementation:** Update the `availableColumns` arrays, expected `Object.keys(payload)` arrays, and label assertions.
- **Edge Cases Handled:** Prevents MCP / Kanban filtering regressions where the board knows about the new column but the public tool layer still treats it as unknown.

#### [MODIFY] `src/test/split-coded-columns-regression.test.js`
- **Context:** This regression test hardcodes the built-in Kanban column definition order.
- **Logic:** Insert the new tester-stage column after `CODE REVIEWED` in the expected regex.
- **Implementation:** Update the regex so the default built-in column set explicitly includes `{ id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested', role: 'tester', ... }`.
- **Edge Cases Handled:** Prevents silent regressions in built-in board ordering when new built-in columns are added.

#### [NO CHANGE] `src/test/send-team-message.test.js`
- **Context:** This file already contains a `tester -> tester.md` persona mapping in its inline simulation.
- **Logic:** No implementation change is required for this plan unless the persona file policy itself changes.
- **Implementation:** Leave unchanged; use it only as confirmation that tester is already recognized in ancillary persona-resolution code.
- **Edge Cases Handled:** Avoids unnecessary scope expansion into persona-content work.

## Verification Plan
### Automated Tests
- Run `npx tsc --noEmit`.
- Run `npm run compile`.
- Run `node src/test/builtin-role-dispatch-coverage.test.js`.
- Run `node src/test/kanban-backward-reset-regression.test.js`.
- Run `node src/test/review-ticket-column-persistence-regression.test.js`.
- Run `node src/test/kanban-state-filter-regression.test.js`.
- Run `node src/test/kanban-mcp-state.test.js`.
- Run `node src/test/split-coded-columns-regression.test.js`.
- If `src/test/kanban-complexity.test.ts` is updated, build test output with `npx tsc -p tsconfig.test.json` and run the compiled test artifact from `out/test/`.

### Manual Checks
- Confirm Acceptance Tester is hidden on a clean workspace before any setup changes.
- Enable Acceptance Tester without enabling the Design Doc / PRD feature; verify reviewer -> tester dispatch is blocked with a clear error and cards do not advance into a hidden/stuck state.
- Enable both Acceptance Tester and Design Doc / PRD; confirm reviewer-complete plans advance to `ACCEPTANCE TESTED`, the tester prompt includes PRD context, and refresh/reload preserves the new column.
- Use manual Kanban move/reset actions to move a card into and out of `ACCEPTANCE TESTED`; confirm the column survives refresh.
- Confirm the timer pipeline sends reviewer-complete plans to Acceptance Tester only when the feature is active and otherwise treats `CODE REVIEWED` as terminal.

**Recommended Agent:** Send to Lead Coder

## Review Pass (2026-04-11)

### Findings

#### MAJOR-1 (FIXED): Copy-prompt auto-advance bypasses tester eligibility gate
- **File:** `src/services/TaskViewerProvider.ts` — `_handleCopyPlanLink()` (line ~7379)
- **Issue:** `columnToPromptRole('CODE REVIEWED')` returns `'tester'` unconditionally. The `workflowName` ternary emitted `'tester-pass'` and auto-advanced the card to `ACCEPTANCE TESTED` without checking `_isAcceptanceTesterActive()`. All other dispatch paths (sidebar, batch, pipeline, Kanban board) properly gate on eligibility. This path silently moved cards into a hidden column when the tester was disabled.
- **Fix:** Added `const isTesterEligible = ... && await this._isAcceptanceTesterActive(resolvedWorkspaceRoot)` guard before the `workflowName` ternary. Auto-advance from `CODE REVIEWED` now only occurs when the tester role is visible AND the design doc is configured.

#### NIT-1: `_workflowForColumn` in KanbanProvider is dead code
- **File:** `src/services/KanbanProvider.ts` — line 1094
- **Status:** Deferred. Defined but never called. Harmless; can be cleaned up or integrated in a future pass.

#### NIT-2: Copy-prompt generates tester-flavored text when tester disabled
- **File:** `src/services/TaskViewerProvider.ts` — line 7350
- **Status:** Deferred. `columnToPromptRole('CODE REVIEWED')` returns `'tester'` regardless of feature state. Cosmetic since the auto-advance (the real danger) is now gated.

#### NIT-3: Copy-prompt omits `designDocContent` for tester prompt
- **File:** `src/services/TaskViewerProvider.ts` — line 7369
- **Status:** Deferred. Only `designDocLink` is passed; the pre-fetched Notion content available in the dispatch path is absent. Low priority since primary dispatch paths are correct.

#### NIT-4: `ACCEPTANCE TESTED` not in `_workflowForColumn` switch
- **File:** `src/services/KanbanProvider.ts` — line 1094
- **Status:** Deferred. Falls to default `'handoff'`. Non-functional since `_workflowForColumn` itself is dead code (NIT-1).

### Files Changed During Review
- `src/services/TaskViewerProvider.ts` — Added `_isAcceptanceTesterActive` eligibility check in `_handleCopyPlanLink` copy-prompt auto-advance path (MAJOR-1 fix).

### Validation Results
- `npx tsc --noEmit` — ✅ Pass (pre-existing unrelated `ArchiveManager` import warning only)
- `npm run compile` — ✅ Pass (webpack compiled successfully)
- `node src/test/builtin-role-dispatch-coverage.test.js` — ✅ 8/8 passed
- `node src/test/kanban-backward-reset-regression.test.js` — ✅ Passed
- `node src/test/review-ticket-column-persistence-regression.test.js` — ✅ Passed
- `node src/test/kanban-state-filter-regression.test.js` — ✅ 4/4 passed
- `node src/test/kanban-mcp-state.test.js` — ✅ 3/3 passed
- `node src/test/split-coded-columns-regression.test.js` — ✅ Passed
- `npx tsc -p tsconfig.test.json` — ✅ Compiled (kanban-complexity.test.ts requires VS Code host to run; type-check confirms correctness)

### Remaining Risks
- **Manual testing required:** Copy-prompt path for `CODE REVIEWED` with tester disabled should be verified to confirm the card no longer auto-advances.
- **NITs deferred:** Dead `_workflowForColumn`, tester prompt flavor on clipboard when disabled, missing `designDocContent` in copy path — all low-impact cosmetic issues.
- **No persona file:** `tester.md` does not exist in `.agent/personas/` — the loader fails open (returns `undefined`), which is noted in the plan and not a blocker. A separate persona-content plan would be needed.

## Preserved Draft Implementation Snippets (Historical Context Only)
> [!NOTE]
> The following blocks are retained so the original implementation steps and code snippets are not lost. Where they disagree with the corrected plan above, the corrected plan above is authoritative.

### 1. Data Model & Column Definition
#### [MODIFY] `src/services/agentConfig.ts`
Add the `tester` role to the core configuration types and columns.

**Implementation:**
```typescript
// 1. Expand BuiltInAgentRole
export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'tester' | 'planner' | 'analyst' | 'team-lead';

// 2. Add to BUILT_IN_AGENT_LABELS
export const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    tester: 'Acceptance Tester',
    planner: 'Planner',
    analyst: 'Analyst',
    'team-lead': 'Team Lead'
};

// 3. Add to DEFAULT_KANBAN_COLUMNS (Order 350 places it between CODE REVIEWED and COMPLETED )
    { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', autobanEnabled: false, dragDropMode: 'cli' },
    { id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested', role: 'tester', order: 350, kind: 'reviewed', autobanEnabled: false, dragDropMode: 'cli', hideWhenNoAgent: true },
    { id: 'COMPLETED', label: 'Completed', order: 9999, kind: 'completed', autobanEnabled: false, dragDropMode: 'cli' },

// 4. Add to VALID_ROLES in parseDefaultPromptOverrides
const VALID_ROLES: BuiltInAgentRole[] = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'team-lead'];
```

### 2. State Validation
#### [MODIFY] `src/services/planStateUtils.ts`
Add the column to the valid set to ensure imports and saves aren't corrupted.

**Implementation:**
Add `'ACCEPTANCE TESTED'` to the `VALID_COLUMNS` Set (around line 10).

### 3. Prompt Builder
#### [MODIFY] `src/services/agentPromptBuilder.ts`
Implement the specific prompt format for the Acceptance Tester.

**Implementation:**
```typescript
// Inside buildKanbanBatchPrompt() add the new branch:
if (role === 'tester') {
    let testerPrompt = `check the code against the relevant sections of the prd and advise if it complies.\n
${batchExecutionRules}
${focusDirective}${GIT_PROHIBITION_DIRECTIVE}

PLANS TO PROCESS:
${planList}`;

    const designDocContent = options?.designDocContent?.trim();
    const designDocLink = options?.designDocLink?.trim();

    if (designDocContent) {
        testerPrompt += `\n\nDESIGN DOC REFERENCE (pre-fetched from Notion):\nThe following is the full content of the project's design document / PRD. Use it as foundational context to verify adherence:\n\n${designDocContent}`;
    } else if (designDocLink) {
        testerPrompt += `\n\nDESIGN DOC REFERENCE:\nThe following design document provides the project's product requirements and specifications. Use it as foundational context to verify adherence:\n${designDocLink}`;
    }

    return applyPromptOverride(testerPrompt, planList, promptOverride);
}

// In columnToPromptRole(), add the case:
case 'ACCEPTANCE TESTED':
    return 'tester';
```

### 4. Kanban Provider Maps
#### [MODIFY] `src/services/KanbanProvider.ts`
Update routing maps for the new column.

**Implementation:**
```typescript
// In _columnToRole()
case 'ACCEPTANCE TESTED': return 'tester';

// In roleFromColumn
'ACCEPTANCE TESTED': 'tester',

// In _workflowForColumn
case 'ACCEPTANCE TESTED': return 'review';

// In roleToCol
'tester': 'ACCEPTANCE TESTED',
```

### 5. Task Viewer Provider Logic
#### [MODIFY] `src/services/TaskViewerProvider.ts`
Wire up the Kanban column flow and the dispatch guard.

**Implementation:**
```typescript
// 1. In _targetColumnForRole()
case 'tester': return 'ACCEPTANCE TESTED';

// 2. In _roleForKanbanColumn()
case 'ACCEPTANCE TESTED': return 'tester';

// 3. In columnRoleMap
'ACCEPTANCE TESTED': 'Acceptance Tester',

// 4. In _getNextKanbanColumnForSession(), update the CODE REVIEWED case to conditionally route:
case 'CODE REVIEWED': {
    const visibleAgents = await this.getVisibleAgents(workspaceRoot);
    return visibleAgents.tester !== false ? 'ACCEPTANCE TESTED' : null;
}
case 'ACCEPTANCE TESTED':
    return null;

// 5. In _handleTriggerAgentActionInternal(), add the dispatch block:
} else if (role === 'tester') {
    if (!this._isDesignDocEnabled()) {
        vscode.window.showErrorMessage('Acceptance Tester requires a Design Doc / PRD to be enabled and attached in Setup.');
        clearDispatchLock();
        return false;
    }
    
    messagePayload = buildKanbanBatchPrompt('tester', [dispatchPlan], {
        designDocLink: this._getDesignDocLink(),
        designDocContent: await this._getDesignDocContent(resolvedWorkspaceRoot) || undefined,
        defaultPromptOverrides: this._cachedDefaultPromptOverrides
    });
    messageMetadata.phase_gate = { enforce_persona: 'tester' };

// 6. In workflowMap inside _handleTriggerAgentActionInternal
'tester': 'reviewer-pass',
```

### 6. Webview UI Setup
#### [MODIFY] `src/webview/implementation.html`
Add the tester to the configuration UI, defaulting to false.

**Implementation:**
```javascript
// 1. In PROMPT_ROLES array
{ key: 'tester', label: 'Acceptance Tester' },

// 2. In lastVisibleAgents object literal (default to false because it requires PRD)
let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, tester: false, analyst: true, 'team-lead': true, jules: true };
```

```html
<!-- 3. Add to Onboarding section (around line 1520), note the ABSENCE of 'checked' attribute -->
<div class="startup-row" style="display:flex; align-items:center; gap:6px;">
    <input type="checkbox" class="onboard-agent-toggle" data-role="tester" 
        style="width:auto; margin:0; flex-shrink:0;">
    <label style="min-width:70px;">Acceptance Tester</label><input type="text" id="onboard-cli-tester" 
        placeholder="e.g. claude --allow-all-tools" style="flex:1;">
</div>

<!-- 4. Add to Main Setup section (around line 1660), note ABSENCE of 'checked' -->
<div class="startup-row" style="display:flex; align-items:center; gap:6px;">
    <input type="checkbox" class="agent-visible-toggle" data-role="tester" 
        style="width:auto; margin:0; flex-shrink:0;">
    <label style="min-width:70px;">Acceptance Tester</label><input type="text" data-role="tester" 
        placeholder="e.g. claude --allow-all-tools" style="flex:1;">
</div>
```
*(Also add to `lastVisibleAgents` defaults in `src/webview/kanban.html`)*
