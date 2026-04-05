import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { KanbanProvider } from '../services/KanbanProvider';

suite('Kanban timestamp preservation', () => {
    test('preserveTimestamps: true does not mutate updated_at on self-heal', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-ts-'));
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            const db = (provider as any)._getKanbanDb(tempDir);
            await db.ensureReady();

            // Insert a plan with a known fixed timestamp
            const fixedTimestamp = '2000-01-01T00:00:00.000Z';
            const sessionId = 'test-session-preserve-ts';
            db._db.run(
                `INSERT INTO plans (session_id, workspace_id, topic, plan_file, kanban_column, status, complexity, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [sessionId, tempDir, 'Test Plan', 'test.md', 'CREATED', 'active', '3', fixedTimestamp, fixedTimestamp]
            );
            await db._persist();

            // Self-heal call with preserveTimestamps: true — should NOT change updated_at
            await db.updateMetadataBatch([{
                sessionId,
                topic: 'Test Plan',
                planFile: 'test.md',
                complexity: '5'
            }], { preserveTimestamps: true });

            const row = db._db.prepare('SELECT updated_at, complexity FROM plans WHERE session_id = ?').get(sessionId);
            assert.strictEqual(row.updated_at, fixedTimestamp, 'updated_at must not change on preserveTimestamps: true');
            assert.strictEqual(row.complexity, '5', 'complexity should still be updated');

            // Genuine user-edit call without flag — should update updated_at
            await db.updateMetadataBatch([{
                sessionId,
                topic: 'Test Plan (edited)',
                planFile: 'test.md',
                complexity: '6'
            }]);

            const row2 = db._db.prepare('SELECT updated_at FROM plans WHERE session_id = ?').get(sessionId);
            assert.notStrictEqual(row2.updated_at, fixedTimestamp, 'updated_at must be refreshed when preserveTimestamps is omitted');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });
});
