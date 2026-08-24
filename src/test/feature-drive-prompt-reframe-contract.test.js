'use strict';

/**
 * Feature Drive-mode prompt-body reframe contract.
 *
 * The Drive toggle prepends the enriched drive prefix (built by KanbanProvider's
 * _buildDrivePrefix — team roster, port, curl template, inlined rules) at
 * position zero. Before this contract the
 * rest of the prompt body was still execution-coded for solo implementation, so a
 * team lead read the body as governing, coded the subtasks itself, and left its wired
 * team idle. That was the reasonable resolution of a prompt where one line said
 * "dispatch" and every other block said "implement yourself".
 *
 * This file pins BOTH directions: every execution-coded block flips under Drive, and
 * the Drive-off payload is unchanged. The negative assertions are the load-bearing
 * half — a partial flip leaves a weaker but still real contradiction, and there are
 * SIX blocks, not five (the coder's FEATURE FILE block carries its own trailing verb
 * and was the one missed on the first pass).
 *
 * Deliberately standalone rather than appended to
 * agent-prompt-builder-subagents.test.js: that file has carried stale assertions
 * since 2026-06 ('Process each plan sequentially', 'create worktrees' — text long
 * since removed from the builder), throws at its second test, and is wired into no
 * gate, so anything added to it is dead on arrival.
 */

const assert = require('assert');
const { buildKanbanBatchPrompt, buildCustomAgentPrompt } = require('../../out/services/agentPromptBuilder');

const makeFeaturePlans = () => [
    { sessionId: 'feat1', planId: 'feat1', title: 'Feature 1', topic: 'Test Feature', isFeature: true, absolutePath: '/path/to/feature.md' },
    { sessionId: 'sub1', planId: 'sub1', title: 'Subtask 1', topic: 'Subtask 1', isSubtask: true, featureId: 'feat1', absolutePath: '/path/to/sub1.md' },
    { sessionId: 'sub2', planId: 'sub2', title: 'Subtask 2', topic: 'Subtask 2', isSubtask: true, featureId: 'feat1', absolutePath: '/path/to/sub2.md' }
];

const baseOpts = { featureMode: true, featureTopic: 'Test Feature', featurePlanId: 'feat1', subtaskCount: 2 };
const driveOpts = { ...baseOpts, driveMode: true };

// Every phrase that tells the receiving agent to implement the subtasks itself. None
// may survive anywhere in a Drive-mode prompt, for any Drive-allowlisted role.
const IMPLEMENT_CODED = [
    'begin implementation immediately',
    'Handle the subtasks yourself',
    'Handle all subtasks yourself',
    'Execute each subtask plan in full'
];

function testLeadDriveOn() {
    console.log('Testing lead role with Drive ON...');
    const prompt = buildKanbanBatchPrompt('lead', makeFeaturePlans(), driveOpts);
    assert.ok(prompt.includes('Please drive the feature described below through your team seats.'), 'Lead should have drive intro');
    assert.ok(prompt.includes('begin dispatching subtasks to your team seats immediately'), 'Lead should have drive execution directive');
    assert.ok(prompt.includes('FEATURE MODE: You are driving the feature "Test Feature"'), 'Lead should have driving feature-mode opener');
    assert.ok(prompt.includes('Dispatch each subtask to a seat on your team — do not implement subtasks yourself.'), 'Lead should have drive feature directive');
    assert.ok(prompt.includes('Do not commit after each subtask'), 'Lead should have commit-timing directive');
    assert.ok(prompt.includes('Team Dispatch Instructions'), 'Lead should have feature-file Team Dispatch Instructions pointer');
    for (const phrase of IMPLEMENT_CODED) {
        assert.ok(!prompt.includes(phrase), `Lead Drive prompt must NOT contain "${phrase}"`);
    }
    console.log('  PASS: lead Drive ON');
}

function testCoderDriveOn() {
    console.log('Testing coder role with Drive ON...');
    const prompt = buildKanbanBatchPrompt('coder', makeFeaturePlans(), driveOpts);
    assert.ok(prompt.includes('Please drive the feature described below through your team seats.'), 'Coder should have drive intro');
    assert.ok(prompt.includes('EXECUTION MODE: The feature below is pre-approved — begin dispatching subtasks to your team seats immediately'), 'Coder should have drive feature execution block');
    assert.ok(prompt.includes('Dispatch each subtask plan to a coder seat; review the diff on callback and resend a fix prompt if it falls short.'), 'Coder should have dispatch instruction');
    assert.ok(prompt.includes('Dispatch each subtask to a seat on your team — do not implement subtasks yourself.'), 'Coder should have drive subagent block');
    assert.ok(prompt.includes('Do not commit after each subtask'), 'Coder should have commit-timing directive');
    // The FEATURE FILE block is the coder's discovery path for the subtask list and
    // must SURVIVE under Drive — only its trailing verb flips. It renders whenever the
    // feature plan carries an absolutePath, which it always does in a real dispatch, so
    // asserting the reframe without asserting the block is present proves nothing.
    assert.ok(prompt.includes('FEATURE FILE:'), 'Coder should still get the feature-file reference under Drive');
    assert.ok(prompt.includes('Dispatch each subtask plan to a seat on your team.'), 'Coder feature-file block should carry the drive verb');
    for (const phrase of IMPLEMENT_CODED) {
        assert.ok(!prompt.includes(phrase), `Coder Drive prompt must NOT contain "${phrase}"`);
    }
    console.log('  PASS: coder Drive ON');
}

function testInternDriveOn() {
    console.log('Testing intern role with Drive ON...');
    // Drive is allowlisted to ['lead', 'coder', 'intern'] (KanbanProvider), so the
    // intern branch is reachable with driveMode true and is not optional coverage.
    const prompt = buildKanbanBatchPrompt('intern', makeFeaturePlans(), driveOpts);
    assert.ok(prompt.includes('Please drive the feature described below through your team seats.'), 'Intern should have drive intro');
    assert.ok(prompt.includes('Dispatch each subtask to a seat on your team — do not implement subtasks yourself.'), 'Intern should have drive directive');
    assert.ok(prompt.includes('Do not commit after each subtask'), 'Intern should have commit-timing directive');
    for (const phrase of IMPLEMENT_CODED) {
        assert.ok(!prompt.includes(phrase), `Intern Drive prompt must NOT contain "${phrase}"`);
    }
    console.log('  PASS: intern Drive ON');
}

function testNoSubagentsSuppressedUnderDrive() {
    console.log('Testing noSubagents clause suppression under Drive...');
    // "You are strictly forbidden from spawning or invoking any subagents. Handle all
    // subtasks yourself." is the sharpest contradiction of "dispatch to seats". The
    // policy is about the Agent tool, not fleet terminals, and the agent has no way to
    // know that — so under Drive the clause is suppressed, not reworded.
    const prompt = buildKanbanBatchPrompt('lead', makeFeaturePlans(), { ...driveOpts, featureNoSubagentsEnabled: true });
    assert.ok(!prompt.includes('Handle all subtasks yourself'), 'noSubagents clause must be suppressed under Drive');
    assert.ok(!prompt.includes('strictly forbidden from spawning'), 'noSubagents prohibition must be suppressed under Drive');
    assert.ok(prompt.includes('Dispatch each subtask to a seat on your team — do not implement subtasks yourself.'), 'Drive directive should replace it');
    console.log('  PASS: noSubagents suppressed under Drive');
}

function testPlannerUnaffectedByDrive() {
    console.log('Testing planner branch is unaffected by driveMode...');
    // The planner bypass precedes the drive branch in resolveFeatureOrchestrationDirective.
    // Planners never drive coders and Drive is not allowlisted to them, but the ordering
    // is what guarantees it — pin it so a future reorder cannot silently re-route planners.
    const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), driveOpts);
    assert.ok(prompt.includes('Process the subtask plan files yourself in a sensible order'), 'Planner keeps its own subtask clause');
    assert.ok(!prompt.includes('Dispatch each subtask to a seat on your team'), 'Planner must NOT get the drive directive');
    console.log('  PASS: planner unaffected');
}

function testDriveOffUnchanged() {
    console.log('Testing Drive OFF payloads are unchanged...');
    const lead = buildKanbanBatchPrompt('lead', makeFeaturePlans(), baseOpts);
    assert.ok(lead.includes('Please execute the feature described below.'), 'Lead Drive off keeps execute intro');
    assert.ok(lead.includes('begin implementation immediately'), 'Lead Drive off keeps implementation directive');
    assert.ok(lead.includes('FEATURE MODE: You are implementing the feature "Test Feature"'), 'Lead Drive off keeps implementing opener');
    assert.ok(!lead.includes('drive the feature'), 'Lead Drive off must NOT have drive intro');
    assert.ok(!lead.includes('dispatching subtasks to your team seats'), 'Lead Drive off must NOT have dispatch directive');

    const coder = buildKanbanBatchPrompt('coder', makeFeaturePlans(), baseOpts);
    assert.ok(coder.includes('Execute each subtask plan in full before moving to the next'), 'Coder Drive off keeps its execution block');
    assert.ok(coder.includes('Execute each subtask plan in full.'), 'Coder Drive off keeps the feature-file verb');
    assert.ok(!coder.includes('Dispatch each subtask plan to a seat on your team.'), 'Coder Drive off must NOT carry the drive verb');
    assert.ok(!coder.includes('dispatching subtasks to your team seats'), 'Coder Drive off must NOT have dispatch directive');

    const leadNoSubagents = buildKanbanBatchPrompt('lead', makeFeaturePlans(), { ...baseOpts, featureNoSubagentsEnabled: true });
    assert.ok(leadNoSubagents.includes('Handle all subtasks yourself'), 'noSubagents clause still emits when Drive is off');
    console.log('  PASS: Drive OFF unchanged');
}

function testCustomAgentPath() {
    console.log('Testing custom-agent path (addons.driveMode)...');
    // buildCustomAgentPrompt takes CustomAgentAddons, NOT PromptBuilderOptions, so the
    // flag arrives via addons. That path uses neither buildExecutionIntro nor
    // executionDirective — the only contradiction to bypass is the subagent clause.
    const driveOn = buildCustomAgentPrompt(
        makeFeaturePlans(),
        'custom instructions',
        { featureSubagentPolicy: 'noSubagents', useWorktreesPerPlan: false, driveMode: true }
    );
    assert.ok(!driveOn.includes('Handle all subtasks yourself'), 'Custom agent Drive on must NOT contain the noSubagents clause');
    assert.ok(driveOn.includes('Dispatch each subtask to a seat on your team — do not implement subtasks yourself.'), 'Custom agent Drive on must contain the drive subagent block');
    assert.ok(driveOn.includes('Do not commit after each subtask'), 'Custom agent Drive on must contain the commit-timing directive');

    const driveOff = buildCustomAgentPrompt(
        makeFeaturePlans(),
        'custom instructions',
        { featureSubagentPolicy: 'noSubagents', useWorktreesPerPlan: false }
    );
    assert.ok(driveOff.includes('Handle all subtasks yourself'), 'Custom agent Drive off must keep the noSubagents clause');
    assert.ok(!driveOff.includes('Dispatch each subtask to a seat on your team'), 'Custom agent Drive off must NOT contain dispatch instructions');
    console.log('  PASS: custom-agent path');
}

function testDriveModeAddonSuppression() {
    console.log('Testing Drive-mode addon suppression...');
    const addons = {
        skipCompilation: true,
        skipTests: true,
        suppressWalkthroughEnabled: true,
        accurateCodingEnabled: true
    };
    const forbidden = ['SKIP COMPILATION:', 'SKIP TESTS:', 'SUPPRESS WALKTHROUGH:', 'Accuracy Mode'];
    const driveCoder = buildKanbanBatchPrompt('coder', makeFeaturePlans(), { ...driveOpts, ...addons });
    for (const phrase of forbidden) {
        assert.ok(!driveCoder.includes(phrase), `Coder Drive prompt must NOT contain "${phrase}"`);
    }
    const nonDriveCoder = buildKanbanBatchPrompt('coder', makeFeaturePlans(), { ...baseOpts, ...addons });
    for (const phrase of forbidden) {
        assert.ok(nonDriveCoder.includes(phrase), `Coder non-Drive prompt must retain "${phrase}"`);
    }
    const driveLead = buildKanbanBatchPrompt('lead', makeFeaturePlans(), { ...driveOpts, ...addons });
    for (const phrase of forbidden.slice(0, 3)) {
        assert.ok(!driveLead.includes(phrase), `Lead Drive prompt must NOT contain "${phrase}"`);
    }
    const nonDriveLead = buildKanbanBatchPrompt('lead', makeFeaturePlans(), { ...baseOpts, ...addons });
    for (const phrase of forbidden.slice(0, 3)) {
        assert.ok(nonDriveLead.includes(phrase), `Lead non-Drive prompt must retain "${phrase}"`);
    }
    const reviewerBase = buildKanbanBatchPrompt('reviewer', makeFeaturePlans(), addons);
    const reviewerWithDriveFlag = buildKanbanBatchPrompt('reviewer', makeFeaturePlans(), { ...addons, driveMode: true });
    assert.strictEqual(reviewerWithDriveFlag, reviewerBase, 'Reviewer prompt must ignore an unpaired Drive flag');
    console.log('  PASS: Drive-mode addon suppression');
}

function testNonFeatureDispatchUnaffected() {
    console.log('Testing non-feature dispatch is unaffected...');
    // driveMode is only ever set alongside featureMode, but the flag must no-op rather
    // than corrupt a plain plan dispatch if it ever arrives without it.
    const plans = [{ topic: 'plan-1', planId: 'p1', absolutePath: '/abs/1.md' }];
    const withFlag = buildKanbanBatchPrompt('coder', plans, { driveMode: true });
    const without = buildKanbanBatchPrompt('coder', plans, {});
    assert.strictEqual(withFlag, without, 'driveMode must no-op when featureMode is false');
    console.log('  PASS: non-feature dispatch unaffected');
}

try {
    testLeadDriveOn();
    testCoderDriveOn();
    testInternDriveOn();
    testNoSubagentsSuppressedUnderDrive();
    testPlannerUnaffectedByDrive();
    testDriveOffUnchanged();
    testCustomAgentPath();
    testDriveModeAddonSuppression();
    testNonFeatureDispatchUnaffected();
    console.log('\nFeature Drive-mode prompt reframe contract PASSED!');
} catch (err) {
    console.error(`\nTest FAILED: ${err.message}`);
    process.exit(1);
}
