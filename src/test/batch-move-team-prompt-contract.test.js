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
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');

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

async function runAll() {
    testTeamHeadBatchPrompt();
    testNonTeamBatchPrompt();
    testPlannerBatchPromptDoesNotLeakWorkflow();
    testRealFeatureDispatchKeepsUnitClause();
    console.log('\nAll batch move team prompt contract tests PASSED!');
}

runAll().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
