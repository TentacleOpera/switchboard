---
description: 'Shell Cockpit Restructure'
---

# Shell Cockpit Restructure

## Goal

Rebuild the browser shell's chrome around what the operator actually does, instead of
around the order features happened to be added. The left rail becomes a fixed-height
navigation surface with a declared hierarchy: five primary panels, three fixed team slots,
four cold panels at the foot. Everything that is not navigation leaves the rail for a
floating top-right cluster. One colour carries one meaning. The right-hand dock becomes the
Mission Control surface it was always intended to be, and grows a second tab for the
terminals kanban pane. Linear gets the dedicated panel its expansion needs.

Today the rail is roughly sixteen buttons in a 48px column with no hierarchy, growing with
process count, painted in five competing hues, and hosting three controls that navigate
nowhere. The dock and the Mission Control controller already share one seat identity but
reach it by two different code paths, only one of which knows what a controller is.

## How the Subtasks Achieve This

- **Shell Rail Restructure: A Primary Group, A Cold Group, And No Process List**: Replaces
  the single optional `placement` marker with a required group key, reorders the manifest
  into primary and cold groups, and deletes the theme toggle, the UFO Mission Control
  button and the per-terminal buttons. This is the structural foundation — every other rail
  subtask assumes its groups exist.
- **A Top-Right Control Cluster For The Shell's Non-Navigational Controls**: Adds the
  shell's first chrome region outside the rail, hosting the dock toggle, Setup, Memo and
  Connections. Gives the four controls the rail could not express an affordance for a home,
  and puts the dock toggle on the same side as the dock.
- **One Colour In The Rail: Theme-Accent Team Icons, No Status Palette**: Collapses six
  treatments and five hues into one. Selection becomes a shape so the theme accent belongs
  to team icons alone, and the completion ring, queue badge and exited grayscale are
  deleted — which also removes the rail's last claim on completion state.
- **Three Fixed Team Slots In The Rail, Present Whether Or Not The Team Is Running**: Binds
  three slots to team definitions by id rather than to whatever is spawned, so the rail's
  height stops being a function of fleet state and a team can be started from the rail
  instead of only from a panel.
- **The Team In-Flight Predicate Already Exists — Expose It To The Rail**: Extracts the
  server's existing dispatch-to-completion predicate into one helper shared by the
  dispatch gate and the rail, so a team slot can show whether it is holding work without
  inventing a second definition of "in flight".
- **Opening The Dock Starts Mission Control: One Seat, One Path**: Routes the dock's
  controller start through the endpoint that seats Mission Control and delivers the
  pre-flight interview, retires role selection, and fixes the exit-code-0 dead end on the
  dock's default role. This is what makes deleting the UFO a pure deletion.
- **The Agent Dock Grows Tabs, And The Terminals Kanban Pane Becomes One Of Them**:
  Generalises the dock from one hardcoded occupant to a tabbed host, adding the existing
  kanban pane as a second tab so a card list can sit beside any panel without spending a
  terminal slot.
- **A Linear Panel: Setup, Agent Wiring, And The Instructions To Drive Switchboard From
  Linear**: Gives the Linear integration a first-class panel for setup, agent wiring and
  the operator instructions that currently exist nowhere, and takes the primary rail slot
  the restructure reserves for it.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->

## Dependencies & sequencing

Not parallel — there are four real ordering constraints, and three of them are shared-code
collisions rather than logical dependencies.

1. **Rail restructure lands first.** It declares the group key every other rail subtask
   renders into, and it deletes the UFO. Nothing else in the rail should be attempted
   against the old flat manifest.
2. **Promote the dim treatment before deleting the UFO.**
   `#strip-mission-control.mission-control-dimmed` is the shell's only "inactive, click to
   start" styling, and the team slots adopt it as `.strip-icon.is-dormant`. If the UFO's
   rules are deleted first, the team slots lose their dim state. This is named in the rail
   restructure, colour and team-slot subtasks — all three must agree.
3. **`showStripToast` survives the UFO.** It exists only for the UFO's start feedback, but
   the team slots' start-failure path uses it. Whichever of those two subtasks lands second
   must not delete it.
4. **Team slots before dispatched state.** Slots render from `running` and are shell-only;
   the dispatched state needs a server-side helper extracted from the dispatch gate. Slots
   can ship first wearing no work-state indicator at all.
5. **Dock-starts-Mission-Control before dock tabs.** It retires the role picker, and the
   tabs subtask must not carry `#dock-role-btn` / `#dock-role-menu` into the new tabbed
   header. Landing tabs first means building a picker into the header and then removing it.

Independent of the rest: the **Linear panel** shares only its manifest entry with the rail
restructure, so it can proceed in parallel once the group key exists. The **top-right
cluster** depends on the rail restructure only for the dock toggle's removal from the left.

## No migration across this feature

Every subtask takes a clean break. No migrations, no compat shims, no legacy-key
preservation, no `*.migrated.bak` archives — CLAUDE.md's migration rule is deliberately
waived for this release. Implementing agents must not add compat paths on their own
initiative; each subtask states this in its own body so the exemption travels with the
work.
