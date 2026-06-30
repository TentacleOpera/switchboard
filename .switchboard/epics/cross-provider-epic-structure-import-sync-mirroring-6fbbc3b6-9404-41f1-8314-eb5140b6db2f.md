---
description: 'Cross-Provider Epic Structure (Import, Sync, Mirroring)'
---

# Cross-Provider Epic Structure (Import, Sync, Mirroring)

## Goal

Make epic parent/child relationships work round-trip across Linear, ClickUp, and Notion. Today, epic structure is a local-only concept — the kanban DB knows about epics and subtasks, but external trackers don't. When a Linear issue with subtasks is imported, the parent-child hierarchy is flattened. When an epic is synced outbound to Linear or ClickUp, no parent/child issues are created. Notion backups don't capture epic metadata. And Remote Control mode can't mirror epic-aware state changes.

## How the Subtasks Achieve This

- **Linear Import — Parent-with-Subtasks Always Becomes Epic**: When importing Linear issues that have subtasks (parent issue + child issues), the parent is automatically promoted to an epic and the children become its subtasks. Uses a two-pass import: first pass creates all issues as plans, second pass resolves parent/child links and promotes parents with children to epic status.

- **ClickUp Import — Parent-with-Subtasks Always Becomes Epic**: Same two-pass pattern for ClickUp. ClickUp's nested task hierarchy (list → folder → task → subtask) is flattened into epic + subtasks, matching the Linear import behavior so both providers produce identical epic structure from equivalent source data.

- **Outbound Epic Sync to Linear + ClickUp**: When a local epic is synced to Linear or ClickUp, create a parent issue for the epic and child issues for each subtask, linked via the tracker's native parent/child fields. This is the outbound counterpart to the import plans — together they make epic structure round-trip.

- **Notion Backup Epic Schema + Remote Agent Epic Orientation**: Add `Is Epic` and `Epic` relation properties to the Notion backup database schema so epic metadata is preserved in Notion backups. Also adds remote agent orientation so a Claude.ai session driving Switchboard through Notion understands epic structure.

- **Remote Control Epic-Aware State Mirroring**: When Remote Control mode polls for changes, detect parent/child relationship changes (new subtask added, subtask removed) and mirror them locally. Without this, Remote Control mode is blind to epic structure changes made in the external tracker.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Plan: Outbound Epic Sync to Linear + ClickUp](../plans/epic-sync-outbound.md) — **PLAN REVIEWED**
- [ ] [Plan: ClickUp Import — Parent-with-Subtasks Always Becomes Epic](../plans/clickup-import-epic-linking.md) — **PLAN REVIEWED**
- [ ] [Plan: Linear Import — Parent-with-Subtasks Always Becomes Epic](../plans/linear-import-epic-linking.md) — **PLAN REVIEWED**
- [ ] [Plan: Remote Control Epic-Aware State Mirroring](../plans/remote-control-epic-aware-mirroring.md) — **PLAN REVIEWED**
- [ ] [Plan: Notion Backup Epic Schema + Remote Agent Epic Orientation](../plans/notion-backup-epic-schema-and-remote-orientation.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Metadata

**Tags:** [backend, api, database, feature, docs]
**Complexity:** 7
*(No Repo line — single-repo workspace per session directive.)*

**Subtask complexity rollup:**
| Subtask | Complexity |
|---------|-----------|
| Outbound Epic Sync to Linear + ClickUp | 7 |
| ClickUp Import — Parent-with-Subtasks → Epic | 6 |
| Linear Import — Parent-with-Subtasks → Epic | 6 |
| Remote Control Epic-Aware State Mirroring | 7 |
| Notion Backup Epic Schema + Remote Agent Orientation | 5 |

The epic-level complexity (8) exceeds the max subtask (7) because it adds cross-plan coordination: round-trip consistency across 3 external providers, a create-and-wait sync convention, two-pass imports with direct DB inserts, a Notion self-relation schema, and remote relationship mirroring — all of which must compose without orphaning subtask links.

## User Review Required

All 9 questions confirmed by user (2026-06-28). Decisions are locked:

1. **1-child threshold (Plans: ClickUp Import, Linear Import):** ✅ **Yes** — a parent with only 1 child/subtask always becomes an epic. No opt-in, no threshold.
2. **Deep nesting flattening (Plan: ClickUp Import):** ✅ **Yes** — deeply nested hierarchies are flattened to a single epic with all descendants as direct subtasks. **Known fidelity limitation:** the outbound sync (Plan 1) also creates flat parent/child, so a 3-level hierarchy imported then synced back out returns as 2 levels — the original nesting is destroyed. Acceptable.
3. **Linear query depth (Plan: Linear Import):** ✅ **SCOPE CHANGE — fetch everything.** The GraphQL query must fetch the FULL hierarchy (all descendants, not just direct children). This makes the Linear import consistent with the ClickUp import (which already handles deep nesting via flattening). **Impact:** Plan 3 must extend the GraphQL query to recursively fetch `children { nodes { ... children { nodes { ... } } } }` and add the same parentId-chain flattening walk as Plan 2. This bumps Plan 3's complexity from 5 to 6.
4. **Outbound failure semantics (Plan: Outbound Sync):** ✅ **Yes** — report partial sync, do not roll back. Matches the `create-epic.js` script pattern.
5. **`promoteToEpic` sync scope (Plan: Outbound Sync):** ✅ **Yes** — `promoteToEpic` syncs outbound; the promoted plan's existing external issue becomes a parent.
6. **Remote-driven epic linkage timing (Plan: Remote Control):** ✅ **Yes** — immediate mirror during the poll. No confirm gate.
7. **No new-issue import via remote control (Plan: Remote Control):** ✅ **Accepted with future-revisit flag.** Remote control only mirrors changes to already-tracked cards. New issues must be batch-imported separately. User is unsure — flagged for future revisit if the workflow proves limiting.
8. **Notion `Epic` relation cardinality (Plan: Notion Schema):** ✅ **Single-property** — one epic per subtask, matching the local model. (Research confirmed `dual_property` can't be API-created anyway.)
9. **Restore applies epic structure (Plan: Notion Schema):** ✅ **Yes** — `restoreFromNotion` applies epic structure from Notion back to the local DB. Restore is an explicit destructive operation; the Notion DB is the source of truth.

## Complexity Audit

### Routine
- Adding two Notion properties (`Is Epic` checkbox, `Epic` self-relation) to the DB creation payload — mechanical, mirrors `_ensureColumnSelectOptions` (`NotionBackupService.ts:349`).
- Adding two optional fields (`parentRemoteId?`, `isEpicCandidate?`) to `RemoteStateDelta` — additive, no breaking change (`RemoteProvider.ts:19-24`).
- Extending the Linear remote GraphQL query to fetch `parent { id }` + `children { nodes { id } }` (Plan 4 — remote control, one level only is sufficient for mirroring since the poll only needs to detect *that* a parent/child relationship changed, not reconstruct the full hierarchy).
- Reading two Notion properties from delta-query rows (same `_queryDelta` method, reads more fields).
- Grouping the flat ClickUp/Linear task list into parent/child/standalone maps (mechanical map building). Both providers now flatten deep hierarchies to one level — Linear (user-confirmed Q3 scope change) and ClickUp (original plan).
- Writing parent files to `.switchboard/epics/` with UUID in filename — the watcher's regex (`GlobalPlanWatcherService.ts:559`) anchors to the trailing UUID in the filename, so `linear_import_<issueId>_<uuid>.md` and `clickup_import_<taskId>_<uuid>.md` both derive the correct planId.
- Linking children via `updateEpicStatus(planId, 0, parentUuid)` — one call per child.
- Adding two public methods (`syncEpicWithSubtasks`, `unlinkSubtasksFromEpic`) to each sync service — the linking primitives already exist (`LinearSyncService.updateIssueParent:1066`, `ClickUpSyncService.updateTask` with `parent?: string` at line 1395).
- SKILL.md / orientation prose updates.

### Complex / Risky
- **Linear deep hierarchy fetch (Plan 3 — user-confirmed Q3 scope change):** The GraphQL query must recursively fetch `children { nodes { ... children { nodes { ... } } } }` to capture the full hierarchy. GraphQL servers typically enforce a max query depth (Linear's limit is not documented — may reject deeply recursive queries). Mitigation: use a fixed-depth recursive fragment (e.g., 5 levels deep) which covers practical hierarchies, or fall back to iterative per-issue `children` queries for known parents. The flattening walk (parentId-chain to top-level in-batch parent) is the same defensive pattern as Plan 2 — with a visited-set for cycle safety.
- **Child-planId race condition (cross-cutting — Plans 2 & 3):** The import plans write the child file to `.switchboard/plans/` first, then insert the DB record with a known `childUuid`. The file write triggers the watcher, which mints a RANDOM planId for `.switchboard/plans/` files (UUID-from-filename derivation only applies to `.switchboard/epics/` — `GlobalPlanWatcherService.ts:556`). If the watcher's debounce fires between the file write and the import's insert, `ON CONFLICT(plan_file, workspace_id)` does NOT update `plan_id` (`KanbanDatabase.ts:1343-1349`), so the child keeps the watcher's random planId. The import's `updateEpicStatus(childUuid, ...)` then targets a non-existent planId — the subtask link is silently orphaned. **Mitigation (epic-level coordination note):** reverse the ordering in Plans 2 & 3 — insert the DB record with the known planId BEFORE writing the file, so the watcher's later ON CONFLICT preserves the import's planId.
- **The create-and-wait pattern (Plan 1):** calling `syncPlan` directly instead of through `debouncedSync` is a new calling convention. Must verify `syncPlan` has no timer-specific assumptions. Fallback: a `syncPlanAndWait` poll wrapper.
- **Subtasks without an existing external issue (Plan 1):** a subtask that has never been synced has no `linearIssueId`/`clickupTaskId`. The epic link cannot be set. Decision: skip and report in `failed`. The link is lost until the next epic-sync trigger. The "epic-aware individual sync" follow-up (making `syncPlan` check `epicId` and set parent) is explicitly out of scope but is the real round-trip closer.
- **Notion self-relation (Plan 5):** Notion relations pointing to the same database require a PATCH after creation (the DB must exist before the relation can reference it). Approach A (create without `Epic`, PATCH to add) mirrors `_ensureColumnSelectOptions` and is proven, but self-relation behavior is an external API assumption (see Uncertain Assumptions).
- **Two-pass setup sync (Plan 5):** `setupRemoteControl` currently backs up plans in a single loop. Splitting into entities-first/relations-second adds a second loop but is bounded by plan count (Notion's ~350ms rate limiter dominates).
- **Shipping order enforcement (Plans 4 & 5):** Plan 4's Notion provider is a silent no-op without Plan 5's `Is Epic`/`Epic` properties. If Plan 4 ships first, Notion epic mirroring invisibly does nothing. **Mitigation (epic-level coordination note):** Plan 5 must ship with or before Plan 4's Notion provider changes. Plan 4's Linear provider works independently (no schema changes needed).
- **Stale `@deprecated` tag on `updateEpicStatus` (`KanbanDatabase.ts:1469`):** the tag says "session_id lookup risk; callers should migrate to plan_id-based updates" but the method already takes `planId` and calls `getPlanByPlanId`. All five plans depend on this method. The tag is stale and misleading — flag for cleanup (out of scope for this epic, but do not "migrate away" from the method).
- **Stale line numbers in subtask plans:** Plan 5's `NotionBackupService.ts` references are off by ~14 lines (`autoCreateDatabase` 151→165, `_ensureColumnSelectOptions` 335→349, `_planToNotionProperties` 436→450, `_notionPageToPlanRecord` 456→470, `setupRemoteControl` 234→248). `KanbanDatabase.ts` `updateEpicStatus` is off by 15 (1455→1470). Method names are correct; implementers should navigate by method name, not line number.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Child-planId race (see Complexity Audit — Complex/Risky). The watcher can interleave between the import's file write and DB insert, orphaning the subtask link. Fix: insert-before-write ordering.
- Echo loop between outbound sync (Plan 1) and remote mirroring (Plan 4): Plan 1 pushes a Linear parent; Plan 4's next poll sees it and calls `_mirrorEpicStructure`. The idempotency guard (`if (plan.epicId !== parentPlan.planId)`) prevents a redundant write. No echo loop — verified by the guard logic.
- Parent and child both have state changes in the same poll cycle (Plan 4): both are in the `deltas` array. Order-independent — the parent's `isEpicCandidate` and the child's `parentRemoteId` are mirrored as independent writes.

**Security:**
- No new credentials or secrets. All API calls reuse existing configured tokens via `loadConfig()`.
- Remote control trusts the remote agent (no `epic_lock_columns` guard on remote-driven mirroring — Plan 4). This is a policy decision: the remote agent is authorized. If unauthorized changes are a concern, add the lock guard.

**Side Effects:**
- Direct DB inserts in the import path (Plans 2 & 3) bypass the watcher's metadata extraction on first ingestion. The watcher's later re-ingestion updates `topic`/`complexity`/`tags`/`project`/`project_id`/`updated_at` via ON CONFLICT but preserves `plan_id`/`is_epic`/`epic_id`/`clickup_task_id`/`linear_issue_id`. Net: the watcher's file-content metadata is more accurate and overrides the import's stub values — this is the desired behavior.
- `_mirrorEpicStructure` (Plan 4) writes `is_epic`/`epic_id` directly during the poll. No board refresh inside the method — the refresh happens once after all deltas are processed. Correct.
- Notion restore (Plan 5) is a destructive operation: manually un-checking `Is Epic` in Notion and restoring loses the local epic. Acceptable (restore is explicit).

**Dependencies & Conflicts:**
- **Cross-plan file ownership:** no two plans modify the same method. `LinearSyncService.ts` is touched by Plan 1 (new `syncEpicWithSubtasks`) and Plan 3 (restructure `importIssuesFromLinear`) — different methods, no conflict. `ClickUpSyncService.ts` is touched by Plan 1 (new methods) and Plan 2 (restructure `importTasksFromClickUp`) — different methods, no conflict. All other files are single-plan.
- **Plan 4 Notion side depends on Plan 5** for the `Is Epic`/`Epic` properties to exist. Plan 4's Linear side is independent.
- **Plan 1 depends on `agent-epic-creation.md`** (shipped — `createEpicFromPlanIds:8657`, `assignPlansToEpic:8786` exist). Note: `createEpicFromPlanIds` requires ≥1 subtask; `promoteToEpic`'s empty-subtask sync call (Plan 1) is fine because it calls `_syncEpicOutbound` directly, not `createEpicFromPlanIds`.
- **No new npm packages** across all five plans. All primitives exist in the codebase.

**Research-Confirmed External API Constraints (web research, 2026-06-28):**
- **Notion `dual_property` self-relations cannot be created via API.** The Notion API only supports creating `single_property` (one-way) self-relations via PATCH. Attempting to programmatically add a `dual_property` self-relation (separate "Parent" and "Child" columns in the Notion UI) silently generates a `single_property` or returns a validation error. **Impact on Plan 5:** Plan 5 already uses `single_property` — no change needed. If a cleaner Notion UX with separate parent/child columns is ever desired, it requires manual creation in the Notion web UI. This is a known limitation of the automated setup path.
- **Notion reciprocal `last_edited_time` gap (dual_property only):** when Page A's relation is set to point to Page B, Page A's `last_edited_time` bumps but Page B's does NOT (the reciprocal update is invisible to the timestamp). **Impact on Plan 5/4:** NOT a problem for `single_property` — only the subtask page (which carries the `Epic` relation) needs detection, and its timestamp bumps on edit. This gap would only matter if the team ever switches to `dual_property`, in which case Strategy B (hybrid polling with bidirectional verification — direct-fetch related target pages on relation change) would be needed.
- **Notion rate limit: 3 requests/second per integration.** Plan 5's ~350ms rate limiter (~2.86 req/s) is compatible. The 100-related-pages-per-PATCH limit is N/A for `single_property` (1 epic per subtask). Schema PATCH payload limit is 50KB — well under the 2-property addition.
- **ClickUp subtask listing confirmed:** `subtasks=true` returns a flat array where each child task has `parent` set to its **immediate** parent's task ID (not the top-level ancestor). Confirms Plan 2's client-side parentId-chain walk to find the top-level epic. Nested hierarchies (sub-subtasks) return the immediate parent only — the flattening walk is required.
- **Linear `updatedAt` tracks `parentId`:** confirmed — `parentId` is a core syncable field that bumps `updatedAt` on `issueUpdate`. The authoritative bump-list: title, description, state, priority, assignee, dueDate, parentId, estimate, project, cycle, labels. Non-bumping: comments, attachments, reactions. Plan 4's Linear state-delta `updatedAt` query WILL detect parent/child changes — no separate relationship-delta query needed.

## Dependencies

- `agent-epic-creation.md` — shipped (`createEpicFromPlanIds` + `assignPlansToEpic` exist in `KanbanProvider.ts`). Required by Plan 1.
- `notion-remote-control-and-delta-polling.md` — shipped (`RemoteControlService` + providers exist). Required by Plans 4 & 5.
- Plan 5 → Plan 4 (Notion side): Plan 4's Notion provider reads properties Plan 5 creates. Ship Plan 5 with or before Plan 4's Notion changes.
- Plans 2, 3, 5 are independent of each other and of Plans 1, 4 — can be implemented in parallel.
- Plan 1 is independent of Plans 2, 3, 5 — can be implemented in parallel.
- Plan 4's Linear side is independent — can be implemented in parallel; Plan 4's Notion side waits for Plan 5.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the child-planId race in Plans 2 & 3 — the watcher can mint a random planId for child files before the import's direct insert, orphaning the subtask link; mitigate by inserting the DB record before writing the file. (2) Plan 4's Notion side is a silent no-op without Plan 5 — enforce the shipping order. (3) The "epic-aware individual sync" follow-up (out of scope) is the real round-trip closer — subtasks that sync individually after epic creation create flat issues with no parent until the next epic-sync trigger. (4) ClickUp deep-nesting fidelity is lossy on round-trip (flattened to one level, not restored). Mitigations: insert-before-write ordering for imports, mandated shipping order for Plans 4 & 5, documented known gaps for the individual-sync and nesting-fidelity limitations.

## Proposed Changes

This is the epic-level rollup. Each subtask plan file is the single source of truth for its own implementation detail (file paths, line numbers, code blocks). Navigate by method name — several subtask plans have stale line numbers (see Complexity Audit).

### `src/services/LinearSyncService.ts`
- **Plan 1 (Outbound):** Add `public async syncEpicWithSubtasks(params)` and `public async unlinkSubtasksFromEpic(planFiles)`. Reuses `syncPlan:1902` (called directly, awaited — bypasses debounce), `updateIssueParent:1066`, `getIssueIdForPlan:1576`.
- **Plan 3 (Linear Import):** Restructure `importIssuesFromLinear:2198` into two-pass (filter+group → write+insert → link). Revive the dead `subIssuesByParentId:2293` map (move it post-filter). Write parents to `.switchboard/epics/`. **SCOPE CHANGE (user-confirmed Q3):** extend the GraphQL query (line 2262-2263) to recursively fetch the full hierarchy — `children { nodes { ... children { nodes { ... } } } }` — not just direct children. Add the same parentId-chain flattening walk as Plan 2 (walk up to top-level in-batch parent, link all descendants as direct subtasks of the epic). This makes Linear import behavior identical to ClickUp import. **Coordination note:** insert DB records before writing child files to avoid the planId race.

### `src/services/ClickUpSyncService.ts`
- **Plan 1 (Outbound):** Add `public async syncEpicWithSubtasks(params)` and `public async unlinkSubtasksFromEpic(planFiles)`. Reuses `syncPlan`, `updateTask:1383` (accepts `parent?: string`), `_findTaskByPlanId`.
- **Plan 2 (ClickUp Import):** Restructure `importTasksFromClickUp:2807` into two-pass (group → write+insert → link). Flatten deep hierarchies to one level (defensive cycle-break via visited-set). **Coordination note:** insert DB records before writing child files to avoid the planId race.

### `src/services/KanbanProvider.ts`
- **Plan 1 (Outbound):** Add `private async _syncEpicOutbound(workspaceRoot, epicPlanFile, epicTopic, epicColumn, subtasks)`. Wire into `createEpicFromPlanIds:8657`, `assignPlansToEpic:8786`, `promoteToEpic`, `removeSubtaskFromEpic`. Uses `Promise.allSettled` for fan-out; best-effort with logging (does not block epic creation return on sync success).

### `src/services/KanbanDatabase.ts`
- **No schema changes** across all five plans. All needed methods exist: `insertFileDerivedPlan:1312`, `updateEpicStatus:1470`, `updateClickUpTaskIdByPlanFile:1834`, `updateLinearIssueIdByPlanFile:1801`, `getSubtasksByEpicId`, `findPlanByNotionPageId`.
- **Stale `@deprecated` tag** on `updateEpicStatus:1469` — flag for cleanup (out of scope; do not migrate away from the method).

### `src/services/remote/RemoteProvider.ts`
- **Plan 4:** Add `parentRemoteId?: string` and `isEpicCandidate?: boolean` to `RemoteStateDelta` (lines 19-24). Additive — existing providers that don't populate them still compile and work.

### `src/services/remote/LinearRemoteProvider.ts`
- **Plan 4:** Extend the state-delta GraphQL query to fetch `parent { id }` + `children { nodes { id } }`. Populate `parentRemoteId` and `isEpicCandidate` on each delta.

### `src/services/remote/NotionRemoteProvider.ts`
- **Plan 4:** Read `Is Epic` checkbox + `Epic` relation from delta-query rows. Depends on Plan 5 for the properties to exist. Safe degradation (returns falsy) if properties absent.

### `src/services/RemoteControlService.ts`
- **Plan 4:** Add `private async _mirrorEpicStructure(db, provider, plan, delta, byRemoteId)`. Call it from `_pollState` before `_applyStateMirror`. Idempotent guards prevent redundant writes and echo loops.

### `src/services/NotionBackupService.ts`
- **Plan 5:** Add `Is Epic` checkbox to `autoCreateDatabase:165` payload. Add `_ensureEpicProperties(databaseId)` (PATCH to add `Epic` self-relation — mirrors `_ensureColumnSelectOptions:349`). Extend `_planToNotionProperties:450` (accept optional `epicIdToNotionPageId` map) and `_notionPageToPlanRecord:470` (read epic properties). Two-pass setup sync in `setupRemoteControl:248`. Epic resolution second pass in `restoreFromNotion`.

### `.agents/skills/switchboard_remote_notion.md`
- **Plan 5:** Add "Epics" section teaching the remote agent how to create/assign epics via Notion MCP (check `Is Epic`, set `Epic` relation, cascade on column move).

### `.agents/skills/kanban_operations/SKILL.md`
- **Plan 1:** Replace the "no Linear/ClickUp sync" note with documentation of the parent/child linking behavior.

## Verification Plan

### Automated Tests
*(Skipped per session directive — the user will run the suite separately.)*

### Manual Verification (epic-level cross-cutting)
1. **Round-trip — Linear:** Import a Linear parent with 2 children (Plan 3) → parent becomes epic, children linked. Create a local epic and sync outbound (Plan 1) → Linear shows parent/child. Move the epic in Linear → remote control mirrors the cascade locally (Plan 4).
2. **Round-trip — ClickUp:** Import a ClickUp parent with 3 nested subtasks (Plan 2) → top parent is epic, all descendants are flat subtasks. Sync outbound (Plan 1) → ClickUp shows flat parent/children. **Confirm the nesting is flattened (known limitation).**
3. **Round-trip — Notion:** Run Notion setup sync with an epic + 2 subtasks (Plan 5) → Notion pages have `Is Epic`/`Epic` properties. In Notion, check `Is Epic` on a page and set `Epic` relation on another (Plan 4) → local poll mirrors the linkage. Move the epic's `Kanban Column` in Notion → cascade fires locally.
4. **Child-planId race (coordination note):** After implementing the insert-before-write fix, import a ClickUp/Linear parent with children, then restart the extension (trigger watcher re-ingestion). Query `SELECT plan_id, is_epic, epic_id FROM plans WHERE plan_file LIKE '%import%'` — confirm all children have `epic_id` set to the parent's `plan_id` (no orphans).
5. **Shipping order (Plans 4 & 5):** Confirm Plan 5's `_ensureEpicProperties` runs on setup before Plan 4's Notion provider reads the properties. On a pre-Plan-5 Notion DB, confirm Plan 4's Notion provider degrades safely (no crash, column mirroring unaffected, no relationship mirroring).
6. **Partial sync (Plan 1):** Create an epic with 1 subtask that has an external issue and 1 that doesn't. Confirm the first is linked and the second is reported in `failed` in the console log.

## Uncertain Assumptions

All 3 uncertain assumptions were **RESOLVED** via web research (2026-06-28). No scope expansion or design changes are needed. Full findings are documented in the "Research-Confirmed External API Constraints" subsection of the Edge-Case & Dependency Audit above.

1. **Linear `updatedAt` bumps on `parentId` changes** — **CONFIRMED.** `parentId` is a core syncable field that bumps `updatedAt` on `issueUpdate`. Plan 4's Linear state-delta `updatedAt` query detects parent/child changes. No separate relationship-delta query needed.
2. **Notion self-relation via PATCH-after-create** — **CONFIRMED viable for `single_property`.** The API supports creating `single_property` self-relations via PATCH (exactly Plan 5's Approach A). `dual_property` self-relations CANNOT be created via API (manual Notion UI only) — documented as a known limitation. No change to Plan 5's design.
3. **Notion `last_edited_time` bumps on property edits** — **CONFIRMED for the edited page.** Setting a checkbox or relation bumps the edited page's `last_edited_time`. A reciprocal gap exists (target page of a relation does not bump), but this is NOT a problem for Plan 5's `single_property` design — only the subtask page carries the `Epic` relation and needs detection. No change to Plan 4's Notion delta detection.

## Recommendation

Complexity is **8** (architectural coordination across 3 external providers + remote control + Notion schema; new patterns in 5+ services — two-pass imports with direct DB inserts, create-and-wait sync convention, Notion self-relations, remote relationship mirroring; data consistency risks across the round-trip). All primitives exist in the codebase; no new dependencies. All 3 uncertain assumptions resolved via web research (no design changes needed). All 9 review questions confirmed by user (2026-06-28). **Send to Lead Coder.**

**Execution order:** Plans 2, 3, 5, and Plan 1 can proceed in parallel. Plan 4's Linear side can proceed in parallel; Plan 4's Notion side must wait for Plan 5. Apply the insert-before-write ordering fix to Plans 2 & 3 before implementation. **Plan 3 scope change:** extend the GraphQL query to fetch the full hierarchy (not just direct children) and add the parentId-chain flattening walk — update `linear-import-epic-linking.md` before implementation.
