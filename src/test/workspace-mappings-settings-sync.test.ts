import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SetupPanelProvider } from '../services/SetupPanelProvider';
import { clearMappingCache } from '../services/WorkspaceIdentityService';

suite('Workspace Mappings Settings Sync Suite', () => {
    let originalGetConfiguration: any;
    let mockConfigData: any;
    let capturedFolderUri: vscode.Uri | undefined;
    let configUpdatedData: { section: string; value: any; target: vscode.ConfigurationTarget }[] = [];

    setup(() => {
        originalGetConfiguration = vscode.workspace.getConfiguration;
        mockConfigData = { enabled: false, mappings: [] };
        capturedFolderUri = undefined;
        configUpdatedData = [];
    });

    teardown(() => {
        vscode.workspace.getConfiguration = originalGetConfiguration;
    });

    function mockGetConfiguration(expectedSection: string) {
        vscode.workspace.getConfiguration = (section?: string, scope?: vscode.ConfigurationScope | null) => {
            if (section === expectedSection) {
                capturedFolderUri = scope as vscode.Uri;
                return {
                    get: (key: string, defaultValue?: any) => {
                        if (key === 'workspaceDatabaseMappings') {
                            return mockConfigData;
                        }
                        return defaultValue;
                    },
                    update: async (key: string, value: any, target: vscode.ConfigurationTarget) => {
                        if (key === 'workspaceDatabaseMappings') {
                            configUpdatedData.push({ section: key, value, target });
                            mockConfigData = value;
                        }
                    }
                } as any;
            }
            return {} as any;
        };
    }

    test('1. SetupPanelProvider - getWorkspaceMappings handler requests config at workspace scope (no folderUri)', async () => {
        mockGetConfiguration('switchboard');
        const provider = new SetupPanelProvider(vscode.Uri.file('/tmp'));
        
        let postedMessage: any = null;
        provider['_panel'] = {
            webview: {
                postMessage: async (msg: any) => {
                    postedMessage = msg;
                }
            }
        } as any;
        
        const mockWorkspaceFolderUri = vscode.Uri.file('/my/test/workspace');
        const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
        (vscode.workspace as any).workspaceFolders = [{ uri: mockWorkspaceFolderUri, name: 'workspace', index: 0 }];
        
        provider['_getCurrentWorkspaceRoot'] = () => '/my/test/workspace';

        await (provider as any)._handleMessage({ command: 'getWorkspaceMappings' });
        
        // After the scope fix, getConfiguration must be called WITHOUT a folderUri so
        // the read resolves from workspace scope (not per-folder scope).
        assert.strictEqual(capturedFolderUri, undefined, 'getConfiguration should NOT be called with a folderUri — must read from workspace scope');
        
        assert.ok(postedMessage !== null);
        assert.strictEqual(postedMessage.type, 'workspaceMappings');
        assert.strictEqual(postedMessage.enabled, false);

        (vscode.workspace as any).workspaceFolders = originalWorkspaceFolders;
    });

    test('2. SetupPanelProvider - setWorkspaceMappingEnabled handler writes to config at workspace scope (no folderUri)', async () => {
        mockGetConfiguration('switchboard');
        const provider = new SetupPanelProvider(vscode.Uri.file('/tmp'));
        
        let postedMessage: any = null;
        provider['_panel'] = {
            webview: {
                postMessage: async (msg: any) => {
                    postedMessage = msg;
                }
            }
        } as any;
        
        const mockWorkspaceFolderUri = vscode.Uri.file('/my/test/workspace');
        const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
        (vscode.workspace as any).workspaceFolders = [{ uri: mockWorkspaceFolderUri, name: 'workspace', index: 0 }];
        
        provider['_getCurrentWorkspaceRoot'] = () => '/my/test/workspace';

        const originalExecuteCommand = vscode.commands.executeCommand;
        (vscode.commands as any).executeCommand = async (cmd: string) => {
            return Promise.resolve();
        };

        try {
            await (provider as any)._handleMessage({ command: 'setWorkspaceMappingEnabled', enabled: true });
            
            // After the scope fix, getConfiguration must NOT receive a folderUri.
            assert.strictEqual(capturedFolderUri, undefined, 'getConfiguration should NOT be called with a folderUri — must use workspace scope');

            assert.strictEqual(configUpdatedData.length, 1);
            assert.strictEqual(configUpdatedData[0].section, 'workspaceDatabaseMappings');
            assert.strictEqual(configUpdatedData[0].value.enabled, true);
            assert.strictEqual(configUpdatedData[0].target, vscode.ConfigurationTarget.Workspace);
            
            assert.ok(postedMessage !== null);
            assert.strictEqual(postedMessage.type, 'workspaceMappingEnabled');
            assert.strictEqual(postedMessage.enabled, true);
        } finally {
            (vscode.workspace as any).workspaceFolders = originalWorkspaceFolders;
            vscode.commands.executeCommand = originalExecuteCommand;
        }
    });

    test('3. SetupPanelProvider - saveWorkspaceMappings handler writes to config at workspace scope (no folderUri)', async () => {
        mockGetConfiguration('switchboard');
        const provider = new SetupPanelProvider(vscode.Uri.file('/tmp'));
        
        let postedMessage: any = null;
        provider['_panel'] = {
            webview: {
                postMessage: async (msg: any) => {
                    postedMessage = msg;
                }
            }
        } as any;

        const mockWorkspaceFolderUri = vscode.Uri.file('/my/test/workspace');
        const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
        (vscode.workspace as any).workspaceFolders = [{ uri: mockWorkspaceFolderUri, name: 'workspace', index: 0 }];
        
        provider['_getCurrentWorkspaceRoot'] = () => '/my/test/workspace';

        const originalExecuteCommand = vscode.commands.executeCommand;
        (vscode.commands as any).executeCommand = async (cmd: string) => {
            return Promise.resolve();
        };

        try {
            await (provider as any)._handleMessage({
                command: 'saveWorkspaceMappings',
                payload: { enabled: true, mappings: [] }
            });
            
            // After the scope fix, getConfiguration must NOT receive a folderUri.
            assert.strictEqual(capturedFolderUri, undefined, 'getConfiguration should NOT be called with a folderUri — must use workspace scope');

            assert.strictEqual(configUpdatedData.length, 1);
            assert.strictEqual(configUpdatedData[0].section, 'workspaceDatabaseMappings');
            assert.strictEqual(configUpdatedData[0].value.enabled, true);
            assert.strictEqual(configUpdatedData[0].target, vscode.ConfigurationTarget.Workspace);
        } finally {
            (vscode.workspace as any).workspaceFolders = originalWorkspaceFolders;
            vscode.commands.executeCommand = originalExecuteCommand;
        }
    });

    test('4. clearMappingCache can be imported and executed successfully', () => {
        assert.strictEqual(typeof clearMappingCache, 'function');
        clearMappingCache();
    });
});
