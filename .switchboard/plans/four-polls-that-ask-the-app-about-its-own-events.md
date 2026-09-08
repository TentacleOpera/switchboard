# Four Client Polls, Three of Which Ask the Application About Its Own Events

## Goal

Retire the browser-side polls that exist for state this application itself originates, and move the one poll watching genuinely external state to the server that is already watching files. Polling stays only where something outside the app changes and no event source exists.

### Problem analysis

**The rule this plan applies:** *poll for state that changes outside the application; use events for state the application creates.* Every poll below is measured against that, and three fail it.

Sibling to *The Fleet Push Died With the TS Gateway* (`198dba7a`), which covers `terminals.js`'s 5-second fleet poll in detail — including the measurement that its 20-second symptom is four poll ticks, and the finding that the only `terminalsChanged` emitter is retired code. This card covers the other four timers found in the same sweep.

> **Superseded:** The original table's line numbers for `terminals.js` were stale by ~360 lines (the file has grown), and two of its verdicts were wrong on inspection (see below). Line numbers corrected; the two wrong verdicts (`shell.js` fleet tab, `terminals.js` kanban) are superseded in their rows and again in Proposed Changes.
> **Reason:** A line-number drift audit against the current tree showed `startFleetPoll` at `terminals.js:7992` (not `:8406`), `startKanbanPoll`/`pollKanbanPanes` at `:7982`/`:8035` (not `:8396`), and `startWorkingSilenceSweep` at `:2460` (not `:2874`). More importantly, reading the actual code disproved the "the push works" claim for two of the polls.
> **Replaced with:** the corrected table below, where each verdict is re-derived from the live code rather than the original sweep's notes.

| Timer | Interval | Watches | Verdict |
| :--- | :--- | :--- | :--- |
| `terminals.js:7992` fleet | 5 s | terminal fleet | **Delete** — see `198dba7a` |
| `shell.js:530` fleet tab | 60 s | terminal fleet + hop state | **Keep (for now)** — see Superseded below |
| `terminals.js:7982` kanban panes | 5 s | board columns **and board cards** | **Keep (for now)** — see Superseded below |
| `planning.js:1573` ticket file | 4 s | nothing — **never started** | **Delete** — dead code the extraction missed |
| `connections.js:69`, `linear.js:51` health | 15 s | a third-party API | **Keep** — correct as written |
| `terminals.js:2460` working-silence | 5 s | nothing (local) | **Keep** — not a network call |

**`shell.js:530` is the fleet bug a second time — but the push that would replace it does not carry what the tab renders.** `startFleetPoll` calls `refreshFleetTab()` every 60 s when the dock's fleet tab is open. Nothing outside the app creates or destroys a terminal, so this is the same category error as the 5-second poll, differing only in how long it hides the missing push.

> **Superseded:** "Remove `startFleetPoll`/`stopFleetPoll` and drive the dock's fleet tab from the same `terminalsChanged` push `198dba7a` restores."
> **Reason:** `refreshFleetTab` (`shell.js:555`) is NOT the rail. It fetches `ptyListTerminals` **and** `getHopState`, and renders hop state — `seatCards` (which seat holds which plan), the plan/code/review hop checkboxes, readiness reasons, and the Start/Stop button (`renderFleetContent`, `shell.js:612`). The `terminalsChanged` push that `198dba7a` restores triggers `fetchTerminalList()` in `terminals.js`, which relays `terminalFleetState` to the shell — but that relay carries only `terminals` and `teams` (`terminals.js:2126`), and the shell's handler for it calls `renderTerminalSection` (the rail), NOT `refreshFleetTab` (`shell.js:1616-1629`). Hop state is app-internal (computed by the seat-pacing engine) and has no broadcast — `getHopState` is a verb only (`bootstrap.ts:2040`, `TaskViewerProvider.ts:3940`), never `broadcastWs`'d. Deleting the poll therefore freezes the fleet tab's hop-state display: seatCards, hops, and readiness would never refresh. The push covers terminal *existence*; it does not cover hop *readiness*.
> **Replaced with:** Keep `startFleetPoll`/`stopFleetPoll` until a hop-state push is wired to the shell's fleet tab. Record this as a prerequisite card (Proposed Change 1, revised). The poll is a stand-in for a missing event, same category as the 5s fleet poll — but the event that would replace it does not exist yet, so unlike `198dba7a` this one cannot be deleted in the same motion.

**`terminals.js:7982` is NOT redundant — it is the only refresh path for board cards in the cockpit kanban panes.** `pollKanbanPanes` (`terminals.js:8035`) runs every 5 s whenever a pane is in kanban mode. It does two things: (1) `fetchKanbanColumnStructure()` (throttled to a 30 s cadence), and (2) `fetchBoardCardsForPane(idx)` for every kanban pane — the actual cards in each column.

> **Superseded:** "`pollKanbanPanes` runs every 5 s whenever a pane is in kanban mode, and calls `fetchKanbanColumnStructure()`. But `kanbanStructure` is a live broadcast — captured arriving unprompted on a hub subscription during this investigation, at +7238 ms with no request behind it. … The client poll is a second answer to a question already answered."
> **Reason:** Three conflations, each fatal to the verdict. (a) **Cards ≠ structure.** The poll's real work is `fetchBoardCardsForPane` (`getBoardCards`), not `getKanbanStructure`. The `kanbanStructure` broadcast carries column *structure* only — never cards. (b) **Wrong surface.** The `kanbanStructure` broadcast observed at +7238 ms is emitted by `KanbanProvider.postMessage` (`KanbanProvider.ts:13689`) and `SetupPanelProvider.postMessage` (`SetupPanelProvider.ts:736`) — it reaches the `kanban.html` and `setup.html` webviews. `terminals.js` is a *different* webview (the cockpit/terminals panel) and has **no `kanbanStructure` handler** at all (its `message` listener, `terminals.js:898`, handles `terminalsChanged`, `requestFleetState`, `switchboardThemeChanged`, `agentCompleted`, `focusTerminal`, `clearTerminalBadge`, `switchToTeam`, `switchToController`, `peekTerminal`, `popoutBlocked`, `startupCommandsChanged`, `terminalsGroupsChanged`, dispatch curtains, `autobanStateSync`/`updateAutobanConfig`, `panelVisibility` — no kanban message of any kind). (c) **No cards push reaches this surface.** The only card-related broadcast, `moveCards` (`bootstrap.ts:3036`), is scoped to `SURFACES.kanban` (the kanban board webview) and is not handled by `terminals.js` regardless. `fetchBoardCardsForPane` is called only from the poll and from explicit user actions (mode toggle `:7979`, column-picker change `:7586`/`:7612`, card advance `:6145`/`:7488`/`:7928`). With the poll gone, a background card move (agent completes, plan advances columns, a `git pull` lands a plan) would never appear in a cockpit kanban pane until the operator manually toggles the column. The pane would look frozen relative to the live board.
> **Replaced with:** Keep `pollKanbanPanes`. It is the only bridge between the server's kanban state and the cockpit's kanban panes. Board cards change from both external sources (plan files written by agents, `git pull`) and app-internal moves (column transitions) — and the server-side events that fire on both (plan watcher → `refreshUI` → `KanbanProvider.postMessage`) terminate at `kanban.html`, not `terminals.js`. Retiring this poll requires first wiring a cards/structure broadcast to the `terminals` surface — a separate, larger piece of work (Proposed Change 2, revised). The structure fetch inside the poll is already 30 s-throttled and low-cost; it is not the argument for deletion and it is not redundant on this surface either, since the structure broadcast does not reach `terminals.js`.

**`planning.js:1573` never runs, and the codebase already knows it.** `_startTicketsFilePoll` has **no call site**. A repo-wide search for `_startTicketsFilePoll()` returns only the function definition itself (`planning.js:1573`); the only other references are two teardown listeners (`planning.js:9265-9266`) stopping a timer nothing starts.

It was already diagnosed and deleted once — in `tickets.js:3568`:

> *"The dead 4-second file poll (`_startTicketsFilePoll` / `_stopTicketsFilePoll`) was removed: it had zero callers, refreshed only the selected ticket, and the backend file watcher (armed via `ensureTicketsWatcherArmed`) is now the single refresh mechanism — keeping both would mean two refresh paths racing on the same state."*

So the correct mechanism already exists and is armed. The 4-second interval was never a considered choice: the code was written during the Tickets panel build (`4161e072`), never wired to a caller, and superseded by the backend watcher before anyone had cause to defend the number.

**The panel extraction deleted the copy in `tickets.js` and missed the copy in `planning.js`.** A contract test guards the deletion — `tickets-auto-refresh-on-file-change.test.js:86` asserts `function _startTicketsFilePoll(` must not exist, *"the dead `_startTicketsFilePoll` must not be reintroduced"*. It reads `ticketsJs` (`test:14`: `fs.readFileSync(path.join(__dirname, '../webview/tickets.js'), ...)`). The surviving copy is in `planning.js`, so the guard passes green while the thing it forbids sits in the tree — a test scoped to one file for a rule that has to hold across the webviews.

**Why this went unnoticed.** A poll that covers for a missing event produces a UI that is correct but late, and nobody files a bug for late. That is precisely how the dead `terminalsChanged` broadcast survived the Go PTY host extraction. Each poll left in place preserves that camouflage for the next notification someone forgets to wire.

**What the remaining polls cost is not the argument.** Measured on the fleet poll: 3.5 KB and 21.8 ms per call at five seats, and it already skips hidden tabs. The case for removal is latency and camouflage, not load — a fix justified on CPU would be reverted the moment someone measured the CPU.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, performance, refactor, reliability

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting `_startTicketsFilePoll` / `_stopTicketsFilePoll` / `_ticketsFilePollTimer` and the two `pagehide`/`beforeunload` teardown listeners in `planning.js` — pure deletion of unreferenced code.
- Widening the contract test to scan every file in `src/webview/` instead of `tickets.js` alone — a glob + loop replacing a single `readFileSync`.
- Adding one-line "this poll earns its place" comments at the two health-poll sites.

### Complex / Risky
- The two polls this review *keeps* (`shell.js` fleet tab, `terminals.js` kanban panes) are kept for a non-obvious reason: the pushes that would replace them do not reach the surface that renders the state. A future sweep that deletes them "on principle" (the exact mistake the original plan made) reintroduces the freeze. The keep-comments at change 4 must be mirrored with a code-level comment at each kept poll so the reasoning survives outside this plan file.
- The test-widening must not regress the test's existing `tickets.js`-specific assertions (Faults 2-4 read `ticketsJs` by name and index into it); the widening adds a *new* cross-webview assertion rather than rewriting the existing ones.

## Edge-Case & Dependency Audit

1. **Ordering.** The `terminals.js:7992` fleet poll deletion belongs to `198dba7a` and is a hard prerequisite for anything that assumes `terminalsChanged` fires. This plan no longer deletes any poll that depends on that push — both fleet-tab and kanban-pane polls are retained until their own pushes exist — so this card has no ordering dependency on `198dba7a` for its executable scope. The dependency is recorded for the *recommended* future work only.
2. **The dock is a separate surface.** `shell.js` subscribes as the `shell` panel and receives `terminalFleetState` (relayed by `terminals.js`), not `terminalsChanged` directly. The shell has no WebSocket. Any future hop-state push must be relayed through `terminals.js` (the only surface that hears `autobanStateSync` and can post to the shell), exactly as `terminalFleetState` is relayed today — not broadcast directly to the shell.
3. **Tab-visibility gating disappears with the polls (future work only).** The fleet poll skips hidden tabs; a push does not. A background tab will process every fleet change. That is cheaper than polling but not free — confirm the handler is a refetch-and-render, not something expensive, before assuming it. Applies to the *future* hop-state push, not to this card's executable scope.
4. **Confirm the poll is dead before deleting, not after.** The evidence is a repo-wide search finding no caller plus `tickets.js:3568` recording the same conclusion. Re-run that search rather than trusting this plan: if a caller has since been added, deleting the functions breaks the Tickets tab instead of tidying it. (`_refreshSelectedTicketFromFile` at `planning.js:1583` is left in place — it is out of the poll's scope and may have other callers; do not delete it on this card.)
5. **Both hosts.** The extension host serves these panels too. The kept polls must keep working under both, and any future push must reach the webview under both. The kanban-pane poll and the fleet-tab poll are pure client-side `setInterval` over HTTP verbs that exist on both hosts, so retention is host-neutral.
6. **`workingSilenceInterval` is not in scope.** It is a local timer over already-received frames and makes no request. Leave it.
7. **The test-widening must scope to webview JS only.** Scanning `src/` broadly would catch the `tickets.js:3568` *comment* that mentions the function name and false-positive. Glob `src/webview/*.js`.
8. **Goal-vs-appearance (the load-bearing check).** The original plan would have passed its own success metric ("zero `getKanbanStructure`/`ptyListTerminals` requests at rest") while the cockpit kanban panes and the fleet tab's hop state silently froze. A green "no poll running" is not evidence the goal — *polling stays only where no event source exists* — was met; it is only evidence the polls are gone. The kept polls are the correction: an event source does NOT exist for hop state or for cockpit kanban cards, so polling stays.

## Dependencies

- Sibling plan *The Fleet Push Died With the TS Gateway* (`198dba7a`) — must restore the `terminalsChanged` broadcast before any fleet-tab poll retirement. Not a dependency for this card's executable scope (dead-poll deletion + test widening + comments), but a prerequisite for the recommended future card that wires a hop-state push and then retires `shell.js:530`.

## Adversarial Synthesis

Key risks: (1) the original plan conflated column-structure with board-cards and a broadcast on one webview with a broadcast on another, which would have frozen cockpit kanban panes; (2) it assumed `terminalsChanged` carries hop state, which it does not — the fleet tab's hop display would have frozen; (3) the test guard that "protects" the dead-poll deletion is scoped to one file, so the rule it encodes has never actually held across the webviews. Mitigations: keep both polls with code-level keep-comments; widen the test to all webview files; delete only the verified-dead ticket poll.

## Proposed Changes

### 1. Keep `shell.js`'s 60-second fleet poll — and record why in the code

> **Superseded:** "Remove `startFleetPoll`/`stopFleetPoll` and drive the dock's fleet tab from the same `terminalsChanged` push `198dba7a` restores. Sequenced after that emitter exists, or the tab goes from stale to frozen."
> **Reason:** `terminalsChanged` → `fetchTerminalList` → `postFleetStateToShell` relays `terminalFleetState` (terminals + teams) to the shell, and the shell's handler calls `renderTerminalSection` (the rail). The fleet *tab* (`refreshFleetTab`) additionally renders hop state from `getHopState`, which no push carries and no handler relays. Deleting the poll freezes hop state (seatCards, hop checkboxes, readiness reasons, Start/Stop button).
> **Replaced with:** Keep `startFleetPoll`/`stopFleetPoll` (`shell.js:530-545`). Add a comment at the `setInterval` (`shell.js:533`) recording that this poll is the only source of hop state for the fleet tab, that `terminalsChanged` covers terminal existence but not hop readiness, and that retiring it requires a hop-state push relayed through `terminals.js` to the shell (mirroring `terminalFleetState`). Open a follow-up card for that push; do not retire this poll in the same change.

### 2. Keep the kanban-pane poll in `terminals.js` — and record why in the code

> **Superseded:** "`pollKanbanPanes` already self-cancels when no pane is in kanban mode; the remaining case is covered by the `kanbanStructure` broadcast. Keep the existing push handler and the fetch-on-mode-change, and drop the timer."
> **Reason:** There is no "existing push handler" for kanban messages in `terminals.js` — its `message` listener handles no kanban type. `pollKanbanPanes` fetches board *cards* (`getBoardCards`), not just structure; the `kanbanStructure` broadcast carries structure only and reaches `kanban.html`/`setup.html`, not `terminals.js`. Dropping the timer leaves cockpit kanban panes updating only on explicit user action; background card moves never appear.
> **Replaced with:** Keep `startKanbanPoll`/`stopKanbanPoll`/`pollKanbanPanes` (`terminals.js:7982-8048`). Add a comment at `startKanbanPoll` (`terminals.js:7982`) recording that this poll is the only refresh path for board cards in the cockpit kanban panes, that the `kanbanStructure`/`moveCards` broadcasts terminate at the `kanban` surface and do not reach this webview, and that retiring the poll requires first wiring a cards broadcast to the `terminals` surface. Open a follow-up card for that wiring; do not retire this poll here.

### 3. Delete the dead ticket poll from `planning.js`, and widen the test that was meant to stop it

Remove `_startTicketsFilePoll`, `_stopTicketsFilePoll`, `_ticketsFilePollTimer` (`planning.js:1572-1582`) and the two teardown listeners at `:9265-9266`. Nothing calls them; `ensureTicketsWatcherArmed` is the live mechanism and already works. Leave `_refreshSelectedTicketFromFile` (`:1583`) in place — it is a separate function and out of this poll's scope.

**No migration is needed** — this is pure deletion of unreferenced code.

**Then fix the guard.** `tickets-auto-refresh-on-file-change.test.js:86` reads only `ticketsJs` (`test:14`), so it certified a deletion that had happened in one file of two. Add a new assertion that globs `src/webview/*.js` and asserts `function _startTicketsFilePoll(` appears in **none** of them — leaving the existing `ticketsJs`-specific assertions (Faults 2-4) untouched, since they index into `ticketsJs` by name and must keep reading that file. The new assertion is the cross-webview rule the old one claimed to enforce.

### 4. Leave the health polls alone, and say why in the code

`connections.js:69` and `linear.js:51` poll a third-party API every 15 s. Nothing can push "Linear is still reachable" — there is no event source, and reachability is exactly the state that changes without anyone telling you. These are correct.

Add one line at each site recording that, so a future sweep that deletes polls on principle does not delete the two that earn their place. **Also add the same style of keep-comment at the two polls this review retains** (`shell.js:533` fleet tab, `terminals.js:7982` kanban panes) — the reasoning lives in this plan, but a future reader deleting polls will not open the plan; the comment is what stops them.

## Verification Plan

> **Note:** Per the dispatching directive for this run, compilation and automated tests are NOT executed now. The checks below remain written down for when this card is implemented; they are simply not run in this pass.

### Automated Tests
1. `grep -rn '_startTicketsFilePoll\|_ticketsFilePollTimer' src/` returns only the contract test, and that test now scans every `src/webview/*.js` file rather than `tickets.js` alone.
2. The widened test still passes its existing `ticketsJs`-specific assertions (Faults 2-4) unchanged — the widening is additive, not a rewrite.

### Goal Invariants
- Assert `_startTicketsFilePoll` is absent from every file matching `src/webview/*.js` (paired positive: assert `ensureTicketsWatcherArmed` is present in `src/webview/tickets.js` — the live mechanism that replaces it).
- Assert `setInterval(` in `src/webview/shell.js` still contains the fleet-tab interval (the poll is retained, not deleted).
- Assert `setInterval(pollKanbanPanes` is still present in `src/webview/terminals.js` (the kanban-pane poll is retained, not deleted).
- Assert `setInterval(` sites in `src/webview/connections.js` and `src/webview/linear.js` each carry a comment containing the word "reachability" or "third-party" (the keep-reason is recorded in code, not only in this plan).

### Manual / Behavioral
3. Edit a ticket file on disk and assert the Tickets tab still updates — via `ensureTicketsWatcherArmed`, unchanged by this card. This is a no-regression check, not new behaviour.
4. With the network blocked to the tracker, the health indicator still degrades within one 15-second interval — the kept polls still work.
5. With a kanban-mode pane open and idle, assert a background card move (advance a plan from another surface) still updates the pane within one 5-second tick — confirming the retained poll is doing its job and the panes are not frozen.
6. With the dock's fleet tab open, assert the hop-state display (seatCards, hop checkboxes, readiness reasons) still refreshes within 60 s with no operator action — confirming the retained fleet-tab poll is doing its job.
