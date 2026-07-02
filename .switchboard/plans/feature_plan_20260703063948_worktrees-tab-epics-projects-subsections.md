# Worktrees Tab: Reorganize UI into Epics and Projects Subsections

## Goal

Reorganize the kanban.html Worktrees tab so the UI is divided between **Epics** and **Projects** top-level sections, each with clearly labeled subsections. This replaces the current flat layout where epic auto-mode radios, manual creation forms (project + epic + unbound), and the active worktrees list are all jumbled together without clear separation.

### Target Structure

```
WORKTREES (header + routing description + suppress checkbox)

EPICS
  ├── Auto (the three existing radio buttons: None / Per Subtask / High-Low)
  ├── Manual Creation (create epic worktree dropdown + button)
  └── Active Worktrees (all epic worktrees only)

PROJECTS
  ├── Manual Creation (create project worktree dropdown + button)
  └── Active Worktrees (all project worktrees only)

UNBOUND (ad-hoc unbound worktree button + any unbound active worktrees)
```

### Problem Analysis & Root Cause

The current `createWorktreesPanel()` function (kanban.html lines 9084–9580) builds the panel as a flat sequence of sections:

1. A config section with the routing-order description (lines 9088–9104).
2. A settings section with the suppress checkbox (lines 9107–9125).
3. An "EPICS" section containing ONLY the auto-mode radios (lines 9128–9187).
4. A single "CREATE NEW WORKTREE" action section containing the project dropdown, the (to-be-removed) batch-all-epics button, the single-epic dropdown, and the unbound button all mixed together (lines 9190–9388).
5. A single "ACTIVE WORKTREES" list that renders ALL worktrees (project, epic, unbound) in one flat list with epic worktrees nested under their parent project (lines 9390–9577).

The problem: epic controls and project controls are interleaved in the same action section, and the active worktrees list mixes epic and project worktrees without clear grouping. Users cannot quickly find "where do I create an epic worktree" vs "where do I create a project worktree."

The fix is structural reorganization of the DOM-building code — no backend changes, no database changes, no new message types. The existing message handlers (`createWorktreeForProject`, `createWorktreeForEpic`, `createWorktree`, `setEpicWorktreeMode`, `openWorktreeTerminals`, `mergeWorktree`, `abandonWorktree`, `toggleWorktreeAgentsOpenWithGrid`) all remain as-is.

## Metadata

- **Tags:** frontend, ui, ux, refactor
- **Complexity:** 4

## Complexity Audit

### Routine
- Moving existing DOM-building blocks into new subsection containers — the individual form elements (dropdowns, buttons, radios) stay identical, only their parent containers change.
- Splitting the active worktrees list into two filtered lists (epic worktrees vs project worktrees) — the `renderWorktreeRow()` helper is reused as-is; only the filtering and grouping logic changes.
- The repo-select dropdown (control plane mode) needs to appear once, shared by both manual-creation subsections. Move it above the Epics/Projects split, inside the existing config area.

### Complex / Risky
- **Epic→project nesting removal:** The current list nests epic worktrees under their parent project worktree (lines 9549–9556). After reorganization, epic worktrees live in the Epics → Active Worktrees subsection and project worktrees live in Projects → Active Worktrees. The nesting visual (`isNested = true`, the `↳` arrow) is no longer applicable in separate lists. This is a deliberate UX change — the user asked for clean separation, not nesting.
- **Unbound worktrees:** The current code has an "Unbound" creation button and renders unbound worktrees at the end of the list. The target structure does not explicitly mention unbound worktrees. Keep the unbound creation button and unbound active worktrees in a small separate "UNBOUND" section at the bottom, preserving existing behavior.

## Edge-Case & Dependency Audit

- **Worktree filtering logic:** Currently `projectWTs = worktrees.filter(w => w.project)` and `epicWTs = worktrees.filter(w => w.epicTopic)`. A worktree can have BOTH `epicTopic` and `epicProject` set (epic worktrees that belong to a project). The epic filter takes precedence — epic worktrees go in the Epics section, not the Projects section. The existing filter logic already does this correctly (`epicTopic` is checked first in the chip mapping at line 9450). Preserve this: filter epic worktrees by `w.epicTopic`, project worktrees by `w.project && !w.epicTopic`.
- **Empty state:** Each Active Worktrees subsection must show "No active epic worktrees." / "No active project worktrees." when empty, mirroring the current empty-state message.
- **Status badges:** The `getWorktreeStatuses` message (line 9572) currently sends ALL worktree IDs. After splitting, both subsections still need status badges. Keep sending all worktree IDs in one message — the status response handler updates badges by `data-wt-id` attribute, which works regardless of DOM location.
- **No backend changes:** All message types and handlers remain unchanged. This is pure frontend DOM reorganization.

## Proposed Changes

### `src/webview/kanban.html` — Reorganize `createWorktreesPanel()`

Restructure the function body. The high-level flow becomes:

```javascript
function createWorktreesPanel(config) {
    const container = document.createElement('div');
    container.style.cssText = 'padding: 12px; display: flex; flex-direction: column; gap: 16px;';

    // 1. Header section: WORKTREES title + routing description + suppress checkbox
    //    (keep existing code for lines 9088–9125, including the repo-select dropdown
    //     if controlPlaneMode === 'explicit' — move it here from the old action section)

    // 2. EPICS section
    const epicsSection = document.createElement('div');
    epicsSection.className = 'db-subsection';
    // Header: "EPICS"

    // 2a. Auto subsection (the three radio buttons)
    //     Move existing autoModeGroup code (lines 9143–9186) here.

    // 2b. Manual Creation subsection
    //     Move existing single-epic dropdown + "Create Epic Worktree" button (lines 9313–9363) here.

    // 2c. Active Worktrees subsection (epic worktrees only)
    //     Filter: worktrees.filter(w => w.epicTopic)
    //     Render each with renderWorktreeRow(w, false) — no nesting.

    // 3. PROJECTS section
    const projectsSection = document.createElement('div');
    projectsSection.className = 'db-subsection';
    // Header: "PROJECTS"

    // 3a. Manual Creation subsection
    //     Move existing project dropdown + "Create Project Worktree" button (lines 9248–9296) here.

    // 3b. Active Worktrees subsection (project worktrees only)
    //     Filter: worktrees.filter(w => w.project && !w.epicTopic)
    //     Render each with renderWorktreeRow(w, false) — no nesting.

    // 4. UNBOUND section (keep small, at bottom)
    //     Move existing "Create Worktree (Unbound)" button (lines 9365–9386) here.
    //     Active unbound worktrees: worktrees.filter(w => !w.project && !w.epicTopic)

    // 5. Status request (keep existing getWorktreeStatuses call, send ALL worktree IDs)

    return container;
}
```

#### Key implementation details:

**Subsection helper** — to avoid repetition, create a small helper:

```javascript
function createSubsection(titleText) {
    const section = document.createElement('div');
    section.className = 'db-subsection';
    const header = document.createElement('div');
    header.className = 'subsection-header';
    const span = document.createElement('span');
    span.textContent = titleText;
    header.appendChild(span);
    section.appendChild(header);
    return section;
}
```

**Active worktrees rendering** — extract the list rendering into a helper that takes a filtered array and an empty-state message:

```javascript
function renderWorktreeList(worktreeSubset, emptyMessage) {
    const listDiv = document.createElement('div');
    listDiv.style.cssText = 'margin-top:8px; display:flex; flex-direction:column; gap:8px;';
    if (!worktreeSubset.length) {
        listDiv.innerHTML = `<div style="font-size:11px; color:var(--text-secondary); padding:4px 0;">${emptyMessage}</div>`;
        return listDiv;
    }
    worktreeSubset.forEach(w => listDiv.appendChild(renderWorktreeRow(w, false)));
    return listDiv;
}
```

Note: `renderWorktreeRow` must be hoisted or defined before it's called by the subsection helpers. Currently it's defined inside the `setTimeout` callback (line 9420). Move it outside the setTimeout so it's available during panel construction. The `setTimeout(() => { ... }, 0)` pattern was used to wait for DOM mounting; with the new structure, render the lists directly (no setTimeout needed) since we're building DOM elements, not querying by ID.

**Repo-select dropdown** — move the control-plane repo-select (lines 9202–9246) into the header section, below the suppress checkbox description. It's shared by both the Epics and Projects manual-creation subsections.

## Verification Plan

1. Open the kanban board and switch to the Worktrees tab.
2. Confirm the panel is divided into clear EPICS and PROJECTS top-level sections.
3. Confirm the EPICS section has three subsections: Auto (three radios), Manual Creation (epic dropdown + button), Active Worktrees (epic worktrees only).
4. Confirm the PROJECTS section has two subsections: Manual Creation (project dropdown + button), Active Worktrees (project worktrees only).
5. Confirm the UNBOUND section appears at the bottom with the unbound creation button and any unbound active worktrees.
6. Create an epic worktree via the Epics → Manual Creation dropdown. Confirm it appears in Epics → Active Worktrees.
7. Create a project worktree via the Projects → Manual Creation dropdown. Confirm it appears in Projects → Active Worktrees.
8. Confirm epic worktrees that have `epicProject` set appear in the Epics section (NOT the Projects section).
9. Confirm the auto-mode radios still persist their selection (toggle, reload tab, verify state).
10. Confirm the "Open terminals", "Merge", and "Abandon" buttons on each worktree row still work.
11. Confirm the "Open terminals with grid" checkbox on each row still works.
12. Confirm status badges (⋯ → clean/dirty) still update for worktrees in both sections.
13. Confirm the repo-select dropdown (control plane mode) appears once in the header and applies to both manual-creation subsections.
14. Run `npm run compile` to confirm no TypeScript errors.
