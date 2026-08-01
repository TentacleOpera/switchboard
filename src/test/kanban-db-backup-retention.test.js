'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

async function run() {
    const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-db-backup-test-'));
    const backupDir = path.join(ws, '.switchboard', 'dbbackup');

    try {
        await fs.promises.mkdir(backupDir, { recursive: true });
        const db = KanbanDatabase.forWorkspace(ws);
        // ensureReady() alone does NOT create a missing DB (it returns false and leaves
        // _db null, which makes writeDbBackup a silent no-op). createIfMissing() is the
        // creation entry point — and it runs migrations, so it writes a pre-migration
        // snapshot of its own. Clear the directory before the first assertion.
        const created = await db.createIfMissing();
        assert.strictEqual(created, true, 'DB should be created for the test workspace');
        const cap = 2; // KanbanDatabase.BACKUP_RETENTION_CAP_PER_REASON
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }

        // Change the DB's bytes so the next export() differs from the previous snapshot.
        const mutate = async (planId) => {
            const nowStr = new Date().toISOString();
            await db.upsertPlans([{
                planId,
                sessionId: `${planId}-sess`,
                topic: `Backup Retention ${planId}`,
                planFile: `.switchboard/plans/${planId}.md`,
                kanbanColumn: 'CREATED',
                status: 'active',
                complexity: 'Unknown',
                workspaceId: 'ws-backup-retention',
                createdAt: nowStr,
                updatedAt: nowStr,
                lastAction: 'created',
                sourceType: 'local',
                brainSourcePath: '',
                mirrorPath: ''
            }]);
        };

        // 1. The reported bug, reproduced then fixed.
        // Seed 5 old pre-migration files and 3 recent bulk-change files.
        const files1 = [
            'kanban.db.backup.pre-migration.2026-07-30T18-25-27-000Z',
            'kanban.db.backup.pre-migration.2026-07-30T18-43-30-000Z',
            'kanban.db.backup.pre-migration.2026-07-30T18-43-38-000Z',
            'kanban.db.backup.pre-migration.2026-07-30T18-45-59-000Z',
            'kanban.db.backup.pre-migration.2026-07-30T18-48-49-000Z',
            'kanban.db.backup.bulk-change.2026-07-31T10-00-00-000Z',
            'kanban.db.backup.bulk-change.2026-07-31T10-01-00-000Z',
            'kanban.db.backup.bulk-change.2026-07-31T10-02-00-000Z',
        ];
        for (const f of files1) {
            await fs.promises.writeFile(path.join(backupDir, f), 'dummy');
        }
        await db['_pruneDbBackups'](backupDir);
        const current1 = await fs.promises.readdir(backupDir);
        // Under the old global lexicographic prune, ALL THREE bulk-change files were
        // deleted (b < p) while every pre-migration file survived. Under per-reason
        // retention the newest `cap` of each reason survive and neither reason starves.
        const bulk1 = current1.filter(f => f.includes('bulk-change'));
        const pre1 = current1.filter(f => f.includes('pre-migration'));
        assert.strictEqual(bulk1.length, cap, 'bulk-change snapshots are retained, not starved');
        assert.ok(current1.includes('kanban.db.backup.bulk-change.2026-07-31T10-01-00-000Z'));
        assert.ok(current1.includes('kanban.db.backup.bulk-change.2026-07-31T10-02-00-000Z'));
        assert.strictEqual(pre1.length, cap, 'pre-migration is capped at the same cap');
        console.log('Pass 1: Reported bug fixed (bulk-change files survive prune)');

        // Cleanup directory for test 2
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }

        // 2. Newest-per-reason is what survives.
        const files2 = [
            'kanban.db.backup.pre-migration.2026-07-30T10-00-00-000Z',
            'kanban.db.backup.pre-migration.2026-07-30T11-00-00-000Z',
            'kanban.db.backup.pre-migration.2026-07-30T12-00-00-000Z',
            'kanban.db.backup.pre-migration.2026-07-30T13-00-00-000Z',
            'kanban.db.backup.pre-migration.2026-07-30T14-00-00-000Z',
            'kanban.db.backup.pre-migration.2026-07-30T15-00-00-000Z',
        ];
        for (const f of files2) {
            await fs.promises.writeFile(path.join(backupDir, f), 'dummy');
        }
        await db['_pruneDbBackups'](backupDir);
        const current2 = await fs.promises.readdir(backupDir);
        assert.strictEqual(current2.length, 2);
        assert.ok(current2.includes('kanban.db.backup.pre-migration.2026-07-30T14-00-00-000Z'));
        assert.ok(current2.includes('kanban.db.backup.pre-migration.2026-07-30T15-00-00-000Z'));
        console.log('Pass 2: Newest per reason retained up to cap');

        // Cleanup
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }

        // 3. Reasons cannot starve each other.
        for (let i = 10; i < 30; i++) {
            await fs.promises.writeFile(path.join(backupDir, `kanban.db.backup.pre-migration.2026-07-30T${i}-00-00-000Z`), 'dummy');
        }
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.bulk-change.2026-07-30T12-00-00-000Z'), 'dummy');
        await db['_pruneDbBackups'](backupDir);
        const current3 = await fs.promises.readdir(backupDir);
        assert.strictEqual(current3.length, 3);
        assert.ok(current3.includes('kanban.db.backup.bulk-change.2026-07-30T12-00-00-000Z'));
        console.log('Pass 3: Reasons do not starve each other');

        // Cleanup
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }

        // 4. Legacy files stay prunable & unparseable fallback.
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.pre-migration.2026-07-30T10-00-00-000Z'), 'dummy');
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.pre-migration.2026-07-30T11-00-00-000Z'), 'dummy');
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.pre-migration.no-timestamp-here'), 'dummy');
        await db['_pruneDbBackups'](backupDir);
        const current4 = await fs.promises.readdir(backupDir);
        assert.strictEqual(current4.length, 2);
        assert.ok(!current4.includes('kanban.db.backup.pre-migration.no-timestamp-here'));
        console.log('Pass 4: Legacy files and unparseable fallback pruned correctly');

        // Cleanup
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }

        // 5. Adversarial reason ordering.
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.zzz.2026-07-31T12-00-00-000Z'), 'dummy');
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.aaa.2026-07-30T12-00-00-000Z'), 'dummy');
        await db['_pruneDbBackups'](backupDir);
        const current5 = await fs.promises.readdir(backupDir);
        assert.strictEqual(current5.length, 2);
        assert.ok(current5.includes('kanban.db.backup.zzz.2026-07-31T12-00-00-000Z'));
        assert.ok(current5.includes('kanban.db.backup.aaa.2026-07-30T12-00-00-000Z'));
        console.log('Pass 5: Adversarial reason lexicographical sorting does not affect independent caps');

        // Cleanup
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }

        // 6 & 7. Content dedupe per reason & mutation bypass.
        // Stub rate limit map temporarily to test dedupe logic directly
        const origThrottles = { ...KanbanDatabase['BACKUP_REASON_THROTTLES_MS'] };
        KanbanDatabase['BACKUP_REASON_THROTTLES_MS']['pre-migration'] = 0;

        await db.writeDbBackup('pre-migration');
        const countAfterWrite1 = (await fs.promises.readdir(backupDir)).filter(f => f.includes('pre-migration')).length;
        assert.strictEqual(countAfterWrite1, 1);

        // Same state call again
        await db.writeDbBackup('pre-migration');
        const countAfterWrite2 = (await fs.promises.readdir(backupDir)).filter(f => f.includes('pre-migration')).length;
        assert.strictEqual(countAfterWrite2, 1, 'Content dedupe suppressed duplicate pre-migration');

        // Call bulk-change with same DB content
        await db.writeDbBackup('bulk-change');
        const countAfterBulk = (await fs.promises.readdir(backupDir)).filter(f => f.includes('bulk-change')).length;
        assert.strictEqual(countAfterBulk, 1, 'Content dedupe is per-reason; bulk-change written');

        // Mutate DB and write pre-migration again
        await mutate('dedupe-plan');
        await db.writeDbBackup('pre-migration');
        const countAfterMutate = (await fs.promises.readdir(backupDir)).filter(f => f.includes('pre-migration')).length;
        assert.strictEqual(countAfterMutate, 2, 'Mutated DB produced new snapshot');

        console.log('Pass 6 & 7: Content dedupe per-reason and mutation checks passed');

        // Restore throttles
        KanbanDatabase['BACKUP_REASON_THROTTLES_MS'] = origThrottles;

        // Cleanup
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }

        // 8. Rate limiting tests
        // Seed pre-migration stamped 1 min ago
        const oneMinAgo = new Date(Date.now() - 60000).toISOString().replace(/[:.]/g, '-');
        await fs.promises.writeFile(path.join(backupDir, `kanban.db.backup.pre-migration.${oneMinAgo}`), 'dummy');

        await db.writeDbBackup('pre-migration');
        const countPreThrottled = (await fs.promises.readdir(backupDir)).filter(f => f.includes('pre-migration')).length;
        assert.strictEqual(countPreThrottled, 1, 'Rate limit throttled pre-migration snapshot within 30 min window');

        // Seed bulk-change stamped 1 second ago and verify not throttled
        const oneSecAgo = new Date(Date.now() - 1000).toISOString().replace(/[:.]/g, '-');
        await fs.promises.writeFile(path.join(backupDir, `kanban.db.backup.bulk-change.${oneSecAgo}`), 'dummy');

        await db.writeDbBackup('bulk-change');
        const countBulkUnthrottled = (await fs.promises.readdir(backupDir)).filter(f => f.includes('bulk-change')).length;
        assert.strictEqual(countBulkUnthrottled, 2, 'bulk-change is never rate-limited');

        // Seed pre-migration stamped 45 min ago and verify written
        const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000).toISOString().replace(/[:.]/g, '-');
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }
        await fs.promises.writeFile(path.join(backupDir, `kanban.db.backup.pre-migration.${fortyFiveMinAgo}`), 'dummy');
        await db.writeDbBackup('pre-migration');
        const countPreExpired = (await fs.promises.readdir(backupDir)).filter(f => f.includes('pre-migration')).length;
        assert.strictEqual(countPreExpired, 2, 'pre-migration snapshot written after throttle window expired');

        console.log('Pass 8: Rate limit throttling rules passed');

        // Cleanup
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }

        // 9. Future-dated snapshot doesn't block writes
        const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/[:.]/g, '-');
        await fs.promises.writeFile(path.join(backupDir, `kanban.db.backup.pre-migration.${futureDate}`), 'dummy');
        await db.writeDbBackup('pre-migration');
        const countFuture = (await fs.promises.readdir(backupDir)).filter(f => f.includes('pre-migration')).length;
        assert.strictEqual(countFuture, 2, 'Future-dated snapshot does not throttle future writes');

        console.log('Pass 9: Future-dated snapshot clock skew defense passed');

        // Cleanup
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }

        // 10. Unknown reason: never throttled, own retention group, displaces nobody.
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.pre-migration.2026-07-30T10-00-00-000Z'), 'dummy');
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.bulk-change.2026-07-30T10-00-00-000Z'), 'dummy');

        await db.writeDbBackup('custom-unknown-reason');
        await mutate('unknown-reason-plan-a');
        await db.writeDbBackup('custom-unknown-reason');
        const after10 = await fs.promises.readdir(backupDir);
        assert.strictEqual(
            after10.filter(f => f.includes('custom-unknown-reason')).length, 2,
            'Unknown reason is never rate-limited — both writes land'
        );
        assert.ok(after10.includes('kanban.db.backup.pre-migration.2026-07-30T10-00-00-000Z'), 'unknown reason does not displace pre-migration');
        assert.ok(after10.includes('kanban.db.backup.bulk-change.2026-07-30T10-00-00-000Z'), 'unknown reason does not displace bulk-change');

        console.log('Pass 10: Unknown reason handling passed');

        // Cleanup
        for (const f of await fs.promises.readdir(backupDir)) {
            await fs.promises.unlink(path.join(backupDir, f));
        }

        // 11. Reason with digits and dashes
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.v2-2026-fix.2026-07-30T10-00-00-000Z'), 'dummy');
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.v2-2026-fix.2026-07-30T11-00-00-000Z'), 'dummy');
        await fs.promises.writeFile(path.join(backupDir, 'kanban.db.backup.v2-2026-fix.2026-07-30T12-00-00-000Z'), 'dummy');
        await db['_pruneDbBackups'](backupDir);
        const current11 = await fs.promises.readdir(backupDir);
        assert.strictEqual(current11.length, 2);
        assert.ok(current11.includes('kanban.db.backup.v2-2026-fix.2026-07-30T11-00-00-000Z'));
        assert.ok(current11.includes('kanban.db.backup.v2-2026-fix.2026-07-30T12-00-00-000Z'));

        console.log('Pass 11: Reason containing digits and dashes grouped correctly');

        // 12. Unrelated files untouched
        await fs.promises.writeFile(path.join(backupDir, 'unrelated-file.txt'), 'dummy');
        await db['_pruneDbBackups'](backupDir);
        assert.ok((await fs.promises.readdir(backupDir)).includes('unrelated-file.txt'));

        console.log('Pass 12: Unrelated files untouched');

        // 13. Best-effort contract: a write failure must not throw out of writeDbBackup.
        await mutate('best-effort-plan');
        const origWriteFile = fs.promises.writeFile;
        const origConsoleError = console.error;
        let loggedError = false;
        fs.promises.writeFile = async () => { throw new Error('EACCES: simulated unwritable dbbackup'); };
        console.error = (...args) => {
            if (String(args[0] || '').includes('Failed to write DB backup')) { loggedError = true; }
            origConsoleError(...args);
        };
        try {
            await db.writeDbBackup('bulk-change');
        } finally {
            fs.promises.writeFile = origWriteFile;
            console.error = origConsoleError;
        }
        assert.ok(loggedError, 'writeDbBackup resolves on failure and logs an error instead of throwing');

        console.log('Pass 13: Best-effort contract holds on write failure');

        console.log('\nAll kanban-db-backup-retention contract tests passed successfully.');
    } finally {
        await KanbanDatabase.invalidateWorkspace(ws);
        await fs.promises.rm(ws, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
});
