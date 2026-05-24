# Add Agent Descriptions to Prompts Tab Dropdown

## Goal
Display a dynamic description beneath the role selector dropdown in the Prompts tab of `kanban.html`, matching the descriptions already shown in the Agents tab, and updating automatically when the user changes the selected role.

## Metadata
- **Tags:** frontend, UI, UX
- **Complexity:** 3

## User Review Required
None — this is a self-contained UI enhancement with no backend changes and no breaking surface area.

## Complexity Audit

### Routine
- Adding a single `<div>` element after an existing `<select>` element (HTML-only change)
- Adding a static `const` object (`ROLE_DESCRIPTIONS`) with string values
- Adding a small helper function `updateRoleDescription()` with 3–4 lines of logic
- Calling the helper in three existing event/handler locations

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions**
- `loadRoleConfigs()` fires async `getSetting` messages. When the prompts tab hydrates, calling `updateRoleDescription()` immediately after `loadRoleConfigs()` may show the default `planner` description before the saved role is restored. This self-corrects when `settingResult` fires and calls `updateRoleDescription()` again.  
- *Mitigation:* No action needed — the async self-correction is sufficient for a non-critical UI label.

**Security**
- None — only static string content written via `textContent` (no innerHTML).

**Side Effects**
- The `.agent-description` CSS class already has `margin-left: 22px`. The new element must override `margin-left: 0` via inline style to prevent misalignment inside the Role Selector section. This is a targeted inline override and does not affect agents-tab usage of the class.

**Dependencies & Conflicts**
- `ROLE_DESCRIPTIONS` and `updateRoleDescription()` must be declared at **module scope** in the Prompts Tab JS section (not inside `initPromptsTabListeners`). If scoped inside `initPromptsTabListeners`, the function will be inaccessible from the `settingResult` message handler at line ~4634. This is the primary scoping risk.
- Custom agent roles (populated dynamically into `customAgentsGroup`) will not have entries in `ROLE_DESCRIPTIONS`. The helper must explicitly clear the description element when no entry is found — no stale text from a previous selection.

## Dependencies
- None (no cross-plan dependencies)

## Adversarial Synthesis
Key risks: (1) Scoping — `updateRoleDescription()` must be module-scoped, not closure-scoped inside `initPromptsTabListeners`, to be reachable from the `settingResult` handler; (2) custom agents — the helper must fall back to empty string when `ROLE_DESCRIPTIONS[currentRole]` is undefined. Mitigations: declare both `ROLE_DESCRIPTIONS` and `updateRoleDescription` at the top of the Prompts Tab JS block; use `|| ''` fallback in the helper body.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

#### Context
- Prompts tab role selector HTML: lines ~2130–2150
- Prompts Tab JS block opens at line ~2420
- `initPromptsTabListeners()` defined at line ~2957
- `settingResult` message handler at line ~4628

#### Step 1 — Add description display element (HTML, ~line 2148)

After the closing `</select>` tag (line 2148) and before `</div>` (line 2149), insert:

```html
<div id="roleDescription" class="agent-description" style="margin-top: 8px; margin-left: 0;"></div>
```

Full target context:
```html
          </select>
          <!-- INSERT HERE -->
          </div>
```

#### Step 2 — Add `ROLE_DESCRIPTIONS` const and `updateRoleDescription()` at module scope (~line 2422)

Insert immediately after `let roleConfigs = JSON.parse(JSON.stringify(DEFAULT_CONFIG));` (line 2425):

```javascript
const ROLE_DESCRIPTIONS = {
  planner: 'Writes detailed step-by-step implementation plans and creates work checklists.',
  lead: 'Implements high-complexity files, complex refactors, and core architecture changes.',
  coder: 'Implements low-complexity boilerplate, routine functions, and minor enhancements.',
  intern: 'Executes simple, repetitive code edits and heavily guided tasks at lowest cost.',
  reviewer: 'Evaluates completed implementations against plans, checking for regressions and scope creep.',
  tester: 'Validates implemented changes against the Design Doc/PRD, applies fixes for requirement gaps, and logs verification results.',
  analyst: 'Researches general-purpose technical queries and outlines plan dependencies.',
  ticket_updater: 'Synchronizes plan state and comments back to connected project management systems (e.g. ClickUp/Linear).',
  researcher: 'Conducts semantic code searches and web research to discover necessary implementation context.',
  research_planner: 'Scopes complex multi-part plans by gathering extensive context using deep research.',
  splitter: 'Segregates planned files into distinct routine and complex task batches.',
  gatherer: 'Aggregates codebase files, directory structure, and relevant symbols into the active prompt context.',
  jules: 'Offloads tasks to Google Jules cloud-coding service for quota-free background execution.'
};

function updateRoleDescription() {
  const descEl = document.getElementById('roleDescription');
  if (descEl) {
    descEl.textContent = ROLE_DESCRIPTIONS[currentRole] || '';
  }
}
```

> **Clarification:** Declaring at module scope (not inside `initPromptsTabListeners`) is required so the function is reachable from the `settingResult` handler and the tab hydration block.

#### Step 3 — Call `updateRoleDescription()` in the role change listener (~line 2960–2964)

Target the existing change listener inside `initPromptsTabListeners()`:

```javascript
// BEFORE
roleSelect.addEventListener('change', (e) => {
    currentRole = e.target.value;
    handleRoleChange();
    postKanbanMessage({ type: 'saveSetting', key: 'selectedRole', value: currentRole });
});

// AFTER
roleSelect.addEventListener('change', (e) => {
    currentRole = e.target.value;
    handleRoleChange();
    updateRoleDescription();
    postKanbanMessage({ type: 'saveSetting', key: 'selectedRole', value: currentRole });
});
```

#### Step 4 — Call `updateRoleDescription()` after role restore in `settingResult` handler (~line 4634)

Target:
```javascript
// BEFORE
if (roleSelect) roleSelect.value = value;
        }
        handleRoleChange();

// AFTER
if (roleSelect) roleSelect.value = value;
        }
        handleRoleChange();
        updateRoleDescription();
```

#### Step 5 — Call `updateRoleDescription()` during prompts tab hydration (~line 2938–2941)

Target:
```javascript
// BEFORE
if (tabName === 'prompts') {
  postKanbanMessage({ type: 'getCustomAgents' });
  loadRoleConfigs();
}

// AFTER
if (tabName === 'prompts') {
  postKanbanMessage({ type: 'getCustomAgents' });
  loadRoleConfigs();
  updateRoleDescription();
}
```

## Verification Plan

### Automated Tests
- None (UI-only change in a webview HTML file with no unit test harness).

### Manual Verification
1. Open the Kanban webview panel in VS Code.
2. Navigate to the **Prompts** tab.
3. Confirm a description appears below the role dropdown for the default **Planner** role: `"Writes detailed step-by-step implementation plans and creates work checklists."`
4. Change the dropdown to **Coder** — confirm description updates to the Coder text.
5. Change to **Reviewer**, **Analyst**, **Ticket Updater**, **Research Planner** — confirm each description updates correctly.
6. If custom agents exist, select one — confirm the description area is **blank** (not stale from previous selection).
7. Close and reopen the Prompts tab — confirm the correct description is shown for the restored role.
8. Open the **Agents** tab and confirm the descriptions match exactly.

---

**Recommendation: Send to Intern**

---
## Review Results

### Stage 1 (Grumpy)
**CRITICAL:** The `settingResult` case block syntax was completely mangled during the implementation of Step 4. The agent correctly inserted `updateRoleDescription()` into the `if (key === 'selectedRole')` block but inexplicably deleted the closing brace `}` for the subsequent `} else if (key.startsWith('roleConfig_')) {` block. This caused a catastrophic `SyntaxError: Unexpected token 'case'` when the webview parses the Javascript, entirely breaking the Kanban board.
**NIT:** The `ROLE_DESCRIPTIONS` const and helper function are placed correctly, but introducing major syntax errors into a single-file webview is unacceptable. 

### Stage 2 (Balanced)
The logic additions perfectly match the plan. The scoping risk was identified and correctly handled. The inline styles for `.agent-description` override were applied correctly to prevent misalignment. The only issue was the botched text replacement that corrupted the switch/case syntax, which would have destroyed the webview's execution. 

### Fixes Applied
- **src/webview/kanban.html:** Restored the missing closing brace `}` before the `break;` inside the `case 'settingResult':` block. 
- Re-ran `node -c` on the extracted script content and verified there are zero syntax errors remaining.

### Validation
All logical requirements have been met and the severe syntax regression has been corrected. The plan is successfully complete.
