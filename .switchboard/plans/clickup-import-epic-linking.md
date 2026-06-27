# Plan: ClickUp Import — Parent-with-Subtasks Always Becomes Epic

## Goal

When importing ClickUp tasks that have subtasks, the parent task should ALWAYS become a Switchboard epic and its subtasks should be linked to it via `epic_id`. Today, `importTasksFromClickUp` (ClickUpSyncService.ts:2807) fetches all tasks with `subtasks=true` — so parents and children arrive in a single flat list — but writes each as an **independent plan file** with no `is_epic`/`epic_id` DB linkage. The only trace of the parent/child relationship is a `> **Parent Task:** ${parentName}` text label in the child's markdown (line 2933). The round-trip is broken: a ClickUp parent with 3 subtasks imports as 4 unrelated plans.

**Core problem / root cause.** The import fetches the relationship data but discards it at write time:
1. `listTasksFromClickUp` (line 827) calls `/list/${listId}/task?subtasks=true` — the API returns parents and children in one flat array, with `parent` set on each child task.
2. `_normalizeClickUpTask` (line 737) preserves `parentId` on each task object — the data is there.
3. The import loop (line 2854) iterates tasks flatly and writes `clickup_import_${task.id}.md` for each — parent and child become sibling files.
4. The file watcher (`GlobalPlanWatcherService`) ingests each file independently. It sets `is_epic=1` only for files in `.switchboard/epics/` (line 577-580) — imported files go to `.switchboard/plans/`, so none become epics.
5. There is no post-import DB pass to link children to parents.

The fix is a **two-pass import**: group the flat task list by parent/child relationships, write parents to `.switchboard/epics/` with deterministic planIds, and link children via direct DB writes.

**Key design decision (user-confirmed):** a ClickUp parent with subtasks ALWAYS becomes a Switchboard epic. No opt-in, no threshold. If ClickUp says "this task has children," it's an epic.

## Metadata

**Tags:** [backend, sync, import, feature]
**Complexity:** 6
**Repo:** (single-repo)
**Related:** `epic-sync-outbound.md` (outbound direction — both needed for round-trip)

## User Review Required

Yes — confirm:
1. Should a ClickUp parent with only 1 subtask still become an epic? This plan says **yes** (user-confirmed: "ALWAYS"). Some users might consider a 1-child parent as just a task with a subtask, not a full epic.
2. Should deeply nested hierarchies (grandparent → parent → child) be flattened to a single epic with all descendants as direct subtasks, or should intermediate parents also become epics? This plan proposes **flatten to one level**: the top-level parent (no `parentId` itself) becomes the epic; all its descendants (regardless of nesting depth) become direct subtasks of that epic. Switchboard epics are single-level (no epic-of-epic).

## Context

The import path and its data flow:

```
importTasksFromClickUp(listId, plansDir)
  → listTasksFromClickUp(listId)     // GET /list/${listId}/task?subtasks=true
  → for each task: writeFile(plansDir/clickup_import_${task.id}.md)
  → file watcher ingests each file independently
```

Key infrastructure:
- `ClickUpTask.parentId` (line 79) — preserved through normalization, available on every child task.
- `GlobalPlanWatcherService` (line 540-580) — derives `planId` from UUID in filename for `.switchboard/epics/` files; generates random UUID for `.switchboard/plans/` files. Sets `is_epic=1` for epics/ files.
- `KanbanDatabase.insertFileDerivedPlan` (line 1310) — ON CONFLICT on `(plan_file, workspace_id)` does NOT update `plan_id`. So if the import inserts a record with a known planId first, the watcher's later ingestion preserves it.
- `KanbanDatabase.updateEpicStatus(planId, isEpic, epicId)` (line 1455) — sets `is_epic` and `epic_id` on a plan record.
- `KanbanDatabase.updateClickUpTaskIdByPlanFile` (line 1832) — persists `clickup_task_id` separately (the watcher's `insertFileDerivedPlan` hardcodes it to `''`).
- `extractClickUpTaskId` (planMetadataUtils.ts:33) — extracts the ClickUp task ID from the `> **ClickUp Task ID:** <id>` metadata line in the file content. The watcher uses this to set `sourceType = 'clickup-import'`.

The dead-code tell: `getTaskWithSubtasks` (line 1201) fetches a task with its subtasks array — **never called anywhere in `src/`**. The relationship data was fetched at the list level (`subtasks=true` param) but never acted upon at the individual task level.

---

## What Gets Built

### 1. Two-pass import in `importTasksFromClickUp`

**Pass 0: Group the flat task list.**
- Before writing any files, build two maps from the flat `tasks` array:
  - `tasksById: Map<string, ClickUpTask>` — taskId → task (for quick lookup).
  - `childrenByParentId: Map<string, ClickUpTask[]>` — parentTaskId → array of direct children.
- A task is a **parent** if it appears as a key in `childrenByParentId` (i.e., at least one other task has `parentId === task.id`).
- A task is a **child** if `task.parentId` is set AND `tasksById.has(task.parentId)` (the parent is also in the import batch). A task with `parentId` pointing to a task NOT in the batch (parent was already imported or filtered out) is treated as standalone — its parent isn't being imported, so there's nothing to link to.
- A task is **standalone** if it has no children and no in-batch parent.

**Pass 1: Write files + insert DB records with known planIds.**
- Generate a UUID (`crypto.randomUUID()`) for each task that will be imported. For parents, this UUID goes in the filename so the watcher derives the same planId.
- **Parents** (have children in the batch):
  - Write to `.switchboard/epics/clickup_import_${task.id}_${uuid}.md` — the UUID suffix ensures the watcher derives `planId = uuid` (GlobalPlanWatcherService line 544-549).
  - Content: same stub format as today, but with the epic heading and description.
  - Insert via `db.insertFileDerivedPlan({ planId: uuid, planFile: '.switchboard/epics/...', ... })` — direct insert so the planId is known immediately.
  - Call `db.updateEpicStatus(uuid, 1, '')` — mark as epic.
  - Call `db.updateClickUpTaskIdByPlanFile(planFile, workspaceId, task.id)` — persist the ClickUp task ID (the watcher's `insertFileDerivedPlan` hardcodes it to `''`; this is the separate persist call, matching the existing sync-service pattern).
- **Children** (have an in-batch parent):
  - Write to `.switchboard/plans/clickup_import_${task.id}.md` — same path as today.
  - Insert via `db.insertFileDerivedPlan({ planId: childUuid, planFile: '.switchboard/plans/...', ... })` — direct insert with known planId.
  - Call `db.updateClickUpTaskIdByPlanFile(planFile, workspaceId, task.id)`.
  - Do NOT link yet — linking happens in Pass 2 after all parents are inserted.
- **Standalone** (no children, no in-batch parent):
  - Same as today: write file, let the watcher ingest. No direct DB insert needed (no one needs to know their planId upfront).

**Pass 2: Link children to parents.**
- For each child with an in-batch parent:
  - Resolve the parent's planId from the `tasksById → uuid` map (built in Pass 1).
  - Call `db.updateEpicStatus(childUuid, 0, parentUuid)` — set `is_epic=0, epic_id=parentUuid`.
- For deeply nested children (child's parent is itself a child of a grandparent): flatten to the top-level parent. Walk up the `parentId` chain via `tasksById` until reaching a task that has no `parentId` (or whose parent isn't in the batch) — that's the epic. Link the child to that epic's planId.

### 2. Preserve the existing dedup + filter logic

The current import has important guards that must be preserved:
- **Dedup** (line 2854-2892): skip tasks that correspond to in-flight `_createTask` calls or existing local plans. This logic runs BEFORE the grouping pass — if a task is skipped, it's excluded from `childrenByParentId` too. A parent whose only child is deduped becomes standalone (no children in the batch → not an epic).
- **Switchboard tag filter** (line 2895): skip tasks already owned by Switchboard. Same — excluded from grouping.
- **Automation rule filter** (line 2898): skip tasks handled by automation rules. Same.
- **Backlog filter** (line 2907): skip tasks named "backlog" if `excludeBacklog` is enabled. Same.

These filters run per-task in the existing loop. In the two-pass design, they run in Pass 0 (grouping) — a task that fails a filter is excluded from the grouping maps entirely. This means a parent that would have been an epic might become standalone if all its children are filtered out.

### 3. Metadata label update

The current `> **Parent Task:** ${parentName}` text label (line 2933) becomes redundant once the DB linkage exists — but it should be **kept** for human readability of the markdown file. The DB linkage is the source of truth for the board; the text label is for someone reading the raw file. Add a new line for children: `> **Epic Plan ID:** ${parentUuid}` — this is NOT parsed by the watcher today, but it documents the linkage in the file for debugging and potential future round-trip use.

---

## Critical Files

| File | Change |
|------|--------|
| `src/services/ClickUpSyncService.ts` | Restructure `importTasksFromClickUp` (line 2807) into two-pass: grouping → write+insert → link. Add direct DB inserts for parents and children. Write parents to `.switchboard/epics/`. |
| `src/services/KanbanDatabase.ts` | No schema change — `updateEpicStatus` and `updateClickUpTaskIdByPlanFile` already exist. May need a batch variant of `updateEpicStatus` for efficiency (optional — the import is not performance-critical). |

---

## Key Reuse (do not reinvent)

- `KanbanDatabase.insertFileDerivedPlan` (line 1310) — direct insert with known planId; ON CONFLICT preserves it when the watcher re-ingests
- `KanbanDatabase.updateEpicStatus` (line 1455) — set `is_epic` and `epic_id`
- `KanbanDatabase.updateClickUpTaskIdByPlanFile` (line 1832) — persist ClickUp task ID (the watcher's insert hardcodes it to `''`)
- `GlobalPlanWatcherService` epic-file detection (line 540-580) — writing to `.switchboard/epics/` with UUID in filename auto-sets `is_epic=1` on watcher ingestion
- `ClickUpTask.parentId` (line 79) — already preserved through normalization
- Existing dedup/filter logic (lines 2854-2910) — preserved, just moved before the grouping step
- `crypto.randomUUID()` — same UUID generation the watcher uses for epic files

---

## Complexity Audit

### Routine
- Grouping the flat task list into parent/child/standalone (mechanical map building)
- Writing parent files to `.switchboard/epics/` with UUID in filename (same pattern as `createEpicFromPlanIds`)
- Direct DB inserts alongside file writes (the DB handle is already open for dedup)
- Linking children via `updateEpicStatus` (one call per child)

### Complex / Risky
- **Deeply nested hierarchies:** ClickUp allows parent → child → grandchild. Switchboard epics are single-level. The flattening walk (follow `parentId` chain to the top-level parent) must handle cycles defensively (though ClickUp shouldn't produce cycles, a defensive visited-set is cheap).
- **Dedup interaction with grouping:** if a parent is deduped (already exists locally) but its children are new, the children have no in-batch parent → they import as standalone. This is correct — the parent already exists locally and may or may not be an epic. A future enhancement could look up the existing parent in the DB and link to it, but that's out of scope for this plan.
- **Watcher re-ingestion:** the import inserts records directly, then the watcher ingests the same files. The ON CONFLICT on `(plan_file, workspace_id)` preserves the import's planId and the epic status (ON CONFLICT doesn't update `plan_id`, `is_epic`, or `epic_id`). But it DOES update `topic`, `complexity`, `tags`, `project`, `project_id`, `updated_at` — so the watcher's metadata extraction overrides the import's initial values. This is fine (the watcher's metadata is more accurate — it parses the file content).
- **`clickup_task_id` persistence:** the watcher's `insertFileDerivedPlan` hardcodes `clickup_task_id` to `''` (line 1340). The import must call `updateClickUpTaskIdByPlanFile` separately. When the watcher re-ingests, the ON CONFLICT doesn't update `clickup_task_id`, so the import's value is preserved. BUT — the watcher also sets `clickupTaskId` on the record object (line 572) and uses it for real-time sync (line 625-628). Since `insertFileDerivedPlan` doesn't persist it, the watcher's in-memory record has it but the DB doesn't — until the import's separate `updateClickUpTaskIdByPlanFile` call. The ordering is: import writes file + inserts record + persists task ID → watcher later re-ingests file → ON CONFLICT preserves task ID. This is safe.

---

## Edge-Case & Dependency Audit

- **Parent with 1 child:** becomes an epic (user-confirmed: ALWAYS). No threshold.
- **All children filtered out:** parent becomes standalone (no children in the batch). It imports as a regular plan, not an epic. Correct — there's nothing to be an epic of.
- **Parent already imported (deduped):** parent is skipped. Children have no in-batch parent → import as standalone. A future enhancement could look up the existing parent's planId in the DB and link, but that's out of scope.
- **Child's parent is not in the batch** (parent was filtered out, already imported, or in a different list): child imports as standalone. The `> **Parent Task:** <name>` text label is still written for human context, but no DB linkage is created.
- **Cycle in parentId chain:** defensively break with a visited-set. Log a warning. Treat the child as standalone (link to no epic).
- **Direct DB insert fails:** catch per-task, log, fall back to file-write-only (watcher will ingest with a random planId — the child won't be linked to the parent, but at least the plan exists). This is a degradation, not a crash.
- **`crypto` module:** already imported in `KanbanProvider.ts` and used by the watcher. The import is in `ClickUpSyncService.ts` — check if `crypto` is imported there; if not, add it (Node built-in, no dep).

---

## Dependencies

- No new npm packages.
- `KanbanDatabase` handle is already opened in the import (line 2832-2845 for dedup). Reuse it for the direct inserts and linking.
- No dependency on `epic-sync-outbound.md` — this plan works independently. The outbound sync is a separate concern (pushing Switchboard epic changes TO external trackers; this plan is pulling external structure INTO Switchboard).

---

## Adversarial Synthesis

**Risk Summary:** (1) The two-pass import with direct DB inserts is a new pattern — the current import relies entirely on the watcher for DB ingestion. Direct inserts must be compatible with the watcher's later re-ingestion (ON CONFLICT preserves planId/is_epic/epic_id/clickup_task_id — verified). (2) Deeply nested ClickUp hierarchies must be flattened to one level — a defensive cycle-break is needed. (3) The dedup/filter logic must run before grouping, which changes the execution order — a parent whose children are all filtered becomes standalone, which is correct but different from the current behavior (where everything is standalone anyway). (4) The `clickup_task_id` persistence gap (watcher hardcodes it to `''`) must be handled by a separate `updateClickUpTaskIdByPlanFile` call — this is an existing pattern used by the sync service, not new.

---

## Proposed Changes

### `src/services/ClickUpSyncService.ts`
- **Context:** `importTasksFromClickUp` (line 2807-2958).
- **Logic:** Restructure into:
  1. **Fetch + filter** (existing lines 2817-2910, mostly unchanged): fetch tasks, run dedup + filters. But instead of writing files in the same loop, collect the surviving tasks into a `filteredTasks` array.
  2. **Group** (new): build `tasksById` and `childrenByParentId` maps from `filteredTasks`. Classify each as parent / child / standalone.
  3. **Write + insert** (new): for each task:
     - Parent: generate UUID, write to `.switchboard/epics/clickup_import_${task.id}_${uuid}.md`, insert via `db.insertFileDerivedPlan`, `db.updateEpicStatus(uuid, 1, '')`, `db.updateClickUpTaskIdByPlanFile(planFile, workspaceId, task.id)`.
     - Child: generate UUID, write to `.switchboard/plans/clickup_import_${task.id}.md`, insert via `db.insertFileDerivedPlan`, `db.updateClickUpTaskIdByPlanFile(planFile, workspaceId, task.id)`. Defer linking to step 4.
     - Standalone: write to `.switchboard/plans/clickup_import_${task.id}.md` (same as today — no direct DB insert needed).
  4. **Link** (new): for each child, walk `parentId` chain to find the top-level in-batch parent. Call `db.updateEpicStatus(childUuid, 0, topParentUuid)`.
- **Edge Cases:** DB insert fails → catch, log, continue with file-write-only. Cycle in parentId → break with visited-set, treat as standalone. All children filtered → parent is standalone.

### `src/services/KanbanDatabase.ts`
- No changes required. All needed methods exist:
  - `insertFileDerivedPlan` (line 1310) — direct insert with known planId
  - `updateEpicStatus` (line 1455) — set is_epic + epic_id
  - `updateClickUpTaskIdByPlanFile` (line 1832) — persist clickup_task_id
- Optional: add `batchUpdateEpicStatus(records: Array<{planId, isEpic, epicId}>)` for efficiency — but the import is not performance-critical, so per-child calls are fine.

---

## Verification Plan

### Automated Tests
*(Skipped per session directive — the user will run the suite separately.)*

### Manual Verification
1. In ClickUp, create a parent task with 2 subtasks. Run the import. Confirm: the parent appears as an epic card on the kanban board, the 2 subtasks appear as regular cards linked to the epic (visible in the Epics tab), and the parent's plan file is in `.switchboard/epics/`.
2. Import a parent with 1 subtask. Confirm it still becomes an epic (ALWAYS, no threshold).
3. Import a parent with 3 subtasks where 1 subtask has its own subtask (grandchild). Confirm: the top-level parent is the epic, all 3 descendants are direct subtasks (flattened, single-level).
4. Import a list where a parent task was already imported (exists locally). Confirm: the parent is skipped (deduped), the children import as standalone plans (no linkage — acceptable per edge-case audit).
5. Import a list where all of a parent's children are filtered out (e.g., they have the `switchboard:` tag). Confirm: the parent imports as a standalone plan, not an epic.
6. After import, restart the extension (trigger watcher re-ingestion). Confirm: the epic status and subtask linkage survive (ON CONFLICT preserves `plan_id`, `is_epic`, `epic_id`).
7. Confirm the `clickup_task_id` is persisted in the DB for both the epic and subtask records (query `SELECT plan_id, clickup_task_id, is_epic, epic_id FROM plans WHERE plan_file LIKE 'clickup_import_%'`).

---

## Recommendation

Complexity is **6** (restructuring an existing import path, direct DB inserts alongside file writes, hierarchy flattening, but no schema changes and all DB methods exist). **Send to Coder** after user confirms the two review questions (1-child threshold + deep nesting flattening).
