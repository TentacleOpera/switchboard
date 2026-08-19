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

## Implementation

### src/services/TaskViewerProvider.ts

**Single-card path (~line 21534):** After the existing self-target guard, add a cross-team membership check. The `coderDb` and `targetAgent` are already in scope. Use `resolveTeamMembersForHead` to get the reviewer's team roster, then check whether `originLead` is in that roster. If not, drop `originLead`.

```ts
// Self-target guard (existing, unchanged):
if (originLead && (originLead === targetAgent || originLead === reviewerCoderTerminal)) {
    originLead = undefined;
}
// Cross-team guard (new): originLead is the last dispatch TARGET, not
// necessarily a member of the reviewer's team. A card that passed through
// planner-1 for plan improvement has dispatchedTerminal = 'planner-1';
// without this check the prompt would tell the reviewer to report to a
// terminal on another team. resolveTeamMembersForHead reads the
// authoritative roster from terminals.groups — the same source the coder
// resolution above already uses. If originLead is not on the reviewer's
// team, drop it; the coder && originLead guard below falls back to
// fix-itself (the conservative outcome).
if (originLead) {
    const reviewerRoster = await resolveTeamMembersForHead({ db: coderDb, originName: targetAgent });
    if (reviewerRoster && !reviewerRoster.includes(originLead)) {
        originLead = undefined;
    }
}
```

**Batch path (~line 6931):** Same guard, same logic. `db` and `group.targetAgent` are already in scope.

```ts
// Self-target guard (existing, unchanged):
if (originLead && (originLead === group.targetAgent || originLead === coder)) {
    originLead = undefined;
}
// Cross-team guard (new):
if (originLead) {
    const reviewerRoster = await resolveTeamMembersForHead({ db, originName: group.targetAgent });
    if (reviewerRoster && !reviewerRoster.includes(originLead)) {
        originLead = undefined;
    }
}
```

**Why `resolveTeamMembersForHead` and not `resolveTeamScopedRoleTerminal`:** The question is membership, not role resolution. `resolveTeamMembersForHead` returns the full roster (head + all members) for the team the reviewer belongs to. We just need to check whether `originLead` is in that list. `resolveTeamScopedRoleTerminal` resolves a specific role within a team — wrong tool for a membership predicate.

**Edge case — `resolveTeamMembersForHead` returns null:** This happens when the reviewer heads no team and is not a member of any group (standalone reviewer, or a gallery-only team that was never spawned). In that case, `reviewerRoster` is null, the `if (reviewerRoster && ...)` guard short-circuits, and `originLead` is kept. This is correct: with no team roster to check against, we cannot determine cross-team status, and the existing self-target guard plus the `coder && originLead` defensive guard are the only gates. This preserves backward compatibility for standalone reviewers.

**Edge case — shared reviewer across teams:** A shared reviewer (scope: 'shared') is a member of multiple groups. `resolveTeamMembersForHead` for a shared member returns the first group (in stored order) that contains it. If `originLead` is on a different one of those teams, the membership check would incorrectly drop it. However: in the delegation flow, the coder was already resolved via `resolveTeamRoleTerminal(resolvedWorkspaceRoot, originLead, 'coder')` — so the coder and originLead are on the same team by construction. If the reviewer is shared across teams A and B, and originLead is on team B, then the coder resolved from originLead's team is team B's coder. The reviewer's roster (first group containing the reviewer) might be team A's roster, which wouldn't include originLead. This is a false positive — originLead IS on a valid team with the coder, just not the first team the roster lookup finds.

**Mitigation for the shared-reviewer edge case:** Check membership against ALL groups that contain the reviewer, not just the first. Add a helper or inline a broader check: if `originLead` appears in ANY group that also contains `targetAgent`, keep it. This is a small extension to the guard:

```ts
if (originLead) {
    const reviewerRoster = await resolveTeamMembersForHead({ db: coderDb, originName: targetAgent });
    if (reviewerRoster && !reviewerRoster.includes(originLead)) {
        // Shared reviewer may be on multiple teams; check all groups
        // containing the reviewer before dropping.
        const allGroups = await coderDb.getConfigJson(TERMINALS_GROUPS_KEY, []);
        const sharedTeams = (Array.isArray(allGroups) ? allGroups : [])
            .filter(g => Array.isArray(g?.members) && g.members.includes(targetAgent));
        const onAnySharedTeam = sharedTeams.some(g =>
            Array.isArray(g?.members) && g.members.includes(originLead));
        if (!onAnySharedTeam) {
            originLead = undefined;
        }
    }
}
```

This adds a direct `getConfigJson` read for the shared-reviewer case only — the common case (single-team or no-team) hits the fast path and never reaches it.

### src/services/teamWiring.ts

No changes. `resolveTeamMembersForHead` already does exactly what we need. The `TERMINALS_GROUPS_KEY` constant is already exported and imported in `TaskViewerProvider.ts`.

### src/test/team-scoped-role-routing.test.js

Add a new test item (Item 10 or append to the existing structure) covering the cross-team guard:

1. **Cross-team originLead is dropped:** Two teams (lead-1 with coder-1 and Coding-reviewer; lead-2 with coder-2 and Backend-reviewer). A plan record with `dispatchedTerminal: 'planner-1'` (not on either team). Verify that when the reviewer dispatch path runs, `originLead` is dropped and delegation mode falls back to fix-itself. This is a structural/source-level test since the full dispatch path requires a live extension — assert the guard code exists and the logic is correct via a unit test of the membership predicate.

2. **Same-team originLead is kept:** A plan record with `dispatchedTerminal: 'lead-1'` (the head of the reviewer's team). Verify `originLead` survives the guard.

3. **Shared reviewer across teams — originLead on a different shared team is kept:** Reviewer is a member of both team A and team B. `originLead` is team B's lead. The first roster lookup returns team A, but the broader check finds originLead on team B. Verify `originLead` is kept.

4. **Null roster (standalone reviewer) — originLead is kept:** No groups registered. `resolveTeamMembersForHead` returns null. `originLead` survives (backward compat for standalone reviewers).

## Verification Plan

1. `npm run compile-tests` — compile succeeds.
2. `node src/test/team-scoped-role-routing.test.js` — all existing tests pass plus the new cross-team guard tests.
3. **Manual / live-extension:** Start a Coding team, run a plan through planner-1 for improvement, then advance the card to CODE REVIEWED. Verify the reviewer's prompt does NOT name planner-1 as the report-to target. Verify it either names the correct team lead (if on the same team) or falls back to fix-itself mode.
4. **Regression:** A card that went through the team's own lead (not planner-1) still gets delegation mode with the correct originLead — no behavior change for the normal flow.
