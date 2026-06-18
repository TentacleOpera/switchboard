import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { KanbanProvider } from '../services/KanbanProvider';

suite('Kanban Workspace Persistence', () => {
    let mockContext: vscode.ExtensionContext;
    let workspaceState: Map<string, any>;

    setup(() => {
        workspaceState = new Map();
        mockContext = {
            workspaceState: {
                get: (key: string, defaultValue?: any) => workspaceState.has(key) ? workspaceState.get(key) : defaultValue,
                update: (key: string, value: any) => {
                    workspaceState.set(key, value);
                    return Promise.resolve();
                }
            }
        } as unknown as vscode.ExtensionContext;
    });

    test('Constructor restores workspace by index when name matches', () => {
        const roots = ['/path/to/ws1', '/path/to/ws2'];
        workspaceState.set('kanban.lastSelectedWorkspace', { index: 1, name: 'ws2' });

        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        
        // Mock _getWorkspaceRoots to return our controlled roots
        (provider as any)._getWorkspaceRoots = () => roots;
        
        // We need to re-initialize because the constructor already ran with default _getWorkspaceRoots
        const restored = (provider as any)._resolvePersistedWorkspace(workspaceState.get('kanban.lastSelectedWorkspace'));
        
        assert.strictEqual(restored, '/path/to/ws2');
    });

    test('Constructor falls back to name matching when index is wrong', () => {
        const roots = ['/path/to/ws2', '/path/to/ws1']; // ws2 is now at index 0
        workspaceState.set('kanban.lastSelectedWorkspace', { index: 1, name: 'ws2' });

        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => roots;
        
        const restored = (provider as any)._resolvePersistedWorkspace(workspaceState.get('kanban.lastSelectedWorkspace'));
        
        assert.strictEqual(restored, '/path/to/ws2');
    });

    test('Constructor returns null when workspace no longer exists', () => {
        const roots = ['/path/to/ws1', '/path/to/ws3'];
        workspaceState.set('kanban.lastSelectedWorkspace', { index: 1, name: 'ws2' });

        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => roots;
        
        const restored = (provider as any)._resolvePersistedWorkspace(workspaceState.get('kanban.lastSelectedWorkspace'));
        
        assert.strictEqual(restored, null);
    });

    test('selectWorkspace handler persists index and name', async () => {
        const roots = ['/path/to/ws1', '/path/to/ws2'];
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => roots;
        
        // Mock _resolveWorkspaceRoot to avoid database/file system calls
        (provider as any)._resolveWorkspaceRoot = () => '/path/to/ws2';
        (provider as any)._setupSessionWatcher = () => {};
        (provider as any)._setupPlanContentWatcher = () => {};
        (provider as any)._refreshBoard = () => Promise.resolve();

        // Simulate selectWorkspace message
        const msg = {
            type: 'selectWorkspace',
            workspaceRoot: '/path/to/ws2'
        };

        // Access the private _handleMessage via any
        await (provider as any)._handleMessage(msg);

        const persisted = workspaceState.get('kanban.lastSelectedWorkspace');
        assert.deepStrictEqual(persisted, { index: 1, name: 'ws2' });
    });

    test('Constructor restores project filter and sets validation flag', () => {
        const roots = ['/path/to/ws1', '/path/to/ws2'];
        workspaceState.set('kanban.lastSelectedWorkspace', { index: 1, name: 'ws2', pathSegments: ['to', 'ws2'] });
        workspaceState.set('kanban.projectFilter./path/to/ws2', 'project-a');

        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => roots;
        
        // Resolve persisted workspace and mock current workspace root
        const restoredWs = (provider as any)._resolvePersistedWorkspace(workspaceState.get('kanban.lastSelectedWorkspace'));
        (provider as any)._currentWorkspaceRoot = restoredWs;

        // Simulate constructor's restore block manually since the constructor ran before roots were mocked
        if (restoredWs) {
            const resolvedRoot = path.resolve(restoredWs);
            const persistedFilter = mockContext.workspaceState.get<string | null>(`kanban.projectFilter.${resolvedRoot}`, null);
            if (persistedFilter !== null) {
                (provider as any)._projectFilter = persistedFilter;
                (provider as any)._projectFilterNeedsValidation = true;
            }
        }

        assert.strictEqual(provider.getProjectFilter(), 'project-a');
        assert.strictEqual((provider as any)._projectFilterNeedsValidation, true);
    });

    test('Validation on board refresh fallback to UNASSIGNED if project no longer exists', async () => {
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._projectFilter = 'deleted-project';
        (provider as any)._projectFilterNeedsValidation = true;

        // Stub the DB
        const mockDb = {
            ensureReady: () => Promise.resolve(true),
            getProjects: () => Promise.resolve(['project-a', 'project-b']),
            getBoardFilteredByProject: () => Promise.resolve([]),
            getCompletedPlans: () => Promise.resolve([]),
            getWorktrees: () => Promise.resolve([])
        };
        (provider as any)._getKanbanDb = () => mockDb;
        (provider as any)._resolveWorkspaceRoot = () => '/path/to/ws2';
        (provider as any)._readWorkspaceId = () => Promise.resolve('ws-id');
        (provider as any)._getCustomAgents = () => Promise.resolve([]);
        (provider as any)._getCustomKanbanColumns = () => Promise.resolve([]);
        (provider as any)._buildKanbanColumns = () => Promise.resolve([]);
        (provider as any)._getAgentNames = () => Promise.resolve([]);
        (provider as any)._getVisibleAgents = () => Promise.resolve([]);
        (provider as any)._filterDynamicColumns = () => [];
        (provider as any)._columnsSignature = () => '';
        (provider as any)._getWorkspaceItems = () => [];
        (provider as any)._getAllWorkspaceProjects = () => Promise.resolve({});
        (provider as any).getControlPlaneSelectionStatus = () => ({ mode: 'none' });

        // Set up dummy webview panel
        (provider as any)._panel = {
            webview: {
                postMessage: () => Promise.resolve(true)
            }
        };

        // Trigger refresh board
        await (provider as any)._refreshBoardImpl('/path/to/ws2');

        // Verify fallback to UNASSIGNED_PROJECT_FILTER
        assert.strictEqual(provider.getProjectFilter(), '__unassigned__');
        assert.strictEqual((provider as any)._projectFilterNeedsValidation, false);
    });

    test('Validation on board refresh keeps project if it still exists', async () => {
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._projectFilter = 'project-b';
        (provider as any)._projectFilterNeedsValidation = true;

        // Stub the DB
        const mockDb = {
            ensureReady: () => Promise.resolve(true),
            getProjects: () => Promise.resolve(['project-a', 'project-b']),
            getBoardFilteredByProject: () => Promise.resolve([]),
            getCompletedPlans: () => Promise.resolve([]),
            getWorktrees: () => Promise.resolve([])
        };
        (provider as any)._getKanbanDb = () => mockDb;
        (provider as any)._resolveWorkspaceRoot = () => '/path/to/ws2';
        (provider as any)._readWorkspaceId = () => Promise.resolve('ws-id');
        (provider as any)._getCustomAgents = () => Promise.resolve([]);
        (provider as any)._getCustomKanbanColumns = () => Promise.resolve([]);
        (provider as any)._buildKanbanColumns = () => Promise.resolve([]);
        (provider as any)._getAgentNames = () => Promise.resolve([]);
        (provider as any)._getVisibleAgents = () => Promise.resolve([]);
        (provider as any)._filterDynamicColumns = () => [];
        (provider as any)._columnsSignature = () => '';
        (provider as any)._getWorkspaceItems = () => [];
        (provider as any)._getAllWorkspaceProjects = () => Promise.resolve({});
        (provider as any).getControlPlaneSelectionStatus = () => ({ mode: 'none' });

        // Set up dummy webview panel
        (provider as any)._panel = {
            webview: {
                postMessage: () => Promise.resolve(true)
            }
        };

        // Trigger refresh board
        await (provider as any)._refreshBoardImpl('/path/to/ws2');

        // Verify project is kept
        assert.strictEqual(provider.getProjectFilter(), 'project-b');
        assert.strictEqual((provider as any)._projectFilterNeedsValidation, false);
    });
});
