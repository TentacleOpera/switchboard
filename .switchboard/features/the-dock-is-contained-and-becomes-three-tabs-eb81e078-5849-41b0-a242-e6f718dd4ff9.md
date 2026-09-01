---
description: 'The dock is contained and becomes three tabs'
---

# The dock is contained and becomes three tabs

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
- [ ] (no subtasks)
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
