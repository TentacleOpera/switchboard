'use strict';

/**
 * Plan-write-set cache contract — plan
 * `.switchboard/plans/feature_plan_20260811094600_cache-plan-write-sets-for-dispatch-analysis.md`.
 *
 * The dispatch-analysis pass re-reads every candidate plan file on every run. This
 * cache stores each plan's extracted write set in `kanban.db`, keyed on the plan
 * file's mtime + size, so a run reads only the files that changed.
 *
 * The whole risk is a STALE HIT: a set from before an edit that added a file makes
 * the pass parallelise two plans that now collide — the unrecoverable failure the
 * skill exists to prevent, made invisible because the pass believes it did the work.
 * So every ambiguous case must resolve to a MISS, never a hit. These tests pin that,
 * plus the two schema paths (fresh vs migrated), the extractor_version gate, and
 * that both composition roots reach the routes (they share one LocalApiServer).
 *
 * Run with:
 *   npm run compile-tests
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/dispatch-writeset-cache-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

if (!process.env.SWITCHBOARD_STATE_HOME) {
    try { require('./bootstrap/sandboxStateHome'); } catch { /* already sandboxed */ }
}

const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');
installVscodeTrap();

const { LocalApiServer } = require('../../out/services/LocalApiServer');
const { KanbanDatabase, PLAN_WRITE_SET_EXTRACTOR_VERSION } = require('../../out/services/KanbanDatabase');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n     ') : e}`); failed++; }
}

const readSrc = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// ── Harness ──────────────────────────────────────────────────────────────────

function fakeRes() {
    return {
        statusCode: undefined,
        headers: undefined,
        body: undefined,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        end(chunk) { this.body = chunk; },
        get json() { try { return JSON.parse(this.body); } catch { return undefined; } },
    };
}

function fakeReq(url, method = 'GET') {
    return { url, method, headers: { host: '127.0.0.1:9999' } };
}

/** A POST req that streams `body` as JSON — `_parseJsonBody` reads 'data'/'end'. */
function fakeJsonReq(url, body) {
    const req = new EventEmitter();
    req.url = url;
    req.method = 'POST';
    req.headers = { host: '127.0.0.1:9999', 'x-switchboard-client': 'test' };
    process.nextTick(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
    });
    return req;
}

function buildServer(dbDouble) {
    const server = Object.create(LocalApiServer.prototype);
    server._options = {
        workspaceRoot: REPO_ROOT,
        getAuthToken: async () => '',
        getKanbanDatabase: async () => dbDouble,
    };
    server._port = 9999;
    return server;
}

function dbDouble(opts) {
    const o = opts || {};
    return {
        async probeStore() { return { reachable: true, tier: 'board' }; },
        async getWorkspaceId() { return 'ws-1'; },
        async getDominantWorkspaceId() { return 'ws-1'; },
        ...(o.extra || {}),
    };
}

async function makeWorkspace(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sb-writeset-${label}-`));
    fs.mkdirSync(path.join(root, '.switchboard', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(root, '.switchboard', 'workspace-id'), `ws-${label}\n`, 'utf8');
    const db = KanbanDatabase.forWorkspace(root);
    await db.createIfMissing();
    return { root, db };
}

function insertPlan(db, wsId, planId, planFile) {
    db.getDriver().run(
        `INSERT INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status,
             complexity, workspace_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [planId, planId, `topic ${planId}`, planFile, 'PLAN REVIEWED', 'active', '3', wsId,
            new Date().toISOString(), new Date().toISOString()]
    );
}

function writePlanFile(root, relPath, content) {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return abs;
}

function hasTable(db, name) {
    return db.querySql("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0;
}

async function main() {
    console.log('\n=== Plan write-set cache contract ===');

    // ── 1. Schema: both paths ────────────────────────────────────────────────
    console.log('\n── 1. both schema paths carry the table ──');

    await test('SCHEMA_TABLES_SQL and SCHEMA_INDEX_STATEMENTS declare plan_write_sets', () => {
        const src = readSrc('src/services/KanbanDatabase.ts');
        assert.ok(/CREATE TABLE IF NOT EXISTS plan_write_sets/.test(src),
            'fresh installs get the table from SCHEMA_TABLES_SQL, not only from the migration');
        assert.ok(/CREATE INDEX IF NOT EXISTS idx_plan_write_sets_ws/.test(src),
            'the workspace index must exist on both paths');
    });

    await test('the V82 migration is registered in the runner', () => {
        const src = readSrc('src/services/KanbanDatabase.ts');
        assert.ok(/MIGRATION_V82_SQL/.test(src), 'the migration constant must exist');
        assert.ok(/setMigrationVersion\(82\)/.test(src), 'the runner must stamp V82 — an unstamped migration re-runs every open');
        assert.ok(/export const PLAN_WRITE_SET_EXTRACTOR_VERSION/.test(src),
            'the extractor version must be a single exported lever, bumpable in one place');
    });

    await test('a fresh DB has plan_write_sets', async () => {
        const { root, db } = await makeWorkspace('fresh');
        try {
            assert.ok(hasTable(db, 'plan_write_sets'), 'createIfMissing must leave the table present');
            assert.ok((await db.getMigrationVersion()) >= 82, 'a fresh DB is stamped at least V82');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('a DB stamped at V81 gains the table after the migration runs', async () => {
        const { root, db } = await makeWorkspace('migrated');
        try {
            db.getDriver().run('DROP TABLE IF EXISTS plan_write_sets');
            await db.setMigrationVersion(81);
            await KanbanDatabase.invalidateWorkspace(root);
            const reopened = KanbanDatabase.forWorkspace(root);
            await reopened.ensureReady();
            assert.ok(hasTable(reopened, 'plan_write_sets'), 'the migration must add the table an upgraded install lacks');
            assert.strictEqual(await reopened.getMigrationVersion(), 82, 'and must stamp V82 exactly once');
            await KanbanDatabase.invalidateWorkspace(root);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    // ── 2. Hit/miss semantics ────────────────────────────────────────────────
    console.log('\n── 2. every ambiguous case resolves to a MISS ──');

    async function seed(label, planIds) {
        const { root, db } = await makeWorkspace(label);
        const wsId = await db.getWorkspaceId();
        for (const id of planIds) {
            const rel = `.switchboard/plans/${id}.md`;
            writePlanFile(root, rel, `# ${id}\n`);
            insertPlan(db, wsId, id, rel);
        }
        return { root, db, wsId };
    }

    async function upsert(db, entries) {
        return db.upsertPlanWriteSets(entries);
    }

    await test('an unchanged plan is a HIT and returns the stored set', async () => {
        const { root, db } = await seed('hit', ['p1']);
        try {
            await upsert(db, [{ planId: 'p1', planFile: '.switchboard/plans/p1.md', files: ['src/a.ts'], declaredDeps: ['p0'] }]);
            const { hits, misses } = await db.getPlanWriteSets(['p1']);
            assert.strictEqual(misses.length, 0);
            assert.strictEqual(hits.length, 1);
            assert.deepStrictEqual(hits[0].files, ['src/a.ts']);
            assert.deepStrictEqual(hits[0].declaredDeps, ['p0']);
        } finally { await KanbanDatabase.invalidateWorkspace(root); fs.rmSync(root, { recursive: true, force: true }); }
    });

    await test('an empty stored set is a HIT meaning "touches nothing", not a miss', async () => {
        const { root, db } = await seed('empty', ['p1']);
        try {
            await upsert(db, [{ planId: 'p1', planFile: '.switchboard/plans/p1.md', files: [] }]);
            const { hits, misses } = await db.getPlanWriteSets(['p1']);
            assert.strictEqual(misses.length, 0, 'an empty set must not be conflated with "unknown"');
            assert.deepStrictEqual(hits[0].files, []);
        } finally { await KanbanDatabase.invalidateWorkspace(root); fs.rmSync(root, { recursive: true, force: true }); }
    });

    await test('no row → miss reason no-row', async () => {
        const { root, db } = await seed('norow', ['p1']);
        try {
            const { misses } = await db.getPlanWriteSets(['p1']);
            assert.strictEqual(misses[0].reason, 'no-row');
        } finally { await KanbanDatabase.invalidateWorkspace(root); fs.rmSync(root, { recursive: true, force: true }); }
    });

    await test('touching mtime → mtime-changed', async () => {
        const { root, db } = await seed('mtime', ['p1']);
        try {
            const abs = path.join(root, '.switchboard/plans/p1.md');
            await upsert(db, [{ planId: 'p1', planFile: '.switchboard/plans/p1.md', files: ['src/a.ts'] }]);
            const future = new Date(Date.now() + 5000);
            fs.utimesSync(abs, future, future);
            const { misses } = await db.getPlanWriteSets(['p1']);
            assert.strictEqual(misses[0].reason, 'mtime-changed');
        } finally { await KanbanDatabase.invalidateWorkspace(root); fs.rmSync(root, { recursive: true, force: true }); }
    });

    await test('appending a byte → size-changed', async () => {
        const { root, db } = await seed('size', ['p1']);
        try {
            const abs = path.join(root, '.switchboard/plans/p1.md');
            await upsert(db, [{ planId: 'p1', planFile: '.switchboard/plans/p1.md', files: ['src/a.ts'] }]);
            const before = fs.statSync(abs).mtimeMs;
            fs.appendFileSync(abs, 'x');
            // Hold mtime constant so ONLY size differs — otherwise the test would pass
            // on mtime and never exercise the size key.
            fs.utimesSync(abs, new Date(before), new Date(before));
            const { misses } = await db.getPlanWriteSets(['p1']);
            assert.strictEqual(misses[0].reason, 'size-changed');
        } finally { await KanbanDatabase.invalidateWorkspace(root); fs.rmSync(root, { recursive: true, force: true }); }
    });

    await test('renaming the plan file → path-changed', async () => {
        const { root, db, wsId } = await seed('path', ['p1']);
        try {
            await upsert(db, [{ planId: 'p1', planFile: '.switchboard/plans/p1.md', files: ['src/a.ts'] }]);
            db.getDriver().run('UPDATE plans SET plan_file = ? WHERE plan_id = ? AND workspace_id = ?',
                ['.switchboard/plans/p1-renamed.md', 'p1', wsId]);
            const { misses } = await db.getPlanWriteSets(['p1']);
            assert.strictEqual(misses[0].reason, 'path-changed');
        } finally { await KanbanDatabase.invalidateWorkspace(root); fs.rmSync(root, { recursive: true, force: true }); }
    });

    await test('bumping extractor_version → extractor-version', async () => {
        const { root, db } = await seed('ver', ['p1']);
        try {
            await upsert(db, [{ planId: 'p1', planFile: '.switchboard/plans/p1.md', files: ['src/a.ts'] }]);
            db.getDriver().run('UPDATE plan_write_sets SET extractor_version = ? WHERE plan_id = ?',
                [PLAN_WRITE_SET_EXTRACTOR_VERSION + 100, 'p1']);
            const { misses } = await db.getPlanWriteSets(['p1']);
            assert.strictEqual(misses[0].reason, 'extractor-version',
                'a rules change is invisible to mtime — without this gate every row would serve stale sets forever');
        } finally { await KanbanDatabase.invalidateWorkspace(root); fs.rmSync(root, { recursive: true, force: true }); }
    });

    await test('deleting the file → stat-failed', async () => {
        const { root, db } = await seed('stat', ['p1']);
        try {
            await upsert(db, [{ planId: 'p1', planFile: '.switchboard/plans/p1.md', files: ['src/a.ts'] }]);
            fs.rmSync(path.join(root, '.switchboard/plans/p1.md'));
            const { misses } = await db.getPlanWriteSets(['p1']);
            assert.strictEqual(misses[0].reason, 'stat-failed',
                'a row must never be served for a file that no longer exists — it is the last thing that would reveal a deleted plan');
        } finally { await KanbanDatabase.invalidateWorkspace(root); fs.rmSync(root, { recursive: true, force: true }); }
    });

    await test('a set extracted from content that changed before the POST stays a MISS', async () => {
        const { root, db } = await seed('interlock', ['p1']);
        try {
            const abs = path.join(root, '.switchboard/plans/p1.md');
            const readSize = fs.statSync(abs).size;
            const readStamp = Math.round(fs.statSync(abs).mtimeMs);
            // The file is edited AFTER the extractor read it, BEFORE the POST.
            fs.appendFileSync(abs, '\nedited\n');
            const result = await upsert(db, [{
                planId: 'p1', planFile: '.switchboard/plans/p1.md', files: ['src/a.ts'],
                sourceMtimeMs: readStamp, sourceSize: readSize,
            }]);
            assert.strictEqual(result.written, 0, 'a stale extraction must not be written as a fresh row');
            assert.strictEqual(result.skipped, 1);
            const { misses } = await db.getPlanWriteSets(['p1']);
            assert.strictEqual(misses[0].reason, 'no-row', 'the entry stayed a miss rather than fabricating a hit');
        } finally { await KanbanDatabase.invalidateWorkspace(root); fs.rmSync(root, { recursive: true, force: true }); }
    });

    await test('a stat-failed entry is skipped, never stamped', async () => {
        const { root, db } = await seed('skipstat', ['p1']);
        try {
            fs.rmSync(path.join(root, '.switchboard/plans/p1.md'));
            const result = await upsert(db, [{ planId: 'p1', planFile: '.switchboard/plans/p1.md', files: ['src/a.ts'] }]);
            assert.strictEqual(result.written, 0);
            const { misses } = await db.getPlanWriteSets(['p1']);
            assert.strictEqual(misses[0].reason, 'no-row');
        } finally { await KanbanDatabase.invalidateWorkspace(root); fs.rmSync(root, { recursive: true, force: true }); }
    });

    // ── 3. Endpoint surface ──────────────────────────────────────────────────
    console.log('\n── 3. one LocalApiServer, both hosts ──');

    await test('the routes are registered on the shared LocalApiServer route ladder', () => {
        const api = readSrc('src/services/LocalApiServer.ts');
        assert.ok(/pathname === '\/dispatch\/writesets' && req\.method === 'GET'/.test(api), 'GET route must be registered');
        assert.ok(/pathname === '\/dispatch\/writesets' && req\.method === 'POST'/.test(api), 'POST route must be registered');
    });

    await test('the standalone host does not fork its own route table', () => {
        const boot = readSrc('src/standalone/bootstrap.ts');
        assert.ok(!/\/dispatch\/writesets/.test(boot),
            'standalone constructs the same LocalApiServer — a second route table is the divergence this guards');
        assert.ok(/new LocalApiServer\(/.test(boot), 'standalone must construct the shared server');
    });

    await test('GET /dispatch/writesets returns hits/misses and requires planIds', async () => {
        const db = dbDouble({ extra: { async getPlanWriteSets(ids) { return { hits: [{ planId: ids[0], files: [] }], misses: [] }; } } });
        const okRes = fakeRes();
        await buildServer(db)._handleGetDispatchWriteSets(fakeReq('/dispatch/writesets?planIds=p1,p2'), okRes);
        assert.strictEqual(okRes.statusCode, 200);
        assert.strictEqual(okRes.json.data.hits.length, 1);

        const badRes = fakeRes();
        await buildServer(db)._handleGetDispatchWriteSets(fakeReq('/dispatch/writesets'), badRes);
        assert.strictEqual(badRes.statusCode, 400, 'a missing planIds must be rejected, not answered with an empty success');
    });

    await test('GET degrades to all-miss when the store has no cache support', async () => {
        const res = fakeRes();
        await buildServer(dbDouble())._handleGetDispatchWriteSets(fakeReq('/dispatch/writesets?planIds=p1'), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.json.data.hits.length, 0);
        assert.strictEqual(res.json.data.misses[0].reason, 'no-row');
    });

    await test('POST /dispatch/writesets validates entries at the boundary', async () => {
        const db = dbDouble({ extra: { async upsertPlanWriteSets(entries) { return { written: entries.length, skipped: 0 }; } } });

        const okRes = fakeRes();
        await buildServer(db)._handlePostDispatchWriteSets(
            fakeJsonReq('/dispatch/writesets', { entries: [{ planId: 'p1', files: ['src/a.ts'] }] }), okRes);
        assert.strictEqual(okRes.statusCode, 200);

        const noPlanRes = fakeRes();
        await buildServer(db)._handlePostDispatchWriteSets(
            fakeJsonReq('/dispatch/writesets', { entries: [{ files: [] }] }), noPlanRes);
        assert.strictEqual(noPlanRes.statusCode, 400);

        const badFilesRes = fakeRes();
        await buildServer(db)._handlePostDispatchWriteSets(
            fakeJsonReq('/dispatch/writesets', { entries: [{ planId: 'p1', files: 'src/a.ts' }] }), badFilesRes);
        assert.strictEqual(badFilesRes.statusCode, 400);
    });

    // ── 4. The skill fetches before it reads ─────────────────────────────────
    console.log('\n── 4. the protocol fetches before it reads ──');

    function skillBody() {
        const bundle = readSrc('src/services/bundledProtocols.ts');
        const m = bundle.match(/"dispatch-analysis":\s*\{[^}]*"body":\s*"((?:[^"\\]|\\.)*)"/s);
        assert.ok(m, 'dispatch-analysis body must be present in the bundle');
        return JSON.parse('"' + m[1] + '"');
    }

    await test('step 2 names the cache, the hit rule, and the stamp interlock', () => {
        const skill = skillBody();
        assert.ok(/\/dispatch\/writesets/.test(skill), 'step 2 must call the cache endpoints');
        assert.ok(/Do NOT open the\s+plan file/.test(skill), 'a hit must forbid opening the plan file');
        assert.ok(/sourceMtimeMs/.test(skill), 'the POST must carry the observed stamp so a stale extraction stays a miss');
    });

    await test('step 5 re-verifies the stamps before moving', () => {
        const skill = skillBody();
        assert.ok(/Re-`GET \/dispatch\/writesets` for the selected set only/.test(skill),
            'the read-to-move window must be re-checked immediately before the moves');
        assert.ok(/edited during analysis — not staged/.test(skill), 'a card edited mid-pass must be dropped and named');
    });

    await test('the rules carry the fallback and the extractor_version lever', () => {
        const skill = skillBody();
        assert.ok(/The cache never decides a plan is safe/.test(skill), 'a miss/error/unreachable endpoint must fall back to reading');
        assert.ok(/extractor_version` must be bumped/.test(skill), 'the rules-change lever must be stated in the protocol');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) { process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
