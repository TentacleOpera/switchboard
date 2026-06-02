# Implementation Plan - Fix Workspace Switch Lock and Terminal Commands

This plan addresses a bug where switching workspaces via the AUTOBAN dropdown (`kanban.html`) launches agent terminals in the new workspace location but fails to send any CLI startup commands.

## Goal

Fix the workspace switch flow so that selecting a child workspace in the kanban dropdown correctly activates the workspace context in the sidebar, re-initializes file watchers for the new workspace, and allows terminal startup commands to be dispatched.

## Metadata

- **Tags:** [bugfix, frontend, workflow]
- **Complexity:** 5

## User Review Required

- Confirm that the "race condition" root cause described below is actually a configuration validation gap, not a timing issue. If there IS a genuine timing path where `initializeMappingIndex` hasn't completed before user interaction, the fix for `_getAllowedRoots` should also include a fallback to open VS Code workspace folders.

## Complexity Audit

### Routine
- Resolving `currentRoot` through `resolveEffectiveWorkspaceRoot` before comparison in `refreshUI` (mirrors existing pattern in `KanbanProvider.refreshWithData`, line 1049)
- Adding `_setupStateWatcher()` call to `reinitializePlanWatcher` (one-line addition)
- Adding `effectiveRoot` to `foldersToWatch` in `_setupPlanWatcher` as a safety net

### Complex / Risky
- Fixing `_getAllowedRoots` in both `KanbanProvider` and `TaskViewerProvider` to accept open VS Code workspace folders even when mapping index hasn't listed them — this changes the validation semantics and could allow workspace switches to folders that were intentionally excluded from mappings
- The `refreshUI` guard interacts with `_activateWorkspaceContext`, which resets `_workspaceId` and `_workspaceIdRoot` when `currentRoot !== effectiveRoot` — the resolved-current-root fix changes when this reset fires

## Edge-Case & Dependency Audit

- **Race Conditions:** The plan originally claimed a race with `initializeMappingIndex`, but `extension.ts:400` awaits it before `KanbanProvider` construction. The real issue is a **configuration validation gap**: `_getAllowedRoots()` removes open workspace folders not found in mapping index, which can reject valid child workspaces if the mapping config is incomplete or the index rebuild hasn't propagated.
- **Security:** No security implications — workspace root validation is an internal consistency check, not a security boundary.
- **Side Effects:** Changing `_getAllowedRoots` to always include open VS Code workspace folders means previously-excluded folders (intentionally unmapped) will become switchable. This may surface workspaces the user deliberately excluded from the mapping.
- **Dependencies & Conflicts:** Both `KanbanProvider._getAllowedRoots` and `TaskViewerProvider._getAllowedRoots` must be updated in lockstep — they have nearly identical logic. A partial fix in only one provider will leave the other rejecting the switch.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Relaxing `_getAllowedRoots` may allow switches to intentionally-excluded workspaces; mitigated by only including folders that are open in VS Code (user-visible). (2) The `refreshUI` guard fix changes when `_workspaceId` resets, potentially causing a brief identity flicker during same-mapping switches; mitigated by the guard only firing when roots truly differ. (3) Both providers' `_getAllowedRoots` must be fixed in lockstep or the switch will still fail at one of the two validation gates.

## Cause of the Bug

The root causes of the issue are:

1. **Mismatched Guard Check in `TaskViewerProvider.refreshUI`** (line 2013):
   The guard compares the raw selected workspace root (`currentRoot` = child workspace, e.g. `Gitlab/fe`) directly with the resolved parent root (`effectiveRoot` = parent workspace, e.g. `Gitlab`) without resolving `currentRoot`'s effective root first. Since they differ, the guard triggers and returns early, aborting the workspace context activation inside `TaskViewerProvider`. Note: `KanbanProvider.refreshWithData` (line 1049) already does this correctly — it resolves `_currentWorkspaceRoot` through `resolveEffectiveWorkspaceRoot` before comparing. The `TaskViewerProvider.refreshUI` guard should follow the same pattern.

2. **Configuration Validation Gap in `_getAllowedRoots`** (both providers):
   `_getAllowedRoots()` in both `KanbanProvider` (line 503) and `TaskViewerProvider` (line 842) removes open VS Code workspace folders that are not found in any mapping when mappings are enabled (line 527/872-874). If a child workspace is open in VS Code but the mapping index doesn't include it (e.g., configuration drift, or the index hasn't been rebuilt after a mapping change), the folder is removed from `allowedRoots`, causing `setCurrentWorkspaceRoot` to reject the switch. The original plan described this as a "race condition after IDE restart" with `initializeMappingIndex`, but that function IS awaited before `KanbanProvider` construction (extension.ts:400). The real issue is that `_getAllowedRoots` is too aggressive in removing folders — it should always allow folders that are open in VS Code, regardless of mapping status.

3. **Stale State Watcher after Workspace Switch**:
   The native `fs.watch` fallback in `_setupStateWatcher()` (line 8514-8530) watches the state file for the workspace that was active when the watcher was created. `reinitializePlanWatcher` (line 3043) calls `_setupPlanWatcher()` and `reinitializeBrainWatcher()`, but does NOT call `_setupStateWatcher()`. After a workspace switch, the native fallback still watches the OLD workspace's state file, so sidebar state changes in the new workspace are not detected by the native fallback. (The VS Code glob watcher `**/.switchboard/state.json` is workspace-agnostic and still works, but the native fallback is needed for gitignored `.switchboard` directories.)

## Proposed Changes

### Kanban Service

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

- **`setCurrentWorkspaceRoot(workspaceRoot)` (line 653):** Update to allow switching to any workspace folder open in VS Code (`roots`), even if mappings are globally active and the folder is not in the mapping index. Change the validation from `allowed.has(resolved)` to `allowed.has(resolved) || roots.includes(resolved)` where `roots = this._getWorkspaceRoots()`. This ensures that any open VS Code workspace folder can be selected, regardless of mapping status.

- **`_resolveWorkspaceRoot(workspaceRoot?)` (line 563):** Update the validation check so that unmapped folders or folders selected during early startup are resolved to themselves rather than falling back to `roots[0]`. After checking `allowedRoots.has(resolved)`, add a fallback check: if the resolved path is in `this._getWorkspaceRoots()`, return it directly (without updating `_currentWorkspaceRoot`). This prevents the resolver from silently discarding a valid workspace selection.

- **`_getAllowedRoots()` (line 503):** Do NOT remove open VS Code workspace folders from `allowedRoots` even if they aren't in any mapping. Remove or guard the deletion block at lines 526-530:
  ```typescript
  // BEFORE (line 526-530):
  for (const root of roots) {
      if (!this.isWorkspaceInMapping(root)) {
          allowedRoots.delete(path.resolve(root));
      }
  }
  ```
  Change to: only remove a root if it is explicitly listed in a mapping exclusion list, or remove this block entirely since open VS Code folders should always be selectable. **Clarification:** This does not add new product scope — it restores the ability to switch to any open workspace folder, which was the original intent before mapping-based filtering was introduced.

### TaskViewerProvider

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

- **`refreshUI(workspaceRoot)` (line 2003):** Resolve the effective root of `currentRoot` first before comparing with `effectiveRoot`. Follow the pattern already used in `KanbanProvider.refreshWithData` (line 1049):
  ```typescript
  // BEFORE (line 2010-2018):
  const currentRoot = this._kanbanProvider?.getCurrentWorkspaceRoot();
  if (currentRoot && path.resolve(currentRoot) !== path.resolve(effectiveRoot)) {
      console.log(
          `[TaskViewerProvider] refreshUI: effectiveRoot ${effectiveRoot} differs from current ${currentRoot} — not switching workspace context`
      );
      return;
  }

  // AFTER:
  const currentRoot = this._kanbanProvider?.getCurrentWorkspaceRoot();
  const resolvedCurrentRoot = currentRoot
      ? (this._kanbanProvider?.resolveEffectiveWorkspaceRoot(currentRoot) || currentRoot)
      : null;
  if (resolvedCurrentRoot && path.resolve(resolvedCurrentRoot) !== path.resolve(effectiveRoot)) {
      console.log(
          `[TaskViewerProvider] refreshUI: effectiveRoot ${effectiveRoot} differs from resolved current ${resolvedCurrentRoot} — not switching workspace context`
      );
      return;
  }
  ```
  This prevents the guard from firing when switching to child workspaces belonging to the same database mapping (e.g., `Gitlab/fe` and `Gitlab` both resolve to `Gitlab`).

- **`_resolveWorkspaceRoot(workspaceRoot?)` (line 822):** Include open VS Code workspace folders in the validation check. After the `allowed.has(resolved)` check at line 827, add a fallback: if `resolved` is in `this._getWorkspaceRoots()`, return `resolved` directly. This mirrors the same fix in `KanbanProvider._resolveWorkspaceRoot`.

- **`_getAllowedRoots()` (line 842):** Same fix as `KanbanProvider._getAllowedRoots` — do not remove open VS Code workspace folders from `allowedRoots` even if they aren't in any mapping. Remove or guard the deletion block at lines 871-875.

- **`reinitializePlanWatcher(workspaceRoot)` (line 3043):** Add `this._setupStateWatcher()` call so that the `.switchboard/state.json` native fs.watch fallback is recreated for the new workspace root:
  ```typescript
  // BEFORE (line 3043-3047):
  public reinitializePlanWatcher(workspaceRoot: string): void {
      this._resolveWorkspaceRoot(workspaceRoot);
      this._setupPlanWatcher();
      this.reinitializeBrainWatcher();
  }

  // AFTER:
  public reinitializePlanWatcher(workspaceRoot: string): void {
      this._resolveWorkspaceRoot(workspaceRoot);
      this._setupStateWatcher();
      this._setupPlanWatcher();
      this.reinitializeBrainWatcher();
  }
  ```

- **`_setupPlanWatcher()` (line 8571):** Ensure the active workspace's `effectiveRoot` is always included in `foldersToWatch`, as a safety net beyond the mapping loop. After the mapping loop (line 8608) and before the fallback check (line 8614), add:
  ```typescript
  // Safety net: always include the effective root of the current workspace
  const effectiveRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(workspaceRoot) || workspaceRoot;
  if (!foldersToWatch.includes(path.resolve(effectiveRoot))) {
      foldersToWatch.push(path.resolve(effectiveRoot));
  }
  ```
  This ensures that even if the mapping config is incomplete or the effective root isn't a mapping parent, the plan watcher still monitors the correct directory.

---

## Verification Plan

### Automated Tests
- No automated test coverage exists for the workspace switch flow. The kanban board and sidebar are UI components tested manually. Adding unit tests for `_getAllowedRoots`, `_resolveWorkspaceRoot`, and `refreshUI` guard logic would be valuable but is out of scope for this bugfix.

### Manual Verification
1. Open VS Code in a multi-root setup with folders belonging to the same mapping (e.g. `switchboard` and `Gitlab/viaapp` / `Gitlab/fe`).
2. Restart the IDE.
3. Switch workspace immediately in `kanban.html` and verify the switch is successful (not rejected).
4. Navigate to the terminals tab in the sidebar and press "Open Agent Terminals".
5. Verify that terminals open in the new workspace location and the CLI startup commands (e.g. `claude --enable-auto-mode`) are successfully sent to each agent.
6. Verify the sidebar's startup commands list updates to match the newly switched workspace.
7. Verify that switching to a workspace folder that is NOT in any mapping still works (it should be selectable since it's an open VS Code folder).
8. Verify that the state.json watcher detects changes in the new workspace (e.g., modify `.switchboard/state.json` in the switched workspace and confirm the sidebar refreshes).

## Recommendation

Complexity 5 → **Send to Coder**

---

## Review Results (2026-06-02)

### Reviewer: Grumpy Principal Engineer (inline adversarial pass)

### Stage 1 Findings

| # | Severity | Description | Location |
|---|----------|-------------|----------|
| 1 | NIT | `_getAllowedRoots` / `isWorkspaceInMapping` philosophical contradiction — unmapped workspaces are now switchable but `initializeKanbanDbOnStartup` (TaskViewerProvider:1842) still skips them via `isWorkspaceInMapping`. DB is created on-demand but not pre-populated from files. Known design trade-off per plan's Adversarial Synthesis. | TaskViewerProvider.ts:1842 |
| 2 | NIT | Misleading log message in `KanbanProvider._resolveWorkspaceRoot` line 566 — says "not switching" but function still returns the resolved path. Pre-existing, not introduced by this change. | KanbanProvider.ts:566 |
| 3 | NIT | `_setupStateWatcher` recreates VS Code glob watcher `**/.switchboard/state.json` unnecessarily on workspace switch. Only the native `fs.watch` fallback needs recreation. Harmless but wasteful. | TaskViewerProvider.ts:8491-8532 |
| 4 | NIT | `_setupPlanWatcher` fallback at line 8620 (`if (foldersToWatch.length === 0)`) is partially dead code when mappings are enabled, since the safety net at line 8614 always adds at least one entry. Still useful as defense-in-depth for no-mappings case. | TaskViewerProvider.ts:8620-8623 |
| 5 | NIT | TaskViewerProvider._resolveWorkspaceRoot line 836 checks `path.resolve(kanbanRoot)` but returns `kanbanRoot` (unresolved). Works due to `kanbanRoot` always being resolved by invariant, but asymmetrical. | TaskViewerProvider.ts:836 |

**No CRITICAL or MAJOR findings.**

### Stage 2 Synthesis

- **Keep:** All eight implementation changes are correct and match the plan requirements.
- **Fix Now:** Nothing — no CRITICAL/MAJOR findings.
- **Defer:** All five NITs are either pre-existing, harmless, or acknowledged design trade-offs.

### Implementation Verification

All eight plan requirements verified against actual code:

1. **KanbanProvider._getAllowedRoots** (line 503): Deletion block removed. Method now starts with `new Set<string>(roots)`, adds mapping entries, returns without deletion. ✓
2. **KanbanProvider._resolveWorkspaceRoot** (line 558): Fallback `if (this._getWorkspaceRoots().includes(resolved)) { return resolved; }` added at line 571. Does NOT update `_currentWorkspaceRoot`. ✓
3. **KanbanProvider.setCurrentWorkspaceRoot** (line 651): Validation updated to `!allowed.has(resolved) && !roots.includes(resolved)` (De Morgan's equivalent of plan's `allowed.has(resolved) || roots.includes(resolved)`). ✓
4. **TaskViewerProvider._getAllowedRoots** (line 844): Deletion block removed. Matches KanbanProvider pattern. Both providers in lockstep. ✓
5. **TaskViewerProvider._resolveWorkspaceRoot** (line 822): Fallback added at line 828 for explicit root, and at line 836 for kanban-delegated root. ✓
6. **TaskViewerProvider.refreshUI** (line 2000): Guard updated to resolve `currentRoot` through `resolveEffectiveWorkspaceRoot` before comparing with `effectiveRoot`. Matches `KanbanProvider.refreshWithData` pattern. ✓
7. **TaskViewerProvider.reinitializePlanWatcher** (line 3043): `_setupStateWatcher()` added between `_resolveWorkspaceRoot` and `_setupPlanWatcher`. ✓
8. **TaskViewerProvider._setupPlanWatcher** (line 8572): Safety net added at lines 8614-8618 — `effectiveRoot` always included in `foldersToWatch`. ✓

### Typecheck Results

- Ran `npx tsc --noEmit` — 2 pre-existing errors only (import path extension issues in `ClickUpSyncService.ts:2310` and `KanbanProvider.ts:4771`). Neither is in a modified area. **No new type errors introduced.**

### Files Changed (by implementation)

- `src/services/KanbanProvider.ts`: `_getAllowedRoots` (deletion block removed), `_resolveWorkspaceRoot` (fallback added), `setCurrentWorkspaceRoot` (validation relaxed)
- `src/services/TaskViewerProvider.ts`: `_getAllowedRoots` (deletion block removed), `_resolveWorkspaceRoot` (fallback added), `refreshUI` (guard fix), `reinitializePlanWatcher` (state watcher added), `_setupPlanWatcher` (safety net added)

### Remaining Risks

1. **Unmapped workspace bootstrap gap** — switching to an unmapped workspace creates a DB on-demand but doesn't pre-populate from files. Low risk since unmapped workspaces typically don't have `.switchboard/` directories. If users report empty kanban boards, `initializeKanbanDbOnStartup` should be updated to also bootstrap unmapped workspaces.
2. **Implicit ordering dependency** — `reinitializePlanWatcher` relies on `setCurrentWorkspaceRoot` having been called first (so `_resolveWorkspaceRoot()` without args returns the new root). This is the existing call pattern but is fragile if refactored.

### Verdict

**PASS** — Implementation is complete and correct. All plan requirements satisfied. No code fixes needed.
