# Remove Duplicate Architect Button and Rename "Copy Architect Prompt" in project.html

## Goal

In `project.html`, there are two architect-related buttons in each of the three tabs (Projects, Constitution, System): an "Architect" button and a "Copy Architect Prompt" button. The user wants:
1. Remove the "Architect" button entirely (it opens a guided architect session via terminal).
2. Rename "Copy Architect Prompt" to "Architect Prompt" across all three tabs.

### Problem Analysis & Root Cause

Each of the three tabs (Projects, Constitution, System) in `project.html` has two architect buttons:

- `btn-architect-projects` / `btn-architect-constitution` / `btn-architect-system` — labeled "Architect", sends `openArchitectTerminal` message (opens a guided architect session in a terminal).
- `btn-copy-architect-projects` / `btn-copy-architect-constitution` / `btn-copy-architect-system` — labeled "Copy Architect Prompt", sends `copyArchitectPrompt` message (copies the architect prompt to clipboard).

The user finds having two buttons confusing and unnecessary. The "Architect" button (which opens a terminal session) is the one to remove. The "Copy Architect Prompt" button should be retained but renamed to "Architect Prompt" for brevity.

The root cause is likely that both buttons were added at different times for different workflows, but the user has decided the terminal-launching path is redundant — copying the prompt is sufficient (the user can paste it into whatever terminal they choose).

## Metadata

- **Tags:** ui-cleanup, project-html, architect, buttons
- **Complexity:** 2

## Complexity Audit

**Routine.** Remove three HTML buttons, remove three JS event listeners and variable references, rename three button labels. No backend changes needed — the `openArchitectTerminal` message handler in the backend can remain (it's harmless if unused), but the `copyArchitectPrompt` handler must continue working.

## Edge-Case & Dependency Audit

- **`openArchitectTerminal` backend handler:** After removing the buttons, no webview message will send `openArchitectTerminal`. The backend handler in `PlanningPanelProvider.ts` can remain as dead code (harmless) or be cleaned up separately. This plan only removes the UI.
- **`architectPromptCopied` message handler (project.js line 1132):** This is the response to `copyArchitectPrompt` — it shows a toast. Must be preserved.
- **`architect-shortcut-btn` CSS class:** Both buttons share this class. After removing the "Architect" button, the class is still used by the "Copy Architect Prompt" (now "Architect Prompt") button. No CSS changes needed.
- **Button variable references in project.js:** Lines 362-367 declare 6 variables for the 6 buttons. The 3 `btnArchitect*` variables (lines 362-364) and their event listeners (lines 2004-2021) must be removed. The 3 `btnCopyArchitect*` variables (lines 365-367) and their event listeners (lines 2022-2039) must be preserved.
- **Tab layout:** Removing one button from each tab's controls strip will make the strip slightly shorter. No layout issues expected — the strip uses flex with wrapping.

## Proposed Changes

### 1. `src/webview/project.html` — Remove "Architect" buttons and rename "Copy Architect Prompt" buttons

**Projects tab (lines 1185-1186):**

Before:
```html
<button id="btn-architect-projects" class="strip-btn architect-shortcut-btn" title="Open guided architect session">Architect</button>
<button id="btn-copy-architect-projects" class="strip-btn architect-shortcut-btn" title="Copy the Architect prompt">Copy Architect Prompt</button>
```

After:
```html
<button id="btn-copy-architect-projects" class="strip-btn architect-shortcut-btn" title="Copy the Architect prompt">Architect Prompt</button>
```

**Constitution tab (lines 1268-1269):**

Before:
```html
<button id="btn-architect-constitution" class="strip-btn architect-shortcut-btn" title="Open guided architect session">Architect</button>
<button id="btn-copy-architect-constitution" class="strip-btn architect-shortcut-btn" title="Copy the Architect prompt">Copy Architect Prompt</button>
```

After:
```html
<button id="btn-copy-architect-constitution" class="strip-btn architect-shortcut-btn" title="Copy the Architect prompt">Architect Prompt</button>
```

**System tab (lines 1303-1304):**

Before:
```html
<button id="btn-architect-system" class="strip-btn architect-shortcut-btn" title="Open guided architect session">Architect</button>
<button id="btn-copy-architect-system" class="strip-btn architect-shortcut-btn" title="Copy the Architect prompt">Copy Architect Prompt</button>
```

After:
```html
<button id="btn-copy-architect-system" class="strip-btn architect-shortcut-btn" title="Copy the Architect prompt">Architect Prompt</button>
```

### 2. `src/webview/project.js` — Remove `btnArchitect*` variable declarations (lines 362-364)

Remove:
```javascript
const btnArchitectProjects = document.getElementById('btn-architect-projects');
const btnArchitectConstitution = document.getElementById('btn-architect-constitution');
const btnArchitectSystem = document.getElementById('btn-architect-system');
```

Keep the `btnCopyArchitect*` declarations (lines 365-367).

### 3. `src/webview/project.js` — Remove `btnArchitect*` event listeners (lines 2004-2021)

Remove the three `if (btnArchitect*) { ... }` blocks that send `openArchitectTerminal`:

```javascript
// REMOVE these three blocks:
if (btnArchitectProjects) {
    btnArchitectProjects.addEventListener('click', () => {
        const wsRoot = projectsWorkspaceFilter ? projectsWorkspaceFilter.value : '';
        vscode.postMessage({ type: 'openArchitectTerminal', workspaceRoot: wsRoot });
    });
}
if (btnArchitectConstitution) {
    btnArchitectConstitution.addEventListener('click', () => {
        const wsRoot = constitutionWorkspaceFilter ? constitutionWorkspaceFilter.value : '';
        vscode.postMessage({ type: 'openArchitectTerminal', workspaceRoot: wsRoot });
    });
}
if (btnArchitectSystem) {
    btnArchitectSystem.addEventListener('click', () => {
        const wsRoot = systemWorkspaceFilter ? systemWorkspaceFilter.value : '';
        vscode.postMessage({ type: 'openArchitectTerminal', workspaceRoot: wsRoot });
    });
}
```

Keep the `btnCopyArchitect*` event listeners (lines 2022-2039) — these send `copyArchitectPrompt` which is the retained functionality.

## Verification Plan

1. Open the project panel.
2. Switch to the Projects tab — verify there is only one architect button labeled "Architect Prompt" (no "Architect" button).
3. Switch to the Constitution tab — verify only "Architect Prompt" button.
4. Switch to the System tab — verify only "Architect Prompt" button.
5. Click "Architect Prompt" in each tab — verify the architect prompt is copied to clipboard and a success toast appears.
6. Verify no console errors about missing DOM elements (the removed `btnArchitect*` variables should not be referenced anywhere).
7. Verify the controls strip layout looks clean with one fewer button per tab.
