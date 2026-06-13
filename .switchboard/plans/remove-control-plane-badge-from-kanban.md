# Remove Control Plane Badge from Kanban UI

## Goal
Remove the "CONTROL PLANE: AUTO" badge from the kanban UI. This badge was added without user request and provides no value while taking up space in the interface.

**Core problem / background:** The kanban panel renders a redundant badge element (`workspace-control-plane-badge`) that duplicates control plane mode information already visible in the Setup panel. The badge and its supporting variables (`currentControlPlaneRoot`) are pure dead code. However, the closely-named `currentControlPlaneMode` variable is still required by the Worktrees tab logic (`createWorktreesPanel`), so it must be preserved.

## Metadata
**Complexity:** 2
**Tags:** ui, bugfix

## User Review Required
No

## Complexity Audit

### Routine
- Single-file change (`src/webview/kanban.html`).
- Deleting a single HTML `<span>` element.
- Removing a dead-code block inside an existing function (`updateWorkspaceFilterBadge`).
- Removing one unused variable declaration and one unused assignment.
- No new patterns introduced; purely subtractive.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. DOM and script changes are synchronous; no async paths involved.
- **Security:** None. Removing a read-only UI element does not alter trust boundaries.
- **Side Effects:** `currentControlPlaneMode` must NOT be removed — it drives the Worktrees tab info banner (`cpMode === 'none'` check at line ~8153). Removing it would suppress the banner and break user-facing guidance.
- **Dependencies & Conflicts:** `dist/webview/kanban.html` is a webpack CopyPlugin build artifact and will be regenerated automatically. Do not edit the dist file directly. The `.workspace-filter-badge` CSS class is shared with the remaining `workspace-filter-badge` element and must be preserved.

## Dependencies
None

## Adversarial Synthesis
Key risks: accidental removal of `currentControlPlaneMode` variable or assignment breaks the Worktrees tab info banner; `currentControlPlaneRoot` dead code may be missed. Mitigations: only remove badge-specific lines, preserve worktrees logic, verify `cpMode` still resolves correctly.

## Proposed Changes

### `src/webview/kanban.html`

**Context:** The kanban webview contains a hidden badge element and supporting JavaScript that renders a "CONTROL PLANE: {MODE}" label. This badge is the only consumer of `currentControlPlaneRoot` and the only UI consumer of `currentControlPlaneMode` inside `updateWorkspaceFilterBadge`. The Worktrees tab (`createWorktreesPanel`) separately uses `currentControlPlaneMode` to decide whether to show an informational banner.

**Logic / Implementation:**

1. **Remove HTML badge element** (line ~2245)
   - Delete the `<span>` element with `id="workspace-control-plane-badge"`.
   - Keep the adjacent `workspace-filter-badge` element intact.

2. **Remove badge DOM lookup and render block** inside `updateWorkspaceFilterBadge()` (lines ~3777 and ~3786–3796)
   - Delete: `const controlPlaneBadge = document.getElementById('workspace-control-plane-badge');`
   - Delete the entire `if (controlPlaneBadge) { ... }` block that toggles visibility, sets text content, and assigns the title.
   - The remaining function body continues to handle `workspace-filter-badge` normally.

3. **Remove dead variable `currentControlPlaneRoot`** (lines ~3406 and ~5539)
   - Delete declaration: `let currentControlPlaneRoot = '';` (line ~3406).
   - Delete assignment: `currentControlPlaneRoot = msg.controlPlaneRoot || msg.effectiveControlPlaneRoot || '';` (line ~5539).
   - This variable is only used for `controlPlaneBadge.title`, which is being removed.

4. **Preserve `currentControlPlaneMode`** (lines ~3405, ~5538, ~8153)
   - **Do NOT delete** `let currentControlPlaneMode = 'none';` — required by Worktrees tab.
   - **Do NOT delete** `currentControlPlaneMode = msg.controlPlaneMode || msg.mode || 'none';` — required to keep the Worktrees tab banner state current.
   - **Do NOT delete** `const cpMode = currentControlPlaneMode || 'none';` — actively used in `createWorktreesPanel` to conditionally render the "No control plane configured" info banner.

5. **Do NOT remove `.workspace-filter-badge` CSS** (line ~101)
   - The class is still used by the remaining `workspace-filter-badge` element.

**Edge Cases:**
- If `updateWorkspaceFilterBadge()` is called before the DOM is ready, the existing `if (!badge) return;` guard remains unchanged.
- If the extension backend continues sending `controlPlaneMode` / `controlPlaneRoot` fields in workspace messages, they will simply be ignored by the kanban script — no error is raised.

## Verification Plan

### Automated Tests
Skipped per session directive.

### Manual Verification
- Open the kanban panel.
- Verify no "CONTROL PLANE: AUTO" (or similar) badge appears in the workspace/project strip.
- Verify workspace filtering still works correctly (the `FILTER: {name}` badge still appears when a filter is active).
- Switch to the Worktrees tab and verify the informational banner still displays when no control plane is configured (this proves `currentControlPlaneMode` was preserved).
- Verify overall kanban board rendering, drag-and-drop, and column interactions remain unchanged.

---

**Recommendation:** Send to Intern
