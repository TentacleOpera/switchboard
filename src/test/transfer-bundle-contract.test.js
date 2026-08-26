'use strict';
/**
 * Transfer-bundle contract — `.switchboard/plans/hand-a-workspace-to-another-machine.md`.
 *
 * Covers the plan's Automated verification items 2–9 and its Goal Invariants.
 * The point of every case here is that the failure it guards is SILENT: a bundle
 * keyed on plan_id matches nothing and reports success, a classifier defaulting
 * to portable poisons the destination, and a credential guard that only asserts
 * "the bundle is clean" passes when the guard is missing entirely.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(process.cwd(), 'out', 'services');
const { KanbanDatabase } = require(path.join(OUT, 'KanbanDatabase.js'));
const {
    TransferBundleService,
    classifyConfigKey,
    scanBundleForCredentials,
    TRANSFER_BUNDLE_SCHEMA,
} = require(path.join(OUT, 'TransferBundleService.js'));

const WORKSPACE_ID = 'ws-transfer-bundle-test';
const PLANS = ['alpha', 'beta'];
const FEATURE = 'feature-one';

async function seedWorkspace(prefix) {
    const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
    const plansDir = path.join(ws, '.switchboard', 'plans');
    await fs.promises.mkdir(plansDir, { recursive: true });
    for (const name of [...PLANS, FEATURE]) {
        await fs.promises.writeFile(path.join(plansDir, `${name}.md`), `# ${name}\n`, 'utf8');
    }
    const db = KanbanDatabase.forWorkspace(ws);
    await db.createIfMissing();
    await db.setWorkspaceId(WORKSPACE_ID);
    const now = new Date().toISOString();
    const rec = (name, extra) => Object.assign({
        planId: `${prefix}${name}`,
        sessionId: `${prefix}${name}-sess`,
        topic: name,
        planFile: `.switchboard/plans/${name}.md`,
        kanbanColumn: 'CREATED',
        status: 'active',
        complexity: 'Unknown',
        tags: '',
        repoScope: '',
        project: '',
        workspaceId: WORKSPACE_ID,
        createdAt: now,
        updatedAt: now,
        lastAction: 'created',
        sourceType: 'local',
        brainSourcePath: '',
        mirrorPath: '',
    }, extra || {});
    await db.upsertPlans([
        rec(FEATURE, { isFeature: 1 }),
        rec(PLANS[0]),
        rec(PLANS[1]),
    ]);
    return { ws, db, planId: (name) => `${prefix}${name}` };
}

function service(db, ws) {
    return new TransferBundleService({ db, getWorkspaceRoot: () => ws, log: () => {} });
}

async function run() {
    const source = await seedWorkspace('sb-transfer-src-');
    // "a *fresh* destination from the same plan files at a **different absolute
    // path**. The different path is the point — it is what proves the bundle is
    // not carrying machine identity." (plan, Verification #2)
    const dest = await seedWorkspace('sb-transfer-dst-different-path-');
    const bundlePath = path.join(source.ws, 'out-bundle.json');

    try {
        // ── Source board state: non-default columns, projects, complexity, links.
        await source.db.movePlanByPlanFile(`.switchboard/plans/${PLANS[0]}.md`, WORKSPACE_ID, 'PLAN REVIEWED');
        await source.db.movePlanByPlanFile(`.switchboard/plans/${PLANS[1]}.md`, WORKSPACE_ID, 'CODE REVIEWED');
        await source.db.updateComplexityByPlanFile(`.switchboard/plans/${PLANS[0]}.md`, WORKSPACE_ID, '5');
        await source.db.updateTagsByPlanFile(`.switchboard/plans/${PLANS[0]}.md`, WORKSPACE_ID, 'feature, backend');
        await source.db.updateRepoScopeByPlanFile(`.switchboard/plans/${PLANS[1]}.md`, WORKSPACE_ID, 'switchboard');
        await source.db.updateFeatureStatus(source.planId(PLANS[0]), 0, source.planId(FEATURE));
        await source.db.setPriorityStarred(source.planId(PLANS[1]), WORKSPACE_ID, true);

        // Portable + machine-local settings, both stores' worth.
        await source.db.setConfig('theme.name', 'obsidian');
        await source.db.setConfig('feature_workflow_mode', 'drive');
        await source.db.setConfig('switchboard.prompts.roleConfig_coder', 'You are a coder. Take the next subtask and implement it end to end, then hand back.');
        await source.db.setConfig('terminals.agentGroups', JSON.stringify([{ role: 'coder', count: 2, prompt: 'Hello {child}, report to {head}.' }]));
        await source.db.setConfig('terminals.groups', JSON.stringify({ 'Claude 3': ['seat-a'] }));
        await source.db.setConfig('terminals.standingOrders', JSON.stringify({ 'Claude 3': 'stand by' }));
        await source.db.setConfig('switchboard.prompts.terminals.paneAssignments', JSON.stringify({ p1: 'Claude 3' }));
        await source.db.setConfig('workspace_mappings', JSON.stringify({ '/Users/someone/repo': 'db' }));
        await source.db.setConfig('kanban.dbPath', '/Users/someone/.switchboard/kanban.db');

        // ── 5. Unknown-key default is machine-local.
        await source.db.setConfig('some.key.invented.later', 'value');
        assert.strictEqual(classifyConfigKey('some.key.invented.later'), 'machine-local',
            'an unclassified key defaults to machine-local');
        assert.strictEqual(classifyConfigKey(''), 'machine-local', 'an empty key defaults to machine-local');
        assert.strictEqual(classifyConfigKey('terminals.agentGroups'), 'team-shared',
            'terminals.agentGroups is the team DEFINITION — exact match must beat the terminals. prefix');
        assert.strictEqual(classifyConfigKey('terminals.groups'), 'machine-local');
        console.log('Pass 1: classifier defaults to machine-local; agentGroups exact beats the prefix');

        // ── Export.
        const exported = await service(source.db, source.ws).exportBundle({ outPath: bundlePath });
        assert.strictEqual(exported.success, true, `export should succeed: ${exported.error || ''}`);
        const bundle = JSON.parse(await fs.promises.readFile(bundlePath, 'utf8'));

        // ── 6 (the real-data half). Prompt overrides are prose, not credentials.
        // The first implementation refused to write here: every roleConfig_* value
        // and terminals.agentGroups tripped a raw 4.5-bits/char entropy threshold,
        // because English prose sits in that band. A guard that blocks the export
        // on a real workspace is not a guard, it is an outage.
        assert.ok(bundle.settings['switchboard.prompts.roleConfig_coder'],
            'a prose prompt override must survive the credential guard');
        assert.ok(bundle.settings['terminals.agentGroups'],
            'the team definition (prompt templates) must survive the credential guard');
        console.log('Pass 2: the credential guard does not fire on prose settings');

        // ── 4. Machine-local exclusion.
        for (const key of ['terminals.groups', 'terminals.standingOrders',
            'switchboard.prompts.terminals.paneAssignments', 'workspace_mappings',
            'kanban.dbPath', 'some.key.invented.later']) {
            assert.ok(!(key in bundle.settings), `${key} must not be in the bundle`);
            assert.ok(exported.settingsExcluded.includes(key),
                `${key} must be REPORTED as excluded — a silent drop is the failure mode`);
        }
        assert.ok(bundle.settings['theme.name'] === 'obsidian', 'personal-portable travels');
        assert.ok(bundle.settings['feature_workflow_mode'] === 'drive', 'team-shared travels');
        console.log('Pass 3: machine-local settings are excluded AND reported by key');

        // ── Goal Invariants.
        const asText = JSON.stringify(bundle);
        for (const forbidden of ['plan_id', 'planId', 'session_id', 'sessionId', 'workspace_id', 'workspaceId']) {
            assert.ok(!asText.includes(`"${forbidden}"`), `the bundle must carry no ${forbidden} key at any depth`);
        }
        assert.strictEqual(bundle.schema, TRANSFER_BUNDLE_SCHEMA);
        for (const card of bundle.cards) {
            assert.ok(card.planFile && !path.isAbsolute(card.planFile) && !/^[A-Za-z]:/.test(card.planFile),
                `cards[].planFile must be relative: ${card.planFile}`);
            for (const machineLocal of ['dispatched_terminal', 'last_liveness_at', 'brain_source_path',
                'mirror_path', 'routed_to', 'dispatched_agent', 'dispatched_ide']) {
                assert.ok(!(machineLocal in card), `${machineLocal} must be absent from cards[]`);
            }
        }
        assert.ok(Object.keys(bundle.settings).length > 0, 'the bundle carries a populated settings object');
        console.log('Pass 4: goal invariants hold (no machine identity, relative paths, settings present)');

        // ── 2. Round-trip onto a fresh destination at a DIFFERENT absolute path.
        const imported = await service(dest.db, dest.ws).importBundle(bundlePath);
        assert.strictEqual(imported.success, true, `import should succeed: ${imported.error || ''}`);
        assert.strictEqual(imported.cardsUpdated, 3, 'every card resolves by planFile on the destination');
        assert.deepStrictEqual(imported.partialFailures, [], 'no partial failures on a clean round trip');

        const destAlpha = await dest.db.getPlanByPlanFile(`.switchboard/plans/${PLANS[0]}.md`, WORKSPACE_ID);
        const destBeta = await dest.db.getPlanByPlanFile(`.switchboard/plans/${PLANS[1]}.md`, WORKSPACE_ID);
        const destFeature = await dest.db.getPlanByPlanFile(`.switchboard/plans/${FEATURE}.md`, WORKSPACE_ID);
        assert.strictEqual(destAlpha.kanbanColumn, 'PLAN REVIEWED');
        assert.strictEqual(destBeta.kanbanColumn, 'CODE REVIEWED');
        assert.strictEqual(destAlpha.complexity, '5');
        assert.strictEqual(destAlpha.tags, 'feature, backend');
        assert.strictEqual(destBeta.repoScope, 'switchboard');
        assert.strictEqual(Number(destBeta.priorityStarred), 1, 'priority travels');
        // The link resolves to the DESTINATION's own feature plan_id, never the source's.
        assert.strictEqual(destAlpha.featureId, destFeature.planId, 'featureFile re-keys onto the destination feature');
        assert.notStrictEqual(destAlpha.featureId, source.planId(FEATURE), 'the source plan_id must NOT be written');
        assert.strictEqual(await dest.db.getConfig('theme.name'), 'obsidian');
        assert.strictEqual(await dest.db.getConfig('terminals.groups'), null, 'no dead terminal roster on the destination');
        console.log('Pass 5: round trip at a different absolute path restores the shared tier');

        // ── 3. Idempotency.
        const again = await service(dest.db, dest.ws).importBundle(bundlePath);
        assert.strictEqual(again.success, true);
        assert.strictEqual(again.cardsUpdated, 3);
        const destAlpha2 = await dest.db.getPlanByPlanFile(`.switchboard/plans/${PLANS[0]}.md`, WORKSPACE_ID);
        assert.strictEqual(destAlpha2.kanbanColumn, destAlpha.kanbanColumn);
        assert.strictEqual(destAlpha2.complexity, destAlpha.complexity);
        assert.strictEqual(destAlpha2.featureId, destAlpha.featureId);
        assert.strictEqual(destAlpha2.updatedAt, destAlpha.updatedAt,
            're-importing an unchanged bundle must not write — updated_at is the witness');
        console.log('Pass 6: importing the same bundle twice changes nothing');

        // ── 7. Unmatched card is skipped and reported; no row is created.
        const ghostPath = path.join(source.ws, 'ghost-bundle.json');
        const ghost = JSON.parse(JSON.stringify(bundle));
        ghost.cards.push({
            planFile: '.switchboard/plans/never-committed.md',
            column: 'PLAN REVIEWED', project: '', complexity: '3',
            isFeature: false, featureFile: null, tags: '', repoScope: '', priority: false,
        });
        await fs.promises.writeFile(ghostPath, JSON.stringify(ghost, null, 2), 'utf8');
        const before = (await dest.db.getBoard(WORKSPACE_ID)).length;
        const ghostResult = await service(dest.db, dest.ws).importBundle(ghostPath);
        assert.strictEqual(ghostResult.success, true);
        assert.strictEqual(ghostResult.cardsSkipped.length, 1, 'the unmatched card is collected');
        assert.strictEqual(ghostResult.cardsSkipped[0].planFile, '.switchboard/plans/never-committed.md');
        assert.match(ghostResult.cardsSkipped[0].reason, /not in this checkout/,
            'a card with no file on disk is reported as missing from the checkout');
        assert.strictEqual((await dest.db.getBoard(WORKSPACE_ID)).length, before,
            'import is update-only — a card with no file behind it is NEVER created');
        assert.strictEqual(
            await dest.db.getPlanByPlanFile('.switchboard/plans/never-committed.md', WORKSPACE_ID), null);
        // A file that IS on disk but has no row yet is a DIFFERENT failure: the
        // plan watcher had not ingested it. Reporting that as "not in this
        // checkout" sends the user hunting a git problem they do not have.
        const notIngestedWs = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-transfer-not-ingested-'));
        try {
            await fs.promises.mkdir(path.join(notIngestedWs, '.switchboard', 'plans'), { recursive: true });
            for (const name of [...PLANS, FEATURE]) {
                await fs.promises.writeFile(path.join(notIngestedWs, '.switchboard', 'plans', `${name}.md`), `# ${name}\n`, 'utf8');
            }
            const emptyDb = KanbanDatabase.forWorkspace(notIngestedWs);
            await emptyDb.createIfMissing();
            await emptyDb.setWorkspaceId(WORKSPACE_ID);
            const early = await service(emptyDb, notIngestedWs).importBundle(bundlePath);
            assert.strictEqual(early.success, true);
            assert.strictEqual(early.cardsUpdated, 0,
                'an import that runs before ingestion matches NOTHING — this is why the first-run import is deferred');
            for (const skip of early.cardsSkipped) {
                assert.match(skip.reason, /not yet imported by the plan watcher/,
                    'a file present on disk with no row is reported as not-yet-ingested, not as missing from the checkout');
            }
        } finally {
            await KanbanDatabase.invalidateWorkspace(notIngestedWs);
            await fs.promises.rm(notIngestedWs, { recursive: true, force: true });
        }
        console.log('Pass 7: unmatched cards are skipped, never created, and the two skip reasons are distinguished');

        // ── 6. The credential guard REFUSES, and names the key. Asserting the
        // refusal (not merely a clean bundle) is what fails when the guard is gone.
        await source.db.setConfig('theme.name', 'lin_api_9f8e7d6c5b4a39281706f5e4d3c2b1a0');
        const refused = await service(source.db, source.ws).exportBundle({ outPath: path.join(source.ws, 'refused.json') });
        assert.strictEqual(refused.success, false, 'export must REFUSE when a credential shape is present');
        assert.ok(/theme\.name/.test(refused.error || ''), 'the refusal names the offending key');
        assert.strictEqual(fs.existsSync(path.join(source.ws, 'refused.json')), false, 'nothing is written on refusal');
        await source.db.setConfig('theme.name', 'obsidian');
        console.log('Pass 8: the credential guard refuses the write and names the key');

        // Shape-first detection: a real token in any position, prose in none.
        const cred = (settings) => scanBundleForCredentials({ schema: 1, exportedAt: '', sourceWorkspaceName: '', cards: [], settings });
        for (const [label, value] of [
            ['linear', 'lin_api_abc123'],
            ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
            ['40-char hex', 'a3f9c2e1b8d47a6f0c5e9b2d1f8a4c7e6b3d0a9f'],
            ['base64', 'kJ8Hn2Qw9ZxL4vB7mR1tY6pA3sD5fG0hJ2kL4nM6oP8='],
            ['token inside JSON', '{"note":"use kJ8Hn2Qw9ZxL4vB7mR1tY6pA3sD5fG0hJ2kL4nM6oP8= here"}'],
            ['bearer header', 'Authorization: Bearer abc'],
        ]) {
            assert.strictEqual(cred({ 'theme.name': value }).length, 1, `${label} must be detected`);
        }
        for (const [label, value] of [
            ['prose prompt', 'You are the reviewer. Read the plan file as the source of truth, then report findings by severity.'],
            ['json config', JSON.stringify({ role: 'coder', count: 2, prompt: 'Hello {child}, report to {head}.' })],
            ['posix path', '/Users/someone/Documents/GitHub/switchboard/.switchboard/plans'],
        ]) {
            assert.deepStrictEqual(cred({ 'theme.name': value }), [], `${label} must NOT be flagged`);
        }
        assert.strictEqual(cred({ 'linear.apiToken': 'x' }).length, 1, 'a credential-shaped KEY is flagged on its own');
        console.log('Pass 9: credential detection is shape-first — catches hex/base64/embedded, not prose');

        // ── 9. Import reuse — the transfer import and restoreFromBackup resolve
        // plan files through the SAME symbol, and the import never creates a row.
        const svcSrc = await fs.promises.readFile(path.join(process.cwd(), 'src', 'services', 'TransferBundleService.ts'), 'utf8');
        const dbSrc = await fs.promises.readFile(path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        assert.ok(/getPlanByPlanFile\(/.test(svcSrc), 'the transfer import resolves via getPlanByPlanFile');
        const restoreBody = dbSrc.slice(dbSrc.indexOf('public async restoreFromBackup'));
        assert.ok(/getPlanByPlanFile\(/.test(restoreBody.slice(0, 6000)),
            'restoreFromBackup resolves via the same getPlanByPlanFile symbol');
        assert.ok(!/upsertPlans|createPlan|INSERT INTO plans/.test(svcSrc),
            'the transfer import is update-only — it must have no row-creating call');
        // getPlanByPlanFile can fall through to the cold archive and call
        // restoreToHot(), which opens its own BEGIN. Resolving inside
        // restoreFromBackup's transaction would nest one and roll the whole
        // restore back, so the lookups must be hoisted above the BEGIN.
        const beginIdx = restoreBody.indexOf("this._db.run('BEGIN')");
        const resolveIdx = restoreBody.indexOf('getPlanByPlanFile(');
        assert.ok(resolveIdx > -1 && beginIdx > -1 && resolveIdx < beginIdx,
            'restoreFromBackup must resolve plan files BEFORE opening its transaction');
        console.log('Pass 10: both restore paths share getPlanByPlanFile; the import creates nothing');

        // ── 8. Host parity — both composition roots wire export AND import.
        const extSrc = await fs.promises.readFile(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
        const bootSrc = await fs.promises.readFile(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        const apiSrc = await fs.promises.readFile(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const pkg = JSON.parse(await fs.promises.readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
        for (const [label, src] of [['extension.ts', extSrc], ['bootstrap.ts', bootSrc]]) {
            for (const cmd of ['switchboard.exportTransferBundle', 'switchboard.importTransferBundle']) {
                assert.ok(src.includes(`'${cmd}'`), `${label} must wire ${cmd} — the two roots must not diverge`);
            }
            assert.ok(src.includes('new TransferBundleService('), `${label} must construct the service itself`);
        }
        for (const route of ['/kanban/transfer/export', '/kanban/transfer/import']) {
            assert.ok(apiSrc.includes(route), `the shared route table must answer ${route}`);
        }
        // A command registered but not contributed has no palette entry: in the
        // extension the feature would ship with no reachable entry point at all.
        const contributed = (pkg.contributes.commands || []).map(c => c.command);
        for (const cmd of ['switchboard.exportTransferBundle', 'switchboard.importTransferBundle']) {
            assert.ok(contributed.includes(cmd), `${cmd} must be contributed in package.json`);
        }
        // The bundle must stay ignored if a user drops one in the tree.
        const excludeSrc = await fs.promises.readFile(path.join(process.cwd(), 'src', 'services', 'WorkspaceExcludeService.ts'), 'utf8');
        assert.ok(excludeSrc.includes('switchboard-transfer*.json'), 'the gitignore template must ignore a bundle in the tree');
        console.log('Pass 11: host parity — both roots, both routes, both palette entries, gitignore template');

        // ── The CLI surface. The standalone host is the likelier DESTINATION, so
        // a bundle it can only import via a hand-rolled curl defeats the point.
        const cliSrc = await fs.promises.readFile(path.join(process.cwd(), 'src', 'standalone', 'cli.ts'), 'utf8');
        for (const marker of ["process.argv[2] === 'export'", "process.argv[2] === 'import'"]) {
            assert.ok(cliSrc.includes(marker), `cli.ts must dispatch ${marker}`);
        }
        assert.ok(/npx switchboard export/.test(cliSrc) && /npx switchboard import/.test(cliSrc),
            'both subcommands must appear in the usage text');
        assert.ok(cliSrc.includes('firstRunDatabaseMenu'), 'cli.ts must offer the first-run database menu');
        // The menu MUST be TTY-gated: a blocking prompt in a detached child, a
        // cron run or a piped invocation would hang the boot instead of serving.
        assert.ok(/process\.stdin\.isTTY/.test(cliSrc), 'the first-run menu must be gated on a TTY');
        assert.ok(/isDetachedChildProcess\(\)/.test(cliSrc), 'the first-run menu must never run in a detached child');
        // Option 3 cannot import inline — the plan files are not rows yet.
        assert.ok(cliSrc.includes('runPendingBundleImport'), 'option 3 must defer its import');
        const deferIdx = cliSrc.indexOf('await runPendingBundleImport');
        const bootIdx = cliSrc.indexOf('await startHeadlessSwitchboard(');
        assert.ok(deferIdx > -1 && bootIdx > -1 && deferIdx > bootIdx,
            'the deferred import must run AFTER the host boots, or it matches nothing');
        assert.ok(cliSrc.includes("childArgv.push('--import-bundle'"),
            'a deferred import chosen in the parent must cross the --detach fork');
        // Resolution must not construct a KanbanDatabase: forWorkspace caches the
        // path at construction, so a pre-menu instance would ignore a db-pointer
        // written by option 2 for the rest of the process.
        assert.ok(/readDbPointer\(workspaceRoot\)/.test(cliSrc),
            'the board-existence check must resolve the path statically, not via forWorkspace');
        assert.ok(!cliSrc.slice(0, cliSrc.indexOf('function boardExists')).includes('KanbanDatabase.forWorkspace('),
            'nothing before boardExists may construct a KanbanDatabase');
        console.log('Pass 12: CLI surface — export/import subcommands, TTY-gated menu, deferred import, detach hand-off');

        console.log('\nAll transfer-bundle contract tests passed successfully.');
    } finally {
        await KanbanDatabase.invalidateWorkspace(source.ws);
        await KanbanDatabase.invalidateWorkspace(dest.ws);
        await fs.promises.rm(source.ws, { recursive: true, force: true });
        await fs.promises.rm(dest.ws, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
});
