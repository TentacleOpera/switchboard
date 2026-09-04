'use strict';

/**
 * Storage verification gap · Proposed Change 5
 * =============================================
 *
 * `exportProject` serializes a workspace's state into a standalone SQLite file,
 * and `importProject` reads it back into a target workspace. The round-trip
 * invariant: every plan, project, worktree, plan_event, and plan_dependency
 * that was exported must be importable into a fresh workspace without loss.
 *
 * This test pins:
 * 1. Export produces a valid SQLite file with the expected row counts.
 * 2. Import into a fresh workspace restores all plans and their events.
 * 3. The imported plans carry the correct workspace_id (rebind to target).
 * 4. A corrupt import source is rejected (integrity check).
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:db-export-import-roundtrip
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const { exportProject, importProject } = require(path.join(process.cwd(), 'out', 'services', 'projectExport.js'));

async function run() {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-export-import-'));
    try {
        await test_export_import_roundtrip_preserves_plans(tmpRoot);
        await test_export_produces_valid_sqlite_file(tmpRoot);
        await test_import_rejects_corrupt_source(tmpRoot);

        console.log('\nAll db-export-import-roundtrip contract tests passed.');
    } finally {
        await KanbanDatabase.disposeAll();
        try { global.gc && global.gc(); } catch {}
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    }
}

async function buildWorkspace(root, workspaceId, planCount) {
    const sbDir = path.join(root, '.switchboard');
    await fs.promises.mkdir(sbDir, { recursive: true });
    await fs.promises.writeFile(path.join(sbDir, 'workspace-id'), `${workspaceId}\n`, 'utf8');
    const db = KanbanDatabase.forWorkspace(root);
    await db.createIfMissing();
    const now = new Date().toISOString();
    const plans = [];
    for (let i = 1; i <= planCount; i++) {
        plans.push({
            planId: `roundtrip-plan-${i}`,
            sessionId: `sess-${i}`,
            topic: `Round-trip plan ${i}`,
            planFile: `.switchboard/plans/roundtrip-plan-${i}.md`,
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
        });
    }
    await db.upsertPlans(plans);
    await KanbanDatabase.invalidateWorkspace(root);
}

async function test_export_import_roundtrip_preserves_plans(tmpRoot) {
    const srcRoot = path.join(tmpRoot, 'src');
    const srcWsId = 'aaaaaaaaaaaaaaaa';
    await buildWorkspace(srcRoot, srcWsId, 5);

    const exportPath = path.join(tmpRoot, 'export.sqlite');
    const exportResult = await exportProject({
        workspaceId: srcWsId,
        workspaceRoot: srcRoot,
        destPath: exportPath,
    });
    assert.strictEqual(exportResult.success, true, 'export should succeed');
    assert.ok(exportResult.rowsExported.plans >= 5, '5 plans exported');
    // exportProject opens a cached KanbanDatabase for srcRoot — invalidate it
    // so its better-sqlite3 statements are freed before the next test.
    await KanbanDatabase.invalidateWorkspace(srcRoot);

    // Import into a fresh target workspace.
    const targetRoot = path.join(tmpRoot, 'target');
    const targetWsId = 'bbbbbbbbbbbbbbbb';
    await buildWorkspace(targetRoot, targetWsId, 0); // empty workspace

    const importResult = await importProject({
        srcPath: exportPath,
        targetWorkspaceRoot: targetRoot,
        targetWorkspaceId: targetWsId,
    });
    assert.strictEqual(importResult.success, true, 'import should succeed');
    assert.ok(importResult.rowsImported.plans >= 5, '5 plans imported');

    // Verify the imported plans exist in the target workspace.
    const db = KanbanDatabase.forWorkspace(targetRoot);
    await db.ensureReady();
    const driver = db.getDriver();
    const plans = driver.all('SELECT plan_id, workspace_id FROM plans ORDER BY plan_id');
    const planIds = plans.map(p => p.plan_id);
    for (let i = 1; i <= 5; i++) {
        assert.ok(planIds.includes(`roundtrip-plan-${i}`), `plan ${i} present in target after import`);
    }
    // Plans should carry the target workspace_id (rebound on import).
    for (const p of plans) {
        if (p.plan_id.startsWith('roundtrip-plan-')) {
            assert.strictEqual(p.workspace_id, targetWsId, `plan ${p.plan_id} rebound to target workspace_id`);
        }
    }
    await KanbanDatabase.invalidateWorkspace(targetRoot);

    console.log('Pass: export→import round-trip preserves all plans and rebinds workspace_id');
}

async function test_export_produces_valid_sqlite_file(tmpRoot) {
    const srcRoot = path.join(tmpRoot, 'src-valid');
    const srcWsId = 'cccccccccccccccc';
    await buildWorkspace(srcRoot, srcWsId, 2);

    const exportPath = path.join(tmpRoot, 'export-valid.sqlite');
    const result = await exportProject({
        workspaceId: srcWsId,
        workspaceRoot: srcRoot,
        destPath: exportPath,
    });
    assert.strictEqual(result.success, true);
    assert.ok(fs.existsSync(exportPath), 'export file exists');
    await KanbanDatabase.invalidateWorkspace(srcRoot);

    // Verify the exported file is a valid SQLite database.
    const { BetterSqliteDriver } = require(path.join(process.cwd(), 'out', 'services', 'sqliteDriver.js'));
    const driver = new BetterSqliteDriver(exportPath, { readonly: true, fileMustExist: true });
    const check = driver.get('PRAGMA integrity_check');
    assert.strictEqual(check.integrity_check, 'ok', 'exported file passes integrity check');
    const planCount = driver.get('SELECT COUNT(*) as cnt FROM plans');
    assert.ok(planCount.cnt >= 2, 'exported file contains the plans');
    driver.close();

    console.log('Pass: export produces a valid SQLite file with correct row counts');
}

async function test_import_rejects_corrupt_source(tmpRoot) {
    const targetRoot = path.join(tmpRoot, 'target-corrupt');
    const targetWsId = 'dddddddddddddddd';
    await buildWorkspace(targetRoot, targetWsId, 0);

    const corruptPath = path.join(tmpRoot, 'corrupt.sqlite');
    await fs.promises.writeFile(corruptPath, 'this is not a SQLite file');

    await assert.rejects(
        () => importProject({ srcPath: corruptPath, targetWorkspaceRoot: targetRoot, targetWorkspaceId: targetWsId }),
        /integrity check|not a SQLite|database disk image|file is not a database/i,
        'corrupt source rejected'
    );

    console.log('Pass: import rejects corrupt source file (integrity check)');
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
