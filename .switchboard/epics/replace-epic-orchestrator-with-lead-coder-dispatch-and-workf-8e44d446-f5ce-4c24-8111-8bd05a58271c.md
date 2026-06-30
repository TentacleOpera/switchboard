---
description: 'Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons'
---

# Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons

**Complexity:** 6

## Goal

Retire the dedicated epic-orchestration lane — the orchestrator role, its terminal, and the ORCHESTRATING column — and route epics through the normal lead-coder dispatch instead. Epics carry their full subtask bundle on both the Copy Prompt and CLI dispatch paths, and an optional workflow directive (Ultracode or /goal) is prepended via two sticky board toggles. This removes a heavyweight, epic-only parallel mechanism while preserving subtask bundling and adding discoverable workflow controls. It also closes a pre-existing bug where CLI-dispatched epics silently dropped their subtasks.

## How the Subtasks Achieve This

- **Unify Epic Subtask Bundling Across Both Plan Resolvers**: Extracts subtask-expansion into one shared helper used by both the copy and CLI-dispatch resolvers, so every epic dispatch bundles its subtasks — fixing the CLI path that currently drops them. Lands first, so the shared helper is the surviving canonical copy when the orchestrator code is deleted.
- **Sticky Epic Workflow Toggle Buttons (Ultracode / Goal) with Prompt Prepend**: Adds two mutually-exclusive sub-bar toggles that prepend the chosen workflow directive at the very start of any epic prompt (on both copy and CLI dispatch, via `generateUnifiedPrompt`), replacing the buried `ultracode` add-on with first-class, always-ready board controls.
- **Remove the Epic Orchestrator Role, ORCHESTRATING Column, and Orchestrate Buttons**: Deletes the now-redundant orchestrator machinery as a clean break (the feature never shipped), since epics now dispatch through lead-coder with full bundling and workflow directives. Lands after the bundling unification and alongside the toggle buttons that supersede its `ultracode` add-on.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Unify Epic Subtask Bundling Across Both Plan Resolvers](../plans/feature_plan_20260629113945_unify-epic-subtask-bundling-across-resolvers.md) — **CODE REVIEWED**
- [ ] [Sticky Epic Workflow Toggle Buttons (Ultracode / Goal) with Prompt Prepend](../plans/feature_plan_20260629113946_sticky-epic-workflow-toggle-buttons.md) — **CODE REVIEWED**
- [ ] [Remove the Epic Orchestrator Role, ORCHESTRATING Column, and Orchestrate Buttons](../plans/feature_plan_20260629113947_remove-epic-orchestrator-role-and-column.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->
