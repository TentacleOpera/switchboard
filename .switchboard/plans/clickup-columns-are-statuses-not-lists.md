# ClickUp columns are lists, which destroys ClickUp's own kanban and burns the axis projects need

## Goal

Move ClickUp's column representation from **one list per column** to **one status
per column**, freeing lists to represent projects — the axis they should always
have been.

### Problem analysis

`_ensureColumnMappings` (`ClickUpSyncService.ts:475`) iterates the board's columns
and, for each, finds or **creates a ClickUp list named after that column** inside
`config.folderId`. `config.columnMappings` is typed `Record<string, string>`
(`:26`) — column name → list id. The provider seam agrees: `stateKeyToColumn`
(`remote/ClickUpRemoteProvider.ts:136`) is `return this._listIdToColumn[stateKey]`.

So this is not an inconsistency to reconcile. It is one choice, applied
uniformly, originating in `27dc6a2e "post-release enhancements"` with no design
commit behind it.

A repo-wide grep for any status→column mapping (`columnToStatus`, `statusToColumn`,
`_columnFromStatus`) returns **nothing**. ClickUp statuses — the feature built for
exactly this purpose — are never used to carry columns. They appear in this
codebase only at `:1642-1695` as `status_mappings`, which is the payload ClickUp
*requires when moving a task between lists*. Statuses exist here solely to pay the
cost of not using them as columns.

Three consequences:

1. **Every column move is a cross-list task move** — a heavy API operation with a
   status-mapping payload — where a status update is one field on one task.
2. **ClickUp's native board view is destroyed.** A list's board view groups by
   status. With one list per column, every list has one status, so every board
   view in ClickUp renders a single meaningless column. A kanban product is
   rendered unusable as kanban.
3. **The lists axis is consumed**, so board projects have nowhere natural to live.
   This is what blocks 1:1 project→list seeding.

Target model: **folder = board, list = project, status = column.**

### This is shipped state

ClickUp sync exists in released versions, so installs carry `columnMappings`
populated with list ids, and real ClickUp workspaces contain per-column lists
holding real tasks. Per the repo's migration rule this must be migrated, not
broken: import before deleting, preserve unknown keys, and never assume the
migration already ran.

## Metadata

- **Complexity:** 8
- **Tags:** integrations, clickup, board-sync, migration, breaking-change

## User Review Required

**[decision] Does the migration run automatically on upgrade, or as a visible action?**

That is the only open question. Everything else is settled by the repo's own
rules and by code that already exists:

- **The migration is cheap.** `moveTask` (`:1637`) already moves a task's home
  list through the v3 endpoint, accepts explicit `statusMappings`, preserves
  other list memberships and carries custom fields. It runs on every column move
  today. Migrating is a loop over it: for each legacy per-column list, move each
  task to the project list with `destination_status` set to the status named
  after the old list. Supplying the mapping explicitly avoids the
  "status does not exist in the target list — task was set to <first>" fallback
  at `:1687`, which would otherwise silently park every task in one column.
- **The emptied legacy lists are never deleted.** They are the user's ClickUp
  lists, not ours. They are left in place, empty, per the repo rule that legacy
  state is archived rather than unlinked.
- **There is no dual model.** Carrying list-per-column and status-per-column
  side by side permanently would leave two contradictory answers to "what is a
  column" inside a service that already can't answer it once. A compat shim is
  warranted when a migration is risky or lossy; this one is neither.

The real trade-off is only about timing. Automatic-on-upgrade matches the
precedent set for Linear's backfill, and means no user is left on the broken
model without knowing it. Against that: it moves tasks inside a person's real
ClickUp workspace without them asking, and a ClickUp workspace is shared with
people who have never heard of Switchboard.

**Recommendation: the user presses a button; nothing migrates on its own.**
Surface the prompt prominently on first connect after upgrade — stating which
lists will be emptied and where their tasks will go — rather than burying it in
settings. Prominent, not automatic.

Unlike Linear's backfill this is not a one-shot opportunity: the tasks stay in
the legacy lists indefinitely and can be migrated any time, so the constraint
that forces Linear's backfill to run unattended does not exist here. What is left
is the cost of acting unasked — this rearranges a workspace the user's colleagues
use, and they did not install Switchboard.

Whichever is chosen, the migration must be **resumable and idempotent**: a task
already in the project list with the right status is skipped, not re-moved.

## Proposed Changes

1. **One column model, with a recorded migration state.** `columnMappings`
   becomes column → status name. A config carries an explicit
   `columnModel: 'status' | 'legacy-list'` — **recorded, never inferred**. A model
   guessed from the shape of a lookup is precisely the fallback hazard this
   repo's rules exist to prevent: a config misread as `status` moves tasks into
   the wrong place, and the failure looks like a working sync.
   `legacy-list` exists only to describe a config that has not migrated yet. It
   is a transitional state, not a supported second model.
2. **Column moves become a single status update.** The cross-list move stops
   being how a column change is expressed.
3. **`moveTask` (`:1637`) stays** — it is how the migration itself moves tasks,
   and it remains correct for a genuine list-to-list move. What is removed is its
   role as the column mechanism.
4. **`stateKeyToColumn` returns `{ value, source }`**, so a column derived from a
   status and one derived from a legacy list id are never indistinguishable at a
   call site or in a log. Log the source where it is used.
5. **Project list creation is separate from column setup.** The seed's
   destination list must not be created through `_ensureColumnMappings` (`:475`),
   whose entire job is the model being removed.
6. **The destination list carries the full status set before the first task
   lands.** A task created in a list lacking its status silently takes ClickUp's
   default and reports the wrong column back to the board.
7. **The migration.** For each legacy per-column list, move every task to the
   project list via `moveTask` with `destination_status` set explicitly to the
   status named after the old list. Resumable and idempotent: a task already in
   the project list with the correct status is skipped. The emptied lists are
   left in place, never deleted. On success, flip `columnModel` to `status`.

## Verification Plan

1. A newly connected workspace creates one list per **project**, with one status
   per board column, and no list named after a column.
2. Moving a card between columns issues a single status update — no task move,
   no `status_mappings` payload.
3. ClickUp's native board view on a seeded list shows the board's real columns.
4. An install carrying legacy `columnMappings` keeps working, unchanged, until it
   migrates: no tasks moved, no lists created or deleted, and column moves land
   in the correct place throughout.
5. Running the migration moves every task into its project list with the status
   matching its former list. No task lands on the target list's first status by
   fallback — `:1687`'s warning path is never taken.
6. Re-running the migration moves nothing and reports zero changes.
7. A migration interrupted partway resumes and completes without moving a task
   twice or losing one.
8. After migration the config reads `columnModel: 'status'`, and the emptied
   legacy lists still exist in ClickUp.
9. `stateKeyToColumn`'s source is logged where it is used; a status-derived and a
   legacy-list-derived column are never indistinguishable in a log.
