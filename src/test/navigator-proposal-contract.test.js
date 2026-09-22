'use strict';

/**
 * The Navigator proposes a mission's cards
 * (plan: the-navigator-groups-ready-plans-into-missions, subtask 2).
 *
 * Starting a mission is two questions — subject and goal — and up to ten
 * EXISTING cards that belong together. Three things this suite exists to hold,
 * each of which is a shipped bug elsewhere in the codebase if it slips:
 *
 *  - **A mission, not a feature.** Applying a proposal writes `missions` +
 *    `mission_members` through `POST /kanban/mission/create` and
 *    `POST /kanban/mission/member/add` (→ `claimIntoMission`), and the result is
 *    visible in `GET /kanban/missions/progress`. A proposal applied as a
 *    *feature* would be invisible to the mission panel, which would go on saying
 *    "No mission set up" over the thing the operator just built.
 *  - **Never trust a model-returned id.** Every id is validated against the
 *    candidate set the capability assembled. An id outside it is an INVALID
 *    REPLY — the pass reports that rather than proposing a card the board never
 *    offered.
 *  - **Four states, four strings.** "No candidates", "invalid reply", "pass
 *    failed" and "no Navigator configured" must never render alike.
 *
 * Harness notes (mirrored from mission-release-column-contract.test.js — do not
 * "simplify" these):
 *  - `vscode` → the standalone shim, installed BEFORE any out/services require.
 *  - KanbanDatabase NEVER auto-creates kanban.db, so the file must be touched on
 *    disk before ensureReady() will initialise it.
 *  - The model is a REAL http server on a loopback port, so the whole path
 *    through `callModel` is exercised rather than stubbed out.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:navigator-proposal
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
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

/** A plan row as the board read returns it. */
function row(planId, extra = {}) {
    return {
        planId, sessionId: planId, topic: 'topic of ' + planId, kanbanColumn: 'PLAN REVIEWED',
        project: 'Orchestration', isFeature: 0, featureId: '', ownerSince: null, completedAt: null,
        planFile: `/tmp/${planId}.md`, ...extra,
    };
}

/**
 * Fake ports for the capability's own contract. The capability makes no board
 * call and no model call of its own, so this is the whole world it sees.
 */
function fakePorts(rows, opts = {}) {
    const created = [];
    const claims = [];
    const recorded = [];
    const seenPayloads = [];
    return {
        created, claims, recorded, seenPayloads,
        ports: {
            listPlans: async () => rows,
            isMissionMember: async (id) => (opts.missionMembers || []).includes(id),
            readPlanBody: async (r) => r.__body || '',
            navigatorModel: async () => (opts.unconfigured
                ? { error: 'Agent-control config could not be read (config may be corrupt).' }
                : { providerId: 'stub', endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'stub-model', apiKey: null, source: 'row:navigator' }),
            callModel: async (req) => {
                if (opts.failCall) { return { ok: false, content: '', doneReason: null, latencyMs: 1, url: req.endpoint, status: 502, error: 'model endpoint returned 502' }; }
                try { seenPayloads.push(JSON.parse(req.user)); } catch { seenPayloads.push(null); }
                return { ok: true, content: typeof opts.reply === 'function' ? opts.reply(seenPayloads[seenPayloads.length - 1]) : opts.reply, doneReason: 'stop', latencyMs: 1, url: req.endpoint, status: 200 };
            },
            createMission: async (input) => { created.push(input); return opts.createError ? { error: opts.createError } : { missionId: 'mission-1' }; },
            claimIntoMission: async ({ missionId, planId }) => {
                claims.push({ missionId, planId });
                return opts.claim ? opts.claim(planId) : { planId, claimed: true };
            },
            recordProvenance: async (entry) => { recorded.push(entry); return { written: true }; },
        },
    };
}

const idsOf = (n, prefix = 'p') => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);

// ── The route harness ──────────────────────────────────────────────────────

function makeServer(db, WS, controllerStore) {
    return new LocalApiServer({
        clickupMetadataPath: '', linearMetadataPath: '',
        getClickUpService: () => null, getLinearService: () => null, getNotionService: () => null,
        getAuthToken: async () => '',
        allRoots: [WS], workspaceRoot: WS,
        getKanbanDatabase: async () => db,
        controllerStore: controllerStore || undefined,
        armQueueWatch: async () => { /* not under test */ },
    });
}

async function request(server, method, url, body) {
    const headers = {
        'content-type': 'application/json',
        'host': '127.0.0.1:7777',
        'x-switchboard-client': 'navigator-proposal-contract',
    };
    const req = {
        method,
        url,
        headers,
        on: (event, cb) => {
            if (event === 'data') cb(Buffer.from(JSON.stringify(body || {})));
            else if (event === 'end') cb();
        },
        socket: { destroy: () => {}, remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
    };
    let status = 0;
    let responseBody = null;
    const headerMap = {};
    const res = {
        headersSent: false,
        writeHead: (code, hdrs) => {
            status = code;
            res.statusCode = code;
            res.headersSent = true;
            if (hdrs && typeof hdrs === 'object') {
                for (const [k, v] of Object.entries(hdrs)) { headerMap[k.toLowerCase()] = v; }
            }
            return res;
        },
        setHeader: (k, v) => { headerMap[String(k).toLowerCase()] = v; },
        getHeader: (k) => headerMap[String(k).toLowerCase()],
        getHeaders: () => ({ ...headerMap }),
        removeHeader: (k) => { delete headerMap[String(k).toLowerCase()]; },
        write: (chunk) => { if (chunk) { responseBody = (responseBody || '') + String(chunk); } return true; },
        once: () => res,
        on: () => res,
        destroy: () => {},
        end: (data) => {
            if (data) { responseBody = (responseBody || '') + String(data); }
            responseBody = responseBody ? JSON.parse(responseBody) : null;
        },
    };
    await server._handleRequest(req, res);
    return { status, body: responseBody };
}

/** Every plan file under the workspace, with its mtime — the "no plan was written" evidence. */
function planFileStamps(root) {
    const dir = path.join(root, '.switchboard', 'plans');
    const out = {};
    for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        out[f] = `${st.size}:${st.mtimeMs}`;
    }
    return out;
}

async function run() {
    console.log('\nThe Navigator proposes a mission\'s cards\n');

    // ══ The capability's own contract ══════════════════════════════════════

    await test('the candidate filter drops features, feature subtasks, held cards and work already on a seat', async () => {
        const rows = [
            row('keep-1'),
            row('keep-2', { ownerSince: null, completedAt: null }),
            row('is-a-feature', { isFeature: 1 }),
            row('inside-a-feature', { featureId: 'feat-1' }),
            row('already-in-a-mission'),
            row('held-by-a-seat', { ownerSince: '2026-09-22T00:00:00Z' }),
            row('held-but-completed', { ownerSince: '2026-09-22T00:00:00Z', completedAt: '2026-09-22T01:00:00Z' }),
        ];
        const h = fakePorts(rows, { missionMembers: ['already-in-a-mission'], reply: '{}' });
        const candidates = await navigator.collectCandidates(h.ports, { bodies: true });
        assert.deepStrictEqual(candidates.map(c => c.planId), ['keep-1', 'keep-2', 'held-but-completed'],
            'only loose, unstarted cards outside a mission and outside a feature are eligible');
    });

    await test('an id absent from the locally-assembled candidate set is an INVALID REPLY, not a proposal', async () => {
        const rows = [row('p01'), row('p02')];
        const h = fakePorts(rows, { reply: JSON.stringify({ missionName: 'M', goal: 'g', planIds: ['p01', 'made-up-id'], rationale: 'r' }) });
        const outcome = await navigator.proposeMission({ subject: 'anything' }, h.ports);
        assert.strictEqual(outcome.kind, 'invalid-reply', `expected invalid-reply, got '${outcome.kind}'`);
        assert.ok(outcome.reason.includes('made-up-id'), 'the offending id must be named');
        assert.ok(!('proposal' in outcome), 'no proposal may be returned for a rejected reply');
    });

    await test('a reply with no valid ids is an invalid reply, not an empty proposal', async () => {
        const h = fakePorts([row('p01')], { reply: JSON.stringify({ missionName: 'M', planIds: [], rationale: 'r' }) });
        const outcome = await navigator.proposeMission({ subject: 'anything' }, h.ports);
        assert.strictEqual(outcome.kind, 'invalid-reply');
    });

    await test('twelve ids yield ten, with the truncation stated as a field', async () => {
        const ids = idsOf(12);
        const h = fakePorts(ids.map(id => row(id)), { reply: JSON.stringify({ missionName: 'M', goal: 'g', planIds: ids, rationale: 'r' }) });
        const outcome = await navigator.proposeMission({ subject: 'anything' }, h.ports);
        assert.strictEqual(outcome.kind, 'proposal');
        assert.strictEqual(outcome.proposal.planIds.length, navigator.NAVIGATOR_PROPOSAL_CAP);
        assert.ok(outcome.proposal.truncated, 'the truncation must be a field, not a log line');
        assert.strictEqual(outcome.proposal.truncated.dropped, 2);
        assert.deepStrictEqual(outcome.proposal.truncated.ids, ['p11', 'p12']);
    });

    await test('duplicate ids collapse before the cap is applied', async () => {
        const ids = idsOf(3);
        const h = fakePorts(ids.map(id => row(id)), { reply: JSON.stringify({ planIds: [ids[0], ids[0], ids[1]] }) });
        const outcome = await navigator.proposeMission({ subject: 'anything' }, h.ports);
        assert.strictEqual(outcome.kind, 'proposal');
        assert.deepStrictEqual(outcome.proposal.planIds, [ids[0], ids[1]]);
        assert.strictEqual(outcome.proposal.truncated, null);
    });

    await test('the validated proposal carries exactly five fields and none can hold plan text', async () => {
        const ids = idsOf(2);
        const h = fakePorts(ids.map(id => row(id)), {
            reply: JSON.stringify({ missionName: 'M', goal: 'g', planIds: ids, rationale: 'r', body: 'a whole plan, smuggled in', planText: '...' }),
        });
        const outcome = await navigator.proposeMission({ subject: 'anything' }, h.ports);
        assert.strictEqual(outcome.kind, 'proposal');
        assert.deepStrictEqual(Object.keys(outcome.proposal).sort(), ['goal', 'missionName', 'planIds', 'rationale', 'truncated']);
        assert.ok(!JSON.stringify(outcome.proposal).includes('a whole plan, smuggled in'),
            'a model that wants to draft has nowhere to put it');
    });

    await test('the three non-proposal states render three distinct strings', async () => {
        const empty = await navigator.proposeMission({ subject: 'nothing matches' }, fakePorts([], { reply: '{}' }).ports);
        assert.strictEqual(empty.kind, 'no-candidates');

        const invalid = await navigator.proposeMission({ subject: 'x' }, fakePorts([row('p01')], { reply: JSON.stringify({ planIds: ['nope'] }) }).ports);
        assert.strictEqual(invalid.kind, 'invalid-reply');

        const failed = await navigator.proposeMission({ subject: 'x' }, fakePorts([row('p01')], { failCall: true }).ports);
        assert.strictEqual(failed.kind, 'error');

        const unconfigured = await navigator.proposeMission({ subject: 'x' }, fakePorts([row('p01')], { unconfigured: true }).ports);
        assert.strictEqual(unconfigured.kind, 'unconfigured');

        const strings = [empty, invalid, failed, unconfigured].map(navigator.navigatorOutcomeMessage);
        assert.strictEqual(new Set(strings).size, 4, `four states, four strings — got ${JSON.stringify(strings)}`);
        for (const s of strings) { assert.ok(s && s.length > 0, 'every state says something'); }
    });

    await test('a subject pass sends plan bodies; the cold-board pass does NOT ship the whole board', async () => {
        const ids = idsOf(3);
        const rows = ids.map(id => ({ ...row(id), __body: `BODY-OF-${id}` }));
        const subjectRun = fakePorts(rows, { reply: JSON.stringify({ planIds: [ids[0]] }) });
        await navigator.proposeMission({ subject: 'x' }, subjectRun.ports);
        assert.ok(JSON.stringify(subjectRun.seenPayloads[0]).includes('BODY-OF-p01'), 'a subject pass sends the candidates\' text');

        const coldRun = fakePorts(rows, { reply: JSON.stringify({ groupings: [{ planIds: [ids[0]] }] }) });
        await navigator.proposeColdBoard(coldRun.ports);
        assert.ok(!JSON.stringify(coldRun.seenPayloads[0]).includes('BODY-OF-'),
            'the pass that reads the whole board must not ship every plan\'s text to a metered model');
    });

    await test('cold-board mode returns at most three groupings and states the cap', async () => {
        const ids = idsOf(5);
        const h = fakePorts(ids.map(id => row(id)), {
            reply: JSON.stringify({ groupings: ids.map((id, i) => ({ missionName: 'G' + i, goal: 'g', planIds: [id], rationale: 'r' })) }),
        });
        const outcome = await navigator.proposeColdBoard(h.ports);
        assert.strictEqual(outcome.kind, 'cold-board');
        assert.strictEqual(outcome.groupings.length, navigator.NAVIGATOR_COLD_BOARD_CAP);
        assert.ok(outcome.truncated && outcome.truncated.dropped === 2, 'the cold-board cap is stated too');
    });

    await test('applying writes exactly the mission verbs, and never team or worktree', async () => {
        const h = fakePorts([], {});
        const outcome = await navigator.applyProposal({ missionName: 'M', goal: 'g', planIds: ['p01', 'p02'], subject: 's', modelId: 'stub (stub-model)' }, h.ports);
        assert.strictEqual(outcome.kind, 'applied');
        assert.strictEqual(outcome.missionId, 'mission-1');
        assert.deepStrictEqual(h.created, [{ name: 'M', goal: 'g', type: 'mission' }],
            'createMission is called with name, goal and type alone — team and maxExtraWorktrees belong to the next subtask');
        assert.deepStrictEqual(h.claims.map(c => c.planId), ['p01', 'p02'], 'one claim per approved id, in order');
        assert.strictEqual(outcome.recorded.written, true, 'provenance is recorded in the controller report');
        assert.strictEqual(h.recorded[0].missionId, 'mission-1');
        assert.strictEqual(h.recorded[0].subject, 's');
        assert.strictEqual(h.recorded[0].modelId, 'stub (stub-model)');
    });

    await test('a partial application is reported as partial, naming the ids that did not land', async () => {
        const h = fakePorts([], {
            claim: (planId) => (planId === 'p02' ? { planId, claimed: false, reason: 'no plan resolved for \'p02\'' } : { planId, claimed: true }),
        });
        const outcome = await navigator.applyProposal({ missionName: 'M', goal: 'g', planIds: ['p01', 'p02'] }, h.ports);
        assert.strictEqual(outcome.kind, 'partial');
        const msg = navigator.applyOutcomeMessage(outcome);
        assert.ok(msg.includes('p02'), `the refused id must be named: ${msg}`);
        assert.ok(!/created with 2/.test(msg), 'a half-built mission is never presented as complete');
    });

    await test('a mission whose every claim failed is created-and-empty, and says so', async () => {
        const h = fakePorts([], { claim: (planId) => ({ planId, claimed: false, reason: 'refused' }) });
        const outcome = await navigator.applyProposal({ missionName: 'M', goal: 'g', planIds: ['p01'] }, h.ports);
        assert.strictEqual(outcome.kind, 'created-empty');
        assert.ok(/empty/i.test(navigator.applyOutcomeMessage(outcome)));
    });

    await test('the capability module names no feature verbs, and its writes are the mission verbs alone', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'controller', 'navigator.ts'), 'utf8');
        assert.ok(!src.includes('create-feature.js'), 'the capability must not call create-feature.js');
        assert.ok(!src.includes('assign-to-feature.js'), 'the capability must not call assign-to-feature.js');
        assert.ok(src.includes('createMission') && src.includes('claimIntoMission'),
            'paired positive: the mission verbs ARE the module\'s write surface');
        // `updateMission` is NOT in this list any more, and that is intended: the
        // parameters subtask (the-navigator-orders-missions-into-a-schedule) fills
        // in `missions.team` and `max_extra_worktrees` through
        // `POST /kanban/mission/update`, which its own plan names. What must stay
        // absent is staging and the INSERT OR IGNORE member add.
        assert.ok(src.includes('updateMission'),
            'paired positive: the parameters pass writes team/worktree through the mission update verb');
        assert.ok(!/appendQueuePositions|addMissionMember/.test(src),
            'no staging (that is the start subtask\'s), and no INSERT OR IGNORE member add');
    });

    // ══ The route, against a real board and a real model endpoint ══════════

    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-navprop-')));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });
    const db = KanbanDatabase.forWorkspace(tmpRoot);
    {
        const dbDir = path.dirname(db.dbPath);
        if (!fs.existsSync(dbDir)) { fs.mkdirSync(dbDir, { recursive: true }); }
        if (!fs.existsSync(db.dbPath)) { fs.writeFileSync(db.dbPath, Buffer.alloc(0)); }
        assert.ok(await db.ensureReady(), 'seeded kanban.db must initialise');
    }
    const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'nav-ws';

    /** Twelve loose, unstarted, unfeatured cards — and one already in a mission. */
    const SEEDED = idsOf(12, 'card-');
    async function seedPlan(planId, extra = {}) {
        const rel = `.switchboard/plans/${planId}.md`;
        fs.writeFileSync(path.join(tmpRoot, rel), `# ${planId}\n\n## Goal\nsomething about ${planId}\n`, 'utf8');
        const now = new Date().toISOString();
        assert.ok(await db.insertFileDerivedPlan({
            planId, sessionId: planId, topic: 'topic ' + planId, planFile: rel,
            status: 'active', complexity: '3', tags: '', project: '', workspaceId: wsId,
            createdAt: now, updatedAt: now, sourceType: 'local', workspaceName: 'navprop',
            isFeature: 0, ...extra,
        }), `seedPlan(${planId}) must insert`);
        return planId;
    }
    for (const id of SEEDED) { await seedPlan(id); }

    // A card another mission already holds, so the transfer path is exercised.
    const otherMission = await db.createMission({ name: 'earlier mission', type: 'mission', workspaceId: wsId });
    await db.claimIntoMission(otherMission.id, SEEDED[0], 'plan', { by: 'test' });

    // ── The model endpoint: a real loopback http server, not a stub module ──
    let replyFor = () => ({ planIds: [] });
    let lastRequest = null;
    const modelServer = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            lastRequest = JSON.parse(raw);
            const user = JSON.parse(lastRequest.messages[1].content);
            const content = JSON.stringify(replyFor(user));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
        });
    });
    await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
    const modelPort = modelServer.address().port;
    await GlobalIntegrationConfigService.setAgentConfig('agentControlNavigatorProvider', 'stubnav');
    await GlobalIntegrationConfigService.setAgentConfig('agentControlProviders', {
        stubnav: { endpoint: `http://127.0.0.1:${modelPort}/v1/chat/completions`, model: 'stub-model' },
    });

    const reports = [];
    const server = makeServer(db, tmpRoot, {
        writeReport: async (root, req) => { reports.push({ root, req }); return { success: true }; },
    });

    const propose = (b) => request(server, 'POST', '/controller/navigator/propose', b);
    const apply = (b) => request(server, 'POST', '/controller/navigator/apply', b);
    const progress = () => request(server, 'GET', '/kanban/missions/progress');
    const missions = () => request(server, 'GET', '/kanban/missions');

    let proposed = null;

    await test('an empty subject with no cold flag is refused, not silently routed to another pass', async () => {
        const r = await propose({ goal: 'g' });
        assert.strictEqual(r.status, 400);
        assert.ok(/cold/.test(r.body.error), `the refusal must name the way to ask for a cold board: ${r.body.error}`);
    });

    await test('a subject the Navigator can answer produces a proposal of existing cards', async () => {
        replyFor = (user) => ({
            missionName: 'RAM ceiling',
            goal: 'bring the board\'s memory floor down',
            planIds: user.eligibleCards.map(c => c.planId),
            rationale: 'all about memory',
        });
        const before = planFileStamps(tmpRoot);
        const r = await propose({ subject: 'memory', goal: 'bring the floor down' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.kind, 'proposal', JSON.stringify(r.body).slice(0, 400));
        proposed = r.body.outcome;
        // Twelve seeded, minus the one already held by `otherMission` = eleven
        // eligible. The cap then takes ten and STATES the one it dropped.
        assert.strictEqual(proposed.candidates.length, 11, 'the card already in a mission is not eligible');
        assert.strictEqual(proposed.proposal.planIds.length, 10, 'eleven eligible ids yield ten');
        assert.strictEqual(proposed.proposal.truncated.dropped, 1);
        assert.deepStrictEqual(planFileStamps(tmpRoot), before, 'a propose cycle writes no plan file');
        assert.ok(lastRequest.messages[0].content.includes('You SELECT among existing cards'),
            'the prompt states the fence: it selects, it does not draft');
    });

    await test('applying creates a mission that GET /kanban/missions/progress reports with cardsTotal === the approved count', async () => {
        const approved = proposed.proposal.planIds.slice(0, 5);
        const before = planFileStamps(tmpRoot);
        const r = await apply({
            missionName: proposed.proposal.missionName,
            goal: proposed.proposal.goal,
            planIds: approved,
            subject: 'memory',
            modelId: proposed.modelId,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.kind, 'applied', JSON.stringify(r.body.outcome));
        assert.deepStrictEqual(planFileStamps(tmpRoot), before, 'an apply cycle writes no plan file');

        const missionId = r.body.outcome.missionId;
        const listed = await missions();
        const found = (listed.body.missions || []).find(m => m.id === missionId);
        assert.ok(found, 'the mission must be in GET /kanban/missions');
        assert.ok(found.name && found.goal, 'missions.name and missions.goal are both non-empty');
        assert.strictEqual(found.team, '', 'this pass does not set missions.team');
        assert.strictEqual(found.maxExtraWorktrees, 0, 'this pass does not set missions.max_extra_worktrees');

        const prog = await progress();
        const strip = (prog.body.data.missions || []).find(m => m.id === missionId);
        assert.ok(strip, 'the mission must appear in the panel\'s own progress read');
        assert.strictEqual(strip.cardsTotal, approved.length, 'cardsTotal equals the approved id count');
    });

    await test('a card another mission held is reported as transferred, not silently re-added', async () => {
        const r = await apply({ missionName: 'transfer', goal: 'g', planIds: [SEEDED[0]] });
        assert.strictEqual(r.body.kind, 'applied');
        const claim = r.body.outcome.claims[0];
        assert.strictEqual(claim.transferredFrom, otherMission.id, 'the losing mission is named');
    });

    await test('the provenance record reaches the controller report store, naming model, subject, mission and per-id claims', async () => {
        assert.ok(reports.length >= 2, 'every apply appends one provenance entry');
        const withModel = reports.find(r => r.req.body.includes('stubnav (stub-model)'));
        assert.ok(withModel, 'the model that proposed it is recorded');
        assert.ok(withModel.req.body.includes('memory'), 'the operator\'s stated subject is recorded');
        const withTransfer = reports.find(r => r.req.body.includes('transferred from'));
        assert.ok(withTransfer, 'the claim outcome is recorded per id, including a transfer');
        for (const r of reports) {
            assert.strictEqual(r.req.from, 'navigator');
            assert.ok(!/^### Actions$/m.test(r.req.body),
                'the entry must NOT carry an ### Actions heading — the panel\'s latest-report walk looks for that');
        }
    });

    await test('an invalid model reply is reported as invalid through the route, and nothing is created', async () => {
        const before = (await missions()).body.missions.length;
        replyFor = () => ({ missionName: 'nope', goal: 'g', planIds: ['card-99'], rationale: 'r' });
        const r = await propose({ subject: 'memory' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.kind, 'invalid-reply');
        assert.ok(r.body.message.includes('invalid'), r.body.message);
        assert.strictEqual((await missions()).body.missions.length, before, 'an invalid reply creates nothing');
    });

    modelServer.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) { process.exit(1); }
}

run().catch(err => { console.error(err); process.exit(1); });
