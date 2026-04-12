# Fix Team Lead UI Visibility

## Goal

Add the `team-lead` role to the Setup UI so users can configure and assign a terminal to the Team Lead role. The original `add_team_lead_orchestrator_role.md` plan added team-lead to the backend but missed updating the webview UI, making it impossible to select the Team Lead role in the Setup section.

## Metadata
**Tags:** frontend, UI, bugfix
**Complexity:** 5

## User Review Required
> [!NOTE]
> No breaking changes. All changes are additive, inserting new `team-lead` entries alongside existing roles. No manual steps required beyond saving the configuration in the UI after deployment.
>
> **Clarification:** the Team Lead custom-prompt tab now lives in the dedicated Setup panel (`src/webview/setup.html`), not inside `src/webview/implementation.html`.

## Root Cause

The `add_team_lead_orchestrator_role.md` plan updated:
- `src/services/agentConfig.ts` — added type union, label, column definition, VALID_ROLES
- `src/services/agentPromptBuilder.ts` — added prompt branch
- `src/services/KanbanProvider.ts` — added column mappings
- `src/services/TaskViewerProvider.ts` — added column mappings
- `src/services/planStateUtils.ts` — added VALID_COLUMNS entry

But it missed updating the user-facing role surfaces and clean-state defaults:
- `src/webview/implementation.html` — missing Team Lead onboarding row, Terminal Operations row, `lastVisibleAgents`, onboarding `agents` save, onboarding `visibleAgents` default, onboarding `startupCommands` rehydration map, onboarding guard role enumeration, and sidebar `renderAgentList()` entry
- `src/webview/setup.html` — missing Team Lead from `PROMPT_ROLES`; the previous draft incorrectly pointed this change at `implementation.html`
- `src/webview/kanban.html` — missing explicit `'team-lead': true` in `lastVisibleAgents`
- `src/services/TaskViewerProvider.ts` and `src/services/KanbanProvider.ts` — **Clarification:** clean-workspace default visibility maps still omit explicit `'team-lead': true`, so fresh state payloads are incomplete until the user manually saves settings

## Complexity Audit

### Routine
- Add `{ key: 'team-lead', label: 'Team Lead' }` to `const PROMPT_ROLES` in `src/webview/setup.html` after `analyst`
- Add a Team Lead onboarding checkbox + command row to `src/webview/implementation.html` after Analyst and before Jules, using `data-role="team-lead"` and `id="onboard-cli-team-lead"`
- Add a Team Lead Terminal Operations checkbox + command row to `src/webview/implementation.html` after Analyst and before Jules, using `data-role="team-lead"`
- Add `'team-lead': true` to the built-in `lastVisibleAgents` defaults in `src/webview/implementation.html` and `src/webview/kanban.html`
- Add `'team-lead': document.getElementById('onboard-cli-team-lead')` to the onboarding `startupCommands` rehydration map in `src/webview/implementation.html`
- Add `'team-lead': document.getElementById('onboard-cli-team-lead').value` to the onboarding `agents` save object in `src/webview/implementation.html`
- Add `'team-lead': true` to the onboarding `visibleAgents` default object in `src/webview/implementation.html`
- **Clarification:** add `team-lead` to the hard-coded onboarding guard role list and the sidebar `renderAgentList()` built-in role list in `src/webview/implementation.html` so the configured role actually appears as a dispatchable agent
- **Clarification:** add `'team-lead': true` to the clean-state defaults returned by `TaskViewerProvider.getVisibleAgents()` and `KanbanProvider._getVisibleAgents()`

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. All changes are synchronous template/default-map updates inside existing webview message flows. `saveStartupCommands` already persists arbitrary keyed role maps; this plan only ensures Team Lead is included everywhere the UI currently hard-codes built-in roles.
- **Security:** No new privileged path is introduced. The `team-lead` role uses the same `data-role` and string-key patterns as the other built-in roles. All hyphenated object keys must remain quoted (`'team-lead'`) to avoid accidental JavaScript expression parsing.
- **Side Effects:** Team Lead becomes visible in more places: onboarding, Terminal Operations, sidebar agent list, Kanban visibility state, and the Setup prompt-override modal. Existing saved `state.visibleAgents['team-lead']` values still win because every change merges defaults with persisted state instead of overwriting it.
- **Dependencies & Conflicts:**
  - **Depends on (already implemented):** "Add Team Lead Orchestrator Role" (`sess_1775781507496`, Reviewed column) — backend support already exists in `agentConfig.ts`, `TaskViewerProvider.ts`, `KanbanProvider.ts`, and `agentPromptBuilder.ts`.
  - **Low-risk same-file overlap** with "Add Git Ignore Strategy UI to Setup Menu" (`sess_1775819673136`, Planned) — both plans now touch `src/webview/setup.html`, but in different blocks (`PROMPT_ROLES` vs. the git-ignore subsection). Merge carefully if they land together.
  - **Potential conflict** with "Feature Plan: Add Acceptance Tester Role" (`sess_1775837845472`, New) — it also targets hard-coded built-in role lists/default visibility maps in `src/webview/implementation.html`, and it cites `PROMPT_ROLES` work that in reality belongs in `src/webview/setup.html`. If both land, merge carefully across shared role arrays/default objects.
  - No other New/Planned dependencies or conflicts were found in the active Kanban scan.

## Adversarial Synthesis
### Grumpy Critique
> Oh, fantastic — the draft says “add Team Lead to `PROMPT_ROLES` in `implementation.html`,” except `implementation.html` does not even contain `PROMPT_ROLES`. That array lives in `src/webview/setup.html`. So the very first step in the old draft sends the implementer into the wrong file before they have written a single line. Stellar start.
>
> And the omissions are not just cosmetic. If you only add two checkbox rows and call it done, the command does not round-trip through onboarding because `startupCommands` rehydration is hard-coded. The sidebar still ignores Team Lead because `renderAgentList()` is hard-coded. The onboarding “agents not connected” guard still ignores Team Lead because `allRoles` is hard-coded. That is how you end up with a role that technically exists, can maybe be saved once, and then mysteriously disappears from half the UI on reload.
>
> Also, stop pretending the missing provider defaults are harmless. Yes, today some code paths treat `undefined !== false` as visible. Other paths explicitly test membership (`role in lastVisibleAgents`) or merge state into built-in defaults before touching the DOM. A built-in role omitted from the built-in default maps is a latent bug, not a clever shortcut. Put `team-lead` in every built-in visibility default and be done with it.

### Balanced Response
Grumpy is right about the draft being incomplete, and the plan below corrects the actual implementation surface without expanding product scope:

1. **Wrong file path fixed:** the Team Lead custom-prompt tab change now targets `src/webview/setup.html`, which is where `PROMPT_ROLES` actually lives.
2. **Round-trip gaps closed:** the plan now covers the hard-coded onboarding load map, onboarding save object, onboarding visibility default, onboarding guard role list, and sidebar `renderAgentList()` role list in `src/webview/implementation.html`.
3. **Explicit built-in defaults restored:** both providers and both webviews now receive an explicit `'team-lead': true` built-in default, so clean-state behavior is deterministic instead of relying on missing-key fallthrough.
4. **Scope still constrained:** no new product behavior is introduced. These are all UI exposure and state-plumbing fixes for a built-in role that already exists in backend dispatch, Kanban column mapping, and prompt generation.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** All code blocks below show the complete, final state of the changed lines. No truncation. The implementation should follow the exact file paths shown here; do not recreate these changes in similarly named files.

### Setup prompt-override modal

#### [MODIFY] `src/webview/setup.html`

**Change 1 — Clarification: add Team Lead to `PROMPT_ROLES` in the real file (`setup.html`)**

- **Context:** The Custom Prompts modal is implemented in `src/webview/setup.html`, not in `src/webview/implementation.html`. Without this change, the Team Lead role cannot receive a prompt override tab even though backend prompt generation already supports `team-lead`.
- **Logic:** Append the Team Lead role after Analyst so it follows the existing built-in role order used by the Setup panel.
- **Implementation:**

Find:
```javascript
        const PROMPT_ROLES = [
            { key: 'planner', label: 'Planner' },
            { key: 'lead', label: 'Lead Coder' },
            { key: 'coder', label: 'Coder' },
            { key: 'reviewer', label: 'Reviewer' },
            { key: 'intern', label: 'Intern' },
            { key: 'analyst', label: 'Analyst' },
        ];
```

Replace with:
```javascript
        const PROMPT_ROLES = [
            { key: 'planner', label: 'Planner' },
            { key: 'lead', label: 'Lead Coder' },
            { key: 'coder', label: 'Coder' },
            { key: 'reviewer', label: 'Reviewer' },
            { key: 'intern', label: 'Intern' },
            { key: 'analyst', label: 'Analyst' },
            { key: 'team-lead', label: 'Team Lead' },
        ];
```

- **Edge Cases Handled:** The key matches the already-supported backend role string exactly, so prompt override save/load continues to use the existing `lastPromptOverrides` plumbing.

---

### Sidebar onboarding, Terminal Operations, and agent list

#### [MODIFY] `src/webview/implementation.html`

**Change 2 — Add `'team-lead': true` to built-in `lastVisibleAgents`**

- **Context:** `lastVisibleAgents` is the sidebar's built-in visibility baseline. The DOM sync logic later checks `role in lastVisibleAgents`, so Team Lead must exist explicitly in this object.
- **Logic:** Insert a quoted `'team-lead'` key before `jules`.
- **Implementation:**

Find:
```javascript
        let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, analyst: true, jules: true };
```

Replace with:
```javascript
        let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, analyst: true, 'team-lead': true, jules: true };
```

- **Edge Cases Handled:** Quoting the hyphenated key avoids the `team - lead` parsing bug and ensures later `role in lastVisibleAgents` checks succeed.

---

**Change 3 — Add Team Lead row to onboarding CLI setup**

- **Context:** The onboarding wizard is still the first place users configure built-in CLI roles. Team Lead needs a checkbox and command input here, or first-run setup cannot persist a Team Lead command.
- **Logic:** Insert the new row after Analyst and before Jules so the draft's existing ordering is preserved.
- **Implementation:**

Find:
```html
                <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="onboard-agent-toggle" data-role="analyst" checked
                        style="width:auto; margin:0; flex-shrink:0;">
                    <label style="min-width:70px;">Analyst</label><input type="text" id="onboard-cli-analyst"
                        placeholder="e.g. qwen" style="flex:1;">
                </div>
                <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="onboard-agent-toggle" data-role="jules" checked
                        style="width:auto; margin:0; flex-shrink:0;">
                    <label style="min-width:70px;">Jules</label>
                    <span style="flex:1; font-size: 10px; color: var(--text-secondary);">Cloud coder visibility
                        only</span>
                </div>
```

Replace with:
```html
                <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="onboard-agent-toggle" data-role="analyst" checked
                        style="width:auto; margin:0; flex-shrink:0;">
                    <label style="min-width:70px;">Analyst</label><input type="text" id="onboard-cli-analyst"
                        placeholder="e.g. qwen" style="flex:1;">
                </div>
                <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="onboard-agent-toggle" data-role="team-lead" checked
                        style="width:auto; margin:0; flex-shrink:0;">
                    <label style="min-width:70px;">Team Lead</label><input type="text" id="onboard-cli-team-lead"
                        placeholder="e.g. opencode" style="flex:1;">
                </div>
                <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="onboard-agent-toggle" data-role="jules" checked
                        style="width:auto; margin:0; flex-shrink:0;">
                    <label style="min-width:70px;">Jules</label>
                    <span style="flex:1; font-size: 10px; color: var(--text-secondary);">Cloud coder visibility
                        only</span>
                </div>
```

- **Edge Cases Handled:** The new row follows the existing `onboard-cli-{role}` ID convention and reuses the generic `.onboard-agent-toggle` collector that already drives visibility persistence.

---

**Change 4 — Add Team Lead row to Terminal Operations / AGENT VISIBILITY & CLI COMMANDS**

- **Context:** This is the post-onboarding configuration surface users revisit from the sidebar. Team Lead must appear here or the role remains hidden from the only everyday built-in role configuration list.
- **Logic:** Insert the new row after Analyst and before Jules, matching the onboarding row placement and preserving the existing draft's ordering.
- **Implementation:**

Find:
```html
                <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="agent-visible-toggle" data-role="analyst" checked
                        style="width:auto; margin:0; flex-shrink:0;">
                    <label style="min-width:70px;">Analyst</label><input type="text" data-role="analyst"
                        placeholder="e.g. qwen" style="flex:1;">
                </div>
                <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="agent-visible-toggle" data-role="jules" checked
                        style="width:auto; margin:0; flex-shrink:0;">
                    <label style="min-width:70px;">Jules</label>
                    <span style="flex:1; font-size: 10px; color: var(--text-secondary);">Cloud coder visibility
                        only</span>
                </div>
```

Replace with:
```html
                <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="agent-visible-toggle" data-role="analyst" checked
                        style="width:auto; margin:0; flex-shrink:0;">
                    <label style="min-width:70px;">Analyst</label><input type="text" data-role="analyst"
                        placeholder="e.g. qwen" style="flex:1;">
                </div>
                <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="agent-visible-toggle" data-role="team-lead" checked
                        style="width:auto; margin:0; flex-shrink:0;">
                    <label style="min-width:70px;">Team Lead</label><input type="text" data-role="team-lead"
                        placeholder="e.g. opencode" style="flex:1;">
                </div>
                <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="agent-visible-toggle" data-role="jules" checked
                        style="width:auto; margin:0; flex-shrink:0;">
                    <label style="min-width:70px;">Jules</label>
                    <span style="flex:1; font-size: 10px; color: var(--text-secondary);">Cloud coder visibility
                        only</span>
                </div>
```

- **Edge Cases Handled:** No extra save logic is required here because the sidebar already collects `document.querySelectorAll('input[type="text"][data-role]')` and `.agent-visible-toggle` dynamically.

---

**Change 5 — Add Team Lead to onboarding `startupCommands` rehydration**

- **Context:** Loading saved startup commands into onboarding fields is hard-coded; adding the input row alone is insufficient.
- **Logic:** Extend `onboardingFields` with a quoted `'team-lead'` entry referencing `onboard-cli-team-lead`.
- **Implementation:**

Find:
```javascript
                        const onboardingFields = {
                            lead: document.getElementById('onboard-cli-lead'),
                            coder: document.getElementById('onboard-cli-coder'),
                            reviewer: document.getElementById('onboard-cli-reviewer'),
                            planner: document.getElementById('onboard-cli-planner'),
                            analyst: document.getElementById('onboard-cli-analyst')
                        };
```

Replace with:
```javascript
                        const onboardingFields = {
                            lead: document.getElementById('onboard-cli-lead'),
                            coder: document.getElementById('onboard-cli-coder'),
                            reviewer: document.getElementById('onboard-cli-reviewer'),
                            planner: document.getElementById('onboard-cli-planner'),
                            analyst: document.getElementById('onboard-cli-analyst'),
                            'team-lead': document.getElementById('onboard-cli-team-lead')
                        };
```

- **Edge Cases Handled:** Saved Team Lead commands now survive reloads/reopened onboarding instead of resetting to blank while other roles rehydrate correctly.

---

**Change 6 — Add Team Lead to onboarding `agents` save payload**

- **Context:** Onboarding command persistence is also hard-coded. Without this change, the Team Lead input exists in the DOM but never reaches `saveStartupCommands`.
- **Logic:** Add a quoted `'team-lead'` entry to the `agents` object.
- **Implementation:**

Find:
```javascript
            const agents = {
                lead: document.getElementById('onboard-cli-lead').value,
                coder: document.getElementById('onboard-cli-coder').value,
                intern: document.getElementById('onboard-cli-intern').value,
                reviewer: document.getElementById('onboard-cli-reviewer').value,
                planner: document.getElementById('onboard-cli-planner').value,
                analyst: document.getElementById('onboard-cli-analyst').value
            };
```

Replace with:
```javascript
            const agents = {
                lead: document.getElementById('onboard-cli-lead').value,
                coder: document.getElementById('onboard-cli-coder').value,
                intern: document.getElementById('onboard-cli-intern').value,
                reviewer: document.getElementById('onboard-cli-reviewer').value,
                planner: document.getElementById('onboard-cli-planner').value,
                analyst: document.getElementById('onboard-cli-analyst').value,
                'team-lead': document.getElementById('onboard-cli-team-lead').value
            };
```

- **Edge Cases Handled:** Empty input still saves as `""`, matching existing role behavior. The key remains quoted, so the payload shape matches persisted state and backend dispatch expectations.

---

**Change 7 — Add Team Lead to onboarding `visibleAgents` default object**

- **Context:** The onboarding visibility object seeds checkbox state before iterating `.onboard-agent-toggle`. Team Lead needs an explicit built-in default just like the other built-in roles.
- **Logic:** Insert a quoted `'team-lead': true` key.
- **Implementation:**

Find:
```javascript
            const visibleAgents = { lead: true, coder: true, intern: true, reviewer: true, planner: true, analyst: true, jules: true };
```

Replace with:
```javascript
            const visibleAgents = { lead: true, coder: true, intern: true, reviewer: true, planner: true, analyst: true, 'team-lead': true, jules: true };
```

- **Edge Cases Handled:** This keeps Team Lead aligned with the same default-checked onboarding behavior as the other built-in CLI roles.

---

**Change 8 — Clarification: add Team Lead to the onboarding guard's `allRoles` list**

- **Context:** The “Agents not connected” guard only counts hard-coded built-in terminal roles. If Team Lead is omitted here, a visible Team Lead terminal never contributes to the green-agent count.
- **Logic:** Add `team-lead` to the `allRoles` array with bracket notation on the visibility lookup.
- **Implementation:**

Find:
```javascript
                const allRoles = [
                    ...(va.planner !== false ? ['planner'] : []),
                    ...(va.lead !== false ? ['lead'] : []),
                    ...(va.coder !== false ? ['coder'] : []),
                    ...(va.intern !== false ? ['intern'] : []),
                    ...(va.reviewer !== false ? ['reviewer'] : []),
                    ...(va.analyst !== false ? ['analyst'] : []),
                    ...lastCustomAgents.filter(a => va[a.role] !== false).map(a => a.role)
                ];
```

Replace with:
```javascript
                const allRoles = [
                    ...(va.planner !== false ? ['planner'] : []),
                    ...(va.lead !== false ? ['lead'] : []),
                    ...(va['team-lead'] !== false ? ['team-lead'] : []),
                    ...(va.coder !== false ? ['coder'] : []),
                    ...(va.intern !== false ? ['intern'] : []),
                    ...(va.reviewer !== false ? ['reviewer'] : []),
                    ...(va.analyst !== false ? ['analyst'] : []),
                    ...lastCustomAgents.filter(a => va[a.role] !== false).map(a => a.role)
                ];
```

- **Edge Cases Handled:** A visible Team Lead terminal now correctly suppresses the false “Agents not connected” onboarding fallback.

---

**Change 9 — Clarification: add a Team Lead row to `renderAgentList()`**

- **Context:** The sidebar agent list is hard-coded for built-in agents. Even after saving a Team Lead command, users still cannot dispatch to Team Lead until this row exists.
- **Logic:** Insert a Team Lead row after Analyst and before custom agents so the draft's existing “after Analyst” placement stays consistent across configuration and dispatch surfaces.
- **Implementation:**

Find:
```javascript
            // 5. Analyst (unchanged position)
            if (va.analyst !== false) {
                agentListStandard.appendChild(createAnalystRow());
                // Restore analyst input state after re-render
                if (analystSnapshot.value || analystSnapshot.focused) {
                    const inp = document.getElementById('analyst-input');
                    if (inp) {
                        inp.value = analystSnapshot.value;
                        if (analystSnapshot.focused) {
                            inp.focus();
                            inp.selectionStart = analystSnapshot.selStart;
                            inp.selectionEnd = analystSnapshot.selEnd;
                        }
                    }
                }
            }

            for (const customAgent of lastCustomAgents) {
```

Replace with:
```javascript
            // 5. Analyst (unchanged position)
            if (va.analyst !== false) {
                agentListStandard.appendChild(createAnalystRow());
                // Restore analyst input state after re-render
                if (analystSnapshot.value || analystSnapshot.focused) {
                    const inp = document.getElementById('analyst-input');
                    if (inp) {
                        inp.value = analystSnapshot.value;
                        if (analystSnapshot.focused) {
                            inp.focus();
                            inp.selectionStart = analystSnapshot.selStart;
                            inp.selectionEnd = analystSnapshot.selEnd;
                        }
                    }
                }
            }

            // 5b. Team Lead
            if (va['team-lead'] !== false) {
                agentListStandard.appendChild(createAgentRow('TEAM LEAD', 'team-lead',
                    'START CODING',
                    terminals => Object.keys(terminals).find(key => terminals[key].role === 'team-lead')
                ));
            }

            for (const customAgent of lastCustomAgents) {
```

- **Edge Cases Handled:** The new row reuses `createAgentRow()` and the existing backend dispatch path for `role === 'team-lead'`, so no new click-handler branch is needed.

---

### Kanban visibility baseline

#### [MODIFY] `src/webview/kanban.html`

**Change 10 — Add `'team-lead': true` to Kanban `lastVisibleAgents`**

- **Context:** Kanban column visibility reads `lastVisibleAgents[role] !== false`. Team Lead should be present explicitly in the same built-in default map used by the other built-in columns.
- **Logic:** Insert a quoted `'team-lead'` key before `jules`.
- **Implementation:**

Find:
```javascript
        let lastVisibleAgents = { lead: true, coder: true, intern: true, reviewer: true, planner: true, analyst: true, jules: true };
```

Replace with:
```javascript
        let lastVisibleAgents = { lead: true, coder: true, intern: true, reviewer: true, planner: true, analyst: true, 'team-lead': true, jules: true };
```

- **Edge Cases Handled:** This keeps Team Lead aligned with `isColumnAgentVisible()` and avoids relying on missing-key fallthrough for a built-in column.

---

### Sidebar/state providers

#### [MODIFY] `src/services/TaskViewerProvider.ts`

**Change 11 — Clarification: add `'team-lead': true` to `getVisibleAgents()` defaults**

- **Context:** The sidebar webview receives visible-agent state from `TaskViewerProvider.getVisibleAgents()`. Clean workspaces should return a complete built-in role map instead of omitting Team Lead.
- **Logic:** Add Team Lead to the `defaults` object only; persisted `state.visibleAgents` values continue to override this baseline.
- **Implementation:**

Find:
```typescript
        const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, planner: true, analyst: true, jules: true };
```

Replace with:
```typescript
        const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, planner: true, analyst: true, 'team-lead': true, jules: true };
```

- **Edge Cases Handled:** Existing saved false values still win because the method returns `{ ...defaults, ...state.visibleAgents }`.

---

#### [MODIFY] `src/services/KanbanProvider.ts`

**Change 12 — Clarification: add `'team-lead': true` to `_getVisibleAgents()` defaults**

- **Context:** The Kanban webview gets its visible-agent state from `KanbanProvider._getVisibleAgents()`. This default should match the sidebar provider so both webviews behave identically on fresh state.
- **Logic:** Add Team Lead to the built-in `defaults` object only.
- **Implementation:**

Find:
```typescript
        const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, planner: true, analyst: true, jules: true };
```

Replace with:
```typescript
        const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, planner: true, analyst: true, 'team-lead': true, jules: true };
```

- **Edge Cases Handled:** This aligns Kanban with the sidebar and preserves the current merge behavior for saved visibility state and custom-agent defaults.

## Files to Modify

| File | Changes |
|------|---------|
| `src/webview/setup.html` | Add Team Lead to `PROMPT_ROLES` — **1 change** |
| `src/webview/implementation.html` | Add Team Lead onboarding/setup rows, defaults, onboarding load/save plumbing, onboarding guard role entry, and sidebar agent row — **8 changes** |
| `src/webview/kanban.html` | Add Team Lead to Kanban `lastVisibleAgents` default — **1 change** |
| `src/services/TaskViewerProvider.ts` | Add Team Lead to sidebar visible-agent defaults — **1 change** |
| `src/services/KanbanProvider.ts` | Add Team Lead to Kanban visible-agent defaults — **1 change** |

**Total: 12 changes across 5 files.**

## Verification Plan

### Automated Tests
- Run `npx tsc --noEmit`
- Run `npm run compile`
- Confirm any existing backend `team-lead` coverage still passes; note that no current automated test exercises the webview HTML role rows, so the manual checks below remain required

### Manual Verification
- [ ] On a clean workspace with no explicit `visibleAgents` entry in `.switchboard/state.json`, open the sidebar and confirm Team Lead appears checked by default in onboarding and Terminal Operations
- [ ] Save a Team Lead command from onboarding, reload the sidebar, and confirm both `onboard-cli-team-lead` and the Terminal Operations `data-role="team-lead"` input rehydrate with the saved value
- [ ] Register a terminal with `role === 'team-lead'` and confirm the sidebar shows a dedicated `TEAM LEAD` row with the standard locate/dispatch controls
- [ ] Leave only Team Lead visible and connected; confirm the onboarding “Agents not connected” fallback does not appear after the grace period
- [ ] Open the Setup panel, launch the Custom Prompts modal, and confirm a `Team Lead` tab is present and saves prompt overrides correctly
- [ ] Toggle Team Lead off in sidebar settings and confirm the Kanban Team Lead column is hidden when empty, then toggle it back on and confirm it reappears
- [ ] Confirm there are no JavaScript console errors from unquoted `team-lead` object keys

## Recommended Agent
**Send to Coder**

## Reviewer Execution

### Stage 1 - Grumpy Principal Engineer
> Nice job adding the Team Lead row, then immediately hiding it everywhere that actually matters. The plan explicitly says clean-state defaults must be `'team-lead': true` and the Team Lead checkboxes should ship checked; the implementation hard-coded `'team-lead': false` in `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/implementation.html`, and `src/webview/kanban.html`, and the regression test locked that wrong behavior in place.
>
> That means fresh workspaces still suppress Team Lead until users manually discover and enable it, which is exactly the bug this plan was supposed to remove. This is not a nit. It is a direct contradiction of the plan's clean-state/default-visibility requirements, and it leaves the role technically wired up but still invisible by default in the first-run path.

### Stage 2 - Balanced Synthesis
The main Team Lead plumbing was already present: `setup.html` already exposed Team Lead in `PROMPT_ROLES`, `implementation.html` already had the onboarding/Terminal Operations rows, onboarding rehydration/save wiring, onboarding guard inclusion, and sidebar `TEAM LEAD` row, and backend column/dispatch support remained intact. The material defect was limited to default visibility behavior.

I corrected the clean-state defaults to make Team Lead explicitly visible by default in both providers and both webviews, pre-checked the Team Lead onboarding and Terminal Operations checkboxes to match the plan, and updated the regression test to assert the intended behavior instead of the incorrect hidden-by-default state. No extra product scope was added beyond enforcing the plan's stated review criteria.

### Fixed Items
- Changed Team Lead clean-state visibility defaults from `'team-lead': false` to `'team-lead': true` in:
  - `src/services/TaskViewerProvider.ts`
  - `src/services/KanbanProvider.ts`
  - `src/webview/implementation.html`
  - `src/webview/kanban.html`
- Pre-checked the Team Lead onboarding checkbox in `src/webview/implementation.html`.
- Pre-checked the Team Lead Terminal Operations checkbox in `src/webview/implementation.html`.
- Updated `src/test/team-lead-visibility-defaults-regression.test.js` to validate the reviewed behavior:
  - Team Lead visible by default
  - Team Lead checkboxes pre-checked
  - Team Lead present in `setup.html` prompt roles
  - Team Lead included in onboarding guard logic and sidebar agent rendering

### Files Changed During Review Pass
- `.switchboard/plans/fix_team_lead_ui_visibility.md`
- `src/services/KanbanProvider.ts`
- `src/services/TaskViewerProvider.ts`
- `src/test/team-lead-visibility-defaults-regression.test.js`
- `src/webview/implementation.html`
- `src/webview/kanban.html`

### Validation Results
- ✅ `node src/test/team-lead-visibility-defaults-regression.test.js`
  - Result: `team lead visibility defaults regression test passed`
- ✅ `node src/test/builtin-role-dispatch-coverage.test.js`
  - Result: `8 passed, 0 failed`
- ✅ `npm run compile`
  - Result: webpack compile succeeded for extension and MCP server bundles
- ❌ `npx tsc --noEmit`
  - Pre-existing failure unrelated to this review pass: `src/services/KanbanProvider.ts:2197` dynamic import `await import('./ArchiveManager')` needs an explicit `.js` extension under the current TypeScript module resolution settings
- ❌ `npm run lint -- --quiet`
  - Pre-existing repo/config failure: ESLint 9 cannot find an `eslint.config.(js|mjs|cjs)` file

### Remaining Risks
- Manual verification from the plan was not executed in this CLI-only review pass, so the live VS Code behaviors (prompt modal tab rendering, sidebar row interaction, onboarding fallback suppression, and Kanban hide/show interaction) remain manually unverified.
- Repository-wide `tsc` and `eslint` failures still prevent a fully clean validation run, although the failures observed were pre-existing and unrelated to the Team Lead visibility fixes.
