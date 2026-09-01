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

    // Capabilities check
    assert.strictEqual(provider.capabilities.agentSurface, true, 'Linear declares agentSurface capability');
    assert.strictEqual(provider.capabilities.agentSessions, true, 'Linear declares agentSessions capability');

    // Assigned issues poll test
    const assignedPlans = [];
    const mockDb = {
        findPlanByLinearIssueId: async (wsId, issueId) => {
            return assignedPlans.find(p => p.linearIssueId === issueId) || null;
        }
    };
    const linearAppMock = {
        fetchAssignedIssues: async () => [
            { id: 'ISSUE_ASSIGNED', identifier: 'ENG-101', title: 'Assigned Task' }
        ],
        fetchMentionNotifications: async () => [
            {
                id: 'notif-1',
                type: 'commentMention',
                comment: {
                    id: 'c-mention-1',
                    body: 'Please check this edge case',
                    issue: { id: 'ISSUE_ASSIGNED', identifier: 'ENG-101' }
                }
            }
        ],
        archiveNotification: async (id) => {
            archivedNotifs.push(id);
            return true;
        },
        getOrCreateAgentSession: async (issueId) => `session-${issueId}`,
        postAgentActivity: async (sessionId, content, ephemeral) => {
            postedActivities.push({ sessionId, content, ephemeral });
            return true;
        }
    };
    const archivedNotifs = [];
    const postedActivities = [];
    const promptDeliveries = [];

    const appProvider = new LinearRemoteProvider(linearAppMock, {
        db: mockDb,
        getWorkspaceId: async () => 'ws-1',
        terminalVerb: async (verb, payload) => {
            if (verb === 'ptyListTerminals') {
                return { terminals: [{ friendlyName: 'seat-1', status: 'active' }] };
            }
            if (verb === 'ptySendPrompt') {
                promptDeliveries.push(payload);
                return { success: true };
            }
            return { success: true };
        }
    });

    appProvider.importRemotePlan = async (remoteId) => {
        const plan = { planId: 'plan-1', linearIssueId: remoteId, dispatchedTerminal: 'seat-1' };
        assignedPlans.push(plan);
        return plan;
    };

    // 1. Poll assigned issues
    await appProvider.pollAssignedIssues(mockDb, 'ws-1');
    assert.strictEqual(assignedPlans.length, 1);
    assert.strictEqual(assignedPlans[0].linearIssueId, 'ISSUE_ASSIGNED');

    // 2. Poll mentions and relay to seat
    await appProvider.pollMentionsAndRelay(mockDb, 'ws-1');
    assert.strictEqual(promptDeliveries.length, 1, 'Delivered mention to live seat');
    assert.strictEqual(promptDeliveries[0].name, 'seat-1');
    assert.strictEqual(promptDeliveries[0].clearBeforePrompt, false);
    assert.match(promptDeliveries[0].data, /=== LINEAR MENTION: ENG-101 ===/);
    assert.match(promptDeliveries[0].data, /Please check this edge case/);
    assert.strictEqual(archivedNotifs.includes('notif-1'), true, 'Notification archived after delivery');

    // 3. Post agent activity
    const activityOk = await appProvider.postAgentActivity('ISSUE_ASSIGNED', 'Started implementation', true);
    assert.strictEqual(activityOk, true);
    assert.strictEqual(postedActivities.length, 1);
    assert.strictEqual(postedActivities[0].sessionId, 'session-ISSUE_ASSIGNED');
    assert.strictEqual(postedActivities[0].content, 'Started implementation');
    assert.strictEqual(postedActivities[0].ephemeral, true);

    console.log('linear-remote-provider tests passed');
}

run().catch((err) => { console.error(err); process.exit(1); });
