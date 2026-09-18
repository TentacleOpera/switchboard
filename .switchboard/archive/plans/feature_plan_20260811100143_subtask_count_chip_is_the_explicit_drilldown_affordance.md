# Subtask-count chip on Tickets sidebar cards, and make it the only drill-down affordance

**Feature:** 25086852-6f83-406e-8f37-3edeaa1244b7

**Consolidated From:** `feature_plan_20260811100143_show_subtask_count_on_tickets_sidebar_cards.md`, `feature_plan_20260811100143_make_tickets_sidebar_drilldown_explicit_not_selection_driven.md`

## Goal

Render the number of subtasks a ticket has directly on its Tickets sidebar card, and make that chip
the **only** way to enter the subtask list. Selecting a ticket loads it into the detail pane and
does nothing else — the sidebar list stays exactly where it is.

These were authored as two plans. They are one: both add the same `.ticket-subtask-count` element
to the same two card renderers, both add the same CSS class to `tickets.html`, and each is broken
without the other (a chip nobody can click; a drill-down affordance with no count to display, and
therefore invisible until the ticket has already been selected — which is the discoverability hole
the explicit-drill-down change creates). One plan owns the element, its count source, and its click
behaviour.

### Problem

Two defects on the same surface:

**1. No parentage is visible.** A card shows a priority dot, title, status + sync badge, assignees
and an action row — nothing about subtasks. The only way to discover a ticket has children today is
to click it and wait for `clickupLoadTaskDetails` / `linearLoadTaskDetails` to return. Scanning a
list for parents costs one API round-trip and one view change per ticket.

**2. Selecting a parent silently replaces the sidebar.** When those details land,
`_maybeEnterDrillDown` (`src/webview/tickets.js:3464`) fires and swaps the grouped status list —
the thing being worked down — for that ticket's subtask list. The switch happens *asynchronously*,
a beat after the click, so the list moves out from under the cursor. Selecting a ticket to read it
is indistinguishable from asking to navigate into it.

### Root cause

**For the missing count:** the sidebar is file-backed, and the file lister deliberately throws
parentage away. `listLocalTicketFiles` (`src/services/TicketsPanelProvider.ts:1981`) reads
`parentId:` out of each ticket's frontmatter and uses it **only** as a hide predicate:

```ts
// src/services/TicketsPanelProvider.ts:2073
const pm = fm[1].match(/^parentId:\s*(.+)$/m);
if (pm) { parentId = pm[1].trim(); }
...
// src/services/TicketsPanelProvider.ts:2098
if (parentId) {
    hiddenBySubtask++;
    continue;          // <-- child is dropped; nothing is credited to the parent
}
```

The same discard happens on the filesystem-scan fallback (`_scanLocalTicketFiles`,
`src/services/TicketsPanelProvider.ts:449`). The `tickets[]` array pushed to the webview
(`:2106-2117`) carries `id / title / status / filePath / lastSyncedAt / syncStatus / url /
dateCreated / assignees / priority` — and no child information, so the card renderers have nothing
to draw. **The data already exists in the loop that discards it:** every child is visited in the
same pass as its parent; it just needs to be tallied instead of dropped.

**For the implicit drill-down:** the card-click handler treats *selection* as *navigation intent*.
In the delegated `#tickets-issues-container` listener (`src/webview/tickets.js:5464-5475`):

```js
            const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]');
            if (card) {
                const linearId = card.dataset.linearIssueId;
                const clickUpId = card.dataset.clickupTaskId;
                // Drill-down intent: only when clicking from the NORMAL list ...
                if (!_sidebarDrillDownParentId) {
                    _pendingDrillDownParentId = clickUpId || linearId || null;
                    _maybeEnterDrillDown(linearId ? 'linear' : 'clickup', linearId || clickUpId);
                }
```

Every card click arms `_pendingDrillDownParentId`. The click itself usually cannot act on it —
details are not loaded, so `_maybeEnterDrillDown` returns early at `:3467`
(`if (!detail || !detail.detailsFetched) return;`). The flag stays armed and the drill-down is
fired later by the detail-loaded arms (`:7476` Linear, `:7502` ClickUp) — hence the delay.

The mechanism is sound: `_pendingDrillDownParentId` is exactly the right "the user asked for this"
signal. The defect is that **one** of its four arming sites arms it without the user asking. The
other three are genuine intent and must be preserved:

| Site | Intent | Keep? |
| :--- | :--- | :--- |
| `src/webview/tickets.js:5472` — any card click | Implicit. **This is the bug.** | Remove |
| `:5330` / `:5344` — clicking an item in the detail pane's inline subtask nav | User opened a subtask; the sidebar should show its siblings | Keep |
| `:7947` — after `clickupTaskCreated` with a `_subtaskParent` | User just created a subtask under this parent | Keep |
| `:7977` — after `linearIssueCreated` with a `_subtaskParent` | Same | Keep |

## Metadata

- **Complexity:** 5
- **Tags:** feature, bugfix, ui, ux, frontend, backend

## Reconciled decisions (were contradictions between the two source plans)

These are decided here. Do not re-litigate them at implementation time.

1. **One element, one class.** A single `.ticket-subtask-count` chip. It is both the count display
   and the drill-down trigger. It carries `data-subtask-count-ticket-id`,
   `data-subtask-count-provider`, `role="button"` and `tabindex="0"`. One CSS block in
   `tickets.html` (the interactive variant with `cursor: pointer` and a hover/focus state) —
   the two source plans each declared a `.ticket-subtask-count` rule and they differed.

2. **Count source: file-derived, with the detail cache preferred once populated.** The
   drill-down-only source (detail cache alone) was rejected: it makes the chip invisible until the
   ticket has already been selected, which defeats the affordance it exists to provide. So
   `listLocalTicketFiles` supplies a file-derived count for every card, and
   `detailCache.get(id).subtasks.length` overrides it when `detailsFetched === true`. Consequence:
   the number can change after first selection if some remote children were never imported. That is
   accepted — a corrected number beats a permanently wrong one, and it keeps the chip consistent
   with what a drill-down would actually list. No hedging UI, no asterisk.

3. **Handler placement: the chip branch runs BEFORE the `[data-edit-status]` branch, and returns.**
   Both source plans put the chip on the status/meta row, and both deferred the handler-order
   question. Resolved by reading the handler: the `[data-edit-status]` branch at
   `src/webview/tickets.js:5374` calls `_selectTicketFromCard` and `showTicketStatusModal`, then
   `return`s. A chip nested in that row would therefore open the status-edit modal and never reach
   a lower branch. The chip branch must be registered **above** `:5374`. It must **not** fall
   through (fall-through was one source plan's design; it does not survive the status-row branch) —
   instead it performs the selection itself via `_selectTicketFromCard(provider, id)`, which
   already posts `linearLoadTaskDetails` / `clickupLoadTaskDetails` when the cache is cold
   (`src/webview/tickets.js:3101-3140`), then returns.

4. **Zero and unknown both render nothing.** `undefined` is "unknown" (remote-list cards,
   drill-down subtask cards), never "0 subtasks".

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Tallying `parentId` into a `Map<string, number>` during a loop that already reads it.
- Adding one field to a message payload and to two webview mapping arms.
- Adding a `<span>` to two card templates plus a CSS rule.
- Deleting the three-line drill-down arming block from the card-click handler.

**Complex / Risky**
- **The counting pass must complete before any ticket is pushed.** The current loop pushes parents
  as it goes, so a parent visited before its children would be pushed with a count of zero. The
  tally must be a separate first pass over the same `dbTickets` array.
- **The lister has two code paths.** The DB-backed path (`:2053-2119`) and the filesystem-scan
  fallback (`:2130-2144`, used when the DB path yields nothing). Wiring only the first leaves the
  count silently absent for anyone whose DB rows are missing — the exact situation the fallback
  exists for. `_scanLocalTicketFiles` does not emit `parentId` at all (`:455`), so the fallback
  needs a small signature change.
- **Not every sidebar card comes from the file lister.** `clickUpProjectIssues` is also assigned
  wholesale from the remote list response (`src/webview/tickets.js:7071`, `linearProjectIssues` at
  `:7097`), and drill-down subtask cards come from the detail fetch (`_drillDownSubtasks`). Those
  objects carry no count, so the renderer must treat "no count" as "render nothing".
- **`_maybeEnterDrillDown` must keep its guard.** It is still called from the detail-loaded arms at
  `:7476` / `:7502`, which fire on *every* detail load — including plain selections. Its
  `if (!id || _pendingDrillDownParentId !== id) return;` guard (`:3465`) is what stops those from
  drilling. Do not "simplify" it away while removing the caller; it becomes load-bearing.
- **Stale entry after exit.** `_resetSidebarDrillDown` (`:380`) clears `_pendingDrillDownParentId`.
  Clicking the chip, then "← Back" before the detail fetch returns, must not re-enter when the
  response lands. The reset clears the pending id and the `:3465` guard rejects it — confirm by
  test, not by reading.
- **Two cards can render the same ticket at once.** In drill-down the parent's card is re-rendered
  inside the header (`_renderDrillDownHeader`, `:737-751`) via the same renderer. Both copies get
  the chip; both must behave.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Ticket has zero subtasks | Render **no** chip. Do not render "0". |
| Count is `undefined` (remote-list card, drill-down subtask card) | Render no chip. `undefined` is "unknown", not "zero". |
| Subtask that itself has children | Counted against its own parent only. Depth-1, no recursion — the drill-down list is also depth-1 (`detail.subtasks`), so the two agree. |
| Child's `parentId` names a ticket not in this list | The tally entry is never read. Must not throw, must not create a phantom row. |
| Child hidden by the `scopeId` filter | Still counts. The `parentId` check at `:2098` runs before the scope check at `:2102`; tally in the first pass, unconditionally, before either filter. |
| DB path returns a row whose file is missing (`fs.existsSync` false, `:2064`) | No frontmatter, no `parentId`, contributes nothing. Correct. |
| Filesystem-scan fallback path | Must produce the same counts. Requires `_scanLocalTicketFiles` to expose `parentId`. |
| Sidebar re-render after `ticketSyncStatusesLoaded` (`:7538-7545`) | That arm rebuilds with a spread (`{...t, syncStatus}`), so `subtaskCount` survives. Verify — a field-by-field rebuild would drop it. |
| Panel scope guard | The count travels inside the existing `localTicketFilesListed` payload, already `this._scoped(...)` (`:2146`) / `_isForThisPanel` (`src/webview/tickets.js:7557`). No new scoping work. |
| Click a parent card body | Detail pane loads the parent. Sidebar unchanged — same scroll position, same status groups, same collapsed/expanded state. |
| Click a childless card | Unchanged from today (never drilled anyway). |
| Click the chip | Ticket is selected in the detail pane **and** the sidebar enters drill-down for it. The status-edit modal must NOT open. |
| Click the chip when details are not cached | Arms `_pendingDrillDownParentId`, `_selectTicketFromCard` fires the detail fetch, the detail-loaded arm completes the entry. No spinner or placeholder. |
| Click the chip, then "← Back" before the fetch returns | Must **not** re-enter when the response lands. |
| Click the chip twice rapidly | Idempotent — re-arms the same id; entry is a state assignment, not a toggle. |
| Click a card inside drill-down (a subtask card) | Selects that subtask; stays in drill-down. Falls out for free once nothing arms the flag on a card click. |
| Click the parent card in the drill-down header | Re-selects the parent, stays in drill-down. Same reasoning. |
| Chip click while already drilled into that ticket | No-op re-entry. Harmless. |
| Control-strip **+ Subtask** | Still drills into the parent afterwards (`:7947` / `:7977` untouched) — intended feedback that the subtask landed. |
| Detail-pane inline subtask nav | Still drills to show siblings (`:5330` / `:5344` untouched). |
| Status filter / search / provider switch / list change | All already call `_resetSidebarDrillDown` (`:916`, `:3644`, `:3685`, `:3896`, `:3959`, `:4319`, `:4876`, `:4899`, `:4908`). Unchanged. |

**Dependencies**
- `parentId:` frontmatter is written at import time by `_buildLinearImportPlanContent`
  (`src/services/TaskViewerProvider.ts:7312`) and `_buildClickUpImportPlanContent` (`:7586`).
  Count accuracy depends on that key. **It is also written on conversion by the sibling subtask
  "Convert-to-subtask must stamp `parentId` into the local ticket file"** — see sequencing below.
- `src/test/tickets-sidebar-list-scoping.test.js` asserts the current subtask/scope hiding
  behaviour. This plan adds a field; it must not change *which* tickets are listed.
- `_selectTicketFromCard` (`src/webview/tickets.js:3101`) — used as-is by the chip branch. It posts
  `readLocalTicketFile` plus the provider's detail-load message when the cache is cold.
- No settings key, no persisted state, no new file format: **no migration required.**

**Glyph constraint:** this panel's font stack carries no symbol glyphs. The chip must be ASCII text
plus an existing `sb-icon` mask class (e.g. `sb-icon-chevron-right`, already used at
`src/webview/tickets.js:719`). Do not use `▸`, `⤿`, `↳` — they render as tofu.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — tally children in the DB-backed path

Inside `case 'listLocalTicketFiles'`, immediately before the existing `for (const dbT of dbTickets)`
loop (`:2053`), add a first pass that reads only `parentId`:

```ts
                            // First pass: tally children per parent. Must complete before any
                            // ticket is pushed — the main loop emits parents as it walks, so a
                            // parent seen before its children would ship a count of zero.
                            // Runs before BOTH the subtask filter and the scope filter so an
                            // out-of-scope child still counts toward its parent.
                            const subtaskCounts = new Map<string, number>();
                            for (const dbT of dbTickets) {
                                if (dbT.sourceId !== provider) { continue; }
                                if (!fs.existsSync(dbT.filePath)) { continue; }
                                try {
                                    const content = fs.readFileSync(dbT.filePath, 'utf8');
                                    const fm = content.match(/^---\n([\s\S]*?)\n---/);
                                    if (!fm) { continue; }
                                    const pm = fm[1].match(/^parentId:\s*(.+)$/m);
                                    if (!pm) { continue; }
                                    const pid = pm[1].trim();
                                    if (pid) { subtaskCounts.set(pid, (subtaskCounts.get(pid) || 0) + 1); }
                                } catch { /* unreadable file contributes nothing */ }
                            }
```

> The main loop re-reads each file a few lines later. If profiling on a large tickets folder shows
> the double read matters, hoist a single `Map<filePath, frontmatterBlock>` and have both passes
> read from it. Do not restructure speculatively.

Then extend the push at `:2106-2117`:

```ts
                                    tickets.push({
                                        id: dbT.remoteDocId || dbT.slugPrefix.replace(`${provider}_`, ''),
                                        title: dbT.docName,
                                        status: clickStatus || kanbanColumn || '',
                                        filePath: dbT.filePath,
                                        lastSyncedAt: dbT.lastSyncedAt,
                                        syncStatus,
                                        url: dbT.url || '',
                                        dateCreated,
                                        assignees,
                                        priority,
                                        // Locally-imported children only. 0 is meaningful ("no
                                        // subtasks"); the webview renders nothing for 0.
                                        subtaskCount: subtaskCounts.get(
                                            dbT.remoteDocId || dbT.slugPrefix.replace(`${provider}_`, '')
                                        ) || 0
                                    });
```

> Confirm the tally key matches the id form actually written into children's `parentId:`
> frontmatter (the raw remote id). If `remoteDocId` and the slug-derived id can diverge for a
> provider, tally under both and read whichever is non-zero.

### 2. `src/services/TicketsPanelProvider.ts` — expose `parentId` from the scan fallback

In `_scanLocalTicketFiles` (`:405`), include `parentId` in the emitted object (`:455`):

```ts
                out.push({ id, title, status: kanbanColumn || '', filePath: fullPath, url: '', dateCreated, assignees, priority, parentId });
```

The value is already parsed at `:431`. This is additive — `skipSubtasks` still filters at `:449`,
so the listed set is unchanged.

Then, in the fallback block (`:2130-2144`), scan once **without** `skipSubtasks` to build the tally,
and once with it to build the list:

```ts
                if (tickets.length === 0) {
                    // Unfiltered scan first, purely to tally children per parent — the
                    // filtered scan below drops them before they can be counted.
                    const allForCounting: any[] = [];
                    for (const dir of ticketDirs) {
                        this._scanLocalTicketFiles(dir, provider, allForCounting);
                    }
                    const fallbackCounts = new Map<string, number>();
                    for (const t of allForCounting) {
                        if (t.parentId) { fallbackCounts.set(t.parentId, (fallbackCounts.get(t.parentId) || 0) + 1); }
                    }
                    for (const dir of ticketDirs) {
                        this._scanLocalTicketFiles(dir, provider, tickets, { scopeId, skipSubtasks: true });
                    }
                    for (const t of tickets) { t.subtaskCount = fallbackCounts.get(t.id) || 0; }
                    // ... existing scope-coverage probe unchanged ...
                }
```

### 3. `src/webview/tickets.js` — carry the field through both mapping arms

In `case 'localTicketFilesListed'`, ClickUp arm (`:7579`) — add to the mapped object:

```js
                        priority: t.priority || null,
                        subtaskCount: t.subtaskCount
```

Linear arm (`:7595`) — same addition alongside `dateCreated`.

### 4. `src/webview/tickets.js` — the chip (count + trigger in one element)

Add beside the card renderers (near `_ticketSyncBadge`, ~`:585`):

```js
    // Subtask count for a sidebar card.
    //
    // Prefers the detail cache once populated: that array is what a drill-down
    // actually lists, and it counts remote subtasks the user never imported.
    // Falls back to the file-derived count from listLocalTicketFiles, which is
    // what makes the chip visible BEFORE the ticket has ever been selected —
    // the whole point of the affordance.
    //
    // Returns undefined when nothing is known — remote-list cards and drill-down
    // subtask cards carry no count, and "unknown" must not render as "0".
    function _ticketSubtaskCount(provider, id, fileCount) {
        const cached = provider === 'linear' ? linearIssueDetailCache.get(id) : clickUpTaskDetailCache.get(id);
        if (cached && cached.detailsFetched && Array.isArray(cached.subtasks)) {
            return cached.subtasks.length;
        }
        return typeof fileCount === 'number' ? fileCount : undefined;
    }

    // The chip is BOTH the count display and the only drill-down affordance.
    // Nothing renders for 0 or unknown — a "0 subtasks" chip on every leaf ticket
    // is noise, unknown is not zero, and a chip that does nothing when clicked is
    // worse than no chip.
    // ASCII + an existing sb-icon mask class only: this panel's font stack has no
    // symbol glyphs, so a decorative arrow would render as tofu.
    function _ticketSubtaskChip(provider, id, fileCount) {
        const n = _ticketSubtaskCount(provider, id, fileCount);
        if (!n) { return ''; }
        return `<span class="ticket-subtask-count" role="button" tabindex="0" data-subtask-count-provider="${escapeAttr(provider)}" data-subtask-count-ticket-id="${escapeAttr(id)}" title="Show ${n} subtask${n === 1 ? '' : 's'}"><span class="sb-icon sb-icon-sm sb-icon-chevron-right" aria-hidden="true"></span>${n}</span>`;
    }
```

### 5. `src/webview/tickets.js` — render the chip on both cards

`_renderClickUpTicketCard` (`:641`):

```js
            <div class="tickets-issue-meta ticket-status-row" data-edit-status data-provider="clickup" data-ticket-id="${escapeAttr(task.id)}">${escapeHtml(task.status || 'Unknown')}${syncBadge}${_ticketSubtaskChip('clickup', task.id, task.subtaskCount)}</div>
```

`_renderLinearTicketCard` (`:675`) — the equivalent line with `'linear'`, `issue.id`,
`issue.subtaskCount`.

The chip sits inside the `data-edit-status` row. That is safe **only** because step 7 registers the
chip branch above the status-row branch — see reconciled decision 3.

### 6. `src/webview/tickets.js` — stop arming drill-down on card selection

In the delegated `#tickets-issues-container` listener, replace the block at `:5464-5475`:

```js
            const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]');
            if (card) {
                const linearId = card.dataset.linearIssueId;
                const clickUpId = card.dataset.clickupTaskId;
                // Selecting a ticket loads it into the detail pane and NOTHING else.
                // Drill-down is entered only by an explicit act — the subtask-count
                // chip handled above, the inline subtask nav, or creating a subtask.
                // Arming it here made every click on a parent silently replace the list
                // the user was working down, a beat after the click, once details landed.
```

…then leave the existing `if (linearId) { ... } else if (clickUpId) { ... }` cache-or-fetch bodies
exactly as they are.

**Do not touch `_maybeEnterDrillDown`.** Its `_pendingDrillDownParentId !== id` guard (`:3465`) is
now the sole thing preventing the detail-loaded arms at `:7476` / `:7502` from drilling on ordinary
selections.

### 7. `src/webview/tickets.js` — arm drill-down from the chip

Add a branch in the same container listener, placed **above** the `[data-edit-status]` branch at
`:5374` (which selects the ticket, opens the status modal and `return`s — a chip nested in that row
would otherwise be swallowed by it):

```js
            // Explicit drill-down request: the subtask-count chip on a card. This is
            // the ONLY card-level path into the subtask list.
            //
            // Registered above the [data-edit-status] branch because the chip lives
            // inside that row and that branch returns; and it does the selection
            // itself rather than falling through, so the status-edit modal never
            // opens. _selectTicketFromCard already posts the provider's detail-load
            // message when the cache is cold, which is what the pending entry waits on.
            const subtaskChip = e.target.closest('[data-subtask-count-ticket-id]');
            if (subtaskChip) {
                e.stopPropagation();
                const chipId = subtaskChip.dataset.subtaskCountTicketId;
                const chipProvider = subtaskChip.dataset.subtaskCountProvider;
                if (chipId) {
                    _resetSidebarDrillDown();
                    _pendingDrillDownParentId = chipId;
                    _selectTicketFromCard(chipProvider, chipId);
                    // Enters synchronously if details are already cached; otherwise the
                    // detail-loaded arm completes the entry when the response lands.
                    _maybeEnterDrillDown(chipProvider, chipId);
                }
                return;
            }
```

Because the chip is `role="button" tabindex="0"`, add a keydown handler on the same container that
forwards Enter/Space on `[data-subtask-count-ticket-id]` to the same logic (or drop the role and
tabindex — do not ship a focusable element that does nothing).

### 8. `src/webview/tickets.html` — chip CSS

Add next to the sync-badge rules (search `ticket-sync-badge`, `:3056`):

```css
        .ticket-subtask-count {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            margin-left: 6px;
            padding: 0 5px;
            height: 15px;
            border-radius: 7px;
            border: 1px solid var(--border-color);
            background: var(--panel-bg2, #1a1a2e);
            color: var(--text-secondary);
            font-size: 9px;
            font-weight: 600;
            line-height: 1;
            vertical-align: middle;
            cursor: pointer;
        }

        .ticket-subtask-count:hover,
        .ticket-subtask-count:focus-visible {
            border-color: var(--accent-teal);
            color: var(--accent-teal);
        }
```

### 9. Comment maintenance

Update the now-inaccurate comment on `_renderDrillDownHeader` (`src/webview/tickets.js:733-736`),
which states that clicking the parent card "re-selects the parent WITHOUT leaving drill-down (the
card-click handler skips drill-down entry once `_sidebarDrillDownParentId` is set)". After this
change no card click ever enters drill-down, so the reason is different — say that instead.

## Verification Plan

Compilation and automated test execution are out of scope for this planning pass; the automated
items below are the contract for whoever implements it.

**Automated**
1. `src/test/tickets-sidebar-list-scoping.test.js` must pass **unchanged** — this plan adds a field,
   it must not change which tickets are listed. Stash-verify against HEAD first to separate
   pre-existing failures.
2. New test over `listLocalTicketFiles` with a fixture folder containing one parent plus three
   children (`parentId:` in frontmatter): the response lists exactly 1 ticket, that ticket's
   `subtaskCount === 3`, a childless sibling's `subtaskCount === 0`.
3. Same fixture with the DB rows absent, forcing the scan fallback — identical assertions.
4. Fixture where a child's `parentId` names an absent ticket: no throw, no extra listed ticket.
5. Fixture where a child is scoped to a different `listId` than its parent: the parent's count still
   includes it (the tally runs before both filters).
6. New test: card click on a ticket whose detail cache is populated with 3 subtasks →
   `_sidebarDrillDownParentId` stays `null` and the sidebar still contains the top-level
   status-group headers.
7. New test: click on `[data-subtask-count-ticket-id]` for the same ticket → drill-down activates,
   the sidebar renders the subtask cards plus the "← Back to all tickets" header, and the
   status-edit modal did **not** open.
8. New test (stale-entry guard): click the chip with details not cached, then call
   `_resetSidebarDrillDown()`, then deliver `clickupTaskDetailsLoaded` → drill-down does **not**
   activate.
9. New test (preserved paths): the `clickupTaskCreated` arm with `_subtaskParent` set still drills
   into the parent; a `.subtask-nav-item` click still drills to siblings.

**Manual (installed VSIX — `dist/` is not used for testing)**
10. Tickets tab, ClickUp provider, a list containing at least one parent with imported subtasks. The
    parent card shows a count chip; tickets with no subtasks show no chip at all (verify no "0"
    chips anywhere). Hover — the tooltip reads "Show 3 subtasks" / "Show 1 subtask".
11. Scroll partway down and collapse one status group. Click a parent card body: the detail pane
    loads the parent, the sidebar is unchanged — same scroll position, same collapsed group. Wait
    3 seconds after the detail loads and confirm it *still* has not changed (the old bug was
    delayed, so an immediate check alone would not catch a regression).
12. After that selection, the chip reflects the API subtask count (it may increase if some children
    were never imported).
13. Click the chip → the sidebar shows the subtask list with the parent card in the header, and the
    status-edit modal does not open. "← Back to all tickets" returns to the full list.
14. Click the chip, then "← Back" immediately, before the detail fetch returns. The sidebar must
    stay on the full list and must not flip into drill-down a moment later.
15. Inside drill-down, click a subtask card → it is selected; the sidebar stays on the sibling list.
16. Control-strip **+ Subtask** on a parent → after creation, the sidebar drills into that parent.
17. Detail-pane inline subtask nav → clicking an item drills to the sibling list.
18. Tab to the chip and press Enter/Space — keyboard activation must drill down.
19. Confirm the chip is legible in the default theme and with the cyber theme enabled, and that the
    icon renders as an icon, not an empty box.
20. Repeat 10–19 with the Linear provider.
21. Convert a ticket into a subtask of another, then trigger a sidebar reload. The parent's count
    increases by one once the child's file carries `parentId:`.

## Review Findings

Implementation matches the plan on every reconciled decision: the tally is a genuine first pass that completes before the emit loop and runs ahead of both the subtask and scope filters, the scan fallback tallies from an unfiltered scan, both webview mapping arms carry `subtaskCount`, the chip branch is registered above `[data-edit-status]`, the catch-all card branch no longer arms `_pendingDrillDownParentId`, and `_maybeEnterDrillDown`'s now load-bearing guard is intact — as are the three legitimate arming sites (`:5344`, `:5358`, and the `_subtaskParent` arms at `:8000`/`:8030`). The tally key was verified rather than assumed: `remoteDocId` is the raw remote id registered by `TaskViewerProvider.ts:22155`, which is the same id form written into children's `parentId:` frontmatter at `:7384`/`:7658`, so parents and children agree. One MAJOR finding — none of the plan's nine automated items shipped — was fixed by adding eight contract assertions to `tickets-sidebar-list-scoping.test.js` and a behavioural scan-fallback test to `verb-engine-tickets-headless.test.js`, both files already invoked by CI so nothing lands defined-but-unwired. Remaining risks are cosmetic: the chip's `e.stopPropagation()` leaves an open priority popover or control-strip menu open (consistent with the existing priority-dot branch), the keydown handler duplicates the click branch verbatim, and `clickupProjectLoaded`/`linearProjectLoaded` reassign the issue arrays without `subtaskCount` so chips blank until the trailing `loadLocalTicketFiles()` lands. Verified: `npm run compile-tests` clean, `node --check src/webview/tickets.js` clean, all 8 CI-wired tickets suites green.
