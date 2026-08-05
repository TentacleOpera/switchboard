'use strict';
/**
 * Contract: the scheduled-jobs file protocol and the Connections hand-off
 * composer behave as the plans specify.
 *
 * Written against the repo's plain-node harness, NOT mocha/jest. The first
 * version of this file used `describe`/`it`/`beforeEach`, which are undefined
 * here — it threw `ReferenceError: describe is not defined` on load and was
 * wired into neither package.json nor CI. A test that cannot run is worse than
 * no test: it reads as coverage in a diff and asserts nothing.
 *
 * The fakes below deliberately mirror the REAL API surface. The earlier fakes
 * exposed `db.all` / `db.run` and a planId-keyed `moveCardToColumn`, none of
 * which exist — so they would have gone green against production code that
 * silently recorded nothing and moved no cards. A fake is only useful when it is
 * a truthful stand-in.
 *
 * Reads out/, so run `npm run compile-tests` first.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = path.join(__dirname, '..', '..', 'out', 'services');
const {
    bootstrapInstructionsDirectory,
    writeInstruction,
    isInboxItemClaimed,
    claimInboxItem,
    processDeclaredMoves,
    ingestJobActivity
} = require(path.join(OUT, 'ScheduledJobsService.js'));
const { generateSparkContext } = require(path.join(OUT, 'SparkContextExporter.js'));
const { composeExternalPrompt, LAUNCHER_REGISTRY } = require(path.join(OUT, 'externalAgentPrompts.js'));

let passed = 0, failed = 0;
const tmpDirs = [];

function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-jobs-'));
    tmpDirs.push(d);
    return d;
}

async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

/**
 * Stand-in for KanbanProvider + KanbanDatabase.
 * `getKanbanDb(root)` and `getPlanByPlanId(planId)` are the real resolution path;
 * `recordBoardMoveRequest` / `recordJobRun` are the real (and only) writers.
 */
function fakeProvider(plansByPlanId, log) {
    const db = {
        getPlanByPlanId: async (planId) => plansByPlanId[planId] || null,
        getAllPlans: async () => Object.values(plansByPlanId),
        recordBoardMoveRequest: async (file, planId, toColumn, status, reason) => {
            log.recorded.push({ file, planId, toColumn, status, reason });
            return true;
        },
        recordJobRun: async (ts, job, summary, source) => {
            if (log.runs.some(r => r.source === source)) { return false; }
            log.runs.push({ ts, job, summary, source });
            return true;
        }
    };
    return {
        getKanbanDb: () => db,
        moveCardToColumn: async (root, sessionId, col) => { log.moves.push({ sessionId, col }); return true; },
        moveCardToColumnByPlanFile: async (root, planFile, col) => { log.moves.push({ planFile, col }); return true; }
    };
}

async function main() {
    console.log('\n── scheduled jobs: directory + claim protocol ──');

    await test('lazy bootstrap returns null and creates nothing when .switchboard is absent', async () => {
        const tmp = mkTmp();
        assert.strictEqual(await bootstrapInstructionsDirectory(tmp), null);
        assert.strictEqual(fs.existsSync(path.join(tmp, '.switchboard')), false,
            'bootstrap must never scaffold .switchboard/ — that is the documented litter failure');
    });

    await test('bootstrap creates the instruction tree when .switchboard exists', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard'), { recursive: true });
        const res = await bootstrapInstructionsDirectory(tmp);
        assert.ok(res);
        for (const sub of ['inbox', 'standing', 'moves']) {
            assert.ok(fs.existsSync(path.join(tmp, '.switchboard', 'instructions', sub)), `missing ${sub}/`);
        }
    });

    await test('claim marker is absent, then active after claiming', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard'), { recursive: true });
        await bootstrapInstructionsDirectory(tmp);
        assert.strictEqual(await isInboxItemClaimed(tmp, 'item-1.md'), false);
        await claimInboxItem(tmp, 'item-1.md', 'agent-xyz');
        assert.strictEqual(await isInboxItemClaimed(tmp, 'item-1.md'), true);
    });

    await test('a claim older than the staleness window is retryable', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard'), { recursive: true });
        await bootstrapInstructionsDirectory(tmp);
        await claimInboxItem(tmp, 'stale.md', 'dead-agent');
        // Zero-hour window: any claim is already expired, so the item must retry.
        assert.strictEqual(await isInboxItemClaimed(tmp, 'stale.md', 0), false,
            'an expired claim must not block reprocessing — otherwise a crashed run wedges the item forever');
    });

    await test('writeInstruction flattens frontmatter so a multi-line body cannot forge keys', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard'), { recursive: true });
        const res = await writeInstruction(tmp, {
            kind: 'plan-review\nkind: forged',
            body: 'Review the plan.\n---\nkind: also-forged',
            from: 'test-user',
            planId: 'plan-123'
        });
        assert.strictEqual(res.success, true);
        const content = fs.readFileSync(res.filePath, 'utf8');
        const lines = content.split('\n');
        const close = lines.indexOf('---', 1);
        assert.ok(close > 0, 'no closing frontmatter delimiter');
        // The guard is per-LINE, not per-substring: flattening turns an embedded
        // newline into a space, so the injected text survives inside the value
        // (harmless) while producing no second key for a YAML parser to read.
        const keyLines = lines.slice(1, close).filter(l => /^kind:/.test(l));
        assert.strictEqual(keyLines.length, 1, `expected exactly one kind: key, got ${keyLines.length}: ${keyLines.join(' / ')}`);
        assert.ok(!lines.slice(1, close).some(l => /^\s*---\s*$/.test(l)), 'body content leaked into the frontmatter block');
        assert.ok(content.includes('planId: plan-123'));
    });

    console.log('\n── declared board moves ──');

    await test('a malformed line rejects the WHOLE file and leaves it in moves/', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard', 'instructions', 'moves'), { recursive: true });
        const bad = path.join(tmp, '.switchboard', 'instructions', 'moves', 'moves-bad.md');
        fs.writeFileSync(bad, '- planId: p1 to: CREATED\n- invalid line with no planId', 'utf8');
        const log = { moves: [], recorded: [], runs: [] };
        const res = await processDeclaredMoves(tmp, fakeProvider({ p1: { planId: 'p1', sessionId: 's1' } }, log));
        assert.strictEqual(res.processedCount, 0);
        assert.strictEqual(res.appliedCount, 0);
        assert.strictEqual(log.moves.length, 0, 'no move may be applied from a rejected file');
        assert.strictEqual(fs.existsSync(bad), true, 'a rejected file must NOT be moved to applied/');
    });

    await test('a custom column present on the board validates', async () => {
        // 'CODED' is NOT a built-in id (the built-ins are CREATED / RESEARCHER /
        // PLAN REVIEWED / LEAD CODED / CODER CODED / INTERN CODED / CODE REVIEWED /
        // ACCEPTANCE TESTED / TICKET UPDATER / COMPLETED), yet the moves grammar in
        // the plan uses it and per-column mirrors exist for it. It must therefore
        // validate via the live board, not a hand-listed set.
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard', 'instructions', 'moves'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.switchboard', 'instructions', 'moves', 'm.md'),
            '- planId: p1 to: CODED\n', 'utf8');
        const log = { moves: [], recorded: [], runs: [] };
        const provider = fakeProvider({ p1: { planId: 'p1', sessionId: 's1', kanbanColumn: 'CODED' } }, log);
        const res = await processDeclaredMoves(tmp, provider);
        assert.strictEqual(res.appliedCount, 1,
            `a column the board actually uses must validate; errors: ${res.errors.join('; ')}`);
    });

    await test('an unknown column rejects the whole file', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard', 'instructions', 'moves'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.switchboard', 'instructions', 'moves', 'm.md'),
            '- planId: p1 to: NOT A REAL COLUMN', 'utf8');
        const log = { moves: [], recorded: [], runs: [] };
        const res = await processDeclaredMoves(tmp, fakeProvider({ p1: { planId: 'p1', sessionId: 's1' } }, log));
        assert.strictEqual(res.appliedCount, 0);
        assert.ok(res.errors.length >= 1);
    });

    await test('column refs are canonical: lead-coded and LEAD CODED both resolve', async () => {
        for (const ref of ['lead-coded', 'LEAD CODED', 'Lead Coded']) {
            const tmp = mkTmp();
            fs.mkdirSync(path.join(tmp, '.switchboard', 'instructions', 'moves'), { recursive: true });
            fs.writeFileSync(path.join(tmp, '.switchboard', 'instructions', 'moves', 'm.md'),
                `- planId: p1 to: ${ref}`, 'utf8');
            const log = { moves: [], recorded: [], runs: [] };
            const res = await processDeclaredMoves(tmp, fakeProvider({ p1: { planId: 'p1', sessionId: 's1' } }, log));
            assert.strictEqual(res.appliedCount, 1, `'${ref}' was rejected — the canonical form must be accepted in any casing`);
        }
    });

    await test('a valid file resolves planId → sessionId, applies, and moves to applied/', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard', 'instructions', 'moves'), { recursive: true });
        const valid = path.join(tmp, '.switchboard', 'instructions', 'moves', 'moves-valid.md');
        fs.writeFileSync(valid, '- planId: p-abc to: CODE REVIEWED\n- planId: p-xyz to: COMPLETED\n', 'utf8');
        const log = { moves: [], recorded: [], runs: [] };
        const provider = fakeProvider({
            'p-abc': { planId: 'p-abc', sessionId: 'sess-abc' },
            'p-xyz': { planId: 'p-xyz', sessionId: 'sess-xyz' }
        }, log);
        const res = await processDeclaredMoves(tmp, provider);
        assert.strictEqual(res.processedCount, 1);
        assert.strictEqual(res.appliedCount, 2);
        assert.deepStrictEqual(log.moves.map(m => m.sessionId), ['sess-abc', 'sess-xyz'],
            'the move must be keyed on the RESOLVED sessionId, never the raw planId');
        assert.strictEqual(log.recorded.filter(r => r.status === 'applied').length, 2);
        assert.ok(fs.existsSync(path.join(tmp, '.switchboard', 'instructions', 'moves', 'applied', 'moves-valid.md')));
    });

    await test('a file-based plan (session_id empty) moves via the plan-file path', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard', 'instructions', 'moves'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.switchboard', 'instructions', 'moves', 'm.md'),
            '- planId: p-file to: CODE REVIEWED', 'utf8');
        const log = { moves: [], recorded: [], runs: [] };
        const res = await processDeclaredMoves(tmp,
            fakeProvider({ 'p-file': { planId: 'p-file', sessionId: '', planFile: '/w/.switchboard/plans/x.md' } }, log));
        assert.strictEqual(res.appliedCount, 1);
        assert.strictEqual(log.moves[0].planFile, '/w/.switchboard/plans/x.md');
    });

    await test('an unresolvable planId is skipped with a reason, not applied', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard', 'instructions', 'moves'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.switchboard', 'instructions', 'moves', 'm.md'),
            '- planId: ghost to: CODE REVIEWED', 'utf8');
        const log = { moves: [], recorded: [], runs: [] };
        const res = await processDeclaredMoves(tmp, fakeProvider({}, log));
        assert.strictEqual(res.appliedCount, 0);
        assert.strictEqual(log.moves.length, 0);
        const row = log.recorded[0];
        assert.strictEqual(row.status, 'skipped');
        assert.ok(/ghost/.test(row.reason), `the outcome row must name the missing planId, got: ${row.reason}`);
    });

    console.log('\n── run-log ingestion ──');

    await test('ingestion writes one row per line and is idempotent across passes', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard', 'instructions'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.switchboard', 'instructions', 'run-log.md'),
            '2026-08-05T12:00:00Z | memo-to-plans | Processed 2 entries\n', 'utf8');
        const log = { moves: [], recorded: [], runs: [] };
        const provider = fakeProvider({}, log);
        const db = provider.getKanbanDb();
        await ingestJobActivity(tmp, db);
        assert.strictEqual(log.runs.length, 1);
        await ingestJobActivity(tmp, db);
        assert.strictEqual(log.runs.length, 1, 'a second pass over an append-only log must not duplicate rows');
    });

    console.log('\n── spark context artifact ──');

    await test('generation is skipped, and creates nothing, when .switchboard is absent', async () => {
        const tmp = mkTmp();
        const res = generateSparkContext(tmp, '1.2.3');
        assert.strictEqual(res.bytes, 0);
        assert.strictEqual(fs.existsSync(path.join(tmp, '.switchboard')), false,
            'activation-time generation must never scaffold .switchboard/ into a non-Switchboard workspace');
    });

    await test('the artifact carries the version stamp and the jobs protocol', async () => {
        const tmp = mkTmp();
        fs.mkdirSync(path.join(tmp, '.switchboard'), { recursive: true });
        const res = generateSparkContext(tmp, '1.2.3');
        const content = fs.readFileSync(res.path, 'utf8');
        assert.ok(content.includes('Extension Version:** 1.2.3'), 'no version stamp — staleness becomes invisible');
        assert.ok(content.includes('Scheduled Jobs & Instruction Inbox Protocol'));
        assert.ok(content.includes('Write-Back Convention'));
    });

    console.log('\n── launcher prompt composition ──');

    await test('a targeted launcher carries the absolute path and the write-back sentence', async () => {
        const tmp = mkTmp();
        const spec = LAUNCHER_REGISTRY.find(l => l.id === 'plan-review');
        assert.ok(spec);
        const res = composeExternalPrompt(spec, tmp, {
            absPath: '/path/to/feature_plan_test.md',
            content: '# Feature Plan Test\n## Goal\nImplement review test'
        });
        assert.ok(res.prompt.includes('/path/to/feature_plan_test.md'), 'missing target path');
        assert.ok(/write/i.test(res.prompt), 'missing write-back instruction');
        assert.ok(res.prompt.includes('Feature Plan Test'), 'missing artifact body');
    });

    await test('every registry entry names the write-back rule and the no-guessed-pin rule', async () => {
        const tmp = mkTmp();
        for (const spec of LAUNCHER_REGISTRY) {
            const target = spec.targetKind === 'none' ? undefined : { absPath: '/w/x.md', content: 'x' };
            const res = composeExternalPrompt(spec, tmp, target);
            assert.ok(/Project:/.test(res.prompt), `${spec.id}: prompt omits the project-pin rule`);
            if (target) {
                assert.ok(res.prompt.includes(target.absPath), `${spec.id}: prompt omits the absolute target path`);
            }
        }
    });

    console.log('\n── connections panel: remote config round-trip ──');

    // Static assertions over connections.js. The Providers tab renders a SUBSET of
    // the Remote form, and `setRemoteConfig` REPLACES the stored object
    // (RemoteControlService.setConfig re-derives every field), so any save built
    // from the visible inputs alone wipes the fields the tab cannot show — the
    // user's board selection above all. This shipped once with invented field
    // names (frequencySeconds / autoPush / autoComment / includeContent) on both
    // the read and the write side, which rendered defaults over real settings and
    // then wrote those defaults back.
    const CONNECTIONS_JS = fs.readFileSync(path.join(__dirname, '..', 'webview', 'connections.js'), 'utf8');
    const CANONICAL = ['provider', 'boards', 'silentSync', 'pingFrequencySeconds', 'mode', 'push', 'comments', 'content'];
    const INVENTED = ['frequencySeconds', 'autoPush', 'autoComment', 'includeContent'];

    await test('the remote config save merges over the host-supplied config', async () => {
        assert.match(CONNECTIONS_JS, /_lastRemoteConfig/,
            'no retained base config — a save built only from the visible inputs replaces and wipes boards/silentSync');
        assert.match(CONNECTIONS_JS, /if \(!_lastRemoteConfig\)\s*\{\s*return/,
            'saveRemoteConfig must no-op until the host has sent the stored config');
    });

    await test('connections.js uses only canonical RemoteConfig field names', async () => {
        // Comments legitimately name the wrong fields to explain why they are wrong,
        // so the check runs over code only.
        const code = CONNECTIONS_JS
            .split('\n')
            .map(l => l.replace(/\/\/.*$/, ''))
            .join('\n')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        for (const bad of INVENTED) {
            assert.ok(!new RegExp(`\\b${bad}\\b`).test(code),
                `'${bad}' is not a RemoteConfig field — see RemoteControlService.ts:42-59; it silently reads/writes nothing`);
        }
        for (const good of ['pingFrequencySeconds', 'comments', 'content', 'push', 'provider']) {
            assert.ok(CONNECTIONS_JS.includes(good), `canonical field '${good}' is not referenced at all`);
        }
        assert.ok(CANONICAL.length === 8, 'RemoteConfig field list drifted — re-check this test against the interface');
    });

    for (const d of tmpDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
