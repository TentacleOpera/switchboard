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

const subagentText = 'If your platform supports parallel sub-agents';
const executionDirective = 'AUTHORIZATION TO EXECUTE';
const chatCritiqueText = 'verbatim in your chat response';

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

try {
    testSinglePlan();
    testMultiplePlans();
    testExecutionDirective();
    testGitProhibitionDirective();
    testChatCritiqueDirective();
    console.log('\nSubagent conditional tests PASSED!');
} catch (err) {
    console.error('\nTest FAILED:', err.message);
    process.exit(1);
}
