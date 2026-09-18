# Project Panel Message Handler Survival

**Complexity:** 5

## Goal

Fix the shared-disposable bug where closing the Planning panel disposes message handlers that the Project panel depends on, breaking all previews and copy-prompt buttons in the Project panel. Both plans share the exact same root cause and the same fix site.

## How the Subtasks Achieve This

- **All Previews Broken in Project Panel**: Diagnoses and fixes the root cause — the shared `_disposables` array means the Project panel's message handlers are disposed when the Planning panel closes, breaking all markdown previews.
- **Kanban Copy Prompt Buttons Broken in Project Panel**: Same root cause manifesting in the copy-prompt buttons; fixing the shared-disposable issue resolves both preview and button breakage simultaneously.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Kanban Copy Prompt Buttons Broken in Project Panel](../plans/feature_plan_20260702114114_kanban-copy-prompt-broken-project-panel.md) — **CODE REVIEWED** — ID: 3e59f236-837c-468f-9fd6-29740a4ee957
- [ ] [All Previews Broken in Project Panel](../plans/feature_plan_20260702114115_all-previews-broken-project-panel.md) — **CODE REVIEWED** — ID: 90eb919a-6586-44b1-aa81-cbb44d614054
<!-- END SUBTASKS -->

