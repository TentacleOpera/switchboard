import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import {
    clearMappingCache,
    setHostWorkspaceRoots,
    isHostRoot,
    resolveEffectiveWorkspaceRootFromMappings,
    buildMappingIndexFromDbs,
    getMappingsFromIndex,
    expandAndResolve
} from '../services/WorkspaceIdentityService';

suite('WorkspaceIdentityService Precedence & Openness Suite', () => {
    teardown(() => {
        setHostWorkspaceRoots(null);
        clearMappingCache();
    });

    test('1. resolveEffectiveWorkspaceRootFromMappings — parent precedence over child in both array orders', async () => {
        const repoA = path.resolve('/test/workspaces/repoA');
        const repoB = path.resolve('/test/workspaces/repoB');
        const mega = path.resolve('/test/workspaces/mega');

        // Mapping 1: repoA is parent of repoB
        const mappingAIsParent = {
            id: 'map-a',
            parentFolder: repoA,
            workspaceFolders: [repoB],
            _enabled: true
        };

        // Mapping 2: mega is parent of repoA and repoB (repoA is a child here)
        const mappingAIsChild = {
            id: 'map-mega',
            parentFolder: mega,
            workspaceFolders: [repoA, repoB],
            _enabled: true
        };

        // Order 1: [mappingAIsChild, mappingAIsParent] -> repoA listed as child first, parent second
        const mockDbsOrder1 = new Map<string, any>([
            [mega, {
                ensureReady: async () => true,
                dbPath: path.join(mega, '.switchboard', 'kanban.db'),
                getWorkspaceMappings: async () => ({ enabled: true, mappings: [mappingAIsChild, mappingAIsParent] })
            }]
        ]);

        setHostWorkspaceRoots(null); // Gate off
        await buildMappingIndexFromDbs(mockDbsOrder1);

        // repoA owns its own mapping (parent), so it MUST resolve to itself, not to mega
        assert.strictEqual(
            resolveEffectiveWorkspaceRootFromMappings(repoA),
            repoA,
            'Order 1: repoA (parent of map-a, child of map-mega) must resolve to itself'
        );

        // Order 2: [mappingAIsParent, mappingAIsChild] -> repoA listed as parent first, child second
        clearMappingCache();
        const mockDbsOrder2 = new Map<string, any>([
            [mega, {
                ensureReady: async () => true,
                dbPath: path.join(mega, '.switchboard', 'kanban.db'),
                getWorkspaceMappings: async () => ({ enabled: true, mappings: [mappingAIsParent, mappingAIsChild] })
            }]
        ]);

        await buildMappingIndexFromDbs(mockDbsOrder2);

        assert.strictEqual(
            resolveEffectiveWorkspaceRootFromMappings(repoA),
            repoA,
            'Order 2: repoA (parent of map-a, child of map-mega) must resolve to itself'
        );
    });

    test('2. All three _hostRoots states: null (gate off), [] (gate on, empty), populated (gate on, filtered)', async () => {
        const parent = path.resolve('/test/workspaces/parent');
        const child = path.resolve('/test/workspaces/child');

        const mapping = {
            id: 'map-1',
            parentFolder: parent,
            workspaceFolders: [child],
            _enabled: true
        };

        const mockDbs = new Map<string, any>([
            [parent, {
                ensureReady: async () => true,
                dbPath: path.join(parent, '.switchboard', 'kanban.db'),
                getWorkspaceMappings: async () => ({ enabled: true, mappings: [mapping] })
            }]
        ]);

        // State A: null (gate off, backwards-compatible)
        setHostWorkspaceRoots(null);
        assert.strictEqual(isHostRoot(parent), true);
        assert.strictEqual(isHostRoot(child), true);
        await buildMappingIndexFromDbs(mockDbs);
        assert.strictEqual(
            resolveEffectiveWorkspaceRootFromMappings(child),
            parent,
            'State null: gate is disabled, child redirects to parent'
        );

        // State B: [] (gate on, empty — no workspace folders open)
        setHostWorkspaceRoots([]);
        assert.strictEqual(isHostRoot(parent), false);
        assert.strictEqual(isHostRoot(child), false);
        await buildMappingIndexFromDbs(mockDbs);
        assert.strictEqual(
            resolveEffectiveWorkspaceRootFromMappings(child),
            child,
            'State []: gate is enabled but no host roots open, child resolves to itself'
        );

        // State C1: Populated with child only (parent not open)
        setHostWorkspaceRoots([child]);
        assert.strictEqual(isHostRoot(parent), false);
        assert.strictEqual(isHostRoot(child), true);
        await buildMappingIndexFromDbs(mockDbs);
        assert.strictEqual(
            resolveEffectiveWorkspaceRootFromMappings(child),
            child,
            'State [child]: parent is NOT in host roots, child resolves to itself'
        );

        // State C2: Populated with parent (parent is open)
        setHostWorkspaceRoots([parent, child]);
        assert.strictEqual(isHostRoot(parent), true);
        assert.strictEqual(isHostRoot(child), true);
        await buildMappingIndexFromDbs(mockDbs);
        assert.strictEqual(
            resolveEffectiveWorkspaceRootFromMappings(child),
            parent,
            'State [parent, child]: parent IS open, child redirects to parent'
        );
    });

    test('3. buildMappingIndexFromDbs two-pass precedence — index maps both-roles folder to itself', async () => {
        const repoA = path.resolve('/test/workspaces/repoA');
        const repoB = path.resolve('/test/workspaces/repoB');
        const mega = path.resolve('/test/workspaces/mega');

        const mappingMega = {
            id: 'map-mega',
            parentFolder: mega,
            workspaceFolders: [repoA, repoB],
            _enabled: true
        };

        const mappingA = {
            id: 'map-a',
            parentFolder: repoA,
            workspaceFolders: [repoB],
            _enabled: true
        };

        // Regardless of which order they are fed in
        const mockDbs = new Map<string, any>([
            [mega, {
                ensureReady: async () => true,
                dbPath: path.join(mega, '.switchboard', 'kanban.db'),
                getWorkspaceMappings: async () => ({ enabled: true, mappings: [mappingMega, mappingA] })
            }]
        ]);

        setHostWorkspaceRoots([mega, repoA, repoB]);
        await buildMappingIndexFromDbs(mockDbs);

        // repoA should map to repoA in cache/index
        assert.strictEqual(
            resolveEffectiveWorkspaceRootFromMappings(repoA),
            repoA,
            'Two-pass index build guarantees parent (repoA) maps to self even when child of mega'
        );
        // repoB (pure child) maps to parent
        assert.strictEqual(
            resolveEffectiveWorkspaceRootFromMappings(repoB),
            repoA,
            'repoB maps to repoA (or parent)'
        );
    });

    test('4. setHostWorkspaceRoots clears mapping cache', async () => {
        const parent = path.resolve('/test/workspaces/parent');
        const child = path.resolve('/test/workspaces/child');

        const mapping = {
            id: 'map-1',
            parentFolder: parent,
            workspaceFolders: [child],
            _enabled: true
        };

        const mockDbs = new Map<string, any>([
            [parent, {
                ensureReady: async () => true,
                dbPath: path.join(parent, '.switchboard', 'kanban.db'),
                getWorkspaceMappings: async () => ({ enabled: true, mappings: [mapping] })
            }]
        ]);

        setHostWorkspaceRoots([child]); // parent not open
        await buildMappingIndexFromDbs(mockDbs);
        assert.strictEqual(resolveEffectiveWorkspaceRootFromMappings(child), child);

        // Dynamically add parent to open roots
        setHostWorkspaceRoots([parent, child]);
        await buildMappingIndexFromDbs(mockDbs);
        assert.strictEqual(
            resolveEffectiveWorkspaceRootFromMappings(child),
            parent,
            'Cache cleared and rebuilt: child now redirects to open parent'
        );
    });

    test('5. getScopedMappingsForBoard accepts string or string[] and prunes non-qualifying mappings', async () => {
        const parentA = path.resolve('/test/workspaces/parentA');
        const childA = path.resolve('/test/workspaces/childA');
        const parentB = path.resolve('/test/workspaces/parentB');
        const childB = path.resolve('/test/workspaces/childB');

        const { getScopedMappingsForBoard } = require('../services/WorkspaceIdentityService');

        const mockDbs = new Map<string, any>([
            [parentA, {
                ensureReady: async () => true,
                dbPath: path.join(parentA, '.switchboard', 'kanban.db'),
                getWorkspaceMappings: async () => ({
                    enabled: true,
                    mappings: [
                        { id: 'map-a', parentFolder: parentA, workspaceFolders: [childA], _enabled: true },
                        { id: 'map-b', parentFolder: parentB, workspaceFolders: [childB], _enabled: true }
                    ]
                })
            }]
        ]);

        await buildMappingIndexFromDbs(mockDbs);

        // Single string root: parentA
        const scopedA = getScopedMappingsForBoard(parentA);
        assert.strictEqual(scopedA.enabled, true);
        assert.strictEqual(scopedA.mappings.length, 1);
        assert.strictEqual(scopedA.mappings[0].id, 'map-a');

        // Multi-root string[]: [parentA, childB]
        const scopedMulti = getScopedMappingsForBoard([parentA, childB]);
        assert.strictEqual(scopedMulti.enabled, true);
        assert.strictEqual(scopedMulti.mappings.length, 2);

        // Unrelated root
        const scopedOther = getScopedMappingsForBoard('/unrelated/path');
        assert.strictEqual(scopedOther.enabled, false);
        assert.strictEqual(scopedOther.mappings.length, 0);
    });

    test('6. buildWorkspaceItems visibility rule — never emits non-open parents', async () => {
        const parent = path.resolve('/test/workspaces/parent');
        const childA = path.resolve('/test/workspaces/childA');
        const childB = path.resolve('/test/workspaces/childB');

        const { buildWorkspaceItems } = require('../services/workspaceUtils');

        const mockDbs = new Map<string, any>([
            [parent, {
                ensureReady: async () => true,
                dbPath: path.join(parent, '.switchboard', 'kanban.db'),
                getWorkspaceMappings: async () => ({
                    enabled: true,
                    mappings: [{
                        id: 'map-1',
                        name: 'My Group',
                        parentFolder: parent,
                        workspaceFolders: [childA, childB],
                        _enabled: true
                    }]
                })
            }]
        ]);

        await buildMappingIndexFromDbs(mockDbs);

        // Case 1: Member opened alone — parent is NOT open
        const itemsMemberAlone = buildWorkspaceItems([childA]);
        assert.deepStrictEqual(
            itemsMemberAlone,
            [{ label: path.basename(childA), workspaceRoot: childA }],
            'Member alone must only show itself; non-open parent must never be emitted'
        );

        // Case 2: Parent opened alone — parent is open, emits parent + children
        const itemsParentAlone = buildWorkspaceItems([parent]);
        assert.deepStrictEqual(
            itemsParentAlone,
            [
                { label: 'My Group', workspaceRoot: parent },
                { label: path.basename(childA), workspaceRoot: childA },
                { label: path.basename(childB), workspaceRoot: childB }
            ],
            'Parent open alone emits parent + its member children'
        );

        // Case 3: Mega multi-root (parent + childA open)
        const itemsMultiRoot = buildWorkspaceItems([parent, childA]);
        assert.deepStrictEqual(
            itemsMultiRoot,
            [
                { label: 'My Group', workspaceRoot: parent },
                { label: path.basename(childA), workspaceRoot: childA },
                { label: path.basename(childB), workspaceRoot: childB }
            ],
            'Multi-root emits parent + member children without duplicates'
        );
    });
});
