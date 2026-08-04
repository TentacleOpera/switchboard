# Tickets panel: list rendering, local file load and the sync-status badges

## Goal

Move the ticket **list** surface into the Tickets panel: both provider list renderers, `loadLocalTicketFiles`, the scope-coverage and empty-state copy, the file watcher, and the sync-status badges. After this slice the Tickets panel actually shows tickets — the first slice with a visible payoff.

### Problem and background

Third of six slices splitting the original `tickets-panel-2` plan, which asked for a ~4,600-line move in one turn and failed three times. See `tickets-panel-2a-tickets-panel-foundation-and-state.md` for the history.

This slice depends on 2b: the list scopes itself by ClickUp list id or Linear project name, and the `unscopedPlaceholder` path exists precisely to distinguish "nothing selected yet" from "this list is empty".

### Root cause context

`initTicketsTab` in `planning.js` is 1,009 lines wiring every ticket feature at once. Take only the list, search and filter listeners.

### What makes slicing safe

TICKETS markup already lives in `tickets.html` and is gone from `planning.html`, so `planning.js`'s ticket code is dead today. Slice-by-slice moves break nothing visible provided nothing is deleted before its destination exists.

## Metadata

**Tags:** refactor, frontend
**Complexity:** 6

## What moves in this plan

JS from `planning.js` into `tickets.js` — take the **real** bodies, not summaries. Current sizes are the acceptance signal:

| Function | Lines in `planning.js` |
|---|---|
| `renderTicketsTab` | 9 |
| `renderTicketsClickUpPanel` | 67 |
| `renderTicketsClickUpList` | 59 |
| `renderTicketsLinearPanel` | 34 |
| `renderTicketsLinearList` | 87 |
| `loadLocalTicketFiles` | 42 |
| `restoreTicketsStateForRoot` / `restoreTicketsState` | — |
| `_ticketsEmptyStateCopy` | — |
| `_requestTicketSyncStatuses` | 13 |

A prior attempt reimplemented `renderTicketsClickUpList` in 12 lines and `renderTicketsLinearList` in 12 — losing hierarchy, subtask rollup, sync badges and filters. If your `tickets.js` copy is materially shorter than the table above, you have rewritten rather than moved.

Verbs to move from `PLANNING_VERBS` to `TICKETS_VERBS`, handlers from `PlanningPanelProvider` to `TicketsPanelProvider`:

`listLocalTicketFiles`, `readLocalTicketFile`, `saveLocalTicketFile`, `setupTicketsWatcher`, `refreshTicketsDelta`, `getTicketSyncStatuses`, `ticketsRootChanged`, `ticketsDefaultRoot`.

Response arms to move into `tickets.js`: `localTicketFilesListed`, `localTicketFileRead`, `ticketFileChanged`, `ticketSyncStatusesLoaded`. All four are present in `planning.js` — two of them also exist as thin reimplementations in the current `tickets.js`; **replace those with the `planning.js` originals.**

Preserve the behaviour `tickets-sidebar-list-scoping` encodes: the ClickUp no-list synthetic `unscopedPlaceholder` early return, the `ticketsLoadedOnce` latch guarded by `!msg.unscopedPlaceholder`, the `_ticketsListedUnscoped` re-issue in `restoreTicketsStateForRoot` (which must **not** assign `ticketsLoadedOnce`), `_ticketsScopeCoverage` capture, and both re-key empty-state strings (the ClickUp "list id" wording and the Linear "project name" wording).

### Verb migration is not just the allowlist — three things move together

Slice 2b moved 20 verbs and got two of the three right. Every verb you move must carry **all three** of:

1. **The handler** — out of `PlanningPanelProvider`, into `TicketsPanelProvider`.
2. **The allowlist entry** — out of `PLANNING_VERBS`, into `TICKETS_VERBS`, via `npm run catalog:generate`.
3. **The payload schema** — out of `PLANNING_VERB_SCHEMAS`, into `TICKETS_VERB_SCHEMAS` in `src/services/verbSchemas.ts`. **2b missed this for all 9 of its verbs that had schemas**, which silently disabled payload validation on the remote-reachable `/tickets/verb/*` rail, because `validateVerbPayload('tickets', …)` treats "no declared shape" as a pass. Review moved them; do not repeat the omission.

**Do not post a verb before its handler arrives.** 2b left five posts in `tickets.js` unroutable — `setupTicketsWatcher` and `ticketsDefaultRoot` (from `restoreTicketsState`, both fire on panel init) and `refreshTicketsDelta` (from `initTicketsTab`) belong to slice 2c; `moveTicket` and `fetchMoveTargets` (from `_fetchMoveTargets` / the move modal) belong to slice 2d. Each is currently rejected with `Unknown Tickets verb`. Whichever slice owns the verb must land its handler, its allowlist entry and its schema. Note `ticketsDefaultRoot`'s handler (`PlanningPanelProvider:2610`, 38 lines) reads `this._kanbanProvider?.getCurrentWorkspaceRoot()` as a fallback and `TicketsPanelProvider` has no `_kanbanProvider` — either add the seam or consciously drop that fallback and say so.

**Migrate the contract assertions you strand.** Moving verbs out of Planning leaves `src/test/verb-engine-planning-headless.test.js` asserting Planning behaviour for verbs it no longer owns — 2b stranded five (`listTicketsFolders`, `browseTicketsFolder`, `linearLoadProject`, `clickupLoadSpaces`, and the `removeTicketsFolder` schema-rejection case), which is why that CI-wired suite is red. Stand up a `verb-engine-tickets` headless suite and move each stranded assertion into it as you move its verb, preserving the assertion and changing only which provider is asked. Do not delete assertions to get green.

## Review Findings

**PASS — best slice so far, three fixes applied in review.** This is the first slice where the code was genuinely *moved*: every function matches its `planning.js` size exactly (`renderTicketsClickUpPanel` 67, `renderTicketsClickUpList` 59, `renderTicketsLinearPanel` 34, `renderTicketsLinearList` 87, `loadLocalTicketFiles` 42, `_requestTicketSyncStatuses` 13), with no rewriting. All 8 verbs carry handler + allowlist entry + **schema** and are gone from both `PLANNING_VERBS` and `PlanningPanelProvider` — the three-things rule was followed. All four response arms landed and the two thin 2a reimplementations were replaced. All nine behaviours the sidebar-scoping contract encodes are preserved (synthetic `unscopedPlaceholder` early return, the `ticketsLoadedOnce` latch guarded by `!unscopedPlaceholder`, the `_ticketsListedUnscoped` re-issue that does *not* assign `ticketsLoadedOnce`, `_ticketsScopeCoverage` capture, the awaiting-list marker, and both re-key empty-state strings). Volume moved: `tickets.js` 361 → 3,043, `PlanningPanelProvider` 9,988 → 8,403, `planning.js` 12,787 → 11,604. Both files parse; `push-routing` holds at `0`.

**Fixed in review — the verb-return ratchet was not updated.** Tickets' actual break count rose to 49 against a ceiling of 29, so `verb-returns:check` failed outright. Planning fell 205 → 185, so this was a clean 1:1 transfer (20 out, 20 in, no new debt); both ceilings were updated to their actuals.

**Fixed in review — five contract assertions were stranded again.** Moving `importTicketSubtasks`, `fetchMoveTargets`, `moveTicket`, `changeTicketStatus` and `deleteTicketConfirmed` left `verb-engine-planning` asserting Planning behaviour for verbs it no longer owns (28 passed / 5 failed). All five were migrated verbatim into `verb-engine-tickets-headless.test.js` — bodies unchanged, only the provider under test and the provider name in each expected error string — and removed from the Planning suite with an accurate comment. Both suites are now green: Planning 28/0, Tickets 15/0. This is the same omission as 2b; the mechanism now exists, so later slices have no excuse.

**Fixed in review — the catalog was two request sites behind.** `src/webview/tickets.js` carried 44 request sites against 42 in the checked-in `protocol-catalog.json`, so `catalog:check` was red. Regenerated. Run `npm run catalog:generate` as the *last* step after touching `tickets.js`, not before.

**MAJOR (not fixed — later slice owns it) — `importAllTickets` is posted but unroutable.** `tickets.js` posts it, the handler is still in `PlanningPanelProvider` and it is still in `PLANNING_VERBS`. Unlike 2b's deferred `moveTicket`/`fetchMoveTargets` (which needed a selected ticket), the import-all control `#tickets-import-all-kanban` exists in `tickets.html` and is wired at three sites in `tickets.js`, so it is **clickable now and silently does nothing**. Either move the verb early or disable the control until slice 2f.

**Two notes for later slices.** (1) `planning.js` still holds full-size duplicates of `renderTicketsClickUpPanel`, `renderTicketsClickUpList`, `renderTicketsLinearPanel`, `renderTicketsLinearList`, `_ticketsEmptyStateCopy`, `loadLocalTicketFiles` and `_requestTicketSyncStatuses` — correctly, because Planning's not-yet-moved detail/comment/attachment code still calls them 7–10 times each; 2f removes the callers and then these. Do not edit the `planning.js` copies in the meantime. (2) `tickets.js` uses `message.` where `planning.js` used `msg.`, so `tickets-sidebar-list-scoping.test.js` will need its regexes adjusted, not just its file targets, when 2f repoints it.

## Constraints — read all of these

- **Do not re-declare `escapeHtml`, `escapeAttr` or `persistTab`** in `tickets.js`.
- **Never delete a region from `planning.js` until its replacement parses in `tickets.js`.**
- Take **only** the list/search/filter listeners out of `initTicketsTab`.
- Do **not** touch `tickets-assignee-filter` or `tickets-sidebar-scoping` yet — they are repointed in 2f. `tickets-sidebar-scoping` currently reads `planning.js`, so it will go red as you move these regions; that is expected and is handled in 2f, not here.
- Recovery source for anything missing is `7aebaf5`, ticket code only — never its `escapeHtml` / `escapeAttr` / overflow-menu copies.

## Verification Plan

### Automated

- `node --check` on both webview files.
- `npm run compile-tests`, `npm run lint` (expect only the pre-existing `terminals.js:1013` error).
- `npm run catalog:generate` then `npm run catalog:check` — green; diff the allowlist and confirm the eight verbs moved sets.
- `npm run parity:check`, `npm run push-routing:check` (`TicketsPanelProvider.ts` at `0`), `npm run verb-returns:check`, `npm run icons:parity`, `npm run mirror:check`.
- `npm run test:contract:tickets-subtasks` must stay green.

### Manual

- Editor host, Tickets panel: with a ClickUp list selected, confirm tickets load and render with sync badges. Deselect the list and confirm the empty state reads "Select a space and list to see its tickets." rather than "No tasks found."
- Repeat for Linear with a project selected and deselected.
- Edit a ticket file on disk and confirm the watcher updates the list live.
- Standalone host: repeat at `/tickets`. Then mutate a ticket from outside the panel and confirm the live update arrives; inspect the WebSocket URL and confirm it carries `surfaces=tickets,common`. A reduction to `common` alone means the `wsHub.SURFACES` entry is missing.
