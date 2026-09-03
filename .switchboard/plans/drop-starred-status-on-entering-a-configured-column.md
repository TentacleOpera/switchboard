# A star is a sprint designation with no end — 37 of 51 have decayed into CODE REVIEWED

## Goal

Add a per-board setting in the Kanban setup menu naming a column on whose entry `priority_starred` is cleared, so the starred set stays the short, reportable list it exists to be.

### Problem Analysis

The star is an impromptu sprint designation: work to get through ahead of other work. It overrides the low→urgent priority scheme (planned, not built) and is deliberately simpler than it — one bit, set by hand.

Its value is **reporting**. The backlog is ~150 cards, which cannot be presented in a controller chat. The starred set can: a handful per column. "What are my starred cards?" is answerable; "what is in my backlog?" is not. The star is the primary surface a controller agent uses to summarise the board.

**Nothing retires it.** `priority_starred` is set manually and cleared manually. Measured on this board:

| Column | Starred |
| :-- | --: |
| `CODE REVIEWED` | **37** |
| `PLAN REVIEWED` | 10 |
| `CREATED` | 3 |
| `CODER CODED` | 1 |
| **total** | **51** |

Two thirds sit in `CODE REVIEWED` — work that has already been planned, coded and reviewed. Those stars have done their job and nothing took them down. The live sprint is the 13 in `CREATED` and `PLAN REVIEWED`; the other 38 are noise that any consumer must now filter out by column.

Left alone this only worsens: every card that is ever starred stays starred forever, so the set converges on "everything that was ever a priority" — which is a second backlog, and unusable for the one question the star exists to answer.

**Why manual unstarring is not the answer.** It puts an upkeep obligation on the operator at exactly the moment attention has moved on — the card is finished, and going back to clear a flag is the least likely action to happen. The flag should retire itself at a transition the system already observes.

### Root Cause

`priority_starred` has no lifecycle. It is a bit with a setter (`setPriorityStarred`) and no clearing rule, on a board where every other piece of dispatch state (`dispatched_at`, `last_liveness_at`, `blocked_at`) is already nulled on column transition by `moveCardToColumnWithReason`. The star was simply never added to that list, and unlike those fields it has no timeout sweep behind it either.

## Metadata

**Complexity:** 3
**Tags:** kanban, ui, settings, backend
**Project:** Browser Switchboard

## Proposed Changes

1. **Add the setting.** A per-board option in the Kanban setup menu: *"Clear star on entering column"*, a select over the board's real column names plus "Never" (the default, preserving today's behaviour). Read the board's actual columns rather than a built-in catalogue — `GET /kanban/columns` publishing the wrong set is already tracked as `d8cc4d79`.

2. **Store it in the kanban DB, not a JSON file.** Config is moving out of `.switchboard/*.json` into `kanban.db` (`sess_178`, and `e2d940d3` on global settings being a file two boards can both write). A new setting should land on the destination side of that move, not add to the pile being migrated.

3. **Clear at the existing transition seam.** `moveCardToColumnWithReason` already nulls `dispatched_at`, `last_liveness_at` and `blocked_at` on a column change. Add `priority_starred = 0` to that same UPDATE when the destination column matches the configured one. No new sweep, no new timer — the transition is already observed.

4. **Cascade with the card, not past it.** A feature moving its subtasks cascades column changes; the star clear must ride the same path so a feature's subtasks do not keep stars their parent has dropped.

5. **Offer a one-time cleanup.** The existing 38 stale stars in `CODE REVIEWED` / `CODER CODED` predate the setting. A button beside it — *"Clear stars in this column now"* — retires them without a migration that silently rewrites rows on upgrade.

### Relationship to the priority-field work

The low→urgent priority scheme is already planned across several cards, four of them in `PLAN REVIEWED`: `602832e6` (priority as a native card field with a board-wide order-by), `4115b513` (priority shown everywhere a card is shown), `d1556fd0` (agents set a card's priority and can tell whether it changed), and `20d4a089` (the star applies optimistically). `f144f810` — the agent-reachable starring endpoint this plan's `setPriorityStarred` calls — is in `CODE REVIEWED`.

This plan does not implement, block, or presuppose any of that. It adds a lifecycle rule to a flag that already exists and already has a setter. The two are compatible: a star is a single-bit sprint marker with no ordering semantics, and a priority level is a graded field with them.

**Priority must NOT be cleared by this rule.** The setting applies to `priority_starred` and to nothing else. Two reasons, and the second is decisive:

1. **They are different kinds of thing.** `602832e6` puts it exactly: *"Priority describes; the star directs."* A star is a single-bit sprint marker with no ordering semantics — in the planned order-by control the star is **always first**, and priority is one of the sortable modes. Retiring a direction is coherent; silently rewriting a description is not.
2. **Priority write-back is bidirectional and last-write-wins.** `602832e6` settles this deliberately: there is no apply-if-empty guard, because the tickets panel already writes remote priority directly and two rules for one field protect nothing. So a local auto-clear would **propagate outward to Linear or ClickUp** — a column move on this board would silently change a field on the tracker. The star has no tracker counterpart, which is precisely why it is safe to retire locally.

Note that priority is native and settable on any card, tracker or not — import is one way it gets populated, not the only one. So "the tracker owns it" is *not* the reason to leave it alone; the reason is that it describes the work rather than sequencing it.

Name the setting for the star alone and do not generalise it to priority later.

## Verification Plan

1. With the setting at "Never", a card keeps its star across every column transition — today's behaviour, unchanged.
2. With the setting on `CODE REVIEWED`, starring a card in `CREATED` and dispatching it through to `CODE REVIEWED` leaves `priority_starred = 0` on arrival.
3. A card moved *backwards* out of the configured column does not regain its star.
4. A feature moved into the configured column drops the star on the feature **and** its cascaded subtasks.
5. The column select lists this board's real columns, not the built-in catalogue.
6. "Clear stars in this column now" clears exactly that column's stars and nothing else.
7. `setPriorityStarred` still works normally on a card sitting in the configured column — the rule fires on entry, not as a lock.
