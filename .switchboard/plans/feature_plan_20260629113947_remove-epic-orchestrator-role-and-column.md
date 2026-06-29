# Remove the Epic Orchestrator Role, ORCHESTRATING Column, and Orchestrate Buttons

## Goal

Delete the dedicated epic-orchestration machinery in its entirety: the `orchestrator` role and its terminal, the `epicOnly` **ORCHESTRATING** column, the **Orchestrate** buttons in both webviews, the `orchestrator.addons.ultracode` toggle, and `orchestrator-prompt.test.js`. Epics will instead dispatch through the normal lead-coder path (carrying the full subtask bundle) with workflow directives supplied by the new sticky buttons.

### Problem

The orchestrate flow is a parallel dispatch lane that exists **only** for epics: a separate role, its own terminal, a column that appears only when an epic is parked in it, and bespoke buttons in two webviews. It duplicates the normal coder columns and is the "weird" surface the rework targets. It only ever existed because the normal CLI-dispatch resolver didn't bundle subtasks — once that gap is closed (see sibling subtask), the orchestrator lane is pure redundancy.

### Root Cause / Background

The orchestrator was the only path that produced a **dispatched** (terminal) bundled epic prompt, because `_resolveKanbanDispatchPlans` never bundled subtasks. With bundling unified across both resolvers and workflow directives moved to board toggles, nothing depends on the orchestrator role or column.

### Release posture — clean break

The entire epic-orchestration feature (orchestrator role, ORCHESTRATING column, Orchestrate buttons, `orchestrator.addons.ultracode`) **never shipped in a released version**. Per the project migration rule, unreleased-only state is deleted outright: no `*.migrated.bak`, no import-before-delete, no compat shims. The `epic_prompt_template` legacy DB key referenced inside the orchestrator branch is part of this same unreleased feature and is removed with it.

## Metadata
- **Tags**: refactor, backend, ui
- **Complexity**: 6/10

## User Review Required
None. Clean break on unreleased-only feature state; no migration is owed.

## Complexity Audit

### Routine
- Deleting code blocks at known locations (mechanical deletion).
- Removing a role from a TypeScript union type (compile-time exhaustive switch checking catches stragglers).
- Deleting a test file.

### Complex / Risky
- **Large deletion surface across 10+ files**: A single missed reference breaks the build. The deletion surface spans `agentConfig.ts`, `extension.ts`, `TaskViewerProvider.ts`, `KanbanProvider.ts`, `PlanningPanelProvider.ts`, `agentPromptBuilder.ts`, `kanban.html`, `project.js`, `project.html`, `implementation.html`, and `sharedDefaults.js`.
- **PipelineOrchestrator name collision**: The repo has a **separate** `PipelineOrchestrator` feature (auto-advancing plans) with its own class, CSS, and test file. References to `PipelineOrchestrator` must NOT be touched. The implementer must distinguish `orchestrator` (the epic role being deleted) from `PipelineOrchestrator` (the pipeline feature being kept).
- **`VALID_KANBAN_COLUMNS` is derived**: It lives in `KanbanDatabase.ts` and is derived from `DEFAULT_KANBAN_COLUMNS` (line 633: `...DEFAULT_KANBAN_COLUMNS.map(c => c.id)`). Removing ORCHESTRATING from `DEFAULT_KANBAN_COLUMNS` automatically removes it from `VALID_KANBAN_COLUMNS` — no direct edit to `KanbanDatabase.ts` needed.
- **Two webview files missed by the original plan**: `implementation.html` (onboarding) and `project.html` (help text + button) contain orchestrator references that must also be removed.

## Edge-Case & Dependency Audit

**Race Conditions:**
- If an epic is currently parked in the ORCHESTRATING column when this code ships, the column will disappear from `DEFAULT_KANBAN_COLUMNS`. The card's `kanbanColumn` field may still reference `ORCHESTRATING`. The board refresh logic should handle unknown columns gracefully (it already has a safety-net for this at `kanban.html:5068-5085`, which is also being deleted). Verify that cards in an unknown column are either moved to a default column or displayed without crashing.

**Security:**
- No security implications. Removing a role reduces attack surface.

**Side Effects:**
- Removing `'orchestrator'` from `BuiltInAgentRole` union will cause compile errors in any exhaustive `switch`/map that handles all roles — this is **desirable** (surfaces stragglers at compile time).
- The `orchestrator-prompt.test.js` deletion removes test coverage for the orchestrator prompt format. New coverage for the unified bundling + prepend is added by sibling subtasks.

**Dependencies & Conflicts:**
- Lands **after** "Unify Epic Subtask Bundling Across Both Plan Resolvers" (so the shared helper is the surviving canonical copy of the expansion logic that `buildEpicOrchestrationPrompt` duplicates).
- Lands **alongside** "Sticky Epic Workflow Toggle Buttons" (which replaces the `ultracode` add-on deleted here, and co-edits `generateUnifiedPrompt`).
- Co-edits `generateUnifiedPrompt` with the toggle-buttons plan — coordinate to avoid merge conflicts.

## Dependencies

- Epic: **"Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons"**
- Sibling: *"Unify Epic Subtask Bundling Across Both Plan Resolvers"* — must land first (shared helper survives; `buildEpicOrchestrationPrompt`'s duplicate expansion logic is deleted here).
- Sibling: *"Sticky Epic Workflow Toggle Buttons"* — co-edits `generateUnifiedPrompt`; replaces the `ultracode` add-on deleted here.

## Adversarial Synthesis

Key risks: (1) The original plan missed two webview files (`implementation.html` onboarding, `project.html` help/button) and had wrong line numbers for all role arrays — the deletion surface must be applied completely or the build breaks. (2) The `PipelineOrchestrator` name collision must be carefully navigated — do NOT touch `PipelineOrchestrator.ts`, its CSS in `implementation.html` (lines 1105-1211), or `pipeline-orchestrator-regression.test.js`. (3) Cards parked in ORCHESTRATING column at upgrade time need graceful handling since the column safety-net is also being deleted. Mitigations: corrected line numbers and added missed files to the deletion surface below; explicit "DO NOT TOUCH" list for PipelineOrchestrator; verify board refresh handles unknown columns.

## Proposed Changes

### `src/services/agentConfig.ts`
- **Context**: Defines the `orchestrator` role and ORCHESTRATING column.
- **Logic**: Drop `'orchestrator'` from `BuiltInAgentRole` type (line 48), the `BUILT_IN_AGENT_LABELS` entry `orchestrator: 'Orchestrator'` (line 102), the ORCHESTRATING entry in `DEFAULT_KANBAN_COLUMNS` (line 112), and `'orchestrator'` from `VALID_ROLES` in `parseDefaultPromptOverrides` (line 397).
- **Edge Cases**: `VALID_KANBAN_COLUMNS` in `KanbanDatabase.ts` is derived from `DEFAULT_KANBAN_COLUMNS` — no direct edit needed there.

### `src/extension.ts`
- **Context**: Orchestrator agent registration.
- **Logic**: Remove the registration `{ name: 'Orchestrator', role: 'orchestrator' }` at line 2669 and its explanatory comments (2664-2668).

### `src/services/TaskViewerProvider.ts`
- **Context**: Role arrays containing `'orchestrator'`.
- **Logic**: Remove `'orchestrator'` from the roles array at line 3998 (`['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'orchestrator']`) and at line 7518 (`['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'ticket_updater', 'researcher', 'orchestrator']`).
- **Edge Cases**: Do NOT touch `PipelineOrchestrator` references at lines 17, 302, 401, 3700 — these are a different feature.

### `src/services/KanbanProvider.ts`
- **Context**: Contains the orchestrator functions, column handling, role arrays, and `generateUnifiedPrompt` branches.
- **Logic (role array)**: Remove `'orchestrator'` from the roles array at line 2579.
- **Logic (functions)**: Delete `buildEpicOrchestrationPrompt` (3112-3160), `dispatchEpicOrchestration` (3167-3188), `markEpicOrchestrating` (3194-3234), `isOrchestratorAvailable` (3244-3254).
- **Logic (message case)**: Delete the `orchestrateEpic` message case (6990-7048).
- **Logic (column/role glue)**: Remove ORCHESTRATING handling at 4154-4165, move guards at 4847-4849 and 4911-4913, `_columnToRole` case at 8247.
- **Logic (generateUnifiedPrompt)**: Remove orchestrator branches at 3046-3062 (incl. `epic_prompt_template` legacy import) and 3071-3077. Keep the `role !== 'orchestrator'` epic-handling block at 3084-3094 — now the only branch; simplify away the dead conditional.
- **Logic (ultracode plumbing)**: Remove `ultracodeByRole` at line 2971 and the `ultracodeByRole` object at 3446-3448.
- **Edge Cases**: The `buildEpicOrchestrationPrompt` function contains a near-duplicate of the subtask-expansion logic (3124-3156). This is safe to delete because the sibling "Unify Bundling" plan extracts the canonical copy into a shared helper that lands first.

### `src/services/agentPromptBuilder.ts`
- **Context**: Contains the orchestrator prompt branch and ultracode directive.
- **Logic**: Remove the `if (role === 'orchestrator')` branch in `buildPrdReferenceBlock` (line 326) and the main orchestrator prompt builder branch at line 1051-1106 (including `orchestratorBase` string at 1056-1060). Remove `ULTRACODE_DIRECTIVE` constant (line 355). Remove `ultracodeEnabled` option plumbing: interface definition (line 165), variable assignment (line 489), usage in suffix block (line 1083).
- **Edge Cases**: The `ULTRACODE_DIRECTIVE` constant (`"use ultracode"`) is replaced by the new `ULTRACODE_EPIC_PREFIX` constant in the sibling toggle-buttons plan. Coordinate so the new constant is defined before this one is deleted (or define it in the same PR).

### `src/webview/kanban.html`
- **Context**: Kanban webview with orchestrator UI elements.
- **Logic**: Remove the orchestrator startup-command input (line 2748), the Orchestrator option in the Agents dropdown (line 2804), its description (line 3212), the ORCHESTRATING column visibility safety-net (5068-5087), and the per-card Orchestrate button + handler (5281-5297, 5399).
- **Edge Cases**: After removing the column safety-net, verify that cards with a stale `kanbanColumn` of `ORCHESTRATING` (from before the update) don't crash the board render. The board should either display them in a default column or filter them gracefully.

### `src/webview/project.js`
- **Context**: Project webview with Orchestrate button and overlay.
- **Logic**: Remove `_orchestratorAvailable` (line 168, assignment at 380), the Orchestrate button (line 1803), button handler (1818-1821), and the Orchestrate overlay + handlers (1913-1954).

### `src/webview/project.html` — **ADDED (missed by original plan)**
- **Context**: Project webview HTML with orchestrator help text and button.
- **Logic**: Remove help text mentioning orchestrator in PRD description (line 1458), "Send to Orchestrator" button text (line 1655), and help modal text explaining Orchestrate mode (lines 1669-1670).

### `src/webview/implementation.html` — **ADDED (missed by original plan)**
- **Context**: Onboarding/implementation webview with orchestrator agent configuration.
- **Logic**: Remove the onboarding Orchestrator agent configuration: checkbox with `data-role="orchestrator"` and label/input (lines 1475-1478), and the onboarding save handler references to `orchestrator` (lines 3710-3712, including `orchestrator: document.getElementById('onboard-cli-orchestrator')?.value` and `visibleAgents.orchestrator`).
- **Edge Cases**: Do NOT remove CSS for `.orchestrator-card`, `.orchestrator-header`, `.orchestrator-timer`, `.orchestrator-controls` (lines 73, 1105-1211) — these are for the **Pipeline Orchestrator** feature (auto-advancing plans), which is a different feature and must be kept.

### `src/services/PlanningPanelProvider.ts`
- **Context**: Planning panel with orchestrator availability computation and orchestrate handler.
- **Logic**: Remove `orchestratorAvailable` computation/messages (lines 2933-2949), the planner-preview call to `buildEpicOrchestrationPrompt` (line 3029), and the `orchestrateEpic` handler (lines 3265-3308). Also remove orchestrator references at lines 129, 2953, 3444, 8575.
- **Edge Cases**: The default-visibility entry referenced in the original plan at line 3199 does not exist at that location — the actual orchestrator references in this file are at the lines listed above.

### `src/webview/sharedDefaults.js`
- **Context**: Shared default configuration for webviews.
- **Logic**: Remove the `orchestrator` config block (line 32), the `ultracode` add-on toggle definition (line 228), and additional orchestrator references at lines 15 and 47.

### `src/test/orchestrator-prompt.test.js`
- **Context**: Test file for the orchestrator prompt format.
- **Logic**: Delete the file entirely. New bundling/prepend coverage is added by sibling subtasks.

### DO NOT TOUCH (PipelineOrchestrator — different feature)
- `src/services/PipelineOrchestrator.ts` — pipeline orchestration for auto-advancing plans.
- `src/test/pipeline-orchestrator-regression.test.js` — tests PipelineOrchestrator.
- `src/services/TaskViewerProvider.ts` lines 17, 302, 401, 3700 — PipelineOrchestrator import, field, instantiation, config.
- `src/webview/implementation.html` lines 73, 1105-1211 — CSS for Pipeline Orchestrator card/controls.

## Verification Plan

### Automated Tests
- After deletion, run `npm run compile` (TypeScript) to catch any missed references via exhaustive switch/union errors. (Per session directives, compilation is not run during this planning session — the user will run it separately.)
- Verify no test file imports the deleted `orchestrator-prompt.test.js`.
- Verify the sibling subtask tests (bundling parity, prepend) still pass after the orchestrator code is removed.

> **Note**: Per session directives, automated tests and compilation are not run during this planning session. The user will run the test suite and compilation separately.

## Epic / Dependencies

Subtask of epic **"Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons."** Land **after** *"Unify Epic Subtask Bundling Across Both Plan Resolvers"* (so the shared bundling helper is the surviving canonical copy) and alongside *"Sticky Epic Workflow Toggle Buttons"* (which replaces the `ultracode` add-on deleted here, and co-edits `generateUnifiedPrompt`).

**Recommendation: Complexity 6/10 → Send to Coder**
