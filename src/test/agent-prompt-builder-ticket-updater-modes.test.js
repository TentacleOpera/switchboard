'use strict';

const assert = require('assert');
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');
const { parseCustomAgentAddons } = require('../../out/services/agentConfig');

function testTicketUpdateModes() {
    console.log('\nTesting ticket triager prompt (collapsed single behavior)...');

    const plans = [{ sessionId: 'sess1', title: 'Plan 1', topic: 'Plan 1', absolutePath: '/path/to/plan1.md' }];

    // The role now always performs triage-only verdicts regardless of the stored
    // ticketUpdateMode value. The legacy 4-mode directives must be gone.
    const modes = ['disabled', 'comment-only', 'refine-ticket', 'research-and-refine', undefined];
    for (const mode of modes) {
        const prompt = buildKanbanBatchPrompt('ticket_updater', plans, mode === undefined ? {} : { ticketUpdateMode: mode });
        assert.ok(prompt.includes('Ticket Triager Agent'), `mode=${mode}: should use the triager prompt`);
        assert.ok(prompt.includes('**Severity:**'), `mode=${mode}: should include the triage verdict shape`);
        assert.ok(prompt.includes('**Routing:**'), `mode=${mode}: should include the routing field`);
        assert.ok(prompt.includes('NEVER overwrite the ticket description'), `mode=${mode}: should forbid description overwrite`);
        // Legacy mode directives are gone.
        assert.ok(!prompt.includes('TICKET UPDATE MODE'), `mode=${mode}: legacy mode directive should be removed`);
        assert.ok(!prompt.includes('add an "AI Analysis" comment'), `mode=${mode}: legacy comment directive removed`);
        assert.ok(!prompt.includes('refine the ticket description'), `mode=${mode}: legacy refine directive removed`);
        assert.ok(!prompt.includes('web_research skill'), `mode=${mode}: legacy research directive removed`);
    }

    // Migration: the ticketUpdateMode config key is still readable (value ignored at
    // prompt time) so old stored configs don't error.
    const migratedTrue = parseCustomAgentAddons({ ticketUpdateEnabled: true });
    assert.strictEqual(migratedTrue?.ticketUpdateMode, 'comment-only', 'ticketUpdateEnabled=true should migrate to comment-only');

    const migratedFalse = parseCustomAgentAddons({ ticketUpdateEnabled: false });
    assert.strictEqual(migratedFalse?.ticketUpdateMode, 'disabled', 'ticketUpdateEnabled=false should migrate to disabled');

    const migratedNewMode = parseCustomAgentAddons({ ticketUpdateMode: 'refine-ticket' });
    assert.strictEqual(migratedNewMode?.ticketUpdateMode, 'refine-ticket', 'ticketUpdateMode should still pass through when present');

    console.log('Ticket triager prompt tests PASSED!');
}

try {
    testTicketUpdateModes();
} catch (err) {
    console.error('\nTest FAILED:', err.message);
    process.exit(1);
}
