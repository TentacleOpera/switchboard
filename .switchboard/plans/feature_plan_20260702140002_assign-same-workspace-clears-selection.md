# Assign To Same Workspace Should Clear The Plan Selection (Not Toast)

## Goal

When the user clicks **ASSIGN** with plans selected and the target is the **same workspace they're already in, with no project target, and none of the selected plans have a project assignment**, the action should silently **clear the plan selection** instead of showing the `Plans are already in this workspace with no project assignment.` info toast. The selection state is otherwise invisible to the user, so re-clicking ASSIGN on the current workspace must serve as the "deselect / I'm done" gesture.

### Problem analysis / root cause

The ASSIGN button handler lives in `src/webview/kanban.html` at line 6901 (`btn-assign-workspace-project` click). It computes `isSameWorkspace` from the selected cards' source workspaces (line 6921), then at lines 6923-6934:

```js
if (isSameWorkspace && (!targetProject || targetProject === '__unassigned__')) {
    const hasAnyProjectAssignment = Array.from(selectedCards.values()).some(val => {
        const cardProject = val && typeof val === 'object' ? val.project : '';
        return !!cardProject;
    });
    if (!hasAnyProjectAssignment) {
        // True no-op: same workspace, no project target, and no cards have project assignments
        vscode?.postMessage?.({ type: 'showInfo', message: 'Plans are already in this workspace with no project assignment.' });
        return;
    }
}
```

So the only feedback the user gets in the genuine no-op case is an info toast — the cards stay selected (`.kanban-card.selected` class remains, `selectedCards` Map stays populated, the ASSIGN button still reads `ASSIGN (N)`). There is no other affordance to clear a selection the user can no longer identify, so the toast reads as a dead end rather than a usable action.

The codebase already has a canonical "clear selection + update UI" pattern used everywhere else (e.g. lines 6982-6989 after a successful assign, 5747-5748 on epic-only drop, 5764-5767 on CODED_AUTO drop):

```js
selectedCards.clear();
updateReassignButtonVisibility();
updateEpicActionButton();
document.querySelectorAll('.kanban-card.selected').forEach(el => { el.classList.remove('selected'); });
```

The fix is to swap the toast+`return` for that exact clear-selection block.

### Important: keep the "clear project" path intact

The `hasAnyProjectAssignment` branch is **not** a no-op: when the selected plans *do* have a project and the target is the current workspace with no project, the existing fall-through (lines 6965-6978) correctly runs `assignSelectedToProject` with an empty project name to **clear** their project assignment. That path must remain untouched — only the true no-op branch (no project on any card) changes behavior.

## Metadata

**Complexity:** 2
**Tags:** frontend, kanban, ux, bug

## Current State

- `selectedCards` is a `Map` declared at `kanban.html:3839`; selection toggling populates it with `{workspaceRoot, project, isEpic, ...}` values.
- `updateReassignButtonVisibility()` (`kanban.html:6859`) sets the ASSIGN button label/disabled from `selectedCards.size`.
- `updateEpicActionButton()` (`kanban.html:6873`) sets the PROMOTE/EPIC button from the selection.
- The clear-selection pattern is used identically in ≥4 places, so there is a single established idiom to reuse.

## Complexity Audit

**Routine.** A 4-line swap in one event handler, reusing an existing helper trio. No backend change, no message protocol change, no state-shape change. The only judgment call is preserving the genuine "clear project assignment" fall-through, which the placement of the change (inside the `!hasAnyProjectAssignment` guard) already guarantees.

## Edge-Case & Dependency Audit

- **Genuine "clear project" case must still work** — the change is scoped to the `if (!hasAnyProjectAssignment)` inner branch only; the outer `isSameWorkspace && no-target` guard and its fall-through to `assignSelectedToProject` are untouched. Selected plans that *have* a project still get their project cleared by the empty-project assignment.
- **Cross-workspace assign** — unaffected; the `!isSameWorkspace` branch (line 6937) is never reached from the changed block.
- **No selection** — the handler already early-returns at line 6906 (`sessionIds.length === 0`), so the cleared state is stable.
- **Toasts** — removing the info toast here is consistent with the project's "no unnecessary dialogs" stance; clearing the selection is itself the visible feedback (cards un-highlight, button resets to `ASSIGN`).
- **Subsequent re-selection** — clearing `selectedCards` and removing `.selected` is exactly what the rest of the app does, so re-selecting cards afterward works as normal.

## Proposed Changes

### 1. `src/webview/kanban.html` — replace the no-op toast with clear-selection

At lines 6930-6934, replace:

```js
if (!hasAnyProjectAssignment) {
    // True no-op: same workspace, no project target, and no cards have project assignments
    vscode?.postMessage?.({ type: 'showInfo', message: 'Plans are already in this workspace with no project assignment.' });
    return;
}
```

with:

```js
if (!hasAnyProjectAssignment) {
    // Same workspace, no project target, and no cards have a project to clear:
    // treat ASSIGN-to-here as "deselect" so the user has a way to clear an
    // otherwise-invisible selection. No toast — clearing IS the feedback.
    selectedCards.clear();
    updateReassignButtonVisibility();
    updateEpicActionButton();
    document.querySelectorAll('.kanban-card.selected').forEach(el => {
        el.classList.remove('selected');
    });
    return;
}
```

This is the identical pattern already used at lines 6982-6989 (post-assign optimistic clear), so it is idiomatic to the file.

### 2. Tests

This is pure webview DOM behavior with no backend round-trip in the changed branch (it returns before any `postKanbanMessage`). If the webview has a JS test harness, add a case that:
- Seeds `selectedCards` with 2 same-workspace, no-project entries + adds `.selected` to two card elements.
- Triggers the ASSIGN click with the workspace-project dropdown pointed at the same workspace / no project.
- Asserts `selectedCards.size === 0`, the ASSIGN button label is `ASSIGN` + disabled, no `.kanban-card.selected` remains, and **no** `showInfo` message was posted.

If no webview JS harness exists, cover via the manual verification step.

## Non-Goals

- No change to cross-workspace reassignment or project-assignment clearing.
- No new "deselect" button or UI affordance — the ASSIGN-to-current-workspace gesture becomes the deselect.
- No backend / `KanbanProvider` change.

## Verification Plan

1. (If harness) unit test from §2.
2. Manual: select 1–3 plans in the current workspace (no project filter) → confirm ASSIGN reads `ASSIGN (N)` and cards are highlighted → set the workspace-project dropdown to the current workspace with no project → click ASSIGN → confirm the toast does **not** appear, the cards un-highlight, and ASSIGN resets to disabled `ASSIGN`.
3. Manual regression: select a plan that **has** a project assignment → point dropdown at current workspace / no project → click ASSIGN → confirm the plan's project **is** cleared (the genuine clear-project path still works) and the selection clears afterward as before.
4. Manual regression: select plans in workspace A, point dropdown at workspace B → click ASSIGN → confirm cross-workspace reassignment still runs.

## User Review Required

None.
