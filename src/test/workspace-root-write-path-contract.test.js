'use strict';

/**
 * Workspace-root resolution on the API write paths.
 *
 * On 2026-08-14 a single `POST /kanban/plans/import` with a workspace root that
 * differed from the canonical one only in CASE inserted 1537 duplicate plan rows
 * into a live board — and answered `{"success":true,"count":0}`. Three defects
 * composed: the handler accepted any string as a root, the row key was the
 * caller's literal spelling of the path, and the write loop threw away its true
 * count the moment a single disk-persist returned false.
 *
 * This suite pins the two boundary guards that contain that failure:
 *
 *   1. `LocalApiServer._resolveKnownRoot` — every caller-supplied root must
 *      resolve to a root the server actually serves, matched by filesystem
 *      IDENTITY (dev+ino on POSIX) rather than by spelling, and the matched
 *      root's OWN registered spelling is what reaches the importer. An empty
 *      known-root set fails CLOSED.
 *   2. `importPlanFiles` — the result must report what the loop actually wrote
 *      (`count`/`written`/`planFiles`) separately from whether the sql.js image
 *      reached disk (`persisted`). A transient persist failure must never come
 *      back as `count: 0` with an empty `planFiles`: that number is what made a
 *      board-wide duplication announce itself as a no-op, and an empty
 *      `planFiles` additionally suppresses integration sync (extension.ts) for
 *      every row the import really did write.
 *
 * A case-only mis-spelling cannot be reproduced on a case-sensitive Linux CI
 * filesystem — two differently-cased directories are genuinely distinct there,
 * and refusing them is correct. A symlinked alias is the portable stand-in: it
 * is the same dev+ino behind a different spelling, which is exactly the identity
 * the guard has to see through.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));
const planFileImporter = require(path.join(process.cwd(), 'out', 'services', 'PlanFileImporter.js'));
const kanbanDbModule = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(err && err.stack ? err.stack : err);
    }
}

function makeServer(opts = {}) {
    return new LocalApiServer({
        clickupMetadataPath: '',
        linearMetadataPath: '',
        getClickUpService: () => null,
        getLinearService: () => null,
        getNotionService: () => null,
        getAuthToken: async () => 'test-token',
        allRoots: opts.allRoots || [],
        workspaceRoot: opts.workspaceRoot,
        getKanbanDatabase: async () => null,
    });
}

/**
 * Minimal KanbanDatabase stand-in. `insertFileDerivedPlan`'s boolean is the
 * whole-image disk-persist result, so each test overrides just that.
 */
function fakeDbBase() {
    return {
        ensureReady: async () => true,
        getWorkspaceId: async () => 'ws-test',
        setWorkspaceId: async () => {},
        getDominantWorkspaceId: async () => null,
        getWorkspaceMappings: async () => ({ mappings: [] }),
        getConfig: async () => null,
        getConfigJson: async () => null,
        getConfigJsonSync: () => null,
        getPlanByPlanFile: async () => null,
        insertFileDerivedPlan: async () => true,
    };
}

async function main() {
    console.log('\n=== Workspace-root resolution on the API write paths ===\n');

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-root-guard-'));
    const canonical = path.join(base, 'switchboard');
    const other = path.join(base, 'unrelated');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(other, { recursive: true });

    await check('the exact registered root resolves to itself', async () => {
        const server = makeServer({ allRoots: [canonical], workspaceRoot: canonical });
        const res = server._resolveKnownRoot(canonical);
        assert.ok(!('error' in res), `expected a match, got ${JSON.stringify(res)}`);
        assert.strictEqual(path.resolve(res.root), path.resolve(canonical));
    });

    await check('a DIFFERENTLY SPELLED path to the same directory resolves to the REGISTERED spelling', async () => {
        // The incident's shape: same directory, different spelling. The guard must
        // match on filesystem identity and hand the importer the registered root,
        // never the caller's string — storing the caller's spelling is what let
        // _ensureRelativePlanFile's prefix strip miss and key every file as new.
        const alias = path.join(base, 'alias-link');
        try { fs.symlinkSync(canonical, alias, 'dir'); } catch (e) {
            if (e && e.code !== 'EEXIST') { throw e; }
        }
        const server = makeServer({ allRoots: [canonical], workspaceRoot: canonical });
        const res = server._resolveKnownRoot(alias);
        assert.ok(!('error' in res), `an alias of a known root must be accepted, got ${JSON.stringify(res)}`);
        assert.strictEqual(path.resolve(res.root), path.resolve(canonical),
            'the matched root\'s own spelling must be returned, not the caller\'s');
    });

    await check('a trailing slash still resolves to the registered root', async () => {
        const server = makeServer({ allRoots: [canonical], workspaceRoot: canonical });
        const res = server._resolveKnownRoot(canonical + path.sep);
        assert.ok(!('error' in res), `expected a match, got ${JSON.stringify(res)}`);
        assert.strictEqual(path.resolve(res.root), path.resolve(canonical));
    });

    await check('an unregistered real directory is refused with 400 naming the known roots', async () => {
        const server = makeServer({ allRoots: [canonical], workspaceRoot: canonical });
        const res = server._resolveKnownRoot(other);
        assert.ok('error' in res, 'an arbitrary directory must not be accepted as a workspace root');
        assert.strictEqual(res.status, 400);
        assert.ok(res.error.includes(canonical), 'the refusal must name the acceptable roots');
        assert.match(res.error, /GET \/health/, 'the refusal must point the caller at the published list');
    });

    await check('a SUBDIRECTORY of a known root is refused — identity, not containment', async () => {
        const child = path.join(canonical, 'nested');
        fs.mkdirSync(child, { recursive: true });
        const server = makeServer({ allRoots: [canonical], workspaceRoot: canonical });
        const res = server._resolveKnownRoot(child);
        assert.ok('error' in res, 'a nested directory is a different workspace root, not the same one');
        assert.strictEqual(res.status, 400);
    });

    await check('an empty known-root set fails CLOSED with 503, never open', async () => {
        const server = makeServer({ allRoots: [] });
        const res = server._resolveKnownRoot(canonical);
        assert.ok('error' in res, 'an empty allowlist must never accept an arbitrary root');
        assert.strictEqual(res.status, 503);
    });

    await check('the single-root standalone construction accepts its own root', async () => {
        // src/standalone/bootstrap.ts passes allRoots: [workspaceRoot] and has no
        // mappings index — the union must degrade to that one root, not to empty.
        const server = makeServer({ allRoots: [canonical], workspaceRoot: canonical });
        const roots = server._getKnownRoots();
        assert.ok(roots.length >= 1, 'the standalone single-root set must not be empty');
        const res = server._resolveKnownRoot(canonical);
        assert.ok(!('error' in res), `standalone must serve its own root, got ${JSON.stringify(res)}`);
    });

    // ── Honest count ──────────────────────────────────────────────────────
    const origForWorkspace = kanbanDbModule.KanbanDatabase.forWorkspace;

    await check('a disk-persist failure reports what was WRITTEN and persisted:false — never count 0', async () => {
        const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-honest-count-'));
        const plansDir = path.join(wsRoot, '.switchboard', 'plans');
        fs.mkdirSync(plansDir, { recursive: true });
        fs.writeFileSync(path.join(plansDir, 'a.md'), '# A\n\n## Goal\n\nfirst\n');
        fs.writeFileSync(path.join(plansDir, 'b.md'), '# B\n\n## Goal\n\nsecond\n');

        // insertFileDerivedPlan's boolean is the WHOLE-IMAGE disk persist, not a
        // per-row verdict: the row is already in the committed transaction when it
        // returns false. Bucketing those records as failures — or discarding the
        // count — reports rows that ARE in the database as nothing having happened.
        kanbanDbModule.KanbanDatabase.forWorkspace = () => ({
            ...fakeDbBase(),
            insertFileDerivedPlan: async () => false,
        });
        try {
            const result = await planFileImporter.importPlanFiles(wsRoot);
            assert.strictEqual(result.count, 2,
                'count must be the number of records the loop wrote, not zero');
            assert.strictEqual(result.written.length, 2);
            assert.strictEqual(result.planFiles.length, 2,
                'an empty planFiles silently disables integration sync for rows that WERE written');
            assert.strictEqual(result.persisted, false,
                'the batch-level disk-persist failure must be reported on its own field');
        } finally {
            kanbanDbModule.KanbanDatabase.forWorkspace = origForWorkspace;
            fs.rmSync(wsRoot, { recursive: true, force: true });
        }
    });

    await check('a successful batch reports persisted:true and a count matching planFiles', async () => {
        const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-honest-count-ok-'));
        const plansDir = path.join(wsRoot, '.switchboard', 'plans');
        fs.mkdirSync(plansDir, { recursive: true });
        fs.writeFileSync(path.join(plansDir, 'a.md'), '# A\n\n## Goal\n\nfirst\n');

        kanbanDbModule.KanbanDatabase.forWorkspace = () => ({
            ...fakeDbBase(),
            insertFileDerivedPlan: async () => true,
        });
        try {
            const result = await planFileImporter.importPlanFiles(wsRoot);
            assert.strictEqual(result.persisted, true);
            assert.strictEqual(result.count, result.planFiles.length);
            assert.strictEqual(result.count, result.written.length);
        } finally {
            kanbanDbModule.KanbanDatabase.forWorkspace = origForWorkspace;
            fs.rmSync(wsRoot, { recursive: true, force: true });
        }
    });

    await check('a database that never opened reports persisted:false, not a clean zero', async () => {
        const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-honest-count-notready-'));
        fs.mkdirSync(path.join(wsRoot, '.switchboard', 'plans'), { recursive: true });
        fs.writeFileSync(path.join(wsRoot, '.switchboard', 'plans', 'a.md'), '# A\n\n## Goal\n\nx\n');

        kanbanDbModule.KanbanDatabase.forWorkspace = () => ({
            ...fakeDbBase(),
            ensureReady: async () => false,
        });
        try {
            const result = await planFileImporter.importPlanFiles(wsRoot);
            assert.strictEqual(result.count, 0);
            assert.strictEqual(result.persisted, false,
                '{count:0, persisted:true} from a DB that never opened is the false success this contract forbids');
        } finally {
            kanbanDbModule.KanbanDatabase.forWorkspace = origForWorkspace;
            fs.rmSync(wsRoot, { recursive: true, force: true });
        }
    });

    await check('an empty plans directory is a legitimate zero and stays persisted:true', async () => {
        const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-honest-count-empty-'));
        fs.mkdirSync(path.join(wsRoot, '.switchboard', 'plans'), { recursive: true });
        try {
            const result = await planFileImporter.importPlanFiles(wsRoot);
            assert.strictEqual(result.count, 0);
            assert.strictEqual(result.persisted, true,
                'nothing to write is not a failure — only a real persist miss clears this flag');
            assert.deepStrictEqual(result.written, []);
        } finally {
            fs.rmSync(wsRoot, { recursive: true, force: true });
        }
    });

    fs.rmSync(base, { recursive: true, force: true });

    console.log(failures === 0
        ? '\nworkspace-root write-path contract passed\n'
        : `\n${failures} failure(s)\n`);
    process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
