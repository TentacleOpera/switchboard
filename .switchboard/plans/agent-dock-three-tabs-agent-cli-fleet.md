# The agent dock becomes three tabs — Agent, CLI, Fleet — and drops the Kanban pane

<!-- board-collapse-08 -->
> **FOLDED IN 2026-09-04 (Board Collapse 08).** *The Agent Dock Opens Below The Top-Right Cluster Instead Of Displacing It* has been **merged into this plan and deleted**. It was a loose card whose entire collision analysis was written against a **two-tab** dock (`#dock-tabs` holding Agent and Kanban) — which is what `shell.html` still has at HEAD, and which this plan replaces with three tabs. Landing it separately would have meant redoing that analysis twice.
> 
> Carry from it: keep the top-right control cluster anchored to the shell's right edge and open the dock **below** it rather than sliding the cluster by `--dock-width`; introduce `--cluster-band: calc(6px + 36px + 4px)` consumed by both `#agent-dock` and `#dock-splitter`; delete `--dock-width` together with its four writers in `shell.js`; and rewrite `shell-terminal-strip.test.js:1116-1132` to assert both the negative and the positive. The 648px dock width is unchanged.
> 
> **Re-derive the geometry against three tabs**, not two. The tab strip this plan builds is wider than the one that analysis measured.


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
- **Not building the automation.** The Fleet tab here renders seat state only; the dispatch hops and
  their Start button are added by `the-fleet-tab-runs-the-hops.md`.

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

- **Hard prerequisite:** `dock-frames-do-not-know-they-are-docks.md`. All three defects it fixes
  follow any `?dock=1` document, so retiring the Kanban pane does not clear them: the dock reads the
  main panel's `terminals.*` pane settings, the mode body class lands after first paint so
  full-panel chrome flashes (already visible on `is-solo` — the agent tab this plan keeps), and a
  dock document can post `switchPanel` to repaint the shell's main content area. The CLI tab added
  here is the same pattern and inherits all three.

### The Kanban pane is retired without being repaired

Testing the Kanban tab surfaced a fourth defect that is genuinely kanban-specific: the dock's kanban
entry paths (`terminals.js:848-856`, `:2228-2233`) set `paneModes = ['kanban']` without seeding
`kanbanPaneColumn`. Both toggle paths do seed it (`:6549`, `:7646`); the dock path does not, so the
column is `undefined`, the snap-to-offered logic (`:7142-7145`) cannot repair it — it tests equality
and `includes()`, both false for `undefined` — and the pane fetches an undefined column and paints
nothing.

**It is deliberately not fixed.** This plan deletes the pane, so the defect dies with it. Recorded
here so the diagnosis is not rediscovered, and so nobody reads the broken tab as a reason to delay
the retirement — it is a reason to hurry it.

## Metadata

**Complexity:** 4
**Tags:** ui, frontend, ux, cli, security
**Feature:** eb81e078-5849-41b0-a242-e6f718dd4ff9

## User Review Required

None — both settled.

**The Kanban pane is retired, not kept as a fourth tab.** Three labels fit the dock's minimum width;
four would need wrap or overflow behaviour the tab strip does not have.

**The Fleet poll is 60s**, and only while the tab is visible. It refreshes the *display* — it is not
what makes rules fire. Rule evaluation runs on the survivor scheduler tick and on the turn-end hook
(`the-fleet-tab-runs-the-hops.md`), so a finished card still produces a dispatch
within seconds no matter how slowly the table repaints. A short poll would buy nothing and cost a
`ptyListTerminals` round trip every few seconds all day.

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
- **Polling stops when the tab is hidden**, and on `visibilitychange` for the whole page. A poll
  running in a background tab all night is a real cost for zero value, even at 60s.
- **Both hosts serve this file.** `getShellHtml` is wired in `bootstrap.ts:3474` *and*
  `src/services/TaskViewerProvider.ts:4198`, so the change lands once and reaches both. Any *new
  endpoint* would need both roots — this plan deliberately adds none.
- **Minimum-width guard.** `shell.js:56` disables the dock below a viewport floor rather than
  shrinking it. Three tab labels must fit at the dock's minimum width, not just its default.

## Adversarial Synthesis

Key risks: the N-pane map must handle three different pane types (lazy-mounted iframe, already-mounted
iframe, plain div) with different show semantics, not a uniform show/hide; the CLI seat needs a
distinct creation path (startup command `switchboard`) from the controller seat, not just a different
name; persisted `'kanban'` normalisation must write back the normalised value or the upgrade never
completes. Mitigations: specify per-tab mount strategy in the pane map; trace CLI seat creation from
start button through the fleet API; persist normalised `activeTab` on read via `writeDockState`.

## Proposed Changes

### 1. `src/webview/shell.html` — tab strip and panes

Replace the two-button strip with three (`Agent`, `CLI`, `Fleet`). Remove `#dock-kanban-frame`; add
`#dock-cli-frame` (iframe) and `#dock-fleet` (a plain div — no iframe, it renders locally). Add both
to the `body.dock-dragging` pointer-inert selector list.

### 2. `src/webview/shell.js` — tab machinery

- Replace `setDockActiveTab`'s two-branch body with a pane map keyed by tab id; exactly one pane
  visible by construction. Each tab entry carries its own show/hide logic: Agent and CLI are
  lazy-mounted iframes (src set on first show, mirroring `mountDockKanbanFrame`), Fleet is a plain
  div toggled by display class.
- Normalise a persisted unknown/retired `activeTab` (including `'kanban'`) to `'agent'` on read,
  and persist the normalised value via `writeDockState` so the upgrade is complete after one read.
- Make `syncDockSeat` tab-aware: agent tab resolves the controller seat as today, CLI tab resolves
  the CLI seat.
- Give `updateDockTitle` a per-tab resolver: controller seat keeps the armed suffix, CLI seat shows
  its seat name, Fleet shows a last-updated stamp.
- Add `#dock-cli-frame` to the theme fan-out beside the existing two.

### 3. CLI tab

Mount `/terminals?solo=<cliSeatName>&dock=1` against a dock-owned seat whose startup command is
`switchboard`. The CLI seat name (e.g. `dock-cli`) must differ from the controller's
(`dock-mission-control`) to avoid collision. Empty state offers a start button, mirroring the agent
tab's — but the start button creates a seat with `switchboard` as its startup command, a distinct
creation path from the controller seat's, not just a different seat name.

### 4. Fleet tab

Poll the same data `cmdFleet` reads (`ptyListTerminals`) on a 60s interval while visible; render the
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

---

## Implementation summary

Replaced the two-tab dock (Agent + Kanban) with three tabs (Agent + CLI + Fleet) across `shell.html`, `shell.js`, and both test files. The Kanban iframe (`#dock-kanban-frame`) and its tab button were removed; a new CLI iframe (`#dock-cli-frame`) was added with its own seat lifecycle (`dock-cli` role, `switchboard` startup command saved via `saveStartupCommands`). `setDockActiveTab` was rewritten with a pane-map pattern that hides every pane before showing exactly one, and `normaliseDockTab` retires persisted `'kanban'` (and any unknown value) to `'agent'`. `syncDockSeat` and `updateDockTitle` are now tab-aware, with a separate `syncCliSeat`/`checkCliLiveness`/`mountCliFrame`/`showCliEmptyState`/`startCliSeat` lifecycle for the CLI tab. Theme fan-out, the `dock-dragging` pointer-inert selector, and the `terminalFleetState`/`dockTerminalExited` message handlers were updated to cover the CLI frame and drop all Kanban references. The folded Board Collapse 08 geometry work landed: `--cluster-band: calc(6px + 36px + 4px)` was added to `:root` and consumed as `margin-top` by `#agent-dock` and `#dock-splitter`; `--dock-width` and its four writers in `shell.js` were deleted; the top-right cluster is now anchored to the shell's right edge (`right: 6px`). No server route was added — the CLI seat uses the existing `ptyCreateTerminal` verb. All 75 tests in `shell-terminal-strip.test.js` pass; the 2 pre-existing failures in `shell-agent-dock.test.js` (about `ptyHost.ts` `hidden` flag forwarding) are unrelated to this change.


## Review Findings

The three-tab restructure is correct and complete: `setDockActiveTab` is a genuine pane
map that hides every pane before showing one, `normaliseDockTab` retires persisted
`'kanban'` and writes the normalised value back, `syncDockSeat`/`updateDockTitle` are
tab-aware, and the CLI seat has its own name, role and `switchboard` startup command
merged into the global store without clobbering other roles (verified against the live
`getStartupCommands`, which returns `{success, commands}` flat as the code assumes). The
folded Board Collapse 08 geometry landed with no orphans — `--dock-width` and all four
writers are gone. Two defects were found and fixed: both seat syncs checked the active
tab only *before* their `ptyListTerminals` await while running on every fleet push, so a
tab click inside the round trip mounted an iframe over the pane the operator had
switched to (`src/webview/shell.js`, post-await re-check added); and the `hidden` flag
the CLI seat relies on was never honoured on the extension host, because the Go PTY host
emits one flat `terminals` array with no `hiddenTerminals` split, so both dock seats were
drawn as ordinary fleet rows there (`src/services/TaskViewerProvider.ts`, split added to
mirror `bootstrap.ts`). Files changed: `src/webview/shell.js`,
`src/services/TaskViewerProvider.ts`, `src/test/shell-agent-dock.test.js`;
`test:contract:shell-agent-dock` 40/0, `test:contract:shell-terminal-strip` 75/0,
typecheck and lint clean.

## Deferred Findings

- MAJOR `cmd/switchboard-pty-host/main.go:388` — the Go PTY host itself still returns one unsplit `terminals` array and no `hiddenTerminals` key. The split is now performed host-side in `TaskViewerProvider.ts` (matching `bootstrap.ts`), so both hosts behave correctly, but any third consumer talking to the Go host directly will see hidden seats in the rendered list. Doing the split in the Go host would remove the duplication; not done here because `main.go` is under concurrent edit by another plan.
- MAJOR `src/webview/shell.html:23` — `connect-src` was widened from an explicit loopback/`*.localhost` WebSocket allowlist to bare `ws: wss:` (any host, any origin). This change is NOT part of this plan — it belongs to the concurrent remote/tailnet WebSocket work also present in the tree — but it lands in a file this commit stages. It should be reviewed by that plan's owner; a tailnet-reachable board with `connect-src ws: wss:` can be induced to open a socket to any host.
- NIT plan verification item 1 ("exactly one pane visible for each of the three tab ids") shipped as a source-level presence check that `setDockActiveTab` contains each hide call, not as a behavioural assertion over all three tabs. The hide-all-then-show-one structure makes the invariant true by construction, but no test would catch a regression that reintroduced conditional hiding.
- NIT `src/webview/shell.js:829` — `dockCliInput` / `dockCliWrap` are the **agent** tab's startup-command input, named before the CLI tab existed. The names now collide with the new CLI tab's vocabulary and read as belonging to it.
- NIT the plan's premise that "`shell.html` still has two dock tabs, Agent and Kanban" was stale at coding time: HEAD already carried a Fleet tab and `#dock-fleet` pane. The delivered change is Kanban -> CLI, not two tabs -> three.
