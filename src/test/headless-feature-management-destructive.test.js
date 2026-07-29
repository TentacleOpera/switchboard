'use strict';

/**
 * Destructive & Convergence Path Tests for Headless Feature Management.
 *
 * The sibling suite (headless-feature-management-contract.test.js) covers the
 * create/promote spine. This one covers the destructive and convergence half —
 * the operations external agent hosts drive unattended:
 *
 *  - reconcileFeatures convergence (create, detach-by-omission, and the
 *    removeUnmentionedFeatures flag in BOTH positions)
 *  - deleteFeature with deleteSubtasks false/true + child-worktree abandonment
 *  - removeSubtaskFromFeature (detach, feature-file regen, worktree abandon)
 *  - splitFeature (partition subtasks into two new features, original deleted)
 *  - watcher exclusion with a LIVE PlanIngestionEngine on the temp root
 *  - a board push a real `ws` client receives, over a real LocalApiServer
 *  - POST /kanban/feature hook-route smoke (200 with data, never 503)
 *
 * Harness notes (learned the hard way — do not "simplify" these):
 *  - `KanbanDatabase` NEVER auto-creates kanban.db (scaffold-litter policy), so
 *    the file must be touched on disk before ensureReady() will initialise it.
 *  - ONE temp workspace and ONE database for the whole suite. Per-test
 *    workspaces exhaust the shared sql.js WASM heap, which presents as
 *    "disk I/O error" across every DB at once.
 *  - `tombstonePlan` sets status='deleted'; the ROW SURVIVES. Deletion is
 *    asserted as status==='deleted', never as a missing row.
 *  - `getPlanByPlanId` returns camelCase records and `featureId` is '' (not
 *    null) when unset, so detach is asserted as falsy.
 *  - The provider is built exactly the way bootstrap.ts builds it, including the
 *    `_hostSeams = undefined` post-construction assignment the sibling suite
 *    documents.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const WebSocket = require('ws');

// `vscode` → the standalone shim, installed BEFORE any out/services require.
const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
{
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') return require(shimPath);
        return originalLoad.apply(this, arguments);
    };
}

// tsc does not copy plain .js helpers into out/; mirror the sibling suite's gap fill.
{
    const implSrc = path.join(__dirname, '..', 'services', 'kanbanColumnDerivationImpl.js');
    const implOut = path.join(__dirname, '..', '..', 'out', 'services', 'kanbanColumnDerivationImpl.js');
    if (fs.existsSync(implSrc) && !fs.existsSync(implOut)) {
        fs.copyFileSync(implSrc, implOut);
    }
}

const { LocalApiServer } = require('../../out/services/LocalApiServer');
const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const { BroadcastHub } = require('../../out/services/broadcastHub');
const { PlanIngestionEngine } = require('../../out/services/PlanIngestionEngine');
const { createStandalonePlanIngestionHost } = require('../../out/standalone/planIngestionHost');

const repoRoot = path.join(__dirname, '..', '..');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n     ') : e}`);
        failed++;
    }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy or the deadline passes. Never a bare sleep. */
async function pollUntil(fn, timeoutMs = 4000, stepMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() >= deadline) return v;
        await wait(stepMs);
    }
}

function memento() {
    const m = new Map();
    return {
        get: (k, d) => (m.has(k) ? m.get(k) : d),
        update: async (k, v) => { m.set(k, v); },
        keys: () => Array.from(m.keys()),
    };
}

async function run() {
    console.log('\nHeadless Feature Management — Destructive & Convergence Path Tests\n');

    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-feat-destr-')));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'features'), { recursive: true });

    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    // ── DB: touch the file first — KanbanDatabase never auto-creates it ──────
    const db = KanbanDatabase.forWorkspace(tmpRoot);
    {
        const dbDir = path.dirname(db.dbPath);
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        if (!fs.existsSync(db.dbPath)) fs.writeFileSync(db.dbPath, Buffer.alloc(0));
        assert.ok(await db.ensureReady(), 'seeded kanban.db must initialise');
    }
    const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'destr-ws';

    // ── Provider: bootstrap.ts shape ────────────────────────────────────────
    const headlessContext = {
        globalState: memento(),
        workspaceState: memento(),
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
        extensionUri: { fsPath: repoRoot },
        extensionPath: repoRoot,
        subscriptions: [],
    };
    const kp = new KanbanProvider({ fsPath: repoRoot }, headlessContext, undefined, undefined);
    kp._hostSeams = undefined;
    kp._broadcaster = new BroadcastHub({ webview: null, apiServer: null });
    kp._currentWorkspaceRoot = tmpRoot;
    await wait(150);

    /** Write a plan file and insert its DB row. Returns the planId. */
    async function seedPlan({ planId, slug, topic, column = 'CREATED', featureId }) {
        const rel = `.switchboard/plans/${slug}.md`;
        fs.writeFileSync(path.join(tmpRoot, rel), `# ${topic}\n\n## Goal\n${topic}\n`, 'utf8');
        const now = new Date().toISOString();
        const ok = await db.insertFileDerivedPlan({
            planId,
            sessionId: planId,
            topic,
            planFile: rel,
            kanbanColumn: column,
            status: 'active',
            complexity: '3',
            tags: '',
            project: '',
            workspaceId: wsId,
            createdAt: now,
            updatedAt: now,
            sourceType: 'local',
            workspaceName: 'destr',
            isFeature: 0,
        });
        assert.ok(ok, `seedPlan(${slug}) must insert`);
        // `insertFileDerivedPlan`'s INSERT column list does NOT include feature_id
        // — passing featureId in the record is a silent no-op. Link through the
        // real primitive, or every "subtask" is an orphan and the destructive
        // assertions below pass vacuously.
        if (featureId) {
            assert.ok(await db.updateFeatureStatus(planId, 0, featureId),
                `seedPlan(${slug}) must link to feature ${featureId}`);
            assert.strictEqual((await db.getPlanByPlanId(planId)).featureId, featureId,
                `seedPlan(${slug}) link must be readable back`);
        }
        return planId;
    }

    const featureIdOf = async (planId) => (await db.getPlanByPlanId(planId))?.featureId || '';
    const statusOf = async (planId) => (await db.getPlanByPlanId(planId))?.status;

    console.log('── reconcileFeatures convergence ──');

    await test('reconcileFeatures: creates a feature and attaches an existing plan by path', async () => {
        await seedPlan({ planId: 'destr-rec-1', slug: 'rec-sub1', topic: 'Rec Sub 1' });

        const res = await kp.reconcileFeatures(tmpRoot, [{
            name: 'Feature Alpha',
            description: 'Alpha',
            subtasks: ['.switchboard/plans/rec-sub1.md'],
        }], { removeUnmentionedFeatures: false });

        assert.strictEqual(res.success, true, res.error);
        assert.ok(Array.isArray(res.features) && res.features.length === 1,
            `expected one feature in body, got ${JSON.stringify(res.features)}`);
        const alpha = res.features[0];
        assert.ok(alpha.featurePlanId, 'body must carry featurePlanId');
        assert.ok(alpha.subtasks.some((s) => s.planId === 'destr-rec-1'),
            `resolved subtask must be the seeded plan: ${JSON.stringify(alpha.subtasks)}`);
        assert.strictEqual(await featureIdOf('destr-rec-1'), alpha.featurePlanId,
            'DB must converge: the plan is now a subtask of Alpha');
    });

    await test('reconcileFeatures: omitting a subtask from a MENTIONED feature detaches it', async () => {
        const res = await kp.reconcileFeatures(tmpRoot, [{ name: 'Feature Alpha', subtasks: [] }],
            { removeUnmentionedFeatures: false });
        assert.strictEqual(res.success, true, res.error);
        assert.ok(!(await featureIdOf('destr-rec-1')),
            'omission from a mentioned feature must detach the subtask');
    });

    let betaId;
    await test('reconcileFeatures: an UNMENTIONED feature survives when the flag is OFF (default)', async () => {
        const mk = await kp.reconcileFeatures(tmpRoot, [{ name: 'Feature Beta', subtasks: [] }],
            { removeUnmentionedFeatures: false });
        assert.strictEqual(mk.success, true, mk.error);
        betaId = mk.features[0].featurePlanId;
        assert.ok(betaId);

        // Reconcile mentioning ONLY Alpha, flag off → Beta must be untouched.
        const res = await kp.reconcileFeatures(tmpRoot, [{ name: 'Feature Alpha', subtasks: [] }],
            { removeUnmentionedFeatures: false });
        assert.strictEqual(res.success, true, res.error);
        assert.strictEqual(await statusOf(betaId), 'active',
            'flag-off default must NOT remove an unmentioned feature');
    });

    await test('reconcileFeatures: an UNMENTIONED feature is removed when the flag is ON', async () => {
        const res = await kp.reconcileFeatures(tmpRoot, [{ name: 'Feature Alpha', subtasks: [] }],
            { removeUnmentionedFeatures: true });
        assert.strictEqual(res.success, true, res.error);
        assert.strictEqual(await statusOf(betaId), 'deleted',
            'flag-on must tombstone the unmentioned feature');
    });

    await test('reconcileFeatures: inline subtask refs dedupe on the deterministic plan path (retry is a no-op)', async () => {
        const manifest = [{
            name: 'Feature Inline',
            subtasks: [{ slug: 'inline-one', title: 'Inline One' }],
        }];
        const first = await kp.reconcileFeatures(tmpRoot, manifest, { removeUnmentionedFeatures: false });
        assert.strictEqual(first.success, true, first.error);
        const firstPlanId = first.features[0].subtasks[0].planId;

        const second = await kp.reconcileFeatures(tmpRoot, manifest, { removeUnmentionedFeatures: false });
        assert.strictEqual(second.success, true, second.error);
        assert.strictEqual(second.features[0].subtasks[0].planId, firstPlanId,
            'the same inline ref must resolve to the same plan, not create a duplicate');
    });

    console.log('\n── deleteFeature side effects ──');

    await test('deleteFeature (deleteSubtasks=false): feature tombstoned, subtask kept and detached', async () => {
        const created = await kp.handleServiceVerb('createFeature',
            { name: 'Delete Keep Subs', subtaskPlanIds: [], workspaceRoot: tmpRoot });
        assert.strictEqual(created.success, true, created.error);
        const featId = created.featurePlanId;
        await seedPlan({ planId: 'destr-del-1', slug: 'del-sub1', topic: 'Del Sub 1', featureId: featId });

        const r = await kp.handleServiceVerb('deleteFeature',
            { sessionId: featId, deleteSubtasks: false, workspaceRoot: tmpRoot });
        assert.strictEqual(r.success, true, r.error);

        assert.strictEqual(await statusOf(featId), 'deleted', 'feature row must be tombstoned');
        assert.strictEqual(await statusOf('destr-del-1'), 'active', 'subtask must survive');
        assert.ok(!(await featureIdOf('destr-del-1')), 'surviving subtask must be detached');
    });

    await test('deleteFeature (deleteSubtasks=true): subtask tombstoned and child worktree abandoned', async () => {
        const created = await kp.handleServiceVerb('createFeature',
            { name: 'Delete With Subs', subtaskPlanIds: [], workspaceRoot: tmpRoot });
        assert.strictEqual(created.success, true, created.error);
        const featId = created.featurePlanId;
        await seedPlan({ planId: 'destr-del-2', slug: 'del-sub2', topic: 'Del Sub 2', featureId: featId });

        // Fake, non-existent worktree path: _removeWorktreeRow skips the git
        // call when the dir is absent and logs-and-continues on failure, so the
        // assertable contract is purely the status flip.
        const wtId = await db.addWorktree('destr-del-wt', path.join(tmpRoot, 'no-such-wt'),
            featId, undefined, 'destr-del-2');
        assert.ok(typeof wtId === 'number' && wtId > 0, `addWorktree must return a row id, got ${wtId}`);

        const r = await kp.handleServiceVerb('deleteFeature',
            { sessionId: featId, deleteSubtasks: true, workspaceRoot: tmpRoot });
        assert.strictEqual(r.success, true, r.error);

        assert.strictEqual(await statusOf(featId), 'deleted', 'feature row must be tombstoned');
        assert.strictEqual(await statusOf('destr-del-2'), 'deleted', 'subtask must be tombstoned too');

        // `getWorktrees()` is status-filtered (WHERE status='active'), so an
        // abandoned row DISAPPEARS from it. Read the row back by branch — the
        // only accessor that is not status-filtered — to assert the status flip
        // rather than mere absence.
        const wt = await db.getWorktreeByBranch('destr-del-wt');
        assert.ok(wt, 'worktree row must survive as a record (abandoned, not hard-deleted)');
        assert.strictEqual(wt.status, 'abandoned', 'child worktree must be abandoned, not merged');
        assert.ok(!(await db.getWorktrees()).some((w) => w.id === wtId),
            'an abandoned worktree must no longer appear in the active worktree list');
    });

    console.log('\n── removeSubtaskFromFeature ──');

    await test('removeSubtaskFromFeature: detaches, abandons its worktree, and regenerates the feature file', async () => {
        const created = await kp.handleServiceVerb('createFeature',
            { name: 'Remove Subtask Host', subtaskPlanIds: [], workspaceRoot: tmpRoot });
        assert.strictEqual(created.success, true, created.error);
        const featId = created.featurePlanId;
        await seedPlan({ planId: 'destr-rem-1', slug: 'rem-sub1', topic: 'Rem Sub 1', featureId: featId });

        const wtId = await db.addWorktree('destr-rem-wt', path.join(tmpRoot, 'no-such-rem-wt'),
            featId, undefined, 'destr-rem-1');

        // Regenerate first so the file genuinely LISTS the subtask — otherwise
        // "absent afterwards" would pass vacuously.
        await kp.regenerateFeatureFile(tmpRoot, featId);
        const featFile = (await db.getPlanByPlanId(featId)).planFile;
        // Assert on the auto-generated ## Subtasks block specifically. The rest of
        // the file is author-owned prose the regenerator must not touch, so a
        // whole-file grep would report the wrong thing.
        const subtasksBlock = (src) => {
            const m = /<!-- BEGIN SUBTASKS[\s\S]*?<!-- END SUBTASKS -->/.exec(src);
            assert.ok(m, `feature file must carry an auto-generated SUBTASKS block:\n${src}`);
            return m[0];
        };
        assert.ok(subtasksBlock(fs.readFileSync(featFile, 'utf8')).includes('rem-sub1.md'),
            'precondition: regenerated ## Subtasks block must list the subtask');

        const r = await kp.handleServiceVerb('removeSubtaskFromFeature',
            { subtaskSessionId: 'destr-rem-1', workspaceRoot: tmpRoot });
        assert.strictEqual(r.success, true, r.error);

        assert.ok(!(await featureIdOf('destr-rem-1')), 'subtask must be detached');
        const afterBlock = subtasksBlock(fs.readFileSync(featFile, 'utf8'));
        assert.ok(!afterBlock.includes('rem-sub1.md'),
            `## Subtasks block must be regenerated without the removed subtask, got:\n${afterBlock}`);

        const wt = await db.getWorktreeByBranch('destr-rem-wt');
        assert.strictEqual(wt.status, 'abandoned', 'the subtask worktree must be abandoned');
        assert.ok(!(await db.getWorktrees()).some((w) => w.id === wtId),
            'an abandoned worktree must no longer appear in the active worktree list');
    });

    console.log('\n── splitFeature ──');

    await test('splitFeature: partitions subtasks into two new features and deletes the original', async () => {
        const created = await kp.handleServiceVerb('createFeature',
            { name: 'Split Original', subtaskPlanIds: [], workspaceRoot: tmpRoot });
        assert.strictEqual(created.success, true, created.error);
        const featId = created.featurePlanId;
        await seedPlan({ planId: 'destr-split-1', slug: 'split1', topic: 'Split 1', featureId: featId });
        await seedPlan({ planId: 'destr-split-2', slug: 'split2', topic: 'Split 2', featureId: featId });

        const r = await kp.splitFeature(tmpRoot, featId, ['destr-split-1'], 'Split New A', 'Split New B');
        assert.strictEqual(r.success, true, r.error);
        assert.ok(r.firstFeaturePlanId && r.secondFeaturePlanId,
            `both new feature ids must come back in-body: ${JSON.stringify(r)}`);

        assert.strictEqual(await statusOf(featId), 'deleted', 'original feature must be deleted');
        assert.strictEqual(await featureIdOf('destr-split-1'), r.firstFeaturePlanId,
            'kept subtask goes to the first new feature');
        assert.strictEqual(await featureIdOf('destr-split-2'), r.secondFeaturePlanId,
            'the remainder goes to the second new feature');
        assert.notStrictEqual(r.firstFeaturePlanId, r.secondFeaturePlanId);

        for (const id of [r.firstFeaturePlanId, r.secondFeaturePlanId]) {
            const row = await db.getPlanByPlanId(id);
            assert.ok(row && row.isFeature, `${id} must be a feature row`);
            assert.ok(fs.existsSync(row.planFile), `new feature file must exist on disk: ${row.planFile}`);
        }
    });

    console.log('\n── watcher exclusion with a LIVE PlanIngestionEngine ──');

    await test('a feature created through the provider is NOT re-imported as a plain plan', async () => {
        const cfg = {
            getConfigBoolean: (_k, d) => d,
            getConfigNumber: (_k, d) => d,
            getConfigJson: (_k, d) => d,
            getConfigString: (_k, d) => d ?? '',
        };
        const host = createStandalonePlanIngestionHost({
            workspaceRoot: tmpRoot,
            config: cfg,
            extraRoots: [],
            log: () => {},
        });
        const getSvc = () => null;
        const engine = new PlanIngestionEngine(getSvc, getSvc, host, getSvc);
        engine.setFeatureColumnRecomputer((fid, root) => kp.recomputeFeatureColumnFromSubtasks(fid, root));
        engine.setFeatureFileRegenerator((ws, fid) => kp.regenerateFeatureFile(ws, fid));
        const discovered = [];
        engine.onPlanDiscovered((root, filePath) => discovered.push({ root, filePath }));
        await engine.initialize();

        try {
            const created = await kp.handleServiceVerb('createFeature',
                { name: 'Watcher Exclusion Feature', subtaskPlanIds: [], workspaceRoot: tmpRoot });
            assert.strictEqual(created.success, true, created.error);
            const featId = created.featurePlanId;
            const featRel = path.basename((await db.getPlanByPlanId(featId)).planFile);

            // Poll for a DUPLICATE row keyed on the same feature file. If the
            // suppression delegation were broken the duplicate lands as soon as
            // the create event is processed — milliseconds, not the 10s TTL.
            const dupes = await pollUntil(async () => {
                const rows = (await db.getAllPlans(wsId))
                    .filter((p) => String(p.planFile).replace(/\\/g, '/').endsWith(featRel));
                return rows.length > 1 ? rows : null;
            }, 3500);

            const rows = (await db.getAllPlans(wsId))
                .filter((p) => String(p.planFile).replace(/\\/g, '/').endsWith(featRel));
            assert.ok(!dupes, `watcher re-imported the feature file: ${rows.length} rows for ${featRel}`);
            assert.strictEqual(rows.length, 1, `exactly one row for ${featRel}, got ${rows.length}`);
            assert.ok(rows[0].isFeature, 'the surviving row must still be the FEATURE row, not a plain plan');
        } finally {
            if (typeof engine.dispose === 'function') engine.dispose();
        }
    });

    console.log('\n── real LocalApiServer: WS board push + hook-route smoke ──');

    await test('a createFeature dispatch reaches a real ws client, and POST /kanban/feature returns 200 with data', async () => {
        // Hooks are TOP-LEVEL LocalApiServerOptions members, not a nested `hooks`
        // object — a nested bag leaves every hook undefined and every route 503s.
        const server = new LocalApiServer({
            port: 0,
            workspaceRoot: tmpRoot,
            // Proven in-repo pattern (cross-client-scope-contract.test.js): an
            // empty token keeps _checkAuth's historical loopback trust. Not a
            // hand-rolled bypass.
            getAuthToken: async () => '',
            getFullState: async () => [{ type: 'seed' }],
            createFeature: async (root, name, planIds, description) =>
                kp.handleServiceVerb('createFeature',
                    { name, subtaskPlanIds: planIds, description, workspaceRoot: root || tmpRoot }),
            assignToFeature: async () => ({ success: true, assigned: [], skipped: [] }),
            removeSubtaskFromFeature: async (root, subtaskPlanId) =>
                kp.handleServiceVerb('removeSubtaskFromFeature',
                    { subtaskSessionId: subtaskPlanId, workspaceRoot: root || tmpRoot }),
            deleteFeature: async (root, featurePlanId, deleteSubtasks) =>
                kp.handleServiceVerb('deleteFeature',
                    { sessionId: featurePlanId, deleteSubtasks, workspaceRoot: root || tmpRoot }),
            splitFeature: async (root, featurePlanId, keptPlanIds, a, b) =>
                kp.splitFeature(root || tmpRoot, featurePlanId, keptPlanIds, a, b),
            reconcileFeatures: async (root, desired, options) =>
                kp.reconcileFeatures(root || tmpRoot, desired, options),
        });

        await server.start();
        const port = server.getPort();
        assert.ok(port > 0, 'server must bind a real port');
        assert.strictEqual(server.hasFeatureManagement(), true,
            'all six feature hooks must be wired (else the capability flag overstates support)');

        // Wire the push target the way bootstrap.ts does: server first, then setApiServer.
        kp.setApiServer(server);

        // The provider's own `_refreshBoard` bails on `!this._panel`, which is
        // ALWAYS true headless — so the provider never broadcasts by itself.
        // bootstrap.ts compensates: its kanbanVerb arm awaits handleServiceVerb
        // and then calls pushFullState() (bootstrap.ts, 'createFeature' arm).
        // Mirror that rail here — the frame under test is the one bootstrap
        // actually emits.
        const kanbanVerbRail = async (verb, payload) => {
            const result = await kp.handleServiceVerb(verb, { ...payload, workspaceRoot: tmpRoot });
            const cards = await db.getAllPlans(wsId);
            server.broadcastWs('updateCards', { type: 'updateCards', cards: cards.length });
            return result;
        };

        const frames = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        try {
            await new Promise((resolve, reject) => {
                ws.on('open', resolve);
                ws.on('error', reject);
            });
            ws.on('message', (raw) => {
                try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore junk */ }
            });

            // Let the connect-time __resync land, then ignore everything so far —
            // otherwise the resync frame alone would satisfy the assertion.
            await wait(250);
            frames.length = 0;

            const created = await kanbanVerbRail('createFeature', { name: 'WS Push Feature', subtaskPlanIds: [] });
            assert.strictEqual(created.success, true, created.error);

            await pollUntil(() => frames.length > 0, 4000);
            assert.ok(frames.length > 0,
                'a board push must reach the ws client after a mutation — the broadcaster→WS path is live');

            // Pin the wiring the runtime assertion above depends on: bootstrap's
            // feature-verb arm must still push after dispatching. If someone drops
            // that call, standalone mutations go silent and the board stops moving.
            const bootstrapSrc = fs.readFileSync(path.join(repoRoot, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
            const featureArm = /case 'createFeature':[\s\S]{0,400}?await pushFullState\(\);/.test(bootstrapSrc);
            assert.ok(featureArm,
                "bootstrap.ts's createFeature verb arm must still call pushFullState() after handleServiceVerb");

            // ── HTTP hook-route smoke. /kanban/feature requires a NON-EMPTY
            //    planIds array; an empty one is a 400 by design, not a 503.
            await seedPlan({ planId: 'destr-http-1', slug: 'http-sub1', topic: 'HTTP Sub 1' });
            const payload = JSON.stringify({
                name: 'HTTP Hook Feature',
                planIds: ['destr-http-1'],
                workspaceRoot: tmpRoot,
            });
            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/kanban/feature',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                }, (r) => {
                    let body = '';
                    r.on('data', (c) => { body += c; });
                    r.on('end', () => resolve({ statusCode: r.statusCode, body }));
                });
                req.on('error', reject);
                req.write(payload);
                req.end();
            });

            assert.strictEqual(res.statusCode, 200,
                `POST /kanban/feature must be served by the wired hook, got ${res.statusCode}: ${res.body}`);
            const parsed = JSON.parse(res.body);
            assert.strictEqual(parsed.success, true, `route body: ${res.body}`);
            assert.ok(parsed.featurePlanId, 'route must return featurePlanId in-body, not a bare ack');
            assert.strictEqual(await featureIdOf('destr-http-1'), parsed.featurePlanId,
                'the plan posted over HTTP must actually be attached to the new feature');
        } finally {
            try { ws.close(); } catch { /* ignore */ }
            kp.setApiServer(undefined);
            await server.stop();
        }
    });

    process.removeListener('unhandledRejection', onUnhandled);
    assert.strictEqual(unhandled.length, 0,
        `suite leaked unhandled rejections: ${unhandled.map((e) => e && e.message).join('; ')}`);

    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
    // The provider/DB keep timers alive; exit explicitly.
    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
