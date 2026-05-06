'use strict';

const assert = require('assert');
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');

const mockPlan = [
    { topic: 'test-plan', absolutePath: '/abs/path/to/test.md' }
];

function testDefaultPromptIsMinimal() {
    console.log('Testing default prompt is minimal...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        aggressivePairProgramming: false,
        dependencyCheckEnabled: false,
        gitProhibitionEnabled: true
    });

    assert.ok(prompt.includes('Read .agent/workflows/improve-plan.md and follow it step-by-step'), 'Prompt should start with minimal instruction');
    assert.ok(!prompt.includes('Complexity Audit'), 'Prompt should not include hardcoded Complexity Audit instruction');
    assert.ok(!prompt.includes('Metadata section'), 'Prompt should not include hardcoded Metadata section instruction');
    assert.ok(!prompt.includes('Scoring guide'), 'Prompt should not include hardcoded Scoring guide');
    assert.ok(prompt.includes('GIT POLICY'), 'Prompt should include git prohibition when enabled');
    console.log('  PASS: Default prompt is minimal');
}

function testAddOnsAreAppendedWhenEnabled() {
    console.log('Testing add-ons are appended when enabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        aggressivePairProgramming: true,
        dependencyCheckEnabled: true
    });

    assert.ok(prompt.includes('PAIR PROGRAMMING OPTIMISATION'), 'Prompt should include aggressive pair programming directive');
    assert.ok(prompt.includes('DEPENDENCY CHECK ENABLED'), 'Prompt should include dependency check directive');
    console.log('  PASS: Add-ons are appended when enabled');
}

function testGitProhibitionIncludedWhenEnabled() {
    console.log('Testing git prohibition is included when enabled (default)...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md'
    });

    assert.ok(prompt.includes('GIT POLICY'), 'Prompt should include git prohibition by default');
    console.log('  PASS: Git prohibition is included when enabled (default)');
}

function testGitProhibitionExcludedWhenDisabled() {
    console.log('Testing git prohibition is excluded when disabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        gitProhibitionEnabled: false
    });

    assert.ok(!prompt.includes('GIT POLICY'), 'Prompt should not include git prohibition when disabled');
    console.log('  PASS: Git prohibition is excluded when disabled');
}

function testDispatchContextAndPlanListAreIncluded() {
    console.log('Testing dispatch context and plan list are included...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md'
    });

    assert.ok(prompt.includes('PLANS TO PROCESS'), 'Prompt should include plan list section');
    assert.ok(prompt.includes('FOCUS DIRECTIVE'), 'Prompt should include focus directive');
    console.log('  PASS: Dispatch context and plan list are included');
}

function testDesignDocContentAppendedWhenProvided() {
    console.log('Testing design doc content is appended when provided...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        designDocContent: 'Pre-fetched Notion content here'
    });

    assert.ok(prompt.includes('DESIGN DOC REFERENCE (pre-fetched from Notion)'), 'Prompt should include design doc content reference');
    assert.ok(prompt.includes('Pre-fetched Notion content here'), 'Prompt should include the actual design doc content');
    console.log('  PASS: Design doc content is appended when provided');
}

function testWorkspaceTypeBlockIncludedForSingleRepo() {
    console.log('Testing workspace type block is included for single-repo...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        workspaceRoot: '/path/to/workspace'
    });

    assert.ok(prompt.includes('WORKSPACE TYPE: This workspace is single-repo'), 'Prompt should include single-repo workspace type block');
    console.log('  PASS: Workspace type block is included for single-repo');
}

function testBatchExecutionRulesIncludedForMultiPlan() {
    console.log('Testing batch execution rules are included for multi-plan dispatches...');
    const multiPlan = [
        { topic: 'plan-a', absolutePath: '/abs/path/to/a.md' },
        { topic: 'plan-b', absolutePath: '/abs/path/to/b.md' }
    ];
    const prompt = buildKanbanBatchPrompt('planner', multiPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md'
    });

    assert.ok(prompt.includes('CRITICAL INSTRUCTIONS'), 'Multi-plan prompt should include batch execution rules');
    assert.ok(prompt.includes('Treat each plan file path below as a completely isolated context'), 'Multi-plan prompt should include plan isolation instruction');
    console.log('  PASS: Batch execution rules are included for multi-plan dispatches');
}

function testBatchExecutionRulesExcludedForSinglePlan() {
    console.log('Testing batch execution rules are excluded for single-plan dispatches...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md'
    });

    assert.ok(!prompt.includes('CRITICAL INSTRUCTIONS'), 'Single-plan prompt should not include batch execution rules');
    console.log('  PASS: Batch execution rules are excluded for single-plan dispatches');
}

try {
    testDefaultPromptIsMinimal();
    testAddOnsAreAppendedWhenEnabled();
    testGitProhibitionIncludedWhenEnabled();
    testGitProhibitionExcludedWhenDisabled();
    testDispatchContextAndPlanListAreIncluded();
    testDesignDocContentAppendedWhenProvided();
    testWorkspaceTypeBlockIncludedForSingleRepo();
    testBatchExecutionRulesIncludedForMultiPlan();
    testBatchExecutionRulesExcludedForSinglePlan();
    console.log('\nAll tests passed!');
} catch (err) {
    console.error('\nTest failed:', err.message);
    process.exit(1);
}
