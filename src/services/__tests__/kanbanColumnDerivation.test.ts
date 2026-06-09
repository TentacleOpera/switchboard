import * as assert from 'assert';
import { deriveKanbanColumn } from '../kanbanColumnDerivation';

suite('kanbanColumnDerivation', () => {
    test('maps improved plan workflow to PLAN REVIEWED', () => {
        const result = deriveKanbanColumn([{ workflow: 'improved plan' }]);
        assert.strictEqual(result, 'PLAN REVIEWED');
    });

    test('maps unknown/deleted workflow to CREATED fallback', () => {
        const result = deriveKanbanColumn([{ workflow: 'handoff' }]);
        assert.strictEqual(result, 'CREATED');
    });

    test('maps reset-to-coded workflow to LEAD CODED', () => {
        const result = deriveKanbanColumn([{ workflow: 'reset-to-coded' }]);
        assert.strictEqual(result, 'LEAD CODED');
    });

    test('maps empty events to CREATED', () => {
        const result = deriveKanbanColumn([]);
        assert.strictEqual(result, 'CREATED');
    });
});
