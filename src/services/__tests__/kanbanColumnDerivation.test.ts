import * as assert from 'assert';
import { deriveKanbanColumn } from '../kanbanColumnDerivation';

suite('kanbanColumnDerivation', () => {
    test('maps challenge workflow to PLAN REVIEWED', () => {
        const result = deriveKanbanColumn([{ workflow: 'challenge' }]);
        assert.strictEqual(result, 'PLAN REVIEWED');
    });

    test('maps jules workflow to CODER CODED', () => {
        const result = deriveKanbanColumn([{ workflow: 'jules' }]);
        assert.strictEqual(result, 'CODER CODED');
    });

    test('maps improved plan workflow to PLAN REVIEWED', () => {
        const result = deriveKanbanColumn([{ workflow: 'improved plan' }]);
        assert.strictEqual(result, 'PLAN REVIEWED');
    });

    test('maps handoff-lead workflow to LEAD CODED', () => {
        const result = deriveKanbanColumn([{ workflow: 'handoff-lead' }]);
        assert.strictEqual(result, 'LEAD CODED');
    });

    test('maps handoff workflow to CODER CODED', () => {
        const result = deriveKanbanColumn([{ workflow: 'handoff' }]);
        assert.strictEqual(result, 'CODER CODED');
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
