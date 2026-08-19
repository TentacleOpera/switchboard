# Standalone Host File Watcher Fix

**Complexity:** 5

## Goal

Fix all 13 broken file watchers in the standalone/browser host. Plan 1 fixes the no-op vscodeShim.createFileSystemWatcher at the source. Plan 2 arms the 7 Planning panel watchers from fetchRoots (the verb handler that runs in both hosts). Plan 3 arms the 4 Design panel watchers from the ready verb handler. Plans 1 and 2 must land together (plan 1 removes the bootstrap override that plan 2's watchFolder calls depend on).

## How the Subtasks Achieve This

- **Fix no-op vscodeShim.createFileSystemWatcher**: Replaces the no-op `createFileSystemWatcher` stub with a real `fs.watch`-backed implementation, adds the missing `RelativePattern` class to the shim (without which `VscodeHostFileWatcher` crashes on `new vscode.RelativePattern(...)`), adds the missing `fs` import, removes the redundant bootstrap `watchFolder` override, and updates the test assertions. This is the root-cause fix that makes all three watcher methods (`watchFolder`, `watchPattern`, `watchFile`) work in standalone without composition-root workarounds.
- **Arm Planning Panel Watchers in Standalone Host**: Adds all 8 `_setup*Watchers` calls to `_handleFetchRoots` (the verb handler that runs in both hosts on page load). In standalone, `open()` is never called, so these watchers were never armed. This plan arms them from the path standalone actually uses.
- **Arm Design Panel Watchers in Standalone Host**: Adds 4 primary `_setup*Watchers` calls to the `ready` verb handler (the Design panel equivalent of Planning's `fetchRoots`). The 5th watcher (Stitch HTML) is already armed from project-selection verb handlers but depends on plan 1's shim fix to actually fire.

## Dependencies & sequencing

- **Plan 1 must land first (or together with plans 2 and 3).** Plan 1 fixes the shim (`createFileSystemWatcher` + `RelativePattern` + `fs` import) and removes the bootstrap `watchFolder` override. Plans 2 and 3 arm watchers that call `watchFolder`/`watchFile` through `VscodeHostFileWatcher`, which routes through the shim. Without plan 1, arming the watchers would either crash (`RelativePattern` undefined → `TypeError`) or produce silent no-ops (stub `createFileSystemWatcher`).
- **Plans 2 and 3 are independent of each other.** They touch different files (`PlanningPanelProvider.ts` vs `DesignPanelProvider.ts`) and can be coded in parallel once plan 1 is complete.
- **All three plans should ship as a single delivery unit.** Plan 1 alone makes the shim real but arms no new watchers (the existing `watchFolder` override removal is safe because the shim is now real, but no new watchers are armed). Plans 2 or 3 alone without plan 1 would crash or no-op. The feature is only complete when all three are merged.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix no-op vscodeShim.createFileSystemWatcher — Root Cause of All Standalone Watcher Failures](../plans/feature_plan_20260819153323_fix-vscodeShim-createFileSystemWatcher-noop.md) — **CODER CODED**
- [ ] [Arm Planning Panel Watchers in Standalone Host](../plans/feature_plan_20260819153324_arm-planning-panel-watchers-in-standalone.md) — **CODER CODED**
- [ ] [Arm Design Panel Watchers in Standalone Host](../plans/feature_plan_20260819153325_arm-design-panel-watchers-in-standalone.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Completion Summary

All three subtasks implemented and reviewed. Plan 1 replaced the no-op `vscodeShim.createFileSystemWatcher` with a real `fs.watch`-backed implementation, added the missing `RelativePattern` class and `fs` import, removed the redundant bootstrap `watchFolder` override, and updated the test assertions (`vscodeShim.ts`, `bootstrap.ts`, `tickets-auto-refresh-on-file-change.test.js`). Plan 2 armed all 8 Planning panel watchers from `_handleFetchRoots` and made `_setupDocsFolderWatcher` idempotent (`PlanningPanelProvider.ts`). Plan 3 armed the 4 primary Design panel watchers from the `ready` verb handler (`DesignPanelProvider.ts`). No issues encountered; compilation and tests skipped per run directives.

