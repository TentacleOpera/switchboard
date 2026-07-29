'use strict';

/**
 * Destructive & Convergence Path Tests for Headless Feature Management.
 *
 * Covers:
 *  - reconcileFeatures convergence (add/detach/removeUnmentionedFeatures)
 *  - deleteFeature with deleteSubtasks (true/false) & worktree row abandonment
 *  - removeSubtaskFromFeature (detach subtask, feature-file regen, worktree abandonment)
 *  - splitFeature (split subtasks into two new features, delete original)
 *  - Watcher exclusion with live PlanIngestionEngine
 *  - End-to-end WS board push over real socket
 *  - Hook-route HTTP smoke over LocalApiServer
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const WebSocket = require('ws');

const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
{
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') return require(shimPath);
        return originalLoad.apply(this, arguments);
    };
}

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
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e}`);
        failed++;
    }
}

function createTempWorkspace() {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-feat-destr-')));
    fs.mkdirSync(path.join(tmpDir, '.switchboard', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.switchboard', 'features'), { recursive: true });
    return tmpDir;
}

function createHeadlessProvider(tmpDir) {
    const headlessSeams = {
        pathConfig: {
            workspaceRoot: tmpDir,
            getConfigString: () => '',
            getConfigStringWithDefault: (_, dflt) => dflt,
            getConfigBoolean: (_, dflt) => dflt,
            getConfigNumber: (_, dflt) => dflt,
            getConfigJson: (_, dflt) => dflt,
            updateConfigGlobal: async () => {},
            updateConfigWorkspace: async () => {},
        },
        terminal: { create: () => ({}), findByName: () => null, sendInput: () => false, kill: () => false, resize: () => false, onClose: () => {} },
        commands: { executeCommand: async () => undefined },
        ui: {
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            showModalWarningMessage: async () => undefined,
            showTemporaryNotification: () => {},
            showInputBox: async () => undefined,
            showQuickPick: async () => undefined,
            showOpenDialog: async () => undefined,
            openExternal: async () => {},
            pickFolder: async () => undefined,
            pickFiles: async () => undefined,
        },
        editor: { openTextDocument: async () => {}, showTextDocument: async () => {} },
        secrets: { get: async () => '', store: async () => {}, delete: async () => {} },
        clipboard: { writeText: async () => {}, readText: async () => '' },
        workspace: { getWorkspaceRoots: () => [tmpDir] },
        watcher: { watchFolder: () => ({ dispose: () => {} }), watchFile: () => ({ dispose: () => {} }) },
    };

    const headlessBroadcaster = new BroadcastHub();
    const headlessContext = { extensionUri: { fsPath: repoRoot }, globalState: { get: () => undefined, update: async () => {} }, workspaceState: { get: () => undefined, update: async () => {} } };

    const provider = new KanbanProvider({ fsPath: repoRoot }, headlessContext, undefined, undefined);
    provider._hostSeams = headlessSeams;
    provider._broadcaster = headlessBroadcaster;
    provider._currentWorkspaceRoot = tmpDir;

    return { provider, headlessSeams, headlessBroadcaster };
}

async function run() {
    console.log('\nHeadless Feature Management — Destructive & Convergence Path Tests\n');

    const tmpDir = createTempWorkspace();
    const dbPath = path.join(tmpDir, '.switchboard', 'kanban.db');
    fs.writeFileSync(dbPath, '');
    const db = await KanbanDatabase.forWorkspace(tmpDir, dbPath);
    await db.ensureReady();

    const { provider } = createHeadlessProvider(tmpDir);

    // 1. reconcileFeatures convergence
    await test('reconcileFeatures convergence (add, detach, removeUnmentionedFeatures)', async () => {
        // Create initial plan file & DB row
        const planPath = path.join(tmpDir, '.switchboard', 'plans', 'subtask1.md');
        fs.writeFileSync(planPath, '# Subtask 1\n\n## Goal\nSubtask 1\n');
        await db.insertFileDerivedPlan('subtask1.md', 'Subtask 1', 'CREATED', 0, undefined, 'subtask1');

        const manifest = [
            {
                name: 'Feature Alpha',
                description: 'Alpha feature',
                subtasks: [{ slug: 'subtask1', title: 'Subtask 1' }]
            }
        ];

        const res = await provider.reconcileFeatures(tmpDir, manifest, { removeUnmentionedFeatures: false });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.features.length, 1);
        const featId = res.features[0].featurePlanId;
        assert.ok(featId);

        // Subtask 1 should be linked to Feature Alpha
        const planRow = db.getPlan(res.features[0].subtasks[0].planId);
        assert.strictEqual(planRow.feature_id, featId);

        // Now reconcile with empty subtasks -> detaches subtask1
        const res2 = await provider.reconcileFeatures(tmpDir, [{ name: 'Feature Alpha', subtasks: [] }], { removeUnmentionedFeatures: false });
        assert.strictEqual(res2.success, true);
        const planRow2 = db.getPlan(planRow.plan_id);
        assert.strictEqual(planRow2.feature_id, null);

        // Add second feature Beta, then reconcile with removeUnmentionedFeatures: true without Beta -> removes Beta
        await provider.reconcileFeatures(tmpDir, [{ name: 'Feature Beta', subtasks: [] }], { removeUnmentionedFeatures: false });
        const betaFeatBefore = db.getAllPlans().find(p => p.title === 'Feature Beta' && p.is_feature === 1);
        assert.ok(betaFeatBefore);

        await provider.reconcileFeatures(tmpDir, [{ name: 'Feature Alpha', subtasks: [] }], { removeUnmentionedFeatures: true });
        const betaFeatAfter = db.getAllPlans().find(p => p.title === 'Feature Beta' && p.is_feature === 1);
        assert.strictEqual(betaFeatAfter, undefined);
    });

    // 2. deleteFeature with deleteSubtasks (false vs true)
    await test('deleteFeature detached subtasks vs deleteSubtasks=true', async () => {
        // Create Feature with subtask
        const res = await provider.handleServiceVerb('createFeature', { name: 'Delete Test Feature 1' });
        const featId = res.featurePlanId;
        const subFile = path.join(tmpDir, '.switchboard', 'plans', 'del-sub1.md');
        fs.writeFileSync(subFile, '# Del Sub 1\n\n## Goal\nTest\n');
        await db.insertFileDerivedPlan('del-sub1.md', 'Del Sub 1', 'CREATED', 0, featId, 'del-sub1');
        const subPlan = db.getAllPlans().find(p => p.plan_slug === 'del-sub1');

        // Delete feature without deleting subtasks
        const delRes = await provider.handleServiceVerb('deleteFeature', { featurePlanId: featId, deleteSubtasks: false });
        assert.strictEqual(delRes.success, true);
        assert.strictEqual(db.getPlan(featId), undefined);
        const subPlanAfter = db.getPlan(subPlan.plan_id);
        assert.ok(subPlanAfter);
        assert.strictEqual(subPlanAfter.feature_id, null);

        // Create Feature 2 with subtask and worktree row
        const res2 = await provider.handleServiceVerb('createFeature', { name: 'Delete Test Feature 2' });
        const featId2 = res2.featurePlanId;
        await db.insertFileDerivedPlan('del-sub2.md', 'Del Sub 2', 'CREATED', 0, featId2, 'del-sub2');
        const subPlan2 = db.getAllPlans().find(p => p.plan_slug === 'del-sub2');

        const wtId = db.addWorktree('wt-branch', path.join(tmpDir, 'wt-path'), featId2, undefined, subPlan2.plan_id);
        assert.ok(wtId);

        // Delete feature with deleteSubtasks = true
        const delRes2 = await provider.handleServiceVerb('deleteFeature', { featurePlanId: featId2, deleteSubtasks: true });
        assert.strictEqual(delRes2.success, true);
        assert.strictEqual(db.getPlan(featId2), undefined);
        assert.strictEqual(db.getPlan(subPlan2.plan_id), undefined);

        // Check worktree status turned abandoned
        const wts = db.getWorktrees();
        const wtRow = wts.find(w => w.id === wtId);
        assert.ok(wtRow);
        assert.strictEqual(wtRow.status, 'abandoned');
    });

    // 3. removeSubtaskFromFeature
    await test('removeSubtaskFromFeature detaches subtask & abandons worktree', async () => {
        const res = await provider.handleServiceVerb('createFeature', { name: 'Remove Subtask Test' });
        const featId = res.featurePlanId;
        await db.insertFileDerivedPlan('rem-sub1.md', 'Rem Sub 1', 'CREATED', 0, featId, 'rem-sub1');
        const subPlan = db.getAllPlans().find(p => p.plan_slug === 'rem-sub1');

        const wtId = db.addWorktree('rem-wt-branch', path.join(tmpDir, 'rem-wt-path'), featId, undefined, subPlan.plan_id);

        const remRes = await provider.handleServiceVerb('removeSubtaskFromFeature', { featurePlanId: featId, subtaskPlanId: subPlan.plan_id });
        assert.strictEqual(remRes.success, true);

        const subPlanAfter = db.getPlan(subPlan.plan_id);
        assert.strictEqual(subPlanAfter.feature_id, null);

        const wtRow = db.getWorktrees().find(w => w.id === wtId);
        assert.strictEqual(wtRow.status, 'abandoned');
    });

    // 4. splitFeature
    await test('splitFeature splits subtasks into new features', async () => {
        const res = await provider.handleServiceVerb('createFeature', { name: 'Split Original' });
        const featId = res.featurePlanId;

        await db.insertFileDerivedPlan('split1.md', 'Split 1', 'CREATED', 0, featId, 'split1');
        await db.insertFileDerivedPlan('split2.md', 'Split 2', 'CREATED', 0, featId, 'split2');
        const sub1 = db.getAllPlans().find(p => p.plan_slug === 'split1');
        const sub2 = db.getAllPlans().find(p => p.plan_slug === 'split2');

        const splitRes = await provider.splitFeature(tmpDir, featId, [
            { name: 'Split New A', subtaskPlanIds: [sub1.plan_id] },
            { name: 'Split New B', subtaskPlanIds: [sub2.plan_id] }
        ]);
        assert.strictEqual(splitRes.success, true);

        // Original feature deleted
        assert.strictEqual(db.getPlan(featId), undefined);

        // New features created
        const sub1After = db.getPlan(sub1.plan_id);
        const sub2After = db.getPlan(sub2.plan_id);
        assert.ok(sub1After.feature_id);
        assert.ok(sub2After.feature_id);
        assert.notStrictEqual(sub1After.feature_id, sub2After.feature_id);
    });

    // 5. Watcher exclusion with live PlanIngestionEngine
    await test('Watcher exclusion suppresses re-import of feature file as plain plan', async () => {
        const getService = () => null;
        const host = {
            workspaceRoot: tmpDir,
            config: { getConfigJson: () => null, getConfigString: () => '' },
            extraRoots: [],
            log: () => {}
        };
        const engine = new PlanIngestionEngine(getService, getService, host, getService);
        engine.setFeatureColumnRecomputer((f, r) => provider.recomputeFeatureColumnFromSubtasks(f, r));
        engine.setFeatureFileRegenerator((w, f) => provider.regenerateFeatureFile(w, f));

        let ingestedPlans = [];
        engine.subscribe((plans) => { ingestedPlans.push(...plans); });
        await engine.initialize();

        // Create feature through provider
        const featRes = await provider.handleServiceVerb('createFeature', { name: 'Watcher Exclusion Feature' });
        assert.strictEqual(featRes.success, true);

        // Poll DB for duplicate non-feature plan row for feature file
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 100));
        }

        const allPlans = db.getAllPlans();
        const featFilePlans = allPlans.filter(p => p.plan_file.includes('watcher-exclusion-feature'));
        assert.strictEqual(featFilePlans.length, 1);
        assert.strictEqual(featFilePlans[0].is_feature, 1);
    });

    // 6. E2E WS board push & HTTP hook route smoke over LocalApiServer
    await test('End-to-end WS board push and HTTP hook-route smoke', async () => {
        const hooks = {
            createFeature: async (req) => provider.handleServiceVerb('createFeature', req),
            assignToFeature: async () => ({ success: true, assigned: [], skipped: [] }),
            removeSubtaskFromFeature: async (req) => provider.handleServiceVerb('removeSubtaskFromFeature', req),
            deleteFeature: async (req) => provider.handleServiceVerb('deleteFeature', req),
            splitFeature: async () => ({ success: true }),
            reconcileFeatures: async () => ({ success: true })
        };

        const server = new LocalApiServer({
            port: 0,
            workspaceRoot: tmpDir,
            getAuthToken: async () => 'test-token',
            hooks,
            kanbanVerb: async (verb, payload) => provider.handleServiceVerb(verb, payload)
        });

        provider.setApiServer(server);
        await server.start();
        const port = server.getPort();

        // WS Connection
        const wsUrl = `ws://127.0.0.1:${port}/ws?token=test-token`;
        const ws = new WebSocket(wsUrl);

        const wsPushes = [];
        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
            ws.on('message', (msg) => {
                try {
                    wsPushes.push(JSON.parse(msg.toString()));
                } catch (_) {}
            });
        });

        // Trigger createFeature -> should push full state frame on WS socket
        const createRes = await provider.handleServiceVerb('createFeature', { name: 'WS Push Feature' });
        assert.strictEqual(createRes.success, true);

        const deadline = Date.now() + 2000;
        while (wsPushes.length === 0 && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 100));
        }

        assert.ok(wsPushes.length > 0, 'Should have received WS board update push frame');
        ws.close();

        // HTTP hook route smoke
        const http = require('http');
        const postData = JSON.stringify({ name: 'HTTP Hook Feature' });
        const httpRes = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: '/kanban/feature',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-token',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
            });
            req.on('error', reject);
            req.write(postData);
            req.end();
        });

        assert.strictEqual(httpRes.statusCode, 200);
        assert.strictEqual(httpRes.body.success, true);
        assert.ok(httpRes.body.featurePlanId);

        await server.stop();
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
