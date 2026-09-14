'use strict';

/**
 * Contract: a seat is clean before it is handed the next subtask, WHOEVER
 * posted the completion.
 *
 * The bug this pins closed: `completeCardInternal` and `releaseCardInternal`
 * both carried a four-line guard
 *
 *     // Never clear the lead in `from`, planner, or reviewer
 *     if (acceptedCodingSeat === from) { acceptedCodingSeat = undefined; }
 *
 * whose comment states the intent BY ROLE and whose code compares BY NAME. The
 * member completion instruction tells a seat to run `done --from "<your
 * terminal name>"`, so `from` and the resolved coding seat are the same string
 * on every self-report — the documented worker flow, not an edge case. The
 * guard therefore fired exactly when the clear was owed, and a seat that
 * reported its own finish suppressed its own clear. Measured 2026-09-13 on
 * `Coding-intern`: three plans dispatched into one seat, no clear between any
 * of them, finishing at 139k/200k context.
 *
 * The at-rest clear is the ONLY clear between two subtasks — the dispatch path
 * issues none, deliberately, so no delivery races a context reset. Suppress it
 * and "one subtask per CLEAN seat" is not enforced anywhere.
 *
 * The `CODING_ROLES` gate inside `_resolveAcceptedCodingSeat` is the entire
 * protection the deleted comment described: it resolves from HOST evidence
 * (the card's `dispatchedTerminal` + `routedTo`, then the live fleet role) and
 * never from `from` or the request body, so a lead/planner/reviewer can never
 * come back as the seat to clear.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

const WS = '/tmp/self-reported-completion-clears-ws';

// The live fleet: one lead, one coder, one intern, one planner, one reviewer.
// `_resolveAcceptedCodingSeat`'s fallback reads these roles when the card row
// carries no `routedTo`.
const FLEET = [
    { friendlyName: 'Coding', role: 'lead_coder' },
    { friendlyName: 'Coder 1', role: 'coder' },
    { friendlyName: 'Coding-intern', role: 'intern' },
    { friendlyName: 'Planner 1', role: 'planner' },
    { friendlyName: 'Reviewer 1', role: 'reviewer' },
];

function card(planId, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: planId,
        kanbanColumn: 'CODER CODED',
        planFile: `/tmp/${planId}.md`,
        workspaceId: 'ws1',
        featureId: '',
        dispatchedAt: '2026-09-13T00:00:00Z',
        dispatchedTerminal: '',
        routedTo: '',
        queuePosition: null,
        completedAt: null,
        releasedAt: null,
        ...extra,
    };
}

function makeServer(opts = {}) {
    const plans = new Map();
    const clears = [];
    const events = [];

    const fakeDb = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => Array.from(plans.values()),
        getPlanByPlanId: async (planId) => plans.get(planId) || null,
        setCompletedAt: async (planId, ts) => {
            const p = plans.get(planId);
            if (!p) return false;
            p.completedAt = ts;
            return true;
        },
        setReleasedAt: async (planId, ts) => {
            const p = plans.get(planId);
            if (!p) return false;
            p.releasedAt = ts;
            return true;
        },
        setPlanOutcomeWorkflow: async () => true,
        releaseDispatchHolder: async (planFile) => {
            for (const p of plans.values()) {
                if (p.planFile === planFile) { p.dispatchedTerminal = ''; p.dispatchedAt = null; }
            }
            return true;
        },
        appendPlanEventByPlanId: async (planId, event) => { events.push({ planId, ...event }); return true; },
        ...(opts.db || {}),
    };

    const server = new LocalApiServer({
        clickupMetadataPath: '',
        linearMetadataPath: '',
        getClickUpService: () => null,
        getLinearService: () => null,
        getNotionService: () => null,
        getAuthToken: async () => 'test-token',
        allRoots: [WS],
        workspaceRoot: WS,
        getKanbanDatabase: async () => fakeDb,
        terminalVerb: async (verb) => {
            if (verb === 'ptyListTerminals') { return { success: true, terminals: FLEET }; }
            return { success: true };
        },
        clearTerminalContext: opts.clearTerminalContext || (async (_ws, term) => { clears.push(term); return { cleared: true }; }),
        armQueueWatch: async () => {},
    });

    return { server, plans, clears, events, fakeDb };
}

// ── 1. The complete path × both posters ──────────────────────────────────

async function run() {
    console.log('\n── a self-reported completion clears the seat ──\n');

    await check('complete: a coder posting its OWN completion is cleared', async () => {
        const { server, plans, clears, fakeDb } = makeServer();
        plans.set('p1', card('p1', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));

        const r = await server.completeCardInternal(fakeDb, 'p1', 'Coder 1', { workspaceRoot: WS });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.cleared, true, 'the self-reporting coder must be cleared');
        assert.strictEqual(r.acceptedCodingSeat, 'Coder 1', 'the receipt names the cleared seat');
        assert.deepStrictEqual(clears, ['Coder 1'], 'clearTerminalContext ran for the reporting coder');
    });

    await check('complete: an intern posting its OWN completion is cleared (the measured case)', async () => {
        const { server, plans, clears, fakeDb } = makeServer();
        // No routedTo on the row — resolution falls through to the live fleet
        // role lookup, which is the path the incident took.
        plans.set('p2', card('p2', { dispatchedTerminal: 'Coding-intern' }));

        const r = await server.completeCardInternal(fakeDb, 'p2', 'Coding-intern', { workspaceRoot: WS });
        assert.strictEqual(r.cleared, true, 'the self-reporting intern must be cleared');
        assert.deepStrictEqual(clears, ['Coding-intern']);
    });

    await check('complete: a lead posting for a coder clears the coder and never itself', async () => {
        const { server, plans, clears, fakeDb } = makeServer();
        plans.set('p3', card('p3', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));

        const r = await server.completeCardInternal(fakeDb, 'p3', 'Coding', { workspaceRoot: WS });
        assert.strictEqual(r.cleared, true);
        assert.deepStrictEqual(clears, ['Coder 1'], 'the coder is cleared, the lead is not');
        assert.ok(!clears.includes('Coding'), 'the lead in `from` is never cleared');
    });

    await check('complete: a planner or reviewer in `from` is never cleared — the coder it posted about is', async () => {
        for (const poster of ['Planner 1', 'Reviewer 1']) {
            const { server, plans, clears, fakeDb } = makeServer();
            plans.set('p4', card('p4', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));

            const r = await server.completeCardInternal(fakeDb, 'p4', poster, { workspaceRoot: WS });
            assert.strictEqual(r.cleared, true, `${poster}: the coder must still be cleared`);
            assert.deepStrictEqual(clears, ['Coder 1'], `${poster}: only the coder is cleared`);
        }
    });

    await check('complete: a lead\'s OWN card resolves to no coding seat and clears nothing', async () => {
        const { server, plans, clears, fakeDb } = makeServer();
        // lead_coder is not in CODING_ROLES — the gate, not the name guard, is
        // what protects a lead posting about its own LEAD CODED card.
        plans.set('p5', card('p5', { kanbanColumn: 'LEAD CODED', dispatchedTerminal: 'Coding', routedTo: 'lead' }));

        const r = await server.completeCardInternal(fakeDb, 'p5', 'Coding', { workspaceRoot: WS });
        assert.strictEqual(r.cleared, false);
        assert.strictEqual(r.acceptedCodingSeat, undefined);
        assert.deepStrictEqual(clears, [], 'no lead is ever cleared');
    });

    // ── 2. The release path × both posters ───────────────────────────────
    // The duplication between the two paths is the risk, and release is what
    // actually ran in the incident: the card came back `released`, and hit the
    // same guard, so the release cleared the card and not the seat.

    await check('release: a coder posting its OWN release is cleared', async () => {
        const { server, plans, clears, fakeDb } = makeServer();
        plans.set('r1', card('r1', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));

        const r = await server.releaseCardInternal(fakeDb, 'r1', 'Coder 1', { workspaceRoot: WS });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.cleared, true, 'the self-reporting coder must be cleared on release too');
        assert.strictEqual(r.acceptedCodingSeat, 'Coder 1');
        assert.deepStrictEqual(clears, ['Coder 1']);
    });

    await check('release: an intern posting its OWN release is cleared', async () => {
        const { server, plans, clears, fakeDb } = makeServer();
        plans.set('r2', card('r2', { dispatchedTerminal: 'Coding-intern' }));

        const r = await server.releaseCardInternal(fakeDb, 'r2', 'Coding-intern', { workspaceRoot: WS });
        assert.strictEqual(r.cleared, true);
        assert.deepStrictEqual(clears, ['Coding-intern']);
    });

    await check('release: a lead releasing a coder clears the coder and never itself', async () => {
        const { server, plans, clears, fakeDb } = makeServer();
        plans.set('r3', card('r3', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));

        const r = await server.releaseCardInternal(fakeDb, 'r3', 'Coding', { workspaceRoot: WS });
        assert.strictEqual(r.cleared, true);
        assert.deepStrictEqual(clears, ['Coder 1']);
        assert.ok(!clears.includes('Coding'));
    });

    await check('release: a planner or reviewer in `from` is never cleared — the coder it released is', async () => {
        for (const poster of ['Planner 1', 'Reviewer 1']) {
            const { server, plans, clears, fakeDb } = makeServer();
            plans.set('r4', card('r4', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));

            const r = await server.releaseCardInternal(fakeDb, 'r4', poster, { workspaceRoot: WS });
            assert.strictEqual(r.cleared, true, `${poster}: the coder must still be cleared`);
            assert.deepStrictEqual(clears, ['Coder 1'], `${poster}: only the coder is cleared`);
        }
    });

    // ── 3. The receipt answers "was this seat cleared, and why not?" ──────
    // The operator's report was "clears are not working", and confirming it
    // took a session log. A suppressed clear must be readable from the
    // response alone.

    await check('the receipt names the cleared seat, or says why none was', async () => {
        const { server, plans, fakeDb } = makeServer();
        plans.set('c1', card('c1', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));
        plans.set('c2', card('c2', { dispatchedTerminal: '', routedTo: '' }));

        const cleared = await server.completeCardInternal(fakeDb, 'c1', 'Coder 1', { workspaceRoot: WS });
        assert.strictEqual(cleared.cleared, true);
        assert.strictEqual(cleared.acceptedCodingSeat, 'Coder 1', 'a clear names the seat it cleared');

        const notCleared = await server.completeCardInternal(fakeDb, 'c2', 'Coding', { workspaceRoot: WS });
        assert.strictEqual(notCleared.cleared, false);
        assert.ok(notCleared.clearReason && notCleared.clearReason.length > 0,
            'a no-clear must carry a non-empty clearReason, not silence');
    });

    await check('a duplicate self-report does not clear twice', async () => {
        const { server, plans, clears, fakeDb } = makeServer();
        plans.set('d1', card('d1', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));

        await server.completeCardInternal(fakeDb, 'd1', 'Coder 1', { workspaceRoot: WS });
        await server.completeCardInternal(fakeDb, 'd1', 'Coder 1', { workspaceRoot: WS });
        assert.deepStrictEqual(clears, ['Coder 1'], 'markSeatAtRest / isSeatAtRest make the clear idempotent');
    });

    // ── 3b. Attribution fallback + multi-seat clear (lead-acceptance plan) ─

    await check('attribution fallback: empty dispatchedTerminal resolves via getLiveDispatchAttribution', async () => {
        // No-op #2: when the plan row has no dispatchedTerminal, the seat is
        // found via live dispatch attribution instead of being silently lost.
        const { server, plans, clears, fakeDb } = makeServer({
            db: {
                getLiveDispatchAttribution: async () => [
                    { planId: 'a1', topic: 'a1', dispatchedTerminal: 'Coder 1', dispatchedAt: '2026-09-14T00:00:00Z', featureId: '', project: '' },
                ],
            },
        });
        plans.set('a1', card('a1', { dispatchedTerminal: '', routedTo: '' }));
        const r = await server.completeCardInternal(fakeDb, 'a1', 'Coding', { workspaceRoot: WS });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.cleared, true, 'attribution fallback must find and clear the seat');
        assert.ok(clears.includes('Coder 1'), 'the attributed coder is cleared');
    });

    await check('multi-seat clear: two attributed coding seats both clear, minus from', async () => {
        // No-op #3: clear every coding seat attributed to the subtask, not
        // just the accepted one. The escalation ladder can put a second seat
        // on a subtask; both must be cleared on acceptance.
        const { server, plans, clears, fakeDb } = makeServer({
            db: {
                getLiveDispatchAttribution: async () => [
                    { planId: 'm1', topic: 'm1', dispatchedTerminal: 'Coder 1', dispatchedAt: '2026-09-14T01:00:00Z', featureId: '', project: '' },
                    { planId: 'm1', topic: 'm1', dispatchedTerminal: 'Coding-intern', dispatchedAt: '2026-09-14T02:00:00Z', featureId: '', project: '' },
                ],
            },
        });
        plans.set('m1', card('m1', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));
        const r = await server.completeCardInternal(fakeDb, 'm1', 'Coding', { workspaceRoot: WS });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.cleared, true);
        assert.ok(clears.includes('Coder 1'), 'the primary coder is cleared');
        assert.ok(clears.includes('Coding-intern'), 'the attributed intern is also cleared');
        assert.ok(!clears.includes('Coding'), 'the lead in `from` is never cleared');
    });

    await check('a coder that IS the poster is cleared (self-reported-completion-clears supersedes plan no-op #4)', async () => {
        // The plan's no-op #4 ("keep excluding `from`") is superseded by the
        // self-reported-completion-clears fix (commit 1073bb1a), which deleted
        // the name guard. A coder posting its own completion IS cleared — the
        // CODING_ROLES gate is the sole protection, and it is sufficient.
        const { server, plans, clears, fakeDb } = makeServer({
            db: {
                getLiveDispatchAttribution: async () => [
                    { planId: 'e1', topic: 'e1', dispatchedTerminal: 'Coder 1', dispatchedAt: '2026-09-14T00:00:00Z', featureId: '', project: '' },
                ],
            },
        });
        plans.set('e1', card('e1', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));
        const r = await server.completeCardInternal(fakeDb, 'e1', 'Coder 1', { workspaceRoot: WS });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.cleared, true, 'the self-reporting coder is cleared (name guard stays deleted)');
        assert.ok(clears.includes('Coder 1'), 'clearTerminalContext ran for the poster');
    });

    await check('a seat that moved on to a different card is not cleared', async () => {
        // The "released and moved on" guard: a seat that worked the subtask,
        // released, and took a NEW subtask must not be cleared mid-turn.
        // _isSeatCurrentDispatchedCard returns shouldClear:false when the
        // seat's current dispatch is a different planId.
        const { server, plans, clears, fakeDb } = makeServer({
            db: {
                getLiveDispatchAttribution: async () => [
                    { planId: 'm1', topic: 'm1', dispatchedTerminal: 'Coder 1', dispatchedAt: '2026-09-14T01:00:00Z', featureId: '', project: '' },
                ],
                getActiveDispatchedByTerminal: async () => ({ planId: 'other-plan', dispatchedTerminal: 'Coder 1' }),
            },
        });
        plans.set('m1', card('m1', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));
        const r = await server.completeCardInternal(fakeDb, 'm1', 'Coding', { workspaceRoot: WS });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.cleared, false, 'a seat that moved on is not cleared');
        assert.deepStrictEqual(clears, [], 'no clear runs for a moved-on seat');
        assert.ok(r.clearReason && r.clearReason.length > 0, 'the failure is surfaced with a reason');
    });

    await check('a failed clear (cleared:false) is surfaced with a warning, not silently dropped', async () => {
        // Root cause 2: a resolved seat whose clear returns cleared:false was
        // silently dropped before this fix. The response must carry the failure.
        const { server, plans, clears, fakeDb } = makeServer({
            clearTerminalContext: async () => ({ cleared: false, reason: 'terminal not found' }),
        });
        plans.set('f1', card('f1', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));
        const r = await server.completeCardInternal(fakeDb, 'f1', 'Coding', { workspaceRoot: WS });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.cleared, false, 'the failed clear is reported as cleared:false');
        assert.ok(r.clearError || r.clearReason, 'the failure reason is surfaced in the response');
    });

    // ── 4. Negative invariant: the name guard is gone ────────────────────

    await check('the `acceptedCodingSeat === from` name guard is absent from LocalApiServer', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        // Strip line and block comments: the deletion is deliberately EXPLAINED
        // in prose above both call sites, and that prose names the guard it
        // replaced. A raw grep would read the explanation as the bug.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/acceptedCodingSeat\s*===\s*from/.test(code),
            'the name-comparison guard must stay deleted — its comment states the intent by ROLE and '
            + 'its code compared by NAME, so it fired on exactly the self-report the clear is owed to');
    });

    // ── 5. One resolution helper, both paths ─────────────────────────────
    // The 17-line CODING_ROLES resolution block was duplicated verbatim
    // between the two functions. That duplication — not the guard — is the
    // drift seam: two paths free to resolve a coding seat differently.

    await check('both at-rest paths resolve the coding seat through ONE shared helper', async () => {
        const { server, plans, fakeDb } = makeServer();
        plans.set('h1', card('h1', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));
        plans.set('h2', card('h2', { dispatchedTerminal: 'Coder 1', routedTo: 'coder' }));

        const seen = [];
        const original = server._resolveAcceptedCodingSeat.bind(server);
        server._resolveAcceptedCodingSeat = async (existing, workspaceRoot) => {
            seen.push(existing.planId);
            return original(existing, workspaceRoot);
        };

        await server.completeCardInternal(fakeDb, 'h1', 'Coder 1', { workspaceRoot: WS });
        await server.releaseCardInternal(fakeDb, 'h2', 'Coder 1', { workspaceRoot: WS });

        assert.deepStrictEqual(seen, ['h1', 'h2'],
            'completeCardInternal and releaseCardInternal must BOTH go through _resolveAcceptedCodingSeat — '
            + 'a second inline copy is the drift seam this extraction closes');
    });

    await check('the helper reads host evidence only — never `from`, never the request body', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const start = src.indexOf('private async _resolveAcceptedCodingSeat(');
        assert.ok(start > 0, '_resolveAcceptedCodingSeat must exist');
        const end = src.indexOf('\n    }', start);
        const body = src.slice(start, end);
        assert.ok(/CODING_ROLES/.test(body), 'the CODING_ROLES gate lives in the helper');
        assert.ok(/existing\.dispatchedTerminal/.test(body), 'the seat comes from the card row, host evidence');
        assert.ok(/ptyListTerminals/.test(body), 'the live-fleet role fallback lives in the helper');
        assert.ok(!/\bfrom\b/.test(body.replace(/from host evidence/gi, '')),
            'the helper must never read `from` — that is what made the deleted guard a bug');
    });

    if (failures > 0) {
        console.error(`\n${failures} failure(s)`);
        process.exit(1);
    }
    console.log(`\nResults: all passed, 0 failed.`);
}

run().catch((err) => { console.error(err); process.exit(1); });
