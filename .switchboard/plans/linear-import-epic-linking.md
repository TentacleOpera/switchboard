# Plan: Linear Import — Parent-with-Subtasks Always Becomes Epic

## Goal

When importing Linear issues that have sub-issues (children), the parent issue should ALWAYS become a Switchboard epic and its children should be linked to it via `epic_id`. Today, `importIssuesFromLinear` (LinearSyncService.ts:2198) fetches issues with their `children` nested in the GraphQL query (line 2263), flattens parent + children into a single `allTasks` array (line 2290), builds a `subIssuesByParentId` map (line 2293) — and then **ignores all of it**, writing each issue as an independent plan file. The only trace of the parent/child relationship is a `> **Parent Issue:** ${parentRef}` text label (line 2351). The round-trip is broken.

**Core problem / root cause.** The Linear import already has the data and the grouping map built, it just doesn't use them. The dead code is right there:
1. The GraphQL query (line 2262-2263) fetches `parent { id title identifier }` on each issue AND `children { nodes { ... } }` on each top-level issue — but only **one level deep**. Grandchildren and deeper descendants are not fetched. **Scope change (user-confirmed Q2):** the query must be extended to recursively fetch the full hierarchy.
2. Line 2289-2290 flattens parents + children into `allTasks` via a dedup Map.
3. Line 2293-2300 builds `subIssuesByParentId` — a `Map<parentId, childIssue[]>` — and `issueNameById` — but these are only used for the `> **Parent Issue:**` text label (line 2343, 2351). They are **never used for DB linkage**.
4. The loop (line 2306) iterates `allTasks` flatly, writes `linear_import_${issue.id}.md` for each, and moves on.
5. The file watcher ingests each file independently — no `is_epic` or `epic_id` is set (files go to `.switchboard/plans/`, not `.switchboard/epics/`).

The fix is the same two-pass pattern as the ClickUp import plan: group, write parents to `.switchboard/epics/` with deterministic planIds, link children via direct DB writes.

**Key design decision (user-confirmed):** a Linear parent issue with children ALWAYS becomes a Switchboard epic. No opt-in, no threshold.

## Metadata

**Tags:** [backend, sync, import, feature]
**Complexity:** 6
**Repo:** (single-repo)
**Related:** `epic-sync-outbound.md` (outbound direction), `clickup-import-epic-linking.md` (sibling plan — same pattern, different service)

## User Review Required

Both questions confirmed by user (2026-06-28). Decisions are locked:

1. ✅ **Yes** — a Linear parent with only 1 child issue always becomes an epic. No opt-in, no threshold. Same decision as the ClickUp plan.
2. ✅ **Yes — fetch everything.** The GraphQL query must fetch the FULL hierarchy (all descendants, not just direct children). This makes the Linear import consistent with the ClickUp import (which already handles deep nesting via flattening). Grandchildren and deeper descendants must be imported and flattened to direct subtasks of the top-level epic.

## Context

The Linear import path and its data flow:

```
importIssuesFromLinear(plansDir)
  → GraphQL query (fetches issues with parent + children nested — MUST fetch full hierarchy recursively)
  → filteredIssues (project filter, state filter)
  → allTasks = flatten(filteredIssues + all their descendants)
  → subIssuesByParentId map (built but UNUSED for linking)
  → for each task: writeFile(plansDir/linear_import_${issue.id}.md)
  → file watcher ingests each file independently
```

Key infrastructure (shared with the ClickUp plan):
- `GlobalPlanWatcherService` (line 540-580) — derives `planId` from UUID in filename for `.switchboard/epics/` files; sets `is_epic=1` for epics/ files.
- `KanbanDatabase.insertFileDerivedPlan` (line 1310) — ON CONFLICT on `(plan_file, workspace_id)` does NOT update `plan_id`, `is_epic`, `epic_id`, or `linear_issue_id`. So direct inserts with known planIds are preserved on watcher re-ingestion.
- `KanbanDatabase.updateEpicStatus` (line 1455) — sets `is_epic` and `epic_id`.
- `KanbanDatabase.updateLinearIssueIdByPlanFile` (line 1799) — persists `linear_issue_id` separately (the watcher's `insertFileDerivedPlan` hardcodes it to `''`).
- `extractLinearIssueId` (planMetadataUtils.ts:43) — extracts the Linear issue ID from the `> **Linear Issue ID:** <id>` metadata line.

The half-built dead code: `subIssuesByParentId` (line 2293) is exactly the map needed for the grouping pass — it just needs to be moved before the file-writing loop and actually used for DB linkage.

---

## What Gets Built

### 1. Two-pass import in `importIssuesFromLinear`

**Pass 0: Filter + group.**
- The existing loop (line 2306-2398) currently filters and writes in one pass. Split it: first iterate `allTasks` and apply all filters (sync-map dedup at line 2307, title-fallback dedup at line 2312, state-type filter at line 2322, backlog filter at line 2328, existing-file check at line 2334). Collect survivors into a `filteredTasks` array.
- Build `tasksById: Map<string, any>` and `childrenByParentId: Map<string, any[]>` from `filteredTasks` (not from `allTasks` — only survivors count). A task is a **parent** if it has entries in `childrenByParentId`. A task is a **child** if `task.parent?.id` is set and `tasksById.has(task.parent.id)`.
- Note: the existing `subIssuesByParentId` (line 2293) is built from `allTasks` (pre-filter). Replace it with a post-filter version.
- **Deep hierarchy handling (scope change — user-confirmed Q2):** the GraphQL query now fetches the full hierarchy recursively, so `allTasks` includes grandchildren and deeper descendants. The `childrenByParentId` map captures the **immediate** parent/child relationships at every level. A task is a **top-level parent** (epic candidate) if it has children but no in-batch parent (i.e., `task.parent?.id` is unset or not in `tasksById`). Intermediate parents (have children AND have an in-batch parent) are NOT epics — they become subtasks like their own children.

**Pass 1: Write files + insert DB records with known planIds.**
- **Top-level parents** (have children in the filtered batch AND no in-batch parent — these become epics):
  - Generate UUID (`crypto.randomUUID()`).
  - Write to `.switchboard/epics/linear_import_${issue.id}_${uuid}.md` — UUID suffix ensures the watcher derives `planId = uuid`.
  - Content: same stub format as today (H1 title, kanbanColumn, metadata block with Linear Issue ID, description, comments, attachments).
  - Insert via `db.insertFileDerivedPlan({ planId: uuid, planFile: '.switchboard/epics/...', ... })`.
  - Call `db.updateEpicStatus(uuid, 1, '')` — mark as epic.
  - Call `db.updateLinearIssueIdByPlanFile(planFile, workspaceId, issue.id)` — persist the Linear issue ID.
- **Children** (have an in-batch parent — includes intermediate parents, which are subtasks NOT epics):
  - Generate UUID.
  - Write to `.switchboard/plans/linear_import_${issue.id}.md` — same path as today.
  - Insert via `db.insertFileDerivedPlan({ planId: childUuid, planFile: '.switchboard/plans/...', ... })`.
  - Call `db.updateLinearIssueIdByPlanFile(planFile, workspaceId, issue.id)`.
  - Defer linking to Pass 2.
- **Standalone** (no children, no in-batch parent):
  - Same as today: write file, let the watcher ingest.

**Pass 2: Link children to top-level parents (flattening walk).**
- For each child: walk up the `parentId` chain via `tasksById` until reaching a task that has no in-batch parent (or whose parent isn't in the batch) — that's the top-level epic. Call `db.updateEpicStatus(childUuid, 0, topParentUuid)`.
- This flattens deeply nested hierarchies (grandparent → parent → child) to a single epic with all descendants as direct subtasks — identical to the ClickUp import's flattening behavior.
- Defensive cycle-break: use a visited-set when walking the parentId chain. If a cycle is detected, log a warning and treat the child as standalone (link to no epic).

### 2. Preserve existing dedup + filter logic

Same as the ClickUp plan — all existing filters (sync-map dedup, title-fallback, state-type, backlog, existing-file) run in Pass 0. A parent whose children are all filtered becomes standalone. A child whose parent was filtered becomes standalone.

### 3. Metadata label

Keep the existing `> **Parent Issue:** ${parentRef}` text label (line 2351) for human readability. Add `> **Epic Plan ID:** ${parentUuid}` for children — documents the DB linkage in the file for debugging.

---

## Critical Files

| File | Change |
|------|--------|
| `src/services/LinearSyncService.ts` | Restructure `importIssuesFromLinear` (line 2198-2404) into two-pass: filter+group → write+insert → link. Extend GraphQL query (line 2262-2263) to fetch full hierarchy recursively. Move `subIssuesByParentId` construction after filtering. Write top-level parents to `.switchboard/epics/`. Add direct DB inserts (insert BEFORE file write). Add parentId-chain flattening walk with cycle guard. |

---

## Key Reuse (do not reinvent)

- `KanbanDatabase.insertFileDerivedPlan` (line 1310) — direct insert with known planId
- `KanbanDatabase.updateEpicStatus` (line 1455) — set `is_epic` and `epic_id`
- `KanbanDatabase.updateLinearIssueIdByPlanFile` (line 1799) — persist `linear_issue_id`
- `GlobalPlanWatcherService` epic-file detection (line 540-580) — writing to `.switchboard/epics/` with UUID in filename auto-sets `is_epic=1`
- Existing `subIssuesByParentId` map construction (line 2293) — move it post-filter and actually use it
- Existing filter logic (lines 2307-2334) — preserved, just moved before grouping
- `crypto.randomUUID()` — UUID generation for deterministic planIds

---

## Complexity Audit

### Routine
- Splitting the existing loop into filter-then-group-then-write (mechanical refactor)
- Moving `subIssuesByParentId` construction after the filter step
- Writing parent files to `.switchboard/epics/` with UUID in filename (same pattern as `createEpicFromPlanIds`)
- Direct DB inserts + `updateEpicStatus` + `updateLinearIssueIdByPlanFile` (same pattern as ClickUp plan)

### Complex / Risky
- **Recursive GraphQL query (scope change — user-confirmed Q2):** the query must fetch the full hierarchy, not just direct children. GraphQL servers typically enforce a max query depth — Linear's limit is not documented. A deeply recursive inline query (e.g., `children { nodes { ... children { nodes { ... } } } }`) may be rejected for very deep hierarchies. Mitigation: use a fixed-depth recursive fragment (e.g., 5 levels deep) which covers practical hierarchies, or fall back to iterative per-issue `children` queries for known parents after the initial fetch.
- **Flattening walk:** the parentId-chain walk to find the top-level epic is the same pattern as the ClickUp plan. Must handle cycles defensively with a visited-set. Intermediate parents (have children AND have a parent) become subtasks, not epics — this is the key distinction from the original one-level design.
- **Child-planId race condition (epic-level coordination note):** insert the DB record with the known planId BEFORE writing the child file. The watcher mints a random planId for `.switchboard/plans/` files; if it fires between the file write and the import's insert, `ON CONFLICT` preserves the watcher's random planId and the import's `updateEpicStatus(childUuid, ...)` targets a non-existent planId — silently orphaning the subtask link.
- **Watcher re-ingestion:** same analysis as the ClickUp plan — ON CONFLICT preserves `plan_id`, `is_epic`, `epic_id`, `linear_issue_id`. The import's direct inserts are safe (given insert-before-write ordering).
- **`linear_issue_id` persistence:** same gap as ClickUp's `clickup_task_id` — the watcher's `insertFileDerivedPlan` hardcodes it to `''`. The import must call `updateLinearIssueIdByPlanFile` separately. This is the existing pattern used by `LinearSyncService.createIssue` (line 2057).

---

## Edge-Case & Dependency Audit

- **Parent with 1 child:** becomes an epic (user-confirmed: ALWAYS).
- **Deep hierarchy (grandparent → parent → child):** top-level parent (no in-batch parent itself) becomes the epic. All descendants (including intermediate parents) become direct subtasks of the epic — flattened to one level. The intermediate parent is NOT a separate epic.
- **All children filtered out:** parent becomes standalone. Correct.
- **Intermediate parent filtered out:** its children's parentId chain walk stops at the filtered parent (not in `tasksById`). The children become standalone (or link to a higher ancestor if the chain continues past the filtered node). In practice, the walk goes up until it finds a task in `tasksById` or exits the batch — if the top-level ancestor is in the batch, descendants still link to it even if intermediate nodes are filtered.
- **Parent already imported (sync-map dedup):** parent is skipped. Children have no in-batch parent → standalone.
- **Child's parent not in the batch** (parent was filtered or is a top-level issue that didn't match the project filter): child imports as standalone. The `> **Parent Issue:**` text label is still written for human context.
- **Cycle in parentId chain:** defensively break with a visited-set. Log a warning. Treat the child as standalone (link to no epic).
- **Direct DB insert fails:** catch per-task, log, fall back to file-write-only. The plan exists but isn't linked. Degradation, not a crash.
- **The `subIssuesByParentId` dead code:** after this change, the map is actually used. Remove the old dead-code construction at line 2293 (which was built from pre-filter `allTasks`) and replace with the post-filter version.

---

## Dependencies

- No new npm packages.
- `KanbanDatabase` handle is already opened in the import (line 2240-2242). Reuse it for direct inserts and linking.
- No dependency on `epic-sync-outbound.md` or `clickup-import-epic-linking.md` — this plan works independently.

---

## Adversarial Synthesis

**Risk Summary:** (1) The recursive GraphQL query is the primary new risk — Linear's max query depth is undocumented, and a deeply recursive inline query may be rejected. Mitigation: fixed-depth fragment (5 levels) or iterative per-issue fetch. (2) The flattening walk must correctly distinguish top-level parents (epics) from intermediate parents (subtasks) — the key invariant is "no in-batch parent = epic candidate." (3) The child-planId race condition requires insert-before-write ordering — if the watcher fires between file write and DB insert, the subtask link is silently orphaned. (4) The `subIssuesByParentId` map must be rebuilt from filtered tasks, not from `allTasks` — the existing dead-code version includes tasks that will be filtered out, which would create phantom parents. (5) The `linear_issue_id` persistence gap must be handled by a separate `updateLinearIssueIdByPlanFile` call.

---

## Proposed Changes

### `src/services/LinearSyncService.ts`
- **Context:** `importIssuesFromLinear` (line 2198-2404). The `subIssuesByParentId` map at line 2293 is dead code that this plan revives.
- **Logic:** Restructure into:
  1. **Fetch** (existing lines 2244-2284, MODIFIED): extend the GraphQL query (line 2262-2263) to recursively fetch the full hierarchy. Replace `children { nodes { ... } }` with a recursive fragment that nests `children { nodes { ... children { nodes { ... } } } }` to a practical fixed depth (e.g., 5 levels). If a deeper hierarchy exists, fall back to iterative per-issue `children` queries for known parents after the initial fetch. The `parent { id title identifier }` field on each issue is unchanged.
  2. **Flatten** (existing line 2289-2290, MODIFIED): `allTasks = [...filteredIssues, ...allDescendants]` deduped by id — now includes grandchildren and deeper descendants, not just direct children.
  3. **Filter** (new — extracted from the existing loop): iterate `allTasks`, apply sync-map dedup, title-fallback, state-type filter, backlog filter, existing-file check. Collect survivors into `filteredTasks`.
  4. **Group** (new): build `tasksById` and `childrenByParentId` from `filteredTasks`. Classify each as top-level parent / child / standalone. A **top-level parent** has children in the batch AND no in-batch parent. An **intermediate parent** has children AND an in-batch parent — it's a subtask, not an epic. **Remove the old dead-code `subIssuesByParentId` construction at line 2293** (it was built from pre-filter `allTasks`).
  5. **Write + insert** (new — insert BEFORE write to avoid planId race): for each task in `filteredTasks`:
     - Top-level parent: generate UUID, insert via `db.insertFileDerivedPlan({ planId: uuid, ... })`, `db.updateEpicStatus(uuid, 1, '')`, `db.updateLinearIssueIdByPlanFile(...)`, THEN write to `.switchboard/epics/linear_import_${issue.id}_${uuid}.md`.
     - Child (including intermediate parents): generate UUID, insert via `db.insertFileDerivedPlan({ planId: childUuid, ... })`, `db.updateLinearIssueIdByPlanFile(...)`, THEN write to `.switchboard/plans/linear_import_${issue.id}.md`. Defer linking.
     - Standalone: write file only (same as today).
  6. **Link** (new): for each child, walk up the `parentId` chain via `tasksById` (with visited-set cycle guard) to find the top-level in-batch parent. Call `db.updateEpicStatus(childUuid, 0, topParentUuid)`.
- **Edge Cases:** DB insert fails → catch, log, continue. All children filtered → parent is standalone. Cycle in parentId → break with visited-set, treat as standalone. GraphQL query depth limit hit → fall back to iterative per-issue fetch.

---

## Verification Plan

### Automated Tests
*(Skipped per session directive — the user will run the suite separately.)*

### Manual Verification
1. In Linear, create a parent issue with 2 child issues. Run the import. Confirm: the parent appears as an epic card on the kanban board, the 2 children appear as regular cards linked to the epic (visible in the Epics tab), and the parent's plan file is in `.switchboard/epics/`.
2. Import a parent with 1 child. Confirm it still becomes an epic.
3. **Deep hierarchy:** In Linear, create a grandparent → parent → child (3 levels). Run the import. Confirm: the grandparent is the epic, both the parent and child are direct subtasks (flattened to one level). The parent is NOT a separate epic. Query `SELECT plan_id, is_epic, epic_id FROM plans WHERE plan_file LIKE 'linear_import_%'` — only the grandparent has `is_epic=1`; both descendants have `epic_id` = grandparent's planId.
4. Import a list where a parent issue was already imported (exists in sync map). Confirm: parent is skipped, children import as standalone.
5. Import a list where all of a parent's children are completed (filtered out by state type). Confirm: parent imports as standalone, not an epic.
6. After import, restart the extension. Confirm: epic status and subtask linkage survive watcher re-ingestion (no orphans — the insert-before-write ordering prevents the planId race).
7. Confirm `linear_issue_id` is persisted in the DB for both epic and subtask records (query `SELECT plan_id, linear_issue_id, is_epic, epic_id FROM plans WHERE plan_file LIKE 'linear_import_%'`).

---

## Recommendation

Complexity is **6** (the recursive GraphQL query + flattening walk + insert-before-write ordering bring this to parity with the ClickUp import plan). Both review questions confirmed by user (2026-06-28). **Send to Coder.**

## Review Findings

**Reviewed:** 2026-07-03. Implementation fully compliant with all 12 plan requirements. Two-pass import (filter+group → write+insert → link) at `LinearSyncService.ts:2442-2708`. Recursive GraphQL query fetches 5 levels deep (lines 2346-2400). Insert-before-write ordering verified (insert at lines 2574/2624, write at lines 2605/2651). Old dead-code `subIssuesByParentId` completely removed (zero grep matches). Cycle-safe flattening walk with visited-set at lines 2671-2695. Intermediate parents correctly classified as subtasks, not epics (line 2494). ON CONFLICT in `insertFileDerivedPlan` preserves `plan_id`, `is_epic`, `epic_id`, `linear_issue_id` — verified at `KanbanDatabase.ts:1442-1449`. No orphaned references found. No code changes applied. No compilation/tests run per session directives. **Remaining risk:** GraphQL query depth limit (5 levels) — deeper hierarchies would need iterative per-issue fetch fallback, as noted in the plan's Complexity Audit.
