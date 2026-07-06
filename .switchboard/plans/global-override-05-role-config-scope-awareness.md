# Global Override 05: Role Config Scope Awareness

## Goal

Route role configs (`switchboard.prompts.roleConfig_*`) — the Prompts/Agents tab settings and every prompt-assembly read of them — through the scope-aware resolution, so a project can carry its own `roleConfig_coder`, `roleConfig_lead`, etc. that override workspace and global values, and dispatched prompts actually use them.

### Problem

Role configs flow through `TaskViewerProvider`, not `KanbanProvider`. They have their own read/write path (`TaskViewerProvider.saveRoleConfig` / `getRoleConfig`) that goes to `globalState` + workspace config mirror. This path is completely separate from the scope-aware layer built in plans 02-04, so role configs would NOT be scope-aware unless explicitly integrated.

### Background

**Verified against code (2026-07-07):**
- `TaskViewerProvider.saveRoleConfig(key, value)` at `:630` → `updateSetting('switchboard.prompts.' + key, value)` (`:614`) → globalState + db config mirror; then rebuilds `this._cachedDefaultPromptOverrides` via `_getDefaultPromptOverrides` (`:641`). **The prompt-overrides cache lives on TaskViewerProvider, not KanbanProvider** (the original draft's `KanbanProvider._cachedDefaultPromptOverrides` does not exist — `KanbanProvider._getDefaultPromptOverrides` at `:3627` is uncached and delegates to TVP).
- `TaskViewerProvider.getRoleConfig(key)` at `:649-651` → `getSetting` (`:610`) — **plain globalState read, nothing else**.
- Key mapping: webview sends the SHORT key `roleConfig_<role>`; providers re-prefix to `switchboard.prompts.roleConfig_<role>`. `KanbanProvider` `saveSetting`/`getSetting` handlers route short keys at `:8366-8370` / `:8382-8384`.
- `KanbanProvider._getRoleConfig(role)` at `:493-498` delegates to `TVP.getRoleConfig`, falling back to its own `_getSetting` at `:497`. Prompt-building reads via `_getRoleConfig`: `:3648` (default overrides), `:3982` (addons), `:4025` (prompt text), `:4242-4255` (dispatch-options builder, per-role git-policy maps consumed `:4342-4378`), `:8603` (webview handler).
- **TaskViewerProvider reads role configs directly via `getSetting` (bypassing even `getRoleConfig`) in seven places:** `:7989` (`_getDefaultPromptOverrides` cache builder loop), six addon getters at `:16315-16316` (`_isAccurateCodingEnabled` — coder+lead), `:16323` (`_isAdvancedReviewerEnabled`), `:16330` (`_isLeadInlineChallengeEnabled`), `:16336` (`_isAggressivePairProgrammingEnabled`), `:16353` (`_isDesignSystemDocEnabled`), and `:16726` (dispatch git-policy read, `addons.gitProhibition`).
- Cross-provider wiring: `TaskViewerProvider._kanbanProvider` field at `:387` (setter `:2140`), `KanbanProvider._taskViewerProvider` at `:204` (setter `:217`), both wired in `extension.ts:790-792`. Direct delegation between the two is the established mechanism.
- Role lists are divergent and inlined (no single source): 9 roles at `TaskViewerProvider:7987` and `KanbanProvider:3646`; 7 roles at `KanbanProvider:3709`; 10 roles (adds `claude_designer`) at `KanbanProvider:4242-4255`. Snapshot (plan 04) sidesteps this via prefix discovery.
- `exportPromptSettings()` at `:653-702` enumerates `globalState.keys()` ∪ `workspaceState.keys()`, filters the roleConfig prefix, values read from globalState, writes `.switchboard/settings.json`.

### Root Cause

The role config read/write path bypasses the scope-aware layer entirely. It needs to be routed through the scoped resolution so that project-scoped and workspace-scoped role configs work — including the prompt-assembly reads inside TaskViewerProvider, or dispatched prompts silently ignore the scoped values.

### Desired Outcome

Role configs are fully scope-aware: a project can have its own `roleConfig_coder`, `roleConfig_lead`, etc. that override the workspace and global role configs. The prompt-building pipeline — both providers — uses the scoped values, and the TVP prompt-overrides cache invalidates on scope changes.

**Depends on:** Plan 01 (project_config table), Plan 02 (scope-aware layer pattern).

## Metadata

**Complexity:** 6
**Tags:** backend, refactor, feature
**Project:** switchboard

## User Review Required

None. Integration approach is decided: Option A (KanbanProvider owns resolution; TaskViewerProvider delegates through its existing `_kanbanProvider` reference with a globalState fallback) — no duplicated resolution logic, no new wiring.

## Complexity Audit

### Routine
- `_getScopedRoleConfig` / `_updateScopedRoleConfig` are direct applications of plan 02's pattern to one key family.
- The `saveSetting`/`getSetting` handler swap is two lines.
- Export extension follows the existing enumerate-and-filter shape.

### Complex / Risky
- Seven direct `getSetting` reads inside TaskViewerProvider (cache builder + six addon getters + git-policy read) must ALL be rerouted — missing one means that addon/policy silently reads global values while the Prompts tab shows project values. The verified line inventory above is the checklist.
- Cache coherence: `_cachedDefaultPromptOverrides` (TVP) is rebuilt on save today; with scoping it must ALSO rebuild on override toggle and project-filter change, or dispatched prompts use the previous scope's overrides.
- Divergent inlined role lists (7/9/10 roles) mean role coverage differs per code path — resolution must be per-key (asked role → scoped lookup), never per-list, so list divergence cannot drop a scoped role.

## Edge-Case & Dependency Audit

- **Race Conditions:** role-config save racing a project-filter switch — the write captures `_projectFilter` at call time (correct target); the subsequent cache rebuild reads the new filter, which is the fresher state (acceptable — next dispatch uses current scope). Cache rebuild is async after write; a dispatch fired in that window uses the stale cache for one prompt (same exposure as today's save path, accepted).
- **Security:** none new — same stores, same binding as plans 01-02.
- **Side Effects:** scoped writes stop updating globalState, so OTHER workspaces' role configs no longer see edits made while an override is ON (intended). Export file shape gains scoped sections — downstream import must tolerate the superset (additive keys, no format break).
- **Dependencies & Conflicts:** depends on plans 01+02; coordinates with plan 04 (snapshot copies role-config values; this plan makes the path read them). The `_kanbanProvider` back-reference can be unset in edge hosts (sidebar-only flows before wiring) — every TVP scoped read keeps the `getSetting` fallback, degrading to today's behavior.

## Dependencies

- Plans 01 and 02 must land first. Ships with plan 04 in either order (snapshot writes are inert until this plan activates scoped reads).

## Adversarial Synthesis

Key risks: a missed direct read in TaskViewerProvider leaving one addon on global values (mitigated: verified seven-site inventory as the implementation checklist); stale prompt-overrides cache after scope/filter changes (mitigated: explicit rebuild hooks on toggle + filter change); provider-wiring gaps (mitigated: globalState fallback on every delegated read). Mitigations keep both-OFF behavior byte-identical to today.

## Proposed Changes

### src/services/KanbanProvider.ts

**1. Scope-aware role config read** — public (TVP delegates to it):

```typescript
public getScopedRoleConfig(role: string): any {
    const key = `switchboard.prompts.roleConfig_${role}`;
    const root = this._taskViewerProvider?._resolveWorkspaceRoot();
    if (root) {
        try {
            const db = KanbanDatabase.forWorkspace(root);
            if (db.isOpen()) {
                // 1. Project tier
                if (this._projectOverrideEnabled && this._projectFilter && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
                    const projectVal = db.getProjectConfigJsonSync<any>(this._projectFilter, key, undefined);
                    if (projectVal !== undefined) return projectVal;
                }
                // 2. Workspace tier (if workspace override ON)
                if (this._workspaceOverrideEnabled) {
                    const wsVal = db.getConfigJsonSync<any>(key, undefined);
                    if (wsVal !== undefined) return wsVal;
                }
            }
        } catch { /* fall through to global */ }
    }
    // 3. Global (existing behavior)
    return this._taskViewerProvider?.getRoleConfig(`roleConfig_${role}`)
        ?? this._getSetting(key, undefined);
}
```

**2. Scope-aware role config write:**

```typescript
public async updateScopedRoleConfig(role: string, value: unknown): Promise<void> {
    const key = `switchboard.prompts.roleConfig_${role}`;
    const root = this._taskViewerProvider?._resolveWorkspaceRoot();
    const db = root ? KanbanDatabase.forWorkspace(root) : undefined;
    if (this._projectOverrideEnabled && this._projectFilter
            && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER
            && db && await db.ensureReady()) {
        await db.setProjectConfigJson(this._projectFilter, key, value);   // project_config only
    } else if (this._workspaceOverrideEnabled && db && await db.ensureReady()) {
        await db.setConfigJson(key, value);                               // db config only, no globalState
    } else {
        await this._taskViewerProvider?.saveRoleConfig(`roleConfig_${role}`, value); // today's path (globalState + mirror + cache rebuild)
    }
    // Cache invalidation for the scoped branches (saveRoleConfig handles its own):
    await this._taskViewerProvider?.refreshPromptOverridesCache();
}
```

**3. `saveSetting` / `getSetting` handler** (`:8355`/`:8373`): for `roleConfig_*` keys, replace `saveRoleConfig(key, value)` (`:8366-8370`) with `updateScopedRoleConfig(roleName, value)` and `getRoleConfig(key)` (`:8382-8384`) with `getScopedRoleConfig(roleName)` (strip the `roleConfig_` prefix to get `roleName`).

**4. `_getRoleConfig` rewire** (`:493-498`) — the single choke point for KanbanProvider's own prompt-building reads (`:3648`, `:3982`, `:4025`, `:4242-4255`, `:8603` all funnel through it):

```typescript
private _getRoleConfig(role: string): any {
    return this.getScopedRoleConfig(role);
}
```

**5. Cache-rebuild hooks:** in the `setWorkspaceOverride` / `setProjectOverride` handlers (plan 03) and in `setProjectFilter` (`:5739`, when `_projectOverrideEnabled`), call `this._taskViewerProvider?.refreshPromptOverridesCache()` after the settings reload — so dispatched prompts never use the previous scope's overrides.

### src/services/TaskViewerProvider.ts

**6. Public cache refresh** — wrap the existing rebuild (today inlined in `saveRoleConfig` `:637-644`):

```typescript
public async refreshPromptOverridesCache(): Promise<void> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (workspaceRoot) {
        try { this._cachedDefaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot); } catch { /* keep prior */ }
    }
}
```

`saveRoleConfig` calls it too (replacing the inline block — same behavior, one implementation).

**7. Reroute the seven direct reads** through the scoped resolver, each with the existing read as fallback when `_kanbanProvider` is unset:

```typescript
private _readRoleConfigScoped(role: string): any {
    return this._kanbanProvider?.getScopedRoleConfig(role)
        ?? this.getSetting(`switchboard.prompts.roleConfig_${role}`, undefined);
}
```

Swap at (verified lines): `:7989` (`_getDefaultPromptOverrides` role loop — this is what makes the CACHE scope-aware), `:16315` + `:16316` (`_isAccurateCodingEnabled`), `:16323` (`_isAdvancedReviewerEnabled`), `:16330` (`_isLeadInlineChallengeEnabled`), `:16336` (`_isAggressivePairProgrammingEnabled`), `:16353` (`_isDesignSystemDocEnabled`), `:16726` (dispatch `addons.gitProhibition` read). This is Option A from the original draft, concretized: TVP already holds `_kanbanProvider` (`:387`, wired `extension.ts:790`), so no new wiring or resolver-callback plumbing is needed; the fallback preserves today's behavior when the reference is absent. Resolution is per-role-key, so the divergent inlined role lists (7/9/10 variants) cannot drop a scoped role — whatever list a code path iterates, each lookup individually resolves through scope.

**8. Export/import — `exportPromptSettings()`** (`:653-702`): after the existing globalState/workspaceState enumeration, additionally include:
- Workspace-scoped role configs: enumerate `switchboard.prompts.roleConfig_*` keys from the db `config` table when workspace override is ON.
- Project-scoped role configs: `db.getAllProjectConfigJson(activeProject)` filtered to the roleConfig prefix when project override is ON.
Emit them under new top-level fields (e.g. `workspaceRoleConfigs`, `projectRoleConfigs: { project, configs }`) so the existing `roleConfigs` shape is untouched (additive, import-compatible).

**Edge Cases:** `_kanbanProvider` unset (sidebar-only path) → fallback to globalState read, today's behavior; role name absent from a hardcoded list but present in project_config → per-key resolution still returns it wherever that role IS iterated (list unification is a separate cleanup, out of scope); `claude_designer` (the 10th role, `KanbanProvider:4255`) → covered like any other role via per-key resolution and prefix-based snapshot discovery.

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/KanbanProvider.ts` | Public `getScopedRoleConfig` / `updateScopedRoleConfig`, `_getRoleConfig` rewire, `saveSetting`/`getSetting` roleConfig routing swap, cache-rebuild hooks on toggle + filter change |
| `src/services/TaskViewerProvider.ts` | Public `refreshPromptOverridesCache()`, `_readRoleConfigScoped` helper + seven read-site swaps, `exportPromptSettings` additive scoped sections |

## Verification Plan

### Automated Tests

Session directive: no compilation or automated test runs in this pass. Acceptance checklist for manual/UAT verification after coding:

- [ ] Both overrides OFF: role config read/write byte-identical to today (globalState + mirror, cache rebuild on save)
- [ ] Workspace ON: changing a role config in Prompts tab writes to db config only (globalState untouched)
- [ ] Workspace ON: reading a role config checks db config before globalState
- [ ] Project ON: changing a role config writes to project_config only
- [ ] Project ON: reading checks project_config → db config → globalState
- [ ] Prompt preview reflects scoped role config values
- [ ] Dispatching a prompt to a CLI agent uses the scoped role config (including `addons.gitProhibition` at the `:16726` read)
- [ ] Each of the six addon getters honors project-scoped `addons.*` flags
- [ ] Toggling an override or switching projects rebuilds the prompt-overrides cache (next dispatch uses new scope)
- [ ] Export includes scoped role configs under the additive fields; legacy `roleConfigs` shape unchanged
- [ ] Snapshot (plan 04) copies role configs; toggling Project ON then editing `roleConfig_coder` diverges only that project
- [ ] Sidebar flows with `_kanbanProvider` unset fall back to global reads without error

---

**Recommendation: Send to Lead Coder**
