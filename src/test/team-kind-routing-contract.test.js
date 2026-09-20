/**
 * Contract: `acceptedKinds` binds the SEAT resolver, not just the queue.
 *
 * Complexity decides the ROLE; `acceptedKinds` decides the TEAM. The queue paths
 * already read it through `resolveImplementationHead`, but the drag-to-column
 * path resolved a seat by role alone. With both implementation teams live that
 * took whichever terminal of the role came first in the fleet — so a single plan
 * of complexity 5-6 routed to role `coder` and landed on the FEATURE team's
 * coder, while the Coding team, the only team declaring `['plan']`, was never a
 * candidate.
 *
 * Observed on the live board 2026-09-20: plan 403c4cbd (is_feature=0, no
 * feature_id, complexity 6) dispatched at 11:56:25Z to `Feature-coder-1` with
 * `agent: "coder"` — the role was right and the team was wrong — while `Coding`
 * and `Coding-intern` were alive and idle.
 *
 * Four rules, all load-bearing:
 *   - both teams live, kind 'plan'    → the Feature team is out, head AND seats
 *   - both teams live, kind 'feature' → the Coding team is out
 *   - no kind supplied                → team-blind, exactly as before
 *   - only the wrong team live        → NOTHING is excluded, and it says so.
 *     Excluding the sole live team turns "the Coding team is not running" into
 *     "nothing is running", which is worse than the bug being fixed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const tw = require(path.join(REPO_ROOT, 'out/services/teamWiring.js'));
const TVP_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src/services/TaskViewerProvider.ts'), 'utf8');

const FEATURE_SEATS = ['Feature', 'Feature-coder-1', 'Feature-coder-2', 'Feature-intern'];
const CODING_SEATS = ['Coding', 'Coding-intern'];

const SPAWNED = {
    feature: {
        id: 'team_Feature', name: 'Feature', head: 'Feature', teamKind: 'spawned',
        definitionId: 'feature-implementation', headRole: 'lead', members: [...FEATURE_SEATS],
    },
    coding: {
        id: 'team_Coding', name: 'Coding', head: 'Coding', teamKind: 'spawned',
        definitionId: 'coding-team', headRole: 'coder', members: [...CODING_SEATS],
    },
};

// The shipped declarations, asserted below against the real definitions so this
// fixture cannot drift away from what actually ships.
const DEFS = [
    { id: 'feature-implementation', name: 'Feature Implementation', headRole: 'lead', acceptedKinds: ['feature'], automatedDispatch: 'pool', members: [] },
    { id: 'coding-team', name: 'Coding', headRole: 'coder', acceptedKinds: ['plan'], automatedDispatch: 'pool', members: [] },
];

const mkDb = (spawned) => ({
    getConfigJson: async (key) => {
        if (key === tw.TERMINALS_GROUPS_KEY) return spawned;
        if (key === 'terminals.agentGroups') return DEFS;
        return [];
    },
});

const excludedFor = async (spawned, liveNames, kind) => {
    const { excluded } = await tw.resolveAutomatedDispatchExclusions({ db: mkDb(spawned), liveNames: new Set(liveNames), kind });
    return [...excluded].sort();
};

(async () => {
    // 0. The fixture matches what ships.
    const shipped = new Map(tw.DEFAULT_TEAM_DEFINITIONS.map(d => [d.id, d]));
    for (const def of DEFS) {
        const real = shipped.get(def.id);
        assert.ok(real, `shipped definition '${def.id}' not found`);
        assert.deepStrictEqual(
            tw.readTeamAcceptedKinds(real).value, def.acceptedKinds,
            `'${def.id}' no longer declares ${JSON.stringify(def.acceptedKinds)} — this contract's fixture is stale`
        );
    }

    const both = [SPAWNED.feature, SPAWNED.coding];
    const allLive = [...FEATURE_SEATS, ...CODING_SEATS];

    // 1. A single plan must not reach the Feature team while Coding is live.
    const onPlan = await excludedFor(both, allLive, 'plan');
    assert.deepStrictEqual(onPlan, [...FEATURE_SEATS].sort(),
        'kind=plan must exclude the Feature team entirely — head AND seats');
    for (const seat of CODING_SEATS) {
        assert.ok(!onPlan.includes(seat), `kind=plan must keep '${seat}' eligible`);
    }

    // 2. A feature must not reach the Coding team.
    const onFeature = await excludedFor(both, allLive, 'feature');
    assert.deepStrictEqual(onFeature, [...CODING_SEATS].sort(),
        'kind=feature must exclude the Coding team entirely');

    // 3. No kind supplied → unchanged, team-blind behaviour.
    assert.deepStrictEqual(await excludedFor(both, allLive, undefined), [],
        'no kind must leave the pool untouched');

    // 4. Only the non-declaring team live → excluded NOTHING.
    assert.deepStrictEqual(await excludedFor([SPAWNED.feature], FEATURE_SEATS, 'plan'), [],
        'with only the Feature team live, a plan must still reach it rather than stranding');

    // 5. The kind actually reaches the seat resolver. A filter nothing calls is
    //    the bug this fixes, one layer down.
    assert.ok(
        /_automatedDispatchExclusions\(workspaceRoot, kind\)/.test(TVP_SRC),
        'the fleet first-match must pass the work kind into the exclusions'
    );
    assert.ok(
        /_resolveExactAgentTerminalForPlan\(role, workspaceRoot, worktreePath, originTerminal, kind\)/.test(TVP_SRC),
        '_resolveAgentTerminalForPlan must forward the kind'
    );
    assert.ok(
        /workKind = \(isFeature \|\| belongsToFeature\) \? 'feature' : 'plan'/.test(TVP_SRC),
        "a subtask (feature_id set, is_feature=0) must count as 'feature' — its team owns it"
    );
    assert.ok(
        /resolvedWorkspaceRoot, worktreePath, originTerminal, workKind\)/.test(TVP_SRC),
        'the kanban dispatch site must pass the derived work kind'
    );

    console.log('team-kind-routing-contract: all assertions passed');
})().catch(err => { console.error(err); process.exit(1); });
