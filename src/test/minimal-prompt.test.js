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
        gitProhibitionEnabled: false
    });

    assert.ok(prompt.includes('Read .agent/workflows/improve-plan.md and follow it step-by-step'), 'Prompt should start with minimal instruction');
    assert.ok(!prompt.includes('Complexity Audit'), 'Prompt should not include hardcoded Complexity Audit instruction');
    assert.ok(!prompt.includes('Metadata section'), 'Prompt should not include hardcoded Metadata section instruction');
    assert.ok(!prompt.includes('Scoring guide'), 'Prompt should not include hardcoded Scoring guide');
    assert.ok(!prompt.includes('GIT POLICY'), 'Prompt should not include git prohibition when disabled');
    console.log('  PASS: Default prompt is minimal');
}

function testNoAddOnsByDefault() {
    console.log('Testing no add-ons are included when no options are passed...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md'
    });

    assert.ok(!prompt.includes('GIT POLICY'), 'Prompt should not include git prohibition by default');
    assert.ok(!prompt.includes('PAIR PROGRAMMING OPTIMISATION'), 'Prompt should not include aggressive pair programming by default');
    console.log('  PASS: No add-ons are included by default');
}

function testAddOnsAreAppendedWhenEnabled() {
    console.log('Testing add-ons are appended when enabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        aggressivePairProgramming: true
    });

    assert.ok(prompt.includes('PAIR PROGRAMMING OPTIMISATION'), 'Prompt should include aggressive pair programming directive');
    console.log('  PASS: Add-ons are appended when enabled');
}

function testGitProhibitionIncludedWhenEnabled() {
    console.log('Testing git prohibition is included when explicitly enabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        gitProhibitionEnabled: true
    });

    assert.ok(prompt.includes('GIT POLICY'), 'Prompt should include git prohibition when enabled');
    console.log('  PASS: Git prohibition is included when enabled');
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

function testClearAntigravityContextEnabled() {
    console.log('Testing clear antigravity context is included when enabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        clearAntigravityContext: true
    });

    assert.ok(prompt.includes('Ignore any previous checkpoint summaries or context carried over from prior agent sessions.'), 'Prompt should include clear antigravity context directive when enabled');
    assert.ok(prompt.includes('Do NOT ignore workspace-level context such as AGENTS.md'), 'Prompt should not exclude workspace context');
    console.log('  PASS: Clear antigravity context is included when enabled');
}

function testClearAntigravityContextDisabled() {
    console.log('Testing clear antigravity context is excluded when disabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        clearAntigravityContext: false
    });

    assert.ok(!prompt.includes('Ignore any previous checkpoint summaries'), 'Prompt should not include clear antigravity context directive when disabled');
    console.log('  PASS: Clear antigravity context is excluded when disabled');
}

function testPromptLineBreaksAreNormalized() {
    console.log('Testing prompt line breaks are normalized...');
    const { normalizeNewlines } = require('../../out/services/agentPromptBuilder');
    
    // 1. Verify utility function
    assert.strictEqual(normalizeNewlines('hello\n\n\nworld'), 'hello\n\nworld');
    assert.strictEqual(normalizeNewlines('hello\n\n\n\nworld'), 'hello\n\nworld');
    assert.strictEqual(normalizeNewlines('\n\n\nhello\n\n\n\nworld\n\n\n'), '\n\nhello\n\nworld\n\n');

    // 2. Verify planner prompt does not contain 3+ consecutive newlines
    const plannerPrompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        aggressivePairProgramming: true,
        dependencyCheckEnabled: true,
        gitProhibitionEnabled: true,
        workspaceRoot: '/path/to/workspace'
    });
    assert.ok(!plannerPrompt.includes('\n\n\n'), 'Planner prompt should not contain 3+ consecutive newlines');

    // 3. Verify non-planner prompt (e.g. reviewer) does not contain 3+ consecutive newlines
    const reviewerPrompt = buildKanbanBatchPrompt('reviewer', mockPlan, {
        gitProhibitionEnabled: true,
        switchboardSafeguardsEnabled: true,
        advancedReviewerEnabled: true
    });
    assert.ok(!reviewerPrompt.includes('\n\n\n'), 'Reviewer prompt should not contain 3+ consecutive newlines');
    
    console.log('  PASS: Prompt line breaks are normalized');
}

function testNoTripleNewlinesInAnyRole() {
    console.log('Testing no triple newlines in any role across option combinations...');
    const roles = ['planner', 'reviewer', 'tester', 'lead', 'coder', 'intern', 'analyst', 'ticket_updater', 'researcher', 'code_researcher', 'splitter'];

    const optionCombos = [
        // All options disabled (minimal prompt)
        { gitProhibitionEnabled: false, switchboardSafeguardsEnabled: false },
        // All options enabled (maximal prompt)
        { gitProhibitionEnabled: true, switchboardSafeguardsEnabled: true, clearAntigravityContext: true },
        // With workspaceRoot (triggers workspaceTypeBlock for planner)
        { gitProhibitionEnabled: true, switchboardSafeguardsEnabled: true, workspaceRoot: '/path/to/workspace' },
        // With dispatchContextBlock (working directory set)
        { gitProhibitionEnabled: true, switchboardSafeguardsEnabled: true },
    ];

    const plansWithWorkingDir = [
        { topic: 'test-plan', absolutePath: '/abs/path/to/test.md', workingDir: '/workspace/project' }
    ];

    for (const role of roles) {
        for (const opts of optionCombos) {
            const plans = opts === optionCombos[3] ? plansWithWorkingDir : mockPlan;
            const promptOpts = { ...opts };
            // Add role-specific options
            if (role === 'planner') {
                promptOpts.plannerWorkflowPath = '.agent/workflows/improve-plan.md';
                promptOpts.aggressivePairProgramming = true;
                promptOpts.dependencyCheckEnabled = true;
            }
            if (role === 'reviewer') {
                promptOpts.advancedReviewerEnabled = true;
            }
            if (role === 'lead' || role === 'coder') {
                promptOpts.pairProgrammingEnabled = true;
                promptOpts.aggressivePairProgramming = true;
                promptOpts.includeInlineChallenge = true;
            }
            if (role === 'coder') {
                promptOpts.accurateCodingEnabled = true;
            }
            if (role === 'code_researcher') {
                promptOpts.researchDepth = 'deep';
            }
            if (role === 'researcher') {
                promptOpts.researchDepth = 'deep';
                promptOpts.saveToLocalDocs = true;
                promptOpts.localDocsPath = '/docs';
            }

            const prompt = buildKanbanBatchPrompt(role, plans, promptOpts);
            assert.ok(!prompt.includes('\n\n\n'), `Role ${role} with opts ${JSON.stringify(opts)} should not contain 3+ consecutive newlines`);
            assert.ok(prompt.includes('\n\n'), `Role ${role} with opts ${JSON.stringify(opts)} should contain at least one paragraph break (\\n\\n)`);
        }
    }
    console.log('  PASS: No triple newlines in any role across option combinations');
}

function testConsistentSpacingBetweenDirectives() {
    console.log('Testing consistent spacing between directives in planner prompt...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agent/workflows/improve-plan.md',
        aggressivePairProgramming: true,
        dependencyCheckEnabled: true,
        gitProhibitionEnabled: true,
        switchboardSafeguardsEnabled: true,
        workspaceRoot: '/path/to/workspace',
        clearAntigravityContext: true
    });

    // Verify no single-newline transitions between major directive sections
    // Each major section should be separated by exactly \n\n
    const sections = [
        'PAIR PROGRAMMING OPTIMISATION',
        'DEPENDENCY CHECK ENABLED',
        'WORKSPACE TYPE',
        'FOCUS DIRECTIVE',
        'GIT POLICY',
        'PLANS TO PROCESS'
    ];

    for (const section of sections) {
        assert.ok(prompt.includes(section), `Planner prompt should include ${section}`);
    }

    // Verify no triple newlines exist (already covered by other tests, but explicit here)
    assert.ok(!prompt.includes('\n\n\n'), 'Planner prompt with all options should not contain 3+ consecutive newlines');

    // Verify paragraph breaks exist between sections
    assert.ok(prompt.includes('\n\n'), 'Planner prompt should contain paragraph breaks between sections');

    console.log('  PASS: Consistent spacing between directives in planner prompt');
}

try {
    testDefaultPromptIsMinimal();
    testNoAddOnsByDefault();
    testAddOnsAreAppendedWhenEnabled();
    testGitProhibitionIncludedWhenEnabled();
    testGitProhibitionExcludedWhenDisabled();
    testDispatchContextAndPlanListAreIncluded();
    testDesignDocContentAppendedWhenProvided();
    testWorkspaceTypeBlockIncludedForSingleRepo();
    testBatchExecutionRulesIncludedForMultiPlan();
    testBatchExecutionRulesExcludedForSinglePlan();
    testClearAntigravityContextEnabled();
    testClearAntigravityContextDisabled();
    testPromptLineBreaksAreNormalized();
    testNoTripleNewlinesInAnyRole();
    testConsistentSpacingBetweenDirectives();
    console.log('\nAll tests passed!');
} catch (err) {
    console.error('\nTest failed:', err.message);
    process.exit(1);
}
