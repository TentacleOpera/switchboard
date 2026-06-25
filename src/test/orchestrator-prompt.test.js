'use strict';

const assert = require('assert');
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');

const mockPlan = [
    { topic: 'test-epic', absolutePath: '/abs/path/to/epic.md' },
    { topic: '[SUBTASK] subtask-1', absolutePath: '/abs/path/to/sub1.md', isSubtask: true }
];

function testOrchestratorPromptTerseWithUltracode() {
    console.log('Testing orchestrator prompt is terse with ultracode...');
    const prompt = buildKanbanBatchPrompt('orchestrator', mockPlan, {
        ultracodeEnabled: true,
        epicDocLink: '.switchboard/plans/epic.md',
        switchboardSafeguardsEnabled: false,
        gitProhibitionEnabled: false,
        clearAntigravityContext: false,
        skipCompilation: false,
        skipTests: false,
        suppressWalkthroughEnabled: false
    });

    assert.ok(prompt.includes('use ultracode'), 'Prompt should include ultracode directive');
    assert.ok(prompt.includes('Read the epic and its subtasks at: .switchboard/plans/epic.md'), 'Prompt should link to the epic doc');
    assert.ok(!prompt.includes('PLANS TO PROCESS'), 'Prompt should not contain PLANS TO PROCESS section');
    assert.ok(!prompt.includes('subtask-1'), 'Prompt should not enumerate subtask path/topic');
    assert.ok(!prompt.includes('FOCUS DIRECTIVE'), 'Prompt should not contain FOCUS DIRECTIVE when safeguards are off');
    assert.ok(!prompt.includes('GIT POLICY'), 'Prompt should not contain GIT POLICY when git prohibition is off');
    console.log('  PASS: Orchestrator prompt is terse with ultracode');
}

function testOrchestratorAddonsToggle() {
    console.log('Testing orchestrator addons toggling on/off...');
    
    // Test safeguards (batch execution rules and focus directive)
    const promptWithSafeguards = buildKanbanBatchPrompt('orchestrator', mockPlan, {
        switchboardSafeguardsEnabled: true,
        gitProhibitionEnabled: false
    });
    assert.ok(promptWithSafeguards.includes('CRITICAL INSTRUCTIONS'), 'Should include batch execution rules when safeguards are on');
    assert.ok(promptWithSafeguards.includes('FOCUS DIRECTIVE'), 'Should include focus directive when safeguards are on');

    const promptWithoutSafeguards = buildKanbanBatchPrompt('orchestrator', mockPlan, {
        switchboardSafeguardsEnabled: false,
        gitProhibitionEnabled: false
    });
    assert.ok(!promptWithoutSafeguards.includes('CRITICAL INSTRUCTIONS'), 'Should not include batch execution rules when safeguards are off');
    assert.ok(!promptWithoutSafeguards.includes('FOCUS DIRECTIVE'), 'Should not include focus directive when safeguards are off');

    // Test Git Prohibition
    const promptWithGit = buildKanbanBatchPrompt('orchestrator', mockPlan, {
        switchboardSafeguardsEnabled: false,
        gitProhibitionEnabled: true
    });
    assert.ok(promptWithGit.includes('GIT POLICY'), 'Should include GIT POLICY when git prohibition is on');

    const promptWithoutGit = buildKanbanBatchPrompt('orchestrator', mockPlan, {
        switchboardSafeguardsEnabled: false,
        gitProhibitionEnabled: false
    });
    assert.ok(!promptWithoutGit.includes('GIT POLICY'), 'Should not include GIT POLICY when git prohibition is off');

    // Test Skip Compilation and Tests
    const promptWithSkip = buildKanbanBatchPrompt('orchestrator', mockPlan, {
        switchboardSafeguardsEnabled: false,
        gitProhibitionEnabled: false,
        skipCompilation: true,
        skipTests: true
    });
    assert.ok(promptWithSkip.includes('SKIP COMPILATION'), 'Should include SKIP COMPILATION');
    assert.ok(promptWithSkip.includes('SKIP TESTS'), 'Should include SKIP TESTS');

    console.log('  PASS: Orchestrator addons toggle works correctly');
}

try {
    testOrchestratorPromptTerseWithUltracode();
    testOrchestratorAddonsToggle();
    console.log('\nOrchestrator prompt tests passed!');
} catch (err) {
    console.error('\nOrchestrator prompt test failed:', err.message);
    process.exit(1);
}
