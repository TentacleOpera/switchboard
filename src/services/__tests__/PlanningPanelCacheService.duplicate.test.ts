import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlanningPanelCacheService } from '../PlanningPanelCacheService';

suite('PlanningPanelCacheService — duplicate detection', () => {
    let tmpDir: string;
    let service: PlanningPanelCacheService;

    suiteSetup(async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-cache-test-'));
        service = new PlanningPanelCacheService(tmpDir);
    });

    suiteTeardown(async () => {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    // Helper: register an import directly
    async function register(
        sourceId: string,
        docId: string,
        docName: string,
        slugPrefix: string
    ): Promise<void> {
        await service.registerImport(sourceId, docId, docName, slugPrefix);
    }

    // ── checkForDuplicate ──────────────────────────────────────────

    test('returns isDuplicate:false when registry is empty', async () => {
        const result = await service.checkForDuplicate('My Doc', 'clickup', 'doc1');
        assert.strictEqual(result.isDuplicate, false);
        assert.strictEqual(result.matchType, undefined);
    });

    test('returns isDuplicate:false when no name collision', async () => {
        await register('clickup', 'doc1', 'Design Spec', 'design_spec');
        const result = await service.checkForDuplicate('Roadmap', 'clickup', 'doc2');
        assert.strictEqual(result.isDuplicate, false);
    });

    test('detects exact name match from different source', async () => {
        await register('clickup', 'doc1', 'My Doc', 'my_doc');
        const result = await service.checkForDuplicate('My Doc', 'notion', 'doc2');
        assert.strictEqual(result.isDuplicate, true);
        assert.strictEqual(result.matchType, 'exact_name');
        assert.strictEqual(result.existingDoc?.sourceId, 'clickup');
    });

    test('detects case-insensitive name match', async () => {
        await register('clickup', 'doc1', 'My Doc', 'my_doc');
        const result = await service.checkForDuplicate('my doc', 'notion', 'doc2');
        assert.strictEqual(result.isDuplicate, true);
        assert.strictEqual(result.matchType, 'case_insensitive_name');
    });

    test('same source + same docId is idempotent (not a duplicate)', async () => {
        await register('clickup', 'doc1', 'My Doc', 'my_doc');
        const result = await service.checkForDuplicate('My Doc', 'clickup', 'doc1');
        assert.strictEqual(result.isDuplicate, false);
    });

    test('same source + different docId is a duplicate', async () => {
        await register('clickup', 'doc1', 'My Doc', 'my_doc');
        const result = await service.checkForDuplicate('My Doc', 'clickup', 'doc2');
        assert.strictEqual(result.isDuplicate, true);
    });

    test('detects same docId from different source', async () => {
        await register('clickup', 'shared-id', 'Doc A', 'doc_a');
        const result = await service.checkForDuplicate('Doc B', 'notion', 'shared-id');
        assert.strictEqual(result.isDuplicate, true);
        assert.strictEqual(result.matchType, 'same_doc_id');
    });

    test('name match takes priority over docId match', async () => {
        await register('clickup', 'doc-alpha', 'Shared Name', 'shared_name');
        const result = await service.checkForDuplicate('Shared Name', 'notion', 'doc-beta');
        assert.strictEqual(result.isDuplicate, true);
        assert.strictEqual(result.matchType, 'exact_name');
    });

    // ── getImportByDocName ──────────────────────────────────────────

    test('returns null when no entry matches', async () => {
        const result = await service.getImportByDocName('Nonexistent');
        assert.strictEqual(result, null);
    });

    test('finds entry by exact name', async () => {
        await register('clickup', 'doc1', 'My Design Doc', 'my_design_doc');
        const result = await service.getImportByDocName('My Design Doc');
        assert.notStrictEqual(result, null);
        assert.strictEqual(result!.docName, 'My Design Doc');
        assert.strictEqual(result!.sourceId, 'clickup');
    });

    test('finds entry by case-insensitive name', async () => {
        await register('clickup', 'doc1', 'My Design Doc', 'my_design_doc');
        const result = await service.getImportByDocName('my design doc');
        assert.notStrictEqual(result, null);
        assert.strictEqual(result!.docName, 'My Design Doc');
    });

    test('returns first match when multiple entries have same name', async () => {
        await register('clickup', 'doc1', 'My Doc', 'my_doc_clickup');
        await register('notion', 'doc2', 'My Doc', 'my_doc_notion');
        const result = await service.getImportByDocName('My Doc');
        assert.notStrictEqual(result, null);
        // Either source is acceptable; just verify it found one
        assert.ok(['clickup', 'notion'].includes(result!.sourceId));
    });

    // ── Integration: replace flow ───────────────────────────────────

    test('removeImport + checkForDuplicate allows re-import', async () => {
        await register('clickup', 'doc1', 'My Doc', 'my_doc');

        // Verify duplicate detected
        let result = await service.checkForDuplicate('My Doc', 'notion', 'doc2');
        assert.strictEqual(result.isDuplicate, true);

        // Remove the existing entry
        await service.removeImport('my_doc');

        // Now it should not be a duplicate
        result = await service.checkForDuplicate('My Doc', 'notion', 'doc2');
        assert.strictEqual(result.isDuplicate, false);
    });
});
