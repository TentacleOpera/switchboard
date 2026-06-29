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

## Implementation — deletion surface

Remove every reference below so the build stays green. **Do NOT** touch `src/test/pipeline-orchestrator-regression.test.js` — that is the unrelated PipelineOrchestrator subsystem.

- **Role / column definitions** — `src/services/agentConfig.ts`: drop `'orchestrator'` from `BuiltInAgentRole` (line 48), the `AGENT_ROLE_LABELS` entry (77), and the ORCHESTRATING entry in `DEFAULT_KANBAN_COLUMNS` (112). Remove ORCHESTRATING from `VALID_KANBAN_COLUMNS` wherever it mirrors the defaults.
- **Agent registration** — `src/extension.ts:2669`: remove the Orchestrator agent registration.
- **Role lists** — remove `'orchestrator'` from the role arrays in `TaskViewerProvider.ts:1530,1626`, `KanbanProvider.ts:797`, and the default-visibility entry in `PlanningPanelProvider.ts:3199`.
- **Orchestrate functions** — delete `buildEpicOrchestrationPrompt`, `dispatchEpicOrchestration`, `markEpicOrchestrating`, `isOrchestratorAvailable` (`KanbanProvider.ts:3112-3260`), and the `orchestrateEpic` message case (6990-7048).
- **Column / role glue in KanbanProvider.ts** — remove ORCHESTRATING handling at 4155-4162, the move guards at 4847 and 4911, the `_columnToRole` case at 8247, and the orchestrator branches in `generateUnifiedPrompt` at 3046-3062 (incl. the `epic_prompt_template` legacy import) and 3071-3077. Keep the `role !== 'orchestrator'` epic-handling block (3084-3094) — now the only branch; simplify away the dead conditional.
- **Prompt builder** — `agentPromptBuilder.ts`: remove the `if (role === 'orchestrator')` branch and `orchestratorBase` (488-1100, 1076), the `ULTRACODE_DIRECTIVE` constant (355), and the `ultracodeEnabled` option plumbing (164-165, 489, 1083). Remove `ultracodeByRole`/add-on plumbing in `KanbanProvider.ts` (2971, 3446-3448).
- **Kanban webview** — `src/webview/kanban.html`: remove the orchestrator startup-command input (2748), the Orchestrator option in the Agents dropdown (2804), its description (3212), the ORCHESTRATING column visibility safety-net (5068-5085), and the per-card Orchestrate button + handler (5281-5297, 5399).
- **Project webview** — `src/webview/project.js`: remove `_orchestratorAvailable` (168, 380) and the Orchestrate button + overlay + handlers (1803, 1818-1821, 1913-1982). `PlanningPanelProvider.ts`: remove the `orchestratorAvailable` computation/messages (2922-2940), the planner-preview call to `buildEpicOrchestrationPrompt` (3016), and the `orchestrateEpic` handler (3252-3294).
- **sharedDefaults.js** — `src/webview/sharedDefaults.js`: remove the `orchestrator` config block (32) and the `ultracode` add-on toggle definition (228).
- **Tests** — delete `src/test/orchestrator-prompt.test.js`. (New bundling/prepend coverage is added by the sibling subtasks.)

### Risks
- Removing `'orchestrator'` from the `BuiltInAgentRole` union surfaces any remaining exhaustive `switch`/map usages at compile time — use that to catch stragglers. A missed reference is a build break, so the surface above must be applied completely.

## User Review Required
None. Clean break on unreleased-only feature state; no migration is owed.

## Epic / Dependencies

Subtask of epic **"Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons."** Land **after** *"Unify Epic Subtask Bundling Across Both Plan Resolvers"* (so the shared bundling helper is the surviving canonical copy) and alongside *"Sticky Epic Workflow Toggle Buttons"* (which replaces the `ultracode` add-on deleted here, and co-edits `generateUnifiedPrompt`).
