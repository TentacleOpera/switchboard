import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NotionBackupService, NotionBackupConfig } from '../NotionBackupService';
import { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';

suite('NotionBackupService', () => {
    let tmpDir: string;
    let service: NotionBackupService;
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
        service = new NotionBackupService(tmpDir, fakeSecretStorage);
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
        const config: NotionBackupConfig = {
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

    // ── backupToNotion ─────────────────────────────────────────────

    test('backupToNotion returns error when database not configured', async () => {
        const result = await service.backupToNotion(tmpDir);
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('Notion database not configured'));
    });

    test('backupToNotion backs up zero plans successfully', async () => {
        await service.saveConfig({
            databaseUrl: 'https://notion.so/db/testdb',
            databaseId: 'testdb',
            databaseTitle: 'Test',
            lastBackupAt: null,
            lastRestoreAt: null
        });
        const result = await service.backupToNotion(tmpDir);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.backedUp, 0);
        assert.strictEqual(result.total, 0);
    });

    test('backupToNotion creates new page for single plan', async () => {
        // Seed kanban.db with one plan
        const plan: KanbanPlanRecord = {
            planId: 'plan-001',
            sessionId: 'sess-001',
            topic: 'Test Plan',
            planFile: '.switchboard/plans/test.md',
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: '3',
            tags: 'bug,backend',
            dependencies: '',
            repoScope: 'switchboard',
            workspaceId: 'test-ws-id',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastAction: '',
            sourceType: 'local',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: '',
            clickupTaskId: '',
            linearIssueId: ''
        };
        await kanbanDb.upsertPlans([plan]);

        await service.saveConfig({
            databaseUrl: 'https://notion.so/db/testdb',
            databaseId: 'testdb',
            databaseTitle: 'Test',
            lastBackupAt: null,
            lastRestoreAt: null
        });

        // Mock: query returns no existing pages, create returns success
        mockResponses = [
            { status: 200, data: { results: [] } },           // query
            { status: 200, data: { id: 'page-001' } }         // create page
        ];

        const result = await service.backupToNotion(tmpDir);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.backedUp, 1);
        assert.strictEqual(result.total, 1);

        // Verify config updated
        const cfg = await service.loadConfig();
        assert.ok(cfg?.lastBackupAt, 'lastBackupAt should be set');
    });

    test('backupToNotion updates existing page when found', async () => {
        const plan: KanbanPlanRecord = {
            planId: 'plan-002',
            sessionId: 'sess-002',
            topic: 'Update Plan',
            planFile: '.switchboard/plans/update.md',
            kanbanColumn: 'CODED',
            status: 'active',
            complexity: '5',
            tags: 'feature',
            dependencies: 'plan-001',
            repoScope: '',
            workspaceId: 'test-ws-id',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastAction: 'coded',
            sourceType: 'local',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: 'lead',
            dispatchedAgent: 'claude',
            dispatchedIde: 'vscode',
            clickupTaskId: '',
            linearIssueId: ''
        };
        await kanbanDb.upsertPlans([plan]);

        await service.saveConfig({
            databaseUrl: 'https://notion.so/db/testdb',
            databaseId: 'testdb',
            databaseTitle: 'Test',
            lastBackupAt: null,
            lastRestoreAt: null
        });

        // Mock: query returns existing page, patch returns success
        mockResponses = [
            { status: 200, data: { results: [{ id: 'existing-page-001' }] } },
            { status: 200, data: { id: 'existing-page-001' } }
        ];

        const result = await service.backupToNotion(tmpDir);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.backedUp, 1);
    });

    test('backupToNotion partial failure does not update lastBackupAt', async () => {
        const plan1: KanbanPlanRecord = {
            planId: 'plan-003', sessionId: 'sess-003', topic: 'P1', planFile: '',
            kanbanColumn: 'CREATED', status: 'active', complexity: '1', tags: '',
            dependencies: '', repoScope: '', workspaceId: 'test-ws-id',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            lastAction: '', sourceType: 'local', brainSourcePath: '', mirrorPath: '',
            routedTo: '', dispatchedAgent: '', dispatchedIde: '', clickupTaskId: '', linearIssueId: ''
        };
        const plan2: KanbanPlanRecord = {
            planId: 'plan-004', sessionId: 'sess-004', topic: 'P2', planFile: '',
            kanbanColumn: 'CREATED', status: 'active', complexity: '1', tags: '',
            dependencies: '', repoScope: '', workspaceId: 'test-ws-id',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            lastAction: '', sourceType: 'local', brainSourcePath: '', mirrorPath: '',
            routedTo: '', dispatchedAgent: '', dispatchedIde: '', clickupTaskId: '', linearIssueId: ''
        };
        await kanbanDb.upsertPlans([plan1, plan2]);

        await service.saveConfig({
            databaseUrl: 'https://notion.so/db/testdb',
            databaseId: 'testdb',
            databaseTitle: 'Test',
            lastBackupAt: null,
            lastRestoreAt: null
        });

        // First plan succeeds, second fails
        mockResponses = [
            { status: 200, data: { results: [] } },
            { status: 200, data: { id: 'page-003' } },
            { status: 200, data: { results: [] } },
            { status: 400, data: { message: 'Bad Request' } }
        ];

        const result = await service.backupToNotion(tmpDir);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.backedUp, 1);
        assert.strictEqual(result.total, 2);

        // lastBackupAt should NOT be updated
        const cfg = await service.loadConfig();
        assert.strictEqual(cfg?.lastBackupAt, null);
    });

    test('backupToNotion reports progress per plan', async () => {
        const plan: KanbanPlanRecord = {
            planId: 'plan-005', sessionId: 'sess-005', topic: 'Progress Plan', planFile: '',
            kanbanColumn: 'CREATED', status: 'active', complexity: '1', tags: '',
            dependencies: '', repoScope: '', workspaceId: 'test-ws-id',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            lastAction: '', sourceType: 'local', brainSourcePath: '', mirrorPath: '',
            routedTo: '', dispatchedAgent: '', dispatchedIde: '', clickupTaskId: '', linearIssueId: ''
        };
        await kanbanDb.upsertPlans([plan]);

        await service.saveConfig({
            databaseUrl: 'https://notion.so/db/testdb',
            databaseId: 'testdb',
            databaseTitle: 'Test',
            lastBackupAt: null,
            lastRestoreAt: null
        });

        mockResponses = [
            { status: 200, data: { results: [] } },
            { status: 200, data: { id: 'page-005' } }
        ];

        const reports: string[] = [];
        const progress = {
            report: (value: { message?: string }) => {
                if (value.message) reports.push(value.message);
            }
        };

        await service.backupToNotion(tmpDir, progress as any);
        assert.strictEqual(reports.length, 1);
        assert.ok(reports[0].includes('Backing up plan 1 of 1'));
    });

    // ── restoreFromNotion ──────────────────────────────────────────

    test('restoreFromNotion returns error when database not configured', async () => {
        const result = await service.restoreFromNotion(tmpDir);
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('Notion database not configured'));
    });

    test('restoreFromNotion restores zero pages successfully', async () => {
        await service.saveConfig({
            databaseUrl: 'https://notion.so/db/testdb',
            databaseId: 'testdb',
            databaseTitle: 'Test',
            lastBackupAt: null,
            lastRestoreAt: null
        });

        mockResponses = [
            { status: 200, data: { results: [], has_more: false } }
        ];

        const result = await service.restoreFromNotion(tmpDir);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.restored, 0);
        assert.strictEqual(result.skipped, 0);
    });

    test('restoreFromNotion converts page to plan record', async () => {
        await service.saveConfig({
            databaseUrl: 'https://notion.so/db/testdb',
            databaseId: 'testdb',
            databaseTitle: 'Test',
            lastBackupAt: null,
            lastRestoreAt: null
        });

        const notionPage = {
            properties: {
                'Topic': { title: [{ plain_text: 'Restored Plan' }] },
                'Plan ID': { rich_text: [{ plain_text: 'plan-restore-001' }] },
                'Session ID': { rich_text: [{ plain_text: 'sess-restore-001' }] },
                'Kanban Column': { select: { name: 'CODED' } },
                'Status': { select: { name: 'active' } },
                'Complexity': { number: 7 },
                'Tags': { multi_select: [{ name: 'feature' }, { name: 'frontend' }] },
                'Dependencies': { rich_text: [{ plain_text: 'dep-001' }] },
                'Repo Scope': { rich_text: [{ plain_text: 'switchboard' }] },
                'Workspace ID': { rich_text: [{ plain_text: 'test-ws-id' }] },
                'Created At': { date: { start: '2025-01-01T00:00:00Z' } },
                'Updated At': { date: { start: '2025-01-02T00:00:00Z' } },
                'Last Action': { rich_text: [{ plain_text: 'reviewed' }] },
                'Source Type': { select: { name: 'brain' } },
                'ClickUp Task ID': { rich_text: [{ plain_text: '' }] },
                'Linear Issue ID': { rich_text: [{ plain_text: '' }] }
            }
        };

        mockResponses = [
            { status: 200, data: { results: [notionPage], has_more: false } }
        ];

        const result = await service.restoreFromNotion(tmpDir);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.restored, 1);
        assert.strictEqual(result.skipped, 0);

        // Verify the plan was inserted
        const plans = await kanbanDb.getAllPlans('test-ws-id');
        const restored = plans.find(p => p.planId === 'plan-restore-001');
        assert.ok(restored, 'Restored plan should exist in DB');
        assert.strictEqual(restored.topic, 'Restored Plan');
        assert.strictEqual(restored.kanbanColumn, 'CODED');
        assert.strictEqual(restored.complexity, '7');
        assert.strictEqual(restored.tags, 'feature,frontend');
        assert.strictEqual(restored.sourceType, 'brain');
    });

    test('restoreFromNotion skips local plans with newer updatedAt', async () => {
        const oldDate = '2025-01-01T00:00:00Z';
        const newDate = '2025-06-01T00:00:00Z';

        // Seed local plan with newer updated_at
        const localPlan: KanbanPlanRecord = {
            planId: 'plan-skip-001', sessionId: 'sess-skip-001', topic: 'Local Plan', planFile: '.switchboard/plans/local.md',
            kanbanColumn: 'CREATED', status: 'active', complexity: '5', tags: '',
            dependencies: '', repoScope: '', workspaceId: 'test-ws-id',
            createdAt: oldDate, updatedAt: newDate,
            lastAction: '', sourceType: 'local', brainSourcePath: '', mirrorPath: '',
            routedTo: '', dispatchedAgent: '', dispatchedIde: '', clickupTaskId: '', linearIssueId: ''
        };
        await kanbanDb.upsertPlans([localPlan]);

        await service.saveConfig({
            databaseUrl: 'https://notion.so/db/testdb',
            databaseId: 'testdb',
            databaseTitle: 'Test',
            lastBackupAt: null,
            lastRestoreAt: null
        });

        const notionPage = {
            properties: {
                'Topic': { title: [{ plain_text: 'Notion Plan' }] },
                'Plan ID': { rich_text: [{ plain_text: 'plan-skip-001' }] },
                'Session ID': { rich_text: [{ plain_text: 'sess-skip-001' }] },
                'Kanban Column': { select: { name: 'CODED' } },
                'Status': { select: { name: 'active' } },
                'Complexity': { number: 3 },
                'Tags': { multi_select: [] },
                'Dependencies': { rich_text: [{ plain_text: '' }] },
                'Repo Scope': { rich_text: [{ plain_text: '' }] },
                'Workspace ID': { rich_text: [{ plain_text: 'test-ws-id' }] },
                'Created At': { date: { start: oldDate } },
                'Updated At': { date: { start: oldDate } },
                'Last Action': { rich_text: [{ plain_text: '' }] },
                'Source Type': { select: { name: 'local' } },
                'ClickUp Task ID': { rich_text: [{ plain_text: '' }] },
                'Linear Issue ID': { rich_text: [{ plain_text: '' }] }
            }
        };

        mockResponses = [
            { status: 200, data: { results: [notionPage], has_more: false } }
        ];

        const result = await service.restoreFromNotion(tmpDir);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.restored, 0);
        assert.strictEqual(result.skipped, 1);

        // Verify local plan unchanged
        const plans = await kanbanDb.getAllPlans('test-ws-id');
        const local = plans.find(p => p.planId === 'plan-skip-001');
        assert.ok(local);
        assert.strictEqual(local.kanbanColumn, 'CREATED'); // Notion had CODED but local is newer
    });

    test('restoreFromNotion preserves local path fields', async () => {
        const date = '2025-01-01T00:00:00Z';

        // Seed local plan with paths
        const localPlan: KanbanPlanRecord = {
            planId: 'plan-path-001', sessionId: 'sess-path-001', topic: 'Path Plan',
            planFile: '.switchboard/plans/path.md',
            kanbanColumn: 'CREATED', status: 'active', complexity: '5', tags: '',
            dependencies: '', repoScope: '', workspaceId: 'test-ws-id',
            createdAt: date, updatedAt: date,
            lastAction: '', sourceType: 'local',
            brainSourcePath: 'brain/plans/path.md',
            mirrorPath: 'mirror/path.md',
            routedTo: 'lead',
            dispatchedAgent: 'claude',
            dispatchedIde: 'vscode',
            clickupTaskId: '', linearIssueId: ''
        };
        await kanbanDb.upsertPlans([localPlan]);

        await service.saveConfig({
            databaseUrl: 'https://notion.so/db/testdb',
            databaseId: 'testdb',
            databaseTitle: 'Test',
            lastBackupAt: null,
            lastRestoreAt: null
        });

        const notionPage = {
            properties: {
                'Topic': { title: [{ plain_text: 'Updated Plan' }] },
                'Plan ID': { rich_text: [{ plain_text: 'plan-path-001' }] },
                'Session ID': { rich_text: [{ plain_text: 'sess-path-001' }] },
                'Kanban Column': { select: { name: 'CODED' } },
                'Status': { select: { name: 'active' } },
                'Complexity': { number: 5 },
                'Tags': { multi_select: [] },
                'Dependencies': { rich_text: [{ plain_text: '' }] },
                'Repo Scope': { rich_text: [{ plain_text: '' }] },
                'Workspace ID': { rich_text: [{ plain_text: 'test-ws-id' }] },
                'Created At': { date: { start: date } },
                'Updated At': { date: { start: '2025-06-01T00:00:00Z' } },
                'Last Action': { rich_text: [{ plain_text: 'updated' }] },
                'Source Type': { select: { name: 'local' } },
                'ClickUp Task ID': { rich_text: [{ plain_text: '' }] },
                'Linear Issue ID': { rich_text: [{ plain_text: '' }] }
            }
        };

        mockResponses = [
            { status: 200, data: { results: [notionPage], has_more: false } }
        ];

        const result = await service.restoreFromNotion(tmpDir);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.restored, 1);

        const plans = await kanbanDb.getAllPlans('test-ws-id');
        const restored = plans.find(p => p.planId === 'plan-path-001');
        assert.ok(restored);
        // Path fields should be preserved from local
        assert.strictEqual(restored.planFile, '.switchboard/plans/path.md');
        assert.strictEqual(restored.brainSourcePath, 'brain/plans/path.md');
        assert.strictEqual(restored.mirrorPath, 'mirror/path.md');
        assert.strictEqual(restored.routedTo, 'lead');
        assert.strictEqual(restored.dispatchedAgent, 'claude');
        assert.strictEqual(restored.dispatchedIde, 'vscode');
        // Column should be updated via updateColumn
        assert.strictEqual(restored.kanbanColumn, 'CODED');
    });

    test('restoreFromNotion batch upserts all valid records', async () => {
        const date = '2025-01-01T00:00:00Z';
        await service.saveConfig({
            databaseUrl: 'https://notion.so/db/testdb',
            databaseId: 'testdb',
            databaseTitle: 'Test',
            lastBackupAt: null,
            lastRestoreAt: null
        });

        const pages = [
            {
                properties: {
                    'Topic': { title: [{ plain_text: 'Plan A' }] },
                    'Plan ID': { rich_text: [{ plain_text: 'plan-batch-001' }] },
                    'Session ID': { rich_text: [{ plain_text: 'sess-batch-001' }] },
                    'Kanban Column': { select: { name: 'CREATED' } },
                    'Status': { select: { name: 'active' } },
                    'Complexity': { number: 1 },
                    'Tags': { multi_select: [] },
                    'Dependencies': { rich_text: [{ plain_text: '' }] },
                    'Repo Scope': { rich_text: [{ plain_text: '' }] },
                    'Workspace ID': { rich_text: [{ plain_text: 'test-ws-id' }] },
                    'Created At': { date: { start: date } },
                    'Updated At': { date: { start: date } },
                    'Last Action': { rich_text: [{ plain_text: '' }] },
                    'Source Type': { select: { name: 'local' } },
                    'ClickUp Task ID': { rich_text: [{ plain_text: '' }] },
                    'Linear Issue ID': { rich_text: [{ plain_text: '' }] }
                }
            },
            {
                properties: {
                    'Topic': { title: [{ plain_text: 'Plan B' }] },
                    'Plan ID': { rich_text: [{ plain_text: 'plan-batch-002' }] },
                    'Session ID': { rich_text: [{ plain_text: 'sess-batch-002' }] },
                    'Kanban Column': { select: { name: 'BACKLOG' } },
                    'Status': { select: { name: 'active' } },
                    'Complexity': { number: 2 },
                    'Tags': { multi_select: [] },
                    'Dependencies': { rich_text: [{ plain_text: '' }] },
                    'Repo Scope': { rich_text: [{ plain_text: '' }] },
                    'Workspace ID': { rich_text: [{ plain_text: 'test-ws-id' }] },
                    'Created At': { date: { start: date } },
                    'Updated At': { date: { start: date } },
                    'Last Action': { rich_text: [{ plain_text: '' }] },
                    'Source Type': { select: { name: 'local' } },
                    'ClickUp Task ID': { rich_text: [{ plain_text: '' }] },
                    'Linear Issue ID': { rich_text: [{ plain_text: '' }] }
                }
            }
        ];

        mockResponses = [
            { status: 200, data: { results: pages, has_more: false } }
        ];

        const result = await service.restoreFromNotion(tmpDir);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.restored, 2);

        const plans = await kanbanDb.getAllPlans('test-ws-id');
        assert.ok(plans.some(p => p.planId === 'plan-batch-001'));
        assert.ok(plans.some(p => p.planId === 'plan-batch-002'));
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
