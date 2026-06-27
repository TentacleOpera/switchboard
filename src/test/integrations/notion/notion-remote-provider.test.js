'use strict';

// NotionRemoteProvider: delta polling over the plans DB (last_edited_time) and the
// "Switchboard Comments" DB (created_time). Verifies the research-confirmed filter shape
// (NO `property` field), bot-id self-identification, and Plan-relation routing.

const assert = require('assert');
const { loadOutModule } = require('../shared/test-harness');

const { NotionRemoteProvider } = loadOutModule('services/remote/NotionRemoteProvider.js');

function makeNotion(bodies, responses) {
    return {
        httpRequest: async (method, apiPath, body) => {
            bodies.push({ apiPath, body });
            if (apiPath.includes('/databases/PDB/query')) { return { status: 200, data: { results: responses.plans, has_more: false } }; }
            if (apiPath.includes('/databases/CDB/query')) { return { status: 200, data: { results: responses.comments, has_more: false } }; }
            return { status: 404, data: {} };
        },
        getBotId: async () => 'bot-1',
        fetchBlocksRecursive: async () => responses.blocks || [],
        convertBlocksToMarkdown: () => responses.markdown || '',
    };
}

function makeDb(setup) {
    return {
        getConfig: async (key) => (key === 'remote.notion.setup' ? JSON.stringify(setup) : null),
        setConfig: async () => true,
        findPlanByNotionPageId: async () => null,
    };
}

async function run() {
    const setup = { plansDatabaseId: 'PDB', commentsDatabaseId: 'CDB', botId: 'bot-1' };

    // ── State deltas: filter shape + select mapping.
    {
        const bodies = [];
        const notion = makeNotion(bodies, {
            plans: [
                { id: 'PAGE1', last_edited_time: '2026-01-02T00:00:00Z', properties: { 'Kanban Column': { select: { name: 'CODER CODED' } } } },
                { id: 'PAGE2', last_edited_time: '2026-01-02T00:05:00Z', properties: { 'Kanban Column': { select: null } } },
            ],
            comments: [],
        });
        const provider = new NotionRemoteProvider({ notion, db: makeDb(setup), getWorkspaceId: async () => 'ws' });
        const state = await provider.fetchStateDeltas('2026-01-01T00:00:00Z');

        const filter = bodies[0].body.filter;
        assert.strictEqual(filter.timestamp, 'last_edited_time', 'uses timestamp keyword');
        assert.ok(filter.last_edited_time && filter.last_edited_time.on_or_after, 'uses on_or_after');
        assert.ok(!('property' in filter), 'filter MUST NOT include a property field (else 400)');

        assert.deepStrictEqual(state.deltas, [{ remoteId: 'PAGE1', stateKey: 'CODER CODED' }], 'only rows with a column are deltas');
        assert.strictEqual(state.nextCursor, '2026-01-02T00:05:00Z', 'cursor = max last_edited_time');
        assert.strictEqual(provider.stateKeyToColumn('CODER CODED'), 'CODER CODED', 'select name is the column name');
    }

    // ── Comment deltas: self-id via created_by, Plan-relation routing, drop unrouted.
    {
        const bodies = [];
        const notion = makeNotion(bodies, {
            plans: [],
            comments: [
                { id: 'cmt1', created_time: '2026-01-02T00:00:00Z', created_by: { id: 'someone-else' },
                  properties: { 'Plan': { relation: [{ id: 'PAGE1' }] }, 'Message': { title: [{ plain_text: 'do the thing' }] } } },
                { id: 'cmt2', created_time: '2026-01-02T00:01:00Z', created_by: { id: 'bot-1' },
                  properties: { 'Plan': { relation: [{ id: 'PAGE1' }] }, 'Message': { title: [{ plain_text: 'switchboard reply' }] } } },
                { id: 'cmt3', created_time: '2026-01-02T00:02:00Z', created_by: { id: 'someone-else' },
                  properties: { 'Plan': { relation: [] }, 'Message': { title: [{ plain_text: 'orphan' }] } } },
            ],
        });
        const provider = new NotionRemoteProvider({ notion, db: makeDb(setup), getWorkspaceId: async () => 'ws' });
        const res = await provider.fetchCommentDeltas('2026-01-01T00:00:00Z');

        const filter = bodies[0].body.filter;
        assert.strictEqual(filter.timestamp, 'created_time', 'comments filter uses created_time');
        assert.ok(!('property' in filter), 'comments filter MUST NOT include a property field');

        // cmt3 has no Plan relation → dropped; cmt1 + cmt2 returned with correct self flags.
        assert.strictEqual(res.deltas.length, 2, 'unrouted comment (no Plan relation) dropped');
        const byId = Object.fromEntries(res.deltas.map((d) => [d.commentId, d]));
        assert.strictEqual(byId.cmt1.authoredBySelf, false, 'other author → not self');
        assert.strictEqual(byId.cmt1.remoteId, 'PAGE1', 'routed via Plan relation');
        assert.strictEqual(byId.cmt1.body, 'do the thing', 'body from Message title');
        assert.strictEqual(byId.cmt2.authoredBySelf, true, 'created_by === bot id → self');
        assert.strictEqual(res.nextCursor, '2026-01-02T00:02:00Z', 'cursor = max created_time (incl. dropped)');
    }

    // ── Bot-id failure → skip comment ingestion (fail safe, no loop).
    {
        const bodies = [];
        const notion = makeNotion(bodies, { plans: [], comments: [] });
        notion.getBotId = async () => null;
        const provider = new NotionRemoteProvider({ notion, db: makeDb({ plansDatabaseId: 'PDB', commentsDatabaseId: 'CDB', botId: '' }), getWorkspaceId: async () => 'ws' });
        const res = await provider.fetchCommentDeltas('2026-01-01T00:00:00Z');
        assert.deepStrictEqual(res.deltas, [], 'no comment ingestion when bot id unavailable');
        assert.strictEqual(res.nextCursor, '2026-01-01T00:00:00Z', 'cursor unchanged when skipping');
    }

    console.log('notion-remote-provider tests passed');
}

run().catch((err) => { console.error(err); process.exit(1); });
