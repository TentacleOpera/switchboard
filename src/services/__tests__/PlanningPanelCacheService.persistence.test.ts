import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlanningPanelCacheService } from '../PlanningPanelCacheService';
import { KanbanDatabase } from '../KanbanDatabase';

suite('PlanningPanelCacheService — persistence', () => {
    let tmpDir: string;
    let kanbanDb: KanbanDatabase;
    let service: PlanningPanelCacheService;
    const workspaceId = 'test-workspace-id';

    setup(async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-persistence-test-'));
        kanbanDb = KanbanDatabase.forWorkspace(tmpDir);
        await kanbanDb.createIfMissing();
        await kanbanDb.ensureReady();
        await kanbanDb.setWorkspaceId(workspaceId);
        service = new PlanningPanelCacheService(tmpDir, kanbanDb);
    });

    teardown(async () => {
        kanbanDb.dispose();
        await KanbanDatabase.invalidateWorkspace(tmpDir);
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    test('registerImport uses database workspace ID', async () => {
        await service.registerImport('notion', 'doc1', 'My Doc', 'my_doc', {});
        
        const docs = await service.getImportedDocs();
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0].workspaceId, workspaceId);
        assert.strictEqual(docs[0].docName, 'My Doc');
    });

    test('imports persist across service recreation', async () => {
        await service.registerImport('clickup', 'doc1', 'Persisted Doc', 'persisted_doc', {});
        
        // Recreate service with same DB
        const service2 = new PlanningPanelCacheService(tmpDir, kanbanDb);
        const docs = await service2.getImportedDocs();
        
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0].docName, 'Persisted Doc');
        assert.strictEqual(docs[0].workspaceId, workspaceId);
    });

    test('explicit workspaceId override works', async () => {
        const otherWsId = 'other-ws';
        await service.registerImport('linear', 'doc1', 'Other Doc', 'other_doc', { workspaceId: otherWsId });
        
        // Should not be in default workspace
        const defaultDocs = await service.getImportedDocs();
        assert.strictEqual(defaultDocs.length, 0);
        
        // Should be in other workspace
        const otherDocs = await service.getImportedDocs(otherWsId);
        assert.strictEqual(otherDocs.length, 1);
        assert.strictEqual(otherDocs[0].workspaceId, otherWsId);
    });

    test('throws when DB exists but has no workspace ID', async () => {
        // Create a new DB without setting workspace ID
        const emptyDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-empty-db-test-'));
        const emptyDb = KanbanDatabase.forWorkspace(emptyDir);
        await emptyDb.createIfMissing();
        const emptyService = new PlanningPanelCacheService(emptyDir, emptyDb);
        
        try {
            await emptyService.registerImport('notion', 'doc1', 'Fail Doc', 'fail_doc', {});
            assert.fail('Should have thrown error for missing workspace_id');
        } catch (err: any) {
            assert.ok(err.message.includes('No workspace_id configured'), `Error message should mention missing workspace_id, got: ${err.message}`);
        } finally {
            emptyDb.dispose();
            await KanbanDatabase.invalidateWorkspace(emptyDir);
            await fs.promises.rm(emptyDir, { recursive: true, force: true });
        }
    });

    test('throws when no database is provided', async () => {
        const noDbService = new PlanningPanelCacheService(tmpDir);
        
        // registerImport handles this with a UI warning and early return (no throw in current impl)
        // But _getEffectiveWorkspaceId (called by getImportedDocs) SHOULD throw
        
        let threw = false;
        try {
            await noDbService.getImportedDocs();
        } catch (err: any) {
            assert.strictEqual(err.message, '[PlanningPanelCacheService] KanbanDatabase not available');
            threw = true;
        }
        assert.ok(threw, 'Should have thrown error for missing KanbanDatabase');
    });
});
