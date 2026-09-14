# Dedup Imports From the Local Link, Not a Tag Written Into the User's Tracker

## Goal

Switchboard stops writing `switchboard` / `switchboard:<planId>` into Linear and ClickUp. Import
dedup is answered from the board's own record of what it has already linked — `linear_issue_id` and
`clickup_task_id` — which is state Switchboard owns, cannot have edited out from under it, and
already stores.

### Problem analysis

**Switchboard writes into the user's tracker to answer a question it can answer locally.** Every
issue it creates gets tagged, and on import those tags are read back to decide "have I seen this?".
The board already holds that answer:

```
KanbanDatabase.ts:4101   UPDATE plans SET linear_issue_id  = ? …   ← written on link
KanbanDatabase.ts:4134   UPDATE plans SET clickup_task_id  = ? …   ← written on link
KanbanDatabase.ts:6474   … AND linear_issue_id = ?                 ← already queryable
KanbanDatabase.ts:6451   … AND clickup_task_id = ?                 ← already queryable
```

**Operator statement, 2026-09-14:** *"i just don't know why we can't record imported cards in a db and
just use that as dedupe list"*, and on the tags themselves — *"i don't want to get crazy with tags no
one will remember how to use"*, *"they won't work well with team tags"*.

**A tag in someone else's system is the weakest possible key.** A user can rename it, a bulk edit can
strip it, a tracker admin tidying the tag list can delete it — and any of those silently breaks
dedup, producing duplicate cards with no error. It also competes with the workspace's own label
taxonomy, which is the operator's stated objection.

**What each provider actually does today.**

- **Linear.** `LinearSyncService.ts:3369` is `.filter(n => n !== 'switchboard')` — it strips the label
  out of the displayed tags string and nothing else. It carries no identity and gates no import. The
  label is a visual marker for humans. Deleting it costs nothing functional.
- **ClickUp.** The tag does two jobs. It is a **fallback carrier of the planId** when the custom field
  is empty (`ClickUpSyncService.ts:~3205-3214`), and it is a **skip** (`:3240`). The dedup chain runs:
  planId custom field → planId parsed from the tag → `_pendingCreateSessions` → title fallback →
  tag skip.

**And the custom field is not configured in practice.** Operator: *"no one will set custom field id on
clickup."* So on ClickUp the tag is not the third of three layers it appears to be in code order — it
is the only planId carrier there is. That is why it cannot simply be deleted without a replacement,
and why it must not be renamed either (see `one-name-end-to-end…`, which records that hazard).

**The replacement is a lookup, not a new mechanism.** "Does a plan already carry this issue/task id?"
is one indexed query against a column already written at link time. It needs no external write, no
custom field, and no cooperation from the tracker.

### Root cause

Dedup was implemented against the tracker because the tracker is where the issues are, and a tag was
the cheapest thing to write there. The board's own link columns predate and outlive that choice, but
nothing revisited it — so Switchboard asks a remote system a question about its own state, and pays
for the answer by polluting a namespace the user owns.

### Non-goals

- **Making the ClickUp planId custom field mandatory.** The operator's position is that nobody will
  set it; this plan removes the dependency rather than trying to enforce it.
- **Removing `_pendingCreateSessions`.** It covers the create race and is still required — see
  Change 3.
- **Retroactively deleting tags already written into a user's tracker.** Switchboard stops writing
  new ones; existing ones become inert. Reaching into a user's workspace to delete labels is exactly
  the overreach this plan is removing.
- **The `lc:`/`sb:` inbound switch vocabulary.** Separately retired — see
  `tracker-labels-select-from-switchboard-registries.md`.

## Metadata

**Tags:** trackers, linear, clickup, sync, cleanup, standalone, extension
**Complexity:** 5

## User Review Required

**Should the readers keep accepting the old tag during a transition?** Asserted default: **yes, read
but never write.** Local-link dedup is primary; the `switchboard:<planId>` parse stays as a read-only
fallback for tasks created before this lands whose link column was never populated — an install that
synced, lost its database, and restored from a board backup. Dropping the reader entirely is simpler
and risks duplicating exactly those tasks. The reader costs one `some()` over tags already in hand.

## Proposed Changes

### 1. Dedup from the local link

On import, before anything else: if a plan already carries this `linear_issue_id` / `clickup_task_id`,
skip. One indexed lookup, against state written at link time.

### 2. Stop writing the tags

Remove `_ensureSwitchboardLabel` and its application on Linear, and the `switchboard:<planId>` tag
write on ClickUp. Remove the Linear display filter at `:3369` with them — with no label written there
is nothing to strip, and leaving the filter would quietly hide a user's own label named
`switchboard`.

### 3. Keep the create-race guard

`_pendingCreateSessions` and the title fallback stay exactly as they are. They cover the window where
the task exists in the tracker but its id has not yet been written to the plan — which no local
lookup can answer, because the local record does not exist yet.

### 4. Keep the old tag as a read-only fallback

Per the review question above: parse `switchboard:<planId>` if present and the link column is empty.
Never write it. This is the migration, and it is read-side only.

### 5. Host scope

The sync services and `KanbanDatabase` are shared by both composition roots, so this lands once. Per
`CLAUDE.md` (2026-09-14) the extension host is being removed in a hard cutover — add no
extension-specific wiring.

## Verification Plan

### Automated Tests

- **Contract** — a task already linked by `clickup_task_id` is skipped on import with **no tag
  present** on the task. This is the behaviour that does not exist today.
- **Contract** — same for Linear by `linear_issue_id`.
- **Contract** — no import or sync path writes a `switchboard` label or `switchboard:` tag. Assert on
  the outbound payloads, not on a mock's call count.
- **Contract** — the create race: a task created in-session, id not yet on the plan, is still skipped
  via `_pendingCreateSessions`.
- **Contract (migration)** — a task carrying `switchboard:<planId>` whose plan has an empty link
  column is skipped via the read-only fallback, and no tag is written back.
- **Contract** — a user's own label literally named `switchboard` is displayed in the tags line rather
  than silently stripped.

Run `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. Switchboard never writes a label or tag into a user's tracker.
2. Dedup is answered entirely from local state for anything linked after this lands.
3. Nothing a user does to their tracker's labels can cause duplicate imports.
4. The ClickUp planId custom field is no longer required for dedup to work.
