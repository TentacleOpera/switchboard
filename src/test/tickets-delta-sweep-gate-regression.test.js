/**
 * Deletion reconciliation — regression test.
 *
 * Two failures bracket this file, and the contract has to hold both off at once.
 *
 * 1. 2026-08-05, data loss. The delta sweep unlinked five live ticket files and
 *    their imported_docs rows while ClickUp still held all five tasks. The sweep
 *    inferred deletion from absence in a list fetch, and its authorisation check
 *    was `fetchSucceeded = true` set unconditionally after the fetch — i.e. it
 *    meant "did not throw", not "is authoritative". `_fetchListTasksInternal`
 *    returns SHORT results without throwing, so a 200 with a short page produced
 *    an id set missing real tickets and every "absent" file was deleted.
 *
 * 2. The fix for (1) was a stack of authority gates — complete && non-empty,
 *    selection-match, resolved-hierarchy. Any gate returning false skipped
 *    reconciliation entirely, with nothing but a console.warn. Since the sidebar's
 *    steady state is the local files (`localTicketFilesListed`), a ticket deleted
 *    in ClickUp or Linear then stayed on screen forever — Refresh and Full
 *    re-fetch both looked like they did nothing at all.
 *
 * The resolution is to stop inferring. A list fetch now only NOMINATES candidates;
 * `_confirmRemotelyDeleted` then asks each candidate's own endpoint, and only a
 * positively-confirmed-gone ticket is unlinked. That is immune to every failure
 * mode the gates were defending against — a short fetch, an emptied list, a moved
 * selection, an unnameable directory cannot make a live ticket's endpoint 404 —
 * so the gates are gone and reconciliation always runs.
 *
 * The invariant this file pins, in both directions:
 *
 *   NEVER delete a local file without positive per-ticket proof it is gone.
 *   ALWAYS delete one that has such proof, however the list fetch went.
 *
 * Cases 2 and 8 are load-bearing: they prove the harness's targetDir matches the
 * one the provider computes. Without them every no-delete assertion would pass for
 * the wrong reason.
 *
 * The provider is driven via `importAllTasks.call(fakeThis, ...)` with stubbed
 * services — no existing harness imports importAllTasks, and standing up the real
 * TaskViewerProvider would drag in the whole extension host.
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
assert.strictEqual(typeof importAllTasks, 'function', 'TaskViewerProvider.importAllTasks must exist');
assert.strictEqual(
    typeof TaskViewerProvider.prototype._confirmRemotelyDeleted, 'function',
    'TaskViewerProvider._confirmRemotelyDeleted must exist — it is the only sanctioned authority for deleting a ticket file'
);
assert.strictEqual(
    typeof TaskViewerProvider.prototype._applyConfirmedDeletions, 'function',
    'TaskViewerProvider._applyConfirmedDeletions must exist'
);

let passed = 0;
const failures = [];

function check(name, fn) {
    return fn().then(
        () => { passed++; console.log(`  ✅ ${name}`); },
        (err) => { failures.push({ name, err }); console.log(`  ❌ ${name}\n     ${err && err.message}`); }
    );
}

/** Deterministic slug so the harness can predict targetDir exactly. */
function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Build a temp workspace with one file per remote id, plus the stubbed `this` the
 * delta path needs. `items` is empty (a delta that reports no CHANGED tasks), so the
 * write/orphan-subtask loops never run and reconciliation is the only thing under test.
 *
 * `opts.probe` maps a remote id to the verdict its endpoint returns
 * ('deleted' | 'exists' | 'unknown'); `opts.probeDefault` covers the rest. The real
 * `_confirmRemotelyDeleted` / `_applyConfirmedDeletions` are bound onto fakeThis so
 * the production decision logic — not a reimplementation of it — is what runs.
 */
function makeFixture(opts) {
    const provider = opts.provider;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delta-sweep-'));

    // Mirror the provider's targetDir derivation, including the ticketSaveLocation path.
    const segments = provider === 'clickup'
        ? [opts.spaceName, opts.listName]
        : [opts.teamName, '_no-project'];
    const saveLocation = opts.ticketSaveLocation;
    const ticketsRoot = saveLocation
        ? path.join(saveLocation, provider)
        : path.join(root, '.switchboard', 'tickets', provider);
    const targetDir = path.join(ticketsRoot, ...segments.map(slugify));
    fs.mkdirSync(targetDir, { recursive: true });

    const dbTickets = opts.localIds.map((id) => {
        const filePath = path.join(targetDir, `${provider}_${id}.md`);
        fs.writeFileSync(filePath, `# ticket ${id}\n`, 'utf8');
        return { slugPrefix: `${provider}_${id}`, filePath, remoteDocId: String(id), docName: `ticket ${id}` };
    });

    const deletedSlugs = [];
    const cacheService = {
        invalidateTaskCache() { /* no-op */ },
        async getImportedTickets() { return dbTickets.slice(); },
        async deleteImportedTicket(slugPrefix) { deletedSlugs.push(slugPrefix); },
        async registerImportedTicket() { /* not reached with items=[] */ }
    };

    const probed = [];
    const probeMap = opts.probe || {};
    const probeDefault = opts.probeDefault || 'exists';
    const verdictFor = (id) => {
        probed.push(String(id));
        return Object.prototype.hasOwnProperty.call(probeMap, id) ? probeMap[id] : probeDefault;
    };

    const clickup = {
        async getListTasks() { return []; },                       // delta: no changed tasks
        async getListTasksLive() { return { tasks: opts.remoteIds.map((id) => ({ id })), complete: opts.complete }; },
        getSelectedHierarchy() { return { spaceName: opts.spaceName, folderName: '', listName: opts.listName }; },
        async loadConfig() { return { selectedListId: opts.selectedListId }; },
        async probeTaskExistence(id) { return verdictFor(id); }
    };

    const linear = {
        async queryIssues() { return []; },                        // delta: no changed issues
        async fetchAllIssueIds() { return { ids: new Set(opts.remoteIds.map(String)), complete: opts.complete }; },
        getTeamName() { return opts.teamName; },
        async probeIssueExistence(id) { return verdictFor(id); }
    };

    const fakeThis = {
        _resolveWorkspaceRoot: (r) => r || root,
        _getCacheService: () => cacheService,
        _getClickUpService: () => clickup,
        _getLinearService: () => linear,
        _slugify: slugify,
        _collectDeletionCandidates: TaskViewerProvider.prototype._collectDeletionCandidates,
        _confirmRemotelyDeleted: TaskViewerProvider.prototype._confirmRemotelyDeleted,
        _applyConfirmedDeletions: TaskViewerProvider.prototype._applyConfirmedDeletions,
        async _writeTaskDocument() { throw new Error('write loop must not run — items is empty'); },
        async _findTicketDocument() { throw new Error('orphan-subtask loop must not run — items is empty'); },
        _mergeSubtasksSection() { throw new Error('merge must not run — items is empty'); }
    };

    return { root, targetDir, ticketsRoot, dbTickets, deletedSlugs, probed, fakeThis };
}

function surviving(dbTickets) {
    return dbTickets.filter((t) => fs.existsSync(t.filePath)).map((t) => t.remoteDocId).sort();
}

async function runClickUp(fx, listId) {
    return importAllTasks.call(fx.fakeThis, fx.root, {
        provider: 'clickup',
        listId,
        importMode: 'document',
        deltaSince: 1
    });
}

async function runLinear(fx, projectId) {
    return importAllTasks.call(fx.fakeThis, fx.root, {
        provider: 'linear',
        projectId,
        importMode: 'document',
        deltaSinceIso: '2026-01-01T00:00:00.000Z'
    });
}

const CU = {
    provider: 'clickup', spaceName: 'space-a', listName: 'list-a',
    selectedListId: 'L1', localIds: ['t1', 't2', 't3']
};
const LI = {
    provider: 'linear', teamName: 'team-a',
    selectedListId: '', localIds: ['i1', 'i2', 'i3']
};

async function main() {
    // A ticketSaveLocation in the sandboxed global config would relocate targetDir and
    // make every no-delete assertion pass vacuously. Cases 2/8 would catch it, but say
    // so plainly rather than leaving a confusing failure.
    for (const p of ['clickup', 'linear']) {
        const cfg = GlobalIntegrationConfigService.loadConfigSync(p);
        assert.ok(
            !cfg || !cfg.ticketSaveLocation,
            `sandboxed ${p} config must not set ticketSaveLocation — the harness predicts the default targetDir`
        );
    }

    console.log('── ClickUp: absence nominates, the endpoint convicts ──');

    // The 2026-08-05 scenario itself: a short fetch makes t2/t3 look absent. Their
    // endpoints say otherwise, so nothing is deleted — no gate required.
    await check('short fetch whose "absent" tickets are alive deletes NOTHING', async () => {
        const fx = makeFixture({ ...CU, remoteIds: ['t1'], complete: false, probeDefault: 'exists' });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 0, 'a live ticket must never be deleted, however short the fetch');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't2', 't3'], 'every local file must survive');
        assert.deepStrictEqual(fx.deletedSlugs, [], 'no imported_docs row may be dropped');
        assert.deepStrictEqual(fx.probed.sort(), ['t2', 't3'], 'only the nominated ids are probed');
    });

    await check('authoritative fetch with one id absent and confirmed gone deletes exactly that file', async () => {
        const fx = makeFixture({ ...CU, remoteIds: ['t1', 't3'], complete: true, probe: { t2: 'deleted' } });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 1, 'a confirmed deletion must reconcile');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't3'], 'only the absent ticket is removed');
        assert.deepStrictEqual(fx.deletedSlugs, ['clickup_t2'], 'its imported_docs row goes with it');
    });

    // The bug the verification path exists to fix: before this, a short fetch skipped
    // reconciliation, so a genuinely deleted ticket never left the sidebar.
    await check('SHORT fetch still removes a ticket its endpoint confirms is gone', async () => {
        const fx = makeFixture({ ...CU, remoteIds: ['t1'], complete: false, probe: { t2: 'deleted', t3: 'exists' } });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 1, 'a non-authoritative fetch must no longer block a proven deletion');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't3'], 'the live ticket stays, the dead one goes');
        assert.deepStrictEqual(fx.deletedSlugs, ['clickup_t2'], 'its imported_docs row goes with it');
    });

    await check('an unverifiable candidate (auth/timeout) is kept and reported', async () => {
        const fx = makeFixture({ ...CU, remoteIds: ['t1'], complete: true, probeDefault: 'unknown' });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 0, '"unknown" is not proof — nothing may be deleted');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't2', 't3'], 'every local file must survive');
        assert.strictEqual(res.deletionChecksUnresolved, 2, 'the caller must be told the check was incomplete');
    });

    await check('selection moved: only probe-confirmed files go, live ones stay', async () => {
        // targetDir is derived from the LIVE selection, not from listId, so an
        // authorised fetch of list A can land on list B's directory. Per-ticket proof
        // makes that harmless — B's live tickets answer their endpoints.
        const fx = makeFixture({ ...CU, selectedListId: 'L2', remoteIds: ['t1'], complete: true, probeDefault: 'exists' });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 0, 'a mismatched selection must not cost live files');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't2', 't3'], 'every local file must survive');
    });

    await check('unresolved hierarchy names (_unknown targetDir) do not delete live files', async () => {
        const fx = makeFixture({ ...CU, spaceName: '_unknown', listName: '_unknown', remoteIds: ['t1'], complete: true, probeDefault: 'exists' });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 0, 'a directory we cannot name still holds real tickets');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't2', 't3'], 'every local file must survive');
    });

    await check('EMPTY remote set with live tickets deletes NOTHING', async () => {
        // The catastrophic shape: the fetch returns nothing at all. Every local file is
        // nominated, and every one of them is saved by its own endpoint.
        const fx = makeFixture({ ...CU, remoteIds: [], complete: true, probeDefault: 'exists' });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 0, 'an empty fetch is not evidence about any ticket');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't2', 't3'], 'every local file must survive');
    });

    await check('a genuinely emptied list IS reconciled once every ticket is confirmed gone', async () => {
        const fx = makeFixture({ ...CU, remoteIds: [], complete: true, probeDefault: 'deleted' });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 3, 'proof for each ticket authorises removing each ticket');
        assert.deepStrictEqual(surviving(fx.dbTickets), [], 'the emptied list empties locally too');
    });

    await check('the probe cap bounds the work and reports the remainder', async () => {
        const many = Array.from({ length: 30 }, (_, i) => `t${i + 100}`);
        const fx = makeFixture({ ...CU, localIds: many, remoteIds: [], complete: false, probeDefault: 'deleted' });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 25, 'at most _DELETION_PROBE_CAP tickets are verified per run');
        assert.strictEqual(fx.probed.length, 25, 'the cap must bound API calls, not just deletions');
        assert.strictEqual(res.deletionChecksSkipped, 5, 'the deferred remainder must be reported, never silently dropped');
    });

    console.log('── Linear: same contract, same proof ──');

    await check('truncated fetch whose "absent" issues are alive deletes NOTHING', async () => {
        const fx = makeFixture({ ...LI, remoteIds: ['i1'], complete: false, probeDefault: 'exists' });
        const res = await runLinear(fx, 'P1');
        assert.strictEqual(res.deletedCount, 0, 'a page-capped/short Linear run must not cost live files');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['i1', 'i2', 'i3'], 'every local file must survive');
        assert.deepStrictEqual(fx.deletedSlugs, [], 'no imported_docs row may be dropped');
    });

    await check('authoritative fetch with one id absent and confirmed gone deletes exactly that file', async () => {
        const fx = makeFixture({ ...LI, remoteIds: ['i1', 'i3'], complete: true, probe: { i2: 'deleted' } });
        const res = await runLinear(fx, 'P1');
        assert.strictEqual(res.deletedCount, 1, 'a confirmed deletion must reconcile');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['i1', 'i3'], 'only the absent issue is removed');
        assert.deepStrictEqual(fx.deletedSlugs, ['linear_i2'], 'its imported_docs row goes with it');
    });

    await check('EMPTY remote set with live issues deletes NOTHING', async () => {
        const fx = makeFixture({ ...LI, remoteIds: [], complete: true, probeDefault: 'exists' });
        const res = await runLinear(fx, 'P1');
        assert.strictEqual(res.deletedCount, 0, 'an empty fetch is not evidence about any issue');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['i1', 'i2', 'i3'], 'every local file must survive');
    });

    console.log('── source contract: a read action must not fire the destructive write ──');

    await check('tickets.js posts refreshTicketsDelta only from Refresh/Refetch', async () => {
        const ticketsJs = fs.readFileSync(path.join(__dirname, '..', 'webview', 'tickets.js'), 'utf8');
        const posts = (ticketsJs.match(/type:\s*'refreshTicketsDelta'/g) || []).length;
        assert.strictEqual(
            posts, 4,
            'expected exactly 4 refreshTicketsDelta posts (Refresh + Refetch × clickup/linear). ' +
            'A 5th means a read/selection action fires the destructive sweep again — that is the ' +
            'trigger that turned a short fetch into live data loss.'
        );
        for (const arm of ["case 'clickupProjectLoaded'", "case 'linearProjectLoaded'"]) {
            const i = ticketsJs.indexOf(arm);
            assert.ok(i !== -1, `${arm} must exist`);
            const body = ticketsJs.slice(i, i + 1400);
            assert.ok(
                !/type:\s*'refreshTicketsDelta'/.test(body),
                `${arm} must not post refreshTicketsDelta — a list load is a read`
            );
        }
    });

    await check('deletion flows only through the verification path', async () => {
        const tvp = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8');
        // Every unlink of a ticket file must be _applyConfirmedDeletions'. A second
        // unlink site is how absence-based deletion would creep back in. The
        // `unlinkedAny = true` assignment is unique to that function, so it pins
        // the count to the verification-gated unlink, not other fs.promises.unlink
        // calls elsewhere in the file.
        const unlinks = (tvp.match(/fs\.promises\.unlink\(filePath\);\s*unlinkedAny/g) || []).length;
        assert.strictEqual(
            unlinks, 1,
            'exactly one ticket-file unlink site may exist (_applyConfirmedDeletions) — a second means some path deletes without proof'
        );
        assert.ok(
            !/fetchSucceeded/.test(tvp),
            'the fetchSucceeded authority flag must be gone — a list fetch nominates, it never convicts'
        );
        assert.match(
            tvp, /_confirmRemotelyDeleted\(\s*provider,\s*resolvedRoot,\s*candidates\s*\)/,
            'both sweeps must route their candidates through _confirmRemotelyDeleted'
        );
    });

    await check('the probes treat only definitive answers as deletion', async () => {
        const cus = fs.readFileSync(path.join(__dirname, '..', 'services', 'ClickUpSyncService.ts'), 'utf8');
        assert.match(
            cus, /probeTaskExistence\(taskId:\s*string\):\s*Promise<'deleted'\s*\|\s*'exists'\s*\|\s*'unknown'>/,
            'ClickUp must expose a tri-state existence probe — a boolean would collapse "unknown" into a deletion'
        );
        assert.match(
            cus, /if\s*\(result\.status\s*===\s*404\)\s*\{\s*return\s*'deleted';\s*\}/,
            'only a 404 may read as deleted'
        );
        const lss = fs.readFileSync(path.join(__dirname, '..', 'services', 'LinearSyncService.ts'), 'utf8');
        assert.match(
            lss, /probeIssueExistence\(issueId:\s*string\):\s*Promise<'deleted'\s*\|\s*'exists'\s*\|\s*'unknown'>/,
            'Linear must expose a tri-state existence probe'
        );
        // Linear's delete is a 30-day trash and a trashed issue is still fetchable by
        // id — without this the probe would report every deleted issue as alive.
        assert.match(
            lss, /node\.trashed\s*===\s*true\s*\?\s*'deleted'\s*:\s*'exists'/,
            'a trashed Linear issue must count as deleted'
        );
        assert.match(
            lss, /fetchAllIssueIds\([^)]*\):\s*Promise<\{\s*ids:\s*Set<string>;\s*complete:\s*boolean\s*\}>/,
            'fetchAllIssueIds must still report completeness — it drives the nomination warning'
        );
    });

    console.log('── Guard + path safety ──');

    await check('a non-absolute path is refused and never unlinked', async () => {
        const fx = makeFixture({ ...CU, remoteIds: ['t1', 't2', 't3'], complete: true, probe: { t1: 'deleted' } });
        const result = await TaskViewerProvider.prototype._applyConfirmedDeletions.call(
            fx.fakeThis, fx.root, fx.ticketsRoot,
            [{ remoteId: 't1', slugPrefix: 'clickup_t1', paths: ['clickup_t1.md'], dbT: fx.dbTickets[0] }],
            'guard test'
        );
        assert.strictEqual(result, 0, 'a non-absolute path must not count as a deletion');
        assert.deepStrictEqual(fx.deletedSlugs, [], 'no imported_docs row may be dropped for a refused path');
        assert.ok(fs.existsSync(fx.dbTickets[0].filePath), 'the real file must survive');
    });

    await check('a path escaping the tickets root is refused', async () => {
        const fx = makeFixture({ ...CU, remoteIds: ['t1', 't2', 't3'], complete: true, probe: { t1: 'deleted' } });
        const badPath = path.join(fx.ticketsRoot, '..', 'evil.md');
        const result = await TaskViewerProvider.prototype._applyConfirmedDeletions.call(
            fx.fakeThis, fx.root, fx.ticketsRoot,
            [{ remoteId: 't1', slugPrefix: 'clickup_t1', paths: [badPath], dbT: fx.dbTickets[0] }],
            'guard test'
        );
        assert.strictEqual(result, 0, 'a containment violation must not count as a deletion');
        assert.deepStrictEqual(fx.deletedSlugs, [], 'no imported_docs row may be dropped for a contained path');
    });

    await check('an absolute legacy row inside the tickets root still deletes', async () => {
        const fx = makeFixture({ ...CU, remoteIds: ['t2'], complete: true, probe: { t2: 'deleted' } });
        const result = await TaskViewerProvider.prototype._applyConfirmedDeletions.call(
            fx.fakeThis, fx.root, fx.ticketsRoot,
            [{ remoteId: 't2', slugPrefix: 'clickup_t2', paths: [fx.dbTickets[1].filePath], dbT: fx.dbTickets[1] }],
            'legacy test'
        );
        assert.strictEqual(result, 1, 'an absolute path inside the tickets root must unlink');
        assert.deepStrictEqual(fx.deletedSlugs, ['clickup_t2'], 'the row is dropped when the file is gone');
        assert.ok(!fs.existsSync(fx.dbTickets[1].filePath), 'the file must be gone');
    });

    await check('mixed-dir candidate: targetDir file unlinked, stale sibling ENOENTs silently', async () => {
        const fx = makeFixture({ ...CU, remoteIds: ['t1'], complete: true, probe: { t2: 'deleted', t1: 'exists', t3: 'exists' } });
        fx.dbTickets[1].filePath = path.join(fx.ticketsRoot, 'other-list', 'clickup_t2.md');
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 1, 'the moved-and-deleted ticket is removed');
        assert.deepStrictEqual(fx.deletedSlugs, ['clickup_t2'], 'its row is dropped');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't3'], 'live tickets survive');
        assert.ok(!fs.existsSync(path.join(fx.targetDir, 'clickup_t2.md')), 'the on-disk ghost is gone');
    });

    await check('ticketSaveLocation outside the workspace root deletes the real file', async () => {
        const saveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-save-'));
        const orig = GlobalIntegrationConfigService.loadConfigSync;
        try {
            GlobalIntegrationConfigService.loadConfigSync = (provider) => {
                if (provider === 'clickup') { return { ticketSaveLocation: saveRoot }; }
                return orig(provider);
            };
            const fx = makeFixture({ ...CU, ticketSaveLocation: saveRoot, remoteIds: [], complete: true, probeDefault: 'deleted' });
            const res = await runClickUp(fx, 'L1');
            assert.strictEqual(res.deletedCount, 3, 'every confirmed deletion in the save location is removed');
            assert.strictEqual(surviving(fx.dbTickets).length, 0, 'all save-location files are gone');
            assert.strictEqual(
                fs.readdirSync(path.join(saveRoot, 'clickup', slugify('space-a'), slugify('list-a'))).filter(n => n.endsWith('.md')).length,
                0,
                'the list directory under ticketSaveLocation is empty'
            );
        } finally {
            GlobalIntegrationConfigService.loadConfigSync = orig;
        }
    });

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        for (const f of failures) { console.error(`\n--- ${f.name} ---\n`, f.err); }
        process.exit(1);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
