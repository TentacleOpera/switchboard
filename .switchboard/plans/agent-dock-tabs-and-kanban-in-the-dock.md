# The Agent Dock Grows Tabs, And The Kanban Pane Moves Into It

## Goal

Turn the right-hand dock from a single-iframe host into a tabbed one, with two tabs: the
agent terminal it hosts today, and a kanban view. The Terminals panel's KANBAN toolbar
button — which repurposes a terminal pane into a board viewer — is retired in favour of
it, giving the board a permanent home beside whatever panel is active.

### The problem, and the root cause

The dock is hardcoded to exactly one occupant. `#agent-dock` (`shell.html:604`) contains
one `#dock-frame` whose `src` is always `/terminals?solo=&dock=1`, one `#dock-title`, one
`#dock-role-btn` role picker, and one `#dock-empty` start state. Every dock function
assumes that occupant: `syncDockSeat` (`shell.js:~800`) resolves a pty seat,
`mountDockFrame` points the single frame at it, `showDockEmptyState` offers to start an
agent. There is no notion of *what* is docked, only of *which seat*.

Wanting a board beside the current panel therefore has no good answer today, so the
Terminals panel invented one: `btn-kanban-toolbar` (`terminals.html:2471`) flips the
focused terminal pane into a kanban list (`.kanban-pane-*`, `terminals.html:1566` onward).
That works, but it costs a terminal pane to see the board, it only exists while the
Terminals panel is the active panel, and the board view is implemented inside the
terminals document — which is why its scroll containers needed a specific bug fix
(`terminals.html:1411-1417`).

**Design decision: tabs in one dock, not a second dock region.** A second dock means a
second splitter, a second min-width floor, a second viability gate against
`DOCK_VIABLE_MIN` (`shell.js:56`), and a three-way width negotiation with `#content`.
Tabs reuse all of that machinery unchanged and cost one header row.

## Metadata
- **Complexity:** 7
- **Tags:** frontend, ui, ux, refactor, feature

## No migration

Clean break. `sb.agentDock` localStorage (`shell.js:DOCK_STATE_KEY`) gains an `activeTab`
key; a stored value without it reads as the agent tab, which is a default-value read and
not a migration. Do not write a migration path or preserve the retired KANBAN toolbar
button behind a setting. CLAUDE.md's migration rule is waived for this release.

## Implementation

1. **Generalise the dock to occupants.** Declare an occupant table:
   `{ id: 'agent', title, mount() }` and `{ id: 'kanban', title, mount() }`. Each owns its
   own iframe, both mounted up-front and toggled by class — the same
   `display`-toggle-not-`[hidden]` idiom the shell uses everywhere, for the documented
   cascade reason: `[hidden]{display:none}` is a user-agent rule and loses to any author
   `display` declaration (`shell.html:432`, `:515`). Two iframes means switching tabs does
   not reload either one, matching how panel frames already behave.
2. **Tab strip in `#dock-header`.** The header currently holds `#dock-role-btn`,
   `#dock-title` and `#dock-close`. Add a two-button tab group at its head. The role picker
   is **agent-tab-specific** and must hide on the kanban tab — it is meaningless there, and
   leaving it visible makes the header lie.
3. **Kanban occupant source.** Point it at the existing board route (`/board`) rather than
   porting the `.kanban-pane-*` renderer out of `terminals.html`. The board document is
   already a complete, tested board; the pane renderer is a compact reimplementation that
   exists only because a terminal pane is not a browser frame. Reusing `/board` deletes
   code instead of moving it.
   - Verify `/board` is usable at the dock's 648px floor (`DOCK_MIN`, `shell.js:50`). If it
     is not, that is a board responsive fix, and it should be scoped as such rather than
     answered by keeping a second board implementation alive.
4. **Retire `btn-kanban-toolbar`.** Remove the button (`terminals.html:2471`), its handler,
   and the `.kanban-pane-*` styles and renderer in `terminals.js` — including
   `fetchBoardCardsForPane` and `kanbanFetchInFlight` (`terminals.js:94`) if nothing else
   consumes them. Check first: drag-and-drop of kanban cards onto terminal panes
   (`terminals.html:1434`) may share this data path, and that feature is staying.
5. **Persist the active tab** in `sb.agentDock` beside `open`, `width` and `seat`, through
   the existing `readDockState`/`writeDockState` pair (`shell.js:64-79`).
6. **`#dock-title` becomes per-occupant.** Agent tab: the seat's friendly name, treated as
   an opaque server-returned string (`shell.js:~85`, edge case 4). Kanban tab: the board's
   name or active project.
7. **Theme fan-out.** `applyThemeToAll` (`shell.js:692`) explicitly fans out to the dock
   frame because it is not in the `frames` map (edge case 10). With two dock frames, **both**
   need the message — this is precisely the kind of "one seam wired, the other silently
   not" bug that leaves the second tab in the old palette until reload.

## Edge cases

- **Splitter drag over two frames.** `body.dock-dragging` sets `pointer-events: none` on
  `.panel-frame` and `#dock-frame` (`shell.html:557`) because iframes swallow mousemove.
  The selector must cover both dock frames or the drag dies on entering the new one.
- **Width floor.** `DOCK_MIN` is 648px, derived as 80 columns × 7.80px + chrome, and
  `shell.html:437` says explicitly *"Do not lower."* That is a terminal constraint. The
  kanban tab does not need 648px but must not be allowed to lower the shared floor.
- **Viability gate.** `updateDockViableGating` (`shell.js:939`) disables the dock below
  980px. Applies to the whole dock, both tabs — do not special-case the kanban tab into a
  narrower allowance, or the terminal tab becomes unusable when the user switches back.
- **Two boards at once.** The Kanban panel and the kanban dock tab can both be open. Both
  read live state over the WS rail and both must stay converged; the resync-on-connect
  path (`getFullState`) already handles multiple clients, so verify rather than special-case.
- **Dock empty state is agent-specific.** `#dock-empty` offers to start an agent
  (`shell.html:611`). The kanban tab has no empty state — it always has a board. Do not
  route the kanban tab through `showDockEmptyState`.
- **Pop-out.** The dock has no pop-out today. Do not add one in this plan.
- **No confirmation dialogs anywhere in the dock header** (CLAUDE.md). `window.confirm` is
  a silent no-op in VS Code webviews.

## Verification plan

1. `npm run compile` clean.
2. Open the dock; both tabs present, agent tab active by default on a fresh profile.
3. Switch tabs repeatedly; confirm neither iframe reloads (the terminal keeps its
   scrollback and its live WebSocket; the board keeps scroll position).
4. Confirm the role picker is present on the agent tab and absent on the kanban tab.
5. Reload with the kanban tab active; confirm it is restored, and that a `sb.agentDock`
   value written before this change still opens cleanly on the agent tab.
6. Drag the splitter across its full range while each tab is active; confirm the drag never
   dies crossing a frame, and that 648px is still the floor.
7. Toggle the theme with each tab active, then switch tabs; confirm **both** frames
   repainted — do not accept "the visible one looks right".
8. Resize below 980px; confirm the whole dock gates off.
9. Terminals panel: KANBAN button gone, no dead handler, no console errors, and
   **card-to-pane drag-and-drop still works**.
10. Board open in the Kanban panel and the dock tab simultaneously; move a card in one and
    confirm the other converges.
11. Both hosts.
