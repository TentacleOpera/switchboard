
import * as assert from 'assert';
import { parsePlanMetadata, sanitizeTags, inferTopicFromPath } from '../planMetadataUtils';

describe('planMetadataUtils', () => {
    describe('sanitizeTags', () => {
        it('returns empty string for empty input', () => {
            assert.strictEqual(sanitizeTags(''), '');
        });

        it('returns empty string for "none"', () => {
            assert.strictEqual(sanitizeTags('none'), '');
        });

        it('filters out invalid tags', () => {
            assert.strictEqual(sanitizeTags('frontend, invalid, backend'), ',frontend,backend,');
        });

        it('normalizes case', () => {
            assert.strictEqual(sanitizeTags('FRONTEND, Backend'), ',frontend,backend,');
        });
    });

    describe('parsePlanMetadata', () => {
        const sampleContent = `
# Sample Plan
## Metadata
- sessionId: test_123
- kanbanColumn: INVESTIGATION

**Complexity:** 5
**Tags:** frontend, backend

### Dependencies
- Dep 1
- Dep 2
`;

        it('extracts basic metadata correctly', async () => {
            const metadata = await parsePlanMetadata(sampleContent, 'test.md');
            assert.strictEqual(metadata.sessionId, undefined); // sessionId no longer extracted
            assert.strictEqual(metadata.topic, 'Sample Plan');
            assert.strictEqual(metadata.kanbanColumn, 'INVESTIGATION');
            assert.strictEqual(metadata.complexity, '5');
            assert.strictEqual(metadata.tags, ',frontend,backend,');
        });

        it('prefers Manual Complexity Override', async () => {
            const content = `
**Manual Complexity Override:** 8
**Complexity:** 5
`;
            const metadata = await parsePlanMetadata(content, 'test.md');
            assert.strictEqual(metadata.complexity, '8');
        });

        it('handles missing metadata gracefully', async () => {
            const metadata = await parsePlanMetadata('', 'brain_test.md');
            assert.strictEqual(metadata.sessionId, undefined); // sessionId no longer extracted from filename
            assert.strictEqual(metadata.topic, 'Test'); // derived from filename after stripping brain_ prefix
            assert.strictEqual(metadata.complexity, 'Unknown');
        });

        it('ignores YAML frontmatter sessionId (backward compat)', async () => {
            const content = '---\nsessionId: legacy_sess_123\ncreated: 2026-01-01\n---\n\n# Legacy Plan';
            const metadata = await parsePlanMetadata(content, 'legacy_plan.md');
            assert.strictEqual(metadata.sessionId, undefined); // must not extract sessionId from YAML
            assert.strictEqual(metadata.topic, 'Legacy Plan');
        });

        it('derives topic from filename when no topic or H1', async () => {
            const metadata = await parsePlanMetadata('', 'fix_kanban_column_sorting.md');
            assert.strictEqual(metadata.topic, 'Fix Kanban Column Sorting');
        });

        describe('list-marker tolerance', () => {
            const listMarkerCases = [
                { label: 'dash list marker', content: '## Metadata\n- **Complexity:** 5', expected: '5' },
                { label: 'asterisk list marker', content: '## Metadata\n* **Complexity:** 5', expected: '5' },
                { label: 'indented', content: '## Metadata\n  **Complexity:** 5', expected: '5' },
                { label: 'dash list marker (override)', content: '- **Manual Complexity Override:** 8\n**Complexity:** 5', expected: '8' },
                { label: 'dash list marker (tags)', content: '## Metadata\n- **Tags:** frontend, backend', expectedTags: ',frontend,backend,' },
                { label: 'blockquote marker', content: '## Metadata\n> **Complexity:** 5', expected: '5' },
                { label: 'numbered list marker', content: '## Metadata\n1. **Complexity:** 5', expected: '5' },
                { label: 'numbered list marker (tags)', content: '1. **Tags:** UI, UX', expectedTags: ',ui,ux,' }
            ];

            listMarkerCases.forEach(({ label, content, expected, expectedTags }) => {
                it(`handles ${label}`, async () => {
                    const metadata = await parsePlanMetadata(content, 'test.md');
                    if (expected) assert.strictEqual(metadata.complexity, expected);
                    if (expectedTags) assert.strictEqual(metadata.tags, expectedTags);
                });
            });
        });
    });

    describe('inferTopicFromPath', () => {
        it('strips common prefixes', () => {
            assert.strictEqual(inferTopicFromPath('brain_test.md'), 'Test');
            assert.strictEqual(inferTopicFromPath('feature_plan_awesome.md'), 'Awesome');
            assert.strictEqual(inferTopicFromPath('plan_my_plan.md'), 'My Plan');
        });

        it('converts underscores and hyphens to spaces with title casing', () => {
            assert.strictEqual(inferTopicFromPath('fix_kanban_column_sorting.md'), 'Fix Kanban Column Sorting');
            assert.strictEqual(inferTopicFromPath('add-user-auth.md'), 'Add User Auth');
        });

        it('strips leading hex hashes', () => {
            assert.strictEqual(inferTopicFromPath('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2_test.md'), 'Test');
            assert.strictEqual(inferTopicFromPath('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2.md'), '(untitled)');
        });

        it('handles hash-only filenames', () => {
            assert.strictEqual(inferTopicFromPath('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2.md'), '(untitled)');
        });

        it('handles empty or undefined input', () => {
            assert.strictEqual(inferTopicFromPath(''), '(untitled)');
            assert.strictEqual(inferTopicFromPath(undefined as any), '(untitled)');
        });
    });
});
