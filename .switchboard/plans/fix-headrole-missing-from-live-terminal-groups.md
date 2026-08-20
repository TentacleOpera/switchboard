# Fix headRole Missing From Live Terminal Groups

## Goal

`resolveCodingRolesFromGroups` and `_resolveTeamRosterForPrompt` filter on `g.headRole === 'lead'` to find the coding team, but `wireSpawnedTeam` never writes `headRole` into the live group object it persists to `switchboard.prompts.terminals.groups`. The field exists only in `terminals.agentGroups` (the team *definitions*), not in the live groups key. Every group is skipped, both resolvers return empty/null, and six downstream consumers have been silently broken since the V60 migration:

1. **Run-queue button** — `codingHeadLive` is always `false`, button always disabled
2. **`runQueue` handler** — always errors "No coding head is live"
3. **Queue watch arming** (`onArmQueueWatch`, `stageForQueue`) — arms with `null` head, sweep's gate fires every time
4. **`extension.ts` queue head resolver** — returns `null`, sweep notifies "no head seated"
5. **`TaskViewerProvider` autoban dispatch** — falls through to the deprecated `state.json` path every time (the comment at line 13025 says this MUST NOT happen for pty-fleet teams)
6. **Drive-mode enriched prompt** (`_buildDrivePrefix`) — always falls back to the static `DRIVE_FEATURE_PREFIX` pointer, so the lead re-discovers everything from scratch (the exact behaviour the drive-mode-prompt-overhaul feature was supposed to eliminate)

### Root Cause

`wireSpawnedTeam` (teamWiring.ts:1371) writes the group object as:

```typescript
const group = {
    id: groupId,
    name: headName,
    source: 'manual' as const,
    teamGroup: true,
    layout,
    members: groupMembers,
    order: groupMembers,
    externalHead,
};
```

No `headRole` field. The `headRole: 'lead'` lives in `terminals.agentGroups` (written by the TEAMS tab / `migrateAgentGroups` / `importDelegatesIntoTeams`), which is a separate config key with a different data shape (member *definitions* `{role, count}`, not live terminal names).

Both `resolveCodingRolesFromGroups` (line 5197) and `_resolveTeamRosterForPrompt` (line 5286) read from `TERMINALS_GROUPS_KEY` and filter on `g.headRole`:

```typescript
if (!g || !g.headRole || !g.name) continue;  // headRole always undefined → always skipped
```

This has been broken since `wireSpawnedTeam` was first introduced (commit `1bd39f4a`). The drive-mode-prompt-overhaul plan inherited the bug by saying "same path as `resolveCodingRolesFromGroups`" without verifying that the path carries the field it filters on.

## Metadata

**Complexity:** 3
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

No user decision needed — the design is fully specified from the codebase and the data shapes are verified.

## Complexity Audit

### Routine
- Adding `headRole` to the group object in `wireSpawnedTeam` (1 line)
- Adding `headRole` to the upsert merge path in `wireSpawnedTeam` (1 line)
- Adding `headRole?: string` to `WireSpawnedTeamOptions` (1 line)
- Passing `group.headRole` from the two live call sites in `agentGroupInstantiation.ts` (2 lines)
- Adding a cross-reference helper that reads `terminals.agentGroups` to fill in `headRole` for groups that lack it (~15 lines)
- Calling the helper from two read sites in `KanbanProvider.ts` (2 lines)
- Writing a contract test that pins the persisted group shape field-for-field (~40 lines)

### Complex / Risky
- **The cross-reference must not change the group object in the DB** — it fills `headRole` in-memory only, at read time. Writing it back would be a migration, which is unnecessary (the write-path fix — both the initial create and the upsert merge — stops creating new groups that lack it, and permanently fixes pre-fix groups on re-wire) and risky (a read-path write reopens the read-modify-write window `mutateTerminalGroups` was built to serialize).
- **`codingHeadLive` flipping from always-false to actually-true** — six downstream consumers have been receiving `false`/`null` since V60. The regression audit (below) confirms every consumer has the correct intended behavior coded; it just never executed. No consumer adapted around the broken state.

## Edge-Case & Dependency Audit

**Race Conditions:** The cross-reference helper reads `terminals.agentGroups` (a separate config key) alongside `TERMINALS_GROUPS_KEY`. Both are read-only at this point — no write race. The `agentGroups` key is written by the TEAMS tab save path (`saveTerminalGroupsGuarded`), which is serialized through `_groupsWriteChain`. A read during a write sees either the old or new array, never a partial — `getConfigJson` returns a parsed clone.

**Security:** No new attack surface. The cross-reference reads a config key that is already read by `findTeamForHeadRole` (teamWiring.ts:897) on the same code path.

**Side Effects:** Fixing `resolveCodingRolesFromGroups` unblocks six downstream consumers simultaneously. The audit below confirms none regress.

**Dependencies & Conflicts:** No dependency on other plans. The drive-mode-prompt-overhaul feature is already committed; this fix makes its enriched-prompt path actually fire instead of always falling back.

## Downstream Regression Audit

Every consumer of `resolveCodingRolesFromGroups` / `resolveCodingHeadFromGroups` was traced. None adapted around the broken state — all have the correct intended behavior coded, just never executed.

| # | Site | File:Line | Broken behavior | Fixed behavior | Regression risk |
|---|------|-----------|----------------|----------------|-----------------|
| 1-4 | Board state push (4 sites) | KanbanProvider.ts:1285, 2288, 4004, 4207 | `codingHeadLive = false` → Run-queue button always disabled | `codingHeadLive = true` when team seated → button enables | **None** — button was designed for this. Dead, not adapted. |
| 5 | `runQueue` handler | KanbanProvider.ts:11889 | Always errors "No coding head is live" | Dispatches via `dispatchNextFromQueue` | **None** — this is the feature's purpose. Has its own null-guard. |
| 6 | `onArmQueueWatch` | KanbanProvider.ts:2609 | Arms with `null` → sweep gate fires | Arms with real head → sweep proceeds | **None** — intended behavior. |
| 7 | `stageForQueue` | KanbanProvider.ts:8020 | Same as #6 | Same as #6 | **None** |
| 8 | `extension.ts` queue head resolver | extension.ts:1107 | Returns `null` → sweep notifies "no head" | Returns real head → sweep runs | **None** |
| 9 | **`TaskViewerProvider` autoban** | TaskViewerProvider.ts:13036 | Falls through to `getAliveRoleTerminalNames` (deprecated `state.json` path) every time | Uses groups resolver; fallback only for non-team terminals | **None** — the comment at line 13025 explicitly says the groups path is the correct one and the `state.json` path is the inferior fallback. The fix makes it use the intended path. |

**Key finding:** The `TaskViewerProvider` autoban path (site #9) is the only consumer with a fallback. The comment documents that the groups path is correct and `getAliveRoleTerminalNames` is the edge-case fallback for "editor-registered terminals that were never wired into a team group." After the fix, team-wired terminals use the groups path (correct), and non-team terminals still use the fallback (no change). The two paths return the same terminal names for the same team — the groups path reads from `terminals.groups` (written by `wireSpawnedTeam`) and checks liveness via `getFleetLiveness()`, the same liveness source the sweep uses.

## Adversarial Synthesis

Key risks: (1) the cross-reference could match the wrong agent group when multiple teams share a name — mitigated by matching on `group.id` first (the team id is deterministic: `team_<encoded head name>`), then falling back to name; (2) a group in `TERMINALS_GROUPS_KEY` with no corresponding entry in `terminals.agentGroups` (orphaned after a team definition was deleted) — mitigated by defaulting to `'lead'` when no match is found, since `wireSpawnedTeam` is only called for team groups and the head role is `'lead'` for all coding teams; (3) the write-path fix doesn't help existing installs whose groups were already written without `headRole` — mitigated by the read-path cross-reference, which fills it in at read time for all existing groups, AND by the upsert merge path fix, which permanently writes `headRole` when a pre-fix team is re-wired; (4) the contract test could be too narrow and miss a future field omission — mitigated by pinning the full persisted literal field-for-field, not just `headRole`; (5) the upsert merge path was initially missed in the plan — the `...existing` spread carries `headRole` only if the existing group already had it, so a pre-fix group being re-wired would still lose it without the explicit `headRole` field in the merge — mitigated by adding `headRole: opts.headRole || 'lead'` to the merge path (Part 1, step 3).

## Proposed Changes

### `src/services/teamWiring.ts` — Part 1: Write `headRole` into the live group object (both create and upsert paths)

**Context:** `wireSpawnedTeam` at line 1371 constructs the group object persisted to `TERMINALS_GROUPS_KEY`. It omits `headRole`. The upsert merge path at line 1392-1405 also omits it — when a team is re-wired, the merged object spreads `...existing` (which lacks `headRole` for pre-fix groups) and does not add it explicitly.

**Logic:** Add `headRole` to both the initial group object and the upsert merge path, and to `WireSpawnedTeamOptions`, so new teams carry it natively and re-wired pre-fix teams get it permanently. Default to `'lead'` — `wireSpawnedTeam` is only called for team groups, and every coding team's head role is `'lead'`.

**Implementation:**

1. Add `headRole?: string` to `WireSpawnedTeamOptions` (after `externalHead?: boolean` at line 1150):

```typescript
    /**
     * The head's role ('lead', 'planner', 'reviewer', etc.). Persisted into the
     * live group object so readers like resolveCodingRolesFromGroups can filter
     * on it without cross-referencing terminals.agentGroups. Defaults to 'lead'
     * — wireSpawnedTeam is only called for team groups, and every coding team's
     * head role is 'lead'.
     */
    headRole?: string;
```

2. Add `headRole` to the group object at line 1371:

```typescript
    const group = {
        id: groupId,
        name: headName,
        headRole: opts.headRole || 'lead',
        source: 'manual' as const,
        teamGroup: true,
        layout,
        members: groupMembers,
        order: groupMembers,
        externalHead,
    };
```

3. Add `headRole` to the **upsert merge path** at line 1392-1405. When a team is re-wired (re-started), `wireSpawnedTeam` upserts: if the group already exists, it merges into the existing object. The merge path spreads `...existing` then overrides explicit fields — but `headRole` is not in the explicit field list. A pre-fix group being re-wired would still lose `headRole` in the DB, making the write-path fix incomplete and the claim "stops creating new groups that need the cross-reference" false for the re-wire case.

```typescript
            const merged = (existing && typeof existing === 'object')
                ? {
                    ...existing,
                    id: groupId,
                    name: headName,
                    headRole: opts.headRole || 'lead',
                    source: 'manual' as const,
                    teamGroup: true,
                    layout: (typeof existing.layout === 'string' && TERMINALS_LAYOUT_MODES.has(existing.layout))
                        ? existing.layout
                        : layout,
                    members: groupMembers,
                    order: groupMembers,
                    externalHead,
                }
                : group;
```

This ensures both the new-group path (`group`) and the re-wire path (`merged`) persist `headRole`. A re-wired pre-fix group gets `headRole` written permanently — the read-path cross-reference then becomes a no-op for that group on the next read.

### `src/services/agentGroupInstantiation.ts` — Part 2: Pass `headRole` from both call sites

**Context:** `instantiateAgentGroupCore` has `group` (the full agent group definition from `terminals.agentGroups`) in scope. `group.headRole` is already read at line 109 (`role: group?.headRole || 'lead'`). The two `wireSpawnedTeam` calls at lines 136 and 395 do not pass it.

**Implementation:**

1. Line 136 — add `headRole: group?.headRole`:

```typescript
    const wired = await wireSpawnedTeam({ db, settings: opts.settings, headName, children: workers, members: Array.isArray(group?.members) ? group.members : undefined, prompt: group?.prompt, headPrompt: group?.headPrompt, headRole: group?.headRole });
```

2. Line 395 (external-headed team path) — add `headRole: group?.headRole`:

```typescript
    const wired = await wireSpawnedTeam({
        db,
        settings: opts.settings,
        headName,
        children: workers,
        members: Array.isArray(group?.members) ? group.members : undefined,
        prompt: group?.prompt,
        headRole: group?.headRole,
        teamId,
        externalHead: true,
        regenerateHeadPrompt: async ({ groupId, memberNames }) => {
```

**Note on dead call sites:** The `wireSpawnedTeam` calls in `bootstrap.ts:1439` and `TaskViewerProvider.ts:3062` are dead code on the raw-create path — `payload.delegates` is cleared to `[]` at `bootstrap.ts:1410` and `TaskViewerProvider.ts:2913`, so `result.delegates.length > 0` is always false and the wiring branch never executes. No change needed at those sites. If they ever become live again, the `headRole` default of `'lead'` in `wireSpawnedTeam` covers them.

### `src/services/KanbanProvider.ts` — Part 3: Cross-reference `terminals.agentGroups` at read time for existing groups

**Context:** `resolveCodingRolesFromGroups` (line 5159) and `_resolveTeamRosterForPrompt` (line 5248) both read `TERMINALS_GROUPS_KEY` and filter on `g.headRole`. Existing groups in ~4,000 installs were written without `headRole` and will never be re-written by `wireSpawnedTeam` unless the team is re-started. A read-time cross-reference fills the gap.

**Logic:** Add a private helper `_resolveHeadRoleForGroups` that builds a `Map<groupId, headRole>` from `terminals.agentGroups`, then patches each group in-memory with `headRole` if it's missing. Call it from both read sites before the `headRole` filter. The helper does NOT write back to the DB — it fills the field in-memory only.

**Implementation:**

```typescript
    /**
     * Cross-reference terminals.agentGroups to fill in headRole for live
     * groups that were written without it (pre-fix installs). Patches the
     * groups array in-memory only — never writes back. The agentGroups key
     * carries headRole in the team definition; the live groups key
     * (TERMINALS_GROUPS_KEY) did not until the write-path fix landed.
     */
    private async _resolveHeadRoleForGroups(workspaceRoot: string, groups: any[]): Promise<any[]> {
        if (!Array.isArray(groups) || groups.length === 0) return groups;
        // If every group already has headRole, no cross-reference needed.
        if (groups.every(g => g && g.headRole)) return groups;
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (!db || !(await db.ensureReady())) return groups;
            const agentGroups = await db.getConfigJson<any[]>('terminals.agentGroups', []) as any[];
            if (!Array.isArray(agentGroups) || agentGroups.length === 0) {
                // No agent groups to cross-reference — default to 'lead' for
                // team groups (wireSpawnedTeam is only called for teams, and
                // every coding team's head role is 'lead').
                return groups.map(g => (g && !g.headRole && g.teamGroup) ? { ...g, headRole: 'lead' } : g);
            }
            // Build id → headRole and name → headRole maps.
            const byId = new Map<string, string>();
            const byName = new Map<string, string>();
            for (const ag of agentGroups) {
                if (ag && ag.headRole) {
                    if (ag.id) byId.set(String(ag.id), String(ag.headRole));
                    if (ag.name) byName.set(String(ag.name), String(ag.headRole));
                }
            }
            return groups.map(g => {
                if (!g || g.headRole) return g;
                // Match by group id first (deterministic), then by name.
                const role = (g.id && byId.get(String(g.id))) || (g.name && byName.get(String(g.name))) || 'lead';
                return { ...g, headRole: role };
            });
        } catch {
            // Best effort — default to 'lead' for team groups.
            return groups.map(g => (g && !g.headRole && g.teamGroup) ? { ...g, headRole: 'lead' } : g);
        }
    }
```

**Call site 1 — `resolveCodingRolesFromGroups` (line 5182):**

After the groups array is assembled (after the bare-key fallback merge at line 5180), before the `if (!Array.isArray(groups) || groups.length === 0)` check at line 5182, insert:

```typescript
            // Fill in headRole for groups written without it (pre-fix installs).
            groups = await this._resolveHeadRoleForGroups(workspaceRoot, groups);
```

**Call site 2 — `_resolveTeamRosterForPrompt` (line 5271):**

After the groups array is assembled (after the bare-key fallback merge at line 5269), before the `if (!Array.isArray(groups) || groups.length === 0)` check at line 5271, insert:

```typescript
            // Fill in headRole for groups written without it (pre-fix installs).
            groups = await this._resolveHeadRoleForGroups(workspaceRoot, groups);
```

### `src/test/terminal-groups-headrole-contract.test.js` — Part 4: Contract test

**Purpose:** Pin `wireSpawnedTeam`'s persisted group literal field-for-field, so the next reader that filters on a field the writer doesn't persist fails at the gate, not at manual test time. Also verify the read-path cross-reference fills `headRole` for groups that lack it.

**Tests:**

1. **`wireSpawnedTeam` persists headRole in the live group** — call `wireSpawnedTeam` with `headRole: 'lead'`, read back the group from `TERMINALS_GROUPS_KEY`, assert `group.headRole === 'lead'`.

2. **`wireSpawnedTeam` defaults headRole to 'lead' when not passed** — call without `headRole`, assert the persisted group has `headRole === 'lead'`.

3. **Persisted group literal is field-for-field complete** — call `wireSpawnedTeam` with full options, read back the group, assert the exact set of keys: `id`, `name`, `headRole`, `source`, `teamGroup`, `layout`, `members`, `order`, `externalHead`. No more, no less. This is the gate: if a future writer adds or drops a field, this test fails.

4. **External-headed team excludes head from members but persists headRole** — call with `externalHead: true`, assert `group.headRole` is present, `group.members` excludes the head name.

5. **Re-wire (upsert) preserves headRole in the merged group** — pre-populate `TERMINALS_GROUPS_KEY` with a group that has NO `headRole` (simulating a pre-fix install), call `wireSpawnedTeam` a second time for the same team id, read back the group, assert `group.headRole === 'lead'` (the merge path wrote it permanently, not just the initial create path).

6. **resolveCodingRolesFromGroups finds a lead when headRole is missing from the live group** — pre-populate `TERMINALS_GROUPS_KEY` with a group that has `teamGroup: true` but NO `headRole`, pre-populate `terminals.agentGroups` with a matching definition carrying `headRole: 'lead'`, call `resolveCodingRolesFromGroups`, assert `leads` is non-empty.

7. **resolveCodingRolesFromGroups defaults to 'lead' when agentGroups is also missing** — pre-populate `TERMINALS_GROUPS_KEY` with a `teamGroup: true` group with no `headRole`, leave `terminals.agentGroups` empty, call `resolveCodingRolesFromGroups`, assert `leads` is non-empty (defaulted to 'lead').

8. **_resolveTeamRosterForPrompt finds the team when headRole is missing from the live group** — same setup as test 6, call `_resolveTeamRosterForPrompt` (via the drive-mode prefix builder or directly), assert the roster is non-null.

## Verification Plan

### Automated Tests
- Run the new contract test: `node src/test/terminal-groups-headrole-contract.test.js`
- Run existing group tests: `node src/test/terminal-groups-key-unification-contract.test.js`
- Run existing standing-orders tests: `node src/test/standing-orders-marker-contract.test.js`
- Run existing team tests: `node src/test/team-autostart-workspace-scope.test.js`
- Run existing external-headed team tests: `node src/test/external-headed-team-contract.test.js`

### Manual
1. With a Coding team seated (head + coders live), verify the Run-queue button is enabled in the Dispatch view
2. Press Run-queue — verify it dispatches the first card (not "No coding head is live")
3. Enable Drive mode on a feature, dispatch to the lead — verify the prompt contains the team roster, plan IDs, and API port (not the static "Read and follow .agents/skills/terminal-coder-dispatch/SKILL.md" pointer)
4. Verify the autoban sweep dispatches through the groups path (not the `state.json` fallback) — check that the head terminal name matches the team group's head name

### Edge cases
- Group in `TERMINALS_GROUPS_KEY` with no matching entry in `terminals.agentGroups` → defaults to `headRole: 'lead'`
- `terminals.agentGroups` key absent entirely → defaults to `headRole: 'lead'` for team groups
- Multiple teams with the same name → matched by `group.id` first (deterministic `team_<encoded head name>`)
- Non-team groups (no `teamGroup: true`) → not defaulted (they're not teams, `headRole` is irrelevant)
- External-headed team → `headRole` persisted, head excluded from members (existing behavior, now with `headRole`)
- Pre-fix group re-wired (team re-started) → upsert merge path writes `headRole` permanently, not just in-memory cross-reference

## Dependencies & Sequencing

- Part 1 (write path — both initial create and upsert merge) and Part 3 (read path) are independent — Part 3 fixes existing installs at read time, Part 1 stops creating new groups that need the cross-reference AND permanently fixes pre-fix groups when they are re-wired.
- Part 2 (pass `headRole` from call sites) depends on Part 1 (the option must exist on `WireSpawnedTeamOptions`).
- Part 4 (contract test) depends on Parts 1-3.
- Recommended order: Part 1 → Part 2 → Part 3 → Part 4. All four in one commit.

## Completion Summary

Implemented all four parts. `wireSpawnedTeam` now persists `headRole` (defaulting to `'lead'`) into the live group object on both the initial-create and upsert-merge paths, with `headRole?: string` added to `WireSpawnedTeamOptions`. Both live call sites in `agentGroupInstantiation.ts` (internal-headed line 136 and external-headed line 395) now pass `group?.headRole`. Added `_resolveHeadRoleForGroups` private helper to `KanbanProvider.ts` that cross-references `terminals.agentGroups` at read time to fill `headRole` in-memory for pre-fix groups, called from both `resolveCodingRolesFromGroups` and `_resolveTeamRosterForPrompt` before the `headRole` filter. Wrote `src/test/terminal-groups-headrole-contract.test.js` (8 tests covering write-path persistence, default, field-for-field key set, external-headed exclusion, upsert preservation, and both read-path cross-reference scenarios) and registered the `test:contract:terminal-groups-headrole` npm script. No issues encountered; compilation and tests were skipped per run directives.

## Review Findings

Reviewed `src/services/teamWiring.ts`, `src/services/agentGroupInstantiation.ts`, `src/services/KanbanProvider.ts`, `src/test/terminal-groups-headrole-contract.test.js`, `package.json`, and `.github/workflows/integration-tests.yml`. Fixed the legacy resolver so only `teamGroup` rows can receive the fallback `lead` role, added a non-team regression assertion, made the test teardown deterministic, and wired the new contract script into CI. `npm run compile-tests`, all five automated checks named above, targeted ESLint, and `git diff --check` passed; ESLint reported only existing warnings and no errors. Remaining risk is limited to manual live-fleet UI/dispatch validation, which was not reproducible in this headless reviewer pass.
