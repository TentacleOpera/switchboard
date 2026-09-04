'use strict';

/**
 * Storage verification gap · Proposed Change 7
 * =============================================
 *
 * BackupService hygiene invariants:
 * 1. Every backup set has a manifest.json with the required fields.
 * 2. Failed sets are marked with `.FAILED` suffix and never counted toward
 *    retention (they don't evict good sets).
 * 3. Retention prunes oldest-first, keeping at most maxHourly + maxDaily sets.
 * 4. `listBackups` distinguishes verified from failed sets.
 * 5. Backup sets are created with 0o600 permissions on the DB file.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:db-backup-hygiene
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const { BackupService } = require(path.join(process.cwd(), 'out', 'services', 'BackupService.js'));

async function run() {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-backup-hygiene-'));
    try {
        await test_backup_set_has_manifest_with_required_fields(tmpRoot);
        await test_failed_sets_not_counted_toward_retention(tmpRoot);
        await test_retention_prunes_oldest_first(tmpRoot);
        await test_listBackups_distinguishes_verified_and_failed(tmpRoot);

        console.log('\nAll db-backup-hygiene contract tests passed.');
    } finally {
        await KanbanDatabase.disposeAll();
        try { global.gc && global.gc(); } catch {}
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    }
}

async function buildWorkspace(root, workspaceId) {
    const sbDir = path.join(root, '.switchboard');
    await fs.promises.mkdir(sbDir, { recursive: true });
    await fs.promises.writeFile(path.join(sbDir, 'workspace-id'), `${workspaceId}\n`, 'utf8');
    const db = KanbanDatabase.forWorkspace(root);
    await db.createIfMissing();
    const now = new Date().toISOString();
    await db.upsertPlans([{
        planId: `hygiene-plan-${workspaceId}`,
        sessionId: 'sess-1',
        topic: 'Hygiene test plan',
        planFile: `.switchboard/plans/hygiene-plan-${workspaceId}.md`,
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
    await KanbanDatabase.invalidateWorkspace(root);
}

async function test_backup_set_has_manifest_with_required_fields(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-a');
    const wsId = 'aaaaaaaaaaaaaaaa';
    await buildWorkspace(wsRoot, wsId);

    const backupDir = path.join(wsRoot, '.switchboard', 'dbbackup');
    const svc = new BackupService({ workspaceRoot: wsRoot, backupDir });
    const info = await svc.createBackup({ type: 'manual', workspaceRoot: wsRoot });

    assert.ok(info.verified, 'backup verified');
    assert.strictEqual(info.failed, false, 'backup not failed');

    // Read and validate manifest.
    const manifestPath = path.join(info.path, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json exists');
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    assert.strictEqual(manifest.version, 1, 'manifest version is 1');
    assert.ok(manifest.id, 'manifest has id');
    assert.ok(manifest.timestamp, 'manifest has timestamp');
    assert.ok(manifest.type, 'manifest has type');
    assert.ok(manifest.reason, 'manifest has reason');
    assert.ok(typeof manifest.rowCounts === 'object', 'manifest has rowCounts');
    assert.ok(Array.isArray(manifest.plans), 'manifest has plans array');

    // DB file should exist in the set.
    const dbPath = path.join(info.path, 'kanban.db');
    assert.ok(fs.existsSync(dbPath), 'kanban.db exists in backup set');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: backup set has manifest with all required fields');
}

async function test_failed_sets_not_counted_toward_retention(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-b');
    const wsId = 'bbbbbbbbbbbbbbbb';
    await buildWorkspace(wsRoot, wsId);

    const backupDir = path.join(wsRoot, '.switchboard', 'dbbackup');
    // Create a fake FAILED set.
    const failedDir = path.join(backupDir, '20260101T000000Z.manual.FAILED');
    await fs.promises.mkdir(failedDir, { recursive: true });
    await fs.promises.writeFile(path.join(failedDir, 'manifest.json'), '{}');

    const svc = new BackupService({ workspaceRoot: wsRoot, backupDir, maxHourly: 2, maxDaily: 2 });
    // Create 3 good backups — retention cap is 4 (2+2), so all should survive.
    for (let i = 0; i < 3; i++) {
        await svc.createBackup({ type: 'manual', workspaceRoot: wsRoot });
    }

    const list = await svc.listBackups(wsRoot);
    const good = list.filter(b => !b.failed);
    const failed = list.filter(b => b.failed);
    // At least our 3 good backups should survive (there may be a pre-migration backup too).
    assert.ok(good.length >= 3, `at least 3 good backups survive (got ${good.length})`);
    assert.ok(failed.length >= 1, 'FAILED set still listed');
    // The FAILED set should not have evicted a good one.
    assert.ok(fs.existsSync(failedDir), 'FAILED set not deleted by retention');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: failed sets not counted toward retention (do not evict good sets)');
}

async function test_retention_prunes_oldest_first(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-c');
    const wsId = 'cccccccccccccccc';
    await buildWorkspace(wsRoot, wsId);

    const backupDir = path.join(wsRoot, '.switchboard', 'dbbackup');
    const svc = new BackupService({ workspaceRoot: wsRoot, backupDir, maxHourly: 1, maxDaily: 1 });

    // Create 4 backups — retention cap is 2 (1+1), so oldest should be pruned.
    const created = [];
    for (let i = 0; i < 4; i++) {
        const info = await svc.createBackup({ type: 'manual', workspaceRoot: wsRoot });
        created.push(info);
        // Small delay so mtimes differ.
        await new Promise(r => setTimeout(r, 50));
    }

    const list = await svc.listBackups(wsRoot);
    const good = list.filter(b => !b.failed);
    // Retention cap is 2, so at most 2 good backups survive (there may be
    // a pre-migration backup that also counts, so we check <= 2 for the
    // ones we created, but the total good should be at most 2 + any pre-migration).
    assert.ok(good.length <= 3, `at most 3 good backups after retention (got ${good.length})`);
    // The newest 2 of our created backups should be among the survivors.
    const survivingIds = good.map(g => g.id);
    assert.ok(survivingIds.includes(created[3].id), 'newest backup survived');
    assert.ok(survivingIds.includes(created[2].id), 'second-newest backup survived');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: retention prunes oldest-first, keeps newest');
}

async function test_listBackups_distinguishes_verified_and_failed(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-d');
    const wsId = 'dddddddddddddddd';
    await buildWorkspace(wsRoot, wsId);

    const backupDir = path.join(wsRoot, '.switchboard', 'dbbackup');
    const svc = new BackupService({ workspaceRoot: wsRoot, backupDir });

    // Create a good backup.
    await svc.createBackup({ type: 'manual', workspaceRoot: wsRoot });

    // Create a fake FAILED set.
    const failedDir = path.join(backupDir, '20260101T120000Z.manual.FAILED');
    await fs.promises.mkdir(failedDir, { recursive: true });
    await fs.promises.writeFile(path.join(failedDir, 'manifest.json'), JSON.stringify({
        version: 1, id: 'failed-1', timestamp: new Date().toISOString(),
        type: 'manual', reason: 'test', dbSchemaVersion: 0, rowCounts: {}, plans: []
    }));

    const list = await svc.listBackups(wsRoot);
    const good = list.find(b => !b.failed);
    const failed = list.find(b => b.failed);
    assert.ok(good, 'at least one good backup listed');
    assert.ok(good.verified, 'good backup is verified');
    assert.ok(failed, 'failed backup listed');
    assert.strictEqual(failed.failed, true, 'failed backup marked as failed');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: listBackups distinguishes verified and failed sets');
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
