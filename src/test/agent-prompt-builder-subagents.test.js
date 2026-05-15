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
    const alwaysRoles = ['reviewer', 'tester', 'lead', 'coder', 'intern', 'analyst'];
    for (const role of alwaysRoles) {
        const prompt = buildKanbanBatchPrompt(role, plans1);
        assert.ok(prompt.includes('GIT POLICY'), `Role ${role} SHOULD include git prohibition directive`);
    }
    // Planner: git prohibition is conditional (add-on), NOT included by default
    const plannerPromptDefault = buildKanbanBatchPrompt('planner', plans1);
    assert.ok(!plannerPromptDefault.includes('GIT POLICY'), 'Planner should NOT include git prohibition by default (it is an add-on)');
    const plannerPromptWithAddon = buildKanbanBatchPrompt('planner', plans1, { gitProhibitionEnabled: true });
    assert.ok(plannerPromptWithAddon.includes('GIT POLICY'), 'Planner SHOULD include git prohibition when add-on is enabled');
    console.log('  PASS: Git prohibition directive correct for all roles');
}

function testGitProhibitionDisabledForExecutionRoles() {
    console.log('Testing git prohibition is excluded when disabled for execution roles...');
    const executionRoles = ['lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst'];
    for (const role of executionRoles) {
        const prompt = buildKanbanBatchPrompt(role, plans1, { gitProhibitionEnabled: false });
        assert.ok(!prompt.includes('GIT POLICY'), `Role ${role} should NOT include git prohibition when gitProhibitionEnabled: false`);
    }
    console.log('  PASS: Git prohibition is excluded for execution roles when disabled');
}

function testChatCritiqueDirective() {
    console.log('Testing chat critique directive absence...');
    // No role should include the chat critique directive after the bugfix
    const allRoles = ['planner', 'reviewer', 'tester', 'lead', 'coder'];
    for (const role of allRoles) {
        const prompt = buildKanbanBatchPrompt(role, plans1);
        assert.ok(!prompt.includes(chatCritiqueText), `Role ${role} should NOT include chat critique directive`);
    }
    console.log('  PASS: Chat critique directive absent from all roles');
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
    const roles = ['planner', 'reviewer', 'tester', 'lead', 'coder', 'intern', 'analyst'];
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
    assert.ok(prompt.includes('CUSTOM CODER PROMPT'), 'Replace override should still replace the main prompt body');
    assert.ok(prompt.includes('WORKING DIRECTORY: /workspace/be'), 'Replace override should keep the working directory block');
    assert.ok(prompt.includes('PLANS TO PROCESS:\n- [plan-1] Plan File: /abs/path/to/1.md'), 'Replace override should keep the canonical plan list');
    console.log('  PASS: Replace overrides retain repo dispatch context');
}

function testPlannerRepoMetadataLine() {
    console.log('Testing planner repo metadata guidance...');
    // Without workspaceRoot, it should NOT include the block
    const prompt1 = buildKanbanBatchPrompt('planner', plans1);
    assert.ok(!prompt1.includes('WORKSPACE TYPE:'), 'Planner prompts should NOT include workspace type without workspaceRoot');
    
    // With workspaceRoot, it SHOULD include it
    const prompt2 = buildKanbanBatchPrompt('planner', plans1, { workspaceRoot: __dirname });
    assert.ok(prompt2.includes('WORKSPACE TYPE:'), 'Planner prompts SHOULD include workspace type with workspaceRoot');
    console.log('  PASS: Planner prompt includes workspace type guidance');
}

function testCustomWorkflowPathGeneratesMinimalPrompt() {
    console.log('Testing custom workflow path generates minimal prompt...');
    const customWorkflowPath = '.claude/get-shit-done/agents/gsd-planner.md';
    const prompt = buildKanbanBatchPrompt('planner', plans1, {
        plannerWorkflowPath: customWorkflowPath
    });
    assert.ok(prompt.includes(`Read ${customWorkflowPath} and follow it step-by-step`), 'Custom workflow should generate minimal "Read and follow" prompt');
    assert.ok(!prompt.includes('Please improve the following'), 'Custom workflow should NOT include full Switchboard prompt');
    assert.ok(!prompt.includes('## Complexity Audit'), 'Custom workflow should NOT include Switchboard-specific sections');
    console.log('  PASS: Custom workflow path generates minimal prompt');
}

function testDefaultWorkflowPathGeneratesMinimalPrompt() {
    console.log('Testing default workflow path generates minimal prompt...');
    const prompt = buildKanbanBatchPrompt('planner', plans1, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md'
    });
    assert.ok(prompt.includes('Read .agent/workflows/improve-plan.md and follow it step-by-step'), 'Default workflow should generate minimal "Read and follow" prompt');
    assert.ok(!prompt.includes('Please improve the following'), 'Default workflow should NOT include old full Switchboard prompt text');
    assert.ok(!prompt.includes('## Complexity Audit'), 'Default workflow should NOT include hardcoded Switchboard-specific sections');
    console.log('  PASS: Default workflow path generates minimal prompt');
}

function testCustomWorkflowWithAddons() {
    console.log('Testing custom workflow with add-ons...');
    const customWorkflowPath = '.claude/superpowers/skills/writing-plans.md';
    const prompt = buildKanbanBatchPrompt('planner', plans1, {
        plannerWorkflowPath: customWorkflowPath,
        aggressivePairProgramming: true,
        dependencyCheckEnabled: true
    });
    assert.ok(prompt.includes(`Read ${customWorkflowPath} and follow it step-by-step`), 'Custom workflow should generate minimal "Read and follow" prompt');
    assert.ok(prompt.includes('PAIR PROGRAMMING OPTIMISATION'), 'Custom workflow should append aggressive pair programming add-on');
    assert.ok(prompt.includes('[DEPENDENCY CHECK ENABLED]'), 'Custom workflow should append dependency check add-on');
    console.log('  PASS: Custom workflow with add-ons appends add-on instructions');
}

function testSplitPlanDefaultDisabled() {
    console.log('Testing split plan default disabled...');
    const prompt = buildKanbanBatchPrompt('planner', plans1, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md'
    });
    assert.ok(!prompt.includes('SPLIT PLAN'), 'Default planner prompt should NOT include "SPLIT PLAN"');
    assert.ok(!prompt.includes('_routine.md'), 'Default planner prompt should NOT include "_routine.md"');
    console.log('  PASS: Default planner prompt excludes split-plan directives');
}

function testSplitPlanEnabledDefaultWorkflow() {
    console.log('Testing split plan enabled with default workflow...');
    const prompt = buildKanbanBatchPrompt('planner', plans1, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        splitPlan: true
    });
    assert.ok(prompt.includes('SPLIT PLAN MODE'), 'Split-plan enabled prompt should include "SPLIT PLAN MODE"');
    assert.ok(prompt.includes('_routine.md'), 'Split-plan enabled prompt should include "_routine.md"');
    console.log('  PASS: Split-plan enabled with default workflow includes full split directives');
}

function testSplitPlanEnabledCustomWorkflow() {
    console.log('Testing split plan enabled with custom workflow...');
    const customWorkflowPath = '.claude/superpowers/skills/writing-plans.md';
    const prompt = buildKanbanBatchPrompt('planner', plans1, {
        plannerWorkflowPath: customWorkflowPath,
        splitPlan: true
    });
    assert.ok(prompt.includes('SPLIT PLAN MODE'), 'Split-plan enabled with custom workflow should include "SPLIT PLAN MODE"');
    assert.ok(prompt.includes('_routine.md'), 'Split-plan enabled with custom workflow should include "_routine.md"');
    assert.ok(prompt.includes(`Read ${customWorkflowPath} and follow it step-by-step`), 'Custom workflow should still generate minimal "Read and follow" prompt');
    console.log('  PASS: Split-plan enabled with custom workflow includes concise split directive');
}

function testSplitPlanWithAggressivePairProgramming() {
    console.log('Testing split plan with aggressive pair programming...');
    const prompt = buildKanbanBatchPrompt('planner', plans1, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        splitPlan: true,
        aggressivePairProgramming: true
    });
    assert.ok(prompt.includes('SPLIT PLAN MODE'), 'Prompt with both options should include "SPLIT PLAN MODE"');
    assert.ok(prompt.includes('PAIR PROGRAMMING OPTIMISATION'), 'Prompt with both options should include "PAIR PROGRAMMING OPTIMISATION"');
    assert.ok(prompt.includes('_routine.md'), 'Prompt with both options should include "_routine.md"');
    console.log('  PASS: Split-plan and aggressive pair programming can coexist without contradiction');
}

function testInternAnalystPrompts() {
    console.log('Testing intern and analyst prompt templates...');
    const internPrompt = buildKanbanBatchPrompt('intern', plans1);
    const analystPrompt = buildKanbanBatchPrompt('analyst', plans1);
    
    assert.ok(internPrompt.includes('Please process the following 1 plans.'), 'Intern prompt should start with processing plans');
    assert.ok(analystPrompt.includes('Please process the following 1 plans.'), 'Analyst prompt should start with processing plans');
    assert.strictEqual(internPrompt, analystPrompt, 'Intern and analyst prompts should be identical in initial state');
    
    assert.ok(internPrompt.includes('GIT POLICY'), 'Intern prompt should include GIT POLICY');
    assert.ok(analystPrompt.includes('GIT POLICY'), 'Analyst prompt should include GIT POLICY');
    console.log('  PASS: Intern and analyst prompt templates correctly implemented');
}

function testUnknownRoleThrows() {
    console.log('Testing unknown role throws error...');
    assert.throws(() => {
        buildKanbanBatchPrompt('unknown_role', plans1);
    }, /Unknown role 'unknown_role' in buildKanbanBatchPrompt/, 'Should throw error for unknown roles');
    console.log('  PASS: Unknown role correctly throws error');
}

try {
    testSinglePlan();
    testMultiplePlans();
    testExecutionDirective();
    testGitProhibitionDirective();
    testGitProhibitionDisabledForExecutionRoles();
    testChatCritiqueDirective();
    testNoRepoContextForUnscopedPlans();
    testSingleWorkingDirectoryContext();
    testMixedWorkingDirectoryContext();
    testPartiallyScopedWorkingDirectoryContext();
    testReplaceOverrideKeepsRepoContext();
    testPlannerRepoMetadataLine();
    testCustomWorkflowPathGeneratesMinimalPrompt();
    testDefaultWorkflowPathGeneratesMinimalPrompt();
    testCustomWorkflowWithAddons();
    testSplitPlanDefaultDisabled();
    testSplitPlanEnabledDefaultWorkflow();
    testSplitPlanEnabledCustomWorkflow();
    testSplitPlanWithAggressivePairProgramming();
    testInternAnalystPrompts();
    testUnknownRoleThrows();
    console.log('\nSubagent conditional tests PASSED!');
} catch (err) {
    console.error('\nTest FAILED:', err.message);
    process.exit(1);
}
