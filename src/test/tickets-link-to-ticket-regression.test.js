'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const planningProviderPath = path.join(process.cwd(), 'src', 'services', 'PlanningPanelProvider.ts');
    const planningProviderSource = fs.readFileSync(planningProviderPath, 'utf8');

    // (a) The copyToClipboard case in PlanningPanelProvider.ts contains importTaskAsDocument
    assert.ok(
        planningProviderSource.includes('switchboard.importTaskAsDocument'),
        'Expected PlanningPanelProvider.ts to contain switchboard.importTaskAsDocument'
    );

    // (b) The copied path does NOT use '@' + prefix
    assert.ok(
        !planningProviderSource.includes("'@' + filePath"),
        "Expected PlanningPanelProvider.ts to NOT prefix copied path with '@'"
    );
    assert.ok(
        planningProviderSource.includes("paths.push(filePath)"),
        "Expected PlanningPanelProvider.ts to push filePath without '@' prefix"
    );

    // (c) The backend posts a ticketLinkCopied message on success and ticketLinkFailed on failure
    assert.ok(
        planningProviderSource.includes("type: 'ticketLinkCopied'"),
        "Expected PlanningPanelProvider.ts to post ticketLinkCopied message"
    );
    assert.ok(
        planningProviderSource.includes("type: 'ticketLinkFailed'"),
        "Expected PlanningPanelProvider.ts to post ticketLinkFailed message"
    );

    const planningJsPath = path.join(process.cwd(), 'src', 'webview', 'planning.js');
    const planningJsSource = fs.readFileSync(planningJsPath, 'utf8');

    // (d) planning.js has a ticketLinkCopied case in the message listener and calls showTicketsStatus
    assert.ok(
        planningJsSource.includes("case 'ticketLinkCopied':"),
        "Expected planning.js to handle ticketLinkCopied message"
    );
    
    // (e) handleLinkToTicket does NOT call flashCopyBtn synchronously
    const handleLinkStart = planningJsSource.indexOf('function handleLinkToTicket');
    const handleLinkEnd = planningJsSource.indexOf('}', handleLinkStart);
    const handleLinkBlock = planningJsSource.slice(handleLinkStart, handleLinkEnd);
    assert.ok(
        !handleLinkBlock.includes('flashCopyBtn'),
        'Expected handleLinkToTicket to NOT call flashCopyBtn synchronously'
    );

    // (f) The ticketLinkFailed handler surfaces msg.error
    assert.ok(
        planningJsSource.includes('msg.error ||'),
        'Expected ticketLinkFailed handler in planning.js to surface msg.error'
    );

    console.log('tickets link-to-ticket regression test passed');
}

try {
    run();
} catch (error) {
    console.error('tickets link-to-ticket regression test failed:', error);
    process.exit(1);
}
