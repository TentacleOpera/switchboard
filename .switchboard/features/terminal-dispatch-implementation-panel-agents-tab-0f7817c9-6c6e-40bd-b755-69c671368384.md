---
description: 'Terminal Dispatch & Implementation Panel Agents Tab'
---

# Terminal Dispatch & Implementation Panel Agents Tab

**Complexity:** 6

## Goal

Fix terminal targeting reliability and improve the Implementation panel's Agents tab UX. Today, clipboard paste actions sometimes target the wrong terminal (the paste goes to a different terminal than the one that was focused), the per-terminal Locate/Clear buttons are left-justified and ungrouped (making them hard to scan visually), and the Implementation panel's Agents tab doesn't track extra planner terminals (so agents launched in additional terminals are invisible in the UI).

## How the Subtasks Achieve This

- **Bug: Clipboard Paste Targets Wrong Terminal During Send-to-Terminal Actions**: When a user sends text to a terminal via clipboard paste, the paste sometimes lands in a different terminal than the intended target. Root cause is a race between terminal focus tracking and the paste dispatch — the paste uses a stale focused-terminal reference. This plan fixes the focus tracking to be atomic with the paste dispatch, ensuring the paste always targets the terminal that was focused at click time.

- **Right-Justify and Group the Per-Terminal Locate/Clear Buttons**: The Locate and Clear buttons for each terminal are currently left-justified and visually scattered, making it hard to tell which buttons belong to which terminal. This plan right-justifies the buttons and groups them as a single button cluster per terminal row, improving visual scannability and reducing mis-clicks.

- **Make the Implementation Panel Agents Tab Track Extra Planner Terminals**: The Implementation panel's Agents tab only shows agents in the primary planner terminal. When a user launches additional planner terminals (e.g., for parallel agent work), those agents are invisible in the tab. This plan extends the Agents tab to discover and track all planner terminals, showing agents from every terminal with a terminal label for disambiguation.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Bug: Clipboard Paste Targets Wrong Terminal During Send-to-Terminal Actions](../plans/feature_plan_20260626100852_clipboard_paste_wrong_terminal.md) — **CODE REVIEWED**
- [ ] [Right-Justify and Group the Per-Terminal Locate/Clear Buttons](../plans/feature_plan_20260626124053_terminal_locate_clear_buttons_right_justified.md) — **CODE REVIEWED**
- [ ] [Make the Implementation Panel Agents Tab Track Extra Planner Terminals](../plans/feature_plan_20260626130005_implementation_tab_track_planner_terminals.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

