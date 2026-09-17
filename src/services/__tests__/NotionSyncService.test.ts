import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NotionSyncService, NotionSyncConfig } from '../NotionSyncService';
import { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';

suite('NotionSyncService', () => {
    let tmpDir: string;
    let service: NotionSyncService;
    let kanbanDb: KanbanDatabase;
    let mockResponses: Array<{ status: number; data: any }>;

    // Minimal fake SecretStorage
    const fakeSecretStorage = {
        get: async (key: string) => null,
        store: async () => {},
        delete: async () => {}
    } as any;

    suiteSetup(async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-backup-test-'));
        await fs.promises.mkdir(path.join(tmpDir, '.switchboard'), { recursive: true });
        kanbanDb = KanbanDatabase.forWorkspace(tmpDir);
        await kanbanDb.createIfMissing();
        await kanbanDb.ensureReady();
        await kanbanDb.setWorkspaceId('test-ws-id');
    });

    suiteTeardown(async () => {
        if (kanbanDb) {
            kanbanDb.dispose();
            await KanbanDatabase.invalidateWorkspace(tmpDir);
        }
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    setup(() => {
        service = new NotionSyncService(tmpDir, fakeSecretStorage);
        mockResponses = [];

        // Inject mock NotionFetchService
        const mockFetchService = {
            parsePageId: (url: string) => {
                try {
                    const parsed = new URL(url);
                    const segments = parsed.pathname.split('/').filter(Boolean);
                    const last = segments[segments.length - 1];
                    if (last && /^[a-f0-9]{32}$/.test(last)) return last;
                    // Handle dashed UUID format
                    const uuidMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
                    if (uuidMatch) return uuidMatch[1].replace(/-/g, '');
                    return null;
                } catch {
                    return null;
                }
            },
            httpRequest: async () => {
                const resp = mockResponses.shift();
                if (!resp) throw new Error('Unexpected httpRequest call – mock queue empty');
                return resp;
            },
            loadConfig: async () => null
        };
        (service as any)._notionFetchService = mockFetchService;
    });

    // ── parseDatabaseId ────────────────────────────────────────────

    test('parseDatabaseId extracts 32-char hex ID from Notion URL', () => {
        const id = service.parseDatabaseId('https://notion.so/workspace/abc123def456abc123def456abc123de');
        assert.strictEqual(id, 'abc123def456abc123def456abc123de');
    });

    test('parseDatabaseId extracts UUID from dashed URL', () => {
        const id = service.parseDatabaseId('https://notion.so/workspace/abc123de-f456-abcd-1234-abc123def456');
        assert.strictEqual(id, 'abc123def456abcd1234abc123def456');
    });

    test('parseDatabaseId returns null for non-Notion URL', () => {
        const id = service.parseDatabaseId('https://example.com/page/123');
        assert.strictEqual(id, null);
    });

    test('parseDatabaseId returns null for missing ID', () => {
        const id = service.parseDatabaseId('https://notion.so/workspace/');
        assert.strictEqual(id, null);
    });

    // ── Config I/O ─────────────────────────────────────────────────

    test('loadConfig returns null when file missing', async () => {
        const cfg = await service.loadConfig();
        assert.strictEqual(cfg, null);
    });

    test('saveConfig and loadConfig round-trip', async () => {
        const config: NotionSyncConfig = {
            databaseUrl: 'https://notion.so/db/abc123',
            databaseId: 'abc123',
            databaseTitle: 'Test',
            lastBackupAt: new Date().toISOString(),
            lastRestoreAt: null
        };
        await service.saveConfig(config);
        const loaded = await service.loadConfig();
        assert.notStrictEqual(loaded, null);
        assert.strictEqual(loaded!.databaseId, 'abc123');
        assert.strictEqual(loaded!.databaseTitle, 'Test');
    });

    test('loadConfig migrates the legacy notion-backup-config.json forward, preserving unknown keys', async () => {
        const legacyPath = path.join(tmpDir, '.switchboard', 'notion-backup-config.json');
        const newPath = path.join(tmpDir, '.switchboard', 'notion-sync-config.json');
        await fs.promises.rm(newPath, { force: true });
        await fs.promises.writeFile(legacyPath, JSON.stringify({
            databaseId: 'legacy-db',
            databaseTitle: 'Legacy',
            lastBackupAt: null,
            lastRestoreAt: null,
            futureUnknownKey: { kept: true },
        }), 'utf8');

        const loaded = await service.loadConfig();
        assert.strictEqual(loaded!.databaseId, 'legacy-db');
        assert.deepStrictEqual((loaded as any).futureUnknownKey, { kept: true });

        // Migrated forward: the new path now carries the value (legacy kept on disk).
        const migrated = JSON.parse(await fs.promises.readFile(newPath, 'utf8'));
        assert.strictEqual(migrated.databaseId, 'legacy-db');
        assert.deepStrictEqual(migrated.futureUnknownKey, { kept: true });
        assert.ok(fs.existsSync(legacyPath), 'the legacy file must not be unlinked');

        await fs.promises.rm(legacyPath, { force: true });
        await fs.promises.rm(newPath, { force: true });
    });

    // `_readConfigFile` promises a corrupt file throws rather than reading as
    // unconfigured — the two states must not be indistinguishable.
    test('a corrupt config is loud, not read as unconfigured', async () => {
        const newPath = path.join(tmpDir, '.switchboard', 'notion-sync-config.json');
        await fs.promises.writeFile(newPath, '{ not json', 'utf8');
        try {
            await assert.rejects(() => service.loadConfig());
        } finally {
            await fs.promises.rm(newPath, { force: true });
        }
    });

    // ── autoCreateDatabase ───────────────────────────────────────────

    test('autoCreateDatabase errors when no parent page configured', async () => {
        const result = await service.autoCreateDatabase();
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('Set up Notion integration'));
    });

    test('autoCreateDatabase succeeds and saves config', async () => {
        // Inject mock with parent page config
        const mockFetchServiceWithParent = {
            parsePageId: (url: string) => 'parent-page-id',
            httpRequest: async () => ({ status: 200, data: { id: 'new-db-id', url: 'https://notion.so/db/new-db-id' } }),
            loadConfig: async () => ({ pageId: 'parent-page-id', pageUrl: 'https://notion.so/parent', pageTitle: 'Parent', setupComplete: true, lastFetchAt: null })
        };
        (service as any)._notionFetchService = mockFetchServiceWithParent;

        const result = await service.autoCreateDatabase();
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.databaseUrl, 'https://notion.so/db/new-db-id');

        const cfg = await service.loadConfig();
        assert.strictEqual(cfg?.databaseId, 'new-db-id');
    });

    test('autoCreateDatabase propagates creation failure', async () => {
        const mockFetchServiceFail = {
            parsePageId: () => null,
            httpRequest: async () => ({ status: 400, data: { message: 'Invalid parent' } }),
            loadConfig: async () => ({ pageId: 'parent-page-id', pageUrl: '', pageTitle: '', setupComplete: true, lastFetchAt: null })
        };
        (service as any)._notionFetchService = mockFetchServiceFail;

        const result = await service.autoCreateDatabase();
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('Failed to create database'));
    });

    // ── Shipped Notion schema — property names are load-bearing ──────
    // Every name below exists in real users' Notion databases. Renaming one
    // orphans every page, so the schema is explicitly NOT migrated by the
    // service rename — this test makes an accidental rename fail.

    test('the plan-push property names are byte-identical to the shipped schema', () => {
        const plan: any = {
            planId: 'p1', sessionId: 's1', topic: 'T', planFile: '/tmp/p.md',
            kanbanColumn: 'CODED', status: 'active', complexity: '3', tags: 'a,b',
            repoScope: 'r', workspaceId: 'w', createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z', lastAction: 'x', sourceType: 'local',
            clickupTaskId: '', linearIssueId: '', notionPageId: '', isFeature: 1, featureId: '',
        };
        const props = (service as any)._planToNotionProperties(plan, undefined);
        assert.deepStrictEqual(Object.keys(props).sort(), [
            'ClickUp Task ID', 'Complexity', 'Created At', 'Feature', 'Is Feature',
            'Kanban Column', 'Last Action', 'Linear Issue ID', 'Plan ID', 'Repo Scope',
            'Session ID', 'Source Type', 'Status', 'Tags', 'Topic', 'Updated At',
            'Workspace ID',
        ].sort());
    });

    test('the database-creation property names are byte-identical to the shipped schema', async () => {
        let createBody: any = null;
        const mockFetchServiceCreate = {
            parsePageId: () => 'parent-page-id',
            httpRequest: async (method: string, apiPath: string, body: any) => {
                if (method === 'POST' && apiPath === '/databases') { createBody = body; }
                return { status: 200, data: { id: 'new-db-id', url: 'https://notion.so/db/new-db-id' } };
            },
            loadConfig: async () => ({ pageId: 'parent-page-id', pageUrl: '', pageTitle: '', setupComplete: true, lastFetchAt: null })
        };
        (service as any)._notionFetchService = mockFetchServiceCreate;

        await service.autoCreateDatabase();
        assert.ok(createBody, 'autoCreateDatabase did not POST /databases');
        assert.deepStrictEqual(Object.keys(createBody.properties).sort(), [
            'ClickUp Task ID', 'Complexity', 'Created At', 'Dependencies', 'Is Feature',
            'Kanban Column', 'Last Action', 'Linear Issue ID', 'Plan ID', 'Repo Scope',
            'Session ID', 'Source Type', 'Status', 'Tags', 'Topic', 'Updated At',
            'Workspace ID',
        ].sort());
    });

    // ── validateDatabaseAccess ─────────────────────────────────────

    test('validateDatabaseAccess returns success for valid database', async () => {
        const mockFetchServiceValid = {
            parsePageId: () => null,
            httpRequest: async () => ({ status: 200, data: { id: 'valid-db' } }),
            loadConfig: async () => null
        };
        (service as any)._notionFetchService = mockFetchServiceValid;

        const result = await service.validateDatabaseAccess('valid-db');
        assert.strictEqual(result.success, true);
    });

    test('validateDatabaseAccess returns error for 403', async () => {
        const mockFetchService403 = {
            parsePageId: () => null,
            httpRequest: async () => ({ status: 403, data: {} }),
            loadConfig: async () => null
        };
        (service as any)._notionFetchService = mockFetchService403;

        const result = await service.validateDatabaseAccess('forbidden-db');
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('403'));
        assert.ok(result.error?.includes('permissions'));
    });

    test('validateDatabaseAccess returns error for network failure', async () => {
        const mockFetchServiceError = {
            parsePageId: () => null,
            httpRequest: async () => { throw new Error('Connection reset'); },
            loadConfig: async () => null
        };
        (service as any)._notionFetchService = mockFetchServiceError;

        const result = await service.validateDatabaseAccess('unreachable-db');
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('Connection reset'));
    });
});
