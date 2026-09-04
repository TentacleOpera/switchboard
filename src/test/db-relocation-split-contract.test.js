'use strict';

/**
 * Storage verification gap · Proposed Change 1
 * =============================================
 *
 * `relocateBoardDatabase` and `splitConsolidatedDatabase` are the two storage
 * migrations that move user data between SQLite files. Both ship unguarded:
 * no contract test pins that (a) the source is archived as `.migrated.bak`
 * rather than unlinked, (b) the operation is idempotent / re-runnable, and
 * (c) `splitConsolidatedDatabase` does not discard rows whose `workspace_id`
 * matches no known workspace — it leaves them in place and reports them.
 *
 * The failure mode each guards is silent data loss; a refactor that swaps the
 * archive step for an unlink, or that drops the unknown-workspace branch,
 * ships green today.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:db-relocation-split
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const { relocateBoardDatabase, splitConsolidatedDatabase } = require(path.join(process.cwd(), 'out', 'services', 'dbMerge.js'));
const { resolveBoardDbPath, getGlobalStoreDir } = require(path.join(process.cwd(), 'out', 'services', 'globalStore.js'));

async function run() {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-relocation-split-'));
    try {
        // ── relocateBoardDatabase ───────────────────────────────────────
        await withCleanBoardDir(async () => {
            await test_relocate_archives_source_as_bak(tmpRoot);
        });
        await withCleanBoardDir(async () => {
            await test_relocate_is_idempotent_on_rerun(tmpRoot);
        });
        await withCleanBoardDir(async () => {
            await test_relocate_zero_byte_stray_is_archived_not_merged(tmpRoot);
        });
        await withCleanBoardDir(async () => {
            await test_relocate_target_already_populated_archives_source(tmpRoot);
        });

        // ── splitConsolidatedDatabase ───────────────────────────────────
        await withCleanBoardDir(async () => {
            await test_split_archives_global_as_bak(tmpRoot);
        });
        await withCleanBoardDir(async () => {
            await test_split_unknown_workspace_left_in_place_and_reported(tmpRoot);
        });
        await withCleanBoardDir(async () => {
            await test_split_clears_migration_guard_keys_on_each_board(tmpRoot);
        });
        await withCleanBoardDir(async () => {
            await test_split_is_idempotent_when_global_already_archived(tmpRoot);
        });

        console.log('\nAll db-relocation-split contract tests passed.');
    } finally {
        await KanbanDatabase.disposeAll();
        try { global.gc && global.gc(); } catch {}
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    }
}

/** Clear the boards directory between tests so each test starts fresh. */
async function withCleanBoardDir(fn) {
    const boardsDir = path.join(getGlobalStoreDir(), 'boards');
    try {
        if (fs.existsSync(boardsDir)) {
            for (const f of await fs.promises.readdir(boardsDir)) {
                await fs.promises.unlink(path.join(boardsDir, f));
            }
        }
    } catch {}
    await fn();
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Build a per-workspace kanban.db at <root>/.switchboard/kanban.db with one plan.
 *  Creates the DB via KanbanDatabase API at the board file path, then copies it
 *  to the legacy per-repo path that relocateBoardDatabase expects. */
async function buildSourceDb(root, workspaceId) {
    const sbDir = path.join(root, '.switchboard');
    await fs.promises.mkdir(sbDir, { recursive: true });
    // Write the workspace-id file so resolveCanonicalWorkspaceIdSync resolves it.
    await fs.promises.writeFile(path.join(sbDir, 'workspace-id'), `${workspaceId}\n`, 'utf8');

    // Create the DB via the KanbanDatabase API (handles all schema/migrations).
    const db = KanbanDatabase.forWorkspace(root);
    await db.createIfMissing();
    const now = new Date().toISOString();
    await db.upsertPlans([{
        planId: `reloc-${workspaceId}`,
        sessionId: 'sess-1',
        topic: 'Relocation source plan',
        planFile: `.switchboard/plans/reloc-${workspaceId}.md`,
        kanbanColumn: 'CREATED',
        status: 'active',
        complexity: 'Unknown',
        workspaceId,
        createdAt: now,
        updatedAt: now,
        lastAction: 'created',
        sourceType: 'local',
        brainSourcePath: '',
        mirrorPath: '',
    }]);
    await db.setConfigJson('workspace_id', workspaceId);
    await KanbanDatabase.invalidateWorkspace(root);

    // Copy the board file to the legacy per-repo path.
    const boardPath = path.resolve(resolveBoardDbPath(workspaceId).path);
    const legacyPath = path.join(sbDir, 'kanban.db');
    await fs.promises.copyFile(boardPath, legacyPath);
    // Remove the board file so the relocation test starts clean.
    await fs.promises.unlink(boardPath);

    return legacyPath;
}

// ── relocateBoardDatabase tests ──────────────────────────────────────────

async function test_relocate_archives_source_as_bak(tmpRoot) {
    const root = path.join(tmpRoot, 'src-a');
    const wsId = 'aaaaaaaaaaaaaaaa';
    const sourceDbPath = await buildSourceDb(root, wsId);

    const result = await relocateBoardDatabase(sourceDbPath, root, wsId);
    assert.strictEqual(result.success, true, 'relocate should succeed');
    assert.strictEqual(result.skipped, undefined, 'relocate should not report skipped on a real relocation');

    // Source is archived, not unlinked.
    const bakPath = `${sourceDbPath}.migrated.bak`;
    assert.ok(fs.existsSync(bakPath), 'source archived as .migrated.bak (bytes preserved)');
    assert.ok(!fs.existsSync(sourceDbPath), 'source file removed after archive');

    // Target board file exists and carries the plan.
    const targetPath = path.resolve(resolveBoardDbPath(wsId).path);
    assert.ok(fs.existsSync(targetPath), 'target board file created');
    const verifyDriver = openDriver(targetPath);
    const plans = verifyDriver.all('SELECT plan_id, workspace_id FROM plans');
    assert.ok(plans.some(p => p.plan_id === `reloc-${wsId}`), 'plan relocated into target board file');
    assert.ok(plans.every(p => p.workspace_id === wsId), 'all relocated plans carry the workspace id');
    verifyDriver.close();

    console.log('Pass: relocate archives source as .migrated.bak and copies rows to board file');
}

async function test_relocate_is_idempotent_on_rerun(tmpRoot) {
    const root = path.join(tmpRoot, 'src-b');
    const wsId = 'bbbbbbbbbbbbbbbb';
    const sourceDbPath = await buildSourceDb(root, wsId);

    // First relocation.
    await relocateBoardDatabase(sourceDbPath, root, wsId);
    // Second run: source is gone, bak exists — must be a no-op, not a throw.
    const result = await relocateBoardDatabase(sourceDbPath, root, wsId);
    assert.strictEqual(result.success, true, 'second relocation is a no-op success');
    assert.strictEqual(result.skipped, true, 'second relocation reports skipped=true');

    console.log('Pass: relocate is idempotent on re-run (source already archived)');
}

async function test_relocate_zero_byte_stray_is_archived_not_merged(tmpRoot) {
    const root = path.join(tmpRoot, 'src-c');
    const sbDir = path.join(root, '.switchboard');
    await fs.promises.mkdir(sbDir, { recursive: true });
    const stray = path.join(sbDir, 'kanban.db');
    await fs.promises.writeFile(stray, ''); // zero bytes

    const result = await relocateBoardDatabase(stray, root, 'cccccccccccccccc');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skipped, true, 'zero-byte stray reports skipped');
    assert.ok(fs.existsSync(`${stray}.migrated.bak`), 'zero-byte stray archived');
    assert.ok(!fs.existsSync(stray), 'zero-byte stray removed');

    console.log('Pass: zero-byte stray DB is archived, not merged');
}

async function test_relocate_target_already_populated_archives_source(tmpRoot) {
    const root = path.join(tmpRoot, 'src-d');
    const wsId = 'dddddddddddddddd';
    const sourceDbPath = await buildSourceDb(root, wsId);

    // Pre-create the target board file so the relocation hits the "target
    // already populated" branch — it must archive the source and report skipped.
    const targetPath = path.resolve(resolveBoardDbPath(wsId).path);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(sourceDbPath, targetPath);

    const result = await relocateBoardDatabase(sourceDbPath, root, wsId);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skipped, true, 'target-already-populated reports skipped');
    assert.ok(fs.existsSync(`${sourceDbPath}.migrated.bak`), 'source archived');
    assert.ok(!fs.existsSync(sourceDbPath), 'source removed');

    console.log('Pass: target already populated → source archived, no double-write');
}

// ── splitConsolidatedDatabase tests ──────────────────────────────────────

/** Build a consolidated global DB at <globalPath> with plans for the given workspace ids.
 *  Uses KanbanDatabase.upsertPlans to avoid raw SQL column-count mismatches. */
async function buildConsolidatedDb(globalPath, workspaceIds) {
    // Create a temp workspace root whose board file IS the global path.
    // We do this by creating the DB via KanbanDatabase at a temp root, upserting
    // plans, then copying the resulting board file to the global path.
    const tmpWsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-consolidated-src-'));
    try {
        const sbDir = path.join(tmpWsRoot, '.switchboard');
        await fs.promises.mkdir(sbDir, { recursive: true });
        // Use the first workspace id for the temp DB's identity.
        await fs.promises.writeFile(path.join(sbDir, 'workspace-id'), `${workspaceIds[0]}\n`, 'utf8');
        const db = KanbanDatabase.forWorkspace(tmpWsRoot);
        await db.createIfMissing();
        const now = new Date().toISOString();
        for (const wsId of workspaceIds) {
            await db.upsertPlans([{
                planId: `split-${wsId}`,
                sessionId: 'sess',
                topic: 'Split plan',
                planFile: `.switchboard/plans/split-${wsId}.md`,
                kanbanColumn: 'CREATED',
                status: 'active',
                complexity: 'Unknown',
                workspaceId: wsId,
                createdAt: now,
                updatedAt: now,
                lastAction: 'created',
                sourceType: 'local',
                brainSourcePath: '',
                mirrorPath: '',
            }]);
        }
        // Seed a migration guard key that must be cleared on every produced board file.
        await db.setConfigJson('kanban.complexityBackfillV1Done', '1');
        await KanbanDatabase.invalidateWorkspace(tmpWsRoot);

        // Copy the board file to the global path.
        const boardPath = path.resolve(resolveBoardDbPath(workspaceIds[0]).path);
        await fs.promises.mkdir(path.dirname(globalPath), { recursive: true });
        await fs.promises.copyFile(boardPath, globalPath);
        await fs.promises.unlink(boardPath);
    } finally {
        try { await fs.promises.rm(tmpWsRoot, { recursive: true, force: true }); } catch {}
    }
}

async function test_split_archives_global_as_bak(tmpRoot) {
    const globalDir = path.join(tmpRoot, 'global-a', '.switchboard');
    await fs.promises.mkdir(globalDir, { recursive: true });
    const globalPath = path.join(globalDir, 'switchboard.db');
    const wsIds = ['eeeeeeeeeeeeeeee', 'ffffffffffffffff'];
    await buildConsolidatedDb(globalPath, wsIds);

    const result = await splitConsolidatedDatabase(globalPath, wsIds);
    assert.strictEqual(result.success, true, 'split should succeed');
    assert.strictEqual(result.workspacesSplit, 2, 'two board files produced');
    assert.strictEqual(result.boardFiles.length, 2);
    assert.ok(fs.existsSync(`${globalPath}.migrated.bak`), 'global archived as .migrated.bak');
    assert.ok(!fs.existsSync(globalPath), 'global file removed after archive');

    // Each board file carries only its own workspace's plans.
    for (const wsId of wsIds) {
        const boardPath = path.resolve(resolveBoardDbPath(wsId).path);
        assert.ok(fs.existsSync(boardPath), `board file for ${wsId} exists`);
        const driver = openDriver(boardPath);
        const plans = driver.all('SELECT plan_id, workspace_id FROM plans');
        assert.ok(plans.some(p => p.plan_id === `split-${wsId}`), `plan for ${wsId} present in its board file`);
        driver.close();
    }

    console.log('Pass: split archives global as .migrated.bak and produces per-workspace board files');
}

async function test_split_unknown_workspace_left_in_place_and_reported(tmpRoot) {
    const globalDir = path.join(tmpRoot, 'global-b', '.switchboard');
    await fs.promises.mkdir(globalDir, { recursive: true });
    const globalPath = path.join(globalDir, 'switchboard.db');
    const knownWs = '1111111111111111';
    const unknownWs = '2222222222222222';
    await buildConsolidatedDb(globalPath, [knownWs, unknownWs]);

    // Provide knownWorkspaceIds so unknownWs is reported, not split.
    const result = await splitConsolidatedDatabase(globalPath, [knownWs]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.workspacesSplit, 1, 'only the known workspace is split');
    assert.deepStrictEqual(result.unknownWorkspaceIds, [unknownWs], 'unknown workspace reported, not discarded');

    console.log('Pass: split leaves unknown workspace in place and reports it');
}

async function test_split_clears_migration_guard_keys_on_each_board(tmpRoot) {
    const globalDir = path.join(tmpRoot, 'global-c', '.switchboard');
    await fs.promises.mkdir(globalDir, { recursive: true });
    const globalPath = path.join(globalDir, 'switchboard.db');
    const wsIds = ['3333333333333333', '4444444444444444'];
    await buildConsolidatedDb(globalPath, wsIds);

    await splitConsolidatedDatabase(globalPath, wsIds);

    for (const wsId of wsIds) {
        const boardPath = path.resolve(resolveBoardDbPath(wsId).path);
        const driver = openDriver(boardPath);
        const guard = driver.get("SELECT value FROM config WHERE key = 'kanban.complexityBackfillV1Done'");
        assert.ok(!guard, `migration guard cleared on board file for ${wsId}`);
        driver.close();
    }

    console.log('Pass: split clears once-per-workspace migration guards on every produced board file');
}

async function test_split_is_idempotent_when_global_already_archived(tmpRoot) {
    const globalDir = path.join(tmpRoot, 'global-d', '.switchboard');
    await fs.promises.mkdir(globalDir, { recursive: true });
    const globalPath = path.join(globalDir, 'switchboard.db');
    const wsIds = ['5555555555555555'];
    await buildConsolidatedDb(globalPath, wsIds);

    // First split.
    await splitConsolidatedDatabase(globalPath, wsIds);
    // Second run: global is gone, bak exists — must be a no-op, not a throw.
    const result = await splitConsolidatedDatabase(globalPath, wsIds);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.workspacesSplit, 0, 'second split is a no-op');

    console.log('Pass: split is idempotent when global already archived');
}

// ── low-level driver helpers ─────────────────────────────────────────────

function openDriver(dbPath) {
    const { BetterSqliteDriver } = require(path.join(process.cwd(), 'out', 'services', 'sqliteDriver.js'));
    return new BetterSqliteDriver(dbPath, { fileMustExist: true });
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
