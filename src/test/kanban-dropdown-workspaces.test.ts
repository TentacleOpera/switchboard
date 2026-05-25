import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { KanbanProvider } from '../services/KanbanProvider';

suite('Kanban Dropdown Workspaces Selection', () => {
    let mockContext: vscode.ExtensionContext;
    let workspaceState: Map<string, any>;
    let originalGetConfiguration: any;

    setup(() => {
        workspaceState = new Map();
        mockContext = {
            workspaceState: {
                get: (key: string, defaultValue?: any) => workspaceState.has(key) ? workspaceState.get(key) : defaultValue,
                update: (key: string, value: any) => {
                    workspaceState.set(key, value);
                    return Promise.resolve();
                }
            },
            globalState: {
                get: (key: string, defaultValue?: any) => workspaceState.has(key) ? workspaceState.get(key) : defaultValue,
                update: (key: string, value: any) => {
                    workspaceState.set(key, value);
                    return Promise.resolve();
                }
            }
        } as unknown as vscode.ExtensionContext;
        originalGetConfiguration = vscode.workspace.getConfiguration;
    });

    teardown(() => {
        vscode.workspace.getConfiguration = originalGetConfiguration;
    });

    function mockSwitchboardConfig(config: any) {
        vscode.workspace.getConfiguration = (section?: string) => {
            if (section === 'switchboard') {
                return {
                    get: (key: string) => {
                        if (key === 'workspaceDatabaseMappings') {
                            return config;
                        }
                        return undefined;
                    }
                } as any;
            }
            return {} as any;
        };
    }

    test('1. Disabled workspaceDatabaseMappings uses standard workspace roots', () => {
        mockSwitchboardConfig({ enabled: false, mappings: [] });
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => ['/path/to/ws1', '/path/to/ws2'];

        const items = (provider as any)._getWorkspaceItems();
        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].label, 'ws1');
        assert.strictEqual(items[0].workspaceRoot, path.resolve('/path/to/ws1'));
        assert.strictEqual(items[1].label, 'ws2');
        assert.strictEqual(items[1].workspaceRoot, path.resolve('/path/to/ws2'));
    });

    test('2. Enabled mappings with dropdown workspaces, but active root is not mapped', () => {
        const mappings = [
            {
                id: '1',
                name: 'Workspace A',
                dbPath: '/db/a.db',
                workspaceFolders: ['/path/to/ws1'],
                dropdownWorkspaces: ['/path/to/dropdown-child']
            }
        ];
        mockSwitchboardConfig({ enabled: true, mappings });
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => ['/path/to/other-ws'];

        const items = (provider as any)._getWorkspaceItems();
        // Since active root is NOT mapped, fallback to standard workspace roots
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].label, 'other-ws');
        assert.strictEqual(items[0].workspaceRoot, path.resolve('/path/to/other-ws'));
    });

    test('3. Mapped when open workspace root matches a dropdownWorkspace folder', () => {
        const mappings = [
            {
                id: '1',
                name: 'Workspace A',
                dbPath: '/db/a.db',
                workspaceFolders: ['/path/to/ws1'],
                dropdownWorkspaces: ['/path/to/dropdown-child']
            }
        ];
        mockSwitchboardConfig({ enabled: true, mappings });
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => ['/path/to/dropdown-child'];

        const items = (provider as any)._getWorkspaceItems();
        // Should trigger anyOpenFolderIsMapped = true and return mapping list with deduplicated roots
        assert.strictEqual(items.length, 2);
        
        // Item 1: configured parent/workspaceFolder[0]
        assert.strictEqual(items[0].label, 'Workspace A');
        assert.strictEqual(items[0].workspaceRoot, path.resolve('/path/to/ws1'));
        
        // Item 2: dropdownWorkspace
        assert.strictEqual(items[1].label, 'dropdown-child');
        assert.strictEqual(items[1].workspaceRoot, path.resolve('/path/to/dropdown-child'));
    });

    test('4. Home directory expansion (~) is resolved correctly for dropdown workspaces', () => {
        const home = os.homedir();
        const mappings = [
            {
                id: '1',
                name: 'Workspace A',
                dbPath: '/db/a.db',
                workspaceFolders: ['~/repos/parent'],
                dropdownWorkspaces: ['~/repos/child-workspace']
            }
        ];
        mockSwitchboardConfig({ enabled: true, mappings });
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => [path.join(home, 'repos', 'child-workspace')];

        const items = (provider as any)._getWorkspaceItems();
        assert.strictEqual(items.length, 2);
        
        assert.strictEqual(items[0].label, 'Workspace A');
        assert.strictEqual(items[0].workspaceRoot, path.resolve(path.join(home, 'repos', 'parent')));
        
        assert.strictEqual(items[1].label, 'child-workspace');
        assert.strictEqual(items[1].workspaceRoot, path.resolve(path.join(home, 'repos', 'child-workspace')));
    });

    test('5. resolveEffectiveWorkspaceRoot resolves dropdown workspace to parent folder', () => {
        const mappings = [
            {
                id: '1',
                name: 'Workspace A',
                dbPath: '/db/a.db',
                workspaceFolders: ['/path/to/ws1'],
                dropdownWorkspaces: ['/path/to/dropdown-child']
            }
        ];
        mockSwitchboardConfig({ enabled: true, mappings });
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        
        const resolved = provider.resolveEffectiveWorkspaceRoot('/path/to/dropdown-child');
        assert.strictEqual(resolved, path.resolve('/path/to/ws1'));
    });

    test('6. _getAllowedRoots includes dropdown workspace paths', () => {
        const mappings = [
            {
                id: '1',
                name: 'Workspace A',
                dbPath: '/db/a.db',
                parentFolder: '/path/to/parent',
                workspaceFolders: ['/path/to/ws1'],
                dropdownWorkspaces: ['/path/to/dropdown-child']
            }
        ];
        mockSwitchboardConfig({ enabled: true, mappings });
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => ['/path/to/parent'];

        const allowed = (provider as any)._getAllowedRoots();
        assert.ok(allowed.has(path.resolve('/path/to/parent')), 'parentFolder should be in allowed set');
        assert.ok(allowed.has(path.resolve('/path/to/ws1')), 'workspaceFolder should be in allowed set');
        assert.ok(allowed.has(path.resolve('/path/to/dropdown-child')), 'dropdownWorkspace should be in allowed set');
    });

    test('7. _getAllowedRoots includes tilde-expanded dropdown workspace paths', () => {
        const home = os.homedir();
        const mappings = [
            {
                id: '1',
                name: 'Workspace A',
                dbPath: '/db/a.db',
                parentFolder: '~/repos/parent',
                workspaceFolders: ['~/repos/ws1'],
                dropdownWorkspaces: ['~/repos/dropdown-child']
            }
        ];
        mockSwitchboardConfig({ enabled: true, mappings });
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => [path.join(home, 'repos', 'parent')];

        const allowed = (provider as any)._getAllowedRoots();
        assert.ok(allowed.has(path.resolve(path.join(home, 'repos', 'parent'))), 'expanded parentFolder should be in allowed set');
        assert.ok(allowed.has(path.resolve(path.join(home, 'repos', 'ws1'))), 'expanded workspaceFolder should be in allowed set');
        assert.ok(allowed.has(path.resolve(path.join(home, 'repos', 'dropdown-child'))), 'expanded dropdownWorkspace should be in allowed set');
    });

    test('8. setCurrentWorkspaceRoot accepts dropdown workspace from allowed set', () => {
        const mappings = [
            {
                id: '1',
                name: 'Workspace A',
                dbPath: '/db/a.db',
                parentFolder: '/path/to/parent',
                workspaceFolders: ['/path/to/ws1'],
                dropdownWorkspaces: ['/path/to/dropdown-child']
            }
        ];
        mockSwitchboardConfig({ enabled: true, mappings });
        const provider = new KanbanProvider(vscode.Uri.file('/tmp'), mockContext);
        (provider as any)._getWorkspaceRoots = () => ['/path/to/parent'];

        // First set to parent (baseline)
        const parentResult = (provider as any).setCurrentWorkspaceRoot('/path/to/parent');
        assert.strictEqual(parentResult, true, 'should accept parent workspace');

        // Now try dropdown workspace
        const dropdownResult = (provider as any).setCurrentWorkspaceRoot('/path/to/dropdown-child');
        assert.strictEqual(dropdownResult, true, 'should accept dropdown workspace');
    });
});
