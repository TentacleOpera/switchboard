'use strict';

// Delta-polling orchestration tests for RemoteControlService (§7/§9/§10).
// Pure logic — driven by a fake DB (config + plans) and a fake RemoteProvider, so no
// vscode / network is needed. Exercises: seed-on-first-poll (no replay), state mirror +
// refresh-before-move + echo guard, comment dedup (seen-set) + advance-after-dispatch,
// authoredBySelf skip, and failure-stops-advance.

const assert = require('assert');
const { loadOutModule } = require('../shared/test-harness');

const { RemoteControlService } = loadOutModule('services/RemoteControlService.js');

function makeDb(initialConfig) {
    const store = new Map();
    store.set('remote.config', JSON.stringify(initialConfig));
    return {
        plans: [],
        ensureReady: async () => true,
        getConfig: async (key) => (store.has(key) ? store.get(key) : null),
        setConfig: async (key, value) => { store.set(key, value); return true; },
        getAllPlans: async () => store.__plans || [],
        _store: store,
        setPlans(plans) { store.__plans = plans; },
    };
}

function makePlan(overrides) {
    return Object.assign({
        planId: 'p1', sessionId: 's1', topic: 't', planFile: '/tmp/p1.md',
        kanbanColumn: 'CREATED', status: 'active', complexity: '5', tags: '',
        repoScope: '', project: 'proj', workspaceId: 'ws',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        lastAction: '', sourceType: 'linear-import', brainSourcePath: '', mirrorPath: '',
        routedTo: '', dispatchedAgent: '', dispatchedIde: '',
        linearIssueId: 'ISSUE1', notionPageId: '',
    }, overrides);
}

const BASE_CONFIG = { provider: 'linear', boards: ['proj'], silentSync: false, pingMode: 'manual', pingFrequencySeconds: 60 };

function makeService(db, provider, sinks) {
    return new RemoteControlService({
        getDb: () => db,
        getWorkspaceId: async () => 'ws',
        getProvider: () => provider,
        onColumnMove: async (plan, col) => {
            sinks.moves.push({ planId: plan.planId, col });
            if (sinks.order) { sinks.order.push('move:' + col); }
            // Mirror the real move: the DB now reflects the new column, so the next poll's
            // equality check no-ops the card's own re-surfaced delta.
            plan.kanbanColumn = col;
        },
        onComment: async (plan, body) => {
            sinks.comments.push({ planId: plan.planId, body });
            if (sinks.failComment) { throw new Error('boom'); }
        },
        log: () => {},
    });
}

async function poll(service) { await service['_poll'](); }

async function run() {
    // ── A. Seed-on-first-poll: no cursors → baseline both, dispatch nothing, never fetch.
    {
        const db = makeDb(BASE_CONFIG);
        db.setPlans([makePlan()]);
        let fetchedState = false, fetchedComments = false;
        const provider = {
            kind: 'linear',
            fetchStateDeltas: async () => { fetchedState = true; return { deltas: [], nextCursor: 'x' }; },
            fetchCommentDeltas: async () => { fetchedComments = true; return { deltas: [], nextCursor: 'x' }; },
            stateKeyToColumn: () => undefined,
            refreshLocalPlanFromRemote: async () => {},
        };
        const sinks = { moves: [], comments: [] };
        await poll(makeService(db, provider, sinks));
        assert.ok(!fetchedState, 'A: first poll must not fetch state (seed only)');
        assert.ok(!fetchedComments, 'A: first poll must not fetch comments (seed only)');
        assert.ok(db._store.get('remote.stateCursor.linear'), 'A: state cursor seeded');
        assert.ok(db._store.get('remote.commentCursor.linear'), 'A: comment cursor seeded');
        assert.strictEqual(sinks.moves.length, 0, 'A: no dispatch on seed poll');
    }

    // ── B. State mirror: refresh BEFORE move, then echo-guard suppresses the re-fetch.
    {
        const db = makeDb(BASE_CONFIG);
        db.setPlans([makePlan({ kanbanColumn: 'CREATED' })]);
        db._store.set('remote.stateCursor.linear', '2026-01-01T00:00:00.000Z');
        db._store.set('remote.commentCursor.linear', '2026-01-01T00:00:00.000Z');
        const order = [];
        const provider = {
            kind: 'linear',
            fetchStateDeltas: async () => ({ deltas: [{ remoteId: 'ISSUE1', stateKey: 'S_CODED' }], nextCursor: '2026-01-03T00:00:00.000Z' }),
            fetchCommentDeltas: async () => ({ deltas: [], nextCursor: '2026-01-01T00:00:00.000Z' }),
            stateKeyToColumn: (k) => (k === 'S_CODED' ? 'CODER CODED' : undefined),
            refreshLocalPlanFromRemote: async (id) => { order.push('refresh:' + id); },
        };
        const sinks = { moves: [], comments: [], order };
        const svc = makeService(db, provider, sinks);
        await poll(svc);
        assert.deepStrictEqual(sinks.moves, [{ planId: 'p1', col: 'CODER CODED' }], 'B: one move to CODER CODED');
        assert.deepStrictEqual(order, ['refresh:ISSUE1', 'move:CODER CODED'], 'B: refresh runs BEFORE move (D7)');
        // Second poll, same delta — the move already set the column, so the equality check
        // no-ops the card's own re-surfaced delta (the only guard we keep).
        await poll(svc);
        assert.strictEqual(sinks.moves.length, 1, 'B: column-equality suppresses the re-surfaced delta');
    }

    // ── C. Comments: ingest non-self once, skip self, advance cursor, de-dup on re-fetch.
    {
        const db = makeDb(BASE_CONFIG);
        db.setPlans([makePlan()]);
        db._store.set('remote.stateCursor.linear', '2026-01-01T00:00:00.000Z');
        db._store.set('remote.commentCursor.linear', '2026-01-01T00:00:00.000Z');
        const deltas = [
            { remoteId: 'ISSUE1', commentId: 'c1', body: 'hello', createdAt: '2026-01-02T00:00:00.000Z', authoredBySelf: false },
            { remoteId: 'ISSUE1', commentId: 'c2', body: 'self', createdAt: '2026-01-02T00:01:00.000Z', authoredBySelf: true },
        ];
        const provider = {
            kind: 'linear',
            fetchStateDeltas: async () => ({ deltas: [], nextCursor: '2026-01-01T00:00:00.000Z' }),
            fetchCommentDeltas: async () => ({ deltas, nextCursor: '2026-01-02T00:01:00.000Z' }),
            stateKeyToColumn: () => undefined,
            refreshLocalPlanFromRemote: async () => {},
        };
        const sinks = { moves: [], comments: [] };
        const svc = makeService(db, provider, sinks);
        await poll(svc);
        assert.deepStrictEqual(sinks.comments, [{ planId: 'p1', body: 'hello' }], 'C: only the non-self comment dispatched');
        assert.strictEqual(db._store.get('remote.commentCursor.linear'), '2026-01-02T00:01:00.000Z', 'C: cursor advanced to max seen');
        // Re-fetch the same rows (inclusive cursor) → seen-set de-dups, no second dispatch.
        await poll(svc);
        assert.strictEqual(sinks.comments.length, 1, 'C: seen-set prevents re-dispatch on re-fetch');
    }

    // ── D. onComment failure: cursor NOT advanced past the failed comment.
    {
        const db = makeDb(BASE_CONFIG);
        db.setPlans([makePlan()]);
        db._store.set('remote.stateCursor.linear', '2026-01-01T00:00:00.000Z');
        db._store.set('remote.commentCursor.linear', '2026-01-01T00:00:00.000Z');
        const provider = {
            kind: 'linear',
            fetchStateDeltas: async () => ({ deltas: [], nextCursor: '2026-01-01T00:00:00.000Z' }),
            fetchCommentDeltas: async () => ({ deltas: [
                { remoteId: 'ISSUE1', commentId: 'c1', body: 'x', createdAt: '2026-01-02T00:00:00.000Z', authoredBySelf: false },
            ], nextCursor: '2026-01-02T00:00:00.000Z' }),
            stateKeyToColumn: () => undefined,
            refreshLocalPlanFromRemote: async () => {},
        };
        const sinks = { moves: [], comments: [], failComment: true };
        await poll(makeService(db, provider, sinks));
        assert.strictEqual(db._store.get('remote.commentCursor.linear'), '2026-01-01T00:00:00.000Z', 'D: cursor not advanced on dispatch failure');
    }

    // ── E. Notion provider selection keys plans by notionPageId (not sourceType).
    {
        const db = makeDb(Object.assign({}, BASE_CONFIG, { provider: 'notion' }));
        db.setPlans([makePlan({ sourceType: 'local', linearIssueId: '', notionPageId: 'PAGE1' })]);
        db._store.set('remote.stateCursor.notion', '2026-01-01T00:00:00.000Z');
        db._store.set('remote.commentCursor.notion', '2026-01-01T00:00:00.000Z');
        let movedTo = null;
        const provider = {
            kind: 'notion',
            fetchStateDeltas: async () => ({ deltas: [{ remoteId: 'PAGE1', stateKey: 'CODER CODED' }], nextCursor: '2026-01-03T00:00:00.000Z' }),
            fetchCommentDeltas: async () => ({ deltas: [], nextCursor: '2026-01-01T00:00:00.000Z' }),
            stateKeyToColumn: (k) => k,
            refreshLocalPlanFromRemote: async () => {},
        };
        const sinks = { moves: [], comments: [] };
        const svc = makeService(db, provider, sinks);
        await poll(svc);
        movedTo = sinks.moves[0] && sinks.moves[0].col;
        assert.strictEqual(movedTo, 'CODER CODED', 'E: notion plan matched by notionPageId and mirrored');
    }

    // ── F. Unmatched state delta → import as a new local plan, then mirror its column.
    {
        const db = makeDb(Object.assign({}, BASE_CONFIG, { provider: 'notion' }));
        db.setPlans([]); // nothing tracked locally yet
        db._store.set('remote.stateCursor.notion', '2026-01-01T00:00:00.000Z');
        db._store.set('remote.commentCursor.notion', '2026-01-01T00:00:00.000Z');
        let imported = null;
        const provider = {
            kind: 'notion',
            fetchStateDeltas: async () => ({ deltas: [{ remoteId: 'NEWPAGE', stateKey: 'CODER CODED' }], nextCursor: '2026-01-03T00:00:00.000Z' }),
            fetchCommentDeltas: async () => ({ deltas: [], nextCursor: '2026-01-01T00:00:00.000Z' }),
            stateKeyToColumn: (k) => k,
            refreshLocalPlanFromRemote: async () => {},
            importRemotePlan: async (id) => { imported = id; return makePlan({ planId: 'imported', notionPageId: id, kanbanColumn: 'CREATED', linearIssueId: '' }); },
        };
        const sinks = { moves: [], comments: [] };
        await poll(makeService(db, provider, sinks));
        assert.strictEqual(imported, 'NEWPAGE', 'F: unmatched remote item imported as a new plan');
        assert.deepStrictEqual(sinks.moves, [{ planId: 'imported', col: 'CODER CODED' }], 'F: imported plan then mirrored to its column');
    }

    console.log('remote-control-service tests passed');
}

run().catch((err) => { console.error(err); process.exit(1); });
