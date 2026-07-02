---
description: 'Tracker-Structure Round-Trip (Tickets-Tab Import + Outbound Epic Sync)'
---

# Tracker-Structure Round-Trip (Tickets-Tab Import + Outbound Epic Sync)

**Plan ID:** 6fbbc3b6-9404-41f1-8314-eb5140b6db2f

**Coordination contract:** [Remote Control Production Readiness — Cross-Epic Sequencing & Coordination Plan](../plans/feature_plan_20260701_remote-control-production-sequencing.md) — **epic 5 of 7** in the program dispatch order (Notion + Linear slice only; the ClickUp members are parked, out of program scope).

> **This is a separate feature from the remote-control program.** Formerly "Cross-Provider Epic Structure (Import, Sync, Mirroring)." It has been **split**: the remote-control slice (remote epic-aware mirroring + Notion epic schema) moved to the **Remote Epic Structure (Notion + Linear)** epic. What remains here is the **planning.html Tickets-tab manual import** feature and its outbound counterpart — mapping tracker parent/subtask hierarchies to Switchboard epics, and creating tracker parent/child issues from local epics.

## Goal

Make epic parent/child relationships round-trip between Switchboard and external trackers for the **Tickets-tab import** workflow: importing a Linear or ClickUp parent-with-subtasks always produces a Switchboard epic + subtasks, and syncing a local epic outbound creates the tracker's native parent/child issues.

## How the subtasks achieve this

- **Linear Import — Parent-with-Subtasks Always Becomes Epic**: two-pass import (group → write+insert → link); fetch the full Linear hierarchy and flatten to one level. Tickets-tab manual import.
- **ClickUp Import — Parent-with-Subtasks Always Becomes Epic**: same two-pass pattern for ClickUp's nested hierarchy, flattened to one level. Tickets-tab manual import.
- **Outbound Epic Sync to Linear + ClickUp**: when a local epic syncs outbound, create a parent issue + child issues linked via the tracker's native parent/child fields. The outbound counterpart to import.

## Relationship to the remote-control program

- **Not remote control.** ClickUp is not a remote-control provider; Linear/ClickUp *import* is a bulk migration path, not the remote poll loop.
- The **remote epic-aware mirroring** (inbound structure detection during the remote poll) and the **Notion epic schema** now live in the **Remote Epic Structure (Notion + Linear)** epic.
- Keep the coordination fixes from the original epic: **insert-before-write ordering** (avoid the child-planId race), single-level flattening with cycle-safe walks, and the shipped `updateEpicStatus` / `insertFileDerivedPlan` primitives.

## Metadata

**Tags:** backend, api, database, import, feature
**Complexity:** 7
**Repo:** switchboard

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Plan: Outbound Epic Sync to Linear + ClickUp](../plans/epic-sync-outbound.md) — **PLAN REVIEWED**
- [ ] [Plan: ClickUp Import — Parent-with-Subtasks Always Becomes Epic](../plans/clickup-import-epic-linking.md) — **PLAN REVIEWED**
- [ ] [Plan: Linear Import — Parent-with-Subtasks Always Becomes Epic](../plans/linear-import-epic-linking.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
