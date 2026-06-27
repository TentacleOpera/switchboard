# Plan: Linear Import — Parent-with-Subtasks Always Becomes Epic

## Goal

When importing Linear issues that have sub-issues (children), the parent issue should ALWAYS become a Switchboard epic and its children should be linked to it via `epic_id`. Today, `importIssuesFromLinear` (LinearSyncService.ts:2198) fetches issues with their `children` nested in the GraphQL query (line 2263), flattens parent + children into a single `allTasks` array (line 2290), builds a `subIssuesByParentId` map (line 2293) — and then **ignores all of it**, writing each issue as an independent plan file. The only trace of the parent/child relationship is a `> **Parent Issue:** ${parentRef}` text label (line 2351). The round-trip is broken.

**Core problem / root cause.** The Linear import is *worse* than the ClickUp import in one respect: it already has the data and the grouping map built, it just doesn't use them. The dead code is right there:
1. The GraphQL query (line 2262-2263) fetches `parent { id title identifier }` on each issue AND `children { nodes { ... } }` on each top-level issue — the relationship data is fetched explicitly.
2. Line 2289-2290 flattens parents + children into `allTasks` via a dedup Map.
3. Line 2293-2300 builds `subIssuesByParentId` — a `Map<parentId, childIssue[]>` — and `issueNameById` — but these are only used for the `> **Parent Issue:**` text label (line 2343, 2351). They are **never used for DB linkage**.
4. The loop (line 2306) iterates `allTasks` flatly, writes `linear_import_${issue.id}.md` for each, and moves on.
5. The file watcher ingests each file independently — no `is_epic` or `epic_id` is set (files go to `.switchboard/plans/`, not `.switchboard/epics/`).

The fix is the same two-pass pattern as the ClickUp import plan: group, write parents to `.switchboard/epics/` with deterministic planIds, link children via direct DB writes.

**Key design decision (user-confirmed):** a Linear parent issue with children ALWAYS becomes a Switchboard epic. No opt-in, no threshold.

## Metadata

**Tags:** [backend, sync, import, feature]
**Complexity:** 5
**Repo:** (single-repo)
**Related:** `epic-sync-outbound.md` (outbound direction), `clickup-import-epic-linking.md` (sibling plan — same pattern, different service)

## User Review Required

Yes — confirm:
1. Should a Linear parent with only 1 child issue still become an epic? This plan says **yes** (user-confirmed: "ALWAYS"). Same decision as the ClickUp plan.
2. The Linear GraphQL query currently fetches only **direct children** (`children { nodes { ... } }` on top-level issues, line 2263) — grandchildren are NOT fetched. So deeply nested hierarchies are inherently flattened by the query itself. Should the query be extended to fetch deeper nesting? This plan says **no** — one level is sufficient. If a grandchild exists, it's simply not imported (same as today). Extending the query is a separate scope decision.

## Context

The Linear import path and its data flow:

```
importIssuesFromLinear(plansDir)
  → GraphQL query (fetches issues with parent + children nested)
  → filteredIssues (project filter, state filter)
  → allTasks = flatten(filteredIssues + their children)
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

**Pass 1: Write files + insert DB records with known planIds.**
- **Parents** (have children in the filtered batch):
  - Generate UUID (`crypto.randomUUID()`).
  - Write to `.switchboard/epics/linear_import_${issue.id}_${uuid}.md` — UUID suffix ensures the watcher derives `planId = uuid`.
  - Content: same stub format as today (H1 title, kanbanColumn, metadata block with Linear Issue ID, description, comments, attachments).
  - Insert via `db.insertFileDerivedPlan({ planId: uuid, planFile: '.switchboard/epics/...', ... })`.
  - Call `db.updateEpicStatus(uuid, 1, '')` — mark as epic.
  - Call `db.updateLinearIssueIdByPlanFile(planFile, workspaceId, issue.id)` — persist the Linear issue ID.
- **Children** (have an in-batch parent):
  - Generate UUID.
  - Write to `.switchboard/plans/linear_import_${issue.id}.md` — same path as today.
  - Insert via `db.insertFileDerivedPlan({ planId: childUuid, planFile: '.switchboard/plans/...', ... })`.
  - Call `db.updateLinearIssueIdByPlanFile(planFile, workspaceId, issue.id)`.
  - Defer linking to Pass 2.
- **Standalone** (no children, no in-batch parent):
  - Same as today: write file, let the watcher ingest.

**Pass 2: Link children to parents.**
- For each child: call `db.updateEpicStatus(childUuid, 0, parentUuid)`.
- Linear's query only fetches direct children (one level), so there's no deep-nesting walk needed. But if the query is later extended, a defensive `parentId` chain walk (same as the ClickUp plan) should be added. For now, direct parent linkage is sufficient.

### 2. Preserve existing dedup + filter logic

Same as the ClickUp plan — all existing filters (sync-map dedup, title-fallback, state-type, backlog, existing-file) run in Pass 0. A parent whose children are all filtered becomes standalone. A child whose parent was filtered becomes standalone.

### 3. Metadata label

Keep the existing `> **Parent Issue:** ${parentRef}` text label (line 2351) for human readability. Add `> **Epic Plan ID:** ${parentUuid}` for children — documents the DB linkage in the file for debugging.

---

## Critical Files

| File | Change |
|------|--------|
| `src/services/LinearSyncService.ts` | Restructure `importIssuesFromLinear` (line 2198-2404) into two-pass: filter+group → write+insert → link. Move `subIssuesByParentId` construction after filtering. Write parents to `.switchboard/epics/`. Add direct DB inserts. |

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
- **Less risky than ClickUp:** the Linear import already fetches and flattens parent/child data. The `subIssuesByParentId` map is already built (just in the wrong place and unused). The work is primarily "move the map construction, use it for DB linkage, write parents to epics/."
- **Query depth limitation:** the GraphQL query fetches only direct children (one level). Grandchildren are invisible. This means the import is inherently one-level for epic/subtask — no deep-nesting walk is needed (unlike ClickUp, which fetches all subtasks flatly). But if the query is later extended, the defensive walk should be added.
- **Watcher re-ingestion:** same analysis as the ClickUp plan — ON CONFLICT preserves `plan_id`, `is_epic`, `epic_id`, `linear_issue_id`. The import's direct inserts are safe.
- **`linear_issue_id` persistence:** same gap as ClickUp's `clickup_task_id` — the watcher's `insertFileDerivedPlan` hardcodes it to `''`. The import must call `updateLinearIssueIdByPlanFile` separately. This is the existing pattern used by `LinearSyncService.createIssue` (line 2057).

---

## Edge-Case & Dependency Audit

- **Parent with 1 child:** becomes an epic (user-confirmed: ALWAYS).
- **All children filtered out:** parent becomes standalone. Correct.
- **Parent already imported (sync-map dedup):** parent is skipped. Children have no in-batch parent → standalone.
- **Child's parent not in the batch** (parent was filtered or is a top-level issue that didn't match the project filter): child imports as standalone. The `> **Parent Issue:**` text label is still written for human context.
- **Direct DB insert fails:** catch per-task, log, fall back to file-write-only. The plan exists but isn't linked. Degradation, not a crash.
- **The `subIssuesByParentId` dead code:** after this change, the map is actually used. Remove the old dead-code construction at line 2293 (which was built from pre-filter `allTasks`) and replace with the post-filter version.

---

## Dependencies

- No new npm packages.
- `KanbanDatabase` handle is already opened in the import (line 2240-2242). Reuse it for direct inserts and linking.
- No dependency on `epic-sync-outbound.md` or `clickup-import-epic-linking.md` — this plan works independently.

---

## Adversarial Synthesis

**Risk Summary:** (1) This is lower risk than the ClickUp plan because the Linear import already fetches and partially processes the parent/child data — the change is "use the map you already built" rather than "build new infrastructure." (2) The query-depth limitation (only direct children) means deep hierarchies are partially imported — acceptable, same as today. (3) The `subIssuesByParentId` map must be rebuilt from filtered tasks, not from `allTasks` — the existing dead-code version includes tasks that will be filtered out, which would create phantom parents. (4) The `linear_issue_id` persistence gap (same as ClickUp's `clickup_task_id`) must be handled by a separate `updateLinearIssueIdByPlanFile` call.

---

## Proposed Changes

### `src/services/LinearSyncService.ts`
- **Context:** `importIssuesFromLinear` (line 2198-2404). The `subIssuesByParentId` map at line 2293 is dead code that this plan revives.
- **Logic:** Restructure into:
  1. **Fetch** (existing lines 2244-2284): unchanged — GraphQL query with `parent` and `children` fields.
  2. **Flatten** (existing line 2289-2290): unchanged — `allTasks = [...filteredIssues, ...subIssues]` deduped by id.
  3. **Filter** (new — extracted from the existing loop): iterate `allTasks`, apply sync-map dedup, title-fallback, state-type filter, backlog filter, existing-file check. Collect survivors into `filteredTasks`.
  4. **Group** (new): build `tasksById` and `childrenByParentId` from `filteredTasks`. Classify each as parent / child / standalone. **Remove the old dead-code `subIssuesByParentId` construction at line 2293** (it was built from pre-filter `allTasks`).
  5. **Write + insert** (new): for each task in `filteredTasks`:
     - Parent: generate UUID, write to `.switchboard/epics/linear_import_${issue.id}_${uuid}.md`, insert via `db.insertFileDerivedPlan`, `db.updateEpicStatus(uuid, 1, '')`, `db.updateLinearIssueIdByPlanFile(...)`.
     - Child: generate UUID, write to `.switchboard/plans/linear_import_${issue.id}.md`, insert via `db.insertFileDerivedPlan`, `db.updateLinearIssueIdByPlanFile(...)`. Defer linking.
     - Standalone: write file only (same as today).
  6. **Link** (new): for each child, `db.updateEpicStatus(childUuid, 0, parentUuid)`.
- **Edge Cases:** DB insert fails → catch, log, continue. All children filtered → parent is standalone.

---

## Verification Plan

### Automated Tests
*(Skipped per session directive — the user will run the suite separately.)*

### Manual Verification
1. In Linear, create a parent issue with 2 child issues. Run the import. Confirm: the parent appears as an epic card on the kanban board, the 2 children appear as regular cards linked to the epic (visible in the Epics tab), and the parent's plan file is in `.switchboard/epics/`.
2. Import a parent with 1 child. Confirm it still becomes an epic.
3. Import a list where a parent issue was already imported (exists in sync map). Confirm: parent is skipped, children import as standalone.
4. Import a list where all of a parent's children are completed (filtered out by state type). Confirm: parent imports as standalone, not an epic.
5. After import, restart the extension. Confirm: epic status and subtask linkage survive watcher re-ingestion.
6. Confirm `linear_issue_id` is persisted in the DB for both epic and subtask records (query `SELECT plan_id, linear_issue_id, is_epic, epic_id FROM plans WHERE plan_file LIKE 'linear_import_%'`).

---

## Recommendation

Complexity is **5** (lower than ClickUp because the data is already fetched and the grouping map is already built — the change is primarily "move the map, use it, write parents to epics/"). **Send to Coder** after user confirms the two review questions (1-child threshold + query depth).
