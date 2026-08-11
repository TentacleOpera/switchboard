/**
 * Refetch full-pull regression — the test eaee275a did not have.
 *
 * eaee275a ("Project Pin Assignment Correctness", 2026-07-30) removed the `isDelta`
 * gate from the conflict guard as a drive-by in an unrelated commit. That widened the
 * guard from "a delta pull must never silently overwrite local edits" to "a import/pull
 * must never silently overwrite local edits" — so a full Refetch could no longer re-pull
 * any flagged ticket, by construction. Combined with the delta cursor advancing past
 * skips regardless, a flagged ticket became permanently stale (ticket 86d3y200v was
 * 3 days behind its remote on a live workspace).
 *
 * This file pins the restored contract:
 *
 *   - An authoritative Refetch (forceFull) writes EVERY item, including one whose
 *     file mtime exceeds last_synced + 1s. This is the escape hatch.
 *   - A delta pull still skips a locally-modified ticket and counts it in
 *     skippedModified — the delta path's protection is untouched.
 *   - A full pull via includeClosed (no forceFull) still skips modified tickets —
 *     a filter toggle must never silently discard local edits.
 *   - _writeTaskDocument stamps last_synced_at BEFORE _removeOrphanTicketFiles,
 *     closing the false-flag window that manufactured the bogus "modified" state.
 *   - pushTicketEdits returns stale:true and issues NO provider write when the
 *     remote's date_updated exceeds the baseline by more than the 60s grace.
 *   - A missing last_synced_at ALLOWS the push (local-only tickets stay pushable).
 *   - A deleted remote (no timestamp returned) cancels the push — never recreates
 *     a deleted ticket from a stale body.
 *   - syncAllTickets filters to non-synced tickets before pushing.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');
installVscodeTrap();

const { TaskViewerProvider } = require('../../out/services/TaskViewerProvider');
const { GlobalIntegrationConfigService } = require('../../out/services/GlobalIntegrationConfigService');

const importAllTasks = TaskViewerProvider.prototype.importAllTasks;
const pushTicketEdits = TaskViewerProvider.prototype.pushTicketEdits;
assert.strictEqual(typeof importAllTasks, 'function', 'TaskViewerProvider.importAllTasks must exist');
assert.strictEqual(typeof pushTicketEdits, 'function', 'TaskViewerProvider.pushTicketEdits must exist');

let passed = 0;
const failures = [];

function check(name, fn) {
    return fn().then(
        () => { passed++; console.log(`  ✅ ${name}`); },
        (err) => { failures.push({ name, err }); console.log(`  ❌ ${name}\n     ${err && err.message}`); }
    );
}

function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Build a temp workspace with one ticket file whose mtime is deliberately set
 * past last_synced_at + 1s, so it reads as "locally modified".
 */
function makeRefetchFixture(opts) {
    const provider = opts.provider || 'clickup';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-refetch-'));

    const segments = provider === 'clickup'
        ? [opts.spaceName || 'space-a', opts.listName || 'list-a']
        : [opts.teamName || 'team-a', '_no-project'];
    const ticketsRoot = path.join(root, '.switchboard', 'tickets', provider);
    const targetDir = path.join(ticketsRoot, ...segments.map(slugify));
    fs.mkdirSync(targetDir, { recursive: true });

    // Create the stale file — its mtime will be set below.
    //
    // The slug defaults to the one the remote title ("ticket <id>") produces, so a
    // rewrite lands on the SAME path — which is the reported scenario (86d3y200v kept
    // its filename across the three stale days). Pass `staleSlug` to force a rename and
    // exercise the orphan-cleanup path instead.
    const staleId = opts.staleId || 't1';
    const staleSlug = opts.staleSlug || slugify(`ticket ${staleId}`);
    const staleFile = path.join(targetDir, `${provider}_${staleId}_${staleSlug}.md`);
    fs.writeFileSync(staleFile, `# stale ticket\nold content\n`, 'utf8');

    // Set the file's mtime 10 seconds in the future relative to last_synced_at
    // so it reads as "modified" (mtime > lastSynced + 1s).
    const lastSyncedAt = opts.lastSyncedAt || new Date(Date.now() - 60000).toISOString();
    const staleMtime = new Date(lastSyncedAt).getTime() + 10000;
    fs.utimesSync(staleFile, staleMtime / 1000, staleMtime / 1000);

    const dbTickets = [{
        slugPrefix: `${provider}_${staleId}`,
        filePath: staleFile,
        lastSyncedAt,
        docName: 'stale ticket',
        remoteDocId: staleId
    }];

    // Other tickets that are in sync.
    for (const id of (opts.otherIds || [])) {
        const f = path.join(targetDir, `${provider}_${id}_other.md`);
        fs.writeFileSync(f, `# ticket ${id}\n`, 'utf8');
        dbTickets.push({
            slugPrefix: `${provider}_${id}`,
            filePath: f,
            lastSyncedAt: new Date().toISOString(),
            docName: `ticket ${id}`,
            remoteDocId: id
        });
    }

    const writtenFiles = new Set();
    const deletedSlugs = [];
    const cacheService = {
        invalidateTaskCache() { /* no-op */ },
        async getImportedTickets() { return dbTickets.slice(); },
        async deleteImportedTicket(slugPrefix) {
            deletedSlugs.push(slugPrefix);
            const i = dbTickets.findIndex(t => t.slugPrefix === slugPrefix);
            if (i !== -1) { dbTickets.splice(i, 1); }
        },
        async registerImportedTicket(provider, id, title, slugPrefix, filePath) {
            // Update the dbTickets entry's lastSyncedAt so it reads "synced" after write.
            const entry = dbTickets.find(t => t.slugPrefix === slugPrefix);
            if (entry) { entry.lastSyncedAt = new Date().toISOString(); }
        },
        async getImportBySlugPrefix(slugPrefix) {
            return dbTickets.find(t => t.slugPrefix === slugPrefix) || null;
        }
    };

    const remoteItems = (opts.remoteIds || [staleId]).map(id => ({
        id,
        name: `ticket ${id}`,
        status: { type: 'open' },
        markdown_description: `# ticket ${id}\nremote content for ${id}\n`,
        url: `https://example.com/${id}`
    }));

    const clickup = {
        async getListTasks() { return remoteItems; },
        async getListTasksLive() { return { tasks: remoteItems, complete: true }; },
        getSelectedHierarchy() {
            return { spaceName: opts.spaceName || 'space-a', folderName: '', listName: opts.listName || 'list-a' };
        },
        async loadConfig() { return { selectedListId: opts.selectedListId || 'L1' }; },
        async probeTaskExistence() { return 'exists'; },
        async getTaskDateUpdated(taskId) {
            if (opts.remoteDateUpdated) { return opts.remoteDateUpdated; }
            return new Date().toISOString();
        },
        async attachFile() { return { url: 'https://example.com/attach' }; },
        async updateTask() { /* no-op */ }
    };

    const linear = {
        async queryIssues() { return remoteItems.map(it => ({ ...it, project: { name: 'proj' }, state: { type: 'started' } })); },
        getTeamName() { return opts.teamName || 'team-a'; },
        async probeIssueExistence() { return 'exists'; },
        async getIssue(id) {
            if (opts.remoteDeleted) { return null; }
            return { id, updatedAt: opts.remoteDateUpdated || new Date().toISOString(), title: `ticket ${id}` };
        },
        async uploadAttachment() { return { url: 'https://example.com/attach' }; },
        async updateIssueDescription() { /* no-op */ }
    };

    // Inherit from the real prototype so every private helper the write path reaches
    // transitively (_parseSubtaskEntries, _buildSubtaskEntry, _buildCommentsSection, …)
    // is present. Hand-listing them is how this harness silently degraded: a missing
    // helper throws inside _writeTaskDocument, importAllTasks swallows it into failCount,
    // and the file-content assertions then compare old bytes to old bytes and "pass".
    // Own properties below still override with stubs where a seam is needed.
    const fakeThis = Object.assign(Object.create(TaskViewerProvider.prototype), {
        _resolveWorkspaceRoot: (r) => r || root,
        _getAllowedRoots: () => [root],
        _getCacheService: () => cacheService,
        _getClickUpService: () => clickup,
        _getLinearService: () => linear,
        _slugify: slugify,
        _collectDeletionCandidates: TaskViewerProvider.prototype._collectDeletionCandidates,
        _confirmRemotelyDeleted: TaskViewerProvider.prototype._confirmRemotelyDeleted,
        _applyConfirmedDeletions: TaskViewerProvider.prototype._applyConfirmedDeletions,
        async _writeTaskDocument(resolvedRoot, provider, task, targetDir, subtasks) {
            // Use the real _writeTaskDocument so the stamp-order assertion covers it.
            return TaskViewerProvider.prototype._writeTaskDocument.call(
                fakeThis, resolvedRoot, provider, task, targetDir, subtasks
            );
        },
        async _findTicketDocument(resolvedRoot, provider, id) {
            const entry = dbTickets.find(t => t.slugPrefix === `${provider}_${id}`);
            return entry ? entry.filePath : null;
        },
        _mergeSubtasksSection: TaskViewerProvider.prototype._mergeSubtasksSection,
        // Required by _writeTaskDocument — omitting it makes every write throw
        // "this._buildCommentsSection is not a function", which importAllTasks swallows
        // into failCount and the file-content assertions then silently compare old vs old.
        _buildCommentsSection: TaskViewerProvider.prototype._buildCommentsSection,
        _buildClickUpImportPlanContent: TaskViewerProvider.prototype._buildClickUpImportPlanContent,
        _buildLinearImportPlanContent: TaskViewerProvider.prototype._buildLinearImportPlanContent,
        _removeOrphanTicketFiles: TaskViewerProvider.prototype._removeOrphanTicketFiles,
        _stripFrontmatter: TaskViewerProvider.prototype._stripFrontmatter,
        _SUBTASKS_HEADING: TaskViewerProvider._SUBTASKS_HEADING
    });

    return { root, targetDir, staleFile, dbTickets, cacheService, clickup, linear, fakeThis, writtenFiles, deletedSlugs };
}

async function main() {
    // Sandboxed config must not set ticketSaveLocation — the harness predicts the
    // default targetDir.
    for (const p of ['clickup', 'linear']) {
        const cfg = GlobalIntegrationConfigService.loadConfigSync(p);
        assert.ok(
            !cfg || !cfg.ticketSaveLocation,
            `sandboxed ${p} config must not set ticketSaveLocation — the harness predicts the default targetDir`
        );
    }

    console.log('── §1: authoritative Refetch writes every item, including stale ones ──');

    await check('authoritative Refetch rewrites a stale (mtime > last_synced + 1s) ticket', async () => {
        const fx = makeRefetchFixture({ staleId: 't1', remoteIds: ['t1'] });
        const before = fs.readFileSync(fx.staleFile, 'utf8');
        const res = await importAllTasks.call(fx.fakeThis, fx.root, {
            provider: 'clickup',
            listId: 'L1',
            importMode: 'document',
            authoritative: true
        });
        assert.strictEqual(res.success, true, 'import should succeed');
        // `success` is hardcoded true on the document fast path, so it proves nothing.
        // Assert the counts — a throw inside _writeTaskDocument lands in failCount and
        // would otherwise leave the content assertions comparing old bytes to old bytes.
        assert.strictEqual(res.failCount, 0, `no write may fail: ${JSON.stringify(res.errors)}`);
        assert.strictEqual(res.successCount, 1, 'the stale ticket must have been written');
        // importAllTasks omits skippedModified entirely when it is 0 (spread-conditional
        // on the return), so normalise before comparing.
        assert.strictEqual(res.skippedModified || 0, 0, 'an authoritative Refetch must skip nothing');
        const after = fs.readFileSync(fx.staleFile, 'utf8');
        assert.notStrictEqual(before, after, 'the stale file must have been rewritten with remote content');
        assert.ok(after.includes('remote content for t1'), 'the file must carry the remote body');
    });

    await check('delta pull still skips a locally-modified ticket', async () => {
        const fx = makeRefetchFixture({ staleId: 't1', remoteIds: ['t1'] });
        const before = fs.readFileSync(fx.staleFile, 'utf8');
        const res = await importAllTasks.call(fx.fakeThis, fx.root, {
            provider: 'clickup',
            listId: 'L1',
            importMode: 'document',
            deltaSince: Date.now() - 60000
        });
        assert.strictEqual(res.skippedModified, 1, 'a delta pull must skip the locally-modified ticket');
        const after = fs.readFileSync(fx.staleFile, 'utf8');
        assert.strictEqual(before, after, 'the stale file must NOT be rewritten by a delta pull');
    });

    console.log('── §1 includeClosed lock: a filter toggle must never discard local edits ──');

    await check('full pull via includeClosed (no forceFull) still skips modified tickets', async () => {
        // includeClosed forces a full pull (no delta cursor) but authoritative=false,
        // so the conflict guard still runs and skips modified tickets.
        const fx = makeRefetchFixture({ staleId: 't1', remoteIds: ['t1'] });
        const before = fs.readFileSync(fx.staleFile, 'utf8');
        const res = await importAllTasks.call(fx.fakeThis, fx.root, {
            provider: 'clickup',
            listId: 'L1',
            importMode: 'document',
            includeClosed: true,
            authoritative: false
        });
        assert.ok(res.skippedModified >= 1, 'includeClosed without forceFull must still skip modified tickets');
        const after = fs.readFileSync(fx.staleFile, 'utf8');
        assert.strictEqual(before, after, 'the stale file must NOT be rewritten by a non-authoritative full pull');
    });

    console.log('── §2: _writeTaskDocument stamps last_synced_at before _removeOrphanTicketFiles ──');

    await check('source: registerImportedTicket call precedes _removeOrphanTicketFiles in _writeTaskDocument', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const writeDocStart = src.indexOf('private async _writeTaskDocument(');
        assert.notStrictEqual(writeDocStart, -1, '_writeTaskDocument must exist');
        const writeDocEnd = src.indexOf('return { success: true, filePath };', writeDocStart);
        assert.notStrictEqual(writeDocEnd, -1, '_writeTaskDocument return must exist');
        const body = src.slice(writeDocStart, writeDocEnd);
        // Match the CALLS, not the bare identifiers — the stamp is preceded by a comment
        // that names _removeOrphanTicketFiles, and an identifier match would read that
        // comment as the call site and invert the order.
        const stampIdx = body.indexOf('await cacheService.registerImportedTicket(');
        const orphanIdx = body.indexOf('await this._removeOrphanTicketFiles(');
        assert.notStrictEqual(stampIdx, -1, 'registerImportedTicket must be called in _writeTaskDocument');
        assert.notStrictEqual(orphanIdx, -1, '_removeOrphanTicketFiles must be called in _writeTaskDocument');
        assert.ok(
            stampIdx < orphanIdx,
            'registerImportedTicket (last_synced_at stamp) must come BEFORE _removeOrphanTicketFiles — stamping after it self-flags the ticket as modified'
        );
    });

    await check('orphan cleanup must NOT delete the imported_docs row the stamp just wrote', async () => {
        // staleSlug forces a rename: the remote title ("ticket t1") slugs to a different
        // filename, so the old file IS an orphan and _removeOrphanTicketFiles unlinks it.
        // Deleting the row keyed on that slug would wipe the last_synced_at stamped moments
        // earlier — leaving the ticket with no baseline for sync status, the push staleness
        // guard, or the conflict guard.
        const fx = makeRefetchFixture({ staleId: 't1', remoteIds: ['t1'], staleSlug: 'old-title' });
        assert.ok(fs.existsSync(fx.staleFile), 'fixture must start with the pre-rename file');
        const res = await importAllTasks.call(fx.fakeThis, fx.root, {
            provider: 'clickup',
            listId: 'L1',
            importMode: 'document',
            authoritative: true
        });
        assert.strictEqual(res.failCount, 0, `no write may fail: ${JSON.stringify(res.errors)}`);
        assert.ok(!fs.existsSync(fx.staleFile), 'the renamed-away file must have been unlinked as an orphan');
        assert.deepStrictEqual(
            fx.deletedSlugs, [],
            'orphan cleanup must not call deleteImportedTicket — the row describes the KEPT file'
        );
        const entry = fx.dbTickets.find(t => t.slugPrefix === 'clickup_t1');
        assert.ok(entry, 'the imported_docs row must survive the orphan cleanup');
        assert.ok(entry.lastSyncedAt, 'the row must still carry a last_synced_at baseline');
    });

    await check('source: _removeOrphanTicketFiles does not delete the ticket row', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const start = src.indexOf('private async _removeOrphanTicketFiles(');
        assert.notStrictEqual(start, -1, '_removeOrphanTicketFiles must exist');
        const end = src.indexOf('private static readonly _SUBTASKS_HEADING', start);
        const body = src.slice(start, end === -1 ? undefined : end);
        assert.ok(
            !/await cacheService\.deleteImportedTicket\(/.test(body),
            '_removeOrphanTicketFiles must not delete the imported_docs row — _writeTaskDocument now stamps BEFORE it runs'
        );
    });

    await check('source: dbTickets is loaded unconditionally, not gated on !authoritative', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const start = src.indexOf('public async importAllTasks(');
        const body = src.slice(start);
        assert.ok(
            !/if \(!authoritative\) \{\s*try \{/.test(body),
            'the cache load must NOT be gated on !authoritative — the prune\'s modified-file guard and the ' +
            'orphan-subtask restamp read dbTickets too, and gating the load silently disarms both on a Refetch'
        );
        assert.ok(
            /if \(!authoritative && dbEntry && dbEntry\.lastSyncedAt\)/.test(body),
            'the orphan-subtask upsert must carry the same !authoritative gate as the write loop'
        );
    });

    console.log('── §3: pushTicketEdits staleness guard ──');

    await check('stale remote blocks the push and issues no provider write', async () => {
        const fx = makeRefetchFixture({
            staleId: 't1',
            remoteIds: ['t1'],
            lastSyncedAt: new Date(Date.now() - 120000).toISOString(),  // 2 min ago
            remoteDateUpdated: new Date().toISOString()                  // remote changed now
        });
        let updateCalled = false;
        fx.clickup.updateTask = async () => { updateCalled = true; };
        const res = await pushTicketEdits.call(fx.fakeThis, fx.root, {
            provider: 'clickup',
            id: 't1'
        });
        assert.strictEqual(res.success, false, 'a stale push must be blocked');
        assert.strictEqual(res.stale, true, 'the blocked result must carry stale: true');
        assert.strictEqual(updateCalled, false, 'no provider write may occur on a blocked push');
    });

    await check('missing last_synced_at allows the push (local-only ticket)', async () => {
        const fx = makeRefetchFixture({ staleId: 't1', remoteIds: ['t1'] });
        // Remove lastSyncedAt so there is no baseline.
        fx.dbTickets[0].lastSyncedAt = undefined;
        let updateCalled = false;
        fx.clickup.updateTask = async () => { updateCalled = true; };
        fx.clickup.getTaskDateUpdated = async () => new Date().toISOString();
        const res = await pushTicketEdits.call(fx.fakeThis, fx.root, {
            provider: 'clickup',
            id: 't1'
        });
        assert.strictEqual(res.success, true, 'a local-only ticket (no baseline) must be pushable');
        assert.strictEqual(updateCalled, true, 'the push must proceed when there is no baseline to check against');
    });

    await check('deleted remote (no timestamp) cancels the push — never recreates', async () => {
        const fx = makeRefetchFixture({
            staleId: 't1',
            remoteIds: ['t1'],
            lastSyncedAt: new Date(Date.now() - 120000).toISOString(),
            remoteDeleted: false  // ClickUp path: getTaskDateUpdated returns ''
        });
        // ClickUp: getTaskDateUpdated returns '' on 404/error → Date.parse('') = NaN
        fx.clickup.getTaskDateUpdated = async () => '';
        let updateCalled = false;
        fx.clickup.updateTask = async () => { updateCalled = true; };
        const res = await pushTicketEdits.call(fx.fakeThis, fx.root, {
            provider: 'clickup',
            id: 't1'
        });
        assert.strictEqual(res.success, false, 'a deleted remote must cancel the push');
        assert.strictEqual(updateCalled, false, 'no provider write may occur when the remote is gone');
        assert.ok(!res.stale, 'a deleted remote is not "stale" — it is gone');
    });

    await check('Linear: deleted remote (getIssue returns null) cancels the push', async () => {
        const fx = makeRefetchFixture({
            provider: 'linear',
            staleId: 'LIN-1',
            remoteIds: ['LIN-1'],
            lastSyncedAt: new Date(Date.now() - 120000).toISOString()
        });
        fx.linear.getIssue = async () => null;  // deleted
        let updateCalled = false;
        fx.linear.updateIssueDescription = async () => { updateCalled = true; };
        const res = await pushTicketEdits.call(fx.fakeThis, fx.root, {
            provider: 'linear',
            id: 'LIN-1'
        });
        assert.strictEqual(res.success, false, 'a deleted Linear issue must cancel the push');
        assert.strictEqual(updateCalled, false, 'no provider write may occur when the issue is gone');
    });

    console.log('── §4: syncAllTickets filters to non-synced tickets ──');

    await check('source: syncAllTickets filters via _ticketSyncStatusFromTimestamps before pushing', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'TicketsPanelProvider.ts'), 'utf8');
        const syncStart = src.indexOf("case 'syncAllTickets':");
        assert.notStrictEqual(syncStart, -1, "syncAllTickets case must exist");
        const syncEnd = src.indexOf('case ', syncStart + 20);
        const body = src.slice(syncStart, syncEnd === -1 ? undefined : syncEnd);
        assert.ok(
            /_ticketSyncStatusFromTimestamps\(t\.filePath/.test(body),
            'syncAllTickets must filter via _ticketSyncStatusFromTimestamps before pushing'
        );
        assert.ok(
            /pushable/.test(body),
            'syncAllTickets must produce a pushable subset'
        );
        assert.ok(
            /skipped/.test(body),
            'syncAllTickets result must report how many were skipped'
        );
        // The count is worthless if the webview drops it: "No local ticket files to sync."
        // on a tree of 250 in-sync files is a lie, and it is the message the pre-filter
        // build never had to render because it always pushed something.
        const ticketsJs = fs.readFileSync(path.join(__dirname, '..', 'webview', 'tickets.js'), 'utf8');
        const handlerStart = ticketsJs.indexOf("case 'syncAllTicketsResult':");
        assert.notStrictEqual(handlerStart, -1, 'tickets.js must handle syncAllTicketsResult');
        const handlerBody = ticketsJs.slice(handlerStart, handlerStart + 1400);
        assert.ok(
            /message\.skipped/.test(handlerBody),
            'the syncAllTicketsResult handler must report message.skipped — otherwise a fully in-sync tree renders as "No local ticket files to sync."'
        );
    });

    console.log('── §5: skip message advertises Refetch, not a non-existent discard ──');

    await check('source: skip warning mentions Refetch, not "discard changes first"', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'TicketsPanelProvider.ts'), 'utf8');
        assert.ok(
            /Refetch to take the remote version/.test(src),
            'the skip warning must point the user to Refetch as the remedy'
        );
        assert.ok(
            !/push or discard changes first/.test(src),
            'the old "push or discard changes first" message must be gone — there is no discard action'
        );
    });

    console.log('── §1 source: the conflict guard is gated on !authoritative, not isDelta ──');

    await check('source: conflict guard uses !authoritative, not isDelta', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(
            /if \(!authoritative && item\.id\)/.test(src),
            'the conflict guard must be gated on !authoritative — only an explicit Refetch discards local edits'
        );
        // The old eaee275a pattern (ungated `if (item.id)`) must be gone.
        // Scan from importAllTasks to EOF: _writeTaskDocument is declared ABOVE it, so the
        // original forward search for that marker returned -1 and silently truncated the
        // slice by one character. The assertion below is a negative match, so an over-wide
        // window is strictly safer than a wrong one.
        const importAllStart = src.indexOf('public async importAllTasks(');
        assert.notStrictEqual(importAllStart, -1, 'importAllTasks must exist');
        const importAllBody = src.slice(importAllStart);
        assert.ok(
            !/if \(item\.id\) \{\s*const slugPrefix/.test(importAllBody),
            'the ungated `if (item.id)` conflict guard from eaee275a must be gone'
        );
    });

    // Summary
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        for (const f of failures) {
            console.error(`FAIL: ${f.name}: ${f.err && f.err.stack || f.err}`);
        }
        process.exit(1);
    }
}

main().catch((e) => {
    console.error('fatal:', e);
    process.exit(1);
});
