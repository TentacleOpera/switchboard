import * as assert from 'assert';

// Type definition matching JulesSessionRecord from TaskViewerProvider.ts
type JulesSessionRecord = {
    sessionId: string;
    planSessionId?: string;
    planName?: string;
    url?: string;
    julesStatus?: string;
    switchboardStatus?: 'Sent' | 'Send Failed' | 'Working' | 'Pulling' | 'Pull Failed' | 'Failed' | 'Reviewing' | 'Reviewing (No Agent)' | 'Completed' | 'Completed (No Changes)';
    patchFile?: string;
    lastCheckedAt?: string;
};

/**
 * Filters sessions to exclude completed ones from display.
 * This is a pure function extracted from TaskViewerProvider for testability.
 */
function filterActiveSessions(sessions: JulesSessionRecord[]): JulesSessionRecord[] {
    return sessions.filter(entry => {
        const status = entry.switchboardStatus;
        return status !== 'Completed' && status !== 'Completed (No Changes)';
    });
}

async function run() {
    console.log('Running Jules Status Filter Tests...\n');

    // Test Case 1: Active session is preserved
    console.log('Test 1: Active session is preserved');
    const activeSession: JulesSessionRecord = {
        sessionId: 'session-001',
        planSessionId: 'plan-001',
        planName: 'Test Feature',
        switchboardStatus: 'Working'
    };
    const result1 = filterActiveSessions([activeSession]);
    assert.strictEqual(result1.length, 1, 'Active session should be preserved');
    assert.strictEqual(result1[0].sessionId, 'session-001', 'Session ID should match');
    console.log('✓ Passed\n');

    // Test Case 2: Completed session is filtered out
    console.log('Test 2: Completed session is filtered out');
    const completedSession: JulesSessionRecord = {
        sessionId: 'session-002',
        planSessionId: 'plan-002',
        planName: 'Completed Feature',
        switchboardStatus: 'Completed'
    };
    const result2 = filterActiveSessions([completedSession]);
    assert.strictEqual(result2.length, 0, 'Completed session should be filtered out');
    console.log('✓ Passed\n');

    // Test Case 3: Completed (No Changes) session is filtered out
    console.log('Test 3: Completed (No Changes) session is filtered out');
    const completedNoChangesSession: JulesSessionRecord = {
        sessionId: 'session-003',
        planSessionId: 'plan-003',
        planName: 'No Changes Feature',
        switchboardStatus: 'Completed (No Changes)'
    };
    const result3 = filterActiveSessions([completedNoChangesSession]);
    assert.strictEqual(result3.length, 0, 'Completed (No Changes) session should be filtered out');
    console.log('✓ Passed\n');

    // Test Case 4: Failed or Error session is preserved
    console.log('Test 4: Failed session is preserved');
    const failedSession: JulesSessionRecord = {
        sessionId: 'session-004',
        planSessionId: 'plan-004',
        planName: 'Failed Feature',
        switchboardStatus: 'Failed'
    };
    const result4 = filterActiveSessions([failedSession]);
    assert.strictEqual(result4.length, 1, 'Failed session should be preserved');
    assert.strictEqual(result4[0].switchboardStatus, 'Failed', 'Failed status should be preserved');
    console.log('✓ Passed\n');

    // Test Case 5: Reviewing session is preserved
    console.log('Test 5: Reviewing session is preserved');
    const reviewingSession: JulesSessionRecord = {
        sessionId: 'session-005',
        planSessionId: 'plan-005',
        planName: 'Reviewing Feature',
        switchboardStatus: 'Reviewing'
    };
    const result5 = filterActiveSessions([reviewingSession]);
    assert.strictEqual(result5.length, 1, 'Reviewing session should be preserved');
    assert.strictEqual(result5[0].switchboardStatus, 'Reviewing', 'Reviewing status should be preserved');
    console.log('✓ Passed\n');

    // Test Case 6: Mixed sessions are filtered correctly
    console.log('Test 6: Mixed sessions are filtered correctly');
    const mixedSessions: JulesSessionRecord[] = [
        { sessionId: 's1', planSessionId: 'p1', planName: 'Active 1', switchboardStatus: 'Working' },
        { sessionId: 's2', planSessionId: 'p2', planName: 'Completed 1', switchboardStatus: 'Completed' },
        { sessionId: 's3', planSessionId: 'p3', planName: 'Active 2', switchboardStatus: 'Sent' },
        { sessionId: 's4', planSessionId: 'p4', planName: 'Completed 2', switchboardStatus: 'Completed (No Changes)' },
        { sessionId: 's5', planSessionId: 'p5', planName: 'Failed 1', switchboardStatus: 'Failed' },
        { sessionId: 's6', planSessionId: 'p6', planName: 'Reviewing 1', switchboardStatus: 'Reviewing' }
    ];
    const result6 = filterActiveSessions(mixedSessions);
    assert.strictEqual(result6.length, 4, 'Should have 4 active sessions (Working, Sent, Failed, Reviewing)');
    const remainingIds = result6.map(s => s.sessionId);
    assert.ok(remainingIds.includes('s1'), 'Working session should remain');
    assert.ok(remainingIds.includes('s3'), 'Sent session should remain');
    assert.ok(remainingIds.includes('s5'), 'Failed session should remain');
    assert.ok(remainingIds.includes('s6'), 'Reviewing session should remain');
    assert.ok(!remainingIds.includes('s2'), 'Completed session should be removed');
    assert.ok(!remainingIds.includes('s4'), 'Completed (No Changes) session should be removed');
    console.log('✓ Passed\n');

    // Test Case 7: Sessions without switchboardStatus are preserved
    console.log('Test 7: Sessions without switchboardStatus are preserved');
    const noStatusSession: JulesSessionRecord = {
        sessionId: 'session-007',
        planSessionId: 'plan-007',
        planName: 'No Status Feature'
    };
    const result7 = filterActiveSessions([noStatusSession]);
    assert.strictEqual(result7.length, 1, 'Session without status should be preserved');
    console.log('✓ Passed\n');

    console.log('All tests passed! ✓');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
