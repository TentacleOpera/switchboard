# ClickUp has every primitive to be seeded from the board and no pass that does it

## Goal

Give ClickUp the same project-scoped bulk seed Linear gets: selected board
projects push their active tasks to a ClickUp list that maps 1:1, creating the
list on first run and attaching to it on every run after.

### Problem analysis

ClickUp's create path is as event-driven as Linear's. `ClickUpSyncService.syncPlan`
(`:2820`) is reached from the provider (`remote/ClickUpRemoteProvider.ts:202`) and
from two internal callers (`:3111`, `:3135`), plus the feature path (`:3545`).
Nothing enumerates the board. A connected ClickUp workspace shows only cards that
move after connection — the same dead mirror Linear presents.

ClickUp is otherwise the *best* positioned of the three providers: it already
persists the plan identity anchor three ways — a `switchboard:{planId}` tag
(`:2976`), a description footer (`:2980`), an optional custom field (`:2986`) —
and already resolves tasks by it in `_findTaskByPlanId()` (`:2935`) with
`include_closed=true`. The seed needs no new identity work here, unlike Linear.

**The blocker is the column model, not the seed.** `_ensureColumnMappings`
(`:475`) makes one list per column, so lists are already spoken for. A project
cannot own a list while every column owns one. That is the subject of
*"ClickUp columns are statuses, not lists"*, which this plan depends on: seeding
projects into lists under the legacy model would put a project's cards into a
list whose name is a column, which is incoherent.

## Metadata

- **Complexity:** 5
- **Tags:** integrations, clickup, board-sync, seed

## Dependencies

Depends on **ClickUp columns are statuses, not lists** for the list axis, and on
the mapping table introduced by **A Linear key buys you nothing until the board is
seeded** — the `(workspace_id, provider, board_project)` binding is shared across
providers and must not be duplicated per provider.

## Proposed Changes

1. Implement the shared seed interface for ClickUp against the mapping table:
   create the list on first seed, attach on re-run, record `created` vs `attached`.
2. Select `status = 'active'` plans for the chosen board project. Archived,
   completed, missing and deleted plans are never seeded.
3. Skip plans already carrying a `clickup_task_id`; for the rest, resolve through
   `_findTaskByPlanId()` **before** creating, so a task that exists remotely but
   lost its local id is attached rather than duplicated. This is the one place
   ClickUp can do better than Linear, and it should.
4. Persist `clickup_task_id` per task as it is created, never batched, so an
   interrupted seed resumes.
5. Ensure the destination list carries the full status set before the first task
   lands — a task created in a list lacking its status silently takes ClickUp's
   default and reports the wrong column back to the board.
6. Bounded concurrency with ClickUp's rate-limit backoff and the same
   `{ done, total, skipped }` progress shape Linear's seed emits, so one UI drives
   both.

## Verification Plan

1. Seeding a board project creates one ClickUp list and one task per active plan.
2. Re-seeding creates zero tasks and zero lists.
3. A plan whose task exists remotely but whose `clickup_task_id` was lost is
   re-attached by `_findTaskByPlanId()`, not duplicated.
4. Archived and completed plans produce no tasks.
5. An interrupted seed resumes without duplicates.
6. Every seeded task reports its correct column back through `stateKeyToColumn`.
