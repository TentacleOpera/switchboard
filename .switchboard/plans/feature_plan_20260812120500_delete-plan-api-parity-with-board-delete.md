# `DELETE /kanban/plans` Leaves the Markdown and the Feature File Behind — Bring It to Parity With the Board's Delete

## Goal

Make the HTTP delete-plan endpoint do what the board's delete button does: remove the DB row, unlink the plan's `.md` file, and regenerate the parent feature's subtask block. Today it does only the first, so an API delete silently reverses itself and can corrupt a feature file.

### Root cause: two delete paths, one of which was never finished

Switchboard deletes a plan two ways, and they disagree.

**The board button** — `deleteKanbanPlan` in `src/services/PlanningPanelProvider.ts:3765`. It:
1. captures `featureId` before the row is destroyed, with a comment explaining that the parent link is unrecoverable afterwards
2. deletes the DB row
3. unlinks the `.md` — *"Delete the .md file from disk so the watcher doesn't re-import it"* (`:3793`)
4. calls `regenerateFeatureFile(wsRoot, featureId)` when the plan was a subtask (`:3808`)

**The HTTP endpoint** — `_handleDeletePlan` in `src/services/LocalApiServer.ts:2983-3022`. It does step 2. It fetches the record first but uses only `record.planFile`. Step 3 is behind an opt-in query param (`:3014`), and step 4 does not exist at all.

Two defects follow.

**Defect 1 — the delete undoes itself.** Without `?deleteFile=true`, the row is removed and the file is left on disk, so the plan watcher re-imports it and the card comes back. The handler's own comment concedes this (`:3011-3012`): *"the .md file re-imports on the next `import_plans` unless the caller opts into unlinking it too."* The response is `{"success":true,"fileDeleted":false}`, which reads as a completed delete. A caller has no way to know the deletion is temporary unless it inspects `fileDeleted` and knows what that implies.

This is also inconsistent with how deletion works everywhere else in this product: deletes execute immediately and mean it. A delete that reappears is the same broken promise as a delete that silently no-ops.

**Defect 2 — deleting a subtask corrupts its feature file.** The board regenerates the parent feature's `## Subtasks` block; the API does not. Deleting a subtask over HTTP leaves an entry in a block marked *"auto-generated, do not edit"* pointing at a plan that no longer exists in the DB — and, once defect 1 is fixed, at a file that no longer exists on disk either. The feature then misreports its own composition to every agent and every rollup that reads it.

### Blast radius

No in-tree caller passes `deleteFile`. Grepping the extension for the param finds only the handler and its doc comment; the board button uses the `deleteKanbanPlan` planning verb, a different path that is already correct. The endpoint's consumers are therefore external agents and orchestrators following `.agents/skills/switchboard-orchestration/SKILL.md:84`, which documents `DELETE /kanban/plans?planId=<id>[&deleteFile=true]`.

Every such caller is today getting a delete that reverses itself. The flip moves them onto the behaviour they already believe they have.

## Implementation

### 1. Flip the `deleteFile` default

Unlink the plan file unless the caller explicitly passes `deleteFile=false`. Parse it as an opt-out: absent or any value other than `false` means delete.

**Keep the existing traversal guard** at `:3017` — `abs.startsWith(plansDir + path.sep)` — unchanged. It is stricter than the board path's workspace-root check and now guards a destructive default, so it becomes more load-bearing, not less. A `planFile` resolving outside `.switchboard/plans` must skip the unlink and report it, never widen the guard to accommodate it.

Preserve the existing swallow of a missing file: an already-gone file is not an error.

### 2. Regenerate the parent feature file

The handler already reads `record` before deleting (`:3004`), so `featureId` is available without a second query — capture it there, mirroring the board path's capture-before-mutate comment.

After a successful row delete, when the plan had a `featureId`, call the same `regenerateFeatureFile(workspaceRoot, featureId)` the board path uses. Reach it through the same provider rather than reimplementing subtask-block rewriting; the block's format is owned by that function.

A regeneration failure must not fail the delete — the row and file are already gone. Log it and report it in the response, as the board path does with `console.warn`.

### 3. Report what actually happened

`fileDeleted` stays in the response and stays meaningful. Add whether the feature file was regenerated, so a caller deleting a subtask can tell the cleanup ran. A caller must be able to distinguish "row gone, file gone, feature updated" from "row gone, everything else skipped."

### 4. Update the documented contract

`.agents/skills/switchboard-orchestration/SKILL.md:84` currently reads:

> `DELETE /kanban/plans?planId=<id>[&deleteFile=true]` — Delete the DB row; `deleteFile=true` also unlinks the `.md`

Rewrite it for the new default: the delete removes the row, the file, and refreshes the parent feature; `deleteFile=false` keeps the file, and say plainly that a kept file re-imports on the next scan — that is the whole reason the opt-out exists and the only way a caller can use it correctly.

## Verification Plan

1. **Default deletes the file.** Create a plan, confirm it imports, `DELETE` it with no flag. Confirm the row is gone, the `.md` is gone, and it does **not** reappear after a watcher scan. Reproduce the current re-import behaviour first so the regression is anchored on observed behaviour.
2. **Opt-out preserved.** Delete with `deleteFile=false`. Confirm the row goes, the file remains, and — as documented — the card re-imports.
3. **Subtask delete cleans its feature.** Create a feature with three subtasks, delete one via the API. Confirm the feature file's `## Subtasks` block lists two, with no dangling entry, and that the result matches deleting the same subtask from the board.
4. **Board parity.** Delete one plan via the board and an equivalent one via the API. Confirm identical end state on disk and in the DB.
5. **Traversal guard.** Force a record whose `planFile` resolves outside `.switchboard/plans`. Confirm nothing is unlinked and the response says so.
6. **Missing file.** Delete a plan whose `.md` is already gone. Confirm success, not a 500.
7. **Regeneration failure is non-fatal.** Force `regenerateFeatureFile` to throw. Confirm the row and file are still deleted and the failure is reported rather than swallowed.
8. **Non-subtask deletes.** Confirm a plan with no `featureId` deletes cleanly with no regeneration attempted.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, api, reliability
**Project:** Browser Switchboard
