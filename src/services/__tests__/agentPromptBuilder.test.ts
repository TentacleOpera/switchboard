import * as assert from 'assert';
import { buildKanbanBatchPrompt, columnToPromptRole } from '../agentPromptBuilder';

suite('agentPromptBuilder', () => {
    const makePlans = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
            topic: `Test Plan ${i + 1}`,
            absolutePath: `/workspace/plan_${i + 1}.md`
        }));

    const makeFeaturePlans = () => [
        { topic: 'Test Feature', absolutePath: '/workspace/.switchboard/features/test-feature.md', isFeature: true, sessionId: 'feature-1' },
        { topic: 'Subtask A', absolutePath: '/workspace/.switchboard/plans/sub-a.md', isSubtask: true, featureTopic: 'Test Feature', featureId: 'feature-1', sessionId: 'st-1' },
        { topic: 'Subtask B', absolutePath: '/workspace/.switchboard/plans/sub-b.md', isSubtask: true, featureTopic: 'Test Feature', featureId: 'feature-1', sessionId: 'st-2' },
    ];

    suite('buildKanbanBatchPrompt — coder role', () => {
        test('accurateCodingEnabled: true injects Accuracy Mode instructions', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                accurateCodingEnabled: true
            });
            assert.ok(prompt.includes('Accuracy Mode'), 'Should include Accuracy Mode header');
            assert.ok(prompt.includes('.agents/skills/accuracy/SKILL.md'), 'Should include reference to accuracy workflow');
        });

        test('accurateCodingEnabled: false omits Accuracy Mode instructions', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                accurateCodingEnabled: false
            });
            assert.ok(!prompt.includes('Accuracy Mode'), 'Should not include Accuracy Mode header');
        });

        test('omits source column label even when provided', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(2), {
                sourceColumnLabel: 'Planned'
            });
            assert.ok(!prompt.includes('from the Planned column'), 'Should NOT include source column label');
            assert.ok(!prompt.includes('from the'), 'Should NOT contain "from the" at all');
            assert.ok(prompt.includes('Please execute the 2 plans below.'), 'Should have clean intro');
        });

        test('omits source column label when not provided', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(2), {});
            assert.ok(!prompt.includes('from the'), 'Should not include "from the" when no sourceColumnLabel');
            assert.ok(prompt.includes('Please execute the 2 plans below.'), 'Should have default intro');
        });

        test('omits complexity and source column for low-complexity coder prompt', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                instruction: 'low-complexity',
                sourceColumnLabel: 'TEST'
            });
            assert.ok(!prompt.includes('from the TEST column'), 'Should NOT include source column label');
            assert.ok(!prompt.includes('low-complexity'), 'Should NOT include low-complexity text');
            assert.ok(prompt.includes('Please execute the plan below.'), 'Should have clean intro');
        });
    });

    suite('buildKanbanBatchPrompt — lead role', () => {
        test('omits source column label even when provided', () => {
            const prompt = buildKanbanBatchPrompt('lead', makePlans(2), {
                sourceColumnLabel: 'Planned'
            });
            assert.ok(!prompt.includes('from the Planned column'), 'Should NOT include source column label');
            assert.ok(prompt.includes('Please execute the 2 plans below.'), 'Should have clean intro');
        });

        test('omits source column label when not provided', () => {
            const prompt = buildKanbanBatchPrompt('lead', makePlans(2), {});
            assert.ok(!prompt.includes('from the'), 'Should not include "from the" when no sourceColumnLabel');
            assert.ok(prompt.includes('Please execute the 2 plans below.'), 'Should have default intro');
        });
    });

    suite('buildKanbanBatchPrompt — overrides & context flags', () => {
        test('clearAntigravityContext: true injects antigravity block', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                clearAntigravityContext: true
            });
            assert.ok(prompt.includes('Ignore any previous checkpoint summaries'), 'Should include checkpoint summaries instruction');
            assert.ok(!prompt.includes('no historical context'), 'Should not include overly broad language');
        });

        test('clearAntigravityContext: false omits antigravity block', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                clearAntigravityContext: false
            });
            assert.ok(!prompt.includes('Ignore any previous checkpoint summaries'), 'Should omit checkpoint summaries instruction');
        });

        test('clearAntigravityContext: undefined omits antigravity block', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {});
            assert.ok(!prompt.includes('Ignore any previous checkpoint summaries'), 'Should omit checkpoint summaries instruction');
        });

        test('replace mode preserves role framing (intro, execution mode, plan list)', () => {
            const overrideText = 'Focus only on security vulnerabilities.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(2), {
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'replace' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes('Execute a direct reviewer pass in-place for each plan'), 'Should preserve reviewer execution intro');
            assert.ok(prompt.includes(overrideText), 'Should include replace override text');
            assert.ok(prompt.includes('PLANS TO PROCESS'), 'Should preserve plan list header');
        });

        test('prepend mode adds override before base instructions', () => {
            const defaultBaseText = 'For each plan:';
            const overrideText = 'Prepend this.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'prepend' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            const prependIndex = prompt.indexOf(overrideText);
            const baseIndex = prompt.indexOf(defaultBaseText);
            assert.ok(prependIndex < baseIndex, 'Prepend text should appear before default base instructions');
        });

        test('append mode adds override after base instructions', () => {
            const defaultBaseText = 'For each plan:';
            const overrideText = 'Append this.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'append' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            const baseIndex = prompt.indexOf(defaultBaseText);
            const appendIndex = prompt.indexOf(overrideText);
            assert.ok(baseIndex < appendIndex, 'Append text should appear after default base instructions');
        });

        test('advanced reviewer add-on is injected with default base instructions', () => {
            const defaultBaseText = 'For each plan:';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                advancedReviewerEnabled: true,
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes(defaultBaseText), 'Should include default base instructions');
            assert.ok(prompt.includes('ADVANCED REGRESSION ANALYSIS'), 'Should include advanced reviewer directive');
        });

        test('cavemanOutputEnabled: true injects caveman directive', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                cavemanOutputEnabled: true
            });
            assert.ok(prompt.includes('CAVEMAN MODE'), 'Should include CAVEMAN MODE directive');
        });

        test('cavemanOutputEnabled: false omits caveman directive', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                cavemanOutputEnabled: false
            });
            assert.ok(!prompt.includes('CAVEMAN MODE'), 'Should NOT include CAVEMAN MODE directive');
        });

        test('cavemanOutputEnabled: undefined omits caveman directive', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {});
            assert.ok(!prompt.includes('CAVEMAN MODE'), 'Should NOT include CAVEMAN MODE directive');
        });
    });

    suite('adviseResearchIfUnsure option', () => {
        test('adviseResearchIfUnsure: true includes research directive', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { adviseResearchIfUnsure: true });
            assert.ok(prompt.includes('RESEARCH WHEN UNSURE:'), 'Should include research directive');
            assert.ok(prompt.includes('.agents/skills/advise_research/SKILL.md'), 'Should include path to skill file');
        });

        test('adviseResearchIfUnsure: false omits research directive', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { adviseResearchIfUnsure: false });
            assert.ok(!prompt.includes('RESEARCH WHEN UNSURE:'), 'Should NOT include research directive');
        });

        test('adviseResearchIfUnsure: undefined includes research directive (default ON)', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), {});
            assert.ok(prompt.includes('RESEARCH WHEN UNSURE:'), 'Should include research directive by default');
            assert.ok(prompt.includes('.agents/skills/advise_research/SKILL.md'), 'Should include path to skill file');
        });
    });

    suite('writeFeatureDescriptionIfEmpty option', () => {
        test('writeFeatureDescriptionIfEmpty: true + featureMode includes feature description directive', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { writeFeatureDescriptionIfEmpty: true, featureMode: true });
            assert.ok(prompt.includes('FEATURE DESCRIPTION BACKFILL:'), 'Should include feature description directive');
            assert.ok(prompt.includes('## Goal'), 'Should reference Goal section');
            assert.ok(prompt.includes('## How the Subtasks Achieve This'), 'Should reference How the Subtasks Achieve This section');
            assert.ok(prompt.includes('## Dependencies & sequencing'), 'Should reference Dependencies & sequencing section');
        });

        test('writeFeatureDescriptionIfEmpty: false + featureMode omits feature description directive', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { writeFeatureDescriptionIfEmpty: false, featureMode: true });
            assert.ok(!prompt.includes('FEATURE DESCRIPTION BACKFILL:'), 'Should NOT include feature description directive');
        });

        test('writeFeatureDescriptionIfEmpty: true without featureMode omits directive (non-feature dispatch unaffected)', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { writeFeatureDescriptionIfEmpty: true });
            assert.ok(!prompt.includes('FEATURE DESCRIPTION BACKFILL:'), 'Should NOT include feature description directive for non-feature dispatch');
        });

        test('writeFeatureDescriptionIfEmpty: undefined + featureMode includes feature description directive (default ON)', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { featureMode: true });
            assert.ok(prompt.includes('FEATURE DESCRIPTION BACKFILL:'), 'Should include feature description directive by default in feature mode');
        });
    });

    suite('columnToPromptRole', () => {
        test('maps CREATED to planner', () => {
            assert.strictEqual(columnToPromptRole('CREATED'), 'planner');
        });

        test('maps PLAN REVIEWED to lead', () => {
            assert.strictEqual(columnToPromptRole('PLAN REVIEWED'), 'lead');
        });

        test('maps LEAD CODED to reviewer', () => {
            assert.strictEqual(columnToPromptRole('LEAD CODED'), 'reviewer');
        });

        test('maps CODER CODED to reviewer', () => {
            assert.strictEqual(columnToPromptRole('CODER CODED'), 'reviewer');
        });

        test('maps INTERN CODED to reviewer', () => {
            assert.strictEqual(columnToPromptRole('INTERN CODED'), 'reviewer');
        });

        test('maps CODE REVIEWED to tester', () => {
            assert.strictEqual(columnToPromptRole('CODE REVIEWED'), 'tester');
        });

        test('maps RESEARCHER to researcher', () => {
            assert.strictEqual(columnToPromptRole('RESEARCHER'), 'researcher');
        });

        test('maps TICKET UPDATER to ticket_updater', () => {
            assert.strictEqual(columnToPromptRole('TICKET UPDATER'), 'ticket_updater');
        });

        test('maps CODED to reviewer (legacy normalization)', () => {
            assert.strictEqual(columnToPromptRole('CODED'), 'reviewer');
        });

        test('returns custom_agent roles as-is', () => {
            assert.strictEqual(columnToPromptRole('custom_agent_devin'), 'custom_agent_devin');
        });

        test('returns null for unknown columns', () => {
            assert.strictEqual(columnToPromptRole('UNKNOWN_COLUMN'), null);
        });
    });

    suite('§9 regression — lean dispatch prompts', () => {


        test('no [SUBTASK] [SUBTASK] double-labelling in feature-mode planner prompt', () => {
            const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(!prompt.includes('[SUBTASK] [SUBTASK]'), 'Feature prompt must not contain double [SUBTASK] labelling');
        });

        test('no [SUBTASK] [SUBTASK] double-labelling in feature-mode coder prompt', () => {
            const prompt = buildKanbanBatchPrompt('coder', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(!prompt.includes('[SUBTASK] [SUBTASK]'), 'Feature coder prompt must not contain double [SUBTASK] labelling');
        });

        test('no batchExecutionRules in single-plan coder prompt', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {});
            assert.ok(!prompt.includes('CRITICAL INSTRUCTIONS:'), 'Single-plan prompt must not include batch execution rules');
        });

        test('no batchExecutionRules in feature-mode coder prompt', () => {
            const prompt = buildKanbanBatchPrompt('coder', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(!prompt.includes('CRITICAL INSTRUCTIONS:'), 'Feature-mode coder prompt must not include batch execution rules');
        });

        test('feature-mode coder prompt contains FEATURE FILE reference and no per-subtask plan lines', () => {
            const prompt = buildKanbanBatchPrompt('coder', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(prompt.includes('FEATURE FILE:'), 'Feature-mode coder prompt should contain FEATURE FILE reference');
            assert.ok(!prompt.includes('Subtask A Plan File:'), 'Feature-mode coder prompt should not enumerate per-subtask plan lines');
            assert.ok(!prompt.includes('Subtask B Plan File:'), 'Feature-mode coder prompt should not enumerate per-subtask plan lines');
        });

        test('single worktree path appears exactly once in worktree dispatch', () => {
            const plans = [{ topic: 'Plan A', absolutePath: '/workspace/plan-a.md', worktreePath: '/workspace/wt-a' }];
            const prompt = buildKanbanBatchPrompt('coder', plans, { gitProhibitionEnabled: false });
            const occurrences = (prompt.match(/\/workspace\/wt-a/g) || []).length;
            assert.strictEqual(occurrences, 1, `Worktree path should appear exactly once, found ${occurrences}`);
        });
    });

    suite('feature-aware workflow routing', () => {
        test('feature-mode planner prompt uses improve-feature workflow path', () => {
            const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(prompt.includes('Read .agents/skills/improve-feature/SKILL.md and follow it step-by-step'), 'Should route to improve-feature SKILL.md');
            assert.ok(!prompt.includes('improve-plan.md'), 'Should NOT include improve-plan.md');
        });

        test('isFeature on plan (no subtasks) uses improve-feature workflow path', () => {
            const prompt = buildKanbanBatchPrompt('planner', [{ topic: 'Lonely Feature', absolutePath: '/workspace/.switchboard/features/lonely.md', isFeature: true }], {});
            assert.ok(prompt.includes('Read .agents/skills/improve-feature/SKILL.md and follow it step-by-step'), 'Should route to improve-feature SKILL.md');
        });

        test('feature-mode overrides custom plannerWorkflowPath', () => {
            const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, plannerWorkflowPath: '.custom/workflows/my-planner.md' });
            assert.ok(prompt.includes('improve-feature.md'), 'Should use improve-feature.md');
            assert.ok(!prompt.includes('.custom/workflows/my-planner.md'), 'Should override custom plannerWorkflowPath');
        });

        test('non-feature planner prompt still uses configured workflow path (regression)', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { plannerWorkflowPath: '.agents/skills/improve-plan/SKILL.md' });
            assert.ok(prompt.includes('improve-plan/SKILL.md'), 'Should use default/configured plan workflow');
        });

        test('workflowFilePathEnabled: false emits no workflow path for feature-mode (regression)', () => {
            const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, workflowFilePathEnabled: false });
            assert.ok(!prompt.includes('improve-feature.md'), 'Should NOT include improve-feature.md when workflowFilePathEnabled is false');
            assert.ok(!prompt.includes('improve-plan.md'), 'Should NOT include improve-plan.md when workflowFilePathEnabled is false');
        });
    });
});
