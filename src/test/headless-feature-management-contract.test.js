'use strict';

/**
 * Contract tests for the Headless Feature Management feature
 * (browser-surface-verb-failures.md + capability-gate-feature-management.md +
 *  wire-feature-management-standalone.md).
 *
 * Covers the load-bearing contracts from all three plans:
 *  - hasFeatureManagement() derives from ALL SIX LocalApiServerOptions hooks —
 *    any single missing hook reports false (an overstating flag turns a dead
 *    control into a lying one)
 *  - DEFAULT_HOST_CAPABILITIES is fail-closed: a caps object with no
 *    featureManagement key serialises into data-host-capabilities as
 *    featureManagement:false
 *  - kanban verb schemas for createFeature / promoteToFeature /
 *    addSubtaskToFeature are live at dispatch AND field-accurate (require only
 *    what the arms dereference — over-strictness is a shipped-install
 *    regression, PRD contract #5)
 *  - standalone construction smoke: KanbanProvider constructs under the
 *    vscodeShim mapping the way bootstrap.ts constructs it, with seams /
 *    broadcaster / workspace root assigned post-construction, and
 *    handleServiceVerb dispatches with allowlist + schema enforcement
 *  - createFeature returns data in-body (featurePlanId), blank-feature
 *    contract holds (zero plan ids still succeeds)
 *  - promoteToFeature PROMOTES (same planId, file moved to
 *    .switchboard/features/<slug>-<planId>.md, is_feature=1) — it does not
 *    create a second feature row (regression guard for the superseded
 *    normalise-to-createFeature proposal)
 *  - source contracts: transport.js keys failure detection on
 *    `result.success === false` strictly, never dispatches an UNTYPED failure
 *    body onward, renders via textContent (no innerHTML); the capability
 *    gating block disables #btn-feature-action; kanban.html's
 *    updateFeatureActionButton re-enable guard sits after the three leading
 *    calls and the !btn guard; both hosts' base capability literals omit
 *    featureManagement (late-bound reads only).
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Map `vscode` to the compiled standalone shim — the same aliasing webpack
// applies when bundling the npx host, so the provider constructed here takes
// the exact code path src/standalone/bootstrap.ts takes. (Deliberately NOT the
// verb-engine trap: this feature's contract is "runs under the shim", and the
// trap would fault the constructor's legitimate shim-covered vscode surface.)
const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
{
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') return require(shimPath);
        return originalLoad.apply(this, arguments);
    };
}

// Same pre-existing gap as cross-client-scope-contract.test.js: tsc does not
// emit hand-written .js sources, so copy the derivation impl into out/.
{
    const implSrc = path.join(__dirname, '..', 'services', 'kanbanColumnDerivationImpl.js');
    const implOut = path.join(__dirname, '..', '..', 'out', 'services', 'kanbanColumnDerivationImpl.js');
    if (fs.existsSync(implSrc) && !fs.existsSync(implOut)) {
        fs.copyFileSync(implSrc, implOut);
    }
}

const { LocalApiServer } = require('../../out/services/LocalApiServer');
const { validateVerbPayload } = require('../../out/services/verbSchemas');
const { getBoardHtml } = require('../../out/services/headlessPanelHtml');
const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const { BroadcastHub } = require('../../out/services/broadcastHub');

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

const SIX_HOOKS = {
    createFeature: async () => ({ success: true }),
    assignToFeature: async () => ({ success: true, assigned: [], skipped: [] }),
    removeSubtaskFromFeature: async () => ({ success: true }),
    deleteFeature: async () => ({ success: true }),
    splitFeature: async () => ({ success: true }),
    reconcileFeatures: async () => ({ success: true }),
};

function capsFromHtml(html) {
    const m = /data-host-capabilities="([^"]*)"/.exec(html);
    assert.ok(m, 'data-host-capabilities attribute not found in board HTML');
    return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

async function main() {
    console.log('\n── hasFeatureManagement(): all-six derivation ──');

    await test('all six hooks supplied → true', () => {
        const server = new LocalApiServer({ ...SIX_HOOKS });
        assert.strictEqual(server.hasFeatureManagement(), true);
    });

    for (const hook of Object.keys(SIX_HOOKS)) {
        await test(`missing ${hook} alone → false`, () => {
            const opts = { ...SIX_HOOKS };
            delete opts[hook];
            const server = new LocalApiServer(opts);
            assert.strictEqual(server.hasFeatureManagement(), false);
        });
    }

    await test('no hooks at all → false', () => {
        const server = new LocalApiServer({});
        assert.strictEqual(server.hasFeatureManagement(), false);
    });

    console.log('\n── DEFAULT_HOST_CAPABILITIES: fail-closed serialisation ──');

    await test('caps object with NO featureManagement key serialises as featureManagement:false', () => {
        const { html } = getBoardHtml(repoRoot, repoRoot, { terminalDispatch: false });
        const caps = capsFromHtml(html);
        assert.strictEqual(caps.featureManagement, false,
            'a host that forgets the flag must gate honestly, not dead-click');
    });

    await test('explicit featureManagement:true survives the default spread', () => {
        const { html } = getBoardHtml(repoRoot, repoRoot, { featureManagement: true });
        const caps = capsFromHtml(html);
        assert.strictEqual(caps.featureManagement, true);
    });

    console.log('\n── kanban verb schemas: live and field-accurate ──');

    await test('createFeature: real webview payload validates', () => {
        const r = validateVerbPayload('kanban', 'createFeature',
            { name: 'F', description: '', subtaskPlanIds: ['a', 'b'], workspaceRoot: '/w' });
        assert.strictEqual(r.ok, true, r.error);
    });

    await test('createFeature: missing name rejected (arm rejects empty names)', () => {
        const r = validateVerbPayload('kanban', 'createFeature', { subtaskPlanIds: [] });
        assert.strictEqual(r.ok, false);
    });

    await test('createFeature: missing subtaskPlanIds accepted (arm defaults to [] — blank-feature contract)', () => {
        const r = validateVerbPayload('kanban', 'createFeature', { name: 'Blank' });
        assert.strictEqual(r.ok, true, r.error);
    });

    await test('promoteToFeature: planId required, name optional (arm falls back to plan.topic)', () => {
        assert.strictEqual(validateVerbPayload('kanban', 'promoteToFeature', { planId: 'p', name: 'N' }).ok, true);
        assert.strictEqual(validateVerbPayload('kanban', 'promoteToFeature', { planId: 'p' }).ok, true);
        assert.strictEqual(validateVerbPayload('kanban', 'promoteToFeature', { name: 'N' }).ok, false);
    });

    await test('addSubtaskToFeature: both session ids required (arm dereferences both)', () => {
        assert.strictEqual(validateVerbPayload('kanban', 'addSubtaskToFeature',
            { featureSessionId: 'f', subtaskSessionId: 's' }).ok, true);
        assert.strictEqual(validateVerbPayload('kanban', 'addSubtaskToFeature', { subtaskSessionId: 's' }).ok, false);
        assert.strictEqual(validateVerbPayload('kanban', 'addSubtaskToFeature', { featureSessionId: 'f' }).ok, false);
    });

    await test('unknown extra fields pass through (permissive contract)', () => {
        const r = validateVerbPayload('kanban', 'createFeature',
            { name: 'F', subtaskPlanIds: [], someFutureField: 1 });
        assert.strictEqual(r.ok, true, r.error);
    });

    console.log('\n── standalone construction smoke + verb dispatch ──');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-headless-fm-'));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });

    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    const memento = () => {
        const m = new Map();
        return {
            get: (k, d) => (m.has(k) ? m.get(k) : d),
            update: async (k, v) => { m.set(k, v); },
            keys: () => Array.from(m.keys()),
        };
    };
    const headlessContext = {
        globalState: memento(),
        workspaceState: memento(),
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
        extensionUri: { fsPath: repoRoot },
        extensionPath: repoRoot,
        subscriptions: [],
    };

    let kp;
    await test('KanbanProvider constructs under the shim (bootstrap.ts shape), no unhandled rejection', async () => {
        kp = new KanbanProvider({ fsPath: repoRoot }, headlessContext, undefined, undefined);
        kp._hostSeams = undefined; // constructor's empty-root bail already cleared these; mirror bootstrap's post-construction assignment
        kp._broadcaster = new BroadcastHub({ webview: null, apiServer: null });
        kp._currentWorkspaceRoot = tmpRoot;
        await new Promise((r) => setTimeout(r, 150));
        assert.strictEqual(unhandled.length, 0,
            `constructor async work leaked a rejection: ${unhandled[0] && unhandled[0].message}`);
    });

    await test('handleServiceVerb: unknown verb is rejected by the allowlist', async () => {
        await assert.rejects(() => kp.handleServiceVerb('definitelyNotAVerb', {}), /Unknown Kanban verb/);
    });

    await test('handleServiceVerb: schema validation is LIVE in standalone (missing name rejected at dispatch)', async () => {
        await assert.rejects(
            () => kp.handleServiceVerb('createFeature', { subtaskPlanIds: [], workspaceRoot: tmpRoot }),
            /Invalid payload for Kanban verb 'createFeature'/
        );
    });

    // The database must exist on disk before ensureReady() can initialise it —
    // KanbanDatabase deliberately never auto-creates kanban.db (scaffold-litter
    // policy). Mirror bootstrap.ts's own seeding exactly.
    {
        const seedDb = KanbanDatabase.forWorkspace(tmpRoot);
        const dbDir = path.dirname(seedDb.dbPath);
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        if (!fs.existsSync(seedDb.dbPath)) fs.writeFileSync(seedDb.dbPath, Buffer.alloc(0));
        assert.ok(await seedDb.ensureReady(), 'seeded kanban.db must initialise');
    }

    let blankFeatureId;
    await test('createFeature returns data in-body: blank feature (zero plan ids) succeeds with featurePlanId', async () => {
        const r = await kp.handleServiceVerb('createFeature',
            { name: 'Headless Contract Feature', subtaskPlanIds: [], workspaceRoot: tmpRoot });
        assert.strictEqual(r.success, true, r.error);
        assert.ok(r.featurePlanId, 'body must carry featurePlanId, not a bare ack');
        blankFeatureId = r.featurePlanId;
        const files = fs.readdirSync(path.join(tmpRoot, '.switchboard', 'features'));
        assert.ok(files.some((f) => f.includes(blankFeatureId)),
            `feature file for ${blankFeatureId} not written; dir has: ${files.join(', ')}`);
    });

    await test('promoteToFeature PROMOTES the same plan (file moved, is_feature=1, no second row)', async () => {
        const db = KanbanDatabase.forWorkspace(tmpRoot);
        assert.ok(await db.ensureReady(), 'kanban db must open in the temp workspace');
        const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'contract-ws';
        const planRel = '.switchboard/plans/promote-me.md';
        fs.writeFileSync(path.join(tmpRoot, planRel), '# Promote Me\n\nBody.\n', 'utf8');
        const now = new Date().toISOString();
        await db.insertFileDerivedPlan({
            planId: 'contract-promote-1',
            sessionId: 'contract-promote-1',
            topic: 'Promote Me',
            planFile: planRel,
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: 3,
            tags: '',
            project: '',
            workspaceId: wsId,
            createdAt: now,
            updatedAt: now,
            sourceType: 'file',
            workspaceName: 'contract',
            isFeature: 0,
        });

        const r = await kp.handleServiceVerb('promoteToFeature',
            { planId: 'contract-promote-1', name: 'Promoted Feature', workspaceRoot: tmpRoot });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.planId, 'contract-promote-1',
            'promotion must keep the SAME planId — a new id means it created instead of promoting');

        const row = await db.getPlanByPlanId('contract-promote-1');
        assert.ok(row, 'promoted row still exists');
        assert.ok(row.isFeature, 'is_feature must flip on the same row');
        // plan_file is stored relative and resolved to absolute at read time —
        // assert the features/ segment, not the prefix.
        assert.ok(String(row.planFile).replace(/\\/g, '/').includes('.switchboard/features/'),
            `plan_file must move under features/: ${row.planFile}`);
        assert.ok(!fs.existsSync(path.join(tmpRoot, planRel)), 'old plan file must be moved, not copied');
        const featureFiles = fs.readdirSync(path.join(tmpRoot, '.switchboard', 'features'))
            .filter((f) => f.includes('contract-promote-1'));
        assert.strictEqual(featureFiles.length, 1,
            `exactly one feature file for the promoted plan, got: ${featureFiles.join(', ')}`);
    });

    await test('recompute resolves the feature column through CUSTOM columns (the mirror\'s hardcoded map could not)', async () => {
        // The deleted mirror built its ordinal map from DEFAULT_KANBAN_COLUMNS, so a
        // subtask sitting in a custom column scored Infinity and sorted LAST. The
        // real provider builds ordinals from the workspace's custom columns, so the
        // custom lane sorts at its configured position. Placing the custom column
        // at order 150 puts it BEFORE 'LEAD CODED' (order 180): the provider must
        // resolve the feature to the CUSTOM column, whereas the mirror would have
        // resolved 'LEAD CODED'. Asserting the custom id is therefore a result the
        // mirror provably cannot produce.
        const CUSTOM_ID = 'custom_column_triage';
        const db = KanbanDatabase.forWorkspace(tmpRoot);
        assert.ok(await db.ensureReady());
        const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'contract-ws';

        // Custom columns live in the DB `config` table under 'kanban.customColumns'.
        // Writing a real .switchboard/state.json would NOT work: `stateFs` is a
        // façade that transparently redirects every state.json read to
        // db.getConfigJsonSync (stateConfigBridge.ts), so an on-disk file is
        // ignored entirely. Seed the blessed store.
        await db.setConfigJson('kanban.customColumns', [{
            id: CUSTOM_ID,
            label: 'Triage',
            role: 'coder',
            triggerPrompt: 'Triage it.',
            order: 150,
            dragDropMode: 'cli',
        }]);
        assert.deepStrictEqual(
            (await kp._getCustomKanbanColumns(tmpRoot)).map((c) => c.id), [CUSTOM_ID],
            'precondition: the provider must actually see the seeded custom column');

        const feat = await kp.handleServiceVerb('createFeature',
            { name: 'Custom Column Recompute', subtaskPlanIds: [], workspaceRoot: tmpRoot });
        assert.strictEqual(feat.success, true, feat.error);
        const featId = feat.featurePlanId;

        const seedSub = async (planId, slug, column) => {
            const rel = `.switchboard/plans/${slug}.md`;
            fs.writeFileSync(path.join(tmpRoot, rel), `# ${slug}\n\nBody.\n`, 'utf8');
            const now = new Date().toISOString();
            await db.insertFileDerivedPlan({
                planId, sessionId: planId, topic: slug, planFile: rel,
                kanbanColumn: column, status: 'active', complexity: '3', tags: '',
                project: '', workspaceId: wsId, createdAt: now, updatedAt: now,
                sourceType: 'local', workspaceName: 'contract', isFeature: 0,
            });
            // feature_id is NOT in insertFileDerivedPlan's column list — link it
            // through the real primitive or the subtask is an orphan.
            assert.ok(await db.updateFeatureStatus(planId, 0, featId), `link ${slug}`);
            // insertFileDerivedPlan CLAMPS an unrecognised column to 'CREATED', so a
            // custom lane never survives the insert. Set it explicitly (relative
            // path — updateColumnByPlanFile keys on the stored relative plan_file).
            assert.ok(await db.updateColumnByPlanFile(rel, wsId, column), `set column for ${slug}`);
            assert.strictEqual((await db.getPlanByPlanId(planId)).kanbanColumn, column,
                `precondition: ${slug} must actually sit in ${column}`);
        };
        await seedSub('contract-custom-1', 'custom-sub-1', CUSTOM_ID);
        await seedSub('contract-custom-2', 'custom-sub-2', 'LEAD CODED');

        // Precondition: the recompute only heals a feature still sitting in CREATED.
        assert.strictEqual((await db.getPlanByPlanId(featId)).kanbanColumn, 'CREATED');

        await kp.recomputeFeatureColumnFromSubtasks(featId, tmpRoot);

        assert.strictEqual((await db.getPlanByPlanId(featId)).kanbanColumn, CUSTOM_ID,
            'feature must resolve to the CUSTOM column — resolving "LEAD CODED" means the '
            + 'hardcoded DEFAULT_KANBAN_COLUMNS map is back in the recompute path');
    });

    process.removeListener('unhandledRejection', onUnhandled);

    console.log('\n── source contracts: transport failure surfacing ──');

    const transportSrc = fs.readFileSync(path.join(repoRoot, 'src', 'webview', 'transport.js'), 'utf8');
    const kanbanHtml = fs.readFileSync(path.join(repoRoot, 'src', 'webview', 'kanban.html'), 'utf8');
    const taskViewerSrc = fs.readFileSync(path.join(repoRoot, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
    const bootstrapSrc = fs.readFileSync(path.join(repoRoot, 'src', 'standalone', 'bootstrap.ts'), 'utf8');

    await test('failure detection keys on result.success === false STRICTLY (never truthiness)', () => {
        assert.ok(transportSrc.includes('result.success === false'),
            'strict-equality failure branch missing');
        assert.ok(!/!result\.success\b/.test(transportSrc),
            '`!result.success` would misclassify every data-returning read verb as a failure');
    });

    await test('kanban failures dispatch showStatusMessage with isError; other panels get the fallback toast', () => {
        assert.ok(/STATUS_MESSAGE_PANELS\s*=\s*\{\s*kanban:\s*true\s*\}/.test(transportSrc));
        assert.ok(/type:\s*'showStatusMessage',\s*message:\s*text,\s*isError:\s*true/.test(transportSrc));
        assert.ok(transportSrc.includes('showTransportError(text)'));
        assert.ok(transportSrc.includes("'sb-transport-error'"));
    });

    await test('an UNTYPED failure body is never re-dispatched (the phantom-MessageEvent bug)', () => {
        assert.ok(/typeof result\.type !== 'string'/.test(transportSrc),
            'untyped failures must stop at the surface branch; typed failures fall through to their panel handler');
    });

    await test('fallback renderer uses textContent only — no innerHTML anywhere in transport.js', () => {
        assert.ok(transportSrc.includes('host.textContent = text'));
        assert.ok(!transportSrc.includes('innerHTML'),
            'server-supplied error strings must stay inert');
    });

    await test('kanban.html showStatusMessage handler renders through showStatusBarMessage with isError', () => {
        assert.ok(/case 'showStatusMessage':\s*\{\s*\n\s*showStatusBarMessage\(msg\.message \|\| '', \{ isError: !!msg\.isError \}\);/.test(kanbanHtml));
    });

    console.log('\n── source contracts: capability gating ──');

    await test('transport gating: featureManagement === false disables #btn-feature-action with tooltip', () => {
        assert.ok(transportSrc.includes('caps.featureManagement === false'));
        assert.ok(transportSrc.includes("classList.add('host-feature-management-false')"));
        assert.ok(/getElementById\('btn-feature-action'\)/.test(transportSrc));
        const gatingBlock = transportSrc.slice(transportSrc.indexOf('caps.featureManagement === false'));
        assert.ok(/btn\.disabled = true/.test(gatingBlock));
        assert.ok(/data-tooltip/.test(gatingBlock));
    });

    await test('updateFeatureActionButton guard: after the three leading calls and !btn, before selection logic', () => {
        const fnIdx = kanbanHtml.indexOf('function updateFeatureActionButton()');
        assert.ok(fnIdx > 0, 'updateFeatureActionButton not found');
        const body = kanbanHtml.slice(fnIdx, fnIdx + 1600);
        const order = [
            'recomputeWorktreeIndicator()',
            'updateCreateWorktreeButton()',
            'updateManagerPassButton()',
            'if (!btn) return;',
            "host-feature-management-false",
            'const selected = Array.from(selectedCards.values());',
        ];
        let last = -1;
        for (const marker of order) {
            const idx = body.indexOf(marker);
            assert.ok(idx > last,
                `guard ordering broken at '${marker}' — the capability guard must not pre-empt the worktree/manager-pass recomputes, and must pre-empt selection-based re-enable`);
            last = idx;
        }
    });

    await test('extension host: base capability literal omits featureManagement; three late-bound reads', () => {
        const litIdx = taskViewerSrc.indexOf('const baseHostCapabilities = {');
        assert.ok(litIdx > 0);
        const literal = taskViewerSrc.slice(litIdx, taskViewerSrc.indexOf('};', litIdx));
        assert.ok(!literal.includes('featureManagement'),
            'featureManagement in the base literal is evaluated before the server exists — it would disable the button in VS Code');
        const reads = taskViewerSrc.match(/featureManagement:\s*this\._localApiServer\?\.hasFeatureManagement\(\)\s*\?\?\s*false/g) || [];
        assert.strictEqual(reads.length, 3, `expected 3 per-request reads (board/project/panel getters), got ${reads.length}`);
    });

    await test('standalone host: base literal omits featureManagement; getStandaloneCaps reads the live server binding', () => {
        const litIdx = bootstrapSrc.indexOf('const baseStandaloneCapabilities');
        assert.ok(litIdx > 0);
        const literal = bootstrapSrc.slice(litIdx, bootstrapSrc.indexOf('};', litIdx));
        assert.ok(!literal.includes('featureManagement'));
        assert.ok(/featureManagement:\s*server\?\.hasFeatureManagement\(\)\s*\?\?\s*false/.test(bootstrapSrc));
        const serverDecl = bootstrapSrc.indexOf('let server: LocalApiServer');
        const capsFn = bootstrapSrc.indexOf('const getStandaloneCaps');
        assert.ok(serverDecl > 0 && serverDecl < capsFn,
            '`let server` must be declared before getStandaloneCaps closes over it');
    });

    console.log('\n── source contracts: standalone wiring ──');

    await test('bootstrap constructs KanbanProvider, assigns root post-construction, attaches to TaskViewer', () => {
        assert.ok(bootstrapSrc.includes('const kanbanProvider = new KanbanProvider('));
        assert.ok(bootstrapSrc.includes('(kanbanProvider as any)._currentWorkspaceRoot = workspaceRoot'),
            'the shim\'s workspaceFolders is [] — without the explicit root every routed verb throws "Kanban service unavailable"');
        assert.ok(bootstrapSrc.includes('taskViewerProvider.setKanbanProvider(kanbanProvider)'));
        assert.ok(bootstrapSrc.includes('kanbanProvider.setApiServer(server)'));
    });

    await test('the three UI verbs route to the provider\'s real dispatcher and push state', () => {
        const armIdx = bootstrapSrc.indexOf("case 'createFeature':");
        assert.ok(armIdx > 0);
        const arm = bootstrapSrc.slice(armIdx, armIdx + 500);
        assert.ok(arm.includes("case 'promoteToFeature':"));
        assert.ok(arm.includes("case 'addSubtaskToFeature':"));
        assert.ok(arm.includes('kanbanProvider.handleServiceVerb(verb'));
        assert.ok(arm.includes('pushFullState()'), 'a correct DB with a stale board reads as "it didn\'t work"');
    });

    await test('all six LocalApiServerOptions hooks are supplied by bootstrap (503s closed)', () => {
        for (const hook of Object.keys(SIX_HOOKS)) {
            assert.ok(new RegExp(`${hook}:\\s*async`).test(bootstrapSrc), `hook ${hook} not supplied`);
        }
        assert.ok(/assigned:\s*\[\],\s*skipped:\s*\[\]/.test(bootstrapSrc),
            'assignToFeature failure shape must match the extension\'s (callers destructure assigned)');
    });

    await test('ingestion feature callbacks delegate to the REAL provider — the mirror is gone', () => {
        // The headlessFeatureCallbacks.ts mirror reimplemented the provider's
        // recompute/regen against KanbanDatabase because "standalone has no
        // KanbanProvider". That premise died when bootstrap started constructing
        // the real provider; two writers for one feature file is the drift class
        // this pins shut.
        assert.ok(!fs.existsSync(path.join(repoRoot, 'src', 'standalone', 'headlessFeatureCallbacks.ts')),
            'headlessFeatureCallbacks.ts must stay deleted — it is the second feature-file writer');
        assert.ok(!/headlessFeatureCallbacks/.test(bootstrapSrc),
            'bootstrap must not import or reference the deleted mirror');
        assert.ok(!/createHeadlessFeatureColumnRecomputer|createHeadlessFeatureFileRegenerator/.test(bootstrapSrc),
            'the mirror factory calls must be gone, not merely unimported');

        assert.ok(/setFeatureColumnRecomputer\(\s*\n?\s*\(featurePlanId,\s*watchedRoot\)\s*=>\s*kanbanProvider\.recomputeFeatureColumnFromSubtasks\(/.test(bootstrapSrc),
            'setFeatureColumnRecomputer must delegate to kanbanProvider.recomputeFeatureColumnFromSubtasks');
        assert.ok(/setFeatureFileRegenerator\(\s*\n?\s*\(ws,\s*fid\)\s*=>\s*kanbanProvider\.regenerateFeatureFile\(/.test(bootstrapSrc),
            'setFeatureFileRegenerator must delegate to kanbanProvider.regenerateFeatureFile');

        // Ordering: the lambdas close over `const kanbanProvider`, so the setters
        // must sit AFTER its initialiser or the wiring is a TDZ crash on boot.
        const ctorIdx = bootstrapSrc.indexOf('const kanbanProvider = new KanbanProvider(');
        const recomputeIdx = bootstrapSrc.indexOf('ingestionEngine.setFeatureColumnRecomputer(');
        const regenIdx = bootstrapSrc.indexOf('ingestionEngine.setFeatureFileRegenerator(');
        assert.ok(ctorIdx > -1 && recomputeIdx > -1 && regenIdx > -1, 'all three landmarks must be present');
        assert.ok(recomputeIdx > ctorIdx && regenIdx > ctorIdx,
            'feature-callback setters must come AFTER the provider const initialises (no TDZ path)');
    });

    // ── summary ──────────────────────────────────────────────────────────────
    console.log(`\n${passed} passed, ${failed} failed`);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp dir */ }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
