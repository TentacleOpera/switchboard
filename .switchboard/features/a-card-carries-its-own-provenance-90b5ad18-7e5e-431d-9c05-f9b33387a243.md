---
description: 'A Card Carries Its Own Provenance'
---

# A Card Carries Its Own Provenance

## Goal

A card records what column it is in and nothing about who it is for or what it produced. Two additions close that: a card can name who is meant to pick it up, with the board filtering to yours; and a card shows the commit its work produced, read-only, from anywhere. Both make a card answerable without opening the plan file or the git log.

## How the Subtasks Achieve This

- **A Card Can Name Who Is Meant to Pick It Up, and the Board Can Filter to Yours**: adds an intended-owner dimension to a card and a board filter over it, so a person or agent can see their own work without reading every column.
- **A Card Shows the Commit Its Work Produced, Read-Only, From Anywhere**: links a card to the commit that came out of it, readable without a local checkout — closing the loop between a card and its result.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A Card Can Name Who Is Meant to Pick It Up, and the Board Can Filter to Yours](../plans/a-card-can-name-who-is-meant-to-pick-it-up-and-the-board-can-filter-to-yours.md) — **PLAN REVIEWED** — ID: 8846b538-84b6-46d1-b750-06a34d9a001c
- [ ] [A Card Shows the Commit Its Work Produced, Read-Only, From Anywhere](../plans/a-card-shows-the-commit-its-work-produced.md) — **PLAN REVIEWED** — ID: abdf578a-e64a-42cb-91de-b13737036066
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. Both add a read-only field to the card surface and do not interact.
