---
title: "Kanban mode in terminals.html: wrong workspace, duplicate button, broken project dropdown, project name spam, complexity badge vomit"
created: 2026-08-06T11:15:00Z
complexity: 4
tags: [frontend, bugfix, ui, ux]
---

# Kanban mode in terminals.html: five bugs

## Goal

Fix five bugs in the kanban-mode pane feature of `terminals.html`:
1. Kanban mode doesn't open to the currently selected workspace
2. Duplicate kanban button — one in the sidebar, one in the toolbar. Only the toolbar button was requested.
3. The projects dropdown shows all projects instead of being workspace-scoped like the kanban board's combined workspace/project dropdown
4. Card lists repeat the project name on every card even when a project is already selected from the dropdown
5. Complexity badges are colored pill-style boxes with uppercase white text on colored backgrounds — visual vomit. Should be plain text "Low complexity" like the kanban board cards.
6. The button to switch a kanban pane back to terminal mode is labeled "term" — meaningless. Rename to "Terminal".

## Problem Analysis

### Bug 1: Wrong workspace on kanban mode open

`defaultKanbanWorkspace()` (`terminals.js:2424`) resolves the workspace for a new kanban pane by:
1. Checking the focused pane's terminal's `parentRoot`
2. Falling back to `buildWorkspaceList()[0].root` (first parent in `parentsList`)

It never reads `document.body.dataset.initialWorkspaceRoot`, even though `headlessPanelHtml.ts:410` injects it into the terminals panel's `<body>` tag. The kanban board reads this attribute at `kanban.html:4329`:
```javascript
const attr = document.body?.dataset?.initialWorkspaceRoot;
if (attr) { currentWorkspaceRoot = decodeURIComponent(attr); }
```

The terminals panel has no equivalent. When the operator has a specific workspace selected on the kanban board and clicks KANBAN in terminals, the kanban pane opens to whatever `parentsList[0]` happens to be — which may be a different workspace entirely.

### Bug 2: Duplicate kanban button

Two buttons call `toggleFocusedPaneKanban()`:
- `#btn-kanban-sidebar` at `terminals.html:1216` — in the sidebar ops block, labeled "KANBAN MODE"
- `#btn-kanban-toolbar` at `terminals.html:1245` — in the toolbar next to NEW WINDOW, labeled "KANBAN"

Both have event listeners at `terminals.js:514-521`. The user only wants the toolbar button. The sidebar button is an unwanted duplicate that was never requested.

### Bug 3: Projects dropdown shows all projects, not workspace-scoped

The kanban board has a single combined workspace+project dropdown (`#workspace-project-select` at `kanban.html:2705`). Each option is `wsRoot|projectName`, built in `updateWorkspaceProjectDropdown()` (`kanban.html:4888`). Projects are scoped per workspace via `allWorkspaceProjects[wsRoot]`.

The terminals kanban mode has **separate** workspace and project `<select>` dropdowns (`renderKanbanPane` at `terminals.js:2472-2523`). The project picker is populated from `kanbanPaneProjectsCache[index]`, which comes from `data.projects` in the `getBoardCards` response. The `getBoardCards` handler (`KanbanProvider.ts:10416`) returns `await db.getProjects(wsId)` — all projects for the resolved workspace.

The problem: when `kanbanPaneWorkspace[index]` is undefined (the default before Bug 1's fix lands), `_resolveWorkspaceRoot` falls back to the backend's singleton workspace root, which may resolve to a different workspace than the operator selected on the kanban board. The projects returned are for that backend-resolved workspace, not the one the operator expects.

Even after Bug 1's fix, the separate-dropdown design is wrong. The user wants the **same combined workspace+project dropdown** as the kanban board — a single `<select>` where each option is `workspace > project`, not two separate dropdowns. The user explicitly said: "YOU WERE MEANT TO FUCKING PUT IN THE WORKSPACE/PROJECTS DROPDOWN IN KANBAN BOARd, NOT THI FUCKING USELESS PIECE OF SHIT."

### Bug 4: Project name spammed on every card

In `renderKanbanPane` at `terminals.js:2644-2650`:
```javascript
if (card.project) {
    const proj = document.createElement('span');
    proj.className = 'kanban-pane-project';
    proj.textContent = card.project;
    proj.title = card.project;
    meta.appendChild(proj);
}
```

Every card in the list renders its `card.project` as a badge. When the operator has selected a project from the dropdown, every card in the filtered list has the same project name — it's repeated on every row, which is pure noise. The project name is only useful when "All projects" is selected (no filter), where cards from different projects can appear in the same list.

### Bug 5: Complexity badge visual vomit

The kanban board cards (`kanban.html:6810-6812`) render complexity as plain text:
```html
Complexity: <span class="complexity-indicator low">Low</span>
```

The `.complexity-indicator` CSS (`kanban.html:998-1009`) is minimal — just `font-weight: 600` and a color per category. No background, no padding, no border-radius, no uppercase. It reads as "Complexity: Low" in a colored word.

The terminals kanban pane (`terminals.js:2632-2637`) renders it as a pill badge:
```javascript
complexityBadge.className = `kanban-pane-complexity ${categoryToCssClass(complexityCat)}`;
complexityBadge.textContent = complexityCat;
```

The `.kanban-pane-complexity` CSS (`terminals.html:946-960`) is a colored box:
```css
.kanban-pane-complexity {
    padding: 1px 4px;
    border-radius: 2px;
    font-size: 8px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: #fff;
}
.kanban-pane-complexity.low { background: #16a085; }
```

White uppercase text on a solid colored background — a pill badge that looks nothing like the kanban board's plain text "Complexity: Low".

### Bug 6: "term" button label

`createPaneElement` (`terminals.js:2066`) creates the mode-toggle button with:
```javascript
modeBtn.textContent = 'term';
modeBtn.title = 'Switch this pane to terminal mode';
```

The button switches a kanban-mode pane back to terminal mode. "term" is not a word anyone uses for this — the tooltip already says "Switch this pane to terminal mode" in plain English. The label should match.

The comment at line 2436 also references `"term" toggle` — update it to match.

## Metadata

**Tags:** frontend, bugfix, ui, ux
**Complexity:** 4
**Project:** browser-switchboard

## User Review Required

This plan modifies user-facing UI in the terminals kanban pane. The combined dropdown redesign (Bug 3) changes the interaction model from two separate dropdowns to one. Review the proposed combined dropdown approach before implementation — it is the most complex change and the one most likely to have edge cases the operator cares about.

## Complexity Audit

### Routine
- Bug 1: Add a module-level variable, read a body attribute in `init()`, add one `if` branch in `defaultKanbanWorkspace()`. Single function, localized.
- Bug 2: Delete one HTML element and its event listener. Pure deletion, no logic.
- Bug 4: Add `!kanbanPaneProject[index]` to an existing `if` condition. One-character-class change.
- Bug 6: Change a string literal from `'term'` to `'Terminal'` and update a comment. Trivial.
- Bug 5: Replace CSS class properties and add a label span. CSS-only + minor DOM restructuring.

### Complex / Risky
- Bug 3: Replace two separate `<select>` elements with one combined `<select>`. Requires updating the signature-gated rebuild logic in `renderKanbanPane` (line 2465), the change handlers, and the value-restore logic (lines 2546-2548). The combined dropdown must handle workspace switching (which triggers a new card fetch and project list reload) and project filtering in a single `change` handler. Projects for non-selected workspaces are not available without a separate fetch — the kanban board receives `allWorkspaceProjects` via a full state push message that the terminals pane does not get.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Bug 3: When the operator switches workspace in the combined dropdown, `fetchBoardCardsForPane` is called, which is async. The `kanbanFetchInFlight` guard (line 2803) prevents overlapping requests for the same pane. However, the project list in the dropdown is rebuilt from `kanbanPaneProjectsCache[index]`, which is only updated when the fetch response arrives (line 2818). If the operator changes workspace again before the first fetch lands, the project options will be stale until the second fetch completes. The existing signature-gated rebuild handles this — the dropdown is rebuilt when `projSig` changes (line 2465), which happens when the cache updates.

**Security:**
- No security implications. All data is workspace-local kanban state.

**Side Effects:**
- Bug 1: `initialWorkspaceRoot` is read once in `init()`. If the operator switches workspace on the kanban board after the terminals panel is loaded, the kanban pane will still open to the old workspace. This matches `kanban.html`'s behavior — it also reads the attribute once at startup (line 4329). No regression.
- Bug 2: Removing the sidebar button changes the sidebar layout. The remaining buttons (OPEN AGENT TERMINALS, CLEAR ALL TERMINALS, SAVE AS GROUP) will reflow. No layout breakage — they are stacked `w-full` buttons.
- Bug 3: The combined dropdown changes the persisted state shape. `kanbanPaneWorkspace` and `kanbanPaneProject` arrays remain the same — the combined dropdown still writes to both. No migration needed.

**Dependencies & Conflicts:**
- Bug 1 fix must land before or with Bug 3 fix — Bug 3's combined dropdown relies on the correct workspace being selected by default.
- Bug 3 and Bug 4 are related: Bug 4 gates the project badge on `!kanbanPaneProject[index]`. The combined dropdown still writes to `kanbanPaneProject[index]`, so Bug 4's fix works regardless of which dropdown design is used.
- Bug 5's CSS changes in `terminals.html` must be coordinated with the JS changes in `terminals.js` — the new `.kanban-pane-complexity-label` class must exist in CSS before the JS creates elements with it.

## Dependencies

- None. All six bugs are self-contained within `src/webview/terminals.js` and `src/webview/terminals.html`.

## Adversarial Synthesis

Key risks: Bug 3's combined dropdown must update the signature-gated rebuild logic (line 2465) — the current code checks `wsPicker.dataset.sig` and `projPicker.dataset.sig` separately; replacing two pickers with one means the signature check and picker-query selectors must change too. The plan's original code referenced a non-existent `wsLabelFor()` function. Projects for non-selected workspaces are unavailable without a fetch — the plan acknowledges this but the optgroup approach in the original draft was incomplete. Mitigations: use `workspaces.find(w => w.root === chosenWs)?.label` for label lookup; update the picker query selectors and signature logic to match the single-dropdown design; only show projects for the currently selected workspace (other workspaces show as "All projects" until selected).

## Proposed Changes

### 1. `src/webview/terminals.js` — Read `data-initial-workspace-root` for default kanban workspace (Bug 1)

Add a module-level variable near the other kanban pane state variables (around line 50) and read the body attribute in `init()` (line 369):

```javascript
let initialWorkspaceRoot = undefined;
// In init(), before any kanban pane is created (after line 388, before the drag-disarm listener):
try {
    const attr = document.body?.dataset?.initialWorkspaceRoot;
    if (attr) { initialWorkspaceRoot = decodeURIComponent(attr); }
} catch { /* ignore */ }
```

Update `defaultKanbanWorkspace()` (line 2424) to prefer `initialWorkspaceRoot`:

```javascript
function defaultKanbanWorkspace() {
    // Prefer the workspace the kanban board selected — the body attribute is
    // injected by headlessPanelHtml.ts and matches what kanban.html reads.
    if (initialWorkspaceRoot) { return initialWorkspaceRoot; }
    const focusedName = paneAssignments[focusedPaneIndex];
    if (focusedName) {
        const term = fleetList.find(t => t.friendlyName === focusedName);
        if (term && term.parentRoot) { return term.parentRoot; }
    }
    const ws = buildWorkspaceList();
    return ws.length > 0 ? ws[0].root : undefined;
}
```

### 2. `src/webview/terminals.html` + `src/webview/terminals.js` — Remove sidebar kanban button (Bug 2)

In `terminals.html`, delete the sidebar kanban button (lines 1216-1217):
```html
<!-- DELETE: -->
<button type="button" id="btn-kanban-sidebar" class="secondary-btn w-full"
        title="Toggle the focused pane between kanban board view and terminal">KANBAN MODE</button>
```

In `terminals.js`, delete the sidebar kanban button listener (lines 518-521):
```javascript
// DELETE:
const btnKanbanSidebar = document.getElementById('btn-kanban-sidebar');
if (btnKanbanSidebar) {
    btnKanbanSidebar.addEventListener('click', () => toggleFocusedPaneKanban());
}
```

The toolbar button (`#btn-kanban-toolbar`) at line 1245 stays. Its listener at lines 514-517 stays.

### 3. `src/webview/terminals.js` — Replace separate workspace/project dropdowns with combined dropdown (Bug 3)

> **Superseded:** The original plan proposed a combined dropdown with `wsRoot|projectName` values and optgroups for other workspaces, using a `wsLabelFor()` helper function.
> **Reason:** `wsLabelFor()` does not exist in the codebase. The optgroup approach for non-selected workspaces was incomplete — projects for other workspaces are unavailable without a separate fetch. The two-approach description (combined vs. simpler merge) was confusing.
> **Replaced with:** A single combined `<select>` that shows the selected workspace's projects as `workspace > project` options. Only the selected workspace's projects are shown (from `kanbanPaneProjectsCache`). When the workspace changes, the dropdown is rebuilt with the new workspace's projects after the fetch lands. Other workspaces are selectable as "All projects" entries via a separate workspace switch mechanism (the workspace name as an option triggers a workspace change + fetch).

Replace the separate workspace picker (lines 2475-2497) and project picker (lines 2499-2523) in `renderKanbanPane` with a single combined `<select>`:

```javascript
// Replace the workspace picker + project picker blocks (lines 2472-2523) with:
const combinedPicker = document.createElement('select');
combinedPicker.className = 'kanban-pane-ws-project-picker';
combinedPicker.title = 'Workspace and project filter';
combinedPicker.dataset.sig = `${wsSig}|${projSig}`;

const wsLabel = workspaces.find(w => w.root === chosenWs)?.label || chosenWs;

// "All projects" option for the selected workspace
const allOpt = document.createElement('option');
allOpt.value = chosenWs + '|';
allOpt.textContent = workspaces.length > 1
    ? `${wsLabel} — All projects`
    : 'All projects';
combinedPicker.appendChild(allOpt);

// Per-project options for the selected workspace
for (const proj of projects) {
    const opt = document.createElement('option');
    opt.value = chosenWs + '|' + proj;
    opt.textContent = (workspaces.length > 1 ? `${wsLabel} > ` : '') + proj;
    combinedPicker.appendChild(opt);
}

// Other workspaces (selectable as "All projects" — triggers a workspace switch)
if (workspaces.length > 1) {
    for (const ws of workspaces) {
        if (ws.root === chosenWs) continue;
    const otherOpt = document.createElement('option');
    otherOpt.value = ws.root + '|';
    otherOpt.textContent = `${ws.label} — All projects`;
    combinedPicker.appendChild(otherOpt);
    }
}

combinedPicker.addEventListener('change', () => {
    const [ws, proj] = combinedPicker.value.split('|');
    const wsChanged = ws !== chosenWs;
    kanbanPaneWorkspace[index] = ws;
    kanbanPaneProject[index] = proj || '';
    kanbanPaneCards[index] = [];
    if (wsChanged) {
        // New workspace — clear project cache so the dropdown rebuilds on next render
        kanbanPaneProjectsCache[index] = [];
    }
    saveLayoutSettings();
    fetchBoardCardsForPane(index);
});
titleEl.appendChild(combinedPicker);
```

**Critical: Update the signature-gated rebuild logic.** The current code at line 2465 checks three separate picker signatures:
```javascript
if (!picker || picker.dataset.sig !== pickerSig || !wsPicker || wsPicker.dataset.sig !== wsSig || !projPicker || projPicker.dataset.sig !== projSig) {
```
Replace the `wsPicker` and `projPicker` queries with a single `combinedPicker` query:
```javascript
let picker = titleEl.querySelector('.kanban-pane-column-picker');
let combinedPicker = titleEl.querySelector('.kanban-pane-ws-project-picker');
if (!picker || picker.dataset.sig !== pickerSig || !combinedPicker || combinedPicker.dataset.sig !== `${wsSig}|${projSig}`) {
```

Also update the value-restore logic at lines 2546-2548. The current code:
```javascript
if (wsPicker && chosenWs && wsPicker.value !== chosenWs) { wsPicker.value = chosenWs; }
if (projPicker && projPicker.value !== chosenProj) { projPicker.value = chosenProj; }
```
Replace with:
```javascript
if (combinedPicker && combinedPicker.value !== `${chosenWs}|${chosenProj}`) {
    combinedPicker.value = `${chosenWs}|${chosenProj}`;
}
```

The column picker (lines 2525-2544) stays unchanged.

**Note:** Projects for non-selected workspaces won't be available until the operator switches to that workspace (which triggers a `getBoardCards` fetch that returns its projects). This is acceptable — the kanban board has the same limitation (its `allWorkspaceProjects` is populated from the full state push, which the terminals pane doesn't receive).

### 4. `src/webview/terminals.js` — Hide project badge when project filter is active (Bug 4)

In `renderKanbanPane` at line 2644, gate the project badge on the project filter being empty:

```javascript
// Before (line 2644):
if (card.project) {

// After:
if (card.project && !kanbanPaneProject[index]) {
```

When a project is selected from the dropdown, every card in the list has the same project — showing it on every row is noise. When "All projects" is selected (`kanbanPaneProject[index] === ''` or `undefined`), cards from different projects can appear, so the badge is useful. `!kanbanPaneProject[index]` is truthy for both `undefined` and `''`.

### 5. `src/webview/terminals.js` + `src/webview/terminals.html` — Replace complexity pill badge with plain text (Bug 5)

**`terminals.js`** — In `renderKanbanPane` (lines 2632-2637), replace the badge with plain text matching the kanban board's format:

```javascript
// Before (lines 2632-2637):
const complexityVal = card.complexity || 'Unknown';
const complexityCat = scoreToCategory(complexityVal);
const complexityBadge = document.createElement('span');
complexityBadge.className = `kanban-pane-complexity ${categoryToCssClass(complexityCat)}`;
complexityBadge.textContent = complexityCat;
meta.appendChild(complexityBadge);

// After:
const complexityVal = card.complexity || 'Unknown';
const complexityCat = scoreToCategory(complexityVal);
const complexityLabel = document.createElement('span');
complexityLabel.className = 'kanban-pane-complexity-label';
complexityLabel.textContent = 'Complexity: ';
meta.appendChild(complexityLabel);
const complexityValue = document.createElement('span');
complexityValue.className = `kanban-pane-complexity ${categoryToCssClass(complexityCat)}`;
complexityValue.textContent = complexityCat;
meta.appendChild(complexityValue);
```

**`terminals.html`** — Replace the `.kanban-pane-complexity` CSS (lines 946-960) with the kanban board's plain-text style:

```css
/* Before (lines 946-960): pill badges with backgrounds */
.kanban-pane-complexity { padding: 1px 4px; border-radius: 2px; ... color: #fff; }
.kanban-pane-complexity.very-low { background: #2980b9; }
...

/* After: plain colored text, matching kanban.html's .complexity-indicator */
.kanban-pane-complexity-label {
    font-weight: 400;
}
.kanban-pane-complexity {
    font-weight: 600;
    letter-spacing: 0.3px;
}
.kanban-pane-complexity.very-high { color: #ff00ff; }
.kanban-pane-complexity.high { color: #da3633; }
.kanban-pane-complexity.medium { color: #d29922; }
.kanban-pane-complexity.low { color: #98c379; }
.kanban-pane-complexity.very-low { color: #00e5ff; }
.kanban-pane-complexity.unknown { color: #7f848e; }
```

No `background`, no `padding`, no `border-radius`, no `text-transform`. The complexity reads as "Complexity: Low" with "Low" in green — exactly like the kanban board.

### 6. `src/webview/terminals.js` — Rename "term" button to "Terminal" (Bug 6)

Line 2066:
```javascript
// Before:
modeBtn.textContent = 'term';

// After:
modeBtn.textContent = 'Terminal';
```

Line 2436 (comment in `renderKanbanPane` docstring):
```javascript
// Before:
 *  + a "term" toggle to switch back to terminal mode; the body lists plan

// After:
 *  + a "Terminal" toggle to switch back to terminal mode; the body lists plan
```

## Verification Plan

### Automated Tests

No automated tests for this plan. The kanban pane is a webview UI feature with no existing test coverage. All verification is manual.

### Manual Verification

1. **Bug 1 (workspace):** On the kanban board, select a non-default workspace. Switch to the terminals panel. Click KANBAN in the toolbar. Verify the kanban pane shows cards from the workspace selected on the kanban board, not the first workspace.
2. **Bug 2 (one button):** Verify the sidebar no longer has a "KANBAN MODE" button. Verify the toolbar still has the "KANBAN" button next to NEW WINDOW. Verify clicking the toolbar button toggles kanban mode.
3. **Bug 3 (combined dropdown):** Click KANBAN, verify a single combined workspace+project dropdown appears in the pane header (not two separate dropdowns). Verify it shows "All projects" and per-project options for the current workspace. Select a project — verify the card list filters to that project. Select "All projects" — verify all cards appear. If multiple workspaces exist, verify other workspaces appear as selectable "All projects" entries — selecting one switches the workspace and rebuilds the project list after the fetch lands.
4. **Bug 4 (no project spam):** Select a project from the dropdown. Verify the card list does NOT show the project name on each card. Switch back to "All projects" — verify the project name reappears on cards that have a project assigned.
5. **Bug 5 (complexity text):** Click KANBAN, verify the card list shows "Complexity: Low" (or Medium, High, etc.) as plain text with the category word colored — no colored pill backgrounds, no uppercase, no white-on-color badges. Compare side-by-side with the kanban board's card meta line to confirm they match.
6. **Bug 6 (button label):** Click KANBAN to enter kanban mode. Verify the button in the pane header reads "Terminal" (not "term"). Click it — verify the pane switches back to terminal mode.

## Recommendation

Complexity is 4 → **Send to Coder**.

## Completion Summary

Implemented all six fixes in `src/webview/terminals.js` and `src/webview/terminals.html`: the panel now reads `data-initial-workspace-root` to default the kanban pane to the board-selected workspace, the duplicate sidebar KANBAN MODE button was removed, the workspace and project pickers were merged into one combined dropdown, project names are hidden when a project filter is active, complexity is rendered as "Complexity: Low" style plain text with colored words, and the mode-toggle button now reads "Terminal". The completion report is appended; no tests were run per the plan's instruction.

## Review Findings

Reviewed against plan requirements: all six bugs correctly implemented, no CRITICAL or MAJOR findings. Files changed: `src/webview/terminals.js`, `src/webview/terminals.html`. Verification: ESLint clean; 6 contract test suites pass (82/82 tests across terminal-sidebar-groupings, browser-kanban-pane-order, terminal-pane-pinning, terminal-solo-popout, terminal-sidebar-role-ordering, multi-parent-terminals). Two pre-existing test failures in other suites (paste-attribution, terminal-focus-affordance) are from unrelated plans' working-tree changes, not this plan. No orphaned references to removed identifiers. No race conditions beyond the documented fetch-guard interaction. Remaining risks: `split('|')` in combined picker will break if a project name contains a pipe character (pre-existing pattern shared with kanban.html); workspace switch can be dropped by fetch guard if poll is in flight (5s delay, acknowledged in plan).
