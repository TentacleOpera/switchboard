# Status View Is the Default for Every Seat Except the Lead

## Goal

A seat pane opens in **status view** unless it is the team lead, and that view is worth looking at: the
seat's CLI brand mark large in the centre of the pane, and a prominent **Terminal view** button under
it. Rendering a live xterm becomes the deliberate choice, not the default for every pane on the grid.

### Problem analysis

**The status view already exists and is not what was asked for.** `paneModes[i] === 'status'` selects
it and `renderStatusPane` (`terminals.js:6793`) draws a `.status-pane-card` — identity row, name,
crown, role, plan, declared state, kind. It is a small text card in a large empty pane. It does not
carry the seat's brand, and there is no obvious way from inside the pane to switch to the terminal;
the only control is a toolbar button (`.btn-output-pane.is-status`).

It is also **off by default**, so every pane on the grid renders a live terminal whether or not anyone
is reading it.

#### Why the default is wrong, measured

Today's work turned up three costs that are all paid per *rendered* pane, and all avoidable for a seat
nobody is watching:

1. **WebGL churn.** Six layout switches with ONE terminal produced 9 context acquires and 9 releases,
   plus 33 `ResizeObserver` callbacks (see *Every Layout Switch Releases and Re-Acquires a WebGL
   Context Per Terminal*). The per-document ceiling is `MAX_WEBGL_CONTEXTS = 12`; a 3×3 grid of live
   seats approaches it, and panes past it silently fall back to the canvas renderer.
2. **tmux size contention.** Grouped sessions share a window list, so every attached client votes on
   window size. Four browser panes at 221×40 against an SSH client at 183×53 produced a viewport
   mismatch that made panes repeat their bottom line. Fewer live clients is fewer votes.
3. **Output bandwidth.** Every rendered pane is a live WebSocket consuming its seat's output, and
   `transport.js` already fans each push out 6× because it ignores `msg.surface`.

A grid of nine seats is nine of each. In practice the operator is reading one — usually the lead,
because that is where judgement happens and where a team's commit is decided.

#### What the pane should show

- **The seat's CLI brand mark, large and centred.** The board already resolves these:
  `brandIconForCliLabel` maps a CLI label to a key and `brandIconUri` resolves it from the
  `data-brand-icon-*` attributes, covering 19 brands including the Ollama mark added 2026-09-08. At
  pane size the mark identifies the seat's vendor instantly, which four lines of grey text do not.
- **A prominent `Terminal view` button beneath it.** Switching to the live terminal is the pane's
  primary action and belongs in the pane, not only in a toolbar.
- **The status facts kept, demoted.** Name, role, plan and declared state stay — smaller, under the
  button. The card's content is not the problem; its prominence and its emptiness are.

### The lead is the exception

The lead opens in terminal view because it is the seat the operator actually watches: it triages what
members return, and a team commits once as its head. Every other seat is doing work that is reported,
not read.

## Metadata

**Complexity:** 4
**Tags:** terminals, ui, performance
**Dependencies:** none

## User Review Required

None.

## Proposed Changes

### 1. Default `paneModes` to `status` for non-lead seats (`src/webview/terminals.js`)

- **Logic:** When a pane is first assigned a seat, choose `status` unless that seat is its team's head.
  An explicit operator choice always wins and persists — this changes the *initial* mode only.
- **Edge cases:** A seat with no team (an individual `+` seat) is not a member of anything and opens in
  terminal view — the operator opened it deliberately. A solo/popout pane is always terminal view.

### 2. Rebuild the status card around the brand and the button

- **Logic:** Centre the seat's brand mark, with `Terminal view` directly beneath it and the existing
  status facts below that, smaller. Resolve the mark through `brandIconForCliLabel` /
  `brandIconUri` — do not add a second brand table.
- **Edge cases:** An unknown CLI falls back to `brand-cli-default.svg`. An exited seat keeps the
  existing `.is-exited` dimming.

### 3. Switching to terminal view must not cost a reconnect

- **Logic:** The seat's socket and scrollback already survive a mode change — `terminalsMap` holds the
  entry whether or not it is rendered. Pressing `Terminal view` should attach the existing view, not
  create one.
- **Edge cases:** The `no move when already in place` invariant (`terminals.js:6806`) must hold: only
  re-parent when `entry.container.parentNode !== contentEl`.

### 4. A seat in status view must still be fully live

- **Logic:** Not rendering is not the same as not running. Dispatch, prompt delivery, completion
  reporting and the liveness sweep are unaffected by pane mode.
- **Rationale:** Stated because it is the obvious way to get this wrong — suspending a seat's stream to
  save work would make the pane a lie.

## Verification Plan

### Automated Tests
- A newly seated team: the lead's pane is terminal view, every member's is status.
- An individually created seat opens in terminal view.
- An explicit mode choice persists across a reload and is not overridden by the default.
- `Terminal view` attaches the existing entry — no new socket, scrollback intact.
- A seat in status view still reports completion and still receives a dispatched prompt.

### Goal Invariants
- Only panes the operator chose to watch hold a WebGL context.
- Pane mode never changes whether a seat runs, is dispatched to, or reports.
- The brand shown is resolved by the same table the title bar uses.

### Manual
- Start a four-seat team, confirm one live terminal and three brand cards, and confirm the WebGL
  count reflects one rendered pane rather than four.

## Outstanding Questions

- None.
