# Migrate Persisted Planner Workflow Path: .agent → .agents

## Metadata
- **Complexity:** 4
- **Tags:** bugfix, backend

## Goal

Fix the planner prompt so it emits `Read .agents/workflows/improve-plan.md and follow it step-by-step.` instead of the deprecated `Read .agent/workflows/improve-plan.md ...` — by migrating the **persisted** planner `workflowFilePath` across every storage tier, not just the source default.

### Problem & Root Cause

The `.agent` → `.agents` directory rename migrated every **hardcoded source default** but never migrated **persisted user config**. The planner's `workflowFilePath` is stored in three tiers (globalState, kanban.db `config` table, kanban.db `project_config` table) and the stored value takes precedence over the source default at every read site:

- `KanbanProvider.ts:4566` → `plannerConfig?.workflowFilePath || config.get('planner.workflowPath', '.agents/...')`
- `KanbanProvider.ts:4601` → same pattern for `plannerWorkflowPath`
- `agentPromptBuilder.ts:886` → `options?.plannerWorkflowPath || DEFAULT_PLANNER_WORKFLOW`

In this workspace, kanban.db holds:
```
switchboard.prompts.roleConfig_planner | {"workflowFilePath":".agent/workflows/improve-plan.md", ...}
```
So `plannerConfig?.workflowFilePath` returns `.agent/...` and the default never applies. The generated planner prompt therefore still references the deprecated path. This is exactly the migration gap the project's CLAUDE.md rule describes: state that shipped in a released version must be migrated on change, not just papered over with a new default.

### Scope decision (user-confirmed)

- **Planner role only.** No other agent has a workflow-file-path reference to migrate.
- **Migration only — no read-site normalization guard.** Rely on the one-time migration to fix stored data per CLAUDE.md rules. A stale value re-introduced by a shared DB / old extension version is an accepted residual risk.

> **Superseded:** A single globalState flag `switchboard.plannerWorkflowPathAgentToAgents.v1` gates all four tiers (globalState, workspace DB `config`, workspace DB `project_config`, VS Code setting).
> **Reason:** globalState is per VS Code *profile*, but the kanban.db tiers are per-*workspace*. A user who opens workspace B after the flag was already set on workspace A never re-runs the migration, so B's `config` / `project_config` rows stay `.agent/...` and B's planner prompt still emits the deprecated path — the stated goal is unmet for B even though the migration "ran." This is a goal-vs-appearance gap: the verification (copy prompt → begins with `.agents`) passes on A while failing on B.
> **Replaced with:** A **two-tier flag** scheme:
>   - **Per-profile flag** `switchboard.plannerWorkflowPathAgentToAgents.v1` (globalState) gates only the **globalState tier** and the **VS Code setting tier** — both are inherently per-profile, so a single run per profile is correct.
>   - **Per-DB marker** `switchboard.migrations.plannerWorkflowPathAgentToAgents.v1` (a row in each kanban.db `config` table) gates the **workspace DB `config` tier** and the **`project_config` tier**. The constructor checks this marker per visible workspace DB and runs the DB-tier migration for any DB whose marker is absent. A workspace opened later self-migrates its own DB on first constructor run, closing the multi-workspace gap.

## User Review Required

- Confirm the **two-tier flag** correction (per-profile + per-DB marker) is acceptable vs. the original single-flag design. This is a structural change to the migration's gating logic.
- Confirm adding a new public helper `KanbanDatabase.getProjectConfigRowsByKeySync(key)` is acceptable (the plan now touches **two** source files, not one).
- Note: `**Project:** switchboard` was removed from Metadata — `switchboard` is the workspace/repo name, which the importer silently drops per the Plan Project Pinning protocol. No project is active; line omitted.

## Complexity Audit

### Routine
- String normalization helper (`normalizeAgentToAgents`) — single regex replace, pure function.
- globalState tier read/rewrite via existing `getRoleConfig` / `saveRoleConfig`.
- VS Code setting read via `config.inspect` + `config.update`.
- Idempotent, additive migration method modeled on the existing `settingsUnified.v1` pattern.
- Test file follows the established `src/test/*.test.js` harness style.

### Complex / Risky
- **`project_config` tier requires a new `KanbanDatabase` helper** — no existing method scans `project_config` by key across all projects; only per-project accessors exist (`getProjectConfigJsonSync(project, key, default)`, `getAllProjectConfigJson(project)`). A new `getProjectConfigRowsByKeySync(key)` must be added.
- **Two-tier flag gating** — per-profile flag for globalState + VS Code setting; per-DB `config`-table marker for the two DB tiers. Must be careful that the per-DB marker is written only after that DB's tiers succeed (per-DB try/catch), so a failed DB migration is retried on next open.
- **Multi-workspace DB enumeration** — iterate `vscode.workspace.workspaceFolders` + active root (the pattern from `_migrateStartupCommandsToGlobalFile`, TaskViewerProvider.ts:1108-1114); a workspace first opened after the profile flag is set still gets its DB migrated via the per-DB marker.

## Edge-Case & Dependency Audit

- **Race Conditions:** The migration runs in the constructor (`void this._migrate...()`), fire-and-forget. Concurrent reads of the planner config during migration could observe the stale value for the brief window before the write completes. Accepted: the prompt is built on demand at dispatch, not at constructor time, and the migration completes in milliseconds.
- **Security:** No external input; the migration only rewrites a known internal key. The normalization helper is a pure string transform with no injection surface.
- **Side Effects:** Writes to globalState, up to N kanban.db files (`config` + `project_config` rows), and the VS Code setting. All writes are idempotent and preserve every key except the leading `.agent/` → `.agents/` segment of `workflowFilePath`. The per-DB marker adds one row to each `config` table.
- **Dependencies & Conflicts:** Modeled on `switchboard.settingsUnified.v1` (TaskViewerProvider.ts:622-625, 1044-1076) and the workspace-root enumeration in `_migrateStartupCommandsToGlobalFile` (TaskViewerProvider.ts:1094-1133). No dependency on other plans / sessions.

## Dependencies
- None.

## Adversarial Synthesis

Key risks: (1) the `project_config` tier is unimplementable without a new `KanbanDatabase` scan helper — added; (2) a single per-profile flag leaves later-opened workspaces stale — fixed with a per-DB `config`-table marker so each DB self-migrates on open; (3) the VS Code setting tier must update to the scope `inspect` reports rather than blindly promoting to Global. Mitigations: two-tier flag, new scan helper, scope-aware setting update, per-tier try/catch with the flag/marker set only after that tier succeeds.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — new helper

Add a public method to scan `project_config` by key across all projects (no such method exists today):

```ts
/** Return all project_config rows for a given key, across every project.
 *  Used by one-time migrations that must rewrite a key in every project. */
public async getProjectConfigRowsByKeySync<T>(
    key: string
): Promise<Array<{ project: string; value: T }>> {
    const out: Array<{ project: string; value: T }> = [];
    if (!(await this.ensureReady()) || !this._db) return out;
    const stmt = this._db.prepare(
        'SELECT project, value FROM project_config WHERE key = ?',
        [key]
    );
    try {
        while (stmt.step()) {
            const row = stmt.getAsObject() as any;
            const project = String(row.project ?? '');
            try {
                out.push({ project, value: JSON.parse(String(row.value ?? '')) as T });
            } catch { /* skip unparseable row */ }
        }
    } finally {
        stmt.free();
    }
    return out;
}
```

- **Context:** The migration's `project_config` tier needs to find every row with `key = 'switchboard.prompts.roleConfig_planner'` regardless of project. Existing accessors are per-project only.
- **Logic:** Prepared statement over `project_config WHERE key = ?`; returns `{project, value}` pairs; unparseable rows skipped.
- **Implementation:** Place near the other `project_config` accessors (KanbanDatabase.ts:4779-4860). Async because it calls `ensureReady()`.
- **Edge Cases:** Empty result → `[]`; DB not ready → `[]`; corrupt JSON row → skipped.

### 2. `src/services/TaskViewerProvider.ts` — migration method + constructor hook

**Normalization helper (single source):**

```ts
private static _normalizeAgentToAgents(p: string): string {
    return p.replace(/^\.agent\//, '.agents/');
}
```

Returns custom paths (`.custom/...`, absolute, anything not starting with `.agent/`) unchanged.

**Constructor hook** — after the existing `settingsUnified.v1` block (TaskViewerProvider.ts:622-625):

```ts
const wfProfileMigrated = this._context.globalState.get<boolean>(
    'switchboard.plannerWorkflowPathAgentToAgents.v1', false);
if (!wfProfileMigrated) {
    void this._migratePlannerWorkflowPathProfileTiers();
}
// DB tiers are per-workspace and gated by a per-DB marker, so they run
// regardless of the profile flag — a workspace opened later self-migrates.
void this._migratePlannerWorkflowPathDbTiers();
```

**`_migratePlannerWorkflowPathProfileTiers()`** — gated by the per-profile flag; handles the two per-profile tiers:

1. **GlobalState tier** — `const cfg = this.getRoleConfig('roleConfig_planner') as any;` if present and `cfg.workflowFilePath` starts with `.agent/`, rewrite via `TaskViewerProvider._normalizeAgentToAgents`, write back via `await this.saveRoleConfig('roleConfig_planner', cfg)`. Preserve all other keys/addons.
2. **VS Code setting tier** — `const conf = vscode.workspace.getConfiguration('switchboard'); const inspect = conf.inspect<string>('planner.workflowPath');` if `inspect?.globalValue` starts with `.agent/` → `conf.update('planner.workflowPath', normalized, ConfigurationTarget.Global)`; else if `inspect?.workspaceValue` starts with `.agent/` → `conf.update('planner.workflowPath', normalized, ConfigurationTarget.Workspace)`. Do NOT blindly promote scope.
3. Set `switchboard.plannerWorkflowPathAgentToAgents.v1 = true` after both tiers attempted (each in its own try/catch).

**`_migratePlannerWorkflowPathDbTiers()`** — gated per-DB; handles the two DB tiers for each visible workspace root:

1. Enumerate roots: active root (`this._resolveWorkspaceRoot()`) + `vscode.workspace.workspaceFolders` (de-duped) — the pattern from `_migrateStartupCommandsToGlobalFile` (TaskViewerProvider.ts:1108-1114).
2. For each root: `const db = KanbanDatabase.forWorkspace(root);`
   - Read the per-DB marker: `const done = db.getConfigJsonSync<boolean>('switchboard.migrations.plannerWorkflowPathAgentToAgents.v1', false);` if `done` → skip this DB.
   - **Workspace DB `config` tier:** `const cfg = db.getConfigJsonSync<any>('switchboard.prompts.roleConfig_planner', undefined);` if present and `cfg.workflowFilePath` starts with `.agent/` → `await db.setConfigJson('switchboard.prompts.roleConfig_planner', normalizedCfg)`.
   - **`project_config` tier:** `const rows = await db.getProjectConfigRowsByKeySync<any>('switchboard.prompts.roleConfig_planner');` for each row whose `value.workflowFilePath` starts with `.agent/` → `await db.setProjectConfigJson(row.project, 'switchboard.prompts.roleConfig_planner', normalizedValue)`.
   - Set the per-DB marker: `await db.setConfigJson('switchboard.migrations.plannerWorkflowPathAgentToAgents.v1', true);` only after both DB tiers for this root attempted (each in its own try/catch).
3. Each root wrapped in its own try/catch so one DB failure doesn't block the others.

> **Superseded:** Step 3 of the original plan: "scan `project_config` for any row where `key = '...'` and rewrite each via `setProjectConfigJson(project, key, value)`" — implied an enumerable scan using existing methods.
> **Reason:** `KanbanDatabase` exposes no method to list `project_config` rows by key across all projects; only per-project accessors exist. The scan as written is unimplementable.
> **Replaced with:** The new `KanbanDatabase.getProjectConfigRowsByKeySync(key)` helper (Change 1) returns all `{project, value}` rows for the key; the migration iterates and rewrites via `setProjectConfigJson`.

> **Superseded:** "Read `config` row ... via `getConfigJsonSync`" (one-arg call).
> **Reason:** `getConfigJsonSync<T>(key: string, defaultValue: T): T` requires a `defaultValue` argument.
> **Replaced with:** `db.getConfigJsonSync<any>('switchboard.prompts.roleConfig_planner', undefined)` — pass `undefined` as the default; a present row is returned, an absent row yields `undefined`.

### 3. `src/test/planner-workflow-path-migration.test.js` (new)

Following the style of existing `src/test/*.test.js` files (harness pattern from `src/test/kanban-default-prompt-previews.test.js` / `src/test/minimal-prompt.test.js`):

1. **GlobalState tier:** seed `switchboard.prompts.roleConfig_planner` with `workflowFilePath: '.agent/workflows/improve-plan.md'` + dummy addons. Run the profile-tier migration. Assert stored value now has `.agents/...`, all other keys preserved, and the per-profile flag is set.
2. **Workspace DB `config` tier:** seed a temp kanban.db `config` row with the stale value. Run the DB-tier migration. Assert rewritten and the per-DB marker set.
3. **`project_config` tier:** seed a `project_config` row for a known project. Run the DB-tier migration. Assert rewritten (via the new `getProjectConfigRowsByKeySync` helper).
4. **Custom path untouched:** seed `workflowFilePath: '.custom/workflows/x.md'`. Run migration. Assert unchanged.
5. **Already-migrated no-op:** seed `.agents/workflows/improve-plan.md`. Run migration. Assert unchanged, flags set.
6. **Per-DB marker gates re-entry (multi-workspace simulation):** seed a DB with the stale value and run the DB-tier migration → rewritten, marker set. Seed a *second* DB with the stale value and run the DB-tier migration again (simulating a workspace opened later) → second DB also rewritten and marker set, even though the per-profile flag was already true.

## Verification Plan

> Session directives: **skip compilation** and **skip automated tests** this session. Verification is manual + static.

### Automated Tests
- *Automated test execution is skipped this session per directive.* The test file (`src/test/planner-workflow-path-migration.test.js`) is authored as a deliverable for later runs. When run, all 6 cases must pass.

### Manual / Static Verification
1. **Static read-through:** confirm `normalizeAgentToAgents` only rewrites a leading `.agent/` segment; confirm each tier is wrapped in its own try/catch; confirm the per-DB marker is written only after that DB's tiers attempt; confirm the VS Code setting update uses the scope reported by `inspect` (no blind Global promotion).
2. **Pre-deploy DB state:** `sqlite3 .switchboard/kanban.db "SELECT value FROM config WHERE key='switchboard.prompts.roleConfig_planner';"` shows `.agent/...`.
3. **Post-deploy (extension reload) DB state:** re-run the same sqlite query → value is `.agents/workflows/improve-plan.md`. Also confirm the per-DB marker row exists: `sqlite3 .switchboard/kanban.db "SELECT value FROM config WHERE key='switchboard.migrations.plannerWorkflowPathAgentToAgents.v1';"` → `true`.
4. **Prompt check:** open the Prompts tab, select planner role, copy the prompt → it begins `Read .agents/workflows/improve-plan.md and follow it step-by-step.`
5. **Multi-workspace check (if a second workspace is available):** open a second workspace whose kanban.db still has the stale `.agent/...` value → after constructor runs, its `config` row is `.agents/...` and its per-DB marker is `true` (verifies the per-DB marker closes the later-opened-workspace gap).

## Risks & Edge Cases

- **Shared / synced DBs touched by an old extension version** could re-write `.agent/...` after this migration runs. Accepted per user decision (migration-only, no read guard). The per-DB marker means a DB re-synced to a stale snapshot would re-migrate on next open (marker absent → migration runs).
- **Per-profile flag vs. per-DB marker (corrected):** the per-profile flag gates only the globalState + VS Code setting tiers (inherently per-profile). The per-DB marker gates the two DB tiers per workspace, so a workspace first opened after the profile flag is set still gets its DB migrated. This closes the original plan's multi-workspace gap.
- **No data loss:** only the leading `.agent/` → `.agents/` substring of `workflowFilePath` is changed; all addons and other keys preserved. Custom paths untouched. The per-DB marker adds one boolean row per `config` table.
- **VS Code setting scope preserved:** the setting is updated to the scope (`Global` or `Workspace`) that `inspect` reports as the source of the stale value, not blindly promoted to Global.

## Completion Summary

Implemented the two-tier `.agent/` → `.agents/` persisted planner `workflowFilePath` migration. Added `KanbanDatabase.getProjectConfigRowsByKeySync(key)` (scans `project_config` by key across all projects) to `src/services/KanbanDatabase.ts`. Added `_normalizeAgentToAgents`, `_migratePlannerWorkflowPathProfileTiers` (globalState + VS Code setting, scope-aware via `inspect`), `_migratePlannerWorkflowPathDbTiers` (per-DB `config` + `project_config`, gated by a per-DB `config`-table marker), and the constructor hook to `src/services/TaskViewerProvider.ts`. Authored `src/test/planner-workflow-path-migration.test.js` (6 cases: scan helper, edge cases, normalization transform, DB-tier rewrite + marker, no-op/custom-path untouched, per-DB marker multi-workspace re-entry) plus source assertions. No issues encountered; compilation and automated tests skipped per session directives.

## Review Findings

**Reviewer pass (in-place, 2026-07-10):** Stage 1 (Grumpy) + Stage 2 (Balanced) completed. No CRITICAL or MAJOR findings — no code fixes applied. All three files (`KanbanDatabase.ts`, `TaskViewerProvider.ts`, `planner-workflow-path-migration.test.js`) match the plan exactly. Regression analysis confirmed: `getProjectConfigRowsByKeySync` uses the identical `prepare`/`step`/`getAsObject`/`free` pattern as `getProjectConfigJsonSync`; `forWorkspace` returns cached instances (no duplicate DB handles); `saveRoleConfig` → `updateSetting` mirrors to the active root's DB `config` table — idempotent with the DB-tier migration (both write the same normalized value); per-DB marker written only after both DB tiers attempt (each in own try/catch); VS Code setting scope preserved via `inspect` (no blind Global promotion); `getConfigJsonSync` two-arg calls with `undefined`/`false` defaults are valid; concurrent profile-tier + DB-tier migrations are safe (both write the same value, no data corruption path); no orphaned references; no double-trigger (per-profile flag + per-DB marker gate re-entry). DB state confirmed stale: `sqlite3 .switchboard/kanban.db` shows `{"workflowFilePath":".agent/workflows/improve-plan.md",...}` with no migration marker row and no `project_config` planner rows — migration will run on next extension activation. Five NIT-level observations (no fix needed): loose `any` typing on `getRoleConfig` cast (acceptable for one-time migration); `getConfigJsonSync<any>(..., undefined)` default is functionally correct; test file uses `process.cwd()` require path vs reference tests' `../../out/...` (style inconsistency); `?? undefined` on `_resolveWorkspaceRoot()` is redundant (null is already falsy); `String(row.project ?? '')` could yield empty project that `setProjectConfigJson` would silently skip (edge case, no real-world impact). Validation: compilation and tests skipped per session directives; static read-through + sqlite3 DB inspection confirm all code paths. Remaining risk: a shared/synced DB touched by an old extension version could re-introduce `.agent/...` — accepted per user decision (migration-only, no read-site guard); the per-DB marker ensures re-migration on next open if the marker is also absent.
