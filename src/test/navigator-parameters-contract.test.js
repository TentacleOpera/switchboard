'use strict';

/**
 * The Navigator fills in a mission's parameters
 * (plan: the-navigator-orders-missions-into-a-schedule, subtask 3).
 *
 * Order, team, dependency mapping and worktree already have stores; this pass
 * writes them and invents none. Five fences this suite holds, each a shipped bug
 * elsewhere in the codebase if it slips:
 *
 *  - **The order IS the edges.** `plan_dependencies` is what `isDependencyReady`
 *    gates the queue pop on, so a written edge is obeyed boardwide. A cyclic set
 *    writes NOTHING — not the edges, not the team, not the worktree.
 *  - **Never stages.** The only method that writes queue order also moves every
 *    card to STAGING, which is starting the mission. `appendQueuePositions` is
 *    absent from the pass's code path and no card's column or `column_order`
 *    moves across it.
 *  - **Team is availability, not suitability.** With no reachable team,
 *    `missions.team` stays `''` and the reason is
 *    `resolveAutomatedDispatchExclusions`' own string, verbatim.
 *  - **The operator's value wins.** A hand-set `team` or `maxExtraWorktrees`
 *    survives a re-run untouched, and says it was the operator's.
 *  - **Nothing else is written.** Zero `coding_rounds` rows, zero `worktrees`
 *    rows, no plan file touched.
 *
 * Harness notes (mirrored from navigator-proposal-contract.test.js — do not
 * "simplify" these): `vscode` → the standalone shim before any out/ require;
 * kanban.db must exist on disk before `ensureReady()`; the model is a REAL http
 * server on a loopback port.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:navigator-parameters
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
const { computeMapFingerprint } = require('../../out/services/kanbanOrdering');
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

const TEAM_GROUPS_KEY = 'switchboard.prompts.terminals.groups';
const AGENT_GROUPS_KEY = 'terminals.agentGroups';

function row(planId, extra = {}) {
    return {
        planId, sessionId: planId, topic: 'topic of ' + planId, kanbanColumn: 'PLAN REVIEWED',
        project: '', isFeature: 0, featureId: '', ownerSince: null, completedAt: null,
        planFile: `/tmp/${planId}.md`, columnOrder: null, ...extra,
    };
}

function mission(plans, extra = {}) {
    return {
        id: 'm1', name: 'Mission', goal: 'a goal', team: '', maxExtraWorktrees: 0,
        runState: 'not-started', plans, features: [], ...extra,
    };
}

/**
 * Fake ports for the capability's own contract. The capability makes no board
 * call and no model call of its own, so this is the whole world it sees.
 */
function fakePorts(opts = {}) {
    const writes = { dependencies: [], missionUpdates: [], records: [], provenance: [] };
    const seen = [];
    return {
        writes, seen,
        ports: {
            listPlans: async () => (opts.board ? opts.board() : (opts.rows || [])),
            isMissionMember: async () => false,
            readPlanBody: async (r) => (r && r.__body) || '',
            navigatorModel: async () => (opts.unconfigured
                ? { error: 'Agent-control config could not be read (config may be corrupt).' }
                : { providerId: 'stub', endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'stub-model', apiKey: null, source: 'row:navigator' }),
            callModel: async (req) => {
                if (opts.failCall) { return { ok: false, content: '', doneReason: null, latencyMs: 1, url: req.endpoint, status: 502, error: 'model endpoint returned 502' }; }
                try { seen.push(JSON.parse(req.user)); } catch { seen.push(null); }
                const content = typeof opts.reply === 'function' ? opts.reply(seen[seen.length - 1]) : opts.reply;
                return { ok: true, content, doneReason: 'stop', latencyMs: 1, url: req.endpoint, status: 200 };
            },
            createMission: async () => ({ missionId: 'm1' }),
            claimIntoMission: async () => ({ claimed: true }),
            readMission: async () => (opts.mission === undefined ? mission(opts.members || []) : opts.mission),
            readAvailableTeams: async () => opts.teams || { available: [], unavailable: [] },
            writeDependencies: async (input) => {
                writes.dependencies.push(input);
                return opts.depWrite ? opts.depWrite(input) : { ok: true };
            },
            updateMission: async (input) => {
                writes.missionUpdates.push(input);
                return opts.updateWrite ? opts.updateWrite(input) : { ok: true };
            },
            readParameterRecord: async () => opts.record || null,
            writeParameterRecord: async (missionId, rec) => { writes.records.push({ missionId, rec }); return { written: true }; },
            recordParameterProvenance: async (entry) => { writes.provenance.push(entry); return { written: true }; },
            now: () => '2026-09-22T06:00:00.000Z',
        },
    };
}

const reply = (obj) => JSON.stringify(obj);
const A = 'plan-a', B = 'plan-b', C = 'plan-c';

async function run() {
    console.log('\nThe Navigator fills in a mission\'s parameters\n');

    // ══ The capability's own contract ══════════════════════════════════════

    await test('the constraints the plans state become edges, one set-write per member, each with a map fingerprint', async () => {
        const h = fakePorts({
            members: [A, B, C],
            rows: [row(A), row(B), row(C)],
            teams: { available: [{ id: 'coding-team', label: 'Coding', head: 'Coding Coder', headRole: 'coder', policy: 'pool', policySource: 'config' }], unavailable: [] },
            reply: reply({
                order: [A, B, C],
                dependencies: [{ planId: B, dependsOn: [A] }],
                team: 'coding-team',
                worktrees: { extra: 0, reason: 'no shared files' },
            }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'applied', JSON.stringify(outcome).slice(0, 400));
        assert.deepStrictEqual(h.writes.dependencies.map(d => d.planId), [A, B, C], 'a set-write per member, so a re-run is idempotent');
        assert.deepStrictEqual(h.writes.dependencies.map(d => d.dependsOn), [[], [A], []]);
        assert.strictEqual(outcome.finding, 'ordering-constraints-recorded');
        // The fingerprint is the SAME computation the analysis pass uses, with
        // the member set standing in for the file set.
        const expected = computeMapFingerprint([{ planId: B, fileSet: [A, B, C].sort() }]);
        assert.strictEqual(h.writes.dependencies[1].mapFingerprint, expected,
            'the fingerprint must be {planId}:{sortedMemberSet}, computed by computeMapFingerprint');
        assert.ok(h.writes.dependencies.every(d => d.mapFingerprint), 'every write carries a fingerprint');
    });

    await test('a topological sort over the written edges reproduces the validated order exactly', async () => {
        const h = fakePorts({
            members: [A, B, C],
            rows: [row(A), row(B), row(C)],
            reply: reply({ order: [A, B, C], dependencies: [{ planId: B, dependsOn: [A] }, { planId: C, dependsOn: [B] }], team: null, worktrees: { extra: 0, reason: '' } }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'applied');
        const edges = new Map(h.writes.dependencies.map(d => [d.planId, d.dependsOn]));
        // Kahn, tie-broken by nothing — the chain is a total order, so the sort
        // is forced and the declared order is reproduced rather than assumed.
        const indeg = new Map([A, B, C].map(id => [id, 0]));
        for (const [id, deps] of edges) { indeg.set(id, deps.length); }
        const ready = [A, B, C].filter(id => indeg.get(id) === 0);
        const sorted = [];
        while (ready.length) {
            const id = ready.shift();
            sorted.push(id);
            for (const [other, deps] of edges) {
                if (deps.indexOf(id) < 0) { continue; }
                indeg.set(other, indeg.get(other) - 1);
                if (indeg.get(other) === 0) { ready.push(other); }
            }
        }
        assert.deepStrictEqual(sorted, [A, B, C]);
        assert.deepStrictEqual(outcome.order, [A, B, C]);
    });

    await test('a mission whose plans state no constraint writes zero edges and records that as a positive finding', async () => {
        const h = fakePorts({
            members: [A, B],
            rows: [row(A), row(B)],
            reply: reply({ order: [A, B], dependencies: [{ planId: A, dependsOn: [] }, { planId: B, dependsOn: [] }], team: null, worktrees: { extra: 0, reason: '' } }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'applied');
        assert.strictEqual(outcome.finding, 'no-hard-ordering-constraints');
        assert.ok(h.writes.dependencies.every(d => d.dependsOn.length === 0), 'zero edges');
        const none = navigator.parameterOutcomeMessage(outcome);
        const some = navigator.parameterOutcomeMessage({ ...outcome, finding: 'ordering-constraints-recorded' });
        assert.notStrictEqual(none, some, '"found none" must not render like "recorded an order"');
        assert.ok(/no hard ordering constraints/i.test(none));
    });

    await test('a cycle writes NOTHING — not the edges, not the team, not the worktree', async () => {
        const h = fakePorts({
            members: [A, B],
            rows: [row(A), row(B)],
            teams: { available: [{ id: 'coding-team', label: 'Coding', head: 'C', headRole: 'coder', policy: 'pool', policySource: 'config' }], unavailable: [] },
            reply: reply({ order: [A, B], dependencies: [{ planId: A, dependsOn: [B] }, { planId: B, dependsOn: [A] }], team: 'coding-team', worktrees: { extra: 1, reason: 'collide' } }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'cycle', JSON.stringify(outcome));
        assert.deepStrictEqual(h.writes.dependencies, [], 'no edge may be written');
        assert.deepStrictEqual(h.writes.missionUpdates, [], 'no team or worktree may be written either');
        assert.deepStrictEqual(h.writes.records, [], 'and no parameter record');
        assert.ok(navigator.parameterOutcomeMessage(outcome).includes('Nothing was written'));
    });

    await test('a reply naming an id that is not a member is rejected wholesale', async () => {
        for (const bad of [
            { order: [A, 'not-a-member'], dependencies: [] },
            { order: [A], dependencies: [{ planId: A, dependsOn: ['not-a-member'] }] },
            { order: [A], dependencies: [{ planId: 'not-a-member', dependsOn: [A] }] },
        ]) {
            const h = fakePorts({ members: [A], rows: [row(A)], reply: reply({ ...bad, team: null, worktrees: { extra: 0, reason: '' } }) });
            const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
            assert.strictEqual(outcome.kind, 'invalid-reply', `${JSON.stringify(bad)} must be refused`);
            assert.deepStrictEqual(h.writes.dependencies, []);
            assert.deepStrictEqual(h.writes.missionUpdates, []);
        }
    });

    await test('an order that is not a permutation of the members is refused, and one that contradicts the edges too', async () => {
        const short = fakePorts({ members: [A, B], rows: [row(A), row(B)], reply: reply({ order: [A], dependencies: [], team: null, worktrees: { extra: 0, reason: '' } }) });
        assert.strictEqual((await navigator.proposeParameters({ missionId: 'm1' }, short.ports)).kind, 'invalid-reply');

        // Declared A -> B, but A depends on B: the two halves disagree.
        const contradicts = fakePorts({
            members: [A, B], rows: [row(A), row(B)],
            reply: reply({ order: [A, B], dependencies: [{ planId: A, dependsOn: [B] }], team: null, worktrees: { extra: 0, reason: '' } }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, contradicts.ports);
        assert.strictEqual(outcome.kind, 'invalid-reply');
        assert.ok(/contradicts/.test(outcome.reason), outcome.reason);
        assert.deepStrictEqual(contradicts.writes.dependencies, []);
    });

    await test('a hand-set team and worktree survive a re-run, and say they are the operator\'s', async () => {
        const h = fakePorts({
            mission: mission([A], { team: 'review-team', maxExtraWorktrees: 1 }),
            rows: [row(A)],
            record: null,
            teams: { available: [{ id: 'coding-team', label: 'Coding', head: 'C', headRole: 'coder', policy: 'pool', policySource: 'config' }], unavailable: [] },
            reply: reply({ order: [A], dependencies: [], team: 'coding-team', worktrees: { extra: 0, reason: 'no' } }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'applied');
        assert.deepStrictEqual(h.writes.missionUpdates, [], 'neither field may be sent when the operator set both');
        assert.strictEqual(outcome.team, 'review-team');
        assert.strictEqual(outcome.teamSource, 'operator');
        assert.strictEqual(outcome.maxExtraWorktrees, 1);
        assert.strictEqual(outcome.worktreeSource, 'operator');
        assert.ok(/hand-set value was left alone/i.test(navigator.parameterOutcomeMessage(outcome)));
    });

    await test('the Navigator\'s OWN earlier value is re-decided rather than mistaken for the operator\'s', async () => {
        const h = fakePorts({
            mission: mission([A], { team: 'coding-team', maxExtraWorktrees: 0 }),
            rows: [row(A)],
            record: { at: '2026-09-22T05:00:00.000Z', modelId: 'stub', order: [A], setters: { order: 'navigator', team: 'navigator', worktree: 'navigator' }, team: 'coding-team', maxExtraWorktrees: 0, finding: 'no-hard-ordering-constraints', teamReason: '', worktreeReason: '' },
            teams: { available: [{ id: 'review-team', label: 'Review', head: 'R', headRole: 'reviewer', policy: 'pool', policySource: 'config' }], unavailable: [] },
            reply: reply({ order: [A], dependencies: [], team: 'review-team', worktrees: { extra: 1, reason: 'collide' } }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'applied');
        assert.strictEqual(h.writes.missionUpdates.length, 1);
        assert.deepStrictEqual(h.writes.missionUpdates[0], { missionId: 'm1', team: 'review-team', maxExtraWorktrees: 1 });
        assert.strictEqual(outcome.teamSource, 'navigator');
    });

    await test('a member a seat already holds is never reordered and its edges are left alone', async () => {
        const h = fakePorts({
            mission: mission([A, B, C]),
            rows: [row(A, { ownerSince: '2026-09-22T05:00:00Z' }), row(B), row(C)],
            reply: reply({ order: [B, C], dependencies: [{ planId: C, dependsOn: [B] }], team: null, worktrees: { extra: 0, reason: '' } }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'applied');
        assert.deepStrictEqual(h.writes.dependencies.map(d => d.planId), [B, C], 'the held member gets no write at all');
        assert.deepStrictEqual(outcome.skippedHeld, [A]);
        assert.ok(!outcome.order.includes(A), 'and it is not in the recorded order');
        assert.ok(navigator.parameterOutcomeMessage(outcome).includes('held card'));
    });

    await test('a card taken by a seat BETWEEN the read and the write is dropped from the write', async () => {
        let call = 0;
        const h = fakePorts({
            mission: mission([A, B]),
            board: () => (++call === 1 ? [row(A), row(B)] : [row(A, { ownerSince: '2026-09-22T06:00:00Z' }), row(B)]),
            reply: reply({ order: [A, B], dependencies: [], team: null, worktrees: { extra: 0, reason: '' } }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'applied');
        assert.deepStrictEqual(h.writes.dependencies.map(d => d.planId), [B], 'ownership is re-read inside the write step');
        assert.deepStrictEqual(outcome.skippedHeld, [A]);
    });

    await test('an in-flight mission is refused outright', async () => {
        const h = fakePorts({ mission: mission([A], { runState: 'in-flight' }), rows: [row(A)], reply: reply({ order: [A] }) });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'refused-in-flight');
        assert.deepStrictEqual(h.writes.dependencies, []);
        assert.deepStrictEqual(h.writes.missionUpdates, []);
    });

    await test('with no reachable team the mission records NO team, and the resolver\'s reason travels verbatim', async () => {
        const verbatim = "head of 'Feature team' (automatedDispatch=never)";
        const h = fakePorts({
            members: [A], rows: [row(A)],
            teams: { available: [], unavailable: [{ id: 'feature-implementation', label: 'Feature team', head: 'Feature', reason: verbatim }] },
            reply: reply({ order: [A], dependencies: [], team: 'feature-implementation', worktrees: { extra: 0, reason: '' } }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'applied');
        assert.strictEqual(outcome.team, '', 'missions.team must stay empty');
        assert.strictEqual(outcome.teamSource, 'unassigned');
        assert.strictEqual(outcome.teamReason, verbatim, 'the reason is the seam\'s own string, not a re-worded one');
        assert.ok(navigator.parameterOutcomeMessage(outcome).includes(verbatim));
        assert.deepStrictEqual(h.writes.missionUpdates, [],
            'nothing is sent when the decided value equals the stored one — a no-op write would bump updated_at and make the mission look like it moved');
    });

    await test('"no team is running" and "the Navigator named no team" are different reasons', async () => {
        const none = fakePorts({ members: [A], rows: [row(A)], teams: { available: [], unavailable: [] }, reply: reply({ order: [A], dependencies: [], team: null, worktrees: { extra: 0, reason: '' } }) });
        const a = await navigator.proposeParameters({ missionId: 'm1' }, none.ports);
        const declined = fakePorts({
            members: [A], rows: [row(A)],
            teams: { available: [{ id: 'coding-team', label: 'Coding', head: 'C', headRole: 'coder', policy: 'pool', policySource: 'config' }], unavailable: [] },
            reply: reply({ order: [A], dependencies: [], team: null, worktrees: { extra: 0, reason: '' } }),
        });
        const b = await navigator.proposeParameters({ missionId: 'm1' }, declined.ports);
        assert.ok(/no team is running/i.test(a.teamReason), a.teamReason);
        assert.ok(/did not name a team/i.test(b.teamReason), b.teamReason);
        assert.notStrictEqual(a.teamReason, b.teamReason);
    });

    await test('a reply that OMITS the dependencies array is a malformed reply, not "no constraints"', async () => {
        const omitted = fakePorts({ members: [A], rows: [row(A)], reply: reply({ order: [A], team: null, worktrees: { extra: 0, reason: '' } }) });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, omitted.ports);
        assert.strictEqual(outcome.kind, 'invalid-reply', 'a missing key must not be recorded as a claim the model never made');
        assert.ok(/dependencies array/.test(outcome.reason));
        assert.deepStrictEqual(omitted.writes.dependencies, []);

        // An EMPTY array IS that claim, and is accepted.
        const stated = fakePorts({ members: [A], rows: [row(A)], reply: reply({ order: [A], dependencies: [], team: null, worktrees: { extra: 0, reason: '' } }) });
        const ok = await navigator.proposeParameters({ missionId: 'm1' }, stated.ports);
        assert.strictEqual(ok.kind, 'applied');
        assert.strictEqual(ok.finding, 'no-hard-ordering-constraints');
    });

    await test('a worktree decision outside the schema\'s range is an invalid reply, never silently capped', async () => {
        const h = fakePorts({ members: [A], rows: [row(A)], reply: reply({ order: [A], dependencies: [], team: null, worktrees: { extra: 3, reason: 'lots' } }) });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'invalid-reply');
        assert.deepStrictEqual(h.writes.missionUpdates, []);
    });

    await test('no worktree judgement keeps the column default of 0, and says the default decided it', async () => {
        const h = fakePorts({ members: [A], rows: [row(A)], reply: reply({ order: [A], dependencies: [], team: null }) });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'applied');
        assert.strictEqual(outcome.maxExtraWorktrees, 0);
        assert.strictEqual(outcome.worktreeSource, 'default');
    });

    await test('every parameter carries the model id and the time that set it', async () => {
        const h = fakePorts({ members: [A], rows: [row(A)], reply: reply({ order: [A], dependencies: [], team: null, worktrees: { extra: 0, reason: '' } }) });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.modelId, 'stub (stub-model)');
        assert.strictEqual(outcome.at, '2026-09-22T06:00:00.000Z');
        const rec = h.writes.records[0].rec;
        assert.strictEqual(rec.modelId, 'stub (stub-model)');
        assert.strictEqual(rec.at, '2026-09-22T06:00:00.000Z');
        assert.deepStrictEqual(rec.setters, { order: 'navigator', team: 'unassigned', worktree: 'navigator' });
        const prov = h.writes.provenance[0];
        assert.strictEqual(prov.modelId, 'stub (stub-model)');
        assert.strictEqual(prov.at, '2026-09-22T06:00:00.000Z');
    });

    await test('a failed edge write is reported as PARTLY arranged, never as applied', async () => {
        const h = fakePorts({
            members: [A, B], rows: [row(A), row(B)],
            depWrite: (input) => (input.planId === B ? { ok: false, error: 'the board refused the dependency write' } : { ok: true }),
            reply: reply({ order: [A, B], dependencies: [{ planId: B, dependsOn: [A] }], team: null, worktrees: { extra: 0, reason: '' } }),
        });
        const outcome = await navigator.proposeParameters({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'partial');
        const msg = navigator.parameterOutcomeMessage(outcome);
        assert.ok(/FAILED/.test(msg), msg);
        assert.ok(/PARTLY arranged/.test(msg), msg);
    });

    await test('the pass names no staging method and no coding_rounds or worktrees write', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'controller', 'navigator.ts'), 'utf8');
        assert.ok(!src.includes('appendQueuePositions'), 'appendQueuePositions stages the cards — it is the start subtask\'s, not this pass\'s');
        assert.ok(!/coding_rounds/.test(src), 'coding_rounds is the lead\'s registration record');
        assert.ok(!/\bgetWorktrees\b|\bsetWorktree\w*\b|\bworktreeId\b/.test(src),
            'the worktrees TABLE is untouched — no worktree-table method is reachable from this module; the route test proves the row count is zero');
        // Paired positive: the two stores it DOES write are both present.
        assert.ok(src.includes('writeDependencies') && src.includes('updateMission'));
    });

    await test('the panel renders the three order states distinctly, from the fields the endpoint sends', async () => {
        // The dock is browser-only DOM code in an IIFE with no export surface, so
        // what CAN be pinned is that it draws from the ONE source the board
        // derives and that the three states are three different strings.
        const dockJs = fs.readFileSync(path.join(__dirname, '..', 'webview', 'dock.js'), 'utf8');
        const dockHtml = fs.readFileSync(path.join(__dirname, '..', 'webview', 'dock.html'), 'utf8');
        assert.ok(dockJs.includes('m.sequencing'), 'the order line is rendered from the board\'s sequencing view, not re-derived');
        assert.ok(dockJs.includes('m.parameters'), 'and the setter record travels with it');
        assert.ok(/Insertion order — not ordered by the Navigator/.test(dockJs),
            'an unordered mission says so');
        assert.ok(/No hard ordering constraints/.test(dockJs),
            'and "the Navigator found none" is a visibly different string');
        assert.ok(dockJs.includes("'/controller/navigator/parameters'"), 'the strip posts the pass\'s own route');
        for (const id of ['mission-params', 'mission-param-btn']) {
            assert.ok(dockHtml.includes('.' + id), `dock.html must carry the ${id} skin`);
        }
        // The endpoint must actually send both fields the strip reads.
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'LocalApiServer.ts'), 'utf8');
        const progressBlock = serverSrc.slice(serverSrc.indexOf('GET /kanban/missions/progress — how far each MISSION'), serverSrc.indexOf('out.sort((a, b) => (b.lastMovementAt || 0)'));
        assert.ok(/sequencing: Array\.isArray\(m\.sequencing\)/.test(progressBlock), 'the progress read surfaces the sequencing view');
        assert.ok(/parameters: parameterRecords\[m\.id\] \|\| null/.test(progressBlock), 'and the parameter record');
    });

    // ══ The route, against a real board and a real model endpoint ══════════

    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-navparam-')));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });
    const db = KanbanDatabase.forWorkspace(tmpRoot);
    {
        const dbDir = path.dirname(db.dbPath);
        if (!fs.existsSync(dbDir)) { fs.mkdirSync(dbDir, { recursive: true }); }
        if (!fs.existsSync(db.dbPath)) { fs.writeFileSync(db.dbPath, Buffer.alloc(0)); }
        assert.ok(await db.ensureReady(), 'seeded kanban.db must initialise');
    }
    const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'navparam-ws';

    const P1 = 'param-one', P2 = 'param-two', P3 = 'param-three';
    async function seedPlan(planId, body) {
        const rel = `.switchboard/plans/${planId}.md`;
        fs.writeFileSync(path.join(tmpRoot, rel), body, 'utf8');
        const now = new Date().toISOString();
        assert.ok(await db.insertFileDerivedPlan({
            planId, sessionId: planId, topic: 'topic ' + planId, planFile: rel,
            status: 'active', complexity: '3', tags: '', project: '', workspaceId: wsId,
            createdAt: now, updatedAt: now, sourceType: 'local', workspaceName: 'navparam',
            isFeature: 0,
        }), `seedPlan(${planId}) must insert`);
    }
    await seedPlan(P1, `# ${P1}\n\n## Goal\nLay the foundation.\n`);
    await seedPlan(P2, `# ${P2}\n\n## Goal\nBuild on ${P1} — it needs the foundation first.\n`);
    await seedPlan(P3, `# ${P3}\n\n## Goal\nPolish, after ${P2} exists.\n`);

    const m = await db.createMission({ name: 'parameter mission', goal: 'order these', type: 'mission', workspaceId: wsId });
    for (const id of [P1, P2, P3]) { await db.claimIntoMission(m.id, id, 'plan', { by: 'test' }); }

    // A live, POOLED team — available.
    await db.setConfigJson(AGENT_GROUPS_KEY, [
        { id: 'coding-team', name: 'Coding', headRole: 'coder', enabled: true, automatedDispatch: 'pool', automatedDispatchSource: 'config', members: [{ role: 'intern', count: 1 }] },
    ]);
    await db.setConfigJson(TEAM_GROUPS_KEY, [
        { id: 'team_Coding', name: 'Coding Coder', head: 'Coding Coder', headRole: 'coder', teamKind: 'spawned', definitionId: 'coding-team', members: ['Coding Intern'], order: ['Coding Coder', 'Coding Intern'] },
    ]);

    // ── The model endpoint: a real loopback http server ──
    let replyFor = () => ({ order: [], dependencies: [], team: null, worktrees: { extra: 0, reason: '' } });
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
    const server = new LocalApiServer({
        clickupMetadataPath: '', linearMetadataPath: '',
        getClickUpService: () => null, getLinearService: () => null, getNotionService: () => null,
        getAuthToken: async () => '',
        allRoots: [tmpRoot], workspaceRoot: tmpRoot,
        getKanbanDatabase: async () => db,
        controllerStore: { writeReport: async (root, req) => { reports.push({ root, req }); return { success: true }; } },
        terminalVerb: async () => ({ terminals: [{ friendlyName: 'Coding Coder', status: 'active', role: 'coder' }, { friendlyName: 'Coding Intern', status: 'active', role: 'intern' }] }),
        armQueueWatch: async () => { /* not under test */ },
    });

    async function request(method, url, body) {
        const headers = { 'content-type': 'application/json', 'host': '127.0.0.1:7777', 'x-switchboard-client': 'navigator-parameters-contract' };
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

    const params = (missionId) => request('POST', '/controller/navigator/parameters', { missionId });
    const deps = (planId) => request('GET', `/kanban/dependencies?planId=${encodeURIComponent(planId)}`);
    const progress = () => request('GET', '/kanban/missions/progress');

    const before = new Map((await db.getBoardWorkingSet(wsId)).map(r => [r.planId, { col: r.kanbanColumn, order: r.columnOrder }]));
    // The mission's column distribution as the BOARD renders it, before any pass.
    const beforeColumns = JSON.stringify(((await progress()).body.data.missions || []).find(x => x.id === m.id).columns);

    let outcome = null;

    await test('the pass writes the edges the plans state, and the queue\'s own read sees them', async () => {
        replyFor = () => ({
            order: [P1, P2, P3],
            dependencies: [{ planId: P2, dependsOn: [P1] }, { planId: P3, dependsOn: [P2] }],
            team: 'coding-team',
            worktrees: { extra: 0, reason: 'the cards do not share files' },
        });
        const r = await params(m.id);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.kind, 'applied', JSON.stringify(r.body.outcome).slice(0, 500));
        outcome = r.body.outcome;

        const p2 = await deps(P2);
        assert.ok((p2.body.dependencies || []).includes(P1), 'GET /kanban/dependencies?planId=P2 must contain P1');
        assert.ok(p2.body.mapFingerprint, 'the fingerprint is persisted so a later pass can detect staleness');
        const p1 = await deps(P1);
        assert.ok(!(p1.body.dependencies || []).includes(P2), 'paired negative: P1 does not depend on P2');
        assert.ok(lastRequest.messages[0].content.includes('You arrange the cards of ONE mission'),
            'the prompt states the fence: it arranges, it does not draft');
    });

    await test('team and the worktree decision land on the mission row, and the panel read shows them', async () => {
        const prog = await progress();
        const strip = (prog.body.data.missions || []).find(x => x.id === m.id);
        assert.ok(strip, 'the mission must appear in the panel read');
        assert.strictEqual(strip.team, 'coding-team');
        assert.strictEqual(strip.maxExtraWorktrees, 0);
        assert.ok(Array.isArray(strip.sequencing) && strip.sequencing.length === 3,
            `the rendered sequencing must travel with the mission: ${JSON.stringify(strip.sequencing)}`);
        assert.ok(strip.sequencing.some(line => line.includes('waits on')), JSON.stringify(strip.sequencing));
        assert.ok(strip.parameters, 'the setter record travels too');
        assert.strictEqual(strip.parameters.modelId, 'stubnav (stub-model)');
        assert.strictEqual(strip.parameters.setters.team, 'navigator');
        assert.strictEqual(strip.parameters.finding, 'ordering-constraints-recorded');
    });

    await test('no card\'s kanban_column or column_order changed — this pass never stages', async () => {
        const after = new Map((await db.getBoardWorkingSet(wsId)).map(r => [r.planId, { col: r.kanbanColumn, order: r.columnOrder }]));
        for (const [planId, was] of before) {
            const now = after.get(planId);
            assert.ok(now, `${planId} must still be on the board`);
            assert.strictEqual(now.col, was.col, `${planId}'s column moved`);
            assert.strictEqual(now.order, was.order, `${planId}'s column_order moved`);
        }
        const prog = await progress();
        const strip = (prog.body.data.missions || []).find(x => x.id === m.id);
        assert.strictEqual(JSON.stringify(strip.columns), beforeColumns,
            `the columns map must be unchanged: ${JSON.stringify(strip.columns)}`);
    });

    await test('zero rows written to coding_rounds and zero to worktrees', async () => {
        const rounds = await db.getCodingRoundsByWorkspace(wsId);
        assert.strictEqual(rounds.length, 0, 'coding_rounds is the lead\'s registration record, not this pass\'s');
        const trees = await db.getWorktrees(wsId);
        assert.strictEqual(trees.length, 0, 'the worktrees table records trees that EXIST on disk');
    });

    await test('a hand-set team survives a re-run through the route', async () => {
        assert.ok(await db.updateMission(m.id, { team: 'review-team', maxExtraWorktrees: 1 }));
        replyFor = () => ({ order: [P1, P2, P3], dependencies: [{ planId: P2, dependsOn: [P1] }, { planId: P3, dependsOn: [P2] }], team: 'coding-team', worktrees: { extra: 0, reason: 'x' } });
        const r = await params(m.id);
        assert.strictEqual(r.body.kind, 'applied');
        assert.strictEqual(r.body.outcome.team, 'review-team', 'the operator\'s team is not overwritten');
        assert.strictEqual(r.body.outcome.teamSource, 'operator');
        assert.strictEqual(r.body.outcome.maxExtraWorktrees, 1);
        const row = await db.getMissionById(m.id);
        assert.strictEqual(row.team, 'review-team');
        assert.strictEqual(row.maxExtraWorktrees, 1);
    });

    await test('a cycle through the route writes nothing and reports the cycle', async () => {
        const edgesBefore = (await deps(P2)).body.dependencies.slice().sort();
        const rowBefore = await db.getMissionById(m.id);
        replyFor = () => ({ order: [P1, P2, P3], dependencies: [{ planId: P1, dependsOn: [P2] }, { planId: P2, dependsOn: [P1] }], team: 'coding-team', worktrees: { extra: 1, reason: 'y' } });
        const r = await params(m.id);
        assert.strictEqual(r.body.kind, 'cycle', JSON.stringify(r.body).slice(0, 300));
        assert.ok(r.body.message.includes('Nothing was written'));
        assert.deepStrictEqual((await deps(P2)).body.dependencies.slice().sort(), edgesBefore, 'no edge moved');
        const rowAfter = await db.getMissionById(m.id);
        assert.strictEqual(rowAfter.team, rowBefore.team, 'and the team was not touched');
        assert.strictEqual(rowAfter.maxExtraWorktrees, rowBefore.maxExtraWorktrees);
    });

    await test('a mission with no reachable team keeps missions.team empty and reports the resolver\'s reason verbatim', async () => {
        // The only live team is switched to `never`: its head is excluded.
        await db.setConfigJson(AGENT_GROUPS_KEY, [
            { id: 'coding-team', name: 'Coding', headRole: 'coder', enabled: true, automatedDispatch: 'never', automatedDispatchSource: 'config', members: [{ role: 'intern', count: 1 }] },
        ]);
        const empty = await db.createMission({ name: 'no team', goal: 'g', type: 'mission', workspaceId: wsId });
        await db.claimIntoMission(empty.id, P1, 'plan', { by: 'test' });
        replyFor = () => ({ order: [P1], dependencies: [], team: 'coding-team', worktrees: { extra: 0, reason: '' } });
        const r = await params(empty.id);
        assert.strictEqual(r.body.kind, 'applied', JSON.stringify(r.body.outcome).slice(0, 400));
        assert.strictEqual(r.body.outcome.team, '', 'missions.team stays empty with no live team');
        assert.strictEqual(r.body.outcome.teamReason, "head of 'Coding' (automatedDispatch=never)",
            'the reason must be resolveAutomatedDispatchExclusions\' own string, verbatim');
        assert.ok(r.body.message.includes("head of 'Coding' (automatedDispatch=never)"), r.body.message);
        const row = await db.getMissionById(empty.id);
        assert.strictEqual(row.team, '');
        // The pass still recorded the finding, so "no constraints" is a result
        // and not an absent pass.
        const prog = await progress();
        const strip = (prog.body.data.missions || []).find(x => x.id === empty.id);
        assert.strictEqual(strip.parameters.finding, 'no-hard-ordering-constraints');
    });

    await test('the provenance record reaches the controller report with the model, the order and each setter', async () => {
        assert.ok(reports.length >= 3, 'every pass appends one entry');
        const withOrder = reports.find(r => r.req.body.includes('Order') || r.req.body.includes('order:'));
        assert.ok(withOrder, 'the recorded order is in the report');
        assert.ok(reports.some(r => r.req.body.includes('stubnav (stub-model)')), 'the model is named');
        assert.ok(reports.some(r => r.req.body.includes('setter: navigator')), 'each parameter carries its setter');
        for (const r of reports) {
            assert.strictEqual(r.req.from, 'navigator');
            assert.ok(!/^### Actions$/m.test(r.req.body), 'no ### Actions heading — the panel\'s latest-report walk must not be hijacked');
        }
    });

    modelServer.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) { process.exit(1); }
}

run().catch(err => { console.error(err); process.exit(1); });
