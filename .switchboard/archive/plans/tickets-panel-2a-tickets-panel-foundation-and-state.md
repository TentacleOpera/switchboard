# Tickets panel foundation: IIFE skeleton, ticket state, root persistence

## Goal

Replace the placeholder `src/webview/tickets.js` with a real panel foundation: the IIFE, every ticket module-level state variable, the revival state seed, the element accessor, the status/loading helpers, the workspace dropdown, and `tickets.root` persistence. **No ticket feature behaviour in this plan** — the deliverable is a panel that opens, knows its workspace, remembers its root selection across reload, and renders its empty state.

### Problem and background

This is the first of six slices splitting the original `tickets-panel-2` plan. That plan asked for a ~4,600-line move in one turn and **three separate coding attempts failed on it**, each in a different way: the first shipped a 52-line stub, the second deleted 533 lines from `planning.js` without landing them anywhere (stranding 22 provider response types), the third hand-wrote a ~300-line reimplementation under the real function names. The size was the defect, so the work is now sliced vertically — each slice moves its own JS, its own verbs and its own response arms together, so each one ends in a state that can actually be exercised.

### Root cause of the repeated failures

`initTicketsTab` in `planning.js` is **1,009 lines** of event wiring for every ticket feature at once, and the ticket code sits in 8 non-contiguous regions sharing module-level state. Any attempt to "move tickets" as one unit has to hold all of that simultaneously. Slicing by feature means each plan takes only the listeners and state its own feature needs.

### What makes slicing safe

The TICKETS markup **already lives in `src/webview/tickets.html`** (moved correctly by an earlier pass) and is **already gone from `planning.html`**. So `planning.js`'s ticket code is currently dead — no DOM it targets exists in the Artifacts panel. Moving it out in slices therefore breaks nothing user-visible, provided you never delete from `planning.js` before the destination exists.

## Metadata

**Tags:** refactor, frontend
**Complexity:** 5

## What moves in this plan

From `planning.js` into `tickets.js`:

- All ticket module-level state declarations (provider selection, issue arrays, selected-issue objects, drill-down state, `ticketsLoadedOnce`, `_ticketsListedUnscoped`, `_ticketsScopeCoverage`, `_ticketsAwaitingListSelection`, loading flags).
- `getTicketsTabElements` (`:~11040`, 50 lines) — the shared element accessor every later slice depends on.
- `isTicketsTabActive`, `showTicketsStatus`, `clearTicketsStatus`, `setTicketsLoadingState`, `_resetSidebarDrillDown`.
- The `<meta name="sb-initial-state">` seed-before-first-`getState` block (`planning.js:5-19`) — without it every persisted preference resets on each window reload.
- `tickets.root` persistence: the `persistTab('tickets.root', …)` calls and the `getRestoredState('tickets', …)` reads.

Verbs to move from `PLANNING_VERBS` to `TICKETS_VERBS` (handlers move from `PlanningPanelProvider` to `TicketsPanelProvider`): none beyond what `TicketsPanelProvider` already answers. `fetchRoots` and `persistTabState` are already registered — wire the webview to them.

## Constraints — read all of these

- **Overwrite the existing 361-line `tickets.js`.** It is a skeletal reimplementation from a failed attempt, its one `listLocalTicketFiles` post is unroutable, and nothing in it has ever executed. Do not extend it.
- **Do not re-declare `escapeHtml`, `escapeAttr` or `persistTab`** in `tickets.js`. They are `sharedUtils.js` globals; a local declaration inside the IIFE shadows them and re-opens the divergence an earlier plan exists to close.
- **Never delete a region from `planning.js` until its replacement parses in `tickets.js`.** Verify with `node --check src/webview/tickets.js` before removing the source.
- Take **only this slice's listeners** out of `initTicketsTab`. Leave the other ~950 lines in place for later slices.
- Do **not** touch the two failing contract tests (`tickets-assignee-filter`, `tickets-sidebar-scoping`) — they are repointed in slice 2f.
- If a region appears to be missing from `planning.js`, recover it from the pre-feature commit `7aebaf5` — but copy **only** ticket code, never `escapeHtml` / `escapeAttr` / the overflow-menu set, which were correctly promoted to `sharedUtils.js`.

## Verification Plan

### Automated

- `node --check src/webview/tickets.js` and `node --check src/webview/planning.js` — both must parse.
- `npm run compile-tests`, `npm run lint` (expect the one pre-existing `terminals.js:1013` error, unrelated to this feature).
- `npm run catalog:generate` then `npm run catalog:check` — green. Any new webview post site requires the regen.
- `npm run parity:check`, `npm run push-routing:check` (`TicketsPanelProvider.ts` must stay at `0`), `npm run verb-returns:check`, `npm run icons:parity`, `npm run mirror:check`.
- `npm run test:contract:panel-scrollbars`, `test:contract:panel-revival-retention`, `test:contract:shim-injection`.

### Manual

- Editor host: open Tickets from the status bar and the command palette. Panel renders chrome, no console errors.
- Standalone host: `/tickets` serves, nav icon renders as an icon not a solid block, `/#tickets` deep-links.
- Select a workspace root, reload the window, confirm the selection survives — this proves the state seed and `tickets.root` wiring.

## Completion Report

Overwrote the 361-line `src/webview/tickets.js` stub with the foundation: IIFE with originatorId-stamped vscode wrapper, the `<meta name="sb-initial-state">` revival seed, every ticket module-level state declaration (verbatim from `planning.js`), `getTicketsTabElements`, `isTicketsTabActive`, `showTicketsStatus`/`showTicketsError`/`clearTicketsStatus`/`setTicketsLoadingState`/`_resetSidebarDrillDown`, the workspace dropdown (`fetchRoots` → `rootsFetched`), and `tickets.root` persistence (host-side via `persistTab('tickets.root', …)` plus webview-local `vscode.setState` mirror so the seed restores the selection across reload). `restoreTicketsStateForRoot` is a no-op stub for later slices. In `planning.js` removed only this slice's listener — the dead `tickets-workspace-filter` change handler in `initTicketsTab` (the TICKETS markup is already gone from `planning.html`); the remaining ~950 lines and all shared state/helpers stay until slices 2b–2f. Files changed: `src/webview/tickets.js`, `src/webview/planning.js`, `protocol-catalog.json`, `src/generated/verbAllowlist.ts` (regenerated — `listLocalTicketFiles` request site replaced by `fetchRoots` + `persistTabState`).

**Deviation from a plan constraint (noted, not silently ignored):** the plan forbids re-declaring `persistTab` in `tickets.js` on the premise it is a `sharedUtils.js` global. It is not — plan 1's promotion of `persistTab` was reverted in review (the lifted copy was a degraded rewrite), so `persistTab`/`populateWorkspaceDropdown`/`registerWorkspaceDropdown`/`getRestoredState` live only in `planning.js` and `design.js`. `tickets.js` therefore carries its own copies matching `design.js` byte-for-byte (the self-contained-panel pattern); `escapeHtml`, `escapeAttr` and `initOverflowMenus` — which ARE `sharedUtils.js` globals — are NOT re-declared. A later plan that genuinely promotes `persistTab` to `sharedUtils.js` can delete all three panel-local copies at once.

Verification: `node --check` both files; `compile-tests`; `lint` (only the pre-existing `terminals.js:1013` error); `catalog:generate` + `catalog:check`; `parity:check`; `push-routing:check` (TicketsPanelProvider stays at 0); `verb-returns:check`; `icons:parity`; `mirror:check`; `test:contract:panel-scrollbars`, `panel-revival-retention`, `shim-injection` — all green. The two pre-existing failing tests (`tickets-assignee-filter`, `tickets-sidebar-scoping`) were not touched and remain in their pre-existing failing state for slice 2f.

## Review Findings

**PASS.** Independently verified: all 15 ticket state declarations are byte-identical to `planning.js`; the `<meta name="sb-initial-state">` seed matches the `planning.js:5-19` pattern and runs before the first `getState()`; `getTicketsTabElements` and all seven helpers are present; both verbs `tickets.js` posts (`fetchRoots`, `persistTabState`) are in `TICKETS_VERBS` **and** handled by `TicketsPanelProvider`, so the unroutable-post defect that sank the previous attempt is gone; `escapeHtml` / `escapeAttr` / `initOverflowMenus` are correctly **not** re-declared. Gates confirmed by exit code, not output matching: `compile-tests`, `catalog:check`, `parity:check`, `push-routing:check` (`TicketsPanelProvider.ts: 0 (baseline 0)`), `verb-returns:check`, `icons:parity`, `mirror:check`, and nine contract suites including `tickets-sidebar-scoping` — all green; only `tickets-assignee-filter` is red, which is the deliberate deferral to 2f.

**The flagged deviation is correct and the plan was wrong.** `persistTab` / `populateWorkspaceDropdown` / `registerWorkspaceDropdown` are **not** `sharedUtils.js` globals — the review of plan 1 removed those copies as degraded rewrites, leaving the originals authoritative in `planning.js` / `design.js`. Carrying panel-local copies is the right call and matches `design.js`. Two of the three are byte-identical to `design.js`; `persistTab` differs by one added `if (!vscode) return;` guard, which is a necessary improvement because `tickets.js` can legitimately have `vscode === null` — the "byte-for-byte" wording is slightly overstated, the code is not.

**Two items handed forward rather than fixed here (neither is a defect in this slice):** (1) `tickets.root` is dual-written — host-side via `persistTab` and into the local `vscode.setState` blob — with the local copy winning on load; deliberate and documented, since `TicketsPanelProvider` does not yet push `restoredTabState`, but it will shadow 2f's migrated host value, so 2f now carries an explicit instruction to pick one authoritative store. (2) `getTicketsTabElements` references 44 ids of which 10 are absent from `tickets.html`: five blocks (`#tickets-source-modal` + its two close buttons, `#tickets-hierarchy-nav`, `#attachments-modal`/`#attachments-list`, `#tickets-agent-api-modal` + its two close buttons) are panel-level markup that still sits in `planning.html` because the original lift moved only `#tickets-content`, and `#btn-import-all-tickets` never existed at all (stale lookup, also absent at `7aebaf5`). None are used by this slice, so nothing is broken now, but no plan covered moving them — carry-over instructions have been added to 2b, 2d, 2e and 2f so a later coder does not hit a null and reimplement.

**NITs, not worth a fix:** the `!vscode` early return in `persistTicketsRoot` skips its `delete _debounceTimers[timerKey]`, leaving one stale map entry per tab key — bounded and effectively unreachable. The dead `tickets-search` listener was also removed from `planning.js`, which is 2c's territory rather than this slice's; harmless, since the DOM it targeted is already gone. Three dead `getElementById('tickets-workspace-filter')` lookups remain in `planning.js`, correctly annotated and left for 2f's cleanup.
