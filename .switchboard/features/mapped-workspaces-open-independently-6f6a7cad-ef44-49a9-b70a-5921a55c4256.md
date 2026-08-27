---
description: 'Mapped Workspaces Open Independently'
---

# Mapped Workspaces Open Independently

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
- [ ] (no subtasks)
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Subtask 1 hard-blocks subtask 3.** This is a correctness constraint, not a preference: the browser host currently sidesteps the first-match-wins redirect bug purely by never building the mapping index. Wiring the index up before the precedence fix lands would import that bug into a host that does not have it today.

**Subtask 2 should precede subtask 3.** Subtask 2 encodes the visibility rule — a workspace is visible iff it is one of the host's roots, or a member of a mapping whose parent is one of the host's roots. Without it, subtask 3 makes the browser list every workspace in the replicated mappings payload, including ones never opened. If subtask 3 must ship earlier, its own diff has to carry the visibility rule.

Recommended order: **1 → 2 → 3.** Subtasks 1 and 2 are independent of each other and could be parallelised, but subtask 1 is expected to resolve the reported symptom alone — landing it first allows re-measuring before sizing subtask 2.

Out of scope: `HeadlessSwitchboardOptions.workspaceRoot` is singular, so the browser host still cannot render a multi-parent mega workspace. That is a separate feature (multi-root standalone), not a bug fix.
