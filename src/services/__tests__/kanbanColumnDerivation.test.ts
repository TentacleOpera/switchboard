import * as assert from 'assert';
import { deriveKanbanColumn } from '../kanbanColumnDerivation';

suite('kanbanColumnDerivation', () => {
    test('maps challenge workflow to PLAN REVIEWED', () => {
        const result = deriveKanbanColumn([{ workflow: 'challenge' }]);
        assert.strictEqual(result, 'PLAN REVIEWED');
    });

    test('maps jules workflow to CODED', () => {
        const result = deriveKanbanColumn([{ workflow: 'jules' }]);
        assert.strictEqual(result, 'CODED');
    });

    test('maps improved plan workflow to PLAN REVIEWED', () => {
        const result = deriveKanbanColumn([{ workflow: 'improved plan' }]);
        assert.strictEqual(result, 'PLAN REVIEWED');
    });

    test('maps handoff-lead workflow to CODED', () => {
        const result = deriveKanbanColumn([{ workflow: 'handoff-lead' }]);
        assert.strictEqual(result, 'CODED');
    });

    test('maps empty events to CREATED', () => {
        const result = deriveKanbanColumn([]);
        assert.strictEqual(result, 'CREATED');
    });
});
