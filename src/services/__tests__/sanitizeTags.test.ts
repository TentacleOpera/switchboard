import * as assert from 'assert';
import { sanitizeTags } from '../KanbanProvider';

suite('sanitizeTags', () => {
    test('retains arbitrary external tags like sprint-4', () => {
        const result = sanitizeTags('sprint-4');
        assert.strictEqual(result, ',sprint-4,');
    });

    test('retains multiple arbitrary tags', () => {
        const result = sanitizeTags('sprint-4, needs-design, custom-feature');
        assert.strictEqual(result, ',sprint-4,needs-design,custom-feature,');
    });

    test('handles standard tags from allowlist', () => {
        const result = sanitizeTags('frontend, backend, bugfix');
        assert.strictEqual(result, ',frontend,backend,bugfix,');
    });

    test('handles mixed standard and custom tags', () => {
        const result = sanitizeTags('frontend, sprint-4, backend, needs-design');
        assert.strictEqual(result, ',frontend,sprint-4,backend,needs-design,');
    });

    test('returns empty string for none', () => {
        const result = sanitizeTags('none');
        assert.strictEqual(result, '');
    });

    test('returns empty string for empty input', () => {
        const result = sanitizeTags('');
        assert.strictEqual(result, '');
    });

    test('normalizes to lowercase', () => {
        const result = sanitizeTags('Frontend, Sprint-4, BACKEND');
        assert.strictEqual(result, ',frontend,sprint-4,backend,');
    });

    test('trims whitespace', () => {
        const result = sanitizeTags('  frontend  ,  sprint-4  ,  backend  ');
        assert.strictEqual(result, ',frontend,sprint-4,backend,');
    });

    test('filters empty tags', () => {
        const result = sanitizeTags('frontend, , , backend');
        assert.strictEqual(result, ',frontend,backend,');
    });
});
