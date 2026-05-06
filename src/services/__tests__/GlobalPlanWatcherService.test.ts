
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GlobalPlanWatcherService } from '../GlobalPlanWatcherService';

describe('GlobalPlanWatcherService', () => {
    let sandbox: sinon.SinonSandbox;
    let service: GlobalPlanWatcherService;
    let outputChannelStub: any;
    let getClickUpServiceStub: sinon.SinonStub;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        outputChannelStub = {
            appendLine: sandbox.stub()
        };
        getClickUpServiceStub = sandbox.stub();
        service = new GlobalPlanWatcherService(getClickUpServiceStub, outputChannelStub);
    });

    afterEach(() => {
        sandbox.restore();
        service.dispose();
    });

    describe('_getAllMappedFolders', () => {
        it('returns workspace folders if no mappings enabled', async () => {
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

        it('returns mapped folders if mappings enabled', async () => {
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

        it('expands home directory in mapping paths', async () => {
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
});
