# Fix Kanban Second Function Bar Layout

## Summary
Reorganize the second function bar in kanban.html to improve UX by moving "Assign to Project" next to the project dropdown and replacing the "Add Project" text button with a simple + icon (matching the add plan icon style).

## Current State (lines ~1955-1964)
```html
<span id="workspace-control-plane-badge" class="workspace-filter-badge" hidden></span>
<button id="workspace-reset-control-plane" class="strip-btn" hidden>RESET AUTO-DETECT</button>
<select id="project-select" class="project-select" title="Filter by project">
    <option value="">All Projects</option>
</select>
<button id="btn-add-project" class="strip-btn is-teal" title="Add new project">ADD PROJECT</button>
<button id="btn-assign-project" class="strip-btn is-teal" title="Assign selected plans to project" disabled>ASSIGN TO PROJECT</button>
<button id="btn-delete-project" class="strip-btn" title="Delete selected project" style="display:none;">DELETE PROJECT</button>
<span id="project-filter-badge" class="workspace-filter-badge" hidden></span>
```

## Desired State
```html
<span id="workspace-control-plane-badge" class="workspace-filter-badge" hidden></span>
<button id="workspace-reset-control-plane" class="strip-btn" hidden>RESET AUTO-DETECT</button>
<select id="project-select" class="project-select" title="Filter by project">
    <option value="">All Projects</option>
</select>
<button id="btn-assign-project" class="strip-btn is-teal" title="Assign selected plans to project" disabled>ASSIGN TO PROJECT</button>
<button class="btn-add-plan" id="btn-add-project" data-tooltip="Add new project">+</button>
<button id="btn-delete-project" class="strip-btn" title="Delete selected project" style="display:none;">DELETE PROJECT</button>
<span id="project-filter-badge" class="workspace-filter-badge" hidden></span>
```

## Changes Required

### 1. Move "Assign to Project" button
- Move `<button id="btn-assign-project">` from after "Add Project" to immediately after the project dropdown
- This groups the project-related controls together: dropdown → assign → add

### 2. Replace "Add Project" button with + icon
- Change from: `<button id="btn-add-project" class="strip-btn is-teal" title="Add new project">ADD PROJECT</button>`
- Change to: `<button class="btn-add-plan" id="btn-add-project" data-tooltip="Add new project">+</button>`
- Use the same class (`btn-add-plan`) and icon style as the column header add plan button (line 3721)
- Update tooltip to use `data-tooltip` attribute for consistency

## Files to Modify
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html` (lines ~1957-1962)

## Verification
- Test that project dropdown still works
- Test that "Assign to Project" button still functions when plans are selected
- Test that "Add Project" + icon opens the project creation dialog
- Verify visual layout matches the desired grouping
