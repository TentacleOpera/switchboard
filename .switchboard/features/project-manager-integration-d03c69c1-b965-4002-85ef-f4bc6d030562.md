# Project Manager Integration

**Complexity:** 5

## Goal

Make the Project Manager a first-class citizen of the board: promote the PM from an optional agents-tab role to a core, default-visible role (so fresh setups get a live PM terminal and the Manage button dispatches instead of clipboard-falling-back), and add a global toolbar button that sends the selected plans to the PM terminal as a targeted autonomous oversight pass (board order; coding lane WIP 1 gated on code review; planner lane with a 2-minute cooldown; complexity-routed dispatch via /kanban/dispatch).

## How the Subtasks Achieve This

- **Promote Project Manager to a Core Role (Agents Tab)**: Moves the PM row from the Optional group into the Core group in the agents tab (`kanban.html:2898` → after Analyst at `:2881`), adds `checked`, and flips the `getVisibleAgents()` default (`TaskViewerProvider.ts:4528`) from `false` to `true`. Result: fresh installs register a live PM terminal by default, so the Manage button — and the new targeted-pass button — dispatch to a real terminal instead of falling back to the clipboard. Existing users who explicitly saved the PM off keep their saved value (verified `{...defaults, ...saved}` merge order in all three persistence tiers).
- **Board → Manager: "Run Selected Plans" Targeted Pass Button**: Adds a global toolbar button beside Create Worktree (`kanban.html:2628`) that freezes the current cross-column card selection into plan records at click time (excluding feature rows and epic subtasks host-side) and delivers a targeted-pass prompt to the PM terminal via the existing `_handleDispatchProjectManager` delivery plumbing (`TaskViewerProvider.ts:22178`). The prompt drives the manage skill's §6 oversight loop with the explicit plan list as the queue: coding lane WIP 1 gated on code-review completion, planner lane overlapping with a 2-minute cooldown, per-card `cardStage` tracking in `oversight-state.md`, halt-on-failure, end-of-pass digest.

## Dependencies & sequencing

- **Cross-feature dependencies:** none new — both subtasks build on machinery already shipped 2026-07-10 (`POST /kanban/dispatch` with complexity auto-routing, manage skill §6 Column Oversight, PM-terminal delivery plumbing).
- **Shipping order within this feature:** ship **Promote Project Manager to a Core Role** first. There is no code dependency between the two, but the targeted-pass button is only usable end-to-end when a live PM terminal exists — the promotion guarantees that on fresh setups, and it also makes the pass button's manual verification path work without extra setup. The promotion is a complexity-2 change and lands in minutes.
- **Prerequisites / guards:** the targeted pass inherits `_handleDispatchProjectManager`'s API-server liveness pre-flight and the §6 single-pass guard (`oversight-state.md` in-flight check → resume-or-refuse). No interaction with autoban timers or `/orchestration/start`.
- **Shared surfaces:** both plans touch `kanban.html` and `TaskViewerProvider.ts` but in disjoint regions (agents tab + visibility defaults vs. toolbar + PM dispatch plumbing) — no merge conflict or contradiction; they can be coded in the same session or separately.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Board → Manager: "Run Selected Plans" Targeted Pass Button](../plans/board-selected-plans-to-manager-targeted-pass.md) — **PLAN REVIEWED**
- [ ] [Promote Project Manager to a Core Role (Agents Tab)](../plans/promote-project-manager-to-core-role.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

