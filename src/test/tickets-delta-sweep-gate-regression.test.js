/**
 * Delta deletion-sweep authorisation gate — regression test.
 *
 * On 2026-08-05 the delta refresh sweep unlinked five live ticket files and their
 * imported_docs rows while ClickUp still held all five tasks. The sweep's
 * authorisation check was `fetchSucceeded = true` set unconditionally after the ID
 * fetch — i.e. it meant "did not throw", not "is authoritative".
 * `_fetchListTasksInternal` returns SHORT results without throwing (it exits its
 * pagination loop with `complete = false` on an empty page or a run that never
 * observes `last_page: true`), so any 200 response with a short page produced a
 * `fullRemoteIds` set missing real tickets — and the sweep deleted every file whose
 * remote id was "absent".
 *
 * Deletion here is irreversible: `.switchboard/tickets/` is a working directory and
 * the sweep drops the DB row too, so there is no record a file ever existed. Every
 * ambiguous case MUST resolve to no-delete. This test pins that:
 *
 *   1. ClickUp short fetch (complete=false)          → 0 deletions
 *   2. ClickUp authoritative fetch, one id absent    → exactly that file deleted
 *   3. ClickUp authoritative but selection moved     → 0 deletions (wrong directory)
 *   4. ClickUp authoritative but hierarchy unresolved→ 0 deletions (unnameable dir)
 *   5. ClickUp authoritative but empty remote set    → 0 deletions
 *   6. Linear truncated fetch (complete=false)       → 0 deletions
 *   7. Linear authoritative fetch, one id absent     → exactly that file deleted
 *
 * Case 2 and 7 are load-bearing: they prove the harness's targetDir matches the one
 * the provider computes. Without them a wiring mistake would make every no-delete
 * assertion pass for the wrong reason.
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
 * write/orphan-subtask loops never run and the sweep is the only thing under test.
 */
function makeFixture(opts) {
    const provider = opts.provider;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delta-sweep-'));

    // Mirror the provider's targetDir derivation for the no-ticketSaveLocation path.
    const segments = provider === 'clickup'
        ? [opts.spaceName, opts.listName]
        : [opts.teamName, '_no-project'];
    const targetDir = path.join(root, '.switchboard', 'tickets', provider, ...segments.map(slugify));
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

    const clickup = {
        async getListTasks() { return []; },                       // delta: no changed tasks
        async getListTasksLive() { return { tasks: opts.remoteIds.map((id) => ({ id })), complete: opts.complete }; },
        getSelectedHierarchy() { return { spaceName: opts.spaceName, folderName: '', listName: opts.listName }; },
        async loadConfig() { return { selectedListId: opts.selectedListId }; }
    };

    const linear = {
        async queryIssues() { return []; },                        // delta: no changed issues
        async fetchAllIssueIds() { return { ids: new Set(opts.remoteIds.map(String)), complete: opts.complete }; },
        getTeamName() { return opts.teamName; }
    };

    const fakeThis = {
        _resolveWorkspaceRoot: (r) => r || root,
        _getCacheService: () => cacheService,
        _getClickUpService: () => clickup,
        _getLinearService: () => linear,
        _slugify: slugify,
        async _writeTaskDocument() { throw new Error('write loop must not run — items is empty'); },
        async _findTicketDocument() { throw new Error('orphan-subtask loop must not run — items is empty'); },
        _mergeSubtasksSection() { throw new Error('merge must not run — items is empty'); }
    };

    return { root, targetDir, dbTickets, deletedSlugs, fakeThis };
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
    // make every no-delete assertion pass vacuously. Cases 2/7 would catch it, but say
    // so plainly rather than leaving a confusing failure.
    for (const p of ['clickup', 'linear']) {
        const cfg = GlobalIntegrationConfigService.loadConfigSync(p);
        assert.ok(
            !cfg || !cfg.ticketSaveLocation,
            `sandboxed ${p} config must not set ticketSaveLocation — the harness predicts the default targetDir`
        );
    }

    console.log('── ClickUp: the sweep authority gate ──');

    await check('short fetch (complete=false, ids present) deletes NOTHING', async () => {
        const fx = makeFixture({ ...CU, remoteIds: ['t1'], complete: false });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 0, 'deletedCount must be 0 on a non-authoritative fetch');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't2', 't3'], 'every local file must survive');
        assert.deepStrictEqual(fx.deletedSlugs, [], 'no imported_docs row may be dropped');
    });

    await check('authoritative fetch with one id absent deletes exactly that file', async () => {
        const fx = makeFixture({ ...CU, remoteIds: ['t1', 't3'], complete: true });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 1, 'the authorised sweep must still reconcile');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't3'], 'only the absent ticket is removed');
        assert.deepStrictEqual(fx.deletedSlugs, ['clickup_t2'], 'its imported_docs row goes with it');
    });

    await check('selection moved since the refresh was queued deletes NOTHING', async () => {
        // targetDir is derived from the LIVE selection, not from listId: an authorised
        // fetch of list A would otherwise sweep list B's directory against A's ids.
        const fx = makeFixture({ ...CU, selectedListId: 'L2', remoteIds: ['t1'], complete: true });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 0, 'a selection mismatch must abort the sweep');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't2', 't3'], 'every local file must survive');
    });

    await check('unresolved hierarchy names (_unknown targetDir) delete NOTHING', async () => {
        const fx = makeFixture({ ...CU, spaceName: '_unknown', listName: '_unknown', remoteIds: ['t1'], complete: true });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 0, 'a directory we cannot name carries no sweep authority');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't2', 't3'], 'every local file must survive');
    });

    await check('empty selectedListId deletes NOTHING', async () => {
        const fx = makeFixture({ ...CU, selectedListId: '', remoteIds: ['t1'], complete: true });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 0, 'an unresolved selection carries no sweep authority');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't2', 't3'], 'every local file must survive');
    });

    await check('authoritative but EMPTY remote set deletes NOTHING', async () => {
        // A genuinely-emptied remote list is reconciled by an explicit user action, never
        // by a background refresh. This mirrors the non-delta gate's rawItemCount > 0.
        const fx = makeFixture({ ...CU, remoteIds: [], complete: true });
        const res = await runClickUp(fx, 'L1');
        assert.strictEqual(res.deletedCount, 0, 'an empty ID set must never authorise deletion');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['t1', 't2', 't3'], 'every local file must survive');
    });

    console.log('── Linear: fetchAllIssueIds must report completeness ──');

    await check('truncated fetch (complete=false, ids present) deletes NOTHING', async () => {
        const fx = makeFixture({ ...LI, remoteIds: ['i1'], complete: false });
        const res = await runLinear(fx, 'P1');
        assert.strictEqual(res.deletedCount, 0, 'a page-capped/short Linear run must not authorise a sweep');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['i1', 'i2', 'i3'], 'every local file must survive');
        assert.deepStrictEqual(fx.deletedSlugs, [], 'no imported_docs row may be dropped');
    });

    await check('authoritative fetch with one id absent deletes exactly that file', async () => {
        const fx = makeFixture({ ...LI, remoteIds: ['i1', 'i3'], complete: true });
        const res = await runLinear(fx, 'P1');
        assert.strictEqual(res.deletedCount, 1, 'the authorised sweep must still reconcile');
        assert.deepStrictEqual(surviving(fx.dbTickets), ['i1', 'i3'], 'only the absent issue is removed');
        assert.deepStrictEqual(fx.deletedSlugs, ['linear_i2'], 'its imported_docs row goes with it');
    });

    await check('authoritative but EMPTY remote set deletes NOTHING', async () => {
        const fx = makeFixture({ ...LI, remoteIds: [], complete: true });
        const res = await runLinear(fx, 'P1');
        assert.strictEqual(res.deletedCount, 0, 'an empty ID set must never authorise deletion');
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

    await check('the sweep gate reads completeness for both providers', async () => {
        const tvp = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.match(
            tvp, /fetchSucceeded\s*=\s*complete\s*&&\s*fullRemoteIds\.size\s*>\s*0/,
            'the ClickUp delta gate must require complete AND non-empty'
        );
        assert.match(
            tvp, /fetchSucceeded\s*=\s*linearComplete\s*&&\s*linearIds\.size\s*>\s*0/,
            'the Linear delta gate must require complete AND non-empty'
        );
        assert.ok(
            !/fetchSucceeded\s*=\s*true;/.test(tvp),
            'no unconditional `fetchSucceeded = true` may remain — "did not throw" is not authority'
        );
        const lss = fs.readFileSync(path.join(__dirname, '..', 'services', 'LinearSyncService.ts'), 'utf8');
        assert.match(
            lss, /fetchAllIssueIds\([^)]*\):\s*Promise<\{\s*ids:\s*Set<string>;\s*complete:\s*boolean\s*\}>/,
            'fetchAllIssueIds must return { ids, complete }'
        );
        assert.match(
            lss, /if\s*\(!page\?\.pageInfo\?\.hasNextPage\)\s*\{\s*complete\s*=\s*true;\s*break;\s*\}/,
            'complete must be set ONLY on the end-of-pagination exit'
        );
    });

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        for (const f of failures) { console.error(`\n--- ${f.name} ---\n`, f.err); }
        process.exit(1);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
