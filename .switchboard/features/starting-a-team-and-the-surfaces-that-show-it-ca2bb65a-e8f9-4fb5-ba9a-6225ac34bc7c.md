# Starting A Team, And The Surfaces That Show It

**Complexity:** 5

## Goal

Make starting and running a team from the Terminals panel one coherent operation, and reduce the surfaces around it to what they actually show.

Four defects compound. The start-team workspace selector is the only one in Switchboard that ignores initialWorkspaceRoot and falls through to DOM order. There is no one-click way to start every defined team - the operator opens a form, picks one team, clicks START, and repeats. OPEN AGENT TERMINALS spawns one bare terminal per visible role with no team structure, no workspace targeting and no group wiring, which is a footgun once teams exist because it bypasses team wiring, standing orders and group seating entirely. And parallel teams share one working tree, so they produce dirty commits and conflict, despite a startWorktree field that exists on team definitions but is only read on the autostart path.

Two surfaces also carry weight they have not earned: a hidden-terminal mechanism with zero callers on every path that would use it, splitting the terminal list into two projections; and a WORKTREES tab that wraps one list in five sections, three of which differ only by a filter, plus 140 words explaining what the rows already show.


## How the Subtasks Achieve This

- **Terminals Sidebar: Team-Start UX Overhaul**: makes the start-team form default to the kanban workspace like every other selector in Switchboard, adds one-click start-all-teams, and retires `OPEN AGENT TERMINALS` — which spawns a disconnected fleet bypassing team wiring, standing orders and group seating.
- **Per-Team Worktree Provisioning For Explicit Starts**: extends the existing `startWorktree` field from the autostart-only path to explicit START TEAM, so parallel teams get their own branch off the default branch instead of sharing one dirty working tree.
- **Remove Hidden Terminals**: deletes a mechanism whose every entry point has zero callers — `getUnattendedPlannerTerminal`, `getUnattendedImproverTerminals`, and no live dispatch path passing `hidden: true`. It splits the terminal list into two projections for nothing.
- **The WORKTREES Tab Is A List, Not A Console**: reduces five sections to one list plus one creation row. Three of the five differ only by a filter, each with its own header, form and prose. Creation stays — two ways to reach one verb is the existing pattern.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminals Sidebar: Team-Start UX Overhaul](../plans/terminals-team-start-ux-overhaul.md) — **PLAN REVIEWED** — ID: d7acd263-5a98-4bc4-b763-cf2ab89a4f5d
- [ ] [Per-Team Worktree Provisioning for Explicit Starts](../plans/per-team-worktree-provisioning.md) — **PLAN REVIEWED** — ID: 7c65bdf1-ccb0-4e9b-98ec-f80d85635d09
- [ ] [Remove Hidden Terminals](../plans/remove-hidden-terminals.md) — **PLAN REVIEWED** — ID: 8131f510-037f-4d47-a567-fe4575990e25
- [ ] [The WORKTREES tab is a list, not a console](../plans/worktrees-tab-is-a-list-not-a-console.md) — **PLAN REVIEWED** — ID: 1b0e8808-6fbc-4752-8fd7-8de528f52cd2
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel.

Two adjacencies to watch. `per-team-worktree-provisioning` and `worktrees-tab-is-a-list-not-a-console` both touch worktree surfaces — land them in either order, but expect edits in the same region and review the combined diff rather than each alone. `terminals-team-start-ux-overhaul` and `remove-hidden-terminals` both change what the terminal list projects, so the hidden-terminal deletion is easier if it lands first: it removes one of the two projections the start-team work would otherwise have to keep consistent.

Two constraints from the plans themselves. `per-team-worktree-provisioning` reuses the existing `tier` column with value `team`, which is disjoint from the future high/low complexity values but would affect any future code filtering `tier IS NULL` for untyped worktrees. Its `worktreeMode` field is new and optional — absent means current behaviour — so on ~4,000 installs users see no change unless they opt in, and no schema migration is required.

`remove-hidden-terminals` is the one subtask whose scope must not creep: the `ptyCreateBatch` verb accepting `hidden` is agent-reachable, so removing the parameter is a verb-contract change, not only dead-code deletion.
