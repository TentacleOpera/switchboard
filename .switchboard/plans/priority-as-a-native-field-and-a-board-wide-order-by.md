# Priority is a native card field, and the board gets one "order by" control that decides what actually runs

## Goal

Give every card a priority — not only cards imported from a tracker — and give the board a single **order by** control (manual · priority · date · complexity, star always first) that determines execution order rather than just the view. Linear and ClickUp both map onto the field without translation.

### Problem Analysis

**`plans` has no priority column.** `TeamQueueService` has a `priority` integer read from queue-item frontmatter and sorted descending (`:172-174`), but that orders *queue items*, not cards, and the board itself has nothing. `card-priority-star-and-manual-column-order.md` confirms it: *"no priority flag exists anywhere on `plans`."*

**Both trackers offer the same shape, which makes the field cheap.** Linear: 1 Urgent, 2 High, 3 Medium, 4 Low, 0 = No Priority — fixed, non-customisable. ClickUp: 1 Urgent, 2 High, 3 Normal, 4 Low, blank = No Priority — also fixed, also non-customisable, and toggleable per Space via ClickApps. Four levels plus an unset state in both, differing only in one label (Medium/Normal) and in how "none" is represented. So a single `1–4` field with null for unset maps to both with no per-provider scale conversion, and 1 = most urgent in both, so there is no inversion to get wrong.

**An import-only field would be worse than no field.** If priority arrives only on tracker-linked cards, most of the board shows nothing, the badge appears for reasons the board does not explain, and a plan authored locally cannot be marked urgent at all. The field has to be native and settable on any card, with import as one way it gets populated rather than the only one.

**And write-back needs no guard, because the guard would be incoherent.** An earlier draft proposed apply-if-empty so Switchboard never overwrites a human's priority. But the tickets panel already lets a developer change remote priority directly — `replace-ticket-card-status-dot-with-changeable-priority-dot.md` and `feature_plan_20260716_sort_tickets_by_priority_in_status_groups.md` are about exactly that. Guarding the kanban route while the panel route is open protects nothing and creates two rules for one field. Bidirectional, last-write-wins, same as the panel.

The control that matters is instead an agent one: **agents do not set priority unless instructed to.** That is prompt-level and therefore advisory, the same class as the `GIT POLICY` line — and here it is proportionate, because the consequence is a wrong flag on a ticket: visible, and one click to undo. Recorded as a deliberate choice so it is not later "fixed" with a mechanism that does not earn its cost.

**Settled: which queue obeys the board, and which does not.** A team queue item is a work order file in `.switchboard/teams/<groupId>/queue/` with `kind: plan | prompt | card` — not a card. So board precedence and queue priority order different things at different stages, and the rule that reconciles them turns on **who created the entry**:

> **Automatic queuing respects board order and the star. User-defined missions in Mission Control do not.**

The reasoning is the same one already settled for STAGING in `card-priority-star-and-manual-column-order.md`, where a star must yield to a stream's dependency order: **a hand-built sequence is a more specific expression of intent than a flag**, so the system must not reorder it. This generalises that from STAGING to every operator-authored mission.

It also explains why `QueueItem.priority` should stay rather than be unified away. Missions sit outside the automatic discipline and may use it freely; the automatic path leaves it at 0 and relies on FIFO by `enqueued_ts` to preserve the order the resolver already decided. That is what happens today by accident of everything being 0 — the rule makes it deliberate.

**But the rule is not enforceable without provenance on the item.** `QueueItem` records `kind`, not origin, so once both are files in one directory an auto-enqueued item and a mission item are indistinguishable. That has a diagnostic cost precisely where the star plan says diagnosis is hardest: an item running out of star order is either a mission behaving correctly or a bug in automatic enqueue, and nothing on the item says which. An `origin: auto | mission` field set at enqueue turns the rule from a convention into something a test can assert.

**One consequence to state rather than let someone discover.** A mission item at priority 5 and an auto-enqueued starred card at priority 0 in the same team queue: the mission runs first. That is correct — the operator sequenced it deliberately — but it is the case where someone asks "why didn't my star win", and the answer should be written down.

**The sort control has one real trap, and it is the star plan's own thesis.** That plan exists because "the board shows one order and the system acts on another, and nothing reports the discrepancy." A sort toggle that reorders the *display* while consumers keep reading something else recreates precisely that defect, in a new place, with the same invisibility. So the control cannot be a view filter — it has to be the thing execution order is read from, which makes **manual** one of its modes rather than a separate concept.

### Root Cause

Ordering inputs were added where each was needed — `queue_position` for the staging queue, a frontmatter integer for team queues — so no field ever described a card's importance, and every consumer that wanted one invented a fallback. Priority is the descriptor that was missing, and it is a different kind of thing from both the star and the sequence.

### Non-goals

- Changing the star. It stays single-level, local, and overriding, per `card-priority-star-and-manual-column-order.md`.
- Feeding `TeamQueueService`'s frontmatter integer from this field. Different entity, different sort direction; conflating them is how an inversion bug arrives. The queue's integer stays, scoped to user-defined missions per the rule above.
- Ranked stars, or priority tiers that act like stars. Priority describes; the star directs.
- Custom priority levels. Both trackers fix theirs; matching them keeps the mapping free.

## Metadata

**Complexity:** 5
**Tags:** feature, frontend, backend, database, api, ux

## User Review Required

Yes — three decisions.

1. **Where does the field live?** Recommendation: a nullable `priority INTEGER` on `plans`, shared tier (`split-shared-board-state-from-machine-local-runtime.md`) so it travels with the board. **Null and 0 are different:** null means never triaged anywhere, 0 means a tracker recorded "No Priority". Collapsing them makes the badge meaningless on local cards.
2. **Is complexity a first-class sort mode?** Recommendation: yes, with the label reflecting that it is agent-estimated — it is a rough grouping for "clear the small ones", not a ranking. Cheap to add once the control exists.
3. **Is the control global or per-column?** Recommendation: **global**, since it answers "how is this board ordered". Manual order remains per-column, so selecting *manual* means each column uses its own arrangement.

## Complexity Audit

### Routine

- The nullable column, the card badge, and the tracker mapping both ways.
- A four-state control at the top of the board.

### Complex / Risky

- **The control must feed the single precedence resolver, not sit beside it.** `card-priority-star-and-manual-column-order.md` is explicit: *"Precedence has to live in one resolver, not in each consumer… the first symptom is two surfaces disagreeing about which card is next, which is very hard to diagnose from the board."* This adds a *mode* to that resolver — starred first, then the selected ordering, then age as a stable tiebreak. It must not become a fourth independent input.
- **Switching modes changes what runs, and that must be obvious.** Selecting "priority" reorders execution for every consumer at once. The control needs to read as consequential rather than as a view preference, or an operator will flip it to look at something and change what dispatches next.
- **The star's dependency rule still governs.** That plan states a star overriding a stream dependency is *"a correctness bug, not a preference"*. A sort mode is no different: ordering by priority must not float a card ahead of an incomplete predecessor in STAGING. The resolver's existing yield-or-refuse behaviour has to cover sort modes too, not just stars.
- **Per-consumer in-progress filters must be confirmed first.** Same warning as the star plan: *"a consumer that leaned on age as its only protection against grabbing in-flight work would start doing so the moment the sort became user intent."* Every consumer needs its `!dispatchedAt` test verified before its sort changes — changing the sort first is a window in which automation picks up work already underway.
- **ClickUp priorities are toggleable per Space.** A workspace with the ClickApp disabled has no priority field at all, so import must treat absent-because-disabled as unset rather than as an error or a zero.

## Edge-Case & Dependency Audit

**Race conditions**
- Priority changed in the tracker and locally between polls: last-write-wins, and the receipt or activity log should record which side won so a surprise is diagnosable.
- Mode switched mid-dispatch: the resolver's result changes for the *next* pick, never for work already in flight.

**Security**
- Anyone who can edit a tracker issue can change a card's priority, and with a priority sort active that changes what runs next. That is a real authority transfer, and it is the reason the star stays local and overriding: the operator retains a mechanism the tracker cannot touch.

**Side effects**
- The badge appears on every card once the field exists, so the empty state matters more than the populated one — a board of blank badges is noise.
- `sort_tickets_by_priority_in_status_groups` already sorts tickets by priority in the tickets panel; the two surfaces should agree on direction and on how unset sorts.
- `TeamQueueService` keeps its own integer, now scoped by the automatic-versus-mission rule. Note the API already exposes it: `POST /terminals/teams/<groupId>/queue` accepts a caller-supplied `priority` (`LocalApiServer.ts:4045`, defaulting to 0). Nothing in-tree passes a non-zero value today, so ordering is currently consistent — the inconsistency is latent, and arrives the first time any caller uses a parameter that is already there.

**Migration**
- Additive nullable column; existing cards read as unset and render no badge. Default mode is **manual**, so no install's ordering changes on upgrade.

## Dependencies

- **Extends** `card-priority-star-and-manual-column-order.md` — same resolver, one more mode. Should land with or after it, never before.
- **Shared tier** per `split-shared-board-state-from-machine-local-runtime.md`.
- **Maps from** Linear and ClickUp; see `tracker-labels-select-from-switchboard-registries.md` for the label side.

## Adversarial Synthesis

Key risks: a sort control that changes the display but not what runs recreates the exact discrepancy the star plan exists to fix; adding a mode as a fourth input rather than into the single resolver produces two surfaces disagreeing about the next card; a priority sort can float a card ahead of an incomplete STAGING predecessor, which the star plan classes as a correctness bug; consumers relying on age as an accidental in-progress guard break the moment sort becomes intent; and collapsing null with 0 makes the badge meaningless on local cards. Mitigations: the control feeds the one resolver and is the execution order; the yield-or-refuse dependency rule covers sort modes; every consumer's `!dispatchedAt` filter is confirmed before its sort changes; and null stays distinct from 0.

## Proposed Changes

1. **A nullable `priority` (1–4) on `plans`**, shared tier, settable on any card from the board, null ≠ 0.
2. **Tracker mapping both ways**, bidirectional last-write-wins, no apply-if-empty guard, absent-because-disabled treated as unset.
3. **An `Order by` control** — manual · priority · date · complexity — global, default manual, feeding the single precedence resolver as a mode.
4. **Star remains first** in all modes, subject to the existing dependency yield-or-refuse rule, which now covers sort modes too.
5. **Confirm each consumer's in-progress filter** before changing its sort.
6. **A card badge** that renders nothing when unset.
7. **An agent instruction** that priority is not to be set without explicit direction — advisory by design, recorded as a deliberate proportionality call.
8. **An `origin: auto | mission` field on queue items**, set at enqueue, so the automatic-respects-board-order rule is assertable rather than conventional and an out-of-order item is diagnosable.
9. **Automatic enqueue derives its order from the resolver** and leaves `priority` at 0; mission enqueue may set it. Both paths documented so the difference is intentional rather than emergent.

### Migration

Additive and inert: default mode is manual, unset priority renders nothing, and no install's execution order changes on upgrade.

## Verification Plan

- **Native, not import-only:** set priority on a locally authored plan with no tracker link. Assert it persists, renders and sorts.
- **Both trackers:** import from Linear and ClickUp; assert all four levels plus unset map correctly, and that a ClickUp Space with priorities disabled yields unset rather than an error or 0.
- **Null ≠ 0:** assert a never-triaged local card renders no badge while a tracker card at No Priority renders its own state, and that the two sort distinguishably.
- **Write-back:** change priority on the board; assert the linked issue updates with no guard, and that the tickets panel and the board agree afterwards.
- **The control is execution order, not a view:** select "priority", then assert the next card *dispatched* is the one the board shows first — the test that this is not the discrepancy the star plan exists to fix.
- **One resolver:** assert every consumer picks the same next card under each mode; specifically assert no consumer has its own ordering.
- **Star precedence:** in every mode, a starred card comes first. In STAGING, a starred or priority-floated card does not precede an incomplete predecessor — it yields or is refused with a reason.
- **In-progress safety:** with a dispatched card that would sort first under each mode, assert no consumer picks it up.
- **Upgrade inertia:** upgrade an install; assert mode is manual and dispatch order is unchanged.
- **Automatic queuing respects the board:** with a starred card and several unstarred ones, trigger automatic enqueue for a team. Assert items arrive in resolver order, all at priority 0, each carrying `origin: auto`.
- **Missions do not:** build a mission in Mission Control in a deliberately non-board order. Assert it runs in the operator's order, that a star does not reorder it, and that its items carry `origin: mission`.
- **The mixed case:** a mission item at priority 5 and an auto-enqueued starred card at 0 in one team queue. Assert the mission runs first, matching the documented rule rather than the star — the case someone will otherwise report as a bug.

## Outstanding Questions

- Should the mode be per-project rather than global, given a project filter already exists?
- Does unset sort last in every mode, or adjacent to Low? Linear treats 0 as untriaged rather than lowest, and the two readings differ for the majority of cards.
- Is a priority sort even wanted in STAGING, where streams already sequence work, or should the control be inert there?
