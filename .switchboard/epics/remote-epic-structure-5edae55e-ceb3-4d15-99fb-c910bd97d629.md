---
description: 'Remote Epic Structure (Notion + Linear)'
---

# Remote Epic Structure (Notion + Linear)

**Plan ID:** 5edae55e-ceb3-4d15-99fb-c910bd97d629

**Coordination contract:** [Remote Control Production Readiness — Cross-Epic Sequencing & Coordination Plan](../plans/feature_plan_20260701_remote-control-production-sequencing.md) — **epic 4 of 7** in the program dispatch order.

## Goal

Make **epic parent/child structure flow through the remote-control loop** for the two driving providers, Notion (primary) and Linear (secondary). When a remote agent creates or re-links an epic on the tracker, Switchboard's poll must detect it and mirror the structure locally; and Notion must carry the schema (`Is Epic` + `Epic` relation) needed to represent an epic at all.

### Problem & background

This epic is the **remote-control slice** carved out of the former "Cross-Provider Epic Structure" epic. That epic conflated two features:

- **Tracker-structure round-trip / Tickets-tab import** (Linear import, ClickUp import, outbound epic sync) — a *separate, necessary feature* for the planning.html Tickets tab. It stays in its own epic (**Tracker-Structure Round-Trip**) and is **not** part of this remote-control program.
- **Remote epic mirroring + Notion epic schema** (this epic) — how epic structure is detected and represented during the remote-control poll.

The split keeps remote control focused: this epic covers only inbound detection + Notion representation. Outbound epic-issue creation is owned by the Tracker-Structure feature; card/content/archive push is owned by the Remote Sync Refactor trunk.

## Scope

**In:**
- **Remote Control Epic-Aware Mirroring** — during the poll, detect parent/child relationship changes (subtask added/removed, parent promoted) for **Notion + Linear** and mirror them into `kanban.db`. **ClickUp is excluded** (not a remote-control provider).
- **Notion Backup Epic Schema + Remote Agent Orientation** — add `Is Epic` checkbox + `Epic` single-property self-relation to the Notion DB schema so an epic can be represented at all, and orient the remote agent to create/assign epics via Notion MCP. The mirroring plan's Notion side depends on this schema.

**Out (owned elsewhere):**
- Linear/ClickUp import → epic (Tracker-Structure Round-Trip feature).
- Outbound epic-issue creation (Tracker-Structure Round-Trip feature).
- Card status/content/archive push (Remote Sync Refactor trunk).

## Dependencies & sequencing

- **Builds on the Remote Sync Refactor trunk.** The `parentRemoteId` / `isEpicCandidate` additions to `RemoteStateDelta` and the provider-query extensions must be made on the **refactored** `RemoteProvider` seam (post Remote Sync Refactor 1/3), not today's. Re-point the mirroring plan onto the refactored seam before coding.
- **Shipping order within this epic:** the Notion schema plan must ship with or before the mirroring plan's Notion side — Plan mirroring's Notion provider is a silent no-op without the `Is Epic`/`Epic` properties. The Linear side is independent.
- **Notion `single_property` self-relation** (research-confirmed): created via PATCH-after-create; `dual_property` cannot be created via API. No change needed to the existing approach.
- **Keep the idempotency/echo guards** (`if (plan.epicId !== parentPlan.planId)`) so outbound (Tracker-Structure feature) → inbound (this epic) does not loop.

See the coordination plan `feature_plan_20260701_remote-control-production-sequencing.md` for the full cross-epic build order.

## Metadata

**Complexity:** 7
**Tags:** backend, api, database, feature, reliability
**Repo:** switchboard

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Plan: Remote Control Epic-Aware State Mirroring](../plans/remote-control-epic-aware-mirroring.md) — **PLAN REVIEWED**
- [ ] [Plan: Notion Backup Epic Schema + Remote Agent Epic Orientation](../plans/notion-backup-epic-schema-and-remote-orientation.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
