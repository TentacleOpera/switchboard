# Sticky Epic Workflow Toggle Buttons (Ultracode / Goal) with Prompt Prepend

## Goal

Add two mutually-exclusive **sticky toggle buttons** to the kanban sub-bar that set a board-level "epic workflow mode" (`none | ultracode | goal`). Whenever an epic is dispatched (Copy Prompt **or** CLI dispatch), the active mode's directive is prepended at the very start of the prompt. This replaces the heavyweight Orchestrate mechanism's only real config knob (the `ultracode` add-on) with a one-click, discoverable board control, and adds a `/goal` sibling.

### Problem

The current epic-orchestration UX is heavyweight: the `ultracode` directive is buried in an orchestrator add-on toggle (`orchestrator.addons.ultracode`), reachable only through the orchestrator role's settings. There is no surface for `/goal` (a host slash-command workflow used by Antigravity/Codex/Devin) at all. The user wants both as first-class, always-ready board toggles so the workflow can be armed before an epic is dispatched.

### Root Cause / Background

Workflow directives today are appended deep in the orchestrator-only suffix of `agentPromptBuilder.ts` (gated on `ultracodeEnabled` at line 1083, using `ULTRACODE_DIRECTIVE` = `"use ultracode"` at line 355), so they never apply to a normal lead-coder dispatch. Both prompt paths (copy and CLI dispatch) funnel through `generateUnifiedPrompt` (`KanbanProvider.ts:2906`), which delegates to `buildKanbanBatchPrompt` (`agentPromptBuilder.ts:465`) and returns the final assembled string at line 3102. Prepending to `generateUnifiedPrompt`'s **return value** covers both surfaces uniformly and guarantees position-zero for `/goal`.

The kanban sub-bar already hosts sticky board toggles — `#btn-cli-triggers` (`src/webview/kanban.html:2498-2500`) round-trips `toggleCliTriggers` → `cliTriggersState` (state message received at `kanban.html:6348`). **However**, `toggleCliTriggers` persists via `_updateSetting()` → `globalState.update()` (VS Code global extension state, shared across all workspaces) — NOT the DB config table. For board-level (per-workspace) persistence, the new toggles must use `db.setConfig()`/`db.getConfig()` instead (the DB config table pattern, e.g. `db.setConfig('project_context_enabled', ...)` at `KanbanProvider.ts:2871`). Do **not** mirror cliTriggers' persistence layer.

### Directive strings (configurable constants)

- **ultracode** → prepend: `This is an epic with multiple subtasks. Activate your ultracode workflow.`
- **goal** → prepend the literal slash command as the very first token: `/goal` (followed by a newline; `/goal` must be position-zero for the host to parse it).

> **Note**: These are **new** constants (`ULTRACODE_EPIC_PREFIX`, `GOAL_EPIC_PREFIX`), distinct from the existing `ULTRACODE_DIRECTIVE` (`"use ultracode"`, `agentPromptBuilder.ts:355`) which is deleted by the sibling "Remove the Epic Orchestrator Role" plan.

## Metadata
- **Tags**: ui, ux, frontend, backend, feature
- **Complexity**: 5/10

## User Review Required
None. Directive wording is captured as editable constants; the `/goal` position-zero requirement is a host constraint, not a preference.

## Complexity Audit

### Routine
- Adding two HTML buttons to an existing controls cluster (mirrors `#btn-cli-triggers` / `#btn-collapse-coders` pattern at `kanban.html:2498-2503`).
- Adding a message round-trip case in `KanbanProvider.handleMessage` (mirrors existing cases).
- Adding icon placeholders to the `iconMap` in `_getHtml()` (`KanbanProvider.ts:8320-8344`).
- Inline toggle handlers in kanban.html's self-contained script section (starts at line 3181).

### Complex / Risky
- **Persistence layer choice**: Must use `db.setConfig`/`db.getConfig` (per-workspace board-level), NOT `_updateSetting`/`globalState` (global). The existing `cliTriggers` toggle uses globalState — do NOT copy that pattern. This is a deliberate divergence from the nearest neighbor.
- **Prepend location**: `generateUnifiedPrompt` is a wrapper that delegates to `buildKanbanBatchPrompt`. The prepend must be applied to `generateUnifiedPrompt`'s **return value** (line 3102: `return buildKanbanBatchPrompt(...)`) — wrap it as `return prefix + buildKanbanBatchPrompt(...)` — NOT inside `buildKanbanBatchPrompt`'s role-specific branches, to guarantee position-zero for `/goal` across all roles.
- **Reading board state inside `generateUnifiedPrompt`**: The method needs to read `epic_workflow_mode` from the DB config table. It already has `workspaceRoot` and obtains the DB in other methods — confirm the DB is accessible here (it is used elsewhere in KanbanProvider for config reads).

## Edge-Case & Dependency Audit

**Race Conditions:**
- The mode is read from DB at prompt-generation time. If the user toggles the mode while a dispatch is in flight, the prompt may use a stale mode. This is acceptable — the toggle is a pre-dispatch configuration, not a mid-dispatch control.

**Security:**
- No new attack surface. The mode is a board-local config string with a fixed enum (`none|ultracode|goal`). Validate incoming `setEpicWorkflowMode` messages against this enum before persisting.

**Side Effects:**
- The prepend changes the prompt string for all epic dispatches once a mode is active. Non-epic cards are unaffected (gated on `isEpic`).
- The DB config key `epic_workflow_mode` is new — no migration needed (unreleased feature state).

**Dependencies & Conflicts:**
- Co-edits `generateUnifiedPrompt` with the sibling "Remove the Epic Orchestrator Role" plan (which strips orchestrator branches at 3046-3062, 3071-3077). The prepend wraps the return value and is independent of those internal branches — no merge conflict if applied carefully.
- Supersedes the `ultracode` add-on (`orchestrator.addons.ultracode`) that the removal plan deletes. The new `ULTRACODE_EPIC_PREFIX` constant replaces the deleted `ULTRACODE_DIRECTIVE`.

## Dependencies

- Epic: **"Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons"**
- Sibling: *"Remove the Epic Orchestrator Role…"* — co-edits `generateUnifiedPrompt` and deletes the old `ULTRACODE_DIRECTIVE` that this plan replaces.
- Sibling: *"Unify Epic Subtask Bundling…"* — independent; this plan operates on the prompt prefix, that plan operates on the plans array content.

## Adversarial Synthesis

Key risks: (1) The plan says "mirror cliTriggers" but cliTriggers persists to globalState, not the DB — the implementer must use `db.setConfig`/`db.getConfig` for board-level persistence, explicitly diverging from the cliTriggers pattern. (2) `generateUnifiedPrompt` is a wrapper, not the assembler — the prepend must wrap the return value at line 3102, not be placed inside `buildKanbanBatchPrompt`, to guarantee `/goal` position-zero. (3) The `/goal` position-zero parsing requirement is a host-specific assumption that should be verified via web research. Mitigations: document the persistence divergence explicitly; wrap the return value; flag the `/goal` assumption for research.

## Proposed Changes

### `src/webview/kanban.html`
- **Context**: The kanban sub-bar has a right-justified controls cluster after the flex spacer at line 2495. `#btn-cli-triggers` is at 2498-2500, `#btn-collapse-coders` at 2501-2503.
- **Logic**: Add two new buttons between `#btn-cli-triggers` and `#btn-collapse-coders` (or after `#btn-collapse-coders`). IDs: `#btn-epic-ultracode`, `#btn-epic-goal`. Class: `strip-icon-btn`. Default both to `is-off` (mode = `none`). Each has a `data-tooltip`.
- **Implementation**: Mirror the HTML structure of `#btn-cli-triggers`. Use `{{ICON_EPIC_ULTRACODE}}` and `{{ICON_EPIC_GOAL}}` template placeholders (or short text glyphs — minor sub-decision). Add inline script handlers: clicking a button sets that mode, flips the other to `is-off`; clicking the active button resets to `none`. Post `setEpicWorkflowMode { mode }` message. Add `case 'epicWorkflowModeState'` handler (mirror `cliTriggersState` at line 6348) to update button visual state on load/reload.
- **Edge Cases**: Buttons are always rendered and clickable, independent of board contents. Do not gate on epic presence.

### `src/services/KanbanProvider.ts`
- **Context**: `handleMessage` processes webview messages. The `toggleCliTriggers` case is at line 5804-5807. `generateUnifiedPrompt` is at line 2906, returning at line 3102.
- **Logic (message handler)**: Add `case 'setEpicWorkflowMode'` in `handleMessage`. Validate `msg.mode` against `['none', 'ultracode', 'goal']`. Persist via `db.setConfig('epic_workflow_mode', mode)` (NOT `_updateSetting`). Broadcast back via `epicWorkflowModeState { mode }` message (mirror `cliTriggersState` broadcast at lines 1314, 2235, 2382).
- **Logic (initial state push)**: In the refresh paths that send `cliTriggersState` (lines 1314, 2235, 2382), also send `epicWorkflowModeState` with the current mode read from `db.getConfig('epic_workflow_mode')` (default `'none'`).
- **Logic (prepend)**: In `generateUnifiedPrompt`, after the existing `return buildKanbanBatchPrompt(...)` at line 3102, wrap as: read `epic_workflow_mode` from DB; if the primary plan `isEpic` and mode is `ultracode` or `goal`, prepend `ULTRACODE_EPIC_PREFIX` or `GOAL_EPIC_PREFIX` to the returned string. Gate on the primary plan's `isEpic` flag (not on `plans.some(isSubtask)`) so subtask-less epics still get the directive.
- **Implementation**: Define `ULTRACODE_EPIC_PREFIX` and `GOAL_EPIC_PREFIX` constants. Modify the return statement to conditionally prepend.
- **Edge Cases**: Non-epic cards → prefix never applies. Mode `none` → no prefix. `/goal` must be position-zero — prepending to the outermost return string guarantees this (no safeguard/authorization wall precedes it).

### `src/services/KanbanProvider.ts` — `_getHtml()` icon injection
- **Context**: The `iconMap` at lines 8320-8344 maps `{{ICON_*}}` placeholders to webview URIs via regex replacement.
- **Logic**: Add `{{ICON_EPIC_ULTRACODE}}` and `{{ICON_EPIC_GOAL}}` entries to `iconMap`, pointing to appropriate icon files in the icon directory (or use text glyphs if no icon files are available).
- **Edge Cases**: If using text glyphs instead of icons, no `iconMap` entry needed — just use text in the button HTML.

## Verification Plan

### Automated Tests
- Test that setting `epic_workflow_mode` to `ultracode` and dispatching an epic produces a prompt starting with `ULTRACODE_EPIC_PREFIX`.
- Test that setting mode to `goal` and dispatching an epic produces a prompt starting with `/goal\n` at position zero.
- Test that mode `none` produces no prefix.
- Test that non-epic cards never get the prefix regardless of mode.
- Test that the mode persists per-workspace (DB config) and survives board reload.
- Test that the toggle round-trip (`setEpicWorkflowMode` → `epicWorkflowModeState`) updates button visual state.

> **Note**: Per session directives, automated tests are not run during this planning session. The user will run the test suite separately.

## Epic / Dependencies

Subtask of epic **"Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons."** The prepend lives in `generateUnifiedPrompt`, which *"Remove the Epic Orchestrator Role…"* also edits (stripping orchestrator branches) — coordinate edits to that function. These buttons supersede the `ultracode` add-on that the removal plan deletes.

**Recommendation: Complexity 5/10 → Send to Coder**
