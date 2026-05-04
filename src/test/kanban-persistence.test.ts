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
});
