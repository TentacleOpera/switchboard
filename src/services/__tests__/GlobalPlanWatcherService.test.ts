
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GlobalPlanWatcherService } from '../GlobalPlanWatcherService';
import { KanbanDatabase } from '../KanbanDatabase';
import * as WorkspaceIdentityService from '../WorkspaceIdentityService';

suite('GlobalPlanWatcherService', () => {
    let sandbox: sinon.SinonSandbox;
    let service: GlobalPlanWatcherService;
    let outputChannelStub: any;
    let getClickUpServiceStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        outputChannelStub = {
            appendLine: sandbox.stub()
        };
        getClickUpServiceStub = sandbox.stub();
        service = new GlobalPlanWatcherService(getClickUpServiceStub, outputChannelStub);
    });

    teardown(() => {
        sandbox.restore();
        service.dispose();
    });

    suite('periodic scan', () => {
        test('starts interval in initialize', async () => {
            const clock = sandbox.useFakeTimers();
            const startScanSpy = sandbox.spy(service as any, '_startPeriodicScan');
            
            sandbox.stub(service as any, '_refreshWatchers').resolves();
            
            const getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
            getConfigurationStub.returns({
                get: (key: string) => true
            } as any);

            await service.initialize();
            
            assert.ok(startScanSpy.calledOnce);
            assert.ok((service as any)._scanInterval !== undefined);
        });

        test('stops existing interval before starting new one', () => {
            const clock = sandbox.useFakeTimers();
            const clearIntervalSpy = sandbox.spy(clock, 'clearInterval');
            
            (service as any)._scanInterval = setInterval(() => {}, 1000);
            
            const getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
            getConfigurationStub.returns({
                get: (key: string) => true
            } as any);

            (service as any)._startPeriodicScan();
            
            assert.ok(clearIntervalSpy.calledOnce);
        });

        test('does not start interval if disabled in config', () => {
            const getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
            getConfigurationStub.returns({
                get: (key: string) => {
                    if (key === 'periodicScanEnabled') return false;
                    return 10000;
                }
            } as any);

            (service as any)._startPeriodicScan();
            
            assert.strictEqual((service as any)._scanInterval, undefined);
        });

        test('_scanForNewFiles discovers and debounces new files', async () => {
            const workspaceRoot = '/mock/root';
            const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
            
            sandbox.stub(fs, 'existsSync').withArgs(plansDir).returns(true);
            
            const dbStub = {
                ensureReady: sandbox.stub().resolves(),
                getWorkspaceId: sandbox.stub().resolves('ws-123'),
                getAllPlans: sandbox.stub().resolves([]),
            };
            sandbox.stub(KanbanDatabase, 'forWorkspace').returns(dbStub as any);

            const readdirStub = sandbox.stub(fs.promises, 'readdir');
            readdirStub.withArgs(plansDir, { withFileTypes: true } as any).resolves([
                { name: 'plan1.md', isFile: () => true, isDirectory: () => false }
            ] as any);

            const statStub = sandbox.stub(fs.promises, 'stat');
            statStub.resolves({ mtimeMs: Date.now() - 1000 } as any);

            const debounceSpy = sandbox.spy(service as any, '_debounceHandleFile');

            await (service as any)._scanForNewFiles(workspaceRoot);

            assert.ok(debounceSpy.calledOnce);
            const call = debounceSpy.getCall(0);
            assert.strictEqual(call.args[0].fsPath, path.join(plansDir, 'plan1.md'));
            assert.strictEqual(call.args[1], workspaceRoot);
        });

        test('_scanForNewFiles skips existing plans', async () => {
            const workspaceRoot = '/mock/root';
            const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
            
            sandbox.stub(fs, 'existsSync').withArgs(plansDir).returns(true);
            
            const dbStub = {
                ensureReady: sandbox.stub().resolves(),
                getWorkspaceId: sandbox.stub().resolves('ws-123'),
                getAllPlans: sandbox.stub().resolves([{ planFile: '.switchboard/plans/plan1.md' }]),
            };
            sandbox.stub(KanbanDatabase, 'forWorkspace').returns(dbStub as any);

            const readdirStub = sandbox.stub(fs.promises, 'readdir');
            readdirStub.resolves([
                { name: 'plan1.md', isFile: () => true, isDirectory: () => false }
            ] as any);

            const debounceSpy = sandbox.spy(service as any, '_debounceHandleFile');

            await (service as any)._scanForNewFiles(workspaceRoot);

            assert.strictEqual(debounceSpy.called, false);
        });

        test('_scanForNewFiles skips files older than last scan', async () => {
            const workspaceRoot = '/mock/root';
            const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
            
            sandbox.stub(fs, 'existsSync').withArgs(plansDir).returns(true);
            
            const dbStub = {
                ensureReady: sandbox.stub().resolves(),
                getWorkspaceId: sandbox.stub().resolves('ws-123'),
                getAllPlans: sandbox.stub().resolves([]),
            };
            sandbox.stub(KanbanDatabase, 'forWorkspace').returns(dbStub as any);

            (service as any)._lastScanTime.set(workspaceRoot, Date.now() - 5000);

            const readdirStub = sandbox.stub(fs.promises, 'readdir');
            readdirStub.resolves([
                { name: 'old-plan.md', isFile: () => true, isDirectory: () => false }
            ] as any);

            const statStub = sandbox.stub(fs.promises, 'stat');
            statStub.resolves({ mtimeMs: Date.now() - 10000 } as any);

            const debounceSpy = sandbox.spy(service as any, '_debounceHandleFile');

            await (service as any)._scanForNewFiles(workspaceRoot);

            assert.strictEqual(debounceSpy.called, false);
        });

        test('_scanForNewFiles skips very recent files (grace window)', async () => {
            const workspaceRoot = '/mock/root';
            const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
            
            sandbox.stub(fs, 'existsSync').withArgs(plansDir).returns(true);
            
            const dbStub = {
                ensureReady: sandbox.stub().resolves(),
                getWorkspaceId: sandbox.stub().resolves('ws-123'),
                getAllPlans: sandbox.stub().resolves([]),
            };
            sandbox.stub(KanbanDatabase, 'forWorkspace').returns(dbStub as any);

            const readdirStub = sandbox.stub(fs.promises, 'readdir');
            readdirStub.resolves([
                { name: 'recent-plan.md', isFile: () => true, isDirectory: () => false }
            ] as any);

            const statStub = sandbox.stub(fs.promises, 'stat');
            statStub.resolves({ mtimeMs: Date.now() - 100 } as any); // 100ms ago, inside 500ms window

            const debounceSpy = sandbox.spy(service as any, '_debounceHandleFile');

            await (service as any)._scanForNewFiles(workspaceRoot);

            assert.strictEqual(debounceSpy.called, false);
        });

        test('dispose clears the interval', () => {
            const clock = sandbox.useFakeTimers();
            const clearIntervalSpy = sandbox.spy(clock, 'clearInterval');
            
            (service as any)._scanInterval = setInterval(() => {}, 1000);
            
            service.dispose();
            
            assert.ok(clearIntervalSpy.calledOnce);
            assert.strictEqual((service as any)._scanInterval, undefined);
        });
    });

    suite('_getAllMappedFolders', () => {
        test('returns workspace folders if no mappings enabled', async () => {
            const mockWorkspaceFolders: any[] = [
                { uri: { fsPath: '/mock/workspace1' } },
                { uri: { fsPath: '/mock/workspace2' } }
            ];
            sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => mockWorkspaceFolders);
            
            const getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
            getConfigurationStub.withArgs('switchboard').returns({
                get: (key: string) => {
                    if (key === 'workspaceDatabaseMappings') return { enabled: false, mappings: [] };
                    return undefined;
                }
            } as any);

            const folders = await (service as any)._getAllMappedFolders();
            assert.deepStrictEqual(folders, ['/mock/workspace1', '/mock/workspace2']);
        });

        test('returns mapped folders if mappings enabled', async () => {
            const getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
            
            // Mock fs.existsSync to return true for these paths
            const existsSyncStub = sandbox.stub(fs, 'existsSync');
            existsSyncStub.returns(true);

            getConfigurationStub.withArgs('switchboard').returns({
                get: (key: string) => {
                    if (key === 'workspaceDatabaseMappings') return {
                        enabled: true,
                        mappings: [
                            {
                                id: 'm1',
                                name: 'Mapping 1',
                                parentFolder: '/mock/parent1',
                                workspaceFolders: ['/mock/ws1', '/mock/ws2']
                            }
                        ]
                    };
                    return undefined;
                }
            } as any);

            const folders = await (service as any)._getAllMappedFolders();
            assert.ok(folders.includes('/mock/parent1'));
            assert.ok(folders.includes('/mock/ws1'));
            assert.ok(folders.includes('/mock/ws2'));
            assert.strictEqual(folders.length, 3);
        });

        test('expands home directory in mapping paths', async () => {
            sandbox.stub(os, 'homedir').returns('/home/user');
            
            // Mock fs.existsSync
            const existsSyncStub = sandbox.stub(fs, 'existsSync');
            existsSyncStub.returns(true);

            const getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
            getConfigurationStub.withArgs('switchboard').returns({
                get: (key: string) => {
                    if (key === 'workspaceDatabaseMappings') return {
                        enabled: true,
                        mappings: [
                            {
                                id: 'm1',
                                name: 'Mapping 1',
                                parentFolder: '~/mock/parent1',
                                workspaceFolders: []
                            }
                        ]
                    };
                    return undefined;
                }
            } as any);

            const folders = await (service as any)._getAllMappedFolders();
            assert.deepStrictEqual(folders, [path.resolve('/home/user/mock/parent1')]);
        });
    });

    suite('_handlePlanFile', () => {
        const workspaceRoot = '/mock/root';
        const planPath = '/mock/root/.switchboard/plans/plan1.md';
        const relativePath = '.switchboard/plans/plan1.md';
        const mockUri = { fsPath: planPath } as vscode.Uri;
        const fixedMtime = new Date('2025-06-01T12:00:00.000Z');
        const fixedBirthtime = new Date('2025-05-15T08:30:00.000Z');

        let dbStub: any;
        let upsertSpy: sinon.SinonStub;

        setup(() => {
            dbStub = {
                ensureReady: sandbox.stub().resolves(),
                getWorkspaceId: sandbox.stub().resolves('ws-123'),
                getDominantWorkspaceId: sandbox.stub().resolves('ws-123'),
            };
            upsertSpy = sandbox.stub().resolves();
            dbStub.upsertPlans = upsertSpy;
            sandbox.stub(KanbanDatabase, 'forWorkspace').returns(dbStub as any);
        });

        test('uses file mtime for updatedAt on existing plans', async () => {
            dbStub.getPlanByPlanFile = sandbox.stub().resolves({
                planId: 'existing-plan-id',
                sessionId: 'sess-123',
                planFile: relativePath,
                workspaceId: 'ws-123',
                createdAt: fixedBirthtime.toISOString(),
                updatedAt: fixedBirthtime.toISOString(),
            });

            sandbox.stub(fs.promises, 'stat').resolves({
                mtime: fixedMtime,
                birthtime: fixedBirthtime,
            } as any);

            sandbox.stub(fs.promises, 'readFile').resolves('# Plan\n\n## Topic\nTest topic');

            const { parsePlanMetadata } = await import('../planMetadataUtils');
            const parseStub = sandbox.stub(await import('../planMetadataUtils'), 'parsePlanMetadata');
            parseStub.resolves({ sessionId: 'sess-123', topic: 'Test topic', complexity: '3', tags: '', kanbanColumn: 'CREATED' });

            await (service as any)._handlePlanFile(mockUri, workspaceRoot);

            const upserted = upsertSpy.getCall(0).args[0][0];
            assert.strictEqual(upserted.updatedAt, fixedMtime.toISOString());
        });

        test('uses file birthtime for createdAt on new plans', async () => {
            dbStub.getPlanByPlanFile = sandbox.stub().resolves(undefined);

            sandbox.stub(fs.promises, 'stat').resolves({
                mtime: fixedMtime,
                birthtime: fixedBirthtime,
            } as any);

            sandbox.stub(fs.promises, 'readFile').resolves('# Plan\n\n## Topic\nTest topic');

            const parseStub = sandbox.stub(await import('../planMetadataUtils'), 'parsePlanMetadata');
            parseStub.resolves({ sessionId: 'sess-123', topic: 'Test topic', complexity: '3', tags: '', kanbanColumn: 'CREATED' });

            await (service as any)._handlePlanFile(mockUri, workspaceRoot);

            const upserted = upsertSpy.getCall(0).args[0][0];
            assert.strictEqual(upserted.createdAt, fixedBirthtime.toISOString());
            assert.strictEqual(upserted.updatedAt, fixedMtime.toISOString());
        });

        test('falls back to mtime when birthtime is epoch-zero', async () => {
            dbStub.getPlanByPlanFile = sandbox.stub().resolves(undefined);

            sandbox.stub(fs.promises, 'stat').resolves({
                mtime: fixedMtime,
                birthtime: new Date(0),
            } as any);

            sandbox.stub(fs.promises, 'readFile').resolves('# Plan\n\n## Topic\nTest topic');

            const parseStub = sandbox.stub(await import('../planMetadataUtils'), 'parsePlanMetadata');
            parseStub.resolves({ sessionId: 'sess-123', topic: 'Test topic', complexity: '3', tags: '', kanbanColumn: 'CREATED' });

            await (service as any)._handlePlanFile(mockUri, workspaceRoot);

            const upserted = upsertSpy.getCall(0).args[0][0];
            assert.strictEqual(upserted.createdAt, fixedMtime.toISOString());
            assert.notStrictEqual(upserted.createdAt, '1970-01-01T00:00:00.000Z');
        });

        test('falls back to current time when stat() throws', async () => {
            dbStub.getPlanByPlanFile = sandbox.stub().resolves({
                planId: 'existing-plan-id',
                sessionId: 'sess-123',
                planFile: relativePath,
                workspaceId: 'ws-123',
                createdAt: fixedBirthtime.toISOString(),
                updatedAt: fixedBirthtime.toISOString(),
            });

            sandbox.stub(fs.promises, 'stat').rejects(new Error('ENOENT'));
            sandbox.stub(fs.promises, 'readFile').resolves('# Plan\n\n## Topic\nTest topic');

            const parseStub = sandbox.stub(await import('../planMetadataUtils'), 'parsePlanMetadata');
            parseStub.resolves({ sessionId: 'sess-123', topic: 'Test topic', complexity: '3', tags: '', kanbanColumn: 'CREATED' });

            const before = Date.now();
            await (service as any)._handlePlanFile(mockUri, workspaceRoot);
            const after = Date.now();

            const upserted = upsertSpy.getCall(0).args[0][0];
            const updatedAtMs = new Date(upserted.updatedAt).getTime();
            assert.ok(updatedAtMs >= before && updatedAtMs <= after, 'updatedAt should be approximately current time');
        });

        test('logs stat failure to output channel', async () => {
            dbStub.getPlanByPlanFile = sandbox.stub().resolves({
                planId: 'existing-plan-id',
                sessionId: 'sess-123',
                planFile: relativePath,
                workspaceId: 'ws-123',
                createdAt: fixedBirthtime.toISOString(),
                updatedAt: fixedBirthtime.toISOString(),
            });

            sandbox.stub(fs.promises, 'stat').rejects(new Error('ENOENT'));
            sandbox.stub(fs.promises, 'readFile').resolves('# Plan\n\n## Topic\nTest topic');

            const parseStub = sandbox.stub(await import('../planMetadataUtils'), 'parsePlanMetadata');
            parseStub.resolves({ sessionId: 'sess-123', topic: 'Test topic', complexity: '3', tags: '', kanbanColumn: 'CREATED' });

            await (service as any)._handlePlanFile(mockUri, workspaceRoot);

            const logCalls = outputChannelStub.appendLine.getCalls();
            const statFailedCall = logCalls.find((c: any) => c.args[0].includes('stat() failed'));
            assert.ok(statFailedCall, 'Expected output channel to log stat() failure');
        });

        test('existing plan with empty project is NOT reassigned to active project on update', async () => {
            dbStub.getPlanByPlanFile = sandbox.stub().resolves({
                planId: 'plan-1',
                sessionId: '',
                topic: 'Existing plan',
                planFile: relativePath,
                kanbanColumn: 'CREATED',
                status: 'active',
                complexity: '3',
                tags: '',
                project: '',           // ← no project assigned
                workspaceId: 'ws-123',
                projectId: null,
            } as any);

            // Simulate the board having "Project A" as the active filter
            dbStub.getConfig = sandbox.stub().withArgs('kanban.activeProjectFilter').resolves('Project A');
            const insertSpy = sandbox.stub().resolves(true);
            dbStub.insertFileDerivedPlan = insertSpy;

            sandbox.stub(fs.promises, 'stat').resolves({
                mtime: fixedMtime,
                birthtime: fixedBirthtime,
            } as any);
            sandbox.stub(fs.promises, 'readFile').resolves('# Plan\n\n## Topic\nExisting plan');
            const parseStub = sandbox.stub(await import('../planMetadataUtils'), 'parsePlanMetadata');
            parseStub.resolves({ sessionId: '', topic: 'Existing plan', complexity: '3', tags: '', kanbanColumn: 'CREATED' });

            await (service as any)._handlePlanFile(mockUri, workspaceRoot);

            const upserted = insertSpy.getCall(0).args[0];
            assert.strictEqual(upserted.project, '', 'Existing plan must not be reassigned to active project on update');
        });
    });

    suite('setCurrentProject', () => {
        const workspaceRoot = '/parent/root';
        const parentPlanPath = '/parent/root/.switchboard/plans/plan1.md';
        const parentMockUri = { fsPath: parentPlanPath } as any;
        const fixedMtime = new Date('2025-06-01T12:00:00.000Z');
        const fixedBirthtime = new Date('2025-05-15T08:30:00.000Z');

        let dbStub: any;
        let upsertSpy: sinon.SinonStub;
        let resolveStub: sinon.SinonStub;

        setup(() => {
            dbStub = {
                ensureReady: sandbox.stub().resolves(),
                getWorkspaceId: sandbox.stub().resolves('ws-123'),
                getDominantWorkspaceId: sandbox.stub().resolves('ws-123'),
            };
            upsertSpy = sandbox.stub().resolves();
            dbStub.upsertPlans = upsertSpy;
            sandbox.stub(KanbanDatabase, 'forWorkspace').returns(dbStub as any);
            resolveStub = sandbox.stub(WorkspaceIdentityService, 'resolveEffectiveWorkspaceRootFromMappings');
        });

        test('resolves child workspace root to parent before caching', () => {
            resolveStub.withArgs('/child/root').returns('/parent/root');
            (service as any).setCurrentProject('/child/root', 'PII Data');
            assert.strictEqual((service as any)._currentProjects.get('/parent/root'), 'PII Data');
            assert.strictEqual((service as any)._currentProjects.has('/child/root'), false);
        });

        test('uses workspaceRoot as-is when no mapping exists', () => {
            resolveStub.withArgs('/standalone/root').returns('/standalone/root');
            (service as any).setCurrentProject('/standalone/root', 'My Project');
            assert.strictEqual((service as any)._currentProjects.get('/standalone/root'), 'My Project');
        });

        test('deletes project entry when filter is null', () => {
            resolveStub.withArgs('/child/root').returns('/parent/root');
            (service as any).setCurrentProject('/child/root', 'PII Data');
            (service as any).setCurrentProject('/child/root', null);
            assert.strictEqual((service as any)._currentProjects.has('/parent/root'), false);
        });

        test('translates UNASSIGNED sentinel to delete', () => {
            resolveStub.withArgs('/child/root').returns('/parent/root');
            (service as any).setCurrentProject('/child/root', KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
            assert.strictEqual((service as any)._currentProjects.has('/parent/root'), false);
        });

        test('new plans detected by watcher inherit the project filter set via child workspace path', async () => {
            resolveStub.withArgs('/child/root').returns('/parent/root');
            (service as any).setCurrentProject('/child/root', 'PII Data');

            dbStub.getPlanByPlanFile = sandbox.stub().resolves(undefined);
            sandbox.stub(fs.promises, 'stat').resolves({
                mtime: fixedMtime,
                birthtime: fixedBirthtime,
            } as any);
            sandbox.stub(fs.promises, 'readFile').resolves('# Plan\n\n## Topic\nTest topic');
            const parseStub = sandbox.stub(await import('../planMetadataUtils'), 'parsePlanMetadata');
            parseStub.resolves({ sessionId: 'sess-123', topic: 'Test topic', complexity: '3', tags: '', kanbanColumn: 'CREATED' });

            await (service as any)._handlePlanFile(parentMockUri, workspaceRoot);

            const upserted = upsertSpy.getCall(0).args[0][0];
            assert.strictEqual(upserted.project, 'PII Data');
        });

        test('new plans detected by watcher resolve child workspace path during handle', async () => {
            resolveStub.withArgs('/child/root').returns('/parent/root');
            (service as any).setCurrentProject('/child/root', 'PII Data');

            dbStub.getPlanByPlanFile = sandbox.stub().resolves(undefined);
            sandbox.stub(fs.promises, 'stat').resolves({
                mtime: fixedMtime,
                birthtime: fixedBirthtime,
            } as any);
            sandbox.stub(fs.promises, 'readFile').resolves('# Plan\n\n## Topic\nTest topic');
            const parseStub = sandbox.stub(await import('../planMetadataUtils'), 'parsePlanMetadata');
            parseStub.resolves({ sessionId: 'sess-123', topic: 'Test topic', complexity: '3', tags: '', kanbanColumn: 'CREATED' });

            await (service as any)._handlePlanFile(parentMockUri, '/child/root');

            const upserted = upsertSpy.getCall(0).args[0][0];
            assert.strictEqual(upserted.project, 'PII Data');
        });
    });
});
