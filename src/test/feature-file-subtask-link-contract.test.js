'use strict';

/**
 * Feature-file → DB subtask LINKING contract.
 *
 * Pins the declarative path: a feature markdown file's `<!-- BEGIN SUBTASKS -->` /
 * `## Subtasks` block names its subtasks, and ingestion links them in kanban.db so
 * feature membership can be declared by writing files alone — no running API server.
 * That is the offline/remote authoring path (`create-feature.js`'s fallback, and the
 * `manage-features` skill's remote Create section).
 *
 * Two classes of assertion, and BOTH are load-bearing:
 *
 *  1. The block LINKS. A regression here silently produces features showing
 *     "0 SUBTASKS" on the board with no error anywhere.
 *
 *  2. The block NEVER UNLINKS. This direction is link-only by design: a path listed
 *     in the block sets feature_id, a path ABSENT from it means nothing. The block is
 *     regenerated from the DB, so anything holding a slightly-stale copy of the file
 *     (an agent mid prose-pass, a git checkout, a failed regen) writes back a block
 *     missing rows the DB legitimately has. Deriving removals from that set difference
 *     reads a stale copy as an instruction to delete, which drops subtasks off the
 *     board — see .switchboard/plans/feature-subtask-block-goes-invisible-on-stale-
 *     file-read.md, where that fired in practice via the rearrange-feature skill.
 *     Removal is an explicit operation only (_removeSubtaskFromFeature, _deleteFeature,
 *     assignPlansToFeature onto a different feature, reconcileFeatures).
 *
 * Regressions these pin, all of which kept every other gate green:
 *  - The `## Subtasks` heading fallback carried the /m flag, so `$` in its lookahead
 *    matched at every end-of-line and the lazy capture stopped after the FIRST link.
 *    Links 2..N were then read as "removed from the file" and unlinked.
 *  - No isFeature guard: the parser accepts `./x.md` targets, which resolve into
 *    .switchboard/features/, and updateFeatureStatus takes is_feature positionally —
 *    so a feature file naming a sibling feature DEMOTED it to a plan.
 *  - A bare `/##\s*Subtasks/` also matches the literal text inside prose or backticks,
 *    so a feature file documenting this very mechanism had its prose parsed as a block.
 *
 * Harness notes (mirrored from headless-feature-management-destructive.test.js — do
 * not "simplify" these):
 *  - KanbanDatabase NEVER auto-creates kanban.db (scaffold-litter policy), so the file
 *    must be touched on disk before ensureReady() will initialise it.
 *  - ONE temp workspace and ONE database for the whole suite. Per-test workspaces
 *    exhaust the shared sql.js WASM heap, presenting as "disk I/O error" everywhere.
 *  - insertFileDerivedPlan's INSERT column list does NOT include feature_id, so
 *    passing featureId in the record is a silent no-op — link via updateFeatureStatus
 *    or every "subtask" is an orphan and the unlink assertions pass vacuously.
 *  - ingestPlanFile() is used instead of the fs watcher: same _handlePlanFile path,
 *    minus the 300ms debounce, so the assertions are deterministic.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

// `vscode` → the standalone shim, installed BEFORE any out/services require.
const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
{
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') return require(shimPath);
        return originalLoad.apply(this, arguments);
    };
}

const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { BroadcastHub } = require('../../out/services/broadcastHub');
const { PlanIngestionEngine } = require('../../out/services/PlanIngestionEngine');
const { createStandalonePlanIngestionHost } = require('../../out/standalone/planIngestionHost');

const repoRoot = path.join(__dirname, '..', '..');
let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n     ') : e}`);
        failed++;
    }
}

const FEAT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FEAT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

async function run() {
    console.log('\nFeature-file → DB subtask LINKING contract\n');

    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-featlink-')));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'features'), { recursive: true });

    const db = KanbanDatabase.forWorkspace(tmpRoot);
    {
        const dbDir = path.dirname(db.dbPath);
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        if (!fs.existsSync(db.dbPath)) fs.writeFileSync(db.dbPath, Buffer.alloc(0));
        assert.ok(await db.ensureReady(), 'seeded kanban.db must initialise');
    }
    const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'featlink-ws';

    const cfg = {
        getConfigBoolean: (_k, d) => d,
        getConfigNumber: (_k, d) => d,
        getConfigJson: (_k, d) => d,
        getConfigString: (_k, d) => d ?? '',
    };
    const host = createStandalonePlanIngestionHost({
        workspaceRoot: tmpRoot, config: cfg, extraRoots: [], log: () => {},
    });
    const getSvc = () => null;
    const engine = new PlanIngestionEngine(getSvc, getSvc, host, getSvc);

    /** Seed a subtask plan row + its file. */
    async function seedPlan(slug, planId) {
        const rel = `.switchboard/plans/${slug}.md`;
        fs.writeFileSync(path.join(tmpRoot, rel), `# ${slug}\n\n## Goal\n${slug}\n`, 'utf8');
        const now = new Date().toISOString();
        assert.ok(await db.insertFileDerivedPlan({
            planId, sessionId: planId, topic: slug, planFile: rel, kanbanColumn: 'CREATED',
            status: 'active', complexity: '3', tags: '', project: '', workspaceId: wsId,
            createdAt: now, updatedAt: now, sourceType: 'local', workspaceName: 'featlink',
            isFeature: 0,
        }), `seedPlan(${slug}) must insert`);
        return rel;
    }

    /** Write a feature file (planId derived from the trailing UUID) and ingest it. */
    async function writeFeatureAndIngest(featureId, slug, body) {
        const rel = `.switchboard/features/${slug}-${featureId}.md`;
        const abs = path.join(tmpRoot, rel);
        fs.writeFileSync(abs, body, 'utf8');
        await engine.ingestPlanFile(abs, tmpRoot);
        return rel;
    }

    const linkedSlugs = async (featureId) =>
        (await db.getSubtasksByFeatureId(featureId))
            .map((s) => path.basename(String(s.planFile))).sort();

    const p1 = await seedPlan('plan-one', '11110000-0000-4000-8000-000000000001');
    const p2 = await seedPlan('plan-two', '22220000-0000-4000-8000-000000000002');
    const p3 = await seedPlan('plan-three', '33330000-0000-4000-8000-000000000003');
    void p1; void p2; void p3;

    const HEADER = (name) => `---\ndescription: '${name}'\n---\n\n# ${name}\n\n## Goal\n\n${name}.\n\n`;

    console.log('── the block LINKS ──');

    await test('a bare `## Subtasks` heading links EVERY listed link, not just the first', async () => {
        // The /m regression made this return exactly 1. Three links is the minimum
        // that distinguishes "first only" from "all of them".
        await writeFeatureAndIngest(FEAT_A, 'feat-a', HEADER('Feat A')
            + '## Subtasks\n'
            + '- [ ] [One](../plans/plan-one.md)\n'
            + '- [ ] [Two](../plans/plan-two.md)\n'
            + '- [ ] [Three](../plans/plan-three.md)\n'
            + '\n## Dependencies & sequencing\n\nnone\n');
        assert.deepStrictEqual(await linkedSlugs(FEAT_A),
            ['plan-one.md', 'plan-three.md', 'plan-two.md'],
            'all three links in a heading-only block must link');
    });

    await test('the auto-generated BEGIN/END block links, column suffixes and all', async () => {
        await writeFeatureAndIngest(FEAT_A, 'feat-a', HEADER('Feat A')
            + '<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n'
            + '- [ ] [One](../plans/plan-one.md) — **CREATED**\n'
            + '- [ ] [Two](../plans/plan-two.md) — **CODE REVIEWED**\n'
            + '- [ ] [Three](../plans/plan-three.md) — **DONE**\n'
            + '<!-- END SUBTASKS -->\n');
        assert.deepStrictEqual(await linkedSlugs(FEAT_A),
            ['plan-one.md', 'plan-three.md', 'plan-two.md'],
            'the marked block must link all three');
    });

    console.log('\n── the block NEVER UNLINKS (link-only) ──');

    await test('a STALE block listing only one subtask does not unlink the other two', async () => {
        await writeFeatureAndIngest(FEAT_A, 'feat-a', HEADER('Feat A')
            + '<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n'
            + '- [ ] [One](../plans/plan-one.md)\n'
            + '<!-- END SUBTASKS -->\n');
        assert.deepStrictEqual(await linkedSlugs(FEAT_A),
            ['plan-one.md', 'plan-three.md', 'plan-two.md'],
            'omission from the block is NOT a removal instruction');
    });

    await test('an EMPTY block wipes nothing', async () => {
        await writeFeatureAndIngest(FEAT_A, 'feat-a', HEADER('Feat A')
            + '<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n'
            + '- [ ] (no subtasks)\n'
            + '<!-- END SUBTASKS -->\n');
        assert.deepStrictEqual(await linkedSlugs(FEAT_A),
            ['plan-one.md', 'plan-three.md', 'plan-two.md'],
            'the (no subtasks) placeholder must be inert, not a wipe');
    });

    await test('re-ingesting an unchanged block is idempotent', async () => {
        const before = await linkedSlugs(FEAT_A);
        await writeFeatureAndIngest(FEAT_A, 'feat-a', HEADER('Feat A')
            + '<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n'
            + '- [ ] [One](../plans/plan-one.md)\n- [ ] [Two](../plans/plan-two.md)\n'
            + '- [ ] [Three](../plans/plan-three.md)\n<!-- END SUBTASKS -->\n');
        assert.deepStrictEqual(await linkedSlugs(FEAT_A), before, 'no churn on re-ingest');
    });

    console.log('\n── guards ──');

    await test('cross-feature guard: a second feature cannot steal an owned subtask', async () => {
        await writeFeatureAndIngest(FEAT_B, 'feat-b', HEADER('Feat B')
            + '<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n'
            + '- [ ] [Two](../plans/plan-two.md)\n'
            + '<!-- END SUBTASKS -->\n');
        assert.deepStrictEqual(await linkedSlugs(FEAT_B), [], 'FEAT_B must steal nothing');
        assert.strictEqual(
            (await db.getPlanByPlanId('22220000-0000-4000-8000-000000000002')).featureId, FEAT_A,
            'plan-two must still belong to FEAT_A');
    });

    await test('nested-feature guard: naming a sibling feature does not demote it', async () => {
        // `./x.md` resolves into .switchboard/features/, and updateFeatureStatus takes
        // is_feature positionally — so an unguarded link writes is_feature=0 here.
        const featBFile = `feat-b-${FEAT_B}.md`;
        await writeFeatureAndIngest(FEAT_A, 'feat-a', HEADER('Feat A')
            + '<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n'
            + `- [ ] [Feat B](./${featBFile})\n`
            + '<!-- END SUBTASKS -->\n');
        const featB = await db.getPlanByPlanId(FEAT_B);
        assert.strictEqual(Number(featB.isFeature), 1, 'FEAT_B must remain a feature');
        assert.notStrictEqual(featB.featureId, FEAT_A, 'FEAT_B must not become a subtask of FEAT_A');
    });

    await test('a `## Subtasks` mention inside prose is not parsed as a block', async () => {
        // A feature file documenting this very mechanism must not have its prose
        // treated as the auto block.
        const FEAT_C = 'cccccccc-0000-4000-8000-00000000000c';
        await writeFeatureAndIngest(FEAT_C, 'feat-c', HEADER('Feat C')
            + 'The watcher looks for a line-anchored `## Subtasks` heading.\n'
            + '- [ ] [One](../plans/plan-one.md)\n');
        assert.deepStrictEqual(await linkedSlugs(FEAT_C), [],
            'an indented/backticked mention must not link anything');
    });

    console.log('\n── source contract: the unlink path must stay gone ──');

    await test('linkFeatureSubtasksByPaths contains no unlink-from-file pass', async () => {
        const src = fs.readFileSync(path.join(repoRoot, 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        const start = src.indexOf('public async linkFeatureSubtasksByPaths(');
        assert.ok(start > 0, 'linkFeatureSubtasksByPaths must exist (renamed? see this suite\'s docblock)');
        // Body ends at the next method declaration at the same indent.
        const after = src.slice(start);
        const end = after.indexOf('\n    public ', 1);
        const body = end > 0 ? after.slice(0, end) : after;
        assert.ok(!/getSubtasksByFeatureId/.test(body),
            'reading the current subtask set is how the removed unlink pass computed its set difference — it must not come back');
        assert.ok(!/updateFeatureStatus\([^)]*,\s*''\s*\)/.test(body),
            "clearing feature_id inside this method is the unlink pass; removal must stay an explicit operation");
        assert.ok(!/allowUnlink/.test(body), 'the allowUnlink gate was removed with the unlink pass');
    });

    console.log('\n── create-feature.js offline fallback ──');

    await test('an unresolvable planId aborts instead of writing guessed links', async () => {
        // The guessed `../plans/<planId>.md` shape matches no row, so ingestion linked
        // nothing while the script reported ok:true — an orphaned feature, silently.
        //
        // cwd MUST be tmpRoot. create-feature.js resolves the API server as
        // `findApiPortInfo(workspaceRoot) || findApiPortInfo(process.cwd())`, and that
        // second walk climbs out of the repo — so with the default cwd this test takes
        // the live-extension path on any developer machine running Switchboard and
        // never exercises the fallback at all. tmpRoot's ancestors hold no port file,
        // so the fallback is deterministic here and in CI alike.
        const before = fs.readdirSync(path.join(tmpRoot, '.switchboard', 'features')).length;
        let code = 0;
        let out = '';
        try {
            out = execFileSync(process.execPath, [
                path.join(repoRoot, '.agents', 'skills', 'kanban_operations', 'create-feature.js'),
                'Offline Fallback Feature',
                JSON.stringify(['no-such-plan-id-0000-0000-000000000000']),
                tmpRoot,
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: tmpRoot });
        } catch (e) {
            code = e.status === undefined ? 1 : e.status;
            out = String(e.stdout || '') + String(e.stderr || '');
        }
        assert.ok(!/featureSessionId/.test(out),
            'this must exercise the offline fallback, not a live API server — check the cwd isolation above');
        assert.notStrictEqual(code, 0, `expected a non-zero exit, got ${code}. Output: ${out}`);
        assert.ok(/ok"?\s*:\s*false|Cannot resolve/i.test(out),
            `expected a resolution failure to be reported, got: ${out}`);
        assert.strictEqual(
            fs.readdirSync(path.join(tmpRoot, '.switchboard', 'features')).length, before,
            'no feature file may be written when a planId cannot be resolved');
    });

    console.log('\n── createFeatureFromPlanIds: unresolved planIds must be REPORTED ──');

    // `{success: true}` used to be the entire response, so a caller could not tell
    // "all linked" from "none linked, here is a blank card". The console.warn it
    // emitted instead lands in the extension host's dev-tools console, which no HTTP
    // or CLI caller can read. Both the total and the PARTIAL case are pinned — the
    // partial case previously produced no signal at all, not even the warning.
    const memento = () => {
        const m = new Map();
        return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => Array.from(m.keys()) };
    };
    const kp = new KanbanProvider({ fsPath: repoRoot }, {
        globalState: memento(), workspaceState: memento(),
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
        extensionUri: { fsPath: repoRoot }, extensionPath: repoRoot, subscriptions: [],
    }, undefined, undefined);
    kp._hostSeams = undefined;
    kp._broadcaster = new BroadcastHub({ webview: null, apiServer: null });
    kp._currentWorkspaceRoot = tmpRoot;

    await test('every planId unresolvable: success reports them all as skipped', async () => {
        const r = await kp.createFeatureFromPlanIds(tmpRoot, 'All Bogus', ['nope-1', 'nope-2']);
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(r.skipped, ['nope-1', 'nope-2'], 'both unresolvable ids must be reported');
        assert.deepStrictEqual(r.linked, [], 'nothing may be reported as linked');
    });

    await test('PARTIAL resolution is reported (previously no signal at all)', async () => {
        const r = await kp.createFeatureFromPlanIds(tmpRoot, 'Half Bogus',
            ['11110000-0000-4000-8000-000000000001', 'nope-3']);
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(r.skipped, ['nope-3'], 'the unresolvable id must be reported');
        assert.deepStrictEqual(r.linked, ['11110000-0000-4000-8000-000000000001'],
            'the resolvable id must be reported as linked');
    });

    await test('a fully-resolvable request reports an empty skipped list', async () => {
        const r = await kp.createFeatureFromPlanIds(tmpRoot, 'All Good',
            ['33330000-0000-4000-8000-000000000003']);
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(r.skipped, [], 'skipped must be present and empty, never undefined');
        assert.strictEqual(r.linked.length, 1, 'the one requested subtask must be linked');
    });

    try { engine.dispose(); } catch { /* never constructed a watcher */ }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch((e) => {
    console.error('feature-file subtask link contract test crashed:', e);
    process.exit(1);
});
