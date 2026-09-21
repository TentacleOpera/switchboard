'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');
const { ProtocolService } = require('../../out/services/ProtocolService');

const mockPlan = [
    { topic: 'test-plan', absolutePath: '/abs/path/to/test.md' }
];

function testDefaultPromptIsMinimal() {
    console.log('Testing default prompt is minimal...');
    // The shipped default is the bare protocol name 'improve-plan'; dispatch
    // resolves it via resolvedProtocols and the builder inlines the body.
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: 'improve-plan',
        resolvedProtocols: { 'improve-plan': { name: 'improve-plan', body: 'STUB IMPROVE-PLAN BODY', delivery: 'inline' } },
        aggressivePairProgramming: false,
        gitProhibitionEnabled: false
    });

    assert.ok(prompt.includes('Read and follow the workflow below step-by-step.'), 'Prompt should start with minimal instruction');
    assert.ok(prompt.includes('--- BEGIN PROTOCOL improve-plan ---'), 'Prompt should inline the improve-plan protocol body');
    assert.ok(prompt.includes('STUB IMPROVE-PLAN BODY'), 'Prompt should contain the resolved protocol body');
    assert.ok(!prompt.includes('Read .agents/protocols/'), 'Prompt must not contain a dead "Read <path>" instruction for the default workflow');
    assert.ok(!prompt.includes('Complexity Audit'), 'Prompt should not include hardcoded Complexity Audit instruction');
    assert.ok(!prompt.includes('Metadata section'), 'Prompt should not include hardcoded Metadata section instruction');
    assert.ok(!prompt.includes('Scoring guide'), 'Prompt should not include hardcoded Scoring guide');
    assert.ok(!prompt.includes('GIT POLICY'), 'Prompt should not include git prohibition when disabled');
    console.log('  PASS: Default prompt is minimal');
}

function testNoAddOnsByDefault() {
    console.log('Testing no add-ons are included when no options are passed...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: 'improve-plan'
    });

    assert.ok(!prompt.includes('GIT POLICY'), 'Prompt should not include git prohibition by default');
    assert.ok(!prompt.includes('PAIR PROGRAMMING OPTIMISATION'), 'Prompt should not include aggressive pair programming by default');
    console.log('  PASS: No add-ons are included by default');
}

function testAddOnsAreAppendedWhenEnabled() {
    console.log('Testing add-ons are appended when enabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: 'improve-plan',
        aggressivePairProgramming: true
    });

    assert.ok(prompt.includes('PAIR PROGRAMMING OPTIMISATION'), 'Prompt should include aggressive pair programming directive');
    console.log('  PASS: Add-ons are appended when enabled');
}

function testGitProhibitionIncludedWhenEnabled() {
    console.log('Testing git prohibition is included when explicitly enabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: 'improve-plan',
        gitProhibitionEnabled: true
    });

    assert.ok(prompt.includes('GIT POLICY'), 'Prompt should include git prohibition when enabled');
    console.log('  PASS: Git prohibition is included when enabled');
}

function testGitProhibitionExcludedWhenDisabled() {
    console.log('Testing git prohibition is excluded when disabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: 'improve-plan',
        gitProhibitionEnabled: false
    });

    assert.ok(!prompt.includes('GIT POLICY'), 'Prompt should not include git prohibition when disabled');
    console.log('  PASS: Git prohibition is excluded when disabled');
}

function testDispatchContextAndPlanListAreIncluded() {
    console.log('Testing dispatch context and plan list are included...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: 'improve-plan'
    });

    assert.ok(prompt.includes('PLANS TO PROCESS'), 'Prompt should include plan list section');
    assert.ok(prompt.includes('FOCUS:'), 'Prompt should include focus directive');
    console.log('  PASS: Dispatch context and plan list are included');
}



function testWorkspaceTypeBlockIncludedForSingleRepo() {
    console.log('Testing workspace type block is included for single-repo...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: 'improve-plan',
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
        plannerWorkflowPath: 'improve-plan'
    });

    assert.ok(prompt.includes('CRITICAL INSTRUCTIONS'), 'Multi-plan prompt should include batch execution rules');
    assert.ok(prompt.includes('Treat each plan file path below as a completely isolated context'), 'Multi-plan prompt should include plan isolation instruction');
    console.log('  PASS: Batch execution rules are included for multi-plan dispatches');
}

function testBatchExecutionRulesExcludedForSinglePlan() {
    console.log('Testing batch execution rules are excluded for single-plan dispatches...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: 'improve-plan'
    });

    assert.ok(!prompt.includes('CRITICAL INSTRUCTIONS'), 'Single-plan prompt should not include batch execution rules');
    console.log('  PASS: Batch execution rules are excluded for single-plan dispatches');
}

function testClearAntigravityContextEnabled() {
    console.log('Testing clear antigravity context is included when enabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: 'improve-plan',
        clearAntigravityContext: true
    });

    assert.ok(prompt.includes('Ignore any previous checkpoint summaries or context carried over from prior agent sessions.'), 'Prompt should include clear antigravity context directive when enabled');
    assert.ok(prompt.includes('Do NOT ignore workspace-level context such as AGENTS.md'), 'Prompt should not exclude workspace context');
    console.log('  PASS: Clear antigravity context is included when enabled');
}

function testClearAntigravityContextDisabled() {
    console.log('Testing clear antigravity context is excluded when disabled...');
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: 'improve-plan',
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
        plannerWorkflowPath: 'improve-plan',
        aggressivePairProgramming: true,
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
    const roles = ['planner', 'reviewer', 'tester', 'lead', 'coder', 'intern', 'analyst', 'ticket_updater', 'researcher'];

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
                promptOpts.plannerWorkflowPath = 'improve-plan';
                promptOpts.aggressivePairProgramming = true;
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
        plannerWorkflowPath: 'improve-plan',
        aggressivePairProgramming: true,
        gitProhibitionEnabled: true,
        switchboardSafeguardsEnabled: true,
        workspaceRoot: '/path/to/workspace',
        clearAntigravityContext: true
    });

    // Verify no single-newline transitions between major directive sections
    // Each major section should be separated by exactly \n\n
    const sections = [
        'PAIR PROGRAMMING OPTIMISATION',
        'WORKSPACE TYPE',
        'FOCUS:',
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

/**
 * The planner default is a bare protocol NAME, so the body a planner reads is
 * whatever resolveProtocol returns — no longer the file the old `Read <path>`
 * instruction named. `ClaudeCodeMirrorService` deliberately preserves an
 * operator-edited `.agents/protocols/improve-plan/SKILL.md` (it writes
 * `<file>.local.bak` and skips the overwrite), so resolution MUST prefer that
 * file, and MUST say which store answered — an inlined shipped body and an
 * inlined edited body read identically.
 */
async function testWorkspaceFileOutranksTheShippedBody() {
    console.log('Testing an operator-edited protocol file outranks the shipped body...');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-protosrc-'));
    const skillDir = path.join(tmp, '.agents', 'protocols', 'improve-plan');
    fs.mkdirSync(skillDir, { recursive: true });
    const SENTINEL = '# Improve Plan\n\nOPERATOR EDIT SENTINEL — this line exists only on disk.\n';
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SENTINEL, 'utf8');

    const edited = await ProtocolService.resolveProtocol('improve-plan', tmp);
    assert.ok(edited, 'improve-plan must resolve when a workspace file exists');
    assert.strictEqual(edited.source, 'workspace-file', 'An existing .agents/protocols file must be the answering store');
    assert.ok(edited.body.includes('OPERATOR EDIT SENTINEL'), 'The resolved body must be the operator-edited file, not the shipped body');

    fs.rmSync(path.join(skillDir, 'SKILL.md'));
    const shipped = await ProtocolService.resolveProtocol('improve-plan', tmp);
    assert.ok(shipped, 'improve-plan must still resolve with no workspace file');
    assert.notStrictEqual(shipped.source, 'workspace-file', 'With no workspace file the source must name the registry/bundle, not the file');
    assert.ok(!shipped.body.includes('OPERATOR EDIT SENTINEL'), 'The shipped body must not carry the removed workspace edit');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  PASS: Workspace protocol file outranks the shipped body, and the source is recorded');
}

try {
    testDefaultPromptIsMinimal();
    testNoAddOnsByDefault();
    testAddOnsAreAppendedWhenEnabled();
    testGitProhibitionIncludedWhenEnabled();
    testGitProhibitionExcludedWhenDisabled();
    testDispatchContextAndPlanListAreIncluded();

    testWorkspaceTypeBlockIncludedForSingleRepo();
    testBatchExecutionRulesIncludedForMultiPlan();
    testBatchExecutionRulesExcludedForSinglePlan();
    testClearAntigravityContextEnabled();
    testClearAntigravityContextDisabled();
    testPromptLineBreaksAreNormalized();
    testNoTripleNewlinesInAnyRole();
    testConsistentSpacingBetweenDirectives();
} catch (err) {
    console.error('\nTest failed:', err.message);
    process.exit(1);
}

testWorkspaceFileOutranksTheShippedBody()
    .then(() => { console.log('\nAll tests passed!'); })
    .catch((err) => { console.error('\nTest failed:', err.message); process.exit(1); });
