# Priority is a native card field, and the board gets one "order by" control that decides what actually runs

## Goal

Give every card a priority — not only cards imported from a tracker — and give the board a single **order by** control (manual · priority · date · complexity, star always first) that determines execution order rather than just the view. Linear and ClickUp both map onto the field without translation.

### Problem Analysis

**`plans` has no priority column.** `TeamQueueService` has a `priority` integer read from queue-item frontmatter and sorted descending (`TeamQueueService.ts:172-174`), but that orders *queue items*, not cards, and the board itself has nothing. `card-priority-star-and-manual-column-order.md` confirms it: *"no priority flag exists anywhere on `plans`."*

**Both trackers offer the same shape, which makes the field cheap.** Linear: 1 Urgent, 2 High, 3 Normal, 4 Low, 0 = No Priority — fixed, non-customisable. ClickUp: 1 Urgent, 2 High, 3 Normal, 4 Low, blank = No Priority — also fixed, also non-customisable, and toggleable per Space via ClickApps. Four levels plus an unset state in both, differing only in one label and in how "none" is represented. So a single `1–4` field with null for unset maps to both with no per-provider scale conversion, and 1 = most urgent in both, so there is no inversion to get wrong.

> **Superseded:** Linear: 1 Urgent, 2 High, 3 Medium, 4 Low, 0 = No Priority
> **Reason:** Label drift — Linear calls level 3 "Normal", not "Medium". The codebase confirms this at `LinearSyncService.ts:2753`: `['', 'urgent', 'high', 'normal', 'low']` — index 3 is `'normal'`.
> **Replaced with:** Linear: 1 Urgent, 2 High, 3 Normal, 4 Low, 0 = No Priority.

> **Clarification — ClickUp read-path format:** The plan states "no per-provider scale conversion," which is true for the *scale* (1=urgent, 2=high, 3=normal, 4=low in both). However, ClickUp's API returns priority as an **object** (`ClickUpSyncService.ts:89`: `{ id: string; priority: string; color: string; orderindex: string } | null`), not a bare integer. The `priority` string is the label ("urgent", "high", etc.) and `orderindex` is the numeric level as a string. Import logic must extract the integer from `parseInt(orderindex)` or map the `priority` string to 1–4. The write path (`ClickUpSyncService.ts:1457`: `if (priority) body.priority = priority`) accepts a bare integer, so write-back is direct. The scale matches; the read-path *format* does not, and extraction logic is required.

**An import-only field would be worse than no field.** If priority arrives only on tracker-linked cards, most of the board shows nothing, the badge appears for reasons the board does not explain, and a plan authored locally cannot be marked urgent at all. The field has to be native and settable on any card, with import as one way it gets populated rather than the only one.

**And write-back needs no guard, because the guard would be incoherent.** An earlier draft proposed apply-if-empty so Switchboard never overwrites a human's priority. But the tickets panel already lets a developer change remote priority directly — `replace-ticket-card-status-dot-with-changeable-priority-dot.md` and `feature_plan_20260716_sort_tickets_by_priority_in_status_groups.md` are about exactly that. Guarding the kanban route while the panel route is open protects nothing and creates two rules for one field. Bidirectional, last-write-wins, same as the panel.

The control that matters is instead an agent one: **agents do not set priority unless instructed to.** That is prompt-level and therefore advisory, the same class as the `GIT POLICY` line — and here it is proportionate, because the consequence is a wrong flag on a ticket: visible, and one click to undo. Recorded as a deliberate choice so it is not later "fixed" with a mechanism that does not earn its cost.

**Settled: which queue obeys the board, and which does not.** A team queue item is a work order file in `.switchboard/teams/<groupId>/queue/` with `kind: plan | prompt | card` — not a card. So board precedence and queue priority order different things at different stages, and the rule that reconciles them turns on **who created the entry**:

> **Automatic queuing respects board order and the star. User-defined missions in Mission Control do not.**

The reasoning is the same one already settled for STAGING in `card-priority-star-and-manual-column-order.md`, where a star must yield to a stream's dependency order: **a hand-built sequence is a more specific expression of intent than a flag**, so the system must not reorder it. This generalises that from STAGING to every operator-authored mission.

It also explains why `QueueItem.priority` should stay rather than be unified away. Missions sit outside the automatic discipline and may use it freely; the automatic path leaves it at 0 and relies on FIFO by `enqueued_ts` to preserve the order the resolver already decided. That is what happens today by accident of everything being 0 — the rule makes it deliberate.

**But the rule is not enforceable without provenance on the item.** `QueueItem` records `kind`, not origin (`TeamQueueService.ts:39-49` — the interface has no `origin` field), so once both are files in one directory an auto-enqueued item and a mission item are indistinguishable. That has a diagnostic cost precisely where the star plan says diagnosis is hardest: an item running out of star order is either a mission behaving correctly or a bug in automatic enqueue, and nothing on the item says which. An `origin: auto | mission` field set at enqueue turns the rule from a convention into something a test can assert.

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

**Complexity:** 6
**Tags:** feature, frontend, backend, database, api, ux

## User Review Required

Yes — three decisions.

1. **Where does the field live?** Recommendation: a nullable `priority INTEGER` on `plans`, shared tier (`split-shared-board-state-from-machine-local-runtime.md`) so it travels with the board. **Null and 0 are different:** null means never triaged anywhere, 0 means a tracker recorded "No Priority". Collapsing them makes the badge meaningless on local cards. Note: Linear uses 0 for "No Priority" and ClickUp uses blank/null, so the import mapping must translate ClickUp's null to 0 (tracker-says-none) and leave a local card's field as null (never-triaged).
2. **Is complexity a first-class sort mode?** Recommendation: yes, with the label reflecting that it is agent-estimated — it is a rough grouping for "clear the small ones", not a ranking. Cheap to add once the control exists. **Caveat:** `KanbanPlanRecord.complexity` is a string (`'Unknown'` or `'1'`–`'10'`), not a number. The sort must `parseInt` and handle `'Unknown'` — recommendation: `'Unknown'` sorts last (after 10), so un-estimated cards don't jump to the top. This makes the mode most useful on boards where complexity has been populated, and inert (everything sorts last, stable) on boards where it hasn't — which is the honest state.
3. **Is the control global or per-column?** Recommendation: **global**, since it answers "how is this board ordered". Manual order remains per-column, so selecting *manual* means each column uses its own arrangement.

## Complexity Audit

### Routine

- The nullable column (V65), the card badge, and the tracker mapping both ways.
- A four-state control at the top of the board, stored as a `kanban.orderBy` key in the `config` table (same pattern as `kanban.activeProjectFilter` at `KanbanDatabase.ts:2349`).

### Complex / Risky

- **The control must feed the single precedence resolver, not sit beside it.** `card-priority-star-and-manual-column-order.md` is explicit: *"Precedence has to live in one resolver, not in each consumer… the first symptom is two surfaces disagreeing about which card is next, which is very hard to diagnose from the board."* The shared resolver is `compareByPrecedence` (`kanbanOrdering.ts:69`), already used by all three consumers: `_distributePlannerDispatch` (`KanbanProvider.ts:7017`), the queue pop (`LocalApiServer.ts:2065`), and the frontend display sort (`kanban.html:9030`). Adding a mode means extending `compareByPrecedence` to accept a `mode?: SortMode` parameter (default `'manual'`), and every call site must read the mode from the same `config` key (`kanban.orderBy`) and pass it through. It must not become a fourth independent input.
- **Switching modes changes what runs, and that must be obvious.** Selecting "priority" reorders execution for every consumer at once. The control needs to read as consequential rather than as a view preference, or an operator will flip it to look at something and change what dispatches next.
- **The star's dependency rule still governs.** That plan states a star overriding a stream dependency is *"a correctness bug, not a preference"*. A sort mode is no different: ordering by priority must not float a card ahead of an incomplete predecessor in STAGING. The resolver's existing yield-or-refuse behaviour has to cover sort modes too, not just stars.
- **Per-consumer in-progress filters must be confirmed first.** The star plan already fixed `_distributePlannerDispatch` — `KanbanProvider.ts:7015` now filters `!c.working` before sorting. The queue pop filters via `isQueueable` (`LocalApiServer.ts:1901`). Both paths are covered as of V63. Any new consumer added before this plan ships must be verified the same way before its sort changes.
- **ClickUp priorities are toggleable per Space.** A workspace with the ClickApp disabled has no priority field at all, so import must treat absent-because-disabled as unset (null) rather than as an error or a zero. This is external API behavior — see Uncertain Assumptions.
- **"date" mode must name its field.** The plan says "date" without specifying which. Recommendation: `column_entered_at` DESC — the board's existing display fallback (V61, `kanbanOrdering.ts:108-112`), consistent with the star plan's analysis. `created_at` would sort oldest-first, which is the age-as-proxy-for-not-in-flight that the star plan explicitly rejected as a sort key. `updated_at` is too noisy (any touch bumps it). `column_entered_at` is the last real column transition — stable, meaningful, and already the resolver's fallback.
- **"complexity" mode must parse a string.** `KanbanPlanRecord.complexity` is `'Unknown'` or `'1'`–`'10'` (a string, not a number — `KanbanDatabase.ts:64`). The sort comparator must `parseInt` and handle `'Unknown'` by sorting it last. Cards with unknown complexity cluster at the bottom, making the mode useful only on boards where complexity has been estimated — which is the honest state.

## Edge-Case & Dependency Audit

**Race conditions**
- Priority changed in the tracker and locally between polls: last-write-wins, and the receipt or activity log should record which side won so a surprise is diagnosable.
- Mode switched mid-dispatch: the resolver's result changes for the *next* pick, never for work already in flight.

**Security**
- Anyone who can edit a tracker issue can change a card's priority, and with a priority sort active that changes what runs next. That is a real authority transfer, and it is the reason the star stays local and overriding: the operator retains a mechanism the tracker cannot touch.

**Side effects**
- The badge appears on every card once the field exists, so the empty state matters more than the populated one — a board of blank badges is noise.
- `sort_tickets_by_priority_in_status_groups` already sorts tickets by priority in the tickets panel; the two surfaces should agree on direction and on how unset sorts.
- `TeamQueueService` keeps its own integer, now scoped by the automatic-versus-mission rule. Note the API already exposes it: `POST /terminals/teams/<groupId>/queue` accepts a caller-supplied `priority` (`LocalApiServer.ts:4820`, defaulting to 0). Nothing in-tree passes a non-zero value today, so ordering is currently consistent — the inconsistency is latent, and arrives the first time any caller uses a parameter that is already there.

> **Superseded:** `LocalApiServer.ts:4045` accepts a caller-supplied `priority`.
> **Reason:** Line drift — `:4045` is `_handleKanbanVerb`, which handles kanban verb dispatch, not team queue enqueue. The team queue enqueue handler is at `:4814-4820`, and the `priority` parameter extraction is at `:4820`: `priority: typeof body.priority === 'number' ? body.priority : 0`.
> **Replaced with:** `LocalApiServer.ts:4820` — the `priority` parameter in the `enqueueItem` call within the `POST /terminals/teams/<groupId>/queue` handler.

**Migration**
- Additive nullable column (V65); existing cards read as unset (null) and render no badge. Default mode is **manual**, so no install's ordering changes on upgrade. The new column must be added to `SCHEMA_TABLES_SQL` (`KanbanDatabase.ts:226-267`) for fresh DBs, `PLAN_COLUMNS` (`:1020-1026`) for reads/writes, the upsert query, and a `MIGRATION_V65_SQL` block with an idempotent `ALTER TABLE plans ADD COLUMN priority INTEGER DEFAULT NULL`, following the V63/V64 pattern (`:626-642`).

## Dependencies

- **Extends** `card-priority-star-and-manual-column-order.md` — same resolver (`kanbanOrdering.ts:69`), one more mode parameter. Should land with or after it, never before. V63 (star + column_order) is already shipped; this plan builds on it.
- **Shared tier** per `split-shared-board-state-from-machine-local-runtime.md`.
- **Maps from** Linear and ClickUp; see `tracker-labels-select-from-switchboard-registries.md` for the label side.

## Adversarial Synthesis

Key risks: the `Order by` mode must be read from one config key by all three consumers or the screen and the system disagree (the exact defect the star plan exists to fix); `compareByPrecedence` needs a `mode` parameter but the plan didn't specify the mechanism; "date" and "complexity" modes name no field and no parsing strategy; ClickUp's read path returns a priority object (not an integer) so extraction logic is required despite the matching scale; and the `origin` field on queue items is three code changes (interface, parser, writer) plus caller updates, not one. Mitigations: mode stored as `kanban.orderBy` in `config`, read by every consumer and passed to `compareByPrecedence(a, b, column, mode)`; "date" mode uses `column_entered_at` DESC; "complexity" mode parses the string with `'Unknown'` sorting last; ClickUp import extracts `parseInt(orderindex)` from the priority object; and the `origin` field is added to `QueueItem`, `parseQueueItem`, `enqueueItem`, and all enqueue call sites.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — schema, migration, and record type

**Context:** The `plans` table schema is at `:226-267`. The latest migration is V64 (`:631-642`). `PLAN_COLUMNS` is at `:1020-1026`. `KanbanPlanRecord` is at `:57-173`.

**Logic:**
- Add `priority INTEGER DEFAULT NULL` to `SCHEMA_TABLES_SQL` (after `map_fingerprint` at `:266`).
- Add `MIGRATION_V65_SQL` with `ALTER TABLE plans ADD COLUMN priority INTEGER DEFAULT NULL`, following the V64 comment format. Register in the migration runner after the V64 block (`:8746`).
- Add `priority` to `PLAN_COLUMNS` (`:1020-1026`).
- Add `priority?: number | null` to `KanbanPlanRecord` (after `mapFingerprint` at `:172`), with a doc comment: "V65: tracker-mapped priority 1–4 (1=urgent, 4=low). NULL = never triaged (local card, no tracker link). 0 = tracker explicitly recorded 'No Priority'. Distinct from `priority_starred` (binary override) — this field describes, the star directs."
- Add `setCardPriority(planId, workspaceId, priority: number | null)` — sets `priority` on a card. Analogous to `setPriorityStarred` (which the star plan added).
- Add `getOrderByMode(workspaceId): Promise<SortMode>` and `setOrderByMode(workspaceId, mode: SortMode)` — reads/writes `kanban.orderBy` from the `config` table using the existing `getConfigSync`/`setConfig` pattern (`:5616`, `:5628`). Default: `'manual'`.

**Edge Cases:**
- `priority` is NOT cleared on column moves — it is a persistent descriptor that follows the card, like `priority_starred`.
- `priority` is preserved on upsert conflict (a file re-import does not overwrite a human-set priority) — same `ON CONFLICT DO UPDATE` preservation as `priority_starred` and `column_order`.

### 2. `src/services/kanbanOrdering.ts` — resolver mode parameter

**Context:** `compareByPrecedence` is at `:69`, taking `(a: OrderableCard, b: OrderableCard, column: string)`. `OrderableCard` is at `:53-60`.

**Logic:**
- Add `priority?: number | null` to `OrderableCard` (after `priorityStarred`).
- Add `complexity?: string` to `OrderableCard` (for the complexity sort mode).
- Define `export type SortMode = 'manual' | 'priority' | 'date' | 'complexity'`.
- Extend `compareByPrecedence` signature to `compareByPrecedence(a, b, column, mode?: SortMode)`. Default `'manual'` preserves current behavior exactly.
- The star step (step 1 in the current comparator) runs first in ALL modes — starred always overrides.
- After the star, the mode selects the secondary sort key:
  - `'manual'` (default): current logic — `queue_position`/`column_order` → `column_entered_at` DESC → `createdAt` DESC.
  - `'priority'`: `priority` ASC (1=urgent first), with NULL sorting last (never-triaged after everything). Cards at the same priority fall through to the manual-order fallback, then `column_entered_at` DESC, then `createdAt` DESC. A card with priority 0 (tracker "No Priority") sorts after 1–4 but before NULL.
  - `'date'`: `column_entered_at` DESC → `createdAt` DESC. Skips the manual-order step entirely — this is "when did it last change columns."
  - `'complexity'`: `parseInt(complexity)` ASC (1 first = easiest first, the "clear the small ones" use case), with `'Unknown'` sorting last. Cards at the same complexity fall through to `column_entered_at` DESC, then `createdAt` DESC.
- The STAGING dependency yield-or-refuse rule is applied by the CALLER (the queue pop at `LocalApiServer.ts:2067-2087`), not by the comparator. The comparator produces the order; the caller filters by dependency gates. This is unchanged — the mode only affects the sort, not the gate.

**Edge Cases:**
- In STAGING, the star step is skipped (mission queue, not board — `kanbanOrdering.ts:77`). The mode still applies to the secondary sort within STAGING: `'priority'` mode sorts STAGING by card priority, `'manual'` uses `queue_position`, etc. This is consistent — the mode is global, and STAGING's `queue_position` is its manual order.
- NULL vs 0 distinction in `'priority'` mode: NULL (never triaged) sorts after 0 (tracker says none). This preserves the distinction the plan's User Review item 1 establishes.

### 3. `src/services/KanbanProvider.ts` — consumer wiring

**Context:** `_distributePlannerDispatch` sorts via `compareByPrecedence` at `:7017`. The in-progress filter (`!c.working`) is at `:7015` — already fixed by V63.

**Logic:**
- Read `orderByMode` from the kanban DB's `getOrderByMode()` and pass it to `compareByPrecedence` at `:7017`: `compareByPrecedence(a, b, sortColumn, orderByMode)`.
- Add a `setCardPriority` verb handler (analogous to `setPriorityStarred`) — validates priority is null or 1–4, calls `db.setCardPriority`, posts a refresh.
- Add an `setOrderByMode` verb handler — calls `db.setOrderByMode`, posts a refresh so the display re-sorts.

### 4. `src/services/LocalApiServer.ts` — queue pop and team queue

**Context:** The queue pop sorts via `compareByPrecedence` at `:2065`. The team queue enqueue is at `:4814-4820`.

**Logic:**
- Read `orderByMode` and pass it to `compareByPrecedence` at `:2065`: `compareByPrecedence(a, b, 'STAGING', orderByMode)`.
- The team queue enqueue handler (`:4814-4820`) gains an `origin` parameter: `origin: body.origin === 'mission' ? 'mission' : 'auto'`. This is passed through to `enqueueItem`.

### 5. `src/services/TeamQueueService.ts` — origin field

**Context:** `QueueItem` interface at `:39-49`. `parseQueueItem` at `:110-141`. `enqueueItem` at `:191-250`.

**Logic:**
- Add `origin: 'auto' | 'mission'` to `QueueItem` interface (after `priority` at `:46`).
- In `parseQueueItem` (`:110-141`): parse `origin` from frontmatter: `origin: (fm.origin as 'auto' | 'mission') || 'auto'`. Default `'auto'` for legacy items (pre-existing items were all auto-enqueued, so the default is safe).
- In `enqueueItem` (`:191-250`): add `origin?: string` to the `params` type (`:194`). Write `origin: ${flatten(origin)}` to the frontmatter lines (`:218-225`), after the `priority` line.
- In `listQueue` (`:149-182`): the sort at `:172-176` is unchanged — it sorts by `priority` desc then `enqueued_ts` asc. The `origin` field is for provenance/diagnostics, not for sort order.

**Edge Cases:**
- Legacy queue items (created before this field) have no `origin` frontmatter. `parseQueueItem` defaults to `'auto'`, which is correct — all pre-existing items were auto-enqueued (no in-tree caller passes a non-zero priority, and mission enqueue is the only path that would set `'mission'`).
- `reorderQueue` (`:293-352`) rewrites `priority` in frontmatter but must NOT touch `origin` — reordering a mission does not change its provenance.

### 6. `src/webview/kanban.html` — Order by control, badge, and display sort

**Context:** The display sort is at `:9030-9054`, using `compareByPrecedence` from `kanbanOrdering.ts`. Card HTML is generated by `createCardHtml`.

**Logic:**
- Add an `Order by` control at the top of the board — a dropdown or segmented control with four options: Manual (default), Priority, Date, Complexity. On change, posts a `setOrderByMode` message. Styled to read as consequential (not a view toggle) — e.g., a labelled dropdown, not an icon.
- The display sort at `:9030` must read the mode from the board state (sent with the board refresh) and pass it to `compareByPrecedence`. If the webview has its own copy of the comparator logic (it does — `:9030-9054` inlines the logic rather than importing `kanbanOrdering.ts`), it must be updated to apply the mode the same way the backend does. **Critical:** the webview and backend must apply the same mode logic or the screen and the system disagree.
- Add a priority badge to `createCardHtml` — renders nothing when `priority` is null (never triaged). When 0, renders a "No Priority" indicator (distinct from blank — the tracker explicitly said none). When 1–4, renders a colored dot or label matching the tracker palette (urgent=red, high=yellow/orange, normal=blue, low=grey). Clicking the badge opens a priority picker (1–4 + clear), posting a `setCardPriority` message. No confirm gate (project rule).
- **Reuse the tickets-panel priority infrastructure.** The Tickets sidebar already has a full priority popover + optimistic update + write-back flow, shipped via `replace-ticket-card-status-dot-with-changeable-priority-dot.md`. The kanban badge should follow the same pattern:
  - `openPriorityPopover` (`tickets.js:3243`) — popover with provider-specific options (Linear: 0–4 hardcoded; ClickUp: `_availableClickUpPriorities()`). The kanban version uses the same 0–4 scale but writes to `plans.priority` via `setCardPriority`, not to the tracker.
  - `selectPriority` (`tickets.js:1831`) — optimistic update + message post + `_pendingPriorityChange` in-flight guard. The kanban version posts `setCardPriority` instead of `linearUpdateIssuePriority`/`clickupUpdateTaskPriority`, and if the card has a tracker link, ALSO triggers the tracker write-back (so the board and the tracker agree).
  - CSS classes (`.ticket-priority-dot`, `.ticket-priority-option`, `.priority-option-swatch`) in `tickets.html:2996-3049` — reuse or share these styles for the kanban badge.
  - The color palette is already defined: Linear at `_linearPriorityColor` (`tickets.js:497`) and `_linearPriorityName` (`:502`); ClickUp at `_clickUpPriorityColor` (`:507`) and `_clickUpPriorityName` (`:521`). The kanban badge should use the same colors so a card's priority dot looks the same whether viewed in the tickets panel or on the board.

**Edge Cases:**
- A board where no card has priority set: the badge column is invisible (renders nothing), so no visual noise. The `Order by` control's "Priority" mode still works — it just sorts everything as NULL (stable, by fallback), which is the same as manual with no arrangement.
- The priority badge and the star icon are separate controls on the same card. They must not overlap or compete for the same visual slot.
- **Board-only cards (no tracker link):** the priority picker writes to `plans.priority` only. No tracker write-back. The badge still renders and sorts.
- **Tracker-linked cards:** the picker writes to `plans.priority` AND triggers the existing `linearUpdateIssuePriority` / `clickupUpdateTaskPriority` path, so the board and tracker stay in sync. This is the bidirectional last-write-wins behavior the plan specifies — the board route and the tickets-panel route both write to the same tracker field, same as today.

### 7. `src/services/LinearSyncService.ts` — Linear priority mapping

**Context:** Linear priority is read at `:389` (`priority: raw?.priority === undefined || raw?.priority === null ? null : Number(raw.priority)`). Write-back is at `:1217-1240` (`updateIssuePriority`). Labels at `:2753`: `['', 'urgent', 'high', 'normal', 'low']`.

**Logic:**
- On import: Linear's `priority` (0–4, where 0 = No Priority) maps directly to the `plans.priority` column. 0 stays 0 (tracker says none), 1–4 map 1:1. Null (Linear returns null when priority is unset) maps to null (never triaged). This is already the correct mapping — the import code at `:389` produces `null` for unset and `0`–`4` for set, which matches the `plans.priority` semantics exactly.
- On write-back: when a card's `priority` changes on the board and the card has a `linearIssueId`, call `updateIssuePriority(issueId, priority)` at `:1217`. If `priority` is null (never triaged), write 0 to Linear (Linear has no "null" priority — 0 is the closest). This is a lossy conversion (null → 0) but it is the only option Linear's API offers, and it is documented.
- The continuous sync (`ContinuousSyncService`) must map Linear priority changes back to `plans.priority` on poll, using the same 0–4 → 0–4 / null → null mapping.

### 8. `src/services/ClickUpSyncService.ts` — ClickUp priority mapping

**Context:** ClickUp priority is read as an object at `:779-784`: `{ id, priority, color, orderindex }`. Write path accepts an integer at `:1457`: `if (priority) body.priority = priority`.

**Logic:**
- On import: extract the integer from the ClickUp priority object. `parseInt(orderindex)` gives 1–4 (1=urgent, 2=high, 3=normal, 4=low). If the priority object is null (ClickApp disabled or no priority set), map to null (never triaged) — NOT 0, because ClickUp's "no priority" is absent, not an explicit "none" like Linear's 0. This is the key asymmetry: Linear 0 → `plans.priority` 0, ClickUp null → `plans.priority` null.
- On write-back: when a card's `priority` changes on the board and the card has a `clickupTaskId`, call `updateTask(taskId, { priority })` at `:1433-1457`. If `priority` is null, omit the `priority` field (ClickUp has no "clear priority" API — or if it does, see Uncertain Assumptions). If `priority` is 0, this is a Linear-ism that doesn't map to ClickUp; write-back should omit the field (ClickUp has no "No Priority" level — it has "no priority set").
- The continuous sync must map ClickUp priority changes back to `plans.priority` on poll, using the `orderindex` extraction.

**Edge Cases:**
- ClickUp's `orderindex` is a string (`:89`: `orderindex: string`). `parseInt` must handle this.
- A ClickUp Space with priorities disabled (ClickApp off) returns `priority: null` on the task object. Import maps this to `plans.priority = null` (never triaged), which is correct — the tracker has no priority concept for that Space.

### 9. Agent instruction (advisory)

Add to the agent rules (AGENTS.md / CLAUDE.md) a line stating that agents do not set `priority` on cards unless explicitly instructed to. This is the same class as the `GIT POLICY` line — advisory, proportionate, and recorded as a deliberate choice. The consequence of a wrong priority is a visible flag, one click to undo.

### 10. Automatic enqueue derives order from the resolver

**Context:** Automatic enqueue (triggered by the orchestration system or by card column transitions) creates queue items in `.switchboard/teams/<groupId>/queue/`. The enqueue path is `enqueueItem` at `TeamQueueService.ts:191`.

**Logic:**
- Automatic enqueue calls `enqueueItem` with `origin: 'auto'` and `priority: 0`. The order of items in the queue is determined by the resolver (`compareByPrecedence` with the current `orderByMode`), NOT by the queue item's `priority` field. Since all auto-enqueued items have `priority: 0`, `listQueue`'s sort (`:172-176`: priority desc then `enqueued_ts` asc) degenerates to FIFO by `enqueued_ts` — which preserves the resolver's order if items are enqueued in resolver order.
- The caller (the automatic enqueue logic) must sort cards by `compareByPrecedence` BEFORE enqueuing them, so the `enqueued_ts` timestamps reflect the resolver's order. This is the mechanism by which "automatic queuing respects board order" — the caller sorts, then enqueues in that order, and the queue's FIFO preserves it.
- Mission enqueue calls `enqueueItem` with `origin: 'mission'` and may set `priority` to any value. The operator's sequence is preserved by the queue's priority-desc-then-FIFO sort, and the `origin: 'mission'` field makes the provenance assertable.

### Migration

Additive and inert: default mode is manual, unset priority renders nothing, and no install's execution order changes on upgrade. V65 adds one nullable column; V63 (star + column_order) and V64 (map_fingerprint + missions) are already shipped.

## Verification Plan

- **Native, not import-only:** set priority on a locally authored plan with no tracker link. Assert it persists, renders and sorts.
- **Both trackers:** import from Linear and ClickUp; assert all four levels plus unset map correctly, and that a ClickUp Space with priorities disabled yields unset (null) rather than an error or 0.
- **Null ≠ 0:** assert a never-triaged local card renders no badge while a tracker card at No Priority renders its own state, and that the two sort distinguishably (null after 0 in priority mode).
- **Write-back:** change priority on the board; assert the linked issue updates with no guard, and that the tickets panel and the board agree afterwards.
- **The control is execution order, not a view:** select "priority", then assert the next card *dispatched* is the one the board shows first — the test that this is not the discrepancy the star plan exists to fix.
- **One resolver:** assert every consumer picks the same next card under each mode; specifically assert no consumer has its own ordering. Verify by reading `kanan.orderBy` from `config` in all three call sites (`KanbanProvider.ts:7017`, `LocalApiServer.ts:2065`, `kanban.html:9030`).
- **Star precedence:** in every mode, a starred card comes first. In STAGING, a starred or priority-floated card does not precede an incomplete predecessor — it yields or is refused with a reason.
- **In-progress safety:** with a dispatched card that would sort first under each mode, assert no consumer picks it up. (V63 already added `!c.working` to `_distributePlannerDispatch` at `KanbanProvider.ts:7015`; verify no new consumer was added without it.)
- **Upgrade inertia:** upgrade an install; assert mode is manual and dispatch order is unchanged.
- **Date mode:** select "date"; assert cards sort by `column_entered_at` DESC (most recently moved first), NOT by `created_at` or `updated_at`.
- **Complexity mode:** select "complexity"; assert cards sort by `parseInt(complexity)` ASC with `'Unknown'` sorting last.
- **Automatic queuing respects the board:** with a starred card and several unstarred ones, trigger automatic enqueue for a team. Assert items arrive in resolver order, all at priority 0, each carrying `origin: auto`.
- **Missions do not:** build a mission in Mission Control in a deliberately non-board order. Assert it runs in the operator's order, that a star does not reorder it, and that its items carry `origin: mission`.
- **The mixed case:** a mission item at priority 5 and an auto-enqueued starred card at 0 in one team queue. Assert the mission runs first, matching the documented rule rather than the star — the case someone will otherwise report as a bug.

### Goal Invariants

- Assert `plans.priority` column exists in `SCHEMA_TABLES_SQL` at `KanbanDatabase.ts` and in `PLAN_COLUMNS`.
- Assert `KanbanPlanRecord` has a `priority?: number | null` field.
- Assert `OrderableCard` in `kanbanOrdering.ts` has `priority?: number | null` and `complexity?: string` fields.
- Assert `compareByPrecedence` accepts a `mode?: SortMode` parameter (4th argument).
- Assert `QueueItem` in `TeamQueueService.ts` has an `origin: 'auto' | 'mission'` field.
- Assert `parseQueueItem` in `TeamQueueService.ts` parses `origin` from frontmatter.
- Assert `enqueueItem` in `TeamQueueService.ts` writes `origin` to frontmatter.
- Assert `kanban.orderBy` key exists in the `config` table after `setOrderByMode` is called.
- Assert the `Order by` control in `kanban.html` posts a `setOrderByMode` message on change.
- Assert the priority badge in `createCardHtml` renders nothing when `priority` is null.

## Uncertain Assumptions

The following are external API behaviors that cannot be confirmed from the codebase alone. The user was advised to run web research to confirm them before implementation:

1. **ClickUp ClickApps priority toggle per Space:** The plan assumes a ClickUp Space with the priority ClickApp disabled returns `priority: null` on task objects (not an error, not a zero-priority object). This is external API behavior — the codebase has no test or handling for this case.
2. **ClickUp "clear priority" API:** The plan assumes that omitting the `priority` field on `updateTask` leaves the existing priority unchanged (no clear). If ClickUp offers a "clear priority" API (e.g., setting priority to 0 or null), write-back from a null `plans.priority` should use it. Unknown from the code.
3. **Linear priority 0 sorting semantics:** Linear's API treats priority 0 as "No Priority" / untriaged. The plan's Outstanding Questions section asks whether unset (null) should sort last or adjacent to Low in priority mode. Linear's own UI behavior for 0 vs unset may inform this decision but is external.

## Outstanding Questions

- Should the mode be per-project rather than global, given a project filter already exists?
- Does unset (null) sort last in every mode, or adjacent to Low (priority 4)? Linear treats 0 as untriaged rather than lowest, and the two readings differ for the majority of cards. The plan's recommendation: null sorts after 0, and 0 sorts after 1–4, so the full order is 1 > 2 > 3 > 4 > 0 > null. This makes "No Priority" (0) a real state that sorts below Low but above never-triaged.
- Is a priority sort even wanted in STAGING, where streams already sequence work, or should the control be inert there? The plan's recommendation: the mode applies everywhere (it is global), but STAGING's dependency gate (yield-or-refuse) still governs — a priority-floated card that jumps ahead of an incomplete predecessor is refused, same as a starred card.
