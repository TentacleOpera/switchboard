'use strict';

/**
 * A prerequisite outside the feature is the Navigator's problem
 * (plan: a-prerequisite-outside-the-feature-is-the-navigators-problem).
 *
 * The plan was written from a live incident (2026-09-22). The lead of feature
 * `cb1ea29b` reached round 3, read its own feature file, and found that a subtask
 * named a prerequisite that was not one of the feature's subtasks. It detected
 * the hazard, refused to guess, held the subtask, and asked the operator — who
 * then dispatched the prerequisite by hand. That cost an operator turn, a stalled
 * subtask and an idle seat. This pass removes that intervention.
 *
 * The crux, and the reason an edge alone is not the fix: `plan_dependencies`
 * gates the queue POP via `isDependencyReady`. A lead driving a feature MANUALLY
 * — polling terminal state and dispatching with `ptySendPrompt` — never pops, so
 * `isDependencyReady` is never consulted and an edge would sit in the table
 * unread by the very caller that was blocked. The intervention is therefore the
 * DISPATCH, which is a board action needing no cooperation from the lead; the
 * edge is written as well, as the durable record and the gate for callers that
 * do pop. Neither half substitutes for the other.
 *
 * Fences this suite holds:
 *  - **Nothing is sent to the lead.** No question, no notice, no relay. The pass
 *    is board actions plus a report, and nothing else.
 *  - **A match is exact or it is reported.** A reference resolving to two cards,
 *    or to a card no single subtask is named beside, writes NOTHING.
 *  - **Three-plus outcomes stay distinct.** `complete`, `exists-unfinished`,
 *    `absent`, `unresolved` and `cycle` are five different situations and none
 *    may render as another. "We could not tell" (an unreadable board) is a sixth
 *    and is `error`, never `absent`.
 *  - **The prose is READ, never authored.** No plan file is written by this pass.
 *  - **The breach is recorded even when resolved**, including when the
 *    prerequisite was already complete.
 *
 * Harness notes (mirrored from navigator-start-contract.test.js — do not
 * "simplify" these): `vscode` → the standalone shim before any out/ require;
 * kanban.db must exist on disk before `ensureReady()`.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:navigator-outside-prerequisites
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// `vscode` → the standalone shim, installed BEFORE any out/services require.
const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
{
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') { return require(shimPath); }
        return originalLoad.apply(this, arguments);
    };
}

const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const { LocalApiServer } = require('../../out/services/LocalApiServer');
const { GlobalIntegrationConfigService } = require('../../out/services/GlobalIntegrationConfigService');
const { createDependencyReadinessSource, isDependencyReady } = require('../../out/services/kanbanOrdering');
const navigator = require('../../out/standalone/controller/navigator');

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e}`);
        failed++;
    }
}

function row(planId, extra = {}) {
    return {
        planId, sessionId: planId, topic: 'topic of ' + planId, kanbanColumn: 'CREATED',
        project: '', isFeature: 0, featureId: '', ownerSince: null, completedAt: null,
        planFile: `/tmp/${planId}.md`, columnOrder: null, ...extra,
    };
}

const FEATURE = row('feat-1', { topic: 'The Feature', isFeature: 1, planFile: '/tmp/feat-1.md' });
const S1 = row('sub-one', { topic: 'Subtask One', featureId: 'feat-1' });
const S2 = row('sub-two', { topic: 'Subtask Two', featureId: 'feat-1' });
const P1 = row('outside-one', { topic: 'Outside Prerequisite', planFile: '/tmp/outside-prerequisite.md' });
const P_DONE = row('outside-done', { topic: 'Already Done Outside', planFile: '/tmp/already-done-outside.md', completedAt: '2026-09-21T00:00:00.000Z' });
const DUP_A = row('dup-a', { topic: 'Duplicate Name', planFile: '/tmp/dup-a.md' });
const DUP_B = row('dup-b', { topic: 'Duplicate Name', planFile: '/tmp/dup-b.md' });

/** Fake ports for the capability's own contract. */
function fakePorts(opts = {}) {
    const writes = { edges: [], dispatched: [], reports: [] };
    const board = opts.board || [FEATURE, S1, S2, P1];
    return {
        writes,
        ports: {
            listPlans: async () => {
                if (opts.boardThrows) { throw new Error('the board read blew up'); }
                return board;
            },
            navigatorModel: async () => (opts.unconfigured
                ? { error: 'Agent-control config could not be read (config may be corrupt).' }
                : { providerId: 'stubnav', endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'stub-model', apiKey: null, source: 'row:navigator' }),
            readFeature: async () => (opts.feature === undefined ? FEATURE : opts.feature),
            readSubtasks: async () => opts.subtasks || [S1, S2],
            readPlanBody: async () => opts.body || '',
            readDependencies: async (planIds) => {
                const out = {};
                for (const id of planIds) { out[id] = (opts.deps && opts.deps[id]) || []; }
                return out;
            },
            writeDependencies: async (input) => {
                writes.edges.push(input);
                return opts.writeDeps ? opts.writeDeps(input) : { ok: true };
            },
            dispatchCard: async (input) => {
                writes.dispatched.push(input);
                return opts.dispatch ? opts.dispatch(input) : { status: 200, payload: { success: true, delivery: 'delivered' } };
            },
            recordPrerequisiteProvenance: async (entry) => { writes.reports.push(entry); return { ok: true, written: true }; },
            now: () => '2026-09-22T07:00:00.000Z',
        },
    };
}

const SECTION = '## Dependencies & sequencing\n\n';

async function run() {
    console.log('\nA prerequisite outside the feature is the Navigator\'s problem\n');

    // ══ The capability's own contract ══════════════════════════════════════

    await test('an unfinished outside prerequisite gets an edge written AND is dispatched', async () => {
        const h = fakePorts({
            body: `# The Feature\n\n${SECTION}- **Subtask One** needs the standalone card \`outside-prerequisite.md\`, which is not one of its subtasks.\n`,
        });
        const outcome = await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, h.ports);
        assert.strictEqual(outcome.kind, 'resolved', JSON.stringify(outcome).slice(0, 600));
        assert.strictEqual(outcome.resolutions.length, 1);
        const r = outcome.resolutions[0];
        assert.strictEqual(r.outcome, 'exists-unfinished');
        assert.strictEqual(r.dependentId, 'sub-one');
        assert.strictEqual(r.prerequisiteId, 'outside-one');
        assert.deepStrictEqual(h.writes.edges, [{ planId: 'sub-one', dependsOn: ['outside-one'], mapFingerprint: h.writes.edges[0].mapFingerprint }],
            'the edge is written from the dependent subtask to the prerequisite');
        assert.ok(h.writes.edges[0].mapFingerprint, 'the write carries a fingerprint, as the parameters pass\'s does');
        assert.deepStrictEqual(h.writes.dispatched, [{ planId: 'outside-one' }],
            'the prerequisite is DISPATCHED — the edge alone is unread by a lead that never pops');
        assert.strictEqual(outcome.modelId, 'stubnav (stub-model)', 'the author of record is tagged');
        assert.ok(/row:navigator/.test(outcome.authorSource), outcome.authorSource);
    });

    await test('the intervention does not depend on a queue pop occurring', async () => {
        // No queue exists in this harness at all — the pass must still dispatch.
        // This is the case the plan was written from: a lead driving by hand never
        // pops, so a fix that only writes edges leaves it blocked.
        const h = fakePorts({
            body: `# The Feature\n\n${SECTION}- **Subtask One** needs the standalone card \`outside-prerequisite.md\`.\n`,
        });
        await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, h.ports);
        assert.strictEqual(h.writes.dispatched.length, 1,
            'the dispatch happens with no pop anywhere in the picture');
        const src = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'controller', 'navigator.ts'), 'utf8');
        const block = src.slice(src.indexOf('export async function resolveOutsidePrerequisites'));
        assert.ok(/dispatchCard/.test(block), 'the pass names the dispatch seam');
        assert.ok(!/dispatchNextFromQueue/.test(src),
            'the pass must not reach for the queue pop — that is the path the blocked lead never took');
        assert.ok(!/ptySendPrompt|sendPrompt/.test(block),
            'nothing is sent to the lead — not a question, not a notice, not a relay');
    });

    await test('a two-candidate match writes ZERO edges and is reported unresolved', async () => {
        const h = fakePorts({
            board: [FEATURE, S1, S2, P1, DUP_A, DUP_B],
            body: `# The Feature\n\n${SECTION}- **Subtask One** needs the standalone card \`duplicate-name.md\`.\n`,
        });
        const outcome = await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, h.ports);
        const r = outcome.resolutions[0];
        assert.strictEqual(r.outcome, 'unresolved', JSON.stringify(r));
        assert.deepStrictEqual(r.candidates.sort(), ['dup-a', 'dup-b']);
        assert.strictEqual(h.writes.edges.length, 0, 'an approximate match would hold unrelated work out of every pop');
        assert.strictEqual(h.writes.dispatched.length, 0);
    });

    await test('paired positive: an exact single match writes exactly ONE edge', async () => {
        const h = fakePorts({
            board: [FEATURE, S1, S2, P1, DUP_A, DUP_B],
            body: `# The Feature\n\n${SECTION}- **Subtask One** needs the standalone card \`outside-prerequisite.md\`.\n`,
        });
        await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, h.ports);
        assert.strictEqual(h.writes.edges.length, 1);
        assert.deepStrictEqual(h.writes.edges[0].dependsOn, ['outside-one']);
    });

    await test('a reference with no card is ABSENT, distinct from unresolved and from exists-unfinished', async () => {
        const h = fakePorts({
            body: `# The Feature\n\n${SECTION}- **Subtask One** needs the standalone card \`no-such-card.md\`.\n`,
        });
        const outcome = await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, h.ports);
        const r = outcome.resolutions[0];
        assert.strictEqual(r.outcome, 'absent', JSON.stringify(r));
        assert.ok(/nobody has written/.test(r.reason), r.reason);
        assert.strictEqual(outcome.kind, 'partial', 'an absent prerequisite is never presented as resolved');
        assert.strictEqual(h.writes.edges.length, 0);
        assert.strictEqual(h.writes.dispatched.length, 0);
        // And the three strings are visibly different.
        const absent = navigator.outsidePrerequisiteMessage(outcome);
        const unfinished = navigator.outsidePrerequisiteMessage({
            ...outcome,
            resolutions: [{ ...r, outcome: 'exists-unfinished', prerequisiteId: 'outside-one', prerequisiteTitle: 'Outside Prerequisite', edgeWritten: true, dispatched: true, dispatchOutcome: 'delivered' }],
        });
        const unresolved = navigator.outsidePrerequisiteMessage({
            ...outcome,
            resolutions: [{ ...r, outcome: 'unresolved', candidates: ['a', 'b'], reason: 'two cards' }],
        });
        assert.notStrictEqual(absent, unfinished);
        assert.notStrictEqual(absent, unresolved);
        assert.ok(/ABSENT/.test(absent) && /UNRESOLVED/.test(unresolved), `${absent} | ${unresolved}`);
    });

    await test('a card no single subtask is named beside is unresolved, and nothing is written', async () => {
        // The table-row shape: the prose names the card but attributes it to no
        // subtask. Guessing a dependent writes an edge onto work that may not
        // depend on it, so this is reported rather than resolved.
        const h = fakePorts({
            body: `# The Feature\n\n${SECTION}### The contended surface\n\n`
                + '| Plan | Touches |\n|---|---|\n'
                + '| *(standalone)* `outside-prerequisite.md` | removes a rule another plan also edits |\n',
        });
        const outcome = await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, h.ports);
        assert.strictEqual(outcome.resolutions.length, 1, JSON.stringify(outcome.resolutions));
        const r = outcome.resolutions[0];
        assert.strictEqual(r.outcome, 'unresolved', JSON.stringify(r));
        assert.strictEqual(r.dependentId, '', 'no subtask is attributed — and none is guessed');
        assert.deepStrictEqual(r.candidates, ['outside-one'], 'the one card it DID find travels with the report');
        assert.strictEqual(r.prerequisiteId, '', 'an unresolved reference is not presented as resolved');
        assert.ok(/names no single subtask/.test(r.reason), r.reason);
        assert.strictEqual(outcome.kind, 'partial', 'and neither is the pass as a whole');
        assert.strictEqual(h.writes.edges.length, 0);
        assert.strictEqual(h.writes.dispatched.length, 0);
    });

    await test('an edge that would close a cycle across the union is refused and NOTHING is written', async () => {
        // The prerequisite already depends on the dependent, so the new edge
        // closes a loop through a card the parameters pass never examined.
        const h = fakePorts({
            body: `# The Feature\n\n${SECTION}- **Subtask One** needs the standalone card \`outside-prerequisite.md\`.\n`,
            deps: { 'outside-one': ['sub-one'] },
        });
        const outcome = await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, h.ports);
        const r = outcome.resolutions[0];
        assert.strictEqual(r.outcome, 'cycle', JSON.stringify(r));
        assert.ok(/cycle/.test(r.reason), r.reason);
        assert.strictEqual(h.writes.edges.length, 0, 'nothing is written — not the edge, and not the dispatch');
        assert.strictEqual(h.writes.dispatched.length, 0);
        assert.strictEqual(outcome.kind, 'partial', 'a refused resolution is never presented as resolved');
    });

    await test('a feature with no outside prerequisites writes no edges and one `none-found` entry', async () => {
        const h = fakePorts({
            body: `# The Feature\n\n${SECTION}- **Subtask One** lands before **Subtask Two**.\n- Subtasks are independent otherwise.\n`,
        });
        const outcome = await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, h.ports);
        assert.strictEqual(outcome.kind, 'none-found', JSON.stringify(outcome).slice(0, 400));
        assert.deepStrictEqual(outcome.resolutions, []);
        assert.strictEqual(h.writes.edges.length, 0);
        assert.strictEqual(h.writes.dispatched.length, 0);
        assert.strictEqual(h.writes.reports.length, 1,
            'an empty list is a CLAIM and it needs a source — one entry, tagged none-found');
        assert.strictEqual(h.writes.reports[0].outcome, 'none-found');
        assert.strictEqual(h.writes.reports[0].authoringBreach, false);
    });

    await test('every resolution records the authoring breach, including one already complete', async () => {
        const h = fakePorts({
            board: [FEATURE, S1, S2, P1, P_DONE],
            body: `# The Feature\n\n${SECTION}`
                + '- **Subtask One** needs the standalone card `outside-prerequisite.md`.\n'
                + '- **Subtask Two** needs the standalone card `already-done-outside.md`.\n',
        });
        const outcome = await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, h.ports);
        assert.strictEqual(outcome.resolutions.length, 2);
        const done = outcome.resolutions.find(r => r.prerequisiteId === 'outside-done');
        assert.strictEqual(done.outcome, 'complete', JSON.stringify(done));
        assert.strictEqual(h.writes.edges.length, 1,
            'a complete prerequisite needs no edge — only the unfinished one is written');
        assert.deepStrictEqual(h.writes.dispatched, [{ planId: 'outside-one' }],
            'and a complete prerequisite is not dispatched');
        assert.strictEqual(h.writes.reports.length, outcome.resolutions.length,
            'ONE report entry per outside prerequisite found');
        assert.ok(h.writes.reports.every(e => e.authoringBreach === true),
            'every resolution records the breach, including the one already complete');
    });

    await test('an unreadable board is `error`, never `absent`', async () => {
        const h = fakePorts({ boardThrows: true, body: `# The Feature\n\n${SECTION}- **Subtask One** needs \`outside-prerequisite.md\`.\n` });
        const outcome = await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, h.ports);
        assert.strictEqual(outcome.kind, 'error', JSON.stringify(outcome));
        assert.ok(/could not be read/.test(outcome.reason), outcome.reason);
        assert.notStrictEqual(outcome.kind, 'none-found',
            '"we could not tell" and "there is nothing" must never render the same string');
    });

    await test('an unknown feature is not-found, and an unset Navigator slot is tagged', async () => {
        const missing = fakePorts({ feature: null });
        assert.strictEqual((await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, missing.ports)).kind, 'not-found');
        const unset = fakePorts({ unconfigured: true, body: `# The Feature\n\n${SECTION}- **Subtask One** needs \`outside-prerequisite.md\`.\n` });
        const outcome = await navigator.resolveOutsidePrerequisites({ featureId: 'feat-1' }, unset.ports);
        assert.strictEqual(outcome.kind, 'resolved', 'the pass is mechanical — no Navigator model is needed to recognise a name');
        assert.strictEqual(outcome.modelId, '', 'an unset slot is blank, not a borrowed name');
        assert.ok(/navigator-slot-unreadable/.test(outcome.authorSource), outcome.authorSource);
    });

    await test('the prose is read, never authored — the module has no write path to a plan file', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'controller', 'navigator.ts'), 'utf8');
        const block = src.slice(src.indexOf('export async function resolveOutsidePrerequisites'));
        assert.ok(!/writeFile|appendFile|fs\./.test(block), 'no plan file is written by this pass');
        assert.ok(!/updateMission|stageMembers|createMission/.test(block),
            'the pass writes the dependency edge and dispatches — nothing else on the board');
    });

    // ══ The route, against a real board ════════════════════════════════════

    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-navprereq-')));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'features'), { recursive: true });
    const db = KanbanDatabase.forWorkspace(tmpRoot);
    {
        const dbDir = path.dirname(db.dbPath);
        if (!fs.existsSync(dbDir)) { fs.mkdirSync(dbDir, { recursive: true }); }
        if (!fs.existsSync(db.dbPath)) { fs.writeFileSync(db.dbPath, Buffer.alloc(0)); }
        assert.ok(await db.ensureReady(), 'seeded kanban.db must initialise');
    }
    const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'navprereq-ws';

    const FEATURE_ID = 'aaaaaaaa-1111-4000-8000-000000000001';
    const SUB_ONE = 'aaaaaaaa-1111-4000-8000-000000000002';
    const SUB_TWO = 'aaaaaaaa-1111-4000-8000-000000000003';
    const PREREQ = 'bbbbbbbb-2222-4000-8000-000000000001';

    async function seedPlan(planId, slug, topic, extra = {}) {
        const rel = `.switchboard/plans/${slug}.md`;
        fs.writeFileSync(path.join(tmpRoot, rel), `# ${topic}\n\n## Goal\n${topic}\n`, 'utf8');
        const now = new Date().toISOString();
        assert.ok(await db.insertFileDerivedPlan({
            planId, sessionId: planId, topic, planFile: rel, kanbanColumn: 'CREATED',
            status: 'active', complexity: '3', tags: '', project: '', workspaceId: wsId,
            createdAt: now, updatedAt: now, sourceType: 'local', workspaceName: 'navprereq',
            isFeature: 0, ...extra,
        }), `seedPlan(${slug}) must insert`);
        return rel;
    }

    // The feature file names its outside prerequisite, exactly as the live
    // incident's feature file did. Its mtime is asserted unchanged below.
    const featureRel = `.switchboard/features/the-feature-${FEATURE_ID}.md`;
    const featureAbs = path.join(tmpRoot, featureRel);
    fs.writeFileSync(featureAbs, `# The Feature\n\n${SECTION}`
        + '- **Subtask One** lands first and needs the standalone card `outside-prerequisite.md`, which is not one of its subtasks.\n'
        + '\n## Subtasks\n\n- [ ] Subtask One\n- [ ] Subtask Two\n', 'utf8');
    const featureMtimeBefore = fs.statSync(featureAbs).mtimeMs;
    assert.ok(await db.insertFileDerivedPlan({
        planId: FEATURE_ID, sessionId: FEATURE_ID, topic: 'The Feature', planFile: featureRel,
        kanbanColumn: 'CREATED', status: 'active', complexity: '6', tags: '', project: '', workspaceId: wsId,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        sourceType: 'local', workspaceName: 'navprereq', isFeature: 1,
    }), 'the feature must insert');
    await seedPlan(SUB_ONE, 'subtask-one', 'Subtask One');
    await seedPlan(SUB_TWO, 'subtask-two', 'Subtask Two');
    await seedPlan(PREREQ, 'outside-prerequisite', 'Outside Prerequisite');
    assert.strictEqual(await db.updateFeatureStatus(SUB_ONE, 0, FEATURE_ID), 'applied', 'subtask one must link to the feature');
    assert.strictEqual(await db.updateFeatureStatus(SUB_TWO, 0, FEATURE_ID), 'applied', 'subtask two must link to the feature');

    // Subtask One is staged and waiting: the queue's own candidate.
    assert.ok(await db.appendQueuePositions(wsId, [SUB_ONE]), 'subtask one must stage');

    const reports = [];
    const server = new LocalApiServer({
        clickupMetadataPath: '', linearMetadataPath: '',
        getClickUpService: () => null, getLinearService: () => null, getNotionService: () => null,
        getAuthToken: async () => '',
        allRoots: [tmpRoot], workspaceRoot: tmpRoot,
        getKanbanDatabase: async () => db,
        controllerStore: { writeReport: async (root, req) => { reports.push({ root, req }); return { success: true }; } },
        terminalVerb: async () => ({ terminals: [] }),
        armQueueWatch: async () => { /* not under test */ },
    });
    const dispatchedByBoard = [];
    server.performKanbanDispatch = async (_root, planId) => {
        dispatchedByBoard.push(planId);
        return { status: 200, payload: { success: true, planId, moved: true, dispatched: true } };
    };

    async function request(method, url, body) {
        const headers = { 'content-type': 'application/json', 'host': '127.0.0.1:7777', 'x-switchboard-client': 'navigator-outside-prerequisites-contract' };
        const req = {
            method, url, headers,
            on: (event, cb) => { if (event === 'data') cb(Buffer.from(JSON.stringify(body || {}))); else if (event === 'end') cb(); },
            socket: { destroy: () => {}, remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
        };
        let status = 0;
        let responseBody = null;
        const headerMap = {};
        const res = {
            headersSent: false,
            writeHead: (code, hdrs) => {
                status = code; res.statusCode = code; res.headersSent = true;
                if (hdrs && typeof hdrs === 'object') { for (const [k, v] of Object.entries(hdrs)) { headerMap[k.toLowerCase()] = v; } }
                return res;
            },
            setHeader: (k, v) => { headerMap[String(k).toLowerCase()] = v; },
            getHeader: (k) => headerMap[String(k).toLowerCase()],
            getHeaders: () => ({ ...headerMap }),
            removeHeader: (k) => { delete headerMap[String(k).toLowerCase()]; },
            write: (chunk) => { if (chunk) { responseBody = (responseBody || '') + String(chunk); } return true; },
            once: () => res, on: () => res, destroy: () => {},
            end: (data) => {
                if (data) { responseBody = (responseBody || '') + String(data); }
                responseBody = responseBody ? JSON.parse(responseBody) : null;
            },
        };
        await server._handleRequest(req, res);
        return { status, body: responseBody };
    }

    const prerequisites = (featureId) => request('POST', '/controller/navigator/prerequisites', { featureId });
    const deps = (planId) => request('GET', `/kanban/dependencies?planId=${encodeURIComponent(planId)}`);

    let passOutcome = null;

    await test('the route writes the edge the queue gate reads, and dispatches the prerequisite', async () => {
        const r = await prerequisites(FEATURE_ID);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.kind, 'resolved', JSON.stringify(r.body.outcome).slice(0, 600));
        passOutcome = r.body.outcome;
        assert.strictEqual(passOutcome.resolutions.length, 1);
        assert.strictEqual(passOutcome.resolutions[0].outcome, 'exists-unfinished');

        const d = await deps(SUB_ONE);
        assert.ok((d.body.dependencies || []).includes(PREREQ),
            `GET /kanban/dependencies?planId=${SUB_ONE} must contain ${PREREQ}: ${JSON.stringify(d.body)}`);
        const none = await deps(SUB_TWO);
        assert.ok(!(none.body.dependencies || []).includes(PREREQ), 'paired negative: the other subtask gains no edge');

        assert.deepStrictEqual(dispatchedByBoard, [PREREQ],
            'the prerequisite is dispatched through the board\'s own dispatch path');
        assert.ok(/dispatched \(delivered\)/.test(r.body.message), r.body.message);
    });

    await test('report entries recording the breach equal the outside prerequisites found', async () => {
        const breaches = reports.filter(x => /Authoring breach/.test(String(x.req && x.req.body || '')));
        assert.strictEqual(breaches.length, passOutcome.resolutions.length,
            'one entry per outside prerequisite, so the breach is visible rather than absorbed');
        assert.strictEqual(reports.length, passOutcome.resolutions.length, 'and no extra aggregate entry when something was found');
    });

    // A feature subtask is deliberately NOT a pop candidate (`isQueueDispatchCandidate`
    // requires an empty `featureId` — subtasks are dispatched by their lead, which is
    // exactly the caller the plan was written from). So the pop-level assertions use a
    // LOOSE dependent carrying the same edge shape, and the feature subtask is asserted
    // through `isDependencyReady`, the one predicate the pop consults.
    const LOOSE = 'aaaaaaaa-1111-4000-8000-000000000004';
    await seedPlan(LOOSE, 'loose-dependent', 'Loose Dependent');
    assert.ok(await db.appendQueuePositions(wsId, [LOOSE]), 'the loose dependent must stage');
    assert.ok(await db.addPlanDependency(LOOSE, PREREQ), 'the loose dependent waits on the same prerequisite');

    const readiness = async () => {
        const board = await db.getBoard(wsId);
        return await isDependencyReady(SUB_ONE, createDependencyReadinessSource(db, board));
    };

    await test('the queue pop REFUSES the dependent until the prerequisite asserts completion', async () => {
        const out = await server.dispatchNextFromQueue({ workspaceRoot: tmpRoot, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'the board never refuses a pop — a blocked one reports not-ready');
        assert.strictEqual(out.payload.dispatched, null, 'nothing is dispatched while the prerequisite is incomplete');
        assert.ok(out.payload.dependencyBlocked && out.payload.dependencyBlocked.blockedBy === PREREQ,
            `the not-ready body must NAME the blocking prerequisite: ${JSON.stringify(out.payload)}`);
        assert.strictEqual(await readiness(), false,
            'and the shared readiness predicate the pop consults refuses the feature subtask too');
    });

    await test('the dependent IS released once the prerequisite completes, with no further Navigator action', async () => {
        assert.ok(await db.setCompletedAt(PREREQ, '2026-09-22T07:05:00.000Z'), 'the prerequisite asserts completion');
        assert.strictEqual(await readiness(), true,
            'asserted completion is the ONLY fact that releases the dependent — no second Navigator pass ran');
        const before = dispatchedByBoard.length;
        const out = await server.dispatchNextFromQueue({ workspaceRoot: tmpRoot, from: 'Coding' });
        assert.strictEqual(out.status, 200, JSON.stringify(out.payload));
        assert.ok(out.payload.dispatched, `the pop hands the dependent out now the edge is satisfied: ${JSON.stringify(out.payload)}`);
        assert.strictEqual(dispatchedByBoard.length, before + 1, 'the pass did not run again');
        assert.strictEqual(dispatchedByBoard[dispatchedByBoard.length - 1], LOOSE,
            'and it is the dependent the edge held back');
    });

    await test('the feature file is not written by this pass — its mtime is unchanged', async () => {
        assert.strictEqual(fs.statSync(featureAbs).mtimeMs, featureMtimeBefore,
            'the prose is READ, never authored');
        const raw = fs.readFileSync(featureAbs, 'utf8');
        assert.ok(raw.includes('`outside-prerequisite.md`'), 'the prose is byte-identical');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) { process.exit(1); }
}

run().catch(err => {
    console.error('suite crashed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
