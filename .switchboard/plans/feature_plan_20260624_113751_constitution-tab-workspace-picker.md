# Add Workspace Picker to the Constitution Tab in project.html

## Goal

The `project.html` **Constitution** tab does not have a workspace picker. Because Switchboard supports multiple workspaces, the sidebar currently displays workspaces in a weird/inconsistent way for this tab. Add a **workspace picker** to the Constitution tab so the user can select which workspace's constitution (and, after the split, system files) they are viewing/editing.

### Problem Analysis

Other tabs in `project.html` (and other panels) have a workspace picker that sets the active workspace context. The Constitution tab lacks one, so the workspace context for constitution viewing/editing is ambiguous — the sidebar shows workspaces oddly because there is no picker driving the active workspace for this tab. This makes multi-workspace projects confusing and risks editing the wrong workspace's constitution.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, ux, bug

## Complexity Audit

### Routine
- Add a workspace picker dropdown to the Constitution tab header.
- Wire it to the existing workspace-selection infrastructure (the same mechanism other tabs use).
- Ensure constitution/system-file load respects the selected workspace.

### Complex / Risky
- If the Constitution tab currently loads constitution data without a workspace parameter, the load path must be updated to accept and use the selected workspace ID.
- The sidebar workspace display logic must be reconciled so the picker and sidebar agree on the active workspace.

## Edge-Case & Dependency Audit

- **Multi-workspace:** Switching workspaces via the picker must reload the constitution (and system files) for the newly selected workspace.
- **Single-workspace projects:** Picker still shows but with one entry; no regression.
- **Sidebar sync:** The sidebar's workspace list should reflect the picker's selection (and vice versa if the sidebar is also selectable).
- **Dependency:** Coordinate with the Constitution/System tab split plan — the picker should cover both tabs once split.

## Proposed Changes

### project.html — Constitution tab workspace picker
- **Context:** The Constitution tab header currently has no workspace selector.
- **Logic:** Add a workspace picker (dropdown) that lists all configured workspaces and sets the active workspace for this tab.
- **Implementation:** Reuse the existing workspace-picker component/pattern used by other tabs. On change, reload the constitution (and system files) for the selected workspace.
- **Edge Cases:** Default to the currently active workspace. Persist the selection per session if other tabs do.

### project.html — load path workspace awareness
- **Context:** The constitution load may currently assume a single workspace or the global active workspace.
- **Logic:** Pass the selected workspace ID into the constitution (and system file) load request.
- **Implementation:** Update the load handler to read the picker's value and include it in the data fetch.
- **Edge Cases:** Fallback to the global active workspace if the picker has no selection.

## Verification Plan

- [ ] Constitution tab shows a workspace picker listing all workspaces.
- [ ] Selecting a different workspace reloads that workspace's constitution.
- [ ] Sidebar workspace display is consistent with the picker selection.
- [ ] Single-workspace project: picker shows one entry, no regression.
- [ ] After the Constitution/System split, the picker covers both tabs.
