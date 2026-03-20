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

function testSinglePlan() {
    console.log('Testing single plan (no subagent info)...');
    const roles = ['planner', 'reviewer', 'lead', 'coder'];
    for (const role of roles) {
        const prompt = buildKanbanBatchPrompt(role, plans1);
        assert.ok(!prompt.includes(subagentText), `Role ${role} should NOT include subagent info for single plan`);
    }
    console.log('  PASS: Single plan correct for all roles');
}

function testMultiplePlans() {
    console.log('Testing multiple plans (with subagent info)...');
    const roles = ['planner', 'reviewer', 'lead', 'coder'];
    for (const role of roles) {
        const prompt = buildKanbanBatchPrompt(role, plans2);
        assert.ok(prompt.includes(subagentText), `Role ${role} SHOULD include subagent info for multiple plans`);
    }
    console.log('  PASS: Multiple plans correct for all roles');
}

try {
    testSinglePlan();
    testMultiplePlans();
    console.log('\nSubagent conditional tests PASSED!');
} catch (err) {
    console.error('\nTest FAILED:', err.message);
    process.exit(1);
}
