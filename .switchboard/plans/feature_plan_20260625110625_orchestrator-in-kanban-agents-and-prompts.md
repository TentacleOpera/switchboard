# Add Orchestrator Agent to the Kanban Agents Tab and Prompt Builder

## Goal

Add the orchestrator agent to the kanban Agents tab (visibility toggle + CLI command) and the Prompts tab role selector (prompt editing + add-ons), so users can configure and manage the orchestrator agent without leaving the kanban webview. This is the missing UAT piece of the epic-orchestration-onramp plan — the backend role registration is complete, but the kanban.html hardcoded UI was never updated.

### Problem analysis & root cause

The epic-orchestration-onramp plan (`feature_plan_20260625081837_epics-as-orchestration-onramp.md`) specified adding the `orchestrator` role across all enumeration touch-points. The **backend** registration is complete and verified:

- `agentConfig.ts:1` — `BuiltInAgentRole` includes `'orchestrator'`
- `agentConfig.ts:99` — `BUILT_IN_AGENT_LABELS` has `orchestrator: 'Orchestrator'`
- `agentConfig.ts:395` — `VALID_ROLES` in `parseDefaultPromptOverrides` includes `'orchestrator'`
- `sharedDefaults.js:38` — `DEFAULT_ROLE_CONFIG` has orchestrator with full addon config
- `sharedDefaults.js:18` — `DEFAULT_VISIBLE_AGENTS` has `orchestrator: false`
- `sharedDefaults.js:56` — `BUILT_IN_AGENT_LABELS` has `{ key: 'orchestrator', label: 'Orchestrator' }`
- `sharedDefaults.js:270-285` — `ROLE_ADDONS` has a complete orchestrator entry (9 addons including subagent policy radio)
- `sharedDefaults.js:63` — `ROLE_KEYS` is derived from `DEFAULT_ROLE_CONFIG` keys, so it includes orchestrator
- `sharedDefaults.js:67` — `PROMPT_OVERRIDE_EXCLUDED_KEYS` does NOT include orchestrator (prompt is editable)
- `extension.ts:2637` — `allBuiltInAgents` includes `{ name: 'Orchestrator', role: 'orchestrator' }`
- `agentPromptBuilder.ts:1162` — `if (role === 'orchestrator')` base-instruction branch exists
- `TaskViewerProvider.ts:3616` — `getVisibleAgents` defaults include `orchestrator: false`
- `TaskViewerProvider.ts:3914` — `handleGetDefaultPromptPreviews` roles array includes `'orchestrator'`
- `TaskViewerProvider.ts:7341` — `_getDefaultPromptOverrides` roles array includes `'orchestrator'`

**However, `kanban.html` uses hardcoded HTML for the Agents tab and Prompts tab role selector — and these were never updated to include orchestrator:**

1. **Agents tab** (`kanban.html:2728-2767`): Hardcoded `<div class="startup-row">` elements for gatherer, planner, code_researcher, splitter, lead, coder, intern, reviewer, tester, analyst, ticket_updater, researcher, jules — **no orchestrator row**. The sync logic at `kanban.html:6493-6498` iterates over existing DOM elements via `querySelectorAll` — it does NOT dynamically create rows. So the orchestrator's visibility toggle and CLI command input simply don't exist in the UI.

2. **Prompts tab role selector** (`kanban.html:2811-2825`): Hardcoded `<select id="roleSelect">` with `<option>` elements for every role except orchestrator — **no `<option value="orchestrator">`**. Without this option, the user cannot select the orchestrator role to edit its prompt or configure its add-ons.

3. **`ROLE_DESCRIPTIONS`** (`kanban.html:3196-3209`): Hardcoded object with descriptions for every role — **no `orchestrator` entry**. The `updateRoleDescription` function at `kanban.html:3212-3216` falls back to empty string when a role has no description, so this is cosmetic but should be fixed for completeness.

**Root cause:** The kanban.html Agents tab and Prompts tab predate the orchestrator role and use hardcoded HTML rows/options instead of dynamic generation from `BUILT_IN_AGENT_LABELS` (which the setup.html Prompts tab does at `setup.html:1643`). When the orchestrator role was added to the backend, these hardcoded UI elements were missed. The `handleRoleChange` function (`kanban.html:3239`) and `renderRoleAddons` function (`kanban.html:3301`) are generic enough to handle orchestrator without additional code — they read from `ROLE_ADDONS[role]` and `roleConfigs[role]`, both of which already include orchestrator. The `refreshPreview` function (`kanban.html:3479`) sends `getPromptPreview` with the current role, and the backend already handles orchestrator in `handleGetDefaultPromptPreviews`. So the ONLY missing pieces are the three hardcoded HTML/JS structures listed above.

**Note:** The same hardcoded-HTML gap also affects `claude_designer` and `mcp_monitor` (both present in `BUILT_IN_AGENT_LABELS` at `sharedDefaults.js:43-60` but absent from the kanban Agents tab and role selector). This plan is scoped to orchestrator only; a separate plan should address the remaining gaps or refactor the Agents tab to dynamically generate rows from `BUILT_IN_AGENT_LABELS`.

## Metadata

- **Tags:** `ui`, `bugfix`, `frontend`
- **Complexity:** 3/10 (adding hardcoded HTML rows/options — the backend and dynamic rendering paths are already complete)
- **Related plan:** `feature_plan_20260625081837_epics-as-orchestration-onramp.md` (this completes its UAT gaps)

## User Review Required

No user review required. This plan adds three hardcoded HTML/JS insertions to a single file (`kanban.html`) with no architectural changes, no data migrations, and no breaking changes. All backend and dynamic-rendering paths are already complete and verified.

## Complexity Audit

### Routine
- Adding an orchestrator `<div class="startup-row">` to the Agents tab HTML — copy-paste of an existing row (e.g. the researcher row at `kanban.html:2764`), changing `data-role` to `orchestrator` and the label/description.
- Adding an `<option value="orchestrator">Orchestrator</option>` to the `roleSelect` dropdown — one line.
- Adding an `orchestrator: '...'` entry to `ROLE_DESCRIPTIONS` — one line.
- The sync logic (`kanban.html:6493-6498`) will automatically pick up the new row's checkbox and command input via `querySelectorAll`.
- The `loadRoleConfigs` function (`kanban.html:3219-3224`) iterates over `ROLE_KEYS` (which includes orchestrator) — it already requests `roleConfig_orchestrator` from the backend.

### Complex / Risky
- **None.** The dynamic rendering paths (`handleRoleChange`, `renderRoleAddons`, `refreshPreview`) and backend handlers (`handleGetDefaultPromptPreviews`, `getPromptPreview`, `getSetting`/`saveSetting` for `roleConfig_orchestrator`) all already handle orchestrator. This is purely a hardcoded-HTML gap.
- **Minor verification:** Confirm that selecting "Orchestrator" in the role selector shows the correct add-ons (subagent policy radio, worktrees per plan, etc.) and an editable prompt preview. The `handleRoleChange` function's `else` branch at `kanban.html:3290-3292` calls `renderRoleAddons(currentRole)` for non-planner, non-researcher roles — orchestrator falls into this branch correctly.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The three insertions are static HTML/JS that load with the webview. The sync logic (`startupCommands` handler at `kanban.html:6491-6519`) runs after DOM load and queries existing elements — the new orchestrator row will be present by then. No async ordering issues.
- **Security:** None. No new user inputs, no new message handlers, no new backend endpoints. The orchestrator CLI command input uses the same `data-role` pattern as all other agent rows — the backend already handles `startupCommands` for orchestrator via the generic `cmds[i.dataset.role]` lookup.
- **Side Effects:**
  - **Orchestrator is hidden by default** (`DEFAULT_VISIBLE_AGENTS.orchestrator = false`): The visibility toggle checkbox should render **unchecked**, matching the default. The sync logic at `kanban.html:6496-6497` sets `cb.checked = vis[cb.dataset.role] !== false`. **Verified safe:** The backend's `getVisibleAgents` (`TaskViewerProvider.ts:3610-3649`) builds `defaults` with `orchestrator: false` and returns `{ ...defaults, ...fileValue }`. If saved state (`fileValue`) lacks the `orchestrator` key, the spread preserves `defaults.orchestrator = false`. So `vis.orchestrator` is always `false` (not `undefined`) for both new and existing installs. The checkbox renders unchecked correctly.
  - **No confirmation dialogs** (project rule) — not applicable (this is a UI addition, no delete/confirm actions).
  - **Prompt preview for orchestrator:** The `previewEl.readOnly` check at `kanban.html:3296` only sets read-only for `planner` and `code_researcher` — orchestrator's prompt preview is editable, which is correct (the orchestrator's prompt override should be user-editable).
  - **Add-on rendering:** The `renderRoleAddons` function at `kanban.html:3301` reads from `ROLE_ADDONS[role]`. The orchestrator entry in `sharedDefaults.js:270-285` includes a `subagentPolicy` radio addon with a `customSubagentName` text input — the rendering code at `kanban.html:3322-3360` handles radio addons with text inputs, so this works out of the box.
  - **Jules row precedent:** The Jules agent row at `kanban.html:2766` has no CLI command input (it uses `<span>` instead of `<input>`). The orchestrator DOES need a CLI command input (it's a terminal-based agent), so model the row after the researcher row (`kanban.html:2764`), not the Jules row.
- **Dependencies & Conflicts:**
  - The `handleGetDefaultPromptPreviews` roles array (`TaskViewerProvider.ts:3914`) includes `'orchestrator'` — the default prompt preview will load correctly. (Note: this array only covers 8 of 16 roles — a pre-existing limitation unrelated to this plan. Orchestrator is among the 8, so verification step 7 will pass.)
  - The `_getDefaultPromptOverrides` roles array (`TaskViewerProvider.ts:7341`) includes `'orchestrator'` — saved prompt overrides will be loaded correctly.
  - No conflicts with other plans. The `claude_designer` and `mcp_monitor` roles are also missing from the kanban UI but are out of scope for this plan.

## Dependencies

- `feature_plan_20260625081837_epics-as-orchestration-onramp.md` — the prior plan that added the orchestrator role to all backend enumeration touch-points (agentConfig.ts, sharedDefaults.js, extension.ts, agentPromptBuilder.ts, TaskViewerProvider.ts). This plan completes its UAT gaps by adding the missing kanban.html UI elements. Must already be implemented (it is — verified by code inspection).

## Adversarial Synthesis

Key risks: (1) The `visibleAgents` merge path could theoretically leave `orchestrator` as `undefined` for existing installs — **verified safe**: the backend spread `{ ...defaults, ...fileValue }` with `defaults.orchestrator = false` guarantees `false` for all installs. (2) The same hardcoded-HTML gap affects `claude_designer` and `mcp_monitor` — out of scope but should be tracked separately. Mitigations: the three insertions are purely additive static HTML with no logic changes; all dynamic rendering paths are generic and already handle orchestrator.

## Proposed Changes

### `src/webview/kanban.html` — Agents tab (after the researcher row, ~line 2765)

**Context:** The Agents tab uses hardcoded `<div class="startup-row">` elements for each built-in agent. The sync logic at `kanban.html:6493-6498` iterates over existing DOM elements via `querySelectorAll` — it does NOT dynamically create rows. The orchestrator row must be added statically.

**1. Add the orchestrator agent row:**

```html
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="orchestrator" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Orchestrator</label><input type="text" data-role="orchestrator" id="agents-tab-cmd-orchestrator" placeholder="e.g. claude --dangerously-skip-permissions" style="flex:1;"></div>
<div class="agent-description">Runs an entire epic end-to-end with native subagents — one agent handles all subtasks in a single dispatch.</div>
```

**Implementation:** Insert this after the researcher row (line 2764-2765) and before the Jules row (line 2766). The row follows the researcher row pattern (checkbox + label + CLI text input), NOT the Jules row pattern (checkbox + label + `<span>` — Jules has no CLI command).

**Edge Cases:** The checkbox renders unchecked by default because `DEFAULT_VISIBLE_AGENTS.orchestrator = false` and the backend merge path preserves this. The CLI command input is picked up by the `startupCommands` handler's `querySelectorAll('#agents-tab-content input[type="text"][data-role]')` at `kanban.html:6493-6494`.

### `src/webview/kanban.html` — Prompts tab role selector (line 2824)

**Context:** The Prompts tab role selector is a hardcoded `<select id="roleSelect">` with `<option>` elements for each built-in role. The `handleRoleChange` function (`kanban.html:3239`) fires on selection change and routes to the correct rendering path based on the selected role. Orchestrator falls into the `else` branch (line 3290-3292) which calls `renderRoleAddons(currentRole)`.

**2. Add the orchestrator option to the `<select id="roleSelect">`:**

```html
<option value="researcher">Researcher</option>
<option value="orchestrator">Orchestrator</option>
<option value="jules">Jules</option>
```

**Implementation:** Insert `<option value="orchestrator">Orchestrator</option>` after the researcher option (line 2823) and before the jules option (line 2824). This matches the order in `BUILT_IN_AGENT_LABELS` (`sharedDefaults.js:55-58`) where orchestrator appears between researcher and jules.

**Edge Cases:** Selecting "Orchestrator" triggers `handleRoleChange`, which shows `promptCustomization` (line 3247: `currentRole === 'planner' ? 'none' : 'block'`), hides `researchComplexityConfig` (line 3246: only for researcher/code_researcher), hides `plannerConfig` (line 3245), and calls `renderRoleAddons('orchestrator')` in the else branch (line 3291). The prompt preview is editable (line 3296: readOnly only for planner/code_researcher).

### `src/webview/kanban.html` — ROLE_DESCRIPTIONS (line 3209)

**Context:** `ROLE_DESCRIPTIONS` is a hardcoded object mapping role keys to description strings. The `updateRoleDescription` function (`kanban.html:3212-3216`) reads `ROLE_DESCRIPTIONS[currentRole]` and falls back to empty string if the key is absent. Adding the orchestrator entry ensures the description displays when the role is selected.

**3. Add the orchestrator description:**

```javascript
const ROLE_DESCRIPTIONS = {
    // ... existing entries ...
    gatherer: 'Researches codebase context for plans and writes context briefs before planning review.',
    orchestrator: 'Runs an entire epic end-to-end with native subagents — one agent handles all subtasks in a single dispatch.',
    jules: 'Offloads tasks to Google Jules cloud-coding service for quota-free background execution.'
};
```

**Implementation:** Insert `orchestrator: 'Runs an entire epic end-to-end with native subagents — one agent handles all subtasks in a single dispatch.',` after the `gatherer` entry (line 3208) and before the `jules` entry (line 3209).

**Edge Cases:** If the entry is omitted, `updateRoleDescription` falls back to empty string — cosmetic only, no functional impact. Adding it ensures UI completeness.

## Verification Plan

> Manual verification against an installed VSIX (per project norm). No compilation or automated tests required for this session.

### Automated Tests

No automated tests required. This plan adds three static HTML/JS insertions to a single webview file with no logic changes. All dynamic rendering paths are already complete and tested via the backend. Verification is manual against an installed VSIX per project norm.

### Manual Verification

1. **Agents tab — orchestrator row visible:** Open the kanban Agents tab → the Orchestrator row appears with an unchecked visibility checkbox and a CLI command input field. The description "Runs an entire epic end-to-end with native subagents…" is shown below it.
2. **Agents tab — enable orchestrator:** Check the Orchestrator visibility checkbox → it saves (autosave on checkbox change at `kanban.html:3649`). Enter a CLI command (e.g. `claude`) → it saves on blur (autosave at `kanban.html:3652`). Verify the command persists after reloading the webview.
3. **Agents tab — state sync:** Reload the webview → the Orchestrator checkbox and command input reflect the saved state (checkbox checked, command populated).
4. **Prompts tab — orchestrator selectable:** Open the Prompts tab → the role selector dropdown includes "Orchestrator". Select it → the role description appears ("Runs an entire epic end-to-end…").
5. **Prompts tab — add-ons render:** With Orchestrator selected, the Add-ons section shows the orchestrator's add-ons: Switchboard Safeguards, Git Prohibition, Clear Antigravity Context, Caveman Output, Skip Compilation, Skip Tests, Subagent Policy (radio: Not Specified / No Subagents / Yes / Custom), Worktrees Per Plan, Workflow File.
6. **Prompts tab — prompt editable:** With Orchestrator selected, the "Edit Prompt Template" textarea is editable (not read-only). Enter a custom prompt override → it saves. Reload → the override persists.
7. **Prompts tab — prompt preview:** With Orchestrator selected, the prompt preview loads (shows the assembled orchestrator base prompt). Editing the textarea updates the saved override.
8. **Subagent policy radio:** Click through the Subagent Policy radio options → selecting "Custom Subagent" shows the custom subagent name text input. Enter a name → it saves.
9. **No phantom kanban column:** Confirm that enabling the orchestrator does NOT create a new column on the kanban board (the orchestrator has no entry in `DEFAULT_KANBAN_COLUMNS` and `columnToPromptRole` has no orchestrator mapping).
10. **Orchestrate button in Epics tab:** After enabling the orchestrator and entering a CLI command, the Orchestrate button in the Epics tab should reflect the configured state (related to the Issue 3 plan — if that plan is also implemented, the button should appear teal/active).
11. **Existing installs — checkbox default:** On an existing install with saved `visibleAgents` state that predates orchestrator, verify the Orchestrator checkbox renders **unchecked** (not incorrectly checked). This confirms the backend merge path (`getVisibleAgents` spreads `defaults.orchestrator = false` over absent saved key).

---

**Recommendation:** Complexity 3/10 → **Send to Intern**. Three static HTML/JS insertions in a single file, no logic changes, no migrations, all backend paths already complete.
