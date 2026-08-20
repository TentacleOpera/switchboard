# A Team Is a First-Class Object You Can See, Configure and Drive

**Complexity:** 8

## Goal

Today a team exists as a definition in the TEAMS tab and as a scatter of terminals on the grid, with nothing joining the two. A live terminal cannot say which team it belongs to, the shell strip labels seats by CLI rather than by team, there is no view scoped to one team, and driving a team means sending it one prompt at a time.

This feature makes the team the unit the UI is built around. It starts with an identity link from a live team back to its definition, gives teams a visible identity through icons, adds a team-scoped cockpit and an action bar for bulk lifecycle and roster order, and then makes a team drivable: a work queue instead of one-prompt-at-a-time dispatch, an editable standing-orders surface for the team and team-head scopes, and scheduled automation that can target a team lead.

## How the Subtasks Achieve This

- **Link a Live Team Back to Its Definition (Team Identity Foundation)**: Records at team-spawn time which team *definition* a live team came from, so any surface can resolve a running terminal to its team and read that team's icon, name, head and roster. This link does not exist today and is the single blocker under every other subtask here.
- **Team Icons: Choose or Customise an Icon per Team in the TEAMS Tab**: Adds an `icon` field to the team definition and the TEAMS-tab editing for it. The authoring half of team identity — the shell strip and the cockpit are its consumers.
- **Shell Strip: Team Icons in Place of Per-Terminal CLI Icons**: Turns the shell rail from one button per terminal into one button per team wearing that team's icon, with unaffiliated terminals keeping an individual button. Clicking a team opens its cockpit, so the rail reads as a roster of squads rather than a list of processes.
- **Agent & Team Pixel Art: Drop PNGs in `icons/`, Render Them Everywhere**: Makes an externally-authored pixel-art PNG usable by dropping it into `icons/` under a name convention — one resolver, one CSS treatment, integer display sizes so raster art is not blurred, and a fallback to today's placeholders so a half-populated set still looks right.
- **Team Cockpit: A `?team=<id>` Scoped Terminals View**: A second, focused Terminals view scoped to one team — its terminals only in the sidebar and the grid, its icon and name in the header. The general-purpose panel is untouched.
- **Team Action Bar: Bulk Lifecycle and Roster Order**: Puts the team-wide verbs into the cockpit header — clear the team, close the team, restart missing members, reorder the roster. Each is currently a per-terminal chore repeated N times, or impossible.
- **Team Work Queue: Queue Work to a Team Instead of Dispatching One Prompt at a Time**: Gives each team a durable, visible queue that holds plans, cards and ad-hoc prompts and hands them to the head (or fans them out) as capacity frees. Today every dispatch is a single fire-and-forget prompt with nowhere to put the next one.
- **Team Standing Orders: Make the Team and Team-Head Scopes Editable**: Surfaces the team and team-head standing orders in the cockpit for reading and editing. Both scopes are already implemented end to end in the backend and are reachable from no UI.
- **Scheduled Automation Targeted at a Team Lead**: Lets an automation address a specific team's lead, and be triggered on demand from the cockpit. Scheduled work currently cannot address a team at all — it spawns its own anonymous terminal outside any team.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Scheduled Automation Targeted at a Team Lead](../plans/scheduled-automation-targeted-at-a-team-lead.md) — **LEAD CODED**
- [ ] [Team Action Bar: Bulk Lifecycle and Roster Order](../plans/team-action-bar-bulk-lifecycle-and-roster-order.md) — **LEAD CODED**
- [ ] [Shell Strip: Team Icons in Place of Per-Terminal CLI Icons](../plans/shell-strip-team-icons-instead-of-per-terminal-cli-icons.md) — **LEAD CODED**
- [ ] [Team Icons: Choose or Customise an Icon per Team in the TEAMS Tab](../plans/team-icon-picker-in-teams-tab.md) — **LEAD CODED**
- [ ] [Link a Live Team Back to Its Definition (Team Identity Foundation)](../plans/team-identity-link-live-team-to-its-definition.md) — **LEAD CODED**
- [ ] [Team Work Queue: Queue Work to a Team Instead of Dispatching One Prompt at a Time](../plans/team-work-queue.md) — **LEAD CODED**
- [ ] [Team Standing Orders: Make the Team and Team-Head Scopes Editable](../plans/team-standing-orders-editor.md) — **LEAD CODED**
- [ ] [Team Cockpit: A `?team=<id>` Scoped Terminals View](../plans/team-cockpit-scoped-terminals-view.md) — **LEAD CODED**
- [ ] [Agent & Team Pixel Art: Drop PNGs in `icons/`, Render Them Everywhere](../plans/agent-and-team-pixel-art-pipeline.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Team identity is the foundation and lands first.** Every other subtask resolves a live terminal to its team definition; without that link the icon has nothing to attach to, the cockpit cannot select a roster, and an automation cannot name a lead.
- **Icons are authored before they are worn.** The TEAMS-tab icon picker writes the `icon` field that the shell strip and the cockpit header read. The pixel-art pipeline is the asset path feeding both and can land in parallel with the picker — it falls back to today's placeholders, so neither blocks the other.
- **The cockpit precedes what lives inside it.** The action bar, the standing-orders editor and the automation's on-demand trigger are all surfaces in the cockpit header. The shell strip's team button is what opens the cockpit, so the strip and the cockpit are a pair.
- **The work queue depends only on identity**, not on the cockpit, and can proceed alongside the icon and cockpit work.

Rough order: identity → (icon picker ‖ pixel art) → cockpit ‖ work queue → shell strip → action bar ‖ standing orders ‖ scheduled automation.

