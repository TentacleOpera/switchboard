# Global Override 04: Snapshot-on-Toggle Mechanism

## Goal

When a scope override switch is turned ON and its scoped store is empty (or missing keys), copy the current effective values of all scope-aware settings into that store — so the board looks identical before and after the toggle, and subsequent edits diverge from a faithful starting point.

### Problem

When a user turns ON a scope override switch for the first time, the scoped store (kanban.db `config` table or `project_config`) may be empty for some keys. Without a snapshot, the board would suddenly show default/empty values instead of the user's current configuration — a jarring experience.

### Background

Today's settings live in `globalState` and the kanban.db `config` table (mirrored). When workspace override is ON, reads check db config first. When project override is ON, reads check `project_config` first. If the scoped store is empty for a key, the read falls through to the next tier — so the board might look fine initially. But the first time the user changes a setting, it writes to the scoped store, and other unchanged settings might appear to "reset" if they were coming from a higher tier that's now shadowed.

**Verified against code (2026-07-07):**
- The complete set of keys flowing through the flat settings layer (see plan 02 §4 Category A) is exactly: `kanban.cliTriggersEnabled`, `kanban.dynamicComplexityRoutingEnabled`, `kanban.allowUnknownComplexityAutoMove`, `kanban.columnDragDropModes`, `kanban.routingMapConfig`, `kanban.orderOverrides`, plus dynamic `switchboard.prompts.*` keys (role configs and any future generic prompts-tab keys).
- The original draft's registry listed `autoArchive.*` and automation/column-structure keys — **verified out**: auto-archive stores at db config `kanban.autoArchive` via `AutoArchiveService` (already per-workspace), automation/autoban/pairProgramming store in `workspaceState` (`autoban.state`), and column structure/visibility store in globalState via the TaskViewerProvider state.json mirror system. None flow through the scoped layer (plan 02 Category B), so none belong in the snapshot registry.
- Role-config key discovery precedent: `exportPromptSettings` (`TaskViewerProvider.ts:653-702`) already enumerates `globalState.keys()` ∪ `workspaceState.keys()` filtered by the `switchboard.prompts.roleConfig_` prefix. The snapshot uses the same discovery.
- Because `_updateSetting` has always mirrored to db config, the workspace store is near-complete already for any key the user ever touched from the board — the workspace snapshot mostly covers globalState-only keys (set via older code paths or never edited on this machine).
- sql.js persists the whole DB image per write — the snapshot MUST use plan 01's batched `setProjectConfigJsonMany` (one persist), not per-key writes.

### Root Cause

No copy mechanism exists to populate the scoped store from the current effective values on first toggle.

### Desired Outcome

When a user turns ON a switch and the scoped store is empty (or missing keys), the current effective values for all known settings are copied into that scoped store. The board looks identical before and after the toggle. Subsequent changes write to the scoped store.

**Depends on:** Plan 01 (project_config table + batched write), Plan 02 (scope-aware layer), Plan 03 (toggle handlers with marked snapshot insertion points).

## Metadata

**Complexity:** 6
**Tags:** backend, feature, ux
**Project:** switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- The static key registry is small and verified (6 keys); dynamic prompts-key discovery copies an existing idiom (`exportPromptSettings`).
- Skip-if-populated checks are simple row-count / key-presence queries.
- Toggle-OFF-keeps-data requires writing no code — it is the absence of deletion.

### Complex / Risky
- Ordering: the snapshot MUST read via the flat pre-toggle resolution (`_getSetting`) and MUST run before the override flag flips — reading through the half-activated new scope would snapshot the wrong tier.
- Registry drift: any future scope-aware key added to plan 02's layer without a registry entry silently escapes snapshotting. Mitigated by the dynamic prompts-prefix discovery plus a code comment on `_updateScopedSetting` pointing at the registry.
- Workspace-tier dormancy is NOT symmetrical with project-tier dormancy (see Edge Cases) — tests must encode the asymmetry, not assume parity.

## Edge-Case & Dependency Audit

- **Race Conditions:** double-toggle before the async snapshot completes — the toggle handler must await the snapshot before flipping the flag and pushing `overrideState`, so the second toggle queues behind the first message-handler invocation. No additional locking needed (webview messages are handled sequentially).
- **Security:** none — copies existing values between internal stores.
- **Side Effects:** one batched db persist per first-toggle (acceptable); snapshot writes to db config for the workspace target overwrite mirror rows with identical values (harmless). **Workspace-tier dormancy caveat:** while workspace override is OFF, both-OFF-mode edits keep mirroring into db config — so previously scoped workspace values are progressively clobbered by the mirror. "Toggle OFF then ON restores previous workspace values" holds only for keys untouched while OFF. Project-tier dormancy is genuine: nothing writes `project_config` while the override is OFF, so project values restore faithfully.
- **Dependencies & Conflicts:** inserts into plan 03's marked handler insertion points; role-config snapshot coordinates with plan 05 (this plan copies the values; plan 05 makes reads/writes scoped). No migration concerns — feature is unreleased dev work; the snapshot only ever copies, never deletes.

## Dependencies

- Plans 01, 02, 03 must land first. Coordinates with plan 05 on role-config keys (either order works: snapshot writes are inert until plan 05 makes role-config reads scoped).

## Adversarial Synthesis

Key risks: snapshotting through the wrong (post-toggle) resolution producing a corrupt baseline (mitigated: snapshot uses flat `_getSetting` explicitly and runs before the flag flips); registry drift as new keys are added (mitigated: dynamic prefix discovery + registry comment); persist storm (mitigated: batched write from plan 01); false expectation of workspace-tier dormancy (documented + tested as asymmetric).

## Proposed Changes

### src/services/KanbanProvider.ts

**1. Known settings key registry** (corrected to the verified Category-A set):

```typescript
private static readonly SCOPE_AWARE_KEYS: string[] = [
    'kanban.cliTriggersEnabled',
    'kanban.dynamicComplexityRoutingEnabled',
    'kanban.allowUnknownComplexityAutoMove',
    'kanban.columnDragDropModes',
    'kanban.routingMapConfig',
    'kanban.orderOverrides',
];
```

Dynamic augmentation at snapshot time — discover every `switchboard.prompts.*` key (role configs + any generic prompts keys) from both mementos, mirroring the `exportPromptSettings` idiom (`TaskViewerProvider.ts:661-671`):

```typescript
const promptKeys = new Set<string>();
for (const k of this._context.globalState.keys()) {
    if (k.startsWith('switchboard.prompts.')) { promptKeys.add(k); }
}
for (const k of this._context.workspaceState.keys()) {
    if (k.startsWith('switchboard.prompts.') && k !== 'switchboard.prompts.selectedRole') { promptKeys.add(k); }
}
```

(`selectedRole` is excluded — ephemeral per-workspace UI state, plan 02.) Add a comment on `_updateScopedSetting`: *"any new scope-aware key must be added to SCOPE_AWARE_KEYS or match the switchboard.prompts. prefix."*

**Removed from the original draft's registry (with verified reasons):** `autoArchive.*` (stored at db config `kanban.autoArchive`, already per-workspace, not routed through the scoped layer), automation/autoban keys (workspaceState `autoban.state`), kanban column structure keys (globalState via state.json mirror — out of feature scope per plan 02 §4 Category B), `kanban.pairProgrammingMode` / `kanban.featureWorkflowMode` / `kanban.clearTerminalBeforePrompt(Delay)` (workspaceState / db config direct / VS Code configuration respectively — none flow through `_getSetting`).

**2. Snapshot method:**

```typescript
private async _snapshotSettingsToScope(target: 'workspace' | 'project', project?: string): Promise<void> {
    const keys = [...KanbanProvider.SCOPE_AWARE_KEYS, ...promptKeyDiscovery()];
    const entries: Record<string, unknown> = {};
    for (const key of keys) {
        // Flat pre-toggle resolution — deliberately NOT _getScopedSetting
        const currentValue = this._getSetting<any>(key, undefined);
        if (currentValue === undefined) continue; // skip keys with no value anywhere
        entries[key] = currentValue;
    }
    const root = this._taskViewerProvider?._resolveWorkspaceRoot();
    if (!root) return;
    const db = KanbanDatabase.forWorkspace(root);
    if (!(await db.ensureReady())) return;
    if (target === 'workspace') {
        for (const [key, value] of Object.entries(entries)) {
            await db.setConfigJson(key, value); // config-table writes have no batch variant; row count is small
        }
    } else if (target === 'project' && project) {
        await db.setProjectConfigJsonMany(project, entries); // single persist (plan 01)
    }
}
```

**Important (preserved from original design):** the snapshot must read using the *current* (pre-toggle) resolution. It runs *before* `_workspaceOverrideEnabled` / `_projectOverrideEnabled` flips to `true`, AND it uses the flat `_getSetting` explicitly — belt and braces.

**3. Workspace override snapshot** — in `setWorkspaceOverride` (plan 03 insertion point), when enabling:

```
1. Read existing db config keys; if all SCOPE_AWARE_KEYS + discovered prompt keys are present, skip
   (mirror behavior means this is the common case)
2. If any keys are missing, run _snapshotSettingsToScope('workspace') — fills only the gaps in effect
   (writing identical values over mirror rows is harmless)
3. Then set _workspaceOverrideEnabled = true and proceed (plan 03 steps)
```

**Optimization note (preserved):** since `_updateSetting` already mirrors to db config, most keys are already present. The snapshot mainly covers keys that only exist in `globalState` (set via older code paths, or edited on another machine before this workspace's db existed).

**4. Project override snapshot** — in `setProjectOverride` (plan 03 insertion point), when enabling:

```
1. rows = await db.getAllProjectConfigJson(project)
   — if non-empty, skip snapshot (user previously toggled ON; dormant data restores)
2. If empty, run _snapshotSettingsToScope('project', project)
   — copies current effective values (globalState/db config) into project_config in one batched persist
3. Then set _projectOverrideEnabled = true and proceed (plan 03 steps)
```

**5. Toggle OFF behavior — no deletion** (unchanged from original design):
- **Workspace OFF:** no data deletion. db config rows remain. Reads revert to `globalState → db config` fallback order. *Caveat (verified):* while OFF, both-OFF-mode edits keep mirroring into db config, so workspace-scoped values for edited keys are overwritten — dormancy is partial by design.
- **Project OFF:** no data deletion. `project_config` rows remain fully dormant (nothing else writes that table). Toggling back ON finds rows and skips the snapshot — previous values restored faithfully.

**Rationale (preserved):** users may toggle OFF temporarily and expect their scoped settings to survive. Deletion would be destructive. A separate "Reset to inherited" action (phase 3, uses plan 01's `deleteProjectConfigJson`/`clearAllProjectConfig`) can provide explicit clearing. Per repo policy, that reset action gets no confirmation dialog.

**6. Role config snapshot coordination** — role configs (`switchboard.prompts.roleConfig_*`) are covered by the dynamic prefix discovery in §1 — they are ordinary globalState keys, readable via `_getSetting` (no TaskViewerProvider round-trip needed for the copy; the original draft's `getRoleConfig` detour is unnecessary since `getRoleConfig` is itself a plain globalState read, verified `TaskViewerProvider.ts:649-651`). Plan 05 makes the role-config read/write path scope-aware; this plan guarantees the values are present in the scoped store when that path activates. Discovery-by-prefix also future-proofs against the divergent hardcoded role lists (9-role, 7-role, and 10-role variants exist — see plan 05).

**Edge Cases:** key present in workspaceState but not globalState (prompt-prefix discovery catches it; `_getSetting` still resolves via globalState/db — if truly absent everywhere, skipped); project renamed on the board while override ON (project_config rows keyed by old name orphan — accepted for v1, same exposure as `kanban.activeProjectFilter` itself); snapshot when db unavailable (guarded no-op — toggle still proceeds, falls back to fall-through resolution which is today's behavior).

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/KanbanProvider.ts` | `SCOPE_AWARE_KEYS` registry + prompts-prefix discovery, `_snapshotSettingsToScope` method, skip-if-populated snapshot calls inside `setWorkspaceOverride` / `setProjectOverride` handlers |

## Verification Plan

### Automated Tests

Session directive: no compilation or automated test runs in this pass. Acceptance checklist for manual/UAT verification after coding:

- [ ] Toggle Workspace ON for first time (db config missing some keys): missing keys copied from globalState, board looks identical
- [ ] Toggle Workspace ON when db config already has all keys: snapshot skipped, board looks identical
- [ ] Toggle Project ON for first time (project_config empty): all current effective values copied in ONE persist, board looks identical
- [ ] Toggle Project ON when project_config already has rows (dormant): snapshot skipped, previous values restored
- [ ] Toggle Project OFF: project_config rows remain, board reverts to workspace/global resolution
- [ ] Toggle Project OFF then ON: previous project settings restored faithfully
- [ ] Toggle Workspace OFF, edit a setting (mirror writes db config), toggle ON: edited key shows the NEW value (partial dormancy is by design — test encodes the asymmetry)
- [ ] Change a setting after snapshot: write goes to the scoped store only
- [ ] Role configs (all `switchboard.prompts.roleConfig_*` keys present in globalState) are included in the snapshot
- [ ] Rapid double-toggle: no interleaved half-snapshot (handler awaits snapshot before flipping flag)

---

**Recommendation: Send to Coder**
