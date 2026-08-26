# The Agent Dock Grows Tabs, And The Terminals Kanban Pane Becomes One Of Them

## Goal

Turn the right-hand dock from a single-iframe host into a tabbed one: the agent terminal it
hosts today, plus the Terminals panel's existing kanban pane. The kanban pane keeps working
exactly where it already works — this adds a second place to put it, so a card list can sit
beside any panel without spending a terminal slot.

### The problem, and the root cause

The dock is hardcoded to exactly one occupant. `#agent-dock` (`shell.html:604`) holds one
`#dock-frame` whose `src` is always `/terminals?solo=&dock=1`, one `#dock-title`, one
`#dock-role-btn` role picker and one `#dock-empty` start state. Every dock function assumes
that occupant: `syncDockSeat` resolves a pty seat, `mountDockFrame` points the single frame
at it, `showDockEmptyState` offers to start an agent. There is no notion of *what* is
docked, only of *which seat*.

So the kanban pane — which is a good thing, and staying — can only appear inside the
Terminals panel's grid, by taking over a pane (`btn-kanban-toolbar`,
`terminals.html:2471`). Two consequences. Seeing the card list costs a terminal slot. And
it is only available while Terminals is the active panel, which is exactly when you least
need a card list, and never available while you are looking at anything else.

**Design decision: tabs in one dock, not a second dock region.** A second dock means a
second splitter, a second min-width floor, a second viability gate against
`DOCK_VIABLE_MIN` (`shell.js:56`), and a three-way width negotiation with `#content`. Tabs
reuse all of that unchanged and cost one header row.

**Design decision: reuse the kanban pane renderer, not the board document.** The dock's
kanban tab renders the same `.kanban-pane-*` list the Terminals panel already renders
(`terminals.html:1566` onward, `terminals.js:7010-7180`). It is a compact, board-aware card
list built for a narrow column — which is what a 648px dock is. The full board document
(`/board`) is built for a wide multi-column surface and does not belong in a dock.

## Metadata
- **Complexity:** 6
- **Tags:** frontend, ui, ux, feature
- **Feature:** 4c1323fb-a025-467f-b289-88f50b1f8347

## Explicitly out of scope

- **`btn-kanban-toolbar` stays.** The in-grid kanban pane is not retired, deprecated, or
  gated behind the dock. `.kanban-pane-*` styles, `fetchBoardCardsForPane`,
  `kanbanFetchInFlight` (`terminals.js:94`) and card-to-pane drag-and-drop
  (`terminals.html:1434`) all stay and keep working.
- **The Kanban panel is untouched.** The board keeps its own rail icon and its own panel.

## No migration

Clean break. `sb.agentDock` (`shell.js:DOCK_STATE_KEY`) gains an `activeTab` key; a stored
value without it reads as the agent tab, which is a default-value read, not a migration. Do
not add compat shims. CLAUDE.md's migration rule is waived for this release.

## Implementation

1. **A kanban-only mode for the terminals document.** The dock's kanban tab is
   `/terminals?kanban=1&dock=1` — the same document, in a mode that renders one
   full-height kanban pane and hides the grid, sidebar and toolbar. This follows the mode
   convention the document already has: `?solo=`, `?team=`, `?dock=1`, parsed together at
   `terminals.js:202-210`, with `is-solo` as the precedent for a body-class-driven mode
   (`terminals.js:776`). No renderer is ported, no markup is duplicated, and the pane's
   scroll-container fix (`terminals.html:1411-1417`) is inherited rather than re-derived.
   - Precedence: `solo` wins over `team` today (narrower scope wins). Put `kanban` at the
     same level and document its precedence explicitly rather than leaving it to
     evaluation order.
2. **Generalise the dock to occupants.** An occupant table — `{ id: 'agent', title,
   src }`, `{ id: 'kanban', title, src }` — with one iframe each, both mounted up-front and
   toggled by class. Use the `display`-toggle-not-`[hidden]` idiom for the documented
   cascade reason: `[hidden]{display:none}` is a user-agent rule and loses to any author
   `display` declaration (`shell.html:432`, `:515`). Two iframes means switching tabs
   reloads neither — the terminal keeps its scrollback and live WebSocket, the card list
   keeps its scroll position.
3. **Tab strip in `#dock-header`,** ahead of `#dock-title` and `#dock-close`. There is no
   role picker to accommodate: `opening-the-dock-starts-mission-control.md` retires it —
   the dock shows the controller agent, with no choice of role. Do not re-add a picker,
   and do not carry `#dock-role-btn` / `#dock-role-menu` forward into the tabbed header.
4. **`#dock-title` per occupant.** Agent tab: the seat's friendly name, treated as an opaque
   server-returned string (edge case 4). Kanban tab: the column or active project the pane
   is showing.
5. **Persist `activeTab`** in `sb.agentDock` through the existing
   `readDockState`/`writeDockState` pair (`shell.js:64-79`).
6. **Theme fan-out to both frames.** `applyThemeToAll` (`shell.js:692`) fans out to the
   dock frame explicitly because it is not in the `frames` map (edge case 10). With two
   dock frames, **both** need the message. This is precisely the one-seam-wired-the-other-
   silently-not failure class CLAUDE.md describes: the visible tab looks right and the
   other is stuck in the old palette until reload.
7. **Empty state stays agent-only.** `#dock-empty` (`shell.html:611`) offers to start an
   agent. The kanban tab has no empty state — it always has a board to read, even if the
   column is empty, in which case the pane's own empty rendering applies. Do not route the
   kanban tab through `showDockEmptyState`.

## Edge cases

- **Splitter drag over two frames.** `body.dock-dragging` sets `pointer-events: none` on
  `.panel-frame` and `#dock-frame` (`shell.html:557`) because iframes swallow mousemove.
  The selector must cover both dock frames or the drag dies on entering the new one.
- **Width floor.** `DOCK_MIN` is 648px, derived as 80 columns × 7.80px + chrome, and
  `shell.html:437` says *"Do not lower."* That is a terminal constraint. The kanban pane is
  comfortable far narrower but must not be allowed to lower the shared floor.
- **Viability gate.** `updateDockViableGating` (`shell.js:939`) disables the dock below
  980px. It applies to the whole dock. Do not special-case the kanban tab into a narrower
  allowance — the terminal tab becomes unusable the moment the user switches back.
- **Two kanban panes at once.** The dock tab and an in-grid pane can both be open, both
  reading live state over the WS rail. `getFullState` resync-on-connect already handles
  multiple clients; verify convergence rather than special-casing it.
- **Drag-and-drop across documents.** Card-to-pane drag works inside the terminals document
  (`terminals.html:1434`). Dragging from the dock's kanban tab into a terminal pane in the
  *panel* crosses an iframe boundary and will not work. Do not advertise it; if a card drag
  starts in the dock, it must fail visibly rather than appear to do nothing.
- **Kanban-mode body class collisions.** `is-solo` already hides the sidebar and suppresses
  `saveSetting` (`terminals.js:1862-1867`). A new kanban mode must not inherit
  solo-specific suppressions by accident, nor re-enable settings writes from a dock frame.
- **No confirmation dialogs anywhere in the dock header** (CLAUDE.md). `window.confirm` is
  a silent no-op in VS Code webviews.

## Verification plan

1. `npm run compile` clean.
2. `/terminals?kanban=1&dock=1` renders a single full-height card list with no grid, no
   sidebar and no toolbar, and no console errors.
3. Open the dock: both tabs present, agent tab active on a fresh profile.
4. Switch tabs repeatedly: confirm neither iframe reloads — terminal scrollback and live
   WebSocket survive, card-list scroll position survives.
5. No role picker in the dock header on either tab.
6. Reload with the kanban tab active: confirm restore, and confirm a `sb.agentDock` value
   written before this change opens cleanly on the agent tab.
7. Drag the splitter across its full range with each tab active: the drag never dies
   crossing a frame, and 648px is still the floor.
8. Toggle the theme with each tab active, then switch tabs: confirm **both** frames
   repainted. Do not accept "the visible one looks right".
9. Resize below 980px: the whole dock gates off.
10. **The in-grid kanban pane still works**: `btn-kanban-toolbar` flips a pane, the card
    list renders and scrolls, and card-to-pane drag-and-drop still works.
11. A dock kanban tab and an in-grid pane open together: move a card in one, confirm the
    other converges.
12. Both hosts.
