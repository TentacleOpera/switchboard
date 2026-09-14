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
**Feature:** 887731e4-382d-45e8-978f-102a35e80682
**Complexity:** 5
**Repo:** switchboard

## User Review Required

**Should the readers keep accepting the old tag during a transition?** Asserted default: **yes, read
but never write.** Local-link dedup is primary; the `switchboard:<planId>` parse stays as a read-only
fallback for tasks created before this lands whose link column was never populated — an install that
synced, lost its database, and restored from a board backup. Dropping the reader entirely is simpler
and risks duplicating exactly those tasks. The reader costs one `some()` over tags already in hand.

## Complexity Audit

### Routine
- Adding a `linear_issue_id` / `clickup_task_id` lookup at the top of each provider's import filter
  loop — one indexed query against columns already written at link time
  (`KanbanDatabase.ts:4150`, `:4183`; queryable at `:6500`, `:6523`).
- Removing the Linear label write paths: `_ensureSwitchboardLabel` (`LinearSyncService.ts:2714`),
  the `labelIds` application on issue creation (`:2956`, `:3048`), and the display filter (`:3369`).
- Removing the ClickUp tag write (`ClickUpSyncService.ts:2993`) and the tag-based skip (`:3240`).
- Removing the ClickUp tag display filter (`:3304`).

### Complex / Risky
- **Linear sync map reconciliation.** Linear already has local dedup via `syncMapIssueIds`
  (`LinearSyncService.ts:3175`, applied at `:3302`), built from a separate sync map — not from
  `linear_issue_id`. The plan adds `linear_issue_id` dedup "before anything else," but the sync
  map is also "before anything else" today. The two must be reconciled: `linear_issue_id` dedup
  runs first (it is the plan's primary), the sync map stays as a secondary local dedup (harmless
  redundancy — it catches anything the link column missed), or is removed. The plan's proposed
  change does not name the sync map; the coder must decide whether to keep it, and the decision
  must be recorded in the implementation.
- **ClickUp orphan risk for new tasks.** After this lands, new ClickUp tasks have no tag (the
  only planId carrier, per the operator's "no one will set custom field id") and no custom field.
  If the `clickup_task_id` link column is later lost (database restore, plan file rename), the
  task is an orphan in ClickUp with no trace back to Switchboard. The read-only fallback
  (Change 4) only covers OLD tasks that still carry the tag. New tasks that lose their link
  column are untraceable. This is a narrow gap (database loss), and the operator prefers no
  tags — but it is a real consequence of removing the only external planId carrier, and must be
  stated rather than discovered.
- **Both composition roots.** The sync services and `KanbanDatabase` are shared, so the code
  lands once. Per `CLAUDE.md` (2026-09-14), the extension host is being removed in a hard
  cutover — add no extension-specific wiring.

## Edge-Case & Dependency Audit

### Race Conditions
- **Create race.** A task exists in the tracker but its id has not yet been written to the plan
  record. No local lookup can answer this — the local record does not exist yet.
  `_pendingCreateSessions` (ClickUp `:181`) and the title fallback cover this window and stay
  exactly as they are (Change 3). The local-link dedup runs before `_pendingCreateSessions` and
  does not replace it.
- **Override write vs. in-flight import.** An operator sets `clickup_task_id` on a plan while an
  import is mid-flight. The import's local-link lookup either sees the old (empty) value or the
  new one — never a torn read (SQLite single-writer). Acceptable.

### Security
- None. No new endpoint, no new auth surface. Removing external writes reduces the trust
  surface, not extends it.

### Side Effects
- **Linear visibility loss.** Removing the `switchboard` label means a user looking at their
  Linear board can no longer tell which issues Switchboard created. This is the operator's
  stated preference ("i don't want to get crazy with tags no one will remember how to use").
  Not a regression against the goal; a consequence of it.
- **ClickUp orphan risk.** See Complexity Audit — new tasks that lose their link column are
  untraceable in ClickUp. Old tasks retain their tags (non-goal: no retroactive deletion).

### Dependencies & Conflicts
- `one-name-end-to-end-switchboard-becomes-labcom-and-the-cli-becomes-lc.md` — records the
  hazard that the ClickUp tag must not be renamed (it is the only planId carrier). This plan
  removes the tag rather than renaming it, so the hazard is retired by elimination.
- `tracker-labels-select-from-switchboard-registries.md` — separately retires the `lc:`/`sb:`
  inbound switch vocabulary. Independent; this plan removes outbound tags, that plan removes
  inbound label selection.
- The existing `control_plane` table and the `linear_issue_id` / `clickup_task_id` columns —
  no schema change needed; the columns already exist and are written at link time.

## Dependencies

- **Retires the hazard recorded in** `one-name-end-to-end-switchboard-becomes-labcom-and-the-cli-becomes-lc.md`
  (the ClickUp tag must not be renamed) — by removing the tag rather than renaming it.
- **Adjacent to** `tracker-labels-select-from-switchboard-registries.md` (retires the `lc:`/`sb:`
  inbound vocabulary) — independent; this plan is outbound, that plan is inbound.
- Independent of the missions, automation, and worktree work.

## Adversarial Synthesis

**Risk summary.** Key risks: (1) the Linear sync map (`syncMapIssueIds`) is not reconciled with
the new `linear_issue_id` dedup — two local dedup paths with no stated ordering is a silent
redundancy or a silent conflict; (2) new ClickUp tasks have no external planId carrier after the
tag is removed, so a lost database produces untraceable orphans; (3) the read-only tag fallback
only covers pre-change tasks, so the migration is one-directional. Mitigations: state the sync
map's role explicitly (keep as secondary, or remove); acknowledge the ClickUp orphan risk as a
narrow, accepted consequence of the operator's no-tags preference; keep `_pendingCreateSessions`
intact for the create race.

## Proposed Changes

### 1. Dedup from the local link

On import, before anything else: if a plan already carries this `linear_issue_id` / `clickup_task_id`,
skip. One indexed lookup, against state written at link time.

**Linear sync map reconciliation (required decision):** Linear already has local dedup via
`syncMapIssueIds` (`LinearSyncService.ts:3175`, applied at `:3302`), built from a separate sync
map — not from `linear_issue_id`. The new `linear_issue_id` lookup runs first. The sync map
either stays as a secondary local dedup (harmless redundancy — it catches anything the link
column missed), or is removed (clean, but loses a dedup path that has been working). The coder
must decide and record the decision. If kept, state the ordering explicitly: `linear_issue_id`
first, sync map second.

### 2. Stop writing the tags

Remove `_ensureSwitchboardLabel` and its application on Linear, and the `switchboard:<planId>` tag
write on ClickUp. Remove the Linear display filter at `:3369` with them — with no label written there
is nothing to strip, and leaving the filter would quietly hide a user's own label named
`switchboard`.

**ClickUp orphan risk (stated consequence):** after this lands, new ClickUp tasks have no tag (the
only planId carrier) and no custom field (nobody configures it). If `clickup_task_id` is later
lost (database restore), the task is an orphan in ClickUp with no trace back. The read-only
fallback (Change 4) only covers old tasks. This is a narrow, accepted consequence of the
operator's no-tags preference — state it in the implementation so it is not discovered later.

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

---

## Implementation Summary

Improve-plan pass completed. Added `Repo: switchboard` to metadata. Added four missing required sections: `## Complexity Audit` (routine tag/label removal + complex sync-map reconciliation and ClickUp orphan risk), `## Edge-Case & Dependency Audit` (create race, override write race, Linear visibility loss, ClickUp orphan risk, sibling plan dependencies), `## Dependencies` (retires the `one-name-end-to-end` rename hazard, adjacent to `tracker-labels-select`), and `## Adversarial Synthesis` (sync map not reconciled, ClickUp orphan risk for new tasks, one-directional migration). Two analysis gaps surfaced and recorded: the Linear sync map (`syncMapIssueIds` at `:3302`) is not mentioned in the original plan and must be reconciled with the new `linear_issue_id` dedup; and new ClickUp tasks lose their only external planId carrier when the tag is removed, creating an orphan risk if the local database is lost. Both gaps are now stated in the Complexity Audit, Proposed Changes, and Adversarial Synthesis. No superseded conclusions — the plan's approach was validated; the gaps are additions, not corrections.
