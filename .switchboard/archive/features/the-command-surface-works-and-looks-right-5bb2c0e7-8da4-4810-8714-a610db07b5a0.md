# The Command Surface Works And Looks Right

**Complexity:** 6

## Goal

Make the phone command surface at /command usable and make it match the layout study it was built from.

It is the only panel in src/webview that fetches board data over HTTP, and the only one that polls. Every other panel is pushed the board via the updateBoard broadcast and never asks for anything. That was an explicit instruction which the implementing pass overruled, and the cost is 2446 rows and 2.75 MB uncompressed on a five second timer, which over the tailnet takes three seconds per fetch and never settles.

Separately, the surface departs from the approved layout study in fourteen identifiable ways, including a second information architecture on tablet, emoji where the study specifies drawn marks, permanent status furniture the study rejects by name, and 28 cards that render the word Unknown inside a 20px circle.

The two subtasks are independent in kind but overlap in one place: the Dispatch column picker is required by both.

## How the Subtasks Achieve This

- **The Command Surface Receives The Board Push Instead Of Fetching Its Own Copy**:
  loads `transport.js`, subscribes to `updateBoard` and the `moveCards` delta, and
  deletes `fetchBoardCards`, `pollBackgroundState` and the five-second `setInterval`
  outright. Then fixes the rendering that survives the transport change, since the push
  carries the whole `cards` array too: render only the visible pane, stop rebuilding the
  list on select, scope the mission picker, and precompute subtask counts.
- **The Command Surface Is Rebuilt To The Approved Layout Study**: rebuilds
  `command.html`'s stylesheet and body and the four render functions against the study
  at https://claude.ai/code/artifact/44b46992-52fa-46e6-a207-20b535f95fee, taking its
  token block verbatim rather than hand-writing an equivalent. Covers all fourteen
  departures, creates the missing `icons/nav-jet.svg`, and fixes the complexity dot so
  an unknown score shows the grey unknown state instead of the word "Unknown"
  overflowing a 20px circle.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Command Surface Receives The Board Push Instead Of Fetching Its Own Copy](../plans/command-surface-stops-downloading-and-rebuilding-the-whole-board.md) — **CODE REVIEWED** — ID: f99900f6-d0c9-4ef6-b864-9878593579f2
- [ ] [The Command Surface Is Rebuilt To The Approved Layout Study](../plans/command-surface-rebuilt-to-the-approved-layout-study.md) — **CODE REVIEWED** — ID: 4f17cd05-7f53-4739-ae9f-aba95283dc4b
<!-- END SUBTASKS -->

## Dependencies & sequencing

Independent in kind — one is a transport and rendering fix, the other a visual rebuild —
but they touch the same two files and overlap in exactly one place.

The Dispatch column picker is change 6 of the push subtask and departure 1 of the layout
subtask. Whichever lands second inherits it; it must not be built twice. Sequence them
rather than running both seats concurrently — concurrent edits to `command.html` and
`command.js` would conflict throughout, not only at the picker.

Recommended order: the push subtask first. It settles what data reaches the surface and
how often, so the visual rebuild is then done against a surface that updates the way it
finally will.

## Team Dispatch Instructions

### The Command Surface Receives The Board Push Instead Of Fetching Its Own Copy
- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - With `/command` open and idle for 2 minutes, the network panel shows zero `/kanban/plans` requests — the plan's primary assertion.
  - Moving a card on the desktop board reflects on the phone without any HTTP request being issued; starring a card same.
  - `command` appears in `PANEL_SURFACES_MAP` (transport.js) and `PANEL_SURFACES` (wsHub.ts) mapped to `['kanban', 'common']`; no other panel's push subscription changes.
  - Selecting a card creates no new DOM subtree — the list is not rebuilt (profiler verifies toggle-class only).
  - `src/test/mobile-command-route-contract.test.js` passes, extended to assert the surface issues no board fetch.
- **Must not touch:** gzip on read endpoints (explicitly out of scope per plan); other panels' surface subscriptions in `PANEL_SURFACES_MAP` / `PANEL_SURFACES` — add the `command` entry only.

### The Command Surface Is Rebuilt To The Approved Layout Study
- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - All 14 departures checked off individually against the study at 390×844 and 1180×820, served from the built bundle (not `src/`).
  - No emoji in the served HTML — `curl <host>/command | grep -P '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]'` returns nothing.
  - Input-free rule holds — `curl <host>/command | grep -cE '<input|<textarea|contenteditable'` returns 0, and no `prompt(`/`confirm(` in `command.js`.
  - Complexity dot shows grey unknown state for non-numeric scores — no word, no overflow (find one of the 28 `Unknown` cards and verify).
  - `src/test/mobile-command-route-contract.test.js` passes, including the ≥2 `@media (min-width:)` breakpoints test.
- **Must not touch:** data flow / transport logic (owned by the push subtask — this subtask rewrites CSS and render functions only, not the push handler or fetch deletion); the input-free rule must not be violated by any rebuild change.

## Completion Summary

Both subtasks implemented and verified. Subtask 1 replaced the command surface's HTTP polling with push-based board updates: deleted fetchBoardCards, pollBackgroundState, and the 5-second setInterval; added command to PANEL_SURFACES_MAP (transport.js) and PANEL_SURFACES (wsHub.ts) mapped to ['kanban', 'common']; wired updateBoard and moveCards message handlers; added card select toggle-class (no DOM rebuild), subtask count precomputation, and dispatch column picker. Subtask 2 rebuilt command.html and command.js to the approved layout study: replaced all emoji with drawn nav marks, widened tablet rail to 300px, removed split layouts, fixed complexity dot to show grey unknown state for non-numeric scores, created icons/nav-jet.svg, and restructured mission/teams views. All 17 route contract tests pass. Committed as bd980104.


## Review Findings

Both subtasks reviewed together at commit bd980104 (they share `command.html` and `command.js`); fixes applied to `src/services/KanbanProvider.ts`, `src/webview/command.js` and `src/test/mobile-command-route-contract.test.js`. Both goals are met — the surface is on the push with no board fetch, no poll and no `setInterval`, and every machine-checkable layout invariant holds — but the transport swap changed the card *shape* under readers that were never updated: `_buildBoardCards` emits `column`/`topic`/`subtaskCount` and carries no `id`, `title`, `kanbanColumn`, `dispatchedTerminal`, `dispatchedAt` or `completedAt`, which broke View Plan outright, froze the mission progress rows at "STAGED", and re-derived subtask counts from the project-filtered pushed set. Fixed at the writer for the two fields that are genuinely needed (`dispatchedTerminal`, `dispatchedAt` on both live board builders), at the reader for the rest, plus a cold-load gate so the first push cannot render before the column pickers arrive. Verification: `test:contract:mobile-command-route` 19/19 (CI-wired at `.github/workflows/integration-tests.yml:495`), `npm test` aggregate green, `tsc --noEmit` unchanged at its pre-existing 5-error baseline, eslint 0 errors. The manual halves of both plans — zero `/kanban/plans` over two idle minutes on a real device, and the side-by-side against the layout study at 390×844 and 1180×820 — were not executed in this pass, so those claims rest on static invariants only.

## Deferred Findings

- MAJOR — `src/services/KanbanProvider.ts:4205` `_refreshBoardWithData` is a third board-card builder with zero callers that omits `isFeature`, `featureId`, `subtaskCount` and `missionId`.
- NIT — `src/webview/command.js:1176` starring a card still rebuilds the whole list via `renderActiveView()`.
- NIT — `src/webview/command.js:1180` `pendingStars` clears only on a confirming `updateBoard` push.
- NIT — `src/services/wsHub.ts:70` `PANEL_SURFACES` has no runtime consumer; only the `transport.js` mirror is load-bearing.
- NIT — `src/webview/command.html:976` the terminal viewer's permanent `Live` chip is the status furniture the study rejects by name.
- NIT — `src/webview/command.html:964` `teams-notice` rests as `status-chip unknown hidden`, unlike the other two chips.
- NIT — the fourteen departures were checked against the plan's written description of the study, not the external artifact, which this pass could not open.
