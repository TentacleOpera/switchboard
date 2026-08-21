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
    const bootstrapTs = fs.readFileSync(path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8');
    const vscodeShimTs = fs.readFileSync(path.join(__dirname, '../standalone/vscodeShim.ts'), 'utf8');

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

    // ── Standalone: the watcher must actually be WIRED, not merely implemented ──
    // The three assertions above prove createStandaloneFolderWatcher is real. They were
    // green for the entire period the browser cockpit received ZERO watcher events,
    // because that function lived only inside createHeadlessHostSeams — a bundle the repo
    // itself documents as NOT WIRED. Pin the composition root instead.
    assert.match(
        standaloneTs,
        /export function createStandaloneFolderWatcher\(/,
        'createStandaloneFolderWatcher must remain exported — it is the proven fs.watch implementation the shim mirrors'
    );
    // ── Standalone: the shim's createFileSystemWatcher must be real ──
    // The bootstrap override was removed — VscodeHostFileWatcher now routes
    // through the shim directly. The shim must be backed by real fs.watch.
    assert.match(
        vscodeShimTs,
        /export function createFileSystemWatcher[\s\S]*?fs\.watch\(/,
        'vscodeShim.createFileSystemWatcher must be backed by real fs.watch — a no-op silently disables every folder watcher in the standalone host'
    );
    assert.match(
        vscodeShimTs,
        /export class RelativePattern/,
        'vscodeShim must export a RelativePattern class — VscodeHostFileWatcher constructs new vscode.RelativePattern(...) before calling createFileSystemWatcher, and without this the constructor is undefined and throws'
    );
    // The bootstrap override must be GONE.
    assert.ok(
        !/headlessSeams\.watcher\s*=\s*\{/.test(bootstrapTs),
        'bootstrap must NOT override headlessSeams.watcher — the shim is now real, so the override is redundant and its presence would mask a shim regression'
    );

    // ── Standalone shim: "real fs.watch" is not enough — the MATCHER must be right ──
    // The first cut of this shim passed the two assertions above while silently
    // dropping the most important watched path in the product. Three invariants,
    // each of which was a live bug:
    //
    //  1. `**/` must match ZERO or more path segments (VS Code semantics). A naive
    //     `**` -> `.*` expansion demands an intervening directory, so
    //     `.switchboard/plans/**/*.md` missed the FLAT `.switchboard/plans/foo.md`
    //     that every plan file actually is.
    //  2. The regex must be anchored. Unanchored + unescaped `.` made `HEAD` match
    //     `ORIG_HEAD` and `constitution.md` match `my-constitution.md`.
    //  3. `base` may arrive as a Uri or WorkspaceFolder, not only a string
    //     (TaskViewerProvider passes `vscode.Uri.file(...)`). Handing that object to
    //     fs.watch throws and the watcher degrades to the no-op this replaced.
    assert.match(
        vscodeShimTs,
        /export function globToRegExp[\s\S]*?\(\?:\[\^\/\]\+\/\)\*/,
        "the shim's glob matcher must expand `**/` to a ZERO-or-more segment group — otherwise `.switchboard/plans/**/*.md` never matches a flat plan file"
    );
    assert.match(
        vscodeShimTs,
        /export function globToRegExp[\s\S]*?new RegExp\('\^' \+ re \+ '\$'\)/,
        "the shim's glob matcher must anchor at both ends — an unanchored pattern makes `HEAD` match `ORIG_HEAD` and fires the wrong file's watcher"
    );
    assert.match(
        vscodeShimTs,
        /function resolveBasePath\(base: any\)[\s\S]*?typeof base\.fsPath === 'string'/,
        'the shim must normalise a RelativePattern base that is a Uri/WorkspaceFolder to a path string — fs.watch throws on the object and the watcher silently no-ops'
    );
    const shimWatcherIdx = vscodeShimTs.indexOf('export function createFileSystemWatcher');
    assert.notStrictEqual(shimWatcherIdx, -1, 'vscodeShim must export createFileSystemWatcher');
    const shimWatcherBody = vscodeShimTs.slice(shimWatcherIdx, vscodeShimTs.indexOf('export function findFiles', shimWatcherIdx));
    assert.match(
        shimWatcherBody,
        /resolveBasePath\(\(pattern as any\)\.base\)/,
        'createFileSystemWatcher must run the RelativePattern base through resolveBasePath, not assume a string'
    );
    assert.ok(
        !/recursive:\s*true/.test(shimWatcherBody),
        'recursion must be conditional on the glob spanning directories — a bare filename (watchFile) recursing over its parent walks all of .switchboard/ to observe one file'
    );
    assert.match(
        shimWatcherBody,
        /eventType === 'rename' && !seen\.has\(fullPath\)/,
        "create and change must be discriminated by a seen-set: fs.watch reports 'rename' for a plain write on macOS, so existence alone reports every save as a create and starves consumers that key on 'change'"
    );

    // ── Standalone: an ARMED watcher must not be gated on a VS Code panel handle ──
    // PlanningPanelProvider's kanban-plans / feature-docs / constitution / insights
    // watchers guarded their refresh on `this._panel` / `this._projectPanel`. Those
    // are assigned ONLY in open()/openProject(), which the standalone host never
    // calls — so arming the watchers there bought exactly nothing. The surface
    // helpers admit the headless broadcaster as a delivery target.
    const planningTs = fs.readFileSync(path.join(__dirname, '../services/PlanningPanelProvider.ts'), 'utf8');
    assert.match(
        planningTs,
        /private _hasProjectSurface\(\): boolean \{[\s\S]*?_broadcaster\?\.isHeadless\(\) === true/,
        'PlanningPanelProvider must expose a surface check that counts the headless broadcaster — a bare `!this._panel` gate is permanently true in standalone'
    );
    for (const marker of ['_kanbanPlansWatchDebounce', '_featureDocsWatchDebounce', '_insightsWatchDebounce', '_constitutionWatchDebounce']) {
        const idx = planningTs.indexOf(marker + ') {');
        assert.notStrictEqual(idx, -1, `PlanningPanelProvider must still debounce via ${marker}`);
        const window = planningTs.slice(Math.max(0, idx - 1500), idx);
        assert.ok(
            /_hasAnySurface\(\)|_hasProjectSurface\(\)/.test(window),
            `the watcher guarded by ${marker} must gate on a surface helper, not on a raw panel handle — otherwise it is armed and dead in the standalone host`
        );
    }
    assert.match(
        planningTs,
        /private async _handleFetchRoots[\s\S]*?this\._setupKanbanPlansWatcher\(\);/,
        'the Planning watchers must be armed from _handleFetchRoots — the only initialization path the standalone host runs'
    );
    // Layer 2 of the two-layer completion contract (PRD #7): without the API server the
    // provider has no port, _buildLocalAssetUrl returns undefined, and every ticket image
    // in the browser cockpit renders as a broken icon.
    assert.match(
        bootstrapTs,
        /ticketsProvider\.setApiServer\(server\)/,
        'bootstrap must hand the Tickets provider the API server, or ticket images have no origin in the browser host'
    );
    assert.match(
        bootstrapTs,
        /getTicketsAssetRoots:\s*\(wsRoot: string\)\s*=>\s*ticketsProvider\.getTicketsAssetRoots\(wsRoot\)/,
        "bootstrap must union the Tickets asset roots into the /design/asset allow-list, or a configured ticketSaveLocation 403s at fetch time"
    );

    // ── Backend: an image overwritten in place must refresh the ticket that embeds it ──
    // An asset write changes no .md byte, so without a dedicated branch nothing even
    // tries to refresh — the "images are always stale" half of the reported bug.
    const assetIdx = providerTs.indexOf('private _handleTicketAssetEvent(');
    assert.notStrictEqual(assetIdx, -1, 'TicketsPanelProvider must handle non-.md (asset) watcher events');
    const assetBody = providerTs.slice(assetIdx, providerTs.indexOf('\n    private ', assetIdx + 10));
    assert.match(
        assetBody,
        /TICKET_ASSET_EXTENSIONS\.has\(path\.extname\(assetPath\)\.toLowerCase\(\)\)/,
        'asset events must be filtered to a servable image extension allow-list — a .DS_Store or .pdf event can never change what is rendered'
    );
    assert.match(
        assetBody,
        /path\.basename\(assetDir\)\.toLowerCase\(\) !== 'attachments'/,
        'only assets under an attachments/ directory are resolvable back to a ticket'
    );
    // THE fan-out guard. _buildTicketDir groups a whole ClickUp list into one directory
    // sharing one attachments/ folder, so a directory-wide replay would emit one push per
    // ticket in the list — potentially hundreds — on every single image write.
    assert.match(
        assetBody,
        /raw\.includes\(assetName\)/,
        'asset->ticket resolution must be filtered by CONTENT REFERENCE, not directory-wide: tickets are stored many-per-directory'
    );
    assert.match(
        assetBody,
        /`asset:\$\{assetPath\}`/,
        "the asset debounce key must be prefixed so an asset write cannot cancel a queued rename resolution keyed on the same .md path"
    );

    // ── Frontend: one shared applier, so a fix in one arm cannot skip the other ──
    // The stale-heading bug existed independently in BOTH file-driven arms; patching only
    // ticketFileChanged left "edit the title, exit edit mode" still showing the old H1.
    const applierIdx = ticketsJs.indexOf('function _applyTicketFilePayloadToSelected(');
    assert.notStrictEqual(applierIdx, -1, '_applyTicketFilePayloadToSelected must exist in tickets.js');
    const applierBody = ticketsJs.slice(applierIdx, ticketsJs.indexOf('\n    window.addEventListener', applierIdx));
    assert.match(
        applierBody,
        /if \(ticketsEditMode\) return false;/,
        'the applier must never clobber a textarea the user is typing in'
    );
    assert.ok(
        /title: nextTitle/.test(applierBody) && /issue: \{ \.\.\.prev\.issue, title: nextTitle \}/.test(applierBody),
        "the applier must write the file's H1 onto the selected object — both detail renderers draw the heading from it"
    );
    assert.match(
        applierBody,
        /if \(rendered === prev\?\.renderedDescriptionHtml && nextTitle === prevTitle\) return false;/,
        'the change signature must cover title AND body — a body-only compare suppresses the re-render on a retitle, and the version-token compare is what makes an image swap visible'
    );
    const readIdx = ticketsJs.indexOf("case 'localTicketFileRead':");
    const readBody = ticketsJs.slice(readIdx, ticketsJs.indexOf("case 'ticketFileChanged':", readIdx));
    assert.ok(
        readBody.includes('_applyTicketFilePayloadToSelected(message)'),
        'localTicketFileRead must route through the shared applier — it is the arm that runs on exit-from-edit'
    );
    // The applier PATCHES only. On a ticket's first selection the click handler has not
    // assigned a selection (it only does so on a detail-cache hit), so without a
    // from-scratch fallback the pane keeps the previous ticket and then shows the REMOTE
    // description, discarding unpushed local edits and local image URLs.
    assert.ok(
        readBody.includes('_isSelectedTicketPayload(message)') && /selectedLinearIssue = \{/.test(readBody),
        'localTicketFileRead must still BUILD the selected object when the payload is not for the already-selected ticket'
    );
    assert.match(
        readBody,
        /localDescription: true/,
        'the from-scratch build must mark the description as local, or the API response overwrites the file content when it lands'
    );

    // ── Backend: the asset URL must be content-versioned ──
    // Blink's per-Document image memory cache is consulted in the render process, before
    // the request reaches the network stack, so Cache-Control: no-cache is never
    // evaluated on an in-place image swap. A different URL string is the ONLY mechanism —
    // and it is also the only thing the rendered-HTML equality guards can see.
    // Do NOT "optimise" this away in favour of ETag/Last-Modified: validators only help
    // once a request is issued, and no request is issued.
    const urlIdx = providerTs.indexOf('private _buildLocalAssetUrl(');
    assert.notStrictEqual(urlIdx, -1, '_buildLocalAssetUrl must exist in TicketsPanelProvider.ts');
    const urlBody = providerTs.slice(urlIdx, providerTs.indexOf('\n    private ', urlIdx + 10));
    assert.match(
        urlBody,
        /try \{ version = `&v=\$\{Math\.floor\(fs\.statSync\(realTarget\)\.mtimeMs\)\}`; \} catch/,
        'the asset URL must carry an mtime version token, stat-ed on the realpathed target and try-wrapped so a vanished file degrades to no token rather than losing the image'
    );
}

if (require.main === module) {
    testTicketsAutoRefreshOnFileChange();
    console.log('tickets-auto-refresh-on-file-change.test.js passed.');
}

module.exports = { testTicketsAutoRefreshOnFileChange };
