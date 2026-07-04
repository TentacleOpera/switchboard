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

The current `createWorktreesPanel()` function (kanban.html lines 9613–10110) builds the panel as a flat sequence of sections:

1. A config section with the routing-order description (lines 9618–9633).
2. A settings section with the suppress checkbox (lines 9636–9654).
3. An "EPICS" section containing ONLY the auto-mode radios (lines 9657–9716).
4. A single "CREATE NEW WORKTREE" action section containing the repo-select dropdown, the project dropdown, the (to-be-removed) batch-all-epics button, the single-epic dropdown, and the unbound button all mixed together (lines 9719–9917).
5. A single "ACTIVE WORKTREES" list that renders ALL worktrees (project, epic, unbound) in one flat list with epic worktrees nested under their parent project (lines 9919–10107).

The problem: epic controls and project controls are interleaved in the same action section, and the active worktrees list mixes epic and project worktrees without clear grouping. Users cannot quickly find "where do I create an epic worktree" vs "where do I create a project worktree."

The fix is structural reorganization of the DOM-building code — no backend changes, no database changes, no new message types. The existing message handlers (`createWorktreeForProject`, `createWorktreeForEpic`, `createWorktree`, `setEpicWorktreeMode`, `openWorktreeTerminals`, `mergeWorktree`, `abandonWorktree`, `toggleWorktreeAgentsOpenWithGrid`) all remain as-is.

## Metadata

- **Tags:** frontend, ui, ux, refactor
- **Complexity:** 4

## User Review Required

Yes — the reorganization deliberately removes the epic→project nesting visual (the `↳` arrow and indented rows). Confirm that clean separation into Epics/Projects active-worktrees lists is preferred over the current nested view before implementing.

## Dependencies

- **Hard dependency:** Plan `feature_plan_20260703063946` (remove batch button) should land first — this plan's target structure omits the batch button, and landing removal first avoids a transient dead button in the new layout.
- **Soft dependency:** Plan `feature_plan_20260703063947` (descriptive text) should land after this one so the text anchors into the final section layout.
- Line numbers in this plan are anchored against the **current HEAD with the batch button still present**. If the batch-button removal lands first, subtract ~14 lines from the action-section anchors (the batch block is kanban.html lines 9827–9840).

## Complexity Audit

### Routine
- Moving existing DOM-building blocks into new subsection containers — the individual form elements (dropdowns, buttons, radios) stay identical, only their parent containers change.
- Splitting the active worktrees list into two filtered lists (epic worktrees vs project worktrees) — the `renderWorktreeRow()` helper is reused as-is; only the filtering and grouping logic changes.
- The repo-select dropdown (control plane mode) needs to appear once, shared by both manual-creation subsections. Move it above the Epics/Projects split, inside the existing config area.

### Complex / Risky
- **Epic→project nesting removal:** The current list nests epic worktrees under their parent project worktree (lines 10079–10086). After reorganization, epic worktrees live in the Epics → Active Worktrees subsection and project worktrees live in Projects → Active Worktrees. The nesting visual (`isNested = true`, the `↳` arrow at lines 9957–9962) is no longer applicable in separate lists. This is a deliberate UX change — the user asked for clean separation, not nesting.
- **Unbound worktrees:** The current code has an "Unbound" creation button (lines 9895–9915) and renders unbound worktrees at the end of the list (lines 10096–10099). The target structure does not explicitly mention unbound worktrees. Keep the unbound creation button and unbound active worktrees in a small separate "UNBOUND" section at the bottom, preserving existing behavior.

## Edge-Case & Dependency Audit

- **Worktree filtering logic (latent double-render bug):** Currently `projectWTs = worktrees.filter(w => w.project)` (line 10075) and `epicWTs = worktrees.filter(w => w.epicTopic)` (line 10076). A worktree can have BOTH `epicTopic` and `epicProject` set (epic worktrees that belong to a project). If an epic worktree object also carries a `project` field, the current `w.project` filter would include it in `projectWTs` AND `epicWTs`, causing a double render (once as a project row, once nested as an epic child). The current nesting logic masks this because the project-row render and the nested-epic render are visually distinct, but it is a latent bug. The reorganization MUST use the safe filter: epic worktrees by `w.epicTopic`, project worktrees by `w.project && !w.epicTopic`. This both fixes the latent double-render and enforces the epic-takes-precedence rule (chip mapping at line 9979 checks `epicTopic` first).
- **Empty state:** Each Active Worktrees subsection must show "No active epic worktrees." / "No active project worktrees." when empty, mirroring the current empty-state message (line 9943).
- **Status badges:** The `getWorktreeStatuses` message (lines 10102–10106) currently sends ALL worktree IDs. After splitting, both subsections still need status badges. Keep sending all worktree IDs in one message — the status response handler updates badges by `data-wt-id` attribute (line 9966), which works regardless of DOM location.
- **setTimeout / DOM mounting:** The current list rendering wraps everything in `setTimeout(() => { ... }, 0)` (line 9939) and re-queries the list via `document.getElementById('worktree-list')` (line 9940) because `listDiv` is created at line 9930 but the rows are appended inside the timeout. In the reorganized version, build the list DOM elements directly against the `listDiv` reference (no `getElementById`, no `setTimeout`) since we are constructing elements, not querying a mounted tree. Hoist `renderWorktreeRow` (currently defined inside the setTimeout at line 9949) to function scope so the subsection helpers can call it during panel construction.
- **No backend changes:** All message types and handlers remain unchanged. This is pure frontend DOM reorganization.

## Adversarial Synthesis

Key risks: latent double-render bug if project filter is not tightened to `w.project && !w.epicTopic`; setTimeout/getElementById pattern must be replaced with direct listDiv reference or rows will not mount; nesting removal is a deliberate UX change requiring user sign-off; line anchors shift if the batch-button removal lands first. Mitigations: safe filter documented with rationale; hoist renderWorktreeRow and build DOM directly; User Review Required flag set; line-shift note added to Dependencies.

## Proposed Changes

### `src/webview/kanban.html` — Reorganize `createWorktreesPanel()`

Restructure the function body. The high-level flow becomes:

```javascript
function createWorktreesPanel(config) {
    const container = document.createElement('div');
    container.style.cssText = 'padding: 12px; display: flex; flex-direction: column; gap: 16px;';

    // 1. Header section: WORKTREES title + routing description + suppress checkbox
    //    (keep existing code for lines 9618–9654, including the repo-select dropdown
    //     if controlPlaneMode === 'explicit' — move it here from the old action section at lines 9731–9775)

    // 2. EPICS section
    const epicsSection = document.createElement('div');
    epicsSection.className = 'db-subsection';
    // Header: "EPICS"

    // 2a. Auto subsection (the three radio buttons)
    //     Move existing autoModeGroup code (lines 9672–9715) here.

    // 2b. Manual Creation subsection
    //     Move existing single-epic dropdown + "Create Epic Worktree" button (lines 9843–9892) here.

    // 2c. Active Worktrees subsection (epic worktrees only)
    //     Filter: worktrees.filter(w => w.epicTopic)
    //     Render each with renderWorktreeRow(w, false) — no nesting.

    // 3. PROJECTS section
    const projectsSection = document.createElement('div');
    projectsSection.className = 'db-subsection';
    // Header: "PROJECTS"

    // 3a. Manual Creation subsection
    //     Move existing project dropdown + "Create Project Worktree" button (lines 9778–9825) here.

    // 3b. Active Worktrees subsection (project worktrees only)
    //     Filter: worktrees.filter(w => w.project && !w.epicTopic)
    //     Render each with renderWorktreeRow(w, false) — no nesting.

    // 4. UNBOUND section (keep small, at bottom)
    //     Move existing "Create Worktree (Unbound)" button (lines 9895–9915) here.
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

Note: `renderWorktreeRow` must be hoisted or defined before it's called by the subsection helpers. Currently it's defined inside the `setTimeout` callback (line 9949). Move it to function scope so it's available during panel construction. The `setTimeout(() => { ... }, 0)` pattern (line 9939) was used to wait for DOM mounting because the code re-queried the list via `document.getElementById('worktree-list')` (line 9940); with the new structure, render the lists directly against the `listDiv` reference (created at line 9930) — no setTimeout, no getElementById — since we're building DOM elements, not querying a mounted tree.

**Repo-select dropdown** — move the control-plane repo-select (lines 9731–9775) into the header section, below the suppress checkbox description. It's shared by both the Epics and Projects manual-creation subsections.

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

## Review Findings

**CRITICAL fix applied:** The new reorganized `createWorktreesPanel` was written correctly (EPICS/PROJECTS/UNBOUND sections, safe filter `w.project && !w.epicTopic`, `createSubsection`/`renderWorktreeList` helpers, no `setTimeout`/`getElementById`, status request sends all IDs) but was nested INSIDE the old flat-layout function that was never deleted. The old function (kanban.html line 9745) had no closing brace, causing `SyntaxError: Unexpected end of input` that broke the entire kanban webview. `renderWorktreeRow` was trapped inside the dead old function's scope, unreachable by the new function's `renderWorktreeList` helper. Fix: deleted the orphaned old function body (306 lines), hoisting `renderWorktreeRow` to outer scope and making the new `createWorktreesPanel` the sole definition. **Files changed:** `src/webview/kanban.html`. **Validation:** `node --check` passes clean; brace balance 1632/1632; single `createWorktreesPanel` at line 9869; `renderWorktreeRow` at outer scope line 9745; `DOMContentLoaded` listeners at top level. **Remaining risks:** NIT — the repo-select dropdown (control plane mode) is appended directly to `container` rather than a wrapper section, floating between the suppress description and EPICS section; cosmetic only.
