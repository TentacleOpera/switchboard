# Migrate Persisted Planner Workflow Path: .agent → .agents

## Metadata
- **Complexity:** 3
- **Tags:** bugfix, migration, backend
- **Project:** switchboard

## Goal

Fix the planner prompt so it emits `Read .agents/workflows/improve-plan.md and follow it step-by-step.` instead of the deprecated `Read .agent/workflows/improve-plan.md ...`.

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

## Changes

### 1. One-time migration — `src/services/TaskViewerProvider.ts`

Add a new idempotent migration method, modeled on the existing `switchboard.settingsUnified.v1` pattern (TaskViewerProvider.ts:622-625). Guard with a new globalState flag `switchboard.plannerWorkflowPathAgentToAgents.v1`.

In the constructor, after the existing `settingsUnified.v1` migration block (~line 625), add:
```
const wfMigrated = this._context.globalState.get<boolean>('switchboard.plannerWorkflowPathAgentToAgents.v1', false);
if (!wfMigrated) {
    void this._migratePlannerWorkflowPathAgentToAgents();
}
```

`_migratePlannerWorkflowPathAgentToAgents()` must, for the **planner role only**:

1. **GlobalState tier** — read `switchboard.prompts.roleConfig_planner` via `getRoleConfig('roleConfig_planner')`. If present and `value.workflowFilePath` starts with `.agent/`, rewrite to `.agents/` (replace only the leading `.agent/` segment; preserve the rest of the path and all other keys/addons), write back via `saveRoleConfig('roleConfig_planner', value)`.
2. **Workspace DB tier** — for each known workspace root (iterate the same workspace set the rest of the provider uses to resolve DBs), open `KanbanDatabase.forWorkspace(root)`, read `config` row `switchboard.prompts.roleConfig_planner` via `getConfigJsonSync`. If present and the `workflowFilePath` starts with `.agent/`, rewrite and write back via `setConfigJson`.
3. **Project DB tier** — for the same DBs, scan `project_config` for any row where `key = 'switchboard.prompts.roleConfig_planner'` and the JSON `workflowFilePath` starts with `.agent/`; rewrite each via `setProjectConfigJson(project, key, value)`.
4. **VS Code setting** — read `switchboard.planner.workflowPath` via `vscode.workspace.getConfiguration('switchboard')`. If it starts with `.agent/`, update to `.agents/` via `config.update('planner.workflowPath', newValue, ConfigurationTarget.Global)`. Only touch it if explicitly set (check `config.inspect('planner.workflowPath')`).
5. Set the globalState flag `switchboard.plannerWorkflowPathAgentToAgents.v1 = true` once all tiers processed without throwing. Wrap each tier in its own try/catch so a failure in one tier doesn't block the others; set the flag only after attempting all tiers.

**Normalization rule (single source):** a small helper `normalizeAgentToAgents(p: string): string` that returns `p.replace(/^\.agent\//, '.agents/')`. Used by the migration only. Custom paths (`.custom/...`, absolute paths, anything not starting with `.agent/`) are returned unchanged.

### 2. Tests — `src/test/planner-workflow-path-migration.test.js` (new)

Following the style of existing `src/test/*.test.js` files:

1. **GlobalState tier:** seed `switchboard.prompts.roleConfig_planner` with `workflowFilePath: '.agent/workflows/improve-plan.md'` + dummy addons. Run the migration. Assert the stored value now has `.agents/...` and the flag is set. Re-run; assert idempotent (no second write, flag still set).
2. **Workspace DB tier:** seed a temp kanban.db `config` row with the stale value. Run migration. Assert rewritten.
3. **Project DB tier:** seed a `project_config` row. Run migration. Assert rewritten.
4. **Custom path untouched:** seed `workflowFilePath: '.custom/workflows/x.md'`. Run migration. Assert unchanged.
5. **Already-migrated no-op:** seed `.agents/workflows/improve-plan.md`. Run migration. Assert unchanged and flag set.

Use the existing in-memory / temp-DB harness pattern from `src/test/kanban-default-prompt-previews.test.js` or `src/test/minimal-prompt.test.js` for DB setup.

## Verification

1. `node src/test/planner-workflow-path-migration.test.js` (or the project's test runner) — all 5 cases pass.
2. Before deploying: `sqlite3 .switchboard/kanban.db "SELECT value FROM config WHERE key='switchboard.prompts.roleConfig_planner';"` shows `.agent/...`.
3. After deploying (extension reload): re-run the same sqlite query → value is `.agents/workflows/improve-plan.md`.
4. Open the Prompts tab, select planner role, copy the prompt → it begins `Read .agents/workflows/improve-plan.md and follow it step-by-step.`
5. `npm run compile` succeeds (webpack build clean).

## Risks & Edge Cases

- **Shared / synced DBs touched by an old extension version** could re-write `.agent/...` after this migration runs. Accepted per user decision (migration-only, no read guard). The migration flag is per-globalState, so a fresh install on a different machine would re-run and re-fix.
- **Migration flag vs. per-workspace DB:** the flag is globalState (per VS Code profile), but the DB is per-workspace. If a user has multiple workspaces, the first run migrates all DBs the provider can see at that moment; a workspace opened later whose DB wasn't visible during the first run would keep its stale value. Mitigation: the migration iterates all currently-known workspace roots; a workspace first opened after the flag is set would not be re-migrated. Accepted risk — the user can re-trigger by clearing the flag, and the source default already uses `.agents` so a workspace with no stored override is correct out of the box.
- **No data loss:** only the leading `.agent/` → `.agents/` substring is changed; all addons and other keys preserved. Custom paths untouched.
