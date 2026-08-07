const fs = require('fs');
const path = require('path');
const assert = require('assert');

/**
 * Tickets sidebar auto-refresh on local .md changes.
 *
 * Four independent faults produced the original symptom ("agent edits a ticket file, the
 * sidebar shows nothing until you click Refresh"), and each one alone is enough to bring
 * it back — a partial regression looks exactly like the original bug. This pins all four,
 * plus the two host/rename hazards the fix itself introduces.
 */
function testTicketsAutoRefreshOnFileChange() {
    const ticketsJs = fs.readFileSync(path.join(__dirname, '../webview/tickets.js'), 'utf8');
    const providerTs = fs.readFileSync(path.join(__dirname, '../services/TicketsPanelProvider.ts'), 'utf8');
    const standaloneTs = fs.readFileSync(path.join(__dirname, '../standalone/hostServices.ts'), 'utf8');

    // ── Fault 3: a change to a NON-selected ticket must still reload the sidebar ──
    // This is the single highest-value assertion in the file. The pre-fix arm updated the
    // detail cache "so the next click shows fresh content" and stopped, which left the
    // card title stale on screen. Without this the whole feature silently reverts.
    const changedIdx = ticketsJs.indexOf("case 'ticketFileChanged':");
    assert.notStrictEqual(changedIdx, -1, "case 'ticketFileChanged': must exist in tickets.js");
    const changedEnd = ticketsJs.indexOf("case 'ticketFileDeleted':", changedIdx);
    assert.notStrictEqual(changedEnd, -1, "case 'ticketFileDeleted': must follow ticketFileChanged in tickets.js");
    const changedBody = ticketsJs.slice(changedIdx, changedEnd);
    assert.ok(
        changedBody.includes('_scheduleSidebarRefreshFromFiles()'),
        'ticketFileChanged must schedule a sidebar reload for BOTH the selected and non-selected branches'
    );
    // Unconditional: not nested inside the is-this-the-selected-ticket branch.
    assert.match(
        changedBody,
        /\n\s{16}_scheduleSidebarRefreshFromFiles\(\);/,
        'the _scheduleSidebarRefreshFromFiles() call must sit at the arm body level, not inside the selected-ticket branch'
    );

    // The reload has to be debounced — an agent rewriting 30 files fires 30 events.
    const debounceIdx = ticketsJs.indexOf('function _scheduleSidebarRefreshFromFiles()');
    assert.notStrictEqual(debounceIdx, -1, '_scheduleSidebarRefreshFromFiles must exist in tickets.js');
    const debounceBody = ticketsJs.slice(debounceIdx, debounceIdx + 400);
    assert.match(
        debounceBody,
        /clearTimeout\(_ticketFileChangedDebounce\)[\s\S]*setTimeout\([\s\S]*loadLocalTicketFiles\(\)/,
        '_scheduleSidebarRefreshFromFiles must be a trailing-edge debounce around loadLocalTicketFiles'
    );

    // ── Fault 2: the backend watcher must be re-armed whenever the root resolves ──
    // restoreTicketsState runs once, before the root exists, so arming there alone left
    // the watcher dead for the whole session.
    assert.match(
        ticketsJs,
        /function ensureTicketsWatcherArmed\(\)\s*\{[\s\S]*?_armedTicketsWatcherRoot === ticketsWorkspaceRoot[\s\S]*?type: 'setupTicketsWatcher'/,
        'ensureTicketsWatcherArmed must guard on the already-armed root before sending setupTicketsWatcher'
    );
    const armCalls = (ticketsJs.match(/(?<!function )ensureTicketsWatcherArmed\(\)/g) || []).length;
    assert.ok(
        armCalls >= 5,
        `every root-resolution site must (re-)arm the watcher — expected >=5 ensureTicketsWatcherArmed() calls, found ${armCalls}`
    );
    for (const site of ['restoreTicketsState', 'ensureTicketsRootDefault']) {
        const idx = ticketsJs.indexOf(`function ${site}(`);
        assert.notStrictEqual(idx, -1, `${site} must exist in tickets.js`);
        assert.ok(
            ticketsJs.slice(idx, idx + 900).includes('ensureTicketsWatcherArmed()'),
            `${site} must arm the tickets watcher`
        );
    }

    // ── Fault 4 (frontend): deletes clear the card and the detail pane ──
    const deletedIdx = ticketsJs.indexOf("case 'ticketFileDeleted':");
    const deletedBody = ticketsJs.slice(deletedIdx, deletedIdx + 1200);
    assert.ok(
        /selectedClickUpIssue = null/.test(deletedBody) && /selectedLinearIssue = null/.test(deletedBody),
        'ticketFileDeleted must clear the detail pane for whichever provider owned the deleted ticket'
    );
    assert.ok(
        deletedBody.includes('_scheduleSidebarRefreshFromFiles()'),
        'ticketFileDeleted must reload the sidebar so the card disappears'
    );

    // ── Fault 1: the dead 4s poll must not come back alongside the watcher ──
    assert.ok(
        !/function _startTicketsFilePoll\s*\(/.test(ticketsJs),
        'the dead _startTicketsFilePoll must not be reintroduced — two refresh mechanisms would race on the same state'
    );

    // ── Side effect the plan called in-scope: a refresh must not lose the user's place ──
    for (const renderer of ['renderTicketsLinearList', 'renderTicketsClickUpList']) {
        const idx = ticketsJs.indexOf(`function ${renderer}()`);
        assert.notStrictEqual(idx, -1, `${renderer} must exist in tickets.js`);
        const end = ticketsJs.indexOf('\n    function ', idx + 10);
        assert.ok(
            ticketsJs.slice(idx, end).includes('_applyTicketsListHtml('),
            `${renderer} must swap its list HTML through _applyTicketsListHtml so scroll position survives an auto-refresh`
        );
    }

    // ── Backend: a rename is delete(old)+create(new) — it must not read as a deletion ──
    // Ticket files are renamed whenever the title changes, so a naive delete branch drops
    // the card and blanks the detail pane of a ticket that still exists.
    const watcherIdx = providerTs.indexOf('private _setupTicketsViewWatcher(');
    assert.notStrictEqual(watcherIdx, -1, '_setupTicketsViewWatcher must exist in TicketsPanelProvider.ts');
    const watcherBody = providerTs.slice(watcherIdx, providerTs.indexOf('\n    private ', watcherIdx + 10));
    assert.match(
        watcherBody,
        /const survivor = this\._findTicketFileById\([\s\S]*?if \(survivor\) \{[\s\S]*?handleTicketFileEvent\(survivor\)/,
        'the delete path must look for a surviving <provider>_<id>_*.md and treat it as a rename, not a deletion'
    );
    const deleteAt = watcherBody.indexOf("type: 'ticketFileDeleted'");
    assert.notStrictEqual(deleteAt, -1, 'the watcher must still post ticketFileDeleted for genuine deletions');
    assert.ok(
        watcherBody.lastIndexOf('const survivor', deleteAt) !== -1,
        'ticketFileDeleted must only be posted after the survivor check'
    );

    // ── Backend: the root-keyed arming guard needs a folder-set escape hatch ──
    // _setupTicketsViewWatcher skips folders that do not exist, so arming before the first
    // import attaches zero watchers and the webview's root guard then blocks re-arming for
    // the rest of the session.
    assert.ok(
        providerTs.includes('private _rearmTicketsViewWatcherIfFoldersChanged('),
        'TicketsPanelProvider must expose a folder-set drift check for the display watcher'
    );
    const listIdx = providerTs.indexOf("case 'listLocalTicketFiles': {");
    assert.notStrictEqual(listIdx, -1, "case 'listLocalTicketFiles' must exist in TicketsPanelProvider.ts");
    assert.ok(
        providerTs.slice(listIdx, listIdx + 1400).includes('this._rearmTicketsViewWatcherIfFoldersChanged(workspaceRoot)'),
        'the sidebar-load path must re-attach the display watcher when its folder set drifted'
    );

    // ── Both hosts: the standalone watcher seam must not be a no-op ──
    // tickets.js is served to the browser host too; a stubbed watchFolder makes every
    // assertion above pass while the browser sidebar never refreshes.
    assert.ok(
        !/watchFolder:\s*\(\)\s*=>\s*\(\{\s*dispose/.test(standaloneTs),
        'standalone hostServices watchFolder must not be a no-op stub — it powers the browser host Tickets auto-refresh'
    );
    assert.match(
        standaloneTs,
        /function createStandaloneFolderWatcher\([\s\S]*?fs\.watch\(/,
        'standalone hostServices must back watchFolder with a real fs.watch'
    );
    assert.match(
        standaloneTs,
        /if \(!fs\.existsSync\(fullPath\)\) \{ listener\('delete', fullPath\); return; \}/,
        "the standalone watcher must map a vanished path to the seam's 'delete' event"
    );
}

if (require.main === module) {
    testTicketsAutoRefreshOnFileChange();
    console.log('tickets-auto-refresh-on-file-change.test.js passed.');
}

module.exports = { testTicketsAutoRefreshOnFileChange };
