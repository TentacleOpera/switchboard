# Fix Plan→Project Assignment End-to-End (Pin Parsing, Upsert Stamping, project_id Auto-Create, Intent-Time Pin Rule)

## Goal

Make project assignment for newly created plans work deterministically: a plan created while a project is active on the kanban board (or explicitly requested for a project) must land on that project's board — regardless of which code path inserts the DB row, whether the user switches projects mid-task, and whether the project row already exists in the `projects` table.

### Problem Analysis & Root Cause

The feature's design is simple: (1) selecting a project on the kanban board writes `kanban.activeProjectFilter` to the DB `config` table; (2) any plan/feature row created in the DB reads that key to populate its project assignment. This has been "fixed" at least three times and still fails. Investigation found **four independent defects** that compose into the persistent failure. All were verified against the live `kanban.db` and current `src/`:

**Defect 1 — The run-sheet/session upsert path never reads the config (the primary race).**
Two independent paths create a plan's DB row:
- The file watcher (`GlobalPlanWatcherService._handlePlanFile`) reads `kanban.activeProjectFilter` and stamps the project — but **only in its new-plan branch** (`GlobalPlanWatcherService.ts:527-536`). Its existing-plan branch deliberately never stamps ("auto-assign is FIRST-IMPORT ONLY", line 629).
- The run-sheet/session machinery (`TaskViewerProvider._buildKanbanRecordFromSheet` at `TaskViewerProvider.ts:2474` → `upsertPlan` at `:15455`, and `_syncKanbanDbFromSheetsSnapshot` → `KanbanMigration.syncPlansMetadata`/`bootstrapIfNeeded`) builds records with **no `project`/`projectId` fields at all** and never consults the config. `upsertPlans` binds `record.project || ''`.

These race. When an agent session creates a plan, the run-sheet insert usually wins → row born with `project=''` → watcher arrives second, sees an existing row, and by design never stamps. `COALESCE(NULLIF(excluded.project,''), plans.project)` then preserves the empty value forever. This is why the bug is intermittent, why it survives testing (watcher wins in test conditions), and why three plumbing fixes to the config write/read path changed nothing — they hardened the branch that loses the race.

> **Clarification (verified against source):** `_buildKanbanRecordFromSheet` is called with `preserveExistingFields: boolean = true` as the default. The caller at `TaskViewerProvider.ts:15453` passes only four args, so the default applies — meaning an **existing** row's `project`/`projectId` ARE preserved (lines 2537-2548). The race is therefore specific to **fresh inserts** (no existing DB row), where `baseRecord` (lines 2510-2530) omits `project`/`projectId` entirely → `record.project` is `undefined` → `upsertPlans` binds `record.project || ''` = `''`. The `_syncKanbanDbFromSheetsSnapshot` path (line 2570) explicitly passes `preserveExistingFields=false`, so it loses project on BOTH fresh and existing rows — but COALESCE re-heals existing rows on conflict-update, so the visible damage is still concentrated on fresh inserts. The fix below (Phase 2) targets the fresh-INSERT window in both methods.

**Defect 2 — The `**Project:**` pin parser rejects the form agents actually write.**
`planMetadataUtils.ts:96` matches `/^\*\*Project(?:\*\*:\s*|:\*\*)\s*(.+)$/im` — anchored at line start. Agents write metadata as list items under `## Metadata` (e.g. `- **Project:** switchboard`), which is exactly the form the **Tags** regex on line 90 explicitly tolerates (`^[\s\-\*\>]*(?:\d+\.\s*)?...`). Result: Tags import, project pins are silently dropped. Verified: the six comms-monitor plans created 2026-07-05 all carry `- **Project:** switchboard` in the file and all have `project=''` in the DB. The prompt-side PROJECT PIN directive (`agentPromptBuilder.ts:664`) and the agent-side habit both work — the parser throws the result away.

**Defect 3 — `project_id` resolution fails silently when the named project has no `projects` row.**
`insertFileDerivedPlan` (`KanbanDatabase.ts:1457`) resolves `project_id` via `SELECT id FROM projects WHERE name = ?`; on miss it writes `project_id=NULL` with no log and no auto-create. The board's project view JOINs on `project_id` (`getBoardFilteredByProject`, `KanbanDatabase.ts:2879`), so a name-stamped plan with NULL id shows under **Unassigned**. Verified: 40 plans in this repo's DB carry `project='Switchboard'/'switchboard'` with `project_id=NULL`; the `projects` table has no such row. `upsertPlans` is worse — it doesn't attempt name→id resolution at all (`KanbanDatabase.ts:1416` comment at `KanbanProvider.ts:10111` acknowledges this).

**Defect 4 — The config key gets silently wiped to `''`.**
`_refreshBoardImpl` (`KanbanProvider.ts:2866`) writes the in-memory filter to the config key on **every refresh** — including `''` whenever `_projectFilter` is null/UNASSIGNED. The restore-validation at `KanbanProvider.ts:2845-2850` resets a restored filter to UNASSIGNED when its name is missing from `getProjects()` (which happens whenever Defect 3's missing-row condition exists, or the projects query races DB readiness). Net effect: a legitimate selection can be erased without any user action, after which even the watcher's first-import branch stamps nothing. Verified: this DB's config value is currently `''`.

### Design decision — where intent is captured

"Read the active project at file-write time" was considered and rejected: it has the same race shape (user switches boards while the agent works) and would override an explicit "write a plan for project X" instruction. The correct capture point is **request time**, with this precedence everywhere:

1. **Explicit pin** (`**Project:**` frontmatter, from the user naming a project or from a dispatch-prompt PROJECT PIN) — always wins.
2. **Active project at row-creation time** (config key read inside the DB layer on fresh INSERT) — fallback when no pin exists.
3. **Unassigned** — when neither exists. Manual reassignment on the board remains the correction path.

## Metadata

- **Tags:** bugfix, database, backend, refactor
- **Complexity:** 6
- **Files touched:** `src/services/planMetadataUtils.ts`, `src/services/KanbanDatabase.ts`, `src/services/GlobalPlanWatcherService.ts`, `src/services/KanbanProvider.ts`, `AGENTS.md` (+ `CLAUDE.md`, `.agents/workflows/switchboard-chat.md`, `.claude/skills/switchboard-chat/SKILL.md` — the three files that mirror the pin rule)

## User Review Required

None.

## Complexity Audit

### Routine
- Phase 1 regex fix + unit tests (mirror of the adjacent Tags regex at `planMetadataUtils.ts:90`).
- Phase 5 AGENTS.md / CLAUDE.md / workflow-skill text change (unconditional pin rule).
- Phase 4 validation change (remove the UNASSIGNED reset branch at `KanbanProvider.ts:2848-2850`, call the auto-create helper instead). The `_refreshBoardImpl:2866` write-on-every-refresh stays — it becomes safe once validation no longer nulls the in-memory filter spuriously.

### Complex / Risky
- Phase 2: `upsertPlans` is called from restore, tombstone, run-sheet, feature-creation, and dispatch paths (callers at `TaskViewerProvider.ts:12169, 12732, 12780, 13920, 15455`, plus the snapshot sync at `:2629`). The fresh-INSERT-only guard must be per-record and must not add a config read on hot update paths (existence check first via `hasPlanByPlanFile` at `KanbanDatabase.ts:1541`, config read only when `record.project` is empty AND the row is new). The batch `BEGIN`…`COMMIT` transaction (`KanbanDatabase.ts:1385,1419`) must be preserved — the per-record SELECTs are safe on sql.js's single connection (no nested transactions) but add N extra round-trips to large restores, so the config read is gated on the existence check, not unconditional.
- Phase 3: auto-create inside insert paths must not fight the `UNIQUE(name, workspace_id)` constraint (`KanbanDatabase.ts:164`) under concurrency. Use `INSERT OR IGNORE` + re-select `getProjectIdByName` (`KanbanDatabase.ts:2668`) — **do NOT reuse `addProject`** (`:2684`), which uses a plain `INSERT` and swallows the duplicate-key error as a generic `return false`, making "already exists" indistinguishable from real failure.
- Phase 3 backfill: shipped-state migration affecting ~4,000 installs. Must be **V50** (the current highest applied migration is V49, `KanbanDatabase.ts:5858`; the migration function closes at `:5865`). Follow the `getMigrationVersion() < N` → `BEGIN`/`COMMIT`/`setMigrationVersion(N)` pattern used by V45-V49. Never edit a shipped `MIGRATION_Vnn_SQL` body.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - The primary race (run-sheet insert beats watcher) is resolved by moving the config read into the DB layer's fresh-INSERT path — both insert methods (`insertFileDerivedPlan`, `upsertPlans`) share the same DB handle, so there is no cross-instance drift. The watcher's existing-plan branch still applies `metadata.project` on every file change (`GlobalPlanWatcherService.ts:636-639`), so a later file touch self-heals a pin that the parser previously dropped (Phase 1 makes this heal reach the `- **Project:**` form).
  - Two concurrent `upsertPlans` batches stamping the same active project onto different fresh plans is safe — both read the same config value and resolve the same `project_id`; the `INSERT OR IGNORE` + re-select makes the project-row creation idempotent.
  - A project row created by Phase 3's auto-create while a `getProjects()` query is in flight on another path: `getProjects` returns a snapshot; the new row appears on the next refresh. No correctness gap — the board refreshes after every mutation.
- **Security:**
  - The `**Project:**` pin value flows from plan-file content into a SQL `SELECT id FROM projects WHERE name = ?` (parameterized) and, on miss, into `INSERT INTO projects (name, workspace_id) VALUES (?, ?)` (parameterized). No injection surface — both use bound parameters. A malicious plan file could pin an arbitrary project name, but that only creates a project row with that name under the plan's workspace; it cannot elevate or cross workspaces (`workspace_id` is caller-supplied, not file-supplied).
- **Side Effects:**
  - Phase 3 auto-create means importing a plan pinned to a typo'd project name will create that project row. This is intentional (matches the remote import semantics) and the user can delete the project via the board (`deleteProject` at `KanbanDatabase.ts:2698` also nulls affected plans). The Phase 5 rule ("state the pin in your reply") makes a wrong name visible immediately.
  - Phase 4 removing the UNASSIGNED reset means a restored filter naming a since-deleted project will now auto-recreate that project on refresh instead of dropping to Unassigned. This is the desired repair, but it means deleting a project then reloading the window could resurrect it if a stale `workspaceState` filter survives. Mitigation: `deleteProject` does not clear `kanban.activeProjectFilter` config — Phase 4 should also clear the config key (and in-memory `_projectFilter`) when `deleteProject` runs, so a reload cannot resurrect a deliberately-removed project. (Clarification, not new scope — it is the natural completion of the "stop the silent wipe / stop the silent resurrect" fix.)
  - NotionBackupService restore uses `upsertPlan` (`KanbanDatabase.ts:1432`). A restored plan that originally had `project=''` (because of the very bug being fixed) will now inherit the currently-active project on fresh restore-insert. For existing rows, `COALESCE(NULLIF(excluded.project,''), plans.project)` preserves the prior value. This is an acceptable heal, consistent with the stated precedence.
- **Dependencies & Conflicts:**
  - `agentPromptBuilder.ts` requires **no change**: it already emits `**Project:** ${project}` (`:664`) and instructs the agent to write the line (`:649,652`). Phase 5 broadens the *agent behavior* rule (pin even without a dispatch directive), which lives in `AGENTS.md`, not in the prompt builder.
  - The sibling plan `feature_plan_20260702130028_creator-manifest-project-pinning.md` covers creator-manifest project pinning. This plan's DB-layer stamping (Phase 2) is the runtime counterpart to that plan's manifest-time pinning; they are complementary, not conflicting. Coordinate so both write the same `**Project:** <name>` form the Phase 1 parser now accepts.
  - `KanbanProvider.ts:10111-10115` already does name→id resolution for the feature-creation path via `getProjectIdByName`. Phase 2's `_resolveProjectForInsert` helper should reuse that same method so resolution semantics stay identical across all paths.

## Dependencies

- None (no session-scoped prerequisites). Related (non-blocking, complementary): `feature_plan_20260702130028_creator-manifest-project-pinning.md` — creator-manifest project pinning; this plan's DB-layer fix is the runtime counterpart.

## Adversarial Synthesis

Key risks: (1) `upsertPlans` is on five hot paths and the per-record existence+config check adds latency to large restores if not strictly gated on the empty-project/new-row condition; (2) the Phase 3 backfill (V50) touches shipped DBs and a botched migration body is near-impossible to retract across ~4,000 installs; (3) Phase 4's auto-recreate can resurrect a deliberately-deleted project from stale `workspaceState` unless `deleteProject` is extended to clear the config/in-memory filter in the same change. Mitigations: gate the config read behind the existence check so hot update paths pay zero cost; follow the V45-V49 `getMigrationVersion() < N` + BEGIN/COMMIT pattern verbatim and test the backfill on a DB copy; pair the Phase 4 validation change with a `deleteProject` config-clear so resurrect-by-reload is impossible.

## Proposed Changes

> The implementation is organized into five phases. Phases 1-4 are code; Phase 5 is docs. All file paths and line numbers are verified against current `src/`.

### Phase 1 — Fix the pin parser (highest value, one line)

**Target:** `src/services/planMetadataUtils.ts:96`

**Context:** The project regex is anchored at line start, while the adjacent Tags regex (line 90) tolerates `- `, `> `, `* `, and `N. ` prefixes. Agents write `- **Project:** switchboard` under `## Metadata`.

**Logic / Implementation:** change the project regex to accept the same prefixes as Tags:

```
/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Project(?:\*\*:\s*|:\*\*)\s*(.+)$/im
```

Trim trailing whitespace; treat empty capture as `undefined` (existing behavior). No migration needed: the watcher's existing-plan branch already applies `metadata.project` on every file change (`GlobalPlanWatcherService.ts:636-639`), so already-imported plans self-heal on their next file touch. Add a note in the verification step to touch one affected file and confirm the DB row updates.

**Edge Cases:** The prefix character class `[\s\-\*\>]` and the optional `N. ` enumeration match the Tags regex exactly — no new forms introduced, so behavior stays symmetric. A `**Project:**` line with no capture group match (e.g. `**Project:**` alone) still yields `undefined` because `(.+)` requires at least one non-newline char.

### Phase 2 — Stamp at the DB layer (single choke point)

**Target:** `src/services/KanbanDatabase.ts` — `insertFileDerivedPlan` (`:1446`) and `upsertPlans` (`:1381`).

**Context:** These are the only two live `INSERT INTO plans` paths (verified: the only other `INSERT INTO plans` matches are migration-time copies into `plans_v20`/`plans_v11` temp tables at `:433` and `:6152`). Fixing both fixes every caller: the watcher (`insertFileDerivedPlan`), and `upsertPlans`/`upsertPlan` from restore, run-sheet, snapshot sync, feature-creation, and dispatch (`TaskViewerProvider.ts:12169,12732,12780,13920,15455,2629`).

**Logic / Implementation:**

- Extract one private helper `_resolveProjectForInsert(record, workspaceId): { project: string, projectId: number | null }` used by both methods so they cannot drift:
  1. If `record.project` is non-empty, keep it (explicit pin / caller intent — precedence rule #1). Never override.
  2. If `record.project` is empty **and** the row does not yet exist (fresh INSERT — `insertFileDerivedPlan` already computes `isExisting` at `:1449`; `upsertPlans` needs a per-record `hasPlanByPlanFile` check via `:1541`), read `kanban.activeProjectFilter` from `this` (same DB handle — `getConfig` at `:3376`) and use it as the project (precedence rule #2). Treat `''` and `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` (`'__unassigned__'`, `:725`) as "no active project".
  3. Resolve `project_id` from the (possibly newly stamped) name via `getProjectIdByName` (`:2668`) — used by both methods. On miss, apply Phase 3 auto-create.
- On conflict-update (existing row), behavior is unchanged: `COALESCE(NULLIF(excluded.project,''), plans.project)` (`UPSERT_PLAN_SQL:632`) and `COALESCE(excluded.project_id, plans.project_id)` (`:651`) preserve existing values.
- `upsertPlans` must also resolve `project_id` from the stamped name when `record.projectId` is null — reuse the same helper (this closes the gap acknowledged at `KanbanProvider.ts:10111`).
- Gate strictly: the `hasPlanByPlanFile` existence check runs per record; the `getConfig` read runs ONLY when `record.project` is empty AND the existence check says "new". Hot update paths (existing rows) pay one SELECT, zero config reads.

**Then simplify the watcher:** `GlobalPlanWatcherService.ts:535-536` no longer needs its own config read (`metadata.project` still flows in via the record; the DB layer supplies the fallback). Keep the log line, reworded to report what the DB layer resolved. The existing-plan branch (`:627-639`) is unchanged — it already honors `metadata.project` on every file change.

**Edge Cases:** Within a single `upsertPlans` batch, an earlier record could insert a `plan_file` that a later record in the same batch also references — the later record's `hasPlanByPlanFile` would then see the just-inserted row and skip the config read. This is correct (the row now exists, so it is not a fresh INSERT). The batch transaction (`BEGIN`/`COMMIT` at `:1385,1419`) is preserved; per-record SELECTs are safe on sql.js's single connection.

### Phase 3 — Auto-create missing project rows (apply-if-empty semantics, local)

**Target:** `src/services/KanbanDatabase.ts` — the `_resolveProjectForInsert` helper from Phase 2, plus a new V50 migration block.

**Context:** `projects` has `UNIQUE(name, workspace_id)` (`:164`). `addProject` (`:2684`) uses a plain `INSERT` and catches the duplicate error as a generic `return false` — unsuitable for "create-if-absent" because the caller cannot tell "already existed" from "real failure".

**Logic / Implementation:**

- Replace the silent-NULL lookup in both insert paths with: resolve name→id via `getProjectIdByName`; **on miss, `INSERT OR IGNORE INTO projects (name, workspace_id) VALUES (?, ?)`** then re-select `getProjectIdByName` to get the id (handles the race where a concurrent insert won the UNIQUE constraint). Use the new id. This matches the import-side semantics already scoped for git-carried plans in `remote-control-via-api-providers-1d073b2c` ("apply-if-empty, auto-create the project"), applied locally. Case-sensitivity: match the existing `UNIQUE(name, workspace_id)` collation; do not add case-folding in this plan.
- **One-time backfill migration (shipped-state rule — affects released installs):** for rows where `project != ''` and `project_id IS NULL`, resolve/auto-create and set `project_id`. This is **migration V50** — the current highest applied migration is V49 (`KanbanDatabase.ts:5858`); the migration function closes at `:5865`. Insert the V50 block immediately before that closing brace, following the exact `getMigrationVersion() < 50` → `BEGIN`/`COMMIT`/`setMigrationVersion(50)` pattern used by V45-V49. Guard the backfill `UPDATE` to skip rows whose `project` names a project that the user has since deleted (i.e. only set `project_id` when the auto-create succeeds — a deleted project's name should not be resurrected by the backfill). Runs once; idempotent via the version gate. Never edit a shipped `MIGRATION_Vnn_SQL` body.

**Edge Cases:** A plan with `project='Switchboard'` and `project_id=NULL` where the user deliberately deleted the "Switchboard" project: the backfill auto-create would resurrect it. Mitigation above (skip if the name corresponds to a deliberately-deleted project) — in practice there is no tombstone of deleted project names, so the pragmatic rule is: the backfill creates the row. If the user did not want the project, they delete it again post-migration (one-time cost). Document this in the migration log line.

### Phase 4 — Stop the silent config wipe

**Target:** `src/services/KanbanProvider.ts:2845-2850` (restore validation) and `deleteProject` (`KanbanDatabase.ts:2698`).

**Context:** `_refreshBoardImpl` writes the in-memory filter to the config key on every refresh (`:2866`), including `''` when the filter is null/UNASSIGNED. The restore validation (`:2848-2850`) resets a restored filter to UNASSIGNED when its name is missing from `getProjects()`.

**Logic / Implementation:**

- `KanbanProvider.ts:2848-2850`: when the restored filter names a project missing from `getProjects()`, **do not reset to UNASSIGNED**. With Phase 3, the name is legitimate — call the auto-create helper (Phase 3) and keep the filter. An empty `getProjects()` result (DB race — `dbReady` true but projects table not yet populated) must never reset a non-empty restored filter: if `projects.length === 0` and `_projectFilter` is non-empty/non-UNASSIGNED, skip validation this cycle (leave `_projectFilterNeedsValidation = true` to retry next refresh) rather than wiping.
- `_refreshBoardImpl:2866` keeps writing on every refresh (it is the sync mechanism), now safe because validation no longer nulls the in-memory filter spuriously. Writing `''` when the user genuinely selects Unassigned remains correct.
- **Pair this change with `deleteProject` (`KanbanDatabase.ts:2698`):** when a project is deleted, also clear `kanban.activeProjectFilter` (set to `''`) and reset the in-memory `_projectFilter` to UNASSIGNED. Without this, a stale `workspaceState` filter survives the delete and Phase 4's "keep the filter, recreate the row" logic resurrects the project on the next reload. This is the natural completion of the wipe fix, not new scope.

**Edge Cases:** Rapid delete-then-reload: `deleteProject` clears config + in-memory filter → reload restores empty filter → no resurrection. Rapid select-then-reload-while-DB-races: the empty-`getProjects` guard prevents a wipe during the race window; the next refresh validates against the now-populated table.

### Phase 5 — Intent-time pin rule for agents (AGENTS.md + mirrors)

**Target:** `AGENTS.md:138-140` (source of truth), `CLAUDE.md:167-169` (mirror), `.agents/workflows/switchboard-chat.md:14,17` (repeats the rule), `.claude/skills/switchboard-chat/SKILL.md:15,18` (mirror of the workflow). `src/services/agentPromptBuilder.ts` requires **no change**.

**Context:** The current rule is conditional ("when a dispatch prompt carries a PROJECT PIN directive…"). Agents that create plans without a dispatch prompt (chat-created plans) have no pin rule and rely on board state at file-write time — the exact race Phase 2 fixes at the DB layer. The agent-side rule should match the DB-layer precedence.

**Logic / Implementation:** Update the **Plan Project Pinning** section in `AGENTS.md` from the conditional rule to an unconditional rule:

> When creating any plan file:
> 1. If the user named a target project in their request, pin that: write `**Project:** <name>` in the metadata block. The user's words always beat board state.
> 2. Otherwise, resolve the active project **once, at the start of the task** (read `kanban.activeProjectFilter` from the workspace's `kanban.db` config table) and pin that snapshot in every plan file written for the task. Do not re-read it at file-write time — the user may browse other boards while you work.
> 3. State the pin in your reply ("Pinning to *<name>*") so a wrong snapshot is visible immediately.
> 4. If neither exists (no named project, empty config), omit the line — the plan lands unassigned and can be reassigned on the board.
> Write the pin as `**Project:** <name>` — plain or as a `- ` list item; both parse.

Mirror the same text into `CLAUDE.md`, `.agents/workflows/switchboard-chat.md`, and `.claude/skills/switchboard-chat/SKILL.md`. Grep confirmed these are the only four files carrying the pin rule (plus `agentPromptBuilder.ts`, which is the prompt emitter, not a rule mirror).

## Verification Plan

> Per session directives: **skip compilation** (`npm run compile`) and **skip automated tests** as verification steps. The plan still lists the manual checks and the tests that *should* be written, so a future coding pass can execute them.

### Automated Tests
- *(Skipped this session per SKIP TESTS directive. To be written by the coder:)*
  - `parsePlanMetadata` unit test with `- **Project:** X`, `**Project:** X`, `> **Project:** X`, `2. **Project:** X`, and no-pin content (Phase 1).
  - Race simulation: insert via `upsertPlans` with empty project while a project is active; confirm stamping + `project_id` resolution; then process the file via the watcher and confirm no clobber. Repeat with a `**Project:**` pin naming a different project — pin must win (Phase 2).
  - Auto-create + backfill against a copy of this repo's `kanban.db` (Phase 3).

### Manual Verification
1. **Parser (Phase 1):** touch one of the 2026-07-05 comms-monitor plan files (which carry `- **Project:** switchboard`) and confirm its DB row gains `project='switchboard'` via the watcher's existing-plan branch self-heal.
2. **Race (Phase 2):** with a project active, simulate the run-sheet path winning (fresh insert via `upsertPlan` with no project on the record); confirm the row is stamped with the active project and a resolved `project_id`; then let the watcher process the file and confirm nothing is clobbered. Repeat with a `**Project:**` pin naming a different project — the pin must win.
3. **Auto-create (Phase 3):** import a plan pinned to a project name with no `projects` row; confirm the row is created and the plan appears on that project's board (filter JOIN at `getBoardFilteredByProject`). Run the V50 backfill against a copy of this repo's DB and confirm the 40 `Switchboard`/`switchboard` rows gain a `project_id` and appear under the project filter.
4. **No wipe / no resurrect (Phase 4):** select a project, reload the window, confirm the config key still holds the name (previously reset to `''` when the row was missing). Then delete the project, reload, confirm it is NOT resurrected (`deleteProject` cleared the config + in-memory filter).
5. **End-to-end:** select a project on the board, ask an agent to create a plan (session-tracked path), confirm the card appears under the project without manual assignment. Then create a plan via chat with no project selected and no named project; confirm it lands unassigned.

## Recommendation

Complexity 6 → **Send to Coder**.
