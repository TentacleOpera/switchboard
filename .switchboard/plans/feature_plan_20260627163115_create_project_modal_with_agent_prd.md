# Replace Create Project VS Code Popup with In-Webview Modal + Agent PRD Generation

## Goal

### Problem Statement
The "Create Project" button (`#btn-add-project`) in `kanban.html` currently posts an `addProject` message to `KanbanProvider.ts`, which handles it by calling `vscode.window.showInputBox()` — a native VS Code popup that only accepts a plain project name. This is inconsistent with the premium in-webview modal UX used elsewhere in the kanban board (e.g. Testing Fail Modal, Routing Map Modal, Integration Settings Modal, Custom Agent Modal). More critically, there is no option during project creation to have an agent auto-generate a PRD that would appear in the `project.html` Projects tab's PRD editor.

### Root Cause
1. **`KanbanProvider.ts` line 5322**: The `addProject` case uses `vscode.window.showInputBox()` — a minimal VS Code native input — instead of rendering an in-webview modal with richer fields.
2. **No PRD generation flow exists**: The per-project PRD system (stored at `.switchboard/projects/<slug>/prd.md`, managed via `prdUtils.ts`) only supports manual editing in `project.html`'s textarea. There is no "Generate PRD" trigger that dispatches to an agent.

### What Success Looks Like
- Clicking the `+` button next to the project dropdown opens a styled in-webview modal (matching existing modal patterns in `kanban.html`).
- The modal contains: project name input, optional project description textarea, and a "Generate PRD with Agent" checkbox/button.
- On submit, the project is created in the database AND, if the user opted in, a PRD generation task is dispatched to an agent terminal, with the resulting PRD saved to `.switchboard/projects/<slug>/prd.md` and visible in the Projects tab.

## Metadata
- **Tags**: `kanban`, `project`, `modal`, `prd`, `ux`, `agent-dispatch`
- **Complexity**: 7/10

## Complexity Audit

| Aspect | Classification | Rationale |
|--------|----------------|-----------|
| Modal HTML/CSS | Routine | Kanban.html has 5+ modal patterns to copy (Testing Fail, Routing Map, Integration Settings, Custom Agent, etc.) — all use `.modal-overlay` / `.modal-content` / `.modal-header` / `.modal-body` / `.modal-footer` structure |
| Frontend JS (webview) | Routine | Button click → show modal → gather inputs → `postKanbanMessage()`. Pattern is identical to testing-fail-modal flow |
| Backend handler refactor | Routine | Replace `showInputBox()` with webview message handling. Same pattern as every other modal in KanbanProvider |
| Agent PRD dispatch | **Complex/Risky** | No existing "generate PRD" flow exists. Must compose a prompt, find/create a terminal, send the prompt, and wire a watcher to pick up the resulting `prd.md` file. Needs to integrate with the existing prompt dispatch system and terminal rotation logic |
| PRD file watcher | Moderate | `prdUtils.ts` already knows the path convention. The Projects tab in `project.js` already handles `projectPrdContent` messages. May need a file watcher or a one-shot read-after-dispatch |
| Cross-panel sync | Moderate | After PRD generation, the Projects tab in `project.html` must reflect the new content. The `allWorkspaceProjects` cache invalidation + refresh already exists (line 5332) |

## Edge-Case & Dependency Audit

1. **Empty project name**: Validate client-side before enabling submit button (mirror the `showInputBox` `validateInput` logic).
2. **Duplicate project name**: The DB `addProject()` method should handle this — verify it doesn't throw but instead shows a user-friendly error.
3. **Agent PRD dispatch without registered terminals**: If no planner/coder terminals are registered, the "Generate PRD" option must be disabled or show a warning. Check `_terminalAgentInfo` availability.
4. **Workspace context**: The modal must respect the currently selected workspace from the dropdown (`workspace-project-select`), same as the current `addProject` handler does.
5. **Claudify theme**: All new modal elements must work with both Afterburner (teal) and Claudify (terracotta) themes. The existing `.modal-*` CSS classes already have Claudify overrides.
6. **Long-running PRD generation**: The modal should close immediately after dispatching; a status message or sub-bar notification should indicate PRD generation is in progress.
7. **PRD generation prompt**: Must include project name, optional description, and workspace context to produce a useful PRD. Should reference the existing PRD template format used in `project.html`.

## Proposed Changes

---

### Component 1: Modal HTML (kanban.html)

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

**Add a new "Create Project" modal** after the existing modals (near line 3074, after the integration-settings-modal). Use the established `.modal-overlay` / `.modal-content` pattern.

```html
<!-- Create Project Modal -->
<div id="create-project-modal" class="modal-overlay hidden">
    <div class="modal-content">
        <div class="modal-header">
            <h3 class="modal-title">Create Project</h3>
            <button class="modal-close-btn" id="create-project-close">&times;</button>
        </div>
        <div class="modal-body">
            <label class="modal-label" for="create-project-name">Project name</label>
            <input id="create-project-name" class="modal-input" type="text" 
                   placeholder="e.g. frontend, backend, infrastructure"
                   autocomplete="off">
            <label class="modal-label" for="create-project-description">Description (optional — used as context for PRD generation)</label>
            <textarea id="create-project-description" class="modal-textarea" rows="4"
                      placeholder="Brief description of the project's purpose, target users, key features..."></textarea>
            <label class="checkbox-label">
                <input type="checkbox" id="create-project-generate-prd">
                Generate PRD with agent — the PRD will appear in the Projects tab
            </label>
        </div>
        <div class="modal-footer">
            <button class="modal-btn modal-btn-secondary" id="create-project-cancel">Cancel</button>
            <button class="modal-btn modal-btn-primary" id="create-project-submit" disabled>Create Project</button>
        </div>
    </div>
</div>
```

**No new CSS needed** — all classes (`.modal-overlay`, `.modal-content`, `.modal-header`, `.modal-body`, `.modal-footer`, `.modal-input`, `.modal-textarea`, `.modal-label`, `.checkbox-label`, `.modal-btn-primary`, `.modal-btn-secondary`) already exist and are Claudify-aware.

---

### Component 2: Modal JS Logic (kanban.html `<script>`)

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

**Replace the existing `btnAddProject` click handler** (lines 3792–3797) to open the modal instead of posting a message directly:

```javascript
// REPLACE the existing handler:
btnAddProject?.addEventListener('click', () => {
    const select = document.getElementById('workspace-project-select');
    const selectedOption = select?.selectedOptions?.[0];
    const workspaceRoot = selectedOption?.dataset?.workspaceRoot || currentWorkspaceRoot;
    
    // Store workspace root for the modal submit handler
    const modal = document.getElementById('create-project-modal');
    if (modal) {
        modal.dataset.workspaceRoot = workspaceRoot;
        document.getElementById('create-project-name').value = '';
        document.getElementById('create-project-description').value = '';
        document.getElementById('create-project-generate-prd').checked = false;
        document.getElementById('create-project-submit').disabled = true;
        modal.classList.remove('hidden');
        document.getElementById('create-project-name').focus();
    }
});
```

**Add modal interaction handlers** (after the existing modal handler blocks):

```javascript
// Create Project Modal handlers
(function initCreateProjectModal() {
    const modal = document.getElementById('create-project-modal');
    const nameInput = document.getElementById('create-project-name');
    const descInput = document.getElementById('create-project-description');
    const generatePrdCheckbox = document.getElementById('create-project-generate-prd');
    const submitBtn = document.getElementById('create-project-submit');
    const cancelBtn = document.getElementById('create-project-cancel');
    const closeBtn = document.getElementById('create-project-close');
    
    if (!modal || !nameInput || !submitBtn) return;
    
    function closeModal() {
        modal.classList.add('hidden');
    }
    
    // Enable submit only when name is non-empty
    nameInput.addEventListener('input', () => {
        submitBtn.disabled = !nameInput.value.trim();
    });
    
    // Enter key submits if name is valid
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && nameInput.value.trim()) {
            submitBtn.click();
        }
    });
    
    // Escape closes
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
    
    // Close buttons
    cancelBtn?.addEventListener('click', closeModal);
    closeBtn?.addEventListener('click', closeModal);
    
    // Backdrop click closes
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });
    
    // Submit
    submitBtn.addEventListener('click', () => {
        const projectName = nameInput.value.trim();
        if (!projectName) return;
        
        const workspaceRoot = modal.dataset.workspaceRoot || currentWorkspaceRoot;
        const description = descInput?.value?.trim() || '';
        const generatePrd = generatePrdCheckbox?.checked || false;
        
        postKanbanMessage({
            type: 'addProject',
            workspaceRoot,
            projectName,
            description,
            generatePrd
        });
        
        closeModal();
    });
})();
```

---

### Component 3: Backend Handler (KanbanProvider.ts)

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

**Replace the `addProject` case** (lines 5319–5337) to accept the project name from the message payload (no more `showInputBox`) and optionally dispatch a PRD generation task:

```typescript
case 'addProject': {
    const workspaceRoot = msg.workspaceRoot || this._currentWorkspaceRoot;
    if (!workspaceRoot) break;

    // Accept projectName from the webview modal payload (no more showInputBox)
    const projectName = typeof msg.projectName === 'string' ? msg.projectName.trim() : '';
    if (!projectName) {
        // Fallback for legacy callers that don't send projectName (shouldn't happen)
        break;
    }

    const workspaceId = await this._readWorkspaceId(workspaceRoot);
    if (!workspaceId) break;

    const db = this._getKanbanDb(workspaceRoot);
    await db.addProject(workspaceId, projectName);
    this._allWorkspaceProjectsCache = null;
    await this._refreshBoard(workspaceRoot);

    // Optional: generate PRD via agent dispatch
    if (msg.generatePrd) {
        const description = typeof msg.description === 'string' ? msg.description.trim() : '';
        await this._dispatchPrdGeneration(workspaceRoot, projectName, description);
    }
    break;
}
```

**Add a new private method `_dispatchPrdGeneration`** to KanbanProvider:

```typescript
/**
 * Dispatch a PRD-generation prompt to an available planner terminal.
 * The agent writes the PRD to .switchboard/projects/<slug>/prd.md,
 * which the Projects tab will pick up on next refresh.
 */
private async _dispatchPrdGeneration(
    workspaceRoot: string,
    projectName: string,
    description: string
): Promise<void> {
    const { getProjectPrdPath } = await import('./prdUtils');
    const prdPath = getProjectPrdPath(workspaceRoot, projectName);
    
    const prompt = [
        `You are a product requirements document (PRD) writer.`,
        `Create a concise but comprehensive PRD for the project "${projectName}".`,
        description ? `\nProject description: ${description}` : '',
        `\nWrite the PRD in markdown format and save it to: ${prdPath}`,
        `\nThe PRD should include:`,
        `- Project overview and purpose`,
        `- Target users / audience`,
        `- Core features and requirements`,
        `- Non-functional requirements (performance, security, etc.)`,
        `- Success criteria`,
        `- Out of scope items`,
        `\nKeep it practical and actionable. This PRD will be injected into agent prompts as project context.`,
    ].filter(Boolean).join('\n');

    // Use the existing terminal dispatch infrastructure
    // Find a planner terminal or fall back to any available terminal
    try {
        const terminals = this._taskViewerProvider?.getRegisteredTerminals?.() || [];
        const plannerTerminal = terminals.find(t => 
            t.role === 'planner' || t.role === 'lead'
        ) || terminals[0];
        
        if (plannerTerminal) {
            await this._taskViewerProvider?.sendTextToTerminal?.(
                plannerTerminal.id, 
                prompt
            );
            this._showStatusMessage(`PRD generation dispatched for "${projectName}" — check the Projects tab shortly.`);
        } else {
            // No terminals available — write a starter template instead
            const fs = await import('fs');
            const path = await import('path');
            const dir = path.dirname(prdPath);
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(prdPath, [
                `# ${projectName} — Product Requirements Document`,
                '',
                description ? `## Overview\n${description}\n` : '## Overview\n[Describe the project purpose here]\n',
                '## Target Users',
                '[Who is this for?]\n',
                '## Core Features',
                '- [Feature 1]',
                '- [Feature 2]\n',
                '## Non-Functional Requirements',
                '- [Performance, security, scalability notes]\n',
                '## Success Criteria',
                '- [How do we know this project is done?]\n',
                '## Out of Scope',
                '- [What this project explicitly does NOT cover]\n',
            ].join('\n'), 'utf8');
            this._showStatusMessage(`PRD template created for "${projectName}" — edit it in the Projects tab.`);
        }
    } catch (err) {
        console.error('[KanbanProvider] PRD generation dispatch failed:', err);
        this._showStatusMessage(`Project "${projectName}" created, but PRD generation failed.`);
    }
}
```

> **Note**: The exact terminal dispatch API (`sendTextToTerminal`, `getRegisteredTerminals`) must be verified against the actual `TaskViewerProvider` interface. The pattern above mirrors how `pairProgramCard` and prompt dispatch work. If the terminal dispatch API differs, adapt accordingly — the key contract is: compose prompt → send to a terminal → agent writes the file → Projects tab picks it up on next refresh.

---

### Component 4: Status Message Helper

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

If `_showStatusMessage` doesn't already exist, add a helper that posts a status flash to the webview sub-bar:

```typescript
private _showStatusMessage(text: string): void {
    this._panel?.webview.postMessage({ type: 'statusMessage', text });
}
```

Verify: the kanban webview already handles `statusMessage` messages (check the `window.addEventListener('message', ...)` handler for `statusMessage` case). If not, add a handler that updates `#status-message`.

---

## Verification Plan

### Automated Tests

1. **HTML structure test**: Assert `kanban.html` contains `id="create-project-modal"`, the modal input/textarea/checkbox/button IDs.
   ```bash
   node src/test/project-panel-kanban-create-button.test.js
   ```
   (Update this test or create a new one for the modal structure.)

2. **Backend handler test**: Assert `KanbanProvider.ts` `addProject` case no longer calls `showInputBox` and instead reads `msg.projectName`.
   ```bash
   grep -c "showInputBox" src/services/KanbanProvider.ts
   # Should return 0 (or at least not in the addProject case)
   ```

3. **PRD path test**: Verify `prdUtils.ts` `getProjectPrdPath` is called correctly:
   ```bash
   grep "getProjectPrdPath" src/services/KanbanProvider.ts
   ```

### Manual Verification

1. Open the Switchboard kanban board in VS Code.
2. Click the `+` button next to the workspace/project dropdown.
3. **Expect**: A styled modal opens (not a VS Code popup).
4. Type a project name → submit button enables.
5. Check "Generate PRD with Agent" → submit.
6. **Expect**: Project appears in the dropdown. If a terminal is registered, a PRD generation prompt is dispatched. If not, a template `prd.md` is created.
7. Switch to the Projects tab → select the new project → PRD content should appear.
8. Test with both Afterburner and Claudify themes — modal should be styled correctly.
9. Test edge cases: empty name (submit disabled), Escape key closes, backdrop click closes, Enter key submits.
