---
description: 'Tickets Tab File-Backed Sync Correctness'
---

# Tickets Tab File-Backed Sync Correctness

**Complexity:** 6

## Goal

Make the Tickets Tab local file layer faithfully reflect remote provider state — both deletions and project-selection-driven imports. The file-backed sync refactor established the substrate (delta pull, per-list/project cursor, cache DB entries, local-file rendering); these two plans close the correctness gaps it left: remote deletions leave ghost files, and the Linear project picker never triggers an import at all. Both plans depend on the same file-backed sync infrastructure and address the same capability (local-file-layer fidelity to remote state).

## How the Subtasks Achieve This

- **Respect Remote Deletions in Delta Pull**: Adds a deletion sweep that diffs the full remote ID set against the local cache DB entries (scoped per list/project directory) and removes the local `.md` file + cache entry for any ticket deleted/archived/trashed remotely. Handles the Linear 100-issue cap via a new uncapped `fetchAllIssueIds` method, and includes fetch-failed vs. empty-list disambiguation so a failed API call never triggers deletions.
- **Linear Project Picker Change Triggers File-Backed Import**: Wires the Linear project picker `change` handler to send `refreshTicketsDelta` (the same message the Refresh button and `linearProjectLoaded` handler already send), so selecting a project immediately imports/delta-pulls tickets for that project — achieving parity with ClickUp's list-select dropdown. Uses the project name directly (not UUID) to preserve cursor-key consistency across all trigger paths.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Linear Project Picker Change Triggers File-Backed Import](../plans/feature_plan_20260629130647_linear-project-picker-triggers-import.md) — **CODE REVIEWED**
- [ ] [Respect Remote Deletions in Delta Pull](../plans/feature_plan_20260629130652_respect-remote-deletions-in-delta-pull.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->
