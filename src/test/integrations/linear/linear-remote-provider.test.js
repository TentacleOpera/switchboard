'use strict';

// LinearRemoteProvider: state + comments are TWO SEPARATE queries. A Linear comment does
// NOT bump the issue's updatedAt (research-confirmed), so comments must be queried via the
// `comments` entity directly and matched back via `issue.id`.

const assert = require('assert');
const { loadOutModule } = require('../shared/test-harness');

const { LinearRemoteProvider } = loadOutModule('services/remote/LinearRemoteProvider.js');
const { stampMarker } = loadOutModule('services/commentMarker.js');

function makeLinear(queries) {
    return {
        loadConfig: async () => ({ setupComplete: true, columnToStateId: { 'CODER CODED': 'state-coded' } }),
        graphqlRequest: async (query) => {
            queries.push(query);
            if (/issues\s*\(/.test(query)) {
                return { data: { issues: { nodes: [
                    { id: 'ISSUE1', updatedAt: '2026-01-02T00:00:00.000Z', state: { id: 'state-coded' } },
                ] } } };
            }
            if (/comments\s*\(/.test(query)) {
                return { data: { comments: { nodes: [
                    { id: 'c1', body: 'human comment', createdAt: '2026-01-02T00:00:00.000Z', issue: { id: 'ISSUE1' } },
                    { id: 'c2', body: stampMarker('switchboard reply'), createdAt: '2026-01-02T00:01:00.000Z', issue: { id: 'ISSUE1' } },
                ] } } };
            }
            return { data: {} };
        },
    };
}

async function run() {
    const queries = [];
    const provider = new LinearRemoteProvider(makeLinear(queries));

    // State deltas via the issues query.
    const state = await provider.fetchStateDeltas('2026-01-01T00:00:00.000Z');
    assert.deepStrictEqual(state.deltas, [{ remoteId: 'ISSUE1', stateKey: 'state-coded' }], 'state delta mapped from issues query');
    assert.strictEqual(state.nextCursor, '2026-01-02T00:00:00.000Z', 'state cursor = max updatedAt');
    assert.strictEqual(provider.stateKeyToColumn('state-coded'), 'CODER CODED', 'reverse state→column map');
    assert.strictEqual(provider.stateKeyToColumn('nope'), undefined, 'unknown state → undefined');

    // Comment deltas via the SEPARATE comments query (not piggybacked on issues).
    const comments = await provider.fetchCommentDeltas('2026-01-01T00:00:00.000Z');
    assert.strictEqual(comments.deltas.length, 2, 'both comments returned');
    assert.strictEqual(comments.deltas[0].remoteId, 'ISSUE1', 'comment matched back to issue.id');
    assert.strictEqual(comments.deltas[0].authoredBySelf, false, 'human comment is not self');
    assert.strictEqual(comments.deltas[1].authoredBySelf, true, 'marker comment flagged as self');
    assert.strictEqual(comments.nextCursor, '2026-01-02T00:01:00.000Z', 'comment cursor = max createdAt');

    // Verify the two queries are distinct entities.
    assert.ok(queries.some((q) => /issues\s*\(/.test(q) && /updatedAt/.test(q)), 'issued an issues/updatedAt query');
    assert.ok(queries.some((q) => /comments\s*\(/.test(q) && /createdAt/.test(q)), 'issued a comments/createdAt query');

    // refreshLocalPlanFromRemote is a no-op for Linear (preserves existing behavior).
    await provider.refreshLocalPlanFromRemote('ISSUE1');

    console.log('linear-remote-provider tests passed');
}

run().catch((err) => { console.error(err); process.exit(1); });
