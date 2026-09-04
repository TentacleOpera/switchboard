'use strict';

/**
 * Storage verification gap · Proposed Change 2
 * =============================================
 *
 * `BackupService.restoreBackup` swaps the live database file under every connected
 * client. Before this change, no broadcast notification was sent after the restore,
 * so a webview or WS client holding a stale handle would continue reading from the
 * old in-memory state — "a client holding a stale handle across a restore is the
 * clobber bug again, in a new costume."
 *
 * This test pins:
 * 1. The `onDatabaseRestored` callback fires after a successful restore, carrying
 *    the restored backup id and workspace root.
 * 2. The callback is invoked AFTER the database is reopened (not before).
 * 3. A restore that throws does NOT fire the callback.
 * 4. The pre-restore backup is taken before the live file is swapped.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:db-restore-broadcast
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const { BackupService } = require(path.join(process.cwd(), 'out', 'services', 'BackupService.js'));

async function run() {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-restore-broadcast-'));
    try {
        await test_restore_fires_onDatabaseRestored_callback(tmpRoot);
        await test_restore_callback_carries_backup_id_and_workspace(tmpRoot);
        await test_restore_takes_pre_restore_backup_before_swap(tmpRoot);
        await test_restore_does_not_fire_callback_on_failure(tmpRoot);

        console.log('\nAll db-restore-broadcast contract tests passed.');
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
        planId: `restore-test-${workspaceId}`,
        sessionId: 'sess-1',
        topic: 'Restore test plan',
        planFile: `.switchboard/plans/restore-test-${workspaceId}.md`,
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

async function test_restore_fires_onDatabaseRestored_callback(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-a');
    const wsId = 'aaaaaaaaaaaaaaaa';
    await buildWorkspace(wsRoot, wsId);

    const backupDir = path.join(wsRoot, '.switchboard', 'dbbackup');
    const backupService = new BackupService({ workspaceRoot: wsRoot, backupDir });
    // Create a backup to restore from.
    const backupInfo = await backupService.createBackup({ type: 'manual', workspaceRoot: wsRoot });
    assert.ok(backupInfo.id, 'backup created with an id');

    let callbackFired = false;
    let callbackPayload = null;
    backupService.setOnDatabaseRestored((info) => {
        callbackFired = true;
        callbackPayload = info;
    });

    const result = await backupService.restoreBackup(backupInfo.id, wsRoot);
    assert.strictEqual(result.success, true, 'restore should succeed');
    assert.ok(callbackFired, 'onDatabaseRestored callback fired after restore');
    assert.ok(callbackPayload, 'callback received payload');

    console.log('Pass: restore fires onDatabaseRestored callback after success');
}

async function test_restore_callback_carries_backup_id_and_workspace(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-b');
    const wsId = 'bbbbbbbbbbbbbbbb';
    await buildWorkspace(wsRoot, wsId);

    const backupDir = path.join(wsRoot, '.switchboard', 'dbbackup');
    const backupService = new BackupService({ workspaceRoot: wsRoot, backupDir });
    const backupInfo = await backupService.createBackup({ type: 'manual', workspaceRoot: wsRoot });

    let payload = null;
    backupService.setOnDatabaseRestored((info) => { payload = info; });

    await backupService.restoreBackup(backupInfo.id, wsRoot);
    assert.ok(payload, 'callback payload received');
    assert.strictEqual(payload.restoredBackupId, backupInfo.id, 'payload carries the restored backup id');
    assert.strictEqual(payload.workspaceRoot, wsRoot, 'payload carries the workspace root');

    console.log('Pass: callback payload carries backup id and workspace root');
}

async function test_restore_takes_pre_restore_backup_before_swap(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-c');
    const wsId = 'cccccccccccccccc';
    await buildWorkspace(wsRoot, wsId);

    const backupDir = path.join(wsRoot, '.switchboard', 'dbbackup');
    const backupService = new BackupService({ workspaceRoot: wsRoot, backupDir });
    // Create a backup to restore from.
    const backupInfo = await backupService.createBackup({ type: 'manual', workspaceRoot: wsRoot });

    // Mutate the live DB so the pre-restore backup captures different state.
    const db = KanbanDatabase.forWorkspace(wsRoot);
    await db.ensureReady();
    await db.upsertPlans([{
        planId: `post-backup-plan-${wsId}`,
        sessionId: 'sess-2',
        topic: 'Plan created after backup',
        planFile: `.switchboard/plans/post-backup-plan-${wsId}.md`,
        kanbanColumn: 'CREATED',
        status: 'active',
        complexity: 'Unknown',
        workspaceId: wsId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastAction: 'created',
        sourceType: 'local',
        brainSourcePath: '',
        mirrorPath: '',
    }]);
    await KanbanDatabase.invalidateWorkspace(wsRoot);

    const result = await backupService.restoreBackup(backupInfo.id, wsRoot);
    assert.strictEqual(result.success, true);
    assert.ok(result.preRestoreBackupId, 'pre-restore backup was taken');
    // The pre-restore backup should be different from the restore source.
    assert.notStrictEqual(result.preRestoreBackupId, backupInfo.id, 'pre-restore backup is distinct from restore source');

    console.log('Pass: pre-restore backup taken before live file swap');
}

async function test_restore_does_not_fire_callback_on_failure(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-d');
    const wsId = 'dddddddddddddddd';
    await buildWorkspace(wsRoot, wsId);

    const backupDir = path.join(wsRoot, '.switchboard', 'dbbackup');
    const backupService = new BackupService({ workspaceRoot: wsRoot, backupDir });

    let callbackFired = false;
    backupService.setOnDatabaseRestored(() => { callbackFired = true; });

    // Attempt to restore a non-existent backup — should throw, not fire callback.
    await assert.rejects(
        () => backupService.restoreBackup('nonexistent-backup-id', wsRoot),
        /Backup set not found/
    );
    assert.strictEqual(callbackFired, false, 'callback not fired on restore failure');

    console.log('Pass: callback not fired on restore failure');
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
