# Plan: Remove Ollama, Orchestration, and Team Lead Features

## Goal
Remove the Ollama integration, Orchestration framework integration, and Team Lead agent role from the codebase. These features are not well-aligned with the core plugin purpose and add unnecessary complexity.

## Metadata
**Tags:** backend, frontend, database, workflow, reliability
**Complexity:** 7

## User Review Required
- [ ] Confirm that existing `state.json` entries for `team-lead`, `ollama`, and `orchestration` can remain as orphaned (harmless, silently ignored after removal)
- [ ] Confirm that `PipelineOrchestrator` (distinct from `InteractiveOrchestrator`) should be KEPT — it is used for ClickUp/Linear automation pipelines, not the removed Orchestration tab feature
- [ ] Confirm no external consumers depend on the Ollama MCP tool endpoints

## Rationale
- The Ollama integration (local/cloud LLM management) is outside the scope of this VS Code extension
- The Orchestration framework integration with Team Lead role is over-complex for the plugin's actual use cases
- Removing these features will simplify the codebase, reduce maintenance burden, and improve clarity

## Complexity Audit

### Routine
- **Delete standalone service files**: `src/services/OllamaSetupService.ts` (643 lines), `src/services/InteractiveOrchestrator.ts` (282 lines) — pure deletion, no downstream logic
- **Delete test files**: `src/test/ollama-setup-service-regression.test.js`, `src/test/interactive-orchestrator.test.ts`, `src/test/team-lead-visibility-defaults-regression.test.js`, `src/test/team-lead-routing-options-regression.test.js` — pure deletion
- **Remove `team-lead` from `BuiltInAgentRole` type and `BUILT_IN_AGENT_LABELS`** in `src/services/agentConfig.ts` (L1, L48) — single-line edits
- **Remove `TEAM LEAD CODED` from `DEFAULT_KANBAN_COLUMNS`** in `src/services/agentConfig.ts` (L55) — single-line deletion
- **Remove `team-lead` from `VALID_ROLES` in `parseDefaultPromptOverrides`** in `src/services/agentConfig.ts` (L287) — single-line edit
- **Remove Ollama/Orchestration tab HTML** from `src/webview/setup.html` (L507-509 tab buttons, L557-586 Ollama section, L602-626 Orchestration section)
- **Remove Ollama/Orchestration JS handlers** from `src/webview/setup.html` (L1269-1285 element references, plus all associated event listeners)
- **Remove `team-lead` from kanban.html** (L1780 agent list entry, L2098 visible agents defaults)
- **Update test expectations** in `src/test/builtin-role-dispatch-coverage.test.js` and `src/test/agent-prompt-builder-subagents.test.js` — remove `team-lead` from expected roles
- **Remove Ollama imports from `extension.ts`** — straightforward import removal

### Complex / Risky
- **TaskViewerProvider Ollama excision** (~16,000-line file): Must remove 6+ handler methods (`handleGetOllamaSetupState` L3229, `handleOpenOllamaInstall` L3246, `handleOllamaSignIn` L3255, `handleOllamaSignOut` L3269, `handleOllamaPullModel` L3283, `_getOllamaService` L4678), the `_ollamaServices` Map (L333), plus helper methods `_findOllamaModel`, `_getOllamaInternConfig`, `_buildUnavailableOllamaSetupState`, and all Ollama message case branches in `_handleMessage`. Missing any one causes runtime errors when the webview sends orphaned messages.
- **SetupPanelProvider message handlers**: Must remove `getOllamaStatus` (L370), `openOllamaInstall` (L375), `ollamaSignIn` (L380), `setOllamaInternModel` (L386), `getTeamLeadRoutingSettings` (L444) case branches. If the UI cleanup removes the buttons but these handlers remain, they're dead code; if the UI cleanup is incomplete, they'll crash.
- **KanbanProvider team-lead routing removal**: 8 touch points — `resolveRoutedRole()` return type (L539), `_teamLeadComplexityCutoff`/`_teamLeadKanbanOrder` fields (L146-147, L263-264), `getTeamLeadRoutingSettings()` (L353), `setTeamLeadComplexityCutoff()` (L361), `setTeamLeadKanbanOrder()` (L371), `_partitionByComplexityRoute()` team-lead group (L3233), `_targetColumnForDispatchRole()` team-lead branch (L3286), `_columnToRole()` TEAM LEAD CODED (L5022), `_getVisibleAgents()` defaults (L2645), `_getDefaultPromptPreviews()` roles list (L2147), `_resolveComplexityRoutedRole()` return type (L3167). Must also update return types from `'lead' | 'coder' | 'intern' | 'team-lead'` to `'lead' | 'coder' | 'intern'`.
- **State migration**: Existing `state.json` files may contain `startupCommands.team-lead`, `visibleAgents.team-lead`, and `kanban.orderOverrides['TEAM LEAD CODED']`. These become orphaned but are silently ignored after the code changes. No migration script needed, but release notes should mention it.

## Edge-Case & Dependency Audit

- **Race Conditions**: None — this is a removal, not a concurrent modification
- **Security**: Removing Ollama sign-in/auth handlers reduces attack surface (credentials no longer flow through the extension)
- **Side Effects**: `PipelineOrchestrator` (used for ClickUp/Linear automation) must NOT be deleted — it is a separate class from `InteractiveOrchestrator`. The `pipeline-orchestrator-regression.test.js` tests `PipelineOrchestrator` and should be KEPT.
- **Dependencies & Conflicts**: Cross-plan conflict with `auto_export_kanban_state_to_file.md` — that plan adds `_workspaceRoot` to `KanbanDatabase.forWorkspace()`. This plan does not touch `KanbanDatabase.ts`, so no direct conflict. However, removing `TEAM LEAD CODED` from `DEFAULT_KANBAN_COLUMNS` affects the column list that `exportStateToFile()` would iterate — the auto-export plan should run AFTER this removal to avoid exporting a now-nonexistent column.
- **Custom agents**: Users who created custom agents referencing `team-lead` will need to update their configurations. This should be documented in release notes.

## Dependencies
- `auto_export_kanban_state_to_file` — This plan should execute BEFORE the auto-export plan, so the exported state doesn't include the `TEAM LEAD CODED` column. No code-level conflict (different files), but execution order matters.

## Adversarial Synthesis
Key risks: (1) Incomplete excision from TaskViewerProvider (16K-line file) leaving dead message handlers that crash on orphaned webview messages; (2) KanbanProvider has 8+ team-lead touch points beyond the 2 fields listed — missing any causes TypeScript compile errors or runtime routing failures; (3) SetupPanelProvider message handlers completely missed in original plan. Mitigations: Grep-driven removal (search all `ollama|Ollama|team-lead|teamLead|TeamLead|orchestrat` references), TypeScript compiler as safety net, sequential phase execution (service layer → UI → tests).

---

## Phase 1: Setup Panel UI Cleanup

### 1.1 Remove Ollama Tab from setup.html
**File**: `src/webview/setup.html`

**Actions**:
1. Remove the "Ollama" tab button from the tab navigation:
   ```html
   <button class="tab-btn" data-tab="ollama" role="tab" aria-selected="false">Ollama</button>
   ```

2. Remove the entire Ollama section (startup-section containing ollama-toggle and ollama-fields)

3. Remove the `.ollama-status-line` CSS class if not used elsewhere

### 1.2 Remove Orchestration Tab from setup.html
**File**: `src/webview/setup.html`

**Actions**:
1. Remove the "Orchestration" tab button:
   ```html
   <button class="tab-btn" data-tab="orchestration" role="tab" aria-selected="false">Orchestration</button>
   ```

2. Remove the entire Orchestration Framework Integration section containing:
   - TEAM LEAD (OPENCODE) subsection
   - Team Lead enable toggle
   - Team Lead startup command input
   - Team Lead complexity cutoff slider

### 1.3 Remove Team Lead from Kanban Structure
**File**: `src/webview/setup.html`

**Actions**:
1. Remove any Team Lead kanban column configuration UI elements
2. Update tab order if needed

---

## Phase 2: Service Layer Cleanup

### 2.1 Delete OllamaSetupService
**File**: `src/services/OllamaSetupService.ts`

**Actions**:
- Delete the entire file (643 lines)

### 2.2 Delete InteractiveOrchestrator
**File**: `src/services/InteractiveOrchestrator.ts`

**Actions**:
- Delete the entire file (282 lines)
- **IMPORTANT**: Do NOT delete `PipelineOrchestrator.ts` — it is a separate class used for ClickUp/Linear automation

### 2.3 Remove Ollama from TaskViewerProvider
**File**: `src/services/TaskViewerProvider.ts` (~16,000 lines)

**Actions**:
1. Remove OllamaSetupService import block (L43-51):
   ```typescript
   import {
       OllamaSetupService,
       DEFAULT_OLLAMA_CLAUDE_MODEL,
       OLLAMA_CLOUD_BASE_URL,
       OLLAMA_LOCAL_BASE_URL,
       type OllamaInternConfig as ImportedOllamaInternConfig,
       type OllamaMode,
       type OllamaSetupState as ImportedOllamaSetupState
   } from './OllamaSetupService';
   ```
2. Remove `_ollamaServices` Map field (L333): `private _ollamaServices: Map<string, OllamaSetupService> = new Map();`
3. Remove handler methods:
   - `handleGetOllamaSetupState()` (L3229-3244)
   - `handleOpenOllamaInstall()` (L3246-3253)
   - `handleOllamaSignIn()` (L3255-3267)
   - `handleOllamaSignOut()` (L3269-3281)
   - `handleOllamaPullModel()` (L3283-3312)
   - `_getOllamaService()` (L4678-4687)
4. Remove helper methods (search for these by name):
   - `_findOllamaModel()`
   - `_getOllamaInternConfig()`
   - `_buildUnavailableOllamaSetupState()`
   - `handleSetOllamaInternModel()`
5. Remove all Ollama-related `case` branches in `_handleMessage` switch statement (search for `'ollama'`, `'getOllamaStatus'`, `'openOllamaInstall'`, `'ollamaSignIn'`, `'setOllamaInternModel'`)
6. Remove any Ollama-related type definitions referenced only by Ollama code (e.g., `OllamaInternConfig`, `OllamaSetupState` if defined locally)

### 2.4 Remove Orchestration from TaskViewerProvider
**File**: `src/services/TaskViewerProvider.ts`

**Actions**:
1. Remove InteractiveOrchestrator import (search for `from './InteractiveOrchestrator'`)
2. Remove orchestrator state management fields (search for `_orchestrat`)
3. Remove orchestration-related message handlers in `_handleMessage` (search for `'orchestrat'` case branches)
4. Remove team-lead complexity cutoff handling in message handlers

### 2.5 Remove Team Lead from KanbanProvider
**File**: `src/services/KanbanProvider.ts` (~5,130 lines)

**Actions**:
1. Remove `_teamLeadComplexityCutoff` private field (L146)
2. Remove `_teamLeadKanbanOrder` private field (L147)
3. Remove workspace state initialization for these fields (L263-264):
   ```typescript
   this._teamLeadComplexityCutoff = this._context.workspaceState.get<number>('kanban.teamLeadComplexityCutoff', 0);
   this._teamLeadKanbanOrder = this._context.workspaceState.get<number>('kanban.teamLeadKanbanOrder', 170);
   ```
4. Remove `getTeamLeadRoutingSettings()` method (L353-358)
5. Remove `setTeamLeadComplexityCutoff()` method (L361-369)
6. Remove `setTeamLeadKanbanOrder()` method (L371-378)
7. Update `_getEffectiveKanbanOrderOverrides()` (L399-407) — remove `TEAM LEAD CODED` override logic
8. Update `resolveRoutedRole()` return type (L539) from `'lead' | 'coder' | 'intern' | 'team-lead'` to `'lead' | 'coder' | 'intern'`, and remove the team-lead cutoff branch (L540-542)
9. Update `_resolveComplexityRoutedRole()` return type (L3167) similarly
10. Update `_partitionByComplexityRoute()` (L3229-3237) — remove `team-lead` group from Map initialization and partitioning logic
11. Update `_targetColumnForDispatchRole()` (L3285-3288) — remove `team-lead` branch, update return type
12. Update `_columnToRole()` (L5019-5025) — remove `TEAM LEAD CODED` case
13. Update `_getVisibleAgents()` defaults (L2645) — remove `'team-lead': false`
14. Update `_getDefaultPromptPreviews()` roles list (L2147) — remove `'team-lead'`
15. Update `_resolveComplexityRoutedRole()` (L3167) — remove `'team-lead'` from return type
16. Remove `TEAM LEAD CODED` from `roleToCol` mapping in dispatch recording (L3373-3377)

### 2.6 Remove Team Lead from agentConfig.ts
**File**: `src/services/agentConfig.ts`

**Actions**:
1. Remove 'team-lead' from BuiltInAgentRole type (L1):
   ```typescript
   export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'tester' | 'planner' | 'analyst'; // removed 'team-lead'
   ```
2. Remove 'team-lead' entry from BUILT_IN_AGENT_LABELS (L48):
   ```typescript
   'team-lead': 'Team Lead'  // REMOVE THIS
   ```
3. Remove TEAM LEAD CODED column from DEFAULT_KANBAN_COLUMNS (L55):
   ```typescript
   { id: 'TEAM LEAD CODED', label: 'Team Lead', role: 'team-lead', order: 170, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
   ```
4. Remove 'team-lead' from VALID_ROLES in parseDefaultPromptOverrides (L287):
   ```typescript
   const VALID_ROLES: BuiltInAgentRole[] = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst']; // removed 'team-lead'
   ```
5. Remove 'Team Lead' from `getReservedAgentNames()` (L267): change `'Team'` entry handling if needed

### 2.7 Update SetupPanelProvider
**File**: `src/services/SetupPanelProvider.ts`

**Actions**:
1. Remove `getOllamaStatus` case branch (L370-373)
2. Remove `openOllamaInstall` case branch (L375-378)
3. Remove `ollamaSignIn` case branch (L380-384)
4. Remove `setOllamaInternModel` case branch (L386-395)
5. Remove `getTeamLeadRoutingSettings` case branch (L444-447)
6. Search for any remaining `ollama|Ollama|team-lead|teamLead|TeamLead|orchestrat` references and remove

---

## Phase 3: Webview JavaScript Cleanup

### 3.1 Remove Ollama JavaScript from setup.html
**File**: `src/webview/setup.html`

**Actions**:
Remove all Ollama-related JavaScript including:
- Ollama status update handlers
- Ollama tab switching logic
- Ollama install/signin button handlers
- Ollama intern configuration (use-gemma-cloud checkbox)

### 3.2 Remove Orchestration JavaScript from setup.html
**File**: `src/webview/setup.html`

**Actions**:
Remove all orchestration-related JavaScript including:
- Team Lead visibility toggle handler
- Team Lead command input handler
- Team Lead complexity cutoff slider handler
- Tab switching for orchestration tab

### 3.3 Remove Team Lead References from implementation.html
**File**: `src/webview/implementation.html`

**Actions**:
1. Search and remove team-lead related JavaScript handlers
2. Remove team-lead column rendering logic
3. Remove team-lead specific agent list entries

### 3.4 Remove Team Lead from kanban.html
**File**: `src/webview/kanban.html`

**Actions**:
Remove team-lead specific kanban column rendering and configuration

---

## Phase 4: Test Cleanup

### 4.1 Delete Ollama Tests
**Files to Delete**:
- `src/test/ollama-setup-service-regression.test.js`

### 4.2 Delete Orchestrator Tests
**Files to Delete**:
- `src/test/interactive-orchestrator.test.ts`
- **KEEP** `src/test/pipeline-orchestrator-regression.test.js` — this tests `PipelineOrchestrator` (ClickUp/Linear automation), NOT `InteractiveOrchestrator`

### 4.3 Delete Team Lead Tests
**Files to Delete**:
- `src/test/team-lead-visibility-defaults-regression.test.js`
- `src/test/team-lead-routing-options-regression.test.js`
- `src/test/pair-programming-routing-bypass.test.ts` — only if it is team-lead specific; review content first

### 4.4 Update Built-in Role Dispatch Tests
**File**: `src/test/builtin-role-dispatch-coverage.test.js`

**Actions**:
1. Remove `team-lead` from expected roles in `DEFAULT_KANBAN_COLUMNS` test (L81)
2. Remove the `team-lead dispatch prompt` test (L120-126)
3. Remove `team-lead` from `_workflowNameForDispatchRole` test (L136-151)

### 4.5 Update Agent Prompt Builder Tests
**File**: `src/test/agent-prompt-builder-subagents.test.js`

**Actions**:
Remove `team-lead` from expected roles

---

## Phase 5: Extension.ts Cleanup

### 5.1 Remove Feature References
**File**: `src/extension.ts`

**Actions**:
1. Remove OllamaSetupService import
2. Remove InteractiveOrchestrator import
3. Remove feature service instantiation if present
4. Remove any feature-specific command registrations
5. Remove `teamLeadCommand` extraction and conditional agent push (L2817-2828):
   ```typescript
   const teamLeadCommand = (startupCommands['team-lead'] || '').trim();
   // ...
   if (visibleAgents['team-lead'] === true && teamLeadCommand) {
       allBuiltInAgents.push({ name: 'Team Lead', role: 'team-lead' });
   }
   ```

---

## Phase 6: MCP Server Cleanup

### 6.1 Update MCP Registration
**File**: `src/mcp-server/register-tools.js`

**Actions**:
1. The `orchestrator` name is used as a default sender in `getSenderWorkflowContext()` (L209) — this is a generic fallback name, NOT the InteractiveOrchestrator feature. **Do NOT remove this.**
2. Search for any orchestration-specific tool registrations (tool names containing `orchestrat` or `team-lead`) and remove them
3. Search for any Ollama-specific tool registrations and remove them

---

## Phase 7: Rebuild and Verification

### 7.1 Clean Build
```bash
cd /Users/patrickvuleta/Documents/GitHub/switchboard
rm -rf out dist
npm run compile
```

### 7.2 Verify No References Remain
Run grep to ensure no stray references:
```bash
grep -r "OllamaSetupService\|OllamaMode\|OllamaInternConfig" src/ --include="*.ts" --include="*.js"
grep -r "InteractiveOrchestrator" src/ --include="*.ts" --include="*.js"
grep -r "team-lead\|teamLead\|TeamLead" src/ --include="*.ts" --include="*.js"
```

### 7.3 Extension Test
1. Run the extension in debug mode
2. Verify Setup panel opens without errors
3. Verify no Ollama tab is visible
4. Verify no Orchestration tab is visible
5. Verify Kanban board loads without Team Lead column

---

## Files to Delete Summary

| File | Lines | Reason |
|------|-------|--------|
| `src/services/OllamaSetupService.ts` | ~643 | Entire Ollama feature |
| `src/services/InteractiveOrchestrator.ts` | ~282 | Entire Orchestration feature |
| `src/test/ollama-setup-service-regression.test.js` | ~29 | Ollama tests |
| `src/test/interactive-orchestrator.test.ts` | ~68 | Orchestrator tests |
| `src/test/team-lead-visibility-defaults-regression.test.js` | ~49 | Team Lead tests |
| `src/test/team-lead-routing-options-regression.test.js` | ~12 | Team Lead tests |

**KEEP** (do NOT delete):
- `src/services/PipelineOrchestrator.ts` — used for ClickUp/Linear automation
- `src/test/pipeline-orchestrator-regression.test.js` — tests PipelineOrchestrator, not InteractiveOrchestrator

## Files to Modify Summary

| File | Changes |
|------|---------|
| `src/services/agentConfig.ts` | Remove team-lead from roles, labels, columns, VALID_ROLES |
| `src/services/KanbanProvider.ts` | Remove 2 fields + 10+ methods/type references for team-lead routing |
| `src/services/TaskViewerProvider.ts` | Remove Ollama imports, `_ollamaServices` Map, 6+ handler methods, 4+ helper methods, all Ollama/orchestration message case branches |
| `src/services/SetupPanelProvider.ts` | Remove 5+ message handler case branches (Ollama + team-lead) |
| `src/webview/setup.html` | Remove Ollama tab, Orchestration tab, and associated JavaScript |
| `src/webview/implementation.html` | Remove team-lead references |
| `src/webview/kanban.html` | Remove team-lead column rendering and agent list entry |
| `src/extension.ts` | Remove feature imports + teamLeadCommand logic |
| `src/mcp-server/register-tools.js` | Remove orchestration/Ollama tool registrations (keep generic 'orchestrator' sender name) |
| `src/test/builtin-role-dispatch-coverage.test.js` | Remove team-lead from coverage |
| `src/test/agent-prompt-builder-subagents.test.js` | Remove team-lead from tests |

## Risks and Considerations

1. **State Migration**: Users with existing state.json containing team-lead, ollama, or orchestration settings will have orphaned config entries. These are harmless (silently ignored after code changes) but could be cleaned up with a migration script if desired. Release notes should mention this.

2. **Column Ordering**: Removing the TEAM LEAD CODED column (order 170) will shift visual column ordering. The remaining columns maintain their relative order: CONTEXT GATHERER (150) → LEAD CODED (180) → CODER CODED (190) → INTERN CODED (200). No gap issues.

3. **Custom Agents**: Users who created custom agents referencing team-lead will need to update their configurations. This should be documented in the release notes.

4. **PipelineOrchestrator Confusion**: The codebase has both `InteractiveOrchestrator` (being removed) and `PipelineOrchestrator` (being kept). The similar names could cause accidental deletion. The verification grep in Phase 7.2 will catch this.

5. **Documentation**: Update README.md, TECHNICAL_DOC.md, and any other documentation referencing these features.

## Acceptance Criteria

- [ ] Ollama tab removed from Setup panel
- [ ] Orchestration tab removed from Setup panel
- [ ] Team Lead column removed from Kanban
- [ ] All related service files deleted (OllamaSetupService, InteractiveOrchestrator)
- [ ] PipelineOrchestrator.ts still exists and compiles
- [ ] All related test files deleted
- [ ] No remaining references to OllamaSetupService
- [ ] No remaining references to InteractiveOrchestrator
- [ ] No remaining references to team-lead role
- [ ] Extension compiles without errors
- [ ] Extension runs without runtime errors
- [ ] Setup panel loads correctly
- [ ] Kanban board displays correctly without Team Lead column
- [ ] ClickUp/Linear automation still works (PipelineOrchestrator intact)

---

## Review Pass Results (2026-05-05)

### Stage 1: Adversarial Findings

| # | File | Finding | Severity |
|---|------|---------|----------|
| 1 | `src/services/planStateUtils.ts` L30 | `'TEAM LEAD CODED'` still in `DEFAULT_VALID_COLUMNS` Set — validates removed column as valid, allowing ghost plans to pass validation while invisible in UI | **CRITICAL** |
| 2 | `src/services/agentPromptBuilder.ts` L408 | `case 'TEAM LEAD CODED':` dead switch case in `columnToPromptRole()` — falls through to `LEAD CODED` return, functionally harmless but maintenance trap | **MAJOR** |
| 3 | `src/services/planStateUtils.ts` L30 | `'BACKLOG'` in `DEFAULT_VALID_COLUMNS` but not in `DEFAULT_KANBAN_COLUMNS` — false alarm, BACKLOG is a virtual toggle column | **NIT** (keep) |
| 4 | Multiple files | 4 pre-existing TypeScript errors unrelated to this plan | **NIT** (defer) |

### Stage 2: Balanced Synthesis — Fixes Applied

| Finding | Action | Result |
|---------|--------|--------|
| CRITICAL: `TEAM LEAD CODED` in `planStateUtils.ts` `DEFAULT_VALID_COLUMNS` | Removed `'TEAM LEAD CODED'` from Set | Fixed |
| MAJOR: `case 'TEAM LEAD CODED':` in `agentPromptBuilder.ts` | Removed dead case branch (fall-through already covered by `LEAD CODED`) | Fixed |
| NIT: `BACKLOG` in `DEFAULT_VALID_COLUMNS` | Kept — legitimate virtual column | No change |
| NIT: Pre-existing TS errors | Deferred — not caused by this plan | No change |

### Files Changed by Review

| File | Change |
|------|--------|
| `src/services/planStateUtils.ts` | Removed `'TEAM LEAD CODED'` from `DEFAULT_VALID_COLUMNS` Set |
| `src/services/agentPromptBuilder.ts` | Removed `case 'TEAM LEAD CODED':` dead branch from `columnToPromptRole()` |

### Verification Results

- **Phase 7.2 grep — `OllamaSetupService|OllamaMode|OllamaInternConfig`**: Zero matches ✓
- **Phase 7.2 grep — `InteractiveOrchestrator`**: Zero matches ✓
- **Phase 7.2 grep — `team-lead|teamLead|TeamLead`**: Zero matches ✓
- **Full-project grep — `TEAM LEAD CODED`**: Zero matches ✓
- **Full-project grep — `TEAM LEAD`**: Zero matches ✓
- **PipelineOrchestrator.ts exists**: ✓
- **pipeline-orchestrator-regression.test.js exists**: ✓
- **TypeScript compilation**: 4 pre-existing errors only (no new regressions) ✓

### Remaining Risks

1. **Pre-existing TS errors**: 4 errors in `ClickUpSyncService.ts`, `KanbanProvider.ts`, and `TaskViewerProvider.ts` — all pre-existing, not caused by this removal. Should be tracked separately.
2. **Orphaned state.json entries**: Existing `state.json` files may contain `team-lead`, `ollama`, or `orchestration` settings. These are silently ignored after code changes but could confuse users inspecting state manually. Release notes should mention this.
3. **Custom agents referencing `team-lead`**: Users with custom agent configs referencing the removed role will need to update their configurations. Release notes should mention this.

---

**Complexity**: 7
**Recommendation**: Send to Lead Coder
