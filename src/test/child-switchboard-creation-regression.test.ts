import * as assert from 'assert';
import * as fs from 'fs';
import * as Module from 'module';
import * as path from 'path';
import * as os from 'os';

// VS Code mock installer for pure NodeJS environment.
// `workspaceFolders` feeds the guard's structural fallback (folders whose own
// control plane makes markerless siblings/children fail closed).
function installVsCodeMock(mappingsConfig: any, workspaceFolders?: string[]) {
    const originalLoad = (Module as any)._load;
    const mock = {
        workspace: {
            workspaceFolders: workspaceFolders
                ? workspaceFolders.map(fsPath => ({ uri: { fsPath } }))
                : undefined,
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

    // Mock WorkspaceIdentityService.getMappingsFromIndex — the guard's Tier-1 reads
    // from getMappingsFromIndex() (the async in-memory index), not from
    // vscode.workspace.getConfiguration. When that index is empty/disabled the guard
    // must fall through to the Tier-2 structural (on-disk control-plane) checks —
    // NOT blanket-allow. Tests below exercise both the populated and empty-index paths.
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

    test('6. Mapping index EMPTY during activation race — structural block via on-disk control plane', () => {
        // THE recurring-bug scenario. The mapping IS enabled in the DB, but the async
        // in-memory index has not finished building when the plan watcher fires, so
        // getMappingsFromIndex() returns { enabled: false }. Tier-1 is skipped. The guard
        // must NOT fall through to `candidate === workspaceRoot` (which is tautologically
        // true, since callers pass the folder as both args). Instead the structural check
        // must recognise that a parent folder owns a control plane (kanban.db) on disk and
        // block the markerless child — even though the index is empty.
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-guard-'));
        const parent = path.join(tmpRoot, 'parent');
        const child = path.join(tmpRoot, 'parent', 'child');       // nested child
        const externalChild = path.join(tmpRoot, 'external-child'); // sibling child (e.g. a repo in another dir)
        try {
            // Parent owns a control plane; neither child does (they share the parent DB).
            fs.mkdirSync(path.join(parent, '.switchboard'), { recursive: true });
            fs.writeFileSync(path.join(parent, '.switchboard', 'kanban.db'), 'x');
            fs.mkdirSync(child, { recursive: true });
            fs.mkdirSync(externalChild, { recursive: true });

            // Empty/disabled index (the race) + all three folders open in the workspace.
            const mock = installVsCodeMock(
                { enabled: false, mappings: [] },
                [parent, child, externalChild]
            );
            try {
                const guardPath = path.resolve(__dirname, '..', 'utils', 'switchboardLocationGuard');
                delete require.cache[require.resolve(guardPath)];
                const { isAllowedSwitchboardLocation } = require(guardPath);

                assert.strictEqual(
                    isAllowedSwitchboardLocation(child, child),
                    false,
                    'Empty index: nested markerless child must be BLOCKED because a parent owns a control plane'
                );
                assert.strictEqual(
                    isAllowedSwitchboardLocation(externalChild, externalChild),
                    false,
                    'Empty index: external markerless child must be BLOCKED (this is the autism360-analytics case)'
                );
                assert.strictEqual(
                    isAllowedSwitchboardLocation(parent, parent),
                    true,
                    'Empty index: the folder that owns the control plane (kanban.db) must be ALLOWED'
                );
            } finally {
                mock.restore();
            }
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    test('7. First-run standalone — no mapping, no control plane anywhere — still allowed', () => {
        // Regression guard for the fix itself: a brand-new single-root install (no DB yet,
        // no other folders) must still be allowed to scaffold, or fresh installs break.
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-guard-'));
        const solo = path.join(tmpRoot, 'solo');
        try {
            fs.mkdirSync(solo, { recursive: true });
            const mock = installVsCodeMock({ enabled: false, mappings: [] }, [solo]);
            try {
                const guardPath = path.resolve(__dirname, '..', 'utils', 'switchboardLocationGuard');
                delete require.cache[require.resolve(guardPath)];
                const { isAllowedSwitchboardLocation } = require(guardPath);

                assert.strictEqual(
                    isAllowedSwitchboardLocation(solo, solo),
                    true,
                    'A lone workspace root with no parent control plane present must be allowed (first-run)'
                );
            } finally {
                mock.restore();
            }
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});
