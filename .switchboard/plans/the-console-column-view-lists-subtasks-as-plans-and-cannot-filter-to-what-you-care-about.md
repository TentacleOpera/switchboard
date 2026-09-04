# The Console Column View Lists Subtasks as Plans, and Cannot Filter to What You Care About

kanbanColumn: CREATED

## Goal

The CLI board console shows the cards an operator can act on: top-level work, filterable to what is starred. Not every row in the table.

### Problem analysis

The operator's stated use of the CLI is three things — monitor the fleet, see high-priority cards, dispatch them. The console makes the second impossible and the third unpleasant.

**The column view lists subtasks as if they were plans.** `cli.ts:2153` splits a column with `colPlans.filter(p => !p?.isFeature)`. The only test is "not a feature", so every subtask — a card with a `featureId`, owned by a feature and belonging to a lead — lands in the PLANS section beside genuine top-level work.

Measured on this board, the Planned column as the console prints it:

| | |
|---|---|
| features | 63 |
| top-level plans | 24 |
| **subtasks listed as plans** | **176** |

263 entries, printed in full with no paging, ending in `Select a card to dispatch [1-263]`.

**The correct filter already exists and is already used elsewhere.** `cli.ts:673-677` filters on `featureId === ''`, and the ready/dispatch view applies it — the comment at `:1162` states outright that subtasks are excluded from that view. The column browser simply does not call it.

**Dispatching from that list is worse than noisy.** A subtask belongs to a feature whose lead allocates it. Offering all 176 as direct dispatch targets invites exactly the seat-level dispatch the team model exists to replace.

**Starred is sorted on but never filtered on.** `compareConsoleCards` reads `priorityStarred` (`:730`) and `formatConsoleCard` prints a `★` (`:756`), so starred cards float to the top of each section. There is no way to show only them. With 20 starred cards board-wide, "see my high-priority cards" means scrolling 263 lines to read 14.

## Metadata

- **Complexity:** 3
- **Feature:** The /switchboard front door
- **Tags:** cli, ux, board

## User Review Required

None.

## Proposed Changes

### 1. Exclude subtasks from the column view

Apply the existing `featureId === ''` filter at `:2153`. A column shows its features and its top-level plans — the same set every other dispatch surface already shows.

On this board that takes the Planned column from 263 entries to 87.

### 2. Reach a feature's subtasks through the feature

Selecting a feature lists its subtasks. That is where they are addressable, in the context that says which feature owns them and which lead allocates them — not flattened into the column beside unrelated work.

### 3. A starred filter, not just a starred sort

Add a filter that shows only starred cards, in the column view and across columns. The data is already read by the comparator; this is a predicate, not new plumbing.

Across-columns matters more than per-column here: the question is "what is high priority", not "what is high priority in Planned".

### 4. Page or cap the listing

Even at 87 a column does not fit a phone screen, and the console's whole value is being usable over ssh from a small client. Show a screenful with a way to continue, rather than printing everything and asking for a number between 1 and N.

## Edge-Case & Dependency Audit

1. **A subtask genuinely needing direct dispatch** is reachable through its feature (change 2). Nothing becomes unreachable, it stops being listed where it does not belong.
2. **A feature with no subtasks in that column** still lists — column membership is per card, and a feature can sit in a different column from its subtasks. Do not filter features out for having no visible children.
3. **The ready/dispatch view already does this correctly** and must not change. This is bringing the column browser in line with it, not inventing a policy.
4. **The starred filter must be an explicit mode**, shown in the header, so an empty list reads as "nothing starred here" rather than "no cards".
5. **Numeric selection has to stay stable across paging** — a card's number must not change meaning when the page does.
6. **Both hosts** — this is CLI-only, but the console reads the same board endpoints, so confirm nothing depends on the unfiltered shape.

## Verification Plan

1. The Planned column lists 63 features and 24 plans, not 263 entries.
2. No card with a `featureId` appears in a column's PLANS section.
3. Selecting a feature lists its subtasks, and one can be dispatched from there.
4. A starred filter shows only starred cards, and says so in the header.
5. A starred filter across columns answers "what is high priority" in one view.
6. A column longer than a screen pages rather than printing in full.
7. Selecting card N on page 2 dispatches the card shown as N on page 2.
