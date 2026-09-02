---
description: 'The dock is contained and becomes three tabs'
---

# The dock is contained and becomes three tabs

**Complexity:** 4

## Goal

Make the dock behave like a dock rather than a copy of the Terminals panel, then give it the three
tabs an operator actually needs: Agent, CLI, and Fleet.

Both dock tabs today are Terminals documents — `/terminals?solo=<name>&dock=1` and
`?kanban=1&dock=1` — so every behaviour of that panel has two meanings depending on which slot it
occupies, and each one has to be individually taught the difference. Two relays were retrofitted
with dock guards and carry careful comments about the hazard; nothing enumerated the rest.

## How the Subtasks Achieve This

- **A dock frame does not know it is a dock**: fixes the three places that never asked which slot
  they were in — the dock reads the main panel's pane-scoped settings, the mode body class lands
  after first paint so full-panel chrome flashes, and `transport.js` lets a dock document post
  `switchPanel` and repaint the shell's whole content area. That last one is also the only message
  arm in the shell with no origin check.
- **The agent dock becomes three tabs**: Agent unchanged, CLI as a real pty seat running the
  `switchboard` front door, Fleet as a polled read-only seat table. The Kanban pane is retired
  rather than repaired — it duplicates the board, and the one defect specific to it dies with it.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The agent dock becomes three tabs — Agent, CLI, Fleet — and drops the Kanban pane](../plans/agent-dock-three-tabs-agent-cli-fleet.md) — **PLAN REVIEWED** — ID: c2502571-4bd0-4785-b22e-0f259d3b654f
- [ ] [A dock frame does not know it is a dock — inherited panel settings, late mode class, and a live channel to the shell](../plans/dock-frames-do-not-know-they-are-docks.md) — **PLAN REVIEWED** — ID: 14d017fb-b08a-494b-87f2-43a729d0a619
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Containment lands first.** All three of its defects follow any `?dock=1` document, so retiring
the Kanban pane does not clear them — the paint flash is already on the agent tab, and the CLI tab
the second plan adds is the same pattern and would inherit all three.

The three-tab plan's own risks are structural rather than novel: `setDockActiveTab` is written for
exactly two tabs and must be rewritten as an N-pane map rather than gaining a third `if`;
`syncDockSeat` early-returns unless the agent tab is active, which would hide a live CLI terminal;
and a persisted `activeTab: 'kanban'` sits in browser-local storage on users' machines and must
normalise, or the dock opens blank for anyone who last used that tab.

## Team Dispatch Instructions

### A dock frame does not know it is a dock — inherited panel settings, late mode class, and a live channel to the shell

- **Seat:** Intern
- **Acceptance:**
  - A `?dock=1` document does not adopt persisted `terminals.kanbanPaneColumn` values from the main panel
  - `is-kanban` and `is-solo` body classes are set before first paint (asserted on the document, not on `init()` having run)
  - A dock document does not post `switchPanel` (both the verb-map path and `window.__switchboardSwitchPanel`); a non-dock panel still can (linear.js Tickets switch works)
  - All four shell message arms carry an origin check
  - `saveLayoutSettings` still writes nothing in dock mode after the re-clamp change
- **Must not touch:** None specified.

### The agent dock becomes three tabs — Agent, CLI, Fleet — and drops the Kanban pane

- **Seat:** Coder
- **Acceptance:**
  - Exactly one pane is visible for each of the three tab ids (Agent, CLI, Fleet) — no state where two panes show at once
  - A persisted `activeTab: 'kanban'` normalises to `'agent'` on read and the normalised value is persisted back
  - Theme fan-out includes every dock frame (set-equality between the fan-out list and the set of dock iframes)
  - Fleet offline path renders offline guidance, not an empty seat table
  - No new server route is introduced (LocalApiServer route table unchanged by this diff)
- **Must not touch:** The Agent tab's seat resolution, persistence, and empty state are not changed. No new command-execution endpoint is added.
