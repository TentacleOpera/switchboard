# Assign To Same Workspace Should Clear The Plan Selection (Not Toast)

**Plan ID:** a7c3f2e1-8b4d-4e6a-9c5f-1a2b3c4d5e6f

## Goal

When the user clicks **ASSIGN** with plans selected and the target is the **same workspace they're already in, with no project target, and none of the selected plans have a project assignment**, the action should silently **clear the plan selection** instead of showing the `Plans are already in this workspace with no project assignment.` info toast. The selection state is otherwise invisible to the user, so re-clicking ASSIGN on the current workspace must serve as the "deselect / I'm done" gesture.

### Problem analysis / root cause

The ASSIGN button handler lives in `src/webview/kanban.html` at line 6904 (`btn-assign-workspace-project` click). It computes `isSameWorkspace` from the selected cards' source workspaces (line 6924), then at lines 6926-6937:

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

The codebase already has a canonical "clear selection + update UI" pattern used in most places (e.g. lines 6985-6992 after a successful assign, 5767-5770 on CODED_AUTO drop):

```js
selectedCards.clear();
updateReassignButtonVisibility();
updateEpicActionButton();
document.querySelectorAll('.kanban-card.selected').forEach(el => { el.classList.remove('selected'); });
```

Note: the epic-only drop clear (lines 5749-5750) uses a **truncated** version that omits `updateReassignButtonVisibility()` and `updateEpicActionButton()` — this is a different context (early return before those UI elements are relevant). The ASSIGN handler must use the **full** 4-call pattern since the ASSIGN and EPIC buttons are visible and their labels depend on selection state.

The fix is to swap the toast+`return` for that exact full clear-selection block.

### Important: keep the "clear project" path intact

The `hasAnyProjectAssignment` branch is **not** a no-op: when the selected plans *do* have a project and the target is the current workspace with no project, the existing fall-through (lines 6968-6981) correctly runs `assignSelectedToProject` with an empty project name to **clear** their project assignment. That path must remain untouched — only the true no-op branch (no project on any card) changes behavior.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, ux, bugfix

## User Review Required

None.

## Complexity Audit

### Routine
- 4-line swap in one event handler, reusing an existing helper trio (`selectedCards.clear()`, `updateReassignButtonVisibility()`, `updateEpicActionButton()`, `querySelectorAll('.kanban-card.selected').forEach`).
- No backend change, no message protocol change, no state-shape change.
- The only judgment call is preserving the genuine "clear project assignment" fall-through, which the placement of the change (inside the `!hasAnyProjectAssignment` guard) already guarantees.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — the handler is synchronous within the click event. No async operations in the changed branch (it returns before any `postKanbanMessage`).
- **Security:** None — no user input processed, no message protocol change.
- **Side Effects:** Clearing `selectedCards` and removing `.selected` class is the exact same side effect the app produces after every successful assign. No new side effects introduced.
- **Dependencies & Conflicts:**
  - **Genuine "clear project" case must still work** — the change is scoped to the `if (!hasAnyProjectAssignment)` inner branch only; the outer `isSameWorkspace && no-target` guard and its fall-through to `assignSelectedToProject` are untouched. Selected plans that *have* a project still get their project cleared by the empty-project assignment.
  - **Cross-workspace assign** — unaffected; the `!isSameWorkspace` branch (line 6940) is never reached from the changed block.
  - **No selection** — the handler already early-returns at line 6909 (`sessionIds.length === 0`), so the cleared state is stable. After clearing, if the user clicks ASSIGN again with no selection, the same early return fires — no error, no toast, no-op. The workspace-project dropdown state is irrelevant because the early return fires before any dropdown logic.
  - **Toasts** — removing the info toast here is consistent with the project's "no unnecessary dialogs" stance (CLAUDE.md: "NEVER add confirmation dialogs"); clearing the selection is itself the visible feedback (cards un-highlight, button resets to `ASSIGN`).
  - **Subsequent re-selection** — clearing `selectedCards` and removing `.selected` is exactly what the rest of the app does, so re-selecting cards afterward works as normal.

## Dependencies

None — this is a self-contained single-file change.

## Adversarial Synthesis

Key risks: stale line numbers (all references off by 3 lines from original plan — corrected in this version); pattern claim was overstated (epic-only drop uses truncated version, but ASSIGN handler correctly needs the full 4-call pattern). Mitigations: line numbers updated to current codebase; pattern claim corrected with note about the truncated epic-only variant. No other risks — the change is a 4-line swap in a synchronous handler with no backend interaction.

## Proposed Changes

### 1. `src/webview/kanban.html` — replace the no-op toast with clear-selection

At lines 6933-6937, replace:

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

This is the identical full pattern already used at lines 6985-6992 (post-assign optimistic clear), so it is idiomatic to the file.

**Context:** The handler is the `btn-assign-workspace-project` click listener at line 6904. The `isSameWorkspace` check is at line 6924. The `hasAnyProjectAssignment` guard is at line 6931. The change is inside the innermost `if (!hasAnyProjectAssignment)` block only.

**Logic:** Swaps an info toast (which provides no actionable feedback) for the canonical clear-selection sequence. The user sees cards un-highlight and the ASSIGN button reset to disabled `ASSIGN` — that IS the feedback.

**Edge Cases:** The genuine clear-project path (fall-through at lines 6968-6981) is untouched because the change is inside the `!hasAnyProjectAssignment` guard. Cross-workspace assign is untouched because it's in the `!isSameWorkspace` branch. No-selection state is handled by the early return at line 6909.

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

### Automated Tests

No automated test suite changes required (webview JS harness availability unknown). If a harness exists, add the test described in §2 above.

### Manual Verification

1. Select 1–3 plans in the current workspace (no project filter) → confirm ASSIGN reads `ASSIGN (N)` and cards are highlighted → set the workspace-project dropdown to the current workspace with no project → click ASSIGN → confirm the toast does **not** appear, the cards un-highlight, and ASSIGN resets to disabled `ASSIGN`.
2. Manual regression: select a plan that **has** a project assignment → point dropdown at current workspace / no project → click ASSIGN → confirm the plan's project **is** cleared (the genuine clear-project path still works) and the selection clears afterward as before.
3. Manual regression: select plans in workspace A, point dropdown at workspace B → click ASSIGN → confirm cross-workspace reassignment still runs.
4. After clearing (step 1), click ASSIGN again with no selection → confirm nothing happens (early return, no error).

## Recommendation

Complexity 2 → **Send to Intern**.

## Review Findings

**Reviewed:** `src/webview/kanban.html` lines 6993-7004. The implementation is an exact match to the plan — the `!hasAnyProjectAssignment` no-op branch now clears the selection (full 4-call pattern: `selectedCards.clear()`, `updateReassignButtonVisibility()`, `updateEpicActionButton()`, `querySelectorAll('.kanban-card.selected').forEach`) instead of showing a toast. No orphaned references to the removed toast string. The genuine clear-project fall-through is untouched. No fixes applied — zero CRITICAL/MAJOR/NIT findings. TypeScript typecheck: no new errors (5 pre-existing TS2835 errors in unrelated files). Remaining risk: none identified.
