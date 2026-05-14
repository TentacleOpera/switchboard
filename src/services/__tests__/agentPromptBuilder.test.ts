import * as assert from 'assert';
import { buildKanbanBatchPrompt, columnToPromptRole } from '../agentPromptBuilder';

suite('agentPromptBuilder', () => {
    const makePlans = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
            topic: `Test Plan ${i + 1}`,
            absolutePath: `/workspace/plan_${i + 1}.md`
        }));

    describe('buildKanbanBatchPrompt — coder role', () => {
        test('includes source column label when provided', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(2), {
                sourceColumnLabel: 'Planned'
            });
            assert.ok(prompt.includes('from the Planned column'), 'Should include source column label');
            assert.ok(!prompt.includes('from PLAN REVIEWED'), 'Should NOT contain hardcoded PLAN REVIEWED');
        });

        test('omits source column label when not provided', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(2), {});
            assert.ok(!prompt.includes('from the'), 'Should not include "from the" when no sourceColumnLabel');
            assert.ok(prompt.includes('Please execute the following 2 plans.'), 'Should have default intro');
        });

        test('includes source column label for low-complexity coder prompt', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                instruction: 'low-complexity',
                sourceColumnLabel: 'TEST'
            });
            assert.ok(prompt.includes('from the TEST column'), 'Should include source column label for low-complexity');
            assert.ok(prompt.includes('low-complexity'), 'Should include low-complexity text');
        });
    });

    describe('buildKanbanBatchPrompt — lead role', () => {
        test('includes source column label when provided', () => {
            const prompt = buildKanbanBatchPrompt('lead', makePlans(2), {
                sourceColumnLabel: 'Planned'
            });
            assert.ok(prompt.includes('from the Planned column'), 'Should include source column label');
        });

        test('omits source column label when not provided', () => {
            const prompt = buildKanbanBatchPrompt('lead', makePlans(2), {});
            assert.ok(!prompt.includes('from the'), 'Should not include "from the" when no sourceColumnLabel');
            assert.ok(prompt.includes('Please execute the following 2 plans.'), 'Should have default intro');
        });
    });

    describe('buildKanbanBatchPrompt — personaContent & overrides', () => {
        test('uses personaContent as base instructions when no override exists', () => {
            const persona = 'You are a specialized security reviewer. Focus on OWASP and injection risks.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                personaContent: persona,
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes(persona), 'Should include personaContent as base instructions');
            assert.ok(prompt.includes('assess the actual code changes'), 'Should preserve execution mode line');
            assert.ok(prompt.includes('PLANS TO PROCESS'), 'Should preserve plan list');
        });

        test('replace override takes precedence over personaContent', () => {
            const persona = 'You are a specialized security reviewer.';
            const overrideText = 'Custom reviewer instructions here.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                personaContent: persona,
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'replace' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes(overrideText), 'Should include replace override text');
            assert.ok(!prompt.includes(persona), 'Should NOT include personaContent when replace override exists');
            assert.ok(prompt.includes('assess the actual code changes'), 'Should preserve execution mode line');
            assert.ok(prompt.includes('PLANS TO PROCESS'), 'Should preserve plan list');
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

        test('falls back to hardcoded default when personaContent is empty string', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                personaContent: '',
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes('For each plan:'), 'Should use hardcoded default base instructions');
            assert.ok(prompt.includes('Stage 1 (Grumpy)'), 'Should include default Stage 1 instruction');
        });

        test('falls back to personaContent when override text is empty string', () => {
            const persona = 'Custom persona text.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                personaContent: persona,
                defaultPromptOverrides: { reviewer: { text: '', mode: 'replace' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes(persona), 'Should fall back to personaContent when override text is empty');
        });

        test('prepend mode adds override before base instructions', () => {
            const persona = 'Base persona.';
            const overrideText = 'Prepend this.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                personaContent: persona,
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'prepend' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            const prependIndex = prompt.indexOf(overrideText);
            const personaIndex = prompt.indexOf(persona);
            assert.ok(prependIndex < personaIndex, 'Prepend text should appear before persona content');
        });

        test('append mode adds override after base instructions', () => {
            const persona = 'Base persona.';
            const overrideText = 'Append this.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                personaContent: persona,
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'append' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            const personaIndex = prompt.indexOf(persona);
            const appendIndex = prompt.indexOf(overrideText);
            assert.ok(personaIndex < appendIndex, 'Append text should appear after persona content');
        });

        test('advanced reviewer add-on is still injected with personaContent', () => {
            const persona = 'You are a security reviewer.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                personaContent: persona,
                advancedReviewerEnabled: true,
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes(persona), 'Should include persona content');
            assert.ok(prompt.includes('ADVANCED REGRESSION ANALYSIS'), 'Should include advanced reviewer directive');
        });
    });

    describe('columnToPromptRole', () => {
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

        test('maps SPLITTER to splitter', () => {
            assert.strictEqual(columnToPromptRole('SPLITTER'), 'splitter');
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
});
