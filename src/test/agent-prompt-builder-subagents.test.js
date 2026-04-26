'use strict';

const assert = require('assert');
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');

const plans1 = [
    { topic: 'plan-1', absolutePath: '/abs/path/to/1.md' }
];

const plans2 = [
    { topic: 'plan-1', absolutePath: '/abs/path/to/1.md' },
    { topic: 'plan-2', absolutePath: '/abs/path/to/2.md' }
];
const sameDirPlans = [
    { topic: 'plan-1', absolutePath: '/abs/path/to/1.md', workingDir: '/workspace/be' },
    { topic: 'plan-2', absolutePath: '/abs/path/to/2.md', workingDir: '/workspace/be' }
];
const mixedDirPlans = [
    { topic: 'plan-1', absolutePath: '/abs/path/to/1.md', workingDir: '/workspace/be' },
    { topic: 'plan-2', absolutePath: '/abs/path/to/2.md', workingDir: '/workspace/fe' }
];
const partiallyScopedPlans = [
    { topic: 'plan-1', absolutePath: '/abs/path/to/1.md', workingDir: '/workspace/be' },
    { topic: 'plan-2', absolutePath: '/abs/path/to/2.md' }
];

const subagentText = 'If your platform supports parallel sub-agents';
const executionDirective = 'AUTHORIZATION TO EXECUTE';
const chatCritiqueText = 'verbatim in your chat response';
const repoMetadataText = "**Repo:** [bare sub-repo folder name, e.g. 'be'. Omit if not a multi-repo setup or if this plan spans multiple repos.]";
const missingRepoScopeText = '[not set — add **Repo:** to the plan metadata before dispatching from a control plane]';

function testSinglePlan() {
    console.log('Testing single plan (no subagent info)...');
    const roles = ['planner', 'reviewer', 'tester', 'lead', 'coder'];
    for (const role of roles) {
        const prompt = buildKanbanBatchPrompt(role, plans1);
        assert.ok(!prompt.includes(subagentText), `Role ${role} should NOT include subagent info for single plan`);
    }
    console.log('  PASS: Single plan correct for all roles');
}

function testMultiplePlans() {
    console.log('Testing multiple plans (with subagent info)...');
    const roles = ['planner', 'reviewer', 'tester', 'lead', 'coder'];
    for (const role of roles) {
        const prompt = buildKanbanBatchPrompt(role, plans2);
        assert.ok(prompt.includes(subagentText), `Role ${role} SHOULD include subagent info for multiple plans`);
    }
    console.log('  PASS: Multiple plans correct for all roles');
}

function testExecutionDirective() {
    console.log('Testing execution directive presence...');
    const roles = ['tester', 'lead', 'coder'];
    for (const role of roles) {
        // Test single plan
        const prompt1 = buildKanbanBatchPrompt(role, plans1);
        assert.ok(prompt1.includes(executionDirective), `Role ${role} SHOULD include execution directive (single plan)`);
        
        // Test multiple plans
        const prompt2 = buildKanbanBatchPrompt(role, plans2);
        assert.ok(prompt2.includes(executionDirective), `Role ${role} SHOULD include execution directive (multiple plans)`);
    }
    const otherRoles = ['planner', 'reviewer'];
    for (const role of otherRoles) {
        const prompt = buildKanbanBatchPrompt(role, plans1);
        assert.ok(!prompt.includes(executionDirective), `Role ${role} should NOT include execution directive`);
    }
    console.log('  PASS: Execution directive correctly limited to tester, lead, and coder (all plan counts)');
}

function testGitProhibitionDirective() {
    console.log('Testing git prohibition directive presence...');
    const allRoles = ['planner', 'reviewer', 'tester', 'lead', 'coder', 'unknown_role'];
    for (const role of allRoles) {
        const prompt = buildKanbanBatchPrompt(role, plans1);
        assert.ok(prompt.includes('GIT POLICY'), `Role ${role} SHOULD include git prohibition directive`);
    }
    console.log('  PASS: Git prohibition directive present for all roles');
}

function testChatCritiqueDirective() {
    console.log('Testing chat critique directive presence...');
    const promptRoles = ['planner', 'reviewer'];
    for (const role of promptRoles) {
        const prompt = buildKanbanBatchPrompt(role, plans1);
        assert.ok(prompt.includes(chatCritiqueText), `Role ${role} SHOULD include chat critique directive`);
    }
    const nonCritiqueRoles = ['tester', 'lead', 'coder'];
    for (const role of nonCritiqueRoles) {
        const prompt = buildKanbanBatchPrompt(role, plans1);
        assert.ok(!prompt.includes(chatCritiqueText), `Role ${role} should NOT include chat critique directive`);
    }
    console.log('  PASS: Chat critique directive correctly limited to planner and reviewer');
}

function testNoRepoContextForUnscopedPlans() {
    console.log('Testing unscoped plans omit repo context...');
    const prompt = buildKanbanBatchPrompt('coder', plans2);
    assert.ok(!prompt.includes('WORKING DIRECTORY:'), 'Unscoped plans should not include a working directory directive');
    assert.ok(!prompt.includes('MULTI-REPO BATCH:'), 'Unscoped plans should not include a multi-repo notice');
    console.log('  PASS: Unscoped plans stay unchanged');
}

function testSingleWorkingDirectoryContext() {
    console.log('Testing shared working directory directive...');
    const roles = ['planner', 'reviewer', 'tester', 'lead', 'coder', 'team-lead', 'unknown_role'];
    for (const role of roles) {
        const prompt = buildKanbanBatchPrompt(role, sameDirPlans);
        assert.ok(prompt.includes('WORKING DIRECTORY: /workspace/be'), `Role ${role} should include the shared working directory`);
        assert.ok(!prompt.includes('MULTI-REPO BATCH:'), `Role ${role} should not use the multi-repo notice for a shared directory`);
    }
    console.log('  PASS: Shared working directory is injected for all prompt paths');
}

function testMixedWorkingDirectoryContext() {
    console.log('Testing mixed working directory notice...');
    const prompt = buildKanbanBatchPrompt('coder', mixedDirPlans);
    assert.ok(prompt.includes('MULTI-REPO BATCH:'), 'Mixed repo batches should include a multi-repo notice');
    assert.ok(prompt.includes('- [plan-1] Working Directory: /workspace/be'), 'Mixed repo batches should list the first working directory');
    assert.ok(prompt.includes('- [plan-2] Working Directory: /workspace/fe'), 'Mixed repo batches should list the second working directory');
    assert.ok(!prompt.includes('WORKING DIRECTORY: /workspace/be\nAll file reads and writes must be relative to this directory unless the plan explicitly states otherwise.'), 'Mixed repo batches should not collapse to a single working directory');
    console.log('  PASS: Mixed repo batches render per-plan directories');
}

function testPartiallyScopedWorkingDirectoryContext() {
    console.log('Testing partially scoped working directory notice...');
    const prompt = buildKanbanBatchPrompt('coder', partiallyScopedPlans);
    assert.ok(prompt.includes('MULTI-REPO BATCH:'), 'Partially scoped batches should include a multi-repo notice');
    assert.ok(prompt.includes('- [plan-1] Working Directory: /workspace/be'), 'Partially scoped batches should keep the scoped directory');
    assert.ok(prompt.includes(`- [plan-2] Working Directory: ${missingRepoScopeText}`), 'Partially scoped batches should call out missing repo metadata');
    console.log('  PASS: Partially scoped batches do not silently fall back to the control-plane root');
}

function testReplaceOverrideKeepsRepoContext() {
    console.log('Testing replace override keeps repo context...');
    const prompt = buildKanbanBatchPrompt('coder', sameDirPlans, {
        defaultPromptOverrides: {
            coder: {
                mode: 'replace',
                text: 'CUSTOM CODER PROMPT'
            }
        }
    });
    assert.ok(prompt.startsWith('CUSTOM CODER PROMPT'), 'Replace override should still replace the main prompt body');
    assert.ok(prompt.includes('WORKING DIRECTORY: /workspace/be'), 'Replace override should keep the working directory block');
    assert.ok(prompt.includes('PLANS TO PROCESS:\n- [plan-1] Plan File: /abs/path/to/1.md'), 'Replace override should keep the canonical plan list');
    console.log('  PASS: Replace overrides retain repo dispatch context');
}

function testPlannerRepoMetadataLine() {
    console.log('Testing planner repo metadata guidance...');
    const prompt = buildKanbanBatchPrompt('planner', plans1);
    assert.ok(prompt.includes(repoMetadataText), 'Planner prompts should require repo metadata guidance');
    console.log('  PASS: Planner prompt includes repo metadata instructions');
}

try {
    testSinglePlan();
    testMultiplePlans();
    testExecutionDirective();
    testGitProhibitionDirective();
    testChatCritiqueDirective();
    testNoRepoContextForUnscopedPlans();
    testSingleWorkingDirectoryContext();
    testMixedWorkingDirectoryContext();
    testPartiallyScopedWorkingDirectoryContext();
    testReplaceOverrideKeepsRepoContext();
    testPlannerRepoMetadataLine();
    console.log('\nSubagent conditional tests PASSED!');
} catch (err) {
    console.error('\nTest FAILED:', err.message);
    process.exit(1);
}
