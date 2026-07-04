# Project carrier hardening (auto-create row, writeback, explicit clear)

## Goal

Make `**Project:** <name>` a fully robust file-authoritative carrier under model C: guarantee the
`projects` row exists so `project_id` resolves (or the card silently drops off its board), add
DB→file writeback so UI reassignments keep the file truthful, and make project *clear* explicit
(never by omission).

### Core problem & root cause

`**Project:**` is already file-authoritative for the *name* (`planMetadataUtils.ts:96`; re-stamped
on re-import only when present, `GlobalPlanWatcherService.ts:619-629`). But the board filters and
JOINs on `project_id` (`KanbanDatabase.ts:2792/2804`), and every writer derives `project_id` from
the name at apply time (`insertFileDerivedPlan:1437-1449`, `updatePlanProjectByPlanFile:1941`,
`setProjectForPlans:2637`). If the named `projects` row doesn't exist yet, `project_id` resolves to
`NULL` and the plan **drops off its project board** — the exact hazard V35/V38 backfill migrations
exist to repair. And UI reassignment (`setProjectForPlans`) never writes the file, so after a UI
move the file lies; while omission can't clear the project (COALESCE stickiness), so remote clear
is impossible today.

## Metadata

- **Project:** Switchboard
- **Tags:** kanban, projects, watcher, frontmatter, reconciliation
- **Complexity:** 5

## Implementation

1. **Auto-create the project row on import.** When applying `metadata.project` (new + existing
   branches, and `updatePlanProjectByPlanFile`), if no `projects` row matches the name, create it
   (reuse `addProject`, `KanbanDatabase.ts:2597`) before resolving `project_id`. Closes the
   drop-off-board gap for file-named projects.

2. **DB→file writeback.** On `setProjectForPlans` / `assignSelectedToProject`
   (`KanbanProvider.ts:6239`) write `**Project:** <name>` back into each affected plan file
   (position-stable writer; pending-suppress; `updated_at` bump; base update per the foundation).

3. **Reconciliation + explicit clear.** Reuse the foundation's base (`base_project`) + CAS +
   ledger so a resurrected file doesn't revert a UI reassignment. Project *clear* uses an explicit
   sentinel (e.g. `**Project:** none`) → apply `updatePlanProjectByPlanFile('', …)`; bare omission
   is a no-op.

## User Review Required

- Confirm auto-creating a `projects` row from a file-named project (vs rejecting unknown names).
- Confirm the clear sentinel spelling, consistent with `**Epic:** none`.
- Note: assigning a project to an **epic** does NOT cascade to subtasks today
  (`assignSelectedToProject` acts only on selected ids) — confirm whether writeback should keep
  that non-cascading behavior (recommended: yes, match current semantics).

## Complexity Audit

### Routine
- Add-project-if-missing before id resolution (reuses `addProject`).
- Writeback via the shared position-stable writer.

### Complex / Risky
- **Auto-create side effects:** a typo'd project name in a file would silently create a junk
  project. Consider normalizing/trimming and logging created-from-file projects.
- **project vs project_id coherence** must hold after every path — always resolve/repair id from
  name in the same transaction as the name write.

## Edge-Case & Dependency Audit

- **Depends on:** the foundation (base/ledger). Independent of the epic-membership carrier but
  shares its machinery.
- **`deleteProject`** (`KanbanDatabase.ts:2611`) clears name+id on all matching plans; with
  writeback, those files should get the clear sentinel or the next re-import re-creates the
  project. Cover this in the delete path.
- **Migration:** additive; existing `**Project:**` behavior unchanged except unknown names now
  auto-create instead of NULL-ing the id (strictly an improvement; matches V35/V38 intent).
