'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    // The copyToClipboard implementation moved out of PlanningPanelProvider.ts into
    // sharedUtilityVerbs.ts (handleCopyToClipboard), and the Tickets front-end moved
    // out of planning.js into tickets.js, during the Tickets panel extraction. This
    // test follows the logic to its real owners — pointing it at the old files made
    // it fail for the wrong reason while the actual regressions went unnoticed.
    const verbsPath = path.join(process.cwd(), 'src', 'services', 'sharedUtilityVerbs.ts');
    const verbsSource = fs.readFileSync(verbsPath, 'utf8');

    // (a) The copy path resolves a real local ticket file rather than reconstructing one
    assert.ok(
        verbsSource.includes('findTicketFilePath'),
        'Expected sharedUtilityVerbs.ts to resolve ticket paths via findTicketFilePath'
    );

    // (b) The copied path does NOT use '@' + prefix
    assert.ok(
        !verbsSource.includes("'@' + filePath"),
        "Expected sharedUtilityVerbs.ts to NOT prefix copied path with '@'"
    );
    assert.ok(
        verbsSource.includes('paths.push(filePath)'),
        "Expected sharedUtilityVerbs.ts to push filePath without '@' prefix"
    );

    // (c) The backend posts a ticketLinkCopied message on success and ticketLinkFailed on failure
    assert.ok(
        verbsSource.includes("type: 'ticketLinkCopied'"),
        'Expected sharedUtilityVerbs.ts to post ticketLinkCopied message'
    );
    assert.ok(
        verbsSource.includes("type: 'ticketLinkFailed'"),
        'Expected sharedUtilityVerbs.ts to post ticketLinkFailed message'
    );

    // (d) Both panel providers route the verb to that shared handler
    for (const provider of ['PlanningPanelProvider.ts', 'TicketsPanelProvider.ts']) {
        const source = fs.readFileSync(path.join(process.cwd(), 'src', 'services', provider), 'utf8');
        assert.ok(
            source.includes('handleCopyToClipboard'),
            `Expected ${provider} to route copyToClipboard to handleCopyToClipboard`
        );
    }

    const ticketsJsPath = path.join(process.cwd(), 'src', 'webview', 'tickets.js');
    const ticketsJsSource = fs.readFileSync(ticketsJsPath, 'utf8');

    // (e) tickets.js handles both result messages in its message listener
    assert.ok(
        ticketsJsSource.includes("case 'ticketLinkCopied':"),
        'Expected tickets.js to handle ticketLinkCopied message'
    );
    assert.ok(
        ticketsJsSource.includes("case 'ticketLinkFailed':"),
        'Expected tickets.js to handle ticketLinkFailed message'
    );

    // (f) handleLinkToTicket does NOT flash the button synchronously — the flash is
    //     driven by the ticketLinkCopied reply so a failure does not read as success.
    const handleLinkStart = ticketsJsSource.indexOf('function handleLinkToTicket');
    assert.ok(handleLinkStart !== -1, 'Expected handleLinkToTicket to live in tickets.js');
    const handleLinkBlock = ticketsJsSource.slice(handleLinkStart, ticketsJsSource.indexOf('\n    }', handleLinkStart));
    assert.ok(
        !handleLinkBlock.includes('flashIconBtn'),
        'Expected handleLinkToTicket to NOT flash the button synchronously'
    );

    // (g) The ticketLinkFailed handler surfaces the backend error text
    assert.ok(
        ticketsJsSource.includes('message.error ||'),
        'Expected ticketLinkFailed handler in tickets.js to surface message.error'
    );

    // (h) REGRESSION GUARD: the "Link all" button must actually have a click listener.
    //     The extraction moved the #tickets-link-all accessor into tickets.js but left
    //     its listener behind in planning.js, where it was deleted — so the button was
    //     present, styled, and completely inert. An accessor alone is not wiring.
    assert.ok(
        ticketsJsSource.includes("linkAllButton: document.getElementById('tickets-link-all')"),
        'Expected tickets.js to look up the #tickets-link-all button'
    );
    const linkAllWiring = /linkAllButton\s*\??\.\s*addEventListener\(\s*'click'/.test(ticketsJsSource);
    assert.ok(
        linkAllWiring,
        'Expected tickets.js to attach a click listener to linkAllButton (the "Link all" button is inert without it)'
    );
    // ...and that listener must post the copyToClipboard verb with a ticketIds array,
    // which is what distinguishes "link all" from the whole-directory copy fallback.
    const linkAllStart = ticketsJsSource.search(/linkAllButton\s*\??\.\s*addEventListener/);
    const linkAllBlock = ticketsJsSource.slice(linkAllStart, linkAllStart + 900);
    assert.ok(
        linkAllBlock.includes("type: 'copyToClipboard'") && linkAllBlock.includes('ticketIds'),
        'Expected the Link all listener to post copyToClipboard with a ticketIds array'
    );
    assert.ok(
        linkAllBlock.includes('getFilteredLinearIssues') && linkAllBlock.includes('getFilteredClickUpTasks'),
        'Expected the Link all listener to collect ids from the filtered list for both providers'
    );

    console.log('tickets link-to-ticket regression test passed');
}

try {
    run();
} catch (error) {
    console.error('tickets link-to-ticket regression test failed:', error);
    process.exit(1);
}
