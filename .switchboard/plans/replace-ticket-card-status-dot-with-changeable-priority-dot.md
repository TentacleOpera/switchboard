# Replace Sidebar Card Status Dot with a Changeable Priority Dot

**Plan ID:** 27e8f591-1b0f-4210-b9c4-ad158d3a060b

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, ui, ux, feature
**Project:** _(unassigned — no active project filter set)_

## Goal

Replace the read-only **status**-colored dot on each ticket card in the Tickets sidebar with a **priority**-colored dot that is **clickable inline** to change the ticket's priority — for both ClickUp and Linear. Status remains visible as text in the row beneath the title (and the status-group accordion headers keep their status dots, since the groups are status-grouped).

### Problem & Root Cause

- **Symptom:** Each ticket card in the sidebar shows a small colored dot in the top-right corner. Today that dot reflects the ticket's **status** (color from `task.statusColor` / `issue.state.color`), and it is purely decorative — it cannot be clicked or changed. Meanwhile there is **no priority indicator on the card at all** and **no way to change priority from the Tickets tab** (the meta bar has Status and Tags but no priority control).
- **Root cause:** The card renderer (`_renderClickUpTicketCard` / `_renderLinearTicketCard` in `planning.js`, lines ~9170 and ~9197) hardcodes a `ticket-status-light` span from the status color. The CSS defines a shared `.ticket-priority-dot, .ticket-status-light` rule (line 2823) but `.ticket-priority-dot` is never rendered by any element. No priority update path is wired into the webview message switch.
- **Why this design:** The status is already conveyed by the status-group accordion the card sits inside (and by the status text row), so a second status-colored dot is redundant. Priority is currently invisible on the card and unchangeable anywhere in the tab. Repurposing the dot's slot for priority both surfaces priority at a glance and gives a natural click target to change it — without adding a second dot or a new meta-bar control (per the user's explicit choice: "dot becomes priority", "inline on card only").

### Scope (confirmed with user)

- **Dot meaning:** The per-card dot becomes priority-colored (replaces the status dot). Status stays shown as text in the row below the title.
- **Changeable where:** Inline on the card only — click the dot to open a small priority picker. No meta-bar control.
- **Providers:** Both ClickUp **and** Linear.

### Out of scope

- A priority control in the detail/meta bar (user chose inline-on-card only).
- A second dot for priority alongside the status dot (user chose to replace, not add).
- Priority as a list filter/sort/grouping option (the sidebar stays grouped by status).
- Changing the status-group accordion header dot (it remains a status dot — the group IS a status group).
- Bulk priority changes across multiple tickets.

## User Review Required

Yes — confirm before coding:
1. The priority color palette for **Linear** (Urgent `#eb5757`, High `#f2c94c`, Normal `#5e6ad2`, Low `#95a2b3`, No priority grey/hollow) matches the product's expectation. These are assumed standard Linear palette values (see Uncertain Assumptions).
2. The optimistic-update-then-revert-on-error UX is acceptable. NOTE: the existing **status** change flow (`changeTicketStatusResult`) is **not** optimistic and does **not** revert on error — it only shows an error footer. This plan deliberately introduces a stronger optimistic+revert pattern for the priority dot because a dot flip is more visually jarring if it silently fails. Confirm this divergence from the status flow is desired.
3. ClickUp priority options are derived from already-loaded tasks (`clickUpProjectIssues`) with a hardcoded standard-set fallback. Confirm the fallback colors are acceptable when no tasks carry a priority object.

## Complexity Audit

### Routine
- Mirroring `updateIssueState` to add `updateIssuePriority` in `LinearSyncService.ts` — same `issueUpdate(id, input:{...})` mutation shape, same cache-invalidation tail. Pure pattern reuse.
- Adding two message-switch cases (`linearUpdateIssuePriority`, `clickupUpdateTaskPriority`) in `PlanningPanelProvider.ts` — structural clone of `linearUpdateIssueLabels` (5100) / `clickupUpdateTaskTags` (5136): validate → service call → post result → catch → post error.
- Swapping the `ticket-status-light` span for a `ticket-priority-dot` span in the two card renderers — 1:1 markup swap, same absolute-positioned slot.
- CSS additions: a `.ticket-priority-dot`-only cursor/hover rule + a popover style mirroring `#tickets-mention-dropdown` (3776). Variable reuse, no new design tokens.

### Complex / Risky
- **Optimistic update + revert-on-error is a NEW pattern** in this tab. The status flow it is "modeled on" does neither. The revert path must stash the pre-change priority and restore it on `linearError`/`clickupError` (scoped to the pending change) — getting this right without a generic transaction wrapper is the main logic risk.
- **Popover lifecycle vs. list re-render.** `renderTicketsLinearList` / `renderTicketsClickUpList` can fire from background refreshes and detach the popover's anchor. The close-on-render hook must be installed in both render entry points, and only one popover may exist at a time.
- **ClickUp `priority: 0` semantics.** `updateTask` sends `updates` raw (no truthy guard at 1409–1460), so `0` IS transmitted — but whether ClickUp's API treats `0` as "clear priority" vs. "no change" vs. error is unverified (see Uncertain Assumptions). If `0` does not clear, the "No priority" option will silently no-op for ClickUp.
- **Popover viewport positioning** near the sidebar bottom edge (flip-above logic via `getBoundingClientRect`).

## Edge-Case & Dependency Audit

### Race Conditions
- **Rapid double-click on the dot** before the first update resolves: could send two `*UpdateTaskPriority` messages and race the optimistic state. Mitigation: disable the dot (`pointer-events:none` + a `.busy` class) the moment `selectPriority` fires, re-enable on result/error. Only one popover open at a time also prevents a second picker opening.
- **Background list refresh while popover open:** a `renderTickets*List` call re-renders the container and orphans the popover. Mitigation: `closePriorityPopover()` is called at the start of both `renderTicketsLinearList` (1430) and `renderTicketsClickUpList` (1434).
- **Optimistic update vs. canonical refetch ordering:** the canonical refetch (`loadLinearTaskDetails`/`loadClickUpTaskDetails`) may return a stale record if it loses a race with the write. Mitigation: the service methods invalidate the list cache before returning (`LinearSyncService.updateIssueState` 1117–1126; `ClickUpSyncService.updateTask` 1448–1457), so the refetch hits fresh data.

### Security
- No new input vectors. `updateIssuePriority` validates `Number.isInteger(priority) && 0<=n<=4`. ClickUp handler validates `taskId` non-empty + `priority` int 0–4. Priority values are provider enums, not free text. No SQL, no HTML injection (dot attrs go through `escapeAttr`).

### Side Effects
- ClickUp `updateTask` invalidates the task's list cache (broad fallback invalidates ALL ClickUp cache if the list is unknown — 1454). Acceptable; mirrors existing update calls.
- Linear `updateIssuePriority` invalidates the issue's project cache (or all Linear cache as fallback).
- On-disk ticket markdown format is unchanged (priority is already serialized by the existing import path).

### Dependencies & Conflicts
- **Depends on** the existing `_adapterFactories.getLinearSyncService` / `getClickUpSyncService` accessors and the `updateTask` signature already accepting `priority?: number` (1419) — no ClickUp service change needed.
- **Conflicts:** none anticipated. The `.ticket-priority-dot` class is currently unused, so repurposing it cannot regress any existing element. The status-group header dot uses `.ticket-status-light` (9230), so a `.ticket-priority-dot`-only cursor/hover rule does NOT affect the header dot — **do not** add cursor/hover to the shared block at 2823.
- **No `extension.ts` / command registration** required (matches the tags/labels wiring, which calls services directly from `PlanningPanelProvider`).

## Dependencies

- None. No `sess_XXXXXXXXXXXXX` prerequisites. Self-contained frontend+backend change within the Tickets tab.

## Background & Context

### Priority data models

- **Linear:** `issue.priority` is a number `0–4` where `0` = No priority, `1` = Urgent, `2` = High, `3` = Normal, `4` = Low (confirmed by the existing mapping at `LinearSyncService.ts:2624`: `['', 'urgent', 'high', 'normal', 'low'][issue.priority]`). The Linear GraphQL `issueUpdate` mutation accepts `priority: Int` on `IssueUpdateInput` (assumed — see Uncertain Assumptions). No `updateIssuePriority` method exists yet — add one mirroring `updateIssueState` (line 1095).
- **ClickUp:** `task.priority` is an object `{ id, priority, color, orderindex }` (see `ClickUpSyncService.ts:88`, normalized at line 764). `orderindex` is a **string** (e.g. `"1"`); the numeric priority value used for updates is `Number(orderindex)`: `1` = Urgent, `2` = High, `3` = Normal, `4` = Low, `0` = No priority (the existing complexity→priority mapping at line 2750 confirms this scale). `updateTask(taskId, { priority: number })` **already supports priority** (param at 1419; method 1409). The method sends `updates` raw to `PUT /task/{id}` (1438–1440) with **no truthy guard**, so `priority: 0` IS transmitted (whether the API clears on `0` is unverified — see Uncertain Assumptions). There is no `getPriorities` endpoint in the codebase; ClickUp priority names/colors are workspace-configurable but the standard set is consistent.

### Files involved (line numbers verified against current `src/`)

- `src/webview/planning.js` — state vars `linearProjectIssues` (241), `selectedLinearIssue` (242), `selectedClickUpIssue` (256), `clickUpProjectIssues` (255); `showTicketsStatus(text, isError)` (660); `renderTicketsLinearList` (1430) / `renderTicketsClickUpList` (1434); card renderers `_renderClickUpTicketCard` (9170, statusLight built 9175 / used 9180) and `_renderLinearTicketCard` (9197, statusLight built 9202 / used 9207); `_ticketStatusLightColor` (9123); `_renderTicketStatusGroup` (9224, header dot 9230 — **keep its status dot**); result handlers `changeTicketStatusResult` (4871), `linearLabelsUpdated` (5323), `clickupTagsUpdated` (5329); delegated ticket-card click handler on `#tickets-issues-container` (8372) — inject dot detection at the top (before the statusHeader check at 8375 and the card-select closest at 8467).
- `src/webview/planning.html` — CSS shared block `.ticket-priority-dot, .ticket-status-light` (2823) and `.ticket-status-light` extras (2834); `#tickets-mention-dropdown` popover template (3776) to mirror; `body.theme-claudify .ticket-status-light` (101). New: a `<div id="ticket-priority-popover">` element + `.ticket-priority-dot`-only cursor/hover rule + `.ticket-priority-popover` / `.ticket-priority-option` styles.
- `src/services/PlanningPanelProvider.ts` — webview message switch: add `linearUpdateIssuePriority` and `clickupUpdateTaskPriority` cases (mirror `linearUpdateIssueLabels` at 5100 and `clickupUpdateTaskTags` at 5136).
- `src/services/LinearSyncService.ts` — add `updateIssuePriority(issueId, priority: number)` mirroring `updateIssueState` (1095); reuse the `_issueProjectIndex` + `_cacheService` invalidation tail (1117–1126).
- `src/services/ClickUpSyncService.ts` — `updateTask(id, { priority })` already works; no new method needed.

### Existing patterns to mirror

- **Status dropdown round-trip** (`select-status-ticket` change → `changeTicketStatus` message → `changeTicketStatusResult` (4871) → `loadLinearTaskDetails`/`loadClickUpTaskDetails` + `renderTickets*List`): the priority update should follow the same message + result + canonical-refetch flow. **Important divergence:** the status flow is NOT optimistic and does NOT revert on error; this plan adds optimistic update + revert for the priority dot (see User Review Required #2).
- **Tags/labels update wiring** (`linearUpdateIssueLabels` 5100 / `clickupUpdateTaskTags` 5136 in `PlanningPanelProvider.ts`): direct service calls via `_adapterFactories`, no `extension.ts` command registration.
- **`_ticketStatusLightColor`** (9123): a parallel `_linearPriorityColor(priority)` helper for Linear's fixed enum, plus `_clickUpPriorityColor(task)` deriving from the loaded task's `priority.color`.

## Design Decisions

1. **Replace, don't add.** The per-card dot's slot is reused for priority. The status-group accordion header dot stays a status dot (the group is defined by status, so a priority dot there would be meaningless). Status text remains in the `.ticket-status-row` beneath the title, so no status information is lost.
2. **Inline popover, not cycling.** Clicking the dot opens a tiny anchored popover listing the priority options with their colors and names (radio-like, current one highlighted). Cycling (click→next) was rejected because it hides labels and makes it easy to mis-set. The popover mirrors the look of the existing `tickets-mention-dropdown` (3776) — absolute-positioned, bordered, z-indexed.
3. **Linear priority colors are fixed** (standard Linear palette): Urgent `#eb5757`, High `#f2c94c`, Normal `#5e6ad2`, Low `#95a2b3`, No priority `#95a2b3` (hollow). Defined in a new `_linearPriorityColor(n)` helper. (Exact hex values are assumptions — see Uncertain Assumptions.)
4. **ClickUp priority colors come from the loaded tasks.** Since there's no `getPriorities` endpoint, derive the available priority options by scanning the already-loaded `clickUpProjectIssues` for distinct `priority` objects (keyed by `Number(priority.orderindex)`), falling back to a hardcoded standard set (Urgent/High/Normal/Low with default ClickUp colors) if none are loaded. This reuses data already in memory and respects workspace-customized colors.
5. **"No priority" is always an option** (sends `0` for both providers).
6. **Optimistic update + canonical refetch + revert-on-error.** On click, immediately update the in-memory task/issue's priority and re-render the card dot; send the update message; on result, refresh the canonical record (mirror the status/tags flow). On error, revert the dot to the pre-change value and surface the error via `showTicketsStatus`. NOTE: this is stronger than the existing status flow (which is neither optimistic nor reverting) — see User Review Required #2.
7. **Direct service calls from `PlanningPanelProvider`** (matching tags/labels wiring) — no `extension.ts` changes.

## Requirements

### Functional

1. Each ticket card in the sidebar shows a single dot in the top-right whose **color and tooltip reflect the ticket's priority** (not status). Tooltip text: the priority name (e.g. "Urgent", "High", "Normal", "Low", "No priority").
2. Clicking the dot opens a small popover anchored to it, listing all available priorities for the provider with their color swatch + name, plus "No priority". The current priority is highlighted.
3. Selecting an option closes the popover, updates the dot immediately (optimistic), and sends the update to the provider.
4. On success, the canonical ticket record is refreshed (so the dot stays correct across re-renders). On error, the dot reverts to the previous priority and an error is shown in the status footer.
5. The status-group accordion header dots remain status-colored and are not affected.
6. Works for both Linear and ClickUp.

### Non-functional

- The popover closes on outside click, Escape, or scroll (mirror standard popover behavior).
- Only one popover open at a time across the sidebar.
- The dot remains `pointer-events: auto` and the rest of the card's existing click-to-select behavior is unchanged (the dot click must `stopPropagation` so it doesn't also select the card / open detail — though selecting is harmless, the popover should take precedence).
- No change to on-disk ticket markdown format (priority is already serialized by the existing import path).

## Adversarial Synthesis

Key risks: (1) the optimistic+revert pattern is novel for this tab and the revert path must correctly pair each pending change with its pre-value on `linearError`/`clickupError`; (2) ClickUp `priority: 0` clearing behavior is unverified, so "No priority" may silently no-op for ClickUp; (3) popover-orphaning on background re-render must be guarded in both list renderers. Mitigations: stash pre-change value per pending update + disable the dot during the in-flight request; close the popover at the top of both `renderTickets*List` calls; verify the ClickUp `0`-clears assumption (or send the documented no-priority value) during implementation.

## Proposed Changes

### `src/services/LinearSyncService.ts`
- **Context:** No `updateIssuePriority` exists; `updateIssueState` (1095) is the canonical `issueUpdate` mutation + cache-invalidation template.
- **Logic:** Add `public async updateIssuePriority(issueId: string, priority: number): Promise<void>` mirroring `updateIssueState` (1095–1126): `loadConfig` → setup guard → trim/validate `issueId` → validate `Number.isInteger(priority) && 0 <= priority <= 4` (throw otherwise) → `graphqlRequest` with `mutation($id: String!, $priority: Int!) { issueUpdate(id: $id, input: { priority: $priority }) { success } }` → throw if `!result.data?.issueUpdate?.success` → invalidate cache via `_issueProjectIndex` + `_cacheService` (identical tail to 1117–1126).
- **Implementation:** Insert immediately after `updateIssueState` (1127) so the two `issueUpdate` mutators sit together.
- **Edge Cases:** `priority: 0` is the documented Linear "No priority" value (assumed — see Uncertain Assumptions). Non-integer / out-of-range throws before any network call.

### `src/services/ClickUpSyncService.ts`
- **Context:** `updateTask` (1409) already accepts `priority?: number` (1419) and sends `updates` raw to `PUT /task/{id}` (1438–1440) with no truthy guard, so `priority: 0` IS transmitted.
- **Logic:** No new method. The `PlanningPanelProvider` handler calls `clickUp.updateTask(taskId, { priority })` directly (mirroring `clickup.updateTask(taskId, { tags })` at 5155).
- **Implementation:** None in this file.
- **Edge Cases:** Whether ClickUp's API clears priority on `0` is unverified (see Uncertain Assumptions). If implementation testing shows `0` does not clear, send the documented no-priority value (e.g. omit and call a clear endpoint, or send `null` if the v3 API accepts it) — record the resolution in the Open Questions section during implementation.

### `src/services/PlanningPanelProvider.ts`
- **Context:** Message switch; `linearUpdateIssueLabels` (5100) and `clickupUpdateTaskTags` (5136) are the direct-service-call templates.
- **Logic:** Add two cases:
  - `case 'linearUpdateIssuePriority'`: resolve workspace root; validate `issueId` + `priority` (int 0–4); `await linear.updateIssuePriority(issueId, priority)`; post `{ type: 'linearPriorityUpdated', issueId, priority, workspaceRoot }`; catch → post `{ type: 'linearError', scope:'task', issueId, error, workspaceRoot }`.
  - `case 'clickupUpdateTaskPriority'`: resolve workspace root; validate `taskId` + `priority` (int 0–4); `await clickUp.updateTask(taskId, { priority })`; post `{ type: 'clickupPriorityUpdated', taskId, priority, workspaceRoot }`; catch → post `{ type: 'clickupError', scope:'task', taskId, error, workspaceRoot }`.
- **Implementation:** Insert adjacent to the labels/tags cases (after `clickupUpdateTaskTags` ends at 5172) to keep all ticket-field mutators grouped.
- **Edge Cases:** Validation mirrors the labels/tags guards (empty id → error post, no throw). `priority` must be coerced with `Number(msg.priority)` and range-checked.

### `src/webview/planning.js` — priority helpers
- **Context:** `_ticketStatusLightColor` (9123) is the parallel helper to mimic.
- **Logic / Implementation:**
  - `_linearPriorityColor(n)`: `0→#95a2b3` (No priority, render hollow), `1→#eb5757` (Urgent), `2→#f2c94c` (High), `3→#5e6ad2` (Normal), `4→#95a2b3` (Low). Return the color.
  - `_linearPriorityName(n)`: `['No priority','Urgent','High','Normal','Low'][n]`.
  - `_clickUpPriorityColor(task)`: return `task.priority?.color` or a default per `Number(task.priority?.orderindex)` value.
  - `_clickUpPriorityName(task)`: return `task.priority?.priority` (the string name) or a default.
  - `_availableClickUpPriorities()`: scan the loaded `clickUpProjectIssues` for distinct `priority` objects keyed by `Number(priority.orderindex)`; return an ordered list `[{ value, name, color }]` including a `0`/"No priority" entry; fall back to the standard set (1=Urgent,2=High,3=Normal,4=Low with default ClickUp colors) if none are loaded.
  - Linear fixed option list: `[{value:0,name:'No priority',color:'#95a2b3'}, {value:1,name:'Urgent',color:'#eb5757'}, {value:2,name:'High',color:'#f2c94c'}, {value:3,name:'Normal',color:'#5e6ad2'}, {value:4,name:'Low',color:'#95a2b3'}]`.

### `src/webview/planning.js` — card renderer changes
- **Context:** `_renderClickUpTicketCard` (9170) builds `statusLight` at 9175 and renders it at 9180; `_renderLinearTicketCard` (9197) builds it at 9202 and renders it at 9207.
- **Logic / Implementation:**
  - In `_renderClickUpTicketCard` (9170): replace the `statusLight` span with a priority dot:
    `<span class="ticket-priority-dot" style="background:${escapeAttr(priorityColor)}" data-priority-value="${Number(task.priority?.orderindex) || 0}" data-priority-provider="clickup" data-ticket-id="${escapeAttr(task.id)}" title="Priority: ${escapeAttr(priorityName)}"></span>`
    where `priorityColor = _clickUpPriorityColor(task)` and `priorityName = _clickUpPriorityName(task)`.
  - In `_renderLinearTicketCard` (9197): same, using `_linearPriorityColor(issue.priority ?? 0)` and `_linearPriorityName(issue.priority ?? 0)`, with `data-priority-value="${issue.priority ?? 0}"`, `data-priority-provider="linear"`, `data-ticket-id="${escapeAttr(issue.id)}"`.
  - **Do not touch** `_renderTicketStatusGroup` (9224) — its header dot (9230) stays a status dot (`.ticket-status-light`).
  - Keep the `.tickets-issue-meta.ticket-status-row` text row unchanged (status name still shown at 9182 / 9209).

### `src/webview/planning.js` — inline popover + state
- **Context:** `#tickets-mention-dropdown` (3776) is the popover look template; the delegated click handler is on `#tickets-issues-container` (8372).
- **Logic / Implementation:**
  - Add state: `let _openPriorityPopoverFor = null;` (holds `{ provider, ticketId, preValue, dotEl }` or null) and `let _pendingPriorityChange = null;` (holds `{ provider, ticketId, preValue }` or null) for revert.
  - `openPriorityPopover(dotEl, provider, ticketId, currentValue)`: position relative to `dotEl.getBoundingClientRect()` within the sidebar container (flip above if overflow); populate the popover with the provider's priority options (Linear: fixed 5; ClickUp: `_availableClickUpPriorities()`); highlight `currentValue`; show; set `_openPriorityPopoverFor`; attach a one-shot outside-click / Escape / scroll handler to close.
  - `closePriorityPopover()`: hide, null `_openPriorityPopoverFor`, remove handlers.
  - `selectPriority(value)`: read `{ provider, ticketId, preValue }` from `_openPriorityPopoverFor`; `closePriorityPopover()`; stash into `_pendingPriorityChange`; optimistic update of the in-memory `selectedClickUpIssue.task.priority` / `selectedLinearIssue.issue.priority` AND the matching item in `clickUpProjectIssues` / `linearProjectIssues` (set ClickUp `priority` to `{id:'',priority:name,color,orderindex:String(value)}` or `null` for 0; set Linear `priority` to `value`); re-render the affected card's dot (or call the matching `renderTickets*List()`); disable the dot (`.busy` + `pointer-events:none`); send `linearUpdateIssuePriority` / `clickupUpdateTaskPriority` message.
  - **Event delegation injection:** at the TOP of the `#tickets-issues-container` click handler (8372), before the statusHeader check (8375), add: `const priorityDot = e.target.closest('.ticket-priority-dot'); if (priorityDot) { e.stopPropagation(); closePriorityPopover(); openPriorityPopover(priorityDot, priorityDot.dataset.priorityProvider, priorityDot.dataset.ticketId, Number(priorityDot.dataset.priorityValue)); return; }`. This must precede the card-select `closest('[data-linear-issue-id], [data-clickup-task-id]')` at 8467 so the dot click never drills into the card.
  - Close any open popover at the start of `renderTicketsLinearList` (1430) and `renderTicketsClickUpList` (1434) (re-render safety).

### `src/webview/planning.js` — result handlers
- **Context:** `changeTicketStatusResult` (4871) does in-memory list update + `loadLinearTaskDetails`/`loadClickUpTaskDetails` + `renderTickets*List`; `linearLabelsUpdated` (5323) / `clickupTagsUpdated` (5329) update the selected detail only.
- **Logic / Implementation:**
  - `case 'linearPriorityUpdated'`: clear `_pendingPriorityChange`; find the issue in `linearProjectIssues` and `selectedLinearIssue` (optimistic update already set the value); call `loadLinearTaskDetails(msg.id)` (canonical refetch, mirroring 4884) + `renderTicketsLinearList()`; re-enable the dot; `showTicketsStatus('Priority updated ✓', false)`.
  - `case 'clickupPriorityUpdated'`: same for ClickUp — `loadClickUpTaskDetails(msg.id)` (mirroring 4895) + `renderTicketsClickUpList()`; re-enable the dot; success status.
  - `case 'linearError'` / `case 'clickupError'` with `scope: 'task'`: if `_pendingPriorityChange` matches `msg.issueId`/`msg.taskId`, revert the in-memory priority to `preValue`, re-render the dot (or `renderTickets*List()`), re-enable the dot, clear `_pendingPriorityChange`, and `showTicketsStatus(msg.error, true)`.

### `src/webview/planning.html` — CSS
- **Context:** Shared block `.ticket-priority-dot, .ticket-status-light` at 2823 (position/size); `.ticket-status-light` extras at 2834; `#tickets-mention-dropdown` at 3776.
- **Logic / Implementation:**
  - Add a **separate** `.ticket-priority-dot { cursor: pointer; }` rule and a hover state (`box-shadow: 0 0 4px currentColor` or a subtle ring) so it's visibly interactive. **Do NOT** add cursor/hover to the shared block at 2823 — that would also make the status-group header dot (`.ticket-status-light`, 9230) appear clickable.
  - Add the `<div id="ticket-priority-popover" style="display:none;">` element (structured like 3776: absolute, bordered, max-height, z-index 100).
  - Add `.ticket-priority-popover` styles mirroring `#tickets-mention-dropdown`: `background: var(--panel-bg)`, `border: 1px solid var(--border-color)`, `border-radius: 4px`, `box-shadow`, `z-index: 100`, `max-height: 180px`, `overflow-y: auto`.
  - Add `.ticket-priority-option` row styles (color swatch + name, hover highlight, selected indicator).
  - Ensure `theme-claudify` and `cyber-theme-enabled` inherit correctly (they will, since vars are used; note the existing `body.theme-claudify .ticket-status-light` rule at 101 and add a parallel `body.theme-claudify .ticket-priority-dot` if needed for shadow parity).

## Uncertain Assumptions

The following were assumed during planning and should be confirmed via web research before implementation (the user was advised to run the research prompt supplied at the end of the chat summary):

1. **Linear `IssueUpdateInput.priority` accepts `Int` and `priority: 0` means "No priority."** The read-side enum (0=no priority) is confirmed in-code at `LinearSyncService.ts:2624`, but the mutation input type and the canonical "clear priority" value (0 vs. `null`) for the current Linear GraphQL API version are unverified.
2. **ClickUp `PUT /task/{id}` with `{"priority": 0}` clears priority.** The code transmits `0` (no truthy guard), but whether the ClickUp v2/v3 API treats `0` as "clear", "no change", or an error is unverified. If `0` does not clear, the "No priority" option will silently no-op for ClickUp.
3. **Linear priority hex colors** (Urgent `#eb5757`, High `#f2c94c`, Normal `#5e6ad2`, Low `#95a2b3`). These are the assumed standard Linear palette; exact current values are unverified (cosmetic, low risk).

## Verification Plan

### Automated Tests
N/A — automated tests and project compilation are skipped per session directives. Verification is manual only.

### Manual Verification
- **Linear:** select a Linear ticket → click its dot → popover shows 5 options with current highlighted → pick "Urgent" → dot turns red, tooltip "Priority: Urgent" → reopen → "Urgent" highlighted → pick "No priority" → dot turns grey/hollow. Confirm status text row unchanged. Confirm status-group header dot still shows status color.
- **ClickUp:** same flow; confirm popover colors match the workspace's priority colors (derived from loaded tasks); confirm multi-card distinct colors render correctly; confirm "No priority" actually clears on the ClickUp side (verifies Uncertain Assumption #2).
- **Error path:** temporarily use an invalid token → click a priority → confirm dot reverts to the pre-change value and an error appears in the status footer; confirm the dot is re-enabled.
- **Double-click race:** click the dot twice rapidly → confirm only one update is sent (dot disabled during in-flight) and no torn state.
- **Re-render safety:** open the popover, trigger a list refresh (e.g. switch provider and back, or hit Refresh) → confirm no orphaned popover.
- **Theme:** toggle `theme-claudify` and `cyber-theme-enabled` → confirm dot + popover styling is consistent.
- **Typecheck (optional, not required):** if a typecheck command is available in `package.json`, run it to confirm the new `updateIssuePriority` method and message-handler cases compile. (Skipped per session directive unless the implementer opts in.)

## Open Questions for Implementation

- Confirm the exact build/typecheck command (check `package.json` scripts during implementation) — optional, skipped per session directive.
- Confirm whether ClickUp's `updateTask({ priority: 0 })` reliably clears priority (see Uncertain Assumptions #2; verify against ClickUp API docs during step 2; if `0` doesn't clear, send the documented no-priority value and record the resolution here).

## Acceptance Criteria

- [ ] Per-card dot color + tooltip reflect priority (not status) for both providers.
- [ ] Clicking the dot opens an inline popover with all priority options + "No priority", current highlighted.
- [ ] Selecting an option updates the provider and the dot (optimistic, then canonical refetch).
- [ ] Errors revert the dot to the pre-change value and surface in the status footer; no uncaught exceptions; dot re-enabled.
- [ ] Status-group accordion header dots remain status-colored and unchanged.
- [ ] Status text row beneath the title still shows the status name.
- [ ] Popover closes on outside click / Escape / scroll / re-render; only one open at a time.
- [ ] Double-click on the dot does not produce duplicate updates or torn state.
- [ ] Works under both `theme-claudify` and `cyber-theme-enabled`.

**Recommendation:** Complexity 5 (Mixed) → **Send to Coder.** Majority of the work is routine pattern-mirroring (Linear mutation, message-switch cases, card markup swap, CSS); the moderate risks are the novel optimistic+revert path, popover lifecycle vs. re-render, and the ClickUp `priority: 0` API behavior (resolve via research before coding).

## Review Findings

Reviewed against commit `c09cba8`. **Fixed (MAJOR):** the in-flight double-update guard in `selectPriority` (`src/webview/planning.js`) was ineffective — it added a `.busy` class to the dot, then the optimistic `renderTickets*List()` rebuilt the dot without it, so a second selection could fire a duplicate write; replaced with a state-based gate on `_pendingPriorityChange` (one priority write at a time, survives re-render). Card markup swap, popover lifecycle (closed at top of both list renderers), optimistic+revert on `linear/clickupError`, status-group header dot preserved, and the new Linear `updateIssuePriority` all match the plan; no orphaned `statusLight`/`statusColor` refs remain. Validation: `node --check src/webview/planning.js` passes; compilation/tests skipped per directive. **Remaining risks:** ClickUp "No priority" sends `{priority: 0}` and whether the API clears vs. no-ops on `0` is still unverified (Uncertain Assumption #2 — needs a live-API check; if it no-ops, send the documented clear value); `_availableClickUpPriorities` reads `t.priority.priority` guarded only by `orderindex` (would throw on a name-less priority object, near-impossible after normalization).

**Stage Complete:** PLAN REVIEWED
