# Delete-epic (and delete-plan) file-resurrect fix

## Goal

Stop a deleted epic/plan from being resurrected by its still-present `.md` file. Today
`deleteEpic` soft-deletes the DB row but leaves the file on disk, so the watcher re-imports it as
a fresh active epic. Under model C — where files can write state — this resurrect path is the same
bug class as the un-reaped manifest and must be closed for the whole design to be sound.

### Core problem & root cause

`deleteEpic` (`KanbanProvider.ts:8984-9021`) captures subtasks, cleans up epic worktrees, then
either tombstones subtasks (`deleteSubtasks`) or clears their `epic_id` (`clearEpicIdForEpic`,
`:9005`), and always `tombstonePlan(epic.planId)` (`:9007`). But `tombstonePlan`
(`KanbanDatabase.ts:3759`) only sets `status='deleted'` — **it does not remove the file**. And
`purgeOrphanedPlans` (`:3773`) only tombstones plans whose *file is missing*. So the epic `.md`
survives, the watcher re-derives the same `plan_id` from the filename UUID, re-stamps
`is_epic=1`, and the "deleted" epic reappears active on next scan/clone. The subtasks it kept were
unlinked in the DB but (pre-C) their files never referenced the epic; post-C, if their files carry
`**Epic:** <deletedId>`, they would also re-link on re-import.

## Metadata

- **Project:** Switchboard
- **Tags:** kanban, epics, delete, watcher, reconciliation, correctness
- **Complexity:** 6

## Implementation

Pick one consistent deletion contract (recommend A):

**A — Delete the file on delete (git-native).** On `deleteEpic`/delete-plan, remove the `.md`
(archive as `*.migrated.bak` per CLAUDE.md's archive-don't-unlink rule, or `git rm`), register the
path in the pending-delete set so the watcher's delete handler runs cleanly, and — for kept
subtasks — writeback the `**Epic:** none` sentinel / strip the line so they don't resurrect the
dead link. Matches the model-C principle "the file is part of the truth."

**B — Honor tombstones for present files.** Keep the file but make the watcher respect a
persisted delete-tombstone: on import, if a plan_id is tombstoned and the file's content
fingerprint matches the tombstoned state, skip re-import (consumed-fingerprint ledger again).
Requires a durable tombstone the ledger checks. Keeps files around but adds import-time state.

Either way, the **consumed-fingerprint ledger** from `manifest-redelivery-idempotency-and-reaping.md`
is the safety net: a resurrected file whose state was already applied/deleted is a no-op.

## User Review Required

- Choose contract **A** (delete/archive the file) vs **B** (keep file, honor tombstone on import).
  A is simpler and git-native; B preserves the file but needs durable tombstones. Recommend A.
- Confirm archiving deleted plan/epic files as `*.migrated.bak` (CLAUDE.md: archive, don't unlink)
  vs a hard `git rm`.

## Complexity Audit

### Routine
- Removing/archiving the file in the delete path; registering the pending-delete.

### Complex / Risky
- **Kept-subtask coherence:** on keep-subtasks delete, files carrying `**Epic:** <deletedId>` must
  be neutralized (sentinel/strip) or they re-link to a dead epic — this is the model-C interaction
  and the reason this subtask pairs with `epic-membership-carrier-bidirectional-sync.md`.
- **Worktree cleanup already handled** (`_cleanupEpicWorktrees`, `:8999`); don't regress it.
- **Multi-branch:** a delete on one branch doesn't delete the file on another — the ledger/tombstone
  is what prevents the other branch's file from resurrecting it on merge/clone (same lesson as the
  manifest).

## Edge-Case & Dependency Audit

- **Depends on:** the foundation + the ledger. Pairs with the epic-membership carrier.
- **`promoteToEpic`/demote** move files between plans/ and epics/ — ensure delete/resurrect logic
  keys on plan_id + fingerprint, not path alone.
- **Migration:** if choosing A, existing already-"deleted"-but-present files on install bases will
  finally be reaped on the first post-upgrade delete or via an opt-in cleanup; don't mass-delete
  silently.
