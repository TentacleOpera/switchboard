import * as assert from 'assert';
import { buildKanbanBatchPrompt, columnToPromptRole } from '../agentPromptBuilder';

suite('agentPromptBuilder', () => {
    const makePlans = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
            topic: `Test Plan ${i + 1}`,
            absolutePath: `/workspace/plan_${i + 1}.md`
        }));

    suite('buildKanbanBatchPrompt — coder role', () => {
        test('accurateCodingEnabled: true injects Accuracy Mode instructions', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                accurateCodingEnabled: true
            });
            assert.ok(prompt.includes('Accuracy Mode'), 'Should include Accuracy Mode header');
            assert.ok(prompt.includes('.agent/workflows/accuracy.md'), 'Should include reference to accuracy workflow');
        });

        test('accurateCodingEnabled: false omits Accuracy Mode instructions', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                accurateCodingEnabled: false
            });
            assert.ok(!prompt.includes('Accuracy Mode'), 'Should not include Accuracy Mode header');
        });

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

    suite('buildKanbanBatchPrompt — lead role', () => {
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

        test('maps SPLITTER to splitter', () => {
            assert.strictEqual(columnToPromptRole('SPLITTER'), 'splitter');
        });

        test('maps TICKET UPDATER to ticket_updater', () => {
            assert.strictEqual(columnToPromptRole('TICKET UPDATER'), 'ticket_updater');
        });

        test('maps CONTEXT GATHERER to gatherer', () => {
            assert.strictEqual(columnToPromptRole('CONTEXT GATHERER'), 'gatherer');
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
