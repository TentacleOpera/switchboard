import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
    clearMappingCache,
    setHostWorkspaceRoots,
    buildMappingIndexFromDbs,
    getMappingsFromIndex,
    resolveWorkspaceDbPath
} from '../services/WorkspaceIdentityService';
import { buildWorkspaceItems } from '../services/workspaceUtils';

suite('Browser Host Workspace Mappings Suite', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-browser-mappings-'));
    });

    teardown(() => {
        setHostWorkspaceRoots(null);
        clearMappingCache();
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    });

    test('1. resolveWorkspaceDbPath — all three resolution tiers', () => {
        const repoRoot = path.join(tmpDir, 'my-repo');
        fs.mkdirSync(path.join(repoRoot, '.switchboard'), { recursive: true });

        // Tier 3: Default fallback when no pointer and no config
        const defaultPath = resolveWorkspaceDbPath(repoRoot);
        assert.strictEqual(defaultPath, path.join(repoRoot, '.switchboard', 'kanban.db'));

        // Tier 2: Config reader supplied
        const customPath = path.join(tmpDir, 'custom-loc', 'kanban.db');
        const configuredResult = resolveWorkspaceDbPath(repoRoot, () => customPath);
        assert.strictEqual(configuredResult, customPath);

        // Relative config path
        const relativeConfig = resolveWorkspaceDbPath(repoRoot, () => 'custom.db');
        assert.strictEqual(relativeConfig, path.join(repoRoot, 'custom.db'));

        // Tier 1: db-pointer file present (highest precedence)
        const pointerTarget = path.join(tmpDir, 'pointer-target.db');
        fs.writeFileSync(pointerTarget, 'db-content');
        fs.writeFileSync(path.join(repoRoot, '.switchboard', 'db-pointer'), pointerTarget + '\n');

        const pointerResult = resolveWorkspaceDbPath(repoRoot, () => customPath);
        assert.strictEqual(pointerResult, pointerTarget, 'db-pointer must override configured setting');
    });

    test('2. Standalone index build and visibility rule — launch in group parent', async () => {
        const parent = path.join(tmpDir, 'parent');
        const child1 = path.join(tmpDir, 'child1');
        const child2 = path.join(tmpDir, 'child2');
        fs.mkdirSync(parent, { recursive: true });
        fs.mkdirSync(child1, { recursive: true });
        fs.mkdirSync(child2, { recursive: true });

        const mapping = {
            id: 'map-group',
            name: 'Group Workspace',
            parentFolder: parent,
            workspaceFolders: [child1, child2],
            _enabled: true
        };

        const mockDbs = new Map<string, any>([
            [parent, {
                ensureReady: async () => true,
                dbPath: path.join(parent, '.switchboard', 'kanban.db'),
                getWorkspaceMappings: async () => ({ enabled: true, mappings: [mapping] })
            }]
        ]);

        // Standalone launch in parent: host roots = [parent]
        setHostWorkspaceRoots([parent]);
        await buildMappingIndexFromDbs(mockDbs);

        const indexResult = getMappingsFromIndex();
        assert.strictEqual(indexResult.enabled, true);
        assert.strictEqual(indexResult.mappings.length, 1);

        // buildWorkspaceItems([parent]) should emit parent + both children
        const items = buildWorkspaceItems([parent]);
        const itemRoots = items.map(i => i.workspaceRoot);
        assert.strictEqual(items.length, 3);
        assert.ok(itemRoots.includes(parent));
        assert.ok(itemRoots.includes(child1));
        assert.ok(itemRoots.includes(child2));
    });

    test('3. Standalone index build and visibility rule — launch in member repo alone', async () => {
        const parent = path.join(tmpDir, 'parent');
        const child1 = path.join(tmpDir, 'child1');
        const child2 = path.join(tmpDir, 'child2');
        fs.mkdirSync(parent, { recursive: true });
        fs.mkdirSync(child1, { recursive: true });
        fs.mkdirSync(child2, { recursive: true });

        // Complete mappings replicated in child DB
        const mapping = {
            id: 'map-group',
            name: 'Group Workspace',
            parentFolder: parent,
            workspaceFolders: [child1, child2],
            _enabled: true
        };

        const mockChildDb = new Map<string, any>([
            [child1, {
                ensureReady: async () => true,
                dbPath: path.join(child1, '.switchboard', 'kanban.db'),
                getWorkspaceMappings: async () => ({ enabled: true, mappings: [mapping] })
            }]
        ]);

        // Standalone launch in child1: host roots = [child1]
        setHostWorkspaceRoots([child1]);
        await buildMappingIndexFromDbs(mockChildDb);

        // Visibility rule in buildWorkspaceItems: parent is not open, so parent and siblings are not emitted
        const items = buildWorkspaceItems([child1]);
        assert.strictEqual(items.length, 1, 'Child launched alone must emit exactly one workspace');
        assert.strictEqual(items[0].workspaceRoot, child1);
    });

    test('4. Composition root check — both extension and bootstrap call buildMappingIndexFromDbs and setHostWorkspaceRoots', () => {
        const extensionSrc = fs.readFileSync(path.resolve(__dirname, '..', 'extension.ts'), 'utf8');
        const bootstrapSrc = fs.readFileSync(path.resolve(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8');

        assert.ok(extensionSrc.includes('buildMappingIndexFromDbs'), 'extension.ts must call buildMappingIndexFromDbs');
        assert.ok(extensionSrc.includes('setHostWorkspaceRoots'), 'extension.ts must call setHostWorkspaceRoots');

        assert.ok(bootstrapSrc.includes('buildMappingIndexFromDbs'), 'bootstrap.ts must call buildMappingIndexFromDbs');
        assert.ok(bootstrapSrc.includes('setHostWorkspaceRoots'), 'bootstrap.ts must call setHostWorkspaceRoots');
        assert.ok(bootstrapSrc.includes('resolveWorkspaceDbPath'), 'bootstrap.ts must use resolveWorkspaceDbPath');
    });

    test('5. DB-creation chain guarded by isAllowedSwitchboardLocation — no kanban.db created in mapped child', async () => {
        const parent = path.join(tmpDir, 'parent');
        const child = path.join(tmpDir, 'child');
        fs.mkdirSync(parent, { recursive: true });
        fs.mkdirSync(child, { recursive: true });

        const mapping = {
            id: 'map-group',
            name: 'Group Workspace',
            parentFolder: parent,
            workspaceFolders: [child],
            _enabled: true
        };

        const mockParentDb = new Map<string, any>([
            [parent, {
                ensureReady: async () => true,
                dbPath: path.join(parent, '.switchboard', 'kanban.db'),
                getWorkspaceMappings: async () => ({ enabled: true, mappings: [mapping] })
            }]
        ]);

        setHostWorkspaceRoots([parent, child]);
        await buildMappingIndexFromDbs(mockParentDb);

        const { isAllowedSwitchboardLocation } = require('../utils/switchboardLocationGuard');
        assert.strictEqual(
            isAllowedSwitchboardLocation(child, child),
            false,
            'isAllowedSwitchboardLocation must return false for mapped child workspace'
        );
        assert.strictEqual(
            isAllowedSwitchboardLocation(parent, parent),
            true,
            'isAllowedSwitchboardLocation must return true for parent workspace'
        );

        // Verify bootstrap.ts guards DB file creation
        const bootstrapSrc = fs.readFileSync(path.resolve(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8');
        assert.ok(
            bootstrapSrc.includes('isAllowedSwitchboardLocation(dbWorkspace, effectiveDbRoot)'),
            'bootstrap.ts must guard DB file creation with isAllowedSwitchboardLocation'
        );
        assert.ok(
            bootstrapSrc.includes('childMapping'),
            'bootstrap.ts must redirect effectiveDbRoot to parent for mapped children'
        );
    });
});
