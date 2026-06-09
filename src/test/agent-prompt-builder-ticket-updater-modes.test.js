'use strict';

const assert = require('assert');
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');
const { parseCustomAgentAddons } = require('../../out/services/agentConfig');

function testTicketUpdateModes() {
    console.log('\nTesting ticket update mode prompts...');
    
    const plans = [{ sessionId: 'sess1', title: 'Plan 1', topic: 'Plan 1', absolutePath: '/path/to/plan1.md' }];
    
    // Test disabled mode
    const disabledPrompt = buildKanbanBatchPrompt('ticket_updater', plans, { ticketUpdateMode: 'disabled' });
    assert.ok(!disabledPrompt.includes('TICKET UPDATE MODE'), 'Disabled mode should not include ticket update directive');
    assert.ok(!disabledPrompt.includes('web_research skill'), 'Disabled mode should not include research directive');
    
    // Test comment-only mode
    const commentOnlyPrompt = buildKanbanBatchPrompt('ticket_updater', plans, { ticketUpdateMode: 'comment-only' });
    assert.ok(commentOnlyPrompt.includes('add an "AI Analysis" comment'), 'Comment-only mode should include comment directive');
    assert.ok(!commentOnlyPrompt.includes('refine the ticket description'), 'Comment-only mode should not include refine directive');
    assert.ok(!commentOnlyPrompt.includes('web_research skill'), 'Comment-only mode should not include research directive');
    
    // Test refine-ticket mode
    const refinePrompt = buildKanbanBatchPrompt('ticket_updater', plans, { ticketUpdateMode: 'refine-ticket' });
    assert.ok(refinePrompt.includes('refine the ticket description'), 'Refine mode should include refine directive');
    assert.ok(!refinePrompt.includes('add an "AI Analysis" comment'), 'Refine mode should not include comment directive');
    assert.ok(!refinePrompt.includes('web_research skill'), 'Refine mode should not include research directive');
    
    // Test research-and-refine mode
    const researchPrompt = buildKanbanBatchPrompt('ticket_updater', plans, { ticketUpdateMode: 'research-and-refine' });
    assert.ok(researchPrompt.includes('web_research skill'), 'Research mode should include research directive');
    assert.ok(researchPrompt.includes('refine the ticket description'), 'Research mode should include refine directive');
    assert.ok(!researchPrompt.includes('add an "AI Analysis" comment'), 'Research mode should not include comment directive');
    
    // Test default behavior (no mode specified) — should be disabled
    const defaultPrompt = buildKanbanBatchPrompt('ticket_updater', plans, {});
    assert.ok(!defaultPrompt.includes('TICKET UPDATE MODE'), 'Default mode should be disabled (no ticket update)');
    
    // Test undefined mode falls back to disabled in prompt builder
    const undefinedPrompt = buildKanbanBatchPrompt('ticket_updater', plans, { ticketUpdateMode: undefined });
    assert.ok(!undefinedPrompt.includes('TICKET UPDATE MODE'), 'Undefined mode should fall back to disabled');
    
    // Test migration: parseCustomAgentAddons maps old ticketUpdateEnabled to ticketUpdateMode
    const migratedTrue = parseCustomAgentAddons({ ticketUpdateEnabled: true });
    assert.strictEqual(migratedTrue?.ticketUpdateMode, 'comment-only', 'ticketUpdateEnabled=true should migrate to comment-only');
    
    const migratedFalse = parseCustomAgentAddons({ ticketUpdateEnabled: false });
    assert.strictEqual(migratedFalse?.ticketUpdateMode, 'disabled', 'ticketUpdateEnabled=false should migrate to disabled');
    
    const migratedNewMode = parseCustomAgentAddons({ ticketUpdateMode: 'refine-ticket' });
    assert.strictEqual(migratedNewMode?.ticketUpdateMode, 'refine-ticket', 'ticketUpdateMode should pass through when valid');
    
    console.log('Ticket update mode tests PASSED!');
}

try {
    testTicketUpdateModes();
} catch (err) {
    console.error('\nTest FAILED:', err.message);
    process.exit(1);
}
