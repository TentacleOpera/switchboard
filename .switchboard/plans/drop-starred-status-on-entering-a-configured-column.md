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

## User Review Required

None.

## Complexity Audit

* **Score:** 3 / 10

### Routine

* Adding one conditional `priority_starred = 0` term to existing column-transition UPDATE statements in `KanbanDatabase`.
* Adding one per-board setting (a column select + "Never" default) to the Kanban setup menu and persisting it in `kanban.db`.
* A one-time "Clear stars in this column now" button — a single UPDATE scoped to one column.

### Complex / Risky

* **The transition seam is split across multiple UPDATE sites that null dispatch fields inconsistently.** `moveCardToColumnWithReason` (KanbanProvider) delegates to `KanbanDatabase`; the actual field-nulling (`dispatched_at = NULL, last_liveness_at = NULL, blocked_at = NULL`) lives in `updateColumnByPlanFileWithReason` (`:2601`) and `cascadeFeatureByPlanId` (`:7468`, `:7476`) — but NOT in `movePlanByPlanFile` (`:2924`/`:2927`), which sets `column_entered_at` yet leaves the dispatch fields untouched. A star clear wired only into the nulling sites fires on some move paths and not others. The implementation must enumerate every column-transition UPDATE and apply the star clear consistently, or the rule becomes path-dependent.
* **The feature-cascade path has two UPDATEs** (feature row `:7468` and subtask rows `:7476`). "Cascade with the card" requires the star clear on both, or a feature's subtasks keep stars the parent dropped.
* **Setting storage location.** Config is migrating out of `.switchboard/*.json` into `kanban.db`; a new setting must land on the destination side, not add to the JSON pile being migrated.
* **The KanbanProvider comment at `:8656`** ("priority_starred is untouched — a star follows the card") explicitly documents today's behaviour and must be updated when the rule lands, or it becomes a lie the next reader trusts.

## Edge-Case & Dependency Audit

### Race Conditions

* **Concurrent star set vs. column move.** A user starring a card in the same instant the card is dragged into the configured column: the column-transition UPDATE and `setPriorityStarred` are separate statements. Last-writer-wins is acceptable — the rule fires on *entry*, not as a lock, and verification point 7 already requires `setPriorityStarred` to work on a card sitting in the configured column.

### Security

* None. The setting is a board-local column name; no untrusted input reaches SQL beyond the existing column-name validation (`VALID_KANBAN_COLUMNS` / `SAFE_COLUMN_NAME_RE`).

### Side Effects

* **External trackers are NOT touched.** The star has no ClickUp/Linear/Notion counterpart (unlike priority, which is bidirectional). Clearing `priority_starred` locally is safe and does not propagate outward — this is the decisive reason the rule may retire the star but must NOT retire priority.
* **The 38 pre-existing stale stars** in `CODE REVIEWED` / `CODER CODED` are not silently rewritten on upgrade; the "Clear stars in this column now" button retires them on demand.

### Dependencies & Conflicts

* **`KanbanDatabase.updateColumnByPlanFileWithReason`** (`:2601`) — single-card transition; nulls dispatch fields. Star clear goes here.
* **`KanbanDatabase.cascadeFeatureByPlanId`** (`:7468` feature row, `:7476` subtask rows) — feature + subtask cascade; nulls dispatch fields. Star clear goes on BOTH UPDATEs.
* **`KanbanDatabase.movePlanByPlanFile`** (`:2924`/`:2927`) — plan-file move path; does NOT null dispatch fields today. Decision required: either add the star clear here too (for consistency) or document that this path is out of scope. See Outstanding Questions.
* **`KanbanProvider.moveCardToColumnWithReason`** (`:8565`) — the orchestration seam; the comment at `:8656` must be updated.
* **Priority-field work** (`602832e6`, `4115b513`, `d1556fd0`, `20d4a089`, `f144f810`) — compatible but MUST NOT be cleared by this rule. The setting names the star alone.

## Dependencies

None blocking. The star (`priority_starred`) and its setter (`setPriorityStarred`) already exist. The planned priority-field cards are related by topic, not by dependency — this plan adds a lifecycle to an existing flag and does not implement or block them.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the seam is not one UPDATE but several, and they null dispatch fields inconsistently — wiring the star clear into only the nulling sites makes the rule path-dependent (a card moved via `movePlanByPlanFile` keeps its star); (2) the feature cascade has two UPDATEs and "cascade with the card" fails silently if only one is patched; (3) generalising the rule to priority later would propagate a local auto-clear outward to Linear/ClickUp via bidirectional write-back — the setting must stay star-scoped. Mitigations: enumerate every column-transition UPDATE and apply the clear consistently (or explicitly scope the exclusion with a recorded decision), patch both cascade UPDATEs, update the `:8656` comment, and name the setting for the star alone.

---

## Proposed Changes

1. **Add the setting.** A per-board option in the Kanban setup menu: *"Clear star on entering column"*, a select over the board's real column names plus "Never" (the default, preserving today's behaviour). Read the board's actual columns rather than a built-in catalogue — `GET /kanban/columns` publishing the wrong set is already tracked as `d8cc4d79`.

2. **Store it in the kanban DB, not a JSON file.** Config is moving out of `.switchboard/*.json` into `kanban.db` (`sess_178`, and `e2d940d3` on global settings being a file two boards can both write). A new setting should land on the destination side of that move, not add to the pile being migrated.

3. **Clear at the existing transition seam.** `moveCardToColumnWithReason` already nulls `dispatched_at`, `last_liveness_at` and `blocked_at` on a column change. Add `priority_starred = 0` to that same UPDATE when the destination column matches the configured one. No new sweep, no new timer — the transition is already observed.

> **Superseded:** "Clear at the existing transition seam … `moveCardToColumnWithReason` already nulls `dispatched_at`, `last_liveness_at` and `blocked_at` … Add `priority_starred = 0` to that same UPDATE."
> **Reason:** `moveCardToColumnWithReason` (KanbanProvider) does not perform the UPDATE — it delegates to `KanbanDatabase`. The field-nulling lives in **two** DB methods (`updateColumnByPlanFileWithReason` `:2601` and `cascadeFeatureByPlanId` `:7468`/`:7476`), and a third transition path (`movePlanByPlanFile` `:2924`/`:2927`) sets `column_entered_at` but does NOT null the dispatch fields at all. Wiring the star clear into "that same UPDATE" as written would patch only the nulling sites and leave `movePlanByPlanFile` inconsistent.
> **Replaced with:** Add the conditional `priority_starred = 0` to **every** column-transition UPDATE in `KanbanDatabase` that sets `column_entered_at` — specifically `updateColumnByPlanFileWithReason` (`:2601`), `cascadeFeatureByPlanId` (feature row `:7468` AND subtask row `:7476`), and `movePlanByPlanFile` (`:2924`/`:2927`) — gated on `newColumn = <configured column>`. The condition is evaluated in TS before the SQL is built (the configured column is read once per move), so each UPDATE gains a `priority_starred = 0` term only when the target matches. Update the KanbanProvider comment at `:8656` to reflect that the star now retires on entry to the configured column.

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
8. A card moved via `movePlanByPlanFile` into the configured column also drops its star (the rule is not path-dependent).

### Goal Invariants

- **Negative (absent):** with the setting on `CODE REVIEWED`, a card that arrives in `CODE REVIEWED` carries `priority_starred = 0` — `SELECT count(*) FROM plans WHERE kanban_column = 'CODE REVIEWED' AND priority_starred = 1` (after a fresh entry, before any manual re-star) is 0.
- **Positive (resolvable):** with the setting at "Never", a starred card keeps `priority_starred = 1` across every column transition (today's behaviour, unchanged).
- **Cascade:** a feature moved into the configured column has `priority_starred = 0` on the feature row AND on every cascaded subtask row.
- **Scope:** the setting clears `priority_starred` only — `priority` (the graded field) is never written by this rule on any path.

## Outstanding Questions

- **[user]** Should `movePlanByPlanFile` (`:2924`/`:2927`) — the plan-file move path that does not null dispatch fields today — also clear the star on entry to the configured column, or is it out of scope? — proceeding on the assumption that it SHOULD clear, for consistency (a card moved by any path into the configured column should drop its star); the assumption is reversible by removing one term.
