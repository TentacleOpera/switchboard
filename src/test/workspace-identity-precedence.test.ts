import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
    clearMappingCache,
    setHostWorkspaceRoots,
    isHostRoot,
    resolveEffectiveWorkspaceRootFromMappings,
    resolveWorkspaceDbPath,
    buildMappingIndexFromDbs,
    getMappingsFromIndex,
    getScopedMappingsForBoard,
    pruneNonExistentMappings,
    expandAndResolve
} from '../services/WorkspaceIdentityService';
import { getGlobalDbPath, resolveGlobalDbPath, validateGlobalDbPath, resolveBoardDbPath } from '../services/globalStore';

/**
 * Consolidation invariants for the storage overhaul.
 *
 * This file used to test the workspace-mapping *database-resolution* subsystem —
 * `buildMappingIndexFromDbs` precedence, the `_hostRoots` openness gate, the
 * `db-pointer` resolution tier. Consolidation to one global database retired all
 * of it, and the retired functions are now no-op stubs.
 *
 * Testing a stub against the old behaviour is worse than not testing it: the old
 * assertions either fail (a red gate for work that shipped deliberately) or pass
 * for the wrong reason, because a stub's identity return is indistinguishable
 * from a real resolution. So the assertions here pin the *retirement* instead:
 * every folder resolves to the one global store, the retired readers report
 * "disabled" rather than something a caller could mistake for a real mapping, and
 * the deleted subsystems are absent from `src/`.
 *
 * The two halves that survived consolidation — terminal parenting
 * (`pruneNonExistentMappings`) and `~` expansion — keep real behavioural tests.
 */
suite('Storage consolidation invariants', () => {
    const SRC_DIR = path.join(__dirname, '..', '..', 'src');

    let tmpDir: string;

    setup(() => {
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-consolidation-')));
    });

    teardown(() => {
        setHostWorkspaceRoots(null);
        clearMappingCache();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    /** Recursively collect every .ts/.js source file under src/. */
    const walkSrc = (dir: string, out: string[] = []): string[] => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkSrc(full, out);
            } else if (/\.(ts|js)$/.test(entry.name)) {
                out.push(full);
            }
        }
        return out;
    };

    // src/test/ is excluded: these assertions are about live code. A test file that
    // NAMES a retired identifier in order to assert its absence is not a reference,
    // and including it would make every one of these checks fail on itself.
    const TEST_TREE = path.join(SRC_DIR, 'test') + path.sep;

    const srcFilesContaining = (needle: string, exclude: RegExp[] = []): string[] => {
        const hits: string[] = [];
        for (const file of walkSrc(SRC_DIR)) {
            if (file.startsWith(TEST_TREE)) continue;
            if (exclude.some(re => re.test(file))) continue;
            let text: string;
            try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
            if (text.includes(needle)) {
                hits.push(path.relative(SRC_DIR, file));
            }
        }
        return hits;
    };

    test('1. each workspace folder resolves to its own per-project board database', () => {
        const repoA = path.join(tmpDir, 'repoA');
        const repoB = path.join(tmpDir, 'nested', 'repoB');
        fs.mkdirSync(repoB, { recursive: true });
        fs.mkdirSync(repoA, { recursive: true });

        const pathA = resolveWorkspaceDbPath(repoA);
        const pathB = resolveWorkspaceDbPath(repoB);

        // Each workspace resolves to its own board file, not a shared global file
        assert.notStrictEqual(pathA, pathB, 'two different roots must resolve to two different board paths');

        // Neither path is inside the workspace repository
        assert.ok(
            !pathA.startsWith(path.resolve(repoA) + path.sep),
            'repoA board must not live inside the workspace repository'
        );
        assert.ok(
            !pathB.startsWith(path.resolve(repoB) + path.sep),
            'repoB board must not live inside the workspace repository'
        );

        // Both paths are under ~/.switchboard/boards/
        assert.ok(pathA.includes(path.join('.switchboard', 'boards')), `pathA must be under boards/: ${pathA}`);
        assert.ok(pathB.includes(path.join('.switchboard', 'boards')), `pathB must be under boards/: ${pathB}`);
    });

    test('2. the global path is tagged with its source, so "which store answered?" is answerable', () => {
        const def = resolveGlobalDbPath();
        assert.strictEqual(def.source, 'global_default', 'the no-argument resolution must report global_default');
        assert.ok(path.isAbsolute(def.path), 'the resolved path must be absolute');

        const explicit = resolveGlobalDbPath(path.join(tmpDir, 'explicit.db'));
        assert.strictEqual(explicit.source, 'explicit', 'an explicit path must report source=explicit, not be silently indistinguishable from the default');
        assert.notStrictEqual(explicit.path, def.path);
    });

    test('3. a dotfiles git repo at $HOME does not veto the default global path', () => {
        // resolveGlobalDbPath() THROWS on a failed default, so a false positive here
        // means the board never opens. A git repo at or above $HOME is common and
        // must not disqualify ~/.switchboard.
        const home = path.resolve(os.homedir());
        const check = validateGlobalDbPath(path.join(home, '.switchboard', 'switchboard.db'));
        assert.strictEqual(check.ok, true, `default global path must validate even with a repo at $HOME (got: ${check.reason})`);
    });

    test('4. a path inside a project checkout is still refused', () => {
        const repo = path.join(tmpDir, 'projectRepo');
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        fs.mkdirSync(path.join(repo, '.switchboard'), { recursive: true });
        const check = validateGlobalDbPath(path.join(repo, '.switchboard', 'kanban.db'));
        assert.strictEqual(check.ok, false, 'a database inside a git work tree must be refused');
        assert.ok(/git work tree/.test(check.reason || ''), 'the refusal must name the reason');
    });

    test('5. a cloud-sync destination is refused', () => {
        for (const folder of ['Dropbox', 'Google Drive', 'OneDrive', 'iCloud']) {
            const userPath = path.join(tmpDir, folder, 'switchboard.db');
            const check = validateGlobalDbPath(userPath, { userSuppliedPath: userPath });
            assert.strictEqual(check.ok, false, `${folder} must be refused as a database destination`);
        }
    });

    test('6. retired mapping readers report disabled — never something mistakable for a real mapping', async () => {
        const parent = path.join(tmpDir, 'parent');
        const child = path.join(tmpDir, 'child');
        fs.mkdirSync(parent, { recursive: true });
        fs.mkdirSync(child, { recursive: true });

        // Feed the retired builder a mapping that WOULD have produced an index entry.
        await buildMappingIndexFromDbs(new Map<string, any>([
            [parent, {
                ensureReady: async () => true,
                dbPath: getGlobalDbPath(),
                getWorkspaceMappings: async () => ({
                    enabled: true,
                    mappings: [{ id: 'map-1', parentFolder: parent, workspaceFolders: [child], _enabled: true }]
                })
            }]
        ]));

        const index = getMappingsFromIndex();
        assert.strictEqual(index.enabled, false, 'the retired mapping index must report enabled=false');
        assert.deepStrictEqual(index.mappings, [], 'the retired mapping index must be empty');

        const scoped = getScopedMappingsForBoard(parent);
        assert.strictEqual(scoped.enabled, false, 'the retired scoped reader must report enabled=false');
        assert.deepStrictEqual(scoped.mappings, []);

        // Identity resolution is now the whole contract: a folder is its own root.
        assert.strictEqual(resolveEffectiveWorkspaceRootFromMappings(child), child);
        assert.strictEqual(isHostRoot(child), true, 'the openness gate is retired and must not filter');
    });

    test('7. terminal parenting survives: pruneNonExistentMappings still prunes by disk presence', () => {
        const present = path.join(tmpDir, 'present');
        fs.mkdirSync(present, { recursive: true });
        const absent = path.join(tmpDir, 'absent-not-created');

        const kept = pruneNonExistentMappings([
            { id: 'a', parentFolder: present, workspaceFolders: [] } as any,
            { id: 'b', parentFolder: absent, workspaceFolders: [] } as any,
            { id: 'c', workspaceFolders: [] } as any,
        ]);

        const ids = kept.map(m => m.id).sort();
        assert.deepStrictEqual(ids, ['a', 'c'], 'only mappings whose parentFolder exists (or is unset) survive');
    });

    test('8. ~ expansion still resolves against the real home directory', () => {
        assert.strictEqual(expandAndResolve('~/foo'), path.join(os.homedir(), 'foo'));
        assert.strictEqual(expandAndResolve(path.join(tmpDir, 'bar')), path.join(tmpDir, 'bar'));
    });

    test('9. switchboardLocationGuard is absent from src/', () => {
        const hits = srcFilesContaining('isAllowedSwitchboardLocation');
        assert.deepStrictEqual(
            hits, [],
            `isAllowedSwitchboardLocation must be gone — the location guard existed only to answer `
            + `"which database does this folder use?", which one global store answers by construction. Found in: ${hits.join(', ')}`
        );
        assert.strictEqual(
            fs.existsSync(path.join(SRC_DIR, 'utils', 'switchboardLocationGuard.ts')),
            false,
            'src/utils/switchboardLocationGuard.ts must be deleted'
        );
    });

    test('10. the db-pointer indirection is absent from src/ code', () => {
        // Prose in comments is not a live reference; the write/read/resolve paths are.
        const hits = srcFilesContaining("'db-pointer'").concat(srcFilesContaining('"db-pointer"'));
        assert.deepStrictEqual(
            hits, [],
            `the db-pointer indirection must be gone — a child repo no longer borrows a parent's database. Found in: ${hits.join(', ')}`
        );
    });

    test('11. the cloud-sync DB path presets are absent from src/', () => {
        for (const needle of ['setPresetDbPath', 'db-preset-google-btn', 'db-preset-dropbox-btn', 'db-preset-icloud-btn']) {
            const hits = srcFilesContaining(needle);
            assert.deepStrictEqual(
                hits, [],
                `${needle} must be gone — a file-sync folder cannot hold the database. Found in: ${hits.join(', ')}`
            );
        }
    });

    test('12. the sql.js memory/eviction apparatus is absent from src/', () => {
        for (const needle of ['_residentDbBudgetBytes', 'startEvictionSweep', '_summedResidentDbBytes', '_evictArchiveKey']) {
            const hits = srcFilesContaining(needle);
            assert.deepStrictEqual(
                hits, [],
                `${needle} must be gone — the 500MB resident budget and LRU eviction existed only to survive `
                + `whole-database-in-memory. Found in: ${hits.join(', ')}`
            );
        }
    });

    test('13. no whole-file export() persist path remains in KanbanDatabase', () => {
        const dbSrc = fs.readFileSync(path.join(SRC_DIR, 'services', 'KanbanDatabase.ts'), 'utf8');
        assert.ok(
            !/this\._db\.export\(\)/.test(dbSrc),
            'KanbanDatabase must not call _db.export() — export-the-world on every write is the engine defect this replaced'
        );
        assert.ok(
            !/PERSIST_DEBOUNCE_MS/.test(dbSrc),
            'the persist debounce must be gone — writes are now page-level statements, not coalesced full-image rewrites'
        );
    });
});
