# Sticky Epic Workflow Toggle Buttons (Ultracode / Goal) with Prompt Prepend

## Goal

Add two mutually-exclusive **sticky toggle buttons** to the kanban sub-bar that set a board-level "epic workflow mode" (`none | ultracode | goal`). Whenever an epic is dispatched (Copy Prompt **or** CLI dispatch), the active mode's directive is prepended at the very start of the prompt. This replaces the heavyweight Orchestrate mechanism's only real config knob (the `ultracode` add-on) with a one-click, discoverable board control, and adds a `/goal` sibling.

### Problem

The current epic-orchestration UX is heavyweight: the `ultracode` directive is buried in an orchestrator add-on toggle (`orchestrator.addons.ultracode`), reachable only through the orchestrator role's settings. There is no surface for `/goal` (a host slash-command workflow used by Antigravity/Codex/Devin) at all. The user wants both as first-class, always-ready board toggles so the workflow can be armed before an epic is dispatched.

### Root Cause / Background

Workflow directives today are appended deep in the orchestrator-only suffix of `agentPromptBuilder.ts` (gated on `ultracodeEnabled`), so they never apply to a normal lead-coder dispatch. Both prompt paths (copy and CLI dispatch) funnel through `generateUnifiedPrompt` (`KanbanProvider.ts:3064`), so a prepend placed there covers both surfaces uniformly. The kanban sub-bar already hosts sticky board toggles that persist through the backend (`#btn-cli-triggers` round-trips `toggleCliTriggers` → `cliTriggersState`), giving a proven pattern to mirror.

### Directive strings (configurable constants)

- **ultracode** → prepend: `This is an epic with multiple subtasks. Activate your ultracode workflow.`
- **goal** → prepend the literal slash command as the very first token: `/goal` (followed by a newline; `/goal` must be position-zero for the host to parse it).

## Metadata
- **Tags**: ui, ux, frontend, backend, feature
- **Complexity**: 5/10

## Implementation

1. **State + persistence.** Store the mode in the per-board DB `config` table under key `epic_workflow_mode` (`none|ultracode|goal`, default `none`). The DB `config` table is the blessed home for board state.
2. **UI — exact placement.** Add the two buttons to the **right-justified controls cluster** of the kanban sub-bar, in the gap **between `#btn-cli-triggers` (`src/webview/kanban.html:2498-2500`) and `#btn-collapse-coders` (2501-2503)** (after the flex spacer at 2495). Match the neighbors: `class="strip-icon-btn"` toggles driven by `is-active` / `is-off` (mirror how `#btn-collapse-coders` defaults to `is-off`), each with a `data-tooltip`. Suggested ids `#btn-epic-ultracode`, `#btn-epic-goal`. Icons: wire two new `{{ICON_...}}` template placeholders (mirroring `{{ICON_CLI}}` / `{{ICON_COLLAPSE_CODERS}}`), or use a short text glyph — minor sub-decision, no logic impact.
3. **Always rendered and always clickable**, independent of board contents — they set board configuration and must be armable before an epic exists. Do **not** gate visibility/enablement on epic presence.
4. **Handlers (kanban.html inline script).** The kanban webview is self-contained — handlers live in kanban.html, not `project.js`. Toggle semantics: clicking a button sets that mode and flips the other to `is-off`; clicking the active button resets to `none`. Three visual states across two buttons: `none` (both off), `ultracode`, `goal`.
5. **Message round-trip** (mirror `#btn-cli-triggers`). Click posts `setEpicWorkflowMode { mode }`; add `case 'setEpicWorkflowMode'` in `KanbanProvider.handleMessage` to persist `epic_workflow_mode` and broadcast back via an `epicWorkflowModeState` message (analogous to `cliTriggersState`, ~`kanban.html:6348`). Send the current mode in the initial board-state push so the right button shows `is-active` on load/reload.
6. **Prepend at assembly time.** In `generateUnifiedPrompt`, read `epic_workflow_mode`; when the primary plan `isEpic` and mode is `ultracode`/`goal`, prepend the corresponding constant to the **final assembled prompt string** as its very first characters (before opening/safeguard blocks). Assembling here (not in the dispatch layer) ensures the prefix appears in both Copy Prompt and CLI-dispatch output. Define `ULTRACODE_EPIC_PREFIX` and `GOAL_EPIC_PREFIX` constants.

### Edge cases
- **Epic with zero subtasks:** gate the prefix on the primary card `isEpic` (not on `plans.some(isSubtask)`), so a subtask-less epic still gets the directive.
- **`/goal` must be position-zero:** prepend to the outermost final string so no safeguard/authorization wall precedes it.
- **Non-epic cards:** prefix never applies, regardless of mode.

## User Review Required
None. Directive wording is captured as editable constants; the `/goal` position-zero requirement is a host constraint, not a preference.

## Epic / Dependencies

Subtask of epic **"Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons."** The prepend lives in `generateUnifiedPrompt`, which *"Remove the Epic Orchestrator Role…"* also edits (stripping orchestrator branches) — coordinate edits to that function. These buttons supersede the `ultracode` add-on that the removal plan deletes.
