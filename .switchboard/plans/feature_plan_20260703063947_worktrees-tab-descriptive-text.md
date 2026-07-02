# Worktrees Tab: Add Descriptive Text for Suppress Main Terminals & Routing Order

## Goal

Improve the descriptive text in the kanban.html Worktrees tab so users understand what "Suppress main repo agent terminals" actually does, and expand the routing-order explanation to mention that when a worktree is active, Switchboard automatically opens agent terminals inside the worktree and routes work in epics or projects to the relevant worktree.

### Problem Analysis & Root Cause

The current Worktrees tab has two text areas that are too terse:

1. **Routing order description** (kanban.html lines 9101–9102):
   ```
   Routing order: epic worktree → project worktree → main repo.
   When you want git worktrees covering agent work for a project or epic. Coder prompts reference the worktree path so agents edit code inside the worktree instead of the workspace root.
   ```
   This explains the priority chain but does NOT mention the automatic terminal-opening behavior — that when a worktree is active, Switchboard opens agent terminals inside the worktree and routes epic/project work there. Users discover this only by trial.

2. **Suppress main repo agent terminals checkbox** (kanban.html line 9122):
   ```
   Suppress main repo agent terminals
   ```
   No description at all. Users don't know that checking this box means the main "Agents" button will NOT open terminals in the workspace root — it only opens terminals for worktrees that have "Open terminals with grid" checked. The backend logic in `extension.ts` (lines 2582–2598) reads `worktree_suppress_main_terminals` and skips main-repo terminal creation when it's `'true'`, but the UI gives zero hint of this.

## Metadata

- **Tags:** frontend, ui, ux, documentation
- **Complexity:** 2

## Complexity Audit

### Routine
- Editing two `innerHTML` / `textContent` strings in `createWorktreesPanel()` in `kanban.html`. No logic changes, no backend changes, no state changes.

### Complex / Risky
- None. Pure text content changes.

## Edge-Case & Dependency Audit

- **CSP compliance:** The description divs use `innerHTML` for rich formatting. The existing routing-order div already uses `innerHTML` with `<strong>` and `<br>` tags. New text must follow the same pattern — only basic HTML tags (`<strong>`, `<br>`, `<em>`), no inline scripts or event handlers. This is CSP-safe.
- **Layout:** The suppress checkbox section (lines 9107–9125) is a flex row with the checkbox and a bare label. Adding a description line below it must not break the flex layout — use a separate `<div>` below the flex row, not inside it.

## Proposed Changes

### 1. `src/webview/kanban.html` — Expand the routing-order description (lines 9101–9102)

Replace the current `descriptionDiv.innerHTML` with:

```javascript
descriptionDiv.innerHTML =
    '<strong>Routing order:</strong> epic worktree → project worktree → main repo.<br><br>' +
    'When a worktree is active, Switchboard automatically opens agent terminals inside the worktree and routes work in epics or projects to the relevant worktree. ' +
    'Coder prompts reference the worktree path so agents edit code inside the worktree instead of the workspace root. ' +
    'If no worktree matches a plan, the plan runs in the main repo terminals as usual.';
```

### 2. `src/webview/kanban.html` — Add description text under the suppress checkbox (after line 9124)

After the `settingsSection.appendChild(suppressLabel);` line, add a description div before `container.appendChild(settingsSection);`:

```javascript
const suppressDesc = document.createElement('div');
suppressDesc.style.cssText = 'font-size:10px; color:var(--text-secondary); line-height:1.4; padding:2px 0 0 24px; margin-top:2px;';
suppressDesc.innerHTML =
    'When checked, the main <strong>Agents</strong> button will NOT open terminals in the workspace root. ' +
    'Instead, terminals are opened only for worktrees that have <em>Open terminals with grid</em> enabled. ' +
    'Use this when all agent work should happen inside worktrees, never in the main repo.';
settingsSection.appendChild(suppressDesc);
```

Note: the `padding-left: 24px` aligns the description text with the label text (past the checkbox width).

## Verification Plan

1. Open the kanban board and switch to the Worktrees tab.
2. Confirm the routing-order description now mentions automatic terminal opening inside worktrees and routing of epic/project work.
3. Confirm the "Suppress main repo agent terminals" checkbox now has a description line below it explaining what checking the box does.
4. Confirm the description text is readable (font size, color, alignment) and does not overflow or break the layout.
5. Confirm no CSP violations in the webview developer console.
6. Toggle the suppress checkbox on/off and verify the backend still receives the `setSuppressMainTerminals` message correctly (the description is purely visual — no behavior change).
