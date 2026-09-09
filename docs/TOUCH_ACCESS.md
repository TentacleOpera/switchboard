# Touch & Tablet Operation Guide

This guide covers operating Switchboard from an iPad, iPhone, or touch device over a remote connection (such as Tailscale). Reaching the board over the network is documented in [`docs/REMOTE_ACCESS.md`](REMOTE_ACCESS.md); this document explains how to interact with the board once connected, what works differently on touch devices, and how to drive the controls.

---

## 1. What Does Not Work on Touch (And Why)

### HTML5 Drag-and-Drop is Inert
On iOS and iPadOS (Safari and WebKit webviews), **HTML5 drag-and-drop events (`dragstart`, `dragover`, `drop`) do not fire from touch input**. This is an operating system platform limitation, not a Switchboard bug or styling issue.

Because of this:
- **Card dragging on the Kanban board does not work.** Touching and dragging a card across columns will scroll the view or select text rather than picking up the card.
- **Terminal pane reordering is inert.**
- **Structure / column reordering rows cannot be dragged.**

The board remains fully readable, live updates stream normally, but dragging cards is impossible via touch glass.

---

## 2. Moving Cards on Touch

Touch input loses drag-and-drop, but Switchboard provides tap-friendly alternatives for moving cards.

### Moving Cards Forward (One Stage)
To advance cards forward through the workflow:
1. Tap one or more cards to select them (selection highlights them).
2. Tap the **column-header move button** (`data-action="moveSelected"`) at the top of the column.
3. All selected cards in that column advance to the next workflow stage.

> ⚠️ **DISPATCH WARNING (CLI Triggers):**
> If CLI triggers are enabled (`kanban.cliTriggersEnabled`), moving a card forward via the column header button **will automatically dispatch an agent** to begin working on the task. If your goal is board housekeeping without starting agents, disable CLI triggers first via the board toggle or settings before tapping the move button.

---

### Moving Cards Backward or to ANY Column (Project Panel)
The primary touch control for moving a card to **any column** — especially moving cards **backwards** — is located in the **Project panel**, not on the Kanban board grid.

#### Tap Sequence:
1. Open the **Project** tab in the navigation bar.
2. In the Kanban plans list, find the plan item you wish to move.
3. Tap the **column badge** displayed on the plan row (e.g. `CREATED`, `CODED`, `STAGING`).
4. Tapping the badge toggles a `<select>` dropdown menu showing all available columns.
5. Tap your desired target column from the native picker list.
6. The card immediately moves to the selected column and the dropdown closes.

#### Key Constraints & Differences from Drag:
- **One card at a time:** The Project panel dropdown operates on exactly one plan. There is no multi-select batch move through this path; moving multiple cards requires repeating the sequence for each card.
- **Verb Asymmetry (`moveKanbanPlanColumn` vs Board Drag):** Moving a card via the Project panel dropdown invokes `moveKanbanPlanColumn` rather than the board's drag handler (`moveCardForward` / `moveCardBackwards`). This creates three distinct behavioral differences:
  1. **No CLI Dispatch:** The Project dropdown path does **NOT** trigger agent dispatch, even if CLI triggers are enabled. Moving a card backward or repositioning it cannot accidentally fire an agent.
  2. **No Run Sheet Recorded:** Moves through the dropdown do not invoke `recordRunSheetForColumnMove`. The transition will not be recorded in the `plan_events` history table.
  3. **No Queue Position or Column Order Cleanup:** Leaving `STAGING` via the dropdown does not clear `queue_position`, nor does it reset custom `column_order` indices. Stale ordering metadata may persist until updated by a subsequent board move.

---

## 3. What Works Normally on Touch

Most Switchboard surfaces work out of the box on tablets:
- **Terminal Panes:** Terminal typing (via on-screen or Bluetooth keyboard), scrolling scrollback, switching tabs, and resizing panes via tap controls.
- **Navigation & Panels:** Switching tabs (Kanban, Project, Tickets, Memo, Worktrees, Automation), expanding collapsibles, filtering lists, and searching.
- **Memo Capture:** Entering `/switchboard-memo` or using the Memo sub-tab to append notes and instructions.
- **Review & Diff Views:** Expanding cards, reading plan previews, viewing diffs, and inspecting run state.

---

## 4. Genuinely Unavailable Capabilities

### Copying Text Out of a Terminal
Copying text out of an active terminal session on touch is currently unavailable. Switchboard terminals render via xterm.js using WebGL or HTML5 canvas (`@xterm/addon-webgl` / `addon-canvas`). Because the output is drawn to a canvas rather than rendered as DOM text nodes, mobile Safari cannot perform long-press text selection on the terminal buffer.

*(Note: Insecure-context clipboard copying for Switchboard UI buttons like "Copy Prompt" or "Copy Plan" is fully supported via the fallback described in `docs/REMOTE_ACCESS.md`.)*

---

## 5. Tablet vs. Phone

- **iPads / Tablets:** Tablet screens (10"–13") comfortably display the full Switchboard interface, including the split-pane Project panel and Kanban columns. Tablets are fully supported touch control surfaces using the Project panel workflow described above.
- **Phones:** Phone screens are too narrow for dense side-by-side split panels and multi-column boards. While the board is accessible on a phone, driving the full Project panel is cramped. (Dedicated mobile-focused touch paths and narrower views are tracked in separate plans).

---

## 6. Architecture Note

Documenting the Project panel as the primary touch control surface establishes an intentional architectural dependency. Changes to `project.js` plan item actions or badge event wiring must preserve tap-accessibility and touch-screen compatibility.
