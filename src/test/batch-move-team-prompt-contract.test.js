'use strict';

/**
 * Batch moves to a team send the feature implementation prompt contract test.
 *
 * Verifies that:
 * 1. Loose plans batched to a team head produce the allocate prompt framing (driveMode + batchMode).
 * 2. BATCH_EXECUTION_RULES and "begin implementation immediately" are suppressed.
 * 3. The batch directive replaces feature-file references and unit clauses with conflict pass instructions.
 * 4. Non-team batches stay byte-identical and carry BATCH_EXECUTION_RULES.
 * 5. Planner batches do not leak feature workflow path.
 * 6. Real feature dispatches retain their unit clause and feature-file references.
 * 7. Cap of 5 loose plans is enforced.
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

// KanbanProvider imports `vscode`; the standalone shim stands in for it so the
// provider's own gate + cap can be exercised headlessly (same pattern as
// drive-mode-prompt-overhaul-contract.test.js).
const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return require(shimPath);
    return originalLoad.apply(this, arguments);
};

const { buildKanbanBatchPrompt, TEAM_BATCH_PLAN_CAP } = require('../../out/services/agentPromptBuilder');
const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { TERMINALS_GROUPS_KEY } = require('../../out/services/teamWiring');

const makeLoosePlans = (count) => {
    const plans = [];
    for (let i = 1; i <= count; i++) {
        plans.push({
            sessionId: `sess${i}`,
            planId: `plan${i}`,
            topic: `Loose Plan ${i}`,
            title: `Loose Plan ${i}`,
            absolutePath: `/path/to/loose_plan_${i}.md`,
            column: 'PLAN REVIEWED',
            createdAt: new Date(2026, 0, i).toISOString()
        });
    }
    return plans;
};

const makeFeaturePlans = () => [
    { sessionId: 'feat1', planId: 'feat1', title: 'Feature 1', topic: 'Test Feature', isFeature: true, absolutePath: '/path/to/feature.md' },
    { sessionId: 'sub1', planId: 'sub1', title: 'Subtask 1', topic: 'Subtask 1', isSubtask: true, featureId: 'feat1', absolutePath: '/path/to/sub1.md' },
    { sessionId: 'sub2', planId: 'sub2', title: 'Subtask 2', topic: 'Subtask 2', isSubtask: true, featureId: 'feat1', absolutePath: '/path/to/sub2.md' }
];

function testTeamHeadBatchPrompt() {
    console.log('Testing team head loose plan batch prompt...');
    const plans = makeLoosePlans(5);
    const options = {
        featureMode: true,
        driveMode: true,
        batchMode: true,
        featureTopic: 'Batch send',
        subtaskCount: 5
    };

    const prompt = buildKanbanBatchPrompt('lead', plans, options);

    // Intro and authorization
    assert.ok(prompt.includes('Please drive the batch of 5 plans below through your team seats.'), 'Should have batch drive intro');
    assert.ok(prompt.includes('begin dispatching subtasks to your team seats immediately'), 'Should have drive authorization');

    // Directive framing
    assert.ok(prompt.includes('BATCH MODE: You are driving a batch of 5 independent plan(s) through your team seats.'), 'Should have BATCH MODE opener');
    assert.ok(prompt.includes('Dispatch each subtask to a seat on your team — do not implement subtasks yourself.'), 'Should have dispatch directive');
    assert.ok(prompt.includes('Read the individual plan files below for requirements, seat assignments, and scope constraints — there is no feature file for a batch.'), 'Should direct to individual plan files');
    assert.ok(prompt.includes('The plans in this batch are independent and possibly unrelated.'), 'Should state independence of plans');
    assert.ok(prompt.includes('sequence any plans that collide, and dispatch non-colliding plans in parallel.'), 'Should have conflict pass instruction');

    // Negative assertions
    assert.ok(!prompt.includes('CRITICAL INSTRUCTIONS:'), 'Must NOT contain BATCH_EXECUTION_RULES');
    assert.ok(!prompt.includes('begin implementation immediately'), 'Must NOT contain "begin implementation immediately"');
    assert.ok(!prompt.includes('Team Dispatch Instructions'), 'Must NOT contain "Team Dispatch Instructions"');
    assert.ok(!prompt.includes('single delivery unit'), 'Must NOT contain "single delivery unit"');
    assert.ok(!prompt.includes('do not treat them as independent tickets'), 'Must NOT contain "do not treat them as independent tickets"');

    console.log('  PASS: team head batch prompt');
}

function testNonTeamBatchPrompt() {
    console.log('Testing non-team batch prompt...');
    const plans = makeLoosePlans(3);
    const options = {
        featureMode: false
    };

    const prompt = buildKanbanBatchPrompt('lead', plans, options);

    assert.ok(prompt.includes('CRITICAL INSTRUCTIONS:'), 'Non-team batch MUST contain BATCH_EXECUTION_RULES');
    assert.ok(prompt.includes('begin implementation immediately'), 'Non-team batch MUST contain "begin implementation immediately"');
    assert.ok(!prompt.includes('BATCH MODE:'), 'Non-team batch must NOT have BATCH MODE opener');
    assert.ok(!prompt.includes('begin dispatching subtasks to your team seats'), 'Non-team batch must NOT have drive authorization');

    console.log('  PASS: non-team batch prompt');
}

function testPlannerBatchPromptDoesNotLeakWorkflow() {
    console.log('Testing planner batch prompt workflow path...');
    const plans = makeLoosePlans(3);
    const options = {
        featureMode: true,
        driveMode: true,
        batchMode: true,
        plannerWorkflowPath: '.agents/protocols/improve-plan/SKILL.md',
        plannerFeatureWorkflowPath: '.agents/protocols/improve-feature/SKILL.md'
    };

    const prompt = buildKanbanBatchPrompt('planner', plans, options);

    assert.ok(prompt.includes('.agents/protocols/improve-plan/SKILL.md'), 'Planner batch should use standard improve-plan workflow');
    assert.ok(!prompt.includes('.agents/protocols/improve-feature/SKILL.md'), 'Planner batch should NOT use feature workflow');

    console.log('  PASS: planner batch prompt workflow path');
}

function testRealFeatureDispatchKeepsUnitClause() {
    console.log('Testing real feature dispatch keeps unit clause...');
    const plans = makeFeaturePlans();
    const options = {
        featureMode: true,
        driveMode: true,
        batchMode: false,
        featureTopic: 'Test Feature',
        subtaskCount: 2
    };

    const prompt = buildKanbanBatchPrompt('lead', plans, options);

    assert.ok(prompt.includes('All subtasks are part of a single delivery unit — do not treat them as independent tickets.'), 'Real feature MUST keep unit clause');
    assert.ok(prompt.includes('Read the feature file\'s Team Dispatch Instructions section'), 'Real feature MUST reference Team Dispatch Instructions');
    assert.ok(!prompt.includes('there is no feature file for a batch'), 'Real feature must NOT claim no feature file');

    console.log('  PASS: real feature dispatch keeps unit clause');
}

function testCoderBatchKeepsPlanList() {
    console.log('Testing coder batch keeps the plan list...');
    const plans = makeLoosePlans(5);
    const options = { featureMode: true, driveMode: true, batchMode: true, featureTopic: 'Batch send', subtaskCount: 5 };

    const prompt = buildKanbanBatchPrompt('coder', plans, options);

    // The coder's featureMode branch replaces PLANS TO PROCESS with a single
    // FEATURE FILE reference resolved as `plans.find(p => !p.isSubtask)`. Every loose
    // plan matches that, so a batch would name plan #1 as the feature file and drop
    // plans #2..N entirely. batchMode must fall through to per-plan enumeration.
    assert.ok(prompt.includes('PLANS TO PROCESS:'), 'Coder batch MUST enumerate the plans');
    for (let i = 1; i <= 5; i++) {
        assert.ok(prompt.includes(`/path/to/loose_plan_${i}.md`), `Coder batch must name plan ${i}`);
    }
    assert.ok(!prompt.includes('FEATURE FILE:'), 'Coder batch must NOT claim a feature file');
    assert.ok(!prompt.includes('All subtasks are one delivery unit'), 'Coder batch must NOT assert a delivery unit');

    console.log('  PASS: coder batch keeps the plan list');
}

function testStaggeredDirectiveSuppressedInBatch() {
    console.log('Testing staggered-implementation directive is suppressed in batch mode...');
    const plans = makeLoosePlans(5);
    const base = { featureMode: true, driveMode: true, featureTopic: 'Batch send', subtaskCount: 5, staggeredImplementationEnabled: true };

    const batchPrompt = buildKanbanBatchPrompt('lead', plans, { ...base, batchMode: true });
    const featurePrompt = buildKanbanBatchPrompt('lead', makeFeaturePlans(), { ...base, batchMode: false, featureTopic: 'Test Feature', subtaskCount: 2 });

    assert.ok(!batchPrompt.includes('STAGGERED IMPLEMENTATION:'), 'Batch prompt must NOT reference the feature overview file');
    assert.ok(featurePrompt.includes('STAGGERED IMPLEMENTATION:'), 'Real feature dispatch MUST keep the staggered directive');

    console.log('  PASS: staggered directive suppressed in batch mode');
}

// ── Provider gate + cap ───────────────────────────────────────────────────────

function makeProvider({ groups = [], agentNames = {} } = {}) {
    const store = { [TERMINALS_GROUPS_KEY]: groups, 'terminals.groups': [] };
    const db = {
        ensureReady: async () => true,
        getConfig: async key => store[key] ?? null,
        getConfigJson: async (key, fallback) => (key in store ? structuredClone(store[key]) : fallback),
    };
    const provider = Object.create(KanbanProvider.prototype);
    provider._getKanbanDb = () => db;
    provider._getAgentNames = async () => agentNames;
    return provider;
}

const TEAM_GROUPS = [{ id: 'team_Coding_lead', head: 'Coding-lead', members: ['Coding-lead', 'Coder-1', 'Coder-2'], order: ['Coding-lead', 'Coder-1', 'Coder-2'] }];

async function testTeamHeadGateResolvesOffTheTerminalName() {
    console.log('Testing team-head gate resolves off the target terminal name...');
    const provider = makeProvider({ groups: TEAM_GROUPS, agentNames: { lead: 'Coding-lead' } });

    // Team groups are keyed by the HEAD TERMINAL's name (`team_<headName>`). Resolving
    // team-ness from the role STRING matches no group, so every lead reads as team-less
    // and the whole allocate path is unreachable — the exact regression this pins.
    assert.strictEqual(await provider.isCodingTeamHead('/ws', 'lead', 'Coding-lead'), true, 'A lead heading a team must gate true');
    assert.strictEqual(await provider.isCodingTeamHead('/ws', 'lead', 'Solo-lead'), false, 'A lead heading no team must gate false');

    // No target terminal (the prompt previews): fall back to the role's agent name.
    assert.strictEqual(await provider.isCodingTeamHead('/ws', 'lead'), true, 'Preview path must fall back to the configured agent name');
    const unassigned = makeProvider({ groups: TEAM_GROUPS, agentNames: { lead: 'No agent assigned' } });
    assert.strictEqual(await unassigned.isCodingTeamHead('/ws', 'lead'), false, '"No agent assigned" is not a team head');

    // The flag must not reach a plain seat or the planner: featureMode redirects the
    // planner's workflow file, and driveMode tells a coder to dispatch to seats it has none of.
    for (const role of ['coder', 'intern', 'planner', 'reviewer']) {
        assert.strictEqual(await provider.isCodingTeamHead('/ws', role, 'Coding-lead'), false, `${role} must never gate as a team head`);
    }

    console.log('  PASS: team-head gate resolves off the target terminal name');
}

function makeOrderablePlans(count, extra = () => ({})) {
    const plans = [];
    for (let i = 1; i <= count; i++) {
        plans.push({
            planId: `plan${i}`,
            topic: `Plan ${i}`,
            column: 'CREATED',
            createdAt: new Date(2026, 0, i).toISOString(),
            columnEnteredAt: new Date(2026, 0, i).toISOString(),
            ...extra(i)
        });
    }
    return plans;
}

function testCapAndRemainder() {
    console.log('Testing cap, remainder and determinism...');
    const provider = makeProvider();
    const twelve = makeOrderablePlans(12);

    const first = provider.selectTeamBatchPlans(twelve);
    assert.strictEqual(TEAM_BATCH_PLAN_CAP, 5, 'The cap is five');
    assert.strictEqual(first.sent.length, 5, 'Five plans are sent');
    assert.strictEqual(first.skipped.length, 7, 'Seven plans stay put');
    assert.strictEqual(new Set([...first.sent, ...first.skipped]).size, 12, 'No plan is dropped or duplicated');

    // The same selection sends the same five, in the same order.
    const second = provider.selectTeamBatchPlans(twelve);
    assert.deepStrictEqual(second.sent.map(p => p.planId), first.sent.map(p => p.planId), 'The selection is deterministic');

    // A non-STAGING hand-arrangement (V63 column_order — reorderColumn rewrites the
    // whole column's positions) is respected. Here the arrangement is oldest-first,
    // the exact opposite of the column_entered_at DESC fallback, so a comparator that
    // ignored column_order would send the five the user deprioritised.
    const arranged = makeOrderablePlans(12, i => ({ columnOrder: i }));
    const arrangedPick = provider.selectTeamBatchPlans(arranged);
    assert.deepStrictEqual(
        arrangedPick.sent.map(p => p.planId),
        ['plan1', 'plan2', 'plan3', 'plan4', 'plan5'],
        'A hand-arranged non-STAGING column must be sent in its arranged order'
    );

    // A starred card outranks the arrangement outside STAGING.
    const starred = makeOrderablePlans(12, i => ({ columnOrder: i, priorityStarred: i === 12 ? 1 : 0 }));
    assert.strictEqual(provider.selectTeamBatchPlans(starred).sent[0].planId, 'plan12', 'A starred card leads the sent set');

    // STAGING reads queue_position instead, and column_order is ignored there.
    const staged = makeOrderablePlans(12, i => ({ column: 'STAGING', queuePosition: 13 - i, columnOrder: i }));
    const stagedPick = provider.selectTeamBatchPlans(staged);
    assert.deepStrictEqual(
        stagedPick.sent.map(p => p.planId),
        ['plan12', 'plan11', 'plan10', 'plan9', 'plan8'],
        'STAGING must send the head of the staged queue'
    );

    // A set at or under the cap is sent whole.
    const three = provider.selectTeamBatchPlans(makeOrderablePlans(3));
    assert.strictEqual(three.sent.length, 3, 'A set under the cap is sent whole');
    assert.strictEqual(three.skipped.length, 0, 'A set under the cap skips nothing');

    console.log('  PASS: cap, remainder and determinism');
}

async function runAll() {
    testTeamHeadBatchPrompt();
    testNonTeamBatchPrompt();
    testPlannerBatchPromptDoesNotLeakWorkflow();
    testRealFeatureDispatchKeepsUnitClause();
    testCoderBatchKeepsPlanList();
    testStaggeredDirectiveSuppressedInBatch();
    await testTeamHeadGateResolvesOffTheTerminalName();
    testCapAndRemainder();
    console.log('\nAll batch move team prompt contract tests PASSED!');
}

runAll().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
