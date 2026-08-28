---
description: 'Mapped Workspaces Open Independently'
---

# Mapped Workspaces Open Independently

**Complexity:** 6

## Goal

Switchboard's workspace mappings let several repos share one board. Grouping works; opening one member on its own does not. A folder that owns its own control plane can be silently redirected to a group parent that is not even open in the window, and the board then renders permanently blank.

The cause is that mapping resolution has no notion of precedence and no notion of which folders are actually open. `resolveEffectiveWorkspaceRootFromMappings` returns on the first mapping that names a folder, in either role, so array order decides whether a repo keeps its own board or hands it away. Nothing checks whether the redirect target is present in the window. Downstream, the board's workspace list and plan watcher read the unscoped global mapping index and act on parents that were never opened, while `refreshUI` converts the resulting root mismatch into a silent early return — a blank board with no error, no fallback, and no recovery.

This feature makes mapping resolution deterministic and window-aware, brings the board's own consumers in line with it, and closes the standalone host's parity gap — where the mapping index is never built at all. Grouping keeps working exactly as it does today; opening any single member starts working.

## How the Subtasks Achieve This

- **A Workspace That Owns a Board Opens On Its Own**: Fixes resolution itself. Adds a precedence rule so parent-hood beats child-hood across all mappings instead of first-match-wins, and gates every redirect on the target being one of the host's roots — supplied through the existing `getWorkspaceRoots()` seam rather than a `vscode` import. This is the primary fix and is expected to resolve the reported symptom on its own.

- **The Board Shows Only the Workspaces You Opened**: Fixes the consumers. Moves the workspace dropdown, plan-watch folders, and allowed roots off the unscoped `getMappingsFromIndex()` onto scoped mappings, stops `_getWatchFolders` silently dropping the folder the user actually opened, and narrows the `refreshUI` guard so an unresolvable root recovers or surfaces instead of blanking the board forever. Defence in depth behind subtask 1.

- **The Browser Host Honours Workspace Mappings**: Closes the parity gap. `buildMappingIndexFromDbs` is called only from `extension.ts`, so mappings are inert in the standalone/browser host. Wires the index into `bootstrap.ts` behind the same visibility rule, and extracts the DB-discovery walk into one shared helper so the two composition roots stop drifting.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Browser Host Honours Workspace Mappings](../plans/the-browser-host-honours-workspace-mappings.md) — **CODER CODED** — ID: 2e268eaf-03af-4909-9595-761c6aec6247
- [ ] [The Board Shows Only the Workspaces You Opened](../plans/the-board-shows-only-the-workspaces-you-opened.md) — **CODER CODED** — ID: 8cffe45e-e4c0-4d11-b766-208df5879050
- [ ] [A Workspace That Owns a Board Opens On Its Own](../plans/a-workspace-that-owns-a-board-opens-on-its-own.md) — **CODER CODED** — ID: 307c9650-1593-481d-a576-088c9de326ec
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Subtask 1 hard-blocks subtask 3.** This is a correctness constraint, not a preference: the browser host currently sidesteps the first-match-wins redirect bug purely by never building the mapping index. Wiring the index up before the precedence fix lands would import that bug into a host that does not have it today.

**Subtask 2 should precede subtask 3.** Subtask 2 encodes the visibility rule — a workspace is visible iff it is one of the host's roots, or a member of a mapping whose parent is one of the host's roots. Without it, subtask 3 makes the browser list every workspace in the replicated mappings payload, including ones never opened. If subtask 3 must ship earlier, its own diff has to carry the visibility rule.

Recommended order: **1 → 2 → 3.** Subtasks 1 and 2 are independent of each other and could be parallelised, but subtask 1 is expected to resolve the reported symptom alone — landing it first allows re-measuring before sizing subtask 2.

Out of scope: `HeadlessSwitchboardOptions.workspaceRoot` is singular, so the browser host still cannot render a multi-parent mega workspace. That is a separate feature (multi-root standalone), not a bug fix.

## Team Dispatch Instructions

### A Workspace That Owns a Board Opens On Its Own

- **Seat:** Coder (Complexity 5)
- **Acceptance:**
  - A folder that is both a parent of mapping A and a child of mapping B resolves to itself, for both array orderings
  - All three `_hostRoots` states behave correctly: `null` (gate off, legacy behaviour), `[]` (gate on, no redirect), populated (gate on, redirect only to listed roots)
  - `buildMappingIndexFromDbs` two-pass precedence: a both-roles folder maps to itself in the index regardless of mapping order
  - `child-switchboard-creation-regression.test.ts` passes — no `.switchboard/` created anywhere
  - Grouping still works: open all group members multi-root → board shows the mega workspace as before
- **Must not touch:** `isAllowedSwitchboardLocation` (untouched by this plan); `src/standalone/bootstrap.ts` (parity note only — no code changes in this plan)

### The Board Shows Only the Workspaces You Opened

- **Seat:** Coder (Complexity 6)
- **Acceptance:**
  - Workspace dropdown lists only host roots plus children of mappings whose parent is a host root — non-open parents never appear
  - `_getWatchFolders()` always contains the current workspace root, for every combination of mappings-enabled and folder-is-mapped
  - `refreshUI` with an unresolvable current root posts state or re-activates; never returns silently. `refreshUI` for a genuinely different workspace still returns early
  - `switchboardLocationGuard.ts` keeps its global `getMappingsFromIndex()` read — the guard is NOT scoped
  - `child-switchboard-creation-regression.test.ts` passes
- **Must not touch:** `src/utils/switchboardLocationGuard.ts:94` — deliberate global read (scoping it weakens a safety guard that exists to stop `.switchboard/` appearing in child folders)

### The Browser Host Honours Workspace Mappings

- **Seat:** Coder (Complexity 5)
- **Acceptance:**
  - `buildMappingIndexFromDbs` is called in the boot path of `startHeadlessSwitchboard` in `src/standalone/bootstrap.ts`
  - `getMappingsFromIndex()` returns `{ enabled: true, mappings: [...] }` after standalone boot when a DB with enabled mappings exists at the launch root
  - `buildWorkspaceItems([workspaceRoot])` returns exactly one item when `workspaceRoot` is a mapped child launched alone (not every workspace in the payload)
  - No `kanban.db` file exists at a mapped child path after `startHeadlessSwitchboard` boots with the child as `workspaceRoot`
  - Stored `workspace_mappings` value is byte-identical before and after standalone boot (read-only adoption)
- **Must not touch:** `HeadlessSwitchboardOptions.workspaceRoot` (singular — multi-root standalone is out of scope); the `onDidChangeWorkspaceFolders` handler in `extension.ts` (owned by subtask 1)
