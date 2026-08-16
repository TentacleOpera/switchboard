# TEAMS Tab — Pick a Team From Three Cards and See It Drawn

## Goal

Turn the TEAMS tab into a picture. You land on three team cards with pixel-art portraits. You click one and the team draws itself below — head at the top, members beneath, arrows for who reports to whom — and you start it from there. Building your own team stays possible, but it is a link under the three cards, not the front door.

### Why

The tab is a form. The three team types already exist as data (`SHIPPED_TEAM_TYPES`, `kanban.html:4396`) — Batch planners, Coding, Multi-agent planning — but they render as text cards next to a members editor with `role` / `count` / `scope` / `relationship` dropdowns. To find out what a team *is*, you read a roster and assemble it in your head.

Everything needed to draw a team is already in the definition: `headRole`, and `members[]` with `role`, `count` and `relationship`. Nothing new has to be stored or computed. The tab just never drew it.

The customisation surface is also backwards. Almost nobody wants to invent a team topology; they want to pick one. The editor should be reachable, not primary.

## What you see

**Three cards, side by side.** Each carries:

- a pixel-art portrait of the head agent (planner, lead, planner-with-fan-in),
- the team name,
- its one-line purpose (already in the data: *"Works a feature's subtasks one at a time, then hands each to the team reviewer."*),
- a compact roster strip — `LEAD · 3 CODER · 1 REVIEWER`.

**Click a card and the flow draws itself** in a panel below the row:

```
            ( LEAD )
               │
    ┌──────────┼──────────┐
 (CODER)    (CODER)    (CODER)
    └──────────┼──────────┘
               │
          ( REVIEWER )
```

Nodes are the same pixel-art figures at small size. Arrows are typed by `relationship`: `reports-to-head` draws member → head; `reviewer` and `researcher` draw their own edge with a distinct label. A `count` of 3 draws three nodes, not a "×3" badge.

**START sits on the flow panel**, so you start the thing you are looking at.

**Under the three cards: `+ Build your own`.** It opens the existing form unchanged. A saved custom team gets a fourth card with a generic portrait, and draws the same way.

## The art

Match `switchboard-site/public/assets/*-detailed.svg` exactly — that is the house style and it is already the extension's theme:

- inline SVG, authored by hand, no image files and no external requests;
- every shape a `<rect>` on a 4px grid with `shape-rendering="crispEdges"`;
- three-tone cyan ramp — `#00e5ff` body, `#7ff3ff` highlight, `#00b8cc` shadow — on `--surface-container`;
- one `feGaussianBlur` glow filter, reused by reference.

Four portraits: **planner**, **lead**, **researcher/coder**, **reviewer**. They double as the flow-diagram nodes at small scale, so author them once at a single cell size and scale by whole multiples to keep the grid crisp.

## The animation

On pick, the diagram draws itself: nodes fade in top-down, staggered ~60ms; each arrow strokes on via `stroke-dashoffset` over ~220ms after its nodes land. Once settled, a slow pulse travels head-ward along the arrows — the idle state, showing direction of reporting.

Nothing here is wired to running agents. It animates because you picked a team, not because a team is doing something.

Under `prefers-reduced-motion: reduce`, the diagram appears complete with no draw-in and no pulse.

## Where the work lands

All in `src/webview/kanban.html`, in the `teamsTab*` functions that already own this markup:

- `teamsTabGalleryCard` (`:4523`) — card body becomes portrait + name + purpose + roster strip; the whole card becomes the click target.
- `teamsTabCustomCard` (`:4583`) — demoted to the `+ Build your own` link beneath the row.
- `teamsTabRenderGallery` (`:4505`) — renders the row, tracks which card is picked.
- **New** `teamsTabRenderFlow(group)` — derives nodes and edges from `headRole` + `members[]` and emits the SVG. One function, one input, no state of its own.
- `teamsTabShowGroupForm` / `teamsTabSaveAgentGroup` — unchanged.

The head-role collision rules, the claimed-role disabling, and `terminals.agentGroups` storage all stay as they are. This is the tab's presentation, not its model.

## Metadata

**Complexity:** 4
**Tags:** ui, ux, frontend

## Verification Plan

Open the TEAMS tab and look at it:

1. Three cards with portraits, purposes and rosters — no dropdowns visible on landing.
2. Click Coding → a lead, three coders and a reviewer draw in, staggered, arrows last.
3. Click Multi-agent planning → the diagram changes to that team's shape; two researchers, not a "×2".
4. START on the flow panel starts the team you are looking at.
5. `+ Build your own` opens the existing form; save one and it appears as a fourth card that draws like the rest.
6. With reduced motion on, the diagram is simply there.
7. Nothing in the SVG references a URL — confirm no network requests from the tab.
