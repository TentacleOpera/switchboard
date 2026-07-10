import * as assert from 'assert';
import * as Module from 'module';
import * as path from 'path';
import * as os from 'os';

// VS Code mock installer for pure NodeJS environment
function installVsCodeMock(mappingsConfig: any) {
    const originalLoad = (Module as any)._load;
    const mock = {
        workspace: {
            getConfiguration: (section: string) => {
                if (section === 'switchboard') {
                    return {
                        get: (key: string) => {
                            if (key === 'workspaceDatabaseMappings') {
                                return mappingsConfig;
                            }
                            return undefined;
                        }
                    };
                }
                return {};
            }
        }
    };

    // Mock WorkspaceIdentityService.getMappingsFromIndex — the guard reads from
    // getMappingsFromIndex() (not vscode.workspace.getConfiguration) since commit a94e7f6.
    // Without this, the guard sees { enabled: false, mappings: [] } and falls through
    // to the default candidate === workspaceRoot check, making mapping-based tests pass
    // or fail for the wrong reasons.
    const mockWorkspaceIdentityService = {
        getMappingsFromIndex: () => mappingsConfig || { enabled: false, mappings: [] },
        resolveEffectiveWorkspaceRootFromMappings: (root: string) => root,
        clearMappingCache: () => {},
    };

    // Clear cached WorkspaceIdentityService so the mock is used on next require
    for (const key of Object.keys(require.cache)) {
        if (key.includes('WorkspaceIdentityService')) {
            delete require.cache[key];
        }
    }

    (Module as any)._load = function patchedLoad(request: string, parent: any, isMain: boolean) {
        if (request === 'vscode') {
            return mock;
        }
        if (request.endsWith('WorkspaceIdentityService') || request.includes('WorkspaceIdentityService')) {
            return mockWorkspaceIdentityService;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    return {
        restore() {
            (Module as any)._load = originalLoad;
        }
    };
}

suite('Child Switchboard Creation Regression', () => {
    test('1. No mapping configured — allowed workspaceRoot match', () => {
        const mock = installVsCodeMock(undefined);
        try {
            // Dynamically import the utility under test so the vscode mock is applied
            const guardPath = path.resolve(__dirname, '..', 'utils', 'switchboardLocationGuard');
            delete require.cache[require.resolve(guardPath)];
            const { isAllowedSwitchboardLocation } = require(guardPath);

            const workspaceRoot = '/Users/user/project';
            assert.strictEqual(isAllowedSwitchboardLocation(workspaceRoot, workspaceRoot), true, 'Should allow if candidate matches workspaceRoot');
            assert.strictEqual(isAllowedSwitchboardLocation('/Users/user/other', workspaceRoot), false, 'Should block if candidate does not match workspaceRoot');
        } finally {
            mock.restore();
        }
    });

    test('2. Mapping enabled, candidate is a mapped child — BLOCKED', () => {
        const mappingsConfig = {
            enabled: true,
            mappings: [
                {
                    workspaceFolders: ['~/project/child1', '~/project/child2'],
                    parentFolder: '~/project'
                }
            ]
        };
        const mock = installVsCodeMock(mappingsConfig);
        try {
            const guardPath = path.resolve(__dirname, '..', 'utils', 'switchboardLocationGuard');
            delete require.cache[require.resolve(guardPath)];
            const { isAllowedSwitchboardLocation } = require(guardPath);

            const home = os.homedir();
            const child1Resolved = path.join(home, 'project', 'child1');
            const parentResolved = path.join(home, 'project');

            assert.strictEqual(isAllowedSwitchboardLocation(child1Resolved, child1Resolved), false, 'Should block if candidate is a mapped child workspaceFolder even if it matches workspaceRoot');
            assert.strictEqual(isAllowedSwitchboardLocation(parentResolved, child1Resolved), true, 'Should allow candidate if it is the configured parentFolder');
        } finally {
            mock.restore();
        }
    });

    test('3. Mapping enabled, candidate is neither child nor parent — conservative default', () => {
        const mappingsConfig = {
            enabled: true,
            mappings: [
                {
                    workspaceFolders: ['~/project/child1'],
                    parentFolder: '~/project'
                }
            ]
        };
        const mock = installVsCodeMock(mappingsConfig);
        try {
            const guardPath = path.resolve(__dirname, '..', 'utils', 'switchboardLocationGuard');
            delete require.cache[require.resolve(guardPath)];
            const { isAllowedSwitchboardLocation } = require(guardPath);

            const workspaceRoot = '/Users/user/project/child2';
            assert.strictEqual(isAllowedSwitchboardLocation('/Users/user/random', workspaceRoot), false, 'Should block random paths');
            assert.strictEqual(isAllowedSwitchboardLocation(workspaceRoot, workspaceRoot), true, 'Should allow workspace root if it is not mapped');
        } finally {
            mock.restore();
        }
    });

    test('4. Home directory expansion', () => {
        const mappingsConfig = {
            enabled: true,
            mappings: [
                {
                    workspaceFolders: ['~/repos/child'],
                    parentFolder: '~/repos/parent'
                }
            ]
        };
        const mock = installVsCodeMock(mappingsConfig);
        try {
            const guardPath = path.resolve(__dirname, '..', 'utils', 'switchboardLocationGuard');
            delete require.cache[require.resolve(guardPath)];
            const { isAllowedSwitchboardLocation } = require(guardPath);

            const home = os.homedir();
            const childAbs = path.join(home, 'repos', 'child');
            const parentAbs = path.join(home, 'repos', 'parent');

            assert.strictEqual(isAllowedSwitchboardLocation(childAbs, childAbs), false, 'Should correctly resolve and block home-expanded child folder');
            assert.strictEqual(isAllowedSwitchboardLocation(parentAbs, childAbs), true, 'Should correctly resolve and allow home-expanded parent folder');
        } finally {
            mock.restore();
        }
    });

    test('5. _setupPlanWatcher scenario — child IS workspaceRoot, guard blocks', () => {
        // Reproduces the exact bug: _kanbanProvider is null at construction time,
        // so effectiveRoot falls back to the raw workspaceRoot. If the workspaceRoot
        // is a child folder, the guard must still block it.
        const mappingsConfig = {
            enabled: true,
            mappings: [
                {
                    workspaceFolders: ['~/Documents/GitHub/autism360-analytics'],
                    parentFolder: '~/Documents/Gitlab'
                }
            ]
        };
        const mock = installVsCodeMock(mappingsConfig);
        try {
            const guardPath = path.resolve(__dirname, '..', 'utils', 'switchboardLocationGuard');
            delete require.cache[require.resolve(guardPath)];
            const { isAllowedSwitchboardLocation } = require(guardPath);

            const home = os.homedir();
            const childResolved = path.join(home, 'Documents', 'GitHub', 'autism360-analytics');
            const parentResolved = path.join(home, 'Documents', 'Gitlab');

            // The child IS the workspaceRoot (as happens when _kanbanProvider is null)
            assert.strictEqual(
                isAllowedSwitchboardLocation(childResolved, childResolved),
                false,
                'Should block child folder even when it is the workspaceRoot — this is the _setupPlanWatcher bug scenario'
            );
            // The parent must still be allowed
            assert.strictEqual(
                isAllowedSwitchboardLocation(parentResolved, childResolved),
                true,
                'Should allow the configured parentFolder'
            );
        } finally {
            mock.restore();
        }
    });
});
