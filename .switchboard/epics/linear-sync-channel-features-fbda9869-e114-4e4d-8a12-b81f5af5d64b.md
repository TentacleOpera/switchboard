---
description: 'Linear Sync & Channel Features'
---

# Linear Sync & Channel Features

## Goal

Extend the Linear integration beyond basic column sync. Today, Switchboard syncs kanban column changes to Linear issue status, but description changes aren't bidirectional, Linear channel issues (issues created in a shared team channel for triage) can't be interacted with from Switchboard, and Linear's free tier accumulates closed issues that should be auto-archived when the corresponding plan completes.

## How the Subtasks Achieve This

- **Linear Bidirectional Description Sync**: When a plan's description is edited locally, push the change to the linked Linear issue's description. When a Linear issue's description is edited remotely, pull the change into the local plan file. Uses the existing integration sync infrastructure, adding a description diff check to the sync payload so only changed descriptions are synced.

- **Linear Channel Issues: Analyst Chat & Extension Command Interface**: Linear issues created in a shared team channel (for triage, analyst requests, etc.) need a way to be interacted with from Switchboard without leaving the extension. This plan adds a command interface for channel issues — view, reply, and link to plans — directly from the Switchboard sidebar, bridging the gap between Linear's channel-based workflow and Switchboard's plan-based workflow.

- **Linear Free-Tier: Auto-Archive Issues on Plan Completion**: Linear's free tier has a limited number of active issues. When a Switchboard plan linked to a Linear issue is completed, the issue should be auto-archived in Linear to free up the slot. This plan adds a post-completion hook that calls Linear's archive API for the linked issue, configurable per-workspace via a toggle.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Linear Channel Issues: Analyst Chat & Extension Command Interface](../plans/linear-channel-issues-analyst-and-command.md)
- [ ] [Linear Free-Tier: Auto-Archive Issues on Plan Completion](../plans/linear-free-tier-auto-archive-on-completion.md)
- [ ] [Linear Bidirectional Description Sync](../plans/linear-bidirectional-description-sync.md)
<!-- END SUBTASKS -->
