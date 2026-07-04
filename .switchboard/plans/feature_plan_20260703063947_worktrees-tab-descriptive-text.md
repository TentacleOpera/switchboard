# Worktrees Tab: Add Descriptive Text for Suppress Main Terminals & Routing Order

## Goal

Improve the descriptive text in the kanban.html Worktrees tab so users understand what "Suppress main repo agent terminals" actually does, and expand the routing-order explanation to mention that when a worktree is active, Switchboard automatically opens agent terminals inside the worktree and routes work in epics or projects to the relevant worktree.

### Problem Analysis & Root Cause

The current Worktrees tab has two text areas that are too terse:

1. **Routing order description** (kanban.html lines 9628–9632, inside `createWorktreesPanel()` which starts at line 9613):
   ```
   Routing order: epic worktree → project worktree → main repo.
   When you want git worktrees covering agent work for a project or epic. Coder prompts reference the worktree path so agents edit code inside the worktree instead of the workspace root.
   ```
   This explains the priority chain but does NOT mention the automatic terminal-opening behavior — that when a worktree is active, Switchboard opens agent terminals inside the worktree and routes epic/project work there. Users discover this only by trial.

2. **Suppress main repo agent terminals checkbox** (kanban.html lines 9638–9654):
   ```
   Suppress main repo agent terminals
   ```
   No description at all. Users don't know that checking this box means the main "Agents" button will NOT open terminals in the workspace root — it only opens terminals for worktrees that have the per-row **Agent terminals** checkbox enabled. The backend logic in `extension.ts` (`createAgentGrid`, lines 2606–2623) reads `worktree_suppress_main_terminals` (line 2614), filters worktrees to those with `agentsOpenWithGrid` set (line 2615), and when suppress is on with no grid-enabled worktrees, shows a warning and returns without opening anything (lines 2620–2623). The UI gives zero hint of this.

> **Note on UI labels:** The per-worktree checkbox that controls `agentsOpenWithGrid` is labeled **"Agent terminals"** in the UI (kanban.html line 10048), not "Open terminals with grid". The description text below references the actual UI label to avoid confusing users.

## Metadata

- **Tags:** frontend, ui, ux, documentation
- **Complexity:** 2

## User Review Required

No — pure descriptive text changes with no behavior or state impact. The wording of the suppress description is the only subjective choice; implementer may refine phrasing for clarity.

## Dependencies

- None. This plan edits only `src/webview/kanban.html` text content. It should land **after** the reorganization plan (`feature_plan_20260703063948`) so the description text lands in the final section layout (per epic sequencing).

## Complexity Audit

### Routine
- Editing two `innerHTML` / `textContent` strings in `createWorktreesPanel()` in `kanban.html`. No logic changes, no backend changes, no state changes.

### Complex / Risky
- None. Pure text content changes.

## Edge-Case & Dependency Audit

- **CSP compliance:** The description divs use `innerHTML` for rich formatting. The existing routing-order div already uses `innerHTML` with `<strong>` and `<br>` tags. New text must follow the same pattern — only basic HTML tags (`<strong>`, `<br>`, `<em>`), no inline scripts or event handlers. This is CSP-safe.
- **Layout:** The suppress checkbox section (lines 9636–9654) is a flex row with the checkbox and a bare label. Adding a description line below it must not break the flex layout — use a separate `<div>` below the flex row, not inside it.

## Adversarial Synthesis

Key risks: description text references a checkbox label that must match the actual UI ("Agent terminals", not the internal field name); line anchors must be re-verified at implementation time since sibling plans rewrite the same function. Mitigations: label verified against current source (kanban.html line 10048); plan lands last per epic sequencing so it edits the final layout.

## Proposed Changes

### 1. `src/webview/kanban.html` — Expand the routing-order description (lines 9630–9631)

Replace the current `descriptionDiv.innerHTML` with:

```javascript
descriptionDiv.innerHTML =
    '<strong>Routing order:</strong> epic worktree → project worktree → main repo.<br><br>' +
    'When a worktree is active, Switchboard automatically opens agent terminals inside the worktree and routes work in epics or projects to the relevant worktree. ' +
    'Coder prompts reference the worktree path so agents edit code inside the worktree instead of the workspace root. ' +
    'If no worktree matches a plan, the plan runs in the main repo terminals as usual.';
```

### 2. `src/webview/kanban.html` — Add description text under the suppress checkbox (after line 9653)

After the `settingsSection.appendChild(suppressLabel);` line (9653), add a description div before `container.appendChild(settingsSection);` (9654):

```javascript
const suppressDesc = document.createElement('div');
suppressDesc.style.cssText = 'font-size:10px; color:var(--text-secondary); line-height:1.4; padding:2px 0 0 24px; margin-top:2px;';
suppressDesc.innerHTML =
    'When checked, the main <strong>Agents</strong> button will NOT open terminals in the workspace root. ' +
    'Instead, terminals are opened only for worktrees that have the per-row <em>Agent terminals</em> checkbox enabled. ' +
    'Use this when all agent work should happen inside worktrees, never in the main repo.';
settingsSection.appendChild(suppressDesc);
```

Note: the `padding-left: 24px` aligns the description text with the label text (past the checkbox width). The description references the actual UI label "Agent terminals" (kanban.html line 10048) rather than the internal field name `agentsOpenWithGrid`.

## Verification Plan

1. Open the kanban board and switch to the Worktrees tab.
2. Confirm the routing-order description now mentions automatic terminal opening inside worktrees and routing of epic/project work.
3. Confirm the "Suppress main repo agent terminals" checkbox now has a description line below it explaining what checking the box does.
4. Confirm the description text is readable (font size, color, alignment) and does not overflow or break the layout.
5. Confirm no CSP violations in the webview developer console.
6. Toggle the suppress checkbox on/off and verify the backend still receives the `setSuppressMainTerminals` message correctly (the description is purely visual — no behavior change).

## Review Findings

**CRITICAL fix applied (shared root cause):** The descriptive text changes (expanded routing-order description with "automatically opens agent terminals inside the worktree", and the suppress checkbox description referencing the "Agent terminals" UI label) were correctly written into the new reorganized `createWorktreesPanel`. However, the new function was nested inside the old undeleted `createWorktreesPanel` which had no closing brace — a `SyntaxError: Unexpected end of input` that broke the entire kanban webview script, making all descriptive text (and the entire board) inaccessible. Fix: deleted the orphaned old function body (306 lines, kanban.html 9745-10050), making the new function with the descriptive text the sole `createWorktreesPanel` definition. **Files changed:** `src/webview/kanban.html`. **Validation:** `node --check` passes clean; routing-order description confirmed at line 9911; suppress description confirmed at line 9943; both use CSP-safe `innerHTML` with only `<strong>`/`<br>`/`<em>` tags. **Remaining risks:** None — pure text content, no behavior or state impact.
