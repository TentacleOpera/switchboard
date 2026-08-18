'use strict';

/**
 * Contract: the team roster survives the terminals panel's whole-array save.
 * Plan: .switchboard/plans/team-roster-survives-the-webview-whole-array-save.md
 *
 * The defect this pins: `wireSpawnedTeam` wrote a BARE `terminals.groups`
 * config row while the terminals panel read and wrote
 * `switchboard.prompts.terminals.groups` (every panel-side read/write goes
 * through `saveSetting`/`getSetting`, which prefix the key). Two rows, neither
 * side able to see the other — routing never found a roster and the panel never
 * seated the team.
 *
 * Covers the plan's `### Automated Tests` list:
 *  1. backend write key === the storage key the webview's saveSetting resolves to
 *  2. bare-key migration: union by id, bare row intact, idempotent on a re-run
 *  3. a stale save whose baseIds omits an id leaves that group in place
 *  4. a deletion with matching baseIds STAYS deleted (the union trap)
 *  5. a missing baseIds takes the full-union branch
 *  6. both saveSetting arms apply the guard, through ONE implementation
 *  7. concurrency: the guarded save interleaved with wireSpawnedTeam loses neither
 *  8. every roster reference uses the exported constant — no bare-key write
 *  9. a non-array value is rejected and stores nothing
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js \
 *     src/test/terminal-groups-key-unification-contract.test.js
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
    TERMINALS_GROUPS_KEY,
    mutateTerminalGroups,
    saveTerminalGroupsGuarded,
    wireSpawnedTeam,
} = require('../../out/services/teamWiring');

const REPO_ROOT = path.resolve(__dirname, '../..');
const teamWiringTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/teamWiring.ts'), 'utf8');
const kanbanServiceTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/kanbanService.ts'), 'utf8');
const kanbanProviderTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/KanbanProvider.ts'), 'utf8');
const terminalsJs = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/terminals.js'), 'utf8');
const verbSchemasTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/verbSchemas.ts'), 'utf8');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n     ') : e}`);
        failed++;
    }
}

/** Minimal async config store, same shape KanbanDatabase exposes to teamWiring. */
function makeInMemoryDb(seed) {
    const store = Object.assign({}, seed);
    return {
        getConfigJson: async (key, fallback) =>
            (key in store ? JSON.parse(JSON.stringify(store[key])) : fallback),
        setConfigJson: async (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); return true; },
        ensureReady: async () => true,
        _store: store,
    };
}

/**
 * A settings accessor whose backing store is DISTINCT from the db's, so a test
 * can tell which one a write actually landed in — the `globalState` shadowing
 * hazard the plan calls out (a raw db write is invisible to the panel, which
 * reads through the scoped accessor).
 */
function makeScopedSettings(seed) {
    const store = Object.assign({}, seed);
    return {
        get: async (key, fallback) => (key in store ? JSON.parse(JSON.stringify(store[key])) : fallback),
        set: async (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); },
        _store: store,
    };
}

const group = (id, extra) => Object.assign({
    id, name: id, source: 'manual', layout: '1x2', members: [id], order: [id],
}, extra);

// ── 1. One key, addressed one way ──────────────────────────────────────────

async function item1() {
    console.log('\n── Item 1: the backend and the panel address ONE storage key ──');

    await test('TERMINALS_GROUPS_KEY is the key saveSetting resolves to for terminals.groups', () => {
        // The panel calls saveSetting('terminals.groups', …); both saveSetting
        // arms build `switchboard.prompts.${key}`. If the exported constant is
        // not that string the two writers address two rows again — the defect.
        assert.strictEqual(
            TERMINALS_GROUPS_KEY, 'switchboard.prompts.terminals.groups',
            'the backend roster key must equal the prefixed key the webview reads'
        );
        assert.ok(
            terminalsJs.includes("loadSetting('terminals.groups', [])"),
            'the panel must still read the webview-facing key name (only storage changed)'
        );
        assert.ok(
            terminalsJs.includes("saveSetting('terminals.groups', terminalGroups)"),
            'the panel must still write the webview-facing key name (only storage changed)'
        );
    });

    await test('wireSpawnedTeam registers under the exported constant, never the bare key', async () => {
        const db = makeInMemoryDb();
        const result = await wireSpawnedTeam({
            db, headName: 'lead-1', children: [{ friendlyName: 'lead-1-coder-1' }],
            members: [{ role: 'coder', count: 1 }],
        });
        assert.strictEqual(result.ok, true, result.error);
        const scoped = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        assert.strictEqual(scoped.length, 1, 'roster must land on the prefixed key');
        assert.strictEqual(scoped[0].id, result.groupId);
        assert.strictEqual(
            'terminals.groups' in db._store, false,
            'wireSpawnedTeam must not write the bare key — that is the split being fixed'
        );
    });

    await test('a settings accessor takes the write — a raw db row would be globalState-shadowed', async () => {
        const db = makeInMemoryDb();
        const settings = makeScopedSettings();
        const result = await wireSpawnedTeam({
            db, settings, headName: 'lead-2', children: [{ friendlyName: 'lead-2-coder-1' }],
            members: [{ role: 'coder', count: 1 }],
        });
        assert.strictEqual(result.ok, true, result.error);
        const throughAccessor = await settings.get(TERMINALS_GROUPS_KEY, []);
        assert.strictEqual(
            throughAccessor.length, 1,
            'the roster must be visible through the same accessor the panel reads'
        );
    });

    await test('no bare-key WRITE survives anywhere in the roster sources', () => {
        for (const [label, src] of [
            ['teamWiring.ts', teamWiringTs],
            ['kanbanService.ts', kanbanServiceTs],
            ['KanbanProvider.ts', kanbanProviderTs],
        ]) {
            assert.ok(
                !/setConfigJson\(\s*['"]terminals\.groups['"]/.test(src),
                `${label} must not write the bare 'terminals.groups' row`
            );
        }
    });
}

// ── 2. Shipped bare-key migration ──────────────────────────────────────────

async function item2() {
    console.log('\n── Item 2: the shipped bare key is imported, not orphaned ──');

    await test('bare rows union into the prefixed array; bare row stays; second run adds nothing', async () => {
        const db = makeInMemoryDb({
            'terminals.groups': [group('team_old'), group('shared')],
            [TERMINALS_GROUPS_KEY]: [group('manual-a'), group('shared', { name: 'prefixed-wins' })],
        });

        const first = await mutateTerminalGroups({ db }, (cur) => cur);
        const ids = first.map(g => g.id).sort();
        assert.deepStrictEqual(ids, ['manual-a', 'shared', 'team_old'], 'union by id');
        assert.strictEqual(
            first.find(g => g.id === 'shared').name, 'prefixed-wins',
            'the prefixed row wins on an id collision'
        );
        assert.ok(Array.isArray(db._store['terminals.groups']), 'the bare row must NOT be deleted (downgrade safety)');

        const second = await mutateTerminalGroups({ db }, (cur) => cur);
        assert.strictEqual(second.length, 3, 'a second pass imports nothing further');
        assert.strictEqual(
            new Set(second.map(g => g.id)).size, second.length,
            'no duplicates after a second run'
        );
    });

    await test('a bare-origin group deleted by the operator is NOT resurrected on the next save', async () => {
        // The bare row is never deleted, so an import with no ledger re-adds the
        // group on every mutation and the delete never sticks.
        const db = makeInMemoryDb({ 'terminals.groups': [group('team_old')] });
        const imported = await mutateTerminalGroups({ db }, (cur) => cur);
        assert.deepStrictEqual(imported.map(g => g.id), ['team_old']);

        const afterDelete = await mutateTerminalGroups({ db }, () => []);
        assert.deepStrictEqual(afterDelete, [], 'the delete must land');

        const afterNextSave = await mutateTerminalGroups({ db }, (cur) => cur);
        assert.deepStrictEqual(
            afterNextSave.map(g => g.id), [],
            'the deleted bare-origin group must stay deleted, not re-import from the bare row'
        );
    });

    await test('a read failure propagates instead of blind-overwriting the stored array', async () => {
        const db = makeInMemoryDb({ [TERMINALS_GROUPS_KEY]: [group('keep-me')] });
        const exploding = {
            getConfigJson: async (key, fallback) => {
                if (key === TERMINALS_GROUPS_KEY) { throw new Error('disk I/O error'); }
                return db.getConfigJson(key, fallback);
            },
            setConfigJson: db.setConfigJson,
        };
        await assert.rejects(
            () => mutateTerminalGroups({ db: exploding }, () => []),
            /disk I\/O error/,
            'an unreadable current array must fail the write, not be treated as empty'
        );
        assert.deepStrictEqual(
            db._store[TERMINALS_GROUPS_KEY].map(g => g.id), ['keep-me'],
            'the stored array must be untouched after a failed read'
        );
    });
}

// ── 3. The baseIds guard ───────────────────────────────────────────────────

async function item3() {
    console.log('\n── Item 3: baseIds separates "I deleted this" from "I never saw this" ──');

    await test('a stale save keeps a group whose id the client never read', async () => {
        const db = makeInMemoryDb({ [TERMINALS_GROUPS_KEY]: [group('A'), group('B'), group('team_new')] });
        const merged = await saveTerminalGroupsGuarded({
            db, value: [group('A')], baseIds: ['A', 'B'],   // client read {A,B}, deleted B
        });
        assert.deepStrictEqual(
            merged.map(g => g.id), ['A', 'team_new'],
            'B was seen and deleted; team_new was never seen and must survive'
        );
    });

    await test('a deletion with matching baseIds STAYS deleted (the union trap)', async () => {
        const db = makeInMemoryDb({ [TERMINALS_GROUPS_KEY]: [group('A'), group('B')] });
        const merged = await saveTerminalGroupsGuarded({ db, value: [group('A')], baseIds: ['A', 'B'] });
        assert.deepStrictEqual(merged.map(g => g.id), ['A'], 'B must not be resurrected');
        const reread = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        assert.deepStrictEqual(reread.map(g => g.id), ['A'], 'and it must stay deleted through a reload');
    });

    await test('a missing or malformed baseIds takes the full-union branch', async () => {
        for (const baseIds of [undefined, null, 'nope', [1, 2, 3]]) {
            const db = makeInMemoryDb({ [TERMINALS_GROUPS_KEY]: [group('A'), group('B')] });
            const merged = await saveTerminalGroupsGuarded({ db, value: [group('A')], baseIds });
            assert.deepStrictEqual(
                merged.map(g => g.id).sort(), ['A', 'B'],
                `baseIds=${JSON.stringify(baseIds)} must mean "saw nothing" — a full union, never "saw everything"`
            );
        }
    });

    await test('the client tracks ids it READ, and never adopts host-merged ids it does not hold', () => {
        assert.ok(
            /lastReadGroupIds = terminalGroups\.map\(g => g\.id\)/.test(terminalsJs),
            'loadLayoutSettings must set lastReadGroupIds from the validated groups'
        );
        assert.ok(
            /lastReadGroupIds = validated\.map\(g => g\.id\)/.test(terminalsJs),
            'reloadTerminalGroups must set lastReadGroupIds from the validated groups'
        );
        // The save response is the MERGED array — client rows plus rows the
        // client never read. Adopting a merged-in id makes it "seen" and the
        // next whole-array save deletes it: the clobber, rebuilt.
        assert.ok(
            /lastReadGroupIds = data\.value\.map\(g => g && g\.id\)\.filter\(id => id && held\.has\(id\)\)/.test(terminalsJs),
            'a save response must only re-affirm ids the panel actually holds'
        );
        assert.ok(
            terminalsJs.includes("body.baseIds = effectiveBaseIds"),
            'the terminals.groups save must carry baseIds'
        );
    });

    await test('baseIds is optional in the saveSetting schema', () => {
        const arm = verbSchemasTs.slice(verbSchemasTs.indexOf('    saveSetting: {'));
        const block = arm.slice(0, arm.indexOf('    getSetting: {'));
        assert.ok(block.includes("baseIds: { type: 'array' }"), 'baseIds must be declared');
        assert.ok(
            !/baseIds:\s*\{[^}]*required:\s*true/.test(block),
            'baseIds must NEVER be required — a shipped webview build sends none'
        );
    });
}

// ── 4. Both saveSetting arms, one implementation ───────────────────────────

async function item4() {
    console.log('\n── Item 4: both saveSetting arms guard, through one implementation ──');

    await test('both arms delegate to saveTerminalGroupsGuarded', () => {
        for (const [label, src] of [
            ['KanbanService.saveSetting', kanbanServiceTs],
            ['KanbanProvider inline fallback', kanbanProviderTs],
        ]) {
            assert.ok(
                src.includes('saveTerminalGroupsGuarded({'),
                `${label} must call the shared guard`
            );
        }
    });

    await test('neither arm re-implements the merge', () => {
        for (const [label, src] of [
            ['kanbanService.ts', kanbanServiceTs],
            ['KanbanProvider.ts', kanbanProviderTs],
        ]) {
            assert.ok(
                !src.includes('!baseIdSet.has(g.id)'),
                `${label} must not carry a second copy of the set difference — one implementation only`
            );
        }
        assert.strictEqual(
            (teamWiringTs.match(/!baseIdSet\.has\(g\.id\)/g) || []).length, 1,
            'the set difference must exist exactly once, in teamWiring.ts'
        );
    });

    await test('both arms reject a non-array value and store nothing', async () => {
        for (const [label, src] of [
            ['kanbanService.ts', kanbanServiceTs],
            ['KanbanProvider.ts', kanbanProviderTs],
        ]) {
            assert.ok(
                src.includes("error: 'value must be an array for terminals.groups'"),
                `${label} must reject a non-array value before writing`
            );
        }
    });

    await test('both arms turn a guard failure into an error result, never a false success', () => {
        for (const [label, src] of [
            ['kanbanService.ts', kanbanServiceTs],
            ['KanbanProvider.ts', kanbanProviderTs],
        ]) {
            assert.ok(
                src.includes('`terminals.groups save failed: ${err?.message || err}`'),
                `${label} must report a failed guarded save instead of returning success`
            );
        }
    });
}

// ── 5. Concurrency ─────────────────────────────────────────────────────────

async function item5() {
    console.log('\n── Item 5: the serialiser — a team start racing a stale panel save ──');

    await test('wireSpawnedTeam and a stale guarded save, interleaved, lose neither', async () => {
        for (let round = 0; round < 25; round++) {
            const db = makeInMemoryDb({ [TERMINALS_GROUPS_KEY]: [group('A')] });
            const [wired, merged] = await Promise.all([
                wireSpawnedTeam({
                    db, headName: `lead-${round}`, children: [{ friendlyName: `lead-${round}-coder-1` }],
                    members: [{ role: 'coder', count: 1 }],
                }),
                // The panel's array was read BEFORE the team existed.
                saveTerminalGroupsGuarded({ db, value: [group('A')], baseIds: ['A'] }),
            ]);
            assert.strictEqual(wired.ok, true, wired.error);
            const stored = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
            const ids = stored.map(g => g.id).sort();
            assert.deepStrictEqual(
                ids, ['A', wired.groupId].sort(),
                `round ${round}: neither the panel's group nor the roster may be dropped (got ${JSON.stringify(ids)}, `
                + `merged=${JSON.stringify(merged.map(g => g.id))})`
            );
        }
    });

    await test('the module-level write chain is not duplicated', () => {
        assert.strictEqual(
            (teamWiringTs.match(/let _groupsWriteChain[^=]*=\s*Promise\.resolve\(\)/g) || []).length, 1,
            'exactly one groups write chain — a second serialiser reopens the race at a smaller window'
        );
        for (const [label, src] of [
            ['kanbanService.ts', kanbanServiceTs],
            ['KanbanProvider.ts', kanbanProviderTs],
        ]) {
            assert.ok(
                !src.includes('_groupsWriteChain'),
                `${label} must reach the chain through the exported mutator, not re-implement it`
            );
        }
    });
}

(async () => {
    console.log('Terminal groups key-unification contract');
    await item1();
    await item2();
    await item3();
    await item4();
    await item5();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
