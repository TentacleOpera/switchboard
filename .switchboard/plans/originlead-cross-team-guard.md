# originLead cross-team guard — drop last-dispatch target when it's not on the reviewer's team

## Goal

When a reviewer is dispatched in delegation mode, the prompt names `reviewerOriginLead` as the terminal the reviewer should report to. `originLead` is resolved from `plausibleOriginTerminal(planRecord)`, which returns `record.dispatchedTerminal` — the terminal the card was last dispatched **TO**, not the team lead. When a card passed through `planner-1` for plan improvement before reaching CODE REVIEWED, `dispatchedTerminal = 'planner-1'`. The existing self-target guard only drops `originLead` when it equals the reviewer itself or the coder being delegated to. It never checks team membership, so a cross-team terminal like `planner-1` passes through and gets rendered into the prompt as the report-to target.

Add a cross-team membership guard: after resolving `originLead`, verify it shares a registered team with the reviewer (or is the reviewer's own team head). If it doesn't, drop it — the reviewer falls back to fix-itself mode (the conservative outcome already used for self-targeted leads).

### Problem analysis

**The bug chain:**

1. `agentPromptBuilder.ts:1827` — step 5 text renders `${reviewerOriginLead}` into the reviewer's prompt as the terminal to report to.
2. `TaskViewerProvider.ts:21556` (single-card) and `:6938` (batch) — `reviewerOriginLead` is filled from `originLead`.
3. `originLead` = `plausibleOriginTerminal(record)` → returns `record.dispatchedTerminal` — the last dispatch **target**.
4. `teamWiring.ts:1669` — that returns `record.dispatchedTerminal` directly.
5. These plan cards went through `planner-1` for plan improvement, so `dispatchedTerminal = 'planner-1'`.
6. The prompt rendered "report to planner-1" — a terminal on a different team with no context.

**The existing guard is too narrow.** `TaskViewerProvider.ts:21534` (single-card) and `:6931` (batch):

```ts
if (originLead && (originLead === targetAgent || originLead === reviewerCoderTerminal)) {
    originLead = undefined;
}
```

This covers self-target (reviewer or coder). It does NOT cover cross-team: any card whose last dispatch was a seat in another team renders a prompt telling the reviewer to report there.

**The machinery to fix it already exists, unused here.** `resolveTeamMembersForHead` (`teamWiring.ts:1799`) reads `terminals.groups` — the authoritative roster, head plus every child, including `scope: 'shared'` members invisible to `parentInstanceId` lookup. It is already imported and called in both dispatch paths (line 21506 and 6919) for coder resolution. The fix adds one more call to validate `originLead` team membership.

**Two affected paths, identical bug:**
- **Single-card dispatch** (`TaskViewerProvider.ts:21480-21536`): `originLead` resolved at 21483, guard at 21534.
- **Batch dispatch** (`TaskViewerProvider.ts:6897-6933`): `originLead` resolved at 6904, guard at 6931.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, reliability
**Project:** Browser Switchboard

## User Review Required

Yes — the plan supersedes the original two-pass guard approach with a single-helper design. The behavioral limitation (dropping a cross-team `originLead` also kills valid same-team coder delegation in the shared-reviewer case) is a conscious conservative trade-off; a follow-up enhancement could resolve the reviewer's actual team lead instead of dropping. Review whether that limitation is acceptable for this fix tier.

## Complexity Audit

### Routine
- Adding one exported helper function to `teamWiring.ts` that reuses the existing group-read + `rosterOf` pattern already used by `resolveTeamMembersForHead`.
- Inserting a single `if (originLead) { … }` guard block after the existing self-target guard in two dispatch paths (single-card and batch) — identical logic, different in-scope variable names.
- Importing the new helper in `TaskViewerProvider.ts` (the import line at 49 already pulls from `teamWiring`).
- Adding behavioral unit tests to the existing test file using mock groups.

### Complex / Risky
- The shared-reviewer edge case: a reviewer with `scope: 'shared'` membership in multiple teams. The membership check must scan ALL groups containing the reviewer, not just the first one `resolveTeamMembersForHead` returns (it returns the group the reviewer heads, or the first group in stored order that contains the reviewer). The helper handles this by iterating every group and checking co-membership.
- Known limitation: dropping `originLead` when it is cross-team also disables delegation mode (the `coder && originLead` gate at line 21555 / 6934), even when a valid same-team coder was resolved. This is the conservative outcome — acceptable for this complexity tier, documented as a follow-up enhancement opportunity.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The `terminals.groups` config is read once per guard invocation. A team spawned between the coder-resolution read (line 21506) and the guard read would be visible to the guard but not to the coder resolution. This is benign — the guard is more permissive with newer data (it might keep an `originLead` that the coder resolution didn't see), which is the conservative direction.
- No write occurs in this guard — it only reads config and conditionally clears a local variable. No lock needed.

**Security:**
- No new attack surface. The guard reads terminal group config (operator-controlled) and drops a prompt field. It cannot escalate or inject.

**Side Effects:**
- Dropping `originLead` changes the reviewer's dispatch from delegation mode to fix-itself mode. The reviewer will fix code directly instead of sending instructions to a coder. This is the intended conservative outcome for cross-team leads.
- **Known limitation:** In the shared-reviewer-as-member case, if the coder was resolved from `originLead`'s team (line 21509 / 6922) and `originLead` is then dropped as cross-team, the coder variable is set but unused (delegation mode is off because `originLead` is falsy at line 21555 / 6934). The reviewer falls to fix-itself despite having a valid coder. This is a behavioral regression for that specific combination (shared reviewer + card dispatched through a cross-team planner). It is safe (no incorrect delegation) but suboptimal. A follow-up enhancement could resolve the reviewer's actual team lead as the report-to target instead of dropping.

**Dependencies & Conflicts:**
- The new `terminalsShareTeam` helper depends on the same `TERMINALS_GROUPS_KEY` constant and `getConfigJson` / `settings.get` read path as `resolveTeamMembersForHead`. No new dependencies.
- The bare-key `terminals.groups` merge (teamWiring.ts:1816-1828) must be replicated in the helper — this is the merge that the original plan's inline mitigation missed. The helper reuses the identical merge logic.

## Dependencies

None — this is a standalone bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the shared-reviewer edge case requires scanning ALL groups, not just the first roster — the `terminalsShareTeam` helper handles this by iterating every group for co-membership; (2) dropping `originLead` kills delegation mode even when a valid same-team coder exists — a known conservative trade-off for this complexity tier; (3) the bare-key `terminals.groups` merge must be present in the helper or it will incorrectly drop valid cross-team leads. Mitigations: single helper with consistent `rosterOf` extraction and full bare-key merge; behavioral unit tests covering all four edge cases (cross-team drop, same-team keep, shared-reviewer multi-team keep, null-roster keep).

## Proposed Changes

### src/services/teamWiring.ts

**Context:** The membership-check logic belongs in `teamWiring.ts` — the module that owns `resolveTeamMembersForHead`, `rosterOf`, and the bare-key `terminals.groups` merge. The original plan's conclusion that no changes are needed here is superseded.

> **Superseded:** No changes. `resolveTeamMembersForHead` already does exactly what we need. The `TERMINALS_GROUPS_KEY` constant is already exported and imported in `TaskViewerProvider.ts`.
> **Reason:** `resolveTeamMembersForHead` returns only ONE roster (the group the origin heads, or the first group containing it). For a shared reviewer on multiple teams, this is insufficient — `originLead` might be on a different one of the reviewer's teams. The original plan's inline fallback in `TaskViewerProvider.ts` tried to cover this but missed the bare-key `terminals.groups` merge (teamWiring.ts:1816-1828) and used inconsistent roster extraction (`g.members.includes` vs `rosterOf` which prefers `g.order`). A single helper in the membership module eliminates both gaps.
> **Replaced with:** Add a new exported `terminalsShareTeam` helper that reads all groups (with the same bare-key merge as `resolveTeamMembersForHead`), extracts rosters consistently via `rosterOf`, and returns true if any group contains BOTH terminals.

**Logic:** Add the helper after `resolveTeamMembersForHead` (after line 1859). It reuses the same group-read + bare-key merge + `rosterOf` pattern. It returns `true` (don't drop) when data is unavailable or reads fail — the conservative direction that matches the existing null-roster behavior.

**Implementation:**

```ts
/**
 * Check whether two terminals share any registered team.
 *
 * Reads `terminals.groups` with the same bare-key merge as
 * `resolveTeamMembersForHead`, extracts rosters consistently via the same
 * `rosterOf` logic (prefers `order`, falls back to `members`), and returns
 * true if ANY group contains both `a` and `b`.
 *
 * Returns `true` (do NOT drop) when data is unavailable, reads fail, or no
 * groups exist — the conservative direction. The caller drops `originLead`
 * only when this returns `false`, i.e. there IS team data and the two
 * terminals are provably on no shared team.
 *
 * Use this instead of `resolveTeamMembersForHead` for cross-team membership
 * predicates: `resolveTeamMembersForHead` returns only one roster (the group
 * the origin heads, or the first containing it), which is insufficient for a
 * shared reviewer on multiple teams.
 */
export async function terminalsShareTeam(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    a: string;
    b: string;
}): Promise<boolean> {
    const { db, settings, a, b } = opts;
    if ((!db && !settings) || !a || !b || a === b) { return true; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return true; }
    if (!Array.isArray(groups) || groups.length === 0) { return true; }

    const rosterOf = (g: any): string[] => {
        const roster: any[] = Array.isArray(g?.order) && g.order.length
            ? g.order
            : (Array.isArray(g?.members) ? g.members : []);
        const names: string[] = [];
        for (const n of roster) {
            if (typeof n === 'string' && n.length > 0) { names.push(n); }
        }
        return names;
    };

    for (const g of groups) {
        const roster = new Set(rosterOf(g));
        if (roster.has(a) && roster.has(b)) { return true; }
    }
    return false;
}
```

**Edge Cases:**
- **Same terminal (`a === b`):** returns `true` — a terminal always shares a team with itself. The self-target guard (which runs before this check) already handles the case where `originLead === targetAgent`, so this is a defensive fallback.
- **No db and no settings:** returns `true` — cannot determine team membership, don't drop (conservative, backward-compat for standalone reviewers).
- **Read failure:** returns `true` — same conservative direction.
- **No groups registered:** returns `true` — standalone reviewer with no team, keep `originLead` (the existing self-target guard is the only gate).
- **Shared reviewer on multiple teams:** iterates ALL groups, returns `true` if any group contains both — handles the case `resolveTeamMembersForHead` misses.
- **Bare-key groups:** merged into the group list before checking — matches `resolveTeamMembersForHead` behavior.

### src/services/TaskViewerProvider.ts

**Context:** Two dispatch paths have the identical bug. Both already import `resolveTeamMembersForHead` and `TERMINALS_GROUPS_KEY` from `teamWiring` (line 49). The new `terminalsShareTeam` helper is added to that same import.

> **Superseded:** Two-pass guard — use `resolveTeamMembersForHead` for the single-team fast path, then inline-read `TERMINALS_GROUPS_KEY` to check all groups for the shared-reviewer case.
> **Reason:** The inline fallback missed the bare-key `terminals.groups` merge (teamWiring.ts:1816-1828) and used inconsistent roster extraction (`g.members.includes` vs `rosterOf` which prefers `g.order`). This could incorrectly drop a valid `originLead` when it was on a bare-key group or listed in `order` but not `members`.
> **Replaced with:** A single `terminalsShareTeam` call that reads all groups once with full bare-key merge and consistent `rosterOf` extraction, checking co-membership across every group.

**Logic:** After the existing self-target guard, add a single cross-team check using `terminalsShareTeam`. If the reviewer and `originLead` share no team, drop `originLead`. The `coder && originLead` gate below then falls the reviewer back to fix-itself.

**Implementation — Single-card path (~line 21534):**

Add `terminalsShareTeam` to the import at line 49:

```ts
import { wireSpawnedTeam, findTeamForHeadRoleInRoots, startTeamById, loadEffectiveStandingOrders, resolveTeamScopedRoleTerminal, resolveTeamMembersForHead, terminalsShareTeam, plausibleOriginTerminal, listTeamsInRoots, resolveTeamByIdInRoots, TERMINALS_GROUPS_KEY, type TerminalGroupsSettingsAccessor } from './teamWiring';
```

After the existing self-target guard (line 21536):

```ts
// Self-target guard (existing, unchanged):
if (originLead && (originLead === targetAgent || originLead === reviewerCoderTerminal)) {
    originLead = undefined;
}
// Cross-team guard (new): originLead is the last dispatch TARGET, not
// necessarily a member of the reviewer's team. A card that passed through
// planner-1 for plan improvement has dispatchedTerminal = 'planner-1';
// without this check the prompt would tell the reviewer to report to a
// terminal on another team. terminalsShareTeam reads all registered groups
// (with the same bare-key merge as resolveTeamMembersForHead) and checks
// whether the reviewer and originLead appear together in ANY group —
// handling shared reviewers on multiple teams. If they share no team, drop
// originLead; the coder && originLead gate below falls back to fix-itself
// (the conservative outcome).
if (originLead) {
    const sharesTeam = await terminalsShareTeam({ db: coderDb, a: targetAgent, b: originLead });
    if (!sharesTeam) {
        originLead = undefined;
    }
}
```

**Implementation — Batch path (~line 6931):**

After the existing self-target guard (line 6933):

```ts
// Self-target guard (existing, unchanged):
if (originLead && (originLead === group.targetAgent || originLead === coder)) {
    originLead = undefined;
}
// Cross-team guard (new):
if (originLead) {
    const sharesTeam = await terminalsShareTeam({ db, a: group.targetAgent, b: originLead });
    if (!sharesTeam) {
        originLead = undefined;
    }
}
```

**Why `terminalsShareTeam` and not `resolveTeamMembersForHead`:** `resolveTeamMembersForHead` returns only ONE roster — the group the origin heads, or the first group in stored order that contains it. For a shared reviewer on multiple teams, `originLead` might be on a different one of those teams, and the single-roster check would incorrectly drop it. `terminalsShareTeam` scans ALL groups and returns true if any group contains both terminals — the correct membership predicate for the shared-reviewer case.

**Why `terminalsShareTeam` and not `resolveTeamScopedRoleTerminal`:** The question is membership, not role resolution. `resolveTeamScopedRoleTerminal` resolves a specific role within a team — wrong tool for a membership predicate.

### src/test/team-scoped-role-routing.test.js

**Context:** The existing test file imports from `out/services/teamWiring` (line 24-25) and reads source files as text for structural assertions. The new `terminalsShareTeam` helper is a pure function over `(db, groups)` — testable with a mock db that returns canned group config.

**Logic:** Add `terminalsShareTeam` to the import from `out/services/teamWiring`. Add behavioral unit tests (not structural assertions) that call the helper with a mock db and verify the drop/keep decision.

**Implementation:**

Update the import (line 24-25):

```js
const { resolveTeamScopedRoleTerminal, plausibleOriginTerminal, terminalsShareTeam } =
    require('../../out/services/teamWiring');
```

Add a mock db helper and four test cases:

```js
function mockDb(groups) {
    return {
        async getConfigJson(key, fallback) {
            if (key === 'switchboard.prompts.terminals.groups' || key === 'terminals.groups') {
                return groups;
            }
            return fallback;
        }
    };
}

// Item 10: Cross-team guard — terminalsShareTeam

test('terminalsShareTeam: cross-team originLead is dropped (no shared group)', async () => {
    const groups = [
        { id: 'team_lead-1', head: 'lead-1', members: ['lead-1', 'coder-1', 'Coding-reviewer'], order: ['lead-1', 'coder-1', 'Coding-reviewer'] },
        { id: 'team_lead-2', head: 'lead-2', members: ['lead-2', 'coder-2', 'Backend-reviewer'], order: ['lead-2', 'coder-2', 'Backend-reviewer'] },
    ];
    const db = mockDb(groups);
    // reviewer = Coding-reviewer (team 1), originLead = planner-1 (no team)
    const shares = await terminalsShareTeam({ db, a: 'Coding-reviewer', b: 'planner-1' });
    assert.strictEqual(shares, false, 'planner-1 is not on any team with Coding-reviewer');
});

test('terminalsShareTeam: same-team originLead is kept', async () => {
    const groups = [
        { id: 'team_lead-1', head: 'lead-1', members: ['lead-1', 'coder-1', 'Coding-reviewer'], order: ['lead-1', 'coder-1', 'Coding-reviewer'] },
    ];
    const db = mockDb(groups);
    const shares = await terminalsShareTeam({ db, a: 'Coding-reviewer', b: 'lead-1' });
    assert.strictEqual(shares, true, 'lead-1 is on the same team as Coding-reviewer');
});

test('terminalsShareTeam: shared reviewer across teams — originLead on a different shared team is kept', async () => {
    const groups = [
        { id: 'team_lead-1', head: 'lead-1', members: ['lead-1', 'coder-1', 'Shared-reviewer'], order: ['lead-1', 'coder-1', 'Shared-reviewer'] },
        { id: 'team_lead-2', head: 'lead-2', members: ['lead-2', 'coder-2', 'Shared-reviewer'], order: ['lead-2', 'coder-2', 'Shared-reviewer'] },
    ];
    const db = mockDb(groups);
    // Shared-reviewer is on both teams; originLead = lead-2 is on team 2.
    // resolveTeamMembersForHead would return team 1's roster (first containing
    // the reviewer), which doesn't include lead-2. terminalsShareTeam scans
    // all groups and finds them together on team 2.
    const shares = await terminalsShareTeam({ db, a: 'Shared-reviewer', b: 'lead-2' });
    assert.strictEqual(shares, true, 'lead-2 shares team 2 with Shared-reviewer');
});

test('terminalsShareTeam: null roster (no groups) — originLead is kept', async () => {
    const db = mockDb([]);
    const shares = await terminalsShareTeam({ db, a: 'Standalone-reviewer', b: 'planner-1' });
    assert.strictEqual(shares, true, 'no groups registered — conservative keep');
});

test('terminalsShareTeam: bare-key group merge — originLead on a bare-key group is kept', async () => {
    // Group registered under bare key 'terminals.groups' only, not under
    // TERMINALS_GROUPS_KEY. The helper must merge bare-key groups before
    // checking (matching resolveTeamMembersForHead behavior).
    const db = {
        async getConfigJson(key, fallback) {
            if (key === 'switchboard.prompts.terminals.groups') { return []; }
            if (key === 'terminals.groups') {
                return [{ id: 'team_lead-1', head: 'lead-1', members: ['lead-1', 'coder-1', 'Coding-reviewer'], order: ['lead-1', 'coder-1', 'Coding-reviewer'] }];
            }
            return fallback;
        }
    };
    const shares = await terminalsShareTeam({ db, a: 'Coding-reviewer', b: 'lead-1' });
    assert.strictEqual(shares, true, 'bare-key group should be merged and found');
});
```

**Edge Cases covered by tests:**
1. Cross-team `originLead` dropped (no shared group).
2. Same-team `originLead` kept.
3. Shared reviewer on multiple teams — `originLead` on a different shared team kept (the case `resolveTeamMembersForHead` misses).
4. Null roster (no groups) — `originLead` kept (backward compat).
5. Bare-key group merge — `originLead` on a bare-key-only group kept (the gap the original plan's inline mitigation had).

## Verification Plan

### Automated Tests
1. `npm run compile-tests` — compile succeeds (SKIP: not executed this run per session directive).
2. `node src/test/team-scoped-role-routing.test.js` — all existing tests pass plus the new `terminalsShareTeam` tests (SKIP: not executed this run per session directive).
3. **Manual / live-extension:** Start a Coding team, run a plan through `planner-1` for improvement, then advance the card to CODE REVIEWED. Verify the reviewer's prompt does NOT name `planner-1` as the report-to target. Verify it either names the correct team lead (if on the same team) or falls back to fix-itself mode.
4. **Regression:** A card that went through the team's own lead (not `planner-1`) still gets delegation mode with the correct `originLead` — no behavior change for the normal flow.
5. **Shared-reviewer regression:** A shared reviewer on multiple teams where `originLead` is on one of those teams — delegation mode is preserved (not incorrectly dropped).

## Outstanding Questions
- **[user]** Should a cross-team `originLead` be dropped entirely (conservative — kills delegation, reviewer fixes itself) or replaced with the reviewer's actual team lead (preserves delegation but adds resolution complexity)? — proceeding on the assumption that dropping is correct for this complexity tier (3), and resolving the actual lead is a follow-up enhancement.
