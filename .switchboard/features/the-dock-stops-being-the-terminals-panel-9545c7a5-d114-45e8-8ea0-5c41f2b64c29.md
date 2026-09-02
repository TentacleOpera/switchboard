---
description: 'The dock stops being the Terminals panel'
---

# The dock stops being the Terminals panel

**Complexity:** 7

## Goal

Extract the terminal viewport out of `terminals.js` and give the dock its own document, so showing
one terminal no longer means loading a 13,037-line panel.

By the file's own section map, a dock terminal tab needs roughly 1,700 lines — the viewport, its
stream, and theming. The other ~8,000 are sidebar, groups, layout, panes, kanban rendering, team
creation and modals that the dock loads and never uses. The sidebar an operator sees flash on open
is `renderSidebarList`: 364 lines rendering something the CSS then hides.

The weight is behavioural, not just bytes. `terminals.js` carries 33 `isSolo` and 4 `isDockFrame`
guards — 37 places asking which slot they are in — and that defect class keeps producing while the
dock is a parameterised panel.

## How the Subtasks Achieve This

- **Extract the terminal viewport into a shared module**: lifts xterm setup, sizing, theme, view
  materialisation, the WebSocket, and write batching and replay into a module anything can embed,
  with the Terminals panel as its first consumer and no behaviour change. The module is one
  terminal, not one pane — the embedder draws its own frame.
- **The dock becomes its own document**: one `/dock` page owning the tab strip, embedding a viewport
  for Agent and CLI, and rendering the Fleet table itself. The shell hosts one frame instead of
  three, and the Fleet tab needs no terminal code at all.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Extract the terminal viewport out of the 13,000-line Terminals panel into a module anything can embed](../plans/extract-the-terminal-viewport-into-a-shared-module.md) — **PLAN REVIEWED** — ID: a3a565fe-cf22-4703-b599-2fecdbc04b27
- [ ] [The dock becomes its own document — one `/dock` page, three tabs, one iframe](../plans/the-dock-becomes-its-own-document.md) — **PLAN REVIEWED** — ID: 28173753-1079-4144-a86b-475220013545
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Strictly ordered, and the long track — this is the end state, not the fix.**
`the-dock-is-contained-and-becomes-three-tabs` ships the working dock; this feature removes the
reason those guards were needed. Two of that feature's three defects cannot occur in a document
with no panel settings and no full-panel chrome, but the `switchPanel` guard is not superseded:
`transport.js` is shared by every panel including `/dock`.

The extraction is complexity 7 for one reason — three hazards that fail **silently** rather than
crashing. A resize invalidates the WebGL glyph model and xterm does not clear it, so a lost path
renders garbled cells, not an error. DEC modes dropped on reattach leave the terminal in the wrong
input mode. And `terminalReplayGaps` is deliberately not `terminalBadges`, because the badge map
drives the shell rail's `done` light — a gap recorded there reports a finished agent.

Verification therefore leads with a recorded-stream equivalence test rather than "does it still
render", and with a source-level gate that the module reads no panel global. A hidden
`getElementById` survives the move and works fine until a second embedder exists.

## Team Dispatch Instructions

### Extract the terminal viewport out of the 13,000-line Terminals panel into a module anything can embed

- **Seat:** Lead Coder (complexity 7)
- **Acceptance:**
  - A recorded pty stream fed through the module produces a byte-identical buffer to the pre-extraction path.
  - `terminalViewport.js` contains no `document.getElementById` and no reference to panel state names (source-level gate).
  - Replay gaps are recorded in `terminalReplayGaps`, never in `terminalBadges`.
  - All four embedding contexts — grid, solo, popout, dock — still render identically.
  - Both composition roots (`bootstrap.ts`, `TaskViewerProvider.ts`) are untouched by this diff.
- **Must not touch:** The pty host, the WebSocket protocol, any server route. The sidebar, groups, layout, panes, and kanban rendering stay in `terminals.js` — the module is one terminal, not a smaller panel.

### The dock becomes its own document — one `/dock` page, three tabs, one iframe

- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - `/dock` is served by both composition roots — `bootstrap.ts` and `TaskViewerProvider.ts` both wire it.
  - `dock.js` does not import from `terminals.js` (source-level gate — no `import … from './terminals.js'`).
  - Both seats (Agent and CLI) stay attached across a tab switch — neither socket is torn down.
  - The Fleet tab loads no terminal code — no viewport instance is constructed for it.
  - No `isDockFrame` guard survives with a live caller in `terminals.js`; no remaining URL constructs `/terminals?…&dock=1`.
- **Must not touch:** Popout terminals (`shell.js` `window.open` path — they have an `opener`, not a `parent`). The Terminals panel keeps its own route and behaviour. No new execution endpoint — the CLI tab remains a pty seat.
