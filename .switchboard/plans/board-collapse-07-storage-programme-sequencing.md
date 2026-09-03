# Board Collapse 07 — Sequence the Storage Programme and Park What It Blocks

## Goal

Turn about 35 storage cards spread over ten features into one ordered programme, park the eight features that cannot start until its first step lands, and merge four competing backup-and-restore designs into two.

### Problem analysis

Storage is the largest cluster on the board. Ten features and several loose plans form a single chain of hard prerequisites that no one file states end to end, so cards that cannot possibly be coded yet sit in Planned looking dispatchable. The chain is: a real SQLite binding under a single sidecar owner, then workspace-scoped tables, then verified backups, then one global database, then the storage topology, then the shared/runtime tier split, then the shared stores.

Four separate cards each describe themselves as the way a lost `kanban.db` comes back: the overhaul's backup service, a loose "backups that can actually be restored" plan, the export/import of the v1 state file, and the tracker-side board-sync restore. None names the others.

The programme also gained a new member under decision 12: *Global settings are a JSON file two boards can both write* waits on the real binding, because sql.js persists the whole image per process and two writers lose each other's updates whatever the file format.

## Execution rules

1. Card operations go through the board or `.agents/skills/kanban_operations/*.js`. **Never SQL.**
2. Rescoping preserves the plan id and filename.
3. **No git working-tree operation** while this runs. Commits are fine.
4. Moving a card to Backlog is a column move, not a delete. Nothing here is deleted except by merge.
5. Do not touch `src/`.

## Metadata

- **Complexity:** 4
- **Tags:** board-hygiene, storage, sequencing

## Proposed Changes

### 1. State the order once

Write the chain into the *Storage layer overhaul* feature file as the programme's single ordering statement, and cross-reference it from *Storage Topology and the Shared/Runtime Schema Split* and *First Run On The Standalone Host*:

1. Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding.
2. Scope the ten unscoped tables by `workspace_id` and fix the three colliding unique constraints.
3. Durable board backups and per-project export/import.
4. Consolidate to one global database in `~/.switchboard`.
5. Storage topology: three stores, one operator choice.
6. Split the schema into shared board state and machine-local runtime.
7. Shared stores (libSQL, or the git-carried snapshot).

Steps 1 to 3 and the `is_feature` clobber fix are independently useful and stay in Planned. The clobber fix in particular ships before the engine swap.

### 2. Park what the first step blocks

Move to Backlog, each with a one-line note naming the prerequisite:

- Feature **Shared Board Stores — libSQL and the Git-Carried Snapshot** (4 subtasks).
- Feature **Two Machines, One Board — the Paired App and Its Command Loop** (2 subtasks).
- Feature **Cloud-Driven Switchboard — Commands, Dispatch And Visibility** (5 subtasks).
- Loose: *The state home derives from an explicitly configured control plane*, *The bundle ledger is extension bookkeeping written into the user's repository*, *Board control instructions — a structured command payload*, and the canonical-layout subtask's dependents.

These are not cancelled. They are unreachable until step 1 lands, and leaving them in Planned invites a coder to start one.

*Global settings are a JSON file two boards can both write* moves the other way — Backlog to Planned — behind step 1 only, per decision 12.

### 3. Merge the backup designs, four into two

- **Merge** the loose *Backups that can actually be restored — a set, a verified write, and a non-destructive restore* into the overhaul's *Durable board backups and per-project export/import* subtask. The surviving plan takes the loose plan's stronger definition: a backup is a **set** (`kanban.db` plus `plans/` plus a manifest with counts, sha256 and the schema version), verified by re-opening after write and marked `*.FAILED` on mismatch, restored without unlinking the live database first, never containing `secrets.enc` or the master key. Legacy `dbbackup/` files are listed as single-artifact sets and left in place. Delete the loose card after the merge.
- **Keep** *Board state cannot survive machine loss without a third-party account* as the interim v1 export/import path, and say so in its Goal: it is the only restore available before the sidecar lands.
- **Keep** the *Board sync is a capability all three providers implement* feature. Rebuilding a board from a tracker is a different operation from restoring a database, and both are wanted.
- Add cross-references so none of the three claims to be the only restore path.

### 4. Fix the two internal contradictions

- The *Storage layer overhaul* feature file's "How the Subtasks Achieve This" still says the sidecar plan "recommends `node:sqlite`". Its subtask has a DECIDED block superseding that to `better-sqlite3`, because VS Code's bundled Node 20 lacks `node:sqlite`. Correct the feature file. (If Board Collapse 01 has already run, this is done; verify rather than repeat.)
- *Split the schema into shared board state and machine-local runtime* relocates `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, `blocked_at` and `worktrees` into a separate runtime database. Three plans outside the storage programme write or read those columns: *Status panes render an empty model* (new writer), and both Worktrees-tab subtasks. Add a cross-reference in each so whichever lands second targets the schema that exists.
- The git-carried snapshot plan adds `device_id` per entry while the sync-owner lease plan states `device_id = os.hostname()` is not unique and introduces a separate stable machine id. Record the open question in the parent feature file; both are in Backlog, so it does not need resolving now, but it must not be forgotten.

## Verification Plan

- The *Storage layer overhaul* feature file contains the seven-step order, and both sibling storage features reference it.
- Every card in the three parked features and the parked loose plans sits in `BACKLOG`, each with a prerequisite note. No parked card sits in `PLAN REVIEWED`.
- Exactly one active plan defines a backup set with verification; the interim export/import plan says it is interim; the tracker restore plan cross-references both.
- No active storage plan says `node:sqlite`.
- The three runtime-column writers cross-reference the tier split.
- `git status` shows only `.switchboard/` changes.
