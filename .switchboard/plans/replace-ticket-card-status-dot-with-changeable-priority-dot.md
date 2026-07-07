# Replace Sidebar Card Status Dot with a Changeable Priority Dot

## Metadata

**Complexity:** 4
**Tags:** frontend, backend, ui, ux, feature
**Project:** _(unassigned — no active project filter set)_

## Goal

Replace the read-only **status**-colored dot on each ticket card in the Tickets sidebar with a **priority**-colored dot that is **clickable inline** to change the ticket's priority — for both ClickUp and Linear. Status remains visible as text in the row beneath the title (and the status-group accordion headers keep their status dots, since the groups are status-grouped).

### Problem & Root Cause

- **Symptom:** Each ticket card in the sidebar shows a small colored dot in the top-right corner. Today that dot reflects the ticket's **status** (color from `task.statusColor` / `issue.state.color`), and it is purely decorative — it cannot be clicked or changed. Meanwhile there is **no priority indicator on the card at all** and **no way to change priority from the Tickets tab** (the meta bar has Status and Tags but no priority control).
- **Root cause:** The card renderer (`_renderClickUpTicketCard` / `_renderLinearTicketCard` in `planning.js`, lines ~9186 and ~9213) hardcodes a `ticket-status-light` span from the status color. The CSS defines `ticket-priority-dot` (line 2834) but it is never rendered. No priority update path is wired into the webview message switch.
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

## Background & Context

### Priority data models

- **Linear:** `issue.priority` is a number `0–4` where `0` = No priority, `1` = Urgent, `2` = High, `3` = Normal, `4` = Low (confirmed by the existing mapping at `LinearSyncService.ts:2624`: `['', 'urgent', 'high', 'normal', 'low'][issue.priority]`). The Linear GraphQL `issueUpdate` mutation accepts `priority: Int` on `IssueUpdateInput`. No `updateIssuePriority` method exists yet — add one mirroring `updateIssueState` (line 1095).
- **ClickUp:** `task.priority` is an object `{ id, priority, color, orderindex }` (see `ClickUpSyncService.ts:88`, normalized at line 764). The numeric priority value used for updates is `1` = Urgent, `2` = High, `3` = Normal, `4` = Low, `0` = No priority (the existing complexity→priority mapping at line 2750 confirms this scale). `updateTask(taskId, { priority: number })` **already supports priority** (line 1419). There is no `getPriorities` endpoint in the codebase; ClickUp priority names/colors are workspace-configurable but the standard set is consistent.

### Files involved

- `src/webview/planning.js` — card renderers (`_renderClickUpTicketCard` ~9186, `_renderLinearTicketCard` ~9213), `_ticketStatusLightColor` (9139), the status-group renderer (`_renderTicketStatusGroup` 9240 — **keep its status dot**), message switch result handlers, click-event delegation.
- `src/webview/planning.html` — CSS for `.ticket-priority-dot` (line 2834, already defined) and a new inline popover menu style.
- `src/services/PlanningPanelProvider.ts` — webview message switch: add `linearUpdateIssuePriority` and `clickupUpdateTaskPriority` cases (mirror `linearUpdateIssueLabels` at 5092 and `clickupUpdateTaskTags` at 5128).
- `src/services/LinearSyncService.ts` — add `updateIssuePriority(issueId, priority: number)` mirroring `updateIssueState` (1095).
- `src/services/ClickUpSyncService.ts` — `updateTask(id, { priority })` already works; no new method needed.

### Existing patterns to mirror

- **Status dropdown round-trip** (`select-status-ticket` change → `changeTicketStatus` message → `changeTicketStatusResult` → refetch): the priority update should follow the same message + result + optimistic-update flow.
- **Tags/labels update wiring** (`linearUpdateIssueLabels` / `clickupUpdateTaskTags` in `PlanningPanelProvider.ts`): direct service calls via `_adapterFactories`, no `extension.ts` command registration.
- **`_ticketStatusLightColor`** (line 9139): a parallel `_ticketPriorityColor(priority)` helper for Linear's fixed enum.

## Design Decisions

1. **Replace, don't add.** The per-card dot's slot is reused for priority. The status-group accordion header dot stays a status dot (the group is defined by status, so a priority dot there would be meaningless). Status text remains in the `.ticket-status-row` beneath the title, so no status information is lost.
2. **Inline popover, not cycling.** Clicking the dot opens a tiny anchored popover listing the priority options with their colors and names (radio-like, current one highlighted). Cycling (click→next) was rejected because it hides labels and makes it easy to mis-set. The popover mirrors the look of the existing `tickets-mention-dropdown` (line 3787) — absolute-positioned, bordered, z-indexed.
3. **Linear priority colors are fixed** (standard Linear palette): Urgent `#eb5757`, High `#f2c94c`, Normal `#5e6ad2`, Low `#95a2b3`, No priority `#95a2b3` (hollow). Defined in a new `_linearPriorityColor(n)` helper.
4. **ClickUp priority colors come from the loaded tasks.** Since there's no `getPriorities` endpoint, derive the available priority options by scanning the already-loaded `clickUpProjectTasks` for distinct `priority` objects (keyed by `priority` numeric value), falling back to a hardcoded standard set (Urgent/High/Normal/Low with default ClickUp colors) if none are loaded. This reuses data already in memory and respects workspace-customized colors.
5. **"No priority" is always an option** (sends `0` for both providers).
6. **Optimistic update + canonical refetch.** On click, immediately update the in-memory task/issue's priority and re-render the card dot; send the update message; on result, refresh the canonical record (mirror the status/tags flow). On error, revert the dot and surface the error via `showTicketsStatus`.
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

## Edge Cases & Risks

- **ClickUp priority color mismatch across workspaces.** Different ClickUp workspaces can customize priority colors. Mitigation: derive colors from loaded tasks (Design Decision #4); fall back to standard colors only if no tasks carry a priority object.
- **ClickUp task with no priority loaded.** `task.priority` may be `null`. The dot renders as the "No priority" color (grey/hollow) and the popover still lets the user set one.
- **Linear priority outside 0–4.** Should never happen, but `updateIssuePriority` validates `0 <= priority <= 4` and throws otherwise.
- **Popover positioning near viewport edges.** A card near the bottom of the sidebar could push the popover off-screen. Mitigation: position the popover with a `max-height` and flip above the dot if it would overflow the sidebar container (simple `getBoundingClientRect` check, mirroring how the mention dropdown is constrained).
- **Re-render while popover open.** A background ticket refresh could re-render the list and detach the popover's anchor. Mitigation: close any open popover at the start of `renderTicketsLinearList` / `renderTicketsClickUpList`.
- **Status-group header dot confusion.** Users might expect the header dot to also be priority. Mitigation: the header dot keeps its status tooltip ("Status: <name>") so the two dot roles are distinguishable; document in tooltip.
- **Permissions.** The configured token must have write access to priority. If not, the provider error surfaces via the status footer; no special handling.
- **Theme compatibility.** The dot and popover must respect `theme-claudify` and `cyber-theme-enabled`. Reuse existing `.ticket-priority-dot` / `.ticket-status-light` CSS and the popover should use the same surface vars (`--panel-bg`, `--border-color`, `--text-secondary`) as the mention dropdown.

## Implementation Plan

### 1. Backend — Linear priority update

In `LinearSyncService.ts`, add `public async updateIssuePriority(issueId: string, priority: number): Promise<void>` mirroring `updateIssueState` (line 1095): validate `priority` is an integer `0–4`; GraphQL `issueUpdate(id, input: { priority })`; invalidate the issue's project cache the same way `updateIssueState` does. Verify the Linear API accepts `priority: 0` for "No priority" (it does — `0` is the documented no-priority value).

### 2. Backend — PlanningPanelProvider message handlers

Add two cases in `PlanningPanelProvider.ts` (mirror the tags handlers at 5092–5163):

- `case 'linearUpdateIssuePriority'`: validate `issueId` + `priority` (int 0–4); call `linear.updateIssuePriority(issueId, priority)`; post `{ type: 'linearPriorityUpdated', issueId, priority }` or `linearError`.
- `case 'clickupUpdateTaskPriority'`: validate `taskId` + `priority` (int 0–4); call `clickup.updateTask(taskId, { priority })`; post `{ type: 'clickupPriorityUpdated', taskId, priority }` or `clickupError`.

### 3. Frontend — priority color helpers (`planning.js`)

- Add `_linearPriorityColor(n)`: map `0→#95a2b3` (No priority, render hollow), `1→#eb5757` (Urgent), `2→#f2c94c` (High), `3→#5e6ad2` (Normal), `4→#95a2b3` (Low). Return the color.
- Add `_linearPriorityName(n)`: `['No priority','Urgent','High','Normal','Low'][n]`.
- Add `_clickUpPriorityColor(task)`: return `task.priority?.color` or a default per numeric value.
- Add `_clickUpPriorityName(task)`: return `task.priority?.priority` (the string) or a default.
- Add `_availableClickUpPriorities()`: scan the loaded `clickUpProjectTasks` for distinct `priority` objects keyed by numeric `orderindex`/`priority` value; return an ordered list `[{ value, name, color }]` including a `0`/"No priority" entry; fall back to the standard set if empty.

### 4. Frontend — card renderer changes (`planning.js`)

- In `_renderClickUpTicketCard` (~9186): replace the `statusLight` span with a priority dot:
  `<span class="ticket-priority-dot" style="background:${priorityColor}" data-priority-value="${task.priority?.orderindex || 0}" title="Priority: ${priorityName}"></span>`
  Add `cursor:pointer` via the existing `.ticket-priority-dot` rule (extend it in CSS).
- In `_renderLinearTicketCard` (~9213): same, using `_linearPriorityColor(issue.priority)` and `_linearPriorityName(issue.priority)`, with `data-priority-value="${issue.priority ?? 0}"`.
- **Do not touch** `_renderTicketStatusGroup` (9240) — its header dot stays a status dot.
- Keep the `.tickets-issue-meta.ticket-status-row` text row unchanged (status name still shown).

### 5. Frontend — inline popover (`planning.js` + `planning.html`)

- Add a single reusable popover element `<div id="ticket-priority-popover" style="display:none;">` to `planning.html`, structured like the mention dropdown (absolute, bordered, max-height, z-index).
- Add state: `let _openPriorityPopoverFor = null;` (holds `{ provider, ticketId, element }` or null).
- `openPriorityPopover(dotEl, provider, ticketId, currentValue)`: position relative to `dotEl.getBoundingClientRect()` within the sidebar container; populate the popover with the provider's priority options (Linear: fixed 5; ClickUp: `_availableClickUpPriorities()`); highlight `currentValue`; show; set `_openPriorityPopoverFor`; attach a one-shot outside-click/Escape/scroll handler to close.
- `closePriorityPopover()`: hide, null state, remove handlers.
- `selectPriority(value)`: read `{ provider, ticketId }` from `_openPriorityPopoverFor`; `closePriorityPopover()`; optimistic update of the in-memory `selectedClickUpIssue.task.priority` / `selectedLinearIssue.issue.priority` (and the matching item in `clickUpProjectTasks` / `linearProjectIssues`); re-render the affected card's dot; send `linearUpdateIssuePriority` or `clickupUpdateTaskPriority` message.
- Event delegation: in the existing ticket-list click handler, detect clicks on `.ticket-priority-dot` (check `e.target.classList.contains('ticket-priority-dot')`), `stopPropagation`, and call `openPriorityPopover`. Close any open popover first.
- Close any open popover at the start of `renderTicketsLinearList` / `renderTicketsClickUpList` (re-render safety).

### 6. Frontend — result handlers (`planning.js`)

- `case 'linearPriorityUpdated'`: find the issue in `linearProjectIssues` and `selectedLinearIssue`; the optimistic update already set the value; trigger the canonical refetch (mirror how `changeTicketStatusResult` refreshes) so the record stays authoritative. Show a brief success status.
- `case 'clickupPriorityUpdated'`: same for ClickUp.
- `case 'linearError'` / `case 'clickupError'` with `scope: 'task'`: if it corresponds to a pending priority change, revert the in-memory priority to the pre-change value, re-render the dot, and `showTicketsStatus(error, true)`.

### 7. CSS (`planning.html`)

- Extend `.ticket-priority-dot` (line 2834): add `cursor: pointer;` and a hover state (`box-shadow: 0 0 4px currentColor` or a subtle ring) so it's visibly interactive. Keep the existing size/position.
- Add `.ticket-priority-popover` styles mirroring `#tickets-mention-dropdown` (line 3787): absolute, `background: var(--panel-bg)`, `border: 1px solid var(--border-color)`, `border-radius: 4px`, `box-shadow`, `z-index: 100`, `max-height: 180px`, `overflow-y: auto`.
- Add `.ticket-priority-option` row styles (color swatch + name, hover highlight, selected indicator).
- Ensure `theme-claudify` and `cyber-theme-enabled` inherit correctly (they will, since vars are used).

### 8. Verification

- Manual (Linear): select a Linear ticket → click its dot → popover shows 5 options with current highlighted → pick "Urgent" → dot turns red, tooltip "Priority: Urgent" → reopen → "Urgent" highlighted → pick "No priority" → dot turns grey/hollow. Confirm status text row unchanged. Confirm status-group header dot still shows status color.
- Manual (ClickUp): same flow; confirm popover colors match the workspace's priority colors (derived from loaded tasks); confirm multi-card distinct colors render correctly.
- Error path: temporarily use an invalid token → click a priority → confirm dot reverts and error appears in status footer.
- Re-render safety: open the popover, trigger a list refresh (e.g. switch provider and back) → confirm no orphaned popover.
- Theme: toggle `theme-claudify` and `cyber-theme-enabled` → confirm dot + popover styling is consistent.
- Typecheck/build: run the repo's build/typecheck (confirm command from `package.json` during implementation) — ensures the new `updateIssuePriority` method and message-handler cases compile.

## Open Questions for Implementation

- Confirm the exact build/typecheck command (check `package.json` scripts during implementation).
- Confirm whether ClickUp's `updateTask({ priority: 0 })` reliably clears priority, or whether the API treats `0` as "leave unchanged" (verify against ClickUp API docs during step 2; if `0` doesn't clear, send the documented no-priority value).

## Acceptance Criteria

- [ ] Per-card dot color + tooltip reflect priority (not status) for both providers.
- [ ] Clicking the dot opens an inline popover with all priority options + "No priority", current highlighted.
- [ ] Selecting an option updates the provider and the dot (optimistic, then canonical refetch).
- [ ] Errors revert the dot and surface in the status footer; no uncaught exceptions.
- [ ] Status-group accordion header dots remain status-colored and unchanged.
- [ ] Status text row beneath the title still shows the status name.
- [ ] Popover closes on outside click / Escape / scroll / re-render; only one open at a time.
- [ ] Works under both `theme-claudify` and `cyber-theme-enabled`; build/typecheck passes.

**Stage Complete:** Created
