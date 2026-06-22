# Unify Epic Architecture & Fix Kanban Epic Display

## Metadata

**Complexity:** 7
**Tags:** frontend, backend, database, ui, bugfix, refactor

## Goal

Unify the two disconnected epic systems (kanban DB-backed epics in `plans/` and project-panel standalone documents in `epics/`) into a single architecture where all epic files live in `.switchboard/epics/` and the DB determines kanban board presence. Fix the blank epic file content, the board signature omission, and the watcher blind spot for the `epics/` directory.

### Problem

The epic feature in Switchboard is architecturally split-brained and has three distinct bugs:

1. **Two disconnected epic systems**: Kanban-created epics write to `.switchboard/plans/epic-{uuid}.md` with a DB record (`is_epic=1`). The project panel's epics tab reads from `.switchboard/epics/` (a completely different directory). The two systems never see each other — kanban-created epics are invisible in the epics tab, and epics-tab documents have no DB record or kanban presence.

2. **Epic files are blank markers**: The epic file written by `KanbanProvider.createEpic` contains only YAML frontmatter + an H1 title. No subtask listing, no plan links, no useful content. Subtask association exists only in the DB (`epic_id` column).

3. **Board signature omits epic metadata**: `buildBoardSignature` doesn't include `isEpic`, `epicId`, or `subtaskCount`. When a plan is promoted to epic (single-card path), the signature may not change, so the board doesn't re-render with the epic styling.

> **Note**: The Claudify theme epic card styling bug (`!important` overrides killing `.epic-card` visual differentiation) is tracked separately and will be handled by another agent.

### Root Cause

The kanban epic system and the project panel epic system were built independently and never connected. The kanban system uses DB records + files in `plans/`. The project panel system uses standalone markdown files in `epics/`. No bridge exists between them.

### Background Context

- The prompt builder (`agentPromptBuilder.ts`) already handles epic orchestration dynamically: at prompt-build time, it fetches subtasks from the DB via `getSubtasksByEpicId` and injects `EPIC_ORCHESTRATION_DIRECTIVE`. The epic file content does NOT affect agent dispatch — the DB `epic_id` linkage is what matters.
- The `promoteToEpic` handler (kanban single-card path) sets `is_epic=1` on an existing plan without creating a new file or moving the existing one.
- The `deleteEpic` handler tombstones the DB record but does not delete the file.
- The file watcher (`GlobalPlanWatcherService`) only watches `.switchboard/plans/`, not `.switchboard/epics/`.
- `filterGhostPlans` checks if plan files exist on disk, resolving relative paths against `workspaceRoot`. Epic files in `epics/` would resolve correctly since the DB `plan_file` stores the relative path.
- **`updatePlanFile` is `@deprecated`** (KanbanDatabase.ts line 1661): *"plan_file is now the unique key; file renames create new plans."* The method's signature is `updatePlanFile(sessionId: string, planFile: string, skipTimestampUpdate?: boolean)` — it internally calls `getPlanBySessionId(sessionId)`, which fails for watcher-imported plans that have `sessionId=''`. **Do not use `updatePlanFile` for the promote-to-epic or migration path updates.** A new `updatePlanFileByPlanId` method must be added (see Part 1.3).
- The upsert SQL has `is_epic = COALESCE(excluded.is_epic, is_epic)` (KanbanDatabase.ts line 580), but this only preserves `is_epic` on **conflict (UPDATE)**. For **new INSERTs** from `_handlePlanFile`, the `newRecord` object does not include `isEpic`, so `excluded.is_epic` is NULL and the record gets `is_epic=NULL` (NOT `0` — the explicit NULL parameter overrides the schema's `DEFAULT 0`). The root cause is architectural: **the importer writes DB-owned columns from a file-derived record that has no business setting them** (see Part 0).
- **`is_epic = NULL` bug (confirmed in production DB)**: A file created via the create-epic modal (`epic-3051b25c-35ae-48c8-9d21-b70436e0c8a2.md`) has `is_epic = NULL` in the DB, not `1`. The DB record shows `plan_id = session_id` (the `_getRegistrySessionId` pattern from TaskViewerProvider.ts line 10240, which returns `planId` for 'local' source type), proving the record was created/overwritten by `_savePlanRegistry`, NOT by `createEpic`'s upsert (which generates two separate UUIDs). The defect is not "the file doesn't carry the flag" — it's "an import was allowed to overwrite a DB-authoritative field from a file that has no business setting it." The `registerPendingCreation` 3-second guard is just a flaky band-aid over the real problem: the importer misclassifying an existing DB plan as "new" and rebuilding from scratch (see Part 0).
- **DB-owned vs file-owned column boundary**: `is_epic`, `epic_id`, `kanban_column`, `status`, `worktree_id`, `clickup_task_id`, `linear_issue_id`, `dispatched_agent`, `dispatched_ide`, `routed_to`, `project_id` are **DB-owned** — the plan file has no business setting them. `topic`, `complexity`, `tags`, `project` (from frontmatter) are **file-derived** — the importer can legitimately update these. A file re-import should only ever touch file-derived columns and leave DB-owned columns exactly as they are. The in-place update path (watcher's existing-record branch, line 531-538) already respects this — it spreads `...plan` and COALESCE preserves. The leak is exclusively the "new plan" INSERT branch (line 501-524) which rebuilds the record from the file alone, omitting DB-owned fields, and `upsertPlans` passes `record.isEpic ?? null` (line 1264), storing NULL instead of the column's `DEFAULT 0`.
- **`_savePlanRegistry` has the same bug** (TaskViewerProvider.ts lines 10507-10529): constructs a new record from scratch, only copying specific fields (`existing?.kanbanColumn`, `existing?.complexity`, `existing?.worktreeId`), but NOT `existing?.isEpic` or `existing?.epicId`. This means registry saves also write DB-owned columns from a registry-derived record, producing `is_epic = NULL` on INSERT.
- The latest DB migration is **V35** (KanbanDatabase.ts line 528). The epic-location migration must be **V36**.
- `filterGhostPlans` exists in both `KanbanProvider.ts` (line 1142) and `TaskViewerProvider.ts` (line 14184). Both resolve relative paths against `workspaceRoot` via `path.resolve`, so both already handle `epics/` paths correctly — no change needed in either location.

## Design Decision

**All epics live in `.switchboard/epics/`. The DB determines if they appear on the kanban board.**

- `.switchboard/epics/{slug}.md` is the single file location for all epic documents
- The DB `plans` table holds a record with `is_epic=1` and `plan_file=.switchboard/epics/{slug}.md` for epics that should appear on the kanban board
- The epics tab reads from `.switchboard/epics/` (no change needed — already does this)
- The kanban board reads from the DB (no change needed — already does this)
- Subtask association stays in the DB via `epic_id` column (no change)
- Epic files include a human-readable subtask listing, updated when subtasks are added/removed

## User Review Required

Yes — this plan involves a file-location migration for ~4,000 published installs. The migration moves existing `plans/epic-{uuid}.md` files to `epics/` and updates DB `plan_file` paths. While the migration is designed to be idempotent and crash-safe, any migration that moves user files on disk warrants user review before execution. Additionally, the `promoteToEpic` behavioral change (file move) alters a previously in-place operation — users who rely on the current promote-to-epic behavior (file stays in `plans/`) should be aware of the change.

## Complexity Audit

### Routine
- Changing `createEpic` file paths from `plans/` to `epics/` in both `KanbanProvider.ts` and `PlanningPanelProvider.ts` — straightforward string/path changes
- Adding `isEpic` and `subtaskCount` to `buildBoardSignature` — single-line addition to a template string
- Writing subtask listing content to epic files — markdown string construction
- Slug generation logic — already exists in `PlanningPanelProvider.ts` line 2858, just needs reuse
- `deleteEpic` — no change needed (already tombstones DB, leaves file)

### Complex / Risky
- **`is_epic = NULL` data integrity bug (confirmed in production DB)**: The importer (watcher + registry) writes DB-owned columns (`is_epic`, `epic_id`, etc.) from file-derived records that have no business setting them. On INSERT, `upsertPlans` passes `record.isEpic ?? null` (line 1264), storing NULL instead of the column's `DEFAULT 0`. The fix requires enforcing the DB-owned/file-owned boundary: the importer's "new plan" INSERT must omit DB-owned columns entirely so column defaults apply, and the registry must not include DB-owned columns in records it doesn't own. Additionally, `createEpic` doesn't check `upsertPlan` results, allowing orphaned files that the registry later imports as non-epics. Requires fixes in 4 files + a V36 data-repair step.
- **`promoteToEpic` file move + DB path update**: requires a new `updatePlanFileByPlanId` method (the existing `updatePlanFile` is deprecated and broken for `sessionId=''` plans). Must order operations correctly (DB update before file move) to avoid watcher race conditions.
- **File watcher extension to `epics/`**: 5 hardcoded `.switchboard/plans` references in `GlobalPlanWatcherService.ts` all need parallel `epics/` handling. Missing any creates silent blind spots.
- **`_handlePlanFile` row-matching failure**: the watcher's "new plan" branch (line 501) fires when `getPlanByPlanFile` returns null for a file that `createEpic` just upserted. This is the misclassification that causes the importer to rebuild from scratch and clobber DB-owned state. The `registerPendingCreation` 3-second guard is a flaky band-aid; the real fix is enforcing the DB-owned boundary so even a misclassified INSERT can't clobber DB-owned columns.
- **V36 migration**: moves files on disk (non-transactional) + updates DB paths (transactional) + data repair (`is_epic NULL → 0`). Must be idempotent and crash-safe. Affects ~4,000 installs.
- **Subtask listing regeneration with marker preservation**: reading, slicing, and rewriting files while preserving user content outside managed markers — string parsing edge cases.

## Edge-Case & Dependency Audit

**Race Conditions:**
- `promoteToEpic` file move: the native watcher may fire delete for the old path and create for the new path. Mitigation: update DB `plan_file` BEFORE the file move, so `getPlanByPlanFile(oldPath)` returns null when the delete handler runs. Also register `pendingCreation` on the new path and `registerRename` on the old path.
- `registerPendingCreation` has a 3-second window; `registerRename` has a 2-second window. If the watcher is slow (>3s), the new path may be imported as a new plan. Mitigation: the DB update (done before the move) means the new path's `getPlanByPlanFile` will find the existing record (already updated to the new path), so the upsert becomes an UPDATE, not a duplicate INSERT.

**Security:**
- Slug generation from epic names: names with special characters are sanitized by `replace(/[^a-z0-9]+/g, '-')`. No path traversal risk since slugs are purely alphanumeric+hyphens.
- YAML frontmatter: epic names are YAML-quoted with `'` → `''` escaping (already done at KanbanProvider.ts line 6807). No injection risk.

**Side Effects:**
- `promoteToEpic` now moves files on disk — previously it was an in-place DB-only operation. Users with external tooling that references `plans/{name}.md` paths will break. This is an accepted trade-off of the unification goal.
- Migration moves files and archives originals as `.migrated.bak` — disk space increases slightly.
- `_handlePlanFile` for `epics/` directory will auto-create DB records for any `.md` file dropped into `epics/`. Users who use `epics/` as a pure document directory (no kanban presence) will get unexpected DB records. Mitigation: these records have `is_epic=1` and `kanbanColumn='CREATED'` — they appear on the board, which is the intended unification behavior.

**Dependencies & Conflicts:**
- The `updatePlanFile` deprecation (KanbanDatabase.ts line 1661) conflicts with the plan's original approach. Resolved by adding `updatePlanFileByPlanId`.
- The Claudify theme epic card styling bug is tracked separately — no dependency, but the board signature fix (Part 3) is a prerequisite for the theme fix to take effect on re-render.
- `agentPromptBuilder.ts` epic orchestration is unaffected — it reads from DB `epic_id`, not from file content.

## Dependencies

- None — this plan is self-contained. All referenced code is in the current codebase.

## Adversarial Synthesis

Key risks: (1) the deprecated `updatePlanFile` API is broken for `sessionId=''` plans and must be replaced with a new `updatePlanFileByPlanId` method; (2) the watcher extension must update all 5 hardcoded `plans/` references, not just one; (3) **`is_epic = NULL` bug confirmed in production DB** — the importer writes DB-owned columns (`is_epic`, `epic_id`) from file-derived records that have no business setting them. On INSERT, `upsertPlans` passes `record.isEpic ?? null`, storing NULL instead of `DEFAULT 0`. The `registerPendingCreation` 3-second guard is a flaky band-aid over the real problem: the importer misclassifying an existing DB plan as "new" and rebuilding from scratch. Mitigations: add `insertFileDerivedPlan` to `KanbanDatabase.ts` that INSERTs only file-derived columns, letting DB-owned columns use their DEFAULT values; fix `_savePlanRegistry` and `_handlePlanFile` to not include DB-owned columns in records they don't own; check `upsertPlan` result in `createEpic` to prevent orphaned files; add V36 data-repair (`UPDATE plans SET is_epic = 0 WHERE is_epic IS NULL`); enumerate all 5 watcher locations; order DB update before file move in `promoteToEpic` to eliminate the watcher race.

## Proposed Changes

### `src/services/KanbanDatabase.ts`

**Context:** Add a new `updatePlanFileByPlanId` method to replace the deprecated `updatePlanFile` for the promote-to-epic and migration paths. The existing `updatePlanFile` (line 1662) uses `getPlanBySessionId` which fails for watcher-imported plans with `sessionId=''`.

**Logic:**
```typescript
/**
 * Update plan_file by plan_id (not sessionId). Use this instead of the deprecated
 * updatePlanFile, which fails for watcher-imported plans with sessionId=''.
 */
public async updatePlanFileByPlanId(planId: string, newPlanFile: string): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    const relativePlanFile = this._ensureRelativePlanFile(newPlanFile);
    const sql = 'UPDATE plans SET plan_file = ?, updated_at = ? WHERE plan_id = ?';
    const params = [relativePlanFile, new Date().toISOString(), planId];
    return this._persistedUpdate(sql, params);
}
```

**Implementation:** Add after `updatePlanFile` (around line 1686). Uses the existing `_ensureRelativePlanFile` and `_persistedUpdate` helpers.

**Edge Cases:** If `planId` doesn't match any row, the UPDATE is a no-op (returns `true` from `_persistedUpdate` — acceptable, the caller should verify the plan exists before calling).

**Logic — `insertFileDerivedPlan` method (new — enforce DB-owned/file-owned boundary):**

The core architectural fix for the `is_epic = NULL` bug. The existing `upsertPlans` uses a single `INSERT ... ON CONFLICT DO UPDATE` statement that includes ALL columns. When a file-derived importer (watcher, registry) calls it with a record that omits DB-owned fields, `upsertPlans` passes `record.isEpic ?? null` (line 1264), storing NULL on INSERT instead of the column's `DEFAULT 0`. The COALESCE on conflict preserves existing values, but the INSERT path clobbers with NULL.

**Fix:** Add a new `insertFileDerivedPlan` method that INSERTs only file-derived columns + the key (`plan_file`, `workspace_id`), letting all DB-owned columns (`is_epic`, `epic_id`, `kanban_column`, `status`, `worktree_id`, etc.) use their schema DEFAULT values:

```typescript
/**
 * Insert a plan record using only file-derived fields.
 * DB-owned columns (is_epic, epic_id, kanban_column, status, worktree_id, etc.)
 * are left at their schema DEFAULT values — the file has no business setting them.
 * Use this for file-watcher imports and registry saves that don't own DB state.
 */
public async insertFileDerivedPlan(record: {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    complexity: string;
    tags: string;
    project: string;
    workspaceId: string;
    sourceType: string;
    createdAt: string;
    updatedAt: string;
}): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    const relativePlanFile = this._ensureRelativePlanFile(record.planFile);
    // INSERT only file-derived columns + key. DB-owned columns use DEFAULT values.
    // ON CONFLICT: update only file-derived columns, preserve DB-owned via COALESCE.
    const sql = `
        INSERT INTO plans (
            plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
            repo_scope, project, workspace_id, created_at, updated_at, last_action, source_type,
            brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
            clickup_task_id, linear_issue_id
        ) VALUES (?, ?, ?, ?, 'CREATED', 'active', ?, ?, '', ?, ?, ?, ?, '', ?, '', '', '', '', '', '', '')
        ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
            topic = excluded.topic,
            complexity = excluded.complexity,
            tags = excluded.tags,
            project = excluded.project,
            updated_at = excluded.updated_at
    `;
    try {
        this._db.run('BEGIN');
        this._db.run(sql, [
            record.planId, record.sessionId, record.topic, relativePlanFile,
            record.complexity, record.tags, record.project, record.workspaceId,
            record.createdAt, record.updatedAt, record.sourceType
        ]);
        this._db.run('COMMIT');
    } catch (error) {
        try { this._db.run('ROLLBACK'); } catch { }
        console.error('[KanbanDatabase] insertFileDerivedPlan failed:', error);
        return false;
    }
    return this._persist();
}
```

**Why this is the correct fix:**
- On INSERT: `is_epic` uses `DEFAULT 0`, `epic_id` uses `DEFAULT ''`, `kanban_column` uses `'CREATED'`, `status` uses `'active'` — no NULL clobbering
- On CONFLICT: only file-derived columns (`topic`, `complexity`, `tags`, `project`, `updated_at`) are updated — DB-owned columns are untouched
- The existing `upsertPlans` remains unchanged for callers that legitimately own DB state (`createEpic`, `promoteToEpic`, column moves, etc.)

**Implementation:** Add after `upsertPlan` (around line 1285). The ON CONFLICT clause intentionally does NOT use COALESCE — it simply doesn't touch DB-owned columns at all, which is the correct boundary enforcement.

**Edge Cases:** If the plan_file + workspace_id already exists, the ON CONFLICT branch updates only file-derived fields. If the INSERT fails (e.g., NOT NULL constraint on `workspace_id`), the transaction rolls back and returns `false`.

### `src/services/KanbanProvider.ts`

**Context:** Four changes: (0) `createEpic` error checking for `upsertPlan` result, (1) `createEpic` file path → `epics/`, (2) `promoteToEpic` file move + DB update, (3) `addSubtaskToEpic`/`removeSubtaskFromEpic` subtask listing regeneration.

**Logic — `createEpic` upsert error checking (line 6781):**
The current code does `await db.upsertPlan({...isEpic: 1...})` without checking the result. If the upsert fails silently (DB not ready, SQL error), the file is still written (line 6814), but no DB record with `is_epic=1` exists. The plan registry then imports the file with `is_epic = NULL`.

Fix: Check the upsert result and abort if it fails:
```typescript
const upsertOk = await db.upsertPlan({
    // ... existing fields ...
    isEpic: 1,
    epicId: ''
});
if (!upsertOk) {
    vscode.window.showErrorMessage('Failed to create epic: DB upsert failed. The epic file was not written.');
    break;
}
```

This ensures the file is NOT written if the DB record can't be created, preventing the orphaned-file scenario that leads to `is_epic = NULL`.

**Logic — `createEpic` (line 6779):**
Replace:
```typescript
const epicPlanFile = path.join('.switchboard', 'plans', `epic-${planId}.md`);
```
With:
```typescript
const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'epic');
let uniqueSlug = slug;
const epicDir = path.join(workspaceRoot, '.switchboard', 'epics');
if (fs.existsSync(path.join(epicDir, `${slug}.md`))) {
    uniqueSlug = `${slug}-${planId.slice(0, 8)}`;
}
const epicPlanFile = path.join('.switchboard', 'epics', `${uniqueSlug}.md`);
```
Also update the epic file content to include the subtask listing (see Part 2.1).

**Logic — `promoteToEpic` (line 6730):**
After `db.updateEpicStatus(plan.planId, 1, '')`, add file move logic:
```typescript
// Move file to epics/ directory for unified architecture
const slug = (plan.topic || 'epic').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'epic';
let uniqueSlug = slug;
const epicDir = path.join(workspaceRoot, '.switchboard', 'epics');
const oldAbsPath = path.resolve(workspaceRoot, plan.planFile);
await fs.promises.mkdir(epicDir, { recursive: true });
if (fs.existsSync(path.join(epicDir, `${slug}.md`))) {
    uniqueSlug = `${slug}-${plan.planId.slice(0, 8)}`;
}
const newRelPath = path.join('.switchboard', 'epics', `${uniqueSlug}.md`);
const newAbsPath = path.join(workspaceRoot, newRelPath);
// 1. Update DB plan_file BEFORE moving the file — so the watcher's delete
//    handler for the old path finds no matching record (already updated).
await db.updatePlanFileByPlanId(plan.planId, newRelPath);
// 2. Register watcher suppression for both paths
GlobalPlanWatcherService.registerPendingCreation(newAbsPath);
const oldRelPath = plan.planFile.replace(/\\/g, '/');
this._globalPlanWatcher?.registerRename(oldRelPath);
// 3. Move the file
try {
    await fs.promises.rename(oldAbsPath, newAbsPath);
} catch (moveErr) {
    // Fallback: leave file in plans/, DB path already updated — filterGhostPlans
    // will filter it out. Log warning.
    console.warn(`[KanbanProvider] promoteToEpic: file move failed, reverting DB path: ${moveErr}`);
    await db.updatePlanFileByPlanId(plan.planId, plan.planFile);
}
```

**Logic — `addSubtaskToEpic` (line 6700) and `removeSubtaskFromEpic` (line 6823):**
After `db.updateEpicStatus(...)` and before `this._refreshBoard(workspaceRoot)`, add:
```typescript
await this._regenerateEpicFile(workspaceRoot, epic.planId, db);
```

**Logic — new helper `_regenerateEpicFile`:**
```typescript
private async _regenerateEpicFile(workspaceRoot: string, epicPlanId: string, db: KanbanDatabase): Promise<void> {
    const epic = await db.getPlanByPlanId(epicPlanId);
    if (!epic || !epic.isEpic) return;
    const subtasks = await db.getSubtasksByEpicId(epicPlanId);
    const epicAbsPath = path.resolve(workspaceRoot, epic.planFile);
    let existingContent = '';
    try {
        existingContent = await fs.promises.readFile(epicAbsPath, 'utf8');
    } catch { /* file may not exist yet */ }
    const subtaskLines = subtasks.map(st => {
        const basename = path.basename(st.planFile);
        const topic = st.topic || basename;
        return `- [ ] [${topic}](../plans/${basename})`;
    });
    const subtaskSection = `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n${subtaskLines.join('\n') || '- [ ] (no subtasks)'}\n<!-- END SUBTASKS -->`;
    let newContent: string;
    const beginMarker = '<!-- BEGIN SUBTASKS';
    const endMarker = '<!-- END SUBTASKS -->';
    const beginIdx = existingContent.indexOf(beginMarker);
    const endIdx = existingContent.indexOf(endMarker);
    if (beginIdx !== -1 && endIdx !== -1) {
        // Replace existing managed section
        newContent = existingContent.slice(0, beginIdx) + subtaskSection + existingContent.slice(endIdx + endMarker.length);
    } else {
        // Append managed section
        newContent = existingContent.replace(/\n*$/, '') + '\n\n' + subtaskSection + '\n';
    }
    GlobalPlanWatcherService.registerPendingCreation(epicAbsPath);
    await fs.promises.writeFile(epicAbsPath, newContent, 'utf8');
}
```

**Edge Cases:**
- Slug collision: handled by `-{shortUuid}` suffix.
- File move failure: DB path reverted, file stays in `plans/`, `filterGhostPlans` handles gracefully.
- `epic.planFile` may be absolute (legacy) — `path.resolve` handles both.
- Subtask `planFile` may be empty — `path.basename('')` returns `''`, producing `../plans/` — acceptable (link will 404 but won't crash).

### `src/services/PlanningPanelProvider.ts`

**Context:** The `addToKanbanBoard` path of `createEpic` (line 2869) writes to `plans/epic-{planId}.md`. Change to `epics/{slug}.md` to match `KanbanProvider.createEpic`.

**Logic — line 2878:**
Replace:
```typescript
const epicPlanFile = path.join('.switchboard', 'plans', `epic-${planId}.md`);
```
With the same slug-based path generation as `KanbanProvider.createEpic` (see above).

**Edge Cases:** Same slug collision logic as KanbanProvider. The `!addToKanbanBoard` path (line 2854) already writes to `epics/` — no change needed. Also add the same `upsertPlan` result checking as KanbanProvider.createEpic (check return value, abort if false).

### `src/services/TaskViewerProvider.ts`

**Context:** `_savePlanRegistry` (line 10507) and `_registerPlan` (line 10536) create DB records without setting `isEpic`, causing `is_epic = NULL` on INSERT. This is the mechanism by which the production epic file `epic-3051b25c...md` ended up with `is_epic = NULL` despite being created via the create-epic modal. The registry is a file-derived importer — it has no business setting DB-owned columns like `is_epic` and `epic_id`.

**Logic — `_savePlanRegistry` (line 10507-10529): Switch to `insertFileDerivedPlan`**

Replace the `db.upsertPlans(records)` call (line 10532) with `db.insertFileDerivedPlan(record)` for each record. This ensures the registry only writes file-derived columns and leaves DB-owned columns (`is_epic`, `epic_id`, `kanban_column`, `status`, `worktree_id`) at their existing values (on conflict) or DEFAULT values (on insert).

```typescript
for (const record of records) {
    await db.insertFileDerivedPlan({
        planId: record.planId,
        sessionId: record.sessionId,
        topic: record.topic,
        planFile: record.planFile,
        complexity: record.complexity,
        tags: record.tags || '',
        project: record.project || '',
        workspaceId: record.workspaceId,
        sourceType: record.sourceType,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
    });
}
```

**Logic — `_registerPlan` (line 10536-10580): Same fix**

Replace the `db.upsertPlan(...)` call with `db.insertFileDerivedPlan(...)`, passing only file-derived fields. The registry doesn't own `is_epic`, `epic_id`, `kanban_column`, `status`, or `worktree_id` — those are set by explicit user actions (createEpic, promoteToEpic, column moves, etc.) via `upsertPlans`.

**Logic — `_migrateLegacyPlanRegistryEntries` (line 10457-10480): Same fix**

Replace `db.upsertPlans(records)` with individual `db.insertFileDerivedPlan(...)` calls. Legacy registry entries are file-derived — they don't carry DB-owned state.

**Why not just add `isEpic: existing?.isEpic` to the record?** That would preserve `is_epic` on conflict (via COALESCE), but on INSERT (new record), `upsertPlans` passes `undefined ?? null = null`, storing NULL instead of `DEFAULT 0`. The registry doesn't own `is_epic`, so it shouldn't be in the record at all. `insertFileDerivedPlan` is the correct boundary enforcement — it structurally prevents file-derived importers from writing DB-owned columns.

### `src/webview/kanban.html`

**Context:** `buildBoardSignature` (line 4335) omits `isEpic` and `subtaskCount`, so the board doesn't re-render when epic status changes.

**Logic — line 4338:**
Replace:
```javascript
.map(card => `${card.workspaceRoot || ''}|${card.planId || card.sessionId || ''}|${card.column}|${card.topic || ''}|${card.planFile || ''}|${card.complexity || 'Unknown'}|${card.lastActivity || ''}`)
```
With:
```javascript
.map(card => `${card.workspaceRoot || ''}|${card.planId || card.sessionId || ''}|${card.column}|${card.topic || ''}|${card.planFile || ''}|${card.complexity || 'Unknown'}|${card.lastActivity || ''}|${card.isEpic ? '1' : '0'}|${card.subtaskCount || 0}`)
```

**Edge Cases:** Cards without `isEpic`/`subtaskCount` (legacy data) default to `'0'` and `0` via the `||` fallbacks — no breakage.

### `src/services/GlobalPlanWatcherService.ts`

**Context:** The watcher only monitors `.switchboard/plans/`. Five hardcoded references to `plans/` must be extended to also handle `epics/`.

**Logic — 5 locations to update:**

1. **`_scanForNewFiles` (line 162):** After scanning `plansDir`, also scan `epicsDir`:
   ```typescript
   const epicsDir = path.join(workspaceRoot, '.switchboard', 'epics');
   if (fs.existsSync(epicsDir)) {
       await collectPaths(epicsDir); // same recursive collector
   }
   ```

2. **`_setupWatcherForFolder` (line 338):** Add a second watcher for `epics/`:
   ```typescript
   const epicPattern = new vscode.RelativePattern(folder, '.switchboard/epics/**/*.md');
   const epicWatcher = vscode.workspace.createFileSystemWatcher(epicPattern, false, false, false);
   // Same onCreateChange/onDelete handlers as plans watcher
   ```

3. **`_setupNativeWatcher` (line 367):** Also set up native watch for `epics/`:
   ```typescript
   const epicsDir = path.join(folder, '.switchboard', 'epics');
   if (fs.existsSync(epicsDir)) {
       this._setupNativeFsWatch(epicsDir, folder);
   }
   ```

4. **`_setupNativeFsWatch` (line 388):** The `startsWith(plansDir)` guard must also accept `epicsDir`:
   ```typescript
   const plansDir = path.resolve(path.join(workspaceRoot, '.switchboard', 'plans'));
   const epicsDir = path.resolve(path.join(workspaceRoot, '.switchboard', 'epics'));
   if (!fullPath.startsWith(plansDir) && !fullPath.startsWith(epicsDir)) return;
   ```

5. **`triggerScan` (line 606):** Also scan `epics/`:
   ```typescript
   const epicsDir = path.join(workspaceRoot, '.switchboard', 'epics');
   if (fs.existsSync(epicsDir)) {
       await scanDir(epicsDir);
   }
   ```

**Logic — `_handlePlanFile` (line 501): Enforce DB-owned/file-owned boundary on new imports:**

The watcher's "new plan" branch (line 501-524) currently builds a full `KanbanPlanRecord` and calls `db.upsertPlans([newRecord])`. This writes DB-owned columns (`is_epic`, `epic_id`) from a file-derived record, storing NULL on INSERT. The watcher is a file-derived importer — it has no business setting DB-owned columns.

**Fix:** Replace `db.upsertPlans([newRecord])` (line 525) with `db.insertFileDerivedPlan(newRecord)`, passing only file-derived fields:

```typescript
// Replace: await db.upsertPlans([newRecord]);
// With:
await db.insertFileDerivedPlan({
    planId: newRecord.planId,
    sessionId: newRecord.sessionId,
    topic: newRecord.topic,
    planFile: newRecord.planFile,
    complexity: newRecord.complexity,
    tags: newRecord.tags,
    project: newRecord.project || '',
    workspaceId: newRecord.workspaceId,
    sourceType: newRecord.sourceType,
    createdAt: newRecord.createdAt,
    updatedAt: newRecord.updatedAt
});
```

This ensures:
- On INSERT: `is_epic` uses `DEFAULT 0`, `epic_id` uses `DEFAULT ''` — no NULL clobbering
- On CONFLICT: only file-derived columns are updated — DB-owned columns are untouched
- The `registerPendingCreation` 3-second guard becomes less critical — even if it expires and the watcher re-imports the file, `insertFileDerivedPlan` can't clobber `is_epic` because it doesn't include it in the SQL

**The existing-record branch (line 531-538) is already safe** — it spreads `...plan` and `upsertPlans` uses COALESCE on conflict. However, for consistency, it should also switch to `insertFileDerivedPlan` so the watcher never writes DB-owned columns via either branch. The spread of `...plan` in the existing branch means the record includes `isEpic: plan.isEpic`, which `upsertPlans` passes as `plan.isEpic ?? null`. If `plan.isEpic` is `0`, COALESCE preserves the existing value. If `plan.isEpic` is `undefined` (shouldn't happen for an existing record, but defensive), it passes NULL. Switching to `insertFileDerivedPlan` eliminates this edge case entirely.

**Note on `epics/` directory detection:** The original plan proposed setting `isEpic: 1` for files in `epics/` based on directory path. With `insertFileDerivedPlan`, this is no longer needed for the NULL fix — `is_epic` defaults to `0` on INSERT, which is correct for a file the watcher knows nothing about. If we want files dropped into `epics/` to auto-import as epics, that's a separate feature (Part 4.2) and should be done via an explicit `UPDATE plans SET is_epic = 1 WHERE plan_file = ?` after the `insertFileDerivedPlan` call, NOT by having the file-derived importer set a DB-owned column.

**Edge Cases:**
- `epics/` directory may not exist — all additions guard with `fs.existsSync`.
- Native watcher `recursive: true` on `epics/` may catch subdirectories — the `startsWith` guard handles this.
- Cross-platform path separators: `relativePath` is already normalized to `/` (line 446).

### `src/services/KanbanDatabase.ts` — V36 Migration

**Context:** Existing kanban-created epics have `plan_file` starting with `.switchboard/plans/epic-`. These must be moved to `.switchboard/epics/` and DB paths updated.

**Logic — add `MIGRATION_V36_SQL` (after line 525, after V35):**
```typescript
// V36: Migrate epic files from plans/ to epics/ directory
// Note: file moves are done in code (not SQL) — this migration block is a marker
// for the version gate. The actual file I/O happens in _runMigrationV36().
const MIGRATION_V36_SQL: string[] = []; // no schema changes needed
```

**Logic — add `_runMigrationV36` method:**
```typescript
private async _runMigrationV36(workspaceRoot: string): Promise<void> {
    const version = await this.getMigrationVersion();
    if (version >= 36) return;

    // ── Data Repair: fix is_epic = NULL → 0 ──
    // Multiple code paths (_savePlanRegistry, _handlePlanFile, _migrateLegacyPlanRegistryEntries)
    // created records without setting isEpic, resulting in is_epic = NULL (overriding DEFAULT 0).
    // This repair sets all NULL is_epic values to 0, restoring the intended default.
    // Epics that were properly created (is_epic = 1) are unaffected.
    this._db.run('UPDATE plans SET is_epic = 0 WHERE is_epic IS NULL');
    console.log('[KanbanDatabase] V36 data repair: set is_epic = 0 for NULL records');

    // ── File Migration: move epic files from plans/ to epics/ ──
    // Query all epics with plan_file in plans/
    const stmt = this._db.prepare(
        `SELECT ${PLAN_COLUMNS} FROM plans WHERE is_epic = 1 AND plan_file LIKE '.switchboard/plans/epic-%'`
    );
    const epics = this._readRows(stmt);
    const epicsDir = path.join(workspaceRoot, '.switchboard', 'epics');
    await fs.promises.mkdir(epicsDir, { recursive: true });
    for (const epic of epics) {
        const oldAbs = path.resolve(workspaceRoot, epic.planFile);
        const basename = path.basename(epic.planFile);
        const newRel = path.join('.switchboard', 'epics', basename);
        const newAbs = path.resolve(workspaceRoot, newRel);
        try {
            // Archive original as .migrated.bak (don't unlink — CLAUDE.md migration rules)
            if (fs.existsSync(oldAbs)) {
                await fs.promises.copyFile(oldAbs, oldAbs + '.migrated.bak');
                await fs.promises.rename(oldAbs, newAbs);
            }
            // Update DB path by planId (not sessionId — may be empty)
            await this.updatePlanFileByPlanId(epic.planId, newRel);
        } catch (e) {
            console.warn(`[KanbanDatabase] V36 migration: failed to move ${epic.planFile}: ${e}`);
            // Leave DB record as-is — filterGhostPlans will handle gracefully
        }
    }
    await this.setMigrationVersion(36);
}
```

**Implementation:** Call `_runMigrationV36` in `_runMigrations` after the V35 block (around line 4737). The migration is idempotent: if `version >= 36`, it's a no-op. If a file can't be moved, it logs a warning and continues — the DB record stays with the old path, and `filterGhostPlans` filters it out if the file was already moved by a previous partial run.

**Edge Cases:**
- Crash mid-migration: `setMigrationVersion(36)` is only called after all files are processed. On restart, `version < 36` so the migration re-runs. Files already moved (old path doesn't exist) are skipped via `fs.existsSync` check.
- File already in `epics/`: the `LIKE '.switchboard/plans/epic-%'` filter excludes them.
- `.migrated.bak` already exists: `copyFile` overwrites it — acceptable (same content).

## Implementation Plan

### Part 0: Fix `is_epic = NULL` Bug — Enforce DB-Owned/File-Owned Boundary

The defect is not "the file doesn't carry the flag" — it's "an import was allowed to overwrite a DB-authoritative field from a file that has no business setting it." The fix is entirely DB-side: the importer must never write DB-owned columns from file-derived records.

**0.1 — `KanbanDatabase.ts`: Add `insertFileDerivedPlan` method**

Add a new `insertFileDerivedPlan` method that INSERTs only file-derived columns (`topic`, `complexity`, `tags`, `project`) + the key (`plan_file`, `workspace_id`), letting all DB-owned columns (`is_epic`, `epic_id`, `kanban_column`, `status`, `worktree_id`, etc.) use their schema DEFAULT values. On conflict, update only file-derived columns — DB-owned columns are untouched. See Proposed Changes: KanbanDatabase.ts for full implementation.

**0.2 — `GlobalPlanWatcherService._handlePlanFile` (line 501 & 531): Use `insertFileDerivedPlan`**

Both the "new plan" branch (line 525: `db.upsertPlans([newRecord])`) and the "existing plan" branch (line 538: `db.upsertPlans([updatedRecord])`) must switch to `db.insertFileDerivedPlan(...)`. The watcher is a file-derived importer — it must never write DB-owned columns. This eliminates the `is_epic = NULL` clobbering on INSERT and makes the `registerPendingCreation` 3-second guard less critical (even if it expires, a re-import can't clobber DB-owned state). See Proposed Changes: GlobalPlanWatcherService.ts.

**0.3 — `TaskViewerProvider._savePlanRegistry` / `_registerPlan` / `_migrateLegacyPlanRegistryEntries`: Use `insertFileDerivedPlan`**

Replace all `db.upsertPlans(records)` / `db.upsertPlan(record)` calls in these three methods with `db.insertFileDerivedPlan(...)`. The registry is a file-derived importer — it doesn't own `is_epic`, `epic_id`, `kanban_column`, `status`, or `worktree_id`. See Proposed Changes: TaskViewerProvider.ts.

**0.4 — `KanbanProvider.createEpic` (line 6781) & `PlanningPanelProvider.createEpic` (line 2880): Check `upsertPlan` result**

These are DB-authoritative callers — they legitimately use `upsertPlans` with `isEpic: 1`. But they don't check the return value. If the upsert fails silently, the file is still written, creating an orphaned file that the registry later imports as a non-epic. Fix: check the return value and abort if false. See Proposed Changes: KanbanProvider.ts.

**0.5 — V36 Migration: Data repair for existing NULL records**

The V36 migration (Part 5) includes a data-repair step: `UPDATE plans SET is_epic = 0 WHERE is_epic IS NULL`. This cleans up any existing records that have `is_epic = NULL` due to the bugs in 0.1-0.3. Records with `is_epic = 1` (properly created epics) are unaffected.

**0.6 — Note on the production file `epic-3051b25c-35ae-48c8-9d21-b70436e0c8a2.md`**

This file was created via the create-epic modal but has `is_epic = NULL` in the DB. After the V36 migration runs, the data-repair step will set `is_epic = 0` (not `1`, because the record was never properly set as an epic by `createEpic`'s upsert — the `plan_id = session_id` pattern proves the registry created the record, not `createEpic`). The file will be treated as a regular plan, not an epic. The user will need to re-create the epic via the modal (or manually set `is_epic = 1` in the DB) after the migration. This is an acceptable outcome — the original epic creation failed silently, and the data repair prevents the NULL from causing further issues.

### Part 1: Unify Epic File Location

**1.1 — `KanbanProvider.createEpic` (line 6744)**

Change the epic file path from `.switchboard/plans/epic-{planId}.md` to `.switchboard/epics/{slug}.md`:
- Generate a slug from the epic name: `name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'epic'`
- If a file with that slug already exists, append `-{shortUuid}` (first 8 chars of planId) for uniqueness
- Set `epicPlanFile = path.join('.switchboard', 'epics', `${slug}.md`)` (relative path for DB)
- Write the file to `path.join(workspaceRoot, '.switchboard', 'epics', `${slug}.md`)`
- Register with `GlobalPlanWatcherService.registerPendingCreation` (still needed — the watcher will be extended to watch `epics/` in Part 4)

**1.2 — `PlanningPanelProvider.createEpic` (line 2836)**

Unify with kanban's createEpic. Both paths (addToKanbanBoard true/false) should write to `.switchboard/epics/{slug}.md`:
- The `!addToKanbanBoard` path (line 2854) already writes to `epics/` — no change needed
- The `addToKanbanBoard` path (line 2869) currently writes to `plans/epic-{planId}.md` — change to `epics/{slug}.md` (same slug logic as 1.1)
- Both paths should use the same slug generation and file writing logic

**1.3 — `KanbanProvider.promoteToEpic` (line 6730)**

When a plan is promoted to epic:
- Move the plan file from its current location (typically `.switchboard/plans/{name}.md`) to `.switchboard/epics/{slug}.md`
- Update the DB `plan_file` path to the new location using the new `db.updatePlanFileByPlanId(plan.planId, newRelPath)` method (NOT the deprecated `updatePlanFile` — see Proposed Changes: KanbanDatabase.ts)
- **Critical ordering**: Update the DB `plan_file` BEFORE moving the file on disk. This ensures the watcher's delete handler for the old path finds no matching DB record (already updated to the new path), eliminating the race condition.
- Register the new path with `GlobalPlanWatcherService.registerPendingCreation`
- Register a rename with `globalPlanWatcher.registerRename(oldRelativePath)` so the watcher doesn't tombstone the old path
- If the file move fails (permissions), revert the DB path update and leave the file in `plans/` with `is_epic=1` — log a warning

> **Correction from original plan**: The original plan called `db.updatePlanFile(plan.planFile, workspaceId, newPlanFile)` — this is wrong. The actual signature is `updatePlanFile(sessionId, planFile, skipTimestampUpdate?)`, and the method is `@deprecated`. It also uses `getPlanBySessionId` internally, which fails for watcher-imported plans with `sessionId=''`. Use the new `updatePlanFileByPlanId(planId, newPlanFile)` method instead.

**1.4 — `KanbanProvider.deleteEpic` (line 6834)**

When an epic is deleted from the kanban board:
- Tombstone the DB record (already done)
- Optionally delete the file from `epics/`, OR leave it as a standalone planning document
- **Decision**: Leave the file. The epic document may still be useful as a planning reference. The `fetchEpicDocuments` function will still show it in the epics tab. If the user wants to delete the file, they can do so from the epics tab. This preserves user data (per CLAUDE.md migration rules).

### Part 2: Epic File Content — Subtask Listing

**2.1 — Write subtask listing on epic creation**

When `KanbanProvider.createEpic` writes the epic file, include a subtask listing section:

```markdown
---
description: 'Epic Name'
---

# Epic Name

Optional description

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Subtask Name 1](../plans/subtask-file-1.md)
- [ ] [Subtask Name 2](../plans/subtask-file-2.md)
<!-- END SUBTASKS -->
```

The subtask list is built from the `subtasks` array (already fetched at line 6756-6759). Use relative paths from `epics/` to `plans/` (i.e., `../plans/{basename}`), where `basename = path.basename(subtask.planFile)`.

**2.2 — Update subtask listing on add/remove**

- `addSubtaskToEpic` (line 6700): After updating the DB, call `_regenerateEpicFile(workspaceRoot, epic.planId, db)` to regenerate the epic file's subtask listing
- `removeSubtaskFromEpic` (line 6823): After updating the DB, call `_regenerateEpicFile(workspaceRoot, epic.planId, db)` to regenerate the epic file's subtask listing
- Create a helper function `_regenerateEpicFile(workspaceRoot, epicPlanId, db)` that:
  1. Fetches the epic record from DB via `db.getPlanByPlanId(epicPlanId)`
  2. Fetches subtasks via `db.getSubtasksByEpicId(epicPlanId)`
  3. Reads the existing epic file content (preserving any user-edited content outside the managed markers)
  4. Rewrites the file with the updated subtask listing between the `<!-- BEGIN SUBTASKS -->` / `<!-- END SUBTASKS -->` markers
  5. Registers with `GlobalPlanWatcherService.registerPendingCreation`
  6. If markers don't exist (legacy file), appends the managed section

**2.3 — Preserve user-edited content**

The subtask listing should be a managed section delimited by markers:
```markdown
<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] ...
<!-- END SUBTASKS -->
```
When regenerating, only replace content between the markers. If markers don't exist (legacy file), append the section. This allows users to add custom content to the epic file without losing it on subtask changes.

### Part 3: Fix Board Signature & Rendering

**3.1 — Include epic metadata in board signature**

In `buildBoardSignature` (line 4335), add `isEpic` and `subtaskCount` to the signature:

```javascript
function buildBoardSignature(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return '';
    return cards
        .map(card => `${card.workspaceRoot || ''}|${card.planId || card.sessionId || ''}|${card.column}|${card.topic || ''}|${card.planFile || ''}|${card.complexity || 'Unknown'}|${card.lastActivity || ''}|${card.isEpic ? '1' : '0'}|${card.subtaskCount || 0}`)
        .sort()
        .join('||');
}
```

This ensures the board re-renders when a card's epic status or subtask count changes, even if nothing else changes.

### Part 4: File Watcher Extension

**4.1 — Watch `.switchboard/epics/` directory**

In `GlobalPlanWatcherService.ts`, extend the watcher to also monitor `.switchboard/epics/`. There are **5 hardcoded `.switchboard/plans` references** that all need parallel `epics/` handling:

1. **`_scanForNewFiles` (line 162)** — also scan `path.join(workspaceRoot, '.switchboard', 'epics')` with the same `collectPaths` recursive collector
2. **`_setupWatcherForFolder` (line 338)** — add a second `vscode.RelativePattern` for `.switchboard/epics/**/*.md` with the same create/change/delete handlers
3. **`_setupNativeWatcher` (line 367)** — also call `_setupNativeFsWatch` for `path.join(folder, '.switchboard', 'epics')` if it exists
4. **`_setupNativeFsWatch` (line 388)** — the `startsWith(plansDir)` guard must also accept `epicsDir`: `if (!fullPath.startsWith(plansDir) && !fullPath.startsWith(epicsDir)) return;`
5. **`triggerScan` (line 606)** — also scan `path.join(workspaceRoot, '.switchboard', 'epics')` with the same `scanDir` recursive collector

In the file change handler, treat files from `epics/` the same as files from `plans/` — call `_handlePlanFile`.

**4.2 — Handle epic file imports via explicit DB update (not file-derived INSERT)**

With the `insertFileDerivedPlan` fix from Part 0, files dropped into `epics/` will be imported with `is_epic = 0` (the column DEFAULT) — correct for a file the watcher knows nothing about. If we want files dropped into `epics/` to auto-import as epics (`is_epic = 1`), this must be done via an **explicit DB update after the file-derived insert**, NOT by having the file-derived importer set a DB-owned column:

```typescript
// After db.insertFileDerivedPlan(...) in _handlePlanFile:
if (relativePath.startsWith('.switchboard/epics/')) {
    // Explicitly set is_epic=1 — this is a DB-authoritative decision, not a file-derived one
    await db.updateEpicStatus(newRecord.planId, 1, '');
}
```

This preserves the DB-owned/file-owned boundary: the file-derived insert handles file-derived columns, and the explicit `updateEpicStatus` handles the DB-owned `is_epic` column. Set `kanbanColumn='CREATED'` as default (already the case via `metadata.kanbanColumn || 'CREATED'`). This allows users to manually create epic documents by dropping markdown files into `.switchboard/epics/`.

### Part 5: Migration

**5.1 — Migrate existing kanban-created epics (V36)**

Add a V36 migration that runs on kanban DB open (in `_runMigrations`, after the V35 block):
- Add `MIGRATION_V36_SQL` (empty array — no schema changes, just a version marker)
- Add `_runMigrationV36(workspaceRoot)` method that:
  1. Checks `getMigrationVersion() >= 36` → no-op if already applied
  2. **Data repair**: `UPDATE plans SET is_epic = 0 WHERE is_epic IS NULL` — fixes the `is_epic = NULL` bug from `_savePlanRegistry` / `_handlePlanFile` / `_migrateLegacyPlanRegistryEntries` omitting `isEpic`
  3. Queries all plans with `is_epic=1` and `plan_file LIKE '.switchboard/plans/epic-%'`
  4. For each, moves the file from `plans/` to `epics/` (preserving the filename — the `epic-{uuid}.md` name is kept as-is for traceability)
  5. Archives the original as `{filename}.migrated.bak` per CLAUDE.md migration rules (copy then rename, don't unlink)
  6. Updates the DB `plan_file` path via `updatePlanFileByPlanId(epic.planId, newRelPath)` (NOT the deprecated `updatePlanFile`)
  7. Calls `setMigrationVersion(36)` after all files are processed

> **Note:** The migration preserves the `epic-{uuid}.md` filename rather than generating a slug. This is intentional — the UUID in the filename ensures uniqueness without collision detection, and renaming to a slug would lose the traceability link to the original planId.

**5.2 — Migration safety**

- The migration should be idempotent — if it's already run (`version >= 36`), it should be a no-op
- Use the migration version system (`MIGRATION_VERSION_KEY`) to track whether this migration has been applied
- File I/O is non-transactional — `setMigrationVersion(36)` is only called after all files are processed. On crash mid-migration, `version < 36` so the migration re-runs. Files already moved (old path doesn't exist) are skipped via `fs.existsSync` check.
- If a file can't be moved (permissions, missing file), log a warning and leave the DB record as-is (the `filterGhostPlans` check will handle it gracefully)
- The `.migrated.bak` files preserve the originals per CLAUDE.md rules

### Part 6: `filterGhostPlans` Update

**6.1 — Handle epic file paths in `epics/`**

The `filterGhostPlans` function (KanbanProvider.ts line 1142) already resolves relative paths against `workspaceRoot`:
```typescript
const resolvedPath = path.isAbsolute(planPath) ? planPath : path.resolve(resolvedWorkspaceRoot, planPath);
const exists = fs.existsSync(resolvedPath);
```

Since the DB `plan_file` will store `.switchboard/epics/{slug}.md` (a relative path), this will resolve correctly to `{workspaceRoot}/.switchboard/epics/{slug}.md`. **No change needed** — the existing logic handles it.

The same applies to `TaskViewerProvider.ts` `filterGhostPlans` (line 14184), which uses the same `path.resolve` pattern. **No change needed** in either location.

### Part 7: Rebuild & Verify

> **Session directives**: Skip compilation (`npm run compile`) and skip automated tests — these will be run separately by the user.

- Test epic creation from kanban: select cards, click EPIC, go through modal
- Verify epic file appears in `.switchboard/epics/` with subtask listing
- Verify epic appears on kanban board
- Verify epic appears in project.html epics tab
- Verify subtask count badge shows correct count
- Test promote-to-epic (single card): verify file moves to `epics/`, DB path updated, board re-renders with epic styling
- Test add/remove subtask: verify epic file subtask listing updates between markers
- Test delete epic: verify DB record tombstoned, file remains in `epics/`
- Test migration: create a fake `plans/epic-{uuid}.md` with DB record (`is_epic=1`), restart, verify it moves to `epics/` and `.migrated.bak` is created
- Test manual file drop: drop a `.md` file into `.switchboard/epics/`, verify it appears on kanban board with `is_epic=1`

## Edge Cases & Risks

1. **Slug collisions**: Two epics with the same name would generate the same slug. Mitigation: append `-{shortUuid}` if file exists.
2. **User manually edits epic file**: The managed subtask section (between markers) is auto-regenerated. User content outside the markers is preserved.
3. **Epic file deleted manually**: `filterGhostPlans` will filter it out of the kanban board. The DB record remains. The epics tab won't show it (file doesn't exist). This is acceptable — the user deleted it.
4. **Promote-to-epic file move fails**: If the file can't be moved (permissions), revert the DB path update and leave the file in `plans/` with `is_epic=1`. Log a warning. `filterGhostPlans` handles the stale path gracefully.
5. **Migration on large installs**: ~4,000 installs, many on older versions. The migration moves files and updates DB paths. If the extension crashes mid-migration, the idempotent design allows re-running. The `.migrated.bak` files preserve the originals.
6. **File watcher race condition**: The `registerPendingCreation` 3-second window may expire before the watcher's periodic scan. With the `insertFileDerivedPlan` fix (Part 0), this is no longer critical — even if the watcher re-imports a file after the guard expires, `insertFileDerivedPlan` can't clobber DB-owned columns (`is_epic`, `epic_id`) because it doesn't include them in the SQL. The guard remains as an optimization (avoids unnecessary DB writes), but the DB-owned/file-owned boundary is the real protection.
7. **Project panel `createEpic` with `addToKanbanBoard=false`**: These epics already go to `epics/` with no DB record. They appear in the epics tab but not on the kanban board. This is the intended behavior — the user can add them to the board later via the manage modal or by dragging.
8. **Watcher-imported epic with `sessionId=''`**: The deprecated `updatePlanFile` uses `getPlanBySessionId` which fails for these plans. The new `updatePlanFileByPlanId` method uses `plan_id` directly, avoiding this issue entirely.
9. **`_handlePlanFile` misclassification as "new"**: The watcher's "new plan" branch fires when `getPlanByPlanFile` returns null for a file that exists in the DB. With `insertFileDerivedPlan`, this misclassification is harmless — the INSERT becomes a no-op (ON CONFLICT updates only file-derived columns), and DB-owned columns are preserved. The `registerPendingCreation` 3-second guard was a flaky band-aid over this; the DB-owned/file-owned boundary is the structural fix.
10. **`insertFileDerivedPlan` ON CONFLICT doesn't update `kanban_column`**: If a plan is moved to a different column via the kanban board (DB-authoritative `upsertPlans`), and then the watcher re-imports the file, `insertFileDerivedPlan`'s ON CONFLICT clause does NOT touch `kanban_column` — the column move is preserved. This is correct: the file doesn't own the column, the DB does.

## Verification Plan

### Automated Tests

> **Session directive**: Skip automated tests — the test suite will be run separately by the user.

### Manual Verification Checklist

- [ ] Epic creation from kanban: file appears in `.switchboard/epics/` with subtask listing between markers
- [ ] Epic appears on kanban board with epic styling
- [ ] Epic appears in project panel epics tab
- [ ] Subtask count badge shows correct count
- [ ] Board re-renders on promote-to-epic (signature change detected)
- [ ] Promote-to-epic: file moves to `epics/`, DB `plan_file` updated, old path no longer in DB
- [ ] Promote-to-epic fallback: if file move fails, DB path reverts, file stays in `plans/`, `is_epic=1` set
- [ ] Add subtask: epic file subtask listing updates (markers preserved, user content outside markers intact)
- [ ] Remove subtask: epic file subtask listing updates
- [ ] Delete epic: DB record tombstoned, file remains in `epics/`, epics tab still shows it
- [ ] V36 migration: `plans/epic-{uuid}.md` → `epics/epic-{uuid}.md`, `.migrated.bak` created, DB path updated
- [ ] V36 migration data repair: `is_epic = NULL` records set to `is_epic = 0`
- [ ] V36 migration idempotency: re-running is a no-op
- [ ] Manual file drop into `epics/`: file imported with `is_epic=1` (via explicit `updateEpicStatus` after `insertFileDerivedPlan`), appears on kanban board
- [ ] `filterGhostPlans`: epic files in `epics/` resolve correctly (no false filtering)
- [ ] TaskViewerProvider: epic files in `epics/` appear correctly (no false filtering)
- [ ] **DB-owned boundary: `insertFileDerivedPlan` does not clobber `is_epic` on INSERT** — verify `is_epic = 0` (not NULL) for new file-derived imports
- [ ] **DB-owned boundary: `insertFileDerivedPlan` does not clobber `is_epic` on CONFLICT** — create an epic (`is_epic=1`), trigger a file re-import (touch the file), verify `is_epic` stays `1`
- [ ] **DB-owned boundary: `insertFileDerivedPlan` does not clobber `kanban_column` on CONFLICT** — move a plan to a new column, trigger a file re-import, verify column is preserved
- [ ] **Registry: `_savePlanRegistry` does not clobber `is_epic`** — create an epic, trigger a registry save, verify `is_epic` stays `1`
- [ ] **`createEpic` error handling: if `upsertPlan` fails, file is NOT written** — simulate DB failure, verify no orphaned file

## Recommendation

**Complexity: 7 → Send to Lead Coder**

This plan involves multi-file coordination across 6 source files, two new DB methods (`updatePlanFileByPlanId` and `insertFileDerivedPlan`), a DB-owned/file-owned boundary enforcement that structurally prevents the `is_epic = NULL` data integrity bug, a file-location migration (V36) affecting ~4,000 published installs, and a watcher race condition that requires careful operation ordering. The `insertFileDerivedPlan` method is the core architectural fix — it structurally prevents file-derived importers from clobbering DB-owned columns, eliminating the `is_epic = NULL` bug at its root rather than patching individual callers. A lead coder should execute this with attention to the DB-owned/file-owned boundary, the operation ordering in `promoteToEpic`, and the 5-location watcher extension.
