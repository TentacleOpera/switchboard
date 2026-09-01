# The agent dock becomes three tabs — Agent, CLI, Fleet — and drops the Kanban pane

## Goal

Restructure the right-hand agent dock from its current two tabs (Agent, Kanban) to three: **Agent**
(unchanged), **CLI** (a live pty seat running the `switchboard` front door), and **Fleet** (a
polled, read-only `switchboard fleet` view). Retire the Kanban pane.

### Problem Analysis

**The dock's job is to be the operator's control surface beside the board, and today two of its
three needed views do not exist while one that duplicates the main content area does.**

The dock is a third flex child beside `#content` (`shell.html:490`), with a tab strip carrying
exactly two buttons (`:492-494`) and two iframes: `#dock-frame` pointed at
`/terminals?solo=<name>&dock=1`, and `#dock-kanban-frame` at `/terminals?kanban=1&dock=1`
(`:505-508`).

1. **The Kanban tab duplicates the board.** `#content` is already the board. A narrow second
   rendering of it, in a pane sized for a terminal (the CSS comment at `shell.html:313` explains
   the floor is set by *"Menlo/DejaVu + 24px chrome"*), is the least useful thing that space can
   hold.

2. **There is no way to run a CLI command from the dock.** The `switchboard` CLI now carries the
   whole board vocabulary — `plans`, `ready`, `dispatch`, `clear`, `fleet`, `verb`, `status` — and
   the operator's only route to it is a terminal outside the board entirely.

3. **Fleet status is agent-mediated.** Reading which seats are live currently means asking the
   controller agent to run `switchboard fleet` and print it back. That is a language model
   paraphrasing a formatted table — latency, tokens, and a paraphrase where the raw table was
   already correct. `cmdFleet` emits an aligned `SEAT / ROLE / STATUS / CURRENT PLAN` table, and
   `--json` returns `{ terminalCount, terminals[] }` with `friendlyName`, `role`, `status`,
   `planTitle`. That is a render, not a conversation.

### Root Cause

The dock was built to host **one** thing — a controller agent terminal — and the Kanban tab was
added as the obvious second use of the space before the CLI existed as a general surface. `dockRole`
is a hard-coded `'mission-control'` constant (`shell.js:60`) and `dockSeatName()` returns
`` `dock-${dockRole}` `` (`:449`), so the dock's shape has always assumed a single occupant class.
Nothing about that assumption was revisited when the CLI grew a board vocabulary.

### Non-goals

- **No new execution endpoint.** The CLI tab is a pty seat, not a `POST /cli/exec`. See below.
- **Not changing the Agent tab.** Its seat resolution, persistence and empty state are untouched.
- **Not building the rules engine.** The Fleet tab here renders fleet state only; rule state is
  added by `rule-state-surfaces-in-the-dock-and-arms-to-act.md`.

### The CLI tab is a pty seat, deliberately

The alternative is an endpoint that accepts a command name and runs it. That is a remote-code
surface reachable by anyone who can reach the board — and under `switchboard tailnet` that is every
device on the tailnet, with *"no token, no enrolment — tailnet membership is the control"*
(`cli.ts` usage). An allowlist narrows it but does not remove it, and the allowlist becomes a
second place where the CLI's command set is enumerated and drifts.

A pty seat adds nothing: the fleet already spawns terminals, the dock already renders one through
`/terminals?solo=<name>&dock=1`, and a terminal is already exactly as privileged as this. It also
gets the interactive front door — `switchboard` bare renders a menu, `ready` offers a picker — which
an exec endpoint could never carry.

## Dependencies

- **Hard prerequisite:** `the-dock-kanban-pane-renders-nothing.md`. Three of the four defects it
  fixes are **not** kanban-specific and survive this plan's retirement of the Kanban pane: the dock
  reads the main panel's `terminals.*` pane settings, the mode body class lands after first paint so
  full-panel chrome flashes (this affects `is-solo` — the agent tab, and the CLI tab added here),
  and a `?dock=1` document can post `switchPanel` to repaint the shell's main content area. The CLI
  tab is the same `/terminals?…&dock=1` pattern and inherits all three. Containment and paint order
  land first, or this plan ships new instances of known bugs.

## Metadata

**Complexity:** 4
**Tags:** ui, frontend, ux, cli, security

## User Review Required

- **Confirm the Kanban pane is retired rather than kept as a fourth tab.** Four labels in a pane
  whose default width is set by a terminal's minimum is a crowding risk; three is comfortable. If
  it is kept, the tab strip needs a wrap or overflow behaviour that it does not have today.
- **Confirm the Fleet poll interval.** 5s is proposed. It is one `ptyListTerminals` round trip per
  tick and only while the tab is visible.

## Complexity Audit

### Routine

- Adding a third tab button and a third pane container.
- Rendering the fleet table from `GET`-equivalent data already served.

### Complex / Risky

- **`setDockActiveTab` is written for exactly two tabs.** `shell.js:451-475` toggles two buttons by
  name and hides one frame in each branch. A third tab added by pattern-matching that structure
  produces a state where two panes are visible at once. The function is rewritten to drive an
  N-pane map, not extended with a third `if`.
- **`syncDockSeat` early-returns on `activeTab !== 'agent'`** (`shell.js:520-521`). The CLI tab also
  hosts a seat, so that guard now hides a live CLI terminal whenever the agent tab is not active.
  The seat-sync path must become tab-aware rather than agent-only.
- **`updateDockTitle` hard-codes the Kanban branch** (`shell.js:542-545`) and otherwise composes
  `` `${name} — ${status}` `` from `lastAutobanArmed`. That armed-status suffix is meaningful for the
  controller seat and meaningless for a CLI seat; the title needs a per-tab resolver.
- **Persisted `activeTab: 'kanban'` exists on users' machines.** `DOCK_STATE_KEY = 'sb.agentDock'`
  (`shell.js:49`) is browser-local and shipped. On upgrade, a stored `'kanban'` must resolve to a
  valid tab rather than leaving every pane hidden and the dock apparently broken. Normalise unknown
  values to `'agent'` on read.
- **Theme fan-out is explicit, not inherited.** `shell.js:400-410` posts theme messages to
  `dockFrame` and `dockKanbanFrame` *by name*, with a comment recording that the dock frames are not
  in `frames` and so *"would leave the dock in the old palette until reload"*. A new CLI frame that
  is not added to that fan-out is a theme bug on every switch.
- **`body.dock-dragging` pointer-inert rules name each frame** (`shell.html:437-439`). A new frame
  omitted from that selector list swallows pointer events mid-drag and the splitter sticks.

## Edge-Case & Dependency Audit

- **The CLI seat needs a distinct name.** `dockSeatName()` is `` `dock-${dockRole}` `` with
  `dockRole` a hard-coded `'mission-control'`. A second dock seat needs its own name or it collides
  with the controller seat.
- **Seat lifecycle.** If the CLI seat exits, the tab shows an empty state with a start button — the
  same shape as `showDockEmptyState()`, not a blank iframe.
- **Fleet tab with no server.** Must render the CLI's offline guidance, not an empty table. An
  empty table reads as "no seats", which is the exact misdiagnosis the Mission Control protocol's
  port-discovery section exists to prevent: *"never report an empty fleet off a resolve that never
  got a 200."*
- **Polling stops when the tab is hidden**, and on `visibilitychange` for the whole page. A 5s poll
  running in a background tab all night is a real cost for zero value.
- **Both hosts serve this file.** `getShellHtml` is wired in `bootstrap.ts:3469` *and*
  `TaskViewerProvider.ts:4190`, so the change lands once and reaches both. Any *new endpoint* would
  need both roots — this plan deliberately adds none.
- **Minimum-width guard.** `shell.js:56` disables the dock below a viewport floor rather than
  shrinking it. Three tab labels must fit at the dock's minimum width, not just its default.

## Proposed Changes

### 1. `src/webview/shell.html` — tab strip and panes

Replace the two-button strip with three (`Agent`, `CLI`, `Fleet`). Remove `#dock-kanban-frame`; add
`#dock-cli-frame` (iframe) and `#dock-fleet` (a plain div — no iframe, it renders locally). Add both
to the `body.dock-dragging` pointer-inert selector list.

### 2. `src/webview/shell.js` — tab machinery

- Replace `setDockActiveTab`'s two-branch body with a pane map keyed by tab id; exactly one pane
  visible by construction.
- Normalise a persisted unknown/retired `activeTab` (including `'kanban'`) to `'agent'` on read.
- Make `syncDockSeat` tab-aware: agent tab resolves the controller seat as today, CLI tab resolves
  the CLI seat.
- Give `updateDockTitle` a per-tab resolver: controller seat keeps the armed suffix, CLI seat shows
  its seat name, Fleet shows a last-updated stamp.
- Add `#dock-cli-frame` to the theme fan-out beside the existing two.

### 3. CLI tab

Mount `/terminals?solo=<cliSeatName>&dock=1` against a dock-owned seat whose startup command is
`switchboard`. Empty state offers a start button, mirroring the agent tab's.

### 4. Fleet tab

Poll the same data `cmdFleet` reads (`ptyListTerminals`) on a 5s interval while visible; render the
`SEAT / ROLE / STATUS / CURRENT PLAN` columns. Offline renders the offline guidance. Poll stops on
tab switch and on page `visibilitychange`.

## Verification Plan

### Automated Tests

1. **Exactly one pane visible** for each of the three tab ids, asserted over all three — the
   regression that a third `if` in `setDockActiveTab` would produce.
2. **Persisted `'kanban'` normalises to `'agent'`** and renders the agent pane. The upgrade path for
   every user who last used that tab; without it the dock opens blank.
3. **Theme fan-out includes every dock frame.** Assert the fan-out list and the set of dock iframes
   are the same set, so a future fourth frame cannot be added to one and not the other.
4. **`dock-dragging` selector covers every dock frame** — same set-equality shape, same reason.
5. **`syncDockSeat` no longer early-returns for the CLI tab**, and resolves the CLI seat there.
6. **Fleet offline path** renders offline guidance, and specifically does *not* render an empty
   seat table.
7. **Poll lifecycle:** no timer runs while the Fleet tab is hidden or the page is backgrounded.
8. **No new server route** is introduced — assert the LocalApiServer route table is unchanged by
   this plan's diff, pinning the "pty seat, not exec endpoint" decision against a later shortcut.

### Goal Invariants

- The dock has three tabs and no Kanban pane.
- The CLI tab runs a real `switchboard` process; there is no command-execution endpoint anywhere in
  the diff.
- Fleet status is readable without an agent in the loop.

### Manual

- Resize to the dock's minimum width; three labels fit without wrapping or clipping.
- Switch theme with each tab active; all three repaint without reload.
- Drag the splitter across the CLI tab; the terminal does not swallow the drag.
- Kill the CLI seat; the tab shows the empty state with a working start button.
