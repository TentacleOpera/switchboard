# Remove Control Plane Badge from Kanban UI

## Goal
Remove the "CONTROL PLANE: AUTO" badge from the kanban UI. This badge was added without user request and provides no value while taking up space in the interface.

## Metadata
**Complexity:** 2
**Tags:** ui, bugfix

## Problem
The kanban UI displays a "CONTROL PLANE: AUTO" badge that:
- Was never requested by the user
- Takes up space in the UI with no functional benefit
- Is not part of the original control plane feature specification
- Only shows the current control plane mode (auto/explicit) which is already visible in the Setup panel

## Solution
Remove the control plane badge and all related code from `kanban.html`:

### Changes Required

1. **Remove HTML element** (line ~2245)
   - Delete: `<span id="workspace-control-plane-badge" class="workspace-filter-badge" hidden></span>`

2. **Remove JavaScript variable** (line ~3405)
   - Delete: `let currentControlPlaneMode = 'none';`

3. **Remove badge update logic** from `updateWorkspaceFilterBadge()` function (lines ~3786-3796)
   - Remove the entire `if (controlPlaneBadge)` block that sets badge text and visibility

4. **Remove message handler assignment** (line ~5538)
   - Delete: `currentControlPlaneMode = msg.controlPlaneMode || msg.mode || 'none';`

5. **Remove unused variable reference** (line ~8153)
   - Delete: `const cpMode = currentControlPlaneMode || 'none';`
   - If `cpMode` is used elsewhere, replace with direct value or remove the usage

## Verification
- Open kanban panel
- Verify no "CONTROL PLANE: AUTO" badge appears in the workspace/project strip
- Verify kanban functionality remains unchanged
- Verify workspace filtering still works correctly
