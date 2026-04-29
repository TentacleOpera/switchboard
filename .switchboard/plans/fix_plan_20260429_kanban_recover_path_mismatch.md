# Fix Kanban "Recover" Path Mismatch Bug

## Goal
Fix the "recover" function in the Switchboard kanban to properly handle plans that have been moved to the archive directory. Currently, when a plan is deleted and archived, clicking "recover" fails silently due to a path mismatch between the database and actual file location.

## Bug Description
When a plan is deleted from the kanban, it is moved to the `.switchboard/archive/plans/` directory, but the database still stores the original path in the `plan_file` field (e.g., `.switchboard/plans/feature_plan_xxx.md`). When a user clicks "recover" on a deleted plan, the system attempts to move the file from the stale path in the database rather than checking the archive directory, causing the recovery to fail silently.

## Steps to Reproduce
1. Create a plan in the kanban
2. Delete the plan (moves it to `.switchboard/archive/plans/`)
3. Click "recover" on the deleted plan in the kanban
4. Observe that the plan does not reappear in the active plans directory
5. Check the database - the plan still shows status "deleted"

## Expected Behavior
When "recover" is clicked on a deleted plan:
- The system should check both the active plans directory AND the archive directory for the plan file
- If found in archive, move it back to the active plans directory
- Update the database status to "active" and column to "CREATED"
- Update the `plan_file` path to reflect the correct location

## Actual Behavior
When "recover" is clicked:
- The system only looks at the `plan_file` path stored in the database
- If the file was moved to archive (different path), the recover action fails silently
- The plan remains in the archive with status "deleted" in the database
- No error message is shown to the user

## Root Cause
The "recover" function does not check the archive directory. It assumes the file is at the exact path stored in `plan_file`, which becomes stale when a plan is archived. The function needs to:
1. First check the path stored in `plan_file`
2. If not found there, check the archive directory
3. If found in archive, move it and update the database
4. If not found anywhere, show an error to the user

## Proposed Fix
Update the "recover" function in the kanban to:

1. **Add archive directory check**: Before attempting recovery, check if the file exists at the path stored in `plan_file`. If not, check the corresponding path in `.switchboard/archive/plans/`.

2. **Update plan_file path**: When recovering from archive, update the `plan_file` field in the database to reflect the new location in the active plans directory.

3. **Add error handling**: If the file cannot be found in either location, show a clear error message to the user instead of failing silently.

4. **Add logging**: Log recovery attempts and failures to the activity log for debugging.

## Files to Modify
- Kanban recovery function (likely in the Switchboard MCP server or kanban database operations)
- Database update logic for `plan_file` path corrections

## Verification
1. Delete a plan from the kanban
2. Click "recover" - verify it successfully moves back to active plans
3. Check database - verify `plan_file` path is correct and status is "active"
4. Attempt to recover a plan that doesn't exist - verify error message is shown
