# The CLI Can Filter by Project, but Cannot List Them or Select Unassigned

kanbanColumn: CREATED

## Goal

`switchboard projects` lists the board's projects and how many cards each holds. The interactive console can filter by one, including the unassigned set.

### Problem analysis

`--project <name>` is accepted by `plans`, `ready` and `dispatch` (`cli.ts:19-21`, filter at `:673-681`). Three gaps make it close to unusable:

**Nothing lists the projects.** There is no `switchboard projects`. The flag requires an exact name the operator has to already know, and the only place to read one is the browser board — which is the surface the CLI exists to avoid needing.

**The interactive console has no project filter at all.** `--project` is a flag on the non-interactive subcommands. The board console, which is where an operator actually browses, cannot narrow by project.

**Unassigned is unreachable, and it is the largest set.** The filter is `String(p?.project ?? '') === projectFilter` and the empty string means "no filter", so there is no way to ask for cards with no project. On this board that is the biggest bucket by a wide margin:

| project | active cards |
| :--- | ---: |
| Browser Switchboard | 1,127 |
| Website | 11 |
| **(no project)** | **1,369** |

**Sizing note, so this is not over-invested in.** With 55% of cards unassigned and 45% in one project, project is a weak filter on this board today — starring and excluding subtasks (`9572d35f`) do far more to make the console usable. This card exists because a documented flag that cannot be discovered or fully expressed is a broken flag, not because project filtering is the answer to the filtering complaint.

## Metadata

- **Complexity:** 2
- **Feature:** The /switchboard front door
- **Tags:** cli, ux, board

## User Review Required

None.

## Proposed Changes

### 1. `switchboard projects`

List each project with its active card count, plus the unassigned count. That is the whole command. It makes `--project` usable by making its argument discoverable.

### 2. A project filter in the interactive console

Offer the same narrowing the flags already provide, picked from the list rather than typed. Show which project is active in the header so a short list reads as a filtered view rather than an empty board.

### 3. Make unassigned selectable

Empty string currently means "no filter", so "no project" cannot be requested. Give it an explicit selector distinct from absence. On this board it is the majority of cards and is currently the one set that cannot be looked at.

Keep the existing meaning of an omitted flag unchanged — this adds a value, it does not repurpose the empty one.

## Edge-Case & Dependency Audit

1. **Do not create projects from the CLI.** Only the operator creates projects, on the board. This is read and filter only.
2. **An exact-match filter with no hits** must say "no cards in project X" rather than rendering an empty board.
3. **A project name with spaces** has to survive the flag and the picker.
4. **Composes with the starred filter** from `9572d35f` — project and starred are independent axes and must be usable together.
5. **Card counts are of active cards.** Say so in the output; a project whose cards are all completed should not read as empty-and-therefore-gone.

## Verification Plan

1. `switchboard projects` lists both projects with their counts, and the unassigned count.
2. `--project` with a name from that output filters as expected.
3. The interactive console can pick a project from the list and shows it in the header.
4. Unassigned can be selected, and returns the 1,369-card set rather than everything.
5. Omitting the flag still means no filter.
6. A project filter and a starred filter apply together.
7. A name with spaces works from both the flag and the picker.
