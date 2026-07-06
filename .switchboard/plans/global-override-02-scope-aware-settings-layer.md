# Global Override 02: Scope-Aware Settings Read/Write Layer

## Goal

Introduce `_getScopedSetting` / `_updateScopedSetting` on `KanbanProvider` that resolve reads and writes through the project → workspace → global tier order, driven by the two override switches, and route every in-scope settings call site through them. This is the backbone that makes tab settings scope-aware.

### Problem

All settings reads and writes in `KanbanProvider` go through flat methods (`_getSetting` / `_updateSetting`) that have no concept of scope. They check `globalState` first, then the workspace `config` table. There is no way to read or write a project-scoped setting, and no way to make workspace config take precedence over globalState.

### Background

`KanbanProvider._getSetting<T>(key, defaultValue)` (verified at line 471) checks `globalState` → workspace kanban.db `config` table → default. `_updateSetting<T>(key, value)` (line 500) writes to `globalState` + mirrors to the kanban.db `config` table. `_reloadSettingsFromStore()` (line 516) also uses `_getSetting`.

**Verified against code (2026-07-07) — corrections to the original draft:**
- "Workspace config" is the **kanban.db `config` table**, reached via `KanbanDatabase.forWorkspace(root)` where `root = this._taskViewerProvider._resolveWorkspaceRoot()` — NOT VS Code workspace configuration. The DB fallback in `_getSetting` is gated on `this._taskViewerProvider` being set (`:474`).
- The original handler table overstated what flows through `_getSetting`/`_updateSetting`. The complete, verified call-site inventory is in Proposed Changes §4 — only **6 `kanban.*` keys + the generic `switchboard.prompts.*` path** go through the flat methods. Several handlers named in the original draft delegate to entirely different storage (VS Code configuration, `workspaceState`, TaskViewerProvider state.json mirror, AutoArchiveService) and are classified explicitly below.
- `_configEpoch` exists (`:194`) but is only ever incremented via `_markConfigDirty()` (`:5653`) — use that, never a manual bump. It feeds `_buildPushKey` (`:5625`) so config-only changes aren't dropped by the refresh no-op early-out.
- `setProjectFilter` **method** is at `:5739` (persists `kanban.activeProjectFilter` to db config at `:5753-5754`, debounced `workspaceState` write at `:5762-5764`); the **message handler** `case 'setProjectFilter'` is at `:6440` and calls `_refreshBoard` after. Neither currently reloads settings — this plan adds that.
- Constructor calls `_reloadSettingsFromStore()` at `:219`, **before** `setTaskViewerProvider` (`:217-218` setter, wired in `extension.ts:790-792`) — so during construction the DB tiers are unreachable and reads degrade to globalState-only. Scoped tiers only become available after wiring; see §6.

### Root Cause

The read/write methods are scope-unaware. They need to be replaced with scope-aware variants that resolve based on the override switch states and active project filter.

### Desired Outcome

New `_getScopedSetting` / `_updateScopedSetting` methods that resolve reads and writes based on the override tier. All in-scope handlers routed through them. Settings whose storage is already per-workspace by construction (workspaceState, db config, VS Code workspace settings) are classified and documented rather than force-fitted.

**Depends on:** Plan 01 (project_config storage layer must exist).

## Metadata

**Complexity:** 7
**Tags:** backend, refactor, feature
**Project:** switchboard

## User Review Required

None. Scope classification (§4) is decided in this plan: the scoped layer covers settings flowing through `_getSetting`/`_updateSetting`; subsystems with natively per-workspace storage keep their storage and are documented as such; the globalState-by-design column-structure system (`switchboard.kanban.customColumns`, `switchboard.agents.visibleAgents`) is a follow-up feature, not this one.

## Complexity Audit

### Routine
- The two new methods are small and their fallback branch is a verbatim copy of today's behavior — both-OFF mode must be bit-identical to current resolution.
- Call-site swaps for the 6 `kanban.*` keys and the generic prompts path are mechanical (verified inventory below).
- Epoch invalidation reuses the existing `_markConfigDirty()`.

### Complex / Risky
- Resolution-order correctness: workspace-ON inverts today's globalState-first order for the workspace tier. A mistake here silently changes every user's effective settings.
- The db `config` table carries **two meanings** in one namespace: "mirror of globalState" (both-OFF mode writes it) and "workspace-scoped values" (workspace-ON mode writes it). While OFF, continued edits clobber previously scoped workspace values via the mirror. This is accepted design (the workspace tier IS the config table), but tests and docs must state it.
- Constructor-time reads happen before `_taskViewerProvider` is wired — override flags and scoped values are unreadable until after wiring. Requires the §6 reload hook or the board opens with global values for one refresh cycle.
- Project filter switches mid-session must swap the effective settings atomically with the board refresh, or the board renders with stale settings.

## Edge-Case & Dependency Audit

- **Race Conditions:** `_updateScopedSetting` is async (db write + persist); rapid toggle sequences in the webview can interleave. Same exposure as today's `_updateSetting` mirror — last write wins, acceptable. Project-filter change during an in-flight scoped write targets the OLD project (the write captured `_projectFilter` at call time) — correct behavior, no fix needed.
- **Security:** No new input surfaces; project names already flow into db queries via plan 01's parameter binding.
- **Side Effects:** Workspace-ON writes stop updating globalState — other workspaces keep their own view (that is the point). Toggling OFF reverts effective values to globalState instantly (feature semantics: both OFF = today's behavior). Snapshot-on-toggle (plan 04) covers the ON-transition continuity.
- **Dependencies & Conflicts:** Depends on plan 01 methods. Plan 03 consumes the override fields + handlers. Plan 05 mirrors this pattern for role configs. No conflict with the tickets tab or other providers — this layer is KanbanProvider-internal.

## Dependencies

- Plan 01 (`project_config` CRUD) must land first. No cross-feature dependencies.

## Adversarial Synthesis

Key risks: regression in both-OFF mode (mitigated: fallback branch is a verbatim copy of current `_getSetting`/`_updateSetting` bodies); mixed mirror/scoped meaning of the config table (accepted design, documented + tested); constructor-order gap where flags load before the DB tier is reachable (mitigated: reload hook in `setTaskViewerProvider`). Mitigations: verified call-site inventory (no missed swaps), `_markConfigDirty()` on every scope-state change, settings reload wired into `setProjectFilter`.

## Proposed Changes

### src/services/KanbanProvider.ts

**Context:** `_getSetting` `:471`, `_updateSetting` `:500`, `_reloadSettingsFromStore` `:516`, constructor loads `:377-393`, `setTaskViewerProvider` `:217-218`, `_markConfigDirty` `:5653`, `setProjectFilter` method `:5739` / handler case `:6440`, generic `saveSetting`/`getSetting` handlers `:8355`/`:8373`.

#### 1. Override state fields

Add fields:
- `_workspaceOverrideEnabled: boolean` (default `false`)
- `_projectOverrideEnabled: boolean` (default `false`)

These two keys live **only** in the kanban.db `config` table (they are the control, not the data — never scope-resolved, never in globalState):

```typescript
private _loadOverrideFlags(): void {
    const root = this._taskViewerProvider?._resolveWorkspaceRoot();
    if (!root) { return; } // pre-wiring: keep defaults (false)
    try {
        const db = KanbanDatabase.forWorkspace(root);
        if (db.isOpen()) {
            this._workspaceOverrideEnabled = db.getConfigJsonSync<boolean>('kanban.workspaceOverrideEnabled', false);
            this._projectOverrideEnabled = db.getConfigJsonSync<boolean>('kanban.projectOverrideEnabled', false);
        }
    } catch { /* keep defaults */ }
}
```

Call from `_reloadSettingsFromStore` (start of method) so flags refresh with every settings reload.

#### 2. Scope-aware read — `_getScopedSetting<T>(key, defaultValue)`

Resolution order (original design, terminology corrected — "workspace config" = kanban.db `config` table):

```
1. If _projectOverrideEnabled AND _projectFilter is a specific project (truthy, not __unassigned__):
     → db.getProjectConfigJsonSync(project, key) — if found, return it
2. If _workspaceOverrideEnabled:
     → db.getConfigJsonSync(key) — if found, return it
3. Check globalState (existing _getSetting globalState check)
4. If neither override is ON:
     → db.getConfigJsonSync(key) (legacy fallback, current behavior)
5. Return defaultValue
```

Key insight: when both overrides are OFF, the order is `globalState → db config` (today's behavior, bit-identical). When workspace override is ON, db config takes precedence over globalState. When project override is ON with a specific project selected, project_config takes precedence over everything. Project override ON but filter on all/unassigned → project tier is skipped (dormant), resolution continues at step 2.

"Found" for the db tiers means: use a sentinel-default probe (e.g. call with `undefined` default and check `!== undefined`), matching how `_getSetting` distinguishes presence at `:480`. All db access wrapped in the same `isOpen()` / try-catch guards as `_getSetting` `:474-482`.

#### 3. Scope-aware write — `_updateScopedSetting<T>(key, value)`

```
- If _projectOverrideEnabled AND _projectFilter is a specific project:
    → db.setProjectConfigJson(project, key, value) ONLY
    → do NOT write globalState or db config
- Else if _workspaceOverrideEnabled:
    → db.setConfigJson(key, value) ONLY
    → do NOT write globalState
- Else (both OFF):
    → globalState.update + mirror to db config (verbatim current _updateSetting body)
```

#### 4. Call-site inventory & routing (verified 2026-07-07)

**Category A — flows through `_getSetting`/`_updateSetting` today → swap to scoped methods.** Complete inventory (every call site, from a full grep):

| Call site | Verified line(s) | Key(s) |
|---|---|---|
| Constructor loads | 377-384, 391-393 | `kanban.cliTriggersEnabled`, `kanban.dynamicComplexityRoutingEnabled`, `kanban.columnDragDropModes`, `kanban.routingMapConfig`, `kanban.allowUnknownComplexityAutoMove`, `kanban.orderOverrides` |
| `_reloadSettingsFromStore` | 516-527 | same 6 keys |
| `toggleCliTriggers` | 6890 (write 6893) | `kanban.cliTriggersEnabled` |
| `toggleDynamicComplexityRouting` | 6917 (write 6921) | `kanban.dynamicComplexityRoutingEnabled` |
| `toggleAllowUnknownComplexityAutoMove` | 6929 (write 6933) | `kanban.allowUnknownComplexityAutoMove` |
| `updateRoutingConfig` → `_updateRoutingConfig` | 6978 → 6015 | `kanban.routingMapConfig` |
| `setColumnDragDropMode` | 6983 (write 6988) | `kanban.columnDragDropModes` |
| `setKanbanOrderOverrides` | 622 | `kanban.orderOverrides` (also reached from TaskViewerProvider `handleUpdateKanbanStructure` for built-in column order) |
| `cleanupKanbanColumnState` | 5215-5216, 5247-5248 | `kanban.orderOverrides`, `kanban.columnDragDropModes` |
| Generic `saveSetting` handler | 8369 | `switchboard.prompts.<key>` (non-roleConfig) |
| Generic `getSetting` handler | 8385 | `switchboard.prompts.<key>` (non-roleConfig) |
| `_getRoleConfig` fallback | 497 | `switchboard.prompts.roleConfig_<role>` — **owned by plan 05**, do not touch here |

**Category B — does NOT flow through the settings layer; storage verified, classified out of the scoped layer:**

| Handler | Verified line | Actual storage | Decision |
|---|---|---|---|
| `toggleClearTerminalBeforePrompt` / `updateClearTerminalBeforePromptDelay` | 6941 / 6960 | VS Code configuration `switchboard.terminal.clearBeforePrompt(Delay)` | Excluded — VS Code settings already have native user/workspace scoping; double-scoping them would create two competing systems |
| `setFeatureWorkflowMode` | 6895 (writes 6911-6912) | db config `feature_ultracode_enabled` / `feature_goal_enabled` | Already per-workspace by construction; project tier deferred |
| `setPairProgrammingMode` | 6536 | `workspaceState` `autoban.state` (`pairProgrammingMode` field; force-reset to `off` on load at TaskViewerProvider `:472-473`) | Already per-workspace ephemeral runtime state; excluded |
| `setAutomationMode` / `updateAutobanConfig` / `toggleAutoban` / `toggleAutobanPause` | 6466 / 6505 / 6511 / 6532 | `workspaceState` `autoban.state`, `singleColumn.autoban.state` via TaskViewerProvider `_persistAutobanState` (`:6543`) | Already per-workspace; automation state, not a "setting"; excluded |
| `saveAutoArchiveConfig` | 8530 | db config `kanban.autoArchive` via `AutoArchiveService.setConfig` (`AutoArchiveService.ts:102`) | Already per-workspace; project tier deferred (auto-archive is a board-wide service) |
| `saveKanbanColumn` / `updateKanbanStructure` / `toggleKanbanColumnVisibility` | 8544 / 8535 / 8574 | globalState `switchboard.kanban.customColumns` / `switchboard.agents.visibleAgents` via TaskViewerProvider `updateState` state.json mirror (+ `~/.switchboard` shadow read in `getVisibleAgents`) | Global-by-design storage riding a different mirror system; scoping it is a separate follow-up feature. Exception: built-in column ORDER flows into `kanban.orderOverrides` via `setKanbanOrderOverrides` → Category A, scoped. |
| `selectedRole` (generic handler special case) | 8361-8364 | `workspaceState` `switchboard.prompts.selectedRole` | Already per-workspace ephemeral UI state; stays as-is (original plan agrees) |

Net effect of the workspace override for Category B rows: those settings are ALREADY per-workspace (workspaceState / db config / VS Code workspace settings), so workspace-override semantics hold natively. Only the project tier is deferred for them.

#### 5. Generic `saveSetting` / `getSetting` handler updates (verified `:8355` / `:8373`)

- `saveSetting`: use `_updateScopedSetting(fullKey, value)` for non-roleConfig keys (`:8369`). `roleConfig_*` keys continue routing to `TaskViewerProvider.saveRoleConfig` until plan 05 replaces that route with the scoped role-config path.
- `getSetting`: use `_getScopedSetting(fullKey, undefined)` for non-roleConfig keys (`:8385`).
- `selectedRole` stays as-is (`workspaceState`, `:8361-8364` / `:8379-8381`).

#### 6. Reload & invalidation wiring

- **After provider wiring:** at the end of `setTaskViewerProvider` (`:217-218`), call `this._loadOverrideFlags()` then `this._reloadSettingsFromStore()` — the constructor's `:219` reload ran before the DB tier was reachable, so this second pass is what actually applies scoped values on startup.
- **On override toggle** (plan 03's handlers): `_loadOverrideFlags()` → `_reloadSettingsFromStore()` → `_markConfigDirty()` (`:5653`) → board refresh. Never bump `_configEpoch` manually.
- **On project filter change:** in the `setProjectFilter` method (`:5739`), after `_projectFilter` updates and when `_projectOverrideEnabled` is true, call `_reloadSettingsFromStore()` + `_markConfigDirty()` before the handler's `_refreshBoard` (`:6440`) runs, so the board renders with the new project's settings, plus push `overrideState` (plan 03 §5).

**Edge Cases:** DB not open / provider not wired → scoped tiers silently skipped, globalState-only resolution (same degradation as today's `_getSetting`); project override ON with no specific project → project tier dormant; values written while workspace-ON then override toggled OFF → effective values revert to globalState by design, db rows remain until next mirror write clobbers them.

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/KanbanProvider.ts` | New `_workspaceOverrideEnabled`/`_projectOverrideEnabled` fields + `_loadOverrideFlags`, `_getScopedSetting`/`_updateScopedSetting` methods, Category-A call-site swaps, generic `saveSetting`/`getSetting` handler update, reload hooks in `setTaskViewerProvider` and `setProjectFilter` |

## Verification Plan

### Automated Tests

Session directive: no compilation or automated test runs in this pass. Acceptance checklist for manual/UAT verification after coding:

- [ ] Both overrides OFF: `_getScopedSetting` returns same values as old `_getSetting` (no regression — bit-identical resolution)
- [ ] Both overrides OFF: `_updateScopedSetting` writes to globalState + db config mirror (same as old `_updateSetting`)
- [ ] Workspace ON: read checks db config before globalState
- [ ] Workspace ON: write goes to db config only, globalState untouched (verify another workspace's board is unaffected)
- [ ] Project ON (specific project): read checks project_config first
- [ ] Project ON: write goes to project_config only
- [ ] Project ON + Workspace ON: project_config takes precedence on read
- [ ] Project ON with filter on All/Unassigned: project tier dormant, workspace/global resolution applies
- [ ] Switching project filter: board refresh renders with the new project's settings (no stale-settings frame)
- [ ] All Category-A toggle/update handlers work correctly in all three scope states
- [ ] Startup: after extension activation, board reflects scoped values (the `setTaskViewerProvider` reload hook fires)
- [ ] Category-B settings (autoban, auto-archive, clear-terminal, column structure, selectedRole) behave exactly as before

---

**Recommendation: Send to Lead Coder**

## Review Findings

Verified all six `kanban.*` keys + the generic `switchboard.prompts.*` path route through `_getScopedSetting`/`_updateScopedSetting` (grep shows no leftover raw `_getSetting`/`_updateSetting` on scoped keys), both-OFF resolution is bit-identical to the old `_getSetting` (globalState→db→default), and the `setTaskViewerProvider` reload hook applies scoped values post-wiring. No code changes required. Files changed: none. Deferred NITs: the step-4 legacy db fallback re-queries redundantly on a miss, and `_updateSetting` is now dead code — both harmless. Remaining risk: toggle-handler flag persistence resolves the root via `msg.workspaceRoot` while reads use `TVP._resolveWorkspaceRoot()`; both converge on `_currentWorkspaceRoot` in normal operation, so divergence is only a self-correcting stale-webview race.
