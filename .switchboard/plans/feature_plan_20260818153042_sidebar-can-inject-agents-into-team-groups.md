# Sidebar can inject agents into team groups — team membership must be Teams-tab-only

## Goal

### Problem
The terminals sidebar allows arbitrary terminals to be added to **team groups** — groups created by `wireSpawnedTeam` when a team is started from the Teams tab. Once a terminal is added to a team group's `members` array, it receives that team's **team-scoped standing orders on every prompt** — including the full Coding team prompt (callback instruction + work directives + git safety rules). The agent then believes it is a member of the Coding team, even though no team was started in the current session.

The user reports: "whenever i join a agent to another one, it thinks it is in the coding team and gives it the coding team standing orders on every prompt. it is not. i've never started that team in this session." Teams are built in the Teams tab, not the terminals sidebar — the sidebar should not be able to mutate team membership.

### Root cause
Team groups and manual groups are **indistinguishable** in the client-side code. Both carry `source: 'manual'`:

- `wireSpawnedTeam` (teamWiring.ts:1217-1224) creates a group with `source: 'manual'`, id `team_<headName>`, and members `[headName, ...childNames]`.
- `saveSelectionAsGroup` (terminals.js:2540-2550) creates a group with `source: 'manual'`, id `grp_<timestamp>_<random>`, and members from the multi-selection.
- `saveCurrentAsGroup` (terminals.js:2406-2416) creates a group with `source: 'manual'`, id `grp_<timestamp>_<random>`, and members from the current pane arrangement.

Because they share the same `source`, the sidebar's group-mutation code paths treat team groups identically to manual groups:

1. **`addTerminalToActiveGroup`** (terminals.js:2884-2897): When a group is active (locked) and the user clicks a non-member terminal with a free pane slot, `handleLockedTerminalClick` (terminals.js:2936-2942) calls `addTerminalToActiveGroup(name)`. For `source: 'manual'` groups, this pushes the terminal directly into `group.members` and calls `saveLayoutSettings()`, which writes the entire `terminalGroups` array — including the now-modified team group — to `terminals.groups` in the DB.

2. **Pane-unassign** (terminals.js:4734-4735): Unassigning a pane while a team group is locked removes the terminal from `group.members` and persists the change.

3. **`selectOrders`** (standingOrders.ts:197-205): Once a terminal is in a team group's `members` array, `selectOrders` includes the team-scoped standing order for that terminal on every prompt. The team-scoped order carries the full team prompt (callback + work instructions + git safety directives), so the agent receives the complete Coding team standing orders.

The team group and team-scoped standing orders **persist across sessions** in the DB config. A team started in a previous session (or via auto-start) leaves its group registration and standing orders in the DB. In a new session, the team group is loaded into the client-side `terminalGroups` array via `loadLayoutSettings` (terminals.js:1546-1564) and `reloadTerminalGroups` (terminals.js:1652+). The user can then inadvertently add terminals to this stale team group by clicking them while the group tab is active.

### Proposed direction
1. **Distinguish team groups from manual groups** by adding a `teamGroup: true` flag to groups created by `wireSpawnedTeam`. Migrate existing team groups in the DB to add this flag.
2. **Guard `addTerminalToActiveGroup`** to refuse modifying team groups — team membership is managed exclusively by the team system (start/stop in the Teams tab).
3. **Guard the pane-unassign path** to refuse removing members from team groups.
4. **Guard `handleLockedTerminalClick`** to fall through to the lock-drop path when the active group is a team group, so the click is not dead and the terminal is seated normally without being added to the team.

## Metadata
- **Complexity:** 6
- **Tags:** frontend, backend, bugfix, ui, ux
- **Project:** Browser Switchboard

## User Review Required

This plan modifies shipped DB state (the `teamGroup` flag migration on `terminals.groups`) and guards three client-side mutation paths. The migration targets the runtime terminal-groups key (`switchboard.prompts.terminals.groups`), NOT the team-definition key (`terminals.agentGroups`) — these are separate DB keys with separate read paths. Review the migration insertion points before implementation.

The `deleteGroup` path (terminals.js:2439) is **not guarded** — team groups can still be deleted from the sidebar. This is intentional: stale team groups from previous sessions need a cleanup path, and the Teams tab may not show teams with no live terminals. If deleting team groups from the sidebar should also be blocked, flag it before implementation.

## Complexity Audit

### Routine
- Adding a `teamGroup: true` flag to the group object in `wireSpawnedTeam` — one line in the group literal (teamWiring.ts:1217-1224) and one in the upsert merge path (teamWiring.ts:1236-1248).
- Guarding `addTerminalToActiveGroup` with an early return for team groups — one conditional (terminals.js:2884).
- Guarding the pane-unassign path with an early return for team groups — one conditional (terminals.js:4729-4741).
- Adding an `isTeamGroup` helper function — 3 lines.
- Client-side migration in `loadLayoutSettings` and `reloadTerminalGroups` — ID prefix check, 3-4 lines each.

### Complex / Risky
- **Migration of existing team groups**: Existing installs have team groups in `terminals.groups` (DB key `switchboard.prompts.terminals.groups`) without the `teamGroup` flag. A migration must identify them. Team groups have IDs matching `team_<encoded-headName>` (teamWiring.ts:1087-1088), while manual groups have IDs matching `grp_<timestamp>_<random>` (terminals.js:2407, 2541). The `grp_` prefix is hardcoded in `saveCurrentAsGroup` and `saveSelectionAsGroup` — it is not user-editable — so `team_` prefix collision with a manual group is impossible. The migration uses `id.startsWith('team_')` to retroactively flag team groups. This is a DB config migration — per CLAUDE.md, state that shipped in a released version MUST be migrated.
- **Migration read path — two insertion points required**: The migration must run on the `TERMINALS_GROUPS_KEY` (`switchboard.prompts.terminals.groups`) read path, NOT the `AGENT_GROUPS_CONFIG_KEY` (`terminals.agentGroups`) read path. These are separate keys. The backend migration runs inside `mutateTerminalGroups` (teamWiring.ts:187), which already reads the array on every write. The client-side migration runs in `loadLayoutSettings` (terminals.js:1546) and `reloadTerminalGroups` (terminals.js:1652), because the initial load path reads directly from the DB via `loadSetting` and does not go through `mutateTerminalGroups`.
- **`handleLockedTerminalClick` fall-through behavior**: When the active group is a team group and the user clicks a non-member terminal with a free slot, the guard must prevent the add+seat path AND fall through to the lock-drop path. If `addTerminalToActiveGroup` returns early but `assignToFocusedPane(name, { keepLock: true })` still runs, the terminal would be seated under the team group's lock without being a member — the next `seatActiveGroupPage` reconcile would evict it (it appears briefly then disappears). The fix checks `isTeamGroup(activeGroupId)` before the add+seat path and falls through to the existing lock-drop logic at line 2948+.

## Edge-Case & Dependency Audit

1. **Team group with `source: 'manual'` and `teamGroup: true`**: The `reloadTerminalGroups` validation (terminals.js:1656-1660) accepts `source: 'manual'` but does not check for `teamGroup`. After the change, team groups will have `source: 'manual'` AND `teamGroup: true`. The validation must continue to accept them — the `teamGroup` flag is an additional property, not a replacement for `source`. The validation filter does not need to change; the `teamGroup` flag passes through as an extra property on the object.

2. **`handleLockedTerminalClick` free-slot behavior**: When a team group is active and the user clicks a non-member terminal with a free slot, the current code adds the terminal to the group (line 2940). After the fix, this must NOT happen — the code falls through to the lock-drop path (line 2948+), which drops the lock and seats the terminal. This is the correct behavior: the user clicked a terminal that isn't part of the team, so the lock is released and the terminal is seated normally. The click is not dead.

3. **Pane unassign under team group lock**: When a team group is active and the user unassigns a pane, the current code removes the terminal from the group's members (line 4734-4735). After the fix, the terminal should remain in the team group's members — only the pane assignment is cleared, not the group membership. The pane becomes empty, but the terminal stays in the team group. This is correct: unassigning a pane is a layout action, not a team management action.

4. **`saveLayoutSettings` whole-array write**: `saveLayoutSettings` (terminals.js:1635) writes the entire `terminalGroups` array to `terminals.groups` in the DB. This includes team groups. If the client-side team group objects are unchanged (because the guards prevented mutation), the write is harmless — it writes back the same data. If a `reloadTerminalGroups` merge updated a team group's members from the backend, and then `saveLayoutSettings` writes, the backend's update is preserved (it was merged into the client-side array). A pre-existing race exists: backend updates team group members → `saveLayoutSettings` writes stale client-side array → backend update is lost. This is a pre-existing issue, not introduced or worsened by this plan. No defense-in-depth check is added — the guards are the real defense, and a half-specified state-tracking variable would add complexity without proportional value.

5. **Migration ID pattern safety**: Team group IDs are `team_` + `encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_')` (teamWiring.ts:1087-1088). Manual group IDs are `grp_` + timestamp + `_` + random (terminals.js:2407, 2541). The `grp_` prefix is hardcoded in both `saveCurrentAsGroup` and `saveCurrentAsGroup` — it is not derived from user input. A manual group cannot have an ID starting with `team_`. The migration's `id.startsWith('team_')` check is safe.

6. **Derived groups (role/worktree)**: Derived groups have `source: 'role'` or `source: 'worktree'`, not `source: 'manual'`. They are already excluded from the `addTerminalToActiveGroup` manual-group branch (line 2887) — they use `groupPrefs.extras` instead. The fix only affects `source: 'manual'` groups with `teamGroup: true`, so derived groups are unaffected.

7. **LINK UP modal**: The LINK UP modal's standing mode creates pair-scoped standing orders, not team-scoped ones. It does not modify group membership. This plan does not affect the LINK UP modal. The "reports-to-head" preset text is byte-identical to `AGENT_GROUP_CALLBACK_INSTRUCTION`, which means a pair-scoped standing order from LINK UP can make an agent think it has a "head agent" — but this is a pair relationship, not a team membership, and does not carry the full team prompt. This is a separate UX concern, not the bug described here.

8. **Auto-start**: `startTeamsOnLoad` (TaskViewerProvider.ts) auto-starts teams with `startOnLoad: true` on boot. If a Coding team was forked from the gallery and has `startOnLoad: true`, it auto-starts on every boot, creating team groups and standing orders. The user may not realize the team is auto-starting. This plan does not change auto-start behavior — it only prevents the sidebar from mutating team group membership.

9. **`deleteGroup` is unguarded for team groups**: `deleteGroup` (terminals.js:2439) removes any `source: 'manual'` group from `terminalGroups`. Team groups have `source: 'manual'`, so they can be deleted from the sidebar. This is intentional: stale team groups from previous sessions need a cleanup path, and the Teams tab may not show teams with no live terminals. Deleting a team group removes the group registration but does NOT remove the team-scoped standing orders (those persist in a separate DB key). A separate plan could address stale team state cleanup.

10. **Standing orders cleanup**: This plan addresses the group membership mutation but does NOT clean up stale team-scoped standing orders from teams started in previous sessions. Those orders persist in the DB and are applied to any terminal that ends up in the team group's members. A separate plan could address stale team state cleanup (removing team groups and standing orders when no team terminals are live). This plan focuses on preventing the injection.

## Dependencies
- None — this plan is self-contained. The fix is purely additive (a new flag, guards, and a migration).

## Adversarial Synthesis

Key risks: (1) the migration must target `TERMINALS_GROUPS_KEY` (`switchboard.prompts.terminals.groups`), not `AGENT_GROUPS_CONFIG_KEY` (`terminals.agentGroups`) — these are separate DB keys, and targeting the wrong one silently no-ops the migration; (2) the `handleLockedTerminalClick` fall-through must check `isTeamGroup` before the add+seat path, not just rely on `addTerminalToActiveGroup` returning early — otherwise the terminal is seated under the lock without membership and evicted on the next reconcile; (3) `deleteGroup` remains unguarded for team groups, which is intentional but must be explicitly acknowledged. Mitigations: migration runs at both backend (`mutateTerminalGroups`) and client-side (`loadLayoutSettings`, `reloadTerminalGroups`) read paths; fall-through is verified by the pane-reconcile eviction path in the verification plan.

## Proposed Changes

### 1. `src/services/teamWiring.ts` — Add `teamGroup: true` flag to team group registration

In `wireSpawnedTeam`, add `teamGroup: true` to the group object (around line 1217):

```typescript
const group = {
    id: groupId,
    name: headName,
    source: 'manual' as const,
    teamGroup: true,          // ← NEW: distinguishes team groups from manual groups
    layout,
    members: groupMembers,
    order: groupMembers,
};
```

Also add it to the upsert merge path (around line 1236-1248):

```typescript
const merged = (existing && typeof existing === 'object')
    ? {
        ...existing,
        id: groupId,
        name: headName,
        source: 'manual' as const,
        teamGroup: true,      // ← NEW: preserve on re-wire
        layout: (typeof existing.layout === 'string' && TERMINALS_LAYOUT_MODES.has(existing.layout))
            ? existing.layout
            : layout,
        members: groupMembers,
        order: groupMembers,
    }
    : group;
```

### 2. `src/services/teamWiring.ts` — Migrate existing team groups inside `mutateTerminalGroups`

> **Superseded:** Call this migration from the same read path that calls `migrateAgentGroups` — the `_loadAgentGroups` or `loadTerminalGroups` function.
> **Reason:** `migrateAgentGroups` operates on `AGENT_GROUPS_CONFIG_KEY` (`'terminals.agentGroups'` — team definition templates), NOT on `TERMINALS_GROUPS_KEY` (`'switchboard.prompts.terminals.groups'` — runtime terminal groups). These are separate DB keys with separate read paths. Calling the `teamGroup` migration from the `migrateAgentGroups` read path would run it against the wrong key — it would find no team groups to flag and silently no-op. Every existing team group in the field would stay unflagged, every guard would silently never fire, and the bug would persist behind a green test.
> **Replaced with:** Run the migration inside `mutateTerminalGroups` (teamWiring.ts:187), which already reads the `TERMINALS_GROUPS_KEY` array on every call. Also run a client-side migration in `loadLayoutSettings` (terminals.js:1546) and `reloadTerminalGroups` (terminals.js:1652), because the initial load path reads directly from the DB via `loadSetting` and does not go through `mutateTerminalGroups`.

Add a migration function in `teamWiring.ts`:

```typescript
/**
 * Flag existing team groups in the terminals.groups array with `teamGroup: true`.
 * Team groups have IDs starting with 'team_' (from wireSpawnedTeam's groupId
 * derivation). Manual groups use 'grp_' prefix (hardcoded, not user-editable),
 * so prefix collision is impossible.
 *
 * Returns `null` when nothing changed (already fully flagged), so the caller
 * does not write. Returns the converted array otherwise.
 *
 * This function is pure — it does not touch the DB.
 */
export function migrateTeamGroupFlags(groups: any[]): any[] | null {
    if (!Array.isArray(groups) || groups.length === 0) { return null; }
    let changed = false;
    const next = groups.map(g => {
        if (!g || typeof g !== 'object') { return g; }
        if (g.id && typeof g.id === 'string' && g.id.startsWith('team_') && !g.teamGroup) {
            changed = true;
            return { ...g, teamGroup: true };
        }
        return g;
    });
    return changed ? next : null;
}
```

Call this migration inside `mutateTerminalGroups` (teamWiring.ts:187), after reading the current array and before applying the caller's transform:

```typescript
// Inside mutateTerminalGroups, after `current` is populated (around line 201):
const migrated = migrateTeamGroupFlags(current);
if (migrated !== null) {
    current = migrated;
    // Persist the migration result even if the caller's transform is a no-op.
    // The validated write below will persist the flagged array.
}
```

The migration result is persisted because `mutateTerminalGroups` always writes the `validated` array (line 231-236). If the caller's transform returns the array unchanged, the migrated flags are still written.

### 3. `src/webview/terminals.js` — Client-side migration in `loadLayoutSettings` and `reloadTerminalGroups`

The initial load path (`loadLayoutSettings`, terminals.js:1546) reads `terminals.groups` via `loadSetting` and does NOT go through `mutateTerminalGroups`. Add a client-side migration after the filter/map at line 1548-1562:

```javascript
// After the .filter(Boolean) at line 1562, before lastReadGroupIds assignment:
terminalGroups = terminalGroups.map(g => {
    if (g && typeof g.id === 'string' && g.id.startsWith('team_') && !g.teamGroup) {
        return { ...g, teamGroup: true };
    }
    return g;
});
```

Similarly, in `reloadTerminalGroups` (terminals.js:1656), after the `validated` filter at line 1660, add the same check:

```javascript
const validated = savedGroups.filter(g =>
    g && typeof g.id === 'string' && typeof g.name === 'string' &&
    LAYOUT_MODES.includes(g.layout) &&
    (g.source === 'manual' || g.source === 'role' || g.source === 'worktree')
).map(g => {
    if (g.id.startsWith('team_') && !g.teamGroup) {
        return { ...g, teamGroup: true };
    }
    return g;
});
```

This client-side migration is idempotent and does not persist on its own — it flags groups in memory so the guards work. The backend migration in `mutateTerminalGroups` handles persistence.

### 4. `src/webview/terminals.js` — Add `isTeamGroup` helper

Add a helper function near `getAllGroups` (around line 2738):

```javascript
function isTeamGroup(groupId) {
    const g = getAllGroups().find(g => g.id === groupId);
    return !!(g && g.teamGroup);
}
```

### 5. `src/webview/terminals.js` — Guard `addTerminalToActiveGroup` against team groups

In `addTerminalToActiveGroup` (line 2884), add an early return for team groups:

```javascript
function addTerminalToActiveGroup(name) {
    const group = getAllGroups().find(g => g.id === activeGroupId);
    if (!group) { return; }
    // Team groups are managed exclusively by the team system (start/stop in
    // the Teams tab). The sidebar must not inject terminals into a team —
    // doing so causes the terminal to receive the team's standing orders on
    // every prompt, making it believe it is a team member.
    if (group.teamGroup) { return; }
    if (group.source === 'manual') {
        if (!group.members) { group.members = []; }
        if (!group.members.includes(name)) { group.members.push(name); }
        if (Array.isArray(group.order) && !group.order.includes(name)) { group.order.push(name); }
    } else {
        if (!groupPrefs.extras) { groupPrefs.extras = {}; }
        if (!Array.isArray(groupPrefs.extras[activeGroupId])) { groupPrefs.extras[activeGroupId] = []; }
        if (!groupPrefs.extras[activeGroupId].includes(name)) { groupPrefs.extras[activeGroupId].push(name); }
    }
    saveLayoutSettings();
}
```

### 6. `src/webview/terminals.js` — Guard pane-unassign against team groups

In the pane-unassign handler (around line 4729-4741), add a guard for team groups:

```javascript
if (activeGroupId) {
    const group = getAllGroups().find(g => g.id === activeGroupId);
    if (group && !group.teamGroup) {  // ← NEW: skip team groups
        if (group.source !== 'manual' && groupPrefs.extras && Array.isArray(groupPrefs.extras[activeGroupId])) {
            groupPrefs.extras[activeGroupId] = groupPrefs.extras[activeGroupId].filter(n => n !== targetName);
        } else if (group.source === 'manual' && Array.isArray(group.members)) {
            group.members = group.members.filter(n => n !== targetName);
            if (Array.isArray(group.order)) {
                group.order = group.order.filter(n => n !== targetName);
            }
        }
    }
}
```

When the active group is a team group, the pane is vacated but the terminal remains in the team group's `members` array. The `saveLayoutSettings()` call at line 4742 still runs, but since the team group's members were not modified, the write is harmless.

### 7. `src/webview/terminals.js` — Guard `handleLockedTerminalClick` against team groups

> **Superseded:** Add to the active group first, then seat with keepLock. Team groups are excluded by `addTerminalToActiveGroup` — the call returns without modifying the group, so the terminal is seated without being added to the team.
> **Reason:** If `addTerminalToActiveGroup` returns early for team groups but `assignToFocusedPane(name, { keepLock: true })` still runs, the terminal is seated in a pane under the team group's lock WITHOUT being added to the group. The next `seatActiveGroupPage` reconcile would evict it (it's not a member). The terminal would appear briefly and then disappear — a visible flicker that reads as a bug.
> **Replaced with:** Check `isTeamGroup(activeGroupId)` before the add+seat path. If the active group is a team group, fall through to the existing lock-drop logic at line 2948+, which drops the lock and seats the terminal normally.

In `handleLockedTerminalClick` (line 2936-2943), revise the free-slot fill:

```javascript
if (hasFreeSlot) {
    const isMemberOfActive = group && group.id === activeGroupId;
    if (!isMemberOfActive) {
        // Team groups are managed exclusively by the team system.
        // Do not inject terminals into a team via sidebar clicks —
        // fall through to the lock-drop path below, which drops the
        // lock and seats the terminal normally.
        if (!isTeamGroup(activeGroupId)) {
            addTerminalToActiveGroup(name);
            assignToFocusedPane(name, { keepLock: true });
            return;
        }
    }
}
```

When the active group is a team group, the code falls through to the existing logic at line 2948+: if the terminal has no group, the lock is dropped and the terminal is seated; if it belongs to another group, the code switches to that group. The click is not dead.

### 8. `src/webview/terminals.js` — `reloadTerminalGroups` merge preserves `teamGroup` flag

No code change needed. The merge logic (terminals.js:1674-1687) updates `existing.members` and `existing.order` from the backend but does not touch other properties. Since the `teamGroup` flag is set on the existing object (by the client-side migration in step 3 or by the backend migration in step 2), it is preserved through the merge. The spread (`...existing`) in the backend upsert path (teamWiring.ts:1238) also preserves it.

### 9. `src/webview/terminals.js` — Visual indicator for team groups in the group tab strip (OPTIONAL)

In `renderGroupTabStrip` (terminals.js:3036-3081), add a visual indicator to team group tabs so the user can distinguish them from manual groups. For example, prepend a small icon or apply a distinct CSS class to the tab:

```javascript
for (const g of groups) {
    const isActive = g.id === activeGroupId;
    const tab = document.createElement('div');
    tab.className = 'group-tab' + (isActive ? ' active' : '') + (g.teamGroup ? ' team-group-tab' : '');
    tab.title = g.teamGroup ? `${g.name} (Team — managed in Teams tab)` : g.name;
    // ... rest of tab rendering
}
```

This is a UX enhancement, not required for the fix. It addresses the user's complaint that the behavior is "hidden in a way that a user does not expect." Ship the functional fix first; this can be a follow-up.

## Verification Plan

### Automated Tests
- Unit test for `migrateTeamGroupFlags`: verify it flags groups with `id.startsWith('team_')` and no `teamGroup` flag, leaves manual groups (`grp_` prefix) untouched, and returns `null` when already fully flagged (idempotent).
- Unit test for `migrateTerminalGroups` with the migration: verify that a `mutateTerminalGroups` call with a team group lacking the flag persists the flagged array.
- Unit test for `addTerminalToActiveGroup` guard: verify that calling it with a team group active does not modify `group.members`.
- Unit test for `handleLockedTerminalClick` fall-through: verify that clicking a non-member terminal with a free slot under a team group lock drops the lock and seats the terminal, rather than adding it to the group.

### Manual Verification
1. **Pre-condition**: Start a Coding team from the Teams tab. Confirm the team group appears in `terminals.groups` with `teamGroup: true`. Confirm the team's terminals receive the Coding team standing orders on every prompt.

2. **Injection prevention**: With the Coding team group active (its tab selected in the group tab strip), create a new terminal (e.g., a planner). Click it in the sidebar. Verify:
   - The terminal is NOT added to the team group's `members` array.
   - The terminal does NOT receive the Coding team standing orders on its next prompt.
   - The group lock is dropped and the terminal is seated normally (the click is not dead).

3. **Pane unassign**: With the Coding team group active, unassign a pane. Verify:
   - The terminal is NOT removed from the team group's `members` array.
   - The pane becomes empty but the terminal remains in the team group.
   - The terminal still receives the Coding team standing orders on its next prompt (it's still a member).

4. **Manual group still works**: Create a manual group via SAVE AS GROUP or multi-select + group. Add a terminal to it by clicking while the group is locked. Verify the terminal IS added to the manual group's `members` array (the guard only affects team groups).

5. **Migration**: On an existing install with team groups in the DB (from a previous session), verify that the migration adds `teamGroup: true` to team groups identified by `id.startsWith('team_')`. Verify that manual groups (id starts with `grp_`) are NOT flagged.

6. **Stale team group**: Start a Coding team, then close all its terminals. The team group persists in the DB. In a new session, verify the team group is loaded with `teamGroup: true` (client-side migration). Click a non-member terminal while the team group tab is active. Verify the terminal is NOT added to the team group and does NOT receive the team's standing orders.

7. **LINK UP unaffected**: Use the LINK UP modal in standing mode to create a pair-scoped standing order. Verify the pair-scoped order is created and applied correctly — the LINK UP modal does not modify group membership and is unaffected by this change.

8. **Delete team group still works**: With a stale team group in the sidebar, click the × delete button on its tab. Verify the team group is removed from `terminalGroups` and the sidebar. (Standing orders persist in a separate key — this is expected and noted as a separate cleanup concern.)

## Outstanding Questions
- **[user]** Should `deleteGroup` be guarded for team groups (preventing sidebar deletion of team groups), or is the current behavior (deletion allowed as a stale-group cleanup path) correct? — proceeding on the assumption that deletion is allowed, since stale team groups need a cleanup path and the Teams tab may not show teams with no live terminals.
