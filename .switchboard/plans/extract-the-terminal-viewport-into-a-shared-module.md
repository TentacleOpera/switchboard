# Extract the terminal viewport out of the 13,000-line Terminals panel into a module anything can embed

## Goal

Lift the code that renders and streams **one terminal** — xterm setup, sizing, theme, view
materialisation, the WebSocket, write batching and replay — out of `src/webview/terminals.js` into a
shared module with a small public surface. The Terminals panel becomes its first consumer, with no
behaviour change. Nothing else moves.

This is the prerequisite that makes a dedicated dock document possible without duplicating the
hardest code in the repository.

### Problem Analysis

**`terminals.js` is 13,037 lines and 293 functions, and showing one terminal requires all of it.**

The dock proves the cost. Its agent tab is `/terminals?solo=<name>&dock=1` — the entire Terminals
panel, parameterised down to a single pane. Reading the file's own section map (`:118-152`), what
that tab actually needs is:

| Section | Lines | Approx |
| :--- | :--- | ---: |
| Input frame encode / base64 decode | 252–280 | 28 |
| xterm renderer: fit, size votes, WebGL swap | 281–671 | 390 |
| Theme resolve / terminal theme build | 672–756 | 84 |
| `materializeTerminalView` / jump-to-latest | 7816–8212 | 396 |
| `connectTerminalSocket` (WebSocket stream) | 8213–8481 | 268 |
| Write batching / replay / completion toasts | 8482–8751 | 269 |
| Server modes / paste identity / view teardown | 7548–7815 | 267 |
| | | **~1,700** |

Everything else it loads and never uses: layout slot math, settings persistence, terminal list and
group reload, the startup curtain, pane assignment sanitising, `renderTerminalRow`, group CRUD,
derived group ordering, `renderGroupTabStrip`, team bucketing, `renderSidebarList`, layout modes,
`renderPaneGrid`, pane element create/update/drop, kanban helpers and `renderKanbanPane`, the fit
ladder, agent-name fetching, terminal and team creation, rename/close/clear, standing orders and the
link modal. **Roughly 8,000 lines of dead weight per dock frame.**

**And the weight is not only bytes.** Loading the panel means loading its *behaviours*, each of which
then has to be taught that it is in a dock. The file carries 33 `isSolo` / `soloTerminalName` guards
and 4 `isDockFrame` guards — every one a place that asks "which slot am I in?". The three defects in
`dock-frames-do-not-know-they-are-docks.md` are precisely the places that never asked: settings
restore, the mode body class, and the parent-message bridge.

The flash the operator sees is `renderSidebarList` (`3459–3823`) — 364 lines rendering a sidebar
that CSS then hides.

### Root Cause

The Terminals panel grew as a single document because for a long time there was exactly one place a
terminal appeared. Each new context — solo mode, popout windows, team scope, the dock — was added by
*parameterising the panel* rather than by extracting what those contexts share, because
parameterising is a one-line change and extraction is a refactor. Four contexts later the panel is
the only thing that knows how to draw a terminal, and every context pays for the whole panel.

### Non-goals

- **No behaviour change.** This is a move. The Terminals panel renders identically before and after;
  that is the plan's central claim and the thing its verification is built to prove.
- **Not building the dock document.** That is `the-dock-becomes-its-own-document.md`, which depends
  on this.
- **Not extracting the sidebar, groups, layout or kanban panes.** They stay in the panel. The module
  is one terminal, not a smaller panel.
- **Not touching the pty host, the WebSocket protocol, or any server route.**

## Metadata

**Complexity:** 7
**Tags:** frontend, refactor, ui, reliability

## User Review Required

None.

**The module is one terminal, not one pane.** A terminal on screen is a box inside a box: the pane
carries a title bar, plan title, action buttons, a drop target and input-state chips; inside it sits
the viewport — xterm and its WebSocket. **The module is the inner box.** Whoever embeds it draws its
own frame.

The dock does not want the outer box. Drop targets exist for dragging terminals around a pane grid,
which the dock has not got; the popout button pops a pane out of that grid. Bundling them would ship
the dock chrome it must then switch off with flags — which is exactly how the `isDockFrame` guards
in `dock-frames-do-not-know-they-are-docks.md` accumulated. Revisit once the boundary is real code
rather than a paragraph, but start narrow.

**No interim duplication, accepted.** The panel is the module's only consumer until the dock document
lands, so this ships as a pure refactor with nothing visible to show for it. That is the price of not
duplicating 1,700 lines of xterm and WebSocket handling later.

## Complexity Audit

### Routine

- Moving functions with no cross-section callers.

### Complex / Risky

- **This is the hardest code in the repository, and its difficulty is invisible in a diff.** Three
  hazards are documented in comments at the extraction sites and every one is a silent-corruption
  class, not a crash:
  - **WebGL glyph model.** *"A grid resize invalidates the WebGL glyph model, and xterm does not
    [clear it]"* (`:421-423`), referencing `GlyphRenderer.clear` in the vendored addon. A resize
    path that loses this renders garbled cells, not an error.
  - **DEC modes on reattach.** Owned by `feature_plan_20260804173903_restore-terminal-dec-modes-on-reattach.md`.
    A reattach that drops them leaves the terminal in the wrong input mode.
  - **Replay gaps.** `terminalReplayGaps` is deliberately *not* `terminalBadges`, with a comment
    explaining that the badge map feeds the shell rail's `done` light, so a gap recorded there would
    *"report a finished agent"* (`:236-240`). The two look interchangeable and are not.
- **Renderer swap is stateful across instances.** `:697` describes the outgoing renderer owning the
  surface the incoming one takes over. Module boundaries that assume instance independence break
  this.
- **The module has no DOM of its own.** It is handed a container. Every `document.getElementById`
  and panel-global it currently closes over is a hidden dependency that must become a parameter —
  and the ones that are *reads of panel state* (theme, server mode, paste identity) are the ones
  that will be missed, because they work by accident until a second embedder exists.
- **`init()` is 620 lines** (`757–1377`) of DOM wiring and listener setup, and the viewport sections
  are entangled with it. Deciding what the module initialises versus what the embedder passes in is
  the design work; the moving is mechanical after that.
- **No `dist/` audit.** Per `CLAUDE.md`, `src/` is the source of truth and testing is via VSIX.

## Edge-Case & Dependency Audit

- **Four existing embedding contexts must keep working**, and each is a separate manual check:
  the grid (multi-pane), solo mode, the popout window (`shell.js:1074`, `window.open`), and the
  dock. A regression in popout is the easiest to miss — nothing routine exercises it.
- **The CSP is per-document** (`headlessPanelHtml.ts:162`) and names `connect-src` for the WebSocket
  on loopback and `*.localhost`. A new document later inherits this; the module must not assume a
  particular document's policy.
- **Both hosts serve the webview tree** via `getShellHtml` / `getPanelHtmlById`
  (`headlessPanelHtml.ts:621`), wired in `bootstrap.ts` and `TaskViewerProvider.ts`. This plan adds
  no route and no seam, so it reaches both without composition-root work — assert that rather than
  assume it.
- **Theme fan-out** posts to dock frames by name (`shell.js:400-410`). The module must accept a theme
  update from its embedder rather than listening globally, or a second embedder gets no theme.
- **No `confirm()`**, per `CLAUDE.md`.

## Proposed Changes

### 1. Draw the boundary before moving anything

Write down the module's public surface first — create, attach to a container, connect, resize,
theme, write, dispose — and the events it emits back. The design decision is which side of that line
`materializeTerminalView` and the server-mode/paste-identity reads fall on. Moving code before the
surface is agreed is how a refactor becomes a rewrite.

### 2. New `src/webview/terminalViewport.js`

Move the seven sections listed above. No panel globals: every dependency becomes a constructor
argument or a method parameter.

### 3. `terminals.js` becomes the first consumer

Delete the moved code; call the module. The panel keeps its sidebar, groups, layout, panes and
kanban rendering untouched.

### 4. Prove equivalence

The verification below is the deliverable as much as the module is.

## Verification Plan

### Automated Tests

1. **Byte-identical stream handling.** Feed a recorded pty stream through the module and through the
   pre-extraction path; assert the resulting buffer matches. This is the assertion that a "pure
   move" actually was one.
2. **Replay gap is recorded in `terminalReplayGaps`, never in `terminalBadges`.** The specific
   confusion the code comments warn about, and one whose symptom is a false "agent finished" light
   rather than a failure.
3. **DEC modes survive a reattach** — the invariant its own plan established.
4. **A resize clears the WebGL glyph model.** Asserted on the call, since the visual symptom is
   garbled cells that no test would otherwise see.
5. **Renderer swap across instances** leaves the incoming renderer owning the surface.
6. **The module reads no panel global.** Source-level: `terminalViewport.js` contains no
   `document.getElementById` and no reference to panel state names. This is the gate that stops a
   hidden dependency surviving the move and working by accident until a second embedder exists.
7. **All four contexts still render** — grid, solo, popout, dock — as an integration pass.
8. **Both hosts unchanged.** No new route, no new seam; assert the composition roots are untouched
   by this diff.

### Goal Invariants

- Drawing and streaming one terminal is possible without loading the Terminals panel.
- The Terminals panel behaves identically to before, in all four embedding contexts.

### Manual

- Open the grid with several terminals; resize aggressively; no garbled cells.
- Pop out a terminal, work in it, close it.
- Reattach after a disconnect; check input mode and that no replay gap reports as a completion.
- Switch theme with terminals live in the grid, a popout and the dock.
