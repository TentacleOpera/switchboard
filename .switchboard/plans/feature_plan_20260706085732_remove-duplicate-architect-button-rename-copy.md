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

- **Tags:** ui, ux
- **Complexity:** 2

## User Review Required

No — this is a low-complexity UI-only change (button removal and label rename). The main gate before coding is confirming no remaining references to the removed `btn-architect-*` DOM ids or `btnArchitect*` JS variables beyond what this plan already identifies for removal. All such references have been verified from source (lines cited below). No user review needed beyond the plan approval itself.

## Complexity Audit

### Routine
- Remove three HTML buttons (`btn-architect-projects`, `btn-architect-constitution`, `btn-architect-system`) from project.html.
- Remove three JS variable declarations (`btnArchitectProjects`, `btnArchitectConstitution`, `btnArchitectSystem`) at project.js lines 362–364.
- Remove three JS event listener blocks (`btnArchitect*` click handlers sending `openArchitectTerminal`) at project.js lines 2004–2021.
- Rename three button labels from "Copy Architect Prompt" to "Architect Prompt" in project.html.
- No backend changes needed — the `openArchitectTerminal` handler in PlanningPanelProvider.ts becomes dead code but is harmless; the `copyArchitectPrompt` handler must continue working.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions**
- None — button removal and rename are synchronous DOM edits with no async side effects.

**Security**
- None — no auth, permissions, or data-access changes.

**Side Effects**
- **`openArchitectTerminal` backend handler becomes dead code:** After removing the three webview senders (the `btnArchitect*` click listeners at project.js:2004–2021), NOTHING else posts `openArchitectTerminal`. The backend handler at `PlanningPanelProvider.ts:4221` is unreachable. Leaving it is harmless and out of scope for this UI-only plan; optional separate cleanup in a follow-up.
- **`architectPromptCopied` toast handler (project.js:1132–1134) MUST be preserved:** This is the inbound response to `copyArchitectPrompt` — it shows `showToast('Architect prompt copied to clipboard', 'success')`. This is the retained functionality's toast and must not be touched.
- **`architect-shortcut-btn` CSS class remains in use:** Both the removed "Architect" button and the retained "Copy Architect Prompt" button share this class. After removal, the class is still used by the renamed "Architect Prompt" button. No CSS changes needed.
- **Tab layout:** Removing one button from each tab's controls strip will make the strip slightly shorter. No layout issues expected — the strip uses flex with wrapping.

**Dependencies & Conflicts**
- **Button variable references in project.js:** Lines 362–367 declare 6 variables for the 6 buttons. The 3 `btnArchitect*` variables (lines 362–364) and their event listeners (lines 2004–2021) must be removed. The 3 `btnCopyArchitect*` variables (lines 365–367) and their event listeners (lines 2022–2039) must be preserved.

## Dependencies

None — single-file UI change (project.html + project.js), no cross-plan dependencies. Backend dead-code cleanup of `openArchitectTerminal` handler is an optional follow-up, out of scope.

## Adversarial Synthesis

Removing three buttons and renaming three labels is mechanically straightforward, but the dead `openArchitectTerminal` handler at PlanningPanelProvider.ts:4221 and the shared `architect-shortcut-btn` CSS class both warrant explicit documentation to prevent later confusion. The `title` attribute on retained buttons still says "Copy the Architect prompt" — consider whether it should be updated to match the new "Architect Prompt" label for consistency, though this is cosmetic and low-risk.

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

> **Note:** The `architect-shortcut-btn` CSS class remains in use by the retained (renamed) buttons — no CSS change needed.

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

### Automated Tests

Automated tests SKIPPED per session directive; verification is manual UI inspection only (no compile, no test runner).

### Manual Steps

1. Open the project panel.
2. Switch to the Projects tab — verify there is only one architect button labeled "Architect Prompt" (no "Architect" button).
3. Switch to the Constitution tab — verify only "Architect Prompt" button.
4. Switch to the System tab — verify only "Architect Prompt" button.
5. Click "Architect Prompt" in each tab — verify the architect prompt is copied to clipboard and a success toast appears.
6. Verify no console errors about missing DOM elements (the removed `btnArchitect*` variables should not be referenced anywhere).
7. Verify the controls strip layout looks clean with one fewer button per tab.
