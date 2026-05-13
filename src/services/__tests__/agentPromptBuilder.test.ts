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

        test('maps CODED to lead (legacy normalization)', () => {
            assert.strictEqual(columnToPromptRole('CODED'), 'lead');
        });

        test('returns custom_agent roles as-is', () => {
            assert.strictEqual(columnToPromptRole('custom_agent_devin'), 'custom_agent_devin');
        });

        test('returns null for unknown columns', () => {
            assert.strictEqual(columnToPromptRole('UNKNOWN_COLUMN'), null);
        });
    });
});
