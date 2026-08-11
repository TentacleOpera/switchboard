# Show a subtask count on every Tickets sidebar card

## Goal

Render the number of subtasks a ticket has directly on its sidebar card, so a parent ticket is
identifiable at a glance without selecting it.

### Problem

The Tickets sidebar gives no indication that a ticket has children. A card shows a priority dot,
title, status + sync badge, assignees and an action row — nothing about subtasks. The only way to
discover that a ticket has subtasks today is to click it and wait for
`clickupLoadTaskDetails` / `linearLoadTaskDetails` to return, at which point
`_maybeEnterDrillDown` (`src/webview/tickets.js:3464`) fires and the sidebar changes underneath
you. Scanning a list for parents therefore costs one API round-trip and one view change per ticket.

### Root cause

The sidebar is file-backed, and the file lister deliberately throws parentage information away.
`listLocalTicketFiles` (`src/services/TicketsPanelProvider.ts:1981`) reads `parentId:` out of each
ticket's frontmatter and uses it **only** as a hide predicate:

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

The same discard happens on the filesystem-scan fallback path
(`_scanLocalTicketFiles`, `src/services/TicketsPanelProvider.ts:449`).

The `tickets[]` array pushed to the webview (`src/services/TicketsPanelProvider.ts:2106-2117`)
carries `id / title / status / filePath / lastSyncedAt / syncStatus / url / dateCreated /
assignees / priority` — and no child information. The webview's mapping arms
(`src/webview/tickets.js:7579` and `:7595`) can only pass along what they are given, so the card
renderers have nothing to draw.

**The data already exists in the loop that discards it.** Every child ticket is visited in the same
pass as its parent; it just needs to be tallied instead of dropped.

## Metadata

- **Complexity:** 4
- **Tags:** feature, ui, frontend, backend

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Tallying `parentId` into a `Map<string, number>` during a loop that already reads it.
- Adding one field to a message payload and to two webview mapping arms.
- Adding a `<span>` to two card templates plus a CSS rule.

**Complex / Risky**
- **The counting pass must complete before any ticket is pushed.** The current loop pushes parents
  as it goes, so a parent visited before its children would be pushed with a count of zero.
  The tally must be a separate first pass over the same `dbTickets` array.
- **The lister has two code paths.** The DB-backed path (`:2053-2119`) and the filesystem-scan
  fallback (`:2130-2144`, used when the DB path yields nothing). Wiring only the first leaves the
  count silently absent for anyone whose DB rows are missing — the exact situation where the
  fallback exists. `_scanLocalTicketFiles` currently does not emit `parentId` at all
  (`src/services/TicketsPanelProvider.ts:455`), so the fallback needs a small signature change.
- **Not every sidebar card comes from the file lister.** `clickUpProjectIssues` is also assigned
  wholesale from the remote list response (`src/webview/tickets.js:7071`,
  `linearProjectIssues` at `:7097`), and drill-down subtask cards come from the detail fetch
  (`_drillDownSubtasks`). Those objects carry no count, so the renderer must treat "no count" as
  "render nothing" and never as "0 subtasks".
- **The count is a count of *imported* subtasks**, not of remote subtasks. A parent with 5 remote
  children of which 2 have been imported locally shows 2. This plan accepts that and mitigates it
  by preferring the API-authoritative `detail.subtasks.length` whenever the ticket's detail cache
  has been populated — see the decided tradeoff below.

### Decided tradeoff

The badge prefers `detailCache.get(id).subtasks.length` when that entry exists and has
`detailsFetched === true`; otherwise it falls back to the file-derived count. Consequence: the
number can change after a ticket is selected for the first time, if some of its remote subtasks
were never imported. That is accepted — a corrected number beats a permanently wrong one, and it
keeps the badge consistent with what a drill-down would actually list. No hedging UI, no asterisk.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Ticket has zero subtasks | Render **no** badge. Do not render "0". |
| Count is `undefined` (remote-list card, drill-down subtask card) | Render no badge. `undefined` is "unknown", not "zero". |
| Subtask that itself has children (grandchildren) | Counted against its own parent only. Depth-1 count, no recursion — the drill-down list is also depth-1 (`detail.subtasks`), so the two agree. |
| Child's `parentId` points at a ticket not in this list (different ClickUp list, or parent never imported) | The tally entry has no matching parent row and is simply never read. Must not throw and must not create a phantom row. |
| Child hidden by the `scopeId` filter | Irrelevant — children are excluded by the `parentId` check at `:2098`, which runs **before** the scope check at `:2102`. Tally in the first pass, unconditionally, before either filter. |
| DB path returns rows but the file is missing on disk (`fs.existsSync` false, `:2064`) | No frontmatter can be read, so no `parentId` — contributes nothing to any tally. Correct. |
| Filesystem-scan fallback path | Must produce the same counts. Requires `_scanLocalTicketFiles` to expose `parentId`. |
| Drill-down parent card in the header (`_renderDrillDownHeader`, `:737`) | Renders via the same card renderer; it will show its count from the detail cache (which is guaranteed populated there). Acceptable and correct. |
| Sidebar re-render after `ticketSyncStatusesLoaded` (`src/webview/tickets.js:7538-7545`) | That arm rebuilds the arrays with a spread (`{...t, syncStatus}`), so `subtaskCount` is preserved. Verify — a field-by-field rebuild would drop it. |
| Panel scope guard | The count travels inside the existing `localTicketFilesListed` payload, which already goes through `this._scoped(...)` (`:2146`) and `_isForThisPanel` (`src/webview/tickets.js:7557`). No new scoping work. |

**Dependencies**
- `parentId:` frontmatter is written at import time by `_buildLinearImportPlanContent`
  (`src/services/TaskViewerProvider.ts:7312`) and `_buildClickUpImportPlanContent`
  (`src/services/TaskViewerProvider.ts:7586`). Accuracy of the count depends entirely on that key
  being present — tickets imported before that key shipped will under-count until re-fetched.
- `src/test/tickets-sidebar-list-scoping.test.js` asserts the current subtask/scope hiding
  behaviour. This plan must not change *which* tickets are listed — only add a field.
- No settings key, no persisted state, no new file format: **no migration required.**

**Glyph constraint:** this panel's font stack carries no symbol glyphs, so the badge must be ASCII
text or one of the existing `sb-icon` mask classes (e.g. `sb-icon-chevron-right`, already used at
`src/webview/tickets.js:719`). Do not use `▸`, `⤿`, `↳` or similar — they render as tofu.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — tally children in the DB-backed path

Inside `case 'listLocalTicketFiles'`, immediately before the existing
`for (const dbT of dbTickets)` loop (`:2053`), add a first pass that reads only `parentId`:

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

### 4. `src/webview/tickets.js` — resolve the count for a card

Add a helper beside the card renderers (near `_ticketSyncBadge`, ~`:585`):

```js
    // Subtask count for a sidebar card.
    //
    // Prefers the detail cache once it has been populated: that array is what a
    // drill-down actually lists, and it counts remote subtasks the user never
    // imported. Falls back to the file-derived count from listLocalTicketFiles.
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

    // Badge markup. Nothing renders for 0 or unknown — a "0 subtasks" chip on every
    // leaf ticket is noise, and unknown is not zero.
    // ASCII + an existing sb-icon mask class only: this panel's font stack has no
    // symbol glyphs, so a decorative arrow would render as tofu.
    function _ticketSubtaskBadge(provider, id, fileCount) {
        const n = _ticketSubtaskCount(provider, id, fileCount);
        if (!n) { return ''; }
        return `<span class="ticket-subtask-count" data-subtask-count-provider="${escapeAttr(provider)}" data-subtask-count-ticket-id="${escapeAttr(id)}" title="${n} subtask${n === 1 ? '' : 's'}"><span class="sb-icon sb-icon-sm sb-icon-chevron-right" aria-hidden="true"></span>${n}</span>`;
    }
```

### 5. `src/webview/tickets.js` — render the badge on both cards

`_renderClickUpTicketCard` (`:637`) — add to the status/meta row so it sits with the other chips:

```js
            <div class="tickets-issue-meta ticket-status-row" data-edit-status data-provider="clickup" data-ticket-id="${escapeAttr(task.id)}">${escapeHtml(task.status || 'Unknown')}${syncBadge}${_ticketSubtaskBadge('clickup', task.id, task.subtaskCount)}</div>
```

`_renderLinearTicketCard` (`:675`) — the equivalent line with `'linear'` and `issue.id`.

> The status row carries `data-edit-status` and opens the status-edit modal on click
> (`src/webview/tickets.js:5371`). Placing the badge there means the badge inherits that click.
> If that is undesirable, move the badge to its own `<div class="tickets-issue-meta">` row instead —
> decide during implementation by looking at the rendered card, not from the source.

### 6. `src/webview/tickets.html` — badge CSS

Add next to the sync-badge rules (search `ticket-sync-badge`):

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
        }
```

## Verification Plan

**Automated**
1. `npm test` — full suite green. `src/test/tickets-sidebar-list-scoping.test.js` in particular must
   pass **unchanged**: this plan adds a field, it must not change which tickets are listed.
   Stash-verify against HEAD first to separate pre-existing failures.
2. New test over `listLocalTicketFiles` with a fixture folder containing one parent plus three
   children (`parentId:` in frontmatter):
   - the response lists exactly 1 ticket,
   - that ticket's `subtaskCount === 3`,
   - a childless sibling's `subtaskCount === 0`.
3. Same fixture with the DB rows absent, forcing the scan fallback — identical assertions.
4. Fixture where a child's `parentId` names a ticket that is not present: no throw, no extra listed
   ticket, parentless ticket still `subtaskCount: 0`.
5. Fixture where a child is scoped to a different `listId` than its parent: the parent's count still
   includes it (the tally runs before both filters).

**Manual (installed VSIX — `dist/` is not used for testing)**
6. Tickets tab, ClickUp provider, a list containing at least one parent with imported subtasks.
   The parent card shows a count chip; tickets with no subtasks show no chip at all (verify no
   "0" chips anywhere).
7. Hover the chip — the tooltip reads "3 subtasks" / "1 subtask" with correct pluralisation.
8. Select the parent. After its details load, the chip reflects the API subtask count (and may
   increase if some children were never imported).
9. Confirm the chip is legible in both the default theme and with the cyber theme enabled, and that
   the icon renders as an icon — not as an empty box.
10. Repeat 6–9 with the Linear provider.
11. Convert a ticket into a subtask of another, then trigger a sidebar reload. The parent's count
    increases by one once the child's file carries `parentId:`.
