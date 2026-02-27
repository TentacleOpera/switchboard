import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionActionLog } from '../services/SessionActionLog';

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs: number = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const done = await predicate();
        if (done) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Timeout waiting for condition');
}

async function run() {
    const root = path.join(os.tmpdir(), `switchboard-session-log-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });

    const log = new SessionActionLog(root);
    const activityPath = path.join(root, '.switchboard', 'sessions', 'activity.jsonl');

    // Test 1: logEvent shape
    await log.logEvent('workflow_event', { action: 'start_workflow', workflow: 'handoff' });
    await waitFor(async () => fs.existsSync(activityPath) && (await fs.promises.readFile(activityPath, 'utf8')).trim().length > 0);
    const firstRows = (await fs.promises.readFile(activityPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
    assert.strictEqual(firstRows[0].type, 'workflow_event');
    assert.ok(typeof firstRows[0].timestamp === 'string');
    assert.strictEqual(firstRows[0].payload.workflow, 'handoff');

    // Test 2: sensitive redaction
    await log.logEvent('workflow_event', {
        token: 'abc123',
        password: 'secret',
        nested: { apiKey: 'xyz', ok: 'yes' }
    });
    const rowsAfterRedaction = (await fs.promises.readFile(activityPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
    const redactionRow = rowsAfterRedaction[rowsAfterRedaction.length - 1];
    assert.strictEqual(redactionRow.payload.token, '[REDACTED]');
    assert.strictEqual(redactionRow.payload.password, '[REDACTED]');
    assert.strictEqual(redactionRow.payload.nested.apiKey, '[REDACTED]');
    assert.strictEqual(redactionRow.payload.nested.ok, 'yes');

    // Test 3: retry behavior on append failure
    const originalAppendFile = fs.promises.appendFile.bind(fs.promises);
    let attempts = 0;
    try {
        (fs.promises as any).appendFile = async (...args: any[]) => {
            attempts += 1;
            if (attempts < 3) {
                throw new Error('simulated append failure');
            }
            return originalAppendFile(...args);
        };
        await log.logEvent('workflow_event', { action: 'retry_check' });
        await waitFor(async () => {
            const rows = (await fs.promises.readFile(activityPath, 'utf8')).trim().split('\n');
            return rows.some(line => line.includes('"retry_check"'));
        });
        assert.ok(attempts >= 3, `expected retry attempts, got ${attempts}`);
    } finally {
        (fs.promises as any).appendFile = originalAppendFile;
    }

    // Test 4: plan_management summary/truncation behavior
    await log.logEvent('plan_management', {
        operation: 'update_plan',
        planFile: '.switchboard/plans/features/demo.md',
        content: 'line1\nline2\nline3',
        beforeContent: 'line1',
        afterContent: 'line1\nline2'
    });
    const rowsAfterPlan = (await fs.promises.readFile(activityPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
    const planRow = rowsAfterPlan[rowsAfterPlan.length - 1];
    assert.strictEqual(planRow.type, 'plan_management');
    assert.strictEqual(planRow.payload.operation, 'update_plan');
    assert.strictEqual(planRow.payload.contentLineCount, 3);
    assert.strictEqual(planRow.payload.beforeLineCount, 1);
    assert.strictEqual(planRow.payload.afterLineCount, 2);
    assert.strictEqual(planRow.payload.content, undefined);

    // Test 5: Lazy Loading Pagination
    // Generate 100 events
    for (let i = 0; i < 100; i++) {
        await log.logEvent('spam', { idx: i });
    }
    // Wait for flush
    await waitFor(async () => {
        const rows = (await fs.promises.readFile(activityPath, 'utf8')).trim().split('\n');
        return rows.length >= 104; // 4 prev + 100
    });

    const page1 = await log.getRecentActivity(50);
    assert.strictEqual(page1.events.length, 50);
    assert.ok(page1.hasMore);
    assert.ok(page1.nextCursor);
    // Events are transformed to summary type by _aggregateEvents
    assert.strictEqual(page1.events[0].type, 'summary');

    const page2 = await log.getRecentActivity(50, page1.nextCursor);
    assert.strictEqual(page2.events.length, 50);

    // Test 6: Aggregation into summary event with plan title mapping
    const summarySessionId = 'sess_summary_1';
    await log.createRunSheet(summarySessionId, { planName: 'Alpha Plan', events: [] });
    const baseTs = Date.now() + 10_000;
    const syntheticEvents = [
        {
            timestamp: new Date(baseTs).toISOString(),
            type: 'ui_action',
            payload: { action: 'triggerAgentAction', role: 'reviewer', sessionId: summarySessionId }
        },
        {
            timestamp: new Date(baseTs + 120).toISOString(),
            type: 'dispatch',
            payload: { event: 'dispatch_sent', role: 'reviewer', sessionId: summarySessionId }
        },
        {
            timestamp: new Date(baseTs + 240).toISOString(),
            type: 'sent',
            payload: { event: 'sent', role: 'reviewer', sessionId: summarySessionId }
        }
    ];
    await fs.promises.appendFile(activityPath, `${syntheticEvents.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const summaryPage = await log.getRecentActivity(200);
    const summaryEvent = summaryPage.events.find(event => event.type === 'summary' && event.payload?.sessionId === summarySessionId);
    assert.ok(summaryEvent, 'expected summary event for UI+dispatch+sent sequence');
    assert.strictEqual(summaryEvent?.payload?.planTitle, 'Alpha Plan');
    assert.ok(String(summaryEvent?.payload?.message || '').includes('SENT TO'), `expected SENT TO in message, got: ${summaryEvent?.payload?.message}`);

    // Test 7: Run Sheet Management
    await log.createRunSheet('sess_test_1', { topic: 'test', events: [] });
    let sheet = await log.getRunSheet('sess_test_1');
    assert.strictEqual(sheet.sessionId, 'sess_test_1');
    assert.strictEqual(sheet.topic, 'test');

    await log.updateRunSheet('sess_test_1', (s) => { s.topic = 'updated'; return s; });
    sheet = await log.getRunSheet('sess_test_1');
    assert.strictEqual(sheet.topic, 'updated');

    const sheets = await log.getRunSheets();
    assert.ok(sheets.some(s => s.sessionId === 'sess_test_1'));

    await log.deleteRunSheet('sess_test_1');
    sheet = await log.getRunSheet('sess_test_1');
    assert.strictEqual(sheet, null);

    // Test 8: Log Rotation (Mock size check)
    // We can't easily force 5MB file size in test without slow I/O, but we can verify
    // logic holds. We rely on manual check or integration for rotation.
    // However, we can test that it doesn't crash.

    // Test Case 1 (Timing): Events 800ms apart should be aggregated; events >1000ms apart should not
    const timingSessionId = 'sess_timing_1';
    await log.createRunSheet(timingSessionId, { planName: 'Timing Test', events: [] });
    const timingBase = Date.now() + 50_000;
    await fs.promises.appendFile(activityPath, [
        // Pair A: 800ms apart — should be aggregated into 1 summary
        JSON.stringify({ timestamp: new Date(timingBase).toISOString(), type: 'ui_action', payload: { action: 'triggerAgentAction', role: 'lead', sessionId: timingSessionId } }),
        JSON.stringify({ timestamp: new Date(timingBase + 800).toISOString(), type: 'dispatch', payload: { event: 'dispatch_sent', role: 'lead', sessionId: timingSessionId } }),
        // Pair B: 1200ms apart — should NOT be aggregated
        JSON.stringify({ timestamp: new Date(timingBase + 5000).toISOString(), type: 'ui_action', payload: { action: 'triggerAgentAction', role: 'coder', sessionId: timingSessionId } }),
        JSON.stringify({ timestamp: new Date(timingBase + 6200).toISOString(), type: 'dispatch', payload: { event: 'dispatch_sent', role: 'coder', sessionId: timingSessionId } }),
    ].join('\n') + '\n', 'utf8');
    const timingPage = await log.getRecentActivity(200);
    const timingEvents = timingPage.events.filter(e => e.payload?.sessionId === timingSessionId);
    // Pair A (800ms): ui_action + dispatch → 1 summary
    const pairAEvents = timingEvents.filter(e => e.payload?.role === 'lead');
    assert.strictEqual(pairAEvents.length, 1, `Pair A (800ms) should collapse to 1 event, got ${pairAEvents.length}`);
    // Pair B (1200ms): ui_action stays, dispatch stays → 2 summaries
    const pairBEvents = timingEvents.filter(e => e.payload?.role === 'coder');
    assert.strictEqual(pairBEvents.length, 2, `Pair B (1200ms) should stay as 2 events, got ${pairBEvents.length}`);

    // Test Case 2 (Semantic Merge): ui_action + dispatch within 500ms → only dispatch kept
    const mergeSessionId = 'sess_merge_1';
    await log.createRunSheet(mergeSessionId, { planName: 'Merge Test', events: [] });
    const mergeBase = Date.now() + 100_000;
    await fs.promises.appendFile(activityPath, [
        JSON.stringify({ timestamp: new Date(mergeBase).toISOString(), type: 'ui_action', payload: { action: 'triggerAgentAction', role: 'jules', sessionId: mergeSessionId } }),
        JSON.stringify({ timestamp: new Date(mergeBase + 300).toISOString(), type: 'dispatch', payload: { event: 'dispatch_sent', role: 'jules', sessionId: mergeSessionId } }),
    ].join('\n') + '\n', 'utf8');
    const mergePage = await log.getRecentActivity(200);
    const mergeEvents = mergePage.events.filter(e => e.payload?.sessionId === mergeSessionId);
    assert.strictEqual(mergeEvents.length, 1, `Semantic merge: ui_action + dispatch within 500ms should collapse to 1 event, got ${mergeEvents.length}`);
    assert.ok(String(mergeEvents[0]?.payload?.message || '').includes('SENT TO'), `Merged event should use dispatch message, got: ${mergeEvents[0]?.payload?.message}`);

    // Test Case 3 (Correlation ID): events >1000ms apart with same correlationId should still be merged
    const corrSessionId = 'sess_corr_1';
    await log.createRunSheet(corrSessionId, { planName: 'Correlation Test', events: [] });
    const corrBase = Date.now() + 200_000;
    const corrId = 'test-corr-id-abc123';
    await fs.promises.appendFile(activityPath, [
        JSON.stringify({ timestamp: new Date(corrBase).toISOString(), type: 'ui_action', correlationId: corrId, payload: { action: 'triggerAgentAction', role: 'reviewer', sessionId: corrSessionId } }),
        JSON.stringify({ timestamp: new Date(corrBase + 1500).toISOString(), type: 'dispatch', correlationId: corrId, payload: { event: 'dispatch_sent', role: 'reviewer', sessionId: corrSessionId } }),
    ].join('\n') + '\n', 'utf8');
    const corrPage = await log.getRecentActivity(200);
    const corrEvents = corrPage.events.filter(e => e.payload?.sessionId === corrSessionId);
    assert.strictEqual(corrEvents.length, 1, `Correlation ID: events 1500ms apart with same correlationId should merge to 1 event, got ${corrEvents.length}`);

    // Test: 'received' event is suppressed in live feed
    const receivedSessionId = 'sess_received_suppress';
    await log.createRunSheet(receivedSessionId, { planName: 'Received Suppress Test', events: [] });
    const receivedBase = Date.now() + 300_000;
    await fs.promises.appendFile(activityPath,
        JSON.stringify({ timestamp: new Date(receivedBase).toISOString(), type: 'dispatch', payload: { event: 'received', role: 'coder', sessionId: receivedSessionId } }) + '\n',
        'utf8'
    );
    const receivedPage = await log.getRecentActivity(200);
    const receivedEvents = receivedPage.events.filter(e => e.payload?.sessionId === receivedSessionId);
    assert.strictEqual(receivedEvents.length, 0, `'received' event should be suppressed from live feed, got ${receivedEvents.length}`);

    // Test: 'submit_result' event is visible as COMPLETED
    const submitSessionId = 'sess_submit_result';
    await log.createRunSheet(submitSessionId, { planName: 'Submit Result Test', events: [] });
    const submitBase = Date.now() + 400_000;
    await fs.promises.appendFile(activityPath,
        JSON.stringify({ timestamp: new Date(submitBase).toISOString(), type: 'dispatch', payload: { event: 'submit_result', role: 'lead', sessionId: submitSessionId } }) + '\n',
        'utf8'
    );
    const submitPage = await log.getRecentActivity(200);
    const submitEvents = submitPage.events.filter(e => e.payload?.sessionId === submitSessionId);
    assert.strictEqual(submitEvents.length, 1, `'submit_result' event should appear in live feed, got ${submitEvents.length}`);
    assert.ok(String(submitEvents[0]?.payload?.message || '').includes('COMPLETED'), `submit_result message should include 'COMPLETED', got: ${submitEvents[0]?.payload?.message}`);

    // Cleanup
    if (fs.existsSync(root)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
    // eslint-disable-next-line no-console
    console.log('session-action-log tests passed');
}

run().catch(error => {
    // eslint-disable-next-line no-console
    console.error('session-action-log tests failed:', error);
    process.exit(1);
});
