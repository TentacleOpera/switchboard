# Agent Control becomes its own panel

**Complexity:** 5

## Goal

Move Agent Control out of kanban.html into a panel file of its own, give it an Orders tab, and retire the agent tabs it leaves behind. These are one unit because they edit the same markup in sequence: extracting first means the Orders tab is added once, in its final home, and the old tabs can then be removed without leaving the board without a control surface.

## How the Subtasks Achieve This

- **Extract Agent Control into its own panel file**: lifts Agent Control out of `kanban.html` into a panel of its own. This is the move that makes the other two cheap.
- **Add an Orders tab to Agent Control**: adds the Orders tab. Done after the extraction, it is written once in its final home rather than added to `kanban.html` and then moved.
- **Retire the agent tabs from kanban.html**: removes what the extraction left behind, once the new panel is carrying the function.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add an Orders tab to Agent Control](../plans/add-an-orders-tab-to-agent-control.md) — **PLAN REVIEWED** — ID: 6b9d97ce-60da-43d2-b1ab-6e574f27e1b7
- [ ] [Extract Agent Control into its own panel file](../plans/extract-agent-control-into-its-own-panel-file.md) — **PLAN REVIEWED** — ID: 1e9a9b79-abd5-46ef-9b78-31beb778cd77
- [ ] [Retire the agent tabs from kanban.html](../plans/retire-the-agent-tabs-from-kanban-html.md) — **PLAN REVIEWED** — ID: 02aa2bd1-26cc-492f-b3b4-7d826eede6f6
<!-- END SUBTASKS -->

## Dependencies & sequencing

Strictly ordered: **extract → add the Orders tab → retire the old tabs**. All three edit the same markup, so any other order edits it more than once, and retiring the old tabs before the new panel carries the function would leave the board without a control surface in between.

**Cross-feature note.** The in-flight standing-orders work has a *Standing Orders Tab in the Agent Control Panel* subtask that depends on the extraction here landing first — it has nowhere to live until Agent Control is its own panel.

